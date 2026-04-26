const express = require("express");
const pool = require("../config/db");
const { attachEstadoDerivadoMany } = require("../services/guiaEstadoDerivado.service");

const router = express.Router();

/* ============================
   HELPERS
============================ */
function pushEstadoPagoWhere(where, params, estado_pago) {
  const ep = String(estado_pago || "").trim().toLowerCase();
  if (!ep) return;

  if (ep === "pendiente") {
    where.push(
      `LOWER(COALESCE(g.estado_pago,'')) IN ('pendiente_origen','pendiente_destino')`
    );
    return;
  }

  if (ep === "pagado") {
    where.push(
      `LOWER(COALESCE(g.estado_pago,'')) IN ('cobrado_destino','rendido','pagado','pagado_origen','no_aplica')`
    );
    return;
  }

  if (ep === "pendiente_rendicion") {
    where.push(
      `LOWER(COALESCE(g.estado_pago,'')) = 'cobrado_destino' AND g.rendido_at IS NULL`
    );
    return;
  }

  if (ep === "rendido") {
    where.push(
      `LOWER(COALESCE(g.estado_pago,'')) IN ('cobrado_destino','rendido') AND g.rendido_at IS NOT NULL`
    );
    return;
  }

  if (ep === "observado") {
    where.push(`LOWER(COALESCE(g.estado_pago,'')) = 'observado'`);
    return;
  }

  params.push(ep);
  where.push(`LOWER(COALESCE(g.estado_pago,'')) = $${params.length}`);
}

function decorateBandejaRows(items) {
  return (items || []).map((g) => {
    const estadoPago = String(g.estado_pago || "").trim().toLowerCase();
    const tipoCobro = String(g.tipo_cobro || "").trim().toUpperCase();
    const condicionPago = String(g.condicion_pago || "").trim().toUpperCase();

    const esPagoDestino =
      tipoCobro === "DESTINO" || condicionPago === "DESTINO";

    const rendido = !!g.rendido_at || estadoPago === "rendido";
    const pendienteRendicion =
      esPagoDestino &&
      estadoPago === "cobrado_destino" &&
      !rendido;

    return {
      ...g,
      rendicion_estado: rendido
        ? "RENDIDO"
        : pendienteRendicion
          ? "PENDIENTE"
          : "NO_APLICA",
      rendicion_pendiente: pendienteRendicion,
      rendido_bool: rendido,
    };
  });
}

function buildBandejaBaseFilters({
  isPriv,
  sucursalId,
  q,
  estado_logistico,
  estado_pago,
  tipo_cobro,
  sin_metodo,
  rendicion,
}) {
  const where = [];
  const params = [];

  if (!isPriv) {
    params.push(sucursalId);
    where.push(`(g.sucursal_origen_id = $1 OR g.sucursal_destino_id = $1)`);
  }

  if (estado_logistico) {
    const est = String(estado_logistico || "").trim().toUpperCase();

    if (est === "RECIBIDO_CENTRAL") {
      where.push(`g.estado_logistico IN ('RECIBIDO_CENTRAL', 'RECIBIDO_CENTRAL_OBSERVADO')`);
    } else if (est === "RECIBIDO_DESTINO") {
      where.push(`g.estado_logistico IN ('RECIBIDO_DESTINO', 'RECIBIDO_DESTINO_OBSERVADO')`);
    } else if (est === "EN_TRANSITO") {
      where.push(`g.estado_logistico IN ('EN_TRANSITO', 'EN_TRANSITO_A_CENTRAL', 'EN_TRANSITO_A_DESTINO')`);
    } else {
      params.push(est);
      where.push(`UPPER(COALESCE(g.estado_logistico,'')) = $${params.length}`);
    }
  }

  pushEstadoPagoWhere(where, params, estado_pago);

  if (tipo_cobro) {
    params.push(tipo_cobro);
    where.push(`UPPER(COALESCE(g.tipo_cobro,'')) = $${params.length}`);
  }

  if (sin_metodo) {
    where.push(
      `g.estado_pago = 'cobrado_destino' AND (g.metodo_pago IS NULL OR g.metodo_pago = '')`
    );
  }

  if (rendicion === "pendiente") {
    where.push(`g.estado_pago = 'cobrado_destino' AND g.rendido_at IS NULL`);
  }

  if (rendicion === "rendido") {
    where.push(`g.estado_pago = 'cobrado_destino' AND g.rendido_at IS NOT NULL`);
  }

  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    where.push(`(
      g.numero_guia ILIKE ${p}
      OR g.remitente_nombre ILIKE ${p}
      OR g.destinatario_nombre ILIKE ${p}
      OR g.remitente_telefono ILIKE ${p}
      OR g.destinatario_telefono ILIKE ${p}
    )`);
  }

  return { where, params };
}

