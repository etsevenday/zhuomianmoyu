#!/usr/bin/env node
// B3 同图房间浏览器验收：执行 doc/测试用例/B3 同图房间.md 里方式为 B、S 的用例，每个 check 名以用例号开头。
//
// 用法：
//   node tools/verify/b3.mjs [网址|--release] [输出目录]
//   --release：先照 CI 的方式发布本地 Release 包，挂在 http://127.0.0.1:5199/zhuomianmoyu/ 上测（推送前的主关卡）
//   网址默认线上 https://etsevenday.github.io/zhuomianmoyu/ ，脚本自动加 ?dev=1；开发中也可测 http://localhost:5188/
//   输出默认系统临时目录下 moyu-b3；环境变量 CHROME 指定浏览器、PLAYTEST_PORT 指定调试端口（默认 9341）
//
// 房间全在内存里，刷新就回单人，所以每个用例先刷新一次、从没有房间开始。房间操作都从房间面板的"演示控制"点；
// 界面上那一刻点不到的（收起时让好友收获、查看鱼缸时让对方断线或结束模拟）用开发入口 moyuDev.room(动作, 成员)，
// 重复和旧代次的好友收获消息用 moyuDev.roomReplay() 造（网页模拟里没有网络）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBatch, sleep, near } from './cdp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEXTS = fs.readFileSync(path.join(REPO, 'web/Moyu.Web/Services/Texts.cs'), 'utf8');
const COPY = fs.readFileSync(path.join(REPO, 'doc/策划案/文案交接 v0.1/04 B3房间文案定稿.md'), 'utf8');

const cm = mm => `${Math.floor(mm / 10)}.${mm % 10} cm`;
const FISH = { TMP_F001: '银白小鱼', TMP_F002: '青圆点鱼', TMP_F003: '金扇尾鱼', TMP_F101: '荷叶尾鱼', TMP_F201: '蓝纹长鱼', TMP_F301: '云纹大鱼' };
const MAPS = { map1: '地图一', map2: '地图二', map3: '地图三' };
const MODE = { 路亚: 'Lure', 手竿: 'Pole', 摸鱼: 'Wade' };
// 地图空间（09 §3）：占地框 180×40，同一区域里两两不相交（贴住算不相交）
const AREA = { shore: { l: 40, t: 540, r: 1560, b: 590 }, shallow: { l: 40, t: 650, r: 1560, b: 760 } };
const areaOf = mode => mode === 'Wade' ? 'shallow' : 'shore';
const inArea = b => { const a = AREA[areaOf(b.mode)]; return b.x - 90 >= a.l - 1e-6 && b.x + 90 <= a.r + 1e-6 && b.y - 20 >= a.t - 1e-6 && b.y + 20 <= a.b + 1e-6; };
const apart = bs => bs.every((a, i) => bs.every((b, j) => j <= i || areaOf(a.mode) !== areaOf(b.mode) || Math.abs(a.x - b.x) >= 180 - 1e-6 || Math.abs(a.y - b.y) >= 40 - 1e-6));
const placed = bs => bs.length > 0 && apart(bs) && bs.every(inArea);

// ───────────── 定稿原句（和 Texts.cs、定稿 04 一致；这里写死，改文案时两边一起对） ─────────────
const T_ = {
  intro: '本机模拟好友，用于体验同图陪伴。当前不会连接真实好友或Steam。',
  none: '还未进入模拟房间。',
  refresh: '刷新会结束本次模拟，个人进度和资产按已保存状态恢复。',
  noInvite: '网页版暂不提供真实邀请链接。Steam好友邀请将在PC版接入。',
  sample: '模拟鱼获和鱼缸仅作展示，不会加入你的鱼篓、金币或捕获记录。',
  count: n => `房间人数 ${n}/4（含房主）`,
  hostOnly: '只有房主可以切换地图。',
  hostHelp: '切换后，全房成员会一起前往所选地图。各地图进度分别保留。',
  followed: m => `已跟随房间前往${m}，原地图进度已保留。`,
  left: m => `已离开房间，留在${m}。个人进度和资产已保留。`,
  full: '房间已满（4/4）。',
  followHost: '房间场景主题与背景鱼缸跟随当前房主，离房后恢复你的显示设置。',
  ownOutfit: '每位成员显示自己装备的人物、鱼竿和手套。',
  locked: '正在切换房主，暂时不能切图或换位。',
  ended: '房间已结束，已返回单机。个人进度和资产已保留。',
  migrating: '房主已离开，正在切换房主…',
  newHost: n => `${n}已成为房主。`,
  migrationFailed: '房主迁移失败，已返回单机。个人进度和资产已保留。',
  rejoined: n => `${n}已重新加入房间。`,
  gone: n => `${n}已断线，位置已释放。`,
  selfDropped: '连接已中断，原位置已释放。重新加入后会重新安排位置。',
  rejoining: '正在重新加入房间…',
  rejoinFailed: '重新加入失败，你仍可继续单机游玩。',
  catchTitle: n => `${n}的新鱼获`,
  catchNote: '好友收获只作展示，不会加入你的鱼篓、新鱼数量或捕获记录。',
  viewTitle: n => `${n}的背景鱼缸`,
  shareNote: '同房成员可查看你当前设为背景的鱼缸；鱼篓、金币和其他收藏不会在这里公开。',
  readOnly: '这里只能查看，不能取回、出售或加入自己的收藏。',
  notSet: '对方还未设置背景鱼缸。',
  emptyTank: '这个鱼缸暂时没有鱼。',
  tankGone: '对方已离开房间，暂时无法查看。',
  expired: '这份展示已失效，请返回房间重新选择成员。',
  sound: '好友收获提示音受静音开关控制；静音后仍显示动作和卡片。',
  noRoom: '这里放不下',
};

