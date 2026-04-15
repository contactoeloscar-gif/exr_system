console.log("CARGANDO routes/finanzas.js");

const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { isOwnerOrAdmin } = require("../middleware/roles");

/* =========================
   Helpers
========================= */
function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}
function asDate(v) {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/* =========================================================
   LIMPIEZA:
   - Cierres diarios viven en routes/cierres.js
     -> POST /interno/cierres/diario
========================================================= */

/* =========================================================
   Sync financiero desde cierres diarios
   - Genera movimientos_agencia idempotentes (sin duplicar)
   - Tipos: COBRO_ENVIO, IVA, SEGURO, COMISION_PAGADA, COMISION_RECIBIDA
   - Comisión (ECO): 25% base; >10 => 28%; >20 => 30% (por período)
   - Comisión aplica SOLO sobre guias.monto_envio
   - Seguro + IVA = 100% EXR (sin comisión)

   IMPORTANTE:
   - Este sync NO usa created_at: usa cierres_diarios.fecha entre desde/hasta.
   - Idempotencia recomendada: índice UNIQUE (guia_id, tipo) en movimientos_agencia
     y usar ON CONFLICT DO NOTHING (implementado abajo).
========================================================= */

function pctEcoByCount(cant) {
  if (cant > 20) return 0.30;
  if (cant > 10) return 0.28;
  return 0.25;
}

// Premium: si todavía no definiste comisión premium, queda 0
function pctPremiumByCount(_cant) {
  return 0.0;
}

async function insertMovimientoIdempotente(client, mov) {
  // mov: {sucursal_id, fecha, tipo, guia_id, debe, haber, detalle}
  // Requiere índice UNIQUE (guia_id, tipo) para idempotencia fuerte.
  const r = await client.query(
    `
    INSERT INTO public.movimientos_agencia
      (sucursal_id, fecha, tipo, guia_id, debe, haber, detalle, creado_en)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (guia_id, tipo) DO NOTHING
    RETURNING id;
    `,
    [
      mov.sucursal_id,
      mov.fecha,
      mov.tipo,
      mov.guia_id,
      mov.debe,
      mov.haber,
      mov.detalle || null,
    ]
  );
  return r.rowCount === 1;
}

/**
 * POST /interno/finanzas/sync?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&dry=1
 * - Genera movimientos desde guías incluidas en cierres diarios CERRADOS.
 */
router.post("/sync", async (req, res) => {
  const owner = isOwnerOrAdmin(req);
  if (!owner) return res.status(403).json({ ok: false, error: "Solo OWNER/ADMIN" });

  const desde = asDate(req.query.desde) || "2000-01-01";
  const hasta = asDate(req.query.hasta) || "2100-01-01";
  const dry = String(req.query.dry || "") === "1";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) Traer guías del rango de cierres
    const q = await client.query(
      `
      SELECT
        g.id AS guia_id,
        g.sucursal_origen_id,
        g.sucursal_destino_id,
        UPPER(COALESCE(g.tipo_cobro,'')) AS tipo_cobro,                  -- ORIGEN|DESTINO
        UPPER(COALESCE(g.servicio_tipo,'ECONOMICO')) AS servicio_tipo,   -- ECONOMICO|PREMIUM
        COALESCE(g.monto_envio,0)::numeric AS monto_envio,
        COALESCE(g.monto_seguro,0)::numeric AS monto_seguro,
        COALESCE(g.iva_monto,0)::numeric AS iva_monto,
        cd.fecha AS fecha_cierre
      FROM public.cierres_diarios cd
      JOIN public.cierres_guias cg ON cg.cierre_id = cd.id
      JOIN public.guias g ON g.id = cg.guia_id
      WHERE cd.estado = 'CERRADO'
        AND cd.fecha BETWEEN $1::date AND $2::date
      ORDER BY cd.fecha ASC, g.id ASC;
      `,
      [desde, hasta]
    );

    const guias = q.rows;

    // 2) Contar volumen por "agencia que despacha" (sucursal_origen) y servicio_tipo
    const key = (row) => `${row.sucursal_origen_id}|${row.servicio_tipo}`;
    const counts = new Map();
    for (const g of guias) {
      const k = key(g);
      counts.set(k, (counts.get(k) || 0) + 1);
    }

    // 3) Armar lista de movimientos (para dry run)
    const planned = [];
    for (const g of guias) {
      const pagoEn = g.tipo_cobro === "DESTINO" ? "DESTINO" : "ORIGEN";
      const sucursalCobra =
        pagoEn === "DESTINO" ? Number(g.sucursal_destino_id) : Number(g.sucursal_origen_id);

      const sucursalDespacha = Number(g.sucursal_origen_id); // agencia despachante
      const montoEnvio = round2(g.monto_envio);
      const montoSeguro = round2(g.monto_seguro);
      const iva = round2(g.iva_monto);

      // COBRO_ENVIO (haber) — base comisionable
      if (montoEnvio > 0) {
        planned.push({
          sucursal_id: sucursalCobra,
          fecha: g.fecha_cierre,
          tipo: "COBRO_ENVIO",
          guia_id: Number(g.guia_id),
          debe: 0,
          haber: montoEnvio,
          detalle: JSON.stringify({
            pago_en: pagoEn,
            servicio_tipo: g.servicio_tipo,
            fecha_cierre: g.fecha_cierre,
            nota: "Ingreso comisionable (monto_envio = envío + domicilio si aplica).",
          }),
        });
      }

      // IVA (haber) — 100% EXR
      if (iva > 0) {
        planned.push({
          sucursal_id: sucursalCobra,
          fecha: g.fecha_cierre,
          tipo: "IVA",
          guia_id: Number(g.guia_id),
          debe: 0,
          haber: iva,
          detalle: JSON.stringify({
            pago_en: pagoEn,
            fecha_cierre: g.fecha_cierre,
            alicuota: 0.21,
            nota: "IVA 21% 100% EXR (no comisiona).",
          }),
        });
      }

      // SEGURO (haber) — 100% EXR
      if (montoSeguro > 0) {
        planned.push({
          sucursal_id: sucursalCobra,
          fecha: g.fecha_cierre,
          tipo: "SEGURO",
          guia_id: Number(g.guia_id),
          debe: 0,
          haber: montoSeguro,
          detalle: JSON.stringify({
            pago_en: pagoEn,
            fecha_cierre: g.fecha_cierre,
            nota: "Seguro 100% EXR (no comisiona).",
          }),
        });
      }

      // COMISION doble partida (sobre monto_envio, sin IVA ni seguro)
      const cant = counts.get(key(g)) || 0;
      let pct = 0;
      if (g.servicio_tipo === "ECONOMICO") pct = pctEcoByCount(cant);
      if (g.servicio_tipo === "PREMIUM") pct = pctPremiumByCount(cant);

      const comision = round2(montoEnvio * pct);
      if (comision > 0) {
        // 1) COMISION_PAGADA (DEBE) en cobradora
        planned.push({
          sucursal_id: sucursalCobra,
          fecha: g.fecha_cierre,
          tipo: "COMISION_PAGADA",
          guia_id: Number(g.guia_id),
          debe: comision,
          haber: 0,
          detalle: JSON.stringify({
            pago_en: pagoEn,
            fecha_cierre: g.fecha_cierre,
            periodo: { desde, hasta },
            servicio_tipo: g.servicio_tipo,
            cant_periodo: cant,
            pct,
            base: montoEnvio,
            contraparte_sucursal_id: sucursalDespacha,
            nota: "Comisión pagada por la sucursal cobradora. Base=monto_envio (sin IVA/seguro).",
          }),
        });

        // 2) COMISION_RECIBIDA (HABER) en despachante
        planned.push({
          sucursal_id: sucursalDespacha,
          fecha: g.fecha_cierre,
          tipo: "COMISION_RECIBIDA",
          guia_id: Number(g.guia_id),
          debe: 0,
          haber: comision,
          detalle: JSON.stringify({
            pago_en: pagoEn,
            fecha_cierre: g.fecha_cierre,
            periodo: { desde, hasta },
            servicio_tipo: g.servicio_tipo,
            cant_periodo: cant,
            pct,
            base: montoEnvio,
            contraparte_sucursal_id: sucursalCobra,
            nota: "Comisión recibida por la sucursal despachante. Contraparte=sucursal cobradora.",
          }),
        });
      }
    }

    if (dry) {
      await client.query("ROLLBACK");
      return res.json({
        ok: true,
        dry: true,
        rango_cierres: { desde, hasta },
        guias: guias.length,
        planned: planned.length,
        sample: planned.slice(0, 25),
      });
    }

    // 4) Insertar idempotente (sin duplicar por guia+tipo)
    let inserted = 0;
    let skipped = 0;

    for (const mov of planned) {
      const ok = await insertMovimientoIdempotente(client, mov);
      if (ok) inserted++;
      else skipped++;
    }

    await client.query("COMMIT");
    return res.json({
      ok: true,
      rango_cierres: { desde, hasta },
      guias: guias.length,
      planned: planned.length,
      inserted,
      skipped_idempotencia: skipped,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[FIN] /sync error:", e);
    return res.status(500).json({ ok: false, error: "server_error", detail: e.message });
  } finally {
    client.release();
  }
});

/* =========================
   A) Lecturas
========================= */

/**
 * GET /interno/finanzas/saldos
 * Saldo por sucursal = SUM(haber) - SUM(debe)
 */
router.get("/saldos", async (req, res) => {
  try {
    const q = await pool.query(
      `
      SELECT
        s.id AS sucursal_id,
        s.nombre AS sucursal_nombre,
        COALESCE(SUM(m.haber),0) AS total_haber,
        COALESCE(SUM(m.debe),0) AS total_debe,
        COALESCE(SUM(m.haber),0) - COALESCE(SUM(m.debe),0) AS saldo
      FROM public.sucursales s
      LEFT JOIN public.movimientos_agencia m
        ON m.sucursal_id = s.id
      GROUP BY s.id, s.nombre
      ORDER BY s.id;
      `
    );

    return res.json({ ok: true, rows: q.rows });
  } catch (e) {
    console.error("[FIN] /saldos error:", e);
    return res.status(500).json({ ok: false, error: "server_error", detail: e.message });
  }
});

/**
 * GET /interno/finanzas/pendientes
 * Movimientos no liquidados (liquidacion_id IS NULL)
 */
router.get("/pendientes", async (req, res) => {
  try {
    const q = await pool.query(
      `
      SELECT
        m.id,
        m.sucursal_id,
        s.nombre AS sucursal_nombre,
        m.fecha,
        m.tipo,
        m.guia_id,
        m.debe,
        m.haber,
        m.detalle,
        m.creado_en
      FROM public.movimientos_agencia m
      JOIN public.sucursales s ON s.id = m.sucursal_id
      WHERE m.liquidacion_id IS NULL
      ORDER BY m.fecha DESC, m.id DESC
      LIMIT 500;
      `
    );

    return res.json({ ok: true, rows: q.rows });
  } catch (e) {
    console.error("[FIN] /pendientes error:", e);
    return res.status(500).json({ ok: false, error: "server_error", detail: e.message });
  }
});

/* =========================
   B) Motor de Liquidaciones
========================= */

/**
 * POST /interno/finanzas/liquidaciones/generar
 * body: { sucursal_id, fecha_desde, fecha_hasta }
 *
 * 1) crea liquidación ABIERTA
 * 2) toma movimientos pendientes del rango y los "asigna" (set liquidacion_id)
 * 3) crea detalle (liquidaciones_detalle)
 * 4) recalcula totales
 */
router.post("/liquidaciones/generar", async (req, res) => {
  const sucursal_id = asInt(req.body?.sucursal_id);
  const fecha_desde = asDate(req.body?.fecha_desde);
  const fecha_hasta = asDate(req.body?.fecha_hasta);

  if (!Number.isFinite(sucursal_id) || !fecha_desde || !fecha_hasta) {
    return res.status(400).json({
      ok: false,
      error: "Datos inválidos. Requiere sucursal_id (int), fecha_desde y fecha_hasta (YYYY-MM-DD).",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) crear liquidación
    const liqIns = await client.query(
      `
      INSERT INTO public.liquidaciones (sucursal_id, fecha_desde, fecha_hasta, estado)
      VALUES ($1, $2, $3, 'ABIERTA')
      RETURNING id, sucursal_id, fecha_desde, fecha_hasta, estado, creado_en;
      `,
      [sucursal_id, fecha_desde, fecha_hasta]
    );
    const liq = liqIns.rows[0];

    // 2) tomar movimientos pendientes (lock para evitar doble liquidación en concurrencia)
    const movs = await client.query(
      `
      SELECT id, sucursal_id, fecha, tipo, guia_id, debe, haber, detalle
      FROM public.movimientos_agencia
      WHERE sucursal_id = $1
        AND liquidacion_id IS NULL
        AND fecha BETWEEN $2 AND $3
      ORDER BY fecha ASC, id ASC
      FOR UPDATE;
      `,
      [sucursal_id, fecha_desde, fecha_hasta]
    );

    // 3) asignar movimientos + insertar detalle
    if (movs.rows.length) {
      const ids = movs.rows.map((r) => r.id);

      await client.query(
        `
        UPDATE public.movimientos_agencia
        SET liquidacion_id = $1, liquidado_en = now()
        WHERE id = ANY($2::bigint[]);
        `,
        [liq.id, ids]
      );

      // Insert detalle (1 fila por movimiento)
      await client.query(
        `
        INSERT INTO public.liquidaciones_detalle
          (liquidacion_id, movimiento_id, guia_id, tipo, debe, haber, fecha, detalle)
        SELECT
          $1 AS liquidacion_id,
          m.id AS movimiento_id,
          m.guia_id,
          m.tipo,
          m.debe,
          m.haber,
          m.fecha,
          m.detalle
        FROM public.movimientos_agencia m
        WHERE m.id = ANY($2::bigint[]);
        `,
        [liq.id, ids]
      );
    }

    // 4) recalcular totales
    const tot = await client.query(
      `
      SELECT
        COALESCE(SUM(debe),0) AS total_debe,
        COALESCE(SUM(haber),0) AS total_haber
      FROM public.liquidaciones_detalle
      WHERE liquidacion_id = $1;
      `,
      [liq.id]
    );

    const total_debe = Number(tot.rows[0].total_debe || 0);
    const total_haber = Number(tot.rows[0].total_haber || 0);
    const saldo = total_haber - total_debe;

    await client.query(
      `
      UPDATE public.liquidaciones
      SET total_debe=$2, total_haber=$3, saldo=$4
      WHERE id=$1;
      `,
      [liq.id, total_debe, total_haber, saldo]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      liquidacion: { ...liq, total_debe, total_haber, saldo },
      movimientos_asignados: movs.rows.length,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[FIN] /liquidaciones/generar error:", e);
    return res.status(500).json({ ok: false, error: "server_error", detail: e.message });
  } finally {
    client.release();
  }
});

/**
 * GET /interno/finanzas/liquidaciones/:id
 * Devuelve cabecera + detalle
 */
router.get("/liquidaciones/:id", async (req, res) => {
  const id = asInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "ID inválido" });

  try {
    const cab = await pool.query(`SELECT * FROM public.liquidaciones WHERE id=$1;`, [id]);
    if (!cab.rows.length) return res.status(404).json({ ok: false, error: "No existe liquidación" });

    const det = await pool.query(
      `
      SELECT *
      FROM public.liquidaciones_detalle
      WHERE liquidacion_id=$1
      ORDER BY fecha ASC, id ASC;
      `,
      [id]
    );

    return res.json({ ok: true, liquidacion: cab.rows[0], detalle: det.rows });
  } catch (e) {
    console.error("[FIN] /liquidaciones/:id error:", e);
    return res.status(500).json({ ok: false, error: "server_error", detail: e.message });
  }
});

/**
 * POST /interno/finanzas/liquidaciones/:id/cerrar
 * Cierra una liquidación ABIERTA (no permite reabrir acá)
 */
router.post("/liquidaciones/:id/cerrar", async (req, res) => {
  const id = asInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "ID inválido" });

  try {
    const r = await pool.query(`SELECT id, estado FROM public.liquidaciones WHERE id=$1;`, [id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "No existe liquidación" });

    if (String(r.rows[0].estado || "").toUpperCase() !== "ABIERTA") {
      return res.status(400).json({ ok: false, error: "La liquidación no está ABIERTA" });
    }

    await pool.query(
      `
      UPDATE public.liquidaciones
      SET estado='CERRADA', cerrado_en=now()
      WHERE id=$1;
      `,
      [id]
    );

    const cab = await pool.query(`SELECT * FROM public.liquidaciones WHERE id=$1;`, [id]);
    return res.json({ ok: true, liquidacion: cab.rows[0] });
  } catch (e) {
    console.error("[FIN] /liquidaciones/:id/cerrar error:", e);
    return res.status(500).json({ ok: false, error: "server_error", detail: e.message });
  }
});

module.exports = router;