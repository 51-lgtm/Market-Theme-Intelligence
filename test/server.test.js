'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createApp,
  createRateLimiter,
  enforceSimulationEnvelope,
  validateConfiguration
} = require('../server');
const { buildMarketRegimePayload } = require('../market-data');

function stubMarketData() {
  return {
    requested: null,
    async getSnapshot(symbols) {
      this.requested = symbols;
      return {
        quotes: { AAPL: { price: 100, changePct: 1, src: 'test', closes: [] } },
        fx: { usdJpy: 160, src: 'test' },
        errors: [],
        stale: [],
        meta: { status: 'ok', requested: symbols.length, returned: 2, sources: ['test'], durationMs: 1 },
        at: new Date().toISOString()
      };
    },
    status() { return { cacheEntries: 0, providers: {} }; }
  };
}

async function withServer(env, fn, marketData = stubMarketData()) {
  const { app } = createApp({ env, marketData });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try { await fn({ base, marketData }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('healthz stays public while API routes honor API_TOKEN', async () => {
  await withServer({ API_TOKEN: 'secret' }, async ({ base, marketData }) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const denied = await fetch(`${base}/api/quotes?symbols=AAPL`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${base}/api/quotes?symbols=AAPL`, {
      headers: { Authorization: 'Bearer secret' }
    });
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get('cache-control'), /no-store/);
    assert.equal(allowed.headers.get('x-market-data-status'), 'ok');
    assert.equal(allowed.headers.get('x-market-data-warnings'), '0');
    assert.match(allowed.headers.get('server-timing'), /^market;dur=/);
    const body = await allowed.json();
    assert.equal(body.quotes.AAPL.price, 100);
    assert.ok(marketData.requested.includes('SPY'));
    assert.ok(marketData.requested.includes('JPY=X'));
  });
});

test('market response warning header includes reference, unverified and failed data', async () => {
  const marketData = stubMarketData();
  marketData.getSnapshot = async () => ({
    quotes: { AAPL: { price: 100, src: 'test' } },
    fx: { usdJpy: 160, src: 'reference' },
    errors: ['MSFT'],
    stale: [],
    meta: { status: 'partial', durationMs: 2, quality: { reference: 1, unverified: 1, failed: 1 } }
  });
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/quotes?symbols=AAPL,MSFT`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-market-data-status'), 'partial');
    assert.equal(response.headers.get('x-market-data-warnings'), '3');
  }, marketData);
});

test('every JSON response carries a sanitized correlation ID in the body and header', async () => {
  await withServer({}, async ({ base }) => {
    const supplied = 'client-trace_1234';
    const accepted = await fetch(`${base}/api/quotes?symbols=AAPL`, {
      headers: { 'X-Request-ID': supplied }
    });
    const acceptedBody = await accepted.json();
    assert.equal(accepted.headers.get('x-request-id'), supplied);
    assert.equal(acceptedBody.requestId, supplied);

    const replaced = await fetch(`${base}/api/not-real`, {
      headers: { 'X-Request-ID': 'short' }
    });
    const replacedBody = await replaced.json();
    const generated = replaced.headers.get('x-request-id');
    assert.notEqual(generated, 'short');
    assert.match(generated, /^[0-9a-f-]{36}$/);
    assert.equal(replacedBody.requestId, generated);
  });
});

test('API authentication runs before body parsing and malformed JSON never leaks an HTML stack', async () => {
  await withServer({ API_TOKEN: 'secret' }, async ({ base }) => {
    const denied = await fetch(`${base}/api/ai-analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken'
    });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('content-type'), /application\/json/);

    const malformed = await fetch(`${base}/api/ai-analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: '{broken'
    });
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers.get('content-type'), /application\/json/);
    assert.match(malformed.headers.get('cache-control'), /no-store/);
    const body = await malformed.json();
    assert.equal(body.error, 'invalid_json');
    assert.equal(body.requestId, malformed.headers.get('x-request-id'));
    assert.doesNotMatch(JSON.stringify(body), /node_modules|server\.js|body-parser/i);
  });
});

test('disconnecting an HTTP client propagates cancellation to its snapshot waiter', async () => {
  let markStarted;
  let markCancelled;
  const started = new Promise(resolve => { markStarted = resolve; });
  const cancelled = new Promise(resolve => { markCancelled = resolve; });
  const marketData = {
    getSnapshot(symbols, options) {
      markStarted();
      return new Promise(resolve => {
        options.signal.addEventListener('abort', () => {
          markCancelled();
          resolve({ quotes: {}, fx: null, errors: symbols, stale: [], meta: { status: 'error', cancelled: true } });
        }, { once: true });
      });
    },
    status() { return { cacheEntries: 0, providers: {} }; }
  };

  await withServer({}, async ({ base }) => {
    const controller = new AbortController();
    const request = fetch(`${base}/api/quotes?symbols=AAPL`, { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(request, error => error?.name === 'AbortError');
    await Promise.race([
      cancelled,
      new Promise((_, reject) => setTimeout(() => reject(new Error('server cancellation was not observed')), 500))
    ]);
  }, marketData);
});

test('invalid symbols are rejected before reaching the provider', async () => {
  await withServer({}, async ({ base, marketData }) => {
    const response = await fetch(`${base}/api/quotes?symbols=AAPL,<script>,BRK.B`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.invalidSymbols, ['<script>']);
    assert.ok(marketData.requested.includes('AAPL'));
    assert.ok(marketData.requested.includes('BRK.B'));
    assert.ok(!marketData.requested.includes('<SCRIPT>'));
  });
});

test('unknown API routes return JSON and server source files are not exposed', async () => {
  await withServer({}, async ({ base }) => {
    const missing = await fetch(`${base}/api/not-real`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'api_not_found');

    const source = await fetch(`${base}/server.js`);
    assert.equal(source.status, 200);
    assert.match(source.headers.get('content-type'), /text\/html/);
    assert.match(await source.text(), /^<!DOCTYPE html>/);
  });
});

test('personal dashboard discourages indexing and serves its social preview safely', async () => {
  await withServer({}, async ({ base }) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');

    const robots = await fetch(`${base}/robots.txt`);
    assert.match(await robots.text(), /Disallow: \/\s*$/m);

    const preview = await fetch(`${base}/og-v14-technical-signals.png`, { method: 'HEAD' });
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-type'), /image\/png/);
  });
});

test('complete upstream failure returns HTTP 503 instead of a false success', async () => {
  const unavailable = {
    async getSnapshot() {
      return { quotes: {}, fx: null, errors: ['AAPL', 'SPY', 'JPY=X'], stale: [], meta: { status: 'error' }, at: new Date().toISOString() };
    },
    status() { return { cacheEntries: 0, providers: {} }; }
  };
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/quotes?symbols=AAPL`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-market-data-status'), 'error');
    assert.equal(response.headers.get('retry-after'), '15');
    assert.equal((await response.json()).meta.status, 'error');
  }, unavailable);
});

test('provider and AI secrets require API_TOKEN', () => {
  assert.throws(
    () => validateConfiguration({ FINNHUB_API_KEY: 'secret' }),
    /require API_TOKEN/
  );
  assert.throws(
    () => validateConfiguration({ ANTHROPIC_API_KEY: 'secret' }),
    /require API_TOKEN/
  );
  assert.doesNotThrow(() => validateConfiguration({ FINNHUB_API_KEY: 'secret', API_TOKEN: 'guard' }));
});

test('quotes have a stricter route-specific rate limit', async () => {
  await withServer({ QUOTE_RATE_LIMIT_PER_MINUTE: '2' }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/quotes?symbols=AAPL`)).status, 200);
    assert.equal((await fetch(`${base}/api/quotes?symbols=AAPL`)).status, 200);
    const limited = await fetch(`${base}/api/quotes?symbols=AAPL`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  });
});

