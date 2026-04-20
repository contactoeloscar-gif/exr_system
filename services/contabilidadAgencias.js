// services/contabilidadAgencias.js

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return Math.round((toNum(v) + Number.EPSILON) * 100) / 100;
}

function normUpper(v) {
  return String(v ?? "").trim().toUpperCase();
}

function normLower(v) {
  return String(v ?? "").trim().toLowerCase();
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "t", "si", "sí", "y", "yes"].includes(s);
}

async function getSucursalContableConfig(db, sucursalId) {
  const { rows } = await db.query(
    `
    SELECT
      id,
      nombre,
      tipo_sucursal,
      liquida_con_exr,
      activa_liquidacion
    FROM sucursales
    WHERE id = $1
    LIMIT 1
    `,
    [sucursalId]
  );

  return rows[0] || null;
}

async function getReglasVigentes(db, { sucursalId, fecha, rolOperacion }) {
  const { rows } = await db.query(
    `
    SELECT
      id,
      sucursal_id,
      vigencia_desde,
      vigencia_hasta,
      rol_operacion,
      concepto,
      modalidad,
      base_calculo,
      valor,
      moneda,
      prioridad,
      activo,
      observaciones
    FROM sucursal_liquidacion_reglas
    WHERE sucursal_id = $1
      AND activo = true
      AND rol_operacion = $2
      AND vigencia_desde <= $3::date
      AND (vigencia_hasta IS NULL OR vigencia_hasta >= $3::date)
    ORDER BY prioridad ASC, id ASC
    `,
    [sucursalId, normUpper(rolOperacion), fecha]
  );

  return rows;
}

function calcularImporteRegla(regla, { guia, cobro }) {
  const modalidad = normUpper(regla.modalidad);
  const baseCalculo = normUpper(regla.base_calculo);
  const valor = toNum(regla.valor);

  if (modalidad === "FIJO" || baseCalculo === "FIJO") {
    return round2(valor);
  }

  let base = 0;

  switch (baseCalculo) {
    case "MONTO_ENVIO":
      base = toNum(guia.monto_envio);
      break;
    case "MONTO_TOTAL":
      base = toNum(guia.monto_total);
      break;
    case "MONTO_COBRADO":
      base = toNum(cobro.monto);
      break;
    default:
      base = 0;
      break;
  }

  return round2((base * valor) / 100);
}

function debeAplicarRegla(regla, { guia, cobro }) {
  const concepto = normUpper(regla.concepto);
  const tipoCobro = normLower(cobro.tipo_cobro);

  if (concepto === "COMISION_ORIGEN" && tipoCobro !== "origen") return false;
  if (concepto === "COMISION_DESTINO" && tipoCobro !== "destino") return false;
  if (concepto === "COMISION_COBRANZA" && tipoCobro !== "destino") return false;

  if (concepto === "ENTREGA_DOMICILIO" && !toBool(guia.entrega_domicilio)) {
    return false;
  }

  // Si más adelante agregás retiro a la guía, acá lo activás.
  if (concepto === "RETIRO") {
    const tieneRetiro =
      toBool(guia.retiro_domicilio) ||
      toBool(guia.requiere_retiro) ||
      toBool(guia.con_retiro);
    if (!tieneRetiro) return false;
  }

  return true;
}

async function crearMovimientoCtaCte(db, payload) {
  const refUid = String(payload.ref_uid || "").trim();
  if (!refUid) {
    throw new Error("ref_uid obligatorio para crear movimiento contable");
  }

  const params = [
    payload.sucursal_id,
    payload.fecha_operativa,
    payload.fecha_contable || payload.fecha_operativa,
    refUid,
    normUpper(payload.sentido),
    normUpper(payload.concepto),
    normUpper(payload.origen_tipo),
    payload.origen_id,
    payload.guia_id ?? null,
    payload.guia_cobro_id ?? null,
    payload.cierre_id ?? null,
    round2(payload.importe),
    payload.moneda || "ARS",
    normUpper(payload.estado || "PENDIENTE"),
    payload.descripcion || null,
    payload.meta ? JSON.stringify(payload.meta) : "{}",
    payload.generado_automaticamente !== false,
    payload.created_by_user_id ?? null,
  ];

  const insertSql = `
    INSERT INTO sucursal_ctacte_movimientos
    (
      sucursal_id,
      fecha_operativa,
      fecha_contable,
      ref_uid,
      sentido,
      concepto,
      origen_tipo,
      origen_id,
      guia_id,
      guia_cobro_id,
      cierre_id,
      importe,
      moneda,
      estado,
      descripcion,
      meta,
      generado_automaticamente,
      created_by_user_id
    )
    VALUES
    (
      $1,  $2,  $3,  $4,  $5,  $6,  $7,  $8,  $9,
      $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18
    )
    ON CONFLICT (ref_uid) DO NOTHING
    RETURNING *
  `;

  const inserted = await db.query(insertSql, params);

  if (inserted.rows[0]) {
    return {
      created: true,
      row: inserted.rows[0],
    };
  }

  const existing = await db.query(
    `
    SELECT *
    FROM sucursal_ctacte_movimientos
    WHERE ref_uid = $1
    LIMIT 1
    `,
    [refUid]
  );

  return {
    created: false,
    row: existing.rows[0] || null,
  };
}

