using Moyu.Core.Rooms;

namespace Moyu.Core.Tests;

/// <summary>
/// B10 用例表（doc/测试用例/B10 Steam 联机.md）里方式为 N 的用例：Steam 房间状态整理成页面事件（LobbyTracker）。
/// Steam 的回调只说"有东西变了"，小程序每次读整份状态交给它；这里喂各种整份状态，看报出去的事件。
/// </summary>
public class B10CaseTests
{
    private const string L1 = "L1";

    private static Dictionary<string, string> Data(params (string Id, string Text)[] kv) => kv.ToDictionary(x => x.Id, x => x.Text);

    private static LobbyTracker InRoom(out LobbyTracker t)
    {
        t = new LobbyTracker("me");
        t.Entered(L1, "a", new[] { "a", "b", "me" }, "v1", "S1|1|1", Data(("a", "PA"), ("b", "PB")));
        t.Out.Clear();
        return t;
    }

    private static string[] Types(LobbyTracker t) => t.Out.Select(e => e.Type).ToArray();

    [Test(Description = "B10-01 进房事件：房间号、所有者、成员含本人、ver、room、别人的资料；没写的是 null；同样的状态再整理不出东西")]
    public void Entered_reports_the_whole_room()
    {
        var t = new LobbyTracker("me");
        t.Entered(L1, "a", new[] { "a", "b", "c" }, "v1", "S1|1|1", Data(("a", "PA"), ("b", "PB"), ("me", "PM"), ("x", "PX"), ("c", "")));
        var e = t.Out.Single();
        Assert.That((e.Type, e.Lobby, e.Owner, e.Ver, e.Room), Is.EqualTo(("entered", L1, "a", "v1", "S1|1|1")));
        Assert.That(e.Members, Is.EquivalentTo(new[] { "a", "b", "c", "me" }));
        Assert.That(e.MemberData, Is.EquivalentTo(Data(("a", "PA"), ("b", "PB"))), "本人的、不在房间的、空的都不带");
        Assert.That(t.Lobby, Is.EqualTo(L1));
        t.Out.Clear();
        t.Refresh(L1, "a", "S1|1|1", Data(("a", "PA"), ("b", "PB"), ("c", "")));
        Assert.That(t.Out, Is.Empty);

        var fresh = new LobbyTracker("me");
        fresh.Entered("L2", "me", new[] { "me" }, "", "", Data());
        var f = fresh.Out.Single();
        Assert.That((f.Ver, f.Room, f.MemberData!.Count), Is.EqualTo(((string?)null, (string?)null, 0)));
    }

    [TestCase("full", Description = "B10-02 进房失败报满员")]
    [TestCase("gone", Description = "B10-02 进房失败报房间不在了")]
    [TestCase("failed", Description = "B10-02 进房失败报其他原因")]
    [TestCase("create", Description = "B10-02 建房失败")]
    public void Enter_failures_carry_the_reason(string reason)
    {
        var t = new LobbyTracker("me");
        t.EnterFailed(reason);
        Assert.That(t.Out.Select(e => (e.Type, e.Reason)), Is.EqualTo(new[] { ("enterFailed", reason) }));
        Assert.That(t.Lobby, Is.Null);
    }

    [Test(Description = "B10-03 成员进出：进来、正常离开、掉线；本人和不在房间的人不报，重复的不报")]
    public void Member_changes()
    {
        InRoom(out var t);
        t.MemberChanged(L1, "c", LobbyChange.Entered);
        t.MemberChanged(L1, "c", LobbyChange.Entered);
        t.MemberChanged(L1, "b", LobbyChange.Left);
        t.MemberChanged(L1, "c", LobbyChange.Dropped);
        t.MemberChanged(L1, "z", LobbyChange.Dropped);
        t.MemberChanged(L1, "me", LobbyChange.Left);
        Assert.That(t.Out.Select(e => (e.Type, e.Id, e.Dropped)), Is.EqualTo(new[]
        {
            ("memberJoined", (string?)"c", false), ("memberLeft", "b", false), ("memberLeft", "c", true),
        }));
        // 走了的人回来，他的资料按新的报
        t.Out.Clear();
        t.MemberChanged(L1, "b", LobbyChange.Entered);
        t.Refresh(L1, "a", "S1|1|1", Data(("a", "PA"), ("b", "PB")));
        Assert.That(t.Out.Select(e => (e.Type, e.Id, e.Text)), Is.EqualTo(new[] { ("memberJoined", (string?)"b", (string?)null), ("memberData", "b", "PB") }));
    }

    [TestCase(true, Description = "B10-04 所有者变了只报一次（先到离开）")]
    [TestCase(false, Description = "B10-04 所有者变了只报一次（先到所有者变了）")]
    public void Owner_change_is_reported_once(bool leftFirst)
    {
        InRoom(out var t);
        if (leftFirst) t.MemberChanged(L1, "a", LobbyChange.Dropped);
        t.Refresh(L1, "b", "S1|1|1", Data(("b", "PB")));
        t.Refresh(L1, "b", "S1|1|1", Data(("b", "PB")));
        if (!leftFirst) t.MemberChanged(L1, "a", LobbyChange.Dropped);
        t.Refresh(L1, "b", "S1|1|1", Data(("b", "PB")));
        var expected = leftFirst ? new[] { "memberLeft", "ownerChanged" } : new[] { "ownerChanged", "memberLeft" };
        Assert.That(Types(t), Is.EqualTo(expected));
        Assert.That(t.Out.Single(e => e.Type == "ownerChanged").Owner, Is.EqualTo("b"));
    }

