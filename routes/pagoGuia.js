const express = require("express");
const router = express.Router();

const pool = require("../config/db");

// Normaliza
const up = (v) => String(v || "").trim().toUpperCase();

/* =========================================
   POST /guias/pago  (si este router se monta en /guias)
   Body:
   - guia_id (number)
   - estado_pago: PAGADO | CONTRA_ENTREGA | PENDIENTE
   - metodo_pago: EFECTIVO | MERCADO_PAGO | TRANSFERENCIA (obligatorio si PAGADO)
========================================= */
router.post("/pago", async (req, res) => {
  try {
    const guia_id = Number(req.body.guia_id);
    const estado_pago = up(req.body.estado_pago);
    const metodo_pago = req.body.metodo_pago == null ? null : up(req.body.metodo_pago);

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

    // leer anterior
    const prev = await pool.query(
      "SELECT estado_pago, metodo_pago FROM guias WHERE id=$1",
      [guia_id]
    );
    if (prev.rowCount === 0) return res.status(404).json({ ok: false, error: "guia no encontrada" });

    const { isOwnerOrAdmin } = require("../middleware/roles");
    const de_estado = prev.rows[0].estado_pago;
    const de_metodo = prev.rows[0].metodo_pago;
    const owner = isOwnerOrAdmin(req);

if (!owner) {
  if (!req.user?.sucursal_id) {
    return res.status(403).json({ ok: false, error: "Usuario sin sucursal asignada" });
  }
  if (Number(prev.rows[0].sucursal_origen_id) !== Number(req.user.sucursal_id)) {
    return res.status(403).json({ ok: false, error: "Sin permisos para cobrar esta guía" });
  }
}


    const nuevoMetodo = (estado_pago === "PAGADO") ? metodo_pago : null;

    // update
    await pool.query(
      "UPDATE guias SET estado_pago=$1, metodo_pago=$2 WHERE id=$3",
      [estado_pago, nuevoMetodo, guia_id]
    );

    // historial (tipo PAGO)
    const de_valor = (de_estado === "PAGADO")
      ? `PAGADO:${de_metodo || "SIN_METODO"}`
      : (de_estado || null);

    const a_valor = (estado_pago === "PAGADO")
      ? `PAGADO:${nuevoMetodo}`
      : estado_pago;

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
        req.headers["user-agent"] || null
      ]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("Error /pagoGuia /pago:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

module.exports = router;
