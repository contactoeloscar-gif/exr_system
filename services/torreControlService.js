"use strict";

const pool = require("../config/db");
const { attachEstadoDerivadoMany } = require("./guiaEstadoDerivado.service");

function asDate(v) {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

function toIso(v) {
  const d = asDate(v);
  return d ? d.toISOString() : null;
}

function round1(n) {
  return Math.round(Number(n || 0) * 10) / 10;
}

function hoursSince(v) {
  const d = asDate(v);
  if (!d) return null;
  return round1((Date.now() - d.getTime()) / 36e5);
}

function norm(v) {
  return String(v || "").trim().toUpperCase();
}

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean).map(String))];
}

function priorityRank(p) {
  return {
    CRITICA: 4,
    ALTA: 3,
    MEDIA: 2,
    BAJA: 1,
  }[String(p || "").toUpperCase()] || 0;
}

function buildAgenciaActual(row) {
  const estadoLote = norm(row.lote_estado);
  const tipoLote = norm(row.tipo_lote);
  const estadoLog = norm(row.estado_logistico);

  if (estadoLog === "RECIBIDO_ORIGEN") {
    return {
      id: row.sucursal_origen_id,
      nombre: row.sucursal_origen_nombre || "S/D",
    };
  }

  if (estadoLote === "DESPACHADO") {
    return {
      id: row.lote_destino_id,
      nombre: row.lote_destino_nombre || "S/D",
    };
  }

  if (["RECIBIDO", "CERRADO"].includes(estadoLote)) {
    return {
      id: row.lote_destino_id,
      nombre: row.lote_destino_nombre || "S/D",
    };
  }

  if (["ABIERTO", "CONSOLIDADO"].includes(estadoLote)) {
    return {
      id: row.lote_origen_id,
      nombre: row.lote_origen_nombre || "S/D",
    };
  }

  if (tipoLote === "COLECTA") {
    return {
      id: row.sucursal_origen_id,
      nombre: row.sucursal_origen_nombre || "S/D",
    };
  }

  return {
    id: row.sucursal_destino_id,
    nombre: row.sucursal_destino_nombre || "S/D",
  };
}

