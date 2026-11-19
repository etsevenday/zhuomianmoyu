// PC 联机的 Steam 小程序（B10）：外壳启动时起它，一行一个 JSON，标准输入收命令、标准输出报事件。
// 事件和 B9 本机回环服务（tools/verify/relay.mjs）同一种，页面不管背后是谁：
//   steam {ready}            Steam 就绪没有（没开、没登录都算没就绪，过一会儿再试；页面据此显示 TXT-ROOM-065）
//   hello {self, name}       就绪了：本人的 SteamID 和 Steam 名字
//   friends {list}           在线好友（Q27）
//   entered / enterFailed / memberJoined / memberLeft / ownerChanged / lobbyData / memberData / message
//   inviteSent / inviteFailed {to}、joinRequested {lobby}（玩家在 Steam 里接受了邀请，或带 +connect_lobby 启动）
// 命令：create、join {lobby}、leave、setLobbyData {key, text}、setMemberData {text}、send {to, text}、broadcast {text}、
//   invite {to}、joinRequest {lobby}（外壳转来的 +connect_lobby）。
// Steam 跑着跑着断了（被关掉、退出登录）就以退出码 3 结束，外壳报"断了"并重新拉起本程序，从等就绪重来。
// 哪些变化要报（进出、所有者、房间数据、成员资料、好友状态）由内核 LobbyTracker 整理，这里只调 Steam。
//
// 参数：--connect <房间号>  就绪后报一次 joinRequested（外壳从 +connect_lobby 转来）
//       --relay <地址> --name <名字>  测试用回环模式：不碰 Steam，连 B9 的回环服务（外壳只在测试模式下给）
// 环境变量：MOYU_NET_RETRY_MS  没就绪时多久再试一次，默认 3000
using System.Collections.Concurrent;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Moyu.Core.Rooms;
using Steamworks;

