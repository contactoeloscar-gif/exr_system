const express = require("express");
const router = express.Router();
const pool = require("../config/db");

// Listar todas las sucursales
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM sucursales ORDER BY id ASC"
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
