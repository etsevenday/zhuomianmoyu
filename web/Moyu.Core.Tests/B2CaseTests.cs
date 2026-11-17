using System.Text.Json;
using System.Text.Json.Serialization;
using Moyu.Core.Desktop;
using Moyu.Core.Engine;
using Moyu.Core.Play;
using Moyu.Core.Scene;
using Moyu.Core.State;

namespace Moyu.Core.Tests;

/// <summary>
/// B2 用例表（doc/测试用例/B2 答复接入.md）里方式含 N 的用例：手竿计时、新鱼表、旧档升级、设置演示开关。
/// </summary>
public class B2CaseTests
{
    private const string M1 = MapCatalog.Pond;
    private const string M2 = MapCatalog.Stream;
    private const long Interval = CaptureRules.PoleIntervalMs;
    private const long Gap = CaptureRules.PoleMaxCheckGapMs;
    private static FishCatalog Fish => FishCatalog.CreateTemporary();
    private static SkinCatalog Skins => SkinCatalog.CreateFirstBatch();
    private static readonly JsonSerializerOptions Json = new() { Converters = { new JsonStringEnumConverter() } };

    private static PlayEngine NewEngine(ulong seed = 1) =>
        new PlayEngine(PlayEngine.NewProfile("test", seed, Skins), Fish, Skins);

    /// <summary>按每段 ≤5 分钟一段段记 total 毫秒，返回期间出的鱼。</summary>
    private static List<FishRecord> Wait(PlayEngine e, string map, long total, long now = 1000)
    {
        var fish = new List<FishRecord>();
        while (total > 0)
        {
            long step = Math.Min(Gap, total);
            if (e.AddPoleTime(map, step, now).Catch is { } f) fish.Add(f);
            total -= step;
        }
        return fish;
    }

    // ---------- 手竿计时 ----------

    [Test(Description = "B2-01 WC-06：差 1 毫秒不出；满 30 分钟正好 1 条、余 0；1801000 结算后余 1000；不改输入次数")]
    public void Pole_catches_at_thirty_minutes()
    {
        var e = NewEngine();
        Assert.That(Wait(e, M1, Interval - 1), Is.Empty);
        Assert.That(e.PoleElapsed(M1), Is.EqualTo(Interval - 1));
        var r = e.AddPoleTime(M1, 1, 5000);
        Assert.That(r.Catch, Is.Not.Null);
        Assert.That(r.GapExcluded, Is.False);
        Assert.That(e.PoleElapsed(M1), Is.EqualTo(0));
        Assert.That(e.Profile.Fish, Has.Count.EqualTo(1));

        var e2 = NewEngine();
        Assert.That(Wait(e2, M1, Interval + 1000), Has.Count.EqualTo(1));
        Assert.That(e2.PoleElapsed(M1), Is.EqualTo(1000));
        Assert.That(e2.Profile.Groups["pole|map1"].Cycle, Is.EqualTo(1));
        Assert.That(e2.Profile.LifetimeInputs, Is.EqualTo(0));
        Assert.That(e2.Profile.ModeInputs, Is.Empty);
        // 一个周期跨两段时，余数正好带进下一轮，再满 30 分钟才出第二条
        Assert.That(Wait(e2, M1, Interval - 1001), Is.Empty);
        Assert.That(Wait(e2, M1, 1), Has.Count.EqualTo(1));
        Assert.That(e2.PoleElapsed(M1), Is.EqualTo(0));
    }

