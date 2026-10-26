"""HTTP 服务：JSON API + 前端静态文件。仅使用 Python 标准库。"""
import json
import mimetypes
import os
import re
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import analytics, capa, governance
from .db import ROOT
from .knowledge import KnowledgeBase
from .llm import LLM

WEB_DIR = os.path.join(ROOT, "web")


class App:
    def __init__(self, db):
        self.db = db
        self.kb = KnowledgeBase(db)
        self.llm = LLM()
        self.routes = [
            ("GET", r"/api/meta$", self.meta),
            ("GET", r"/api/dashboard$", lambda q, b: analytics.dashboard(self.db, self.kb)),
            ("GET", r"/api/suppliers$", lambda q, b: analytics.supplier_scores(self.db)),
            ("GET", r"/api/suppliers/(\w+)$", lambda q, b, c: analytics.supplier_detail(self.db, self.kb, c)),
            ("GET", r"/api/alerts$", lambda q, b: analytics.compute_alerts(self.db, self.kb)),
            ("GET", r"/api/alerts/([\w\-]+)$", lambda q, b, k: analytics.alert_detail(self.db, self.kb, k)),
            ("POST", r"/api/alerts/([\w\-]+)/status$", self.alert_status),
            ("POST", r"/api/alerts/([\w\-]+)/refine$", self.alert_refine),
            ("GET", r"/api/kb/docs$", lambda q, b: self.kb.list_docs()),
            ("GET", r"/api/kb/docs/(\d+)$", lambda q, b, i: self.kb.doc(i)),
            ("POST", r"/api/kb/search$", self.kb_search),
            ("GET", r"/api/governance/dictionary$", lambda q, b: governance.dictionary()),
            ("GET", r"/api/governance/health$", lambda q, b: governance.health(self.db)),
            ("GET", r"/api/governance/sample$", lambda q, b: {"csv": governance.sample_csv(self.db)}),
            ("POST", r"/api/governance/validate$", lambda q, b: governance.validate(self.db, b.get("csv", ""))),
            ("POST", r"/api/governance/import$", lambda q, b: governance.import_rows(self.db, b.get("csv", ""))),
            ("GET", r"/api/capa$", lambda q, b: capa.list_capa(self.db)),
            ("POST", r"/api/capa$", lambda q, b: capa.create(self.db, b)),
            ("PUT", r"/api/capa/(\d+)$", lambda q, b, i: capa.update(self.db, int(i), b)),
            ("POST", r"/api/capa/(\d+)/close$", lambda q, b, i: capa.close(self.db, self.kb, int(i), b)),
        ]

    def meta(self, q, b):
        return {
            "as_of": analytics.as_of(self.db).isoformat(),
            "llm": self.llm.status(),
            "counts": {
                "suppliers": self.db.scalar("SELECT COUNT(*) FROM suppliers"),
                "materials": self.db.scalar("SELECT COUNT(*) FROM materials"),
                "lots": self.db.scalar("SELECT COUNT(*) FROM iqc_lots"),
                "kb_docs": self.db.scalar("SELECT COUNT(*) FROM kb_docs"),
            },
            "mode": "server",
            "suppliers": self.db.all("SELECT code, name FROM suppliers ORDER BY code"),
            "materials": self.db.all("SELECT code, name, supplier_code FROM materials ORDER BY code"),
            "defects": self.db.all("SELECT code, name FROM defect_codes ORDER BY code"),
        }

    def alert_status(self, q, b, key):
        status = b.get("status")
        if status not in ("待处理", "处理中", "已关闭"):
            raise ValueError("状态无效")
        self.db.execute("INSERT OR REPLACE INTO alert_state VALUES (?,?,?,?)",
                        (key, status, b.get("note", ""), datetime.now().isoformat(timespec="seconds")))
        return {"key": key, "status": status}

    def alert_refine(self, q, b, key):
        a = analytics.alert_detail(self.db, self.kb, key)
        if not a:
            raise KeyError(key)
        if not self.llm.enabled():
            return {"text": None, "error": self.llm.status()["reason"]}
        text, err = self.llm.refine_brief(a["brief"])
        return {"text": text, "error": err}

    def kb_search(self, q, b):
        return self.kb.answer(b.get("q", ""), doc_type=b.get("doc_type") or None,
                              supplier=b.get("supplier") or None, llm=self.llm, use_llm=bool(b.get("use_llm")))

    def dispatch(self, method, path, query, body):
        for m, pattern, fn in self.routes:
            if m != method:
                continue
            match = re.match(pattern, path)
            if match:
                return fn(query, body, *match.groups())
        raise KeyError(path)


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "SQMInsight/1.0"

        def log_message(self, fmt, *args):
            pass

        def _send(self, code, payload, ctype="application/json; charset=utf-8", extra=None):
            data = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _api(self, method):
            url = urlparse(self.path)
            body = {}
            if method in ("POST", "PUT"):
                n = int(self.headers.get("Content-Length") or 0)
                if n:
                    try:
                        body = json.loads(self.rfile.read(n).decode("utf-8"))
                    except (ValueError, UnicodeDecodeError):
                        return self._send(400, {"error": "请求格式错误"})
            try:
                if url.path == "/api/export/lots.csv":
                    return self._send(200, governance.export_lots_csv(app.db).encode("utf-8"),
                                      "text/csv; charset=utf-8",
                                      {"Content-Disposition": "attachment; filename=iqc_lots.csv"})
                result = app.dispatch(method, url.path, parse_qs(url.query), body)
                if result is None:
                    return self._send(404, {"error": "未找到"})
                self._send(200, result)
            except KeyError:
                self._send(404, {"error": "未找到"})
            except ValueError as e:
                self._send(400, {"error": str(e)})
            except Exception as e:
                traceback.print_exc()
                self._send(500, {"error": f"服务器错误：{e}"})

        def _static(self):
            path = urlparse(self.path).path
            if path == "/":
                path = "/index.html"
            full = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
            if not full.startswith(WEB_DIR) or not os.path.isfile(full):
                return self._send(404, b"Not found", "text/plain")
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            with open(full, "rb") as f:
                self._send(200, f.read(), ctype)

        def do_GET(self):
            if self.path.startswith("/api/"):
                return self._api("GET")
            self._static()

        def do_POST(self):
            self._api("POST")

        def do_PUT(self):
            self._api("PUT")

    return Handler


def serve(app, host="127.0.0.1", port=8765):
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    return httpd
