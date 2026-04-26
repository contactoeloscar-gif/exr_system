// utils/rules.js

// Flujo logístico real del sistema EXR
const LOG_FLOW = [
  "RECIBIDO_ORIGEN",
  "EN_TRANSITO_A_CENTRAL",
  "RECIBIDO_CENTRAL",
  "RECIBIDO_CENTRAL_OBSERVADO",
  "EN_TRANSITO_A_DESTINO",
  "RECIBIDO_DESTINO",
  "RECIBIDO_DESTINO_OBSERVADO",
  "ENTREGADO",
];

function normEstado(v) {
  return String(v || "").trim().toUpperCase();
}

function normPago(v) {
  return String(v || "").trim().toUpperCase();
}

function idxEstado(estado) {
  return LOG_FLOW.indexOf(normEstado(estado));
}

/**
 * Estados financieros válidos
 */
const PAGO_VALIDOS = new Set([
  "NO_APLICA",
  "PENDIENTE_ORIGEN",
  "PENDIENTE_DESTINO",
  "COBRADO_DESTINO",
  "RENDIDO",
  "OBSERVADO",
]);

function isDestinoRecibido(estado) {
  const e = normEstado(estado);
  return e === "RECIBIDO_DESTINO" || e === "RECIBIDO_DESTINO_OBSERVADO";
}

function isCentralRecibido(estado) {
  const e = normEstado(estado);
  return e === "RECIBIDO_CENTRAL" || e === "RECIBIDO_CENTRAL_OBSERVADO";
}

/**
 * Reglas de transición logística completas
 *
 * Permitidas:
 * - RECIBIDO_ORIGEN -> EN_TRANSITO_A_CENTRAL
 * - EN_TRANSITO_A_CENTRAL -> RECIBIDO_CENTRAL
 * - EN_TRANSITO_A_CENTRAL -> RECIBIDO_CENTRAL_OBSERVADO
 * - RECIBIDO_CENTRAL -> EN_TRANSITO_A_DESTINO
 * - RECIBIDO_CENTRAL_OBSERVADO -> EN_TRANSITO_A_DESTINO
 * - EN_TRANSITO_A_DESTINO -> RECIBIDO_DESTINO
 * - EN_TRANSITO_A_DESTINO -> RECIBIDO_DESTINO_OBSERVADO
 * - RECIBIDO_DESTINO -> RECIBIDO_DESTINO_OBSERVADO
 * - RECIBIDO_DESTINO -> ENTREGADO
 * - RECIBIDO_DESTINO_OBSERVADO -> ENTREGADO
 *
 * No permitidas:
 * - retrocesos
 * - saltos fuera del circuito
 * - reabrir estados anteriores
 */
function canChangeEstado({ fromEstado, toEstado, pagoEstado }) {
  const from = normEstado(fromEstado);
  const to = normEstado(toEstado);
  const pago = normPago(pagoEstado);

  if (idxEstado(from) === -1 || idxEstado(to) === -1) {
    return { ok: false, error: "estado_logistico inválido" };
  }

  if (from === to) {
    return { ok: false, error: "El estado ya es ese" };
  }

  if (pago && !PAGO_VALIDOS.has(pago)) {
    return { ok: false, error: "estado_pago inválido" };
  }

  // Origen -> tránsito a central
  if (from === "RECIBIDO_ORIGEN" && to === "EN_TRANSITO_A_CENTRAL") {
    return { ok: true };
  }

  // Llegada a HUB
  if (from === "EN_TRANSITO_A_CENTRAL" && to === "RECIBIDO_CENTRAL") {
    return { ok: true };
  }

  if (from === "EN_TRANSITO_A_CENTRAL" && to === "RECIBIDO_CENTRAL_OBSERVADO") {
    return { ok: true };
  }

  // HUB -> distribución
  if (from === "RECIBIDO_CENTRAL" && to === "EN_TRANSITO_A_DESTINO") {
    return { ok: true };
  }

  if (from === "RECIBIDO_CENTRAL_OBSERVADO" && to === "EN_TRANSITO_A_DESTINO") {
    return { ok: true };
  }

  // Llegada a destino
  if (from === "EN_TRANSITO_A_DESTINO" && to === "RECIBIDO_DESTINO") {
    return { ok: true };
  }

  if (from === "EN_TRANSITO_A_DESTINO" && to === "RECIBIDO_DESTINO_OBSERVADO") {
    return { ok: true };
  }

  // Observación detectada ya en destino
  if (from === "RECIBIDO_DESTINO" && to === "RECIBIDO_DESTINO_OBSERVADO") {
    return { ok: true };
  }

  // Entrega final
  if (from === "RECIBIDO_DESTINO" && to === "ENTREGADO") {
    return { ok: true };
  }

  if (from === "RECIBIDO_DESTINO_OBSERVADO" && to === "ENTREGADO") {
    return { ok: true };
  }

  return {
    ok: false,
    error: "Movimiento de estado no permitido para el flujo logístico actual",
  };
}

/**
 * Reglas de transición financiera
 *
 * - No cambiar pago si ya está ENTREGADA
 * - Cobro destino / excepción permitidos solo cuando la guía está en destino
 *   (normal u observada)
 * - RENDIDO solo desde COBRADO_DESTINO
 * - NO_APLICA no es transición manual
 */
function canChangePago({ fromPago, toPago, estadoLogistico }) {
  const from = normPago(fromPago);
  const to = normPago(toPago);
  const estado = normEstado(estadoLogistico);

  if (!PAGO_VALIDOS.has(from) || !PAGO_VALIDOS.has(to)) {
    return { ok: false, error: "estado_pago inválido" };
  }

  if (from === to) {
    return { ok: false, error: "El pago ya es ese" };
  }

  if (estado === "ENTREGADO") {
    return {
      ok: false,
      error: "No se puede cambiar el pago cuando la guía está ENTREGADA",
    };
  }

  if ((to === "COBRADO_DESTINO" || to === "OBSERVADO") && !isDestinoRecibido(estado)) {
    return {
      ok: false,
      error:
        "Solo se puede registrar cobro destino o excepción cuando la guía está en RECIBIDO_DESTINO o RECIBIDO_DESTINO_OBSERVADO",
    };
  }

  if (to === "RENDIDO" && from !== "COBRADO_DESTINO") {
    return {
      ok: false,
      error: "Solo se puede pasar a RENDIDO desde COBRADO_DESTINO",
    };
  }

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