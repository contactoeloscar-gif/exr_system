const {
  SITUACION_OPERATIVA,
  SITUACION_CONTABLE,
  CIERRE_ESTADO,
  LIQUIDACION_ESTADO,
  CONCILIACION_ESTADO,
  ACCION_PRINCIPAL
} = require("../utils/estadoDerivado.constants");

function normStr(v) {
  return String(v ?? "").trim().toUpperCase();
}

function normBool(v) {
  return v === true || v === 1 || v === "1" || v === "true" || v === "TRUE";
}

function hasValue(v) {
  return v !== undefined && v !== null && v !== "";
}

function deriveCierreEstado(row) {
  const cierreId = row?.cierre_id ?? row?.cierreId ?? null;
  const cierreEstadoDb = normStr(row?.cierre_estado_db ?? row?.cierre_estado);

  if (!hasValue(cierreId)) return CIERRE_ESTADO.SIN_CIERRE;
  if (cierreEstadoDb === "ABIERTO") return CIERRE_ESTADO.ABIERTO;
  return CIERRE_ESTADO.CERRADO;
}

function deriveLiquidacionEstado(row, cierreEstado) {
  const liquidacionId = row?.liquidacion_id ?? row?.liquidacionId ?? null;
  const liquidacionEstadoDb = normStr(
    row?.liquidacion_estado_db ?? row?.liquidacion_estado
  );

  if (cierreEstado === CIERRE_ESTADO.SIN_CIERRE) {
    return LIQUIDACION_ESTADO.NO_APLICA;
  }

  if (!hasValue(liquidacionId)) {
    return LIQUIDACION_ESTADO.LIQUIDABLE;
  }

  if (liquidacionEstadoDb === "APROBADA") {
    return LIQUIDACION_ESTADO.APROBADA;
  }

  if (liquidacionEstadoDb === "REGISTRADA") {
    return LIQUIDACION_ESTADO.REGISTRADA;
  }

  return LIQUIDACION_ESTADO.EN_LIQUIDACION;
}

function deriveConciliacionEstado(row, liquidacionEstado) {
  const conciliacionEstadoDb = normStr(
    row?.conciliacion_estado_db ?? row?.conciliacion_estado
  );
  const conciliacionId = row?.conciliacion_id ?? row?.conciliacionId ?? null;

  if (liquidacionEstado !== LIQUIDACION_ESTADO.REGISTRADA) {
    return CONCILIACION_ESTADO.NO_APLICA;
  }

  if (conciliacionEstadoDb === "CONCILIADA") {
    return CONCILIACION_ESTADO.CONCILIADA;
  }

  if (hasValue(conciliacionId)) {
    return CONCILIACION_ESTADO.PENDIENTE;
  }

  return CONCILIACION_ESTADO.PENDIENTE;
}

function deriveSituacionOperativa(row) {
  const estadoLogistico = normStr(row?.estado_logistico);
  const estadoPago = normStr(row?.estado_pago);
  const condicionPago = normStr(row?.condicion_pago ?? row?.tipo_cobro);
  const cobroObligatorioEntrega = normBool(row?.cobro_obligatorio_entrega);
  const observada = normBool(row?.observada);
  const excepcionEntrega = normBool(row?.excepcion_entrega);

  if (observada || estadoPago === "OBSERVADO" || excepcionEntrega) {
    return SITUACION_OPERATIVA.OBSERVADA;
  }

  if (estadoLogistico === "RECIBIDO_ORIGEN") {
    return SITUACION_OPERATIVA.PENDIENTE_DESPACHO;
  }

  if (estadoLogistico === "EN_TRANSITO") {
    return SITUACION_OPERATIVA.EN_TRANSITO;
  }

  if (estadoLogistico === "RECIBIDO_DESTINO") {
    const requiereCobroPrevio =
      condicionPago === "DESTINO" &&
      cobroObligatorioEntrega &&
      estadoPago === "PENDIENTE_DESTINO";

    if (requiereCobroPrevio) {
      return SITUACION_OPERATIVA.PENDIENTE_COBRO_DESTINO;
    }

    return SITUACION_OPERATIVA.LISTA_PARA_ENTREGA;
  }

  if (estadoLogistico === "ENTREGADO") {
    return SITUACION_OPERATIVA.ENTREGADA;
  }

  return SITUACION_OPERATIVA.OBSERVADA;
}

