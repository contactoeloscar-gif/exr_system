// routes/lotes.js
console.log("CARGANDO routes/lotes.js");

const express = require("express");
const router = express.Router();
const pool = require("../config/db");

const CASA_CENTRAL_ID = 7;

/* =========================
   Helpers
========================= */
function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function asDate(v) {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function cleanText(v, max = 255) {
  return String(v ?? "").trim().slice(0, max);
}

function todayYmd() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getUser(req) {
  return {
    userId: req.user?.user_id || null,
    usuario: req.user?.usuario || req.user?.nombre || "system",
    rol: String(req.user?.rol || "").toUpperCase(),
    sucursalId: req.user?.sucursal_id || null
  };
}

function isGlobalRole(rol) {
  return rol === "OWNER" || rol === "ADMIN";
}

function isOperativeRole(rol) {
  return rol === "OPERADOR" || rol === "ENCARGADO";
}

function canUseSucursal(u, sucursalId) {
  if (!Number.isFinite(Number(sucursalId)) || Number(sucursalId) <= 0) return false;
  if (isGlobalRole(u.rol)) return true;
  return Number(u.sucursalId) === Number(sucursalId);
}

function mustBeAuthenticatedUser(u) {
  return !!u.userId;
}

function normalizeTipoLote(v) {
  const x = String(v || "").trim().toUpperCase();
  return x === "DISTRIBUCION" ? "DISTRIBUCION" : "COLECTA";
}

function expectedEstadoGuiaParaAgregar(tipoLote) {
  return tipoLote === "DISTRIBUCION" ? "RECIBIDO_CENTRAL" : "RECIBIDO_ORIGEN";
}

function expectedEstadoGuiaDespacho(tipoLote) {
  return tipoLote === "DISTRIBUCION" ? "EN_TRANSITO_A_DESTINO" : "EN_TRANSITO_A_CENTRAL";
}

function expectedEstadoGuiaRecepcionOK(tipoLote) {
  return tipoLote === "DISTRIBUCION" ? "RECIBIDO_DESTINO" : "RECIBIDO_CENTRAL";
}

function expectedEstadoGuiaRecepcionObservada(tipoLote) {
  return tipoLote === "DISTRIBUCION"
    ? "RECIBIDO_DESTINO_OBSERVADO"
    : "RECIBIDO_CENTRAL_OBSERVADO";
}

async function insertarEventoLote(client, {
  loteId,
  evento,
  payload = {},
  userId = null,
  usuario = null
}) {
  await client.query(
    `
      INSERT INTO lote_eventos (
        lote_id, evento, payload, user_id, usuario
      )
      VALUES ($1, $2, $3::jsonb, $4, $5)
    `,
    [loteId, evento, JSON.stringify(payload || {}), userId, usuario]
  );
}

async function recalcularTotalesLote(client, loteId) {
  await client.query(`SELECT recalcular_totales_lote($1)`, [loteId]);
}

async function obtenerLoteCabecera(client, loteId) {
  const q = await client.query(
    `
      SELECT
        lc.*,
        so.nombre AS sucursal_origen_nombre,
        sd.nombre AS sucursal_destino_nombre
      FROM lotes_colecta lc
      JOIN sucursales so ON so.id = lc.sucursal_origen_id
      JOIN sucursales sd ON sd.id = lc.sucursal_destino_id
      WHERE lc.id = $1
      LIMIT 1
    `,
    [loteId]
  );
  return q.rows[0] || null;
}

async function guiaEnLoteActivo(client, guiaId) {
  const q = await client.query(
    `
      SELECT
        lc.id,
        lc.numero_lote,
        lc.estado,
        lc.tipo_lote
      FROM lote_guias lg
      JOIN lotes_colecta lc ON lc.id = lg.lote_id
      WHERE lg.guia_id = $1
        AND lc.estado IN ('ABIERTO', 'CONSOLIDADO', 'DESPACHADO')
      LIMIT 1
    `,
    [guiaId]
  );
  return q.rows[0] || null;
}

async function generarNumeroLote(client, sucursalOrigenId, fechaOperativa, tipoLote) {
  const base = String(fechaOperativa || todayYmd()).replaceAll("-", "");
  const pref = tipoLote === "DISTRIBUCION" ? "DIS" : "COL";

  const q = await client.query(
    `
      SELECT numero_lote
      FROM lotes_colecta
      WHERE sucursal_origen_id = $1
        AND fecha_operativa = $2::date
        AND tipo_lote = $3
      ORDER BY id DESC
      LIMIT 1
    `,
    [sucursalOrigenId, fechaOperativa, tipoLote]
  );

  let next = 1;
  if (q.rows[0]?.numero_lote) {
    const m = String(q.rows[0].numero_lote).match(/-(\d{4})$/);
    if (m) next = Number(m[1]) + 1;
  }

  return `${pref}-${sucursalOrigenId}-${base}-${String(next).padStart(4, "0")}`;
}

async function insertarHistorialMovimiento(client, {
  guiaId,
  tipo,
  deValor,
  aValor,
  sucursalId = null,
  userId = null,
  usuario = null,
  ip = null,
  userAgent = null
}) {
  await client.query(
    `
      INSERT INTO historial_movimientos (
        guia_id, tipo, de_valor, a_valor,
        sucursal_id, user_id, usuario, ip, user_agent
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `,
    [
      guiaId,
      tipo,
      deValor,
      aValor,
      sucursalId,
      userId,
      usuario,
      ip,
      userAgent
    ]
  );
}

function getReqMeta(req) {
  return {
    ip:
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      null,
    userAgent: cleanText(req.headers["user-agent"], 500) || null
  };
}

/* =========================
   GET /interno/lotes/sucursales
========================= */
router.get("/sucursales", async (req, res) => {
  try {
    const u = getUser(req);
    if (!mustBeAuthenticatedUser(u)) {
      return res.status(401).json({ ok: false, error: "No autenticado." });
    }

    const q = await pool.query(
      `
        SELECT
          id,
          nombre,
          codigo
        FROM sucursales
        ORDER BY nombre ASC
      `
    );

    let items = q.rows || [];

    if (isOperativeRole(u.rol)) {
      items = items.filter((x) =>
        Number(x.id) === Number(u.sucursalId) ||
        Number(x.id) === Number(CASA_CENTRAL_ID)
      );
    }

    return res.json({
      ok: true,
      casa_central_id: CASA_CENTRAL_ID,
      user: {
        rol: u.rol,
        sucursal_id: u.sucursalId
      },
      items
    });
  } catch (err) {
    console.error("GET /interno/lotes/sucursales error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al listar sucursales.",
      detail: err.message
    });
  }
});

