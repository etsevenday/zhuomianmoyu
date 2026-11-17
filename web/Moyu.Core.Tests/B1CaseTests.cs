using System.Text.Json;
using System.Text.Json.Serialization;
using Moyu.Core.Play;
using Moyu.Core.Scene;

namespace Moyu.Core.Tests;

/// <summary>
/// B1 用例表（doc/测试用例/B1 网页核心循环.md）里方式含 N 的用例：节点捕获、鱼池、收藏、出售、抽取、存档检查。
/// 需要某个随机结果时，从种子 1 起找第一个满足条件的档案种子，所以每条测试都是确定的。
/// </summary>
public class B1CaseTests
{
    private const string M1 = MapCatalog.Pond;
    private const string M2 = MapCatalog.Stream;
    private const string M3 = MapCatalog.Bay;
    // 每次现造：变异测试按用例切换变异，静态缓存的目录只会在第一次用时建一次，目录里的变异就测不到
    private static FishCatalog Fish => FishCatalog.CreateTemporary();
    private static SkinCatalog Skins => SkinCatalog.CreateFirstBatch();

    private static PlayEngine NewEngine(ulong seed = 1) =>
        new PlayEngine(PlayEngine.NewProfile("test", seed, Skins), Fish, Skins);

    /// <summary>本轮第 node 次输入在第 cycle 个周期里判定成功与否。</summary>
    private static bool NodeWins(ulong seed, FishingMode mode, string map, long cycle, int node) =>
        Dice.Unit(seed, $"node|{PlayEngine.GroupKey(mode, map)}|{cycle}|{node}") < CaptureRules.For(mode)!.NodeProbability;

    private static ulong SeedWhere(Func<ulong, bool> ok)
    {
        for (ulong s = 1; s < 100000; s++)
            if (ok(s)) return s;
        throw new InvalidOperationException("找不到满足条件的种子");
    }

    /// <summary>连续输入 n 次，返回这期间出的鱼和每次的结果。</summary>
    private static List<InputResult> Feed(PlayEngine e, FishingMode mode, string map, int n, long now = 1000)
    {
        var list = new List<InputResult>();
        for (int i = 0; i < n; i++) list.Add(e.Input(mode, map, now));
        return list;
    }

    // ---------- 输入与节点 ----------

    [Test(Description = "B1-07 05 §1：手竿只计总累计和手竿模式统计，不推进路亚/摸鱼、不出鱼")]
    public void Pole_inputs_count_totals_only()
    {
        var e = NewEngine();
        Feed(e, FishingMode.Lure, M1, 7);
        var results = Feed(e, FishingMode.Pole, M1, 3000);
        Assert.That(e.Profile.LifetimeInputs, Is.EqualTo(3007));
        Assert.That(e.ModeInputs(FishingMode.Pole), Is.EqualTo(3000));
        Assert.That(e.ModeInputs(FishingMode.Lure), Is.EqualTo(7));
        Assert.That(e.CycleCount(FishingMode.Lure, M1), Is.EqualTo(7));
        Assert.That(e.CycleCount(FishingMode.Wade, M1), Is.EqualTo(0));
        Assert.That(e.Profile.Fish, Is.Empty);
        Assert.That(results.All(r => r.Mode == FishingMode.Pole && r.Count == null && r.Catch == null && !r.Rolled && !r.Guaranteed));
        Assert.That(e.NextNode(FishingMode.Pole, M1), Is.Null);
        Assert.That(e.Profile.Groups.Keys, Is.EquivalentTo(new[] { "lure|map1" }));
    }

    [Test(Description = "B1-10 WI-04：路亚 499 不判、500 判失败留 500、501—999 不判、1000 必得 1 条并归零")]
    public void Lure_fail_at_500_then_guaranteed_at_1000()
    {
        var seed = SeedWhere(s => !NodeWins(s, FishingMode.Lure, M1, 0, 500));
        var e = NewEngine(seed);
        var r = Feed(e, FishingMode.Lure, M1, 1000);
        Assert.That(r.Take(499).Any(x => x.Rolled || x.Guaranteed || x.Catch != null), Is.False);
        Assert.That(r[499].Rolled, Is.True);
        Assert.That(r[499].Catch, Is.Null);
        Assert.That(r[499].Count, Is.EqualTo(500));
        Assert.That(r.Skip(500).Take(499).Any(x => x.Rolled || x.Guaranteed || x.Catch != null), Is.False);
        Assert.That(r[999].Guaranteed, Is.True);
        Assert.That(r[999].Rolled, Is.False);
        Assert.That(r[999].Catch, Is.Not.Null);
        Assert.That(r[999].Catch!.Guaranteed, Is.True, "保底出的鱼带标记");
        Assert.That(r[999].Count, Is.EqualTo(0));
        Assert.That(e.Profile.Fish, Has.Count.EqualTo(1));
        Assert.That(e.Profile.Groups["lure|map1"].Cycle, Is.EqualTo(1));
    }

    [Test(Description = "B1-11 WI-04：路亚 500 成功出 1 条并归零，下一周期第 500 次重新判定")]
    public void Lure_success_at_500_resets_cycle()
    {
        var seed = SeedWhere(s => NodeWins(s, FishingMode.Lure, M1, 0, 500));
        var e = NewEngine(seed);
        var r = Feed(e, FishingMode.Lure, M1, 1000);
        Assert.That(r[499].Rolled && r[499].Catch != null, Is.True);
        Assert.That(r[499].Catch!.Guaranteed, Is.False, "判定出的鱼不带保底标记");
        Assert.That(r[499].Count, Is.EqualTo(0));
        Assert.That(r.Skip(500).Take(499).Any(x => x.Rolled || x.Catch != null), Is.False);
        Assert.That(r[999].Rolled, Is.True, "新周期的第 500 次");
        Assert.That(r[999].Guaranteed, Is.False);
        Assert.That(e.Profile.Fish.Count, Is.EqualTo(r[999].Catch == null ? 1 : 2));
    }

    [Test(Description = "B1-12 WI-05：摸鱼 200—1800 九个节点都失败，1801—1999 不判，2000 只出 1 条不再判 20%")]
    public void Wade_all_nodes_fail_then_guaranteed_at_2000()
    {
        var seed = SeedWhere(s => Enumerable.Range(1, 9).All(i => !NodeWins(s, FishingMode.Wade, M1, 0, i * 200)));
        var e = NewEngine(seed);
        var r = Feed(e, FishingMode.Wade, M1, 2000);
        var rolledAt = r.Select((x, i) => (x, n: i + 1)).Where(t => t.x.Rolled).Select(t => t.n);
        Assert.That(rolledAt, Is.EqualTo(Enumerable.Range(1, 9).Select(i => i * 200)));
        Assert.That(r.Take(1999).Any(x => x.Catch != null || x.Guaranteed), Is.False);
        Assert.That(r[1999].Guaranteed && !r[1999].Rolled && r[1999].Catch != null, Is.True);
        Assert.That(r[1999].Count, Is.EqualTo(0));
        Assert.That(e.Profile.Fish, Has.Count.EqualTo(1));
    }

