"""生成售后故障演示数据：8 个型号、33 个月批次、出货与逐台模拟的报修记录、改善措施。

每台产品按若干失效机理（Weibull 分布）抽取寿命，在截止日前发生的才成为报修记录，
因此批次故障率、寿命分析都能从数据里“算回”设定的情境。所有数据为模拟数据，固定随机种子。
"""
import math
import random
from datetime import date, timedelta

from . import reference as ref

N_MONTHS = 33

# 失效机理：(部位代码, β, η 月, 故障现象权重)；η 可按“生产月距截止月的月数”分段覆盖
#   overrides: [(off_lo, off_hi, eta)]，off = 1 表示截止日的上一个月
SENSOR_A = [(1, 15, 210)]   # 2025-07 起（截止 2026-10 时）改用 IR-300 感应模块
MECHANISMS = {
    "SF-101": [("P01", 2.2, 80, {"F02": 6, "F01": 4}, SENSOR_A),
               ("P02", 1.0, 6000, {"F04": 7, "F05": 3}, []),
               ("P03", 1.0, 8000, {"F01": 5, "F03": 5}, []),
               ("P04", 1.3, 3000, {"F01": 1}, []),
               ("P06", 1.5, 1800, {"F05": 1}, []),
               ("P07", 1.2, 6000, {"F07": 1}, []),
               ("P08", 0.5, 5e6, {"F06": 1}, [])],
    "SF-102": [("P01", 2.2, 90, {"F02": 6, "F01": 4}, [(1, 15, 220)]),
               ("P02", 1.0, 6000, {"F04": 7, "F05": 3}, []),
               ("P03", 1.0, 8000, {"F01": 5, "F03": 5}, []),
               ("P04", 1.3, 3000, {"F01": 1}, []),
               ("P06", 1.5, 1800, {"F05": 1}, []),
               ("P08", 0.5, 4e6, {"F06": 1}, [])],
    "SF-201": [("P01", 2.2, 150, {"F02": 6, "F01": 4}, []),
               ("P02", 1.0, 6000, {"F04": 7, "F05": 3}, []),
               ("P02", 0.8, 1e12, {"F04": 8, "F05": 2}, [(9, 11, 800)]),  # 电磁阀临时切换二供的 3 个批次
               ("P03", 1.0, 8000, {"F01": 5, "F03": 5}, []),
               ("P04", 1.3, 3000, {"F01": 1}, []),
               ("P06", 1.5, 1800, {"F05": 1}, []),
               ("P08", 0.5, 5e6, {"F06": 1}, [])],
    "MF-301": [("P05", 1.8, 420, {"F04": 6, "F06": 4}, []),
               ("P09", 1.5, 900, {"F08": 1}, []),
               ("P07", 1.2, 2500, {"F07": 1}, []),
               ("P06", 1.5, 1500, {"F05": 1}, []),
               ("P08", 0.5, 2e6, {"F06": 1}, [])],
    "GD-550": [("P21", 2.6, 210, {"F21": 4, "F24": 6}, []),
               ("P22", 1.3, 1500, {"F23": 1}, [(5, 19, 350)]),       # 密封圈新模具批次
               ("P23", 1.0, 6000, {"F21": 1}, []),
               ("P24", 2.0, 600, {"F22": 1}, []),
               ("P25", 1.0, 6000, {"F22": 1}, []),
               ("P26", 0.5, 3e6, {"F23": 1}, [])],
    "GD-750": [("P21", 2.6, 240, {"F21": 4, "F24": 6}, []),
               ("P22", 1.3, 1500, {"F23": 1}, [(5, 19, 350)]),
               ("P23", 1.0, 6000, {"F21": 1}, []),
               ("P24", 2.0, 650, {"F22": 1}, []),
               ("P25", 1.0, 6000, {"F22": 1}, []),
               ("P26", 0.5, 3e6, {"F23": 1}, [])],
    "SK-680": [("P41", 0.9, 12000, {"F41": 1}, []),
               ("P42", 0.6, 4e5, {"F42": 5, "F43": 5}, []),
               ("P43", 0.4, 3e7, {"F42": 7, "F44": 3}, []),
               ("P44", 1.5, 2500, {"F43": 1}, [])],
    "SK-820": [("P41", 0.9, 10000, {"F41": 1}, []),
               ("P42", 0.6, 4e5, {"F42": 5, "F43": 5}, []),
               ("P43", 0.4, 2e7, {"F42": 7, "F44": 3}, []),
               ("P44", 1.5, 2500, {"F43": 1}, [])],
}


