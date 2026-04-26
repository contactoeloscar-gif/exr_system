(() => {
  const $ = (id) => document.getElementById(id);
  const LS_TOKEN = "exr_token";

  const state = {
    me: null,
    fecha: null,
    estado: null,
    preview: null,
    loading: false,
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

  function fmtNum(v) {
    const n = Number(v || 0);
    return Number.isFinite(n) ? String(n) : "0";
  }

  function isOwnerRole(rol) {
    return ["OWNER", "ADMIN"].includes(norm(rol));
  }

  function pill(text, type = "") {
    return `<span class="c-pill ${type}">${text}</span>`;
  }

  function goLogin() {
    window.location.href = "/operador.html";
  }

  function showFlash(type, text) {
    const box = $("flashBox");
    if (!box) return;
    box.style.display = "block";
    box.innerHTML = `<div class="exr-pro-msg ${type}">${text}</div>`;
  }

  function clearFlash() {
    const box = $("flashBox");
    if (!box) return;
    box.style.display = "none";
    box.innerHTML = "";
  }

  function setBusy(flag) {
    state.loading = !!flag;
    [
      "btn_refresh",
      "btn_preview_mi",
      "btn_cerrar_mi",
      "btn_preview_global",
      "btn_cerrar_global",
      "fecha",
    ].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !!flag;
    });
  }

  async function getMe() {
    try {
      return await api("/interno/ping");
    } catch (err) {
      if (err?.status === 401) {
        alert("Sesión vencida o no autenticada.");
        goLogin();
        return null;
      }
      throw err;
    }
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
    if (box) box.innerHTML = `<div class="exr-pro-empty">Sin preview cargado.</div>`;
  }

  function renderKpis() {
    const box = $("kpiRow");
    if (!box) return;

    const me = state.me || {};
    const st = state.estado || {};
    const owner = isOwnerRole(me?.user?.rol || "");
    const cierres = st.cierres || [];

    if (owner) {
      const totalSuc = (st.sucursales || []).length;
      const cerradasSuc = cierres.filter(
        (x) => norm(x.scope_modo) === "SUCURSAL" && norm(x.estado) === "CERRADO"
      ).length;
      const faltantes = (st.faltantes_sucursal_id || []).length;
      const globalPermitido = !!st.global_permitido;

      box.innerHTML = `
        <div class="c-kpi">
          <div class="c-kpi-label">Fecha</div>
          <div class="c-kpi-value">${fmtText(state.fecha)}</div>
        </div>
        <div class="c-kpi">
          <div class="c-kpi-label">Sucursales</div>
          <div class="c-kpi-value">${fmtNum(totalSuc)}</div>
        </div>
        <div class="c-kpi">
          <div class="c-kpi-label">Sucursales cerradas</div>
          <div class="c-kpi-value">${fmtNum(cerradasSuc)}</div>
        </div>
        <div class="c-kpi">
          <div class="c-kpi-label">Faltantes</div>
          <div class="c-kpi-value">${fmtNum(faltantes)}</div>
        </div>
        <div class="c-kpi">
          <div class="c-kpi-label">Cierre global</div>
          <div class="c-kpi-value">${globalPermitido ? "Habilitado" : "Pendiente"}</div>
        </div>
      `;
      return;
    }

    const cierre = st.cierre || null;
    const estado = cierre?.estado || "PENDIENTE";

    box.innerHTML = `
      <div class="c-kpi">
        <div class="c-kpi-label">Fecha</div>
        <div class="c-kpi-value">${fmtText(state.fecha)}</div>
      </div>
      <div class="c-kpi">
        <div class="c-kpi-label">Mi estado</div>
        <div class="c-kpi-value">${fmtText(estado)}</div>
      </div>
      <div class="c-kpi">
        <div class="c-kpi-label">Cierre ID</div>
        <div class="c-kpi-value">${fmtText(cierre?.id)}</div>
      </div>
      <div class="c-kpi">
        <div class="c-kpi-label">Cerrado en</div>
        <div class="c-kpi-value">${fmtTS(cierre?.cerrado_en)}</div>
      </div>
    `;
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
        <div class="c-row" style="margin-top:8px;">
          ${pill(`GLOBAL ${globalPermitido ? "habilitado" : "pendiente"}`, globalPermitido ? "ok" : "bad")}
          ${
            falt.length
              ? pill(`Faltan cierres SUCURSAL: ${falt.join(", ")}`, "bad")
              : pill("Todas las sucursales del día están cerradas", "ok")
          }
        </div>
      `;
      return;
    }

    const cierre = st.cierre || null;
    const estado = cierre?.estado || "PENDIENTE";

    box.innerHTML = `
      <div><b>Vista:</b> Mi sucursal</div>
      <div class="c-row" style="margin-top:8px;">
        ${pill(`Estado: ${estado}`, norm(estado) === "CERRADO" ? "ok" : "warn")}
        ${pill(`Cierre ID: ${cierre?.id ?? "-"}`)}
        ${pill(`Cerrado en: ${fmtTS(cierre?.cerrado_en)}`)}
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

    function resumenCell(c) {
      if (!c) return `<span class="c-small c-muted">Sin cierre todavía</span>`;
      return `
        <div class="c-small">Pagadas: <b>${fmtNum(c.cantidad_pagadas)}</b></div>
        <div class="c-small">CE: <b>${fmtNum(c.cantidad_ce_pendiente)}</b></div>
        <div class="c-small">Guías: <b>${fmtNum(c.total_entregadas)}</b></div>
      `;
    }

    function actionsHtml(scope, id, estado, cierreId) {
      const closed = norm(estado) === "CERRADO";
      return `
        <div class="c-actions">
          <button class="exr-pro-btn" data-preview="${scope}:${id}">Preview</button>
          <button class="exr-pro-btn ok" data-close="${scope}:${id}" ${closed ? "disabled" : ""}>Cerrar</button>
          ${cierreId ? `<button class="exr-pro-btn" data-comp="${cierreId}">Comprobante</button>` : ""}
        </div>
      `;
    }

    if (!owner) {
      const sucursal = st.sucursal || { id: mySuc, codigo: "MI", nombre: "Mi sucursal" };
      const c = st.cierre || null;
      const estado = c ? c.estado : "PENDIENTE";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>
          <div><b>${fmtText(sucursal.codigo, "S" + (sucursal.id ?? ""))}</b> — ${fmtText(sucursal.nombre)}</div>
          <div class="c-small c-muted">id:${sucursal.id ?? "-"}</div>
        </td>
        <td>${pill(estado, norm(estado) === "CERRADO" ? "ok" : "warn")}</td>
        <td class="c-muted">${fmtTS(c?.cerrado_en)}</td>
        <td>${c?.id ?? "-"}</td>
        <td>${resumenCell(c)}</td>
        <td>${actionsHtml("SUCURSAL", sucursal.id, estado, c?.id)}</td>
      `;
      tb.appendChild(tr);
    } else {
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

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>
            <div><b>${fmtText(s.codigo, "S" + s.id)}</b> — ${fmtText(s.nombre)}</div>
            <div class="c-small c-muted">id:${s.id}</div>
          </td>
          <td>${pill(estado, norm(estado) === "CERRADO" ? "ok" : "warn")}</td>
          <td class="c-muted">${fmtTS(c?.cerrado_en)}</td>
          <td>${c?.id ?? "-"}</td>
          <td>${resumenCell(c)}</td>
          <td>${actionsHtml("SUCURSAL", s.id, estado, c?.id)}</td>
        `;
        tb.appendChild(tr);
      }
    }

    tb.querySelectorAll("button[data-preview]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const raw = btn.getAttribute("data-preview") || "";
        const [scope, idRaw] = raw.split(":");
        const sid = Number(idRaw || 0);

        btn.disabled = true;
        try {
          clearFlash();
          if (scope === "SUCURSAL") {
            const ownerLocal = isOwnerRole(state?.me?.user?.rol || "");
            if (ownerLocal) {
              await doPreviewSucursal(sid);
            } else {
              await doPreviewMiSucursal();
            }
          }
        } catch (e) {
          showFlash("bad", (e?.data?.error) || e.message);
        } finally {
          btn.disabled = false;
        }
      });
    });

    tb.querySelectorAll("button[data-close]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const raw = btn.getAttribute("data-close") || "";
        const [scope, idRaw] = raw.split(":");
        const sid = Number(idRaw || 0);

        btn.disabled = true;
        try {
          clearFlash();
          if (scope === "SUCURSAL") {
            const ownerLocal = isOwnerRole(state?.me?.user?.rol || "");
            if (ownerLocal) {
              await confirmCloseSucursalOwner(sid);
            } else {
              await confirmCloseMiSucursal();
            }
          }
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
      box.innerHTML = `<div class="exr-pro-empty">Sin preview cargado.</div>`;
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
      <div class="c-summary-grid">
        <div class="c-kpi">
          <div class="c-kpi-label">Guías</div>
          <div class="c-kpi-value">${fmtNum(tot.total_entregadas)}</div>
        </div>
        <div class="c-kpi">
          <div class="c-kpi-label">Pagadas</div>
          <div class="c-kpi-value">${fmtNum(tot.cantidad_pagadas)}</div>
        </div>
        <div class="c-kpi">
          <div class="c-kpi-label">Contra entrega</div>
          <div class="c-kpi-value">${fmtNum(tot.cantidad_ce_pendiente)}</div>
        </div>
        <div class="c-kpi">
          <div class="c-kpi-label">Bultos</div>
          <div class="c-kpi-value">${fmtNum(tot.total_bultos)}</div>
        </div>
      </div>
    `;

    if (scope === "GLOBAL") {
      box.innerHTML = `
        <div class="c-preview-head">
          <div>
            <div><b>Preview:</b> GLOBAL</div>
            <div class="c-small c-muted" style="margin-top:4px">Fecha: ${fmtText(p.fecha)}</div>
            <div class="c-small c-muted">Universo: cierres SUCURSAL cerrados del día</div>
          </div>
          <div class="c-row">
            ${pill(`GLOBAL ${p.global_permitido ? "habilitado" : "pendiente"}`, p.global_permitido ? "ok" : "bad")}
            ${
              (p.faltantes_sucursal_id || []).length
                ? pill(`Faltan: ${(p.faltantes_sucursal_id || []).join(", ")}`, "bad")
                : pill("Todas las sucursales cerradas", "ok")
            }
          </div>
        </div>

        ${resumenHtml}

        <div class="exr-pro-empty" style="margin-top:12px">
          El cierre GLOBAL consolida los cierres SUCURSAL del día. Esta vista es de control y validación, no de detalle por guía.
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
                <td>${fmtNum(g.cant_bultos)}</td>
                <td>${fmtText(g.estado_pago)}</td>
                <td>${fmtText(g.estado_logistico)}</td>
              </tr>
            `
          )
          .join("")
      : `<tr><td colspan="7" class="c-muted">No hay guías candidatas para este cierre.</td></tr>`;

    box.innerHTML = `
      <div class="c-preview-head">
        <div>
          <div><b>Preview:</b> SUCURSAL</div>
          <div class="c-small c-muted" style="margin-top:4px">Fecha: ${fmtText(p.fecha)}</div>
          <div class="c-small c-muted">Universo: ${sucLabel}</div>
        </div>
        <div class="c-row">
          ${pill(`Guías candidatas: ${guias.length}`, guias.length ? "ok" : "warn")}
        </div>
      </div>

      ${resumenHtml}

      <div class="c-table-box" style="margin-top:12px">
        <table class="c-mini-table">
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
          ? `<div class="c-small c-muted" style="margin-top:8px">Mostrando 100 guías de ${guias.length}.</div>`
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

    if (btnPreviewMi) btnPreviewMi.disabled = state.loading || !mySuc;
    if (btnCerrarMi) btnCerrarMi.disabled = state.loading || !mySuc || norm(cierreActual?.estado) === "CERRADO";
    if (btnPreviewGlobal) btnPreviewGlobal.disabled = state.loading || !owner;
    if (btnCerrarGlobal) btnCerrarGlobal.disabled = state.loading || !owner || !st.global_permitido;
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
    if (!confirm(`¿Cerrar mi sucursal para la fecha ${fecha}?`)) return;

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
    if (!confirm(`¿Cerrar la sucursal ${sucursalId} para la fecha ${fecha}?`)) return;

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
    if (!confirm(`¿Ejecutar cierre GLOBAL para la fecha ${fecha}?`)) return;

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
    renderKpis();
    renderTopEstado();
    renderTablaSucursales();
    renderButtons();
    renderPreview();
  }

  async function runAction(fn) {
    try {
      clearFlash();
      setBusy(true);
      await fn();
    } catch (err) {
      console.error(err);
      if (err?.status === 401) {
        alert("Sesión vencida o no autenticada.");
        goLogin();
        return;
      }
      showFlash("bad", err?.data?.error || err.message || "Error");
    } finally {
      setBusy(false);
      renderButtons();
    }
  }

  async function init() {
    state.me = await getMe();
    if (!state.me) return;

    $("fecha").value = todayYMD();
    state.fecha = $("fecha").value;

    $("btnVolverPanel")?.addEventListener("click", () => {
      window.location.href = "/panel.html";
    });

    $("fecha")?.addEventListener("change", async () => {
      await runAction(async () => {
        clearPreview();
        await reloadAll();
        showFlash("info", "Fecha operativa actualizada.");
      });
    });

    $("btn_refresh")?.addEventListener("click", async () => {
      await runAction(async () => {
        clearPreview();
        await reloadAll();
        showFlash("info", "Estado de cierres actualizado.");
      });
    });

    $("btn_preview_mi")?.addEventListener("click", async () => {
      await runAction(doPreviewMiSucursal);
    });

    $("btn_cerrar_mi")?.addEventListener("click", async () => {
      await runAction(confirmCloseMiSucursal);
    });

    $("btn_preview_global")?.addEventListener("click", async () => {
      await runAction(doPreviewGlobal);
    });

    $("btn_cerrar_global")?.addEventListener("click", async () => {
      await runAction(confirmCloseGlobal);
    });

    clearPreview();
    await runAction(reloadAll);
  }

  init().catch((err) => {
    console.error(err);
    if (err?.status === 401) {
      alert("Sesión vencida o no autenticada.");
      goLogin();
      return;
    }
    showFlash("bad", err?.data?.error || err.message || "Error");
  });
})();