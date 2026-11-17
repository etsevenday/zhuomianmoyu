// PC 窗口的尺寸与位置计算（05 §6.1，Q6/Q7）。纯函数，不碰 Electron，验收脚本直接调用。
// 坐标都是逻辑像素（Electron 的 DIP）。显示器：{ id, bounds:{x,y,width,height}, workArea:{...}, primary }。
'use strict';

const MIN_W = 400;
const MIN_H = 225;
const DEFAULT_S = 1 / 4;
const MARGIN = 24; // 首次打开离工作区右、下边的距离，和网页版一致

const finite = v => typeof v === 'number' && Number.isFinite(v);

/** 基准宽度 B=min(W,16H/9)，W、H 是整块屏幕（不是工作区）。 */
function baseWidth(display) {
  const { width, height } = display.bounds;
  return Math.min(width, height * 16 / 9);
}

/** 工作区里能放下的最大 16:9 宽度。 */
function fitWidth(workArea) {
  return Math.min(workArea.width, workArea.height * 16 / 9);
}

const sizeOf = w => ({ width: w, height: w * 9 / 16 });

/**
 * 按占屏比例 s 在这块屏上显示的尺寸：目标 sB，受工作区能放下的最大 16:9 限制，但不低于 400×225。
 * 工作区比下限还小时仍按下限（不偷偷降低下限），位置由 clampPos 保证可找回。
 */
function targetSize(s, display) {
  const w = Math.max(MIN_W, Math.min(s * baseWidth(display), fitWidth(display.workArea)));
  return sizeOf(w);
}

const validS = s => finite(s) && s > 0 && s <= 1;

/** 玩家缩放结束时选定的宽度换成占屏比例。 */
function sFromWidth(width, display) {
  return width / baseWidth(display);
}

/** 把一根轴夹进 [lo, lo+len-size]；放不下（没有余量）就留在可用边界 lo。 */
function clampAxis(v, size, lo, len) {
  const hi = lo + len - size;
  if (hi < lo) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/** 整窗放回工作区：出界的轴平移回来，不锁底。 */
function clampPos(x, y, size, workArea) {
  return {
    x: clampAxis(x, size.width, workArea.x, workArea.width),
    y: clampAxis(y, size.height, workArea.y, workArea.height),
  };
}

/** 窗口左上角在工作区里的相对位置（0—1）。 */
function relPos(x, y, workArea) {
  return { rx: (x - workArea.x) / workArea.width, ry: (y - workArea.y) / workArea.height };
}

function defaultPos(size, workArea) {
  return clampPos(workArea.x + workArea.width - size.width - MARGIN, workArea.y + workArea.height - size.height - MARGIN, size, workArea);
}

/** 按相对位置在工作区里放下这么大的窗口。 */
function placeFromRel(rx, ry, size, workArea) {
  return clampPos(workArea.x + rx * workArea.width, workArea.y + ry * workArea.height, size, workArea);
}

function primaryOf(displays) {
  return displays.find(d => d.primary) || displays[0];
}

/** 原屏还在用原屏，否则主屏。 */
function pickDisplay(displays, id) {
  return (id != null && displays.find(d => String(d.id) === String(id))) || primaryOf(displays);
}

const overlap = (a, b) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** 窗口归哪块屏：重叠面积最大的那块；都不重叠就看窗口中心离哪块最近。 */
function displayAt(displays, rect) {
  let best = null, bestArea = 0;
  for (const d of displays) {
    const a = overlap(rect, d.bounds);
    if (a > bestArea) { best = d; bestArea = a; }
  }
  if (best) return best;
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  const dist = d => Math.hypot(cx - (d.bounds.x + d.bounds.width / 2), cy - (d.bounds.y + d.bounds.height / 2));
  return displays.reduce((a, b) => (dist(b) < dist(a) ? b : a));
}

/** 读窗口设置文件。坏的字段逐项丢掉：s 坏了回落 1/4，位置坏了回落默认位置，显示器不认识回落主屏。 */
function parseSettings(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  if (typeof raw.displayId === 'string' || typeof raw.displayId === 'number') out.displayId = String(raw.displayId);
  if (validS(raw.s)) out.s = raw.s;
  if (finite(raw.rx) && finite(raw.ry) && raw.rx >= 0 && raw.ry >= 0 && raw.rx <= 1 && raw.ry <= 1) {
    out.rx = raw.rx;
    out.ry = raw.ry;
  }
  return out;
}

/** 启动恢复：先选显示器，再按 s 和相对位置放。返回 { settings, display, bounds }。 */
function restore(settings, displays) {
  const display = pickDisplay(displays, settings.displayId);
  const s = validS(settings.s) ? settings.s : DEFAULT_S;
  const size = targetSize(s, display);
  const pos = settings.rx != null ? placeFromRel(settings.rx, settings.ry, size, display.workArea) : defaultPos(size, display.workArea);
  return { settings: { ...settings, s }, display, bounds: { ...pos, ...size } };
}

/**
 * 右下角缩放：左上角不动，按指针位移换算宽度（沿对角线拖时宽度就加 dx），保持 16:9。
 * 不小于下限；也不超过工作区能放下的最大 16:9，且右下角不出工作区（下限优先）。
 */
function resizeWidth(start, dx, dy, workArea) {
  const want = start.width + (dx + dy * 16 / 9) / 2;
  const roomW = workArea.x + workArea.width - start.x;
  const roomH = workArea.y + workArea.height - start.y;
  const max = Math.min(fitWidth(workArea), roomW, roomH * 16 / 9);
  return Math.max(MIN_W, Math.min(want, max));
}

/** 收起头像：直径为展开窗口高的 1/4，放在窗口左下角色处（和网页版 DesktopLayout 同一个算法）。 */
function avatarRect(win) {
  const a = win.height / 4;
  return { x: win.x + win.width * 0.06, y: win.y + win.height - a - win.height * 0.18, width: a, height: a };
}

/** 由头像位置反推展开窗口的位置，再夹进工作区。 */
function windowFromAvatar(avatar, size, workArea) {
  const a = size.height / 4;
  return clampPos(avatar.x - size.width * 0.06, avatar.y - size.height + a + size.height * 0.18, size, workArea);
}

module.exports = {
  MIN_W, MIN_H, DEFAULT_S,
  baseWidth, fitWidth, targetSize, validS, sFromWidth, clampPos, relPos, defaultPos, placeFromRel,
  pickDisplay, displayAt, parseSettings, restore, resizeWidth, avatarRect, windowFromAvatar,
};
