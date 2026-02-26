// EXR-P4-ESTADO-V3
console.log("CARGANDO routes/estadoGuia.js");

const express = require("express");
const router = express.Router();

const pool = require("../config/db");
const { canOperateGuia } = require("../middleware/guiaScope");
const { auditMovimiento } = require("../utils/audit");
const { canChangeEstado } = require("../utils/rules");
const { isOwnerOrAdmin } = require("../middleware/roles");

const ESTADOS = new Set(["RECIBIDO_ORIGEN", "EN_TRANSITO", "RECIBIDO_DESTINO", "ENTREGADO"]);

function normEstado(v) {
  return String(v || "").trim().toUpperCase().replace(/\s+/g, "_");
}

// Montado en server.js como: mountProtected("/guias/estado", "./routes/estadoGuia")
router.post("/", canOperateGuia, async (req, res) => {
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
      `SELECT id, sucursal_origen_id, estado_logistico, estado_pago
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

    // ✅ Scope por sucursal (OWNER/ADMIN global)
    const owner = isOwnerOrAdmin(req);
    if (!owner) {
      if (!req.user?.sucursal_id) {
        await client.query("ROLLBACK");
        return res.status(403).json({ ok: false, error: "Usuario sin sucursal asignada" });
      }
      if (Number(guia.sucursal_origen_id) !== Number(req.user.sucursal_id)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ ok: false, error: "Sin permisos para esta guía" });
      }
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
