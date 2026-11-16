namespace Moyu.Core.Play
{
    /// <summary>
    /// 可重建的随机数：结果只由档案种子和一个说明"这是哪一次掷骰"的键决定（03 §5）。
    /// 同一节点、同一次抽取无论重试、刷新多少次都得到同一个结果，所以保存失败后重走不会重抽。
    /// 算法一经发布就不能改：改了以后旧档里没走完的节点会掷出不同结果（B1-19 用固定值锁住）。
    /// </summary>
    public static class Dice
    {
        /// <summary>FNV-1a 把键（按 UTF-16 码元）和种子混成 64 位，再用 SplitMix64 的收尾打散。</summary>
        public static ulong Hash(ulong seed, string key)
        {
            ulong h = 14695981039346656037UL ^ seed;
            foreach (char c in key)
            {
                h ^= c;
                h *= 1099511628211UL;
            }
            h += 0x9E3779B97F4A7C15UL;
            // Stryker disable Bitwise : h 是无符号 ulong，>> 本来就是补 0 的右移，和 >>> 完全一样
            h = (h ^ (h >> 30)) * 0xBF58476D1CE4E5B9UL;
            h = (h ^ (h >> 27)) * 0x94D049BB133111EBUL;
            return h ^ (h >> 31);
            // Stryker restore Bitwise
        }

        /// <summary>[0, 1) 上的均匀小数，取哈希的高 53 位。</summary>
        // Stryker disable once Bitwise : 同上，无符号右移
        public static double Unit(ulong seed, string key) => (Hash(seed, key) >> 11) * (1.0 / (1UL << 53));

        /// <summary>[0, n) 上的均匀整数；n 必须大于 0。</summary>
        public static int Below(ulong seed, string key, int n) => (int)(Unit(seed, key) * n);
    }
}
