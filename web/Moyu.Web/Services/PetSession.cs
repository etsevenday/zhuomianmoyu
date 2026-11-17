using Microsoft.JSInterop;
using Moyu.Core.Desktop;
using Moyu.Core.Engine;
using Moyu.Core.Play;
using Moyu.Core.Scene;

namespace Moyu.Web.Services;

/// <summary>保存状态，底栏上一直看得见（02 §1）。</summary>
public enum SaveState
{
    Loading,
    Saved,
    Saving,
    /// <summary>有改动还没存进去（保存失败会自动重试）。</summary>
    Unsaved,
    /// <summary>别的标签页在写，这一页只看不写（06 §3）。</summary>
    ReadOnly,
    /// <summary>旧档读不出：不计数、不交易，也不拿空档覆盖它（WA-06）。</summary>
    LoadError,
}

/// <summary>新鱼获卡片（02 §2.1）：保存成功后才出现，4 秒消失；卡片还在时又出鱼就合成一张、从最后一批重新计 4 秒。</summary>
public sealed class CatchCard
{
    public List<FishRecord> Fish { get; } = new();
    public FishRecord Latest => Fish[^1];
}

/// <summary>
/// 网页里的一局：窗口控制器、玩法引擎与存档、面板上的临时选择、提示。
/// 输入和手竿计时直接改当前档案并稍后存；收藏、出售、抽取、装备在档案副本上做、存成功才换上（06 §3 一笔事务）。
/// </summary>
public sealed partial class PetSession
{
    public const int CardMs = 4000;
    private const int SaveDebounceMs = 800;
    private const int RetryMs = 2000;
    /// <summary>手竿多久检查一次时间。只影响显示有多及时，计入多少按真实经过时间算（05 §1.1）。</summary>
    private const int PoleCheckMs = 1000;
    /// <summary>手竿只涨时间时多久存一次；出鱼马上存。刷新只恢复最后存进去的时间。</summary>
    private const int PoleSaveMs = 5000;

    private readonly PrefsStore _prefs;
    private readonly ProfileStore _store;
    private readonly IJSRuntime _js;
    private readonly SemaphoreSlim _saveLock = new(1, 1);

    public PetSession(PrefsStore prefs, ProfileStore store, IJSRuntime js)
    {
        _prefs = prefs;
        _store = store;
        _js = js;
    }

    public PetController Pet { get; private set; } =
        new(new DesktopLayout(), MapCatalog.CreatePlaceholder());

    public FishCatalog FishCatalog { get; } = FishCatalog.CreateTemporary();
    public SkinCatalog Skins { get; } = SkinCatalog.CreateFirstBatch();

    /// <summary>玩法引擎；读档失败、或只读页还没有档时为 null。</summary>
    public PlayEngine? Play { get; private set; }
    public bool Writer { get; private set; }
    public SaveState State { get; private set; } = SaveState.Loading;

    /// <summary>在 PC 外壳（Electron）里跑：设置页不显示网页专属说明（B4，Q24 待文案）。</summary>
    public bool Pc { get; set; }
    public string? LoadError { get; private set; }

    /// <summary>能不能计数和交易：拿到写权、读档正常、初始档已经存进去（03 §5）。</summary>
    public bool CanPlay => Play != null && Writer && State != SaveState.LoadError && Play.Profile.Revision > 0;

    public CatchCard? Card { get; private set; }

    /// <summary>底栏鱼篓上的新鱼数：已存进去、还在鱼篓、没在鱼篓里显示过的正常捕获（02 §2.1）。</summary>
    public int NewFishCount => Play == null ? 0
        : Play.Profile.NewFishIds.Count(id => _unconfirmed.All(f => f.Id != id) && Play.FindFish(id)?.Place == FishPlace.Basket);

    /// <summary>上一段手竿检查间隔超过 5 分钟没计入（状态详情 TXT-STAT-012）；出鱼或换组后不再提。</summary>
    public bool PoleGapExcluded { get; private set; }
    /// <summary>此刻在计时的手竿地图；没在计时为 null。</summary>
    public string? PoleTimingMap => _poleClock.MapId;
    /// <summary>开发入口：把手竿计时看到的"现在"往后拨（验收脚本验 30 分钟和 5 分钟边界用），走同一条计时路径。</summary>
    public long DevSkewMs { get; set; }
    /// <summary>短提示（到账回执、失败原因）。</summary>
    public string? Notice { get; private set; }
    public bool NoticeIsError { get; private set; }

