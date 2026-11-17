using Moyu.Core.Play;
using Moyu.Core.Scene;

namespace Moyu.Web.Services;

/// <summary>
/// 玩家看得到的整句文字，按《文案交接 v0.1/03 B0-B1界面文案定稿》原样接入（B0 Q5、B1 Q13 答复），注释里是定稿 ID。
/// 短的按钮名、页签名直接写在组件里，同样照定稿。内核只认内部 ID，换文案只改这里和组件。
/// </summary>
public static class Texts
{
    // ---- 6 种鱼、16 件外观（定稿 §8、§9） ----

    public static string FishName(string speciesId) => speciesId switch
    {
        "TMP_F001" => "银白小鱼",
        "TMP_F002" => "青圆点鱼",
        "TMP_F003" => "金扇尾鱼",
        "TMP_F101" => "荷叶尾鱼",
        "TMP_F201" => "蓝纹长鱼",
        "TMP_F301" => "云纹大鱼",
        _ => speciesId,
    };

    public static string FishDescription(string speciesId) => speciesId switch
    {
        "TMP_F001" => "银白的细身小鱼，摆着短短的圆尾。",
        "TMP_F002" => "青绿的圆身上，留着一枚醒目的大圆点。",
        "TMP_F003" => "淡金的修长鱼身，拖着宽宽的扇形尾巴。",
        "TMP_F101" => "尾巴像一片小叶子，鳍尖透着柔粉色。",
        "TMP_F201" => "青蓝色的断纹，沿着修长的鱼身排开。",
        "TMP_F301" => "厚厚的鱼身和大尾巴上，浮着奶黄色的云纹。",
        _ => "",
    };

    public static string SkinName(string skinId) => skinId switch
    {
        "BASE_CHAR" or "BASE_ROD" or "BASE_GLOVE" or "BASE_SCENE" => "默认",
        "WEB_CHAR_01" => "草帽背带",
        "WEB_CHAR_02" => "黄雨衣",
        "WEB_CHAR_03" => "条纹领巾",
        "WEB_ROD_01" => "薄荷竿",
        "WEB_ROD_02" => "竹节竿",
        "WEB_ROD_03" => "金环竿",
        "WEB_GLOVE_01" => "黄胶手套",
        "WEB_GLOVE_02" => "叶纹手套",
        "WEB_GLOVE_03" => "深蓝手套",
        "WEB_SCENE_01" => "暖灯",
        "WEB_SCENE_02" => "细雨",
        "WEB_SCENE_03" => "月光",
        _ => skinId,
    };

    public static string SkinDescription(string skinId) => skinId switch
    {
        "BASE_CHAR" => "保留伙伴原本的模样，轻轻松松坐在水边。",
        "BASE_ROD" => "熟悉的鱼竿，搭配基础配色和握柄。",
        "BASE_GLOVE" => "简洁的基础手套，陪伙伴一起探探水。",
        "BASE_SCENE" => "保留当前地图原本的光线与装饰。",
        "WEB_CHAR_01" => "戴上草帽，穿好薄荷色背带裤。",
        "WEB_CHAR_02" => "柔黄的连帽雨衣，让水边多一点亮色。",
        "WEB_CHAR_03" => "白蓝条纹上衣，配一条蓝色小领巾。",
        "WEB_ROD_01" => "薄荷色竿身，搭配奶油色握柄。",
        "WEB_ROD_02" => "竹节纹样的竿身，缠着一小段红线。",
        "WEB_ROD_03" => "深蓝竿身点缀金环，竿尖添上一抹亮色。",
        "WEB_GLOVE_01" => "柔黄的手套，收在奶白色袖口里。",
        "WEB_GLOVE_02" => "自然绿色的手套，印着几片简洁的叶纹。",
        "WEB_GLOVE_03" => "深蓝手套配橙色边线，掌面添上防滑纹样。",
        "WEB_SCENE_01" => "水边亮起几盏小灯，添一点暖光。",
        "WEB_SCENE_02" => "细细的雨线落下，水面泛起小小涟漪。",
        "WEB_SCENE_03" => "青色月光和几点微亮装饰，轻轻落在场景里。",
        _ => "",
    };

    /// <summary>TXT-SKIN-001</summary>
    public static string Category(SkinCategory c) => c switch
    {
        SkinCategory.Character => "人物",
        SkinCategory.Rod => "鱼竿",
        SkinCategory.Glove => "手套",
        _ => "场景",
    };

    // ---- 模式与窗口（定稿 §2） ----

    /// <summary>TXT-B0-001</summary>
    public static string ModeName(FishingMode m) => m switch
    {
        FishingMode.Lure => "路亚",
        FishingMode.Wade => "摸鱼",
        _ => "手竿",
    };

