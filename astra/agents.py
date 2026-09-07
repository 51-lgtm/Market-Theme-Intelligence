"""Deterministic evidence agents. Scores are observations, never order authority."""
from __future__ import annotations

import hashlib
import math
import re
from datetime import datetime, timezone
from statistics import mean, pstdev
from urllib.parse import urlsplit, urlunsplit

from .providers import finite, timestamp

THEME_GROUPS = [
    ("ai", "AI", ["ai-apps", "ai-agents", "ai-cloud", "ai-software", "ai-inference"]),
    ("ai_servers", "AIサーバー", ["ai-servers", "servers"]),
    ("semiconductors", "半導体", ["ai-semiconductors", "gpu", "cpu", "asic", "fpga", "semiconductor-equipment"]),
    ("memory", "メモリ", ["hbm", "dram", "nand"]),
    ("power", "電力 / インフラ", ["utilities-power", "power-grid", "gas-turbines", "ups-power"]),
    ("bitcoin", "Bitcoin", ["bitcoin"]),
    ("bitcoin_miners", "Bitcoin miners", ["bitcoin-miners"]),
    ("quantum", "量子コンピュータ", ["quantum-computing"]),
    ("space", "宇宙", ["space"]),
    ("nuclear", "原子力", ["nuclear", "smr"]),
    ("datacenter", "データセンター", ["servers", "racks", "datacenter-networking", "optical-communications", "liquid-cooling"]),
    ("robotics", "Robotics", ["robotics", "autonomous-driving"]),
]
THEME_MEMBERS = {
    "bitcoin": ["BTC-USD", "IBIT", "FBTC", "MSTR", "COIN"],
    "bitcoin_miners": ["MARA", "RIOT", "CLSK", "CIFR", "IREN", "HUT", "BTDR"],
}
SETUPS = ["volume_breakout", "earnings_breakout", "pullback", "trend_follow", "momentum",
          "mean_reversion", "gap_and_go", "52w_high_breakout", "sector_rotation",
          "catalyst_trade", "theme_trade", "short_squeeze_candidate"]


def obj(value):
    return value if isinstance(value, dict) else {}


def rows(value):
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    value = obj(value)
    return rows(value.get("bars", value.get("points", value.get("items", []))))


def number(row, *keys):
    for key in keys:
        if key in row:
            value = finite(row[key])
            if value is not None:
                return value
    return None


def clipped(value):
    return round(min(100, max(0, value)), 2) if value is not None else None


def normalize_bars(history) -> list[dict]:
    by_date = {}
    for bar in rows(history):
        day = str(bar.get("date", bar.get("sessionDate", bar.get("at", bar.get("timestamp", "")))))[:10]
        values = {k: finite(bar.get(k)) for k in ("open", "high", "low", "close", "volume")}
        if timestamp(day) is None or values["close"] is None or values["close"] <= 0:
            continue
        # Do not manufacture OHLC from close-only Spark points.
        if any(values[k] is None or values[k] <= 0 for k in ("open", "high", "low")):
            continue
        if values["low"] > min(values["open"], values["close"]) or values["high"] < max(values["open"], values["close"]):
            continue
        if values["volume"] is not None and values["volume"] < 0:
            values["volume"] = None
        by_date[day] = {"date": day, **values}
    return [by_date[day] for day in sorted(by_date)]


