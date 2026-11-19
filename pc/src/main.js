// 桌面摸鱼 PC 外壳：透明无框窗口装网页版的 Blazor 包（界面和 C# 内核与网页同一份）。
// 外壳管窗口：分区穿透、拖窗、右下角缩放、收起成头像、置顶、跨屏与重启恢复（05 §6.1）、关闭即退出；
// 以及后台输入（B5）："后台输入"开着时起采集程序（pc/input），把别的程序里的按下、点击一次次转给页面计数；
// 以及联机（B10）：起 Steam 小程序（pc/steam），在它和页面之间转事件、命令。
// 窗口设置（显示器、相对位置、占屏比例 s）存在数据目录的 window.json，和玩法存档分开。
//
// 环境变量：
//   MOYU_WEB_DIR   网页包目录（dotnet publish 出来的 wwwroot），默认 pc/.web/wwwroot（npm run build:web）
//   MOYU_INPUT_EXE 采集程序，默认 pc/.input/MoyuInput.exe（npm run build:input）
//   MOYU_USER_DATA 数据目录，默认系统给的
//   MOYU_DEV=1     打开 ?dev=1 开发入口
//   MOYU_TEST=1    验收测试模式：开发入口、window.moyuPc.test 测试入口、可换成虚构显示器
//   MOYU_FAKE_DISPLAYS  测试模式下的虚构显示器 JSON
//   MOYU_TEST_OS_MOUSE=1  测试模式下系统鼠标照常进窗口（B5 用系统层面的输入测，不用 CDP 拖动）
//   MOYU_STEAM_EXE Steam 小程序，默认 pc/.steam/MoyuSteam.exe（npm run build:steam）
//   MOYU_NET_RELAY、MOYU_NET_NAME  测试模式下让小程序改连 B9 的回环服务、用这个名字（不碰 Steam）；正常模式不认
//   MOYU_NET_RETRY_MS  小程序没就绪时多久再试、断了多久重新拉起，默认 3000
'use strict';

const { app, BrowserWindow, ipcMain, protocol, screen } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const L = require('./layout');

const TEST = process.env.MOYU_TEST === '1';
const DEV = TEST || process.env.MOYU_DEV === '1';
const OS_MOUSE = !TEST || process.env.MOYU_TEST_OS_MOUSE === '1';
const WEB_DIR = path.resolve(process.env.MOYU_WEB_DIR || path.join(__dirname, '..', '.web', 'wwwroot'));
const INPUT_EXE = path.resolve(process.env.MOYU_INPUT_EXE || path.join(__dirname, '..', '.input', 'MoyuInput.exe'));
const STEAM_EXE = path.resolve(process.env.MOYU_STEAM_EXE || path.join(__dirname, '..', '.steam', 'MoyuSteam.exe'));
const NET_RELAY = TEST ? process.env.MOYU_NET_RELAY : null;
const NET_RETRY_MS = Number(process.env.MOYU_NET_RETRY_MS) || 3000;
if (process.env.MOYU_USER_DATA) app.setPath('userData', process.env.MOYU_USER_DATA);
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'window.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.dat': 'application/octet-stream', '.pdb': 'application/octet-stream',
};

