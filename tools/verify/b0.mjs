#!/usr/bin/env node
// B0 第一阶段浏览器验收：执行 doc/测试用例/B0 第一阶段.md 里方式为 B 的用例，每个 check 名以用例号开头。
// 零依赖：Node 22+ 自带 fetch/WebSocket + Chrome DevTools Protocol；每次用全新的浏览器配置目录，不受旧存档影响。
//
// 用法：
//   node tools/verify/b0.mjs [网址|--release] [输出目录]
//   --release：先照 CI 的方式发布本地 Release 包，挂在 http://127.0.0.1:5199/zhuomianmoyu/ 上测（推送前的主关卡）
//   网址默认线上 https://etsevenday.github.io/zhuomianmoyu/ ，脚本自动加 ?dev=1；开发中也可测 http://localhost:5188/
//   输出默认系统临时目录下 moyu-b0；环境变量 CHROME 指定浏览器、PLAYTEST_PORT 指定调试端口（默认 9341）
// 结果写 <输出目录>/b0-results.json，截图写 <输出目录>/screenshots/；有失败时退出码为 1。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRelease } from './release.mjs';

const RELEASE = process.argv[2] === '--release';
let base = null; // 在主流程里定：线上、给定网址或本地 Release 包
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'moyu-b0'));
const PORT = Number(process.env.PLAYTEST_PORT || 9341);
const CHROMES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ───────────── CDP ─────────────
let ws, msgId = 0;
const waiters = new Map();
const consoleErrors = [];
function send(method, params = {}) {
  return new Promise((ok, bad) => { const i = ++msgId; waiters.set(i, { ok, bad }); ws.send(JSON.stringify({ id: i, method, params })); });
}
async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page');
      if (p) {
        ws = new WebSocket(p.webSocketDebuggerUrl);
        await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
        ws.onmessage = m => {
          const d = JSON.parse(m.data);
          if (d.method === 'Runtime.exceptionThrown') consoleErrors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
          if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErrors.push(d.params.args.map(a => a.value ?? a.description).join(' '));
          const w = d.id && waiters.get(d.id);
          if (w) { waiters.delete(d.id); d.error ? w.bad(new Error(d.error.message)) : w.ok(d.result); }
        };
        return;
      }
    } catch { }
    await sleep(250);
  }
  throw new Error('连不上无头浏览器');
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expr, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev(expr).catch(() => false)) return true; await sleep(100); }
  return false;
}
async function size(w, h) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(400); }

