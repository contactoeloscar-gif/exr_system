(() => {
  const $ = (id) => document.getElementById(id);

  function getToken() {
    return localStorage.getItem("exr_token") || "";
  }

  function getLoteId() {
    const url = new URL(window.location.href);
    return Number(url.searchParams.get("id") || 0);
  }

  function esc(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function fmtDate(v) {
    if (!v) return "-";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return esc(v);
    return d.toLocaleDateString("es-AR");
  }

  function fmtDateTime(v) {
    if (!v) return "-";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return esc(v);
    return d.toLocaleString("es-AR");
  }

  function setStatus(msg) {
    $("status").textContent = msg;
  }

  function copyLabelItems() {
    return [
      { key: "ORIGEN", title: "EJEMPLAR ORIGEN" },
      { key: "CHOFER", title: "EJEMPLAR CHOFER" },
      { key: "DESTINO", title: "EJEMPLAR DESTINO" }
    ];
  }

  function tipoLoteLabel(tipo) {
    return String(tipo || "").toUpperCase() === "DISTRIBUCION"
      ? "DISTRIBUCIÓN"
      : "COLECTA";
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

  function sumGuias(guias, field) {
    return (Array.isArray(guias) ? guias : []).reduce((acc, g) => {
      const n = Number(g?.[field] ?? 0);
      return acc + (Number.isFinite(n) ? n : 0);
    }, 0);
  }

  function renderGuiasRows(lote, guias) {
    if (!Array.isArray(guias) || !guias.length) {
      return `
        <tr>
          <td colspan="10">Sin guías cargadas en el lote.</td>
        </tr>
      `;
    }

    const isColecta = String(lote.tipo_lote || "").toUpperCase() === "COLECTA";

    return guias.map((g, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${esc(g.numero_guia || "-")}</td>
        <td>${esc(g.remitente_nombre || "-")}</td>
        <td>${esc(g.destinatario_nombre || "-")}</td>
        <td>${isColecta ? esc(g.guia_sucursal_destino_nombre || g.guia_sucursal_destino_id || "-") : esc(lote.sucursal_destino_nombre || "-")}</td>
        <td>${esc(g.cant_bultos_declarada ?? "-")}</td>
        <td>${esc(g.peso_kg ?? "-")}</td>
        <td>${esc(g.volumetrico_kg ?? "-")}</td>
        <td>${esc(pagoVisible(g))}</td>
        <td>${esc(g.estado_logistico || "-")}</td>
      </tr>
    `).join("");
  }

  function renderCopy(lote, tagTitle) {
    const isColecta = String(lote.tipo_lote || "").toUpperCase() === "COLECTA";
    const destinoLabel = isColecta ? "Nodo receptor del lote" : "Destino del lote";
    const destinoValor = lote.sucursal_destino_nombre || lote.sucursal_destino_id || "-";

    const totalKg = sumGuias(lote.guias, "peso_kg");
    const totalVol = sumGuias(lote.guias, "volumetrico_kg");

    return `
      <section class="copy">
        <div class="head">
          <div class="brand">
            <h1>HOJA DE RUTA - EXR encomiendas</h1>
            <div class="sub">
              Control de despacho y recepción por lote
              <span class="chip">${esc(tipoLoteLabel(lote.tipo_lote))}</span>
            </div>
          </div>
          <div class="copy-tag">${esc(tagTitle)}</div>
        </div>

        <div class="meta-grid">
          <div class="meta-block">
            <div class="meta-title">Número de lote</div>
            <div class="meta-value">${esc(lote.numero_lote || "-")}</div>
          </div>
          <div class="meta-block">
            <div class="meta-title">Fecha operativa</div>
            <div class="meta-value">${fmtDate(lote.fecha_operativa)}</div>
          </div>
          <div class="meta-block">
            <div class="meta-title">Tipo de lote</div>
            <div class="meta-value">${esc(tipoLoteLabel(lote.tipo_lote))}</div>
          </div>
          <div class="meta-block">
            <div class="meta-title">Estado lote</div>
            <div class="meta-value">${esc(lote.estado || "-")}</div>
          </div>
          <div class="meta-block">
            <div class="meta-title">Sucursal origen</div>
            <div class="meta-value">${esc(lote.sucursal_origen_nombre || lote.sucursal_origen_id || "-")}</div>
          </div>
          <div class="meta-block">
            <div class="meta-title">${esc(destinoLabel)}</div>
            <div class="meta-value">${esc(destinoValor)}</div>
          </div>
          <div class="meta-block">
            <div class="meta-title">Chofer</div>
            <div class="meta-value">${esc(lote.chofer || "-")}</div>
          </div>
          <div class="meta-block">
            <div class="meta-title">Vehículo / patente</div>
            <div class="meta-value">${esc([lote.vehiculo, lote.patente].filter(Boolean).join(" / ") || "-")}</div>
          </div>
        </div>

        <div class="summary">
          <div class="box">
            <div class="k">Guías</div>
            <div class="v">${esc(lote.cant_guias ?? 0)}</div>
          </div>
          <div class="box">
            <div class="k">Bultos</div>
            <div class="v">${esc(lote.cant_bultos ?? 0)}</div>
          </div>
          <div class="box">
            <div class="k">Kg total</div>
            <div class="v">${esc(totalKg.toFixed(2))}</div>
          </div>
          <div class="box">
            <div class="k">Volumétrico total</div>
            <div class="v">${esc(totalVol.toFixed(2))}</div>
          </div>
          <div class="box">
            <div class="k">Consolidado</div>
            <div class="v" style="font-size:12px">${fmtDateTime(lote.consolidado_en)}</div>
          </div>
          <div class="box">
            <div class="k">Despachado</div>
            <div class="v" style="font-size:12px">${fmtDateTime(lote.despachado_en)}</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th style="width:36px">#</th>
              <th style="width:120px">Guía</th>
              <th>Remitente</th>
              <th>Destinatario</th>
              <th style="width:${isColecta ? "150px" : "120px"}">${isColecta ? "Destino final guía" : "Destino"}</th>
              <th style="width:60px">Bultos</th>
              <th style="width:70px">Kg</th>
              <th style="width:90px">Volumétrico</th>
              <th style="width:90px">Pago</th>
              <th style="width:120px">Estado</th>
            </tr>
          </thead>
          <tbody>
            ${renderGuiasRows(lote, lote.guias)}
          </tbody>
        </table>

        <div class="obs-box">
          <strong>Observaciones:</strong><br>
          ${esc(lote.observaciones || "-")}
        </div>

        <div class="signs">
          <div class="sign">Entrega origen</div>
          <div class="sign">Recibe chofer</div>
          <div class="sign">${isColecta ? "Recibe central / hub" : "Recibe destino"}</div>
        </div>

        <div class="footer-note">
          Impreso: ${fmtDateTime(new Date().toISOString())}
        </div>
      </section>
    `;
  }

  function renderAll(lote) {
    const html = copyLabelItems().map(x => renderCopy(lote, x.title)).join("");
    $("root").innerHTML = html;
  }

  async function load() {
    const loteId = getLoteId();
    if (!loteId) {
      setStatus("Falta el parámetro id del lote.");
      return;
    }

    try {
      setStatus("Cargando datos del lote...");

      const r = await fetch(`/interno/lotes/${loteId}`, {
        headers: {
          "Authorization": `Bearer ${getToken()}`
        }
      });

      const data = await r.json().catch(() => ({}));

      if (!r.ok || !data?.ok || !data?.lote) {
        throw new Error(data?.error || "No se pudo cargar el lote.");
      }

      renderAll(data.lote);
      setStatus(`Hoja de ruta lista: ${data.lote.numero_lote}`);
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Error al cargar hoja de ruta.");
      $("root").innerHTML = "";
    }
  }

  $("btnImprimir").addEventListener("click", () => window.print());

  load();
})();