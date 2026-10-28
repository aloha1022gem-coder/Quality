"""售后故障分析：批次 × 使用月数矩阵、异常批次、寿命分析、故障模式、供应商、改善验证、数据质量。

所有时间窗口以数据截止日（meta.as_of）为准，保证演示结果可复现。
"""
from collections import defaultdict
from datetime import date, timedelta

from ..stats import binom_sf
from . import reference as ref
from . import reliability as rel

LAG = timedelta(days=ref.INSTALL_LAG_DAYS)


def months_between(a, b):
    return (b - a).days / ref.DAYS_PER_MONTH


def month_add(ym, n):
    y, m = map(int, ym.split("-"))
    m = m - 1 + n
    return f"{y + m // 12:04d}-{m % 12 + 1:02d}"


class FieldData:
    """一次性把批次、出货、故障记录读进内存，供各项分析共用。"""

    def __init__(self, db):
        self.db = db
        self.as_of = date.fromisoformat(db.scalar("SELECT value FROM meta WHERE key='as_of'") or date.today().isoformat())
        self.models = ref.model_map()
        self.suppliers = {s[0]: {"code": s[0], "name": s[1], "product": s[2], "region": s[3], "mode": s[4]}
                          for s in ref.SUPPLIERS}
        self.batches = {}
        for b in db.all("SELECT * FROM batches ORDER BY model_code, prod_month"):
            b.update(ships=[], shipped=0, fails=[])
            self.batches[b["batch_no"]] = b
        for s in db.all("SELECT batch_no, ship_date, qty FROM shipments ORDER BY ship_date"):
            b = self.batches.get(s["batch_no"])
            if b:
                b["ships"].append((date.fromisoformat(s["ship_date"]), s["qty"]))
                b["shipped"] += s["qty"]
        for b in self.batches.values():
            b["first_ship"] = b["ships"][0][0] if b["ships"] else None
            b["last_ship"] = b["ships"][-1][0] if b["ships"] else None
        self.failures = db.all("SELECT * FROM failures ORDER BY report_date")
        for f in self.failures:
            f["report"] = date.fromisoformat(f["report_date"])
            f["line"] = self.models.get(f["model_code"], {}).get("line")
            b = self.batches.get(f["batch_no"]) if f["batch_no"] else None
            f["age"] = None
            if b and b["first_ship"]:
                inst = date.fromisoformat(f["install_date"]) if f["install_date"] else b["first_ship"] + LAG
                f["age"] = max(0.05, months_between(inst, f["report"]))
                b["fails"].append(f)
        self.by_model = defaultdict(list)
        for b in self.batches.values():
            self.by_model[b["model_code"]].append(b)

    # ---------------------------------------------------------------- 基本口径
    def matured(self, b, k):
        return b["last_ship"] is not None and months_between(b["last_ship"] + LAG, self.as_of) >= k

    def count_within(self, b, k, part=None):
        return sum(1 for f in b["fails"] if f["age"] <= k and (part is None or f["part_code"] == part))

    def pooled(self, batches, k, part=None, last=None):
        ok = [b for b in batches if self.matured(b, k) and b["shipped"]]
        if last:
            ok = ok[-last:]
        n = sum(b["shipped"] for b in ok)
        x = sum(self.count_within(b, k, part) for b in ok)
        return {"x": x, "n": n, "rate": x / n if n else None, "batches": len(ok)}

    def censored(self, batches):
        """仍在使用的产品：每次出货一组，(已使用月数, 台数)。"""
        out = []
        for b in batches:
            nf = len(b["fails"])
            for ship_date, qty in b["ships"]:
                c = months_between(ship_date + LAG, self.as_of)
                if c > 0:
                    out.append((c, qty - nf * qty / b["shipped"]))
        return out

    def window(self, days):
        start = self.as_of - timedelta(days=days)
        return [f for f in self.failures if f["report"] > start]


# -------------------------------------------------------------------- 批次矩阵与异常批次
def _component_changes(db):
    rows = db.all("SELECT c.batch_no, c.component, c.part_no, b.model_code, b.prod_month FROM batch_components c "
                  "JOIN batches b ON b.batch_no = c.batch_no ORDER BY b.model_code, c.component, b.prod_month")
    changes, last = defaultdict(list), {}
    for r in rows:
        key = (r["model_code"], r["component"])
        if key in last and last[key] != r["part_no"]:
            changes[r["batch_no"]].append(f"{r['component']}：{last[key]} → {r['part_no']}")
        last[key] = r["part_no"]
    return changes


