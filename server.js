// server.js (EXR-P17.1) — CORREGIDO + PRO (listo para pegar)
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const pool = require("./config/db");
const cobrosRoutes = require("./routes/cobros");
const { attachEstadoDerivadoMany } = require("./services/guiaEstadoDerivado.service");

const authMod = require("./middleware/auth");
const auth = authMod.auth || authMod;

const rateLimit = require("express-rate-limit");
const QRCode = require("qrcode");
const crypto = require("crypto");

/* ============================
   CACHE BANDEJA (RAM)
============================ */
const bandejaCache = new Map();

function cacheGet(key) {
  const hit = bandejaCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    bandejaCache.delete(key);
    return null;
  }
  return hit.val;
}

function cacheSet(key, val, ttlMs) {
  bandejaCache.set(key, { val, exp: Date.now() + ttlMs });
}

function cacheClearBandeja() {
  bandejaCache.clear();
}

/* ============================
   APP
============================ */
const app = express();

// IMPORTANT: desactiva el ETag automático de Express (W/"...") para usar el nuestro.
app.set("etag", false);

const IS_PROD = process.env.NODE_ENV === "production";

function log(...args) {
  if (!IS_PROD) console.log(...args);
}

function logErr(...args) {
  console.error(...args);
}

log("SERVER FILE:", __filename);

const SERVER_BOOT_AT = new Date().toISOString();

function loadRouteModule(routeFile) {
  const resolved = require.resolve(routeFile);
  delete require.cache[resolved];
  return {
    router: require(resolved),
    resolved,
    mtime: fs.statSync(resolved).mtime.toISOString(),
  };
}

/* ============================
   RUTAS PUBLICAS
============================ */
function mountPublic(basePath, routeFile) {
  try {
    const loaded = loadRouteModule(routeFile);
    log(`MONTANDO ${basePath} (public) -> ${routeFile}`);
    log(`ROUTE FILE: ${loaded.resolved}`);
    log(`ROUTE MTIME: ${loaded.mtime}`);
    app.use(basePath, loaded.router);
  } catch (e) {
    logErr(`ERROR cargando ${routeFile} para ${basePath}:`, e.message);
  }
}

/* ============================
   RUTAS INTERNAS (PROTEGIDAS)
============================ */
function mountProtected(basePath, routeFile) {
  try {
    const loaded = loadRouteModule(routeFile);
    log(`MONTANDO ${basePath} (protected) -> ${routeFile}`);
    log(`ROUTE FILE: ${loaded.resolved}`);
    log(`ROUTE MTIME: ${loaded.mtime}`);
    app.use(basePath, auth, loaded.router);
  } catch (e) {
    logErr(`ERROR cargando ${routeFile} para ${basePath}:`, e.message);
  }
}

/* ============================
   CORS + MIDDLEWARES BASE
============================ */
const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// fallback dev
const defaultOrigins = [
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: corsOrigins.length ? corsOrigins : defaultOrigins,
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

/* ============================
   STATIC
============================ */
const staticDir = path.join(__dirname, "public");
log("STATIC DIR:", staticDir);
app.use(express.static(staticDir));

// Forzar entrega de HTML (evita caer al 404 JSON si hay confusión/caché)
app.get("/etiqueta_batch.html", (_req, res) =>
  res.sendFile(path.join(staticDir, "etiqueta_batch.html"))
);
app.get("/etiqueta.html", (_req, res) =>
  res.sendFile(path.join(staticDir, "etiqueta.html"))
);
app.get("/cierres.html", (_req, res) =>
  res.sendFile(path.join(staticDir, "cierres.html"))
);
app.get("/cierre_comprobante.html", (_req, res) =>
  res.sendFile(path.join(staticDir, "cierre_comprobante.html"))
);
app.get("/cierres_historial.html", (_req, res) =>
  res.sendFile(path.join(staticDir, "cierres_historial.html"))
);
app.get("/contabilidad_agencias.html", (_req, res) =>
  res.sendFile(path.join(staticDir, "contabilidad_agencias.html"))
);

/* ============================
   INVALIDACIÓN CACHE BANDEJA
============================ */
app.use((req, res, next) => {
  const m = req.method.toUpperCase();
  const p = req.path;

  const mutatingMethod = ["POST", "PATCH", "PUT", "DELETE"].includes(m);

  const touchesBandeja =
    mutatingMethod &&
    (
      p === "/guias" ||
      p === "/guias/pago" ||
      p.startsWith("/guias/estado") ||
      p.startsWith("/interno/cobros") ||
      p.startsWith("/interno/contabilidad") ||
      p.startsWith("/interno/cierres") ||
      p.startsWith("/interno/lotes")
    );

  if (!touchesBandeja) return next();

  res.on("finish", () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      cacheClearBandeja();
    }
  });

  next();
});

