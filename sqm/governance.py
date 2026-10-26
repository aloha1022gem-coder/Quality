"""质量数据治理：导入校验、编码标准化、缺陷名称映射、数据健康检查。"""
import csv
import io
import re
from datetime import date, timedelta

from . import reference as ref

FIELDS = [
    ("lot_no", "批次号"), ("supplier_code", "供应商编码"), ("material_code", "物料编码"),
    ("inspect_date", "检验日期"), ("lot_qty", "批量"), ("sample_size", "抽样数"),
    ("defect_qty", "不良数"), ("defect_desc", "缺陷描述"), ("inspector", "检验员"),
]
HEADER_MAP = {}
for key, cn in FIELDS:
    HEADER_MAP[key] = key
    HEADER_MAP[cn] = key
REQUIRED = ["lot_no", "supplier_code", "material_code", "inspect_date", "sample_size", "defect_qty"]

METRICS = [
    {"name": "抽样不良率", "formula": "不良品数 ÷ 实际抽检数 × 100%",
     "note": "分子是不良品件数，不是缺陷个数；一件产品有两处缺陷只计 1 件。"},
    {"name": "抽样 PPM", "formula": "不良品数 ÷ 实际抽检数 × 1,000,000",
     "note": "反映抽样结果，不等于整批真实不良率；推断整批需考虑抽样方案和置信区间。"},
    {"name": "批次合格率", "formula": "判定合格批数 ÷ 检验批数 × 100%",
     "note": "特采批次计为不合格批；退货重检的批次按首次判定统计。"},
    {"name": "拒收判定", "formula": "不良数 > Ac（GB/T 2828.1，一般检验水平 II，AQL 0.65）",
     "note": "安全关键缺陷（耐压、短路）出现即拒收，不适用 Ac。"},
    {"name": "供应商质量评分", "formula": "PPM 得分 50 + 批次合格率得分 30 + 8D 响应得分 20",
     "note": "PPM 得分 = 50 × max(0, 1 − PPM/20000)；8D 得分 = 20 − 8×逾期数 − 3×未关闭数。"},
]


def _norm_date(s):
    s = s.strip()
    for pat, fixed in ((r"^(\d{4})-(\d{1,2})-(\d{1,2})$", False), (r"^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$", True),
                       (r"^(\d{4})(\d{2})(\d{2})$", True)):
        m = re.match(pat, s)
        if m:
            try:
                d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                return None, False
            return d, fixed or len(s) != 10
    return None, False


def _norm_int(s):
    """返回 (数值, 是否修正, 错误信息)"""
    raw = s.strip()
    if "%" in raw:
        return None, False, "单位混用：应填写件数，不能填写百分比"
    cleaned = re.sub(r"(pcs|PCS|件|个|,|，|\s)", "", raw)
    if not re.fullmatch(r"-?\d+(\.0+)?", cleaned):
        return None, False, f"不是有效数字：{raw}"
    v = int(float(cleaned))
    if v < 0:
        return None, False, "不能为负数"
    return v, cleaned != raw, None


def parse_csv(text):
    text = text.lstrip("﻿")
    reader = csv.reader(io.StringIO(text))
    rows = [r for r in reader if any(c.strip() for c in r)]
    if not rows:
        return [], []
    header = [HEADER_MAP.get(h.strip(), h.strip()) for h in rows[0]]
    out = []
    for r in rows[1:]:
        r = r + [""] * (len(header) - len(r))
        out.append({header[i]: r[i].strip() for i in range(len(header))})
    missing_cols = [cn for key, cn in FIELDS if key in REQUIRED and key not in header]
    return out, missing_cols


