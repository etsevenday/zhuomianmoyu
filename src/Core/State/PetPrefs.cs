namespace Moyu.Core.State
{
    /// <summary>
    /// 要保存的小窗设置与位置（05 §6）。只有平铺字段，网页用 System.Text.Json、Unity 用 Newtonsoft 都能直接序列化。
    /// 第一阶段没有鱼获资产，这里不含任何玩法存档。
    /// </summary>
    public sealed class PetPrefs
    {
        public const int CurrentVersion = 1;

        public int Version { get; set; } = CurrentVersion;
        /// <summary>小窗左上角在桌面上的相对位置（0—1，按桌面宽高归一），换分辨率后仍能找回。</summary>
        // Stryker disable once Unary : 两个坐标任一为负就整体回落默认位置，单改一个默认值结果一样
        public double WindowX { get; set; } = -1;
        // Stryker disable once Unary : 同上
        public double WindowY { get; set; } = -1;
        public bool Collapsed { get; set; }
        public bool Closed { get; set; }
        public bool Passthrough { get; set; } = true;
        public bool Mute { get; set; } = true;
        public bool Topmost { get; set; } = true;
        public bool BackgroundInput { get; set; }
        // Stryker disable once String : 缺字段或不认识的值都回落路亚，默认串改成别的结果一样
        public string Mode { get; set; } = "Lure";
        // Stryker disable once String : 空串和不认识的地图都回落默认地图，结果一样
        public string MapId { get; set; } = "";
        public bool HasSpot { get; set; }
        public double SpotX { get; set; }
        public double SpotY { get; set; }
    }
}
