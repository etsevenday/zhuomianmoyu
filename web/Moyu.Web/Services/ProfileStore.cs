using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.JSInterop;
using Moyu.Core.Play;

namespace Moyu.Web.Services;

public enum LoadStatus
{
    /// <summary>这个浏览器里还没有玩法档。</summary>
    None,
    Ok,
    /// <summary>读不出或读出来不能用；不能拿空档覆盖它（WA-06）。</summary>
    Error,
}

public sealed record LoadResult(LoadStatus Status, Profile? Profile, string? Error);

/// <summary>
/// 玩法档存在本浏览器的 IndexedDB（js/play.js），和 localStorage 里的窗口偏好分开（03 §5）。
/// 读写失败都照实返回，不吞掉；保存是整份档案一个事务。
/// </summary>
public sealed class ProfileStore
{
    public static readonly JsonSerializerOptions Json = new() { Converters = { new JsonStringEnumConverter() } };

    private readonly IJSRuntime _js;

    public ProfileStore(IJSRuntime js) => _js = js;

    private sealed class Reply
    {
        public string? Status { get; set; }
        public string? Json { get; set; }
        public long Revision { get; set; }
        public bool Ok { get; set; }
        public string? Message { get; set; }
    }

    public async Task<LoadResult> LoadAsync(FishCatalog fish, SkinCatalog skins)
    {
        Reply r;
        try
        {
            r = await _js.InvokeAsync<Reply>("moyuPlay.load");
        }
        catch (Exception ex)
        {
            return new LoadResult(LoadStatus.Error, null, ex.Message);
        }
        if (r.Status == "none") return new LoadResult(LoadStatus.None, null, null);
        if (r.Status != "ok" || r.Json == null) return new LoadResult(LoadStatus.Error, null, r.Message ?? "读档失败");
        Profile? p;
        try
        {
            p = JsonSerializer.Deserialize<Profile>(r.Json, Json);
        }
        catch (JsonException)
        {
            return new LoadResult(LoadStatus.Error, null, "存档内容损坏");
        }
        PlayEngine.Upgrade(p); // B1 的档升到当前版本；升级后的档下次保存时写回
        var problem = PlayEngine.Validate(p, fish, skins);
        if (problem != null) return new LoadResult(LoadStatus.Error, null, problem);
        p!.Revision = r.Revision;
        return new LoadResult(LoadStatus.Ok, p, null);
    }

    /// <summary>把档案存成 Revision+1；记录里的修订号不是 Revision（别处写过）就失败。成功后 Revision 前进。</summary>
    public async Task<(bool Ok, string? Error)> SaveAsync(Profile p)
    {
        long baseRevision = p.Revision;
        p.Revision = baseRevision + 1;
        string json = JsonSerializer.Serialize(p, Json);
        p.Revision = baseRevision;
        try
        {
            var r = await _js.InvokeAsync<Reply>("moyuPlay.save", json, baseRevision);
            if (!r.Ok) return (false, r.Message ?? "保存失败");
            p.Revision = baseRevision + 1;
            return (true, null);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    public static Profile Clone(Profile p) => JsonSerializer.Deserialize<Profile>(JsonSerializer.Serialize(p, Json), Json)!;
}