/* =========================
   GET /interno/lotes/buscar-guia?numero=EXR-000123
========================= */
router.get("/buscar-guia", async (req, res) => {
  try {
    const u = getUser(req);
    if (!mustBeAuthenticatedUser(u)) {
      return res.status(401).json({ ok: false, error: "No autenticado." });
    }

    const numero = cleanText(req.query?.numero, 80);
    if (!numero) {
      return res.status(400).json({ ok: false, error: "Debe informar numero." });
    }

    const q = await pool.query(
      `
        SELECT
          g.id,
          g.numero_guia,
          g.sucursal_origen_id,
          so.nombre AS sucursal_origen_nombre,
          g.sucursal_destino_id,
          sd.nombre AS sucursal_destino_nombre,
          g.estado_logistico,
          g.estado_pago,
          g.condicion_pago,
          g.tipo_cobro,
          g.remitente_nombre,
          g.destinatario_nombre,
          COALESCE((
            SELECT SUM(COALESCE(gi.cantidad, 0))::int
            FROM guia_items gi
            WHERE gi.guia_id = g.id
          ), 0) AS cant_bultos_calc
        FROM guias g
        JOIN sucursales so ON so.id = g.sucursal_origen_id
        JOIN sucursales sd ON sd.id = g.sucursal_destino_id
        WHERE
          UPPER(g.numero_guia) = UPPER($1)
          OR UPPER(g.numero_guia) LIKE UPPER($2)
        ORDER BY
          CASE WHEN UPPER(g.numero_guia) = UPPER($1) THEN 0 ELSE 1 END,
          g.id DESC
        LIMIT 1
      `,
      [numero, `%${numero}%`]
    );

    const guia = q.rows[0];
    if (!guia) {
      return res.status(404).json({ ok: false, error: "Guía no encontrada." });
    }

    if (!isGlobalRole(u.rol)) {
      const sameOrigen = Number(u.sucursalId) === Number(guia.sucursal_origen_id);
      const sameDestino = Number(u.sucursalId) === Number(guia.sucursal_destino_id);

      if (!sameOrigen && !sameDestino) {
        return res.status(403).json({
          ok: false,
          error: "No tenés permiso para ver esa guía."
        });
      }
    }

    return res.json({ ok: true, guia });
  } catch (err) {
    console.error("GET /interno/lotes/buscar-guia error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al buscar guía.",
      detail: err.message
    });
  }
});