def abnormal_batches(fd):
    found = {}
    for model, batches in fd.by_model.items():
        for k in (3, 6):
            history = []
            for b in batches:
                if not fd.matured(b, k) or not b["shipped"]:
                    continue
                x, n = fd.count_within(b, k), b["shipped"]
                clean = [h for h in history if h[0] not in found][-ref.BASELINE_BATCHES:]
                if len(clean) >= ref.MIN_BASELINE_BATCHES:
                    bx, bn = sum(h[1] for h in clean), sum(h[2] for h in clean)
                    p0 = max(bx, 0.5) / bn
                    pv = binom_sf(x, n, p0)
                    if pv < ref.ALPHA_ABNORMAL and x / n >= 1.5 * p0:
                        prev = found.get(b["batch_no"])
                        if not prev or pv < prev["p_value"]:
                            top = defaultdict(int)
                            for f in b["fails"]:
                                if f["age"] <= k:
                                    top[f["part_code"] or "待拆解"] += 1
                            found[b["batch_no"]] = {
                                "batch_no": b["batch_no"], "model_code": model, "model_name": fd.models[model]["name"],
                                "supplier_code": b["supplier_code"], "prod_month": b["prod_month"], "mis": k,
                                "x": x, "n": n, "rate": x / n, "baseline": p0, "ratio": round(x / n / p0, 1),
                                "p_value": pv, "level": "高" if pv < 1e-7 else "中",
                                "top_parts": sorted(top.items(), key=lambda kv: -kv[1])[:3]}
                history.append((b["batch_no"], x, n))
    return sorted(found.values(), key=lambda a: a["p_value"])


def batch_matrix(db, fd=None):
    fd = fd or FieldData(db)
    changes = _component_changes(db)
    abn = {a["batch_no"]: a for a in abnormal_batches(fd)}
    rows = []
    for model, batches in fd.by_model.items():
        m = fd.models[model]
        for b in batches:
            mis = {}
            for k in ref.MIS_POINTS:
                if fd.matured(b, k) and b["shipped"]:
                    x = fd.count_within(b, k)
                    mis[str(k)] = {"x": x, "rate": x / b["shipped"]}
                else:
                    mis[str(k)] = None
            rows.append({
                "batch_no": b["batch_no"], "model_code": model, "model_name": m["name"], "line": m["line"],
                "supplier_code": b["supplier_code"], "prod_month": b["prod_month"], "shipped": b["shipped"],
                "fails": len(b["fails"]), "mis": mis, "changes": changes.get(b["batch_no"], []),
                "abnormal": abn.get(b["batch_no"], {}).get("level")})
    return {"as_of": fd.as_of.isoformat(), "mis_points": list(ref.MIS_POINTS),
            "targets": {k: v[1] for k, v in ref.LINES.items()}, "rows": rows}


# -------------------------------------------------------------------- 寿命分析
def _fit_summary(fd, batches, part, line, beta=None):
    fails, cens = [], fd.censored(batches)
    for b in batches:
        for f in b["fails"]:
            if part is None or f["part_code"] == part:
                fails.append(f["age"])
            else:
                cens.append((f["age"], 1))  # 其他模式的故障：在该模式下按删失处理
    if not fails and beta is None:
        return None
    fit = rel.weibull_fit(fails, cens, beta=beta)
    if not fit:
        return None
    max_age = max([c for c, _ in cens] + fails + [1])
    return {
        "beta": round(fit["beta"], 2), "eta": round(fit["eta"], 1), "r": fit["r"], "method": fit["method"],
        "units": round(sum(b["shipped"] for b in batches)), "batches": len(batches),
        "r5": round(1 - rel.cdf(fit, 60), 4), "f12": round(rel.cdf(fit, 12), 4),
        "b10": round(rel.b_life(fit, 0.10), 1), "mttf": round(rel.mttf(fit), 1),
        "naive_mean": round(sum(fails) / len(fails), 1) if fails else None,
        "observed_max": round(max_age, 1), "target_r5": ref.LINES[line][2],
        "curve": [[t, round(rel.cdf(fit, t), 5)] for t in range(0, 73, 2)],
        "empirical": [[t, round(v, 5)] for t, v in rel.nelson_aalen(fails, cens, int(max_age))],
        "warning": "故障数少于 10，估计不确定性大" if fit["r"] < 10 else None,
    }


