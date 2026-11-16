namespace Moyu.Core.Scene
{
    /// <summary>三种玩法，同一时刻每位玩家只有一种是当前模式（DEC-06）。</summary>
    public enum FishingMode
    {
        /// <summary>路亚：岸边拉竿。</summary>
        Lure,
        /// <summary>摸鱼：下浅水探水。</summary>
        Wade,
        /// <summary>手竿：岸边竿架等待。</summary>
        Pole,
    }

    /// <summary>地图活动区域的种类（09 §3）。</summary>
    public enum AreaKind
    {
        Shore,
        Shallow,
    }

    public static class FishingModeExtensions
    {
        /// <summary>路亚和手竿在岸边，摸鱼在浅水（09 §2）。</summary>
        public static AreaKind Area(this FishingMode mode) => mode == FishingMode.Wade ? AreaKind.Shallow : AreaKind.Shore;
    }
}
