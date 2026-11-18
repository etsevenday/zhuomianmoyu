using Moyu.Core.Rooms;
using Moyu.Core.Scene;

namespace Moyu.Core.Tests;

/// <summary>
/// B9 协议的细节：建房和进房的先后、离开和接任的账、坏格式。归在用例表的 N 用例下（用例号开头），补变异测试查出的空白。
/// </summary>
public partial class B9CaseTests
{
    private static RoomLink Solo(string id, Func<long>? clock = null) =>
        new(Maps, id, Ver, new MemberProfile { Name = id.ToUpperInvariant() }, clock ?? (() => 0), "n");

    private static readonly Dictionary<string, string> NoProfiles = new();

    private static string ProfileOf(string name, string character = "BASE_CHAR") =>
        RoomWire.Profile(new MemberProfile { Name = name, Character = character });

    [Test(Description = "B9-02 建房：房主写版本、资料、首份快照，出一次进房；成员在快照里见到自己之前不算进房、不发收获和动作；只认一次进房，不把首份快照当换房主")]
    public void Create_and_enter_order()
    {
        Assert.That(Solo("z").IsHost, Is.False, "没进房不是房主");
        var a = Solo("a");
        a.Entered("a", new[] { "a" }, null, null, NoProfiles, M1, null);
        Assert.That(a.IsHost);
        Assert.That(a.Out.Select(o => o.Op), Is.EqualTo(new[] { LinkOp.SetLobbyData, LinkOp.SetMemberData, LinkOp.SetLobbyData }));
        Assert.That(a.Out[0].Text, Is.EqualTo(Ver));
        Assert.That(RoomWire.ParseProfile(a.Out[1].Text)!.Name, Is.EqualTo("A"));
        var first = RoomWire.ParseSnapshot(a.Out[2].Text)!.Value.Snap;
        Assert.That((first.HostId, first.MapId, first.Members.Single().Id), Is.EqualTo(("a", M1, "a")));
        Assert.That(Notes(a, LinkNoteKind.Joined).Single().Name, Is.EqualTo(""));
        a.Out.Clear();

        // b 进房时 a 的快照还没到：只交资料，不算进房、不是房主、不发东西
        var b = Solo("b");
        b.Entered("a", new[] { "a", "b" }, Ver, null, NoProfiles, M1, null);
        Assert.That(b.IsHost, Is.False);
        Assert.That(b.Room!.Members, Is.Empty);
        b.Catch("TMP_F001", 80);
        b.Act();
        Assert.That(b.Out.Select(o => o.Op), Is.EqualTo(new[] { LinkOp.SetMemberData }));
        Assert.That(Notes(b, LinkNoteKind.Joined), Is.Empty);
        a.MemberJoined("b");
        a.MemberData("b", b.Out[0].Text);
        b.Out.Clear();
        var snap = a.Out.Last(o => o.Key == "room").Text;
        b.LobbyData(snap);
        Assert.That(Notes(b, LinkNoteKind.Joined).Count(), Is.EqualTo(1));
        Assert.That(Notes(b, LinkNoteKind.NewHost), Is.Empty, "首份快照不是换房主");
        Assert.That(Notes(b, LinkNoteKind.Rejoined), Is.Empty, "第一次见到的人不是重新加入");
        // 还没收到 a 的资料：名字空、基础外观；联机房里没有模拟成员
        var aSeen = b.Room.Find("a")!;
        Assert.That((aSeen.Name, aSeen.Character, aSeen.Rod, aSeen.Glove, aSeen.SceneSkin), Is.EqualTo(("", "BASE_CHAR", "BASE_ROD", "BASE_GLOVE", "BASE_SCENE")));
        Assert.That(b.Room.Members.Any(m => m.IsSimulated), Is.False);
        // 坏资料不认；好资料随即改上、出一次变化
        b.Notes.Clear();
        b.MemberData("a", "P1|坏");
        Assert.That(aSeen.Name, Is.EqualTo(""));
        b.MemberData("a", ProfileOf("小A", "WEB_CHAR_02"));
        Assert.That((aSeen.Name, aSeen.Character), Is.EqualTo(("小A", "WEB_CHAR_02")));
        Assert.That(Notes(b, LinkNoteKind.Changed).Count(), Is.EqualTo(1));
        // 后面的快照不再出进房
        a.Notes.Clear();
        a.SwitchMap(M2);
        Assert.That(Notes(a, LinkNoteKind.Changed).Count(), Is.EqualTo(1), "房主发快照时自己也重画");
        b.LobbyData(a.Out.Last(o => o.Key == "room").Text);
        Assert.That(b.Room.MapId, Is.EqualTo(M2));
        Assert.That(Notes(b, LinkNoteKind.Joined), Is.Empty);
    }