    [Test(Description = "B1-13 WI-05：摸鱼 200 失败、400 成功，出 1 条并归零；199 不判")]
    public void Wade_success_resets_cycle()
    {
        var seed = SeedWhere(s => !NodeWins(s, FishingMode.Wade, M1, 0, 200) && NodeWins(s, FishingMode.Wade, M1, 0, 400));
        var e = NewEngine(seed);
        var r = Feed(e, FishingMode.Wade, M1, 400);
        Assert.That(r[198].Rolled, Is.False);
        Assert.That(r[199].Rolled && r[199].Catch == null && r[199].Count == 200, Is.True);
        Assert.That(r[399].Rolled && r[399].Catch != null, Is.True);
        Assert.That(e.CycleCount(FishingMode.Wade, M1), Is.EqualTo(0));
        Assert.That(e.NextNode(FishingMode.Wade, M1), Is.EqualTo(200));
    }

    [Test(Description = "B1-14 WI-06：出鱼只清本组本轮，总累计、模式统计和别的组都不归零")]
    public void Catch_resets_only_current_cycle()
    {
        var seed = SeedWhere(s => NodeWins(s, FishingMode.Lure, M1, 0, 500));
        var e = NewEngine(seed);
        Feed(e, FishingMode.Wade, M1, 30);
        Feed(e, FishingMode.Lure, M2, 40);
        Feed(e, FishingMode.Lure, M1, 500);
        Assert.That(e.Profile.Fish, Has.Count.EqualTo(1));
        Assert.That(e.Profile.LifetimeInputs, Is.EqualTo(570));
        Assert.That(e.ModeInputs(FishingMode.Lure), Is.EqualTo(540));
        Assert.That(e.CycleCount(FishingMode.Lure, M1), Is.EqualTo(0));
        Assert.That(e.CycleCount(FishingMode.Lure, M2), Is.EqualTo(40));
        Assert.That(e.CycleCount(FishingMode.Wade, M1), Is.EqualTo(30));
    }

    [Test(Description = "B1-15 01 §3：2000 个种子下，路亚 500 成功约 50%、平均 750 次；摸鱼节点约 20%、平均 892.6 次、保底约 13.4%")]
    public void Node_probabilities_match_rules()
    {
        const int runs = 2000;
        int lureEarly = 0;
        long lureTotal = 0;
        int wadeRolls = 0, wadeWins = 0, wadeGuaranteed = 0;
        long wadeTotal = 0;
        for (ulong s = 1; s <= runs; s++)
        {
            var e = NewEngine(s);
            for (int n = 1; ; n++)
            {
                var r = e.Input(FishingMode.Lure, M1, 0);
                if (r.Catch == null) continue;
                if (r.Rolled) lureEarly++;
                lureTotal += n;
                break;
            }
            for (int n = 1; ; n++)
            {
                var r = e.Input(FishingMode.Wade, M1, 0);
                if (r.Rolled) wadeRolls++;
                if (r.Catch == null) continue;
                if (r.Rolled) wadeWins++;
                if (r.Guaranteed) wadeGuaranteed++;
                wadeTotal += n;
                break;
            }
        }
        Assert.That(lureEarly / (double)runs, Is.EqualTo(0.5).Within(0.03));
        Assert.That(lureTotal / (double)runs, Is.EqualTo(750).Within(15));
        Assert.That(wadeWins / (double)wadeRolls, Is.EqualTo(0.2).Within(0.03));
        Assert.That(wadeTotal / (double)runs, Is.EqualTo(892.6).Within(25));
        Assert.That(wadeGuaranteed / (double)runs, Is.EqualTo(0.134).Within(0.02));
    }

    [Test(Description = "B1-16 WI-10：一批事件按顺序逐个处理，只越过 500 一次，切换前后的输入各归各的模式")]
    public void Batch_is_processed_in_order()
    {
        var e = NewEngine(SeedWhere(s => !NodeWins(s, FishingMode.Lure, M1, 0, 500)));
        Feed(e, FishingMode.Lure, M1, 498);
        var batch = new[] { FishingMode.Lure, FishingMode.Lure, FishingMode.Lure, FishingMode.Wade, FishingMode.Wade };
        var results = batch.Select(m => e.Input(m, M1, 0)).ToList();
        Assert.That(results.Count(r => r.Rolled), Is.EqualTo(1));
        Assert.That(results[1].Rolled, Is.True, "第 500 次正是第二个事件");
        Assert.That(e.CycleCount(FishingMode.Lure, M1), Is.EqualTo(501));
        Assert.That(e.CycleCount(FishingMode.Wade, M1), Is.EqualTo(2));
        Assert.That(e.ModeInputs(FishingMode.Wade), Is.EqualTo(2));
    }

    [Test(Description = "B1-17 WEB-DEC-07：地图一路亚 400 切走再切回仍是 400，到 500 判定用地图一鱼池；别的组各记各的")]
    public void Progress_is_kept_per_mode_and_map()
    {
        var seed = SeedWhere(s => NodeWins(s, FishingMode.Lure, M1, 0, 500));
        var e = NewEngine(seed);
        Feed(e, FishingMode.Lure, M1, 400);
        Assert.That(e.CycleCount(FishingMode.Lure, M2), Is.EqualTo(0));
        Feed(e, FishingMode.Lure, M2, 50);
        Assert.That(e.CycleCount(FishingMode.Wade, M2), Is.EqualTo(0));
        Assert.That(e.CycleCount(FishingMode.Lure, M1), Is.EqualTo(400));
        var r = Feed(e, FishingMode.Lure, M1, 100);
        Assert.That(r[99].Rolled, Is.True);
        var fish = r[99].Catch!;
        Assert.That(fish.MapId, Is.EqualTo(M1));
        Assert.That(Fish.Pool(M1).Select(s => s.Id), Does.Contain(fish.SpeciesId));
        Assert.That(e.CycleCount(FishingMode.Lure, M2), Is.EqualTo(50));
    }

    [Test(Description = "B1-18 WC-01/02：每图只出 3 种共享 + 本图专属，频率接近 40/40/16/4，体长为含端点的整数毫米")]
    public void Map_pools_and_lengths()
    {
        var exclusive = new Dictionary<string, string> { [M1] = "TMP_F101", [M2] = "TMP_F201", [M3] = "TMP_F301" };
        foreach (var map in new[] { M1, M2, M3 })
        {
            var e = NewEngine(7);
            Assert.That(Fish.Pool(map).Sum(s => s.Weight), Is.EqualTo(100));
            const int n = 20000;
            for (int i = 0; i < n; i++) e.DevInjectFish(map, 0);
            var bySpecies = e.Profile.Fish.GroupBy(f => f.SpeciesId).ToDictionary(g => g.Key, g => g.ToList());
            Assert.That(bySpecies.Keys, Is.EquivalentTo(new[] { "TMP_F001", "TMP_F002", "TMP_F003", exclusive[map] }), map);
            foreach (var (id, w) in new[] { ("TMP_F001", 40), ("TMP_F002", 40), ("TMP_F003", 16), (exclusive[map], 4) })
                Assert.That(bySpecies[id].Count / (double)n, Is.EqualTo(w / 100.0).Within(0.015), $"{map} {id}");
            foreach (var (id, list) in bySpecies)
            {
                var s = Fish.Find(id)!;
                Assert.That(list.All(f => s.IsValidLength(f.LengthMm)), $"{id} 体长越界");
            }
            foreach (var id in new[] { "TMP_F001", "TMP_F002" })
            {
                var s = Fish.Find(id)!;
                Assert.That(bySpecies[id].Min(f => f.LengthMm), Is.EqualTo(s.MinMm), $"{id} 最短端点");
                Assert.That(bySpecies[id].Max(f => f.LengthMm), Is.EqualTo(s.MaxMm), $"{id} 最长端点");
            }
        }
    }

