using Moyu.Core.Rooms;
using Moyu.Core.Scene;

namespace Moyu.Core.Tests;

/// <summary>
/// B3 用例表（doc/测试用例/B3 同图房间.md）里方式含 N 的用例：房间人数、排位、切图权限、断线与迁移、选位、去重、共享画面、只读鱼缸。
/// </summary>
public class B3CaseTests
{
    private static readonly MapCatalog Maps = MapCatalog.CreatePlaceholder();
    private const string M1 = MapCatalog.Pond;
    private const string M2 = MapCatalog.Stream;
    private const double ShoreY = 565;

    private static RoomMember Me(FishingMode mode = FishingMode.Lure) => new("me", "我", true, false, mode);
    private static RoomMember Sim(string id, FishingMode mode = FishingMode.Lure) => new(id, id, false, true, mode);

    private static Room NewRoom(FishingMode selfMode = FishingMode.Lure, params RoomMember[] friends)
    {
        var room = Room.Create(Maps, RoomKind.Simulated, Me(selfMode), M1, null);
        foreach (var f in friends) Assert.That(room.Add(f), Is.EqualTo(RoomResult.Ok));
        return room;
    }

    /// <summary>每人的落点都在自己模式的区域里、不压装饰，同一区域里占地框两两不相交。</summary>
    private static void AssertLayoutValid(Room room)
    {
        var planner = new SpotPlanner();
        foreach (var m in room.Members)
        {
            Assert.That(m.Spot, Is.Not.Null, $"{m.Id} 没排上");
            var others = room.Members.Where(o => o != m && o.Mode.Area() == m.Mode.Area()).Select(o => o.Spot!.Value);
            Assert.That(planner.TryPlace(room.Map, m.Mode, m.Spot!.Value, others), Is.EqualTo(PlaceResult.Placed), $"{m.Id} 的落点 {m.Spot} 放不下");
        }
    }

    private static Dictionary<string, ScenePoint?> Spots(Room room) => room.Members.ToDictionary(m => m.Id, m => m.Spot);

    [Test(Description = "B3-01 4 人上限：第 5 人被拒，已有成员、落点、房主不变")]
    public void Room_holds_four_and_rejects_fifth()
    {
        var room = NewRoom(FishingMode.Lure, Sim("a"), Sim("b"), Sim("c"));
        Assert.That(room.Members, Has.Count.EqualTo(Room.Capacity));
        var before = Spots(room);
        Assert.That(room.Add(Sim("d")), Is.EqualTo(RoomResult.Full));
        Assert.That(room.Members.Select(m => m.Id), Is.EqualTo(new[] { "me", "a", "b", "c" }));
        Assert.That(Spots(room), Is.EqualTo(before));
        Assert.That(room.HostId, Is.EqualTo("me"));
        Assert.That(room.Find("d"), Is.Null);
    }

    private static readonly FishingMode L = FishingMode.Lure, P = FishingMode.Pole, W = FishingMode.Wade;

    private static IEnumerable<TestCaseData> FullRooms()
    {
        var combos = new (string Name, FishingMode[] Modes)[]
        {
            ("全路亚", new[] { L, L, L, L }),
            ("全手竿", new[] { P, P, P, P }),
            ("全摸鱼", new[] { W, W, W, W }),
            ("2 岸 2 水", new[] { L, W, P, W }),
            ("3 岸 1 水", new[] { P, L, W, L }),
        };
        foreach (var map in Maps.All)
            foreach (var (name, modes) in combos)
                yield return new TestCaseData(map.Id, modes).SetDescription($"B3-02 {map.PlaceholderName} 4 人{name}都排得下").SetName($"Room_arranges_four_on_every_map({map.Id},{name})");
    }

    [TestCaseSource(nameof(FullRooms))]
    public void Room_arranges_four_on_every_map(string mapId, FishingMode[] modes)
    {
        var room = Room.Create(Maps, RoomKind.Simulated, Me(modes[0]), mapId, null);
        for (int i = 1; i < modes.Length; i++) Assert.That(room.Add(Sim("f" + i, modes[i])), Is.EqualTo(RoomResult.Ok));
        Assert.That(room.MapId, Is.EqualTo(mapId));
        Assert.That(room.Members, Has.Count.EqualTo(4));
        AssertLayoutValid(room);
    }

