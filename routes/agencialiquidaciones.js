const express = require("express");
const router = express.Router();

const pool = require("../config/db");

function getUserSucursalId(req) {
  return Number(req.user?.sucursal_id || req.user?.sucursalId || 0);
}

function getUserRole(req) {
  return String(req.user?.rol || req.user?.role || "").toUpperCase();
}

router.get("/liquidaciones/resumen", async (req, res) => {
  try {
    const rol = getUserRole(req);
    const sucursalId = getUserSucursalId(req);

    if (!sucursalId && !["OWNER", "ADMIN"].includes(rol)) {
      return res.status(403).json({
        ok: false,
        error: "Usuario sin sucursal asignada.",
      });
    }

    const params = [];
    let where = "";

    if (!["OWNER", "ADMIN"].includes(rol)) {
      params.push(sucursalId);
      where = "WHERE sucursal_id = $1";
    }

    const { rows } = await pool.query(
      `
      SELECT
        id,
        sucursal_id,
        periodo_desde,
        periodo_hasta,
        fecha_emision,
        fecha_vencimiento,
        saldo_inicial,
        total_creditos,
        total_debitos,
        saldo_neto,
        moneda,
        estado,
        total_pagos_registrados,
        saldo_pendiente_absoluto
      FROM vw_sucursal_liquidaciones_resumen
      ${where}
      ORDER BY fecha_emision DESC, id DESC
      LIMIT 100
      `,
      params
    );

    const liquidacionesPendientes = rows.filter(
      (r) => String(r.estado || "").toUpperCase() !== "CONCILIADA"
    );

    const saldoPendiente = liquidacionesPendientes.reduce((acc, r) => {
      return acc + Number(r.saldo_pendiente_absoluto || 0);
    }, 0);

    const totalHistorico = rows.reduce((acc, r) => {
      return acc + Math.abs(Number(r.saldo_neto || 0));
    }, 0);

    res.json({
      ok: true,
      kpis: {
        saldo_pendiente: saldoPendiente,
        liquidaciones_pendientes: liquidacionesPendientes.length,
        ultima_liquidacion_fecha: rows[0]?.fecha_emision || null,
        total_historico: totalHistorico,
      },
      liquidaciones: rows.map((r) => ({
        id: r.id,
        sucursal_id: r.sucursal_id,
        periodo_desde: r.periodo_desde,
        periodo_hasta: r.periodo_hasta,
        fecha: r.fecha_emision,
        vencimiento: r.fecha_vencimiento,
        estado: r.estado,
        moneda: r.moneda,
        total_debe: r.total_debitos,
        total_haber: r.total_creditos,
        saldo: r.saldo_neto,
        saldo_pendiente: r.saldo_pendiente_absoluto,
        pagos_registrados: r.total_pagos_registrados,
      })),
    });
  } catch (err) {
    console.error("GET /interno/agencia/liquidaciones/resumen error:", err);
    res.status(500).json({
      ok: false,
      error: "Error interno cargando liquidaciones de agencia.",
    });
  }
});

module.exports = router;