function deriveSituacionContable(row, cierreEstado, liquidacionEstado, conciliacionEstado) {
  const cobradoDestinoAt = row?.cobrado_destino_at ?? null;
  const rendidoAt = row?.rendido_at ?? null;

  if (conciliacionEstado === CONCILIACION_ESTADO.CONCILIADA) {
    return SITUACION_CONTABLE.CONCILIADA;
  }

  if (liquidacionEstado === LIQUIDACION_ESTADO.REGISTRADA) {
    return SITUACION_CONTABLE.REGISTRADA_PENDIENTE_CONCILIACION;
  }

  if (liquidacionEstado === LIQUIDACION_ESTADO.APROBADA) {
    return SITUACION_CONTABLE.APROBADA_PENDIENTE_REGISTRO;
  }

  if (liquidacionEstado === LIQUIDACION_ESTADO.EN_LIQUIDACION) {
    return SITUACION_CONTABLE.EN_LIQUIDACION;
  }

  if (liquidacionEstado === LIQUIDACION_ESTADO.LIQUIDABLE) {
    return SITUACION_CONTABLE.LIQUIDABLE;
  }

  if (hasValue(cobradoDestinoAt) && !hasValue(rendidoAt)) {
    return SITUACION_CONTABLE.PENDIENTE_RENDICION;
  }

  if (hasValue(rendidoAt) && cierreEstado === CIERRE_ESTADO.SIN_CIERRE) {
    return SITUACION_CONTABLE.RENDIDA_SIN_CIERRE;
  }

  return SITUACION_CONTABLE.NO_APLICA;
}

function deriveBloqueos(row, cierreEstado, liquidacionEstado, conciliacionEstado) {
  const bloqueos = [];

  const estadoLogistico = normStr(row?.estado_logistico);
  const estadoPago = normStr(row?.estado_pago);
  const condicionPago = normStr(row?.condicion_pago ?? row?.tipo_cobro);
  const cobroObligatorioEntrega = normBool(row?.cobro_obligatorio_entrega);

  const requiereCobroPrevio =
    estadoLogistico === "RECIBIDO_DESTINO" &&
    condicionPago === "DESTINO" &&
    cobroObligatorioEntrega &&
    estadoPago === "PENDIENTE_DESTINO";

  if (requiereCobroPrevio) {
    bloqueos.push({
      codigo: "COBRO_PREVIO_OBLIGATORIO",
      mensaje: "Requiere cobro previo para entregar"
    });
  }

  if (cierreEstado === CIERRE_ESTADO.CERRADO) {
    bloqueos.push({
      codigo: "CIERRE_SUCURSAL",
      mensaje: "Incluida en cierre sucursal"
    });
  }

  if (liquidacionEstado === LIQUIDACION_ESTADO.EN_LIQUIDACION) {
    bloqueos.push({
      codigo: "EN_LIQUIDACION",
      mensaje: "Ya incluida en liquidación"
    });
  }

  if (liquidacionEstado === LIQUIDACION_ESTADO.APROBADA) {
    bloqueos.push({
      codigo: "LIQUIDACION_APROBADA",
      mensaje: "Liquidación aprobada, pendiente de registro"
    });
  }

  if (conciliacionEstado === CONCILIACION_ESTADO.CONCILIADA) {
    bloqueos.push({
      codigo: "CONCILIADA",
      mensaje: "Movimiento ya conciliado"
    });
  }

  return bloqueos;
}

function deriveAlertas(row) {
  const alertas = [];
  const estadoPago = normStr(row?.estado_pago);
  const observada = normBool(row?.observada);
  const excepcionEntrega = normBool(row?.excepcion_entrega);

  if (observada || estadoPago === "OBSERVADO") {
    alertas.push({
      codigo: "OBSERVADA",
      mensaje: "Guía con observación operativa/contable"
    });
  }

  if (excepcionEntrega) {
    alertas.push({
      codigo: "EXCEPCION_ENTREGA",
      mensaje: "Entrega realizada por excepción"
    });
  }

  return alertas;
}

function deriveAccionPrincipal(row, liquidacionEstado, conciliacionEstado) {
  const estadoLogistico = normStr(row?.estado_logistico);
  const estadoPago = normStr(row?.estado_pago);
  const condicionPago = normStr(row?.condicion_pago ?? row?.tipo_cobro);
  const cobroObligatorioEntrega = normBool(row?.cobro_obligatorio_entrega);
  const cobradoDestinoAt = row?.cobrado_destino_at ?? null;
  const rendidoAt = row?.rendido_at ?? null;

  if (estadoLogistico === "RECIBIDO_ORIGEN") {
    return ACCION_PRINCIPAL.DESPACHAR;
  }

  if (estadoLogistico === "EN_TRANSITO") {
    return ACCION_PRINCIPAL.RECIBIR_DESTINO;
  }

  if (
    estadoLogistico === "RECIBIDO_DESTINO" &&
    condicionPago === "DESTINO" &&
    cobroObligatorioEntrega &&
    estadoPago === "PENDIENTE_DESTINO"
  ) {
    return ACCION_PRINCIPAL.REGISTRAR_COBRO;
  }

  if (
    estadoLogistico === "RECIBIDO_DESTINO" &&
    ["COBRADO_DESTINO", "NO_APLICA", "OBSERVADO", "RENDIDO"].includes(estadoPago)
  ) {
    return ACCION_PRINCIPAL.ENTREGAR;
  }

  if (hasValue(cobradoDestinoAt) && !hasValue(rendidoAt)) {
    return ACCION_PRINCIPAL.RENDIR_COBRO;
  }

  if (
    liquidacionEstado === LIQUIDACION_ESTADO.EN_LIQUIDACION ||
    liquidacionEstado === LIQUIDACION_ESTADO.APROBADA
  ) {
    return ACCION_PRINCIPAL.VER_LIQUIDACION;
  }

  if (conciliacionEstado === CONCILIACION_ESTADO.PENDIENTE) {
    return ACCION_PRINCIPAL.VER_CONCILIACION;
  }

  return ACCION_PRINCIPAL.VER_DETALLE;
}

