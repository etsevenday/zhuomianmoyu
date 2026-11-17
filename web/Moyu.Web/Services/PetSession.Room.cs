using Microsoft.JSInterop;
using Moyu.Core.Play;
using Moyu.Core.Rooms;
using Moyu.Core.Scene;

namespace Moyu.Web.Services;

/// <summary>好友收获卡片（同图房间 01 §4.6）：冒在那位好友头上，4 秒消失；卡片还在时又出鱼就合成一张、重新计 4 秒。只作展示。</summary>
public sealed class FriendCard
{
    public string MemberId { get; init; } = "";
    public string Name { get; init; } = "";
    public List<(string SpeciesId, int LengthMm)> Fish { get; } = new();
    public (string SpeciesId, int LengthMm) Latest => Fish[^1];
    internal CancellationTokenSource? Timer;
}

/// <summary>只读看鱼缸时要画的东西；State 为 null 表示这份展示已失效（房间已经没了）。</summary>
public sealed record TankView(string Name, TankViewState? State, TankSnapshot Tank);

/// <summary>
/// 网页的本机模拟房间（同图房间 v0.1，Q14 选 B）。房间只在内存里，刷新就回单人（01 §6）；
/// 地图和落点由 Moyu.Core.Rooms.Room 统一确认，本人的结果再抄回窗口控制器。
/// 好友的动作、收获、鱼缸都是本机样本，从不碰本人档案（Q16 选 A：各算各的，房间只管展示）。
/// </summary>
public sealed partial class PetSession
{
    public const string SelfId = "me";
    /// <summary>模拟"重新加入"等多久才有结果：只是让"正在重新加入房间…"看得见。</summary>
    private const int RejoinMs = 600;
    /// <summary>几位好友挨得很近地收获时只响一声（01 §4.6 允许合并声音）。</summary>
    private const int ChimeMergeMs = 300;

    private static readonly FishingMode[] SampleModes = { FishingMode.Lure, FishingMode.Pole, FishingMode.Wade };
    private static readonly string[] SampleScenes = { "WEB_SCENE_02", "WEB_SCENE_03", "BASE_SCENE" };

    public Room? Room { get; private set; }
    /// <summary>房间页上常驻的一行结果（本人断线、迁移失败、正在重新加入、重新加入失败）；有房间时为 null。</summary>
    public string? RoomStatus { get; private set; }
    public bool CanRejoin { get; private set; }
    public bool Rejoining { get; private set; }
    /// <summary>演示控制作用在哪位成员身上（房间页里点成员行选中）。</summary>
    public string? SelectedMemberId { get; set; }
    public IReadOnlyCollection<FriendCard> FriendCards => _friendCards.Values;

    private readonly Dictionary<string, FriendCard> _friendCards = new();
    /// <summary>断线或离开的模拟成员，"模拟重新加入"从最后一个开始请回来。</summary>
    private readonly List<RoomMember> _departed = new();
    /// <summary>本人断线后还在继续的那个房间（只剩模拟成员）。</summary>
    private Room? _droppedRoom;
    /// <summary>迁移失败、房间结束时还在的模拟成员和地图：重新加入时由他们另开一间。</summary>
    private List<RoomMember> _survivors = new();
    private string? _survivorMap;
    private (string Member, string Event, int Epoch)? _lastCatch;
    private int _simCount;
    private int _eventSeq;
    private long _lastChimeAt;
    private string? _viewingId;
    private string _viewingName = "";
    private bool _viewExpired;
    private readonly Random _rng = new();

    public RoomMember? SelfMember => Room?.Find(SelfId);
    public bool IsHost => Room?.HostId == SelfId;
    public string MapName(string mapId) => Pet.Maps.Find(mapId)?.PlaceholderName ?? mapId;

    // ---- 共同画面（Q20）：场景主题和底层鱼缸跟房主，迁移中和离房后显示本人自己的 ----