    [Test(Description = "B3-03 以成员加入：跟到房主的地图，按本人模式的区域安排、不和房主重叠")]
    public void Join_follows_room_map()
    {
        var host = Sim("h");
        var me = Me();
        var room = Room.Join(Maps, RoomKind.Simulated, host, M2, me);
        Assert.That(room.MapId, Is.EqualTo(M2));
        Assert.That(room.HostId, Is.EqualTo("h"));
        Assert.That(me.Spot, Is.Not.Null);
        Assert.That(me.Spot, Is.Not.EqualTo(host.Spot));
        AssertLayoutValid(room);
    }

    [Test(Description = "B3-04 只有房主能切图：成员请求被拒、什么都不变；房主切换全房跟、模式不变、全部重排")]
    public void Only_host_switches_map()
    {
        var room = NewRoom(L, Sim("a", W), Sim("b", P), Sim("c", L));
        var spots = Spots(room);
        var modes = room.Members.ToDictionary(m => m.Id, m => m.Mode);

        Assert.That(room.SwitchMap("a", M2), Is.EqualTo(RoomResult.NotHost));
        Assert.That(room.MapId, Is.EqualTo(M1));
        Assert.That(Spots(room), Is.EqualTo(spots));

        Assert.That(room.SwitchMap("me", M2), Is.EqualTo(RoomResult.Ok));
        Assert.That(room.MapId, Is.EqualTo(M2));
        Assert.That(room.Members.ToDictionary(m => m.Id, m => m.Mode), Is.EqualTo(modes));
        AssertLayoutValid(room);

        var after = Spots(room);
        Assert.That(room.SwitchMap("me", M2), Is.EqualTo(RoomResult.Unchanged));
        Assert.That(room.SwitchMap("me", "map9"), Is.EqualTo(RoomResult.Unchanged));
        Assert.That(room.MapId, Is.EqualTo(M2));
        Assert.That(Spots(room), Is.EqualTo(after));
        Assert.That(room.SwitchMap("nobody", M1), Is.EqualTo(RoomResult.NotFound));
    }

    [Test(Description = "B3-04 切图后按加入次序重排：房主先排在锚点上")]
    public void Map_switch_rearranges_in_join_order()
    {
        var room = NewRoom(L, Sim("a", L));
        // 先把房主挪开，切图后房主应回到新图锚点（加入最早先排），成员排在旁边
        Assert.That(room.Place("me", new ScenePoint(1200, ShoreY)).Place, Is.EqualTo(PlaceResult.Placed));
        Assert.That(room.SwitchMap("me", M2), Is.EqualTo(RoomResult.Ok));
        var anchor = new SpotPlanner().Arrange(room.Map, L, Enumerable.Empty<ScenePoint>());
        Assert.That(room.Find("me")!.Spot, Is.EqualTo(anchor));
        Assert.That(room.Find("a")!.Spot, Is.Not.EqualTo(anchor));
    }

    [Test(Description = "B3-05 断线立即移除、释放位置；本人能占原位；重新加入排新位置、不挤走本人、次序排最后")]
    public void Disconnect_releases_spot_at_once()
    {
        var room = NewRoom(L, Sim("a", L), Sim("b", W), Sim("c", L));
        var old = room.Find("a")!.Spot!.Value;
        Assert.That(room.Remove("a"), Is.EqualTo(RoomResult.Ok));
        Assert.That(room.Find("a"), Is.Null);
        Assert.That(room.Members, Has.Count.EqualTo(3));
        Assert.That(room.HostId, Is.EqualTo("me"));
        Assert.That(room.Migrating, Is.False);

        Assert.That(room.Place("me", old), Is.EqualTo((RoomResult.Ok, PlaceResult.Placed)));
        var back = Sim("a", L);
        Assert.That(room.Add(back), Is.EqualTo(RoomResult.Ok));
        Assert.That(room.Find("me")!.Spot, Is.EqualTo(old));
        Assert.That(back.Spot, Is.Not.EqualTo(old));
        Assert.That(back.JoinOrder, Is.GreaterThan(room.Members.Where(m => m != back).Max(m => m.JoinOrder)));
        AssertLayoutValid(room);
        Assert.That(room.Remove("a"), Is.EqualTo(RoomResult.Ok));
        Assert.That(room.Remove("a"), Is.EqualTo(RoomResult.NotFound));
    }

