'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { MarketDataService, THEME_CATALOG, normalizeSymbol } = require('./market-data');
const pkg = require('./package.json');

const APP_VERSION = pkg.version;
const DEFAULT_PORT = 10000;
const MAX_SYMBOLS = 40;
const MAX_THEME_IDS = THEME_CATALOG.length;
const SYMBOL_PATTERN = /^[A-Z0-9^][A-Z0-9.^=\/-]{0,19}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;
const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const THEME_IDS = new Set(THEME_CATALOG.map(theme => theme.id));

function secureEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseAllowedOrigins(value) {
  return String(value || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function parseThemeIds(value) {
  if (value === undefined) return { ids: null, invalid: [] };
  if (typeof value !== 'string' || !value.trim() || value.length > 500) {
    return { ids: null, invalid: ['ids'] };
  }
  const parts = value.split(',').map(id => id.trim());
  if (parts.some(id => !id)) return { ids: null, invalid: ['ids'] };
  const ids = [...new Set(parts)];
  const invalid = ids.filter(id => !THEME_ID_PATTERN.test(id) || !THEME_IDS.has(id));
  if (ids.length > MAX_THEME_IDS) invalid.push('too-many-theme-ids');
  return { ids: invalid.length ? null : ids, invalid: [...new Set(invalid)] };
}

function createRateLimiter({ windowMs = 60_000, max = 60, maxBuckets = 2000 } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    if (buckets.size >= maxBuckets && !buckets.has(key)) {
      for (const [bucketKey, value] of buckets) {
        if (now >= value.resetAt) buckets.delete(bucketKey);
      }
      while (buckets.size >= maxBuckets) buckets.delete(buckets.keys().next().value);
    }
    const current = buckets.get(key);
    const bucket = !current || now >= current.resetAt
      ? { count: 0, resetAt: now + windowMs }
      : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.set('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({
        error: 'rate_limited',
        message: 'リクエストが多すぎます。少し待ってから再試行してください。'
      });
    }
    next();
  };
}

function validateConfiguration(env) {
  const protectedFeatures = [];
  if (env.FINNHUB_API_KEY) protectedFeatures.push('FINNHUB_API_KEY');
  if (env.ANTHROPIC_API_KEY) protectedFeatures.push('ANTHROPIC_API_KEY');
  if (protectedFeatures.length && !env.API_TOKEN) {
    throw new Error(`${protectedFeatures.join(' and ')} require API_TOKEN to prevent public quota abuse`);
  }
}

function resolveStaticFiles(rootDir) {
  const publicDir = path.join(rootDir, 'public');
  const publicIndexPath = path.join(publicDir, 'index.html');
  const staticDir = fs.existsSync(publicIndexPath) ? publicDir : rootDir;
  const indexPath = fs.existsSync(publicIndexPath)
    ? publicIndexPath
    : path.join(rootDir, 'index.html');
  return { staticDir, indexPath };
}

function applyMarketResponseHeaders(res, snapshot) {
  const meta = snapshot?.meta || {};
  const status = ['ok', 'partial', 'error'].includes(meta.status) ? meta.status : 'unknown';
  const durationMs = Number.isFinite(Number(meta.durationMs)) ? Math.max(0, Number(meta.durationMs)) : 0;
  const quality = meta.quality || {};
  const safeCount = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const warnings = Math.max(0,
    safeCount(quality.stale) +
    safeCount(quality.aged) +
    safeCount(quality.delayed) +
    safeCount(quality.reference) +
    safeCount(quality.unverified) +
    safeCount(quality.consensusWarnings) +
    safeCount(quality.failed)
  );
  res.set('X-Market-Data-Status', status);
  res.set('X-Market-Data-Warnings', String(warnings));
  res.set('Server-Timing', `market;dur=${durationMs.toFixed(1)}`);
  if (status === 'error') res.set('Retry-After', meta.deadlineExceeded ? '5' : '15');
}

