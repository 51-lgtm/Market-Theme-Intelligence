"""Deterministic controls. No model output may alter these limits or clear a halt."""
from __future__ import annotations

from datetime import datetime, timezone
import math
import uuid

from .models import CommanderDecision, RiskLimits
from .db import utc_now


LEVERAGED = frozenset("SOXL SOXS TQQQ SQQQ UPRO SPXU SPXL QLD QID SSO SDS TECL TECS FAS FAZ TNA TZA LABU LABD NUGT DUST BOIL KOLD TMF TBT BITX CONL NVDL NVDU TSLL MSTU MSTZ MUU".split())


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def parse_time(value):
    if isinstance(value, datetime):
        result = value
    elif isinstance(value, str):
        try:
            result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if result.tzinfo is None:
        return None
    return result.astimezone(timezone.utc)


def market_is_open(now):
    """Exchange calendar includes holidays and early closes; unavailable fails closed."""
    try:
        import exchange_calendars as xcals
        import pandas as pd
        calendar = xcals.get_calendar("XNYS")
        return bool(calendar.is_open_on_minute(pd.Timestamp(now).floor("min")))
    except Exception:
        return False


def risk_multiplier(confidence, regime):
    base = 1.5 if confidence >= 95 else 1.0 if confidence >= 85 else 0.5 if confidence >= 70 else 0.25
    multiplier = {"STRONG_RISK_ON": 1.0, "RISK_ON": 1.0, "NEUTRAL": 0.75,
                  "RISK_OFF": 0.5, "STRONG_RISK_OFF": 0.25}.get(regime, 0.25)
    return min(base * multiplier, 1.0)  # Hard per-trade risk remains the absolute ceiling.


