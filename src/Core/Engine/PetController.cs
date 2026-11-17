using System;
using System.Linq;
using Moyu.Core.Desktop;
using Moyu.Core.Scene;
using Moyu.Core.State;

namespace Moyu.Core.Engine
{
    /// <summary>
    /// 第一阶段的小窗逻辑：窗口位置、收起、面板、模式、地图与选位。
    /// 这里的任何操作都是管理/窗口操作，不产生捕鱼输入（01 §4、02 §5）；第一阶段也还没有捕鱼计数。
    /// </summary>
    public sealed class PetController
    {
        private readonly SpotPlanner _planner = new SpotPlanner();

        public DesktopLayout Layout { get; }
        public MapCatalog Maps { get; }
        public GameState State { get; }

        public PetController(DesktopLayout layout, MapCatalog maps, GameState? state = null)
        {
            Layout = layout;
            Maps = maps;
            State = state ?? new GameState { Window = layout.DefaultPosition };
            if (Maps.Find(State.MapId) == null) State.MapId = Maps.Default.Id;
            if (State.Spot == null || !SpotValid(State.Spot.Value)) Rearrange();
        }

        public MapDef CurrentMap => Maps.Find(State.MapId) ?? Maps.Default;

        // ---- 窗口 ----

        /// <summary>拖动结束（含取消）后定下窗口位置。只移动整个窗口，不改模式、地图、落点（01 §4）。</summary>
        public WindowPosition MoveWindow(double x, double y)
        {
            State.Window = Layout.Clamp(x, y);
            return State.Window;
        }

        /// <summary>拖动收起头像结束：按头像位置反推小窗位置。</summary>
        public WindowPosition MoveAvatar(double x, double y)
        {
            State.Window = Layout.WindowFromAvatar(new WindowPosition(x, y));
            return State.Window;
        }

        public WindowPosition AvatarPosition => Layout.AvatarPosition(State.Window);

        /// <summary>收起：关掉面板，缩成头像留在原处；当前模式不变。</summary>
        public void Collapse()
        {
            State.Panel = Panel.None;
            State.Collapsed = true;
        }

        public void Restore() => State.Collapsed = false;

        /// <summary>关闭：网页版里小窗消失；状态保留，再打开时回到原位。</summary>
        public void Close()
        {
            State.Panel = Panel.None;
            State.Closed = true;
        }

        public void Reopen()
        {
            State.Closed = false;
            State.Collapsed = false;
        }

        // ---- 面板 ----

        /// <summary>打开面板；点的就是当前面板则关掉，否则替换（01 §2）。</summary>
        public void TogglePanel(Panel panel)
        {
            State.Panel = State.Panel == panel ? Panel.None : panel;
        }

        public void ClosePanel() => State.Panel = Panel.None;

        // ---- 模式、地图、选位 ----

        /// <summary>切模式：同一时刻只有一个当前模式；岸边/浅水不同时为角色重新安排位置（09 §2）。</summary>
        public void SwitchMode(FishingMode mode)
        {
            State.Panel = Panel.None;
            // Stryker disable once Statement : 去掉也一样——同模式时 sameArea 为真且已有落点，不会重排
            if (State.Mode == mode) return;
            bool sameArea = State.Mode.Area() == mode.Area();
            State.Mode = mode;
            if (!sameArea || State.Spot == null) Rearrange();
        }

        /// <summary>切地图：旧坐标不直接沿用，按新地图区域重新安排（09 §4.2）。</summary>
        public bool SelectMap(string mapId)
        {
            var map = Maps.Find(mapId);
            if (map == null) return false;
            if (map.Id == State.MapId) return true;
            State.MapId = map.Id;
            Rearrange();
            return true;
        }

