'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { MarketDataService, THEME_CATALOG, normalizeSymbol } = require('./market-data');
const pkg = require('./package.json');
const { astraEvidence } = require('./astra-bridge');

const APP_VERSION = pkg.version;
const DEFAULT_PORT = 10000;
const MAX_SYMBOLS = 40;
const MAX_TECHNICAL_SYMBOLS = 20;
const MAX_THEME_IDS = THEME_CATALOG.length;
const DEFAULT_SIGNAL_SYMBOLS = Object.freeze([
  'SPY', 'QQQ', 'SOXX', 'MU', 'SNDK',
  'NVDA', 'VRT', 'ANET', 'RKLB', 'JMIA', 'POET'
]);
const DEFAULT_BACKTEST_SYMBOLS = Object.freeze([
  'SPY', 'QQQ', 'SOXX', 'SOXL', 'MU', 'SNDK',
  'NVDA', 'VRT', 'ANET', 'RKLB', 'JMIA', 'POET'
]);
const DEFAULT_TECHNICAL_SYMBOLS = DEFAULT_SIGNAL_SYMBOLS;
const SIMULATION_EXECUTION = Object.freeze({
  mode: 'SIMULATE',
  autoOrder: false,
  tradingConnected: false,
  tradeEligible: false
});
const KNOWN_LEVERAGED_PRODUCTS = new Set([
  'SOXL', 'SOXS', 'TQQQ', 'SQQQ', 'UPRO', 'SPXU', 'SPXL',
  'QLD', 'QID', 'SSO', 'SDS', 'TECL', 'TECS', 'FAS', 'FAZ',
  'TNA', 'TZA', 'LABU', 'LABD', 'NUGT', 'DUST', 'BOIL', 'KOLD',
  'TMF', 'TBT', 'BITX', 'CONL', 'NVDL', 'NVDU', 'TSLL', 'MSTU',
  'MSTZ', 'MUU'
]);
const SYMBOL_PATTERN = /^[A-Z0-9^][A-Z0-9.^=\/-]{0,19}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;
const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const THEME_IDS = new Set(THEME_CATALOG.map(theme => theme.id));

function secureEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Never log upstream messages/stacks: URLs and provider errors can contain keys.
function safeErrorKind(error) {
  const known = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError']);
  return known.has(error?.name) ? error.name : 'Error';
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

function parseTechnicalSymbols(value, defaults = DEFAULT_SIGNAL_SYMBOLS) {
  if (value === undefined || value === null || value === '') {
    return { symbols: [...defaults], invalid: [] };
  }
  const raw = Array.isArray(value) ? value : String(value).split(',');
  if (raw.length > MAX_TECHNICAL_SYMBOLS) {
    return { symbols: null, invalid: ['too-many-symbols'] };
  }
  const symbols = [];
  const invalid = [];
  for (const entry of raw) {
    const symbol = normalizeSymbol(entry);
    if (!symbol || !SYMBOL_PATTERN.test(symbol)) {
      invalid.push(String(entry ?? '').trim().slice(0, 30) || 'empty');
      continue;
    }
    if (!symbols.includes(symbol)) symbols.push(symbol);
  }
  if (!symbols.length) invalid.push('symbols');
  return {
    symbols: invalid.length ? null : symbols,
    invalid: [...new Set(invalid)]
  };
}

function boundedNumber(value, min, max, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean' || typeof value === 'object') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function parseSimulationAccount(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    mode: 'SIMULATE',
    equityJpy: boundedNumber(source.equityJpy, 0, 1e15),
    cashJpy: boundedNumber(source.cashJpy, 0, 1e15),
    usdJpy: boundedNumber(source.usdJpy, 0.01, 10_000),
    riskBudgetJpy: boundedNumber(source.riskBudgetJpy, 0, 1e15),
    existingOpenRiskJpy: boundedNumber(source.existingOpenRiskJpy, 0, 1e15, 0),
    existingTickerValueJpy: boundedNumber(source.existingTickerValueJpy, 0, 1e15, 0),
    maxPositionPct: boundedNumber(source.maxPositionPct, 0.1, 100, 10),
    slippageBufferPct: boundedNumber(source.slippageBufferPct, 0, 25, 2)
  };
}

