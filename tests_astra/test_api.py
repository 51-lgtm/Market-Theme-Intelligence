from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from astra.app import create_app
from astra.config import Settings
from astra.db import Database
from astra.service import TradingService


class Provider:
    async def snapshot(self, symbols):
        return {"quotes": [{"symbol": t, "price": 100.0, "at": datetime.now(timezone.utc).isoformat(), "changePct": 4.0, "freshness": "live"} for t in symbols],
                "buy_signals": [], "themes": [], "market": {}, "histories": {}, "news": {}, "sec": {}, "status": "partial"}

    async def close(self):
        pass


@pytest.fixture
def system(tmp_path):
    settings = Settings(database_path=str(tmp_path / "test.sqlite3"), password="test-password-local-only",
                        jwt_secret="test-key-local-only-" * 4, secure_cookie=False, background_jobs=False,
                        openai_api_key="", universe=("JMIA",), risk_limits={})
    service = TradingService(settings, provider=Provider())
    app = create_app(settings, service)
    with TestClient(app) as client:
        yield client, service


def login(client):
    response = client.post("/api/astra/auth/login", json={"password": "test-password-local-only"})
    assert response.status_code == 200
    return {"X-CSRF-Token": response.json()["csrf_token"]}


def test_auth_cookie_csrf_logout_and_secret_redaction(system):
    client, service = system
    assert client.get("/api/astra/dashboard").status_code == 401
    response = client.post("/api/astra/auth/login", json={"password": "test-password-local-only"})
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=strict" in response.headers["set-cookie"]
    headers = {"X-CSRF-Token": response.json()["csrf_token"]}
    assert client.post("/api/astra/risk/kill", json={"reason": "review"}).status_code == 403
    assert client.post("/api/astra/risk/kill", json={"reason": "review"}, headers={**headers, "Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/astra/risk/kill", json={"reason": "review"}, headers=headers).status_code == 200
    assert service.risk.status()["kill_switch"]["active"]
    assert client.post("/api/astra/risk/reset", json={"acknowledgement": "yes"}, headers=headers).status_code == 422
    assert client.post("/api/astra/risk/reset", json={"acknowledgement": "RESET KILL SWITCH"}, headers=headers).status_code == 200
    assert not service.risk.status()["kill_switch"]["active"]
    exported = client.get("/api/astra/export").text
    assert "test-password-local-only" not in exported and "test-key-local-only" not in exported
    assert client.post("/api/astra/auth/logout", json={}, headers=headers).status_code == 200
    assert client.get("/api/astra/dashboard").status_code == 401


def test_api_read_contract_and_import_no_orders(system):
    client, service = system
    headers = login(client)
    for path in ["dashboard", "scanner", "market", "signals", "themes", "portfolio", "trades", "shadow", "strategies", "system", "system/events", "risk", "settings", "orders", "schema"]:
        assert client.get("/api/astra/" + path).status_code == 200, path
    body = {"positions": [{"ticker": "JMIA", "shares": 10.0, "average_cost": 9.0, "stop": 7.5}]}
    result = client.post("/api/astra/portfolio/import", json=body, headers=headers)
    assert result.status_code == 200
    assert len(client.get("/api/astra/portfolio").json()["items"]) == 1
    assert service.broker.orders() == [] and service.broker.positions() == []
    assert client.post("/api/astra/orders", json={}, headers=headers).status_code == 403
    assert client.post("/api/astra/shadow", json={"decision_id": "not-stored", "idempotency_key": "test-missing"}, headers=headers).status_code == 404
    result = client.post("/api/astra/commander/analyze", json={"ticker": "JMIA"}, headers=headers)
    assert result.json()["status"] == "unavailable"


def test_validation_rejects_numeric_strings_duplicates_and_secret_echo(system):
    client, _ = system
    headers = login(client)
    secret = "private-password-do-not-echo"
    response = client.post("/api/astra/auth/login", json={"password": secret, "extra": secret})
    assert response.status_code == 422 and secret not in response.text
    assert client.post("/api/astra/portfolio/import", json={"positions": [{"ticker": "JMIA", "shares": "10", "average_cost": 9.0}]}, headers=headers).status_code == 422
    assert client.post("/api/astra/refresh", json={"symbols": ["../secret"]}, headers=headers).status_code == 422
    assert client.post("/api/astra/refresh", content="{bad json", headers={**headers, "Content-Type": "application/json"}).status_code == 422
    assert client.post("/api/astra/refresh", content="x" * 262145, headers={**headers, "Content-Type": "application/json"}).status_code == 413
    assert client.get("/api/astra-evidence").status_code == 404


def test_refresh_persists_partial_real_contract_and_restart_invalidates(tmp_path):
    settings = Settings(database_path=str(tmp_path / "data.sqlite3"), background_jobs=False, openai_api_key="", universe=("JMIA",), risk_limits={})
    service = TradingService(settings, provider=Provider())
    asyncio.run(service.refresh(["JMIA"]))
    assert service.last_error is None
    assert service.rows[0]["ticker"] == "JMIA"
    assert service.rows[0]["data_status"] == "unavailable"
    assert service.db.list_records("system_events")
    assert len(service.themes) == 12
    restored = TradingService(settings, provider=Provider())
    assert restored.rows[0]["data_status"] == "stale"
    assert restored.rows[0]["action"] == "HOLD"
    asyncio.run(service.close())
    asyncio.run(restored.close())


def test_live_configuration_fails_closed_and_secure_cookie_default(tmp_path):
    with pytest.raises(ValueError):
        Settings(live_trading=True).validate()
    with pytest.raises(ValueError):
        Settings(auto_trade=True).validate()
    assert Settings().secure_cookie is True
    assert Settings().manual_approval is True
