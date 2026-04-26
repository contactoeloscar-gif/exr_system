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
  const t = String(tipoLote || "").trim().toUpperCase();

  if (t === "COLECTA") return "RECIBIDO_ORIGEN";
  if (t === "DISTRIBUCION") return "RECIBIDO_CENTRAL";

  return null;
}

function expectedEstadoGuiaDespacho(tipoLote) {
  return String(tipoLote || "").trim().toUpperCase() === "DISTRIBUCION"
    ? "EN_TRANSITO_A_DESTINO"
    : "EN_TRANSITO_A_CENTRAL";
}

function expectedEstadoGuiaRecepcionOK(tipoLote) {
  return String(tipoLote || "").trim().toUpperCase() === "DISTRIBUCION"
    ? "RECIBIDO_DESTINO"
    : "RECIBIDO_CENTRAL";
}

function expectedEstadoGuiaRecepcionObservada(tipoLote) {
  return String(tipoLote || "").trim().toUpperCase() === "DISTRIBUCION"
    ? "RECIBIDO_DESTINO_OBSERVADO"
    : "RECIBIDO_CENTRAL_OBSERVADO";
}

function isRecepcionHub(tipoLote) {
  return String(tipoLote || "").trim().toUpperCase() === "COLECTA";
}

function isEstadoLoteRecibido(estado) {
  return String(estado || "").trim().toUpperCase() === "RECIBIDO";
}

