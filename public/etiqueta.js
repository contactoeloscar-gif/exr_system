(() => {
  const LS_TOKEN = "exr_token";
  const $ = (id) => document.getElementById(id);

  function token() {
    const t = (localStorage.getItem(LS_TOKEN) || "").trim();
    return t.replace(/^Bearer\s+/i, "").trim();
  }

  async function safeReadJson(resp) {
    const text = await resp.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { _raw: text };
    }
  }

  async function api(url) {
    const t = token();
    const resp = await fetch(url, {
      headers: { Authorization: "Bearer " + t }
    });
    const data = await safeReadJson(resp);
    if (!resp.ok || data.ok === false) {
      throw new Error(data?.error || ("HTTP " + resp.status));
    }
    return data;
  }

  function fmtDate(iso) {
    if (!iso) return "-";
    try {
      return new Date(iso).toLocaleDateString("es-AR");
    } catch {
      return iso;
    }
  }

  function pagoVisible(e) {
    const forma = String(
      e.condicion_pago || e.forma_pago || e.tipo_cobro || ""
    ).trim().toUpperCase();

    const estado = String(e.estado_pago || "").trim().toLowerCase();

    if (forma === "ORIGEN") {
      if (estado === "observado") return "OBSERVADO";
      return "PAGADO";
    }

    if (forma === "DESTINO") {
      if (estado === "cobrado_destino" || estado === "rendido") return "PAGADO";
      if (estado === "observado") return "OBSERVADO";
      return "PENDIENTE";
    }

    if (estado === "cobrado_destino" || estado === "rendido") return "PAGADO";
    if (estado === "pendiente_destino" || estado === "pendiente_origen") return "PENDIENTE";
    if (estado === "observado") return "OBSERVADO";
    if (estado === "no_aplica") return "PAGADO";

    return (e.estado_pago || "-");
  }

  async function main() {
    const params = new URLSearchParams(location.search);
    const guiaId = params.get("id");
    const b = params.get("b"); // opcional

    if (!guiaId) throw new Error("Falta ?id=GUÍA_ID");

    const url = "/interno/etiqueta/" + encodeURIComponent(guiaId) + (b ? `?b=${encodeURIComponent(b)}` : "");
    const r = await api(url);
    const e = r.etiqueta;

    $("qrImg").src = e.qr_data_url;
    $("numero").textContent = e.numero_guia;
    $("origen").textContent = e.origen;
    $("destino").textContent = e.destino;

    $("bultos").textContent = String(e.cant_bultos ?? 0);
    $("pago").textContent = pagoVisible(e);
    $("estado").textContent = e.estado_logistico;
    $("fecha").textContent = fmtDate(e.created_at);
    $("suc").textContent = `Guía ID: ${e.guia_id}`;

    const destBox = $("destBox");
    const nom = String(e.destinatario_nombre || "").trim();
    const tel = String(e.destinatario_telefono || "").trim();
    const dir = String(e.destinatario_direccion || "").trim();

    if (!nom && !tel && !dir) {
      if (destBox) destBox.style.display = "none";
    } else {
      if ($("destNombre")) $("destNombre").textContent = nom || "—";
      if ($("destTel")) $("destTel").textContent = tel ? `Tel: ${tel}` : "";
      if ($("destDir")) $("destDir").textContent = dir ? `Dir: ${dir}` : "";
    }

    const n = Number(params.get("n") || 0);
    const bultoNro = Number(e.bulto_nro || b || 0);
    const cantBultos = Number(e.cant_bultos || n || 0);

    const bl = $("bultoLine");
      if (bl) {
      bl.textContent = bultoNro > 0 ? `BULTO ${bultoNro} / ${cantBultos || 0}` : "";
    }


    if (e.fragil) {
      $("fragilBox").classList.add("on");
    }

    const img = $("qrImg");
    if (!img.complete) {
      await new Promise((res) => (img.onload = res));
    }

    await new Promise((r) => setTimeout(r, 0));

    window.__EXR_ETIQUETA_READY = true;

    if (!params.get("nop")) window.print();
  }

  main().catch(err => {
    document.body.innerHTML = `<pre style="padding:16px;font-family:ui-monospace">${String(err.message || err)}</pre>`;
  });
})();