using Moyu.Core.Rooms;
using Moyu.Core.Scene;

namespace Moyu.Core.Tests;

/// <summary>
/// B9 用例表（doc/测试用例/B9 联机协议.md）里方式为 N 的用例：4 个 RoomLink 经内存假房间服务联机。
/// 假服务照 NET-EVAL-001 §8 实测的 Steam 房间规矩：所有者唯一、所有者走了交给别人、只有所有者写得进房间数据、每人写自己的成员数据、消息点对点。
/// 事件进队列，Run() 才送达，测试能控制顺序、重复、丢弃。
/// </summary>
public partial class B9CaseTests
{
    private static readonly MapCatalog Maps = MapCatalog.CreatePlaceholder();
    private const string M1 = MapCatalog.Pond;
    private const string M2 = MapCatalog.Stream;
    private const string Ver = "v1";
    private const double ShoreY = 565;

    /// <summary>内存里的假房间服务。</summary>
    private sealed class Lobby
    {
        public readonly Dictionary<string, RoomLink> Links = new();
        public readonly List<string> Members = new();
        public readonly Dictionary<string, string> Data = new();
        public readonly Dictionary<string, string> MemberData = new();
        public readonly List<(string To, string From, string Text)> Sent = new();
        public string? Owner;
        public long Now;
        /// <summary>所有者走了交给谁；null 为剩下的第一个。</summary>
        public string? NextOwner;
        /// <summary>所有者走了先通知"所有者变了"再通知"离开"。</summary>
        public bool OwnerFirst;
        private readonly Queue<(string To, Action<RoomLink> Do)> _queue = new();

        public RoomLink Make(string id, FishingMode mode = FishingMode.Lure, string version = Ver) =>
            Links[id] = new RoomLink(Maps, id, version, new MemberProfile { Name = id.ToUpperInvariant(), Mode = mode }, () => Now, "n" + Links.Count);

        public RoomLink Enter(string id, FishingMode mode = FishingMode.Lure, string version = Ver, string map = M1)
        {
            var link = Links.TryGetValue(id, out var had) && had.Room == null && had.Version == version ? had : Make(id, mode, version);
            if (Members.Count >= Room.Capacity) throw new InvalidOperationException("满员");
            if (Members.Count == 0) Owner = id;
            Members.Add(id);
            var snapshot = new Dictionary<string, string>(MemberData);
            Data.TryGetValue("ver", out var ver);
            Data.TryGetValue("room", out var room);
            var members = Members.ToList();
            var owner = Owner!;
            Queue(id, l => l.Entered(owner, members, ver, room, snapshot, map, null));
            foreach (var m in Others(id)) Queue(m, l => l.MemberJoined(id));
            Run();
            return link;
        }

        /// <summary>id 离开（dropped 为掉线）。</summary>
        public void Remove(string id, bool dropped)
        {
            if (!Members.Remove(id)) return;
            MemberData.Remove(id);
            if (Members.Count == 0)
            {
                Owner = null;
                Data.Clear();
                return;
            }
            bool ownerLeft = Owner == id;
            if (ownerLeft) Owner = NextOwner ?? Members[0];
            var owner = Owner!;
            foreach (var m in Members)
            {
                if (ownerLeft && OwnerFirst) Queue(m, l => l.OwnerChanged(owner));
                Queue(m, l => l.MemberLeft(id, dropped));
                if (ownerLeft && !OwnerFirst) Queue(m, l => l.OwnerChanged(owner));
            }
        }

        public IEnumerable<string> Others(string id) => Members.Where(m => m != id).ToList();

        public void Queue(string to, Action<RoomLink> act) => _queue.Enqueue((to, act));