// 页面里的取数小工具（每次加载自动注入）
const HELPERS = `window.__t = {
  scene(x, y) { const r = document.querySelector('svg.scene').getBoundingClientRect(); return { x: r.left + x / 1600 * r.width, y: r.top + y / 900 * r.height }; },
  center(el) { if (typeof el === 'string') el = document.querySelector(el); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; },
  btn(text) { return [...document.querySelectorAll('#pet button'), ...document.querySelectorAll('button')].find(b => b.offsetParent !== null && (b.title === text || (b.innerText || '').trim() === text)); },
  save() { return document.querySelector('[data-stat=save]')?.innerText.trim() ?? null; },
  pos(g) { const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(g.getAttribute('transform')); return { x: +m[1], y: +m[2] }; },
  bears() {
    const self = document.querySelector('svg.scene g.bear[data-hit=character]');
    const one = (id, g) => ({ id, ...this.pos(g), mode: g.dataset.mode, skins: g.dataset.skins });
    return [...(self ? [one('me', self)] : []), ...[...document.querySelectorAll('svg.scene g.friend')].map(f => one(f.dataset.member, f.querySelector('g.bear')))];
  },
  tags() { return [...document.querySelectorAll('svg.scene g.name-tag')].map(t => ({ id: t.dataset.member, host: t.dataset.host === 'true', text: t.textContent.replace(/\\s+/g, ''), x: this.pos(t).x })); },
  room() {
    const p = document.querySelector('#pet .panel.room'); if (!p) return null;
    const q = s => p.querySelector(s);
    return {
      none: q('[data-stat=room-none]')?.innerText.trim() ?? null, status: q('[data-stat=room-status]')?.innerText.trim() ?? null,
      migrating: q('[data-stat=room-migrating]')?.innerText.trim() ?? null, kind: q('[data-stat=room-kind]')?.innerText.trim() ?? null,
      count: q('[data-stat=room-count]')?.innerText.trim() ?? null, map: q('[data-stat=room-map]')?.dataset.map ?? null,
      members: [...p.querySelectorAll('.member-row')].map(r => ({ id: r.dataset.member, self: r.dataset.self === 'true', host: r.dataset.host === 'true', mode: r.dataset.mode, name: r.querySelector('.nm').innerText.trim(), tags: [...r.querySelectorAll('.tag')].map(t => t.innerText.trim()) })),
      text: p.innerText, buttons: [...p.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean),
    };
  },
  cards() {
    return [...document.querySelectorAll('#pet .friend-card')].map(c => ({ id: c.dataset.member, count: +c.dataset.count, species: c.dataset.species, len: +c.dataset.len,
      head: c.querySelector('.card-head').innerText.trim(), line: c.querySelector('.line1').innerText.trim(), tag: c.querySelector('.tag').innerText.trim(),
      mid: parseFloat(c.style.left) + parseFloat(c.style.width) / 2, pe: getComputedStyle(c).pointerEvents }));
  },
  tank() {
    const g = document.querySelector('svg.scene .bg-tank'); if (!g) return null;
    const f = g.querySelector('.bg-tank-frame');
    return { owner: g.dataset.owner, id: g.dataset.tank, fish: g.querySelectorAll('.bg-fish').length, frameX: +f.getAttribute('x'), pe: getComputedStyle(g).pointerEvents, fe: getComputedStyle(f).pointerEvents };
  },
};`;

