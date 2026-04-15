(() => {
  const $ = (id) => document.getElementById(id);
  const LS_TOKEN = "exr_token";

  const state = {
    me: null,
    fecha: null,
    estado: null,
    preview: null,
  };

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

  const todayYMD = () => new Date().toISOString().slice(0, 10);

  function norm(v) {
    return String(v || "").trim().toUpperCase();
  }

  function fmtTS(v) {
    if (!v) return "-";
    try {
      return String(v).replace("T", " ").slice(0, 19);
    } catch {
      return String(v);
    }
  }

  function fmtText(v, fallback = "-") {
    const s = String(v ?? "").trim();
    return s || fallback;
  }

  function isOwnerRole(rol) {
    return ["OWNER", "ADMIN"].includes(norm(rol));
  }

  function showFlash(type, text) {
    const box = $("flashBox");
    if (!box) return;
    box.style.display = "block";
    box.innerHTML = `<div class="msg ${type}">${text}</div>`;
  }

  function clearFlash() {
    const box = $("flashBox");
    if (!box) return;
    box.style.display = "none";
    box.innerHTML = "";
  }

  async function getMe() {
    return api("/interno/ping");
  }

  async function loadEstado(fecha) {
    return api(`/interno/cierres/estado?fecha=${encodeURIComponent(fecha)}`);
  }

  async function loadPreview({ fecha, scope_modo, sucursal_id }) {
    const qs = new URLSearchParams();
    qs.set("fecha", fecha);
    qs.set("scope_modo", scope_modo);
    if (scope_modo === "SUCURSAL" && sucursal_id) {
      qs.set("sucursal_id", String(sucursal_id));
    }
    return api(`/interno/cierres/preview?${qs.toString()}`);
  }

  async function postCerrarDiario(payload) {
    return api(`/interno/cierres/diario`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  function openComprobante(cierreId) {
    if (!cierreId) return;
    window.open(`/cierre_comprobante.html?id=${encodeURIComponent(cierreId)}`, "_blank");
  }

  function clearPreview() {
    state.preview = null;
    const box = $("previewBox");
    if (box) box.innerHTML = `<div class="muted">Sin preview cargado.</div>`;
  }

  function renderTopEstado() {
    const me = state.me || {};
    const rol = me?.user?.rol || "-";
    const mySuc = me?.user?.sucursal_id || null;
    const owner = isOwnerRole(rol);
    const st = state.estado || {};

    const userChip = $("chipUser");
    if (userChip) {
      userChip.textContent = `${fmtText(me?.user?.usuario)} • ${fmtText(rol)} • sucursal ${mySuc ?? "-"}`;
    }

    const box = $("estadoBox");
    if (!box) return;

    if (owner) {
      const falt = st.faltantes_sucursal_id || [];
      const globalPermitido = !!st.global_permitido;

      box.innerHTML = `
        <div><b>Vista:</b> Owner/Admin</div>
        <div style="margin-top:8px" class="row">
          <span class="pill ${globalPermitido ? "ok" : "bad"}">GLOBAL permitido: ${globalPermitido ? "SI" : "NO"}</span>
          ${
            falt.length
              ? `<span class="pill bad">Faltan cierres SUCURSAL: ${falt.join(", ")}</span>`
              : `<span class="pill ok">Todas las sucursales del día están cerradas</span>`
          }
        </div>
      `;
      return;
    }

    const cierre = st.cierre || null;
    const estado = cierre?.estado || "PENDIENTE";

    box.innerHTML = `
      <div><b>Vista:</b> Sucursal propia</div>
      <div style="margin-top:8px" class="row">
        <span class="pill ${norm(estado) === "CERRADO" ? "ok" : "warn"}">Estado mi sucursal: ${estado}</span>
        <span class="pill">Cierre ID: ${cierre?.id ?? "-"}</span>
        <span class="pill">Cerrado en: ${fmtTS(cierre?.cerrado_en)}</span>
      </div>
    `;
  }

  function renderTablaSucursales() {
    const me = state.me || {};
    const rol = me?.user?.rol || "";
    const owner = isOwnerRole(rol);
    const mySuc = Number(me?.user?.sucursal_id || 0);
    const st = state.estado || {};
    const tb = $("tb");
    if (!tb) return;

    tb.innerHTML = "";

    if (!owner) {
      const sucursal = st.sucursal || { id: mySuc, codigo: "MI", nombre: "Mi sucursal" };
      const c = st.cierre || null;
      const estado = c ? c.estado : "PENDIENTE";
      const cerradoEn = c?.cerrado_en || null;
      const cierreId = c?.id || "-";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>
          <div><b>${fmtText(sucursal.codigo, "S" + (sucursal.id ?? ""))}</b> — ${fmtText(sucursal.nombre)}</div>
          <div class="muted small">id:${sucursal.id ?? "-"}</div>
        </td>
        <td><span class="pill ${norm(estado) === "CERRADO" ? "ok" : "warn"}">${estado}</span></td>
        <td class="muted">${fmtTS(cerradoEn)}</td>
        <td>${cierreId}</td>
        <td>
          ${
            c
              ? `
                <div class="small">Pagadas: ${c.cantidad_pagadas ?? 0}</div>
                <div class="small">CE: ${c.cantidad_ce_pendiente ?? 0}</div>
                <div class="small">Guías: ${c.total_entregadas ?? 0}</div>
              `
              : `<span class="muted small">Sin cierre todavía</span>`
          }
        </td>
        <td>
          <div class="actions">
            <button class="btn" data-preview-mine="1">Preview</button>
            <button class="btn ok" data-close-mine="1" ${norm(estado) === "CERRADO" ? "disabled" : ""}>Cerrar</button>
            ${c?.id ? `<button class="btn" data-comp="${c.id}">Ver comprobante</button>` : ""}
          </div>
        </td>
      `;
      tb.appendChild(tr);

      tb.querySelector('[data-preview-mine="1"]')?.addEventListener("click", async () => {
        try {
          clearFlash();
          await doPreviewMiSucursal();
        } catch (e) {
          showFlash("bad", (e?.data?.error) || e.message);
        }
      });

      tb.querySelector('[data-close-mine="1"]')?.addEventListener("click", async () => {
        try {
          clearFlash();
          await confirmCloseMiSucursal();
        } catch (e) {
          showFlash("bad", (e?.data?.error) || e.message);
        }
      });

      tb.querySelector("[data-comp]")?.addEventListener("click", () => {
        openComprobante(c?.id);
      });

      return;
    }

    const sucursales = st.sucursales || [];
    const cierres = st.cierres || [];

    function findCierre(scope, sucursalId) {
      return (
        cierres.find(
          (c) =>
            norm(c.scope_modo) === scope &&
            Number(c.sucursal_id) === Number(sucursalId)
        ) || null
      );
    }

    for (const s of sucursales) {
      const c = findCierre("SUCURSAL", s.id);
      const estado = c ? c.estado : "PENDIENTE";
      const cerradoEn = c?.cerrado_en || null;
      const cierreId = c?.id || "-";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>
          <div><b>${fmtText(s.codigo, "S" + s.id)}</b> — ${fmtText(s.nombre)}</div>
          <div class="muted small">id:${s.id}</div>
        </td>
        <td><span class="pill ${norm(estado) === "CERRADO" ? "ok" : "warn"}">${estado}</span></td>
        <td class="muted">${fmtTS(cerradoEn)}</td>
        <td>${cierreId}</td>
        <td>
          ${
            c
              ? `
                <div class="small">Pagadas: ${c.cantidad_pagadas ?? 0}</div>
                <div class="small">CE: ${c.cantidad_ce_pendiente ?? 0}</div>
                <div class="small">Guías: ${c.total_entregadas ?? 0}</div>
              `
              : `<span class="muted small">Pendiente</span>`
          }
        </td>
        <td>
          <div class="actions">
            <button class="btn" data-preview-suc="${s.id}">Preview</button>
            <button class="btn ok" data-close-suc="${s.id}" ${norm(estado) === "CERRADO" ? "disabled" : ""}>Cerrar</button>
            ${c?.id ? `<button class="btn" data-comp="${c.id}">Ver comprobante</button>` : ""}
          </div>
        </td>
      `;
      tb.appendChild(tr);
    }

    tb.querySelectorAll("button[data-preview-suc]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sid = Number(btn.getAttribute("data-preview-suc"));
        if (!sid) return;
        btn.disabled = true;
        try {
          clearFlash();
          await doPreviewSucursal(sid);
        } catch (e) {
          showFlash("bad", (e?.data?.error) || e.message);
        } finally {
          btn.disabled = false;
        }
      });
    });

    tb.querySelectorAll("button[data-close-suc]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sid = Number(btn.getAttribute("data-close-suc"));
        if (!sid) return;
        btn.disabled = true;
        try {
          clearFlash();
          await confirmCloseSucursalOwner(sid);
        } catch (e) {
          showFlash("bad", (e?.data?.error) || e.message);
        } finally {
          btn.disabled = false;
        }
      });
    });

    tb.querySelectorAll("button[data-comp]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cierreId = Number(btn.getAttribute("data-comp"));
        openComprobante(cierreId);
      });
    });
  }

  function renderPreview() {
    const box = $("previewBox");
    if (!box) return;

    const p = state.preview;
    if (!p) {
      box.innerHTML = `<div class="muted">Sin preview cargado.</div>`;
      return;
    }

    const guias = p.guias || [];
    const tot = p.totales || {};
    const scope = norm(p.scope_modo);
    const sucLabel =
      scope === "SUCURSAL"
        ? `${p?.sucursal?.codigo || "S" + p?.sucursal_id} — ${p?.sucursal?.nombre || ""} (id:${p?.sucursal_id ?? "-"})`
        : "GLOBAL";

    const resumenHtml = `
      <div class="summary-grid">
        <div class="summary-item">
          <div class="k">Guías</div>
          <div class="v">${tot.total_entregadas ?? 0}</div>
        </div>
        <div class="summary-item">
          <div class="k">Pagadas</div>
          <div class="v">${tot.cantidad_pagadas ?? 0}</div>
        </div>
        <div class="summary-item">
          <div class="k">Contra entrega</div>
          <div class="v">${tot.cantidad_ce_pendiente ?? 0}</div>
        </div>
        <div class="summary-item">
          <div class="k">Bultos</div>
          <div class="v">${tot.total_bultos ?? 0}</div>
        </div>
      </div>
    `;

    if (scope === "GLOBAL") {
      box.innerHTML = `
        <div><b>Preview:</b> GLOBAL</div>
        <div class="muted small" style="margin-top:6px">Fecha: ${fmtText(p.fecha)}</div>
        <div class="muted small" style="margin-top:2px">Universo: cierres SUCURSAL cerrados del día</div>

        <div style="margin-top:10px" class="row">
          <span class="pill ${p.global_permitido ? "ok" : "bad"}">GLOBAL permitido: ${p.global_permitido ? "SI" : "NO"}</span>
          ${
            (p.faltantes_sucursal_id || []).length
              ? `<span class="pill bad">Faltan cierres: ${(p.faltantes_sucursal_id || []).join(", ")}</span>`
              : `<span class="pill ok">Todas las sucursales cerradas</span>`
          }
        </div>

        ${resumenHtml}

        <div class="empty" style="margin-top:12px">
          El cierre GLOBAL consolida los cierres SUCURSAL del día y no muestra detalle individual de guías en esta vista.
        </div>
      `;
      return;
    }

    const rowsHtml = guias.length
      ? guias
          .slice(0, 100)
          .map(
            (g) => `
              <tr>
                <td>${g.numero_guia ?? g.id}</td>
                <td>${fmtText(g.remitente_nombre)}</td>
                <td>${fmtText(g.destinatario_nombre)}</td>
                <td>${fmtText(g.destinatario_direccion)}</td>
                <td>${g.cant_bultos ?? 0}</td>
                <td>${fmtText(g.estado_pago)}</td>
                <td>${fmtText(g.estado_logistico)}</td>
              </tr>
            `
          )
          .join("")
      : `<tr><td colspan="7" class="muted">No hay guías candidatas para este cierre.</td></tr>`;

    box.innerHTML = `
      <div><b>Preview:</b> SUCURSAL</div>
      <div class="muted small" style="margin-top:6px">Fecha: ${fmtText(p.fecha)}</div>
      <div class="muted small" style="margin-top:2px">Universo: ${sucLabel}</div>

      ${resumenHtml}

      <div style="overflow:auto; max-height:420px; margin-top:12px; border:1px solid rgba(255,255,255,.08); border-radius:12px;">
        <table>
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
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>

      ${
        guias.length > 100
          ? `<div class="muted small" style="margin-top:8px">Mostrando 100 guías de ${guias.length}.</div>`
          : ""
      }
    `;
  }

  function renderButtons() {
    const me = state.me || {};
    const rol = me?.user?.rol || "";
    const owner = isOwnerRole(rol);
    const mySuc = Number(me?.user?.sucursal_id || 0);
    const st = state.estado || {};
    const cierreActual = st.cierre || null;

    const btnCerrarMi = $("btn_cerrar_mi");
    const btnCerrarGlobal = $("btn_cerrar_global");
    const btnPreviewMi = $("btn_preview_mi");
    const btnPreviewGlobal = $("btn_preview_global");

    if (btnPreviewMi) btnPreviewMi.disabled = !mySuc;
    if (btnCerrarMi) btnCerrarMi.disabled = !mySuc || norm(cierreActual?.estado) === "CERRADO";
    if (btnPreviewGlobal) btnPreviewGlobal.disabled = !owner;
    if (btnCerrarGlobal) btnCerrarGlobal.disabled = !owner || !st.global_permitido;
  }

  async function doPreviewMiSucursal() {
    const fecha = state.fecha;
    const mySuc = Number(state?.me?.user?.sucursal_id || 0);
    if (!mySuc) throw new Error("Usuario sin sucursal");

    const p = await loadPreview({
      fecha,
      scope_modo: "SUCURSAL",
    });

    state.preview = p;
    renderPreview();
    showFlash("info", "Preview de mi sucursal cargado correctamente.");
  }

  async function doPreviewSucursal(sucursalId) {
    const fecha = state.fecha;

    const p = await loadPreview({
      fecha,
      scope_modo: "SUCURSAL",
      sucursal_id: sucursalId,
    });

    state.preview = p;
    renderPreview();
    showFlash("info", `Preview de sucursal ${sucursalId} cargado correctamente.`);
  }

  async function doPreviewGlobal() {
    const fecha = state.fecha;

    const p = await loadPreview({
      fecha,
      scope_modo: "GLOBAL",
    });

    state.preview = p;
    renderPreview();
    showFlash("info", "Preview GLOBAL cargado correctamente.");
  }

  async function confirmCloseMiSucursal() {
    const fecha = state.fecha;
    const r = await postCerrarDiario({
      scope_modo: "SUCURSAL",
      fecha,
    });

    state.preview = null;
    await reloadAll();

    showFlash("ok", `Cierre sucursal OK. Cierre ID: ${r.cierre_id}`);
  }

  async function confirmCloseSucursalOwner(sucursalId) {
    const fecha = state.fecha;
    const r = await postCerrarDiario({
      scope_modo: "SUCURSAL",
      fecha,
      sucursal_id: sucursalId,
    });

    state.preview = null;
    await reloadAll();

    showFlash("ok", `Cierre sucursal ${sucursalId} OK. Cierre ID: ${r.cierre_id}`);
  }

  async function confirmCloseGlobal() {
    const fecha = state.fecha;
    const r = await postCerrarDiario({
      scope_modo: "GLOBAL",
      fecha,
    });

    state.preview = null;
    await reloadAll();

    showFlash("ok", `Cierre GLOBAL OK. Cierre ID: ${r.cierre_id}`);
  }

  async function reloadAll() {
    state.fecha = $("fecha")?.value || todayYMD();
    state.estado = await loadEstado(state.fecha);
    renderTopEstado();
    renderTablaSucursales();
    renderButtons();
    renderPreview();
  }

  async function init() {
    state.me = await getMe();
    $("fecha").value = todayYMD();
    state.fecha = $("fecha").value;

    $("btnVolverPanel")?.addEventListener("click", () => {
      window.location.href = "/panel.html";
    });

    if ($("previewBox")) {
      $("previewBox").innerHTML = `<div class="muted">Sin preview cargado.</div>`;
    }

    $("btn_refresh")?.addEventListener("click", async () => {
      clearFlash();
      clearPreview();
      await reloadAll();
      showFlash("info", "Estado de cierres actualizado.");
    });

    $("btn_preview_mi")?.addEventListener("click", async () => {
      try {
        clearFlash();
        await doPreviewMiSucursal();
      } catch (e) {
        showFlash("bad", (e?.data?.error) || e.message);
      }
    });

    $("btn_cerrar_mi")?.addEventListener("click", async () => {
      try {
        clearFlash();
        await confirmCloseMiSucursal();
      } catch (e) {
        showFlash("bad", (e?.data?.error) || e.message);
      }
    });

    $("btn_preview_global")?.addEventListener("click", async () => {
      try {
        clearFlash();
        await doPreviewGlobal();
      } catch (e) {
        showFlash("bad", (e?.data?.error) || e.message);
      }
    });

    $("btn_cerrar_global")?.addEventListener("click", async () => {
      try {
        clearFlash();
        await confirmCloseGlobal();
      } catch (e) {
        showFlash("bad", (e?.data?.error) || e.message);
      }
    });

    await reloadAll();
  }

  init().catch((err) => {
    console.error(err);
    showFlash("bad", err?.data?.error || err.message || "Error");
  });
})();