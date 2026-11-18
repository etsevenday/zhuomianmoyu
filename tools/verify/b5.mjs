// B5 PC 后台输入验收：node tools/verify/b5.mjs [--release] [输出目录]
// 发布网页包和采集程序，以测试模式启动 Electron（系统鼠标照常进窗口），再开一个记事本垫在小窗底下，
// 用 sendinput.ps1 发系统层面的真实按键和点击（和用户自己按键走同一条路），看计数、动作、状态、提示和记事本收到的字。
// 发键前确认前台是指定窗口、点击前确认那一点上是指定窗口，不对就停，不会往别的软件里打字或点击。
// 跑的时候不要动鼠标键盘。PC 包本来就是 Release 发布，--release 只为和其他批次的命令一致。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './b4.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PC = path.join(REPO, 'pc');
const out = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'moyu-b5'));
fs.mkdirSync(out, { recursive: true });

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail !== '' ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

// 定稿原句（文案交接 05；和 Texts.cs 一致，改文案时两边一起对）
const COPY_FILE = path.join(REPO, 'doc/策划案/文案交接 v0.1/05 PC输入与设置文案定稿.md');
const TXT = Object.fromEntries(fs.readFileSync(COPY_FILE, 'utf8').split('\n')
  .filter(l => /^\| TXT-PC-\d{3} \|/.test(l)).map(l => { const c = l.split('|').map(s => s.trim()); return [c[1], c[3]]; }));