        /// <summary>把 id 发出的命令交给服务执行（结果进队列，Run 时送达）。</summary>
        public void Flush(string id)
        {
            var link = Links[id];
            var cmds = link.Out.ToList();
            link.Out.Clear();
            foreach (var c in cmds)
            {
                if (!Members.Contains(id)) break;
                switch (c.Op)
                {
                    case LinkOp.SetLobbyData:
                        if (Owner != id) break; // 别人写：不报错、不生效（§8 实测）
                        Data[c.Key] = c.Text;
                        if (c.Key == "room") foreach (var m in Others(id)) Queue(m, l => l.LobbyData(c.Text));
                        break;
                    case LinkOp.SetMemberData:
                        MemberData[id] = c.Text;
                        foreach (var m in Others(id)) Queue(m, l => l.MemberData(id, c.Text));
                        break;
                    case LinkOp.Send:
                        Sent.Add((c.Key, id, c.Text));
                        if (Members.Contains(c.Key)) Queue(c.Key, l => l.Message(id, c.Text));
                        break;
                    case LinkOp.Broadcast:
                        foreach (var m in Others(id))
                        {
                            Sent.Add((m, id, c.Text));
                            Queue(m, l => l.Message(id, c.Text));
                        }
                        break;
                    case LinkOp.Leave:
                        Remove(id, false);
                        break;
                }
            }
        }

        /// <summary>送达队列里的事件，每送一件就执行收件人新产生的命令，直到没事可做。</summary>
        public void Run()
        {
            foreach (var id in Links.Keys.ToList()) Flush(id);
            while (_queue.Count > 0)
            {
                var (to, act) = _queue.Dequeue();
                if (!Members.Contains(to)) continue;
                act(Links[to]);
                Flush(to);
            }
        }

        public void Tick()
        {
            foreach (var l in Links.Values) l.Tick();
            Run();
        }

        public void ClearNotes()
        {
            foreach (var l in Links.Values) l.Notes.Clear();
        }
    }

    /// <summary>a 建房，其余按序进房，都是岸边路亚。</summary>
    private static Lobby Four(params string[] ids)
    {
        var lobby = new Lobby();
        foreach (var id in ids.Length == 0 ? new[] { "a", "b", "c", "d" } : ids) lobby.Enter(id);
        lobby.ClearNotes();
        return lobby;
    }

    private static string Layout(Room r) =>
        $"{r.Epoch}|{r.HostId}|{r.MapId}|" + string.Join(";", r.Members.Select(m => $"{m.Id},{m.JoinOrder},{m.Mode},{m.Spot}"));

    /// <summary>各人的镜像和房主的权威房间逐项一样。</summary>
    private static void AssertConverged(Lobby lobby)
    {
        var rooms = lobby.Members.Select(id => (id, lobby.Links[id].Room)).ToList();
        Assert.That(rooms.All(r => r.Room != null), "有人没房间");
        var layouts = rooms.Select(r => Layout(r.Room!)).Distinct().ToList();
        Assert.That(layouts, Has.Count.EqualTo(1), string.Join("\n", rooms.Select(r => $"{r.id}: {Layout(r.Room!)}")));
    }

    /// <summary>岸边一个此刻谁都不在、放得下的点。</summary>
    private static ScenePoint FreeShorePoint(Room room)
    {
        var planner = new SpotPlanner();
        var others = room.Members.Where(m => m.Mode.Area() == AreaKind.Shore && m.Spot != null).Select(m => m.Spot!.Value).ToList();
        for (double x = room.Map.Shore.Left + 60; x < room.Map.Shore.Right - 60; x += 10)
        {
            var p = new ScenePoint(x, ShoreY);
            if (planner.TryPlace(room.Map, FishingMode.Lure, p, others) == PlaceResult.Placed) return p;
        }
        throw new InvalidOperationException("岸边没空位");
    }

    private static IEnumerable<LinkNote> Notes(RoomLink l, LinkNoteKind kind) => l.Notes.Where(n => n.Kind == kind);

    [Test(Description = "B9-01 换房主由外部指定：指定 C 就是 C、代次 +1、地图落点不变；指定不在的人不接任；不指定按加入次序")]
    public void Migration_takes_the_named_host()
    {
        Room NewRoom()
        {
            var room = Room.Create(Maps, RoomKind.Real, new RoomMember("a", "A", true, false, FishingMode.Lure), M1, null);
            foreach (var id in new[] { "b", "c", "d" }) room.Add(new RoomMember(id, id, false, false, FishingMode.Lure));
            room.Remove("a");
            return room;
        }
        var r1 = NewRoom();
        var before = r1.Members.ToDictionary(m => m.Id, m => m.Spot);
        Assert.That(r1.CompleteMigration("c")?.Id, Is.EqualTo("c"));
        Assert.That((r1.HostId, r1.Epoch, r1.Migrating, r1.MapId), Is.EqualTo(("c", 2, false, M1)));
        Assert.That(r1.Members.ToDictionary(m => m.Id, m => m.Spot), Is.EqualTo(before));

        var r2 = NewRoom();
        Assert.That(r2.CompleteMigration("a"), Is.Null, "已离开的人不能接任");
        Assert.That((r2.HostId, r2.Epoch, r2.Migrating), Is.EqualTo(((string?)null, 1, true)));

        var r3 = NewRoom();
        Assert.That(r3.CompleteMigration()?.Id, Is.EqualTo("b"));
    }

