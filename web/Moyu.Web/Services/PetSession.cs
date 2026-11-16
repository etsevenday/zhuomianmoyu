using Moyu.Core.Desktop;
using Moyu.Core.Engine;
using Moyu.Core.Scene;

namespace Moyu.Web.Services;

/// <summary>网页里的一局：内核控制器、示例鱼篓、提示气泡，以及保存。</summary>
public sealed class PetSession
{
    private readonly PrefsStore _store;

    public PetSession(PrefsStore store) => _store = store;

    public PetController Pet { get; private set; } =
        new(new DesktopLayout(), MapCatalog.CreatePlaceholder());

    public List<SampleFish> Basket { get; } = SampleData.Basket();
    public int SelectedFishId { get; set; } = SampleData.SilverFish.Id;

    /// <summary>新鱼获轻提示（开发入口模拟）；关掉提示不影响鱼篓。</summary>
    public SampleFish? CatchToast { get; set; }

    /// <summary>选位放不下时在点击处冒的短提示。</summary>
    public ScenePoint? NoRoomAt { get; set; }

    public event Action? Changed;

    public async Task LoadAsync()
    {
        var prefs = await _store.LoadAsync();
        Pet = PetController.FromPrefs(new DesktopLayout(), MapCatalog.CreatePlaceholder(), prefs);
        Changed?.Invoke();
    }

    public async Task CommitAsync()
    {
        Changed?.Invoke();
        await _store.SaveAsync(Pet.ToPrefs());
    }

    private int _nextFishId = 100;

    /// <summary>开发入口：模拟一条鱼获。先放进鱼篓，再出提示（01 §6）。</summary>
    public void SimulateCatch()
    {
        var fish = SampleData.SilverFish with { Id = _nextFishId++ };
        Basket.Add(fish);
        CatchToast = fish;
        Changed?.Invoke();
    }
}
