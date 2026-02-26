console.log("CARGANDO routes/finanzas.js");

const express = require("express");
const router = express.Router();
const pool = require("../config/db");

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

router.get("/ping", (req, res) => res.json({ ok: true, from: "finanzas" }));

/**
 * POST /interno/finanzas/cierre
 * Body opcional:
 *  - fecha: YYYY-MM-DD (default hoy)
 *  - scope: global|sucursal (default global)
 *
 * Scope=sucursal usa req.user.sucursal_id (origen o destino)
 */
router.post("/cierre", async (req, res) => {
  const fecha = String(req.body?.fecha || isoDate(new Date()));
  const scope = String(req.body?.scope || "global").toLowerCase();
  const isSucursal = scope === "sucursal";
  const sucursalId = req.user?.sucursal_id;

  if (isSucursal && !sucursalId) {
    return res.status(400).json({ ok: false, error: "scope=sucursal requiere sucursal_id en token" });
  }

  const scopeModo = isSucursal ? "SUCURSAL" : "GLOBAL";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Evitar doble cierre
    const ex = await client.query(
      `SELECT id, fecha, scope_modo, sucursal_id, total_pagado, total_ce_pendiente, total_entregadas, creado_en
       FROM cierres_diarios
       WHERE fecha = $1 AND scope_modo = $2 AND (sucursal_id IS NOT DISTINCT FROM $3)`,
      [fecha, scopeModo, isSucursal ? sucursalId : null]
    );

    if (ex.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "El día ya está cerrado para ese scope", cierre: ex.rows[0] });
    }

    // Total pagado del día (según historial pagos -> PAGADO)
    const qPagado = await client.query(
      `SELECT COALESCE(SUM(g.importe_servicio),0)::numeric(12,2) AS total_pagado
       FROM historial_movimientos h
       JOIN guias g ON g.id = h.guia_id
       WHERE h.tipo='PAGO'
         AND h.a_valor='PAGADO'
         AND h.creado_en::date = $1
       ${isSucursal ? "AND (g.sucursal_origen_id = $2 OR g.sucursal_destino_id = $2)" : ""}`,
      isSucursal ? [fecha, sucursalId] : [fecha]
    );

    // Total entregadas del día (historial estado -> ENTREGADO)
    const qEnt = await client.query(
      `SELECT COUNT(*)::int AS total_entregadas
       FROM historial_movimientos h
       JOIN guias g ON g.id = h.guia_id
       WHERE h.tipo='ESTADO'
         AND h.a_valor='ENTREGADO'
         AND h.creado_en::date = $1
       ${isSucursal ? "AND (g.sucursal_origen_id = $2 OR g.sucursal_destino_id = $2)" : ""}`,
      isSucursal ? [fecha, sucursalId] : [fecha]
    );

    // Foto actual CE pendiente (contra entrega en destino)
    const qCe = await client.query(
      `SELECT COALESCE(SUM(importe_servicio),0)::numeric(12,2) AS total_ce_pendiente
       FROM guias
       WHERE estado_pago='CONTRA_ENTREGA'
         AND estado_logistico='RECIBIDO_DESTINO'
       ${isSucursal ? "AND (sucursal_origen_id = $1 OR sucursal_destino_id = $1)" : ""}`,
      isSucursal ? [sucursalId] : []
    );

    const total_pagado = qPagado.rows[0]?.total_pagado ?? "0.00";
    const total_entregadas = qEnt.rows[0]?.total_entregadas ?? 0;
    const total_ce_pendiente = qCe.rows[0]?.total_ce_pendiente ?? "0.00";

    const ins = await client.query(
      `INSERT INTO cierres_diarios
       (fecha, scope_modo, sucursal_id, total_pagado, total_ce_pendiente, total_entregadas, creado_por_user_id, creado_por_usuario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        fecha,
        scopeModo,
        isSucursal ? sucursalId : null,
        total_pagado,
        total_ce_pendiente,
        total_entregadas,
        req.user?.user_id,
        req.user?.usuario || null,
      ]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, cierre: ins.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /interno/finanzas/cierre error:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  } finally {
    client.release();
  }
});

// Listado de cierres recientes
router.get("/cierres", async (req, res) => {
  const limit = Math.min(Number(req.query?.limit || 30), 200);
  const scope = String(req.query?.scope || "global").toLowerCase();
  const isSucursal = scope === "sucursal";
  const sucursalId = req.user?.sucursal_id;

  if (isSucursal && !sucursalId) {
    return res.status(400).json({ ok: false, error: "scope=sucursal requiere sucursal_id en token" });
  }

  try {
    const q = await pool.query(
      `SELECT *
       FROM cierres_diarios
       WHERE scope_modo = $1
         AND (sucursal_id IS NOT DISTINCT FROM $2)
       ORDER BY fecha DESC
       LIMIT $3`,
      [isSucursal ? "SUCURSAL" : "GLOBAL", isSucursal ? sucursalId : null, limit]
    );
    return res.json({ ok: true, data: q.rows });
  } catch (e) {
    console.error("GET /interno/finanzas/cierres error:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

module.exports = router;