    [Test(Description = "B9-02 快照往返：4 份镜像的代次、房主、地图、每人次序模式落点一致；名字和外观来自各人成员数据")]
    public void Snapshot_round_trip_converges()
    {
        var lobby = new Lobby();
        lobby.Enter("a");
        lobby.Make("b", FishingMode.Wade);
        lobby.Enter("b", FishingMode.Wade);
        lobby.Make("c", FishingMode.Pole);
        lobby.Links["c"].UpdateProfile(new MemberProfile { Name = "小C", Mode = FishingMode.Pole, Character = "WEB_CHAR_02", SceneSkin = "WEB_SCENE_03" });
        lobby.Links["c"].Out.Clear();
        lobby.Enter("c", FishingMode.Pole);
        lobby.Enter("d");
        AssertConverged(lobby);
        var room = lobby.Links["d"].Room!;
        Assert.That(room.Members.Select(m => (m.Id, m.Mode)), Is.EqualTo(new[] { ("a", FishingMode.Lure), ("b", FishingMode.Wade), ("c", FishingMode.Pole), ("d", FishingMode.Lure) }));
        Assert.That(room.Members.All(m => m.Spot != null));
        var c = room.Find("c")!;
        Assert.That((c.Name, c.Character, c.SceneSkin), Is.EqualTo(("小C", "WEB_CHAR_02", "WEB_SCENE_03")));
        Assert.That(room.Find("d")!.IsSelf && !room.Find("a")!.IsSelf);

        var snap = lobby.Links["a"].Room!.Snapshot();
        var parsed = RoomWire.ParseSnapshot(RoomWire.Snapshot(snap, 7))!.Value;
        Assert.That(parsed.Rev, Is.EqualTo(7));
        Assert.That(RoomWire.Snapshot(parsed.Snap, 7), Is.EqualTo(RoomWire.Snapshot(snap, 7)));
        Assert.That(RoomWire.ParseSnapshot("S1|x|1|a|m|"), Is.Null);
        Assert.That(RoomWire.ParseProfile("P1|a|Lure"), Is.Null);
    }

    [Test(Description = "B9-03 旧快照不认：旧代次、同代次旧修订和同修订都不改镜像，新修订才认")]
    public void Stale_snapshots_are_ignored()
    {
        var lobby = Four("a", "b");
        var b = lobby.Links["b"];
        var host = lobby.Links["a"].Room!;
        string Snap(int epoch, int rev, string map) =>
            RoomWire.Snapshot(new RoomSnapshot(epoch, "a", map, host.Members.Select(m => new RoomSnapshot.Entry(m.Id, m.JoinOrder, m.Mode, m.Spot))), rev);
        // 先让 b 到代次 2 修订 5
        b.LobbyData(Snap(2, 5, M1));
        Assert.That((b.Room!.Epoch, b.Room.MapId), Is.EqualTo((2, M1)));
        foreach (var (e, r) in new[] { (1, 99), (2, 4), (2, 5) })
        {
            b.LobbyData(Snap(e, r, M2));
            Assert.That(b.Room.MapId, Is.EqualTo(M1), $"代次 {e} 修订 {r} 不该认");
        }
        b.LobbyData(Snap(2, 6, M2));
        Assert.That(b.Room.MapId, Is.EqualTo(M2));
    }

