"""Single-owner JWT sessions with HttpOnly cookies and server-side CSRF tokens."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import HTTPException, Request

from .config import Settings

COOKIE = "astra_session"


class AuthManager:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.sessions: dict[str, dict] = {}
        self.attempts: dict[str, deque] = defaultdict(deque)

    def login(self, password: str, address: str) -> tuple[str, dict]:
        if not self.settings.password or not self.settings.jwt_secret:
            raise HTTPException(503, "auth_setup_required")
        now = time.time()
        if len(self.attempts) >= 2048:
            for old_ip in list(self.attempts)[:1024]:
                if not self.attempts[old_ip] or self.attempts[old_ip][-1] < now - 900:
                    del self.attempts[old_ip]
            if len(self.attempts) >= 2048 and address not in self.attempts:
                raise HTTPException(429, "login_rate_limited")
        attempts = self.attempts[address]
        while attempts and attempts[0] < now - 900:
            attempts.popleft()
        if len(attempts) >= 8:
            raise HTTPException(429, "login_rate_limited")
        attempts.append(now)
        if not hmac.compare_digest(hashlib.sha256(password.encode()).digest(),
                                   hashlib.sha256(self.settings.password.encode()).digest()):
            raise HTTPException(401, "invalid_credentials")
        # Expired sessions and unbounded IP entries cannot accumulate indefinitely.
        self.sessions = {k: v for k, v in self.sessions.items() if v["expires"] > now}
        if len(self.sessions) >= 100:
            del self.sessions[next(iter(self.sessions))]
        for ip in list(self.attempts):
            if not self.attempts[ip] or self.attempts[ip][-1] < now - 900:
                del self.attempts[ip]
        issued = datetime.now(timezone.utc)
        session_id = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        claims = {"sub": "owner", "jti": session_id, "iat": issued,
                  "nbf": issued, "exp": issued + timedelta(hours=8),
                  "iss": "astra-v2", "aud": "astra-dashboard"}
        token = jwt.encode(claims, self.settings.jwt_secret, algorithm="HS256")
        self.sessions[session_id] = {"csrf_token": csrf, "expires": now + 28800, "actor": "owner"}
        return token, {"authenticated": True, "csrf_token": csrf, "actor": "owner"}

    def authenticate(self, request: Request, *, mutate: bool = False) -> dict:
        token = request.cookies.get(COOKIE, "")
        if not token or not self.settings.jwt_secret:
            raise HTTPException(401, "authentication_required")
        try:
            claims = jwt.decode(token, self.settings.jwt_secret, algorithms=["HS256"],
                                audience="astra-dashboard", issuer="astra-v2",
                                options={"require": ["sub", "jti", "exp", "iat", "nbf", "iss", "aud"]})
            session = self.sessions[claims["jti"]]
            if claims["sub"] != "owner" or session["expires"] <= time.time():
                raise ValueError("expired")
        except (jwt.PyJWTError, KeyError, ValueError):
            raise HTTPException(401, "invalid_session") from None
        if mutate:
            origin = request.headers.get("origin")
            if origin and origin != self.settings.expected_request_origin(request.url.scheme, request.url.netloc):
                raise HTTPException(403, "cross_origin_request_rejected")
            if not hmac.compare_digest(request.headers.get("x-csrf-token", ""), session["csrf_token"]):
                raise HTTPException(403, "csrf_token_required")
        return {**session, "jti": claims["jti"], "authenticated": True}

    def logout(self, request: Request) -> None:
        session = self.authenticate(request, mutate=True)
        self.sessions.pop(session["jti"], None)
