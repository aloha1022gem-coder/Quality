"""售后故障追踪的 SQLite 表结构：批次表、关键件批次、出货表、故障记录表、改善措施表。"""
import os

from ..db import ROOT, Database

DEFAULT_DB = os.path.join(ROOT, "data", "field.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS batches (
    batch_no TEXT PRIMARY KEY, model_code TEXT NOT NULL, supplier_code TEXT NOT NULL,
    prod_month TEXT NOT NULL, prod_qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS batch_components (
    batch_no TEXT NOT NULL, component TEXT NOT NULL, part_no TEXT NOT NULL, lot_no TEXT
);
CREATE TABLE IF NOT EXISTS shipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, batch_no TEXT NOT NULL, ship_date TEXT NOT NULL, qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT, rec_no TEXT UNIQUE NOT NULL, report_date TEXT NOT NULL,
    channel TEXT, model_code TEXT NOT NULL, sn TEXT, batch_no TEXT, install_date TEXT,
    fault_code TEXT NOT NULL, part_code TEXT, resp TEXT, handling TEXT, returned INTEGER DEFAULT 0,
    cost REAL DEFAULT 0, note TEXT, source TEXT DEFAULT '系统'
);
CREATE INDEX IF NOT EXISTS ix_fail_batch ON failures(batch_no);
CREATE INDEX IF NOT EXISTS ix_fail_date ON failures(report_date);
CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, action_no TEXT UNIQUE, title TEXT, models TEXT,
    supplier_code TEXT, part_code TEXT, root_cause TEXT, action TEXT, breakpoint_month TEXT,
    owner TEXT, status TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


class FieldDatabase(Database):
    def __init__(self, path=DEFAULT_DB):
        super().__init__(path, SCHEMA)

    def is_empty(self):
        return not self.scalar("SELECT COUNT(*) FROM batches")
