console.log("CARGANDO routes/admin.js");

const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const bcrypt = require("bcrypt");
const { requireRole, isOwner } = require("../middleware/roles");

const ROLES_VALIDOS = new Set(["OWNER", "ADMIN", "ENCARGADO", "OPERADOR"]);
const TIPOS_VALIDOS = new Set(["SUCURSAL", "DEPOSITO"]); // tu DB hoy usa esto

const IS_PROD = process.env.NODE_ENV === "production";
function serverError(res, e) {
  console.error("[ADMIN] ERROR:", e);
  return res.status(500).json({
    ok: false,
    error: "server_error",
    ...(IS_PROD ? {} : { detail: e.message }),
  });
}

function norm(v) {
  return String(v ?? "").trim();
}
function normUpper(v) {
  return norm(v).toUpperCase();
}
function asInt(v) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : null;
}
function asBool(v) {
  if (v === true || v === false) return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (["true", "1", "si", "sí", "y", "yes"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return null;
}

/* =========================
   SUCURSALES
   Regla: OWNER/ADMIN pueden operar (si querés solo OWNER, cambiás requireRole)
========================= */

// GET /admin/sucursales
router.get("/sucursales", requireRole("OWNER", "ADMIN"), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, nombre, codigo, tipo, direccion, activa, fecha_creacion
       FROM sucursales
       ORDER BY id DESC`
    );
    res.json({ ok: true, sucursales: r.rows });
  } catch (e) {
    console.error("GET /admin/sucursales error:", e);
    return serverError(res, e);
  }
});

// POST /admin/sucursales  (crea sucursal + contador)
router.post("/sucursales", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const nombre = norm(req.body?.nombre);
  const codigo = normUpper(req.body?.codigo); // ✅ fijo: codigos uniformes
  let tipoIn = normUpper(req.body?.tipo || "SUCURSAL");

  // ✅ Mapeo compatible con tu negocio (inputs “humanos”)
  // - PUNTO_VENTA => SUCURSAL
  // - DESTINO => SUCURSAL
  // - CENTRAL => DEPOSITO
  if (tipoIn === "PUNTO_VENTA") tipoIn = "SUCURSAL";
  if (tipoIn === "DESTINO") tipoIn = "SUCURSAL";
  if (tipoIn === "CENTRAL") tipoIn = "DEPOSITO";

  const tipo = tipoIn;
  const direccion = norm(req.body?.direccion) || null;

  const activa = asBool(req.body?.activa);
  const activaFinal = activa == null ? true : activa;

  if (!nombre || !codigo) {
    return res.status(400).json({ ok: false, error: "nombre y codigo requeridos" });
  }
  if (!TIPOS_VALIDOS.has(tipo)) {
    return res.status(400).json({ ok: false, error: "tipo inválido (SUCURSAL|DEPOSITO)" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // codigo único
    const exists = await client.query(
      "SELECT id FROM sucursales WHERE codigo = $1 LIMIT 1",
      [codigo]
    );
    if (exists.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "codigo ya existe" });
    }

    const ins = await client.query(
      `INSERT INTO sucursales (nombre, codigo, tipo, direccion, activa, fecha_creacion)
       VALUES ($1,$2,$3,$4,$5, NOW())
       RETURNING id, nombre, codigo, tipo, direccion, activa, fecha_creacion`,
      [nombre, codigo, tipo, direccion, activaFinal]
    );

    const sucursal = ins.rows[0];

    // crear contador si no existe
    await client.query(
      `INSERT INTO contadores_guias (sucursal_id, ultimo_numero)
       VALUES ($1, 0)
       ON CONFLICT (sucursal_id) DO NOTHING`,
      [sucursal.id]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, sucursal });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /admin/sucursales error:", e);
    return serverError(res, e);
  } finally {
    client.release();
  }
});

/* =========================
   USUARIOS
========================= */

// GET /admin/usuarios
router.get("/usuarios", requireRole("OWNER", "ADMIN"), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.nombre, u.usuario, u.email, u.rol, u.sucursal_id, u.activo, u.fecha_creacion,
              s.nombre AS sucursal_nombre, s.codigo AS sucursal_codigo
       FROM usuarios u
       LEFT JOIN sucursales s ON s.id = u.sucursal_id
       ORDER BY u.id DESC`
    );
    res.json({ ok: true, usuarios: r.rows });
  } catch (e) {
    console.error("GET /admin/usuarios error:", e);
    return serverError(res, e);
  }
});

