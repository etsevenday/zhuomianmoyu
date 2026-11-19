#!/usr/bin/env node
// B10 Steam 联机验收（PC 外壳）：执行 doc/测试用例/B10 Steam 联机.md 里方式为 B 的用例，每个 check 名以用例号开头。
//   node tools/verify/b10.mjs [--release] [输出目录]
// 以测试模式开 4 个 PC 外壳（各自数据目录、各自调试端口）当 A—D，Steam 小程序走回环模式（MOYU_NET_RELAY），连本机回环服务
// （relay.mjs，B9 那个）："在 Steam 里点接受邀请""拔网线"由脚本让回环服务做；"Steam 被关掉"是直接结束小程序进程。
// B10-20 用 B5 的输入发送器往记事本里真按 3 次键（PC 版工作输入只认后台输入采集），那几秒不要动键盘。
// 另开一个正常模式的外壳看 Steam 模式（B10-30），结果按本机 Steam 实际在不在跑来判。
// PC 包本来就是 Release 发布，--release 只为和其他批次的命令一致。MOYU_PC_APP=<包里的 桌面摸鱼.exe>：改测打好的包（B6 用）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, PACKED, ONE } from './b4.mjs';
import { startRelay } from './relay.mjs';
import { T_, ROOM_HELPERS } from './room-helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PC = path.join(REPO, 'pc');
const ELECTRON = path.join(PC, 'node_modules', 'electron', 'dist', 'electron.exe');
const APP = PACKED ? [PACKED, []] : [ELECTRON, [PC]];
const out = path.resolve(process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || path.join(os.tmpdir(), 'moyu-b10'));
const PORT = Number(process.env.PLAYTEST_PORT || 9371);
const RELAY_PORT = 5198;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const STEAM_NEEDED = '请先启动并登录Steam，再与好友同房。你仍可继续单机游玩。';
fs.mkdirSync(out, { recursive: true });

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail !== '' ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

function build() {
  if (PACKED) return;
  const web = spawnSync(process.execPath, [path.join(PC, 'build-web.mjs')], { cwd: PC, stdio: 'inherit' });
  if (web.status !== 0) throw new Error('网页发布失败');
  const steam = spawnSync('dotnet', ['publish', 'steam', '-c', 'Release', '-o', '.steam', '--nologo', '-v', 'q'], { cwd: PC, stdio: 'inherit' });
  if (steam.status !== 0) throw new Error('Steam 小程序发布失败');
  const input = spawnSync('dotnet', ['publish', 'input', '-c', 'Release', '-o', '.input', '--nologo', '-v', 'q'], { cwd: PC, stdio: 'inherit' });
  if (input.status !== 0) throw new Error('采集程序发布失败');
}

/** B5 的系统层面输入发送器（sendinput.ps1）：PC 版的工作输入只认后台输入采集，B10-20 用它往记事本里真按键。 */
function sender() {
  const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'tools/verify/sendinput.ps1')], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const queue = [];
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) queue.shift()?.(JSON.parse(buf.slice(0, i)));
  });
  const cmd = line => new Promise(r => { queue.push(r); ps.stdin.write(line + '\n'); }).then(r => {
    if (!r.ok) throw new Error(`输入发送器：${line} → ${r.error}`);
    return r;
  });
  return { cmd, close: () => ps.stdin.end() };
}

const tmpData = name => fs.mkdtempSync(path.join(os.tmpdir(), `moyu-b10-${name}-`));
let portSeq = 0;
const shells = [];
const errorsSeen = [];