function stubThemeMarketData(status = 'ok') {
  return {
    requestedThemeIds: undefined,
    async getThemes({ ids }) {
      this.requestedThemeIds = ids;
      const unavailable = status === 'unavailable';
      return {
        updatedAt: '2026-07-12T00:00:00.000Z',
        asOf: unavailable ? null : '2026-07-10T20:00:00.000Z',
        status,
        partial: status !== 'ok',
        errors: unavailable ? ['NVDA'] : [],
        themes: unavailable ? [] : [{
          id: 'ai-semiconductors',
          name: 'AI半導体',
          performance: { '1d': 1, '5d': 2, '1m': 3, '1y': 4 },
          leaders: []
        }],
        meta: {
          status: unavailable ? 'error' : status,
          durationMs: 3,
          quality: { failed: unavailable ? 1 : 0 }
        }
      };
    },
    status() { return { cacheEntries: 0, providers: {} }; }
  };
}

test('themes endpoint returns all periods and validates allowlisted theme IDs', async () => {
  const marketData = stubThemeMarketData();
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/themes?ids=ai-semiconductors`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-market-data-status'), 'ok');
    assert.match(response.headers.get('cache-control'), /no-store/);
    const body = await response.json();
    assert.deepEqual(Object.keys(body.themes[0].performance), ['1d', '5d', '1m', '1y']);
    assert.deepEqual(marketData.requestedThemeIds, ['ai-semiconductors']);

    const invalid = await fetch(`${base}/api/themes?ids=ai-semiconductors,not-a-theme`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_theme_ids');
    assert.deepEqual(marketData.requestedThemeIds, ['ai-semiconductors']);
  }, marketData);
});

test('themes endpoint reports complete upstream failure as HTTP 503', async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/themes`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-market-data-status'), 'error');
    assert.equal((await response.json()).status, 'unavailable');
  }, stubThemeMarketData('unavailable'));
});

