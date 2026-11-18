// B4 PC 窗口验收：node tools/verify/b4.mjs [--release] [输出目录]
// ① 直接调用外壳的窗口尺寸计算（pc/src/layout.js），按 05 §6.1 的数字例子核对；
// ② 把网页发布成 Release 包（pc/build-web.mjs），以测试模式启动 Electron，经 CDP 连渲染页操作，
//    用外壳的测试入口 window.moyuPc.test 读窗口位置、穿透、置顶、焦点，换成虚构显示器触发换屏、拔屏、改分辨率。
// PC 包本来就是 Release 发布，--release 只为和其他批次的命令一致。每次启动都用新的数据目录（除非用例要重启恢复）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PC = path.join(REPO, 'pc');
const L = createRequire(import.meta.url)(path.join(PC, 'src', 'layout.js'));
const ELECTRON = path.join(PC, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'moyu-b4'));
const PORT = Number(process.env.PLAYTEST_PORT || 9351);
fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail !== '' ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

// 显示器：bounds 是整块屏，workArea 去掉任务栏（48）
const disp = (id, x, y, w, h, primary = false, wa = null) =>
  ({ id, bounds: { x, y, width: w, height: h }, workArea: wa || { x, y, width: w, height: h - 48 }, primary });
const ONE = [disp('A', 0, 0, 1920, 1080, true)];

// ───── ① 窗口尺寸计算 ─────
function layoutChecks() {
  {
    const big = disp('A', 0, 0, 2560, 1440, true), small = disp('B', 2560, 0, 1920, 1080);
    const s = L.sFromWidth(800, big);
    const there = L.targetSize(s, small), back = L.targetSize(s, big);
    check('B4-01 2560 屏上 800×450 → s=0.3125；1920 屏 600×337.5；回原屏 800×450',
      s === 0.3125 && there.width === 600 && there.height === 337.5 && back.width === 800 && back.height === 450, { s, there, back });
  }
  {
    const s = 1 / 4;
    const small = L.targetSize(s, disp('A', 0, 0, 1280, 720, true)), big = L.targetSize(s, disp('B', 0, 0, 1920, 1080));
    const restored = L.restore({ s }, [disp('A', 0, 0, 1280, 720, true)]);
    check('B4-02 1280×720 上 s=1/4 显示 400×225、s 仍 1/4；1920×1080 上 480×270',
      small.width === 400 && small.height === 225 && restored.settings.s === 0.25 && big.width === 480 && big.height === 270, { small, big, s: restored.settings.s });
  }
  {
    const rows = [[1920, 1200], [1280, 1024], [3440, 1440]].map(([w, h]) => {
      const d = disp('A', 0, 0, w, h, true);
      const t = L.targetSize(1 / 4, d);
      return { screen: `${w}×${h}`, B: L.baseWidth(d), w: t.width, ratio: t.width / t.height };
    });
    check('B4-03 非 16:9 屏：基准宽 1920/1280/2560，窗口宽 480/400/640，都是 16:9',
      rows.map(r => r.B).join() === '1920,1280,2560' && rows.map(r => r.w).join() === '480,400,640' && rows.every(r => near(r.ratio, 16 / 9, 1e-9)), rows);
  }
  {
    const r = L.restore({}, ONE);
    check('B4-04 没有窗口设置：s=1/4，480×270，放在工作区右下', r.settings.s === 0.25 && r.bounds.width === 480 && r.bounds.height === 270
      && r.bounds.x === 1920 - 480 - 24 && r.bounds.y === 1032 - 270 - 24, r);
  }
  {
    const d = disp('A', 0, 0, 2560, 1440, true, { x: 100, y: 50, width: 600, height: 300 });
    const t = L.targetSize(1 / 4, d);
    const tiny = disp('A', 0, 0, 2560, 1440, true, { x: 100, y: 50, width: 300, height: 150 });
    const t2 = L.targetSize(1 / 4, tiny);
    const pos = L.clampPos(500, 400, t2, tiny.workArea);
    const r = L.restore({ s: 1 / 4 }, [d]);
    check('B4-05 工作区 600×300：显示 533⅓×300、s 不变；比下限还小时仍 400×225、留在可用边界',
      near(t.width, 1600 / 3, 1e-9) && t.height === 300 && r.settings.s === 0.25 && t2.width === 400 && t2.height === 225 && pos.x === 100 && pos.y === 50,
      { t, t2, pos });
  }
  {
    const A = disp('A', 0, 0, 1920, 1080, true), Bn = disp('B', -1920, -200, 1920, 1080);
    const onB = L.restore({ displayId: 'B', rx: 0.5, ry: 0.25, s: 1 / 4 }, [A, Bn]);
    const gone = L.restore({ displayId: 'B', rx: 0.5, ry: 0.25, s: 1 / 4 }, [A]);
    const edge = L.restore({ displayId: 'A', rx: 0.95, ry: 0.95, s: 0.5 }, [A]);
    check('B4-06 原屏在用原屏（负坐标）、不在用主屏；按工作区相对位置放；出界的轴平移回来不锁底',
      onB.display.id === 'B' && onB.bounds.x === -1920 + 960 && onB.bounds.y === -200 + 0.25 * 1032
      && gone.display.id === 'A' && gone.bounds.x === 960 && gone.bounds.y === 0.25 * 1032
      && edge.bounds.x === 1920 - 960 && edge.bounds.y === 1032 - 540,
      { onB: onB.bounds, gone: gone.bounds, edge: edge.bounds });
  }
  {
    const wa = ONE[0].workArea, start = { x: 100, y: 100, width: 480, height: 270 };
    const bigger = L.resizeWidth(start, 160, 90, wa);
    const tooSmall = L.resizeWidth(start, -400, -225, wa);
    const tooBig = L.resizeWidth(start, 5000, 5000, wa);
    check('B4-07 缩放：对角拖 +160 → 640；拖小停在 400；拖大停在工作区内能放下的最大 16:9（右下角不出界）',
      bigger === 640 && tooSmall === 400 && near(tooBig, Math.min(1920 - 100, (1032 - 100) * 16 / 9), 1e-9), { bigger, tooSmall, tooBig });
  }
  {
    const bad = ['不是 JSON', 'null', '[]', '{"s":"x","rx":1}', JSON.stringify({ s: -1, rx: NaN, ry: 0.2, displayId: {} }), '{"s":1e9,"rx":2,"ry":-1}', '{"displayId":"不认识的屏","s":0.25}'];
    const rs = bad.map(t => L.restore(L.parseSettings(t), ONE));
    check('B4-08 坏的窗口设置逐项回落：初始 480×270、主屏、默认位置',
      rs.every(r => r.display.id === 'A' && r.bounds.width === 480 && r.bounds.x === 1416 && r.bounds.y === 738), rs.map(r => r.bounds));
  }
}

