(() => {
  const endpoint = "/v1/webhook/sdwan";
  const tbody = document.getElementById("tbody");
  const sseStatus = document.getElementById("sseStatus");
  const btnRefresh = document.getElementById("btnRefresh");
  const btnToggleSse = document.getElementById("btnToggleSse");

  let items = [];
  let es = null;

  function esc(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function rowHtml(e) {
    const payload = esc(JSON.stringify(e.body, null, 2));
    return `      <tr>        <td><code>${esc(e.id)}</code></td>        <td><code>${esc(e.receivedAt)}</code></td>        <td><code>${esc(e.sourceIp)}</code></td>        <td><pre>${payload}</pre></td>      </tr>`;
  }

  function render() {
    const html = items.map(rowHtml).join("");
    tbody.innerHTML = html || `<tr><td colspan="4">（まだデータがありません。vManage から Webhook を送ると表示されます）</td></tr>`;
  }

  async function refresh() {
    const r = await fetch(endpoint, { headers: { "Accept": "application/json" }});
    if (!r.ok) throw new Error("GET failed: " + r.status);
    const data = await r.json();
    // 新しい順で表示
    items = (data.items || []).slice().reverse();
    render();
  }

  function setSseState(connected) {
    sseStatus.textContent = connected ? "SSE: connected" : "SSE: disconnected";
    sseStatus.className = "pill " + (connected ? "ok" : "ng");
    btnToggleSse.textContent = connected ? "SSE 切断" : "SSE 接続";
  }

  function connectSse() {
    es = new EventSource(endpoint);

    es.addEventListener("open", () => setSseState(true));

    es.addEventListener("snapshot", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        items = (data.items || []).slice().reverse();
        render();
      } catch (e) {
        console.error("snapshot parse error", e);
      }
    });

    es.addEventListener("alarm", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        items.unshift(data);
        items = items.slice(0, 100);
        render();
      } catch (e) {
        console.error("alarm parse error", e);
      }
    });

    es.addEventListener("error", () => {
      // EventSource は自動再接続します
      setSseState(false);
    });
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

  // 初期：GET → SSE
  refresh().catch(console.error).finally(() => connectSse());
})();