    /// <summary>选位放不下时在点击处冒的短提示。</summary>
    public ScenePoint? NoRoomAt { get; set; }

    // 面板上的临时选择（不进存档）
    public string? FocusFishId { get; set; }
    public HashSet<string> Checked { get; } = new();
    public Quote? PendingSale { get; private set; }
    public string? TankFishId { get; set; }
    public SkinCategory SkinTab { get; set; } = SkinCategory.Rod;
    public string? SkinSelected { get; set; }
    public LedgerEntry? LastDraw { get; private set; }

    public event Action? Changed;

    private bool _dirty;
    private bool _inTransaction;
    private readonly List<(FishingMode Mode, string Map, long At)> _queued = new();
    private readonly List<FishRecord> _unconfirmed = new();
    private CancellationTokenSource? _saveTimer;
    private CancellationTokenSource? _cardTimer;
    private CancellationTokenSource? _noticeTimer;
    private string? _saleOp;
    private List<string>? _saleIds;
    private string? _drawOp;
    private readonly PoleClock _poleClock = new();
    private bool _poleLoop;
    private long _saveDueMs;

    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private long PoleNow => Now + DevSkewMs;
    private void Notify() => Changed?.Invoke();

    // ---- 载入 ----

    public async Task LoadAsync()
    {
        var prefs = await _prefs.LoadAsync();
        Pet = PetController.FromPrefs(new DesktopLayout(), MapCatalog.CreatePlaceholder(), prefs);
        Writer = await _js.InvokeAsync<bool>("moyuPlay.acquireWriter");
        await LoadProfileAsync();
        StartPoleLoop();
    }

    public async Task ReloadPrefsAsync()
    {
        Pet = PetController.FromPrefs(new DesktopLayout(), MapCatalog.CreatePlaceholder(), await _prefs.LoadAsync());
        PoleCheck();
        Notify();
    }

    private async Task LoadProfileAsync()
    {
        _poleClock.Reset(); // 换了档案：从读好的那一刻重新起算，不补算之前那段（05 §1.1）
        State = SaveState.Loading;
        Notify();
        var r = await _store.LoadAsync(FishCatalog, Skins);
        LoadError = r.Error;
        switch (r.Status)
        {
            case LoadStatus.Ok:
                Play = new PlayEngine(r.Profile!, FishCatalog, Skins);
                State = Writer ? SaveState.Saved : SaveState.ReadOnly;
                break;
            case LoadStatus.None when Writer:
                var seed = ulong.Parse(await _js.InvokeAsync<string>("moyuPlay.newSeed"));
                Play = new PlayEngine(PlayEngine.NewProfile(Guid.NewGuid().ToString("N"), seed, Skins), FishCatalog, Skins);
                _dirty = true;
                await SaveNowAsync();
                break;
            case LoadStatus.None:
                Play = null;
                State = SaveState.ReadOnly;
                break;
            default:
                Play = null;
                State = SaveState.LoadError;
                break;
        }
        PoleCheck(); // 读好就起算，不等下一次每秒检查
        Notify();
    }

    /// <summary>排队等到写权后：先重读别的标签页存下的最新档，再开始写（06 §3）。</summary>
    public async Task OnWriterGrantedAsync()
    {
        Writer = true;
        await LoadProfileAsync();
    }

    public async Task CommitPrefsAsync()
    {
        PoleCheck(); // 切模式、切地图、收起、关闭之后：先把时间结给之前那组，再按现在的状态起算
        Notify();
        await _prefs.SaveAsync(Pet.ToPrefs());
    }

    // ---- 手竿计时（05 §1.1） ----

    /// <summary>此刻有计时资格的手竿地图：当前玩法是手竿、小窗没关（收起照算）、能写档。</summary>
    private string? PoleMap => CanPlay && !Pet.State.Closed && Pet.State.Mode == FishingMode.Pole ? Pet.State.MapId : null;

    private void StartPoleLoop()
    {
        if (_poleLoop) return;
        _poleLoop = true;
        _ = PoleLoopAsync();
    }