    [Test(Description = "B1-19 WI-09、03 §5：同一种子重走得到完全相同的鱼；不同种子结果不同；骰子算法固定")]
    public void Outcomes_are_reproducible_from_profile_seed()
    {
        string Run(ulong seed)
        {
            var e = NewEngine(seed);
            Feed(e, FishingMode.Lure, M1, 3000);
            Feed(e, FishingMode.Wade, M2, 3000);
            e.DevAddCoins(500, 0);
            for (int i = 0; i < 4; i++) e.Draw("d" + i, 0);
            return string.Join(";", e.Profile.Fish.Select(f => $"{f.CatchEventId}:{f.SpeciesId}:{f.LengthMm}"))
                + "|" + string.Join(",", e.Profile.Ledger.Select(l => l.SkinId));
        }
        Assert.That(Run(42), Is.EqualTo(Run(42)));
        Assert.That(Run(42), Is.Not.EqualTo(Run(43)));
        // 算法一改，旧档里没走完的节点就会掷出不同结果；这几个值锁住它
        Assert.That(Dice.Hash(0, ""), Is.EqualTo(14087677454934409008UL));
        Assert.That(Dice.Hash(1, "node|lure|map1|0|500"), Is.EqualTo(2690795027776215785UL));
        Assert.That(Dice.Hash(123456789, "draw|1"), Is.EqualTo(12014624369320284897UL));
        Assert.That(Dice.Unit(1, "a"), Is.EqualTo((Dice.Hash(1, "a") >> 11) / 9007199254740992.0));
        Assert.That(Dice.Below(1, "a", 7), Is.EqualTo((int)(Dice.Unit(1, "a") * 7)));
    }

    [Test(Description = "B1-20 03 §1、05 §3：鱼个体字段齐全、编号唯一；开发注入的来源是 Dev 且不推进计数")]
    public void Catch_fields_and_source()
    {
        var e = NewEngine(SeedWhere(s => NodeWins(s, FishingMode.Wade, M3, 0, 200)));
        var r = Feed(e, FishingMode.Wade, M3, 200, now: 1_700_000_000_000);
        var f = r[199].Catch!;
        Assert.That(f.Id, Is.EqualTo("F1"));
        Assert.That(f.Mode, Is.EqualTo("wade"));
        Assert.That(f.MapId, Is.EqualTo(M3));
        Assert.That(f.CaughtAtMs, Is.EqualTo(1_700_000_000_000));
        Assert.That(f.CatchEventId, Is.EqualTo("catch|wade|map3|0"));
        Assert.That(f.ContentVersion, Is.EqualTo(FishCatalog.ContentVersion));
        Assert.That(f.Source, Is.EqualTo(CatchSource.Normal));
        Assert.That(f.Place, Is.EqualTo(FishPlace.Basket));
        Assert.That(Fish.Find(f.SpeciesId)!.IsValidLength(f.LengthMm));

        var before = e.Profile.LifetimeInputs;
        var d = e.DevInjectFish(M1, 5);
        Assert.That(d.Id, Is.EqualTo("F2"));
        Assert.That(d.Source, Is.EqualTo(CatchSource.Dev));
        Assert.That(d.Guaranteed, Is.False);
        Assert.That(d.Mode, Is.EqualTo("dev"));
        Assert.That(d.CatchEventId, Is.EqualTo("dev|2"));
        Assert.That(e.Profile.LifetimeInputs, Is.EqualTo(before));
        Assert.That(e.Profile.NextFishSeq, Is.EqualTo(3));
    }

    [Test(Description = "B1-49 02 §1：下一节点——路亚 0→500、500 失败后→1000；摸鱼 0→200、199→200、200→400、1800→2000；手竿无")]
    public void Next_node()
    {
        Assert.That(CaptureRules.Lure.NextNode(0), Is.EqualTo(500));
        Assert.That(CaptureRules.Lure.NextNode(499), Is.EqualTo(500));
        Assert.That(CaptureRules.Lure.NextNode(500), Is.EqualTo(1000));
        Assert.That(CaptureRules.Lure.NextNode(999), Is.EqualTo(1000));
        Assert.That(CaptureRules.Wade.NextNode(0), Is.EqualTo(200));
        Assert.That(CaptureRules.Wade.NextNode(199), Is.EqualTo(200));
        Assert.That(CaptureRules.Wade.NextNode(200), Is.EqualTo(400));
        Assert.That(CaptureRules.Wade.NextNode(1800), Is.EqualTo(2000));
        Assert.That(CaptureRules.Wade.GuaranteedNode, Is.EqualTo(2000));
        Assert.That(CaptureRules.Lure.GuaranteedNode, Is.EqualTo(1000));
        Assert.That(CaptureRules.For(FishingMode.Pole), Is.Null);
    }

    // ---------- 存档 ----------

    [Test(Description = "B1-21 WA-01：新档 1 个 20 条鱼缸、金币 0、空鱼篓空纪录、四类默认外观已装备")]
    public void New_profile_defaults()
    {
        var p = PlayEngine.NewProfile("abc", 99, Skins);
        Assert.That(p.ProfileId, Is.EqualTo("abc"));
        Assert.That(p.Seed, Is.EqualTo(99));
        Assert.That(p.RulesVersion, Is.EqualTo("web_core_0.2"));
        Assert.That(p.ContentVersion, Is.EqualTo("tmp_fish_0.1"));
        Assert.That(p.Tanks.Select(t => (t.Id, t.Capacity)), Is.EqualTo(new[] { ("tank1", 20) }));
        Assert.That(p.Coins, Is.EqualTo(0));
        Assert.That(p.Fish, Is.Empty);
        Assert.That(p.Records, Is.Empty);
        Assert.That(p.Ledger, Is.Empty);
        Assert.That(p.BackgroundTankId, Is.Null);
        Assert.That(p.OwnedSkins, Is.EquivalentTo(new[] { "BASE_CHAR", "BASE_ROD", "BASE_GLOVE", "BASE_SCENE" }));
        Assert.That(p.Equipped, Is.EquivalentTo(new Dictionary<string, string>
        {
            ["Character"] = "BASE_CHAR", ["Rod"] = "BASE_ROD", ["Glove"] = "BASE_GLOVE", ["Scene"] = "BASE_SCENE",
        }));
        Assert.That(PlayEngine.Validate(p, Fish, Skins), Is.Null);
    }

