// public/etiqueta_batch.js (PRO v3.0) — LISTO PARA PEGAR
(() => {
  const LS_TOKEN = "exr_token";
  const $ = (id) => document.getElementById(id);

  function rawToken() {
    return (localStorage.getItem(LS_TOKEN) || "").trim();
  }

  function token() {
    return rawToken().replace(/^Bearer\s+/i, "").trim();
  }

  async function safeReadJson(resp) {
    const text = await resp.text();
    try { return text ? JSON.parse(text) : {}; }
    catch { return { _raw: text }; }
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

  function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  async function waitEtiquetaReady(frame, ms = 15000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      try {
        if (frame.contentWindow && frame.contentWindow.__EXR_ETIQUETA_READY) return true;
      } catch (_) {}
      await sleep(50);
    }
    throw new Error("Timeout esperando datos de etiqueta");
  }

  async function waitFrameLoad(frame, ms = 15000) {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("Timeout cargando etiqueta")), ms);
      frame.onload = () => {
        clearTimeout(to);
        frame.onload = null;
        resolve();
      };
    });
  }

  async function printFrame(frame) {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    await sleep(700);
  }

  function waitUserClick(btn) {
    return new Promise((resolve) => {
      const h = () => {
        btn.removeEventListener("click", h);
        resolve();
      };
      btn.addEventListener("click", h);
    });
  }

  function esc(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function hardFail(msg) {
    document.body.innerHTML = `<pre style="padding:16px;font-family:ui-monospace">${msg}</pre>`;
  }

  function getParams() {
    return new URLSearchParams(location.search);
  }

  function getPreferredMode() {
    const params = getParams();
    const mode = String(params.get("mode") || "").trim().toLowerCase();
    return mode === "a4" ? "a4" : "thermal";
  }

  function etiquetaUrl({ guiaId, b, n }) {
    const ts = Date.now();
    return `${location.origin}/etiqueta.html?id=${encodeURIComponent(guiaId)}&b=${encodeURIComponent(b)}&n=${encodeURIComponent(n)}&nop=1&_=${ts}`;
  }

  function pagoVisible(data) {
    const forma = String(
      data?.condicion_pago || data?.forma_pago || data?.tipo_cobro || ""
    ).trim().toUpperCase();

    const estado = String(data?.estado_pago || "").trim().toLowerCase();

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

    return data?.estado_pago || "-";
  }

  async function resolveEtiquetaData({ guiaId, b, total }) {
    const r = await api(`/interno/etiqueta/${encodeURIComponent(guiaId)}?b=${encodeURIComponent(b)}`);
    const e = r.etiqueta || {};

    return {
      ...e,
      bulto_nro: Number(e?.bulto_nro || b || 1),
      cant_bultos: Number(e?.cant_bultos || total || 1),
      pago_visible: pagoVisible(e),
    };
  }

  async function buildA4Html({ guiaId, total }) {
    const pages = [];

    for (let b = 1; b <= total; b++) {
      const e = await resolveEtiquetaData({ guiaId, b, total });

      pages.push(`
        <div class="label">
          <div class="head">
            <div class="brand">EXR encomiendas</div>
            <div class="bulto">BULTO ${esc(e.bulto_nro)} / ${esc(e.cant_bultos)}</div>
          </div>

          <div class="numero">${esc(e.numero_guia || "-")}</div>

          <div class="grid">
            <div><span class="k">Origen:</span> ${esc(e.origen || "-")}</div>
            <div><span class="k">Destino:</span> ${esc(e.destino || "-")}</div>
            <div><span class="k">Pago:</span> ${esc(e.pago_visible || "-")}</div>
            <div><span class="k">Estado:</span> ${esc(e.estado_logistico || "-")}</div>
          </div>

          <div class="dest">
            <div><span class="k">Destinatario:</span> ${esc(e.destinatario_nombre || "-")}</div>
            <div><span class="k">Tel:</span> ${esc(e.destinatario_telefono || "-")}</div>
            <div><span class="k">Dir:</span> ${esc(e.destinatario_direccion || "-")}</div>
          </div>

          <div class="qr-wrap">
            <img src="${esc(e.qr_data_url || "")}" alt="QR" />
          </div>
        </div>
      `);
    }

    return `
      <!doctype html>
      <html lang="es">
      <head>
        <meta charset="utf-8" />
        <title>Etiquetas A4</title>
        <style>
          @page {
            size: A4;
            margin: 10mm;
          }

          * { box-sizing: border-box; }

          body {
            margin: 0;
            font-family: Arial, Helvetica, sans-serif;
            color: #111;
            background: #fff;
          }

          .sheet {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8mm;
            padding: 10mm;
          }

          .label {
            border: 1px solid #222;
            border-radius: 3mm;
            padding: 4mm;
            min-height: 128mm;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            page-break-inside: avoid;
          }

          .head {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            align-items: flex-start;
            margin-bottom: 4mm;
          }

          .brand {
            font-size: 16px;
            font-weight: 700;
          }

          .bulto {
            font-size: 12px;
            font-weight: 700;
          }

          .numero {
            font-size: 20px;
            font-weight: 800;
            margin-bottom: 4mm;
          }

          .grid, .dest {
            display: grid;
            gap: 2mm;
            font-size: 12px;
          }

          .k {
            font-weight: 700;
          }

          .qr-wrap {
            display: flex;
            justify-content: center;
            margin-top: 5mm;
          }

          .qr-wrap img {
            width: 42mm;
            height: 42mm;
            object-fit: contain;
          }

          @media print {
            .sheet {
              padding: 0;
            }
          }
        </style>
      </head>
      <body>
        <div class="sheet">
          ${pages.join("")}
        </div>
        <script>
          window.onload = () => {
            setTimeout(() => window.print(), 250);
          };
        </script>
      </body>
      </html>
    `;
  }

  async function openA4Window({ guiaId, total, status }) {
    status.textContent = `Armando A4 (${total} bultos)…`;

    const html = await buildA4Html({ guiaId, total });
    const win = window.open("", "_blank");

    if (!win) {
      throw new Error("El navegador bloqueó la ventana de impresión A4.");
    }

    win.document.open();
    win.document.write(html);
    win.document.close();

    status.textContent = `A4 listo: ${total} etiquetas.`;
  }

  async function runThermalMode({ guiaId, total, status, frame, safeModeEl, btnNext, btnRetry, btnCancel }) {
    let cancelled = false;
    let currentB = 1;

    const setButtons = ({ next, retry }) => {
      btnNext.disabled = !next;
      btnRetry.disabled = !retry;
    };

    btnCancel.onclick = () => {
      cancelled = true;
      status.textContent = "Cancelado.";
      setButtons({ next: false, retry: false });
    };

    btnRetry.onclick = async () => {
      if (cancelled) return;
      try {
        status.textContent = `Reintentando impresión bulto ${currentB} / ${total}…`;
        await printFrame(frame);
        status.textContent = `Impreso bulto ${currentB} / ${total}.`;
        setButtons({ next: true, retry: true });
      } catch (e) {
        status.textContent = `Error reintentando: ${e.message || e}`;
      }
    };

    while (currentB <= total && !cancelled) {
      const safe = !!safeModeEl?.checked;

      status.textContent = `Cargando bulto ${currentB} / ${total}…`;
      setButtons({ next: false, retry: false });

      try {
        if (frame.contentWindow) frame.contentWindow.__EXR_ETIQUETA_READY = false;
      } catch (_) {}

      frame.src = etiquetaUrl({ guiaId, b: currentB, n: total });

      try {
        await waitFrameLoad(frame, 15000);
      } catch (e) {
        status.textContent = `Error cargando bulto ${currentB}: ${e.message || e}. Reintentá.`;
        setButtons({ next: false, retry: true });

        if (safe) {
          await sleep(200);
          continue;
        }

        await sleep(400);
        frame.src = etiquetaUrl({ guiaId, b: currentB, n: total });
        await waitFrameLoad(frame, 15000);
      }

      await waitEtiquetaReady(frame, 15000);

      status.textContent = `Imprimiendo bulto ${currentB} / ${total}…`;
      await printFrame(frame);

      status.textContent = `Impreso bulto ${currentB} / ${total}.`;
      setButtons({ next: true, retry: true });

      if (safe) {
        status.textContent = `Impreso bulto ${currentB} / ${total}. Tocá “Continuar” para seguir.`;
        await waitUserClick(btnNext);
      } else {
        await sleep(250);
      }

      currentB++;
    }

    if (!cancelled) {
      status.textContent = `Listo: ${total} etiquetas impresas.`;
      setButtons({ next: false, retry: false });
    }
  }

  async function main() {
    const params = getParams();
    const guiaId = params.get("id");
    if (!guiaId) throw new Error("Falta ?id=GUÍA_ID");

    const status = $("status");
    const frame = $("frame");
    const safeModeEl = $("safeMode");
    const btnNext = $("btnNext");
    const btnRetry = $("btnRetry");
    const btnCancel = $("btnCancel");
    const btnPrintA4 = $("btnPrintA4");
    const btnThermal = $("btnThermal");
    const printMode = $("printMode");
    const safeWrap = $("safeWrap");

    if (!status || !frame || !btnNext || !btnRetry || !btnCancel || !btnPrintA4 || !btnThermal || !printMode || !safeWrap) {
      hardFail("Error: faltan elementos del DOM en etiqueta_batch.html.");
      return;
    }

    if (!token()) {
      status.textContent = "Sesión vencida. Volvé a ingresar.";
      btnNext.disabled = true;
      btnRetry.disabled = true;
      btnPrintA4.disabled = true;
      btnThermal.disabled = true;
      return;
    }

    status.textContent = "Leyendo bultos…";

    const nParam = Number(params.get("n") || 0);
    let total = 0;

    if (Number.isFinite(nParam) && nParam > 0) {
      total = Math.floor(nParam);
    } else {
      const r = await api("/interno/etiqueta/" + encodeURIComponent(guiaId));
      total = Number(r?.etiqueta?.cant_bultos || 0);
    }

    if (!total) {
      status.textContent = "Esta guía no tiene bultos cargados.";
      btnNext.disabled = true;
      btnRetry.disabled = true;
      btnPrintA4.disabled = true;
      btnThermal.disabled = true;
      return;
    }

    printMode.value = getPreferredMode();

    function syncModeUI() {
      const mode = printMode.value;
      const isA4 = mode === "a4";

      frame.classList.toggle("hidden", isA4);
      safeWrap.classList.toggle("hidden", isA4);
      btnNext.classList.toggle("hidden", isA4);
      btnRetry.classList.toggle("hidden", isA4);

      btnPrintA4.disabled = !isA4;
      btnThermal.disabled = isA4;

      if (isA4) {
        status.textContent = `Modo A4 listo (${total} bultos).`;
      } else {
        status.textContent = `Modo térmica listo (${total} bultos).`;
      }
    }

    printMode.addEventListener("change", syncModeUI);

    btnPrintA4.onclick = async () => {
      try {
        btnPrintA4.disabled = true;
        await openA4Window({ guiaId, total, status });
      } catch (e) {
        status.textContent = `Error A4: ${e.message || e}`;
      } finally {
        if (printMode.value === "a4") btnPrintA4.disabled = false;
      }
    };

    btnThermal.onclick = async () => {
      try {
        btnThermal.disabled = true;
        await runThermalMode({
          guiaId,
          total,
          status,
          frame,
          safeModeEl,
          btnNext,
          btnRetry,
          btnCancel
        });
      } catch (e) {
        status.textContent = `Error térmica: ${e.message || e}`;
      } finally {
        if (printMode.value === "thermal") btnThermal.disabled = false;
      }
    };

    syncModeUI();

    if (printMode.value === "thermal") {
      await runThermalMode({
        guiaId,
        total,
        status,
        frame,
        safeModeEl,
        btnNext,
        btnRetry,
        btnCancel
      });
    }
  }

  main().catch(err => {
    document.body.innerHTML = `<pre style="padding:16px;font-family:ui-monospace">${String(err.message || err)}</pre>`;
  });
})();