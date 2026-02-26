console.log("CARGANDO routes/recalculo.js");

const express = require("express");
const router = express.Router();
const { recalcularGuia } = require("../services/recalcularGuia");

router.post("/:guia_id", async (req, res) => {
  try {
    const guiaId = Number(req.params.guia_id);
    const totales = await recalcularGuia(guiaId);
    res.json({ ok: true, guia_id: guiaId, totales });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
