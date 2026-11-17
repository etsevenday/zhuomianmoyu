#!/usr/bin/env node
// B2 答复接入浏览器验收：执行 doc/测试用例/B2 答复接入.md 里方式为 B、S 的用例，每个 check 名以用例号开头。
//
// 用法：
//   node tools/verify/b2.mjs [网址|--release] [输出目录]
//   --release：先照 CI 的方式发布本地 Release 包，挂在 http://127.0.0.1:5199/zhuomianmoyu/ 上测（推送前的主关卡）
//   网址默认线上 https://etsevenday.github.io/zhuomianmoyu/ ，脚本自动加 ?dev=1；开发中也可测 http://localhost:5188/
//   输出默认系统临时目录下 moyu-b2；环境变量 CHROME 指定浏览器、PLAYTEST_PORT 指定调试端口（默认 9341）
//
// 手竿 30 分钟不真等：开发入口 moyuDev.skew(毫秒) 把页面计时看到的"现在"往后拨，moyuDev.poleTick() 立刻检查一次，
// 和每秒一次的真实检查走同一条路径（每段间隔照样受 5 分钟规则约束，所以拨大段时间要分成 ≤290 秒的小段）。
// 其余前置条件和 b1 一样：开发入口（注入鱼、加金币、模拟保存失败、读档案）或直接改 IndexedDB 里的档案再刷新。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBatch, sleep, near } from './cdp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEXTS = fs.readFileSync(path.join(REPO, 'web/Moyu.Web/Services/Texts.cs'), 'utf8');
const COPY = fs.readFileSync(path.join(REPO, 'doc/策划案/文案交接 v0.1/03 B0-B1界面文案定稿.md'), 'utf8');

// ───────────── 和内核一致的随机数（src/Core/Play/Dice.cs），用来构造"下一抽必重复" ─────────────
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
function nextDraw(seed, drawSeq, owned, streak) {
  const cands = streak >= 4 ? POOL.filter(s => !owned.includes(s)) : POOL;
  return cands[below(seed, `draw|${drawSeq + 1}`, cands.length)];
}
const cm = mm => `${Math.floor(mm / 10)}.${mm % 10} cm`;
const setCount = (p, g, n) => { p.Groups[g] = { ...p.Groups[g], Count: n, Cycle: p.Groups[g]?.Cycle ?? 0 }; };
const HOUR = 1800000, STEP = 290000;

// ───────────── 定稿原句（和 Texts.cs、定稿表一致；这里写死，改文案时两边一起对） ─────────────
const T_ = {
  poleRunningPrefix: '手竿计时中，还需 ',
  polePausedPrefix: '手竿已暂停，已累计 ',
  poleRules: '网页开着时计时，切到其他标签页或最小化仍可累计。收起头像继续计时，关闭小窗或网页停止计时，不补离线时间。',
  poleGapRule: '两次计时检查间隔超过5分钟时，该段时间不计入手竿进度。',
  poleGap: '刚才的计时检查间隔超过5分钟，这一段未计入。',
  closed: '小窗已关闭，输入计数和手竿计时已暂停。',
  saveRetry: '保存失败，尚未确认的进度不会显示为已获得。请重试。',
  loadFailed: '读档失败，现有存档未被覆盖。请重试。',
  readOnly: '当前页面只读。请在正在运行游戏的页面继续操作。',
  unknownVersion: '当前存档版本无法读取，现有数据未被覆盖。',
  recordHelp: '卖鱼和收藏都不会清除捕获记录。',
  demo: '网页演示开关，不会改变系统置顶，也不会接收其他网页或软件的输入。',
  inputScope: '仅统计本页面内游戏界面以外的真实键盘按下和鼠标点击。其他网页、地址栏及其他软件中的输入不会计入。',
  basketEmpty: '鱼篓是空的。',
  saleFinal: '确认后鱼将被出售，本轮不支持撤销。',
  saleStale: '鱼或报价有变化，请重新选择后再卖。',
  tankEmpty: '鱼缸是空的，从鱼篓放鱼进来。',
  tankBg: '鱼缸显示在钓鱼场景后方，鱼在缸里游动，不影响当前地图和选位。',
  moreTanks: '更多鱼缸尚未开放。',
  tankFull: '鱼缸满了（20/20），鱼还在鱼篓里。',
  drawPrice: '每抽100金币，重复返20金币。',
  drawOdds: '12款外观各有1/12机会，允许重复。分类页签只筛选浏览，不改变抽取池。',
  allOwned: '已拥有全部可抽外观，不再扣除金币。',
  cosmetic: '外观只改变样子，不影响出鱼、售价或鱼缸容量。',
  equipHelp: '新外观不会自动装备，可以在这里主动更换。',
  roomClosed: '好友联机尚未开放。',
  trial: '试玩版本，部分美术为临时素材。好友联机与更多鱼缸尚未开放。',
  modeHelp: {
    路亚: '工作时输入键盘或点击鼠标，角色就会提竿。第500次有50%机会出鱼；本轮累计到1000次必得一条。成功后本轮重新计数。',
    摸鱼: '工作时输入键盘或点击鼠标，角色就会探水。每累计200次有20%机会出鱼；本轮累计到2000次必得一条。成功后本轮重新计数。',
    手竿: '选择手竿后，累计30分钟有效时间就能获得一条鱼。切换地图或玩法会暂停，回来接着等。',
  },
};
const FISH_NAMES = ['银白小鱼', '青圆点鱼', '金扇尾鱼', '荷叶尾鱼', '蓝纹长鱼', '云纹大鱼'];

