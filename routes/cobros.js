console.log("CARGANDO routes/cobros.js");

const express = require("express");
const router = express.Router();
const pool = require("../config/db");

const authMod = require("../middleware/auth");
const auth = authMod.auth || authMod;

const {
  CONDICION_PAGO,
  ESTADO_PAGO,
  TIPO_COBRO,
  ESTADO_COBRO,
  EVENTO_COBRO,
  SET_MEDIO_PAGO,
} = require("../utils/cobros.constants");

const { generarMovimientosPorCobro } = require("../services/contabilidadAgencias");

/* =========================================================
   Helpers
========================================================= */
function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

function asNum(v) {
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : NaN;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function norm(v) {
  return String(v ?? "").trim();
}

function hasRole(req, roles = []) {
  const role = String(req.user?.rol || req.user?.role || "").toUpperCase();
  return roles.map((r) => String(r).toUpperCase()).includes(role);
}

function getUserSucursalId(req) {
  return asInt(req.user?.sucursal_id);
}

function getUserId(req) {
  return asInt(req.user?.user_id ?? req.user?.id);
}

function toGuiasMetodoPago(medioPago) {
  const v = String(medioPago || "").trim().toLowerCase();

  if (v === "efectivo") return "EFECTIVO";
  if (v === "transferencia") return "TRANSFERENCIA";
  if (v === "qr") return "MERCADO_PAGO";

  return null;
}

async function getGuiaById(client, guiaId) {
  const q = `
    SELECT
      g.id,
      g.numero_guia,
      g.sucursal_origen_id,
      g.sucursal_destino_id,
      g.estado_logistico,
      g.condicion_pago,
      g.estado_pago,
      g.metodo_pago,
      g.monto_total,
      g.monto_cobrar_destino,
      g.cobro_obligatorio_entrega,
      g.cobrado_destino_at,
      g.cobrado_destino_por,
      g.rendido_at,
      g.rendido_by_user_id,
      g.rendido_by_usuario
    FROM guias g
    WHERE g.id = $1
    LIMIT 1
  `;
  const { rows } = await client.query(q, [guiaId]);
  return rows[0] || null;
}

function canAccessGuia(req, guia) {
  const role = String(req.user?.rol || req.user?.role || "").toUpperCase();
  const userSucursalId = getUserSucursalId(req);

  if (role === "OWNER" || role === "ADMIN") return true;

  if (role === "ENCARGADO" || role === "OPERADOR") {
    return (
      Number(guia.sucursal_origen_id) === Number(userSucursalId) ||
      Number(guia.sucursal_destino_id) === Number(userSucursalId)
    );
  }

  return false;
}

function isDestinoSucursalUserForGuia(req, guia) {
  const userSucursalId = getUserSucursalId(req);
  return Number(guia.sucursal_destino_id) === Number(userSucursalId);
}

async function insertCobroEvento(
  client,
  {
    guiaCobroId = null,
    guiaId,
    usuarioId,
    sucursalId,
    evento,
    detalle = {},
  }
) {
  await client.query(
    `
      INSERT INTO guia_cobro_eventos
      (guia_cobro_id, guia_id, usuario_id, sucursal_id, evento, detalle_json)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [
      guiaCobroId,
      guiaId,
      usuarioId,
      sucursalId,
      evento,
      JSON.stringify(detalle || {}),
    ]
  );
}

/* =========================================================
   POST /interno/cobros/registrar
   Registrar cobro de guía con pago en destino
========================================================= */
router.post("/registrar", auth, async (req, res) => {
  const guiaId = asInt(req.body?.guia_id);
  const medioPago = norm(req.body?.medio_pago).toLowerCase();
  const monto = round2(asNum(req.body?.monto));
  const referenciaExterna = norm(req.body?.referencia_externa || "");
  const observaciones = norm(req.body?.observaciones || "");

  const usuarioId = getUserId(req);
  const sucursalId = getUserSucursalId(req);
  const usuarioNombre = norm(req.user?.usuario || req.user?.nombre || "");

  if (!Number.isInteger(guiaId) || guiaId <= 0) {
    return res.status(400).json({ ok: false, error: "guia_id inválido." });
  }

  if (!SET_MEDIO_PAGO.has(medioPago)) {
    return res.status(400).json({ ok: false, error: "medio_pago inválido." });
  }

  if (!Number.isFinite(monto) || monto < 0) {
    return res.status(400).json({ ok: false, error: "monto inválido." });
  }

  if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
    return res.status(401).json({ ok: false, error: "Usuario inválido." });
  }

  if (!Number.isInteger(sucursalId) || sucursalId <= 0) {
    return res
      .status(400)
      .json({ ok: false, error: "Sucursal de usuario inválida." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const guia = await getGuiaById(client, guiaId);
    if (!guia) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Guía no encontrada." });
    }

    if (!canAccessGuia(req, guia)) {
      await client.query("ROLLBACK");
      return res
        .status(403)
        .json({ ok: false, error: "Sin acceso a esta guía." });
    }

    if (
      !hasRole(req, ["OWNER", "ADMIN"]) &&
      !isDestinoSucursalUserForGuia(req, guia)
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        ok: false,
        error: "Solo la sucursal destino puede registrar este cobro.",
      });
    }

    if (guia.condicion_pago !== CONDICION_PAGO.DESTINO) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "La guía no está configurada con pago en destino.",
      });
    }

    if (guia.estado_pago !== ESTADO_PAGO.PENDIENTE_DESTINO) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: `La guía no está pendiente de cobro en destino. Estado actual: ${guia.estado_pago}`,
      });
    }

    if (String(guia.estado_logistico || "").toUpperCase() !== "RECIBIDO_DESTINO") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error:
          "Solo se puede registrar cobro cuando la guía está en RECIBIDO_DESTINO.",
      });
    }

    const sucursalEvento =
      Number.isInteger(sucursalId) && sucursalId > 0
        ? sucursalId
        : asInt(guia.sucursal_destino_id);

    const montoEsperado = round2(asNum(guia.monto_cobrar_destino));
    if (!Number.isFinite(montoEsperado) || montoEsperado < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "La guía no tiene monto válido para cobro en destino.",
      });
    }

    if (round2(monto) !== round2(montoEsperado)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: `El monto debe coincidir exactamente con el monto a cobrar en destino (${montoEsperado}).`,
      });
    }

    await client.query(`SELECT id FROM guias WHERE id = $1 FOR UPDATE`, [guiaId]);

    const existingCobro = await client.query(
      `
        SELECT id, estado
        FROM guia_cobros
        WHERE guia_id = $1
          AND estado = $2
        LIMIT 1
      `,
      [guiaId, ESTADO_COBRO.REGISTRADO]
    );

    if (existingCobro.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "La guía ya tiene un cobro activo registrado.",
      });
    }

    const insertedCobro = await client.query(
      `
        INSERT INTO guia_cobros
        (
          guia_id,
          sucursal_id,
          usuario_id,
          tipo_cobro,
          medio_pago,
          monto,
          moneda,
          estado,
          referencia_externa,
          observaciones
        )
        VALUES
        ($1, $2, $3, $4, $5, $6, 'ARS', $7, $8, $9)
        RETURNING *
      `,
      [
        guiaId,
        sucursalId,
        usuarioId,
        TIPO_COBRO.DESTINO,
        medioPago,
        monto,
        ESTADO_COBRO.REGISTRADO,
        referenciaExterna || null,
        observaciones || null,
      ]
    );

    const cobro = insertedCobro.rows[0];
    const metodoPagoGuia = toGuiasMetodoPago(medioPago);

    await client.query(
      `
        UPDATE guias
        SET
          estado_pago = $1,
          cobrado_destino_at = NOW(),
          cobrado_destino_por = $2,
          metodo_pago = COALESCE($3, metodo_pago),
          rendido_at = NULL,
          rendido_by_user_id = NULL,
          rendido_by_usuario = NULL
        WHERE id = $4
      `,
      [
        ESTADO_PAGO.COBRADO_DESTINO,
        usuarioId,
        metodoPagoGuia,
        guiaId,
      ]
    );

    await insertCobroEvento(client, {
      guiaCobroId: cobro.id,
      guiaId,
      usuarioId,
      sucursalId: sucursalEvento,
      evento: EVENTO_COBRO.CREADO,
      detalle: {
        medio_pago: medioPago,
        monto,
        referencia_externa: referenciaExterna || null,
        observaciones: observaciones || null,
        usuario: usuarioNombre || null,
      },
    });

    const contabilidad = await generarMovimientosPorCobro(client, cobro.id);
    const guiaActualizada = await getGuiaById(client, guiaId);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      guia: guiaActualizada,
      cobro,
      contabilidad,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/cobros/registrar", err);
    return res
      .status(500)
      .json({ ok: false, error: "Error interno al registrar cobro." });
  } finally {
    client.release();
  }
});

/* =========================================================
   POST /interno/cobros/rendir
========================================================= */
router.post("/rendir", auth, async (req, res) => {
  const guiaId = asInt(req.body?.guia_id);

  const usuarioId = getUserId(req);
  const usuarioNombre = norm(req.user?.usuario || req.user?.nombre || "");

  if (!hasRole(req, ["OWNER", "ADMIN", "ENCARGADO"])) {
    return res.status(403).json({
      ok: false,
      error: "No tenés permisos para rendir cobros.",
    });
  }

  if (!Number.isInteger(guiaId) || guiaId <= 0) {
    return res.status(400).json({ ok: false, error: "guia_id inválido." });
  }

  if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
    return res.status(401).json({ ok: false, error: "Usuario inválido." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const guia = await getGuiaById(client, guiaId);
    if (!guia) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Guía no encontrada." });
    }

    console.log("RENDIR guia:", guia);
    console.log("RENDIR req.user:", req.user);

    if (!canAccessGuia(req, guia)) {
      await client.query("ROLLBACK");
      return res
        .status(403)
        .json({ ok: false, error: "Sin acceso a esta guía." });
    }

    const userSucursalId = getUserSucursalId(req);
    const sucursalEvento =
      Number.isInteger(userSucursalId) && userSucursalId > 0
        ? userSucursalId
        : asInt(guia.sucursal_destino_id);

    if (guia.condicion_pago !== CONDICION_PAGO.DESTINO) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "La guía no corresponde a pago en destino.",
      });
    }

    if (guia.estado_pago !== ESTADO_PAGO.COBRADO_DESTINO) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: `Solo se puede rendir una guía en estado ${ESTADO_PAGO.COBRADO_DESTINO}. Estado actual: ${guia.estado_pago}`,
      });
    }

    if (guia.rendido_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "La guía ya fue rendida.",
      });
    }

    const cobroQ = await client.query(
      `
        SELECT *
        FROM guia_cobros
        WHERE guia_id = $1
          AND estado = $2
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [guiaId, ESTADO_COBRO.REGISTRADO]
    );

    if (cobroQ.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        ok: false,
        error: "No existe un cobro registrado activo para esta guía.",
      });
    }

    const cobro = cobroQ.rows[0];

    if (cobro.rendido_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "El cobro ya fue rendido.",
      });
    }

    console.log("RENDIR cobro:", cobro);
    console.log("RENDIR sucursalEvento:", sucursalEvento);

    await client.query(
      `
        UPDATE guia_cobros
        SET
          rendido_at = NOW(),
          rendido_by_user_id = $1,
          rendido_by_usuario = $2,
          updated_at = NOW()
        WHERE id = $3
      `,
      [usuarioId, usuarioNombre || null, cobro.id]
    );

    await client.query(
      `
        UPDATE guias
        SET
          rendido_at = NOW(),
          rendido_by_user_id = $1,
          rendido_by_usuario = $2
        WHERE id = $3
      `,
      [usuarioId, usuarioNombre || null, guiaId]
    );

    await insertCobroEvento(client, {
      guiaCobroId: cobro.id,
      guiaId,
      usuarioId,
      sucursalId: sucursalEvento,
      evento: EVENTO_COBRO.RENDIDO,
      detalle: {
        cobro_id: cobro.id,
        monto: cobro.monto,
        medio_pago: cobro.medio_pago,
        usuario: usuarioNombre || null,
      },
    });

    const guiaActualizada = await getGuiaById(client, guiaId);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Cobro rendido correctamente.",
      guia: guiaActualizada,
      cobro_id: cobro.id,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/cobros/rendir", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al rendir cobro.",
      debug: err?.message || String(err),
      detail: err?.detail || null,
      code: err?.code || null,
    });
  } finally {
    client.release();
  }
});