def validate(db, text):
    rows, missing_cols = parse_csv(text)
    sup_codes = {s["code"]: s for s in db.all("SELECT * FROM suppliers")}
    sup_names = {s["name"]: s["code"] for s in sup_codes.values()}
    mats = {m["code"]: m for m in db.all("SELECT * FROM materials")}
    existing = {r["lot_no"] for r in db.all("SELECT lot_no FROM iqc_lots")}
    alias = ref.build_alias_map()
    today = date.today()
    seen = set()
    results = []
    dims = {"完整性": 0, "唯一性": 0, "一致性": 0, "有效性": 0}

    for idx, row in enumerate(rows, 2):
        issues = []
        clean = {k: row.get(k, "") for k, _ in FIELDS}
        bad = set()

        def add(level, field, msg, dim):
            issues.append({"level": level, "field": dict(FIELDS).get(field, field), "msg": msg})
            if level == "error":
                bad.add(dim)

        for f in REQUIRED:
            if not clean[f]:
                add("error", f, "必填项缺失", "完整性")
        lot = clean["lot_no"]
        if lot:
            if lot in seen:
                add("error", "lot_no", "文件内重复批次", "唯一性")
            elif lot in existing:
                add("error", "lot_no", "系统中已存在该批次", "唯一性")
            seen.add(lot)

        sc = clean["supplier_code"]
        if sc:
            if sc.upper() in sup_codes and sc != sc.upper():
                add("fixed", "supplier_code", f"编码大小写统一：{sc} → {sc.upper()}", "一致性")
                sc = sc.upper()
            elif sc in sup_names:
                add("fixed", "supplier_code", f"名称转编码：{sc} → {sup_names[sc]}", "一致性")
                sc = sup_names[sc]
            elif sc not in sup_codes:
                add("error", "supplier_code", f"供应商编码不存在：{sc}", "一致性")
            clean["supplier_code"] = sc
        mc = clean["material_code"].upper()
        if mc:
            if mc not in mats:
                add("error", "material_code", f"物料编码不存在：{clean['material_code']}", "一致性")
            elif sc in sup_codes and mats[mc]["supplier_code"] != sc:
                add("error", "material_code", f"物料 {mc} 不属于供应商 {sc}", "一致性")
            clean["material_code"] = mc

        if clean["inspect_date"]:
            d, fixed = _norm_date(clean["inspect_date"])
            if not d:
                add("error", "inspect_date", f"日期无法识别：{clean['inspect_date']}", "有效性")
            elif d > today + timedelta(days=1):
                add("error", "inspect_date", f"检验日期晚于今天：{d}", "有效性")
            else:
                if fixed:
                    add("fixed", "inspect_date", f"日期格式统一：{clean['inspect_date']} → {d}", "有效性")
                clean["inspect_date"] = d.isoformat()

        nums = {}
        for f in ("lot_qty", "sample_size", "defect_qty"):
            if clean[f]:
                v, fixed, err = _norm_int(clean[f])
                if err:
                    add("error", f, err, "有效性")
                else:
                    if fixed:
                        add("fixed", f, f"去除单位/分隔符：{clean[f]} → {v}", "有效性")
                    nums[f] = v
                    clean[f] = v
        if "sample_size" in nums and "defect_qty" in nums and nums["defect_qty"] > nums["sample_size"]:
            add("error", "defect_qty", "不良数大于抽样数（可能把缺陷个数当成了不良品数）", "有效性")
        if "lot_qty" in nums and "sample_size" in nums:
            if nums["sample_size"] > nums["lot_qty"]:
                add("error", "sample_size", "抽样数大于批量", "有效性")
            else:
                n, _ = ref.sampling_for(nums["lot_qty"])
                if n != nums["sample_size"]:
                    add("warn", "sample_size", f"与抽样方案不一致：批量 {nums['lot_qty']} 应抽 {n}", "有效性")

        desc = clean["defect_desc"]
        clean["defect_code"] = None
        if nums.get("defect_qty"):
            if not desc:
                add("error", "defect_desc", "有不良但缺少缺陷描述", "完整性")
            else:
                code = alias.get(desc.lower())
                if code:
                    if desc != ref.defect_name(code):
                        add("fixed", "defect_desc", f"缺陷名称标准化：{desc} → {code} {ref.defect_name(code)}", "一致性")
                    clean["defect_code"] = code
                elif desc in ref.AMBIGUOUS_TERMS:
                    add("confirm", "defect_desc", f"“{desc}”过于笼统，需人工确认具体缺陷类别", "一致性")
                else:
                    add("confirm", "defect_desc", f"未收录的缺陷描述“{desc}”，需维护到缺陷代码库", "一致性")

        levels = {i["level"] for i in issues}
        status = ("错误" if "error" in levels else "待确认" if "confirm" in levels
                  else "已修正" if "fixed" in levels else "通过")
        for k in dims:
            if k not in bad:
                dims[k] += 1
        results.append({"line": idx, "status": status, "issues": issues, "clean": clean,
                        "importable": status in ("通过", "已修正")})

    total = len(results)
    summary = {s: sum(r["status"] == s for r in results) for s in ("通过", "已修正", "待确认", "错误")}
    return {
        "total": total, "summary": summary, "missing_columns": missing_cols,
        "importable": sum(r["importable"] for r in results),
        "quality_score": round(sum(r["importable"] for r in results) / total * 100, 1) if total else 0,
        "dimensions": {k: round(v / total * 100, 1) if total else 0 for k, v in dims.items()},
        "rows": results,
    }