    [Test(Description = "B1-22 WA-05：整份档案序列化再读回，计数、各组进度、鱼、金币、账本、外观、背景都一样")]
    public void Profile_round_trip()
    {
        var e = NewEngine(SeedWhere(s => NodeWins(s, FishingMode.Lure, M1, 0, 500)));
        Feed(e, FishingMode.Lure, M1, 520);
        Feed(e, FishingMode.Wade, M2, 33);
        for (int i = 0; i < 3; i++) e.DevInjectFish(M1, 0);
        var basket = e.InBasket.Select(f => f.Id).ToList();
        e.Collect(basket[0], "tank1");
        var q = e.QuoteSale(new[] { basket[1] });
        e.Sell("s1", new[] { basket[1] }, q.Total, 0);
        e.DevAddCoins(300, 0);
        var drawn = e.Draw("d1", 0).Receipt!.SkinId!;
        e.Equip(drawn);
        e.SetBackground("tank1");

        var options = new JsonSerializerOptions { Converters = { new JsonStringEnumConverter() } };
        var json = JsonSerializer.Serialize(e.Profile, options);
        var back = JsonSerializer.Deserialize<Profile>(json, options)!;
        Assert.That(JsonSerializer.Serialize(back, options), Is.EqualTo(json));
        Assert.That(PlayEngine.Validate(back, Fish, Skins), Is.Null);
        var e2 = new PlayEngine(back, Fish, Skins);
        Assert.That(e2.CycleCount(FishingMode.Lure, M1), Is.EqualTo(20));
        Assert.That(e2.CycleCount(FishingMode.Wade, M2), Is.EqualTo(33));
        Assert.That(e2.InTank("tank1").Single().Id, Is.EqualTo(basket[0]));
        Assert.That(back.BackgroundTankId, Is.EqualTo("tank1"));
        Assert.That(back.Coins, Is.EqualTo(e.Profile.Coins));
        Assert.That(e2.Owns(drawn));
    }

    [Test(Description = "B1-24 WA-06：读进来的坏档案被拒绝并说明原因，好档案通过")]
    public void Bad_profile_is_rejected()
    {
        Profile Good()
        {
            var e = NewEngine();
            e.DevInjectFish(M1, 0);
            return e.Profile;
        }
        Assert.That(PlayEngine.Validate(Good(), Fish, Skins), Is.Null);
        Assert.That(PlayEngine.Validate(null, Fish, Skins), Is.EqualTo("空档案"));
        // 原因会显示在底栏"读档失败"的悬停提示里
        var cases = new (string, Action<Profile>, string)[]
        {
            ("版本", p => p.Schema = 3, "存档版本不认识"),
            ("旧版本没升级", p => p.Schema = 1, "存档版本不认识"),
            ("缺鱼表", p => p.Fish = null!, "存档缺字段"),
            ("缺纪录", p => p.Records = null!, "存档缺字段"),
            ("缺鱼缸表", p => p.Tanks = null!, "存档缺字段"),
            ("缺外观", p => p.OwnedSkins = null!, "存档缺字段"),
            ("缺装备", p => p.Equipped = null!, "存档缺字段"),
            ("缺账本", p => p.Ledger = null!, "存档缺字段"),
            ("缺统计", p => p.ModeInputs = null!, "存档缺字段"),
            ("缺进度", p => p.Groups = null!, "存档缺字段"),
            ("总数为负", p => p.LifetimeInputs = -1, "计数为负"),
            ("金币为负", p => p.Coins = -1, "计数为负"),
            ("重复计数为负", p => p.DuplicateStreak = -1, "计数为负"),
            ("进度为负", p => p.Groups["lure|map1"] = new ProgressGroup { Count = -1 }, "进度为负"),
            ("进度为空", p => p.Groups["lure|map1"] = null!, "进度为负"),
            ("没有鱼缸", p => p.Tanks.Clear(), "没有鱼缸"),
            ("鱼种不认识", p => p.Fish[0].SpeciesId = "X", "鱼的数据无效"),
            ("体长越界", p => p.Fish[0].LengthMm = 5000, "鱼的数据无效"),
            ("鱼为空", p => p.Fish[0] = null!, "鱼的数据无效"),
            ("鱼在不存在的缸", p => { p.Fish[0].Place = FishPlace.Tank; p.Fish[0].TankId = "tank9"; }, "鱼在不存在的鱼缸里"),
            ("外观不认识", p => p.OwnedSkins.Add("NOPE"), "外观不认识"),
        };
        foreach (var (name, breakIt, reason) in cases)
        {
            var p = Good();
            breakIt(p);
            Assert.That(PlayEngine.Validate(p, Fish, Skins), Is.EqualTo(reason), name);
        }
        var edge = Good();
        edge.Fish[0].Place = FishPlace.Tank;
        edge.Fish[0].TankId = "tank1";
        edge.Groups["lure|map1"] = new ProgressGroup { Count = 0 };
        Assert.That(PlayEngine.Validate(edge, Fish, Skins), Is.Null, "0 和在存在的缸里都合法");
    }

    // ---------- 收藏 ----------

    [Test(Description = "B1-28 WA-02：第 20 条放得进，第 21 条放不进、仍在鱼篓，不自动卖不丢")]
    public void Tank_holds_twenty()
    {
        var e = NewEngine();
        for (int i = 0; i < 21; i++) e.DevInjectFish(M1, 0);
        var ids = e.InBasket.Select(f => f.Id).ToList();
        for (int i = 0; i < 20; i++) Assert.That(e.Collect(ids[i], "tank1"), Is.EqualTo(MoveResult.Ok), $"第 {i + 1} 条");
        Assert.That(e.Collect(ids[20], "tank1"), Is.EqualTo(MoveResult.TankFull));
        Assert.That(e.FindFish(ids[20])!.Place, Is.EqualTo(FishPlace.Basket));
        Assert.That(e.InTank("tank1").Count(), Is.EqualTo(20));
        Assert.That(e.Profile.Fish, Has.Count.EqualTo(21));
        Assert.That(e.Profile.Coins, Is.EqualTo(0));
        Assert.That(e.Collect(ids[20], "tank9"), Is.EqualTo(MoveResult.NoSuchTank));
        Assert.That(e.Collect("F999", "tank1"), Is.EqualTo(MoveResult.NoSuchFish));
    }

    [Test(Description = "B1-29 WA-03：放入、取回是同一条鱼，编号体长不变，重复操作不出副本")]
    public void Collect_and_retrieve_move_the_same_fish()
    {
        var e = NewEngine();
        var f = e.DevInjectFish(M1, 0);
        int len = f.LengthMm;
        Assert.That(e.Collect(f.Id, "tank1"), Is.EqualTo(MoveResult.Ok));
        Assert.That(f.Place, Is.EqualTo(FishPlace.Tank));
        Assert.That(f.TankId, Is.EqualTo("tank1"));
        Assert.That(e.InBasket, Is.Empty);
        Assert.That(e.Collect(f.Id, "tank1"), Is.EqualTo(MoveResult.WrongPlace));
        Assert.That(e.Retrieve(f.Id), Is.EqualTo(MoveResult.Ok));
        Assert.That(f.Place, Is.EqualTo(FishPlace.Basket));
        Assert.That(f.TankId, Is.Null);
        Assert.That(e.Retrieve(f.Id), Is.EqualTo(MoveResult.WrongPlace));
        Assert.That(e.Retrieve("F999"), Is.EqualTo(MoveResult.NoSuchFish));
        Assert.That(e.Profile.Fish.Single().LengthMm, Is.EqualTo(len));
        Assert.That(e.InTank("tank1"), Is.Empty);
    }

