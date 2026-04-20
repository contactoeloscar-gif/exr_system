(() => {
  const $ = (id) => document.getElementById(id);

  console.log("BANDEJA_V2 P17.2 CARGADA", new Date().toISOString());

  /* =========================
     HELPERS UI
  ========================= */
  function esc(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function ensureToastsRoot() {
    let root = document.querySelector(".exr-toast-wrap");
    if (!root) {
      root = document.createElement("div");
      root.className = "exr-toast-wrap";
      document.body.appendChild(root);
    }
    return root;
  }

  function toast(title, message, type = "") {
    const root = ensureToastsRoot();
    const el = document.createElement("div");
    el.className = "exr-toast";
    el.innerHTML = `<div class="t">${esc(title)}</div><div class="m">${esc(message)}</div>`;

    if (type === "ok") el.style.borderColor = "rgba(32,201,151,.5)";
    if (type === "warn") el.style.borderColor = "rgba(255,204,0,.5)";
    if (type === "bad") el.style.borderColor = "rgba(255,92,119,.5)";

    root.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function money(n) {
    return Number(n ?? 0).toLocaleString("es-AR", {
      style: "currency",
      currency: "ARS",
    });
  }

  function dt(iso) {
    try {
      return iso ? new Date(iso).toLocaleString("es-AR") : "";
    } catch {
      return String(iso || "");
    }
  }

  function normalizeUpper(v) {
    return String(v || "").trim().toUpperCase();
  }

  function normalizeLower(v) {
    return String(v || "").trim().toLowerCase();
  }

  function pagoVisible(data) {
    const forma = String(
      data?.condicion_pago || data?.forma_pago || data?.tipo_cobro || ""
    ).trim().toUpperCase();

    const estado = String(data?.estado_pago || "").trim().toLowerCase();

    if (forma === "ORIGEN") {
      if (estado === "observado") return "OBSERVADO";
      if (estado === "pendiente_origen") return "PENDIENTE";
      if (["pagado", "pagado_origen", "no_aplica"].includes(estado)) return "PAGADO";
      return "PAGADO";
    }

    if (forma === "DESTINO") {
      if (estado === "observado") return "OBSERVADO";
      if (estado === "pendiente_destino") return "PENDIENTE";
      if (estado === "cobrado_destino" || estado === "rendido") return "PAGADO";
      return "PENDIENTE";
    }

    if (estado === "observado") return "OBSERVADO";
    if (estado === "pendiente_destino" || estado === "pendiente_origen") return "PENDIENTE";
    if (["cobrado_destino", "rendido", "pagado", "pagado_origen", "no_aplica"].includes(estado)) return "PAGADO";

    return data?.estado_pago || "-";
  }

  function getEstadoDerivado(g) {
    return g?.estado_derivado && typeof g.estado_derivado === "object"
      ? g.estado_derivado
      : null;
  }

  function firstMsg(arr) {
    return Array.isArray(arr) && arr.length
      ? (arr[0]?.mensaje || arr[0]?.codigo || "")
      : "";
  }

  function hasCode(arr, code) {
    return Array.isArray(arr) && arr.some(x => String(x?.codigo || "").toUpperCase() === String(code || "").toUpperCase());
  }

  function badgeText(label, cls = "") {
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  }

  function operativaText(key) {
    const map = {
      PENDIENTE_DESPACHO: "Pendiente despacho",
      EN_TRANSITO: "En tránsito",
      PENDIENTE_COBRO_DESTINO: "No entregar sin cobro",
      LISTA_PARA_ENTREGA: "Lista para entrega",
      ENTREGADA: "Entregada",
      OBSERVADA: "Requiere revisión",
      PENDIENTE_PAGO_ORIGEN: "No despachar sin cobro origen",
      EN_VIAJE: "En viaje",
      EN_CENTRAL: "En central",
      CENTRAL_OBSERVADO: "Central observado",
      EXCEPCION_AUTORIZADA: "Excepción autorizada",
      PENDIENTE_RENDICION: "Pte. rendición CC",
      RENDIDO: "Rendido",
      SIN_CLASIFICAR: "Sin clasificar"
    };
    return map[String(key || "").toUpperCase()] || (key || "—");
  }

  function operativaClass(key) {
    const k = String(key || "").toUpperCase();
    if (["PENDIENTE_COBRO_DESTINO", "OBSERVADA", "PENDIENTE_PAGO_ORIGEN", "CENTRAL_OBSERVADO"].includes(k)) return "bad";
    if (["LISTA_PARA_ENTREGA", "ENTREGADA", "RENDIDO", "EN_CENTRAL"].includes(k)) return "ok";
    if (["PENDIENTE_DESPACHO", "EN_TRANSITO", "EN_VIAJE", "EXCEPCION_AUTORIZADA", "PENDIENTE_RENDICION"].includes(k)) return "warn";
    return "";
  }

  function contableText(key) {
    const map = {
      NO_APLICA: "Contable N/A",
      PENDIENTE_RENDICION: "Contable: pte. rendición",
      RENDIDA_SIN_CIERRE: "Contable: rendida sin cierre",
      LIQUIDABLE: "Contable: liquidable",
      EN_LIQUIDACION: "Contable: en liquidación",
      APROBADA_PENDIENTE_REGISTRO: "Contable: aprobada",
      REGISTRADA_PENDIENTE_CONCILIACION: "Contable: pte. conciliación",
      CONCILIADA: "Contable: conciliada"
    };
    return map[String(key || "").toUpperCase()] || (key || "—");
  }

  function contableClass(key) {
    const k = String(key || "").toUpperCase();
    if (["CONCILIADA"].includes(k)) return "ok";
    if (["PENDIENTE_RENDICION", "RENDIDA_SIN_CIERRE", "LIQUIDABLE", "EN_LIQUIDACION", "APROBADA_PENDIENTE_REGISTRO", "REGISTRADA_PENDIENTE_CONCILIACION"].includes(k)) return "warn";
    return "";
  }

  /* =========================
     LOGOUT
  ========================= */
  (function bindLogoutNuclear() {
    try {
      const ensureTypeButton = () => {
        const btn = $("btnLogout") || document.getElementById("logoutBtn");
        if (btn && btn.tagName === "BUTTON") btn.setAttribute("type", "button");
      };

      ensureTypeButton();
      document.addEventListener("DOMContentLoaded", ensureTypeButton);

      document.addEventListener(
        "click",
        (e) => {
          const b = e.target.closest("#btnLogout, #logoutBtn, [data-action='logout']");
          if (!b) return;

          e.preventDefault();
          e.stopPropagation();

          try {
            localStorage.removeItem("exr_token");
            localStorage.removeItem("exr_bandeja_etag");
            localStorage.removeItem("exr_bandeja_ui_v2");
          } catch {}

          location.replace("/operador.html");
        },
        true
      );
    } catch (err) {
      console.error("bindLogoutNuclear error:", err);
    }
  })();

  /* =========================
     CONSTANTES
  ========================= */
  const LS_TOKEN = "exr_token";
  const LS_UI = "exr_bandeja_ui_v2";
  const LS_ETAG = "exr_bandeja_etag";

  const ENDPOINTS = {
    authPing: "/test-auth",
    bandeja: "/interno/bandeja",
    estado: "/guias/estado",
    registrarCobro: "/interno/cobros/registrar",
    rendirCobro: "/interno/cobros/rendir",
    excepcionEntrega: "/interno/cobros/excepcion-entrega",
  };

  const TABS = [
    { key: "RECIBIDO_ORIGEN", label: "Pendientes origen" },
    { key: "EN_TRANSITO_A_CENTRAL", label: "A central" },
    { key: "RECIBIDO_CENTRAL", label: "En central" },
    { key: "EN_TRANSITO_A_DESTINO", label: "A destino" },
    { key: "RECIBIDO_DESTINO", label: "En destino" },
    { key: "ENTREGADO", label: "Entregadas" },
    { key: "ALL", label: "Todas" },
  ];

  let all = [];
  let apiTotal = 0;
  let activeTab = "ALL";
  let quick = "ALL";
  let page = 1;
  let limit = 25;
  let debounceTimer = null;
  let refreshTimer = null;
  let currentUser = null;
  let lastUpdatedAt = 0;
  let lastEtag = localStorage.getItem(LS_ETAG) || "";

  /* =========================
     API
  ========================= */
  function getToken() {
    return localStorage.getItem(LS_TOKEN) || "";
  }

  function logout() {
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_ETAG);
    location.href = "/operador.html";
  }

  async function api(path, opts = {}) {
    const token = getToken();
    const headers = Object.assign({}, opts.headers || {});
    if (token) headers["Authorization"] = "Bearer " + token;
    if (opts.json) headers["Content-Type"] = "application/json";

    const res = await fetch(path, { ...opts, headers });
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json")
      ? await res.json().catch(() => ({}))
      : await res.text().catch(() => "");

    if (!res.ok) {
      const msg =
        (data && data.error)
          ? data.error
          : (typeof data === "string" && data)
            ? data
            : ("HTTP " + res.status);
      throw new Error(msg);
    }

    return data;
  }

  /* =========================
     SYNC CHIP
  ========================= */
  function setSyncChip(mode, extra = "") {
    const el = $("syncChip");
    if (!el) return;

    const now = Date.now();
    const age = lastUpdatedAt ? Math.max(0, Math.round((now - lastUpdatedAt) / 1000)) : 0;

    const base =
      mode === "loading" ? "Actualizando…" :
      mode === "ok" ? "Actualizado" :
      mode === "same" ? "Sin cambios" : "Error";

    el.textContent = `${base}${lastUpdatedAt ? ` • hace ${age}s` : ""}${extra ? ` • ${extra}` : ""}`;

    el.classList.remove("ok", "same", "err");
    if (mode === "ok") el.classList.add("ok");
    if (mode === "same") el.classList.add("same");
    if (mode === "err") el.classList.add("err");
  }

  /* =========================
     UI STATE
  ========================= */
  function readUI() {
    try {
      const raw = localStorage.getItem(LS_UI);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return (obj && typeof obj === "object") ? obj : null;
    } catch {
      return null;
    }
  }

  function writeUI(patch) {
    const prev = readUI() || {};
    const next = { ...prev, ...patch, saved_at: new Date().toISOString() };
    try {
      localStorage.setItem(LS_UI, JSON.stringify(next));
    } catch {}
  }

  function captureUI() {
    return {
      activeTab,
      quick,
      q: ($("q")?.value || "").trim(),
      f_estado_log: $("f_estado_log")?.value || "",
      f_estado_pago: $("f_estado_pago")?.value || "",
      f_tipo_cobro: $("f_tipo_cobro")?.value || "",
      page,
      limit,
    };
  }

  function applyUI(state) {
    if (!state) return;

    if (state.activeTab) activeTab = state.activeTab;
    if (state.quick) quick = state.quick;
    if (typeof state.page === "number" && state.page >= 1) page = state.page;
    if (typeof state.limit === "number" && [25, 50, 100].includes(state.limit)) limit = state.limit;

    if ($("q") && typeof state.q === "string") $("q").value = state.q;
    if ($("f_estado_log") && typeof state.f_estado_log === "string") $("f_estado_log").value = state.f_estado_log;
    if ($("f_estado_pago") && typeof state.f_estado_pago === "string") $("f_estado_pago").value = state.f_estado_pago;
    if ($("f_tipo_cobro") && typeof state.f_tipo_cobro === "string") $("f_tipo_cobro").value = state.f_tipo_cobro;
    if ($("limitSel")) $("limitSel").value = String(limit);
  }

  /* =========================
     ROLES
  ========================= */
  function roleUpper() {
    return String(currentUser?.rol || "").trim().toUpperCase();
  }

  function isOwnerOrAdminUser() {
    return ["OWNER", "ADMIN"].includes(roleUpper());
  }

  /* =========================
     BADGES
  ========================= */
  function badgeLog(estado) {
    const map = {
      RECIBIDO_ORIGEN: ["Recibido origen", "warn"],
      EN_TRANSITO: ["En tránsito", "warn"],
      EN_TRANSITO_A_CENTRAL: ["A central", "warn"],
      RECIBIDO_CENTRAL: ["Recibido central", "ok"],
      RECIBIDO_CENTRAL_OBSERVADO: ["Central observado", "bad"],
      EN_TRANSITO_A_DESTINO: ["A destino", "warn"],
      RECIBIDO_DESTINO: ["Recibido destino", "warn"],
      RECIBIDO_DESTINO_OBSERVADO: ["Destino observado", "bad"],
      ENTREGADO: ["Entregado", "ok"],
    };
    const [label, cls] = map[estado] || [estado || "—", ""];
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  }

  function badgePago(data) {
    const visible = pagoVisible(data);
    const estadoTecnico = normalizeLower(data?.estado_pago);
    const metodo = data?.metodo_pago;

    const rendido =
      data?.rendido_bool === true ||
      String(data?.rendicion_estado || "").toUpperCase() === "RENDIDO" ||
      !!data?.rendido_at;

    let cls = "";
    if (visible === "PAGADO") cls = "ok";
    if (visible === "PENDIENTE") cls = "warn";
    if (visible === "OBSERVADO") cls = "bad";

    const extra =
      ((estadoTecnico === "cobrado_destino" || estadoTecnico === "rendido") && metodo)
        ? ` <span class="muted mono" style="font-size:11px">(${esc(metodo)})</span>`
        : (rendido ? ` <span class="muted mono" style="font-size:11px">(rendido)</span>` : "");

    return `<span class="badge ${cls}">${esc(visible)}</span>${extra}`;
  }

  /* =========================
     OPERATIVA
  ========================= */
  function deriveOperativaLegacy(g) {
    const estadoLog = normalizeUpper(g.estado_logistico);
    const estadoPago = normalizeLower(g.estado_pago);

    const condicionPago = normalizeUpper(g.condicion_pago);
    const tipoCobro = normalizeUpper(g.tipo_cobro);

    const esPagoDestino = condicionPago === "DESTINO" || tipoCobro === "DESTINO";
    const esPagoOrigen = condicionPago === "ORIGEN" || tipoCobro === "ORIGEN";

    const rendido =
      g.rendido_bool === true ||
      String(g.rendicion_estado || "").toUpperCase() === "RENDIDO" ||
      !!g.rendido_at ||
      estadoPago === "rendido";

    const pendienteRendicion =
      g.rendicion_pendiente === true ||
      String(g.rendicion_estado || "").toUpperCase() === "PENDIENTE";

    const cobroConfirmado =
      rendido ||
      estadoPago === "cobrado_destino" ||
      estadoPago === "pagado" ||
      estadoPago === "pagado_origen" ||
      (esPagoOrigen && estadoPago === "no_aplica");

    const tieneExcepcion = estadoPago === "observado";
    const bloqueadoPorPagoOrigen = esPagoOrigen && estadoPago === "pendiente_origen";

    const puedeDespachar =
      estadoLog === "RECIBIDO_ORIGEN" &&
      !bloqueadoPorPagoOrigen;

    const puedeRecibirDestino =
      estadoLog === "EN_TRANSITO" ||
      estadoLog === "EN_TRANSITO_A_DESTINO";

    const puedeCobrar =
      estadoLog === "RECIBIDO_DESTINO" &&
      esPagoDestino &&
      estadoPago === "pendiente_destino";

    const puedeEntregar =
      (estadoLog === "RECIBIDO_DESTINO" || estadoLog === "RECIBIDO_DESTINO_OBSERVADO") &&
      (
        !esPagoDestino ||
        cobroConfirmado ||
        tieneExcepcion
      );

    const puedeRendir =
      isOwnerOrAdminUser() &&
      esPagoDestino &&
      pendienteRendicion &&
      !rendido;

    const listaParaEntrega =
      (estadoLog === "RECIBIDO_DESTINO" || estadoLog === "RECIBIDO_DESTINO_OBSERVADO") &&
      puedeEntregar;

    let estadoOperativo = "SIN_CLASIFICAR";

    if (tieneExcepcion && (estadoLog === "RECIBIDO_DESTINO" || estadoLog === "RECIBIDO_DESTINO_OBSERVADO")) {
      estadoOperativo = "EXCEPCION_AUTORIZADA";
    } else if (estadoLog === "RECIBIDO_ORIGEN" && bloqueadoPorPagoOrigen) {
      estadoOperativo = "PENDIENTE_PAGO_ORIGEN";
    } else if (estadoLog === "RECIBIDO_ORIGEN") {
      estadoOperativo = "PENDIENTE_DESPACHO";
    } else if (estadoLog === "EN_TRANSITO" || estadoLog === "EN_TRANSITO_A_CENTRAL" || estadoLog === "EN_TRANSITO_A_DESTINO") {
      estadoOperativo = "EN_VIAJE";
    } else if (estadoLog === "RECIBIDO_CENTRAL") {
      estadoOperativo = "EN_CENTRAL";
    } else if (estadoLog === "RECIBIDO_CENTRAL_OBSERVADO") {
      estadoOperativo = "CENTRAL_OBSERVADO";
    } else if (estadoLog === "RECIBIDO_DESTINO" && puedeCobrar) {
      estadoOperativo = "PENDIENTE_COBRO_DESTINO";
    } else if (listaParaEntrega) {
      estadoOperativo = "LISTA_PARA_ENTREGA";
    } else if (estadoLog === "ENTREGADO") {
      estadoOperativo = "ENTREGADA";
    }

    if (rendido) {
      estadoOperativo = "RENDIDO";
    } else if (pendienteRendicion) {
      estadoOperativo = "PENDIENTE_RENDICION";
    }

    return {
      source: "legacy",
      estadoLog,
      estadoPago,
      condicionPago,
      tipoCobro,
      esPagoDestino,
      esPagoOrigen,
      cobroConfirmado,
      tieneExcepcion,
      bloqueadoPorPagoOrigen,
      rendido,
      pendienteRendicion,
      puedeDespachar,
      puedeRecibirDestino,
      puedeCobrar,
      puedeEntregar,
      puedeRendir,
      listaParaEntrega,
      estadoOperativo,
      situacionOperativa: estadoOperativo,
      situacionContable: pendienteRendicion
        ? "PENDIENTE_RENDICION"
        : (rendido ? "RENDIDA_SIN_CIERRE" : "NO_APLICA"),
      accionPrincipal:
        puedeDespachar ? "DESPACHAR" :
        puedeRecibirDestino ? "RECIBIR_DESTINO" :
        puedeCobrar ? "REGISTRAR_COBRO" :
        puedeRendir ? "RENDIR_COBRO" :
        puedeEntregar ? "ENTREGAR" : "VER_DETALLE",
      resumenCorto: "",
      bloqueos: [],
      alertas: [],
      cierreEstado: "SIN_CIERRE",
      liquidacionEstado: "NO_APLICA",
      conciliacionEstado: "NO_APLICA"
    };
  }

  function deriveOperativa(g) {
    const der = getEstadoDerivado(g);
    if (!der) return deriveOperativaLegacy(g);

    const estadoLog = normalizeUpper(g.estado_logistico);
    const estadoPago = normalizeLower(g.estado_pago);
    const condicionPago = normalizeUpper(g.condicion_pago);
    const tipoCobro = normalizeUpper(g.tipo_cobro);

    const esPagoDestino = condicionPago === "DESTINO" || tipoCobro === "DESTINO";
    const esPagoOrigen = condicionPago === "ORIGEN" || tipoCobro === "ORIGEN";

    const situacionOperativa = normalizeUpper(der.situacion_operativa);
    const situacionContable = normalizeUpper(der.situacion_contable);
    const accionPrincipal = normalizeUpper(der.accion_principal);

    const bloqueos = Array.isArray(der.bloqueos) ? der.bloqueos : [];
    const alertas = Array.isArray(der.alertas) ? der.alertas : [];

    const tieneExcepcion =
      hasCode(alertas, "EXCEPCION_ENTREGA") ||
      estadoPago === "observado";

    const bloqueadoPorPagoOrigen =
      esPagoOrigen &&
      estadoPago === "pendiente_origen";

    const pendienteRendicion = situacionContable === "PENDIENTE_RENDICION";

    const rendido =
      !!g.rendido_at ||
      estadoPago === "rendido" ||
      [
        "RENDIDA_SIN_CIERRE",
        "LIQUIDABLE",
        "EN_LIQUIDACION",
        "APROBADA_PENDIENTE_REGISTRO",
        "REGISTRADA_PENDIENTE_CONCILIACION",
        "CONCILIADA"
      ].includes(situacionContable);

    const cobroConfirmado =
      rendido ||
      estadoPago === "cobrado_destino" ||
      estadoPago === "pagado" ||
      estadoPago === "pagado_origen" ||
      situacionOperativa === "LISTA_PARA_ENTREGA" ||
      situacionOperativa === "ENTREGADA" ||
      (esPagoOrigen && estadoPago === "no_aplica");

    const puedeDespachar = accionPrincipal === "DESPACHAR";
    const puedeRecibirDestino = accionPrincipal === "RECIBIR_DESTINO";
    const puedeCobrar = accionPrincipal === "REGISTRAR_COBRO";
    const puedeEntregar = accionPrincipal === "ENTREGAR";
    const puedeRendir = accionPrincipal === "RENDIR_COBRO";
    const listaParaEntrega = situacionOperativa === "LISTA_PARA_ENTREGA";

    return {
      source: "estado_derivado",
      estadoLog,
      estadoPago,
      condicionPago,
      tipoCobro,
      esPagoDestino,
      esPagoOrigen,
      cobroConfirmado,
      tieneExcepcion,
      bloqueadoPorPagoOrigen,
      rendido,
      pendienteRendicion,
      puedeDespachar,
      puedeRecibirDestino,
      puedeCobrar,
      puedeEntregar,
      puedeRendir,
      listaParaEntrega,
      estadoOperativo: situacionOperativa || "SIN_CLASIFICAR",
      situacionOperativa,
      situacionContable,
      accionPrincipal,
      resumenCorto: der.resumen_corto || "",
      bloqueos,
      alertas,
      cierreEstado: normalizeUpper(der.cierre_estado),
      liquidacionEstado: normalizeUpper(der.liquidacion_estado),
      conciliacionEstado: normalizeUpper(der.conciliacion_estado)
    };
  }

  function canUseExcepcion(guia) {
    if (!isOwnerOrAdminUser()) return false;

    const op = deriveOperativa(guia);
    return (
      op.esPagoDestino &&
      (op.estadoLog === "RECIBIDO_DESTINO" || op.estadoLog === "RECIBIDO_DESTINO_OBSERVADO") &&
      op.estadoPago === "pendiente_destino"
    );
  }

  function badgeOperativa(g) {
    const op = deriveOperativa(g);
    const out = [];

    out.push(badgeText(
      operativaText(op.situacionOperativa || op.estadoOperativo),
      operativaClass(op.situacionOperativa || op.estadoOperativo)
    ));

    if (op.situacionContable && op.situacionContable !== "NO_APLICA") {
      out.push(badgeText(contableText(op.situacionContable), contableClass(op.situacionContable)));
    }

    if (firstMsg(op.bloqueos)) {
      out.push(badgeText(firstMsg(op.bloqueos), "bad"));
    } else if (firstMsg(op.alertas)) {
      out.push(badgeText(firstMsg(op.alertas), "warn"));
    }

    return out.join(" ");
  }

  function renderEstadoMeta(g) {
    const op = deriveOperativa(g);
    const bits = [];

    if (op.resumenCorto) {
      bits.push(`<div class="muted" style="font-size:12px">${esc(op.resumenCorto)}</div>`);
    }

    if (firstMsg(op.bloqueos)) {
      bits.push(`<div class="muted" style="font-size:12px">Bloqueo: ${esc(firstMsg(op.bloqueos))}</div>`);
    } else if (firstMsg(op.alertas)) {
      bits.push(`<div class="muted" style="font-size:12px">Alerta: ${esc(firstMsg(op.alertas))}</div>`);
    }

    return bits.join("");
  }

  function montoSugeridoCobro(g) {
    const a = Number(g.monto_cobrar_destino ?? 0);
    const b = Number(g.monto_total ?? 0);
    return a > 0 ? a : b;
  }

  /* =========================
     MODAL RUNTIME
  ========================= */
  function ensureRuntimeModal() {
    if ($("modalBack")) return;

    const back = document.createElement("div");
    back.id = "modalBack";
    back.style.cssText = [
      "display:none",
      "position:fixed",
      "inset:0",
      "background:rgba(0,0,0,.55)",
      "z-index:9999",
      "align-items:center",
      "justify-content:center",
      "padding:16px"
    ].join(";");

    back.innerHTML = `
      <div id="modalCard" style="width:min(560px,96vw);background:#101722;border:1px solid rgba(255,255,255,.08);border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.35);overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08)">
          <div id="modalTitle" style="font-weight:700">Operación</div>
          <button type="button" data-modal-close="1" class="exr-pro-btn">Cerrar</button>
        </div>
        <div id="modalBody" style="padding:16px"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;padding:14px 16px;border-top:1px solid rgba(255,255,255,.08)">
          <button type="button" id="modalCancel" class="exr-pro-btn">Cancelar</button>
          <button type="button" id="modalConfirm" class="exr-pro-btn ok">Confirmar</button>
        </div>
      </div>
    `;

    document.body.appendChild(back);

    back.addEventListener("click", (e) => {
      if (e.target === back || e.target.closest("[data-modal-close='1']")) {
        closeModal();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && back.style.display === "flex") closeModal();
    });
  }

  function closeModal() {
    const back = $("modalBack");
    if (!back) return;
    back.style.display = "none";

    const body = $("modalBody");
    if (body) body.innerHTML = "";
  }

  function openModal({ title, html, confirmText = "Confirmar", onConfirm }) {
    ensureRuntimeModal();

    const back = $("modalBack");
    const titleEl = $("modalTitle");
    const bodyEl = $("modalBody");
    const btnCancel = $("modalCancel");
    const btnConfirm = $("modalConfirm");

    if (!back || !titleEl || !bodyEl || !btnCancel || !btnConfirm) return;

    titleEl.textContent = title;
    bodyEl.innerHTML = html;
    btnConfirm.textContent = confirmText;
    back.style.display = "flex";

    btnCancel.onclick = () => closeModal();

    btnConfirm.onclick = async () => {
      try {
        btnConfirm.disabled = true;
        btnCancel.disabled = true;
        await onConfirm?.({ body: bodyEl, close: closeModal });
      } finally {
        btnConfirm.disabled = false;
        btnCancel.disabled = false;
      }
    };
  }

  /* =========================
     TABS / FILTERS
  ========================= */
  function renderTabs() {
    const el = $("tabs");
    if (!el) return;

    el.innerHTML = TABS.map(t => `
      <button class="tab ${t.key === activeTab ? "active" : ""}" data-k="${t.key}">
        ${esc(t.label)}
      </button>
    `).join("");
  }

  function renderQuickChips() {
    const el = $("quickChips");
    if (!el) return;

    const items = [
      { k: "ALL", label: "Todo" },
      { k: "COBRO_DEST_PEND", label: "Cobro destino pendiente" },
      { k: "COBRADO_DEST", label: "Cobrado destino" },
      { k: "PEND_RENDICION", label: "Pendiente rendición" },
      { k: "RENDIDO", label: "Rendido" },
      { k: "OBSERVADO", label: "Observado" },
      { k: "PEND_ORIGEN", label: "Pendiente origen" },
    ];

    el.innerHTML = items.map(i => `
      <button class="tab ${i.k === quick ? "active" : ""}" data-qc="${i.k}">
        ${esc(i.label)}
      </button>
    `).join("");
  }

  function buildServerFilters() {
    const selEstLog = $("f_estado_log")?.value || "";
    const estado_logistico = (activeTab !== "ALL") ? activeTab : (selEstLog || "");

    let estado_pago = normalizeLower($("f_estado_pago")?.value || "");
    let tipo_cobro = $("f_tipo_cobro")?.value || "";
    let sin_metodo = 0;
    let rendicion = "";

    if (quick === "COBRO_DEST_PEND") {
      estado_pago = "pendiente_destino";
      if (!tipo_cobro) tipo_cobro = "DESTINO";
    } else if (quick === "COBRADO_DEST") {
      estado_pago = "cobrado_destino";
      if (!tipo_cobro) tipo_cobro = "DESTINO";
    } else if (quick === "PEND_RENDICION") {
      estado_pago = "pendiente_rendicion";
      if (!tipo_cobro) tipo_cobro = "DESTINO";
    } else if (quick === "RENDIDO") {
      estado_pago = "rendido";
      if (!tipo_cobro) tipo_cobro = "DESTINO";
    } else if (quick === "OBSERVADO") {
      estado_pago = "observado";
      if (!tipo_cobro) tipo_cobro = "DESTINO";
    } else if (quick === "PEND_ORIGEN") {
      estado_pago = "pendiente_origen";
      if (!tipo_cobro) tipo_cobro = "ORIGEN";
    } else if (quick === "SIN_METODO") {
      sin_metodo = 1;
      estado_pago = "cobrado_destino";
    }

    return { estado_logistico, estado_pago, tipo_cobro, sin_metodo, rendicion };
  }

  /* =========================
     TABLE
  ========================= */
  function routeLabel(g) {
    const o = g.sucursal_origen_codigo || g.sucursal_origen_nombre || ("S" + g.sucursal_origen_id);
    const d = g.sucursal_destino_codigo || g.sucursal_destino_nombre || ("S" + g.sucursal_destino_id);
    const on = g.sucursal_origen_nombre ? ` <span class="muted">(${esc(g.sucursal_origen_nombre)})</span>` : "";
    const dn = g.sucursal_destino_nombre ? ` <span class="muted">(${esc(g.sucursal_destino_nombre)})</span>` : "";
    return `<div><b>${esc(o)}</b>${on} → <b>${esc(d)}</b>${dn}</div>`;
  }

  function rowIsBad(g) {
    const op = deriveOperativa(g);
    return (
      ["PENDIENTE_COBRO_DESTINO", "OBSERVADA", "PENDIENTE_PAGO_ORIGEN"].includes(op.situacionOperativa || op.estadoOperativo) ||
      !!firstMsg(op.bloqueos)
    );
  }

  function renderAcciones(g) {
    const op = deriveOperativa(g);
    const btns = [];

    btns.push(`<button class="exr-pro-btn" data-act="detalle" data-id="${g.id}">Detalle</button>`);
    btns.push(`<button class="exr-pro-btn" data-act="etiqueta_thermal" data-id="${g.id}">Etiqueta térmica</button>`);
    btns.push(`<button class="exr-pro-btn" data-act="etiqueta_a4" data-id="${g.id}">Etiquetas A4</button>`);

    if (op.puedeDespachar) {
      btns.push(`<button class="exr-pro-btn ok" data-act="despachar" data-id="${g.id}">Despachar</button>`);
    }

    if (op.puedeRecibirDestino) {
      btns.push(`<button class="exr-pro-btn ok" data-act="recibir_destino" data-id="${g.id}">Recibir destino</button>`);
    }

    if (op.puedeCobrar) {
      btns.push(`<button class="exr-pro-btn ok" data-act="cobrar" data-id="${g.id}">Registrar cobro</button>`);
    }

    if (op.puedeRendir) {
      btns.push(`<button class="exr-pro-btn" data-act="rendir" data-id="${g.id}">Rendir manual</button>`);
    }

    if (op.puedeEntregar) {
      btns.push(`<button class="exr-pro-btn ok" data-act="entregar" data-id="${g.id}">Entregar</button>`);
    }

    if (canUseExcepcion(g)) {
      btns.push(`<button class="exr-pro-btn" data-act="excepcion" data-id="${g.id}">Excepción</button>`);
    }

    return `<div style="display:flex;gap:8px;flex-wrap:wrap">${btns.join("")}</div>`;
  }

  function renderPager() {
    const totalPages = Math.max(1, Math.ceil((apiTotal || 0) / limit));
    if (page > totalPages) page = totalPages;

    if ($("pagerInfo")) {
      $("pagerInfo").textContent = `Página ${page} / ${totalPages} • Total: ${apiTotal}`;
    }
    if ($("btnPrev")) $("btnPrev").disabled = (page <= 1);
    if ($("btnNext")) $("btnNext").disabled = (page >= totalPages);
    if ($("limitSel")) $("limitSel").value = String(limit);
  }

  function render() {
    const tbody = $("tbody");
    const msg = $("msg");
    if (!tbody) return;

    if ($("countTxt")) $("countTxt").textContent = String(all.length);
    renderPager();

    if (!all.length) {
      tbody.innerHTML = "";
      if (msg) msg.textContent = "Sin guías para los filtros actuales.";
      writeUI(captureUI());
      return;
    }

    if (msg) msg.textContent = `Mostrando ${all.length} en esta página (limit ${limit}).`;

    tbody.innerHTML = all.map(g => {
      const op = deriveOperativa(g);
      const nro = esc(g.numero_guia ?? g.id);
      const ruta = `${routeLabel(g)}<div class="muted" style="font-size:12px">${esc(dt(g.created_at))}</div>`;
      const cliente = `
        <div><b>${esc(g.remitente_nombre || "—")}</b> <span class="muted">→</span> <b>${esc(g.destinatario_nombre || "—")}</b></div>
        <div class="muted" style="font-size:12px">${esc(g.remitente_telefono || "")} • ${esc(g.destinatario_telefono || "")}</div>
      `;

      const estados = `
        <div style="display:grid;gap:6px">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${badgeLog(g.estado_logistico)}
            ${badgePago(g)}
            ${badgeOperativa(g)}
          </div>
          ${renderEstadoMeta(g)}
        </div>
      `;

      const monto = `
        <div><b>${money(g.monto_total ?? 0)}</b></div>
        <div class="muted" style="font-size:12px">${esc(g.condicion_pago || g.tipo_cobro || "")} • ${esc(pagoVisible(g))}</div>
        ${
          Number(g.monto_cobrar_destino || 0) > 0
            ? `<div class="muted" style="font-size:12px">Cobrar destino: ${money(g.monto_cobrar_destino)}</div>`
            : ""
        }
        ${
          op.situacionContable && op.situacionContable !== "NO_APLICA"
            ? `<div class="muted" style="font-size:12px">${esc(contableText(op.situacionContable))}</div>`
            : ""
        }
        ${
          op.cierreEstado && op.cierreEstado !== "SIN_CIERRE"
            ? `<div class="muted" style="font-size:12px">Cierre: ${esc(op.cierreEstado)}</div>`
            : ""
        }
        ${
          op.liquidacionEstado && op.liquidacionEstado !== "NO_APLICA"
            ? `<div class="muted" style="font-size:12px">Liquidación: ${esc(op.liquidacionEstado)}</div>`
            : ""
        }
        ${
          op.conciliacionEstado && op.conciliacionEstado !== "NO_APLICA"
            ? `<div class="muted" style="font-size:12px">Conciliación: ${esc(op.conciliacionEstado)}</div>`
            : ""
        }
      `;

      const acciones = renderAcciones(g);

      return `
        <tr class="${rowIsBad(g) ? "bandeja-row-bad" : ""}">
          <td class="mono"><b>${nro}</b></td>
          <td>${ruta}</td>
          <td>${cliente}</td>
          <td>${estados}</td>
          <td>${monto}</td>
          <td>${acciones}</td>
        </tr>
      `;
    }).join("");

    writeUI(captureUI());
  }

  /* =========================
     CSV
  ========================= */
  function csvCell(v) {
    const s = String(v ?? "");
    const needs = /[;\n\r"]/g.test(s);
    const escaped = s.replaceAll('"', '""');
    return needs ? `"${escaped}"` : escaped;
  }

  function toCSV(rows) {
    const cols = [
      ["numero_guia", "N° Guía"],
      ["created_at", "Fecha"],
      ["sucursal_origen_codigo", "Origen"],
      ["sucursal_destino_codigo", "Destino"],
      ["sucursal_origen_nombre", "Origen (nombre)"],
      ["sucursal_destino_nombre", "Destino (nombre)"],
      ["remitente_nombre", "Remitente"],
      ["remitente_telefono", "Tel Rem"],
      ["destinatario_nombre", "Destinatario"],
      ["destinatario_telefono", "Tel Dest"],
      ["estado_logistico", "Estado Log"],
      ["estado_pago", "Estado Pago"],
      ["metodo_pago", "Método Pago"],
      ["tipo_cobro", "Tipo Cobro"],
      ["condicion_pago", "Condición Pago"],
      ["monto_cobrar_destino", "Monto Cobrar Destino"],
      ["monto_total", "Monto Total"],
      ["rendido_at", "Rendido At"],
      ["rendido_by_usuario", "Rendido Por"],
    ];

    const header = cols.map(c => csvCell(c[1])).join(";");
    const lines = rows.map(r => cols.map(c => csvCell(r?.[c[0]])).join(";"));
    return [header, ...lines].join("\n");
  }

  async function exportCSVAll() {
    const q = ($("q")?.value || "").trim();
    const f = buildServerFilters();

    const url =
      `${ENDPOINTS.bandeja}?export=1` +
      `&q=${encodeURIComponent(q)}` +
      `&estado_logistico=${encodeURIComponent(f.estado_logistico || "")}` +
      `&estado_pago=${encodeURIComponent(f.estado_pago || "")}` +
      `&tipo_cobro=${encodeURIComponent(f.tipo_cobro || "")}` +
      `&sin_metodo=${encodeURIComponent(String(f.sin_metodo || 0))}` +
      `&rendicion=${encodeURIComponent(f.rendicion || "")}`;

    const data = await api(url);
    const rows = Array.isArray(data) ? data : (data?.guias || []);

    const csv = toCSV(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });

    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    a.href = URL.createObjectURL(blob);
    a.download = `exr_bandeja_${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);

    toast("Export listo", `Filas: ${rows.length}`, "ok");
  }

  /* =========================
     OPERACIONES
  ========================= */
  async function cambiarEstado(guia, nuevoEstado, textoOk) {
    await api(ENDPOINTS.estado, {
      method: "POST",
      json: true,
      body: JSON.stringify({
        guia_id: guia.id,
        estado: nuevoEstado,
      })
    });

    toast("OK", textoOk || "Estado actualizado.", "ok");
    await load();
  }

  function openCobroModal(guia) {
    const sugerido = montoSugeridoCobro(guia);

    openModal({
      title: `Registrar cobro · ${guia.numero_guia || guia.id}`,
      confirmText: "Registrar cobro",
      html: `
        <div style="display:grid;gap:12px">
          <div class="muted" style="font-size:12px">
            Guía ${esc(guia.numero_guia || guia.id)} • ${esc(guia.remitente_nombre || "—")} → ${esc(guia.destinatario_nombre || "—")}
          </div>

          <label>
            <div style="margin-bottom:6px">Monto</div>
            <input id="exrCobroMonto" type="number" step="0.01" value="${sugerido}" style="width:100%;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#0c121b;color:#fff">
          </label>

          <label>
            <div style="margin-bottom:6px">Medio de pago</div>
            <select id="exrCobroMedio" style="width:100%;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#0c121b;color:#fff">
              <option value="efectivo">Efectivo</option>
              <option value="transferencia">Transferencia</option>
              <option value="qr">QR</option>
            </select>
          </label>

          <label>
            <div style="margin-bottom:6px">Referencia externa</div>
            <input id="exrCobroRef" type="text" placeholder="Comprobante / referencia" style="width:100%;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#0c121b;color:#fff">
          </label>

          <label>
            <div style="margin-bottom:6px">Observaciones</div>
            <textarea id="exrCobroObs" rows="3" style="width:100%;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#0c121b;color:#fff"></textarea>
          </label>
        </div>
      `,
      onConfirm: async ({ body, close }) => {
        const monto = Number(body.querySelector("#exrCobroMonto")?.value || 0);
        const medio_pago = String(body.querySelector("#exrCobroMedio")?.value || "").trim().toLowerCase();
        const referencia_externa = (body.querySelector("#exrCobroRef")?.value || "").trim();
        const observaciones = (body.querySelector("#exrCobroObs")?.value || "").trim();
        const inpMonto = body.querySelector("#exrCobroMonto");

        if (!(monto >= 0)) {
          if (inpMonto) {
            inpMonto.style.borderColor = "rgba(255,92,119,.8)";
            inpMonto.focus();
          }
          toast("Monto inválido", "Ingresá un monto válido.", "warn");
          return;
        }

        if (!medio_pago) {
          toast("Falta medio de pago", "Seleccioná un medio de pago.", "warn");
          return;
        }

        try {
          if (inpMonto) inpMonto.style.borderColor = "";

          await api(ENDPOINTS.registrarCobro, {
            method: "POST",
            json: true,
            body: JSON.stringify({
              guia_id: guia.id,
              medio_pago,
              monto,
              referencia_externa,
              observaciones,
            })
          });

          close();
          toast("Cobro registrado", `Guía ${guia.numero_guia || guia.id}`, "ok");
          await load();
        } catch (err) {
          const msg = err?.message || "No se pudo registrar el cobro.";
          if (inpMonto) {
            inpMonto.style.borderColor = "rgba(255,92,119,.8)";
            inpMonto.focus();
          }
          toast("Error al registrar cobro", msg, "bad");
        }
      }
    });
  }

  function openRendirModal(guia) {
    openModal({
      title: `Rendir cobro · ${guia.numero_guia || guia.id}`,
      confirmText: "Rendir",
      html: `
        <div style="display:grid;gap:12px">
          <div class="muted" style="font-size:12px">
            Esta acción marcará el cobro como <b>rendido</b> en el circuito interno.
          </div>
          <div>
            <b>Guía:</b> ${esc(guia.numero_guia || guia.id)}
          </div>
          <div>
            <b>Cliente:</b> ${esc(guia.remitente_nombre || "—")} → ${esc(guia.destinatario_nombre || "—")}
          </div>
          <div>
            <b>Monto:</b> ${money(guia.monto_cobrar_destino ?? guia.monto_total ?? 0)}
          </div>
        </div>
      `,
      onConfirm: async ({ close }) => {
        try {
          await api(ENDPOINTS.rendirCobro, {
            method: "POST",
            json: true,
            body: JSON.stringify({
              guia_id: guia.id,
            })
          });

          close();
          toast("Cobro rendido", `Guía ${guia.numero_guia || guia.id}`, "ok");
          await load();
        } catch (err) {
          toast("Error al rendir", err?.message || "No se pudo rendir el cobro.", "bad");
        }
      }
    });
  }

  function openExcepcionModal(guia) {
    openModal({
      title: `Excepción de entrega · ${guia.numero_guia || guia.id}`,
      confirmText: "Registrar excepción",
      html: `
        <div style="display:grid;gap:12px">
          <div class="muted" style="font-size:12px">
            Esta acción marcará la guía como <b>OBSERVADO</b> y permitirá la entrega bajo excepción autorizada.
          </div>

          <label>
            <div style="margin-bottom:6px">Motivo</div>
            <textarea id="exrExcMotivo" rows="4" placeholder="Motivo obligatorio" style="width:100%;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#0c121b;color:#fff"></textarea>
          </label>
        </div>
      `,
      onConfirm: async ({ body, close }) => {
        const motivo = (body.querySelector("#exrExcMotivo")?.value || "").trim();

        if (!motivo) {
          toast("Motivo obligatorio", "Completá el motivo.", "warn");
          return;
        }

        try {
          await api(ENDPOINTS.excepcionEntrega, {
            method: "POST",
            json: true,
            body: JSON.stringify({
              guia_id: guia.id,
              motivo,
            })
          });

          close();
          toast("Excepción registrada", `Guía ${guia.numero_guia || guia.id}`, "warn");
          await load();
        } catch (err) {
          toast("Error al registrar excepción", err?.message || "No se pudo registrar la excepción.", "bad");
        }
      }
    });
  }

  function openConfirmModal({ title, message, confirmText, onConfirm }) {
    openModal({
      title,
      confirmText,
      html: `<div>${message}</div>`,
      onConfirm
    });
  }

  /* =========================
     EVENTS
  ========================= */
  function bindTableActions() {
    const tbody = $("tbody");
    if (!tbody) return;

    tbody.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;

      const act = btn.dataset.act;
      const id = btn.dataset.id;
      if (!id) return;

      const guia = all.find(x => String(x.id) === String(id));
      if (!guia) return;

      if (act === "etiqueta_thermal") {
        const total = Number(guia.cant_bultos || guia.cant_bultos_declarada || 0);
        const qs = new URLSearchParams({
          id: String(id),
          mode: "thermal"
        });
        if (total > 0) qs.set("n", String(total));

        window.open(`/etiqueta_batch.html?${qs.toString()}`, "_blank");
        return;
      }

      if (act === "etiqueta_a4") {
        const total = Number(guia.cant_bultos || guia.cant_bultos_declarada || 0);
        const qs = new URLSearchParams({
          id: String(id),
          mode: "a4"
        });
        if (total > 0) qs.set("n", String(total));

        window.open(`/etiqueta_batch.html?${qs.toString()}`, "_blank");
        return;
      }

      if (act === "detalle") {
        location.href = `/detalle.html?id=${encodeURIComponent(id)}`;
        return;
      }

      if (act === "despachar") {
        openConfirmModal({
          title: `Despachar · ${guia.numero_guia || guia.id}`,
          message: "La guía pasará a EN_TRANSITO.",
          confirmText: "Despachar",
          onConfirm: async ({ close }) => {
            await cambiarEstado(guia, "EN_TRANSITO", "Guía despachada.");
            close();
          }
        });
        return;
      }

      if (act === "recibir_destino") {
        openConfirmModal({
          title: `Recibir en destino · ${guia.numero_guia || guia.id}`,
          message: "La guía pasará a RECIBIDO_DESTINO.",
          confirmText: "Recibir",
          onConfirm: async ({ close }) => {
            await cambiarEstado(guia, "RECIBIDO_DESTINO", "Guía recibida en destino.");
            close();
          }
        });
        return;
      }

      if (act === "entregar") {
        openConfirmModal({
          title: `Entregar · ${guia.numero_guia || guia.id}`,
          message: "La guía pasará a ENTREGADO.",
          confirmText: "Entregar",
          onConfirm: async ({ close }) => {
            await cambiarEstado(guia, "ENTREGADO", "Guía entregada.");
            close();
          }
        });
        return;
      }

      if (act === "cobrar") {
        openCobroModal(guia);
        return;
      }

      if (act === "rendir") {
        openRendirModal(guia);
        return;
      }

      if (act === "excepcion") {
        openExcepcionModal(guia);
      }
    });
  }

  function bindEvents() {
    $("tabs")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".tab");
      if (!btn) return;
      activeTab = btn.dataset.k || "ALL";
      page = 1;
      writeUI(captureUI());
      load();
    });

    $("quickChips")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".tab");
      if (!btn) return;
      quick = btn.dataset.qc || "ALL";
      page = 1;
      writeUI(captureUI());
      load();
    });

    $("btnRefresh")?.addEventListener("click", () => {
      writeUI(captureUI());
      load();
    });

    $("btnBuscar")?.addEventListener("click", () => {
      page = 1;
      writeUI(captureUI());
      load();
    });

    $("btnExport")?.addEventListener("click", () => {
      exportCSVAll().catch(e => toast("Error export", e.message, "bad"));
    });

    ["f_estado_log", "f_estado_pago", "f_tipo_cobro"].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("change", () => {
        page = 1;
        writeUI(captureUI());
        load();
      });
    });

    $("q")?.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        page = 1;
        writeUI(captureUI());
        load();
      }, 350);
    });

    $("q")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        clearTimeout(debounceTimer);
        page = 1;
        writeUI(captureUI());
        load();
      }
      if (e.key === "Escape") {
        clearTimeout(debounceTimer);
        e.target.value = "";
        if ($("f_estado_log")) $("f_estado_log").value = "";
        if ($("f_estado_pago")) $("f_estado_pago").value = "";
        if ($("f_tipo_cobro")) $("f_tipo_cobro").value = "";
        page = 1;
        writeUI(captureUI());
        load();
      }
    });

    $("btnPrev")?.addEventListener("click", () => {
      if (page > 1) {
        page--;
        writeUI(captureUI());
        load();
      }
    });

    $("btnNext")?.addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil((apiTotal || 0) / limit));
      if (page < totalPages) {
        page++;
        writeUI(captureUI());
        load();
      }
    });

    $("limitSel")?.addEventListener("change", (e) => {
      limit = parseInt(e.target.value, 10) || 25;
      page = 1;
      writeUI(captureUI());
      load();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() === "r") {
        writeUI(captureUI());
        load();
      }
    });

    bindTableActions();
  }

  /* =========================
     LOAD
  ========================= */
  async function load() {
    try {
      const me = await api(ENDPOINTS.authPing);
      const u = me?.user || me || {};
      currentUser = u;

      if ($("userChip")) {
        $("userChip").textContent =
          `${u.usuario || "usuario"} • ${u.rol || "ROL"} ${u.sucursal_id ? ("• S" + u.sucursal_id) : "• Global"}`;
      }
    } catch (_e) {
      return logout();
    }

    try {
      if ($("msg")) $("msg").textContent = "Cargando…";
      setSyncChip("loading");

      const q = ($("q")?.value || "").trim();
      const offset = (page - 1) * limit;
      const f = buildServerFilters();

      const url =
        `${ENDPOINTS.bandeja}?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}` +
        `&q=${encodeURIComponent(q)}` +
        `&estado_logistico=${encodeURIComponent(f.estado_logistico || "")}` +
        `&estado_pago=${encodeURIComponent(f.estado_pago || "")}` +
        `&tipo_cobro=${encodeURIComponent(f.tipo_cobro || "")}` +
        `&sin_metodo=${encodeURIComponent(String(f.sin_metodo || 0))}` +
        `&rendicion=${encodeURIComponent(f.rendicion || "")}`;

      const token = getToken();
      const headers = {};
      if (token) headers["Authorization"] = "Bearer " + token;
      if (lastEtag) headers["If-None-Match"] = String(lastEtag).replace(/"/g, "");

      const r = await fetch(url, { headers });

      if (r.status === 304) {
        lastUpdatedAt = Date.now();
        setSyncChip("same");
        return;
      }

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(t || ("HTTP " + r.status));
      }

      const data = await r.json();
      const etag = r.headers.get("etag") || "";

      if (etag) {
        lastEtag = etag;
        localStorage.setItem(LS_ETAG, etag);
      }

      all = Array.isArray(data) ? data : (data?.guias || []);
      apiTotal = Number(data?.total ?? all.length ?? 0);

      lastUpdatedAt = Date.now();
      setSyncChip("ok", `rows ${all.length}/${apiTotal}`);

      renderTabs();
      renderQuickChips();
      render();
    } catch (e) {
      if ($("msg")) $("msg").textContent = "Error: " + e.message;
      setSyncChip("err", e.message);
      toast("Error", e.message, "bad");
    }
  }

  /* =========================
     AUTO REFRESH
  ========================= */
  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);

    refreshTimer = setInterval(() => {
      const active = document.activeElement;
      if (active && active.id === "q") return;

      const modal = $("modalBack");
      if (modal && modal.style && modal.style.display === "flex") return;

      load();
    }, 8000);
  }

  /* =========================
     BOOT
  ========================= */
  function boot() {
    renderTabs();
    renderQuickChips();
    applyUI(readUI());
    renderTabs();
    renderQuickChips();
    writeUI(captureUI());

    bindEvents();
    ensureRuntimeModal();
    load();
    startAutoRefresh();
  }

  boot();
})();