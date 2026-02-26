// server.js (EXR-PRO-FINAL)
const path = require("path");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const pool = require("./config/db");

const authMod = require("./middleware/auth");
const auth = authMod.auth || authMod;

const { isOwnerOrAdmin } = require("./middleware/roles");

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

/* ============================
   CORS + MIDDLEWARES BASE
============================ */
const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// fallback dev
const defaultOrigins = ["http://localhost:5500", "http://127.0.0.1:5500", "http://localhost:3000"];

app.use(
  cors({
    origin: corsOrigins.length ? corsOrigins : defaultOrigins,
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

const staticDir = path.join(__dirname, "public");
log("STATIC DIR:", staticDir);
app.use(express.static(staticDir));

/* ============================
   INVALIDACIÓN CACHE BANDEJA
   Cuando cambian guías / pagos / estado
============================ */
app.use((req, res, next) => {
  const m = req.method.toUpperCase();
  const p = req.path;

  const touchesBandeja =
    (m === "POST" && (p === "/guias" || p === "/guias/pago" || p === "/guias/estado")) ||
    (m === "PATCH" && p.startsWith("/guias/")) ||
    (m === "DELETE" && p.startsWith("/guias/"));

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
    total: payload.total,
    guias: (payload.guias || []).map((g) => [
      g.id,
      g.created_at,
      g.estado_logistico,
      g.estado_pago,
      g.metodo_pago,
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

/* ============================
   RUTAS PUBLICAS
============================ */
function mountPublic(basePath, routeFile) {
  try {
    log(`MONTANDO ${basePath} (public) -> ${routeFile}`);
    const router = require(routeFile);
    app.use(basePath, router);
  } catch (e) {
    logErr(`ERROR cargando ${routeFile} para ${basePath}:`, e.message);
  }
}

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Demasiados intentos. Esperá unos minutos y probá de nuevo." },
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
function mountProtected(basePath, routeFile) {
  try {
    log(`MONTANDO ${basePath} (protected) -> ${routeFile}`);
    const router = require(routeFile);
    app.use(basePath, auth, router);
  } catch (e) {
    logErr(`ERROR cargando ${routeFile} para ${basePath}:`, e.message);
  }
}

mountProtected("/interno", "./routes/buscarGuia");
mountProtected("/sucursales", "./routes/sucursales");
mountProtected("/guias", "./routes/guias");
mountProtected("/guias", "./routes/guiaDetalle");
mountProtected("/bultos", "./routes/bultos");
mountProtected("/recalculo", "./routes/recalculo");
mountProtected("/guias/estado", "./routes/estadoGuia");
mountProtected("/interno/finanzas", "./routes/finanzas");
mountProtected("/interno/dashboard", "./routes/dashboard");
mountProtected("/admin", "./routes/admin");

/* ============================
   ENDPOINTS INTERNOS BASE
============================ */
app.get("/interno/ping", auth, (req, res) => res.json({ ok: true, user: req.user }));
app.get("/", (req, res) => res.send("Sistema EXR activo 🚛"));

app.get("/health/db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, now: result.rows[0].now });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* ============================
   BANDEJA OPERATIVA (PROTEGIDA)
   - OWNER/ADMIN: global
   - resto: sucursal (UNION ALL para evitar OR)
   - Cache RAM + ETag/304 (también en cache hit)
============================ */
app.get("/interno/bandeja", auth, async (req, res) => {
  try {
    const isPriv = ["OWNER", "ADMIN"].includes(req.user?.rol);
    const sucursalId = req.user?.sucursal_id ?? null;

    const exportAll = String(req.query.export || "") === "1";
    const wantsCSV = exportAll && String(req.query.format || "").toLowerCase() === "csv";

    const q = (req.query.q || "").trim();
    const estado_logistico = (req.query.estado_logistico || "").trim();
    const estado_pago = (req.query.estado_pago || "").trim();
    const tipo_cobro = (req.query.tipo_cobro || "").trim();
    const sin_metodo = String(req.query.sin_metodo || "") === "1";

    const limit = exportAll ? 50000 : Math.min(parseInt(req.query.limit || "25", 10) || 25, 500);
    const offset = exportAll ? 0 : Math.max(parseInt(req.query.offset || "0", 10) || 0, 0);

    const where = [];
    const params = [];

    if (estado_logistico) {
      params.push(estado_logistico);
      where.push(`g.estado_logistico = $${params.length}`);
    }
    if (estado_pago) {
      params.push(estado_pago);
      where.push(`g.estado_pago = $${params.length}`);
    }
    if (tipo_cobro) {
      params.push(tipo_cobro);
      where.push(`g.tipo_cobro = $${params.length}`);
    }

    if (sin_metodo) {
      where.push(`g.estado_pago = 'PAGADO' AND (g.metodo_pago IS NULL OR g.metodo_pago = '')`);
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

    const commonWhereSql = where.length ? `AND ${where.join(" AND ")}` : "";

    // Cache solo JSON
    const cacheable = !wantsCSV;
    const cacheKey = cacheable
      ? JSON.stringify({
          user: req.user?.user_id,
          rol: req.user?.rol,
          suc: req.user?.sucursal_id,
          q,
          estado_logistico,
          estado_pago,
          tipo_cobro,
          sin_metodo,
          limit,
          offset,
        })
      : null;

    // ✅ Cache hit con ETag/304
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

    const selectCols = `
      g.id, g.numero_guia, g.created_at,
      g.sucursal_origen_id, g.sucursal_destino_id,
      so.nombre AS sucursal_origen_nombre,
      so.codigo AS sucursal_origen_codigo,
      sd.nombre AS sucursal_destino_nombre,
      sd.codigo AS sucursal_destino_codigo,
      g.estado_logistico, g.estado_pago, g.tipo_cobro, g.metodo_pago,
      g.remitente_nombre, g.remitente_telefono,
      g.destinatario_nombre, g.destinatario_telefono,
      g.valor_declarado, g.monto_seguro, g.monto_envio, g.importe_servicio,
      COALESCE(g.monto_total, 0) AS monto_total
    `;

    const joins = `
      LEFT JOIN sucursales so ON so.id = g.sucursal_origen_id
      LEFT JOIN sucursales sd ON sd.id = g.sucursal_destino_id
    `;

    if (isPriv) {
      const totalQ = `
        SELECT COUNT(*)::int AS total
        FROM guias g
        ${joins}
        WHERE 1=1
        ${commonWhereSql}
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
        WHERE 1=1
        ${commonWhereSql}
        ORDER BY g.created_at DESC
        LIMIT ${pLimit} OFFSET ${pOffset}
      `;
      const r = await pool.query(dataQ, p);
      rows = r.rows || [];
    } else {
      if (!sucursalId) return res.status(403).json({ ok: false, error: "Sin sucursal asignada" });

      const pBase = [sucursalId, ...params];
      const sucP = "$1";

      const totalQ = `
        SELECT SUM(t.c)::int AS total
        FROM (
          SELECT COUNT(*)::int AS c
          FROM guias g
          ${joins}
          WHERE g.sucursal_origen_id = ${sucP}
          ${commonWhereSql}

          UNION ALL

          SELECT COUNT(*)::int AS c
          FROM guias g
          ${joins}
          WHERE g.sucursal_destino_id = ${sucP}
            AND g.sucursal_origen_id <> ${sucP}
          ${commonWhereSql}
        ) t
      `;
      const totalR = await pool.query(totalQ, pBase);
      total = totalR.rows?.[0]?.total ?? 0;

      const p = [...pBase];
      p.push(limit);
      const pLimit = `$${p.length}`;
      p.push(offset);
      const pOffset = `$${p.length}`;

      const dataQ = `
        SELECT *
        FROM (
          SELECT ${selectCols}
          FROM guias g
          ${joins}
          WHERE g.sucursal_origen_id = ${sucP}
          ${commonWhereSql}

          UNION ALL

          SELECT ${selectCols}
          FROM guias g
          ${joins}
          WHERE g.sucursal_destino_id = ${sucP}
            AND g.sucursal_origen_id <> ${sucP}
          ${commonWhereSql}
        ) u
        ORDER BY created_at DESC
        LIMIT ${pLimit} OFFSET ${pOffset}
      `;
      const r = await pool.query(dataQ, p);
      rows = r.rows || [];
    }

    // CSV export
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
        ["monto_total", "Monto Total"],
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

    // JSON + ETag/304 + cache
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
    console.error("ERROR /interno/bandeja:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

/* ============================
   ETIQUETA / QR (PROTEGIDA)
============================ */
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
      SELECT
        g.id,
        g.numero_guia,
        g.fragil,
        g.estado_pago,
        g.estado_logistico,
        g.created_at,
        g.sucursal_origen_id,
        g.sucursal_destino_id,
        COALESCE(so.nombre, ('Sucursal ' || g.sucursal_origen_id)) AS origen_nombre,
        COALESCE(sd.nombre, ('Sucursal ' || g.sucursal_destino_id)) AS destino_nombre,
        COALESCE(b.cant_bultos, 0) AS cant_bultos
      FROM guias g
      LEFT JOIN sucursales so ON so.id = g.sucursal_origen_id
      LEFT JOIN sucursales sd ON sd.id = g.sucursal_destino_id
      LEFT JOIN (
        SELECT guia_id, COUNT(*)::int AS cant_bultos
        FROM bultos
        GROUP BY guia_id
      ) b ON b.guia_id = g.id
      WHERE g.id = $1
      LIMIT 1
      `,
      [guiaId]
    );

    if (!q.rows.length) {
      return res.status(404).json({ ok: false, error: "Guía no encontrada" });
    }

    const guia = q.rows[0];

    const owner = isOwnerOrAdmin(req);
    if (!owner) {
      const s = Number(req.user?.sucursal_id);
      if (!s) return res.status(403).json({ ok: false, error: "Usuario sin sucursal asignada" });

      const ok = Number(guia.sucursal_origen_id) === s || Number(guia.sucursal_destino_id) === s;
      if (!ok) return res.status(403).json({ ok: false, error: "Sin permisos para esta guía" });
    }

    const total = Number(guia.cant_bultos || 0);

    if (b !== null) {
      if (total <= 0) return res.status(400).json({ ok: false, error: "La guía no tiene bultos" });
      if (b > total) return res.status(400).json({ ok: false, error: `Bulto fuera de rango (1..${total})` });
    }

    const qrText = b ? `${guia.numero_guia}#B${b}/${total}` : guia.numero_guia;
    const qrDataUrl = await QRCode.toDataURL(qrText, { margin: 1, scale: 6 });

    return res.json({
      ok: true,
      etiqueta: {
        guia_id: guia.id,
        numero_guia: guia.numero_guia,
        origen: guia.origen_nombre,
        destino: guia.destino_nombre,
        cant_bultos: total,
        bulto_nro: b,
        estado_pago: guia.estado_pago,
        estado_logistico: guia.estado_logistico,
        created_at: guia.created_at,
        fragil: !!guia.fragil,
        qr_data_url: qrDataUrl,
        qr_payload: qrText,
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