await runBatch({
  batch: 'b3',
  helpers: HELPERS,
  async run({ main, base, check, setBuild }) {
    const { ev, waitFor, clickAt, key, press, shot, send } = main;
    const T = expr => ev(`window.__t.${expr}`);
    const P = () => ev('window.moyuDev.profile()');
    const total = async () => (await P()).LifetimeInputs;
    const prefsMap = () => ev(`JSON.parse(localStorage.getItem('moyu.prefs.v1')).MapId`);
    const focusNotepad = () => ev(`document.querySelector('#notepad textarea').focus(); true`);

    async function load() {
      await send('Page.navigate', { url: base.href });
      const ok = await waitFor(`!!window.__t && !!window.moyuPlay && !!window.moyuDev && !!document.querySelector('.taskbar') && !!document.querySelector('#pet')`, 30000);
      if (!ok) throw new Error('页面没加载出小窗');
      if (!(await waitFor(`window.__t.save() === '已保存'`, 15000))) throw new Error('存档状态不对：' + await T('save()'));
      await sleep(300);
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
    const clickScene = async (x, y, wait = 400) => clickAt(await T(`scene(${x}, ${y})`), wait);
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
    /** 静音是记住的偏好，上一条用例可能已经取消了。 */
    const unmute = async () => { if (await ev(`!!window.__t.btn('取消静音')`)) await clickBtn('取消静音'); };
    const notice = () => ev(`document.querySelector('.notice')?.innerText.trim() ?? null`);
    const room = () => T('room()');
    const bears = () => T('bears()');
    async function roomPanel() { if (!(await room())) await openPanel('房间'); }
    const demo = async (name, wait = 300) => { await roomPanel(); await clickSel(`[data-demo="${name}"]`, wait); };
    const pick = async id => { await roomPanel(); await clickSel(`.member-row[data-member="${id}"] .who`, 200); };
    async function create(friends = 0) {
      await openPanel('房间');
      await clickSel('.room .create');
      for (let i = 0; i < friends; i++) await demo('add');
    }
    async function join() {
      await openPanel('房间');
      await clickSel('.room .join');
    }
    /** 本人档里会被房间碰到的东西：一样就说明房间什么都没发、没扣。 */
    const assets = async () => {
      const p = await P();
      return JSON.stringify({ t: p.LifetimeInputs, c: p.Coins, f: p.Fish.map(f => f.Id + f.Place), r: p.Records, n: p.NewFishIds, g: p.Groups, e: p.Equipped, bg: p.BackgroundTankId });
    };

    // ═════════════ 新档 ═════════════
    await load();
    setBuild(await ev(`document.querySelector('meta[name=app-build]')?.content`));
    await setMode('路亚');
    await setMap(1);

    // ───── B3-35 静态：网页用到的 TXT-ROOM 句和定稿 04 逐字一致；PC 专属 038—048 只在联机回环代码里（B9 起） ─────
    let pcOnly = [];
    {
      const table = Object.fromEntries(COPY.split('\n').filter(l => /^\| TXT-ROOM-\d{3} \|/.test(l)).map(l => { const c = l.split('|').map(s => s.trim()); return [c[1], c[3].split(' / ')]; }));
      const norm = s => s.replace(/\{[^}]*\}(\.\{[^}]*\})?/g, '{}');
      const bad = [], used = [];
      for (const m of TEXTS.matchAll(/(?:const string \w+ = "([^"]*)"|=> \$"([^"]*)");\s*\/\/ (TXT-ROOM-\d{3})/g)) {
        const text = norm(m[1] ?? m[2]), id = m[3];
        used.push(id);
        if (!table[id]?.map(norm).includes(text)) bad.push([id, text, table[id]]);
      }
      const web = [];
      (function walk(d) {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, f.name);
          if (f.isDirectory()) { if (!['bin', 'obj', 'lib'].includes(f.name)) walk(fp); }
          else if (/\.(cs|razor|js|html)$/.test(f.name)) web.push([f.name, fs.readFileSync(fp, 'utf8')]);
        }
      })(path.join(REPO, 'web/Moyu.Web'));
      const src = web.map(([, t]) => t).join('\n');
      pcOnly = Object.entries(table).filter(([id]) => id >= 'TXT-ROOM-038' && id <= 'TXT-ROOM-048').flatMap(([id, parts]) => parts.filter(p => !p.includes('{')).map(p => [id, p]));
      // B9 起联机回环（?net=）要用这些句子：原文只许写在 Texts.cs 的 Net 常量里，常量只许联机代码用（PetSession.Net.cs、面板的联机分支）
      const netConsts = [...TEXTS.matchAll(/const string (Net\w+) = "([^"]*)";\s*\/\/ TXT-ROOM-0(?:3[89]|4\d)/g)].map(m => [m[1], m[2]]);
      const leaked = pcOnly.filter(([, p]) => web.some(([f, t]) => t.includes(p) && !(f === 'Texts.cs' && netConsts.some(([, v]) => v.includes(p)))));
      const netUsers = [...new Set(web.filter(([f, t]) => f !== 'Texts.cs' && netConsts.some(([c]) => t.includes(`Texts.${c}`))).map(([f]) => f))];
      leaked.push(...netUsers.filter(f => !['PetSession.Net.cs', 'PetPanels.razor'].includes(f)).map(f => ['用到 Net 句的文件', f]));
      const labels = ['房间', '本机模拟', '模拟成员', '创建模拟房间', '加入模拟房间', '添加模拟好友', '移除模拟好友', '演示控制', '模拟动作', '模拟收获', '模拟断线', '模拟重新加入',
        '模拟房主离开', '模拟迁移成功', '模拟迁移失败', '结束模拟', '离开房间', '跟随房主', '重新加入', '查看鱼缸', '只读'];
      const panels = ['PetPanels.razor', 'PetScene.razor'].map(f => fs.readFileSync(path.join(REPO, 'web/Moyu.Web/Components', f), 'utf8')).join('\n');
      const missing = labels.filter(l => !panels.includes(`>${l}<`) && !panels.includes(`"${l}"`));
      check('B3-35 Texts.cs 里 TXT-ROOM 句和定稿 04 逐字一致；按钮和标签用定稿短词；PC 专属 038—048 只写在 Texts.cs 的 Net 常量里、只有联机代码用；没有"链接已复制"',
        used.length >= 30 && bad.length === 0 && missing.length === 0 && leaked.length === 0 && netConsts.length >= 10 && !src.includes('链接已复制'), { used: used.length, bad, missing, leaked, netUsers });
    }

    // ───── B3-20 没进房间时的面板 ─────
    {
      const t0 = await total();
      await openPanel('房间');
      const r = await room();
      const page = await ev(`document.body.innerText`);
      const banned = ['邀请好友', '链接已复制', '已加入房间', 'Steam连接成功', '连接成功', ...pcOnly.map(([, p]) => p)].filter(w => page.includes(w));
      check('B3-20 没进房间：写"还未进入模拟房间。"、本机模拟说明、网页无真实邀请说明；只有"创建模拟房间""加入模拟房间"；页面没有邀请好友、链接已复制、已加入房间、Steam 连接成功、PC 专属 038—048',
        r.none === T_.none && r.text.includes(T_.intro) && r.text.includes(T_.noInvite) && r.text.includes(T_.refresh)
        && JSON.stringify(r.buttons) === JSON.stringify(['创建模拟房间', '加入模拟房间']) && banned.length === 0 && (await total()) === t0, { r, banned });
      await closePanels();
    }

    // ───── B3-21 建房、标模拟、刷新结束 ─────
    {
      await create();
      const r1 = await room();
      await demo('add'); await demo('add');
      const r3 = await room();
      const b3 = await bears();
      const me = r3.members.find(m => m.self);
      const friends = r3.members.filter(m => !m.self);
      await shot('b3-21-room');
      await load();
      const b = await bears();
      await openPanel('房间');
      const after = await room();
      check('B3-21 建房：写"本机模拟"、人数 1/4→3/4（含房主）；本人标"我""房主"，好友标"成员""模拟成员"、叫"模拟好友1/2"；刷新后回单人、没有好友的熊、房间页回到"还未进入模拟房间。"',
        r1.kind === '本机模拟' && r1.count === T_.count(1) && r3.count === T_.count(3) && b3.length === 3
        && me?.tags.join() === '我,房主' && me.host && friends.length === 2 && friends.every((f, i) => f.name === `模拟好友${i + 1}` && f.tags.join() === '成员,模拟成员' && !f.host)
        && b.length === 1 && b[0].id === 'me' && after.none === T_.none, { r1: r1.count, r3: r3.members, b, after: after.none });
      await closePanels();
    }

    // ───── B3-22 4 人同屏、第 5 人被拒、三图各种模式组合都排得下 ─────
    {
      await load();
      await create(3);
      const r4 = await room();
      const b4 = await bears();
      await demo('add', 100);
      const full = await notice();
      const r5 = await room();
      const b5 = await bears();
      const maps = [];
      for (const i of [2, 3, 1]) {
        await setMap(i);
        maps.push({ map: await prefsMap(), bears: await bears() });
      }
      await setMode('摸鱼');
      const wade = await bears();
      const tags = await T('tags()');
      await shot('b3-22-four');
      check('B3-22 4/4、场景 4 只熊落点互不相交且都在各自区域；第 5 次添加提示"房间已满（4/4）。"、仍 4 只不变；三张图各切一次、本人换摸鱼后仍是 4 只都排得下；每只熊头上有名字，本人写"我"、房主带"房主"',
        r4.count === T_.count(4) && b4.length === 4 && placed(b4) && full === T_.full && r5.count === T_.count(4) && JSON.stringify(b5) === JSON.stringify(b4)
        && maps.map(m => m.map).join() === 'map2,map3,map1' && maps.every(m => m.bears.length === 4 && placed(m.bears))
        && wade.length === 4 && placed(wade) && wade.find(b => b.id === 'me').mode === 'Wade'
        && tags.length === 4 && tags.every(t => near(t.x, wade.find(b => b.id === t.id).x, 0.01)) && tags.find(t => t.id === 'me').text === '我房主' && tags.filter(t => t.host).length === 1,
        { b4, full, maps: maps.map(m => [m.map, m.bears.map(b => [b.id, b.x, b.y])]), wade, tags });
      await setMode('路亚');
    }

    // ───── B3-23 以成员加入跟图、不能切图、离开留图 ─────
    {
      await load();
      await setMode('路亚'); await setMap(1);
      const c0 = (await P()).Groups['lure|map1']?.Count ?? 0;
      await focusNotepad(); await press(37);
      await waitFor(`window.moyuDev.profile().then(p => p.Groups['lure|map1']?.Count === ${c0 + 37})`, 10000);
      await join();
      const followed = await notice();
      const r = await room();
      const map0 = await prefsMap();
      await openPanel('地图');
      const mapPanel = await ev(`({ rows: [...document.querySelectorAll('.map-row')].map(b => b.disabled), note: document.querySelector('.map-note')?.innerText.trim() })`);
      await closePanels();
      await roomPanel();
      await clickSel('[data-demo-map="map3"]');
      const r3 = await room();
      const b3 = await bears();
      await clickSel('.room .leave', 200);
      const left = await notice();
      const map3 = await prefsMap();
      const bLeft = await bears();
      await setMap(1);
      const c1 = (await P()).Groups['lure|map1']?.Count ?? 0;
      check('B3-23 加入后到房主的地图二并提示跟随；地图页三行都不能点、写"只有房主可以切换地图。"；演示让房主切到地图三后全房在地图三；离开后提示"已离开房间，留在地图三。…"、仍在地图三、只剩自己；回地图一本轮还是 +37',
        followed === T_.followed(MAPS.map2) && r.map === 'map2' && map0 === 'map2' && r.members.find(m => m.host)?.name === '模拟好友1'
        && mapPanel.rows.length === 3 && mapPanel.rows.every(d => d) && mapPanel.note === T_.hostOnly
        && r3.map === 'map3' && b3.length === 3 && placed(b3) && left === T_.left(MAPS.map3) && map3 === 'map3' && bLeft.length === 1 && c1 === c0 + 37,
        { followed, map0, mapPanel, r3: r3?.map, left, map3, c0, c1 });
    }

    // ───── B3-24 房主切图全房跟 ─────
    {
      await load();
      await setMap(1);
      await create(2);
      const before = await bears();
      await openPanel('地图');
      const note = await ev(`document.querySelector('.map-note')?.innerText.trim()`);
      await clickSel('.map-row:nth-child(2)');
      await closePanels();
      const after = await bears();
      await openPanel('房间');
      const r = await room();
      check('B3-24 房主地图页有切图说明；切到地图二后全房在地图二、3 只熊重排且不相交，各自模式不变',
        note === T_.hostHelp && r.map === 'map2' && (await prefsMap()) === 'map2' && after.length === 3 && placed(after)
        && before.every(b => after.find(a => a.id === b.id)?.mode === b.mode), { note, before, after });
      await closePanels();
    }

    // ───── B3-25 好友断线：立即释放、本人能占、重新加入另排、没有"连接中" ─────
    {
      await load();
      await setMode('路亚'); await setMap(1);
      await create(2);
      const b0 = await bears();
      const spot = b0.find(b => b.id === 'sim1');
      await pick('sim1');
      await demo('drop', 100);
      const gone = await notice();
      const r = await room();
      const b1 = await bears();
      await closePanels();
      await clickScene(spot.x, spot.y);
      const me = (await bears()).find(b => b.id === 'me');
      await demo('rejoin', 100);
      const back = await notice();
      const r2 = await room();
      const b2 = await bears();
      check('B3-25 好友 1 断线：熊立即消失、提示"模拟好友1已断线，位置已释放。"、2/4；本人能换到它原来的位置；重新加入后排在别处、不挤走本人，没有"连接中"或倒计时',
        gone === T_.gone('模拟好友1') && r.count === T_.count(2) && !b1.some(b => b.id === 'sim1') && near(me.x, spot.x, 0.01) && near(me.y, spot.y, 0.01)
        && back === T_.rejoined('模拟好友1') && r2.count === T_.count(3) && b2.length === 3 && placed(b2)
        && near(b2.find(b => b.id === 'me').x, spot.x, 0.01) && !/连接中|\d+\s*秒/.test(r2.text), { gone, spot, me, back, b2 });
      await closePanels();
    }

    // ───── B3-26 房主离开→迁移中锁住→迁移成功→旧房主回来是成员 ─────
    {
      await load();
      await setMode('路亚'); await setMap(1);
      await join();
      const map = (await room()).map;
      await demo('host-leave', 100);
      const leaving = await notice();
      const rm = await room();
      await closePanels();
      const me0 = (await bears()).find(b => b.id === 'me');
      await clickScene(1300, 565);
      const lockPlace = await notice();
      const me1 = (await bears()).find(b => b.id === 'me');
      await openPanel('地图');
      await clickSel('.map-row:nth-child(3)', 100);
      const lockMap = await notice();
      await closePanels();
      await setMode('摸鱼');
      const lockMode = await notice();
      const modeAfter = await modeNow();
      await demo('migrate-ok', 100);
      const newHost = await notice();
      const r = await room();
      const me2 = (await bears()).find(b => b.id === 'me');
      await demo('rejoin', 100);
      const back = await notice();
      const r2 = await room();
      check('B3-26 房主离开：提示"房主已离开，正在切换房主…"；迁移中换位、切图、换模式都提示"正在切换房主，暂时不能切图或换位。"且不变；迁移成功提示"模拟好友2已成为房主。"（加入最早的接）、地图和本人落点不变；模拟好友1 回来标"成员"并提示重新加入',
        leaving === T_.migrating && rm.migrating === T_.migrating && !rm.members.some(m => m.host)
        && lockPlace === T_.locked && near(me1.x, me0.x, 0.01) && lockMap === T_.locked && lockMode === T_.locked && modeAfter === '路亚' && (await prefsMap()) === map
        && newHost === T_.newHost('模拟好友2') && r.members.find(m => m.host)?.id === 'sim2' && r.map === map && near(me2.x, me0.x, 0.01) && near(me2.y, me0.y, 0.01)
        && back === T_.rejoined('模拟好友1') && r2.members.find(m => m.id === 'sim1')?.tags.includes('成员') && !r2.members.find(m => m.id === 'sim1').host,
        { leaving, lockPlace, lockMap, lockMode, modeAfter, newHost, back, me0, me2 });
      await closePanels();
    }

    // ───── B3-27 迁移失败：回单机、资产不变、重新加入进好友 2 主持的房间 ─────
    {
      await load();
      await join();
      await demo('host-leave');
      const map = (await room()).map;
      const a0 = await assets();
      await demo('migrate-fail', 100);
      const failed = await notice();
      const r = await room();
      const a1 = await assets();
      const b = await bears();
      await clickSel('.room .rejoin', 0);
      await sleep(150);
      const during = await room();
      await waitFor(`!!window.__t.room()?.count`, 5000);
      const r2 = await room();
      check('B3-27 迁移失败：回单机、留在当前图，提示并常驻"房主迁移失败，已返回单机。…"、有"重新加入"；本人档和失败前一样；重新加入先显示"正在重新加入房间…"，然后进入模拟好友2 主持的房间',
        failed === T_.migrationFailed && r.status === T_.migrationFailed && r.buttons.includes('重新加入') && a1 === a0 && b.length === 1 && (await prefsMap()) === map
        && during.status === T_.rejoining && r2.members.find(m => m.host)?.name === '模拟好友2' && r2.members.some(m => m.self) && r2.map === map,
        { failed, r: r.status, during: during.status, r2: r2.members });
      await closePanels();
    }

    // ───── B3-28 本人断线、重新加入失败 ─────
    {
      await load();
      await create();
      await pick('me');
      await demo('drop', 100);
      const dropped = await notice();
      const r = await room();
      await clickSel('.room .rejoin', 0);
      await waitFor(`window.__t.room()?.status === ${JSON.stringify(T_.rejoinFailed)}`, 5000);
      const r2 = await room();
      check('B3-28 本人断线：提示并常驻"连接已中断，原位置已释放。…"、有"重新加入"；没有模拟好友可回时提示"重新加入失败，你仍可继续单机游玩。"、仍是单机',
        dropped === T_.selfDropped && r.status === T_.selfDropped && r.none === T_.none && r.buttons.includes('重新加入')
        && r2.status === T_.rejoinFailed && r2.none === T_.none && !r2.buttons.includes('重新加入') && (await bears()).length === 1, { dropped, r: r.status, r2: r2.status });
      await closePanels();
    }

    // ───── B3-29 各自外观、场景主题跟房主、本人装备不变 ─────
    {
      await load();
      const own = await ev(`document.querySelector('svg.scene').dataset.scene`);
      await join();
      const r = await room();
      const scene = await ev(`document.querySelector('svg.scene').dataset.scene`);
      const b = await bears();
      const eq = (await P()).Equipped;
      await shot('b3-29-host-scene');
      await clickSel('.room .leave');
      const back = await ev(`document.querySelector('svg.scene').dataset.scene`);
      check('B3-29 3 只熊的人物/竿/手套组合各不相同、本人还是基础外观；场景主题是房主的 WEB_SCENE_02、本人档的场景装备不变；离开后场景回本人的；房间页写各自装备和跟随房主说明',
        own === 'BASE_SCENE' && scene === 'WEB_SCENE_02' && back === 'BASE_SCENE' && new Set(b.map(x => x.skins)).size === 3
        && b.find(x => x.id === 'me').skins === 'BASE_CHAR BASE_ROD BASE_GLOVE' && (eq.Scene ?? 'BASE_SCENE') === 'BASE_SCENE'
        && r.text.includes(T_.ownOutfit) && r.text.includes(T_.followHost), { own, scene, back, skins: b.map(x => x.skins), eq });
      await closePanels();
    }

    // ───── B3-30 背景鱼缸跟房主：3 条鱼→空缸只画框→未设不画→离开画回自己的 ─────
    {
      await load();
      await ev('window.moyuDev.injectFish(2)');
      await waitFor(`window.__t.save() === '已保存'`, 10000);
      for (let i = 0; i < 2; i++) {
        await openPanel('鱼篓');
        await clickSel('.basket .fish-cell .pick');
        await clickSel('.basket .collect');
        await waitFor(`window.__t.save() === '已保存'`, 10000);
      }
      await openPanel('收藏');
      await clickSel('.collection .background');
      await waitFor(`window.__t.save() === '已保存'`, 10000);
      await closePanels();
      const own = await T('tank()');
      await join();
      const host3 = await T('tank()');
      await shot('b3-30-host-tank');
      await demo('add');
      await demo('host-leave');
      const migrating = await T('tank()');
      await demo('migrate-ok');
      const empty = await T('tank()');
      await pick('sim2');
      await demo('drop');
      await demo('migrate-fail');
      const solo = await T('tank()');
      await clickSel('.room .rejoin', 0);
      await waitFor(`!!window.__t.room()?.count`, 5000);
      const r = await room();
      const notSet = await T('tank()');
      await clickSel('.room .leave');
      const back = await T('tank()');
      check('B3-30 先画房主的 3 条鱼（缸框向内 10、不接指针）；迁移中画自己的；空缸房主只画框；回单机画自己的；未设缸的房主不画缸；离开后画回自己的 2 条鱼',
        own?.owner === 'me' && own.fish === 2 && host3?.owner === 'sim1' && host3.fish === 3 && host3.frameX === 10 && host3.pe === 'none' && host3.fe === 'none'
        && migrating?.owner === 'me' && migrating.fish === 2 && empty?.owner === 'sim2' && empty.fish === 0
        && solo?.owner === 'me' && solo.fish === 2 && r.members.find(m => m.host)?.id === 'sim3' && notSet === null && back?.owner === 'me' && back.fish === 2,
        { own, host3, migrating, empty, solo, host: r.members.find(m => m.host)?.id, notSet, back });
      await closePanels();
    }

    // ───── B3-31 好友收获卡片和提示音 ─────
    {
      await load();
      await create(2);
      await unmute();
      const c0 = await ev('window.moyuPlay.chimes');
      await pick('sim1'); await demo('catch', 50);
      await pick('sim2'); await demo('catch', 100);
      const cards = await T('cards()');
      const b = await bears();
      const panels = await ev(`[...document.querySelectorAll('#pet .panel, #pet .popup')].map(e => e.className)`);
      const c1 = await ev('window.moyuPlay.chimes');
      await shot('b3-31-cards');
      await sleep(4400);
      const gone = await T('cards()');
      await clickBtn('静音');
      await pick('sim1'); await demo('catch', 100);
      const muted = await T('cards()');
      const c2 = await ev('window.moyuPlay.chimes');
      await clickBtn('取消静音');
      await sleep(4400);
      await clickBtn('收起');
      await ev(`window.moyuDev.room('catch', 'sim2')`);
      await sleep(200);
      const c3 = await ev('window.moyuPlay.chimes');
      await clickSel('#avatar');
      await sleep(300);
      const restored = await T('cards()');
      const ok1 = cards.length === 2 && cards.every(c => {
        const n = c.id === 'sim1' ? '模拟好友1' : '模拟好友2';
        return c.head === T_.catchTitle(n) && c.line === `${FISH[c.species]} · ${cm(c.len)}` && c.tag === '模拟收获' && c.pe === 'none' && Math.abs(c.mid - b.find(x => x.id === c.id).x) < 200;
      });
      check('B3-31 好友 1、2 先后收获：两张卡片各在自己熊头上，写"模拟好友n的新鱼获""{鱼名} · {体长} cm""模拟收获"、不接指针；房间页还开着、没开别的面板；未静音出提示音；约 4 秒后消失；静音后卡片照出、不响；收起时收获不响，恢复后也不补卡片',
        ok1 && panels.length === 1 && panels[0].includes('room') && c1 > c0 && c1 - c0 <= 2 && gone.length === 0
        && muted.length === 1 && muted[0].id === 'sim1' && c2 === c1 && c3 === c2 && restored.length === 0,
        { cards, bears: b.map(x => [x.id, x.x]), panels, chimes: [c0, c1, c2, c3], gone: gone.length, muted: muted.length, restored: restored.length });
    }

    // ───── B3-32 好友收获不进本人资产、重复和旧代次消息不重播 ─────
    {
      await load();
      await create(2);
      await unmute();
      const a0 = await assets();
      await pick('sim1');
      for (let i = 0; i < 3; i++) await demo('catch', 150);
      const card = (await T('cards()')).find(c => c.id === 'sim1');
      const c0 = await ev('window.moyuPlay.chimes');
      const accepted = await ev('window.moyuDev.roomReplay()');
      await sleep(200);
      const card2 = (await T('cards()')).find(c => c.id === 'sim1');
      const c1 = await ev('window.moyuPlay.chimes');
      await sleep(1200);
      const a1 = await assets();
      check('B3-32 好友收获 3 次：本人鱼、金币、总累计、记录、新鱼数、装备全不变；重发上一条和旧代次的消息都不被接受、卡片不加、不响',
        a1 === a0 && card?.count === 3 && accepted === 0 && card2?.count === 3 && c1 === c0, { card: card?.count, accepted, card2: card2?.count, chimes: [c0, c1] });
    }

    // ───── B3-33 只读看好友鱼缸 ─────
    {
      await load();
      const known = Object.keys((await P()).Records);
      await openPanel('记录');
      const rows0 = await ev(`[...document.querySelectorAll('.record-row')].map(r => r.innerText.trim())`);
      await join();
      await clickSel('.member-row[data-member="sim1"] .view');
      const v = await ev(`(() => { const p = document.querySelector('.tank-view'); return p && { state: p.dataset.viewState, text: p.innerText, title: p.querySelector('.view-head b').innerText.trim(), tag: p.querySelector('.view-head .tag').innerText.trim(),
        cap: p.querySelector('[data-stat=view-cap]')?.innerText.trim(), fish: [...p.querySelectorAll('.view-fish')].map(f => ({ sp: f.dataset.species, len: +f.dataset.len, text: f.innerText.trim() })),
        buttons: [...p.querySelectorAll('button')].map(b => b.innerText.trim()) }; })()`);
      await shot('b3-33-view');
      await clickSel('.tank-view .back');
      await openPanel('记录');
      const rows = await ev(`[...document.querySelectorAll('.record-row')].map(r => r.innerText.trim())`);
      check('B3-33 好友 1 的鱼缸：标题"模拟好友1的背景鱼缸"、标"只读"、写展示范围和只读说明；3 条"{鱼名} · {体长} cm"和"3/20"；只有返回，没有取回、出售、设为背景；里面有本人没抓过的鱼，看完本人记录不变（没抓过的仍是"？"）',
        v?.state === 'Fish' && v.title === T_.viewTitle('模拟好友1') && v.tag === '只读' && v.text.includes(T_.shareNote) && v.text.includes(T_.readOnly)
        && v.cap === '3/20' && v.fish.length === 3 && v.fish.every(f => f.text === `${FISH[f.sp]} · ${cm(f.len)}`)
        && JSON.stringify(v.buttons) === JSON.stringify(['房间']) && v.fish.some(f => !known.includes(f.sp))
        && JSON.stringify(rows) === JSON.stringify(rows0) && Object.keys((await P()).Records).length === known.length, { v, known, rows0, rows });
      await closePanels();
    }

    // ───── B3-34 查看的各种状态；房间操作都不加数 ─────
    {
      await load();
      const t0 = await total();
      await join();
      await demo('add');
      const view = async id => {
        await clickSel(`.member-row[data-member="${id}"] .view`);
        return ev(`(() => { const p = document.querySelector('.tank-view'); return p && { state: p.dataset.viewState, text: p.querySelector('.view-state')?.innerText.trim() ?? null }; })()`);
      };
      const readNow = () => ev(`(() => { const p = document.querySelector('.tank-view'); return p && { state: p.dataset.viewState, text: p.querySelector('.view-state')?.innerText.trim() ?? null }; })()`);
      const notSet = await view('sim3');
      await clickSel('.tank-view .back');
      const empty = await view('sim2');
      await ev(`window.moyuDev.room('drop', 'sim2')`);
      await sleep(200);
      const gone = await readNow();
      await clickSel('.tank-view .back');
      await view('sim1');
      await ev(`window.moyuDev.room('end')`);
      await sleep(200);
      const expired = await readNow();
      await clickSel('.tank-view .back');
      const after = await room();
      const t1 = await total();
      check('B3-34 未设写"对方还未设置背景鱼缸。"、空缸写"这个鱼缸暂时没有鱼。"；查看中对方断线写"对方已离开房间，暂时无法查看。"；查看中结束模拟写"这份展示已失效…"；返回后是没有房间；全程总累计不变',
        notSet?.state === 'NotSet' && notSet.text === T_.notSet && empty?.state === 'Empty' && empty.text === T_.emptyTank
        && gone?.state === 'Gone' && gone.text === T_.tankGone && expired?.state === 'Expired' && expired.text === T_.expired && after?.none === T_.none && t1 === t0,
        { notSet, empty, gone, expired, t0, t1 });
      await closePanels();
    }

    // ───── B3-36 好友有待机动作、不挡选位 ─────
    {
      await load();
      await setMode('路亚'); await setMap(1);
      await create(1);
      await closePanels();
      const b = await bears();
      const friend = b.find(x => x.id === 'sim1'), me = b.find(x => x.id === 'me');
      const anim = await ev(`getComputedStyle(document.querySelector('svg.scene g.friend')).animationName`);
      const p = await T(`scene(${friend.x}, ${friend.y - 4})`);
      const hit = await ev(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return { friend: !!e?.closest('g.friend'), hit: e?.closest('[data-hit]')?.dataset.hit ?? null }; })()`);
      await clickAt(p, 150);
      const bubble = await ev(`document.querySelector('svg.scene .noroom')?.textContent.trim() ?? null`);
      const me2 = (await bears()).find(x => x.id === 'me');
      check('B3-36 好友的熊有循环待机动作；点在它脚下等于点到下面的岸：冒"这里放不下"、本人原位不动',
        anim === 'bob' && !hit.friend && hit.hit === 'shore' && bubble === T_.noRoom && near(me2.x, me.x, 0.01) && near(me2.y, me.y, 0.01), { anim, hit, bubble, me, me2 });
    }

    // ───── B3-37 跟随房主的标记 ─────
    {
      await load();
      await join();
      await openPanel('皮肤');
      await clickSel('.skin [data-tab=Scene]');
      const skin = await ev(`(() => { const t = document.querySelector('.follow-note .follow-host'); return t && { text: t.innerText.trim(), title: t.title }; })()`);
      await openPanel('收藏');
      const tank = await ev(`(() => { const t = document.querySelector('.bg-help .follow-host'); return t && { text: t.innerText.trim(), title: t.title }; })()`);
      await openPanel('房间');
      await clickSel('.room .leave');
      await openPanel('收藏');
      const solo = await ev(`!!document.querySelector('.follow-host')`);
      check('B3-37 加入后皮肤页场景分类、收藏页都标"跟随房主"，说明是跟随房主那句；离房后不再标',
        skin?.text === '跟随房主' && skin.title === T_.followHost && tank?.text === '跟随房主' && tank.title === T_.followHost && !solo, { skin, tank, solo });
      await closePanels();
    }
  },
});