function buildTowerRow(row) {
  const ed = row.estado_derivado || {};
  const situacionOperativa = norm(ed.situacion_operativa);
  const accionPrincipal = norm(ed.accion_principal);
  const bloqueos = Array.isArray(ed.bloqueos) ? ed.bloqueos : [];
  const alertasBase = Array.isArray(ed.alertas) ? ed.alertas : [];

  const estadoLog = norm(row.estado_logistico);
  const loteEstado = norm(row.lote_estado);
  const tipoLote = norm(row.tipo_lote);

  const ultimoMovimientoAt =
    row.lote_ultimo_evento_at ||
    row.guia_ultimo_evento_at ||
    row.created_at ||
    null;

  const sinMovimientoHoras = hoursSince(ultimoMovimientoAt);

  const guiaActivaOperativamente = estadoLog !== "ENTREGADO";

  // En esta torre: retiro de agencia = colecta
  const requiereColecta =
    guiaActivaOperativamente &&
    (
      estadoLog === "RECIBIDO_ORIGEN" ||
      (
        tipoLote === "COLECTA" &&
        ["DESPACHADO", "RECIBIDO", "ABIERTO", "CONSOLIDADO"].includes(loteEstado) &&
        ["EN_TRANSITO", "EN_TRANSITO_A_CENTRAL", "RECIBIDO_CENTRAL", "RECIBIDO_CENTRAL_OBSERVADO"].includes(estadoLog)
      ) ||
      (
        tipoLote === "DISTRIBUCION" &&
        ["DESPACHADO", "RECIBIDO"].includes(loteEstado) &&
        ["EN_TRANSITO_A_DESTINO", "RECIBIDO_DESTINO", "RECIBIDO_DESTINO_OBSERVADO"].includes(estadoLog)
      )
    );

  // Unificado: no separar retiro en esta pantalla
  const requiereRetiro = false;

  const requierePase =
    guiaActivaOperativamente &&
    estadoLog === "RECIBIDO_CENTRAL" &&
    !["OBSERVADA"].includes(situacionOperativa);

  const novedadRecepcion = ["DANADO", "OBSERVADO", "FALTANTE", "PENDIENTE"].includes(
    norm(row.estado_recepcion)
  );

  const novedadHub =
    estadoLog === "RECIBIDO_CENTRAL_OBSERVADO" ||
    row.novedad_hub_abierta === true;

  const hayNovedad = novedadRecepcion || novedadHub;

  const requiereRevision =
    hayNovedad ||
    situacionOperativa === "OBSERVADA" ||
    alertasBase.length > 0 ||
    bloqueos.length > 0;

  const requiereAccionCentral =
    requiereColecta ||
    requierePase ||
    requiereRevision ||
    situacionOperativa === "PENDIENTE_COBRO_DESTINO" ||
    (sinMovimientoHoras || 0) >= 6;

  const prioridad =
    hayNovedad ||
    estadoLog === "RECIBIDO_CENTRAL_OBSERVADO" ||
    estadoLog === "RECIBIDO_DESTINO_OBSERVADO"
      ? "CRITICA"
      : (sinMovimientoHoras || 0) >= 12
      ? "CRITICA"
      : estadoLog === "RECIBIDO_ORIGEN"
      ? "ALTA"
      : situacionOperativa === "PENDIENTE_COBRO_DESTINO"
      ? "ALTA"
      : ["EN_TRANSITO", "EN_TRANSITO_A_CENTRAL", "EN_TRANSITO_A_DESTINO"].includes(estadoLog)
      ? "ALTA"
      : (sinMovimientoHoras || 0) >= 6
      ? "ALTA"
      : estadoLog === "RECIBIDO_CENTRAL" || estadoLog === "RECIBIDO_DESTINO"
      ? "MEDIA"
      : requiereRevision
      ? "MEDIA"
      : "BAJA";

  const accionRecomendada =
    hayNovedad ||
    estadoLog === "RECIBIDO_CENTRAL_OBSERVADO" ||
    estadoLog === "RECIBIDO_DESTINO_OBSERVADO"
      ? "REVISAR_NOVEDAD"
      : estadoLog === "RECIBIDO_ORIGEN"
      ? "COORDINAR_COLECTA"
      : estadoLog === "RECIBIDO_CENTRAL"
      ? "COORDINAR_PASE"
      : situacionOperativa === "PENDIENTE_COBRO_DESTINO"
      ? "CONTACTAR_AGENCIA"
      : (sinMovimientoHoras || 0) >= 12
      ? "ESCALAR_CENTRAL"
      : ["EN_TRANSITO", "EN_TRANSITO_A_CENTRAL", "EN_TRANSITO_A_DESTINO", "RECIBIDO_DESTINO"].includes(estadoLog)
      ? "SEGUIMIENTO"
      : requiereColecta
      ? "COORDINAR_COLECTA"
      : requierePase
      ? "COORDINAR_PASE"
      : accionPrincipal === "VER_LIQUIDACION" || accionPrincipal === "VER_CONCILIACION"
      ? "SEGUIMIENTO"
      : "SEGUIMIENTO";

  const extraAlertas = [];
  if (hayNovedad) extraAlertas.push("NOVEDAD_ABIERTA");
  if (novedadRecepcion) extraAlertas.push(`RECEPCION_${norm(row.estado_recepcion)}`);
  if (novedadHub) extraAlertas.push("NOVEDAD_HUB");
  if ((sinMovimientoHoras || 0) >= 12) extraAlertas.push("SIN_MOVIMIENTO_12H");
  else if ((sinMovimientoHoras || 0) >= 6) extraAlertas.push("SIN_MOVIMIENTO_6H");
  if (requiereColecta) extraAlertas.push("REQUIERE_COLECTA");
  if (requierePase) extraAlertas.push("REQUIERE_PASE");
  if (situacionOperativa === "PENDIENTE_COBRO_DESTINO") extraAlertas.push("PENDIENTE_COBRO_DESTINO");

  const alertas = uniq([
    ...alertasBase.map((x) => x.codigo || x.mensaje || x),
    ...bloqueos.map((x) => `BLOQUEO:${x.codigo || x.mensaje || x}`),
    ...extraAlertas,
  ]);

  const agenciaActual = buildAgenciaActual(row);

  return {
    guia_id: row.id,
    numero_guia: row.numero_guia,

    agencia_actual_id: agenciaActual.id,
    agencia_actual_nombre: agenciaActual.nombre,

    origen_id: row.sucursal_origen_id,
    origen_nombre: row.sucursal_origen_nombre,
    destino_id: row.sucursal_destino_id,
    destino_nombre: row.sucursal_destino_nombre,

    lote_id: row.lote_id,
    lote_tipo: row.tipo_lote,
    lote_estado: row.lote_estado,

    estado_logistico: row.estado_logistico,
    estado_pago: row.estado_pago,

    situacion_operativa: ed.situacion_operativa || null,
    situacion_contable: ed.situacion_contable || null,

    ultima_novedad: hayNovedad
      ? (row.lote_ultimo_evento || row.estado_recepcion || row.estado_logistico)
      : (sinMovimientoHoras || 0) >= 6
      ? "sin_movimiento"
      : (row.lote_ultimo_evento || row.guia_ultimo_evento || "seguimiento"),

    ultima_novedad_at: toIso(ultimoMovimientoAt),
    sin_movimiento_horas: sinMovimientoHoras,

    requiere_accion_central: requiereAccionCentral,
    requiere_retiro: false,
    requiere_colecta: requiereColecta,
    requiere_pase: requierePase,
    requiere_revision: requiereRevision,

    accion_recomendada: accionRecomendada,
    prioridad,

    bloqueos: bloqueos.map((x) => x.codigo || x.mensaje || x),
    alertas,

    usuario_ultimo_evento: row.lote_ultimo_evento_usuario || null,
    ultimo_hito: ed.ultimo_hito || row.lote_ultimo_evento || row.guia_ultimo_evento || null,
    ultimo_hito_at: ed.ultimo_hito_at || toIso(ultimoMovimientoAt),
    resumen_corto: ed.resumen_corto || "",

    estado_derivado: ed,
  };
}