def extended_technicals(history) -> dict:
    bars = normalize_bars(history)
    result = {"status": "unavailable", "bars": len(bars), "sma20": None, "sma50": None,
              "sma200": None, "bollinger": None, "gap_pct": None, "high52w": None,
              "low52w": None, "near_52w_high": None, "breakout_52w": None,
              "breakout_20d": None, "golden_cross": None, "death_cross": None,
              "volume_average20": None, "vwap": None, "vwap_status": "unavailable"}
    if not bars:
        return result
    closes = [b["close"] for b in bars]
    for period in (20, 50, 200):
        if len(closes) >= period:
            result[f"sma{period}"] = round(mean(closes[-period:]), 6)
    if len(closes) >= 20:
        avg, sd = mean(closes[-20:]), pstdev(closes[-20:])
        result["bollinger"] = {"middle": avg, "upper": avg + 2 * sd, "lower": avg - 2 * sd, "period": 20, "deviations": 2}
    if len(closes) >= 2:
        result["gap_pct"] = round((bars[-1]["open"] / closes[-2] - 1) * 100, 4)
    if len(closes) >= 21:
        result["breakout_20d"] = closes[-1] > max(b["high"] for b in bars[-21:-1])
        volumes = [b["volume"] for b in bars[-21:-1]]
        if all(v is not None for v in volumes):
            result["volume_average20"] = mean(volumes)
    if len(closes) >= 252:
        result["high52w"] = max(b["high"] for b in bars[-252:])
        result["low52w"] = min(b["low"] for b in bars[-252:])
        result["near_52w_high"] = closes[-1] >= result["high52w"] * .97
    if len(closes) >= 253:
        result["breakout_52w"] = closes[-1] > max(b["high"] for b in bars[-253:-1])
    if len(closes) >= 201:
        previous50, previous200 = mean(closes[-51:-1]), mean(closes[-201:-1])
        result["golden_cross"] = previous50 <= previous200 and result["sma50"] > result["sma200"]
        result["death_cross"] = previous50 >= previous200 and result["sma50"] < result["sma200"]
    result["as_of"] = bars[-1]["date"]
    result["status"] = "ok" if len(bars) >= 253 else "partial"
    return result


class TechnicalAgent:
    name = "technical"

    def analyze(self, signal: dict, history=None) -> dict:
        technical = obj(signal.get("technical", signal.get("indicators")))
        daily, weekly = obj(technical.get("daily")), obj(technical.get("weekly"))
        extended = extended_technicals(history)
        checks = []
        def check(name, weight, value):
            checks.append({"name": name, "weight": weight, "value": value if isinstance(value, bool) else None})
        rsi = number(daily, "rsi14")
        macd = obj(daily.get("macd"))
        flags = obj(daily.get("flags"))
        ema = obj(flags.get("ema"))
        check("rsi_balanced", 10, 40 <= rsi < 70 if rsi is not None else None)
        dif, dea = number(macd, "dif", "line"), number(macd, "dea", "signal")
        check("macd_bullish", 15, dif > dea if dif is not None and dea is not None else None)
        for period, weight in ((20, 10), (50, 10), (200, 10)):
            px, level = number(daily, "price"), number(daily, f"ema{period}")
            above = daily.get(f"priceAboveEma{period}", ema.get(f"priceAboveEma{period}"))
            if above is None and px is not None and level is not None:
                above = px > level
            check(f"ema{period}", weight, above)
        check("volume_expansion", 10, flags.get("volumeExpansion", obj(flags.get("volume")).get("expansion")))
        wrsi = number(weekly, "rsi14")
        check("weekly_rsi", 10, wrsi >= 50 if wrsi is not None else None)
        wd, ws = number(obj(weekly.get("macd")), "dif", "line"), number(obj(weekly.get("macd")), "dea", "signal")
        check("weekly_macd", 10, wd > ws if wd is not None and ws is not None else None)
        wp, we = number(weekly, "price"), number(weekly, "ema20")
        check("weekly_ema20", 10, wp > we if wp is not None and we is not None else None)
        check("breakout", 5, extended.get("breakout_20d"))
        observed = sum(c["weight"] for c in checks if c["value"] is not None)
        score = sum(c["weight"] for c in checks if c["value"] is True) if observed else None
        status = "unavailable" if not observed else "ok" if observed == 100 else "partial"
        if signal.get("dataStatus", signal.get("status")) == "unavailable":
            status, score = "unavailable", None
        elif signal.get("stale") or signal.get("dataStatus") == "stale":
            status = "stale"
        return {"agent": self.name, "score": clipped(score), "status": status,
                "coverage": observed / 100, "daily": daily, "weekly": weekly,
                "extended": extended, "checks": checks,
                "support": technical.get("supportCandidates", []),
                "resistance": number(daily, "high20", "priorHigh20"),
                "as_of": daily.get("asOf") or extended.get("as_of") or signal.get("asOf"),
                "source": "v14 deterministic indicators + Python OHLC calculations"}


