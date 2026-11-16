// 各批浏览器验收脚本共用的底座：起无头浏览器、连 Chrome DevTools Protocol、发真实（isTrusted）键鼠事件、记结果。
// 零依赖：Node 22+ 自带 fetch/WebSocket。每次用全新的浏览器配置目录，不受旧存档影响。
// 用法见各批脚本开头；b0.mjs 早于这个底座，自带一份同样的代码。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRelease } from './release.mjs';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const near = (a, b, tol) => Math.abs(a - b) <= tol;

const CHROMES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);

/**
 * 跑一批用例。batch 是批次名（结果文件、临时目录用），helpers 是每次加载自动注入页面的脚本，
 * run(ctx) 里写用例。命令行：node <脚本> [网址|--release] [输出目录]。
 */
export async function runBatch({ batch, helpers, run, defaultUrl = 'https://etsevenday.github.io/zhuomianmoyu/' }) {
  const RELEASE = process.argv[2] === '--release';
  const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), `moyu-${batch}`));
  const PORT = Number(process.env.PLAYTEST_PORT || 9341);
  fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
  const chrome = CHROMES.find(p => fs.existsSync(p));
  if (!chrome) { console.error('找不到 Chrome/Edge，用环境变量 CHROME 指定'); process.exit(2); }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `moyu-${batch}-profile-`));
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });

  // ───── CDP ─────
  let ws, msgId = 0;
  const waiters = new Map();
  const consoleErrors = [];
  const send = (method, params = {}, sessionId) => new Promise((ok, bad) => {
    const i = ++msgId;
    waiters.set(i, { ok, bad });
    ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
  });
  async function connect() {
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
        ws = new WebSocket(list.webSocketDebuggerUrl);
        await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
        ws.onmessage = m => {
          const d = JSON.parse(m.data);
          if (d.method === 'Runtime.exceptionThrown') consoleErrors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
          if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErrors.push(d.params.args.map(a => a.value ?? a.description).join(' '));
          const w = d.id && waiters.get(d.id);
          if (w) { waiters.delete(d.id); d.error ? w.bad(new Error(d.error.message)) : w.ok(d.result); }
        };
        return;
      } catch { }
      await sleep(250);
    }
    throw new Error('连不上无头浏览器');
  }

  /** 一个标签页：浏览器级连接上的一个会话。 */
  function tab(sessionId) {
    const s = (method, params) => send(method, params, sessionId);
    const t = {
      sessionId,
      send: s,
      async ev(expr) {
        const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
      async waitFor(expr, ms = 15000) {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await t.ev(expr).catch(() => false)) return true; await sleep(100); }
        return false;
      },
      async size(w, h) { await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(300); },
      // 鼠标：按下期间的移动带 buttons，页面收到的是真实的 pointermove 拖动
      async mouse(type, x, y, { button = 'left', buttons = 0, clickCount = 1, deltaY = 0 } = {}) {
        await s('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' || type === 'mouseWheel' ? 'none' : button, buttons, clickCount, deltaX: 0, deltaY, pointerType: 'mouse' });
      },
      async clickAt(p, settle = 300, button = 'left') {
        const mask = { left: 1, right: 2, middle: 4 }[button];
        await t.mouse('mouseMoved', p.x, p.y);
        await t.mouse('mousePressed', p.x, p.y, { button, buttons: mask });
        await t.mouse('mouseReleased', p.x, p.y, { button });
        await sleep(settle);
      },
      async dblClickAt(p) {
        await t.mouse('mouseMoved', p.x, p.y);
        await t.mouse('mousePressed', p.x, p.y, { buttons: 1, clickCount: 1 });
        await t.mouse('mouseReleased', p.x, p.y, { clickCount: 1 });
        await t.mouse('mousePressed', p.x, p.y, { buttons: 1, clickCount: 2 });
        await t.mouse('mouseReleased', p.x, p.y, { clickCount: 2 });
        await sleep(400);
      },
      async dragBy(p, dx, dy, steps = 8) {
        await t.mouse('mouseMoved', p.x, p.y);
        await t.mouse('mousePressed', p.x, p.y, { buttons: 1 });
        for (let i = 1; i <= steps; i++) await t.mouse('mouseMoved', p.x + dx * i / steps, p.y + dy * i / steps, { buttons: 1 });
        await t.mouse('mouseReleased', p.x + dx, p.y + dy);
        await sleep(400);
      },
      /** 按一次键（按下 + 松开）。字母键带文字；repeat 是自动连发的按下。 */
      async key(k, { repeat = false, up = true, modifiers = 0 } = {}) {
        const named = { Enter: [13, 'Enter', '\r'], Control: [17, 'ControlLeft', ''], Shift: [16, 'ShiftLeft', ''], Process: [229, '', ''] }[k];
        const [vk, code, text] = named || [k.toUpperCase().charCodeAt(0), 'Key' + k.toUpperCase(), modifiers ? '' : k];
        await s('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, text: text || undefined, autoRepeat: repeat, modifiers });
        if (up) await s('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
      },
      async keyUp(k) {
        const vk = { Control: 17, Shift: 16 }[k] ?? k.toUpperCase().charCodeAt(0);
        await s('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: { Control: 'ControlLeft', Shift: 'ShiftLeft' }[k] ?? 'Key' + k.toUpperCase(), windowsVirtualKeyCode: vk });
      },
      /** 连按 n 次字母键。 */
      async press(n, k = 'j') { for (let i = 0; i < n; i++) await t.key(k); },
      async shot(name) {
        const r = await s('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(out, 'screenshots', name + '.png'), Buffer.from(r.data, 'base64'));
      },
    };
    return t;
  }

  async function openTab(url) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const t = tab(sessionId);
    t.targetId = targetId;
    await t.send('Runtime.enable');
    await t.send('Page.enable');
    if (helpers) await t.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers });
    if (url) await t.send('Page.navigate', { url });
    return t;
  }
  const closeTab = t => send('Target.closeTarget', { targetId: t.targetId });

  // ───── 记录 ─────
  const results = [];
  function check(name, pass, detail = '') {
    results.push({ name, pass: !!pass, detail });
    console.log(`${pass ? '✅' : '❌'} ${name}${detail !== '' ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  }

  let base = null, build = null, fatal = null, rel = null, main = null;
  try {
    if (RELEASE) rel = await startRelease();
    base = new URL(rel ? rel.url : process.argv[2] && process.argv[2] !== '--release' ? process.argv[2] : defaultUrl);
    base.searchParams.set('dev', '1');
    await connect();
    const pages = await send('Target.getTargets');
    const first = pages.targetInfos.find(t => t.type === 'page');
    const { sessionId } = await send('Target.attachToTarget', { targetId: first.targetId, flatten: true });
    main = tab(sessionId);
    main.targetId = first.targetId;
    await main.send('Runtime.enable');
    await main.send('Page.enable');
    if (helpers) await main.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers });
    await main.size(1600, 900);
    await run({ main, base, check, openTab, closeTab, consoleErrors, setBuild: b => { build = b; } });
  } catch (e) {
    fatal = String(e?.stack || e);
    console.error('脚本中断：', fatal);
    try { await main?.shot('99-fatal'); } catch { }
  } finally {
    try { ws?.close(); } catch { }
    proc.kill();
    rel?.close();
  }
  const failed = results.filter(r => !r.pass).length;
  const file = path.join(out, `${batch}-results.json`);
  fs.writeFileSync(file, JSON.stringify({ url: base?.href, build, time: new Date().toISOString(), passed: results.length - failed, failed, fatal, results }, null, 2));
  console.log(`\n${results.length - failed}/${results.length} 通过${fatal ? '（脚本中断）' : ''}；构建 ${build}；结果 ${file}`);
  process.exit(failed || fatal ? 1 : 0);
}
