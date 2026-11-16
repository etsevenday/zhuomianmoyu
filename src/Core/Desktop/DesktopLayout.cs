using System;

namespace Moyu.Core.Desktop
{
    /// <summary>
    /// 桌面与小窗的几何。坐标是桌面逻辑像素（1920×1080，网页版按视口等比缩放）。
    /// 小窗固定 16:9（DEC-02），宽高各为桌面的 1/4、面积约 1/16（DEC-01）；可放在工作区内任意位置。
    /// </summary>
    public sealed class DesktopLayout
    {
        public const double DefaultDesktopWidth = 1920;
        public const double DefaultDesktopHeight = 1080;
        /// <summary>网页模拟桌面的任务栏高度；PC 端换成系统工作区。</summary>
        public const double DefaultTaskbarHeight = 48;
        /// <summary>默认位置离工作区右、下边的距离。</summary>
        public const double DefaultMargin = 24;

        public double DesktopWidth { get; }
        public double DesktopHeight { get; }
        public double TaskbarHeight { get; }

        public DesktopLayout(double desktopWidth = DefaultDesktopWidth, double desktopHeight = DefaultDesktopHeight,
            double taskbarHeight = DefaultTaskbarHeight)
        {
            if (desktopWidth <= 0 || desktopHeight <= 0) throw new ArgumentOutOfRangeException(nameof(desktopWidth));
            DesktopWidth = desktopWidth;
            DesktopHeight = desktopHeight;
            TaskbarHeight = Math.Max(0, taskbarHeight);
        }

        /// <summary>工作区高度：桌面减去任务栏。</summary>
        public double WorkAreaHeight => DesktopHeight - TaskbarHeight;

        /// <summary>小窗宽：桌面宽的 1/4，且不超过工作区按 16:9 能放下的宽度。</summary>
        public double WindowWidth => Math.Min(DesktopWidth / 4, WorkAreaHeight * 16 / 9);

        /// <summary>小窗高：由宽按 16:9 算出，保证比例不变。</summary>
        public double WindowHeight => WindowWidth * 9 / 16;

        /// <summary>首次打开的位置：工作区右下角。</summary>
        public WindowPosition DefaultPosition =>
            new WindowPosition(DesktopWidth - WindowWidth - DefaultMargin, WorkAreaHeight - WindowHeight - DefaultMargin);

        /// <summary>把小窗左上角夹进工作区，整窗可见。</summary>
        public WindowPosition Clamp(double x, double y)
        {
            double maxX = DesktopWidth - WindowWidth;
            double maxY = WorkAreaHeight - WindowHeight;
            return new WindowPosition(Math.Max(0, Math.Min(maxX, x)), Math.Max(0, Math.Min(maxY, y)));
        }

        /// <summary>收起后的头像：直径为小窗高的 1/4。</summary>
        public double AvatarSize => WindowHeight / 4;

        /// <summary>收起时头像放在小窗左下（角色所在处），并夹进工作区。</summary>
        public WindowPosition AvatarPosition(WindowPosition window)
        {
            double x = window.X + WindowWidth * 0.06;
            double y = window.Y + WindowHeight - AvatarSize - WindowHeight * 0.18;
            return new WindowPosition(
                Math.Max(0, Math.Min(DesktopWidth - AvatarSize, x)),
                Math.Max(0, Math.Min(WorkAreaHeight - AvatarSize, y)));
        }

        /// <summary>由头像位置反推恢复后小窗的位置（拖动过头像时用）。</summary>
        public WindowPosition WindowFromAvatar(WindowPosition avatar) =>
            Clamp(avatar.X - WindowWidth * 0.06, avatar.Y - WindowHeight + AvatarSize + WindowHeight * 0.18);
    }

    public readonly struct WindowPosition : IEquatable<WindowPosition>
    {
        public double X { get; }
        public double Y { get; }

        public WindowPosition(double x, double y)
        {
            X = x;
            Y = y;
        }

        public bool Equals(WindowPosition other) => X.Equals(other.X) && Y.Equals(other.Y);
        public override bool Equals(object? obj) => obj is WindowPosition p && Equals(p);
        public override int GetHashCode() => X.GetHashCode() * 397 ^ Y.GetHashCode();
        public override string ToString() => $"({X:0.#}, {Y:0.#})";
    }
}