function includeRow(baseRow, tower) {
  const estadoLog = norm(baseRow.estado_logistico);

  if (estadoLog === "ENTREGADO") return false;

  if (estadoLog === "RECIBIDO_ORIGEN") return true;

  const estadosPermitidos = [
    "EN_TRANSITO",
    "EN_TRANSITO_A_CENTRAL",
    "RECIBIDO_CENTRAL",
    "RECIBIDO_CENTRAL_OBSERVADO",
    "EN_TRANSITO_A_DESTINO",
    "RECIBIDO_DESTINO",
    "RECIBIDO_DESTINO_OBSERVADO",
  ];

  if (!estadosPermitidos.includes(estadoLog)) return false;

  return (
    tower.requiere_accion_central ||
    tower.alertas.length > 0 ||
    (tower.sin_movimiento_horas || 0) >= 6 ||
    tower.situacion_operativa === "PENDIENTE_COBRO_DESTINO"
  );
}

function sortRows(rows) {
  return rows.sort((a, b) => {
    const p = priorityRank(b.prioridad) - priorityRank(a.prioridad);
    if (p !== 0) return p;

    const sm = Number(b.sin_movimiento_horas || 0) - Number(a.sin_movimiento_horas || 0);
    if (sm !== 0) return sm;

    const da = new Date(a.ultima_novedad_at || a.ultimo_hito_at || 0).getTime();
    const db = new Date(b.ultima_novedad_at || b.ultimo_hito_at || 0).getTime();
    return da - db;
  });
}

function buildResumen(rows) {
  return {
    novedades_activas: rows.filter((r) => r.alertas.includes("NOVEDAD_ABIERTA")).length,
    pendientes_retiro_colecta: rows.filter((r) => r.requiere_colecta).length,
    sin_movimiento_6h: rows.filter((r) => (r.sin_movimiento_horas || 0) >= 6 && (r.sin_movimiento_horas || 0) < 12).length,
    sin_movimiento_12h: rows.filter((r) => (r.sin_movimiento_horas || 0) >= 12).length,
    agencias_con_alerta: new Set(rows.map((r) => r.agencia_actual_id).filter(Boolean)).size,
    lotes_afectados: new Set(rows.map((r) => r.lote_id).filter(Boolean)).size,
  };
}