function build() {
  const r = spawnSync(process.execPath, [path.join(PC, 'build-web.mjs')], { cwd: PC, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('网页发布失败');
  const r2 = spawnSync('dotnet', ['publish', 'input', '-c', 'Release', '-o', '.input', '--nologo', '-v', 'q'], { cwd: PC, stdio: 'inherit' });
  if (r2.status !== 0) throw new Error('采集程序发布失败');
}

/** 系统层面输入发送器：一行命令一行 JSON。 */
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

let fatal = null, build_ = null;
const errorsSeen = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-b5-'));
const si = sender();
let np = null, p = null;

// input: null —— 不预写后台输入偏好，用外壳自己的默认（全新安装）
const launchPc = (userData = tmp, env = {}) => launch({ userData, displays: null, input: null, env: { MOYU_TEST_OS_MOUSE: '1', ...env } });

async function run() {
  build();
  p = await launchPc();
  build_ = await p.ev(`document.querySelector('meta[name=app-build]')?.content`);

  const st = () => p.state();
  const prof = () => p.ev('window.moyuDev.profile()');
  const inputs = async () => (await prof()).LifetimeInputs;
  const acts = () => p.ev('window.moyuPlay.acts');
  const groups = async prefix => Object.entries((await prof()).Groups || {}).filter(([k]) => k.toLowerCase().startsWith(prefix)).reduce((a, [, g]) => a + (g.Count ?? 0), 0);
  const text = async () => (await si.cmd(`text ${np.hwnd}`)).length;
  const demoPref = async () => (await p.T('prefs()'))?.BackgroundInput ?? null;
  /** 等计数到 want（最多 3 秒），返回实际值。 */
  const settle = async want => {
    let v;
    for (let i = 0; i < 30; i++) { v = await inputs(); if (v === want) return v; await sleep(100); }
    await sleep(300);
    return inputs();
  };
  /** 等页面浮出这句提示（提示 3.5 秒后自己消失）。 */
  const sawNotice = (t, ms = 6000) => p.waitFor(`document.querySelector('.notice')?.innerText.trim() === ${JSON.stringify(t)}`, ms);
  /** 窗口里一点（CSS 像素）在屏幕上的物理坐标。 */
  const phys = async pt => {
    const q = await p.ev(`window.moyuPc.test.screenPoint(${pt.x}, ${pt.y})`);
    return { x: Math.round(q.x), y: Math.round(q.y) };
  };
  const switchSel = '.setting-row[data-setting=background-input] [role=switch]';
  /** 打开设置读"后台输入"那一行和下面的说明，fn 在关面板前再做点事。 */
  async function settings(fn) {
    await p.btn('更多'); await p.btn('设置');
    const r = await p.ev(`({ on: document.querySelector('${switchSel}')?.getAttribute('aria-checked'),
      label: document.querySelector('[data-stat=input-status]')?.innerText.trim(),
      problem: document.querySelector('[data-note=input-state]')?.innerText.trim() ?? null,
      retry: !!document.querySelector('[data-act=retry-input]'),
      offNote: document.querySelector('[data-note=input-off]')?.innerText.trim() ?? null })`);
    if (fn) await fn();
    await p.click(await p.T(`center('#pet .panel-head .x')`));
    return r;
  }
  const waitStatus = async (status, ms = 6000) => {
    const end = Date.now() + ms;
    let s;
    while (Date.now() < end) { s = await st(); if (s.input.status === status) return s; await sleep(100); }
    return s;
  };

  // 记事本垫在小窗底下，并往左上多出一块（在小窗外，用来点它、往里打字）
  np = await si.cmd('notepad');
  const placeNotepad = async () => {
    const w = (await st()).physical;
    const x = Math.max(0, w.x - 520), y = Math.max(0, w.y - 320);
    await si.cmd(`move ${np.hwnd} ${x} ${y} ${w.x + w.width - x} ${w.y + w.height - y}`);
    return { x: x + Math.round((w.x - x) / 2), y: w.y + Math.round(w.height / 2) };
  };
  let npPoint;
  /** 让记事本到前台、光标在文字区：点它露在小窗外的那块。 */
  const focusNotepad = async () => {
    await si.cmd(`focus ${np.hwnd}`);
    await si.cmd(`click ${np.hwnd} ${npPoint.x} ${npPoint.y}`);
    await sleep(200);
  };
  const keysDelta = async n => {
    await focusNotepad();
    const t0 = await inputs();
    await si.cmd(`keys ${np.hwnd} ${n}`);
    await sleep(400);
    return (await settle(t0 + n)) - t0;
  };

  // B5-01 全新启动默认开，真跑起来才说
  {
    const intro = await sawNotice(TXT['TXT-PC-007']);
    const s = await waitStatus('running');
    const panels = await p.T('panels()');
    npPoint = await placeNotepad();
    const sw = await settings();
    const file = JSON.parse(s.inputFile || 'null');
    const demo = await demoPref();
    await focusNotepad();
    const t0 = await inputs(), x0 = await text();
    await si.cmd(`keys ${np.hwnd} 10`);
    const t1 = await settle(t0 + 10), x1 = await text();
    check('B5-01 全新启动：后台输入默认开、采集程序起来后状态"正在采集"、浮出一次首次说明、不开面板；网页演示值没被当成真实开关；记事本按 10 次 +10',
      intro && s.input.status === 'running' && s.capture.ready && sw.on === 'true' && sw.label === TXT['TXT-PC-018'] && panels === 0
      && file?.on === true && file?.introShown === true && file?.chosen === false && demo !== true && t1 - t0 === 10 && x1 - x0 === 10,
      { intro, status: s.input.status, switch: sw, panels, file, demo, inputs: t1 - t0, text: x1 - x0 });
  }

  // B5-02 100 次
  {
    await focusNotepad();
    const t0 = await inputs(), a0 = await acts(), x0 = await text();
    await si.cmd(`keys ${np.hwnd} 100`);
    const t1 = await settle(t0 + 100), a1 = await acts(), x1 = await text();
    check('B5-02 记事本按 100 次：计数 +100、动作 +100、记事本收到 100 个字', t1 - t0 === 100 && a1 - a0 === 100 && x1 - x0 === 100,
      { inputs: t1 - t0, acts: a1 - a0, text: x1 - x0 });
  }
  // B5-03 连发
  {
    const t0 = await inputs(), x0 = await text();
    await si.cmd(`hold ${np.hwnd} 25`);
    const t1 = await settle(t0 + 1), x1 = await text();
    check('B5-03 按住连发 25 次：计数 +1；记事本收到 25 个字', t1 - t0 === 1 && x1 - x0 === 25, { inputs: t1 - t0, text: x1 - x0 });
  }
  // B5-04 组合键
  {
    const t0 = await inputs();
    await si.cmd(`combo ${np.hwnd}`);
    const t1 = await settle(t0 + 2);
    check('B5-04 Shift+1：计数 +2', t1 - t0 === 2, { inputs: t1 - t0 });
  }
  // B5-05 点击
  {
    const t0 = await inputs();
    await si.cmd(`click ${np.hwnd} ${npPoint.x} ${npPoint.y} left`);
    await si.cmd(`click ${np.hwnd} ${npPoint.x + 20} ${npPoint.y} middle`);
    const t1 = await settle(t0 + 2);
    check('B5-05 记事本里左键、中键各点一次：计数 +2', t1 - t0 === 2, { inputs: t1 - t0 });
  }
  // B5-06 拖动
  {
    const t0 = await inputs();
    await si.cmd(`drag ${np.hwnd} ${npPoint.x - 60} ${npPoint.y} 40 0`);
    await sleep(600);
    const t1 = await inputs();
    check('B5-06 记事本里按下左键挪 40 像素松开：计数 +0', t1 === t0, { inputs: t1 - t0 });
  }
  // B5-07 点小窗
  {
    const s0 = await st();
    const t0 = await inputs();
    const clickOwn = async cssPt => {
      const q = await phys(cssPt);
      await si.cmd(`point ${q.x} ${q.y}`);
      await sleep(300); // 小窗按指针位置切到"接住"
      await si.cmd(`click ${s0.hwnd} ${q.x} ${q.y}`);
      await sleep(300);
    };
    await clickOwn(await p.T(`hit('character')`));
    await clickOwn(await p.T(`center(window.__t.btn('更多'))`));
    await clickOwn(await p.T(`center(window.__t.btn('设置'))`));
    const opened = await p.T('panels()');
    await clickOwn(await p.T(`center('#pet .panel-head .x')`));
    const closed = await p.T('panels()');
    await sleep(300);
    const t1 = await inputs(), s1 = await st();
    check('B5-07 系统点击点小熊、开设置、关面板：计数 +0；面板照常开关', t1 === t0 && opened === 1 && closed === 0 && s1.capture.own - s0.capture.own >= 4,
      { inputs: t1 - t0, opened, closed, own: s1.capture.own - s0.capture.own });
  }
  // B5-08 小窗在前台时按键
  {
    const s0 = await st();
    const fg = (await si.cmd('fg')).hwnd;
    const t0 = await inputs();
    let sent = true;
    try { await si.cmd(`keys ${s0.hwnd} 10`); } catch { sent = false; }
    await sleep(600);
    const t1 = await inputs();
    check('B5-08 小窗在前台时按 10 次：计数 +0', sent && String(fg) === s0.hwnd && t1 === t0, { foregroundIsPc: String(fg) === s0.hwnd, sent, inputs: t1 - t0 });
  }
  // B5-09 穿透区点击
  {
    const blank = await p.T('blank()');
    const q = await phys(blank);
    await si.cmd(`point ${q.x} ${q.y}`);
    await sleep(400); // 小窗按指针位置切到穿透
    const t0 = await inputs();
    let through = true;
    // 守卫：这一点上的窗口必须已经是记事本（小窗确实让开了），否则不点
    try { await si.cmd(`click ${np.hwnd} ${q.x} ${q.y}`); } catch { through = false; }
    const t1 = await settle(t0 + 1);
    const fg = (await si.cmd('fg')).hwnd;
    check('B5-09 小窗留白处系统点击：落到记事本（它到了前台）、计数 +1', through && fg === np.hwnd && t1 - t0 === 1, { through, notepadFront: fg === np.hwnd, inputs: t1 - t0 });
  }
  // B5-10 收起
  {
    await p.btn('收起');
    await sleep(500);
    await focusNotepad();
    const t0 = await inputs(), a0 = await acts();
    await si.cmd(`keys ${np.hwnd} 10`);
    const t1 = await settle(t0 + 10), a1 = await acts();
    const collapsed = (await st()).collapsed && !(await p.ev(`!!document.querySelector('#pet')`));
    await p.click(await p.T(`center('#avatar')`));
    await sleep(800);
    const panels = await p.T('panels()'), a2 = await acts();
    check('B5-10 收起时记事本按 10 次：计数 +10、动作 +10；恢复后不回放动作、不自己开面板', collapsed && t1 - t0 === 10 && a1 - a0 === 10 && a2 === a1 && panels === 0,
      { collapsed, inputs: t1 - t0, acts: a1 - a0, replay: a2 - a1, panels });
    npPoint = await placeNotepad();
  }
  // B5-11 落在当前模式
  {
    const cur = await p.ev(`document.querySelector('#pet .mode span').innerText`);
    if (cur !== '摸鱼') { await p.btn(cur); await p.btn('摸鱼'); }
    await sleep(300);
    const mode = await p.ev(`document.querySelector('#pet .mode span').innerText`);
    await focusNotepad(); // 点记事本那一下也计，基线放在它后面
    const l0 = await groups('lure'), w0 = await groups('wade'), t0 = await inputs();
    await si.cmd(`keys ${np.hwnd} 10`);
    const d = (await settle(t0 + 10)) - t0;
    const l1 = await groups('lure'), w1 = await groups('wade');
    check('B5-11 换到摸鱼后按 10 次：摸鱼那组 +10、路亚那组不变', mode === '摸鱼' && d === 10 && w1 - w0 === 10 && l1 === l0, { mode, wade: w1 - w0, lure: l1 - l0 });
  }
  // B5-12 玩家关掉
  {
    const pid = (await st()).capture.pid;
    const demo0 = await demoPref();
    await p.btn('更多'); await p.btn('设置');
    await p.click(await p.T(`center('${switchSel}')`));
    const said = await sawNotice(TXT['TXT-PC-009']);
    await p.click(await p.T(`center('#pet .panel-head .x')`));
    const s = await waitStatus('off');
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) { try { process.kill(pid, 0); await sleep(100); } catch { alive = false; } }
    const sw = await settings();
    const d = await keysDelta(100);
    const file = JSON.parse(s.inputFile || 'null');
    check('B5-12 关掉：提示"已关闭"、标签"已关闭"、显示关闭说明；采集程序退出；记事本按 100 次 +0；真实偏好记成玩家关过，网页演示值不变',
      said && sw.on === 'false' && sw.label === TXT['TXT-PC-019'] && sw.offNote === TXT['TXT-PC-010'] && !s.capture.running && !alive && d === 0
      && file?.on === false && file?.chosen === true && (await demoPref()) === demo0,
      { said, switch: sw, alive, inputs: d, file, demo: [demo0, await demoPref()] });
  }
  // B5-13 关着重启仍关；重开不补；开着退出、期间按键也不补
  {
    let code = await p.closeByButton();
    errorsSeen.push(...p.errors);
    p = await launchPc();
    await sleep(1500);
    const s0 = await st(), sw0 = await settings();
    npPoint = await placeNotepad();
    const dOff = await keysDelta(100);
    await p.btn('更多'); await p.btn('设置');
    await p.click(await p.T(`center('${switchSel}')`));
    const saidOn = await sawNotice(TXT['TXT-PC-008']);
    await p.click(await p.T(`center('#pet .panel-head .x')`));
    await waitStatus('running');
    const dOn = await keysDelta(100);
    // 开着退出、退出期间按 10 次、再启动
    await p.waitFor(`window.__t.save() === '已保存'`, 10000);
    const before = await inputs();
    code = (await p.closeByButton()) === 0 && code === 0 ? 0 : 1;
    errorsSeen.push(...p.errors);
    await focusNotepad();
    await si.cmd(`keys ${np.hwnd} 10`);
    p = await launchPc();
    const s1 = await waitStatus('running');
    const after = await inputs();
    const introAgain = await sawNotice(TXT['TXT-PC-007'], 2500);
    check('B5-13 关着重启：仍关、不起采集程序，按 100 次 +0；重开提示"已开启"，按 100 次 +100；开着退出期间按 10 次、再启动：自动开起来、计数和退出前一样、不再弹首次说明',
      code === 0 && sw0.on === 'false' && s0.capture.started === 0 && dOff === 0 && saidOn && dOn === 100 && s1.capture.ready && after === before && !introAgain,
      { exit: code, switch: sw0, started: s0.capture.started, off: dOff, saidOn, on: dOn, before, after, introAgain });
    npPoint = await placeNotepad();
  }
  // B5-14 采集中断：显示中断，等玩家重试
  {
    const c0 = (await st()).capture;
    process.kill(c0.pid);
    const said = await sawNotice(TXT['TXT-PC-016']);
    const s = await waitStatus('interrupted');
    const d0 = await keysDelta(5);
    const sw = await settings(async () => {
      await p.click(await p.T(`center('[data-act=retry-input]')`));
    });
    const s1 = await waitStatus('running');
    const d1 = await keysDelta(5);
    check('B5-14 采集程序中途退出：提示"已中断"、状态"尚未采集"并有重试，按 5 次 +0；点重试后重新采集，按 5 次 +5',
      said && s.input.status === 'interrupted' && sw.label === TXT['TXT-PC-017'] && sw.problem?.startsWith(TXT['TXT-PC-016']) && sw.retry && d0 === 0
      && s1.input.status === 'running' && s1.capture.pid !== c0.pid && d1 === 5,
      { said, status: s.input.status, switch: sw, before: d0, pid: [c0.pid, s1.capture.pid], after: d1 });
  }
  errorsSeen.push(...p.errors);
  await p.kill();

  // B5-15 启动失败
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-b5-fail-'));
    p = await launchPc(dir, { MOYU_INPUT_EXE: path.join(dir, '没有这个程序.exe') });
    const said = await sawNotice(TXT['TXT-PC-014']);
    const s = await waitStatus('failed');
    npPoint = await placeNotepad();
    const sw = await settings();
    const d = await keysDelta(10);
    check('B5-15 采集程序起不来：提示"启动失败"、状态"尚未采集"并有重试，不弹首次说明；按 10 次 +0',
      said && s.input.status === 'failed' && sw.on === 'true' && sw.label === TXT['TXT-PC-017'] && sw.problem?.startsWith(TXT['TXT-PC-014']) && sw.retry && d === 0,
      { said, status: s.input.status, switch: sw, inputs: d });
    errorsSeen.push(...p.errors);
  }
}

