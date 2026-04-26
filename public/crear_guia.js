// public/crear_guia.js (P15 bridge) — CORREGIDO + LISTO PARA PEGAR
// Alineado con backend P15:
// - DESTINO => condicion_pago=destino y estado_pago=pendiente_destino
// - ORIGEN => la UI ya no expone pendiente_origen como opción manual
// - El backend sigue resolviendo la lógica financiera real
// - Compatible con tu HTML actual

(() => {
  const $ = (id) => document.getElementById(id);
  const LS_TOKEN = "exr_token";

  const elItems = $("items");
  const elOut = $("out");
  const elStatus = $("status");
  const btnCrear = $("btnCrear");

  const VAL_DECL_MIN = 20000;
  const VAL_DECL_MAX = 80000;
  const SEGURO_PCT = 0.01;

  const elActions = (() => {
    const box = document.createElement("div");
    box.id = "actions";
    box.className = "row";
    box.style.marginTop = "10px";
    box.style.display = "none";
    elStatus.parentElement.appendChild(box);
    return box;
  })();

  const PRESETS = {
    SOBRE:    { bultos: 1, peso_kg: 0.5, largo_cm: 25,  ancho_cm: 15,  alto_cm: 1 },

    BOX_S:    { bultos: 1, peso_kg: 5,   largo_cm: 15,  ancho_cm: 10,  alto_cm: 10 },
    BOX_M:    { bultos: 1, peso_kg: 15,  largo_cm: 40,  ancho_cm: 30,  alto_cm: 30 },
    BOX_L:    { bultos: 1, peso_kg: 35,  largo_cm: 70,  ancho_cm: 50,  alto_cm: 50 },

    BOLSA_10: { bultos: 1, peso_kg: 10,  largo_cm: 60,  ancho_cm: 40,  alto_cm: 40 },
    BOLSA_20: { bultos: 1, peso_kg: 20,  largo_cm: 70,  ancho_cm: 50,  alto_cm: 45 },

    SILLA:    { bultos: 1, peso_kg: 6,   largo_cm: 50,  ancho_cm: 50,  alto_cm: 90 },
    BICI:     { bultos: 1, peso_kg: 15,  largo_cm: 170, ancho_cm: 25,  alto_cm: 90 },
  };

  let lastCotOk = false;
  let tmr = null;

  let authUser = null;
  let sucursales = [];

  const DEBUG = false;

  function token() {
    return localStorage.getItem(LS_TOKEN) || "";
  }

  function num(v) {
    const n = Number(String(v ?? "").replace(",", ".").trim());
    return Number.isFinite(n) ? n : 0;
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function clamp(n, min, max) {
    const x = Number(n) || 0;
    if (x < min) return min;
    if (x > max) return max;
    return x;
  }

  function setStatus(text, type = "") {
    elStatus.textContent = text;
    elStatus.className = "pill " + (type || "");
  }

  function showOut(obj) {
    if (!DEBUG) return;
    elOut.style.display = "block";
    elOut.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  }

  function resetKPIs() {
    $("k_vol").textContent = `0.00`;
    $("k_kgc").textContent = `0.00`;
    $("k_env").textContent = `$ 0.00`;
    $("k_tot").textContent = `$ 0.00`;
    $("valor_seguro").value = `0.00`;
  }

  function setSeguroZero() {
    $("valor_seguro").value = `0.00`;
  }

  function updateSeguroLocal() {
    const decl = round2(num($("valor_declarado").value));
    if (!(Number.isFinite(decl) && decl > 0)) {
      setSeguroZero();
      return;
    }
    const aseg = clamp(decl, VAL_DECL_MIN, VAL_DECL_MAX);
    const seguro = round2(aseg * SEGURO_PCT);
    $("valor_seguro").value = seguro.toFixed(2);
  }

function addItemRow(seed = {}) {
  const wrap = document.createElement("div");
  wrap.className = "cg-items-row itemrow";

  wrap.innerHTML = `
    <label class="exr-pro-field">Bultos
      <input class="exr-pro-input it_bultos" type="number" min="1" value="${seed.bultos ?? 1}">
    </label>
    <label class="exr-pro-field">Peso (kg)
      <input class="exr-pro-input it_peso" placeholder="1" value="${seed.peso_kg ?? 2}">
    </label>
    <label class="exr-pro-field">Largo (cm)
      <input class="exr-pro-input it_l" placeholder="10" value="${seed.largo_cm ?? 10}">
    </label>
    <label class="exr-pro-field">Ancho (cm)
      <input class="exr-pro-input it_a" placeholder="10" value="${seed.ancho_cm ?? 10}">
    </label>
    <label class="exr-pro-field">Alto (cm)
      <input class="exr-pro-input it_h" placeholder="10" value="${seed.alto_cm ?? 10}">
    </label>
    <button type="button" class="exr-pro-btn bad it_del" title="Eliminar">✕</button>
  `;

  wrap.querySelector(".it_del").addEventListener("click", () => {
    wrap.remove();
    debouncedCotizar();
  });

  ["it_bultos", "it_peso", "it_l", "it_a", "it_h"].forEach((cls) => {
    const el = wrap.querySelector("." + cls);
    el.addEventListener("input", debouncedCotizar);
    el.addEventListener("change", debouncedCotizar);
    el.addEventListener("keyup", debouncedCotizar);
  });

  elItems.appendChild(wrap);
}

  function collectItems() {
    const rows = [...elItems.querySelectorAll(".itemrow")];
    if (!rows.length) {
      return [{ bultos: 1, peso_kg: 2, largo_cm: 10, ancho_cm: 10, alto_cm: 10 }];
    }

    return rows.map((r) => ({
      descripcion: "",
      bultos: Math.max(1, Number(r.querySelector(".it_bultos").value) || 1),
      peso_kg: round2(num(r.querySelector(".it_peso").value)),
      largo_cm: round2(num(r.querySelector(".it_l").value)),
      ancho_cm: round2(num(r.querySelector(".it_a").value)),
      alto_cm: round2(num(r.querySelector(".it_h").value)),
    }));
  }

  function computePayGateOk() {
    const forma = $("forma_pago").value;
    const confirm = $("confirmar_pago")?.checked === true;

    if (forma === "DESTINO") return true;
    return confirm;
  }

  function domicilioOk() {
    const dom = $("entrega_domicilio").value === "true";
    if (!dom) return true;
    return $("destinatario_dir").value.trim().length >= 6;
  }

  function refreshCreateButton() {
    const ok = lastCotOk && computePayGateOk() && domicilioOk();
    btnCrear.disabled = !ok;
  }

  function syncPagoUI() {
    const forma = $("forma_pago").value;

    const metodo = $("metodo_pago");
    const estado = $("estado_pago");
    const confirm = $("confirmar_pago");

    if (forma === "DESTINO") {
      if (metodo) {
        metodo.disabled = true;
        metodo.value = "EFECTIVO";
      }

      if (estado) {
        estado.innerHTML = `
          <option value="pendiente_destino">pendiente_destino</option>
          <option value="cobrado_destino">cobrado_destino</option>
          <option value="observado">observado</option>
        `;
        estado.value = "pendiente_destino";
        estado.disabled = true;
      }

      if (confirm) {
        confirm.checked = false;
        confirm.disabled = true;
      }

      setStatus("Cobro en DESTINO → la guía quedará pendiente de cobro en sucursal destino", "warn");
    } else {
      if (metodo) metodo.disabled = false;

      if (estado) {
        estado.innerHTML = `
          <option value="no_aplica">no_aplica</option>
          <option value="observado">observado</option>
        `;
        estado.value = "no_aplica";
        estado.disabled = true;
      }

      if (confirm) {
        confirm.disabled = false;
      }

      if (confirm?.checked) {
        setStatus("Cobro confirmado en ORIGEN", "ok");
      } else {
        setStatus("Cobro en ORIGEN", "");
      }
    }

    refreshCreateButton();
  }

  function payloadCotizar() {
    const destinoVal = $("sucursal_destino_id").value;
    const items = collectItems();

    return {
      sucursal_destino_id: destinoVal ? Number(destinoVal) : undefined,
      entrega_domicilio: $("entrega_domicilio").value === "true",
      valor_declarado: round2(num($("valor_declarado").value)),
      items,
      peso_kg: 0,
      largo_cm: 0,
      ancho_cm: 0,
      alto_cm: 0,
    };
  }

  function quoteMissingMsg() {
    const destinoOk = !!$("sucursal_destino_id").value;
    const decl = num($("valor_declarado").value);
    const declOk = Number.isFinite(decl) && decl > 0;

    if (!destinoOk && !declOk) return "Elegí DESTINO y cargá VALOR DECLARADO para cotizar";
    if (!destinoOk) return "Elegí DESTINO para cotizar";
    if (!declOk) return "Cargá VALOR DECLARADO para cotizar";
    return "Completá los datos para cotizar";
  }

  function isReadyToQuote(payload) {
    const destinoOk = !!payload?.sucursal_destino_id;
    const declOk = Number.isFinite(payload?.valor_declarado) && payload.valor_declarado > 0;
    const itemsOk = Array.isArray(payload?.items) && payload.items.some((it) => (it.bultos || 0) > 0);
    return destinoOk && declOk && itemsOk;
  }

  function debouncedCotizar() {
    clearTimeout(tmr);
    tmr = setTimeout(() => {
      updateSeguroLocal();
      cotizarLive();
      refreshCreateButton();
    }, 250);
  }

  function clearActions() {
    elActions.innerHTML = "";
    elActions.style.display = "none";
  }

  function addActionButton(label, cls, onClick) {
    const b = document.createElement("button");
    b.className = `btn ${cls || ""}`.trim();
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", onClick);
    elActions.appendChild(b);
    elActions.style.display = "flex";
    return b;
  }

  function money2(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : "0.00";
  }

  function getCotizacionErrorMessage(data) {
    const code = String(data?.code || "").trim().toUpperCase();

    if (code === "MAX_KG_AGENCIA") {
      const maxKg = Number(data?.max_kg_agencia || 200);
      return `Carga fuera de estándar de agencia. Supera el máximo operativo de ${maxKg} kg y requiere cotización especial.`;
    }

    return String(data?.error || "No se pudo cotizar en este momento.");
  }

  async function cotizarLive() {
    const payload = payloadCotizar();

    if (!isReadyToQuote(payload)) {
      lastCotOk = false;
      resetKPIs();
      setStatus(quoteMissingMsg(), "warn");
      refreshCreateButton();
      return;
    }

    if (DEBUG) console.log("[cotizar] payload", payload);

    try {
      const r = await fetch("/guias/cotizar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token(),
        },
        body: JSON.stringify(payload),
      });

      const data = await r.json().catch(() => ({}));
      if (DEBUG) console.log("[cotizar] resp", r.status, data);

      if (!r.ok || !data.ok) {
        lastCotOk = false;
        resetKPIs();
        setStatus(`Cotización: ${getCotizacionErrorMessage(data)}`, "warn");
        refreshCreateButton();
        return;
      }

      const d = data.desglose;
      $("k_vol").textContent = Number(d.volumetrico_kg).toFixed(2);
      $("k_kgc").textContent = Number(d.kg_cobrable).toFixed(2);
      $("k_env").textContent = `$ ${Number(d.valor_envio).toFixed(2)}`;
      $("k_tot").textContent = `$ ${Number(d.total).toFixed(2)}`;
      $("valor_seguro").value = Number(d.seguro).toFixed(2);

      lastCotOk = true;
      setStatus("Cotización OK", "ok");
      refreshCreateButton();
    } catch (err) {
      lastCotOk = false;
      resetKPIs();
      setStatus("Cotización: error de red", "bad");
      if (DEBUG) console.error("[cotizar] error", err);
      refreshCreateButton();
    }
  }

  async function loadAuth() {
    const r = await fetch("/test-auth", { headers: { Authorization: "Bearer " + token() } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.ok) throw new Error(data?.error || "No autorizado");

    authUser = data.user;

    $("who").textContent =
      `${authUser?.usuario || "usuario"} • rol ${authUser?.rol || "?"} • sucursal_id ${authUser?.sucursal_id ?? "?"}`;

    $("origen_locked").value = `Sucursal ${authUser?.sucursal_id ?? "?"} (bloqueado)`;
  }

  async function loadSucursales() {
    const r = await fetch("/sucursales", { headers: { Authorization: "Bearer " + token() } });
    const data = await r.json().catch(() => ({}));

    const arr =
      Array.isArray(data) ? data :
      Array.isArray(data?.rows) ? data.rows :
      Array.isArray(data?.sucursales) ? data.sucursales : [];

    sucursales = arr
      .map((x) => ({
        id: Number(x.id),
        nombre: String(x.nombre ?? "").trim(),
        codigo: String(x.codigo ?? "").trim(),
      }))
      .filter((x) => Number.isFinite(x.id) && x.id > 0);

    const origenId = Number(authUser?.sucursal_id);
    const sel = $("sucursal_destino_id");

    sel.innerHTML = `<option value="">Seleccionar…</option>` + sucursales
      .filter((s) => s.id !== origenId)
      .map((s) => {
        const label = `${s.codigo ? s.codigo + " — " : ""}${s.nombre || "Sucursal " + s.id}`;
        return `<option value="${s.id}">${label}</option>`;
      })
      .join("");
  }

$("btnReset").addEventListener("click", (e) => {
  e.preventDefault();

  $("sucursal_destino_id").value = "";
  $("entrega_domicilio").value = "false";
  $("observaciones").value = "";

  $("remitente_nombre").value = "";
  $("remitente_tel").value = "";
  $("remitente_dni").value = "";

  $("destinatario_nombre").value = "";
  $("destinatario_tel").value = "";
  $("destinatario_dni").value = "";
  $("destinatario_dir").value = "";

  $("forma_pago").value = "ORIGEN";
  $("metodo_pago").value = "EFECTIVO";

  if ($("estado_pago")) $("estado_pago").value = "no_aplica";
  if ($("confirmar_pago")) $("confirmar_pago").checked = false;

  $("valor_declarado").value = "";
  if ($("preset_bulto")) $("preset_bulto").value = "";

  resetKPIs();
  setStatus("Listo", "");

  elItems.innerHTML = "";
  addItemRow({ bultos: 1, peso_kg: 2, largo_cm: 10, ancho_cm: 10, alto_cm: 10 });

  syncPagoUI();
  refreshCreateButton();
  debouncedCotizar();
});

  $("btnSalir").addEventListener("click", () => {
    localStorage.removeItem(LS_TOKEN);
    location.href = "/operador.html";
  });

  $("btnAddOne").addEventListener("click", (e) => {
    e.preventDefault();
    addItemRow({ bultos: 1, peso_kg: 2, largo_cm: 10, ancho_cm: 10, alto_cm: 10 });
    debouncedCotizar();
  });

  $("btnClear").addEventListener("click", (e) => {
    e.preventDefault();
    elItems.innerHTML = "";
    addItemRow({ bultos: 1, peso_kg: 2, largo_cm: 10, ancho_cm: 10, alto_cm: 10 });
    debouncedCotizar();
  });

  $("btnAddPreset").addEventListener("click", (e) => {
    e.preventDefault();
    const key = $("preset_bulto").value;
    if (!key || !PRESETS[key]) return;
    addItemRow(PRESETS[key]);
    debouncedCotizar();
  });

  $("sucursal_destino_id").addEventListener("change", debouncedCotizar);

  $("valor_declarado").addEventListener("input", debouncedCotizar);
  $("valor_declarado").addEventListener("change", debouncedCotizar);
  $("valor_declarado").addEventListener("keyup", debouncedCotizar);

  $("forma_pago").addEventListener("change", syncPagoUI);

  if ($("estado_pago")) {
    $("estado_pago").addEventListener("change", () => {
      refreshCreateButton();
    });
  }

  if ($("confirmar_pago")) {
    $("confirmar_pago").addEventListener("change", () => {
      const forma = $("forma_pago").value;
      if (forma === "ORIGEN" && $("confirmar_pago").checked) {
        setStatus("Cobro confirmado en ORIGEN", "ok");
      } else if (forma === "ORIGEN") {
        setStatus("Cobro en ORIGEN", "");
      }
      refreshCreateButton();
    });
  }

  $("entrega_domicilio").addEventListener("change", () => {
    if ($("entrega_domicilio").value === "true" && !domicilioOk()) {
      setStatus("Entrega a domicilio: completar DIRECCIÓN", "warn");
    }
    debouncedCotizar();
    refreshCreateButton();
  });

  $("destinatario_dir").addEventListener("input", refreshCreateButton);

  btnCrear.addEventListener("click", async (e) => {
    e.preventDefault();
    if (btnCrear.disabled) return;

    setStatus("Creando...", "warn");
    elOut.style.display = "none";
    clearActions();

    const destinoVal = $("sucursal_destino_id").value;
    const forma_pago = $("forma_pago").value;
    const metodo_pago = $("metodo_pago") ? $("metodo_pago").value : null;

    const payload = {
      sucursal_destino_id: destinoVal ? Number(destinoVal) : undefined,

      entrega_domicilio: $("entrega_domicilio").value === "true",
      valor_declarado: round2(num($("valor_declarado").value)),

      forma_pago,
      estado_pago: $("estado_pago") ? $("estado_pago").value : null,
      confirmar_pago: $("confirmar_pago") ? $("confirmar_pago").checked : false,

      metodo_pago: forma_pago === "ORIGEN" ? metodo_pago : null,

      remitente_nombre: $("remitente_nombre").value,
      remitente_tel: $("remitente_tel").value,
      remitente_dni: $("remitente_dni").value,

      destinatario_nombre: $("destinatario_nombre").value,
      destinatario_tel: $("destinatario_tel").value,
      destinatario_dni: $("destinatario_dni").value,
      destinatario_dir: $("destinatario_dir").value,

      observaciones: $("observaciones").value,
      items: collectItems(),

      peso_kg: 2,
      largo_cm: 0,
      ancho_cm: 0,
      alto_cm: 0,
    };

    try {
      const r = await fetch("/guias", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token() },
        body: JSON.stringify(payload),
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        setStatus("Error", "bad");
        showOut({ http: r.status, ...data });
        return;
      }

      const numGuia = data?.guia?.numero_guia || "Guía";
      const total = data?.cotizacion?.total ?? data?.guia?.monto_total ?? 0;
      const condicionPago = String(data?.guia?.condicion_pago || forma_pago || "").toUpperCase();

      if (condicionPago === "DESTINO") {
        setStatus(`${numGuia} creada ✅  Cobro en destino  Total $ ${money2(total)}`, "ok");
      } else {
        setStatus(`${numGuia} creada ✅  Total $ ${money2(total)}`, "ok");
      }

      clearActions();

      const guiaId = data?.guia?.id;

      if (guiaId) {
        addActionButton("Imprimir etiquetas", "ok", () => {
          window.open(`${location.origin}/etiqueta_batch.html?id=${encodeURIComponent(guiaId)}`, "_blank");
        });
      }

      addActionButton("Ir a bandeja", "", () => (location.href = "/operador.html"));

      if (DEBUG) {
        addActionButton("Contactar soporte (DEBUG)", "warn", () => {
          showOut(data);
          navigator.clipboard?.writeText(JSON.stringify(data, null, 2)).catch(() => {});
          setStatus("DEBUG copiado: enviá a soporte", "warn");
        });
      }
    } catch (err) {
      setStatus("Error de red", "bad");
      showOut(String(err?.message || err));
    }
  });

  (async () => {
    try {
      setStatus("Cargando…", "warn");
      resetKPIs();
      setSeguroZero();

      addItemRow({ bultos: 1, peso_kg: 2, largo_cm: 10, ancho_cm: 10, alto_cm: 10 });
      syncPagoUI();

      await loadAuth();
      await loadSucursales();

      setStatus("Listo", "");
      clearActions();
      refreshCreateButton();
    } catch (e) {
      console.error("crear_guia init error:", e);
      setStatus(String(e?.message || e), "bad");
    }
  })();
})();