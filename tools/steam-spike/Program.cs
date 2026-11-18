// NET-EVAL-001 第一步：Steam 小实验（公用测试 ID 480）。
// 两台电脑跑同一个程序：开发方那台带参数 host 当房主，对方双击（不带参数）当加入方。全程自动，结果写在程序旁边的 txt 里。
//
// 房主：建"仅好友"房间 → 等好友打开本程序（好友状态显示在玩 480）→ 只邀请这位好友 → 对方进房后依次测：
//   房间数据同步、成员数据同步、可靠消息往返延迟、不可靠消息连发丢包、房间数据连续改的到达情况、房间聊天消息、
//   房主退出后 Steam 换所有者、旧房主重新进房是普通成员。
// 加入方：等邀请 → 自动进房 → 按房主发来的消息配合，记下自己看到的（尤其是换房主那一段），最后汇报给房主。
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Steamworks;

Console.OutputEncoding = Encoding.UTF8;
var host = args.FirstOrDefault() == "host";
var log = new Log(host ? "房主" : "加入方");
Environment.SetEnvironmentVariable("SteamAppId", "480");
Environment.SetEnvironmentVariable("SteamGameId", "480");

if (!SteamAPI.Init())
{
    log.Line("连不上 Steam：请先打开 Steam 客户端并登录，再重新运行本程序。");
    log.End(false);
    return;
}
SteamNetworkingUtils.InitRelayNetworkAccess();
var me = SteamUser.GetSteamID();
log.Line($"已登录 Steam：{SteamFriends.GetPersonaName()}（{me}），身份：{(host ? "房主" : "加入方")}");

var net = new Net(log);
var ok = host ? Host.Run(log, net, me) : Join.Run(log, net, me);
log.End(ok);
SteamAPI.Shutdown();

