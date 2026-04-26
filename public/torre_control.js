(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    fAgencia: $("fAgencia"),
    fPrioridad: $("fPrioridad"),
    fAccion: $("fAccion"),
    fSinMovimiento: $("fSinMovimiento"),
    fFechaDesde: $("fFechaDesde"),
    fFechaHasta: $("fFechaHasta"),
    fSoloCriticas: $("fSoloCriticas"),
    fAuto: $("fAuto"),

    btnRefresh: $("btnRefresh"),
    btnLimpiar: $("btnLimpiar"),

    statusText: $("statusText"),
    statusUpdated: $("statusUpdated"),
    errorBox: $("errorBox"),

    kpiNovedades: $("kpiNovedades"),
    kpiRetiro: $("kpiRetiro"),
    kpi6h: $("kpi6h"),
    kpi12h: $("kpi12h"),
    kpiAgencias: $("kpiAgencias"),
    kpiLotes: $("kpiLotes"),

    tbodyGuias: $("tbodyGuias"),
    tbodyAgencias: $("tbodyAgencias"),

    modalBackdrop: $("modalBackdrop"),
    btnCloseModal: $("btnCloseModal"),
    modalTitle: $("modalTitle"),
    modalSub: $("modalSub"),
    detailCabecera: $("detailCabecera"),
    detailOperativo: $("detailOperativo"),
    detailAlertas: $("detailAlertas"),
    detailTimeline: $("detailTimeline"),
  };

  const state = {
    autoTimer: null,
    lastResponse: null,
    loading: false,
  };

  function esc(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getToken() {
    return (
      localStorage.getItem("exr_token") ||
      sessionStorage.getItem("exr_token") ||
      ""
    );
  }

  async function apiFetch(url, options = {}) {
    const token = getToken();
    const headers = {
      ...(options.headers || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, {
      ...options,
      headers,
      credentials: "include",
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.payload = data;

      if (res.status === 401) {
        window.location.href = "/operador.html";
        return;
      }

      throw err;
    }

    return data;
  }

  function nowText() {
    return new Date().toLocaleString("es-AR");
  }

  function fmtDate(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("es-AR");
  }

  function fmtRel(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "—";

    const diffMs = Date.now() - d.getTime();
    const mins = Math.round(diffMs / 60000);

    if (mins < 1) return "recién";
    if (mins < 60) return `hace ${mins} min`;

    const hours = Math.round((mins / 60) * 10) / 10;
    if (hours < 24) return `hace ${String(hours).replace(".", ",")} h`;

    const days = Math.round((hours / 24) * 10) / 10;
    return `hace ${String(days).replace(".", ",")} días`;
  }

  function setStatus(text) {
    if (els.statusText) els.statusText.textContent = text;
  }

  function setUpdated(text) {
    if (els.statusUpdated) els.statusUpdated.textContent = text;
  }

  function showError(msg) {
    if (!els.errorBox) return;
    els.errorBox.style.display = "block";
    els.errorBox.textContent = msg;
  }

  function hideError() {
    if (!els.errorBox) return;
    els.errorBox.style.display = "none";
    els.errorBox.textContent = "";
  }

  function queryParamsFromFilters() {
    const p = new URLSearchParams();

    if (els.fAgencia?.value) p.set("sucursal_id", els.fAgencia.value);
    if (els.fPrioridad?.value) p.set("prioridad", els.fPrioridad.value);
    if (els.fAccion?.value) p.set("tipo_accion", els.fAccion.value);
    if (els.fSinMovimiento?.value) p.set("sin_movimiento_desde_horas", els.fSinMovimiento.value);
    if (els.fFechaDesde?.value) p.set("fecha_desde", els.fFechaDesde.value);
    if (els.fFechaHasta?.value) p.set("fecha_hasta", els.fFechaHasta.value);
    if (els.fSoloCriticas?.checked) p.set("solo_criticas", "1");

    p.set("limit", "200");
    p.set("offset", "0");
    return p.toString();
  }

  function chip(text, klass = "") {
    return `<span class="chip ${klass}">${esc(text)}</span>`;
  }

  function renderKPIs(resumen) {
    if (els.kpiNovedades) els.kpiNovedades.textContent = resumen?.novedades_activas ?? 0;
    if (els.kpiRetiro) els.kpiRetiro.textContent = resumen?.pendientes_retiro_colecta ?? 0;
    if (els.kpi6h) els.kpi6h.textContent = resumen?.sin_movimiento_6h ?? 0;
    if (els.kpi12h) els.kpi12h.textContent = resumen?.sin_movimiento_12h ?? 0;
    if (els.kpiAgencias) els.kpiAgencias.textContent = resumen?.agencias_con_alerta ?? 0;
    if (els.kpiLotes) els.kpiLotes.textContent = resumen?.lotes_afectados ?? 0;
  }

  function renderGuias(guias) {
    if (!els.tbodyGuias) return;

    if (!guias?.length) {
      els.tbodyGuias.innerHTML =
        `<tr><td colspan="8" class="empty">No hay guías accionables para los filtros actuales.</td></tr>`;
      return;
    }

    els.tbodyGuias.innerHTML = guias
      .map((g) => {
        const ruta = `${esc(g.origen_nombre || "S/D")} → ${esc(g.destino_nombre || "S/D")}`;
        const alertasTxt = (g.alertas || []).slice(0, 2).join(" · ");
        const ultima = g.ultima_novedad || g.resumen_corto || "seguimiento";

        return `
          <tr>
            <td>${chip(g.prioridad || "S/D", `prio-${esc(g.prioridad || "BAJA")}`)}</td>
            <td>${esc(g.agencia_actual_nombre || "S/D")}</td>
            <td>
              <div class="mono">${esc(g.numero_guia || "S/D")}</div>
              ${alertasTxt ? `<div class="small">${esc(alertasTxt)}</div>` : ""}
            </td>
            <td>${ruta}</td>
            <td>${chip(g.estado_logistico || "—")}</td>
            <td>
              <div>${esc(ultima)}</div>
              ${g.resumen_corto ? `<div class="small">${esc(g.resumen_corto)}</div>` : ""}
            </td>
            <td>
              <div>${fmtRel(g.ultima_novedad_at || g.ultimo_hito_at)}</div>
              <div class="small">${g.sin_movimiento_horas != null ? `${String(g.sin_movimiento_horas).replace(".", ",")} h` : "—"}</div>
            </td>
            <td>
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                ${chip(g.accion_recomendada || "SEGUIMIENTO")}
                <button class="btn-link" data-guia-id="${esc(g.guia_id)}">Ver</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");

    els.tbodyGuias.querySelectorAll("[data-guia-id]").forEach((btn) => {
      btn.addEventListener("click", () => openDetalle(btn.getAttribute("data-guia-id")));
    });
  }

function renderAgencias(agencias) {
  if (!els.tbodyAgencias) return;

  if (!agencias?.length) {
    els.tbodyAgencias.innerHTML =
      `<tr><td colspan="8" class="empty">Sin agencias con alertas para el filtro actual.</td></tr>`;
    return;
  }

  els.tbodyAgencias.innerHTML = agencias
    .map((a) => {
      return `
        <tr>
          <td>
            <div><button class="btn-link" data-agencia-id="${esc(a.sucursal_id)}">${esc(a.sucursal_nombre || "S/D")}</button></div>
            <div class="small">ID ${esc(a.sucursal_id || "—")}</div>
          </td>
          <td>${esc(a.novedades_activas ?? 0)}</td>
          <td>${esc(a.pendientes_retiro_colecta ?? 0)}</td>
          <td>${esc(a.sin_movimiento_6h ?? 0)}</td>
          <td>${esc(a.sin_movimiento_12h ?? 0)}</td>
          <td>${esc(a.lotes_afectados ?? 0)}</td>
          <td>${fmtRel(a.ultimo_movimiento_at)}</td>
          <td>${chip(a.estado || "—", `sem-${esc(a.estado || "VERDE")}`)}</td>
        </tr>
      `;
    })
    .join("");

  els.tbodyAgencias.querySelectorAll("[data-agencia-id]").forEach((btn) => {
    btn.addEventListener("click", () => openAgenciaColectaModal(btn.getAttribute("data-agencia-id")));
  });
}
  function openAgenciaColectaModal(sucursalId) {
  const data = state.lastResponse || {};
  const agencias = data.agencias || [];
  const guias = data.guias || [];

  const agencia = agencias.find((a) => String(a.sucursal_id) === String(sucursalId));
  const nombre = agencia?.sucursal_nombre || `Agencia ${sucursalId}`;

  const items = guias.filter((g) =>
    String(g.agencia_actual_id) === String(sucursalId) &&
    (
      g.requiere_colecta === true ||
      String(g.accion_recomendada || "").toUpperCase() === "COORDINAR_COLECTA"
    )
  );

  els.modalTitle.textContent = `Guías listas para colecta · ${nombre}`;
  els.modalSub.textContent = `${items.length} guía(s)`;

  els.detailCabecera.innerHTML = [
    detailItem("Agencia", nombre),
    detailItem("Guías listas", items.length),
    detailItem("Pendientes retiro/colecta", agencia?.pendientes_retiro_colecta ?? 0),
    detailItem("Sin movimiento +6h", agencia?.sin_movimiento_6h ?? 0),
  ].join("");

  els.detailOperativo.innerHTML = "";
  els.detailAlertas.innerHTML = "";

  if (!items.length) {
    els.detailTimeline.innerHTML = `<div class="empty">No hay guías listas para colecta en esta agencia.</div>`;
    els.modalBackdrop.style.display = "block";
    return;
  }

  els.detailTimeline.innerHTML = items.map((g) => {
    const ruta = `${esc(g.origen_nombre || "S/D")} → ${esc(g.destino_nombre || "S/D")}`;
    const alertas = (g.alertas || []).slice(0, 3).map((a) => chip(a)).join(" ");

    return `
      <div class="timeline-item">
        <div class="timeline-top">
          <div class="timeline-event">${esc(g.numero_guia || "S/D")}</div>
          <div class="timeline-meta">${esc(g.estado_logistico || "—")} · ${fmtRel(g.ultima_novedad_at || g.ultimo_hito_at)}</div>
        </div>
        <div class="timeline-meta">${ruta}</div>
        <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
          ${chip(g.prioridad || "S/D", `prio-${esc(g.prioridad || "BAJA")}`)}
          ${chip(g.accion_recomendada || "SEGUIMIENTO")}
          ${alertas || ""}
          <button class="btn-link" data-modal-guia-id="${esc(g.guia_id)}">Ver detalle</button>
        </div>
      </div>
    `;
  }).join("");

  els.modalBackdrop.style.display = "block";

  els.detailTimeline.querySelectorAll("[data-modal-guia-id]").forEach((btn) => {
    btn.addEventListener("click", () => openDetalle(btn.getAttribute("data-modal-guia-id")));
  });
}

  function refillAgenciaFilter(agencias) {
    if (!els.fAgencia) return;

    const current = els.fAgencia.value;
    const opts = ['<option value="">Todas</option>']
      .concat(
        (agencias || []).map(
          (a) =>
            `<option value="${esc(a.sucursal_id)}">${esc(a.sucursal_nombre)}${a.estado ? ` (${esc(a.estado)})` : ""}</option>`
        )
      )
      .join("");

    els.fAgencia.innerHTML = opts;
    if ([...els.fAgencia.options].some((o) => o.value === current)) {
      els.fAgencia.value = current;
    }
  }

  async function loadData() {
    if (state.loading) return;
    state.loading = true;

    try {
      hideError();
      setStatus("Cargando Torre de Control…");

      const qs = queryParamsFromFilters();
      const data = await apiFetch(`/interno/torre-control/novedades?${qs}`);

      state.lastResponse = data;

      renderKPIs(data.resumen || {});
      renderGuias(data.guias || []);
      renderAgencias(data.agencias || []);
      refillAgenciaFilter(data.agencias || []);

      setStatus(`OK · ${data.paginacion?.total ?? 0} guía(s) accionable(s)`);
      setUpdated(`Última actualización: ${nowText()}`);
    } catch (err) {
      console.error("TorreControl loadData error:", err);
      setStatus("Error de carga");

      const msg = [
        err?.payload?.error,
        err?.payload?.debug,
        err?.message,
      ].filter(Boolean).join(" | ");

      showError(msg || "No se pudo cargar la Torre de Control.");

      if (err.status === 401 || err.status === 403) {
        showError("Sin permisos o sesión vencida para acceder a Torre de Control.");
      }
    } finally {
      state.loading = false;
    }
  }

  function detailItem(label, value) {
    return `
      <div class="detail-item">
        <div class="k">${esc(label)}</div>
        <div class="v">${value == null || value === "" ? "—" : esc(value)}</div>
      </div>
    `;
  }

  async function openDetalle(guiaId) {
    try {
      setStatus(`Cargando detalle guía #${guiaId}…`);
      const data = await apiFetch(`/interno/torre-control/guias/${guiaId}`);

      const g = data.guia || {};
      const e = data.estado_derivado || {};
      const t = data.torre_control || {};
      const lote = data.lote || null;
      const eventos = data.eventos || [];

      els.modalTitle.textContent = g.numero_guia || `Guía #${guiaId}`;
      els.modalSub.textContent = `${g.origen_nombre || "S/D"} → ${g.destino_nombre || "S/D"}`;

      els.detailCabecera.innerHTML = [
        detailItem("Estado logístico", g.estado_logistico),
        detailItem("Estado pago", g.estado_pago),
        detailItem("Situación operativa", e.situacion_operativa),
        detailItem("Situación contable", e.situacion_contable),
        detailItem("Agencia actual", g.agencia_actual_nombre),
        detailItem("Acción principal", e.accion_principal),
        detailItem("Prioridad", t.prioridad),
        detailItem("Lote", lote ? `#${lote.lote_id} · ${lote.tipo || ""} / ${lote.estado || ""}` : "—"),
      ].join("");

      els.detailOperativo.innerHTML = [
        detailItem("Requiere acción central", t.requiere_accion_central ? "Sí" : "No"),
        detailItem("Requiere retiro", t.requiere_retiro ? "Sí" : "No"),
        detailItem("Requiere colecta", t.requiere_colecta ? "Sí" : "No"),
        detailItem("Requiere pase", t.requiere_pase ? "Sí" : "No"),
        detailItem("Requiere revisión", t.requiere_revision ? "Sí" : "No"),
        detailItem("Acción recomendada", t.accion_recomendada),
        detailItem("Sin movimiento", t.sin_movimiento_horas != null ? `${String(t.sin_movimiento_horas).replace(".", ",")} horas` : "—"),
        detailItem("Resumen corto", t.resumen_corto || e.resumen_corto || "—"),
      ].join("");

      const alertas = []
        .concat(t.alertas || [])
        .concat((t.bloqueos || []).map((b) => `BLOQUEO:${b}`));

      els.detailAlertas.innerHTML = alertas.length
        ? alertas.map((a) => chip(a)).join("")
        : `<span class="small">Sin alertas activas.</span>`;

      els.detailTimeline.innerHTML = eventos.length
        ? eventos
            .map(
              (ev) => `
                <div class="timeline-item">
                  <div class="timeline-top">
                    <div class="timeline-event">${esc(ev.evento || "evento")}</div>
                    <div class="timeline-meta">${esc(ev.fuente || "")} · ${fmtDate(ev.fecha)}</div>
                  </div>
                  <div class="timeline-meta">
                    ${esc(ev.sucursal_nombre || "Sin sucursal")} · ${esc(ev.usuario || "Sin usuario")}
                  </div>
                  <div style="margin-top:8px; font-size:13px; color:#374151;">${esc(ev.detalle || "—")}</div>
                </div>
              `
            )
            .join("")
        : `<div class="empty">Sin eventos para mostrar.</div>`;

      els.modalBackdrop.style.display = "block";
      setStatus(`Detalle cargado · ${g.numero_guia || `#${guiaId}`}`);
    } catch (err) {
      console.error("openDetalle error:", err);

      const msg = [
        err?.payload?.error,
        err?.payload?.debug,
        err?.message,
      ].filter(Boolean).join(" | ");

      showError(msg || "No se pudo cargar el detalle.");
    }
  }

  function closeModal() {
    if (els.modalBackdrop) els.modalBackdrop.style.display = "none";
  }

  function clearFilters() {
    if (els.fAgencia) els.fAgencia.value = "";
    if (els.fPrioridad) els.fPrioridad.value = "";
    if (els.fAccion) els.fAccion.value = "";
    if (els.fSinMovimiento) els.fSinMovimiento.value = "";
    if (els.fFechaDesde) els.fFechaDesde.value = "";
    if (els.fFechaHasta) els.fFechaHasta.value = "";
    if (els.fSoloCriticas) els.fSoloCriticas.checked = false;
    loadData();
  }

  function restartAuto() {
    if (state.autoTimer) clearInterval(state.autoTimer);
    state.autoTimer = null;

    if (!els.fAuto?.checked) return;

    state.autoTimer = setInterval(() => {
      if (!document.hidden) loadData();
    }, 15000);
  }

  function bind() {
    [
      els.fAgencia,
      els.fPrioridad,
      els.fAccion,
      els.fSinMovimiento,
      els.fFechaDesde,
      els.fFechaHasta,
      els.fSoloCriticas,
    ]
      .filter(Boolean)
      .forEach((el) => el.addEventListener("change", loadData));

    els.fAuto?.addEventListener("change", restartAuto);
    els.btnRefresh?.addEventListener("click", loadData);
    els.btnLimpiar?.addEventListener("click", clearFilters);
    els.btnCloseModal?.addEventListener("click", closeModal);

    els.modalBackdrop?.addEventListener("click", (ev) => {
      if (ev.target === els.modalBackdrop) closeModal();
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeModal();
    });
  }

  async function init() {
    bind();
    restartAuto();
    await loadData();
  }

  init();
})();