    [Test(Description = "B3-06 断线后位置被新成员占满，再重新加入被拒")]
    public void Rejoin_into_full_room_is_refused()
    {
        var room = NewRoom(L, Sim("a"), Sim("b"), Sim("c"));
        room.Remove("a");
        Assert.That(room.Add(Sim("d")), Is.EqualTo(RoomResult.Ok));
        var before = Spots(room);
        Assert.That(room.Add(Sim("a")), Is.EqualTo(RoomResult.Full));
        Assert.That(Spots(room), Is.EqualTo(before));
    }

    [Test(Description = "B3-07 房主离开：迁移中拒绝切图/选位/换模式；成功后加入最早的接任、代次 +1、地图落点不变；旧房主回来是成员")]
    public void Host_leave_migrates_to_earliest_member()
    {
        var host = Sim("h");
        var room = Room.Join(Maps, RoomKind.Simulated, host, M2, Me());
        Assert.That(room.Add(Sim("b", W)), Is.EqualTo(RoomResult.Ok));
        var hostSpot = host.Spot!.Value;

        Assert.That(room.Remove("h"), Is.EqualTo(RoomResult.Ok));
        Assert.That(room.Migrating, Is.True);
        Assert.That(room.HostId, Is.Null);
        Assert.That(room.Host, Is.Null);
        Assert.That(room.Ended, Is.False);
        var spots = Spots(room);
        var me = room.Find("me")!;

        Assert.That(room.SwitchMap("me", M1), Is.EqualTo(RoomResult.Migrating));
        Assert.That(room.Place("me", hostSpot), Is.EqualTo((RoomResult.Migrating, PlaceResult.NoRoom)));
        Assert.That(room.SetMode("me", W), Is.EqualTo(RoomResult.Migrating));
        Assert.That(me.Mode, Is.EqualTo(L));
        Assert.That(room.MapId, Is.EqualTo(M2));
        Assert.That(Spots(room), Is.EqualTo(spots));

        Assert.That(room.CompleteMigration(), Is.SameAs(me));
        Assert.That(room.HostId, Is.EqualTo("me"));
        Assert.That(room.Epoch, Is.EqualTo(2));
        Assert.That(room.Migrating, Is.False);
        Assert.That(room.MapId, Is.EqualTo(M2));
        Assert.That(Spots(room), Is.EqualTo(spots));
        Assert.That(room.CompleteMigration(), Is.Null, "不在迁移中");
        Assert.That(room.Epoch, Is.EqualTo(2));

        Assert.That(room.Add(Sim("h")), Is.EqualTo(RoomResult.Ok));
        Assert.That(room.HostId, Is.EqualTo("me"));
        Assert.That(room.Place("me", hostSpot).Result, Is.EqualTo(RoomResult.Ok), "迁移完可以选位了");
    }

    [Test(Description = "B3-08 迁移失败房间结束；只剩本人时本人接任；没人剩下房间结束")]
    public void Migration_failure_and_last_member()
    {
        var failed = Room.Join(Maps, RoomKind.Simulated, Sim("h"), M1, Me());
        failed.Remove("h");
        failed.FailMigration();
        Assert.That(failed.Ended, Is.True);
        Assert.That(failed.Migrating, Is.False);
        Assert.That(failed.Add(Sim("x")), Is.EqualTo(RoomResult.NotFound), "结束的房间不能再进");
        Assert.That(failed.Place("me", new ScenePoint(800, ShoreY)).Result, Is.EqualTo(RoomResult.NotFound));
        Assert.That(failed.SetMode("me", W), Is.EqualTo(RoomResult.NotFound));
        Assert.That(failed.SwitchMap("me", M2), Is.EqualTo(RoomResult.NotFound));

        var notMigrating = NewRoom();
        notMigrating.FailMigration();
        Assert.That(notMigrating.Ended, Is.False, "不在迁移中时失败不结束房间");

        var alone = Room.Join(Maps, RoomKind.Simulated, Sim("h"), M1, Me());
        alone.Remove("h");
        Assert.That(alone.CompleteMigration()!.Id, Is.EqualTo("me"));
        Assert.That(alone.Ended, Is.False);

        var empty = NewRoom(L, Sim("a"));
        empty.Remove("a");
        Assert.That(empty.Ended, Is.False);
        empty.Remove("me");
        Assert.That(empty.Ended, Is.True);
        Assert.That(empty.HostId, Is.Null);
    }

