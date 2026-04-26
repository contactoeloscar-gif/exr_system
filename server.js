// server.js (EXR P17.3+) — LIMPIO / CONSOLIDADO / listo para pegar
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const pool = require("./config/db");
const { cacheClearBandeja } = require("./services/bandejaCache.service");

const authMod = require("./middleware/auth");
const auth = authMod.auth || authMod;

const rateLimit = require("express-rate-limit");

/* ============================
   APP
============================ */
const app = express();
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

/* ============================
   ROUTE LOADERS
============================ */
function loadRouteModule(routeFile) {
  const resolved = require.resolve(routeFile);
  delete require.cache[resolved];

  return {
    router: require(resolved),
    resolved,
    mtime: fs.statSync(resolved).mtime.toISOString(),
  };
}

function mountRoute(basePath, routeFile, { protectedRoute = false } = {}) {
  try {
    const loaded = loadRouteModule(routeFile);

    log(
      `MONTANDO ${basePath} (${protectedRoute ? "protected" : "public"}) -> ${routeFile}`
    );
    log(`ROUTE FILE: ${loaded.resolved}`);
    log(`ROUTE MTIME: ${loaded.mtime}`);

    if (protectedRoute) {
      app.use(basePath, auth, loaded.router);
    } else {
      app.use(basePath, loaded.router);
    }
  } catch (e) {
    logErr(`ERROR cargando ${routeFile} para ${basePath}:`, e.message);
  }
}

function mountPublic(basePath, routeFile) {
  mountRoute(basePath, routeFile, { protectedRoute: false });
}

function mountProtected(basePath, routeFile) {
  mountRoute(basePath, routeFile, { protectedRoute: true });
}

/* ============================
   CORS + MIDDLEWARES BASE
============================ */
const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
   STATIC / HTML
============================ */
const staticDir = path.join(__dirname, "public");
log("STATIC DIR:", staticDir);

function sendHtml(fileName) {
  return (_req, res) => res.sendFile(path.join(staticDir, fileName));
}

[
  "etiqueta_batch.html",
  "etiqueta.html",
  "cierres.html",
  "cierre_comprobante.html",
  "cierres_historial.html",
  "contabilidad_agencias.html",
  "lotes.html",
  "hoja_ruta_lote.html",
  "agencia_liquidaciones.html",
].forEach((fileName) => {
  app.get(`/${fileName}`, sendHtml(fileName));
});

/* ============================
   TORRE DE CONTROL
   Acceso protegido
============================ */

// Bloquear acceso público directo
    // Bloquear acceso público directo a archivos internos sensibles
app.get("/torre_control.html", (_req, res) => {
  return res.status(403).send("Acceso no permitido");
});

app.get("/torre_control.js", (_req, res) => {
  return res.status(403).send("Acceso no permitido");
});

app.use(express.static(staticDir));

/* ============================
   HTML / JS INTERNOS PROTEGIDOS
============================ */
app.get("/interno/torre_control.html", (_req, res) =>
  res.sendFile(path.join(staticDir, "torre_control.html"))
);

app.get("/interno/torre_control.js", (_req, res) =>
  res.sendFile(path.join(staticDir, "torre_control.js"))
);

/* ============================
   INVALIDACIÓN CACHE BANDEJA
============================ */
function isMutatingMethod(method) {
  return ["POST", "PATCH", "PUT", "DELETE"].includes(
    String(method || "").toUpperCase()
  );
}

function touchesBandejaPath(pathname) {
  const p = String(pathname || "");

  return (
    p === "/guias" ||
    p === "/guias/pago" ||
    p.startsWith("/guias/estado") ||
    p.startsWith("/interno/cobros") ||
    p.startsWith("/interno/contabilidad") ||
    p.startsWith("/interno/cierres") ||
    p.startsWith("/interno/lotes")
  );
}

app.use((req, res, next) => {
  if (!isMutatingMethod(req.method) || !touchesBandejaPath(req.path)) {
    return next();
  }

  res.on("finish", () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      cacheClearBandeja();
    }
  });

  next();
});

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

app.use("/auth/login", loginLimiter);

[
  ["/tracking", "./routes/tracking"],
  ["/auth", "./routes/auth"],
].forEach(([basePath, routeFile]) => mountPublic(basePath, routeFile));

/* ============================
   TEST AUTH (PROTEGIDA)
============================ */
app.get("/test-auth", auth, (req, res) => {
  res.json({ ok: true, user: req.user });
});


/* ============================
   RUTAS INTERNAS (PROTEGIDAS)
============================ */
// Orden importante: específicas primero
[
  ["/guias/estado", "./routes/estadoGuia"],
  ["/guias", "./routes/guias"],
  ["/guias", "./routes/guiaDetalle"],
  ["/sucursales", "./routes/sucursales"],
  ["/bultos", "./routes/bultos"],
  ["/recalculo", "./routes/recalculo"],
  ["/interno/cierres", "./routes/cierres"],
  ["/admin", "./routes/admin"],
  ["/interno/lotes", "./routes/lotes"],
  ["/interno/contabilidad", "./routes/contabilidadAgencias"],
  ["/interno/agencia", "./routes/agenciaLiquidaciones"],
  ["/interno/cobros", "./routes/cobros"],
  ["/interno/torre-control", "./routes/torreControl"],
  ["/interno", "./routes/bandeja"],
  ["/interno", "./routes/etiquetas"],
].forEach(([basePath, routeFile]) => mountProtected(basePath, routeFile));

/* ============================
   ENDPOINTS INTERNOS BASE
============================ */
app.get("/interno/ping", auth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.get("/interno/runtime", auth, (req, res) => {
  res.json({
    ok: true,
    boot_at: SERVER_BOOT_AT,
    pid: process.pid,
    node_env: process.env.NODE_ENV || "development",
  });
});

app.get("/", (_req, res) => {
  res.send("Sistema EXR activo 🚛");
});

app.get("/health/db", async (_req, res) => {
  try {
    const result = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, now: result.rows[0].now });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
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