def deduplicate_news(items: list[dict]) -> list[dict]:
    output, seen = [], set()
    for item in items:
        if not isinstance(item, dict):
            continue
        title = re.sub(r"\W+", " ", str(item.get("headline", item.get("title", ""))).lower()).strip()
        url = str(item.get("url", ""))
        try:
            parts = urlsplit(url)
            url = urlunsplit((parts.scheme, parts.netloc.lower(), parts.path.rstrip("/"), "", ""))
        except ValueError:
            url = ""
        # Repeated SEC forms can be separate disclosures; accession identity wins.
        keys = {"accession:" + str(item["id"])} if item.get("content_status") == "metadata_only" and item.get("id") else ({"title:" + title} if title else set())
        if url:
            keys.add("url:" + url)
        if not keys or seen.intersection(keys):
            continue
        seen.update(keys)
        # Distinct SEC accessions must also have distinct downstream signal ids.
        identity_source = "accession:" + str(item["id"]) if item.get("content_status") == "metadata_only" and item.get("id") else title or url
        identity = hashlib.sha256(identity_source.encode()).hexdigest()[:24]
        output.append({**item, "id": str(item.get("id", identity)), "headline": item.get("headline", item.get("title", "")), "dedupe_id": identity})
    return output


CATALYST_PATTERNS = {
    "dilution": r"\b(dilut\w*|secondary offering|share offering|equity offering|at.the.market offering)\b",
    "offering": r"\b(offering|424b5|s-3|s-1)\b",
    "buyback": r"\b(buyback|share repurchase)\b",
    "earnings": r"\b(earnings|quarterly results|financial results|10-q|10-k)\b",
    "guidance": r"\b(guidance|outlook|forecast)\b",
    "insider": r"\b(insider|form 4)\b",
    "partnership": r"\b(partnership|collaboration|strategic alliance)\b",
    "contract": r"\b(contract|government award|order backlog)\b",
    "fda": r"\b(fda|clinical trial|phase [123])\b",
    "analyst": r"\b(upgrade|downgrade|price target|analyst)\b",
    "sec": r"\b(8-k|10-q|10-k|6-k|20-f|sec filing)\b",
}