function buildResumenCorto(estadoDerivado) {
  const {
    situacion_operativa,
    situacion_contable
  } = estadoDerivado;

  if (situacion_contable === SITUACION_CONTABLE.CONCILIADA) {
    return "Liquidación registrada y conciliada";
  }

  if (
    situacion_contable === SITUACION_CONTABLE.REGISTRADA_PENDIENTE_CONCILIACION
  ) {
    return "Liquidación registrada, pendiente conciliación";
  }

  if (
    situacion_contable === SITUACION_CONTABLE.APROBADA_PENDIENTE_REGISTRO
  ) {
    return "Liquidación aprobada, pendiente de registro";
  }

  if (situacion_contable === SITUACION_CONTABLE.EN_LIQUIDACION) {
    return "Incluida en liquidación";
  }

  if (situacion_contable === SITUACION_CONTABLE.LIQUIDABLE) {
    return "Disponible para liquidación";
  }

  if (situacion_contable === SITUACION_CONTABLE.PENDIENTE_RENDICION) {
    return "Cobrada en destino, pendiente de rendición";
  }

  if (situacion_contable === SITUACION_CONTABLE.RENDIDA_SIN_CIERRE) {
    return "Rendida, pendiente de cierre";
  }

  if (situacion_operativa === SITUACION_OPERATIVA.PENDIENTE_COBRO_DESTINO) {
    return "Pendiente cobro para entregar";
  }

  if (situacion_operativa === SITUACION_OPERATIVA.LISTA_PARA_ENTREGA) {
    return "Lista para entrega";
  }

  if (situacion_operativa === SITUACION_OPERATIVA.EN_TRANSITO) {
    return "Guía en tránsito";
  }

  if (situacion_operativa === SITUACION_OPERATIVA.PENDIENTE_DESPACHO) {
    return "Pendiente de despacho";
  }

  if (situacion_operativa === SITUACION_OPERATIVA.ENTREGADA) {
    return "Entrega completada";
  }

  if (situacion_operativa === SITUACION_OPERATIVA.OBSERVADA) {
    return "Requiere revisión";
  }

  return "Sin definición";
}

function buildGuiaEstadoDerivado(row) {
  const cierre_estado = deriveCierreEstado(row);
  const liquidacion_estado = deriveLiquidacionEstado(row, cierre_estado);
  const conciliacion_estado = deriveConciliacionEstado(row, liquidacion_estado);

  const situacion_operativa = deriveSituacionOperativa(row);
  const situacion_contable = deriveSituacionContable(
    row,
    cierre_estado,
    liquidacion_estado,
    conciliacion_estado
  );

  const bloqueos = deriveBloqueos(
    row,
    cierre_estado,
    liquidacion_estado,
    conciliacion_estado
  );

  const alertas = deriveAlertas(row);

  const accion_principal = deriveAccionPrincipal(
    row,
    liquidacion_estado,
    conciliacion_estado
  );

  const estadoDerivado = {
    situacion_operativa,
    situacion_contable,
    accion_principal,
    accion_secundaria: ACCION_PRINCIPAL.VER_DETALLE,
    puede_accionar: accion_principal !== ACCION_PRINCIPAL.SIN_ACCION,
    bloqueos,
    alertas,
    cierre_estado,
    liquidacion_estado,
    conciliacion_estado,
    resumen_corto: "",
    ultimo_hito: row?.ultimo_evento ?? null,
    ultimo_hito_at: row?.ultimo_evento_at ?? null
  };

  estadoDerivado.resumen_corto = buildResumenCorto(estadoDerivado);
  return estadoDerivado;
}

function attachEstadoDerivado(row) {
  return {
    ...row,
    estado_derivado: buildGuiaEstadoDerivado(row)
  };
}

function attachEstadoDerivadoMany(rows) {
  return Array.isArray(rows) ? rows.map(attachEstadoDerivado) : [];
}

module.exports = {
  buildGuiaEstadoDerivado,
  attachEstadoDerivado,
  attachEstadoDerivadoMany
};