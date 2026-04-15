// utils/cobros.constants.js

const CONDICION_PAGO = Object.freeze({
  ORIGEN: "origen",
  DESTINO: "destino",
});

const ESTADO_PAGO = Object.freeze({
  NO_APLICA: "no_aplica",
  PENDIENTE_ORIGEN: "pendiente_origen",
  PENDIENTE_DESTINO: "pendiente_destino",
  COBRADO_DESTINO: "cobrado_destino",
  RENDIDO: "rendido",
  OBSERVADO: "observado",
});

const TIPO_COBRO = Object.freeze({
  ORIGEN: "origen",
  DESTINO: "destino",
});

const MEDIO_PAGO = Object.freeze({
  EFECTIVO: "efectivo",
  TRANSFERENCIA: "transferencia",
  QR: "qr",
  POS: "pos",
  MANUAL: "manual",
});

const ESTADO_COBRO = Object.freeze({
  REGISTRADO: "registrado",
  ANULADO: "anulado",
  OBSERVADO: "observado",
});

const EVENTO_COBRO = Object.freeze({
  CREADO: "creado",
  ANULADO: "anulado",
  CORREGIDO: "corregido",
  EXCEPCION_AUTORIZADA: "excepcion_autorizada",
  RENDIDO: "rendido",
});

const SET_CONDICION_PAGO = new Set(Object.values(CONDICION_PAGO));
const SET_ESTADO_PAGO = new Set(Object.values(ESTADO_PAGO));
const SET_TIPO_COBRO = new Set(Object.values(TIPO_COBRO));
const SET_MEDIO_PAGO = new Set(Object.values(MEDIO_PAGO));
const SET_ESTADO_COBRO = new Set(Object.values(ESTADO_COBRO));
const SET_EVENTO_COBRO = new Set(Object.values(EVENTO_COBRO));

module.exports = {
  CONDICION_PAGO,
  ESTADO_PAGO,
  TIPO_COBRO,
  MEDIO_PAGO,
  ESTADO_COBRO,
  EVENTO_COBRO,
  SET_CONDICION_PAGO,
  SET_ESTADO_PAGO,
  SET_TIPO_COBRO,
  SET_MEDIO_PAGO,
  SET_ESTADO_COBRO,
  SET_EVENTO_COBRO,
};