class CatalystAgent:
    name = "catalyst"

    def analyze(self, signal: dict, news=None, sec=None) -> dict:
        items = deduplicate_news(rows(news) + rows(sec))
        classified = []
        now = datetime.now(timezone.utc)
        for item in items:
            text = " ".join(str(item.get(k, "")) for k in ("headline", "title", "summary", "form"))[:12000]
            categories = [name for name, pattern in CATALYST_PATTERNS.items() if re.search(pattern, text, re.I)]
            at = next((parsed for key in ("at", "datetime", "timestamp", "publishedAt", "published_at", "filing_date")
                       if (parsed := timestamp(item.get(key))) is not None), None)
            current = at is not None and 0 <= (now - at).total_seconds() <= 7 * 86400
            # Headlines are only labelled by literal wording. SEC form metadata
            # alone never establishes financial impact or sentiment.
            sentiment = str(item.get("sentiment", "unknown")).lower()
            if sentiment not in {"positive", "negative", "neutral"}:
                sentiment = "unknown"
            if item.get("content_status") == "metadata_only":
                sentiment = "unknown"
            if sentiment == "unknown" and item.get("content_status") != "metadata_only":
                negative = bool(re.search(r"\b(bankrupt\w*|fraud|cuts guidance|lowers guidance|fda rejects|recall|dilution|misses estimates)\b", text, re.I))
                positive = bool(re.search(r"\b(raises guidance|beats estimates|fda approves|awarded.{0,30}contract|share repurchase authorized)\b", text, re.I))
                ambiguous = bool(re.search(r"\b(not|denies?|denied|rumou?r|unconfirmed|may|might)\b", text, re.I))
                sentiment = "unknown" if ambiguous else "negative" if negative else "positive" if positive else "unknown"
            classified.append({**item, "categories": categories, "sentiment": sentiment,
                               "timestamp": at.isoformat() if at else None,
                               "current": current, "timestamp_valid": at is not None,
                               "classification_method": "provider_or_literal_rule", "importance": "high" if categories else "normal"})
        fund = obj(signal.get("fundamental"))
        fund_at = timestamp(obj(fund.get("provenance")).get("retrievedAt", fund.get("as_of")))
        fund_current = fund_at is not None and 0 <= (now - fund_at).total_seconds() <= 86400
        flags = obj(fund.get("flags")) if fund_current and fund.get("status") in {"ok", "partial"} else {}
        current_news = [n for n in classified if n["current"]]
        # Fundamentals are supplied as current-only provider observations. No
        # headline score is promoted to a verified earnings beat.
        positive_count = sum(n["sentiment"] == "positive" for n in current_news)
        negative_count = sum(n["sentiment"] == "negative" for n in current_news)
        known_flags = [v for v in flags.values() if isinstance(v, bool)] if fund.get("status") in {"ok", "partial"} else []
        observed = bool(known_flags or positive_count or negative_count)
        score = 50 if observed else None
        if score is not None:
            score += 15 * (flags.get("goodEarnings") is True) + 15 * (flags.get("guidanceUp") is True)
            score += 10 * (flags.get("revenueGrowth") is True) + 10 * (flags.get("positiveCatalyst") is True)
            score += min(15, positive_count * 5) - min(50, negative_count * 25)
            score -= 40 * (flags.get("negativeMaterial") is True)
        return {"agent": self.name, "score": clipped(score),
                "status": "ok" if observed and fund_current and fund.get("status") == "ok" else "partial" if observed or classified else "unavailable",
                "items": classified, "positive_count": positive_count, "negative_count": negative_count,
                "fundamental": {**fund, "flags": flags, "current": fund_current}, "earnings_days": signal.get("earningsDays"),
                "negative_material": flags.get("negativeMaterial") is True or negative_count > 0,
                "source": "connected news / SEC metadata / v14 current fundamental evidence"}


def summarize_market(evidence: dict) -> dict:
    market = obj(evidence.get("market"))
    existing = obj(market.get("regime"))
    score = number(existing, "optimismScore", "score")
    if score is None:
        score = number(market, "score", "market_score")
    if market.get("status") in {"unavailable", "stale"} or score is not None and not 0 <= score <= 100:
        score = None
    state = ("STRONG_RISK_ON" if score >= 80 else "RISK_ON" if score >= 60 else "NEUTRAL" if score >= 40
             else "RISK_OFF" if score >= 20 else "STRONG_RISK_OFF") if score is not None else "UNAVAILABLE"
    quote_map = {q.get("ticker", q.get("symbol")): q for q in rows(evidence.get("quotes"))}
    symbols = {"SPY": "SPY", "QQQ": "QQQ", "IWM": "IWM", "VIX": "^VIX", "BTC": "BTC-USD",
               "Treasury Yield": "^TNX", "USD": "DX-Y.NYB", "WTI": "CL=F", "USD/JPY": "JPY=X"}
    instruments = {}
    legacy_indicators = obj(market.get("indicators", market.get("instruments")))
    for name, symbol in symbols.items():
        q = obj(quote_map.get(symbol))
        fallback = obj(legacy_indicators.get({"VIX": "vix", "WTI": "wti", "SPY": "spy"}.get(name, name.lower())))
        price = number(q, "price", "last")
        if price is None:
            price = number(fallback, "level", "price", "value")
        instruments[name] = {"symbol": symbol, "price": price, "change": number(q, "changePct", "changePercent", "change"),
                             "as_of": q.get("at", q.get("as_of", q.get("asOf", fallback.get("asOf")))),
                             "source": q.get("source", q.get("src", fallback.get("source"))),
                             "status": q.get("freshness", q.get("status", "partial" if price is not None else "unavailable"))}
    return {"agent": "market", "score": clipped(score), "regime": state,
            "risk_score": 100 - score if score is not None else None,
            "status": market.get("status", "partial" if score is not None else "unavailable"),
            "as_of": market.get("asOf", market.get("as_of")), "instruments": instruments,
            "reasons": existing.get("reasons", []), "warnings": market.get("warnings", []),
            "source": "v14 VIX/WTI/SPY regime model; supplementary market quotes"}


