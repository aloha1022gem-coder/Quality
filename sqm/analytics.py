"""质量指标、供应商评分、统计判异与三层预警。"""
from datetime import date, timedelta

from . import reference as ref
from .stats import binom_sf, upper_count_limit, baseline_rate

LEVEL_ORDER = {"高": 0, "中": 1, "低": 2}


def as_of(db):
    """数据截止日 = 最新检验日期。所有时间窗口都以它为准，保证演示数据随时可复现。"""
    d = db.scalar("SELECT MAX(inspect_date) FROM iqc_lots")
    return date.fromisoformat(d) if d else date.today()


def _ppm(defects, samples):
    return round(defects / samples * 1e6) if samples else 0


def _window(db, start, end, where="", args=()):
    r = db.one(
        "SELECT COUNT(*) lots, SUM(result='拒收') rejected, COALESCE(SUM(sample_size),0) samples, "
        "COALESCE(SUM(defect_qty),0) defects FROM iqc_lots WHERE inspect_date > ? AND inspect_date <= ? " + where,
        (start.isoformat(), end.isoformat()) + tuple(args))
    r["rejected"] = r["rejected"] or 0
    r["ppm"] = _ppm(r["defects"], r["samples"])
    r["reject_rate"] = round(r["rejected"] / r["lots"] * 100, 2) if r["lots"] else 0
    return r


# ---------------------------------------------------------------- 供应商评分
def supplier_scores(db):
    end = as_of(db)
    s90 = end - timedelta(days=90)
    rows = []
    capas = db.all("SELECT supplier_code, status, due_date FROM capa")
    for code, name, cat, region, owner, tier in ref.SUPPLIERS:
        w = _window(db, s90, end, "AND supplier_code=?", (code,))
        recent = _window(db, end - timedelta(days=30), end, "AND supplier_code=?", (code,))
        prior = _window(db, s90, end - timedelta(days=30), "AND supplier_code=?", (code,))
        open_c = [c for c in capas if c["supplier_code"] == code and c["status"] != "已关闭"]
        overdue = [c for c in open_c if c["due_date"] and c["due_date"] < end.isoformat()]
        r = ref.SCORE_RULES
        ppm_pts = r["ppm_weight"] * max(0.0, 1 - w["ppm"] / r["ppm_floor"])
        acc = (1 - w["rejected"] / w["lots"]) if w["lots"] else 1
        acc_pts = r["accept_weight"] * acc
        capa_pts = max(0, r["capa_weight"] - 8 * len(overdue) - 3 * len(open_c))
        score = round(ppm_pts + acc_pts + capa_pts, 1)
        grade = next(g for th, g in ref.GRADES if score >= th)
        rows.append({
            "code": code, "name": name, "category": cat, "region": region, "sqe_owner": owner, "tier": tier,
            "lots_90d": w["lots"], "rejected_90d": w["rejected"], "ppm_90d": w["ppm"],
            "ppm_30d": recent["ppm"], "ppm_prior": prior["ppm"],
            "accept_rate": round(acc * 100, 1), "open_capa": len(open_c), "overdue_capa": len(overdue),
            "score": score, "grade": grade,
            "score_parts": {"ppm": round(ppm_pts, 1), "accept": round(acc_pts, 1), "capa": capa_pts},
        })
    rows.sort(key=lambda x: -x["score"])
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return rows


