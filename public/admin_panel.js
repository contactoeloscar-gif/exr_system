console.log("ADMIN PANEL JS v1");

(() => {
  const LS_TOKEN = "exr_token";
  const $ = (id) => document.getElementById(id);

  async function api(url, opts = {}) {
    const token = localStorage.getItem(LS_TOKEN);
    if (!token) throw new Error("No hay token. Iniciá sesión.");
    const r = await fetch(url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(opts.headers || {}),
      },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Error API");
    return j;
  }

  function jwtPayload() {
    try {
      const t = localStorage.getItem(LS_TOKEN);
      if (!t) return null;
      return JSON.parse(atob(t.split(".")[1]));
    } catch {
      return null;
    }
  }

  function renderSucursales(rows) {
    const tb = $("tbl_suc");
    tb.innerHTML = "";
    (rows || []).forEach((s) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${s.id}</td><td><b>${s.codigo}</b></td><td>${s.nombre}</td><td>${s.tipo}</td><td>${s.activa !== false ? "Sí" : "No"}</td>`;
      tb.appendChild(tr);
    });
    if (!rows || rows.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="5" class="muted">Sin sucursales</td>`;
      tb.appendChild(tr);
    }
  }

  function renderUsuarios(rows) {
    const tb = $("tbl_usr");
    tb.innerHTML = "";
    (rows || []).forEach((u) => {
      const suc = u.sucursal_nombre ? `${u.sucursal_nombre}` : (u.sucursal_id == null ? "GLOBAL" : `#${u.sucursal_id}`);
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${u.id}</td><td><b>${u.usuario}</b></td><td>${u.rol}</td><td>${suc}</td><td>${u.activo === false ? "No" : "Sí"}</td>`;
      tb.appendChild(tr);
    });
    if (!rows || rows.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="5" class="muted">Sin usuarios</td>`;
      tb.appendChild(tr);
    }
  }

  function fillSucursalSelect(rows) {
    const sel = $("u_sucursal");
    if (!sel) return;
    const first = sel.querySelector("option")?.outerHTML || `<option value="">Seleccionar…</option>`;
    sel.innerHTML = first;
    (rows || []).forEach((s) => {
      const opt = document.createElement("option");
      opt.value = String(s.id);
      opt.textContent = `${s.codigo} - ${s.nombre}`;
      sel.appendChild(opt);
    });
  }

  async function refresh() {
    const me = jwtPayload();
    if ($("me")) $("me").textContent = me ? `${me.usuario} (${me.rol})` : "-";

    const suc = await api("/admin/sucursales");
    renderSucursales(suc.sucursales);
    fillSucursalSelect(suc.sucursales);

    const usr = await api("/admin/usuarios");
    renderUsuarios(usr.usuarios);
  }

  async function crearSucursal() {
    const body = {
      nombre: $("s_nombre").value,
      codigo: $("s_codigo").value,
      tipo: $("s_tipo").value,
      direccion: $("s_dir").value,
      activa: true,
    };
    await api("/admin/sucursales", { method: "POST", body: JSON.stringify(body) });
    await refresh();
    alert("Sucursal creada");
  }

  async function crearUsuario() {
    const rol = $("u_rol").value;
    const sucursal_id = $("u_sucursal").value || null;

    const body = {
      nombre: $("u_nombre").value,
      usuario: $("u_usuario").value,
      email: $("u_email").value,
      password: $("u_password").value,
      rol,
      sucursal_id: rol === "OWNER" ? null : sucursal_id,
      activo: true,
    };
    await api("/admin/usuarios", { method: "POST", body: JSON.stringify(body) });
    await refresh();
    alert("Usuario creado");
  }

  $("refreshBtn")?.addEventListener("click", () => refresh().catch((e) => alert(e.message)));
  $("crearSucursalBtn")?.addEventListener("click", () => crearSucursal().catch((e) => alert(e.message)));
  $("crearUsuarioBtn")?.addEventListener("click", () => crearUsuario().catch((e) => alert(e.message)));

  refresh().catch((e) => alert(e.message));
})();