function createApp(options = {}) {
  const app = express();
  const rootDir = options.rootDir || __dirname;
  const { staticDir, indexPath } = resolveStaticFiles(rootDir);
  const env = options.env || process.env;
  validateConfiguration(env);
  const marketData = options.marketData || new MarketDataService({
    fetch: options.fetch,
    finnhubKey: env.FINNHUB_API_KEY || ''
  });
  const fetchImpl = options.fetch || global.fetch;
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    const supplied = String(req.get('X-Request-ID') || '');
    req.requestId = REQUEST_ID_PATTERN.test(supplied) ? supplied : crypto.randomUUID();
    res.set('X-Request-ID', req.requestId);

    // Every JSON response carries the same safe correlation ID as its header,
    // including authentication/rate-limit errors emitted by middleware.
    const sendJson = res.json.bind(res);
    res.json = body => {
      const value = body && typeof body === 'object' && !Array.isArray(body) && !body.requestId
        ? { ...body, requestId: req.requestId }
        : body;
      return sendJson(value);
    };
    res.once('finish', () => {
      if (req.path.startsWith('/api/') && res.statusCode >= 500) {
        console.warn(`[api:${req.requestId}] ${req.method} ${req.path} -> ${res.statusCode}`);
      }
    });
    next();
  });

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
      "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' https:"
    );
    next();
  });

  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (!origin) return next();
    const sameOrigin = origin === `${req.protocol}://${req.get('host')}`;
    const allowAll = allowedOrigins.includes('*');
    if (sameOrigin || allowAll || allowedOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', allowAll ? '*' : origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
      res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });

  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, version: APP_VERSION, uptimeSec: Math.round(process.uptime()) });
  });

  app.use('/api', createRateLimiter({
    max: Number(env.API_GENERAL_RATE_LIMIT_PER_MINUTE) || 60
  }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    next();
  });
  app.use('/api', (req, res, next) => {
    const token = env.API_TOKEN;
    if (!token) return next();
    const authorization = req.get('Authorization') || '';
    if (authorization.startsWith('Bearer ') && secureEqual(authorization.slice(7), token)) return next();
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({
      error: 'unauthorized',
      message: 'APIトークンが一致しません。Renderとアプリ設定を確認してください。'
    });
  });
  app.use('/api', express.json({ limit: '256kb' }));
  app.use('/api', (error, req, res, next) => {
    if (error?.type === 'entity.parse.failed' || (error instanceof SyntaxError && error?.status === 400)) {
      return res.status(400).json({
        error: 'invalid_json',
        message: 'JSONリクエストの形式が正しくありません。'
      });
    }
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({
        error: 'payload_too_large',
        message: 'リクエスト本文が上限を超えています。'
      });
    }
    return next(error);
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      version: APP_VERSION,
      marketData: marketData.status(),
      ai: {
        configured: Boolean(env.ANTHROPIC_API_KEY),
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
      },
      at: new Date().toISOString()
    });
  });

  const quoteRateLimiter = createRateLimiter({
    max: Number(env.QUOTE_RATE_LIMIT_PER_MINUTE || env.API_RATE_LIMIT_PER_MINUTE) || 12
  });
  const themeRateLimiter = createRateLimiter({
    max: Number(env.THEME_RATE_LIMIT_PER_MINUTE) || 18
  });
  const intelligenceRateLimiter = createRateLimiter({
    max: Number(env.INTELLIGENCE_RATE_LIMIT_PER_MINUTE) || 6
  });
  const diagnoseRateLimiter = createRateLimiter({
    max: Number(env.DIAGNOSE_RATE_LIMIT_PER_MINUTE) || 6
  });
  const aiRateLimiter = createRateLimiter({
    max: Number(env.AI_RATE_LIMIT_PER_MINUTE) || 3
  });

  app.get('/api/quotes', quoteRateLimiter, async (req, res) => {
    const raw = String(req.query.symbols || '').split(',');
    const invalid = [];
    const symbols = [];
    for (const value of raw) {
      const symbol = normalizeSymbol(value);
      if (!symbol) continue;
      if (!SYMBOL_PATTERN.test(symbol)) {
        invalid.push(String(value).trim().slice(0, 30));
        continue;
      }
      if (!symbols.includes(symbol) && symbols.length < MAX_SYMBOLS) symbols.push(symbol);
    }

    const requested = [...new Set([...(symbols.length ? symbols : ['SPY']), 'SPY', 'JPY=X'])];
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', close);
    try {
      const snapshot = await marketData.getSnapshot(requested, { signal: controller.signal });
      if (controller.signal.aborted && !res.writableEnded) return;
      const statusCode = snapshot.meta?.status === 'error' ? 503 : 200;
      applyMarketResponseHeaders(res, snapshot);
      res.status(statusCode).json({
        ...snapshot,
        requestedSymbols: symbols,
        invalidSymbols: invalid,
        limits: { maxSymbols: MAX_SYMBOLS }
      });
    } catch (error) {
      if (controller.signal.aborted && !res.writableEnded) return;
      console.error(`[quotes:${req.requestId}] unexpected failure:`, error?.stack || error);
      res.status(502).json({
        error: 'market_data_unavailable',
        message: '市場データサービスに接続できませんでした。',
        at: new Date().toISOString()
      });
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
    }
  });

  app.get('/api/themes', themeRateLimiter, async (req, res) => {
    const parsed = parseThemeIds(req.query.ids);
    if (parsed.invalid.length) {
      return res.status(400).json({
        error: 'invalid_theme_ids',
        message: 'idsには公開テーマIDをカンマ区切りで指定してください。',
        invalidThemeIds: parsed.invalid.slice(0, MAX_THEME_IDS + 1),
        limits: { maxThemeIds: MAX_THEME_IDS },
        allowedThemeIds: [...THEME_IDS]
      });
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', close);
    try {
      const payload = await marketData.getThemes({ ids: parsed.ids, signal: controller.signal });
      if (controller.signal.aborted && !res.writableEnded) return;
      applyMarketResponseHeaders(res, payload);
      return res.status(payload.status === 'unavailable' ? 503 : 200).json(payload);
    } catch (error) {
      if (controller.signal.aborted && !res.writableEnded) return;
      const timedOut = error?.code === 'DEADLINE' || error?.code === 'UPSTREAM_TIMEOUT';
      console.error(`[themes:${req.requestId}] unexpected failure:`, error?.stack || error);
      if (timedOut) res.set('Retry-After', '5');
      return res.status(timedOut ? 504 : 502).json({
        error: timedOut ? 'theme_data_timeout' : 'theme_data_unavailable',
        message: timedOut
          ? 'テーマデータの取得がタイムアウトしました。キャッシュ更新後に再試行してください。'
          : 'テーマデータを取得できませんでした。',
        at: new Date().toISOString()
      });
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
    }
  });

  app.get('/api/theme-intelligence', intelligenceRateLimiter, async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', close);
    try {
      const payload = await marketData.getThemeIntelligence({ signal: controller.signal });
      if (controller.signal.aborted && !res.writableEnded) return;
      applyMarketResponseHeaders(res, payload);
      return res.status(payload.status === 'unavailable' ? 503 : 200).json(payload);
    } catch (error) {
      if (controller.signal.aborted && !res.writableEnded) return;
      const timedOut = error?.code === 'DEADLINE' || error?.code === 'UPSTREAM_TIMEOUT';
      console.error(`[theme-intelligence:${req.requestId}] unexpected failure:`, error?.stack || error);
      if (timedOut) res.set('Retry-After', '5');
      return res.status(timedOut ? 504 : 502).json({
        error: timedOut ? 'theme_intelligence_timeout' : 'theme_intelligence_unavailable',
        message: timedOut
          ? '市場テーマOSの取得がタイムアウトしました。キャッシュ更新後に再試行してください。'
          : '市場テーマOSを取得できませんでした。',
        at: new Date().toISOString()
      });
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
    }
  });

  app.get('/api/diagnose', diagnoseRateLimiter, async (req, res) => {
    const symbols = String(req.query.symbols || 'JMIA,SPY')
      .split(',')
      .map(normalizeSymbol)
      .filter(symbol => SYMBOL_PATTERN.test(symbol))
      .slice(0, 5);
    const requested = [...new Set([...symbols, 'JPY=X'])];
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', close);
    try {
      const snapshot = await marketData.getSnapshot(requested, { signal: controller.signal });
      if (controller.signal.aborted && !res.writableEnded) return;
      applyMarketResponseHeaders(res, snapshot);
      res.status(snapshot.meta.status === 'error' ? 503 : 200)
        .json({ ok: snapshot.meta.status !== 'error', snapshot, service: marketData.status() });
    } catch (error) {
      if (controller.signal.aborted && !res.writableEnded) return;
      console.error(`[diagnose:${req.requestId}] unexpected failure:`, error?.stack || error);
      res.status(502).json({ ok: false, error: 'diagnose_failed', message: String(error?.message || error) });
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
    }
  });

  app.get('/api/ai-status', (req, res) => {
    res.json({
      server: Boolean(env.ANTHROPIC_API_KEY),
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
    });
  });

  app.post('/api/ai-analyze', aiRateLimiter, async (req, res) => {
    if (!env.ANTHROPIC_API_KEY) {
      return res.status(503).json({
        error: 'ai_not_configured',
        message: 'RenderにANTHROPIC_API_KEYを設定するとAI直結を利用できます。'
      });
    }
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt || prompt.length > 50_000) {
      return res.status(400).json({ error: 'invalid_prompt', message: 'promptは1〜50,000文字で指定してください。' });
    }

    const controller = new AbortController();
    let timedOut = false;
    let clientCancelled = false;
    const cancel = () => { clientCancelled = true; controller.abort(); };
    const close = () => { if (!res.writableEnded) cancel(); };
    req.once('aborted', cancel);
    res.once('close', close);
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 115_000);
    try {
      const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
          max_tokens: 4500,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error(`[ai:${req.requestId}] upstream failure:`, response.status, payload?.error?.type || 'unknown');
        return res.status(502).json({
          error: 'ai_upstream_error',
          message: payload?.error?.message || `AI API returned HTTP ${response.status}`
        });
      }
      const text = (payload.content || [])
        .filter(block => block?.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();
      if (!text) return res.status(502).json({ error: 'ai_empty_response' });
      return res.json({ text, model: payload.model || env.ANTHROPIC_MODEL || 'claude-sonnet-4-6' });
    } catch (error) {
      if (clientCancelled && !res.writableEnded) return;
      const requestTimedOut = timedOut && error?.name === 'AbortError';
      return res.status(502).json({
        error: requestTimedOut ? 'ai_timeout' : 'ai_request_failed',
        message: requestTimedOut ? 'AI応答がタイムアウトしました。' : String(error?.message || error)
      });
    } finally {
      clearTimeout(timer);
      req.removeListener('aborted', cancel);
      res.removeListener('close', close);
    }
  });

  app.use('/api', (error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error(`[api:${req.requestId}] internal error:`, error?.stack || error);
    return res.status(500).json({
      error: 'internal_error',
      message: 'サーバー内部でエラーが発生しました。'
    });
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'api_not_found' });
  });

  const sendAsset = (filename, cacheControl) => (req, res, next) => {
    const filePath = path.join(staticDir, filename);
    if (!fs.existsSync(filePath)) return next();
    res.set('Cache-Control', cacheControl);
    return res.sendFile(filePath);
  };

  app.get('/sw.js', sendAsset('sw.js', 'no-cache, no-store, must-revalidate'));
  app.get('/manifest.json', sendAsset('manifest.json', 'public, max-age=3600'));
  app.get('/icon-192.png', sendAsset('icon-192.png', 'public, max-age=604800, immutable'));
  app.get('/icon-512.png', sendAsset('icon-512.png', 'public, max-age=604800, immutable'));
  app.get('/og-v12.png', sendAsset('og-v12.png', 'public, max-age=604800, immutable'));
  app.get('/og.png', sendAsset('og.png', 'public, max-age=604800, immutable'));
  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

  const sendIndex = (req, res) => {
    if (!fs.existsSync(indexPath)) {
      return res.status(500).json({ error: 'index_not_found' });
    }
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(indexPath);
  };
  app.get(['/', '/index.html'], sendIndex);
  app.get('*', sendIndex);

  return { app, marketData, staticDir, indexPath };
}

function startServer(options = {}) {
  const port = Number(options.port || process.env.PORT) || DEFAULT_PORT;
  const created = createApp(options);
  const server = created.app.listen(port, '0.0.0.0', () => {
    console.log(`US COMMAND ULTRA v${APP_VERSION} -> http://0.0.0.0:${port}`);
  });

  const shutdown = signal => {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(error => {
      if (error) {
        console.error('[server] shutdown error:', error);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return { ...created, server };
}

if (require.main === module) startServer();

module.exports = {
  APP_VERSION,
  MAX_SYMBOLS,
  MAX_THEME_IDS,
  SYMBOL_PATTERN,
  createApp,
  createRateLimiter,
  parseThemeIds,
  secureEqual,
  startServer,
  validateConfiguration
};