def summarize_themes(evidence: dict) -> list[dict]:
    if isinstance(evidence.get("theme_aggregates"), list):
        return evidence["theme_aggregates"]
    source = rows(evidence.get("themes"))
    by_id = {t.get("id"): t for t in source}
    output = []
    for identity, name, children in THEME_GROUPS:
        members = [by_id[c] for c in children if c in by_id]
        valid = [t for t in members if t.get("status") == "ok" and number(t, "score") is not None and 0 <= number(t, "score") <= 100
                 and not obj(obj(obj(t.get("availability")).get("price")).get("observationFreshness")).get("stale")]
        # Fixed constituent weights: absent children never increase the score
        # assigned to remaining themes. Partial baskets stay nonactionable.
        score = sum(number(t, "score") for t in valid) / len(children) if valid else None
        tickers = sorted({str(s.get("symbol", s.get("ticker", ""))) if isinstance(s, dict) else str(s)
                          for t in members for s in t.get("relatedTickers", t.get("tickers", []))})
        if not tickers:
            tickers = THEME_MEMBERS.get(identity, [])
        output.append({"id": identity, "name": name, "score": clipped(score),
                       "status": "ok" if len(valid) == len(children) else "partial" if valid else "unavailable",
                       "related_tickers": tickers, "children": children,
                       "coverage": len(valid) / len(children),
                       "change_24h": None, "change_7d": None,
                       "as_of": max((str(t.get("asOf") or (rows(t.get("history"))[-1].get("date") if rows(t.get("history")) else "")) for t in valid), default=None),
                       "history_status": "requires_persisted_snapshots", "source": "v14 theme basket scores"})
    return output


class ThemeAgent:
    name = "theme"

    def analyze(self, ticker, signal, themes):
        direct = obj(signal.get("theme"))
        matches = [t for t in themes if ticker in t.get("related_tickers", [])]
        if direct.get("status") == "ok" and number(direct, "score") is not None and 0 <= number(direct, "score") <= 100 and not direct.get("stale"):
            scored_matches = [t for t in matches if t.get("status") == "ok" and number(t, "score") is not None]
            primary = max(scored_matches, key=lambda t: t["score"], default={})
            return {"agent": self.name, **direct, "score": number(direct, "score"), "themes": matches,
                    "change_24h": primary.get("change_24h"), "change_7d": primary.get("change_7d")}
        valid = [t for t in matches if t.get("status") == "ok" and number(t, "score") is not None and 0 <= number(t, "score") <= 100]
        best = max(valid, key=lambda t: t["score"], default=None)
        return {"agent": self.name, "score": best["score"] if best else None,
                "name": best["name"] if best else direct.get("name"),
                "status": "ok" if best else "partial" if matches or direct else "unavailable",
                "themes": matches, "trend": direct.get("trend"), "breadth": number(direct, "breadth"),
                "change_24h": (best or {}).get("change_24h"), "change_7d": (best or {}).get("change_7d")}


