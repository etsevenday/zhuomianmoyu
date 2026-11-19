using System.Text.Json;
using Microsoft.JSInterop;
using Moyu.Core.Play;
using Moyu.Core.Rooms;
using Moyu.Core.Scene;

namespace Moyu.Web.Services;

/// <summary>好友列表的一行（Q27）：Playing 为正在玩本游戏；"已在房间里"看本房成员（TXT-ROOM-066—069）。</summary>
public sealed record NetFriend(string Id, string Name, bool Playing);

/// <summary>
/// 联机房间：页面经 js/net.js 连房间服务，规则全在 Moyu.Core.Rooms.RoomLink（房主权威、请求、快照、换房主）。
/// PC 连外壳里的 Steam 小程序（B10）；网页只有带 ?net=本机地址时连本机回环（B9，验收脚本用），否则这里什么都不做，仍是 B3 的模拟房间。
/// </summary>
public sealed partial class PetSession
{
    private const int ActEveryMs = 1000;

    /// <summary>这一页打开了联机（PC，或网页带了本机回环地址）。</summary>
    public bool NetEnabled { get; private set; }
    /// <summary>Steam 没开或没登录（小程序报的）：房间入口说明 TXT-ROOM-065，单机照常（Q26）。</summary>
    public bool NetSteamDown { get; private set; }
    public bool NetConnected { get; private set; }
    /// <summary>好友列表；null 为还没读到（显示"正在处理"，不冒充没有好友）。</summary>
    public IReadOnlyList<NetFriend>? NetFriends { get; private set; }
    /// <summary>房间页上的一行联机状态：正在创建、等待好友、正在加入、已加入、各种失败。</summary>
    public string? NetStatus { get; private set; }
    public bool NetBusy { get; private set; }
    public RoomLink? Link { get; private set; }

    private string _netName = "";
    private string _netVer = "";
    private string? _netSelf;
    private string? _netLobby;
    private string _lastProfile = "";
    private long _lastActSent;
    private bool _netRejoining;
    private TaskCompletionSource<bool>? _hello;
    private object? _netRef;
    private Timer? _netTimer;

    public string SelfId => Link?.SelfId ?? SimSelfId;

    /// <summary>页面加载后调一次：带了本机回环地址就连上去。</summary>
    public async Task NetInitAsync(object dotnetRef)
    {
        var json = await _js.InvokeAsync<string?>("moyuNet.config");
        if (json == null) return;
        var c = JsonDocument.Parse(json).RootElement;
        NetEnabled = true;
        _netRef = dotnetRef;
        _netName = c.GetProperty("name").GetString() ?? "me";
        _netVer = c.GetProperty("ver").GetString() ?? "";
        await NetConnectAsync();
        _netTimer = new Timer(_ => _ = NetTickAsync(), null, 1000, 1000);
    }

    private async Task NetConnectAsync()
    {
        var cfg = JsonDocument.Parse(await _js.InvokeAsync<string>("moyuNet.config")).RootElement;
        _hello = new TaskCompletionSource<bool>();
        var relay = cfg.TryGetProperty("relay", out var r) ? r.GetString() : null;
        await _js.InvokeVoidAsync("moyuNet.start", _netRef, relay, _netName);
    }