function validateSimulationAccount(value) {
  if (value === undefined || value === null) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['account'];
  const ranges = {
    equityJpy: [0, 1e15],
    cashJpy: [0, 1e15],
    usdJpy: [0.01, 10_000],
    riskBudgetJpy: [0, 1e15],
    existingOpenRiskJpy: [0, 1e15],
    existingTickerValueJpy: [0, 1e15],
    maxPositionPct: [0.1, 100],
    slippageBufferPct: [0, 25]
  };
  const invalid = [];
  if (value.mode !== undefined && value.mode !== 'SIMULATE') invalid.push('mode');
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (value[key] === undefined || value[key] === null || value[key] === '') continue;
    if (typeof value[key] === 'boolean' || typeof value[key] === 'object') {
      invalid.push(key);
      continue;
    }
    const number = Number(value[key]);
    if (!Number.isFinite(number) || number < min || number > max) invalid.push(key);
  }
  const equity = boundedNumber(value.equityJpy, 0, 1e15);
  const cash = boundedNumber(value.cashJpy, 0, 1e15);
  const risk = boundedNumber(value.riskBudgetJpy, 0, 1e15);
  if (equity !== null && cash !== null && cash > equity) invalid.push('cashJpy>equityJpy');
  if (equity !== null && risk !== null && risk > equity) invalid.push('riskBudgetJpy>equityJpy');
  return [...new Set(invalid)];
}

function parseSimulationPositions(value, allowedSymbols = []) {
  if (value === undefined || value === null) return { positions: [], invalid: [] };
  if (!Array.isArray(value) || value.length > MAX_TECHNICAL_SYMBOLS) {
    return { positions: [], invalid: ['positions'] };
  }
  const allowed = new Set(Array.isArray(allowedSymbols) ? allowedSymbols : []);
  const positions = [];
  const invalid = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const source = value[index];
    const prefix = `positions[${index}]`;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      invalid.push(prefix);
      continue;
    }
    const symbol = normalizeSymbol(source.symbol || source.ticker);
    const shares = boundedNumber(source.shares, 0.000001, 1e12);
    const price = boundedNumber(source.price, 0.000001, 1e9);
    const averageCost = boundedNumber(source.avgCost, 0.000001, 1e9);
    const stop = boundedNumber(source.stop, 0.000001, 1e9);
    const take = boundedNumber(source.take, 0.000001, 1e9);
    const currency = String(source.currency || 'USD').trim().toUpperCase();
    if (!symbol || !SYMBOL_PATTERN.test(symbol) || !allowed.has(symbol) || seen.has(symbol)) {
      invalid.push(`${prefix}.symbol`);
      continue;
    }
    if (shares === null) invalid.push(`${prefix}.shares`);
    if (price === null) invalid.push(`${prefix}.price`);
    if (averageCost === null) invalid.push(`${prefix}.avgCost`);
    if (stop === null || (price !== null && stop >= price)) invalid.push(`${prefix}.stop`);
    if (source.take !== undefined && source.take !== null && source.take !== '' && take === null) {
      invalid.push(`${prefix}.take`);
    }
    if (currency !== 'USD') invalid.push(`${prefix}.currency`);
    if (invalid.some(item => item.startsWith(`${prefix}.`))) continue;
    seen.add(symbol);
    positions.push({
      symbol,
      shares,
      avgCost: averageCost,
      price,
      stop,
      take,
      currency: 'USD',
      role: source.role === 'core' ? 'core' : 'trade'
    });
  }
  return { positions, invalid: [...new Set(invalid)] };
}