function buildAgencias(rows) {
  const map = new Map();

  for (const r of rows) {
    const key = String(r.agencia_actual_id || 0);
    if (!map.has(key)) {
      map.set(key, {
        sucursal_id: r.agencia_actual_id,
        sucursal_nombre: r.agencia_actual_nombre || "S/D",
        novedades_activas: 0,
        pendientes_retiro_colecta: 0,
        sin_movimiento_6h: 0,
        sin_movimiento_12h: 0,
        lotesSet: new Set(),
        ultimo_movimiento_at: null,
        criticas: 0,
      });
    }

    const x = map.get(key);

    if (r.alertas.includes("NOVEDAD_ABIERTA")) x.novedades_activas += 1;
    if (r.requiere_colecta) x.pendientes_retiro_colecta += 1;
    if ((r.sin_movimiento_horas || 0) >= 6 && (r.sin_movimiento_horas || 0) < 12) x.sin_movimiento_6h += 1;
    if ((r.sinMovimiento_horas || r.sin_movimiento_horas || 0) >= 12) x.sin_movimiento_12h += 1;
    if (r.lote_id) x.lotesSet.add(r.lote_id);
    if (r.prioridad === "CRITICA") x.criticas += 1;

    const d = r.ultimo_hito_at || r.ultima_novedad_at;
    if (d && (!x.ultimo_movimiento_at || new Date(d) > new Date(x.ultimo_movimiento_at))) {
      x.ultimo_movimiento_at = d;
    }
  }

  return [...map.values()].map((x) => ({
    sucursal_id: x.sucursal_id,
    sucursal_nombre: x.sucursal_nombre,
    novedades_activas: x.novedades_activas,
    pendientes_retiro_colecta: x.pendientes_retiro_colecta,
    sin_movimiento_6h: x.sin_movimiento_6h,
    sin_movimiento_12h: x.sin_movimiento_12h,
    lotes_afectados: x.lotesSet.size,
    ultimo_movimiento_at: x.ultimo_movimiento_at,
    estado:
      x.criticas > 0 || x.sin_movimiento_12h > 0
        ? "ROJO"
        : x.novedades_activas > 0 || x.pendientes_retiro_colecta > 0 || x.sin_movimiento_6h > 0
        ? "AMARILLO"
        : "VERDE",
  }));
}

function applyFilters(rows, filters) {
  let out = rows.slice();

  if (filters.sucursal_id) {
    out = out.filter((r) => Number(r.agencia_actual_id) === Number(filters.sucursal_id));
  }

  if (filters.prioridad) {
    out = out.filter((r) => norm(r.prioridad) === filters.prioridad);
  }

  if (filters.tipo_accion) {
    out = out.filter((r) => norm(r.accion_recomendada) === filters.tipo_accion);
  }

  if (filters.solo_criticas) {
    out = out.filter((r) => norm(r.prioridad) === "CRITICA");
  }

  if (Number.isFinite(filters.sin_movimiento_desde_horas)) {
    out = out.filter((r) => Number(r.sin_movimiento_horas || 0) >= Number(filters.sin_movimiento_desde_horas));
  }

  if (filters.fecha_desde) {
    const d = new Date(`${filters.fecha_desde}T00:00:00`);
    out = out.filter((r) => {
      const x = asDate(r.ultima_novedad_at || r.ultimo_hito_at);
      return x && x >= d;
    });
  }

  if (filters.fecha_hasta) {
    const d = new Date(`${filters.fecha_hasta}T23:59:59.999`);
    out = out.filter((r) => {
      const x = asDate(r.ultima_novedad_at || r.ultimo_hito_at);
      return x && x <= d;
    });
  }

  return out;
}