/* =========================================================
   GET /interno/cobros/guia/:guiaId
========================================================= */
router.get("/guia/:guiaId", auth, async (req, res) => {
  const guiaId = asInt(req.params.guiaId);
  if (!Number.isInteger(guiaId) || guiaId <= 0) {
    return res.status(400).json({ ok: false, error: "guiaId inválido." });
  }

  const client = await pool.connect();
  try {
    const guia = await getGuiaById(client, guiaId);
    if (!guia) {
      return res.status(404).json({ ok: false, error: "Guía no encontrada." });
    }

    if (!canAccessGuia(req, guia)) {
      return res
        .status(403)
        .json({ ok: false, error: "Sin acceso a esta guía." });
    }

    const cobroActualQ = await client.query(
      `
        SELECT
          gc.id,
          gc.guia_id,
          gc.sucursal_id,
          gc.usuario_id,
          gc.tipo_cobro,
          gc.medio_pago,
          gc.monto,
          gc.moneda,
          gc.estado,
          gc.referencia_externa,
          gc.observaciones,
          gc.created_at,
          gc.updated_at,
          gc.rendido_at,
          gc.rendido_by_user_id,
          gc.rendido_by_usuario
        FROM guia_cobros gc
        WHERE gc.guia_id = $1
        ORDER BY gc.created_at DESC
        LIMIT 1
      `,
      [guiaId]
    );

    const eventosQ = await client.query(
      `
        SELECT
          e.id,
          e.guia_cobro_id,
          e.guia_id,
          e.usuario_id,
          e.sucursal_id,
          e.evento,
          e.detalle_json,
          e.created_at
        FROM guia_cobro_eventos e
        WHERE e.guia_id = $1
        ORDER BY e.created_at DESC
        LIMIT 50
      `,
      [guiaId]
    );

    return res.json({
      ok: true,
      guia,
      cobro_actual: cobroActualQ.rows[0] || null,
      eventos: eventosQ.rows,
    });
  } catch (err) {
    console.error("GET /interno/cobros/guia/:guiaId", err);
    return res
      .status(500)
      .json({ ok: false, error: "Error interno al consultar cobro." });
  } finally {
    client.release();
  }
});

