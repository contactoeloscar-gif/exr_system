(() => {
  const $ = (id) => document.getElementById(id);

  const LS_TOKEN = "exr_token";
  const LS_UI = "exr_bandeja_ui";
  const LS_ETAG = "exr_bandeja_etag";

  const TABS = [
    { key: "RECIBIDO_ORIGEN", label: "Pendientes" },
    { key: "EN_TRANSITO", label: "En tránsito" },
    { key: "RECIBIDO_DESTINO", label: "En destino" },
    { key: "ENTREGADO", label: "Entregadas" },
    { key: "ALL", label: "Todas" },
  ];

  let all = [];
  let activeTab = "ALL";
  let refreshTimer = null;
  let debounceTimer = null;

  // Paginación (si no la usás, dejalo igual)
  let page = 1;
  const limit = 25;
  let apiTotal = 0;

  // Quick chips opcionales (si tu HTML los tiene)
  let quick = "ALL";

  // ETag
  let lastEtag = localStorage.getItem(LS_ETAG) || "";
  let lastUpdatedAt = 0;

  /* ============================
     UI helpers (no rompe si faltan)
  ============================ */
  function setText(id, txt) {
    const el = $(id);
    if (el) el.textContent = txt;
  }

  function setSyncChip(mode, extra = "") {
    // mode: loading | ok | same | err
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

  function toast(type, msg) {
    console.log(`[${type}]`, msg);
    const el = $("msg");
    if (el) el.textContent = msg;
  }

  function money(n) {
    return Number(n ?? 0).toLocaleString("es-AR", { style: "currency", currency: "ARS" });
  }

  /* ============================
     AUTH + API
  ============================ */
  function getToken() {
    return localStorage.getItem(LS_TOKEN) || "";
  }

  function logout() {
    localStorage.removeItem(LS_TOKEN);
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
      const msg = (data && data.error) ? data.error : ("HTTP " + res.status);
      throw new Error(msg);
    }
    return data;
  }

  /* ============================
     ✅ Custom Selects (PRO) - Fix dropdown blanco Chrome/Windows
     Requiere CSS en exr_ui.css (te lo pasé antes).
  ============================ */
  function initCustomSelects(root = document) {
    const selects = root.querySelectorAll("select.exr-select");
    selects.forEach(sel => {
      if (sel.dataset.exrCustomDone === "1") return;
      sel.dataset.exrCustomDone = "1";

      // Ocultamos el nativo pero lo dejamos en DOM
      sel.classList.add("exr-select-native");

      const wrap = document.createElement("div");
      wrap.className = "exr-cselect";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "exr-cselect-btn";

      const value = document.createElement("span");
      value.className = "exr-cselect-value";

      const caret = document.createElement("span");
      caret.className = "exr-cselect-caret";
      caret.textContent = "▾";

      btn.appendChild(value);
      btn.appendChild(caret);

      const menu = document.createElement("div");
      menu.className = "exr-cselect-menu";

      function currentLabel() {
        const opt = sel.options[sel.selectedIndex];
        return opt ? opt.textContent : "—";
      }

      function rebuild() {
        value.textContent = currentLabel();
        menu.innerHTML = "";

        [...sel.options].forEach((opt, idx) => {
          const item = document.createElement("div");
          const isSelected = idx === sel.selectedIndex;
          item.className = "exr-cselect-item" + (isSelected ? " selected" : "");
          item.textContent = opt.textContent;

          item.addEventListener("click", () => {
            sel.selectedIndex = idx;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            close();
            rebuild();
          });

          menu.appendChild(item);
        });
      }

      function open() { wrap.classList.add("open"); }
      function close() { wrap.classList.remove("open"); }
      function toggle() { wrap.classList.contains("open") ? close() : open(); }

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        toggle();
      });

      // Cerrar al click afuera
      document.addEventListener("click", (e) => {
        if (!wrap.contains(e.target) && e.target !== sel) close();
      });

      // Escape cierra
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close();
      });

      // Sync si cambia por código / restore UI
      sel.addEventListener("change", rebuild);

      // Montaje
      sel.parentNode.insertBefore(wrap, sel.nextSibling);
      wrap.appendChild(btn);
      wrap.appendChild(menu);

      rebuild();
    });
  }

  /* ============================
     Persistencia UI (opcional)
  ============================ */
  function captureUI() {
    return {
      activeTab,
      page,
      limit,
      q: ($("q")?.value || "").trim(),
      estado_log: $("f_estado_log")?.value || "",
      estado_pago: $("f_estado_pago")?.value || "",
      tipo_cobro: $("f_tipo_cobro")?.value || "",
      quick
    };
  }
  function writeUI(state) {
    localStorage.setItem(LS_UI, JSON.stringify(state || {}));
  }
  function readUI() {
    try { return JSON.parse(localStorage.getItem(LS_UI) || "{}"); }
    catch { return {}; }
  }

  /* ============================
     Filters server-side
  ============================ */
  function buildServerFilters() {
    const selEstLog = $("f_estado_log")?.value || "";
    const estado_logistico = (activeTab !== "ALL") ? activeTab : (selEstLog || "");

    let estado_pago = $("f_estado_pago")?.value || "";
    let tipo_cobro = $("f_tipo_cobro")?.value || "";
    let sin_metodo = 0;

    if (quick === "SIN_METODO") {
      sin_metodo = 1;
      estado_pago = "PAGADO";
    } else if (quick === "PAGADO") {
      estado_pago = "PAGADO";
    } else if (quick === "PENDIENTE") {
      estado_pago = "PENDIENTE";
    } else if (quick === "CE") {
      if (!estado_pago) estado_pago = "CONTRA_ENTREGA";
      if (!tipo_cobro) tipo_cobro = "DESTINO";
    }

    return { estado_logistico, estado_pago, tipo_cobro, sin_metodo };
  }

  /* ============================
     Render tabs
  ============================ */
  function renderTabs() {
    const el = $("tabs");
    if (!el) return;

    el.innerHTML = TABS.map(t => {
      const cls = (t.key === activeTab) ? "active" : "";
      return `<button class="tab ${cls}" data-k="${t.key}">${t.label}</button>`;
    }).join("");

    el.querySelectorAll(".tab").forEach(btn => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.k || "ALL";
        page = 1;
        writeUI(captureUI());
        load();
      });
    });
  }

  function renderQuickChips() {
    const el = $("quickChips");
    if (!el) return;

    const items = [
      { k: "ALL", label: "Todo" },
      { k: "PENDIENTE", label: "Pendiente" },
      { k: "CE", label: "Contra-entrega" },
      { k: "PAGADO", label: "Pagado" },
      { k: "SIN_METODO", label: "Pagado sin método" },
    ];

    el.innerHTML = items.map(i => {
      const cls = (i.k === quick) ? "active" : "";
      return `<button class="tab ${cls}" data-qc="${i.k}">${i.label}</button>`;
    }).join("");

    el.querySelectorAll(".tab").forEach(btn => {
      btn.addEventListener("click", () => {
        quick = btn.dataset.qc || "ALL";
        page = 1;
        writeUI(captureUI());
        load();
      });
    });
  }

  /* ============================
     Render table
  ============================ */
  function badgeLog(estado) {
    const map = {
      RECIBIDO_ORIGEN: ["Recibido origen", "warn"],
      EN_TRANSITO: ["En tránsito", "warn"],
      RECIBIDO_DESTINO: ["Recibido destino", "warn"],
      ENTREGADO: ["Entregado", "ok"],
    };
    const [label, cls] = map[estado] || [estado || "—", ""];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function badgePago(estado, metodo) {
    const map = {
      PENDIENTE: ["Pendiente", "warn"],
      CONTRA_ENTREGA: ["Contra entrega", "warn"],
      PAGADO: ["Pagado", "ok"],
    };
    const [label, cls] = map[estado] || [estado || "—", ""];
    const extra = (estado === "PAGADO" && metodo) ? ` <span class="muted mono" style="font-size:11px">(${metodo})</span>` : "";
    const warn = (estado === "PAGADO" && !metodo) ? ` <span class="badge bad">SIN MÉTODO</span>` : "";
    return `<span class="badge ${cls}">${label}</span>${extra}${warn}`;
  }

  function render() {
    const tbody = $("tbody");
    if (!tbody) return;

    setText("countTxt", String(all.length));
    if (!all.length) {
      tbody.innerHTML = "";
      setText("msg", "Sin resultados.");
      return;
    }

    setText("msg", "Tip: la bandeja se actualiza sola (si hay cambios).");

    tbody.innerHTML = all.map(g => {
      const nro = g.numero_guia ?? g.id;

      const ruta = `
        <div><b>${g.sucursal_origen_codigo || g.sucursal_origen_nombre || g.sucursal_origen_id || "—"}</b>
        → <b>${g.sucursal_destino_codigo || g.sucursal_destino_nombre || g.sucursal_destino_id || "—"}</b></div>
        <div class="muted" style="font-size:12px">${g.created_at || ""}</div>
      `;

      const cliente = `
        <div><b>${g.remitente_nombre || "—"}</b> <span class="muted">→</span> <b>${g.destinatario_nombre || "—"}</b></div>
        <div class="muted" style="font-size:12px">${g.remitente_telefono || ""} • ${g.destinatario_telefono || ""}</div>
      `;

      const estados = `<div style="display:flex;gap:8px;flex-wrap:wrap">${badgeLog(g.estado_logistico)} ${badgePago(g.estado_pago, g.metodo_pago)}</div>`;

      const monto = `
        <div><b>${money(g.monto_total ?? 0)}</b></div>
        <div class="muted" style="font-size:12px">${g.tipo_cobro || ""}</div>
      `;

      const acciones = `
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="exr-btn" data-act="detalle" data-id="${g.id}">Detalle</button>
          <button class="exr-btn" data-act="etiqueta" data-id="${g.id}">Etiqueta</button>
          <button class="exr-btn primary" data-act="pago" data-id="${g.id}">Pago</button>
        </div>
      `;

      return `
        <tr>
          <td class="mono"><b>${nro}</b></td>
          <td>${ruta}</td>
          <td>${cliente}</td>
          <td>${estados}</td>
          <td>${monto}</td>
          <td>${acciones}</td>
        </tr>
      `;
    }).join("");
  }

  /* ============================
     Delegación acciones tabla
  ============================ */
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

      if (act === "etiqueta") {
        window.open(`/interno/etiqueta/${encodeURIComponent(id)}?b=1`, "_blank");
        return;
      }
      if (act === "detalle") {
        location.href = `/detalle.html?id=${encodeURIComponent(id)}`;
        return;
      }
      if (act === "pago") {
        // Si tu bandeja_v2 ya tiene modal, llamá tu función real:
        // openPagoModal(guia);
        toast("info", "Abrir modal pago (conectá openPagoModal si lo tenés).");
        return;
      }
    });
  }

  /* ============================
     Load con ETag / 304
  ============================ */
  async function load() {
    // validar sesión
    try {
      const me = await api("/interno/ping", { method: "GET" });
      const who = $("who");
      if (who) who.textContent = `${me.user?.usuario || "operador"} · sucursal ${me.user?.sucursal_id ?? "?"}`;
    } catch (e) {
      return logout();
    }

    try {
      setSyncChip("loading");

      const q = ($("q")?.value || "").trim();
      const f = buildServerFilters();

      const offset = (page - 1) * limit;

      const url =
        `/interno/bandeja?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}` +
        `&q=${encodeURIComponent(q)}` +
        `&estado_logistico=${encodeURIComponent(f.estado_logistico || "")}` +
        `&estado_pago=${encodeURIComponent(f.estado_pago || "")}` +
        `&tipo_cobro=${encodeURIComponent(f.tipo_cobro || "")}` +
        `&sin_metodo=${encodeURIComponent(String(f.sin_metodo || 0))}`;

      const token = getToken();
      const headers = {};
      if (token) headers["Authorization"] = "Bearer " + token;
      if (lastEtag) headers["If-None-Match"] = lastEtag;

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

      apiTotal = Number(data?.total ?? 0);
      all = Array.isArray(data?.guias) ? data.guias : (Array.isArray(data) ? data : []);

      lastUpdatedAt = Date.now();
      setSyncChip("ok", `rows ${all.length}`);

      renderTabs();
      renderQuickChips();
      render();
    } catch (e) {
      setSyncChip("err", e.message);
      toast("error", "Error: " + e.message);
    }
  }

  /* ============================
     Auto refresh inteligente
  ============================ */
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

  /* ============================
     Events
  ============================ */
  function bindEvents() {
    const btnRefresh = $("btnRefresh");
    if (btnRefresh) btnRefresh.addEventListener("click", () => {
      writeUI(captureUI());
      load();
    });

    const btnLogout = $("btnLogout");
    if (btnLogout) btnLogout.addEventListener("click", logout);

    const btnBuscar = $("btnBuscar");
    if (btnBuscar) btnBuscar.addEventListener("click", () => {
      page = 1;
      writeUI(captureUI());
      load();
    });

    const q = $("q");
    if (q) {
      q.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          page = 1;
          writeUI(captureUI());
          load();
        }, 350);
      });

      q.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          q.value = "";
          page = 1;
          writeUI(captureUI());
          load();
        }
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() === "r") {
        writeUI(captureUI());
        load();
      }
    });
  }

  /* ============================
     Boot
  ============================ */
  function boot() {
    // Restaurar UI si existe
    const st = readUI();
    if (st.activeTab) activeTab = st.activeTab;
    if (st.page) page = st.page;
    if (typeof st.quick === "string") quick = st.quick;

    if ($("q") && st.q != null) $("q").value = st.q;
    if ($("f_estado_log") && st.estado_log != null) $("f_estado_log").value = st.estado_log;
    if ($("f_estado_pago") && st.estado_pago != null) $("f_estado_pago").value = st.estado_pago;
    if ($("f_tipo_cobro") && st.tipo_cobro != null) $("f_tipo_cobro").value = st.tipo_cobro;

    // ✅ Inicializamos selects custom luego de restaurar valores
    initCustomSelects(document);

    bindEvents();
    bindTableActions();
    renderTabs();
    renderQuickChips();

    load();
    startAutoRefresh();
  }

  boot();
})();