// 页面里的取数小工具（每次加载自动注入）
const HELPERS = `window.__t = {
  scene(x, y) { const r = document.querySelector('svg.scene').getBoundingClientRect(); return { x: r.left + x / 1600 * r.width, y: r.top + y / 900 * r.height }; },
  rect(sel) { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; },
  center(el) { if (typeof el === 'string') el = document.querySelector(el); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; },
  inPet(x, y) { const e = document.elementFromPoint(x, y); return !!(e && e.closest('#pet')); },
  btn(text) { return [...document.querySelectorAll('#pet button'), ...document.querySelectorAll('button')].find(b => b.offsetParent !== null && (b.title === text || (b.innerText || '').trim() === text)); },
  panels() { return [...document.querySelectorAll('#pet .panel, #pet .popup')].map(e => e.className.replace(/\\b(panel|popup|solid)\\b/g, '').trim()); },
  bear() { const g = document.querySelector('svg.scene g.bear'); if (!g) return null; const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(g.getAttribute('transform')); return { x: +m[1], y: +m[2], mode: g.dataset.mode }; },
  stat(name) { const e = document.querySelector('[data-stat=' + name + ']'); return e ? { text: e.innerText.replace(/\\s+/g, ''), title: e.title } : null; },
  save() { return document.querySelector('[data-stat=save]')?.innerText.trim() ?? null; },
  badge() { return document.querySelector('[data-stat=new-fish]')?.innerText.trim() ?? null; },
  fullTime(ms) { const d = new Date(ms), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); },
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
  batch: 'b2',
  helpers: HELPERS,
  async run({ main, base, check, openTab, closeTab, consoleErrors, setBuild }) {
    const { ev, waitFor, clickAt, key, press, shot, send } = main;
    const T = expr => ev(`window.__t.${expr}`);
    const P = () => ev('window.moyuDev.profile()');
    const total = async () => (await P()).LifetimeInputs;
    const focusNotepad = () => ev(`document.querySelector('#notepad textarea').focus(); true`);
    const statText = async name => (await T(`stat('${name}')`))?.text;
    const statTitle = async name => (await T(`stat('${name}')`))?.title;

    async function load(expect = ['已保存']) {
      await send('Page.navigate', { url: base.href });
      const ok = await waitFor(`!!window.__t && !!window.moyuPlay && !!window.moyuDev && !!document.querySelector('.taskbar') && !!(document.querySelector('#pet') || document.querySelector('#avatar'))`, 30000);
      if (!ok) throw new Error('页面没加载出小窗');
      if (expect && !(await waitFor(`${JSON.stringify(expect)}.includes(window.__t.save()) || !document.querySelector('#pet')`, 15000))) throw new Error('存档状态不对：' + await T('save()'));
      await sleep(300);
    }
    async function settle() { await sleep(1000); return waitFor(`window.__t.save() === '已保存'`, 10000); }
    const waitTotal = (n, ms = 30000) => waitFor(`window.moyuDev.profile().then(p => p.LifetimeInputs === ${n})`, ms);
    async function raw() {
      const rec = await T(`idb('get')`);
      return rec && { ...rec, seed: BigInt(/"Seed":(\d+)/.exec(rec.json)[1]) };
    }
    const parse = json => JSON.parse(json.replace(/"Seed":(\d+)/, '"Seed":"$1"'));
    const stored = async () => parse((await raw()).json);
    /** 改存档再刷新；修订号跳开，旧页面迟到的保存会被拒。 */
    async function patch(fn, expect) {
      await settle();
      const rec = await raw();
      const p = parse(rec.json);
      fn(p);
      const json = JSON.stringify(p).replace(/"Seed":"(\d+)"/, '"Seed":$1');
      await T(`idb('put', ${JSON.stringify({ revision: rec.revision + 1000, json })})`);
      await load(expect);
      return rec.seed;
    }
    async function clickBtn(text, wait = 300) {
      const p = await T(`center(window.__t.btn(${JSON.stringify(text)}))`);
      if (!p) throw new Error(`找不到按钮：${text}`);
      await clickAt(p, wait);
    }
    const clickSel = async (sel, wait = 300) => {
      const p = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); return window.__t.center(e); })()`);
      if (!p) throw new Error(`找不到：${sel}`);
      await clickAt(p, wait);
    };
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
    const modeNow = () => ev(`document.querySelector('#pet .mode span').innerText`);
    async function setMode(name) {
      const cur = await modeNow();
      if (cur === name) return;
      await closePanels();
      await clickBtn(cur); await clickBtn(name);
    }
    async function setMap(i) {
      await openPanel('地图');
      await clickSel(`.map-row:nth-child(${i})`);
      await closePanels();
    }
    const basketIds = () => ev(`[...document.querySelectorAll('.basket .fish-cell')].map(c => c.dataset.fish)`);
    const selectFish = id => clickSel(`.basket .fish-cell[data-fish="${id}"] .pick`);
    const confirmSale = async () => { await clickSel('.confirm .ok', 100); await waitFor(`!document.querySelector('.confirm') && window.__t.save() === '已保存'`, 10000); };
    const notice = () => ev(`(() => { const n = document.querySelector('.notice'); return n ? { text: n.innerText.trim(), error: n.dataset.error === 'true' } : null; })()`);

    // 手竿
    const poleMs = async (map = 'map1') => (await P()).Groups[`pole|${map}`]?.ElapsedMs ?? 0;
    async function advance(ms) { await ev(`window.moyuDev.skew(${ms})`); await ev('window.moyuDev.poleTick()'); await sleep(120); }
    /** 把当前手竿图拨到出一条鱼（每段 ≤290 秒）；返回新出的鱼（内存里的档案）。 */
    async function fillPole(map = 'map1') {
      const before = (await P()).Fish.length;
      for (let i = 0; i < 20; i++) {
        const p = await P();
        if (p.Fish.length > before) return p.Fish[p.Fish.length - 1];
        const need = HOUR - (p.Groups[`pole|${map}`]?.ElapsedMs ?? 0);
        await advance(Math.min(STEP, need + 300));
      }
      throw new Error('拨满 30 分钟也没出鱼');
    }

    // ═════════════ 新档 ═════════════
    await load();
    setBuild(await ev(`document.querySelector('meta[name=app-build]')?.content`));

    // ───── B2-25 静态：6 鱼 16 外观的名称、描述和定稿表逐字一致 ─────
    {
      const block = name => { const i = TEXTS.indexOf(`public static string ${name}(`); return TEXTS.slice(i, TEXTS.indexOf('};', i)); };
      const arm = (body, id) => new RegExp(`"${id}"(?: or "\\w+")* => "([^"]*)"`).exec(body)?.[1];
      const section = (n, next) => COPY.slice(COPY.indexOf(`## ${n}.`), COPY.indexOf(`## ${next}.`));
      const rows = sec => sec.split('\n').filter(l => /^\| (TMP|BASE|WEB)_/.test(l)).map(l => l.split('|').slice(1, -1).map(c => c.trim()));
      const bad = [];
      const fish = rows(section(8, 9)), skins = rows(section(9, 10));
      for (const [id, name, desc] of fish) {
        if (arm(block('FishName'), id) !== name) bad.push([id, 'name', arm(block('FishName'), id), name]);
        if (arm(block('FishDescription'), id) !== desc) bad.push([id, 'desc']);
      }
      for (const [id, , name, desc] of skins) {
        if (arm(block('SkinName'), id) !== name) bad.push([id, 'name', arm(block('SkinName'), id), name]);
        if (arm(block('SkinDescription'), id) !== desc) bad.push([id, 'desc']);
      }
      check('B2-25 定稿表 §8 的 6 种鱼、§9 的 16 件外观：名称和描述在 Texts.cs 里逐字一致', fish.length === 6 && skins.length === 16 && bad.length === 0, { fish: fish.length, skins: skins.length, bad });
    }

    // ───── B2-19 新档没有鱼缸层 ─────
    check('B2-19 新档：场景里没有鱼缸层', !(await ev(`!!document.querySelector('svg.scene .bg-tank')`)) && (await P()).BackgroundTankId == null);

    // ───── B2-12 新档记录全是"？"且不泄露 ─────
    {
      await openPanel('地图');
      const mapNames = await ev(`[...document.querySelectorAll('.map-row .name')].map(e => e.innerText.trim())`);
      await openPanel('记录');
      const rows = await ev(`[...document.querySelectorAll('.record-row')].map(r => ({ slot: r.dataset.slot, sp: r.dataset.species ?? null, text: r.innerText.trim() }))`);
      const details = [];
      for (const r of rows) {
        await clickSel(`.record-row[data-slot="${r.slot}"]`, 120);
        details.push(await ev(`document.querySelector('.records .fish-detail').innerText.trim()`));
      }
      const dump = await ev(`(() => { const p = document.querySelector('.records'); return p.innerText + ' ' + [...p.querySelectorAll('*')].flatMap(e => ['title', 'aria-label', 'alt'].map(a => e.getAttribute(a) || '')).join(' '); })()`);
      const shapes = await ev(`document.querySelectorAll('.records .record-row svg, .records .fish-detail svg').length`);
      const leaks = [...FISH_NAMES, ...mapNames, '出处'].filter(w => dump.includes(w));
      const found = await statText('records');
      check('B2-12 新档记录：顶部"已发现 0/6"；6 行都只写"？"、详情只有"？"；没有鱼形、鱼名、地图名、"出处"；有记录说明',
        found === '已发现0/6' && rows.length === 6 && rows.every(r => r.text === '？' && r.sp === null) && details.every(d => d === '？') && shapes === 0 && leaks.length === 0
        && (await ev(`document.querySelector('.record-help')?.innerText.trim()`)) === T_.recordHelp, { found, rows, details, shapes, leaks, mapNames });
      await closePanels();
    }

    // ───── 新档的空鱼篓、空鱼缸文字（B2-27、B2-28 用） ─────
    await openPanel('鱼篓');
    const emptyBasket = await ev(`document.querySelector('.basket .empty')?.innerText.trim()`);
    await openPanel('收藏');
    const emptyTank = {
      hint: await ev(`document.querySelector('.tank-side .hint')?.innerText.trim()`),
      cap: await ev(`document.querySelector('[data-stat=tank]').innerText.trim()`),
      more: await ev(`document.querySelector('.more-tanks')?.innerText.trim()`),
      bg: await ev(`document.querySelector('.bg-help')?.innerText.trim()`),
    };
    await closePanels();

    // ───── B2-26 底栏原句（路亚） ─────
    {
      await focusNotepad(); await press(3);
      await waitTotal(3, 5000);
      const t = { total: await statTitle('total'), cycle: await statTitle('cycle'), coins: await statTitle('coins'), text: await ev(`document.querySelector('.stats').innerText.replace(/\\s+/g, ' ')`) };
      check('B2-26 底栏悬停："总累计 n 次"、"本轮 n 次，下一次判定在第 500 次。"、"金币 n"；金币前写"金币"',
        t.total === '总累计 3 次' && t.cycle === '本轮 3 次，下一次判定在第 500 次。' && t.coins === '金币 0' && t.text.includes('金币'), t);
    }

    // ───── B2-29 模式帮助、房间、试玩说明；旧占位句不再出现 ─────
    {
      await clickBtn(await modeNow());
      const help = await ev(`Object.fromEntries([...document.querySelectorAll('.mode-menu .opt')].map(b => [b.innerText.trim(), b.title]))`);
      await clickBtn(await modeNow());
      await openPanel('房间');
      const room = await ev(`({ note: document.querySelector('.room .sample-note')?.innerText.trim(), me: document.querySelector('.room .member span')?.innerText.trim(), invite: (() => { const b = [...document.querySelectorAll('.room button')].find(b => b.innerText.trim() === '邀请好友'); return b && { disabled: b.disabled, title: b.title }; })() })`);
      await closePanels();
      const corner = await ev(`document.querySelector('.placeholder-note')?.innerText ?? ''`);
      const offenders = [];
      (function walk(d) {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, f.name);
          if (f.isDirectory()) { if (!['bin', 'obj'].includes(f.name)) walk(fp); }
          else if (/\.(cs|razor|js|html)$/.test(f.name) && /计时未开放|出处：|文案占位|？？？/.test(fs.readFileSync(fp, 'utf8'))) offenders.push(path.relative(REPO, fp));
        }
      })(path.join(REPO, 'web/Moyu.Web'));
      const page = await ev(`document.body.innerText`);
      check('B2-29 三种模式各有定稿帮助句（手竿写 30 分钟）；房间"好友联机尚未开放。"、"我"、"邀请好友"不可用；角落试玩说明；网页代码和页面里没有"计时未开放""出处：""？？？"和文案占位',
        Object.entries(T_.modeHelp).every(([k, v]) => help[k] === v) && room.note === T_.roomClosed && room.me === '我' && room.invite?.disabled && room.invite.title === '尚未开放'
        && corner.includes(T_.trial) && offenders.length === 0 && !/计时未开放|出处：/.test(page), { help, room, corner, offenders });
    }

    // ───── B2-24 设置四行与演示开关 ─────
    {
      await openPanel('设置');
      const rows = () => ev(`[...document.querySelectorAll('.setting-row')].map(r => ({ id: r.dataset.setting, t: r.querySelector('span').innerText, on: r.querySelector('[role=switch]').getAttribute('aria-checked') }))`);
      const r0 = await rows();
      const notes = await ev(`({ demo: document.querySelector('[data-note=demo]')?.innerText.trim(), input: document.querySelector('[data-note=input]')?.innerText.trim() })`);
      await clickSel('.setting-row[data-setting=topmost] [role=switch]');
      await clickSel('.setting-row[data-setting=background-input] [role=switch]');
      const r1 = await rows();
      await load();
      await openPanel('设置');
      const r2 = await rows();
      const prefs = await ev(`JSON.parse(localStorage.getItem('moyu.prefs.v1'))`);
      await closePanels();
      const t0 = await total();
      await focusNotepad(); await press(3);
      await waitTotal(t0 + 3, 5000);
      const d = (await total()) - t0;
      const on = (rs, id) => rs.find(r => r.id === id)?.on;
      check('B2-24 设置四行（透明区穿透、静音、置顶、后台输入）各显示开/关；置顶、后台输入写演示说明；有输入范围说明；点了翻转、刷新后还在；按键照样计数',
        r0.map(r => r.t).join('|') === '透明区穿透|静音|置顶|后台输入' && on(r0, 'topmost') === 'true' && on(r0, 'background-input') === 'false'
        && notes.demo?.includes(T_.demo) && notes.input === T_.inputScope && on(r1, 'topmost') === 'false' && on(r1, 'background-input') === 'true'
        && on(r2, 'topmost') === 'false' && on(r2, 'background-input') === 'true' && prefs.Topmost === false && prefs.BackgroundInput === true && d === 3,
        { r0: r0.map(r => `${r.t}:${r.on}`), r1: r1.map(r => r.on), r2: r2.map(r => r.on), notes, prefs: { Topmost: prefs.Topmost, BackgroundInput: prefs.BackgroundInput }, d });
      await openPanel('设置');
      await clickSel('.setting-row[data-setting=topmost] [role=switch]');
      await clickSel('.setting-row[data-setting=background-input] [role=switch]');
      await closePanels();
    }

    // ═════════════ 手竿 ═════════════

    // ───── B2-07 底栏、间隔、满 30 分钟 ─────
    {
      await setMode('手竿');
      await sleep(1200);
      const c0 = await statText('cycle'), title0 = await statTitle('cycle');
      check('B2-07 手竿底栏"本轮 mm:ss/30:00"；悬停"手竿计时中，还需 mm:ss。"加计时规则和 5 分钟规则',
        /^本轮\d\d:\d\d\/30:00$/.test(c0) && /^手竿计时中，还需 \d\d:\d\d。$/.test(title0.split('\n')[0]) && title0.includes(T_.poleRules) && title0.includes(T_.poleGapRule) && !title0.includes(T_.poleGap),
        { c0, title0 });
      const e0 = await poleMs();
      await advance(299000);
      const e1 = await poleMs();
      await advance(300001);
      const e2 = await poleMs();
      const title2 = await statTitle('cycle');
      check('B2-07 拨 299 秒检查：整段计入；拨 300001 毫秒检查：整段不计，悬停多一句"刚才的计时检查间隔超过5分钟，这一段未计入。"',
        e1 - e0 >= 299000 && e1 - e0 < 302000 && e2 - e1 < 2000 && title2.includes(T_.poleGap), { gain299: e1 - e0, gainLong: e2 - e1, title2 });
      await shot('01-pole');
      const p0 = await P();
      const badge0 = Number(await T('badge()') ?? 0);
      const fish = await fillPole();
      const cardOk = await waitFor(`document.querySelector('.catch-card')?.dataset.fish === ${JSON.stringify(fish.Id)}`, 5000);
      const card = await ev(`(() => { const c = document.querySelector('.catch-card'); return c && { guaranteed: !!c.querySelector('[data-guaranteed]'), text: c.innerText }; })()`);
      const p1 = await P();
      const title3 = await statTitle('cycle');
      check('B2-07 满 30 分钟出 1 条：本图鱼池、来源正常、不带保底、事件号 catch|pole|map1|0；卡片没有"保底"、鱼篓新鱼数 +1；总累计和各模式输入不变；余数留在本轮、"未计入"那句不再提',
        cardOk && !card.guaranteed && p1.Fish.length === p0.Fish.length + 1 && fish.MapId === 'map1' && fish.Source === 'Normal' && !fish.Guaranteed && fish.CatchEventId === 'catch|pole|map1|0'
        && ['TMP_F001', 'TMP_F002', 'TMP_F003', 'TMP_F101'].includes(fish.SpeciesId) && Number(await T('badge()')) === badge0 + 1
        && p1.LifetimeInputs === p0.LifetimeInputs && JSON.stringify(p1.ModeInputs) === JSON.stringify(p0.ModeInputs) && (p1.Groups['pole|map1'].ElapsedMs < STEP) && !title3.includes(T_.poleGap),
        { fish: [fish.SpeciesId, fish.MapId, fish.Source, fish.CatchEventId], card, rest: p1.Groups['pole|map1'] });
      await shot('02-pole-catch');
    }

    // ───── B2-08 收起照计、关闭停、切走停 ─────
    {
      await settle();
      await clickBtn('收起');
      const e0 = await poleMs();
      await advance(60000);
      const e1 = await poleMs();
      await clickAt(await T(`center('#avatar')`));
      check('B2-08 收起期间拨 60 秒：手竿 +60 秒', e1 - e0 >= 60000 && e1 - e0 < 62500, { gain: e1 - e0 });

      await clickBtn('关闭');
      const note = await ev(`document.querySelector('.closed-note[data-note=closed]')?.innerText.trim()`);
      const e2 = await poleMs();
      await advance(60000);
      await sleep(1100);
      const e3 = await poleMs();
      await clickSel('.taskbar button[title=桌面摸鱼]');
      check('B2-08 关闭小窗期间拨 60 秒：手竿 +0；页面角落写"小窗已关闭，输入计数和手竿计时已暂停。"', e3 === e2 && note === T_.closed, { gain: e3 - e2, note });

      await setMode('路亚');
      const e4 = await poleMs();
      const lure = await statText('cycle');
      await advance(60000);
      await sleep(1100);
      const e5 = await poleMs();
      await setMode('手竿');
      await sleep(1200);
      const back = await statTitle('cycle');
      const e6 = await poleMs();
      check('B2-08 切路亚期间拨 60 秒：手竿不涨、底栏显示路亚进度；切回后悬停是"手竿计时中"、接着计',
        e5 === e4 && /^本轮\d+\/\d+/.test(lure) && back.startsWith(T_.poleRunningPrefix) && !back.includes(T_.polePausedPrefix) && e6 >= e5, { lure, gain: e5 - e4, back: back.split('\n')[0], after: e6 - e5 });
    }

    // ───── B2-09 刷新不补离线 ─────
    {
      await advance(30000);
      await sleep(5600); // 只涨时间时 5 秒存一次
      await settle();
      const saved = (await stored()).Groups['pole|map1'].ElapsedMs;
      await ev(`window.moyuDev.skew(600000)`);
      await load();
      const after = await poleMs();
      check('B2-09 拨 10 分钟后刷新：手竿时间 = 刷新前存进去的时间（2 秒内），不补这 10 分钟', after >= saved && after - saved < 2500, { saved, after });
    }

    // ───── B2-10 切图临界属于旧组 ─────
    {
      await patch(p => { p.Groups['pole|map1'] = { ...p.Groups['pole|map1'], ElapsedMs: HOUR - 1000 }; p.Groups['pole|map2'] = { Count: 0, Cycle: 0, ElapsedMs: 0 }; });
      const p0 = await P();
      await ev(`window.moyuDev.skew(2000)`);
      await setMap(2);
      await sleep(500);
      const p1 = await P();
      const fish = p1.Fish.filter(f => !p0.Fish.some(g => g.Id === f.Id));
      const m1 = p1.Groups['pole|map1'].ElapsedMs, m2 = p1.Groups['pole|map2']?.ElapsedMs ?? 0;
      check('B2-10 地图一差 1 秒满时拨 2 秒再切地图二：出的那条是地图一的；地图一余下零头；地图二从 0 起',
        fish.length === 1 && fish[0].MapId === 'map1' && fish[0].CatchEventId.startsWith('catch|pole|map1|') && m1 < 6000 && m2 < 3000, { fish: fish.map(f => [f.MapId, f.CatchEventId]), m1, m2 });
      await setMap(1);
    }

    // ───── B2-11 只读页不计时；保存失败不发卡片、新鱼数 ─────
    {
      await settle();
      const s0 = await stored();
      const tab2 = await openTab(base.href);
      const ro = await tab2.waitFor(`window.__t && window.moyuDev && window.__t.save() === '只读'`, 30000);
      const f0 = (await tab2.ev('window.moyuDev.profile()')).Fish.length;
      for (let i = 0; i < 7; i++) { await tab2.ev(`window.moyuDev.skew(${STEP})`); await tab2.ev('window.moyuDev.poleTick()'); }
      await sleep(500);
      const r2 = {
        fish: (await tab2.ev('window.moyuDev.profile()')).Fish.length - f0,
        card: await tab2.ev(`!!document.querySelector('.catch-card')`),
        pole: await tab2.ev(`window.__t.stat('cycle').title.split('\\n')[0]`),
        save: await tab2.ev(`window.__t.stat('save').title`),
      };
      await closeTab(tab2);
      const s1 = await stored();
      check('B2-11 第二个标签页只读：拨满 30 分钟也不计时、不出鱼，悬停"手竿已暂停"；存档里鱼数不变；保存状态悬停"当前页面只读。请在正在运行游戏的页面继续操作。"',
        ro && r2.fish === 0 && !r2.card && r2.pole.startsWith(T_.polePausedPrefix) && s1.Fish.length === s0.Fish.length && r2.save === T_.readOnly, r2);

      const badge0 = Number(await T('badge()') ?? 0);
      await ev('window.moyuDev.failSaves(true)');
      const p0 = await P();
      const fish = await fillPole();
      await sleep(1500);
      const during = { save: await T('save()'), title: await statTitle('save'), card: await ev(`!!document.querySelector('.catch-card')`), badge: Number(await T('badge()') ?? 0) };
      const storedDuring = (await stored()).Fish.length;
      await ev('window.moyuDev.failSaves(false)');
      const appeared = await waitFor(`document.querySelector('.catch-card')?.dataset.fish === ${JSON.stringify(fish.Id)}`, 6000);
      await settle();
      const badge1 = Number(await T('badge()') ?? 0);
      const s2 = await stored();
      check('B2-11 保存失败时满 30 分钟：显示未保存（悬停"保存失败，尚未确认的进度不会显示为已获得。请重试。"）、没有卡片、新鱼数不变；恢复后补存，卡片和新鱼数出现，只 1 条',
        during.save === '未保存' && during.title === T_.saveRetry && !during.card && during.badge === badge0 && storedDuring === p0.Fish.length
        && appeared && badge1 === badge0 + 1 && s2.Fish.filter(f => f.CatchEventId === fish.CatchEventId).length === 1, { during, appeared, badge: [badge0, badge1] });
    }

    // ═════════════ 鱼获卡片与新鱼数 ═════════════
    const clearBadge = async () => { await openPanel('鱼篓'); await sleep(300); await closePanels(); await settle(); };

    // ───── B2-15 卡片和新鱼数同时出现、超时不清；合成；打开鱼篓清掉 ─────
    {
      await clearBadge();
      await patch(p => { setCount(p, 'lure|map1', 999); setCount(p, 'wade|map1', 1999); });
      await setMode('路亚');
      const b0 = await T('badge()');
      await focusNotepad(); await key('k');
      await waitFor(`!!document.querySelector('.catch-card')`, 5000);
      const t = Date.now();
      const at = { badge: await T('badge()'), title: await ev(`document.querySelector('[data-stat=new-fish]')?.title`) };
      check('B2-15 出鱼时卡片和底栏鱼篓上的"1"同时出现，悬停"新鱼 1 条"', b0 === null && at.badge === '1' && at.title === '新鱼 1 条', { b0, ...at });
      await sleep(Math.max(0, 4700 - (Date.now() - t)));
      const later = { card: await ev(`!!document.querySelector('.catch-card')`), badge: await T('badge()') };
      check('B2-15 卡片 4 秒后消失，新鱼数还在', !later.card && later.badge === '1', later);
      await patch(p => { setCount(p, 'lure|map1', 999); });
      await focusNotepad(); await key('k');
      await waitFor(`!!document.querySelector('.catch-card')`, 5000);
      await setMode('摸鱼');
      await focusNotepad(); await key('k');
      const merged = await waitFor(`document.querySelector('.catch-card')?.dataset.count === '2'`, 5000);
      const two = { text: await ev(`document.querySelector('.catch-card')?.innerText ?? ''`), badge: await T('badge()') };
      await clickBtn('鱼篓');
      await sleep(400);
      const opened = await T('badge()');
      await closePanels();
      await settle();
      check('B2-15 再连出 2 条：卡片"+2"、新鱼数 3；打开鱼篓后数字消失', merged && two.text.includes('+2') && two.badge === '3' && opened === null && (await P()).NewFishIds.length === 0, { two, opened });
      await setMode('路亚');
    }

    // ───── B2-16 刷新恢复；开着鱼篓时到的鱼直接算看过 ─────
    {
      await patch(p => { setCount(p, 'lure|map1', 999); setCount(p, 'wade|map1', 1999); });
      await focusNotepad(); await key('k');
      await waitFor(`window.__t.badge() === '1'`, 5000);
      await setMode('摸鱼');
      await focusNotepad(); await key('k');
      await waitFor(`window.__t.badge() === '2'`, 5000);
      await setMode('路亚');
      await patch(p => { setCount(p, 'lure|map1', 999); });
      const afterReload = await T('badge()');
      await clickBtn('鱼篓');
      await sleep(400);
      const opened = await T('badge()');
      const n0 = (await P()).Fish.length;
      await focusNotepad(); await key('k');
      await waitFor(`window.moyuDev.profile().then(p => p.Fish.length === ${n0 + 1})`, 5000);
      await settle();
      const p1 = await P();
      const newest = p1.Fish[p1.Fish.length - 1];
      const listed = (await basketIds()).includes(newest.Id);
      check('B2-16 2 条未看过时刷新仍是 2；打开鱼篓后 0；鱼篓开着时到的那条显示出来就算看过',
        afterReload === '2' && opened === null && listed && !p1.NewFishIds.includes(newest.Id) && (await T('badge()')) === null, { afterReload, opened, listed, newFish: p1.NewFishIds });
      await closePanels();
      await settle();
      await load();
      const reloaded = await T('badge()');
      check('B2-16 关掉鱼篓再刷新：仍没有新鱼数', reloaded === null && (await P()).NewFishIds.length === 0, { reloaded });
    }

    // ───── B2-17 收起时出鱼不展开、不补播 ─────
    {
      await patch(p => { setCount(p, 'lure|map1', 999); });
      await clickBtn('收起');
      const n0 = (await P()).Fish.length;
      await focusNotepad(); await key('k');
      await waitFor(`window.moyuDev.profile().then(p => p.Fish.length === ${n0 + 1})`, 5000);
      const t = Date.now();
      await sleep(1500);
      const collapsed = await ev(`!document.querySelector('#pet') && !!document.querySelector('#avatar')`);
      await sleep(Math.max(0, 5000 - (Date.now() - t)));
      await clickAt(await T(`center('#avatar')`));
      await sleep(300);
      const after = { card: await ev(`!!document.querySelector('.catch-card')`), badge: await T('badge()') };
      check('B2-17 收起时出鱼：小窗不展开；5 秒后恢复没有卡片补播，新鱼数 1', collapsed && !after.card && after.badge === '1', { collapsed, ...after });
    }

    // ───── B2-18 点卡片只选还在鱼篓的那条 ─────
    {
      await patch(p => { setCount(p, 'lure|map1', 999); });
      await focusNotepad(); await key('k');
      await waitFor(`!!document.querySelector('.catch-card')`, 5000);
      const id1 = await ev(`document.querySelector('.catch-card').dataset.fish`);
      await clickSel('.catch-card');
      const sel1 = await ev(`document.querySelector('.basket .fish-cell.on')?.dataset.fish ?? null`);
      await closePanels();
      await patch(p => { setCount(p, 'lure|map1', 999); });
      await focusNotepad(); await key('k');
      await waitFor(`!!document.querySelector('.catch-card')`, 5000);
      const id2 = await ev(`document.querySelector('.catch-card').dataset.fish`);
      await clickBtn('鱼篓', 150);
      await selectFish(id2);
      await clickSel('.basket .collect', 150);
      await closePanels();
      const cardStill = await ev(`document.querySelector('.catch-card')?.dataset.fish ?? null`);
      if (cardStill) await clickSel('.catch-card', 300);
      const second = { panels: await T('panels()'), sel: await ev(`document.querySelector('.basket .fish-cell.on')?.dataset.fish ?? null`) };
      const copies = (await P()).Fish.filter(f => f.Id === id2);
      check('B2-18 点卡片打开鱼篓并选中那条；那条已放进收藏时点卡片只打开鱼篓、不选中，鱼仍只在鱼缸里',
        sel1 === id1 && cardStill === id2 && second.panels.some(p => p.includes('basket')) && second.sel === null && copies.length === 1 && copies[0].Place === 'Tank', { sel1, id1, id2, cardStill, second, places: copies.map(f => f.Place) });
      await closePanels();
    }

    // ═════════════ 记录（B2-13） ═════════════
    {
      await settle();
      let p = await P();
      const inBasket = sp => p.Fish.filter(f => f.Place === 'Basket' && f.SpeciesId === sp);
      let species = Object.keys(p.Records).filter(sp => inBasket(sp).length > 0);
      if (species.length < 2) throw new Error('鱼篓里不足两种抓到的鱼：' + species);
      await openPanel('记录');
      const read = async () => {
        const rows = await ev(`[...document.querySelectorAll('.record-row')].map(r => ({ slot: r.dataset.slot, sp: r.dataset.species ?? null, text: r.innerText.trim() }))`);
        const details = [];
        for (const r of rows) {
          await clickSel(`.record-row[data-slot="${r.slot}"]`, 100);
          details.push(await ev(`(() => { const d = document.querySelector('.records .fish-detail'); return { text: d.innerText.replace(/\\s+/g, ' ').trim(), svg: !!d.querySelector('svg.big') }; })()`));
        }
        return { rows, details, found: await statText('records') };
      };
      const r0 = await read();
      const n = Object.keys(p.Records).length;
      const known = r0.rows.map((r, i) => [r, r0.details[i]]).filter(([r]) => r.sp);
      const okKnown = known.length === n && known.every(([r, d]) => {
        const rec = p.Records[r.sp];
        return d.svg && d.text.includes(`最长 ${cm(rec.MaxLengthMm)}`) && /抓到 \d+ 次 · 首次 \d{4}-\d\d-\d\d \d\d:\d\d/.test(d.text) && d.text.includes(`抓到 ${rec.Count} 次`) && FISH_NAMES.some(nm => r.text === nm && d.text.includes(nm));
      });
      const okUnknown = r0.rows.filter(r => !r.sp).every((r, i) => r.text === '？');
      // 把其中一种在鱼篓里的全部卖掉、另一种放一条进收藏，纪录不变
      const [sellSp, keepSp] = species;
      await openPanel('鱼篓');
      for (const f of inBasket(sellSp)) await clickSel(`.basket .fish-cell[data-fish="${f.Id}"] .tick`, 80);
      await clickSel('.basket .sell');
      await confirmSale();
      p = await P();
      await selectFish(inBasket(keepSp)[0].Id);
      await clickSel('.basket .collect');
      await settle();
      await openPanel('记录');
      const r1 = await read();
      const p1 = await P();
      check('B2-13 抓过的显示鱼形、名字、"最长 x.x cm"、"抓到 n 次 · 首次 YYYY-MM-DD HH:mm"，其余只有"？"，顶部"已发现 n/6"；卖掉一种、收藏一种后纪录和显示都不变',
        n >= 2 && r0.found === `已发现${n}/6` && okKnown && okUnknown && JSON.stringify(r1) === JSON.stringify(r0) && JSON.stringify(p1.Records) === JSON.stringify(p.Records)
        && !p1.Fish.some(f => f.Place === 'Basket' && f.SpeciesId === sellSp), { found: r0.found, known: known.map(([r, d]) => d.text), sellSp, keepSp });
      await closePanels();
    }

    // ═════════════ 鱼篓与出售原句（B2-27） ═════════════
    {
      await ev('window.moyuDev.injectFish(3)');
      await settle();
      await openPanel('鱼篓');
      const ids = await basketIds();
      const fishOf = async id => (await P()).Fish.find(f => f.Id === id);
      const f0 = await fishOf(ids[0]);
      await selectFish(f0.Id);
      const detail = await ev(`(() => { const d = document.querySelector('.basket .fish-detail'); const t = s => d.querySelector(s)?.innerText.trim(); return { name: t('.name'), desc: t('.desc'), len: t('.len'), chip: t('.chip'), price: +d.querySelector('.chip').dataset.price, meta: t('.meta') }; })()`);
      const when = await T(`fullTime(${f0.CaughtAtMs})`);
      await clickSel(`.basket .fish-cell[data-fish="${ids[0]}"] .tick`, 80);
      await clickSel(`.basket .fish-cell[data-fish="${ids[1]}"] .tick`, 80);
      const picked = await ev(`document.querySelector('[data-stat=picked]')?.innerText.trim()`);
      const descOk = await ev(`document.querySelector('.basket .fish-detail .desc').innerText.trim()`) === detail.desc;
      const expectDesc = new RegExp(`"${f0.SpeciesId}" => "([^"]*)"`).exec(TEXTS.slice(TEXTS.indexOf('FishDescription(')))[1];
      check('B2-27 空鱼篓"鱼篓是空的。"；详情有鱼的描述、"体长 x cm"、"售价 n"、"捕获时间 YYYY-MM-DD HH:mm"；勾 2 条显示"已选 2 条"',
        emptyBasket === T_.basketEmpty && descOk && detail.desc === expectDesc && detail.len === `体长 ${cm(f0.LengthMm)}` && detail.chip === `售价 ${detail.price}` && detail.meta === `捕获时间 ${when}` && picked === '已选 2 条',
        { emptyBasket, detail, when, picked });

      await clickSel('.basket .sell');
      const q = await ev(`(() => { const c = document.querySelector('.confirm'); return { title: c.querySelector('b')?.innerText.trim(), lines: [...c.querySelectorAll('.line-row')].map(r => ({ text: r.innerText.trim(), id: r.dataset.fish, price: +r.dataset.price })), total: c.querySelector('.total').innerText.trim(), sum: +c.querySelector('.total').dataset.total, final: c.querySelector('.final')?.innerText.trim() }; })()`);
      const names = Object.fromEntries((await P()).Fish.map(f => [f.Id, f]));
      const lineOk = q.lines.every(l => { const f = names[l.id]; return /^.+ · \d+\.\d cm · \d+ 金币$/.test(l.text) && l.text.includes(cm(f.LengthMm)) && l.text.endsWith(`${l.price} 金币`); });
      const c0 = (await P()).Coins;
      await confirmSale();
      const rec = await notice();
      const c1 = (await P()).Coins;
      // 过期报价：确认框开着时把要卖的那条放进收藏（管理点击直接派发），再确认
      const [id3] = await basketIds();
      await selectFish(id3);
      await clickSel('.basket .sell');
      await ev(`document.querySelector('.basket .collect').dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
      await waitFor(`window.moyuDev.profile().then(p => p.Fish.find(f => f.Id === ${JSON.stringify(id3)}).Place === 'Tank')`, 5000);
      await clickSel('.confirm .ok', 600);
      const stale = await notice();
      await closePanels();
      check('B2-27 确认框"确认出售 2 条？"，每行"鱼名 · x cm · n 金币"，"合计 +n"，"确认后鱼将被出售，本轮不支持撤销。"；回执"卖出 2 条，+x，余额 y。"；报价过期"鱼或报价有变化，请重新选择后再卖。"',
        q.title === '确认出售 2 条？' && q.lines.length === 2 && lineOk && q.total === `合计 +${q.sum}` && q.final === T_.saleFinal
        && rec?.text === `卖出 2 条，+${q.sum}，余额 ${c1}。` && c1 === c0 + q.sum && stale?.text === T_.saleStale && stale.error, { q, rec, stale });
    }

    // ═════════════ 皮肤原句（B2-28） ═════════════
    {
      const skinName = id => new RegExp(`"${id}"(?: or "\\w+")* => "([^"]*)"`).exec(TEXTS.slice(TEXTS.indexOf('SkinName(')))[1];
      const odds = () => ev(`(() => { const o = document.querySelector('[data-stat=odds]'); const pool = o.querySelector('[data-stat=pool]'); return { text: o.innerText, pool: pool.dataset.pool, poolText: pool.innerText.trim() }; })()`);
      await ev('window.moyuDev.addCoins(100)');
      await patch(p => { p.Coins = 500; p.OwnedSkins = [...BASES, 'WEB_CHAR_01', 'WEB_ROD_01']; p.DuplicateStreak = 0; });
      await openPanel('皮肤');
      await clickSel('.skin .tabpill[data-tab=Rod]', 150);
      await clickSel('.skin-cell[data-skin=WEB_ROD_02]', 150);
      const look = await ev(`({ desc: document.querySelector('.skin-desc')?.innerText.trim(), notes: document.querySelector('.skin-notes')?.innerText.trim(), state: document.querySelector('.preview-side .state')?.innerText.trim() })`);
      const normal = await odds();
      await patch(p => { p.DuplicateStreak = 4; });
      await openPanel('皮肤');
      const sure = await odds();
      check('B2-28 皮肤页"每抽100金币，重复返20金币。"；普通时写 12 款各 1/12 那套，必新时只写"本次只从尚未拥有的外观中等概率抽取，每款机会为1/10。"（两套不同时出现）；外观描述、纯外观说明、装备说明',
        normal.text.includes(T_.drawPrice) && normal.pool === 'all' && normal.poolText === T_.drawOdds && !normal.text.includes('尚未拥有的外观')
        && sure.pool === 'new' && sure.poolText === '本次只从尚未拥有的外观中等概率抽取，每款机会为1/10。' && !sure.text.includes('12款外观各有') && sure.text.includes('下一抽必出新款。')
        && look.desc === '竹节纹样的竿身，缠着一小段红线。' && look.notes.includes(T_.cosmetic) && look.notes.includes(T_.equipHelp) && look.state === '未拥有', { normal, sure, look });

      // 抽新款、抽重复、余额不足、集齐
      await patch(p => { p.Coins = 200; p.OwnedSkins = [...BASES]; p.DuplicateStreak = 0; });
      await openPanel('皮肤');
      await clickSel('.draw-btn', 700);
      const got = await ev(`(() => { const d = document.querySelector('.last-draw'); return { id: d.dataset.skin, dup: d.dataset.duplicate === 'true', text: d.innerText.trim() }; })()`);
      const r = await raw(), pr = parse(r.json);
      const dupSkin = nextDraw(r.seed, pr.DrawSeq, pr.OwnedSkins.filter(s => !BASES.includes(s)), pr.DuplicateStreak);
      await patch(p => { p.OwnedSkins = [...new Set([...p.OwnedSkins, dupSkin])]; p.Coins = 100; });
      await openPanel('皮肤');
      await clickSel('.draw-btn', 700);
      const dup = await ev(`(() => { const d = document.querySelector('.last-draw'); return { id: d.dataset.skin, dup: d.dataset.duplicate === 'true', text: d.innerText.trim() }; })()`);
      const poor = await ev(`(() => { const b = document.querySelector('.draw-btn'); return { disabled: b.disabled, title: b.title }; })()`);
      const coins = (await P()).Coins;
      await patch(p => { p.OwnedSkins = [...BASES, ...POOL]; });
      await openPanel('皮肤');
      const all = await ev(`({ text: document.querySelector('.all-owned')?.innerText.trim(), title: document.querySelector('.draw-btn').title })`);
      await closePanels();
      check('B2-28 抽到新款"获得新外观：名。"；抽到重复"重复外观：名，返还20金币。"；余额不足时抽取按钮悬停"金币不够，还差 n。"；集齐"已拥有全部可抽外观，不再扣除金币。"',
        !got.dup && got.text === `获得新外观：${skinName(got.id)}。` && dup.dup && dup.id === dupSkin && dup.text === `重复外观：${skinName(dupSkin)}，返还20金币。`
        && poor.disabled && coins === 20 && poor.title === '金币不够，还差 80。' && all.text === T_.allOwned && all.title === T_.allOwned, { got, dup, poor, coins, all });
    }

    // ───── B2-27 账本类型和重复抽取说明 ─────
    {
      await openPanel('鱼篓');
      await clickSel('.basket .btn.small');
      const rows = await ev(`[...document.querySelectorAll('.ledger-row')].map(r => ({ kind: r.querySelector('.kind').innerText.trim(), what: r.querySelector('.what').innerText.trim() }))`);
      await closePanels();
      const kinds = [...new Set(rows.map(r => r.kind))];
      check('B2-27 账本类型写"卖鱼""抽取""开发入口"；抽到重复的那条写"扣除 100，重复返还 20。"',
        ['卖鱼', '抽取', '开发入口'].every(k => kinds.includes(k)) && kinds.length === 3 && rows.some(r => r.kind === '抽取' && r.what.endsWith('扣除 100，重复返还 20。')), { kinds, rows: rows.slice(0, 6) });
    }

    // ═════════════ 底层鱼缸 ═════════════
    {
      // 鱼缸里正好 3 条
      await ev('window.moyuDev.injectFish(3)');
      await patch(p => {
        for (const f of p.Fish) if (f.Place === 'Tank') { f.Place = 'Basket'; f.TankId = null; }
        let n = 3;
        for (const f of p.Fish) if (n > 0 && f.Place === 'Basket') { f.Place = 'Tank'; f.TankId = 'tank1'; n--; }
        p.BackgroundTankId = null;
      });
      await openPanel('收藏');
      await clickSel('.collection .background');
      await waitFor(`document.querySelector('.collection .background').dataset.on === 'true'`, 5000);
      await closePanels();
      await settle();

      // ───── B2-20 层级、边界、裁切、不铺底 ─────
      const s = await ev(`(() => {
        const svg = document.querySelector('svg.scene'), g = svg.querySelector('.bg-tank'), frame = g.querySelector('.bg-tank-frame'), clip = svg.querySelector('#bg-tank-clip rect');
        const box = e => ({ x: +e.getAttribute('x'), y: +e.getAttribute('y'), w: +e.getAttribute('width'), h: +e.getAttribute('height') });
        const fish = [...g.querySelectorAll('.bg-fish')].map(f => { const b = f.getBBox(); return { len: +f.dataset.len, s: +/scale\\(([\\d.]+)\\)/.exec(f.querySelector('.fish').getAttribute('transform'))[1], b: { x: b.x, y: b.y, w: b.width, h: b.height } }; });
        return { first: svg.firstElementChild === g, beforeBear: !!(g.compareDocumentPosition(svg.querySelector('g.bear')) & Node.DOCUMENT_POSITION_FOLLOWING),
          frame: box(frame), frameFill: frame.getAttribute('fill'), clip: box(clip), clipped: g.querySelector('.bg-tank-fish').getAttribute('clip-path'), nohit: getComputedStyle(g).pointerEvents, fish };
      })()`);
      const inside = (b, r) => b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;
      const canvas = { x: 0, y: 0, w: 1600, h: 900 };
      const sameScale = s.fish.length === 3 && s.fish.every(f => near(f.s / f.len, s.fish[0].s / s.fish[0].len, 0.001 * s.fish[0].s / s.fish[0].len));
      await shot('03-bg-tank');
      check('B2-20 鱼缸层是场景第一个元素（最底下），小熊等都画在它上面；缸框在 1600×900 内、向内画、不填色；鱼裁在缸内且落在缸里；缸里鱼共用一个比例；整层不接指针',
        s.first && s.beforeBear && inside(s.frame, canvas) && s.frame.x > 0 && s.frameFill === 'none' && inside(s.clip, canvas) && s.clipped === 'url(#bg-tank-clip)'
        && s.fish.every(f => inside(f.b, s.clip)) && sameScale && s.nohit === 'none', s);

      // ───── B2-21 不截获点击 ─────
      const fishPt = await ev(`(() => { const r = document.querySelector('svg.scene .bg-fish .fish').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      const framePt = await scenePt(16, 300);
      const hitOn = { fish: await T(`inPet(${fishPt.x}, ${fishPt.y})`), frame: await T(`inPet(${framePt.x}, ${framePt.y})`) };
      const b0 = await T('bear()');
      await clickAt(await scenePt(b0.x > 800 ? 600 : 1000, 565));
      const b1 = await T('bear()');
      await setMode('摸鱼');
      const bw = await T('bear()');
      await clickAt(await scenePt(bw.x > 800 ? 450 : 1450, 700));
      const b2 = await T('bear()');
      await setMode('路亚');
      check('B2-21 穿透开：天空里的缸鱼和缸框处命中下层桌面；岸边、浅水（摸鱼）照常选位',
        !hitOn.fish && !hitOn.frame && b1.x !== b0.x && b2.x !== bw.x && b2.mode === 'Wade', { hitOn, bears: [b0.x, b1.x, bw.x, b2.x] });
      await openPanel('设置');
      await clickSel('.setting-row[data-setting=passthrough] [role=switch]');
      await closePanels();
      const hitOff = await ev(`(() => { const e = document.elementFromPoint(${fishPt.x}, ${fishPt.y}); return { pet: !!e?.closest('#pet'), tank: !!e?.closest('.bg-tank') }; })()`);
      const t0 = await total();
      const fp = await ev(`(() => { const r = document.querySelector('svg.scene .bg-fish .fish').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await clickAt(fp, 500);
      const after = { panels: await T('panels()'), total: (await total()) - t0 };
      await openPanel('设置');
      await clickSel('.setting-row[data-setting=passthrough] [role=switch]');
      await closePanels();
      check('B2-21 穿透关：缸鱼处命中小窗本身而不是鱼缸层；单击缸鱼不打开任何东西、不计数', hitOff.pet && !hitOff.tank && after.panels.length === 0 && after.total === 0, { hitOff, after });

      // ───── B2-22 归属变化及时反映；取消不清鱼；空缸只画缸框 ─────
      const count = () => ev(`document.querySelectorAll('svg.scene .bg-fish').length`);
      await openPanel('收藏');
      const inTank = await ev(`[...document.querySelectorAll('.tank .tank-fish')].map(g => g.dataset.fish)`);
      await ev(`document.querySelector('.tank .tank-fish[data-fish="${inTank[0]}"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
      await sleep(200);
      await clickSel('.tank-side .retrieve');
      await closePanels();
      const n2 = await count();
      await openPanel('鱼篓');
      await selectFish((await basketIds())[0]);
      await clickSel('.basket .collect');
      await closePanels();
      const n3 = await count();
      await openPanel('收藏');
      await clickSel('.collection .background');
      await waitFor(`document.querySelector('.collection .background').dataset.on === 'false'`, 5000);
      await closePanels();
      const off = { layer: await ev(`!!document.querySelector('svg.scene .bg-tank')`), tank: (await P()).Fish.filter(f => f.Place === 'Tank').length };
      // 空缸设为背景
      await patch(p => { for (const f of p.Fish) if (f.Place === 'Tank') { f.Place = 'Basket'; f.TankId = null; } });
      await openPanel('收藏');
      await clickSel('.collection .background');
      await waitFor(`document.querySelector('.collection .background').dataset.on === 'true'`, 5000);
      await closePanels();
      const empty = await ev(`({ layer: !!document.querySelector('svg.scene .bg-tank'), frame: !!document.querySelector('svg.scene .bg-tank-frame'), fish: document.querySelectorAll('svg.scene .bg-fish').length })`);
      check('B2-22 取回 1 条层里剩 2 条、再放 1 条回到 3 条；取消背景后层消失、缸里 3 条还在；空缸设为背景只画缸框',
        n2 === 2 && n3 === 3 && !off.layer && off.tank === 3 && empty.layer && empty.frame && empty.fish === 0, { n2, n3, off, empty });

      // ───── B2-23 B1 版旧档的背景 ─────
      await patch(p => {
        let n = 2;
        for (const f of p.Fish) if (n > 0 && f.Place === 'Basket') { f.Place = 'Tank'; f.TankId = 'tank1'; n--; }
        p.BackgroundTankId = 'tank1';
        p.Schema = 1; p.RulesVersion = 'web_core_0.1';
        delete p.NewFishIds;
        for (const g of Object.values(p.Groups)) delete g.ElapsedMs;
      });
      const old = await P();
      const layer = await ev(`[...document.querySelectorAll('svg.scene .bg-tank .bg-fish')].map(g => g.dataset.fish)`);
      check('B2-23 B1 版存档（Schema 1，设过背景）：读得进、升到 2、背景仍设着，鱼在底层鱼缸里',
        old.Schema === 2 && old.RulesVersion === 'web_core_0.2' && old.BackgroundTankId === 'tank1' && layer.length === 2 && old.NewFishIds.length === 0 && (await T('save()')) === '已保存', { schema: old.Schema, layer });

      // ───── B2-28 收藏原句；20 条满 ─────
      await ev('window.moyuDev.injectFish(21)');
      await patch(p => {
        let need = 20 - p.Fish.filter(f => f.Place === 'Tank').length;
        for (const f of p.Fish) if (need > 0 && f.Place === 'Basket') { f.Place = 'Tank'; f.TankId = 'tank1'; need--; }
      });
      await openPanel('鱼篓');
      await selectFish((await basketIds())[0]);
      await clickSel('.basket .collect');
      const full = await notice();
      await openPanel('收藏');
      const cap = await ev(`document.querySelector('[data-stat=tank]').innerText.trim()`);
      const help = await ev(`document.querySelector('.tank-side .hint')?.innerText.trim()`);
      await closePanels();
      check('B2-28 收藏"n/20"、空缸"鱼缸是空的，从鱼篓放鱼进来。"、有鱼时"点缸里的鱼可以取回。"、背景说明、"更多鱼缸尚未开放。"；满缸"鱼缸满了（20/20），鱼还在鱼篓里。"',
        emptyTank.cap === '0/20' && emptyTank.hint === T_.tankEmpty && emptyTank.more === T_.moreTanks && emptyTank.bg === T_.tankBg && cap === '20/20' && help === '点缸里的鱼可以取回。'
        && full?.text === T_.tankFull && full.error, { emptyTank, cap, help, full });
    }

    // ───── B2-26 读档失败、版本不认识 ─────
    {
      await settle();
      const good = await T(`idb('get')`);
      await T(`idb('put', ${JSON.stringify({ revision: good.revision + 5, json: '{"Schema":2,"Fish":[' })})`);
      await load(['读档失败']);
      const broken = { save: await T('save()'), title: await statTitle('save') };
      await T(`idb('put', ${JSON.stringify({ revision: good.revision + 6, json: good.json.replace('"Schema":2', '"Schema":3') })})`);
      await load(['读档失败']);
      const future = { save: await T('save()'), title: await statTitle('save'), kept: (await T(`idb('get')`)).json.includes('"Schema":3') };
      await T(`idb('put', ${JSON.stringify({ revision: good.revision + 10, json: good.json })})`);
      await load();
      check('B2-26 存档坏了悬停"读档失败，现有存档未被覆盖。请重试。"；版本不认识悬停"当前存档版本无法读取，现有数据未被覆盖。"且存档原样',
        broken.save === '读档失败' && broken.title === T_.loadFailed && future.save === '读档失败' && future.title === T_.unknownVersion && future.kept, { broken, future });
    }

    check('控制台无报错', consoleErrors.length === 0, consoleErrors.slice(0, 5));
  },
});
