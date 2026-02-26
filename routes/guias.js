const express = require("express");
const router = express.Router();

const pool = require("../config/db");
const { isOwnerOrAdmin } = require("../middleware/roles");

console.log("CARGANDO routes/guias.js (SECURE-SCOPE)");

function normTipoCobro(v) {
  return String(v || "").trim().toUpperCase();
}
function normUp(v) {
  return String(v || "").trim().toUpperCase();
}

/* =========================================
   GET /guias  (scope por sucursal)
========================================= */
router.get("/", async (req, res) => {
  try {
    const owner = isOwnerOrAdmin(req);

    if (!owner && !req.user?.sucursal_id) {
      return res.status(403).json({ ok: false, error: "Usuario sin sucursal asignada" });
    }

    const sql = owner
      ? "SELECT * FROM guias ORDER BY id DESC"
      : "SELECT * FROM guias WHERE sucursal_origen_id = $1 ORDER BY id DESC";

    const params = owner ? [] : [req.user.sucursal_id];

    const result = await pool.query(sql, params);
    res.json({ ok: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* =========================================
   POST /guias/pago  (cambiar estado pago + metodo_pago)
   - scope: OWNER/ADMIN global, resto solo su sucursal_origen
   Reglas:
   - Si estado_pago = PAGADO => metodo_pago requerido (EFECTIVO | MERCADO_PAGO | TRANSFERENCIA)
   - Si estado_pago != PAGADO => metodo_pago se guarda NULL
========================================= */
router.post("/pago", async (req, res) => {
  try {
    const guia_id = Number(req.body?.guia_id);
    const estado_pago = normUp(req.body?.estado_pago);
    const metodo_pago = req.body?.metodo_pago == null ? null : normUp(req.body?.metodo_pago);

    if (!guia_id) return res.status(400).json({ ok: false, error: "guia_id requerido" });

    const estadosValidos = new Set(["PAGADO", "CONTRA_ENTREGA", "PENDIENTE"]);
    if (!estadosValidos.has(estado_pago)) {
      return res.status(400).json({ ok: false, error: "estado_pago inválido" });
    }

    const metodosValidos = new Set(["EFECTIVO", "MERCADO_PAGO", "TRANSFERENCIA"]);
    if (estado_pago === "PAGADO") {
      if (!metodo_pago || !metodosValidos.has(metodo_pago)) {
        return res.status(400).json({ ok: false, error: "metodo_pago inválido" });
      }
    }

    // leer anterior + scope
    const prev = await pool.query(
      "SELECT estado_pago, metodo_pago, sucursal_origen_id FROM guias WHERE id=$1",
      [guia_id]
    );
    if (prev.rowCount === 0) return res.status(404).json({ ok: false, error: "guia no encontrada" });

    const owner = isOwnerOrAdmin(req);
    const guia = prev.rows[0];

    if (!owner) {
      if (!req.user?.sucursal_id) {
        return res.status(403).json({ ok: false, error: "Usuario sin sucursal asignada" });
      }
      if (Number(guia.sucursal_origen_id) !== Number(req.user.sucursal_id)) {
        return res.status(403).json({ ok: false, error: "Sin permisos para cobrar esta guía" });
      }
    }

    const de_estado = guia.estado_pago;
    const de_metodo = guia.metodo_pago;

    const nuevoMetodo = estado_pago === "PAGADO" ? metodo_pago : null;

    // update
    await pool.query(
      "UPDATE guias SET estado_pago=$1, metodo_pago=$2 WHERE id=$3",
      [estado_pago, nuevoMetodo, guia_id]
    );

    // historial (tipo = PAGO). Guardamos método dentro del valor para trazabilidad.
    const de_valor =
      de_estado === "PAGADO" ? `PAGADO:${de_metodo || "SIN_METODO"}` : (de_estado || null);

    const a_valor =
      estado_pago === "PAGADO" ? `PAGADO:${nuevoMetodo}` : estado_pago;

    await pool.query(
      `INSERT INTO historial_movimientos
        (guia_id, tipo, de_valor, a_valor, sucursal_id, user_id, usuario, ip, user_agent, creado_en)
       VALUES
        ($1,'PAGO',$2,$3,$4,$5,$6,$7,$8,NOW())`,
      [
        guia_id,
        de_valor,
        a_valor,
        req.user?.sucursal_id || null,
        req.user?.user_id || null,
        req.user?.usuario || null,
        req.ip || null,
        req.headers["user-agent"] || null,
      ]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("Error en /guias/pago:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* =========================================
   POST /guias  (crear guía)
   - scope: si NO es OWNER/ADMIN, fuerza sucursal_origen_id = req.user.sucursal_id
========================================= */
router.post("/", async (req, res) => {
  const {
    sucursal_origen_id,
    sucursal_destino_id,
    remitente_nombre,
    remitente_dni,
    remitente_telefono,
    destinatario_nombre,
    destinatario_dni,
    destinatario_telefono,
    tipo_cobro, // ORIGEN | DESTINO
    fragil,
    valor_declarado,
    importe_servicio,
  } = req.body || {};

  const owner = isOwnerOrAdmin(req);

  // ✅ Forzar sucursal origen para OPERADOR/ENCARGADO
  const origenFinal = owner ? Number(sucursal_origen_id) : Number(req.user?.sucursal_id);

  if (!origenFinal || !sucursal_destino_id) {
    return res.status(400).json({ ok: false, error: "Faltan sucursal_origen_id / sucursal_destino_id" });
  }

  if (!owner && !req.user?.sucursal_id) {
    return res.status(403).json({ ok: false, error: "Usuario sin sucursal asignada" });
  }

  const tc = normTipoCobro(tipo_cobro);

  if (!remitente_nombre || !destinatario_nombre) {
    return res.status(400).json({ ok: false, error: "Faltan nombres (remitente/destinatario)" });
  }
  if (!["ORIGEN", "DESTINO"].includes(tc)) {
    return res.status(400).json({ ok: false, error: "tipo_cobro invalido (ORIGEN|DESTINO)" });
  }

  const vd = Number(valor_declarado ?? 0);
  if (Number.isNaN(vd) || vd < 0) {
    return res.status(400).json({ ok: false, error: "valor_declarado invalido" });
  }

  const imp = Number(importe_servicio ?? 0);
  if (Number.isNaN(imp) || imp < 0) {
    return res.status(400).json({ ok: false, error: "importe_servicio invalido" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const s = await client.query(
      "SELECT id, codigo FROM sucursales WHERE id = $1",
      [origenFinal]
    );
    if (s.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Sucursal origen no existe" });
    }

    const codigoSucursal = s.rows[0].codigo;

    const c = await client.query(
      "SELECT ultimo_numero FROM contadores_guias WHERE sucursal_id = $1 FOR UPDATE",
      [origenFinal]
    );
    if (c.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Contador no existe para sucursal" });
    }

    const nextNumber = Number(c.rows[0].ultimo_numero) + 1;

    await client.query(
      "UPDATE contadores_guias SET ultimo_numero = $1 WHERE sucursal_id = $2",
      [nextNumber, origenFinal]
    );

    const year = new Date().getFullYear();
    const padded = String(nextNumber).padStart(6, "0");
    const numero_guia = `${codigoSucursal}-${year}-${padded}`;

    const estado_pago = tc === "DESTINO" ? "CONTRA_ENTREGA" : "PENDIENTE";

    const ins = await client.query(
      `INSERT INTO guias (
        numero_guia, sucursal_origen_id, sucursal_destino_id,
        remitente_nombre, remitente_dni, remitente_telefono,
        destinatario_nombre, destinatario_dni, destinatario_telefono,
        tipo_cobro, estado_pago, fragil, valor_declarado, importe_servicio,
        estado_logistico
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
      )
      RETURNING *`,
      [
        numero_guia,
        origenFinal,
        sucursal_destino_id,
        remitente_nombre,
        remitente_dni || null,
        remitente_telefono || null,
        destinatario_nombre,
        destinatario_dni || null,
        destinatario_telefono || null,
        tc,
        estado_pago,
        !!fragil,
        vd,
        imp,
        "RECIBIDO_ORIGEN",
      ]
    );

    await client.query("COMMIT");
    res.json({ ok: true, guia: ins.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