static class Host
{
    public static bool Run(Log log, Net net, CSteamID me)
    {
        // 1. 建仅好友房间，写房间数据和自己的成员数据
        var lobby = Lobby.Create(log);
        if (lobby == CSteamID.Nil) return false;
        SteamMatchmaking.SetLobbyData(lobby, "marker", "moyu-spike");
        SteamMatchmaking.SetLobbyData(lobby, "ver", "spike-1");
        SteamMatchmaking.SetLobbyData(lobby, "epoch", "1");
        SteamMatchmaking.SetLobbyMemberData(lobby, "mode", "Lure");

        // 2. 等好友打开本程序（在玩 480 的好友），只邀请这一位
        log.Line("等对方打开实验程序（最多等 2 小时）……");
        CSteamID friend = CSteamID.Nil;
        var waitStart = Stopwatch.StartNew();
        while (friend == CSteamID.Nil && waitStart.Elapsed.TotalHours < 2)
        {
            friend = Friends.PlayingSpike(me);
            if (friend == CSteamID.Nil) net.Pump(() => false, 2);
        }
        if (friend == CSteamID.Nil) { log.Line("2 小时内没等到对方，结束。"); return false; }
        log.Line($"看到好友 {SteamFriends.GetFriendPersonaName(friend)}（{friend}）打开了实验程序，发邀请。");

        var entered = false;
        using var chatUpdate = Callback<LobbyChatUpdate_t>.Create(u =>
        {
            if (u.m_ulSteamIDUserChanged == friend.m_SteamID && (u.m_rgfChatMemberStateChange & (uint)EChatMemberStateChange.k_EChatMemberStateChangeEntered) != 0) entered = true;
        });
        var invited = Stopwatch.StartNew();
        log.Check("邀请发出", SteamMatchmaking.InviteUserToLobby(lobby, friend), "InviteUserToLobby 返回");
        log.Check("对方收到邀请并进房", net.Pump(() => entered, 60), $"{invited.ElapsedMilliseconds} 毫秒（邀请到进房）");
        if (!entered) return false;
        log.Line($"房间人数 {SteamMatchmaking.GetNumLobbyMembers(lobby)}/{SteamMatchmaking.GetLobbyMemberLimit(lobby)}，所有者 {SteamMatchmaking.GetLobbyOwner(lobby)}");

        // 3. 房间数据：对方进房后读到的快照，用消息报回来
        var hello = net.Expect(friend, "HELLO", 20);
        log.Check("房间数据进房就能读到", hello == "moyu-spike|spike-1|1|Lure", $"对方读到 marker|ver|epoch|房主模式 = {hello ?? "（没收到）"}");

        // 4. 成员数据：对方改自己的模式，这边等数据更新
        var memberSeen = Stopwatch.StartNew();
        net.Send(friend, "SETMODE");
        var mode = "";
        log.Check("成员数据同步", net.Pump(() => (mode = SteamMatchmaking.GetLobbyMemberData(lobby, friend, "mode")) == "Wade", 20), $"读到对方模式 {mode}，{memberSeen.ElapsedMilliseconds} 毫秒");
        log.Check("别人不能改房间数据、只能读", SteamMatchmaking.GetLobbyData(lobby, "touched") == "", "对方试写的 touched 键（应为空）");

        // 5. 可靠消息往返 30 次
        var rtts = new List<double>();
        for (var i = 0; i < 30; i++)
        {
            var sent = Stopwatch.GetTimestamp();
            net.Send(friend, $"PING|{i}");
            if (net.Expect(friend, $"PONG|{i}", 10) != null) rtts.Add(Stopwatch.GetElapsedTime(sent).TotalMilliseconds);
            net.Pump(() => false, 0.1);
        }
        rtts.Sort();
        log.Check("可靠消息往返", rtts.Count == 30,
            rtts.Count == 0 ? "一次都没回来" : $"收回 {rtts.Count}/30，最短 {rtts[0]:0} 中位 {rtts[rtts.Count / 2]:0} 最长 {rtts[^1]:0} 毫秒");

        // 6. 不可靠消息：1 秒内连发 100 条
        for (var i = 0; i < 100; i++) { net.Send(friend, $"BURST|{i}", reliable: false); net.Pump(() => false, 0.01); }
        net.Send(friend, "BURSTEND");
        var burst = net.Expect(friend, "BURSTGOT", 20);
        log.Check("不可靠消息连发（1 秒 100 条）", burst != null, $"对方收到 {burst ?? "（没回）"}/100");

        // 7. 房间数据连续改：每 100 毫秒改一次，共 20 次
        for (var i = 1; i <= 20; i++) { SteamMatchmaking.SetLobbyData(lobby, "tick", i.ToString()); net.Pump(() => false, 0.1); }
        net.Pump(() => false, 2);
        net.Send(friend, "TICKEND");
        var tick = net.Expect(friend, "TICKGOT", 20);
        log.Check("房间数据连续改（2 秒 20 次）", tick != null && tick.EndsWith("|20"), $"对方收到的更新次数|最后的值 = {tick ?? "（没回）"}（中间的被合并不要紧，最后的值要对）");

        // 8. 房间聊天消息：连发 10 条
        for (var i = 0; i < 10; i++) { var b = Encoding.UTF8.GetBytes($"chat {i}"); SteamMatchmaking.SendLobbyChatMsg(lobby, b, b.Length); }
        net.Pump(() => false, 2);
        net.Send(friend, "CHATEND");
        var chat = net.Expect(friend, "CHATGOT", 20);
        log.Check("房间聊天消息（连发 10 条）", chat == "10", $"对方收到 {chat ?? "（没回）"}/10");

        // 9. 房主退出：Steam 换所有者
        net.Send(friend, "LEAVING");
        net.Pump(() => false, 1);
        SteamMatchmaking.LeaveLobby(lobby);
        log.Line("房主已退出房间，等 5 秒让对方接手……");
        net.Pump(() => false, 5);

        // 10. 旧房主重新进房：应是普通成员，房间数据是新房主写的
        var back = Lobby.Enter(log, lobby);
        if (!back) return false;
        net.Pump(() => SteamMatchmaking.GetLobbyData(lobby, "report") != "", 20);
        var owner = SteamMatchmaking.GetLobbyOwner(lobby);
        log.Check("换房主：对方成了房间所有者", owner == friend, $"所有者 {owner}");
        log.Check("新房主写了新代次", SteamMatchmaking.GetLobbyData(lobby, "epoch") == "2", $"epoch = {SteamMatchmaking.GetLobbyData(lobby, "epoch")}");
        log.Check("旧房主回来是普通成员、不能写房间数据", !SteamMatchmaking.SetLobbyData(lobby, "epoch", "99") && owner != me, "SetLobbyData 应返回 false");
        log.Line("对方看到的换房主过程：" + SteamMatchmaking.GetLobbyData(lobby, "report"));

        net.Send(friend, "DONE");
        net.Pump(() => false, 2);
        SteamMatchmaking.LeaveLobby(lobby);
        return log.Failed == 0;
    }
}