    /// <summary>正在跟随的别人当房主；本人当房主、迁移中、没进房间都为 null。</summary>
    private RoomMember? SharedHost => Room is { Migrating: false, Host: { IsSelf: false } h } ? h : null;
    public bool FollowingHost => SharedHost != null;

    public string ShownSceneSkin => SharedHost?.SceneSkin ?? Play?.EquippedId(SkinCategory.Scene) ?? Skins.BaseOf(SkinCategory.Scene).Id;
    /// <summary>画的是谁的缸："me" 或房主的成员号。</summary>
    public string ShownTankOwner => SharedHost?.Id ?? SelfId;
    public string? ShownTankId => SharedHost is { } h ? h.Tank.TankId : Play?.Profile.BackgroundTankId;

    public List<FishRecord> ShownTankFish => SharedHost is { } h
        ? h.Tank.Fish.Select((f, i) => new FishRecord { Id = $"{h.Id}-{i}", SpeciesId = f.SpeciesId, LengthMm = f.LengthMm }).ToList()
        : Play is { Profile.BackgroundTankId: { } tank } play ? play.InTank(tank).ToList() : new();

    // ---- 建房、加入、离开 ----

    public void CreateRoom()
    {
        if (Room != null) return;
        ResetRoom();
        Room = Room.Create(Pet.Maps, RoomKind.Simulated, NewSelf(), Pet.State.MapId, Pet.State.Spot);
        SyncSelf();
    }

    /// <summary>以成员身份加入：模拟好友1当房主、开在下一张图，好友2已在房里，本人第三个进（便于演示成员权限和迁移）。</summary>
    public void JoinRoom()
    {
        if (Room != null) return;
        ResetRoom();
        var maps = Pet.Maps.All;
        int i = maps.ToList().FindIndex(m => m.Id == Pet.State.MapId);
        var mapId = maps[(i + 1) % maps.Count].Id;
        var room = Room.Open(Pet.Maps, RoomKind.Simulated, NewFriend(), mapId);
        room.Add(NewFriend());
        room.Add(NewSelf());
        Room = room;
        FollowRoomMap();
    }

    public void LeaveRoom()
    {
        if (Room == null) return;
        var map = Room.MapId;
        Room.Remove(SelfId);
        ToSolo(null, false);
        Say(Texts.RoomLeft(MapName(map)));
    }

    public void EndSimulation()
    {
        if (Room == null) return;
        Room.End();
        ToSolo(null, false);
        Say(Texts.RoomEnded);
    }

    // ---- 演示控制 ----

    public void AddFriend()
    {
        if (Room == null) return;
        if (Room.Members.Count >= Room.Capacity)
        {
            Say(Texts.RoomFull);
            return;
        }
        Room.Add(NewFriend());
        SyncSelf();
    }

    /// <summary>移除模拟好友：选中的普通模拟成员，没选就最后加入的那个。房主要走用"模拟房主离开"。</summary>
    public void RemoveFriend()
    {
        var m = SelectedSimMember() ?? Room?.Members.Where(IsPlainSim).OrderBy(x => x.JoinOrder).LastOrDefault();
        if (m == null) return;
        Room!.Remove(m.Id);
        Forget(m.Id);
        SyncSelf();
    }

    public async Task FriendActAsync()
    {
        if (SelectedSim() is not { } m) return;
        await _js.InvokeVoidAsync("moyuPlay.friendAct", m.Id);
    }

    /// <summary>模拟收获：按房间地图的鱼池和权重抽一条样本鱼，作为一条新的收获消息送达（不进本人档）。</summary>
    public async Task FriendCatchAsync()
    {
        if (Room == null || SelectedSim() is not { } m) return;
        var pool = FishCatalog.Pool(Room.MapId);
        var sp = FishCatalog.PickByWeight(pool, _rng.Next(pool.Sum(s => s.Weight)));
        int mm = _rng.Next(sp.MinMm, sp.MaxMm + 1);
        var ev = $"{m.Id}-{++_eventSeq}";
        _lastCatch = (m.Id, ev, Room.Epoch);
        await DeliverCatchAsync(m.Id, ev, Room.Epoch, sp.Id, mm);
    }

