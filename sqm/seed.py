"""生成演示数据：10 家模拟供应商、约 26 周 IQC 批次、4M 变更、8D/CAPA 与知识库。

所有数据为模拟数据，固定随机种子，便于复现。
"""
import os
import random
from datetime import date, timedelta

from . import reference as ref
from .db import ROOT

KB_DIR = os.path.join(ROOT, "knowledge_base")

INSPECTORS = ["张敏", "刘洋", "赵婷", "孙浩"]

LOT_QTY = {
    "default": [2000, 2500, 3000, 4000, 5000, 6000, 8000],
    "M-FLT-01": [1500, 2000, 2500, 3000],
    "M-DSP-01": [1500, 2000, 2500, 3000],
    "M-SNS-01": [2000, 3000, 4000],
}

# 重点异常情境：从“截止日前 start 天”起，按批次顺序注入指定缺陷数
SCENARIOS = {
    "M-HSG-01": {"start": 26, "defect": "D01", "counts": [3, 6, 5, 8, 7, 9, 8, 10]},
    "M-FLT-01": {"start": 20, "defect": "D05", "counts": [2, 4, 6, 5, 7, 8]},
    "M-PCB-01": {"start": 16, "defect": "D06", "counts": [3, 5, 8, 7, 9]},
    "M-DSP-01": {"start": 19, "defect": "D09", "counts": [2, 2, 3, 2, 2, 3]},
}

# 一次性事件：(物料, 截止日前天数, 缺陷, 数量)
SPOT_DEFECTS = [
    ("M-WIR-01", 6, "D14", 1),    # 线束耐压不良：安全关键缺陷
    ("M-SEL-01", 48, "D04", 5),   # 密封圈尺寸超差：已发起 8D
    ("M-PKG-01", 46, "D13", 6),   # 彩盒色差：已发起 8D
]

# 4M 变更：(供应商, 物料, 截止日前天数, 类别, 描述, 是否按 PCN 提前通知)
CHANGES = [
    ("S01", "M-HSG-01", 29, "机", "前壳模具 T2 新模投产，旧模退役；取件机械手同步更换夹爪", 1),
    ("S02", "M-FLT-01", 27, "料", "活性炭层热熔胶更换为新供应商型号（未走 PCN 流程，审核时发现）", 0),
    ("S03", "M-PCB-01", 18, "法", "导入新型号无铅锡膏，回流焊温度曲线随之调整", 1),
    ("S09", "M-DSP-01", 22, "人", "模组组装线扩线，新增 6 名操作员上岗", 1),
    ("S04", "M-STP-01", 95, "环", "冲压车间整体搬迁至新厂房", 1),
    ("S06", "M-PKG-01", 62, "料", "瓦楞纸板供应商变更", 1),
    ("S10", "M-SNS-01", 44, "法", "传感器出厂校准程序固件升级 V2.3", 1),
    ("S07", "M-WIR-01", 12, "机", "压接机更换刀具（例行保养）", 1),
]


def _weighted(rng, mix):
    total = sum(mix.values())
    r = rng.random() * total
    for k, w in mix.items():
        r -= w
        if r <= 0:
            return k
    return k


def _binomial(rng, n, p):
    return sum(1 for _ in range(n) if rng.random() < p)


def parse_front_matter(text):
    meta, body = {}, text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end > 0:
            for line in text[3:end].strip().splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip()
            body = text[end + 4:].lstrip("\n")
    return meta, body


def load_kb_files(db, kb_dir=KB_DIR):
    count = 0
    if not os.path.isdir(kb_dir):
        return 0
    for fn in sorted(os.listdir(kb_dir)):
        if not fn.lower().endswith((".md", ".txt")):
            continue
        with open(os.path.join(kb_dir, fn), encoding="utf-8") as f:
            meta, body = parse_front_matter(f.read())
        doc_no = meta.get("doc_no") or os.path.splitext(fn)[0]
        db.execute(
            "INSERT OR REPLACE INTO kb_docs(doc_no,title,doc_type,supplier_code,material_code,"
            "defect_code,doc_date,content,source) VALUES (?,?,?,?,?,?,?,?,?)",
            (doc_no, meta.get("title", doc_no), meta.get("type", "其他"), meta.get("supplier") or None,
             meta.get("material") or None, meta.get("defect") or None, meta.get("date"), body, "内置知识库"))
        count += 1
    return count


