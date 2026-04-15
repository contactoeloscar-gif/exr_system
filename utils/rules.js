// utils/rules.js

// Flujo lineal (sin retrocesos ni saltos)
const LOG_FLOW = ["RECIBIDO_ORIGEN", "EN_TRANSITO", "RECIBIDO_DESTINO", "ENTREGADO"];

function idxEstado(estado) {
  return LOG_FLOW.indexOf(String(estado || "").trim().toUpperCase());
}

/**
 * Estados financieros válidos P15
 */
const PAGO_VALIDOS = new Set([
  "NO_APLICA",
  "PENDIENTE_ORIGEN",
  "PENDIENTE_DESTINO",
  "COBRADO_DESTINO",
  "RENDIDO",
  "OBSERVADO",
]);

function normPago(v) {
  return String(v || "").trim().toUpperCase();
}

/**
 * Reglas P15 (Estado logístico):
 * - Solo avanzar 1 paso (sin saltos)
 * - Prohibido retroceder SIEMPRE
 * - La validación fuerte de entrega con cobro destino
 *   se resuelve en routes/estadoGuia.js, no acá.
 */
function canChangeEstado({ fromEstado, toEstado, pagoEstado }) {
  const a = idxEstado(fromEstado);
  const b = idxEstado(toEstado);
  const pago = normPago(pagoEstado);

  if (a === -1 || b === -1) {
    return { ok: false, error: "estado_logistico inválido" };
  }

  if (a === b) {
    return { ok: false, error: "El estado ya es ese" };
  }

  if (pago && !PAGO_VALIDOS.has(pago)) {
    return { ok: false, error: "estado_pago inválido" };
  }

  const diff = b - a;

  // Solo permitir avanzar 1 paso
  if (diff !== 1) {
    return {
      ok: false,
      error: "Movimiento de estado no permitido (solo avance lineal, sin retrocesos ni saltos)",
    };
  }

  return { ok: true };
}

/**
 * Reglas P15 (Pago):
 * - Prohibido cambiar pago si la guía está ENTREGADA
 * - Solo permitir COBRADO_DESTINO / OBSERVADO cuando la guía está en RECIBIDO_DESTINO
 * - No permitir “no cambios”
 * - No permitir saltos absurdos
 */
function canChangePago({ fromPago, toPago, estadoLogistico }) {
  const from = normPago(fromPago);
  const to = normPago(toPago);
  const estado = String(estadoLogistico || "").trim().toUpperCase();

  if (!PAGO_VALIDOS.has(from) || !PAGO_VALIDOS.has(to)) {
    return { ok: false, error: "estado_pago inválido" };
  }

  if (from === to) {
    return { ok: false, error: "El pago ya es ese" };
  }

  if (estado === "ENTREGADO") {
    return { ok: false, error: "No se puede cambiar el pago cuando la guía está ENTREGADA" };
  }

  // Cobro real en destino solo cuando la guía ya llegó a destino
  if ((to === "COBRADO_DESTINO" || to === "OBSERVADO") && estado !== "RECIBIDO_DESTINO") {
    return {
      ok: false,
      error: "Solo se puede registrar cobro destino o excepción cuando la guía está en RECIBIDO_DESTINO",
    };
  }

  // Rendido solo después de cobrar destino
  if (to === "RENDIDO" && from !== "COBRADO_DESTINO") {
    return {
      ok: false,
      error: "Solo se puede pasar a RENDIDO desde COBRADO_DESTINO",
    };
  }

  // NO_APLICA no debería usarse como transición manual arbitraria
  if (to === "NO_APLICA") {
    return {
      ok: false,
      error: "NO_APLICA no es un estado manual de transición",
    };
  }

  return { ok: true };
}

module.exports = {
  LOG_FLOW,
  canChangeEstado,
  canChangePago,
};
