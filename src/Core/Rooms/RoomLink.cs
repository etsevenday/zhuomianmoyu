using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Moyu.Core.Scene;

namespace Moyu.Core.Rooms
{
    /// <summary>
    /// 每位成员自己写的展示资料（房间服务的"成员数据"，每人只能写自己的）：名字、进房时的模式、外观、场景主题、背景缸（Q20、Q21）。
    /// 不带金币、鱼篓、输入记录。
    /// </summary>
    public sealed class MemberProfile
    {
        public string Name { get; set; } = "";
        public FishingMode Mode { get; set; }
        public string Character { get; set; } = "BASE_CHAR";
        public string Rod { get; set; } = "BASE_ROD";
        public string Glove { get; set; } = "BASE_GLOVE";
        public string SceneSkin { get; set; } = "BASE_SCENE";
        public TankSnapshot Tank { get; set; } = TankSnapshot.NotSet;

        public void ApplyTo(RoomMember m)
        {
            m.Name = Name;
            m.Character = Character;
            m.Rod = Rod;
            m.Glove = Glove;
            m.SceneSkin = SceneSkin;
            m.Tank = Tank;
        }
    }

    /// <summary>交给房间服务执行的命令（PC 是 Steam 小程序，测试是本机回环服务）。</summary>
    public enum LinkOp
    {
        /// <summary>写房间数据（只有房间所有者写得进去）：Key 是 "ver" 或 "room"。</summary>
        SetLobbyData,
        /// <summary>写自己的成员数据（资料）。</summary>
        SetMemberData,
        /// <summary>发给 To 一个人。</summary>
        Send,
        /// <summary>发给房间里除自己以外的每个人。</summary>
        Broadcast,
        /// <summary>离开房间。</summary>
        Leave,
    }

    public sealed class LinkCommand
    {
        public LinkOp Op { get; }
        public string Key { get; }
        public string Text { get; }

        public LinkCommand(LinkOp op, string key, string text)
        {
            Op = op;
            Key = key;
            Text = text;
        }

        public override string ToString() => $"{Op} {Key} {Text}";

        // Stryker disable once String : 离开只看 Op，Key 和 Text 用不上
        public static LinkCommand Leave() => new LinkCommand(LinkOp.Leave, "", "");
        // Stryker disable once String : 写成员数据只看 Op 和 Text，Key 用不上
        public static LinkCommand MemberData(string text) => new LinkCommand(LinkOp.SetMemberData, "", text);
    }

    /// <summary>给界面的结果：提示哪句话、要不要演动作和卡片。</summary>
    public enum LinkNoteKind
    {
        /// <summary>本人进房了（建房的房主、或成员在快照里看到了自己）。</summary>
        Joined,
        /// <summary>镜像变了（地图、成员、落点、房主），界面重画、本人落点抄回。</summary>
        Changed,
        /// <summary>普通成员确认断线（TXT-ROOM-034）。</summary>
        MemberGone,
        /// <summary>离开过的人回来了（TXT-ROOM-033）。</summary>
        Rejoined,
        /// <summary>房主离开，迁移中（TXT-ROOM-029）。</summary>
        Migrating,
        /// <summary>新房主（TXT-ROOM-030）。</summary>
        NewHost,
        /// <summary>迁移超时，房间结束，已离开（TXT-ROOM-031）。</summary>
        MigrationFailed,
        /// <summary>版本不一致，已离开（TXT-ROOM-044）。</summary>
        VersionMismatch,
        /// <summary>房主的快照里没有本人了：按断线处理（TXT-ROOM-035）。</summary>
        SelfRemoved,
        /// <summary>选位结果回来了：Place 和 Point。</summary>
        PlaceResult,
        /// <summary>好友收获：MemberId、SpeciesId、LengthMm。</summary>
        FriendCatch,
        /// <summary>好友动作：MemberId。</summary>
        FriendAct,
    }

    public sealed class LinkNote
    {
        public LinkNoteKind Kind { get; set; }
        public string? MemberId { get; set; }
        public string Name { get; set; } = "";
        public PlaceResult Place { get; set; }
        public ScenePoint Point { get; set; }
        public string SpeciesId { get; set; } = "";
        public int LengthMm { get; set; }