def reliability(db, fd=None):
    fd = fd or FieldData(db)
    bps = defaultdict(list)
    for a in db.all("SELECT * FROM actions WHERE breakpoint_month IS NOT NULL"):
        for m in a["models"].split(","):
            bps[m].append(a)
    out = []
    for model, batches in fd.by_model.items():
        m = fd.models[model]
        counts = defaultdict(int)
        for b in batches:
            for f in b["fails"]:
                if f["part_code"]:
                    counts[f["part_code"]] += 1
        modes = [None] + [p for p, c in sorted(counts.items(), key=lambda kv: -kv[1]) if c >= 15][:3]
        groups = [("all", "全部批次", batches, None)]
        for a in bps.get(model, []):
            bp = a["breakpoint_month"]
            groups.append(("before", f"{bp} 之前", [b for b in batches if b["prod_month"] < bp], a))
            groups.append(("after", f"{bp} 起", [b for b in batches if b["prod_month"] >= bp], a))
            modes = modes if a["part_code"] in modes else modes + [a["part_code"]]
            break
        fits = []
        for part in modes:
            before = None
            for key, label, gb, action in groups:
                if not gb:
                    continue
                if key == "after" and before:
                    # 断点后批次使用时间短，耗损型失效还没显现，β 沿用断点前（Weibayes）
                    s = _fit_summary(fd, gb, part, m["line"], beta=before["beta"])
                else:
                    s = _fit_summary(fd, gb, part, m["line"])
                if key == "before":
                    before = s
                if s:
                    s.update(group=key, group_label=label, part_code=part,
                             part_name=ref.PART_CODES[part][0] if part else "全部故障",
                             action_no=action["action_no"] if action else None)
                    fits.append(s)
        out.append({"model_code": model, "model_name": m["name"], "line": m["line"],
                    "supplier_code": m["supplier"], "fits": fits})
    return {"as_of": fd.as_of.isoformat(), "models": out}


# -------------------------------------------------------------------- 故障模式、供应商
def pareto_cube(db, fd=None, days=365):
    fd = fd or FieldData(db)
    cube = defaultdict(lambda: [0, 0.0])
    for f in fd.window(days):
        m = fd.models[f["model_code"]]
        key = (m["line"], f["model_code"], m["supplier"], f["fault_code"], f["part_code"] or "", f["resp"] or "")
        cube[key][0] += 1
        cube[key][1] += f["cost"] or 0
    return {"days": days, "rows": [list(k) + [v[0], round(v[1])] for k, v in cube.items()]}


def supplier_scores(db, fd=None):
    fd = fd or FieldData(db)
    recent = fd.window(365)
    start = fd.as_of - timedelta(days=365)
    abn = abnormal_batches(fd)
    acts = db.all("SELECT supplier_code, status FROM actions")
    out = []
    for code, s in fd.suppliers.items():
        models = [m for m in fd.models.values() if m["supplier"] == code]
        line = models[0]["line"]
        batches = [b for m in models for b in fd.by_model[m["code"]]]
        mis12 = fd.pooled(batches, 12, last=12 * len(models))
        mis3 = fd.pooled(batches, 3, last=6 * len(models))
        mine = [f for f in recent if fd.models[f["model_code"]]["supplier"] == code]
        target = ref.LINES[line][1]
        ratio = mis12["rate"] / target if mis12["rate"] is not None else 0
        by_resp = defaultdict(lambda: [0, 0.0])
        parts = defaultdict(int)
        for f in mine:
            by_resp[f["resp"] or "待判定"][0] += 1
            by_resp[f["resp"] or "待判定"][1] += f["cost"] or 0
            if f["part_code"]:
                parts[f["part_code"]] += 1
        out.append({
            **s, "line": line, "line_name": ref.line_name(line), "models": [m["code"] for m in models],
            "shipped_12m": sum(q for b in batches for d, q in b["ships"] if d > start),
            "reports_12m": len(mine),
            "traceable": round(sum(1 for f in mine if f["batch_no"]) / len(mine), 3) if mine else None,
            "mis3": mis3["rate"], "mis12": mis12["rate"], "target": target, "ratio": round(ratio, 2),
            "grade": ref.grade_for(ratio),
            "resp": {k: {"count": v[0], "cost": round(v[1])} for k, v in by_resp.items()},
            "claim": round(by_resp["S"][1]),
            "abnormal": sum(1 for a in abn if a["supplier_code"] == code),
            "open_actions": sum(1 for a in acts if a["supplier_code"] == code and a["status"] != "已关闭"),
            "top_parts": [[p, ref.PART_CODES[p][0], c] for p, c in sorted(parts.items(), key=lambda kv: -kv[1])[:3]],
        })
    return sorted(out, key=lambda x: -x["ratio"])


