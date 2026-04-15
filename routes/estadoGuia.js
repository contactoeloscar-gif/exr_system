// EXR-P15-ESTADO-V4
console.log("CARGANDO routes/estadoGuia.js");

const express = require("express");
const router = express.Router();

const pool = require("../config/db");
const { canOperateGuia } = require("../middleware/guiaScope");
const { auditMovimiento } = require("../utils/audit");
const { canChangeEstado } = require("../utils/rules");
const { isOwnerOrAdmin } = require("../middleware/roles");
const {
  CONDICION_PAGO,
  ESTADO_PAGO,
} = require("../utils/cobros.constants");

const ESTADOS = new Set(["RECIBIDO_ORIGEN", "EN_TRANSITO", "RECIBIDO_DESTINO", "ENTREGADO"]);

function normEstado(v) {
  return String(v || "").trim().toUpperCase().replace(/\s+/g, "_");
}

function canUserOperateTransition(req, guia, toEstado) {
  const owner = isOwnerOrAdmin(req);
  if (owner) return true;

  const userSucursalId = Number(req.user?.sucursal_id || 0);
  if (!userSucursalId) return false;

  const origenId = Number(guia.sucursal_origen_id || 0);
  const destinoId = Number(guia.sucursal_destino_id || 0);

  // Reglas operativas por etapa
  if (toEstado === "RECIBIDO_ORIGEN" || toEstado === "EN_TRANSITO") {
    return userSucursalId === origenId;
  }

  if (toEstado === "RECIBIDO_DESTINO" || toEstado === "ENTREGADO") {
    return userSucursalId === destinoId;
  }

  return false;
}

// Montado en server.js como: mountProtected("/guias/estado", "./routes/estadoGuia")
  router.post("/", canOperateGuia({ allowOrigen: true, allowDestino: true }), async (req, res) => {
  const guia_id = Number(req.body?.guia_id);
  const estado = normEstado(req.body?.estado);

  if (!guia_id || !estado) {
    return res.status(400).json({ ok: false, error: "Faltan datos" });
  }

  if (!ESTADOS.has(estado)) {
    return res.status(400).json({ ok: false, error: "estado_logistico invalido" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const q = await client.query(
      `SELECT
         id,
         sucursal_origen_id,
         sucursal_destino_id,
         estado_logistico,
         estado_pago,
         condicion_pago,
         cobro_obligatorio_entrega
       FROM guias
       WHERE id = $1
       FOR UPDATE`,
      [guia_id]
    );

    if (q.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Guia no existe" });
    }

    const guia = q.rows[0];

    // Scope por sucursal según transición
    if (!canUserOperateTransition(req, guia, estado)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ ok: false, error: "Sin permisos para operar esta transición" });
    }

    const verdict = canChangeEstado({
      fromEstado: guia.estado_logistico,
      toEstado: estado,
      pagoEstado: guia.estado_pago,
    });

    if (!verdict.ok) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: verdict.error });
    }

    // Blindaje P15: pago en destino requiere cobro o excepción antes de entrega
    if (
      estado === "ENTREGADO" &&
      guia.condicion_pago === CONDICION_PAGO.DESTINO &&
      guia.cobro_obligatorio_entrega
    ) {
      const puedeEntregar =
        guia.estado_pago === ESTADO_PAGO.COBRADO_DESTINO ||
        guia.estado_pago === ESTADO_PAGO.OBSERVADO;

      if (!puedeEntregar) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          ok: false,
          error: "La guía requiere cobro en destino o excepción autorizada antes de la entrega.",
        });
      }
    }

    await client.query(
      `UPDATE guias
       SET estado_logistico = $1
       WHERE id = $2`,
      [estado, guia_id]
    );

    await auditMovimiento(client, {
      guia_id,
      tipo: "ESTADO",
      de_valor: guia.estado_logistico,
      a_valor: estado,
      req,
    });

    await client.query(
      `INSERT INTO guia_eventos(guia_id, evento, detalle, sucursal_id)
       VALUES($1,$2,$3,$4)`,
      [
        guia_id,
        "ESTADO",
        `Cambio de estado: ${guia.estado_logistico} -> ${estado}`,
        Number(req.user?.sucursal_id || null),
      ]
    );

    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /guias/estado error:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  } finally {
    client.release();
  }
});

module.exports = router;