def recognize_setups(technical, catalysts, theme, signal) -> list[str]:
    daily = obj(technical.get("daily")); ext = obj(technical.get("extended"))
    flags = obj(daily.get("flags")); rvol = number(daily, "rvol20", "rvol")
    change = number(daily, "change1dPct"); rsi = number(daily, "rsi14")
    selected = []
    if ext.get("breakout_20d") and rvol is not None and rvol > 2:
        selected.append("volume_breakout")
    if ext.get("breakout_20d") and obj(obj(catalysts.get("fundamental")).get("flags")).get("goodEarnings") is True:
        selected.append("earnings_breakout")
    if ext.get("breakout_52w"):
        selected.append("52w_high_breakout")
    if (ext.get("gap_pct") or 0) >= 3 and (change or 0) >= 3 and (rvol or 0) >= 1.5:
        selected.append("gap_and_go")
    if flags.get("ema20Recovery") and 40 <= (rsi or -1) < 60:
        selected.append("pullback")
    if obj(flags.get("ema")).get("bullishAlignment"):
        selected.append("trend_follow")
    if (change or 0) > 3 and (rvol or 0) > 1.5:
        selected.append("momentum")
    if flags.get("rsiRecovery"):
        selected.append("mean_reversion")
    if catalysts.get("positive_count", 0) > 0:
        selected.append("catalyst_trade")
    if theme.get("score") is not None and theme["score"] >= 75:
        selected.append("theme_trade")
    if number(theme, "flowVelocity", "flow_velocity") is not None and number(theme, "flowVelocity", "flow_velocity") > 0 and theme.get("trend") == "up":
        selected.append("sector_rotation")
    short = obj(signal.get("short_interest"))
    if number(short, "float_pct") is not None and number(short, "float_pct") >= 20 and (rvol or 0) > 2:
        selected.append("short_squeeze_candidate")
    return selected


def regime_weights(regime: str) -> dict:
    if regime in {"RISK_OFF", "STRONG_RISK_OFF"}:
        return {"technical": .20, "catalyst": .20, "theme": .10, "market": .25, "momentum": .05, "risk_reward": .20}
    return {"technical": .25, "catalyst": .25, "theme": .15, "market": .15, "momentum": .10, "risk_reward": .10}


