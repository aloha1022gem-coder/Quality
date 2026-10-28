"""SQLite 存储层。"""
import os
import sqlite3
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.path.join(ROOT, "data", "sqm.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS suppliers (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, region TEXT,
    sqe_owner TEXT, tier TEXT
);
CREATE TABLE IF NOT EXISTS materials (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, supplier_code TEXT NOT NULL,
    critical INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS defect_codes (
    code TEXT PRIMARY KEY, name TEXT, category TEXT, severity TEXT, safety INTEGER
);
CREATE TABLE IF NOT EXISTS defect_aliases (
    alias TEXT PRIMARY KEY, code TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS iqc_lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lot_no TEXT UNIQUE NOT NULL, supplier_code TEXT NOT NULL, material_code TEXT NOT NULL,
    inspect_date TEXT NOT NULL, lot_qty INTEGER, sample_size INTEGER NOT NULL,
    defect_qty INTEGER NOT NULL, result TEXT, inspector TEXT, source TEXT DEFAULT '系统'
);
CREATE TABLE IF NOT EXISTS iqc_defects (
    lot_id INTEGER NOT NULL, defect_code TEXT NOT NULL, qty INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_lots_mat ON iqc_lots(material_code, inspect_date);
CREATE TABLE IF NOT EXISTS change_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_code TEXT, material_code TEXT,
    event_date TEXT, kind TEXT, description TEXT, notified INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS capa (
    id INTEGER PRIMARY KEY AUTOINCREMENT, capa_no TEXT UNIQUE, title TEXT,
    supplier_code TEXT, material_code TEXT, defect_code TEXT, alert_key TEXT,
    owner TEXT, due_date TEXT, status TEXT, problem TEXT, containment TEXT,
    root_cause TEXT, corrective_action TEXT, verification TEXT,
    created_at TEXT, closed_at TEXT, kb_doc_id INTEGER
);
CREATE TABLE IF NOT EXISTS alert_state (
    alert_key TEXT PRIMARY KEY, status TEXT, note TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS kb_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, doc_no TEXT UNIQUE, title TEXT, doc_type TEXT,
    supplier_code TEXT, material_code TEXT, defect_code TEXT, doc_date TEXT,
    content TEXT, source TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""

_lock = threading.RLock()


class Database:
    def __init__(self, path=DEFAULT_DB, schema=SCHEMA):
        self.path = path
        self.schema = schema
        if path != ":memory:":
            os.makedirs(os.path.dirname(path), exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(schema)
        self.lock = _lock

    def all(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        with self.lock:
            r = self.conn.execute(sql, args).fetchone()
            return dict(r) if r else None

    def scalar(self, sql, args=()):
        with self.lock:
            r = self.conn.execute(sql, args).fetchone()
            return r[0] if r else None

    def execute(self, sql, args=()):
        with self.lock:
            cur = self.conn.execute(sql, args)
            self.conn.commit()
            return cur.lastrowid

    def executemany(self, sql, rows):
        with self.lock:
            self.conn.executemany(sql, rows)
            self.conn.commit()

    def is_empty(self):
        return not self.scalar("SELECT COUNT(*) FROM iqc_lots")

    def reset(self):
        with self.lock:
            tables = [r[0] for r in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            for t in tables:
                self.conn.execute(f"DROP TABLE {t}")
            self.conn.commit()
            self.conn.executescript(self.schema)
