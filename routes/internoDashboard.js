const express = require("express");
const router = express.Router();
const pool = require("../config/db");

// Si tu server.js ya aplica auth por mountProtected, no hace falta auth acá.
const asNull = (v) => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};
const asIntOrNull = (v) => {
  const s = asNull(v);
  if (s == null) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
};
const asLimit = (v, def = 50, max = 200) => {
  const n = parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
};
const asOffset = (v) => {
  const n = parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
};

// GET /interno/dashboard/meta
router.get("/meta", async (req, res) => {
  try {
    const metaSql = `
      SELECT 'estado_pago' AS campo, estado_pago AS valor
      FROM guias GROUP BY estado_pago
      UNION ALL
      SELECT 'tipo_cobro' AS campo, tipo_cobro AS valor
      FROM guias GROUP BY tipo_cobro
      UNION ALL
      SELECT 'estado_logistico' AS campo, estado_logistico AS valor
      FROM guias GROUP BY estado_logistico
      UNION ALL
      SELECT 'metodo_pago' AS campo, metodo_pago AS valor
      FROM guias GROUP BY metodo_pago;
    `;
    const rows = (await pool.query(metaSql)).rows;

    const meta = { estado_pago: [], tipo_cobro: [], estado_logistico: [], metodo_pago: [] };
    for (const r of rows) meta[r.campo].push(r.valor);

    for (const k of Object.keys(meta)) meta[k] = meta[k].filter((x) => x != null).sort();

    const suc = await pool.query(
      `SELECT id, nombre, codigo, tipo
       FROM sucursales
       WHERE activa IS DISTINCT FROM false
       ORDER BY nombre ASC`
    );

    res.json({ ok: true, meta, sucursales: suc.rows });
  } catch (e) {
    console.error("GET /interno/dashboard/meta error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// GET /interno/dashboard/summary
router.get("/summary", async (req, res) => {
  try {
    const from = asNull(req.query.from);
    const to = asNull(req.query.to);
    if (!from || !to) {
      return res.status(400).json({ ok: false, error: "from/to requeridos (YYYY-MM-DD)" });
    }

    const sucursal_id = asIntOrNull(req.query.sucursal_id);
    const estado_pago = asNull(req.query.estado_pago);
    const tipo_cobro = asNull(req.query.tipo_cobro);
    const metodo_pago = asNull(req.query.metodo_pago);

    const q = asNull(req.query.q);
    const limit = asLimit(req.query.limit, 50, 200);
    const offset = asOffset(req.query.offset);

    const kpiSql = `
      SELECT
        COUNT(*)::int AS guias_count,
        COALESCE(SUM(g.monto_total),0) AS facturacion_total,
        COALESCE(SUM(CASE WHEN g.estado_pago='PAGADO' THEN g.monto_total ELSE 0 END),0) AS cobrado_total,
        COALESCE(SUM(CASE WHEN g.estado_pago='CONTRA_ENTREGA' THEN g.monto_total ELSE 0 END),0) AS contra_entrega_total,
        COALESCE(SUM(CASE WHEN g.estado_pago='PENDIENTE' THEN g.monto_total ELSE 0 END),0) AS pendiente_total,
        COALESCE(AVG(g.monto_total),0) AS ticket_promedio
      FROM guias g
      WHERE g.created_at >= $1::date
        AND g.created_at < ($2::date + INTERVAL '1 day')
        AND ($3::int  IS NULL OR g.sucursal_origen_id = $3::int)
        AND ($4::text IS NULL OR g.estado_pago = $4::text)
        AND ($5::text IS NULL OR g.tipo_cobro = $5::text)
        AND ($6::text IS NULL OR g.metodo_pago = $6::text);
    `;
    const kpis = (await pool.query(kpiSql, [from, to, sucursal_id, estado_pago, tipo_cobro, metodo_pago])).rows[0];

    const seriesSql = `
      WITH params AS (
        SELECT
          $1::date AS desde,
          $2::date AS hasta,
          $3::int  AS sucursal_origen_id,
          $4::text AS estado_pago,
          $5::text AS tipo_cobro,
          $6::text AS metodo_pago
      ),
      dias AS (
        SELECT generate_series(
          (SELECT desde FROM params),
          (SELECT hasta FROM params),
          interval '1 day'
        )::date AS dia
      ),
      agg AS (
        SELECT
          DATE(g.created_at) AS dia,
          COALESCE(SUM(g.monto_total),0) AS facturacion,
          COALESCE(SUM(CASE WHEN g.estado_pago='PAGADO' THEN g.monto_total ELSE 0 END),0) AS cobrado,
          COALESCE(SUM(CASE WHEN g.estado_pago='CONTRA_ENTREGA' THEN g.monto_total ELSE 0 END),0) AS contra_entrega,
          COALESCE(SUM(CASE WHEN g.estado_pago='PENDIENTE' THEN g.monto_total ELSE 0 END),0) AS pendiente,
          COUNT(*)::int AS guias
        FROM guias g, params p
        WHERE g.created_at >= p.desde
          AND g.created_at < (p.hasta + INTERVAL '1 day')
          AND (p.sucursal_origen_id IS NULL OR g.sucursal_origen_id = p.sucursal_origen_id)
          AND (p.estado_pago IS NULL OR g.estado_pago = p.estado_pago)
          AND (p.tipo_cobro IS NULL OR g.tipo_cobro = p.tipo_cobro)
          AND (p.metodo_pago IS NULL OR g.metodo_pago = p.metodo_pago)
        GROUP BY DATE(g.created_at)
      )
      SELECT
        d.dia,
        COALESCE(a.facturacion,0) AS facturacion,
        COALESCE(a.cobrado,0) AS cobrado,
        COALESCE(a.contra_entrega,0) AS contra_entrega,
        COALESCE(a.pendiente,0) AS pendiente,
        COALESCE(a.guias,0) AS guias
      FROM dias d
      LEFT JOIN agg a USING (dia)
      ORDER BY d.dia;
    `;
    const series = (await pool.query(seriesSql, [from, to, sucursal_id, estado_pago, tipo_cobro, metodo_pago])).rows;

    const donutMetodoSql = `
      SELECT
        COALESCE(g.metodo_pago,'SIN_METODO') AS label,
        COUNT(*)::int AS value,
        COALESCE(SUM(g.monto_total),0) AS total_monto
      FROM guias g
      WHERE g.created_at >= $1::date
        AND g.created_at < ($2::date + INTERVAL '1 day')
        AND g.estado_pago = 'PAGADO'
        AND ($3::int  IS NULL OR g.sucursal_origen_id = $3::int)
        AND ($4::text IS NULL OR g.tipo_cobro = $4::text)
      GROUP BY COALESCE(g.metodo_pago,'SIN_METODO')
      ORDER BY total_monto DESC;
    `;
    const donut_metodo = (await pool.query(donutMetodoSql, [from, to, sucursal_id, tipo_cobro])).rows;

    const donutEstadoSql = `
      SELECT
        g.estado_logistico AS label,
        COUNT(*)::int AS value
      FROM guias g
      WHERE g.created_at >= $1::date
        AND g.created_at < ($2::date + INTERVAL '1 day')
        AND ($3::int IS NULL OR g.sucursal_origen_id = $3::int)
      GROUP BY g.estado_logistico
      ORDER BY value DESC;
    `;
    const donut_estado = (await pool.query(donutEstadoSql, [from, to, sucursal_id])).rows;

    const tableSql = `
      SELECT
        g.created_at,
        g.numero_guia,
        so.nombre AS origen,
        sd.nombre AS destino,
        g.remitente_nombre,
        g.destinatario_nombre,
        g.estado_logistico,
        g.estado_pago,
        g.tipo_cobro,
        g.metodo_pago,
        g.monto_total
      FROM guias g
      JOIN sucursales so ON so.id = g.sucursal_origen_id
      JOIN sucursales sd ON sd.id = g.sucursal_destino_id
      WHERE g.created_at >= $1::date
        AND g.created_at < ($2::date + INTERVAL '1 day')
        AND ($3::int  IS NULL OR g.sucursal_origen_id = $3::int)
        AND ($4::text IS NULL OR g.estado_pago = $4::text)
        AND ($5::text IS NULL OR g.tipo_cobro = $5::text)
        AND ($6::text IS NULL OR g.metodo_pago = $6::text)
        AND (
          $7::text IS NULL
          OR g.numero_guia ILIKE '%'||$7||'%'
          OR g.remitente_nombre ILIKE '%'||$7||'%'
          OR g.destinatario_nombre ILIKE '%'||$7||'%'
          OR so.nombre ILIKE '%'||$7||'%'
          OR sd.nombre ILIKE '%'||$7||'%'
        )
      ORDER BY g.created_at DESC
      LIMIT $8::int OFFSET $9::int;
    `;
    const table = (await pool.query(tableSql, [from, to, sucursal_id, estado_pago, tipo_cobro, metodo_pago, q, limit, offset])).rows;

    res.json({ ok: true, kpis, series, donut_metodo, donut_estado, table, page: { limit, offset } });
  } catch (e) {
    console.error("GET /interno/dashboard/summary error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

module.exports = router;