def analyze_evidence(evidence: dict, positions: list[dict] | None = None) -> list[dict]:
    market = summarize_market(evidence); themes = summarize_themes(evidence)
    signals = {s.get("ticker", s.get("symbol")): s for s in rows(evidence.get("buy_signals")) if isinstance(s.get("ticker", s.get("symbol")), str)}
    quotes = {s.get("ticker", s.get("symbol")): s for s in rows(evidence.get("quotes")) if isinstance(s.get("ticker", s.get("symbol")), str)}
    histories = obj(evidence.get("histories")); news = obj(evidence.get("news")); sec = obj(evidence.get("sec"))
    positions_map = {p.get("ticker", p.get("symbol")): p for p in positions or []}
    symbols = sorted(set(signals) | {s for s in quotes if s not in {"^VIX", "^TNX", "CL=F", "DX-Y.NYB", "BTC-USD", "JPY=X"}})
    output = []
    for ticker in symbols:
        signal = obj(signals.get(ticker)); quote = obj(quotes.get(ticker))
        technical = TechnicalAgent().analyze(signal, histories.get(ticker))
        catalysts = CatalystAgent().analyze(signal, news.get(ticker), sec.get(ticker))
        theme = ThemeAgent().analyze(ticker, signal, themes)
        daily = obj(technical.get("daily")); price = number(quote, "price", "last")
        quote_as_of = quote.get("at", quote.get("as_of", quote.get("asOf", quote.get("timestamp"))))
        if price is not None and price <= 0:
            price = None
        if price is None:
            price = number(signal, "price")
        rvol = number(daily, "rvol20", "rvol"); change = number(quote, "changePct", "changePercent")
        if change is None:
            change = number(daily, "change1dPct")
        history_bars = normalize_bars(histories.get(ticker))
        volume = number(quote, "volume")
        if volume is None and history_bars:
            volume = history_bars[-1]["volume"]
        momentum = clipped(50 + change * 5 + (rvol - 1) * 10) if rvol is not None and change is not None else None
        rr = number(signal, "riskReward", "risk_reward")
        if rr is None:
            rr = number(obj(signal.get("riskReward")), "ratio")
        if rr is None:
            rr = number(obj(signal.get("riskRewardDetail")), "ratio")
        if rr is None:
            rr = number(obj(signal.get("positionPlan")), "riskReward")
        rr_score = clipped(rr / 3 * 100) if rr is not None else None
        scores = {"technical": technical["score"], "catalyst": catalysts["score"], "theme": theme["score"],
                  "market": market["score"], "momentum": momentum, "risk_reward": rr_score}
        weights = regime_weights(market["regime"])
        coverage = sum(weights[k] for k, v in scores.items() if v is not None)
        score = clipped(sum((v or 0) * weights[k] for k, v in scores.items())) if coverage else None
        flags = [str(w) for w in signal.get("warnings", []) if isinstance(w, (str, int, float))]
        blocked = []
        if signal.get("chaseBlocked"):
            blocked.append("chase_blocked")
        if signal.get("leverageStatus") != "unleveraged":
            blocked.append("leveraged_or_unknown_product")
        if signal.get("earningsBlocked") or (number(signal, "earningsDays") is not None and 0 <= number(signal, "earningsDays") <= 3):
            blocked.append("earnings_within_3_sessions")
        if signal.get("stale") or signal.get("dataStatus") == "stale":
            blocked.append("stale_technical_data")
        if rr is None or rr < 1.8:
            blocked.append("insufficient_risk_reward")
        if catalysts["negative_material"]:
            blocked.append("negative_material")
        if timestamp(quote_as_of) is None:
            blocked.append("quote_timestamp_unavailable")
        else:
            age = (datetime.now(timezone.utc) - timestamp(quote_as_of)).total_seconds()
            if age < -5 or age > 120 or quote.get("freshness") != "live" or quote.get("delayed"):
                blocked.append("quote_not_execution_fresh")
        if technical["status"] != "ok" or catalysts["status"] != "ok" or theme["status"] != "ok" or market["status"] != "ok":
            blocked.append("incomplete_agent_evidence")
        if coverage < 1:
            flags.append("partial_agent_coverage")
        decision = "BUY" if score is not None and score >= 80 and not blocked and coverage >= .99 else "HOLD" if score is not None and score >= 60 else "AVOID"
        tier = ("EXTREME" if score >= 90 else "STRONG" if score >= 80 else "WATCH" if score >= 70 else "NEUTRAL" if score >= 60 else "AVOID") if score is not None else "UNAVAILABLE"
        setups = recognize_setups(technical, catalysts, theme, signal)
        agent_statuses = {"technical": technical, "catalyst": catalysts, "theme": theme, "market": market}
        confidence_coverage = sum(weights[k] * (float(agent_statuses[k].get("coverage", 1 if agent_statuses[k].get("status") == "ok" else .5))
                                                    if k in agent_statuses else 1)
                                  for k, value in scores.items() if value is not None)
        output.append({"ticker": ticker, "price": price, "change": change, "volume": volume, "rvol": rvol,
                       **{k + "_score": scores[k] for k in ("technical", "catalyst", "theme", "market")},
                       "total_score": score, "astra_score": score, "tier": tier, "action": decision,
                       "confidence": round(min(1, max(0, confidence_coverage)) * 100), "confidence_basis": "evidence_coverage_not_win_probability",
                       "setup": setups[0] if setups else "unavailable", "setups": setups,
                       "technical": technical, "catalysts": catalysts, "theme": theme, "market": market,
                       "agent_outputs": {"technical": technical, "catalyst": catalysts, "theme": theme, "market": market},
                       "weights": weights, "component_scores": scores, "signals": [],
                       "data_status": "unavailable" if price is None or technical["status"] == "unavailable" else "stale" if "stale_technical_data" in blocked else "partial" if coverage < 1 or "incomplete_agent_evidence" in blocked else "ok",
                       "as_of": quote_as_of or signal.get("asOf"), "quote_as_of": quote_as_of,
                       "technical_as_of": technical.get("as_of"), "quote": quote,
                       "reasons": signal.get("reasons", []), "risk_flags": sorted(set(flags + blocked)),
                       "entry_plan": signal.get("positionPlan", {}), "risk_reward": rr,
                       "position": positions_map.get(ticker), "news": catalysts["items"], "sec": rows(sec.get(ticker)),
                       "leverage_status": signal.get("leverageStatus", "unavailable"),
                       "earnings_days": signal.get("earningsDays"), "chase_blocked": bool(signal.get("chaseBlocked")),
                       "jmia": jmia_analysis(signal, catalysts, evidence) if ticker == "JMIA" else {}})
    output.sort(key=lambda r: r["astra_score"] if r["astra_score"] is not None else -1, reverse=True)
    for rank, item in enumerate(output, 1):
        item["rank"] = rank
    return output


