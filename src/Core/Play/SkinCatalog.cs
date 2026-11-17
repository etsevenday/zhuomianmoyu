using System.Collections.Generic;
using System.Linq;

namespace Moyu.Core.Play
{
    /// <summary>四类外观（04 §4），四类可同时各装备 1 件。</summary>
    public enum SkinCategory
    {
        Character,
        Rod,
        Glove,
        Scene,
    }

    public sealed class SkinDef
    {
        public string Id { get; }
        public SkinCategory Category { get; }
        /// <summary>默认外观：一开始就有，不进抽取池。</summary>
        public bool IsBase { get; }

        public SkinDef(string id, SkinCategory category, bool isBase)
        {
            Id = id;
            Category = category;
            IsBase = isBase;
        }
    }

    /// <summary>首批 12 件可抽外观 + 4 件默认（WEB-DEC-08）。名称与描述按文案定稿 §9 放在网页 Texts。纯外观，不影响任何玩法数值。</summary>
    public sealed class SkinCatalog
    {
        public const int DrawCost = 100;
        public const int DuplicateRefund = 20;
        /// <summary>连续重复到这个次数后，下一抽只从未拥有里抽（04 §3）。</summary>
        public const int StreakForGuarantee = 4;

        private readonly List<SkinDef> _all;

        public SkinCatalog(IEnumerable<SkinDef> all)
        {
            _all = all.ToList();
        }

        public IReadOnlyList<SkinDef> All => _all;
        /// <summary>抽取池，按表格顺序。</summary>
        public IReadOnlyList<SkinDef> Pool => _all.Where(s => !s.IsBase).ToList();
        public IReadOnlyList<SkinDef> Bases => _all.Where(s => s.IsBase).ToList();

        public SkinDef? Find(string? id) => _all.FirstOrDefault(s => s.Id == id);
        // Stryker disable once Linq : 每一类都有默认款（目录测试 B1-21 保证），First 和 FirstOrDefault 结果一样
        public SkinDef BaseOf(SkinCategory c) => _all.First(s => s.IsBase && s.Category == c);

        public static SkinCatalog CreateFirstBatch()
        {
            var list = new List<SkinDef>
            {
                new SkinDef("BASE_CHAR", SkinCategory.Character, true),
                new SkinDef("BASE_ROD", SkinCategory.Rod, true),
                new SkinDef("BASE_GLOVE", SkinCategory.Glove, true),
                new SkinDef("BASE_SCENE", SkinCategory.Scene, true),
            };
            foreach (var (prefix, cat) in new[] { ("WEB_CHAR", SkinCategory.Character), ("WEB_ROD", SkinCategory.Rod), ("WEB_GLOVE", SkinCategory.Glove), ("WEB_SCENE", SkinCategory.Scene) })
                for (int i = 1; i <= 3; i++)
                    list.Add(new SkinDef($"{prefix}_0{i}", cat, false));
            return new SkinCatalog(list);
        }
    }
}