    [TestCase(false, Description = "B9-04 同时抢同一位置（B 先到）：一个成功、另一个放不下留原位，4 份镜像一致")]
    [TestCase(true, Description = "B9-04 同时抢同一位置（C 先到）：一个成功、另一个放不下留原位，4 份镜像一致")]
    public void Concurrent_place_has_one_winner(bool cFirst)
    {
        var lobby = Four();
        var p = FreeShorePoint(lobby.Links["a"].Room!);
        var b = lobby.Links["b"];
        var c = lobby.Links["c"];
        var bSpot = b.Room!.Find("b")!.Spot;
        var cSpot = c.Room!.Find("c")!.Spot;
        Assert.That(b.Place(p).Place, Is.Null, "成员的选位要等房主回");
        Assert.That(c.Place(p).Place, Is.Null);
        if (cFirst) { lobby.Flush("c"); lobby.Flush("b"); }
        else { lobby.Flush("b"); lobby.Flush("c"); }
        lobby.Run();
        var (winner, loser, loserSpot) = cFirst ? (c, b, bSpot) : (b, c, cSpot);
        Assert.That(Notes(winner, LinkNoteKind.PlaceResult).Single().Place, Is.EqualTo(PlaceResult.Placed));
        Assert.That(Notes(loser, LinkNoteKind.PlaceResult).Single().Place, Is.EqualTo(PlaceResult.NoRoom));
        Assert.That(Notes(winner, LinkNoteKind.PlaceResult).Select(n => (n.Name, n.SpeciesId)), Is.EqualTo(new[] { ("", "") }));
        var host = lobby.Links["a"].Room!;
        Assert.That(host.Find(winner.SelfId)!.Spot, Is.EqualTo(p));
        Assert.That(host.Find(loser.SelfId)!.Spot, Is.EqualTo(loserSpot));
        AssertConverged(lobby);
    }

    [Test(Description = "B9-05 重复请求不再执行，房主把原结果再回一次，修订不变")]
    public void Duplicate_request_is_not_applied_twice()
    {
        var lobby = Four();
        var b = lobby.Links["b"];
        var p = FreeShorePoint(lobby.Links["a"].Room!);
        b.Place(p);
        lobby.Run();
        var first = lobby.Sent.Last(s => s.From == "b" && s.Text.StartsWith("Q|"));
        var q = FreeShorePoint(lobby.Links["a"].Room!);
        b.Place(q);
        lobby.Run();
        Assert.That(lobby.Links["a"].Room!.Find("b")!.Spot, Is.EqualTo(q));
        var revBefore = lobby.Data["room"];
        var repliesBefore = lobby.Sent.Count(s => s.To == "b" && s.Text.StartsWith("A|"));
        lobby.Queue("a", l => l.Message("b", first.Text));
        lobby.Run();
        Assert.That(lobby.Links["a"].Room!.Find("b")!.Spot, Is.EqualTo(q), "旧请求不该把 b 拉回 p");
        Assert.That(lobby.Data["room"], Is.EqualTo(revBefore), "没发新快照");
        Assert.That(lobby.Sent.Count(s => s.To == "b" && s.Text.StartsWith("A|")), Is.EqualTo(repliesBefore), "比最后一条还旧的请求什么都不回");
        // 最后一条重复到达：原样再回一次
        var second = lobby.Sent.Last(s => s.From == "b" && s.Text.StartsWith("Q|"));
        lobby.Queue("a", l => l.Message("b", second.Text));
        lobby.Run();
        var replies = lobby.Sent.Where(s => s.To == "b" && s.Text.StartsWith("A|2|")).Select(s => s.Text).ToList();
        Assert.That(replies, Has.Count.EqualTo(2));
        Assert.That(replies.Distinct().Count(), Is.EqualTo(1));
        Assert.That(lobby.Data["room"], Is.EqualTo(revBefore));
        Assert.That(Notes(b, LinkNoteKind.PlaceResult).Count(), Is.EqualTo(2), "同一条回复再到不再出结果");
    }

    [Test(Description = "B9-06 带旧地图、旧代次的请求回已过期，什么都不改")]
    public void Old_map_or_epoch_requests_are_stale()
    {
        var lobby = Four();
        var a = lobby.Links["a"];
        var host = a.Room!;
        var p = FreeShorePoint(host);
        var bSpot = host.Find("b")!.Spot;
        string Q(int req, int epoch, string map, string body) => $"Q|{req}|{epoch}|{map}|{body}";
        lobby.Queue("a", l => l.Message("b", Q(10, 1, M2, $"place|{p.X}|{p.Y}")));
        lobby.Queue("a", l => l.Message("b", Q(11, 0, M1, $"place|{p.X}|{p.Y}")));
        lobby.Queue("a", l => l.Message("b", Q(12, 0, M1, "mode|Wade")));
        lobby.Run();
        Assert.That(host.Find("b")!.Spot, Is.EqualTo(bSpot));
        Assert.That(host.Find("b")!.Mode, Is.EqualTo(FishingMode.Lure));
        Assert.That(lobby.Sent.Where(s => s.To == "b" && s.Text.StartsWith("A|1")).Select(s => s.Text.Split('|')[2]), Is.EqualTo(new[] { "Stale", "Stale", "Stale" }));
        Assert.That(Notes(lobby.Links["b"], LinkNoteKind.PlaceResult), Is.Empty, "不是 b 自己挂着的请求，不出结果");
    }

