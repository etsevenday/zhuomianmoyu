// 联机传输：页面只认这一层，事件和命令两种来源同一种 JSON。
// - PC（B10）：外壳里的 Steam 小程序（window.moyuPc.net），总是打开；Steam 没就绪时小程序报 steam {ready:false}。
// - 网页（B9）：本机回环（验收脚本起的假房间服务，tools/verify/relay.mjs），只有网址带 ?net=http://127.0.0.1:端口（或 localhost）才打开；
//   别的地址一律不连，正常网页和 B3 的模拟房间不受影响。
window.moyuNet = (() => {
  let es = null, dotnet = null, relay = null, self = null, chain = Promise.resolve(), pcSubscribed = false;
  const pc = () => window.moyuPc?.net;

  function config() {
    const ver = document.querySelector('meta[name="app-build"]')?.content || '';
    if (pc()) return { pc: true, name: '', ver };
    const q = new URLSearchParams(location.search);
    const net = q.get('net');
    if (!net) return null;
    try {
      const u = new URL(net);
      if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) return null;
      return { relay: u.origin, name: q.get('name') || 'me', ver };
    } catch { return null; }
  }

  return {
    /** 联机配置的 JSON 文字；没打开联机为 null。 */
    config: () => { const c = config(); return c ? JSON.stringify(c) : null; },
    /** 连上服务；事件逐条交给 .NET（OnNet）。断了（服务关掉、被拔网线）送一条 disconnected，不自动重连。 */
    start(ref, url, name) {
      dotnet = ref;
      if (pc()) {
        if (!pcSubscribed) {
          pcSubscribed = true;
          pc().onEvent(json => dotnet.invokeMethodAsync('OnNet', json));
        }
        pc().start();
        return;
      }
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
      if (pc()) return pc().cmd(json); // 小程序知道本人是谁
      const c = JSON.parse(json);
      c.user = self;
      const body = JSON.stringify(c);
      chain = chain.then(() => fetch(`${relay}/cmd`, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } })).catch(() => { });
    },
  };
})();
