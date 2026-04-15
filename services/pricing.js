// services/pricing.js
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function ecoDiscountPctByKg(kg) {
  const x = Number(kg || 0);
  if (x <= 25) return 0;
  if (x <= 50) return 15;
  if (x <= 100) return 33;
  return 40;
}

/**
 * Reglas:
 * - Si entra en “paquete tipo” (<=5kg y <=0.036m3): precio fijo (7500 eco / 35000 premium)
 * - Si excede: precio = max(kg*valor_kg, m3*valor_m3)
 * - ECO: aplicar descuento por KG sobre el precio resultante (según tramo de kg)
 * - ECO: domicilio opcional +6000
 * - PREMIUM: domicilio incluido sin cargo
 * - IVA 21% (100% EXR) sobre (monto_envio + monto_seguro)
 * - Comisión base = monto_envio (envío + domicilio)
 */
function calcularTarifa({
  servicio_tipo,           // 'ECONOMICO'|'PREMIUM'
  entrega_domicilio,       // boolean (solo eco)
  total_kg,
  total_m3,
  monto_seguro,            // numeric (guias.monto_seguro)
}) {
  const kg = Number(total_kg || 0);
  const m3 = Number(total_m3 || 0);
  const seguro = Number(monto_seguro || 0);

  // Tarifas (hardcode por ahora; después lo pasamos a tablas si querés)
  const FIX_M3 = 0.036;
  const FIX_KG = 5;

  const TARIFA = servicio_tipo === "PREMIUM"
    ? { fijo: 35000, porKg: 6990, porM3: 978600, domIncluido: true, domOpcionalEco: false, domPrecioEco: 0 }
    : { fijo: 7500,  porKg: 1500, porM3: 210000, domIncluido: false, domOpcionalEco: true, domPrecioEco: 6000 };

  const fijoOk = kg <= FIX_KG && m3 <= FIX_M3;

  let envio = 0;
  let detalle = { servicio_tipo, input: { kg: round2(kg), m3: round2(m3) }, modo: "", dominante: null };

  if (fijoOk) {
    envio = TARIFA.fijo;
    detalle.modo = "FIJO";
  } else {
    const linealKg = kg * TARIFA.porKg;
    const linealM3 = m3 * TARIFA.porM3;
    envio = Math.max(linealKg, linealM3);

    detalle.modo = "MAX(KG,M3)";
    detalle.dominante = {
      precio_kg: round2(linealKg),
      precio_m3: round2(linealM3),
      elegido: round2(envio),
      metric: linealKg >= linealM3 ? "KG" : "M3",
    };

    // Descuento solo ECO
    if (servicio_tipo === "ECONOMICO") {
      const desc = ecoDiscountPctByKg(kg);
      const antes = envio;
      envio = envio * (1 - desc / 100);
      detalle.dominante.descuento_pct = desc;
      detalle.dominante.antes_descuento = round2(antes);
      detalle.dominante.despues_descuento = round2(envio);
    }
  }

  // Domicilio
  let domicilio = 0;
  if (servicio_tipo === "ECONOMICO" && entrega_domicilio) domicilio = 6000;
  // PREMIUM domicilio incluido sin cargo => 0

  const monto_envio = round2(envio + domicilio); // base comisionable
  const base_iva = monto_envio + seguro;
  const iva_monto = round2(base_iva * 0.21);
  const monto_total = round2(monto_envio + seguro + iva_monto);

  detalle.calculo = {
    envio: round2(envio),
    domicilio: round2(domicilio),
    monto_envio: round2(monto_envio),
    seguro: round2(seguro),
    base_iva: round2(base_iva),
    iva_monto: round2(iva_monto),
    monto_total: round2(monto_total),
    regla_comision: "Comisión solo sobre monto_envio (envío+domicilio). Seguro+IVA = 100% EXR.",
  };

  return { monto_envio, iva_monto, monto_total, detalle };
}

module.exports = { calcularTarifa };