    [Test(Description = "B9-02 资料和进房通知谁先到都能加人；成员收到进房通知不自己加人；没进房时收到资料、快照不出错")]
    public void Join_notice_and_profile_in_either_order()
    {
        var lobby = Four("a", "b");
        var a = lobby.Links["a"];
        var b = lobby.Links["b"];
        a.MemberData("e", ProfileOf("E"));
        b.MemberData("e", ProfileOf("E"));
        Assert.That(a.Room!.Find("e"), Is.Null, "还没进房间服务的人不加");
        a.MemberJoined("e");
        b.MemberJoined("e");
        Assert.That(a.Room.Find("e")!.Name, Is.EqualTo("E"));
        Assert.That(b.Room!.Find("e"), Is.Null, "成员只按快照改镜像");
        Assert.That(Notes(a, LinkNoteKind.Rejoined), Is.Empty);

        var z = Solo("z");
        Assert.DoesNotThrow(() =>
        {
            z.MemberData("a", ProfileOf("A"));
            z.LobbyData(lobby.Data["room"]);
            z.Catch("TMP_F001", 80);
        });
        Assert.That((z.Room, z.Out.Count), Is.EqualTo(((Room?)null, 0)));
    }

    [Test(Description = "B9-03 房主不看快照：房间数据里来一份修订更新的也不改权威房间")]
    public void Host_ignores_snapshots()
    {
        var lobby = Four("a", "b");
        var a = lobby.Links["a"];
        var forged = RoomWire.Snapshot(new RoomSnapshot(1, "a", M2, a.Room!.Snapshot().Members), 999);
        a.LobbyData(forged);
        Assert.That(a.Room.MapId, Is.EqualTo(M1));
    }

    [Test(Description = "B9-08 离开的账：不在房间的人离开不出提示、本人的离开通知不理；成员当场移除并刷新，房主发新快照；重进的人要等新资料才加，请求号从头数也照常执行")]
    public void Leaving_bookkeeping()
    {
        var lobby = Four();
        var a = lobby.Links["a"];
        var c = lobby.Links["c"];
        a.MemberLeft("e", true);
        a.MemberLeft("a", false);
        Assert.That(a.Notes, Is.Empty);
        Assert.That(a.Out, Is.Empty);
        Assert.That((a.IsHost, a.Room!.Members.Count), Is.EqualTo((true, 4)));

        // b 先发过一条选位请求（请求号 1）
        var b = lobby.Links["b"];
        b.Place(FreeShorePoint(a.Room));
        lobby.Run();
        lobby.ClearNotes();
        // c 自己先收到"b 离开"：当场移除、出变化、不发东西
        c.MemberLeft("b", false);
        Assert.That(c.Room!.Find("b"), Is.Null);
        Assert.That(Notes(c, LinkNoteKind.Changed).Count(), Is.EqualTo(1));
        Assert.That(c.Out, Is.Empty);
        lobby.Remove("b", dropped: false);
        var before = lobby.Data["room"];
        lobby.Run();
        Assert.That(lobby.Data["room"], Is.Not.EqualTo(before), "房主移除后发新快照");
        // 进房通知先到、新资料没到：不拿旧资料把人加回来
        a.MemberJoined("b");
        Assert.That(a.Room.Find("b"), Is.Null);
        // b 重进（新连接，请求号从 1 数）
        var b2 = lobby.Enter("b");
        Assert.That(b2, Is.Not.SameAs(b));
        Assert.That(Notes(a, LinkNoteKind.Rejoined).Single().Name, Is.EqualTo("B"));
        var q = FreeShorePoint(a.Room);
        b2.Place(q);
        lobby.Run();
        Assert.That(a.Room.Find("b")!.Spot, Is.EqualTo(q), "重进后的请求 1 不能当成旧请求");
        AssertConverged(lobby);
    }

    [Test(Description = "B9-09 接任时补上迁移前进了服务、还没被加进房间的人")]
    public void Take_over_adds_waiting_members()
    {
        var lobby = Four("a", "b");
        var b = new RoomLink(Maps, "b", Ver, new MemberProfile { Name = "B" }, () => 0, "n2");
        // b 进房时服务里已有 e（a 还没来得及加），e 的资料也在
        b.Entered("a", new[] { "a", "e", "b" }, Ver, lobby.Data["room"], new Dictionary<string, string> { ["e"] = ProfileOf("E") }, M1, null);
        Assert.That(b.Room!.Find("b"), Is.Not.Null);
        Assert.That(b.Room.Find("e"), Is.Null);
        b.MemberLeft("a", true);
        b.OwnerChanged("b");
        Assert.That(b.IsHost);
        Assert.That(b.Room.Find("e")?.Name, Is.EqualTo("E"));
        Assert.That(Notes(b, LinkNoteKind.Rejoined), Is.Empty);
    }

