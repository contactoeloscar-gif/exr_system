(() => {
  const LS_TOKEN = "exr_token";
  const $ = (id) => document.getElementById(id);

  function token(){ return localStorage.getItem(LS_TOKEN); }

  async function safeReadJson(resp){
    const text = await resp.text();
    try { return text ? JSON.parse(text) : {}; } catch { return { _raw: text }; }
  }

  async function api(url){
    const t = token();
    const resp = await fetch(url, {
      headers: { Authorization: "Bearer " + t }
    });
    const data = await safeReadJson(resp);
    if(!resp.ok || data.ok === false){
      throw new Error(data?.error || ("HTTP " + resp.status));
    }
    return data;
  }

  function fmtDate(iso){
    if(!iso) return "-";
    try{ return new Date(iso).toLocaleDateString("es-AR"); }catch{ return iso; }
  }

  async function main(){
    const params = new URLSearchParams(location.search);
    const guiaId = params.get("id");
    const b = params.get("b"); // opcional

    if(!guiaId) throw new Error("Falta ?id=GUÍA_ID");

    const url = "/interno/etiqueta/" + encodeURIComponent(guiaId) + (b ? `?b=${encodeURIComponent(b)}` : "");
    const r = await api(url);
    const e = r.etiqueta;

    $("qrImg").src = e.qr_data_url;
    $("numero").textContent = e.numero_guia;
    $("origen").textContent = e.origen;
    $("destino").textContent = e.destino;

    $("bultos").textContent = String(e.cant_bultos ?? 0);
    $("pago").textContent = e.estado_pago;
    $("estado").textContent = e.estado_logistico;
    $("fecha").textContent = fmtDate(e.created_at);
    $("suc").textContent = `Guía ID: ${e.guia_id}`;

    // NUEVO: mostrar "BULTO i / N" si viene bulto_nro
    const bl = $("bultoLine");
    if (bl) {
      bl.textContent = e.bulto_nro ? `BULTO ${e.bulto_nro} / ${e.cant_bultos ?? 0}` : "";
    }

    if(e.fragil){
      $("fragilBox").classList.add("on");
    }

    // Esperar a que cargue el QR para imprimir
    const img = $("qrImg");
    if(!img.complete){
      await new Promise(res => img.onload = res);
    }

    // Imprime automáticamente
    if (!params.get("nop")) window.print();
  }

  main().catch(err => {
    document.body.innerHTML = `<pre style="padding:16px;font-family:ui-monospace">${String(err.message || err)}</pre>`;
  });
})();