/* =========================================================
   GET /interno/cobros/pendientes-destino
========================================================= */
router.get("/pendientes-destino", auth, async (req, res) => {
  const sucursalIdQuery = asInt(req.query?.sucursal_id);
  const userSucursalId = getUserSucursalId(req);
  const isPrivileged = hasRole(req, ["OWNER", "ADMIN"]);

  const sucursalFiltro =
    isPrivileged && Number.isInteger(sucursalIdQuery) && sucursalIdQuery > 0
      ? sucursalIdQuery
      : userSucursalId;

  const params = [
    CONDICION_PAGO.DESTINO,
    ESTADO_PAGO.PENDIENTE_DESTINO,
    sucursalFiltro,
  ];

  try {
    const { rows } = await pool.query(
      `
        SELECT
          g.id,
          g.numero_guia,
          g.estado_logistico,
          g.condicion_pago,
          g.estado_pago,
          g.metodo_pago,
          g.monto_total,
          g.monto_cobrar_destino,
          g.sucursal_origen_id,
          g.sucursal_destino_id,
          g.cobrado_destino_at,
          g.rendido_at
        FROM guias g
        WHERE g.condicion_pago = $1
          AND g.estado_pago = $2
          AND g.sucursal_destino_id = $3
        ORDER BY g.id DESC
        LIMIT 500
      `,
      params
    );

    return res.json({ ok: true, rows });
  } catch (err) {
    console.error("GET /interno/cobros/pendientes-destino", err);
    return res
      .status(500)
      .json({ ok: false, error: "Error interno al listar pendientes." });
  }
});

