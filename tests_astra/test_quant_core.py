from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import math
import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError

from astra.brokers import ShadowBroker, PaperBroker, LiveBroker
from astra.db import Database
from astra.journal import mark_trade, strategy_analytics, similar_trades, trading_session_distance
from astra.models import CommanderDecision, RiskLimits
from astra.risk import RiskEngine, market_is_open, risk_multiplier


NOW = datetime(2026, 9, 4, 15, 0, tzinfo=timezone.utc)


def decision(ticker="JMIA"):
    return {"ticker": ticker, "action": "BUY", "confidence": 90.0,
        "entry": {"min": 99.0, "max": 101.0}, "stop": 95.0, "targets": [114.0, 125.0],
        "position_size": 500, "risk_reward": 2.1, "time_horizon": "swing", "setup": "pullback",
        "reasons": ["confirmed signals"], "invalidation": ["stop breaks"], "risk_flags": [], "should_execute": False}


def quote(ticker="JMIA", now=NOW, price=100.0):
    return {"ticker": ticker, "price": price, "as_of": now.isoformat(),
        "bid": price - 0.01, "ask": price + 0.01, "average_volume": 2000000.0, "volume": 3000000.0,
        "providers": [{"source": "provider_one", "price": price, "as_of": now.isoformat()},
                      {"source": "provider_two", "price": price + 0.01, "as_of": now.isoformat()}],
        "api_healthy": True, "broker_healthy": True, "leverage_status": "unleveraged",
        "data_status": "ok", "rsi14": 55.0, "return_5d_pct": 2.0, "earnings_status": "ok",
        "earnings_business_days": 15, "market_regime": "RISK_ON"}


def account():
    return {"equity": 100000.0, "cash": 100000.0, "available_cash": 100000.0,
        "peak_equity": 100000.0, "day_start_equity": 100000.0, "consecutive_losses": 0,
        "marks_status": "ok", "last_trade_at": {}}


class CoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temp.name) / "quant.sqlite3")
        self.db.migrate()
        self.risk = RiskEngine(self.db)
        self.broker = ShadowBroker(self.db, self.risk)

    def tearDown(self):
        self.temp.cleanup()

    def evaluate(self, data=None, q=None, a=None, positions=None):
        return self.risk.evaluate(data or decision(), q or quote(), a or account(), positions or [], NOW)

    def test_strict_schema_all_fields_required_and_false_execute(self):
        schema = CommanderDecision.model_json_schema()
        self.assertEqual(set(schema["required"]), set(schema["properties"]))
        data = decision(); data["should_execute"] = True
        with self.assertRaises(ValidationError): CommanderDecision.model_validate(data)
        data = decision(); data["confidence"] = "90"
        with self.assertRaises(ValidationError): CommanderDecision.model_validate(data)
        data = decision(); data["position_size"] = True
        with self.assertRaises(ValidationError): CommanderDecision.model_validate(data)
        data = decision(); data["surprise_order"] = True
        with self.assertRaises(ValidationError): CommanderDecision.model_validate(data)
        for value in (0, 0.0, "false", None):
            data = decision(); data["should_execute"] = value
            with self.assertRaises(ValidationError): CommanderDecision.model_validate(data)

    def test_risk_limits_are_immutable(self):
        with self.assertRaises(ValidationError):
            self.risk.limits.max_positions = 100

    def test_schema_rejects_nonfinite_inverted_prices_and_bad_tickers(self):
        for key, value in (("confidence", float("nan")), ("stop", float("inf")), ("ticker", "JMIA;DROP")):
            data = decision(); data[key] = value
            with self.assertRaises(ValidationError): CommanderDecision.model_validate(data)
        data = decision(); data["entry"] = {"min": 102.0, "max": 100.0}
        with self.assertRaises(ValidationError): CommanderDecision.model_validate(data)
        data = decision(); data["targets"] = [114.0, 105.0]
        with self.assertRaises(ValidationError): CommanderDecision.model_validate(data)
        data = decision(); data["stop"] = 100.0
        with self.assertRaises(ValidationError): CommanderDecision.model_validate(data)

    def test_complete_fresh_evidence_passes_but_risk_size_caps_ai(self):
        result = self.evaluate()
        self.assertTrue(result["approved"], result)
        self.assertEqual(result["position_size"], 166)
        self.assertLessEqual(result["risk_amount"], 1000)

    def test_every_missing_market_field_fails_closed(self):
        for field in ("bid", "ask", "average_volume", "volume", "providers", "api_healthy", "broker_healthy",
                      "leverage_status", "rsi14", "return_5d_pct", "earnings_status", "as_of", "price"):
            with self.subTest(field=field):
                q = quote(); q.pop(field)
                self.assertFalse(self.evaluate(q=q)["approved"])
                self.risk.reset_kill("human:test", "RESET KILL SWITCH")

    def test_stale_quote_persists_kill_across_engine_instances(self):
        q = quote(now=NOW - timedelta(seconds=121))
        self.assertIn("stale_quote", self.evaluate(q=q)["reasons"])
        self.assertTrue(RiskEngine(Database(self.db.path)).status()["kill_switch"]["active"])

    def test_future_timestamp_and_naive_timestamp_rejected(self):
        for stamp in ((NOW + timedelta(seconds=6)).isoformat(), "2026-09-04T15:00:00"):
            q = quote(); q["as_of"] = stamp
            self.assertIn("stale_quote", self.evaluate(q=q)["reasons"])

    def test_zero_negative_and_nonfinite_prices_fail_without_exception(self):
        for value in (0.0, -100.0, math.inf, math.nan, True):
            q = quote(); q["price"] = value
            self.assertIn("invalid_price", self.evaluate(q=q)["reasons"])

    def test_bid_ask_must_match_observed_trade_price(self):
        q = quote(); q.update(bid=10.0, ask=10.01)
        result = self.risk.quote_checks(q, NOW, entry_checks=False)
        self.assertIn("quote_price_mismatch", result["reasons"])
        self.assertIn("quote_price_mismatch", result["halt"])

    def test_exit_quote_checks_do_not_require_entry_liquidity(self):
        q = quote(); q.pop("volume"); q.pop("average_volume")
        self.assertTrue(self.risk.quote_checks(q, NOW)["reasons"])
        self.assertEqual(self.risk.quote_checks(q, NOW, entry_checks=False)["reasons"], [])
        q["as_of"] = (NOW - timedelta(seconds=121)).isoformat()
        self.assertIn("stale_quote", self.risk.quote_checks(q, NOW, entry_checks=False)["reasons"])

    def test_provider_discrepancy_and_duplicate_source_fail(self):
        q = quote(); q["providers"][1]["price"] = 110.0
        self.assertIn("provider_price_mismatch", self.evaluate(q=q)["reasons"])
        q = quote(); q["providers"][1]["source"] = "provider_one"
        self.assertIn("provider_consistency_unavailable", self.evaluate(q=q)["reasons"])
        q = quote(); q["providers"][1]["source"] = " Provider_One "
        self.assertIn("provider_consistency_unavailable", self.evaluate(q=q)["reasons"])

    def test_spread_and_provider_outage_halt(self):
        q = quote(); q["ask"] = 102.0
        self.assertIn("abnormal_spread", self.evaluate(q=q)["reasons"])
        q = quote(); q["api_healthy"] = False
        self.assertIn("api_failure", self.evaluate(q=q)["reasons"])
        q = quote(); q["broker_healthy"] = False
        self.assertIn("broker_failure", self.evaluate(q=q)["reasons"])

    def test_daily_drawdown_and_consecutive_loss_limits(self):
        for key, value, reason in (("equity", 97000.0, "max_daily_loss"), ("peak_equity", 120000.0, "max_portfolio_drawdown"),
                                  ("consecutive_losses", 5, "max_consecutive_losses")):
            a = account(); a[key] = value
            self.assertIn(reason, self.evaluate(a=a)["reasons"])
            self.assertTrue(self.risk.status()["kill_switch"]["active"])
            self.risk.reset_kill("human:test", "RESET KILL SWITCH")

    def test_kill_switch_cannot_be_cleared_by_ai(self):
        self.risk.activate_kill("test")
        for actor in ("ai", "commander", "human:", ""):
            with self.assertRaises(PermissionError): self.risk.reset_kill(actor, "RESET KILL SWITCH")
        with self.assertRaises(PermissionError): self.risk.reset_kill("human:admin", "yes")
        self.assertFalse(self.risk.reset_kill("human:admin", "RESET KILL SWITCH")["active"])
        self.assertTrue(any(e["event"] == "kill_switch_reset" for e in self.db.list_records("risk_events")))

    def test_leverage_chase_earnings_and_rr_override_ai(self):
        for ticker in ("SOXL", "MUU", "MSTU"):
            self.assertIn("leveraged_product_prohibited", self.evaluate(decision(ticker), quote(ticker))["reasons"])
        for key, value, reason in (("rsi14", 80.0, "chase_blocked"), ("return_5d_pct", 25.0, "chase_blocked"),
                                  ("earnings_business_days", 3, "earnings_blackout")):
            q = quote(); q[key] = value
            self.assertIn(reason, self.evaluate(q=q)["reasons"])
        data = decision(); data["targets"] = [105.0]; data["risk_reward"] = 100.0
        self.assertIn("insufficient_risk_reward", self.evaluate(data)["reasons"])

    def test_max_positions_cooldown_cash_and_position_limit(self):
        self.assertIn("max_positions", self.evaluate(positions=[{"ticker": str(i)} for i in range(5)])["reasons"])
        a = account(); a["last_trade_at"] = {"JMIA": (NOW - timedelta(seconds=899)).isoformat()}
        self.assertIn("cooldown", self.evaluate(a=a)["reasons"])
        a = account(); a["available_cash"] = 100.0
        self.assertIn("insufficient_position_budget", self.evaluate(a=a)["reasons"])
        q = quote(); q["market_regime"] = "STRONG_RISK_OFF"
        self.assertLess(self.evaluate(q=q)["position_size"], self.evaluate()["position_size"])

    def test_missing_or_impossible_account_state_fails_closed(self):
        for field in ("equity", "peak_equity", "day_start_equity", "consecutive_losses", "marks_status", "last_trade_at"):
            a = account(); a.pop(field)
            self.assertFalse(self.evaluate(a=a)["approved"], field)
        for key, value in (("consecutive_losses", -1), ("consecutive_losses", 0.5),
                           ("peak_equity", 99999.0), ("available_cash", -1.0),
                           ("available_cash", 100001.0), ("last_trade_at", {"JMIA": "invalid"})):
            a = account(); a[key] = value
            self.assertFalse(self.evaluate(a=a)["approved"], (key, value))

    def test_stale_open_position_marks_cannot_be_hidden_by_account_flag(self):
        p = {"ticker": "NVDA", "status": "OPEN", "mark_price": 100.0,
             "mark_timestamp": (NOW - timedelta(seconds=121)).isoformat()}
        self.assertIn("stale_portfolio_marks", self.evaluate(positions=[p])["reasons"])
        self.assertIn("position_data_unavailable", self.evaluate(positions=[None])["reasons"])

    def test_invalid_chase_earnings_and_unknown_market_regime_fail_closed(self):
        for key, value, reason in (("rsi14", -5.0, "invalid_chase_data"),
                                  ("return_5d_pct", -101.0, "invalid_chase_data"),
                                  ("earnings_business_days", -1, "invalid_earnings_calendar"),
                                  ("earnings_business_days", 3.5, "invalid_earnings_calendar"),
                                  ("market_regime", "unknown", "market_regime_unavailable")):
            q = quote(); q[key] = value
            self.assertIn(reason, self.evaluate(q=q)["reasons"])

    def test_exchange_holiday_early_close_weekend(self):
        self.assertTrue(market_is_open(NOW))
        self.assertFalse(market_is_open(datetime(2026, 9, 7, 15, tzinfo=timezone.utc)))  # Labor Day
        self.assertFalse(market_is_open(datetime(2026, 9, 5, 15, tzinfo=timezone.utc)))
        self.assertTrue(market_is_open(datetime(2026, 11, 27, 17, tzinfo=timezone.utc)))
        self.assertFalse(market_is_open(datetime(2026, 11, 27, 19, tzinfo=timezone.utc)))

    def test_no_live_or_paper_network_execution(self):
        self.assertEqual(LiveBroker().submit()["status"], "disabled")
        self.assertEqual(PaperBroker().submit()["status"], "unavailable")
        result = self.risk.evaluate(decision(), quote(), account(), [], NOW, mode="live")
        self.assertIn("broker_mode_disabled", result["reasons"])

    def test_shadow_reserves_cash_and_does_not_fill_same_observation(self):
        order = self.broker.submit(decision(), quote(), "entry-key-0001", now=NOW)
        self.assertEqual(order["status"], "PENDING", order)
        self.assertGreater(self.broker.account(NOW)["reserved_cash"], 0)
        self.assertEqual(self.broker.positions(), [])
        self.assertEqual(self.broker.observe(quote(), NOW), [])
        self.assertEqual(self.broker.positions(), [])

    def test_next_quote_fill_exit_and_atomic_net_cash(self):
        order = self.broker.submit(decision(), quote(), "entry-key-0001", now=NOW)
        later = NOW + timedelta(seconds=2)
        events = self.broker.observe(quote(now=later), later)
        trade = next(x for x in events if x["status"] == "OPEN")
        self.assertEqual(len(self.broker.positions()), 1)
        expected_cash = 100000 - trade["entry"] * trade["shares"] - trade["entry_fee"]
        self.assertAlmostEqual(self.broker.account(later)["cash"], expected_cash)
        self.assertEqual(self.broker.account(later)["reserved_cash"], 0)
        final = later + timedelta(seconds=10)
        closed = self.broker.close(order["id"], quote(now=final, price=110.0), "close-key-0001", final)
        self.assertEqual(closed["status"], "CLOSED", closed)
        self.assertAlmostEqual(self.broker.account(final)["cash"], 100000 + closed["profit"])
        self.assertEqual(self.broker.positions(), [])
        replay = self.broker.close(order["id"], quote(now=final, price=110.0), "close-key-0001", final)
        self.assertTrue(replay["idempotent_replay"])
        self.assertAlmostEqual(self.broker.account(final)["cash"], 100000 + closed["profit"])

    def test_atomic_concurrent_duplicate_submit_reserves_once(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            orders = list(pool.map(lambda _: self.broker.submit(decision(), quote(), "same-idempotency", now=NOW), range(8)))
        self.assertEqual(len({x["id"] for x in orders}), 1)
        self.assertEqual(len(self.broker.orders()), 1)
        self.assertAlmostEqual(self.broker.account(NOW)["reserved_cash"], orders[0]["reserved_cash"])
        self.assertFalse(self.risk.status()["kill_switch"]["active"])

    def test_concurrent_distinct_keys_same_ticker_blocks_duplicate(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            orders = list(pool.map(lambda i: self.broker.submit(decision(), quote(), f"different-{i}", now=NOW), range(2)))
        self.assertEqual(sum(x["status"] == "PENDING" for x in orders), 1)
        self.assertTrue(self.risk.status()["kill_switch"]["active"])

    def test_reused_idempotency_key_with_changed_decision_rejected(self):
        self.broker.submit(decision(), quote(), "entry-key-0001", now=NOW)
        other = decision(); other["confidence"] = 95.0
        result = self.broker.submit(other, quote(), "entry-key-0001", now=NOW)
        self.assertEqual(result["reasons"], ["idempotency_conflict"])

    def test_expired_order_releases_reserved_cash(self):
        self.broker.submit(decision(), quote(), "entry-key-0001", now=NOW)
        later = NOW + timedelta(seconds=901)
        self.broker.observe(quote(now=later), later)
        self.assertEqual(self.broker.account(later)["reserved_cash"], 0)
        self.assertEqual(self.broker.positions(), [])

    def test_stale_fill_is_rejected_and_reserved_cash_released(self):
        self.broker.submit(decision(), quote(), "entry-key-0001", now=NOW)
        later = NOW + timedelta(seconds=130)
        q = quote(now=NOW + timedelta(seconds=1))
        self.broker.observe(q, later)
        self.assertEqual(self.broker.positions(), [])
        self.assertEqual(self.broker.account(later)["reserved_cash"], 0)
        self.assertTrue(self.risk.status()["kill_switch"]["active"])

    def test_stop_executes_virtual_exit_even_when_kill_is_active(self):
        self.broker.submit(decision(), quote(), "entry-key-0001", now=NOW)
        later = NOW + timedelta(seconds=2)
        self.broker.observe(quote(now=later), later)
        self.risk.activate_kill("human_stop_new_entries")
        final = later + timedelta(seconds=5)
        self.broker.observe(quote(now=final, price=94.0), final)
        self.assertEqual(self.broker.positions(), [])
        self.assertEqual(self.broker.trades()[0]["exit_reason"], "stop_observed")

    def test_database_additive_migration_and_sql_injection_guard(self):
        self.db.save_record("signals", "a", {"id": "a", "ticker": "JMIA", "value": 1})
        self.db.migrate()
        self.assertEqual(self.db.get_record("signals", "a")["value"], 1)
        with self.assertRaises(ValueError): self.db.list_records("signals; DROP TABLE users")
        self.assertEqual(self.db.list_records("signals", ticker="JMIA' OR 1=1--"), [])
        with self.assertRaises(ValueError): self.db.save_record("signals", "nan", {"x": math.nan})

    def test_horizon_is_exchange_session_exact_not_calendar_or_backfill(self):
        trade = {"entry": 100.0, "shares": 10, "entry_timestamp": NOW.isoformat()}
        tuesday = datetime(2026, 9, 8, 15, tzinfo=timezone.utc)
        self.assertEqual(trading_session_distance(NOW, tuesday), 1)
        marked = mark_trade(trade, 110.0, tuesday)
        self.assertAlmostEqual(marked["horizon_returns"]["1"]["return_pct"], 10)
        self.assertNotIn("3", marked["horizon_returns"])
        thursday = datetime(2026, 9, 10, 15, tzinfo=timezone.utc)
        skipped = mark_trade(trade, 115.0, thursday)
        self.assertNotIn("1", skipped["horizon_returns"])
        self.assertEqual(skipped["horizon_status"]["1"], "missed_observation")

    def test_mfe_mae_out_of_order_and_analytics(self):
        trade = {"entry": 100.0, "shares": 10, "entry_timestamp": NOW.isoformat()}
        up = mark_trade(trade, 110.0, NOW + timedelta(seconds=2))
        down = mark_trade(up, 95.0, NOW + timedelta(seconds=4))
        self.assertAlmostEqual(down["maximum_favorable_excursion"], 10)
        self.assertAlmostEqual(down["maximum_adverse_excursion"], -5)
        self.assertEqual(mark_trade(down, 200.0, NOW + timedelta(seconds=3)), down)
        trades = [{"status": "CLOSED", "setup": "pullback", "profit": 100.0, "profit_pct": 10.0, "exit_timestamp": "2026-01-01T20:00:00Z", "holding_sessions": 5},
                  {"status": "CLOSED", "setup": "pullback", "profit": -50.0, "profit_pct": -5.0, "exit_timestamp": "2026-01-02T20:00:00Z", "holding_sessions": 10}]
        stats = strategy_analytics(trades, 1000.0)[0]
        self.assertEqual(stats["win_rate"], 50)
        self.assertEqual(stats["profit_factor"], 2)
        self.assertEqual(stats["expectancy"], 2.5)
        self.assertAlmostEqual(stats["maximum_drawdown"], 50 / 1100 * 100)
        self.assertEqual(stats["average_holding_period"], 7.5)
        self.assertEqual(len(similar_trades(trades, setup="pullback")), 2)

    def test_analytics_drawdown_uses_timezones_and_unknown_chronology_is_unavailable(self):
        trades = [{"status": "CLOSED", "setup": "pullback", "profit": 100.0, "profit_pct": 10.0,
                   "exit_timestamp": "2026-01-01T17:00:00+00:00"},
                  {"status": "CLOSED", "setup": "pullback", "profit": -50.0, "profit_pct": -5.0,
                   "exit_timestamp": "2026-01-01T13:00:00-05:00"}]
        self.assertAlmostEqual(strategy_analytics(trades, 1000.0)[0]["maximum_drawdown"], 50 / 1100 * 100)
        trades[0]["exit_timestamp"] = None
        self.assertIsNone(strategy_analytics(trades, 1000.0)[0]["maximum_drawdown"])

    def test_similarity_missing_evidence_cannot_beat_observed_match(self):
        trades = [{"id": "missing", "status": "CLOSED", "setup": "pullback", "entry_snapshot": {}},
                  {"id": "partial", "status": "CLOSED", "setup": "pullback", "entry_snapshot": {"rsi14": 50.0}},
                  {"id": "measured", "status": "CLOSED", "setup": "pullback", "entry_snapshot": {"rsi14": 51.0, "technical_score": 80.0}}]
        results = similar_trades(trades, setup="pullback", features={"rsi14": 50.0, "technical_score": 80.0})
        self.assertEqual([t["id"] for t in results], ["measured", "partial", "missing"])
        self.assertIsNone(results[-1]["similarity_distance"])
        self.assertEqual(results[-1]["similarity_status"], "unavailable")

    def test_invalid_position_shares_do_not_create_phantom_journal_performance(self):
        for shares in (None, -1, 0, True):
            with self.assertRaises(ValueError):
                mark_trade({"entry": 100.0, "shares": shares, "entry_timestamp": NOW.isoformat()}, 110.0, NOW)


if __name__ == "__main__":
    unittest.main()