    [Test(Description = "B2-02 WC-08：5 分钟整段计入，多 1 毫秒整段不计（不封顶）；时间倒退不减不出")]
    public void Pole_gap_boundaries()
    {
        var e = NewEngine();
        var clock = new PoleClock();
        Assert.That(clock.Check(e, M1, 10_000), Is.Null, "第一次检查只建锚点");
        Assert.That(clock.MapId, Is.EqualTo(M1));

        var r = clock.Check(e, M1, 10_000 + Gap)!;
        Assert.That(r.GapExcluded, Is.False);
        Assert.That(e.PoleElapsed(M1), Is.EqualTo(Gap));

        r = clock.Check(e, M1, 10_000 + Gap + Gap + 1)!;
        Assert.That(r.GapExcluded, Is.True);
        Assert.That(e.PoleElapsed(M1), Is.EqualTo(Gap), "超过 5 分钟的一段一毫秒都不算");

        r = clock.Check(e, M1, 10_000 + Gap + Gap + 1 - 5000)!;
        Assert.That(r.GapExcluded, Is.False);
        Assert.That(r.Catch, Is.Null);
        Assert.That(e.PoleElapsed(M1), Is.EqualTo(Gap), "倒退不减");

        clock.Check(e, M1, 10_000 + Gap + Gap + 1 - 5000 + 1234);
        Assert.That(e.PoleElapsed(M1), Is.EqualTo(Gap + 1234), "倒退后从新锚点接着计");

        // 引擎直接给的间隔：0 不建组，负数不计
        var e2 = NewEngine();
        Assert.That(e2.AddPoleTime(M1, 0, 0).Catch, Is.Null);
        Assert.That(e2.AddPoleTime(M1, -1, 0).GapExcluded, Is.False);
        Assert.That(e2.Profile.Groups, Is.Empty);
        Assert.That(e2.AddPoleTime(M1, Gap + 1, 0).GapExcluded, Is.True);
        Assert.That(e2.Profile.Groups, Is.Empty);
    }

    [Test(Description = "B2-03 WC-07：各图手竿时间分开存；切走不涨、切回接着计；临界出的鱼属于切换前的地图")]
    public void Pole_progress_is_per_map_and_settles_before_switch()
    {
        var e = NewEngine();
        var clock = new PoleClock();
        long t = 0;
        clock.Check(e, M1, t);
        for (int i = 0; i < 4; i++) clock.Check(e, M1, t += Gap);   // 地图一 20 分钟
        clock.Check(e, M2, t += 1000);                              // 切地图二时这 1 秒结给地图一
        Assert.That(e.PoleElapsed(M1), Is.EqualTo(4 * Gap + 1000));
        clock.Check(e, M2, t += Gap);                               // 地图二 5 分钟
        clock.Check(e, null, t += 1000);                            // 切路亚：这 1 秒结给地图二，之后不计
        Assert.That(clock.MapId, Is.Null);
        clock.Check(e, null, t += Gap);
        Assert.That(clock.Check(e, null, t += 10 * Gap), Is.Null, "不计时期间检查什么都不结");
        Assert.That(e.PoleElapsed(M1), Is.EqualTo(4 * Gap + 1000));
        Assert.That(e.PoleElapsed(M2), Is.EqualTo(Gap + 1000));
        clock.Check(e, M1, t += 1);
        clock.Check(e, M1, t += 2000);
        Assert.That(e.PoleElapsed(M1), Is.EqualTo(4 * Gap + 3000), "切回接着计，不清空");

        // 临界：地图一差 1 秒，过 2 秒后切到地图二——这 2 秒先结给地图一
        var c = NewEngine();
        Wait(c, M1, Interval - 1000);
        var k = new PoleClock();
        k.Check(c, M1, 0);
        var r = k.Check(c, M2, 2000)!;
        Assert.That(r.Catch!.MapId, Is.EqualTo(M1));
        Assert.That(c.PoleElapsed(M1), Is.EqualTo(1000));
        Assert.That(c.PoleElapsed(M2), Is.EqualTo(0));
        Assert.That(k.MapId, Is.EqualTo(M2));
    }