// 鼠标：按下期间的移动带 buttons=1，这样页面收到的是真实的 pointermove 拖动
async function mouse(type, x, y, { buttons = 0, clickCount = 1 } = {}) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount, pointerType: 'mouse' });
}
async function clickAt(p, settle = 350) {
  await mouse('mouseMoved', p.x, p.y);
  await mouse('mousePressed', p.x, p.y, { buttons: 1 });
  await mouse('mouseReleased', p.x, p.y);
  await sleep(settle);
}
async function dblClickAt(p) {
  await mouse('mouseMoved', p.x, p.y);
  await mouse('mousePressed', p.x, p.y, { buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', p.x, p.y, { clickCount: 1 });
  await mouse('mousePressed', p.x, p.y, { buttons: 1, clickCount: 2 });
  await mouse('mouseReleased', p.x, p.y, { clickCount: 2 });
  await sleep(400);
}
async function dragBy(p, dx, dy, steps = 8) {
  await mouse('mouseMoved', p.x, p.y);
  await mouse('mousePressed', p.x, p.y, { buttons: 1 });
  for (let i = 1; i <= steps; i++) await mouse('mouseMoved', p.x + dx * i / steps, p.y + dy * i / steps, { buttons: 1 });
  await mouse('mouseReleased', p.x + dx, p.y + dy);
  await sleep(400);
}

// 页面里的取数小工具（每次加载自动注入）
const HELPERS = `window.__t = {
  scene(x, y) { const r = document.querySelector('svg.scene').getBoundingClientRect(); return { x: r.left + x / 1600 * r.width, y: r.top + y / 900 * r.height }; },
  rect(sel) { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; },
  center(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; },
  inPet(x, y) { const e = document.elementFromPoint(x, y); return !!(e && e.closest('#pet')); },
  hitAt(x, y) { const e = document.elementFromPoint(x, y); if (!e) return null; const h = e.closest('[data-hit]'); if (h) return h.getAttribute('data-hit'); const b = e.closest('button'); if (b) return 'button:' + (b.title || b.innerText.trim()); return e.closest('#pet') ? 'pet' : 'desktop'; },
  prefs() { try { return JSON.parse(localStorage.getItem('moyu.prefs.v1') || 'null'); } catch { return 'bad'; } },
  bear() { const g = document.querySelector('g.bear'); if (!g) return null; const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(g.getAttribute('transform')); return { x: +m[1], y: +m[2], mode: g.dataset.mode }; },
  water() { return document.querySelector('[data-hit=water]')?.getAttribute('fill'); },
  btn(text) { return [...document.querySelectorAll('#pet button'), ...document.querySelectorAll('button')].find(b => b.title === text || (b.innerText || '').trim() === text); },
  panels() { return [...document.querySelectorAll('#pet .panel, #pet .popup')].map(e => e.className.replace(/\\b(panel|popup|solid)\\b/g, '').trim()); },
};`;

async function load({ clear = false, raw } = {}) {
  if (clear || raw !== undefined) {
    await ev(`localStorage.clear(); ${raw !== undefined ? `localStorage.setItem('moyu.prefs.v1', ${JSON.stringify(raw)});` : ''} true`);
  }
  await send('Page.navigate', { url: base.href });
  const ok = await waitFor(`!!window.__t && !!document.querySelector('.taskbar') && !!(document.querySelector('#pet') || document.querySelector('#avatar'))`, 30000);
  if (!ok) throw new Error('页面没加载出小窗');
  await sleep(500);
}
const T = expr => ev(`window.__t.${expr}`);
async function clickBtn(text) {
  const p = await T(`center(window.__t.btn(${JSON.stringify(text)}))`);
  if (!p) throw new Error(`找不到按钮：${text}`);
  await clickAt(p);
}
async function scenePt(x, y) { return T(`scene(${x}, ${y})`); }
// 角色身体中心：脚下往上 120 画布单位（Bear.razor 身体椭圆的圆心），避开竿子等不接指针的部分
async function bearBody() { const b = await T('bear()'); return scenePt(b.x, b.y - 120); }

// ───────────── 记录 ─────────────
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'screenshots', name + '.png'), Buffer.from(r.data, 'base64'));
}

