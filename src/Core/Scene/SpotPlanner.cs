using System;
using System.Collections.Generic;

namespace Moyu.Core.Scene
{
    public enum PlaceResult
    {
        /// <summary>放得下，落点就是点击处。</summary>
        Placed,
        /// <summary>点在当前模式的区域外（天空、装饰外沿、别的模式的区域），不算一次选位。</summary>
        NotInArea,
        /// <summary>在区域内但放不下：保留原位并反馈（DEC-14）。</summary>
        NoRoom,
    }

    /// <summary>
    /// 选位与自动安排（09 §4）。落点是角色脚下的点；"放得下"只看角色必要实体空间（占地框），
    /// 竿线、水花等表现可以交叠，不算占用。放不下时不改投到别的空位。
    /// </summary>
    public sealed class SpotPlanner
    {
        /// <summary>角色占地框宽（画布单位）：只取身体宽度，允许并排紧挨（DEC-14）。</summary>
        public const double FootprintWidth = 180;
        /// <summary>角色占地框前后深度。</summary>
        public const double FootprintDepth = 40;
        /// <summary>自动安排时从锚点向两侧试探的步长。</summary>
        public const double ArrangeStep = 20;

        public static SceneRect Footprint(ScenePoint feet) =>
            new SceneRect(feet.X - FootprintWidth / 2, feet.Y - FootprintDepth / 2,
                feet.X + FootprintWidth / 2, feet.Y + FootprintDepth / 2);

        /// <summary>点击某处换位。others 是同一区域里其他成员的已确认落点（第一阶段单人时为空）。</summary>
        public PlaceResult TryPlace(MapDef map, FishingMode mode, ScenePoint target, IEnumerable<ScenePoint> others)
        {
            var kind = mode.Area();
            if (!map.AreaOf(kind).Contains(target)) return PlaceResult.NotInArea;
            return Fits(map, kind, target, others) ? PlaceResult.Placed : PlaceResult.NoRoom;
        }

        /// <summary>
        /// 首次进入、切模式、切地图时系统先安排一个能放下的位置（09 §4.2）：
        /// 从地图锚点向两侧交替试探，取第一个放得下的点；整片都放不下返回 null（安排失败）。
        /// </summary>
        public ScenePoint? Arrange(MapDef map, FishingMode mode, IEnumerable<ScenePoint> others)
        {
            var kind = mode.Area();
            var area = map.AreaOf(kind);
            var occupied = new List<ScenePoint>(others);
            double y = area.CenterY;
            double anchor = Math.Max(area.Left, Math.Min(area.Right, map.AnchorXOf(kind)));
            int maxSteps = (int)Math.Ceiling((area.Right - area.Left) / ArrangeStep) + 1;
            for (int i = 0; i <= maxSteps; i++)
            {
                foreach (double x in i == 0 ? new[] { anchor } : new[] { anchor + i * ArrangeStep, anchor - i * ArrangeStep })
                {
                    var p = new ScenePoint(x, y);
                    if (area.Contains(p) && Fits(map, kind, p, occupied)) return p;
                }
            }
            return null;
        }

        private static bool Fits(MapDef map, AreaKind kind, ScenePoint feet, IEnumerable<ScenePoint> others)
        {
            var box = Footprint(feet);
            var area = map.AreaOf(kind);
            // 占地框左右不能伸出连续区域（伸出去就站到水里/画面外了）；前后深度允许略出区域上下沿。
            if (box.Left < area.Left || box.Right > area.Right) return false;
            foreach (var blocked in map.BlockedOf(kind))
                if (blocked.Intersects(box)) return false;
            foreach (var other in others)
                if (Footprint(other).Intersects(box)) return false;
            return true;
        }
    }
}
