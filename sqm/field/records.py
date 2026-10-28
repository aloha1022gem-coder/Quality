"""故障记录：清单、录入校验、按 SN / 批次 / 记录号追溯、导出 CSV。"""
import csv
import io
import re
from datetime import date

from . import reference as ref
from .analytics import FieldData

SN_RE = re.compile(r"^([A-Z]{2})-?(\d{3})-?(\d{4})-?(\d{1,5})$")
BATCH_RE = re.compile(r"^([A-Z]{2})-?(\d{3})-?(\d{4})$")


def _decorate(f, models):
    m = models.get(f["model_code"], {})
    return {**{k: v for k, v in f.items() if k not in ("report", "age", "line")},
            "model_name": m.get("name"), "line": m.get("line"),
            "fault_name": ref.FAULT_CODES.get(f["fault_code"], ("",))[0],
            "part_name": ref.PART_CODES[f["part_code"]][0] if f.get("part_code") in ref.PART_CODES else None,
            "age": round(f["age"], 1) if f.get("age") is not None else None}


def list_records(db, limit=300):
    fd = FieldData(db)
    return [_decorate(f, fd.models) for f in reversed(fd.failures[-limit:])]


def parse_sn(sn):
    """SN 格式：型号-生产年月-流水号，例如 SF101-2507-00123。返回 (型号代码, 批次号, 标准 SN) 或 None。"""
    m = SN_RE.match((sn or "").strip().upper())
    if not m:
        return None
    batch = f"{m.group(1)}{m.group(2)}-{m.group(3)}"
    return f"{m.group(1)}-{m.group(2)}", batch, f"{batch}-{int(m.group(4)):05d}"


def parse_batch(text):
    m = BATCH_RE.match((text or "").strip().upper())
    return f"{m.group(1)}{m.group(2)}-{m.group(3)}" if m else None


def validate(db, body):
    """校验一条报修记录。返回 (清洗后的记录, 错误列表, 提示列表)。"""
    errors, warnings = [], []
    models = ref.model_map()
    rec = {k: (str(body.get(k)).strip() if body.get(k) not in (None, "") else None) for k in (
        "report_date", "channel", "model_code", "sn", "batch_no", "install_date", "fault_code",
        "part_code", "resp", "handling", "note")}
    model = models.get(rec["model_code"])
    if not model:
        errors.append("请选择型号")
    try:
        report = date.fromisoformat(rec["report_date"] or "")
    except ValueError:
        report = None
        errors.append("报修日期格式应为 YYYY-MM-DD")
    if rec["sn"]:
        parsed = parse_sn(rec["sn"])
        if not parsed:
            errors.append("SN 格式不正确，应为 型号-生产年月-流水号，例如 SF101-2507-00123")
        else:
            if model and parsed[0] != rec["model_code"]:
                errors.append(f"SN 对应型号 {parsed[0]}，与所选型号 {rec['model_code']} 不一致")
            if rec["batch_no"] and parse_batch(rec["batch_no"]) != parsed[1]:
                errors.append("SN 与批次号不一致")
            rec["batch_no"], rec["sn"] = parsed[1], parsed[2]
    elif rec["batch_no"]:
        rec["batch_no"] = parse_batch(rec["batch_no"]) or rec["batch_no"].upper()
    if rec["batch_no"]:
        b = db.one("SELECT * FROM batches WHERE batch_no=?", (rec["batch_no"],))
        if not b:
            errors.append(f"系统中没有批次 {rec['batch_no']}")
        elif model and b["model_code"] != rec["model_code"]:
            errors.append(f"批次 {rec['batch_no']} 属于 {b['model_code']}")
    else:
        warnings.append("缺少 SN / 批次号：这条记录只计入报修总量，不能进入批次故障率和寿命分析")
    if rec["install_date"]:
        try:
            inst = date.fromisoformat(rec["install_date"])
            if report and inst > report:
                errors.append("安装日期晚于报修日期")
        except ValueError:
            errors.append("安装日期格式应为 YYYY-MM-DD")
    else:
        warnings.append(f"缺少安装日期：使用月数按批次首次出货 + {ref.INSTALL_LAG_DAYS} 天估算")
    fault = ref.FAULT_CODES.get(rec["fault_code"])
    if not fault:
        errors.append("请选择故障现象代码")
    elif model and fault[1] != model["line"]:
        errors.append(f"{rec['fault_code']} 不是{ref.line_name(model['line'])}的故障代码")
    if rec["part_code"]:
        part = ref.PART_CODES.get(rec["part_code"])
        if not part or (model and part[1] != model["line"]):
            errors.append("故障部位代码与产品线不符")
        elif not rec["resp"]:
            rec["resp"] = part[2]
    else:
        warnings.append("故障部位待拆解确认：请安排回收故障件")
        rec["resp"] = None
    if rec["resp"] and rec["resp"] not in ref.RESPONSIBILITY:
        errors.append("责任方代码无效")
    if rec["channel"] and rec["channel"] not in ref.CHANNELS:
        errors.append("报修渠道无效")
    if rec["handling"] and rec["handling"] not in ref.HANDLING:
        errors.append("处理方式无效")
    rec["returned"] = 1 if body.get("returned") in (True, 1, "1", "on", "true") else 0
    if model and rec["handling"]:
        rec["cost"] = round(model["unit_cost"] * ref.HANDLING[rec["handling"]]
                            + (0 if rec["handling"] == "远程指导" else ref.SERVICE_FEE))
    else:
        rec["cost"] = 0
    return rec, errors, warnings


