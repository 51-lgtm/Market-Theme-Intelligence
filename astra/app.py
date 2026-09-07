"""FastAPI composition root, authenticated APIs and legacy-compatible gateway."""
from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from .auth import AuthManager, COOKIE
from .config import Settings
from .service import TradingService, now_iso
from .journal import strategy_analytics

ROOT = Path(__file__).resolve().parent.parent
SYMBOL = re.compile(r"^[A-Z][A-Z0-9.\-]{0,14}$")


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class LoginBody(StrictBody):
    password: str = Field(min_length=1, max_length=512)


class RefreshBody(StrictBody):
    symbols: list[str] | None = Field(default=None, max_length=100)


class TickerBody(StrictBody):
    ticker: str = Field(pattern=r"^[A-Z][A-Z0-9.\-]{0,14}$")


class ShadowBody(StrictBody):
    decision_id: str = Field(min_length=1, max_length=128)
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9:._-]+$")


class CloseBody(StrictBody):
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9:._-]+$")


class KillBody(StrictBody):
    reason: str = Field(min_length=1, max_length=200)


class ResetBody(StrictBody):
    acknowledgement: str = Field(min_length=1, max_length=100)


class PositionBody(TickerBody):
    shares: float = Field(gt=0, le=100000000)
    average_cost: float = Field(gt=0, le=10000000)
    stop: float | None = Field(default=None, gt=0, le=10000000)


class ImportBody(StrictBody):
    positions: list[PositionBody] = Field(max_length=100)