# ---------------------------------------------------------------- 控制图与判异
def material_analysis(db, mat_code):
    """单物料 p 图：基线期估计 p̄，评估窗口内按二项分布精确尾概率判异。"""
    end = as_of(db)
    split = end - timedelta(days=ref.BASELINE_GAP_DAYS)
    lots = db.all("SELECT id, lot_no, inspect_date, lot_qty, sample_size, defect_qty, result FROM iqc_lots "
                  "WHERE material_code=? ORDER BY inspect_date, id", (mat_code,))
    base = [l for l in lots if l["inspect_date"] <= split.isoformat()]
    p_bar = baseline_rate(sum(l["defect_qty"] for l in base), sum(l["sample_size"] for l in base))
    defects = {}
    for row in db.all("SELECT d.lot_id, d.defect_code, d.qty FROM iqc_defects d JOIN iqc_lots l ON l.id=d.lot_id "
                      "WHERE l.material_code=?", (mat_code,)):
        defects.setdefault(row["lot_id"], {})[row["defect_code"]] = row["qty"]

    points = []
    for l in lots:
        n, x = l["sample_size"], l["defect_qty"]
        c3 = upper_count_limit(n, p_bar, ref.ALPHA_3S)
        c2 = upper_count_limit(n, p_bar, ref.ALPHA_2S)
        c1 = upper_count_limit(n, p_bar, ref.ALPHA_1S)
        points.append({
            "lot_no": l["lot_no"], "date": l["inspect_date"], "n": n, "x": x, "result": l["result"],
            "p": x / n, "ucl": (c3 - 0.5) / n, "u2": (c2 - 0.5) / n,
            "zone": 3 if x >= c3 else 2 if x >= c2 else 1 if x >= c1 else 0,
            "p_value": binom_sf(x, n, p_bar) if x else 1.0,
            "phase": "基线" if l["inspect_date"] <= split.isoformat() else "评估",
            "defects": defects.get(l["id"], {}), "signals": [],
        })

    # 判异规则（只看质量恶化方向）
    ev = [i for i, p in enumerate(points) if p["phase"] == "评估"]
    rules = []
    for i in ev:
        if points[i]["zone"] == 3:
            points[i]["signals"].append("R1")
        win3 = [points[j]["zone"] >= 2 for j in range(max(0, i - 2), i + 1)]
        if len(win3) == 3 and sum(win3) >= 2 and points[i]["zone"] >= 2:
            points[i]["signals"].append("R2")
        win5 = [points[j]["zone"] >= 1 for j in range(max(0, i - 4), i + 1)]
        if len(win5) == 5 and sum(win5) >= 4 and points[i]["zone"] >= 1:
            points[i]["signals"].append("R3")
    r1 = [points[i] for i in ev if "R1" in points[i]["signals"]]
    r2 = [points[i] for i in ev if "R2" in points[i]["signals"]]
    r3 = [points[i] for i in ev if "R3" in points[i]["signals"]]
    if r1:
        rules.append(f"R1 单点超出控制上限（≈3σ）：{len(r1)} 批")
    if r2:
        rules.append(f"R2 连续 3 批中有 2 批超出 2σ 警戒线：{len(r2)} 次")
    if r3:
        rules.append(f"R3 连续 5 批中有 4 批超出 1σ：{len(r3)} 次")

    # 汇总趋势：最近 28 天合并样本与基线比较
    t_start = (end - timedelta(days=ref.TREND_WINDOW_DAYS)).isoformat()
    recent = [p for p in points if p["date"] > t_start]
    rn, rx = sum(p["n"] for p in recent), sum(p["x"] for p in recent)
    trend_p = binom_sf(rx, rn, p_bar) if rx else 1.0
    ratio = (rx / rn) / p_bar if rn and p_bar else 0
    trend = rn > 0 and trend_p < 0.001 and ratio >= 2
    if trend:
        rules.append(f"趋势：近 {ref.TREND_WINDOW_DAYS} 天合并不良率为基线的 {ratio:.1f} 倍（二项检验 p={trend_p:.1e}）")

    signal_pts = [p for p in points if p["signals"]] or (recent if trend else [])
    first_signal = signal_pts[0]["date"] if signal_pts else None
    dom = {}
    for p in signal_pts:
        for k, q in p["defects"].items():
            dom[k] = dom.get(k, 0) + q
    return {
        "material": mat_code, "p_bar": p_bar, "split_date": split.isoformat(), "points": points,
        "rules": rules, "r1": len(r1), "r2": len(r2), "r3": len(r3), "trend": trend,
        "recent": {"lots": len(recent), "samples": rn, "defects": rx, "p": rx / rn if rn else 0,
                   "ratio": round(ratio, 2), "p_value": trend_p},
        "first_signal": first_signal,
        "dominant_defect": max(dom, key=dom.get) if dom else None,
    }


def _stat_level(a):
    if a["r1"] >= 2:
        return "高"
    if a["r1"] or a["r2"] or a["r3"] or (a["trend"] and a["recent"]["ratio"] >= 3):
        return "中"
    return "低"


# ---------------------------------------------------------------- 预警
def _changes_before(db, mat_code, signal_date):
    if not signal_date:
        return []
    d = date.fromisoformat(signal_date)
    lo = (d - timedelta(days=ref.CHANGE_LOOKBACK_DAYS)).isoformat()
    rows = db.all("SELECT * FROM change_events WHERE material_code=? AND event_date>=? AND event_date<=? "
                  "ORDER BY event_date", (mat_code, lo, signal_date))
    for r in rows:
        r["days_before"] = (d - date.fromisoformat(r["event_date"])).days
    return rows