async function fetchBaseRows(limitBase = 500) {
  const q = await pool.query(
    `
      WITH last_lote AS (
        SELECT
          lg.guia_id,
          lg.lote_id,
          lg.estado_recepcion,
          lg.observacion_recepcion,
          lg.recibido_en,
          lg.agregado_en,
          ROW_NUMBER() OVER (
            PARTITION BY lg.guia_id
            ORDER BY lg.lote_id DESC, lg.id DESC
          ) AS rn
        FROM lote_guias lg
      ),
      last_lote_evento AS (
        SELECT
          x.lote_id,
          x.evento,
          x.payload,
          x.usuario,
          x.created_at
        FROM (
          SELECT
            le.*,
            ROW_NUMBER() OVER (
              PARTITION BY le.lote_id
              ORDER BY le.id DESC
            ) AS rn
          FROM lote_eventos le
        ) x
        WHERE x.rn = 1
      ),
      last_guia_evento AS (
        SELECT
          x.guia_id,
          x.evento,
          x.detalle,
          x.created_at
        FROM (
          SELECT
            ge.*,
            ROW_NUMBER() OVER (
              PARTITION BY ge.guia_id
              ORDER BY ge.id DESC
            ) AS rn
          FROM guia_eventos ge
        ) x
        WHERE x.rn = 1
      )
      SELECT
        g.id,
        g.numero_guia,
        g.created_at,
        g.sucursal_origen_id,
        g.sucursal_destino_id,
        so.nombre AS sucursal_origen_nombre,
        sd.nombre AS sucursal_destino_nombre,
        g.estado_logistico,
        g.estado_pago,
        g.condicion_pago,
        g.tipo_cobro,
        g.metodo_pago,
        g.cobro_obligatorio_entrega,
        g.monto_cobrar_destino,
        g.cobrado_destino_at,
        g.rendido_at,
        g.rendido_by_user_id,
        g.rendido_by_usuario,
        g.remitente_nombre,
        g.remitente_telefono,
        g.destinatario_nombre,
        g.destinatario_telefono,
        g.destinatario_direccion,
        g.fragil,
        g.novedad_hub_tipo,
        g.novedad_hub_detalle,
        g.novedad_hub_abierta,
        g.novedad_hub_resolucion,

        ll.lote_id,
        ll.estado_recepcion,
        ll.observacion_recepcion,
        ll.recibido_en AS lote_guia_recibido_en,
        ll.agregado_en,

        lc.tipo_lote,
        lc.estado AS lote_estado,
        lc.sucursal_origen_id AS lote_origen_id,
        lc.sucursal_destino_id AS lote_destino_id,
        slo.nombre AS lote_origen_nombre,
        sld.nombre AS lote_destino_nombre,
        lc.fecha_operativa,
        lc.creado_en,
        lc.consolidado_en,
        lc.despachado_en,
        lc.recibido_en,
        lc.cerrado_en,
        lc.resultado_recepcion,

        le.evento AS lote_ultimo_evento,
        le.payload AS lote_ultimo_payload,
        le.usuario AS lote_ultimo_evento_usuario,
        le.created_at AS lote_ultimo_evento_at,

        ge.evento AS guia_ultimo_evento,
        ge.detalle AS guia_ultimo_detalle,
        ge.created_at AS guia_ultimo_evento_at,

        NULL::bigint AS cierre_id,
        NULL::text AS cierre_estado_db,
        NULL::bigint AS liquidacion_id,
        NULL::text AS liquidacion_estado_db,
        NULL::bigint AS conciliacion_id,
        NULL::text AS conciliacion_estado_db,

        COALESCE(le.evento, ge.evento) AS ultimo_evento,
        COALESCE(le.created_at, ge.created_at) AS ultimo_evento_at
      FROM guias g
      LEFT JOIN sucursales so ON so.id = g.sucursal_origen_id
      LEFT JOIN sucursales sd ON sd.id = g.sucursal_destino_id
      LEFT JOIN last_lote ll
        ON ll.guia_id = g.id
       AND ll.rn = 1
      LEFT JOIN lotes_colecta lc
        ON lc.id = ll.lote_id
      LEFT JOIN sucursales slo
        ON slo.id = lc.sucursal_origen_id
      LEFT JOIN sucursales sld
        ON sld.id = lc.sucursal_destino_id
      LEFT JOIN last_lote_evento le
        ON le.lote_id = lc.id
      LEFT JOIN last_guia_evento ge
        ON ge.guia_id = g.id
      WHERE
        lc.id IS NOT NULL
        OR g.estado_logistico IN (
          'RECIBIDO_ORIGEN',
          'EN_TRANSITO',
          'EN_TRANSITO_A_CENTRAL',
          'RECIBIDO_CENTRAL',
          'RECIBIDO_CENTRAL_OBSERVADO',
          'EN_TRANSITO_A_DESTINO',
          'RECIBIDO_DESTINO',
          'RECIBIDO_DESTINO_OBSERVADO'
        )
      ORDER BY COALESCE(le.created_at, ge.created_at, lc.creado_en, g.created_at) DESC
      LIMIT $1
    `,
    [limitBase]
  );

  return q.rows || [];
}

