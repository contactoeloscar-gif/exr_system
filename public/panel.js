// public/panel.js
(() => {
  const LS_TOKEN = "exr_token";
  const $ = (id) => document.getElementById(id);

  function logout() {
    localStorage.removeItem(LS_TOKEN);
    location.href = "/operador.html";
  }

  async function api(url, opts = {}) {
    const token = localStorage.getItem(LS_TOKEN);
    if (!token) throw new Error("No hay token");
    const headers = Object.assign({}, opts.headers || {}, {
      Authorization: "Bearer " + token,
    });
    const res = await fetch(url, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data?.error || "Error"), { status: res.status, data });
    return data;
  }

  async function refresh() {
    try {
      const r = await api("/test-auth");
      const u = r?.user || {};
      const rol = String(u.rol || "").toUpperCase();
      const isPriv = rol === "OWNER" || rol === "ADMIN";
      const suc = u.sucursal_id ? `S${u.sucursal_id}` : "GLOBAL";

      $("chipUser").textContent = `${u.usuario || "usuario"} • ${rol || "ROL"} • ${suc}`;

      // Ocultar tarjetas según rol
      $("cardAdmin").classList.toggle("hide", !isPriv);
      $("cardDash").classList.toggle("hide", !isPriv);
    } catch (e) {
      logout();
    }
  }

  $("btnLogout").addEventListener("click", logout);
  $("btnRefresh").addEventListener("click", refresh);

  refresh();
})();