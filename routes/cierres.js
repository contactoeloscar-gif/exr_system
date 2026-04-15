// routes/cierres.js
const express = require("express");
const router = express.Router();

const pool = require("../config/db");
const { isOwnerOrAdmin } = require("../middleware/roles");

function isYMD(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

function norm(v) {
  return String(v || "").trim().toUpperCase();
}

function hasOperativeRole(req) {
  const rol = norm(req.user?.rol);
  return ["OWNER", "ADMIN", "OPERADOR"].includes(rol);
}

function getUserSucursalId(req) {
  const s = Number(req.user?.sucursal_id);
  return Number.isFinite(s) && s > 0 ? s : null;
}

async function sucursalExiste(db, sucursalId) {
  const r = await db.query(
    `SELECT id, codigo, nombre FROM public.sucursales WHERE id = $1 LIMIT 1`,
    [sucursalId]
  );
  return r.rows[0] || null;
}

async function getSucursales(db) {
  const r = await db.query(`
    SELECT id, codigo, nombre
    FROM public.sucursales
    ORDER BY id
  `);
  return r.rows || [];
}

async function getCierresDelDia(db, fecha) {
  const r = await db.query(
    `
    SELECT
      id,
      fecha,
      scope_modo,
      sucursal_id,
      estado,
      cantidad_pagadas,
      cantidad_ce_pendiente,
      total_entregadas,
      creado_por_user_id,
      creado_por_usuario,
      creado_en,
      cerrado_en
    FROM public.cierres_diarios
    WHERE fecha = $1
    ORDER BY scope_modo, sucursal_id, id
    `,
    [fecha]
  );
  return r.rows || [];
}

async function getPreviewData(db, { fecha, scope_modo, sucursal_id }) {
  if (scope_modo === "GLOBAL") {
    const r = await db.query(
      `
      SELECT
        COALESCE(SUM(cantidad_pagadas), 0)::int AS cantidad_pagadas,
        COALESCE(SUM(cantidad_ce_pendiente), 0)::int AS cantidad_ce_pendiente,
        COALESCE(SUM(total_entregadas), 0)::int AS total_entregadas
      FROM public.cierres_diarios
      WHERE fecha = $1
        AND scope_modo = 'SUCURSAL'
        AND estado = 'CERRADO'
      `,
      [fecha]
    );

    return {
      fecha,
      scope_modo,
      sucursal_id: 0,
      guias: [],
      totales: {
        cantidad_pagadas: Number(r.rows[0]?.cantidad_pagadas || 0),
        cantidad_ce_pendiente: Number(r.rows[0]?.cantidad_ce_pendiente || 0),
        total_entregadas: Number(r.rows[0]?.total_entregadas || 0),
        total_bultos: 0,
      },
    };
  }

  const guiasR = await db.query(
    `
    SELECT
      g.id,
      g.numero_guia,
      g.estado_logistico,
      g.estado_pago,
      g.sucursal_origen_id,
      g.sucursal_destino_id,
      g.remitente_nombre,
      g.destinatario_nombre,
      g.destinatario_direccion,
      COALESCE(SUM(gi.cantidad), 0)::int AS cant_bultos
    FROM public.guias g
    LEFT JOIN public.cierres_guias cg ON cg.guia_id = g.id
    LEFT JOIN public.guia_items gi ON gi.guia_id = g.id
    WHERE g.estado_logistico = 'RECIBIDO_ORIGEN'
      AND g.sucursal_origen_id = $1
      AND cg.guia_id IS NULL
    GROUP BY
      g.id,
      g.numero_guia,
      g.estado_logistico,
      g.estado_pago,
      g.sucursal_origen_id,
      g.sucursal_destino_id,
      g.remitente_nombre,
      g.destinatario_nombre,
      g.destinatario_direccion
    ORDER BY g.id DESC
    `,
    [sucursal_id]
  );

  const rows = guiasR.rows || [];

  const cantidad_pagadas = rows.filter(
    (r) => norm(r.estado_pago) === "PAGADO"
  ).length;

  const cantidad_ce_pendiente = rows.filter(
    (r) => norm(r.estado_pago) === "CONTRA_ENTREGA"
  ).length;

  const total_entregadas = rows.length;
  const total_bultos = rows.reduce((acc, r) => acc + Number(r.cant_bultos || 0), 0);

  return {
    fecha,
    scope_modo,
    sucursal_id,
    guias: rows,
    totales: {
      cantidad_pagadas,
      cantidad_ce_pendiente,
      total_entregadas,
      total_bultos,
    },
  };
}

async function ensureOpenOrCreateCierre(
  client,
  { fecha, scope_modo, sucursal_id, userId, usuario }
) {
  const up = await client.query(
    `
    INSERT INTO public.cierres_diarios
      (
        fecha,
        scope_modo,
        sucursal_id,
        cantidad_pagadas,
        cantidad_ce_pendiente,
        total_entregadas,
        creado_por_user_id,
        creado_por_usuario,
        estado,
        creado_en
      )
    VALUES
      (
        $1, $2, $3,
        0, 0, 0,
        $4, $5,
        'ABIERTO', now()
      )
    ON CONFLICT (fecha, scope_modo, sucursal_id)
    DO UPDATE SET
      fecha = EXCLUDED.fecha
    RETURNING id, estado
    `,
    [fecha, scope_modo, sucursal_id, userId, usuario]
  );

  const cierreId = up.rows[0]?.id;
  const estadoActual = norm(up.rows[0]?.estado);

  if (!cierreId) {
    throw new Error("No se pudo crear/obtener el cierre");
  }

  if (estadoActual === "CERRADO") {
    const err = new Error("El cierre ya está CERRADO para esa fecha/scope/sucursal");
    err.httpStatus = 409;
    throw err;
  }

  return cierreId;
}

async function validarGlobalPermitido(client, fecha) {
  const sucursales = await getSucursales(client);
  const ids = sucursales.map((s) => Number(s.id)).filter(Boolean);

  const cR = await client.query(
    `
    SELECT sucursal_id
    FROM public.cierres_diarios
    WHERE fecha = $1
      AND scope_modo = 'SUCURSAL'
      AND estado = 'CERRADO'
    ORDER BY sucursal_id
    `,
    [fecha]
  );

  const cerradas = new Set((cR.rows || []).map((r) => Number(r.sucursal_id)));
  const faltantes = ids.filter((id) => !cerradas.has(id));

  return {
    ok: faltantes.length === 0,
    faltantes_sucursal_id: faltantes,
  };
}

async function insertarGuiasEnCierre(client, { cierreId, scope_modo, sucursal_id }) {
  if (scope_modo === "GLOBAL") {
    return [];
  }

  const ins = await client.query(
    `
    INSERT INTO public.cierres_guias (cierre_id, guia_id)
    SELECT $1, g.id
    FROM public.guias g
    LEFT JOIN public.cierres_guias cg ON cg.guia_id = g.id
    WHERE g.estado_logistico = 'RECIBIDO_ORIGEN'
      AND g.sucursal_origen_id = $2
      AND cg.guia_id IS NULL
    ON CONFLICT DO NOTHING
    RETURNING guia_id
    `,
    [cierreId, sucursal_id]
  );

  return ins.rows || [];
}

async function recalcularTotalesCierre(client, cierreId, scope_modo, fecha) {
  if (scope_modo === "GLOBAL") {
    const tot = await client.query(
      `
      SELECT
        COALESCE(SUM(cantidad_pagadas), 0)::int AS cantidad_pagadas,
        COALESCE(SUM(cantidad_ce_pendiente), 0)::int AS cantidad_ce_pendiente,
        COALESCE(SUM(total_entregadas), 0)::int AS total_entregadas
      FROM public.cierres_diarios
      WHERE fecha = $1
        AND scope_modo = 'SUCURSAL'
        AND estado = 'CERRADO'
      `,
      [fecha]
    );

    return {
      cantidad_pagadas: Number(tot.rows[0]?.cantidad_pagadas || 0),
      cantidad_ce_pendiente: Number(tot.rows[0]?.cantidad_ce_pendiente || 0),
      total_entregadas: Number(tot.rows[0]?.total_entregadas || 0),
    };
  }

  const tot = await client.query(
    `
    WITH g AS (
      SELECT g.estado_pago
      FROM public.cierres_guias cg
      JOIN public.guias g ON g.id = cg.guia_id
      WHERE cg.cierre_id = $1
    )
    SELECT
      SUM(CASE WHEN UPPER(COALESCE(estado_pago,'')) = 'PAGADO' THEN 1 ELSE 0 END)::int AS cantidad_pagadas,
      SUM(CASE WHEN UPPER(COALESCE(estado_pago,'')) = 'CONTRA_ENTREGA' THEN 1 ELSE 0 END)::int AS cantidad_ce_pendiente,
      COUNT(*)::int AS total_entregadas
    FROM g
    `,
    [cierreId]
  );

  return {
    cantidad_pagadas: Number(tot.rows[0]?.cantidad_pagadas || 0),
    cantidad_ce_pendiente: Number(tot.rows[0]?.cantidad_ce_pendiente || 0),
    total_entregadas: Number(tot.rows[0]?.total_entregadas || 0),
  };
}

/**
 * GET /interno/cierres/estado?fecha=YYYY-MM-DD
 * OWNER/ADMIN: estado global del día
 * OPERADOR: estado de su sucursal en el día
 */
router.get("/estado", async (req, res) => {
  if (!hasOperativeRole(req)) {
    return res.status(403).json({ ok: false, error: "Sin permisos" });
  }

  const fecha = isYMD(String(req.query?.fecha || ""))
    ? String(req.query.fecha)
    : todayYMD();

  try {
    const owner = !!isOwnerOrAdmin(req);

    if (owner) {
      const sucursales = await getSucursales(pool);
      const cierres = await getCierresDelDia(pool, fecha);

      const cerradasSucursal = new Set(
        cierres
          .filter(
            (r) => norm(r.scope_modo) === "SUCURSAL" && norm(r.estado) === "CERRADO"
          )
          .map((r) => Number(r.sucursal_id))
      );

      const faltantes = sucursales
        .map((s) => Number(s.id))
        .filter((id) => !cerradasSucursal.has(id));

      const global =
        cierres.find(
          (r) => norm(r.scope_modo) === "GLOBAL" && Number(r.sucursal_id) === 0
        ) || null;

      return res.json({
        ok: true,
        fecha,
        scope: "OWNER",
        sucursales,
        cierres,
        faltantes_sucursal_id: faltantes,
        global,
        global_permitido: faltantes.length === 0,
      });
    }

    const sucursal_id = getUserSucursalId(req);
    if (!sucursal_id) {
      return res.status(400).json({ ok: false, error: "Usuario sin sucursal_id válido" });
    }

    const sucursal = await sucursalExiste(pool, sucursal_id);
    if (!sucursal) {
      return res.status(404).json({ ok: false, error: "Sucursal no encontrada" });
    }

    const r = await pool.query(
      `
      SELECT
        id,
        fecha,
        scope_modo,
        sucursal_id,
        estado,
        cantidad_pagadas,
        cantidad_ce_pendiente,
        total_entregadas,
        creado_por_user_id,
        creado_por_usuario,
        creado_en,
        cerrado_en
      FROM public.cierres_diarios
      WHERE fecha = $1
        AND scope_modo = 'SUCURSAL'
        AND sucursal_id = $2
      ORDER BY id DESC
      LIMIT 1
      `,
      [fecha, sucursal_id]
    );

    return res.json({
      ok: true,
      fecha,
      scope: "SUCURSAL",
      sucursal,
      cierre: r.rows[0] || null,
    });
  } catch (e) {
    console.error("GET /interno/cierres/estado error:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

/**
 * GET /interno/cierres/preview?fecha=YYYY-MM-DD&scope_modo=SUCURSAL|GLOBAL&sucursal_id=#
 *
 * - OPERADOR: solo preview SUCURSAL de su propia sucursal
 * - OWNER/ADMIN: puede preview SUCURSAL de cualquier sucursal o GLOBAL
 */
router.get("/preview", async (req, res) => {
  if (!hasOperativeRole(req)) {
    return res.status(403).json({ ok: false, error: "Sin permisos" });
  }

  const owner = !!isOwnerOrAdmin(req);
  const fecha = isYMD(String(req.query?.fecha || ""))
    ? String(req.query.fecha)
    : todayYMD();

  const scope_modo = norm(req.query?.scope_modo || "SUCURSAL");
  if (!["SUCURSAL", "GLOBAL"].includes(scope_modo)) {
    return res.status(400).json({ ok: false, error: "scope_modo inválido (GLOBAL|SUCURSAL)" });
  }

  try {
    let sucursal_id = 0;

    if (scope_modo === "GLOBAL") {
      if (!owner) {
        return res.status(403).json({ ok: false, error: "Solo OWNER/ADMIN puede preview GLOBAL" });
      }

      const validacion = await validarGlobalPermitido(pool, fecha);
      const preview = await getPreviewData(pool, {
        fecha,
        scope_modo,
        sucursal_id: 0,
      });

      return res.json({
        ok: true,
        fecha,
        scope_modo,
        sucursal_id: 0,
        global_permitido: validacion.ok,
        faltantes_sucursal_id: validacion.faltantes_sucursal_id,
        ...preview,
      });
    }

    if (owner) {
      sucursal_id = Number(req.query?.sucursal_id);
      if (!sucursal_id || Number.isNaN(sucursal_id)) {
        return res.status(400).json({ ok: false, error: "sucursal_id inválido" });
      }
    } else {
      sucursal_id = getUserSucursalId(req);
      if (!sucursal_id) {
        return res.status(400).json({ ok: false, error: "Usuario sin sucursal_id válido" });
      }
    }

    const sucursal = await sucursalExiste(pool, sucursal_id);
    if (!sucursal) {
      return res.status(404).json({ ok: false, error: "Sucursal no encontrada" });
    }

    const preview = await getPreviewData(pool, {
      fecha,
      scope_modo: "SUCURSAL",
      sucursal_id,
    });

    return res.json({
      ok: true,
      fecha,
      scope_modo: "SUCURSAL",
      sucursal_id,
      sucursal,
      ...preview,
    });
  } catch (e) {
    console.error("GET /interno/cierres/preview error:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

/**
 * POST /interno/cierres/diario-sucursal/:sucursalId
 * Solo OWNER/ADMIN
 * QA / piloto / cierre forzado de una sucursal específica
 * body opcional: { fecha: "YYYY-MM-DD" }
 */
router.post("/diario-sucursal/:sucursalId", async (req, res) => {
  const owner = !!isOwnerOrAdmin(req);
  if (!owner) {
    return res.status(403).json({ ok: false, error: "Solo OWNER/ADMIN" });
  }

  const userId = req.user?.user_id ?? null;
  const usuario = req.user?.usuario ?? null;
  if (!userId) {
    return res.status(401).json({ ok: false, error: "No hay user_id en token" });
  }

  const fecha = isYMD(req.body?.fecha) ? req.body.fecha : todayYMD();

  const sucursal_id = Number(req.params.sucursalId);
  if (!sucursal_id || Number.isNaN(sucursal_id)) {
    return res.status(400).json({ ok: false, error: "sucursalId inválido" });
  }

  const s = await sucursalExiste(pool, sucursal_id);
  if (!s) {
    return res.status(404).json({ ok: false, error: "Sucursal no encontrada" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cierreId = await ensureOpenOrCreateCierre(client, {
      fecha,
      scope_modo: "SUCURSAL",
      sucursal_id,
      userId,
      usuario,
    });

    const preview = await getPreviewData(client, {
      fecha,
      scope_modo: "SUCURSAL",
      sucursal_id,
    });

    const insertadas = await insertarGuiasEnCierre(client, {
      cierreId,
      scope_modo: "SUCURSAL",
      sucursal_id,
    });

    const totales = await recalcularTotalesCierre(client, cierreId, "SUCURSAL", fecha);

    await client.query(
      `
      UPDATE public.cierres_diarios
      SET estado = 'CERRADO',
          cerrado_en = now(),
          cantidad_pagadas = $2,
          cantidad_ce_pendiente = $3,
          total_entregadas = $4
      WHERE id = $1
      `,
      [
        cierreId,
        totales.cantidad_pagadas,
        totales.cantidad_ce_pendiente,
        totales.total_entregadas,
      ]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      cierre_id: cierreId,
      fecha,
      scope_modo: "SUCURSAL",
      sucursal_id,
      preview_totales: preview.totales,
      guias_incluidas: insertadas.length,
      totales,
      sample: insertadas.slice(0, 10).map((r) => r.guia_id),
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /interno/cierres/diario-sucursal error:", e);
    return res.status(e.httpStatus || 500).json({ ok: false, error: e.message || "Error interno" });
  } finally {
    client.release();
  }
});

/**
 * POST /interno/cierres/diario
 * body:
 * {
 *   fecha?: "YYYY-MM-DD",
 *   scope_modo?: "SUCURSAL"|"GLOBAL",
 *   sucursal_id?: number // solo OWNER/ADMIN si scope=SUCURSAL
 * }
 *
 * Reglas:
 * - SUCURSAL:
 *   - OPERADOR: solo su propia sucursal
 *   - OWNER/ADMIN: su sucursal o una sucursal indicada
 * - GLOBAL:
 *   - solo OWNER/ADMIN
 *   - requiere que todas las sucursales tengan cierre SUCURSAL del día
 */
router.post("/diario", async (req, res) => {
  if (!hasOperativeRole(req)) {
    return res.status(403).json({ ok: false, error: "Sin permisos" });
  }

  const owner = !!isOwnerOrAdmin(req);
  const userId = req.user?.user_id ?? null;
  const usuario = req.user?.usuario ?? null;

  if (!userId) {
    return res.status(401).json({ ok: false, error: "No hay user_id en token" });
  }

  const fecha = isYMD(req.body?.fecha) ? req.body.fecha : todayYMD();
  const scope_modo = norm(req.body?.scope_modo || "SUCURSAL");

  if (!["GLOBAL", "SUCURSAL"].includes(scope_modo)) {
    return res.status(400).json({ ok: false, error: "scope_modo inválido (GLOBAL|SUCURSAL)" });
  }

  let sucursal_id = 0;

  try {
    if (scope_modo === "GLOBAL") {
      if (!owner) {
        return res.status(403).json({ ok: false, error: "Solo OWNER/ADMIN puede cerrar GLOBAL" });
      }
      sucursal_id = 0;
    } else {
      if (owner) {
        const bodySucursal = Number(req.body?.sucursal_id);
        const tokenSucursal = getUserSucursalId(req);

        sucursal_id =
          Number.isFinite(bodySucursal) && bodySucursal > 0
            ? bodySucursal
            : tokenSucursal;

        if (!sucursal_id) {
          return res.status(400).json({ ok: false, error: "sucursal_id inválido" });
        }
      } else {
        sucursal_id = getUserSucursalId(req);
        if (!sucursal_id) {
          return res.status(400).json({ ok: false, error: "Usuario sin sucursal_id válido" });
        }
      }

      const s = await sucursalExiste(pool, sucursal_id);
      if (!s) {
        return res.status(404).json({ ok: false, error: "Sucursal no encontrada" });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (scope_modo === "GLOBAL") {
        const validacion = await validarGlobalPermitido(client, fecha);
        if (!validacion.ok) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            ok: false,
            error: "No se puede cerrar GLOBAL: faltan cierres SUCURSAL del día",
            fecha,
            faltantes_sucursal_id: validacion.faltantes_sucursal_id,
          });
        }
      }

      const cierreId = await ensureOpenOrCreateCierre(client, {
        fecha,
        scope_modo,
        sucursal_id,
        userId,
        usuario,
      });

      const preview = await getPreviewData(client, {
        fecha,
        scope_modo,
        sucursal_id,
      });

      const insertadas = await insertarGuiasEnCierre(client, {
        cierreId,
        scope_modo,
        sucursal_id,
      });

      const totales = await recalcularTotalesCierre(client, cierreId, scope_modo, fecha);

      await client.query(
        `
        UPDATE public.cierres_diarios
        SET estado = 'CERRADO',
            cerrado_en = now(),
            cantidad_pagadas = $2,
            cantidad_ce_pendiente = $3,
            total_entregadas = $4
        WHERE id = $1
        `,
        [
          cierreId,
          totales.cantidad_pagadas,
          totales.cantidad_ce_pendiente,
          totales.total_entregadas,
        ]
      );

      await client.query("COMMIT");

      return res.json({
        ok: true,
        cierre_id: cierreId,
        fecha,
        scope_modo,
        sucursal_id,
        preview_totales: preview.totales,
        guias_incluidas: insertadas.length,
        totales,
        sample: insertadas.slice(0, 10).map((r) => r.guia_id),
      });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("POST /interno/cierres/diario error:", e);
      return res.status(e.httpStatus || 500).json({ ok: false, error: e.message || "Error interno" });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("POST /interno/cierres/diario outer error:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

/**
 * GET /interno/cierres/listado
 * Query:
 * - desde=YYYY-MM-DD
 * - hasta=YYYY-MM-DD
 * - scope_modo=GLOBAL|SUCURSAL
 * - estado=ABIERTO|CERRADO
 * - sucursal_id=#
 * - limit=100
 * - offset=0
 */
router.get("/listado", async (req, res) => {
  if (!hasOperativeRole(req)) {
    return res.status(403).json({ ok: false, error: "Sin permisos" });
  }

  const owner = !!isOwnerOrAdmin(req);
  const mySuc = getUserSucursalId(req);

  const desde = isYMD(String(req.query?.desde || "")) ? String(req.query.desde) : null;
  const hasta = isYMD(String(req.query?.hasta || "")) ? String(req.query.hasta) : null;
  const scope_modo = norm(req.query?.scope_modo || "");
  const estado = norm(req.query?.estado || "");
  const qSucursal = Number(req.query?.sucursal_id);
  const limit = Math.min(Math.max(Number(req.query?.limit || 100), 1), 500);
  const offset = Math.max(Number(req.query?.offset || 0), 0);

  try {
    const where = [];
    const params = [];

    if (desde) {
      params.push(desde);
      where.push(`c.fecha >= $${params.length}`);
    }

    if (hasta) {
      params.push(hasta);
      where.push(`c.fecha <= $${params.length}`);
    }

    if (scope_modo && ["GLOBAL", "SUCURSAL"].includes(scope_modo)) {
      params.push(scope_modo);
      where.push(`UPPER(c.scope_modo) = $${params.length}`);
    }

    if (estado && ["ABIERTO", "CERRADO"].includes(estado)) {
      params.push(estado);
      where.push(`UPPER(c.estado) = $${params.length}`);
    }

    if (owner) {
      if (Number.isFinite(qSucursal) && qSucursal > 0) {
        params.push(qSucursal);
        where.push(`c.sucursal_id = $${params.length}`);
      }
    } else {
      if (!mySuc) {
        return res.status(400).json({ ok: false, error: "Usuario sin sucursal_id válido" });
      }
      where.push(`(UPPER(c.scope_modo) = 'SUCURSAL' AND c.sucursal_id = ${Number(mySuc)})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const totalR = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM public.cierres_diarios c
      ${whereSql}
      `,
      params
    );

    const paramsData = [...params];
    paramsData.push(limit);
    const pLimit = `$${paramsData.length}`;
    paramsData.push(offset);
    const pOffset = `$${paramsData.length}`;

    const rowsR = await pool.query(
      `
      SELECT
        c.id,
        c.fecha,
        c.scope_modo,
        c.sucursal_id,
        c.estado,
        c.cantidad_pagadas,
        c.cantidad_ce_pendiente,
        c.total_entregadas,
        c.creado_por_usuario,
        c.creado_en,
        c.cerrado_en,
        s.codigo AS sucursal_codigo,
        s.nombre AS sucursal_nombre
      FROM public.cierres_diarios c
      LEFT JOIN public.sucursales s ON s.id = c.sucursal_id
      ${whereSql}
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT ${pLimit} OFFSET ${pOffset}
      `,
      paramsData
    );

    return res.json({
      ok: true,
      total: Number(totalR.rows[0]?.total || 0),
      limit,
      offset,
      rows: rowsR.rows || [],
    });
  } catch (e) {
    console.error("GET /interno/cierres/listado error:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

/**
 * GET /interno/cierres/:id
 * Detalle completo de un cierre
 */
router.get("/:id", async (req, res) => {
  if (!hasOperativeRole(req)) {
    return res.status(403).json({ ok: false, error: "Sin permisos" });
  }

  const cierreId = Number(req.params.id);
  if (!cierreId || Number.isNaN(cierreId)) {
    return res.status(400).json({ ok: false, error: "id inválido" });
  }

  try {
    const cabR = await pool.query(
      `
      SELECT
        c.id,
        c.fecha,
        c.scope_modo,
        c.sucursal_id,
        c.estado,
        c.cantidad_pagadas,
        c.cantidad_ce_pendiente,
        c.total_entregadas,
        c.creado_por_user_id,
        c.creado_por_usuario,
        c.creado_en,
        c.cerrado_en,
        s.codigo AS sucursal_codigo,
        s.nombre AS sucursal_nombre
      FROM public.cierres_diarios c
      LEFT JOIN public.sucursales s ON s.id = c.sucursal_id
      WHERE c.id = $1
      LIMIT 1
      `,
      [cierreId]
    );

    if (!cabR.rows.length) {
      return res.status(404).json({ ok: false, error: "Cierre no encontrado" });
    }

    const cierre = cabR.rows[0];
    const owner = !!isOwnerOrAdmin(req);

    if (!owner && norm(cierre.scope_modo) === "SUCURSAL") {
      const mySuc = getUserSucursalId(req);
      if (!mySuc || Number(mySuc) !== Number(cierre.sucursal_id)) {
        return res.status(403).json({ ok: false, error: "Sin permisos para este cierre" });
      }
    }

    let detalle = [];
    let total_bultos = 0;

    if (norm(cierre.scope_modo) === "SUCURSAL") {
      const detR = await pool.query(
        `
        SELECT
          g.id,
          g.numero_guia,
          g.estado_logistico,
          g.estado_pago,
          g.remitente_nombre,
          g.destinatario_nombre,
          g.destinatario_direccion,
          g.sucursal_origen_id,
          g.sucursal_destino_id,
          COALESCE(SUM(gi.cantidad), 0)::int AS cant_bultos
        FROM public.cierres_guias cg
        JOIN public.guias g ON g.id = cg.guia_id
        LEFT JOIN public.guia_items gi ON gi.guia_id = g.id
        WHERE cg.cierre_id = $1
        GROUP BY
          g.id,
          g.numero_guia,
          g.estado_logistico,
          g.estado_pago,
          g.remitente_nombre,
          g.destinatario_nombre,
          g.destinatario_direccion,
          g.sucursal_origen_id,
          g.sucursal_destino_id
        ORDER BY g.numero_guia ASC, g.id ASC
        `,
        [cierreId]
      );

      detalle = detR.rows || [];
      total_bultos = detalle.reduce((acc, r) => acc + Number(r.cant_bultos || 0), 0);
    }

    return res.json({
      ok: true,
      cierre,
      detalle,
      resumen: {
        cantidad_pagadas: Number(cierre.cantidad_pagadas || 0),
        cantidad_ce_pendiente: Number(cierre.cantidad_ce_pendiente || 0),
        total_entregadas: Number(cierre.total_entregadas || 0),
        total_bultos,
      },
    });
  } catch (e) {
    console.error("GET /interno/cierres/:id error:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

/**
 * GET /interno/cierres/:id/comprobante
 * Devuelve payload listo para la vista imprimible
 */
router.get("/:id/comprobante", async (req, res) => {
  if (!hasOperativeRole(req)) {
    return res.status(403).json({ ok: false, error: "Sin permisos" });
  }

  const cierreId = Number(req.params.id);
  if (!cierreId || Number.isNaN(cierreId)) {
    return res.status(400).json({ ok: false, error: "id inválido" });
  }

  try {
    const cabR = await pool.query(
      `
      SELECT
        c.id,
        c.fecha,
        c.scope_modo,
        c.sucursal_id,
        c.estado,
        c.cantidad_pagadas,
        c.cantidad_ce_pendiente,
        c.total_entregadas,
        c.creado_por_user_id,
        c.creado_por_usuario,
        c.creado_en,
        c.cerrado_en,
        s.codigo AS sucursal_codigo,
        s.nombre AS sucursal_nombre
      FROM public.cierres_diarios c
      LEFT JOIN public.sucursales s ON s.id = c.sucursal_id
      WHERE c.id = $1
      LIMIT 1
      `,
      [cierreId]
    );

    if (!cabR.rows.length) {
      return res.status(404).json({ ok: false, error: "Cierre no encontrado" });
    }

    const cierre = cabR.rows[0];
    const owner = !!isOwnerOrAdmin(req);

    if (!owner && norm(cierre.scope_modo) === "SUCURSAL") {
      const mySuc = getUserSucursalId(req);
      if (!mySuc || Number(mySuc) !== Number(cierre.sucursal_id)) {
        return res.status(403).json({ ok: false, error: "Sin permisos para este cierre" });
      }
    }

    let detalle = [];
    let total_bultos = 0;

    if (norm(cierre.scope_modo) === "SUCURSAL") {
      const detR = await pool.query(
        `
        SELECT
          g.id,
          g.numero_guia,
          g.estado_logistico,
          g.estado_pago,
          g.remitente_nombre,
          g.destinatario_nombre,
          g.destinatario_direccion,
          COALESCE(SUM(gi.cantidad), 0)::int AS cant_bultos
        FROM public.cierres_guias cg
        JOIN public.guias g ON g.id = cg.guia_id
        LEFT JOIN public.guia_items gi ON gi.guia_id = g.id
        WHERE cg.cierre_id = $1
        GROUP BY
          g.id,
          g.numero_guia,
          g.estado_logistico,
          g.estado_pago,
          g.remitente_nombre,
          g.destinatario_nombre,
          g.destinatario_direccion
        ORDER BY g.numero_guia ASC, g.id ASC
        `,
        [cierreId]
      );

      detalle = detR.rows || [];
      total_bultos = detalle.reduce((acc, r) => acc + Number(r.cant_bultos || 0), 0);
    }

    return res.json({
      ok: true,
      comprobante: {
        cierre_id: cierre.id,
        fecha: cierre.fecha,
        scope_modo: cierre.scope_modo,
        estado: cierre.estado,
        sucursal_id: cierre.sucursal_id,
        sucursal_codigo: cierre.sucursal_codigo,
        sucursal_nombre: cierre.sucursal_nombre,
        creado_por_usuario: cierre.creado_por_usuario,
        creado_en: cierre.creado_en,
        cerrado_en: cierre.cerrado_en,
        resumen: {
          cantidad_pagadas: Number(cierre.cantidad_pagadas || 0),
          cantidad_ce_pendiente: Number(cierre.cantidad_ce_pendiente || 0),
          total_entregadas: Number(cierre.total_entregadas || 0),
          total_bultos,
        },
        detalle,
      },
    });
  } catch (e) {
    console.error("GET /interno/cierres/:id/comprobante error:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

module.exports = router;