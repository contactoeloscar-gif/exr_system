console.log("CARGANDO routes/buscarGuia.js");

const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { canOperateGuia } = require("../middleware/guiaScope");

// GET /interno/guias/por-numero/:numero
router.get("/guias/por-numero/:numero", async (req, res) => {
  try {
    const numero = String(req.params.numero || "").trim();
    if (!numero) return res.status(400).json({ ok: false, error: "Falta número" });

    const r = await pool.query(
      `SELECT
         id, numero_guia, estado_logistico, estado_pago, tipo_cobro,
         sucursal_origen_id, sucursal_destino_id, fragil, created_at
       FROM guias
       WHERE numero_guia = $1
       LIMIT 1`,
      [numero]
    );

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Guía no encontrada" });
    }

    res.json({ ok: true, guia: r.rows[0] });
  } catch (e) {
    console.error("GET /interno/guias/por-numero/:numero:", e);
    res.status(500).json({ ok: false, error: "Error buscando guía" });
  }
});

// GET /interno/guias/:id/historial
router.get("/guias/:id/historial", canOperateGuia, async (req, res) => {
  try {
    const guiaId = Number(req.params.id);
    if (!guiaId) return res.status(400).json({ ok: false, error: "ID inválido" });

    const { rows } = await pool.query(
      `SELECT
         id,
         tipo,
         de_valor,
         a_valor,
         sucursal_id,
         user_id,
         usuario,
         ip,
         creado_en
       FROM historial_movimientos
       WHERE guia_id = $1
       ORDER BY creado_en ASC`,
      [guiaId]
    );

    res.json({ ok: true, rows });
  } catch (e) {
    console.error("GET /interno/guias/:id/historial:", e);
    res.status(500).json({ ok: false, error: "Error leyendo historial" });
  }
});

module.exports = router;


