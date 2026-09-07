"""Atomic virtual brokerage. This package contains no live order transport."""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone
import hashlib
import json
import re
import uuid
from zoneinfo import ZoneInfo

from .db import json_dump, utc_now
from .models import CommanderDecision
from .risk import number, parse_time
from .journal import mark_trade, strategy_analytics


def journal_snapshot(quote):
    """Store the requested quantitative entry features, never arbitrary credentials."""
    source = quote.get("analysis_snapshot") or {}
    articles = source.get("news") if isinstance(source.get("news"), list) else []
    daily = (source.get("technical") or {}).get("daily") or {}
    snapshot = {key: quote.get(key) for key in ("ticker", "price", "as_of", "bid", "ask", "volume", "rsi14", "market_regime")}
    snapshot.update({key: source.get(key) for key in ("rvol", "technical_score", "catalyst_score", "theme_score", "market_score", "astra_score", "setup", "risk_flags", "quote_as_of", "technical_as_of")})
    snapshot.update(macd=daily.get("macd"), vwap=daily.get("vwap"), atr=daily.get("atr14"),
                    news=[{key: article.get(key) for key in ("headline", "url", "source", "timestamp", "datetime", "sentiment")}
                          for article in articles[:20] if isinstance(article, dict)])
    return snapshot


class BrokerInterface(ABC):
    @abstractmethod
    def submit(self, decision, quote, idempotency_key, **kwargs): ...

    @abstractmethod
    def close(self, trade_id, quote, idempotency_key, **kwargs): ...


class LiveBroker(BrokerInterface):
    mode = "live"
    def submit(self, *args, **kwargs):
        return {"status": "disabled", "reason": "live_trading_not_implemented", "should_execute": False}
    def close(self, *args, **kwargs):
        return self.submit()


class PaperBroker(BrokerInterface):
    mode = "paper"
    def submit(self, *args, **kwargs):
        return {"status": "unavailable", "reason": "paper_broker_not_connected", "should_execute": False}
    def close(self, *args, **kwargs):
        return self.submit()