    [Test(Description = "B10-05 房间数据、成员资料只报变化；本人的、空的不报；ver 不报")]
    public void Only_changes_are_reported()
    {
        InRoom(out var t);
        t.Refresh(L1, "a", "S1|1|1", Data(("a", "PA"), ("b", "PB"), ("me", "PM")));
        Assert.That(t.Out, Is.Empty, "值一样、本人的都不报");
        t.Refresh(L1, "a", "S1|1|2", Data(("a", "PA"), ("b", "PB2")));
        t.Refresh(L1, "a", "S1|1|2", Data(("a", "PA"), ("b", "PB2")));
        t.Refresh(L1, "a", "", Data(("a", ""), ("b", "PB2")));
        Assert.That(t.Out.Select(e => (e.Type, e.Key, e.Id, e.Text)), Is.EqualTo(new[]
        {
            ("lobbyData", (string?)"room", (string?)null, (string?)"S1|1|2"), ("memberData", null, "b", "PB2"),
        }));
    }

    [Test(Description = "B10-06 离开后旧房间迟到的进出、更新都不报；进新房间按新房间整理")]
    public void Nothing_after_leaving()
    {
        InRoom(out var t);
        t.Left();
        Assert.That(t.Lobby, Is.Null);
        t.MemberChanged(L1, "c", LobbyChange.Entered);
        t.MemberChanged(L1, "a", LobbyChange.Left);
        t.Refresh(L1, "b", "S1|2|1", Data(("b", "PB2")));
        Assert.That(t.Out, Is.Empty);
        t.Entered("L2", "c", new[] { "c" }, "v1", "S1|1|1", Data(("c", "PC")));
        t.MemberChanged(L1, "d", LobbyChange.Entered);
        t.MemberChanged("L2", "a", LobbyChange.Left);
        t.Refresh("L2", "c", "S1|1|1", Data(("c", "PC")));
        Assert.That(Types(t), Is.EqualTo(new[] { "entered" }), "旧房间的不认；新房间里没有 a，同样的状态不报");
    }

    [Test(Description = "B10-06 没先离开就进了另一个房间：成员、资料按新房间算，旧房间的不带过去")]
    public void Entering_another_room_starts_fresh()
    {
        InRoom(out var t);
        t.Entered("L2", "c", new[] { "c", "b" }, "v1", "S1|1|1", Data(("c", "PC")));
        var e = t.Out.Single();
        Assert.That(e.Members, Is.EquivalentTo(new[] { "c", "b", "me" }));
        Assert.That(e.MemberData, Is.EquivalentTo(Data(("c", "PC"))));
        t.Out.Clear();
        t.Refresh("L2", "c", "S1|1|1", Data(("c", "PC"), ("b", "PB")));
        t.MemberChanged("L2", "a", LobbyChange.Entered);
        Assert.That(t.Out.Select(x => (x.Type, x.Id)), Is.EqualTo(new[] { ("memberData", (string?)"b"), ("memberJoined", "a") }),
            "b 在新房间里第一次写资料要报；a 不在新房间，进来要报");
    }

    [Test(Description = "B10-07 好友：离线不列；同一 App 且带本游戏标记才算正在玩；按名字排；没变不报")]
    public void Friend_states()
    {
        var t = new LobbyTracker("me");
        var all = new[]
        {
            new SteamFriend("5", "Eve", false, true, true),     // 离线
            new SteamFriend("4", "Dan", true, true, false),     // 480 上玩 Spacewar，没有本游戏标记
            new SteamFriend("3", "Cat", true, false, true),     // 玩别的游戏
            new SteamFriend("2", "Bob", true, true, true),      // 正在玩本游戏
            new SteamFriend("6", "Amy", true, false, false),    // 同名的按 Id 排
            new SteamFriend("1", "Amy", true, false, false),    // 在线
        };
        t.Friends(all);
        var ev = t.Out.Single();
        Assert.That(ev.Type, Is.EqualTo("friends"));
        Assert.That(ev.Friends!.Select(f => (f.Id, f.Name, f.Playing)), Is.EqualTo(new[]
        {
            ("1", "Amy", false), ("6", "Amy", false), ("2", "Bob", true), ("3", "Cat", false), ("4", "Dan", false),
        }));
        t.Out.Clear();
        t.Friends(all.Reverse());
        Assert.That(t.Out, Is.Empty, "没变不报");
        t.Friends(all.Select(f => f.Id == "4" ? new SteamFriend("4", "Dan", true, true, true) : f));
        Assert.That(t.Out.Single().Friends!.Single(f => f.Id == "4").Playing, Is.True);
        t.Out.Clear();
        t.Friends(Array.Empty<SteamFriend>());
        t.Friends(new[] { all[0] });
        Assert.That(t.Out.Select(e => e.Friends!.Count), Is.EqualTo(new[] { 0 }), "空列表报一次，之后仍空不再报");
    }
}
