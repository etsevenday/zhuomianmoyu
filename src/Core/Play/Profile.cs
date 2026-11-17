using System.Collections.Generic;

namespace Moyu.Core.Play
{
    public enum FishPlace
    {
        Basket,
        Tank,
        Sold,
    }

    /// <summary>鱼是怎么来的。开发入口注入的鱼与正常节点捕获分开记（05 §3）。</summary>
    public enum CatchSource
    {
        Normal,
        Dev,
    }

    public enum LedgerKind
    {
        Sale,
        Draw,
        /// <summary>开发入口加的金币，只在 ?dev=1 下出现。</summary>
        Dev,
    }

    /// <summary>一组"模式×地图"的本轮进度（WEB-DEC-07）。</summary>
    public sealed class ProgressGroup
    {
        /// <summary>本轮已累计的有效输入；成功出鱼后归零。</summary>
        public long Count { get; set; }
        /// <summary>这一组已经完成的周期数；它是本轮随机结果的键的一部分，成功后加 1。</summary>
        public long Cycle { get; set; }
        /// <summary>手竿组本轮已累计的有效毫秒（0—1799999）；主动模式的组一直是 0。</summary>
        public long ElapsedMs { get; set; }
    }

    // 存档类里字符串属性的默认 "" 只防 null：引擎造鱼、建档时每个都会赋值，读档时 Validate 查认得的字段，
    // 默认值换成别的字也没有任何路径能看出来。Stryker 的区段注释只管到所在的类为止，所以每个类前各写一次
    // Stryker disable String : 只防 null 的默认值，见上
    /// <summary>一条鱼个体（03 §1）。同一条鱼任一时刻只在鱼篓、一个鱼缸或已出售之一。</summary>
    public sealed class FishRecord
    {
        public string Id { get; set; } = "";
        public string SpeciesId { get; set; } = "";
        public int LengthMm { get; set; }
        public string Mode { get; set; } = "";
        public string MapId { get; set; } = "";
        public long CaughtAtMs { get; set; }
        /// <summary>捕获事件号：模式、地图、周期唯一确定；同一事件不会生成第二条鱼。</summary>
        public string CatchEventId { get; set; } = "";
        public string ContentVersion { get; set; } = "";
        public CatchSource Source { get; set; }
        /// <summary>是主动模式周期末保底节点出的（新鱼获卡片上加个标记，02 §2.1）；手竿出的不算。</summary>
        public bool Guaranteed { get; set; }
        public FishPlace Place { get; set; }
        /// <summary>在鱼缸里时是哪个缸。</summary>
        public string? TankId { get; set; }
    }

    // Stryker disable String : 只防 null 的默认值，见 FishRecord 上方
    public sealed class Tank
    {
        public string Id { get; set; } = "";
        public int Capacity { get; set; }
    }

    // Stryker disable String : 只防 null 的默认值，见 FishRecord 上方
    public sealed class SaleLine
    {
        public string FishId { get; set; } = "";
        public string SpeciesId { get; set; } = "";
        public int LengthMm { get; set; }
        public int Price { get; set; }
    }

    // Stryker disable String : 只防 null 的默认值，见 FishRecord 上方
    /// <summary>账本一行，也是出售和抽取的回执（02 §3）。同一个操作号只会有一行。</summary>
    public sealed class LedgerEntry
    {
        public string Id { get; set; } = "";
        public string OpId { get; set; } = "";
        public LedgerKind Kind { get; set; }
        public long AtMs { get; set; }
        /// <summary>这一笔金币增减（抽到重复时已含返还）。</summary>
        public int Delta { get; set; }
        public int BalanceAfter { get; set; }
        public List<SaleLine> Lines { get; set; } = new List<SaleLine>();
        public string? SkinId { get; set; }
        public bool Duplicate { get; set; }
        /// <summary>这一抽是连续重复后的必新抽。</summary>
        public bool Guaranteed { get; set; }
    }

    // Stryker disable String : 只防 null 的默认值，见 FishRecord 上方
    /// <summary>一种鱼的纪录（记录页）；卖掉鱼不影响它。</summary>
    public sealed class SpeciesRecord
    {
        public long Count { get; set; }
        public long FirstAtMs { get; set; }
        public int MaxLengthMm { get; set; }
        public string MaxFishId { get; set; } = "";
    }

    // Stryker disable String : 只防 null 的默认值，见 FishRecord 上方
    /// <summary>
    /// 玩法存档（03 §5）：计数、周期、鱼、金币、外观、账本。和窗口偏好（PetPrefs）分开保存。
    /// 只有可序列化的属性，网页用 System.Text.Json、Unity 用 Newtonsoft 都能直接存取。
    /// </summary>
    public sealed class Profile
    {
        /// <summary>2：加了手竿有效时间和新鱼表（B2）。1 是 B1 的档，读进来时升级。</summary>
        public const int CurrentSchema = 2;

        public int Schema { get; set; } = CurrentSchema;
        public string RulesVersion { get; set; } = "";
        public string ContentVersion { get; set; } = "";
        public string ProfileId { get; set; } = "";
        /// <summary>档案随机上下文：所有节点、鱼种、体长、抽取都由它和事件键算出（Dice）。</summary>
        public ulong Seed { get; set; }
        /// <summary>每成功保存一次加 1，用来发现别的标签页写过。</summary>
        public long Revision { get; set; }

        public long LifetimeInputs { get; set; }
        /// <summary>各模式累计输入（键：lure / wade / pole），切换和出鱼都不归零。</summary>
        public Dictionary<string, long> ModeInputs { get; set; } = new Dictionary<string, long>();
        /// <summary>各"模式|地图"的本轮进度。</summary>
        public Dictionary<string, ProgressGroup> Groups { get; set; } = new Dictionary<string, ProgressGroup>();

        public long NextFishSeq { get; set; } = 1;
        public List<FishRecord> Fish { get; set; } = new List<FishRecord>();
        /// <summary>
        /// 新鱼：正常捕获、还没在鱼篓里显示过的鱼编号（02 §2.1）。开发注入的不进；离开鱼篓就去掉。
        /// 底栏鱼篓上的数字就是它，随档保存，刷新不重复加。
        /// </summary>
        public List<string> NewFishIds { get; set; } = new List<string>();
        public Dictionary<string, SpeciesRecord> Records { get; set; } = new Dictionary<string, SpeciesRecord>();

        public int Coins { get; set; }
        public List<Tank> Tanks { get; set; } = new List<Tank>();
        /// <summary>设为观赏背景的鱼缸；null 表示不显示（03 §3：新档默认不设）。</summary>
        public string? BackgroundTankId { get; set; }

        public List<string> OwnedSkins { get; set; } = new List<string>();
        /// <summary>每类当前装备（键：SkinCategory 名）。</summary>
        public Dictionary<string, string> Equipped { get; set; } = new Dictionary<string, string>();
        public long DrawSeq { get; set; }
        /// <summary>连续抽到重复的次数；抽到新款归零。</summary>
        public int DuplicateStreak { get; set; }

        public long NextLedgerSeq { get; set; } = 1;
        public List<LedgerEntry> Ledger { get; set; } = new List<LedgerEntry>();
    }
}
