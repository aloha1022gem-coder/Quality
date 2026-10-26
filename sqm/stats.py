"""统计工具：二项分布精确尾概率与控制限。

来料抽检的不良数服从二项分布。当 n·p 很小时（IQC 常见），正态近似的 3σ 控制限误差较大，
因此这里用二项分布的精确单侧尾概率来判异，阈值与 3σ/2σ/1σ 的单侧概率一致。
"""
import math


def binom_sf(k, n, p):
    """P(X >= k)，X ~ Binomial(n, p)。"""
    if k <= 0:
        return 1.0
    if k > n or p <= 0:
        return 0.0
    if p >= 1:
        return 1.0
    logp, logq = math.log(p), math.log1p(-p)
    lg_n = math.lgamma(n + 1)
    total = 0.0
    for i in range(k, n + 1):
        term = math.exp(lg_n - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * logp + (n - i) * logq)
        total += term
        if i > n * p and term < total * 1e-12:
            break
    return min(1.0, total)


def upper_count_limit(n, p, alpha):
    """最小不良数 c，使 P(X >= c) <= alpha。不良数 >= c 即判为超限。"""
    c = 0
    while c <= n and binom_sf(c, n, p) > alpha:
        c += 1
    return c


def baseline_rate(defects, samples):
    """历史基线不良率；基线无不良时用 0.5 个不良做连续性修正，避免控制限退化为 0。"""
    if samples <= 0:
        return 0.0
    return max(defects, 0.5) / samples
