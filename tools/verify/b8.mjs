#!/usr/bin/env node
// B8 画面修正验收：执行 doc/测试用例/B8 画面修正.md 里方式为 B 的用例，每个 check 名以用例号开头。
//
// 用法：
//   node tools/verify/b8.mjs [网址|--release] [输出目录]
//   --release：先照 CI 的方式发布本地 Release 包，挂在 http://127.0.0.1:5199/zhuomianmoyu/ 上测（推送前的主关卡）
//   网址默认线上；开发中也可测 http://localhost:5188/ 。PC 部分（B8-05）用测试模式外壳，设了 MOYU_PC_APP 就测包里的 exe。
//
// 小窗整块等比缩放，所以都换算成设计坐标（1600×900）量。量的是最长的内容：把数字、体长、提示文字临时换成能出现的
// 最长值，同一次求值里量完再换回去（Blazor 不会在中间重画）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runBatch, sleep } from './cdp.mjs';
import { launch, PACKED } from './b4.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEXTS = fs.readFileSync(path.join(REPO, 'web/Moyu.Web/Services/Texts.cs'), 'utf8');
const INTRO = TEXTS.match(/PcInputIntro = "([^"]+)"/)[1]; // TXT-PC-007，提示条里最长的一句
const LONG = { total: '9999.9万', coins: '9999.9万', save: '读档失败', len: '130.0 cm' };
const MODES = [
  { name: '路亚', fmt: /^\d+\/(500|1000)( 保底)?$/, longest: '999/1000 保底' },
  { name: '摸鱼', fmt: /^\d+\/\d+00( 保底)?$/, longest: '1999/2000 保底' },
  { name: '手竿', fmt: /^\d\d:\d\d\/30:00$/, longest: '29:59/30:00' },
];

// 页面里的量具：设计坐标的框、相交、包含、文字的框、临时换字
const GEOM = `window.__g = {
  R(x) {
    const p = document.querySelector('#pet').getBoundingClientRect(), s = p.width / 1600;
    const r = x.getBoundingClientRect ? x.getBoundingClientRect() : x;
    const f = v => Math.round(v * 10) / 10;
    return { l: f((r.left - p.left) / s), t: f((r.top - p.top) / s), r: f((r.right - p.left) / s), b: f((r.bottom - p.top) / s) };
  },
  hit(a, b, tol = 1) { return Math.min(a.r, b.r) - Math.max(a.l, b.l) > tol && Math.min(a.b, b.b) - Math.max(a.t, b.t) > tol; },
  inside(a, b, tol = 1) { return a.l >= b.l - tol && a.t >= b.t - tol && a.r <= b.r + tol && a.b <= b.b + tol; },
  text(el) { const r = document.createRange(); r.selectNodeContents(el); return this.R(r.getBoundingClientRect()); },
  cut(el) { return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1; },
  name(e) { return e.dataset?.stat || e.title || (typeof e.className === 'string' ? e.className : e.tagName); },
  // 换掉元素里最后一段文字，返回还原函数
  swap(el, t) {
    const n = [...el.childNodes].reverse().find(n => n.nodeType === 3 && n.textContent.trim());
    if (!n) return () => {};
    const old = n.textContent; n.textContent = t; return () => { n.textContent = old; };
  },
  // 底栏：模式按钮、四项数字、四个入口、新鱼数两两不重叠；四项在信息区里、没被截断
  bar() {
    const bb = document.querySelector('#pet .bottombar'), st = bb.querySelector('.stats');
    const items = [...bb.children].flatMap(k => k === st ? [...st.children] : [k]);
    const badge = bb.querySelector('.badge'); if (badge) items.push(badge);
    const hits = [];
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.contains(b) || b.contains(a)) continue;
      if (this.hit(this.R(a), this.R(b))) hits.push(this.name(a) + ' × ' + this.name(b));
    }
    const sR = this.R(st), bR = this.R(bb);
    const stats = Object.fromEntries([...st.children].map(e => [e.dataset.stat, { text: e.innerText.replace(/\\s+/g, ' ').trim(), r: this.R(e) }]));
    return {
      hits,
      outside: [...st.children].filter(e => !this.inside(this.R(e), sR) || !this.inside(this.R(e), bR)).map(e => this.name(e)),
      cut: [...st.children].filter(e => this.cut(e)).map(e => this.name(e)),
      bar: bR, stats,
    };
  },
  // 提示条：字全在条里、不压右上按钮、不出小窗
  notice() {
    const n = document.querySelector('#pet .notice'); if (!n) return null;
    const nR = this.R(n), tR = this.text(n), top = this.R(document.querySelector('#pet .topbar'));
    return { nR, tR, top, inText: this.inside(tR, nR, 0.5) && !this.cut(n), hitTop: this.hit(nR, top, 0), inPet: this.inside(nR, { l: 0, t: 0, r: 1600, b: 900 }) };
  },
};`;