static class Join
{
    public static bool Run(Log log, Net net, CSteamID me)
    {
        log.Line("等房主发来邀请（最多等 2 小时，不用操作，窗口别关）……");
        CSteamID lobby = CSteamID.Nil, inviter = CSteamID.Nil;
        using var invite = Callback<LobbyInvite_t>.Create(i =>
        {
            if (lobby != CSteamID.Nil || i.m_ulGameID != 480) return;
            lobby = new CSteamID(i.m_ulSteamIDLobby);
            inviter = new CSteamID(i.m_ulSteamIDUser);
        });
        if (!net.Pump(() => lobby != CSteamID.Nil, 7200)) { log.Line("没等到邀请，结束。"); return false; }
        log.Line($"收到 {SteamFriends.GetFriendPersonaName(inviter)} 的邀请，进房。");
        if (!Lobby.Enter(log, lobby)) return false;

        var host = SteamMatchmaking.GetLobbyOwner(lobby);
        string D(string k) => SteamMatchmaking.GetLobbyData(lobby, k);
        net.Send(host, $"HELLO|{D("marker")}|{D("ver")}|{D("epoch")}|{SteamMatchmaking.GetLobbyMemberData(lobby, host, "mode")}");
        log.Line($"进房时读到房间数据 marker={D("marker")} ver={D("ver")} epoch={D("epoch")}");

        int burst = 0, tickUpdates = 0, chats = 0;
        var report = new StringBuilder();
        Stopwatch? leaving = null;
        bool done = false, migrated = false, tookOver = false;
        using var data = Callback<LobbyDataUpdate_t>.Create(u =>
        {
            if (u.m_ulSteamIDLobby == lobby.m_SteamID && u.m_ulSteamIDMember == lobby.m_SteamID && D("tick") != "") tickUpdates++;
        });
        using var chat = Callback<LobbyChatMsg_t>.Create(c => { if (c.m_ulSteamIDLobby == lobby.m_SteamID) chats++; });
        using var members = Callback<LobbyChatUpdate_t>.Create(u =>
        {
            if (u.m_ulSteamIDLobby != lobby.m_SteamID || u.m_ulSteamIDUserChanged != host.m_SteamID) return;
            var state = (EChatMemberStateChange)u.m_rgfChatMemberStateChange;
            if (migrated && (state & EChatMemberStateChange.k_EChatMemberStateChangeEntered) != 0)
            {
                log.Line($"旧房主重新进房，所有者仍是 {SteamMatchmaking.GetLobbyOwner(lobby)}（应是自己 {me}）");
                return;
            }
            if ((state & (EChatMemberStateChange.k_EChatMemberStateChangeLeft | EChatMemberStateChange.k_EChatMemberStateChangeDisconnected)) == 0) return;
            var owner = SteamMatchmaking.GetLobbyOwner(lobby);
            var line = $"房主离开通知在说要走后 {leaving?.ElapsedMilliseconds ?? -1} 毫秒到达（{state}），这时所有者 = {(owner == me ? "自己" : owner.ToString())}";
            log.Line(line);
            report.Append(line);
            migrated = true;
        });

        net.OnMessage = (from, text) =>
        {
            var p = text.Split('|');
            switch (p[0])
            {
                case "SETMODE":
                    SteamMatchmaking.SetLobbyMemberData(lobby, "mode", "Wade");
                    var wrote = SteamMatchmaking.SetLobbyData(lobby, "touched", "1"); // 不是所有者，应该写不进去
                    log.Line($"改了自己的成员数据 mode=Wade；试写房间数据 {(wrote ? "成功（不对）" : "被拒（对）")}");
                    break;
                case "PING": net.Send(from, $"PONG|{p[1]}"); break;
                case "BURST": burst++; break;
                case "BURSTEND": net.Send(from, $"BURSTGOT|{burst}"); log.Line($"不可靠连发收到 {burst}/100"); break;
                case "TICKEND": net.Send(from, $"TICKGOT|{tickUpdates}|{D("tick")}"); log.Line($"房间数据 tick 更新 {tickUpdates} 次，最后 {D("tick")}"); break;
                case "CHATEND": net.Send(from, $"CHATGOT|{chats}"); log.Line($"房间聊天收到 {chats}/10"); break;
                case "LEAVING": leaving = Stopwatch.StartNew(); log.Line("房主说要退出了"); break;
                case "DONE": done = true; break;
            }
        };

        var finished = net.Pump(() =>
        {
            if (migrated && !tookOver && SteamMatchmaking.GetLobbyOwner(lobby) == me)
            {
                tookOver = true;
                var ok = SteamMatchmaking.SetLobbyData(lobby, "epoch", "2");
                var line = $"；{leaving?.ElapsedMilliseconds ?? -1} 毫秒时确认自己是新所有者，写新代次 {(ok ? "成功" : "失败")}";
                log.Line(line.TrimStart('；'));
                report.Append(line);
                SteamMatchmaking.SetLobbyData(lobby, "report", report.ToString());
            }
            return done;
        }, 900);
        SteamMatchmaking.LeaveLobby(lobby);
        if (!finished) log.Line("15 分钟内没走完，结束。");
        return finished;
    }
}