    private async Task PoleLoopAsync()
    {
        while (true)
        {
            await Task.Delay(PoleCheckMs);
            PoleCheck();
        }
    }

    /// <summary>做一次计时检查。管理事务进行中先不结（档案会被换成副本），锚点不动，下一次检查一起结。</summary>
    public void PoleCheck()
    {
        if (Play == null || _inTransaction) return;
        var before = _poleClock.MapId;
        var r = _poleClock.Check(Play, PoleMap, PoleNow);
        if (_poleClock.MapId != before) PoleGapExcluded = false;
        if (r == null)
        {
            if (before != _poleClock.MapId) Notify();
            return;
        }
        if (r.GapExcluded) PoleGapExcluded = true;
        else _dirty = true;
        if (r.Catch != null)
        {
            PoleGapExcluded = false;
            _unconfirmed.Add(r.Catch);
            _ = SaveNowAsync();
        }
        else if (!r.GapExcluded)
        {
            ScheduleSave(PoleSaveMs);
        }
        Notify();
    }

    // ---- 输入 ----

    /// <summary>
    /// 一次页面工作输入（js/play.js 已排除游戏界面）。关闭小窗时不收；收起照收（05 §1）。
    /// 返回是否接受，接受了网页就播一个短动作。
    /// </summary>
    public bool OnWorkInput()
    {
        if (!CanPlay || Pet.State.Closed) return false;
        var item = (Pet.State.Mode, Pet.State.MapId, Now);
        if (_inTransaction)
        {
            _queued.Add(item);
            return true;
        }
        Apply(item);
        return true;
    }

    private void Apply((FishingMode Mode, string Map, long At) item)
    {
        var r = Play!.Input(item.Mode, item.Map, item.At);
        _dirty = true;
        if (r.Catch != null)
        {
            // 鱼先存，存成功才出卡片（01 §4）
            _unconfirmed.Add(r.Catch);
            _ = SaveNowAsync();
        }
        else
        {
            ScheduleSave(SaveDebounceMs);
        }
        Notify();
    }

    // ---- 保存 ----

    /// <summary>过 delayMs 存一次；已经排着一次更早的就不再排，排着的更晚就改成这次的时间。</summary>
    private void ScheduleSave(int delayMs)
    {
        long due = Now + delayMs;
        if (_saveTimer != null && _saveDueMs <= due) return;
        _saveTimer?.Cancel();
        _saveDueMs = due;
        var timer = _saveTimer = new CancellationTokenSource();
        _ = Later(delayMs, timer.Token, async () =>
        {
            if (_saveTimer == timer) _saveTimer = null;
            await SaveNowAsync();
        });
    }

    /// <summary>过一会儿做一件事；被取消就不做。</summary>
    private static async Task Later(int ms, CancellationToken token, Func<Task> then)
    {
        try
        {
            await Task.Delay(ms, token);
        }
        catch (TaskCanceledException)
        {
            return;
        }
        await then();
    }

    public async Task<bool> SaveNowAsync()
    {
        if (Play == null || !Writer || State == SaveState.LoadError) return false;
        await _saveLock.WaitAsync();
        try
        {
            if (!_dirty) return true;
            _dirty = false;
            var confirming = _unconfirmed.ToList();
            State = SaveState.Saving;
            Notify();
            var (ok, _) = await _store.SaveAsync(Play.Profile);
            if (ok) Confirmed(confirming);
            else Failed();
            return ok;
        }
        finally
        {
            _saveLock.Release();
            Notify();
        }
    }

    private void Confirmed(List<FishRecord> confirming)
    {
        State = _dirty ? SaveState.Unsaved : SaveState.Saved;
        if (_dirty) ScheduleSave(SaveDebounceMs);
        if (confirming.Count == 0) return;
        foreach (var f in confirming) _unconfirmed.Remove(f);
        ShowCard(confirming);
    }

    private void Failed()
    {
        _dirty = true;
        State = SaveState.Unsaved;
        ScheduleSave(RetryMs);
    }