const HELPERS = `window.__t = {
  center(el) { if (typeof el === 'string') el = document.querySelector(el); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; },
  btn(text) { return [...document.querySelectorAll('#pet button')].find(b => b.offsetParent !== null && (b.title === text || (b.innerText || '').trim() === text)); },
  save() { return document.querySelector('[data-stat=save]')?.innerText.trim() ?? null; },
  idbClear() { return new Promise(ok => { const r = indexedDB.deleteDatabase('zhuomianmoyu-play'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); }); },
};
${GEOM}`;

await runBatch({
  batch: 'b8',
  helpers: HELPERS,
  async run({ main, base, check, consoleErrors, setBuild }) {
    const { ev, waitFor, clickAt } = main;
    const click = async (expr, settle = 350) => {
      const p = await ev(`window.__t.center(${expr})`);
      if (!p) throw new Error('点不到：' + expr);
      await clickAt(p, settle);
    };
    const btn = text => click(`window.__t.btn(${JSON.stringify(text)})`);
    const close = () => click(`document.querySelector('#pet .panel-head .x, #pet .popup-head .x')`);
    const closeIfOpen = async () => { if (await ev(`!!document.querySelector('#pet .panel, #pet .popup')`)) await close(); };
    const more = async item => { await btn('更多'); await click(`[...document.querySelectorAll('#pet .popup .row')].find(b => b.innerText.trim() === ${JSON.stringify(item)})`); };
    const mode = async name => {
      await click(`document.querySelector('#pet .pill.mode')`);
      await click(`[...document.querySelectorAll('#pet .popup .opt')].find(b => b.innerText.includes(${JSON.stringify(name)}))`, 800);
      await closeIfOpen();
    };

    await main.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 2, mobile: false });
    await main.send('Page.navigate', { url: base.href });
    await waitFor(`!!window.__t`, 30000);
    await ev(`localStorage.clear(), window.__t.idbClear()`);
    await main.send('Page.navigate', { url: base.href });
    if (!(await waitFor(`!!window.moyuDev && !!document.querySelector('#pet') && window.__t.save() === '已保存'`, 30000))) throw new Error('页面没加载出小窗');
    setBuild(await ev(`document.querySelector('meta[name=app-build]')?.content`));
    await sleep(800);

    // 前置：有币有鱼，再真钓一条让鱼篓带新鱼数（摸鱼：每 200 次判定一次，最晚第 2000 次保底出）
    await ev('window.moyuDev.addCoins(3000)');
    await ev('window.moyuDev.injectFish(6)');
    await mode('摸鱼');
    await ev(`document.querySelector('#notepad textarea')?.focus(), true`);
    for (let i = 0; i < 205 && !(await ev(`!!document.querySelector('#pet .badge')`)); i++) await main.press(10);
    const badge = await waitFor(`!!document.querySelector('#pet .badge')`, 5000);
    await sleep(4500); // 出鱼卡片自己收起

    // ── B8-01 两行 ──
    {
      const b = await ev('window.__g.bar()');
      const cy = r => (r.t + r.b) / 2, s = b.stats;
      const twoRows = Math.abs(cy(s.total.r) - cy(s.coins.r)) <= 6 && Math.abs(cy(s.cycle.r) - cy(s.save.r)) <= 6
        && cy(s.total.r) < cy(s.cycle.r) - 20 && s.total.r.l < s.coins.r.l && s.cycle.r.l < s.save.r.l;
      check('B8-01 底栏信息区两行：上行总、金币，下行本轮、保存状态；底栏高度位置不变、四项都在底栏里',
        twoRows && Math.abs(b.bar.t - 780) <= 1 && Math.abs(b.bar.b - 900) <= 1 && b.outside.length === 0,
        { bar: b.bar, rows: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, `${v.text} @${v.r.l},${v.r.t}`])), outside: b.outside });
    }

    // ── B8-02 三种模式，真实内容和最长内容 ──
    {
      const res = [];
      for (const m of MODES) {
        await mode(m.name);
        const real = await ev('window.__g.bar()');
        const longest = await ev(`(() => {
          const q = k => document.querySelector('#pet [data-stat=' + k + ']');
          const undo = [window.__g.swap(q('total'), ${JSON.stringify(LONG.total)}), window.__g.swap(q('coins'), ${JSON.stringify(LONG.coins)}),
            window.__g.swap(q('save'), ${JSON.stringify(LONG.save)}), window.__g.swap(q('cycle'), ${JSON.stringify(m.longest)})];
          const r = window.__g.bar(); undo.forEach(f => f()); return r;
        })()`);
        const cyc = real.stats.cycle.text.replace(/^本轮\s*/, '');
        res.push({ mode: m.name, cycle: cyc, fmt: m.fmt.test(cyc), real: [...real.hits, ...real.outside, ...real.cut], longest: [...longest.hits, ...longest.outside.map(x => '出区 ' + x), ...longest.cut.map(x => '截断 ' + x)] });
      }
      check('B8-02 底栏三种模式、最长内容（9999.9万、读档失败、各模式最长进度）都不重叠、不出区、不截断',
        badge && res.every(r => r.fmt && r.real.length === 0 && r.longest.length === 0), { badge, res });
      await mode('路亚');
    }

    // ── B8-03 更多 ──
    {
      await btn('更多');
      const r = await ev(`(() => { const g = window.__g, bb = g.R(document.querySelector('#pet .bottombar'));
        const rows = [...document.querySelectorAll('#pet .more-menu .row')].map(e => ({ t: e.innerText.trim(), b: g.R(e).b }));
        return { barTop: bb.t, rows, menu: g.R(document.querySelector('#pet .more-menu')) }; })()`);
      check('B8-03 "更多"弹窗三行都完整露在底栏上面，弹窗不出小窗',
        r.rows.length === 3 && r.rows.every(x => x.b <= r.barTop + 0.5) && r.menu.t >= 0 && r.menu.r <= 1600, r);
      await close();
    }

    // ── B8-04 提示条放最长一句 ──
    {
      await btn('鱼篓');
      await click(`document.querySelectorAll('#pet .fish-cell .tick')[0]`);
      await click(`document.querySelector('#pet .btn.sell')`);
      await click(`document.querySelector('#pet .btn.ok')`, 200);
      const shown = await waitFor(`!!document.querySelector('#pet .notice')`, 4000);
      const r = shown ? await ev(`(() => { const n = document.querySelector('#pet .notice'); const undo = window.__g.swap(n, ${JSON.stringify(INTRO)});
        const r = window.__g.notice(); undo(); return r; })()`) : null;
      check('B8-04 网页提示条放最长一句（TXT-PC-007）：字在条里、不压右上按钮、不出小窗', !!r && r.inText && !r.hitTop && r.inPet, r ?? '没弹出提示');
    }

    // ── B8-07 鱼篓格子最长体长 ──
    {
      const r = await ev(`(() => { const g = window.__g, cell = document.querySelector('#pet .basket .fish-cell'), len = cell.querySelector('.len');
        const undo = g.swap(len, ${JSON.stringify(LONG.len)});
        const c = g.R(cell), bw = 6; // 格子边框（设计像素）
        const inner = { l: c.l + bw, t: c.t + bw, r: c.r - bw, b: c.b - bw };
        const t = g.text(len), tick = g.R(cell.querySelector('.tick'));
        const res = { text: len.innerText, t, inner, tick, inCell: g.inside(t, inner, 0), hitTick: g.hit(t, tick, 0) }; undo(); return res; })()`);
      check('B8-07 鱼篓格子放最长体长"130.0 cm"：字在边框里面、不碰勾选框', r.inCell && !r.hitTick, r);
      await closeIfOpen();
    }

    // ── B8-08 收藏室标签 ──
    {
      await btn('收藏');
      const r = await ev(`(() => { const g = window.__g, el = document.querySelector('#pet .more-tanks'); if (!el) return null;
        const b = g.R(el), t = g.text(el), bw = 5;
        return { text: el.innerText.trim(), left: +(t.l - b.l - bw).toFixed(1), right: +(b.r - bw - t.r).toFixed(1), inY: t.t >= b.t && t.b <= b.b }; })()`);
      check('B8-08 收藏室"更多鱼缸尚未开放。"字到边框左右各留 12 以上，上下不出框', !!r && r.left >= 12 && r.right >= 12 && r.inY, r);
      await close();
    }

    // ── B8-06 皮肤 ──
    {
      await more('皮肤');
      const res = [];
      for (const tab of await ev(`[...document.querySelectorAll('#pet [data-tab]')].map(b => b.dataset.tab)`)) {
        await click(`document.querySelector('#pet [data-tab="${tab}"]')`);
        res.push(await ev(`(() => { const g = window.__g, panel = document.querySelector('#pet .skin'), P = g.R(panel), bad = [];
          let gridB = 0;
          for (const c of document.querySelectorAll('#pet .skin-cell')) {
            const nm = c.querySelector('.nm'), tag = c.querySelector('.tag'), C = g.R(c), N = g.text(nm);
            if (nm.getClientRects().length !== 1) bad.push('折行 ' + nm.innerText);
            if (!g.inside(N, C, 0)) bad.push('出卡 ' + nm.innerText);
            gridB = Math.max(gridB, C.b);
            if (tag) { const T = g.R(tag); gridB = Math.max(gridB, T.b);
              if (g.hit(T, N, 0)) bad.push('标签压名字 ' + nm.innerText);
              if (T.t < (C.t + C.b) / 2) bad.push('标签太高 ' + nm.innerText); }
          }
          for (const sel of ['.preview-row', '.preview-side .nm', '.preview-side .state', '.preview-side .btn']) {
            const e = document.querySelector('#pet .skin ' + sel); if (e && g.R(e).t < gridB) bad.push('压卡片行 ' + sel);
          }
          for (const e of panel.querySelectorAll('*')) {
            if (e.closest('svg') && e.tagName.toLowerCase() !== 'svg') continue;
            const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
            if (!g.inside(g.R(e), P, 1)) bad.push('出面板 ' + g.name(e));
            const txt = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
            if (txt && getComputedStyle(e).display !== 'inline' && g.cut(e) && !/auto|scroll/.test(getComputedStyle(e).overflowY)) bad.push('截断 ' + g.name(e));
          }
          return { tab: ${JSON.stringify(tab)}, bad: [...new Set(bad)] }; })()`));
      }
      check('B8-06 皮肤四个分类：卡片名字一行、标签不压名字、预览在卡片行下面、说明公示在面板里不截断', res.length === 4 && res.every(r => r.bad.length === 0), res);
      await close();
    }

    check('B8-09 网页控制台没有报错', consoleErrors.length === 0, consoleErrors.slice(0, 5));

    // ── B8-05 PC 首次后台输入提示 ──
    {
      if (!PACKED) {
        const r = spawnSync(process.execPath, [path.join(REPO, 'pc', 'build-web.mjs')], { cwd: path.join(REPO, 'pc'), stdio: 'inherit' });
        if (r.status !== 0) throw new Error('网页发布失败');
      }
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-b8-pc-'));
      const p = await launch({ userData, input: null, port: 9358 }); // 全新安装：后台输入默认开，浮出首次说明
      try {
        const shown = await p.waitFor(`!!document.querySelector('#pet .notice')`, 8000);
        const r = shown ? await p.ev(`(${GEOM.replace(/;$/, '')}, window.__g.notice())`) : null;
        check('B8-05 PC 首次后台输入提示：字在条里、不压右上按钮、不出小窗', !!r && r.inText && !r.hitTop && r.inPet, r ?? '没浮出首次说明');
        check('B8-09 PC 页面没有报错', p.errors.length === 0, p.errors.slice(0, 5));
      } finally {
        await p.kill();
      }
    }
  },
});
