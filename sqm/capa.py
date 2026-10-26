"""8D / CAPA 改善闭环：创建、推进、关闭并回写知识库。"""
from datetime import date, datetime, timedelta

from . import reference as ref

EDITABLE = ["title", "owner", "due_date", "status", "problem", "containment", "root_cause",
            "corrective_action", "verification"]


def list_capa(db):
    end = db.scalar("SELECT MAX(inspect_date) FROM iqc_lots") or date.today().isoformat()
    rows = db.all("SELECT c.*, s.name supplier_name, m.name material_name FROM capa c "
                  "LEFT JOIN suppliers s ON s.code=c.supplier_code LEFT JOIN materials m ON m.code=c.material_code "
                  "ORDER BY c.status='已关闭', c.due_date")
    for r in rows:
        r["defect_name"] = ref.defect_name(r["defect_code"]) if r["defect_code"] else None
        r["overdue"] = r["status"] != "已关闭" and bool(r["due_date"]) and r["due_date"] < end
    return rows


def get(db, capa_id):
    return next((c for c in list_capa(db) if c["id"] == int(capa_id)), None)


def _next_no(db):
    year = date.today().year
    nos = [r["capa_no"] for r in db.all("SELECT capa_no FROM capa WHERE capa_no LIKE ?", (f"8D-{year}-%",))]
    n = max([int(x.rsplit("-", 1)[1]) for x in nos if x.rsplit("-", 1)[1].isdigit()] or [0])
    return f"8D-{year}-{n + 1:03d}"


def create(db, data):
    if not data.get("title"):
        raise ValueError("请填写问题标题")
    if data.get("alert_key"):
        exist = db.one("SELECT capa_no FROM capa WHERE alert_key=?", (data["alert_key"],))
        if exist:
            raise ValueError(f"该预警已关联 {exist['capa_no']}")
    no = _next_no(db)
    due = data.get("due_date") or (date.today() + timedelta(days=30)).isoformat()
    cid = db.execute(
        "INSERT INTO capa(capa_no,title,supplier_code,material_code,defect_code,alert_key,owner,due_date,status,"
        "problem,containment,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (no, data["title"], data.get("supplier_code"), data.get("material_code"), data.get("defect_code"),
         data.get("alert_key"), data.get("owner") or "", due, "待围堵", data.get("problem", ""),
         data.get("containment", ""), date.today().isoformat()))
    if data.get("alert_key"):
        db.execute("INSERT OR REPLACE INTO alert_state VALUES (?,?,?,?)",
                   (data["alert_key"], "处理中", f"已发起 {no}", datetime.now().isoformat(timespec="seconds")))
    return get(db, cid)


def update(db, capa_id, data):
    c = get(db, capa_id)
    if not c:
        raise KeyError(capa_id)
    if c["status"] == "已关闭":
        raise ValueError("已关闭的 8D 不能再修改")
    if data.get("status") == "已关闭":
        raise ValueError("请使用“关闭并回写知识库”完成关闭")
    if data.get("status") and data["status"] not in ref.CAPA_STATUSES:
        raise ValueError("状态无效")
    fields = [k for k in EDITABLE if k in data]
    if fields:
        db.execute(f"UPDATE capa SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?",
                   [data[k] for k in fields] + [capa_id])
    return get(db, capa_id)


def close(db, kb, capa_id, data=None):
    if data:
        update(db, capa_id, {k: v for k, v in data.items() if k != "status"})
    c = get(db, capa_id)
    missing = [n for k, n in (("root_cause", "根本原因"), ("corrective_action", "永久对策"),
                              ("verification", "效果验证")) if not (c.get(k) or "").strip()]
    if missing:
        raise ValueError("关闭前请补充：" + "、".join(missing))
    today = date.today().isoformat()
    content = "\n".join([
        "## D2 问题描述", c["problem"] or c["title"], "",
        "## D3 围堵措施", c["containment"] or "（未记录）", "",
        "## D4 根本原因", c["root_cause"], "",
        "## D5-D6 永久对策", c["corrective_action"], "",
        "## D7 效果验证", c["verification"], "",
        "## 经验教训", f"本案例由 {c['capa_no']} 关闭时自动回写知识库，责任人：{c['owner'] or '未指定'}。",
    ])
    doc_id = db.execute(
        "INSERT OR REPLACE INTO kb_docs(doc_no,title,doc_type,supplier_code,material_code,defect_code,doc_date,content,source)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (c["capa_no"], f"{c['supplier_name'] or ''} {c['title']} 8D 报告".strip(), "8D", c["supplier_code"],
         c["material_code"], c["defect_code"], today, content, "8D 关闭回写"))
    db.execute("UPDATE capa SET status='已关闭', closed_at=?, kb_doc_id=? WHERE id=?", (today, doc_id, capa_id))
    if c["alert_key"]:
        db.execute("INSERT OR REPLACE INTO alert_state VALUES (?,?,?,?)",
                   (c["alert_key"], "已关闭", f"{c['capa_no']} 已关闭", datetime.now().isoformat(timespec="seconds")))
    kb.reindex()
    return get(db, capa_id)