    [Test(Description = "B2-04 05 §1.1：手竿鱼用本图鱼池、来源正常、不带保底，进纪录和新鱼表；手竿下按键不改手竿时间")]
    public void Pole_fish_fields_and_input_does_not_speed_up()
    {
        var e = NewEngine(7);
        Wait(e, M1, Interval / 2);
        for (int i = 0; i < 1000; i++) Assert.That(e.Input(FishingMode.Pole, M1, 0).Catch, Is.Null);
        Assert.That(e.PoleElapsed(M1), Is.EqualTo(Interval / 2));
        Assert.That(e.ModeInputs(FishingMode.Pole), Is.EqualTo(1000));

        var f = Wait(e, M1, Interval / 2, now: 4242).Single();
        Assert.That(f.CatchEventId, Is.EqualTo("catch|pole|map1|0"));
        Assert.That(f.Mode, Is.EqualTo("pole"));
        Assert.That(f.MapId, Is.EqualTo(M1));
        Assert.That(f.CaughtAtMs, Is.EqualTo(4242));
        Assert.That(f.Source, Is.EqualTo(CatchSource.Normal));
        Assert.That(f.Guaranteed, Is.False);
        Assert.That(f.Place, Is.EqualTo(FishPlace.Basket));
        Assert.That(Fish.Pool(M1).Select(s => s.Id), Does.Contain(f.SpeciesId));
        Assert.That(e.Profile.Records[f.SpeciesId].Count, Is.EqualTo(1));
        Assert.That(e.Profile.NewFishIds, Is.EqualTo(new[] { f.Id }));
        Assert.That(e.Profile.LifetimeInputs, Is.EqualTo(1000), "出鱼不加输入次数");

        // 第二周期的键带周期号；地图二另一套
        Assert.That(Wait(e, M1, Interval).Single().CatchEventId, Is.EqualTo("catch|pole|map1|1"));
        Assert.That(Wait(e, M2, Interval).Single().CatchEventId, Is.EqualTo("catch|pole|map2|0"));
        // 地图三连出 300 条：只出本图鱼池里的鱼
        var m3 = NewEngine(3);
        var species = Wait(m3, MapCatalog.Bay, 300 * Interval).Select(x => x.SpeciesId).Distinct();
        Assert.That(species, Is.SubsetOf(Fish.Pool(MapCatalog.Bay).Select(s => s.Id)));
    }

    [Test(Description = "B2-05 WC-09：同种子同样的时间出一样的鱼；存档失败从旧档重走不重抽、不多发")]
    public void Pole_outcomes_are_reproducible()
    {
        string Run(PlayEngine e) => string.Join(";", Wait(e, M1, 3 * Interval).Select(f => $"{f.SpeciesId}/{f.LengthMm}"));
        Assert.That(Run(NewEngine(42)), Is.EqualTo(Run(NewEngine(42))));
        Assert.That(Run(NewEngine(42)), Is.Not.EqualTo(Run(NewEngine(43))));

        var e = NewEngine(42);
        Wait(e, M1, Interval - 10);
        var saved = JsonSerializer.Serialize(e.Profile, Json);
        var first = e.AddPoleTime(M1, 10, 0).Catch!;
        var retry = new PlayEngine(JsonSerializer.Deserialize<Profile>(saved, Json)!, Fish, Skins);
        var again = retry.AddPoleTime(M1, 10, 0).Catch!;
        Assert.That((again.Id, again.SpeciesId, again.LengthMm, again.CatchEventId), Is.EqualTo((first.Id, first.SpeciesId, first.LengthMm, first.CatchEventId)));
        Assert.That(retry.Profile.Fish, Has.Count.EqualTo(1));
    }

    // ---------- 旧档升级 ----------