test('themes endpoint has an independent route-specific rate limit', async () => {
  await withServer({ THEME_RATE_LIMIT_PER_MINUTE: '1' }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/themes`)).status, 200);
    const limited = await fetch(`${base}/api/themes`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  }, stubThemeMarketData());
});

function stubIntelligenceMarketData(status = 'ok') {
  return {
    signalSeen: null,
    async getThemeIntelligence({ signal }) {
      this.signalSeen = signal;
      const unavailable = status === 'unavailable';
      return {
        updatedAt: '2026-07-12T00:00:00.000Z',
        asOf: unavailable ? null : '2026-07-10',
        dataRevision: 'theme-intelligence-v1:test',
        status,
        partial: status !== 'ok',
        actualFundFlow: false,
        flowProxy: null,
        categories: unavailable ? [] : [{ id: 'ai', name: 'AI', themeIds: ['ai-apps'] }],
        themes: unavailable ? [] : [{
          id: 'ai-apps',
          name: 'AIアプリ',
          trend: 'up',
          entry: 'watch',
          newsScore: null,
          newsCount: 0,
          constituents: []
        }],
        edges: [],
        nextCandidates: [],
        observedEvidence: [],
        errors: unavailable ? ['MSFT'] : [],
        meta: {
          status: unavailable ? 'error' : status,
          durationMs: 4,
          stale: false,
          cache: 'refreshed',
          quality: { failed: unavailable ? 1 : 0 }
        }
      };
    },
    status() { return { cacheEntries: 0, providers: {} }; }
  };
}

test('theme intelligence endpoint returns the non-fund-flow contract with market headers', async () => {
  const marketData = stubIntelligenceMarketData();
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/theme-intelligence`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-market-data-status'), 'ok');
    assert.match(response.headers.get('cache-control'), /no-store/);
    const body = await response.json();
    assert.equal(body.actualFundFlow, false);
    assert.equal(body.flowProxy, null);
    assert.equal(body.themes[0].newsScore, null);
    assert.equal(body.themes[0].trend, 'up');
    assert.equal(body.themes[0].entry, 'watch');
    assert.ok(marketData.signalSeen instanceof AbortSignal);
  }, marketData);
});

test('theme intelligence endpoint reports complete failure as 503 and has its own limiter', async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/theme-intelligence`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-market-data-status'), 'error');
    assert.equal((await response.json()).status, 'unavailable');
  }, stubIntelligenceMarketData('unavailable'));

  await withServer({ INTELLIGENCE_RATE_LIMIT_PER_MINUTE: '1' }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/theme-intelligence`)).status, 200);
    const limited = await fetch(`${base}/api/theme-intelligence`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  }, stubIntelligenceMarketData());
});