function calcularResultadoRecepcion(total, okCount, novedadCount) {
  const totalN = Number(total || 0);
  const okN = Number(okCount || 0);
  const novedadN = Number(novedadCount || 0);

  if (totalN > 0 && okN === totalN) return "TOTAL";
  if (okN > 0 && novedadN > 0) return "PARCIAL";
  return "CON_NOVEDAD";
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

    const limit = Math.min(Math.max(asInt(req.query?.limit) || 5, 1), 50);
    const offset = Math.max(asInt(req.query?.offset) || 0, 0);

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

    const sqlCount = `
      SELECT COUNT(*)::int AS total
      FROM lotes_colecta lc
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    `;

    const countResult = await pool.query(sqlCount, params);
    const total = Number(countResult.rows[0]?.total || 0);

    const sql = `
      SELECT
        lc.id,
        lc.numero_lote,
        lc.tipo_lote,
        lc.estado,
        lc.resultado_recepcion,
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
        lc.creado_en,
        lc.consolidado_en,
        lc.despachado_en,
        lc.recibido_en,
        lc.cerrado_en
      FROM lotes_colecta lc
      JOIN sucursales so ON so.id = lc.sucursal_origen_id
      JOIN sucursales sd ON sd.id = lc.sucursal_destino_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY lc.id DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const r = await pool.query(sql, [...params, limit, offset]);

    return res.json({
      ok: true,
      total,
      limit,
      offset,
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
   GET /interno/lotes/:id/guias-disponibles
========================= */
router.get("/:id/guias-disponibles", async (req, res) => {
  const client = await pool.connect();
  try {
    const loteId = asInt(req.params.id);
    const q = cleanText(req.query?.q, 120);
    const u = getUser(req);

    if (!mustBeAuthenticatedUser(u)) {
      return res.status(401).json({ ok: false, error: "No autenticado." });
    }

    if (!Number.isFinite(loteId) || loteId <= 0) {
      return res.status(400).json({ ok: false, error: "ID de lote inválido." });
    }

    const lote = await obtenerLoteCabecera(client, loteId);
    if (!lote) {
      return res.status(404).json({ ok: false, error: "Lote no encontrado." });
    }

    if (String(lote.estado || "").toUpperCase() !== "ABIERTO") {
      return res.status(409).json({
        ok: false,
        error: "Solo se pueden listar guías disponibles para un lote ABIERTO."
      });
    }

    if (!canUseSucursal(u, lote.sucursal_origen_id)) {
      return res.status(403).json({
        ok: false,
        error: "No tenés permiso para operar este lote."
      });
    }

    const tipoLote = String(lote.tipo_lote || "").trim().toUpperCase();
    const estadoEsperado = expectedEstadoGuiaParaAgregar(tipoLote);

    if (!estadoEsperado) {
      return res.status(400).json({
        ok: false,
        error: `Tipo de lote inválido o no soportado para agregar guías: ${lote.tipo_lote}`
      });
    }

    const params = [estadoEsperado];
    let whereExtra = "";
    let notExistsSql = "";
    let hubNovedadSql = "";

    if (tipoLote === "COLECTA") {
      params.push(lote.sucursal_origen_id);
      whereExtra += ` AND g.sucursal_origen_id = $${params.length} `;

      notExistsSql = `
        AND NOT EXISTS (
          SELECT 1
          FROM lote_guias lg
          JOIN lotes_colecta lc ON lc.id = lg.lote_id
          WHERE lg.guia_id = g.id
            AND lc.estado IN ('ABIERTO', 'CONSOLIDADO', 'DESPACHADO')
        )
      `;
    } else if (tipoLote === "DISTRIBUCION") {
      params.push(lote.sucursal_destino_id);
      whereExtra += ` AND g.sucursal_destino_id = $${params.length} `;

      hubNovedadSql = `
        AND COALESCE(g.novedad_hub_resolucion, 'CONTINUAR_ENVIO') <> 'RETENER_EN_HUB'
      `;

      notExistsSql = `
        AND NOT EXISTS (
          SELECT 1
          FROM lote_guias lg
          JOIN lotes_colecta lc ON lc.id = lg.lote_id
          WHERE lg.guia_id = g.id
            AND lc.tipo_lote = 'DISTRIBUCION'
            AND lc.estado IN ('ABIERTO', 'CONSOLIDADO', 'DESPACHADO')
            AND lc.id <> ${Number(lote.id)}
        )
      `;
    } else {
      params.push(lote.sucursal_destino_id);
      whereExtra += ` AND g.sucursal_destino_id = $${params.length} `;

      notExistsSql = `
        AND NOT EXISTS (
          SELECT 1
          FROM lote_guias lg
          JOIN lotes_colecta lc ON lc.id = lg.lote_id
          WHERE lg.guia_id = g.id
            AND lc.estado IN ('ABIERTO', 'CONSOLIDADO', 'DESPACHADO')
        )
      `;
    }

    if (q) {
      params.push(`%${q}%`);
      whereExtra += `
        AND (
          g.numero_guia ILIKE $${params.length}
          OR COALESCE(g.remitente_nombre, '') ILIKE $${params.length}
          OR COALESCE(g.destinatario_nombre, '') ILIKE $${params.length}
        )
      `;
    }

    const sql = `
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
      WHERE g.estado_logistico = $1
        ${hubNovedadSql}
        ${notExistsSql}
        ${whereExtra}  
      ORDER BY g.id DESC
      LIMIT 300
    `;

    const r = await client.query(sql, params);

    const items = (r.rows || []).filter((guia) => {
      const tipoCobro = String(guia.tipo_cobro || "").trim().toUpperCase();
      const estadoPago = String(guia.estado_pago || "").trim().toLowerCase();

      if (tipoCobro === "ORIGEN" && estadoPago === "pendiente_origen") {
        return false;
      }

      return true;
    });

    return res.json({
      ok: true,
      lote: {
        id: lote.id,
        numero_lote: lote.numero_lote,
        tipo_lote: lote.tipo_lote,
        estado: lote.estado
      },
      total: items.length,
      items
    });
  } catch (err) {
    console.error("GET /interno/lotes/:id/guias-disponibles error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al listar guías disponibles.",
      detail: err.message
    });
  } finally {
    client.release();
  }
});

/* =========================
   POST /interno/lotes/:id/guias/batch
========================= */
router.post("/:id/guias/batch", async (req, res) => {
  const client = await pool.connect();
  try {
    const loteId = asInt(req.params.id);
    const guiaIds = Array.isArray(req.body?.guia_ids) ? req.body.guia_ids.map(asInt) : [];
    const u = getUser(req);

    if (!mustBeAuthenticatedUser(u)) {
      return res.status(401).json({ ok: false, error: "No autenticado." });
    }
    if (!Number.isFinite(loteId) || loteId <= 0) {
      return res.status(400).json({ ok: false, error: "ID de lote inválido." });
    }
    if (!guiaIds.length) {
      return res.status(400).json({ ok: false, error: "Debe informar guia_ids." });
    }

    const idsValidos = guiaIds.filter((x) => Number.isFinite(x) && x > 0);
    const idsSet = new Set(idsValidos);

    if (idsValidos.length !== guiaIds.length || idsSet.size !== idsValidos.length) {
      return res.status(400).json({
        ok: false,
        error: "La lista de guia_ids contiene valores inválidos o duplicados."
      });
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
        error: "Solo se pueden agregar guías a un lote ABIERTO."
      });
    }
    if (!canUseSucursal(u, lote.sucursal_origen_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        error: "No tenés permiso para operar este lote desde la sucursal origen."
      });
    }

    const estadoEsperado = expectedEstadoGuiaParaAgregar(lote.tipo_lote);
    if (!estadoEsperado) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: `Tipo de lote inválido o no soportado: ${lote.tipo_lote}`
      });
    }

    const qGuias = await client.query(
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
        WHERE g.id = ANY($1::int[])
        ORDER BY g.id ASC
      `,
      [idsValidos]
    );

    const guias = qGuias.rows || [];
    if (guias.length !== idsValidos.length) {
      const encontrados = new Set(guias.map((g) => Number(g.id)));
      const faltantes = idsValidos.filter((id) => !encontrados.has(id));
      await client.query("ROLLBACK");
      return res.status(404).json({
        ok: false,
        error: "Una o más guías no existen.",
        faltantes
      });
    }

    const conflictos = [];
    const paraInsertar = [];

    for (const guia of guias) {
      const guiaId = Number(guia.id);
      const tipoLote = String(lote.tipo_lote || "").trim().toUpperCase();
      const estadoLogistico = String(guia.estado_logistico || "").trim().toUpperCase();
      const tipoCobro = String(guia.tipo_cobro || "").trim().toUpperCase();
      const estadoPago = String(guia.estado_pago || "").trim().toLowerCase();
      const cantBultos = Number(guia.cant_bultos_calc || 0);

      const guiaEnOtro = await guiaEnLoteActivo(client, guiaId);
      if (guiaEnOtro && Number(guiaEnOtro.id) !== Number(loteId)) {
        conflictos.push({
          guia_id: guiaId,
          numero_guia: guia.numero_guia,
          error: "La guía ya pertenece a otro lote activo.",
          lote_activo: guiaEnOtro
        });
        continue;
      }

      if (estadoLogistico !== estadoEsperado) {
        conflictos.push({
          guia_id: guiaId,
          numero_guia: guia.numero_guia,
          error: `La guía debe estar en ${estadoEsperado} para entrar a un lote ${tipoLote}.`
        });
        continue;
      }

      if (tipoLote === "COLECTA") {
        if (Number(guia.sucursal_origen_id) !== Number(lote.sucursal_origen_id)) {
          conflictos.push({
            guia_id: guiaId,
            numero_guia: guia.numero_guia,
            error: "La guía no pertenece a la sucursal origen del lote de colecta."
          });
          continue;
        }
      } else if (tipoLote === "DISTRIBUCION") {
        if (Number(guia.sucursal_destino_id) !== Number(lote.sucursal_destino_id)) {
          conflictos.push({
            guia_id: guiaId,
            numero_guia: guia.numero_guia,
            error: "La guía no coincide con el destino final del lote de distribución."
          });
          continue;
        }
      } else {
        conflictos.push({
          guia_id: guiaId,
          numero_guia: guia.numero_guia,
          error: `Tipo de lote no soportado: ${tipoLote}`
        });
        continue;
      }

      if (tipoCobro === "ORIGEN" && estadoPago === "pendiente_origen") {
        conflictos.push({
          guia_id: guiaId,
          numero_guia: guia.numero_guia,
          error: "Una guía con cobro en ORIGEN debe estar cobrada para entrar al lote."
        });
        continue;
      }

      if (!Number.isFinite(cantBultos) || cantBultos <= 0) {
        conflictos.push({
          guia_id: guiaId,
          numero_guia: guia.numero_guia,
          error: "La guía no tiene cantidad de bultos válida."
        });
        continue;
      }

      paraInsertar.push({
        guia_id: guiaId,
        numero_guia: guia.numero_guia,
        cant_bultos_declarada: cantBultos,
        guia_sucursal_destino_id: guia.sucursal_destino_id
      });
    }

    if (conflictos.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "No se pudo agregar el lote completo porque hay guías con conflicto.",
        conflictos
      });
    }

    for (const guia of paraInsertar) {
      await client.query(
        `
          INSERT INTO lote_guias (
            lote_id, guia_id, cant_bultos_declarada
          )
          VALUES ($1, $2, $3)
        `,
        [loteId, guia.guia_id, guia.cant_bultos_declarada]
      );

      await insertarEventoLote(client, {
        loteId,
        evento: "guia_agregada",
        payload: {
          guia_id: guia.guia_id,
          numero_guia: guia.numero_guia,
          cant_bultos_declarada: guia.cant_bultos_declarada,
          guia_sucursal_destino_id: guia.guia_sucursal_destino_id
        },
        userId: u.userId,
        usuario: u.usuario
      });
    }

    await recalcularTotalesLote(client, loteId);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: `${paraInsertar.length} guía(s) agregadas al lote.`,
      lote_id: loteId,
      agregadas: paraInsertar.map((g) => ({
        guia_id: g.guia_id,
        numero_guia: g.numero_guia
      }))
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/lotes/:id/guias/batch error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al agregar guías al lote.",
      detail: err.message
    });
  } finally {
    client.release();
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

    const tipoLote = String(lote.tipo_lote || "").trim().toUpperCase();
    const estadoEsperado = expectedEstadoGuiaParaAgregar(tipoLote);

    if (!estadoEsperado) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: `Tipo de lote inválido o no soportado: ${lote.tipo_lote}`
      });
    }

    if (String(guia.estado_logistico || "").trim().toUpperCase() !== estadoEsperado) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: `La guía debe estar en ${estadoEsperado} para entrar a un lote ${tipoLote}.`
      });
    }

    if (tipoLote === "COLECTA") {
      if (Number(guia.sucursal_origen_id) !== Number(lote.sucursal_origen_id)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "La guía no pertenece a la sucursal origen del lote de colecta."
        });
      }
    } else if (tipoLote === "DISTRIBUCION") {
      if (Number(guia.sucursal_destino_id) !== Number(lote.sucursal_destino_id)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "La guía no coincide con el destino final del lote de distribución."
        });
      }
    } else {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: `Tipo de lote inválido o no soportado: ${tipoLote}`
      });
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

    if (!upLote.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "No se pudo despachar. Verificá que el lote siga CONSOLIDADO."
      });
    }

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

    const qGuiasLote = await client.query(
      `
        SELECT
          lg.guia_id,
          lg.estado_recepcion,
          g.estado_logistico
        FROM lote_guias lg
        JOIN guias g ON g.id = lg.guia_id
        WHERE lg.lote_id = $1
        ORDER BY lg.id ASC
      `,
      [loteId]
    );

    const guiasLote = qGuiasLote.rows || [];
    if (!guiasLote.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "El lote no tiene guías para recepcionar."
      });
    }

    const idsLote = new Set(guiasLote.map((x) => Number(x.guia_id)));
    const idsPayload = [];
    const idsPayloadSet = new Set();

    for (const it of items) {
      const guiaId = asInt(it?.guia_id);
      if (!Number.isFinite(guiaId) || guiaId <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: "Hay guia_id inválido en recepción." });
      }
      if (idsPayloadSet.has(guiaId)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: `La guía ${guiaId} está repetida en la recepción.`
        });
      }
      idsPayloadSet.add(guiaId);
      idsPayload.push(guiaId);
    }

    for (const guiaId of idsPayload) {
      if (!idsLote.has(guiaId)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: `La guía ${guiaId} no pertenece al lote.`
        });
      }
    }

    for (const fila of guiasLote) {
      if (!idsPayloadSet.has(Number(fila.guia_id))) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: `Falta informar recepción para la guía ${fila.guia_id}. Debe resolverse todo el lote.`
        });
      }
    }

    const estadoEsperadoEnRecepcion =
      String(lote.tipo_lote || "").trim().toUpperCase() === "DISTRIBUCION"
        ? "EN_TRANSITO_A_DESTINO"
        : "EN_TRANSITO_A_CENTRAL";

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
    SET
      estado_logistico = $2::varchar,
      novedad_hub_tipo = CASE
        WHEN $2::varchar = 'RECIBIDO_CENTRAL' THEN NULL
        ELSE novedad_hub_tipo
      END,
      novedad_hub_detalle = CASE
        WHEN $2::varchar = 'RECIBIDO_CENTRAL' THEN NULL
        ELSE novedad_hub_detalle
      END,
      novedad_hub_abierta = CASE
        WHEN $2::varchar = 'RECIBIDO_CENTRAL' THEN false
        ELSE novedad_hub_abierta
      END,
      novedad_hub_resolucion = CASE
        WHEN $2::varchar = 'RECIBIDO_CENTRAL' THEN NULL
        ELSE novedad_hub_resolucion
      END
    WHERE id = $1
      AND estado_logistico = $3::varchar
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
        const tipoLoteActual = String(lote.tipo_lote || "").trim().toUpperCase();
        const esHub = isRecepcionHub(tipoLoteActual);

        const nuevoEstadoGuia = esHub
          ? "RECIBIDO_CENTRAL"
          : estadoDestinoRecepcionObservada;

        const novedadTipo = estadoRecepcion === "DANADO" ? "DANADO" : "OBSERVADO";
        const evento = estadoRecepcion === "DANADO" ? "guia_danada" : "guia_observada";

