console.log("DASHBOARD EJECUTIVO JS v3");

(() => {
  const LS_TOKEN = "exr_token";
  const $ = (id) => document.getElementById(id);

  function getToken() {
    return localStorage.getItem(LS_TOKEN) || "";
  }

  function logout() {
    localStorage.removeItem(LS_TOKEN);
    location.href = "/operador.html";
  }

  function esc(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function money(n) {
    return Number(n ?? 0).toLocaleString("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 2,
    });
  }

  function pct(a, b) {
    const A = Number(a || 0);
    const B = Number(b || 0);
    if (B === 0) return A === 0 ? 0 : 100;
    return ((A - B) / Math.abs(B)) * 100;
  }

  function fmtDelta(p) {
    if (!isFinite(p)) return "—";
    const sign = p > 0 ? "▲" : p < 0 ? "▼" : "•";
    return `${sign} ${p.toFixed(1)}% vs previo`;
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

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function toast(title, message, type = "") {
    let root = document.querySelector(".exr-toasts");
    if (!root) {
      root = document.createElement("div");
      root.className = "exr-toasts";
      document.body.appendChild(root);
    }

    const el = document.createElement("div");
    el.className = "exr-toast";
    el.innerHTML = `<div class="t">${esc(title)}</div><div class="m">${esc(message)}</div>`;

    if (type === "ok") el.style.borderColor = "rgba(32,201,151,.5)";
    if (type === "warn") el.style.borderColor = "rgba(255,204,0,.5)";
    if (type === "bad") el.style.borderColor = "rgba(255,92,119,.5)";

    root.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  async function api(path, opts = {}) {
    const token = getToken();
    const headers = Object.assign({}, opts.headers || {});
    if (token) headers.Authorization = "Bearer " + token;
    if (opts.json) headers["Content-Type"] = "application/json";

    const res = await fetch(path, { ...opts, headers });
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json")
      ? await res.json().catch(() => ({}))
      : await res.text().catch(() => "");

    if (!res.ok) {
      const msg = data && data.error ? data.error : "HTTP " + res.status;
      throw new Error(msg);
    }

    return data;
  }

  async function guardEjecutivoOwnerOnly() {
    const t = getToken();
    if (!t) {
      location.href = "/operador.html";
      return false;
    }

    const r = await fetch("/test-auth", {
      headers: { Authorization: "Bearer " + t },
    });
    const j = await r.json().catch(() => ({}));

    if (!r.ok || j.ok === false) {
      localStorage.removeItem(LS_TOKEN);
      location.href = "/operador.html";
      return false;
    }

    const rol = String(j.user?.rol || "").toUpperCase();
    if (rol !== "OWNER") {
      location.href = "/panel.html";
      return false;
    }

    return true;
  }

  function drawChart(canvas, series) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    canvas.width = Math.max(320, Math.floor(rect.width * dpr));
    canvas.height = Math.floor(260 * dpr);

    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1 * dpr;
    for (let i = 1; i <= 4; i++) {
      const y = (H / 5) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (!series.length) return;

    const maxY = Math.max(...series.map((p) => p.y));
    const pad = 18 * dpr;
    const innerW = W - pad * 2;
    const innerH = H - pad * 2;

    const xAt = (i) => pad + innerW * (i / (series.length - 1 || 1));
    const yAt = (v) => pad + innerH - innerH * (v / (maxY || 1));

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();

    series.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p.y);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    series.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p.y);
      ctx.beginPath();
      ctx.arc(x, y, 3.2 * dpr, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  async function loadMeta() {
    const meta = await api("/interno/dashboard/meta");
    const sel = $("sucursal");
    const rows = meta?.sucursales || [];

    if (sel) {
      sel.innerHTML =
        `<option value="">Todas</option>` +
        rows
          .map((s) => `<option value="${s.id}">${esc(s.nombre)} (${esc(s.codigo || "")})</option>`)
          .join("");
    }

    setText("gen", meta?.generado_en || "—");
  }

  function buildQuery() {
    const from = $("desde").value;
    const to = $("hasta").value;
    const sucursal_id = $("sucursal").value;
    const estado_pago = $("estadoPago").value;
    const tipo_cobro = $("tipoCobro").value;
    const metodo_pago = $("metodoPago").value;
    const q = $("q").value.trim();

    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (sucursal_id) params.set("sucursal_id", sucursal_id);
    if (estado_pago) params.set("estado_pago", estado_pago);
    if (tipo_cobro) params.set("tipo_cobro", tipo_cobro);
    if (metodo_pago) params.set("metodo_pago", metodo_pago);
    if (q) params.set("q", q);
    params.set("limit", "200");
    params.set("offset", "0");

    return params.toString();
  }

  function renderHeader(payload) {
    const chips = [];
    if (payload?.scope) chips.push(`<span class="badge">${esc(payload.scope)}</span>`);
    if (payload?.comparativo?.previo) {
      chips.push(`<span class="badge">Previo: ${esc(payload.comparativo.previo)}</span>`);
    }

    $("chips").innerHTML = chips.join("");
    setText("rangoTxt", payload?.rango ? `Rango: ${payload.rango}` : "—");
  }

  function renderKPIs(data) {
    const k = data?.kpis || {};
    const c = data?.comparativo || {};

    const prevEnt = Number(c.entregadas_prev || 0);
    const prevFac = Number(c.facturacion_prev || 0);
    const prevTic = Number(c.ticket_prev || 0);

    const ent = Number(k.guias_entregadas || 0);
    const fac = Number(k.facturacion_entregadas || 0);
    const tic = Number(k.ticket_promedio || 0);

    setText("k_cre", String(k.guias_creadas ?? 0));
    setText("k_ent", String(ent));
    setText("k_fac", money(fac));
    setText("k_tic", money(tic));
    setText("k_ce", money(k.contra_entrega ?? 0));

    setText("s_cre", "—");
    setText("s_ent", fmtDelta(pct(ent, prevEnt)));
    setText("s_fac", fmtDelta(pct(fac, prevFac)));
    setText("s_tic", fmtDelta(pct(tic, prevTic)));
    setText("s_ce", "—");
  }

  function renderTrend(data) {
    const rows = data?.tendencia_diaria || [];
    const tb = $("tbl_trend");

    tb.innerHTML = rows
      .map(
        (r) => `
          <tr>
            <td class="exr-mono">${esc(r.dia || r.fecha || "—")}</td>
            <td><b>${esc(r.entregadas ?? r.cant ?? 0)}</b></td>
            <td><b>${money(r.facturacion ?? r.monto ?? 0)}</b></td>
          </tr>
        `
      )
      .join("");

    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="3" class="exr-muted">Sin datos</td></tr>`;
    }

    const series = rows.map((r) => ({ y: Number(r.entregadas ?? r.cant ?? 0) }));
    drawChart($("chart"), series);
  }

  function renderRank(data) {
    const rows = data?.ranking_sucursales || data?.ranking || [];
    const tb = $("tbl_rank");

    tb.innerHTML = rows
      .map(
        (r) => `
          <tr>
            <td><b>${esc(r.clave || r.nombre || r.metodo_pago || r.sucursal || "—")}</b></td>
            <td>${esc(r.cantidad ?? r.cant ?? 0)}</td>
            <td><b>${money(r.monto ?? r.facturacion ?? 0)}</b></td>
          </tr>
        `
      )
      .join("");

    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="3" class="exr-muted">Sin datos</td></tr>`;
    }
  }

  function renderAlertas(data) {
    const alertas = data?.alertas || [];
    const el = $("alertas");

    if (!alertas.length) {
      el.innerHTML = "";
      return;
    }

    el.innerHTML = alertas
      .map((a) => {
        const lvl = a.nivel || "warn";
        const cls = lvl === "bad" || lvl === "error" ? "bad" : lvl === "ok" ? "ok" : "warn";
        return `<span class="badge ${cls}">${esc(a.titulo || "Alerta")}: ${esc(a.mensaje || "")}</span>`;
      })
      .join("");
  }

  function toCSV(data) {
    const k = data?.kpis || {};
    const trend = data?.tendencia_diaria || [];
    const rank = data?.ranking_sucursales || data?.ranking || [];

    const lines = [];
    lines.push("SECCION,CLAVE,VALOR");
    lines.push(`KPI,guias_creadas,${k.guias_creadas || 0}`);
    lines.push(`KPI,guias_entregadas,${k.guias_entregadas || 0}`);
    lines.push(`KPI,facturacion_entregadas,${k.facturacion_entregadas || 0}`);
    lines.push(`KPI,ticket_promedio,${k.ticket_promedio || 0}`);
    lines.push(`KPI,contra_entrega,${k.contra_entrega || 0}`);

    lines.push("");
    lines.push("TENDENCIA,dia,entregadas,facturacion");
    trend.forEach((r) =>
      lines.push(
        `TENDENCIA,${r.dia || r.fecha || ""},${r.entregadas ?? r.cant ?? 0},${r.facturacion ?? r.monto ?? 0}`
      )
    );

    lines.push("");
    lines.push("RANKING,clave,cantidad,monto");
    rank.forEach((r) =>
      lines.push(
        `RANKING,${r.clave || r.nombre || r.metodo_pago || r.sucursal || ""},${r.cantidad ?? r.cant ?? 0},${r.monto ?? r.facturacion ?? 0}`
      )
    );

    return lines.join("\n");
  }

  function download(name, content) {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  let lastData = null;

  async function loadAll() {
    try {
      const me = await api("/test-auth");
      const u = me?.user || me || {};
      setText(
        "userChip",
        `${u.usuario || "usuario"} • ${u.rol || "ROL"} ${u.sucursal_id ? "• S" + u.sucursal_id : "• Global"}`
      );
    } catch (e) {
      return logout();
    }

    try {
      await loadMeta();
    } catch (e) {
      toast("Error meta", e.message, "bad");
    }

    try {
      const qs = buildQuery();
      const data = await api("/interno/dashboard/summary?" + qs);
      lastData = data;

      renderHeader(data);
      renderKPIs(data);
      renderTrend(data);
      renderRank(data);
      renderAlertas(data);

      toast("OK", "Dashboard actualizado", "ok");
    } catch (e) {
      toast("Error", e.message, "bad");
    }
  }

  function bindEvents() {
    $("desde").value = daysAgoISO(7);
    $("hasta").value = todayISO();

    $("loadBtn").addEventListener("click", loadAll);
    $("btnLogout").addEventListener("click", logout);

    $("btnCSV").addEventListener("click", () => {
      if (!lastData) {
        toast("Sin datos", "Primero actualizá el dashboard.", "warn");
        return;
      }

      const from = $("desde").value || "from";
      const to = $("hasta").value || "to";
      download(`exr_dashboard_${from}_a_${to}.csv`, toCSV(lastData));
    });

    $("q").addEventListener("keydown", (e) => {
      if (e.key === "Enter") loadAll();
      if (e.key === "Escape") {
        e.target.value = "";
        loadAll();
      }
    });
  }

  (async () => {
    const ok = await guardEjecutivoOwnerOnly();
    if (!ok) return;

    bindEvents();
    loadAll();
  })();
})();