    [Test(Description = "B1-30 WA-04：背景只能设成自己的鱼缸；缸里有哪些鱼背景就显示哪些")]
    public void Background_follows_tank()
    {
        var e = NewEngine();
        var a = e.DevInjectFish(M1, 0);
        var b = e.DevInjectFish(M1, 0);
        e.Collect(a.Id, "tank1");
        e.Collect(b.Id, "tank1");
        Assert.That(e.SetBackground("tank9"), Is.False);
        Assert.That(e.Profile.BackgroundTankId, Is.Null);
        Assert.That(e.SetBackground("tank1"), Is.True);
        Assert.That(e.InTank(e.Profile.BackgroundTankId!).Count(), Is.EqualTo(2));
        e.Retrieve(a.Id);
        Assert.That(e.InTank("tank1").Select(f => f.Id), Is.EqualTo(new[] { b.Id }));
        Assert.That(e.SetBackground(null), Is.True);
        Assert.That(e.Profile.BackgroundTankId, Is.Null);
    }

    [Test(Description = "B1-32 WE-02：缸里的鱼报价被拒，取回后能报价")]
    public void Collected_fish_cannot_be_sold()
    {
        var e = NewEngine();
        var f = e.DevInjectFish(M1, 0);
        e.Collect(f.Id, "tank1");
        Assert.That(e.QuoteSale(new[] { f.Id }).Status, Is.EqualTo(TradeStatus.Invalid));
        Assert.That(e.Sell("x", new[] { f.Id }, 0, 0).Status, Is.EqualTo(TradeStatus.StaleQuote));
        e.Retrieve(f.Id);
        var q = e.QuoteSale(new[] { f.Id });
        Assert.That(q.Status, Is.EqualTo(TradeStatus.Ok));
        Assert.That(q.Total, Is.EqualTo(Fish.Find(f.SpeciesId)!.Price(f.LengthMm)));
    }

    // ---------- 出售 ----------

    [TestCase("TMP_F001", 60, 80, 100, 12, 16, 20, Description = "B1-33 WE-01：F001 6/8/10 厘米 12/16/20 币")]
    [TestCase("TMP_F002", 120, 160, 200, 18, 24, 30, Description = "B1-33 WE-01：F002")]
    [TestCase("TMP_F003", 240, 320, 400, 45, 60, 75, Description = "B1-33 WE-01：F003")]
    [TestCase("TMP_F101", 450, 550, 650, 120, 150, 180, Description = "B1-33 WE-01：F101")]
    [TestCase("TMP_F201", 600, 750, 900, 120, 150, 180, Description = "B1-33 WE-01：F201")]
    [TestCase("TMP_F301", 900, 1100, 1300, 120, 150, 180, Description = "B1-33 WE-01：F301")]
    public void Price_table(string id, int min, int mid, int max, int pMin, int pMid, int pMax)
    {
        var s = Fish.Find(id)!;
        Assert.That((s.MinMm, s.MaxMm), Is.EqualTo((min, max)));
        Assert.That(s.Price(min), Is.EqualTo(pMin));
        Assert.That(s.Price(mid), Is.EqualTo(pMid));
        Assert.That(s.Price(max), Is.EqualTo(pMax));
    }

    [Test(Description = "B1-33 04 §1.1：逐毫米不降价、中点两侧对称和为 2B、平均正好是基准价；含一处恰好半币的取整")]
    public void Price_is_monotonic_and_symmetric()
    {
        foreach (var s in Fish.All)
        {
            int prev = int.MinValue;
            long sum = 0;
            for (int mm = s.MinMm; mm <= s.MaxMm; mm++)
            {
                int p = s.Price(mm)!.Value;
                Assert.That(p, Is.GreaterThanOrEqualTo(prev), $"{s.Id} {mm}");
                Assert.That(p + s.Price(s.MinMm + s.MaxMm - mm)!.Value, Is.EqualTo(2 * s.PriceBase), $"{s.Id} {mm} 对称");
                prev = p;
                sum += p;
            }
            Assert.That(sum, Is.EqualTo((long)s.PriceBase * (s.MaxMm - s.MinMm + 1)), s.Id);
        }
        // 恰好半币：F003 体长 328mm，d=16，偏移 = 15×16/160 = 1.5，远离中点取 2；312mm 对称取 −2
        var f3 = Fish.Find("TMP_F003")!;
        Assert.That(f3.Price(328), Is.EqualTo(62));
        Assert.That(f3.Price(312), Is.EqualTo(58));
        // 不到半币向中点取：F001 65mm，偏移 −3.0 → 13；F003 327mm，偏移 1.3125 → 61
        Assert.That(Fish.Find("TMP_F001")!.Price(65), Is.EqualTo(13));
        Assert.That(f3.Price(327), Is.EqualTo(61));
    }

    [Test(Description = "B1-34 04 §1：体长超出范围、鱼种不认识都不报价，不夹到最高价，鱼不变")]
    public void Invalid_fish_is_not_quoted()
    {
        var s = Fish.Find("TMP_F001")!;
        Assert.That(s.Price(59), Is.Null);
        Assert.That(s.Price(101), Is.Null);
        var e = NewEngine();
        var f = e.DevInjectFish(M1, 0);
        f.LengthMm = 99999;
        Assert.That(e.QuoteSale(new[] { f.Id }).Status, Is.EqualTo(TradeStatus.Invalid));
        f.LengthMm = Fish.Find(f.SpeciesId)!.MinMm;
        f.SpeciesId = "NOPE";
        var q = e.QuoteSale(new[] { f.Id });
        Assert.That(q.Status, Is.EqualTo(TradeStatus.Invalid));
        Assert.That(q.Lines, Is.Empty);
        Assert.That(q.Total, Is.EqualTo(0));
        Assert.That(f.Place, Is.EqualTo(FishPlace.Basket));
        // 好鱼排在坏鱼前面时，已经算进去的那条也要清掉，整单不报价
        var good = e.DevInjectFish(M1, 0);
        var mixed = e.QuoteSale(new[] { good.Id, f.Id });
        Assert.That(mixed.Status, Is.EqualTo(TradeStatus.Invalid));
        Assert.That(mixed.Lines, Is.Empty);
        Assert.That(mixed.Total, Is.EqualTo(0));
        Assert.That(e.QuoteSale(new[] { "F999" }).Status, Is.EqualTo(TradeStatus.Invalid));
        Assert.That(e.QuoteSale(Array.Empty<string>()).Status, Is.EqualTo(TradeStatus.Empty));
        Assert.That(e.Sell("e", Array.Empty<string>(), 0, 0).Status, Is.EqualTo(TradeStatus.Empty));
    }

    [Test(Description = "B1-36 WE-03：多选合计是逐条价之和；只报价不确认不改任何东西；确认后没选的那条还在")]
    public void Multi_sale_total_and_cancel()
    {
        var e = NewEngine(3);
        var fish = Enumerable.Range(0, 3).Select(_ => e.DevInjectFish(M2, 0)).ToList();
        var pick = new[] { fish[0].Id, fish[2].Id };
        var q = e.QuoteSale(pick);
        Assert.That(q.Status, Is.EqualTo(TradeStatus.Ok));
        Assert.That(q.Lines.Select(l => l.FishId), Is.EqualTo(pick));
        Assert.That(q.Total, Is.EqualTo(q.Lines.Sum(l => l.Price)));
        Assert.That(q.Lines.Select(l => l.Price), Is.EqualTo(pick.Select(id => Fish.Find(e.FindFish(id)!.SpeciesId)!.Price(e.FindFish(id)!.LengthMm)!.Value)));
        Assert.That(e.InBasket.Count(), Is.EqualTo(3), "取消=只报价不确认");
        Assert.That(e.Profile.Coins, Is.EqualTo(0));
        Assert.That(e.QuoteSale(new[] { fish[0].Id, fish[0].Id }).Total, Is.EqualTo(e.QuoteSale(new[] { fish[0].Id }).Total), "同一条只算一次");

        var r = e.Sell("op1", pick, q.Total, 777);
        Assert.That(r.Status, Is.EqualTo(TradeStatus.Ok));
        Assert.That(e.Profile.Coins, Is.EqualTo(q.Total));
        Assert.That(e.InBasket.Select(f => f.Id), Is.EqualTo(new[] { fish[1].Id }));
        Assert.That(fish[0].Place, Is.EqualTo(FishPlace.Sold));
        var receipt = r.Receipt!;
        Assert.That(receipt.Kind, Is.EqualTo(LedgerKind.Sale));
        Assert.That(receipt.Delta, Is.EqualTo(q.Total));
        Assert.That(receipt.BalanceAfter, Is.EqualTo(q.Total));
        Assert.That(receipt.AtMs, Is.EqualTo(777));
        Assert.That(receipt.Lines.Select(l => l.FishId), Is.EqualTo(pick));
        Assert.That(receipt.Id, Is.EqualTo("R1"));
    }