/* ============================
   ETag helper
============================ */
function makeEtagForBandeja(payload) {
  const base = JSON.stringify({
    scope: payload.scope,
    sucursal_id: payload.sucursal_id,
    total: payload.total,
    export: payload.export,
    guias: (payload.guias || []).map((g) => [
      g.id,
      g.created_at,
      g.updated_at ?? null,
      g.estado_logistico,
      g.estado_pago,
      g.condicion_pago,
      g.tipo_cobro,
      g.metodo_pago,
      g.cobro_obligatorio_entrega,
      g.monto_cobrar_destino,
      g.cobrado_destino_at ?? null,
      g.rendido_at ?? null,
      g.cierre_id ?? null,
      g.cierre_estado_db ?? null,
      g.liquidacion_id ?? null,
      g.liquidacion_estado_db ?? null,
      g.conciliacion_id ?? null,
      g.conciliacion_estado_db ?? null,
    ]),
  });
  return crypto.createHash("sha1").update(base).digest("hex");
}

function parseIfNoneMatch(headerVal) {
  const inm = String(headerVal || "");
  return inm
    .split(",")
    .map((s) => s.trim())
    .map((s) => s.replace(/^W\//, "").replace(/"/g, ""))
    .filter(Boolean);
}

function pushEstadoPagoWhere(where, params, estado_pago) {
  const ep = String(estado_pago || "").trim().toLowerCase();
  if (!ep) return;

  if (ep === "pendiente") {
    where.push(`LOWER(COALESCE(g.estado_pago,'')) IN ('pendiente_origen','pendiente_destino')`);
    return;
  }

  if (ep === "pagado") {
    where.push(`LOWER(COALESCE(g.estado_pago,'')) IN ('cobrado_destino','rendido','pagado','pagado_origen','no_aplica')`);
    return;
  }

  if (ep === "pendiente_rendicion") {
    where.push(`LOWER(COALESCE(g.estado_pago,'')) = 'cobrado_destino' AND g.rendido_at IS NULL`);
    return;
  }

  if (ep === "rendido") {
    where.push(`LOWER(COALESCE(g.estado_pago,'')) IN ('cobrado_destino','rendido') AND g.rendido_at IS NOT NULL`);
    return;
  }

  if (ep === "observado") {
    where.push(`LOWER(COALESCE(g.estado_pago,'')) = 'observado'`);
    return;
  }

  params.push(ep);
  where.push(`LOWER(COALESCE(g.estado_pago,'')) = $${params.length}`);
}

function decorateBandejaRows(items) {
  return (items || []).map((g) => {
    const estadoPago = String(g.estado_pago || "").trim().toLowerCase();
    const tipoCobro = String(g.tipo_cobro || "").trim().toUpperCase();
    const condicionPago = String(g.condicion_pago || "").trim().toUpperCase();

    const esPagoDestino =
      tipoCobro === "DESTINO" || condicionPago === "DESTINO";

    const rendido = !!g.rendido_at || estadoPago === "rendido";
    const pendienteRendicion =
      esPagoDestino &&
      estadoPago === "cobrado_destino" &&
      !rendido;

    return {
      ...g,
      rendicion_estado: rendido
        ? "RENDIDO"
        : (pendienteRendicion ? "PENDIENTE" : "NO_APLICA"),
      rendicion_pendiente: pendienteRendicion,
      rendido_bool: rendido,
    };
  });
}

/* ============================
   SQL comunes (reutilizables)
   - Incluye cant_bultos desde guia_items (SUM(cantidad))
   - Incluye destinatario_direccion
   - P15/P17.1: incluye campos mínimos para estado_derivado
============================ */
const SQL_GUIAS_SELECT = `
  g.id, g.numero_guia, g.created_at,
  g.sucursal_origen_id, g.sucursal_destino_id,
  so.nombre AS sucursal_origen_nombre,
  so.codigo AS sucursal_origen_codigo,
  sd.nombre AS sucursal_destino_nombre,
  sd.codigo AS sucursal_destino_codigo,

  g.estado_logistico,
  g.estado_pago,
  g.condicion_pago,
  g.tipo_cobro,
  g.metodo_pago,

  g.monto_total,
  g.monto_cobrar_destino,
  g.cobro_obligatorio_entrega,
  g.cobrado_destino_at,

  g.rendido_at,
  g.rendido_by_user_id,
  g.rendido_by_usuario,

  g.remitente_nombre, g.remitente_telefono,
  g.destinatario_nombre, g.destinatario_telefono, g.destinatario_direccion,

  COALESCE(b.cant_bultos,0) AS cant_bultos,
  g.fragil,

  false AS observada,
  false AS excepcion_entrega,

  NULL::bigint AS cierre_id,
  NULL::text AS cierre_estado_db,
  NULL::date AS cierre_fecha,

  NULL::bigint AS liquidacion_id,
  NULL::text AS liquidacion_estado_db,

  NULL::bigint AS conciliacion_id,
  NULL::text AS conciliacion_estado_db,

  NULL::text AS ultimo_evento,
  NULL::timestamp AS ultimo_evento_at
`;

const SQL_GUIAS_JOINS = `
  LEFT JOIN sucursales so ON so.id = g.sucursal_origen_id
  LEFT JOIN sucursales sd ON sd.id = g.sucursal_destino_id
  LEFT JOIN (
    SELECT guia_id, COALESCE(SUM(cantidad),0)::int AS cant_bultos
    FROM guia_items
    GROUP BY guia_id
  ) b ON b.guia_id = g.id
`;

/* ============================
   RUTAS PUBLICAS
============================ */
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "Demasiados intentos. Esperá unos minutos y probá de nuevo.",
  },
});