def import_rows(db, text, inspector_default="导入"):
    report = validate(db, text)
    inserted = 0
    for r in report["rows"]:
        if not r["importable"]:
            continue
        c = r["clean"]
        lot_qty = c["lot_qty"] if isinstance(c["lot_qty"], int) else c["sample_size"]
        _, ac = ref.sampling_for(lot_qty)
        safety = c["defect_code"] and ref.DEFECT_CODES[c["defect_code"]][3]
        result = "拒收" if (safety or c["defect_qty"] > ac) else "合格"
        lot_id = db.execute(
            "INSERT INTO iqc_lots(lot_no,supplier_code,material_code,inspect_date,lot_qty,sample_size,defect_qty,"
            "result,inspector,source) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (c["lot_no"], c["supplier_code"], c["material_code"], c["inspect_date"], lot_qty,
             c["sample_size"], c["defect_qty"], result, c["inspector"] or inspector_default, "CSV导入"))
        if c["defect_code"] and c["defect_qty"]:
            db.execute("INSERT INTO iqc_defects VALUES (?,?,?)", (lot_id, c["defect_code"], c["defect_qty"]))
        inserted += 1
    report["inserted"] = inserted
    return report


def sample_csv(db):
    """生成一份带典型数据问题的导入样例（日期相对数据截止日）。"""
    end = date.fromisoformat(db.scalar("SELECT MAX(inspect_date) FROM iqc_lots") or date.today().isoformat())
    d = lambda n: end - timedelta(days=n)
    dup = db.scalar("SELECT lot_no FROM iqc_lots ORDER BY id DESC LIMIT 1") or "HSG000000-01"
    rows = [
        ["批次号", "供应商编码", "物料编码", "检验日期", "批量", "抽样数", "不良数", "缺陷描述", "检验员"],
        [f"IMP{d(3):%y%m%d}-01", "S04", "M-STP-01", d(3).isoformat(), "5000", "200", "0", "", "张敏"],
        [f"IMP{d(3):%y%m%d}-02", "s01", "M-HSG-02", d(3).strftime("%Y/%m/%d"), "3000", "125", "1", "表面划伤", "刘洋"],
        [f"IMP{d(2):%y%m%d}-03", "华辰塑胶", "M-HSG-01", d(2).strftime("%Y%m%d"), "4000", "200", "2", "Scratch", "赵婷"],
        [f"IMP{d(2):%y%m%d}-04", "S06", "M-PKG-01", d(2).isoformat(), "6000", "200pcs", "1", "外箱破损", "孙浩"],
        [f"IMP{d(2):%y%m%d}-05", "S05", "M-MOT-01", d(2).isoformat(), "2000", "125", "1", "外观不良", "张敏"],
        [f"IMP{d(1):%y%m%d}-06", "S08", "M-SEL-01", d(1).isoformat(), "5000", "200", "1.5%", "尺寸不良", "刘洋"],
        [f"IMP{d(1):%y%m%d}-07", "S03", "M-PCB-01", d(1).isoformat(), "3000", "125", "130", "冷焊", "赵婷"],
        [f"IMP{d(1):%y%m%d}-07", "S03", "M-PCB-02", d(1).isoformat(), "3000", "125", "0", "", "赵婷"],
        [dup, "S01", "M-HSG-01", d(1).isoformat(), "4000", "200", "0", "", "孙浩"],
        [f"IMP{d(1):%y%m%d}-09", "S11", "M-XXX-01", d(1).isoformat(), "2000", "125", "0", "", "张敏"],
        [f"IMP{d(1):%y%m%d}-10", "S02", "M-PCB-01", d(1).isoformat(), "2000", "125", "0", "", "刘洋"],
        [f"IMP{d(0):%y%m%d}-11", "S09", "M-DSP-01", "2026-13-40", "2500", "125", "0", "", "赵婷"],
        [f"IMP{d(0):%y%m%d}-12", "S10", "M-SNS-01", d(0).isoformat(), "3000", "", "0", "", "孙浩"],
        [f"IMP{d(0):%y%m%d}-13", "S07", "M-WIR-01", d(0).isoformat(), "4000", "200", "1", "线皮发白", "张敏"],
        [f"IMP{d(0):%y%m%d}-14", "S02", "M-FLT-01", d(0).isoformat(), "2000", "125", "2", "异味超标", "刘洋"],
        [f"IMP{d(0):%y%m%d}-15", "S09", "M-DSP-01", d(0).isoformat(), "2500", "80", "0", "", "赵婷"],
    ]
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\n").writerows(rows)
    return buf.getvalue()