/** 开一个外壳当 name。args：附加命令行参数（+connect_lobby）；test=false 为正常模式。 */
async function shell(name, { args = [], test = true, userData = tmpData(name), input } = {}) {
  const q = await launch({
    userData, port: PORT + portSeq++, test, ...(input ? { input } : {}), app: [APP[0], [...APP[1], ...args]],
    env: { MOYU_NET_RELAY: RELAY, MOYU_NET_NAME: name, MOYU_NET_RETRY_MS: '500' },
  });
  await q.ev(ROOM_HELPERS);
  const T = expr => q.ev(`window.__t.${expr}`);
  const p = {
    name, id: `u-${name}`, q, userData, T, ev: q.ev, waitFor: q.waitFor,
    room: () => T('room()'),
    bears: () => T(`bears("u-${name}")`),
    seen: () => q.ev('window.__seen'),
    clearSeen: () => q.ev('window.__seen = []; true'),
    inputs: () => q.ev('window.moyuDev.profile()').then(j => j.LifetimeInputs),
    state: () => q.state(),
    async clickSel(sel) {
      const pt = await q.ev(`window.__t.center(${JSON.stringify(sel)})`);
      if (!pt) throw new Error(`${name} 找不到：${sel}`);
      await q.click(pt, 300);
    },
    async clickBtn(text) {
      const pt = await T(`center(window.__t.btn(${JSON.stringify(text)}))`);
      if (!pt) throw new Error(`${name} 找不到按钮：${text}`);
      await q.click(pt, 300);
    },
    async closePanels() {
      for (let i = 0; i < 3; i++) {
        const x = await T(`center(document.querySelector('#pet .panel-head .x, #pet .popup-head .x'))`);
        if (!x) return;
        await q.click(x, 200);
      }
    },
    async roomPanel() {
      if (await p.room()) return;
      await p.closePanels();
      await p.clickBtn('房间');
    },
    kill: () => q.kill(),
  };
  shells.push(p);
  return p;
}

const all = (ps, expr, ms = 10000) => Promise.all(ps.map(p => p.waitFor(expr, ms)));
const countIs = n => `window.__t.room()?.count === '${n}'`;
const counts = ps => Promise.all(ps.map(async p => { await p.roomPanel(); return (await p.room())?.count ?? null; }));