    /// <summary>
    /// 模拟断线：普通成员立即移除、释放位置（Q19 保留 0 秒）；房主断线进迁移；本人断线就回单机，房间留给模拟成员。
    /// </summary>
    public void Disconnect()
    {
        if (Room == null || SelectedMemberId is not { } id || Room.Find(id) is not { } m) return;
        if (m.IsSelf)
        {
            var room = Room;
            room.Remove(SelfId);
            _droppedRoom = room.Ended ? null : room;
            ToSolo(Texts.RoomSelfDropped, true);
            return;
        }
        Depart(m);
    }

    /// <summary>模拟房主离开：只在别人当房主时能用；进入迁移（Q18）。</summary>
    public void HostLeave()
    {
        if (Room is { Migrating: false, Host: { IsSelf: false } h }) Depart(h);
    }

    public void MigrationSucceed()
    {
        if (Room?.CompleteMigration() is not { } next) return;
        Say(Texts.RoomNewHost(next.Name));
        SyncSelf();
    }

    /// <summary>迁移失败：房间结束、回单机，留在当前地图，留"重新加入"（01 §4.4）。个人档本来就不在房间里，什么都不用回滚。</summary>
    public void MigrationFail()
    {
        if (Room is not { Migrating: true } room) return;
        _survivors = room.Members.Where(m => m.IsSimulated).OrderBy(m => m.JoinOrder).ToList();
        _survivorMap = room.MapId;
        room.FailMigration();
        ToSolo(Texts.RoomMigrationFailed, true);
    }

    /// <summary>模拟重新加入：最近断线或离开的那位模拟成员回来，算新加入、重新安排位置；旧房主回来也只是普通成员。</summary>
    public void RejoinDemo()
    {
        if (Room == null || _departed.Count == 0) return;
        var m = _departed[^1];
        if (Room.Add(m) == RoomResult.Full)
        {
            Say(Texts.RoomFull);
            return;
        }
        _departed.RemoveAt(_departed.Count - 1);
        Say(Texts.RoomRejoined(m.Name));
        SyncSelf();
    }

    public bool CanRejoinDemo => Room != null && _departed.Count > 0;

    /// <summary>别人当房主时，演示让房主切到另一张图：全房一起去（Q17(2)）。</summary>
    public void SimHostSwitchMap(string mapId)
    {
        if (Room is not { Migrating: false, Host: { IsSelf: false } h }) return;
        if (Room.SwitchMap(h.Id, mapId) == RoomResult.Ok) FollowRoomMap();
    }

    /// <summary>本人断线或迁移失败后点"重新加入"：回到还在的房间；房间没了就由剩下的模拟成员另开一间；都没有就失败、继续单机。</summary>
    public async Task RejoinAsync()
    {
        if (!CanRejoin || Rejoining) return;
        Rejoining = true;
        CanRejoin = false;
        RoomStatus = Texts.RoomRejoining;
        Notify();
        await Task.Delay(RejoinMs);
        Rejoining = false;
        Room? room = null;
        if (_droppedRoom is { Ended: false } dropped)
        {
            dropped.CompleteMigration();
            room = dropped;
        }
        else if (_survivors.Count > 0)
        {
            room = Room.Open(Pet.Maps, RoomKind.Simulated, _survivors[0], _survivorMap ?? Pet.State.MapId);
            foreach (var s in _survivors.Skip(1)) room.Add(s);
        }
        _droppedRoom = null;
        _survivors = new();
        if (room == null || room.Add(NewSelf()) != RoomResult.Ok)
        {
            RoomStatus = Texts.RoomRejoinFailed;
            Say(Texts.RoomRejoinFailed);
            return;
        }
        Room = room;
        RoomStatus = null;
        FollowRoomMap();
    }