function serverRegimePayload() {
  const dates = [];
  const cursor = new Date('2026-06-01T21:00:00.000Z');
  while (dates.length < 30) {
    if (![0, 6].includes(cursor.getUTCDay())) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const histories = new Map([
    ['^VIX', index => 16 + index * 0.01],
    ['CL=F', index => 70 + index * 0.05],
    ['SPY', index => 500 + index]
  ].map(([symbol, valueAt]) => [symbol, {
    priceMode: 'adjusted',
    points: dates.map((date, index) => {
      const value = valueAt(index);
      return {
        timestamp: Date.parse(`${date}T21:00:00Z`) / 1000,
        at: `${date}T21:00:00.000Z`,
        sessionDate: date,
        close: value,
        rawClose: value,
        priceMode: 'adjusted'
      };
    })
  }]));
  return buildMarketRegimePayload(histories, `${dates.at(-1)}T23:00:00.000Z`);
}

function stubRegimeMarketData(status = 'ok') {
  const payload = serverRegimePayload();
  if (status === 'unavailable') {
    payload.status = 'unavailable';
    payload.partial = true;
    payload.regime.state = 'unavailable';
    payload.regime.score = null;
    payload.regime.optimismScore = null;
    payload.regime.riskScore = null;
    payload.meta.status = 'error';
  }
  return {
    signalSeen: null,
    forceRefreshSeen: null,
    async getMarketRegime({ signal, forceRefresh }) {
      this.signalSeen = signal;
      this.forceRefreshSeen = forceRefresh;
      return payload;
    },
    status() { return { cacheEntries: 0, providers: {} }; }
  };
}

test('market regime endpoint returns the frontend contract with provenance and no trading signal', async () => {
  const marketData = stubRegimeMarketData();
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/market-regime`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-market-data-status'), 'ok');
    assert.match(response.headers.get('cache-control'), /no-store/);
    const body = await response.json();
    assert.ok(['danger', 'caution', 'neutral', 'optimistic'].includes(body.regime.state));
    assert.equal(typeof body.regime.label, 'string');
    assert.equal(body.regime.riskScore, 100 - body.regime.optimismScore);
    assert.ok(Array.isArray(body.regime.reasons));
    assert.equal(body.regime.tradeEligible, false);
    assert.equal(body.tradingSignal, null);
    assert.equal(body.actualFundFlow, false);
    for (const key of ['vix', 'wti', 'spy']) {
      assert.equal(typeof body.instruments[key].symbol, 'string');
      assert.equal(typeof body.instruments[key].value, 'number');
      assert.deepEqual(Object.keys(body.instruments[key].changes), ['1d', '5d', '20d']);
      assert.equal(body.instruments[key].trail.length, 21);
    }
    assert.equal(body.meta.source.id, 'yahoo-spark');
    assert.equal(body.meta.source.official, false);
    assert.ok(marketData.signalSeen instanceof AbortSignal);
    assert.equal(marketData.forceRefreshSeen, false);
  }, marketData);
});

test('market regime refresh query explicitly requests an upstream revalidation', async () => {
  const marketData = stubRegimeMarketData();
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/market-regime?refresh=1`);
    assert.equal(response.status, 200);
    assert.equal(marketData.forceRefreshSeen, true);

    const alias = await fetch(`${base}/api/market-regime?refresh=true`);
    assert.equal(alias.status, 200);
    assert.equal(marketData.forceRefreshSeen, true);

    const ordinary = await fetch(`${base}/api/market-regime?refresh=0`);
    assert.equal(ordinary.status, 200);
    assert.equal(marketData.forceRefreshSeen, false);
  }, marketData);
});

test('market regime endpoint returns 503 when unavailable and has an independent limiter', async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/market-regime`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-market-data-status'), 'error');
    assert.equal((await response.json()).regime.state, 'unavailable');
  }, stubRegimeMarketData('unavailable'));

  await withServer({ MARKET_REGIME_RATE_LIMIT_PER_MINUTE: '1' }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/market-regime`)).status, 200);
    const limited = await fetch(`${base}/api/market-regime`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  }, stubRegimeMarketData());
});

test('market regime endpoint honors API_TOKEN before invoking market data', async () => {
  const marketData = stubRegimeMarketData();
  let calls = 0;
  const original = marketData.getMarketRegime.bind(marketData);
  marketData.getMarketRegime = async options => {
    calls += 1;
    return original(options);
  };
  await withServer({ API_TOKEN: 'regime-secret' }, async ({ base }) => {
    const denied = await fetch(`${base}/api/market-regime`);
    assert.equal(denied.status, 401);
    assert.equal(calls, 0);

    const allowed = await fetch(`${base}/api/market-regime`, {
      headers: { Authorization: 'Bearer regime-secret' }
    });
    assert.equal(allowed.status, 200);
    assert.equal(calls, 1);
  }, marketData);
});

