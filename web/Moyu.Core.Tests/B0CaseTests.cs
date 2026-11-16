using Moyu.Core.Desktop;
using Moyu.Core.Engine;
using Moyu.Core.Scene;
using Moyu.Core.State;

namespace Moyu.Core.Tests;

/// <summary>
/// B0 用例表（doc/测试用例/B0 第一阶段.md）按覆盖标准补出的内核用例：边界值、反例、不变量、状态组合。
/// </summary>
public class B0CaseTests
{
    private static PetController NewController() =>
        new PetController(new DesktopLayout(), MapCatalog.CreatePlaceholder());

    [TestCase(1280, 720, 320, 180, Description = "B0-02 TECH-08：1280×720 桌面")]
    [TestCase(1080, 1920, 270, 151.875, Description = "B0-02 TECH-08：竖屏桌面")]
    [TestCase(1920, 300, 448, 252, Description = "B0-02 TECH-08：很矮的桌面按工作区高度收小")]
    public void Window_size_on_other_desktops(double w, double h, double ww, double wh)
    {
        var layout = new DesktopLayout(w, h);
        Assert.That(layout.WindowWidth, Is.EqualTo(ww).Within(1e-9));
        Assert.That(layout.WindowHeight, Is.EqualTo(wh).Within(1e-9));
        Assert.That(layout.WindowHeight, Is.LessThanOrEqualTo(layout.WorkAreaHeight));
    }

    [Test(Description = "B0-03 UI-01：恰好贴住工作区右下角不被挪动，再多半像素就夹回")]
    public void Window_clamp_exact_edges()
    {
        var c = NewController();
        Assert.That(c.MoveWindow(1440, 762), Is.EqualTo(new WindowPosition(1440, 762)));
        Assert.That(c.MoveWindow(1440.5, 762.5), Is.EqualTo(new WindowPosition(1440, 762)));
        Assert.That(c.MoveWindow(0, 0), Is.EqualTo(new WindowPosition(0, 0)));
    }

    // 地图一：岸 x 40—1560、荷花茎 110—170 与 1440—1500；浅水 x 40—1560、y 650—760、大荷叶 960—1340。占地框宽 180。
    [TestCase(FishingMode.Lure, 260, 565, PlaceResult.Placed, Description = "B0-18 左荷花茎右侧正好贴住")]
    [TestCase(FishingMode.Lure, 259, 565, PlaceResult.NoRoom, Description = "B0-18 左荷花茎右侧压进 1")]
    [TestCase(FishingMode.Lure, 1350, 565, PlaceResult.Placed, Description = "B0-18 右荷花茎左侧正好贴住")]
    [TestCase(FishingMode.Lure, 1351, 565, PlaceResult.NoRoom, Description = "B0-18 右荷花茎左侧压进 1")]
    [TestCase(FishingMode.Wade, 130, 705, PlaceResult.Placed, Description = "B0-18 浅水左端正好放下")]
    [TestCase(FishingMode.Wade, 129, 705, PlaceResult.NoRoom, Description = "B0-18 浅水左端伸出 1")]
    [TestCase(FishingMode.Wade, 870, 705, PlaceResult.Placed, Description = "B0-18 大荷叶左侧正好贴住")]
    [TestCase(FishingMode.Wade, 871, 705, PlaceResult.NoRoom, Description = "B0-18 大荷叶左侧压进 1")]
    [TestCase(FishingMode.Wade, 1430, 705, PlaceResult.Placed, Description = "B0-18 大荷叶右侧正好贴住")]
    [TestCase(FishingMode.Wade, 1429, 705, PlaceResult.NoRoom, Description = "B0-18 大荷叶右侧压进 1")]
    [TestCase(FishingMode.Wade, 1470, 705, PlaceResult.Placed, Description = "B0-18 浅水右端正好放下")]
    [TestCase(FishingMode.Wade, 1471, 705, PlaceResult.NoRoom, Description = "B0-18 浅水右端伸出 1")]
    [TestCase(FishingMode.Wade, 500, 650, PlaceResult.Placed, Description = "B0-18 浅水上沿算在区域内")]
    [TestCase(FishingMode.Wade, 500, 649.9, PlaceResult.NotInArea, Description = "B0-18 浅水上沿外")]
    [TestCase(FishingMode.Wade, 500, 760, PlaceResult.Placed, Description = "B0-18 浅水下沿算在区域内")]
    [TestCase(FishingMode.Wade, 500, 760.1, PlaceResult.NotInArea, Description = "B0-18 浅水下沿外")]
    public void Footprint_edges(FishingMode mode, double x, double y, PlaceResult expected)
    {
        var c = NewController();
        c.SwitchMode(mode);
        var before = c.State.Spot;
        Assert.That(c.ClickScene(new ScenePoint(x, y)), Is.EqualTo(expected));
        Assert.That(c.State.Spot, Is.EqualTo(expected == PlaceResult.Placed ? new ScenePoint(x, y) : before));
    }

    [Test(Description = "B0-21 09 §4.2：整片区域都放不下时安排失败，不硬塞；之后单击也不会落座")]
    public void Arrange_fails_when_area_is_full()
    {
        var full = new SceneRect(40, 520, 1560, 600);
        var map = new MapDef("full", "满", new SceneRect(40, 540, 1560, 590), new SceneRect(40, 650, 1560, 760),
            new[] { full }, System.Array.Empty<SceneRect>(), 330, 420);
        var c = new PetController(new DesktopLayout(), new MapCatalog(new[] { map }));
        Assert.That(c.State.Spot, Is.Null);
        Assert.That(c.ClickScene(new ScenePoint(800, 565)), Is.EqualTo(PlaceResult.NoRoom));
        Assert.That(c.State.Spot, Is.Null);
        Assert.That(c.ToPrefs().HasSpot, Is.False);
        c.SwitchMode(FishingMode.Wade);
        Assert.That(c.State.Spot, Is.Not.Null, "浅水没被占满，切过去就能安排");
    }