Console.OutputEncoding = new UTF8Encoding(false);
Console.InputEncoding = new UTF8Encoding(false);
var io = new Io();
string? Arg(string name) { var i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
var connect = Arg("--connect");
var relay = Arg("--relay");
var retryMs = int.TryParse(Environment.GetEnvironmentVariable("MOYU_NET_RETRY_MS"), out var r) ? r : 3000;
return relay != null
    ? await RelayMode.Run(io, relay, Arg("--name") ?? "me", connect, retryMs)
    : SteamMode.Run(io, connect, retryMs);

/// <summary>标准输入、输出：命令进队列，事件一行一个 JSON。外壳关掉输入（退出）时 Closed。</summary>
sealed class Io
{
    private readonly object _lock = new();
    public BlockingCollection<JsonElement> Commands { get; } = new();
    public bool Closed => Commands.IsAddingCompleted;
    private readonly CancellationTokenSource _gone = new();
    /// <summary>外壳关掉输入时取消：回环模式里正等着读事件流，靠它脱身。</summary>
    public CancellationToken Gone => _gone.Token;

    public Io()
    {
        new Thread(() =>
        {
            string? line;
            while ((line = Console.In.ReadLine()) != null)
            {
                try { Commands.Add(JsonDocument.Parse(line).RootElement.Clone()); } catch (JsonException) { }
            }
            Commands.CompleteAdding();
            _gone.Cancel();
        }) { IsBackground = true }.Start();
    }

    public void Emit(object ev) => Raw(JsonSerializer.Serialize(ev));

    /// <summary>已经是事件 JSON 的一行（回环模式原样转）。</summary>
    public void Raw(string line)
    {
        lock (_lock)
        {
            Console.Out.Write(line + "\n");
            Console.Out.Flush();
        }
    }

    /// <summary>内核整理出来的事件，按回环服务的字段名写出去。</summary>
    public void Emit(LobbyEvent e) => Emit(e.Type switch
    {
        "entered" => new { type = e.Type, lobby = e.Lobby, owner = e.Owner, members = e.Members, ver = e.Ver, room = e.Room, memberData = e.MemberData },
        "enterFailed" => new { type = e.Type, reason = e.Reason },
        "memberJoined" => new { type = e.Type, id = e.Id },
        "memberLeft" => new { type = e.Type, id = e.Id, dropped = e.Dropped },
        "ownerChanged" => new { type = e.Type, owner = e.Owner },
        "lobbyData" => new { type = e.Type, key = e.Key, text = e.Text },
        "memberData" => new { type = e.Type, id = e.Id, text = e.Text },
        _ => (object)new { type = e.Type, list = e.Friends!.Select(f => new { id = f.Id, name = f.Name, playing = f.Playing }) },
    });

    public void Flush(LobbyTracker t)
    {
        foreach (var e in t.Out) Emit(e);
        t.Out.Clear();
    }

    public static string S(JsonElement c, string key) => c.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
}

static class SteamMode
{
    /// <summary>开发阶段用 Steam 的公用测试 ID；换正式 App ID 时改这里（NET-EVAL-001 §6 第 4 步）。从 Steam 里启动时 Steam 自己会给。</summary>
    private const string DevAppId = "480";

    public static int Run(Io io, string? connect, int retryMs)
    {
        if (Environment.GetEnvironmentVariable("SteamAppId") == null)
        {
            Environment.SetEnvironmentVariable("SteamAppId", DevAppId);
            Environment.SetEnvironmentVariable("SteamGameId", DevAppId);
        }
        bool? ready = null;
        void Ready(bool on)
        {
            if (ready == on) return;
            ready = on;
            io.Emit(new { type = "steam", ready = on });
        }
        // 等 Steam 就绪：没开、没登录都算没就绪，命令一律不理（页面这时不给按）
        var inited = false;
        while (true)
        {
            if (io.Closed) return 0;
            while (io.Commands.TryTake(out _)) { }
            if (!inited)
            {
                try { inited = SteamAPI.Init(); }
                catch (Exception e) when (e is DllNotFoundException || e is BadImageFormatException) { Console.Error.WriteLine(e.Message); }
            }
            if (inited)
            {
                SteamAPI.RunCallbacks();
                if (!SteamAPI.IsSteamRunning()) return 3;
                if (SteamUser.BLoggedOn()) break;
            }
            Ready(false);
            Thread.Sleep(inited ? 500 : retryMs);
        }
        Ready(true);
        var code = new SteamSession(io, connect).Run();
        SteamAPI.Shutdown();
        return code;
    }
}

/// <summary>Steam 就绪以后：房间、好友、网络消息。</summary>
sealed class SteamSession
{
    private const string Marker = "moyu";
    private readonly Io _io;
    private readonly LobbyTracker _tracker;
    private readonly CSteamID _me;
    private readonly HashSet<ulong> _presenceAsked = new();
    private readonly List<IDisposable> _hooks = new();
    private readonly CallResult<LobbyCreated_t> _created;
    private readonly CallResult<LobbyEnter_t> _joined;
    private string? _connect;
    private CSteamID _lobby = CSteamID.Nil;
    private bool _friendsDirty = true;

    public SteamSession(Io io, string? connect)
    {
        _io = io;
        _connect = connect;
        _me = SteamUser.GetSteamID();
        _tracker = new LobbyTracker(_me.ToString());
        _created = CallResult<LobbyCreated_t>.Create((c, failed) =>
        {
            if (failed || c.m_eResult != EResult.k_EResultOK) Fail("create");
        });
        _joined = CallResult<LobbyEnter_t>.Create((e, failed) =>
        {
            if (failed) Fail("failed");
            else OnEnter(e);
        });
        _hooks.Add(Callback<LobbyEnter_t>.Create(OnEnter));
        _hooks.Add(Callback<LobbyChatUpdate_t>.Create(u =>
        {
            if (u.m_ulSteamIDLobby != _lobby.m_SteamID) return;
            var state = (EChatMemberStateChange)u.m_rgfChatMemberStateChange;
            var change = (state & EChatMemberStateChange.k_EChatMemberStateChangeEntered) != 0 ? LobbyChange.Entered
                : (state & EChatMemberStateChange.k_EChatMemberStateChangeLeft) != 0 ? LobbyChange.Left
                : LobbyChange.Dropped; // 掉线、被踢、被封都按掉线
            _tracker.MemberChanged(_lobby.ToString(), u.m_ulSteamIDUserChanged.ToString(), change);
            Refresh();
        }));
        _hooks.Add(Callback<LobbyDataUpdate_t>.Create(u => { if (u.m_ulSteamIDLobby == _lobby.m_SteamID) Refresh(); }));
        _hooks.Add(Callback<GameLobbyJoinRequested_t>.Create(r => JoinRequested(r.m_steamIDLobby.ToString())));
        _hooks.Add(Callback<PersonaStateChange_t>.Create(_ => _friendsDirty = true));
        _hooks.Add(Callback<FriendRichPresenceUpdate_t>.Create(_ => _friendsDirty = true));
        // 只收同房间的人发来的消息
        _hooks.Add(Callback<SteamNetworkingMessagesSessionRequest_t>.Create(req =>
        {
            var id = req.m_identityRemote;
            if (_lobby != CSteamID.Nil && Members().Contains(id.GetSteamID())) SteamNetworkingMessages.AcceptSessionWithUser(ref id);
        }));
    }

    public int Run()
    {
        SteamFriends.SetRichPresence(Marker, "1");
        SteamNetworkingUtils.InitRelayNetworkAccess();
        _io.Emit(new { type = "hello", self = _me.ToString(), name = SteamFriends.GetPersonaName() });
        Friends();
        if (_connect != null) JoinRequested(_connect);
        var lastFriends = DateTime.UtcNow;
        var lastHealth = DateTime.UtcNow;
        var bad = 0;
        while (true)
        {
            SteamAPI.RunCallbacks();
            Receive();
            while (_io.Commands.TryTake(out var c)) Command(c);
            if (_io.Closed)
            {
                Leave();
                return 0;
            }
            var now = DateTime.UtcNow;
            if (_friendsDirty && (now - lastFriends).TotalSeconds >= 1 || (now - lastFriends).TotalSeconds >= 10)
            {
                lastFriends = now;
                Friends();
            }
            if ((now - lastHealth).TotalSeconds >= 1)
            {
                lastHealth = now;
                bad = SteamAPI.IsSteamRunning() && SteamUser.BLoggedOn() ? 0 : bad + 1;
                if (bad >= 3) return 3; // Steam 断了：外壳报给页面并重新拉起
            }
            Thread.Sleep(10);
        }
    }

    private void Command(JsonElement c)
    {
        string S(string k) => Io.S(c, k);
        switch (S("op"))
        {
            case "create":
                Leave();
                _created.Set(SteamMatchmaking.CreateLobby(ELobbyType.k_ELobbyTypeFriendsOnly, Room.Capacity));
                break;
            case "join":
                Leave();
                if (ulong.TryParse(S("lobby"), out var id)) _joined.Set(SteamMatchmaking.JoinLobby(new CSteamID(id)));
                else Fail("gone");
                break;
            case "leave":
                Leave();
                break;
            case "setLobbyData":
                if (_lobby != CSteamID.Nil) SteamMatchmaking.SetLobbyData(_lobby, S("key"), S("text"));
                break;
            case "setMemberData":
                if (_lobby != CSteamID.Nil) SteamMatchmaking.SetLobbyMemberData(_lobby, "p", S("text"));
                break;
            case "send":
                if (ulong.TryParse(S("to"), out var to)) Send(new CSteamID(to), S("text"));
                break;
            case "broadcast":
                foreach (var m in Members()) if (m != _me) Send(m, S("text"));
                break;
            case "invite":
                var ok = _lobby != CSteamID.Nil && ulong.TryParse(S("to"), out var f) && SteamMatchmaking.InviteUserToLobby(_lobby, new CSteamID(f));
                _io.Emit(new { type = ok ? "inviteSent" : "inviteFailed", to = S("to") });
                break;
            case "joinRequest":
                JoinRequested(S("lobby"));
                break;
        }
    }

    private void JoinRequested(string lobby) => _io.Emit(new { type = "joinRequested", lobby });

    private void Fail(string reason)
    {
        _tracker.EnterFailed(reason);
        _io.Flush(_tracker);
    }

    private void OnEnter(LobbyEnter_t e)
    {
        var id = new CSteamID(e.m_ulSteamIDLobby);
        if (_tracker.Lobby == id.ToString()) return; // 建房、进房的结果 Steam 会报两遍
        var response = (EChatRoomEnterResponse)e.m_EChatRoomEnterResponse;
        if (response != EChatRoomEnterResponse.k_EChatRoomEnterResponseSuccess)
        {
            Fail(response switch
            {
                EChatRoomEnterResponse.k_EChatRoomEnterResponseFull => "full",
                EChatRoomEnterResponse.k_EChatRoomEnterResponseDoesntExist => "gone",
                _ => "failed",
            });
            return;
        }
        _lobby = id;
        var members = Members();
        _tracker.Entered(id.ToString(), SteamMatchmaking.GetLobbyOwner(id).ToString(), members.Select(m => m.ToString()),
            SteamMatchmaking.GetLobbyData(id, "ver"), SteamMatchmaking.GetLobbyData(id, "room"), Profiles(members));
        _io.Flush(_tracker);
    }

    private void Refresh()
    {
        if (_lobby == CSteamID.Nil) return;
        _tracker.Refresh(_lobby.ToString(), SteamMatchmaking.GetLobbyOwner(_lobby).ToString(), SteamMatchmaking.GetLobbyData(_lobby, "room"), Profiles(Members()));
        _io.Flush(_tracker);
    }

    private void Leave()
    {
        if (_lobby == CSteamID.Nil) return;
        SteamMatchmaking.LeaveLobby(_lobby);
        _lobby = CSteamID.Nil;
        _tracker.Left();
    }

    private List<CSteamID> Members()
    {
        var n = SteamMatchmaking.GetNumLobbyMembers(_lobby);
        return Enumerable.Range(0, n).Select(i => SteamMatchmaking.GetLobbyMemberByIndex(_lobby, i)).ToList();
    }

    private Dictionary<string, string> Profiles(IEnumerable<CSteamID> members) =>
        members.ToDictionary(m => m.ToString(), m => SteamMatchmaking.GetLobbyMemberData(_lobby, m, "p"));

    /// <summary>在线好友：正在玩要同一个 App 且带本游戏标记（480 是公用的，光看 App 会把玩 Spacewar 的也算进来）。</summary>
    private void Friends()
    {
        _friendsDirty = false;
        var app = SteamUtils.GetAppID();
        var list = new List<SteamFriend>();
        var n = SteamFriends.GetFriendCount(EFriendFlags.k_EFriendFlagImmediate);
        for (var i = 0; i < n; i++)
        {
            var f = SteamFriends.GetFriendByIndex(i, EFriendFlags.k_EFriendFlagImmediate);
            var online = SteamFriends.GetFriendPersonaState(f) != EPersonaState.k_EPersonaStateOffline;
            var playingApp = SteamFriends.GetFriendGamePlayed(f, out var g) && g.m_gameID.AppID() == app;
            var marker = playingApp && SteamFriends.GetFriendRichPresence(f, Marker) == "1";
            if (playingApp && !marker && _presenceAsked.Add(f.m_SteamID)) SteamFriends.RequestFriendRichPresence(f);
            list.Add(new SteamFriend(f.ToString(), SteamFriends.GetFriendPersonaName(f), online, playingApp, marker));
        }
        _tracker.Friends(list);
        _io.Flush(_tracker);
    }

    private void Send(CSteamID to, string text)
    {
        var id = new SteamNetworkingIdentity();
        id.SetSteamID(to);
        var bytes = Encoding.UTF8.GetBytes(text);
        var h = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            SteamNetworkingMessages.SendMessageToUser(ref id, h.AddrOfPinnedObject(), (uint)bytes.Length,
                Constants.k_nSteamNetworkingSend_Reliable | Constants.k_nSteamNetworkingSend_AutoRestartBrokenSession, 0);
        }
        finally { h.Free(); }
    }

    private void Receive()
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
                _io.Emit(new { type = "message", from = from.ToString(), text = Encoding.UTF8.GetString(data) });
            }
    }
}