    /// <summary>房间服务推来一件事。</summary>
    public async Task OnNetAsync(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var e = doc.RootElement;
        string S(string k) => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
        switch (S("type"))
        {
            case "steam":
                NetSteamDown = !e.GetProperty("ready").GetBoolean();
                break;
            case "hello":
                _netSelf = S("self");
                if (S("name") != "") _netName = S("name"); // PC 用 Steam 名字
                NetSteamDown = false;
                NetConnected = true;
                _hello?.TrySetResult(true);
                break;
            case "friends":
                NetFriends = e.GetProperty("list").EnumerateArray()
                    .Select(f => new NetFriend(f.GetProperty("id").GetString()!, f.GetProperty("name").GetString()!, f.GetProperty("playing").GetBoolean())).ToList();
                break;
            case "entered":
                _netLobby = S("lobby");
                NetBusy = false;
                var profiles = e.GetProperty("memberData").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!);
                Link?.Entered(S("owner"), e.GetProperty("members").EnumerateArray().Select(m => m.GetString()!).ToList(),
                    e.TryGetProperty("ver", out var ver) && ver.ValueKind == JsonValueKind.String ? ver.GetString() : null,
                    e.TryGetProperty("room", out var room) && room.ValueKind == JsonValueKind.String ? room.GetString() : null,
                    profiles, Pet.State.MapId, Pet.State.Spot);
                break;
            case "enterFailed":
                NetEnterFailed(S("reason"));
                break;
            case "memberJoined": Link?.MemberJoined(S("id")); break;
            case "memberLeft": Link?.MemberLeft(S("id"), e.GetProperty("dropped").GetBoolean()); break;
            case "ownerChanged": Link?.OwnerChanged(S("owner")); break;
            case "lobbyData": if (S("key") == "room") Link?.LobbyData(S("text")); break;
            case "memberData": Link?.MemberData(S("id"), S("text")); break;
            case "message": Link?.Message(S("from"), S("text")); break;
            case "inviteSent":
                NetStatus = Texts.NetInviteSent;
                Say(Texts.NetInviteSent);
                break;
            case "joinRequested":
                // 玩家在 Steam 里点了"接受邀请"（回环里由脚本代点）
                await NetJoinAsync(S("lobby"));
                return;
            case "disconnected":
                NetDisconnected();
                break;
        }
        await NetProcessAsync();
    }

    // ---- 本人操作 ----

    public async Task NetCreateAsync()
    {
        if (!NetConnected || Room != null || NetBusy) return;
        ResetRoom();
        NewLink();
        NetBusy = true;
        NetStatus = Texts.NetCreating;
        Notify();
        await NetCmdAsync(new { op = "create" });
    }

    public async Task NetInviteAsync(string friendId)
    {
        if (Room == null || Room.Find(friendId) != null) return;
        await NetCmdAsync(new { op = "invite", to = friendId });
    }

    private async Task NetJoinAsync(string lobby)
    {
        if (!NetConnected || Room != null || NetBusy) return;
        ResetRoom();
        NewLink();
        NetBusy = true;
        NetStatus = Texts.NetJoining;
        Say(Texts.NetJoining);
        await NetCmdAsync(new { op = "join", lobby });
    }

    /// <summary>本人掉线或迁移失败后点"重新加入"：没连着先重连，再进原来那间（TXT-ROOM-036）。</summary>
    private async Task NetRejoinAsync()
    {
        if (_netLobby == null || Rejoining) return;
        Rejoining = true;
        _netRejoining = true;
        CanRejoin = false;
        RoomStatus = Texts.RoomRejoining;
        Notify();
        if (!NetConnected)
        {
            await NetConnectAsync();
            await Task.WhenAny(_hello!.Task, Task.Delay(5000));
        }
        Rejoining = false;
        if (!NetConnected)
        {
            NetRejoinFailed(Texts.RoomRejoinFailed);
            return;
        }
        await NetJoinAsync(_netLobby);
    }

    // ---- 内部 ----

    private void NewLink()
    {
        _lastProfile = "";
        Link = new RoomLink(Pet.Maps, _netSelf!, _netVer, SelfProfile(), () => Now, Guid.NewGuid().ToString("N")[..8]);
    }

    private void NetEnterFailed(string reason)
    {
        NetBusy = false;
        Link = null;
        var text = reason switch { "full" => Texts.RoomFull, "gone" => Texts.NetInviteGone, "create" => Texts.NetCreateFailed, _ => Texts.NetJoinFailed };
        if (_netRejoining)
        {
            NetRejoinFailed(reason == "gone" ? Texts.NetRoomGone : text);
            return;
        }
        NetStatus = text;
        Say(text);
    }

    private void NetRejoinFailed(string text)
    {
        _netRejoining = false;
        RoomStatus = Texts.RoomRejoinFailed;
        NetStatus = text;
        Say(text);
    }

    /// <summary>本人和服务断了：房里的人会按掉线处理（Q19）；本人回单机、留重新加入（TXT-ROOM-035）。</summary>
    private void NetDisconnected()
    {
        NetConnected = false;
        NetBusy = false;
        if (Link?.Room == null)
        {
            Link = null;
            return;
        }
        Link = null;
        NetStatus = null;
        ToSolo(Texts.RoomSelfDropped, true);
    }

    /// <summary>把 RoomLink 攒下的命令交给服务、结果变成提示和画面。</summary>
    private async Task NetProcessAsync()
    {
        var link = Link;
        if (link == null)
        {
            Notify();
            return;
        }
        var cmds = link.Out.ToList();
        link.Out.Clear();
        var notes = link.Notes.ToList();
        link.Notes.Clear();
        foreach (var c in cmds)
        {
            object cmd = c.Op switch
            {
                LinkOp.SetLobbyData => new { op = "setLobbyData", key = c.Key, text = c.Text },
                LinkOp.SetMemberData => new { op = "setMemberData", text = c.Text },
                LinkOp.Send => new { op = "send", to = c.Key, text = c.Text },
                LinkOp.Broadcast => new { op = "broadcast", text = c.Text },
                _ => new { op = "leave" },
            };
            await NetCmdAsync(cmd);
        }
        foreach (var n in notes) await NetNoteAsync(link, n);
        if (Link == link)
        {
            Room = link.Room;
            // 房主切了图：成员跟过去并提示一句（TXT-ROOM-021）
            if (Room != null && SelfMember != null)
            {
                if (link.IsHost) SyncSelf();
                else FollowRoomMap();
            }
        }
        Notify();
    }

    private async Task NetNoteAsync(RoomLink link, LinkNote n)
    {
        switch (n.Kind)
        {
            case LinkNoteKind.Joined:
                Room = link.Room;
                RoomStatus = null;
                _netRejoining = false;
                NetStatus = link.IsHost ? Texts.NetWaiting : Texts.NetJoined;
                if (!link.IsHost)
                {
                    Say(Texts.NetJoined);
                    FollowRoomMap();
                }
                break;
            case LinkNoteKind.MemberGone:
                Forget(n.MemberId!);
                Say(Texts.RoomMemberGone(n.Name));
                break;
            case LinkNoteKind.Rejoined:
                Say(Texts.RoomRejoined(n.Name));
                break;
            case LinkNoteKind.Migrating:
                if (n.MemberId != null) Forget(n.MemberId);
                Say(Texts.RoomMigrating);
                break;
            case LinkNoteKind.NewHost:
                Say(Texts.RoomNewHost(n.Name));
                break;
            case LinkNoteKind.MigrationFailed:
                Link = null;
                ToSolo(Texts.RoomMigrationFailed, true);
                break;
            case LinkNoteKind.VersionMismatch:
                Link = null;
                NetBusy = false;
                if (_netRejoining) NetRejoinFailed(Texts.NetVersionMismatch);
                else
                {
                    NetStatus = Texts.NetVersionMismatch;
                    Say(Texts.NetVersionMismatch);
                }
                break;
            case LinkNoteKind.SelfRemoved:
                Link = null;
                ToSolo(Texts.RoomSelfDropped, true);
                break;
            case LinkNoteKind.PlaceResult:
                if (n.Place == PlaceResult.NoRoom) ShowNoRoom(n.Point);
                else if (n.Place == PlaceResult.Placed) NoRoomAt = null;
                break;
            case LinkNoteKind.FriendCatch:
                if (link.Room?.Find(n.MemberId!) is { } m) await ShowFriendCatchAsync(m, n.SpeciesId, n.LengthMm);
                break;
            case LinkNoteKind.FriendAct:
                if (!Pet.State.Collapsed && !Pet.State.Closed) await _js.InvokeVoidAsync("moyuPlay.friendAct", n.MemberId);
                break;
        }
    }

    private async Task NetCmdAsync(object cmd)
    {
        if (!NetConnected) return;
        await _js.InvokeVoidAsync("moyuNet.cmd", JsonSerializer.Serialize(cmd));
    }

    /// <summary>每秒：迁移超时检查；本人资料（外观、主题、背景缸）变了就重写成员数据。</summary>
    private async Task NetTickAsync()
    {
        if (Link == null) return;
        Link.Tick();
        if (Link?.Room != null)
        {
            var p = SelfProfile();
            var text = RoomWire.Profile(p);
            if (text != _lastProfile)
            {
                _lastProfile = text;
                Link.UpdateProfile(p);
            }
        }
        await NetProcessAsync();
    }

    /// <summary>本人存好了新鱼：告诉房里的人（只作展示）。</summary>
    private void NetCatches(IEnumerable<FishRecord> fish)
    {
        if (Link?.Room == null) return;
        foreach (var f in fish) Link.Catch(f.SpeciesId, f.LengthMm);
        _ = NetProcessAsync();
    }

    /// <summary>本人有工作输入：每秒最多告诉房里一次"在动"（01 §4.6 合并降噪）。</summary>
    private void NetAct()
    {
        if (Link?.Room == null || Now - _lastActSent < ActEveryMs) return;
        _lastActSent = Now;
        Link.Act();
        _ = NetProcessAsync();
    }

    private MemberProfile SelfProfile() => new()
    {
        Name = _netName,
        Mode = Pet.State.Mode,
        Character = Play?.EquippedId(SkinCategory.Character) ?? "BASE_CHAR",
        Rod = Play?.EquippedId(SkinCategory.Rod) ?? "BASE_ROD",
        Glove = Play?.EquippedId(SkinCategory.Glove) ?? "BASE_GLOVE",
        SceneSkin = Play?.EquippedId(SkinCategory.Scene) ?? "BASE_SCENE",
        Tank = OwnTank(),
    };
}
