using System;

namespace Moyu.Core.Scene
{
    /// <summary>
    /// 小窗内部画布坐标：1600×900（16:9），与效果图同向，左上为原点。
    /// 地图位置用这套坐标，和桌面窗口位置是两套数据（09 §3）。
    /// </summary>
    public static class SceneCanvas
    {
        public const double Width = 1600;
        public const double Height = 900;
        /// <summary>底栏上沿；场景只画在它上面。</summary>
        public const double BottomBarTop = 780;
    }

    public readonly struct ScenePoint : IEquatable<ScenePoint>
    {
        public double X { get; }
        public double Y { get; }

        public ScenePoint(double x, double y)
        {
            X = x;
            Y = y;
        }

        public bool Equals(ScenePoint other) => X.Equals(other.X) && Y.Equals(other.Y);
        public override bool Equals(object? obj) => obj is ScenePoint p && Equals(p);
        // Stryker disable once all : 只供字典与调试输出，不属于玩法规则
        public override int GetHashCode() => X.GetHashCode() * 397 ^ Y.GetHashCode();
        // Stryker disable once all : 同上
        public override string ToString() => $"({X:0.#}, {Y:0.#})";
    }

    public readonly struct SceneRect
    {
        public double Left { get; }
        public double Top { get; }
        public double Right { get; }
        public double Bottom { get; }

        public SceneRect(double left, double top, double right, double bottom)
        {
            Left = Math.Min(left, right);
            Right = Math.Max(left, right);
            Top = Math.Min(top, bottom);
            Bottom = Math.Max(top, bottom);
        }

        public double CenterY => (Top + Bottom) / 2;

        public bool Contains(ScenePoint p) => p.X >= Left && p.X <= Right && p.Y >= Top && p.Y <= Bottom;

        public bool Intersects(SceneRect r) => r.Left < Right && r.Right > Left && r.Top < Bottom && r.Bottom > Top;
    }
}