function buildWhereSql(where) {
  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

function buildBandejaCsv(rows, res) {
  const sep = ";";
  const csvCell = (v) => {
    const s = String(v ?? "");
    const needs = /[;\n\r"]/g.test(s);
    const escaped = s.replace(/"/g, '""');
    return needs ? `"${escaped}"` : escaped;
  };

  const cols = [
    ["numero_guia", "N° Guía"],
    ["created_at", "Fecha"],
    ["sucursal_origen_codigo", "Origen"],
    ["sucursal_destino_codigo", "Destino"],
    ["sucursal_origen_nombre", "Origen (nombre)"],
    ["sucursal_destino_nombre", "Destino (nombre)"],
    ["remitente_nombre", "Remitente"],
    ["remitente_telefono", "Tel Rem"],
    ["destinatario_nombre", "Destinatario"],
    ["destinatario_telefono", "Tel Dest"],
    ["estado_logistico", "Estado Log"],
    ["estado_pago", "Estado Pago"],
    ["metodo_pago", "Método Pago"],
    ["tipo_cobro", "Tipo Cobro"],
    ["condicion_pago", "Condición Pago"],
    ["monto_cobrar_destino", "Monto Cobrar Destino"],
    ["monto_total", "Monto Total"],
    ["rendido_at", "Rendido At"],
    ["rendido_by_usuario", "Rendido Por"],
  ];

  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="exr_bandeja_${stamp}.csv"`
  );

  res.write("\uFEFF");
  res.write(cols.map((c) => csvCell(c[1])).join(sep) + "\n");
  for (const row of rows) {
    res.write(cols.map((c) => csvCell(row?.[c[0]])).join(sep) + "\n");
  }
  return res.end();
}

/* ============================
   SQL comunes
============================ */
const SQL_GUIAS_SELECT = `
  g.id, g.numero_guia, g.created_at,
  g.sucursal_origen_id, g.sucursal_destino_id,
  so.nombre AS sucursal_origen_nombre,
  so.codigo AS sucursal_origen_codigo,
  sd.nombre AS sucursal_destino_nombre,
  sd.codigo AS sucursal_destino_codigo,

  g.estado_logistico,
  g.estado_pago,
  g.condicion_pago,
  g.tipo_cobro,
  g.metodo_pago,

  g.monto_total,
  g.monto_cobrar_destino,
  g.cobro_obligatorio_entrega,
  g.cobrado_destino_at,

  g.rendido_at,
  g.rendido_by_user_id,
  g.rendido_by_usuario,

  g.remitente_nombre, g.remitente_telefono,
  g.destinatario_nombre, g.destinatario_telefono, g.destinatario_direccion,

  COALESCE(b.cant_bultos,0) AS cant_bultos,
  g.fragil,

  false AS observada,
  false AS excepcion_entrega,

  NULL::bigint AS cierre_id,
  NULL::text AS cierre_estado_db,
  NULL::date AS cierre_fecha,

  NULL::bigint AS liquidacion_id,
  NULL::text AS liquidacion_estado_db,

  NULL::bigint AS conciliacion_id,
  NULL::text AS conciliacion_estado_db,

  NULL::text AS ultimo_evento,
  NULL::timestamp AS ultimo_evento_at
`;

const SQL_GUIAS_JOINS = `
  LEFT JOIN sucursales so ON so.id = g.sucursal_origen_id
  LEFT JOIN sucursales sd ON sd.id = g.sucursal_destino_id
  LEFT JOIN (
    SELECT guia_id, COALESCE(SUM(cantidad),0)::int AS cant_bultos
    FROM guia_items
    GROUP BY guia_id
  ) b ON b.guia_id = g.id
`;

async function queryBandeja({ isPriv, sucursalId, filters, limit, offset }) {
  const { where, params } = buildBandejaBaseFilters({
    isPriv,
    sucursalId,
    ...filters,
  });

  const whereSql = buildWhereSql(where);

  const totalQ = `
    SELECT COUNT(*)::int AS total
    FROM guias g
    ${SQL_GUIAS_JOINS}
    ${whereSql}
  `;
  const totalR = await pool.query(totalQ, params);
  const total = totalR.rows?.[0]?.total ?? 0;

  const p = [...params];
  p.push(limit);
  const pLimit = `$${p.length}`;
  p.push(offset);
  const pOffset = `$${p.length}`;

  const dataQ = `
    SELECT ${SQL_GUIAS_SELECT}
    FROM guias g
    ${SQL_GUIAS_JOINS}
    ${whereSql}
    ORDER BY g.created_at DESC
    LIMIT ${pLimit} OFFSET ${pOffset}
  `;
  const r = await pool.query(dataQ, p);

  let rows = decorateBandejaRows(r.rows || []);
  rows = attachEstadoDerivadoMany(rows);

  return { total, rows };
}

/* ============================
   GET /interno/bandeja
============================ */
router.get("/bandeja", async (req, res) => {
  try {
    const rol = String(req.user?.rol || "").trim().toUpperCase();
    const isPriv = rol === "OWNER" || rol === "ADMIN";
    const sucursalId = Number(req.user?.sucursal_id || 0) || null;

    if (!isPriv && !["OPERADOR", "ENCARGADO"].includes(rol)) {
      return res
        .status(403)
        .json({ ok: false, error: "Rol sin permisos para bandeja" });
    }

    const exportAll = String(req.query.export || "") === "1";
    const wantsCSV =
      exportAll && String(req.query.format || "").toLowerCase() === "csv";

    const filters = {
      q: String(req.query.q || "").trim(),
      estado_logistico: String(req.query.estado_logistico || "").trim(),
      estado_pago: String(req.query.estado_pago || "").trim().toLowerCase(),
      tipo_cobro: String(req.query.tipo_cobro || "").trim().toUpperCase(),
      sin_metodo: String(req.query.sin_metodo || "") === "1",
      rendicion: String(req.query.rendicion || "").trim().toLowerCase(),
    };

    const limit = exportAll
      ? 50000
      : Math.min(parseInt(req.query.limit || "25", 10) || 25, 500);

    const offset = exportAll
      ? 0
      : Math.max(parseInt(req.query.offset || "0", 10) || 0, 0);

    if (!isPriv && !sucursalId) {
      return res
        .status(403)
        .json({ ok: false, error: "Usuario sin sucursal asignada" });
    }

    const { total, rows } = await queryBandeja({
      isPriv,
      sucursalId,
      filters,
      limit,
      offset,
    });

    if (wantsCSV) {
      return buildBandejaCsv(rows, res);
    }

    const payload = {
      ok: true,
      scope: isPriv ? "global" : "sucursal",
      sucursal_id: sucursalId,
      total,
      export: exportAll,
      guias: rows,
    };

    res.setHeader("Cache-Control", "no-store");
    return res.json(payload);
  } catch (e) {
    console.error("ERROR /interno/bandeja:", {
      message: e?.message,
      detail: e?.detail,
      hint: e?.hint,
      code: e?.code,
      stack: e?.stack,
    });
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

module.exports = router;