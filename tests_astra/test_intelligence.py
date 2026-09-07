import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import math

import httpx
import pytest

from astra.agents import TechnicalAgent, CatalystAgent, analyze_evidence, deduplicate_news, extended_technicals, summarize_market
from astra.commander import Commander, output_text, strict_schema
from astra.db import Database
from astra.providers import LegacyProvider
from astra.signals import SignalEngine
from tests_astra.test_quant_core import decision


def row():
    return {"ticker": "JMIA", "price": 100.0, "as_of": datetime.now(timezone.utc).isoformat(),
            "data_status": "ok", "risk_flags": [], "agent_outputs": {}, "leverage_status": "unleveraged"}


def response_payload(value):
    return {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(value)}]}], "usage": {"input_tokens": 100, "output_tokens": 80}}


def test_structured_response_validation_budget_cache_and_no_tools():
    calls = []
    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        assert request.url.path == "/v1/responses"
        assert payload["text"]["format"]["strict"] is True
        assert payload["text"]["format"]["type"] == "json_schema"
        assert payload["store"] is False
        assert "tools" not in payload
        return httpx.Response(200, json=response_payload(decision()))
    async def run():
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        ai = Commander(api_key="test-not-real", client=client, model="test-model", max_calls_per_day=1, max_calls_per_run=1)
        evidence = row()
        first = await ai.analyze(evidence)
        second = await ai.analyze(evidence)
        assert first["status"] == "ok" and second["cached"]
        assert first["decision"]["should_execute"] is False
        assert first["model"] == "test-model"
        evidence["price"] = 102.0
        assert (await ai.analyze(evidence))["status"] == "budget_exhausted"
        await client.aclose()
    asyncio.run(run())
    assert len(calls) == 1
    schema = strict_schema()
    assert set(schema["required"]) == set(schema["properties"])
    assert schema["additionalProperties"] is False


@pytest.mark.parametrize("payload", [
    {**decision(), "should_execute": True}, {**decision(), "ticker": "MSFT"},
    {**decision(), "confidence": "90"}, {**decision(), "stop": 150.0},
    {**decision(), "position_size": True}, {**decision(), "extra": "change risk"}])
def test_invalid_commander_output_never_yields_decision(payload):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=response_payload(payload)))) as client:
            result = await Commander(api_key="test", client=client).analyze(row())
            assert result.get("decision") is None
    asyncio.run(run())


def test_commander_veto_partial_chase_and_refusal():
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=response_payload(decision())))) as client:
            evidence = {**row(), "risk_flags": ["chase_blocked"]}
            result = await Commander(api_key="test", client=client).analyze(evidence)
            assert result["decision"]["action"] == "HOLD"
            assert result["decision"]["position_size"] == 0
    asyncio.run(run())
    with pytest.raises(ValueError): output_text({"status": "incomplete", "output_text": "{}"})
    with pytest.raises(ValueError): output_text({"output_text": "{}"})
    with pytest.raises(ValueError): output_text({"status": "completed", "output": [{"type": "message", "content": [{"type": "refusal", "refusal": "no"}]}]})


def test_real_provider_adapter_forwards_server_token_and_reports_failure():
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"status": "partial", "quotes": [{"symbol": "JMIA", "price": 10.0}], "buy_signals": []})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            p = LegacyProvider("http://127.0.0.1:10000", "private-test-token", client=client)
            result = await p.snapshot(["JMIA"])
            assert result["quotes"][0]["price"] == 10
            assert result["jmia_macro"]["status"] == "unavailable"
            assert "private-test-token" not in json.dumps(result)
    asyncio.run(run())
    assert seen[0].headers["authorization"] == "Bearer private-test-token"


def test_missing_indicators_never_inflate_scores_and_news_dedupe_preserves_filings():
    result = TechnicalAgent().analyze({}, [])
    assert result["score"] is None and result["status"] == "unavailable"
    items = deduplicate_news([{"headline": "A new contract", "url": "https://example.com/a?utm=x"}, {"headline": "A new contract", "url": "https://example.com/a?utm=y"}])
    assert len(items) == 1
    items = deduplicate_news([{"id": "1", "title": "JMIA SEC 4", "content_status": "metadata_only"}, {"id": "2", "title": "JMIA SEC 4", "content_status": "metadata_only"}])
    assert len(items) == 2
    assert CatalystAgent().analyze({}, [], items)["score"] is None


def test_extended_calculations_prior_high_and_bad_ohlc():
    start = datetime(2025, 1, 1)
    bars = [{"date": (start + timedelta(days=i)).date().isoformat(), "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "volume": 1000.0} for i in range(253)]
    bars[-1].update(open=103.0, close=105.0, high=106.0, low=102.0, volume=3000.0)
    ext = extended_technicals(bars)
    assert ext["breakout_20d"] and ext["breakout_52w"]
    assert ext["volume_average20"] == 1000
    assert ext["vwap"] is None
    assert extended_technicals([{"close": 10, "date": "2026-01-01"}])["status"] == "unavailable"


def test_signals_persist_dedupe_and_retain_evidence(tmp_path):
    db = Database(tmp_path / "a.db"); db.migrate()
    detector = SignalEngine(db)
    evidence = {**row(), "rvol": 3.0, "change": 5.0, "technical_as_of": "2026-09-04", "technical": {"daily": {"rsi14": 55.0}}}
    first = detector.detect([evidence])
    assert len(first) == 1 and first[0]["signal_count"] == 2
    assert evidence["signals"]
    assert SignalEngine(db).detect([{**evidence, "price": 102.0}]) == []
