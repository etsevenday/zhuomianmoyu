using System.Collections.Generic;
using System.Linq;
using Moyu.Core.Scene;

namespace Moyu.Core.Rooms
{
    /// <summary>房间的运行种类：网页只有本机模拟（Q14 选 B），PC 以后接 Steam 真实房间。</summary>
    public enum RoomKind
    {
        Simulated,
        Real,
    }

    public enum RoomResult
    {
        Ok,
        /// <summary>已满 4 人（Q15），第 5 人不加入、不挤走已有成员。</summary>
        Full,
        /// <summary>只有房主能切图（Q17）。</summary>
        NotHost,
        /// <summary>房主迁移中，暂不接受切图、选位确认（01 §4.4）。</summary>
        Migrating,
        /// <summary>没有这个成员，或房间已结束。</summary>
        NotFound,
        /// <summary>切到当前地图或不认识的地图：什么都不改。</summary>
        Unchanged,
    }

    /// <summary>
    /// 某成员当前设为背景的鱼缸的展示快照（01 §3 只读鱼缸）：只有鱼形、名称（由鱼种得出）和体长，
    /// 不带金币、鱼篓或别的容器。TankId 为空表示没设背景。
    /// </summary>
    public sealed class TankSnapshot
    {
        public string? TankId { get; }
        public IReadOnlyList<(string SpeciesId, int LengthMm)> Fish { get; }
        public int Capacity { get; }

        public TankSnapshot(string? tankId, IEnumerable<(string SpeciesId, int LengthMm)> fish, int capacity)
        {
            TankId = tankId;
            Fish = fish.ToList();
            Capacity = capacity;
        }

        public static readonly TankSnapshot NotSet = new TankSnapshot(null, Enumerable.Empty<(string, int)>(), 0);
    }

    public enum TankViewState
    {
        Fish,
        Empty,
        NotSet,
        /// <summary>对方已离开或断线，旧快照不能当在线的看（Q21）。</summary>
        Gone,
    }

    public sealed class RoomMember
    {
        public string Id { get; }
        public string Name { get; }
        public bool IsSelf { get; }
        public bool IsSimulated { get; }
        /// <summary>加入次序，迁移时按它选新房主（加入最早的先接）。重新加入算新加入。</summary>
        public int JoinOrder { get; internal set; }
        public FishingMode Mode { get; internal set; }
        /// <summary>地图空间里的已确认落点（09 §3），和桌面窗口位置无关；安排失败为 null。</summary>
        public ScenePoint? Spot { get; internal set; }
        // 外观和展示缸：本人的这几项由网页实时读档案，房间里只给模拟成员存样本（Q20、Q21）
        public string Character { get; set; } = "BASE_CHAR";
        public string Rod { get; set; } = "BASE_ROD";
        public string Glove { get; set; } = "BASE_GLOVE";
        public string SceneSkin { get; set; } = "BASE_SCENE";
        public TankSnapshot Tank { get; set; } = TankSnapshot.NotSet;

        public RoomMember(string id, string name, bool isSelf, bool isSimulated, FishingMode mode)
        {
            Id = id;
            Name = name;
            IsSelf = isSelf;
            IsSimulated = isSimulated;
            Mode = mode;
        }
    }

    /// <summary>
    /// 同图房间的状态机（同图房间 01 §4）。房主端统一确认地图和位置；每人的输入、出鱼、金币、收藏都在各自档里算，
    /// 房间只管展示（Q16 交开发方定，按推荐 A）。网页里只有本机模拟成员，PC 以后换连接来源，规则照用。
    /// </summary>
    public sealed class Room
    {
        public const int Capacity = 4;

        private readonly MapCatalog _maps;
        private readonly SpotPlanner _planner = new SpotPlanner();
        private readonly List<RoomMember> _members = new List<RoomMember>();
        private readonly HashSet<string> _seenEvents = new HashSet<string>();
        private int _nextJoin;

        public RoomKind Kind { get; }
        /// <summary>房间代次：每次换房主加 1，旧代次的消息一律不认（01 §6）。</summary>
        public int Epoch { get; private set; } = 1;
        public string? HostId { get; private set; }
        public string MapId { get; private set; }
        public bool Migrating { get; private set; }
        public bool Ended { get; private set; }

        public IReadOnlyList<RoomMember> Members => _members;
        public RoomMember? Host => Find(HostId);
        // Stryker disable once all : MapId 只在构造和 SwitchMap 里赋值，两处都核过是目录里的图，Find 不会落空
        public MapDef Map => _maps.Find(MapId) ?? _maps.Default;

        private Room(MapCatalog maps, RoomKind kind, string mapId)
        {
            _maps = maps;
            Kind = kind;
            MapId = maps.Find(mapId)?.Id ?? maps.Default.Id;
        }

        /// <summary>本人建房：本人是房主，房间地图是本人当前地图，本人落点照旧（单人时本来就放得下）。</summary>
        public static Room Create(MapCatalog maps, RoomKind kind, RoomMember self, string mapId, ScenePoint? spot)
        {
            var room = new Room(maps, kind, mapId);
            room.Enter(self);
            self.Spot = spot ?? room.Arrange(self);
            room.HostId = self.Id;
            return room;
        }

        /// <summary>别人开的房间：只有房主，房间地图是房主的。其他人随后用 Add 加入。</summary>
        public static Room Open(MapCatalog maps, RoomKind kind, RoomMember host, string mapId)
        {
            var room = new Room(maps, kind, mapId);
            room.Enter(host);
            host.Spot = room.Arrange(host);
            room.HostId = host.Id;
            return room;
        }