// ───────────── 用例 ─────────────
async function run() {
  // B0-01 / B0-04 视口尺寸
  for (const [w, h] of [[1920, 1080], [1600, 900], [1280, 720], [1366, 768], [1024, 768]]) {
    await size(w, h);
    const r = await ev(`(() => { const p = window.__t.rect('#pet'), d = window.__t.rect('.desktop'); return { p, d, sw: document.documentElement.scrollWidth, iw: innerWidth }; })()`);
    const ratio = r.p.w / r.p.h, share = r.p.w / r.d.w;
    check(`B0-04 ${w}×${h} 小窗 16:9、宽占桌面 1/4、无横向滚动`, near(ratio, 16 / 9, 0.01) && near(share, 0.25, 0.002) && r.sw <= r.iw,
      { ratio: +ratio.toFixed(4), share: +share.toFixed(4), scrollWidth: r.sw });
    if (w === 1920) check('B0-01 1920×1080 时小窗 480×270', near(r.p.w, 480, 0.5) && near(r.p.h, 270, 0.5), r.p);
  }
  await size(1600, 900);
  await shot('01-default');

  // B0-15 / B0-39 / B0-42 全新存档
  {
    const b = await T('bear()');
    check('B0-15 首次进入角色已被安排在岸边', b && b.mode === 'Lure' && b.x >= 40 && b.x <= 1560 && b.y >= 540 && b.y <= 590, b);
    await clickBtn('更多'); await clickBtn('设置');
    const s = await ev(`[...document.querySelectorAll('.setting-row')].map(r => ({ t: r.querySelector('span').innerText, on: r.querySelector('[role=switch]').getAttribute('aria-checked') }))`);
    check('B0-39 默认透明区穿透开、静音开', s.length === 2 && s[0].on === 'true' && s[1].on === 'true', s);
    check('B0-42 网页版设置只有"透明区穿透""静音"两行', s.map(x => x.t).join('|') === '透明区穿透|静音', s.map(x => x.t));
    await clickBtn('更多');
  }

  // B0-05 / B0-06 / B0-31 穿透开时的命中
  {
    const sky = await scenePt(800, 200);
    check('B0-05 穿透开：点小窗天空处命中下层桌面', !(await T(`inPet(${sky.x}, ${sky.y})`)), await T(`hitAt(${sky.x}, ${sky.y})`));
    await clickAt(await T(`center(document.querySelector('.desk-icon'))`));
    const selBefore = await ev(`document.querySelectorAll('.desk-icon.sel').length`);
    await clickAt(sky);
    const selAfter = await ev(`document.querySelectorAll('.desk-icon.sel').length`);
    check('B0-05 穿透开：真实单击天空处由桌面收到（图标选中被清掉）', selBefore === 1 && selAfter === 0, { selBefore, selAfter });
    const gaps = await ev(`(() => { const bs = [...document.querySelectorAll('#pet .topbar button')]; const out = [];
      for (let i = 0; i + 1 < bs.length; i++) { const a = bs[i].getBoundingClientRect(), b = bs[i + 1].getBoundingClientRect();
        if (b.left - a.right >= 2) { const x = (a.right + b.left) / 2, y = (a.top + a.bottom) / 2; out.push(window.__t.inPet(x, y)); } }
      return out; })()`);
    check('B0-05 穿透开：右上按钮之间的空隙落到下层', gaps.length >= 1 && gaps.every(g => !g), gaps);
    const body = await bearBody();
    const solid = await ev(`(() => { const bear = window.__t.hitAt(${body.x}, ${body.y});
      const bb = window.__t.center(document.querySelector('.bottombar')); const bottom = window.__t.inPet(bb.x, bb.y);
      return { bear, bottom }; })()`);
    check('B0-06 角色身体、底栏接得住指针', solid.bear === 'character' && solid.bottom, solid);
    const top = await ev(`[...document.querySelectorAll('#pet .topbar button')].map(b => { const c = window.__t.center(b); const e = document.elementFromPoint(c.x, c.y); return { title: b.title, self: !!e && e.closest('button') === b }; })`);
    check('B0-31 右上四个按钮各有独立热区：房间、静音、收起、关闭', top.length === 4 && top.every(t => t.self) && top.map(t => t.title).join('|') === '房间|取消静音|收起|关闭', top);
    const title = await ev(`(() => { const r = document.querySelector('#pet').getBoundingClientRect(); return document.elementFromPoint(r.x + 20, r.y + 20)?.closest('#pet') ? 'pet' : 'desktop'; })()`);
    check('B0-31 左上角没有标题或拖动符号（留白透出下层）', title === 'desktop', title);
  }

  // B0-08 面板关闭后不留拦截热区
  {
    const before = await ev(`(() => { const r = document.querySelector('#pet').getBoundingClientRect(); const pts = [];
      for (let i = 1; i < 10; i++) for (let j = 1; j < 6; j++) { const x = r.x + r.width * i / 10, y = r.y + r.height * j / 10; if (!window.__t.inPet(x, y)) pts.push({ x, y }); } return pts; })()`);
    await clickBtn('鱼篓');
    const covered = await ev(`${JSON.stringify(before)}.filter(p => { const r = document.querySelector('#pet .panel').getBoundingClientRect(); return p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom; })`);
    const whileOpen = await ev(`${JSON.stringify(covered)}.every(p => window.__t.inPet(p.x, p.y))`);
    await clickBtn('鱼篓');
    const afterClose = await ev(`${JSON.stringify(covered)}.every(p => !window.__t.inPet(p.x, p.y))`);
    check('B0-08 面板开着时卡片接指针，关掉后原处恢复穿透', covered.length > 0 && whileOpen && afterClose, { points: covered.length, whileOpen, afterClose });
  }

  // B0-07 穿透关→开
  {
    await clickBtn('更多'); await clickBtn('设置');
    await clickAt(await T(`center(document.querySelectorAll('.setting-row [role=switch]')[0])`));
    await clickBtn('更多');
    const sky = await scenePt(800, 200);
    const off = await T(`inPet(${sky.x}, ${sky.y})`);
    const r0 = await T(`rect('#pet')`);
    await dragBy(sky, -150, -80);
    const r1 = await T(`rect('#pet')`);
    const prefsOff = await T('prefs()');
    await load();
    const keep = await ev(`document.querySelector('#pet').classList.contains('capture')`);
    check('B0-07 关穿透：留白接住指针、拖留白窗口不动、刷新后仍是关', off && near(r0.x, r1.x, 0.5) && near(r0.y, r1.y, 0.5) && prefsOff?.Passthrough === false && keep,
      { off, moved: [r1.x - r0.x, r1.y - r0.y], saved: prefsOff?.Passthrough, keep });
    await clickBtn('更多'); await clickBtn('设置');
    await clickAt(await T(`center(document.querySelectorAll('.setting-row [role=switch]')[0])`));
    await clickBtn('更多');
    const on = await T(`inPet(${sky.x}, ${sky.y})`);
    check('B0-07 再打开穿透：同一点恢复落到下层，设置已保存', !on && (await T('prefs()'))?.Passthrough === true, { inPet: on });
  }

  // B0-09 / B0-10 / B0-11 / B0-12 / B0-13 / B0-14 拖动与单击
  {
    await load({ clear: true });
    const p0 = await T('prefs()'); // 全新存档可能还没写过
    const r0 = await T(`rect('#pet')`);
    const b0 = await T('bear()');
    await dragBy(await scenePt(700, 620), -200, -100);
    const r1 = await T(`rect('#pet')`);
    const b1 = await T('bear()');
    const p1 = await T('prefs()');
    check('B0-09 拖水面：窗口跟着移动、大小不变，角色落点和模式不变',
      near(r1.x - r0.x, -200, 1) && near(r1.y - r0.y, -100, 1) && near(r1.w, r0.w, 0.5) && b1.x === b0.x && b1.y === b0.y && b1.mode === b0.mode && p1 && p1.WindowX !== undefined,
      { moved: [r1.x - r0.x, r1.y - r0.y], bear: [b0, b1], firstPrefs: p0 });

    await dragBy(await bearBody(), 120, 0);
    const r2 = await T(`rect('#pet')`), b2 = await T('bear()');
    check('B0-10 拖角色：只移动窗口，松开不选位', near(r2.x - r1.x, 120, 1) && b2.x === b1.x && b2.y === b1.y, { moved: r2.x - r1.x, bear: b2 });

    await dragBy(await scenePt(900, 565), 40, 0);
    const r3 = await T(`rect('#pet')`), b3 = await T('bear()');
    check('B0-11 在岸边按住移动后松开：不算单击，不选位、窗口不动', b3.x === b2.x && near(r3.x, r2.x, 0.5), { bear: b3, windowMoved: r3.x - r2.x });

    const s = await T(`rect('svg.scene')`);
    await dragBy(await scenePt(900, 565), 3, 0, 2);
    const b4 = await T('bear()'), r4 = await T(`rect('#pet')`);
    const expectX = 900 + 3 / s.w * 1600;
    check('B0-12 按住后移动不超过 5 像素：仍算单击，在松开处选位', near(b4.x, expectX, 2) && near(r4.x, r3.x, 0.5), { bear: b4, expectX: +expectX.toFixed(1) });

    const from = await scenePt(700, 620), vp = await ev(`({ w: innerWidth, h: innerHeight })`);
    await dragBy(from, vp.w - 1 - from.x, vp.h - 1 - from.y); // 拖到视口右下角：窗口要伸出桌面的部分应被夹回
    const r5 = await T(`rect('#pet')`), d = await T(`rect('.desktop')`), p5 = await T('prefs()');
    const scale = d.w / 1920;
    check('B0-13 拖出桌面右下：整窗夹在工作区内', near(r5.x + r5.w, d.x + d.w, 1) && near(r5.y + r5.h, d.y + d.h - 48 * scale, 1) && near(p5.WindowX * 1920, 1440, 0.5) && near(p5.WindowY * 1080, 762, 0.5),
      { right: r5.x + r5.w - (d.x + d.w), bottomGap: d.y + d.h - (r5.y + r5.h), saved: [p5.WindowX * 1920, p5.WindowY * 1080] });

    // 取消：浏览器打断指针（如弹出系统菜单）时只定下窗口位置，不选位
    const b5 = await T('bear()');
    const w = await scenePt(700, 620);
    await ev(`(() => { const el = document.elementFromPoint(${w.x}, ${w.y}); const o = { pointerId: 7, isPrimary: true, button: 0, buttons: 1, bubbles: true };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: ${w.x}, clientY: ${w.y} }));
      document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: ${w.x} - 60, clientY: ${w.y} }));
      document.dispatchEvent(new PointerEvent('pointercancel', { ...o, clientX: ${w.x} - 60, clientY: ${w.y} })); return true; })()`);
    await sleep(500);
    const r6 = await T(`rect('#pet')`), b6 = await T('bear()');
    check('B0-14 拖动中被取消：窗口停在取消处，不选位', near(r6.x - r5.x, -60, 1) && b6.x === b5.x && b6.y === b5.y, { moved: r6.x - r5.x, bear: b6 });
    await shot('02-after-drags');
  }

  // B0-16 / B0-17 / B0-19 选位
  {
    await load({ clear: true });
    await clickAt(await scenePt(1000, 565));
    const b1 = await T('bear()'), p1 = await T('prefs()');
    check('B0-16 单击岸边任意点：角色移到点击处并保存', near(b1.x, 1000, 2) && near(b1.y, 565, 2) && p1?.HasSpot && near(p1.SpotX, 1000, 2), { bear: b1, saved: p1 && [p1.SpotX, p1.SpotY] });
    await clickAt(await scenePt(140, 565), 200);
    const bubble = await ev(`!!document.querySelector('.noroom')`);
    await shot('03-noroom');
    const b2 = await T('bear()');
    await sleep(1800);
    const gone = await ev(`!document.querySelector('.noroom')`);
    check('B0-17 单击荷花茎旁放不下：冒"放不下"提示、角色留在原处，约 1.5 秒后提示消失', bubble && b2.x === b1.x && b2.y === b1.y && gone, { bubble, bear: b2, gone });
    await clickAt(await scenePt(700, 700));
    const b3 = await T('bear()'), bubble3 = await ev(`!!document.querySelector('.noroom')`);
    check('B0-19 路亚时单击浅水：不选位、也不冒提示', b3.x === b1.x && b3.y === b1.y && !bubble3, { bear: b3, bubble: bubble3 });
  }

  // B0-22 / B0-23 模式
  {
    const modeText = () => ev(`document.querySelector('#pet .mode span').innerText`);
    await clickBtn(await modeText()); await clickBtn('摸鱼');
    const w = await T('bear()');
    check('B0-22 切到摸鱼：下水姿态、搬到浅水、底栏写"摸鱼"、菜单关闭',
      w.mode === 'Wade' && w.y >= 650 && w.y <= 760 && (await modeText()) === '摸鱼' && (await T('panels()')).length === 0, { bear: w, mode: await modeText() });
    await clickBtn('摸鱼'); await clickBtn('手竿');
    const p = await T('bear()');
    check('B0-22 切到手竿：竿架姿态、回到岸边', p.mode === 'Pole' && p.y >= 540 && p.y <= 590 && (await modeText()) === '手竿', p);
    // 先换到自己选的点：用自动安排的默认点时，"没动"和"被重排回同一点"分不出来
    await clickAt(await scenePt(700, 565));
    const own = await T('bear()');
    await clickBtn('手竿'); await clickBtn('路亚');
    const l = await T('bear()');
    check('B0-22 路亚↔手竿同在岸边：玩家选的落点不动', near(own.x, 700, 2) && l.mode === 'Lure' && l.x === own.x && l.y === own.y, { own, after: l });
    await clickBtn('路亚'); await clickBtn('路亚');
    const same = await T('bear()');
    check('B0-23 选当前模式：菜单关闭、落点不动', same.x === l.x && (await T('panels()')).length === 0, same);
  }

  // B0-24 / B0-25 / B0-28 / B0-30 地图与"更多"
  {
    await clickBtn('路亚'); await clickBtn('摸鱼');
    await clickBtn('更多');
    const rows = await ev(`[...document.querySelectorAll('.more-menu .row')].map(b => b.innerText.trim())`);
    await clickBtn('地图');
    const maps = await ev(`[...document.querySelectorAll('.map-row')].map(b => ({ name: b.querySelector('.name').innerText, on: b.classList.contains('on') }))`);
    check('B0-25 更多里地图、皮肤是两个入口；地图面板三选一，当前地图单独标记',
      rows.includes('地图') && rows.includes('皮肤') && maps.length === 3 && maps.filter(m => m.on).length === 1 && maps[0].on, { rows, maps });
    check('B0-28 荷塘水面是青绿色（不是紫色）', (await T('water()')) === '#7dbba5', await T('water()'));
    await clickAt(await T(`center(document.querySelectorAll('.map-row')[1])`));
    const after = await ev(`[...document.querySelectorAll('.map-row')].map(b => b.classList.contains('on'))`);
    const moreOn = await ev(`[...document.querySelectorAll('#pet .bottombar .tab')].pop().classList.contains('on')`);
    check('B0-25 选地图二：水色换成溪流、选中标记移到第二行', (await T('water()')) === '#7fbfd0' && after[1] && !after[0], { water: await T('water()'), after });
    check('B0-30 从"更多"打开的面板开着时"更多"保持高亮', moreOn, moreOn);
    await clickBtn('更多');
    const b = await T('bear()');
    check('B0-30 再点"更多"关掉地图面板', (await T('panels()')).length === 0, await T('panels()'));
    check('B0-24 切地图、关地图面板后仍是摸鱼，并在新地图浅水里', b.mode === 'Wade' && b.y >= 650 && b.y <= 760 && (await T('prefs()')).Mode === 'Wade', b);
    const sky = await scenePt(800, 120);
    const bg = await ev(`[getComputedStyle(document.querySelector('#pet')).backgroundColor, getComputedStyle(document.querySelector('#pet .design')).backgroundColor]`);
    check('B0-28 小窗外层与设计层背景透明，天空处透出下层', bg.every(c => c === 'rgba(0, 0, 0, 0)') && !(await T(`inPet(${sky.x}, ${sky.y})`)), bg);
  }

  // B0-29 一次一个面板
  {
    await clickBtn('鱼篓'); await clickBtn('收藏');
    const one = await T('panels()');
    await clickBtn('收藏');
    const none = await T('panels()');
    check('B0-29 打开收藏替换鱼篓，再点收藏关闭', one.length === 1 && one[0].includes('collection') && none.length === 0, { one, none });
  }

  // B0-35 / B0-36 / B0-37 已作废：B1 去掉了模拟鱼获和示例鱼、开放了出售收藏抽取，改由 B1 用例覆盖

  // B0-32 / B0-33 / B0-34 收起、关闭
  {
    const r0 = await T(`rect('#pet')`), m0 = (await T('prefs()')).Mode;
    await clickBtn('收起');
    const collapsed = await ev(`!document.querySelector('#pet') && !!document.querySelector('#avatar')`);
    await clickAt(await T(`center(document.querySelector('#avatar'))`));
    const r1 = await T(`rect('#pet')`);
    check('B0-32 收起成头像，单击头像恢复到原位置，模式不变', collapsed && near(r1.x, r0.x, 0.5) && near(r1.y, r0.y, 0.5) && (await T('prefs()')).Mode === m0, { collapsed, r0, r1 });
    await clickAt(await T(`center(document.querySelector('.taskbar button[title=桌面摸鱼]'))`));
    const viaTask = await ev(`!!document.querySelector('#avatar')`);
    await clickAt(await T(`center(document.querySelector('.taskbar button[title=桌面摸鱼]'))`));
    check('B0-32 任务栏按钮也能收起、恢复', viaTask && !!(await T(`rect('#pet')`)), viaTask);

    await clickBtn('收起');
    await dragBy(await T(`center(document.querySelector('#avatar'))`), -100, -50);
    await clickAt(await T(`center(document.querySelector('#avatar'))`));
    const r2 = await T(`rect('#pet')`);
    check('B0-33 拖动头像后恢复：小窗跟着头像移动', near(r2.x - r1.x, -100, 1) && near(r2.y - r1.y, -50, 1), { moved: [r2.x - r1.x, r2.y - r1.y] });

    await clickBtn('关闭');
    const closed = await ev(`!document.querySelector('#pet') && !document.querySelector('#avatar')`);
    await clickAt(await T(`center(document.querySelector('.taskbar button[title=桌面摸鱼]'))`));
    const r3 = await T(`rect('#pet')`);
    await clickBtn('关闭');
    await dblClickAt(await T(`center([...document.querySelectorAll('.desk-icon')].find(b => b.innerText.includes('桌面摸鱼')))`));
    const r4 = await T(`rect('#pet')`);
    check('B0-34 关闭后小窗消失；任务栏按钮、双击桌面图标都能在原位置重新打开',
      closed && r3 && r4 && near(r3.x, r2.x, 0.5) && near(r4.x, r2.x, 0.5) && near(r4.y, r2.y, 0.5), { closed, r3, r4 });
  }

  // B0-40 保存与恢复
  {
    await clickBtn('更多'); await clickBtn('地图');
    await clickAt(await T(`center(document.querySelectorAll('.map-row')[2])`));
    await clickBtn('更多'); // 选完地图面板还开着，先关掉
    await clickBtn('更多'); await clickBtn('设置');
    await clickAt(await T(`center(document.querySelectorAll('.setting-row [role=switch]')[0])`));
    await clickBtn('更多');
    await clickAt(await scenePt(600, 700));
    const before = { bear: await T('bear()'), water: await T('water()'), rect: await T(`rect('#pet')`), prefs: await T('prefs()') };
    await load();
    const after = { bear: await T('bear()'), water: await T('water()'), rect: await T(`rect('#pet')`), capture: await ev(`document.querySelector('#pet').classList.contains('capture')`) };
    check('B0-40 刷新后恢复：地图三、摸鱼、落点、窗口位置、穿透关',
      after.water === '#9fd3e3' && after.bear.mode === 'Wade' && after.bear.x === before.bear.x && after.bear.y === before.bear.y && near(after.rect.x, before.rect.x, 0.5) && near(after.rect.y, before.rect.y, 0.5) && after.capture,
      { before: before.bear, after });
  }

  // B0-41 坏存档
  {
    await load({ raw: '{"WindowX":' });
    const a = { pet: !!(await T(`rect('#pet')`)), err: await ev(`getComputedStyle(document.querySelector('#blazor-error-ui') || document.body).display`), mode: (await T('bear()'))?.mode, water: await T('water()') };
    check('B0-41 存档不是合法 JSON：按全新存档打开，不报错', a.pet && a.err === 'none' && a.mode === 'Lure' && a.water === '#7dbba5', a);
    await load({ raw: JSON.stringify({ Version: 1, WindowX: 5, WindowY: -1, Mode: 'Boat', MapId: 'gone', HasSpot: true, SpotX: 140, SpotY: 565, Passthrough: true, Mute: true }) });
    const r = await T(`rect('#pet')`), d = await T(`rect('.desktop')`), b = await T('bear()');
    check('B0-41 存档字段越界或不认识：逐项回落，窗口仍整窗可见，放不下的旧落点重新安排',
      r.x >= d.x - 0.5 && r.x + r.w <= d.x + d.w + 0.5 && r.y + r.h <= d.y + d.h && b.mode === 'Lure' && (await T('water()')) === '#7dbba5' && b.x !== 140,
      { rect: r, bear: b });
  }

  check('控制台无报错', consoleErrors.length === 0, consoleErrors.slice(0, 5));
}

