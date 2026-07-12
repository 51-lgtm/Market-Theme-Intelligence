'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyValidatedEdgeAssociations,
  buildIntelligencePayload,
  compareProviders,
  calculatePeriodPerformance,
  INTELLIGENCE_CATEGORIES,
  INTELLIGENCE_STRUCTURAL_EDGES,
  INTELLIGENCE_THEME_CATALOG,
  MarketDataService,
  normalizeHistoryPoints,
  parseYahooSpark,
  parseYahooThemeHistory,
  quoteFromChart,
  quoteFreshness,
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

test('theme intelligence publishes exactly 50 fixed themes without claiming actual capital flow', () => {
  const payload = applyValidatedEdgeAssociations(buildIntelligencePayload(
    intelligenceHistories(),
    '2026-07-12T00:00:00.000Z'
  ));
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
  let now = Date.parse('2026-07-12T00:00:00Z');
  let fail = false;
  const service = new MarketDataService({
    fetch: async () => { throw new Error('fetch should be replaced'); },
    now: () => now,
    intelligenceTtlMs: 1_000,
    intelligencePartialTtlMs: 1_000,
    intelligenceStaleMs: 60_000
  });
  const histories = intelligenceHistories();
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
  assert.equal(Object.hasOwn(stale, '_internal'), false);
});
