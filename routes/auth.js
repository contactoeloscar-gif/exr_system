console.log("CARGANDO routes/auth.js");

const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

function normUser(v) {
  return String(v || "").trim();
}

router.post("/login", async (req, res) => {
  const usuarioIn = normUser(req.body?.usuario);
  const password = String(req.body?.password || "");

  if (!usuarioIn || !password) {
    return res.status(400).json({ ok: false, error: "Faltan datos" });
  }

  try {
    // ✅ Traemos rol + activo + sucursal_id
    // Opcional: permitir login por email también (sin romper tu flujo actual)
    const r = await pool.query(
      `SELECT id, sucursal_id, usuario, email, rol, password_hash, activo
       FROM usuarios
       WHERE usuario = $1 OR email = $1
       LIMIT 1`,
      [usuarioIn]
    );

    if (r.rows.length === 0) {
      return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
    }

    const u = r.rows[0];

    // ✅ activo puede venir NULL, lo tratamos como true por compatibilidad
    if (u.activo === false) {
      return res.status(403).json({ ok: false, error: "Usuario desactivado" });
    }

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) {
      return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
    }

    const token = jwt.sign(
      {
        user_id: u.id,
        sucursal_id: u.sucursal_id ?? null,
        usuario: u.usuario,
        rol: String(u.rol || "").toUpperCase(), // ✅ NUEVO: rol en JWT
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || "12h" }
    );

    return res.json({ ok: true, token });
  } catch (e) {
    console.error("POST /auth/login error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

module.exports = router;
