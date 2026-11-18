#!/usr/bin/env node
// B7 截图巡检：node tools/verify/shots.mjs [--release] [输出目录]
// 按固定清单截图，给开发方（Claude）每批推送前逐张看画面用：文字截断、遮挡、重叠、挤成一团这类问题脚本判不出来。
//   网页：本地 Release 包（--release）或线上，无头浏览器，视口 1600×900 / 1920×1080 / 2560×1440（小窗 400×225 / 480×270 / 640×360）；
//   PC：测试模式的外壳（虚构主屏 1920×1080、1280×720），MOYU_PC_APP 指向试玩包时测包里的。都不动鼠标键盘。
// 只截小窗那块，按 2 倍像素截，字看得清；每张截之前在页面里查一遍出界和截断（只记下来给看图时重点看，不判失败）。
// 输出：shots/<尺寸>/<序号-画面>.png、sheets/<n>.png（四宫格总览，标签带检测结果）、shots.json。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBatch, sleep } from './cdp.mjs';
import { launch, sleep as _s, PACKED } from './b4.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'moyu-shots'));
fs.rmSync(path.join(out, 'shots'), { recursive: true, force: true });
fs.rmSync(path.join(out, 'sheets'), { recursive: true, force: true });

// 页面里的检测：小窗（或头像）里可见元素超出它的边界、文字比框大（被截断或溢出框外）
const AUDIT = `window.__audit = function () {
  const root = document.querySelector('#pet') || document.querySelector('#avatar');
  if (!root) return null;
  const pr = root.getBoundingClientRect();
  const label = e => (e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : '')
    + (e.innerText ? ' "' + e.innerText.trim().replace(/\\s+/g, ' ').slice(0, 24) + '"' : '')).slice(0, 80);
  const clipped = (e, r) => {
    // 和小窗里会裁切的祖先（滚动区、overflow 隐藏）求交：滚走看不见的不算
    let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    for (let a = e.parentElement; a && a !== root; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const q = a.getBoundingClientRect();
        x0 = Math.max(x0, q.left); y0 = Math.max(y0, q.top); x1 = Math.min(x1, q.right); y1 = Math.min(y1, q.bottom);
      }
    }
    return x1 - x0 > 0.5 && y1 - y0 > 0.5 ? { x0, y0, x1, y1 } : null;
  };
  const outside = [], cut = [], overlap = [];
  // 底栏、顶栏、面板里的一排按钮：相邻可见的兄弟元素互相压住（挤不下时常见，出界、截断查不出）
  for (const row of root.querySelectorAll('.bar, .topbar, .tabs, .panel-actions, .panel-head, .bottom, .status, [class*=bar]')) {
    // 底栏里的几个数字装在 .stats 里：拆开和两边的按钮一起比
    const kids = [...row.children].flatMap(k => k.classList.contains('stats') ? [...k.children] : [k]).filter(k => { const r = k.getBoundingClientRect(); return r.width && r.height && getComputedStyle(k).visibility !== 'hidden'; });
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 2 && h > 2) overlap.push(label(kids[i]) + ' × ' + label(kids[j]));
    }
  }
  for (const e of root.querySelectorAll('*')) {
    if (e.closest('svg') && e.tagName.toLowerCase() !== 'svg') continue; // 场景画布里的东西本来就会画出去再被裁
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const v = clipped(e, r);
    if (!v) continue;
    if (v.x0 < pr.left - 1 || v.y0 < pr.top - 1 || v.x1 > pr.right + 1 || v.y1 > pr.bottom + 1) outside.push(label(e));
    const text = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (text && cs.display !== 'inline' && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)
      && !/auto|scroll/.test(cs.overflowX + cs.overflowY)) cut.push(label(e));
  }
  return { outside, cut, overlap: [...new Set(overlap)] };
};`;

const HELPERS = `window.__t = {
  center(el) { if (typeof el === 'string') el = document.querySelector(el); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; },
  rect(sel) { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; },
  btn(text) { return [...document.querySelectorAll('#pet button')].find(b => b.offsetParent !== null && (b.title === text || (b.innerText || '').trim() === text)); },
  save() { return document.querySelector('[data-stat=save]')?.innerText.trim() ?? null; },
  idbClear() { return new Promise(ok => { const r = indexedDB.deleteDatabase('zhuomianmoyu-play'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); }); },
};
${AUDIT}`;

