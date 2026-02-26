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
    const resp = await fetch(url, { headers: { Authorization: "Bearer " + t }});
    const data = await safeReadJson(resp);
    if(!resp.ok || data.ok === false){
      throw new Error(data?.error || ("HTTP " + resp.status));
    }
    return data;
  }

  function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

  async function waitFrameLoad(frame){
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("Timeout cargando etiqueta")), 15000);
      frame.onload = () => { clearTimeout(to); resolve(); };
    });
  }

  async function printFrame(frame){
    frame.contentWindow.focus();
    frame.contentWindow.print();
    await sleep(600);
  }

  function waitUserClick(btn){
    return new Promise((resolve) => {
      const h = () => { btn.removeEventListener("click", h); resolve(); };
      btn.addEventListener("click", h);
    });
  }

  async function main(){
    const params = new URLSearchParams(location.search);
    const guiaId = params.get("id");
    if(!guiaId) throw new Error("Falta ?id=GUÍA_ID");

    const status = $("status");
    const frame = $("frame");
    const safeModeEl = $("safeMode");
    const btnNext = $("btnNext");
    const btnRetry = $("btnRetry");
    const btnCancel = $("btnCancel");

    let cancelled = false;
    let currentB = 1;
    let total = 0;
    let lastStep = "idle"; // load|printed

    btnCancel?.addEventListener("click", () => {
      cancelled = true;
      status.textContent = "Cancelado.";
      btnNext.disabled = true;
      btnRetry.disabled = true;
    });

    // 1) Obtener total bultos
    status.textContent = "Leyendo bultos…";
    const r = await api("/interno/etiqueta/" + encodeURIComponent(guiaId));
    total = Number(r?.etiqueta?.cant_bultos || 0);
    if (!total) {
      status.textContent = "Esta guía no tiene bultos cargados.";
      return;
    }

    // Helpers para botones
    const setButtons = ({ next, retry }) => {
      btnNext.disabled = !next;
      btnRetry.disabled = !retry;
    };

    btnRetry?.addEventListener("click", async () => {
      if (cancelled) return;
      // reintenta imprimir el mismo bulto sin avanzar
      try {
        status.textContent = `Reintentando impresión bulto ${currentB} / ${total}…`;
        await printFrame(frame);
        lastStep = "printed";
        status.textContent = `Impreso bulto ${currentB} / ${total}.`;
        setButtons({ next: true, retry: true });
      } catch (e) {
        status.textContent = `Error reintentando: ${e.message || e}`;
      }
    });

    // 2) Loop
    while (currentB <= total && !cancelled) {
      const safe = !!safeModeEl?.checked;

      // cargar etiqueta
      status.textContent = `Cargando bulto ${currentB} / ${total}…`;
      setButtons({ next: false, retry: false });
      lastStep = "load";

      frame.src = `/etiqueta.html?id=${encodeURIComponent(guiaId)}&b=${currentB}&nop=1`;
      await waitFrameLoad(frame);

      // imprimir
      status.textContent = `Imprimiendo bulto ${currentB} / ${total}…`;
      await printFrame(frame);
      lastStep = "printed";

      status.textContent = `Impreso bulto ${currentB} / ${total}.`;
      setButtons({ next: true, retry: true });

      // modo seguro: espera confirmación
      if (safe) {
        status.textContent = `Impreso bulto ${currentB} / ${total}. Tocá “Continuar” para seguir.`;
        await waitUserClick(btnNext);
      } else {
        // modo rápido: micro pausa
        await sleep(250);
      }

      // avanzar al próximo
      currentB++;
    }

    if (!cancelled) {
      status.textContent = `Listo: ${total} etiquetas impresas.`;
      setButtons({ next: false, retry: false });
    }
  }

  main().catch(err => {
    document.body.innerHTML = `<pre style="padding:16px;font-family:ui-monospace">${String(err.message || err)}</pre>`;
  });
})();