    [Test(Description = "B9-07 请求只动发件人；不在房间的人的请求不理不回；坏格式不理")]
    public void Requests_only_move_the_sender()
    {
        var lobby = Four();
        var host = lobby.Links["a"].Room!;
        var p = FreeShorePoint(host);
        var before = host.Members.ToDictionary(m => m.Id, m => m.Spot);
        lobby.Queue("a", l => l.Message("e", $"Q|1|1|{M1}|place|{p.X}|{p.Y}"));
        lobby.Queue("a", l => l.Message("b", "Q|x|1"));
        lobby.Queue("a", l => l.Message("b", $"Q|1|1|{M1}|fly|1|2"));
        lobby.Run();
        Assert.That(host.Members.ToDictionary(m => m.Id, m => m.Spot), Is.EqualTo(before));
        Assert.That(lobby.Sent.Where(s => s.From == "a" && s.Text.StartsWith("A|")), Is.Empty);
        lobby.Queue("a", l => l.Message("c", $"Q|1|1|{M1}|place|{p.X}|{p.Y}"));
        lobby.Run();
        var after = host.Members.ToDictionary(m => m.Id, m => m.Spot);
        Assert.That(after["c"], Is.EqualTo(p));
        Assert.That(after.Where(kv => kv.Key != "c"), Is.EqualTo(before.Where(kv => kv.Key != "c")));
    }

    [Test(Description = "B9-08 普通成员掉线：房主立即移除、位置马上能被选到，别人得到已断线；重进算新加入")]
    public void Dropped_member_is_released_and_rejoins_as_new()
    {
        var lobby = Four();
        var host = lobby.Links["a"].Room!;
        var bSpot = host.Find("b")!.Spot!.Value;
        lobby.Remove("b", dropped: true);
        lobby.Run();
        Assert.That(host.Find("b"), Is.Null);
        foreach (var id in new[] { "a", "c", "d" })
        {
            Assert.That(Notes(lobby.Links[id], LinkNoteKind.MemberGone).Single().Name, Is.EqualTo("B"), id);
            Assert.That(lobby.Links[id].Room!.Find("b"), Is.Null, id);
        }
        AssertConverged(lobby);
        // b 的原位马上能被 c 选到
        lobby.Links["c"].Place(bSpot);
        lobby.Run();
        Assert.That(host.Find("c")!.Spot, Is.EqualTo(bSpot));
        // 正常离开不说"已断线"
        lobby.Remove("d", dropped: false);
        lobby.Run();
        Assert.That(Notes(lobby.Links["c"], LinkNoteKind.MemberGone).Count(), Is.EqualTo(1));
        lobby.Enter("d");
        lobby.ClearNotes();
        // b 重进：次序最大、重新安排，别人得到"已重新加入"
        lobby.Enter("b");
        Assert.That(host.Find("b")!.JoinOrder, Is.EqualTo(host.Members.Max(m => m.JoinOrder)));
        Assert.That(host.Find("b")!.Spot, Is.Not.Null);
        Assert.That(Notes(lobby.Links["c"], LinkNoteKind.Rejoined).Single().Name, Is.EqualTo("B"));
        Assert.That(Notes(lobby.Links["b"], LinkNoteKind.Joined).Count(), Is.EqualTo(1));
        AssertConverged(lobby);
    }

