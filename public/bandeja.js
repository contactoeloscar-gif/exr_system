document.title = "Bandeja Operativa EXR";
console.log("BANDEJA.JS OPERATIVA -", new Date().toISOString());

window.addEventListener("error", (e) => {
  console.error(
    "JS ERROR:",
    e.message,
    "at",
    e.filename + ":" + e.lineno + ":" + e.colno
  );
});

(() => {
  const $ = (id) => document.getElementById(id);

  const LS_TOKEN = "exr_token";
  const LS_UI = "exr_bandeja_ui";

  const ENDPOINTS = {
    ping: "/interno/ping",
    bandeja: "/interno/bandeja",
    estado: "/guias/estado",
    registrarCobro: "/interno/cobros/registrar",
    rendirCobro: "/interno/cobros/rendir",
    excepcionEntrega: "/interno/cobros/excepcion-entrega",
  };

  const TABS = [
    { key: "RECIBIDO_ORIGEN", label: "Pendientes origen" },
    { key: "EN_TRANSITO", label: "En tránsito" },
    { key: "RECIBIDO_CENTRAL", label: "En central" },
    { key: "RECIBIDO_DESTINO", label: "En destino" },
    { key: "ENTREGADO", label: "Entregadas" },
    { key: "ALL", label: "Todas" },
  ];

  let all = [];
  let activeTab = "RECIBIDO_ORIGEN";
  let refreshTimer = null;
  let debounceTimer = null;
  let currentUser = null;

  function esc(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setMsg(type, text) {
    const box = $("msg");
    if (!box) return;
    if (!text) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML = `<div class="${type}">${esc(text)}</div>`;
  }

  function token() {
    return localStorage.getItem(LS_TOKEN);
  }

  function clearToken() {
    localStorage.removeItem(LS_TOKEN);
  }

  function saveUI() {
    const ui = {
      activeTab,
      payFilter: $("payFilter")?.value || "",
      quickFilter: $("quickFilter")?.value || "",
      autoRefresh: $("autoRefresh")?.value || "",
      q: $("q")?.value || "",
    };
    localStorage.setItem(LS_UI, JSON.stringify(ui));
  }

  function loadUI() {
    try {
      const ui = JSON.parse(localStorage.getItem(LS_UI) || "{}");
      if (ui.activeTab) activeTab = ui.activeTab;
      if ($("payFilter") && ui.payFilter !== undefined) $("payFilter").value = ui.payFilter;
      if ($("quickFilter") && ui.quickFilter !== undefined) $("quickFilter").value = ui.quickFilter;
      if ($("autoRefresh") && ui.autoRefresh !== undefined) $("autoRefresh").value = ui.autoRefresh;
      if ($("q") && ui.q !== undefined) $("q").value = ui.q;
    } catch {}
  }

  async function safeReadJson(resp) {
    const text = await resp.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { _raw: text };
    }
  }

  async function api(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };

    if (opts.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const t = token();
    if (t) headers["Authorization"] = "Bearer " + t;

    const resp = await fetch(url, { ...opts, headers });
    const data = await safeReadJson(resp);

    if (!resp.ok || data.ok === false) {
      const msg = data?.error || data?.message || ("HTTP " + resp.status);
      throw new Error(msg);
    }
    return data;
  }

  function fmtDate(iso) {
    if (!iso) return "-";
    try {
      return new Date(iso).toLocaleString("es-AR");
    } catch {
      return iso;
    }
  }

  function isToday(iso) {
    try {
      const d = new Date(iso);
      const now = new Date();
      return (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      );
    } catch {
      return false;
    }
  }

  function statePill(s, extraClass = "") {
    return `<span class="state ${extraClass}">${esc(s || "-")}</span>`;
  }

  function payPill(p, extraClass = "") {
    return `<span class="pay ${extraClass}">${esc(p || "-")}</span>`;
  }

  function normUpper(v) {
    return String(v || "").trim().toUpperCase();
  }

  function normLower(v) {
    return String(v || "").trim().toLowerCase();
  }

  function isOwnerOrAdmin() {
    const rol = String(currentUser?.rol || "").trim().toUpperCase();
    return rol === "OWNER" || rol === "ADMIN";
  }

  function tabKeyForEstado(estadoLogistico) {
    const e = normUpper(estadoLogistico);

    if (e === "RECIBIDO_ORIGEN") return "RECIBIDO_ORIGEN";
    if (["EN_TRANSITO", "EN_TRANSITO_A_CENTRAL", "EN_TRANSITO_A_DESTINO"].includes(e)) return "EN_TRANSITO";
    if (["RECIBIDO_CENTRAL", "RECIBIDO_CENTRAL_OBSERVADO"].includes(e)) return "RECIBIDO_CENTRAL";
    if (["RECIBIDO_DESTINO", "RECIBIDO_DESTINO_OBSERVADO"].includes(e)) return "RECIBIDO_DESTINO";
    if (e === "ENTREGADO") return "ENTREGADO";
    return "ALL";
  }

  function estadoLogLabel(estadoLogistico) {
    const e = normUpper(estadoLogistico);
    const map = {
      RECIBIDO_ORIGEN: "Recibido origen",
      EN_TRANSITO: "En tránsito",
      EN_TRANSITO_A_CENTRAL: "A central",
      RECIBIDO_CENTRAL: "Recibido central",
      RECIBIDO_CENTRAL_OBSERVADO: "Central observado",
      EN_TRANSITO_A_DESTINO: "A destino",
      RECIBIDO_DESTINO: "Recibido destino",
      RECIBIDO_DESTINO_OBSERVADO: "Destino observado",
      ENTREGADO: "Entregado",
    };
    return map[e] || e || "-";
  }

  function pagoVisible(g) {
    const estado = normLower(g.estado_pago);
    const condicion = normUpper(g.condicion_pago || g.tipo_cobro);

    if (condicion === "ORIGEN") {
      if (estado === "pendiente_origen") return "PENDIENTE";
      if (estado === "observado") return "OBSERVADO";
      return "PAGADO";
    }

    if (condicion === "DESTINO") {
      if (estado === "pendiente_destino") return "PENDIENTE";
      if (estado === "observado") return "OBSERVADO";
      if (estado === "cobrado_destino" || estado === "rendido") return "PAGADO";
      return estado ? estado.toUpperCase() : "-";
    }

    return estado ? estado.toUpperCase() : "-";
  }

  function deriveFlags(g) {
    const estadoLog = normUpper(g.estado_logistico);
    const estadoPago = normLower(g.estado_pago);
    const condicionPago = normUpper(g.condicion_pago || g.tipo_cobro);

    const destinoRecibido = ["RECIBIDO_DESTINO", "RECIBIDO_DESTINO_OBSERVADO"].includes(estadoLog);
    const centralRecibido = ["RECIBIDO_CENTRAL", "RECIBIDO_CENTRAL_OBSERVADO"].includes(estadoLog);
    const observadaDestino = estadoLog === "RECIBIDO_DESTINO_OBSERVADO";
    const observadaCentral = estadoLog === "RECIBIDO_CENTRAL_OBSERVADO";

    const puedeCobrar =
      destinoRecibido &&
      condicionPago === "DESTINO" &&
      estadoPago === "pendiente_destino";

    const puedeEntregar =
      destinoRecibido &&
      (
        condicionPago !== "DESTINO" ||
        estadoPago === "cobrado_destino" ||
        estadoPago === "rendido" ||
        estadoPago === "observado"
      );

    const puedeRendir =
      isOwnerOrAdmin() &&
      condicionPago === "DESTINO" &&
      estadoPago === "cobrado_destino";

    const puedeExcepcion =
      isOwnerOrAdmin() &&
      destinoRecibido &&
      condicionPago === "DESTINO" &&
      estadoPago === "pendiente_destino";

    return {
      estadoLog,
      estadoPago,
      condicionPago,
      destinoRecibido,
      centralRecibido,
      observadaDestino,
      observadaCentral,
      puedeCobrar,
      puedeEntregar,
      puedeRendir,
      puedeExcepcion,
    };
  }

  function getCounts() {
    const counts = { ALL: all.length };
    for (const g of all) {
      const k = tabKeyForEstado(g.estado_logistico);
      counts[k] = (counts[k] || 0) + 1;
    }
    return counts;
  }

  function renderTabs(counts) {
    const box = $("tabs");
    if (!box) return;

    box.innerHTML = "";
    TABS.forEach((t) => {
      const c = t.key === "ALL" ? all.length : (counts[t.key] || 0);
      const btn = document.createElement("button");
      btn.className = "tab" + (activeTab === t.key ? " active" : "");
      btn.innerHTML = `${esc(t.label)} <span class="badge">${c}</span>`;
      btn.onclick = () => {
        activeTab = t.key;
        saveUI();
        renderTabs(counts);
        render();
      };
      box.appendChild(btn);
    });
  }

  function filtered() {
    const q = ($("q")?.value || "").trim().toLowerCase();
    const pay = $("payFilter")?.value || "";
    const quick = $("quickFilter")?.value || "";

    return all
      .filter((g) => {
        const tabKey = tabKeyForEstado(g.estado_logistico);
        if (activeTab !== "ALL" && tabKey !== activeTab) return false;

        if (pay && normLower(g.estado_pago) !== normLower(pay)) return false;

        if (quick === "SOLO_HOY" && !isToday(g.created_at)) return false;

        if (quick === "COBRO_DEST_PEND") {
          const f = deriveFlags(g);
          if (!f.puedeCobrar) return false;
        }

        if (quick === "OBSERVADAS") {
          const f = deriveFlags(g);
          if (!f.observadaDestino && !f.observadaCentral && normLower(g.estado_pago) !== "observado") {
            return false;
          }
        }

        if (quick === "LISTAS_ENTREGA") {
          const f = deriveFlags(g);
          if (!f.puedeEntregar) return false;
        }

        if (q) {
          const ok =
            String(g.numero_guia || "").toLowerCase().includes(q) ||
            String(g.remitente_nombre || "").toLowerCase().includes(q) ||
            String(g.destinatario_nombre || "").toLowerCase().includes(q);

          if (!ok) return false;
        }

        return true;
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async function cambiarEstado(guiaId, nuevoEstado) {
    setMsg("", "");
    try {
      await api(ENDPOINTS.estado, {
        method: "POST",
        body: JSON.stringify({
          guia_id: guiaId,
          estado: nuevoEstado,
        }),
      });

      await load();
      setMsg("ok", "Estado actualizado OK");
    } catch (e) {
      setMsg("err", e.message);
    }
  }

  async function registrarCobro(guiaId) {
    const montoStr = window.prompt("Monto a cobrar:");
    if (montoStr == null) return;

    const monto = Number(String(montoStr).replace(",", "."));
    if (!Number.isFinite(monto) || monto < 0) {
      setMsg("err", "Monto inválido");
      return;
    }

    const medio = window.prompt("Medio de pago (efectivo / transferencia / qr):", "efectivo");
    if (medio == null) return;

    try {
      await api(ENDPOINTS.registrarCobro, {
        method: "POST",
        body: JSON.stringify({
          guia_id: guiaId,
          medio_pago: String(medio).trim().toLowerCase(),
          monto,
          referencia_externa: "",
          observaciones: "Cobro registrado desde bandeja operativa",
        }),
      });

      await load();
      setMsg("ok", "Cobro registrado OK");
    } catch (e) {
      setMsg("err", e.message);
    }
  }

  async function rendirCobro(guiaId) {
    try {
      await api(ENDPOINTS.rendirCobro, {
        method: "POST",
        body: JSON.stringify({
          guia_id: guiaId,
        }),
      });

      await load();
      setMsg("ok", "Cobro rendido OK");
    } catch (e) {
      setMsg("err", e.message);
    }
  }

  async function registrarExcepcion(guiaId) {
    const motivo = window.prompt("Motivo de excepción:");
    if (!motivo) return;

    try {
      await api(ENDPOINTS.excepcionEntrega, {
        method: "POST",
        body: JSON.stringify({
          guia_id: guiaId,
          motivo,
        }),
      });

      await load();
      setMsg("ok", "Excepción registrada OK");
    } catch (e) {
      setMsg("err", e.message);
    }
  }

  function render() {
    const rows = $("rows");
    if (!rows) return;

    const data = filtered();

    if (!data.length) {
      rows.innerHTML = `<tr><td colspan="8" class="muted">Sin guías para este filtro.</td></tr>`;
      return;
    }

    rows.innerHTML = data.map((g) => {
      const f = deriveFlags(g);

      const ruta = `O:${g.sucursal_origen_id ?? "-"} → D:${g.sucursal_destino_id ?? "-"}`;
      const numero = g.numero_guia || "-";
      const pago = pagoVisible(g);

      const logClass =
        f.observadaDestino || f.observadaCentral
          ? "warn"
          : (normUpper(g.estado_logistico) === "ENTREGADO" ? "ok" : "");

      const payClass =
        pago === "PENDIENTE"
          ? "warn"
          : (pago === "OBSERVADO" ? "bad" : "ok");

      const obsBadge = (f.observadaDestino || f.observadaCentral)
        ? `<span class="ce-badge">OBS</span>`
        : "";

      const imprimir = `<button class="secondary" onclick="window.__exrPrint(${g.id})">Imprimir</button>`;
      const ver = `<button class="secondary" onclick="window.__exrVer(${g.id})">Ver</button>`;

      const cobrar = f.puedeCobrar
        ? `<button onclick="window.__exrCobrar(${g.id})">Cobrar</button>`
        : "";

      const rendir = f.puedeRendir
        ? `<button class="secondary" onclick="window.__exrRendir(${g.id})">Rendir</button>`
        : "";

      const entregar = f.puedeEntregar
        ? `<button onclick="window.__exrEntregar(${g.id})">Entregar</button>`
        : "";

      const excepcion = f.puedeExcepcion
        ? `<button class="secondary" onclick="window.__exrExcepcion(${g.id})">Excepción</button>`
        : "";

      return `
        <tr class="${(f.observadaDestino || f.observadaCentral) ? "ce-row" : ""}">
          <td class="mono">${esc(numero)} ${obsBadge}</td>
          <td>${statePill(estadoLogLabel(g.estado_logistico), logClass)}</td>
          <td>${payPill(pago, payClass)}</td>
          <td>${fmtDate(g.created_at)}</td>
          <td>${esc(ruta)}</td>
          <td>${esc(g.remitente_nombre || "-")}</td>
          <td>${esc(g.destinatario_nombre || "-")}</td>
          <td class="right">${imprimir} ${ver} ${cobrar} ${rendir} ${entregar} ${excepcion}</td>
        </tr>
      `;
    }).join("");
  }

  async function load() {
    setMsg("", "");
    saveUI();

    try {
      const me = await api(ENDPOINTS.ping, { method: "GET" });
      currentUser = me.user || null;

      if ($("who")) {
        $("who").textContent = `${me.user?.usuario || "operador"} · sucursal ${me.user?.sucursal_id ?? "?"}`;
      }

      const r = await api(ENDPOINTS.bandeja, { method: "GET" });

      const list = Array.isArray(r.guias) ? r.guias : [];
      all = list.map((x) => ({
        id: x.id,
        numero_guia: x.numero_guia ?? "",
        estado_logistico: x.estado_logistico ?? "",
        estado_pago: x.estado_pago ?? "",
        created_at: x.created_at ?? null,
        sucursal_origen_id: x.sucursal_origen_id ?? null,
        sucursal_destino_id: x.sucursal_destino_id ?? null,
        remitente_nombre: x.remitente_nombre ?? "",
        destinatario_nombre: x.destinatario_nombre ?? "",
        condicion_pago: x.condicion_pago ?? "",
        tipo_cobro: x.tipo_cobro ?? "",
      }));

      if (activeTab === "RECIBIDO_ORIGEN") {
        const counts = getCounts();
        const prefer = [
          "RECIBIDO_ORIGEN",
          "EN_TRANSITO",
          "RECIBIDO_CENTRAL",
          "RECIBIDO_DESTINO",
          "ENTREGADO",
        ];
        const firstWithData = prefer.find((k) => (counts[k] || 0) > 0);
        if (firstWithData) activeTab = firstWithData;
      }

      renderTabs(getCounts());
      render();
      setMsg("ok", `Bandeja actualizada (${r.total ?? all.length})`);
    } catch (e) {
      console.error("LOAD ERROR:", e);
      if (String(e.message || "").toLowerCase().includes("token")) {
        clearToken();
      }
      setMsg("err", e.message);
    }
  }

  function setAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;

    const sec = Number($("autoRefresh")?.value || 0);
    if (!sec) return;

    refreshTimer = setInterval(() => {
      load();
    }, sec * 1000);
  }

  window.__exrVer = (id) => {
    location.href = `/detalle.html?id=${encodeURIComponent(id)}`;
  };

  window.__exrPrint = (id) => {
    window.open(`/etiqueta.html?id=${id}`, "_blank", "noopener,noreferrer,width=420,height=700");
  };

  window.__exrCobrar = (id) => registrarCobro(id);
  window.__exrRendir = (id) => rendirCobro(id);
  window.__exrEntregar = (id) => cambiarEstado(id, "ENTREGADO");
  window.__exrExcepcion = (id) => registrarExcepcion(id);

  function on(id, ev, fn) {
    const el = $(id);
    if (!el) return;
    el.addEventListener(ev, fn);
  }

  on("btnRefresh", "click", load);
  on("btnSalir", "click", () => {
    clearToken();
    location.href = "/operador.html";
  });
  on("btnOperador", "click", () => location.href = "/operador.html");

  on("payFilter", "change", () => { saveUI(); render(); });
  on("quickFilter", "change", () => { saveUI(); render(); });
  on("autoRefresh", "change", () => { saveUI(); setAutoRefresh(); });

  const qEl = $("q");
  if (qEl) {
    qEl.addEventListener("input", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        saveUI();
        render();
      }, 180);
    });
  }

  if (!token()) {
    setMsg("err", "No hay sesión. Iniciá sesión en /operador.html");
  } else {
    loadUI();
    setAutoRefresh();
    load();
  }

  console.log("BANDEJA.JS OPERATIVA FIN");
})();