function parseUnverifiedSignalContext(value, allowedSymbols = null) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const allowed = Array.isArray(allowedSymbols) ? new Set(allowedSymbols) : null;
  const events = Array.isArray(source.events) ? source.events : [];
  const news = Array.isArray(source.news) ? source.news : [];
  return {
    verified: false,
    events: events.slice(0, 50).flatMap(entry => {
      const ticker = normalizeSymbol(entry?.ticker);
      const date = String(entry?.date || '').slice(0, 10);
      const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
      const validDate = parsedDate && Number.isFinite(parsedDate.getTime()) &&
        parsedDate.toISOString().slice(0, 10) === date;
      if (!ticker || !SYMBOL_PATTERN.test(ticker) || !validDate || (allowed && !allowed.has(ticker))) return [];
      return [{ ticker, date, label: String(entry?.label || '').slice(0, 300) }];
    }),
    news: news.slice(0, 50).flatMap(entry => {
      const ticker = normalizeSymbol(entry?.ticker || entry?.t);
      if (!ticker || !SYMBOL_PATTERN.test(ticker) || (allowed && !allowed.has(ticker))) return [];
      return [{
        ticker,
        headline: String(entry?.headline || entry?.h || '').slice(0, 500),
        source: String(entry?.source || entry?.src || '').slice(0, 100),
        at: String(entry?.at || entry?.date || entry?.d || '').slice(0, 64)
      }];
    })
  };
}

function stripPrivateSignalFields(value, depth = 0) {
  if (depth > 16) return null;
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 2000).map(entry => stripPrivateSignalFields(entry, depth + 1));
  if (typeof value !== 'object') return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (
      key.startsWith('_') ||
      normalizedKey.startsWith('order') ||
      normalizedKey.includes('apikey') ||
      normalizedKey.includes('apitoken') ||
      normalizedKey.includes('accesstoken') ||
      normalizedKey.includes('refreshtoken') ||
      normalizedKey.includes('authorization') ||
      normalizedKey.includes('clientsecret') ||
      normalizedKey.includes('privatekey') ||
      normalizedKey.includes('password') ||
      normalizedKey.includes('cookie') ||
      normalizedKey === 'secret' ||
      normalizedKey.includes('brokeraccount')
    ) continue;
    output[key] = stripPrivateSignalFields(entry, depth + 1);
  }
  return output;
}