        public override string ToString() => $"{Kind} {MemberId} {Name}";
    }

    /// <summary>
    /// 联机房间的协议（NET-EVAL-001 §4）：一位成员一份，接房间服务推来的事件，产出要执行的命令和给界面的结果。不碰网络、不碰存档。
    /// 房主就是房间服务的"所有者"（唯一；离开时服务自动交给别人）。房主端的 Room 是权威的：成员发请求，房主用 Room 判定、回结果、
    /// 发快照（代次 + 修订）；成员只按快照改镜像。个人资产各算各的（Q16 推荐 A），房间只传展示。
    /// </summary>
    public sealed class RoomLink
    {
        /// <summary>房主离开后多久还没有新房主就算迁移失败（01 §4.4 不能无限停在迁移中）。实测交接约 1.2 秒（NET-EVAL-001 §8）。</summary>
        public const long MigrationTimeoutMs = 10000;

        private readonly MapCatalog _maps;
        private readonly Func<long> _clock;
        private readonly string _nonce;
        private readonly Dictionary<string, MemberProfile> _profiles = new Dictionary<string, MemberProfile>();
        private readonly HashSet<string> _lobby = new HashSet<string>();
        private readonly HashSet<string> _departed = new HashSet<string>();
        private readonly Dictionary<int, ScenePoint> _pendingPlace = new Dictionary<int, ScenePoint>();
        private readonly Dictionary<string, (int Req, string Reply)> _lastReply = new Dictionary<string, (int, string)>();
        private MemberProfile _self;
        private string? _owner;
        private int _rev;
        private int _reqSeq;
        private int _eventSeq;
        private long? _migratingSince;
        private bool _joined;

        public string SelfId { get; }
        public string Version { get; }
        /// <summary>进房后才有；离开、迁移失败、版本不一致后为 null。</summary>
        public Room? Room { get; private set; }
        public bool IsHost => Room != null && !Room.Migrating && Room.HostId == SelfId;
        public List<LinkCommand> Out { get; } = new List<LinkCommand>();
        public List<LinkNote> Notes { get; } = new List<LinkNote>();

        /// <param name="nonce">本次连接独有的一段字，拼进收获事件号：重新进房后事件号不会和以前的撞上。</param>
        public RoomLink(MapCatalog maps, string selfId, string version, MemberProfile self, Func<long> clock, string nonce)
        {
            _maps = maps;
            SelfId = selfId;
            Version = version;
            _self = self;
            _clock = clock;
            _nonce = nonce;
        }

        // ---- 房间服务推来的事件 ----

        /// <summary>
        /// 进了房间：自己是所有者且还没有快照就是刚建的房（本人当房主，地图和落点照旧）；否则先核版本，对得上就交资料、等快照。
        /// </summary>
        public void Entered(string ownerId, IEnumerable<string> members, string? version, string? snapshot,
            IDictionary<string, string> profiles, string mapId, ScenePoint? spot)
        {
            _owner = ownerId;
            if (ownerId == SelfId && snapshot == null)
            {
                Room = Room.Create(_maps, RoomKind.Real, NewMember(SelfId), mapId, spot);
                Out.Add(new LinkCommand(LinkOp.SetLobbyData, "ver", Version));
                Out.Add(LinkCommand.MemberData(RoomWire.Profile(_self)));
                Publish();
                Note(LinkNoteKind.Joined);
                return;
            }
            if (version != Version)
            {
                Out.Add(LinkCommand.Leave());
                Note(LinkNoteKind.VersionMismatch);
                return;
            }
            foreach (var id in members) _lobby.Add(id);
            foreach (var kv in profiles)
            {
                var p = RoomWire.ParseProfile(kv.Value);
                if (p != null) _profiles[kv.Key] = p;
            }
            Room = Room.Mirror(_maps, RoomKind.Real);
            Out.Add(LinkCommand.MemberData(RoomWire.Profile(_self)));
            if (snapshot != null) LobbyData(snapshot);
        }

        public void MemberJoined(string id)
        {
            if (Room == null) return;
            _lobby.Add(id);
            if (IsHost) TryAdd(id);
        }

