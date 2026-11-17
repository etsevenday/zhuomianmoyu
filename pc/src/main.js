// 桌面摸鱼 PC 外壳：透明无框窗口装网页版的 Blazor 包（界面和 C# 内核与网页同一份）。
// 外壳只管窗口：分区穿透、拖窗、右下角缩放、收起成头像、置顶、跨屏与重启恢复（05 §6.1）、关闭即退出。
// 窗口设置（显示器、相对位置、占屏比例 s）存在数据目录的 window.json，和玩法存档分开。
//
// 环境变量：
//   MOYU_WEB_DIR   网页包目录（dotnet publish 出来的 wwwroot），默认 pc/.web/wwwroot（npm run build:web）
//   MOYU_USER_DATA 数据目录，默认系统给的
//   MOYU_DEV=1     打开 ?dev=1 开发入口
//   MOYU_TEST=1    验收测试模式：开发入口、window.moyuPc.test 测试入口、可换成虚构显示器
//   MOYU_FAKE_DISPLAYS  测试模式下的虚构显示器 JSON
'use strict';

const { app, BrowserWindow, ipcMain, protocol, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const L = require('./layout');

const TEST = process.env.MOYU_TEST === '1';
const DEV = TEST || process.env.MOYU_DEV === '1';
const WEB_DIR = path.resolve(process.env.MOYU_WEB_DIR || path.join(__dirname, '..', '.web', 'wwwroot'));
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
  // 测试模式下系统鼠标一律不进窗口：窗口挪到测试机真实光标底下时系统会补发鼠标移动，混进 CDP 模拟的拖动。
  // CDP 的指针事件直接送进页面，不受影响；穿透状态照样按页面要求记着（真实系统穿透见人工用例 B4-M2）
  if (TEST) win.setIgnoreMouseEvents(true);
  else win.setIgnoreMouseEvents(on, { forward: true });
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
    win.webContents.send('pc:closing');
    setTimeout(quit, 3000); // 页面没响应也别卡住
  });
  win.loadURL('moyu://app/index.html' + (DEV ? '?dev=1' : ''));
}

function quit() {
  quitting = true;
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 再启动一次：不开第二个窗口，把原窗口显示出来（05 §2 找回）
  app.on('second-instance', () => {
    stats.secondInstance++;
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

  if (TEST) {
    ipcMain.handle('pc:test:state', () => {
      let file = null;
      try { file = fs.readFileSync(SETTINGS_FILE(), 'utf8'); } catch { }
      return {
        bounds: win.getBounds(), expanded, collapsed, ignoring, gesture: gesture?.kind ?? null,
        topmost: win.isAlwaysOnTop(), focused: win.isFocused(), visible: win.isVisible(),
        content: win.getContentBounds(), resizable: win.isResizable(),
        settings, settingsFile: file, userData: app.getPath('userData'), displays: displays(), stats,
      };
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