def seed(db, end=None, seed_value=20261026):
    end = end or date.today()
    rng = random.Random(seed_value)
    db.reset()

    db.executemany("INSERT INTO suppliers VALUES (?,?,?,?,?,?)", ref.SUPPLIERS)
    db.executemany("INSERT INTO materials VALUES (?,?,?,?)",
                   [(m[0], m[1], m[2], m[3]) for m in ref.MATERIALS])
    db.executemany("INSERT INTO defect_codes VALUES (?,?,?,?,?)",
                   [(c, v[0], v[1], v[2], int(v[3])) for c, v in ref.DEFECT_CODES.items()])
    db.executemany("INSERT OR REPLACE INTO defect_aliases VALUES (?,?)",
                   [(a, c) for a, c in ref.build_alias_map().items()])

    start = end - timedelta(days=181)
    spot = {(m, d): (code, q) for m, d, code, q in SPOT_DEFECTS}
    for mat_code, _name, sup, _crit, base_p, mix in ref.MATERIALS:
        scen = SCENARIOS.get(mat_code)
        scen_idx = 0
        days = []
        for w in range(27):
            for off in (rng.choice([0, 1]), 3 + rng.choice([0, 1])):
                d = start + timedelta(days=w * 7 + off)
                if d <= end:
                    days.append(d)
        spot_hits = {}
        for (m, back), v in spot.items():
            if m == mat_code:
                target = end - timedelta(days=back)
                nearest = min(days, key=lambda x: abs((x - target).days))
                spot_hits[nearest] = v
        for seq, d in enumerate(days, 1):
            qty = rng.choice(LOT_QTY.get(mat_code, LOT_QTY["default"]))
            n, ac = ref.sampling_for(qty)
            defects = {}
            for _ in range(_binomial(rng, n, base_p)):
                k = _weighted(rng, mix)
                defects[k] = defects.get(k, 0) + 1
            if scen and (end - d).days <= scen["start"]:
                c = scen["counts"][min(scen_idx, len(scen["counts"]) - 1)]
                scen_idx += 1
                defects = {scen["defect"]: c}  # 情境批次只保留设计的缺陷数，保证演示结果可复现
            if d in spot_hits:
                code, q = spot_hits[d]
                defects[code] = defects.get(code, 0) + q
            total = sum(defects.values())
            safety = any(ref.DEFECT_CODES[k][3] for k in defects)
            result = "拒收" if (safety or total > ac) else "合格"
            lot_no = f"{mat_code[2:5]}{mat_code[-1]}-{d:%y%m%d}-{seq:02d}"
            lot_id = db.execute(
                "INSERT INTO iqc_lots(lot_no,supplier_code,material_code,inspect_date,lot_qty,"
                "sample_size,defect_qty,result,inspector,source) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (lot_no, sup, mat_code, d.isoformat(), qty, n, total, result,
                 rng.choice(INSPECTORS), "系统"))
            for k, q in defects.items():
                db.execute("INSERT INTO iqc_defects VALUES (?,?,?)", (lot_id, k, q))

    for sup, mat, back, kind, desc, notified in CHANGES:
        db.execute("INSERT INTO change_events(supplier_code,material_code,event_date,kind,description,notified)"
                   " VALUES (?,?,?,?,?,?)",
                   (sup, mat, (end - timedelta(days=back)).isoformat(), kind, desc, notified))

    def ago(n):
        return (end - timedelta(days=n)).isoformat()

    capas = [
        ("8D-2026-005", "风道支架冲压毛刺超标", "S04", "M-STP-01", "D10", "陈工", ago(52), "已关闭",
         "风道支架边缘毛刺高度 0.15–0.25 mm，超出图纸 ≤0.1 mm 要求，装配时划伤线束。",
         "库存 3 批全检挑选，在途批次加严检验。",
         "冲裁间隙因凸模磨损增大至 12%t，刃口维护周期未按冲次管理。",
         "刃口按 3 万冲次强制修磨；首件增加毛刺高度测量；控制计划更新。",
         "连续 12 批毛刺高度 ≤0.08 mm，IQC 零不良。", ago(80), ago(50)),
        ("8D-2026-008", "彩盒印刷色差", "S06", "M-PKG-01", "D13", "李工", ago(-6), "效果验证",
         "彩盒主色 ΔE 2.8，超出 ≤1.5 的色差标准，客户抽检提出。",
         "已到货批次按标准色卡挑选，不合格品退货。",
         "更换瓦楞纸板后纸面吸墨性变化，印刷未重新调色确认。",
         "纸板变更纳入 PCN；每批首件用色差仪测 ΔE 并留存记录。", "", ago(44), None),
        ("8D-2026-011", "密封圈内径尺寸偏小", "S08", "M-SEL-01", "D04", "陈工", ago(10), "根因分析",
         "密封圈内径实测 Φ47.62–47.70，规格 Φ48.0±0.2，装配困难。",
         "库存隔离，安排全检；供应商在制品暂停发货。", "", "", "", ago(46), None),
    ]
    for c in capas:
        db.execute(
            "INSERT INTO capa(capa_no,title,supplier_code,material_code,defect_code,owner,due_date,status,"
            "problem,containment,root_cause,corrective_action,verification,created_at,closed_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", c)

    n_docs = load_kb_files(db)
    db.execute("INSERT OR REPLACE INTO meta VALUES ('seeded_at', ?)", (end.isoformat(),))
    return {"kb_docs": n_docs, "lots": db.scalar("SELECT COUNT(*) FROM iqc_lots")}