        /// <summary>有人离开（dropped 为确认断线）：立即从房间移除、释放位置（Q19）；走的是房主就进迁移（Q18）。</summary>
        public void MemberLeft(string id, bool dropped)
        {
            if (Room == null || id == SelfId) return;
            _lobby.Remove(id);
            _profiles.Remove(id);
            _lastReply.Remove(id); // 重进的人请求号从头数，不能当成重复
            var m = Room.Find(id);
            if (m == null) return;
            bool wasHost = Room.HostId == id;
            _departed.Add(id);
            Room.Remove(id);
            if (wasHost)
            {
                _migratingSince = _clock();
                Note(LinkNoteKind.Migrating, m);
                return;
            }
            if (dropped) Note(LinkNoteKind.MemberGone, m);
            if (IsHost) Publish();
            else Note(LinkNoteKind.Changed);
        }

        public void OwnerChanged(string id)
        {
            _owner = id;
            CheckTakeOver();
        }

        /// <summary>房间数据里的快照。房主自己不看（它是写的人）；旧代次、同代次旧修订都不认（01 §6）。</summary>
        public void LobbyData(string snapshot)
        {
            if (Room == null || IsHost) return;
            var parsed = RoomWire.ParseSnapshot(snapshot);
            if (parsed == null) return;
            var (snap, rev) = parsed.Value;
            if (snap.Epoch < Room.Epoch || snap.Epoch == Room.Epoch && rev <= _rev) return;
            var before = Room.Members.Select(m => m.Id).ToList();
            var oldHost = Room.HostId;
            bool newEpoch = snap.Epoch > Room.Epoch;
            Room.Apply(snap, NewMember);
            _rev = rev;
            _migratingSince = null;
            foreach (var m in Room.Members)
                if (_departed.Remove(m.Id) && !before.Contains(m.Id)) Note(LinkNoteKind.Rejoined, m);
            if (newEpoch && Room.HostId != oldHost) Note(LinkNoteKind.NewHost, Room.Host);
            bool inRoom = Room.Find(SelfId) != null;
            if (!_joined && inRoom)
            {
                _joined = true;
                Note(LinkNoteKind.Joined);
            }
            else if (_joined && !inRoom)
            {
                Room = null;
                Out.Add(LinkCommand.Leave());
                Note(LinkNoteKind.SelfRemoved);
                return;
            }
            Note(LinkNoteKind.Changed);
        }

        /// <summary>
        /// 某成员的资料变了。可能比"进房"通知先到（Steam 不保证顺序），先存下，进房通知到了再加人；
        /// 已经离开的人迟到的资料只存不用，不让他"复活"（Q21）。
        /// </summary>
        public void MemberData(string id, string profile)
        {
            var p = RoomWire.ParseProfile(profile);
            if (Room == null || p == null) return;
            _profiles[id] = p;
            if (!_lobby.Contains(id)) return;
            var m = Room.Find(id);
            if (m != null)
            {
                p.ApplyTo(m);
                Note(LinkNoteKind.Changed);
            }
            else if (IsHost) TryAdd(id);
        }

        public void Message(string from, string text)
        {
            if (Room == null) return;
            var f = text.Split('|');
            switch (f[0])
            {
                case "Q":
                    OnRequest(from, f);
                    break;
                case "A":
                    OnReply(f);
                    break;
                case "C":
                    OnCatch(from, f);
                    break;
                case "T":
                    var actor = Room.Find(from);
                    if (actor != null && from != SelfId) Note(LinkNoteKind.FriendAct, actor);
                    break;
            }
        }

        /// <summary>定时调：迁移超过时限还没新房主就失败，离开房间（回单机、留重新加入，01 §4.4）。</summary>
        public void Tick()
        {
            if (Room == null || !Room.Migrating || _migratingSince == null || _clock() - _migratingSince.Value < MigrationTimeoutMs) return;
            Room.FailMigration();
            Room = null;
            Out.Add(LinkCommand.Leave());
            Note(LinkNoteKind.MigrationFailed);
        }

        // ---- 本人的操作 ----

