(() => {
  const $ = (id) => document.getElementById(id);

  let currentLote = null;
  let guiaEncontrada = null;
  let guiasDisponibles = [];
  let lotesPage = 0;
  let lotesLimit = 5;

  function token() {
    return localStorage.getItem("exr_token") || "";
  }

  function headers(extra = {}) {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token()}`,
      ...extra
    };
  }

  function esc(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function todayYmd() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function setStatus(id, msg, isErr = false) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isErr ? "#ff8d8d" : "#b7c1ca";
  }

  function badge(v) {
    return `<span class="badge">${esc(v || "-")}</span>`;
  }

  async function api(url, opts = {}) {
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.ok) {
      const msg = data?.error || data?.detail || `Error ${r.status}`;
      const err = new Error(msg);
      err.httpStatus = r.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  function setCount(id, value) {
    const el = $(id);
    if (!el) return;
    el.textContent = String(Number(value || 0));
  }

  function initDefaults() {
    const fecha = $("fecha_operativa");
    if (fecha) fecha.value = todayYmd();
  }

  function setBlockVisible(id, visible) {
    const el = $(id);
    if (!el) return;
    el.style.display = visible ? "" : "none";
  }

  function setWorkflowHint(msg) {
    const el = $("detailWorkflowHint");
    if (!el) return;
    el.innerHTML = msg || "Seleccioná un lote para ver la acción operativa correspondiente.";
  }

  function focusFirstRecepcionControl() {
    const first = document.querySelector(".rx-estado");
    if (!first) return;
    first.scrollIntoView({ behavior: "smooth", block: "center" });
    first.focus();
  }

  function syncDetailMode(lote) {
    const estado = String(lote?.estado || "").toUpperCase();

    const isAbierto = estado === "ABIERTO";
    const isDespachado = estado === "DESPACHADO";
    const isRecibido = estado === "RECIBIDO";

    setBlockVisible("sectionAbierto", isAbierto);
    setBlockVisible("sectionRecepcion", isDespachado);
    setBlockVisible("sectionCierre", isRecibido);

    if (!lote?.id) {
      setWorkflowHint("Seleccioná un lote para ver la acción operativa correspondiente.");
      return;
    }

    if (isAbierto) {
      setWorkflowHint(`
        <b>Lote ABIERTO.</b>
        Podés agregar o quitar guías, buscar disponibles y preparar el lote antes de consolidarlo.
      `);
      return;
    }

    if (estado === "CONSOLIDADO") {
      setWorkflowHint(`
        <b>Lote CONSOLIDADO.</b>
        Ya no se agregan guías. El siguiente paso es <b>Despachar</b>.
      `);
      return;
    }

    if (isDespachado) {
      setWorkflowHint(`
        <b>Lote DESPACHADO.</b>
        Abajo, en <b>Guías del lote</b>, completá los controles de recepción.
        Por defecto todas quedan en <b>RECIBIDO_OK</b>.
      `);
      return;
    }

    if (isRecibido) {
      setWorkflowHint(`
        <b>Lote RECIBIDO.</b>
        Si está todo conforme, podés ejecutar <b>Cerrar lote</b>.
      `);
      return;
    }

    if (estado === "CERRADO") {
      setWorkflowHint(`<b>Lote CERRADO.</b> Operación finalizada.`);
      return;
    }

    if (estado === "ANULADO") {
      setWorkflowHint(`<b>Lote ANULADO.</b> No admite nuevas acciones operativas.`);
      return;
    }

    setWorkflowHint(`Estado actual: <b>${esc(estado || "-")}</b>.`);
  }

  function resetGuiaEncontrada() {
    guiaEncontrada = null;
    renderGuiaEncontrada(null);
    const input = $("numero_guia_add");
    if (input) input.value = "";
  }

async function crearLote() {
  try {
    setStatus("createStatus", "Creando lote...");

    const tipoRaw = String($("tipo_lote")?.value || "").trim().toUpperCase();
    const tipoLote = tipoRaw === "DISTRIBUCION" ? "DISTRIBUCION" : "COLECTA";

    const body = {
      tipo_lote: tipoLote,
      fecha_operativa: $("fecha_operativa")?.value || null,
      sucursal_origen_id: Number($("sucursal_origen_id")?.value || 0),
      sucursal_destino_id: Number($("sucursal_destino_id")?.value || 0),
      chofer: $("chofer")?.value.trim() || "",
      vehiculo: $("vehiculo")?.value.trim() || "",
      patente: $("patente")?.value.trim() || "",
      observaciones: $("observaciones")?.value.trim() || ""
    };

    const data = await api("/interno/lotes", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body)
    });

    setStatus("createStatus", `Lote creado: ${data.lote.numero_lote}`);
    await cargarLotes();
    if (data.lote?.id) {
      await cargarDetalle(data.lote.id);
    }
  } catch (err) {
    setStatus("createStatus", err.message, true);
  }
}

  async function cargarLotes() {
    try {
      setStatus("listStatus", "Cargando lotes...");

      const qs = new URLSearchParams();
      if ($("f_q")?.value.trim()) qs.set("q", $("f_q").value.trim());
      if ($("f_tipo")?.value) qs.set("tipo_lote", $("f_tipo").value);
      if ($("f_estado")?.value) qs.set("estado", $("f_estado").value);

      qs.set("limit", String(lotesLimit));
      qs.set("offset", String(lotesPage * lotesLimit));

      const data = await api(`/interno/lotes?${qs.toString()}`, {
        headers: headers({ "Content-Type": "application/json" })
      });

      const rows = Array.isArray(data.items) ? data.items : [];
      const tbody = $("tbodyLotes");
      if (!tbody) return;

      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="10">Sin lotes para mostrar.</td></tr>`;
        setStatus("listStatus", "Sin resultados.");

        const total = Number(data.total || 0);
        const totalPages = Math.max(1, Math.ceil(total / lotesLimit));

        if ($("lotesPagerInfo")) {
          $("lotesPagerInfo").textContent = `Página ${Math.min(lotesPage + 1, totalPages)} de ${totalPages}`;
        }
        if ($("btnPrevLotes")) $("btnPrevLotes").disabled = lotesPage <= 0;
        if ($("btnNextLotes")) $("btnNextLotes").disabled = true;

        return;
      }

      tbody.innerHTML = rows.map(r => `
        <tr>
          <td><strong>${esc(r.numero_lote)}</strong></td>
          <td>${badge(r.tipo_lote)}</td>
          <td>${badge(r.estado)}</td>
          <td>${badge(r.resultado_recepcion || "-")}</td>
          <td>${esc(r.sucursal_origen_nombre || r.sucursal_origen_id)}</td>
          <td>${esc(r.sucursal_destino_nombre || r.sucursal_destino_id)}</td>
          <td>${esc(r.cant_guias)}</td>
          <td>${esc(r.cant_bultos)}</td>
          <td>${esc(r.chofer || "-")}</td>
          <td>
            <div class="row-actions">
              <button class="secondary" data-view="${r.id}">Ver</button>
              <button class="secondary" data-print="${r.id}">Imprimir</button>
            </div>
          </td>
        </tr>
      `).join("");

      tbody.querySelectorAll("[data-view]").forEach(btn => {
        btn.addEventListener("click", () => cargarDetalle(btn.getAttribute("data-view")));
      });

      tbody.querySelectorAll("[data-print]").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-print");
          window.open(`/hoja_ruta_lote.html?id=${encodeURIComponent(id)}`, "_blank");
        });
      });

      const total = Number(data.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / lotesLimit));
      const pageActual = Math.min(lotesPage + 1, totalPages);

      if ($("lotesPagerInfo")) $("lotesPagerInfo").textContent = `Página ${pageActual} de ${totalPages}`;
      if ($("btnPrevLotes")) $("btnPrevLotes").disabled = lotesPage <= 0;
      if ($("btnNextLotes")) $("btnNextLotes").disabled = (lotesPage + 1) >= totalPages;

      setStatus("listStatus", `${rows.length} lote(s) cargados. Total: ${total}.`);
    } catch (err) {
      const tbody = $("tbodyLotes");
      if (tbody) tbody.innerHTML = `<tr><td colspan="10">${esc(err.message)}</td></tr>`;
      setStatus("listStatus", err.message, true);
    }
  }

  function renderGuiaEncontrada(guia) {
    const box = $("guiaEncontradaBox");
    const btn = $("btnAgregarGuia");
    if (!box || !btn) return;

    if (!guia) {
      box.innerHTML = `<div class="empty">Buscá una guía por número para agregarla al lote.</div>`;
      btn.disabled = true;
      return;
    }

    box.innerHTML = `
      <div class="item">
        <div class="line1">${esc(guia.numero_guia)} · ID ${esc(guia.id)}</div>
        <div class="line2">
          ${esc(guia.remitente_nombre || "-")} → ${esc(guia.destinatario_nombre || "-")}
        </div>
        <div class="line2">
          Origen: ${esc(guia.sucursal_origen_nombre || guia.sucursal_origen_id)} ·
          Destino final: ${esc(guia.sucursal_destino_nombre || guia.sucursal_destino_id)}
        </div>
        <div class="line2">
          Estado: ${esc(guia.estado_logistico || "-")} ·
          Pago: ${esc(guia.estado_pago || "-")} ·
          Cobro: ${esc(guia.tipo_cobro || "-")} ·
          Bultos: ${esc(guia.cant_bultos_calc || 0)}
        </div>
      </div>
    `;

    btn.disabled = false;
  }

  async function buscarGuia() {
    try {
      if (!currentLote?.id) throw new Error("Seleccioná un lote primero.");

      const numero = String($("numero_guia_add")?.value || "").trim();
      if (!numero) throw new Error("Ingresá un número de guía.");

      setStatus("detailStatus", "Buscando guía...");

      const data = await api(`/interno/lotes/buscar-guia?numero=${encodeURIComponent(numero)}`, {
        headers: headers({ "Content-Type": "application/json" })
      });

      guiaEncontrada = data.guia;
      renderGuiaEncontrada(guiaEncontrada);
      setStatus("detailStatus", "Guía encontrada.");
    } catch (err) {
      guiaEncontrada = null;
      renderGuiaEncontrada(null);

      if (err.httpStatus === 404) {
        setStatus("detailStatus", "Guía no encontrada. Probá con el número completo o una parte exacta.", true);
      } else if (err.httpStatus === 403) {
        setStatus("detailStatus", "La guía existe, pero no tenés permiso para verla desde esta sucursal.", true);
      } else {
        setStatus("detailStatus", err.message, true);
      }
    }
  }

  async function cargarGuiasDisponibles() {
    try {
      const wrap = $("guiasDisponiblesWrap");
      if (!wrap) return;

      if (!currentLote?.id) {
        setCount("countGuiasDisponibles", 0);
        wrap.innerHTML = `<div class="empty">Seleccioná un lote para ver guías disponibles.</div>`;
        return;
      }

      if (String(currentLote.estado || "").toUpperCase() !== "ABIERTO") {
        guiasDisponibles = [];
        setCount("countGuiasDisponibles", 0);
        wrap.innerHTML = `<div class="empty">Las guías disponibles solo se muestran para lotes ABIERTOS.</div>`;
        return;
      }

      const q = String($("f_disponibles_q")?.value || "").trim();
      const qs = new URLSearchParams();
      if (q) qs.set("q", q);

      wrap.innerHTML = `<div class="empty">Cargando guías disponibles...</div>`;

      const data = await api(`/interno/lotes/${currentLote.id}/guias-disponibles?${qs.toString()}`, {
        headers: headers({ "Content-Type": "application/json" })
      });

      guiasDisponibles = Array.isArray(data.items) ? data.items : [];
      renderGuiasDisponibles(guiasDisponibles);
    } catch (err) {
      const wrap = $("guiasDisponiblesWrap");
      if (wrap) wrap.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  function renderGuiasDisponibles(items) {
    const wrap = $("guiasDisponiblesWrap");
    if (!wrap) return;

    const total = Array.isArray(items) ? items.length : 0;
    setCount("countGuiasDisponibles", total);

    if (!Array.isArray(items) || !items.length) {
      wrap.innerHTML = `<div class="empty">No hay guías disponibles para agregar.</div>`;
      return;
    }

    wrap.innerHTML = items.map((g) => `
      <div class="item">
        <div style="display:flex; gap:10px; align-items:flex-start;">
          <div style="padding-top:3px;">
            <input type="checkbox" class="chk-guia-disponible" data-guia="${g.id}" />
          </div>
          <div style="flex:1;">
            <div class="line1">${esc(g.numero_guia)} · ID ${esc(g.id)}</div>
            <div class="line2">
              ${esc(g.remitente_nombre || "-")} → ${esc(g.destinatario_nombre || "-")}
            </div>
            <div class="line2">
              Origen: ${esc(g.sucursal_origen_nombre || g.sucursal_origen_id)} ·
              Destino: ${esc(g.sucursal_destino_nombre || g.sucursal_destino_id)}
            </div>
            <div class="line2">
              Estado: ${esc(g.estado_logistico || "-")} ·
              Pago: ${esc(g.estado_pago || "-")} ·
              Cobro: ${esc(g.tipo_cobro || "-")} ·
              Bultos: ${esc(g.cant_bultos_calc || 0)}
            </div>
          </div>
        </div>
      </div>
    `).join("");
  }

  function renderGuiasAgregadas(guias, estadoLote) {
    const box = $("guiasAgregadasWrap");
    if (!box) return;

    const total = Array.isArray(guias) ? guias.length : 0;
    setCount("countGuiasAgregadas", total);

    if (!Array.isArray(guias) || !guias.length) {
      box.innerHTML = `<div class="empty">Todavía no hay guías agregadas al lote.</div>`;
      return;
    }

    const canRemove = String(estadoLote || "").toUpperCase() === "ABIERTO";

    box.innerHTML = guias.map((g) => `
      <div class="item">
        <div class="line1">${esc(g.numero_guia || g.guia_id)} · ${esc(g.estado_logistico || "-")}</div>
        <div class="line2">
          ${esc(g.remitente_nombre || "-")} → ${esc(g.destinatario_nombre || "-")}
        </div>
        <div class="line2">
          Destino final: ${esc(g.guia_sucursal_destino_nombre || g.guia_sucursal_destino_id || "-")} ·
          Bultos: ${esc(g.cant_bultos_declarada || 0)} ·
          Recepción: ${esc(g.estado_recepcion || "PENDIENTE")}
        </div>
        <div class="line3">${esc(g.observacion_recepcion || "")}</div>
        ${canRemove ? `
          <div style="margin-top:8px;">
            <button class="danger btn-remove-guia-agregada" data-guia="${g.guia_id}" style="width:auto;">
              Quitar guía
            </button>
          </div>
        ` : ""}
      </div>
    `).join("");

    box.querySelectorAll(".btn-remove-guia-agregada").forEach((btn) => {
      btn.addEventListener("click", () => quitarGuia(btn.getAttribute("data-guia")));
    });
  }

  function renderConflictosBatch(conflictos) {
    const box = $("guiasBatchConflictosWrap");
    if (!box) return;

    const total = Array.isArray(conflictos) ? conflictos.length : 0;
    setCount("countGuiasConflictos", total);

    if (!Array.isArray(conflictos) || !conflictos.length) {
      box.innerHTML = `<div class="empty">Sin conflictos.</div>`;
      return;
    }

    box.innerHTML = conflictos.map((c) => `
      <div class="item">
        <div class="line1">${esc(c.numero_guia || c.guia_id || "-")}</div>
        <div class="line2">Motivo: ${esc(c.error || "Conflicto no especificado")}</div>
        ${c.lote_activo ? `
          <div class="line3">
            Lote activo: ${esc(c.lote_activo.numero_lote || c.lote_activo.id || "-")}
          </div>
        ` : ""}
      </div>
    `).join("");
  }

  function getGuiasSeleccionadasDisponibles() {
    return Array.from(document.querySelectorAll(".chk-guia-disponible:checked"))
      .map((el) => Number(el.getAttribute("data-guia")))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  function marcarTodasDisponibles(flag) {
    document.querySelectorAll(".chk-guia-disponible").forEach((el) => {
      el.checked = !!flag;
    });
  }

  async function agregarGuiasSeleccionadas() {
    try {
      if (!currentLote?.id) throw new Error("Seleccioná un lote primero.");
      if (String(currentLote.estado || "").toUpperCase() !== "ABIERTO") {
        throw new Error("Solo se pueden agregar guías a un lote ABIERTO.");
      }

      const ids = getGuiasSeleccionadasDisponibles();
      if (!ids.length) {
        throw new Error("Seleccioná al menos una guía.");
      }

      renderConflictosBatch([]);
      setStatus("detailStatus", `Agregando ${ids.length} guía(s)...`);

      const data = await api(`/interno/lotes/${currentLote.id}/guias/batch`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ guia_ids: ids })
      });

      await cargarDetalle(currentLote.id);
      await cargarLotes();
      await cargarGuiasDisponibles();
      renderConflictosBatch([]);
      setStatus("detailStatus", data?.message || `${ids.length} guía(s) agregadas al lote.`);
    } catch (err) {
      const conflictos = err?.payload?.conflictos;
      if (Array.isArray(conflictos) && conflictos.length) {
        renderConflictosBatch(conflictos);
      }
      setStatus("detailStatus", err.message, true);
    }
  }

  function syncRecepcionObsInputs() {
    document.querySelectorAll(".rx-estado").forEach((sel) => {
      const guiaId = Number(sel.getAttribute("data-guia"));
      const obs = document.querySelector(`.rx-obs[data-guia="${guiaId}"]`);
      if (!obs) return;

      const estado = String(sel.value || "").toUpperCase();
      const requiereObs = ["FALTANTE", "DANADO", "OBSERVADO"].includes(estado);

      obs.disabled = !requiereObs;
      if (!requiereObs) obs.value = "";
    });
  }

  function renderRecepcionControles(guias, estadoLote) {
    const estado = String(estadoLote || "").toUpperCase();
    if (estado !== "DESPACHADO") return;

    const box = $("guiasWrap");
    if (!box) return;

    const itemsHtml = (Array.isArray(guias) ? guias : []).map((g) => `
      <div class="item" style="margin-top:10px;">
        <div class="line1">Recepción ${esc(g.numero_guia || g.guia_id)}</div>
        <div class="line2">
          ${esc(g.remitente_nombre || "-")} → ${esc(g.destinatario_nombre || "-")}
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top:8px;">
          <div>
            <label>Estado recepción</label>
            <select class="rx-estado" data-guia="${g.guia_id}">
              <option value="RECIBIDO_OK" selected>RECIBIDO_OK</option>
              <option value="FALTANTE">FALTANTE</option>
              <option value="DANADO">DANADO (continúa a central)</option>
              <option value="OBSERVADO">OBSERVADO (continúa a central)</option>            </select>
          </div>
          <div>
            <label>Observación</label>
            <input class="rx-obs" data-guia="${g.guia_id}" type="text" placeholder="Obligatoria si hay novedad" disabled />
          </div>
        </div>
      </div>
    `).join("");

    box.insertAdjacentHTML("beforeend", `
      <div style="margin-top:14px;">
        <div class="mini-title">Controles de recepción</div>
        <div class="muted" style="margin-bottom:8px;">
        Por defecto las guías quedan en <b>RECIBIDO_OK</b>. 
        Las novedades <b>DANADO</b> y <b>OBSERVADO</b> continúan el flujo en central y no traban la guía.   
     </div>
        ${itemsHtml || `<div class="empty">No hay guías para recepcionar.</div>`}
      </div>
    `);

    box.querySelectorAll(".rx-estado").forEach((sel) => {
      sel.addEventListener("change", syncRecepcionObsInputs);
    });

    syncRecepcionObsInputs();
  }

  function renderGuias(guias, estadoLote) {
    const box = $("guiasWrap");
    if (!box) return;

    if (!Array.isArray(guias) || !guias.length) {
      box.innerHTML = `<div class="empty">No hay detalle cargado.</div>`;
      return;
    }

    box.innerHTML = guias.map((g) => `
      <div class="item">
        <div class="line1">${esc(g.numero_guia || g.guia_id)} · ${esc(g.estado_logistico || "-")}</div>
        <div class="line2">
          ${esc(g.remitente_nombre || "-")} → ${esc(g.destinatario_nombre || "-")}
        </div>
        <div class="line2">
          Pago: ${esc(g.estado_pago || "-")} ·
          Cobro: ${esc(g.tipo_cobro || "-")} ·
          Bultos: ${esc(g.cant_bultos_declarada || 0)}
        </div>
        <div class="line2">
          Recepción actual: ${esc(g.estado_recepcion || "PENDIENTE")}
        </div>
        ${g.observacion_recepcion ? `<div class="line3">${esc(g.observacion_recepcion)}</div>` : ""}
      </div>
    `).join("");

    renderRecepcionControles(guias, estadoLote);
  }

  function loadMeta(lote) {
    $("detailNumero").textContent = lote.numero_lote || "Lote";
    $("detailSub").textContent = `ID ${lote.id} · ${lote.fecha_operativa || "-"}`;
    $("mTipo").textContent = lote.tipo_lote || "-";
    $("mEstado").textContent = lote.estado || "-";
    $("mOrigen").textContent = lote.sucursal_origen_nombre || lote.sucursal_origen_id || "-";
    $("mDestino").textContent = lote.sucursal_destino_nombre || lote.sucursal_destino_id || "-";
    $("mChofer").textContent = lote.chofer || "-";
    $("mVehiculo").textContent = [lote.vehiculo, lote.patente].filter(Boolean).join(" / ") || "-";
    $("mGuias").textContent = lote.cant_guias ?? "-";
    $("mBultos").textContent = lote.cant_bultos ?? "-";

    const mResultado = $("mResultadoRecepcion");
    if (mResultado) mResultado.textContent = lote.resultado_recepcion || "-";

    const estado = String(lote.estado || "").toUpperCase();

    if ($("btnImprimir")) $("btnImprimir").disabled = false;
    if ($("btnConsolidar")) $("btnConsolidar").disabled = estado !== "ABIERTO";
    if ($("btnDespachar")) $("btnDespachar").disabled = estado !== "CONSOLIDADO";
    if ($("btnAnular")) $("btnAnular").disabled = estado !== "ABIERTO";
    if ($("btnRecepcionar")) $("btnRecepcionar").disabled = estado !== "DESPACHADO";
    if ($("btnCerrarLote")) $("btnCerrarLote").disabled = estado !== "RECIBIDO";

    const wrapAdd = $("addGuiaWrap");
    if (wrapAdd) {
      wrapAdd.style.opacity = estado === "ABIERTO" ? "1" : "0.55";
      wrapAdd.style.pointerEvents = estado === "ABIERTO" ? "auto" : "none";
    }

    syncDetailMode(lote);
  }

  async function cargarDetalle(id) {
    try {
      setStatus("detailStatus", "Cargando detalle...");
      const data = await api(`/interno/lotes/${id}`, {
        headers: headers({ "Content-Type": "application/json" })
      });

      currentLote = data.lote;
      loadMeta(currentLote);
      renderGuias(currentLote.guias || [], currentLote.estado);
      resetGuiaEncontrada();
      renderConflictosBatch([]);
      await cargarGuiasDisponibles();

      const estado = String(currentLote?.estado || "").toUpperCase();
      if (estado === "ABIERTO") {
        setStatus("detailStatus", "Lote ABIERTO: podés agregar o quitar guías.");
      } else if (estado === "DESPACHADO") {
        setStatus("detailStatus", "Marcá novedades si existen. Por defecto todas las guías quedan en RECIBIDO_OK.");
      } else if (estado === "RECIBIDO") {
        setStatus("detailStatus", "Lote RECIBIDO: ya podés cerrarlo si corresponde.");
      } else {
        setStatus("detailStatus", "Detalle cargado.");
      }
    } catch (err) {
      setStatus("detailStatus", err.message, true);
    }
  }

  async function agregarGuia() {
    try {
      if (!currentLote?.id) throw new Error("Seleccioná un lote primero.");
      if (String(currentLote.estado || "").toUpperCase() !== "ABIERTO") {
        throw new Error("Solo se pueden agregar guías a un lote ABIERTO.");
      }
      if (!guiaEncontrada?.id) throw new Error("Buscá una guía primero.");

      setStatus("detailStatus", "Agregando guía...");

      await api(`/interno/lotes/${currentLote.id}/guias`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ guia_id: guiaEncontrada.id })
      });

      resetGuiaEncontrada();
      await cargarDetalle(currentLote.id);
      await cargarLotes();
      setStatus("detailStatus", "Guía agregada.");
    } catch (err) {
      setStatus("detailStatus", err.message, true);
    }
  }

  async function quitarGuia(guiaId) {
    try {
      if (!currentLote?.id) throw new Error("Seleccioná un lote primero.");
      if (!confirm(`¿Quitar guía ${guiaId} del lote?`)) return;

      setStatus("detailStatus", "Quitando guía...");

      await api(`/interno/lotes/${currentLote.id}/guias/${guiaId}`, {
        method: "DELETE",
        headers: headers({ "Content-Type": "application/json" })
      });

      await cargarDetalle(currentLote.id);
      await cargarLotes();
      setStatus("detailStatus", "Guía quitada.");
    } catch (err) {
      setStatus("detailStatus", err.message, true);
    }
  }

  async function consolidar() {
    try {
      if (!currentLote?.id) throw new Error("Seleccioná un lote primero.");
      if (!confirm(`¿Consolidar lote ${currentLote.numero_lote}?`)) return;

      setStatus("detailStatus", "Consolidando lote...");

      await api(`/interno/lotes/${currentLote.id}/consolidar`, {
        method: "POST",
        headers: headers()
      });

      await cargarDetalle(currentLote.id);
      await cargarLotes();
      setStatus("detailStatus", "Lote consolidado.");
    } catch (err) {
      setStatus("detailStatus", err.message, true);
    }
  }

  async function despachar() {
    try {
      if (!currentLote?.id) throw new Error("Seleccioná un lote primero.");
      if (!confirm(`¿Despachar lote ${currentLote.numero_lote}?`)) return;

      setStatus("detailStatus", "Despachando lote...");

      await api(`/interno/lotes/${currentLote.id}/despachar`, {
        method: "POST",
        headers: headers()
      });

      await cargarDetalle(currentLote.id);
      await cargarLotes();
      setStatus("detailStatus", "Lote despachado.");
    } catch (err) {
      setStatus("detailStatus", err.message, true);
    }
  }

  async function anular() {
    try {
      if (!currentLote?.id) throw new Error("Seleccioná un lote primero.");
      if (!confirm(`¿Anular lote ${currentLote.numero_lote}?`)) return;

      setStatus("detailStatus", "Anulando lote...");

      await api(`/interno/lotes/${currentLote.id}/anular`, {
        method: "POST",
        headers: headers()
      });

      await cargarDetalle(currentLote.id);
      await cargarLotes();
      setStatus("detailStatus", "Lote anulado.");
    } catch (err) {
      setStatus("detailStatus", err.message, true);
    }
  }

  function collectRecepcionItems() {
    if (!currentLote?.id) {
      throw new Error("Seleccioná un lote primero.");
    }

    const estados = Array.from(document.querySelectorAll(".rx-estado"));
    if (!estados.length) {
      throw new Error("No se cargaron los controles de recepción. Tocá 'Ver' sobre el lote y completá los estados abajo en 'Guías del lote'.");
    }

    const items = estados.map((sel) => {
      const guiaId = Number(sel.getAttribute("data-guia"));
      const estado = String(sel.value || "").trim().toUpperCase();
      const obsEl = document.querySelector(`.rx-obs[data-guia="${guiaId}"]`);
      const observacion = (obsEl?.value || "").trim();

      if (!estado) {
        throw new Error(`Debés indicar estado de recepción para la guía ${guiaId}.`);
      }

      if (["FALTANTE", "DANADO", "OBSERVADO"].includes(estado) && !observacion) {
        throw new Error(`Debés indicar observación para la guía ${guiaId}.`);
      }

      return {
        guia_id: guiaId,
        estado_recepcion: estado,
        observacion_recepcion: observacion
      };
    });

    const ids = items.map(x => x.guia_id);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      throw new Error("Hay guías duplicadas en la recepción.");
    }

    if ((currentLote.guias || []).length !== items.length) {
      throw new Error("La recepción debe resolver todas las guías del lote.");
    }

    return items;
  }

  async function recepcionar() {
    try {
      if (!currentLote?.id) throw new Error("Seleccioná un lote primero.");
      if (String(currentLote.estado || "").toUpperCase() !== "DESPACHADO") {
        throw new Error("Solo se puede recepcionar un lote DESPACHADO.");
      }

      const controles = Array.from(document.querySelectorAll(".rx-estado"));
      if (!controles.length) {
        throw new Error("No se cargaron los controles de recepción. Tocá 'Ver' sobre el lote y desplazate al bloque 'Guías del lote'.");
      }

      const items = collectRecepcionItems();

      setStatus("detailStatus", "Registrando recepción...");

      await api(`/interno/lotes/${currentLote.id}/recepcion`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          items,
          observacion_general: $("observacion_general")?.value.trim() || ""
        })
      });

      if ($("observacion_general")) $("observacion_general").value = "";
      await cargarDetalle(currentLote.id);
      await cargarLotes();
      setStatus("detailStatus", "Recepción registrada.");
    } catch (err) {
      setStatus("detailStatus", err.message, true);
      focusFirstRecepcionControl();
    }
  }

  async function cerrarLote() {
    try {
      if (!currentLote?.id) throw new Error("Seleccioná un lote primero.");
      if (String(currentLote.estado || "").toUpperCase() !== "RECIBIDO") {
        throw new Error("Solo se puede cerrar un lote RECIBIDO.");
      }
      if (!confirm(`¿Cerrar lote ${currentLote.numero_lote}?`)) return;

      setStatus("detailStatus", "Cerrando lote...");

      await api(`/interno/lotes/${currentLote.id}/cerrar`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          observacion_cierre: $("observacion_cierre")?.value.trim() || ""
        })
      });

      if ($("observacion_cierre")) $("observacion_cierre").value = "";
      await cargarDetalle(currentLote.id);
      await cargarLotes();
      setStatus("detailStatus", "Lote cerrado.");
    } catch (err) {
      setStatus("detailStatus", err.message, true);
    }
  }

  async function cargarSucursales() {
    try {
      const data = await api("/interno/lotes/sucursales", {
        headers: headers({ "Content-Type": "application/json" })
      });

      const items = Array.isArray(data.items) ? data.items : [];
      const origen = $("sucursal_origen_id");
      const destino = $("sucursal_destino_id");
      const tipo = $("tipo_lote");

      if (!origen || !destino || !tipo) return;

      const userRol = String(data.user?.rol || "").toUpperCase();
      const userSucursalId = Number(data.user?.sucursal_id || 0);
      const casaCentralId = Number(data.casa_central_id || 0);

      const options = [
        `<option value="">Seleccionar...</option>`,
        ...items.map(s => `<option value="${esc(s.id)}">${esc(s.nombre || s.codigo || s.id)}</option>`)
      ].join("");

      origen.innerHTML = options;
      destino.innerHTML = options;

      if (userRol === "OPERADOR" || userRol === "ENCARGADO") {
        tipo.value = "COLECTA";
        tipo.disabled = true;

        origen.value = String(userSucursalId);
        origen.disabled = true;

        destino.value = String(casaCentralId);
        destino.disabled = true;
      } else {
        tipo.disabled = false;
        origen.disabled = false;
        destino.disabled = false;
      }

      refreshTipoLoteLabels();
    } catch (err) {
      setStatus("createStatus", err.message, true);
    }
  }

  function refreshTipoLoteLabels() {
    const tipo = String($("tipo_lote")?.value || "COLECTA").toUpperCase();
    const lbl = $("lblDestinoLote");

    if (lbl) {
      lbl.textContent = tipo === "DISTRIBUCION"
        ? "Sucursal destino final"
        : "Nodo receptor / HUB_EXR";
    }
  }

  function bind() {
    $("btnPrevLotes")?.addEventListener("click", async () => {
      if (lotesPage <= 0) return;
      lotesPage -= 1;
      await cargarLotes();
    });

    $("btnNextLotes")?.addEventListener("click", async () => {
      lotesPage += 1;
      await cargarLotes();
    });

    $("btnRefrescarDisponibles")?.addEventListener("click", () => {
      cargarGuiasDisponibles();
    });

    $("btnMarcarTodasDisponibles")?.addEventListener("click", () => {
      marcarTodasDisponibles(true);
    });

    $("btnDesmarcarTodasDisponibles")?.addEventListener("click", () => {
      marcarTodasDisponibles(false);
    });

    $("btnAgregarSeleccionadas")?.addEventListener("click", () => {
      agregarGuiasSeleccionadas();
    });

    $("f_disponibles_q")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        cargarGuiasDisponibles();
      }
    });

    $("btnCrearLote")?.addEventListener("click", crearLote);
    $("btnRefrescar")?.addEventListener("click", cargarLotes);
    $("btnBuscarGuia")?.addEventListener("click", buscarGuia);
    $("btnAgregarGuia")?.addEventListener("click", agregarGuia);
    $("btnConsolidar")?.addEventListener("click", consolidar);
    $("btnDespachar")?.addEventListener("click", despachar);
    $("btnAnular")?.addEventListener("click", anular);
    $("btnRecepcionar")?.addEventListener("click", recepcionar);
    $("btnCerrarLote")?.addEventListener("click", cerrarLote);

    $("btnImprimir")?.addEventListener("click", () => {
      if (!currentLote?.id) return;
      window.open(`/hoja_ruta_lote.html?id=${encodeURIComponent(currentLote.id)}`, "_blank");
    });

    $("f_q")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        lotesPage = 0;
        cargarLotes();
      }
    });

    $("f_tipo")?.addEventListener("change", () => {
      lotesPage = 0;
      cargarLotes();
    });

    $("f_estado")?.addEventListener("change", () => {
      lotesPage = 0;
      cargarLotes();
    });

    $("tipo_lote")?.addEventListener("change", refreshTipoLoteLabels);

    $("numero_guia_add")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") buscarGuia();
    });
  }

  initDefaults();
  bind();
  renderGuiaEncontrada(null);
  refreshTipoLoteLabels();
  syncDetailMode(null);
  cargarSucursales();
  cargarLotes();
})();