    [Test(Description = "B0-23 PLAY-01：选当前模式只关菜单，不重新安排")]
    public void Switching_to_current_mode_changes_nothing()
    {
        var c = NewController();
        c.ClickScene(new ScenePoint(700, 565));
        c.TogglePanel(Panel.ModeMenu);
        c.SwitchMode(FishingMode.Lure);
        Assert.That(c.State.Mode, Is.EqualTo(FishingMode.Lure));
        Assert.That(c.State.Spot, Is.EqualTo(new ScenePoint(700, 565)));
        Assert.That(c.State.Panel, Is.EqualTo(Panel.None));
    }

    [Test(Description = "B0-24 UI-05/CONTENT-07：切地图、关地图面板都不改当前模式")]
    public void Map_change_keeps_mode()
    {
        var c = NewController();
        c.SwitchMode(FishingMode.Wade);
        c.TogglePanel(Panel.Map);
        c.SelectMap(MapCatalog.Bay);
        Assert.That(c.State.Mode, Is.EqualTo(FishingMode.Wade));
        Assert.That(c.CurrentMap.Shallow.Contains(c.State.Spot!.Value), Is.True, "新地图上按当前模式的区域安排");
        c.ClosePanel();
        Assert.That(c.State.Mode, Is.EqualTo(FishingMode.Wade));
    }

    [Test(Description = "B0-26 CONTENT-02：选当前地图不重新安排，玩家选过的位置保留")]
    public void Selecting_current_map_keeps_spot()
    {
        var c = NewController();
        c.ClickScene(new ScenePoint(1000, 565));
        Assert.That(c.SelectMap(MapCatalog.Pond), Is.True);
        Assert.That(c.State.Spot, Is.EqualTo(new ScenePoint(1000, 565)));
    }

    [Test(Description = "B0-27 CONTENT-08：三张图三种模式都能在连续区域里安排到放得下的位置")]
    public void Every_map_and_mode_can_be_arranged()
    {
        var c = NewController();
        foreach (var map in c.Maps.All)
        {
            c.SelectMap(map.Id);
            foreach (var mode in new[] { FishingMode.Lure, FishingMode.Wade, FishingMode.Pole })
            {
                c.SwitchMode(mode);
                var spot = c.State.Spot;
                Assert.That(spot, Is.Not.Null, $"{map.Id} {mode}");
                Assert.That(map.AreaOf(mode.Area()).Contains(spot!.Value), Is.True, $"{map.Id} {mode}");
                Assert.That(new SpotPlanner().TryPlace(map, mode, spot.Value, System.Array.Empty<ScenePoint>()),
                    Is.EqualTo(PlaceResult.Placed), $"{map.Id} {mode}");
            }
        }
    }

    [Test(Description = "B0-32 TECH-15：收起、恢复、静音都不改模式、地图、落点")]
    public void Collapse_and_mute_keep_play_state()
    {
        var c = NewController();
        c.SwitchMode(FishingMode.Pole);
        c.SelectMap(MapCatalog.Stream);
        var spot = c.State.Spot;
        c.Collapse();
        c.SetMute(false);
        c.Restore();
        c.SetMute(true);
        Assert.That(c.State.Mode, Is.EqualTo(FishingMode.Pole));
        Assert.That(c.State.MapId, Is.EqualTo(MapCatalog.Stream));
        Assert.That(c.State.Spot, Is.EqualTo(spot));
    }

    [Test(Description = "B0-34：关闭再打开回到原位置，收起状态清掉，模式地图不变")]
    public void Close_and_reopen()
    {
        var c = NewController();
        c.MoveWindow(200, 100);
        c.SwitchMode(FishingMode.Wade);
        c.TogglePanel(Panel.Basket);
        c.Collapse();
        c.Close();
        Assert.That(c.State.Closed, Is.True);
        Assert.That(c.State.Panel, Is.EqualTo(Panel.None));
        c.Reopen();
        Assert.That(c.State.Closed, Is.False);
        Assert.That(c.State.Collapsed, Is.False);
        Assert.That(c.State.Window, Is.EqualTo(new WindowPosition(200, 100)));
        Assert.That(c.State.Mode, Is.EqualTo(FishingMode.Wade));
    }

    [Test(Description = "B0-41 05 §6：数字模式名、负坐标、非数落点都回落")]
    public void More_bad_prefs_fall_back()
    {
        var prefs = new PetPrefs { WindowX = -0.2, WindowY = 0.5, Mode = "7", HasSpot = true, SpotX = double.PositiveInfinity, SpotY = 565 };
        var c = PetController.FromPrefs(new DesktopLayout(), MapCatalog.CreatePlaceholder(), prefs);
        Assert.That(c.State.Window, Is.EqualTo(new DesktopLayout().DefaultPosition));
        Assert.That(c.State.Mode, Is.EqualTo(FishingMode.Lure));
        Assert.That(c.State.Spot, Is.Not.Null);
        Assert.That(c.CurrentMap.Shore.Contains(c.State.Spot!.Value), Is.True);

        var none = PetController.FromPrefs(new DesktopLayout(), MapCatalog.CreatePlaceholder(), null);
        Assert.That(none.State.Settings.Passthrough, Is.True);
        Assert.That(none.State.Window, Is.EqualTo(new DesktopLayout().DefaultPosition));
    }
}
