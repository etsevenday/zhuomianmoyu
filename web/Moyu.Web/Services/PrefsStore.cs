using System.Text.Json;
using Microsoft.JSInterop;
using Moyu.Core.State;

namespace Moyu.Web.Services;

/// <summary>小窗设置存在本浏览器的 localStorage 里；读写失败（隐私模式、被禁用）就当没有。</summary>
public sealed class PrefsStore
{
    private const string Key = "moyu.prefs.v1";
    private readonly IJSRuntime _js;

    public PrefsStore(IJSRuntime js) => _js = js;

    public async Task<PetPrefs?> LoadAsync()
    {
        try
        {
            var json = await _js.InvokeAsync<string?>("moyuPet.load", Key);
            return string.IsNullOrEmpty(json) ? null : JsonSerializer.Deserialize<PetPrefs>(json);
        }
        catch (Exception)
        {
            return null;
        }
    }

    public async Task SaveAsync(PetPrefs prefs)
    {
        try
        {
            await _js.InvokeVoidAsync("moyuPet.save", Key, JsonSerializer.Serialize(prefs));
        }
        catch (Exception)
        {
            // 存不下不影响当前这次使用
        }
    }
}
