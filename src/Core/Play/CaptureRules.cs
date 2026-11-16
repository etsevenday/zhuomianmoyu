using System.Collections.Generic;
using System.Linq;
using Moyu.Core.Scene;

namespace Moyu.Core.Play
{
    /// <summary>
    /// 一种主动模式的节点规则（WEB-DEC-02）：本轮累计到随机节点各判一次，到保底节点直接出鱼。
    /// 成功只清本组本轮（WEB-DEC-03）。
    /// </summary>
    public sealed class CaptureRule
    {
        public IReadOnlyList<int> RandomNodes { get; }
        public double NodeProbability { get; }
        public int GuaranteedNode { get; }

        public CaptureRule(IEnumerable<int> randomNodes, double nodeProbability, int guaranteedNode)
        {
            RandomNodes = randomNodes.ToList();
            NodeProbability = nodeProbability;
            GuaranteedNode = guaranteedNode;
        }

        /// <summary>本轮已累计 count 次时，下一个要判定（或保底）的节点。</summary>
        // Stryker disable once Linq : DefaultIfEmpty 之后序列一定不空，First 和 FirstOrDefault 结果一样
        public int NextNode(long count) => RandomNodes.Where(n => n > count).DefaultIfEmpty(GuaranteedNode).First();
    }

    /// <summary>网页核心循环 v0.1 的规则版本与节点（参数 JSON 的 capture 段）。</summary>
    public static class CaptureRules
    {
        public const string RulesVersion = "web_core_0.1";

        /// <summary>路亚：500 次判 50%，累计 1000 必得。</summary>
        public static readonly CaptureRule Lure = new CaptureRule(new[] { 500 }, 0.5, 1000);

        /// <summary>摸鱼：200、400……1800 各判 20%，累计 2000 必得。</summary>
        public static readonly CaptureRule Wade = new CaptureRule(Enumerable.Range(1, 9).Select(i => i * 200), 0.2, 2000);

        /// <summary>手竿没有输入节点（计时另定，00 §5），返回 null。</summary>
        public static CaptureRule? For(FishingMode mode) => mode switch
        {
            FishingMode.Lure => Lure,
            FishingMode.Wade => Wade,
            _ => null,
        };
    }
}