# 关键元器件料号：(部件, 默认料号, [(off_lo, off_hi, 料号)])
COMPONENTS = {
    "感应模块": ("IR-200 光感电子", {"SF-101": [(1, 15, "IR-300 光感电子（自动增益补偿）")],
                                "SF-102": [(1, 15, "IR-300 光感电子（自动增益补偿）")],
                                "SF-201": [(1, 99, "IR-210 远辰光电")]}),
    "电磁阀": ("DV-12 华通阀门", {"SF-201": [(9, 11, "DV-12B 永固电磁阀（二供）")]}),
    "PCBA": ("CB-05 恒泰贴片", {"SF-201": [(1, 99, "CB-06 台州鑫电")]}),
    "电池盒": ("BX-4AA 通用", {}),
    "阀芯": ("35mm 陶瓷阀芯 万利", {}),
    "抽拉软管": ("PH-15 宏塑", {}),
    "电机": ("DCM 系列 股东方电机厂", {}),
    "密封圈": ("SR-90 凯达橡胶", {"GD-550": [(5, 19, "SR-90 凯达橡胶（新模具）"), (1, 4, "SR-92 凯达橡胶（EPDM）")],
                               "GD-750": [(5, 19, "SR-90 凯达橡胶（新模具）"), (1, 4, "SR-92 凯达橡胶（EPDM）")]}),
    "研磨盘": ("GR-304 不锈钢", {}),
    "下水器": ("DR-110 宏达", {}),
    "板材": ("SUS304 1.0mm", {}),
}

CODING_RULE_OFF = 20  # 截止月前 20 个月起推行统一批次编码，报修记录可追溯率明显提升

HANDLING_MIX = {
    "FAU": {"上门换件": 6, "换新机": 2, "退货": 1, "远程指导": 1},
    "GD": {"上门换件": 5, "换新机": 3.5, "退货": 1, "远程指导": 0.5},
    "SINK": {"上门换件": 7, "换新机": 1, "退货": 1, "远程指导": 1},
}
CHANNEL_MIX = {"客服热线": 4, "电商平台": 3, "经销商": 1.5, "安装师傅": 1.5}


