const express = require("express");
const router = express.Router();
const pool = require("../config/db");

/* Helpers */
function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}
function todayISO() {
  return isoDate(new Date());
}
function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

/* =========================================
   GET /interno/dashboard/operativo
   Scope: sucursal del usuario (origen o destino)
========================================= */
router.get("/operativo", async (req, res) => {
  const sucursalId = req.user?.sucursal_id;
  if (!sucursalId) return res.status(401).json({ ok: false, error: "No autenticado" });

  const client = await pool.connect();
  try {
    const qActivas = await client.query(
      `SELECT COUNT(*)::int AS guias_activas
       FROM guias
       WHERE (sucursal_origen_id = $1 OR sucursal_destino_id = $1)
         AND estado_logistico <> 'ENTREGADO'`,
      [sucursalId]
    );

    const qEntHoy = await client.query(
      `SELECT COUNT(*)::int AS entregadas_hoy
       FROM historial_movimientos h
       JOIN guias g ON g.id = h.guia_id
       WHERE h.tipo='ESTADO'
         AND h.a_valor='ENTREGADO'
         AND h.creado_en::date = CURRENT_DATE
         AND (g.sucursal_origen_id = $1 OR g.sucursal_destino_id = $1)`,
      [sucursalId]
    );

    const qCePend = await client.query(
      `SELECT COALESCE(SUM(importe_servicio),0)::numeric(12,2) AS ce_pendiente_en_destino
       FROM guias
       WHERE sucursal_destino_id = $1
         AND estado_logistico = 'RECIBIDO_DESTINO'
         AND estado_pago = 'CONTRA_ENTREGA'`,
      [sucursalId]
    );

    // Riesgo operativo (foto actual): suma valor_declarado NO entregadas dentro del scope de la sucursal
    const qRiesgo = await client.query(
      `SELECT COALESCE(SUM(valor_declarado),0)::numeric(14,2) AS exposicion_en_transito
       FROM guias
       WHERE estado_logistico <> 'ENTREGADO'
         AND (sucursal_origen_id = $1 OR sucursal_destino_id = $1)`,
      [sucursalId]
    );

    const qPagadoHoy = await client.query(
      `SELECT COALESCE(SUM(g.importe_servicio),0)::numeric(12,2) AS pagado_hoy
       FROM historial_movimientos h
       JOIN guias g ON g.id = h.guia_id
       WHERE h.tipo='PAGO'
         AND h.a_valor='PAGADO'
         AND h.creado_en::date = CURRENT_DATE
         AND (g.sucursal_origen_id = $1 OR g.sucursal_destino_id = $1)`,
      [sucursalId]
    );

    const qEstadosLog = await client.query(
      `SELECT estado_logistico AS estado, COUNT(*)::int AS count
       FROM guias
       WHERE (sucursal_origen_id = $1 OR sucursal_destino_id = $1)
       GROUP BY estado_logistico
       ORDER BY estado_logistico`,
      [sucursalId]
    );

    const qEstadosPago = await client.query(
      `SELECT estado_pago AS estado, COUNT(*)::int AS count
       FROM guias
       WHERE (sucursal_origen_id = $1 OR sucursal_destino_id = $1)
       GROUP BY estado_pago
       ORDER BY estado_pago`,
      [sucursalId]
    );

    const qEstancadasDestino48 = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM guias
       WHERE sucursal_destino_id = $1
         AND estado_logistico = 'RECIBIDO_DESTINO'
         AND created_at < NOW() - INTERVAL '48 hours'`,
      [sucursalId]
    );

    const qTransito72 = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM guias
       WHERE (sucursal_origen_id = $1 OR sucursal_destino_id = $1)
AND estado_logistico IN ('EN_TRANSITO', 'EN_TRANSITO_A_CENTRAL', 'EN_TRANSITO_A_DESTINO')
         AND created_at < NOW() - INTERVAL '72 hours'`,
      [sucursalId]
    );

    return res.json({
      ok: true,
      scope: { modo: "SUCURSAL", sucursal_id: sucursalId },
      kpis: {
        guias_activas: qActivas.rows[0]?.guias_activas ?? 0,
        entregadas_hoy: qEntHoy.rows[0]?.entregadas_hoy ?? 0,
        ce_pendiente_en_destino: qCePend.rows[0]?.ce_pendiente_en_destino ?? "0.00",
        pagado_hoy: qPagadoHoy.rows[0]?.pagado_hoy ?? "0.00",
        exposicion_en_transito: qRiesgo.rows[0]?.exposicion_en_transito ?? "0.00",
      },
      estado_logistico: qEstadosLog.rows,
      estado_pago: qEstadosPago.rows,
      alertas: [
        { tipo: "ESTANCADA_DESTINO_48H", count: qEstancadasDestino48.rows[0]?.count ?? 0 },
        { tipo: "TRANSITO_72H", count: qTransito72.rows[0]?.count ?? 0 },
      ],
      generado_en: new Date().toISOString(),
    });
  } catch (e) {
    console.error("GET /interno/dashboard/operativo error:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  } finally {
    client.release();
  }
});

