'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyValidatedEdgeAssociations,
  buildIntelligencePayload,
  buildMarketRegimePayload,
  buildRrgData,
  chronologicalAssociationWindows,
  compareProviders,
  calculatePeriodPerformance,
  INTELLIGENCE_CATEGORIES,
  INTELLIGENCE_STRUCTURAL_EDGES,
  INTELLIGENCE_THEME_CATALOG,
  MARKET_REGIME_MAX_OBSERVATION_AGE_MS,
  RRG_LONG_SESSIONS,
  RRG_SHORT_SESSIONS,
  RRG_TRAIL_POINTS,
  MarketDataService,
  normalizeHistoryPoints,
  normalizeTechnicalBars,
  parseYahooSpark,
  parseYahooTechnicalChartHistory,
  parseYahooTechnicalHistory,
  parseYahooThemeHistory,
  parseYahooChartHistory,
  quoteFromChart,
  quoteFreshness,
  rrgQuadrant,
  scoreMarketRegime,
  THEME_CATALOG
} = require('../market-data');

function chart(symbol, prices, current = prices.at(-1), time = 1_800_000_000) {
  return {
    meta: {
      symbol,
      currency: symbol === 'JPY=X' ? 'JPY' : 'USD',
      regularMarketPrice: current,
      regularMarketTime: time,
      chartPreviousClose: prices[0] / 2,
      fullExchangeName: symbol === 'JPY=X' ? 'CCY' : 'NasdaqGS',
      longName: symbol,
      currentTradingPeriod: {}
    },
    indicators: { quote: [{ close: prices }] }
  };
}

function sparkPayload(symbols) {
  return {
    spark: {
      result: symbols.map(({ symbol, prices, current }) => ({
        symbol,
        response: [chart(symbol, prices, current)]
      })),
      error: null
    }
  };
}

test('daily change uses the previous trading close, not chartPreviousClose', () => {
  const quote = quoteFromChart(chart('AAPL', [50, 100, 110]), '2026-01-01T00:00:00.000Z');
  assert.equal(quote.previousClose, 100);
  assert.equal(quote.changePct, 10);
  assert.notEqual(quote.changePct, 120);
});

test('Yahoo Spark batch parser returns every symbol including FX', () => {
  const payload = sparkPayload([
    { symbol: 'AAPL', prices: [100, 101] },
    { symbol: 'NVDA', prices: [200, 210] },
    { symbol: 'JPY=X', prices: [160, 161] }
  ]);
  const parsed = parseYahooSpark(payload, '2026-01-01T00:00:00.000Z');
  assert.deepEqual([...parsed.keys()].sort(), ['AAPL', 'JPY=X', 'NVDA']);
  assert.equal(parsed.get('NVDA').changePct, 5);
});

test('closed holiday and early-close observations remain valid previous closes', () => {
  const fixtures = [
    { now: '2026-07-03T14:00:00Z', at: '2026-07-02T20:00:00Z' },
    { now: '2026-11-27T19:00:00Z', at: '2026-11-27T18:00:00Z' }
  ];
  for (const fixture of fixtures) {
    const nowMs = Date.parse(fixture.now);
    const result = quoteFreshness({
      at: fixture.at,
      retrievedAt: fixture.now,
      marketState: 'closed',
      delayed: false
    }, 'refreshed', 0, nowMs, 45_000);
    assert.equal(result.status, 'previous-close-valid');
    assert.equal(result.transportFresh, true);
    assert.equal(result.marketRecency, 'previous-session');
  }
});

test('a freshly transported but week-old closed-session quote is stale', () => {
  const now = Date.parse('2026-07-12T16:00:00Z');
  const result = quoteFreshness({
    at: '2026-07-02T20:00:00Z',
    retrievedAt: '2026-07-12T16:00:00Z',
    marketState: 'closed',
    delayed: false
  }, 'refreshed', 0, now, 45_000);
  assert.equal(result.transportFresh, true);
  assert.equal(result.marketRecency, 'aged');
  assert.equal(result.status, 'stale');
});

test('provider consensus refuses cross-currency or cross-session comparisons', () => {
  const base = {
    price: 100,
    at: '2026-07-06T14:00:00Z',
    src: 'primary',
    currency: 'USD',
    marketState: 'open'
  };
  const currencyMismatch = compareProviders(base, {
    ...base,
    price: 120,
    src: 'secondary',
    currency: 'EUR'
  }, 1.5, '2026-07-06T14:00:01Z');
  assert.equal(currencyMismatch.status, 'inconclusive');
  assert.equal(currencyMismatch.reason, 'currency-mismatch');

  const sessionMismatch = compareProviders(base, {
    ...base,
    price: 120,
    src: 'secondary',
    marketState: 'closed'
  }, 1.5, '2026-07-06T14:00:01Z');
  assert.equal(sessionMismatch.status, 'inconclusive');
  assert.equal(sessionMismatch.reason, 'session-mismatch');
});

test('MarketDataService fetches multiple quotes in one Yahoo batch request', async () => {
  const calls = [];
  const payload = sparkPayload([
    { symbol: 'AAPL', prices: [100, 101] },
    { symbol: 'NVDA', prices: [200, 210] },
    { symbol: 'JPY=X', prices: [160, 161] }
  ]);
  const service = new MarketDataService({
    fetch: async url => {
      calls.push(String(url));
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    now: () => 1_800_000_000_000,
    sleep: async () => {}
  });

  const result = await service.getSnapshot(['AAPL', 'NVDA', 'JPY=X']);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /finance\/spark/);
  assert.equal(result.quotes.AAPL.price, 101);
  assert.equal(result.quotes.NVDA.price, 210);
  assert.equal(result.fx.usdJpy, 161);
  assert.deepEqual(result.fx.closes, [160, 161]);
  assert.equal(result.fx.freshness, 'previous-close-valid');
  assert.equal(result.meta.symbols.AAPL.cacheState, 'refreshed');
  assert.equal(result.meta.symbols.AAPL.quoteAgeMs, 0);
  assert.equal(result.meta.delivery.cache.refreshed, 3);
  assert.equal(result.meta.delivery.upstream.yahooBatches, 1);
  assert.equal(result.meta.status, 'ok');
  assert.deepEqual(result.meta.quality, {
    coveragePct: 100,
    fresh: 3,
    live: 0,
    closeValid: 3,
    stale: 0,
    failed: 0,
    delayed: 0,
    aged: 0,
    reference: 0,
    unverified: 0,
    consensusWarnings: 0,
    grade: 'close-valid'
  });
});

test('FX history is finite, positive and bounded for risk calculations', async () => {
  const prices = [null, 'bad', -1, 0, ...Array.from({ length: 80 }, (_, index) => 100 + index)];
  const service = new MarketDataService({
    fetch: async () => new Response(JSON.stringify(sparkPayload([
      { symbol: 'JPY=X', prices, current: 180 }
    ])), { status: 200 }),
    now: () => 1_800_000_000_000,
    sleep: async () => {}
  });

  const result = await service.getSnapshot(['JPY=X']);
  assert.equal(result.fx.closes.length, 66);
  assert.equal(result.fx.closes.at(-1), 179);
  assert.ok(result.fx.closes.every(value => Number.isFinite(value) && value > 0));
});

test('Finnhub and Yahoo prices are compared without an extra provider call', async () => {
  const calls = [];
  const service = new MarketDataService({
    finnhubKey: 'test-key',
    providerDivergencePct: 1,
    now: () => 1_800_000_000_000,
    fetch: async (url, init) => {
      calls.push(String(url));
      if (String(url).includes('finnhub.io')) {
        assert.equal(init.headers['X-Finnhub-Token'], 'test-key');
        return new Response(JSON.stringify({ c: 100, pc: 99, t: 1_800_000_000 }), { status: 200 });
      }
      return new Response(JSON.stringify(sparkPayload([
        { symbol: 'AAPL', prices: [99, 103], current: 103 }
      ])), { status: 200 });
    },
    sleep: async () => {}
  });

  const result = await service.getSnapshot(['AAPL']);
  assert.equal(calls.length, 2);
  assert.equal(result.quotes.AAPL.src, 'finnhub');
  assert.equal(result.quotes.AAPL.providerComparison.status, 'divergent');
  assert.ok(result.quotes.AAPL.providerComparison.differencePct > 2);
  assert.equal(result.quotes.AAPL.marketState, 'closed');
  assert.equal(result.meta.symbols.AAPL.providerConsensus, 'divergent');
  assert.equal(result.meta.quality.consensusWarnings, 1);
  assert.equal(result.meta.status, 'partial');
  assert.equal(result.meta.quality.grade, 'divergent');
  assert.equal(service.status().consensus.divergences, 1);
});

test('pre-market previous close stays valid while transport and market ages remain separate', async () => {
  const now = Date.parse('2026-07-06T12:00:00Z');
  const service = new MarketDataService({
    fetch: async () => { throw new Error('fresh cache should avoid upstream'); },
    now: () => now,
    sleep: async () => {}
  });
  service._setCache('AAPL', {
    price: 100,
    changePct: 0,
    at: '2026-07-02T20:00:00Z',
    retrievedAt: new Date(now).toISOString(),
    closes: [98, 100],
    marketState: 'pre',
    delayed: false,
    src: 'test'
  });

  const result = await service.getSnapshot(['AAPL']);
  assert.equal(result.quotes.AAPL.cacheState, 'hit');
  assert.equal(result.quotes.AAPL.freshness, 'previous-close-valid');
  assert.equal(result.meta.symbols.AAPL.cacheAgeMs, 0);
  assert.ok(result.meta.symbols.AAPL.quoteAgeMs > 3 * 24 * 60 * 60 * 1000);
  assert.equal(result.meta.symbols.AAPL.transportAgeMs, 0);
  assert.equal(result.meta.symbols.AAPL.transportFresh, true);
  assert.equal(result.meta.symbols.AAPL.marketRecency, 'previous-session');
  assert.equal(result.meta.quality.fresh, 1);
  assert.equal(result.meta.quality.live, 0);
  assert.equal(result.meta.quality.closeValid, 1);
  assert.equal(result.meta.quality.aged, 0);
  assert.equal(result.meta.quality.grade, 'close-valid');
  assert.deepEqual(result.meta.delivery.cache, {
    hits: 1,
    refreshed: 0,
    staleFallbacks: 0,
    negativeHits: 0
  });
});

test('an old observation during an open session is stale even when freshly retrieved', async () => {
  const now = Date.parse('2026-07-06T14:00:00Z');
  const service = new MarketDataService({
    fetch: async () => { throw new Error('fresh cache should avoid upstream'); },
    now: () => now,
    sleep: async () => {}
  });
  service._setCache('AAPL', {
    price: 100,
    changePct: 0,
    at: '2026-07-02T20:00:00Z',
    retrievedAt: new Date(now).toISOString(),
    closes: [98, 100],
    marketState: 'open',
    delayed: false,
    src: 'test'
  });

  const result = await service.getSnapshot(['AAPL']);
  assert.equal(result.quotes.AAPL.freshness, 'stale');
  assert.equal(result.meta.symbols.AAPL.transportFresh, true);
  assert.equal(result.meta.symbols.AAPL.marketRecency, 'aged');
  assert.equal(result.meta.quality.fresh, 0);
  assert.equal(result.meta.quality.live, 0);
  assert.equal(result.meta.quality.closeValid, 0);
  assert.equal(result.meta.quality.aged, 1);
  assert.equal(result.meta.quality.grade, 'aged');
  assert.equal(result.meta.status, 'partial');
});

test('concurrent Yahoo batches are serialized globally to avoid shared-IP bursts', async () => {
  let active = 0;
  let maxActive = 0;
  const service = new MarketDataService({
    fetch: async url => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 15));
      const symbols = new URL(String(url)).searchParams.get('symbols').split(',');
      const payload = sparkPayload(symbols.map((symbol, index) => ({ symbol, prices: [100 + index, 101 + index] })));
      active -= 1;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    sleep: async () => {}
  });

  await Promise.all([
    service.getSnapshot(['AAPL']),
    service.getSnapshot(['NVDA'])
  ]);
  assert.equal(maxActive, 1);
});