def create_app(settings=None, service=None):
    if settings is None:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env", override=False)
    settings = settings or Settings()
    settings.validate()
    auth = AuthManager(settings)
    trading = service or TradingService(settings)
    proxy = httpx.AsyncClient(timeout=httpx.Timeout(90, connect=5), follow_redirects=False)

    @asynccontextmanager
    async def lifespan(app):
        if settings.background_jobs:
            trading.loop_task = asyncio.create_task(trading.background_loop(), name="astra-jobs")
        yield
        await trading.close()
        await proxy.aclose()

    app = FastAPI(title="米国株AI司令室 Astra v2", version="2.0.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.trading = trading
    app.state.auth = auth
    counters = defaultdict(deque)

    @app.middleware("http")
    async def security(request: Request, call_next):
        identity = request.headers.get("x-request-id", "")
        request.state.request_id = identity if re.fullmatch(r"[A-Za-z0-9._-]{8,64}", identity) else str(uuid.uuid4())
        content_length = request.headers.get("content-length", "0")
        try:
            if int(content_length) > 262144:
                return JSONResponse({"error": "payload_too_large"}, status_code=413)
        except ValueError:
            return JSONResponse({"error": "invalid_content_length"}, status_code=400)
        # Buffer at most 256 KiB, including requests without Content-Length.
        if request.method in {"POST", "PUT", "PATCH"}:
            if request.url.path.startswith("/api/astra/") and "application/json" not in request.headers.get("content-type", ""):
                return JSONResponse({"error": "json_content_type_required"}, status_code=415)
            body = b""
            async for chunk in request.stream():
                body += chunk
                if len(body) > 262144:
                    return JSONResponse({"error": "payload_too_large"}, status_code=413)
            request._body = body
        if request.url.path.startswith("/api/astra/"):
            ip = request.client.host if request.client else "unknown"
            now = time.monotonic()
            bucket = counters[ip]
            while bucket and bucket[0] < now - 60:
                bucket.popleft()
            if len(bucket) >= 180:
                return JSONResponse({"error": "rate_limited"}, status_code=429)
            bucket.append(now)
            if len(counters) > 10000:
                counters.clear()
            if request.url.path not in {"/api/astra/auth/login", "/api/astra/auth/session"}:
                try:
                    request.state.session = auth.authenticate(request, mutate=request.method not in {"GET", "HEAD", "OPTIONS"})
                except HTTPException as exc:
                    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)
        try:
            response = await call_next(request)
        except Exception as exc:
            trading.event("api_error", component="http", error_type=type(exc).__name__)
            response = JSONResponse({"error": "internal_error", "request_id": request.state.request_id}, status_code=500)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
        if request.url.path.startswith(("/api/astra", "/astra")):
            response.headers["Cache-Control"] = "no-store"
            response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        # Do not echo submitted passwords or other potentially sensitive values.
        return JSONResponse({"error": "invalid_input", "fields": [list(e["loc"]) for e in exc.errors()]}, status_code=422)

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    @app.get("/healthz")
    async def health():
        return {"ok": True, "version": "astra-v2", "live_enabled": False}

    @app.post("/api/astra/auth/login")
    async def login(body: LoginBody, request: Request):
        origin = request.headers.get("origin")
        if origin and origin != settings.expected_request_origin(request.url.scheme, request.url.netloc):
            raise HTTPException(403, "cross_origin_request_rejected")
        token, session = auth.login(body.password, request.client.host if request.client else "unknown")
        response = JSONResponse(session)
        response.set_cookie(COOKIE, token, httponly=True, secure=settings.secure_cookie,
                            samesite="strict", max_age=28800, path="/")
        trading.event("session_created")
        return response

    @app.get("/api/astra/auth/session")
    async def session(request: Request):
        try:
            result = auth.authenticate(request)
            return {"authenticated": True, "actor": result["actor"], "csrf_token": result["csrf_token"]}
        except HTTPException:
            return {"authenticated": False, "setup_required": not bool(settings.password and settings.jwt_secret)}

    @app.post("/api/astra/auth/logout")
    async def logout(request: Request):
        auth.logout(request)
        response = JSONResponse({"authenticated": False})
        response.delete_cookie(COOKIE, path="/", secure=settings.secure_cookie, httponly=True, samesite="strict")
        return response

    @app.get("/api/astra/dashboard")
    async def dashboard():
        return trading.dashboard()

    @app.get("/api/astra/scanner")
    async def scanner():
        return {"items": trading.rows, "universe": list(settings.universe), "scope": "configured-universe", "as_of": trading.last_refresh}

    @app.get("/api/astra/signals")
    async def signals():
        return {"items": trading.db.list_records("signals", limit=300)}

    @app.get("/api/astra/themes")
    async def themes():
        return {"items": trading.themes}

    @app.get("/api/astra/market")
    async def market():
        return trading.market

    @app.get("/api/astra/portfolio")
    async def portfolio():
        return {"items": trading.portfolio(), "shadow_account": trading.broker.account()}

    @app.post("/api/astra/portfolio/import")
    async def import_portfolio(body: ImportBody):
        if len({p.ticker for p in body.positions}) != len(body.positions):
            raise HTTPException(422, "duplicate_ticker")
        for position in body.positions:
            value = {**position.model_dump(), "imported_at": now_iso(), "source": "owner-import", "mode": "observation"}
            trading.db.save_record("positions", position.ticker, value, ticker=position.ticker)
        # Position changes invalidate pending analysis even before a data refresh.
        for row in trading.rows:
            row["data_status"] = "partial"
            row["action"] = "HOLD"
            row["risk_flags"] = list(dict.fromkeys(row.get("risk_flags", []) + ["portfolio_changed_requires_refresh"]))
        trading.event("portfolio_imported", count=len(body.positions))
        return {"items": trading.portfolio(), "imported": len(body.positions)}

    @app.post("/api/astra/refresh")
    async def refresh(body: RefreshBody):
        if body.symbols is not None and (not body.symbols or any(not SYMBOL.fullmatch(t) for t in body.symbols)):
            raise HTTPException(422, "invalid_symbols")
        return trading.queue_refresh(body.symbols)

    @app.get("/api/astra/ticker/{ticker}")
    async def ticker_detail(ticker: str):
        if not SYMBOL.fullmatch(ticker):
            raise HTTPException(422, "invalid_ticker")
        return trading.ticker(ticker)

    @app.post("/api/astra/commander/analyze")
    async def commander_analyze(body: TickerBody):
        return await trading.analyze(body.ticker)

    @app.get("/api/astra/commander")
    async def commander():
        return trading.latest_commander

    @app.get("/api/astra/ai")
    async def ai():
        return {"items": trading.db.list_records("ai_decisions", limit=300), "configured": bool(settings.openai_api_key)}

    async def refresh_quote(ticker):
        try:
            response = await proxy.get(settings.legacy_url + "/api/quotes", params={"symbols": ticker},
                headers={"Authorization": f"Bearer {settings.legacy_token}"} if settings.legacy_token else {})
            response.raise_for_status()
            quote = response.json().get("quotes", {}).get(ticker)
            if not isinstance(quote, dict):
                raise ValueError("no_quote")
            trading.evidence["quotes"] = [q for q in trading.evidence.get("quotes", []) if q.get("symbol", q.get("ticker")) != ticker] + [{**quote, "symbol": ticker}]
        except (httpx.HTTPError, ValueError, TypeError):
            trading.risk.activate_kill("api_failure")
            trading.event("api_error", ticker=ticker, component="execution_quote")
            raise HTTPException(503, "fresh_quote_unavailable") from None

    @app.get("/api/astra/shadow")
    @app.get("/api/astra/trades")
    async def shadow():
        return {"items": trading.broker.trades(), "account": trading.broker.account()}

    @app.post("/api/astra/shadow")
    async def shadow_submit(body: ShadowBody):
        stored = trading.db.get_record("ai_decisions", body.decision_id)
        if not stored:
            raise HTTPException(404, "decision_not_found")
        ticker = stored.get("ticker", (stored.get("decision") or {}).get("ticker"))
        if not ticker or not SYMBOL.fullmatch(ticker):
            raise HTTPException(422, "invalid_stored_decision")
        # A transport retry returns the atomic journaled result before another
        # provider call; the broker still checks the original payload fingerprint.
        with trading.db.connection() as conn:
            replay = conn.execute("SELECT 1 FROM shadow_orders WHERE idempotency_key=?", (body.idempotency_key,)).fetchone()
        if replay:
            return trading.broker.submit(stored["decision"], {}, body.idempotency_key, decision_id=body.decision_id)
        close_replay = trading.db.get_control("close:" + body.idempotency_key)
        if close_replay:
            return trading.broker.close(close_replay["trade_id"], {}, body.idempotency_key, decision_id=body.decision_id)
        await refresh_quote(ticker)
        try:
            return trading.submit_shadow(body.decision_id, body.idempotency_key)
        except ValueError as exc:
            trading.event("risk_rejected", ticker=ticker, reason=str(exc)[:200])
            raise HTTPException(409, str(exc)[:200]) from None

    @app.post("/api/astra/shadow/{trade_id}/close")
    async def shadow_close(trade_id: str, body: CloseBody):
        trade = next((t for t in trading.broker.trades() if t.get("id") == trade_id), None)
        if not trade:
            raise HTTPException(404, "trade_not_found")
        if trading.db.get_control("close:" + body.idempotency_key):
            return trading.broker.close(trade_id, {}, body.idempotency_key)
        await refresh_quote(trade["ticker"])
        try:
            result = trading.broker.close(trade_id, trading.quote_for(trade["ticker"]), body.idempotency_key)
            trading.event("shadow_closed" if result.get("status") == "CLOSED" else "order_rejected", ticker=trade["ticker"], trade_id=trade_id)
            return result
        except ValueError as exc:
            raise HTTPException(409, str(exc)[:200]) from None

    @app.get("/api/astra/strategies")
    async def strategies():
        result = strategy_analytics(trading.broker.trades(), initial_equity=settings.initial_cash)
        return {"items": result} if isinstance(result, list) else result

    @app.get("/api/astra/risk")
    async def risk():
        return trading.risk.status()

    @app.post("/api/astra/risk/kill")
    async def kill(body: KillBody):
        result = trading.risk.activate_kill(body.reason)
        trading.event("kill_switch", action="activated")
        return result or trading.risk.status()

    @app.post("/api/astra/risk/reset")
    async def reset(body: ResetBody, request: Request):
        try:
            result = trading.risk.reset_kill("human:" + request.state.session["actor"], body.acknowledgement)
        except (ValueError, PermissionError):
            raise HTTPException(422, "explicit_reset_acknowledgement_required") from None
        trading.event("kill_switch", action="human_reset")
        return result or trading.risk.status()

    @app.get("/api/astra/orders")
    async def orders():
        return {"items": trading.broker.orders(), "live_enabled": False}

    @app.get("/api/astra/trade-events")
    async def trade_events():
        return {"items": trading.db.list_records("trade_events", limit=1000)}

    @app.post("/api/astra/orders")
    async def deny_orders():
        raise HTTPException(403, "live_and_direct_order_submission_disabled")

    @app.get("/api/astra/system")
    async def system():
        return trading.system()

    @app.get("/api/astra/settings")
    async def configuration():
        return {**settings.public(), "risk": trading.risk.status()}

    @app.get("/api/astra/system/events")
    async def system_events():
        return {"items": trading.db.list_records("system_events", limit=200)}

    @app.get("/api/astra/export")
    async def export():
        tables = ["positions", "trades", "shadow_trades", "trade_events", "signals", "news", "themes", "theme_scores", "ai_decisions", "risk_events", "system_events", "technical_history"]
        return {"version": "astra-v2", "exported_at": now_iso(), "settings": settings.public(),
                "records": {table: trading.db.list_records(table, limit=10000) for table in tables}}

    @app.get("/api/astra/events")
    async def event_stream(request: Request):
        async def stream():
            revision = -1
            for _ in range(240):
                if await request.is_disconnected():
                    break
                # Revalidate session so logout/expiry revokes an active stream.
                try:
                    auth.authenticate(request)
                except HTTPException:
                    break
                if revision != trading.revision:
                    revision = trading.revision
                    yield f"event: update\ndata: {json.dumps({'revision': revision, 'as_of': trading.last_refresh})}\n\n"
                else:
                    yield ": heartbeat\n\n"
                await asyncio.sleep(5)
        return StreamingResponse(stream(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})

    @app.get("/api/astra/schema")
    async def schema():
        from .models import CommanderDecision
        return CommanderDecision.model_json_schema()

    @app.get("/astra")
    @app.get("/astra/{asset:path}")
    async def frontend(asset: str = ""):
        base = ROOT / "frontend" / "dist"
        selected = (base / asset).resolve()
        if not selected.is_relative_to(base.resolve()):
            raise HTTPException(404, "not_found")
        if not asset or not selected.is_file():
            selected = base / "index.html"
        if not selected.is_file():
            return JSONResponse({"error": "frontend_build_required", "command": "npm --prefix frontend ci && npm --prefix frontend run build"}, status_code=503)
        return FileResponse(selected)

    @app.api_route("/{path:path}", methods=["GET", "HEAD", "POST", "OPTIONS"])
    async def legacy(path: str, request: Request):
        if path.startswith("api/astra"):
            raise HTTPException(404, "not_found")
        if path.startswith("api/astra-evidence"):
            raise HTTPException(404, "not_found")  # bridge is internal only
        headers = {key: value for key, value in request.headers.items()
                   if key.lower() in {"authorization", "content-type", "origin", "x-request-id", "accept"}}
        try:
            result = await proxy.request(request.method, settings.legacy_url + "/" + path,
                                         params=request.query_params, content=await request.body(), headers=headers)
        except httpx.HTTPError:
            return JSONResponse({"error": "legacy_service_unavailable"}, status_code=503)
        safe_headers = {key: value for key, value in result.headers.items()
                        if key.lower() in {"content-type", "cache-control", "etag", "last-modified", "content-security-policy", "x-market-data-warning"}}
        return Response(result.content, result.status_code, headers=safe_headers)

    return app


# Start with: uvicorn astra.app:create_app --factory --host 127.0.0.1 --port 8000