/* =========================================
   GET /interno/dashboard/ejecutivo?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&scope=global|sucursal
   - global: toda la empresa
   - sucursal: filtra por la sucursal del usuario (origen o destino)
========================================= */
router.get("/ejecutivo", async (req, res) => {
  const desde = String(req.query?.desde || daysAgoISO(14));
  const hasta = String(req.query?.hasta || todayISO());

  const scope = String(req.query?.scope || "global").toLowerCase();
  const sucursalId = req.user?.sucursal_id;

  const isSucursal = scope === "sucursal";
  if (isSucursal && !sucursalId) {
    return res.status(400).json({ ok: false, error: "scope=sucursal requiere sucursal_id en token" });
  }

  // ===== Rango anterior (mismos días) =====
  const dDesde = new Date(desde + "T00:00:00");
  const dHasta = new Date(hasta + "T00:00:00");
  const msDay = 24 * 60 * 60 * 1000;
  const days = Math.floor((dHasta - dDesde) / msDay) + 1;

  const prevHastaDate = new Date(dDesde.getTime() - msDay);
  const prevDesdeDate = new Date(prevHastaDate.getTime() - (days - 1) * msDay);

  const prevDesde = isoDate(prevDesdeDate);
  const prevHasta = isoDate(prevHastaDate);

  const client = await pool.connect();
  try {
    // ===== KPIs (rango seleccionado) =====
    const qCreadas = await client.query(
      `SELECT COUNT(*)::int AS guias_creadas
       FROM guias
       WHERE created_at::date BETWEEN $1 AND $2
       ${isSucursal ? "AND (sucursal_origen_id = $3 OR sucursal_destino_id = $3)" : ""}`,
      isSucursal ? [desde, hasta, sucursalId] : [desde, hasta]
    );

    const qEntregadas = await client.query(
      `SELECT COUNT(*)::int AS guias_entregadas
       FROM historial_movimientos h
       JOIN guias g ON g.id = h.guia_id
       WHERE h.tipo='ESTADO'
         AND h.a_valor='ENTREGADO'
         AND h.creado_en::date BETWEEN $1 AND $2
       ${isSucursal ? "AND (g.sucursal_origen_id = $3 OR g.sucursal_destino_id = $3)" : ""}`,
      isSucursal ? [desde, hasta, sucursalId] : [desde, hasta]
    );

    const qFact = await client.query(
      `SELECT COALESCE(SUM(g.importe_servicio),0)::numeric(12,2) AS facturacion_entregadas
       FROM historial_movimientos h
       JOIN guias g ON g.id = h.guia_id
       WHERE h.tipo='ESTADO'
         AND h.a_valor='ENTREGADO'
         AND h.creado_en::date BETWEEN $1 AND $2
       ${isSucursal ? "AND (g.sucursal_origen_id = $3 OR g.sucursal_destino_id = $3)" : ""}`,
      isSucursal ? [desde, hasta, sucursalId] : [desde, hasta]
    );

    const qTicket = await client.query(
      `SELECT COALESCE(AVG(g.importe_servicio),0)::numeric(12,2) AS ticket_promedio
       FROM historial_movimientos h
       JOIN guias g ON g.id = h.guia_id
       WHERE h.tipo='ESTADO'
         AND h.a_valor='ENTREGADO'
         AND h.creado_en::date BETWEEN $1 AND $2
       ${isSucursal ? "AND (g.sucursal_origen_id = $3 OR g.sucursal_destino_id = $3)" : ""}`,
      isSucursal ? [desde, hasta, sucursalId] : [desde, hasta]
    );

    // CE pendiente (foto actual)
    const qCePend = await client.query(
      `SELECT COALESCE(SUM(importe_servicio),0)::numeric(12,2) AS ce_pendiente
       FROM guias
       WHERE estado_pago='CONTRA_ENTREGA'
         AND estado_logistico='RECIBIDO_DESTINO'
       ${isSucursal ? "AND (sucursal_origen_id = $1 OR sucursal_destino_id = $1)" : ""}`,
      isSucursal ? [sucursalId] : []
    );

    // Riesgo (foto actual): exposición por valor declarado NO entregado
    const qRiesgo = await client.query(
      `SELECT COALESCE(SUM(valor_declarado),0)::numeric(14,2) AS exposicion_en_transito
       FROM guias
       WHERE estado_logistico <> 'ENTREGADO'
       ${isSucursal ? "AND (sucursal_origen_id = $1 OR sucursal_destino_id = $1)" : ""}`,
      isSucursal ? [sucursalId] : []
    );

    // ===== KPIs período anterior (mismo tamaño de ventana) =====
    const qEntregadasPrev = await client.query(
      `SELECT COUNT(*)::int AS guias_entregadas
       FROM historial_movimientos h
       JOIN guias g ON g.id = h.guia_id
       WHERE h.tipo='ESTADO'
         AND h.a_valor='ENTREGADO'
         AND h.creado_en::date BETWEEN $1 AND $2
       ${isSucursal ? "AND (g.sucursal_origen_id = $3 OR g.sucursal_destino_id = $3)" : ""}`,
      isSucursal ? [prevDesde, prevHasta, sucursalId] : [prevDesde, prevHasta]
    );

    const qFactPrev = await client.query(
      `SELECT COALESCE(SUM(g.importe_servicio),0)::numeric(12,2) AS facturacion_entregadas
       FROM historial_movimientos h
       JOIN guias g ON g.id = h.guia_id
       WHERE h.tipo='ESTADO'
         AND h.a_valor='ENTREGADO'
         AND h.creado_en::date BETWEEN $1 AND $2
       ${isSucursal ? "AND (g.sucursal_origen_id = $3 OR g.sucursal_destino_id = $3)" : ""}`,
      isSucursal ? [prevDesde, prevHasta, sucursalId] : [prevDesde, prevHasta]
    );

    const qTicketPrev = await client.query(
      `SELECT COALESCE(AVG(g.importe_servicio),0)::numeric(12,2) AS ticket_promedio
       FROM historial_movimientos h
       JOIN guias g ON g.id = h.guia_id
       WHERE h.tipo='ESTADO'
         AND h.a_valor='ENTREGADO'
         AND h.creado_en::date BETWEEN $1 AND $2
       ${isSucursal ? "AND (g.sucursal_origen_id = $3 OR g.sucursal_destino_id = $3)" : ""}`,
      isSucursal ? [prevDesde, prevHasta, sucursalId] : [prevDesde, prevHasta]
    );

    // ===== Ranking (solo global) =====
    const qRanking = isSucursal
      ? { rows: [] }
      : await client.query(
          `SELECT s.id AS sucursal_id, s.nombre,
                  COUNT(*)::int AS guias,
                  COALESCE(SUM(g.importe_servicio),0)::numeric(12,2) AS facturacion
           FROM historial_movimientos h
           JOIN guias g ON g.id = h.guia_id
           JOIN sucursales s ON s.id = g.sucursal_origen_id
           WHERE h.tipo='ESTADO'
             AND h.a_valor='ENTREGADO'
             AND h.creado_en::date BETWEEN $1 AND $2
           GROUP BY s.id, s.nombre
           ORDER BY facturacion DESC
           LIMIT 10`,
          [desde, hasta]
        );

    // ===== Tendencia diaria =====
    const qTrend = await client.query(
      `SELECT h.creado_en::date AS fecha,
              COUNT(*)::int AS entregadas,
              COALESCE(SUM(g.importe_servicio),0)::numeric(12,2) AS facturacion
       FROM historial_movimientos h
       JOIN guias g ON g.id = h.guia_id
       WHERE h.tipo='ESTADO'
         AND h.a_valor='ENTREGADO'
         AND h.creado_en::date BETWEEN $1 AND $2
       ${isSucursal ? "AND (g.sucursal_origen_id = $3 OR g.sucursal_destino_id = $3)" : ""}
       GROUP BY h.creado_en::date
       ORDER BY fecha`,
      isSucursal ? [desde, hasta, sucursalId] : [desde, hasta]
    );

    // ===== Alertas =====
    const qEstancadas48 = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM guias
       WHERE estado_logistico='RECIBIDO_DESTINO'
         AND created_at < NOW() - INTERVAL '48 hours'
       ${isSucursal ? "AND (sucursal_origen_id = $1 OR sucursal_destino_id = $1)" : ""}`,
      isSucursal ? [sucursalId] : []
    );

    return res.json({
      ok: true,
      scope: { modo: isSucursal ? "SUCURSAL" : "GLOBAL", sucursal_id: isSucursal ? sucursalId : null },
      rango: { desde, hasta },
      comparativo: {
        previo: { desde: prevDesde, hasta: prevHasta },
        entregadas_prev: qEntregadasPrev.rows[0]?.guias_entregadas ?? 0,
        facturacion_prev: qFactPrev.rows[0]?.facturacion_entregadas ?? "0.00",
        ticket_prev: qTicketPrev.rows[0]?.ticket_promedio ?? "0.00",
      },
      kpis: {
  guias_creadas: qCreadas.rows[0]?.guias_creadas ?? 0,
  guias_entregadas: qEntregadas.rows[0]?.guias_entregadas ?? 0,
  facturacion_entregadas: qFact.rows[0]?.facturacion_entregadas ?? "0.00",
  ticket_promedio: qTicket.rows[0]?.ticket_promedio ?? "0.00",

  // foto actual
  ce_pendiente: qCePend.rows[0]?.ce_pendiente ?? "0.00",
  exposicion_en_transito: qRiesgo.rows[0]?.exposicion_en_transito ?? "0.00",

  // alias ejecutivos (sin riesgo_total)
  riesgo_cobro: qCePend.rows[0]?.ce_pendiente ?? "0.00",
  riesgo_mercaderia: qRiesgo.rows[0]?.exposicion_en_transito ?? "0.00",
},
 
      ranking_sucursales: qRanking.rows,
      tendencia_diaria: qTrend.rows.map((r) => ({
        fecha: r.fecha,
        entregadas: r.entregadas,
        facturacion: r.facturacion,
      })),
      alertas: [
        { tipo: "GUIAS_ESTANCADAS_48H", count: qEstancadas48.rows[0]?.count ?? 0 },
        { tipo: "CE_ACUMULADO", monto: qCePend.rows[0]?.ce_pendiente ?? "0.00" },
      ],
      generado_en: new Date().toISOString(),
    });
  } catch (e) {
    console.error("GET /interno/dashboard/ejecutivo error:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  } finally {
    client.release();
  }
});

module.exports = router;
