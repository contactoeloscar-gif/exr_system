const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { isOwnerOrAdmin } = require("../middleware/roles");

/* =========================
   Helpers
========================= */
function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function asNum(v) {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : NaN;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function asDate(v) {
  const s = String(v || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function cleanText(v, max = 255) {
  return String(v ?? "").trim().slice(0, max);
}

function getUser(req) {
  return {
    userId: asInt(req.user?.user_id ?? req.user?.id),
    usuario: cleanText(req.user?.usuario || req.user?.nombre || "system", 120),
    rol: String(req.user?.rol || req.user?.role || "").trim().toUpperCase(),
    sucursalId: asInt(req.user?.sucursal_id),
  };
}

function mustBeAuthenticatedUser(u) {
  return Number.isFinite(u.userId) && u.userId > 0;
}

function assertAdminRole(req, res) {
  const u = getUser(req);

  if (!mustBeAuthenticatedUser(u)) {
    res.status(401).json({ ok: false, error: "No autenticado." });
    return null;
  }

  if (!isOwnerOrAdmin(req)) {
    res.status(403).json({ ok: false, error: "Sin permisos para contabilidad/agencias." });
    return null;
  }

  return u;
}

function buildLiquidacionEstadoDerivado(row) {
  const estadoRaw = String(row?.estado || "").trim().toUpperCase();
  const nueva = !!row?.notificada_at && !row?.vista_agencia_at;

  let estado_visible = estadoRaw || "BORRADOR";
  let resumen_corto = "Liquidación disponible";

  if (estadoRaw === "BORRADOR" || estadoRaw === "OBSERVADA") {
    estado_visible = "PENDIENTE_REVISION";
    resumen_corto = "Pendiente de revisión interna";
  } else if (estadoRaw === "APROBADA") {
    estado_visible = "APROBADA";
    resumen_corto = "Aprobada y pendiente de cobro/pago";
  } else if (estadoRaw === "PAGADA_PARCIAL") {
    estado_visible = "PENDIENTE_CONCILIACION";
    resumen_corto = "Pago/cobro parcial registrado";
  } else if (estadoRaw === "PAGADA_TOTAL") {
    estado_visible = "CONCILIADA";
    resumen_corto = "Liquidación conciliada";
  } else if (estadoRaw === "ANULADA") {
    estado_visible = "ANULADA";
    resumen_corto = "Liquidación anulada";
  }

  return {
    nueva,
    estado_visible,
    resumen_corto,
  };
}

/* =========================
   DB helpers
========================= */
async function getSucursalAgencia(client, sucursalId) {
  const q = await client.query(
    `
      SELECT
        id,
        nombre,
        tipo_sucursal,
        liquida_con_exr,
        activa_liquidacion,
        plazo_liquidacion_dias,
        razon_social,
        cuit,
        condicion_iva,
        alias_cbu,
        titular_cuenta
      FROM sucursales
      WHERE id = $1
      LIMIT 1
    `,
    [sucursalId]
  );
  return q.rows[0] || null;
}

async function getLiquidacionCabecera(client, liquidacionId) {
  const q = await client.query(
    `
      SELECT
        l.*,
        s.nombre AS sucursal_nombre,
        s.razon_social,
        s.cuit,
        s.condicion_iva,
        s.alias_cbu,
        s.titular_cuenta
      FROM sucursal_liquidaciones l
      JOIN sucursales s ON s.id = l.sucursal_id
      WHERE l.id = $1
      LIMIT 1
    `,
    [liquidacionId]
  );
  return q.rows[0] || null;
}

async function getLiquidacionItems(client, liquidacionId) {
  const q = await client.query(
    `
      SELECT
        i.id,
        i.liquidacion_id,
        i.movimiento_id,
        i.sucursal_id,
        i.guia_id,
        g.numero_guia,
        i.fecha_operativa,
        i.sentido,
        i.concepto,
        i.importe,
        i.descripcion_snapshot,
        i.meta_snapshot,
        i.created_at
      FROM sucursal_liquidacion_items i
      LEFT JOIN guias g ON g.id = i.guia_id
      WHERE i.liquidacion_id = $1
      ORDER BY i.fecha_operativa ASC, i.id ASC
    `,
    [liquidacionId]
  );
  return q.rows || [];
}

async function getLiquidacionPagos(client, liquidacionId) {
  const q = await client.query(
    `
      SELECT
        id,
        liquidacion_id,
        sucursal_id,
        tipo,
        fecha,
        medio_pago,
        importe,
        referencia,
        estado,
        observaciones,
        created_by_user_id,
        created_at
      FROM sucursal_liquidacion_pagos
      WHERE liquidacion_id = $1
      ORDER BY fecha ASC, id ASC
    `,
    [liquidacionId]
  );
  return q.rows || [];
}

async function recalcLiquidacionTotals(client, liquidacionId) {
  const cab = await getLiquidacionCabecera(client, liquidacionId);
  if (!cab) return null;

  const qItems = await client.query(
    `
      SELECT
        COALESCE(SUM(CASE WHEN sentido = 'CREDITO_AGENCIA' THEN importe ELSE 0 END), 0)::numeric(12,2) AS total_creditos,
        COALESCE(SUM(CASE WHEN sentido = 'DEBITO_AGENCIA' THEN importe ELSE 0 END), 0)::numeric(12,2) AS total_debitos
      FROM sucursal_liquidacion_items
      WHERE liquidacion_id = $1
    `,
    [liquidacionId]
  );

  const totalCreditos = round2(qItems.rows[0]?.total_creditos || 0);
  const totalDebitos = round2(qItems.rows[0]?.total_debitos || 0);
  const saldoInicial = round2(cab.saldo_inicial || 0);
  const saldoNeto = round2(saldoInicial + totalCreditos - totalDebitos);

  await client.query(
    `
      UPDATE sucursal_liquidaciones
      SET
        total_creditos = $2,
        total_debitos = $3,
        saldo_neto = $4,
        updated_at = NOW()
      WHERE id = $1
    `,
    [liquidacionId, totalCreditos, totalDebitos, saldoNeto]
  );

  return {
    total_creditos: totalCreditos,
    total_debitos: totalDebitos,
    saldo_neto: saldoNeto,
    saldo_inicial: saldoInicial,
  };
}

async function computeLiquidacionResumen(client, liquidacionId) {
  const cab = await getLiquidacionCabecera(client, liquidacionId);
  if (!cab) return null;

  const totals = await recalcLiquidacionTotals(client, liquidacionId);

  const qPagos = await client.query(
    `
      SELECT
        COALESCE(SUM(CASE WHEN COALESCE(estado, '') <> 'ANULADO' THEN importe ELSE 0 END), 0)::numeric(12,2) AS total_pagos
      FROM sucursal_liquidacion_pagos
      WHERE liquidacion_id = $1
    `,
    [liquidacionId]
  );

  const totalPagos = round2(qPagos.rows[0]?.total_pagos || 0);
  const saldoPendienteAbs = round2(Math.max(0, Math.abs(totals.saldo_neto) - totalPagos));

  return {
    id: cab.id,
    sucursal_id: cab.sucursal_id,
    sucursal_nombre: cab.sucursal_nombre,
    periodo_desde: cab.periodo_desde,
    periodo_hasta: cab.periodo_hasta,
    fecha_emision: cab.fecha_emision,
    estado: cab.estado,
    moneda: cab.moneda || "ARS",
    saldo_inicial: totals.saldo_inicial,
    total_creditos: totals.total_creditos,
    total_debitos: totals.total_debitos,
    saldo_neto: totals.saldo_neto,
    total_pagos_registrados: totalPagos,
    saldo_pendiente_absoluto: saldoPendienteAbs,
  };
}

async function updateLiquidacionEstadoPorPagos(client, liquidacionId, forcedState = null) {
  const resumen = await computeLiquidacionResumen(client, liquidacionId);
  if (!resumen) return null;

  let nuevoEstado = forcedState || resumen.estado;

  if (!forcedState) {
    const actual = String(resumen.estado || "").toUpperCase();

    if (["ANULADA"].includes(actual)) {
      nuevoEstado = actual;
    } else if (round2(resumen.total_pagos_registrados) <= 0) {
      nuevoEstado = actual === "BORRADOR" ? "BORRADOR" : "APROBADA";
    } else if (round2(resumen.saldo_pendiente_absoluto) === 0) {
      nuevoEstado = "PAGADA_TOTAL";
    } else {
      nuevoEstado = "PAGADA_PARCIAL";
    }
  }

  await client.query(
    `
      UPDATE sucursal_liquidaciones
      SET
        estado = $2,
        updated_at = NOW()
      WHERE id = $1
    `,
    [liquidacionId, nuevoEstado]
  );

  return computeLiquidacionResumen(client, liquidacionId);
}

/* =========================
   GET /interno/contabilidad/agencias/resumen
========================= */
router.get("/agencias/resumen", async (req, res) => {
  try {
    const u = assertAdminRole(req, res);
    if (!u) return;

    const q = await pool.query(
      `
        SELECT
          s.id AS sucursal_id,
          s.nombre AS sucursal_nombre,
          s.tipo_sucursal,
          s.liquida_con_exr,
          s.activa_liquidacion,

          COALESCE(SUM(CASE
            WHEN m.estado = 'PENDIENTE' AND m.sentido = 'CREDITO_AGENCIA'
            THEN m.importe ELSE 0 END), 0)::numeric(12,2) AS creditos_abiertos,

          COALESCE(SUM(CASE
            WHEN m.estado = 'PENDIENTE' AND m.sentido = 'DEBITO_AGENCIA'
            THEN m.importe ELSE 0 END), 0)::numeric(12,2) AS debitos_abiertos,

          (
            COALESCE(SUM(CASE
              WHEN m.estado = 'PENDIENTE' AND m.sentido = 'CREDITO_AGENCIA'
              THEN m.importe ELSE 0 END), 0)
            -
            COALESCE(SUM(CASE
              WHEN m.estado = 'PENDIENTE' AND m.sentido = 'DEBITO_AGENCIA'
              THEN m.importe ELSE 0 END), 0)
          )::numeric(12,2) AS saldo_abierto,

          (
            COALESCE(SUM(CASE
              WHEN m.estado = 'BLOQUEADO_CIERRE' AND m.sentido = 'CREDITO_AGENCIA'
              THEN m.importe ELSE 0 END), 0)
            -
            COALESCE(SUM(CASE
              WHEN m.estado = 'BLOQUEADO_CIERRE' AND m.sentido = 'DEBITO_AGENCIA'
              THEN m.importe ELSE 0 END), 0)
          )::numeric(12,2) AS saldo_liquidable,

          (
            COALESCE(SUM(CASE
              WHEN m.estado = 'INCLUIDO_LIQUIDACION' AND m.sentido = 'CREDITO_AGENCIA'
              THEN m.importe ELSE 0 END), 0)
            -
            COALESCE(SUM(CASE
              WHEN m.estado = 'INCLUIDO_LIQUIDACION' AND m.sentido = 'DEBITO_AGENCIA'
              THEN m.importe ELSE 0 END), 0)
          )::numeric(12,2) AS saldo_en_liquidacion,

          COUNT(*) FILTER (WHERE m.estado = 'PENDIENTE')::int AS cant_pendiente,
          COUNT(*) FILTER (WHERE m.estado = 'BLOQUEADO_CIERRE')::int AS cant_bloqueado_cierre,
          COUNT(*) FILTER (WHERE m.estado = 'INCLUIDO_LIQUIDACION')::int AS cant_en_liquidacion

        FROM sucursales s
        LEFT JOIN sucursal_ctacte_movimientos m
          ON m.sucursal_id = s.id
        WHERE s.tipo_sucursal = 'AGENCIA'
          AND s.liquida_con_exr = true
          AND s.activa_liquidacion = true
        GROUP BY
          s.id, s.nombre, s.tipo_sucursal, s.liquida_con_exr, s.activa_liquidacion
        ORDER BY s.nombre ASC
      `
    );

    return res.json({
      ok: true,
      total: q.rows.length,
      items: q.rows,
    });
  } catch (err) {
    console.error("GET /interno/contabilidad/agencias/resumen error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al listar resumen de agencias.",
      detail: err.message,
    });
  }
});
/* =========================
   GET /interno/contabilidad/agencias/:sucursalId/movimientos
========================= */
router.get("/agencias/:sucursalId/movimientos", async (req, res) => {
  try {
    const u = assertAdminRole(req, res);
    if (!u) return;

    const sucursalId = asInt(req.params.sucursalId);
    const fechaDesde = asDate(req.query?.fecha_desde);
    const fechaHasta = asDate(req.query?.fecha_hasta);
    const estado = cleanText(req.query?.estado, 40).toUpperCase();
    const qtxt = cleanText(req.query?.q, 120);
    const limit = Math.min(Math.max(asInt(req.query?.limit) || 200, 1), 1000);

    if (!Number.isFinite(sucursalId) || sucursalId <= 0) {
      return res.status(400).json({ ok: false, error: "sucursalId inválido." });
    }

    const params = [sucursalId];
    const where = [`m.sucursal_id = $1`];

    if (fechaDesde) {
      params.push(fechaDesde);
      where.push(`m.fecha_operativa >= $${params.length}::date`);
    }
    if (fechaHasta) {
      params.push(fechaHasta);
      where.push(`m.fecha_operativa <= $${params.length}::date`);
    }
    if (estado) {
      params.push(estado);
      where.push(`UPPER(COALESCE(m.estado,'')) = $${params.length}`);
    }
    if (qtxt) {
      params.push(`%${qtxt}%`);
      where.push(`(
        COALESCE(g.numero_guia, '') ILIKE $${params.length}
        OR COALESCE(m.ref_uid, '') ILIKE $${params.length}
        OR COALESCE(m.descripcion, '') ILIKE $${params.length}
      )`);
    }

    params.push(limit);

    const q = await pool.query(
      `
        SELECT
          m.id,
          m.sucursal_id,
          s.nombre AS sucursal_nombre,
          m.fecha_operativa,
          m.fecha_contable,
          m.ref_uid,
          m.sentido,
          m.concepto,
          m.origen_tipo,
          m.origen_id,
          m.guia_id,
          g.numero_guia,
          m.guia_cobro_id,
          m.cierre_id,
          m.importe,
          m.moneda,
          m.estado,
          m.descripcion,
          m.meta,
          m.generado_automaticamente,
          m.created_by_user_id,
          m.created_at
        FROM sucursal_ctacte_movimientos m
        JOIN sucursales s ON s.id = m.sucursal_id
        LEFT JOIN guias g ON g.id = m.guia_id
        WHERE ${where.join(" AND ")}
        ORDER BY m.fecha_operativa DESC, m.id DESC
        LIMIT $${params.length}
      `,
      params
    );

    return res.json({
      ok: true,
      total: q.rows.length,
      items: q.rows,
    });
  } catch (err) {
    console.error("GET /interno/contabilidad/agencias/:sucursalId/movimientos error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al listar movimientos.",
      detail: err.message,
    });
  }
});

/* =========================
   GET /interno/contabilidad/agencias/:sucursalId/liquidables
========================= */
router.get("/agencias/:sucursalId/liquidables", async (req, res) => {
  try {
    const u = assertAdminRole(req, res);
    if (!u) return;

    const sucursalId = asInt(req.params.sucursalId);
    const fechaDesde = asDate(req.query?.fecha_desde);
    const fechaHasta = asDate(req.query?.fecha_hasta);

    if (!Number.isFinite(sucursalId) || sucursalId <= 0) {
      return res.status(400).json({ ok: false, error: "sucursalId inválido." });
    }

    const params = [sucursalId];
    const where = [`m.sucursal_id = $1`, `m.estado = 'BLOQUEADO_CIERRE'`];

    if (fechaDesde) {
      params.push(fechaDesde);
      where.push(`m.fecha_operativa >= $${params.length}::date`);
    }
    if (fechaHasta) {
      params.push(fechaHasta);
      where.push(`m.fecha_operativa <= $${params.length}::date`);
    }

    const q = await pool.query(
      `
        SELECT
          m.id,
          m.sucursal_id,
          s.nombre AS sucursal_nombre,
          m.fecha_operativa,
          m.fecha_contable,
          m.ref_uid,
          m.sentido,
          m.concepto,
          m.origen_tipo,
          m.origen_id,
          m.guia_id,
          g.numero_guia,
          m.guia_cobro_id,
          m.cierre_id,
          m.importe,
          m.moneda,
          m.estado,
          m.descripcion,
          m.meta,
          m.generado_automaticamente,
          m.created_by_user_id,
          m.created_at
        FROM sucursal_ctacte_movimientos m
        JOIN sucursales s ON s.id = m.sucursal_id
        LEFT JOIN guias g ON g.id = m.guia_id
        WHERE ${where.join(" AND ")}
        ORDER BY m.fecha_operativa ASC, m.id ASC
      `,
      params
    );

    const resumen = q.rows.reduce(
      (acc, row) => {
        const imp = round2(row.importe);
        if (row.sentido === "CREDITO_AGENCIA") acc.total_creditos += imp;
        if (row.sentido === "DEBITO_AGENCIA") acc.total_debitos += imp;
        return acc;
      },
      { total_creditos: 0, total_debitos: 0 }
    );

    resumen.saldo_neto = round2(resumen.total_creditos - resumen.total_debitos);

    return res.json({
      ok: true,
      total: q.rows.length,
      resumen,
      items: q.rows,
    });
  } catch (err) {
    console.error("GET /interno/contabilidad/agencias/:sucursalId/liquidables error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al listar movimientos liquidables.",
      detail: err.message,
    });
  }
});