def add_record(db, body):
    rec, errors, warnings = validate(db, body)
    if errors:
        raise ValueError("；".join(errors))
    prefix = "FR" + rec["report_date"][2:4] + rec["report_date"][5:7]
    last = db.scalar("SELECT MAX(rec_no) FROM failures WHERE rec_no LIKE ?", (prefix + "%",))
    rec["rec_no"] = f"{prefix}{int(last[len(prefix):]) + 1 if last else 1:04d}"
    rec["source"] = "手工录入"
    cols = ["rec_no", "report_date", "channel", "model_code", "sn", "batch_no", "install_date", "fault_code",
            "part_code", "resp", "handling", "returned", "cost", "note", "source"]
    db.execute(f"INSERT INTO failures({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
               [rec[c] for c in cols])
    return {"record": rec, "warnings": warnings}


def trace(db, q, fd=None):
    """按记录号、SN 或批次号追溯：批次 → 关键件批次 → 出货 → 报修。"""
    fd = fd or FieldData(db)
    q = (q or "").strip().upper()
    record = None
    if q.startswith("FR"):
        record = next((f for f in fd.failures if f["rec_no"] == q), None)
        bno = record["batch_no"] if record else None
    else:
        sn = parse_sn(q)
        bno = sn[1] if sn else parse_batch(q)
        if sn:
            record = next((f for f in reversed(fd.failures) if f["sn"] == sn[2]), None)
    if record and not bno:
        return {"query": q, "record": _decorate(record, fd.models), "batch": None,
                "message": "该记录没有批次码，无法向上追溯"}
    b = fd.batches.get(bno) if bno else None
    if not b:
        return None
    return batch_detail(db, fd, b, record)


def batch_detail(db, fd, b, record=None):
    m = fd.models[b["model_code"]]
    by_fault, by_part = {}, {}
    for f in b["fails"]:
        by_fault[f["fault_code"]] = by_fault.get(f["fault_code"], 0) + 1
        key = f["part_code"] or "待拆解"
        by_part[key] = by_part.get(key, 0) + 1
    mis = {}
    for k in ref.MIS_POINTS:
        if fd.matured(b, k) and b["shipped"]:
            x = fd.count_within(b, k)
            mis[str(k)] = {"x": x, "rate": x / b["shipped"]}
        else:
            mis[str(k)] = None
    return {
        "batch": {"batch_no": b["batch_no"], "model_code": b["model_code"], "model_name": m["name"],
                  "line": m["line"], "supplier_code": b["supplier_code"],
                  "supplier_name": fd.suppliers[b["supplier_code"]]["name"], "prod_month": b["prod_month"],
                  "prod_qty": b["prod_qty"], "shipped": b["shipped"]},
        "components": db.all("SELECT component, part_no, lot_no FROM batch_components WHERE batch_no=?",
                             (b["batch_no"],)),
        "shipments": [{"ship_date": d.isoformat(), "qty": q} for d, q in b["ships"]],
        "mis": mis, "fails": len(b["fails"]),
        "by_fault": sorted([[k, ref.FAULT_CODES[k][0], v] for k, v in by_fault.items()], key=lambda x: -x[2]),
        "by_part": sorted([[k, ref.PART_CODES[k][0] if k in ref.PART_CODES else k, v] for k, v in by_part.items()],
                          key=lambda x: -x[2]),
        "recent": [_decorate(f, fd.models) for f in b["fails"][-8:][::-1]],
        "record": _decorate(record, fd.models) if record else None,
    }


def export_csv(db):
    rows = db.all("SELECT rec_no, report_date, channel, model_code, sn, batch_no, install_date, fault_code, "
                  "part_code, resp, handling, returned, cost, note, source FROM failures ORDER BY report_date")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["记录号", "报修日期", "渠道", "型号", "SN", "批次号", "安装日期", "故障现象", "故障部位",
                "责任方", "处理方式", "故障件回收", "处理成本", "备注", "来源"])
    for r in rows:
        w.writerow(list(r.values()))
    return "﻿" + buf.getvalue()
