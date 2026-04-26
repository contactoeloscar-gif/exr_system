"use strict";

const express = require("express");
const router = express.Router();
const {
  getNovedadesTorre,
  getDetalleGuiaTorre,
} = require("../services/torreControlService");

function getAuthUser(req, res) {
  return req.user || res.locals?.user || null;
}

function getRole(user) {
  return String(user?.rol || user?.role || "").trim().toUpperCase();
}

function requireAdminOwner(req, res, next) {
  const user = getAuthUser(req, res);
  const role = getRole(user);

  if (role === "ADMIN" || role === "OWNER") {
    req.authUser = user;
    return next();
  }

  return res.status(403).json({
    ok: false,
    error: "Sin permiso para acceder a Torre de Control.",
  });
}

function parseBool(v) {
  return v === true || v === 1 || v === "1" || v === "true";
}

function parseIntSafe(v, def = null) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

router.get("/novedades", requireAdminOwner, async (req, res) => {
  try {
    const filters = {
      sucursal_id: parseIntSafe(req.query.sucursal_id, null),
      prioridad: String(req.query.prioridad || "").trim().toUpperCase(),
      tipo_accion: String(req.query.tipo_accion || "").trim().toUpperCase(),
      solo_criticas: parseBool(req.query.solo_criticas),
      sin_movimiento_desde_horas: parseIntSafe(req.query.sin_movimiento_desde_horas, null),
      fecha_desde: String(req.query.fecha_desde || "").trim(),
      fecha_hasta: String(req.query.fecha_hasta || "").trim(),
      limit: parseIntSafe(req.query.limit, 200),
      offset: parseIntSafe(req.query.offset, 0),
    };

    const data = await getNovedadesTorre(filters);

    return res.json({
      ok: true,
      ...data,
    });
  } catch (err) {
    console.error("GET /interno/torre-control/novedades error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al cargar Torre de Control.",
      debug: err.message,
    });
  }
});

router.get("/guias/:guiaId", requireAdminOwner, async (req, res) => {
  try {
    const guiaId = Number(req.params.guiaId);
    if (!Number.isFinite(guiaId) || guiaId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "guiaId inválido.",
      });
    }

    const data = await getDetalleGuiaTorre(guiaId);

    if (!data) {
      return res.status(404).json({
        ok: false,
        error: "Guía no encontrada.",
      });
    }

    return res.json({
      ok: true,
      ...data,
    });
  } catch (err) {
    console.error("GET /interno/torre-control/guias/:guiaId error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al cargar detalle de guía.",
      debug: err.message,
    });
  }
});

module.exports = router;