/* =========================
   POST /interno/lotes
========================= */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const u = getUser(req);

    if (!mustBeAuthenticatedUser(u)) {
      return res.status(401).json({ ok: false, error: "No autenticado." });
    }

    let tipo_lote = normalizeTipoLote(req.body?.tipo_lote);
    let sucursal_origen_id = asInt(req.body?.sucursal_origen_id);
    let sucursal_destino_id = asInt(req.body?.sucursal_destino_id);

    const fecha_operativa = asDate(req.body?.fecha_operativa) || todayYmd();
    const chofer = cleanText(req.body?.chofer, 120);
    const vehiculo = cleanText(req.body?.vehiculo, 120);
    const patente = cleanText(req.body?.patente, 20).toUpperCase();
    const observaciones = cleanText(req.body?.observaciones, 2000);

    if (isOperativeRole(u.rol)) {
      tipo_lote = "COLECTA";
      sucursal_origen_id = Number(u.sucursalId);
      sucursal_destino_id = Number(CASA_CENTRAL_ID);
    } else {
      if (!Number.isFinite(sucursal_origen_id) || sucursal_origen_id <= 0) {
        return res.status(400).json({ ok: false, error: "sucursal_origen_id inválido." });
      }
      if (!Number.isFinite(sucursal_destino_id) || sucursal_destino_id <= 0) {
        return res.status(400).json({ ok: false, error: "sucursal_destino_id inválido." });
      }

      if (tipo_lote === "DISTRIBUCION" && Number(sucursal_origen_id) !== Number(CASA_CENTRAL_ID)) {
        return res.status(409).json({
          ok: false,
          error: "Los lotes de DISTRIBUCION solo pueden originarse en HUB_EXR."
        });
      }
    }

    if (sucursal_origen_id === sucursal_destino_id) {
      return res.status(400).json({
        ok: false,
        error: "Origen y destino del lote no pueden ser iguales."
      });
    }

    if (!canUseSucursal(u, sucursal_origen_id)) {
      return res.status(403).json({
        ok: false,
        error: "No tenés permiso para crear lotes en esa sucursal origen."
      });
    }

    if (isOperativeRole(u.rol) && Number(u.sucursalId) === Number(CASA_CENTRAL_ID)) {
      return res.status(409).json({
        ok: false,
        error: "Operador/encargado de HUB_EXR no crea lotes operativos desde esta pantalla."
      });
    }

    await client.query("BEGIN");

    const numero_lote = await generarNumeroLote(
      client,
      sucursal_origen_id,
      fecha_operativa,
      tipo_lote
    );

    const ins = await client.query(
      `
        INSERT INTO lotes_colecta (
          numero_lote,
          tipo_lote,
          sucursal_origen_id,
          sucursal_destino_id,
          fecha_operativa,
          chofer,
          vehiculo,
          patente,
          observaciones,
          creado_por_user_id,
          creado_por_usuario
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id, numero_lote, tipo_lote, estado, fecha_operativa
      `,
      [
        numero_lote,
        tipo_lote,
        sucursal_origen_id,
        sucursal_destino_id,
        fecha_operativa,
        chofer || null,
        vehiculo || null,
        patente || null,
        observaciones || null,
        u.userId,
        u.usuario
      ]
    );

    const lote = ins.rows[0];

    await insertarEventoLote(client, {
      loteId: lote.id,
      evento: "creado",
      payload: {
        numero_lote,
        tipo_lote,
        sucursal_origen_id,
        sucursal_destino_id,
        fecha_operativa
      },
      userId: u.userId,
      usuario: u.usuario
    });

    await client.query("COMMIT");

    return res.json({ ok: true, lote });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/lotes error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al crear lote.",
      detail: err.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   GET /interno/lotes
