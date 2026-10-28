"""售后故障追踪测试：python -m unittest discover -s tests"""
import json
import math
import os
import random
import sys
import threading
import unittest
import urllib.error
import urllib.request
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqm.db import Database  # noqa: E402
from sqm.field import analytics as fa, records, reliability as rel  # noqa: E402
from sqm.field.db import FieldDatabase  # noqa: E402
from sqm.field.seed import seed  # noqa: E402
from sqm.server import App, serve  # noqa: E402

END = date(2026, 10, 15)


def fresh():
    db = FieldDatabase(":memory:")
    seed(db, end=END)
    return db


class WeibullTest(unittest.TestCase):
    def test_recovers_parameters_with_censoring(self):
        rng = random.Random(1)
        fails, cens = [], []
        for _ in range(20000):
            t = 100 * (-math.log(1 - rng.random())) ** (1 / 2.0)
            c = rng.uniform(1, 60)  # 观察期 1–60 个月，大部分产品未故障
            if t <= c:
                fails.append(t)
            else:
                cens.append((c, 1))
        fit = rel.weibull_fit(fails, cens)
        self.assertAlmostEqual(fit["beta"], 2.0, delta=0.15)
        self.assertAlmostEqual(fit["eta"], 100, delta=8)
        # 只对已坏产品求平均会远低于真实平均寿命（约 88.6 个月）
        self.assertLess(sum(fails) / len(fails), 45)

    def test_weibayes_uses_given_beta(self):
        fit = rel.weibull_fit([10.0, 20.0], [(30.0, 100)], beta=2.0)
        self.assertEqual(fit["method"], "Weibayes")
        self.assertEqual(fit["beta"], 2.0)


class FieldAnalyticsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.db = fresh()
        cls.fd = fa.FieldData(cls.db)

    def test_abnormal_batches_are_the_valve_batches(self):
        found = {a["batch_no"] for a in fa.abnormal_batches(self.fd)}
        self.assertEqual(found, {"SF201-2511", "SF201-2512", "SF201-2601"})

    def test_immature_batches_have_no_rate(self):
        rows = [r for r in fa.batch_matrix(self.db, self.fd)["rows"] if r["batch_no"] == "SF101-2609"]
        self.assertIsNone(rows[0]["mis"]["3"])
        old = [r for r in fa.batch_matrix(self.db, self.fd)["rows"] if r["batch_no"] == "SF101-2401"]
        self.assertIsNotNone(old[0]["mis"]["24"])

    def test_sensor_improvement_detected_but_below_target(self):
        r = fa.reliability(self.db, self.fd)
        sf = next(m for m in r["models"] if m["model_code"] == "SF-101")
        fits = {(f["group"], f["part_code"]): f for f in sf["fits"]}
        self.assertGreater(fits[("before", "P01")]["beta"], 1.5)   # 感应元件衰减是耗损型
        self.assertLess(fits[("before", None)]["r5"], 0.7)
        self.assertEqual(fits[("after", None)]["method"], "Weibayes")
        self.assertTrue(0.75 < fits[("after", None)]["r5"] < 0.95)

    def test_action_verdicts(self):
        v = {a["action_no"]: a["verification"] for a in fa.actions(self.db, self.fd)}
        self.assertEqual(v["FA-2025-003"]["verdict"], "有效")
        self.assertEqual(v["FA-2026-001"]["verdict"], "有效")
        self.assertEqual(v["FA-2026-004"]["verdict"], "数据不足")
        self.assertIsNone(v["FA-2026-006"])

    def test_design_issues_not_claimed_from_supplier(self):
        v01 = next(s for s in fa.supplier_scores(self.db, self.fd) if s["code"] == "V01")
        self.assertGreater(v01["resp"]["D"]["count"], v01["resp"]["S"]["count"])
        self.assertEqual(v01["claim"], v01["resp"]["S"]["cost"])

    def test_traceability_improves_after_coding_rule(self):
        q = fa.data_quality(self.db, self.fd)["months"]
        self.assertLess(q[0]["traceable"], 0.9)
        self.assertGreater(q[-2]["traceable"], 0.9)


class RecordTest(unittest.TestCase):
    def setUp(self):
        self.db = fresh()

    def test_validation_messages(self):
        _, errors, _ = records.validate(self.db, {"report_date": "2026-10-10", "model_code": "SF-101",
                                                  "sn": "SF201-2507-00001", "fault_code": "F01"})
        self.assertTrue(any("型号" in e for e in errors))
        _, errors, _ = records.validate(self.db, {"report_date": "2026-10-10", "model_code": "SF-101",
                                                  "fault_code": "F21"})
        self.assertTrue(any("不是龙头" in e for e in errors))
        rec, errors, warnings = records.validate(self.db, {"report_date": "2026-10-10", "model_code": "SF-101",
                                                           "fault_code": "F02", "part_code": "P01"})
        self.assertFalse(errors)
        self.assertEqual(rec["resp"], "D")
        self.assertTrue(any("批次" in w for w in warnings))

    def test_add_and_trace(self):
        r = records.add_record(self.db, {"report_date": "2026-10-12", "model_code": "SF-101", "sn": "sf101-2507-42",
                                         "fault_code": "F02", "handling": "上门换件", "channel": "客服热线"})
        self.assertEqual(r["record"]["sn"], "SF101-2507-00042")
        self.assertEqual(r["record"]["batch_no"], "SF101-2507")
        t = records.trace(self.db, r["record"]["rec_no"])
        self.assertEqual(t["batch"]["batch_no"], "SF101-2507")
        self.assertEqual(t["record"]["rec_no"], r["record"]["rec_no"])
        with self.assertRaises(ValueError):
            records.add_record(self.db, {"report_date": "2026-10-12", "model_code": "SF-101", "batch_no": "SF101-1201",
                                         "fault_code": "F02"})


class FieldApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = serve(App(Database(":memory:"), fresh()), "127.0.0.1", 0)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def get(self, path):
        with urllib.request.urlopen(self.base + path) as r:
            return r.read().decode("utf-8")

    def test_endpoints(self):
        self.assertEqual(json.loads(self.get("/api/field/meta"))["counts"]["batches"], 264)
        for name in ("overview", "batches", "reliability", "pareto", "suppliers", "actions", "rules", "records"):
            self.assertTrue(json.loads(self.get("/api/field/" + name)))
        self.assertIn("SF201-2511", self.get("/api/field/trace/SF201-2511"))
        self.assertTrue(self.get("/api/field/export/failures.csv").startswith("﻿记录号"))
        self.assertIn("field.js", self.get("/field"))
        with self.assertRaises(urllib.error.HTTPError):
            self.get("/api/field/trace/XX999-0000")


if __name__ == "__main__":
    unittest.main()
