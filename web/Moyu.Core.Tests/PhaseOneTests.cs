using Moyu.Core.Desktop;
using Moyu.Core.Engine;
using Moyu.Core.Scene;
using Moyu.Core.State;

namespace Moyu.Core.Tests;

/// <summary>第一阶段（06 §4）可在内核层判定的验收：窗口、面板、模式、地图与选位。</summary>
public class PhaseOneTests
{
    private static PetController NewController() =>
        new PetController(new DesktopLayout(), MapCatalog.CreatePlaceholder());

    [Test(Description = "UI-01：1920×1080 时小窗 480×270，16:9")]
    public void Window_is_quarter_size_16_9()
    {
        var layout = new DesktopLayout();
        Assert.That(layout.WindowWidth, Is.EqualTo(480));
        Assert.That(layout.WindowHeight, Is.EqualTo(270));
        Assert.That(layout.WindowWidth / layout.WindowHeight, Is.EqualTo(16.0 / 9).Within(1e-9));
    }

    [Test(Description = "UI-01/TECH-09：可放在工作区任意位置，拖出去会被夹回，整窗可见")]
    public void Window_position_is_clamped_into_work_area()
    {
        var c = NewController();
        Assert.That(c.MoveWindow(100, 200), Is.EqualTo(new WindowPosition(100, 200)));
        var p = c.MoveWindow(5000, 5000);
        Assert.That(p.X, Is.EqualTo(1920 - 480));
        Assert.That(p.Y, Is.EqualTo(1080 - 48 - 270));
        Assert.That(c.MoveWindow(-50, -50), Is.EqualTo(new WindowPosition(0, 0)));
    }

    [Test(Description = "UI-03：拖动只移动窗口，不改模式、地图、落点")]
    public void Dragging_window_keeps_mode_map_and_spot()
    {
        var c = NewController();
        c.SwitchMode(FishingMode.Wade);
        c.SelectMap(MapCatalog.Stream);
        var spot = c.State.Spot;
        c.MoveWindow(10, 10);
        Assert.That(c.State.Mode, Is.EqualTo(FishingMode.Wade));
        Assert.That(c.State.MapId, Is.EqualTo(MapCatalog.Stream));
        Assert.That(c.State.Spot, Is.EqualTo(spot));
    }

    [Test(Description = "01 §2：同一时刻只开一个面板，打开另一个替换，再点同一个关闭")]
    public void Panels_replace_each_other()
    {
        var c = NewController();
        c.TogglePanel(Panel.Basket);
        c.TogglePanel(Panel.Settings);
        Assert.That(c.State.Panel, Is.EqualTo(Panel.Settings));
        c.TogglePanel(Panel.Settings);
        Assert.That(c.State.Panel, Is.EqualTo(Panel.None));
    }

    [Test(Description = "UI-09：收起关掉面板、保持窗口位置，恢复后回原处")]
    public void Collapse_and_restore_keep_position()
    {
        var c = NewController();
        c.MoveWindow(300, 300);
        c.TogglePanel(Panel.Records);
        c.Collapse();
        Assert.That(c.State.Collapsed, Is.True);
        Assert.That(c.State.Panel, Is.EqualTo(Panel.None));
        c.Restore();
        Assert.That(c.State.Window, Is.EqualTo(new WindowPosition(300, 300)));
    }

    [Test(Description = "收起后拖头像：恢复时小窗跟着头像走")]
    public void Dragging_avatar_moves_window()
    {
        var c = NewController();
        c.MoveWindow(300, 300);
        var avatar = c.AvatarPosition;
        c.MoveAvatar(avatar.X + 100, avatar.Y - 50);
        Assert.That(c.State.Window.X, Is.EqualTo(400).Within(1e-9));
        Assert.That(c.State.Window.Y, Is.EqualTo(250).Within(1e-9));
    }

    [Test(Description = "SPACE-01：一进来就被自动安排在当前模式的区域里")]
    public void Spot_is_arranged_on_start()
    {
        var c = NewController();
        Assert.That(c.State.Spot, Is.Not.Null);
        Assert.That(c.CurrentMap.Shore.Contains(c.State.Spot!.Value), Is.True);
    }

    [Test(Description = "09 §2/CONTENT-07：切到摸鱼换到浅水，路亚↔手竿同在岸边则不动")]
    public void Switching_mode_moves_between_shore_and_shallow()
    {
        var c = NewController();
        c.TogglePanel(Panel.ModeMenu);
        var shoreSpot = c.State.Spot;
        c.SwitchMode(FishingMode.Pole);
        Assert.That(c.State.Mode, Is.EqualTo(FishingMode.Pole));
        Assert.That(c.State.Spot, Is.EqualTo(shoreSpot));
        Assert.That(c.State.Panel, Is.EqualTo(Panel.None));
        c.SwitchMode(FishingMode.Wade);
        Assert.That(c.CurrentMap.Shallow.Contains(c.State.Spot!.Value), Is.True);
    }

    [Test(Description = "SPACE-02/UI-13：单击连续区域内的任意点就换到那里")]
    public void Click_in_area_places_exactly_there()
    {
        var c = NewController();
        foreach (var x in new[] { 400.0, 613.0, 877.5, 1200.0 })
        {
            var target = new ScenePoint(x, 570);
            Assert.That(c.ClickScene(target), Is.EqualTo(PlaceResult.Placed));
            Assert.That(c.State.Spot, Is.EqualTo(target));
        }
    }