/// <summary>
/// 测试用回环模式：不碰 Steam，连 B9 的回环服务（tools/verify/relay.mjs），事件原样转给外壳。
/// 外壳、本程序进程、页面这一整条链因此能在一台电脑上开 4 个外壳自动测（CI 上没有 Steam）。连不上算"Steam 没就绪"，连上后断了退出码 3。
/// </summary>
static class RelayMode
{
    public static async Task<int> Run(Io io, string relay, string name, string? connect, int retryMs)
    {
        using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        string? self = null;
        bool? ready = null;
        var sender = Task.Run(async () =>
        {
            foreach (var c in io.Commands.GetConsumingEnumerable())
            {
                if (Io.S(c, "op") == "joinRequest")
                {
                    io.Emit(new { type = "joinRequested", lobby = Io.S(c, "lobby") });
                    continue;
                }
                if (self == null) continue;
                var body = JsonSerializer.Serialize(MergeUser(c, self));
                try { await http.PostAsync($"{relay}/cmd", new StringContent(body, Encoding.UTF8, "text/plain")); } catch (HttpRequestException) { }
            }
        });
        while (!io.Closed)
        {
            try
            {
                using var resp = await http.GetAsync($"{relay}/events?name={Uri.EscapeDataString(name)}", HttpCompletionOption.ResponseHeadersRead, io.Gone);
                resp.EnsureSuccessStatusCode();
                using var reader = new StreamReader(await resp.Content.ReadAsStreamAsync(io.Gone), Encoding.UTF8);
                string? line;
                while ((line = await reader.ReadLineAsync(io.Gone)) != null)
                {
                    if (!line.StartsWith("data: ")) continue;
                    var json = line[6..];
                    var e = JsonDocument.Parse(json).RootElement;
                    if (Io.S(e, "type") == "hello")
                    {
                        self = Io.S(e, "self");
                        ready = true;
                        io.Emit(new { type = "steam", ready = true });
                        io.Raw(json);
                        if (connect != null) io.Emit(new { type = "joinRequested", lobby = connect });
                        continue;
                    }
                    io.Raw(json);
                }
            }
            catch (HttpRequestException) { }
            catch (IOException) { }
            catch (OperationCanceledException) { break; }
            if (self != null) return 3; // 连上过又断了：等同 Steam 断了
            if (ready != false)
            {
                ready = false;
                io.Emit(new { type = "steam", ready = false });
            }
            try { await Task.Delay(retryMs, io.Gone); } catch (OperationCanceledException) { break; }
        }
        await sender;
        return 0;
    }

    private static Dictionary<string, object?> MergeUser(JsonElement c, string self)
    {
        var d = c.EnumerateObject().ToDictionary(p => p.Name, p => (object?)p.Value);
        d["user"] = self;
        return d;
    }
}