def portfolio_analysis(scanner: list[dict], positions: list[dict]) -> list[dict]:
    by_ticker = {r["ticker"]: r for r in scanner}
    output = []
    for position in positions:
        ticker = position.get("ticker", position.get("symbol"))
        row = obj(by_ticker.get(ticker)); price = number(row, "price")
        average = number(position, "average_cost", "averageCost", "avgCost")
        shares = number(position, "shares", "quantity")
        stop = number(position, "stop", "stopPx")
        action, reason = "HOLD", "No complete buy/exit evidence"
        if price is not None and stop is not None and price <= stop:
            action, reason = "STOP", "Observed price at or below recorded stop"
        elif obj(row.get("catalysts")).get("negative_material"):
            action, reason = "SELL", "Adverse current material; review evidence"
        elif row.get("chase_blocked"):
            action, reason = "TRIM", "Overextended setup; review existing exposure"
        elif row.get("action") == "BUY" and row.get("leverage_status") == "unleveraged":
            action, reason = "BUY_MORE", "Complete positive evidence; independent risk review still required"
        if row.get("data_status") in {"stale", "unavailable"}:
            action, reason = "HOLD", "Unavailable/stale evidence; no actionable recommendation"
        pnl = (price - average) * shares if all(v is not None for v in (price, average, shares)) else None
        output.append({**position, "ticker": ticker, "price": price, "average_cost": average,
                       "shares": shares, "unrealized_pnl": pnl, "unrealized_pnl_pct": ((price / average - 1) * 100) if price is not None and average and average > 0 else None,
                       "realized_pnl": number(position, "realized_pnl", "realizedPnl"),
                       "position_value": price * shares if price is not None and shares is not None else None,
                       "action": action, "confidence": row.get("confidence", 0), "reason": reason,
                       "data_status": row.get("data_status", "unavailable"), "stop": stop,
                       "targets": [obj(row.get("entry_plan")).get("take1Px"), obj(row.get("entry_plan")).get("take2Px")],
                       "risk_flags": row.get("risk_flags", []), "as_of": row.get("as_of"), "analysis_only": True})
    return output


def jmia_analysis(signal, catalyst, evidence):
    fund = obj(signal.get("fundamental"))
    return {"status": "partial", "priority_watch": True, "technical": signal.get("technical", {}),
            "earnings": fund, "news": catalyst.get("items", []), "macro": evidence.get("jmia_macro", {"status": "unavailable"}),
            "cash": None, "financing": None, "dilution": [n for n in catalyst.get("items", []) if "dilution" in n.get("categories", [])],
            "logistics": None, "jumiapay": None, "profitability": None, "historical_analogs": [],
            "unavailable": ["cash", "Nigeria macro", "USD/NGN", "inflation", "logistics", "JumiaPay", "profitability progress"],
            "purpose": "Analysis support; company operating metrics require verified IR data"}


class MarketAgent:
    analyze = staticmethod(summarize_market)


class ScannerAgent:
    analyze = staticmethod(analyze_evidence)


class PortfolioAgent:
    analyze = staticmethod(portfolio_analysis)