// 网页包挂在 moyu://app/ 下：standard + secure 才有 localStorage、IndexedDB、Web Locks，存档跟着数据目录走
protocol.registerSchemesAsPrivileged([
  { scheme: 'moyu', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let win = null;
let settings = {};      // { displayId, rx, ry, s }
let expanded = null;    // 展开时的窗口矩形；收起时记着，恢复用
let collapsed = false;
let ignoring = null;
let gesture = null;     // { kind: 'drag'|'resize', start }
let quitting = false;
let fakeDisplays = null;
const stats = { secondInstance: 0, closeRequests: 0 };

if (TEST && process.env.MOYU_FAKE_DISPLAYS) fakeDisplays = JSON.parse(process.env.MOYU_FAKE_DISPLAYS);
// 虚构显示器上的窗口多半在真实屏幕外，Chromium 会当成被遮挡而停帧，拖动中的指针移动就送不到页面
if (TEST) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

function displays() {
  if (fakeDisplays) return fakeDisplays;
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map(d => ({ id: String(d.id), bounds: d.bounds, workArea: d.workArea, primary: d.id === primaryId }));
}

function readSettings() {
  try { return L.parseSettings(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch { return {}; }
}

function writeSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify({ version: 1, ...settings }, null, 2));
  } catch { /* 存不下不影响这次使用，下次按默认 */ }
}

// Electron 只接受整数矩形；取整交给这里，算法里一直用小数，不累计偏移比例
const round = r => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
const setBounds = r => win.setBounds(round(r));

/** 玩家定下了新位置（拖窗、缩放、拖头像结束）：记显示器和相对位置。 */
function remember(display, rect) {
  const { rx, ry } = L.relPos(rect.x, rect.y, display.workArea);
  settings = { ...settings, displayId: String(display.id), rx, ry };
  writeSettings();
}

/** 按目标屏重算展开尺寸，左上角尽量不动，出界的轴平移回来。 */
function fitOn(display, x, y) {
  const size = L.targetSize(settings.s, display);
  return { ...L.clampPos(x, y, size, display.workArea), ...size };
}

function applyExpanded() {
  setBounds(collapsed ? L.avatarRect(expanded) : expanded);
}

// ───── 拖窗、缩放 ─────

function dragStart() {
  gesture = { kind: 'drag', start: win.getBounds() };
}

function dragMove(dx, dy) {
  if (gesture?.kind !== 'drag') return;
  const s = gesture.start;
  setBounds({ x: s.x + dx, y: s.y + dy, width: s.width, height: s.height }); // 拖动中尺寸不变
}

/** 松手：按落在的屏重算尺寸（05 §6.1 跨屏），记下位置。 */
function dragEnd() {
  if (gesture?.kind !== 'drag') return;
  gesture = null;
  const b = win.getBounds();
  if (collapsed) {
    const display = L.displayAt(displays(), b);
    const size = L.targetSize(settings.s, display);
    expanded = { ...L.windowFromAvatar(b, size, display.workArea), ...size };
    const avatar = L.avatarRect(expanded);
    setBounds({ x: b.x, y: b.y, width: avatar.width, height: avatar.height }); // 头像留在松手处，只按新屏改大小
    remember(display, expanded);
    return;
  }
  const display = L.displayAt(displays(), b);
  expanded = fitOn(display, b.x, b.y);
  setBounds(expanded);
  remember(display, expanded);
}

function resizeStart() {
  if (collapsed) return;
  gesture = { kind: 'resize', start: win.getBounds() };
}

function resizeMove(dx, dy) {
  if (gesture?.kind !== 'resize') return;
  const s = gesture.start;
  const display = L.displayAt(displays(), s);
  const w = gesture.width = L.resizeWidth(s, dx, dy, display.workArea);
  setBounds({ x: s.x, y: s.y, width: w, height: w * 9 / 16 });
}

/** 缩放结束：取消回到拖动前、偏好不变；成功松手才把宽度换成新的 s。 */
function resizeEnd(cancel) {
  if (gesture?.kind !== 'resize') return;
  const { start, width } = gesture;
  gesture = null;
  if (cancel || width == null) {
    setBounds(start);
    return;
  }
  const display = L.displayAt(displays(), start);
  // 用算出来的宽度（未取整）定 s，取整误差不往偏好里累计
  settings = { ...settings, s: L.sFromWidth(width, display) };
  expanded = { x: start.x, y: start.y, width, height: width * 9 / 16 };
  remember(display, expanded);
}

// ───── 收起、置顶、穿透 ─────

function sync(state) {
  if (typeof state.topmost === 'boolean' && win.isAlwaysOnTop() !== state.topmost) win.setAlwaysOnTop(state.topmost);
  if (typeof state.collapsed === 'boolean' && state.collapsed !== collapsed) {
    if (state.collapsed) {
      collapsed = true;
      setBounds(L.avatarRect(expanded));
    } else {
      // 单击头像恢复：按头像现在的位置反推展开窗口（拖过头像时已在 dragEnd 算好）
      collapsed = false;
      setBounds(expanded);
    }
  }
}

function setIgnore(on) {
  if (gesture || on === ignoring) return; // 拖动、缩放中不切，免得半路丢指针
  ignoring = on;
  // B4 测试模式下系统鼠标一律不进窗口：窗口挪到测试机真实光标底下时系统会补发鼠标移动，混进 CDP 模拟的拖动。
  // CDP 的指针事件直接送进页面，不受影响；穿透状态照样按页面要求记着（真实系统穿透见人工用例 B4-M2）
  if (!OS_MOUSE) win.setIgnoreMouseEvents(true);
  else win.setIgnoreMouseEvents(on, { forward: true });
}

// ───── 后台输入（B5，PC 输入 v0.1） ─────
// 开关是 PC 自己的真实偏好，存在数据目录的 input.json，和网页（及 B4 时）的演示开关分开：没有真实偏好时默认开（Q23②）。
// 开着才起采集程序，关了就结束它：关着时什么都不采。采集程序只报"按键 / 点击 / 是不是落在小窗上"，
// 落在小窗上的是管理操作，不计；其余每条立刻转给页面，页面和网页版一样每次调用一次 OnWorkInput，不合并、不限速。
// 只有一条通道、进程内按顺序送达、不重发，所以不需要序号去重；关掉或退出时先断资格（旧进程迟到的行一律丢弃）再结束进程。
// 状态：off 已关闭；starting 正在启动；running 正在采集；failed 启动失败；interrupted 运行中断；unsupported 不是 Windows。
// 失败、中断都等玩家点重试，不自动反复起，也不补算没采到的时段。

const INPUT_FILE = () => path.join(app.getPath('userData'), 'input.json');
let capture = null;      // 采集程序进程
let input = { on: true, chosen: false, introShown: false, status: 'off' };
let introPending = false; // 首次说明要显示、页面还没确认显示过（页面订阅前就跑起来也不丢）
const inputStats = { started: 0, keys: 0, clicks: 0, own: 0 };

function readInput() {
  try {
    const j = JSON.parse(fs.readFileSync(INPUT_FILE(), 'utf8'));
    if (j && typeof j.on === 'boolean') return { on: j.on, chosen: j.chosen === true, introShown: j.introShown === true };
  } catch { }
  return { on: true, chosen: false, introShown: false }; // 没有真实偏好：默认开
}

function writeInput() {
  try {
    fs.writeFileSync(INPUT_FILE(), JSON.stringify({ version: 1, on: input.on, chosen: input.chosen, introShown: input.introShown }, null, 2));
  } catch { /* 存不下下次按默认 */ }
}

/** 把开关和真实状态告诉页面；intro：第一次默认开启、真的跑起来了，页面显示一次说明。 */
const inputView = () => ({ on: input.on, status: input.status, intro: introPending && input.status === 'running' });

function setStatus(status) {
  input.status = status;
  win?.webContents.send('pc:input', inputView());
}

/** 按开关起停。玩家点开关时 chosen 记成真实选择，以后重启照它。 */
function applyInput() {
  if (!input.on) {
    if (capture) stopCapture();
    setStatus('off');
    return;
  }
  if (process.platform !== 'win32') { setStatus('unsupported'); return; }
  if (!capture) startCapture();
}

function setInput(on) {
  input.on = !!on;
  input.chosen = true;
  introPending = false;
  writeInput();
  applyInput();
}

function stopCapture() {
  const p = capture;
  capture = null; // 先断资格：之后到的行都不认
  p.stdin.end();
  p.kill();
}

function nativeHandle() {
  const h = win.getNativeWindowHandle();
  return (h.length >= 8 ? h.readBigUInt64LE(0) : BigInt(h.readUInt32LE(0))).toString();
}

function startCapture() {
  setStatus('starting');
  let p;
  try {
    p = spawn(INPUT_EXE, [nativeHandle()], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    setStatus('failed');
    return;
  }
  capture = p;
  inputStats.started++;
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', chunk => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) onCaptureLine(p, buf.slice(0, i).trim());
  });
  const gone = () => {
    if (capture !== p) return; // 是外壳自己关的
    capture = null;
    if (!quitting) setStatus(p.ready ? 'interrupted' : 'failed');
  };
  p.on('error', gone);
  p.on('exit', gone);
}

function onCaptureLine(p, line) {
  if (capture !== p) return; // 已关掉、已退出或旧进程迟到的
  if (line === 'ready') {
    p.ready = true;
    if (!input.chosen && !input.introShown) {
      input.introShown = true;
      introPending = true;
      writeInput();
    }
    setStatus('running');
    return;
  }
  const [kind, own] = line.split(' ');
  if (kind !== 'k' && kind !== 'c') return;
  // 点击落在小窗上、而小窗这时是穿透的：点击其实落到了下层窗口，照算
  if (own === '1' && !(kind === 'c' && ignoring)) { inputStats.own++; return; }
  inputStats[kind === 'k' ? 'keys' : 'clicks']++;
  win?.webContents.send('pc:work');
}

// ───── 联机（B10） ─────
// Steam 小程序一行一个 JSON：事件和 B9 回环服务同一种，原样转给页面；页面的命令原样写给它。
// 页面订阅之前到的事件先攒着（带 +connect_lobby 启动时，小程序就绪就会报"要进这个房间"），订阅时一起送。
// 小程序退出（Steam 被关掉、退出登录、崩了）：连上过就告诉页面"断了"（房里按掉线，页面回单机、留重新加入），
// 再报"没就绪"，过一会儿重新拉起，从等 Steam 就绪重来。Steam 自己往标准输出写的杂行不是 JSON，丢掉。

let net = null;          // 小程序进程
let netQueue = [];       // 页面订阅前攒下的事件
let netSubscribed = false;
let netConnect = connectArg(process.argv);
const netStats = { started: 0 };

/** Steam 拉起游戏、或玩家在 Steam 里接受邀请时带的 +connect_lobby <房间号>。 */
function connectArg(argv) {
  const i = argv.indexOf('+connect_lobby');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function netEvent(json) {
  if (netSubscribed) win?.webContents.send('pc:net', json);
  else netQueue.push(json);
}

function startNet() {
  if (net || quitting) return;
  const args = NET_RELAY ? ['--relay', NET_RELAY, '--name', process.env.MOYU_NET_NAME || 'me'] : [];
  if (netConnect) args.push('--connect', netConnect);
  let p;
  try {
    p = spawn(STEAM_EXE, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, MOYU_NET_RETRY_MS: String(NET_RETRY_MS) } });
  } catch {
    netEvent('{"type":"steam","ready":false}');
    return;
  }
  net = p;
  netStats.started++;
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', chunk => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
      const line = buf.slice(0, i).trim();
      if (net !== p || !line.startsWith('{')) continue;
      try { JSON.parse(line); } catch { continue; }
      if (line.includes('"type":"hello"')) { p.hello = true; netConnect = null; }
      netEvent(line);
    }
  });
  const gone = () => {
    if (net !== p) return;
    net = null;
    if (quitting) return;
    if (p.hello) netEvent('{"type":"disconnected"}');
    netEvent('{"type":"steam","ready":false}');
    setTimeout(startNet, NET_RETRY_MS);
  };
  p.on('error', gone);
  p.on('exit', gone);
  p.stdin.on('error', () => { });
}