========================= */
router.get("/", async (req, res) => {
  try {
    const u = getUser(req);
    if (!mustBeAuthenticatedUser(u)) {
      return res.status(401).json({ ok: false, error: "No autenticado." });
    }

    const estado = cleanText(req.query?.estado, 30).toUpperCase();
    const tipo_lote = cleanText(req.query?.tipo_lote, 20).toUpperCase();
    const fecha = asDate(req.query?.fecha);
    const sucursal_id = asInt(req.query?.sucursal_id);
    const q = cleanText(req.query?.q, 120);

    const params = [];
    const where = [];

    if (!isGlobalRole(u.rol)) {
      params.push(u.sucursalId);
      where.push(`(lc.sucursal_origen_id = $${params.length} OR lc.sucursal_destino_id = $${params.length})`);
    } else if (Number.isFinite(sucursal_id) && sucursal_id > 0) {
      params.push(sucursal_id);
      where.push(`(lc.sucursal_origen_id = $${params.length} OR lc.sucursal_destino_id = $${params.length})`);
    }

    if (estado) {
      params.push(estado);
      where.push(`lc.estado = $${params.length}`);
    }
    if (tipo_lote && ["COLECTA", "DISTRIBUCION"].includes(tipo_lote)) {
      params.push(tipo_lote);
      where.push(`lc.tipo_lote = $${params.length}`);
    }
    if (fecha) {
      params.push(fecha);
      where.push(`lc.fecha_operativa = $${params.length}::date`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(
        lc.numero_lote ILIKE $${params.length}
        OR COALESCE(lc.chofer, '') ILIKE $${params.length}
        OR COALESCE(lc.vehiculo, '') ILIKE $${params.length}
        OR COALESCE(lc.patente, '') ILIKE $${params.length}
      )`);
    }

    const sql = `
      SELECT
        lc.id,
        lc.numero_lote,
        lc.tipo_lote,
        lc.estado,
        lc.fecha_operativa,
        lc.sucursal_origen_id,
        so.nombre AS sucursal_origen_nombre,
        lc.sucursal_destino_id,
        sd.nombre AS sucursal_destino_nombre,
        lc.chofer,
        lc.vehiculo,
        lc.patente,
        lc.cant_guias,
        lc.cant_bultos,
        lc.creado_en
      FROM lotes_colecta lc
      JOIN sucursales so ON so.id = lc.sucursal_origen_id
      JOIN sucursales sd ON sd.id = lc.sucursal_destino_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY lc.id DESC
      LIMIT 200
    `;

    const r = await pool.query(sql, params);

    return res.json({
      ok: true,
      total: r.rows.length,
      items: r.rows
    });
  } catch (err) {
    console.error("GET /interno/lotes error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al listar lotes.",
      detail: err.message
    });
  }
});

/* =========================
   GET /interno/lotes/:id
========================= */
router.get("/:id", async (req, res) => {
  try {
    const u = getUser(req);
    if (!mustBeAuthenticatedUser(u)) {
      return res.status(401).json({ ok: false, error: "No autenticado." });
    }

    const loteId = asInt(req.params.id);
    if (!Number.isFinite(loteId) || loteId <= 0) {
      return res.status(400).json({ ok: false, error: "ID de lote inválido." });
    }

    const cab = await pool.query(
      `
        SELECT
          lc.*,
          so.nombre AS sucursal_origen_nombre,
          sd.nombre AS sucursal_destino_nombre
        FROM lotes_colecta lc
        JOIN sucursales so ON so.id = lc.sucursal_origen_id
        JOIN sucursales sd ON sd.id = lc.sucursal_destino_id
        WHERE lc.id = $1
        LIMIT 1
      `,
      [loteId]
    );

    const lote = cab.rows[0];
    if (!lote) {
      return res.status(404).json({ ok: false, error: "Lote no encontrado." });
    }

    if (
      !isGlobalRole(u.rol) &&
      Number(u.sucursalId) !== Number(lote.sucursal_origen_id) &&
      Number(u.sucursalId) !== Number(lote.sucursal_destino_id)
    ) {
      return res.status(403).json({
        ok: false,
        error: "No tenés permiso para ver este lote."
      });
    }

    const guias = await pool.query(
      `
        SELECT
          lg.id,
          lg.guia_id,
          lg.cant_bultos_declarada,
          lg.estado_recepcion,
          lg.observacion_recepcion,
          lg.recibido_en,
          lg.agregado_en,
          g.numero_guia,
          g.remitente_nombre,
          g.destinatario_nombre,
          g.estado_logistico,
          g.condicion_pago,
          g.estado_pago,
          g.tipo_cobro,
          g.peso_kg,
          0 AS volumetrico_kg,
          0 AS kg_cobrable,
          g.sucursal_destino_id AS guia_sucursal_destino_id,
          sdg.nombre AS guia_sucursal_destino_nombre
          FROM lote_guias lg
        JOIN guias g ON g.id = lg.guia_id
        LEFT JOIN sucursales sdg ON sdg.id = g.sucursal_destino_id
        WHERE lg.lote_id = $1
        ORDER BY lg.id ASC
      `,
      [loteId]
    );

    const eventos = await pool.query(
      `
        SELECT
          id,
          evento,
          payload,
          user_id,
          usuario,
          created_at
        FROM lote_eventos
        WHERE lote_id = $1
        ORDER BY id DESC
        LIMIT 100
      `,
      [loteId]
    );

    return res.json({
      ok: true,
      lote: {
        ...lote,
        guias: guias.rows,
        eventos: eventos.rows
      }
    });
  } catch (err) {
    console.error("GET /interno/lotes/:id error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al obtener lote.",
      detail: err.message
    });
  }
});

/* =========================
   POST /interno/lotes/:id/guias
========================= */
router.post("/:id/guias", async (req, res) => {
  const client = await pool.connect();
  try {
    const loteId = asInt(req.params.id);
    const guiaId = asInt(req.body?.guia_id);
    const u = getUser(req);

    if (!mustBeAuthenticatedUser(u)) {
      return res.status(401).json({ ok: false, error: "No autenticado." });
    }
    if (!Number.isFinite(loteId) || loteId <= 0) {
      return res.status(400).json({ ok: false, error: "ID de lote inválido." });
    }
    if (!Number.isFinite(guiaId) || guiaId <= 0) {
      return res.status(400).json({ ok: false, error: "guia_id inválido." });
    }

    await client.query("BEGIN");

    const lote = await obtenerLoteCabecera(client, loteId);
    if (!lote) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Lote no encontrado." });
    }
    if (lote.estado !== "ABIERTO") {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "Solo se pueden agregar guías a un lote ABIERTO." });
    }
    if (!canUseSucursal(u, lote.sucursal_origen_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        error: "No tenés permiso para operar este lote desde la sucursal origen."
      });
    }

    const guiaEnOtro = await guiaEnLoteActivo(client, guiaId);
    if (guiaEnOtro && Number(guiaEnOtro.id) !== Number(loteId)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "La guía ya pertenece a otro lote activo.",
        lote_activo: guiaEnOtro
      });
    }

    const qg = await client.query(
      `
        SELECT
          g.id,
          g.numero_guia,
          g.sucursal_origen_id,
          g.sucursal_destino_id,
          g.estado_logistico,
          g.estado_pago,
          g.tipo_cobro,
          COALESCE((
            SELECT SUM(COALESCE(gi.cantidad, 0))::int
            FROM guia_items gi
            WHERE gi.guia_id = g.id
          ), 0) AS cant_bultos_calc
        FROM guias g
        WHERE g.id = $1
        LIMIT 1
      `,
      [guiaId]
    );

    const guia = qg.rows[0];
    if (!guia) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Guía no encontrada." });
    }

    const estadoEsperado = expectedEstadoGuiaParaAgregar(lote.tipo_lote);
    if (String(guia.estado_logistico || "").toUpperCase() !== estadoEsperado) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: `La guía debe estar en ${estadoEsperado} para entrar a un lote ${lote.tipo_lote}.`
      });
    }

    if (lote.tipo_lote === "COLECTA") {
      if (Number(guia.sucursal_origen_id) !== Number(lote.sucursal_origen_id)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "La guía no pertenece a la sucursal origen del lote de colecta."
        });
      }
    } else {
      if (Number(guia.sucursal_destino_id) !== Number(lote.sucursal_destino_id)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "La guía no coincide con el destino final del lote de distribución."
        });
      }
    }

    const tipoCobro = String(guia.tipo_cobro || "").trim().toUpperCase();
    const estadoPago = String(guia.estado_pago || "").trim().toLowerCase();

    if (tipoCobro === "ORIGEN" && estadoPago === "pendiente_origen") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "Una guía con cobro en ORIGEN debe estar cobrada para entrar al lote."
      });
    }

    const cantBultos = Math.max(1, Number(guia.cant_bultos_calc || 1));

    await client.query(
      `
        INSERT INTO lote_guias (
          lote_id, guia_id, cant_bultos_declarada
        )
        VALUES ($1, $2, $3)
      `,
      [loteId, guiaId, cantBultos]
    );

    await recalcularTotalesLote(client, loteId);

    await insertarEventoLote(client, {
      loteId,
      evento: "guia_agregada",
      payload: {
        guia_id: guia.id,
        numero_guia: guia.numero_guia,
        cant_bultos_declarada: cantBultos,
        guia_sucursal_destino_id: guia.sucursal_destino_id
      },
      userId: u.userId,
      usuario: u.usuario
    });

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Guía agregada al lote.",
      lote_id: loteId,
      guia_id: guiaId
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/lotes/:id/guias error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al agregar guía al lote.",
      detail: err.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   DELETE /interno/lotes/:id/guias/:guiaId
========================= */
router.delete("/:id/guias/:guiaId", async (req, res) => {
  const client = await pool.connect();
  try {
    const loteId = asInt(req.params.id);
    const guiaId = asInt(req.params.guiaId);
    const u = getUser(req);

    if (!mustBeAuthenticatedUser(u)) {
      return res.status(401).json({ ok: false, error: "No autenticado." });
    }
    if (!Number.isFinite(loteId) || loteId <= 0 || !Number.isFinite(guiaId) || guiaId <= 0) {
      return res.status(400).json({ ok: false, error: "Parámetros inválidos." });
    }

    await client.query("BEGIN");

    const lote = await obtenerLoteCabecera(client, loteId);
    if (!lote) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Lote no encontrado." });
    }
    if (lote.estado !== "ABIERTO") {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "Solo se pueden quitar guías de un lote ABIERTO." });
    }
    if (!canUseSucursal(u, lote.sucursal_origen_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        error: "No tenés permiso para modificar este lote."
      });
    }

    const del = await client.query(
      `
        DELETE FROM lote_guias
        WHERE lote_id = $1
          AND guia_id = $2
        RETURNING guia_id
      `,
      [loteId, guiaId]
    );

    if (!del.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "La guía no pertenece al lote." });
    }

    await recalcularTotalesLote(client, loteId);

    await insertarEventoLote(client, {
      loteId,
      evento: "guia_quitada",
      payload: { guia_id: guiaId },
      userId: u.userId,
      usuario: u.usuario
    });

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Guía quitada del lote."
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("DELETE /interno/lotes/:id/guias/:guiaId error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al quitar guía del lote.",
      detail: err.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   POST /interno/lotes/:id/consolidar
========================= */
router.post("/:id/consolidar", async (req, res) => {
  const client = await pool.connect();
  try {
    const loteId = asInt(req.params.id);
    const u = getUser(req);

    if (!mustBeAuthenticatedUser(u)) {
      return res.status(401).json({ ok: false, error: "No autenticado." });
    }
    if (!Number.isFinite(loteId) || loteId <= 0) {
      return res.status(400).json({ ok: false, error: "ID de lote inválido." });
    }

    await client.query("BEGIN");

    const lote = await obtenerLoteCabecera(client, loteId);
    if (!lote) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Lote no encontrado." });
    }
    if (lote.estado !== "ABIERTO") {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "Solo se puede consolidar un lote ABIERTO." });
    }
    if (!canUseSucursal(u, lote.sucursal_origen_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        error: "No tenés permiso para consolidar este lote."
      });
    }

    await recalcularTotalesLote(client, loteId);

    const q = await client.query(
      `
        UPDATE lotes_colecta
        SET
          estado = 'CONSOLIDADO',
          consolidado_en = NOW()
        WHERE id = $1
          AND estado = 'ABIERTO'
          AND cant_guias > 0
        RETURNING id, numero_lote, tipo_lote, estado, cant_guias, cant_bultos, consolidado_en
      `,
      [loteId]
    );

    if (!q.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "No se pudo consolidar. Verificá que el lote tenga al menos una guía."
      });
    }

    await insertarEventoLote(client, {
      loteId,
      evento: "consolidado",
      payload: {
        cant_guias: q.rows[0].cant_guias,
        cant_bultos: q.rows[0].cant_bultos,
        tipo_lote: q.rows[0].tipo_lote
      },
      userId: u.userId,
      usuario: u.usuario
    });

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Lote consolidado.",
      lote: q.rows[0]
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/lotes/:id/consolidar error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al consolidar lote.",
      detail: err.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   POST /interno/lotes/:id/despachar
========================= */
router.post("/:id/despachar", async (req, res) => {
  const client = await pool.connect();
  try {
    const loteId = asInt(req.params.id);
    const u = getUser(req);
    const meta = getReqMeta(req);

    if (!mustBeAuthenticatedUser(u)) {
      return res.status(401).json({ ok: false, error: "No autenticado." });
    }
    if (!Number.isFinite(loteId) || loteId <= 0) {
      return res.status(400).json({ ok: false, error: "ID de lote inválido." });
    }

    await client.query("BEGIN");

    const lote = await obtenerLoteCabecera(client, loteId);
    if (!lote) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Lote no encontrado." });
    }
    if (lote.estado !== "CONSOLIDADO") {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "Solo se puede despachar un lote CONSOLIDADO." });
    }
    if (!canUseSucursal(u, lote.sucursal_origen_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        error: "No tenés permiso para despachar este lote."
      });
    }

    const qGuias = await client.query(
      `
        SELECT g.id, g.estado_logistico
        FROM guias g
        WHERE g.id IN (
          SELECT lg.guia_id
          FROM lote_guias lg
          WHERE lg.lote_id = $1
        )
        ORDER BY g.id ASC
      `,
      [loteId]
    );

    const estadoOrigenEsperado = expectedEstadoGuiaParaAgregar(lote.tipo_lote);
    const estadoDestinoDespacho = expectedEstadoGuiaDespacho(lote.tipo_lote);

    const upLote = await client.query(
      `
        UPDATE lotes_colecta
        SET
          estado = 'DESPACHADO',
          despachado_en = NOW()
        WHERE id = $1
          AND estado = 'CONSOLIDADO'
        RETURNING id, numero_lote, tipo_lote, estado, despachado_en
      `,
      [loteId]
    );

    for (const g of qGuias.rows) {
      const deValor = String(g.estado_logistico || "").toUpperCase();
      if (deValor !== estadoOrigenEsperado) continue;

      await client.query(
        `
          UPDATE guias
          SET estado_logistico = $2
          WHERE id = $1
            AND estado_logistico = $3
        `,
        [g.id, estadoDestinoDespacho, estadoOrigenEsperado]
      );

      await insertarHistorialMovimiento(client, {
        guiaId: g.id,
        tipo: "ESTADO",
        deValor: estadoOrigenEsperado,
        aValor: estadoDestinoDespacho,
        sucursalId: lote.sucursal_origen_id,
        userId: u.userId,
        usuario: u.usuario,
        ip: meta.ip,
        userAgent: meta.userAgent
      });
    }

    await insertarEventoLote(client, {
      loteId,
      evento: "despachado",
      payload: {
        despachado_en: upLote.rows[0]?.despachado_en || null,
        tipo_lote: lote.tipo_lote
      },
      userId: u.userId,
      usuario: u.usuario
    });

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Lote despachado.",
      lote: upLote.rows[0]
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/lotes/:id/despachar error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al despachar lote.",
      detail: err.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   POST /interno/lotes/:id/recepcion
========================= */
router.post("/:id/recepcion", async (req, res) => {
  const client = await pool.connect();
  try {
    const loteId = asInt(req.params.id);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const observacionGeneral = cleanText(req.body?.observacion_general, 2000);
    const u = getUser(req);
    const meta = getReqMeta(req);

    if (!mustBeAuthenticatedUser(u)) {
      return res.status(401).json({ ok: false, error: "No autenticado." });
    }
    if (!Number.isFinite(loteId) || loteId <= 0) {
      return res.status(400).json({ ok: false, error: "ID de lote inválido." });
    }
    if (!items.length) {
      return res.status(400).json({ ok: false, error: "Debe informar items de recepción." });
    }

    await client.query("BEGIN");

    const lote = await obtenerLoteCabecera(client, loteId);
    if (!lote) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Lote no encontrado." });
    }
    if (lote.estado !== "DESPACHADO") {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "Solo se puede recibir un lote DESPACHADO." });
    }
    if (!canUseSucursal(u, lote.sucursal_destino_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        error: "No tenés permiso para registrar la recepción de este lote."
      });
    }

    const estadoEsperadoEnRecepcion =
      lote.tipo_lote === "DISTRIBUCION" ? "EN_TRANSITO_A_DESTINO" : "EN_TRANSITO_A_CENTRAL";

    const estadoDestinoRecepcionOK = expectedEstadoGuiaRecepcionOK(lote.tipo_lote);
    const estadoDestinoRecepcionObservada = expectedEstadoGuiaRecepcionObservada(lote.tipo_lote);

    await insertarEventoLote(client, {
      loteId,
      evento: "recepcion_iniciada",
      payload: {
        observacion_general: observacionGeneral || null,
        tipo_lote: lote.tipo_lote
      },
      userId: u.userId,
      usuario: u.usuario
    });

    for (const it of items) {
      const guiaId = asInt(it?.guia_id);
      const estadoRecepcion = cleanText(it?.estado_recepcion, 20).toUpperCase();
      const obs = cleanText(it?.observacion_recepcion, 2000);

      if (!Number.isFinite(guiaId) || guiaId <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: "Hay guia_id inválido en recepción." });
      }

      if (!["RECIBIDO_OK", "FALTANTE", "DANADO", "OBSERVADO"].includes(estadoRecepcion)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: `estado_recepcion inválido para guía ${guiaId}.`
        });
      }

      if (["FALTANTE", "DANADO", "OBSERVADO"].includes(estadoRecepcion) && !obs) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: `Debe informar observación para la guía ${guiaId}.`
        });
      }

      const chk = await client.query(
        `
          SELECT lg.id, g.estado_logistico
          FROM lote_guias lg
          JOIN guias g ON g.id = lg.guia_id
          WHERE lg.lote_id = $1
            AND lg.guia_id = $2
          LIMIT 1
        `,
        [loteId, guiaId]
      );

      if (!chk.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: `La guía ${guiaId} no pertenece al lote.`
        });
      }

      await client.query(
        `
          UPDATE lote_guias
          SET
            estado_recepcion = $3,
            observacion_recepcion = $4,
            recibido_en = NOW()
          WHERE lote_id = $1
            AND guia_id = $2
        `,
        [loteId, guiaId, estadoRecepcion, obs || null]
      );

      if (estadoRecepcion === "RECIBIDO_OK") {
        const deValor = String(chk.rows[0].estado_logistico || "").toUpperCase();

        await client.query(
          `
            UPDATE guias
            SET estado_logistico = $2
            WHERE id = $1
              AND estado_logistico = $3
          `,
          [guiaId, estadoDestinoRecepcionOK, estadoEsperadoEnRecepcion]
        );

        if (deValor === estadoEsperadoEnRecepcion) {
          await insertarHistorialMovimiento(client, {
            guiaId,
            tipo: "ESTADO",
            deValor: estadoEsperadoEnRecepcion,
            aValor: estadoDestinoRecepcionOK,
            sucursalId: lote.sucursal_destino_id,
            userId: u.userId,
            usuario: u.usuario,
            ip: meta.ip,
            userAgent: meta.userAgent
          });
        }

        await insertarEventoLote(client, {
          loteId,
          evento: "guia_recibida_ok",
          payload: {
            guia_id: guiaId,
            tipo_lote: lote.tipo_lote,
            nuevo_estado_guia: estadoDestinoRecepcionOK
          },
          userId: u.userId,
          usuario: u.usuario
        });
      } else if (estadoRecepcion === "DANADO" || estadoRecepcion === "OBSERVADO") {
        const deValor = String(chk.rows[0].estado_logistico || "").toUpperCase();

        await client.query(
          `
            UPDATE guias
            SET estado_logistico = $2
            WHERE id = $1
              AND estado_logistico = $3
          `,
          [guiaId, estadoDestinoRecepcionObservada, estadoEsperadoEnRecepcion]
        );

        if (deValor === estadoEsperadoEnRecepcion) {
          await insertarHistorialMovimiento(client, {
            guiaId,
            tipo: "ESTADO",
            deValor: estadoEsperadoEnRecepcion,
            aValor: estadoDestinoRecepcionObservada,
            sucursalId: lote.sucursal_destino_id,
            userId: u.userId,
            usuario: u.usuario,
            ip: meta.ip,
            userAgent: meta.userAgent
          });
        }

        const evento =
          estadoRecepcion === "DANADO"
            ? "guia_danada"
            : "guia_observada";

        await insertarEventoLote(client, {
          loteId,
          evento,
          payload: {
            guia_id: guiaId,
            observacion_recepcion: obs || null,
            tipo_lote: lote.tipo_lote,
            nuevo_estado_guia: estadoDestinoRecepcionObservada
          },
          userId: u.userId,
          usuario: u.usuario
        });
      } else {
        await insertarEventoLote(client, {
          loteId,
          evento: "guia_faltante",
          payload: {
            guia_id: guiaId,
            observacion_recepcion: obs || null,
            tipo_lote: lote.tipo_lote
          },
          userId: u.userId,
          usuario: u.usuario
        });
      }
    }

    const qResumen = await client.query(
      `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE estado_recepcion = 'RECIBIDO_OK')::int AS ok_count,
          COUNT(*) FILTER (
            WHERE estado_recepcion IN ('FALTANTE', 'DANADO', 'OBSERVADO')
          )::int AS novedad_count
        FROM lote_guias
        WHERE lote_id = $1
      `,
      [loteId]
    );

    const resumen = qResumen.rows[0];
    let estadoFinal = "RECIBIDO_CON_NOVEDAD";

    if (Number(resumen.ok_count) === Number(resumen.total)) {
      estadoFinal = "RECIBIDO_TOTAL";
    } else if (Number(resumen.ok_count) > 0 && Number(resumen.novedad_count) > 0) {
      estadoFinal = "RECIBIDO_PARCIAL";
    }

    const up = await client.query(
      `
        UPDATE lotes_colecta
        SET
          estado = $2,
          recibido_en = NOW()
        WHERE id = $1
        RETURNING id, numero_lote, tipo_lote, estado, recibido_en
      `,
      [loteId, estadoFinal]
    );

    await insertarEventoLote(client, {
      loteId,
      evento: "recepcion_cerrada",
      payload: {
        estado_final: estadoFinal,
        observacion_general: observacionGeneral || null,
        tipo_lote: lote.tipo_lote
      },
      userId: u.userId,
      usuario: u.usuario
    });

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Recepción registrada.",
      lote: up.rows[0]
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/lotes/:id/recepcion error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al registrar recepción.",
      detail: err.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   POST /interno/lotes/:id/anular
========================= */
router.post("/:id/anular", async (req, res) => {
  const client = await pool.connect();
  try {
    const loteId = asInt(req.params.id);
    const u = getUser(req);

    if (!mustBeAuthenticatedUser(u)) {
      return res.status(401).json({ ok: false, error: "No autenticado." });
    }
    if (!Number.isFinite(loteId) || loteId <= 0) {
      return res.status(400).json({ ok: false, error: "ID de lote inválido." });
    }

    await client.query("BEGIN");

    const lote = await obtenerLoteCabecera(client, loteId);
    if (!lote) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Lote no encontrado." });
    }
    if (lote.estado !== "ABIERTO") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "Solo se puede anular un lote ABIERTO."
      });
    }
    if (!canUseSucursal(u, lote.sucursal_origen_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        error: "No tenés permiso para anular este lote."
      });
    }

    const up = await client.query(
      `
        UPDATE lotes_colecta
        SET
          estado = 'ANULADO',
          anulado_en = NOW()
        WHERE id = $1
          AND estado = 'ABIERTO'
        RETURNING id, numero_lote, tipo_lote, estado, anulado_en
      `,
      [loteId]
    );

    await insertarEventoLote(client, {
      loteId,
      evento: "anulado",
      payload: {
        tipo_lote: lote.tipo_lote
      },
      userId: u.userId,
      usuario: u.usuario
    });

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Lote anulado.",
      lote: up.rows[0]
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/lotes/:id/anular error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al anular lote.",
      detail: err.message
    });
  } finally {
    client.release();
  }
});

module.exports = router;