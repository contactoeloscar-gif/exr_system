const pool = require("../config/db");

async function recalcularGuia(guiaId) {
  // 1) total items
  const items = await pool.query(
    "SELECT COALESCE(SUM(subtotal),0) AS total_envio FROM guia_items WHERE guia_id = $1",
    [guiaId]
  );
  const total_envio = Number(items.rows[0].total_envio || 0);

  // 2) seguro % * valor_declarado
  const guia = await pool.query(
    "SELECT valor_declarado FROM guias WHERE id = $1",
    [guiaId]
  );
  const valor = Number(guia.rows[0]?.valor_declarado || 0);

  const conf = await pool.query(
    "SELECT valor FROM config_sistema WHERE clave = 'seguro_porcentaje'"
  );
  const porcentaje = Number(conf.rows[0]?.valor || 0);

  const monto_seguro = valor > 0 ? (valor * porcentaje) / 100 : 0;

  const monto_total = total_envio + monto_seguro;

  // 3) actualizar guía
  await pool.query(
    "UPDATE guias SET monto_envio=$1, monto_seguro=$2, monto_total=$3 WHERE id=$4",
    [total_envio, monto_seguro, monto_total, guiaId]
  );

  return { total_envio, monto_seguro, monto_total };
}

module.exports = { recalcularGuia };
