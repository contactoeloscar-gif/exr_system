// utils/audit.js
console.log("CARGANDO utils/audit.js");

/**
 * Inserta un movimiento en historial_movimientos.
 * Requiere un client de pg dentro de una transacción.
 */
async function auditMovimiento(client, { guia_id, tipo, de_valor, a_valor, req }) {
  const user = req?.user || {};
  const user_id = user.user_id ?? null;
  const sucursal_id = user.sucursal_id ?? null;
  const usuario = user.usuario ?? null;

  const ip =
    (req?.headers?.["x-forwarded-for"] && String(req.headers["x-forwarded-for"]).split(",")[0].trim()) ||
    req?.ip ||
    null;

  await client.query(
    `INSERT INTO historial_movimientos
      (guia_id, tipo, de_valor, a_valor, sucursal_id, user_id, usuario, ip)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [guia_id, tipo, de_valor, a_valor, sucursal_id, user_id, usuario, ip]
  );
}

module.exports = { auditMovimiento };
