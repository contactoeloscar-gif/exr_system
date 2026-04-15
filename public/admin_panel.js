console.log("ADMIN PANEL JS v4");

(() => {
  const LS_TOKEN = "exr_token";
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  let sucursales = [];
  let usuarios = [];
  let currentUser = null;

  function toast(title, msg, type = "") {
    let root = $(".exr-toasts");
    if (!root) {
      root = document.createElement("div");
      root.className = "exr-toasts";
      document.body.appendChild(root);
    }

    const el = document.createElement("div");
    el.className = "exr-toast";
    el.innerHTML = `<div class="t">${escapeHtml(title)}</div><div class="m">${escapeHtml(msg)}</div>`;

    if (type === "ok") el.style.borderColor = "rgba(32,201,151,.5)";
    if (type === "warn") el.style.borderColor = "rgba(255,204,0,.5)";
    if (type === "bad") el.style.borderColor = "rgba(255,92,119,.5)";

    root.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getToken() {
    return localStorage.getItem(LS_TOKEN) || "";
  }

  function logout() {
    localStorage.removeItem(LS_TOKEN);
    location.href = "/operador.html";
  }

  async function guardAdmin() {
    const token = getToken();
    if (!token) {
      location.href = "/operador.html";
      return false;
    }

    const r = await fetch("/test-auth", {
      headers: { Authorization: "Bearer " + token },
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) {
      localStorage.removeItem(LS_TOKEN);
      location.href = "/operador.html";
      return false;
    }

    const rol = String(j.user?.rol || "").toUpperCase();
    if (!(rol === "OWNER" || rol === "ADMIN")) {
      location.href = "/panel.html";
      return false;
    }

    currentUser = j.user || null;
    return true;
  }

  async function api(path, opts = {}) {
    const token = getToken();
    if (!token) throw new Error("No hay token. Iniciá sesión.");

    const headers = Object.assign({}, opts.headers || {});
    headers["Authorization"] = "Bearer " + token;
    if (opts.json) headers["Content-Type"] = "application/json";

    const res = await fetch(path, { ...opts, headers });
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json")
      ? await res.json().catch(() => ({}))
      : await res.text().catch(() => "");

    if (!res.ok) {
      const msg = data && data.error ? data.error : "HTTP " + res.status;
      throw Object.assign(new Error(msg), { status: res.status, data });
    }
    return data;
  }

  function setTab(which) {
    const suc = which === "s";
    $("#tabSuc")?.classList.toggle("active", suc);
    $("#tabUsr")?.classList.toggle("active", !suc);
    $("#paneSuc").style.display = suc ? "block" : "none";
    $("#paneUsr").style.display = suc ? "none" : "block";
  }

  function applyRoleOptions() {
    const rolSel = $("#u_rol");
    if (!rolSel) return;

    const myRole = String(currentUser?.rol || "").toUpperCase();

    [...rolSel.options].forEach((opt) => {
      const v = String(opt.value).toUpperCase();

      if (myRole === "ADMIN" && v === "OWNER") {
        opt.disabled = true;
        opt.hidden = true;
      }

      // recomendación: ADMIN tampoco crea ADMIN
      if (myRole === "ADMIN" && v === "ADMIN") {
        opt.disabled = true;
        opt.hidden = true;
      }
    });

    if (myRole === "ADMIN" && ["OWNER", "ADMIN"].includes(String(rolSel.value).toUpperCase())) {
      rolSel.value = "OPERADOR";
    }
  }

  function fillSucSelect() {
    const sel = $("#u_sucursal");
    if (!sel) return;

    sel.innerHTML =
      `<option value="">—</option>` +
      sucursales
        .map((s) => `<option value="${s.id}">${escapeHtml(s.nombre)} (${escapeHtml(s.codigo)})</option>`)
        .join("");
  }

  function renderSuc() {
    const tb = $("#s_tbody");
    if (!tb) return;

    if (!sucursales.length) {
      tb.innerHTML = `<tr><td colspan="6" class="exr-muted">Sin sucursales.</td></tr>`;
      $("#s_msg").textContent = "Sucursales: 0";
      return;
    }

    tb.innerHTML = sucursales.map((s) => `
      <tr>
        <td class="exr-mono"><b>${s.id}</b></td>
        <td><b>${escapeHtml(s.nombre || "—")}</b></td>
        <td class="exr-mono">${escapeHtml(s.codigo || "—")}</td>
        <td>${escapeHtml(s.tipo || "—")}</td>
        <td>${escapeHtml(s.direccion || "")}</td>
        <td>${s.activa ? `<span class="badge ok">Activa</span>` : `<span class="badge bad">Inactiva</span>`}</td>
      </tr>
    `).join("");

    $("#s_msg").textContent = `Sucursales: ${sucursales.length}`;
  }

  function renderUsr() {
    const tb = $("#u_tbody");
    if (!tb) return;

    if (!usuarios.length) {
      tb.innerHTML = `<tr><td colspan="7" class="exr-muted">Sin usuarios.</td></tr>`;
      $("#u_msg").textContent = "Usuarios: 0";
      return;
    }

    const sucMap = new Map(sucursales.map((s) => [String(s.id), s]));

    tb.innerHTML = usuarios.map((u) => {
      const s = u.sucursal_id ? sucMap.get(String(u.sucursal_id)) : null;
      const sucTxt = u.sucursal_id ? `${s?.nombre || "Sucursal"} (#${u.sucursal_id})` : "— (global)";
      const activo = u.activo
        ? `<span class="badge ok">Activo</span>`
        : `<span class="badge bad">Bloqueado</span>`;

      const btn = u.activo
        ? `<button class="exr-pro-btn bad" data-act="toggle" data-id="${u.id}" data-next="0">Desactivar</button>`
        : `<button class="exr-pro-btn" data-act="toggle" data-id="${u.id}" data-next="1">Activar</button>`;

      return `
        <tr>
          <td class="exr-mono"><b>${u.id}</b></td>
          <td class="exr-mono">${escapeHtml(u.usuario || "—")}</td>
          <td><span class="badge">${escapeHtml(u.rol || "—")}</span></td>
          <td>${escapeHtml(sucTxt)}</td>
          <td>${escapeHtml(u.email || "")}</td>
          <td>${activo}</td>
          <td>${btn}</td>
        </tr>
      `;
    }).join("");

    $$("button[data-act='toggle']", tb).forEach((b) => {
      b.addEventListener("click", async () => {
        const id = Number(b.dataset.id);
        const next = b.dataset.next === "1";
        b.disabled = true;

        try {
          await api(`/admin/usuarios/${id}/activo`, {
            method: "PATCH",
            json: true,
            body: JSON.stringify({ activo: next }),
          });

          toast("OK", `Usuario #${id} ${next ? "activado" : "desactivado"}`, "ok");
          await loadAll();
        } catch (e) {
          toast("Error", e.message, "bad");
        } finally {
          b.disabled = false;
        }
      });
    });

    $("#u_msg").textContent = `Usuarios: ${usuarios.length}`;
  }

  function enforceSucursalRule() {
    const rol = $("#u_rol")?.value || "OPERADOR";
    const sel = $("#u_sucursal");
    if (!sel) return;

    const isOwner = String(rol).toUpperCase() === "OWNER";
    sel.disabled = isOwner;

    if (isOwner) {
      sel.value = "";
    }
  }

  async function loadSucursalesSafe() {
    try {
      const s = await api("/admin/sucursales");
      if (Array.isArray(s)) return s;
      if (Array.isArray(s?.sucursales)) return s.sucursales;
      if (Array.isArray(s?.rows)) return s.rows;
    } catch (e) {
      console.warn("Fallo /admin/sucursales, intento /sucursales", e.message);
    }

    const s2 = await api("/sucursales");
    if (Array.isArray(s2)) return s2;
    if (Array.isArray(s2?.sucursales)) return s2.sucursales;
    if (Array.isArray(s2?.rows)) return s2.rows;
    return [];
  }

  async function loadUsuariosSafe() {
    const u = await api("/admin/usuarios");
    if (Array.isArray(u)) return u;
    if (Array.isArray(u?.usuarios)) return u.usuarios;
    if (Array.isArray(u?.rows)) return u.rows;
    return [];
  }

  async function loadAll() {
    try {
      const me = await api("/test-auth");
      currentUser = me?.user || {};
      $("#userChip").textContent =
        `${currentUser.usuario || "usuario"} • ${currentUser.rol || "ROL"} ${
          currentUser.sucursal_id ? "• S" + currentUser.sucursal_id : "• Global"
        }`;
    } catch {
      return logout();
    }

    sucursales = await loadSucursalesSafe();
    renderSuc();
    fillSucSelect();

    usuarios = await loadUsuariosSafe();
    renderUsr();

    applyRoleOptions();
    enforceSucursalRule();

    console.log("ADMIN loadAll", {
      sucursales,
      usuarios,
      rol_actual: currentUser?.rol,
      select_disabled: $("#u_sucursal")?.disabled,
      select_value: $("#u_sucursal")?.value,
    });
  }

  async function crearSucursal() {
    const nombre = $("#s_nombre").value.trim();
    const codigo = $("#s_codigo").value.trim();
    const tipo = $("#s_tipo").value;
    const direccion = $("#s_direccion").value.trim();

    if (!nombre || !codigo) {
      toast("Faltan datos", "Nombre y código son obligatorios.", "warn");
      return;
    }

    await api("/admin/sucursales", {
      method: "POST",
      json: true,
      body: JSON.stringify({ nombre, codigo, tipo, direccion }),
    });

    toast("OK", "Sucursal creada", "ok");
    $("#s_nombre").value = "";
    $("#s_codigo").value = "";
    $("#s_direccion").value = "";
    await loadAll();
  }

  async function crearUsuario() {
    const nombre = $("#u_nombre").value.trim();
    const email = $("#u_email").value.trim();
    const usuario = $("#u_usuario").value.trim();
    const rol = $("#u_rol").value;
    const sucursal_id_raw = $("#u_sucursal").value;
    const password = $("#u_pass").value;

    const myRole = String(currentUser?.rol || "").toUpperCase();

    if (!nombre || !email || !usuario || !password || !rol) {
      toast("Faltan datos", "nombre/email/usuario/password/rol son obligatorios.", "warn");
      return;
    }

    if (myRole === "ADMIN" && String(rol).toUpperCase() === "OWNER") {
      toast("No permitido", "Un ADMIN no puede crear usuarios OWNER.", "bad");
      return;
    }

    if (myRole === "ADMIN" && String(rol).toUpperCase() === "ADMIN") {
      toast("No permitido", "Un ADMIN no puede crear usuarios ADMIN.", "bad");
      return;
    }

    const sucursal_id = sucursal_id_raw ? Number(sucursal_id_raw) : null;
    if (rol !== "OWNER" && !sucursal_id) {
      toast("Sucursal requerida", "Para roles no-OWNER asigná sucursal.", "warn");
      return;
    }

    await api("/admin/usuarios", {
      method: "POST",
      json: true,
      body: JSON.stringify({
        nombre,
        email,
        usuario,
        rol,
        sucursal_id,
        password,
        activo: true,
      }),
    });

    toast("OK", "Usuario creado", "ok");
    $("#u_nombre").value = "";
    $("#u_email").value = "";
    $("#u_usuario").value = "";
    $("#u_pass").value = "";
    $("#u_rol").value = "OPERADOR";
    $("#u_sucursal").value = "";

    enforceSucursalRule();
    await loadAll();
  }

  $("#tabSuc")?.addEventListener("click", () => setTab("s"));
  $("#tabUsr")?.addEventListener("click", () => setTab("u"));

  $("#btnReload")?.addEventListener("click", () => {
    loadAll().catch((e) => toast("Error", e.message, "bad"));
  });

  $("#btnLogout")?.addEventListener("click", logout);

  $("#btnCrearSucursal")?.addEventListener("click", () => {
    crearSucursal().catch((e) => toast("Error", e.message, "bad"));
  });

  $("#btnCrearUsuario")?.addEventListener("click", () => {
    crearUsuario().catch((e) => toast("Error", e.message, "bad"));
  });

  $("#u_rol")?.addEventListener("change", enforceSucursalRule);

  (async () => {
    const ok = await guardAdmin();
    if (!ok) return;

    applyRoleOptions();
    enforceSucursalRule();

    loadAll().catch((e) => {
      console.error(e);
      toast("Error", e.message, "bad");
    });
  })();
})();