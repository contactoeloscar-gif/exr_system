(() => {
  const LS_TOKEN = "exr_token";
  const $ = (id) => document.getElementById(id);

  function money(v) {
    const n = Number(v || 0);
    return n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 });
  }

  function pct(curr, prev){
  const c = Number(curr || 0);
  const p = Number(prev || 0);
  if (p === 0 && c === 0) return 0;
  if (p === 0) return 100; // de 0 a algo: lo mostramos como +100% (simplificado)
  return ((c - p) / p) * 100;
}
function fmtPct(x){
  const n = Number(x || 0);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

  async function apiGet(url) {
    const token = localStorage.getItem(LS_TOKEN);
    if (!token) throw new Error("No hay token. Iniciá sesión.");
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Error API");
    return j;
  }

  function renderTable(tbodyId, rows) {
    const tb = $(tbodyId);
    tb.innerHTML = "";
    for (const r of rows || []) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${r.estado}</td><td><b>${r.count}</b></td>`;
      tb.appendChild(tr);
    }
    if (!rows || rows.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="2" class="muted">Sin datos</td>`;
      tb.appendChild(tr);
    }
  }

  function renderChips(alertas) {
    const box = $("chips");
    box.innerHTML = "";
    for (const a of alertas || []) {
      const div = document.createElement("div");
      div.className = "chip";
      div.textContent = `${a.tipo}: ${a.count ?? a.monto ?? 0}`;
      box.appendChild(div);
    }
    if (!alertas || alertas.length === 0) {
      const div = document.createElement("div");
      div.className = "chip";
      div.textContent = "Sin alertas";
      box.appendChild(div);
    }
  }

  async function load() {
    const data = await apiGet("/interno/dashboard/operativo");

    $("scope").textContent = `Sucursal ${data.scope?.sucursal_id ?? "-"}`;
    $("k_act").textContent = data.kpis?.guias_activas ?? 0;
    $("k_ent").textContent = data.kpis?.entregadas_hoy ?? 0;
    $("k_ce").textContent = money(data.kpis?.ce_pendiente_en_destino ?? 0);
    $("k_pay").textContent = money(data.kpis?.pagado_hoy ?? 0);

    renderTable("tbl_log", data.estado_logistico);
    renderTable("tbl_pay", data.estado_pago);
    renderChips(data.alertas);
    // Comparativo vs período anterior
const cmpBox = document.getElementById("chips_cmp");
if (cmpBox) {
  cmpBox.innerHTML = "";

  const prev = data.comparativo || {};
  const entPrev = Number(prev.entregadas_prev || 0);
  const facPrev = Number(prev.facturacion_prev || 0);
  const ticPrev = Number(prev.ticket_prev || 0);

  const entNow = Number(data.kpis?.guias_entregadas || 0);
  const facNow = Number(data.kpis?.facturacion_entregadas || 0);
  const ticNow = Number(data.kpis?.ticket_promedio || 0);

  const items = [
    { label: `Entregadas vs previo (${prev.previo?.desde}→${prev.previo?.hasta})`, val: fmtPct(pct(entNow, entPrev)) },
    { label: "Facturación vs previo", val: fmtPct(pct(facNow, facPrev)) },
    { label: "Ticket vs previo", val: fmtPct(pct(ticNow, ticPrev)) },
  ];

  items.forEach(it => {
    const div = document.createElement("div");
    div.className = "chip";
    div.textContent = `${it.label}: ${it.val}`;
    cmpBox.appendChild(div);
  });
}


    $("gen").textContent = `Generado: ${new Date(data.generado_en).toLocaleString("es-AR")}`;
  }

  $("refreshBtn").addEventListener("click", () => load().catch(e => alert(e.message)));

  load().catch(e => alert(e.message));
  setInterval(() => load().catch(() => {}), 30000);
})();