/* =========================
   POST /interno/contabilidad/liquidaciones/generar
========================= */
router.post("/liquidaciones/generar", async (req, res) => {
  const client = await pool.connect();
  try {
    const u = assertAdminRole(req, res);
    if (!u) return;

    const sucursalId = asInt(req.body?.sucursal_id);
    const periodoDesde = asDate(req.body?.periodo_desde);
    const periodoHasta = asDate(req.body?.periodo_hasta);
    const observaciones = cleanText(req.body?.observaciones, 2000);

    if (!Number.isFinite(sucursalId) || sucursalId <= 0) {
      return res.status(400).json({ ok: false, error: "sucursal_id inválido." });
    }
    if (!periodoDesde || !periodoHasta) {
      return res.status(400).json({ ok: false, error: "periodo_desde / periodo_hasta inválidos." });
    }
    if (periodoHasta < periodoDesde) {
      return res.status(400).json({ ok: false, error: "El período es inválido." });
    }

    await client.query("BEGIN");

    const sucursal = await getSucursalAgencia(client, sucursalId);
    if (!sucursal) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Sucursal no encontrada." });
    }
    if (
      String(sucursal.tipo_sucursal || "").toUpperCase() !== "AGENCIA" ||
      !sucursal.liquida_con_exr ||
      !sucursal.activa_liquidacion
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "La sucursal no está habilitada como agencia liquidable.",
      });
    }

    const qMovs = await client.query(
      `
        SELECT
          id,
          sucursal_id,
          guia_id,
          fecha_operativa,
          sentido,
          concepto,
          importe,
          descripcion,
          meta
        FROM sucursal_ctacte_movimientos
        WHERE sucursal_id = $1
          AND estado = 'BLOQUEADO_CIERRE'
          AND fecha_operativa >= $2::date
          AND fecha_operativa <= $3::date
        ORDER BY fecha_operativa ASC, id ASC
      `,
      [sucursalId, periodoDesde, periodoHasta]
    );

    const movimientos = qMovs.rows || [];
    if (!movimientos.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "No hay movimientos bloqueados para liquidar en ese período.",
      });
    }

    const insCab = await client.query(
      `
        INSERT INTO sucursal_liquidaciones
        (
          sucursal_id,
          periodo_desde,
          periodo_hasta,
          fecha_emision,
          saldo_inicial,
          total_creditos,
          total_debitos,
          saldo_neto,
          moneda,
          estado,
          observaciones,
          created_by_user_id
        )
        VALUES ($1, $2::date, $3::date, CURRENT_DATE, 0, 0, 0, 0, 'ARS', 'BORRADOR', $4, $5)
        RETURNING id
      `,
      [sucursalId, periodoDesde, periodoHasta, observaciones || null, u.userId]
    );

    const liquidacionId = insCab.rows[0].id;

    await client.query(
      `
        INSERT INTO sucursal_liquidacion_items
        (
          liquidacion_id,
          movimiento_id,
          sucursal_id,
          guia_id,
          fecha_operativa,
          sentido,
          concepto,
          importe,
          descripcion_snapshot,
          meta_snapshot
        )
        SELECT
          $1,
          m.id,
          m.sucursal_id,
          m.guia_id,
          m.fecha_operativa,
          m.sentido,
          m.concepto,
          m.importe,
          m.descripcion,
          m.meta
        FROM sucursal_ctacte_movimientos m
        WHERE m.sucursal_id = $2
          AND m.estado = 'BLOQUEADO_CIERRE'
          AND m.fecha_operativa >= $3::date
          AND m.fecha_operativa <= $4::date
      `,
      [liquidacionId, sucursalId, periodoDesde, periodoHasta]
    );

    await recalcLiquidacionTotals(client, liquidacionId);

    await client.query(
      `
        UPDATE sucursal_ctacte_movimientos
        SET estado = 'INCLUIDO_LIQUIDACION'
        WHERE id IN (
          SELECT movimiento_id
          FROM sucursal_liquidacion_items
          WHERE liquidacion_id = $1
        )
          AND estado = 'BLOQUEADO_CIERRE'
      `,
      [liquidacionId]
    );

    const resumen = await computeLiquidacionResumen(client, liquidacionId);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Liquidación generada.",
      liquidacion_id: liquidacionId,
      resumen,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/contabilidad/liquidaciones/generar error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al generar liquidación.",
      detail: err.message,
    });
  } finally {
    client.release();
  }
});