# -------------------------------------------------------------------- 改善验证
def _cohort_curve(fd, batches, part, k_fixed=None, max_k=18):
    """固定一组批次画累计故障率曲线，避免批次构成随月数变化造成假波动。

    k_fixed 给定时取已用满 k_fixed 个月的批次（与验证结论同一口径）；
    否则取已用满月数最长、且至少 3 个批次的那一组。
    """
    need = min(3, len(batches))
    k_max = k_fixed or next((k for k in range(max_k, 0, -1)
                             if need and sum(1 for b in batches if fd.matured(b, k)) >= need), 0)
    cohort = [b for b in batches if fd.matured(b, k_max)] if k_max else []
    return [[k, round(fd.pooled(cohort, k, part=part)["rate"], 5)] for k in range(1, k_max + 1)] if cohort else []


def actions(db, fd=None, rel_data=None):
    fd = fd or FieldData(db)
    rel_data = rel_data or reliability(db, fd)
    out = []
    for a in db.all("SELECT * FROM actions ORDER BY created_at"):
        models = a["models"].split(",")
        a["model_names"] = [fd.models[m]["name"] for m in models]
        a["supplier_name"] = fd.suppliers[a["supplier_code"]]["name"]
        a["part_name"] = ref.PART_CODES[a["part_code"]][0] if a["part_code"] else None
        a["verification"] = None
        bp = a["breakpoint_month"]
        if bp:
            all_b = [b for m in models for b in fd.by_model[m]]
            before = [b for b in all_b if month_add(bp, -12) <= b["prod_month"] < bp]
            after = [b for b in all_b if b["prod_month"] >= bp]
            v = {"verdict": "数据不足", "mis": None, "after_batches": len(after),
                 "note": "断点后成熟批次不足 3 批，继续观察"}
            for k in (12, 6, 3):
                pa, pb = fd.pooled(after, k, a["part_code"]), fd.pooled(before, k, a["part_code"])
                if pa["batches"] >= 3 * len(models) and pb["batches"] >= 3:
                    p_value = 1 - binom_sf(pa["x"] + 1, pa["n"], pb["rate"]) if pb["rate"] else 1.0
                    drop = 1 - pa["rate"] / pb["rate"] if pb["rate"] else 0
                    verdict = ("有效" if p_value < 0.05 and drop >= 0.3 else
                               "未见改善" if drop <= 0 else "趋势改善，待更多数据")
                    v = {"verdict": verdict, "mis": k, "before": pb, "after": pa, "drop": round(drop, 3),
                         "p_value": p_value, "after_batches": len(after),
                         "note": f"按 {k} 个月故障率比较（只统计 {a['part_name']}）"}
                    break
            v["curves"] = {"before": _cohort_curve(fd, before, a["part_code"], v["mis"]),
                           "after": _cohort_curve(fd, after, a["part_code"], v["mis"])}
            proj = {}
            for mdl in rel_data["models"]:
                if mdl["model_code"] == models[0]:
                    for f in mdl["fits"]:
                        if f["part_code"] is None and f["group"] in ("before", "after"):
                            proj[f["group"]] = {k: f[k] for k in ("r5", "b10", "method", "r", "target_r5")}
            v["projection"] = proj
            a["verification"] = v
        out.append(a)
    return out


