"""寿命分析：带右删失数据的 Weibull 最大似然估计、Weibayes、Nelson-Aalen 经验累计故障率。

售后数据里绝大多数产品还没坏（右删失）。只对已坏产品求平均寿命会严重偏低，
所以按“故障时间 + 仍在使用产品的已用时间”一起估计 Weibull 参数。
时间单位均为月。
"""
import math


def _sums(beta, times, weights):
    s0 = s1 = 0.0
    for t, w in zip(times, weights):
        tb = w * t ** beta
        s0 += tb
        s1 += tb * math.log(t)
    return s0, s1


def weibull_fit(failures, censored, beta=None):
    """failures: 故障时间列表；censored: [(删失时间, 台数)]。

    beta 为 None 时用剖面似然方程二分求 β；给定 beta 时为 Weibayes，只估计 η。
    返回 dict(beta, eta, r, method)；故障数为 0 且未给 β 时返回 None。
    """
    fails = [max(t, 0.05) for t in failures]
    r = len(fails)
    times = fails + [max(c, 0.05) for c, n in censored if n > 0]
    weights = [1.0] * r + [float(n) for c, n in censored if n > 0]
    if not times:
        return None
    scale = max(times)
    times = [t / scale for t in times]
    if beta is None:
        if r < 2:
            return None
        mean_log = sum(math.log(t / scale) for t in fails) / r

        def g(b):
            s0, s1 = _sums(b, times, weights)
            return s1 / s0 - 1 / b - mean_log

        lo, hi = 0.1, 12.0
        if g(lo) > 0 or g(hi) < 0:
            return None
        for _ in range(80):
            mid = (lo + hi) / 2
            if g(mid) > 0:
                hi = mid
            else:
                lo = mid
        beta, method = (lo + hi) / 2, "MLE"
    else:
        method = "Weibayes"
    s0, _ = _sums(beta, times, weights)
    # Weibayes 零故障时按 1 个故障保守估计
    eta = scale * (s0 / max(r, 1)) ** (1 / beta)
    return {"beta": beta, "eta": eta, "r": r, "method": method}


def cdf(fit, t):
    return 1 - math.exp(-((t / fit["eta"]) ** fit["beta"]))


def b_life(fit, p):
    """B_p 寿命：比例 p 的产品故障所用时间。"""
    return fit["eta"] * (-math.log(1 - p)) ** (1 / fit["beta"])


def mttf(fit):
    return fit["eta"] * math.gamma(1 + 1 / fit["beta"])


def nelson_aalen(failures, censored, max_month, min_at_risk=200):
    """按月分箱的经验累计故障率 F(t) = 1 - exp(-H(t))，风险集过小的月份不输出。"""
    deaths = [0] * (max_month + 1)
    for t in failures:
        m = int(t)
        if m <= max_month:
            deaths[m] += 1
    exits = [0.0] * (max_month + 2)
    for t in failures:
        exits[min(int(t), max_month + 1)] += 1
    for c, n in censored:
        exits[min(int(c), max_month + 1)] += n
    at_risk = sum(exits)
    h, out = 0.0, []
    for m in range(max_month + 1):
        if at_risk < min_at_risk:
            break
        h += deaths[m] / at_risk
        out.append([m + 1, 1 - math.exp(-h)])
        at_risk -= exits[m]
    return out
