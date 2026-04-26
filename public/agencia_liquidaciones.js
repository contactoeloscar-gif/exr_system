(() => {
  const $ = (id) => document.getElementById(id);

  function money(value) {
    const n = Number(value || 0);
    return n.toLocaleString("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    });
  }

  function fmtDate(value) {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleDateString("es-AR");
  }

async function api(url) {
  const token = localStorage.getItem("exr_token");

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.ok === false) {
    throw new Error(data.error || "Error cargando liquidaciones");
  }

  return data;
}

  function renderKpis(kpis) {
    $("kpiSaldoPendiente").textContent = money(kpis.saldo_pendiente);
    $("kpiPendientes").textContent = kpis.liquidaciones_pendientes || 0;
    $("kpiUltima").textContent = fmtDate(kpis.ultima_liquidacion_fecha);
    $("kpiHistorico").textContent = money(kpis.total_historico);
  }

function renderTabla(items) {
  const tbody = $("tablaLiquidaciones");

  if (!items || !items.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty">No hay liquidaciones registradas.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = items
    .map((liq) => {
      const estado = String(liq.estado || "-").toUpperCase();

      return `
        <tr>
          <td>${fmtDate(liq.fecha)}</td>
          <td>${fmtDate(liq.periodo_desde)} al ${fmtDate(liq.periodo_hasta)}</td>
          <td><span class="estado ${estado}">${estado}</span></td>
          <td>${money(liq.total_debe)}</td>
          <td>${money(liq.total_haber)}</td>
          <td>${money(liq.pagos_registrados)}</td>
          <td class="saldo">${money(liq.saldo_pendiente ?? liq.saldo)}</td>
        </tr>
      `;
    })
    .join("");
}

  async function init() {
    try {
      const data = await api("/interno/agencia/liquidaciones/resumen");

      renderKpis(data.kpis || {});
      renderTabla(data.liquidaciones || []);
    } catch (err) {
      console.error(err);

      $("tablaLiquidaciones").innerHTML = `
        <tr>
          <td colspan="5">No se pudieron cargar las liquidaciones.</td>
        </tr>
      `;
    }
  }

  init();
})();