test('market regime upstream exceptions return safe JSON without leaking a stack', async () => {
  const marketData = {
    async getMarketRegime() { throw new Error('secret upstream detail'); },
    status() { return { cacheEntries: 0, providers: {} }; }
  };
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/market-regime`);
    assert.equal(response.status, 502);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const body = await response.json();
    assert.equal(body.error, 'market_regime_unavailable');
    assert.doesNotMatch(JSON.stringify(body), /secret upstream detail|server\.js/i);
  }, marketData);
});

test('disconnecting from market regime propagates cancellation to its waiter', async () => {
  let markStarted;
  let markCancelled;
  const started = new Promise(resolve => { markStarted = resolve; });
  const cancelled = new Promise(resolve => { markCancelled = resolve; });
  const marketData = {
    getMarketRegime({ signal }) {
      markStarted();
      return new Promise(resolve => {
        signal.addEventListener('abort', () => {
          markCancelled();
          resolve({ status: 'unavailable', regime: { state: 'unavailable' }, meta: { status: 'error' } });
        }, { once: true });
      });
    },
    status() { return { cacheEntries: 0, providers: {} }; }
  };
  await withServer({}, async ({ base }) => {
    const controller = new AbortController();
    const request = fetch(`${base}/api/market-regime`, { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(request, error => error?.name === 'AbortError');
    await Promise.race([
      cancelled,
      new Promise((_, reject) => setTimeout(() => reject(new Error('market regime cancellation was not observed')), 500))
    ]);
  }, marketData);
});

test('buy signal API is SIMULATE-only, validates symbols and forwards bounded account context', async () => {
  const marketData = {
    seen: null,
    async getBuySignals(options) {
      this.seen = options;
      return {
        status: 'partial',
        asOf: '2026-07-29',
        results: [{
          ticker: 'SNDK',
          dataStatus: 'partial',
          price: 100,
          technical: { daily: {}, weekly: {} },
          signals: { active: 2, available: 6 },
          score: 64,
          decision: 'wait',
          chaseBlocked: false,
          positionPlan: null,
          reasons: [],
          warnings: ['fundamental/news unavailable'],
          provenance: [],
          execution: { mode: 'LIVE', autoOrder: true, tradingConnected: true },
          tradeEligible: true,
          _internal: { apiKey: 'must-not-leak' }
        }],
        execution: { mode: 'LIVE', autoOrder: true, tradingConnected: true },
        tradeEligible: true,
        _internal: { apiKey: 'must-not-leak' },
        meta: { status: 'partial', durationMs: 2, quality: { unverified: 1 } }
      };
    },
    status() { return { cacheEntries: 0, providers: {} }; }
  };
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/buy-signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbols: ['sndk'],
        account: {
          mode: 'SIMULATE',
          equityJpy: 3_000_000,
          cashJpy: 500_000,
          usdJpy: 155,
          riskBudgetJpy: 30_000,
          maxPositionPct: 12
        },
        positions: [{
          symbol: 'SNDK',
          shares: 10,
          avgCost: 95,
          price: 100,
          stop: 92,
          take: 120,
          currency: 'USD',
          role: 'trade'
        }],
        context: {
          events: [{ ticker: 'SNDK', date: '2026-08-01', label: '決算' }],
          news: [{ ticker: 'SNDK', headline: 'Unverified local headline', source: 'manual' }]
        }
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-market-data-status'), 'partial');
    const body = await response.json();
    assert.equal(body.execution.mode, 'SIMULATE');
    assert.equal(body.execution.autoOrder, false);
    assert.equal(body.execution.tradingConnected, false);
    assert.equal(body.tradeEligible, false);
    assert.equal(body.results[0].ticker, 'SNDK');
    assert.equal(body.results[0].execution.mode, 'SIMULATE');
    assert.equal(body.results[0].tradeEligible, false);
    assert.doesNotMatch(JSON.stringify(body), /must-not-leak|_internal|apiKey/);
    assert.deepEqual(marketData.seen.symbols, ['SNDK']);
    assert.equal(marketData.seen.account.mode, 'SIMULATE');
    assert.equal(marketData.seen.account.equityJpy, 3_000_000);
    assert.deepEqual(marketData.seen.positions, [{
      symbol: 'SNDK',
      shares: 10,
      avgCost: 95,
      price: 100,
      stop: 92,
      take: 120,
      currency: 'USD',
      role: 'trade'
    }]);
    assert.equal(marketData.seen.unverifiedContext.verified, false);
    assert.equal(marketData.seen.unverifiedContext.events.length, 1);
    assert.equal(marketData.seen.unverifiedContext.news.length, 1);

    const invalid = await fetch(`${base}/api/buy-signals?symbols=AAPL,%3Cscript%3E`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_signal_symbols');

    const liveMode = await fetch(`${base}/api/buy-signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: ['SNDK'], account: { mode: 'LIVE' } })
    });
    assert.equal(liveMode.status, 400);
    assert.equal((await liveMode.json()).error, 'invalid_simulation_account');

    const unsafePosition = await fetch(`${base}/api/buy-signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbols: ['SNDK'],
        positions: [{
          symbol: 'SNDK',
          shares: 10,
          avgCost: 95,
          price: 100,
          stop: 0,
          currency: 'USD'
        }]
      })
    });
    assert.equal(unsafePosition.status, 400);
    assert.match(
      (await unsafePosition.json()).invalidFields.join(','),
      /positions\[0\]\.stop/
    );
  }, marketData);
});

test('simulation envelope independently blocks leverage and requires numeric risk/reward >= 1.8', () => {
  const body = enforceSimulationEnvelope({
    status: 'ok',
    results: [
      {
        ticker: 'SOXL',
        decision: 'strong_buy_watch',
        active: true,
        riskReward: { ratio: 3, passed: true },
        positionPlan: { amountJpy: 100_000, amountUsd: 700, shares: 10 }
      },
      {
        ticker: 'NVDA',
        decision: 'buy_watch',
        active: true,
        leverageStatus: 'unleveraged',
        riskReward: { ratio: 1.79, passed: true, eligible: true },
        positionPlan: { amountJpy: 50_000, shares: 1 }
      },
      {
        ticker: 'SPY',
        dataStatus: 'stale',
        stale: true,
        decision: 'strong_buy_watch',
        active: true,
        leverageStatus: 'unleveraged',
        riskReward: { ratio: 2.2, passed: true },
        quality: { sufficient: true, stale: true },
        positionPlan: { amountJpy: 100_000, shares: 2 }
      }
    ]
  });
  assert.equal(body.results[0].decision, 'check');
  assert.equal(body.results[0].leverageBlocked, true);
  assert.equal(body.results[0].active, false);
  assert.equal(body.results[0].positionPlan.amountJpy, 0);
  assert.equal(body.results[0].positionPlan.shares, 0);
  assert.equal(body.results[1].decision, 'check');
  assert.equal(body.results[1].active, false);
  assert.equal(body.results[1].positionPlan.amountJpy, 0);
  assert.equal(body.results[1].positionPlan.shares, 0);
  assert.equal(body.results[2].decision, 'wait');
  assert.equal(body.results[2].active, false);
  assert.equal(body.results[2].positionPlan.amountJpy, 0);
  assert.equal(body.results[2].positionPlan.shares, 0);
  assert.equal(body.execution.mode, 'SIMULATE');
  assert.equal(body.tradeEligible, false);
});

test('simulation envelope strips nested secret and order aliases including over-depth values', () => {
  let tooDeep = { secret: 'deep-secret-marker' };
  for (let index = 0; index < 30; index += 1) tooDeep = { next: tooDeep };
  const body = enforceSimulationEnvelope({
    status: 'ok',
    meta: {
      api_key: 'root-api-key-marker',
      nested: { clientSecret: 'root-client-secret-marker' }
    },
    results: [{
      ticker: 'NVDA',
      status: 'ok',
      dataStatus: 'ok',
      decision: 'wait',
      leverageStatus: 'unleveraged',
      riskReward: 2,
      fundamental: {
        api_key: 'api-key-marker',
        nested: {
          clientSecret: 'client-secret-marker',
          accessToken: 'access-token-marker',
          orderRequest: { side: 'BUY', token: 'order-marker' }
        },
        tooDeep
      },
      positionPlan: {
        amountJpy: 10_000,
        shares: 1,
        orderRequest: { side: 'BUY', token: 'plan-order-marker' }
      }
    }]
  });
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(
    serialized,
    /api_key|clientSecret|accessToken|orderRequest|root-api-key-marker|root-client-secret-marker|api-key-marker|client-secret-marker|access-token-marker|order-marker|plan-order-marker|deep-secret-marker/
  );
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].ticker, 'NVDA');
});

test('simulation envelope fails closed for aliases, restrictions, earnings, chase and stale data', () => {
  const base = {
    status: 'ok',
    dataStatus: 'ok',
    decision: 'buy_watch',
    active: true,
    leverageStatus: 'unleveraged',
    riskReward: { ratio: 2.2, passed: true, eligible: true },
    quality: { sufficient: true, stale: false },
    positionPlan: { available: true, amountJpy: 50_000, amountUsd: 330, shares: 2 }
  };
  const body = enforceSimulationEnvelope({
    status: 'ok',
    results: [
      { ...base, ticker: 'AAPL', highChaseBlocked: true },
      { ...base, ticker: 'MSFT', restrictions: { chaseBlocked: true } },
      { ...base, ticker: 'TSLA', restrictions: { leverageBlocked: true } },
      { ...base, ticker: 'AMZN', restrictions: { earningsBlocked: true } },
      { ...base, ticker: 'NVDA', earningsDays: 3 },
      { ...base, ticker: 'AMD', chaseBlocked: true },
      { ...base, ticker: 'MU', stale: true, dataStatus: 'stale' }
    ]
  });

  assert.equal(body.results.length, 7);
  for (const result of body.results) {
    assert.equal(result.active, false, `${result.ticker} must not remain active`);
    assert.equal(result.positionPlan.available, false, `${result.ticker} plan must be unavailable`);
    assert.equal(result.positionPlan.amountJpy, 0, `${result.ticker} amountJpy must be zero`);
    assert.equal(result.positionPlan.amountUsd, 0, `${result.ticker} amountUsd must be zero`);
    assert.equal(result.positionPlan.shares, 0, `${result.ticker} shares must be zero`);
  }
  assert.deepEqual(body.results.slice(0, 6).map(result => result.decision), Array(6).fill('check'));
  assert.equal(body.results[6].decision, 'wait');
  assert.equal(body.results[0].chaseBlocked, true);
  assert.equal(body.results[1].chaseBlocked, true);
  assert.equal(body.results[2].leverageBlocked, true);
  assert.equal(body.results[3].earningsBlocked, true);
  assert.equal(body.results[4].earningsBlocked, true);
});

test('buy signal API returns 503 for unavailable evidence and remains protected by API_TOKEN', async () => {
  let calls = 0;
  const marketData = {
    async getBuySignals() {
      calls += 1;
      return {
        status: 'unavailable',
        results: [],
        execution: { mode: 'SIMULATE', autoOrder: false, tradingConnected: false },
        meta: { status: 'error', quality: { failed: 1 } }
      };
    },
    status() { return { cacheEntries: 0, providers: {} }; }
  };
  await withServer({ API_TOKEN: 'signal-secret' }, async ({ base }) => {
    const denied = await fetch(`${base}/api/buy-signals?symbols=NVDA`);
    assert.equal(denied.status, 401);
    assert.equal(calls, 0);

    const allowed = await fetch(`${base}/api/buy-signals?symbols=NVDA`, {
      headers: { Authorization: 'Bearer signal-secret' }
    });
    assert.equal(allowed.status, 503);
    assert.equal(calls, 1);
    const body = await allowed.json();
    assert.equal(body.execution.tradingConnected, false);
  }, marketData);
});

test('buy signal API fails closed with 503 when an upstream ok payload has no results', async () => {
  const marketData = {
    async getBuySignals() {
      return {
        status: 'ok',
        results: [],
        meta: { status: 'ok', durationMs: 1, quality: {} }
      };
    },
    status() { return { cacheEntries: 0, providers: {} }; }
  };
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/buy-signals?symbols=NVDA`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-market-data-status'), 'error');
    const body = await response.json();
    assert.equal(body.status, 'unavailable');
    assert.deepEqual(body.results, []);
    assert.equal(body.meta.status, 'error');
  }, marketData);
});