        /// <summary>
        /// 本人选位。房主当场判定；成员发请求给房主，Place 为 null 表示等结果（回来时出一条 PlaceResult）。迁移中不确认（TXT-ROOM-027）。
        /// </summary>
        public (RoomResult Result, PlaceResult? Place) Place(ScenePoint target)
        {
            if (Room == null) return (RoomResult.NotFound, PlaceResult.NotInArea);
            if (Room.Migrating) return (RoomResult.Migrating, PlaceResult.NoRoom);
            if (IsHost)
            {
                var (r, place) = Room.Place(SelfId, target);
                if (place == PlaceResult.Placed) Publish();
                return (r, place);
            }
            int req = ++_reqSeq;
            _pendingPlace[req] = target;
            Request(req, $"place|{Num(target.X)}|{Num(target.Y)}");
            return (RoomResult.Ok, null);
        }

        public RoomResult SetMode(FishingMode mode)
        {
            if (Room == null) return RoomResult.NotFound;
            if (Room.Migrating) return RoomResult.Migrating;
            _self.Mode = mode;
            if (!IsHost)
            {
                Request(++_reqSeq, $"mode|{mode}");
                return RoomResult.Ok;
            }
            var r = Room.SetMode(SelfId, mode);
            Publish();
            return r;
        }

        /// <summary>切公共地图：只有房主（Q17）；成员在本地镜像上就被拒，什么都不发。</summary>
        public RoomResult SwitchMap(string mapId)
        {
            if (Room == null) return RoomResult.NotFound;
            var r = Room.SwitchMap(SelfId, mapId);
            if (r == RoomResult.Ok) Publish();
            return r;
        }

        /// <summary>本人存好了一条新鱼：告诉房里的人（只作展示，Q16、Q21）。</summary>
        public void Catch(string speciesId, int lengthMm)
        {
            if (Room == null || Room.Find(SelfId) == null) return;
            // Stryker disable once Update,String : 事件号只要不重复，序号往下数也一样；广播的 Key 用不上
            Out.Add(new LinkCommand(LinkOp.Broadcast, "", $"C|{SelfId}-{_nonce}-{++_eventSeq}|{Room.Epoch}|{speciesId}|{lengthMm}"));
        }

        /// <summary>本人在动（调用方自己限频，每秒最多一两次，01 §4.6 合并降噪）。</summary>
        public void Act()
        {
            if (Room?.Find(SelfId) != null) Out.Add(new LinkCommand(LinkOp.Broadcast, "", "T"));
        }

        /// <summary>本人的资料变了（换装、换主题、背景缸进出鱼）：重写成员数据。</summary>
        public void UpdateProfile(MemberProfile profile)
        {
            _self = profile;
            if (Room == null) return;
            var me = Room.Find(SelfId);
            if (me != null) profile.ApplyTo(me);
            Out.Add(LinkCommand.MemberData(RoomWire.Profile(profile)));
        }

        public void Leave()
        {
            if (Room == null) return;
            Room = null;
            Out.Add(LinkCommand.Leave());
        }

        // ---- 内部 ----

        /// <summary>服务说所有者是本人、而镜像里房主还不是本人：接任（原房主一定已经走了，服务只在所有者离开时换人）。</summary>
        private void CheckTakeOver()
        {
            if (Room == null || _owner != SelfId || Room.HostId == SelfId || Room.Find(SelfId) == null) return;
            var gone = Room.Host;
            if (gone != null)
            {
                _departed.Add(gone.Id);
                _lobby.Remove(gone.Id);
                Room.Remove(gone.Id);
                Note(LinkNoteKind.Migrating, gone);
            }
            var me = Room.CompleteMigration(SelfId)!; // 上面已核过本人在房间里，接任一定成功
            _migratingSince = null;
            Note(LinkNoteKind.NewHost, me);
            // 迁移前就进了服务、房主还没来得及加进房间的人，现在由本人加
            foreach (var id in _lobby.ToList()) TryAdd(id);
            Publish();
        }

        private void TryAdd(string id)
        {
            if (Room == null || Room.Find(id) != null || !_profiles.ContainsKey(id)) return;
            var m = NewMember(id);
            if (Room.Add(m) != RoomResult.Ok) return;
            if (_departed.Remove(id)) Note(LinkNoteKind.Rejoined, m);
            Publish();
        }

