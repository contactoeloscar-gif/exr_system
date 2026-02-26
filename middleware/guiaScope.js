const pool = require("../config/db");
const { isOwnerOrAdmin, roleOf } = require("./roles");

/**
 * Middleware PRO: valida que el usuario pueda operar una guía según políticas.
 *
 * Uso:
 *   router.post("/estado", canOperateGuia({ allowOrigen:true, allowDestino:false }), handler)
 *
 * Opciones:
 * - allowOrigen: si permite operar cuando sucursal_origen_id = user.sucursal_id
 * - allowDestino: si permite operar cuando sucursal_destino_id = user.sucursal_id
 * - rolesAllow: lista de roles permitidos (si se setea, exige que el rol esté incluido)
 * - ownerBypass: si true, OWNER/ADMIN saltean scope (default true)
 * - attachToReq: si true, setea req.guia con la guía (default true)
 */
function canOperateGuia(opts = {}) {
  const {
    allowOrigen = true,
    allowDestino = true,
    rolesAllow = null,
    ownerBypass = true,
    attachToReq = true,
  } = opts;

  return async (req, res, next) => {
    try {
      const guiaId = Number(req.params?.id || req.body?.guia_id || req.body?.id);
      if (!Number.isFinite(guiaId) || guiaId <= 0) {
        return res.status(400).json({ ok: false, error: "Falta guia_id válido" });
      }

      // Si se definió rolesAllow, validar rol
      if (Array.isArray(rolesAllow) && rolesAllow.length > 0) {
        const r = roleOf(req);
        const allowed = rolesAllow.map((x) => String(x).toUpperCase());
        if (!allowed.includes(r)) {
          return res.status(403).json({ ok: false, error: "Sin permisos (rol)" });
        }
      }

      const { rows } = await pool.query(
        `SELECT
           id,
           sucursal_origen_id,
           sucursal_destino_id,
           estado_logistico,
           estado_pago
         FROM guias
         WHERE id = $1`,
        [guiaId]
      );

      const guia = rows[0];
      if (!guia) return res.status(404).json({ ok: false, error: "Guía no encontrada" });

      // OWNER/ADMIN bypass global
      if (ownerBypass && isOwnerOrAdmin(req)) {
        if (attachToReq) req.guia = guia;
        return next();
      }

      // Requiere sucursal
      const s = Number(req.user?.sucursal_id);
      if (!Number.isFinite(s) || s <= 0) {
        return res.status(403).json({ ok: false, error: "Usuario sin sucursal asignada" });
      }

      const isOrigen = Number(guia.sucursal_origen_id) === s;
      const isDestino = Number(guia.sucursal_destino_id) === s;

      const ok = (allowOrigen && isOrigen) || (allowDestino && isDestino);

      if (!ok) {
        return res.status(403).json({
          ok: false,
          error: "Sin permiso: la guía no pertenece a tu scope",
        });
      }

      if (attachToReq) req.guia = guia;
      return next();
    } catch (e) {
      console.error("canOperateGuia(PRO):", e);
      return res.status(500).json({ ok: false, error: "Error de permisos" });
    }
  };
}

module.exports = { canOperateGuia };