// Aplica SOLO a login
app.use("/auth/login", loginLimiter);

mountPublic("/tracking", "./routes/tracking");
mountPublic("/auth", "./routes/auth");

/* ============================
   TEST AUTH (PROTEGIDA)
============================ */
app.get("/test-auth", auth, (req, res) => res.json({ ok: true, user: req.user }));

/* ============================
   RUTAS INTERNAS (PROTEGIDAS)
============================ */
// 1) lo más específico primero
mountProtected("/guias/estado", "./routes/estadoGuia");

// 2) general primero (para que /guias/cotizar NO sea capturado por /:id)
mountProtected("/guias", "./routes/guias");

// 3) detalle después
mountProtected("/guias", "./routes/guiaDetalle");

// 4) resto
mountProtected("/sucursales", "./routes/sucursales");
mountProtected("/bultos", "./routes/bultos");
mountProtected("/recalculo", "./routes/recalculo");
mountProtected("/interno/cierres", "./routes/cierres");
mountProtected("/admin", "./routes/admin");
mountProtected("/interno/lotes", "./routes/lotes");
mountProtected("/interno/contabilidad", "./routes/contabilidadAgencias");

// P15 - Cobros / pago en destino
// Se deja sin auth acá porque routes/cobros.js ya protege cada endpoint.
// Si luego limpiás auth interno de routes/cobros.js, cambiá a:
// app.use("/interno/cobros", auth, cobrosRoutes);
app.use("/interno/cobros", cobrosRoutes);

/* ============================
   ENDPOINTS INTERNOS BASE
============================ */
app.get("/interno/ping", auth, (req, res) => res.json({ ok: true, user: req.user }));

app.get("/interno/runtime", auth, (req, res) => {
  res.json({
    ok: true,
    boot_at: SERVER_BOOT_AT,
    pid: process.pid,
    node_env: process.env.NODE_ENV || "development",
  });
});

app.get("/", (_req, res) => res.send("Sistema EXR activo 🚛"));

app.get("/health/db", async (_req, res) => {
  try {
    const result = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, now: result.rows[0].now });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/lotes.html", auth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "lotes.html"));
});

app.get("/hoja_ruta_lote.html", auth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "hoja_ruta_lote.html"));
});

