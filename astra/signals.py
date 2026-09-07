"""Event-driven candidate selection with persisted idempotent signal identities."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from .agents import number, obj
from .providers import timestamp, utc_now


class SignalEngine:
    def __init__(self, db=None, cooldown_seconds: int = 900):
        self.db = db
        self.cooldown_seconds = max(60, int(cooldown_seconds))
        self._seen: dict[str, datetime] = {}

    def detect(self, scanner: list[dict]) -> list[dict]:
        result = []
        now = datetime.now(timezone.utc)
        for row in scanner:
            ticker = row.get("ticker")
            if not ticker:
                continue
            events = []
            daily = obj(obj(row.get("technical")).get("daily"))
            extended = obj(obj(row.get("technical")).get("extended"))
            flags = obj(daily.get("flags"))
            rvol = number(row, "rvol"); change = number(row, "change")
            rsi = number(daily, "rsi14")
            def add(kind, priority, value=None):
                events.append({"kind": kind, "priority": priority, "value": value})
            if row.get("data_status") in {"stale", "unavailable"}:
                add("data_quality_alert", 95, row.get("data_status"))
            else:
                if rvol is not None and rvol > 2:
                    add("rvol_spike", 65, rvol)
                if change is not None and abs(change) > 3:
                    add("price_move", 55 if change > 0 else 70, change)
                if change is not None and abs(change) >= 15:
                    add("abnormal_price_move", 100, change)
                if flags.get("macdGoldenCross") is True or obj(daily.get("macd")).get("goldenCross") is True:
                    add("macd_golden_cross", 65)
                if flags.get("macdDeadCross") is True or obj(daily.get("macd")).get("deadCross") is True:
                    add("macd_dead_cross", 70)
                previous_rsi = number(obj(daily.get("previous")), "rsi14")
                if rsi is not None and previous_rsi is not None:
                    if (previous_rsi > 30 >= rsi) or (previous_rsi < 70 <= rsi) or flags.get("rsiRecovery"):
                        add("rsi_threshold", 50, rsi)
                if extended.get("breakout_20d") and (rvol or 0) >= 1.5:
                    add("volume_breakout", 80, rvol)
                if extended.get("near_52w_high"):
                    add("near_52w_high", 50)
                vwap, previous_vwap = number(daily, "vwap"), number(obj(daily.get("previous")), "vwap")
                price, previous_price = number(daily, "price"), number(obj(daily.get("previous")), "price")
                if all(v is not None for v in (vwap, previous_vwap, price, previous_price)) and previous_price <= previous_vwap and price > vwap:
                    add("vwap_breakout", 70)
                theme_delta = number(obj(row.get("theme")), "change_24h", "scoreChange24h")
                if theme_delta is not None and theme_delta >= 10:
                    add("theme_acceleration", 70, theme_delta)
            for news in obj(row.get("catalysts")).get("items", []):
                if news.get("current") and news.get("importance") == "high":
                    kind = "sec_filing" if news.get("source") == "SEC EDGAR" else "earnings" if "earnings" in news.get("categories", []) else "important_news"
                    add(kind, 85, news.get("dedupe_id", news.get("id")))
            position = obj(row.get("position"))
            stop = number(position, "stop", "stopPx"); price = number(row, "price")
            if stop is not None and price is not None and stop > 0 and price <= stop * 1.03:
                add("position_stop_proximity", 100, {"price": price, "stop": stop})
            if not events:
                continue
            row["signals"] = events
            # Daily technical events stay deduped across fresh quote ticks;
            # material news identities permit a new analysis immediately.
            event_keys = sorted((event["kind"], str(event["value"]) if event["kind"] in {"important_news", "sec_filing", "earnings"} else "") for event in events)
            signature = {"ticker": ticker, "session": row.get("technical_as_of") or str(row.get("as_of", ""))[:10], "events": event_keys}
            identity = hashlib.sha256(json.dumps(signature, sort_keys=True).encode()).hexdigest()
            existing = self.db.get_record("signals", identity) if self.db else None
            if existing or identity in self._seen:
                continue
            # Concurrent refreshes are serialized by root service; DB upsert
            # preserves the same deterministic id if a second worker observes it.
            item = {"id": identity, "ticker": ticker, "timestamp": utc_now(), "as_of": row.get("as_of"),
                    "events": events, "kinds": [e["kind"] for e in events],
                    "priority": min(100, max(e["priority"] for e in events) + max(0, len(events) - 1) * 5),
                    "signal_count": len(events), "astra_score": row.get("astra_score"),
                    "ai_eligible": row.get("data_status") not in {"stale", "unavailable"},
                    "data_status": row.get("data_status", "unavailable")}
            self._seen[identity] = now
            if self.db:
                self.db.save_record("signals", identity, item, ticker=ticker, timestamp=item["timestamp"])
            result.append(item)
        if len(self._seen) > 5000:
            self._seen = dict(sorted(self._seen.items(), key=lambda kv: kv[1])[-3000:])
        return sorted(result, key=lambda e: e["priority"], reverse=True)