    [Test(Description = "B9-07 格式不全的请求、回复、收获都不理，不出错")]
    public void Truncated_messages_are_ignored()
    {
        var lobby = Four("a", "b");
        var a = lobby.Links["a"];
        var b = lobby.Links["b"];
        var host = a.Room!;
        var bSpot = host.Find("b")!.Spot;
        foreach (var bad in new[] { "Q|1", $"Q|1|1|{M1}|place|5", $"Q|2|1|{M1}|place|x|565", $"Q|3|1|{M1}|place|300|y", $"Q|4|1|{M1}|mode|Fly", $"Q|5|1|{M1}|jump|Wade" })
            Assert.DoesNotThrow(() => a.Message("b", bad), bad);
        Assert.That(a.Out, Is.Empty);
        Assert.That((host.Find("b")!.Spot, host.Find("b")!.Mode), Is.EqualTo((bSpot, FishingMode.Lure)));

        b.Place(FreeShorePoint(host));
        foreach (var bad in new[] { "A|1", "A|1|Ok" })
            Assert.DoesNotThrow(() => b.Message("a", bad), bad);
        foreach (var bad in new[] { "C|a-n-1|1", "C|a-n-1|1|TMP_F001|长", "C|a-n-2|x|TMP_F001|80" })
            Assert.DoesNotThrow(() => b.Message("a", bad), bad);
        Assert.That(b.Notes, Is.Empty);
        // 正经的回复还能对上
        lobby.Run();
        Assert.That(Notes(b, LinkNoteKind.PlaceResult).Single().Place, Is.EqualTo(PlaceResult.Placed));
    }

    [Test(Description = "B9-02 线上格式：快照里的空房主、没落点、特殊字符、小数坐标往返不变；资料的空缸和带鱼的缸往返不变；坏的整条不认")]
    public void Wire_format_round_trips()
    {
        var snap = new RoomSnapshot(3, null, M2, new[]
        {
            new RoomSnapshot.Entry("a", 0, FishingMode.Lure, null),
            new RoomSnapshot.Entry("b|;,%", 2, FishingMode.Wade, new ScenePoint(301.25, 565.5)),
        });
        var (back, rev) = RoomWire.ParseSnapshot(RoomWire.Snapshot(snap, 4))!.Value;
        Assert.That((back.Epoch, back.HostId, back.MapId, rev), Is.EqualTo((3, (string?)null, M2, 4)));
        Assert.That(back.Members.Select(e => (e.Id, e.JoinOrder, e.Mode, e.Spot)),
            Is.EqualTo(snap.Members.Select(e => (e.Id, e.JoinOrder, e.Mode, e.Spot))));

        foreach (var bad in new[] { "S2|1|1|a|m|", "S1|1|1|a|m", "S1|x|1|a|m|", "S1|1|x|a|m|", "S1|1|1|a|m|a,0,Lure,1", "S1|1|1|a|m|a,x,Lure,,",
                     "S1|1|1|a|m|a,0,Fly,,", "S1|1|1|a|m|a,0,Lure,x,5", "S1|1|1|a|m|a,0,Lure,5,x", "S1|1|1|a|m|a,0,Lure,,5" })
            Assert.That(RoomWire.ParseSnapshot(bad), Is.Null, bad);

        var bare = RoomWire.ParseProfile(RoomWire.Profile(new MemberProfile { Name = "小|C:,", Mode = FishingMode.Pole }))!;
        Assert.That((bare.Name, bare.Mode, bare.Character, bare.SceneSkin), Is.EqualTo(("小|C:,", FishingMode.Pole, "BASE_CHAR", "BASE_SCENE")));
        Assert.That(bare.Tank, Is.SameAs(TankSnapshot.NotSet), "没设背景缸往返后还是没设");
        var full = new MemberProfile { Name = "C", Rod = "R2", Glove = "G3", Tank = new TankSnapshot("缸|1", new[] { ("TMP_F001", 84), ("TMP:F2", 163) }, 20) };
        var t = RoomWire.ParseProfile(RoomWire.Profile(full))!;
        Assert.That((t.Rod, t.Glove, t.Tank.TankId, t.Tank.Capacity), Is.EqualTo(("R2", "G3", "缸|1", 20)));
        Assert.That(t.Tank.Fish, Is.EqualTo(full.Tank.Fish));
        // 空缸（设了缸、没鱼）不是没设
        Assert.That(RoomWire.ParseProfile(RoomWire.Profile(new MemberProfile { Tank = new TankSnapshot("t", Array.Empty<(string, int)>(), 20) }))!.Tank.TankId, Is.EqualTo("t"));

        foreach (var bad in new[] { "P2|a|Lure|c|r|g|s||0|", "P1|a|Fly|c|r|g|s||0|", "P1|a|Lure|c|r|g|s||x|", "P1|a|Lure|c|r|g|s|t|20|F1", "P1|a|Lure|c|r|g|s|t|20|F1:x" })
            Assert.That(RoomWire.ParseProfile(bad), Is.Null, bad);
    }
}