/* =========================================================
   GET /interno/cobros/cobrados-no-rendidos
========================================================= */
router.get("/cobrados-no-rendidos", auth, async (req, res) => {
  const sucursalIdQuery = asInt(req.query?.sucursal_id);
  const userSucursalId = getUserSucursalId(req);
  const isPrivileged = hasRole(req, ["OWNER", "ADMIN"]);

  const sucursalFiltro =
    isPrivileged && Number.isInteger(sucursalIdQuery) && sucursalIdQuery > 0
      ? sucursalIdQuery
      : userSucursalId;

  try {
    const { rows } = await pool.query(
      `
        SELECT
          g.id,
          g.numero_guia,
          g.estado_logistico,
          g.condicion_pago,
          g.estado_pago,
          g.metodo_pago,
          g.monto_total,
          g.monto_cobrar_destino,
          g.cobrado_destino_at,
          g.cobrado_destino_por,
          g.rendido_at,
          gc.id AS cobro_id,
          gc.medio_pago,
          gc.monto,
          gc.estado AS estado_cobro,
          gc.created_at AS cobro_created_at,
          gc.rendido_at AS cobro_rendido_at,
          gc.rendido_by_user_id,
          gc.rendido_by_usuario
        FROM guias g
        INNER JOIN guia_cobros gc
          ON gc.guia_id = g.id
         AND gc.estado = 'registrado'
        WHERE g.condicion_pago = 'destino'
          AND g.estado_pago = 'cobrado_destino'
          AND g.rendido_at IS NULL
          AND gc.rendido_at IS NULL
          AND g.sucursal_destino_id = $1
        ORDER BY gc.created_at DESC
        LIMIT 500
      `,
      [sucursalFiltro]
    );

    return res.json({ ok: true, rows });
  } catch (err) {
    console.error("GET /interno/cobros/cobrados-no-rendidos", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al listar cobrados no rendidos.",
    });
  }
});