    [TestCase(980, PlaceResult.Placed, Description = "B3-09 右边正好贴住好友占地框：放得下")]
    [TestCase(979, PlaceResult.NoRoom, Description = "B3-09 右边压进 1：放不下")]
    [TestCase(620, PlaceResult.Placed, Description = "B3-09 左边正好贴住：放得下")]
    [TestCase(621, PlaceResult.NoRoom, Description = "B3-09 左边压进 1：放不下")]
    public void Place_among_members_boundaries(double x, PlaceResult expected)
    {
        var room = Room.Create(Maps, RoomKind.Simulated, Me(), M1, new ScenePoint(300, ShoreY));
        room.Add(Sim("a"));
        Assert.That(room.Place("a", new ScenePoint(800, ShoreY)).Place, Is.EqualTo(PlaceResult.Placed));
        var r = room.Place("me", new ScenePoint(x, ShoreY));
        Assert.That(r, Is.EqualTo((RoomResult.Ok, expected)));
        Assert.That(room.Find("me")!.Spot, Is.EqualTo(expected == PlaceResult.Placed ? new ScenePoint(x, ShoreY) : new ScenePoint(300, ShoreY)));
        Assert.That(room.Find("a")!.Spot, Is.EqualTo(new ScenePoint(800, ShoreY)));
    }

    [Test(Description = "B3-09 房间里点天空不在区域、不动；不在房间里的人选位返回没有这个成员")]
    public void Place_outside_area_in_room()
    {
        var room = Room.Create(Maps, RoomKind.Simulated, Me(), M1, new ScenePoint(300, ShoreY));
        Assert.That(room.Place("me", new ScenePoint(800, 200)), Is.EqualTo((RoomResult.Ok, PlaceResult.NotInArea)));
        Assert.That(room.Find("me")!.Spot, Is.EqualTo(new ScenePoint(300, ShoreY)));
        Assert.That(room.Place("ghost", new ScenePoint(800, ShoreY)).Result, Is.EqualTo(RoomResult.NotFound));
    }

    [Test(Description = "B3-10 房间里换模式：换区域避开别人重排；手竿回岸边重排；路亚、手竿互换不动")]
    public void Mode_switch_in_room_rearranges_by_area()
    {
        var room = NewRoom(L, Sim("a", W));
        var me = room.Find("me")!;
        Assert.That(room.SetMode("me", W), Is.EqualTo(RoomResult.Ok));
        Assert.That(room.Map.Shallow.Contains(me.Spot!.Value), Is.True);
        AssertLayoutValid(room);
        Assert.That(room.SetMode("me", P), Is.EqualTo(RoomResult.Ok));
        Assert.That(room.Map.Shore.Contains(me.Spot!.Value), Is.True);
        // 先挪到不是自动安排首选的位置，再在岸边两种模式之间换：落点不能被重排回首选位
        var shore = new ScenePoint(900, ShoreY);
        Assert.That(room.Place("me", shore), Is.EqualTo((RoomResult.Ok, PlaceResult.Placed)));
        Assert.That(room.SetMode("me", L), Is.EqualTo(RoomResult.Ok));
        Assert.That(me.Spot, Is.EqualTo(shore));
        Assert.That(me.Mode, Is.EqualTo(L));
        Assert.That(room.SetMode("ghost", L), Is.EqualTo(RoomResult.NotFound));
    }

