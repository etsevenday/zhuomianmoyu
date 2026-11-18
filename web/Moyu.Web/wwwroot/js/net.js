// 联机传输（B9）：页面只认这一层。现在只有本机回环（验收脚本起的假房间服务，tools/verify/relay.mjs），B10 换 Steam。
// 只有网址带 ?net=http://127.0.0.1:端口（或 localhost）才打开；别的地址一律不连，正常网页和 B3 的模拟房间不受影响。
window.moyuNet = (() => {
  let es = null, dotnet = null, relay = null, self = null, chain = Promise.resolve();

  function config() {
    const q = new URLSearchParams(location.search);
    const net = q.get('net');
    if (!net) return null;
    try {
      const u = new URL(net);
      if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) return null;
      const ver = document.querySelector('meta[name="app-build"]')?.content || '';
      return { relay: u.origin, name: q.get('name') || 'me', ver };
    } catch { return null; }
  }

  return {
    /** 联机配置的 JSON 文字；没打开联机为 null。 */
    config: () => { const c = config(); return c ? JSON.stringify(c) : null; },
    /** 连上服务；事件逐条交给 .NET（OnNet）。断了（服务关掉、被拔网线）送一条 disconnected，不自动重连。 */
    start(ref, url, name) {
      dotnet = ref;
      relay = url;
      es?.close();
      const s = es = new EventSource(`${relay}/events?name=${encodeURIComponent(name)}`);
      s.onmessage = e => {
        const ev = JSON.parse(e.data);
        if (ev.type === 'hello') self = ev.self;
        dotnet.invokeMethodAsync('OnNet', e.data);
      };
      s.onerror = () => {
        if (es !== s) return;
        s.close();
        es = null;
        dotnet.invokeMethodAsync('OnNet', '{"type":"disconnected"}');
      };
    },
    /** 发一条命令；按发出的先后排队送，不让后发的先到。 */
    cmd(json) {
      const c = JSON.parse(json);
      c.user = self;
      const body = JSON.stringify(c);
      chain = chain.then(() => fetch(`${relay}/cmd`, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } })).catch(() => { });
    },
    connected: () => !!es,
  };
})();