    /// <summary>TXT-B0-002/003/004</summary>
    public static string ModeHelp(FishingMode m) => m switch
    {
        FishingMode.Lure => "工作时输入键盘或点击鼠标，角色就会提竿。第500次有50%机会出鱼；本轮累计到1000次必得一条。成功后本轮重新计数。",
        FishingMode.Wade => "工作时输入键盘或点击鼠标，角色就会探水。每累计200次有20%机会出鱼；本轮累计到2000次必得一条。成功后本轮重新计数。",
        _ => "选择手竿后，累计30分钟有效时间就能获得一条鱼。切换地图或玩法会暂停，回来接着等。",
    };

    public const string CollapseHelp = "收起为头像，点击恢复，按住拖动。收起期间当前玩法继续运行。"; // TXT-B0-011
    public const string CloseHelp = "关闭小窗会暂停输入计数和手竿计时。重新打开后继续已保存的进度。"; // TXT-B0-012
    public const string PlaceHelp = "单击岸边或浅水中的可用位置选位；按住角色或水面拖动小窗。选位、拖窗和菜单操作不计捕鱼输入。"; // TXT-B0-013

    // ---- 设置与说明（定稿 §3） ----

    public const string PassthroughHelp = "开启后，透明留白处的点击会交给下层界面；关闭后，留白仍保持透明。"; // TXT-SET-003
    public const string DemoSwitchNote = "网页演示开关，不会改变系统置顶，也不会接收其他网页或软件的输入。"; // TXT-SET-004
    public const string InputScopeHelp = "仅统计本页面内游戏界面以外的真实键盘按下和鼠标点击。其他网页、地址栏及其他软件中的输入不会计入。"; // TXT-SET-005
    public const string ClosedState = "小窗已关闭，输入计数和手竿计时已暂停。"; // TXT-SET-007
    public const string MuteHelp = "静音只影响声音，不影响动作、计数和鱼获。"; // TXT-SET-008
    public const string TrialNote = "试玩版本，部分美术为临时素材。好友联机与更多鱼缸尚未开放。"; // TXT-SET-009
    public const string FakeDesktopNote = "这是网页内的模拟桌面，不会控制真实系统桌面。"; // TXT-SET-010
    public const string RoomClosed = "好友联机尚未开放。"; // TXT-SET-011
    public const string RoomInviteClosed = "尚未开放"; // TXT-SET-012
    public const string ArtPlaceholder = "当前美术为临时素材，正式素材将逐步替换。"; // TXT-SET-013

    // ---- 计数、计时与保存（定稿 §4） ----

    public static string TotalTitle(long n) => $"总累计 {n} 次"; // TXT-STAT-002
    public static string CycleTitle(long count, int next) => $"本轮 {count} 次，下一次判定在第 {next} 次。"; // TXT-STAT-003
    public static string CoinsTitle(long n) => $"金币 {n}"; // TXT-STAT-005
    public static string PoleShort(long elapsedMs) => $"{Clock(elapsedMs)}/30:00"; // TXT-STAT-007
    public static string PoleRunning(long elapsedMs) => $"手竿计时中，还需 {Clock(CaptureRules.PoleIntervalMs - elapsedMs, up: true)}。"; // TXT-STAT-008
    public static string PolePaused(long elapsedMs) => $"手竿已暂停，已累计 {Clock(elapsedMs)}。"; // TXT-STAT-009
    public const string PoleRules = "网页开着时计时，切到其他标签页或最小化仍可累计。收起头像继续计时，关闭小窗或网页停止计时，不补离线时间。"; // TXT-STAT-010
    public const string PoleGapRule = "两次计时检查间隔超过5分钟时，该段时间不计入手竿进度。"; // TXT-STAT-011
    public const string PoleGapHappened = "刚才的计时检查间隔超过5分钟，这一段未计入。"; // TXT-STAT-012

    public const string SaveRetry = "保存失败，尚未确认的进度不会显示为已获得。请重试。"; // TXT-SAVE-002
    public const string SaveFailed = "保存失败，什么都没变，可以再试一次。"; // TXT-SAVE-003
    public const string LoadFailed = "读档失败，现有存档未被覆盖。请重试。"; // TXT-SAVE-004
    public const string ReadOnlyPage = "当前页面只读。请在正在运行游戏的页面继续操作。"; // TXT-SAVE-005
    public const string UnknownVersion = "当前存档版本无法读取，现有数据未被覆盖。"; // TXT-SAVE-006
    public const string NotReady = "存档尚未准备好，请稍后重试。"; // TXT-SAVE-007

    // ---- 鱼获、鱼篓与出售（定稿 §5） ----

