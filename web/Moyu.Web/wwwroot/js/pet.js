// 假桌面的缩放与指针手势。
// 桌面逻辑尺寸 1920×1080，按视口等比缩放、居中。
// 小窗上：按住角色/水面拖动整个窗口；没拖动就松开算单击，交给 C# 判定选位（DEC-13）。
// 拖动全程（按下、移动、松开、取消）都不产生捕鱼输入——第一阶段也还没有捕鱼计数。
// PC 版（Electron 外壳给了 window.moyuPc）：页面就是小窗本身，拖动改成移动原生窗口，
// 右下角热区缩放窗口，指针下面是不是实体决定窗口接不接鼠标（分区穿透）。
window.moyuPet = (() => {
  const DESKTOP_W = 1920;
  const DESKTOP_H = 1080;
  const DRAG_THRESHOLD = 5; // 屏幕像素：超过才算拖动

  let dotnet = null;
  let desktop = null;
  let gesture = null;
  const pc = window.moyuPc || null;

  function scale() {
    return desktop ? desktop.getBoundingClientRect().width / DESKTOP_W : 1;
  }

  function fit() {
    if (pc) return pcFit();
    if (!desktop) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const s = Math.min(vw / DESKTOP_W, vh / DESKTOP_H);
    desktop.style.transform =
      `translate(${(vw - DESKTOP_W * s) / 2}px, ${(vh - DESKTOP_H * s) / 2}px) scale(${s})`;
  }

  // 被拖动的元素：小窗、收起头像、记事本窗口（由 data-drag-target 指明）
  function dragTarget(el) {
    const id = el.closest('[data-drag-target]')?.getAttribute('data-drag-target');
    return id ? document.getElementById(id) : null;
  }

  function onDown(e) {
    if (e.button !== 0) return;
    const hit = e.target.closest('[data-hit]');
    if (!hit) return;
    const kind = hit.getAttribute('data-hit');
    const target = pc ? null : dragTarget(hit);
    gesture = {
      kind,
      target,
      id: e.pointerId,
      // PC 拖动时窗口自己在动，页面内坐标跟着变，位移按屏幕坐标算
      sx: pc ? e.screenX : e.clientX,
      sy: pc ? e.screenY : e.clientY,
      ox: target ? parseFloat(target.style.left) || 0 : 0,
      oy: target ? parseFloat(target.style.top) || 0 : 0,
      moved: false,
      dragging: false,
      el: hit,
    };
    try { hit.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
    // 只有能拖的才阻止默认，避免选中文字；记事本正文等照常
    if (target || pc) e.preventDefault();
  }

  function canDrag(kind) {
    return kind === 'character' || kind === 'water' || kind === 'avatar' || kind === 'app-title' || kind === 'resize';
  }

  function onMove(e) {
    if (!gesture || e.pointerId !== gesture.id) return;
    const dx = (pc ? e.screenX : e.clientX) - gesture.sx;
    const dy = (pc ? e.screenY : e.clientY) - gesture.sy;
    if (!gesture.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      // 按住移动过就不再是单击：能拖的开始拖窗，岸边等不能拖的松开后什么也不做（B0-11）
      gesture.moved = true;
      if (canDrag(gesture.kind)) {
        gesture.dragging = true;
        document.body.classList.add('dragging');
        if (pc) gesture.kind === 'resize' ? pc.resizeStart() : pc.dragStart();
      }
    }
    if (gesture.dragging && pc) {
      gesture.kind === 'resize' ? pc.resizeMove(dx, dy) : pc.dragMove(dx, dy);
    } else if (gesture.dragging && gesture.target) {
      const s = scale();
      const w = gesture.target.offsetWidth;
      const h = gesture.target.offsetHeight;
      const x = Math.max(0, Math.min(DESKTOP_W - w, gesture.ox + dx / s));
      const y = Math.max(0, Math.min(DESKTOP_H - 48 - h, gesture.oy + dy / s));
      gesture.target.style.left = `${x}px`;
      gesture.target.style.top = `${y}px`;
    }
  }

  function finish(e, cancelled) {
    if (!gesture || e.pointerId !== gesture.id) return;
    const g = gesture;
    gesture = null;
    document.body.classList.remove('dragging');
    if (g.dragging && pc) {
      // 拖窗松开、取消都定下位置（和网页一致）；缩放取消回到拖动前尺寸
      if (g.kind === 'resize') pc.resizeEnd(cancelled);
      else pc.dragEnd();
      suppressClickUntil = performance.now() + 300;
      return;
    }
    if (g.dragging) {
      // 拖动的松开和取消都只定下窗口位置，不再提交选位
      const x = parseFloat(g.target.style.left) || 0;
      const y = parseFloat(g.target.style.top) || 0;
      if (g.kind === 'avatar') dotnet?.invokeMethodAsync('OnAvatarMoved', x, y);
      else if (g.kind !== 'app-title') dotnet?.invokeMethodAsync('OnWindowMoved', x, y);
      // 拖完紧跟的 click 不要再触发按钮等
      suppressClickUntil = performance.now() + 300;
      return;
    }
    if (cancelled || g.moved) return;
    if (g.kind === 'avatar') {
      dotnet?.invokeMethodAsync('OnAvatarClicked');
      return;
    }
    if (g.kind === 'character' || g.kind === 'water' || g.kind === 'shore') {
      const scene = g.el.closest('svg.scene');
      if (!scene) return;
      const r = scene.getBoundingClientRect();
      const cx = (e.clientX - r.left) / r.width * 1600;
      const cy = (e.clientY - r.top) / r.height * 900;
      dotnet?.invokeMethodAsync('OnSceneClicked', g.kind, cx, cy);
    }
  }

  let suppressClickUntil = 0;

  // 缩放中按 Esc 取消（UI-15）
  function onKey(e) {
    if (e.key !== 'Escape' || !gesture || gesture.kind !== 'resize') return;
    const g = gesture;
    gesture = null;
    document.body.classList.remove('dragging');
    if (g.dragging) pc?.resizeEnd(true);
    e.preventDefault();
  }

  // ───── PC：分区穿透 ─────
  // 窗口默认忽略鼠标、只转发移动；指针移到画出来的实体（角色、岸、水、按钮、面板、头像）上才接住。
  // 穿透关时整窗都接住（留白点了没反应，DEC-09）。
  const pcState = { passthrough: true, ignore: null, x: -1, y: -1 };

  function pcFit() {
    const r = document.documentElement;
    r.style.setProperty('--pc-scale', String(window.innerWidth / 1600));
    // 收起头像的直径是展开窗口高的 1/4；展开时记下，收起那一刻就按这个大小画
    if (!document.getElementById('avatar')) r.style.setProperty('--pc-avatar', `${window.innerHeight / 4}px`);
  }

  function blankAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return !el || el === document.documentElement || el === document.body || el.id === 'app' || el.classList.contains('pc-root');
  }

  function pcHover() {
    if (!pc || gesture) return;
    const ignore = pcState.passthrough && (pcState.x < 0 || blankAt(pcState.x, pcState.y));
    if (ignore === pcState.ignore) return;
    pcState.ignore = ignore;
    pc.setIgnore(ignore);
  }

  function pcPointer(e) {
    pcState.x = e.clientX;
    pcState.y = e.clientY;
    pcHover();
  }

  // 点完按钮面板可能开了或关了，指针不动也要重新判断脚下（面板关后不留热区，TECH-05）
  function pcRecheck() {
    setTimeout(pcHover, 30);
    setTimeout(pcHover, 200);
  }

  function swallowClickAfterDrag(e) {
    if (performance.now() < suppressClickUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  return {
    init(ref, desktopEl) {
      dotnet = ref;
      desktop = desktopEl;
      fit();
      window.addEventListener('resize', fit);
      document.addEventListener('pointerdown', onDown);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', (e) => finish(e, false));
      document.addEventListener('pointercancel', (e) => finish(e, true));
      window.addEventListener('click', swallowClickAfterDrag, true);
      if (!pc) return;
      document.documentElement.classList.add('pc');
      window.addEventListener('keydown', onKey, true);
      document.addEventListener('pointermove', pcPointer, true);
      document.addEventListener('pointerup', pcRecheck, true);
      pc.onClosing(() => dotnet?.invokeMethodAsync('OnPcClosing'));
    },
    isPc() {
      return !!pc;
    },
    /** C# 渲染完同步：收起、置顶交给外壳，穿透开关自己记着。 */
    pcSync(collapsed, topmost, passthrough) {
      if (!pc) return;
      pc.sync({ collapsed, topmost });
      pcState.passthrough = passthrough;
      pcState.ignore = null;
      pcFit();
      pcRecheck();
      pcHover();
    },
    /** 存完档退出程序。 */
    pcQuit() {
      pc?.quit();
    },
    load(key) {
      try { return window.localStorage.getItem(key); } catch { return null; }
    },
    save(key, value) {
      try { window.localStorage.setItem(key, value); } catch { /* 存不下就算了 */ }
    },
    isDev() {
      return new URLSearchParams(window.location.search).get('dev') === '1';
    },
  };
})();
