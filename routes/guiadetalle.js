console.log("CARGANDO routes/guiaDetalle.js");

const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { isOwnerOrAdmin } = require("../middleware/roles");

// GET /guias/:id/detalle -> guia + bultos + items + eventos
router.get("/:id/detalle", async (req, res) => {
  const guiaId = Number(req.params.id);
  if (!guiaId) return res.status(400).json({ ok: false, error: "id inválido" });

  try {
    const g = await pool.query(
      `SELECT g.*,
              so.nombre AS sucursal_origen_nombre,
              sd.nombre AS sucursal_destino_nombre
       FROM guias g
       LEFT JOIN sucursales so ON so.id = g.sucursal_origen_id
       LEFT JOIN sucursales sd ON sd.id = g.sucursal_destino_id
       WHERE g.id = $1`,
      [guiaId]
    );

    if (g.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Guía no existe" });
    }

    const guia = g.rows[0];

    // ✅ Scope por sucursal (OWNER/ADMIN global)
    const owner = isOwnerOrAdmin(req);
    if (!owner) {
      if (!req.user?.sucursal_id) {
        return res.status(403).json({ ok: false, error: "Usuario sin sucursal asignada" });
      }
      if (Number(guia.sucursal_origen_id) !== Number(req.user.sucursal_id)) {
        return res.status(403).json({ ok: false, error: "Sin permisos para ver esta guía" });
      }
    }

    const bultos = await pool.query(
      "SELECT * FROM bultos WHERE guia_id = $1 ORDER BY id ASC",
      [guiaId]
    );

    const items = await pool.query(
      `SELECT gi.*,
              at.nombre AS articulo_nombre
       FROM guia_items gi
       LEFT JOIN articulos_tarifados at ON at.id = gi.articulo_id
       WHERE gi.guia_id = $1
       ORDER BY gi.id ASC`,
      [guiaId]
    );

    const eventos = await pool.query(
      `SELECT ge.*,
              s.nombre AS sucursal_nombre
       FROM guia_eventos ge
       LEFT JOIN sucursales s ON s.id = ge.sucursal_id
       WHERE ge.guia_id = $1
       ORDER BY ge.id ASC`,
      [guiaId]
    );

    return res.json({
      ok: true,
      guia,
      bultos: bultos.rows,
      items: items.rows,
      eventos: eventos.rows,
    });
  } catch (e) {
    console.error("GET /guias/:id/detalle error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