    // ---- 本人在房间里的操作：结果由房间确认 ----

    public void SwitchMode(FishingMode mode)
    {
        if (Room == null)
        {
            Pet.SwitchMode(mode);
            return;
        }
        Pet.ClosePanel();
        if (Room.SetMode(SelfId, mode) == RoomResult.Migrating) Say(Texts.RoomMigratingLocked);
        SyncSelf();
    }

    public void SelectMap(string mapId)
    {
        if (Room == null)
        {
            Pet.SelectMap(mapId);
            return;
        }
        var r = Room.SwitchMap(SelfId, mapId);
        if (r == RoomResult.Migrating) Say(Texts.RoomMigratingLocked);
        else if (r == RoomResult.NotHost) Say(Texts.RoomHostOnlyMap);
        SyncSelf();
    }

    /// <summary>单击场景选位。房间里要避开其他成员的落点（09 §4.3）；迁移中不确认、提示一下，不冒"放不下"。</summary>
    public PlaceResult ClickScene(ScenePoint point)
    {
        if (Room == null) return Pet.ClickScene(point);
        var (r, place) = Room.Place(SelfId, point);
        if (r == RoomResult.Migrating)
        {
            Say(Texts.RoomMigratingLocked);
            return PlaceResult.NotInArea;
        }
        SyncSelf();
        return place;
    }

    // ---- 只读看鱼缸（Q21） ----

    public void ViewTank(string memberId)
    {
        if (Room?.Find(memberId) is not { } m) return;
        _viewingId = m.Id;
        _viewingName = m.Name;
        _viewExpired = false;
    }

    public void CloseTankView()
    {
        _viewingId = null;
        _viewExpired = false;
    }

    public TankView? ViewedTank
    {
        get
        {
            if (_viewingId == null) return null;
            if (_viewExpired || Room == null) return new TankView(_viewingName, null, TankSnapshot.NotSet);
            if (SelfMember is { } self) self.Tank = OwnTank(); // 本人的展示缸实时读档
            var (state, tank) = Room.ViewTank(_viewingId);
            return new TankView(_viewingName, state, tank);
        }
    }

    // ---- 开发入口 ----

    /// <summary>把上一条好友收获消息原样再送一次，再送一条旧代次的（网页里没有网络，只能这样造重复消息）；返回被接受的条数。</summary>
    public async Task<int> DevRoomReplayAsync()
    {
        if (Room == null || _lastCatch is not { } c) return 0;
        int n = 0;
        if (await DeliverCatchAsync(c.Member, c.Event, c.Epoch, "TMP_F001", 80)) n++;
        if (await DeliverCatchAsync(c.Member, c.Event + "-stale", c.Epoch - 1, "TMP_F001", 80)) n++;
        return n;
    }

    // ---- 内部 ----

    /// <summary>收到一条好友收获消息：房间认了才演（动作、卡片、提示音）；收起或关闭时不演，之后也不补。</summary>
    private async Task<bool> DeliverCatchAsync(string memberId, string eventId, int epoch, string speciesId, int mm)
    {
        if (Room == null || !Room.AcceptCatch(memberId, eventId, epoch)) return false;
        if (Pet.State.Collapsed || Pet.State.Closed) return true;
        var m = Room.Find(memberId)!;
        if (!_friendCards.TryGetValue(m.Id, out var card)) _friendCards[m.Id] = card = new FriendCard { MemberId = m.Id, Name = m.Name };
        card.Fish.Add((speciesId, mm));
        card.Timer?.Cancel();
        var timer = card.Timer = new CancellationTokenSource();
        _ = Later(CardMs, timer.Token, () =>
        {
            if (_friendCards.TryGetValue(m.Id, out var c) && c == card) _friendCards.Remove(m.Id);
            Notify();
            return Task.CompletedTask;
        });
        Notify();
        await _js.InvokeVoidAsync("moyuPlay.friendAct", m.Id);
        if (!Pet.State.Settings.Mute && Now - _lastChimeAt >= ChimeMergeMs)
        {
            _lastChimeAt = Now;
            await _js.InvokeVoidAsync("moyuPlay.chime");
        }
        return true;
    }

