using System;
using System.Collections.Generic;
using System.Linq;
using Moyu.Core.Scene;

namespace Moyu.Core.Play
{
    /// <summary>一次有效工作输入的处理结果。</summary>
    public sealed class InputResult
    {
        public FishingMode Mode { get; set; }
        /// <summary>处理后本组本轮进度；手竿为 null。</summary>
        public long? Count { get; set; }
        /// <summary>这次输入正好到了随机节点并判定过。</summary>
        public bool Rolled { get; set; }
        /// <summary>这次输入正好到了保底节点。</summary>
        public bool Guaranteed { get; set; }
        public FishRecord? Catch { get; set; }
    }

    public enum MoveResult
    {
        Ok,
        NoSuchFish,
        WrongPlace,
        NoSuchTank,
        TankFull,
    }

    public enum TradeStatus
    {
        Ok,
        /// <summary>同一操作号已经做过，返回的是当时那张回执，没有再改资产。</summary>
        AlreadyDone,
        /// <summary>有鱼不在鱼篓、找不到或体长/鱼种无效；整批不动。</summary>
        Invalid,
        /// <summary>报价之后鱼或价格变了；整批不动，重新报价。</summary>
        StaleQuote,
        NotEnoughCoins,
        AllOwned,
        Empty,
    }

    public sealed class Quote
    {
        public TradeStatus Status { get; set; }
        public List<SaleLine> Lines { get; set; } = new List<SaleLine>();
        public int Total { get; set; }
    }

    public sealed class TradeResult
    {
        public TradeStatus Status { get; set; }
        public LedgerEntry? Receipt { get; set; }
    }

    /// <summary>
    /// 网页核心循环的玩法规则：输入计数与节点捕获（01）、收藏（03）、出售与抽取（04）。
    /// 只改传进来的 Profile，不碰存储；调用方把一次操作前后的整份档案作为一个事务保存（06 §3）。
    /// 这里的每个方法都是管理或玩法结算，本身不算捕鱼输入；只有 Input 推进计数。
    /// </summary>
    public sealed class PlayEngine
    {
        public const string FirstTankId = "tank1";
        public const int FirstTankCapacity = 20;

        public Profile Profile { get; }
        public FishCatalog Fish { get; }
        public SkinCatalog Skins { get; }

        public PlayEngine(Profile profile, FishCatalog fish, SkinCatalog skins)
        {
            Profile = profile;
            Fish = fish;
            Skins = skins;
        }

        /// <summary>新档（WA-01）：金币 0、空鱼篓、1 个 20 条的免费鱼缸、四类默认外观已装备。</summary>
        public static Profile NewProfile(string profileId, ulong seed, SkinCatalog skins)
        {
            var p = new Profile
            {
                RulesVersion = CaptureRules.RulesVersion,
                ContentVersion = FishCatalog.ContentVersion,
                ProfileId = profileId,
                Seed = seed,
            };
            p.Tanks.Add(new Tank { Id = FirstTankId, Capacity = FirstTankCapacity });
            foreach (var b in skins.Bases)
            {
                p.OwnedSkins.Add(b.Id);
                p.Equipped[b.Category.ToString()] = b.Id;
            }
            return p;
        }

        public static string ModeKey(FishingMode mode) => mode.ToString().ToLowerInvariant();
        public static string GroupKey(FishingMode mode, string mapId) => ModeKey(mode) + "|" + mapId;

        // ---- 输入与节点 ----

        /// <summary>本组本轮进度（没输入过的组是 0）。</summary>
        public long CycleCount(FishingMode mode, string mapId) =>
            Profile.Groups.TryGetValue(GroupKey(mode, mapId), out var g) ? g.Count : 0;

        public long ModeInputs(FishingMode mode) =>
            Profile.ModeInputs.TryGetValue(ModeKey(mode), out var n) ? n : 0;

        /// <summary>本组下一个节点；手竿没有输入节点，返回 null。</summary>
        public int? NextNode(FishingMode mode, string mapId) => CaptureRules.For(mode)?.NextNode(CycleCount(mode, mapId));

