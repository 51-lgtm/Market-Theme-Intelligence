"""SQLite persistence, additive migrations and bounded, parameterized record access."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import threading
import uuid


RECORD_TABLES = frozenset({"users", "portfolios", "positions", "trades", "trade_events",
    "shadow_trades", "signals", "technical_snapshots", "news", "catalysts", "themes",
    "theme_scores", "ai_decisions", "agent_outputs", "strategies", "strategy_stats",
    "market_regimes", "risk_events", "orders", "executions", "system_events",
    "market_histories", "technical_history"})


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def json_dump(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class Database:
    def __init__(self, path):
        self.path = str(path)
        self._lock = threading.RLock()
        self._memory = self.path == ":memory:"
        self._uri = f"file:astra-{uuid.uuid4().hex}?mode=memory&cache=shared" if self._memory else self.path
        self._anchor = self._connect() if self._memory else None
        if not self._memory:
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)

    def _connect(self):
        conn = sqlite3.connect(self._uri, uri=self._memory, timeout=15, isolation_level=None,
                               check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=15000")
        return conn

    @contextmanager
    def connection(self):
        conn = self._connect()
        try:
            yield conn
            if conn.in_transaction:
                conn.commit()
        except BaseException:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def migrate(self):
        with self._lock, self.connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("CREATE TABLE IF NOT EXISTS astra_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
            for table in RECORD_TABLES:
                conn.execute(f"CREATE TABLE IF NOT EXISTS {table}(id TEXT PRIMARY KEY,ticker TEXT,timestamp TEXT NOT NULL,payload TEXT NOT NULL)")
                conn.execute(f"CREATE INDEX IF NOT EXISTS ix_{table}_timestamp ON {table}(timestamp DESC)")
                conn.execute(f"CREATE INDEX IF NOT EXISTS ix_{table}_ticker ON {table}(ticker,timestamp DESC)")
            conn.execute("CREATE TABLE IF NOT EXISTS astra_control(key TEXT PRIMARY KEY,payload TEXT NOT NULL)")
            conn.execute("CREATE TABLE IF NOT EXISTS shadow_accounts(id TEXT PRIMARY KEY,payload TEXT NOT NULL)")
            conn.execute("CREATE TABLE IF NOT EXISTS shadow_orders(id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE NOT NULL,ticker TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL)")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_pending_ticker ON shadow_orders(ticker) WHERE status='PENDING'")
            conn.execute("CREATE TABLE IF NOT EXISTS shadow_positions(id TEXT PRIMARY KEY,ticker TEXT UNIQUE NOT NULL,payload TEXT NOT NULL)")
            conn.execute("INSERT OR IGNORE INTO astra_migrations VALUES(1,?)", (utc_now(),))
            conn.execute("INSERT OR IGNORE INTO astra_migrations VALUES(2,?)", (utc_now(),))
        return {"version": 2, "status": "ok"}

    @staticmethod
    def _table(table):
        if table not in RECORD_TABLES:
            raise ValueError("unsupported record table")
        return table

    def save_record(self, table, id, payload, ticker=None, timestamp=None):
        table = self._table(table)
        timestamp = timestamp or payload.get("timestamp") or payload.get("as_of") or utc_now()
        with self.connection() as conn:
            self.put_record(conn, table, id, payload, ticker=ticker, timestamp=timestamp)
        return payload

    def put_record(self, conn, table, id, payload, ticker=None, timestamp=None):
        table = self._table(table)
        conn.execute(f"INSERT INTO {table}(id,ticker,timestamp,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET ticker=excluded.ticker,timestamp=excluded.timestamp,payload=excluded.payload",
            (str(id), ticker or payload.get("ticker"), timestamp or utc_now(), json_dump(payload)))

    def list_records(self, table, limit=300, ticker=None):
        table = self._table(table)
        limit = max(1, min(int(limit), 10000))
        with self.connection() as conn:
            query = f"SELECT payload FROM {table}"
            args = []
            if ticker:
                query += " WHERE ticker=?"
                args.append(ticker)
            query += " ORDER BY timestamp DESC,id DESC LIMIT ?"
            args.append(limit)
            return [json.loads(x[0]) for x in conn.execute(query, args)]

    def get_record(self, table, id):
        table = self._table(table)
        with self.connection() as conn:
            row = conn.execute(f"SELECT payload FROM {table} WHERE id=?", (str(id),)).fetchone()
            return json.loads(row[0]) if row else None

    def get_control(self, key, default=None, conn=None):
        if conn is None:
            with self.connection() as handle:
                return self.get_control(key, default, handle)
        row = conn.execute("SELECT payload FROM astra_control WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_control(self, key, payload, conn=None):
        if conn is None:
            with self.connection() as handle:
                return self.set_control(key, payload, handle)
        conn.execute("INSERT INTO astra_control VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload", (key, json_dump(payload)))
