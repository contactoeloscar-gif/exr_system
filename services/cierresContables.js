// services/cierresContables.js

async function resumirPendientesPorCierre(db, { sucursalId, fecha }) {
  const { rows } = await db.query(
    `
    SELECT
      COUNT(*)::int AS cantidad_movimientos,
      COALESCE(SUM(CASE WHEN sentido = 'CREDITO_AGENCIA' THEN importe ELSE 0 END), 0)::numeric(12,2) AS total_creditos,
      COALESCE(SUM(CASE WHEN sentido = 'DEBITO_AGENCIA' THEN importe ELSE 0 END), 0)::numeric(12,2) AS total_debitos,
      (
        COALESCE(SUM(CASE WHEN sentido = 'CREDITO_AGENCIA' THEN importe ELSE 0 END), 0)
        -
        COALESCE(SUM(CASE WHEN sentido = 'DEBITO_AGENCIA' THEN importe ELSE 0 END), 0)
      )::numeric(12,2) AS saldo_neto
    FROM sucursal_ctacte_movimientos
    WHERE sucursal_id = $1
      AND fecha_operativa = $2
      AND estado = 'PENDIENTE'
    `,
    [sucursalId, fecha]
  );

  return rows[0] || {
    cantidad_movimientos: 0,
    total_creditos: '0.00',
    total_debitos: '0.00',
    saldo_neto: '0.00',
  };
}

        async function bloquearMovimientosPorCierre(db, { sucursalId, fecha, cierreId }) {
  const previo = await resumirPendientesPorCierre(db, { sucursalId, fecha });

  const cierreIdNum = Number(cierreId);
  if (!Number.isFinite(cierreIdNum) || cierreIdNum <= 0) {
    throw new Error("cierreId inválido para bloquear movimientos.");
  }

  const updateResult = await db.query(
    `
    UPDATE sucursal_ctacte_movimientos
    SET
      estado = 'BLOQUEADO_CIERRE',
      cierre_id = $3::bigint
    WHERE sucursal_id = $1
      AND fecha_operativa = $2
      AND estado = 'PENDIENTE'
    `,
    [sucursalId, fecha, cierreIdNum]
  );

  const { rows } = await db.query(
    `
    SELECT
      COUNT(*)::int AS cantidad_bloqueados,
      COALESCE(SUM(CASE WHEN sentido = 'CREDITO_AGENCIA' THEN importe ELSE 0 END), 0)::numeric(12,2) AS total_creditos_bloqueados,
      COALESCE(SUM(CASE WHEN sentido = 'DEBITO_AGENCIA' THEN importe ELSE 0 END), 0)::numeric(12,2) AS total_debitos_bloqueados,
      (
        COALESCE(SUM(CASE WHEN sentido = 'CREDITO_AGENCIA' THEN importe ELSE 0 END), 0)
        -
        COALESCE(SUM(CASE WHEN sentido = 'DEBITO_AGENCIA' THEN importe ELSE 0 END), 0)
      )::numeric(12,2) AS saldo_bloqueado
    FROM sucursal_ctacte_movimientos
    WHERE cierre_id = $1::bigint
      AND estado = 'BLOQUEADO_CIERRE'
    `,
    [cierreIdNum]
  );

  return {
    previo,
    bloqueados: updateResult.rowCount || 0,
    posterior: rows[0] || {
      cantidad_bloqueados: 0,
      total_creditos_bloqueados: '0.00',
      total_debitos_bloqueados: '0.00',
      saldo_bloqueado: '0.00',
    },
  };
}

module.exports = {
  resumirPendientesPorCierre,
  bloquearMovimientosPorCierre,
};