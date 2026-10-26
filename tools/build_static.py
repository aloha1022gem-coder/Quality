"""生成单文件离线演示版（无需 Python 服务，双击即可在浏览器打开）。

用法：
    python tools/build_static.py                      # 输出 dist/sqm_insight_offline.html
    python tools/build_static.py --fragment out.html  # 另外输出不含 <html>/<head> 外壳的页面片段（用于在线发布）

数据快照在构建时用内存数据库重新生成，不读写 data/sqm.db。
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from sqm import analytics, capa, governance, reference as ref  # noqa: E402
from sqm.db import Database  # noqa: E402
from sqm.knowledge import KnowledgeBase  # noqa: E402
from sqm.seed import seed  # noqa: E402

TITLE = "SQM Insight"


def build_bundle():
    db = Database(":memory:")
    seed(db)
    kb = KnowledgeBase(db)
    alerts = analytics.compute_alerts(db, kb)
    return {
        "meta": {
            "as_of": analytics.as_of(db).isoformat(), "mode": "static",
            "llm": {"enabled": False, "model": None, "reason": "在线预览不调用大模型；本地运行并配置 API Key 后可用"},
            "counts": {"suppliers": len(ref.SUPPLIERS), "materials": len(ref.MATERIALS),
                       "lots": db.scalar("SELECT COUNT(*) FROM iqc_lots"),
                       "kb_docs": db.scalar("SELECT COUNT(*) FROM kb_docs")},
            "suppliers": db.all("SELECT code, name FROM suppliers ORDER BY code"),
            "materials": db.all("SELECT code, name, supplier_code FROM materials ORDER BY code"),
            "defects": db.all("SELECT code, name FROM defect_codes ORDER BY code"),
        },
        "dashboard": analytics.dashboard(db, kb),
        "suppliers": analytics.supplier_scores(db),
        "supplier_details": {s[0]: analytics.supplier_detail(db, kb, s[0]) for s in ref.SUPPLIERS},
        "alerts": alerts,
        "alert_details": {a["key"]: analytics.alert_detail(db, kb, a["key"]) for a in alerts},
        "docs": db.all("SELECT * FROM kb_docs"),
        "capa": [{k: v for k, v in c.items() if k not in ("supplier_name", "material_name", "defect_name", "overdue")}
                 for c in capa.list_capa(db)],
        "dictionary": governance.dictionary(),
        "health": governance.health(db),
        "sample_csv": governance.sample_csv(db),
        "alias_map": ref.build_alias_map(),
        "defect_names": {c: v[0] for c, v in ref.DEFECT_CODES.items()},
        "ambiguous": ref.AMBIGUOUS_TERMS,
        "suppliers_ref": db.all("SELECT code, name FROM suppliers"),
        "materials": db.all("SELECT code, name, supplier_code FROM materials"),
        "existing_lots": [r["lot_no"] for r in db.all("SELECT lot_no FROM iqc_lots")],
        "sampling_plan": ref.SAMPLING_PLAN,
    }


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        return f.read()


def body_html(bundle):
    data = json.dumps(bundle, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    return (f"<style>\n{read('web/app.css')}\n</style>\n<div id=\"app\"></div>\n"
            f"<script>window.SQM_BUNDLE={data};</script>\n"
            f"<script>\n{read('web/static-backend.js')}\n</script>\n<script>\n{read('web/app.js')}\n</script>\n")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=os.path.join(ROOT, "dist", "sqm_insight_offline.html"))
    p.add_argument("--fragment", help="同时输出不含文档外壳的页面片段")
    args = p.parse_args()
    body = body_html(build_bundle())
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write("<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n"
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
                f"<title>{TITLE}</title>\n</head>\n<body>\n{body}</body>\n</html>\n")
    print("已生成", args.out)
    if args.fragment:
        with open(args.fragment, "w", encoding="utf-8") as f:
            f.write(f"<title>{TITLE}</title>\n<meta name=\"claude:viewport-fit-sides\" content=\"cover\">\n{body}")
        print("已生成", args.fragment)


if __name__ == "__main__":
    main()