def add_months(d, n):
    m = d.month - 1 + n
    return date(d.year + m // 12, m % 12 + 1, 1)


def batch_no(model, month):
    return f"{model.replace('-', '')}-{month:%y%m}"


def _pick(rng, mix):
    r = rng.random() * sum(mix.values())
    for k, w in mix.items():
        r -= w
        if r <= 0:
            return k
    return k


def _eta(eta, overrides, off):
    for lo, hi, v in overrides:
        if lo <= off <= hi:
            return v
    return eta


def _part_no(component, model, off):
    default, per_model = COMPONENTS[component]
    for lo, hi, v in per_model.get(model, []):
        if lo <= off <= hi:
            return v
    return default


def actions(end_month):
    m = lambda off: add_months(end_month, -off)  # noqa: E731
    return [
        ("FA-2025-003", "感应龙头感应距离衰减（元器件钝化）", "SF-101,SF-102", "V01", "P01",
         "IR-200 红外发射管长期通电后光衰，接收电路无增益补偿，使用 12 个月后感应距离逐步变短直至不感应。"
         "拆解 46 件回收件，41 件发射功率低于初始值 60%。属于设计选型问题，不能直接向代工厂索赔。",
         "改用 IR-300 感应模块（自动增益补偿）；来料增加 85℃/85%RH 500h 老化后感应距离测试；"
         "设计规范增加光衰余量要求。", f"{m(15):%Y-%m}", "质量工程师 + 研发", "验证中", (m(17) + timedelta(days=9)).isoformat()),
        ("FA-2026-001", "SF-201 电磁阀不关水、滴漏", "SF-201", "V02", "P02",
         "代工厂缺料时临时切换电磁阀二供 DV-12B，膜片硬度偏低，开关数千次后关闭不严。二供导入前未做寿命验证，也未通知我司。",
         "恢复 DV-12 主供；二供须完成 10 万次开关寿命验证并经我司批准后才能导入；出厂 100% 气密测试；"
         "3 个问题批次按质量协议索赔。", f"{m(8):%Y-%m}", "质量工程师", "已关闭", (m(9) + timedelta(days=20)).isoformat()),
        ("FA-2026-004", "垃圾处理器密封圈漏水", "GD-550,GD-750", "V03", "P22",
         "密封圈换新模具后内径偏小、硬度偏高，长期热水冲击后老化开裂。股东方技术团队已复现。",
         "改用 SR-92（EPDM 材料）并修正模具尺寸；增加 90℃ 热水循环 2000 次验证。", f"{m(4):%Y-%m}",
         "股东方技术团队 + 质量工程师", "验证中", (m(6) + timedelta(days=12)).isoformat()),
        ("FA-2026-006", "抽拉龙头阀芯滴漏", "MF-301", "V02", "P05",
         "回收件分析中：初步判断为陶瓷阀片研磨平面度不足。", "", None, "质量工程师", "根因分析",
         (m(1) + timedelta(days=5)).isoformat()),
    ]


def seed(db, end=None, seed_value=20261015):
    end = end or date.today()
    rng = random.Random(seed_value)
    db.reset()
    models = ref.model_map()
    end_month = date(end.year, end.month, 1)
    lag_mean = 20.0

    batches, comps, ships, fails = [], [], [], []
    for code, mdl in models.items():
        line = mdl["line"]
        for off in range(N_MONTHS, 0, -1):
            month = add_months(end_month, -off)
            growth = 1 + 0.012 * (N_MONTHS - off)
            qty = int(round(mdl["base_qty"] * growth * rng.uniform(0.85, 1.15), -1))
            bno = batch_no(code, month)
            batches.append((bno, code, mdl["supplier"], f"{month:%Y-%m}", qty))
            for c in mdl["components"]:
                comps.append((bno, c, _part_no(c, code, off), f"{month:%y%m}-{rng.randint(1, 9):02d}"))
            mechs = [(p, beta, _eta(eta, ov, off), faults) for p, beta, eta, faults, ov in MECHANISMS[code]]
            split = [(month + timedelta(days=24), int(qty * 0.6)), (month + timedelta(days=54), qty - int(qty * 0.6))]
            for ship_date, sq in split:
                if ship_date > end:
                    continue
                ships.append((bno, ship_date.isoformat(), sq))
                for _ in range(sq):
                    install = ship_date + timedelta(days=min(150, 5 + rng.expovariate(1 / lag_mean)))
                    if install > end:
                        continue
                    horizon = (end - install).days / ref.DAYS_PER_MONTH
                    best = None
                    for p, beta, eta, faults in mechs:
                        t = eta * (-math.log(1 - rng.random())) ** (1 / beta)
                        if t <= horizon and (best is None or t < best[0]):
                            best = (t, p, faults)
                    if best:
                        report = install + timedelta(days=best[0] * ref.DAYS_PER_MONTH + rng.randint(0, 6))
                        if report <= end:
                            fails.append((report, code, line, bno, install, best[1], best[2]))

    fails.sort(key=lambda x: x[0])
    rows, seq = [], {}
    for report, code, line, bno, install, part, faults in fails:
        off_r = (end_month.year - report.year) * 12 + end_month.month - report.month
        old = off_r > CODING_RULE_OFF
        key = f"{report:%y%m}"
        seq[key] = seq.get(key, 0) + 1
        traceable = rng.random() >= (0.20 if old else 0.04)
        part_known = rng.random() >= (0.35 if (end - report).days <= 45 else 0.12 if old else 0.05)
        handling = _pick(rng, HANDLING_MIX[line])
        cost = round(models[code]["unit_cost"] * ref.HANDLING[handling] + (0 if handling == "远程指导" else ref.SERVICE_FEE))
        rows.append((
            f"FR{key}{seq[key]:04d}", report.isoformat(), _pick(rng, CHANNEL_MIX), code,
            f"{bno}-{rng.randint(1, 99999):05d}" if traceable else None, bno if traceable else None,
            install.isoformat() if rng.random() >= (0.30 if old else 0.10) else None,
            _pick(rng, faults), part if part_known else None,
            ref.PART_CODES[part][2] if part_known else None, handling,
            1 if rng.random() < (0.25 if old else 0.60) else 0, cost, None, "系统"))

    db.executemany("INSERT INTO batches VALUES (?,?,?,?,?)", batches)
    db.executemany("INSERT INTO batch_components VALUES (?,?,?,?)", comps)
    db.executemany("INSERT INTO shipments(batch_no,ship_date,qty) VALUES (?,?,?)", ships)
    db.executemany(
        "INSERT INTO failures(rec_no,report_date,channel,model_code,sn,batch_no,install_date,fault_code,"
        "part_code,resp,handling,returned,cost,note,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.executemany(
        "INSERT INTO actions(action_no,title,models,supplier_code,part_code,root_cause,action,breakpoint_month,"
        "owner,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", actions(end_month))
    db.executemany("INSERT OR REPLACE INTO meta VALUES (?,?)", [
        ("as_of", end.isoformat()),
        ("coding_rule_month", f"{add_months(end_month, -CODING_RULE_OFF):%Y-%m}"),
    ])
    return {"batches": len(batches), "failures": len(rows), "units": sum(s[2] for s in ships)}
