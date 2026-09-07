"""Strict, provider-independent contracts for validated analysis and risk limits."""
from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class EntryRange(StrictModel):
    min: float = Field(gt=0)
    max: float = Field(gt=0)

    @model_validator(mode="after")
    def ordered(self):
        if self.min > self.max:
            raise ValueError("entry min must not exceed max")
        return self


SETUPS = Literal["volume_breakout", "earnings_breakout", "pullback", "trend_follow",
    "momentum", "mean_reversion", "gap_and_go", "52w_high_breakout",
    "sector_rotation", "catalyst_trade", "theme_trade", "short_squeeze_candidate", "none"]


class CommanderDecision(StrictModel):
    ticker: str = Field(min_length=1, max_length=15, pattern=r"^[A-Z][A-Z0-9.\-^=]{0,14}$")
    action: Literal["BUY", "BUY_MORE", "HOLD", "TRIM", "SELL", "STOP", "AVOID"]
    confidence: float = Field(ge=0, le=100)
    entry: EntryRange | None
    stop: float | None = Field(gt=0)
    targets: list[float] = Field(max_length=8)
    position_size: int = Field(ge=0, le=10000000)
    risk_reward: float | None = Field(ge=0)
    time_horizon: Literal["intraday", "swing", "position", "none"]
    setup: SETUPS
    reasons: list[str] = Field(max_length=30)
    invalidation: list[str] = Field(max_length=30)
    risk_flags: list[str] = Field(max_length=30)
    should_execute: Literal[False]

    @field_validator("should_execute", mode="before")
    @classmethod
    def execution_is_boolean_false(cls, value):
        # Python considers 0 == False; a Literal alone therefore accepts integer 0.
        if value is not False:
            raise ValueError("should_execute must be the boolean false")
        return value

    @field_validator("targets")
    @classmethod
    def target_prices(cls, values):
        if any(isinstance(x, bool) or not math.isfinite(x) or x <= 0 for x in values):
            raise ValueError("targets must contain finite positive prices")
        if values != sorted(set(values)):
            raise ValueError("targets must be unique ascending prices")
        return values

    @field_validator("reasons", "invalidation", "risk_flags")
    @classmethod
    def bounded_text(cls, values):
        if any(not x.strip() or len(x) > 1500 for x in values):
            raise ValueError("text entries must be nonempty and at most 1500 characters")
        return values

    @model_validator(mode="after")
    def validate_trade(self):
        if self.action in {"BUY", "BUY_MORE"}:
            if self.entry is None or self.stop is None or not self.targets or self.risk_reward is None:
                raise ValueError("buy analysis requires entry, stop, targets and risk_reward")
            if self.stop >= self.entry.min or self.targets[0] <= self.entry.max:
                raise ValueError("long trade prices must satisfy stop < entry < targets")
        return self


class RiskLimits(StrictModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False, frozen=True)
    max_positions: int = Field(default=5, ge=1, le=100)
    max_position_pct: float = Field(default=0.20, gt=0, le=1)
    max_risk_per_trade: float = Field(default=0.01, gt=0, le=0.05)
    max_daily_loss: float = Field(default=0.03, gt=0, le=0.25)
    max_drawdown: float = Field(default=0.10, gt=0, le=0.5)
    max_consecutive_losses: int = Field(default=5, ge=1, le=100)
    max_spread_pct: float = Field(default=0.005, gt=0, le=0.05)
    minimum_liquidity: float = Field(default=1000000.0, ge=0)
    minimum_average_volume: float = Field(default=100000.0, ge=0)
    maximum_slippage_pct: float = Field(default=0.005, ge=0, le=0.05)
    max_quote_age_seconds: int = Field(default=120, ge=1, le=300)
    max_price_discrepancy_pct: float = Field(default=0.005, gt=0, le=0.05)
    cooldown_seconds: int = Field(default=900, ge=0, le=86400)
    minimum_risk_reward: float = Field(default=1.8, ge=1.0, le=10)
    max_stop_distance_pct: float = Field(default=0.10, gt=0, le=0.10)
    pending_expiry_seconds: int = Field(default=900, ge=30, le=86400)
    require_market_hours: bool = True
