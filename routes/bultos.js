console.log("CARGANDO routes/bultos.js NUEVO (con guia_items + recalculo)");

const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { recalcularGuia } = require("../services/recalcularGuia"); // 👈 ESTA LINEA ES CLAVE

// POST crear bulto + item + recalcular
router.post("/", async (req, res) => {

  const { guia_id, peso, largo, ancho, alto, descripcion } = req.body;

  const factor = 5000;
  const L = Number(largo || 0);
  const A = Number(ancho || 0);
  const H = Number(alto || 0);

  const pesoReal = Number(peso);
  const pesoVol = (L > 0 && A > 0 && H > 0) ? (L * A * H) / factor : 0;
  const pesoCobrable = Math.max(pesoReal, pesoVol);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Insert bulto
    const b = await client.query(
      `INSERT INTO bultos (guia_id, peso, largo, ancho, alto, peso_volumetrico, descripcion)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [Number(guia_id), pesoReal, L || null, A || null, H || null, pesoVol, descripcion || null]
    );

    const bulto = b.rows[0];

    // Buscar tarifa general
    const t = await client.query(
      `SELECT precio
       FROM tarifas_rango
       WHERE activo = true
         AND origen_id IS NULL
         AND destino_id IS NULL
         AND $1 >= peso_min AND $1 < peso_max
       ORDER BY peso_min ASC
       LIMIT 1`,
      [pesoCobrable]
    );

    if (t.rows.length === 0) {
      throw new Error("No hay tarifa para el peso cobrable: " + pesoCobrable);
    }

    const precioUnitario = Number(t.rows[0].precio);
    const subtotal = precioUnitario;
console.log("VOY A INSERTAR guia_items para guia", guia_id, "bulto", bulto.id);


    // Insert guia_item
    await client.query(
      `INSERT INTO guia_items (guia_id, tipo, bulto_id, cantidad, precio_unitario, subtotal)
       VALUES ($1,'BULTO',$2,1,$3,$4)`,
      [Number(guia_id), bulto.id, precioUnitario, subtotal]
    );

    await client.query("COMMIT");

    // 🔥 Recalcular totales
    const totales = await recalcularGuia(Number(guia_id));

    res.json({
      ok: true,
      bulto,
      pesoCobrable,
      precioUnitario,
      subtotal,
      totales
    });

  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

// GET listar bultos
router.get("/:guia_id", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM bultos WHERE guia_id = $1 ORDER BY id ASC",
      [Number(req.params.guia_id)]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