        private void OnRequest(string from, string[] f)
        {
            int? req = f.Length >= 6 ? Int(f[1]) : null;
            if (!IsHost || req == null || Room!.Find(from) == null) return;
            if (_lastReply.ContainsKey(from) && req <= _lastReply[from].Req)
            {
                // 重复的请求：不再执行，同一条原样再回一次；更旧的不理
                if (req == _lastReply[from].Req) Send(from, _lastReply[from].Reply);
                return;
            }
            var result = Execute(from, req.Value, f);
            if (result == null) return;
            _lastReply[from] = (req.Value, result);
            Send(from, result);
        }

        /// <summary>房主执行一条新请求，返回回复；格式不对返回 null（不理、不回）。旧代次、旧地图的回"已过期"、什么都不改。</summary>
        private string? Execute(string from, int req, string[] f)
        {
            if (Int(f[2]) != Room!.Epoch || f[3] != Room.MapId) return $"A|{req}|Stale|{PlaceResult.NotInArea}";
            if (f[4] == "place")
            {
                if (f.Length < 7) return null;
                double? x = Dbl(f[5]), y = Dbl(f[6]);
                if (x == null || y == null) return null;
                var (r, place) = Room.Place(from, new ScenePoint(x.Value, y.Value));
                if (place == PlaceResult.Placed) Publish();
                return $"A|{req}|{r}|{place}";
            }
            if (f[4] != "mode" || !Enum.IsDefined(typeof(FishingMode), f[5])) return null;
            var set = Room.SetMode(from, (FishingMode)Enum.Parse(typeof(FishingMode), f[5]));
            Publish();
            return $"A|{req}|{set}|{PlaceResult.NotInArea}";
        }

        /// <summary>成员收到房主对自己选位请求的回复。</summary>
        private void OnReply(string[] f)
        {
            int? req = f.Length >= 4 ? Int(f[1]) : null;
            if (req == null || !_pendingPlace.ContainsKey(req.Value) || !Enum.IsDefined(typeof(PlaceResult), f[3])) return;
            var point = _pendingPlace[req.Value];
            _pendingPlace.Remove(req.Value);
            Notes.Add(new LinkNote { Kind = LinkNoteKind.PlaceResult, Place = (PlaceResult)Enum.Parse(typeof(PlaceResult), f[3]), Point = point });
        }

        private void OnCatch(string from, string[] f)
        {
            if (f.Length < 5) return;
            int? epoch = Int(f[2]), mm = Int(f[4]);
            if (epoch == null || mm == null || !Room!.AcceptCatch(from, f[1], epoch.Value)) return;
            Notes.Add(new LinkNote { Kind = LinkNoteKind.FriendCatch, MemberId = from, Name = Room.Find(from)!.Name, SpeciesId = f[3], LengthMm = mm.Value });
        }

        private void Request(int req, string body)
        {
            Send(Room!.HostId!, $"Q|{req}|{Room.Epoch}|{Room.MapId}|{body}");
        }

        private void Send(string to, string text) => Out.Add(new LinkCommand(LinkOp.Send, to, text));

        private void Publish()
        {
            if (Room == null) return;
            Out.Add(new LinkCommand(LinkOp.SetLobbyData, "room", RoomWire.Snapshot(Room.Snapshot(), ++_rev)));
            Note(LinkNoteKind.Changed);
        }

        private RoomMember NewMember(string id)
        {
            var p = id == SelfId ? _self : _profiles.ContainsKey(id) ? _profiles[id] : new MemberProfile();
            var m = new RoomMember(id, p.Name, id == SelfId, false, p.Mode);
            p.ApplyTo(m);
            return m;
        }

        private void Note(LinkNoteKind kind, RoomMember? m = null) =>
            Notes.Add(new LinkNote { Kind = kind, MemberId = m?.Id, Name = m?.Name ?? "" });

        private static int? Int(string s) => RoomWire.Int(s);
        private static double? Dbl(string s) => RoomWire.Dbl(s);
        // Stryker disable once String : .NET Core 3.0 起默认格式就是最短可往返，"R" 和默认一样
        private static string Num(double v) => v.ToString("R", CultureInfo.InvariantCulture);
    }

