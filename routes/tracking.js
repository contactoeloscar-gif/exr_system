console.log("CARGANDO routes/tracking.js");

const express = require("express");
const router = express.Router();
const pool = require("../config/db");

function traducirEstado(estado) {
  const mapa = {
RECIBIDO_ORIGEN: "Recibido en sucursal de origen",
EN_TRANSITO: "En tránsito",
EN_TRANSITO_A_CENTRAL: "En tránsito hacia HUB",
RECIBIDO_CENTRAL: "Recibido en HUB",
RECIBIDO_CENTRAL_OBSERVADO: "Recibido en HUB con observación",
EN_TRANSITO_A_DESTINO: "En tránsito hacia sucursal destino",
RECIBIDO_DESTINO: "Disponible en sucursal de destino",
RECIBIDO_DESTINO_OBSERVADO: "Disponible en destino con observación",
ENTREGADO: "Entregado",
  };
  return mapa[estado] || estado;
}

router.get("/:numero_guia", async (req, res) => {
  const numero = String(req.params.numero_guia || "").trim();

  try {
    const g = await pool.query(
      `SELECT g.id,
              g.numero_guia,
              g.estado_logistico,
              g.fragil,
              g.created_at,
              so.nombre AS sucursal_origen,
              sd.nombre AS sucursal_destino
       FROM guias g
       LEFT JOIN sucursales so ON so.id = g.sucursal_origen_id
       LEFT JOIN sucursales sd ON sd.id = g.sucursal_destino_id
       WHERE g.numero_guia = $1
       LIMIT 1`,
      [numero]
    );

    if (g.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Guía no encontrada" });
    }

    const guia = g.rows[0];

    // Obtener eventos
    const eventosQuery = await pool.query(
      `SELECT ge.evento,
              ge.detalle,
              ge.created_at,
              s.nombre AS sucursal
       FROM guia_eventos ge
       LEFT JOIN sucursales s ON s.id = ge.sucursal_id
       WHERE ge.guia_id = $1
       ORDER BY ge.id ASC`,
      [guia.id]
    );

    const eventosTraducidos = eventosQuery.rows.map(e => ({
      evento: e.evento.startsWith("ESTADO_")
        ? traducirEstado(e.evento.replace("ESTADO_", ""))
        : e.evento,
      detalle: e.detalle,
      fecha: e.created_at,
      sucursal: e.sucursal,
    }));

    res.json({
      ok: true,
      tracking: {
        numero_guia: guia.numero_guia,
        estado_logistico: traducirEstado(guia.estado_logistico),
        origen: guia.sucursal_origen,
        destino: guia.sucursal_destino,
        fragil: guia.fragil,
        creado: guia.created_at,
        eventos: eventosTraducidos,
      },
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
