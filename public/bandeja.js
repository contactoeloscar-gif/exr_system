document.title = "Bandeja EXR ✅ JS OK";
console.log("BANDEJA.JS OK -", new Date().toISOString());

window.addEventListener("error", (e) => {
  console.error("JS ERROR:", e.message, "at", e.filename + ":" + e.lineno + ":" + e.colno);
});

console.log("BANDEJA.JS CARGADO");

(() => {
  const $ = (id) => document.getElementById(id);

  const LS_TOKEN = "exr_token";
  const LS_UI = "exr_bandeja_ui";

  const TABS = [
    { key: "RECIBIDO_ORIGEN", label: "Pendientes" },
    { key: "EN_TRANSITO", label: "En tránsito" },
    { key: "RECIBIDO_DESTINO", label: "En destino" },
    { key: "ENTREGADO", label: "Entregadas" },
    { key: "ALL", label: "Todas" },
  ];

  let all = [];
  let activeTab = "RECIBIDO_ORIGEN";
  let refreshTimer = null;
  let debounceTimer = null;

  function setMsg(type, text){
    const box = $("msg");
    if(!text){ box.innerHTML=""; return; }
    box.innerHTML = `<div class="${type}">${text}</div>`;
  }

  function token(){ return localStorage.getItem(LS_TOKEN); }
  function clearToken(){ localStorage.removeItem(LS_TOKEN); }

  function saveUI(){
    const ui = {
      activeTab,
      payFilter: $("payFilter").value,
      quickFilter: $("quickFilter").value,
      autoRefresh: $("autoRefresh").value,
      q: $("q").value
    };
    localStorage.setItem(LS_UI, JSON.stringify(ui));
  }

  function loadUI(){
    try{
      const ui = JSON.parse(localStorage.getItem(LS_UI) || "{}");
      if(ui.activeTab) activeTab = ui.activeTab;
      if(ui.payFilter !== undefined) $("payFilter").value = ui.payFilter;
      if(ui.quickFilter !== undefined) $("quickFilter").value = ui.quickFilter;
      if(ui.autoRefresh !== undefined) $("autoRefresh").value = ui.autoRefresh;
      if(ui.q !== undefined) $("q").value = ui.q;
    }catch{}
  }

  async function safeReadJson(resp){
    const text = await resp.text();
    try { return text ? JSON.parse(text) : {}; } catch { return { _raw: text }; }
  }

  async function api(url, opts={}){
    const headers = { ...(opts.headers || {}) };
    if(opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

    const t = token();
    if(t) headers["Authorization"] = "Bearer " + t;

    const resp = await fetch(url, { ...opts, headers });
    const data = await safeReadJson(resp);

    if(!resp.ok || data.ok === false){
      const msg = data?.error || data?.message || ("HTTP " + resp.status);
      throw new Error(msg);
    }
    return data;
  }

  function fmtDate(iso){
    if(!iso) return "-";
    try{ return new Date(iso).toLocaleString("es-AR"); }catch{ return iso; }
  }

  function isToday(iso){
    try{
      const d = new Date(iso);
      const now = new Date();
      return d.getFullYear() === now.getFullYear() &&
             d.getMonth() === now.getMonth() &&
             d.getDate() === now.getDate();
    }catch{
      return false;
    }
  }

  function statePill(s){ return `<span class="state">${s}</span>`; }
  function payPill(p){ return `<span class="pay">${p}</span>`; }

  function getCounts(){
    const counts = {};
    for(const g of all){
      counts[g.estado_logistico] = (counts[g.estado_logistico] || 0) + 1;
    }
    return counts;
  }

  function renderTabs(counts){
    const box = $("tabs");
    box.innerHTML = "";
    TABS.forEach(t => {
      const c = t.key === "ALL" ? all.length : (counts[t.key] || 0);
      const btn = document.createElement("button");
      btn.className = "tab" + (activeTab === t.key ? " active" : "");
      btn.innerHTML = `${t.label} <span class="badge">${c}</span>`;
      btn.onclick = () => {
        activeTab = t.key;
        saveUI();
        renderTabs(counts);
        render();
      };
      box.appendChild(btn);
    });
  }

  function filtered(){
    const q = ($("q").value || "").trim().toLowerCase();
    const pay = $("payFilter").value;
    const quick = $("quickFilter").value;

    return all
      .filter(g => {
        if(activeTab !== "ALL" && g.estado_logistico !== activeTab) return false;
        if(pay && g.estado_pago !== pay) return false;
        if(quick === "SOLO_CE" && g.estado_pago !== "CONTRA_ENTREGA") return false;
        if(quick === "SOLO_HOY" && !isToday(g.created_at)) return false;
        if(q && !(g.numero_guia || "").toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a,b) => {
        const ace = a.estado_pago === "CONTRA_ENTREGA" ? 1 : 0;
        const bce = b.estado_pago === "CONTRA_ENTREGA" ? 1 : 0;
        if(ace !== bce) return bce - ace;
        return new Date(b.created_at) - new Date(a.created_at);
      });
  }

  function nextStates(current){
    const flow = ["RECIBIDO_ORIGEN", "EN_TRANSITO", "RECIBIDO_DESTINO", "ENTREGADO"];
    const idx = flow.indexOf(current);
    const next = idx >= 0 && idx < flow.length - 1 ? flow[idx + 1] : null;
    const prev = idx > 0 ? flow[idx - 1] : null;
    return { prev, next };
  }

  async function cambiarEstado(guiaId, nuevoEstado){
    setMsg("", "");
    try{
      const r = await api("/guias/estado", {
        method: "POST",
        body: JSON.stringify({
          guia_id: guiaId,
          nuevo_estado: nuevoEstado,
          detalle: "Actualizado desde bandeja operativa"
        })
      });

      const updated = r.guia;
      all = all.map(g => g.id === guiaId
        ? { ...g, estado_logistico: updated.estado_logistico, estado_pago: updated.estado_pago }
        : g
      );

      renderTabs(getCounts());
      render();
      setMsg("ok", "Estado actualizado OK");
    }catch(e){
      setMsg("err", e.message);
    }
  }

  function render(){
    const rows = $("rows");
    const data = filtered();

    if(!data.length){
      rows.innerHTML = `<tr><td colspan="6" class="muted">Sin guías para este filtro.</td></tr>`;
      return;
    }

    rows.innerHTML = data.map(g => {
      const { prev, next } = nextStates(g.estado_logistico);
      const ruta = `O:${g.sucursal_origen_id ?? "-"} → D:${g.sucursal_destino_id ?? "-"}`;
      const numero = g.numero_guia || "-";
      const isCE = g.estado_pago === "CONTRA_ENTREGA";
      const ceBadge = isCE ? `<span class="ce-badge">CONTRA</span>` : "";

      const btnPrev = prev
        ? `<button class="secondary" onclick="window.__exrPrev(${g.id}, '${prev}')">←</button>`
        : "";

      const btnNext = next
        ? `<button onclick="window.__exrNext(${g.id}, '${next}')">→</button>`
        : "";

      const ver = `<button class="secondary" onclick="window.__exrVer('${encodeURIComponent(numero)}')">Ver</button>`;
      const imprimir = `<button class="secondary" onclick="window.__exrPrint(${g.id})">Imprimir</button>`;
      const marca = `<span style="border:2px solid red;padding:2px 6px;border-radius:6px">RENDER_OK</span>`;

      return `
        <tr class="${isCE ? "ce-row" : ""}">
          <td class="mono">${numero}${ceBadge}</td>
          <td>${statePill(g.estado_logistico || "-")}</td>
          <td>${payPill(g.estado_pago || "-")}</td>
          <td>${fmtDate(g.created_at)}</td>
          <td>${ruta}</td>
          <td class="right">${marca} ${imprimir} ${ver} ${btnPrev} ${btnNext}</td>
        </tr>
      `;
    }).join("");
  }

  async function load(){
    setMsg("", "");
    saveUI();
    try{
      const me = await api("/interno/ping", { method:"GET" });
      $("who").textContent = `${me.user?.usuario || "operador"} · sucursal ${me.user?.sucursal_id ?? "?"}`;

      const r = await api("/interno/bandeja", { method:"GET" });

      const list = Array.isArray(r.guias) ? r.guias : [];
      all = list.map(x => ({
        id: x.id,
        numero_guia: x.numero_guia ?? x.numero ?? "",
        estado_logistico: x.estado_logistico ?? x.estado ?? "",
        estado_pago: x.estado_pago ?? "",
        created_at: x.created_at ?? null,
        sucursal_origen_id: x.sucursal_origen_id ?? x.sucursal_origen ?? null,
        sucursal_destino_id: x.sucursal_destino_id ?? x.sucursal_destino ?? null,
      
    }));
        // Auto seleccionar primer estado con datos
if(activeTab === "RECIBIDO_ORIGEN"){
  const counts = getCounts();
  const prefer = ["RECIBIDO_ORIGEN","EN_TRANSITO","RECIBIDO_DESTINO","ENTREGADO"];
  const firstWithData = prefer.find(k => (counts[k] || 0) > 0);
  if(firstWithData) activeTab = firstWithData;
}
      renderTabs(getCounts());
      render();
      setMsg("ok", `Bandeja actualizada (${r.total ?? all.length})`);
    }catch(e){
      console.error("LOAD ERROR:", e);
      if(String(e.message || "").toLowerCase().includes("token")){
        clearToken();
      }
      setMsg("err", e.message);
    }
  }

  function setAutoRefresh(){
    if(refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;

    const sec = Number($("autoRefresh").value || 0);
    if(!sec) return;

    refreshTimer = setInterval(() => {
      load();
    }, sec * 1000);
  }

  // Exponer acciones
  window.__exrNext = (id, st) => cambiarEstado(id, st);
  window.__exrPrev = (id, st) => cambiarEstado(id, st);
  window.__exrVer = (num) => { location.href = `/operador.html#${num}`; };
  window.__exrPrint = (id) => {
    window.open(`/etiqueta.html?id=${id}`, "_blank", "noopener,noreferrer,width=420,height=700");
  };

  // UI events
  function on(id, ev, fn){
  const el = $(id);
  if(!el){
    console.warn("FALTA ELEMENTO:", id);
    return;
  }
  el.addEventListener(ev, fn);
}

// UI events (con protección)
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
if(qEl){
  qEl.addEventListener("input", () => {
    if(debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      saveUI();
      render();
    }, 120);
  });
} else {
  console.warn("FALTA ELEMENTO: q");
}

// init (forzado)
if(!token()){
  setMsg("err", "No hay sesión. Iniciá sesión en /operador.html");
} else {
  loadUI();
  setAutoRefresh();

  console.log("INIT OK -> llamando load()");
  load();
}


  loadUI();
  setAutoRefresh();
  load();

  console.log("BANDEJA.JS FIN");
})();