/* =========================================================
   POST /interno/cobros/:id/anular
   Solo ADMIN / OWNER
========================================================= */
router.post("/:id/anular", auth, async (req, res) => {
  if (!hasRole(req, ["OWNER", "ADMIN"])) {
    return res.status(403).json({
      ok: false,
      error: "Solo OWNER o ADMIN pueden anular cobros.",
    });
  }

  const cobroId = asInt(req.params.id);
  const motivo = norm(req.body?.motivo);

  const usuarioId = getUserId(req);
  const sucursalId = getUserSucursalId(req);

  if (!Number.isInteger(cobroId) || cobroId <= 0) {
    return res.status(400).json({ ok: false, error: "id inválido." });
  }

  if (!motivo) {
    return res
      .status(400)
      .json({ ok: false, error: "El motivo es obligatorio." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cobroQ = await client.query(
      `
        SELECT *
        FROM guia_cobros
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [cobroId]
    );

    if (cobroQ.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Cobro no encontrado." });
    }

    const cobro = cobroQ.rows[0];

    if (cobro.estado !== ESTADO_COBRO.REGISTRADO) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: `Solo se puede anular un cobro en estado ${ESTADO_COBRO.REGISTRADO}.`,
      });
    }

    const guia = await getGuiaById(client, cobro.guia_id);
    if (!guia) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ ok: false, error: "Guía asociada no encontrada." });
    }

    await client.query(
      `
        UPDATE guia_cobros
        SET estado = $1
        WHERE id = $2
      `,
      [ESTADO_COBRO.ANULADO, cobroId]
    );

    await client.query(
      `
        UPDATE guias
        SET
          estado_pago = $1,
          cobrado_destino_at = NULL,
          cobrado_destino_por = NULL,
          metodo_pago = NULL,
          rendido_at = NULL,
          rendido_by_user_id = NULL,
          rendido_by_usuario = NULL
        WHERE id = $2
      `,
      [ESTADO_PAGO.PENDIENTE_DESTINO, cobro.guia_id]
    );

    await insertCobroEvento(client, {
      guiaCobroId: cobroId,
      guiaId: cobro.guia_id,
      usuarioId,
      sucursalId,
      evento: EVENTO_COBRO.ANULADO,
      detalle: { motivo },
    });

    const guiaActualizada = await getGuiaById(client, cobro.guia_id);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Cobro anulado correctamente.",
      guia: guiaActualizada,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/cobros/:id/anular", err);
    return res
      .status(500)
      .json({ ok: false, error: "Error interno al anular cobro." });
  } finally {
    client.release();
  }
});

/* =========================================================
   POST /interno/cobros/excepcion-entrega
   Solo ADMIN / OWNER
========================================================= */
router.post("/excepcion-entrega", auth, async (req, res) => {
  if (!hasRole(req, ["OWNER", "ADMIN"])) {
    return res.status(403).json({
      ok: false,
      error: "Solo OWNER o ADMIN pueden registrar excepción.",
    });
  }

  const guiaId = asInt(req.body?.guia_id);
  const motivo = norm(req.body?.motivo);

  const usuarioId = getUserId(req);
  const sucursalId = getUserSucursalId(req);

  if (!Number.isInteger(guiaId) || guiaId <= 0) {
    return res.status(400).json({ ok: false, error: "guia_id inválido." });
  }

  if (!motivo) {
    return res
      .status(400)
      .json({ ok: false, error: "El motivo es obligatorio." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const guia = await getGuiaById(client, guiaId);
    if (!guia) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Guía no encontrada." });
    }

    if (guia.condicion_pago !== CONDICION_PAGO.DESTINO) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "La guía no corresponde a pago en destino.",
      });
    }

    await client.query(
      `
        UPDATE guias
        SET estado_pago = $1
        WHERE id = $2
      `,
      [ESTADO_PAGO.OBSERVADO, guiaId]
    );

    await insertCobroEvento(client, {
      guiaCobroId: null,
      guiaId,
      usuarioId,
      sucursalId,
      evento: EVENTO_COBRO.EXCEPCION_AUTORIZADA,
      detalle: { motivo },
    });

    const guiaActualizada = await getGuiaById(client, guiaId);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      message: "Excepción de entrega registrada correctamente.",
      guia: guiaActualizada,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /interno/cobros/excepcion-entrega", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno al registrar excepción.",
    });
  } finally {
    client.release();
  }
});

module.exports = router;