// ───────────── 主流程 ─────────────
fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
const chrome = CHROMES.find(p => fs.existsSync(p));
if (!chrome) { console.error('找不到 Chrome/Edge，用环境变量 CHROME 指定'); process.exit(2); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-b0-profile-'));
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
let build = null, fatal = null, rel = null;
try {
  if (RELEASE) rel = await startRelease();
  base = new URL(rel ? rel.url : process.argv[2] || 'https://etsevenday.github.io/zhuomianmoyu/');
  base.searchParams.set('dev', '1');
  await connect();
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
  await size(1600, 900);
  await load({ clear: false });
  build = await ev(`document.querySelector('meta[name=app-build]')?.content`);
  await run();
} catch (e) {
  fatal = String(e?.stack || e);
  console.error('脚本中断：', fatal);
  try { await shot('99-fatal'); } catch { }
} finally {
  try { ws?.close(); } catch { }
  proc.kill();
  rel?.close();
}
const failed = results.filter(r => !r.pass).length;
fs.writeFileSync(path.join(out, 'b0-results.json'), JSON.stringify({ url: base?.href, build, time: new Date().toISOString(), passed: results.length - failed, failed, fatal, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} 通过${fatal ? '（脚本中断）' : ''}；构建 ${build}；结果 ${path.join(out, 'b0-results.json')}`);
process.exit(failed || fatal ? 1 : 0);