async function getNovedadesTorre(filters = {}) {
  const limit = Math.max(1, Math.min(Number(filters.limit || 200), 500));
  const offset = Math.max(0, Number(filters.offset || 0));

  const baseRows = await fetchBaseRows(limit + offset + 150);
  const enriched = attachEstadoDerivadoMany(baseRows);

  let rows = enriched
    .map((row) => ({ base: row, tower: buildTowerRow(row) }))
    .filter(({ base, tower }) => includeRow(base, tower))
    .map(({ tower }) => tower);

  rows = applyFilters(rows, {
    sucursal_id: filters.sucursal_id || null,
    prioridad: norm(filters.prioridad || ""),
    tipo_accion: norm(filters.tipo_accion || ""),
    solo_criticas: !!filters.solo_criticas,
    sin_movimiento_desde_horas:
      Number.isFinite(Number(filters.sin_movimiento_desde_horas))
        ? Number(filters.sin_movimiento_desde_horas)
        : null,
    fecha_desde: filters.fecha_desde || "",
    fecha_hasta: filters.fecha_hasta || "",
  });

  rows = sortRows(rows);

  const total = rows.length;
  const paged = rows.slice(offset, offset + limit);

  return {
    ts: new Date().toISOString(),
    resumen: buildResumen(rows),
    agencias: buildAgencias(rows),
    guias: paged,
    paginacion: {
      limit,
      offset,
      total,
    },
  };
}