    [Test(Description = "B1-37 ECON-05：同一操作号再提交只到账一次，回同一张回执")]
    public void Sale_is_idempotent()
    {
        var e = NewEngine();
        var f = e.DevInjectFish(M1, 0);
        var q = e.QuoteSale(new[] { f.Id });
        var first = e.Sell("op", new[] { f.Id }, q.Total, 0);
        var again = e.Sell("op", new[] { f.Id }, q.Total, 0);
        Assert.That(again.Status, Is.EqualTo(TradeStatus.AlreadyDone));
        Assert.That(again.Receipt, Is.SameAs(first.Receipt));
        Assert.That(e.Profile.Coins, Is.EqualTo(q.Total));
        Assert.That(e.Profile.Ledger, Has.Count.EqualTo(1));
    }

    [Test(Description = "B1-37 04 §1：报价后其中一条进了鱼缸、或合计对不上，整批不卖，鱼和金币都不变")]
    public void Stale_quote_rejects_whole_batch()
    {
        var e = NewEngine();
        var a = e.DevInjectFish(M1, 0);
        var b = e.DevInjectFish(M1, 0);
        var q = e.QuoteSale(new[] { a.Id, b.Id });
        Assert.That(e.Sell("x1", new[] { a.Id, b.Id }, q.Total + 1, 0).Status, Is.EqualTo(TradeStatus.StaleQuote));
        e.Collect(b.Id, "tank1");
        Assert.That(e.Sell("x2", new[] { a.Id, b.Id }, q.Total, 0).Status, Is.EqualTo(TradeStatus.StaleQuote));
        Assert.That(a.Place, Is.EqualTo(FishPlace.Basket));
        Assert.That(b.Place, Is.EqualTo(FishPlace.Tank));
        Assert.That(e.Profile.Coins, Is.EqualTo(0));
        Assert.That(e.Profile.Ledger, Is.Empty);
    }

    [Test(Description = "B1-38 ECON-06：卖掉的鱼不能再报价")]
    public void Sold_fish_cannot_be_sold_again()
    {
        var e = NewEngine();
        var f = e.DevInjectFish(M1, 0);
        var q = e.QuoteSale(new[] { f.Id });
        e.Sell("a", new[] { f.Id }, q.Total, 0);
        Assert.That(e.QuoteSale(new[] { f.Id }).Status, Is.EqualTo(TradeStatus.Invalid));
        Assert.That(e.Sell("b", new[] { f.Id }, q.Total, 0).Status, Is.EqualTo(TradeStatus.StaleQuote));
        Assert.That(e.Profile.Coins, Is.EqualTo(q.Total));
        Assert.That(e.Retrieve(f.Id), Is.EqualTo(MoveResult.WrongPlace));
        Assert.That(e.Collect(f.Id, "tank1"), Is.EqualTo(MoveResult.WrongPlace));
    }

    // ---------- 抽取与装备 ----------

    /// <summary>已拥有 owned 里的外观、金币 coins，并且下一抽（普通抽）的结果满足 want。</summary>
    private static PlayEngine EngineForDraw(int coins, string[] owned, Func<SkinDef, bool> want)
    {
        var pool = Skins.Pool;
        var seed = SeedWhere(s => want(pool[Dice.Below(s, "draw|1", pool.Count)]));
        var e = NewEngine(seed);
        e.Profile.OwnedSkins.AddRange(owned);
        e.Profile.Coins = coins;
        return e;
    }

    [Test(Description = "B1-40 WE-04：99 币不能抽；120 币抽到重复剩 40、无副本、连续重复 +1；抽到新款剩 20、解锁、归零")]
    public void Draw_costs_and_refunds()
    {
        var poor = NewEngine();
        poor.Profile.Coins = 99;
        Assert.That(poor.Draw("p", 0).Status, Is.EqualTo(TradeStatus.NotEnoughCoins));
        Assert.That(poor.Profile.Coins, Is.EqualTo(99));
        Assert.That(poor.Profile.DrawSeq, Is.EqualTo(0));
        Assert.That(poor.Profile.Ledger, Is.Empty);

        var dup = EngineForDraw(120, new[] { "WEB_ROD_01" }, s => s.Id == "WEB_ROD_01");
        dup.Profile.DuplicateStreak = 2;
        var r = dup.Draw("d", 5);
        Assert.That(r.Status, Is.EqualTo(TradeStatus.Ok));
        Assert.That(dup.Profile.Coins, Is.EqualTo(40));
        Assert.That(r.Receipt!.Duplicate, Is.True);
        Assert.That(r.Receipt.Delta, Is.EqualTo(-80));
        Assert.That(r.Receipt.BalanceAfter, Is.EqualTo(40));
        Assert.That(r.Receipt.SkinId, Is.EqualTo("WEB_ROD_01"));
        Assert.That(r.Receipt.Kind, Is.EqualTo(LedgerKind.Draw));
        Assert.That(dup.Profile.OwnedSkins.Count(id => id == "WEB_ROD_01"), Is.EqualTo(1));
        Assert.That(dup.Profile.DuplicateStreak, Is.EqualTo(3));

        var fresh = EngineForDraw(120, Array.Empty<string>(), s => s.Id == "WEB_SCENE_02");
        fresh.Profile.DuplicateStreak = 3;
        var n = fresh.Draw("n", 0);
        Assert.That(fresh.Profile.Coins, Is.EqualTo(20));
        Assert.That(n.Receipt!.Duplicate, Is.False);
        Assert.That(n.Receipt.Delta, Is.EqualTo(-100));
        Assert.That(fresh.Owns("WEB_SCENE_02"));
        Assert.That(fresh.Profile.DuplicateStreak, Is.EqualTo(0));

        var exact = EngineForDraw(100, Array.Empty<string>(), _ => true);
        Assert.That(exact.Draw("e", 0).Status, Is.EqualTo(TradeStatus.Ok), "正好 100 能抽");
    }