// B5-16 静态：只数次数；B5-17 PC 原句逐字一致
function staticChecks() {
  const src = fs.readFileSync(path.join(PC, 'input/Program.cs'), 'utf8');
  const main = fs.readFileSync(path.join(PC, 'src/main.js'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  const banned = ['ToUnicode', 'GetKeyNameText', 'MapVirtualKey', 'SetWindowsHook', 'GetWindowText', 'File.', 'FileStream', 'Socket', 'Http', 'Clipboard', 'Process.'].filter(w => code.includes(w));
  const writes = [...code.matchAll(/output\.WriteLine\(([^;]*)\);/g)].map(m => m[1].trim());
  const writesOk = writes.length === 2 && writes.includes('"ready"') && writes.some(w => /\$"\{kind\} 1"\s*:\s*\$"\{kind\} 0"/.test(w));
  const noConsole = !/Console\.(Write|Out)/.test(code.replace('Console.Error.WriteLine', ''));
  const mainForward = /function onCaptureLine[\s\S]*?\r?\n}\r?\n/.exec(main)?.[0] || '';
  const mainOk = mainForward.includes("send('pc:work')") && !/console\.|writeFile|appendFile/.test(mainForward) && !/console\.(log|info|warn|error)/.test(main);
  check('B5-16 采集程序不取字符键名、不装钩子、不写文件不联网，只输出 ready/k/c；外壳只转发次数、不写日志',
    banned.length === 0 && writesOk && noConsole && mainOk, { banned, writes, noConsole, mainOk });

  const texts = fs.readFileSync(path.join(REPO, 'web/Moyu.Web/Services/Texts.cs'), 'utf8');
  const used = [...texts.matchAll(/const string \w+ = "([^"]*)"; \/\/ (TXT-PC-\d{3})/g)].map(m => ({ id: m[2], text: m[1] }));
  const wrong = used.filter(u => TXT[u.id] !== u.text);
  check('B5-17 PC 用到的 TXT-PC 原句和定稿 05 逐字一致（24 条唯一）', Object.keys(TXT).length === 24 && used.length >= 18 && wrong.length === 0,
    { copy: Object.keys(TXT).length, used: used.length, wrong });
}

try {
  staticChecks();
  await run();
  check('B5-18 控制台没有报错', errorsSeen.length === 0, errorsSeen.slice(0, 5));
} catch (e) {
  fatal = String(e?.stack || e);
  console.error('脚本中断：', fatal);
} finally {
  if (np) await si.cmd(`kill ${np.pid}`).catch(() => { });
  si.close();
  if (p) await p.kill();
}
const failed = results.filter(r => !r.pass).length;
const file = path.join(out, 'b5-results.json');
fs.writeFileSync(file, JSON.stringify({ build: build_, time: new Date().toISOString(), passed: results.length - failed, failed, fatal, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} 通过${fatal ? '（脚本中断）' : ''}；构建 ${build_}；结果 ${file}`);
process.exit(failed || fatal ? 1 : 0);