    /// <summary>
    /// 一笔管理操作：在档案副本上做，整份存成功才换上；存不进就丢掉副本，原档不变（WA-06、04 §1）。
    /// 做的期间来的输入先排队，做完再按原顺序处理。返回操作结果和是否已保存。
    /// </summary>
    private async Task<(T Result, bool Saved)> TransactAsync<T>(Func<PlayEngine, T> op, Func<T, bool> changed)
    {
        await _saveLock.WaitAsync();
        _inTransaction = true;
        try
        {
            var copy = new PlayEngine(ProfileStore.Clone(Play!.Profile), FishCatalog, Skins);
            var result = op(copy);
            if (!changed(result)) return (result, false);
            var confirming = _unconfirmed.ToList();
            State = SaveState.Saving;
            Notify();
            var (ok, _) = await _store.SaveAsync(copy.Profile);
            if (!ok)
            {
                Failed();
                return (result, false);
            }
            // 副本里的鱼是新对象；还没确认的鱼按编号换成副本里的
            var remap = _unconfirmed.Select(f => copy.FindFish(f.Id)!).ToList();
            _unconfirmed.Clear();
            _unconfirmed.AddRange(remap);
            Play = copy;
            _dirty = false;
            Confirmed(remap.Where(f => confirming.Any(c => c.Id == f.Id)).ToList());
            return (result, true);
        }
        finally
        {
            _inTransaction = false;
            _saveLock.Release();
            var queued = _queued.ToList();
            _queued.Clear();
            foreach (var item in queued) Apply(item);
            PoleCheck();
            Notify();
        }
    }

    // ---- 鱼获卡片与提示 ----

    private void ShowCard(List<FishRecord> fish)
    {
        Card ??= new CatchCard();
        Card.Fish.AddRange(fish);
        _cardTimer?.Cancel();
        _cardTimer = new CancellationTokenSource();
        _ = Later(CardMs, _cardTimer.Token, () =>
        {
            Card = null;
            Notify();
            return Task.CompletedTask;
        });
    }

    /// <summary>点卡片：打开鱼篓，选中卡片里最新的、还在鱼篓的那条；都不在鱼篓了就只打开（02 §2.1）。</summary>
    public void OpenCard()
    {
        if (Card == null) return;
        FocusFishId = Card.Fish.Select(f => f.Id).Reverse().FirstOrDefault(id => Play?.FindFish(id)?.Place == FishPlace.Basket);
        Card = null;
        _cardTimer?.Cancel();
        Pet.State.Panel = Moyu.Core.State.Panel.Basket;
        Notify();
    }

    private void Say(string text, bool error = false)
    {
        Notice = text;
        NoticeIsError = error;
        _noticeTimer?.Cancel();
        _noticeTimer = new CancellationTokenSource();
        _ = Later(3500, _noticeTimer.Token, () =>
        {
            Notice = null;
            Notify();
            return Task.CompletedTask;
        });
        Notify();
    }

    /// <summary>
    /// 鱼篓列表已经显示了这些鱼：其中的新鱼算看过（02 §2.1）。只认这一次真的画出来的，之后新到的不清。
    /// </summary>
    public void MarkSeen(IReadOnlyCollection<string> shownIds)
    {
        if (!CanPlay || _inTransaction || shownIds.Count == 0) return;
        var confirmed = shownIds.Where(id => _unconfirmed.All(f => f.Id != id)).ToList();
        if (!Play!.MarkSeen(confirmed)) return;
        _dirty = true;
        ScheduleSave(SaveDebounceMs);
        Notify();
    }

    // ---- 鱼篓与收藏 ----

    public async Task CollectAsync(string fishId)
    {
        if (!CanPlay) return;
        var (r, saved) = await TransactAsync(e => e.Collect(fishId, PlayEngine.FirstTankId), r => r == MoveResult.Ok);
        if (r == MoveResult.TankFull) Say(Texts.TankFull, true);
        else if (r == MoveResult.Ok && !saved) Say(Texts.SaveFailed, true);
        else if (r == MoveResult.Ok)
        {
            Checked.Remove(fishId);
            if (FocusFishId == fishId) FocusFishId = null;
        }
    }

    public async Task RetrieveAsync(string fishId)
    {
        if (!CanPlay) return;
        var (r, saved) = await TransactAsync(e => e.Retrieve(fishId), r => r == MoveResult.Ok);
        if (r == MoveResult.Ok && !saved) Say(Texts.SaveFailed, true);
        else if (r == MoveResult.Ok && TankFishId == fishId) TankFishId = null;
    }

