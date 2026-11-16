using System.Collections.Generic;
using System.Linq;

namespace Moyu.Core.Scene
{
    /// <summary>
    /// 一张地图的活动区域。岸边、浅水各是一整片连续范围（09 §4.1），
    /// 装饰占的地方另列为禁入块。坐标为 1600×900 画布。
    /// </summary>
    public sealed class MapDef
    {
        public string Id { get; }
        /// <summary>占位显示名（地图名【交文案策划定】，B0 Q5 定稿前用效果图上的"地图一/二/三"）。</summary>
        public string PlaceholderName { get; }
        public SceneRect Shore { get; }
        public SceneRect Shallow { get; }
        public IReadOnlyList<SceneRect> ShoreBlocked { get; }
        public IReadOnlyList<SceneRect> ShallowBlocked { get; }
        /// <summary>自动安排时优先靠近的横坐标。</summary>
        public double ShoreAnchorX { get; }
        public double ShallowAnchorX { get; }

        public MapDef(string id, string placeholderName, SceneRect shore, SceneRect shallow,
            IEnumerable<SceneRect> shoreBlocked, IEnumerable<SceneRect> shallowBlocked,
            double shoreAnchorX, double shallowAnchorX)
        {
            Id = id;
            PlaceholderName = placeholderName;
            Shore = shore;
            Shallow = shallow;
            ShoreBlocked = shoreBlocked.ToList();
            ShallowBlocked = shallowBlocked.ToList();
            ShoreAnchorX = shoreAnchorX;
            ShallowAnchorX = shallowAnchorX;
        }

        public SceneRect AreaOf(AreaKind kind) => kind == AreaKind.Shore ? Shore : Shallow;
        public IReadOnlyList<SceneRect> BlockedOf(AreaKind kind) => kind == AreaKind.Shore ? ShoreBlocked : ShallowBlocked;
        public double AnchorXOf(AreaKind kind) => kind == AreaKind.Shore ? ShoreAnchorX : ShallowAnchorX;
    }

    /// <summary>
    /// 首发三张地图（用户基线）。题材、名称、鱼池均未定（03 §1）；
    /// 第一阶段三图共用开发方先划的占位区域（B0 Q3），只在画面配色上区分。
    /// </summary>
    public sealed class MapCatalog
    {
        public const string Pond = "map1";
        public const string Stream = "map2";
        public const string Bay = "map3";

        private readonly List<MapDef> _maps;

        public MapCatalog(IEnumerable<MapDef> maps)
        {
            _maps = maps.ToList();
        }

        public IReadOnlyList<MapDef> All => _maps;
        public MapDef Default => _maps[0];

        public MapDef? Find(string? id) => _maps.FirstOrDefault(m => m.Id == id);

        public static MapCatalog CreatePlaceholder()
        {
            // 岸边：水面上沿那条连续草岸；浅水：靠岸的一整条水带。两端各留出画面边缘。
            var shore = new SceneRect(40, 540, 1560, 590);
            var shallow = new SceneRect(40, 650, 1560, 760);
            // 岸上两株荷花的茎、水里的大荷叶是装饰，不让角色站上去。
            var shoreBlocked = new[] { new SceneRect(110, 520, 170, 600), new SceneRect(1440, 520, 1500, 600) };
            var shallowBlocked = new[] { new SceneRect(960, 650, 1340, 735) };
            MapDef Make(string id, string name) => new MapDef(id, name, shore, shallow, shoreBlocked, shallowBlocked, 330, 420);
            return new MapCatalog(new[] { Make(Pond, "地图一"), Make(Stream, "地图二"), Make(Bay, "地图三") });
        }
    }
}