/* ============================
   BANDEJA OPERATIVA (PROTEGIDA)
============================ */
app.get("/interno/bandeja", auth, async (req, res) => {
  try {
    const rol = String(req.user?.rol || "").trim().toUpperCase();
    const isPriv = rol === "OWNER" || rol === "ADMIN";
    const sucursalId = Number(req.user?.sucursal_id || 0) || null;

    if (!IS_PROD) {
      console.log("BANDEJA AUTH DEBUG", {
        user_id: req.user?.user_id,
        usuario: req.user?.usuario,
        rol,
        isPriv,
        sucursalId,
      });
    }

    if (!isPriv && !["OPERADOR", "ENCARGADO"].includes(rol)) {
      return res.status(403).json({ ok: false, error: "Rol sin permisos para bandeja" });
    }

    const exportAll = String(req.query.export || "") === "1";
    const wantsCSV = exportAll && String(req.query.format || "").toLowerCase() === "csv";

    const q = (req.query.q || "").trim();
    const estado_logistico = (req.query.estado_logistico || "").trim();
    const estado_pago = (req.query.estado_pago || "").trim().toLowerCase();
    const tipo_cobro = (req.query.tipo_cobro || "").trim().toUpperCase();
    const sin_metodo = String(req.query.sin_metodo || "") === "1";
    const rendicion = (req.query.rendicion || "").trim().toLowerCase();

    const limit = exportAll ? 50000 : Math.min(parseInt(req.query.limit || "25", 10) || 25, 500);
    const offset = exportAll ? 0 : Math.max(parseInt(req.query.offset || "0", 10) || 0, 0);

    const cacheable = !wantsCSV;
    const cacheKey = cacheable
      ? JSON.stringify({
          user: req.user?.user_id,
          rol,
          suc: sucursalId,
          q,
          estado_logistico,
          estado_pago,
          tipo_cobro,
          sin_metodo,
          rendicion,
          limit,
          offset,
        })
      : null;

    if (cacheable) {
      const cached = cacheGet(cacheKey);
      if (cached) {
        const etagCached = "exr-" + makeEtagForBandeja(cached);
        res.setHeader("ETag", `"${etagCached}"`);
        res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

        const candidates = parseIfNoneMatch(req.headers["if-none-match"]);
        if (candidates.includes(etagCached)) {
          return res.status(304).end();
        }

        return res.json(cached);
      }
    }

    let total = 0;
    let rows = [];

    const selectCols = SQL_GUIAS_SELECT;
    const joins = SQL_GUIAS_JOINS;

    if (isPriv) {
      const where = [];
      const params = [];

      if (estado_logistico) {
        params.push(estado_logistico);
        where.push(`g.estado_logistico = $${params.length}`);
      }

      pushEstadoPagoWhere(where, params, estado_pago);

      if (tipo_cobro) {
        params.push(tipo_cobro);
        where.push(`UPPER(COALESCE(g.tipo_cobro,'')) = $${params.length}`);
      }

      if (sin_metodo) {
        where.push(`g.estado_pago = 'cobrado_destino' AND (g.metodo_pago IS NULL OR g.metodo_pago = '')`);
      }

      if (rendicion === "pendiente") {
        where.push(`g.estado_pago = 'cobrado_destino' AND g.rendido_at IS NULL`);
      }

      if (rendicion === "rendido") {
        where.push(`g.estado_pago = 'cobrado_destino' AND g.rendido_at IS NOT NULL`);
      }

      if (q) {
        params.push(`%${q}%`);
        const p = `$${params.length}`;
        where.push(`(
          g.numero_guia ILIKE ${p}
          OR g.remitente_nombre ILIKE ${p}
          OR g.destinatario_nombre ILIKE ${p}
          OR g.remitente_telefono ILIKE ${p}
          OR g.destinatario_telefono ILIKE ${p}
        )`);
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const totalQ = `
        SELECT COUNT(*)::int AS total
        FROM guias g
        ${joins}
        ${whereSql}
      `;
      const totalR = await pool.query(totalQ, params);
      total = totalR.rows?.[0]?.total ?? 0;

      const p = [...params];
      p.push(limit);
      const pLimit = `$${p.length}`;
      p.push(offset);
      const pOffset = `$${p.length}`;

      const dataQ = `
        SELECT ${selectCols}
        FROM guias g
        ${joins}
        ${whereSql}
        ORDER BY g.created_at DESC
        LIMIT ${pLimit} OFFSET ${pOffset}
      `;
      const r = await pool.query(dataQ, p);
      rows = decorateBandejaRows(r.rows || []);
    } else {
      if (!sucursalId) {
        return res.status(403).json({ ok: false, error: "Usuario sin sucursal asignada" });
      }

      const where = [`(g.sucursal_origen_id = $1 OR g.sucursal_destino_id = $1)`];
      const params = [sucursalId];

      if (estado_logistico) {
        params.push(estado_logistico);
        where.push(`g.estado_logistico = $${params.length}`);
      }

      pushEstadoPagoWhere(where, params, estado_pago);

      if (tipo_cobro) {
        params.push(tipo_cobro);
        where.push(`UPPER(COALESCE(g.tipo_cobro,'')) = $${params.length}`);
      }

      if (sin_metodo) {
        where.push(`g.estado_pago = 'cobrado_destino' AND (g.metodo_pago IS NULL OR g.metodo_pago = '')`);
      }

      if (rendicion === "pendiente") {
        where.push(`g.estado_pago = 'cobrado_destino' AND g.rendido_at IS NULL`);
      }

      if (rendicion === "rendido") {
        where.push(`g.estado_pago = 'cobrado_destino' AND g.rendido_at IS NOT NULL`);
      }

      if (q) {
        params.push(`%${q}%`);
        const p = `$${params.length}`;
        where.push(`(
          g.numero_guia ILIKE ${p}
          OR g.remitente_nombre ILIKE ${p}
          OR g.destinatario_nombre ILIKE ${p}
          OR g.remitente_telefono ILIKE ${p}
          OR g.destinatario_telefono ILIKE ${p}
        )`);
      }

      const whereSql = `WHERE ${where.join(" AND ")}`;

      const totalQ = `
        SELECT COUNT(*)::int AS total
        FROM guias g
        ${joins}
        ${whereSql}
      `;
      const totalR = await pool.query(totalQ, params);
      total = totalR.rows?.[0]?.total ?? 0;

      const p = [...params];
      p.push(limit);
      const pLimit = `$${p.length}`;
      p.push(offset);
      const pOffset = `$${p.length}`;

      const dataQ = `
        SELECT ${selectCols}
        FROM guias g
        ${joins}
        ${whereSql}
        ORDER BY g.created_at DESC
        LIMIT ${pLimit} OFFSET ${pOffset}
      `;
      const r = await pool.query(dataQ, p);
      rows = decorateBandejaRows(r.rows || []);
    }

    rows = attachEstadoDerivadoMany(rows);

    if (wantsCSV) {
      const sep = ";";
      const csvCell = (v) => {
        const s = String(v ?? "");
        const needs = /[;\n\r"]/g.test(s);
        const escaped = s.replace(/"/g, '""');
        return needs ? `"${escaped}"` : escaped;
      };

      const cols = [
        ["numero_guia", "N° Guía"],
        ["created_at", "Fecha"],
        ["sucursal_origen_codigo", "Origen"],
        ["sucursal_destino_codigo", "Destino"],
        ["sucursal_origen_nombre", "Origen (nombre)"],
        ["sucursal_destino_nombre", "Destino (nombre)"],
        ["remitente_nombre", "Remitente"],
        ["remitente_telefono", "Tel Rem"],
        ["destinatario_nombre", "Destinatario"],
        ["destinatario_telefono", "Tel Dest"],
        ["estado_logistico", "Estado Log"],
        ["estado_pago", "Estado Pago"],
        ["metodo_pago", "Método Pago"],
        ["tipo_cobro", "Tipo Cobro"],
        ["condicion_pago", "Condición Pago"],
        ["monto_cobrar_destino", "Monto Cobrar Destino"],
        ["monto_total", "Monto Total"],
        ["rendido_at", "Rendido At"],
        ["rendido_by_usuario", "Rendido Por"],
      ];

      const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="exr_bandeja_${stamp}.csv"`);

      res.write("\uFEFF");
      res.write(cols.map((c) => csvCell(c[1])).join(sep) + "\n");
      for (const row of rows) {
        res.write(cols.map((c) => csvCell(row?.[c[0]])).join(sep) + "\n");
      }
      return res.end();
    }

    const payload = {
      ok: true,
      scope: isPriv ? "global" : "sucursal",
      sucursal_id: sucursalId,
      total,
      export: exportAll,
      guias: rows,
    };

    const etag = "exr-" + makeEtagForBandeja(payload);
    res.setHeader("ETag", `"${etag}"`);
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

    const candidates = parseIfNoneMatch(req.headers["if-none-match"]);
    if (candidates.includes(etag)) return res.status(304).end();

    if (cacheable) cacheSet(cacheKey, payload, 2000);
    return res.json(payload);
  } catch (e) {
    console.error("ERROR /interno/bandeja:", {
      message: e?.message,
      detail: e?.detail,
      hint: e?.hint,
      code: e?.code,
      stack: e?.stack,
    });
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

/* =============================
   ETIQUETA / QR (PROTEGIDA)
============================= */
app.get("/interno/etiqueta/:guiaId", auth, async (req, res) => {
  try {
    const guiaId = Number(req.params.guiaId);
    const b = req.query.b ? Number(req.query.b) : null;

    if (!guiaId || Number.isNaN(guiaId)) {
      return res.status(400).json({ ok: false, error: "guiaId inválido" });
    }

    if (b !== null && (Number.isNaN(b) || b < 1)) {
      return res.status(400).json({ ok: false, error: "b inválido (>=1)" });
    }

    const q = await pool.query(
      `
      SELECT ${SQL_GUIAS_SELECT}
      FROM guias g
      ${SQL_GUIAS_JOINS}
      WHERE g.id = $1
      LIMIT 1
      `,
      [guiaId]
    );

    if (!q.rows.length) {
      return res.status(404).json({ ok: false, error: "Guía no encontrada" });
    }

    const guia = q.rows[0];

    const rol = String(req.user?.rol || "").trim().toUpperCase();
    const owner = rol === "OWNER" || rol === "ADMIN";

    if (!owner) {
      const s = Number(req.user?.sucursal_id);
      if (!s) {
        return res.status(403).json({ ok: false, error: "Usuario sin sucursal asignada" });
      }

      const ok =
        Number(guia.sucursal_origen_id) === s ||
        Number(guia.sucursal_destino_id) === s;

      if (!ok) {
        return res.status(403).json({ ok: false, error: "Sin permisos para esta guía" });
      }
    }

    const total = Math.max(1, Number(guia.cant_bultos || 0));

    if (b !== null && b > total) {
      return res.status(400).json({ ok: false, error: `Bulto fuera de rango (1..${total})` });
    }

    const qrText = b ? `${guia.numero_guia}#B${b}/${total}` : guia.numero_guia;
    const qrDataUrl = await QRCode.toDataURL(qrText, { margin: 1, scale: 6 });

    const origenLabel =
      `${guia.sucursal_origen_codigo ? guia.sucursal_origen_codigo + " — " : ""}` +
      `${guia.sucursal_origen_nombre || ("Sucursal " + guia.sucursal_origen_id)}`;

    const destinoLabel =
      `${guia.sucursal_destino_codigo ? guia.sucursal_destino_codigo + " — " : ""}` +
      `${guia.sucursal_destino_nombre || ("Sucursal " + guia.sucursal_destino_id)}`;

    return res.json({
      ok: true,
      etiqueta: {
        guia_id: guia.id,
        numero_guia: guia.numero_guia,
        origen: origenLabel,
        destino: destinoLabel,
        cant_bultos: total,
        bulto_nro: b,
        estado_pago: guia.estado_pago,
        condicion_pago: guia.condicion_pago,
        monto_cobrar_destino: guia.monto_cobrar_destino,
        estado_logistico: guia.estado_logistico,
        created_at: guia.created_at,
        fragil: !!guia.fragil,
        qr_data_url: qrDataUrl,
        qr_payload: qrText,
        destinatario_nombre: guia.destinatario_nombre,
        destinatario_telefono: guia.destinatario_telefono,
        destinatario_direccion: guia.destinatario_direccion,
      },
    });
  } catch (e) {
    console.error("GET /interno/etiqueta/:guiaId error:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

/* ============================
   404 + ERROR HANDLERS
============================ */
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Ruta no encontrada",
    method: req.method,
    path: req.originalUrl,
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logErr("ERROR HANDLER:", err);
  res.status(500).json({ ok: false, error: err.message || "Error interno" });
});

/* ============================
   START
============================ */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor EXR en http://localhost:${port}`);
});