    public static string NewFishTitle(int n) => $"新鱼 {n} 条"; // TXT-CATCH-005
    public static string Picked(int n) => $"已选 {n} 条"; // TXT-BASKET-006
    public static string SaleTitle(int n) => $"确认出售 {n} 条？"; // TXT-SALE-001
    public static string SaleLine(string speciesId, int mm, int price) => $"{FishName(speciesId)} · {Cm(mm)} · {price} 金币"; // TXT-SALE-002
    public const string SaleFinal = "确认后鱼将被出售，本轮不支持撤销。"; // TXT-SALE-003
    public static string SaleReceipt(int n, int delta, int balance) => $"卖出 {n} 条，+{delta}，余额 {balance}。"; // TXT-SALE-005
    public const string SaleStale = "鱼或报价有变化，请重新选择后再卖。"; // TXT-SALE-006
    public const string SaleNothing = "请先选择要出售的鱼。"; // TXT-SALE-008
    public static string DrawLedgerDetail(int cost, int refund) => $"扣除 {cost}，重复返还 {refund}。"; // TXT-LEDGER-004

    // ---- 收藏与记录（定稿 §6） ----

    public const string TankEmpty = "鱼缸是空的，从鱼篓放鱼进来。"; // TXT-TANK-003
    public const string TankHelp = "点缸里的鱼可以取回。"; // TXT-TANK-004
    public const string TankFull = "鱼缸满了（20/20），鱼还在鱼篓里。"; // TXT-TANK-006
    public const string TankBackgroundHelp = "鱼缸显示在钓鱼场景后方，鱼在缸里游动，不影响当前地图和选位。"; // TXT-TANK-007
    public const string MoreTanksClosed = "更多鱼缸尚未开放。"; // TXT-TANK-008
    public static string Found(int n) => $"已发现 {n}/6"; // TXT-RECORD-001
    public const string Unknown = "？"; // TXT-RECORD-002
    public static string Longest(int mm) => $"最长 {Cm(mm)}"; // TXT-RECORD-003
    public static string Caught(long n, long firstMs) => $"抓到 {n} 次 · 首次 {FullTime(firstMs)}"; // TXT-RECORD-004
    public const string RecordHelp = "卖鱼和收藏都不会清除捕获记录。"; // TXT-RECORD-005

    // ---- 皮肤（定稿 §7） ----

    public const string SkinLocked = "还没拥有，获得后可以装备。"; // TXT-SKIN-004
    public const string DrawPrice = "每抽100金币，重复返20金币。"; // TXT-SKIN-005
    public const string DrawOdds = "12款外观各有1/12机会，允许重复。分类页签只筛选浏览，不改变抽取池。"; // TXT-SKIN-006
    public static string Streak(int n) => $"连续重复 {n}/4"; // TXT-SKIN-007
    public const string NextIsNew = "下一抽必出新款。"; // TXT-SKIN-008
    public static string GuaranteedOdds(int unowned) => $"本次只从尚未拥有的外观中等概率抽取，每款机会为1/{unowned}。"; // TXT-SKIN-009
    public static string DrawNew(string skinId) => $"获得新外观：{SkinName(skinId)}。"; // TXT-SKIN-012
    public static string DrawDuplicate(string skinId) => $"重复外观：{SkinName(skinId)}，返还20金币。"; // TXT-SKIN-013
    public static string NotEnough(long lack) => $"金币不够，还差 {lack}。"; // TXT-SKIN-014
    public const string AllOwned = "已拥有全部可抽外观，不再扣除金币。"; // TXT-SKIN-015
    public const string CosmeticOnly = "外观只改变样子，不影响出鱼、售价或鱼缸容量。"; // TXT-SKIN-016
    public const string EquipHelp = "新外观不会自动装备，可以在这里主动更换。"; // TXT-SKIN-017

    // ---- 格式（定稿 §1） ----

    /// <summary>体长：整数毫米显示成一位小数的厘米，不经过浮点。</summary>
    public static string Cm(int mm) => $"{mm / 10}.{mm % 10} cm";

    /// <summary>列表里的短时间。</summary>
    public static string Time(long ms) =>
        DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().ToString("M/d HH:mm");

    /// <summary>完整详情里的时间：YYYY-MM-DD HH:mm。</summary>
    public static string FullTime(long ms) =>
        DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().ToString("yyyy-MM-dd HH:mm");

    /// <summary>mm:ss。已过时间向下取整到秒；剩余时间向上取整（还差半秒也写 00:01，不提前写 00:00）。</summary>
    public static string Clock(long ms, bool up = false)
    {
        long s = up ? (ms + 999) / 1000 : ms / 1000;
        return $"{s / 60:00}:{s % 60:00}";
    }
}