def _risk(alert, analysis, changes, kb_hits, material, supplier):
    """第三层：可解释的加权风险评分（每一项都可追溯到数据，不是黑箱模型）。"""
    f = []
    if analysis:
        f.append(("统计异常强度", min(30, analysis["r1"] * 12 + (8 if analysis["r2"] or analysis["r3"] else 0)
                                + (8 if analysis["trend"] else 0))))
    else:
        f.append(("规则触发", 30 if alert["level"] == "高" else 18))
    sev = ref.DEFECT_CODES.get(alert.get("defect_code") or "", (None, None, "C"))[2]
    f.append((f"缺陷严重度 {sev} 类", {"A": 25, "B": 15, "C": 5}.get(sev, 5)))
    if material and material["critical"]:
        f.append(("关键物料", 10))
    if changes:
        f.append(("异常前存在 4M 变更", 15 + (5 if any(not c["notified"] for c in changes) else 0)))
    same = [h for h in kb_hits if h["supplier_code"] == alert["supplier_code"]
            and h["defect_code"] == alert.get("defect_code")]
    if same:
        f.append(("同供应商同类问题历史复发", 10))
    elif any(h["defect_code"] == alert.get("defect_code") for h in kb_hits):
        f.append(("其他供应商有同类历史案例", 5))
    if supplier and supplier["tier"] in ("战略", "核心"):
        f.append((f"{supplier['tier']}供应商", 5))
    return min(100, sum(v for _, v in f)), [{"factor": k, "points": v} for k, v in f]


def compute_alerts(db, kb, with_detail=False):
    end = as_of(db)
    eval_start = (end - timedelta(days=ref.BASELINE_GAP_DAYS)).isoformat()
    sups = {s["code"]: s for s in db.all("SELECT * FROM suppliers")}
    mats = {m["code"]: m for m in db.all("SELECT * FROM materials")}
    states = {s["alert_key"]: s for s in db.all("SELECT * FROM alert_state")}
    capa_by_alert = {c["alert_key"]: c for c in db.all("SELECT * FROM capa WHERE alert_key IS NOT NULL")}
    alerts = []

    # 一级：规则预警 —— 安全关键缺陷
    for r in db.all(
            "SELECT l.*, d.defect_code, d.qty FROM iqc_lots l JOIN iqc_defects d ON d.lot_id=l.id "
            "JOIN defect_codes c ON c.code=d.defect_code WHERE c.safety=1 AND l.inspect_date>? "
            "ORDER BY l.inspect_date", (eval_start,)):
        alerts.append({
            "key": f"SAFE-{r['lot_no']}", "tier": "规则预警", "level": "高",
            "supplier_code": r["supplier_code"], "material_code": r["material_code"],
            "defect_code": r["defect_code"], "date": r["inspect_date"], "lot_no": r["lot_no"],
            "title": f"安全关键缺陷：{ref.defect_name(r['defect_code'])}",
            "summary": f"批次 {r['lot_no']} 抽检发现 {r['qty']} 件{ref.defect_name(r['defect_code'])}，"
                       f"属于安全关键缺陷，按规则整批拒收并立即通知 SQE。",
            "rules": ["规则：安全关键缺陷（耐压/短路）出现即预警，不设容许数"],
        })
    # 一级：规则预警 —— 8D 逾期
    for c in db.all("SELECT * FROM capa WHERE status!='已关闭' AND due_date < ?", (end.isoformat(),)):
        late = (end - date.fromisoformat(c["due_date"])).days
        alerts.append({
            "key": f"CAPA-{c['capa_no']}", "tier": "规则预警", "level": "高" if late > 14 else "中",
            "supplier_code": c["supplier_code"], "material_code": c["material_code"],
            "defect_code": c["defect_code"], "date": c["due_date"], "capa_no": c["capa_no"],
            "title": f"8D 逾期未关闭：{c['capa_no']}",
            "summary": f"{c['title']}，要求 {c['due_date']} 完成，已逾期 {late} 天，当前停留在“{c['status']}”阶段。",
            "rules": ["规则：8D 超过约定期限未完成即预警；逾期超过 14 天升级为高风险"],
        })

    # 二级：统计预警
    analyses = {}
    for m in mats.values():
        a = material_analysis(db, m["code"])
        analyses[m["code"]] = a
        if not a["rules"]:
            continue
        r = a["recent"]
        alerts.append({
            "key": f"STAT-{m['code']}", "tier": "统计预警", "level": _stat_level(a),
            "supplier_code": m["supplier_code"], "material_code": m["code"],
            "defect_code": a["dominant_defect"], "date": a["first_signal"],
            "title": f"{ref.defect_name(a['dominant_defect']) if a['dominant_defect'] else '不良率'}异常上升",
            "summary": f"近 {ref.TREND_WINDOW_DAYS} 天抽检 {r['lots']} 批、样本 {r['samples']} 件，不良 {r['defects']} 件，"
                       f"不良率 {r['p'] * 100:.2f}%，历史基线 {a['p_bar'] * 100:.2f}%（{r['ratio']:.1f} 倍）。",
            "rules": a["rules"],
            "metrics": {"baseline_p": a["p_bar"], "recent_p": r["p"], "ratio": r["ratio"], "p_value": r["p_value"]},
        })

    # 三层：关联分析 + 风险评分
    for al in alerts:
        sup, mat = sups.get(al["supplier_code"]), mats.get(al["material_code"])
        al["supplier_name"] = sup["name"] if sup else al["supplier_code"]
        al["material_name"] = mat["name"] if mat else al["material_code"]
        al["defect_name"] = ref.defect_name(al["defect_code"]) if al.get("defect_code") else None
        analysis = analyses.get(al["material_code"]) if al["tier"] == "统计预警" else None
        changes = _changes_before(db, al["material_code"], al["date"]) if al["tier"] != "规则预警" or al["key"].startswith("SAFE") else []
        query = f"{al['material_name']} {al['defect_name'] or ''} {al['supplier_name']}"
        hits, _ = kb.search(query, top_k=4)
        al["risk_score"], al["risk_factors"] = _risk(al, analysis, changes, hits, mat, sup)
        al["changes"] = changes
        al["similar_count"] = len(hits)
        st = states.get(al["key"])
        al["status"] = st["status"] if st else "待处理"
        linked = capa_by_alert.get(al["key"])
        al["capa_no"] = al.get("capa_no") or (linked["capa_no"] if linked else None)
        if with_detail:
            al["analysis"] = analysis
            al["similar"] = hits
    alerts.sort(key=lambda a: (a["status"] == "已关闭", LEVEL_ORDER[a["level"]], -a["risk_score"]))
    return alerts


