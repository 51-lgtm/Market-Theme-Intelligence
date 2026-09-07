"""Bounded, read-only external evidence adapters. No broker credentials or orders."""
from __future__ import annotations

import asyncio
import copy
import math
import re
import time
from datetime import datetime, timezone
from typing import Any

import httpx

SYMBOL = re.compile(r"^[A-Z][A-Z0-9.^=-]{0,14}$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def finite(value: Any) -> float | None:
    if isinstance(value, bool) or value is None or isinstance(value, (dict, list)):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def timestamp(value: Any) -> datetime | None:
    try:
        if isinstance(value, bool) or value is None:
            return None
        if isinstance(value, (int, float)):
            value = value / 1000 if value > 1e12 else value
            return datetime.fromtimestamp(value, timezone.utc)
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return result.replace(tzinfo=timezone.utc) if result.tzinfo is None else result.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


class LegacyProvider:
    def __init__(self, base_url: str, token: str = "", *, timeout: float = 45,
                 sec_user_agent: str = "", alpha_vantage_key: str = "",
                 client: httpx.AsyncClient | None = None):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = min(max(float(timeout), 1), 90)
        self.sec_user_agent = sec_user_agent.strip()
        self.alpha_vantage_key = alpha_vantage_key
        self.client = client or httpx.AsyncClient(timeout=self.timeout, follow_redirects=False)
        self._owns_client = client is None
        self._cache: dict[str, tuple[float, Any]] = {}
        self._sec_lock = asyncio.Lock()
        self._sec_next = 0.0
        self._alpha_lock = asyncio.Lock()
        self._alpha_last = 0.0

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()

    async def _get_json(self, url: str, *, params=None, headers=None, retries=2) -> dict:
        for attempt in range(retries + 1):
            try:
                response = await self.client.get(url, params=params, headers=headers, timeout=self.timeout)
                if response.status_code in (429, 502, 503, 504) and attempt < retries:
                    await asyncio.sleep(min(0.25 * 2 ** attempt, 1))
                    continue
                response.raise_for_status()
                result = response.json()
                if not isinstance(result, dict):
                    raise ValueError("Evidence response is not an object")
                return result
            except (httpx.TimeoutException, httpx.NetworkError):
                if attempt >= retries:
                    raise
                await asyncio.sleep(0.25 * 2 ** attempt)
        raise RuntimeError("Provider unavailable")

    async def snapshot(self, symbols: list[str]) -> dict:
        clean = list(dict.fromkeys(str(item).strip().upper() for item in symbols))
        if len(clean) > 40 or not all(SYMBOL.fullmatch(item) for item in clean):
            raise ValueError("1–40 valid ticker symbols are required")
        if not clean:
            raise ValueError("At least one symbol is required")
        result = {"quotes": [], "buy_signals": [], "themes": [], "market": {},
                  "histories": {}, "news": {}, "sec": {}, "as_of": utc_now(),
                  "status": "unavailable", "provider_errors": [], "provenance": {}}
        try:
            headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
            payload = await self._get_json(self.base_url + "/api/astra-evidence",
                                           params={"symbols": ",".join(clean)}, headers=headers)
            for key in result:
                if key in payload:
                    result[key] = payload[key]
            result["status"] = payload.get("status", "partial")
        except (httpx.HTTPError, ValueError, TypeError):
            result["provider_errors"].append({"provider": "legacy_bridge", "error": "unavailable"})
        for name in ("quotes", "buy_signals", "themes"):
            if not isinstance(result[name], list):
                result[name] = []
        for name in ("market", "histories", "news", "sec", "provenance"):
            if not isinstance(result[name], dict):
                result[name] = {}
        # Alpha Vantage is a deliberately rate-limited fallback, not a parallel
        # source falsely presented as provider confirmation for a live order.
        if self.alpha_vantage_key:
            available = {str(q.get("ticker", q.get("symbol", ""))) for q in result["quotes"]
                         if finite(q.get("price")) is not None}
            missing = [s for s in clean if s not in available]
            for symbol in missing[:1]:
                quote = await self.alpha_quote(symbol)
                if quote:
                    result["quotes"].append(quote)
        if self.sec_user_agent:
            for symbol in clean[:10]:
                if not result["sec"].get(symbol):
                    filings = await self.sec_filings(symbol)
                    if filings:
                        result["sec"][symbol] = filings
        result["jmia_macro"] = {
            "status": "unavailable", "usd_ngn": None, "nigeria_inflation": None,
            "ecommerce_environment": None, "source": None,
            "reason": "Nigeria macro/FX and company operational datasets are not connected"}
        result["providers"] = {
            "legacy": {"status": result["provenance"].get("provider_status", "partial" if result["quotes"] else "unavailable"),
                       "provenance": result["provenance"]},
            "sec": {"configured": bool(self.sec_user_agent), "status": "ok" if any(result["sec"].values()) else "unavailable"},
            "alpha_vantage": {"configured": bool(self.alpha_vantage_key), "mode": "rate_limited_fallback"},
            "nigeria_macro": {"status": "unavailable"}}
        if not result["quotes"] and not result["buy_signals"]:
            result["status"] = "unavailable"
        elif result["provider_errors"]:
            result["status"] = "partial"
        return result

    async def alpha_quote(self, symbol: str) -> dict | None:
        if not self.alpha_vantage_key or not SYMBOL.fullmatch(symbol):
            return None
        key = "alpha:" + symbol
        if key in self._cache and time.monotonic() - self._cache[key][0] < 900:
            return copy.deepcopy(self._cache[key][1])
        async with self._alpha_lock:
            if time.monotonic() - self._alpha_last < 65:
                return None
            self._alpha_last = time.monotonic()
            try:
                data = await self._get_json("https://www.alphavantage.co/query", params={
                    "function": "GLOBAL_QUOTE", "symbol": symbol, "apikey": self.alpha_vantage_key}, retries=0)
                row = data.get("Global Quote", {})
                price = finite(row.get("05. price"))
                session = row.get("07. latest trading day")
                if price is None or price <= 0 or timestamp(session) is None:
                    return None
                result = {"ticker": symbol, "symbol": symbol, "price": price,
                          "changePct": finite(str(row.get("10. change percent", "")).rstrip("%")),
                          "volume": finite(row.get("06. volume")), "at": session,
                          "source": "alpha-vantage-global-quote", "status": "partial",
                          "timestamp_precision": "session", "delayed": True,
                          "warnings": ["End-of-day/delayed fallback; not eligible for execution"]}
                self._cache[key] = (time.monotonic(), result)
                return copy.deepcopy(result)
            except (httpx.HTTPError, ValueError, TypeError):
                return None

    async def _sec_get(self, url: str) -> dict:
        async with self._sec_lock:
            wait = self._sec_next - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._sec_next = time.monotonic() + 0.25  # <=4/s; below SEC 10/s cap
            return await self._get_json(url, headers={"User-Agent": self.sec_user_agent,
                                                       "Accept-Encoding": "gzip, deflate"}, retries=1)

    async def sec_filings(self, symbol: str) -> list[dict]:
        if not self.sec_user_agent or not SYMBOL.fullmatch(symbol):
            return []
        key = "sec:" + symbol
        if key in self._cache and time.monotonic() - self._cache[key][0] < 1800:
            return copy.deepcopy(self._cache[key][1])
        try:
            mapping = self._cache.get("sec_tickers")
            if not mapping or time.monotonic() - mapping[0] > 86400:
                data = await self._sec_get("https://www.sec.gov/files/company_tickers.json")
                self._cache["sec_tickers"] = (time.monotonic(), data)
            else:
                data = mapping[1]
            company = next((r for r in data.values() if isinstance(r, dict) and r.get("ticker") == symbol), None)
            if not company:
                return []
            cik = int(company["cik_str"])
            data = await self._sec_get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json")
            recent = data.get("filings", {}).get("recent", {})
            output = []
            for index, form in enumerate(recent.get("form", [])[:40]):
                if form not in {"8-K", "10-Q", "10-K", "6-K", "20-F", "4", "S-1", "S-3", "424B5", "SC 13D"}:
                    continue
                def at(field):
                    rows = recent.get(field, [])
                    return rows[index] if index < len(rows) else None
                accession = at("accessionNumber")
                document = at("primaryDocument")
                url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{str(accession).replace('-', '')}/{document}" if accession and document else None
                output.append({"id": accession, "form": form, "timestamp": at("acceptanceDateTime") or at("filingDate"),
                               "filing_date": at("filingDate"), "title": f"{symbol} SEC {form}",
                               "url": url, "source": "SEC EDGAR", "sentiment": "unknown",
                               "content_status": "metadata_only"})
            self._cache[key] = (time.monotonic(), output)
            return copy.deepcopy(output)
        except (httpx.HTTPError, ValueError, TypeError, KeyError):
            return []
