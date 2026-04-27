(() => {
  const LS_TOKEN = "exr_token";
  const $ = (id) => document.getElementById(id);

  function token() {
    return (localStorage.getItem(LS_TOKEN) || "")
      .replace(/^Bearer\s+/i, "")
      .trim();
  }

  async function api(url) {
    const resp = await fetch(url, {
      headers: {
        Authorization: "Bearer " + token(),
      },
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok || data.ok === false) {
      throw new Error(data.error || "No se pudo cargar el comprobante.");
    }

    return data;
  }

  function fmtDate(v) {
    if (!v) return "-";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleDateString("es-AR");
  }

  function money(v) {
    const n = Number(v || 0);
    return n.toLocaleString("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    });
  }

  function pagoVisible(e) {
    const forma = String(e.condicion_pago || e.tipo_cobro || "").toUpperCase();
    const estado = String(e.estado_pago || "").toLowerCase();

    if (forma === "ORIGEN") return "PAGO EN ORIGEN";
    if (forma === "DESTINO") return "PAGO EN DESTINO";

    if (estado.includes("destino")) return "PAGO EN DESTINO";
    return forma || "-";
  }

  function importeVisible(e) {
    const forma = String(e.condicion_pago || e.tipo_cobro || "").toUpperCase();

    if (forma === "DESTINO") {
      return money(e.monto_cobrar_destino || e.monto_total);
    }

    return money(e.monto_total || e.monto_cobrar_destino);
  }

  async function main() {
    const params = new URLSearchParams(location.search);
    const guiaId = params.get("id");

    if (!guiaId) {
      throw new Error("Falta ?id=GUÍA_ID");
    }

    const r = await api("/interno/etiqueta/" + encodeURIComponent(guiaId));
    const e = r.etiqueta || {};

    $("numero").textContent = e.numero_guia || "-";
    $("fecha").textContent = fmtDate(e.created_at);
    $("estado").textContent = e.estado_logistico || "-";

    $("origen").textContent = e.origen || "-";
    $("destino").textContent = e.destino || "-";

    $("remitente").textContent = [
      e.remitente_nombre,
      e.remitente_telefono ? "Tel: " + e.remitente_telefono : "",
    ].filter(Boolean).join(" · ") || "-";

    $("destinatario").textContent = [
      e.destinatario_nombre,
      e.destinatario_telefono ? "Tel: " + e.destinatario_telefono : "",
    ].filter(Boolean).join(" · ") || "-";

    $("direccion").textContent = e.destinatario_direccion || "-";
    $("bultos").textContent = String(e.cant_bultos || 0);
    $("pago").textContent = pagoVisible(e);
    $("importe").textContent = importeVisible(e);
    $("condicion").textContent = String(e.condicion_pago || e.tipo_cobro || "-").toUpperCase();

    if (!params.get("nop")) {
      setTimeout(() => window.print(), 300);
    }
  }

  main().catch((err) => {
    document.body.innerHTML = `<pre style="padding:16px;font-family:monospace">${String(err.message || err)}</pre>`;
  });
})();