        /// <summary>以成员身份加入：房主先在房间里，房间地图是房主的；本人跟到这张图、重新安排位置（Q17(1)）。</summary>
        public static Room Join(MapCatalog maps, RoomKind kind, RoomMember host, string mapId, RoomMember self)
        {
            var room = Open(maps, kind, host, mapId);
            room.Add(self);
            return room;
        }

        public RoomMember? Find(string? id) => _members.FirstOrDefault(m => m.Id == id);

        /// <summary>新成员加入（含重新加入）：满 4 人拒绝；否则排到最后、自动安排位置。</summary>
        public RoomResult Add(RoomMember member)
        {
            if (Ended) return RoomResult.NotFound;
            if (_members.Count >= Capacity) return RoomResult.Full;
            Enter(member);
            member.Spot = Arrange(member);
            return RoomResult.Ok;
        }

        /// <summary>
        /// 主动离开或确认断线：立即移除、释放位置，保留 0 秒（Q19）。房主走了先进迁移（Q18），没人剩下房间结束。
        /// </summary>
        public RoomResult Remove(string id)
        {
            var member = Find(id);
            if (member == null) return RoomResult.NotFound;
            _members.Remove(member);
            member.Spot = null;
            if (_members.Count == 0)
            {
                End();
                return RoomResult.Ok;
            }
            if (id == HostId)
            {
                HostId = null;
                Migrating = true;
            }
            return RoomResult.Ok;
        }

        /// <summary>迁移成功：加入最早的有效成员接任房主，代次加 1；地图和各人落点都不动。</summary>
        public RoomMember? CompleteMigration()
        {
            if (!Migrating) return null;
            // Stryker disable once Linq : 迁移中一定还有成员（最后一人离开时房间直接结束），First 和 FirstOrDefault 结果一样
            var next = _members.OrderBy(m => m.JoinOrder).First();
            HostId = next.Id;
            Epoch++;
            Migrating = false;
            return next;
        }

        /// <summary>迁移失败：房间结束，各人回单机（个人档本来就不在房间里，不用回滚）。</summary>
        public void FailMigration()
        {
            if (Migrating) End();
        }

        public void End()
        {
            Ended = true;
            Migrating = false;
            HostId = null;
        }

        /// <summary>切公共地图：只有房主能切；全房一起换，各人模式不变，按加入次序重新安排（Q17(2)）。</summary>
        public RoomResult SwitchMap(string requesterId, string mapId)
        {
            if (Find(requesterId) == null || Ended) return RoomResult.NotFound;
            if (Migrating) return RoomResult.Migrating;
            if (requesterId != HostId) return RoomResult.NotHost;
            var map = _maps.Find(mapId);
            if (map == null || map.Id == MapId) return RoomResult.Unchanged;
            MapId = map.Id;
            foreach (var m in _members) m.Spot = null;
            foreach (var m in _members.OrderBy(m => m.JoinOrder)) m.Spot = Arrange(m);
            return RoomResult.Ok;
        }

        /// <summary>成员为自己选位（09 §4.3）：放得下就换，放不下保留原位；迁移中不确认。</summary>
        public (RoomResult Result, PlaceResult Place) Place(string memberId, ScenePoint target)
        {
            var member = Find(memberId);
            if (member == null || Ended) return (RoomResult.NotFound, PlaceResult.NotInArea);
            if (Migrating) return (RoomResult.Migrating, PlaceResult.NoRoom);
            var place = _planner.TryPlace(Map, member.Mode, target, OthersIn(member));
            if (place == PlaceResult.Placed) member.Spot = target;
            return (RoomResult.Ok, place);
        }

        /// <summary>成员换模式：换到另一种区域（岸边↔浅水）或原来没落点才重新安排，岸边两种模式之间不动（09 §2）。</summary>
        public RoomResult SetMode(string memberId, FishingMode mode)
        {
            var member = Find(memberId);
            if (member == null || Ended) return RoomResult.NotFound;
            if (Migrating) return RoomResult.Migrating;
            bool sameArea = member.Mode.Area() == mode.Area();
            member.Mode = mode;
            if (!sameArea || member.Spot == null) member.Spot = Arrange(member);
            return RoomResult.Ok;
        }

        /// <summary>同一区域里别人的落点，选位和安排时都要避开。</summary>
        public IEnumerable<ScenePoint> OthersIn(RoomMember member) =>
            _members.Where(m => m != member && m.Spot.HasValue && m.Mode.Area() == member.Mode.Area()).Select(m => m.Spot!.Value);

        /// <summary>
        /// 好友收获表现：同一事件只认一次；旧代次、已不在房间的成员的消息不认（01 §6、SIM-10）。
        /// 接受了才出卡片和提示音；无论接不接受，都没有给本人发鱼发钱的权限。
        /// </summary>
        public bool AcceptCatch(string memberId, string eventId, int epoch)
        {
            if (Ended || epoch != Epoch || Find(memberId) == null) return false;
            return _seenEvents.Add(eventId);
        }

        /// <summary>只读看某成员当前的背景缸（Q21）：离开了的不再给旧快照。</summary>
        public (TankViewState State, TankSnapshot Tank) ViewTank(string memberId)
        {
            var member = Ended ? null : Find(memberId);
            if (member == null) return (TankViewState.Gone, TankSnapshot.NotSet);
            var tank = member.Tank;
            if (tank.TankId == null) return (TankViewState.NotSet, tank);
            return (tank.Fish.Count == 0 ? TankViewState.Empty : TankViewState.Fish, tank);
        }

        private void Enter(RoomMember member)
        {
            member.JoinOrder = _nextJoin++;
            _members.Add(member);
        }

        private ScenePoint? Arrange(RoomMember member) => _planner.Arrange(Map, member.Mode, OthersIn(member));
    }
}