    private void Depart(RoomMember m)
    {
        bool host = Room!.HostId == m.Id;
        Room.Remove(m.Id);
        Forget(m.Id);
        _departed.Add(m);
        Say(host ? Texts.RoomMigrating : Texts.RoomMemberGone(m.Name));
        SyncSelf();
    }

    private void Forget(string memberId)
    {
        if (_friendCards.Remove(memberId, out var card)) card.Timer?.Cancel();
        if (SelectedMemberId == memberId) SelectedMemberId = null;
    }

    /// <summary>回到单机：留在当前地图和落点；正在看的鱼缸展示作废。</summary>
    private void ToSolo(string? status, bool canRejoin)
    {
        foreach (var c in _friendCards.Values) c.Timer?.Cancel();
        _friendCards.Clear();
        if (_viewingId != null) _viewExpired = true;
        Room = null;
        SelectedMemberId = null;
        _departed.Clear();
        RoomStatus = status;
        CanRejoin = canRejoin;
        if (status != null) Say(status);
        Notify();
    }

    private void ResetRoom()
    {
        ToSolo(null, false);
        _droppedRoom = null;
        _survivors = new();
        _lastCatch = null;
        _simCount = 0;
        _viewingId = null;
        _viewExpired = false;
    }

    /// <summary>房间确认的地图、模式、落点抄回本人；地图变了提示一句（TXT-ROOM-021）。</summary>
    private void FollowRoomMap()
    {
        var before = Pet.State.MapId;
        SyncSelf();
        if (Pet.State.MapId != before) Say(Texts.RoomFollowed(MapName(Pet.State.MapId)));
    }

    private void SyncSelf()
    {
        if (SelfMember is { } self) Pet.ApplyRoomPlacement(Room!.MapId, self.Mode, self.Spot);
        Notify();
    }

    private RoomMember NewSelf() => new(SelfId, "我", true, false, Pet.State.Mode) { Tank = OwnTank() };

    /// <summary>第 n 位模拟好友的样本：模式、外观组合、场景主题、背景缸三种情况（有 3 条鱼、空缸、未设）轮着来。</summary>
    private RoomMember NewFriend()
    {
        int n = ++_simCount;
        int k = (n - 1) % 3;
        var m = new RoomMember($"sim{n}", Texts.SimFriendName(n), false, true, SampleModes[k])
        {
            Character = $"WEB_CHAR_0{k + 1}",
            Rod = $"WEB_ROD_0{(k + 1) % 3 + 1}",
            Glove = $"WEB_GLOVE_0{(k + 2) % 3 + 1}",
            SceneSkin = SampleScenes[k],
        };
        m.Tank = k switch
        {
            0 => new TankSnapshot("tank1", new[] { ("TMP_F001", 84), ("TMP_F002", 163), ("TMP_F003", 318) }, PlayEngine.FirstTankCapacity),
            1 => new TankSnapshot("tank1", Enumerable.Empty<(string, int)>(), PlayEngine.FirstTankCapacity),
            _ => TankSnapshot.NotSet,
        };
        return m;
    }

    private TankSnapshot OwnTank() => Play is { Profile.BackgroundTankId: { } tank } play
        ? new TankSnapshot(tank, play.InTank(tank).Select(f => (f.SpeciesId, f.LengthMm)), PlayEngine.FirstTankCapacity)
        : TankSnapshot.NotSet;

    private bool IsPlainSim(RoomMember m) => m.IsSimulated && m.Id != Room?.HostId;
    private RoomMember? SelectedSim() => SelectedMemberId is { } id && Room?.Find(id) is { IsSimulated: true } m ? m : null;
    private RoomMember? SelectedSimMember() => SelectedSim() is { } m && IsPlainSim(m) ? m : null;
}