// POST /admin/usuarios
router.post("/usuarios", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const nombre = norm(req.body?.nombre);
  const usuario = norm(req.body?.usuario);
  const email = norm(req.body?.email);
  const password = String(req.body?.password || "");
  const rol = normUpper(req.body?.rol);

  const sucursal_id = req.body?.sucursal_id == null ? null : asInt(req.body?.sucursal_id);
  const activo = asBool(req.body?.activo);
  const activoFinal = activo == null ? true : activo;

  if (!nombre || !usuario || !email || !password || !rol) {
    return res.status(400).json({
      ok: false,
      error: "Faltan datos (nombre/usuario/email/password/rol)",
    });
  }
  if (!ROLES_VALIDOS.has(rol)) {
    return res.status(400).json({ ok: false, error: "rol inválido" });
  }

  // ✅ Seguridad: solo OWNER puede crear OWNER
  if (rol === "OWNER" && !isOwner(req)) {
    return res.status(403).json({ ok: false, error: "Solo OWNER puede crear otro OWNER" });
  }

  // ✅ Seguridad recomendada: ADMIN no puede crear ADMIN/OWNER (puede crear operadores/encargados)
  if (!isOwner(req) && (rol === "ADMIN" || rol === "OWNER")) {
    return res.status(403).json({ ok: false, error: "ADMIN no puede crear usuarios ADMIN/OWNER" });
  }

  // OWNER global: sucursal_id debe ser NULL
  if (rol === "OWNER") {
    // forzar global (lo hacemos al insertar)
  } else {
    if (!sucursal_id) {
      return res.status(400).json({ ok: false, error: "sucursal_id requerido para este rol" });
    }
  }

  try {
    // usuario o email únicos
    const ex = await pool.query(
      `SELECT 1 FROM usuarios WHERE usuario = $1 OR email = $2 LIMIT 1`,
      [usuario, email]
    );
    if (ex.rowCount > 0) {
      return res.status(400).json({ ok: false, error: "usuario o email ya existe" });
    }

    // validar sucursal si aplica
    if (rol !== "OWNER") {
      const s = await pool.query("SELECT id FROM sucursales WHERE id = $1 LIMIT 1", [sucursal_id]);
      if (s.rowCount === 0) {
        return res.status(400).json({ ok: false, error: "sucursal_id no existe" });
      }
    }

    const hash = await bcrypt.hash(password, 10);

    const ins = await pool.query(
      `INSERT INTO usuarios (nombre, email, usuario, password_hash, rol, sucursal_id, activo, fecha_creacion)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
       RETURNING id, nombre, email, usuario, rol, sucursal_id, activo, fecha_creacion`,
      [nombre, email, usuario, hash, rol, rol === "OWNER" ? null : sucursal_id, activoFinal]
    );

    res.json({ ok: true, usuario: ins.rows[0] });
  } catch (e) {
    console.error("POST /admin/usuarios error:", e);
    return serverError(res, e);
  }
});

// PATCH /admin/usuarios/:id/activo
router.patch("/usuarios/:id/activo", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const id = asInt(req.params.id);
  const activo = asBool(req.body?.activo);

  if (!id || activo == null) {
    return res.status(400).json({ ok: false, error: "id y activo requeridos" });
  }

  try {
    // ✅ Seguridad: ADMIN no puede desactivar OWNER
    if (!isOwner(req)) {
      const t = await pool.query("SELECT rol FROM usuarios WHERE id = $1", [id]);
      if (t.rowCount === 0) return res.status(404).json({ ok: false, error: "usuario no existe" });
      const targetRole = String(t.rows[0].rol || "").toUpperCase();
      if (targetRole === "OWNER") {
        return res.status(403).json({ ok: false, error: "No podés modificar un OWNER" });
      }
    }

    const r = await pool.query(
      `UPDATE usuarios SET activo = $1 WHERE id = $2
       RETURNING id, usuario, rol, sucursal_id, activo`,
      [activo, id]
    );
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "usuario no existe" });
    res.json({ ok: true, usuario: r.rows[0] });
  } catch (e) {
    console.error("PATCH /admin/usuarios/:id/activo error:", e);
    return serverError(res, e);
  }
});

module.exports = router;