function netCmd(json) {
  if (net && !net.stdin.destroyed) net.stdin.write(json + '\n');
}

function stopNet() {
  const p = net;
  net = null;
  if (!p) return;
  p.stdin.end();
  setTimeout(() => p.kill(), 1000); // 给它一点时间离开房间
}

/** 开始退出：先停止新增采集资格，再走保存退出。开关不变。 */
function quitting_() {
  quitting = true;
  if (capture) stopCapture();
  stopNet();
}

/** 显示器拔掉、分辨率或系统缩放变了：回到原屏或主屏，按 s 重算，按相对位置放回可用范围。不改玩家偏好。 */
function onDisplaysChanged() {
  if (!win || !expanded) return;
  const display = L.pickDisplay(displays(), settings.displayId);
  const size = L.targetSize(settings.s, display);
  const pos = settings.rx != null ? L.placeFromRel(settings.rx, settings.ry, size, display.workArea) : L.defaultPos(size, display.workArea);
  expanded = { ...pos, ...size };
  applyExpanded();
}

// ───── 启动 ─────

function serveWeb() {
  protocol.handle('moyu', async req => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR + path.sep)) return new Response('not found', { status: 404 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

function createWindow() {
  const restored = L.restore(readSettings(), displays());
  settings = restored.settings;
  expanded = restored.bounds;
  win = new BrowserWindow({
    ...round(expanded),
    title: '桌面摸鱼',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,       // 只认右下角热区缩放（16:9），系统边框缩放不要
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  setIgnore(true); // 穿透默认开：留白交给下层，页面按指针下面是不是实体再切
  win.once('ready-to-show', () => (TEST ? win.showInactive() : win.show()));
  // 系统关窗（Alt+F4、任务栏关闭）也走游戏里的关闭：先存档再退出
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    stats.closeRequests++;
    quitting_();
    win.webContents.send('pc:closing');
    setTimeout(quit, 3000); // 页面没响应也别卡住
  });
  win.loadURL('moyu://app/index.html' + (DEV ? '?dev=1' : ''));
  // 页面载完再起采集：状态要能告诉页面，首次说明也要页面在才看得到
  input = { ...readInput(), status: 'off' };
  win.webContents.once('did-finish-load', applyInput);
  startNet();
}

function quit() {
  quitting_();
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 再启动一次：不开第二个窗口，把原窗口显示出来（05 §2 找回）
  app.on('second-instance', (_, argv) => {
    stats.secondInstance++;
    // 游戏开着时 Steam 又带着房间号启动了一次：交给小程序，就绪后报"要进这个房间"
    const lobby = connectArg(argv);
    if (lobby) netCmd(JSON.stringify({ op: 'joinRequest', lobby }));
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.showInactive();
    applyExpanded();
  });

  ipcMain.on('pc:info', e => { e.returnValue = { test: TEST }; });
  ipcMain.on('pc:ignore', (_, on) => setIgnore(!!on));
  ipcMain.on('pc:sync', (_, state) => sync(state || {}));
  ipcMain.on('pc:drag-start', dragStart);
  ipcMain.on('pc:drag-move', (_, dx, dy) => dragMove(dx, dy));
  ipcMain.handle('pc:drag-end', dragEnd);
  ipcMain.on('pc:resize-start', resizeStart);
  ipcMain.on('pc:resize-move', (_, dx, dy) => resizeMove(dx, dy));
  ipcMain.handle('pc:resize-end', (_, cancel) => resizeEnd(!!cancel));
  ipcMain.on('pc:quit', quit);
  ipcMain.on('pc:quitting', quitting_);
  ipcMain.handle('pc:input', inputView);
  ipcMain.on('pc:intro-seen', () => { introPending = false; });
  ipcMain.on('pc:set-input', (_, on) => setInput(on));
  ipcMain.on('pc:retry-input', () => { if (input.on && !capture) applyInput(); });
  ipcMain.on('pc:net-start', () => {
    if (!netSubscribed) {
      netSubscribed = true;
      for (const json of netQueue) win?.webContents.send('pc:net', json);
      netQueue = [];
    }
    startNet();
  });
  ipcMain.on('pc:net-cmd', (_, json) => netCmd(String(json)));

  if (TEST) {
    ipcMain.handle('pc:test:state', () => {
      let file = null;
      try { file = fs.readFileSync(SETTINGS_FILE(), 'utf8'); } catch { }
      return {
        bounds: win.getBounds(), expanded, collapsed, ignoring, gesture: gesture?.kind ?? null,
        topmost: win.isAlwaysOnTop(), focused: win.isFocused(), visible: win.isVisible(),
        content: win.getContentBounds(), resizable: win.isResizable(),
        settings, settingsFile: file, userData: app.getPath('userData'), displays: displays(), stats,
        capture: { running: !!capture, ready: !!capture?.ready, pid: capture?.pid ?? null, ...inputStats },
        input: { ...input }, inputFile: (() => { try { return fs.readFileSync(INPUT_FILE(), 'utf8'); } catch { return null; } })(),
        physical: screen.dipToScreenRect(win, win.getBounds()), hwnd: nativeHandle(),
        net: { running: !!net, pid: net?.pid ?? null, hello: !!net?.hello, relay: NET_RELAY ?? null, ...netStats },
        windows: BrowserWindow.getAllWindows().length,
      };
    });
    // 窗口里一点（页面 CSS 像素）在屏幕上的物理坐标：系统层面的点击要用
    ipcMain.handle('pc:test:screen-point', (_, x, y) => {
      const b = win.getBounds();
      return screen.dipToScreenPoint({ x: b.x + x, y: b.y + y });
    });
    ipcMain.handle('pc:test:displays', (_, list) => { fakeDisplays = list; onDisplaysChanged(); });
    // 和真实拖动走同一套：按下、按位移移动、松手
    ipcMain.handle('pc:test:drag', (_, dx, dy, release = true) => {
      dragStart();
      dragMove(dx, dy);
      if (release) dragEnd();
    });
    ipcMain.handle('pc:test:release', () => dragEnd());
  }

  app.whenReady().then(() => {
    serveWeb();
    createWindow();
    if (!fakeDisplays) for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, onDisplaysChanged);
  });
  app.on('window-all-closed', () => app.quit());
}