function enforceSimulationEnvelope(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const clean = stripPrivateSignalFields(source);
  const allowedResultFields = new Set([
    'symbol', 'ticker', 'status', 'dataStatus', 'stale', 'available', 'active',
    'asOf', 'price', 'score', 'baseScore', 'decision', 'recommendation',
    'signals', 'signalsList', 'scoreBreakdown', 'deductions', 'caps',
    'indicators', 'technical', 'theme', 'fundamental', 'earningsDays',
    'earningsBlocked', 'quality', 'riskReward', 'riskRewardDetail',
    'positionPlan', 'leveragedProduct', 'leverageStatus', 'leverageBlocked',
    'chaseBlocked', 'reasons', 'warnings', 'provenance', 'backtest'
  ]);
  let status = ['ok', 'partial', 'unavailable'].includes(clean.status)
    ? clean.status
    : 'unavailable';
  const results = (Array.isArray(clean.results) ? clean.results : [])
    .slice(0, MAX_TECHNICAL_SYMBOLS)
    .map(entry => {
      const rawResult = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
      const result = Object.fromEntries(
        Object.entries(rawResult).filter(([key]) => allowedResultFields.has(key))
      );
      const ticker = normalizeSymbol(result.ticker || result.symbol);
      if (!ticker || !SYMBOL_PATTERN.test(ticker)) return null;
      const leveragedProduct = result.leveragedProduct === true ||
        KNOWN_LEVERAGED_PRODUCTS.has(ticker);
      const leverageStatus = ['leveraged', 'unleveraged', 'unavailable'].includes(result.leverageStatus)
        ? result.leverageStatus
        : (leveragedProduct ? 'leveraged' : 'unavailable');
      const leverageBlocked = leveragedProduct ||
        result.leverageBlocked === true ||
        rawResult.restrictions?.leverageBlocked === true ||
        leverageStatus === 'unavailable';
      const chaseBlocked = result.chaseBlocked === true ||
        rawResult.highChaseBlocked === true ||
        rawResult.chase?.blocked === true ||
        rawResult.highPriceChase?.blocked === true ||
        rawResult.restrictions?.chaseBlocked === true;
      const riskReward = boundedNumber(
        result.riskReward?.ratio ??
          result.riskReward?.value ??
          result.riskReward ??
          result.riskRewardDetail?.ratio ??
          result.positionPlan?.riskReward,
        0,
        1e6
      );
      const riskRewardPassed = riskReward !== null && riskReward >= 1.8;
      const earningsDays = boundedNumber(
        result.earningsDays ??
          rawResult.daysToEarnings ??
          result.fundamental?.earningsDays ??
          result.fundamental?.daysToEarnings ??
          rawResult.earnings?.days,
        -10_000,
        10_000
      );
      const earningsBlocked = result.earningsBlocked === true ||
        rawResult.restrictions?.earningsBlocked === true ||
        (earningsDays !== null && earningsDays >= 0 && earningsDays <= 3);
      const dataStatus = String(result.dataStatus || result.status || '').toLowerCase();
      const stale = result.stale === true || result.quality?.stale === true ||
        dataStatus === 'stale';
      const insufficient = result.quality?.sufficient === false ||
        result.available === false ||
        dataStatus === 'unavailable';
      const mustCapAtCheck = leverageBlocked || chaseBlocked ||
        !riskRewardPassed || earningsBlocked;
      const decision = ['strong_buy_watch', 'buy_watch', 'check', 'wait', 'avoid', 'unavailable']
        .includes(result.decision) ? result.decision : 'unavailable';
      let safeDecision = mustCapAtCheck && ['strong_buy_watch', 'buy_watch'].includes(decision)
        ? 'check'
        : decision;
      if (stale && ['strong_buy_watch', 'buy_watch', 'check'].includes(safeDecision)) {
        safeDecision = 'wait';
      }
      if (insufficient) safeDecision = 'unavailable';
      const planBlocked = leverageBlocked || chaseBlocked || !riskRewardPassed ||
        stale || insufficient || earningsBlocked;
      const safePlan = result.positionPlan && typeof result.positionPlan === 'object'
        ? { ...result.positionPlan }
        : null;
      if (safePlan && planBlocked) {
        safePlan.available = false;
        safePlan.amount = 0;
        safePlan.amountJpy = 0;
        safePlan.amountUsd = 0;
        safePlan.shares = 0;
        safePlan.reason = leverageBlocked
          ? 'レバレッジ属性を安全に確認できない商品は新規・買い増し候補にしません。'
          : (stale || insufficient
              ? '価格履歴の品質が不足しているため株数を算出しません。'
              : '安全ゲート未達のため新規株数を0に制限します。');
      }
      return {
        ...result,
        ticker,
        symbol: ticker,
        decision: safeDecision,
        recommendation: safeDecision,
        leveragedProduct,
        leverageStatus,
        leverageBlocked,
        chaseBlocked,
        earningsBlocked,
        active: result.active === true &&
          ['strong_buy_watch', 'buy_watch'].includes(safeDecision) &&
          !planBlocked,
        positionPlan: safePlan
          ? { ...safePlan, mode: 'SIMULATE', tradeEligible: false }
          : null,
        execution: { ...SIMULATION_EXECUTION },
        tradeEligible: false
      };
    })
    .filter(Boolean);
  const unavailableResults = results.filter(result =>
    result.dataStatus === 'unavailable' || result.status === 'unavailable'
  ).length;
  if (!results.length || unavailableResults === results.length) status = 'unavailable';
  else if (status === 'ok' && results.some(result =>
    ['partial', 'stale', 'unavailable'].includes(result.dataStatus || result.status)
  )) status = 'partial';
  return {
    asOf: clean.asOf || null,
    updatedAt: clean.updatedAt || null,
    methodology: clean.methodology || null,
    status,
    results,
    meta: {
      ...(clean.meta && typeof clean.meta === 'object' ? clean.meta : {}),
      status: status === 'unavailable' ? 'error' : status
    },
    execution: { ...SIMULATION_EXECUTION },
    tradeEligible: false,
    orders: undefined
  };
}

