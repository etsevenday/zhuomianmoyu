using System;
using System.Collections.Generic;
using System.Linq;

namespace Moyu.Core.Play
{
    /// <summary>
    /// 一种鱼（05 §2 六种临时鱼）。体长以整数毫米保存；价格只按整数毫米和整数币算（04 §1.1）。
    /// 鱼名、描述【交文案策划定】，这里只有内部 ID。
    /// </summary>
    public sealed class FishSpecies
    {
        public string Id { get; }
        public IReadOnlyList<string> MapIds { get; }
        public int MinMm { get; }
        public int MaxMm { get; }
        /// <summary>出鱼成功后在本图鱼池里抽鱼种的相对权重。</summary>
        public int Weight { get; }
        /// <summary>基准价 B 与上下浮动 H。</summary>
        public int PriceBase { get; }
        public int PriceHalfSpan { get; }

        public FishSpecies(string id, IEnumerable<string> mapIds, int minMm, int maxMm, int weight, int priceBase, int priceHalfSpan)
        {
            Id = id;
            MapIds = mapIds.ToList();
            MinMm = minMm;
            MaxMm = maxMm;
            Weight = weight;
            PriceBase = priceBase;
            PriceHalfSpan = priceHalfSpan;
        }

        public bool IsValidLength(int mm) => mm >= MinMm && mm <= MaxMm;

        /// <summary>
        /// 售价：d = 2L − a − b，q = ⌊(2H·|d| + R) / 2R⌋，价 = B + sign(d)·q（04 §1.1）。
        /// 偏移取最近整数，恰好半币时远离中点，所以中点两侧对称个体价格之和恒为 2B。体长不在范围内返回 null，不夹价。
        /// </summary>
        public int? Price(int lengthMm)
        {
            if (!IsValidLength(lengthMm)) return null;
            long r = MaxMm - MinMm;
            long d = 2L * lengthMm - MinMm - MaxMm;
            long q = (2L * PriceHalfSpan * Math.Abs(d) + r) / (2 * r);
            return (int)(PriceBase + Math.Sign(d) * q);
        }
    }

    public sealed class FishCatalog
    {
        public const string ContentVersion = "tmp_fish_0.1";

        private readonly List<FishSpecies> _species;

        public FishCatalog(IEnumerable<FishSpecies> species)
        {
            _species = species.ToList();
        }

        public IReadOnlyList<FishSpecies> All => _species;

        public FishSpecies? Find(string? id) => _species.FirstOrDefault(s => s.Id == id);

        /// <summary>这张图能出的鱼（三种共享 + 本图专属）。</summary>
        public IReadOnlyList<FishSpecies> Pool(string mapId) => _species.Where(s => s.MapIds.Contains(mapId)).ToList();

        /// <summary>按权重从本图鱼池抽一种；r 是 [0, 权重和) 上的整数。</summary>
        public static FishSpecies PickByWeight(IReadOnlyList<FishSpecies> pool, int r)
        {
            foreach (var s in pool)
            {
                if (r < s.Weight) return s;
                r -= s.Weight;
            }
            // Stryker disable once all : r 总小于权重和，走不到这里
            throw new ArgumentOutOfRangeException(nameof(r));
        }

        /// <summary>05 §2 用户已定的六种临时鱼：TMP_F001—F003 三图共享，F101/F201/F301 各属一图。</summary>
        public static FishCatalog CreateTemporary()
        {
            var all = new[] { Scene.MapCatalog.Pond, Scene.MapCatalog.Stream, Scene.MapCatalog.Bay };
            return new FishCatalog(new[]
            {
                new FishSpecies("TMP_F001", all, 60, 100, 40, 16, 4),
                new FishSpecies("TMP_F002", all, 120, 200, 40, 24, 6),
                new FishSpecies("TMP_F003", all, 240, 400, 16, 60, 15),
                new FishSpecies("TMP_F101", new[] { Scene.MapCatalog.Pond }, 450, 650, 4, 150, 30),
                new FishSpecies("TMP_F201", new[] { Scene.MapCatalog.Stream }, 600, 900, 4, 150, 30),
                new FishSpecies("TMP_F301", new[] { Scene.MapCatalog.Bay }, 900, 1300, 4, 150, 30),
            });
        }
    }
}