    /// <summary>一份 B1（版本 1）的档：没有手竿时间、没有新鱼表，设过背景、有鱼有钱有纪录。</summary>
    private static string B1ProfileJson()
    {
        var e = NewEngine(5);
        for (int i = 0; i < 1000; i++) e.Input(FishingMode.Lure, M1, 0);
        var tankFish = e.DevInjectFish(M1, 0);
        e.Collect(tankFish.Id, PlayEngine.FirstTankId);
        e.SetBackground(PlayEngine.FirstTankId);
        e.DevAddCoins(300, 0);
        e.Draw("d1", 0);
        for (int i = 0; i < 77; i++) e.Input(FishingMode.Wade, M2, 0);
        var node = System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(e.Profile, Json))!.AsObject();
        node["Schema"] = 1;
        node["RulesVersion"] = "web_core_0.1";
        node.Remove("NewFishIds");
        foreach (var g in node["Groups"]!.AsObject()) g.Value!.AsObject().Remove("ElapsedMs");
        return node.ToJsonString();
    }

    [Test(Description = "B2-06 WC-09、WA-10：B1 的档读进来升到版本 2，手竿各图 0 毫秒、新鱼 0，其余资产与背景原样")]
    public void Old_b1_profile_upgrades()
    {
        var json = B1ProfileJson();
        var p = JsonSerializer.Deserialize<Profile>(json, Json)!;
        var before = JsonSerializer.Serialize(p, Json);
        Assert.That(PlayEngine.Validate(p, Fish, Skins), Is.EqualTo("存档版本不认识"), "升级前不能直接用");
        PlayEngine.Upgrade(p);
        Assert.That(PlayEngine.Validate(p, Fish, Skins), Is.Null);
        Assert.That(p.Schema, Is.EqualTo(2));
        Assert.That(p.RulesVersion, Is.EqualTo("web_core_0.2"));
        Assert.That(p.NewFishIds, Is.Empty, "旧鱼不补标新");
        var e = new PlayEngine(p, Fish, Skins);
        Assert.That(e.PoleElapsed(M1), Is.EqualTo(0));
        Assert.That(e.PoleElapsed(M2), Is.EqualTo(0));
        Assert.That(p.BackgroundTankId, Is.EqualTo(PlayEngine.FirstTankId));
        Assert.That(e.InTank(PlayEngine.FirstTankId).Count(), Is.EqualTo(1));
        Assert.That(e.CycleCount(FishingMode.Wade, M2), Is.EqualTo(77));
        // 除了版本号和两个新字段，其余逐字段不变
        string Strip(Profile x)
        {
            var n = System.Text.Json.Nodes.JsonNode.Parse(JsonSerializer.Serialize(x, Json))!.AsObject();
            n.Remove("Schema");
            n.Remove("RulesVersion");
            n.Remove("NewFishIds");
            foreach (var g in n["Groups"]!.AsObject()) g.Value!.AsObject().Remove("ElapsedMs");
            return n.ToJsonString();
        }
        Assert.That(Strip(p), Is.EqualTo(Strip(JsonSerializer.Deserialize<Profile>(before, Json)!)));

        // 当前版本和不认识的版本都不动
        var cur = NewEngine().Profile;
        PlayEngine.Upgrade(cur);
        Assert.That(cur.Schema, Is.EqualTo(2));
        var future = NewEngine().Profile;
        future.Schema = 3;
        future.RulesVersion = "x";
        PlayEngine.Upgrade(future);
        Assert.That((future.Schema, future.RulesVersion), Is.EqualTo((3, "x")));
        PlayEngine.Upgrade(null);
    }

    [Test(Description = "B2-06 03 §5：手竿时间越界、新鱼表为空的档拒绝；边界 0 和 1799999 合法")]
    public void Bad_pole_and_new_fish_fields_are_rejected()
    {
        Profile Good() => NewEngine().Profile;
        var cases = new (string, Action<Profile>, string)[]
        {
            ("手竿时间为负", p => p.Groups["pole|map1"] = new ProgressGroup { ElapsedMs = -1 }, "手竿时间越界"),
            ("手竿时间满一轮没结", p => p.Groups["pole|map1"] = new ProgressGroup { ElapsedMs = Interval }, "手竿时间越界"),
            ("缺新鱼表", p => p.NewFishIds = null!, "存档缺字段"),
        };
        foreach (var (name, breakIt, reason) in cases)
        {
            var p = Good();
            breakIt(p);
            Assert.That(PlayEngine.Validate(p, Fish, Skins), Is.EqualTo(reason), name);
        }
        foreach (var ms in new[] { 0L, Interval - 1 })
        {
            var p = Good();
            p.Groups["pole|map1"] = new ProgressGroup { ElapsedMs = ms };
            Assert.That(PlayEngine.Validate(p, Fish, Skins), Is.Null, ms.ToString());
        }
    }

    // ---------- 新鱼 ----------

    [Test(Description = "B2-14 WU-08：正常出的鱼进新鱼表、注入的不进；标看过只去掉给定的；离开鱼篓就去掉")]
    public void New_fish_list_rules()
    {
        var e = NewEngine(11);
        var lure = new List<FishRecord>();
        for (int i = 0; i < 3000; i++)
            if (e.Input(FishingMode.Lure, M1, 0).Catch is { } f) lure.Add(f);
        Assert.That(lure, Has.Count.GreaterThanOrEqualTo(3));
        var pole = Wait(e, M1, Interval).Single();
        var dev = e.DevInjectFish(M1, 0);
        Assert.That(e.Profile.NewFishIds, Is.EqualTo(lure.Select(f => f.Id).Append(pole.Id)));
        Assert.That(e.Profile.NewFishIds, Does.Not.Contain(dev.Id));

        Assert.That(e.MarkSeen(new[] { lure[0].Id }), Is.True);
        Assert.That(e.Profile.NewFishIds, Does.Not.Contain(lure[0].Id));
        Assert.That(e.Profile.NewFishIds, Has.Count.EqualTo(lure.Count));
        Assert.That(e.MarkSeen(new[] { lure[0].Id, dev.Id }), Is.False, "已经看过的、本来不算新的，再标没有变化");

        Assert.That(e.Collect(lure[1].Id, PlayEngine.FirstTankId), Is.EqualTo(MoveResult.Ok));
        Assert.That(e.Profile.NewFishIds, Does.Not.Contain(lure[1].Id));
        Assert.That(e.Retrieve(lure[1].Id), Is.EqualTo(MoveResult.Ok));
        Assert.That(e.Profile.NewFishIds, Does.Not.Contain(lure[1].Id), "取回不算新鱼");

        var ids = new[] { lure[2].Id };
        Assert.That(e.Sell("s", ids, e.QuoteSale(ids).Total, 0).Status, Is.EqualTo(TradeStatus.Ok));
        Assert.That(e.Profile.NewFishIds, Does.Not.Contain(lure[2].Id));
        Assert.That(e.Profile.NewFishIds, Does.Contain(pole.Id), "没动的还在");
        // 放不进缸（满了）时鱼没动，仍算新
        var full = NewEngine(11);
        var fresh = new List<FishRecord>();
        for (int i = 0; i < 30000 && fresh.Count < 21; i++)
            if (full.Input(FishingMode.Lure, M1, 0).Catch is { } f) fresh.Add(f);
        foreach (var f in fresh.Take(20)) full.Collect(f.Id, PlayEngine.FirstTankId);
        Assert.That(full.Collect(fresh[20].Id, PlayEngine.FirstTankId), Is.EqualTo(MoveResult.TankFull));
        Assert.That(full.Profile.NewFishIds, Is.EqualTo(new[] { fresh[20].Id }));
    }

    // ---------- 设置 ----------

    [Test(Description = "B2-24 B0 Q2：置顶、后台输入两个演示开关默认开/关，存进偏好、读回一样，和穿透、静音互不影响")]
    public void Demo_switches_round_trip()
    {
        var layout = new DesktopLayout();
        var maps = MapCatalog.CreatePlaceholder();
        var c = PetController.FromPrefs(layout, maps, null);
        Assert.That((c.State.Settings.Topmost, c.State.Settings.BackgroundInput), Is.EqualTo((true, false)));
        Assert.That((new PetPrefs().Topmost, new PetPrefs().BackgroundInput), Is.EqualTo((true, false)));
        c.SetTopmost(false);
        c.SetBackgroundInput(true);
        Assert.That((c.State.Settings.Passthrough, c.State.Settings.Mute), Is.EqualTo((true, true)));
        var back = PetController.FromPrefs(layout, maps, c.ToPrefs());
        Assert.That((back.State.Settings.Topmost, back.State.Settings.BackgroundInput), Is.EqualTo((false, true)));
        back.SetTopmost(true);
        back.SetBackgroundInput(false);
        var again = PetController.FromPrefs(layout, maps, back.ToPrefs());
        Assert.That((again.State.Settings.Topmost, again.State.Settings.BackgroundInput), Is.EqualTo((true, false)));
    }
}
