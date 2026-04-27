// routes/etiquetas.js
const express = require("express");
const QRCode = require("qrcode");
const pool = require("../config/db");

const router = express.Router();

const SQL_GUIAS_SELECT = `
  g.id, g.numero_guia, g.created_at,
  g.sucursal_origen_id, g.sucursal_destino_id,
  so.nombre AS sucursal_origen_nombre,
  so.codigo AS sucursal_origen_codigo,
  sd.nombre AS sucursal_destino_nombre,
  sd.codigo AS sucursal_destino_codigo,

  g.estado_logistico,
  g.estado_pago,
  g.condicion_pago,
  g.tipo_cobro,
  g.metodo_pago,

  g.monto_total,
  g.monto_cobrar_destino,
  g.cobro_obligatorio_entrega,
  g.cobrado_destino_at,

  g.rendido_at,
  g.rendido_by_user_id,
  g.rendido_by_usuario,

  g.remitente_nombre, g.remitente_telefono,
  g.destinatario_nombre, g.destinatario_telefono, g.destinatario_direccion,

  COALESCE(b.cant_bultos,0) AS cant_bultos,
  g.fragil,

  false AS observada,
  false AS excepcion_entrega,

  NULL::bigint AS cierre_id,
  NULL::text AS cierre_estado_db,
  NULL::date AS cierre_fecha,

  NULL::bigint AS liquidacion_id,
  NULL::text AS liquidacion_estado_db,

  NULL::bigint AS conciliacion_id,
  NULL::text AS conciliacion_estado_db,

  NULL::text AS ultimo_evento,
  NULL::timestamp AS ultimo_evento_at
`;

const SQL_GUIAS_JOINS = `
  LEFT JOIN sucursales so ON so.id = g.sucursal_origen_id
  LEFT JOIN sucursales sd ON sd.id = g.sucursal_destino_id
  LEFT JOIN (
    SELECT guia_id, COALESCE(SUM(cantidad),0)::int AS cant_bultos
    FROM guia_items
    GROUP BY guia_id
  ) b ON b.guia_id = g.id
`;

async function fetchGuiaForEtiqueta(guiaId) {
  const q = await pool.query(
    `
      SELECT ${SQL_GUIAS_SELECT}
      FROM guias g
      ${SQL_GUIAS_JOINS}
      WHERE g.id = $1
      LIMIT 1
    `,
    [guiaId]
  );

  return q.rows?.[0] || null;
}

router.get("/etiqueta/:guiaId", async (req, res) => {
  try {
    const guiaId = Number(req.params.guiaId);
    const b = req.query.b ? Number(req.query.b) : null;

    if (!guiaId || Number.isNaN(guiaId)) {
      return res.status(400).json({ ok: false, error: "guiaId inválido" });
    }

    if (b !== null && (Number.isNaN(b) || b < 1)) {
      return res.status(400).json({ ok: false, error: "b inválido (>=1)" });
    }

    const guia = await fetchGuiaForEtiqueta(guiaId);

    if (!guia) {
      return res.status(404).json({ ok: false, error: "Guía no encontrada" });
    }

    const rol = String(req.user?.rol || "").trim().toUpperCase();
    const owner = rol === "OWNER" || rol === "ADMIN";

    if (!owner) {
      const s = Number(req.user?.sucursal_id);
      if (!s) {
        return res
          .status(403)
          .json({ ok: false, error: "Usuario sin sucursal asignada" });
      }

      const ok =
        Number(guia.sucursal_origen_id) === s ||
        Number(guia.sucursal_destino_id) === s;

      if (!ok) {
        return res
          .status(403)
          .json({ ok: false, error: "Sin permisos para esta guía" });
      }
    }

    const total = Math.max(1, Number(guia.cant_bultos || 0));

    if (b !== null && b > total) {
      return res
        .status(400)
        .json({ ok: false, error: `Bulto fuera de rango (1..${total})` });
    }

    const qrText = b ? `${guia.numero_guia}#B${b}/${total}` : guia.numero_guia;
    const qrDataUrl = await QRCode.toDataURL(qrText, { margin: 1, scale: 6 });

    const origenLabel =
      `${guia.sucursal_origen_codigo ? guia.sucursal_origen_codigo + " — " : ""}` +
      `${guia.sucursal_origen_nombre || "Sucursal " + guia.sucursal_origen_id}`;

    const destinoLabel =
      `${guia.sucursal_destino_codigo ? guia.sucursal_destino_codigo + " — " : ""}` +
      `${guia.sucursal_destino_nombre || "Sucursal " + guia.sucursal_destino_id}`;

    return res.json({
      ok: true,
      etiqueta: {
        guia_id: guia.id,
        numero_guia: guia.numero_guia,
        origen: origenLabel,
        destino: destinoLabel,
        cant_bultos: total,
        bulto_nro: b,
        estado_pago: guia.estado_pago,
        condicion_pago: guia.condicion_pago,
        monto_cobrar_destino: guia.monto_cobrar_destino,
        estado_logistico: guia.estado_logistico,
        created_at: guia.created_at,
        fragil: !!guia.fragil,
        qr_data_url: qrDataUrl,
        qr_payload: qrText,
        remitente_nombre: guia.remitente_nombre,
        remitente_telefono: guia.remitente_telefono,
        destinatario_nombre: guia.destinatario_nombre,
        destinatario_telefono: guia.destinatario_telefono,
        destinatario_direccion: guia.destinatario_direccion,
        monto_total: guia.monto_total,
        monto_cobrar_destino: guia.monto_cobrar_destino,
      },
    });
  } catch (e) {
    console.error("GET /interno/etiqueta/:guiaId error:", e);
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

module.exports = router;