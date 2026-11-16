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

    [TestCase(0, 1080, Description = "B0-02 桌面宽为 0")]
    [TestCase(1920, 0, Description = "B0-02 桌面高为 0")]
    [TestCase(-1, 1080, Description = "B0-02 桌面宽为负")]
    public void Invalid_desktop_size_is_rejected(double w, double h)
    {
        Assert.Throws<System.ArgumentOutOfRangeException>(() => new DesktopLayout(w, h));
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
    [TestCase(FishingMode.Lure, 40, 565, PlaceResult.NoRoom, Description = "B0-18 岸边左端点算在区域内（放不下会冒提示）")]
    [TestCase(FishingMode.Lure, 39.9, 565, PlaceResult.NotInArea, Description = "B0-18 岸边左端外（不冒提示）")]
    [TestCase(FishingMode.Lure, 1560, 565, PlaceResult.NoRoom, Description = "B0-18 岸边右端点算在区域内")]
    [TestCase(FishingMode.Lure, 1560.1, 565, PlaceResult.NotInArea, Description = "B0-18 岸边右端外")]
    [TestCase(FishingMode.Wade, 1100, 755, PlaceResult.Placed, Description = "B0-18 大荷叶下方：占地框上沿正好贴住荷叶下沿")]
    [TestCase(FishingMode.Wade, 1100, 754, PlaceResult.NoRoom, Description = "B0-18 大荷叶下方：上沿压进 1")]
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

    [Test(Description = "B0-43：首次打开、空存档都在工作区右下角留 24 边距（1920×1080 下 (1416,738)），其余取默认")]
    public void Defaults_for_new_and_empty_prefs()
    {
        Assert.That(new DesktopLayout().DefaultPosition, Is.EqualTo(new WindowPosition(1416, 738)));
        Assert.That(new DesktopLayout(1280, 720).DefaultPosition, Is.EqualTo(new WindowPosition(1280 - 320 - 24, 720 - 48 - 180 - 24)));
        foreach (var c in new[] { NewController(), PetController.FromPrefs(new DesktopLayout(), MapCatalog.CreatePlaceholder(), new PetPrefs()) })
        {
            Assert.That(c.State.Window, Is.EqualTo(new WindowPosition(1416, 738)));
            Assert.That(c.State.Settings.Passthrough, Is.True);
            Assert.That(c.State.Settings.Mute, Is.True);
            Assert.That(c.State.Mode, Is.EqualTo(FishingMode.Lure));
            Assert.That(c.State.MapId, Is.EqualTo(MapCatalog.Pond));
            Assert.That(c.State.Collapsed, Is.False);
            Assert.That(c.State.Closed, Is.False);
            Assert.That(c.State.Spot, Is.EqualTo(new ScenePoint(330, 565)));
        }
    }

    [Test(Description = "B0-44：落点、窗口位置要两个分量都相同才算同一位置（各条\"位置不变\"断言靠它）")]
    public void Positions_compare_both_components()
    {
        Assert.That(new ScenePoint(1, 2), Is.EqualTo(new ScenePoint(1, 2)));
        Assert.That(new ScenePoint(1, 2), Is.Not.EqualTo(new ScenePoint(1, 3)));
        Assert.That(new ScenePoint(1, 2), Is.Not.EqualTo(new ScenePoint(0, 2)));
        Assert.That(new WindowPosition(1, 2), Is.EqualTo(new WindowPosition(1, 2)));
        Assert.That(new WindowPosition(1, 2), Is.Not.EqualTo(new WindowPosition(1, 3)));
        Assert.That(new WindowPosition(1, 2), Is.Not.EqualTo(new WindowPosition(0, 2)));
    }

    [TestCase(565, PlaceResult.Placed, Description = "B0-18 岸边下方装饰：占地框下沿正好贴住")]
    [TestCase(566, PlaceResult.NoRoom, Description = "B0-18 岸边下方装饰：下沿压进 1")]
    public void Footprint_bottom_edge(double y, PlaceResult expected)
    {
        var map = OpenShore("m", 330, new SceneRect(700, 585, 900, 600));
        Assert.That(new SpotPlanner().TryPlace(map, FishingMode.Lure, new ScenePoint(800, y), System.Array.Empty<ScenePoint>()), Is.EqualTo(expected));
    }

    [Test(Description = "B0-33 B0 Q1 假设：头像直径为小窗高的 1/4，放在小窗左下角色处")]
    public void Avatar_size_and_position()
    {
        var layout = new DesktopLayout();
        Assert.That(layout.AvatarSize, Is.EqualTo(67.5).Within(1e-9));
        var a = layout.AvatarPosition(new WindowPosition(300, 300));
        Assert.That(a.X, Is.EqualTo(300 + 480 * 0.06).Within(1e-9));
        Assert.That(a.Y, Is.EqualTo(300 + 270 - 67.5 - 270 * 0.18).Within(1e-9));
    }

    [Test(Description = "B0-18：矩形只贴住边不算相交，四个方向都一样")]
    public void Touching_rects_do_not_intersect()
    {
        var r = new SceneRect(100, 100, 200, 200);
        Assert.That(r.Intersects(new SceneRect(200, 120, 300, 180)), Is.False, "右");
        Assert.That(r.Intersects(new SceneRect(0, 120, 100, 180)), Is.False, "左");
        Assert.That(r.Intersects(new SceneRect(120, 200, 180, 300)), Is.False, "下");
        Assert.That(r.Intersects(new SceneRect(120, 0, 180, 100)), Is.False, "上");
        Assert.That(r.Intersects(new SceneRect(199, 199, 300, 300)), Is.True, "压进 1");
    }

    [Test(Description = "B0-15 SPACE-01：自动安排从地图锚点开始（占位地图岸边 x 330、浅水 x 420，取区域上下中线）")]
    public void Arrange_starts_at_anchor()
    {
        var c = NewController();
        Assert.That(c.State.Spot, Is.EqualTo(new ScenePoint(330, 565)));
        c.SwitchMode(FishingMode.Wade);
        Assert.That(c.State.Spot, Is.EqualTo(new ScenePoint(420, 705)));
    }

    private static MapDef OpenShore(string id, double anchorX, params SceneRect[] blocked) =>
        new MapDef(id, id, new SceneRect(40, 540, 1560, 590), new SceneRect(40, 650, 1560, 760),
            blocked, System.Array.Empty<SceneRect>(), anchorX, 420);

    [Test(Description = "B0-45 09 §4.2：锚点放不下时按 20 一步左右交替找；右边全挡住就往左找到最近的点")]
    public void Arrange_searches_left_when_right_is_blocked()
    {
        var map = OpenShore("m", 800, new SceneRect(700, 520, 1560, 600));
        // 占地框右沿不能超过 700，即 x ≤ 610；从 800 往左按 20 一步，第一个是 600
        Assert.That(new SpotPlanner().Arrange(map, FishingMode.Lure, System.Array.Empty<ScenePoint>()), Is.EqualTo(new ScenePoint(600, 565)));
    }

    [TestCase(2000, 1460, Description = "B0-45 锚点在区域右外：先拉回右端 1560，再往左找到 1460")]
    [TestCase(-500, 140, Description = "B0-45 锚点在区域左外：先拉回左端 40，再往右找到 140")]
    public void Arrange_clamps_anchor_into_area(double anchorX, double expectedX)
    {
        var map = OpenShore("m", anchorX);
        Assert.That(new SpotPlanner().Arrange(map, FishingMode.Lure, System.Array.Empty<ScenePoint>()), Is.EqualTo(new ScenePoint(expectedX, 565)));
    }

    [Test(Description = "B0-24 09 §4.2：切到别的地图时旧落点不沿用，按新图重新安排")]
    public void Changing_map_rearranges_even_if_old_spot_would_fit()
    {
        var c = NewController();
        c.ClickScene(new ScenePoint(1000, 565));
        c.SelectMap(MapCatalog.Stream);
        Assert.That(c.State.Spot, Is.EqualTo(new ScenePoint(330, 565)));
    }

    [Test(Description = "B0-24 CONTENT-10：切图后选位、安排都用新地图自己的区域（三张占位图区域相同，这里用形状不同的图）")]
    public void Changing_map_uses_new_map_areas()
    {
        var a = OpenShore("a", 330);
        var b = new MapDef("b", "b", new SceneRect(200, 300, 1400, 350), new SceneRect(200, 400, 1400, 500),
            System.Array.Empty<SceneRect>(), System.Array.Empty<SceneRect>(), 700, 800);
        var c = new PetController(new DesktopLayout(), new MapCatalog(new[] { a, b }));
        c.SelectMap("b");
        Assert.That(c.State.Spot, Is.EqualTo(new ScenePoint(700, 325)));
        Assert.That(c.ClickScene(new ScenePoint(1000, 325)), Is.EqualTo(PlaceResult.Placed), "y 325 只在 b 的岸边里");
        Assert.That(c.ClickScene(new ScenePoint(1000, 565)), Is.EqualTo(PlaceResult.NotInArea), "a 的岸边不再算");
    }

    [Test(Description = "B0-41 05 §6：窗口坐标正好为 0 有效；无穷大回落；没有落点标记时不用存档里的坐标")]
    public void Prefs_edge_values()
    {
        var layout = new DesktopLayout();
        var maps = MapCatalog.CreatePlaceholder();
        Assert.That(PetController.FromPrefs(layout, maps, new PetPrefs { WindowX = 0, WindowY = 0 }).State.Window, Is.EqualTo(new WindowPosition(0, 0)));
        Assert.That(PetController.FromPrefs(layout, maps, new PetPrefs { WindowX = double.PositiveInfinity, WindowY = 0.5 }).State.Window, Is.EqualTo(layout.DefaultPosition));
        Assert.That(PetController.FromPrefs(layout, maps, new PetPrefs { WindowX = 0.5, WindowY = double.PositiveInfinity }).State.Window, Is.EqualTo(layout.DefaultPosition));
        var noSpot = PetController.FromPrefs(layout, maps, new PetPrefs { HasSpot = false, SpotX = 700, SpotY = 565 });
        Assert.That(noSpot.State.Spot, Is.EqualTo(new ScenePoint(330, 565)));
    }
}