# -------------------------------------------------------------------- 总览与数据质量
def overview(db, fd=None):
    fd = fd or FieldData(db)
    start = fd.as_of - timedelta(days=365)
    recent = fd.window(365)
    rel_data = reliability(db, fd)
    acts = actions(db, fd, rel_data)
    lines = []
    for code, (name, target, r5_target) in ref.LINES.items():
        batches = [b for m in fd.models.values() if m["line"] == code for b in fd.by_model[m["code"]]]
        n_models = sum(1 for m in fd.models.values() if m["line"] == code)
        p12 = fd.pooled(batches, 12, last=12 * n_models)
        lines.append({"code": code, "name": name, "target": target, "r5_target": r5_target,
                      "mis12": p12["rate"], "reports_12m": sum(1 for f in recent if f["line"] == code),
                      "shipped_12m": sum(q for b in batches for d, q in b["ships"] if d > start)})
    # 每千台在用产品的月报修数
    end_month = fd.as_of.strftime("%Y-%m")
    months = [month_add(end_month, -i) for i in range(23, -1, -1)]
    trend = {c: [] for c in ref.LINES}
    for ym in months:
        m_end = date.fromisoformat(month_add(ym, 1) + "-01") - timedelta(days=1)
        for code in ref.LINES:
            base = sum(q for b in fd.batches.values() if fd.models[b["model_code"]]["line"] == code
                       for d, q in b["ships"] if d + LAG <= m_end)
            n = sum(1 for f in fd.failures if f["line"] == code and f["report_date"][:7] == ym)
            trend[code].append([ym, round(n / base * 1000, 3) if base else 0, n])
    # 近 6 个月上升最快的问题：型号 × 部位
    six = fd.as_of - timedelta(days=182)
    cur, prev = defaultdict(int), defaultdict(int)
    for f in recent:
        key = (f["model_code"], f["part_code"] or "")
        (cur if f["report"] > six else prev)[key] += 1
    issues = sorted(cur.items(), key=lambda kv: -kv[1])[:6]
    sf = next((m for m in rel_data["models"] if m["model_code"] == "SF-101"), None)
    sensor = {}
    if sf:
        for f in sf["fits"]:
            if f["part_code"] is None and f["group"] in ("before", "after", "all"):
                sensor[f["group"]] = {k: f[k] for k in ("r5", "b10", "method", "target_r5", "group_label")}
    last90 = fd.window(91)
    return {
        "as_of": fd.as_of.isoformat(),
        "kpi": {
            "shipped_12m": sum(l["shipped_12m"] for l in lines), "reports_12m": len(recent),
            "traceable_90d": round(sum(1 for f in last90 if f["batch_no"]) / len(last90), 3) if last90 else None,
            "claim_12m": round(sum(f["cost"] or 0 for f in recent if f["resp"] == "S")),
            "pending_parts": sum(1 for f in last90 if not f["part_code"]),
        },
        "lines": lines, "trend": {"months": months, "series": trend}, "sensor": sensor,
        "issues": [{"model_code": k[0], "model_name": fd.models[k[0]]["name"], "part_code": k[1] or None,
                    "part_name": ref.PART_CODES[k[1]][0] if k[1] else "待拆解", "count": v,
                    "prev": prev.get(k, 0)} for k, v in issues],
        "abnormal": abnormal_batches(fd)[:6],
        "actions": [{"action_no": a["action_no"], "title": a["title"], "status": a["status"],
                     "verdict": a["verification"]["verdict"] if a["verification"] else "待实施"} for a in acts],
    }


def data_quality(db, fd=None):
    fd = fd or FieldData(db)
    end_month = fd.as_of.strftime("%Y-%m")
    months = [month_add(end_month, -i) for i in range(23, -1, -1)]
    rows = []
    for ym in months:
        fs = [f for f in fd.failures if f["report_date"][:7] == ym]
        n = len(fs) or 1
        rows.append({"month": ym, "records": len(fs),
                     "traceable": round(sum(1 for f in fs if f["batch_no"]) / n, 3),
                     "install": round(sum(1 for f in fs if f["install_date"]) / n, 3),
                     "part": round(sum(1 for f in fs if f["part_code"]) / n, 3),
                     "returned": round(sum(1 for f in fs if f["returned"]) / n, 3)})
    return {"months": rows,
            "coding_rule_month": db.scalar("SELECT value FROM meta WHERE key='coding_rule_month'"),
            "totals": {"records": len(fd.failures), "batches": len(fd.batches),
                       "units": sum(b["shipped"] for b in fd.batches.values())}}


def dictionary():
    return {
        "lines": [{"code": k, "name": v[0], "mis12_target": v[1], "r5_target": v[2]} for k, v in ref.LINES.items()],
        "faults": [{"code": k, "name": v[0], "line": v[1]} for k, v in ref.FAULT_CODES.items()],
        "parts": [{"code": k, "name": v[0], "line": v[1], "resp": v[2]} for k, v in ref.PART_CODES.items()],
        "resp": [{"code": k, "name": v} for k, v in ref.RESPONSIBILITY.items()],
        "metrics": [{"name": a, "formula": b, "note": c} for a, b, c in ref.METRICS],
        "channels": ref.CHANNELS, "handling": list(ref.HANDLING),
    }