        /// <summary>
        /// 单击场景（已判定不是拖动）。在当前模式区域内且放得下就换位；放不下保留原位（DEC-13、DEC-14）。
        /// </summary>
        public PlaceResult ClickScene(ScenePoint point)
        {
            var result = _planner.TryPlace(CurrentMap, State.Mode, point, Enumerable.Empty<ScenePoint>());
            if (result == PlaceResult.Placed) State.Spot = point;
            return result;
        }

        /// <summary>
        /// 在同图房间里，地图和落点由房间确认（房主端统一确认，同图房间 01 §4.1），这里只照抄结果；
        /// 本人单独时仍走上面的 SelectMap、SwitchMode、ClickScene。
        /// </summary>
        public void ApplyRoomPlacement(string mapId, FishingMode mode, ScenePoint? spot)
        {
            State.MapId = Maps.Find(mapId)?.Id ?? State.MapId;
            State.Mode = mode;
            State.Spot = spot;
        }

        private bool SpotValid(ScenePoint spot) =>
            _planner.TryPlace(CurrentMap, State.Mode, spot, Enumerable.Empty<ScenePoint>()) == PlaceResult.Placed;

        private void Rearrange() =>
            State.Spot = _planner.Arrange(CurrentMap, State.Mode, Enumerable.Empty<ScenePoint>());

        // ---- 设置 ----

        public void SetPassthrough(bool on) => State.Settings.Passthrough = on;
        public void SetMute(bool on) => State.Settings.Mute = on;
        public void SetTopmost(bool on) => State.Settings.Topmost = on;
        public void SetBackgroundInput(bool on) => State.Settings.BackgroundInput = on;

        // ---- 保存与恢复 ----

        public PetPrefs ToPrefs() => new PetPrefs
        {
            WindowX = State.Window.X / Layout.DesktopWidth,
            WindowY = State.Window.Y / Layout.DesktopHeight,
            Collapsed = State.Collapsed,
            Closed = State.Closed,
            Passthrough = State.Settings.Passthrough,
            Mute = State.Settings.Mute,
            Topmost = State.Settings.Topmost,
            BackgroundInput = State.Settings.BackgroundInput,
            Mode = State.Mode.ToString(),
            MapId = State.MapId,
            HasSpot = State.Spot.HasValue,
            SpotX = State.Spot?.X ?? 0,
            SpotY = State.Spot?.Y ?? 0,
        };

        /// <summary>
        /// 从保存的设置恢复。坏值逐项回落默认：位置夹回工作区（05 §6 能找回），地图/模式不认识就用默认，
        /// 落点在当前地图模式下放不下就重新安排。
        /// </summary>
        public static PetController FromPrefs(DesktopLayout layout, MapCatalog maps, PetPrefs? prefs)
        {
            var state = new GameState { Window = layout.DefaultPosition };
            if (prefs != null)
            {
                if (IsFinite(prefs.WindowX) && IsFinite(prefs.WindowY) && prefs.WindowX >= 0 && prefs.WindowY >= 0)
                    state.Window = layout.Clamp(prefs.WindowX * layout.DesktopWidth, prefs.WindowY * layout.DesktopHeight);
                state.Collapsed = prefs.Collapsed;
                state.Closed = prefs.Closed;
                state.Settings.Passthrough = prefs.Passthrough;
                state.Settings.Mute = prefs.Mute;
                state.Settings.Topmost = prefs.Topmost;
                state.Settings.BackgroundInput = prefs.BackgroundInput;
                if (Enum.TryParse(prefs.Mode, out FishingMode mode) && Enum.IsDefined(typeof(FishingMode), mode))
                    state.Mode = mode;
                if (maps.Find(prefs.MapId) != null) state.MapId = prefs.MapId;
                if (prefs.HasSpot && IsFinite(prefs.SpotX) && IsFinite(prefs.SpotY))
                    state.Spot = new ScenePoint(prefs.SpotX, prefs.SpotY);
            }
            return new PetController(layout, maps, state);
        }

        private static bool IsFinite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);
    }
}
