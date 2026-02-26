function roleOf(req) {
  return String(req?.user?.rol || "").trim().toUpperCase();
}

function requireRole(...roles) {
  const allowed = roles.map((r) => String(r).toUpperCase());

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: "No autenticado" });
    }

    const rol = roleOf(req);

    if (!rol || !allowed.includes(rol)) {
      return res.status(403).json({
        ok: false,
        error: "Sin permisos (rol)",
      });
    }

    next();
  };
}

function isOwner(req) {
  return roleOf(req) === "OWNER";
}

function isOwnerOrAdmin(req) {
  const rol = roleOf(req);
  return rol === "OWNER" || rol === "ADMIN";
}

// Opcional: útil si después querés reglas especiales
function isOperadorLike(req) {
  const rol = roleOf(req);
  return rol === "OPERADOR" || rol === "ENCARGADO";
}

module.exports = {
  requireRole,
  isOwner,
  isOwnerOrAdmin,
  isOperadorLike,
  roleOf,
};
