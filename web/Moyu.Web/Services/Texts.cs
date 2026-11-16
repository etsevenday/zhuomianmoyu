using Moyu.Core.Play;

namespace Moyu.Web.Services;

/// <summary>
/// 鱼名、外观名等玩家可见名字。全部【交文案策划定】，B1 Q13 定稿前按建议 A 用直白的占位叫法；
/// 内核只认内部 ID，换文案只改这里。
/// </summary>
public static class Texts
{
    public static string FishName(string speciesId) => speciesId switch
    {
        "TMP_F001" => "银白小鱼",
        "TMP_F002" => "青圆点鱼",
        "TMP_F003" => "金扇尾鱼",
        "TMP_F101" => "荷叶尾鱼",
        "TMP_F201" => "蓝纹长鱼",
        "TMP_F301" => "云纹大鱼",
        _ => speciesId,
    };

    public static string SkinName(string skinId) => skinId switch
    {
        "BASE_CHAR" or "BASE_ROD" or "BASE_GLOVE" or "BASE_SCENE" => "默认",
        "WEB_CHAR_01" => "草帽背带",
        "WEB_CHAR_02" => "黄雨衣",
        "WEB_CHAR_03" => "条纹领巾",
        "WEB_ROD_01" => "薄荷竿",
        "WEB_ROD_02" => "竹节竿",
        "WEB_ROD_03" => "金环竿",
        "WEB_GLOVE_01" => "黄胶手套",
        "WEB_GLOVE_02" => "叶纹手套",
        "WEB_GLOVE_03" => "深蓝手套",
        "WEB_SCENE_01" => "暖灯",
        "WEB_SCENE_02" => "细雨",
        "WEB_SCENE_03" => "月光",
        _ => skinId,
    };

    public static string Category(SkinCategory c) => c switch
    {
        SkinCategory.Character => "人物",
        SkinCategory.Rod => "鱼竿",
        SkinCategory.Glove => "手套",
        _ => "场景",
    };

    /// <summary>体长：整数毫米显示成一位小数的厘米，不经过浮点。</summary>
    public static string Cm(int mm) => $"{mm / 10}.{mm % 10} cm";

    public static string Time(long ms) =>
        DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().ToString("M/d HH:mm");
}
