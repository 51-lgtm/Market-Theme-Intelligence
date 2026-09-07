"""Server-owned configuration. AI never gets permission to change these values."""
from __future__ import annotations

import os
import re
import ipaddress
from urllib.parse import urlsplit
from dataclasses import dataclass, field
from pathlib import Path


def normalize_public_origin(value: str) -> str:
    """Validate a server-owned HTTPS origin; never infer it from forwarded headers."""
    if value == "":
        return ""
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) <= 32 for c in value):
        raise ValueError("Public origin must be an HTTPS origin without whitespace")
    endpoint = urlsplit(value)
    if (endpoint.scheme != "https" or not endpoint.hostname
            or endpoint.username is not None or endpoint.password is not None
            or endpoint.path not in {"", "/"} or "?" in value or "#" in value):
        raise ValueError("Public origin must be HTTPS without credentials, path, query or fragment")
    host, port = endpoint.hostname.lower(), endpoint.port
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("Public origin has an invalid port")
    if ":" in host:
        ipaddress.IPv6Address(host)
        host = f"[{host}]"
    elif len(host) > 253 or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                                     for label in host.split(".")):
        raise ValueError("Public origin has an invalid hostname")
    authority = host + (f":{port}" if port is not None else "")
    if endpoint.netloc.lower() != authority:
        raise ValueError("Public origin has an ambiguous authority")
    return f"https://{host}" + (f":{port}" if port not in {None, 443} else "")


def boolean(name: str, default: bool = False) -> bool:
    value = os.getenv(name, str(default)).strip().lower()
    if value not in {"true", "false", "1", "0"}:
        raise ValueError(f"{name} must be true or false")
    return value in {"true", "1"}


def number(name: str, default: float, minimum: float, maximum: float) -> float:
    value = float(os.getenv(name, str(default)))
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} is outside allowed bounds")
    return value


def risk_environment() -> dict:
    names = {"MAX_POSITIONS": ("max_positions", int), "MAX_POSITION_PCT": ("max_position_pct", float),
        "MAX_RISK_PER_TRADE": ("max_risk_per_trade", float), "MAX_DAILY_LOSS": ("max_daily_loss", float),
        "MAX_DRAWDOWN": ("max_drawdown", float), "MAX_CONSECUTIVE_LOSSES": ("max_consecutive_losses", int),
        "MAX_SPREAD": ("max_spread_pct", float), "MINIMUM_LIQUIDITY": ("minimum_liquidity", float),
        "MINIMUM_AVERAGE_VOLUME": ("minimum_average_volume", float), "MAXIMUM_SLIPPAGE": ("maximum_slippage_pct", float),
        "MAX_QUOTE_AGE_SECONDS": ("max_quote_age_seconds", int), "MAX_PRICE_DISCREPANCY": ("max_price_discrepancy_pct", float),
        "ORDER_COOLDOWN_SECONDS": ("cooldown_seconds", int), "MINIMUM_RISK_REWARD": ("minimum_risk_reward", float)}
    return {field_name: cast(os.environ[name]) for name, (field_name, cast) in names.items()
            if os.getenv(name, "").strip()}


