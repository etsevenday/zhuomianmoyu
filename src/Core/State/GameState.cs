using Moyu.Core.Desktop;
using Moyu.Core.Scene;

namespace Moyu.Core.State
{
    /// <summary>小窗里同一时刻只开一个管理面板，打开另一个时替换（01 §2）。</summary>
    public enum Panel
    {
        None,
        /// <summary>左下模式入口弹出的三模式选择。</summary>
        ModeMenu,
        /// <summary>更多：地图、皮肤、设置。</summary>
        More,
        Basket,
        Collection,
        Records,
        Map,
        Skin,
        Settings,
        Room,
    }

    /// <summary>显示设置，与玩法存档分开保存（01 §6）。</summary>
    public sealed class DisplaySettings
    {
        /// <summary>透明区穿透：默认开，可关（DEC-09）。只改指针命中，不改画面透明。</summary>
        public bool Passthrough { get; set; } = true;
        /// <summary>静音：默认开（01 §6 默认建议静音）。</summary>
        public bool Mute { get; set; } = true;
        /// <summary>置顶：网页版只是演示开关，不改系统窗口层级（B0 Q2 答复 C）。初值是开发方默认。</summary>
        public bool Topmost { get; set; } = true;
        /// <summary>后台输入：网页版只是演示开关，不接收页面外输入、也不改计数资格（B0 Q2 答复 C）。默认关（窗口验收 05：不能默认允许采集全局输入）。</summary>
        public bool BackgroundInput { get; set; }
    }

    public sealed class GameState
    {
        public FishingMode Mode { get; set; } = FishingMode.Lure;
        public string MapId { get; set; } = MapCatalog.Pond;
        /// <summary>本人在当前地图、当前模式区域里的已确认落点；安排失败时为 null。</summary>
        public ScenePoint? Spot { get; set; }
        public WindowPosition Window { get; set; }
        /// <summary>收起成头像（B0 Q1 待定，先按建议 A）。</summary>
        public bool Collapsed { get; set; }
        /// <summary>点了关闭：网页版里小窗消失，双击桌面图标再打开。</summary>
        public bool Closed { get; set; }
        public Panel Panel { get; set; } = Panel.None;
        public DisplaySettings Settings { get; set; } = new DisplaySettings();
    }
}
