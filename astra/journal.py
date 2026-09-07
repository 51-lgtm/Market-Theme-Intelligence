"""Observed shadow outcomes and transparent, non-optimized strategy statistics."""
from __future__ import annotations

from datetime import datetime, timezone
from statistics import mean, stdev

from .risk import number, parse_time


HORIZONS = (1, 3, 5, 10, 20)


def trading_session_distance(start, end):
    start, end = parse_time(start), parse_time(end)
    if start is None or end is None or end < start:
        return None
    try:
        import exchange_calendars as xcals
        from zoneinfo import ZoneInfo
        ny = ZoneInfo("America/New_York")
        first, last = start.astimezone(ny).date(), end.astimezone(ny).date()
        sessions = xcals.get_calendar("XNYS").sessions_in_range(str(first), str(last))
        return max(0, len(sessions) - 1)
    except Exception:
        return None


def mark_trade(trade, price, as_of):
    entry = number(trade.get("entry"))
    shares = number(trade.get("shares"))
    price = number(price)
    timestamp = parse_time(as_of)
    if entry is None or entry <= 0 or shares is None or shares <= 0 or price is None or price <= 0 or timestamp is None:
        raise ValueError("valid observed price and timezone timestamp required")
    entered = parse_time(trade.get("entry_timestamp"))
    if entered is None or timestamp < entered:
        raise ValueError("observation precedes entry")
    last = parse_time(trade.get("mark_timestamp"))
    if last and timestamp <= last:
        return trade
    updated = dict(trade)
    updated["mark_price"] = price
    updated["mark_timestamp"] = timestamp.isoformat()
    updated["unrealized_profit"] = (price - entry) * shares
    updated["unrealized_profit_pct"] = (price / entry - 1) * 100
    updated["observed_high"] = max(number(trade.get("observed_high")) or entry, price)
    updated["observed_low"] = min(number(trade.get("observed_low")) or entry, price)
    updated["maximum_favorable_excursion"] = (updated["observed_high"] / entry - 1) * 100
    updated["maximum_adverse_excursion"] = (updated["observed_low"] / entry - 1) * 100
    updated["excursion_basis"] = "observed_quotes_only_not_intrabar_extrema"
    session = trading_session_distance(entered, timestamp)
    updated["holding_sessions"] = session
    horizons = dict(trade.get("horizon_returns", {}))
    if session in HORIZONS and str(session) not in horizons:
        horizons[str(session)] = {"return_pct": (price / entry - 1) * 100, "price": price,
            "as_of": timestamp.isoformat(), "basis": "first_observed_quote_on_exact_exchange_session"}
    updated["horizon_returns"] = horizons
    updated["horizon_status"] = {str(h): "observed" if str(h) in horizons else
        "missed_observation" if session is not None and session > h else "pending" for h in HORIZONS}
    return updated


def strategy_analytics(trades, initial_equity=100000.0):
    if number(initial_equity) is None or initial_equity <= 0:
        raise ValueError("initial equity must be positive")
    groups = {}
    for trade in trades:
        if trade.get("status") != "CLOSED" or number(trade.get("profit")) is None or number(trade.get("profit_pct")) is None:
            continue
        groups.setdefault(trade.get("setup", "none"), []).append(trade)
    results = []
    for setup, records in groups.items():
        chronology_available = all(parse_time(t.get("exit_timestamp")) is not None for t in records)
        records.sort(key=lambda t: parse_time(t.get("exit_timestamp")) or datetime.min.replace(tzinfo=timezone.utc))
        profits = [float(t["profit"]) for t in records]
        returns = [float(t["profit_pct"]) / 100 for t in records]
        winning = [t for t in records if t["profit"] > 0]
        losing = [t for t in records if t["profit"] < 0]
        gross_win, gross_loss = sum(max(0, p) for p in profits), abs(sum(min(0, p) for p in profits))
        curve, peak, drawdown = initial_equity, initial_equity, 0.0
        for profit in profits:
            curve += profit
            peak = max(peak, curve)
            drawdown = max(drawdown, (peak - curve) / peak)
        deviation = stdev(returns) if len(returns) >= 2 else 0.0
        holdings = [t["holding_sessions"] for t in records if number(t.get("holding_sessions")) is not None]
        mfes = [t["maximum_favorable_excursion"] for t in records if number(t.get("maximum_favorable_excursion")) is not None]
        maes = [t["maximum_adverse_excursion"] for t in records if number(t.get("maximum_adverse_excursion")) is not None]
        results.append({"setup": setup, "trade_count": len(records),
            "win_rate": len(winning) / len(records) * 100,
            "average_win": mean([t["profit_pct"] for t in winning]) if winning else None,
            "average_loss": mean([t["profit_pct"] for t in losing]) if losing else None,
            "expectancy": mean([t["profit_pct"] for t in records]),
            "expectancy_dollars": mean(profits), "total_profit": sum(profits),
            "profit_factor": gross_win / gross_loss if gross_loss else None,
            "profit_factor_status": "ok" if gross_loss else "unavailable_no_losses",
            "maximum_drawdown": drawdown * 100 if chronology_available else None,
            "drawdown_status": "ok" if chronology_available else "unavailable_exit_timestamps",
            "drawdown_basis": "chronological_realized_pnl_curve_fixed_initial_capital",
            "drawdown_initial_equity": initial_equity,
            "sharpe_ratio": mean(returns) / deviation if deviation else None,
            "sharpe_basis": "per_trade_nonannualized_zero_risk_free_rate",
            "average_holding_period": mean(holdings) if holdings else None,
            "holding_period_unit": "XNYS_sessions",
            "mfe": mean(mfes) if mfes else None, "mae": mean(maes) if maes else None,
            "excursion_basis": "observed_quotes_only_not_intrabar_extrema",
            "sample_status": "partial_small_sample" if len(records) < 30 else "ok"})
    return sorted(results, key=lambda r: r["trade_count"], reverse=True)


def similar_trades(trades, ticker=None, setup=None, features=None, limit=10):
    features = features or {}
    keys = ("rsi14", "rvol", "technical_score", "catalyst_score", "theme_score", "market_score", "astra_score")
    requested = sum(number(features.get(key)) is not None for key in keys)
    scores = []
    for trade in trades:
        if trade.get("status") != "CLOSED":
            continue
        distance, available = 0.0, 0
        snapshot = trade.get("entry_snapshot", {})
        if not isinstance(snapshot, dict):
            snapshot = {}
        for key in keys:
            a, b = number(features.get(key)), number(snapshot.get(key))
            if a is not None and b is not None:
                distance += abs(a - b) / (10 if key == "rvol" else 100)
                available += 1
        if available:
            # Mean feature distance plus explicit missing-evidence penalty prevents
            # a record with no measurements from outranking a measured match.
            distance = distance / available + (requested - available) / max(1, requested)
        if setup and trade.get("setup") != setup:
            distance += 2
        if ticker and trade.get("ticker") != ticker:
            distance += 0.25
        scores.append({**trade, "similarity_distance": round(distance, 5) if available or not requested else None,
            "compared_feature_count": available, "requested_feature_count": requested,
            "similarity_status": "partial" if 0 < available < requested else "ok" if available else "unavailable" if requested else "setup_only",
            "similarity_method": "setup_and_available_feature_distance_with_coverage_penalty"})
    return sorted(scores, key=lambda x: float("inf") if x["similarity_distance"] is None else x["similarity_distance"])[:max(0, min(limit, 50))]