        /// <summary>
        /// 接受一次有效工作输入（01 §2—§5）：总累计和本模式统计 +1；主动模式再推进本组本轮，
        /// 到随机节点判一次、到保底节点直接出鱼，成功即生成 1 条鱼并只把本组本轮归零。手竿只计统计。
        /// </summary>
        public InputResult Input(FishingMode mode, string mapId, long nowMs)
        {
            Profile.LifetimeInputs++;
            Profile.ModeInputs[ModeKey(mode)] = ModeInputs(mode) + 1;
            var result = new InputResult { Mode = mode };
            var rule = CaptureRules.For(mode);
            if (rule == null) return result;

            var key = GroupKey(mode, mapId);
            if (!Profile.Groups.TryGetValue(key, out var g)) Profile.Groups[key] = g = new ProgressGroup();
            g.Count++;
            bool success = false;
            if (g.Count == rule.GuaranteedNode)
            {
                result.Guaranteed = true;
                success = true;
            }
            else if (rule.RandomNodes.Any(n => n == g.Count))
            {
                result.Rolled = true;
                // Stryker disable once Equality : < 和 <= 只差在 Unit 恰好等于概率的那一个值上，哈希落到那点的机会约 2^-53，找不到能测的种子，玩家也遇不到
                success = Dice.Unit(Profile.Seed, $"node|{key}|{g.Cycle}|{g.Count}") < rule.NodeProbability;
            }

            if (success)
            {
                var eventId = $"catch|{key}|{g.Cycle}";
                result.Catch = MakeFish(eventId, ModeKey(mode), mapId, nowMs, CatchSource.Normal);
                result.Catch.Guaranteed = result.Guaranteed;
                g.Count = 0;
                g.Cycle++;
            }
            result.Count = g.Count;
            return result;
        }

        /// <summary>开发入口：按本图鱼池造一条鱼，来源记为开发（05 §3），不推进任何计数。</summary>
        public FishRecord DevInjectFish(string mapId, long nowMs) =>
            MakeFish($"dev|{Profile.NextFishSeq}", "dev", mapId, nowMs, CatchSource.Dev);

        /// <summary>按捕获事件号生成鱼种和体长：先按权重抽鱼种，再在含端点的毫米范围里等概率取体长（05 §2）。</summary>
        private FishRecord MakeFish(string eventId, string mode, string mapId, long nowMs, CatchSource source)
        {
            var pool = Fish.Pool(mapId);
            var species = FishCatalog.PickByWeight(pool, Dice.Below(Profile.Seed, eventId + "|species", pool.Sum(s => s.Weight)));
            int length = species.MinMm + Dice.Below(Profile.Seed, eventId + "|length", species.MaxMm - species.MinMm + 1);
            var fish = new FishRecord
            {
                Id = "F" + Profile.NextFishSeq++,
                SpeciesId = species.Id,
                LengthMm = length,
                Mode = mode,
                MapId = mapId,
                CaughtAtMs = nowMs,
                CatchEventId = eventId,
                ContentVersion = FishCatalog.ContentVersion,
                Source = source,
                Place = FishPlace.Basket,
            };
            Profile.Fish.Add(fish);

            if (!Profile.Records.TryGetValue(species.Id, out var rec))
                Profile.Records[species.Id] = rec = new SpeciesRecord { FirstAtMs = nowMs };
            rec.Count++;
            if (length > rec.MaxLengthMm)
            {
                rec.MaxLengthMm = length;
                rec.MaxFishId = fish.Id;
            }
            return fish;
        }

        // ---- 鱼篓与收藏 ----

        public FishRecord? FindFish(string id) => Profile.Fish.FirstOrDefault(f => f.Id == id);
        public IEnumerable<FishRecord> InBasket => Profile.Fish.Where(f => f.Place == FishPlace.Basket);
        public IEnumerable<FishRecord> InTank(string tankId) => Profile.Fish.Where(f => f.Place == FishPlace.Tank && f.TankId == tankId);

        /// <summary>鱼篓里的鱼放进鱼缸；满了放不进，鱼留在鱼篓（WA-02），不先删来源。</summary>
        public MoveResult Collect(string fishId, string tankId)
        {
            var fish = FindFish(fishId);
            if (fish == null) return MoveResult.NoSuchFish;
            if (fish.Place != FishPlace.Basket) return MoveResult.WrongPlace;
            var tank = Profile.Tanks.FirstOrDefault(t => t.Id == tankId);
            if (tank == null) return MoveResult.NoSuchTank;
            if (InTank(tankId).Count() >= tank.Capacity) return MoveResult.TankFull;
            fish.Place = FishPlace.Tank;
            fish.TankId = tankId;
            return MoveResult.Ok;
        }

