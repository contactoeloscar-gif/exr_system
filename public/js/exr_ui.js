(() => {
  const $ = (s, el=document) => el.querySelector(s);

  function ensureToasts(){
    let root = $(".exr-toasts");
    if(!root){
      root = document.createElement("div");
      root.className = "exr-toasts";
      document.body.appendChild(root);
    }
    return root;
  }

  function toast(title, message, type=""){
    const root = ensureToasts();
    const el = document.createElement("div");
    el.className = "exr-toast";
    el.innerHTML = `
      <div class="t">${escapeHtml(title)}</div>
      <div class="m">${escapeHtml(message)}</div>
    `;
    if(type === "ok") el.style.borderColor = "rgba(32,201,151,.5)";
    if(type === "warn") el.style.borderColor = "rgba(255,204,0,.5)";
    if(type === "bad") el.style.borderColor = "rgba(255,92,119,.5)";
    root.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function escapeHtml(str){
    return String(str ?? "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  // Helper badges para estados
  function badgeEstadoLogistico(estado){
    const map = {
      RECIBIDO_ORIGEN: ["Recibido origen","warn"],
      EN_TRANSITO: ["En tránsito","warn"],
      RECIBIDO_DESTINO: ["Recibido destino","warn"],
      ENTREGADO: ["Entregado","ok"],
    };
    const [label, cls] = map[estado] || [estado || "—",""];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function badgeEstadoPago(estado){
    const map = {
      PENDIENTE: ["Pendiente","warn"],
      CONTRA_ENTREGA: ["Contra entrega","warn"],
      PAGADO: ["Pagado","ok"],
    };
    const [label, cls] = map[estado] || [estado || "—",""];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  window.EXR_UI = { toast, badgeEstadoLogistico, badgeEstadoPago };
})();
