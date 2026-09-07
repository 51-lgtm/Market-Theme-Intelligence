"""Event driven application orchestration; no LLM can call a broker directly."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import uuid
from datetime import datetime, timezone, timedelta

from .config import Settings
from .db import Database
from .risk import RiskEngine, RiskLimits, parse_time
from .brokers import ShadowBroker
from .journal import strategy_analytics, similar_trades
from .providers import LegacyProvider
from .agents import analyze_evidence, summarize_market, summarize_themes, portfolio_analysis, normalize_bars
from .signals import SignalEngine
from .commander import Commander, compact_evidence
from .models import CommanderDecision

LOG = logging.getLogger("astra.events")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def finite(value):
    if isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value):
        return value
    return None


def evidence_fingerprint(row):
    return hashlib.sha256(json.dumps(compact_evidence(row), sort_keys=True, default=str, allow_nan=False).encode()).hexdigest()


def current_features(row):
    return {**{key: row.get(key) for key in ("rvol", "technical_score", "catalyst_score", "theme_score", "market_score", "astra_score")},
            "rsi14": ((row.get("technical") or {}).get("daily") or {}).get("rsi14")}


class TradingService:
    def __init__(self, settings: Settings, *, db=None, provider=None, commander=None):
        self.settings = settings
        self.db = db or Database(settings.database_path)
        self.db.migrate()
        self.risk = RiskEngine(self.db, RiskLimits(**settings.risk_limits))
        self.broker = ShadowBroker(self.db, self.risk, initial_cash=settings.initial_cash)
        self.provider = provider or LegacyProvider(settings.legacy_url, settings.legacy_token,
                                                   timeout=75, sec_user_agent=settings.sec_user_agent,
                                                   alpha_vantage_key=settings.alpha_vantage_key)
        self.commander = commander or Commander(api_key=settings.openai_api_key,
            model=settings.commander_model, agent_model=settings.agent_model, db=self.db,
            max_calls_per_day=settings.max_ai_daily, max_calls_per_run=settings.max_ai_run)
        self.detector = SignalEngine(self.db)
        self.lock = asyncio.Lock()
        self.refresh_task = None
        self.loop_task = None
        self.last_error = None
        self.last_refresh = None
        self.evidence = {}
        self.rows = self.db.list_records("technical_snapshots", limit=100)
        for row in self.rows:
            row["data_status"] = "stale"
            row["action"] = "HOLD"
            row["risk_flags"] = list(row.get("risk_flags", [])) + ["restored_snapshot_requires_refresh"]
        self.market = {}
        self.themes = []
        self.latest_commander = {}
        self.revision = 0

    def event(self, kind: str, **payload):
        record = {"id": str(uuid.uuid4()), "kind": kind, "timestamp": now_iso(), **payload}
        self.db.save_record("system_events", record["id"], record, ticker=payload.get("ticker"), timestamp=record["timestamp"])
        LOG.info(json.dumps({"kind": kind, "id": record["id"], "ticker": payload.get("ticker")}, ensure_ascii=False))
        self.revision += 1

    def imported_positions(self):
        return self.db.list_records("positions", limit=500)

    def portfolio(self):
        imported = self.imported_positions()
        return portfolio_analysis(self.rows, imported)

    def system(self):
        return {**self.settings.public(), "status": "degraded" if self.last_error else "ok",
                "as_of": self.last_refresh, "last_error": self.last_error,
                "jobs": {"refresh_running": bool(self.refresh_task and not self.refresh_task.done()),
                         "background_enabled": self.settings.background_jobs,
                         "interval_seconds": self.settings.refresh_seconds},
                "providers": self.evidence.get("providers", self.evidence.get("provenance", {})),
                "legacy_status": self.evidence.get("status", "unavailable"),
                "broker_status": "shadow" if self.settings.broker_mode == "shadow" else "unavailable",
                "paper_reason": "Broker credentials and execution adapter not connected" if self.settings.broker_mode == "paper" else None}

    def dashboard(self):
        return {"status": self.evidence.get("status", "unavailable"), "as_of": self.last_refresh, "revision": self.revision,
                "market": self.market, "scanner": self.rows, "themes": self.themes,
                "portfolio": self.portfolio(), "signals": self.db.list_records("signals", limit=50),
                "commander": self.latest_commander, "risk": self.risk.status(), "system": self.system()}

    def queue_refresh(self, symbols=None):
        if self.refresh_task and not self.refresh_task.done():
            return {"status": "running"}
        self.refresh_task = asyncio.create_task(self.refresh(symbols), name="astra-refresh")
        return {"status": "queued"}

    async def refresh(self, symbols=None):
        async with self.lock:
            requested = list(dict.fromkeys((symbols or list(self.settings.universe)) +
                         [p["ticker"] for p in self.imported_positions()] +
                         [p["ticker"] for p in self.broker.positions()]))[:100]
            self.event("refresh_started", count=len(requested))
            try:
                combined = {"quotes": [], "buy_signals": [], "themes": [], "histories": {}, "news": {}, "sec": {}, "status": "partial"}
                for offset in range(0, len(requested), 20):
                    chunk = await self.provider.snapshot(requested[offset:offset + 20])
                    for name in ("quotes", "buy_signals"):
                        value = chunk.get(name, [])
                        combined[name].extend(list(value.values()) if isinstance(value, dict) else value)
                    for name in ("histories", "news", "sec"):
                        combined[name].update(chunk.get(name) or {})
                    for name in ("themes", "market", "provenance", "as_of", "status", "jmia_macro", "providers", "provider_errors"):
                        if name in chunk:
                            combined[name] = chunk[name]
                self.themes = summarize_themes(combined)
                self.last_refresh = now_iso()
                for theme in self.themes:
                    key = theme.get("id", theme.get("name", "unknown"))
                    theme["timestamp"] = self.last_refresh
                    theme["change_24h"] = self.theme_change(key, theme.get("score"), 1)
                    theme["change_7d"] = self.theme_change(key, theme.get("score"), 7)
                combined["theme_aggregates"] = self.themes
                self.evidence = combined
                self.rows = [row for row in analyze_evidence(combined, self.imported_positions()) if row["ticker"] in requested]
                self.market = summarize_market(combined)
                self.last_error = None if self.rows else "market_data_unavailable"
                for ticker, history in combined.get("histories", {}).items():
                    if isinstance(history, dict) and history.get("bars"):
                        stored = {**history, "ticker": ticker, "saved_at": self.last_refresh}
                        self.db.save_record("market_histories", ticker, stored, ticker=ticker, timestamp=self.last_refresh)
                for row in self.rows:
                    self.db.save_record("technical_snapshots", row["ticker"], row, ticker=row["ticker"], timestamp=self.last_refresh)
                    history_key = row["ticker"] + ":" + str(row.get("technical_as_of") or self.last_refresh)
                    self.db.save_record("technical_history", history_key, {**row, "saved_at": self.last_refresh}, ticker=row["ticker"], timestamp=self.last_refresh)
                    outputs = row.get("agent_outputs", {})
                    for output in outputs.values() if isinstance(outputs, dict) else outputs:
                        if isinstance(output, dict):
                            self.db.save_record("agent_outputs", str(uuid.uuid4()), output, ticker=row["ticker"], timestamp=self.last_refresh)
                self.db.save_record("market_regimes", self.last_refresh, self.market, timestamp=self.last_refresh)
                for theme in self.themes:
                    key = theme.get("id", theme.get("name", "unknown"))
                    theme["timestamp"] = self.last_refresh
                    self.db.save_record("themes", key, theme, timestamp=self.last_refresh)
                    self.db.save_record("theme_scores", f"{key}:{self.last_refresh}", theme, ticker=key, timestamp=self.last_refresh)
                    theme["change_24h"] = self.theme_change(key, theme.get("score"), 1)
                    theme["change_7d"] = self.theme_change(key, theme.get("score"), 7)
                for ticker, articles in combined.get("news", {}).items():
                    for article in articles if isinstance(articles, list) else []:
                        identity = hashlib.sha256(json.dumps(article, sort_keys=True, default=str).encode()).hexdigest()
                        self.db.save_record("news", identity, article, ticker=ticker, timestamp=article.get("published_at", self.last_refresh))
                fired = self.detector.detect(self.rows)
                for row in self.rows:
                    self.db.save_record("technical_snapshots", row["ticker"], row, ticker=row["ticker"], timestamp=self.last_refresh)
                for item in fired:
                    self.event("signal_fired", ticker=item.get("ticker"), signal_id=item.get("id"))
                # Only a new, deduplicated event may consume the automatic AI budget.
                self.commander.reset_run_budget()
                if self.settings.openai_api_key:
                    for ticker in list(dict.fromkeys(s.get("ticker") for s in fired if s.get("ticker") and s.get("ai_eligible")))[:self.settings.max_ai_run]:
                        await self.analyze(ticker, automatic=True)
                for row in self.rows:
                    quote = self.quote_for(row["ticker"])
                    # Closed-market daily history is valid analysis but never a fresh fill.
                    quoted_at = parse_time(quote.get("as_of"))
                    quote_age = (datetime.now(timezone.utc) - quoted_at).total_seconds() if quoted_at else None
                    if quote.get("data_status") == "ok" and quote_age is not None and 0 <= quote_age <= self.risk.limits.max_quote_age_seconds:
                        try:
                            self.broker.observe(quote)
                        except (ValueError, KeyError):
                            self.event("shadow_observation_rejected", ticker=row["ticker"])
                self.event("refresh_completed", count=len(self.rows))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = type(exc).__name__
                for row in self.rows:
                    row["data_status"] = "stale"
                    row["action"] = "HOLD"
                self.event("api_error", component="refresh", error_type=type(exc).__name__)

    def theme_change(self, theme_id, score, days):
        if finite(score) is None:
            return None
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        history = self.db.list_records("theme_scores", limit=1000, ticker=theme_id)
        candidates = []
        for record in history:
            try:
                at = datetime.fromisoformat(record.get("timestamp", record.get("as_of", "")).replace("Z", "+00:00"))
                if at.tzinfo and cutoff - timedelta(days=1) <= at <= cutoff and finite(record.get("score")) is not None:
                    candidates.append((at, record["score"]))
            except (ValueError, TypeError):
                pass
        return round(score - max(candidates)[1], 2) if candidates else None

    def quote_for(self, ticker):
        raw = next((q for q in self.evidence.get("quotes", []) if q.get("symbol", q.get("ticker")) == ticker), {})
        row = next((r for r in self.rows if r["ticker"] == ticker), {})
        daily = (row.get("technical") or {}).get("daily", {})
        original = next((r for r in self.evidence.get("buy_signals", []) if r.get("ticker", r.get("symbol")) == ticker), {})
        if not daily:
            daily = (original.get("technical") or {}).get("daily", {})
        comparison = raw.get("providerComparison") or {}
        providers = raw.get("providers", [])
        return {"ticker": ticker, "price": raw.get("price"), "as_of": raw.get("as_of", raw.get("at")),
                "bid": raw.get("bid"), "ask": raw.get("ask"),
                "volume": raw.get("volume", daily.get("volume")),
                "average_volume": (row.get("technical") or {}).get("extended", {}).get("volume_average20"),
                "providers": providers, "api_healthy": bool(raw) and not raw.get("stale", False),
                "broker_healthy": True, "leverage_status": original.get("leverageStatus", "unavailable"),
                "data_status": "ok" if raw.get("freshness") == "live" and not raw.get("delayed") else "partial",
                "rsi14": daily.get("rsi14"), "return_5d_pct": daily.get("change5dPct"),
                "earnings_status": "ok" if original.get("earningsDays") is not None else "unavailable",
                "earnings_business_days": original.get("earningsDays"),
                "market_regime": self.market.get("regime", "NEUTRAL"),
                "provider_comparison": comparison, "analysis_snapshot": row}

    async def analyze(self, ticker, *, automatic=False):
        row = next((r for r in self.rows if r["ticker"] == ticker), None)
        if not row:
            return {"status": "unavailable", "reason": "Refresh server market evidence first"}
        self.event("ai_requested", ticker=ticker)
        evidence_as_of = row.get("as_of")
        fingerprint = evidence_fingerprint(row)
        trades = self.broker.trades()
        result = await self.commander.analyze(row, similar_trades=similar_trades(trades, ticker=ticker, setup=row.get("setup"), features=current_features(row)))
        current = next((r for r in self.rows if r["ticker"] == ticker), {})
        if current.get("as_of") != evidence_as_of or evidence_fingerprint(current) != fingerprint:
            self.event("ai_decision_invalidated", ticker=ticker)
            return {"status": "stale", "reason": "evidence_changed_during_analysis"}
        if result.get("decision"):
            identity = result.get("id") or str(uuid.uuid4())
            result = {**result, "id": identity, "decision_id": identity, "ticker": ticker,
                      "as_of": now_iso(), "evidence_as_of": row.get("as_of"), "source_fingerprint": fingerprint, "automatic": automatic}
            self.db.save_record("ai_decisions", identity, result, ticker=ticker, timestamp=result["as_of"])
            self.latest_commander = result
            result["today_strategy"] = (result["decision"].get("reasons") or ["判断根拠を確認してください"])[0]
            result["risk_level"] = self.market.get("regime", "UNAVAILABLE")
            result["portfolio_action"] = result["decision"].get("action")
            row["commander"] = result
            decision = result["decision"]
            self.event("ai_decision", ticker=ticker, decision_id=identity, action=decision.get("action"))
            if automatic and self.settings.shadow_trading and not self.settings.manual_approval and decision.get("action") in {"BUY", "BUY_MORE", "SELL", "STOP"}:
                self.submit_shadow(identity, f"auto:{identity}")
        else:
            self.event("ai_error", ticker=ticker, status=result.get("status", "unavailable"))
        return result

    def submit_shadow(self, decision_id, idempotency_key):
        if not self.settings.shadow_trading or self.settings.broker_mode != "shadow":
            raise ValueError("shadow_trading_disabled")
        record = self.db.get_record("ai_decisions", decision_id)
        if not record or not record.get("decision"):
            raise ValueError("stored_decision_required")
        CommanderDecision.model_validate(record["decision"])
        ticker = record.get("ticker", record["decision"].get("ticker"))
        row = next((r for r in self.rows if r["ticker"] == ticker), {})
        if record.get("evidence_as_of") != row.get("as_of") or record.get("source_fingerprint") != evidence_fingerprint(row):
            raise ValueError("decision_evidence_changed")
        if record["decision"].get("action") in {"SELL", "STOP"}:
            replay = self.db.get_control("close:" + idempotency_key)
            positions = self.broker.positions()
            trade_id = replay.get("trade_id") if replay else next((p["id"] for p in positions if p["ticker"] == ticker), None)
            if not trade_id:
                raise ValueError("no_matching_shadow_position")
            result = self.broker.close(trade_id, self.quote_for(ticker), idempotency_key,
                                       reason="commander_" + record["decision"]["action"].lower(), decision_id=decision_id)
            self.event("shadow_closed" if result.get("status") == "CLOSED" else "order_rejected", ticker=ticker, decision_id=decision_id)
            return result
        result = self.broker.submit(record["decision"], self.quote_for(ticker),
                                    idempotency_key, decision_id=decision_id)
        self.event("shadow_order_reviewed", ticker=ticker, decision_id=decision_id)
        return result

    def ticker(self, ticker):
        row = next((r for r in self.rows if r["ticker"] == ticker), {"ticker": ticker, "data_status": "unavailable"})
        history = self.evidence.get("histories", {}).get(ticker, {})
        if not history:
            stored = self.db.get_record("market_histories", ticker)
            history = {**stored, "status": "stale", "reason": "restored_history_requires_refresh"} if stored else {}
        bars = history.get("bars", []) if isinstance(history, dict) else history
        return {**row, "history": bars[-520:], "history_status": history.get("status", "unavailable") if isinstance(history, dict) else "partial", "weekly": completed_weekly(bars),
                "news": row.get("news", self.evidence.get("news", {}).get(ticker, [])),
                "sec": self.evidence.get("sec", {}).get(ticker, []),
                "similar_trades": similar_trades(self.broker.trades(), ticker=ticker, setup=row.get("setup"), features=current_features(row)),
                "jmia": row.get("jmia", {}) if ticker == "JMIA" else None}

    async def background_loop(self):
        # Start after the UI/auth has become available; bounded sequential jobs.
        await asyncio.sleep(3)
        while True:
            if self.settings.password and self.settings.background_jobs:
                self.queue_refresh()
            await asyncio.sleep(self.settings.refresh_seconds)

    async def close(self):
        tasks = [task for task in [self.loop_task, self.refresh_task] if task and not task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self.provider.close()
        if hasattr(self.commander, "close"):
            await self.commander.close()


def completed_weekly(bars):
    """Build OHLC only for complete exchange weeks, including holiday weeks."""
    grouped = {}
    for bar in normalize_bars(bars):
        day = datetime.fromisoformat(bar["date"]).date()
        monday = day - timedelta(days=day.weekday())
        grouped.setdefault(monday, []).append(bar)
    output = []
    try:
        import exchange_calendars as xcals
        cal = xcals.get_calendar("XNYS")
        for monday, week in grouped.items():
            expected = {d.date().isoformat() for d in cal.sessions_in_range(str(monday), str(monday + timedelta(days=4)))}
            if not expected or {b["date"] for b in week} != expected:
                continue
            output.append({"date": week[-1]["date"], "open": week[0]["open"], "close": week[-1]["close"],
                           "high": max(b["high"] for b in week), "low": min(b["low"] for b in week),
                           "volume": sum(b["volume"] for b in week) if all(b["volume"] is not None for b in week) else None})
    except Exception:
        return []
    return output[-260:]