    [Test(Description = "DEC-14：放不下保留原位，不改投到别处")]
    public void No_room_keeps_previous_spot()
    {
        var c = NewController();
        var before = c.State.Spot;
        Assert.That(c.ClickScene(new ScenePoint(140, 570)), Is.EqualTo(PlaceResult.NoRoom), "荷花茎旁");
        Assert.That(c.ClickScene(new ScenePoint(60, 570)), Is.EqualTo(PlaceResult.NoRoom), "岸的尽头");
        Assert.That(c.State.Spot, Is.EqualTo(before));
    }

    [Test(Description = "不在当前模式区域：天空、路亚时点浅水都不算选位")]
    public void Click_outside_mode_area_is_ignored()
    {
        var c = NewController();
        var before = c.State.Spot;
        Assert.That(c.ClickScene(new ScenePoint(800, 200)), Is.EqualTo(PlaceResult.NotInArea));
        Assert.That(c.ClickScene(new ScenePoint(800, 700)), Is.EqualTo(PlaceResult.NotInArea));
        Assert.That(c.State.Spot, Is.EqualTo(before));
        c.SwitchMode(FishingMode.Wade);
        Assert.That(c.ClickScene(new ScenePoint(800, 700)), Is.EqualTo(PlaceResult.Placed));
    }

    [Test(Description = "SPACE-04：允许紧挨，但两个占地框不能重叠")]
    public void Neighbours_may_stand_close_but_not_overlap()
    {
        var map = MapCatalog.CreatePlaceholder().Default;
        var planner = new SpotPlanner();
        var friend = new ScenePoint(600, 565);
        Assert.That(planner.TryPlace(map, FishingMode.Lure, new ScenePoint(600 + SpotPlanner.FootprintWidth, 565), new[] { friend }),
            Is.EqualTo(PlaceResult.Placed));
        Assert.That(planner.TryPlace(map, FishingMode.Lure, new ScenePoint(650, 565), new[] { friend }),
            Is.EqualTo(PlaceResult.NoRoom));
        var arranged = planner.Arrange(map, FishingMode.Lure, new[] { new ScenePoint(map.ShoreAnchorX, map.Shore.CenterY) });
        Assert.That(arranged, Is.Not.Null);
        Assert.That(SpotPlanner.Footprint(arranged!.Value)
            .Intersects(SpotPlanner.Footprint(new ScenePoint(map.ShoreAnchorX, map.Shore.CenterY))), Is.False);
    }

    [Test(Description = "CONTENT-02/TECH-14：地图三选一；不认识的地图不切")]
    public void Map_selection()
    {
        var c = NewController();
        Assert.That(c.SelectMap(MapCatalog.Bay), Is.True);
        Assert.That(c.State.MapId, Is.EqualTo(MapCatalog.Bay));
        Assert.That(c.SelectMap("nope"), Is.False);
        Assert.That(c.State.MapId, Is.EqualTo(MapCatalog.Bay));
        Assert.That(c.State.Spot, Is.Not.Null);
    }

    [Test(Description = "UI-11/TECH-06：穿透默认开、静音默认开；设置可保存恢复")]
    public void Prefs_round_trip()
    {
        var c = NewController();
        Assert.That(c.State.Settings.Passthrough, Is.True);
        Assert.That(c.State.Settings.Mute, Is.True);
        c.SetPassthrough(false);
        c.SwitchMode(FishingMode.Wade);
        c.SelectMap(MapCatalog.Stream);
        c.ClickScene(new ScenePoint(700, 700));
        c.MoveWindow(123, 456);
        c.Collapse();

        var back = PetController.FromPrefs(new DesktopLayout(), MapCatalog.CreatePlaceholder(), c.ToPrefs());
        Assert.That(back.State.Settings.Passthrough, Is.False);
        Assert.That(back.State.Mode, Is.EqualTo(FishingMode.Wade));
        Assert.That(back.State.MapId, Is.EqualTo(MapCatalog.Stream));
        Assert.That(back.State.Spot, Is.EqualTo(new ScenePoint(700, 700)));
        Assert.That(back.State.Window.X, Is.EqualTo(123).Within(1e-9));
        Assert.That(back.State.Window.Y, Is.EqualTo(456).Within(1e-9));
        Assert.That(back.State.Collapsed, Is.True);
    }

    [Test(Description = "05 §6：坏设置逐项回落，窗口能找回")]
    public void Bad_prefs_fall_back()
    {
        var prefs = new PetPrefs { WindowX = 3.5, WindowY = double.NaN, Mode = "Boat", MapId = "gone", HasSpot = true, SpotX = 140, SpotY = 570 };
        var c = PetController.FromPrefs(new DesktopLayout(), MapCatalog.CreatePlaceholder(), prefs);
        Assert.That(c.State.Window, Is.EqualTo(new DesktopLayout().DefaultPosition));
        Assert.That(c.State.Mode, Is.EqualTo(FishingMode.Lure));
        Assert.That(c.State.MapId, Is.EqualTo(MapCatalog.Pond));
        Assert.That(c.State.Spot, Is.Not.EqualTo(new ScenePoint(140, 570)), "放不下的旧落点要重新安排");

        var far = PetController.FromPrefs(new DesktopLayout(), MapCatalog.CreatePlaceholder(), new PetPrefs { WindowX = 0.99, WindowY = 0.99 });
        Assert.That(far.State.Window, Is.EqualTo(new WindowPosition(1920 - 480, 1080 - 48 - 270)));
    }
}
