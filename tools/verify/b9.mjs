#!/usr/bin/env node
// B9 联机协议浏览器验收：执行 doc/测试用例/B9 联机协议.md 里方式为 B 的用例，每个 check 名以用例号开头。
//
// 用法：
//   node tools/verify/b9.mjs [网址|--release] [输出目录]
//   --release：先照 CI 的方式发布本地 Release 包，挂在 http://127.0.0.1:5199/zhuomianmoyu/ 上测（推送前的主关卡）
//   网址默认线上；开发中可测 http://localhost:5188/ 。输出默认系统临时目录下 moyu-b9
//
// 脚本在本机起回环服务（relay.mjs，按 Steam 房间的规矩做的假房间服务），开 5 个互相隔离的浏览器上下文当 A—E 五个人
// （各自一份存档），网址带 ?net=<回环地址>&name=<名字>。"在 Steam 里点接受邀请"、"拔网线"、"重发一条旧消息"由脚本让回环服务做。
// 每页装一个记录器，把出现过的状态行和提示都记下来，看得到"正在创建房间…"这类一闪而过的状态。
import { runBatch, sleep } from './cdp.mjs';
import { startRelay } from './relay.mjs';
import { T_, ROOM_HELPERS as HELPERS } from './room-helpers.mjs';

const MAPS = { map1: '地图一', map2: '地图二', map3: '地图三' };
const HOUR = 1800000, STEP = 290000;

const relay = await startRelay();