const manifest = [];
let sheetN = 0;

await runBatch({
  batch: 'shots',
  helpers: HELPERS,
  async run({ main, base, check, openTab, closeTab, consoleErrors, setBuild }) {
    const { ev, waitFor, clickAt, send } = main;
    const T = expr => ev(`window.__t.${expr}`);
    let size = '';

    async function viewport(w, h) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
      await sleep(300);
    }
    async function load() {
      await send('Page.navigate', { url: base.href });
      if (!(await waitFor(`!!window.__t && !!window.moyuDev && !!document.querySelector('#pet') && window.__t.save() === '已保存'`, 30000)))
        throw new Error('页面没加载出小窗');
      await sleep(800);
    }
    async function reset(w, h) {
      await viewport(w, h);
      await send('Page.navigate', { url: base.href });
      await waitFor(`!!window.__t`, 30000);
      await ev(`localStorage.clear(), window.__t.idbClear()`);
      await load();
    }
    /** 截一张：默认只截小窗（或头像）那块；whole 截整个视口。截之前跑检测。 */
    async function shot(name, { whole = false, pad = 0 } = {}) {
      await sleep(450);
      const audit = await ev('window.__audit()');
      const sel = (await ev(`!!document.querySelector('#pet')`)) ? '#pet' : '#avatar';
      const r = await T(`rect('${sel}')`);
      const vp = await ev('({ w: innerWidth, h: innerHeight })');
      const clip = whole ? { x: 0, y: 0, width: vp.w, height: vp.h, scale: 0.5 }
        : { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + pad * 2, height: r.h + pad * 2, scale: 1 };
      const res = await send('Page.captureScreenshot', { format: 'png', clip });
      const dir = path.join(out, 'shots', size);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${String(manifest.filter(m => m.size === size).length + 1).padStart(2, '0')}-${name}.png`);
      fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
      manifest.push({ size, name, file: path.relative(out, file), pet: r && { w: Math.round(r.w), h: Math.round(r.h) }, audit, whole });
    }
    const click = async (expr, settle = 350) => {
      const p = await ev(`window.__t.center(${expr})`);
      if (!p) throw new Error('点不到：' + expr);
      await clickAt(p, settle);
    };
    const btn = text => click(`window.__t.btn(${JSON.stringify(text)})`);
    const closePanel = () => click(`document.querySelector('#pet .panel-head .x, #pet .popup-head .x')`);
    const more = async item => { await btn('更多'); await click(`[...document.querySelectorAll('#pet .popup .row')].find(b => b.innerText.trim() === ${JSON.stringify(item)})`); };

    // ── 网页：最小、默认两档截全清单 ──
    for (const [w, h] of [[1600, 900], [1920, 1080]]) {
      size = `web-${w / 4}x${h / 4}`;
      await reset(w, h);
      await shot('desktop', { whole: true });
      await shot('home-empty');
      for (const [tab, name] of [['鱼篓', 'basket-empty'], ['收藏', 'collection-empty'], ['记录', 'records-empty']]) { await btn(tab); await shot(name); await closePanel(); }

      // 有鱼有币：开发入口注入；出鱼卡片要真出一条：摸鱼模式（每 200 次判定、一个周期 400 次、周期末必出）在假桌面的记事本里按，出了就停
      await ev('window.moyuDev.addCoins(3000)');
      await ev('window.moyuDev.injectFish(12)');
      await click(`document.querySelector('#pet .pill.mode')`);
      await click(`[...document.querySelectorAll('#pet .popup .opt')].find(b => b.innerText.includes('摸鱼'))`, 800);
      if (await ev(`!!document.querySelector('#pet .popup')`)) await closePanel();
      await ev(`document.querySelector('#notepad textarea')?.focus(), true`);
      // 卡片几秒后自己收起，按一小段就看一眼（周期中途也可能先出）
      for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('#pet .catch-card')`)); i++) {
        await main.press(10);
        await waitFor(`!!document.querySelector('#pet .catch-card')`, 300);
      }
      if (await waitFor(`!!document.querySelector('#pet .catch-card')`, 5000)) await shot('catch-card');
      await sleep(4500); // 等卡片自己收起
      await shot('home-data');

      // 玩法模式：弹窗，再逐个切过去
      await click(`document.querySelector('#pet .pill.mode')`);
      await shot('mode-menu');
      const modes = await ev(`document.querySelectorAll('#pet .popup .opt').length`);
      await closePanel();
      for (let i = 0; i < modes; i++) {
        await click(`document.querySelector('#pet .pill.mode')`);
        await click(`document.querySelectorAll('#pet .popup .opt')[${i}]`, 800);
        if (await ev(`!!document.querySelector('#pet .popup')`)) await closePanel();
        await shot(`mode-${i + 1}`);
      }
      await click(`document.querySelector('#pet .pill.mode')`);
      await click(`document.querySelectorAll('#pet .popup .opt')[0]`, 800);
      if (await ev(`!!document.querySelector('#pet .popup')`)) await closePanel();

      await btn('更多'); await shot('more'); await closePanel();

      // 地图：面板，再逐张切过去
      await more('地图'); await shot('map');
      const maps = await ev(`document.querySelectorAll('#pet .map-row').length`);
      await closePanel();
      for (let i = 0; i < maps; i++) {
        await more('地图');
        await click(`document.querySelectorAll('#pet .map-row')[${i}]`, 1200);
        if (await ev(`!!document.querySelector('#pet .panel, #pet .popup')`)) await closePanel();
        await shot(`map-${i + 1}`);
      }
      await more('地图'); await click(`document.querySelectorAll('#pet .map-row')[0]`, 1200);
      if (await ev(`!!document.querySelector('#pet .panel, #pet .popup')`)) await closePanel();

      // 皮肤：每个分类
      await more('皮肤');
      for (const tab of await ev(`[...document.querySelectorAll('#pet [data-tab]')].map(b => b.dataset.tab)`)) {
        await click(`document.querySelector('#pet [data-tab="${tab}"]')`);
        await shot(`skin-${tab}`);
      }
      await closePanel();

      await more('设置'); await shot('settings'); await closePanel();
      await btn('鱼篓'); await shot('basket');
      await click(`document.querySelectorAll('#pet .fish-cell .tick')[0]`);
      await click(`document.querySelectorAll('#pet .fish-cell .tick')[1]`);
      await click(`document.querySelector('#pet .btn.sell')`); await shot('sale-confirm');
      await click(`document.querySelector('#pet .btn.ok')`, 200);
      if (await waitFor(`!!document.querySelector('#pet .notice')`, 4000)) await shot('notice-sold');
      await click(`[...document.querySelectorAll('#pet button')].find(b => b.innerText.trim() === '账本')`); await shot('ledger');
      await closePanel();
      await btn('收藏'); await shot('collection'); await closePanel();
      await btn('记录'); await shot('records'); await closePanel();
      await btn('房间'); await shot('room'); await closePanel();

      // 错误提示：模拟保存失败时卖一条鱼
      await ev('window.moyuDev.failSaves(true)');
      await btn('鱼篓');
      await click(`document.querySelectorAll('#pet .fish-cell .tick')[0]`);
      await click(`document.querySelector('#pet .btn.sell')`);
      await click(`document.querySelector('#pet .btn.ok')`, 200);
      if (await waitFor(`!!document.querySelector('#pet .notice.error')`, 6000)) await shot('notice-save-failed');
      await ev('window.moyuDev.failSaves(false)');
      if (await ev(`!!document.querySelector('#pet .btn.ok')`)) await click(`document.querySelector('#pet .btn.ok')`, 600);
      if (await ev(`!!document.querySelector('#pet .panel')`)) await closePanel();
      await waitFor(`window.__t.save() === '已保存'`, 10000);
      await sleep(3500);

      await btn('收起');
      await waitFor(`!!document.querySelector('#avatar') && !document.querySelector('#pet')`, 5000);
      await shot('collapsed', { pad: 24 });
      await click(`document.querySelector('#avatar')`, 800);
    }

    // ── 网页大尺寸：主界面和几个面板 ──
    size = 'web-640x360';
    await reset(2560, 1440);
    await shot('home-empty');
    await ev('window.moyuDev.addCoins(3000)');
    await ev('window.moyuDev.injectFish(12)');
    await sleep(4500);
    await shot('home-data');
    await more('设置'); await shot('settings'); await closePanel();
    await btn('鱼篓'); await shot('basket'); await closePanel();
    await more('皮肤'); await shot('skin'); await closePanel();
    await btn('记录'); await shot('records'); await closePanel();
    setBuild(await ev(`document.querySelector('meta[name=app-build]')?.content`));
    const webErrors = [...consoleErrors];

    // ── PC 小窗 ──
    if (!PACKED) {
      const r = spawnSync(process.execPath, [path.join(REPO, 'pc', 'build-web.mjs')], { cwd: path.join(REPO, 'pc'), stdio: 'inherit' });
      if (r.status !== 0) throw new Error('网页发布失败');
    }
    const pcErrors = [];
    const disp = (w, h) => [{ id: 'A', bounds: { x: 0, y: 0, width: w, height: h }, workArea: { x: 0, y: 0, width: w, height: h - 48 }, primary: true }];
    for (const [w, h] of [[1280, 720], [1920, 1080]]) {
      size = `pc-${w / 4 < 400 ? 400 : w / 4}`;
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-shots-pc-'));
      // input: null —— 全新安装：后台输入默认开，会浮出首次说明（只起采集程序，不发任何输入）
      const p = await launch({ userData, displays: disp(w, h), input: null, port: 9357 });
      try {
        await p.send('Page.enable');
        const pcShot = async name => {
          await _s(450);
          await p.send('Runtime.evaluate', { expression: AUDIT });
          const audit = await p.ev('window.__audit()');
          const res = await p.send('Page.captureScreenshot', { format: 'png' });
          const dir = path.join(out, 'shots', size);
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${String(manifest.filter(m => m.size === size).length + 1).padStart(2, '0')}-${name}.png`);
          fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
          const vp = await p.ev('({ w: innerWidth, h: innerHeight })');
          manifest.push({ size, name, file: path.relative(out, file), pet: vp, audit, pc: true });
        };
        if (await p.waitFor(`!!document.querySelector('#pet .notice')`, 6000)) await pcShot('intro-notice');
        await _s(4000);
        await pcShot('home');
        await p.btn('更多'); await p.btn('设置');
        await pcShot('settings');
        await p.click(await p.ev(`window.__t.center('[data-act=input-help]')`));
        await pcShot('settings-input-help');
        await p.click(await p.ev(`window.__t.center('#pet .panel-head .x')`));
        await p.btn('收起');
        await p.waitFor(`!!document.querySelector('#avatar')`, 5000);
        await pcShot('collapsed');
        pcErrors.push(...p.errors);
      } finally {
        await p.kill();
      }
    }

    // ── 四宫格总览 ──
    const sheetTab = await openTab(null);
    await sheetTab.send('Emulation.setDeviceMetricsOverride', { width: 1640, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (let i = 0; i < manifest.length; i += 4) {
      const items = manifest.slice(i, i + 4).map(m => {
        const flags = [...(m.audit?.outside || []).map(s => '出界 ' + s), ...(m.audit?.cut || []).map(s => '截断 ' + s), ...(m.audit?.overlap || []).map(s => '压住 ' + s)];
        const src = 'data:image/png;base64,' + fs.readFileSync(path.join(out, m.file)).toString('base64');
        return `<figure><div class="img${m.pc ? ' pc' : ''}"><img src="${src}"></div><figcaption><b>${m.size} · ${m.name}</b>${flags.length ? `<span class="flag">${flags.slice(0, 3).join('；').replace(/</g, '&lt;')}${flags.length > 3 ? ` 等 ${flags.length} 处` : ''}</span>` : ''}</figcaption></figure>`;
      }).join('');
      const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:10px;background:#e8e8ee;font:13px "Microsoft YaHei",sans-serif;display:grid;grid-template-columns:1fr 1fr;gap:10px}
figure{margin:0;background:#fff;padding:6px}.img{height:440px;display:flex;align-items:center;justify-content:center;background:#f4f4f6}
.img.pc{background:repeating-conic-gradient(#ddd 0 25%,#f6f6f6 0 50%) 0 0/20px 20px}img{max-width:100%;max-height:440px}
figcaption{padding-top:4px}.flag{display:block;color:#c0392b}</style>${items}`;
      await sheetTab.ev(`document.open(); document.write(${JSON.stringify(html)}); document.close(); true`);
      await sheetTab.waitFor(`[...document.images].every(i => i.complete)`, 10000);
      const hgt = await sheetTab.ev('document.documentElement.scrollHeight');
      const res = await sheetTab.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1640, height: hgt, scale: 1 }, captureBeyondViewport: true });
      fs.mkdirSync(path.join(out, 'sheets'), { recursive: true });
      fs.writeFileSync(path.join(out, 'sheets', `${String(++sheetN).padStart(2, '0')}.png`), Buffer.from(res.data, 'base64'));
    }
    await closeTab(sheetTab);

    fs.writeFileSync(path.join(out, 'shots.json'), JSON.stringify(manifest, null, 2));

    // ── 检查 ──
    const web = manifest.filter(m => !m.pc);
    const need = ['desktop', 'home-empty', 'basket-empty', 'collection-empty', 'records-empty', 'catch-card', 'home-data', 'mode-menu', 'more', 'map',
      'settings', 'basket', 'sale-confirm', 'notice-sold', 'ledger', 'collection', 'records', 'room', 'notice-save-failed', 'collapsed'];
    const missing = [];
    for (const s of ['web-400x225', 'web-480x270']) {
      const names = web.filter(m => m.size === s).map(m => m.name);
      for (const n of need) if (!names.includes(n)) missing.push(`${s}/${n}`);
      if (!names.some(n => /^mode-\d/.test(n)) || !names.some(n => /^map-\d/.test(n)) || !names.some(n => n.startsWith('skin-'))) missing.push(`${s}/模式、地图或皮肤分类`);
    }
    const blank = web.filter(m => !m.whole && !m.pet);
    check('B7-01 网页清单里的画面都截到，每张都有小窗或头像', missing.length === 0 && blank.length === 0, { shots: web.length, missing, blank: blank.map(m => m.file) });
    const sizeOf = s => web.find(m => m.size === s && m.name === 'home-empty')?.pet;
    check('B7-02 三档尺寸：小窗 400×225、480×270、640×360', JSON.stringify([sizeOf('web-400x225'), sizeOf('web-480x270'), sizeOf('web-640x360')])
      === JSON.stringify([{ w: 400, h: 225 }, { w: 480, h: 270 }, { w: 640, h: 360 }]), [sizeOf('web-400x225'), sizeOf('web-480x270'), sizeOf('web-640x360')]);
    const pc = manifest.filter(m => m.pc);
    const pcNames = s => pc.filter(m => m.size === s).map(m => m.name).join();
    check('B7-03 PC 小窗：常态、设置、输入说明、收起都截到（两种主屏）',
      ['pc-400', 'pc-480'].every(s => ['home', 'settings', 'settings-input-help', 'collapsed'].every(n => pcNames(s).split(',').includes(n))),
      { 'pc-400': pcNames('pc-400'), 'pc-480': pcNames('pc-480') });
    const flagged = manifest.filter(m => m.audit && (m.audit.outside.length || m.audit.cut.length || m.audit.overlap.length));
    check('B7-04 每张图都跑了出界、截断、压住检测（结果给看图用，不判失败）', manifest.filter(m => !m.whole).every(m => m.audit),
      { total: manifest.length, flagged: flagged.map(m => `${m.size}/${m.name}: 出界 ${m.audit.outside.length}、截断 ${m.audit.cut.length}、压住 ${m.audit.overlap.length}`) });
    check('B7-06 网页和 PC 页面没有报错', webErrors.length === 0 && pcErrors.length === 0, [...webErrors, ...pcErrors].slice(0, 5));
    console.log(`\n截图 ${manifest.length} 张，总览 ${sheetN} 张：${path.join(out, 'sheets')}`);
  },
});
