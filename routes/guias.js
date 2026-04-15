// routes/guias.js
console.log("CARGANDO routes/guias.js");

const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const {
  CONDICION_PAGO,
  ESTADO_PAGO,
} = require("../utils/cobros.constants");

/* =========================
   Helpers
========================= */
function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}
function asNum(v) {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : NaN;
}
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}
function round6(n) {
  return Math.round(Number(n) * 1000000) / 1000000;
}
function s(v, max = 255) {
  const t = String(v ?? "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) : t;
}
function pad(n, len = 8) {
  const x = String(n);
  return x.length >= len ? x : "0".repeat(len - x.length) + x;
}
function ceilMin1(n) {
  const x = Math.ceil(Number(n) || 0);
  return x < 1 ? 1 : x;
}
function clamp(n, min, max) {
  const x = Number(n) || 0;
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

/* =========================
   Reglas de negocio
========================= */
const FACTOR_VOLUM = 5000;
const MIN_BULTO = 7500;
const EXTRA_DOMICILIO = 6000;
const SEGURO_PCT = 0.01;
const VAL_DECL_MIN = 20000;
const VAL_DECL_MAX = 80000;

function calcVolKg(largo_cm, ancho_cm, alto_cm) {
  if (largo_cm > 0 && ancho_cm > 0 && alto_cm > 0) {
    return (largo_cm * ancho_cm * alto_cm) / FACTOR_VOLUM;
  }
  return 0;
}
function calcM3(largo_cm, ancho_cm, alto_cm) {
  if (largo_cm > 0 && ancho_cm > 0 && alto_cm > 0) {
    return (largo_cm * ancho_cm * alto_cm) / 1_000_000;
  }
  return 0;
}

function sumBultos(items) {
  if (!Array.isArray(items) || items.length === 0) return 1;
  const total = items.reduce((acc, it) => {
    const b = Number.isFinite(asInt(it?.bultos)) ? asInt(it.bultos) : 0;
    return acc + (b > 0 ? b : 0);
  }, 0);
  return total > 0 ? total : 1;
}

/* =========================
   PRO: Normalizador de líneas
========================= */
function normalizeItem(it) {
  const bultos = asInt(it?.bultos ?? it?.cantidad ?? 1);

  const peso_kg = asNum(it?.peso_kg ?? it?.peso ?? it?.pesoKg ?? 0);

  const largo_cm = asNum(it?.largo_cm ?? it?.largo ?? it?.largoCm ?? 0);
  const ancho_cm = asNum(it?.ancho_cm ?? it?.ancho ?? it?.anchoCm ?? 0);
  const alto_cm = asNum(it?.alto_cm ?? it?.alto ?? it?.altoCm ?? 0);

  return {
    descripcion: s(it?.descripcion ?? it?.desc ?? "", 180),
    bultos: Number.isFinite(bultos) && bultos > 0 ? bultos : 0,
    peso_kg: Number.isFinite(peso_kg) && peso_kg > 0 ? peso_kg : 0,
    largo_cm: Number.isFinite(largo_cm) && largo_cm > 0 ? largo_cm : 0,
    ancho_cm: Number.isFinite(ancho_cm) && ancho_cm > 0 ? ancho_cm : 0,
    alto_cm: Number.isFinite(alto_cm) && alto_cm > 0 ? alto_cm : 0,
  };
}

/**
 * Totales por líneas
 */
function itemPesoTotalKg(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  let total = 0;
  for (const it of items) {
    if (it.bultos > 0 && it.peso_kg > 0) total += it.bultos * it.peso_kg;
  }
  return total;
}
function itemVolTotalKg(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  let total = 0;
  for (const it of items) {
    if (it.bultos > 0 && it.largo_cm > 0 && it.ancho_cm > 0 && it.alto_cm > 0) {
      total += it.bultos * ((it.largo_cm * it.ancho_cm * it.alto_cm) / FACTOR_VOLUM);
    }
  }
  return total;
}
function itemTotalM3(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  let total = 0;
  for (const it of items) {
    if (it.bultos > 0 && it.largo_cm > 0 && it.ancho_cm > 0 && it.alto_cm > 0) {
      total += it.bultos * ((it.largo_cm * it.ancho_cm * it.alto_cm) / 1_000_000);
    }
  }
  return total;
}

/* =========================
   Tarifas por ruta y kg
========================= */
async function tarifaPorKgRuta(client, origen_id, destino_id, kg_tarifado) {
  const q = await client.query(
    `
    SELECT precio, peso_min, peso_max, id, origen_id, destino_id
    FROM tarifas_rango
    WHERE activo = true
      AND $3 >= peso_min AND $3 <= peso_max
      AND (
        (origen_id = $1 AND destino_id = $2)
        OR (origen_id = $1 AND destino_id IS NULL)
        OR (origen_id IS NULL AND destino_id IS NULL)
      )
    ORDER BY
      CASE
        WHEN origen_id = $1 AND destino_id = $2 THEN 1
        WHEN origen_id = $1 AND destino_id IS NULL THEN 2
        ELSE 3
      END,
      peso_min ASC
    LIMIT 1
    `,
    [origen_id, destino_id, kg_tarifado]
  );

  if (q.rowCount === 0) return null;

  const row = q.rows[0];
  return {
    precio: round2(row.precio),
    peso_min: round2(row.peso_min),
    peso_max: round2(row.peso_max),
    tarifa_id: row.id,
    tarifa_match: {
      origen_id: row.origen_id,
      destino_id: row.destino_id,
      tipo:
        row.origen_id === origen_id && row.destino_id === destino_id
          ? "RUTA"
          : row.origen_id === origen_id && row.destino_id == null
          ? "ORIGEN"
          : "GLOBAL",
    },
  };
}

/* =========================
   Cotizador central
========================= */
async function cotizar(client, params) {
  const {
    origen_id,
    destino_id,
    peso_kg,
    largo_cm,
    ancho_cm,
    alto_cm,
    entrega_domicilio,
    valor_declarado,
    items,
  } = params;

  const norm = Array.isArray(items) ? items.map(normalizeItem).filter((x) => x.bultos > 0) : [];

  const peso_items = itemPesoTotalKg(norm);
  const vol_items = itemVolTotalKg(norm);
  const m3_items = itemTotalM3(norm);

  const peso_global = Number(peso_kg) || 0;
  const vol_global = calcVolKg(largo_cm, ancho_cm, alto_cm);
  const m3_global = calcM3(largo_cm, ancho_cm, alto_cm);

  const peso_total = peso_items > 0 ? peso_items : peso_global;
  const vol_total = vol_items > 0 ? vol_items : vol_global;
  const m3_total = m3_items > 0 ? m3_items : m3_global;

  const kg_cobrable = round2(Math.max(peso_total, vol_total));
  const kg_tarifado = ceilMin1(kg_cobrable);

  const t = await tarifaPorKgRuta(client, origen_id, destino_id, kg_tarifado);
  if (!t) return { ok: false, error: "No hay tarifa para esa ruta/peso", kg_tarifado, kg_cobrable };

  const bultos_total = sumBultos(norm);
  const minimo_bultos = round2(bultos_total * MIN_BULTO);

  const valor_envio_kg = round2(kg_tarifado * t.precio);
  const valor_envio = round2(Math.max(valor_envio_kg, minimo_bultos));

  const extra_domicilio = entrega_domicilio ? EXTRA_DOMICILIO : 0;

  const declarado_input = valor_declarado > 0 ? valor_declarado : 0;
  const declarado_asegurable = clamp(declarado_input, VAL_DECL_MIN, VAL_DECL_MAX);
  const seguro = round2(declarado_asegurable * SEGURO_PCT);

  const total = round2(valor_envio + extra_domicilio + seguro);

  return {
    ok: true,
    desglose: {
      peso_kg: round2(peso_total),
      volumetrico_kg: round2(vol_total),
      kg_cobrable,
      kg_tarifado,
      tarifa_kg: t.precio,
      tarifa_id: t.tarifa_id,
      tarifa_rango: { peso_min: t.peso_min, peso_max: t.peso_max },
      tarifa_match: t.tarifa_match,
      bultos_total,
      minimo_bultos,
      valor_envio,
      valor_envio_kg,
      extra_domicilio,
      declarado_input: round2(declarado_input),
      declarado_asegurable: round2(declarado_asegurable),
      seguro,
      total,
      total_m3: round6(m3_total),
    },
  };
}

/* ==============================
   POST /guias/cotizar
============================== */
router.post("/cotizar", async (req, res) => {
  const user = req.user || {};
  const usuario_id = user.user_id;
  if (!usuario_id) return res.status(401).json({ ok: false, error: "No autorizado" });

  const origen_id = Number.isFinite(asInt(req.body?.sucursal_origen_id))
    ? asInt(req.body.sucursal_origen_id)
    : asInt(user.sucursal_id);

  const destino_id = asInt(req.body?.sucursal_destino_id);

  if (!Number.isFinite(origen_id) || !Number.isFinite(destino_id)) {
    return res.status(400).json({ ok: false, error: "Faltan sucursal_origen_id / sucursal_destino_id" });
  }

  const peso_kg = asNum(req.body?.peso_kg ?? 0);
  const largo_cm = asNum(req.body?.largo_cm ?? 0);
  const ancho_cm = asNum(req.body?.ancho_cm ?? 0);
  const alto_cm = asNum(req.body?.alto_cm ?? 0);

  const entrega_domicilio = !!req.body?.entrega_domicilio;
  const valor_declarado = asNum(req.body?.valor_declarado ?? 0);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  const safeItems = items.map(normalizeItem).filter((x) => x.bultos > 0);

  const client = await pool.connect();
  try {
    const out = await cotizar(client, {
      origen_id,
      destino_id,
      peso_kg,
      largo_cm,
      ancho_cm,
      alto_cm,
      entrega_domicilio,
      valor_declarado,
      items: safeItems,
    });
    if (!out.ok) return res.status(400).json(out);
    return res.json(out);
  } catch (e) {
    console.error("POST /guias/cotizar ERROR:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || "Error interno cotizando") });
  } finally {
    client.release();
  }
});

/* ==============================
   POST /guias
============================== */
router.post("/", async (req, res) => {
  const user = req.user || {};
  const usuario_id = user.user_id;
  if (!usuario_id) return res.status(401).json({ ok: false, error: "No autorizado" });

  const sucursal_origen_id = Number.isFinite(asInt(req.body?.sucursal_origen_id))
    ? asInt(req.body.sucursal_origen_id)
    : asInt(user.sucursal_id);

  const sucursal_destino_id = asInt(req.body?.sucursal_destino_id);

  if (!Number.isFinite(sucursal_origen_id) || !Number.isFinite(sucursal_destino_id)) {
    return res.status(400).json({ ok: false, error: "Faltan sucursal_origen_id / sucursal_destino_id" });
  }

  // Personas
  const remitente_nombre = s(req.body?.remitente_nombre, 120);
  const remitente_telefono = s(req.body?.remitente_tel ?? req.body?.remitente_telefono, 40);
  const remitente_dni = s(req.body?.remitente_dni, 30);

  const destinatario_nombre = s(req.body?.destinatario_nombre, 120);
  const destinatario_telefono = s(req.body?.destinatario_tel ?? req.body?.destinatario_telefono, 40);
  const destinatario_dni = s(req.body?.destinatario_dni, 30);

  const destinatario_dir = s(req.body?.destinatario_dir, 200);
  const observaciones = s(req.body?.observaciones, 500);

  // Back-compat global (fallback)
  const peso_kg = asNum(req.body?.peso_kg ?? 0);
  const largo_cm = asNum(req.body?.largo_cm ?? 0);
  const ancho_cm = asNum(req.body?.ancho_cm ?? 0);
  const alto_cm = asNum(req.body?.alto_cm ?? 0);
  const entrega_domicilio = !!req.body?.entrega_domicilio;

  // Pago
  const tipo_cobro = s(req.body?.forma_pago ?? req.body?.tipo_cobro ?? "ORIGEN", 20).toUpperCase();
  const confirmar_pago = !!req.body?.confirmar_pago;
  const valor_declarado = asNum(req.body?.valor_declarado ?? 0);

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const safeItems = items.map(normalizeItem).filter((x) => x.bultos > 0);
  if (safeItems.length === 0) safeItems.push(normalizeItem({ bultos: 1 }));

  if (!remitente_nombre) return res.status(400).json({ ok: false, error: "remitente_nombre requerido" });
  if (!destinatario_nombre) return res.status(400).json({ ok: false, error: "destinatario_nombre requerido" });
  if (!["ORIGEN", "DESTINO"].includes(tipo_cobro)) return res.status(400).json({ ok: false, error: "tipo_cobro inválido" });

  if (entrega_domicilio && destinatario_dir.trim().length < 6) {
    return res.status(400).json({ ok: false, error: "Dirección obligatoria para entrega a domicilio" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Validar sucursales
    const so = await client.query("SELECT id FROM sucursales WHERE id=$1", [sucursal_origen_id]);
    const sd = await client.query("SELECT id FROM sucursales WHERE id=$1", [sucursal_destino_id]);
    if (so.rowCount === 0 || sd.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Sucursal origen/destino inexistente" });
    }

    // Cotización
    const q = await cotizar(client, {
      origen_id: sucursal_origen_id,
      destino_id: sucursal_destino_id,
      peso_kg,
      largo_cm,
      ancho_cm,
      alto_cm,
      entrega_domicilio,
      valor_declarado,
      items: safeItems,
    });

    if (!q.ok) {
      await client.query("ROLLBACK");
      return res.status(400).json(q);
    }

    const d = q.desglose;

    // Estados financieros P15
    const condicion_pago =
      tipo_cobro === "DESTINO" ? CONDICION_PAGO.DESTINO : CONDICION_PAGO.ORIGEN;

    let estado_pago;
    let monto_cobrar_destino = 0;
    const cobro_obligatorio_entrega = true;

    if (tipo_cobro === "DESTINO") {
      estado_pago = ESTADO_PAGO.PENDIENTE_DESTINO;
      monto_cobrar_destino = round2(d.total);
    } else {
      estado_pago = confirmar_pago
        ? ESTADO_PAGO.NO_APLICA
        : ESTADO_PAGO.PENDIENTE_ORIGEN;
      monto_cobrar_destino = 0;
    }

    // Contador por sucursal
    const c1 = await client.query(
      "SELECT ultimo_numero FROM contadores_guias WHERE sucursal_id=$1 FOR UPDATE",
      [sucursal_origen_id]
    );

    let ultimo = 0;
    if (c1.rowCount === 0) {
      await client.query("INSERT INTO contadores_guias(sucursal_id, ultimo_numero) VALUES($1, 0)", [sucursal_origen_id]);
      ultimo = 0;
    } else {
      ultimo = Number(c1.rows[0].ultimo_numero) || 0;
    }

    const next = ultimo + 1;
    await client.query("UPDATE contadores_guias SET ultimo_numero=$2 WHERE sucursal_id=$1", [sucursal_origen_id, next]);

    const numero_guia = `EXR-${pad(sucursal_origen_id, 3)}-${pad(next, 8)}`;

    const detalle_tarifa = {
      factor_volum: FACTOR_VOLUM,
      min_bulto: MIN_BULTO,
      extra_domicilio_fijo: EXTRA_DOMICILIO,
      seguro_pct: SEGURO_PCT,
      declarado_min: VAL_DECL_MIN,
      declarado_max: VAL_DECL_MAX,
      destino_dir: destinatario_dir,
      observaciones,
      items: safeItems,
      cotizacion: d,
      p15: {
        condicion_pago,
        estado_pago,
        monto_cobrar_destino,
        cobro_obligatorio_entrega,
      },
    };

    const ins = await client.query(
      `
      INSERT INTO guias(
        numero_guia,
        sucursal_origen_id, sucursal_destino_id,
        remitente_nombre, remitente_dni, remitente_telefono,
        destinatario_nombre, destinatario_dni, destinatario_telefono, destinatario_direccion,
        tipo_cobro,
        condicion_pago,
        estado_logistico,
        estado_pago,
        monto_cobrar_destino,
        cobro_obligatorio_entrega,
        valor_declarado,
        monto_seguro, monto_envio, monto_total,
        entrega_domicilio,
        detalle_tarifa,
        peso_kg, largo_cm, ancho_cm, alto_cm, kg_cobrable,
        total_kg, total_m3,
        cantidad_bultos,
        precio_envio, precio_domicilio, precio_seguro, total_cobrar
      ) VALUES(
        $1,
        $2,$3,
        $4,$5,$6,
        $7,$8,$9,$10,
        $11,
        $12,
        'RECIBIDO_ORIGEN',
        $13,
        $14,
        $15,
        $16,
        $17,$18,$19,
        $20,
        $21::jsonb,
        $22,$23,$24,$25,$26,
        $27,$28,
        $29,
        $30,$31,$32,$33
      )
      RETURNING
        id,
        numero_guia,
        estado_logistico,
        estado_pago,
        condicion_pago,
        monto_cobrar_destino,
        monto_total,
        created_at
      `,
      [
        numero_guia,
        sucursal_origen_id, sucursal_destino_id,

        remitente_nombre, remitente_dni || null, remitente_telefono || null,
        destinatario_nombre, destinatario_dni || null, destinatario_telefono || null, destinatario_dir || null,

        tipo_cobro,
        condicion_pago,
        estado_pago,
        monto_cobrar_destino,
        cobro_obligatorio_entrega,
        round2(valor_declarado),

        round2(d.seguro), round2(d.valor_envio), round2(d.total),
        entrega_domicilio,

        JSON.stringify(detalle_tarifa),

        round2(d.peso_kg),
        round2(largo_cm), round2(ancho_cm), round2(alto_cm), round2(d.kg_cobrable),

        round3(d.kg_cobrable), round6(d.total_m3),
        d.bultos_total,

        round2(d.valor_envio), round2(d.extra_domicilio), round2(d.seguro), round2(d.total),
      ]
    );

    const guia = ins.rows[0];

    // guia_items tipo BULTO
    for (const it of safeItems) {
      await client.query(
        `INSERT INTO guia_items(guia_id, tipo, cantidad, precio_unitario, subtotal)
         VALUES($1,'BULTO',$2,0,0)`,
        [guia.id, it.bultos]
      );
    }

    // guia_eventos
    await client.query(
      `INSERT INTO guia_eventos(guia_id, evento, detalle, sucursal_id)
       VALUES($1,$2,$3,$4)`,
      [guia.id, "CREADA", "Guía creada en origen", sucursal_origen_id]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, guia, cotizacion: d });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    console.error("POST /guias ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || "Error interno creando guía") });
  } finally {
    client.release();
  }
});

module.exports = router;
