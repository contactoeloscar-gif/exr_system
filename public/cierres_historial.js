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

  function norm(v) {
    return String(v || "").trim().toUpperCase();
  }

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

  function buildQS() {
    const qs = new URLSearchParams();

    const desde = $("desde")?.value || "";
    const hasta = $("hasta")?.value || "";
    const scope = $("scope_modo")?.value || "";
    const estado = $("estado")?.value || "";
    const sucursalId = $("sucursal_id")?.value || "";
    const limit = $("limit")?.value || "100";

    if (desde) qs.set("desde", desde);
    if (hasta) qs.set("hasta", hasta);
    if (scope) qs.set("scope_modo", scope);
    if (estado) qs.set("estado", estado);
    if (sucursalId) qs.set("sucursal_id", sucursalId);
    if (limit) qs.set("limit", limit);

    return qs.toString();
  }

  function openComprobante(cierreId) {
    if (!cierreId) return;
    window.open(`/cierre_comprobante.html?id=${encodeURIComponent(cierreId)}`, "_blank");
  }

  async function loadListado() {
    const qs = buildQS();
    return api(`/interno/cierres/listado?${qs}`);
  }

  function renderRows(rows) {
    const tb = $("tb");
    tb.innerHTML = "";

    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="9" class="muted">Sin resultados.</td></tr>`;
      return;
    }

    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.id}</td>
        <td>${fmtText(r.fecha)}</td>
        <td><span class="pill ${norm(r.scope_modo) === "GLOBAL" ? "warn" : "ok"}">${fmtText(r.scope_modo)}</span></td>
        <td>
          ${
            norm(r.scope_modo) === "GLOBAL"
              ? `<span class="muted small">GLOBAL</span>`
              : `<div><b>${fmtText(r.sucursal_codigo, "S" + r.sucursal_id)}</b> — ${fmtText(r.sucursal_nombre)}</div><div class="muted small">id:${r.sucursal_id}</div>`
          }
        </td>
        <td><span class="pill ${norm(r.estado) === "CERRADO" ? "ok" : "warn"}">${fmtText(r.estado)}</span></td>
        <td>
          <div class="small">Pagadas: ${r.cantidad_pagadas ?? 0}</div>
          <div class="small">CE: ${r.cantidad_ce_pendiente ?? 0}</div>
          <div class="small">Guías: ${r.total_entregadas ?? 0}</div>
        </td>
        <td>
          <div>${fmtText(r.creado_por_usuario)}</div>
          <div class="muted small">${fmtTS(r.creado_en)}</div>
        </td>
        <td>${fmtTS(r.cerrado_en)}</td>
        <td>
          <div class="actions">
            <button class="btn" data-comp="${r.id}">Comprobante</button>
          </div>
        </td>
      `;
      tb.appendChild(tr);
    });

    tb.querySelectorAll("[data-comp]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-comp"));
        openComprobante(id);
      });
    });
  }

  async function reload() {
    clearFlash();
    const data = await loadListado();
    renderRows(data.rows || []);
    $("stats").textContent = `Resultados: ${data.total ?? 0} • Mostrando: ${(data.rows || []).length}`;
  }

  function setDefaults() {
    const today = new Date().toISOString().slice(0, 10);
    $("desde").value = today;
    $("hasta").value = today;
    $("limit").value = 100;
  }

  function clearFilters() {
    setDefaults();
    $("scope_modo").value = "";
    $("estado").value = "";
    $("sucursal_id").value = "";
  }

  async function init() {
    setDefaults();

    $("btnVolverCierres")?.addEventListener("click", () => {
      window.location.href = "/cierres.html";
    });

    $("btnVolverPanel")?.addEventListener("click", () => {
      window.location.href = "/panel.html";
    });

    $("btnBuscar")?.addEventListener("click", async () => {
      try {
        await reload();
      } catch (e) {
        showFlash("bad", (e?.data?.error) || e.message);
      }
    });

    $("btnLimpiar")?.addEventListener("click", async () => {
      try {
        clearFilters();
        await reload();
      } catch (e) {
        showFlash("bad", (e?.data?.error) || e.message);
      }
    });

    await reload();
  }

  init().catch((err) => {
    console.error(err);
    showFlash("bad", err?.data?.error || err.message || "Error");
  });
})();