async function getDetalleGuiaTorre(guiaId) {
  const baseRows = await pool.query(
    `
      WITH last_lote AS (
        SELECT
          lg.guia_id,
          lg.lote_id,
          lg.estado_recepcion,
          lg.observacion_recepcion,
          lg.recibido_en,
          lg.agregado_en,
          ROW_NUMBER() OVER (
            PARTITION BY lg.guia_id
            ORDER BY lg.lote_id DESC, lg.id DESC
          ) AS rn
        FROM lote_guias lg
        WHERE lg.guia_id = $1
      )
      SELECT
        g.id,
        g.numero_guia,
        g.created_at,
        g.sucursal_origen_id,
        g.sucursal_destino_id,
        so.nombre AS sucursal_origen_nombre,
        sd.nombre AS sucursal_destino_nombre,
        g.estado_logistico,
        g.estado_pago,
        g.condicion_pago,
        g.tipo_cobro,
        g.metodo_pago,
        g.cobro_obligatorio_entrega,
        g.monto_cobrar_destino,
        g.cobrado_destino_at,
        g.rendido_at,
        g.rendido_by_user_id,
        g.rendido_by_usuario,
        g.remitente_nombre,
        g.remitente_telefono,
        g.destinatario_nombre,
        g.destinatario_telefono,
        g.destinatario_direccion,
        g.fragil,
        g.novedad_hub_tipo,
        g.novedad_hub_detalle,
        g.novedad_hub_abierta,
        g.novedad_hub_resolucion,

        ll.lote_id,
        ll.estado_recepcion,
        ll.observacion_recepcion,
        ll.recibido_en AS lote_guia_recibido_en,
        ll.agregado_en,

        lc.tipo_lote,
        lc.estado AS lote_estado,
        lc.sucursal_origen_id AS lote_origen_id,
        lc.sucursal_destino_id AS lote_destino_id,
        slo.nombre AS lote_origen_nombre,
        sld.nombre AS lote_destino_nombre,
        lc.fecha_operativa,
        lc.creado_en,
        lc.consolidado_en,
        lc.despachado_en,
        lc.recibido_en,
        lc.cerrado_en,
        lc.resultado_recepcion,

        NULL::bigint AS cierre_id,
        NULL::text AS cierre_estado_db,
        NULL::bigint AS liquidacion_id,
        NULL::text AS liquidacion_estado_db,
        NULL::bigint AS conciliacion_id,
        NULL::text AS conciliacion_estado_db,

        NULL::text AS ultimo_evento,
        NULL::timestamp AS ultimo_evento_at
      FROM guias g
      LEFT JOIN sucursales so ON so.id = g.sucursal_origen_id
      LEFT JOIN sucursales sd ON sd.id = g.sucursal_destino_id
      LEFT JOIN last_lote ll
        ON ll.guia_id = g.id
       AND ll.rn = 1
      LEFT JOIN lotes_colecta lc
        ON lc.id = ll.lote_id
      LEFT JOIN sucursales slo
        ON slo.id = lc.sucursal_origen_id
      LEFT JOIN sucursales sld
        ON sld.id = lc.sucursal_destino_id
      WHERE g.id = $1
      LIMIT 1
    `,
    [guiaId]
  );

  if (!baseRows.rows.length) return null;

  const [row] = attachEstadoDerivadoMany(baseRows.rows);
  const tower = buildTowerRow(row);

  const eventosGuiaQ = await pool.query(
    `
      SELECT
        ge.id,
        ge.evento,
        ge.detalle,
        ge.sucursal_id,
        s.nombre AS sucursal_nombre,
        ge.created_at,
        'GUIA'::text AS fuente
      FROM guia_eventos ge
      LEFT JOIN sucursales s ON s.id = ge.sucursal_id
      WHERE ge.guia_id = $1
      ORDER BY ge.id ASC
      LIMIT 100
    `,
    [guiaId]
  );

  const eventosLoteQ = row.lote_id
    ? await pool.query(
        `
          SELECT
            le.id,
            le.evento,
            le.payload::text AS detalle,
            NULL::integer AS sucursal_id,
            NULL::text AS sucursal_nombre,
            le.created_at,
            'LOTE'::text AS fuente,
            le.usuario
          FROM lote_eventos le
          WHERE le.lote_id = $1
          ORDER BY le.id ASC
          LIMIT 100
        `,
        [row.lote_id]
      )
    : { rows: [] };

  const eventos = [
    ...(eventosGuiaQ.rows || []).map((x) => ({
      fuente: x.fuente,
      evento: x.evento,
      fecha: toIso(x.created_at),
      usuario: null,
      sucursal_nombre: x.sucursal_nombre || null,
      detalle: x.detalle || null,
    })),
    ...(eventosLoteQ.rows || []).map((x) => ({
      fuente: x.fuente,
      evento: x.evento,
      fecha: toIso(x.created_at),
      usuario: x.usuario || null,
      sucursal_nombre: x.sucursal_nombre || null,
      detalle: x.detalle || null,
    })),
  ].sort((a, b) => new Date(a.fecha || 0) - new Date(b.fecha || 0));

  return {
    guia: {
      guia_id: row.id,
      numero_guia: row.numero_guia,
      estado_logistico: row.estado_logistico,
      estado_pago: row.estado_pago,
      origen_id: row.sucursal_origen_id,
      origen_nombre: row.sucursal_origen_nombre,
      destino_id: row.sucursal_destino_id,
      destino_nombre: row.sucursal_destino_nombre,
      agencia_actual_id: tower.agencia_actual_id,
      agencia_actual_nombre: tower.agencia_actual_nombre,
    },
    estado_derivado: row.estado_derivado,
    torre_control: {
      requiere_accion_central: tower.requiere_accion_central,
      requiere_retiro: tower.requiere_retiro,
      requiere_colecta: tower.requiere_colecta,
      requiere_pase: tower.requiere_pase,
      requiere_revision: tower.requiere_revision,
      accion_recomendada: tower.accion_recomendada,
      prioridad: tower.prioridad,
      sin_movimiento_horas: tower.sin_movimiento_horas,
      alertas: tower.alertas,
      bloqueos: tower.bloqueos,
      resumen_corto: tower.resumen_corto,
    },
    lote: row.lote_id
      ? {
          lote_id: row.lote_id,
          tipo: row.tipo_lote,
          estado: row.lote_estado,
          origen_nombre: row.lote_origen_nombre,
          destino_nombre: row.lote_destino_nombre,
        }
      : null,
    eventos,
  };
}

module.exports = {
  getNovedadesTorre,
  getDetalleGuiaTorre,
};