def health(db):
    """对系统现有数据做治理检查。"""
    end = db.scalar("SELECT MAX(inspect_date) FROM iqc_lots") or date.today().isoformat()
    s30 = (date.fromisoformat(end) - timedelta(days=30)).isoformat()
    checks = [
        ("批次缺陷明细与不良数一致",
         "SELECT COUNT(*) FROM iqc_lots l WHERE l.defect_qty != COALESCE((SELECT SUM(qty) FROM iqc_defects d WHERE d.lot_id=l.id),0)"),
        ("不良数不大于抽样数", "SELECT COUNT(*) FROM iqc_lots WHERE defect_qty > sample_size"),
        ("抽样数不大于批量", "SELECT COUNT(*) FROM iqc_lots WHERE sample_size > lot_qty"),
        ("缺陷均使用标准代码",
         "SELECT COUNT(*) FROM iqc_defects WHERE defect_code NOT IN (SELECT code FROM defect_codes)"),
        ("物料与供应商关系一致",
         "SELECT COUNT(*) FROM iqc_lots l JOIN materials m ON m.code=l.material_code WHERE m.supplier_code != l.supplier_code"),
        ("近 30 天每个物料都有检验记录",
         f"SELECT COUNT(*) FROM materials m WHERE NOT EXISTS (SELECT 1 FROM iqc_lots l WHERE l.material_code=m.code AND l.inspect_date > '{s30}')"),
        ("4M 变更均按 PCN 提前通知", "SELECT COUNT(*) FROM change_events WHERE notified=0"),
    ]
    out = []
    for name, sql in checks:
        n = db.scalar(sql)
        out.append({"check": name, "violations": n, "ok": n == 0})
    return {
        "checks": out,
        "totals": {
            "lots": db.scalar("SELECT COUNT(*) FROM iqc_lots"),
            "imported": db.scalar("SELECT COUNT(*) FROM iqc_lots WHERE source='CSV导入'"),
            "defect_codes": db.scalar("SELECT COUNT(*) FROM defect_codes"),
            "aliases": db.scalar("SELECT COUNT(*) FROM defect_aliases"),
        },
    }


def dictionary():
    return {
        "defects": [{"code": c, "name": v[0], "category": v[1], "severity": v[2], "safety": v[3], "aliases": v[4]}
                    for c, v in ref.DEFECT_CODES.items()],
        "ambiguous": ref.AMBIGUOUS_TERMS, "metrics": METRICS,
    }


def export_lots_csv(db):
    rows = db.all(
        "SELECT l.lot_no, l.supplier_code, s.name supplier_name, l.material_code, m.name material_name, l.inspect_date,"
        " l.lot_qty, l.sample_size, l.defect_qty, l.result, l.inspector, l.source,"
        " (SELECT GROUP_CONCAT(d.defect_code || ':' || d.qty, ';') FROM iqc_defects d WHERE d.lot_id=l.id) defects"
        " FROM iqc_lots l JOIN suppliers s ON s.code=l.supplier_code JOIN materials m ON m.code=l.material_code"
        " ORDER BY l.inspect_date, l.id")
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["批次号", "供应商编码", "供应商", "物料编码", "物料", "检验日期", "批量", "抽样数", "不良数",
                "判定", "检验员", "来源", "缺陷明细"])
    for r in rows:
        w.writerow(list(r.values()))
    return "﻿" + buf.getvalue()