    [Test(Description = "B1-41 WE-06：普通抽 12 款各约 1/12")]
    public void Draw_is_uniform_over_twelve()
    {
        const int n = 60000;
        var counts = new Dictionary<string, int>();
        for (ulong s = 1; s <= n; s++)
        {
            var e = NewEngine(s);
            e.Profile.Coins = 100;
            var id = e.Draw("x", 0).Receipt!.SkinId!;
            counts[id] = counts.GetValueOrDefault(id) + 1;
        }
        Assert.That(counts.Keys, Is.EquivalentTo(Skins.Pool.Select(p => p.Id)));
        foreach (var (id, c) in counts) Assert.That(c / (double)n, Is.EqualTo(1 / 12.0).Within(0.004), id);
    }

    [Test(Description = "B1-42 WE-08：连续重复 3 次不触发；第 4 次重复只把计数记成 4；第 5 抽只从未拥有里抽、必新、归零")]
    public void Duplicate_streak_guarantees_new()
    {
        // 拥有 11 款，只差 WEB_GLOVE_03：普通抽 11/12 是重复，找一个前 4 抽都重复的种子
        var owned = Skins.Pool.Where(s => s.Id != "WEB_GLOVE_03").Select(s => s.Id).ToArray();
        var pool = Skins.Pool;
        var seed = SeedWhere(s => Enumerable.Range(1, 4).All(i => pool[Dice.Below(s, $"draw|{i}", 12)].Id != "WEB_GLOVE_03"));
        var e = NewEngine(seed);
        e.Profile.OwnedSkins.AddRange(owned);
        e.Profile.Coins = 1000;
        for (int i = 1; i <= 3; i++)
        {
            Assert.That(e.NextDrawGuaranteed, Is.False, $"第 {i} 抽前");
            var r = e.Draw("d" + i, 0).Receipt!;
            Assert.That(r.Duplicate && !r.Guaranteed, Is.True);
        }
        Assert.That(e.Profile.DuplicateStreak, Is.EqualTo(3));
        Assert.That(e.NextDrawGuaranteed, Is.False);
        var fourth = e.Draw("d4", 0).Receipt!;
        Assert.That(fourth.Duplicate && !fourth.Guaranteed, Is.True);
        Assert.That(e.Profile.DuplicateStreak, Is.EqualTo(4));
        Assert.That(e.NextDrawGuaranteed, Is.True);
        var fifth = e.Draw("d5", 0).Receipt!;
        Assert.That(fifth.Guaranteed, Is.True);
        Assert.That(fifth.Duplicate, Is.False);
        Assert.That(fifth.SkinId, Is.EqualTo("WEB_GLOVE_03"));
        Assert.That(e.Profile.DuplicateStreak, Is.EqualTo(0));
        Assert.That(e.Profile.Coins, Is.EqualTo(1000 - 4 * 80 - 100));
    }

    [Test(Description = "B1-42 WE-08：必新抽在剩下的几款里等概率")]
    public void Guaranteed_draw_is_uniform_over_unowned()
    {
        var left = new[] { "WEB_CHAR_02", "WEB_ROD_03", "WEB_SCENE_01" };
        var counts = left.ToDictionary(x => x, _ => 0);
        for (ulong s = 1; s <= 3000; s++)
        {
            var e = NewEngine(s);
            e.Profile.OwnedSkins.AddRange(Skins.Pool.Select(p => p.Id).Except(left));
            e.Profile.DuplicateStreak = 4;
            e.Profile.Coins = 100;
            counts[e.Draw("g", 0).Receipt!.SkinId!]++;
        }
        foreach (var c in counts.Values) Assert.That(c / 3000.0, Is.EqualTo(1 / 3.0).Within(0.03));
    }

    [Test(Description = "B1-43 WE-06：12 款都有时不能抽、不扣币")]
    public void All_owned_stops_drawing()
    {
        var e = NewEngine();
        e.Profile.OwnedSkins.AddRange(Skins.Pool.Select(s => s.Id));
        e.Profile.Coins = 500;
        Assert.That(e.AllOwned, Is.True);
        Assert.That(e.Draw("a", 0).Status, Is.EqualTo(TradeStatus.AllOwned));
        Assert.That(e.Profile.Coins, Is.EqualTo(500));
        Assert.That(e.Profile.Ledger, Is.Empty);
        var one = NewEngine();
        one.Profile.OwnedSkins.AddRange(Skins.Pool.Skip(1).Select(s => s.Id));
        Assert.That(one.AllOwned, Is.False, "还差一款");
    }

    [Test(Description = "B1-44 WE-05：同一操作号重试返回同一结果、不再扣；抽到不自动装备")]
    public void Draw_is_idempotent_and_does_not_equip()
    {
        var e = NewEngine(5);
        e.Profile.Coins = 300;
        var first = e.Draw("op", 0);
        var again = e.Draw("op", 0);
        Assert.That(again.Status, Is.EqualTo(TradeStatus.AlreadyDone));
        Assert.That(again.Receipt, Is.SameAs(first.Receipt));
        Assert.That(e.Profile.Coins, Is.EqualTo(200));
        Assert.That(e.Profile.DrawSeq, Is.EqualTo(1));
        foreach (SkinCategory c in Enum.GetValues(typeof(SkinCategory)))
            Assert.That(e.EquippedId(c), Is.EqualTo(Skins.BaseOf(c).Id));
    }

    [Test(Description = "B1-45 WE-07：未拥有/不认识的不能装、原装备不变；四类各自独立；能换回默认")]
    public void Equip_rules()
    {
        var e = NewEngine();
        e.Profile.OwnedSkins.AddRange(new[] { "WEB_CHAR_01", "WEB_ROD_02", "WEB_GLOVE_03", "WEB_SCENE_01" });
        Assert.That(e.Equip("WEB_CHAR_02"), Is.False);
        Assert.That(e.Equip("NOPE"), Is.False);
        Assert.That(e.EquippedId(SkinCategory.Character), Is.EqualTo("BASE_CHAR"));
        Assert.That(e.Equip("WEB_CHAR_01") && e.Equip("WEB_ROD_02") && e.Equip("WEB_GLOVE_03") && e.Equip("WEB_SCENE_01"), Is.True);
        Assert.That(e.EquippedId(SkinCategory.Character), Is.EqualTo("WEB_CHAR_01"));
        Assert.That(e.EquippedId(SkinCategory.Rod), Is.EqualTo("WEB_ROD_02"));
        Assert.That(e.EquippedId(SkinCategory.Glove), Is.EqualTo("WEB_GLOVE_03"));
        Assert.That(e.EquippedId(SkinCategory.Scene), Is.EqualTo("WEB_SCENE_01"));
        Assert.That(e.Equip("BASE_ROD"), Is.True);
        Assert.That(e.EquippedId(SkinCategory.Rod), Is.EqualTo("BASE_ROD"));
        Assert.That(e.EquippedId(SkinCategory.Character), Is.EqualTo("WEB_CHAR_01"), "换竿不动角色");
        e.Profile.Equipped.Remove("Glove");
        Assert.That(e.EquippedId(SkinCategory.Glove), Is.EqualTo("BASE_GLOVE"), "缺这一类时按默认");
    }

