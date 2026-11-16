namespace Moyu.Web.Services;

/// <summary>效果图里的两种示例鱼。第一阶段面板只读布局用；名字与长度只是排版示例（03 §6），不进任何配置。</summary>
public enum FishLook
{
    Silver,
    BigTail,
}

public sealed record SampleFish(int Id, string Name, FishLook Look, double LengthCm);

public static class SampleData
{
    public static readonly SampleFish SilverFish = new(1, "小银鱼", FishLook.Silver, 23.6);
    public static readonly SampleFish BigTailFish = new(2, "巨尾鱼", FishLook.BigTail, 42.0);

    public static List<SampleFish> Basket() => new() { SilverFish, BigTailFish };

    /// <summary>记录页示例：两种已发现，一种未发现。</summary>
    public static readonly (SampleFish? Fish, string Label)[] Records =
    {
        (SilverFish, SilverFish.Name),
        (BigTailFish, BigTailFish.Name),
        (null, "？？？"),
    };
}
