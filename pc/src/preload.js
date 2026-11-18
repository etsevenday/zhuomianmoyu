// 页面能用的外壳接口：window.moyuPc。网页版没有它，页面据此判断是不是 PC。
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('pc:info');
const api = {
  /** 指针下面是留白（true）还是实体（false）：留白让鼠标落到下层窗口，移动仍转发回来。 */
  setIgnore: on => ipcRenderer.send('pc:ignore', !!on),
  /** 同步收起、置顶。 */
  sync: state => ipcRenderer.send('pc:sync', state),
  dragStart: () => ipcRenderer.send('pc:drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('pc:drag-move', dx, dy),
  dragEnd: () => ipcRenderer.invoke('pc:drag-end'),
  resizeStart: () => ipcRenderer.send('pc:resize-start'),
  resizeMove: (dx, dy) => ipcRenderer.send('pc:resize-move', dx, dy),
  resizeEnd: cancel => ipcRenderer.invoke('pc:resize-end', !!cancel),
  /** 开始退出（点了关闭）：先停后台输入，再存档。 */
  quitting: () => ipcRenderer.send('pc:quitting'),
  /** 存完档后调用：退出程序。 */
  quit: () => ipcRenderer.send('pc:quit'),
  /** 系统要关窗（Alt+F4 等）：页面走游戏里的关闭，存完再 quit。 */
  onClosing: cb => ipcRenderer.on('pc:closing', () => cb()),
  /** 后台输入：别的程序里按下了一次键或点了一次鼠标（落在小窗上的外壳已排除）。 */
  onWork: cb => ipcRenderer.on('pc:work', () => cb()),
  /** 后台输入的真实开关和状态 { on, status, intro }；状态变了外壳推过来。 */
  input: () => ipcRenderer.invoke('pc:input'),
  onInput: cb => ipcRenderer.on('pc:input', (_, s) => cb(s)),
  setInput: on => ipcRenderer.send('pc:set-input', !!on),
  retryInput: () => ipcRenderer.send('pc:retry-input'),
  introSeen: () => ipcRenderer.send('pc:intro-seen'),
};
if (info.test) {
  api.test = {
    state: () => ipcRenderer.invoke('pc:test:state'),
    setDisplays: list => ipcRenderer.invoke('pc:test:displays', list),
    drag: (dx, dy, release) => ipcRenderer.invoke('pc:test:drag', dx, dy, release),
    release: () => ipcRenderer.invoke('pc:test:release'),
    screenPoint: (x, y) => ipcRenderer.invoke('pc:test:screen-point', x, y),
  };
}
contextBridge.exposeInMainWorld('moyuPc', api);
