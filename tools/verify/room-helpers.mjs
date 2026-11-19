// B9、B10 共用：房间相关的定稿文案（脚本里比对用）和页面里的读数助手（window.__t，记出现过的状态行到 window.__seen）。
export const T_ = {
  create: '创建房间', creating: '正在创建房间…', waiting: '等待好友加入…', inviteSent: '已发出邀请，等待好友加入。',
  joining: '正在加入房间…', joined: '已加入房间。', inviteGone: '邀请已失效，或房间已结束。', version: '游戏版本不一致，暂时无法加入。',
  friendsTitle: '在线Steam好友', online: '在线', playing: '正在玩桌面摸鱼', inRoom: '已在房间里', invite: '邀请', noFriends: '暂时没有在线的Steam好友。',
  full: '房间已满（4/4）。', hostOnly: '只有房主可以切换地图。', followed: m => `已跟随房间前往${m}，原地图进度已保留。`,
  left: m => `已离开房间，留在${m}。个人进度和资产已保留。`, migrating: '房主已离开，正在切换房主…', newHost: n => `${n}已成为房主。`,
  rejoined: n => `${n}已重新加入房间。`, gone: n => `${n}已断线，位置已释放。`, selfDropped: '连接已中断，原位置已释放。重新加入后会重新安排位置。',
  catchTitle: n => `${n}的新鱼获`, tankGone: '对方已离开房间，暂时无法查看。', noRoom: '这里放不下', count: n => `房间人数 ${n}/4（含房主）`,
};

export const ROOM_HELPERS = `window.__seen = [];
new MutationObserver(() => {
  for (const e of document.querySelectorAll('[data-stat=net-status], [data-stat=room-status], [data-stat=room-migrating], .notice, svg.scene text')) {
    const t = (e.textContent || '').trim();
    if (t && window.__seen[window.__seen.length - 1] !== t && !window.__seen.slice(-40).includes(t)) window.__seen.push(t);
  }
}).observe(document, { subtree: true, childList: true, characterData: true });
window.__t = {
  scene(x, y) { const r = document.querySelector('svg.scene').getBoundingClientRect(); return { x: r.left + x / 1600 * r.width, y: r.top + y / 900 * r.height }; },
  center(el) { if (typeof el === 'string') el = document.querySelector(el); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; },
  btn(text) { return [...document.querySelectorAll('button')].find(b => b.offsetParent !== null && (b.title === text || (b.innerText || '').trim() === text)); },
  save() { return document.querySelector('[data-stat=save]')?.innerText.trim() ?? null; },
  pos(g) { const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(g.getAttribute('transform')); return { x: +m[1], y: +m[2] }; },
  bears(self) {
    const me = document.querySelector('svg.scene g.bear[data-hit=character]');
    const one = (id, g) => ({ id, ...this.pos(g), mode: g.dataset.mode });
    return [...(me ? [one(self, me)] : []), ...[...document.querySelectorAll('svg.scene g.friend')].map(f => one(f.dataset.member, f.querySelector('g.bear')))].sort((a, b) => a.id < b.id ? -1 : 1);
  },
  room() {
    const p = document.querySelector('#pet .panel.room'); if (!p) return null;
    const q = s => p.querySelector(s);
    return {
      none: q('[data-stat=room-none]')?.innerText.trim() ?? null, status: q('[data-stat=room-status]')?.innerText.trim() ?? null,
      net: q('[data-stat=net-status]')?.innerText.trim() ?? null, kind: q('[data-stat=room-kind]')?.dataset.kind ?? null,
      count: q('[data-stat=room-count]')?.dataset.count ?? null, map: q('[data-stat=room-map]')?.dataset.map ?? null,
      members: [...p.querySelectorAll('.member-row')].map(r => ({ id: r.dataset.member, self: r.dataset.self === 'true', host: r.dataset.host === 'true' })),
      friends: [...p.querySelectorAll('.friend-row')].map(r => ({ name: r.dataset.friend, state: r.dataset.state, text: r.querySelector('.state').innerText.trim(), btn: r.querySelector('button').innerText.trim(), off: r.querySelector('button').disabled })),
      title: p.querySelector('.room-right .demo-title')?.innerText.trim() ?? null,
      empty: q('[data-stat=friends-empty]')?.innerText.trim() ?? null,
      text: p.innerText, buttons: [...p.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean),
      view: q('.tank-view')?.dataset.viewState ?? null, viewFish: p.querySelectorAll('.view-fish').length,
    };
  },
  cards() { return [...document.querySelectorAll('#pet .friend-card')].map(c => ({ id: c.dataset.member, head: c.querySelector('.card-head').innerText.trim() })); },
  tank() { const g = document.querySelector('svg.scene .bg-tank'); return g ? { owner: g.dataset.owner, fish: g.querySelectorAll('.bg-fish').length } : null; },
  notice() { return document.querySelector('.notice')?.innerText.trim() ?? null; },
};`;