def alert_detail(db, kb, key):
    for a in compute_alerts(db, kb, with_detail=True):
        if a["key"] == key:
            if not a.get("analysis"):
                a["analysis"] = material_analysis(db, a["material_code"])
            a["brief"] = build_brief(db, kb, a)
            return a
    return None


def build_brief(db, kb, a):
    """异常分析简报：数据证据 + 4M 变更 + 历史案例 + 建议，全部由数据和知识库原文拼装。"""
    end = as_of(db)
    L = [f"【异常分析简报】{a['supplier_name']} · {a['material_name']}",
         f"预警类型：{a['tier']}｜等级：{a['level']}｜风险评分：{a['risk_score']}/100｜数据截止：{end}", "",
         "一、异常概述", a["summary"], ""]
    L.append("二、数据证据")
    for r in a["rules"]:
        L.append(f"- {r}")
    an = a.get("analysis")
    if an and a["tier"] == "统计预警":
        for p in [p for p in an["points"] if p["signals"]][:6]:
            dd = "、".join(f"{ref.defect_name(k)}{v}" for k, v in p["defects"].items())
            L.append(f"- {p['date']} 批次 {p['lot_no']}：{p['x']}/{p['n']} 不良（{dd}），"
                     f"二项尾概率 {p['p_value']:.1e}，判异 {'/'.join(p['signals'])}")
    L.append("")
    L.append("三、关联变更（4M）")
    if a["changes"]:
        for c in a["changes"]:
            note = "" if c["notified"] else "【未按 PCN 提前通知】"
            L.append(f"- {c['event_date']} {c['kind']}：{c['description']}{note}（首个异常前 {c['days_before']} 天）")
    else:
        L.append("- 系统中未记录异常前 30 天内的 4M 变更，建议向供应商确认是否存在未申报变更。")
    L.append("")
    L.append("四、历史相似案例（知识库检索）")
    groups = kb.evidence(a.get("similar") or [], max_docs=3)
    for n, h in enumerate((a.get("similar") or [])[:3], 1):
        L.append(f"- [{n}] {h['doc_no']} {h['title']}")
    if not a.get("similar"):
        L.append("- 未检索到相似案例。")
    L.append("")
    L.append("五、建议排查方向（来自历史案例原文，需现场验证）")
    causes = next((g for g in groups if g["key"] == "cause"), None)
    if causes:
        for it in causes["items"][:4]:
            L.append(f"- {it['text']} [{it['ref']}]")
    else:
        L.append("- 按人、机、料、法、环、测逐项排查，重点核对异常前后的变更点。")
    L.append("")
    L.append("六、建议围堵措施")
    L.append("- 隔离在库及在途批次，对后续来料加严检验（抽样升级或全检）。")
    if a["level"] == "高":
        L.append("- 通知供应商 24 小时内回复围堵措施，7 天内提交根因分析（依据 SOP-SQE-005）。")
    if a.get("defect_code") and ref.DEFECT_CODES.get(a["defect_code"], ("", "", "", False))[3]:
        L.append("- 安全关键缺陷：追溯同批次已上线产品，评估是否需要对成品进行耐压复测。")
    L.append("")
    L.append("七、需责任人确认")
    L.append("- 停线、批次放行、特采与责任判定，按企业授权和质量流程由责任人审批；本简报不构成结论。")
    return "\n".join(L)