class RiskEngine:
    def __init__(self, db, limits=None):
        self.db = db
        self.limits = limits if isinstance(limits, RiskLimits) else RiskLimits(**(limits or {}))

    def status(self, conn=None):
        switch = self.db.get_control("kill_switch", {"active": False, "reasons": []}, conn)
        return {"kill_switch": switch, "limits": self.limits.model_dump(), "live_enabled": False}

    def activate_kill(self, reason, *, conn=None):
        if conn is None:
            with self.db.connection() as handle:
                handle.execute("BEGIN IMMEDIATE")
                return self.activate_kill(reason, conn=handle)
        current = self.status(conn)["kill_switch"]
        reasons = list(dict.fromkeys(current.get("reasons", []) + [str(reason)[:200]]))[-50:]
        switch = {"active": True, "reasons": reasons, "activated_at": current.get("activated_at") or utc_now(),
                  "updated_at": utc_now()}
        self.db.set_control("kill_switch", switch, conn)
        if reason not in current.get("reasons", []):
            event_id = uuid.uuid4().hex
            self.db.put_record(conn, "risk_events", event_id,
                {"id": event_id, "timestamp": utc_now(), "event": "kill_switch", "reason": reason})
        return switch

    def reset_kill(self, actor, acknowledgement):
        if not isinstance(actor, str) or not actor.startswith(("human:", "user:")) or not actor.split(":", 1)[1].strip():
            raise PermissionError("authenticated human actor required")
        if acknowledgement != "RESET KILL SWITCH":
            raise PermissionError("explicit acknowledgement required")
        with self.db.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            previous = self.status(conn)["kill_switch"]
            switch = {"active": False, "reasons": [], "reset_at": utc_now(), "reset_by": actor,
                      "previous_reasons": previous.get("reasons", [])}
            self.db.set_control("kill_switch", switch, conn)
            id = uuid.uuid4().hex
            self.db.put_record(conn, "risk_events", id, {"id": id, "timestamp": utc_now(),
                "event": "kill_switch_reset", "actor": actor, "previous": previous})
        return switch

    def quote_checks(self, quote, now=None, *, market_hours=True, entry_checks=True):
        now = parse_time(now) if now is not None else datetime.now(timezone.utc)
        if now is None:
            raise ValueError("now must have timezone")
        reasons, halt = [], []
        price = number(quote.get("price"))
        as_of = parse_time(quote.get("as_of"))
        if price is None or price <= 0:
            reasons.append("invalid_price"); halt.append("invalid_price")
        if as_of is None or (now - as_of).total_seconds() > self.limits.max_quote_age_seconds or (as_of - now).total_seconds() > 5:
            reasons.append("stale_quote"); halt.append("stale_quote")
        for key in ("api_healthy", "broker_healthy"):
            if quote.get(key) is not True:
                reason = "api_failure" if key == "api_healthy" else "broker_failure"
                reasons.append(reason)
                if quote.get(key) is False:
                    halt.append(reason)
        bid, ask = number(quote.get("bid")), number(quote.get("ask"))
        if bid is None or ask is None or bid <= 0 or ask < bid:
            reasons.append("spread_unavailable")
            if bid is not None and ask is not None:
                halt.append("invalid_spread")
        elif (ask - bid) / ((ask + bid) / 2) > self.limits.max_spread_pct:
            reasons.append("abnormal_spread"); halt.append("abnormal_spread")
        elif price is not None and price > 0 and abs((ask + bid) / 2 - price) / price > self.limits.max_price_discrepancy_pct:
            reasons.append("quote_price_mismatch"); halt.append("quote_price_mismatch")
        avg_volume = number(quote.get("average_volume"))
        volume = number(quote.get("volume"))
        if entry_checks and (avg_volume is None or avg_volume <= 0 or avg_volume < self.limits.minimum_average_volume):
            reasons.append("insufficient_average_volume")
        if entry_checks and (price is None or avg_volume is None or price * avg_volume < self.limits.minimum_liquidity):
            reasons.append("insufficient_liquidity")
        if entry_checks and (volume is None or volume < 0):
            reasons.append("volume_unavailable")
        providers = quote.get("providers")
        valid = {}
        if isinstance(providers, list):
            for provider in providers:
                if not isinstance(provider, dict):
                    continue
                source = provider.get("source")
                px, timestamp = number(provider.get("price")), parse_time(provider.get("as_of"))
                if isinstance(source, str) and source.strip() and px and px > 0 and timestamp and -5 <= (now - timestamp).total_seconds() <= self.limits.max_quote_age_seconds:
                    valid[source.strip().casefold()] = px
        if len(valid) < 2:
            reasons.append("provider_consistency_unavailable")
        elif price is not None and price > 0:
            prices = [price, *valid.values()]
            if (max(prices) - min(prices)) / min(prices) > self.limits.max_price_discrepancy_pct:
                reasons.append("provider_price_mismatch"); halt.append("provider_price_mismatch")
        if market_hours and self.limits.require_market_hours and not market_is_open(now):
            reasons.append("market_closed")
        return {"reasons": reasons, "halt": halt, "now": now, "price": price, "bid": bid, "ask": ask}

    def evaluate(self, decision, quote, account, positions=None, now=None, mode="shadow", *, conn=None):
        decision = decision if isinstance(decision, CommanderDecision) else CommanderDecision.model_validate(decision)
        positions = positions or []
        checks = self.quote_checks(quote, now)
        reasons, halt = checks["reasons"], checks["halt"]
        now = checks["now"]
        if self.status(conn)["kill_switch"].get("active"):
            reasons.append("kill_switch_active")
        if mode != "shadow":
            reasons.append("broker_mode_disabled")
        if quote.get("ticker") != decision.ticker:
            reasons.append("ticker_mismatch"); halt.append("ticker_mismatch")
        if decision.action not in {"BUY", "BUY_MORE"}:
            reasons.append("not_entry_action")
        leverage_status = quote.get("leverage_status")
        if decision.ticker in LEVERAGED or leverage_status == "leveraged":
            reasons.append("leveraged_product_prohibited")
        elif leverage_status != "unleveraged":
            reasons.append("leverage_status_unavailable")
        if quote.get("data_status") != "ok":
            reasons.append("incomplete_market_data")
        if quote.get("chase_blocked") is True:
            reasons.append("chase_blocked")
        rsi, five_day = number(quote.get("rsi14")), number(quote.get("return_5d_pct"))
        if rsi is None or five_day is None:
            reasons.append("chase_data_unavailable")
        elif not 0 <= rsi <= 100 or five_day < -100:
            reasons.append("invalid_chase_data")
        if (rsi is not None and rsi >= 80) or (five_day is not None and five_day >= 25):
            reasons.append("chase_blocked")
        earnings = number(quote.get("earnings_business_days"))
        if earnings is not None and 0 <= earnings <= 3:
            reasons.append("earnings_blackout")
        if quote.get("earnings_status") != "ok":
            reasons.append("earnings_calendar_unavailable")
        if quote.get("earnings_business_days") is not None and (earnings is None or earnings < 0 or not earnings.is_integer()):
            reasons.append("invalid_earnings_calendar")
        if quote.get("market_regime") not in {"STRONG_RISK_ON", "RISK_ON", "NEUTRAL", "RISK_OFF", "STRONG_RISK_OFF"}:
            reasons.append("market_regime_unavailable")
        equity, cash = number(account.get("equity")), number(account.get("available_cash", account.get("cash")))
        peak, start = number(account.get("peak_equity")), number(account.get("day_start_equity"))
        losses = number(account.get("consecutive_losses"))
        if (any(x is None for x in (equity, cash, peak, start, losses))
                or any(x <= 0 for x in (equity, peak, start) if x is not None)
                or (cash is not None and cash < 0)
                or (losses is not None and (losses < 0 or not losses.is_integer()))
                or (equity is not None and peak is not None and peak < equity)
                or (cash is not None and equity is not None and cash > equity + 0.01)):
            reasons.append("account_data_unavailable")
        if account.get("marks_status") != "ok":
            reasons.append("stale_portfolio_marks")
        for position in positions:
            if not isinstance(position, dict) or not isinstance(position.get("ticker"), str):
                reasons.append("position_data_unavailable")
                continue
            if position.get("status") == "OPEN":
                mark = parse_time(position.get("mark_timestamp"))
                marked_price = number(position.get("mark_price"))
                if (mark is None or not -5 <= (now - mark).total_seconds() <= self.limits.max_quote_age_seconds
                        or marked_price is None or marked_price <= 0):
                    reasons.append("stale_portfolio_marks")
        if equity is not None and start and equity <= start * (1 - self.limits.max_daily_loss):
            reasons.append("max_daily_loss"); halt.append("max_daily_loss")
        if equity is not None and peak and equity <= peak * (1 - self.limits.max_drawdown):
            reasons.append("max_portfolio_drawdown"); halt.append("max_portfolio_drawdown")
        if losses is not None and losses >= self.limits.max_consecutive_losses:
            reasons.append("max_consecutive_losses"); halt.append("max_consecutive_losses")
        if len(positions) >= self.limits.max_positions:
            reasons.append("max_positions")
        if any(isinstance(p, dict) and p.get("ticker") == decision.ticker for p in positions):
            reasons.append("duplicate_position"); halt.append("duplicate_order")
        trade_history = account.get("last_trade_at")
        if not isinstance(trade_history, dict):
            reasons.append("cooldown_history_unavailable")
        trade_timestamp = trade_history.get(decision.ticker) if isinstance(trade_history, dict) else None
        last_trade = parse_time(trade_timestamp)
        if trade_timestamp is not None and last_trade is None:
            reasons.append("cooldown_history_unavailable")
        if last_trade and (now - last_trade).total_seconds() < self.limits.cooldown_seconds:
            reasons.append("cooldown")
        entry = decision.entry.max if decision.entry else None
        stop = decision.stop
        price = checks["ask"] or checks["price"]
        shares, risk_amount, rr = 0, 0.0, None
        if entry and stop and stop < entry and decision.targets:
            risk_per_share = entry - stop
            rr = (decision.targets[0] - entry) / risk_per_share
            if rr < self.limits.minimum_risk_reward or decision.risk_reward is None or decision.risk_reward < self.limits.minimum_risk_reward:
                reasons.append("insufficient_risk_reward")
            if risk_per_share / entry > self.limits.max_stop_distance_pct:
                reasons.append("stop_too_wide")
            if price is not None and price > entry * (1 + self.limits.maximum_slippage_pct):
                reasons.append("maximum_slippage")
            if price is not None and price > entry:
                reasons.append("outside_entry_range")
            if price is not None and price < decision.entry.min:
                reasons.append("outside_entry_range")
            if equity and cash is not None:
                factor = risk_multiplier(decision.confidence, quote.get("market_regime"))
                allowed_risk = equity * self.limits.max_risk_per_trade * factor
                size_risk = math.floor(allowed_risk / risk_per_share)
                size_value = math.floor(equity * self.limits.max_position_pct / entry)
                size_cash = math.floor(max(0, cash) / (entry * (1 + self.limits.maximum_slippage_pct)))
                shares = max(0, min(size_risk, size_value, size_cash, decision.position_size))
                risk_amount = shares * risk_per_share
                if shares < 1:
                    reasons.append("insufficient_position_budget")
        else:
            reasons.append("invalid_entry_plan")
        for reason in halt:
            self.activate_kill(reason, conn=conn)
        return {"approved": not reasons, "reasons": list(dict.fromkeys(reasons)),
                "position_size": shares if not reasons else 0, "risk_amount": round(risk_amount, 8),
                "risk_reward": rr, "kill_switch": self.status(conn)["kill_switch"],
                "mode": "shadow", "live_enabled": False, "evaluated_at": now.isoformat()}
