namespace Moyu.Core.Play
{
    /// <summary>
    /// 手竿计时的检查锚点（05 §1.1）。只在内存里，不进存档：读档、刷新、重新拿到写权时都从"现在"重新起算，
    /// 不按墙钟补算关掉网页或睡眠的那段。
    /// 每次检查先把上次检查到现在的时间结给上次在计的那一组，再按调用方给的资格换组——
    /// 所以切地图、切玩法时临界出的鱼属于切换前的地图（WC-07）。
    /// </summary>
    public sealed class PoleClock
    {
        private long _anchorMs;

        /// <summary>正在计时的地图；没在计（不是手竿、小窗关了、只读、没读好档）时为 null。</summary>
        public string? MapId { get; private set; }

        /// <summary>丢掉锚点、不结时间（换了一份档案时用：旧档的这段时间不能记到新档上）。</summary>
        public void Reset() => MapId = null;

        /// <summary>
        /// 做一次检查。mapId 是此刻有计时资格的手竿地图，没有资格传 null。
        /// 返回结给上一组的结果；之前没在计时返回 null。
        /// </summary>
        public PoleResult? Check(PlayEngine engine, string? mapId, long nowMs)
        {
            PoleResult? result = null;
            if (MapId != null) result = engine.AddPoleTime(MapId, nowMs - _anchorMs, nowMs);
            MapId = mapId;
            _anchorMs = nowMs;
            return result;
        }
    }
}
