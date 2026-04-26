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

/**
 * Base comisionable:
 * - usar MONTO_ENVIO como base principal
 * - IVA para EXR
 * - seguro para EXR
 * - extras administrativos no operativos fuera
 *
 * Entrega a domicilio:
 * - si la regla es ENTREGA_DOMICILIO => 70% agencia / 30% EXR
 *   (o sea la agencia comisiona solo el 70% del valor de ese concepto)
 */
function calcularImporteRegla(regla, { guia, cobro }) {
  const modalidad = normUpper(regla.modalidad);
  const baseCalculo = normUpper(regla.base_calculo);
  const concepto = normUpper(regla.concepto);
  const valor = toNum(regla.valor);

  // FIJO
  if (modalidad === "FIJO" || baseCalculo === "FIJO") {
    let importe = round2(valor);

    if (concepto === "ENTREGA_DOMICILIO") {
      importe = round2(importe * 0.7);
    }

    return importe;
  }

  // PORCENTAJE
  let base = 0;

  switch (baseCalculo) {
    case "MONTO_ENVIO":
      base = toNum(guia.monto_envio);
      break;

    case "MONTO_TOTAL":
      // compatibilidad: si alguna regla vieja usa MONTO_TOTAL, la mantenemos,
      // aunque la regla recomendada sea liquidar sobre MONTO_ENVIO
      base = toNum(guia.monto_total);
      break;

    case "MONTO_COBRADO":
      base = toNum(cobro.monto);
      break;

    default:
      base = 0;
      break;
  }

  let importe = round2((base * valor) / 100);

  // Entrega domicilio: 70% para agencia / 30% EXR
  if (concepto === "ENTREGA_DOMICILIO") {
    importe = round2(importe * 0.7);
  }

  return importe;
}

/**
 * Compatibilidad + nueva política:
 * - COMISION_COBRANZA no aplica más
 * - COMISION_ORIGEN puede generarse incluso cuando el cobro es destino
 *   si el bloque que la invoca ya decidió que corresponde
 * - COMISION_DESTINO aplica solo en cobro destino
 */