    [TestCase(false, Description = "B9-09 房主掉线换房主（先到离开）：只有指定的 B 当房主、代次 2，C、D 得到 B 已成为房主")]
    [TestCase(true, Description = "B9-09 房主掉线换房主（先到所有者变了）：只有指定的 B 当房主、代次 2，C、D 得到 B 已成为房主")]
    public void Host_drop_hands_over_to_the_owner(bool ownerFirst)
    {
        var lobby = Four();
        lobby.OwnerFirst = ownerFirst;
        lobby.NextOwner = "c"; // 不是加入最早的 b，验证听服务的
        var spots = lobby.Links["b"].Room!.Members.Where(m => m.Id != "a").ToDictionary(m => m.Id, m => m.Spot);
        lobby.Remove("a", dropped: true);
        lobby.Run();
        AssertConverged(lobby);
        foreach (var id in new[] { "b", "c", "d" })
        {
            var r = lobby.Links[id].Room!;
            Assert.That((r.HostId, r.Epoch, r.Migrating, r.MapId), Is.EqualTo(("c", 2, false, M1)), id);
            Assert.That(r.Members.ToDictionary(m => m.Id, m => m.Spot), Is.EqualTo(spots), id);
            Assert.That(Notes(lobby.Links[id], LinkNoteKind.NewHost).Single().Name, Is.EqualTo("C"), id);
            Assert.That(Notes(lobby.Links[id], LinkNoteKind.Migrating).Single().Name, Is.EqualTo("A"), id);
            Assert.That(Notes(lobby.Links[id], LinkNoteKind.MemberGone), Is.Empty, $"{id}：房主走了说的是迁移，不是成员断线");
        }
        Assert.That(lobby.Links["c"].IsHost && !lobby.Links["b"].IsHost && !lobby.Links["d"].IsHost);
    }

    [TestCase(false, Description = "B9-10 旧房主回来是普通成员（先到离开）；它写的房间数据、旧代次快照和请求都不认；别人得到已重新加入")]
    [TestCase(true, Description = "B9-10 旧房主回来是普通成员（先到所有者变了）；它写的房间数据、旧代次快照和请求都不认；别人得到已重新加入")]
    public void Old_host_returns_as_member(bool ownerFirst)
    {
        var lobby = Four();
        lobby.OwnerFirst = ownerFirst;
        var oldSnap = lobby.Data["room"];
        lobby.Remove("a", dropped: true);
        lobby.Run();
        lobby.ClearNotes();
        var a = lobby.Enter("a");
        Assert.That(a.IsHost, Is.False);
        Assert.That(a.Room!.HostId, Is.EqualTo("b"));
        foreach (var id in new[] { "b", "c", "d" })
            Assert.That(Notes(lobby.Links[id], LinkNoteKind.Rejoined).Single().Name, Is.EqualTo("A"), id);
        AssertConverged(lobby);
        var layout = Layout(lobby.Links["b"].Room!);
        // 旧房主写房间数据：服务不让写；就算旧快照被转到别人手里也不认
        a.Out.Add(new LinkCommand(LinkOp.SetLobbyData, "room", oldSnap));
        foreach (var id in new[] { "c", "d" }) lobby.Queue(id, l => l.LobbyData(oldSnap));
        lobby.Queue("b", l => l.Message("a", $"Q|99|1|{M1}|mode|Wade"));
        lobby.Run();
        Assert.That(lobby.Data["room"], Is.Not.EqualTo(oldSnap));
        Assert.That(Layout(lobby.Links["b"].Room!), Is.EqualTo(layout));
        AssertConverged(lobby);
    }

    [Test(Description = "B9-11 迁移中本地直接回迁移中、不发请求；新快照到了再选能成功")]
    public void Migrating_refuses_locally()
    {
        var lobby = Four();
        lobby.NextOwner = "b";
        var c = lobby.Links["c"];
        // 只把"a 离开"送给 c，b 那边先压着
        lobby.Members.Remove("a");
        lobby.Owner = "b";
        c.MemberLeft("a", true);
        Assert.That(Notes(c, LinkNoteKind.Migrating).Count(), Is.EqualTo(1));
        var p = FreeShorePoint(c.Room!);
        Assert.That(c.Place(p).Result, Is.EqualTo(RoomResult.Migrating));
        Assert.That(c.SetMode(FishingMode.Wade), Is.EqualTo(RoomResult.Migrating));
        Assert.That(c.SwitchMap(M2), Is.EqualTo(RoomResult.Migrating));
        Assert.That(c.Out, Is.Empty, "迁移中什么都不发");
        foreach (var id in new[] { "b", "d" })
        {
            lobby.Queue(id, l => l.MemberLeft("a", true));
            lobby.Queue(id, l => l.OwnerChanged("b"));
        }
        lobby.Queue("c", l => l.OwnerChanged("b"));
        lobby.Run();
        Assert.That(c.Room!.Migrating, Is.False);
        c.Place(p);
        lobby.Run();
        Assert.That(Notes(c, LinkNoteKind.PlaceResult).Single().Place, Is.EqualTo(PlaceResult.Placed));
        AssertConverged(lobby);
    }