await client.query(
  `
    UPDATE guias
    SET
      estado_logistico = $2::varchar,
      novedad_hub_tipo = CASE WHEN $4 THEN $5::varchar ELSE novedad_hub_tipo END,
      novedad_hub_detalle = CASE WHEN $4 THEN $6::text ELSE novedad_hub_detalle END,
      novedad_hub_abierta = CASE WHEN $4 THEN true ELSE novedad_hub_abierta END,
      novedad_hub_resolucion = CASE WHEN $4 THEN 'CONTINUAR_ENVIO' ELSE novedad_hub_resolucion END
    WHERE id = $1
      AND estado_logistico = $3::varchar
  `,
  [
    guiaId,
    nuevoEstadoGuia,
    estadoEsperadoEnRecepcion,
    esHub,
    novedadTipo,
    obs || `${novedadTipo} en recepción HUB`
  ]
);

        if (deValor === estadoEsperadoEnRecepcion) {
          await insertarHistorialMovimiento(client, {
            guiaId,
            tipo: "ESTADO",
            deValor: estadoEsperadoEnRecepcion,
            aValor: nuevoEstadoGuia,
            sucursalId: lote.sucursal_destino_id,
            userId: u.userId,
            usuario: u.usuario,
            ip: meta.ip,
            userAgent: meta.userAgent
          });
        }

        await insertarEventoLote(client, {
          loteId,
          evento,
          payload: {
            guia_id: guiaId,
            observacion_recepcion: obs || null,
            tipo_lote: lote.tipo_lote,
            nuevo_estado_guia: nuevoEstadoGuia,
            novedad_hub_tipo: esHub ? novedadTipo : null,
            novedad_hub_resolucion: esHub ? "CONTINUAR_ENVIO" : null
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
    const resultadoRecepcion = calcularResultadoRecepcion(
      resumen.total,
      resumen.ok_count,
      resumen.novedad_count
    );

    const up = await client.query(
      `
        UPDATE lotes_colecta
        SET
          estado = 'RECIBIDO',
          resultado_recepcion = $2,
          recibido_en = NOW(),
          recibido_por_user_id = $3,
          recibido_por_usuario = $4
        WHERE id = $1
          AND estado = 'DESPACHADO'
        RETURNING
          id,
          numero_lote,
          tipo_lote,
          estado,
          resultado_recepcion,
          recibido_en,
          recibido_por_user_id,
          recibido_por_usuario
      `,
      [loteId, resultadoRecepcion, u.userId, u.usuario]
    );

    if (!up.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "No se pudo registrar la recepción. Verificá que el lote siga DESPACHADO."
      });
    }

    await insertarEventoLote(client, {
      loteId,
      evento: "recepcion_cerrada",
      payload: {
        estado_final: "RECIBIDO",
        resultado_recepcion: resultadoRecepcion,
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
   POST /interno/lotes/:id/cerrar
========================= */
router.post("/:id/cerrar", async (req, res) => {
  const client = await pool.connect();
  try {
    const loteId = asInt(req.params.id);
    const u = getUser(req);
    const observacionCierre = cleanText(req.body?.observacion_cierre, 2000);

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

    if (!isEstadoLoteRecibido(lote.estado)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "Solo se puede cerrar un lote en estado RECIBIDO."
      });
    }

    if (!canUseSucursal(u, lote.sucursal_destino_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        error: "No tenés permiso para cerrar este lote."
      });
    }

    const up = await client.query(
      `
        UPDATE lotes_colecta
        SET
          estado = 'CERRADO',
          cerrado_en = NOW(),
          cerrado_por_user_id = $2,
          cerrado_por_usuario = $3
        WHERE id = $1
          AND estado = 'RECIBIDO'
        RETURNING
          id,
          numero_lote,
          tipo_lote,
          estado,
          resultado_recepcion,
          recibido_en,
          cerrado_en,
          cerrado_por_user_id,
          cerrado_por_usuario
      `,
      [loteId, u.userId, u.usuario]
    );

    if (!up.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "No se pudo cerrar el lote."
      });
    }

    await insertarEventoLote(client, {
      loteId,
      evento: "cerrado",
      payload: {
        observacion_cierre: observacionCierre || null,
        resultado_recepcion: lote.resultado_recepcion || null,
        tipo_lote: lote.tipo_lote
      },
      userId: u.userId,
      usuario: u.usuario
    });

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Lote cerrado.",
      lote: up.rows[0]
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/lotes/:id/cerrar error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al cerrar lote.",
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

    if (!up.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "No se pudo anular el lote."
      });
    }

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
module.exports.__testables = {
  isEstadoLoteRecibido,
  calcularResultadoRecepcion
};