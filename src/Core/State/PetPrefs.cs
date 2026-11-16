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
        public double WindowX { get; set; } = -1;
        public double WindowY { get; set; } = -1;
        public bool Collapsed { get; set; }
        public bool Closed { get; set; }
        public bool Passthrough { get; set; } = true;
        public bool Mute { get; set; } = true;
        public string Mode { get; set; } = "Lure";
        public string MapId { get; set; } = "";
        public bool HasSpot { get; set; }
        public double SpotX { get; set; }
        public double SpotY { get; set; }
    }
}