test('buy signal API rejects a second concurrent request and releases the first on cancellation', async () => {
  let markStarted;
  let markCancelled;
  const started = new Promise(resolve => { markStarted = resolve; });
  const cancelled = new Promise(resolve => { markCancelled = resolve; });
  let calls = 0;
  const marketData = {
    async getBuySignals({ signal }) {
      calls += 1;
      markStarted();
      return new Promise(resolve => {
        signal.addEventListener('abort', () => {
          markCancelled();
          resolve({
            status: 'unavailable',
            results: [],
            meta: { status: 'error', quality: { failed: 1 } }
          });
        }, { once: true });
      });
    },
    status() { return { cacheEntries: 0, providers: {} }; }
  };
  await withServer({
    TECHNICAL_SIGNAL_MAX_CONCURRENCY: '1',
    TECHNICAL_SIGNAL_RATE_LIMIT_PER_MINUTE: '10'
  }, async ({ base }) => {
    const controller = new AbortController();
    const first = fetch(`${base}/api/buy-signals?symbols=NVDA`, {
      signal: controller.signal
    });
    await started;

    const second = await fetch(`${base}/api/buy-signals?symbols=NVDA`);
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '5');
    assert.equal((await second.json()).error, 'technical_signal_busy');
    assert.equal(calls, 1);

    controller.abort();
    await assert.rejects(first, error => error?.name === 'AbortError');
    await Promise.race([
      cancelled,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('technical signal cancellation was not observed')),
        1_000
      ))
    ]);
  }, marketData);
});