async function run() {
  // ═════════════ B10-20 服务没起来时启动：单机照常，房间页说明 TXT-ROOM-065 ═════════════
  // A 开着后台输入：往记事本里按 3 次键，看计数照常；测完关掉后台输入，后面的房间操作不受真键鼠干扰
  const A = await shell('A', { input: { on: true, chosen: true } });
  build_ = await A.ev(`document.querySelector('meta[name=app-build]')?.content`);
  await A.roomPanel();
  await A.waitFor(`window.__t.room()?.text.includes(${JSON.stringify(STEAM_NEEDED)})`, 8000);
  await A.waitFor(`window.moyuPc.test.state().then(s => s.input.status === 'running')`, 10000);
  const in0 = await A.inputs();
  const si = sender();
  try {
    const np = await si.cmd('notepad');
    try {
      await si.cmd(`focus ${np.hwnd}`);
      await si.cmd(`keys ${np.hwnd} 3`);
      await A.waitFor(`Promise.resolve(window.moyuDev.profile()).then(j => j.LifetimeInputs === ${in0 + 3})`, 5000);
    } finally { await si.cmd(`kill ${np.pid}`).catch(() => { }); }
  } finally { si.close(); }
  await A.ev('window.moyuPc.setInput(false)');
  await A.waitFor(`window.__t.save() === '已保存'`, 8000);
  {
    const r = await A.room();
    const createOff = await A.ev(`document.querySelector('[data-net=create]')?.disabled`);
    const in1 = await A.inputs();
    check('B10-20 回环服务没开时启动：房间页写 TXT-ROOM-065、"创建房间"不可点，没有模拟房间入口、好友列表、"已加入"；工作输入照常计数、存档"已保存"',
      r.text.includes(STEAM_NEEDED) && createOff === true && !r.buttons.includes('创建模拟房间') && !r.buttons.includes('加入模拟房间') && !r.text.includes(T_.friendsTitle)
      && !r.text.includes(T_.joined) && in1 === in0 + 3 && (await A.T('save()')) === '已保存', { text: r.text.slice(0, 120), buttons: r.buttons, createOff, inputs: [in0, in1] });
  }

  // ═════════════ B10-21 起服务，不重开外壳：恢复就绪 ═════════════
  const relay = await startRelay({ port: RELAY_PORT });
  try {
    const ready = await A.waitFor(`!window.__t.room()?.text.includes(${JSON.stringify(STEAM_NEEDED)}) && document.querySelector('[data-net=create]')?.disabled === false`, 10000);
    const in2 = await A.inputs();
    check('B10-21 起回环服务后不重开外壳：几秒内 TXT-ROOM-065 消失、"创建房间"可点；输入次数没变', ready && in2 === in0 + 3, { ready, inputs: in2 });

    // ═════════════ B10-22 4 个外壳同时开 ═════════════
    const B = await shell('B'), C = await shell('C'), D = await shell('D');
    const four = [A, B, C, D];
    const inputs0 = await Promise.all(four.map(p => p.inputs()));
    await A.clearSeen();
    await A.clickSel('[data-net=create]');
    await A.waitFor(countIs(1), 8000);
    await A.waitFor(`window.__t.room().friends.length === 3`, 8000);
    {
      const states = await Promise.all(four.map(p => p.state()));
      const r = await A.room();
      check('B10-22 4 个外壳同时开（各自数据目录）：4 个窗口都在、小程序都连上；A 建房后好友列表有 B、C、D，都是"正在玩桌面摸鱼"',
        states.every(s => s.visible && s.net.running && s.net.hello) && new Set(states.map(s => s.userData)).size === 4
        && r.friends.map(f => f.name).sort().join() === 'B,C,D' && r.friends.every(f => f.text === T_.playing),
        { net: states.map(s => s.net), friends: r.friends });
    }

    // ═════════════ B10-23 邀请、接受经外壳 ═════════════
    const lobby = () => relay.lobbyOf('A');
    await A.clickSel('.friend-row[data-friend="B"] .invite');
    await A.waitFor(`window.__seen.includes(${JSON.stringify(T_.inviteSent)})`, 5000);
    await sleep(400);
    const afterInvite = await A.room();
    await B.roomPanel();
    await B.clearSeen();
    relay.accept('B', lobby());
    await all([A, B], countIs(2));
    const bSeen = await B.seen();
    for (const p of [C, D]) {
      await A.clickSel(`.friend-row[data-friend="${p.name}"] .invite`);
      relay.accept(p.name, lobby());
    }
    await Promise.all(four.map(p => p.roomPanel()));
    await all(four, countIs(4));
    await sleep(600);
    const layouts = async () => Promise.all(four.map(p => p.bears().then(bs => JSON.stringify(bs.map(b => [b.id, Math.round(b.x), Math.round(b.y), b.mode])))));
    {
      const rs = await Promise.all(four.map(p => p.room()));
      const ar = rs[0];
      check('B10-23 点邀请只出"已发出邀请，等待好友加入。"、仍 1/4；接受后"正在加入房间…"→"已加入房间。"；4 页 4/4、房主都是 A、落点一致；被邀请的那行变"已在房间里"',
        afterInvite.count === '1' && afterInvite.net === T_.inviteSent && bSeen.indexOf(T_.joining) >= 0 && bSeen.indexOf(T_.joined) > bSeen.indexOf(T_.joining)
        && rs.every(r => r.count === '4' && r.members.find(m => m.host)?.id === 'u-A') && new Set(await layouts()).size === 1
        && ar.friends.every(f => f.text === T_.inRoom && f.off),
        { afterInvite: { count: afterInvite.count, net: afterInvite.net }, bSeen: bSeen.slice(0, 6), counts: rs.map(r => r.count), friends: ar.friends });
    }

    // ═════════════ B10-24 两人同时抢一个点 ═════════════
    for (const p of four) await p.closePanels();
    await sleep(800);
    {
      const bs = await A.bears();
      let x = null;
      for (let cx = 200; cx <= 1400; cx += 20) if (bs.every(b => b.mode === 'Wade' || Math.abs(b.x - cx) >= 200)) { x = cx; break; }
      if (x === null) throw new Error('岸边没空位：' + JSON.stringify(bs));
      const before = Object.fromEntries(bs.map(b => [b.id, b.x]));
      await B.clearSeen(); await C.clearSeen();
      const pb = await B.T(`scene(${x}, 565)`), pc = await C.T(`scene(${x}, 565)`);
      await Promise.all([B.q.click(pb, 0), C.q.click(pc, 0)]);
      await sleep(1500);
      const after = await A.bears();
      const at = id => after.find(b => b.id === id).x;
      const winners = ['u-B', 'u-C'].filter(id => Math.abs(at(id) - x) < 1);
      const loser = winners.length === 1 ? (winners[0] === 'u-B' ? C : B) : null;
      const loserSeen = loser ? await loser.seen() : [];
      check('B10-24 B、C 同时单击同一点：只有一人站过去，另一人看到"这里放不下"、留在原位；4 页落点一致',
        winners.length === 1 && loserSeen.includes(T_.noRoom) && Math.abs(at(loser.id) - before[loser.id]) < 1 && new Set(await layouts()).size === 1,
        { x, winners, loserSeen: loserSeen.slice(-3) });
    }

    // ═════════════ B10-25 房主掉线 ═════════════
    for (const p of four) await p.clearSeen();
    relay.drop('A');
    await all([B, C, D], `window.__seen.some(s => s.endsWith('已成为房主。'))`, 8000).catch(() => { });
    await sleep(600);
    let newHost;
    {
      const seen = await Promise.all([B, C, D].map(p => p.seen()));
      const hosts = await Promise.all([B, C, D].map(async p => { await p.roomPanel(); const r = await p.room(); return { host: r.members.find(m => m.host)?.id, count: r.count }; }));
      newHost = hosts[0].host;
      await A.roomPanel();
      await A.waitFor(`window.__t.room()?.status === ${JSON.stringify(T_.selfDropped)}`, 5000);
      const ar = await A.room();
      check('B10-25 断掉房主 A：B、C、D 先"正在切换房主…"再"X已成为房主。"、房主同一人、3/4；A 回单机、"连接已中断…"、有"重新加入"',
        seen.every(s => s.includes(T_.migrating) && s.indexOf(T_.newHost(newHost?.slice(2))) > s.indexOf(T_.migrating))
        && hosts.every(h => h.host === newHost && h.count === '3') && newHost !== 'u-A' && ar.status === T_.selfDropped && ar.buttons.includes('重新加入'),
        { hosts, a: { status: ar.status, buttons: ar.buttons } });
    }
    // A 点重新加入回到房里（成员）
    await A.waitFor(`document.querySelector('.rejoin')?.disabled === false && document.querySelector('[data-net=create]')?.disabled === false`, 8000);
    await A.clickBtn('重新加入');
    await all(four, countIs(4), 10000).catch(() => { });

    // ═════════════ B10-26 小程序中途退出（Steam 被关掉） ═════════════
    {
      const st = await A.state();
      for (const p of [B, C, D]) await p.clearSeen();
      await A.clearSeen();
      process.kill(st.net.pid);
      await A.waitFor(`window.__seen.includes(${JSON.stringify(T_.selfDropped)})`, 8000);
      await A.roomPanel();
      const dropped = await A.room();
      const restarted = await A.waitFor(`document.querySelector('.rejoin')?.disabled === false && document.querySelector('[data-net=create]')?.disabled === false`, 10000);
      const st2 = await A.state();
      await A.clickBtn('重新加入');
      await all(four, countIs(4), 10000).catch(() => { });
      await sleep(500);
      const ar = await A.room();
      const rejoinSeen = await Promise.all([B, C, D].map(p => p.seen().then(s => s.includes(T_.rejoined('A')))));
      check('B10-26 结束 A 的小程序：A 回单机、"连接已中断…"；外壳重新拉起小程序，"重新加入"可用；点了回房、是成员；其他人看到"A已重新加入房间。"',
        dropped.status === T_.selfDropped && restarted && st2.net.pid !== st.net.pid && st2.net.started === st.net.started + 1
        && ar.count === '4' && ar.members.find(m => m.self)?.host === false && ar.members.find(m => m.host)?.id === newHost && rejoinSeen.every(Boolean),
        { dropped: dropped.status, restarted, pid: [st.net.pid, st2.net.pid], started: [st.net.started, st2.net.started], a: ar.members, rejoinSeen });
    }

    // ═════════════ B10-27 带房间号冷启动 ═════════════
    const dData = D.userData;
    console.log('  …关掉 D', await D.q.closeByButton());
    await all([A, B, C], countIs(3), 8000).catch(() => { });
    const lob = relay.lobbyOf(newHost.slice(2));
    console.log('  …带 +connect_lobby 重开 D', lob);
    const D2 = await shell('D', { args: ['+connect_lobby', lob], userData: dData });
    await D2.roomPanel();
    await D2.waitFor(countIs(4), 10000);
    {
      const seen = await D2.seen();
      const r = await D2.room();
      check('B10-27 用 +connect_lobby <房间号> 重开 D：启动后自动进这个房间（"已加入房间。"），4/4',
        r.count === '4' && relay.lobbyOf('D') === lob && (seen.includes(T_.joined) || r.net === T_.joined), { count: r.count, net: r.net, seen: seen.slice(0, 6) });
    }

    // ═════════════ B10-28 运行中再启动一次带房间号：不开第二个窗口 ═════════════
    await D2.roomPanel();
    await D2.clickBtn('离开房间');
    await all([A, B, C], countIs(3), 8000).catch(() => { });
    await D2.clearSeen();
    {
      const second = spawn(APP[0], [...APP[1], '+connect_lobby', lob], { env: { ...process.env, MOYU_TEST: '1', MOYU_USER_DATA: dData, MOYU_FAKE_DISPLAYS: JSON.stringify(ONE) }, stdio: 'ignore' });
      const code = await Promise.race([new Promise(r => second.once('exit', r)), sleep(15000).then(() => 'timeout')]);
      if (code === 'timeout') second.kill();
      await D2.roomPanel();
      await D2.waitFor(countIs(4), 10000);
      const st = await D2.state();
      const r = await D2.room();
      check('B10-28 D 开着、在单机时用同一数据目录带 +connect_lobby 再启动一次：第二个进程退出、不开第二个窗口，D 进这个房间',
        code !== 'timeout' && st.windows === 1 && st.stats.secondInstance === 1 && r.count === '4' && relay.lobbyOf('D') === lob,
        { code, windows: st.windows, second: st.stats.secondInstance, count: r.count });
    }

    // ═════════════ B10-29 房间操作不算输入 ═════════════
    {
      const now = await Promise.all([A, B, C].map(p => p.inputs()));
      check('B10-29 建房、邀请、进房、掉线、重新加入、离开前后：输入次数都没因房间操作增加', JSON.stringify(now) === JSON.stringify(inputs0.slice(0, 3)),
        { before: inputs0.slice(0, 3), now });
    }
  } finally {
    for (const p of shells) errorsSeen.push(...p.q.errors);
    for (const p of shells) await p.kill().catch(() => { });
    shells.length = 0;
    relay.close();
  }

  // ═════════════ B10-30 正常模式不认回环：用 Steam 小程序 ═════════════
  {
    const relay2 = await startRelay({ port: RELAY_PORT });
    try {
      const steamRunning = spawnSync('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH'], { encoding: 'utf8' }).stdout.includes('steam.exe');
      const N = await shell('N', { test: false });
      await N.ev(`(() => { const b = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '房间'); b?.click(); return !!b; })()`);
      await sleep(steamRunning ? 8000 : 4000);
      const r = await N.room();
      const createOn = await N.ev(`document.querySelector('[data-net=create]')?.disabled === false`);
      const ok = steamRunning ? createOn && !r.text.includes(STEAM_NEEDED) : r.text.includes(STEAM_NEEDED) && !createOn;
      check('B10-30 正常模式带回环地址启动：不连回环服务（服务里没有这个人），用 Steam 小程序——本机 Steam 没跑时显示 TXT-ROOM-065，跑着并登录时"创建房间"可点',
        ok && relay2.users.size === 0, { steamRunning, createOn, steamNeeded: r.text.includes(STEAM_NEEDED), users: relay2.users.size });
      errorsSeen.push(...N.q.errors);
      await N.kill();
    } finally {
      relay2.close();
    }
  }
  check('B10-31 所有外壳页面控制台没有报错', errorsSeen.length === 0, errorsSeen.slice(0, 5));
}

let fatal = null, build_ = null;
try {
  build();
  await run();
} catch (e) {
  fatal = String(e?.stack || e);
  console.error('脚本中断：', fatal);
  for (const p of shells) await p.kill().catch(() => { });
}
const failed = results.filter(r => !r.pass).length;
const file = path.join(out, 'b10-results.json');
fs.writeFileSync(file, JSON.stringify({ build: build_, time: new Date().toISOString(), passed: results.length - failed, failed, fatal, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} 通过${fatal ? '（脚本中断）' : ''}；构建 ${build_}；结果 ${file}`);
process.exit(failed || fatal ? 1 : 0);