/* =========================
   GET /interno/contabilidad/liquidaciones/resumen
   ADMIN ONLY
========================= */
router.get("/liquidaciones/resumen", async (req, res) => {
  try {
    const u = assertAdminRole(req, res);
    if (!u) return;

    const q = await pool.query(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE l.notificada_at IS NOT NULL
              AND l.vista_agencia_at IS NULL
          )::int AS nuevas,

          COUNT(*) FILTER (
            WHERE UPPER(COALESCE(l.estado,'')) = 'APROBADA'
          )::int AS pendientes_pago,

          COUNT(*) FILTER (
            WHERE UPPER(COALESCE(l.estado,'')) = 'PAGADA_PARCIAL'
          )::int AS pendientes_conciliacion,

          COUNT(*) FILTER (
            WHERE UPPER(COALESCE(l.estado,'')) = 'PAGADA_TOTAL'
          )::int AS conciliadas
        FROM sucursal_liquidaciones l
      `
    );

    const row = q.rows?.[0] || {};

    return res.json({
      ok: true,
      nuevas: Number(row.nuevas || 0),
      pendientes_pago: Number(row.pendientes_pago || 0),
      pendientes_conciliacion: Number(row.pendientes_conciliacion || 0),
      conciliadas: Number(row.conciliadas || 0),
    });
  } catch (err) {
    console.error("GET /interno/contabilidad/liquidaciones/resumen error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al consultar resumen de liquidaciones.",
      detail: err.message,
    });
  }
});

/* =========================
   GET /interno/contabilidad/liquidaciones
   ADMIN ONLY
========================= */
router.get("/liquidaciones", async (req, res) => {
  try {
    const u = assertAdminRole(req, res);
    if (!u) return;

    const estado = cleanText(req.query?.estado, 40).toUpperCase();
    const soloNoVistas = String(req.query?.solo_no_vistas || "") === "1";
    const limit = Math.min(Math.max(asInt(req.query?.limit) || 25, 1), 200);
    const offset = Math.max(asInt(req.query?.offset) || 0, 0);

    const params = [];
    const where = [];

    if (estado) {
      params.push(estado);
      where.push(`UPPER(COALESCE(l.estado,'')) = $${params.length}`);
    }

    if (soloNoVistas) {
      where.push(`l.notificada_at IS NOT NULL AND l.vista_agencia_at IS NULL`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const totalQ = await pool.query(
      `
        SELECT COUNT(*)::int AS total
        FROM sucursal_liquidaciones l
        ${whereSql}
      `,
      params
    );
    const total = Number(totalQ.rows?.[0]?.total || 0);

    const p = [...params];
    p.push(limit);
    const pLimit = `$${p.length}`;
    p.push(offset);
    const pOffset = `$${p.length}`;

    const q = await pool.query(
      `
        SELECT
          l.id,
          l.sucursal_id,
          s.nombre AS sucursal_nombre,
          l.periodo_desde,
          l.periodo_hasta,
          l.fecha_emision,
          l.estado,
          l.saldo_neto,
          l.total_creditos,
          l.total_debitos,
          l.notificada_at,
          l.vista_agencia_at,
          l.vista_agencia_by_usuario,
          l.created_at,
          l.updated_at
        FROM sucursal_liquidaciones l
        JOIN sucursales s ON s.id = l.sucursal_id
        ${whereSql}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ${pLimit} OFFSET ${pOffset}
      `,
      p
    );

    const items = (q.rows || []).map((x) => ({
      ...x,
      estado_derivado: buildLiquidacionEstadoDerivado(x),
    }));

    return res.json({
      ok: true,
      total,
      items,
    });
  } catch (err) {
    console.error("GET /interno/contabilidad/liquidaciones error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al listar liquidaciones.",
      detail: err.message,
    });
  }
});

/* =========================
   GET /interno/contabilidad/liquidaciones/:id
   ADMIN ONLY
========================= */
router.get("/liquidaciones/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const u = assertAdminRole(req, res);
    if (!u) return;

    const liquidacionId = asInt(req.params.id);
    if (!Number.isFinite(liquidacionId) || liquidacionId <= 0) {
      return res.status(400).json({ ok: false, error: "ID de liquidación inválido." });
    }

    const cabecera = await getLiquidacionCabecera(client, liquidacionId);
    if (!cabecera) {
      return res.status(404).json({ ok: false, error: "Liquidación no encontrada." });
    }

    const resumen = await computeLiquidacionResumen(client, liquidacionId);
    const items = await getLiquidacionItems(client, liquidacionId);
    const pagos = await getLiquidacionPagos(client, liquidacionId);

    return res.json({
      ok: true,
      liquidacion: {
        cabecera: {
          ...cabecera,
          estado_derivado: buildLiquidacionEstadoDerivado(cabecera),
        },
        resumen,
        items,
        pagos,
      },
    });
  } catch (err) {
    console.error("GET /interno/contabilidad/liquidaciones/:id error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al consultar liquidación.",
      detail: err.message,
    });
  } finally {
    client.release();
  }
});

/* =========================
   POST /interno/contabilidad/liquidaciones/:id/marcar-vista
   ADMIN ONLY
========================= */
router.post("/liquidaciones/:id/marcar-vista", async (req, res) => {
  const client = await pool.connect();
  try {
    const u = assertAdminRole(req, res);
    if (!u) return;

    const liquidacionId = asInt(req.params.id);
    if (!Number.isFinite(liquidacionId) || liquidacionId <= 0) {
      return res.status(400).json({ ok: false, error: "ID de liquidación inválido." });
    }

    await client.query("BEGIN");

    const cabecera = await getLiquidacionCabecera(client, liquidacionId);
    if (!cabecera) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Liquidación no encontrada." });
    }

    const up = await client.query(
      `
        UPDATE sucursal_liquidaciones
        SET
          vista_agencia_at = COALESCE(vista_agencia_at, NOW()),
          vista_agencia_by_user_id = COALESCE(vista_agencia_by_user_id, $2),
          vista_agencia_by_usuario = COALESCE(vista_agencia_by_usuario, $3),
          updated_at = NOW()
        WHERE id = $1
        RETURNING id, vista_agencia_at, vista_agencia_by_usuario
      `,
      [liquidacionId, u.userId, u.usuario]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Liquidación marcada como vista.",
      liquidacion: up.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/contabilidad/liquidaciones/:id/marcar-vista error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al marcar liquidación como vista.",
      detail: err.message,
    });
  } finally {
    client.release();
  }
});

/* =========================
   POST /interno/contabilidad/liquidaciones/:id/aprobar
========================= */
router.post("/liquidaciones/:id/aprobar", async (req, res) => {
  const client = await pool.connect();
  try {
    const u = assertAdminRole(req, res);
    if (!u) return;

    const liquidacionId = asInt(req.params.id);
    if (!Number.isFinite(liquidacionId) || liquidacionId <= 0) {
      return res.status(400).json({ ok: false, error: "ID de liquidación inválido." });
    }

    await client.query("BEGIN");

    const cabecera = await getLiquidacionCabecera(client, liquidacionId);
    if (!cabecera) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Liquidación no encontrada." });
    }

    if (!["BORRADOR", "OBSERVADA"].includes(String(cabecera.estado || "").toUpperCase())) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "Solo se puede aprobar una liquidación en BORRADOR u OBSERVADA.",
      });
    }

    await client.query(
      `
        UPDATE sucursal_liquidaciones
        SET
          estado = 'APROBADA',
          approved_by_user_id = $2,
          approved_at = NOW(),
          notificada_at = COALESCE(notificada_at, NOW()),
          updated_at = NOW()
        WHERE id = $1
      `,
      [liquidacionId, u.userId]
    );

    const resumen = await computeLiquidacionResumen(client, liquidacionId);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Liquidación aprobada.",
      resumen,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/contabilidad/liquidaciones/:id/aprobar error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al aprobar liquidación.",
      detail: err.message,
    });
  } finally {
    client.release();
  }
});

/* =========================
   POST /interno/contabilidad/liquidaciones/:id/pagos
========================= */
router.post("/liquidaciones/:id/pagos", async (req, res) => {
  const client = await pool.connect();
  try {
    const u = assertAdminRole(req, res);
    if (!u) return;

    const liquidacionId = asInt(req.params.id);
    const tipo = cleanText(req.body?.tipo, 40).toUpperCase();
    const fecha = asDate(req.body?.fecha) || null;
    const medioPago = cleanText(req.body?.medio_pago, 30).toUpperCase();
    const importe = round2(asNum(req.body?.importe));
    const referencia = cleanText(req.body?.referencia, 120);
    const observaciones = cleanText(req.body?.observaciones, 2000);

    if (!Number.isFinite(liquidacionId) || liquidacionId <= 0) {
      return res.status(400).json({ ok: false, error: "ID de liquidación inválido." });
    }
    if (!["PAGO_A_AGENCIA", "COBRO_DE_AGENCIA", "COMPENSACION"].includes(tipo)) {
      return res.status(400).json({ ok: false, error: "tipo inválido." });
    }
    if (!["EFECTIVO", "TRANSFERENCIA", "QR", "POS", "MANUAL"].includes(medioPago)) {
      return res.status(400).json({ ok: false, error: "medio_pago inválido." });
    }
    if (!(importe > 0)) {
      return res.status(400).json({ ok: false, error: "importe inválido." });
    }

    await client.query("BEGIN");

    const cabecera = await getLiquidacionCabecera(client, liquidacionId);
    if (!cabecera) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Liquidación no encontrada." });
    }

    const resumenActual = await computeLiquidacionResumen(client, liquidacionId);
    if (!resumenActual) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "No se pudo calcular el resumen actual de la liquidación." });
    }

    const estado = String(cabecera.estado || "").toUpperCase();

    if (["BORRADOR", "ANULADA"].includes(estado)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "La liquidación debe estar APROBADA o en curso para registrar pagos/cobros.",
      });
    }

    if (["PAGADA_TOTAL"].includes(estado)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "La liquidación ya está totalmente pagada/cobrada.",
      });
    }

    const saldoPendiente = round2(resumenActual.saldo_pendiente_absoluto || 0);
    const saldoNeto = round2(resumenActual.saldo_neto || 0);

    if (!(saldoPendiente > 0)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "La liquidación no tiene saldo pendiente.",
      });
    }

    if (importe > saldoPendiente) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: `El importe supera el saldo pendiente de la liquidación (${saldoPendiente.toFixed(2)}).`,
      });
    }

    if (saldoNeto < 0 && tipo === "PAGO_A_AGENCIA") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "Esta liquidación corresponde a COBRO_DE_AGENCIA, no a PAGO_A_AGENCIA.",
      });
    }

    if (saldoNeto > 0 && tipo === "COBRO_DE_AGENCIA") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "Esta liquidación corresponde a PAGO_A_AGENCIA, no a COBRO_DE_AGENCIA.",
      });
    }

    const ins = await client.query(
      `
        INSERT INTO sucursal_liquidacion_pagos
        (
          liquidacion_id,
          sucursal_id,
          tipo,
          fecha,
          medio_pago,
          importe,
          referencia,
          observaciones,
          created_by_user_id
        )
        VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7, $8, $9)
        RETURNING *
      `,
      [
        liquidacionId,
        cabecera.sucursal_id,
        tipo,
        fecha,
        medioPago,
        importe,
        referencia || null,
        observaciones || null,
        u.userId,
      ]
    );

    const resumen = await updateLiquidacionEstadoPorPagos(client, liquidacionId);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Pago/cobro registrado.",
      pago: ins.rows[0],
      resumen,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/contabilidad/liquidaciones/:id/pagos error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al registrar pago/cobro.",
      detail: err.message,
    });
  } finally {
    client.release();
  }
});

/* =========================
   POST /interno/contabilidad/liquidaciones/:id/conciliar
========================= */
router.post("/liquidaciones/:id/conciliar", async (req, res) => {
  const client = await pool.connect();
  try {
    const u = assertAdminRole(req, res);
    if (!u) return;

    const liquidacionId = asInt(req.params.id);
    if (!Number.isFinite(liquidacionId) || liquidacionId <= 0) {
      return res.status(400).json({ ok: false, error: "ID de liquidación inválido." });
    }

    await client.query("BEGIN");

    const cabecera = await getLiquidacionCabecera(client, liquidacionId);
    if (!cabecera) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Liquidación no encontrada." });
    }

    const resumen = await computeLiquidacionResumen(client, liquidacionId);

    if (round2(resumen.saldo_pendiente_absoluto) !== 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "La liquidación todavía tiene saldo pendiente.",
        saldo_pendiente_absoluto: round2(resumen.saldo_pendiente_absoluto),
      });
    }

    const upMovs = await client.query(
      `
        UPDATE sucursal_ctacte_movimientos
        SET estado = 'CONCILIADO'
        WHERE id IN (
          SELECT movimiento_id
          FROM sucursal_liquidacion_items
          WHERE liquidacion_id = $1
        )
          AND estado = 'INCLUIDO_LIQUIDACION'
      `,
      [liquidacionId]
    );

    await client.query(
      `
        UPDATE guias g
        SET
          rendido_at = NOW(),
          rendido_by_user_id = $2,
          rendido_by_usuario = $3
        WHERE g.id IN (
          SELECT DISTINCT i.guia_id
          FROM sucursal_liquidacion_items i
          WHERE i.liquidacion_id = $1
            AND i.guia_id IS NOT NULL
        )
          AND LOWER(COALESCE(g.estado_pago, '')) = 'cobrado_destino'
          AND g.rendido_at IS NULL
      `,
      [liquidacionId, u.userId, u.usuario]
    );

    await client.query(
      `
        UPDATE sucursal_liquidaciones
        SET
          estado = 'PAGADA_TOTAL',
          updated_at = NOW()
        WHERE id = $1
      `,
      [liquidacionId]
    );

    const resumenFinal = await computeLiquidacionResumen(client, liquidacionId);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Liquidación conciliada.",
      movimientos_conciliados: upMovs.rowCount || 0,
      resumen: resumenFinal,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/contabilidad/liquidaciones/:id/conciliar error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al conciliar liquidación.",
      detail: err.message,
    });
  } finally {
    client.release();
  }
});

module.exports = router;