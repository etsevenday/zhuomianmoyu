// B9 本机回环服务：按 Steam 房间的规矩做的假房间服务，让几个网页在一台电脑上联机测协议（NET-EVAL-001 §6 第 2 步）。
// 规矩照 §8 实测：所有者唯一、所有者走了交给剩下的人、只有所有者写得进房间数据（别人写不报错但不生效）、每人只写自己的成员数据、
// 消息点对点；4 人上限，满了拒绝。网页带 ?net=<本服务地址>&name=<名字> 连上来：GET /events 收事件（SSE），POST /cmd 发命令。
// 脚本另有直接控制：accept（代替"在 Steam 里点接受邀请"）、drop（拔网线）、replay（把一条旧消息再发一次）等。零依赖。
import http from 'node:http';

export async function startRelay({ port = Number(process.env.RELAY_PORT || 5197), ownerFirst = false } = {}) {
  const users = new Map();   // id → { id, name, playing, res（连着时的 SSE 响应）, lobby }
  const lobbies = new Map(); // id → { id, owner, members: [], data: {}, memberData: {} }
  const lastMsg = new Map(); // "from→to" → 最后一条消息
  const log = [];
  let lobbySeq = 0;

  const push = (id, ev) => { const u = users.get(id); if (u?.res) u.res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const friendsOf = id => [...users.values()].filter(u => u.id !== id && (u.res || u.fake)).map(u => ({ id: u.id, name: u.name, playing: u.playing }));
  const pushFriends = () => { for (const u of users.values()) if (u.res) push(u.id, { type: 'friends', list: friendsOf(u.id) }); };

  function enter(u, lobbyId) {
    const l = lobbies.get(lobbyId);
    if (!l) return push(u.id, { type: 'enterFailed', reason: 'gone' });
    if (l.members.length >= 4) return push(u.id, { type: 'enterFailed', reason: 'full' });
    if (u.lobby) leave(u, false);
    l.members.push(u.id);
    u.lobby = l.id;
    push(u.id, { type: 'entered', lobby: l.id, owner: l.owner, members: [...l.members], ver: l.data.ver ?? null, room: l.data.room ?? null, memberData: { ...l.memberData } });
    for (const m of l.members) if (m !== u.id) push(m, { type: 'memberJoined', id: u.id });
  }

  function leave(u, dropped) {
    const l = lobbies.get(u.lobby);
    u.lobby = null;
    if (!l) return;
    l.members = l.members.filter(m => m !== u.id);
    delete l.memberData[u.id];
    if (l.members.length === 0) { lobbies.delete(l.id); return; }
    const ownerLeft = l.owner === u.id;
    if (ownerLeft) l.owner = l.members[0];
    for (const m of l.members) {
      if (ownerLeft && ownerFirst) push(m, { type: 'ownerChanged', owner: l.owner });
      push(m, { type: 'memberLeft', id: u.id, dropped });
      if (ownerLeft && !ownerFirst) push(m, { type: 'ownerChanged', owner: l.owner });
    }
  }

  function command(u, c) {
    log.push({ from: u.id, ...c });
    const l = lobbies.get(u.lobby);
    switch (c.op) {
      case 'create': {
        if (u.lobby) leave(u, false);
        const id = `L${++lobbySeq}`;
        lobbies.set(id, { id, owner: u.id, members: [], data: {}, memberData: {} });
        return enter(u, id);
      }
      case 'join': return enter(u, c.lobby);
      case 'leave': return leave(u, false);
      case 'setLobbyData':
        if (!l || l.owner !== u.id) return; // 不是所有者：不报错、不生效
        l.data[c.key] = c.text;
        for (const m of l.members) if (m !== u.id) push(m, { type: 'lobbyData', key: c.key, text: c.text });
        return;
      case 'setMemberData':
        if (!l) return;
        l.memberData[u.id] = c.text;
        for (const m of l.members) if (m !== u.id) push(m, { type: 'memberData', id: u.id, text: c.text });
        return;
      case 'send':
        lastMsg.set(`${u.id}→${c.to}`, c.text);
        return push(c.to, { type: 'message', from: u.id, text: c.text });
      case 'broadcast':
        if (!l) return;
        for (const m of l.members) if (m !== u.id) { lastMsg.set(`${u.id}→${m}`, c.text); push(m, { type: 'message', from: u.id, text: c.text }); }
        return;
      case 'invite':
        if (!l || !users.get(c.to)) return push(u.id, { type: 'inviteFailed', to: c.to });
        push(c.to, { type: 'invited', from: u.id, lobby: l.id });
        return push(u.id, { type: 'inviteSent', to: c.to });
    }
  }

  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (url.pathname === '/events') {
      const name = url.searchParams.get('name') || 'anon';
      const id = `u-${name}`;
      const old = users.get(id);
      if (old?.res) { const r = old.res; old.res = null; if (old.lobby) leave(old, true); r.end(); }
      const u = old || { id, name, playing: true, lobby: null };
      u.fake = false;
      users.set(id, u);
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': hi\n\n');
      u.res = res;
      push(id, { type: 'hello', self: id, name });
      pushFriends();
      req.on('close', () => {
        if (u.res !== res) return;
        u.res = null;
        if (u.lobby) leave(u, true);
        pushFriends();
      });
      return;
    }
    if (url.pathname === '/cmd' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        res.writeHead(204, cors);
        res.end();
        try {
          const c = JSON.parse(body);
          const u = users.get(c.user);
          if (u?.res) command(u, c);
        } catch { }
      });
      return;
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(port, '127.0.0.1', ok); });

  const idOf = name => `u-${name}`;
  return {
    url: `http://127.0.0.1:${port}`,
    log, users, lobbies,
    lobbyOf: name => users.get(idOf(name))?.lobby ?? null,
    /** 在 Steam 里点"接受邀请"：让 name 收到"要加入这个房间"。 */
    accept: (name, lobby) => push(idOf(name), { type: 'joinRequested', lobby }),
    /** 拔网线：断开 name 的连接，房间里按掉线处理。 */
    drop: name => {
      const u = users.get(idOf(name));
      if (!u?.res) return false;
      const r = u.res;
      u.res = null;
      if (u.lobby) leave(u, true);
      r.destroy();
      pushFriends();
      return true;
    },
    /** 把 from 发给 to 的最后一条消息原样再送一次。 */
    replay: (from, to) => {
      const text = lastMsg.get(`${idOf(from)}→${idOf(to)}`);
      if (text) push(idOf(to), { type: 'message', from: idOf(from), text });
      return text ?? null;
    },
    /** 一个在线但没开游戏的好友（没有连接，只出现在别人的好友列表里）。 */
    addIdle: name => { users.set(idOf(name), { id: idOf(name), name, playing: false, fake: true, res: null, lobby: null }); pushFriends(); },
    /** 改房间数据里的版本，造"版本不一致"。 */
    setVer: (lobby, ver) => { const l = lobbies.get(lobby); if (l) l.data.ver = ver; },
    close: () => { for (const u of users.values()) u.res?.destroy(); server.close(); },
  };
}