static class Lobby
{
    public static CSteamID Create(Log log)
    {
        CSteamID id = CSteamID.Nil;
        var done = false;
        using var r = CallResult<LobbyCreated_t>.Create((c, failed) =>
        {
            done = true;
            if (!failed && c.m_eResult == EResult.k_EResultOK) id = new CSteamID(c.m_ulSteamIDLobby);
            else log.Line($"建房失败：{c.m_eResult}");
        });
        r.Set(SteamMatchmaking.CreateLobby(ELobbyType.k_ELobbyTypeFriendsOnly, 4));
        Net.PumpStatic(() => done, 30);
        log.Check("建仅好友房间（4 人）", id != CSteamID.Nil, id.ToString());
        return id;
    }

    public static bool Enter(Log log, CSteamID lobby)
    {
        var ok = false;
        var done = false;
        var sw = Stopwatch.StartNew();
        using var r = CallResult<LobbyEnter_t>.Create((e, failed) =>
        {
            done = true;
            ok = !failed && e.m_EChatRoomEnterResponse == (uint)EChatRoomEnterResponse.k_EChatRoomEnterResponseSuccess;
            if (!ok) log.Line($"进房失败：{(EChatRoomEnterResponse)e.m_EChatRoomEnterResponse}");
        });
        r.Set(SteamMatchmaking.JoinLobby(lobby));
        Net.PumpStatic(() => done, 30);
        log.Check("进房", ok, $"{sw.ElapsedMilliseconds} 毫秒");
        return ok;
    }
}

static class Friends
{
    /// <summary>好友里正在玩 480 的（就是打开了本程序的那位），只认这一位，不碰别的好友。</summary>
    public static CSteamID PlayingSpike(CSteamID me)
    {
        var n = SteamFriends.GetFriendCount(EFriendFlags.k_EFriendFlagImmediate);
        for (var i = 0; i < n; i++)
        {
            var f = SteamFriends.GetFriendByIndex(i, EFriendFlags.k_EFriendFlagImmediate);
            if (SteamFriends.GetFriendGamePlayed(f, out var g) && g.m_gameID.AppID() == new AppId_t(480)) return f;
        }
        return CSteamID.Nil;
    }
}

/// <summary>Steam 网络消息（经中继，按对方 SteamID 发），文本协议。</summary>
sealed class Net
{
    readonly Log _log;
    readonly List<(CSteamID From, string Text)> _inbox = new();
    readonly Callback<SteamNetworkingMessagesSessionRequest_t> _accept;
    public Action<CSteamID, string>? OnMessage;

