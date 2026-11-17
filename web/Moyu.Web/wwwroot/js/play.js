// 网页核心循环在浏览器这边的三件事：收工作输入、存玩法档、多标签页只让一个写。
//
// 工作输入（01 §1）：页面里游戏界面以外的真实键盘按下、鼠标点击各算 1 次。
//   - 只认 isTrusted 的事件：页面脚本合成的不算；页面外（别的软件、别的标签页）本来就收不到，也不补。
//   - 键盘：keydown 计 1，自动连发（repeat）不计，松开不计；输入法按真实按键计，composition/input 事件不另计。
//   - 鼠标：一次按下到松开算一次点击（主/中/次键都算），双击是两次；按住移动超过 5 像素就算拖，不计。
//   - 游戏界面（小窗、收起头像、任务栏和桌面上的"桌面摸鱼"入口、开发条）上的操作都是管理操作，不计。
// 玩法档（03 §5）：IndexedDB 一条记录 {revision, json}，整份档案在一个事务里写完才算保存成功；读写失败照实报告。
// 写权（06 §3）：Web Locks 拿到锁的标签页才能计数和交易，别的标签页只读，等锁空出来再接手。
window.moyuPlay = (() => {
  const DB_NAME = 'zhuomianmoyu-play';
  const STORE = 'profile';
  const KEY = 'main';
  const LOCK = 'zhuomianmoyu-writer';
  const DRAG_THRESHOLD = 5;
  const GAME_UI = '#pet, #avatar, .dev-strip, [data-game-ui]';

  let dotnet = null;
  let press = null;
  let failSaves = false;
  let acts = 0;

  const isGame = el => !!(el && el.closest && el.closest(GAME_UI));

  function work() {
    if (!dotnet) return;
    dotnet.invokeMethodAsync('OnWorkInput').then(accepted => { if (accepted) act(); }).catch(() => { });
  }

  // 小熊的短动作：每次重新播放，高频时互相打断，停下就停，不排队补播（02 §2）
  function act() {
    acts++;
    const pet = document.getElementById('pet');
    if (pet) pet.dataset.acts = String(acts);
    replay(document.querySelector('#pet svg.scene g.bear[data-hit="character"]'));
  }

  function replay(bear) {
    if (!bear) return;
    bear.classList.remove('act');
    void bear.getBoundingClientRect();
    bear.classList.add('act');
  }

  // 好友收获的提示音（同图房间 01 §4.6）：一声短促的两音，克制。静音、收起由 .NET 判定后才调用。
  // 占位音色，等正式音效替换。浏览器没给声音权限（页面还没被点过）时静默失败。
  let audio = null;
  let chimes = 0;
  function chime() {
    chimes++;
    try {
      audio = audio || new AudioContext();
      const t = audio.currentTime;
      [[880, 0], [1175, 0.09]].forEach(([freq, at]) => {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t + at);
        gain.gain.exponentialRampToValueAtTime(0.06, t + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.25);
        osc.connect(gain).connect(audio.destination);
        osc.start(t + at);
        osc.stop(t + at + 0.3);
      });
    } catch { }
  }

  function onKeyDown(e) {
    if (!e.isTrusted || e.repeat || isGame(e.target)) return;
    work();
  }

  function onPointerDown(e) {
    if (!e.isTrusted) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, game: isGame(e.target), moved: false };
  }

  function onPointerMove(e) {
    if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_THRESHOLD) press.moved = true;
  }

  function onPointerUp(e) {
    if (!e.isTrusted || !press || e.pointerId !== press.id) return;
    const p = press;
    press = null;
    if (p.game || p.moved || isGame(e.target)) return;
    work();
  }

  // ---- IndexedDB ----

  function openDb() {
    return new Promise((ok, bad) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => ok(req.result);
      req.onerror = () => bad(req.error);
      req.onblocked = () => bad(new Error('数据库被占用'));
    });
  }

  async function load() {
    try {
      const db = await openDb();
      try {
        const rec = await new Promise((ok, bad) => {
          const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
          req.onsuccess = () => ok(req.result);
          req.onerror = () => bad(req.error);
        });
        if (rec === undefined) return { status: 'none' };
        if (!rec || typeof rec.json !== 'string' || typeof rec.revision !== 'number') return { status: 'error', message: '存档格式不对' };
        return { status: 'ok', json: rec.json, revision: rec.revision };
      } finally { db.close(); }
    } catch (err) {
      return { status: 'error', message: String(err && err.message || err) };
    }
  }

  // 只有记录里的修订号还是 baseRevision 时才写（别的标签页写过就拒绝），事务 complete 才算成功
  async function save(json, baseRevision) {
    if (failSaves) return { ok: false, message: '模拟保存失败' };
    try {
      const db = await openDb();
      try {
        return await new Promise((ok) => {
          const tx = db.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          let result = { ok: true };
          const get = store.get(KEY);
          get.onsuccess = () => {
            const cur = get.result;
            const curRev = cur && typeof cur.revision === 'number' ? cur.revision : 0;
            if (cur !== undefined && curRev !== baseRevision) {
              result = { ok: false, message: '存档已被别处改过' };
              tx.abort();
              return;
            }
            store.put({ revision: baseRevision + 1, json }, KEY);
          };
          tx.oncomplete = () => ok(result);
          tx.onabort = () => ok(result.ok ? { ok: false, message: String(tx.error && tx.error.message || '保存中断') } : result);
          tx.onerror = () => { };
        });
      } finally { db.close(); }
    } catch (err) {
      return { ok: false, message: String(err && err.message || err) };
    }
  }

  // ---- 写权 ----

  // 立刻拿得到锁返回 true；拿不到返回 false，并在后台排队，轮到时通知 .NET 接手（接手前重新读档）
  function acquireWriter() {
    if (!navigator.locks) return Promise.resolve(true);
    return new Promise(resolve => {
      navigator.locks.request(LOCK, { ifAvailable: true }, lock => {
        if (!lock) {
          resolve(false);
          navigator.locks.request(LOCK, () => {
            dotnet?.invokeMethodAsync('OnWriterGranted');
            return new Promise(() => { });
          });
          return;
        }
        resolve(true);
        return new Promise(() => { }); // 页面在就一直拿着
      });
    });
  }

  return {
    init(ref) {
      dotnet = ref;
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('pointerup', onPointerUp, true);
      document.addEventListener('pointercancel', () => { press = null; }, true);
    },
    load,
    save,
    acquireWriter,
    act,
    friendAct: id => replay(document.querySelector(`#pet svg.scene g.friend[data-member="${id}"] g.bear`)),
    chime,
    now: () => Date.now(),
    // 新档的随机上下文：64 位，十进制字符串交给 .NET（JS 数字装不下 64 位整数）
    newSeed() {
      const a = new Uint32Array(2);
      crypto.getRandomValues(a);
      return ((BigInt(a[0]) << 32n) | BigInt(a[1])).toString();
    },
    // 开发入口（只在 ?dev=1 下由 .NET 打开）：验收脚本和试玩用来构造前置条件
    enableDev(ref) {
      window.moyuDev = {
        injectFish: n => ref.invokeMethodAsync('DevInjectFish', n),
        addCoins: n => ref.invokeMethodAsync('DevAddCoins', n),
        failSaves: on => { failSaves = !!on; return ref.invokeMethodAsync('DevSaveFailureChanged', failSaves); },
        profile: () => ref.invokeMethodAsync('DevProfileJson').then(j => JSON.parse(j)),
        // 手竿计时：把页面看到的"现在"往后拨，再立刻检查一次
        skew: ms => ref.invokeMethodAsync('DevSkew', ms),
        poleTick: () => ref.invokeMethodAsync('DevPoleTick'),
        // 同图房间：把上一条好友收获消息原样重发一次、再发一条旧代次的（模拟网络重复和迟到），返回被接受的条数
        roomReplay: () => ref.invokeMethodAsync('DevRoomReplay'),
        // 同图房间：界面上这时点不到的演示（收起时让好友收获、查看鱼缸时让对方断线或结束模拟）：catch / drop / end
        room: (action, id) => ref.invokeMethodAsync('DevRoom', action, id ?? null),
      };
    },
    get failingSaves() { return failSaves; },
    // 页面收到并被接受的工作输入次数（小熊动作次数），收起时 #pet 不在也照样记
    get acts() { return acts; },
    // 好友收获提示音响过几次（验收用）
    get chimes() { return chimes; },
  };
})();
