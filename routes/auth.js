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
  try {
    const usuarioIn = normUser(req.body?.usuario);
    const password = String(req.body?.password || "");

    if (!usuarioIn || !password) {
      return res.status(400).json({ ok: false, error: "Faltan datos" });
    }

    // ✅ Traemos rol + activo + sucursal_id
    const r = await pool.query(
      `SELECT id, sucursal_id, usuario, email, rol, password_hash, activo
       FROM public.usuarios
       WHERE usuario = $1 OR email = $1
       LIMIT 1`,
      [usuarioIn]
    );

    if (r.rows.length === 0) {
      return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
    }

    const u = r.rows[0];

    // Si activo es false → bloqueamos
    if (u.activo === false) {
      return res.status(403).json({ ok: false, error: "Usuario desactivado" });
    }

    // Si no tiene hash → error claro
    if (!u.password_hash) {
      return res.status(500).json({ ok: false, error: "Usuario sin password_hash" });
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
        rol: String(u.rol || "").toUpperCase(),
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || "12h" }
    );

    return res.json({ ok: true, token });

  } catch (e) {
    console.error("[AUTH] LOGIN ERROR:", e);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      detail: e.message,
    });
  }
});

module.exports = router;