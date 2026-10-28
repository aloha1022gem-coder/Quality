"""售后故障追踪的 API 路由，挂在 /api/field/ 下，由 sqm.server.App 统一分发。"""
from urllib.parse import unquote

from . import analytics as fa
from . import records
from . import reference as ref


def meta(db, mode="server"):
    fd = fa.FieldData(db)
    d = fa.dictionary()
    return {
        "as_of": fd.as_of.isoformat(), "mode": mode,
        "models": [{k: m[k] for k in ("code", "name", "line", "supplier", "unit_cost")} for m in fd.models.values()],
        "suppliers": list(fd.suppliers.values()),
        "lines": d["lines"], "faults": d["faults"], "parts": d["parts"], "resp": d["resp"],
        "channels": d["channels"], "handling": d["handling"],
        "counts": {"batches": len(fd.batches), "records": len(fd.failures),
                   "units": sum(b["shipped"] for b in fd.batches.values())},
        "targets": {k: {"mis12": v[1], "r5": v[2]} for k, v in ref.LINES.items()},
    }


def rules(db):
    return {**fa.dictionary(), "quality": fa.data_quality(db)}


def check(db, body):
    rec, errors, warnings = records.validate(db, body)
    return {"record": rec, "errors": errors, "warnings": warnings}


class FieldService:
    def __init__(self, db):
        self.db = db
        self.routes = [
            ("GET", r"/api/field/meta$", lambda q, b: meta(self.db)),
            ("GET", r"/api/field/overview$", lambda q, b: fa.overview(self.db)),
            ("GET", r"/api/field/batches$", lambda q, b: fa.batch_matrix(self.db)),
            ("GET", r"/api/field/reliability$", lambda q, b: fa.reliability(self.db)),
            ("GET", r"/api/field/pareto$", lambda q, b: fa.pareto_cube(self.db)),
            ("GET", r"/api/field/suppliers$", lambda q, b: fa.supplier_scores(self.db)),
            ("GET", r"/api/field/actions$", lambda q, b: fa.actions(self.db)),
            ("GET", r"/api/field/rules$", lambda q, b: rules(self.db)),
            ("GET", r"/api/field/records$", lambda q, b: records.list_records(self.db)),
            ("POST", r"/api/field/records$", lambda q, b: records.add_record(self.db, b)),
            ("POST", r"/api/field/records/check$", lambda q, b: check(self.db, b)),
            ("GET", r"/api/field/trace/([^/]+)$", lambda q, b, s: records.trace(self.db, unquote(s))),
        ]

    def export(self, path):
        if path == "/api/field/export/failures.csv":
            return records.export_csv(self.db).encode("utf-8"), "field_failures.csv"
        return None