test('overlapping snapshots are unioned into one Yahoo request without fetching a symbol twice', async () => {
  const batches = [];
  const service = new MarketDataService({
    yahooBatchWindowMs: 25,
    fetch: async url => {
      const symbols = new URL(String(url)).searchParams.get('symbols').split(',');
      batches.push(symbols);
      return new Response(JSON.stringify(sparkPayload(
        symbols.map((symbol, index) => ({ symbol, prices: [100 + index, 101 + index] }))
      )), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    sleep: async () => {}
  });

  const [left, right] = await Promise.all([
    service.getSnapshot(['AAPL', 'NVDA']),
    service.getSnapshot(['AAPL', 'MSFT'])
  ]);

  assert.equal(batches.length, 1);
  assert.deepEqual([...batches[0]].sort(), ['AAPL', 'MSFT', 'NVDA']);
  assert.equal(batches.flat().filter(symbol => symbol === 'AAPL').length, 1);
  assert.ok(left.quotes.AAPL && left.quotes.NVDA);
  assert.ok(right.quotes.AAPL && right.quotes.MSFT);
  assert.equal(service.status().coalescing.yahooJoins, 1);
});

test('a later overlapping request joins an already-running Yahoo symbol flight', async () => {
  const batches = [];
  let releaseFirst;
  let markStarted;
  const firstStarted = new Promise(resolve => { markStarted = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const service = new MarketDataService({
    yahooBatchWindowMs: 5,
    fetch: async url => {
      const symbols = new URL(String(url)).searchParams.get('symbols').split(',');
      batches.push(symbols);
      if (batches.length === 1) {
        markStarted();
        await firstGate;
      }
      return new Response(JSON.stringify(sparkPayload(
        symbols.map((symbol, index) => ({ symbol, prices: [200 + index, 201 + index] }))
      )), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    sleep: async () => {}
  });

  const first = service.getSnapshot(['AAPL', 'NVDA']);
  await firstStarted;
  const second = service.getSnapshot(['AAPL', 'MSFT']);
  await new Promise(resolve => setTimeout(resolve, 15));
  releaseFirst();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(batches.length, 2);
  assert.equal(batches.flat().filter(symbol => symbol === 'AAPL').length, 1);
  assert.deepEqual([...batches[1]].sort(), ['MSFT']);
  assert.ok(left.quotes.AAPL && right.quotes.AAPL && right.quotes.MSFT);
});

test('Yahoo symbol-flight bookkeeping is bounded under a burst of unique symbols', async () => {
  let releaseFetch;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const gate = new Promise(resolve => { releaseFetch = resolve; });
  const service = new MarketDataService({
    maxInFlightEntries: 10,
    yahooBatchWindowMs: 5,
    fetch: async url => {
      const symbols = new URL(String(url)).searchParams.get('symbols').split(',');
      markStarted();
      await gate;
      return new Response(JSON.stringify(sparkPayload(
        symbols.map(symbol => ({ symbol, prices: [10, 11] }))
      )), { status: 200 });
    },
    sleep: async () => {}
  });
  const symbols = Array.from({ length: 11 }, (_, index) => `SYM${index}`);

  const pending = service.yahooSpark(symbols);
  await started;
  const active = service.status();
  assert.equal(active.coalescing.yahooInFlight, 10);
  assert.equal(active.coalescing.capacityDrops, 1);
  releaseFetch();
  const result = await pending;

  assert.equal(result.size, 10);
  assert.equal(service.status().coalescing.yahooInFlight, 0);
});

test('cancelling one caller does not abort a shared Yahoo fetch needed by another caller', async () => {
  const controller = new AbortController();
  const upstreamSignals = [];
  let releaseFetch;
  let markStarted;
  const fetchStarted = new Promise(resolve => { markStarted = resolve; });
  const fetchGate = new Promise(resolve => { releaseFetch = resolve; });
  let calls = 0;
  const service = new MarketDataService({
    yahooBatchWindowMs: 5,
    deadlineMs: 500,
    fetch: async (url, init) => {
      calls += 1;
      upstreamSignals.push(init.signal);
      const symbols = new URL(String(url)).searchParams.get('symbols').split(',');
      markStarted();
      await fetchGate;
      return new Response(JSON.stringify(sparkPayload(
        symbols.map(symbol => ({ symbol, prices: [300, 303] }))
      )), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    sleep: async () => {}
  });

  const cancelledCall = service.getSnapshot(['AAPL'], { signal: controller.signal });
  const survivingCall = service.getSnapshot(['AAPL']);
  await fetchStarted;
  controller.abort();
  releaseFetch();
  const [cancelled, survived] = await Promise.all([cancelledCall, survivingCall]);

  assert.equal(calls, 1);
  assert.equal(cancelled.meta.cancelled, true);
  assert.equal(survived.meta.status, 'ok');
  assert.equal(survived.quotes.AAPL.price, 303);
  assert.equal(upstreamSignals[0].aborted, false);
  assert.deepEqual(service.status().circuits, {});
});

test('Finnhub symbol flights also coalesce overlapping request sets', async () => {
  const finnhubSymbols = [];
  const service = new MarketDataService({
    finnhubKey: 'header-only-secret',
    yahooBatchWindowMs: 5,
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === 'finnhub.io') {
        const symbol = parsed.searchParams.get('symbol');
        finnhubSymbols.push(symbol);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(init.headers['X-Finnhub-Token'], 'header-only-secret');
        return new Response(JSON.stringify({ c: 101, pc: 100, t: 1_800_000_000 }), { status: 200 });
      }
      const symbols = parsed.searchParams.get('symbols').split(',');
      return new Response(JSON.stringify(sparkPayload(
        symbols.map(symbol => ({ symbol, prices: [99, 100] }))
      )), { status: 200 });
    },
    sleep: async () => {}
  });

  await Promise.all([
    service.getSnapshot(['AAPL', 'NVDA']),
    service.getSnapshot(['AAPL', 'MSFT'])
  ]);

  assert.deepEqual([...finnhubSymbols].sort(), ['AAPL', 'MSFT', 'NVDA']);
  assert.equal(finnhubSymbols.filter(symbol => symbol === 'AAPL').length, 1);
  assert.ok(service.status().coalescing.sharedJoins >= 1);
});

test('an open Finnhub circuit does not spend budget on calls that are never sent', async () => {
  let finnhubRequests = 0;
  const symbols = Array.from({ length: 40 }, (_, index) => `S${String(index).padStart(2, '0')}`);
  const service = new MarketDataService({
    finnhubKey: 'test-key',
    fetch: async url => {
      if (String(url).includes('finnhub.io')) {
        finnhubRequests += 1;
        return new Response('unavailable', { status: 503 });
      }
      if (String(url).includes('finance.yahoo.com')) {
        const requested = new URL(String(url)).searchParams.get('symbols').split(',');
        return new Response(JSON.stringify(sparkPayload(requested.map((symbol, index) => ({
          symbol,
          prices: [100 + index, 101 + index]
        })))), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    },
    sleep: async () => {}
  });

  const result = await service.getSnapshot(symbols);
  assert.equal(result.meta.status, 'ok');
  assert.ok(finnhubRequests <= 3, `sent ${finnhubRequests} Finnhub requests`);
  assert.equal(service.status().finnhubBudget.used, finnhubRequests);
});

test('provider diagnostics record circuit recovery after the cool-down', async () => {
  let now = Date.parse('2026-07-12T00:00:00Z');
  let calls = 0;
  const service = new MarketDataService({
    now: () => now,
    clock: () => now,
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response('temporary failure', { status: 503 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });

  await assert.rejects(service._requestJson('probe', 'https://example.test/data'));
  let status = service.status();
  assert.equal(status.providers.probe.circuitTrips, 1);
  assert.equal(status.providers.probe.consecutiveFailures, 1);
  assert.equal(status.providers.probe.health, 'circuit-open');

  now += 15_001;
  assert.deepEqual(await service._requestJson('probe', 'https://example.test/data'), { ok: true });
  status = service.status();
  assert.equal(status.providers.probe.recoveries, 1);
  assert.equal(status.providers.probe.consecutiveFailures, 0);
  assert.equal(status.providers.probe.health, 'healthy');
  assert.deepEqual(status.circuits, {});
});

test('a configured Finnhub key makes the official provider primary', async () => {
  const calls = [];
  const service = new MarketDataService({
    finnhubKey: 'test-key',
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers || {} });
      if (String(url).includes('finnhub.io')) {
        return new Response(JSON.stringify({ c: 101, pc: 100, dp: 1, t: 1_800_000_000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify(sparkPayload([
        { symbol: 'AAPL', prices: [98, 100] }
      ])), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    sleep: async () => {}
  });

  const result = await service.getSnapshot(['AAPL']);
  assert.equal(result.quotes.AAPL.src, 'finnhub');
  assert.equal(result.quotes.AAPL.price, 101);
  assert.deepEqual(result.quotes.AAPL.closes, [98, 100]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /finnhub\.io/);
  assert.doesNotMatch(calls[0].url, /test-key/);
  assert.equal(calls[0].headers['X-Finnhub-Token'], 'test-key');
});

test('FX falls back to the ECB reference rate when Yahoo is unavailable', async () => {
  const calls = [];
  const service = new MarketDataService({
    fetch: async url => {
      calls.push(String(url));
      if (String(url).includes('frankfurter.dev')) {
        return new Response(JSON.stringify([{ date: '2026-07-10', base: 'USD', quote: 'JPY', rate: 161.87 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response('rate limited', { status: 429 });
    },
    now: () => Date.parse('2026-07-11T00:00:00Z'),
    sleep: async () => {}
  });

  const result = await service.getSnapshot(['JPY=X']);
  assert.equal(result.fx.usdJpy, 161.87);
  assert.equal(result.fx.src, 'frankfurter');
  assert.equal(result.fx.delayed, true);
  assert.equal(result.fx.freshness, 'reference');
  assert.equal(result.fx.currency, 'JPY');
  assert.equal(result.meta.quality.fresh, 0);
  assert.equal(result.meta.quality.delayed, 1);
  assert.equal(result.meta.quality.grade, 'delayed');
  assert.equal(result.meta.status, 'partial');
  assert.ok(calls.some(url => url.includes('query1.finance.yahoo.com')));
  assert.ok(calls.some(url => url.includes('query2.finance.yahoo.com')));
});

test('expired good data is returned as stale when every provider fails', async () => {
  let now = 1_800_000_000_000;
  const service = new MarketDataService({
    fetch: async () => new Response('unavailable', { status: 503 }),
    now: () => now,
    ttlMs: 1000,
    staleMs: 60_000,
    sleep: async () => {}
  });
  service._setCache('AAPL', {
    price: 123.45,
    changePct: 1,
    at: new Date(now).toISOString(),
    retrievedAt: new Date(now).toISOString(),
    closes: [120, 123.45],
    src: 'test'
  });
  now += 2000;

  const result = await service.getSnapshot(['AAPL']);
  assert.equal(result.quotes.AAPL.price, 123.45);
  assert.equal(result.quotes.AAPL.stale, true);
  assert.deepEqual(result.stale, ['AAPL']);
  assert.equal(result.meta.status, 'partial');
  assert.equal(result.meta.quality.grade, 'stale');
  assert.equal(result.meta.quality.stale, 1);
});

test('a snapshot-wide deadline stops an upstream fetch that ignores AbortSignal', async () => {
  let calls = 0;
  const service = new MarketDataService({
    fetch: async () => { calls += 1; return new Promise(() => {}); },
    deadlineMs: 60,
    timeoutMs: 10_000,
    yahooTimeoutMs: 10_000,
    sleep: async () => {}
  });

  const started = Date.now();
  const result = await service.getSnapshot(['AAPL', 'JPY=X']);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 500, `deadline took ${elapsed}ms`);
  assert.equal(result.meta.status, 'error');
  assert.equal(result.meta.deadlineExceeded, true);
  assert.ok(calls <= 1, `unexpected outbound calls: ${calls}`);
});

test('client cancellation returns promptly and detached shared work is cleaned up at its deadline', async () => {
  const controller = new AbortController();
  let upstreamSignal;
  const service = new MarketDataService({
    fetch: async (url, init) => {
      upstreamSignal = init.signal;
      return new Promise(() => {});
    },
    yahooBatchWindowMs: 5,
    deadlineMs: 100,
    sleep: async () => {}
  });
  setTimeout(() => controller.abort(), 30);

  const started = Date.now();
  const result = await service.getSnapshot(['AAPL'], { signal: controller.signal });

  assert.ok(Date.now() - started < 500);
  assert.equal(result.meta.cancelled, true);
  assert.equal(upstreamSignal.aborted, false);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(service.status().inFlight, 0);
});

const historyPoint = (date, close, priceMode = 'adjusted') => ({
  timestamp: Date.parse(`${date}T20:00:00Z`) / 1000,
  at: `${date}T20:00:00.000Z`,
  close,
  rawClose: close,
  priceMode
});

test('theme periods use trading sessions and never look ahead across a market holiday', () => {
  const points = [
    historyPoint('2025-07-03', 80),
    historyPoint('2026-06-05', 90),
    historyPoint('2026-06-26', 100),
    historyPoint('2026-06-29', 102),
    historyPoint('2026-06-30', 101),
    historyPoint('2026-07-01', 103),
    historyPoint('2026-07-02', 104),
    // July 3 was the observed Independence Day holiday; no fabricated point.
    historyPoint('2026-07-06', 106)
  ];
  const oneDay = calculatePeriodPerformance(points, '1d');
  const fiveDay = calculatePeriodPerformance(points, '5d');
  const oneMonth = calculatePeriodPerformance(points, '1m');
  const oneYear = calculatePeriodPerformance(points, '1y');
  assert.equal(oneDay.baselineAt, '2026-07-02T20:00:00.000Z');
  assert.equal(oneDay.sessions, 1);
  assert.ok(Math.abs(oneDay.valuePct - 1.9230769230769231) < 1e-12);
  assert.equal(fiveDay.baselineAt, '2026-06-26T20:00:00.000Z');
  assert.equal(fiveDay.sessions, 5);
  assert.ok(Math.abs(fiveDay.valuePct - 6) < 1e-12);
  assert.equal(oneMonth.baselineAt, '2026-06-05T20:00:00.000Z');
  assert.ok(Math.abs(oneMonth.valuePct - 17.77777777777777) < 1e-12);
  assert.equal(oneYear.baselineAt, '2025-07-03T20:00:00.000Z');
  assert.ok(Math.abs(oneYear.valuePct - 32.5) < 1e-12);
});

test('calendar month and leap-year anchors choose the nearest prior trading close', () => {
  const monthPoints = [
    historyPoint('2026-07-01', 90),
    historyPoint('2026-07-02', 100),
    historyPoint('2026-07-06', 101),
    historyPoint('2026-08-03', 110)
  ];
  const month = calculatePeriodPerformance(monthPoints, '1m');
  // 2026-07-03 was closed, so the baseline must be July 2, not July 6.
  assert.equal(month.baselineAt, '2026-07-02T20:00:00.000Z');

  const leapPoints = [
    historyPoint('2023-02-27', 80),
    historyPoint('2023-02-28', 100),
    historyPoint('2024-02-29', 125)
  ];
  const year = calculatePeriodPerformance(leapPoints, '1y');
  assert.equal(year.baselineAt, '2023-02-28T20:00:00.000Z');
  assert.equal(year.valuePct, 25);
});

test('theme history prefers adjusted closes and excludes the open-session daily bar', () => {
  const timestamps = [
    Date.parse('2026-07-09T13:30:00Z') / 1000,
    Date.parse('2026-07-10T13:30:00Z') / 1000
  ];
  const chartWithSplit = {
    meta: { currency: 'USD', currentTradingPeriod: {} },
    timestamp: timestamps,
    indicators: {
      quote: [{ close: [100, 50] }],
      adjclose: [{ adjclose: [50, 50] }]
    }
  };
  const normalized = normalizeHistoryPoints(chartWithSplit);
  assert.deepEqual(normalized.map(point => point.close), [50, 50]);
  assert.equal(calculatePeriodPerformance(normalized, '1d').valuePct, 0);

  const openChart = {
    ...chartWithSplit,
    meta: {
      currency: 'USD',
      regularMarketTime: timestamps[1],
      currentTradingPeriod: {
        regular: {
          start: Date.parse('2026-07-10T13:30:00Z') / 1000,
          end: Date.parse('2026-07-10T20:00:00Z') / 1000
        }
      }
    }
  };
  const payload = { spark: { result: [{ symbol: 'AAPL', response: [openChart] }] } };
  const parsed = parseYahooThemeHistory(payload, Date.parse('2026-07-10T16:00:00Z'));
  assert.equal(parsed.get('AAPL').points.length, 1);
  assert.equal(parsed.get('AAPL').excludedOpenSession, true);

  const earlyCloseTimestamp = Date.parse('2026-11-27T14:30:00Z') / 1000;
  const earlyClosePayload = {
    spark: { result: [{
      symbol: 'AAPL',
      response: [{
        meta: {
          currency: 'USD',
          regularMarketTime: Date.parse('2026-11-27T18:00:00Z') / 1000,
          currentTradingPeriod: {
            regular: {
              start: earlyCloseTimestamp,
              end: Date.parse('2026-11-27T18:00:00Z') / 1000
            }
          }
        },
        timestamp: [earlyCloseTimestamp],
        indicators: {
          quote: [{ close: [110] }],
          adjclose: [{ adjclose: [110] }]
        }
      }]
    }] }
  };
  const afterEarlyClose = parseYahooThemeHistory(
    earlyClosePayload,
    Date.parse('2026-11-27T19:00:00Z')
  );
  assert.equal(afterEarlyClose.get('AAPL').points.length, 1);
  assert.equal(afterEarlyClose.get('AAPL').excludedOpenSession, false);
});

test('theme universe uses bounded 20-symbol batches, caches, and exposes partial failures', async () => {
  let calls = 0;
  const timestamps = [
    Date.parse('2025-07-01T13:30:00Z') / 1000,
    Date.parse('2026-06-30T13:30:00Z') / 1000,
    Date.parse('2026-07-01T13:30:00Z') / 1000
  ];
  const omitted = THEME_CATALOG[0].members[0].symbol;
  const rows = THEME_CATALOG.flatMap(entry => entry.members)
    .filter(member => member.symbol !== omitted)
    .map(member => ({
      symbol: member.symbol,
      response: [{
        meta: { currency: 'USD', currentTradingPeriod: {} },
        timestamp: timestamps,
        indicators: {
          quote: [{ close: [80, 99, 100] }],
          adjclose: [{ adjclose: [80, 99, 100] }]
        }
      }]
    }));
  const service = new MarketDataService({
    fetch: async url => {
      calls += 1;
      assert.match(url, /range=2y/);
      return new Response(JSON.stringify({ spark: { result: rows } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    },
    sleep: async () => {},
    themeTtlMs: 60_000
  });

  const first = await service.getThemes();
  const second = await service.getThemes();
  assert.equal(calls, 4);
  assert.equal(first.themes.length, THEME_CATALOG.length);
  assert.equal(first.status, 'partial');
  assert.ok(first.errors.includes(omitted));
  assert.equal(first.themes[0].leaders.find(leader => leader.symbol === omitted).status, 'unavailable');
  assert.equal(second.meta.cache, 'hit');
  assert.equal(first.meta.method, 'equal-weight arithmetic mean of available constituents');
  assert.match(first.meta.pricePolicy.performance, /adjusted close preferred/);
});

test('theme refresh failure preserves and explicitly labels stale cached data', async () => {
  let now = Date.parse('2026-07-12T00:00:00Z');
  let fail = false;
  const timestamps = [
    Date.parse('2025-07-10T13:30:00Z') / 1000,
    Date.parse('2026-07-09T13:30:00Z') / 1000,
    Date.parse('2026-07-10T13:30:00Z') / 1000
  ];
  const service = new MarketDataService({
    now: () => now,
    themeTtlMs: 1_000,
    themePartialTtlMs: 1_000,
    themeStaleMs: 60_000,
    sleep: async () => {},
    fetch: async url => {
      if (fail) return new Response('down', { status: 503 });
      const symbols = new URL(url).searchParams.get('symbols').split(',');
      const result = symbols.map(symbol => ({
        symbol,
        response: [{
          meta: { currency: 'USD', currentTradingPeriod: {} },
          timestamp: timestamps,
          indicators: {
            quote: [{ close: [80, 99, 100] }],
            adjclose: [{ adjclose: [80, 99, 100] }]
          }
        }]
      }));
      return new Response(JSON.stringify({ spark: { result } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });

  const initial = await service.getThemes();
  assert.equal(initial.meta.cache, 'refreshed');
  now += 2_000;
  fail = true;
  const fallback = await service.getThemes();
  assert.equal(fallback.meta.cache, 'stale-fallback');
  assert.equal(fallback.meta.stale, true);
  assert.equal(fallback.status, 'partial');
  assert.equal(fallback.meta.quality.grade, 'stale');
  assert.ok(fallback.themes[0].leaders[0].price > 0);
});

function rrgFixture({ sessions = 110, themeDailyLog = 0.012, spyDailyLog = 0.001, priceMode = 'raw' } = {}) {
  const dates = [];
  const cursor = new Date('2025-01-02T21:00:00Z');
  while (dates.length < sessions) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const symbols = [...new Set(['SPY', ...INTELLIGENCE_THEME_CATALOG.flatMap(theme => theme.relatedTickers)])];
  const histories = new Map(symbols.map(symbol => {
    const rate = symbol === 'SPY' ? spyDailyLog : themeDailyLog;
    const points = dates.map((date, index) => {
      const close = 100 * Math.exp(rate * index);
      return { timestamp: Date.parse(`${date}T21:00:00Z`) / 1000, at: `${date}T21:00:00.000Z`, sessionDate: date, close, rawClose: close, priceMode };
    });
    return [symbol, { points, currency: 'USD', exchange: 'TEST', priceMode, excludedOpenSession: false }];
  }));
  return { dates, histories };
}

test('RRG-style coordinates use exact SPY sessions, untrimmed log returns and fixed quadrant boundaries', () => {
  const { dates, histories } = rrgFixture();
  const rrg = buildRrgData(histories, dates);
  const gpu = rrg.byTheme.get('gpu');
  assert.equal(rrg.dates.length, RRG_TRAIL_POINTS);
  assert.equal(gpu.trail.length, RRG_TRAIL_POINTS);
  assert.equal(gpu.longPeriodSessions, RRG_LONG_SESSIONS);
  assert.equal(gpu.shortPeriodSessions, RRG_SHORT_SESSIONS);
  assert.ok(Math.abs(gpu.longRelativePct - 69.3) < 1e-8);
  assert.ok(Math.abs(gpu.shortRelativePct - 5.5) < 1e-8);
  assert.ok(gpu.longRelativePct > 50, 'RRG values must not inherit the score model ±50% clipping');
  assert.equal(gpu.quadrant, 'leader');
  assert.equal(gpu.priceMode, 'raw-close-fallback');
  assert.equal(gpu.dividendAdjusted, false);
  assert.match(gpu.qualityWarning, /dividends are excluded/);
  assert.deepEqual([
    rrgQuadrant(1, 1),
    rrgQuadrant(1, -1),
    rrgQuadrant(-1, 1),
    rrgQuadrant(-1, -1),
    rrgQuadrant(0, 0)
  ], ['leader', 'weakening', 'rebound', 'lagging', 'leader']);
});

test('RRG trails share SPY dates, never fill missing endpoints and do not look ahead', () => {
  const { dates, histories } = rrgFixture({ themeDailyLog: 0.004 });
  const before = buildRrgData(histories, dates).byTheme.get('gpu');
  const currentDate = dates.at(-1);
  histories.get('NVDA').points = histories.get('NVDA').points.filter(point => point.sessionDate !== currentDate);
  const missing = buildRrgData(histories, dates).byTheme.get('gpu');
  assert.equal(missing.trail.at(-1).status, 'unavailable');
  assert.equal(missing.trail.at(-1).longRelativePct, null);
  assert.equal(missing.trail.at(-1).coveragePct, 75);
  assert.deepEqual(missing.trail.map(point => point.date), dates.slice(-RRG_TRAIL_POINTS));

  const futureChanged = rrgFixture({ themeDailyLog: 0.004 });
  futureChanged.histories.get('NVDA').points.at(-1).close *= 9;
  futureChanged.histories.get('NVDA').points.at(-1).rawClose *= 9;
  const after = buildRrgData(futureChanged.histories, futureChanged.dates).byTheme.get('gpu');
  assert.deepEqual(after.trail.slice(0, -1), before.trail.slice(0, -1));
  assert.notEqual(after.trail.at(-1).longRelativePct, before.trail.at(-1).longRelativePct);
});

test('RRG contract labels raw-close limits and fingerprints historical trail revisions', () => {
  const firstFixture = rrgFixture({ sessions: 300, themeDailyLog: 0.002 });
  const retrievedAt = `${firstFixture.dates.at(-1)}T23:00:00.000Z`;
  const first = applyValidatedEdgeAssociations(buildIntelligencePayload(firstFixture.histories, retrievedAt));
  assert.equal(first.rrg.status, 'ok');
  assert.equal(first.rrg.priceMode, 'raw-close-fallback');
  assert.equal(first.rrg.dividendAdjusted, false);
  assert.equal(first.rrg.dates.length, 21);
  assert.equal(first.rrg.methodology.officialRrg, false);
  assert.equal(first.rrg.methodology.lookahead, false);
  assert.equal(first.rrg.methodology.actualFundFlow, false);
  assert.ok(first.themes.every(theme => theme.rrg.trail.length === 21));
  assert.ok(first.observedEvidence.some(evidence => evidence.metric === 'rrgLongRelativePct' && evidence.source === 'yahoo-spark-raw-close'));

  const secondFixture = rrgFixture({ sessions: 300, themeDailyLog: 0.002 });
  secondFixture.histories.get('NVDA').points.at(-10).close *= 1.07;
  secondFixture.histories.get('NVDA').points.at(-10).rawClose *= 1.07;
  const second = applyValidatedEdgeAssociations(buildIntelligencePayload(secondFixture.histories, retrievedAt));
  assert.notEqual(second.dataRevision, first.dataRevision);
});

test('market-observation age is independent from transport cache age and fail-closes decisions', () => {
  const fixture = rrgFixture({ sessions: 300, priceMode: 'adjusted' });
  const payload = applyValidatedEdgeAssociations(buildIntelligencePayload(
    fixture.histories,
    '2026-07-19T00:00:00.000Z'
  ));

  assert.equal(payload.status, 'partial');
  assert.equal(payload.partial, true);
  assert.equal(payload.meta.stale, false, 'transport cache is freshly built');
  assert.equal(payload.meta.observationStale, true);
  assert.equal(payload.meta.marketObservation.status, 'stale');
  assert.equal(payload.meta.marketObservation.transportCacheIndependent, true);
  assert.equal(payload.meta.quality.grade, 'stale');
  assert.deepEqual(payload.nextCandidates, []);
  assert.ok(payload.themes.every(theme => theme.eligible === false));
  assert.ok(payload.themes.every(theme => ['watch', 'avoid'].includes(theme.entry)));
  assert.ok(payload.edges.every(edge => edge.eligible === false));
});

test('score features require exact SPY 1/5/20-session endpoints', () => {
  const fixture = rrgFixture({ sessions: 300, priceMode: 'adjusted' });
  const missingDate = fixture.dates.at(-1 - RRG_SHORT_SESSIONS);
  fixture.histories.get('NVDA').points = fixture.histories.get('NVDA').points
    .filter(point => point.sessionDate !== missingDate);
  const payload = applyValidatedEdgeAssociations(buildIntelligencePayload(
    fixture.histories,
    `${fixture.dates.at(-1)}T23:00:00.000Z`
  ));
  const gpu = payload.themes.find(theme => theme.id === 'gpu');

  assert.equal(payload.status, 'partial');
  assert.equal(gpu.coverage.pct, 75);
  assert.equal(gpu.score, null);
  assert.equal(gpu.eligible, false);
  assert.equal(gpu.rrg.trail.at(-1).coveragePct, 75);
  assert.equal(gpu.rrg.trail.at(-1).status, 'unavailable');
});

test('a later close can change only its own score frame and never rewrites earlier frames', () => {
  const beforeFixture = rrgFixture({ sessions: 300, priceMode: 'adjusted', themeDailyLog: 0.002 });
  const retrievedAt = `${beforeFixture.dates.at(-1)}T23:00:00.000Z`;
  const before = applyValidatedEdgeAssociations(buildIntelligencePayload(beforeFixture.histories, retrievedAt));
  const afterFixture = rrgFixture({ sessions: 300, priceMode: 'adjusted', themeDailyLog: 0.002 });
  afterFixture.histories.get('NVDA').points.at(-1).close *= 3;
  const after = applyValidatedEdgeAssociations(buildIntelligencePayload(afterFixture.histories, retrievedAt));

  for (const theme of before.themes) {
    const changed = after.themes.find(candidate => candidate.id === theme.id);
    assert.deepEqual(changed.history.slice(0, -1), theme.history.slice(0, -1));
  }
  assert.notDeepEqual(
    after.themes.find(theme => theme.id === 'gpu').history.at(-1),
    before.themes.find(theme => theme.id === 'gpu').history.at(-1)
  );
});

test('global status aggregates a partial RRG component even when current scores are complete', () => {
  const fixture = rrgFixture({ sessions: 300, priceMode: 'adjusted' });
  const historicalGap = fixture.dates.at(-10);
  fixture.histories.get('NVDA').points = fixture.histories.get('NVDA').points
    .filter(point => point.sessionDate !== historicalGap);
  const payload = applyValidatedEdgeAssociations(buildIntelligencePayload(
    fixture.histories,
    `${fixture.dates.at(-1)}T23:00:00.000Z`
  ));
  const gpu = payload.themes.find(theme => theme.id === 'gpu');

  assert.ok(Number.isFinite(gpu.score));
  assert.equal(payload.rrg.status, 'partial');
  assert.equal(payload.status, 'partial');
  assert.equal(payload.partial, true);
  assert.deepEqual(payload.nextCandidates, []);
});

test('raw and mixed close histories remain reference-only and cannot create decisions', () => {
  const rawFixture = rrgFixture({ sessions: 300, priceMode: 'raw' });
  const rawPayload = applyValidatedEdgeAssociations(buildIntelligencePayload(
    rawFixture.histories,
    `${rawFixture.dates.at(-1)}T23:00:00.000Z`
  ));
  const rawGpu = rawPayload.themes.find(theme => theme.id === 'gpu');
  assert.equal(rawPayload.status, 'partial');
  assert.equal(rawPayload.availability.price.decisionEligible, false);
  assert.equal(rawGpu.scorePriceMode, 'raw-close-fallback');
  assert.equal(rawGpu.decisionPriceEligible, false);
  assert.equal(rawGpu.eligible, false);
  assert.equal(rawGpu.entry, 'watch');
  assert.deepEqual(rawPayload.nextCandidates, []);
  assert.ok(rawPayload.edges.every(edge => edge.eligible === false));
  assert.equal(rawPayload.rrg.benchmarkPriceMode, 'raw-close-fallback');

  const mixedFixture = rrgFixture({ sessions: 300, priceMode: 'adjusted' });
  const nvda = mixedFixture.histories.get('NVDA');
  nvda.priceMode = 'mixed';
  nvda.points.at(-30).priceMode = 'raw';
  const mixedPayload = applyValidatedEdgeAssociations(buildIntelligencePayload(
    mixedFixture.histories,
    `${mixedFixture.dates.at(-1)}T23:00:00.000Z`
  ));
  const mixedGpu = mixedPayload.themes.find(theme => theme.id === 'gpu');
  assert.equal(mixedGpu.scorePriceMode, 'raw-close-fallback');
  assert.equal(mixedGpu.decisionPriceEligible, false);
  assert.equal(mixedGpu.eligible, false);
});

test('data revision fingerprints full history and final edge results before evidence IDs are assigned', () => {
  const firstFixture = rrgFixture({ sessions: 300, priceMode: 'adjusted', themeDailyLog: 0.002 });
  const retrievedAt = `${firstFixture.dates.at(-1)}T23:00:00.000Z`;
  const first = applyValidatedEdgeAssociations(buildIntelligencePayload(firstFixture.histories, retrievedAt));
  const sameObservationLater = applyValidatedEdgeAssociations(buildIntelligencePayload(
    rrgFixture({ sessions: 300, priceMode: 'adjusted', themeDailyLog: 0.002 }).histories,
    `${firstFixture.dates.at(-1)}T23:30:00.000Z`
  ));
  const secondFixture = rrgFixture({ sessions: 300, priceMode: 'adjusted', themeDailyLog: 0.002 });
  secondFixture.histories.get('NVDA').points.at(-30).close *= 1.25;
  const second = applyValidatedEdgeAssociations(buildIntelligencePayload(secondFixture.histories, retrievedAt));
  const firstGpu = first.themes.find(theme => theme.id === 'gpu');
  const secondGpu = second.themes.find(theme => theme.id === 'gpu');

  assert.notDeepEqual(firstGpu.history, secondGpu.history);
  assert.equal(first.dataRevision, sameObservationLater.dataRevision);
  assert.notEqual(first.dataRevision, second.dataRevision);
  assert.match(first.dataRevision, /^theme-intelligence-v3:/);
  assert.equal(first.meta.evidenceRevision, first.dataRevision);
  assert.ok(first.edges.every(edge => edge.revision === first.dataRevision));
  assert.ok(first.observedEvidence.every(evidence => evidence.revision === first.dataRevision));
});

test('lag association train and validation windows are chronological and disjoint', () => {
  const tooShort = Array.from({ length: 159 }, (_, index) => [index, index]);
  assert.equal(chronologicalAssociationWindows(tooShort), null);
  const pairs = Array.from({ length: 160 }, (_, index) => [index, index]);
  const windows = chronologicalAssociationWindows(pairs);
  assert.equal(windows.train.length, 100);
  assert.equal(windows.validation.length, 60);
  assert.equal(windows.train.at(-1)[0], 99);
  assert.equal(windows.validation[0][0], 100);
});

function intelligenceHistories() {
  const symbols = [...new Set([
    'SPY',
    ...INTELLIGENCE_THEME_CATALOG.flatMap(entry => [
      ...entry.relatedTickers,
      ...entry.etfs,
      ...entry.relatedInstruments.map(instrument => instrument.symbol)
    ])
  ])];
  const start = Date.parse('2025-01-01T21:00:00Z');
  return new Map(symbols.map((symbol, symbolIndex) => {
    const phase = (symbolIndex % 31) / 7;
    const drift = 0.00015 + (symbolIndex % 9) * 0.000035;
    const points = Array.from({ length: 420 }, (_, index) => {
      const timestamp = (start + index * 24 * 60 * 60 * 1000) / 1000;
      const close = (30 + symbolIndex / 3) * Math.exp(drift * index + 0.025 * Math.sin(index / 13 + phase));
      return {
        timestamp,
        at: new Date(timestamp * 1000).toISOString(),
        sessionDate: new Date(timestamp * 1000).toISOString().slice(0, 10),
        close,
        rawClose: close,
        priceMode: 'adjusted',
        volume: 1_000_000 + index
      };
    });
    return [symbol, {
      points,
      currency: 'USD',
      exchange: 'TEST',
      priceMode: 'adjusted',
      excludedOpenSession: false,
      volumeAvailable: true
    }];
  }));
}

function freshRetrievedAt(histories, offsetMs = 60 * 60 * 1000) {
  const latest = histories.get('SPY').points.at(-1);
  return new Date(Date.parse(latest.at) + offsetMs).toISOString();
}

test('theme intelligence publishes exactly 50 fixed themes without claiming actual capital flow', () => {
  const histories = intelligenceHistories();
  const payload = applyValidatedEdgeAssociations(buildIntelligencePayload(histories, freshRetrievedAt(histories)));
  assert.equal(INTELLIGENCE_THEME_CATALOG.length, 50);
  assert.deepEqual(
    INTELLIGENCE_CATEGORIES.map(category => INTELLIGENCE_THEME_CATALOG.filter(theme => theme.categoryId === category.id).length),
    [8, 8, 6, 6, 8, 5, 5, 4]
  );
  assert.equal(payload.themes.length, 50);
  assert.equal(payload.categories.length, 8);
  assert.equal(payload.summary.market.themeIds.length, 50);
  assert.equal(payload.edges.length, INTELLIGENCE_STRUCTURAL_EDGES.length);
  assert.equal(payload.actualFundFlow, false);
  assert.equal(payload.flowProxy, null);
  assert.equal(payload.methodology.volumeUsed, false);
  assert.equal(payload.availability.volume.available, false);
  assert.equal(payload.availability.actualFundFlow.available, false);
  assert.equal(payload.availability.newsScore.value, null);
  assert.equal(payload.availability.newsScore.newsCount, 0);
  assert.equal(Object.hasOwn(payload, '_internal'), false);

  const allowedTrends = new Set(['up', 'flat', 'down']);
  const allowedEntries = new Set(['buy', 'pullback_only', 'watch', 'avoid']);
  for (const theme of payload.themes) {
    assert.ok(allowedTrends.has(theme.trend));
    assert.ok(allowedEntries.has(theme.entry));
    assert.equal(theme.marketCapWeight, null);
    assert.equal(theme.newsScore, null);
    assert.equal(theme.newsCount, 0);
    assert.equal(theme.history.length, 30);
    assert.equal(theme.constituents.length, 4);
    for (const constituent of theme.constituents) {
      assert.deepEqual(Object.keys(constituent.performance), ['1d', '5d', '1m', '1y']);
      assert.ok(Object.values(constituent.performance).every(Number.isFinite));
    }
  }

  const evidenceIds = new Set(payload.observedEvidence.map(evidence => evidence.id));
  assert.ok(payload.observedEvidence.every(evidence => evidence.revision === payload.dataRevision));
  assert.ok(payload.nextCandidates.every(candidate => candidate.evidenceIds.every(id => evidenceIds.has(id))));
  assert.ok(payload.edges.every(edge => edge.catalogRelation === true && edge.predictive === false));
});

test('theme intelligence cache strips internals and disables decision outputs on stale fallback', async () => {
  const histories = intelligenceHistories();
  let now = Date.parse(freshRetrievedAt(histories));
  let fail = false;
  const service = new MarketDataService({
    fetch: async () => { throw new Error('fetch should be replaced'); },
    now: () => now,
    intelligenceTtlMs: 1_000,
    intelligencePartialTtlMs: 1_000,
    intelligenceStaleMs: 60_000
  });
  service._yahooThemeHistory = async () => {
    if (fail) throw new Error('upstream down');
    return histories;
  };

  const first = await service.getThemeIntelligence();
  const hit = await service.getThemeIntelligence();
  assert.equal(first.meta.cache, 'refreshed');
  assert.equal(hit.meta.cache, 'hit');
  assert.equal(Object.hasOwn(first, '_internal'), false);

  now += 2_000;
  fail = true;
  const stale = await service.getThemeIntelligence();
  assert.equal(stale.meta.cache, 'stale-fallback');
  assert.equal(stale.meta.stale, true);
  assert.equal(stale.status, 'partial');
  assert.equal(stale.meta.quality.grade, 'stale');
  assert.deepEqual(stale.nextCandidates, []);
  assert.ok(stale.themes.every(theme => theme.eligible === false));
  assert.ok(stale.themes.every(theme => ['watch', 'avoid'].includes(theme.entry)));
  assert.notEqual(stale.dataRevision, first.dataRevision);
  assert.equal(stale.meta.evidenceRevision, stale.dataRevision);
  assert.ok(stale.observedEvidence.every(evidence => evidence.revision === stale.dataRevision));
  assert.ok(stale.edges.every(edge => edge.revision === stale.dataRevision));
  assert.equal(Object.hasOwn(stale, '_internal'), false);
});

test('a benchmark-only refresh failure cannot overwrite the last usable intelligence cache', async () => {
  const histories = intelligenceHistories();
  let now = Date.parse(freshRetrievedAt(histories));
  let omitBenchmark = false;
  const service = new MarketDataService({
    fetch: async () => { throw new Error('fetch should be replaced'); },
    now: () => now,
    intelligenceTtlMs: 1_000,
    intelligencePartialTtlMs: 1_000,
    intelligenceStaleMs: 60_000
  });
  service._yahooThemeHistory = async () => omitBenchmark
    ? new Map([...histories].filter(([symbol]) => symbol !== 'SPY'))
    : histories;

  const first = await service.getThemeIntelligence();
  assert.notEqual(first.status, 'unavailable');
  now += 2_000;
  omitBenchmark = true;
  const fallback = await service.getThemeIntelligence();
  assert.equal(fallback.meta.cache, 'stale-fallback');
  assert.equal(fallback.meta.stale, true);
  assert.notEqual(fallback.status, 'unavailable');
  assert.deepEqual(fallback.nextCandidates, []);
});

test('reference-only raw pricing does not force a two-minute full-universe refresh loop', async () => {
  const histories = intelligenceHistories();
  for (const history of histories.values()) {
    history.priceMode = 'raw';
    for (const point of history.points) point.priceMode = 'raw';
  }
  let now = Date.parse(freshRetrievedAt(histories));
  let calls = 0;
  const service = new MarketDataService({
    fetch: async () => { throw new Error('fetch should be replaced'); },
    now: () => now,
    intelligenceTtlMs: 60_000,
    intelligencePartialTtlMs: 1_000
  });
  service._yahooThemeHistory = async () => {
    calls += 1;
    return histories;
  };

  const first = await service.getThemeIntelligence();
  assert.equal(first.status, 'partial');
  assert.equal(first.availability.price.decisionEligible, false);
  now += 2_000;
  const hit = await service.getThemeIntelligence();
  assert.equal(hit.meta.cache, 'hit');
  assert.equal(calls, 1);
});

function marketRegimeFixture(options = {}) {
  const sessions = options.sessions || 30;
  const dates = [];
  const cursor = new Date('2026-06-01T21:00:00.000Z');
  while (dates.length < sessions) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const modes = options.modes || {};
  const builders = {
    '^VIX': options.vix || (index => 15 + index * 0.01),
    'CL=F': options.wti || (index => 70 + index * 0.05),
    SPY: options.spy || (index => 500 + index)
  };
  const histories = new Map(Object.entries(builders).map(([symbol, builder]) => {
    const mode = modes[symbol] || 'adjusted';
    const points = dates.map((date, index) => {
      const value = builder(index);
      return {
        timestamp: Date.parse(`${date}T21:00:00.000Z`) / 1000,
        at: `${date}T21:00:00.000Z`,
        sessionDate: date,
        close: value,
        rawClose: value,
        priceMode: mode === 'adjusted' ? 'adjusted' : 'raw',
        volume: 1_000_000
      };
    });
    return [symbol, {
      points,
      currency: 'USD',
      exchange: 'TEST',
      priceMode: mode,
      excludedOpenSession: false,
      volumeAvailable: true
    }];
  }));
  return {
    dates,
    histories,
    retrievedAt: `${dates.at(-1)}T23:00:00.000Z`
  };
}

function spyAdjustedChartPayload(history) {
  return {
    chart: {
      result: [{
        meta: {
          symbol: 'SPY',
          currency: 'USD',
          fullExchangeName: 'NYSEArca',
          regularMarketTime: history.points.at(-1).timestamp,
          currentTradingPeriod: {}
        },
        timestamp: history.points.map(point => point.timestamp),
        indicators: {
          quote: [{
            close: history.points.map(point => point.rawClose),
            volume: history.points.map(() => 50_000_000)
          }],
          adjclose: [{
            adjclose: history.points.map(point => point.close)
          }]
        }
      }],
      error: null
    }
  };
}

test('Yahoo Chart v8 parser produces adjusted SPY history with explicit provenance', () => {
  const fixture = marketRegimeFixture({ modes: { SPY: 'raw' } });
  const history = parseYahooChartHistory(
    spyAdjustedChartPayload(fixture.histories.get('SPY')),
    'SPY',
    Date.parse(fixture.retrievedAt)
  );
  assert.equal(history.priceMode, 'adjusted');
  assert.equal(history.source, 'yahoo-chart-v8-adjusted');
  assert.equal(history.points.length, fixture.dates.length);
  assert.ok(history.points.every(point => point.priceMode === 'adjusted'));

  const openPayload = spyAdjustedChartPayload(fixture.histories.get('SPY'));
  const openChart = openPayload.chart.result[0];
  const lastTimestamp = openChart.timestamp.at(-1);
  openChart.meta.regularMarketTime = lastTimestamp;
  openChart.meta.currentTradingPeriod = {
    regular: {
      start: lastTimestamp - 6 * 60 * 60,
      end: lastTimestamp + 60 * 60
    }
  };
  const openHistory = parseYahooChartHistory(
    openPayload,
    'SPY',
    (lastTimestamp + 30 * 60) * 1000
  );
  assert.equal(openHistory.points.length, fixture.dates.length - 1);
  assert.equal(openHistory.excludedOpenSession, true);
});

test('market regime prefers cached adjusted SPY Chart history and keeps trading disconnected', async () => {
  const fixture = marketRegimeFixture({
    modes: { '^VIX': 'raw', 'CL=F': 'raw', SPY: 'raw' }
  });
  let now = Date.parse(fixture.retrievedAt);
  let chartCalls = 0;
  const service = new MarketDataService({
    fetch: async url => {
      chartCalls += 1;
      assert.match(String(url), /\/v8\/finance\/chart\/SPY/);
      assert.match(String(url), /includeAdjustedClose=true/);
      return new Response(JSON.stringify(spyAdjustedChartPayload(fixture.histories.get('SPY'))), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    },
    now: () => now,
    ttlMs: 1,
    marketRegimeTtlMs: 1_000,
    marketRegimeSpyAdjustedTtlMs: 60_000
  });
  service._yahooThemeHistory = async () => fixture.histories;

  const first = await service.getMarketRegime();
  assert.equal(first.status, 'ok');
  assert.equal(first.regime.assessmentStatus, 'confirmed');
  assert.equal(first.regime.confidence, 85);
  assert.equal(first.referenceOnly, false);
  assert.equal(first.tradeEligible, false);
  assert.equal(first.regime.tradeEligible, false);
  assert.equal(first.instruments.spy.priceMode, 'adjusted-close');
  assert.equal(first.instruments.spy.source, 'yahoo-chart-v8-adjusted');
  assert.equal(first.meta.source.id, 'yahoo-spark+chart-v8-adjusted');
  assert.equal(first.meta.source.adjustedSpyUsed, true);
  assert.equal(chartCalls, 1);

  now += 2_000;
  const second = await service.getMarketRegime();
  assert.equal(second.meta.cache, 'refreshed');
  assert.equal(second.instruments.spy.source, 'yahoo-chart-v8-adjusted');
  assert.equal(chartCalls, 1, 'adjusted SPY history is fetched at most once inside its TTL');

  now += 2;
  const forced = await service.getMarketRegime({ forceRefresh: true });
  assert.equal(forced.meta.cache, 'refreshed');
  assert.equal(forced.meta.refreshRequested, true);
  assert.equal(forced.meta.refreshSuppressed, false);
  assert.equal(forced.instruments.spy.source, 'yahoo-chart-v8-adjusted');
  assert.equal(chartCalls, 2, 'explicit refresh revalidates adjusted SPY alongside VIX and WTI');
});

test('forced refresh reuses only a same-session adjusted SPY cache when Chart v8 briefly fails', async () => {
  const baseline = marketRegimeFixture({
    vix: () => 15,
    modes: { '^VIX': 'raw', 'CL=F': 'raw', SPY: 'raw' }
  });
  const stressed = marketRegimeFixture({
    vix: () => 40,
    modes: { '^VIX': 'raw', 'CL=F': 'raw', SPY: 'raw' }
  });
  let now = Date.parse(baseline.retrievedAt);
  let useStress = false;
  let chartCalls = 0;
  const service = new MarketDataService({
    fetch: async () => {
      chartCalls += 1;
      if (chartCalls > 1) return new Response('temporary failure', { status: 503 });
      return new Response(JSON.stringify(spyAdjustedChartPayload(baseline.histories.get('SPY'))), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    },
    now: () => now,
    ttlMs: 1,
    marketRegimeTtlMs: 60_000,
    marketRegimeSpyAdjustedTtlMs: 60_000
  });
  service._yahooThemeHistory = async () => useStress ? stressed.histories : baseline.histories;

  const first = await service.getMarketRegime();
  const originalCacheSavedAt = service.marketRegimeCache.savedAt;
  assert.equal(first.status, 'ok');
  assert.equal(first.instruments.spy.source, 'yahoo-chart-v8-adjusted');
  assert.equal(first.meta.source.adjustedSpyRefreshFallback, false);

  now += 2_000;
  useStress = true;
  const forced = await service.getMarketRegime({ forceRefresh: true });
  assert.equal(chartCalls, 2);
  assert.equal(forced.status, 'ok');
  assert.equal(forced.instruments.spy.source, 'yahoo-chart-v8-adjusted');
  assert.equal(forced.meta.source.adjustedSpyRefreshFallback, true);
  assert.equal(forced.meta.source.adjustedSpyRefreshFallbackAgeMs, 2_000);
  assert.equal(forced.meta.quality.fresh, 2);
  assert.equal(forced.meta.quality.closeValid, 3);
  assert.equal(forced.meta.quality.delayed, 1);
  assert.match(forced.warnings.join(' '), /同一営業日の正常キャッシュ/);
  assert.equal(forced.instruments.vix.value, 40, 'new VIX stress is not hidden by the SPY fallback');
  assert.equal(forced.regime.state, 'danger');
  assert.notEqual(forced.dataRevision, first.dataRevision);
  assert.equal(
    service.marketRegimeCache.savedAt,
    originalCacheSavedAt,
    'fallback does not extend the underlying adjusted-SPY cache lifetime'
  );

  const mismatch = await service._getMarketRegimeSpyAdjustedHistory(
    { deadlineAt: Date.now() + 1_000, signal: null },
    { forceRefresh: true, requiredSessionDate: '2099-01-01' }
  );
  assert.equal(mismatch, null, 'an adjusted series from an older session is never mixed into a newer refresh');
  const unknownSession = await service._getMarketRegimeSpyAdjustedHistory(
    { deadlineAt: Date.now() + 1_000, signal: null },
    { forceRefresh: true }
  );
  assert.equal(unknownSession, null, 'fallback is not used when the refreshed SPY session is unknown');
});

test('SPY Chart failure safely falls back to Spark raw and negative-caches the failure', async () => {
  const fixture = marketRegimeFixture({
    modes: { '^VIX': 'raw', 'CL=F': 'raw', SPY: 'raw' }
  });
  let now = Date.parse(fixture.retrievedAt);
  let chartCalls = 0;
  const service = new MarketDataService({
    fetch: async () => {
      chartCalls += 1;
      return new Response('upstream unavailable', { status: 503 });
    },
    now: () => now,
    marketRegimeTtlMs: 1_000,
    marketRegimeSpyAdjustedTtlMs: 60_000
  });
  service._yahooThemeHistory = async () => fixture.histories;

  const first = await service.getMarketRegime();
  assert.equal(first.status, 'partial');
  assert.equal(first.regime.assessmentStatus, 'reference_only');
  assert.equal(first.referenceOnly, true);
  assert.equal(first.instruments.spy.priceMode, 'raw-close-reference');
  assert.equal(first.instruments.spy.source, 'yahoo-spark');
  assert.equal(first.meta.source.adjustedSpyUsed, false);
  assert.equal(first.regime.confidence, 65);
  assert.equal(chartCalls, 1);

  now += 2_000;
  const second = await service.getMarketRegime();
  assert.equal(second.status, 'partial');
  assert.equal(second.instruments.spy.source, 'yahoo-spark');
  assert.equal(chartCalls, 1, 'null adjusted-history result is cached to prevent retry loops');
});

test('market regime synchronizes VIX, WTI and SPY to exact confirmed SPY sessions', () => {
  const fixture = marketRegimeFixture();
  const payload = buildMarketRegimePayload(fixture.histories, fixture.retrievedAt);
  const end = fixture.histories.get('SPY').points.at(-1).close;
  const baseline5 = fixture.histories.get('SPY').points.at(-6).close;

  assert.equal(payload.status, 'ok');
  assert.equal(payload.asOf, fixture.dates.at(-1));
  assert.equal(payload.availability.synchronizedConfirmedSession.lagSessions, 0);
  assert.equal(payload.indicators.spy.baselines['5d'].date, fixture.dates.at(-6));
  assert.equal(payload.indicators.spy.changesPct['5d'], +(((end / baseline5) - 1) * 100).toFixed(3));
  assert.equal(payload.regime.assessmentStatus, 'confirmed');
  assert.equal(payload.regime.labelJa, payload.regime.label);
  assert.deepEqual(payload.regime.reasons, payload.regime.rationale);
  assert.equal(payload.regime.tradeEligible, false);
  assert.equal(payload.instruments.vix.symbol, '^VIX');
  assert.equal(payload.instruments.vix.value, payload.indicators.vix.level);
  assert.equal(payload.instruments.vix.changes['5d'], payload.indicators.vix.changesPct['5d']);
  assert.equal(payload.instruments.vix.trail.length, 21);
  assert.ok(payload.instruments.vix.trail.every(point => typeof point.date === 'string'));
  assert.equal(payload.instruments.vix.priceMode, 'native-index-close');
  assert.equal(payload.instruments.vix.adjusted, false);
  assert.equal(payload.instruments.wti.priceMode, 'native-futures-close');
  assert.equal(payload.instruments.wti.adjusted, false);
  assert.equal(payload.instruments.wti.continuousContract, true);
  assert.equal(payload.instruments.wti.rollAdjusted, false);
  assert.equal(payload.meta.source.id, 'yahoo-spark');
  assert.equal(payload.meta.source.official, false);
  assert.equal(payload.meta.source.adjustedSpyUsed, false);
  assert.ok(payload.regime.confidence <= 85);
  assert.equal(payload.actualFundFlow, false);
  assert.equal(payload.tradingSignal, null);
  assert.equal(payload.methodology.synchronization.includes('no fill'), true);
});

test('confirmed neutral market regime payload never exposes empty reasons', () => {
  const fixture = marketRegimeFixture({
    sessions: 35,
    vix: index => 18 + index * 0.002,
    wti: index => 75 + index * 0.03,
    spy: index => 530 + index * 0.08
  });
  const payload = buildMarketRegimePayload(fixture.histories, fixture.retrievedAt);

  assert.equal(payload.status, 'ok');
  assert.equal(payload.regime.state, 'neutral');
  assert.equal(payload.regime.score, 50);
  assert.ok(payload.regime.reasons.length >= 1);
  assert.ok(payload.regime.reasons.length <= 3);
  assert.deepEqual(payload.regime.reasons, payload.regime.rationale);
  assert.ok(payload.regime.reasons.every(reason => typeof reason === 'string' && reason.length > 0));
});

test('market regime revision follows observations, not retrieval or cache age', () => {
  const fixture = marketRegimeFixture();
  const first = buildMarketRegimePayload(fixture.histories, fixture.retrievedAt);
  const laterRetrieval = buildMarketRegimePayload(
    fixture.histories,
    new Date(Date.parse(fixture.retrievedAt) + 60_000).toISOString()
  );
  const changedFixture = marketRegimeFixture();
  changedFixture.histories.get('^VIX').points.at(-1).close += 1;
  changedFixture.histories.get('^VIX').points.at(-1).rawClose += 1;
  const changed = buildMarketRegimePayload(changedFixture.histories, changedFixture.retrievedAt);
  assert.equal(first.dataRevision, laterRetrieval.dataRevision);
  assert.notEqual(first.dataRevision, changed.dataRevision);
});

test('danger rules combine high/rising VIX, falling SPY and a confirmed oil shock', () => {
  const fixture = marketRegimeFixture({
    vix: index => 15 * Math.pow(1.035, index),
    wti: index => 60 * Math.pow(1.018, index),
    spy: index => 500 * Math.pow(0.989, index)
  });
  const payload = buildMarketRegimePayload(fixture.histories, fixture.retrievedAt);

  assert.equal(payload.status, 'ok');
  assert.equal(payload.regime.state, 'danger');
  assert.ok(payload.regime.score <= 29);
  assert.ok(payload.regime.contributions.some(entry => entry.factor.startsWith('wti-up-') && entry.points < 0));
  assert.ok(payload.regime.contributions.some(entry => entry.factor.startsWith('vix-') && entry.points < 0));
  assert.ok(payload.regime.contributions.some(entry => entry.factor.startsWith('spy-') && entry.points < 0));
});

test('oil rise alone is neutral and an oil collapse is conditional on cross-market context', () => {
  const risingOil = marketRegimeFixture({
    vix: () => 15,
    wti: index => 60 * Math.pow(1.02, index),
    spy: index => 500 * Math.pow(1.004, index)
  });
  const rise = buildMarketRegimePayload(risingOil.histories, risingOil.retrievedAt);
  const oilReference = rise.regime.contributions.find(entry => entry.factor === 'wti-up-unconfirmed');
  assert.equal(oilReference.points, 0);
  assert.notEqual(rise.regime.state, 'danger');

  const unconfirmedCollapse = marketRegimeFixture({
    vix: () => 18,
    wti: index => 100 * Math.pow(0.98, index),
    spy: () => 500
  });
  const unconfirmed = buildMarketRegimePayload(unconfirmedCollapse.histories, unconfirmedCollapse.retrievedAt);
  assert.ok(unconfirmed.regime.contributions.some(entry =>
    entry.factor.startsWith('wti-down-unconfirmed-') && entry.points === 0));

  const demandScare = marketRegimeFixture({
    vix: index => 15 * Math.pow(1.02, index),
    wti: index => 100 * Math.pow(0.98, index),
    spy: index => 500 * Math.pow(0.995, index)
  });
  const demand = buildMarketRegimePayload(demandScare.histories, demandScare.retrievedAt);
  assert.ok(demand.regime.contributions.some(entry =>
    entry.factor.startsWith('wti-down-demand-scare-') && entry.points < 0));

  const disinflation = marketRegimeFixture({
    vix: index => 25 * Math.pow(0.98, index),
    wti: index => 100 * Math.pow(0.98, index),
    spy: index => 500 * Math.pow(1.005, index)
  });
  const relief = buildMarketRegimePayload(disinflation.histories, disinflation.retrievedAt);
  assert.ok(relief.regime.contributions.some(entry =>
    entry.factor.startsWith('wti-down-disinflation-') && entry.points > 0));
  assert.match(relief.methodology.oilInterpretation, /sharp fall/i);
});

test('confirmed shorter-horizon oil demand scare outranks an ambiguous longer collapse', () => {
  const result = scoreMarketRegime({
    vix: { level: 18, changesPct: { '1d': 0, '5d': 12, '20d': 0 } },
    wti: { changesPct: { '1d': 0, '5d': -16, '20d': -30 } },
    spy: { changesPct: { '1d': 0, '5d': 0, '20d': 0 } }
  });
  const oilContributions = result.contributions.filter(entry => entry.factor.startsWith('wti-down-'));
  assert.equal(oilContributions.length, 1);
  assert.equal(oilContributions[0].factor, 'wti-down-demand-scare-5d');
  assert.equal(oilContributions[0].points, -7);
});

test('missing exact endpoints never use nearest dates or future observations', () => {
  const fixture = marketRegimeFixture();
  const missingBaseline = fixture.dates.at(-6);
  fixture.histories.get('CL=F').points = fixture.histories.get('CL=F').points
    .filter(point => point.sessionDate !== missingBaseline);
  const payload = buildMarketRegimePayload(fixture.histories, fixture.retrievedAt);

  assert.equal(payload.indicators.wti.changesPct['5d'], null);
  assert.equal(payload.indicators.wti.baselines['5d'].exactSession, false);
  assert.equal(payload.status, 'partial');
  assert.equal(payload.regime.state, 'unavailable');
  assert.equal(payload.regime.decisionEligible, false);

  const futureDate = '2026-08-03';
  fixture.histories.get('SPY').points.push({
    timestamp: Date.parse(`${futureDate}T21:00:00.000Z`) / 1000,
    at: `${futureDate}T21:00:00.000Z`,
    sessionDate: futureDate,
    close: 9_999,
    rawClose: 9_999,
    priceMode: 'adjusted'
  });
  const lagged = buildMarketRegimePayload(fixture.histories, `${futureDate}T23:00:00.000Z`);
  assert.equal(lagged.asOf, fixture.dates.at(-1));
  assert.equal(lagged.availability.synchronizedConfirmedSession.lagSessions, 1);
  assert.equal(lagged.status, 'partial');
  assert.equal(lagged.regime.state, 'unavailable');
});

test('raw, mixed, stale, nonpositive and extreme observations preserve display data but fail closed', () => {
  const rawFixture = marketRegimeFixture({
    modes: { '^VIX': 'raw', 'CL=F': 'raw', SPY: 'raw' }
  });
  const raw = buildMarketRegimePayload(rawFixture.histories, rawFixture.retrievedAt);
  assert.equal(raw.status, 'partial');
  assert.notEqual(raw.regime.state, 'unavailable');
  assert.equal(raw.regime.referenceOnly, true);
  assert.equal(raw.regime.watchOnly, true);
  assert.ok(Number.isFinite(raw.regime.optimismScore));
  assert.equal(raw.regime.riskScore, 100 - raw.regime.optimismScore);
  assert.equal(raw.regime.decisionEligible, false);
  assert.equal(raw.availability.adjustedClose.available, false);
  assert.equal(raw.tradingSignal, null);

  const mixedFixture = marketRegimeFixture({ modes: { 'CL=F': 'mixed' } });
  const mixed = buildMarketRegimePayload(mixedFixture.histories, mixedFixture.retrievedAt);
  assert.equal(mixed.status, 'partial');
  assert.notEqual(mixed.regime.state, 'unavailable');
  assert.equal(mixed.regime.referenceOnly, true);
  assert.equal(mixed.availability.adjustedClose.priceMode, 'mixed-native-close-reference');

  const staleFixture = marketRegimeFixture();
  const staleAt = new Date(Date.parse(staleFixture.retrievedAt) + 8 * 24 * 60 * 60 * 1000).toISOString();
  const stale = buildMarketRegimePayload(staleFixture.histories, staleAt);
  assert.equal(stale.status, 'partial');
  assert.equal(stale.meta.observationStale, true);
  assert.equal(stale.regime.state, 'unavailable');
  assert.equal(stale.regime.score, null);

  const negativeFixture = marketRegimeFixture();
  const negativeLast = negativeFixture.histories.get('CL=F').points.at(-1);
  negativeLast.close = -37.63;
  negativeLast.rawClose = -37.63;
  const negative = buildMarketRegimePayload(negativeFixture.histories, negativeFixture.retrievedAt);
  assert.equal(negative.instruments.wti.value, -37.63);
  assert.equal(negative.instruments.wti.returnUndefinedReason, 'nonpositive-futures-level');
  assert.equal(negative.instruments.wti.changes['1d'], null);
  assert.equal(negative.regime.state, 'unavailable');

  for (const invalidLevel of [5_000]) {
    const invalidFixture = marketRegimeFixture();
    const last = invalidFixture.histories.get('CL=F').points.at(-1);
    last.close = invalidLevel;
    last.rawClose = invalidLevel;
    const invalid = buildMarketRegimePayload(invalidFixture.histories, invalidFixture.retrievedAt);
    assert.equal(invalid.indicators.wti.level, null);
    assert.equal(invalid.indicators.wti.invalidReason, 'implausible-level');
    assert.equal(invalid.status, 'partial');
    assert.equal(invalid.regime.state, 'unavailable');
  }
});

test('market regime freshness matches the 96-hour UI contract across weekends', () => {
  const fixture = marketRegimeFixture();
  const observedAt = Date.parse(fixture.histories.get('SPY').points.at(-1).at);
  const withinWeekendWindow = buildMarketRegimePayload(
    fixture.histories,
    new Date(observedAt + MARKET_REGIME_MAX_OBSERVATION_AGE_MS - 60_000).toISOString()
  );
  assert.equal(withinWeekendWindow.meta.observationStale, false);
  assert.notEqual(withinWeekendWindow.regime.state, 'unavailable');
  assert.equal(withinWeekendWindow.meta.maximumObservationAgeMs, 96 * 60 * 60 * 1000);

  const stoppedForFiveDays = buildMarketRegimePayload(
    fixture.histories,
    new Date(observedAt + MARKET_REGIME_MAX_OBSERVATION_AGE_MS + 60_000).toISOString()
  );
  assert.equal(stoppedForFiveDays.meta.observationStale, true);
  assert.equal(stoppedForFiveDays.regime.state, 'unavailable');
  assert.equal(stoppedForFiveDays.regime.score, null);
});

test('market regime service caches synchronized observations and fail-closes stale fallback', async () => {
  const fixture = marketRegimeFixture();
  let now = Date.parse(fixture.retrievedAt);
  let fail = false;
  let calls = 0;
  const service = new MarketDataService({
    fetch: async () => { throw new Error('fetch should be replaced'); },
    now: () => now,
    marketRegimeTtlMs: 1_000,
    marketRegimePartialTtlMs: 500,
    marketRegimeStaleMs: 60_000
  });
  service._yahooThemeHistory = async () => {
    calls += 1;
    if (fail) throw new Error('upstream down');
    return fixture.histories;
  };

  const first = await service.getMarketRegime();
  const hit = await service.getMarketRegime();
  assert.equal(first.meta.cache, 'refreshed');
  assert.equal(hit.meta.cache, 'hit');
  assert.equal(calls, 1);

  now += 2_000;
  fail = true;
  const stale = await service.getMarketRegime();
  assert.equal(stale.meta.cache, 'stale-fallback');
  assert.equal(stale.meta.stale, true);
  assert.equal(stale.status, 'partial');
  assert.equal(stale.regime.state, 'unavailable');
  assert.equal(stale.regime.score, null);
  assert.equal(stale.regime.decisionEligible, false);
  assert.equal(stale.tradingSignal, null);
});

test('explicit market regime refresh bypasses the fifteen-minute history cache after the quote refresh floor', async () => {
  const fixture = marketRegimeFixture();
  let now = Date.parse(fixture.retrievedAt);
  let calls = 0;
  const bypassFlags = [];
  const service = new MarketDataService({
    fetch: async () => { throw new Error('fetch should be replaced'); },
    now: () => now,
    ttlMs: 45_000,
    marketRegimeTtlMs: 15 * 60_000
  });
  service._yahooThemeHistory = async (_symbols, _context, options = {}) => {
    calls += 1;
    bypassFlags.push(options.bypassCache === true);
    return fixture.histories;
  };

  const first = await service.getMarketRegime();
  const normalHit = await service.getMarketRegime();
  assert.equal(first.meta.cache, 'refreshed');
  assert.equal(normalHit.meta.cache, 'hit');
  assert.equal(calls, 1);
  assert.deepEqual(bypassFlags, [false]);

  const immediate = await service.getMarketRegime({ forceRefresh: true });
  assert.equal(immediate.meta.cache, 'hit');
  assert.equal(immediate.meta.refreshRequested, true);
  assert.equal(immediate.meta.refreshSuppressed, true);
  assert.equal(calls, 1, 'manual refresh shares the same short anti-spam floor as FX quotes');

  now += 45_001;
  const forced = await service.getMarketRegime({ forceRefresh: true });
  assert.equal(forced.meta.cache, 'refreshed');
  assert.equal(forced.meta.refreshRequested, true);
  assert.equal(forced.meta.refreshSuppressed, false);
  assert.equal(calls, 2);
  assert.deepEqual(bypassFlags, [false, true]);
  assert.equal(forced.dataRevision, first.dataRevision, 'retrieval alone does not fabricate a new observation revision');
  assert.notEqual(forced.updatedAt, first.updatedAt);
});

test('incomplete market regime history uses the short partial cache without a request loop', async () => {
  const fixture = marketRegimeFixture();
  const missingDate = fixture.dates.at(-6);
  fixture.histories.get('CL=F').points = fixture.histories.get('CL=F').points
    .filter(point => point.sessionDate !== missingDate);
  let now = Date.parse(fixture.retrievedAt);
  let calls = 0;
  const service = new MarketDataService({
    fetch: async () => { throw new Error('fetch should be replaced'); },
    now: () => now,
    marketRegimeTtlMs: 60_000,
    marketRegimePartialTtlMs: 500
  });
  service._yahooThemeHistory = async () => {
    calls += 1;
    return fixture.histories;
  };

  const first = await service.getMarketRegime();
  const hit = await service.getMarketRegime();
  assert.equal(first.status, 'partial');
  assert.equal(first.meta.cache, 'refreshed');
  assert.equal(hit.meta.cache, 'hit');
  assert.equal(calls, 1);

  now += 600;
  const refreshed = await service.getMarketRegime();
  assert.equal(refreshed.meta.cache, 'refreshed');
  assert.equal(calls, 2);
});

test('fresh high-VIX partial observation outranks an expired complete cache', async () => {
  const completeFixture = marketRegimeFixture({ vix: () => 15 });
  const dangerFixture = marketRegimeFixture({ vix: () => 40 });
  dangerFixture.histories.delete('CL=F');
  let now = Date.parse(completeFixture.retrievedAt);
  let useDangerPartial = false;
  let calls = 0;
  const service = new MarketDataService({
    fetch: async () => { throw new Error('fetch should be replaced'); },
    now: () => now,
    marketRegimeTtlMs: 1_000,
    marketRegimePartialTtlMs: 500,
    marketRegimeStaleMs: 60_000
  });
  service._yahooThemeHistory = async () => {
    calls += 1;
    return useDangerPartial ? dangerFixture.histories : completeFixture.histories;
  };

  const complete = await service.getMarketRegime();
  assert.notEqual(complete.regime.state, 'danger');
  assert.equal(complete.meta.cacheTier, 'complete');
  assert.ok(service.marketRegimeCache);

  now += 2_000;
  useDangerPartial = true;
  const danger = await service.getMarketRegime();
  assert.equal(danger.meta.cache, 'refreshed');
  assert.equal(danger.meta.cacheTier, 'partial');
  assert.equal(danger.meta.stale, false);
  assert.equal(danger.status, 'partial');
  assert.equal(danger.regime.state, 'danger');
  assert.equal(danger.regime.dangerOverride, true);
  assert.equal(danger.regime.score <= 20, true);
  assert.ok(service.marketRegimeCache, 'last complete observation remains available for transport failure');
  assert.ok(service.marketRegimePartialCache, 'fresh partial observation is cached separately');

  const partialHit = await service.getMarketRegime();
  assert.equal(partialHit.meta.cache, 'hit');
  assert.equal(partialHit.meta.cacheTier, 'partial');
  assert.equal(partialHit.regime.state, 'danger');
  assert.equal(calls, 2);

  now += 600;
  service._yahooThemeHistory = async () => {
    calls += 1;
    throw new Error('upstream down');
  };
  const newestStale = await service.getMarketRegime();
  assert.equal(newestStale.meta.cache, 'stale-fallback');
  assert.equal(newestStale.meta.cacheTier, 'partial');
  assert.equal(newestStale.meta.stale, true);
  assert.equal(newestStale.regime.state, 'unavailable');
  assert.equal(newestStale.regime.score, null);
  assert.equal(newestStale.instruments.vix.value, 40);
  assert.equal(calls, 3);
});

test('concurrent market regime callers coalesce into one shared history refresh', async () => {
  const fixture = marketRegimeFixture();
  let release;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const service = new MarketDataService({
    fetch: async () => { throw new Error('fetch should be replaced'); },
    now: () => Date.parse(fixture.retrievedAt)
  });
  service._yahooThemeHistory = async () => {
    calls += 1;
    await gate;
    return fixture.histories;
  };
  const first = service.getMarketRegime();
  const second = service.getMarketRegime();
  await new Promise(resolve => setImmediate(resolve));
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(left.dataRevision, right.dataRevision);
  assert.equal(service.marketRegimeInFlight, null);
});

test('force refresh queues once behind a normal refresh and caller abort does not stop shared work', async () => {
  const fixture = marketRegimeFixture();
  const releases = [];
  const bypassFlags = [];
  let calls = 0;
  const service = new MarketDataService({
    fetch: async () => { throw new Error('fetch should be replaced'); },
    now: () => Date.parse(fixture.retrievedAt),
    ttlMs: 45_000,
    marketRegimeTtlMs: 15 * 60_000,
    marketRegimeDeadlineMs: 5_000
  });
  service._yahooThemeHistory = async (_symbols, _context, options = {}) => {
    calls += 1;
    bypassFlags.push(options.bypassCache === true);
    await new Promise(resolve => releases.push(resolve));
    return fixture.histories;
  };
  const waitForCallCount = async expected => {
    for (let attempt = 0; attempt < 20 && releases.length < expected; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(releases.length, expected);
  };

  const normal = service.getMarketRegime();
  await waitForCallCount(1);
  assert.equal(service.marketRegimeInFlightForce, false);

  const controller = new AbortController();
  const abortedForce = service.getMarketRegime({
    forceRefresh: true,
    signal: controller.signal
  });
  const survivingForce = service.getMarketRegime({ forceRefresh: true });
  const sharedQueuedForce = service.marketRegimeForceQueued;
  assert.ok(sharedQueuedForce);
  assert.equal(service.marketRegimeForceQueued, sharedQueuedForce);
  assert.equal(calls, 1, 'force waits for the active normal refresh');

  controller.abort();
  await assert.rejects(abortedForce, error => error?.code === 'CLIENT_ABORT');
  assert.equal(service.marketRegimeForceQueued, sharedQueuedForce, 'caller abort leaves shared force queued');

  releases[0]();
  const normalPayload = await normal;
  assert.equal(normalPayload.meta.refreshRequested, false);
  await waitForCallCount(2);
  assert.equal(service.marketRegimeInFlightForce, true);
  assert.equal(service.marketRegimeForceQueued, sharedQueuedForce);

  const joinedDuringForce = service.getMarketRegime({ forceRefresh: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2, 'force caller joins the running forced refresh');

  releases[1]();
  const [queuedPayload, joinedPayload] = await Promise.all([survivingForce, joinedDuringForce]);
  assert.equal(queuedPayload.meta.refreshRequested, true);
  assert.equal(joinedPayload.meta.refreshRequested, true);
  assert.equal(queuedPayload.meta.refreshSuppressed, false);
  assert.equal(joinedPayload.meta.refreshSuppressed, false);
  assert.equal(queuedPayload.dataRevision, joinedPayload.dataRevision);
  assert.deepEqual(bypassFlags, [false, true], 'the internal queued force bypasses the floor exactly once');
  assert.equal(calls, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.marketRegimeInFlight, null);
  assert.equal(service.marketRegimeInFlightForce, false);
  assert.equal(service.marketRegimeForceQueued, null);
});

test('scoreMarketRegime exposes a bounded transparent 0-danger to 100-optimistic scale', () => {
  const result = scoreMarketRegime({
    vix: { level: 80, changesPct: { '1d': 30, '5d': 50, '20d': 90 } },
    wti: { changesPct: { '1d': 10, '5d': 20, '20d': 40 } },
    spy: { changesPct: { '1d': -5, '5d': -10, '20d': -20 } }
  });
  assert.equal(result.score, 0);
  assert.equal(result.classification.id, 'danger');
  assert.equal(result.scale.direction, '0=danger, 100=optimistic');
  assert.ok(result.contributions.every(entry => Number.isFinite(entry.points)));
});

test('actual-like neutral observations explain zero-point VIX, SPY and WTI context', () => {
  const result = scoreMarketRegime({
    vix: {
      level: 18.1,
      changesPct: { '1d': 0.5, '5d': -2.5, '20d': 5 },
      changesPoints: { '1d': 0.1, '5d': -0.5, '20d': 0.9 }
    },
    wti: { changesPct: { '1d': 1.1, '5d': 2.8, '20d': 6.2 } },
    spy: { changesPct: { '1d': 0.2, '5d': 1.2, '20d': 4.5 } }
  });

  assert.equal(result.score, 50);
  assert.equal(result.classification.id, 'neutral');
  assert.equal(result.rationale.length, 3);
  assert.ok(result.rationale.includes('VIXが通常域'));
  assert.ok(result.rationale.includes('SPYの1・5・20日変化は警戒・楽観の判定閾値内'));
  assert.ok(result.rationale.includes('原油上昇だけでは危険判定にしない'));
  assert.ok(result.contributions
    .filter(contribution => result.rationale.includes(contribution.reason))
    .every(contribution => contribution.points === 0));
});

test('VIX hard caps prevent a high but falling VIX from becoming optimistic', () => {
  const result = scoreMarketRegime({
    vix: { level: 35, changesPct: { '1d': -20, '5d': -30, '20d': -50 } },
    wti: { changesPct: { '1d': 0, '5d': 0, '20d': 0 } },
    spy: { changesPct: { '1d': 2, '5d': 6, '20d': 13 } }
  });
  assert.equal(result.classification.id, 'danger');
  assert.ok(result.score <= 29);
  assert.ok(result.contributions.some(entry => entry.factor === 'vix-hard-cap'));
  assert.ok(result.contributions.filter(entry => /^vix-(1d|5d|20d)$/.test(entry.factor)).length <= 1);
  assert.ok(result.contributions.filter(entry => /^spy-(1d|5d|20d)$/.test(entry.factor)).length <= 1);
});

test('short-horizon VIX or SPY stress outranks overlapping long-horizon relief', () => {
  const spyConflict = scoreMarketRegime({
    vix: { level: 15, changesPct: { '1d': 0, '5d': 0, '20d': 0 } },
    wti: { changesPct: { '1d': 0, '5d': 0, '20d': 0 } },
    spy: { changesPct: { '1d': -3, '5d': 0, '20d': 12 } }
  });
  assert.ok(spyConflict.contributions.some(entry => entry.factor === 'spy-1d' && entry.points === -12));
  assert.ok(!spyConflict.contributions.some(entry => entry.factor === 'spy-20d' && entry.points > 0));
  assert.notEqual(spyConflict.classification.id, 'optimistic');

  const vixConflict = scoreMarketRegime({
    vix: { level: 15, changesPct: { '1d': 10, '5d': 0, '20d': -25 } },
    wti: { changesPct: { '1d': 0, '5d': 0, '20d': 0 } },
    spy: { changesPct: { '1d': 0, '5d': 0, '20d': 0 } }
  });
  assert.ok(vixConflict.contributions.some(entry => entry.factor === 'vix-1d' && entry.points === -6));
  assert.ok(!vixConflict.contributions.some(entry => entry.factor === 'vix-20d' && entry.points > 0));
});

test('risk improvement is capped per confirmed session without delaying deterioration', () => {
  const fixture = marketRegimeFixture({
    sessions: 35,
    vix: index => index === 34 ? 15 : (index === 33 ? 40 : 22),
    wti: () => 75,
    spy: index => index === 34 ? 530 : (index === 33 ? 450 : 500)
  });
  const payload = buildMarketRegimePayload(fixture.histories, fixture.retrievedAt);
  assert.ok(payload.regime.previousRawScores.length >= 1);
  assert.ok(payload.regime.contributions.some(entry => entry.factor === 'risk-improvement-hysteresis'));
  assert.ok(payload.regime.score <= payload.regime.previousRawScores[0].score + 12);
});

test('revision includes older endpoints used by score hysteresis', () => {
  const options = {
    sessions: 35,
    vix: index => index === 34 ? 15 : (index === 33 ? 26 : 22),
    wti: () => 75,
    spy: index => index === 34 ? 530 : (index === 33 ? 450 : 500)
  };
  const firstFixture = marketRegimeFixture(options);
  const secondFixture = marketRegimeFixture(options);
  secondFixture.histories.get('SPY').points[13].close = 800;
  secondFixture.histories.get('SPY').points[13].rawClose = 800;
  const first = buildMarketRegimePayload(firstFixture.histories, firstFixture.retrievedAt);
  const second = buildMarketRegimePayload(secondFixture.histories, secondFixture.retrievedAt);

  assert.deepEqual(first.instruments.spy.changes, second.instruments.spy.changes);
  assert.notDeepEqual(first.regime.previousRawScores, second.regime.previousRawScores);
  assert.notEqual(first.regime.score, second.regime.score);
  assert.notEqual(first.dataRevision, second.dataRevision);
});

test('fresh high VIX can escalate danger with missing inputs but missing data cannot reassure', () => {
  const highVix = marketRegimeFixture({ vix: () => 35 });
  highVix.histories.delete('CL=F');
  const danger = buildMarketRegimePayload(highVix.histories, highVix.retrievedAt);
  assert.equal(danger.status, 'partial');
  assert.equal(danger.regime.state, 'danger');
  assert.equal(danger.regime.dangerOverride, true);
  assert.equal(danger.regime.tradeEligible, false);

  const lowVix = marketRegimeFixture({ vix: () => 15 });
  lowVix.histories.delete('CL=F');
  const blockedReassurance = buildMarketRegimePayload(lowVix.histories, lowVix.retrievedAt);
  assert.equal(blockedReassurance.regime.state, 'unavailable');
  assert.equal(blockedReassurance.regime.score, null);
});

test('a futures weekend open period does not discard the last confirmed Friday WTI bar', () => {
  const friday = Date.parse('2026-07-24T21:00:00Z') / 1000;
  const sundayStart = Date.parse('2026-07-26T22:00:00Z') / 1000;
  const payload = {
    spark: {
      result: [{
        symbol: 'CL=F',
        response: [{
          meta: {
            currency: 'USD',
            regularMarketTime: friday,
            currentTradingPeriod: {
              regular: {
                start: sundayStart,
                end: Date.parse('2026-07-27T21:00:00Z') / 1000
              }
            }
          },
          timestamp: [friday],
          indicators: {
            quote: [{ close: [78.5] }]
          }
        }]
      }]
    }
  };
  const parsed = parseYahooThemeHistory(payload, Date.parse('2026-07-26T23:00:00Z'));
  assert.equal(parsed.get('CL=F').points.length, 1);
  assert.equal(parsed.get('CL=F').excludedOpenSession, false);
});

test('WTI nonpositive closes are preserved while percentage returns remain undefined', () => {
  const timestamp = Date.parse('2020-04-20T21:00:00Z') / 1000;
  const points = normalizeHistoryPoints({
    timestamp: [timestamp],
    indicators: { quote: [{ close: [-37.63] }] }
  }, 'CL=F');
  assert.equal(points.length, 1);
  assert.equal(points[0].rawClose, -37.63);
});

function technicalChart(
  symbol,
  count = 1_320,
  start = '2021-01-04T21:00:00Z',
  metadata = {}
) {
  const timestamp = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  const volume = [];
  const adjusted = [];
  const date = new Date(start);
  let session = 0;
  while (timestamp.length < count) {
    if (![0, 6].includes(date.getUTCDay())) {
      const value = 60 * Math.exp(session * 0.00035) *
        (1 + Math.sin(session / 7) * 0.045 + Math.sin(session / 23) * 0.015);
      const opening = value * (1 - Math.sin(session / 5) * 0.003);
      timestamp.push(Math.floor(date.getTime() / 1000));
      open.push(opening);
      high.push(Math.max(opening, value) * 1.007);
      low.push(Math.min(opening, value) * 0.993);
      close.push(value);
      volume.push(1_000_000 + (session % 17) * 10_000);
      adjusted.push(value);
      session += 1;
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return {
    meta: {
      symbol,
      currency: 'USD',
      regularMarketPrice: close.at(-1),
      regularMarketTime: timestamp.at(-1),
      fullExchangeName: 'NasdaqGS',
      quoteType: 'EQUITY',
      instrumentType: 'EQUITY',
      longName: `${symbol} Corporation`,
      shortName: symbol,
      ...metadata,
      currentTradingPeriod: {}
    },
    timestamp,
    indicators: {
      quote: [{ open, high, low, close, volume }],
      adjclose: [{ adjclose: adjusted }]
    }
  };
}

function technicalSparkPayload(symbols, count = 1_320, metadataBySymbol = {}) {
  return {
    spark: {
      result: symbols.map(symbol => ({
        symbol,
        response: [technicalChart(symbol, count, '2021-01-04T21:00:00Z', metadataBySymbol[symbol])]
      })),
      error: null
    }
  };
}

test('technical Yahoo parser requires real OHLC and never fills a missing open from close', () => {
  const valid = technicalChart('NVDA', 3);
  const invalid = structuredClone(valid);
  invalid.indicators.quote[0].open[1] = null;
  const bars = normalizeTechnicalBars(invalid);
  assert.equal(bars.length, 2);
  assert.equal(bars.some(bar => bar.sessionDate === new Date(valid.timestamp[1] * 1000).toISOString().slice(0, 10)), false);

  const parsed = parseYahooTechnicalHistory({
    spark: { result: [{ symbol: 'NVDA', response: [invalid] }] }
  }, Date.parse('2026-07-30T12:00:00Z'));
  assert.equal(parsed.get('NVDA').bars.length, 2);
  assert.equal(parsed.get('NVDA').partial, true);
  assert.equal(parsed.get('NVDA').quoteType, 'EQUITY');
  assert.equal(parsed.get('NVDA').longName, 'NVDA Corporation');
  assert.ok(parsed.get('NVDA').ohlcCoveragePct < 100);

  const chartHistory = parseYahooTechnicalChartHistory({
    chart: { result: [valid], error: null }
  }, 'NVDA', Date.parse('2026-07-30T12:00:00Z'));
  assert.equal(chartHistory.bars.length, 3);
  assert.equal(chartHistory.source, 'yahoo-chart-v8-5y-1d');
});

test('technical history falls back to Yahoo Chart v8 when Spark exposes close-only data', async () => {
  const fullChart = technicalChart('SPY');
  const closeOnlyChart = {
    meta: fullChart.meta,
    timestamp: fullChart.timestamp,
    indicators: { quote: [{ close: fullChart.indicators.quote[0].close }] }
  };
  const latest = fullChart.timestamp.at(-1) * 1000;
  const calls = [];
  const service = new MarketDataService({
    fetch: async url => {
      const href = String(url);
      calls.push(href);
      const payload = href.includes('/v8/finance/chart/')
        ? { chart: { result: [fullChart], error: null } }
        : { spark: { result: [{ symbol: 'SPY', response: [closeOnlyChart] }], error: null } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    now: () => latest + 12 * 60 * 60 * 1000,
    clock: () => latest + 12 * 60 * 60 * 1000,
    sleep: async () => {}
  });
  const first = await service.getBuySignals({
    symbols: ['SPY'],
    intelligencePayload: { status: 'partial', themes: [] }
  });
  const callCountAfterFirst = calls.length;
  const second = await service.getBuySignals({
    symbols: ['SPY'],
    intelligencePayload: { status: 'partial', themes: [] }
  });
  assert.ok(calls.some(url => url.includes('/v7/finance/spark')));
  assert.ok(calls.some(url => url.includes('/v8/finance/chart/SPY')));
  assert.equal(first.results[0].quality.dailyBars, 1_320);
  assert.equal(first.results[0].quality.source, 'yahoo-chart-v8-5y-1d');
  assert.notEqual(first.results[0].status, 'unavailable');
  assert.equal(second.results[0].quality.cacheState, 'hit');
  assert.equal(calls.length, callCountAfterFirst);
});

test('buy signals use one dedicated 5y/1d Yahoo batch, cache it, and fail closed on optional evidence', async () => {
  const calls = [];
  const payload = technicalSparkPayload(['NVDA']);
  const latest = payload.spark.result[0].response[0].timestamp.at(-1) * 1000;
  const service = new MarketDataService({
    fetch: async url => {
      calls.push(String(url));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    now: () => latest + 12 * 60 * 60 * 1000,
    clock: () => latest + 12 * 60 * 60 * 1000,
    sleep: async () => {}
  });
  const intelligencePayload = {
    status: 'ok',
    asOf: new Date(latest).toISOString().slice(0, 10),
    themes: [{
      id: 'ai-semiconductors',
      name: 'AI半導体',
      status: 'ok',
      score: 82,
      trend: 'up',
      breadth: 70,
      confidence: 90,
      relatedTickers: ['NVDA']
    }]
  };
  const account = {
    equityJpy: 10_000_000,
    cashJpy: 2_000_000,
    usdJpy: 150,
    riskBudgetJpy: 100_000,
    existingOpenRiskJpy: 0,
    maxPositionPct: 10
  };
  const first = await service.getBuySignals({
    symbols: ['NVDA'],
    intelligencePayload,
    account
  });
  const second = await service.getBuySignals({
    symbols: ['NVDA'],
    intelligencePayload,
    account
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /range=5y/);
  assert.match(calls[0], /interval=1d/);
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0].signals.total, 8);
  assert.ok([true, 'unavailable'].includes(first.results[0].signals.supportBounce));
  assert.equal(first.results[0].fundamental.status, 'unavailable');
  assert.equal(first.results[0].dataStatus, 'partial');
  assert.equal(first.results[0].tradeEligible, false);
  assert.equal(second.results[0].quality.cacheState, 'hit');
});

test('technical service marks short-history symbols unavailable and backtests A-E with SPY only as benchmark', async () => {
  const payload = technicalSparkPayload(['SNDK', 'SPY'], 520);
  const latest = payload.spark.result[0].response[0].timestamp.at(-1) * 1000;
  const service = new MarketDataService({
    fetch: async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }),
    now: () => latest + 12 * 60 * 60 * 1000,
    clock: () => latest + 12 * 60 * 60 * 1000,
    sleep: async () => {}
  });
  const signals = await service.getBuySignals({
    symbols: ['SNDK'],
    intelligencePayload: { status: 'partial', themes: [] },
    account: {}
  });
  assert.equal(signals.status, 'unavailable');
  assert.equal(signals.results[0].status, 'unavailable');
  assert.equal(signals.results[0].decision, 'unavailable');

  const backtest = await service.getTechnicalBacktest({
    symbols: ['SNDK'],
    commissionBps: 1,
    slippageBps: 10
  });
  assert.equal(backtest.results[0].status, 'unavailable');
  assert.equal(backtest.results[0].backtest.status, 'unavailable');
});

test('buy-signal integration blocks known leveraged ETFs and caps metadata-less ETFs', async () => {
  const symbols = ['QLD', 'SSO', 'MSTU', 'NVDA', 'MYST'];
  const payload = technicalSparkPayload(symbols, 1_320, {
    QLD: {
      quoteType: 'ETF',
      instrumentType: 'ETF',
      longName: 'ProShares Ultra QQQ',
      shortName: 'QLD'
    },
    SSO: {
      quoteType: 'ETF',
      instrumentType: 'ETF',
      longName: 'ProShares Ultra S&P500',
      shortName: 'SSO'
    },
    MSTU: {
      quoteType: 'ETF',
      instrumentType: 'ETF',
      longName: 'T-Rex 2X Long MSTR Daily Target ETF',
      shortName: 'MSTU'
    },
    MYST: {
      quoteType: 'ETF',
      instrumentType: 'ETF',
      longName: null,
      shortName: null
    }
  });
  const latest = payload.spark.result[0].response[0].timestamp.at(-1) * 1000;
  let calls = 0;
  const service = new MarketDataService({
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    now: () => latest + 12 * 60 * 60 * 1000,
    clock: () => latest + 12 * 60 * 60 * 1000,
    sleep: async () => {}
  });
  const response = await service.getBuySignals({
    symbols,
    intelligencePayload: { status: 'partial', themes: [] },
    account: {
      equityJpy: 10_000_000,
      cashJpy: 2_000_000,
      usdJpy: 150,
      riskBudgetJpy: 100_000
    }
  });
  assert.equal(calls, 1);
  const bySymbol = new Map(response.results.map(result => [result.symbol, result]));
  for (const symbol of ['QLD', 'SSO', 'MSTU']) {
    assert.equal(bySymbol.get(symbol).leverageStatus, 'leveraged', symbol);
    assert.equal(bySymbol.get(symbol).leverageProvenance.source, 'static-leveraged-symbol', symbol);
    assert.equal(bySymbol.get(symbol).positionPlan.shares, 0, symbol);
  }
  assert.equal(bySymbol.get('NVDA').leverageStatus, 'unleveraged');
  assert.equal(bySymbol.get('NVDA').leverageProvenance.source, 'yahoo-quote-type');
  assert.equal(bySymbol.get('MYST').leverageStatus, 'unavailable');
  assert.equal(bySymbol.get('MYST').leverageBlocked, true);
  assert.ok(bySymbol.get('MYST').caps.some(cap => cap.key === 'leverage-unavailable'));
  assert.equal(bySymbol.get('MYST').positionPlan.shares, 0);
});

test('full technical backtest batches target with SPY, exposes A-F, and supports cancellation', async () => {
  const payload = technicalSparkPayload(['NVDA', 'SPY'], 1_320, {
    SPY: {
      quoteType: 'ETF',
      instrumentType: 'ETF',
      longName: 'SPDR S&P 500 ETF Trust',
      shortName: 'SPY'
    }
  });
  const latest = payload.spark.result[0].response[0].timestamp.at(-1) * 1000;
  let calls = 0;
  const service = new MarketDataService({
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    },
    now: () => latest + 12 * 60 * 60 * 1000,
    clock: () => latest + 12 * 60 * 60 * 1000,
    sleep: async () => {}
  });
  const response = await service.getTechnicalBacktest({
    symbols: ['NVDA'],
    commissionBps: 2,
    slippageBps: 8
  });
  assert.equal(calls, 1);
  assert.equal(response.results[0].backtest.status, 'ok');
  assert.deepEqual(
    response.results[0].backtest.strategies.map(strategy => strategy.id),
    ['A', 'B', 'C', 'D', 'E', 'F']
  );
  assert.equal(response.results[0].backtest.strategies.at(-1).status, 'unavailable');
  assert.equal(response.results[0].backtest.assumptions.benchmark, 'SPY');

  const controller = new AbortController();
  controller.abort();
  const cancelled = new MarketDataService({
    fetch: async () => {
      throw new Error('fetch should not run after cancellation');
    },
    sleep: async () => {}
  });
  await assert.rejects(
    cancelled.getTechnicalBacktest({ symbols: ['NVDA'], signal: controller.signal }),
    error => error?.code === 'CLIENT_ABORT'
  );
});