    public Net(Log log)
    {
        _log = log;
        _accept = Callback<SteamNetworkingMessagesSessionRequest_t>.Create(r =>
        {
            var id = r.m_identityRemote;
            SteamNetworkingMessages.AcceptSessionWithUser(ref id);
        });
    }

    public void Send(CSteamID to, string text, bool reliable = true)
    {
        var id = new SteamNetworkingIdentity();
        id.SetSteamID(to);
        var bytes = Encoding.UTF8.GetBytes(text);
        var h = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            var flags = (reliable ? Constants.k_nSteamNetworkingSend_Reliable : Constants.k_nSteamNetworkingSend_Unreliable) | Constants.k_nSteamNetworkingSend_AutoRestartBrokenSession;
            var r = SteamNetworkingMessages.SendMessageToUser(ref id, h.AddrOfPinnedObject(), (uint)bytes.Length, flags, 0);
            if (r != EResult.k_EResultOK) _log.Line($"发送 {text} 失败：{r}");
        }
        finally { h.Free(); }
    }

    void Receive()
    {
        var ptrs = new IntPtr[32];
        int n;
        while ((n = SteamNetworkingMessages.ReceiveMessagesOnChannel(0, ptrs, ptrs.Length)) > 0)
            for (var i = 0; i < n; i++)
            {
                var m = SteamNetworkingMessage_t.FromIntPtr(ptrs[i]);
                var data = new byte[m.m_cbSize];
                Marshal.Copy(m.m_pData, data, 0, data.Length);
                var from = m.m_identityPeer.GetSteamID();
                SteamNetworkingMessage_t.Release(ptrs[i]);
                var text = Encoding.UTF8.GetString(data);
                if (OnMessage != null) OnMessage(from, text); else _inbox.Add((from, text));
            }
    }

    /// <summary>跑回调、收消息，直到 done 或超时（秒）。</summary>
    public bool Pump(Func<bool> done, double seconds)
    {
        var sw = Stopwatch.StartNew();
        while (true)
        {
            SteamAPI.RunCallbacks();
            Receive();
            if (done()) return true;
            if (sw.Elapsed.TotalSeconds >= seconds) return false;
            Thread.Sleep(5);
        }
    }

    public static bool PumpStatic(Func<bool> done, double seconds)
    {
        var sw = Stopwatch.StartNew();
        while (!done()) { SteamAPI.RunCallbacks(); if (sw.Elapsed.TotalSeconds >= seconds) return false; Thread.Sleep(5); }
        return true;
    }

    /// <summary>等对方发来以 prefix 开头的消息，返回 prefix 后面的部分（没有就是空串）；超时返回 null。</summary>
    public string? Expect(CSteamID from, string prefix, double seconds)
    {
        string? got = null;
        Pump(() =>
        {
            var i = _inbox.FindIndex(m => m.From == from && (m.Text == prefix || m.Text.StartsWith(prefix + "|")));
            if (i < 0) return false;
            var t = _inbox[i].Text;
            _inbox.RemoveRange(0, i + 1);
            got = t.Length > prefix.Length ? t[(prefix.Length + 1)..] : "";
            return true;
        }, seconds);
        return got;
    }
}

sealed class Log
{
    readonly StreamWriter _file;
    public string Path { get; }
    public int Failed { get; private set; }

    public Log(string role)
    {
        Path = System.IO.Path.Combine(AppContext.BaseDirectory, $"steam-spike-{role}-{DateTime.Now:yyyyMMdd-HHmmss}.txt");
        _file = new StreamWriter(Path, false, new UTF8Encoding(true)) { AutoFlush = true };
    }

    public void Line(string s)
    {
        var l = $"{DateTime.Now:HH:mm:ss.fff} {s}";
        Console.WriteLine(l);
        _file.WriteLine(l);
    }

    public void Check(string name, bool ok, string detail)
    {
        if (!ok) Failed++;
        Line($"{(ok ? "【通过】" : "【没过】")} {name} — {detail}");
    }

    public void End(bool ok)
    {
        Line(ok ? "实验完成。" : "实验没有走完。");
        Line($"结果已保存：{Path}");
        _file.Dispose();
        if (!Console.IsInputRedirected) { Console.WriteLine("按回车键关闭窗口。"); Console.ReadLine(); }
    }
}