test('buy signal API returns a hard 504 deadline even when downstream ignores AbortSignal', async () => {
  let downstreamSignal;
  const marketData = {
    async getBuySignals({ signal }) {
      downstreamSignal = signal;
      return new Promise(() => {});
    },
    status() { return { cacheEntries: 0, providers: {} }; }
  };
  await withServer({
    TECHNICAL_SIGNAL_ROUTE_TIMEOUT_MS: '5000',
    TECHNICAL_SIGNAL_RATE_LIMIT_PER_MINUTE: '10'
  }, async ({ base }) => {
    const startedAt = Date.now();
    const response = await fetch(`${base}/api/buy-signals?symbols=NVDA`, {
      signal: AbortSignal.timeout(8_000)
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.status, 504);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.equal((await response.json()).error, 'technical_signal_timeout');
    assert.equal(downstreamSignal.aborted, true);
    assert.ok(elapsedMs >= 4_500, `deadline fired too early: ${elapsedMs}ms`);
    assert.ok(elapsedMs < 8_000, `deadline did not terminate the request: ${elapsedMs}ms`);
  }, marketData);
});

test('technical backtest API forwards costs, defaults to the fixed universe and rejects unsafe values', async () => {
  const marketData = {
    seen: null,
    async getTechnicalBacktest(options) {
      this.seen = options;
      return {
        status: 'partial',
        methodology: {
          entry: 'next-session-adjusted-open',
          commissionBps: options.commissionBps,
          slippageBps: options.slippageBps,
          lookaheadBias: false
        },
        results: [{
          symbol: 'SPY',
          ticker: 'SPY',
          status: 'partial',
          dataStatus: 'partial',
          leverageStatus: 'unleveraged',
          backtest: {
            status: 'partial',
            methodVersion: 'test-backtest-v1',
            strategies: []
          },
          warnings: ['fixture']
        }],
        meta: { status: 'partial', durationMs: 3, quality: { reference: 1 } }
      };
    },
    status() { return { cacheEntries: 0, providers: {} }; }
  };
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/buy-signals/backtest?commissionBps=2.5&slippageBps=12`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.methodology.lookaheadBias, false);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].ticker, 'SPY');
    assert.equal(marketData.seen.commissionBps, 2.5);
    assert.equal(marketData.seen.slippageBps, 12);
    assert.ok(marketData.seen.symbols.includes('SPY'));
    assert.ok(marketData.seen.symbols.includes('SNDK'));

    const invalid = await fetch(`${base}/api/buy-signals/backtest?commissionBps=-1`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_backtest_parameters');
  }, marketData);
});

test('rate limiter clamps negative and infinite limits to safe finite values', () => {
  const request = { ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } };
  const makeResponse = () => ({
    headers: new Map(),
    statusCode: null,
    body: null,
    set(name, value) {
      this.headers.set(String(name).toLowerCase(), String(value));
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  });

  const negative = createRateLimiter({ max: -5, windowMs: -1, maxBuckets: -1 });
  let negativeNextCalls = 0;
  const first = makeResponse();
  negative(request, first, () => { negativeNextCalls += 1; });
  assert.equal(negativeNextCalls, 1);
  assert.equal(first.headers.get('ratelimit-limit'), '1');
  const second = makeResponse();
  negative(request, second, () => { negativeNextCalls += 1; });
  assert.equal(negativeNextCalls, 1);
  assert.equal(second.statusCode, 429);
  assert.equal(second.body.error, 'rate_limited');

  const infinite = createRateLimiter({
    max: Number.POSITIVE_INFINITY,
    windowMs: Number.POSITIVE_INFINITY,
    maxBuckets: Number.POSITIVE_INFINITY
  });
  let infiniteNextCalls = 0;
  const finiteFallback = makeResponse();
  infinite(request, finiteFallback, () => { infiniteNextCalls += 1; });
  assert.equal(infiniteNextCalls, 1);
  assert.equal(finiteFallback.headers.get('ratelimit-limit'), '60');
  assert.match(finiteFallback.headers.get('ratelimit-reset'), /^\d+$/);
});