    /// <summary>快照和资料的文字格式：竖线分段，自由文字和编号都转义，读不懂的整条不认。</summary>
    public static class RoomWire
    {
        public static string Snapshot(RoomSnapshot s, int rev) =>
            string.Join("|", "S1", s.Epoch.ToString(CultureInfo.InvariantCulture), rev.ToString(CultureInfo.InvariantCulture), Esc(s.HostId ?? ""), Esc(s.MapId),
                string.Join(";", s.Members.Select(m => string.Join(",", Esc(m.Id), m.JoinOrder.ToString(CultureInfo.InvariantCulture), m.Mode.ToString(),
                    m.Spot.HasValue ? Num(m.Spot.Value.X) : "", m.Spot.HasValue ? Num(m.Spot.Value.Y) : ""))));

        public static (RoomSnapshot Snap, int Rev)? ParseSnapshot(string text)
        {
            var f = text.Split('|');
            if (f.Length != 6 || f[0] != "S1") return null;
            int? epoch = Int(f[1]), rev = Int(f[2]);
            if (epoch == null || rev == null) return null;
            var members = new List<RoomSnapshot.Entry>();
            foreach (var part in f[5].Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var e = part.Split(',');
                if (e.Length != 5) return null;
                int? join = Int(e[1]);
                if (join == null || !Enum.IsDefined(typeof(FishingMode), e[2])) return null;
                ScenePoint? spot = null;
                if (e[3] != "" || e[4] != "")
                {
                    double? x = Dbl(e[3]), y = Dbl(e[4]);
                    if (x == null || y == null) return null;
                    spot = new ScenePoint(x.Value, y.Value);
                }
                members.Add(new RoomSnapshot.Entry(Unesc(e[0]), join.Value, (FishingMode)Enum.Parse(typeof(FishingMode), e[2]), spot));
            }
            var host = Unesc(f[3]);
            return (new RoomSnapshot(epoch.Value, host == "" ? null : host, Unesc(f[4]), members), rev.Value);
        }

        public static string Profile(MemberProfile p) =>
            string.Join("|", "P1", Esc(p.Name), p.Mode.ToString(), Esc(p.Character), Esc(p.Rod), Esc(p.Glove), Esc(p.SceneSkin), Esc(p.Tank.TankId ?? ""),
                p.Tank.Capacity.ToString(CultureInfo.InvariantCulture),
                string.Join(",", p.Tank.Fish.Select(x => Esc(x.SpeciesId) + ":" + x.LengthMm.ToString(CultureInfo.InvariantCulture))));

        public static MemberProfile? ParseProfile(string text)
        {
            var f = text.Split('|');
            if (f.Length != 10 || f[0] != "P1" || !Enum.IsDefined(typeof(FishingMode), f[2])) return null;
            int? cap = Int(f[8]);
            if (cap == null) return null;
            var fish = new List<(string, int)>();
            foreach (var part in f[9].Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var x = part.Split(':');
                int? mm = x.Length == 2 ? Int(x[1]) : null;
                if (mm == null) return null;
                fish.Add((Unesc(x[0]), mm.Value));
            }
            var tank = Unesc(f[7]);
            return new MemberProfile
            {
                Name = Unesc(f[1]),
                Mode = (FishingMode)Enum.Parse(typeof(FishingMode), f[2]),
                Character = Unesc(f[3]),
                Rod = Unesc(f[4]),
                Glove = Unesc(f[5]),
                SceneSkin = Unesc(f[6]),
                Tank = tank == "" ? TankSnapshot.NotSet : new TankSnapshot(tank, fish, cap.Value),
            };
        }

        private static string Esc(string s) => Uri.EscapeDataString(s);
        private static string Unesc(string s) => Uri.UnescapeDataString(s);
        // Stryker disable once String : .NET Core 3.0 起默认格式就是最短可往返，"R" 和默认一样
        private static string Num(double v) => v.ToString("R", CultureInfo.InvariantCulture);
        internal static int? Int(string s) => int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : (int?)null;
        internal static double? Dbl(string s) => double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : (double?)null;
    }
}
