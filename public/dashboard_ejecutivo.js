console.log("DASH JS VERSION:", "EXEC-SUMMARY-2026-02-15-NEW-FIX1");

(() => {
  const LS_TOKEN = "exr_token";
  const $ = (id) => document.getElementById(id);

  function money(v) {
    const n = Number(v || 0);
    return n.toLocaleString("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 2,
    });
  }

  function isoDate(d) {
    return new Date(d).toISOString().slice(0, 10);
  }
  function todayISO() {
    return isoDate(new Date());
  }
  function daysAgoISO(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return isoDate(d);
  }

  async function apiGet(url) {
    const token = localStorage.getItem(LS_TOKEN);
    if (!token) throw new Error("No hay token. Iniciá sesión.");
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Error API");
    return j;
  }

  function setDefaultDates() {
    const hastaEl = $("hasta");
    const desdeEl = $("desde");
    if (hastaEl && !hastaEl.value) hastaEl.value = todayISO();
    if (desdeEl && !desdeEl.value) desdeEl.value = daysAgoISO(14);
  }

  // ========== RENDERERS ==========
  function renderRankingMetodo(rows) {
    const tb = $("tbl_rank");
    if (!tb) return;

    tb.innerHTML = "";

    (rows || []).forEach((r, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${idx + 1}</td>
        <td><b>${r.label}</b></td>
        <td>${r.value}</td>
        <td><b>${money(r.total_monto)}</b></td>`;
      tb.appendChild(tr);
    });

    if (!rows || rows.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="4" class="muted">Sin datos en el rango</td>`;
      tb.appendChild(tr);
    }
  }

  function renderTrendSeries(series) {
    const tb = $("tbl_trend");
    if (!tb) return;

    tb.innerHTML = "";

    (series || []).forEach((r) => {
      const tr = document.createElement("tr");
      const dia = (r.dia || r.fecha || "").toString().slice(0, 10);
      tr.innerHTML = `<td>${dia}</td><td>${r.guias ?? 0}</td><td><b>${money(r.facturacion ?? 0)}</b></td>`;
      tb.appendChild(tr);
    });

    if (!series || series.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="3" class="muted">Sin datos</td>`;
      tb.appendChild(tr);
    }
  }

  function renderChips(alertas) {
    const box = $("chips");
    if (!box) return;

    box.innerHTML = "";
    (alertas || []).forEach((a) => {
      const div = document.createElement("div");
      div.className = "chip";

      if (a.kind === "money") div.textContent = `${a.label}: ${money(a.value)}`;
      else div.textContent = `${a.label}: ${a.value ?? 0}`;

      if (a.tone === "ok") div.style.borderColor = "#22c55e";
      if (a.tone === "warn") div.style.borderColor = "#f59e0b";
      if (a.tone === "bad") div.style.borderColor = "#ef4444";

      box.appendChild(div);
    });

    if (!alertas || alertas.length === 0) {
      const div = document.createElement("div");
      div.className = "chip";
      div.textContent = "Sin alertas";
      box.appendChild(div);
    }
  }

  function setText(id, value) {
    const el = $(id);
    if (!el) return;
    el.textContent = value;
  }

  // ========== META (filtros dinámicos) ==========
  async function loadMeta() {
    const meta = await apiGet("/interno/dashboard/meta");

    const selSuc = $("sucursal");
    if (selSuc && meta.sucursales) {
      const keepFirst = selSuc.querySelectorAll("option").length > 0;
      const first = keepFirst ? selSuc.querySelector("option")?.outerHTML : "";
      selSuc.innerHTML = "";
      if (keepFirst && first) selSuc.insertAdjacentHTML("beforeend", first);

      meta.sucursales.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = String(s.id);
        opt.textContent = s.nombre;
        selSuc.appendChild(opt);
      });
    }

    const selEP = $("estadoPago");
    if (selEP && meta.meta?.estado_pago) {
      const keepFirst = selEP.querySelectorAll("option").length > 0;
      const first = keepFirst ? selEP.querySelector("option")?.outerHTML : "";
      selEP.innerHTML = "";
      if (keepFirst && first) selEP.insertAdjacentHTML("beforeend", first);

      meta.meta.estado_pago.forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        selEP.appendChild(opt);
      });
    }

    const selTC = $("tipoCobro");
    if (selTC && meta.meta?.tipo_cobro) {
      const keepFirst = selTC.querySelectorAll("option").length > 0;
      const first = keepFirst ? selTC.querySelector("option")?.outerHTML : "";
      selTC.innerHTML = "";
      if (keepFirst && first) selTC.insertAdjacentHTML("beforeend", first);

      meta.meta.tipo_cobro.forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        selTC.appendChild(opt);
      });
    }

    const selMP = $("metodoPago");
    if (selMP && meta.meta?.metodo_pago) {
      const keepFirst = selMP.querySelectorAll("option").length > 0;
      const first = keepFirst ? selMP.querySelector("option")?.outerHTML : "";
      selMP.innerHTML = "";
      if (keepFirst && first) selMP.insertAdjacentHTML("beforeend", first);

      meta.meta.metodo_pago.forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        selMP.appendChild(opt);
      });
    }
  }

  function buildSummaryUrl() {
    const desde = $("desde")?.value || daysAgoISO(14);
    const hasta = $("hasta")?.value || todayISO();

    const p = new URLSearchParams();
    p.set("from", desde);
    p.set("to", hasta);

    const suc = $("sucursal")?.value || "";
    const ep = $("estadoPago")?.value || "";
    const tc = $("tipoCobro")?.value || "";
    const mp = $("metodoPago")?.value || "";
    const q = $("q")?.value || "";

    if (suc) p.set("sucursal_id", suc);
    if (ep) p.set("estado_pago", ep);
    if (tc) p.set("tipo_cobro", tc);
    if (mp) p.set("metodo_pago", mp);
    if (q) p.set("q", q);

    const limit = $("limit")?.value || "";
    const offset = $("offset")?.value || "";
    if (limit) p.set("limit", limit);
    if (offset) p.set("offset", offset);

    return `/interno/dashboard/summary?${p.toString()}`;
  }

  // ========== LOAD PRINCIPAL ==========
  async function load() {
    const desde = $("desde")?.value || daysAgoISO(14);
    const hasta = $("hasta")?.value || todayISO();
    const url = buildSummaryUrl();

    const data = await apiGet(url);

    setText("k_cre", data.kpis?.guias_count ?? 0);

    const entregadas = (data.donut_estado || []).find((x) => x.label === "ENTREGADO")?.value ?? 0;
    setText("k_ent", entregadas);

    setText("k_fac", money(data.kpis?.facturacion_total ?? 0));
    setText("k_tic", money(data.kpis?.ticket_promedio ?? 0));
    setText("k_ce", money(data.kpis?.contra_entrega_total ?? 0));

    const rangoEl = $("rangoTxt");
    if (rangoEl) rangoEl.textContent = `${desde} → ${hasta}`;

    renderTrendSeries(data.series || []);
    renderRankingMetodo(data.donut_metodo || []);

    const sinMetodo = (data.donut_metodo || []).find((x) => x.label === "SIN_METODO")?.value ?? 0;
    const recibDestino = (data.donut_estado || []).find((x) => x.label === "RECIBIDO_DESTINO")?.value ?? 0;
    const enTransito = (data.donut_estado || []).find((x) => x.label === "EN_TRANSITO")?.value ?? 0;

    const chips = [
      { label: "Cobrado", kind: "money", value: data.kpis?.cobrado_total ?? 0, tone: "ok" },
      { label: "Contra entrega", kind: "money", value: data.kpis?.contra_entrega_total ?? 0, tone: "warn" },
      { label: "Pendiente", kind: "money", value: data.kpis?.pendiente_total ?? 0, tone: "warn" },
      { label: "Entregado", value: entregadas, tone: "ok" },
      { label: "En destino", value: recibDestino, tone: "warn" },
      { label: "En tránsito", value: enTransito, tone: "warn" },
    ];
    if (sinMetodo > 0) chips.push({ label: "PAGADO sin método", value: sinMetodo, tone: "bad" });

    renderChips(chips);

    const genEl = $("gen");
    if (genEl) genEl.textContent = `Generado: ${new Date().toLocaleString("es-AR")}`;

    console.log("SUMMARY OK:", { kpis: data.kpis, series_len: (data.series || []).length });
  }

  // ========== INIT ==========
  const btn = $("loadBtn");
  if (btn) btn.addEventListener("click", () => load().catch((e) => alert(e.message)));

  setDefaultDates();
  loadMeta().catch((e) => console.warn("meta warn:", e.message));

  load().catch((e) => {
    console.error("LOAD ERROR:", e);
    alert(e.message);
  });
})();
