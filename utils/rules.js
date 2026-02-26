// utils/rules.js

// Flujo lineal (sin retrocesos ni saltos)
const LOG_FLOW = ["RECIBIDO_ORIGEN", "EN_TRANSITO", "RECIBIDO_DESTINO", "ENTREGADO"];

function idxEstado(estado) {
  return LOG_FLOW.indexOf(estado);
}

/**
 * Reglas P4 (Estado logístico):
 * - Solo avanzar 1 paso (sin saltos)
 * - Prohibido retroceder SIEMPRE
 * - Prohibido ENTREGADO si es CONTRA_ENTREGA y no está PAGADO
 */
function canChangeEstado({ fromEstado, toEstado, pagoEstado }) {
  const a = idxEstado(fromEstado);
  const b = idxEstado(toEstado);

  if (a === -1 || b === -1) return { ok: false, error: "estado_logistico inválido" };
  if (a === b) return { ok: false, error: "El estado ya es ese" };

  const diff = b - a;

  // Solo permitir avanzar 1 paso
  if (diff !== 1) {
    return { ok: false, error: "Movimiento de estado no permitido (solo avance lineal, sin retrocesos ni saltos)" };
  }

  // No entregar contra entrega sin cobrar
  if (toEstado === "ENTREGADO" && pagoEstado === "CONTRA_ENTREGA") {
    return { ok: false, error: "No se puede ENTREGAR una CONTRA_ENTREGA sin cobrar (pasar a PAGADO)" };
  }

  return { ok: true };
}

/**
 * Reglas P4 (Pago):
 * - Prohibido cambiar pago si la guía está ENTREGADA
 * - Marcar PAGADO solo si estado_logistico es RECIBIDO_DESTINO
 * - Validación de valores + no permitir “no cambios”
 */
function canChangePago({ fromPago, toPago, estadoLogistico }) {
  const valid = ["PENDIENTE", "PAGADO", "CONTRA_ENTREGA"];
  if (!valid.includes(fromPago) || !valid.includes(toPago)) return { ok: false, error: "estado_pago inválido" };
  if (fromPago === toPago) return { ok: false, error: "El pago ya es ese" };

  if (estadoLogistico === "ENTREGADO") {
    return { ok: false, error: "No se puede cambiar el pago cuando la guía está ENTREGADA" };
  }

  // Política: cobro en destino
  if (toPago === "PAGADO" && estadoLogistico !== "RECIBIDO_DESTINO") {
    return { ok: false, error: "Solo se puede marcar PAGADO cuando la guía está en RECIBIDO_DESTINO" };
  }

  return { ok: true };
}

module.exports = { LOG_FLOW, canChangeEstado, canChangePago };
