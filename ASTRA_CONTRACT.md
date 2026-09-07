# Astra v2 implementation contract

The legacy HTML/Express v14 service stays intact. A new FastAPI service runs on
port 8000 (public in combined deployment) and proxies legacy routes to loopback
Node on port 10000. React is served at `/astra/`; `/` remains legacy.

## Ownership
- Root: FastAPI app, auth/settings, service orchestration, Node bridge, launcher,
  deployment, README, integration tests/review.
- quant_core agent: `astra/db.py`, `astra/models.py`, `astra/risk.py`,
  `astra/brokers.py`, `astra/journal.py`, related tests.
- intelligence agent: `astra/agents.py`, `astra/commander.py`,
  `astra/providers.py`, `astra/signals.py`, related tests.
- frontend agent: `frontend/**` React/Vite only, frontend tests as appropriate.

## Python package
Python 3.12+, Pydantic v2, FastAPI, httpx, SQLite stdlib, PyJWT.
Use snake_case JSON. No network/broker orders in module import. No live adapter
may submit an order. No fake market values. Missing evidence has null score and
status unavailable/partial. AI inputs are evidence, never trusted instructions.

## Data / functions
`Database(path)` provides `migrate()`, `connection()` context manager and generic
`save_record(table, id, payload, ticker=None, timestamp=None)`,
`list_records(table, limit=300, ticker=None)`, `get_record(table,id)`.
Generic records tables use id TEXT PRIMARY KEY, ticker TEXT, timestamp TEXT,
payload TEXT. Specific order/journal accounting tables may be separate.

`CommanderDecision` strictly validates ticker, action BUY/BUY_MORE/HOLD/TRIM/SELL/
STOP/AVOID, confidence 0..100, entry {min,max} nullable, stop nullable, targets
list, position_size int>=0, risk_reward nullable, time_horizon, setup,
reasons/invalidation/risk_flags lists, should_execute Literal[False].
Every field required for OpenAI strict JSON Schema; numerical values finite.

`RiskEngine` / `ShadowBroker` interfaces are decided by quant_core and reported
promptly to root. Risk rejects live mode, stale/invalid quotes, unknown spread/
liquidity/provider consistency; stricter checks apply to fills than analysis.
Use atomic BEGIN IMMEDIATE to prevent race/duplicate entry and reserve cash.
Kill switch persists and can only be reset by authenticated explicit human action.

`LegacyProvider(base_url, token)` async `snapshot(symbols)` returns
{quotes:[...], buy_signals:[...], themes:[...], market:{...}, histories:{...},
news:{ticker:[...]}, sec:{ticker:[...]}, as_of, status}. Network failures partial.
Bridge uses Node internal GET `/api/astra-evidence?symbols=...` implemented by root.
Provider can include SEC/IR/news adapters; report unavailable on missing credentials.

`analyze_evidence(evidence, positions=[])` produces scanner rows with ticker,
price, change, volume, rvol, technical_score, catalyst_score, theme_score,
market_score, total_score, astra_score, tier, action, confidence, setup,
technical, catalysts, theme, market, agent_outputs, signals, data_status,
as_of, reasons, risk_flags. Missing components do not inflate score.
`Commander(client/config...)` consumes only agent outputs, no direct data fetch,
uses OpenAI Responses with strict JSON Schema and Pydantic validation, no tools,
cache keyed by evidence revision/model. Root can adapt exact signatures.

## React / REST contract
All new endpoints prefixed `/api/astra`. Auth: `/auth/login` {password},
`/auth/session` -> {authenticated,csrf_token,...}; mutations require
X-CSRF-Token; HttpOnly SameSite Strict session cookie, no frontend API keys.
Read APIs:
- GET `/dashboard`: {status,as_of,market,scanner:[],themes:[],portfolio:[],signals:[],commander:{},risk:{},system:{}}
- GET `/scanner`: {items:[]}; `/signals`, `/themes`, `/portfolio`, `/shadow`,
  `/trades`, `/strategies`, `/system/events` use {items:[]}.
- GET `/ticker/{ticker}`: scanner row plus {history:[],weekly:[],news:[],sec:[],similar_trades:[],jmia:{}}
- GET `/risk`: {kill_switch:{active,reasons},limits:{},...}
- GET `/system`: {status,mode,live_enabled:false,openai_configured,commander_model,jobs,providers,database,...}
- GET `/settings`: non-secret configuration.
Mutations:
- POST `/refresh` {symbols?:[]} queues bounded background refresh -> {status:queued}
- POST `/commander/analyze` {ticker} -> {status,decision,...}
- POST `/shadow` {decision_id,idempotency_key} validates stored decision + fresh
  server evidence and independent risk engine before virtual entry.
- POST `/shadow/{id}/close` {idempotency_key} server derives fresh exit price.
- POST `/risk/kill` {reason}; `/risk/reset` {acknowledgement:"RESET KILL SWITCH"}
- POST `/portfolio/import` {positions:[{ticker,shares,average_cost,stop?}]}
  explicitly imports device v14 holdings as observations, not orders.
- GET `/export` complete persisted journal/settings-safe JSON.
- GET `/events` SSE (authenticated cookie).
UI must render honest empty/disconnected states and never seed demo trades.

Defaults AUTO_TRADE=false LIVE_TRADING=false MANUAL_APPROVAL=true
SHADOW_TRADING=true PAPER_TRADING=false BROKER_MODE=shadow.