        /// <summary>鱼缸里的鱼取回鱼篓；取回后才能出售（04 §1）。</summary>
        public MoveResult Retrieve(string fishId)
        {
            var fish = FindFish(fishId);
            if (fish == null) return MoveResult.NoSuchFish;
            if (fish.Place != FishPlace.Tank) return MoveResult.WrongPlace;
            fish.Place = FishPlace.Basket;
            fish.TankId = null;
            return MoveResult.Ok;
        }

        /// <summary>把一个自己的鱼缸设为观赏背景，null 取消。换背景不碰地图、模式、落点和鱼的归属（03 §3）。</summary>
        public bool SetBackground(string? tankId)
        {
            if (tankId != null && Profile.Tanks.All(t => t.Id != tankId)) return false;
            Profile.BackgroundTankId = tankId;
            return true;
        }

        // ---- 出售 ----

        /// <summary>给鱼篓里的一批鱼报价：逐条按整数毫米算整数价再相加（04 §1.1）。任一条不可卖就整批拒绝。</summary>
        public Quote QuoteSale(IReadOnlyList<string> fishIds)
        {
            var quote = new Quote();
            if (fishIds.Count == 0)
            {
                quote.Status = TradeStatus.Empty;
                return quote;
            }
            foreach (var id in fishIds.Distinct())
            {
                var fish = FindFish(id);
                var species = Fish.Find(fish?.SpeciesId);
                int? price = fish == null || species == null ? null : species.Price(fish.LengthMm);
                if (fish == null || fish.Place != FishPlace.Basket || price == null)
                {
                    quote.Status = TradeStatus.Invalid;
                    quote.Lines.Clear();
                    quote.Total = 0;
                    return quote;
                }
                quote.Lines.Add(new SaleLine { FishId = fish.Id, SpeciesId = fish.SpeciesId, LengthMm = fish.LengthMm, Price = price.Value });
                quote.Total += price.Value;
            }
            return quote;
        }

        /// <summary>
        /// 确认出售：同一笔里把鱼标成已出售、金币加合计、记回执（04 §1）。
        /// 同一操作号只做一次；报价后鱼动过或合计对不上就整批不卖（WE-03）。
        /// </summary>
        public TradeResult Sell(string opId, IReadOnlyList<string> fishIds, int quotedTotal, long nowMs)
        {
            var done = Profile.Ledger.FirstOrDefault(e => e.OpId == opId);
            if (done != null) return new TradeResult { Status = TradeStatus.AlreadyDone, Receipt = done };
            var quote = QuoteSale(fishIds);
            if (quote.Status != TradeStatus.Ok) return new TradeResult { Status = quote.Status == TradeStatus.Invalid ? TradeStatus.StaleQuote : quote.Status };
            if (quote.Total != quotedTotal) return new TradeResult { Status = TradeStatus.StaleQuote };

            foreach (var line in quote.Lines)
            {
                var fish = FindFish(line.FishId)!;
                fish.Place = FishPlace.Sold;
                fish.TankId = null;
            }
            Profile.Coins += quote.Total;
            var receipt = AddLedger(opId, LedgerKind.Sale, quote.Total, nowMs);
            receipt.Lines = quote.Lines;
            return new TradeResult { Status = TradeStatus.Ok, Receipt = receipt };
        }

        // ---- 外观 ----

        public bool Owns(string skinId) => Profile.OwnedSkins.Contains(skinId);
        public bool AllOwned => Skins.Pool.All(s => Owns(s.Id));
        /// <summary>下一抽是不是连续重复后的必新抽。</summary>
        public bool NextDrawGuaranteed => Profile.DuplicateStreak >= SkinCatalog.StreakForGuarantee;