@dataclass(frozen=True)
class Settings:
    risk_limits: dict = field(default_factory=risk_environment)
    database_path: str = field(default_factory=lambda: os.getenv("ASTRA_DATABASE_PATH", "data/astra.sqlite3"))
    legacy_url: str = field(default_factory=lambda: os.getenv("LEGACY_API_URL", "http://127.0.0.1:10000"))
    legacy_token: str = field(default_factory=lambda: os.getenv("API_TOKEN", ""), repr=False)
    password: str = field(default_factory=lambda: os.getenv("ASTRA_ADMIN_PASSWORD", ""), repr=False)
    jwt_secret: str = field(default_factory=lambda: os.getenv("ASTRA_JWT_SECRET", ""), repr=False)
    secure_cookie: bool = field(default_factory=lambda: boolean("COOKIE_SECURE", True))
    public_origin: str = field(default_factory=lambda: os.getenv("ASTRA_PUBLIC_ORIGIN", "") or os.getenv("RENDER_EXTERNAL_URL", ""))
    openai_api_key: str = field(default_factory=lambda: os.getenv("OPENAI_API_KEY", ""), repr=False)
    commander_model: str = field(default_factory=lambda: os.getenv("OPENAI_COMMANDER_MODEL", "gpt-6-astra"))
    agent_model: str = field(default_factory=lambda: os.getenv("OPENAI_AGENT_MODEL", ""))
    sec_user_agent: str = field(default_factory=lambda: os.getenv("SEC_USER_AGENT", ""))
    alpha_vantage_key: str = field(default_factory=lambda: os.getenv("ALPHA_VANTAGE_API_KEY", ""), repr=False)
    auto_trade: bool = field(default_factory=lambda: boolean("AUTO_TRADE"))
    live_trading: bool = field(default_factory=lambda: boolean("LIVE_TRADING"))
    paper_trading: bool = field(default_factory=lambda: boolean("PAPER_TRADING"))
    shadow_trading: bool = field(default_factory=lambda: boolean("SHADOW_TRADING", True))
    manual_approval: bool = field(default_factory=lambda: boolean("MANUAL_APPROVAL", True))
    broker_mode: str = field(default_factory=lambda: os.getenv("BROKER_MODE", "shadow"))
    background_jobs: bool = field(default_factory=lambda: boolean("ASTRA_BACKGROUND_JOBS", True))
    refresh_seconds: int = field(default_factory=lambda: int(number("ASTRA_REFRESH_SECONDS", 900, 60, 86400)))
    max_ai_daily: int = field(default_factory=lambda: int(number("OPENAI_MAX_CALLS_PER_DAY", 20, 0, 300)))
    max_ai_run: int = field(default_factory=lambda: int(number("OPENAI_MAX_CALLS_PER_RUN", 3, 0, 10)))
    initial_cash: float = field(default_factory=lambda: number("SHADOW_INITIAL_CASH_USD", 100000, 100, 100000000))
    universe: tuple[str, ...] = field(default_factory=lambda: tuple(dict.fromkeys(os.getenv(
        "ASTRA_UNIVERSE", "SPY,QQQ,IWM,SOXX,NVDA,MU,SNDK,VRT,ANET,JMIA,RKLB,POET,CIFR,IREN,IONQ,OKLO"
    ).upper().split(","))))

    def validate(self) -> None:
        normalize_public_origin(self.public_origin)
        if self.live_trading or self.auto_trade or self.broker_mode == "live":
            raise ValueError("Live and automatic broker execution are not enabled in Astra v2")
        if self.broker_mode not in {"shadow", "paper"}:
            raise ValueError("BROKER_MODE must be shadow or paper")
        if self.password and len(self.password) < 12:
            raise ValueError("ASTRA_ADMIN_PASSWORD must contain at least 12 characters")
        if self.password and len(self.jwt_secret) < 32:
            raise ValueError("ASTRA_JWT_SECRET must contain at least 32 characters")
        endpoint = urlsplit(self.legacy_url)
        if (endpoint.scheme != "http" or endpoint.hostname not in {"127.0.0.1", "localhost"}
                or not endpoint.port or endpoint.username or endpoint.password
                or endpoint.path not in {"", "/"} or endpoint.query or endpoint.fragment):
            raise ValueError("Legacy service must be on loopback")
        if len(self.universe) > 100:
            raise ValueError("ASTRA_UNIVERSE may contain at most 100 tickers")
        if not self.universe or any(not re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,14}", ticker) for ticker in self.universe):
            raise ValueError("ASTRA_UNIVERSE must contain valid US equity ticker symbols")

    def expected_request_origin(self, scheme: str, netloc: str) -> str:
        return normalize_public_origin(self.public_origin) or f"{scheme}://{netloc}"

    def public(self) -> dict:
        return {
            "mode": self.broker_mode, "live_enabled": False, "auto_trade": False,
            "manual_approval": self.manual_approval, "shadow_trading": self.shadow_trading,
            "paper_trading": self.paper_trading, "openai_configured": bool(self.openai_api_key),
            "commander_model": self.commander_model, "agent_model": self.agent_model or None,
            "auth_configured": bool(self.password and self.jwt_secret),
            "secure_cookie": self.secure_cookie, "background_jobs": self.background_jobs,
            "refresh_seconds": self.refresh_seconds, "universe": list(self.universe),
            "openai_max_calls_per_day": self.max_ai_daily, "openai_max_calls_per_run": self.max_ai_run,
            "database": "SQLite", "persistent_storage_required": True,
            "initial_shadow_cash_usd": self.initial_cash,
        }