function createRateLimiter({ windowMs = 60_000, max = 60, maxBuckets = 2000 } = {}) {
  const safeWindowMs = Number.isFinite(Number(windowMs))
    ? Math.min(60 * 60 * 1000, Math.max(1_000, Math.floor(Number(windowMs))))
    : 60_000;
  const safeMax = Number.isFinite(Number(max))
    ? Math.min(10_000, Math.max(1, Math.floor(Number(max))))
    : 60;
  const safeMaxBuckets = Number.isFinite(Number(maxBuckets))
    ? Math.min(50_000, Math.max(10, Math.floor(Number(maxBuckets))))
    : 2_000;
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    if (buckets.size >= safeMaxBuckets && !buckets.has(key)) {
      for (const [bucketKey, value] of buckets) {
        if (now >= value.resetAt) buckets.delete(bucketKey);
      }
      while (buckets.size >= safeMaxBuckets) buckets.delete(buckets.keys().next().value);
    }
    const current = buckets.get(key);
    const bucket = !current || now >= current.resetAt
      ? { count: 0, resetAt: now + safeWindowMs }
      : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    res.set('RateLimit-Limit', String(safeMax));
    res.set('RateLimit-Remaining', String(Math.max(0, safeMax - bucket.count)));
    res.set('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > safeMax) {
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
  const marketRegimeRateLimiter = createRateLimiter({
    max: Number(env.MARKET_REGIME_RATE_LIMIT_PER_MINUTE) || 12
  });
  const technicalSignalRateLimiter = createRateLimiter({
    max: Number(env.TECHNICAL_SIGNAL_RATE_LIMIT_PER_MINUTE) || 6
  });
  const technicalBacktestRateLimiter = createRateLimiter({
    max: Number(env.TECHNICAL_BACKTEST_RATE_LIMIT_PER_MINUTE) || 2
  });
  const technicalSignalTimeoutMs = Math.min(120_000, Math.max(
    5_000,
    Number(env.TECHNICAL_SIGNAL_ROUTE_TIMEOUT_MS) || 35_000
  ));
  const technicalBacktestTimeoutMs = Math.min(180_000, Math.max(
    10_000,
    Number(env.TECHNICAL_BACKTEST_ROUTE_TIMEOUT_MS) || 75_000
  ));
  const technicalBacktestConcurrency = Math.min(2, Math.max(
    1,
    Math.floor(Number(env.TECHNICAL_BACKTEST_MAX_CONCURRENCY) || 1)
  ));
  const technicalSignalConcurrency = Math.min(8, Math.max(
    1,
    Math.floor(Number(env.TECHNICAL_SIGNAL_MAX_CONCURRENCY) || 3)
  ));
  let activeTechnicalSignals = 0;
  let activeTechnicalBacktests = 0;
  const diagnoseRateLimiter = createRateLimiter({
    max: Number(env.DIAGNOSE_RATE_LIMIT_PER_MINUTE) || 6
  });
  const aiRateLimiter = createRateLimiter({
    max: Number(env.AI_RATE_LIMIT_PER_MINUTE) || 3
  });

  let astraBridgeFlight = null;
  const astraBridgeLimiter = createRateLimiter({ max: 4 });
  app.get('/api/astra-evidence', astraBridgeLimiter, async (req, res) => {
    const parsed = parseTechnicalSymbols(req.query.symbols);
    if (parsed.invalid.length) return res.status(400).json({ error: 'invalid_symbols' });
    if (astraBridgeFlight) return res.status(429).json({ error: 'evidence_refresh_busy' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 65000);
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', close);
    astraBridgeFlight = controller;
    try {
      const deadline = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true }));
      const result = await Promise.race([astraEvidence(marketData, parsed.symbols, controller.signal), deadline]);
      if (!res.destroyed) res.json(result);
    } catch {
      if (!res.destroyed) res.status(503).json({ status: 'unavailable', error: 'evidence_unavailable' });
    } finally {
      clearTimeout(timeout);
      res.removeListener('close', close);
      astraBridgeFlight = null;
    }
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
      console.error(`[quotes:${req.requestId}] unexpected failure:`, safeErrorKind(error));
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
      console.error(`[themes:${req.requestId}] unexpected failure:`, safeErrorKind(error));
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
      console.error(`[theme-intelligence:${req.requestId}] unexpected failure:`, safeErrorKind(error));
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

  app.get('/api/market-regime', marketRegimeRateLimiter, async (req, res) => {
    const forceRefresh = ['1', 'true'].includes(String(req.query.refresh || '').trim().toLowerCase());
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', close);
    try {
      const payload = await marketData.getMarketRegime({
        signal: controller.signal,
        forceRefresh
      });
      if (controller.signal.aborted && !res.writableEnded) return;
      applyMarketResponseHeaders(res, payload);
      return res.status(payload.status === 'unavailable' ? 503 : 200).json(payload);
    } catch (error) {
      if (controller.signal.aborted && !res.writableEnded) return;
      const timedOut = error?.code === 'DEADLINE' || error?.code === 'UPSTREAM_TIMEOUT';
      console.error(`[market-regime:${req.requestId}] unexpected failure:`, safeErrorKind(error));
      if (timedOut) res.set('Retry-After', '5');
      return res.status(timedOut ? 504 : 502).json({
        error: timedOut ? 'market_regime_timeout' : 'market_regime_unavailable',
        message: timedOut
          ? 'VIX・原油・SPYデータの取得がタイムアウトしました。'
          : 'VIX・原油・SPYデータを取得できませんでした。',
        at: new Date().toISOString()
      });
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
    }
  });

  const technicalSignalHandler = async (req, res) => {
    if (req.method === 'POST' && !req.is('application/json')) {
      return res.status(415).json({ error: 'content_type_must_be_application_json' });
    }
    const input = req.method === 'POST' ? req.body : req.query;
    if (req.method === 'POST' && input?.symbols === undefined) {
      return res.status(400).json({ error: 'symbols_required' });
    }
    const parsed = parseTechnicalSymbols(input?.symbols);
    if (parsed.invalid.length) {
      return res.status(400).json({
        error: 'invalid_signal_symbols',
        invalidSymbols: parsed.invalid,
        limits: { maxSymbols: MAX_TECHNICAL_SYMBOLS }
      });
    }
    const invalidAccount = validateSimulationAccount(input?.account);
    const parsedPositions = parseSimulationPositions(input?.positions, parsed.symbols);
    if (invalidAccount.length || parsedPositions.invalid.length) {
      return res.status(400).json({
        error: 'invalid_simulation_account',
        invalidFields: [...invalidAccount, ...parsedPositions.invalid]
      });
    }
    if (activeTechnicalSignals >= technicalSignalConcurrency) {
      res.set('Retry-After', '5');
      return res.status(429).json({
        error: 'technical_signal_busy',
        message: 'テクニカルシグナルを同時処理中です。少し待って再試行してください。'
      });
    }
    activeTechnicalSignals += 1;
    const forceRefresh = ['1', 'true'].includes(String(input?.refresh || '').trim().toLowerCase());
    const controller = new AbortController();
    let clientCancelled = false;
    let timedOut = false;
    let rejectClientCancellation = () => {};
    const clientCancellation = new Promise((resolve, reject) => {
      rejectClientCancellation = reject;
    });
    const abort = () => {
      clientCancelled = true;
      controller.abort();
      const error = new Error('technical signal client disconnected');
      error.code = 'CLIENT_ABORT';
      rejectClientCancellation(error);
    };
    const close = () => { if (!res.writableEnded) abort(); };
    let deadlineTimer;
    req.once('aborted', abort);
    res.once('close', close);
    try {
      const deadline = new Promise((resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          const error = new Error('technical signal route deadline exceeded');
          error.code = 'DEADLINE';
          reject(error);
        }, technicalSignalTimeoutMs);
      });
      const work = Promise.resolve().then(() => marketData.getBuySignals({
          symbols: parsed.symbols,
          account: parseSimulationAccount(input?.account),
          positions: parsedPositions.positions,
          unverifiedContext: parseUnverifiedSignalContext(input?.context, parsed.symbols),
          forceRefresh,
          signal: controller.signal
        }));
      const payload = enforceSimulationEnvelope(await Promise.race([
        work,
        deadline,
        clientCancellation
      ]));
      clearTimeout(deadlineTimer);
      if (clientCancelled && !res.writableEnded) return;
      applyMarketResponseHeaders(res, payload);
      return res.status(payload.status === 'unavailable' ? 503 : 200).json(payload);
    } catch (error) {
      if (clientCancelled && !res.writableEnded) return;
      const requestTimedOut = timedOut || error?.code === 'DEADLINE' || error?.code === 'UPSTREAM_TIMEOUT';
      console.error(`[buy-signals:${req.requestId}] unexpected failure:`, safeErrorKind(error));
      if (requestTimedOut) res.set('Retry-After', '5');
      return res.status(requestTimedOut ? 504 : 502).json({
        error: requestTimedOut ? 'technical_signal_timeout' : 'technical_signal_unavailable',
        message: requestTimedOut
          ? 'テクニカルシグナルの取得がタイムアウトしました。少し待って再試行してください。'
          : 'テクニカルシグナルを取得できませんでした。',
        at: new Date().toISOString()
      });
    } finally {
      clearTimeout(deadlineTimer);
      activeTechnicalSignals = Math.max(0, activeTechnicalSignals - 1);
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
    }
  };
  app.get('/api/buy-signals', technicalSignalRateLimiter, technicalSignalHandler);
  app.post('/api/buy-signals', technicalSignalRateLimiter, technicalSignalHandler);

  app.get('/api/buy-signals/backtest', technicalBacktestRateLimiter, async (req, res) => {
    const parsed = parseTechnicalSymbols(req.query.symbols, DEFAULT_BACKTEST_SYMBOLS);
    const commissionBps = req.query.commissionBps === undefined
      ? 0
      : boundedNumber(req.query.commissionBps, 0, 500);
    const slippageBps = req.query.slippageBps === undefined
      ? 10
      : boundedNumber(req.query.slippageBps, 0, 500);
    if (parsed.invalid.length || commissionBps === null || slippageBps === null) {
      return res.status(400).json({
        error: 'invalid_backtest_parameters',
        invalidSymbols: parsed.invalid,
        limits: {
          maxSymbols: MAX_TECHNICAL_SYMBOLS,
          commissionBps: [0, 500],
          slippageBps: [0, 500]
        }
      });
    }
    if (activeTechnicalBacktests >= technicalBacktestConcurrency) {
      res.set('Retry-After', '15');
      return res.status(429).json({
        error: 'technical_backtest_busy',
        message: 'バックテストを実行中です。完了後に再試行してください。'
      });
    }
    activeTechnicalBacktests += 1;
    const forceRefresh = ['1', 'true'].includes(String(req.query.refresh || '').trim().toLowerCase());
    const controller = new AbortController();
    let clientCancelled = false;
    let timedOut = false;
    let rejectClientCancellation = () => {};
    const clientCancellation = new Promise((resolve, reject) => {
      rejectClientCancellation = reject;
    });
    const abort = () => {
      clientCancelled = true;
      controller.abort();
      const error = new Error('technical backtest client disconnected');
      error.code = 'CLIENT_ABORT';
      rejectClientCancellation(error);
    };
    const close = () => { if (!res.writableEnded) abort(); };
    let deadlineTimer;
    req.once('aborted', abort);
    res.once('close', close);
    try {
      const deadline = new Promise((resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          const error = new Error('technical backtest route deadline exceeded');
          error.code = 'DEADLINE';
          reject(error);
        }, technicalBacktestTimeoutMs);
      });
      const work = Promise.resolve().then(() => marketData.getTechnicalBacktest({
          symbols: parsed.symbols,
          commissionBps,
          slippageBps,
          forceRefresh,
          signal: controller.signal
        }));
      const payload = enforceSimulationEnvelope(await Promise.race([
        work,
        deadline,
        clientCancellation
      ]));
      clearTimeout(deadlineTimer);
      if (clientCancelled && !res.writableEnded) return;
      applyMarketResponseHeaders(res, payload);
      return res.status(payload.status === 'unavailable' ? 503 : 200).json(payload);
    } catch (error) {
      if (clientCancelled && !res.writableEnded) return;
      const requestTimedOut = timedOut || error?.code === 'DEADLINE' || error?.code === 'UPSTREAM_TIMEOUT';
      console.error(`[technical-backtest:${req.requestId}] unexpected failure:`, safeErrorKind(error));
      if (requestTimedOut) res.set('Retry-After', '10');
      return res.status(requestTimedOut ? 504 : 502).json({
        error: requestTimedOut ? 'technical_backtest_timeout' : 'technical_backtest_unavailable',
        message: requestTimedOut
          ? 'バックテストの取得がタイムアウトしました。少し待って再試行してください。'
          : 'バックテストを実行できませんでした。',
        at: new Date().toISOString()
      });
    } finally {
      clearTimeout(deadlineTimer);
      activeTechnicalBacktests = Math.max(0, activeTechnicalBacktests - 1);
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
      console.error(`[diagnose:${req.requestId}] unexpected failure:`, safeErrorKind(error));
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
        console.error(`[ai:${req.requestId}] upstream failure:`, response.status);
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
    console.error(`[api:${req.requestId}] internal error:`, safeErrorKind(error));
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
  app.get('/og-v14-technical-signals.png', sendAsset('og-v14-technical-signals.png', 'public, max-age=604800, immutable'));
  app.get('/og-v13-1-rrg.png', sendAsset('og-v13-1-rrg.png', 'public, max-age=604800, immutable'));
  app.get('/og-v13-2-market-regime.png', sendAsset('og-v13-2-market-regime.png', 'public, max-age=604800, immutable'));
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
  const host = options.host || process.env.HOST || '0.0.0.0';
  const server = created.app.listen(port, host, () => {
    console.log(`US COMMAND ULTRA v${APP_VERSION} -> http://${host}:${port}`);
  });

  const shutdown = signal => {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(error => {
      if (error) {
        console.error('[server] shutdown error:', safeErrorKind(error));
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
  DEFAULT_BACKTEST_SYMBOLS,
  DEFAULT_SIGNAL_SYMBOLS,
  DEFAULT_TECHNICAL_SYMBOLS,
  MAX_SYMBOLS,
  MAX_TECHNICAL_SYMBOLS,
  MAX_THEME_IDS,
  KNOWN_LEVERAGED_PRODUCTS,
  SYMBOL_PATTERN,
  boundedNumber,
  createApp,
  createRateLimiter,
  enforceSimulationEnvelope,
  parseSimulationAccount,
  parseSimulationPositions,
  parseTechnicalSymbols,
  parseThemeIds,
  parseUnverifiedSignalContext,
  secureEqual,
  safeErrorKind,
  startServer,
  validateSimulationAccount,
  validateConfiguration
};
