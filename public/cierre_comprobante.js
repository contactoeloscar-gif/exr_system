(() => {
  const $ = (id) => document.getElementById(id);
  const LS_TOKEN = "exr_token";

  const api = async (url, opts = {}) => {
    const token = localStorage.getItem(LS_TOKEN);
    const headers = Object.assign({}, opts.headers || {}, {
      Authorization: "Bearer " + token,
    });

    const res = await fetch(url, { ...opts, headers });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw Object.assign(new Error(data?.error || "Error"), {
        status: res.status,
        data,
      });
    }
    return data;
  };

  function fmtText(v, fb = "-") {
    const s = String(v ?? "").trim();
    return s || fb;
  }

  function fmtTS(v) {
    if (!v) return "-";
    try {
      return String(v).replace("T", " ").slice(0, 19);
    } catch {
      return String(v);
    }
  }

  function norm(v) {
    return String(v || "").trim().toUpperCase();
  }

  function esc(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getCierreId() {
    const url = new URL(window.location.href);
    const id = Number(url.searchParams.get("id"));
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  function renderKV(c) {
    $("kv").innerHTML = `
      <div class="cc-label">Cierre ID</div><div>${esc(c.cierre_id)}</div>
      <div class="cc-label">Fecha operativa</div><div>${esc(fmtText(c.fecha))}</div>
      <div class="cc-label">Tipo</div><div>${esc(fmtText(c.scope_modo))}</div>
      <div class="cc-label">Estado</div><div>${esc(fmtText(c.estado))}</div>
      <div class="cc-label">Sucursal</div><div>${
        norm(c.scope_modo) === "GLOBAL"
          ? "GLOBAL"
          : `${esc(fmtText(c.sucursal_codigo, "S" + c.sucursal_id))} — ${esc(fmtText(c.sucursal_nombre))}`
      }</div>
      <div class="cc-label">Creado por</div><div>${esc(fmtText(c.creado_por_usuario))}</div>
      <div class="cc-label">Creado en</div><div>${esc(fmtTS(c.creado_en))}</div>
      <div class="cc-label">Cerrado en</div><div>${esc(fmtTS(c.cerrado_en))}</div>
    `;
  }

  function renderResumen(r) {
    $("resumenPills").innerHTML = `
      <span class="exr-pro-pill">Pagadas: ${Number(r.cantidad_pagadas ?? 0)}</span>
      <span class="exr-pro-pill">Contra entrega: ${Number(r.cantidad_ce_pendiente ?? 0)}</span>
      <span class="exr-pro-pill">Guías: ${Number(r.total_entregadas ?? 0)}</span>
      <span class="exr-pro-pill">Bultos: ${Number(r.total_bultos ?? 0)}</span>
    `;
  }

  function renderDetalle(c) {
    const rows = Array.isArray(c.detalle) ? c.detalle : [];
    const detalleBox = $("detalleBox");

    if (norm(c.scope_modo) === "GLOBAL") {
      detalleBox.innerHTML = `
        <div class="exr-pro-empty">
          El cierre GLOBAL consolida los cierres SUCURSAL del día. No muestra detalle individual de guías en esta versión.
        </div>
      `;
      return;
    }

    if (!rows.length) {
      detalleBox.innerHTML = `
        <div class="exr-pro-empty">Este cierre no tiene guías asociadas.</div>
      `;
      return;
    }

    detalleBox.innerHTML = `
      <div class="exr-pro-table-wrap">
        <table class="exr-pro-table">
          <thead>
            <tr>
              <th>Guía</th>
              <th>Remitente</th>
              <th>Destinatario</th>
              <th>Dirección</th>
              <th>Bultos</th>
              <th>Pago</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(g => `
              <tr>
                <td>${esc(fmtText(g.numero_guia, g.id))}</td>
                <td>${esc(fmtText(g.remitente_nombre))}</td>
                <td>${esc(fmtText(g.destinatario_nombre))}</td>
                <td>${esc(fmtText(g.destinatario_direccion))}</td>
                <td>${Number(g.cant_bultos ?? 0)}</td>
                <td>${esc(fmtText(g.estado_pago))}</td>
                <td>${esc(fmtText(g.estado_logistico))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  async function init() {
    const cierreId = getCierreId();
    if (!cierreId) {
      throw new Error("Falta id de cierre");
    }

    $("btnVolver")?.addEventListener("click", () => {
      if (history.length > 1) history.back();
      else window.location.href = "/cierres.html";
    });

    $("btnPrint")?.addEventListener("click", () => window.print());

    const data = await api(`/interno/cierres/${cierreId}/comprobante`);
    const c = data.comprobante;

    document.title = `EXR | Cierre ${c.cierre_id}`;
    $("sub").textContent = `Cierre ${c.cierre_id} • ${fmtText(c.scope_modo)} • ${fmtText(c.fecha)}`;

    renderKV(c);
    renderResumen(c.resumen || {});
    renderDetalle(c);
  }

  init().catch((err) => {
    console.error(err);
    alert(err?.data?.error || err.message || "Error");
  });
})();