class ShadowBroker(BrokerInterface):
    mode = "shadow"

    def __init__(self, db, risk, initial_cash=100000.0, commission_bps=1.0, slippage_bps=2.0):
        if number(initial_cash) is None or initial_cash <= 0:
            raise ValueError("positive initial cash required")
        if any(number(x) is None or not 0 <= x <= 100 for x in (commission_bps, slippage_bps)):
            raise ValueError("simulation costs must be between 0 and 100 basis points")
        self.db, self.risk = db, risk
        self.commission_bps, self.slippage_bps = commission_bps, slippage_bps
        with db.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if conn.execute("SELECT 1 FROM shadow_accounts WHERE id='default'").fetchone() is None:
                account = {"initial_cash": float(initial_cash), "cash": float(initial_cash), "reserved_cash": 0.0,
                    "equity": float(initial_cash), "peak_equity": float(initial_cash), "day_start_equity": float(initial_cash),
                    "day": datetime.now(ZoneInfo("America/New_York")).date().isoformat(),
                    "consecutive_losses": 0, "realized_profit": 0.0, "last_trade_at": {}, "currency": "USD"}
                self._save_account(conn, account)

    @staticmethod
    def _key(key):
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_.:\-]{8,128}", key):
            raise ValueError("idempotency key must be 8..128 safe ASCII characters")
        return key

    @staticmethod
    def _now(now=None):
        result = parse_time(now) if now is not None else datetime.now(timezone.utc)
        if result is None:
            raise ValueError("timezone-aware now required")
        return result

    @staticmethod
    def _save_account(conn, account):
        conn.execute("INSERT INTO shadow_accounts VALUES('default',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", (json_dump(account),))

    @staticmethod
    def _positions(conn):
        return [json.loads(row[0]) for row in conn.execute("SELECT payload FROM shadow_positions")]

    def _account(self, conn, now):
        account = json.loads(conn.execute("SELECT payload FROM shadow_accounts WHERE id='default'").fetchone()[0])
        positions = self._positions(conn)
        equity = account["cash"] + sum(p["shares"] * p["mark_price"] for p in positions)
        account["equity"] = equity
        account["available_cash"] = max(0.0, account["cash"] - account["reserved_cash"])
        account["peak_equity"] = max(account["peak_equity"], equity)
        day = now.astimezone(ZoneInfo("America/New_York")).date().isoformat()
        if day != account.get("day"):
            account["day"], account["day_start_equity"] = day, equity
        account["daily_profit"] = equity - account["day_start_equity"]
        account["marks_status"] = "partial" if any(not parse_time(p.get("mark_timestamp")) or
            (now - parse_time(p["mark_timestamp"])).total_seconds() > self.risk.limits.max_quote_age_seconds for p in positions) else "ok"
        account["position_count"] = len(positions)
        account["as_of"] = now.isoformat()
        self._save_account(conn, account)
        return account

    def account(self, now=None):
        with self.db.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            return self._account(conn, self._now(now))

    def positions(self):
        with self.db.connection() as conn:
            return self._positions(conn)

    def trades(self, limit=1000):
        return self.db.list_records("shadow_trades", limit=limit)

    def orders(self, limit=300):
        with self.db.connection() as conn:
            return [json.loads(r[0]) for r in conn.execute("SELECT payload FROM shadow_orders ORDER BY created_at DESC LIMIT ?", (min(max(1, limit), 10000),))]

    def _event(self, conn, event, payload):
        id = uuid.uuid4().hex
        self.db.put_record(conn, "trade_events", id, {"id": id, "event": event, "timestamp": utc_now(), **payload})

    def _save_order(self, conn, order):
        conn.execute("INSERT INTO shadow_orders VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload",
            (order["id"], order["idempotency_key"], order["ticker"], order["status"], order["created_at"], json_dump(order)))
        self.db.put_record(conn, "orders", order["id"], order, timestamp=order["created_at"])

    def _save_trade(self, conn, trade):
        for table in ("trades", "shadow_trades"):
            self.db.put_record(conn, table, trade["id"], trade, timestamp=trade.get("exit_timestamp") or trade["entry_timestamp"])
        if trade["status"] == "OPEN":
            conn.execute("INSERT INTO shadow_positions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                         (trade["id"], trade["ticker"], json_dump(trade)))

    def submit(self, decision, quote, idempotency_key, decision_id=None, now=None):
        decision = decision if isinstance(decision, CommanderDecision) else CommanderDecision.model_validate(decision)
        key, now = self._key(idempotency_key), self._now(now)
        fingerprint = hashlib.sha256(json_dump({"decision": decision.model_dump(), "decision_id": decision_id}).encode()).hexdigest()
        with self.db.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            previous = conn.execute("SELECT payload FROM shadow_orders WHERE idempotency_key=?", (key,)).fetchone()
            if previous:
                order = json.loads(previous[0])
                if order.get("fingerprint") != fingerprint:
                    self.risk.activate_kill("idempotency_conflict", conn=conn)
                    return {"status": "REJECTED", "reasons": ["idempotency_conflict"]}
                return {**order, "idempotent_replay": True}
            account = self._account(conn, now)
            positions = self._positions(conn)
            pending = [json.loads(r[0]) for r in conn.execute("SELECT payload FROM shadow_orders WHERE status='PENDING'")]
            result = self.risk.evaluate(decision, quote, account, [*positions, *pending], now, conn=conn)
            order = {"id": uuid.uuid4().hex, "idempotency_key": key, "fingerprint": fingerprint,
                "decision_id": decision_id, "ticker": decision.ticker, "created_at": now.isoformat(),
                "submitted_quote_as_of": quote.get("as_of"), "status": "PENDING" if result["approved"] else "REJECTED",
                "decision": decision.model_dump(), "risk": result, "shares": result["position_size"],
                "mode": "shadow", "should_execute": False, "reserved_cash": 0.0}
            if result["approved"]:
                reserve = result["position_size"] * decision.entry.max * (1 + self.commission_bps / 10000)
                if reserve > account["available_cash"]:
                    order["status"] = "REJECTED"
                    order["risk"] = {**result, "approved": False, "reasons": ["insufficient_cash_after_costs"]}
                else:
                    order["reserved_cash"] = reserve
                    account["reserved_cash"] += reserve
                    self._save_account(conn, account)
            self._save_order(conn, order)
            self._event(conn, "order_created" if order["status"] == "PENDING" else "order_rejected", {"order_id": order["id"], "ticker": decision.ticker, "risk": order["risk"]})
            return order

    def _cancel(self, conn, order, account, reasons, now):
        account["reserved_cash"] = max(0.0, account["reserved_cash"] - order.get("reserved_cash", 0))
        order.update(status="REJECTED", rejected_at=now.isoformat(), rejection_reasons=reasons, reserved_cash=0.0)
        self._save_account(conn, account)
        self._save_order(conn, order)
        self._event(conn, "order_rejected", {"order_id": order["id"], "ticker": order["ticker"], "reasons": reasons})

    def observe(self, quote, now=None):
        now, events = self._now(now), []
        with self.db.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            account = self._account(conn, now)
            # Expire all reservations even if the next observation is a different ticker.
            for row in conn.execute("SELECT payload FROM shadow_orders WHERE status='PENDING'").fetchall():
                order = json.loads(row[0])
                if (now - parse_time(order["created_at"])).total_seconds() > self.risk.limits.pending_expiry_seconds:
                    self._cancel(conn, order, account, ["pending_expired"], now)
                    events.append(order)
            checks = self.risk.quote_checks(quote, now, market_hours=False, entry_checks=False)
            for reason in checks["halt"]:
                self.risk.activate_kill(reason, conn=conn)
            timestamp = parse_time(quote.get("as_of"))
            ticker = quote.get("ticker")
            row = conn.execute("SELECT payload FROM shadow_positions WHERE ticker=?", (ticker,)).fetchone()
            if row and not checks["reasons"]:
                trade = json.loads(row[0])
                trade = mark_trade(trade, checks["price"], timestamp)
                self._save_trade(conn, trade)
                events.append({"status": "MARKED", "id": trade["id"], "ticker": ticker})
                if checks["bid"] <= trade["stop"]:
                    events.append(self._close_locked(conn, trade, quote, f"auto-stop:{trade['id']}", now, "stop_observed"))
            account = self._account(conn, now)
            row = conn.execute("SELECT payload FROM shadow_orders WHERE ticker=? AND status='PENDING'", (ticker,)).fetchone()
            if not row:
                return events
            order = json.loads(row[0])
            if timestamp is None or timestamp <= parse_time(order["created_at"]) or timestamp <= parse_time(order["submitted_quote_as_of"]):
                return events
            decision = CommanderDecision.model_validate(order["decision"])
            evaluate_account = dict(account)
            evaluate_account["available_cash"] += order["reserved_cash"]
            other_pending = [json.loads(r[0]) for r in conn.execute("SELECT payload FROM shadow_orders WHERE status='PENDING' AND id<>?", (order["id"],))]
            result = self.risk.evaluate(decision, quote, evaluate_account, [*self._positions(conn), *other_pending], now, conn=conn)
            if not result["approved"]:
                self._cancel(conn, order, account, result["reasons"], now)
                events.append(order)
                return events
            fill_price = checks["ask"] * (1 + self.slippage_bps / 10000)
            if fill_price > decision.entry.max or fill_price < decision.entry.min:
                self._cancel(conn, order, account, ["fill_outside_entry_range"], now)
                events.append(order)
                return events
            shares = min(order["shares"], result["position_size"])
            fee = fill_price * shares * self.commission_bps / 10000
            cost = fill_price * shares + fee
            if cost > account["cash"] - (account["reserved_cash"] - order["reserved_cash"]):
                self._cancel(conn, order, account, ["insufficient_cash_at_fill"], now)
                events.append(order)
                return events
            account["reserved_cash"] = max(0.0, account["reserved_cash"] - order["reserved_cash"])
            account["cash"] -= cost
            account["last_trade_at"][ticker] = now.isoformat()
            self._save_account(conn, account)
            trade = {"id": order["id"], "order_id": order["id"], "decision_id": order["decision_id"], "ticker": ticker,
                "status": "OPEN", "mode": "shadow", "entry": fill_price, "shares": shares,
                "entry_timestamp": timestamp.isoformat(), "entry_fee": fee, "setup": decision.setup,
                "stop": decision.stop, "targets": decision.targets, "risk_reward": result["risk_reward"],
                "entry_risk": (fill_price - decision.stop) * shares, "entry_snapshot": journal_snapshot(quote),
                "commander_decision": decision.model_dump(), "market_regime": quote.get("market_regime"),
                "reason": decision.reasons, "news": journal_snapshot(quote).get("news", []), "mark_price": fill_price,
                "mark_timestamp": timestamp.isoformat(), "observed_high": fill_price, "observed_low": fill_price,
                "maximum_favorable_excursion": 0.0, "maximum_adverse_excursion": 0.0,
                "unrealized_profit": 0.0, "unrealized_profit_pct": 0.0, "horizon_returns": {},
                "holding_sessions": 0, "execution_basis": "next_observed_ask_plus_configured_slippage",
                "commission_bps": self.commission_bps, "slippage_bps": self.slippage_bps,
                "should_execute": False}
            self._save_trade(conn, trade)
            order.update(status="FILLED", filled_at=timestamp.isoformat(), fill_price=fill_price, shares=shares, reserved_cash=0.0)
            self._save_order(conn, order)
            self._event(conn, "execution", {"ticker": ticker, "trade_id": trade["id"], "price": fill_price, "shares": shares, "mode": "shadow"})
            self.db.put_record(conn, "executions", order["id"], {"id": order["id"], "ticker": ticker, "side": "BUY", "price": fill_price, "shares": shares, "fee": fee, "timestamp": timestamp.isoformat(), "mode": "shadow"})
            self._account(conn, now)
            events.append(trade)
        return events

    def _close_locked(self, conn, trade, quote, key, now, reason, decision_id=None):
        checks = self.risk.quote_checks(quote, now, entry_checks=False)
        reasons = list(checks["reasons"])
        if quote.get("ticker") != trade["ticker"]:
            reasons.append("ticker_mismatch")
        quote_time = parse_time(quote.get("as_of"))
        if not quote_time or quote_time <= parse_time(trade["entry_timestamp"]):
            reasons.append("exit_must_follow_entry")
        mark_time = parse_time(trade.get("mark_timestamp"))
        if quote_time and mark_time and quote_time < mark_time:
            reasons.append("out_of_order_exit_quote")
        for halt in checks["halt"]:
            self.risk.activate_kill(halt, conn=conn)
        if reasons:
            self._event(conn, "order_rejected", {"trade_id": trade["id"], "side": "SELL", "reasons": reasons})
            return {"status": "REJECTED", "reasons": reasons}
        trade = mark_trade(trade, checks["price"], quote_time)
        exit_price = checks["bid"] * (1 - self.slippage_bps / 10000)
        fee = exit_price * trade["shares"] * self.commission_bps / 10000
        profit = (exit_price - trade["entry"]) * trade["shares"] - fee - trade["entry_fee"]
        account = self._account(conn, now)
        account["cash"] += exit_price * trade["shares"] - fee
        account["realized_profit"] += profit
        account["consecutive_losses"] = account["consecutive_losses"] + 1 if profit < 0 else 0
        account["last_trade_at"][trade["ticker"]] = now.isoformat()
        trade.update(status="CLOSED", exit=exit_price, exit_timestamp=quote_time.isoformat(), exit_fee=fee,
            profit=profit, profit_pct=profit / (trade["entry"] * trade["shares"] + trade["entry_fee"]) * 100,
            holding_period_seconds=(quote_time - parse_time(trade["entry_timestamp"])).total_seconds(),
            exit_reason=reason, realized_r_multiple=profit / trade["entry_risk"] if trade["entry_risk"] else None,
            close_idempotency_key=key, exit_decision_id=decision_id, unrealized_profit=0.0, unrealized_profit_pct=0.0)
        conn.execute("DELETE FROM shadow_positions WHERE id=?", (trade["id"],))
        self._save_account(conn, account)
        self._save_trade(conn, trade)
        self.db.set_control("close:" + key, {"trade_id": trade["id"], "decision_id": decision_id, "result": trade}, conn)
        execution_id = uuid.uuid4().hex
        self.db.put_record(conn, "executions", execution_id, {"id": execution_id, "ticker": trade["ticker"], "side": "SELL",
            "price": exit_price, "shares": trade["shares"], "fee": fee, "timestamp": quote_time.isoformat(), "mode": "shadow"})
        self._event(conn, "execution", {"ticker": trade["ticker"], "trade_id": trade["id"], "side": "SELL", "price": exit_price, "profit": profit})
        account = self._account(conn, now)
        for condition, reason in ((account["equity"] <= account["day_start_equity"] * (1 - self.risk.limits.max_daily_loss), "max_daily_loss"),
                (account["equity"] <= account["peak_equity"] * (1 - self.risk.limits.max_drawdown), "max_portfolio_drawdown"),
                (account["consecutive_losses"] >= self.risk.limits.max_consecutive_losses, "max_consecutive_losses")):
            if condition:
                self.risk.activate_kill(reason, conn=conn)
        return trade

    def close(self, trade_id, quote, idempotency_key, now=None, reason="human_close", decision_id=None):
        key, now = self._key(idempotency_key), self._now(now)
        with self.db.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            previous = self.db.get_control("close:" + key, conn=conn)
            if previous:
                if previous["trade_id"] != trade_id or previous.get("decision_id") != decision_id:
                    self.risk.activate_kill("idempotency_conflict", conn=conn)
                    return {"status": "REJECTED", "reasons": ["idempotency_conflict"]}
                return {**previous["result"], "idempotent_replay": True}
            row = conn.execute("SELECT payload FROM shadow_positions WHERE id=?", (trade_id,)).fetchone()
            if not row:
                return {"status": "REJECTED", "reasons": ["position_not_open"]}
            return self._close_locked(conn, json.loads(row[0]), quote, key, now, reason, decision_id)

    def analytics(self):
        account = self.account()
        return strategy_analytics(self.trades(limit=10000), account["initial_cash"])