async function getCobroConGuia(db, guiaCobroId) {
  const { rows } = await db.query(
    `
    SELECT
      gc.id,
      gc.guia_id,
      gc.sucursal_id,
      gc.usuario_id,
      gc.tipo_cobro,
      gc.medio_pago,
      gc.monto,
      gc.moneda,
      gc.estado,
      gc.created_at::date AS fecha_operativa,

      g.id AS guia_real_id,
      g.numero_guia,
      g.sucursal_origen_id,
      g.sucursal_destino_id,
      g.monto_envio,
      g.monto_total,
      g.entrega_domicilio

    FROM guia_cobros gc
    JOIN guias g
      ON g.id = gc.guia_id
    WHERE gc.id = $1
    LIMIT 1
    `,
    [guiaCobroId]
  );

  return rows[0] || null;
}

async function generarMovimientosPorCobro(db, guiaCobroId) {
  const cobro = await getCobroConGuia(db, guiaCobroId);
  if (!cobro) {
    throw new Error(`No existe guia_cobro id=${guiaCobroId}`);
  }

  const tipoCobro = normLower(cobro.tipo_cobro);
  if (!["origen", "destino"].includes(tipoCobro)) {
    return {
      ok: true,
      skipped: true,
      reason: `tipo_cobro no soportado: ${cobro.tipo_cobro}`,
      movimientos: [],
    };
  }

  if (normLower(cobro.estado) === "anulado") {
    return {
      ok: true,
      skipped: true,
      reason: "El cobro está anulado",
      movimientos: [],
    };
  }

  const sucursalId = Number(cobro.sucursal_id || 0);
  if (!sucursalId) {
    return {
      ok: true,
      skipped: true,
      reason: "El cobro no tiene sucursal_id válido",
      movimientos: [],
    };
  }

  const sucursal = await getSucursalContableConfig(db, sucursalId);
  if (!sucursal) {
    return {
      ok: true,
      skipped: true,
      reason: `Sucursal ${sucursalId} inexistente`,
      movimientos: [],
    };
  }

  if (normUpper(sucursal.tipo_sucursal) !== "AGENCIA") {
    return {
      ok: true,
      skipped: true,
      reason: "La sucursal no es AGENCIA",
      movimientos: [],
    };
  }

  if (!toBool(sucursal.liquida_con_exr) || !toBool(sucursal.activa_liquidacion)) {
    return {
      ok: true,
      skipped: true,
      reason: "La sucursal no liquida con EXR o tiene liquidación inactiva",
      movimientos: [],
    };
  }

  const fechaOperativa = cobro.fecha_operativa;
  const guia = {
    id: cobro.guia_real_id,
    numero_guia: cobro.numero_guia,
    sucursal_origen_id: cobro.sucursal_origen_id,
    sucursal_destino_id: cobro.sucursal_destino_id,
    monto_envio: cobro.monto_envio,
    monto_total: cobro.monto_total,
    entrega_domicilio: cobro.entrega_domicilio,
  };

  const movimientos = [];

  // 1) Recaudación real del cobro
  const conceptoRecaudacion =
    tipoCobro === "origen" ? "RECAUDACION_ORIGEN" : "RECAUDACION_DESTINO";

  const recaudacion = await crearMovimientoCtaCte(db, {
    sucursal_id: sucursalId,
    fecha_operativa: fechaOperativa,
    fecha_contable: fechaOperativa,
    ref_uid: `COBRO:${cobro.id}:${conceptoRecaudacion}`,
    sentido: "DEBITO_AGENCIA",
    concepto: conceptoRecaudacion,
    origen_tipo: "GUIA_COBRO",
    origen_id: cobro.id,
    guia_id: cobro.guia_id,
    guia_cobro_id: cobro.id,
    importe: cobro.monto,
    moneda: cobro.moneda || "ARS",
    estado: "PENDIENTE",
    descripcion: `Recaudación ${tipoCobro} guía ${cobro.numero_guia}`,
    meta: {
      origen: "generarMovimientosPorCobro",
      tipo_cobro: tipoCobro,
      medio_pago: cobro.medio_pago,
      numero_guia: cobro.numero_guia,
    },
    generado_automaticamente: true,
    created_by_user_id: cobro.usuario_id,
  });

  movimientos.push({
    kind: "recaudacion",
    created: recaudacion.created,
    row: recaudacion.row,
  });

  // 2) Reglas / comisiones de la sucursal que cobró
  const rolOperacion = tipoCobro === "origen" ? "ORIGEN" : "DESTINO";
  const reglas = await getReglasVigentes(db, {
    sucursalId,
    fecha: fechaOperativa,
    rolOperacion,
  });

  for (const regla of reglas) {
    if (!debeAplicarRegla(regla, { guia, cobro })) {
      continue;
    }

    const importe = calcularImporteRegla(regla, { guia, cobro });
    if (!(importe > 0)) {
      continue;
    }

    const mov = await crearMovimientoCtaCte(db, {
      sucursal_id: sucursalId,
      fecha_operativa: fechaOperativa,
      fecha_contable: fechaOperativa,
      ref_uid: `REGLA:${regla.id}:COBRO:${cobro.id}:${normUpper(regla.concepto)}`,
      sentido: "CREDITO_AGENCIA",
      concepto: normUpper(regla.concepto),
      origen_tipo: "GUIA_COBRO",
      origen_id: cobro.id,
      guia_id: cobro.guia_id,
      guia_cobro_id: cobro.id,
      importe,
      moneda: regla.moneda || cobro.moneda || "ARS",
      estado: "PENDIENTE",
      descripcion: `${regla.concepto} guía ${cobro.numero_guia}`,
      meta: {
        origen: "generarMovimientosPorCobro",
        regla_id: regla.id,
        tipo_cobro: tipoCobro,
        medio_pago: cobro.medio_pago,
        numero_guia: cobro.numero_guia,
        modalidad: regla.modalidad,
        base_calculo: regla.base_calculo,
        valor_regla: regla.valor,
      },
      generado_automaticamente: true,
      created_by_user_id: cobro.usuario_id,
    });

    movimientos.push({
      kind: "regla",
      regla_id: regla.id,
      concepto: regla.concepto,
      created: mov.created,
      row: mov.row,
    });
  }

  return {
    ok: true,
    skipped: false,
    sucursal: {
      id: sucursal.id,
      nombre: sucursal.nombre,
      tipo_sucursal: sucursal.tipo_sucursal,
      liquida_con_exr: sucursal.liquida_con_exr,
      activa_liquidacion: sucursal.activa_liquidacion,
    },
    cobro: {
      id: cobro.id,
      guia_id: cobro.guia_id,
      numero_guia: cobro.numero_guia,
      sucursal_id: cobro.sucursal_id,
      tipo_cobro: cobro.tipo_cobro,
      monto: cobro.monto,
      moneda: cobro.moneda,
      fecha_operativa: fechaOperativa,
    },
    movimientos,
  };
}

async function crearAjusteManual(db, payload) {
  return crearMovimientoCtaCte(db, {
    sucursal_id: payload.sucursal_id,
    fecha_operativa: payload.fecha_operativa,
    fecha_contable: payload.fecha_contable || payload.fecha_operativa,
    ref_uid: payload.ref_uid,
    sentido: payload.sentido,
    concepto: payload.concepto,
    origen_tipo: "AJUSTE_MANUAL",
    origen_id: payload.origen_id || Date.now(),
    guia_id: payload.guia_id ?? null,
    guia_cobro_id: payload.guia_cobro_id ?? null,
    cierre_id: null,
    importe: payload.importe,
    moneda: payload.moneda || "ARS",
    estado: payload.estado || "PENDIENTE",
    descripcion: payload.descripcion || null,
    meta: payload.meta || {},
    generado_automaticamente: false,
    created_by_user_id: payload.created_by_user_id ?? null,
  });
}

module.exports = {
  crearMovimientoCtaCte,
  generarMovimientosPorCobro,
  crearAjusteManual,
  getSucursalContableConfig,
  getReglasVigentes,
};