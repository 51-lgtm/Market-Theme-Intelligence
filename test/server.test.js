'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, validateConfiguration } = require('../server');

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

    const preview = await fetch(`${base}/og-v12.png`, { method: 'HEAD' });
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