    [Test(Description = "B3-14 成员默认显示基础人物、鱼竿、手套和场景，没设背景缸")]
    public void Member_defaults_to_base_outfit()
    {
        var m = Sim("a");
        Assert.That((m.Character, m.Rod, m.Glove, m.SceneSkin), Is.EqualTo(("BASE_CHAR", "BASE_ROD", "BASE_GLOVE", "BASE_SCENE")));
        Assert.That(m.Tank.TankId, Is.Null);
    }

    [Test(Description = "B3-11 好友收获去重：同一事件、旧代次、已离开成员、迁移前代次都不认")]
    public void Friend_catch_events_are_deduplicated()
    {
        var room = NewRoom(L, Sim("a"), Sim("b"));
        Assert.That(room.AcceptCatch("a", "e1", 1), Is.True);
        Assert.That(room.AcceptCatch("a", "e1", 1), Is.False, "重复");
        Assert.That(room.AcceptCatch("a", "e2", 0), Is.False, "旧代次");
        Assert.That(room.AcceptCatch("a", "e2", 2), Is.False, "未来代次");
        room.Remove("b");
        Assert.That(room.AcceptCatch("b", "e3", 1), Is.False, "已离开");

        var migrated = Room.Join(Maps, RoomKind.Simulated, Sim("h"), M1, Me());
        migrated.Add(Sim("a"));
        migrated.Remove("h");
        migrated.CompleteMigration();
        Assert.That(migrated.AcceptCatch("a", "e4", 1), Is.False, "迁移前代次");
        Assert.That(migrated.AcceptCatch("a", "e5", 2), Is.True);
        migrated.Remove("me");
        migrated.Remove("a");
        Assert.That(migrated.AcceptCatch("a", "e6", 2), Is.False, "房间结束");
    }

    private static TankSnapshot ThreeFish() =>
        new("tank1", new[] { ("TMP_F001", 120), ("TMP_F002", 240), ("TMP_F005", 410) }, 20);

    [Test(Description = "B3-12 共享主题和背景缸跟当前房主；迁移中没有；本人接任后是本人的")]
    public void Shared_scene_follows_host()
    {
        var host = Sim("h");
        host.SceneSkin = "WEB_SCENE_02";
        host.Tank = ThreeFish();
        var room = Room.Join(Maps, RoomKind.Simulated, host, M1, Me());
        Assert.That(room.Host!.SceneSkin, Is.EqualTo("WEB_SCENE_02"));
        Assert.That(room.Host!.Tank.Fish, Has.Count.EqualTo(3));
        room.Remove("h");
        Assert.That(room.Host, Is.Null);
        room.CompleteMigration();
        Assert.That(room.Host!.IsSelf, Is.True);
    }

    [Test(Description = "B3-13 只读鱼缸：有鱼带占用、未设、空缸、离开后不给旧快照")]
    public void Tank_view_states()
    {
        var a = Sim("a");
        a.Tank = ThreeFish();
        var c = Sim("c");
        c.Tank = new TankSnapshot("tank1", Enumerable.Empty<(string, int)>(), 20);
        var room = NewRoom(L, a, Sim("b"), c);

        var (state, tank) = room.ViewTank("a");
        Assert.That(state, Is.EqualTo(TankViewState.Fish));
        Assert.That(tank.Fish, Is.EqualTo(new[] { ("TMP_F001", 120), ("TMP_F002", 240), ("TMP_F005", 410) }));
        Assert.That(tank.Capacity, Is.EqualTo(20));
        Assert.That(room.ViewTank("b").State, Is.EqualTo(TankViewState.NotSet));
        Assert.That(room.ViewTank("c").State, Is.EqualTo(TankViewState.Empty));

        room.Remove("a");
        Assert.That(room.ViewTank("a"), Is.EqualTo((TankViewState.Gone, TankSnapshot.NotSet)));
        var ended = NewRoom(L, Sim("c2"));
        ended.Find("c2")!.Tank = c.Tank;
        ended.End();
        Assert.That(ended.ViewTank("c2").State, Is.EqualTo(TankViewState.Gone), "房间结束了成员还在名单里，也不再给快照");
        room.Remove("b");
        room.Remove("c");
        room.Remove("me");
        Assert.That(room.ViewTank("me").State, Is.EqualTo(TankViewState.Gone), "房间结束");
    }
}