# ---------------------------------------------------------------- 驾驶舱
def dashboard(db, kb):
    end = as_of(db)
    cur = _window(db, end - timedelta(days=30), end)
    prev = _window(db, end - timedelta(days=60), end - timedelta(days=30))
    weeks = []
    monday = end - timedelta(days=end.weekday())
    for i in range(25, -1, -1):
        ws = monday - timedelta(days=7 * i)
        w = _window(db, ws - timedelta(days=1), ws + timedelta(days=6))
        weeks.append({"week": ws.isoformat(), "ppm": w["ppm"], "lots": w["lots"], "rejected": w["rejected"]})
    s90 = (end - timedelta(days=90)).isoformat()
    pareto = db.all("SELECT d.defect_code code, SUM(d.qty) qty FROM iqc_defects d JOIN iqc_lots l ON l.id=d.lot_id "
                    "WHERE l.inspect_date > ? GROUP BY d.defect_code ORDER BY qty DESC", (s90,))
    total = sum(p["qty"] for p in pareto) or 1
    acc = 0
    for p in pareto:
        acc += p["qty"]
        p["name"] = ref.defect_name(p["code"])
        p["cum_pct"] = round(acc / total * 100, 1)
    alerts = compute_alerts(db, kb)
    open_alerts = [a for a in alerts if a["status"] != "已关闭"]
    capa = db.all("SELECT status, due_date FROM capa")
    return {
        "as_of": end.isoformat(), "kpi": {"current": cur, "previous": prev, "ppm_target": ref.PPM_TARGET},
        "weekly": weeks, "pareto": pareto, "ranking": supplier_scores(db),
        "alerts": {"total": len(open_alerts), "high": sum(a["level"] == "高" for a in open_alerts),
                   "medium": sum(a["level"] == "中" for a in open_alerts),
                   "low": sum(a["level"] == "低" for a in open_alerts), "top": open_alerts[:5]},
        "capa": {"open": sum(c["status"] != "已关闭" for c in capa),
                 "overdue": sum(c["status"] != "已关闭" and c["due_date"] < end.isoformat() for c in capa)},
    }


def supplier_detail(db, kb, code):
    sup = db.one("SELECT * FROM suppliers WHERE code=?", (code,))
    if not sup:
        return None
    score = next(s for s in supplier_scores(db) if s["code"] == code)
    mats = db.all("SELECT * FROM materials WHERE supplier_code=?", (code,))
    charts = []
    for m in mats:
        a = material_analysis(db, m["code"])
        charts.append({"material": m, "analysis": a})
    lots = db.all("SELECT * FROM iqc_lots WHERE supplier_code=? ORDER BY inspect_date DESC, id DESC LIMIT 40", (code,))
    ids = [l["id"] for l in lots]
    dmap = {}
    if ids:
        for r in db.all(f"SELECT * FROM iqc_defects WHERE lot_id IN ({','.join('?' * len(ids))})", ids):
            dmap.setdefault(r["lot_id"], []).append(f"{ref.defect_name(r['defect_code'])}×{r['qty']}")
    for l in lots:
        l["defects"] = "、".join(dmap.get(l["id"], []))
    return {
        "supplier": sup, "score": score, "charts": charts, "lots": lots,
        "changes": db.all("SELECT * FROM change_events WHERE supplier_code=? ORDER BY event_date DESC", (code,)),
        "capa": db.all("SELECT * FROM capa WHERE supplier_code=? ORDER BY created_at DESC", (code,)),
        "alerts": [a for a in compute_alerts(db, kb) if a["supplier_code"] == code],
        "docs": [d for d in kb.list_docs() if d["supplier_code"] == code],
    }
