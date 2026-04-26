(() => {
  console.log("CONTABILIDAD_AGENCIAS JS V6 CARGADO");

  const $ = (id) => document.getElementById(id);
  const LS_TOKEN = "exr_token";
  const API = "/interno/contabilidad";

  let authUser = null;
  let agencias = [];
  let selectedSucursalId = null;
  let selectedSucursalNombre = "";
  let selectedLiquidacionId = null;
  let currentLiquidacion = null;
  let liquidacionesListado = [];
  let liquidacionesResumen = null;

  function token() {
    return localStorage.getItem(LS_TOKEN) || "";
  }

  function asNum(v) {
    const n = Number(String(v ?? "").replace(",", ".").trim());
    return Number.isFinite(n) ? n : 0;
  }

  function asInt(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : NaN;
  }

  function money(v) {
    const n = Number(v);
    return `$ ${Number.isFinite(n) ? n.toFixed(2) : "0.00"}`;
  }

  function clean(v) {
    return String(v ?? "").trim();
  }

  function todayYmd() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function firstDayOfMonthYmd() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${yyyy}-${mm}-01`;
  }

  function esc(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value ?? "");
  }

  function setValue(id, value) {
    const el = $(id);
    if (el) el.value = value ?? "";
  }

  function roleUpper() {
    return String(authUser?.rol || "").trim().toUpperCase();
  }

  function isPrivRole() {
    return ["OWNER", "ADMIN"].includes(roleUpper());
  }

  function liqDer(row) {
    return row?.estado_derivado && typeof row.estado_derivado === "object"
      ? row.estado_derivado
      : {};
  }

  async function apiGet(path) {
    const r = await fetch(path, {
      headers: { Authorization: "Bearer " + token() },
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok || data?.ok === false) {
      const msg = data?.detail || data?.error || `HTTP ${r.status}`;
      throw new Error(msg);
    }

    return data;
  }

  async function apiPost(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token(),
      },
      body: JSON.stringify(body || {}),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok || data?.ok === false) {
      const msg = data?.detail || data?.error || `HTTP ${r.status}`;
      throw new Error(msg);
    }

    return data;
  }

  function setResumenEstado(text, meta = "") {
    setText("resumenEstado", text);
    setText("resumenMeta", meta || "");
  }

  function setLiquidacionStatus(text, meta = "") {
    setText("liqSelEstado", text);
    setText("liqSelMeta", meta || "");
  }

  function setGenStatus(text, msg = "") {
    setText("genEstado", text);
    setText("genEstadoMsg", msg || "");
  }

  function setPagoStatus(text, msg = "") {
    setText("pagoEstado", text);
    setText("pagoEstadoMsg", msg || "");
  }

  function setListadoLiquidacionesStatus(text, meta = "") {
    setText("liqListadoEstado", text);
    setText("liqListadoMeta", meta || "");
  }

  function badgeEstadoLiquidacionHTML(der, fallbackEstado) {
    const visible = String(der?.estado_visible || fallbackEstado || "").toUpperCase();
    let cls = "";
    if (visible === "CONCILIADA") cls = "ok";
    else if (["APROBADA", "PENDIENTE_CONCILIACION", "PENDIENTE_REVISION"].includes(visible)) cls = "warn";
    else if (visible === "ANULADA") cls = "bad";

    const nueva = der?.nueva
      ? `<span class="ca-pill bad">NUEVA</span> `
      : "";

    return `${nueva}<span class="ca-pill ${cls}">${esc(visible || "-")}</span>`;
  }

  function resetLiquidablesBox() {
    setText("liqKCreditos", money(0));
    setText("liqKDebitos", money(0));
    setText("liqKSaldo", money(0));
    setText("liqKCantidad", "0");
    if ($("tbLiquidables")) {
      $("tbLiquidables").innerHTML =
        `<tr><td colspan="6" class="ca-empty">No hay movimientos bloqueados para liquidar</td></tr>`;
    }
  }

  function resetMovimientosBox() {
    if ($("tbMovimientos")) {
      $("tbMovimientos").innerHTML =
        `<tr><td colspan="8" class="ca-empty">No hay movimientos para mostrar</td></tr>`;
    }
  }

  function resetLiquidacionesListadoBox() {
    liquidacionesListado = [];
    if ($("tbLiquidacionesListado")) {
      $("tbLiquidacionesListado").innerHTML =
        `<tr><td colspan="7" class="ca-empty">Sin liquidaciones para mostrar</td></tr>`;
    }
    setListadoLiquidacionesStatus("Sin liquidaciones", "Todavía no se cargó el listado");
  }

  function resetLiquidacionBox() {
    currentLiquidacion = null;
    selectedLiquidacionId = null;

    setValue("selLiquidacionId", "");
    setValue("selLiquidacionSucursal", "");
    setValue("selLiquidacionDesde", "");
    setValue("selLiquidacionHasta", "");
    setValue("selLiquidacionEstado", "");

    setText("selKCreditos", money(0));
    setText("selKDebitos", money(0));
    setText("selKSaldo", money(0));
    setText("selKSaldoPendiente", money(0));

    if ($("tbLiquidacionItems")) {
      $("tbLiquidacionItems").innerHTML =
        `<tr><td colspan="6" class="ca-empty">Sin liquidación seleccionada</td></tr>`;
    }
    if ($("tbLiquidacionPagos")) {
      $("tbLiquidacionPagos").innerHTML =
        `<tr><td colspan="7" class="ca-empty">Sin pagos registrados</td></tr>`;
    }

    setLiquidacionStatus("Sin liquidación", "Seleccioná o generá una liquidación");
    syncActionButtons();
  }

  function fillSelectedAgencyUI() {
    setValue("movSucursalNombre", selectedSucursalNombre || "");
    setValue("liqSucursalNombre", selectedSucursalNombre || "");
    setValue("genSucursalNombre", selectedSucursalNombre || "");
  }

  function syncActionButtons() {
    const hasAgency =
      Number.isFinite(Number(selectedSucursalId)) &&
      Number(selectedSucursalId) > 0;

    const hasLiq =
      Number.isFinite(Number(selectedLiquidacionId)) &&
      Number(selectedLiquidacionId) > 0;

    const saldoPendiente =
      Number(currentLiquidacion?.resumen?.saldo_pendiente_absoluto ?? 0) || 0;

    const estadoLiq = String(
      currentLiquidacion?.resumen?.estado ||
      currentLiquidacion?.cabecera?.estado ||
      ""
    ).toUpperCase();

    const canRegisterPago =
      hasLiq &&
      saldoPendiente > 0 &&
      !["BORRADOR", "ANULADA", "PAGADA_TOTAL"].includes(estadoLiq);

    const canConciliar =
      hasLiq &&
      saldoPendiente === 0 &&
      ["APROBADA", "PAGADA_PARCIAL", "PAGADA_TOTAL"].includes(estadoLiq);

    if ($("btnMovimientosRefresh")) $("btnMovimientosRefresh").disabled = !hasAgency;
    if ($("btnLiquidablesRefresh")) $("btnLiquidablesRefresh").disabled = !hasAgency;
    if ($("btnMovimientosBuscar")) $("btnMovimientosBuscar").disabled = !hasAgency;
    if ($("btnMovimientosLimpiar")) $("btnMovimientosLimpiar").disabled = !hasAgency;
    if ($("btnVerLiquidables")) $("btnVerLiquidables").disabled = !hasAgency;
    if ($("btnGenerarLiquidacion")) $("btnGenerarLiquidacion").disabled = !hasAgency;

    if ($("btnLiquidacionRefresh")) $("btnLiquidacionRefresh").disabled = !hasLiq;
    if ($("btnAprobarLiquidacion")) $("btnAprobarLiquidacion").disabled = !hasLiq || !["BORRADOR", "OBSERVADA"].includes(estadoLiq);
    if ($("btnRegistrarPago")) $("btnRegistrarPago").disabled = !canRegisterPago;
    if ($("btnConciliarLiquidacion")) $("btnConciliarLiquidacion").disabled = !canConciliar;
    if ($("btnLiquidacionesRefresh")) $("btnLiquidacionesRefresh").disabled = false;
  }

  function agencyActionButtons(row) {
    return `
      <div class="ca-actions">
        <button class="btn btn-ver-mov" data-id="${row.sucursal_id}" data-nombre="${esc(row.sucursal_nombre)}" type="button">Movs.</button>
        <button class="btn btn-ver-liq" data-id="${row.sucursal_id}" data-nombre="${esc(row.sucursal_nombre)}" type="button">Liquidables</button>
        <button class="btn ok btn-gen-liq" data-id="${row.sucursal_id}" data-nombre="${esc(row.sucursal_nombre)}" type="button">Generar</button>
      </div>
    `;
  }

  function renderAgencias(items) {
    const tb = $("tbAgencias");
    if (!tb) return;

    if (!items?.length) {
      tb.innerHTML = `<tr><td colspan="9" class="ca-empty">No hay agencias configuradas para liquidación</td></tr>`;
      return;
    }

    tb.innerHTML = items.map((row) => {
      const selected =
        Number(selectedSucursalId) === Number(row.sucursal_id)
          ? ` class="ca-selected"`
          : "";

      const saldoAbierto = Number(row.saldo_abierto || 0);
      const saldoLiquidable = Number(row.saldo_liquidable || 0);
      const saldoEnLiquidacion = Number(row.saldo_en_liquidacion || 0);

      return `
        <tr data-sucursal-id="${row.sucursal_id}"${selected}>
          <td>
            <strong>${esc(row.sucursal_nombre)}</strong><br>
            <span class="ca-muted ca-code">#${row.sucursal_id}</span>
          </td>

          <td>
            <strong>${money(row.creditos_abiertos)}</strong>
            <div class="ca-muted">Solo PENDIENTE</div>
          </td>

          <td>
            <strong>${money(row.debitos_abiertos)}</strong>
            <div class="ca-muted">Solo PENDIENTE</div>
          </td>

          <td>
            <strong>${money(saldoAbierto)}</strong>
            <div class="ca-muted">Abierto real</div>
          </td>

          <td>
            <strong>${money(saldoLiquidable)}</strong>
            <div class="ca-muted">Bloqueado para cierre</div>
          </td>

          <td>
            <strong>${Number(row.cant_pendiente || 0)}</strong>
            <div class="ca-muted">movs. pendientes</div>
          </td>

          <td>
            <strong>${Number(row.cant_bloqueado_cierre || 0)}</strong>
            <div class="ca-muted">movs. bloqueados</div>
          </td>

          <td>
            <strong>${Number(row.cant_en_liquidacion || 0)}</strong>
            <div class="ca-muted">${money(saldoEnLiquidacion)}</div>
          </td>

          <td>${agencyActionButtons(row)}</td>
        </tr>
      `;
    }).join("");

    [...tb.querySelectorAll("tr[data-sucursal-id]")].forEach((tr) => {
      tr.addEventListener("click", async () => {
        const sid = Number(tr.dataset.sucursalId);
        const ag = agencias.find((x) => Number(x.sucursal_id) === sid);
        selectAgency(sid, ag?.sucursal_nombre || "");
        await safeAction(async () => {
          await loadMovimientos();
          await loadLiquidables();
          await loadLiquidacionesListado();
        }, "No se pudo cargar la agencia seleccionada.");
      });
    });

    [...tb.querySelectorAll(".btn-ver-mov")].forEach((b) => {
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        selectAgency(Number(b.dataset.id), b.dataset.nombre || "");
        await safeAction(async () => {
          await loadMovimientos();
          await loadLiquidacionesListado();
        }, "No se pudieron cargar los movimientos.");
      });
    });

    [...tb.querySelectorAll(".btn-ver-liq")].forEach((b) => {
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        selectAgency(Number(b.dataset.id), b.dataset.nombre || "");
        await safeAction(async () => {
          await loadLiquidables();
          await loadLiquidacionesListado();
        }, "No se pudieron cargar los liquidables.");
      });
    });

    [...tb.querySelectorAll(".btn-gen-liq")].forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        selectAgency(Number(b.dataset.id), b.dataset.nombre || "");
        openGenerarLiquidacionDialog();
      });
    });
  }

  function renderMovimientos(items) {
    const tb = $("tbMovimientos");
    if (!tb) return;

    if (!items?.length) {
      tb.innerHTML = `<tr><td colspan="8" class="ca-empty">No hay movimientos para mostrar</td></tr>`;
      return;
    }

    tb.innerHTML = items.map((m) => `
      <tr>
        <td>${esc(m.fecha_operativa || "")}</td>
        <td>${esc(m.sentido || "")}</td>
        <td>${esc(m.concepto || "")}</td>
        <td>${esc(m.numero_guia || m.guia_id || "")}</td>
        <td>${money(m.importe)}</td>
        <td><span class="ca-pill">${esc(m.estado || "")}</span></td>
        <td title="${esc(m.descripcion || "")}">${esc(m.descripcion || "")}</td>
        <td class="ca-code">${esc(m.ref_uid || "")}</td>
      </tr>
    `).join("");
  }

  function renderLiquidables(data) {
    const items = data?.items || [];
    const resumen = data?.resumen || {};

    setText("liqKCreditos", money(resumen.total_creditos || 0));
    setText("liqKDebitos", money(resumen.total_debitos || 0));
    setText("liqKSaldo", money(resumen.saldo_neto || 0));
    setText("liqKCantidad", String(items.length || 0));

    const tb = $("tbLiquidables");
    if (!tb) return;

    if (!items.length) {
      tb.innerHTML = `<tr><td colspan="6" class="ca-empty">No hay movimientos bloqueados para liquidar</td></tr>`;
      return;
    }

    tb.innerHTML = items.map((m) => `
      <tr>
        <td>${esc(m.fecha_operativa || "")}</td>
        <td>${esc(m.sentido || "")}</td>
        <td>${esc(m.concepto || "")}</td>
        <td>${esc(m.numero_guia || m.guia_id || "")}</td>
        <td>${money(m.importe)}</td>
        <td>${esc(m.descripcion || "")}</td>
      </tr>
    `).join("");
  }

  function renderLiquidacionesResumenPanel(data) {
    liquidacionesResumen = data || null;

    setText("liqNotifNuevas", Number(data?.nuevas || 0));
    setText("liqNotifPendPago", Number(data?.pendientes_pago || 0));
    setText("liqNotifPendConc", Number(data?.pendientes_conciliacion || 0));
    setText("liqNotifConciliadas", Number(data?.conciliadas || 0));

    const ultimaTxt = [
      `Nuevas: ${Number(data?.nuevas || 0)}`,
      `Pend. cobro/pago: ${Number(data?.pendientes_pago || 0)}`,
      `Pend. conciliación: ${Number(data?.pendientes_conciliacion || 0)}`,
      `Conciliadas: ${Number(data?.conciliadas || 0)}`
    ].join(" • ");

    setText("liqNotifUltima", ultimaTxt);
  }

  function currentListadoLiquidaciones() {
    const onlyNew = !!$("chkLiquidacionesSoloNoVistas")?.checked;
    let rows = Array.isArray(liquidacionesListado) ? [...liquidacionesListado] : [];

    if (selectedSucursalId && isPrivRole()) {
      rows = rows.filter((x) => Number(x.sucursal_id) === Number(selectedSucursalId));
    }

    if (onlyNew) {
      rows = rows.filter((x) => !!liqDer(x).nueva);
    }

    return rows;
  }

  function renderLiquidacionesListado() {
    const tb = $("tbLiquidacionesListado");
    if (!tb) return;

    const rows = currentListadoLiquidaciones();

    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="7" class="ca-empty">Sin liquidaciones para mostrar</td></tr>`;
      setListadoLiquidacionesStatus(
        "Sin resultados",
        selectedSucursalId
          ? `Sin liquidaciones para ${selectedSucursalNombre || "#" + selectedSucursalId}`
          : "No hay liquidaciones disponibles"
      );
      return;
    }

    tb.innerHTML = rows.map((x) => {
      const der = liqDer(x);
      const periodo = `${esc(x.periodo_desde || "")} → ${esc(x.periodo_hasta || "")}`;
      const rowCls = der.nueva ? ` class="ca-selected"` : "";

      return `
        <tr data-liq-id="${x.id}"${rowCls}>
          <td><strong>#${esc(x.id)}</strong></td>
          <td>${esc(x.sucursal_nombre || x.sucursal_id || "")}</td>
          <td>${periodo}</td>
          <td>${money(x.saldo_neto || 0)}</td>
          <td>
            ${badgeEstadoLiquidacionHTML(der, x.estado)}
            <div class="ca-muted" style="margin-top:4px">${esc(der.resumen_corto || "")}</div>
          </td>
          <td>${esc(x.created_at || "")}</td>
          <td>
            <button class="btn btn-abrir-liquidacion" data-id="${x.id}" type="button">Abrir</button>
          </td>
        </tr>
      `;
    }).join("");

    setListadoLiquidacionesStatus(
      "Listado actualizado",
      `${rows.length} liquidación(es) visibles`
    );

    [...tb.querySelectorAll(".btn-abrir-liquidacion")].forEach((b) => {
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = Number(b.dataset.id);
        if (!id) return;

        await safeAction(async () => {
          await openLiquidacion(id);
        }, "No se pudo abrir la liquidación.");
      });
    });

    [...tb.querySelectorAll("tr[data-liq-id]")].forEach((tr) => {
      tr.addEventListener("click", async () => {
        const id = Number(tr.dataset.liqId);
        if (!id) return;

        await safeAction(async () => {
          await openLiquidacion(id);
        }, "No se pudo abrir la liquidación.");
      });
    });
  }

  function renderLiquidacion(liq) {
    currentLiquidacion = liq;
    selectedLiquidacionId = Number(liq?.resumen?.id || liq?.cabecera?.id || 0) || null;

    const cab = liq?.cabecera || {};
    const resu = liq?.resumen || {};
    const items = liq?.items || [];
    const pagos = liq?.pagos || [];
    const der = cab?.estado_derivado || {};

    setValue("selLiquidacionId", resu.id || cab.id || "");
    setValue("selLiquidacionSucursal", resu.sucursal_nombre || cab.sucursal_nombre || "");
    setValue("selLiquidacionDesde", resu.periodo_desde || cab.periodo_desde || "");
    setValue("selLiquidacionHasta", resu.periodo_hasta || cab.periodo_hasta || "");
    setValue("selLiquidacionEstado", der.estado_visible || resu.estado || cab.estado || "");

    setText("selKCreditos", money(resu.total_creditos || cab.total_creditos || 0));
    setText("selKDebitos", money(resu.total_debitos || cab.total_debitos || 0));
    setText("selKSaldo", money(resu.saldo_neto || cab.saldo_neto || 0));
    setText("selKSaldoPendiente", money(resu.saldo_pendiente_absoluto || 0));

    setLiquidacionStatus(
      der.estado_visible || resu.estado || cab.estado || "Sin estado",
      der.resumen_corto || `Pagos registrados: ${money(resu.total_pagos_registrados || 0)}`
    );

    const tbItems = $("tbLiquidacionItems");
    if (tbItems) {
      tbItems.innerHTML = items.length
        ? items.map((it) => `
            <tr>
              <td>${esc(it.fecha_operativa || "")}</td>
              <td>${esc(it.sentido || "")}</td>
              <td>${esc(it.concepto || "")}</td>
              <td>${esc(it.numero_guia || it.guia_id || "")}</td>
              <td>${money(it.importe)}</td>
              <td>${esc(it.descripcion_snapshot || "")}</td>
            </tr>
          `).join("")
        : `<tr><td colspan="6" class="ca-empty">Sin items</td></tr>`;
    }

    const tbPagos = $("tbLiquidacionPagos");
    if (tbPagos) {
      tbPagos.innerHTML = pagos.length
        ? pagos.map((p) => `
            <tr>
              <td>${esc(p.fecha || "")}</td>
              <td>${esc(p.tipo || "")}</td>
              <td>${esc(p.medio_pago || "")}</td>
              <td>${money(p.importe)}</td>
              <td>${esc(p.referencia || "")}</td>
              <td><span class="ca-pill">${esc(p.estado || "")}</span></td>
              <td>${esc(p.observaciones || "")}</td>
            </tr>
          `).join("")
        : `<tr><td colspan="7" class="ca-empty">Sin pagos registrados</td></tr>`;
    }

    syncActionButtons();
  }

  function selectAgency(sucursalId, sucursalNombre) {
    selectedSucursalId = Number(sucursalId);
    selectedSucursalNombre = String(sucursalNombre || "");

    fillSelectedAgencyUI();
    renderAgencias(agencias);
    renderLiquidacionesListado();

    const ag = agencias.find((x) => Number(x.sucursal_id) === Number(selectedSucursalId));

    setResumenEstado(
      "Agencia seleccionada",
      ag
        ? `${selectedSucursalNombre} (#${selectedSucursalId}) • Abierto real: ${money(ag.saldo_abierto || 0)} • Liquidable: ${money(ag.saldo_liquidable || 0)} • En liquidación: ${money(ag.saldo_en_liquidacion || 0)}`
        : `${selectedSucursalNombre} (#${selectedSucursalId})`
    );

    syncActionButtons();
  }

          async function loadAuth() {
  const data = await apiGet("/test-auth");
  authUser = data.user;

  const rol = String(authUser?.rol || "").trim().toUpperCase();
  if (!["OWNER", "ADMIN"].includes(rol)) {
    alert("No tenés permisos para ingresar a Contabilidad Agencias.");
    location.replace("/panel.html");
    return;
  }

  setText(
    "who",
    `${authUser?.usuario || "usuario"} • rol ${authUser?.rol || "?"} • sucursal_id ${authUser?.sucursal_id ?? "?"}`
  );
}

  async function loadResumen() {
    setResumenEstado("Cargando…", "Consultando resumen de agencias");

    const data = await apiGet(`${API}/agencias/resumen`);
    agencias = data.items || [];

    if (!agencias.length) {
      renderAgencias([]);
      selectedSucursalId = null;
      selectedSucursalNombre = "";
      fillSelectedAgencyUI();
      resetMovimientosBox();
      resetLiquidablesBox();
      resetLiquidacionesListadoBox();
      resetLiquidacionBox();
      setResumenEstado("Sin agencias", "No hay agencias configuradas para liquidación");
      syncActionButtons();
      return;
    }

    const stillExists = agencias.some(
      (x) => Number(x.sucursal_id) === Number(selectedSucursalId)
    );

    if (!stillExists) {
      selectedSucursalId = Number(agencias[0].sucursal_id);
      selectedSucursalNombre = String(agencias[0].sucursal_nombre || "");
    } else {
      const found = agencias.find(
        (x) => Number(x.sucursal_id) === Number(selectedSucursalId)
      );
      selectedSucursalNombre = String(found?.sucursal_nombre || "");
    }

    fillSelectedAgencyUI();
    renderAgencias(agencias);
    syncActionButtons();

    const ag = agencias.find(
      (x) => Number(x.sucursal_id) === Number(selectedSucursalId)
    );

    setResumenEstado(
      "Listo",
      ag
        ? `${agencias.length} agencia(s) • activa: ${selectedSucursalNombre} (#${selectedSucursalId}) • Abierto real actual: ${money(ag.saldo_abierto || 0)} • Liquidable: ${money(ag.saldo_liquidable || 0)}`
        : `${agencias.length} agencia(s)`
    );
  }

  async function loadMovimientos() {
    if (!selectedSucursalId) {
      resetMovimientosBox();
      return;
    }

    const fd = clean($("movFechaDesde")?.value);
    const fh = clean($("movFechaHasta")?.value);
    const estado = clean($("movEstado")?.value);
    const q = clean($("movQ")?.value);

    const qs = new URLSearchParams();
    if (fd) qs.set("fecha_desde", fd);
    if (fh) qs.set("fecha_hasta", fh);
    if (estado) qs.set("estado", estado);
    if (q) qs.set("q", q);

    const data = await apiGet(`${API}/agencias/${selectedSucursalId}/movimientos?${qs.toString()}`);
    renderMovimientos(data.items || []);
  }

  async function loadLiquidables() {
    if (!selectedSucursalId) {
      resetLiquidablesBox();
      return;
    }

    const fd = clean($("liqFechaDesde")?.value);
    const fh = clean($("liqFechaHasta")?.value);

    const qs = new URLSearchParams();
    if (fd) qs.set("fecha_desde", fd);
    if (fh) qs.set("fecha_hasta", fh);

    const data = await apiGet(`${API}/agencias/${selectedSucursalId}/liquidables?${qs.toString()}`);
    renderLiquidables(data);
  }

  async function bloquearPendientes() {
  if (!selectedSucursalId) {
    alert("Seleccioná una agencia primero.");
    return;
  }

  const fechaDesde = clean($("liqFechaDesde")?.value);
  const fechaHasta = clean($("liqFechaHasta")?.value);

  if (!confirm("¿Bloquear movimientos PENDIENTE para dejarlos listos para liquidación?")) {
    return;
  }

  const data = await apiPost(`${API}/agencias/${selectedSucursalId}/bloquear-pendientes`, {
    fecha_desde: fechaDesde || null,
    fecha_hasta: fechaHasta || null,
    observaciones: "Bloqueado desde Contabilidad Agencias"
  });

  alert(data.message || "Movimientos bloqueados.");

  await loadResumen();
  await loadMovimientos();
  await loadLiquidables();
}
  async function loadLiquidacionesResumen() {
    try {
      const data = await apiGet(`${API}/liquidaciones/resumen`);
      renderLiquidacionesResumenPanel(data);
    } catch (err) {
      console.warn("loadLiquidacionesResumen warning:", err);
      renderLiquidacionesResumenPanel({
        nuevas: 0,
        pendientes_pago: 0,
        pendientes_conciliacion: 0,
        conciliadas: 0
      });
      setListadoLiquidacionesStatus("Avisos no disponibles", String(err?.message || err));
    }
  }

  async function loadLiquidacionesListado() {
    try {
      const soloNoVistas = !!$("chkLiquidacionesSoloNoVistas")?.checked;
      const qs = new URLSearchParams();
      qs.set("limit", "50");
      qs.set("offset", "0");
      if (soloNoVistas) qs.set("solo_no_vistas", "1");

      const data = await apiGet(`${API}/liquidaciones?${qs.toString()}`);
      liquidacionesListado = data.items || [];
      renderLiquidacionesListado();
    } catch (err) {
      console.warn("loadLiquidacionesListado warning:", err);
      resetLiquidacionesListadoBox();
      setListadoLiquidacionesStatus("Listado no disponible", String(err?.message || err));
    }
  }

  async function markLiquidacionVista(liquidacionId) {
    if (isPrivRole()) return;
    try {
      await apiPost(`${API}/liquidaciones/${liquidacionId}/marcar-vista`, {});
    } catch (err) {
      console.warn("markLiquidacionVista warning:", err);
    }
  }

  async function openLiquidacion(liquidacionId) {
    const data = await apiGet(`${API}/liquidaciones/${liquidacionId}`);
    renderLiquidacion(data.liquidacion);

    await markLiquidacionVista(liquidacionId);
    await loadLiquidacionesResumen();
    await loadLiquidacionesListado();
  }

  function openDialog(id) {
    const dlg = $(id);
    if (!dlg) return;
    if (typeof dlg.showModal === "function") dlg.showModal();
  }

  function closeDialog(id) {
    const dlg = $(id);
    if (!dlg) return;
    if (typeof dlg.close === "function") dlg.close();
  }

  function openGenerarLiquidacionDialog() {
    if (!selectedSucursalId) {
      alert("Seleccioná una agencia primero.");
      return;
    }

    setValue("genSucursalNombre", selectedSucursalNombre || "");
    setValue("genPeriodoDesde", $("liqFechaDesde")?.value || firstDayOfMonthYmd());
    setValue("genPeriodoHasta", $("liqFechaHasta")?.value || todayYmd());
    setValue("genObservaciones", "");
    setGenStatus("Pendiente", "Prepará el período y confirmá.");
    openDialog("dlgGenerarLiquidacion");
  }

  function openPagoDialog() {
    if (!selectedLiquidacionId || !currentLiquidacion) {
      alert("Seleccioná o abrí una liquidación primero.");
      return;
    }

    const saldoPendiente =
      Number(currentLiquidacion?.resumen?.saldo_pendiente_absoluto ?? 0) || 0;

    if (!(saldoPendiente > 0)) {
      alert("La liquidación no tiene saldo pendiente.");
      return;
    }

    const saldoNeto =
      Number(
        currentLiquidacion?.resumen?.saldo_neto ??
        currentLiquidacion?.cabecera?.saldo_neto ??
        0
      ) || 0;

    setValue("pagoLiquidacionId", selectedLiquidacionId);
    setValue(
      "pagoSucursalNombre",
      currentLiquidacion?.resumen?.sucursal_nombre ||
      currentLiquidacion?.cabecera?.sucursal_nombre ||
      ""
    );

    setValue("pagoTipo", saldoNeto >= 0 ? "PAGO_A_AGENCIA" : "COBRO_DE_AGENCIA");
    setValue("pagoFecha", todayYmd());
    setValue("pagoMedio", "TRANSFERENCIA");
    setValue("pagoImporte", Math.abs(saldoPendiente || saldoNeto || 0).toFixed(2));
    setValue("pagoReferencia", "");
    setValue("pagoObservaciones", "");
    setPagoStatus("Pendiente", "Completá datos y confirmá.");
    openDialog("dlgRegistrarPago");
  }

  async function generarLiquidacion() {
    if (!selectedSucursalId) {
      alert("Seleccioná una agencia primero.");
      return;
    }

    const body = {
      sucursal_id: selectedSucursalId,
      periodo_desde: clean($("genPeriodoDesde")?.value),
      periodo_hasta: clean($("genPeriodoHasta")?.value),
      observaciones: clean($("genObservaciones")?.value),
    };

    setGenStatus("Procesando", "Generando liquidación…");
    const data = await apiPost(`${API}/liquidaciones/generar`, body);
    setGenStatus("OK", `Liquidación #${data.liquidacion_id} generada.`);

    closeDialog("dlgGenerarLiquidacion");
    await loadResumen();
    await loadLiquidables();
    await loadLiquidacionesResumen();
    await loadLiquidacionesListado();
    await openLiquidacion(data.liquidacion_id);
  }

  async function aprobarLiquidacion() {
    if (!selectedLiquidacionId) {
      alert("Seleccioná una liquidación primero.");
      return;
    }

    const data = await apiPost(`${API}/liquidaciones/${selectedLiquidacionId}/aprobar`, {});
    await openLiquidacion(data?.resumen?.id || selectedLiquidacionId);
    await loadResumen();
    await loadLiquidacionesResumen();
    await loadLiquidacionesListado();
  }

  async function registrarPago() {
    if (!selectedLiquidacionId) {
      alert("Seleccioná una liquidación primero.");
      return;
    }

    const body = {
      tipo: clean($("pagoTipo")?.value),
      fecha: clean($("pagoFecha")?.value),
      medio_pago: clean($("pagoMedio")?.value),
      importe: asNum($("pagoImporte")?.value),
      referencia: clean($("pagoReferencia")?.value),
      observaciones: clean($("pagoObservaciones")?.value),
    };

    setPagoStatus("Procesando", "Registrando…");
    const data = await apiPost(`${API}/liquidaciones/${selectedLiquidacionId}/pagos`, body);
    setPagoStatus("OK", "Pago/cobro registrado.");

    closeDialog("dlgRegistrarPago");
    await openLiquidacion(data?.resumen?.id || selectedLiquidacionId);
    await loadResumen();
    await loadLiquidacionesResumen();
    await loadLiquidacionesListado();
  }

  async function conciliarLiquidacion() {
    if (!selectedLiquidacionId) {
      alert("Seleccioná una liquidación primero.");
      return;
    }

    if (!confirm("¿Conciliar la liquidación seleccionada? Solo debe hacerse con saldo pendiente 0.")) {
      return;
    }

    const data = await apiPost(`${API}/liquidaciones/${selectedLiquidacionId}/conciliar`, {});
    await openLiquidacion(data?.resumen?.id || selectedLiquidacionId);
    await loadResumen();
    await loadMovimientos();
    await loadLiquidables();
    await loadLiquidacionesResumen();
    await loadLiquidacionesListado();
    try {
      localStorage.removeItem("exr_bandeja_etag");
    } catch {}
  }

  async function buscarLiquidacionPorId() {
    const id = asInt($("buscarLiquidacionId")?.value);
    if (!Number.isFinite(id) || id <= 0) {
      alert("Ingresá un ID válido.");
      return;
    }

    closeDialog("dlgBuscarLiquidacion");
    await openLiquidacion(id);
  }

  async function safeAction(fn, fallbackMsg = "Ocurrió un error.") {
    try {
      await fn();
    } catch (err) {
      console.error(err);
      alert(String(err?.message || fallbackMsg));
    }
  }

  function bindEvents() {
    $("btnVolverPanel")?.addEventListener("click", () => {
      location.href = "/panel.html";
    });

    $("btnSalir")?.addEventListener("click", () => {
      localStorage.removeItem(LS_TOKEN);
      location.href = "/operador.html";
    });

    $("btnReload")?.addEventListener("click", () =>
      safeAction(async () => {
        await loadResumen();
        await loadLiquidacionesResumen();
        await loadLiquidacionesListado();
        if (selectedSucursalId) {
          await loadMovimientos();
          await loadLiquidables();
        }
        if (selectedLiquidacionId) {
          await openLiquidacion(selectedLiquidacionId);
        }
      }, "No se pudo actualizar la pantalla.")
    );

    $("btnResumenRefresh")?.addEventListener("click", () =>
      safeAction(loadResumen, "No se pudo recargar el resumen.")
    );

    $("btnMovimientosRefresh")?.addEventListener("click", () =>
      safeAction(loadMovimientos, "No se pudieron cargar los movimientos.")
    );

    $("btnLiquidablesRefresh")?.addEventListener("click", () =>
      safeAction(loadLiquidables, "No se pudieron cargar los liquidables.")
    );

    $("btnLiquidacionRefresh")?.addEventListener("click", () =>
      safeAction(async () => {
        if (selectedLiquidacionId) await openLiquidacion(selectedLiquidacionId);
      }, "No se pudo recargar la liquidación.")
    );

    $("btnLiquidacionesRefresh")?.addEventListener("click", () =>
      safeAction(async () => {
        await loadLiquidacionesResumen();
        await loadLiquidacionesListado();
      }, "No se pudo recargar el listado de liquidaciones.")
    );

    $("chkLiquidacionesSoloNoVistas")?.addEventListener("change", () =>
      safeAction(renderLiquidacionesListado, "No se pudo refrescar el listado.")
    );

    $("btnBloquearPendientes")?.addEventListener("click", () =>
      safeAction(bloquearPendientes, "No se pudieron bloquear los movimientos pendientes.")
    );

    $("btnMovimientosBuscar")?.addEventListener("click", () =>
      safeAction(loadMovimientos, "No se pudieron buscar los movimientos.")
    );

    $("btnMovimientosLimpiar")?.addEventListener("click", () =>
      safeAction(async () => {
        setValue("movFechaDesde", "");
        setValue("movFechaHasta", "");
        setValue("movEstado", "");
        setValue("movQ", "");
        await loadMovimientos();
      }, "No se pudieron limpiar los filtros.")
    );

    $("btnVerLiquidables")?.addEventListener("click", () =>
      safeAction(loadLiquidables, "No se pudieron cargar los liquidables.")
    );

    $("btnGenerarLiquidacion")?.addEventListener("click", openGenerarLiquidacionDialog);

    $("btnBuscarLiquidacion")?.addEventListener("click", () => openDialog("dlgBuscarLiquidacion"));

    $("btnAprobarLiquidacion")?.addEventListener("click", () =>
      safeAction(aprobarLiquidacion, "No se pudo aprobar la liquidación.")
    );

    $("btnRegistrarPago")?.addEventListener("click", openPagoDialog);

    $("btnConciliarLiquidacion")?.addEventListener("click", () =>
      safeAction(conciliarLiquidacion, "No se pudo conciliar la liquidación.")
    );

    $("btnCloseDlgGenerar")?.addEventListener("click", () => closeDialog("dlgGenerarLiquidacion"));
    $("btnCancelarGeneracion")?.addEventListener("click", () => closeDialog("dlgGenerarLiquidacion"));
    $("btnConfirmarGeneracion")?.addEventListener("click", () =>
      safeAction(generarLiquidacion, "No se pudo generar la liquidación.")
    );

    $("btnCloseDlgPago")?.addEventListener("click", () => closeDialog("dlgRegistrarPago"));
    $("btnCancelarPago")?.addEventListener("click", () => closeDialog("dlgRegistrarPago"));
    $("btnConfirmarPago")?.addEventListener("click", () =>
      safeAction(registrarPago, "No se pudo registrar el pago/cobro.")
    );

    $("btnCloseDlgBuscarLiq")?.addEventListener("click", () => closeDialog("dlgBuscarLiquidacion"));
    $("btnCancelarBuscarLiq")?.addEventListener("click", () => closeDialog("dlgBuscarLiquidacion"));
    $("btnConfirmarBuscarLiq")?.addEventListener("click", () =>
      safeAction(buscarLiquidacionPorId, "No se pudo abrir la liquidación.")
    );
  }

  async function init() {
    try {
      setValue("movFechaDesde", firstDayOfMonthYmd());
      setValue("movFechaHasta", todayYmd());
      setValue("liqFechaDesde", firstDayOfMonthYmd());
      setValue("liqFechaHasta", todayYmd());

      resetMovimientosBox();
      resetLiquidablesBox();
      resetLiquidacionesListadoBox();
      resetLiquidacionBox();
      bindEvents();
      syncActionButtons();

      await loadAuth();
      await loadResumen();
      await loadLiquidacionesResumen();
      await loadLiquidacionesListado();

      if (selectedSucursalId) {
        await loadMovimientos();
        await loadLiquidables();
      }
    } catch (err) {
      console.error("contabilidad_agencias init error:", err);
      setResumenEstado("Error", String(err?.message || err));
      alert(String(err?.message || err));
    }
  }

  init();
})();