// ───── ② Electron ─────
function buildWeb() {
  const r = spawnSync(process.execPath, [path.join(PC, 'build-web.mjs')], { cwd: PC, encoding: 'utf8', stdio: 'inherit' });
  if (r.status !== 0) throw new Error('网页发布失败');
}

/**
 * 启动一次外壳；返回渲染页的 CDP 会话。input：先写进数据目录的后台输入偏好（B5）。B4 只测窗口，
 * 默认按"玩家关过"启动，免得系统层面的输入混进来；传 null 不写，用外壳自己的默认。
 */
async function launch({ userData, displays = ONE, port = PORT, env = {}, input = { on: false, chosen: true } } = {}) {
  if (input) fs.writeFileSync(path.join(userData, 'input.json'), JSON.stringify({ version: 1, introShown: false, ...input }));
  const proc = spawn(ELECTRON, [PC, `--remote-debugging-port=${port}`], {
    env: { ...process.env, MOYU_TEST: '1', MOYU_USER_DATA: userData, MOYU_FAKE_DISPLAYS: JSON.stringify(displays), ...env },
    stdio: 'ignore',
  });
  const exited = new Promise(r => proc.once('exit', code => r(code)));
  let ws, msgId = 0;
  const waiters = new Map();
  const errors = [];
  for (let i = 0; i < 120 && !ws; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
    } catch { ws = null; await sleep(250); }
  }
  if (!ws) throw new Error('连不上 Electron');
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value ?? a.description).join(' '));
    const w = d.id && waiters.get(d.id);
    if (w) { waiters.delete(d.id); d.error ? w.bad(new Error(d.error.message)) : w.ok(d.result); }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, bad) => {
    const i = ++msgId;
    waiters.set(i, { ok, bad });
    ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
  });
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    target = (await send('Target.getTargets')).targetInfos.find(t => t.type === 'page' && t.url.startsWith('moyu://'));
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('没找到小窗页面');
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  await s('Runtime.enable');
  const ev = async expr => {
    const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expr, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await ev(expr).catch(() => false)) return true; await sleep(100); }
    return false;
  };
  const mouse = (type, x, y, buttons = 0) => s('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: 1, pointerType: 'mouse',
  });
  const p = {
    proc, exited, errors, ev, waitFor, send: s,
    state: () => ev('window.moyuPc.test.state()'),
    T: expr => ev(`window.__t.${expr}`),
    async move(pt) { await mouse('mouseMoved', pt.x, pt.y); await sleep(120); },
    async click(pt, settle = 400) {
      await mouse('mouseMoved', pt.x, pt.y);
      await mouse('mousePressed', pt.x, pt.y, 1);
      await mouse('mouseReleased', pt.x, pt.y);
      await sleep(settle);
    },
    async btn(text) {
      const pt = await ev(`window.__t.center(window.__t.btn(${JSON.stringify(text)}))`);
      if (!pt) throw new Error('找不到按钮：' + text);
      await p.click(pt);
    },
    /**
     * 真实指针拖动。窗口在动时页面坐标跟着变：每一步按"指针在屏幕上的位置 − 窗口现在的位置"换算成页面坐标，
     * 和真人拖动时页面收到的一样。合成事件的屏幕坐标按页面记着的窗口位置算，而页面要晚一点才知道窗口挪了，
     * 所以每步都等外壳里的窗口到位、页面的 screenX/screenY 也对上了再走下一步。follows：窗口应跟着指针走。
     * 返回拖动前后的窗口矩形。
     */
    async drag(pt, dx, dy, { steps = 8, release = true, beforeRelease, follows = true } = {}) {
      const settled = async want => {
        let b;
        for (let i = 0; i < 60; i++) {
          b = (await p.state()).bounds;
          const [sx, sy] = await ev('[screenX, screenY]');
          if (sx === b.x && sy === b.y && (!want || (near(b.x, want.x, 1) && near(b.y, want.y, 1)))) return b;
          await sleep(25);
        }
        return b;
      };
      const b0 = await settled();
      const screenX = b0.x + pt.x, screenY = b0.y + pt.y;
      await mouse('mouseMoved', pt.x, pt.y);
      await mouse('mousePressed', pt.x, pt.y, 1);
      let b = b0;
      for (let i = 1; i <= steps; i++) {
        await mouse('mouseMoved', screenX + dx * i / steps - b.x, screenY + dy * i / steps - b.y, 1);
        b = await settled(follows && { x: b0.x + dx * i / steps, y: b0.y + dy * i / steps });
      }
      if (beforeRelease) await beforeRelease();
      if (release) await mouse('mouseReleased', screenX + dx - b.x, screenY + dy - b.y);
      await sleep(400);
      return { before: b0, after: (await p.state()).bounds };
    },
    /**
     * 右下角缩放。CDP 合成的指针事件落到视口外就送不到页面（真实鼠标有系统捕获，不受影响），
     * 所以从热区里离边 7、5 像素处按下，每步不超过 5 像素，指针始终留在跟着变大的窗口里。
     */
    async resize(dx, dy, opts = {}) {
      const pt = await p.ev(`({ x: innerWidth - 7, y: innerHeight - 5 })`);
      const steps = Math.max(2, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 5));
      return p.drag(pt, dx, dy, { steps, follows: false, ...opts });
    },
    async key(k, code, vk) {
      await s('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
      await s('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
    },
    async shot(name) {
      await s('Page.enable');
      const r = await s('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, 'screenshots', name + '.png'), Buffer.from(r.data, 'base64'));
    },
    /** 点游戏里的关闭：存档后退出，等进程结束。 */
    async closeByButton() {
      await p.btn('关闭').catch(() => { });
      return Promise.race([exited, sleep(10000).then(() => 'timeout')]);
    },
    kill() { try { ws.close(); } catch { } proc.kill(); return exited; },
  };
  await s('Runtime.evaluate', { expression: HELPERS });
  if (!(await waitFor(`!!window.moyuDev && !!(document.querySelector('#pet') || document.querySelector('#avatar')) && (!document.querySelector('[data-stat=save]') || document.querySelector('[data-stat=save]').innerText.trim() === '已保存')`, 40000)))
    throw new Error('小窗没有载入');
  await sleep(500);
  return p;
}

const HELPERS = `window.__t = {
  center(el) { if (typeof el === 'string') el = document.querySelector(el); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; },
  rect(sel) { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; },
  btn(text) { return [...document.querySelectorAll('button')].find(b => b.offsetParent !== null && (b.title === text || (b.innerText || '').trim() === text)); },
  scene(x, y) { const r = document.querySelector('svg.scene').getBoundingClientRect(); return { x: r.left + x / 1600 * r.width, y: r.top + y / 900 * r.height }; },
  blankAt(x, y) { const e = document.elementFromPoint(x, y); return !e || e === document.documentElement || e === document.body || e.classList.contains('pc-root'); },
  blank() {
    for (let fy = 0.08; fy < 0.6; fy += 0.04) for (let fx = 0.1; fx < 0.9; fx += 0.04) {
      const x = innerWidth * fx, y = innerHeight * fy;
      if (this.blankAt(x, y) && this.blankAt(x + 6, y) && this.blankAt(x, y + 6)) return { x, y };
    }
    return null;
  },
  prefs() { try { return JSON.parse(localStorage.getItem('moyu.prefs.v1') || 'null'); } catch { return 'bad'; } },
  save() { return document.querySelector('[data-stat=save]')?.innerText.trim() ?? null; },
  bear() { const g = document.querySelector('svg.scene g.bear'); if (!g) return null; const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(g.getAttribute('transform')); return { x: +m[1], y: +m[2] }; },
  hit(kind) {
    const e = document.querySelector('[data-hit=' + kind + ']'); if (!e) return null; const r = e.getBoundingClientRect();
    for (let fy = 0.5; fy < 0.95; fy += 0.05) for (let fx = 0.5, k = 0; k < 18; k++, fx = 0.5 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.05) {
      const x = r.left + fx * r.width, y = r.top + fy * r.height, h = document.elementFromPoint(x, y)?.closest('[data-hit]');
      if (h && h.getAttribute('data-hit') === kind) return { x, y };
    }
    return null;
  },
  panels() { return [...document.querySelectorAll('#pet .panel, #pet .popup')].length; },
};`;

async function profile(p) {
  const j = await p.ev('window.moyuDev.profile()');
  return { inputs: j.LifetimeInputs, coins: j.Coins, fish: (j.Fish || j.Basket || []).length, raw: j };
}

const tmpData = name => fs.mkdtempSync(path.join(os.tmpdir(), `moyu-b4-${name}-`));
const sizeOk = (b, w, h, tol = 1) => near(b.width, w, tol) && near(b.height, h, tol);

async function electronChecks() {
  // ── 一次启动做大部分窗口用例 ──
  const dataMain = tmpData('main');
  let p = await launch({ userData: dataMain });
  try {
    {
      const st = await p.state();
      const page = await p.ev(`({ bg: getComputedStyle(document.body).backgroundColor, html: getComputedStyle(document.documentElement).backgroundColor,
        fake: ['.desktop', '.taskbar', '#notepad', '.placeholder-note', '.dev-strip'].filter(s => document.querySelector(s)),
        pet: window.__t.rect('#pet'), iw: innerWidth, ih: innerHeight, build: document.querySelector('meta[name=app-build]')?.content })`);
      await p.shot('20-pc-window');
      check('B4-20 透明无框：背景透明、没有假桌面和说明；小窗填满 480×270 的 16:9 窗口',
        page.bg === 'rgba(0, 0, 0, 0)' && page.html === 'rgba(0, 0, 0, 0)' && page.fake.length === 0 && JSON.stringify(st.content) === JSON.stringify(st.bounds) && !st.resizable
        && sizeOk(st.bounds, 480, 270) && near(page.pet.w, page.iw, 1) && near(page.pet.h, page.ih, 1) && near(page.iw / page.ih, 16 / 9, 0.02),
        { page, bounds: st.bounds, content: st.content, resizable: st.resizable });
      build = page.build;
    }

    // B4-21 分区穿透
    {
      const blank = await p.T('blank()');
      const ignoreAt = async pt => { await p.move(pt); return (await p.state()).ignoring; };
      const pts = await p.ev(`(() => { const c = window.__t.center;
        const tops = [...document.querySelectorAll('#pet .topbar button')].map(b => b.getBoundingClientRect());
        let gap = null; for (let i = 1; i < tops.length && !gap; i++) if (tops[i].left - tops[i - 1].right >= 2) { const x = (tops[i].left + tops[i - 1].right) / 2, y = (tops[i].top + tops[i].bottom) / 2; if (window.__t.blankAt(x, y)) gap = { x, y }; }
        return { bear: window.__t.hit('character'), water: window.__t.hit('water'), top: c(document.querySelector('#pet .topbar button')), gap }; })()`);
      const r = { blank: await ignoreAt(blank), bear: await ignoreAt(pts.bear), blank2: await ignoreAt(blank), water: await ignoreAt(pts.water), top: await ignoreAt(pts.top), gap: pts.gap && await ignoreAt(pts.gap) };
      await p.btn('鱼篓');
      const panel = await p.T(`center('#pet .panel')`);
      r.panel = await ignoreAt(panel);
      await p.btn('鱼篓');
      // 关穿透：留白也接住
      await p.btn('更多'); await p.btn('设置');
      await p.click(await p.T(`center(document.querySelectorAll('.setting-row [role=switch]')[0])`));
      await p.btn('更多');
      r.offBlank = await ignoreAt(blank);
      r.offSaved = (await p.T('prefs()'))?.Passthrough;
      await p.btn('更多'); await p.btn('设置');
      await p.click(await p.T(`center(document.querySelectorAll('.setting-row [role=switch]')[0])`));
      await p.btn('更多');
      r.onBlank = await ignoreAt(blank);
      r.onSaved = (await p.T('prefs()'))?.Passthrough;
      check('B4-21 留白和按钮间隙忽略鼠标、角色水面按钮面板接住；关穿透留白也接住，重开恢复，开关已保存',
        r.blank === true && r.blank2 === true && r.bear === false && r.water === false && r.top === false && r.gap === true && r.panel === false
        && r.offBlank === false && r.offSaved === false && r.onBlank === true && r.onSaved === true, r);
    }

    // B4-22 拖窗
    {
      const before = await profile(p), bear0 = await p.T('bear()');
      const bear = await p.T(`hit('character')`);
      const a = await p.drag(bear, -300, -150);
      const water = await p.T(`hit('water')`);
      // 拖动中取消（pointercancel）：和松手一样定下位置，不算单击
      const b = await p.drag(water, 120, 60, { release: false, beforeRelease: () => p.ev(`document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }))`) });
      const st = await p.state();
      const after = await profile(p), bear1 = await p.T('bear()');
      check('B4-22 拖角色、拖水面（含中途取消）移动原生窗口；大小不变、落点不变、计数增量 0',
        near(a.after.x - a.before.x, -300, 2) && near(a.after.y - a.before.y, -150, 2) && near(b.after.x - b.before.x, 120, 2) && near(b.after.y - b.before.y, 60, 2)
        && sizeOk(st.bounds, 480, 270) && st.gesture === null && bear0.x === bear1.x && bear0.y === bear1.y && after.inputs === before.inputs && (await p.T('panels()')) === 0,
        { a, b, bear0, bear1, inputs: [before.inputs, after.inputs] });
    }

    // B4-23 面板关后无残留热区
    {
      await p.btn('鱼篓');
      await p.btn('更多'); await p.btn('设置');
      const panel = await p.T(`center('#pet .panel')`);
      await p.move(panel);
      const open = (await p.state()).ignoring;
      await p.btn('更多');
      const blankThere = await p.T(`blankAt(${panel.x}, ${panel.y})`);
      await p.move({ x: panel.x + 1, y: panel.y });
      const closed = (await p.state()).ignoring;
      check('B4-23 面板开着时接住，关掉后原处恢复穿透', open === false && (!blankThere || closed === true), { open, blankThere, closed });
    }

    // B4-24 不抢焦点
    {
      const st0 = await p.state();
      await p.ev('window.moyuDev.injectFish(2)');
      await p.waitFor(`window.__t.save() === '已保存'`, 8000);
      await sleep(600);
      const st1 = await p.state();
      check('B4-24 出鱼、存档时小窗不变成前台、不自动开面板', st0.focused === false && st1.focused === false && (await p.T('panels()')) === 0,
        { before: st0.focused, after: st1.focused });
    }

    // B4-25 置顶
    {
      const on0 = (await p.state()).topmost;
      await p.btn('更多'); await p.btn('设置');
      await p.click(await p.T(`center(document.querySelectorAll('.setting-row [role=switch]')[2])`));
      const off = (await p.state()).topmost;
      await p.click(await p.T(`center(document.querySelectorAll('.setting-row [role=switch]')[2])`));
      const on1 = (await p.state()).topmost;
      const notes = await p.ev(`({ notes: [...document.querySelectorAll('.setting-note')].map(e => e.dataset.note),
        titles: Object.fromEntries([...document.querySelectorAll('.setting-row')].map(e => [e.dataset.setting, e.title])) })`);
      await p.btn('更多');
      // PC 输入 v0.1 §5 / 文案 05 起：两行悬停提示换成 PC 原句 TXT-PC-003、004（原来 B4 是先不显示）
      check('B4-35 PC 设置页不显示网页专属说明（置顶、后台输入是演示开关；只统计本页面输入），两行悬停提示用 PC 原句', !notes.notes.includes('demo') && !notes.notes.includes('input')
        && notes.notes.includes('help') && notes.titles.topmost === '开启后，游戏小窗会保持在其他普通窗口上方。'
        && notes.titles['background-input'] === '开启后台输入后，会统计游戏界面以外的键盘按下和鼠标点击次数，用于角色动作和捕鱼进度。', notes);
      check('B4-25 置顶默认开，开关切换真实置顶状态', on0 === true && off === false && on1 === true, { on0, off, on1 });
    }

    // B4-26 收起与恢复
    {
      const win = (await p.state()).bounds;
      await p.btn('收起');
      await sleep(300);
      const st = await p.state();
      const expect = L.avatarRect(win);
      const avatar = await p.T(`rect('#avatar')`);
      const d = await p.drag({ x: avatar.x + avatar.w / 2, y: avatar.y + avatar.h / 2 }, 200, -100);
      const still = await p.ev(`!!document.querySelector('#avatar')`);
      const a2 = await p.T(`center('#avatar')`);
      await p.click(a2, 600);
      const back = await p.state();
      const want = L.windowFromAvatar(d.after, { width: 480, height: 270 }, ONE[0].workArea);
      check('B4-26 收起成头像留在原处；拖头像不恢复；单击恢复原大小、按头像位置放',
        near(st.bounds.x, expect.x, 1) && near(st.bounds.y, expect.y, 1) && sizeOk(st.bounds, expect.width, expect.height) && avatar && near(avatar.w, st.bounds.width, 1.5)
        && near(d.after.x - d.before.x, 200, 2) && still && sizeOk(back.bounds, 480, 270) && near(back.bounds.x, want.x, 1) && near(back.bounds.y, want.y, 1) && !back.collapsed,
        { collapsed: st.bounds, expect, avatar, drag: d, back: back.bounds, want });
    }

    // B4-28 右下角缩放
    {
      const before = await profile(p), bear0 = await p.T('bear()');
      const hit = await p.ev(`document.elementFromPoint(innerWidth - 7, innerHeight - 5)?.dataset.hit`);
      await p.ev('window.moyuPc.test.drag(-600, -300, true)'); // 先离开右下边，留出放大的余地
      const s0 = (await p.state()).settings.s;
      const up = await p.resize(160, 90);
      const sUp = (await p.state()).settings.s;
      const fish = await p.ev(`[...document.querySelectorAll('svg.scene g.bear')].length`);
      const down = await p.resize(-400, -225);
      const sDown = (await p.state()).settings.s;
      // 拖动中按 Esc 取消
      let during = null;
      await p.resize(160, 90, { release: false, beforeRelease: async () => { during = (await p.state()).bounds; await p.key('Escape', 'Escape', 27); await sleep(200); } });
      await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(300);
      const st = await p.state();
      const after = await profile(p), bear1 = await p.T('bear()');
      check('B4-28 右下角热区缩放：放大 640×360、缩到下限 400×225、Esc 取消回原尺寸不改偏好；不拖窗、不开面板、落点不变、计数 0',
        hit === 'resize' && s0 === 0.25 && sizeOk(up.after, 640, 360) && up.after.x === up.before.x && up.after.y === up.before.y && near(sUp, 640 / 1920, 1e-9)
        && sizeOk(down.after, 400, 225) && near(sDown, 400 / 1920, 1e-9) && sizeOk(during, 560, 315) && sizeOk(st.bounds, 400, 225) && near(st.settings.s, sDown, 1e-12)
        && bear0.x === bear1.x && bear0.y === bear1.y && after.inputs === before.inputs && (await p.T('panels()')) === 0 && fish === 1,
        { hit, s0, up: up.after, sUp, down: down.after, sDown, during, cancelled: st.bounds, inputs: [before.inputs, after.inputs] });
    }

    // B4-33 单实例（在 B4-27 退出之前）
    {
      const second = spawn(ELECTRON, [PC], { env: { ...process.env, MOYU_TEST: '1', MOYU_USER_DATA: dataMain, MOYU_FAKE_DISPLAYS: JSON.stringify(ONE) }, stdio: 'ignore' });
      const code = await Promise.race([new Promise(r => second.once('exit', r)), sleep(10000).then(() => 'timeout')]);
      if (code === 'timeout') second.kill();
      await sleep(300);
      const st = await p.state();
      check('B4-33 再启动一次：第二个进程直接退出，原窗口收到并显示', code !== 'timeout' && st.stats.secondInstance === 1 && st.visible, { code, stats: st.stats });
    }

    // B4-27 关闭即退出（先存档）
    {
      await p.ev('window.moyuDev.addCoins(100)');
      const prof = await profile(p);
      const errs = [...p.errors];
      const code = await p.closeByButton();
      p = await launch({ userData: dataMain });
      const again = await profile(p);
      check('B4-27 点关闭先存档再退出程序；重启后金币和鱼都在', code !== 'timeout' && again.coins === prof.coins && again.fish === prof.fish && again.coins >= 100,
        { code, coins: [prof.coins, again.coins], fish: [prof.fish, again.fish], errs });
    }

    // B4-29 重启恢复（上面退出前缩放到 400×225 并拖过位置）
    {
      const st = await p.state();
      const file = JSON.parse(st.settingsFile);
      const want = L.restore(L.parseSettings(st.settingsFile), ONE).bounds;
      check('B4-29 重启按保存的 s 和相对位置恢复', sizeOk(st.bounds, 400, 225) && near(st.bounds.x, want.x, 1) && near(st.bounds.y, want.y, 1) && near(file.s, 400 / 1920, 1e-9),
        { bounds: st.bounds, want, file });
    }

    // B4-32 本机存档：窗口设置和玩法存档分开
    {
      const st = await p.state();
      const files = fs.readdirSync(st.userData);
      const settingsText = st.settingsFile;
      check('B4-32 窗口设置 window.json 和玩法存档（IndexedDB、Local Storage）分开存，设置里没有玩法数据',
        files.includes('window.json') && files.includes('IndexedDB') && files.includes('Local Storage') && !/coin|fish|Coins|Fish/i.test(settingsText),
        { files, settingsText });
    }
    errorsSeen.push(...p.errors);
  } finally {
    await p.kill();
  }

  // ── B4-30 换屏松手重算（虚构两块屏） ──
  {
    const two = [disp('A', 0, 0, 2560, 1440, true), disp('B', 2560, 0, 1920, 1080)];
    const q = await launch({ userData: tmpData('screens'), displays: two, port: PORT + 1 });
    try {
      const st0 = await q.state();
      await q.ev('window.moyuPc.test.drag(-800, -400, true)');
      const up = await q.resize(160, 90);
      const s = (await q.state()).settings.s;
      await q.ev('window.moyuPc.test.drag(2000, 0, false)');
      const during = (await q.state()).bounds;
      await q.ev('window.moyuPc.test.release()');
      const there = await q.state();
      await q.ev('window.moyuPc.test.drag(-2000, 0, true)');
      const back = await q.state();
      check('B4-30 2560 屏调到 800×450 拖到 1920 屏：拖动中不变、松手 600×337.5、拖回 800×450、s 不变',
        sizeOk(st0.bounds, 640, 360) && sizeOk(up.after, 800, 450) && s === 0.3125 && sizeOk(during, 800, 450)
        && sizeOk(there.bounds, 600, 337.5) && there.settings.displayId === 'B' && sizeOk(back.bounds, 800, 450) && back.settings.s === 0.3125,
        { start: st0.bounds, up: up.after, s, during, there: there.bounds, back: back.bounds });
      errorsSeen.push(...q.errors);
    } finally {
      await q.kill();
    }
  }

  // ── B4-31 拔屏、改分辨率 ──
  {
    const A = disp('A', 0, 0, 1920, 1080, true), Bn = disp('B', -1920, 0, 1920, 1080);
    const q = await launch({ userData: tmpData('unplug'), displays: [A, Bn], port: PORT + 2 });
    try {
      await q.ev('window.moyuDev.addCoins(100)');
      await q.waitFor(`window.__t.save() === '已保存'`, 8000);
      const prof0 = await profile(q);
      await q.ev('window.moyuPc.test.drag(-1800, -300, true)');
      const onB = await q.state();
      await q.ev(`window.moyuPc.test.setDisplays(${JSON.stringify([A])})`);
      const unplugged = await q.state();
      const small = disp('A', 0, 0, 1280, 720, true);
      await q.ev(`window.moyuPc.test.setDisplays(${JSON.stringify([small])})`);
      const shrunk = await q.state();
      const inside = (b, wa) => b.x >= wa.x && b.y >= wa.y && b.x + b.width <= wa.x + wa.width + 1 && b.y + b.height <= wa.y + wa.height + 1;
      const prof1 = await profile(q);
      check('B4-31 拔掉负坐标副屏移回主屏、在可用范围内；主屏改成 1280×720 显示 400×225、s 不变；资产不变',
        onB.settings.displayId === 'B' && onB.bounds.x < 0 && inside(unplugged.bounds, A.workArea) && sizeOk(unplugged.bounds, 480, 270)
        && sizeOk(shrunk.bounds, 400, 225) && inside(shrunk.bounds, small.workArea) && shrunk.settings.s === 0.25 && prof1.coins === prof0.coins && prof1.fish === prof0.fish,
        { onB: onB.bounds, unplugged: unplugged.bounds, shrunk: shrunk.bounds, s: shrunk.settings.s, coins: [prof0.coins, prof1.coins] });
      errorsSeen.push(...q.errors);
    } finally {
      await q.kill();
    }
  }

  // ── B4-08 坏的窗口设置文件（真实启动） ──
  {
    const data = tmpData('bad');
    fs.writeFileSync(path.join(data, 'window.json'), '{ 坏掉的 "s": NaN');
    const q = await launch({ userData: data, port: PORT + 3 });
    try {
      const st = await q.state();
      check('B4-08 启动时窗口设置是乱码：按初始 480×270、主屏默认位置打开，存档正常', sizeOk(st.bounds, 480, 270) && st.bounds.x === 1416 && st.bounds.y === 738
        && (await q.T('save()')) === '已保存', st.bounds);
    } finally {
      await q.kill();
    }
  }
}

// ───── 静态 ─────
function staticChecks() {
  const win = fs.readFileSync(path.join(REPO, 'web/Moyu.Web/Components/PetWindow.razor'), 'utf8');
  const desk = fs.readFileSync(path.join(REPO, 'web/Moyu.Web/Components/FakeDesktop.razor'), 'utf8');
  const guarded = /@if \(Pc\)\s*\{[^}]*class="pc-resize"/.test(win) && (win.match(/pc-resize/g) || []).length === 1;
  const onlyPc = (desk.match(/Pc="true"/g) || []).length === 1 && desk.indexOf('Pc="true"') < desk.indexOf('<div class="viewport">');
  check('B4-34 网页版没有缩放热区：热区只在 Pc 时画，Pc 只在外壳分支打开', guarded && onlyPc, { guarded, onlyPc });
}

let build = null, fatal = null;
const errorsSeen = [];
export { launch, disp, ONE, L, sleep };
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
try {
  layoutChecks();
  staticChecks();
  buildWeb();
  await electronChecks();
  check('B4 控制台没有报错', errorsSeen.length === 0, errorsSeen.slice(0, 5));
} catch (e) {
  fatal = String(e?.stack || e);
  console.error('脚本中断：', fatal);
}
const failed = results.filter(r => !r.pass).length;
const file = path.join(out, 'b4-results.json');
fs.writeFileSync(file, JSON.stringify({ build, time: new Date().toISOString(), passed: results.length - failed, failed, fatal, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} 通过${fatal ? '（脚本中断）' : ''}；构建 ${build}；结果 ${file}`);
process.exit(failed || fatal ? 1 : 0);
}
