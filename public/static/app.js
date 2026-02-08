(() => {
  const endpoint = "/v1/webhooks/sdwan/";
  const tbody = document.getElementById("tbody");
  const sseStatus = document.getElementById("sseStatus");
  const btnRefresh = document.getElementById("btnRefresh");
  const btnToggleSse = document.getElementById("btnToggleSse");

  let items = [];
  let es = null;

  function esc(s) {
    return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
  }

  function rowHtml(e) {
    const payload = esc(JSON.stringify(e.body, null, 2));
    return `      <tr>        <td><code>${esc(e.id)}</code></td>        <td><code>${esc(e.receivedAt)}</code></td>        <td><code>${esc(e.sourceIp)}</code></td>        <td><pre>${payload}</pre></td>      </tr>`;
  }

  function render() {
    tbody.innerHTML = items.map(rowHtml).join("") || `<tr><td colspan="4">（まだデータがありません）</td></tr>`;
  }

  async function refresh() {
    const r = await fetch(endpoint, { headers: { "Accept": "application/json" } });
    const data = await r.json();
    items = (data.items || []).slice().reverse();
    render();
  }

  function setSseState(ok) {
    sseStatus.textContent = ok ? "SSE: connected" : "SSE: disconnected";
    sseStatus.className = "pill " + (ok ? "ok" : "ng");
    btnToggleSse.textContent = ok ? "SSE 切断" : "SSE 接続";
  }

  function connectSse() {
    es = new EventSource(endpoint);
    es.addEventListener("open", () => setSseState(true));
    es.addEventListener("snapshot", (ev) => {
      const d = JSON.parse(ev.data);
      items = (d.items || []).slice().reverse();
      render();
    });
    es.addEventListener("alarm", (ev) => {
      const d = JSON.parse(ev.data);
      items.unshift(d);
      items = items.slice(0,100);
      render();
    });
    es.addEventListener("error", () => setSseState(false));
  }

  function disconnectSse() {
    if (es) es.close();
    es = null;
    setSseState(false);
  }

  btnRefresh.addEventListener("click", () => refresh().catch(console.error));
  btnToggleSse.addEventListener("click", () => {
    if (es) disconnectSse();
    else connectSse();
  });

  refresh().catch(console.error).finally(() => connectSse());
})();
