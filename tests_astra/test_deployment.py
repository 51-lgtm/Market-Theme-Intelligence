"""HTTPS proxy deployment checks without network, credentials or external APIs."""
import pytest
from fastapi.testclient import TestClient

from astra.app import create_app
from astra.config import Settings, normalize_public_origin
from astra.service import TradingService


class OfflineProvider:
    async def snapshot(self, symbols):
        raise AssertionError("Deployment authentication test must not fetch market data")

    async def close(self):
        pass


def app_settings(tmp_path, public_origin=""):
    return Settings(database_path=str(tmp_path / "deployment.sqlite3"), public_origin=public_origin,
        password="deployment-test-only-password", jwt_secret="deployment-test-only-secret-" * 3,
        secure_cookie=True, background_jobs=False, openai_api_key="", universe=("JMIA",), risk_limits={})


@pytest.mark.parametrize("origin", ["http://example.com", "https://user:password@example.com", "https://@example.com",
    "https://example.com/astra", "https://example.com?key=private", "https://example.com#fragment",
    "https://example.com?", "https://example.com#", "https://example.com:0", "https://example.com:65536",
    "https://example.com\\evil", "https://exa mple.com", "https://example.com\n.evil", "https://-invalid.example",
    "https://[::1]evil", "https://example.com:", None, False])
def test_public_origin_configuration_rejects_ambiguous_or_unsafe_urls(origin):
    with pytest.raises(ValueError):
        Settings(public_origin=origin).validate()


def test_public_origin_environment_precedence_and_canonicalization(monkeypatch):
    monkeypatch.delenv("ASTRA_PUBLIC_ORIGIN", raising=False)
    monkeypatch.setenv("RENDER_EXTERNAL_URL", "https://service.onrender.com")
    assert Settings().public_origin == "https://service.onrender.com"
    monkeypatch.setenv("ASTRA_PUBLIC_ORIGIN", "https://custom.example")
    assert Settings().public_origin == "https://custom.example"
    assert normalize_public_origin("https://CUSTOM.example:443/") == "https://custom.example"
    assert normalize_public_origin("https://custom.example:8443") == "https://custom.example:8443"
    assert normalize_public_origin("https://[::1]:8443") == "https://[::1]:8443"


def test_https_public_origin_login_and_csrf_work_over_internal_http(tmp_path):
    origin = "https://astra-test.onrender.com"
    settings = app_settings(tmp_path, origin)
    service = TradingService(settings, provider=OfflineProvider())
    with TestClient(create_app(settings, service), base_url="http://internal-service:8000") as client:
        response = client.post("/api/astra/auth/login", json={"password": settings.password}, headers={"Origin": origin})
        assert response.status_code == 200
        assert "Secure" in response.headers["set-cookie"]
        assert "HttpOnly" in response.headers["set-cookie"]
        cookie = response.headers["set-cookie"].split(";", 1)[0]
        headers = {"Cookie": cookie, "X-CSRF-Token": response.json()["csrf_token"], "Origin": origin}
        assert client.post("/api/astra/risk/kill", json={"reason": "deployment test"}, headers=headers).status_code == 200
        assert client.post("/api/astra/risk/reset", json={"acknowledgement": "RESET KILL SWITCH"}, headers=headers).status_code == 200
        for bad_origin in ("https://evil.example", "http://internal-service:8000", "null"):
            assert client.post("/api/astra/risk/kill", json={"reason": "reject"},
                headers={**headers, "Origin": bad_origin, "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https"}).status_code == 403
        assert client.post("/api/astra/risk/kill", json={"reason": "missing csrf"},
            headers={"Cookie": cookie, "Origin": origin}).status_code == 403


def test_local_default_stays_exact_request_origin(tmp_path):
    settings = app_settings(tmp_path)
    service = TradingService(settings, provider=OfflineProvider())
    with TestClient(create_app(settings, service), base_url="http://testserver") as client:
        assert client.post("/api/astra/auth/login", json={"password": settings.password},
            headers={"Origin": "https://testserver", "X-Forwarded-Proto": "https"}).status_code == 403
        assert client.post("/api/astra/auth/login", json={"password": settings.password},
            headers={"Origin": "http://testserver"}).status_code == 200


def test_forwarded_ip_spoofing_does_not_reset_login_rate_limit(tmp_path):
    settings = app_settings(tmp_path, "https://astra-test.onrender.com")
    service = TradingService(settings, provider=OfflineProvider())
    with TestClient(create_app(settings, service), base_url="http://internal-service:8000") as client:
        for index in range(9):
            response = client.post("/api/astra/auth/login", json={"password": "wrong-test-password"},
                headers={"Origin": settings.public_origin, "X-Forwarded-For": f"198.51.100.{index + 1}"})
            assert response.status_code == (401 if index < 8 else 429)