    [Test(Description = "B9-12 迁移超时：9.9 秒还在迁移中，10 秒迁移失败、离开房间")]
    public void Migration_times_out()
    {
        var lobby = Four();
        lobby.Now = 50_000;
        var c = lobby.Links["c"];
        var room = c.Room!;
        lobby.Members.Remove("a");
        c.MemberLeft("a", true); // 所有者一直没换过来
        lobby.Now += RoomLink.MigrationTimeoutMs - 100;
        c.Tick();
        Assert.That(c.Room?.Migrating, Is.True);
        Assert.That(Notes(c, LinkNoteKind.MigrationFailed), Is.Empty);
        lobby.Now += 100;
        c.Tick();
        Assert.That(c.Room, Is.Null);
        Assert.That(room.Ended, "房间结束");
        Assert.That(Notes(c, LinkNoteKind.MigrationFailed).Count(), Is.EqualTo(1));
        Assert.That(c.Out.Select(o => o.Op), Is.EqualTo(new[] { LinkOp.Leave }));
        c.Tick();
        Assert.That(Notes(c, LinkNoteKind.MigrationFailed).Count(), Is.EqualTo(1), "只失败一次");
    }

    [Test(Description = "B9-13 新房主接管后切图全房跟、同时抢位只成功一个")]
    public void New_host_keeps_the_rules()
    {
        var lobby = Four();
        lobby.Remove("a", dropped: true);
        lobby.Run();
        var b = lobby.Links["b"];
        Assert.That(b.SwitchMap(M2), Is.EqualTo(RoomResult.Ok));
        lobby.Run();
        AssertConverged(lobby);
        Assert.That(lobby.Links["d"].Room!.MapId, Is.EqualTo(M2));
        lobby.ClearNotes();
        var p = FreeShorePoint(b.Room!);
        lobby.Links["c"].Place(p);
        lobby.Links["d"].Place(p);
        lobby.Flush("c");
        lobby.Flush("d");
        lobby.Run();
        var results = new[] { "c", "d" }.Select(id => Notes(lobby.Links[id], LinkNoteKind.PlaceResult).Single().Place).ToList();
        Assert.That(results.Count(r => r == PlaceResult.Placed), Is.EqualTo(1));
        Assert.That(results.Count(r => r == PlaceResult.NoRoom), Is.EqualTo(1));
        AssertConverged(lobby);
    }

    [Test(Description = "B9-14 成员资料更新随即可见；离开后看到已离开，迟到的资料不让他复活")]
    public void Profile_updates_and_departure()
    {
        var lobby = Four();
        var c = lobby.Links["c"];
        var three = new TankSnapshot("tank1", new[] { ("TMP_F001", 84), ("TMP_F002", 163), ("TMP_F003", 318) }, 20);
        c.UpdateProfile(new MemberProfile { Name = "小C", Tank = three });
        Assert.That((c.Room!.Find("c")!.Name, c.Room.ViewTank("c").State), Is.EqualTo(("小C", TankViewState.Fish)), "自己的镜像当场改");
        lobby.Run();
        var b = lobby.Links["b"];
        Assert.That(b.Room!.ViewTank("c").State, Is.EqualTo(TankViewState.Fish));
        Assert.That(b.Room.ViewTank("c").Tank.Fish, Has.Count.EqualTo(3));
        c.UpdateProfile(new MemberProfile { Name = "C", Tank = new TankSnapshot("tank1", Array.Empty<(string, int)>(), 20) });
        lobby.Run();
        Assert.That(b.Room.ViewTank("c").State, Is.EqualTo(TankViewState.Empty));
        var late = lobby.MemberData["c"];
        lobby.Remove("c", dropped: false);
        lobby.Run();
        Assert.That(b.Room.ViewTank("c").State, Is.EqualTo(TankViewState.Gone));
        lobby.Queue("b", l => l.MemberData("c", late));
        lobby.Queue("a", l => l.MemberData("c", late));
        lobby.Run();
        Assert.That(b.Room.ViewTank("c").State, Is.EqualTo(TankViewState.Gone));
        Assert.That(lobby.Links["a"].Room!.Find("c"), Is.Null, "房主不会因迟到的资料把人加回来");
    }