    public async Task SetBackgroundAsync(string? tankId)
    {
        if (!CanPlay) return;
        var (r, saved) = await TransactAsync(e => e.SetBackground(tankId), r => r);
        if (r && !saved) Say(Texts.SaveFailed, true);
    }

    // ---- 出售 ----

    /// <summary>勾选了就卖勾选的，没勾就卖当前选中的那条；先报价、等确认（04 §1）。</summary>
    public void BeginSale()
    {
        if (!CanPlay) return;
        var ids = Checked.Count > 0 ? Play!.InBasket.Where(f => Checked.Contains(f.Id)).Select(f => f.Id).ToList()
            : FocusFishId != null ? new List<string> { FocusFishId } : new List<string>();
        var quote = Play!.QuoteSale(ids);
        if (quote.Status != TradeStatus.Ok) return;
        PendingSale = quote;
        _saleIds = ids;
        _saleOp = Guid.NewGuid().ToString("N");
        Notify();
    }

    public void CancelSale()
    {
        PendingSale = null;
        _saleIds = null;
        _saleOp = null;
        Notify();
    }

    public async Task ConfirmSaleAsync()
    {
        if (!CanPlay || PendingSale == null || _saleIds == null || _saleOp == null) return;
        var ids = _saleIds;
        var total = PendingSale.Total;
        var (r, saved) = await TransactAsync(e => e.Sell(_saleOp, ids, total, Now), r => r.Status == TradeStatus.Ok);
        if (r.Status == TradeStatus.Ok && saved)
        {
            Checked.Clear();
            FocusFishId = null;
            PendingSale = null;
            _saleIds = null;
            _saleOp = null;
            Say(Texts.SaleReceipt(r.Receipt!.Lines.Count, r.Receipt.Delta, r.Receipt.BalanceAfter));
        }
        else if (r.Status == TradeStatus.Ok)
        {
            Say(Texts.SaveFailed, true); // 保留同一个操作号，重试只会到账一次
        }
        else
        {
            CancelSale();
            Say(Texts.SaleStale, true);
        }
    }

    // ---- 抽取与装备 ----

    public async Task DrawAsync()
    {
        if (!CanPlay) return;
        _drawOp ??= Guid.NewGuid().ToString("N");
        var op = _drawOp;
        var (r, saved) = await TransactAsync(e => e.Draw(op, Now), r => r.Status == TradeStatus.Ok);
        if (r.Status == TradeStatus.Ok && saved)
        {
            _drawOp = null;
            LastDraw = r.Receipt;
            SkinSelected = r.Receipt!.SkinId;
            SkinTab = Skins.Find(SkinSelected)!.Category;
        }
        else if (r.Status == TradeStatus.Ok) Say(Texts.SaveFailed, true);
        else
        {
            _drawOp = null;
            if (r.Status == TradeStatus.NotEnoughCoins) Say(Texts.NotEnough(SkinCatalog.DrawCost - Play!.Profile.Coins), true);
        }
    }

    public async Task EquipAsync(string skinId)
    {
        if (!CanPlay) return;
        var (r, saved) = await TransactAsync(e => e.Equip(skinId), r => r);
        if (r && !saved) Say(Texts.SaveFailed, true);
    }

    // ---- 开发入口（?dev=1） ----

    public async Task DevInjectFishAsync(int n)
    {
        if (!CanPlay) return;
        var map = Pet.State.MapId;
        await TransactAsync(e => { for (int i = 0; i < n; i++) e.DevInjectFish(map, Now); return true; }, r => r);
    }

    public async Task DevAddCoinsAsync(int n)
    {
        if (!CanPlay) return;
        await TransactAsync(e => e.DevAddCoins(n, Now), _ => true);
    }

    /// <summary>"模拟保存失败"关掉时马上补存，不用等重试计时。</summary>
    public async Task DevSaveFailureChangedAsync(bool failing)
    {
        if (!failing && _dirty) await SaveNowAsync();
        Notify();
    }

    public string DevProfileJson() =>
        Play == null ? "null" : System.Text.Json.JsonSerializer.Serialize(Play.Profile, ProfileStore.Json);
}
