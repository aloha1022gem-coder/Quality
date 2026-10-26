"""核心逻辑测试：python -m unittest discover -s tests"""
import json
import os
import sys
import threading
import unittest
import urllib.request
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqm import analytics, capa, governance  # noqa: E402
from sqm.db import Database  # noqa: E402
from sqm.knowledge import KnowledgeBase, tokenize  # noqa: E402
from sqm.seed import seed  # noqa: E402
from sqm.server import App, serve  # noqa: E402
from sqm.stats import binom_sf, upper_count_limit  # noqa: E402


def fresh():
    db = Database(":memory:")
    seed(db, end=date(2026, 10, 26))
    return db, KnowledgeBase(db)


class StatsTest(unittest.TestCase):
    def test_binom_sf(self):
        self.assertAlmostEqual(binom_sf(0, 10, 0.3), 1.0)
        self.assertAlmostEqual(binom_sf(1, 10, 0.5), 1 - 0.5 ** 10)
        self.assertAlmostEqual(binom_sf(10, 10, 0.5), 0.5 ** 10)

    def test_upper_limit(self):
        c = upper_count_limit(200, 0.004, 0.00135)
        self.assertLessEqual(binom_sf(c, 200, 0.004), 0.00135)
        self.assertGreater(binom_sf(c - 1, 200, 0.004), 0.00135)


class AlertTest(unittest.TestCase):
    def setUp(self):
        self.db, self.kb = fresh()

    def test_designed_scenarios_detected(self):
        alerts = {a["key"]: a for a in analytics.compute_alerts(self.db, self.kb)}
        for mat in ("M-HSG-01", "M-FLT-01", "M-PCB-01"):
            self.assertEqual(alerts[f"STAT-{mat}"]["level"], "高")
        self.assertEqual(alerts["STAT-M-DSP-01"]["level"], "中")
        self.assertTrue(any(k.startswith("SAFE-") for k in alerts))
        self.assertIn("CAPA-8D-2026-011", alerts)
        self.assertEqual(alerts["STAT-M-FLT-01"]["defect_code"], "D05")
        self.assertTrue(alerts["STAT-M-FLT-01"]["changes"])

    def test_stable_materials_quiet(self):
        keys = {a["key"] for a in analytics.compute_alerts(self.db, self.kb)}
        for mat in ("M-MOT-01", "M-SNS-01", "M-STP-01"):
            self.assertNotIn(f"STAT-{mat}", keys)

    def test_brief_cites_history(self):
        a = analytics.alert_detail(self.db, self.kb, "STAT-M-FLT-01")
        self.assertIn("8D-2025-014", a["brief"])
        self.assertIn("需责任人确认", a["brief"])


class KnowledgeTest(unittest.TestCase):
    def setUp(self):
        self.db, self.kb = fresh()

    def test_tokenize(self):
        self.assertEqual(tokenize("划伤"), ["划伤"])
        self.assertIn("scratch", tokenize("Scratch 划伤"))

    def test_synonym_expansion(self):
        hits, info = self.kb.search("Scratch")
        self.assertIn("D01", info["defects"])
        self.assertEqual(hits[0]["defect_code"], "D01")

    def test_answer_has_citations(self):
        r = self.kb.answer("回流焊虚焊 锡膏")
        self.assertTrue(r["hits"])
        self.assertTrue(all(i["ref"] >= 1 for g in r["groups"] for i in g["items"]))


class GovernanceTest(unittest.TestCase):
    def setUp(self):
        self.db, _ = fresh()

    def test_sample_issues(self):
        r = governance.validate(self.db, governance.sample_csv(self.db))
        msgs = " ".join(i["msg"] for row in r["rows"] for i in row["issues"])
        for expect in ("文件内重复批次", "系统中已存在", "单位混用", "不良数大于抽样数", "名称转编码", "过于笼统"):
            self.assertIn(expect, msgs)
        self.assertEqual(r["total"], 16)

    def test_import_only_clean_rows(self):
        before = self.db.scalar("SELECT COUNT(*) FROM iqc_lots")
        r = governance.import_rows(self.db, governance.sample_csv(self.db))
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM iqc_lots") - before, r["importable"])
        self.assertTrue(all(c["ok"] for c in governance.health(self.db)["checks"][:5]))


class CapaTest(unittest.TestCase):
    def setUp(self):
        self.db, self.kb = fresh()

    def test_close_requires_fields_and_writes_back(self):
        c = capa.create(self.db, {"title": "测试问题", "supplier_code": "S01", "material_code": "M-HSG-01",
                                  "defect_code": "D01", "alert_key": "STAT-M-HSG-01"})
        self.assertEqual(c["capa_no"], f"8D-{date.today().year}-{'012' if date.today().year == 2026 else '001'}")
        with self.assertRaises(ValueError):
            capa.close(self.db, self.kb, c["id"])
        capa.close(self.db, self.kb, c["id"], {"root_cause": "夹爪无保护", "corrective_action": "加保护套",
                                               "verification": "连续 10 批合格"})
        hits, _ = self.kb.search("夹爪 保护套")
        self.assertIn(c["capa_no"], [h["doc_no"] for h in hits])
        st = self.db.one("SELECT status FROM alert_state WHERE alert_key='STAT-M-HSG-01'")
        self.assertEqual(st["status"], "已关闭")


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db, _ = fresh()
        cls.httpd = serve(App(db), "127.0.0.1", 0)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def call(self, path, body=None):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())

    def test_endpoints(self):
        self.assertEqual(self.call("/api/meta")["counts"]["suppliers"], 10)
        self.assertEqual(len(self.call("/api/dashboard")["weekly"]), 26)
        self.assertTrue(self.call("/api/suppliers/S02")["charts"])
        self.assertTrue(self.call("/api/kb/search", {"q": "异味"})["hits"])
        with urllib.request.urlopen(self.base + "/") as r:
            self.assertIn("app.js", r.read().decode())


if __name__ == "__main__":
    unittest.main()
