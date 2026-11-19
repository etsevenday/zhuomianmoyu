using System;
using System.Collections.Generic;
using System.Linq;

namespace Moyu.Core.Rooms
{
    /// <summary>成员进出的种类（Steam 的 LobbyChatUpdate）：进来、正常离开、掉线（含被踢）。</summary>
    public enum LobbyChange
    {
        Entered,
        Left,
        Dropped,
    }

    /// <summary>
    /// 交给页面的一件事，和 B9 回环服务推的事件同一种（tools/verify/relay.mjs）：页面只认这一层，不管背后是 Steam 还是回环。
    /// Type：entered、enterFailed、memberJoined、memberLeft、ownerChanged、lobbyData、memberData、friends。
    /// </summary>
    public sealed class LobbyEvent
    {
        // Stryker disable once String : 只防 null 的默认值，每个事件建的时候都给了 Type
        public string Type { get; set; } = "";
        public string? Lobby { get; set; }
        public string? Owner { get; set; }
        public IReadOnlyList<string>? Members { get; set; }
        public string? Ver { get; set; }
        public string? Room { get; set; }
        public IReadOnlyDictionary<string, string>? MemberData { get; set; }
        public string? Reason { get; set; }
        public string? Id { get; set; }
        public bool Dropped { get; set; }
        public string? Key { get; set; }
        public string? Text { get; set; }
        public IReadOnlyList<FriendEntry>? Friends { get; set; }

        public override string ToString() => $"{Type} {Lobby}{Id}{Owner}{Reason} {Text}";
    }

    /// <summary>好友列表的一行（Q27）：Playing 为正在玩本游戏。</summary>
    public sealed class FriendEntry
    {
        public string Id { get; }
        public string Name { get; }
        public bool Playing { get; }

        public FriendEntry(string id, string name, bool playing)
        {
            Id = id;
            Name = name;
            Playing = playing;
        }
    }

    /// <summary>Steam 报来的一位好友。PlayingApp：在玩同一个 App；Marker：带着本游戏的标记（480 是公用 ID，光看 App 认不出是不是本游戏）。</summary>
    public sealed class SteamFriend
    {
        public string Id { get; }
        public string Name { get; }
        public bool Online { get; }
        public bool PlayingApp { get; }
        public bool Marker { get; }

        public SteamFriend(string id, string name, bool online, bool playingApp, bool marker)
        {
            Id = id;
            Name = name;
            Online = online;
            PlayingApp = playingApp;
            Marker = marker;
        }
    }

    /// <summary>
    /// 把 Steam 房间的状态整理成事件（B10）。Steam 的回调只说"有东西变了"，读到的是当时的整份状态：
    /// 这里记着上一次的，只把真正的变化报出去（进出、所有者、房间数据 room、各人资料），本人自己的不报，离开后旧房间迟到的不认。
    /// 不碰 Steam，Steam 小程序（pc/steam）调 Steam、把读到的交给这里。
    /// </summary>
    public sealed class LobbyTracker
    {
        private readonly string _self;
        private readonly HashSet<string> _members = new HashSet<string>();
        private readonly Dictionary<string, string> _profiles = new Dictionary<string, string>();
        private string? _owner;
        private string? _room;
        private List<(string Id, string Name, bool Playing)>? _friends;

        public LobbyTracker(string selfId)
        {
            _self = selfId;
        }

        /// <summary>现在所在的房间；不在房间里为 null。</summary>
        public string? Lobby { get; private set; }
        public List<LobbyEvent> Out { get; } = new List<LobbyEvent>();

        /// <summary>进房成功。ver、room 没写过是空字符串（Steam 的读法），报成 null。</summary>
        public void Entered(string lobby, string owner, IEnumerable<string> members, string ver, string room, IDictionary<string, string> memberData)
        {
            Lobby = lobby;
            _owner = owner;
            _room = room;
            _members.Clear();
            _profiles.Clear();
            foreach (var m in members) _members.Add(m);
            _members.Add(_self);
            foreach (var kv in memberData)
                if (kv.Key != _self && _members.Contains(kv.Key) && kv.Value != "") _profiles[kv.Key] = kv.Value;
            Out.Add(new LobbyEvent
            {
                Type = "entered",
                Lobby = lobby,
                Owner = owner,
                Members = _members.ToList(),
                Ver = ver == "" ? null : ver,
                Room = room == "" ? null : room,
                MemberData = new Dictionary<string, string>(_profiles),
            });
        }

        /// <summary>进房或建房失败：full 满员、gone 房间不在了、create 建房失败、failed 其他。</summary>
        public void EnterFailed(string reason) => Out.Add(new LobbyEvent { Type = "enterFailed", Reason = reason });

        public void MemberChanged(string lobby, string id, LobbyChange change)
        {
            if (lobby != Lobby || id == _self) return;
            if (change == LobbyChange.Entered)
            {
                if (_members.Add(id)) Out.Add(new LobbyEvent { Type = "memberJoined", Id = id });
                return;
            }
            if (!_members.Remove(id)) return;
            _profiles.Remove(id);
            Out.Add(new LobbyEvent { Type = "memberLeft", Id = id, Dropped = change == LobbyChange.Dropped });
        }

        /// <summary>Steam 说房间有更新：拿当时的所有者、房间数据 room、在房成员的资料来比。</summary>
        public void Refresh(string lobby, string owner, string room, IDictionary<string, string> memberData)
        {
            if (lobby != Lobby) return;
            if (owner != _owner)
            {
                _owner = owner;
                Out.Add(new LobbyEvent { Type = "ownerChanged", Owner = owner });
            }
            if (room != "" && room != _room)
            {
                _room = room;
                Out.Add(new LobbyEvent { Type = "lobbyData", Key = "room", Text = room });
            }
            foreach (var kv in memberData)
            {
                if (kv.Key == _self || !_members.Contains(kv.Key) || kv.Value == "") continue;
                if (_profiles.TryGetValue(kv.Key, out var had) && had == kv.Value) continue;
                _profiles[kv.Key] = kv.Value;
                Out.Add(new LobbyEvent { Type = "memberData", Id = kv.Key, Text = kv.Value });
            }
        }

        /// <summary>本人离开：之后旧房间迟到的回调都不认。成员、资料留到下次进房时清。</summary>
        public void Left()
        {
            Lobby = null;
            _owner = null;
            _room = null;
        }

        /// <summary>好友列表：离线的不列；在玩同一 App 且带本游戏标记才算正在玩；按名字排。和上次一样不报。</summary>
        public void Friends(IEnumerable<SteamFriend> all)
        {
            var list = all.Where(f => f.Online)
                .Select(f => new FriendEntry(f.Id, f.Name, f.PlayingApp && f.Marker))
                .OrderBy(f => f.Name, StringComparer.Ordinal).ThenBy(f => f.Id, StringComparer.Ordinal)
                .ToList();
            var key = list.Select(f => (f.Id, f.Name, f.Playing)).ToList();
            if (_friends != null && key.SequenceEqual(_friends)) return;
            _friends = key;
            Out.Add(new LobbyEvent { Type = "friends", Friends = list });
        }
    }
}
