#!/usr/bin/env node
// B1 网页核心循环浏览器验收：执行 doc/测试用例/B1 网页核心循环.md 里方式为 B 的用例，每个 check 名以用例号开头。
//
// 用法：
//   node tools/verify/b1.mjs [网址|--release] [输出目录]
//   --release：先照 CI 的方式发布本地 Release 包，挂在 http://127.0.0.1:5199/zhuomianmoyu/ 上测（推送前的主关卡）
//   网址默认线上 https://etsevenday.github.io/zhuomianmoyu/ ，脚本自动加 ?dev=1；开发中也可测 http://localhost:5188/
//   输出默认系统临时目录下 moyu-b1；环境变量 CHROME 指定浏览器、PLAYTEST_PORT 指定调试端口（默认 9341）
//
// 计数用的键鼠全部是 CDP Input.dispatch* 发的真实事件（isTrusted）。前置条件用两种办法造，都不算"玩家输入"：
//   - 开发入口 window.moyuDev（注入鱼、加金币、模拟保存失败、读当前档案）；
//   - 直接改 IndexedDB 里的档案再刷新（把本轮进度放到节点前一次、摆好已拥有的外观等），见 patch()。
// 抽取结果用和内核同一套 Dice 在这里算出来，好构造"下一抽必重复"这类前置（B1-19 的固定值在开头自检）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBatch, sleep, near } from './cdp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ───────────── 和内核一致的随机数（src/Core/Play/Dice.cs） ─────────────
const M64 = (1n << 64n) - 1n;
function hash(seed, key) {
  let h = 14695981039346656037n ^ seed;
  for (let i = 0; i < key.length; i++) { h ^= BigInt(key.charCodeAt(i)); h = (h * 1099511628211n) & M64; }
  h = (h + 0x9E3779B97F4A7C15n) & M64;
  h = ((h ^ (h >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
  h = ((h ^ (h >> 27n)) * 0x94D049BB133111EBn) & M64;
  return h ^ (h >> 31n);
}
const below = (seed, key, n) => Math.floor(Number(hash(seed, key) >> 11n) / 2 ** 53 * n);
const POOL = ['CHAR', 'ROD', 'GLOVE', 'SCENE'].flatMap(c => [1, 2, 3].map(i => `WEB_${c}_0${i}`));
const BASES = ['BASE_CHAR', 'BASE_ROD', 'BASE_GLOVE', 'BASE_SCENE'];
/** 下一抽会抽到什么（PlayEngine.Draw）。 */
function nextDraw(seed, drawSeq, owned, streak) {
  const cands = streak >= 4 ? POOL.filter(s => !owned.includes(s)) : POOL;
  return cands[below(seed, `draw|${drawSeq + 1}`, cands.length)];
}
const cm = mm => `${Math.floor(mm / 10)}.${mm % 10} cm`;
/** 改某组本轮次数，保留周期号（周期号是捕获事件键的一部分，倒回去会让新鱼和旧鱼撞同一个事件）。 */
const setCount = (p, g, n) => { p.Groups[g] = { Count: n, Cycle: p.Groups[g]?.Cycle ?? 0 }; };

// 页面里的取数小工具（每次加载自动注入）
const HELPERS = `window.__t = {
  scene(x, y) { const r = document.querySelector('svg.scene').getBoundingClientRect(); return { x: r.left + x / 1600 * r.width, y: r.top + y / 900 * r.height }; },
  rect(sel) { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; },
  center(el) { if (typeof el === 'string') el = document.querySelector(el); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; },
  inPet(x, y) { const e = document.elementFromPoint(x, y); return !!(e && e.closest('#pet')); },
  btn(text) { return [...document.querySelectorAll('#pet button'), ...document.querySelectorAll('button')].find(b => b.offsetParent !== null && (b.title === text || (b.innerText || '').trim() === text)); },
  panels() { return [...document.querySelectorAll('#pet .panel, #pet .popup')].map(e => e.className.replace(/\\b(panel|popup|solid)\\b/g, '').trim()); },
  bear() { const g = document.querySelector('svg.scene g.bear'); if (!g) return null; const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(g.getAttribute('transform')); return { x: +m[1], y: +m[2], mode: g.dataset.mode, skins: g.dataset.skins }; },
  stat(name) { const e = document.querySelector('[data-stat=' + name + ']'); return e ? { text: e.innerText.replace(/\\s+/g, ''), title: e.title } : null; },
  save() { return document.querySelector('[data-stat=save]')?.innerText.trim() ?? null; },
  prefs() { try { return JSON.parse(localStorage.getItem('moyu.prefs.v1') || 'null'); } catch { return 'bad'; } },
  blank() {
    const d = document.querySelector('.desktop'), r = d.getBoundingClientRect();
    for (let fy = 0.9; fy > 0.3; fy -= 0.05) for (let fx = 0.35; fx < 0.7; fx += 0.03) {
      const x = r.left + fx * r.width, y = r.top + fy * r.height;
      if (document.elementFromPoint(x, y) === d && document.elementFromPoint(x + 40, y) === d && document.elementFromPoint(x, y + 40) === d) return { x, y };
    }
    return null;
  },
  idb(op, rec) {
    return new Promise((ok, bad) => {
      const r = indexedDB.open('zhuomianmoyu-play', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('profile');
      r.onerror = () => bad(r.error);
      r.onsuccess = () => {
        const db = r.result, tx = db.transaction('profile', op === 'get' ? 'readonly' : 'readwrite'), st = tx.objectStore('profile');
        const q = op === 'get' ? st.get('main') : op === 'put' ? st.put(rec, 'main') : st.delete('main');
        let val = null;
        q.onsuccess = () => { if (op === 'get') val = q.result ?? null; };
        tx.oncomplete = () => { db.close(); ok(val); };
        tx.onerror = () => { db.close(); bad(tx.error); };
      };
    });
  },
};`;

await runBatch({
  batch: 'b1',
  helpers: HELPERS,
  async run({ main, base, check, openTab, closeTab, consoleErrors, setBuild }) {
    const { ev, waitFor, clickAt, dblClickAt, dragBy, key, keyUp, press, shot, send } = main;
    const T = expr => ev(`window.__t.${expr}`);
    const P = () => ev('window.moyuDev.profile()');
    const total = async () => (await P()).LifetimeInputs;
    const acts = () => ev('window.moyuPlay.acts');
    const group = (p, g) => p.Groups[g]?.Count ?? 0;
    const focusNotepad = () => ev(`document.querySelector('#notepad textarea').focus(); true`);

    async function load(expect = ['已保存']) {
      await send('Page.navigate', { url: base.href });
      const ok = await waitFor(`!!window.__t && !!window.moyuPlay && !!document.querySelector('.taskbar') && !!(document.querySelector('#pet') || document.querySelector('#avatar'))`, 30000);
      if (!ok) throw new Error('页面没加载出小窗');
      if (expect && !(await waitFor(`${JSON.stringify(expect)}.includes(window.__t.save()) || !document.querySelector('#pet')`, 15000))) throw new Error('存档状态不对：' + await T('save()'));
      await sleep(300);
    }
    /** 等防抖保存落盘。 */
    async function settle() { await sleep(1000); return waitFor(`window.__t.save() === '已保存'`, 10000); }
    /** 等页面把已发出的输入都处理完：总累计到 n。 */
    const waitTotal = (n, ms = 30000) => waitFor(`window.moyuDev.profile().then(p => p.LifetimeInputs === ${n})`, ms);
    /** 读 IndexedDB 里的原始存档；Seed 按字符串取，避免 64 位整数丢精度。 */
    async function raw() {
      const rec = await T(`idb('get')`);
      return rec && { ...rec, seed: BigInt(/"Seed":(\d+)/.exec(rec.json)[1]) };
    }
    /** 改存档再刷新：fn 收到解析后的档案对象（Seed 以外）。修订号跳开，旧页面迟到的保存会被拒，不会盖掉改动。 */
    async function patch(fn) {
      await settle();
      const rec = await raw();
      const p = JSON.parse(rec.json.replace(/"Seed":(\d+)/, '"Seed":"$1"'));
      fn(p);
      const json = JSON.stringify(p).replace(/"Seed":"(\d+)"/, '"Seed":$1');
      await T(`idb('put', ${JSON.stringify({ revision: rec.revision + 1000, json })})`);
      await load();
      return rec.seed;
    }
    async function clickBtn(text, settle = 300) {
      const p = await T(`center(window.__t.btn(${JSON.stringify(text)}))`);
      if (!p) throw new Error(`找不到按钮：${text}`);
      await clickAt(p, settle);
    }
    /** 真实单击一个元素；在可滚动的列表里先把它滚进视野。 */
    const clickSel = async (sel, settle = 300) => {
      const p = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); return window.__t.center(e); })()`);
      if (!p) throw new Error(`找不到：${sel}`);
      await clickAt(p, settle);
    };
    /** 按文字找元素再真实单击。 */
    const clickText = async (sel, text, settle = 300) => {
      const p = await T(`center([...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.innerText.includes(${JSON.stringify(text)})))`);
      if (!p) throw new Error(`找不到：${sel} ${text}`);
      await clickAt(p, settle);
    };
    /** 缸里的鱼可能叠在一起，选鱼这种管理点击直接派发给那条鱼。 */
    /** 点确认出售，等确认框收起、存好。 */
    const confirmSale = async () => { await clickSel('.confirm .ok', 100); await waitFor(`!document.querySelector('.confirm') && window.__t.save() === '已保存'`, 10000); };
    const pickTankFish = async id => { await ev(`document.querySelector('.tank .tank-fish[data-fish="${id}"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); true`); await sleep(250); };
    const scenePt = (x, y) => T(`scene(${x}, ${y})`);
    async function closePanels() {
      for (let i = 0; i < 3; i++) {
        const x = await T(`center(document.querySelector('#pet .panel-head .x, #pet .popup-head .x'))`);
        if (!x) return;
        await clickAt(x);
      }
    }
    async function openPanel(name) {
      await closePanels();
      if (['地图', '皮肤', '设置'].includes(name)) { await clickBtn('更多'); await clickBtn(name); } else await clickBtn(name);
    }
    async function setMode(name) {
      const cur = await ev(`document.querySelector('#pet .mode span').innerText`);
      if (cur === name) return;
      await closePanels();
      await clickBtn(cur); await clickBtn(name);
    }
    async function setMap(i) {
      await openPanel('地图');
      await clickSel(`.map-row:nth-child(${i})`);
      await closePanels();
    }
    const statText = async name => (await T(`stat('${name}')`))?.text;

    // ───── 自检：和内核同一套随机数 ─────
    check('Dice 与内核一致（B1-19 固定值）', hash(0n, '') === 14087677454934409008n && hash(1n, 'node|lure|map1|0|500') === 2690795027776215785n
      && hash(123456789n, 'draw|1') === 12014624369320284897n);

    // ───── B1-21 / B1-26 / B1-27 新档 ─────
    await load();
    setBuild(await ev(`document.querySelector('meta[name=app-build]')?.content`));
    {
      const p = await P(), b = await T('bear()'), scene = await ev(`document.querySelector('svg.scene').dataset.scene`);
      const fresh = p.Revision === 1 && p.Tanks.length === 1 && p.Tanks[0].Id === 'tank1' && p.Tanks[0].Capacity === 20 && p.Fish.length === 0 && p.Coins === 0
        && Object.keys(p.Records).length === 0 && p.Ledger.length === 0 && BASES.every(s => Object.values(p.Equipped).includes(s)) && b.skins === 'BASE_CHAR BASE_ROD BASE_GLOVE' && scene === 'BASE_SCENE';
      await load();
      const p2 = await P();
      check('B1-21 新档：1 个鱼缸容量 20、空；金币 0；鱼篓和记录空；四类装备默认；刷新后不多发', fresh && p2.Revision === 1 && p2.Fish.length === 0 && p2.Coins === 0,
        { rev: [p.Revision, p2.Revision], tanks: p.Tanks, coins: p.Coins, equipped: p.Equipped, skins: b.skins, scene });
      await openPanel('鱼篓');
      const cells = await ev(`document.querySelectorAll('.basket .fish-cell').length`), empty = await ev(`!!document.querySelector('.basket .empty')`);
      await closePanels();
      const offenders = [];
      (function walk(d) {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, f.name);
          if (f.isDirectory()) { if (!['bin', 'obj'].includes(f.name)) walk(fp); }
          else if (/\.(cs|razor|js|html)$/.test(f.name) && /SampleData|SampleFish/.test(fs.readFileSync(fp, 'utf8'))) offenders.push(fp);
        }
      })(path.join(REPO, 'web/Moyu.Web'));
      check('B1-26 新档鱼篓空；网页代码里没有示例鱼', cells === 0 && empty && offenders.length === 0, { cells, offenders });
      const st = await ev(`(async () => ({ dbs: (await indexedDB.databases()).map(d => d.name), ls: Object.keys(localStorage) }))()`);
      check('B1-27 玩法档在 IndexedDB（库名含 zhuomianmoyu），窗口偏好仍在 localStorage 的 moyu.prefs.v1，两者分开',
        st.dbs.includes('zhuomianmoyu-play') && st.ls.every(k => k === 'moyu.prefs.v1'), st);
    }

    // ───── B1-48 底栏 ─────
    {
      const s = await ev(`[...document.querySelectorAll('.stats [data-stat]')].map(e => e.dataset.stat)`);
      const r = await T(`rect('.bottombar')`), d = await T(`rect('#pet .design')`);
      const scale = (await T(`rect('#pet')`)).w / 1600;
      const top = await ev(`[...document.querySelectorAll('#pet .topbar > *')].map(e => e.title)`);
      check('B1-48 底栏常驻总累计、本轮进度、金币、保存状态；底栏 120 设计单位高；顶栏只有四个按钮、没有标题',
        ['total', 'cycle', 'coins', 'save'].every(k => s.includes(k)) && near(r.h / scale, 120, 0.5) && top.length === 4 && !(await ev(`!!document.querySelector('#pet .title, #pet h1')`)),
        { stats: s, height: +(r.h / scale).toFixed(2), top, design: d });
    }

    // ───── B1-01 输入归属 ─────
    const blank = await T('blank()');
    if (!blank) throw new Error('找不到桌面空白处');
    {
      const t0 = await total(), a0 = await acts();
      await clickAt(blank);
      await clickText('.desk-icon', '此电脑');
      await clickSel('#notepad textarea');
      await clickSel('.taskbar .clock');
      const sky = await scenePt(800, 120);
      const skyThrough = !(await T(`inPet(${sky.x}, ${sky.y})`));
      await clickAt(sky);
      await focusNotepad();
      await key('a');
      await ev(`document.activeElement.blur(); true`);
      await key('b');
      await waitTotal(t0 + 7, 5000);
      const p = await P(), a1 = await acts();
      check('B1-01 桌面空白、桌面图标、记事本正文、任务栏时钟、小窗天空（穿透）各点一下，记事本里按 A、页面空白处按 B：总累计 7、路亚本轮 7、小熊动作 7 次',
        p.LifetimeInputs - t0 === 7 && group(p, 'lure|map1') === 7 && a1 - a0 === 7 && skyThrough, { total: p.LifetimeInputs - t0, cycle: group(p, 'lure|map1'), acts: a1 - a0, skyThrough });
    }

    // ───── B1-02 键盘 ─────
    {
      await focusNotepad();
      const step = async (name, fn, want) => {
        const t0 = await total();
        await fn();
        await sleep(400);
        const d = (await total()) - t0;
        check(`B1-02 ${name}：+${want}`, d === want, { got: d });
      };
      await step('按住 A 连发 5 次再松开', async () => {
        await key('a', { up: false });
        for (let i = 0; i < 5; i++) await key('a', { repeat: true, up: false });
        await keyUp('a');
      }, 1);
      await step('Ctrl+C', async () => { await key('Control', { up: false }); await key('c', { modifiers: 2 }); await keyUp('Control'); }, 2);
      await step('输入法提交一次（Process 按下 + 插入"你好"）', async () => { await key('Process', { up: false }); await send('Input.insertText', { text: '你好' }); }, 1);
      await step('只插入文字、没有按键', () => send('Input.insertText', { text: 'abc' }), 0);
    }

    // ───── B1-03 鼠标 ─────
    {
      const step = async (name, fn, want) => {
        const t0 = await total();
        await fn();
        await sleep(400);
        const d = (await total()) - t0;
        check(`B1-03 ${name}：+${want}`, d === want, { got: d });
      };
      const b = blank;
      await step('左键单击', () => clickAt(b), 1);
      await step('双击', () => dblClickAt(b), 2);
      await step('右键单击', () => clickAt(b, 300, 'right'), 1);
      await step('中键单击', () => clickAt(b, 300, 'middle'), 1);
      await step('只移动', async () => { for (let i = 0; i < 10; i++) await main.mouse('mouseMoved', b.x + i * 5, b.y); }, 0);
      await step('滚轮', () => main.mouse('mouseWheel', b.x, b.y, { deltaY: 120 }), 0);
      await step('按下后移 30 像素再松开（拖）', () => dragBy(b, 30, 0), 0);
      await step('按下后移 3 像素再松开', () => dragBy(b, 3, 0, 3), 1);
    }

    // ───── B1-04 管理操作不计 ─────
    {
      await settle();
      const t0 = await total(), a0 = await acts();
      for (const p of ['鱼篓', '收藏', '记录']) { await clickBtn(p); await clickBtn(p); }
      for (const p of ['地图', '皮肤', '设置']) { await clickBtn('更多'); await clickBtn(p); await clickBtn('更多'); }
      await clickBtn('房间'); await clickBtn('房间');
      await setMode('摸鱼'); await setMode('路亚');
      await clickAt(await scenePt(1000, 565));
      await clickAt(await scenePt(140, 565));
      await dragBy(await scenePt(800, 700), -40, -20);
      await clickBtn('收起');
      await dragBy(await T(`center('#avatar')`), -30, -20);
      await clickAt(await T(`center('#avatar')`));
      await clickSel('.taskbar button[title=桌面摸鱼]'); await clickSel('.taskbar button[title=桌面摸鱼]');
      await clickBtn('关闭');
      await dblClickAt(await T(`center([...document.querySelectorAll('.desk-icon')].find(b => b.innerText.includes('桌面摸鱼')))`));
      await ev(`document.querySelector('#pet .bottombar .tab[title=鱼篓]').focus(); true`);
      await key('Enter'); await sleep(300);
      await closePanels();
      await openPanel('设置');
      await clickSel('.setting-row [role=switch]');
      await closePanels();
      const sky = await scenePt(800, 120);
      const captured = await T(`inPet(${sky.x}, ${sky.y})`);
      await clickAt(sky);
      await openPanel('设置');
      await clickSel('.setting-row [role=switch]');
      await closePanels();
      await clickText('.dev-strip button', '+100');
      await sleep(400);
      const t1 = await total(), a1 = await acts();
      check('B1-04 开关各面板、切模式、选位、放不下、拖窗、收起/拖头像/恢复、任务栏、关闭后双击图标打开、按钮上按 Enter、穿透关时点留白、点开发条：都不计数、小熊不动作',
        t1 === t0 && a1 === a0 && captured, { total: [t0, t1], acts: [a0, a1], captured });
    }

    // ───── B1-05 合成事件、失焦 ─────
    {
      const t0 = await total();
      await ev(`(() => {
        const ta = document.querySelector('#notepad textarea');
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9 }));
        document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
        window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        return true; })()`);
      await send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await send('Emulation.setFocusEmulationEnabled', { enabled: false });
      await sleep(400);
      check('B1-05 脚本合成的键盘/点击/指针事件、失焦与恢复焦点、visibilitychange 都不计', (await total()) === t0, { total: [t0, await total()] });
    }

    // ───── B1-06 收起照计、关闭不计 ─────
    {
      const t0 = await total();
      await clickBtn('收起');
      await focusNotepad(); await press(3);
      await sleep(400);
      const t1 = await total();
      await clickAt(await T(`center('#avatar')`));
      check('B1-06 收起期间按键照常计数（+3）', t1 - t0 === 3, { delta: t1 - t0 });
      await clickBtn('关闭');
      await focusNotepad(); await press(3);
      await sleep(400);
      const t2 = await total();
      await clickSel('.taskbar button[title=桌面摸鱼]');
      const shown = await statText('total');
      check('B1-06 关闭期间按键不计（+0），重新打开后显示关闭前的数字', t2 === t1 && shown === `总${t1}`, { delta: t2 - t1, shown });
    }

    // ───── B1-08 短动作 ─────
    {
      await focusNotepad();
      const a0 = await acts(), t0 = await total();
      await press(30);
      await waitTotal(t0 + 30, 10000);
      const a1 = await acts();
      await sleep(1000);
      const anim = await ev(`document.querySelector('svg.scene g.bear .pose').getAnimations().length`);
      check('B1-08 连发 30 次：动作 30 次；停 1 秒后小熊不在动作中', a1 - a0 === 30 && anim === 0, { acts: a1 - a0, running: anim });
    }

    // ───── B1-09 降速 ─────
    {
      const t0 = await total();
      await send('Emulation.setCPUThrottlingRate', { rate: 6 });
      await focusNotepad();
      await press(200);
      const ok = await waitTotal(t0 + 200, 60000);
      await send('Emulation.setCPUThrottlingRate', { rate: 1 });
      check('B1-09 CPU 降速 6 倍时连发 200 次：总累计正好 +200', ok && (await total()) === t0 + 200, { delta: (await total()) - t0 });
    }

    // ───── B1-07 手竿 ─────
    {
      await settle();
      const p0 = await P();
      await setMode('手竿');
      const cyc = await statText('cycle');
      await focusNotepad();
      await press(3000);
      await waitTotal(p0.LifetimeInputs + 3000, 60000);
      const p1 = await P();
      await setMode('路亚');
      const same = Object.keys(p0.Groups).every(g => group(p0, g) === group(p1, g)) && Object.keys(p1.Groups).every(g => g.startsWith('pole') || group(p0, g) === group(p1, g));
      check('B1-07 手竿 3000 次：总累计和手竿统计 +3000，路亚/摸鱼本轮不变、不出鱼，底栏写"计时未开放"、没有倒计时数字',
        p1.LifetimeInputs - p0.LifetimeInputs === 3000 && (p1.ModeInputs.pole ?? 0) - (p0.ModeInputs.pole ?? 0) === 3000 && same && p1.Fish.length === p0.Fish.length
        && cyc.includes('计时未开放') && !/\d/.test(cyc), { total: p1.LifetimeInputs - p0.LifetimeInputs, pole: p1.ModeInputs.pole, cycle: cyc, fish: p1.Fish.length });
    }

    // ───── B1-51 / B1-14 / B1-50 新鱼获卡片 ─────
    {
      await patch(p => { setCount(p, 'lure|map1', 999); setCount(p, 'wade|map1', 1999); });
      await closePanels();
      const p0 = await P();
      await focusNotepad();
      await key('k');
      const shown = await waitFor(`!!document.querySelector('.catch-card')`, 5000);
      const t = Date.now();
      const p1 = await P();
      const fish = p1.Fish.find(f => !p0.Fish.some(g => g.Id === f.Id));
      const card = await ev(`(() => { const c = document.querySelector('.catch-card'); return c && { id: c.dataset.fish, count: c.dataset.count, text: c.innerText, guaranteed: !!c.querySelector('[data-guaranteed]') }; })()`);
      // 卡片冒在小熊头顶：横向盖住小熊所在的竖线（贴边时夹住），整张在小熊脚下以上
      const over = await ev(`(() => { const c = document.querySelector('.catch-card').getBoundingClientRect(), b = window.__t.bear(), p = window.__t.scene(b.x, b.y); return c.left <= p.x && p.x <= c.right && c.bottom < p.y; })()`);
      const st = await ev(`({ focus: document.activeElement?.tagName, panels: window.__t.panels() })`);
      await shot('01-catch-card');
      check('B1-51 出鱼后卡片冒在小熊头顶，显示这条鱼和体长，保底出的带标记；焦点仍在记事本、没有自动开面板',
        shown && fish && card.id === fish.Id && card.text.includes(cm(fish.LengthMm)) && card.guaranteed && fish.Guaranteed && over && st.focus === 'TEXTAREA' && st.panels.length === 0,
        { card, over, fish: fish && [fish.Id, fish.LengthMm, fish.Guaranteed], ...st });
      const others = Object.keys(p0.Groups).filter(g => g !== 'lure|map1').every(g => group(p0, g) === group(p1, g));
      check('B1-14 出鱼只清本轮：总累计、路亚统计照加，只有地图一路亚本轮归零',
        p1.LifetimeInputs === p0.LifetimeInputs + 1 && p1.ModeInputs.lure === p0.ModeInputs.lure + 1 && group(p1, 'lure|map1') === 0
        && p1.Groups['lure|map1'].Cycle === p0.Groups['lure|map1'].Cycle + 1 && others, { total: [p0.LifetimeInputs, p1.LifetimeInputs], lure: [p0.ModeInputs.lure, p1.ModeInputs.lure], group: p1.Groups['lure|map1'] });
      await sleep(Math.max(0, 3400 - (Date.now() - t)));
      const still = await ev(`!!document.querySelector('.catch-card')`);
      await sleep(1300);
      const gone = await ev(`!document.querySelector('.catch-card')`);
      check('B1-51 卡片约 4 秒后自己消失（3.4 秒还在、4.7 秒已没）', still && gone, { still, gone });

      // 两条连着出：合成 +2；卡片在时岸边、浅水都能选位
      await patch(p => { setCount(p, 'lure|map1', 999); });
      await closePanels();
      await focusNotepad();
      await key('k');
      await waitFor(`!!document.querySelector('.catch-card')`, 5000);
      const cardRect = await T(`rect('.catch-card')`), shoreTop = (await scenePt(0, 528)).y;
      const b0 = await T('bear()');
      await clickAt(await scenePt(b0.x > 800 ? 600 : 1000, 565));
      const b1 = await T('bear()');
      await setMode('摸鱼');
      const bw = await T('bear()');
      await focusNotepad();
      await key('k');
      await waitFor(`document.querySelector('.catch-card')?.dataset.count === '2'`, 5000);
      await clickAt(await scenePt(bw.x > 800 ? 450 : 1450, 700));
      const b2 = await T('bear()');
      const two = await ev(`(() => { const c = document.querySelector('.catch-card'); return c && { id: c.dataset.fish, count: c.dataset.count, text: c.innerText }; })()`);
      check('B1-50 卡片在时：单击岸边、浅水（摸鱼）都能选位；卡片不压岸和浅水',
        b1.x !== b0.x && b2.x !== bw.x && b2.mode === 'Wade' && cardRect.y + cardRect.h < shoreTop, { bears: [b0, b1, bw, b2], cardBottom: cardRect.y + cardRect.h, shoreTop });
      await shot('02-catch-card-2');
      await clickSel('.catch-card');
      const focusOn = await ev(`document.querySelector('.basket .fish-cell.on')?.dataset.fish`);
      check('B1-51 几秒内连出两条合成一张"+2"；点卡片打开鱼篓并选中最新那条',
        two && two.count === '2' && two.text.includes('+2') && (await T('panels()')).some(p => p.includes('basket')) && focusOn === two.id, { two, focusOn });
      await closePanels();
      await setMode('路亚');
    }

    // ───── B1-49 / B1-48 下一节点与大数字 ─────
    {
      await patch(p => {
        setCount(p, 'lure|map1', 0); setCount(p, 'lure|map2', 500);
        setCount(p, 'wade|map1', 0); setCount(p, 'wade|map2', 1800);
        p.LifetimeInputs = 123456; p.Coins = 98765;
      });
      const seen = [];
      await setMap(1); seen.push(await statText('cycle'));
      await setMap(2); seen.push(await statText('cycle'));
      await setMode('摸鱼'); await setMap(1); seen.push(await statText('cycle'));
      await setMap(2); seen.push(await statText('cycle'));
      check('B1-49 下一节点：路亚 0 → /500，500 判定失败后 → /1000，摸鱼 0 → /200，1800 → /2000 保底',
        seen[0] === '本轮0/500' && seen[1].startsWith('本轮500/1000') && seen[2] === '本轮0/200' && seen[3] === '本轮1800/2000保底', seen);
      const tot = await T(`stat('total')`), coins = await T(`stat('coins')`);
      check('B1-48 大数字缩写，悬停提示里是完整整数', tot.text === '总12.3万' && tot.title.includes('123456') && coins.title.includes('98765'), { tot, coins });
      await setMode('路亚'); await setMap(1);
    }

    // ───── B1-17 按模式×地图分别记 ─────
    {
      await patch(p => { setCount(p, 'lure|map1', 400); setCount(p, 'lure|map2', 0); setCount(p, 'wade|map2', 0); p.Coins = 0; });
      const p0 = await P();
      await setMap(2);
      const c0 = await statText('cycle');
      await focusNotepad(); await press(50); await waitTotal(p0.LifetimeInputs + 50);
      const c1 = await statText('cycle');
      await setMode('摸鱼');
      const c2 = await statText('cycle');
      await setMode('路亚'); await setMap(1);
      const c3 = await statText('cycle');
      await focusNotepad(); await press(100); await waitTotal(p0.LifetimeInputs + 150);
      await settle();
      const p1 = await P();
      const g1 = p1.Groups['lure|map1'], cyc0 = p0.Groups['lure|map1'].Cycle;
      const caught = p1.Fish.filter(f => !p0.Fish.some(g => g.Id === f.Id));
      const judged = (g1.Count === 500 && g1.Cycle === cyc0 && caught.length === 0) || (g1.Count === 0 && g1.Cycle === cyc0 + 1 && caught.length === 1
        && caught[0].MapId === 'map1' && ['TMP_F001', 'TMP_F002', 'TMP_F003', 'TMP_F101'].includes(caught[0].SpeciesId));
      await load();
      const p2 = await P();
      check('B1-17 地图一路亚 400 → 地图二路亚从 0 记到 50 → 地图二摸鱼 0 → 回地图一路亚仍 400，再 100 次到 500 用地图一鱼池判定；刷新后各组都在',
        c0 === '本轮0/500' && c1 === '本轮50/500' && c2 === '本轮0/200' && c3 === '本轮400/500' && judged && group(p1, 'lure|map2') === 50
        && JSON.stringify(p2.Groups) === JSON.stringify(p1.Groups), { seen: [c0, c1, c2, c3], g1, caught: caught.map(f => f.SpeciesId + '@' + f.MapId) });
    }

    // ───── 收藏：B1-29 / B1-32 / B1-30 / B1-31 ─────
    const basketIds = () => ev(`[...document.querySelectorAll('.basket .fish-cell')].map(c => c.dataset.fish)`);
    async function selectFish(id) { await clickSel(`.basket .fish-cell[data-fish="${id}"] .pick`); }
    {
      await ev('window.moyuDev.injectFish(4)');
      await settle();
      await openPanel('鱼篓');
      const [id] = await basketIds();
      const before = (await P()).Fish.find(f => f.Id === id);
      await selectFish(id);
      await clickSel('.basket .collect');
      const p1 = await P();
      const inTank = p1.Fish.filter(f => f.Id === id);
      const gone = !(await basketIds()).includes(id);
      await openPanel('收藏');
      await pickTankFish(id);
      const tankLen = await ev(`document.querySelector('.tank-side .len')?.innerText`);
      await clickSel('.tank-side .retrieve');
      const p2 = await P();
      const back = p2.Fish.filter(f => f.Id === id);
      check('B1-29 放入收藏再取回：同一条鱼（编号、体长不变），任一时刻只在一处、不出副本',
        inTank.length === 1 && inTank[0].Place === 'Tank' && gone && back.length === 1 && back[0].Place === 'Basket' && back[0].LengthMm === before.LengthMm && tankLen === cm(before.LengthMm)
        && p2.Fish.length === p1.Fish.length, { before: [before.Id, before.LengthMm], inTank: inTank.map(f => f.Place), back: back.map(f => f.Place) });

      // B1-32 收藏的鱼不能卖
      await openPanel('鱼篓');
      await selectFish(id);
      await clickSel('.basket .collect');
      const listed = (await basketIds()).includes(id);
      await openPanel('收藏');
      await pickTankFish(id);
      await clickSel('.tank-side .retrieve');
      await openPanel('鱼篓');
      await selectFish(id);
      const sellable = await ev(`!document.querySelector('.basket .sell').disabled`);
      check('B1-32 在缸里时不在可出售的鱼篓列表里；取回后可选中、出售可用', !listed && sellable, { listed, sellable });

      // B1-30 设为背景
      const ids = (await basketIds()).slice(0, 2);
      for (const f of ids) { await selectFish(f); await clickSel('.basket .collect'); }
      const prefs0 = await T('prefs()'), bear0 = await T('bear()');
      await openPanel('收藏');
      await clickSel('.collection .background');
      await waitFor(`document.querySelector('.collection .background').dataset.on === 'true'`, 5000);
      await closePanels();
      const bg = await ev(`[...document.querySelectorAll('svg.scene .bg-fish')].map(g => g.dataset.fish)`);
      const pe = await ev(`[...document.querySelectorAll('svg.scene .bg-fish')].map(g => getComputedStyle(g).pointerEvents)`);
      const hit = await ev(`(() => { const g = document.querySelector('svg.scene .bg-fish .fish'); const r = g.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e?.closest('[data-hit]')?.getAttribute('data-hit') ?? e?.tagName; })()`);
      await shot('03-background');
      const prefs1 = await T('prefs()'), bear1 = await T('bear()');
      check('B1-30 设为背景：场景水里游着缸里这 2 条；观赏鱼不接指针（点到的是水）；地图、模式、落点不变',
        bg.length === 2 && ids.every(i => bg.includes(i)) && pe.every(v => v === 'none') && hit === 'water' && prefs1.MapId === prefs0.MapId && prefs1.Mode === prefs0.Mode && bear1.x === bear0.x,
        { bg, pe, hit });

      // B1-31 同缸同比例
      const ratio = sel => ev(`[...document.querySelectorAll('${sel}')].map(g => ({ len: +g.dataset.len, s: +/scale\\(([\\d.]+)\\)/.exec(g.querySelector('.fish').getAttribute('transform'))[1] }))`);
      const bgR = await ratio('svg.scene .bg-fish');
      await openPanel('收藏');
      const tkR = await ratio('.tank .tank-fish');
      const same = rs => rs.length >= 2 && new Set(rs.map(r => r.len)).size >= 2 && rs.every(r => near(r.s / r.len, rs[0].s / rs[0].len, 0.001 * rs[0].s / rs[0].len));
      // 体长数字一致：同一条鱼在鱼篓格子、鱼篓详情、出售确认、收藏室详情里一样
      await pickTankFish(ids[0]);
      const lenTank = await ev(`document.querySelector('.tank-side .len').innerText`);
      await clickSel('.tank-side .retrieve');
      await openPanel('鱼篓');
      await selectFish(ids[0]);
      const lenCell = await ev(`document.querySelector('.basket .fish-cell[data-fish="${ids[0]}"] .len').innerText`);
      const lenDetail = await ev(`document.querySelector('.basket .fish-detail .len').innerText`);
      await clickSel('.basket .sell');
      const lenQuote = await ev(`document.querySelector('.confirm .line-row span:nth-child(2)').innerText`);
      await clickSel('.confirm .cancel');
      const mm = (await P()).Fish.find(f => f.Id === ids[0]).LengthMm;
      check('B1-31 鱼缸和背景里各鱼缩放比 = 体长比；同一条鱼在收藏、鱼篓、报价里的体长一样',
        same(bgR) && same(tkR) && [lenTank, lenCell, lenDetail, lenQuote].every(s => s === cm(mm)), { bgR, tkR, lens: [lenTank, lenCell, lenDetail, lenQuote], mm });

      // B1-30 取回一条背景马上少一条；取消背景就没有
      await closePanels();
      const n1 = await ev(`document.querySelectorAll('svg.scene .bg-fish').length`);
      await openPanel('收藏');
      const onBefore = await ev(`document.querySelector('.collection .background').dataset.on`);
      await clickSel('.collection .background');
      const flipped = await waitFor(`document.querySelector('.collection .background').dataset.on === 'false'`, 5000);
      await closePanels();
      const n0 = await ev(`document.querySelectorAll('svg.scene .bg-fish').length`);
      check('B1-30 取回一条后背景只剩 1 条；取消背景后没有', n1 === 1 && n0 === 0, { afterRetrieve: n1, afterUnset: n0, onBefore, flipped });
    }

    // ───── 出售：B1-35 / B1-36 / B1-39 ─────
    {
      await ev('window.moyuDev.injectFish(3)');
      await settle();
      await openPanel('鱼篓');
      const p0 = await P();
      const [id] = await basketIds();
      await selectFish(id);
      const price = +(await ev(`document.querySelector('.basket .fish-detail .chip').dataset.price`));
      await clickSel('.basket .sell');
      const q = await ev(`({ lines: [...document.querySelectorAll('.confirm .line-row')].map(r => [r.dataset.fish, +r.dataset.price]), total: +document.querySelector('.confirm .total').dataset.total, title: document.querySelector('.confirm b').innerText })`);
      await confirmSale();
      const p1 = await P();
      const notice = await ev(`document.querySelector('.notice')?.innerText ?? ''`);
      const shown = { bottom: (await T(`stat('coins')`)).title, wallet: await ev(`document.querySelector('.basket .wallet').innerText.trim()`) };
      check('B1-35 选一条 → 出售 → 确认框写条数、单价、合计 → 确认：鱼离开鱼篓、金币 + 合计，底栏、鱼篓顶部、回执余额一致，账本多一条',
        q.lines.length === 1 && q.lines[0][0] === id && q.lines[0][1] === price && q.total === price && q.title.includes('1 条')
        && !(await basketIds()).includes(id) && p1.Coins === p0.Coins + price && shown.bottom === `金币 ${p1.Coins}` && shown.wallet === String(p1.Coins)
        && notice.includes(`余额 ${p1.Coins}`) && p1.Ledger.length === p0.Ledger.length + 1, { q, price, coins: [p0.Coins, p1.Coins], shown, notice });

      const three = (await basketIds()).slice(0, 3);
      await clickSel(`.basket .fish-cell[data-fish="${three[0]}"] .tick`);
      await clickSel(`.basket .fish-cell[data-fish="${three[1]}"] .tick`);
      await clickSel('.basket .sell');
      const q2 = await ev(`({ lines: [...document.querySelectorAll('.confirm .line-row')].map(r => +r.dataset.price), total: +document.querySelector('.confirm .total').dataset.total })`);
      await clickSel('.confirm .cancel');
      const p2 = await P();
      await clickSel('.basket .sell');
      await confirmSale();
      const p3 = await P();
      const left = await basketIds();
      check('B1-36 勾 2 条出售：取消后鱼和金币都不变；确认后合计 = 两条单价之和，没勾的那条还在',
        q2.lines.length === 2 && q2.total === q2.lines[0] + q2.lines[1] && p2.Coins === p1.Coins && p2.Fish.length === p1.Fish.length
        && p3.Coins === p2.Coins + q2.total && !left.includes(three[0]) && !left.includes(three[1]) && left.includes(three[2]), { q2, coins: [p1.Coins, p2.Coins, p3.Coins] });

      await clickSel('.basket .btn.small');
      const rows = await ev(`[...document.querySelectorAll('.ledger-row')].map(r => ({ time: r.querySelector('.time').innerText, kind: r.querySelector('.kind').innerText, what: r.querySelector('.what').innerText, delta: r.querySelector('.delta').innerText, bal: +r.dataset.balance }))`);
      const coinsNow = (await P()).Coins;
      check('B1-39 账本每条有时间、类型、对象、增减、交易后余额；最新一条余额 = 底栏余额',
        rows.length === p3.Ledger.length && rows.every(r => r.time && r.kind && r.what && /^[+-]\d+$/.test(r.delta)) && rows[0].bal === coinsNow && (await T(`stat('coins')`)).title === `金币 ${coinsNow}`, { rows: rows.slice(0, 3), coinsNow });
      await closePanels();
    }

    // ───── B1-23 保存失败 ─────
    {
      await ev('window.moyuDev.injectFish(1)');
      await settle();
      await openPanel('鱼篓');
      const p0 = await P();
      await ev('window.moyuDev.failSaves(true)');
      const [id] = await basketIds();
      await selectFish(id);
      await clickSel('.basket .sell');
      await clickSel('.confirm .ok', 600);
      const n1 = await ev(`({ text: document.querySelector('.notice')?.innerText ?? '', error: document.querySelector('.notice')?.dataset.error })`);
      await clickSel('.confirm .ok', 600);
      const p1 = await P();
      const unchanged = p1.Coins === p0.Coins && p1.Fish.find(f => f.Id === id)?.Place === 'Basket' && p1.Ledger.length === p0.Ledger.length;
      check('B1-23 保存失败时出售：报失败，鱼和金币都不变（点两次也一样）', n1.error === 'true' && unchanged, { notice: n1, coins: [p0.Coins, p1.Coins] });
      await closePanels();
      await ev('window.moyuDev.failSaves(false)');

      // 出鱼时存不进：不出卡片、显示未保存；恢复后自动补存、卡片出现、只有一条
      await patch(p => { setCount(p, 'lure|map1', 999); });
      await ev('window.moyuDev.failSaves(true)');
      const p2 = await P();
      await focusNotepad();
      await key('k');
      await sleep(1500);
      const s1 = { save: await T('save()'), card: await ev(`!!document.querySelector('.catch-card')`) };
      const p3 = await P();
      const fish = p3.Fish.filter(f => !p2.Fish.some(g => g.Id === f.Id));
      const stored0 = JSON.parse((await raw()).json.replace(/"Seed":(\d+)/, '"Seed":"$1"')).Fish.length;
      await ev('window.moyuDev.failSaves(false)');
      const appeared = await waitFor(`!!document.querySelector('.catch-card')`, 5000);
      await settle();
      const stored = JSON.parse((await raw()).json.replace(/"Seed":(\d+)/, '"Seed":"$1"'));
      const same = fish.length === 1 && stored.Fish.filter(f => f.Id === fish[0].Id).length === 1 && stored.Fish.filter(f => f.CatchEventId === fish[0].CatchEventId).length === 1;
      check('B1-23 出鱼时存不进：显示未保存、不出卡片、存档里没有这条；恢复后自动补存，卡片出现，同一条鱼只有一条',
        s1.save === '未保存' && !s1.card && stored0 === p2.Fish.length && appeared && same && (await T('save()')) === '已保存', { s1, stored0, appeared, fish: fish.map(f => f.CatchEventId) });

      // 恢复后再卖：只到账一次
      await openPanel('鱼篓');
      const p4 = await P();
      await selectFish(id);
      const price = +(await ev(`document.querySelector('.basket .fish-detail .chip').dataset.price`));
      await clickSel('.basket .sell');
      const ok = await T(`center('.confirm .ok')`);
      await clickAt(ok, 0); await clickAt(ok, 600);
      await settle();
      const p5 = await P();
      check('B1-23 恢复后重试出售：只到账一次', p5.Coins === p4.Coins + price && p5.Ledger.length === p4.Ledger.length + 1, { coins: [p4.Coins, p5.Coins], price });
      await closePanels();
    }

    // ───── 皮肤：B1-40 / B1-42 / B1-44 / B1-43 / B1-45 / B1-47 / B1-53 ─────
    {
      const drawBtn = () => ev(`(() => { const b = document.querySelector('.draw-btn'); return b && { text: b.innerText.trim(), disabled: b.disabled }; })()`);
      const lastDraw = () => ev(`(() => { const d = document.querySelector('.last-draw'); return d && { skin: d.dataset.skin, dup: d.dataset.duplicate === 'true' }; })()`);

      // 余额 99 不能抽
      await patch(p => { p.Coins = 99; p.OwnedSkins = [...BASES]; p.DuplicateStreak = 0; p.Equipped = { Character: 'BASE_CHAR', Rod: 'BASE_ROD', Glove: 'BASE_GLOVE', Scene: 'BASE_SCENE' }; });
      await openPanel('皮肤');
      const b99 = await drawBtn();
      await clickSel('.draw-btn');
      const c99 = (await P()).Coins;
      // 120 抽到重复：把下一抽要抽到的那款先放进已拥有
      let rec = await raw(), pr = JSON.parse(rec.json.replace(/"Seed":(\d+)/, '"Seed":"$1"'));
      const dupSkin = nextDraw(rec.seed, pr.DrawSeq, [], 0);
      await patch(p => { p.Coins = 120; p.OwnedSkins = [...BASES, dupSkin]; p.DuplicateStreak = 0; });
      await openPanel('皮肤');
      await clickSel('.draw-btn', 600);
      const pd = await P(), ld = await lastDraw();
      // 120 抽到新款
      await patch(p => { p.Coins = 120; p.OwnedSkins = [...BASES]; p.DuplicateStreak = 0; });
      await openPanel('皮肤');
      await clickSel('.draw-btn', 600);
      const pn = await P(), ln = await lastDraw();
      check('B1-40 余额 99 不能抽、不扣；120 抽到重复后剩 40、无副本、连续重复 +1；120 抽到新款后剩 20、解锁、连续重复归零',
        b99.disabled && c99 === 99 && pd.Coins === 40 && ld.dup && ld.skin === dupSkin && pd.OwnedSkins.filter(s => s === dupSkin).length === 1 && pd.DuplicateStreak === 1
        && pn.Coins === 20 && !ln.dup && pn.OwnedSkins.includes(ln.skin) && pn.DuplicateStreak === 0, { b99, c99, dup: [pd.Coins, ld, pd.DuplicateStreak], fresh: [pn.Coins, ln, pn.DuplicateStreak] });

      // 连续重复保底：连续重复 3 时不提示；再重复一次到 4、提示必新；刷新后还在；下一抽必新、归零
      rec = await raw(); pr = JSON.parse(rec.json.replace(/"Seed":(\d+)/, '"Seed":"$1"'));
      const x = nextDraw(rec.seed, pr.DrawSeq, [], 0);
      const owned4 = [...BASES, x];
      const expectNew = nextDraw(rec.seed, pr.DrawSeq + 1, owned4.filter(s => !BASES.includes(s)), 4);
      await patch(p => { p.Coins = 1000; p.OwnedSkins = owned4; p.DuplicateStreak = 3; });
      await openPanel('皮肤');
      const s3 = { streak: await statText('streak'), guaranteed: await ev(`!!document.querySelector('[data-stat=guaranteed]')`) };
      await clickSel('.draw-btn', 600);
      const s4 = { streak: await statText('streak'), guaranteed: await ev(`!!document.querySelector('[data-stat=guaranteed]')`), last: await lastDraw() };
      await load();
      await openPanel('皮肤');
      const s4r = { streak: await statText('streak'), guaranteed: await ev(`!!document.querySelector('[data-stat=guaranteed]')`) };
      await clickSel('.draw-btn', 600);
      const s5 = { last: await lastDraw(), streak: (await P()).DuplicateStreak, guaranteed: await ev(`!!document.querySelector('[data-stat=guaranteed]')`) };
      check('B1-42 连续重复 3 次不触发；第 4 次重复只记成 4/4、提示下一抽必新；刷新后还在；下一抽从未拥有里出、计数归零',
        s3.streak === '连续重复3/4' && !s3.guaranteed && s4.last.dup && s4.streak === '连续重复4/4' && s4.guaranteed && s4r.streak === '连续重复4/4' && s4r.guaranteed
        && !s5.last.dup && s5.last.skin === expectNew && !owned4.includes(s5.last.skin) && s5.streak === 0 && !s5.guaranteed, { s3, s4, s4r, s5, expectNew });

      // 重试不重抽、不自动装备
      rec = await raw(); pr = JSON.parse(rec.json.replace(/"Seed":(\d+)/, '"Seed":"$1"'));
      const predicted = nextDraw(rec.seed, pr.DrawSeq, pr.OwnedSkins.filter(s => !BASES.includes(s)), pr.DuplicateStreak);
      const pBefore = await P();
      await ev('window.moyuDev.failSaves(true)');
      await clickSel('.draw-btn', 600);
      const failed = { notice: await ev(`document.querySelector('.notice')?.dataset.error`), coins: (await P()).Coins, seq: (await P()).DrawSeq };
      await ev('window.moyuDev.failSaves(false)');
      await settle();
      await clickSel('.draw-btn', 600);
      const pAfter = await P(), got = await lastDraw();
      const cost = got.dup ? 80 : 100;
      check('B1-44 抽取存不进时不扣币；重试拿到同一个结果（不重抽）、只扣一次；抽到的外观不自动装备',
        failed.notice === 'true' && failed.coins === pBefore.Coins && failed.seq === pBefore.DrawSeq && got.skin === predicted && pAfter.Coins === pBefore.Coins - cost
        && JSON.stringify(pAfter.Equipped) === JSON.stringify(pBefore.Equipped), { failed, predicted, got, coins: [pBefore.Coins, pAfter.Coins] });

      // 集齐停抽
      await patch(p => { p.OwnedSkins = [...BASES, ...POOL]; p.Coins = 500; });
      await openPanel('皮肤');
      const all = await drawBtn();
      await clickSel('.draw-btn');
      check('B1-43 集齐后显示已集齐、抽取不可用，点了也不扣币', all.disabled && all.text === '已集齐' && (await P()).Coins === 500, all);

      // B1-53 16 件外观的预览互不相同
      const previews = [];
      for (const tabName of ['Character', 'Rod', 'Glove', 'Scene']) {
        await clickSel(`.skin .tabpill[data-tab=${tabName}]`, 150);
        const cells = await ev(`[...document.querySelectorAll('.skin-cell')].map(c => c.dataset.skin)`);
        for (const c of cells) {
          await clickSel(`.skin-cell[data-skin=${c}]`, 120);
          previews.push([c, await ev(`document.querySelector('.skin-preview').innerHTML`)]);
        }
      }
      // 预览 = 当前装备（此时全是默认）换上这一件；三类"默认"都是默认小熊，本来就是同一个样子
      const look = Object.fromEntries(previews);
      const perCat = ['CHAR', 'ROD', 'GLOVE', 'SCENE'].every(c => new Set(previews.filter(([id]) => id.includes(c)).map(p => p[1])).size === 4);
      const pool = POOL.map(id => look[id]);
      check('B1-53 每类 4 件预览互不相同；12 件抽取款装上后两两不同，也都不同于全默认',
        previews.length === 16 && perCat && new Set(pool).size === 12 && pool.every(h => h !== look.BASE_CHAR && h !== look.BASE_SCENE), previews.map(p => p[0]));

      // B1-47 公示与页签
      const odds = [];
      for (const tabName of ['Character', 'Rod', 'Glove', 'Scene']) {
        await clickSel(`.skin .tabpill[data-tab=${tabName}]`, 150);
        odds.push({ tab: tabName, odds: await ev(`document.querySelector('[data-stat=odds]').innerText.replace(/\\s+/g, '')`), cells: await ev(`[...document.querySelectorAll('.skin-cell')].map(c => c.dataset.skin)`) });
      }
      const wallet = await ev(`document.querySelector('.draw .wallet').innerText.trim()`);
      const prefix = { Character: 'CHAR', Rod: 'ROD', Glove: 'GLOVE', Scene: 'SCENE' };
      check('B1-47 皮肤页公示余额、单价 100、12 款各 1/12、连续重复次数；切页签只筛选（每页 4 件同类），公示不变',
        wallet === String((await P()).Coins) && odds.every(o => o.odds === odds[0].odds && o.cells.length === 4 && o.cells.every(c => c.includes(prefix[o.tab])))
        && odds[0].odds.includes('每抽100') && odds[0].odds.includes('12款各1/12') && /连续重复\d\/4/.test(odds[0].odds), { wallet, odds });

      // B1-45 装备
      const mine = ['WEB_CHAR_02', 'WEB_ROD_03', 'WEB_GLOVE_01', 'WEB_SCENE_02'];
      await patch(p => { p.OwnedSkins = [...BASES, ...mine]; p.Equipped = { Character: 'BASE_CHAR', Rod: 'BASE_ROD', Glove: 'BASE_GLOVE', Scene: 'BASE_SCENE' }; });
      await openPanel('皮肤');
      await clickSel('.skin .tabpill[data-tab=Character]', 150);
      await clickSel('.skin-cell[data-skin=WEB_CHAR_01]', 150);
      const lockedBtn = await ev(`document.querySelector('.preview-side .equip').disabled`);
      const eq0 = (await P()).Equipped.Character;
      for (const [tabName, id] of [['Character', mine[0]], ['Rod', mine[1]], ['Glove', mine[2]], ['Scene', mine[3]]]) {
        await clickSel(`.skin .tabpill[data-tab=${tabName}]`, 150);
        await clickSel(`.skin-cell[data-skin=${id}]`, 150);
        await clickSel('.preview-side .equip', 500);
      }
      await closePanels();
      const worn = { bear: (await T('bear()')).skins, scene: await ev(`document.querySelector('svg.scene').dataset.scene`) };
      await openPanel('皮肤');
      await clickSel('.skin .tabpill[data-tab=Character]', 150);
      await clickSel('.skin-cell[data-skin=BASE_CHAR]', 150);
      await clickSel('.preview-side .equip', 500);
      await load();
      const pe = await P(), after = { bear: (await T('bear()')).skins, scene: await ev(`document.querySelector('svg.scene').dataset.scene`) };
      check('B1-45 未拥有的不能装、原装备不变；四类各装一件互不影响、小熊和场景跟着变；换回默认人物；刷新后都在',
        lockedBtn && eq0 === 'BASE_CHAR' && worn.bear === `${mine[0]} ${mine[1]} ${mine[2]}` && worn.scene === mine[3]
        && after.bear === `BASE_CHAR ${mine[1]} ${mine[2]}` && after.scene === mine[3] && pe.Equipped.Rod === mine[1], { lockedBtn, worn, after });
      await shot('04-skins');
    }

    // ───── B1-52 / B1-53 记录页 ─────
    {
      await openPanel('记录');
      const p = await P();
      const rows = await ev(`[...document.querySelectorAll('.record-row')].map(r => ({ sp: r.dataset.species, caught: r.dataset.caught === 'true', text: r.innerText.trim() }))`);
      const found = await ev(`document.querySelector('[data-stat=records]').innerText.trim()`);
      const shapes = [];
      const details = [];
      for (const r of rows) {
        await clickSel(`.record-row[data-species=${r.sp}]`, 120);
        shapes.push(await ev(`document.querySelector('.records .fish-detail svg.big').innerHTML.replace(/fill="[^"]*"/g, '')`));
        details.push(await ev(`document.querySelector('.records .fish-detail').innerText.replace(/\\s+/g, ' ')`));
      }
      const caughtOk = rows.every((r, i) => r.caught === !!p.Records[r.sp] && (r.caught
        ? details[i].includes(cm(p.Records[r.sp].MaxLengthMm)) && details[i].includes(`${p.Records[r.sp].Count} 次`)
        : r.text === '？？？' && details[i].includes('出处')));
      const soldSpecies = p.Ledger.filter(e => e.Kind === 'Sale').flatMap(e => e.Lines.map(l => l.SpeciesId));
      check('B1-52 记录页 6 行：抓到的显示最长体长和次数，没抓到的是问号和出处地图；顶部 n/6；卖掉的鱼种纪录还在',
        rows.length === 6 && caughtOk && found === `${Object.keys(p.Records).length}/6` && soldSpecies.length > 0 && soldSpecies.every(s => p.Records[s]), { found, rows, details });
      check('B1-53 6 种鱼的图形互不相同', new Set(shapes).size === 6, shapes.length);
      await closePanels();
    }

    // ───── B1-28 鱼缸 20 条边界 ─────
    {
      await ev('window.moyuDev.injectFish(21)');
      await settle();
      // 先直接摆 19 条进缸，再从界面放第 20、21 条
      await patch(p => {
        const inTank = p.Fish.filter(f => f.Place === 'Tank').length;
        let need = 19 - inTank;
        for (const f of p.Fish) if (need > 0 && f.Place === 'Basket') { f.Place = 'Tank'; f.TankId = 'tank1'; need--; }
      });
      await openPanel('鱼篓');
      const p0 = await P();
      const [a, b] = await basketIds();
      await selectFish(a); await clickSel('.basket .collect');
      const cap20 = (await P()).Fish.filter(f => f.Place === 'Tank').length;
      await selectFish(b); await clickSel('.basket .collect');
      const note = await ev(`({ text: document.querySelector('.notice')?.innerText ?? '', error: document.querySelector('.notice')?.dataset.error })`);
      const p1 = await P();
      await openPanel('收藏');
      const capText = await ev(`document.querySelector('[data-stat=tank]').innerText`);
      check('B1-28 第 20 条放得进（20/20）；第 21 条放不进、说明原因、仍在鱼篓；不自动卖、不丢鱼',
        cap20 === 20 && capText === '20/20' && note.error === 'true' && note.text.includes('满') && p1.Fish.find(f => f.Id === b).Place === 'Basket'
        && p1.Fish.length === p0.Fish.length && p1.Coins === p0.Coins, { cap20, capText, note });
      await closePanels();
    }

    // ───── B1-22 刷新恢复全部状态 ─────
    {
      await openPanel('收藏');
      if (!(await ev(`document.querySelector('.collection .background').dataset.on === 'true'`))) await clickSel('.collection .background');
      await closePanels();
      await settle();
      const snap = async () => ({ p: JSON.stringify(await P()), bear: (await T('bear()')).skins, scene: await ev(`document.querySelector('svg.scene').dataset.scene`),
        bg: await ev(`[...document.querySelectorAll('svg.scene .bg-fish')].map(g => g.dataset.fish).join()`), stats: await ev(`[...document.querySelectorAll('.stats [data-stat]')].map(e => e.innerText).join('|')`) });
      const s0 = await snap();
      await load();
      const s1 = await snap();
      const p = JSON.parse(s1.p);
      const rich = p.Fish.some(f => f.Place === 'Sold') && p.Fish.some(f => f.Place === 'Tank') && p.Ledger.some(e => e.Kind === 'Draw') && p.BackgroundTankId && Object.keys(p.Groups).length >= 3;
      check('B1-22 刷新后鱼、归属、各组进度、总累计、金币、账本、外观、背景全部恢复', rich && JSON.stringify(s0) === JSON.stringify(s1), { same: JSON.stringify(s0) === JSON.stringify(s1), bg: s1.bg, stats: s1.stats });
    }

    // ───── B1-25 第二个标签页只读 ─────
    {
      const t0 = await total();
      const tab2 = await openTab(base.href);
      const ro = await tab2.waitFor(`window.__t && window.__t.save() === '只读'`, 30000);
      await tab2.ev(`window.__keys = 0; addEventListener('keydown', () => window.__keys++, true); true`);
      await tab2.ev(`document.querySelector('#notepad textarea').focus(); true`);
      await tab2.press(5);
      await sleep(500);
      const r2 = { keys: await tab2.ev('window.__keys'), acts: await tab2.ev('window.moyuPlay.acts') };
      await tab2.ev(`document.querySelector('#pet .bottombar .tab[title=鱼篓]').click(); true`);
      await sleep(300);
      const sellDisabled = await tab2.ev(`document.querySelector('.basket .sell')?.disabled`);
      await focusNotepad(); await key('k');
      await waitTotal(t0 + 1, 5000);
      const t1 = await total();
      await closeTab(tab2);
      check('B1-25 第二个标签页显示只读：那边按键收到了但不计数、出售不可用；第一页照常计数',
        ro && r2.keys === 5 && r2.acts === 0 && sellDisabled === true && t1 === t0 + 1, { ro, r2, sellDisabled, total: [t0, t1] });
    }

    // ───── B1-24 读档失败不覆盖 ─────
    {
      await settle();
      const good = await T(`idb('get')`);
      await T(`idb('put', ${JSON.stringify({ revision: good.revision + 5, json: '{"Schema":1,"Fish":[' })})`);
      await load(['读档失败']);
      const state = await T('save()');
      await focusNotepad(); await press(10);
      await sleep(1200);
      const after = await T(`idb('get')`);
      const a = await ev('window.moyuPlay.acts');
      check('B1-24 存档坏了：显示读档失败、只读，按键不计数，存档原样没被覆盖', state === '读档失败' && a === 0 && after.json === '{"Schema":1,"Fish":[' && after.revision === good.revision + 5, { state, acts: a, kept: after.json });
      await T(`idb('put', ${JSON.stringify({ revision: good.revision + 10, json: good.json })})`);
      await load();
    }

    // ───── B1-54 只靠真实输入走一圈 ─────
    {
      await T(`idb('del')`);
      await load();
      await setMode('路亚');
      await closePanels();
      const readStored = async () => JSON.parse((await raw()).json.replace(/"Seed":(\d+)/, '"Seed":"$1"'));
      const price = f => { const s = { TMP_F001: [60, 100, 16, 4], TMP_F002: [120, 200, 24, 6], TMP_F003: [240, 400, 60, 15], TMP_F101: [450, 650, 150, 30], TMP_F201: [600, 900, 150, 30], TMP_F301: [900, 1300, 150, 30] }[f.SpeciesId];
        const [a, b, B, H] = s, R = b - a, d = 2 * f.LengthMm - a - b, q = Math.floor((2 * H * Math.abs(d) + R) / (2 * R)); return B + Math.sign(d) * q; };
      await focusNotepad();
      let stored, pressed = 0;
      for (let chunk = 400; ;) {
        await press(chunk); pressed += chunk;
        await settle();
        stored = await readStored();
        const basket = stored.Fish.filter(f => f.Place === 'Basket').sort((x, y) => price(x) - price(y));
        if (basket.length >= 6 && basket.slice(1).reduce((s, f) => s + price(f), 0) >= 100) break;
        chunk = basket.length >= 5 ? 100 : 400;
        if (pressed > 30000) throw new Error('按了 3 万次还没攒够鱼');
        await focusNotepad();
      }
      await openPanel('鱼篓');
      const basket = stored.Fish.filter(f => f.Place === 'Basket').sort((x, y) => price(x) - price(y));
      const keep = basket[0];
      await selectFish(keep.Id); await clickSel('.basket .collect');
      const s1 = await readStored();
      check('B1-54 真实输入攒鱼后放 1 条进收藏', s1.Fish.find(f => f.Id === keep.Id).Place === 'Tank', { pressed, fish: basket.length });
      for (const f of basket.slice(1)) await clickSel(`.basket .fish-cell[data-fish="${f.Id}"] .tick`, 80);
      await clickSel('.basket .sell');
      const quoted = +(await ev(`document.querySelector('.confirm .total').dataset.total`));
      await confirmSale();
      const s2 = await readStored();
      check('B1-54 卖掉其余的鱼：金币 = 报价合计', s2.Coins === quoted && quoted >= 100 && s2.Fish.filter(f => f.Place === 'Basket').length === 0, { quoted, coins: s2.Coins });
      await openPanel('皮肤');
      await clickSel('.draw-btn', 600);
      const drawn = (await ev(`document.querySelector('.last-draw')?.dataset.skin`));
      await clickSel(`.skin-cell[data-skin=${drawn}]`, 150);
      await clickSel('.preview-side .equip', 500);
      await closePanels();
      const s3 = await readStored();
      const look = { bear: (await T('bear()')).skins, scene: await ev(`document.querySelector('svg.scene').dataset.scene`) };
      check('B1-54 用卖鱼的钱抽一次并装备抽到的外观', drawn && Object.values(s3.Equipped).includes(drawn) && (`${look.bear} ${look.scene}`).includes(drawn) && s3.Coins === s2.Coins - 100, { drawn, look });
      await load();
      const s4 = await readStored();
      check('B1-54 刷新后收藏、出售、抽取、装备都在；全程没有开发来源的鱼或金币',
        s4.Fish.find(f => f.Id === keep.Id).Place === 'Tank' && s4.Coins === s3.Coins && Object.values(s4.Equipped).includes(drawn)
        && s4.Fish.every(f => f.Source === 'Normal') && s4.Ledger.every(e => e.Kind !== 'Dev'), { coins: s4.Coins, sources: [...new Set(s4.Fish.map(f => f.Source))], kinds: [...new Set(s4.Ledger.map(e => e.Kind))] });
      await shot('05-loop');
    }

    check('控制台无报错', consoleErrors.length === 0, consoleErrors.slice(0, 5));
  },
});