function debeAplicarRegla(regla, { guia, cobro, forzarConcepto = null }) {
  const concepto = normUpper(regla.concepto);
  const tipoCobro = normLower(cobro.tipo_cobro);

  // Desactivar plus por cobranza
  if (concepto === "COMISION_COBRANZA") return false;

  // Si estamos forzando un concepto exacto, solo dejamos pasar ese
  if (forzarConcepto && concepto !== normUpper(forzarConcepto)) {
    return false;
  }

  // Regla histórica:
  // COMISION_DESTINO solo cuando el cobro fue destino
  if (concepto === "COMISION_DESTINO" && tipoCobro !== "destino") return false;

  // IMPORTANTE:
  // COMISION_ORIGEN ya NO depende de que el tipo_cobro sea origen.
  // Se puede aplicar en cobro destino si la invocación la busca para la sucursal origen.

  if (concepto === "ENTREGA_DOMICILIO" && !toBool(guia.entrega_domicilio)) {
    return false;
  }

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

/**
 * Aplica reglas para una sucursal/rol y un subconjunto opcional de conceptos.
 */
async function aplicarReglasSucursal(db, {
  sucursal,
  guia,
  cobro,
  fechaOperativa,
  rolOperacion,
  usuarioId,
  conceptosPermitidos = null,
  refPrefix = "",
  descripcionPrefix = "",
}) {
  const reglas = await getReglasVigentes(db, {
    sucursalId: sucursal.id,
    fecha: fechaOperativa,
    rolOperacion,
  });

  const movimientos = [];

  for (const regla of reglas) {
    const concepto = normUpper(regla.concepto);

    if (Array.isArray(conceptosPermitidos) && conceptosPermitidos.length) {
      if (!conceptosPermitidos.map(normUpper).includes(concepto)) {
        continue;
      }
    }

    if (!debeAplicarRegla(regla, { guia, cobro, forzarConcepto: concepto })) {
      continue;
    }

    const importe = calcularImporteRegla(regla, { guia, cobro });
    if (!(importe > 0)) continue;

    const mov = await crearMovimientoCtaCte(db, {
      sucursal_id: sucursal.id,
      fecha_operativa: fechaOperativa,
      fecha_contable: fechaOperativa,
      ref_uid: `${refPrefix}REGLA:${regla.id}:COBRO:${cobro.id}:${concepto}`,
      sentido: "CREDITO_AGENCIA",
      concepto,
      origen_tipo: "GUIA_COBRO",
      origen_id: cobro.id,
      guia_id: cobro.guia_id,
      guia_cobro_id: cobro.id,
      importe,
      moneda: regla.moneda || cobro.moneda || "ARS",
      estado: "PENDIENTE",
      descripcion: `${descripcionPrefix}${regla.concepto} guía ${cobro.numero_guia}`,
      meta: {
        origen: "generarMovimientosPorCobro",
        regla_id: regla.id,
        sucursal_id: sucursal.id,
        sucursal_nombre: sucursal.nombre,
        rol_operacion: rolOperacion,
        tipo_cobro: cobro.tipo_cobro,
        medio_pago: cobro.medio_pago,
        numero_guia: cobro.numero_guia,
        modalidad: regla.modalidad,
        base_calculo: regla.base_calculo,
        valor_regla: regla.valor,
      },
      generado_automaticamente: true,
      created_by_user_id: usuarioId,
    });

    movimientos.push({
      kind: "regla",
      regla_id: regla.id,
      concepto: regla.concepto,
      created: mov.created,
      row: mov.row,
      sucursal_id: sucursal.id,
      rol_operacion: rolOperacion,
    });
  }

  return movimientos;
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

  const sucursalCobradoraId = Number(cobro.sucursal_id || 0);
  if (!sucursalCobradoraId) {
    return {
      ok: true,
      skipped: true,
      reason: "El cobro no tiene sucursal_id válido",
      movimientos: [],
    };
  }

  const sucursalCobradora = await getSucursalContableConfig(db, sucursalCobradoraId);
  if (!sucursalCobradora) {
    return {
      ok: true,
      skipped: true,
      reason: `Sucursal ${sucursalCobradoraId} inexistente`,
      movimientos: [],
    };
  }

  if (normUpper(sucursalCobradora.tipo_sucursal) !== "AGENCIA") {
    return {
      ok: true,
      skipped: true,
      reason: "La sucursal no es AGENCIA",
      movimientos: [],
    };
  }

  if (!toBool(sucursalCobradora.liquida_con_exr) || !toBool(sucursalCobradora.activa_liquidacion)) {
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

  // 1) Recaudación real del cobro, siempre sobre la sucursal que cobró
  const conceptoRecaudacion =
    tipoCobro === "origen" ? "RECAUDACION_ORIGEN" : "RECAUDACION_DESTINO";

  const recaudacion = await crearMovimientoCtaCte(db, {
    sucursal_id: sucursalCobradoraId,
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
    sucursal_id: sucursalCobradoraId,
  });

  // 2) Comisión para la sucursal que cobró / operó el destino
  // Sin plus de cobranza.
  {
    const reglasDestino = await getReglasVigentes(db, {
      sucursalId: sucursalCobradoraId,
      fecha: fechaOperativa,
      rolOperacion: tipoCobro === "destino" ? "DESTINO" : "ORIGEN",
    });

    for (const regla of reglasDestino) {
      const concepto = normUpper(regla.concepto);

      // Desactivar plus cobranza
      if (concepto === "COMISION_COBRANZA") continue;

      // En cobro destino: solo comisión destino + entrega domicilio + retiro si existiera
      if (tipoCobro === "destino") {
        if (!["COMISION_DESTINO", "ENTREGA_DOMICILIO", "RETIRO"].includes(concepto)) {
          continue;
        }
      }

      // En cobro origen: solo comisión origen + entrega domicilio + retiro si existiera
      if (tipoCobro === "origen") {
        if (!["COMISION_ORIGEN", "ENTREGA_DOMICILIO", "RETIRO"].includes(concepto)) {
          continue;
        }
      }

      if (!debeAplicarRegla(regla, { guia, cobro })) continue;

      const importe = calcularImporteRegla(regla, { guia, cobro });
      if (!(importe > 0)) continue;

      const mov = await crearMovimientoCtaCte(db, {
        sucursal_id: sucursalCobradoraId,
        fecha_operativa: fechaOperativa,
        fecha_contable: fechaOperativa,
        ref_uid: `REGLA:${regla.id}:COBRO:${cobro.id}:${concepto}`,
        sentido: "CREDITO_AGENCIA",
        concepto,
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
        sucursal_id: sucursalCobradoraId,
      });
    }
  }

  // 3) Si el cobro fue DESTINO, también generar comisión ORIGEN para la agencia de origen
  if (tipoCobro === "destino") {
    const sucursalOrigenId = Number(cobro.sucursal_origen_id || 0);

    if (sucursalOrigenId && sucursalOrigenId !== sucursalCobradoraId) {
      const sucursalOrigen = await getSucursalContableConfig(db, sucursalOrigenId);

      if (
        sucursalOrigen &&
        normUpper(sucursalOrigen.tipo_sucursal) === "AGENCIA" &&
        toBool(sucursalOrigen.liquida_con_exr) &&
        toBool(sucursalOrigen.activa_liquidacion)
      ) {
        const reglasOrigen = await getReglasVigentes(db, {
          sucursalId: sucursalOrigenId,
          fecha: fechaOperativa,
          rolOperacion: "ORIGEN",
        });

        for (const regla of reglasOrigen) {
          const concepto = normUpper(regla.concepto);

          // Solo comisión origen para la agencia de origen
          if (concepto !== "COMISION_ORIGEN") continue;

          if (!debeAplicarRegla(regla, { guia, cobro, forzarConcepto: "COMISION_ORIGEN" })) {
            continue;
          }

          const importe = calcularImporteRegla(regla, { guia, cobro });
          if (!(importe > 0)) continue;

          const mov = await crearMovimientoCtaCte(db, {
            sucursal_id: sucursalOrigenId,
            fecha_operativa: fechaOperativa,
            fecha_contable: fechaOperativa,
            ref_uid: `ORIGEN:REGLA:${regla.id}:COBRO:${cobro.id}:COMISION_ORIGEN`,
            sentido: "CREDITO_AGENCIA",
            concepto: "COMISION_ORIGEN",
            origen_tipo: "GUIA_COBRO",
            origen_id: cobro.id,
            guia_id: cobro.guia_id,
            guia_cobro_id: cobro.id,
            importe,
            moneda: regla.moneda || cobro.moneda || "ARS",
            estado: "PENDIENTE",
            descripcion: `COMISION_ORIGEN guía ${cobro.numero_guia}`,
            meta: {
              origen: "generarMovimientosPorCobro",
              regla_id: regla.id,
              sucursal_id: sucursalOrigenId,
              sucursal_nombre: sucursalOrigen.nombre,
              rol_operacion: "ORIGEN",
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
            concepto: "COMISION_ORIGEN",
            created: mov.created,
            row: mov.row,
            sucursal_id: sucursalOrigenId,
          });
        }
      }
    }
  }

  return {
    ok: true,
    skipped: false,
    sucursal: {
      id: sucursalCobradora.id,
      nombre: sucursalCobradora.nombre,
      tipo_sucursal: sucursalCobradora.tipo_sucursal,
      liquida_con_exr: sucursalCobradora.liquida_con_exr,
      activa_liquidacion: sucursalCobradora.activa_liquidacion,
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