    [Test(Description = "B9-15 好友收获：同一条重复、旧代次、不在房间的人都不认，只认第一条")]
    public void Friend_catch_is_accepted_once()
    {
        var lobby = Four();
        var b = lobby.Links["b"];
        b.Catch("TMP_F002", 163);
        var msg = b.Out.Single().Text;
        lobby.Run();
        foreach (var id in new[] { "a", "c", "d" })
        {
            var n = Notes(lobby.Links[id], LinkNoteKind.FriendCatch).Single();
            Assert.That((n.MemberId, n.Name, n.SpeciesId, n.LengthMm), Is.EqualTo(("b", "B", "TMP_F002", 163)), id);
        }
        Assert.That(Notes(b, LinkNoteKind.FriendCatch), Is.Empty);
        var stale = msg.Replace("|1|TMP", "|0|TMP").Replace("-1|", "-2|");
        lobby.Queue("c", l => l.Message("b", msg));
        lobby.Queue("c", l => l.Message("b", stale));
        lobby.Queue("c", l => l.Message("e", "C|e-x-1|1|TMP_F001|80"));
        lobby.Run();
        Assert.That(Notes(lobby.Links["c"], LinkNoteKind.FriendCatch).Count(), Is.EqualTo(1));
    }

    [Test(Description = "B9-16 版本不一致：马上离开、出版本不一致，不建镜像、不交资料")]
    public void Version_mismatch_leaves()
    {
        var lobby = Four("a", "b");
        var e = lobby.Enter("e", version: "v0");
        Assert.That(e.Room, Is.Null);
        Assert.That(Notes(e, LinkNoteKind.VersionMismatch).Count(), Is.EqualTo(1));
        Assert.That(lobby.Members, Is.EqualTo(new[] { "a", "b" }));
        Assert.That(lobby.MemberData.ContainsKey("e"), Is.False);
        Assert.That(lobby.Links["a"].Room!.Members, Has.Count.EqualTo(2));
    }

    [Test(Description = "B9-17 房主收到第 5 人的进房和资料：不加人、快照不变")]
    public void Host_does_not_add_a_fifth()
    {
        var lobby = Four();
        var snap = lobby.Data["room"];
        var a = lobby.Links["a"];
        a.MemberJoined("e");
        a.MemberData("e", RoomWire.Profile(new MemberProfile { Name = "E" }));
        lobby.Run();
        Assert.That(a.Room!.Members, Has.Count.EqualTo(4));
        Assert.That(lobby.Data["room"], Is.EqualTo(snap));
    }

    [Test(Description = "B9-18 成员切图本地被拒、什么都不发；房主切图全房跟、各人重新安排")]
    public void Only_host_switches_map()
    {
        var lobby = Four();
        var b = lobby.Links["b"];
        Assert.That(b.SwitchMap(M2), Is.EqualTo(RoomResult.NotHost));
        Assert.That(b.Out, Is.Empty);
        Assert.That(b.Room!.MapId, Is.EqualTo(M1));
        var a = lobby.Links["a"];
        Assert.That(a.SwitchMap(M2), Is.EqualTo(RoomResult.Ok));
        lobby.Run();
        AssertConverged(lobby);
        Assert.That(b.Room.MapId, Is.EqualTo(M2));
        Assert.That(b.Room.Members.All(m => m.Spot != null));
        Assert.That(Notes(b, LinkNoteKind.Changed), Is.Not.Empty);
        // 成员换模式经房主确认：去浅水、重新安排
        b.SetMode(FishingMode.Wade);
        lobby.Run();
        Assert.That(a.Room!.Find("b")!.Mode, Is.EqualTo(FishingMode.Wade));
        Assert.That(lobby.Sent.Last(s => s.To == "b").Text, Does.Match(@"^A\|\d+\|Ok\|"));
        b.SetMode(FishingMode.Pole);
        lobby.Run();
        Assert.That(a.Room.Find("b")!.Mode, Is.EqualTo(FishingMode.Pole), "第二次换模式也执行");
        AssertConverged(lobby);
    }
}