        /// <summary>
        /// 抽一次（04 §3）：要有 100 币；普通抽在 12 款里等概率抽，抽到已有的返 20 币、连续重复 +1；
        /// 连续重复已到 4 次时这一抽只从未拥有里等概率抽。扣币、返还或解锁、计数、回执在同一笔里。不自动装备。
        /// </summary>
        public TradeResult Draw(string opId, long nowMs)
        {
            var done = Profile.Ledger.FirstOrDefault(e => e.OpId == opId);
            if (done != null) return new TradeResult { Status = TradeStatus.AlreadyDone, Receipt = done };
            if (AllOwned) return new TradeResult { Status = TradeStatus.AllOwned };
            if (Profile.Coins < SkinCatalog.DrawCost) return new TradeResult { Status = TradeStatus.NotEnoughCoins };

            Profile.DrawSeq++;
            var key = $"draw|{Profile.DrawSeq}";
            bool guaranteed = NextDrawGuaranteed;
            var candidates = guaranteed ? Skins.Pool.Where(s => !Owns(s.Id)).ToList() : Skins.Pool.ToList();
            var skin = candidates[Dice.Below(Profile.Seed, key, candidates.Count)];
            bool duplicate = Owns(skin.Id);
            int delta = -SkinCatalog.DrawCost;
            if (duplicate)
            {
                delta += SkinCatalog.DuplicateRefund;
                Profile.DuplicateStreak++;
            }
            else
            {
                Profile.OwnedSkins.Add(skin.Id);
                Profile.DuplicateStreak = 0;
            }
            Profile.Coins += delta;
            var receipt = AddLedger(opId, LedgerKind.Draw, delta, nowMs);
            receipt.SkinId = skin.Id;
            receipt.Duplicate = duplicate;
            receipt.Guaranteed = guaranteed;
            return new TradeResult { Status = TradeStatus.Ok, Receipt = receipt };
        }

        /// <summary>装备一件已拥有的外观；未拥有或不认识的不换，原装备不变（WE-07）。</summary>
        public bool Equip(string skinId)
        {
            var skin = Skins.Find(skinId);
            if (skin == null || !Owns(skinId)) return false;
            Profile.Equipped[skin.Category.ToString()] = skin.Id;
            return true;
        }

        public string EquippedId(SkinCategory c) =>
            Profile.Equipped.TryGetValue(c.ToString(), out var id) ? id : Skins.BaseOf(c).Id;

        /// <summary>开发入口：加金币，账本里记为开发来源。</summary>
        public LedgerEntry DevAddCoins(int amount, long nowMs)
        {
            Profile.Coins += amount;
            return AddLedger($"dev|{Profile.NextLedgerSeq}", LedgerKind.Dev, amount, nowMs);
        }

        private LedgerEntry AddLedger(string opId, LedgerKind kind, int delta, long nowMs)
        {
            var e = new LedgerEntry
            {
                Id = "R" + Profile.NextLedgerSeq++,
                OpId = opId,
                Kind = kind,
                AtMs = nowMs,
                Delta = delta,
                BalanceAfter = Profile.Coins,
            };
            Profile.Ledger.Add(e);
            return e;
        }

        // ---- 读档检查 ----

        /// <summary>
        /// 读进来的档案是否可用。不可用时调用方不能拿空档覆盖它（WA-06），返回原因；可用返回 null。
        /// </summary>
        public static string? Validate(Profile? p, FishCatalog fish, SkinCatalog skins)
        {
            if (p == null) return "空档案";
            if (p.Schema != Profile.CurrentSchema) return "存档版本不认识";
            if (p.ModeInputs == null || p.Groups == null || p.Fish == null || p.Records == null || p.Tanks == null
                || p.OwnedSkins == null || p.Equipped == null || p.Ledger == null) return "存档缺字段";
            if (p.LifetimeInputs < 0 || p.Coins < 0 || p.DuplicateStreak < 0) return "计数为负";
            if (p.Groups.Values.Any(g => g == null || g.Count < 0)) return "进度为负";
            if (p.Tanks.Count == 0) return "没有鱼缸";
            foreach (var f in p.Fish)
            {
                var s = fish.Find(f?.SpeciesId);
                if (f == null || s == null || !s.IsValidLength(f.LengthMm)) return "鱼的数据无效";
                if (f.Place == FishPlace.Tank && p.Tanks.All(t => t.Id != f.TankId)) return "鱼在不存在的鱼缸里";
            }
            if (p.OwnedSkins.Any(id => skins.Find(id) == null)) return "外观不认识";
            return null;
        }
    }
}