await runBatch({
  batch: 'b9',
  helpers: HELPERS,
  async run({ main, base, check, openTab, consoleErrors, setBuild }) {
    const people = {};
    const url = (name, net = relay.url) => { const u = new URL(base.href); u.searchParams.set('net', net); u.searchParams.set('name', name); return u.href; };

    /** 一个人：一个隔离的标签页 + 常用操作。 */
    function person(name, t) {
      const id = `u-${name}`;
      const T = expr => t.ev(`window.__t.${expr}`);
      const p = {
        name, id, t, T,
        ev: t.ev, waitFor: t.waitFor,
        room: () => T('room()'),
        bears: () => T(`bears(${JSON.stringify(id)})`),
        seen: () => t.ev('window.__seen'),
        clearSeen: () => t.ev('window.__seen = []; true'),
        profile: () => t.ev('window.moyuDev.profile()'),
        async load() {
          await t.size(1600, 900);
          await t.send('Page.navigate', { url: url(name) });
          if (!(await t.waitFor(`!!window.__t && !!window.moyuDev && !!window.moyuNet && !!document.querySelector('#pet') && window.__t.save() === '已保存'`, 40000))) throw new Error(`${name} 没加载出来`);
          await sleep(300);
        },
        async clickSel(sel, wait = 300) {
          const pt = await t.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); return window.__t.center(e); })()`);
          if (!pt) throw new Error(`${name} 找不到：${sel}`);
          await t.clickAt(pt, wait);
        },
        async clickBtn(text, wait = 300) {
          const pt = await T(`center(window.__t.btn(${JSON.stringify(text)}))`);
          if (!pt) throw new Error(`${name} 找不到按钮：${text}`);
          await t.clickAt(pt, wait);
        },
        async closePanels() {
          for (let i = 0; i < 3; i++) {
            const x = await T(`center(document.querySelector('#pet .panel-head .x, #pet .popup-head .x'))`);
            if (!x) return;
            await t.clickAt(x);
          }
        },
        async openPanel(panel) {
          await p.closePanels();
          if (['地图', '皮肤', '设置'].includes(panel)) { await p.clickBtn('更多'); await p.clickBtn(panel); } else await p.clickBtn(panel);
        },
        async roomPanel() { if (!(await p.room())) await p.openPanel('房间'); },
        /** 鱼篓里塞 n 条鱼、全部收进鱼缸、设为背景（B2 的界面流程）。 */
        async stockTank(n) {
          await t.ev(`window.moyuDev.injectFish(${n})`);
          await p.openPanel('鱼篓');
          for (let i = 0; i < n; i++) {
            const ids = await t.ev(`[...document.querySelectorAll('.basket .fish-cell')].map(c => c.dataset.fish)`);
            await p.clickSel(`.basket .fish-cell[data-fish="${ids[0]}"] .pick`, 150);
            await p.clickSel('.basket .collect', 150);
            await t.waitFor(`window.__t.save() === '已保存'`, 10000);
          }
          await p.openPanel('收藏');
          await p.clickSel('.collection .background');
          await t.waitFor(`document.querySelector('.collection .background').dataset.on === 'true'`, 5000);
          await p.closePanels();
        },
        async setMode(label) {
          const cur = await t.ev(`document.querySelector('#pet .mode span').innerText`);
          if (cur === label) return;
          await p.closePanels();
          await p.clickBtn(cur);
          await p.clickBtn(label);
        },
      };
      return p;
    }

    async function open(name) {
      const t = await openTab(null, { isolated: true });
      const p = people[name] = person(name, t);
      await p.load();
      return p;
    }
    const lobby = () => relay.lobbyOf('A');
    /** 等 4 页（或给定几页）的某件事都成立。 */
    const all = (ps, expr, ms = 8000) => Promise.all(ps.map(p => p.waitFor(expr, ms)));
    const countIs = (n) => `window.__t.room()?.count === '${n}'`;
    /** 各页的房间人数（房间面板没开就先开）。 */
    const counts = ps => Promise.all(ps.map(async p => { await p.roomPanel(); return (await p.room())?.count ?? null; }));
    async function acceptInto(p, lob = lobby()) {
      relay.accept(p.name, lob);
    }

    // ═════════════ B9-20 不带回环地址：网页不变 ═════════════
    {
      const plain = async href => {
        await main.send('Page.navigate', { url: href });
        await main.waitFor(`!!window.__t && !!document.querySelector('#pet') && window.__t.save() === '已保存'`, 40000);
        await sleep(300);
        setBuild(await main.ev(`document.querySelector('meta[name=app-build]')?.content`));
        const m = person('main', main);
        await m.openPanel('房间');
        return main.ev(`({ room: window.__t.room(), net: window.moyuNet.config() !== null })`);
      };
      const a = await plain(base.href);
      const bad = new URL(base.href); bad.searchParams.set('net', 'http://example.com:5197'); bad.searchParams.set('name', 'X');
      const b = await plain(bad.href);
      const ok = r => r.room.buttons.includes('创建模拟房间') && r.room.buttons.includes('加入模拟房间') && !r.room.buttons.includes(T_.create) && !r.room.text.includes(T_.friendsTitle) && !r.net;
      check('B9-20 不带回环地址、或地址不是本机时：房间页和 B3 一样只有"创建模拟房间/加入模拟房间"，没有联机入口和好友列表，也没连任何服务',
        ok(a) && ok(b) && relay.users.size === 0, { plain: a.room.buttons, external: b.room.buttons, users: relay.users.size });
    }

    // ═════════════ 准备：A、C 各有一个 3 条鱼的背景缸（B9-29、30 用） ═════════════
    const A = await open('A');
    await A.stockTank(3);

    // ═════════════ B9-21 建房；B9-22 只有自己连着时好友列表是空态 ═════════════
    await A.openPanel('房间');
    await A.clearSeen();
    const inputsA0 = (await A.profile()).LifetimeInputs;
    await A.clickSel('[data-net=create]');
    await A.waitFor(`window.__t.room()?.count === '1'`, 8000);
    await sleep(400);
    {
      const r = await A.room();
      const seen = await A.seen();
      const mapA = await A.ev(`document.querySelector('svg.scene').dataset.map`);
      check('B9-21 点"创建房间"：先"正在创建房间…"，进房后房主是本人、1/4、地图是本人当前地图、状态"等待好友加入…"',
        seen.includes(T_.creating) && r.kind === 'Real' && r.count === '1' && r.members.length === 1 && r.members[0].self && r.members[0].host && r.map === mapA && r.net === T_.waiting,
        { seen: seen.slice(0, 6), r: { kind: r.kind, count: r.count, map: r.map, mapA, net: r.net, members: r.members } });
      check('B9-22 只有本人连着时：标题"在线Steam好友"、显示"暂时没有在线的Steam好友。"',
        r.title === T_.friendsTitle && r.empty === T_.noFriends && r.friends.length === 0, { title: r.title, empty: r.empty });
    }

    // ═════════════ B9-22 好友列表的状态 ═════════════
    relay.addIdle('F');
    const B = await open('B');
    const C = await open('C');
    await C.stockTank(3);
    await A.waitFor(`window.__t.room().friends.length === 3`, 8000);
    const fr = await A.room();
    const st = Object.fromEntries(fr.friends.map(f => [f.name, f]));
    const listOk = st.B?.text === T_.playing && st.C?.text === T_.playing && st.F?.text === T_.online && fr.friends.every(f => f.btn === T_.invite && !f.off);

    // ═════════════ B9-23 邀请和加入分开 ═════════════
    const inputsB0 = (await B.profile()).LifetimeInputs;
    await A.clearSeen();
    await A.clickSel('.friend-row[data-friend="B"] .invite');
    await A.waitFor(`window.__seen.includes(${JSON.stringify(T_.inviteSent)})`, 5000);
    await sleep(600);
    const afterInvite = await A.room();
    await B.openPanel('房间');
    await B.clearSeen();
    await acceptInto(B);
    await all([A, B], countIs(2));
    await sleep(500);
    {
      const bSeen = await B.seen();
      const br = await B.room();
      const ar = await A.room();
      const bState = ar.friends.find(f => f.name === 'B');
      check('B9-22 好友列表：B、C 正在玩桌面摸鱼、F 在线（没开游戏）；每行一个"邀请"；B 进房后 B 那行变"已在房间里"、邀请不可点',
        listOk && bState?.text === T_.inRoom && bState.off, { before: fr.friends, after: bState });
      check('B9-23 点"邀请"只显示"已发出邀请，等待好友加入。"、人数仍 1/4；B 接受后先"正在加入房间…"再"已加入房间。"，跟到房间地图，两边 2/4',
        afterInvite.count === '1' && afterInvite.net === T_.inviteSent && bSeen.indexOf(T_.joining) >= 0 && bSeen.indexOf(T_.joined) > bSeen.indexOf(T_.joining) && br.map === ar.map && br.count === '2' && ar.count === '2' && br.members.find(m => m.self)?.host === false,
        { afterInvite: { count: afterInvite.count, net: afterInvite.net }, bSeen: bSeen.slice(0, 8), map: [ar.map, br.map] });
    }
    await A.clickSel('.friend-row[data-friend="C"] .invite');
    await acceptInto(C);
    await all([A, B, C], countIs(3));

    // ═════════════ B9-26 失效、版本不一致 ═════════════
    const E = await open('E');
    await E.openPanel('房间');
    await E.clearSeen();
    relay.accept('E', 'L999');
    await E.waitFor(`window.__seen.includes(${JSON.stringify(T_.inviteGone)})`, 5000);
    const lob = lobby();
    const ver = relay.lobbies.get(lob).data.ver;
    relay.setVer(lob, 'old-build');
    relay.accept('E', lob);
    await E.waitFor(`window.__seen.includes(${JSON.stringify(T_.version)})`, 5000);
    relay.setVer(lob, ver);
    await sleep(500);
    {
      const er = await E.room();
      const ar = await A.room();
      check('B9-26 接受一个已没有的房间："邀请已失效，或房间已结束。"；版本对不上："游戏版本不一致，暂时无法加入。"；两次都留在单机，房里仍 3 人',
        (await E.seen()).includes(T_.inviteGone) && (await E.seen()).includes(T_.version) && er.count === null && er.none === T_.create && ar.count === '3' && relay.lobbies.get(lob).members.length === 3,
        { seen: await E.seen(), e: { count: er.count, none: er.none }, a: ar.count });
    }

    // D 进来，满 4 人
    const D = await open('D');
    await A.clickSel('.friend-row[data-friend="D"] .invite');
    await acceptInto(D);
    await all([A, B, C, D], countIs(4));

    // ═════════════ B9-25 第 5 人 ═════════════
    await E.clearSeen();
    relay.accept('E', lob);
    await E.waitFor(`window.__seen.includes(${JSON.stringify(T_.full)})`, 5000);
    await sleep(400);
    {
      const er = await E.room();
      const counts4 = await counts([A, B, C, D]);
      check('B9-25 第 5 人接受邀请：看到"房间已满（4/4）。"、留在单机；房里 4 人不变',
        (await E.seen()).includes(T_.full) && er.count === null && counts4.every(c => c === '4'), { counts: counts4, e: er.count });
    }

    // ═════════════ B9-24 房间操作不算输入 ═════════════
    {
      const a1 = (await A.profile()).LifetimeInputs, b1 = (await B.profile()).LifetimeInputs;
      check('B9-24 建房、邀请、进房（含失败的进房）：A、B 的输入次数都不变', a1 === inputsA0 && b1 === inputsB0, { A: [inputsA0, a1], B: [inputsB0, b1] });
    }

    const four = [A, B, C, D];
    const layouts = async () => Promise.all(four.map(p => p.bears().then(bs => JSON.stringify(bs.map(b => [b.id, Math.round(b.x), Math.round(b.y), b.mode])))));
    const sameLayout = async () => new Set(await layouts()).size === 1;

    // ═════════════ B9-27 两人同时点同一处 ═════════════
    for (const p of four) await p.closePanels();
    await sleep(800);
    {
      const bs = await A.bears();
      // 岸边找一个离所有人都超过 200 的点
      let x = null;
      for (let cx = 200; cx <= 1400; cx += 20) if (bs.every(b => b.mode === 'Wade' || Math.abs(b.x - cx) >= 200)) { x = cx; break; }
      if (x === null) throw new Error('岸边没空位：' + JSON.stringify(bs));
      const before = Object.fromEntries(bs.map(b => [b.id, b.x]));
      await B.clearSeen(); await C.clearSeen();
      const pb = await B.T(`scene(${x}, 565)`), pc = await C.T(`scene(${x}, 565)`);
      await Promise.all([B.t.clickAt(pb, 0), C.t.clickAt(pc, 0)]);
      await sleep(1500);
      const after = await A.bears();
      const at = id => after.find(b => b.id === id).x;
      const winners = ['u-B', 'u-C'].filter(id => Math.abs(at(id) - x) < 1);
      const loser = winners.length === 1 ? (winners[0] === 'u-B' ? C : B) : null;
      const loserSeen = loser ? await loser.seen() : [];
      check('B9-27 B、C 同时单击同一点：只有一人站过去，另一人看到"这里放不下"、留在原位；4 页的 4 人落点一致',
        winners.length === 1 && loserSeen.includes(T_.noRoom) && Math.abs(at(loser.id) - before[loser.id]) < 1 && await sameLayout(),
        { x, winners, loser: loser?.id, loserSeen: loserSeen.slice(-3), layouts: await layouts() });
    }

    // ═════════════ B9-28 切图全房一致 ═════════════
    await B.openPanel('地图');
    const bMap = await B.ev(`({ off: [...document.querySelectorAll('.map-row')].every(b => b.disabled), note: document.querySelector('.map-note')?.innerText.trim() })`);
    await B.closePanels();
    for (const p of [B, C, D]) await p.clearSeen();
    await A.openPanel('地图');
    await A.clickSel('.map-row:nth-child(2)');
    await A.closePanels();
    await all(four, `window.__seen.length >= 0`, 100);
    await sleep(1200);
    {
      const maps = await Promise.all(four.map(p => p.ev(`document.querySelector('svg.scene').dataset.map`)));
      const followed = await Promise.all([B, C, D].map(p => p.seen().then(s => s.includes(T_.followed(MAPS.map2)))));
      check('B9-28 成员 B 的地图按钮都不可点、说明"只有房主可以切换地图。"；A 切到地图二后 4 页都在地图二，B/C/D 有"已跟随房间前往地图二…"，4 人落点一致',
        bMap.off && bMap.note === T_.hostOnly && maps.every(m => m === 'map2') && followed.every(Boolean) && await sameLayout(), { bMap, maps, followed });
    }

    // ═════════════ B9-29 共同画面跟房主 ═════════════
    {
      const tanks = await Promise.all(four.map(p => p.T('tank()')));
      await B.openPanel('收藏');
      const tag = await B.ev(`!!document.querySelector('.bg-help .follow-host')`);
      await B.closePanels();
      check('B9-29 B、C、D 的底层鱼缸都是房主 A 的（3 条），不是自己的（C 自己也有缸）；收藏页标"跟随房主"',
        tanks.every(t => t?.owner === 'u-A' && t.fish === 3) && tag, { tanks, tag });
    }

    // ═════════════ B9-30 只读看鱼缸及时更新（离开后的部分在 B9-32 之后） ═════════════
    await B.openPanel('房间');
    await B.clickSel('.member-row[data-member="u-C"] .view');
    await B.waitFor(`window.__t.room().view === 'Fish'`, 5000);
    const view3 = (await B.room()).viewFish;
    await C.openPanel('收藏');
    await C.ev(`document.querySelector('.tank .tank-fish').dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
    await sleep(200);
    await C.clickSel('.tank-side .retrieve');
    await C.waitFor(`window.__t.save() === '已保存'`, 5000);
    await C.closePanels();
    const t0 = Date.now();
    const updated = await B.waitFor(`window.__t.room().viewFish === 2`, 6000);
    const lag = Date.now() - t0;

    // ═════════════ B9-32 普通成员拔网线 ═════════════
    for (const p of [A, D]) await p.clearSeen();
    relay.drop('C');
    await all([A, B, D], countIs(3), 5000).catch(() => { });
    await A.waitFor(`window.__seen.includes(${JSON.stringify(T_.gone('C'))})`, 5000);
    await sleep(500);
    const viewGone = await B.room();
    check('B9-30 B 看 C 的缸：先 3 条；C 取回一条后 B 那里 2 条（2 秒内）；C 断线后 B 看到"对方已离开房间，暂时无法查看。"',
      view3 === 3 && updated && lag < 2500 && viewGone.view === 'Gone' && viewGone.text.includes(T_.tankGone), { view3, updated, lag, after: viewGone.view });
    await B.clickSel('.tank-view .back');
    await B.closePanels();
    {
      const cr = await C.room() ?? (await C.openPanel('房间'), await C.room());
      const counts3 = await counts([A, D]);
      const goneSeen = await Promise.all([A, D].map(p => p.seen().then(s => s.includes(T_.gone('C')))));
      const freed = (await A.bears()).every(b => b.id !== 'u-C');
      await C.clickBtn('重新加入');
      await all([A, B, C, D], countIs(4), 8000).catch(() => { });
      const back = await counts(four);
      check('B9-32 拔 C 的网线：A、D 立即看到"C已断线，位置已释放。"、3/4，C 的角色不见了；C 回单机、显示"连接已中断…"和"重新加入"；C 点重新加入后 4 页都 4/4',
        goneSeen.every(Boolean) && counts3.every(c => c === '3') && freed && cr.status === T_.selfDropped && cr.buttons.includes('重新加入') && back.every(c => c === '4'),
        { goneSeen, counts3, freed, c: { status: cr.status, buttons: cr.buttons }, back });
    }
    for (const p of four) await p.closePanels();

    // ═════════════ B9-31 好友收获只展示、不重复 ═════════════
    {
      const before = await Promise.all([A, C, D].map(p => p.profile().then(x => ({ fish: x.Fish.length, coins: x.Coins, inputs: x.LifetimeInputs }))));
      await B.setMode('手竿');
      await sleep(600);
      const fishBefore = (await B.profile()).Fish.length;
      for (let i = 0; i < 20 && (await B.profile()).Fish.length === fishBefore; i++) {
        await B.ev(`window.moyuDev.skew(${STEP})`);
        await B.ev('window.moyuDev.poleTick()');
        await sleep(150);
      }
      const gotCards = await all([A, C, D], `window.__t.cards().some(c => c.id === 'u-B')`, 5000);
      const heads = await Promise.all([A, C, D].map(p => p.T('cards()')));
      const after = await Promise.all([A, C, D].map(p => p.profile().then(x => ({ fish: x.Fish.length, coins: x.Coins, inputs: x.LifetimeInputs }))));
      // 等卡片消失（4 秒），再让回环服务把 B 发给 A 的最后一条（就是这条收获）重发一次
      await A.waitFor(`window.__t.cards().length === 0`, 6000);
      const replayed = relay.replay('B', 'A');
      await sleep(1500);
      const again = await A.T('cards()');
      check('B9-31 B 出一条鱼：A、C、D 各出一张"B的新鱼获"卡片，三人的鱼、金币、输入次数都不变；把这条消息重发给 A，不再出卡片',
        gotCards.every(Boolean) && heads.every(h => h.some(c => c.head === T_.catchTitle('B'))) && JSON.stringify(before) === JSON.stringify(after) && replayed?.startsWith('C|') && again.length === 0,
        { heads, before, after, replayed, again });
    }

    // ═════════════ B9-33 房主拔网线 ═════════════
    for (const p of [B, C, D]) await p.clearSeen();
    relay.drop('A');
    await all([B, C, D], `window.__seen.some(s => s.endsWith('已成为房主。'))`, 8000).catch(() => { });
    await sleep(600);
    {
      const seen = await Promise.all([B, C, D].map(p => p.seen()));
      const hosts = await Promise.all([B, C, D].map(async p => { await p.roomPanel(); const r = await p.room(); return { host: r.members.find(m => m.host)?.id, map: r.map, count: r.count }; }));
      const tanks = await Promise.all([B, C, D].map(p => p.T('tank()')));
      const newHost = hosts[0].host;
      const name = newHost?.slice(2);
      check('B9-33 拔房主 A 的网线：B、C、D 先"房主已离开，正在切换房主…"再"X已成为房主。"；三页房主是同一人、仍在地图二、3/4；底层鱼缸不再是 A 的',
        seen.every(s => s.includes(T_.migrating) && s.indexOf(T_.newHost(name)) > s.indexOf(T_.migrating)) && hosts.every(h => h.host === newHost && h.map === 'map2' && h.count === '3') && newHost !== 'u-A' && tanks.every(t => t?.owner !== 'u-A'),
        { seen: seen.map(s => s.filter(x => x.includes('房主'))), hosts, tanks });
      for (const p of [B, C, D]) await p.clearSeen();
      await A.roomPanel();
      await A.clickBtn('重新加入');
      await all(four, countIs(4), 8000).catch(() => { });
      await sleep(400);
      const ar = await A.room();
      const rejoinSeen = await Promise.all([B, C, D].map(p => p.seen().then(s => s.includes(T_.rejoined('A')))));
      check('B9-33 A 重新加入后是成员（房主仍是新房主）；B、C、D 看到"A已重新加入房间。"',
        ar.count === '4' && ar.members.find(m => m.self)?.host === false && ar.members.find(m => m.host)?.id === newHost && rejoinSeen.every(Boolean), { a: ar.members, rejoinSeen });
    }

    // ═════════════ B9-34 离开房间 ═════════════
    {
      await D.roomPanel();
      await D.clearSeen();
      await D.clickBtn('离开房间');
      await all([A, B, C], countIs(3), 5000).catch(() => { });
      const dSeen = await D.seen();
      const dMap = await D.ev(`document.querySelector('svg.scene').dataset.map`);
      const left3 = await counts([A, B, C]);
      check('B9-34 D 点"离开房间"：D 看到"已离开房间，留在地图二。…"、留在地图二；其他人 3/4',
        dSeen.includes(T_.left(MAPS.map2)) && dMap === 'map2' && left3.every(c => c === '3'), { dSeen: dSeen.slice(0, 4), dMap, counts: left3 });
    }

    // ═════════════ B9-35 没有报错 ═════════════
    check('B9-35 全程各页面控制台没有报错', consoleErrors.length === 0, consoleErrors.slice(0, 5));
    relay.close();
  },
});