    [Test(Description = "B1-46 WL-07：换外观、设背景前后同样的输入出同样的鱼，鱼价和容量不变")]
    public void Cosmetics_do_not_change_outcomes()
    {
        string Run(bool dressUp)
        {
            var e = NewEngine(11);
            if (dressUp)
            {
                e.Profile.OwnedSkins.AddRange(Skins.Pool.Select(s => s.Id));
                foreach (var s in Skins.Pool) e.Equip(s.Id);
                e.SetBackground("tank1");
            }
            Feed(e, FishingMode.Lure, M1, 2500);
            Feed(e, FishingMode.Wade, M3, 2500);
            var q = e.QuoteSale(e.InBasket.Select(f => f.Id).ToList());
            return string.Join(",", e.Profile.Fish.Select(f => f.SpeciesId + f.LengthMm)) + "|" + q.Total + "|" + e.Profile.Tanks[0].Capacity;
        }
        Assert.That(Run(true), Is.EqualTo(Run(false)));
    }

    [Test(Description = "B1-52 01 §5：纪录记每种鱼的次数、首次时间、最长体长和那条鱼；卖掉不影响")]
    public void Records_track_species()
    {
        var e = NewEngine(8);
        // 条数多到同种鱼必有体长并列最长的，验证纪录留的是先抓到的那条
        var made = Enumerable.Range(0, 1000).Select(i => e.DevInjectFish(M1, 100 + i)).ToList();
        Assert.That(made.GroupBy(f => (f.SpeciesId, f.LengthMm)).Any(g => g.Count() > 1 && g.Key.LengthMm == made.Where(f => f.SpeciesId == g.Key.SpeciesId).Max(f => f.LengthMm)));
        foreach (var g in made.GroupBy(f => f.SpeciesId))
        {
            var rec = e.Profile.Records[g.Key];
            Assert.That(rec.Count, Is.EqualTo(g.Count()));
            Assert.That(rec.FirstAtMs, Is.EqualTo(g.First().CaughtAtMs));
            Assert.That(rec.MaxLengthMm, Is.EqualTo(g.Max(f => f.LengthMm)));
            Assert.That(rec.MaxFishId, Is.EqualTo(g.First(f => f.LengthMm == rec.MaxLengthMm).Id));
        }
        var before = JsonSerializer.Serialize(e.Profile.Records);
        var all = e.InBasket.Select(f => f.Id).ToList();
        e.Sell("s", all, e.QuoteSale(all).Total, 0);
        Assert.That(JsonSerializer.Serialize(e.Profile.Records), Is.EqualTo(before));
        Assert.That(e.Profile.Records.Keys, Is.SubsetOf(Fish.Pool(M1).Select(s => s.Id)));
    }

    [Test(Description = "B1-21 04 §4：外观表 12 件可抽（四类各 3）+ 4 件默认；常量 100/20/4")]
    public void Skin_catalog()
    {
        Assert.That(Skins.Pool, Has.Count.EqualTo(12));
        Assert.That(Skins.Bases, Has.Count.EqualTo(4));
        foreach (SkinCategory c in Enum.GetValues(typeof(SkinCategory)))
        {
            Assert.That(Skins.Pool.Count(s => s.Category == c), Is.EqualTo(3), c.ToString());
            Assert.That(Skins.BaseOf(c).IsBase, Is.True);
        }
        Assert.That(Skins.Pool.Select(s => s.Id).Take(4), Is.EqualTo(new[] { "WEB_CHAR_01", "WEB_CHAR_02", "WEB_CHAR_03", "WEB_ROD_01" }));
        Assert.That(Skins.Find("WEB_SCENE_03")!.Category, Is.EqualTo(SkinCategory.Scene));
        Assert.That(Skins.Find(null), Is.Null);
        Assert.That((SkinCatalog.DrawCost, SkinCatalog.DuplicateRefund, SkinCatalog.StreakForGuarantee), Is.EqualTo((100, 20, 4)));
    }

    [Test(Description = "B1-40 账本：开发加币记为开发来源，余额与回执一致")]
    public void Dev_coins_are_marked()
    {
        var e = NewEngine();
        var r = e.DevAddCoins(150, 9);
        Assert.That(r.Kind, Is.EqualTo(LedgerKind.Dev));
        Assert.That(r.Delta, Is.EqualTo(150));
        Assert.That(r.BalanceAfter, Is.EqualTo(150));
        Assert.That(r.OpId, Is.EqualTo("dev|1"));
        Assert.That(e.Profile.Coins, Is.EqualTo(150));
        Assert.That(e.Profile.NextLedgerSeq, Is.EqualTo(2));
    }

    [TestCase(0, "TMP_F001")]
    [TestCase(39, "TMP_F001")]
    [TestCase(40, "TMP_F002")]
    [TestCase(79, "TMP_F002")]
    [TestCase(80, "TMP_F003")]
    [TestCase(95, "TMP_F003")]
    [TestCase(96, "TMP_F101")]
    [TestCase(99, "TMP_F101")]
    [Test(Description = "B1-18 WC-02：按权重抽鱼种的每个边界（地图一 40/40/16/4）")]
    public void Weight_boundaries(int r, string species)
    {
        Assert.That(FishCatalog.PickByWeight(Fish.Pool(M1), r).Id, Is.EqualTo(species));
    }

    [Test(Description = "B1-19 WI-09：固定种子出的鱼种和体长是固定值（算法发布后不能改，改了旧档没走完的节点会变）")]
    public void Catch_outcomes_are_locked()
    {
        var e = NewEngine(20261116);
        var dev = e.DevInjectFish(M2, 0);
        // 取前 6 条，种类不全一样，换了种子拼法的变异才逃不掉
        var caught = Feed(e, FishingMode.Wade, M3, 12000).Where(r => r.Catch != null).Take(6)
            .Select(r => $"{r.Catch!.CatchEventId} {r.Catch.SpeciesId} {r.Catch.LengthMm}").ToList();
        Assert.That((dev.SpeciesId, dev.LengthMm), Is.EqualTo(("TMP_F001", 68)));
        Assert.That(caught, Is.EqualTo(new[]
        {
            "catch|wade|map3|0 TMP_F001 66", "catch|wade|map3|1 TMP_F001 67", "catch|wade|map3|2 TMP_F001 86",
            "catch|wade|map3|3 TMP_F001 87", "catch|wade|map3|4 TMP_F002 174", "catch|wade|map3|5 TMP_F002 156",
        }));
    }

    [Test(Description = "B1-30 WA-04：有第二个鱼缸时，按缸取鱼、设背景、读档检查都认准是哪个缸（更多鱼缸以后另定，规则先不写死成一个）")]
    public void Second_tank_is_kept_apart()
    {
        var e = NewEngine();
        e.Profile.Tanks.Add(new Tank { Id = "tank2", Capacity = 20 });
        var a = e.DevInjectFish(M1, 0);
        var b = e.DevInjectFish(M1, 0);
        Assert.That(e.Collect(a.Id, "tank1"), Is.EqualTo(MoveResult.Ok));
        Assert.That(e.Collect(b.Id, "tank2"), Is.EqualTo(MoveResult.Ok));
        Assert.That(e.InTank("tank1").Select(f => f.Id), Is.EqualTo(new[] { a.Id }));
        Assert.That(e.InTank("tank2").Select(f => f.Id), Is.EqualTo(new[] { b.Id }));
        Assert.That(e.SetBackground("tank2"), Is.True);
        Assert.That(e.Profile.BackgroundTankId, Is.EqualTo("tank2"));
        Assert.That(e.SetBackground("tank9"), Is.False);
        Assert.That(e.Profile.BackgroundTankId, Is.EqualTo("tank2"));
        Assert.That(PlayEngine.Validate(e.Profile, Fish, Skins), Is.Null);
    }
}
