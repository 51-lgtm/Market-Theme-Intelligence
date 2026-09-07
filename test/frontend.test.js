'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const functionBlock = (startName, nextName) => {
  const start = html.indexOf(`function ${startName}(`);
  const end = html.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `${startName} source should be present`);
  return html.slice(start, end);
};
const migrationBlock = () => {
  const seedStart = html.indexOf('const SEED =');
  const seedEnd = html.indexOf('/* ============ STORAGE', seedStart);
  const migrateStart = html.indexOf('const cloneSeed=');
  const migrateEnd = html.indexOf('function recoveryRead()', migrateStart);
  assert.ok(seedStart >= 0 && seedEnd > seedStart && migrateStart >= 0 && migrateEnd > migrateStart);
  return `${html.slice(seedStart, seedEnd)}\n${html.slice(migrateStart, migrateEnd)}`;
};
const concurrentMergeBlock = () => {
  const start = html.indexOf('const stateClone=');
  const end = html.indexOf("let S,bootRecoveryStatus=''", start);
  assert.ok(start >= 0 && end > start, 'concurrent merge source should be present');
  return html.slice(start, end);
};

test('inline application JavaScript parses successfully', () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: 'index-inline.js' }));
  assert.doesNotMatch(html, /user-scalable=no/);
  assert.doesNotMatch(html, /fetch\('https:\/\/api\.anthropic\.com/);
  assert.match(html, /DATA CONNECTION/);
  assert.match(html, /一部同期/);
  assert.match(html, /\.offline\{[^}]*visibility:hidden/);
  assert.match(html, /lastResponseAt/);
  assert.match(html, /古いキャッシュ/);
  assert.match(html, /safeStateId/);
});

test('v14 keeps prior risk controls and remains v3-storage compatible', () => {
  assert.match(html, /PORTFOLIO X-RAY/);
  assert.match(html, /id="portfolio-xray"/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /STRESS LAB — WHAT IF/);
  assert.equal((html.match(/<button[^>]+data-stress-preset/g) || []).length, 5);
  assert.match(html, /id="stress-results" aria-live="polite"/);
  assert.match(html, /drawdownPct/);
  assert.match(html, /円換算残高DD／入出金未調整／履歴最大180日・最高残高継続/);
  assert.match(html, /<meta property="og:image" content="\/og-v14-technical-signals\.png">/);
  assert.match(html, /TRACE ID/);
  assert.match(html, /qualityParts/);
  assert.match(html, /RISK ENGINE 95/);
  assert.match(html, /TRADE GATE — POSITION SIZER/);
  assert.match(html, /AUTO RECOVERY — DEVICE LOCAL/);
  assert.match(html, /STOP価格での約定は保証されず/);
  assert.match(html, /function orderPlanner\(pre\)\{\s*openTradeGate\(pre\|\|\{\}\)/);
  assert.doesNotMatch(html, /function opToPos\(/);
  assert.match(html, /US COMMAND ULTRA v14\.0 — TECHNICAL SIGNAL WATCH \/ SIMULATE ONLY/);
  assert.match(html, /const KEY='uscmd_ultra_v3'/);
  assert.match(html, /out\.v=3/);
  assert.match(html, /S\.spark\['JPY=X'\]=fxCloses/);
  assert.match(html, /p\.currency=\/\^\[A-Z\]\{3\}\$\//);
});

test('portfolio X-RAY uses marked market value, standard HHI and explicit stop coverage', () => {
  const source = functionBlock('portfolioXraySnapshot', 'xrayQuoteQuality');
  const state = {
    settings: { usdJpy: 150 },
    cash: { usd: 1000, jpy: 200000 },
    positions: [
      { ticker: 'A', shares: 10, price: 100, avgCost: 80, stopPx: 90 },
      { ticker: 'B', shares: 20, price: 50, avgCost: 55 }
    ]
  };
  const context = { state };
  vm.runInNewContext(`${source}; result = portfolioXraySnapshot(state);`, context);
  const x = context.result;
  assert.equal(x.stockMarketValueUsd, 2000);
  assert.equal(x.navJpy, 650000);
  assert.deepEqual(Array.from(x.rows, row => row.weightPct), [50, 50]);
  assert.ok(Math.abs(x.hhi - 5000) < 1e-9);
  assert.ok(Math.abs(x.effectiveN - 2) < 1e-9);
  assert.equal(x.stopCoveragePct, 50);
  assert.equal(x.remainingStopRiskJpy, 15000);
  assert.ok(Math.abs(x.knownStopRiskPct - 15000 / 650000 * 100) < 1e-9);
  assert.equal(x.stopRiskPct, null);
  assert.equal(x.stopRiskExact, false);
  assert.equal(x.uncoveredCount, 1);
  assert.equal(x.breachedCount, 0);

  state.positions[0].price = 85;
  vm.runInNewContext(`${source}; breached = portfolioXraySnapshot(state);`, context);
  assert.equal(context.breached.breachedCount, 1);
  assert.equal(context.breached.remainingStopRiskJpy, null);
  assert.equal(context.breached.stopRiskPct, null);
  assert.equal(context.breached.stopBreachExcessJpy, 7500);

  state.positions[1].price = null;
  vm.runInNewContext(`${source}; incomplete = portfolioXraySnapshot(state);`, context);
  assert.equal(context.incomplete.unpricedCount, 1);
  assert.equal(context.incomplete.navJpy, null);
  assert.equal(context.incomplete.stopRiskPct, null);

  state.positions = [
    { ticker: 'AAPL', currency: 'USD', shares: 10, price: 100, avgCost: 80, stopPx: 90 },
    { ticker: '7203.T', currency: 'JPY', shares: 100, price: 3000, avgCost: 2500 }
  ];
  vm.runInNewContext(`${source}; multiCurrency = portfolioXraySnapshot(state);`, context);
  assert.equal(context.multiCurrency.unsupportedCurrencyCount, 1);
  assert.equal(context.multiCurrency.stockMarketValueUsd, 1000);
  assert.equal(context.multiCurrency.navJpy, null);
  assert.equal(context.multiCurrency.hhi, null);
});

test('Stress Lab includes stock-FX interaction and never mutates portfolio state', () => {
  const source = functionBlock('stressScenarioSnapshot', 'openStressLab');
  const state = {
    settings: { usdJpy: 150, fxStale: false },
    cash: { usd: 1000, jpy: 200000 },
    positions: [
      { ticker: 'A', shares: 10, price: 100 },
      { ticker: 'B', shares: 20, price: 50 }
    ]
  };
  const before = JSON.parse(JSON.stringify(state));
  const context = { state };
  vm.runInNewContext(`${source}; result = stressScenarioSnapshot(-20, -10, state);`, context);
  const r = context.result;
  assert.equal(r.complete, true);
  assert.equal(r.stressedJpy, 551000);
  assert.equal(r.deltaJpy, -99000);
  assert.ok(Math.abs(r.deltaPct - (-99000 / 650000 * 100)) < 1e-9);
  assert.equal(r.stockContributionJpy, -60000);
  assert.equal(r.fxContributionJpy, -45000);
  assert.ok(Math.abs(r.interactionJpy - 6000) < 1e-9);
  assert.deepEqual(state, before);

  const old = new Date(Date.now() - 30 * 864e5).toISOString();
  state.settings.fxAt = old;
  state.settings.fxSource = 'api';
  state.positions.forEach(position => { position.syncedAt = old; position.priceSource = 'api'; });
  vm.runInNewContext(`${source}; aged = stressScenarioSnapshot(-20, -10, state);`, context);
  assert.equal(context.aged.stale, true);

  state.positions[1].price = null;
  vm.runInNewContext(`${source}; incomplete = stressScenarioSnapshot(-20, -10, state);`, context);
  assert.equal(context.incomplete.complete, false);
  assert.match(context.incomplete.reason, /価格未取得/);

  state.positions[1].price = 50;
  state.positions[1].currency = 'JPY';
  vm.runInNewContext(`${source}; unsupported = stressScenarioSnapshot(-20, -10, state);`, context);
  assert.equal(context.unsupported.complete, false);
  assert.equal(context.unsupported.unsupportedCurrencyCount, 1);
  assert.match(context.unsupported.reason, /USDとして誤換算せず/);
});

test('Risk Engine computes 95% historical VaR, expected shortfall, annual volatility and SPY beta', () => {
  const source = functionBlock('portfolioRiskSnapshot', 'riskEnginePanel');
  const dailyReturns = [-0.10, -0.06];
  while (dailyReturns.length < 40) dailyReturns.push([-0.02, -0.01, 0, 0.01, 0.02][dailyReturns.length % 5]);
  const prices = [100];
  const spy = [100];
  for (const value of dailyReturns) {
    prices.push(prices.at(-1) * (1 + value));
    spy.push(spy.at(-1) * (1 + value / 2));
  }
  const now = new Date().toISOString();
  const state = {
    settings: { usdJpy: 150, fxAt: now, fxRetrievedAt: now, fxSource: 'api', fxFreshness: 'live', fxStale: false },
    cash: { usd: 0, jpy: 0 },
    positions: [{ ticker: 'AAPL', currency: 'USD', shares: 10, price: prices.at(-1), syncedAt: now, priceSource: 'api', freshness: 'live' }],
    spark: { AAPL: prices, SPY: spy, 'JPY=X': Array(prices.length).fill(150) }
  };
  const context = { state };
  vm.runInNewContext(`${source}; result = portfolioRiskSnapshot(state);`, context);
  const result = context.result;
  const mean = dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length;
  const expectedVol = Math.sqrt(dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (dailyReturns.length - 1)) * Math.sqrt(252) * 100;
  assert.equal(result.sufficient, true);
  assert.equal(result.decisionReady, true);
  assert.equal(result.mode, 'jpy');
  assert.equal(result.sampleCount, 40);
  assert.equal(result.tailCount, 2);
  assert.ok(Math.abs(result.varPct - 6) < 1e-9);
  assert.ok(Math.abs(result.expectedShortfallPct - 8) < 1e-9);
  assert.ok(Math.abs(result.annualVolPct - expectedVol) < 1e-9);
  assert.ok(Math.abs(result.beta - 2) < 1e-9);
  assert.equal(result.coveragePct, 100);

  delete state.spark['JPY=X'];
  vm.runInNewContext(`${source}; usdFallback = portfolioRiskSnapshot(state);`, context);
  assert.equal(context.usdFallback.mode, 'usd');
  assert.match(context.usdFallback.reason.join(' '), /為替変動を除くUSDリスク/);

  state.spark.AAPL = prices.slice(-10);
  state.spark.SPY = spy.slice(-10);
  vm.runInNewContext(`${source}; shortHistory = portfolioRiskSnapshot(state);`, context);
  assert.equal(context.shortHistory.sufficient, false);
  assert.equal(context.shortHistory.sampleCount, 9);

  state.spark.AAPL = [100, 102, 51, 52];
  vm.runInNewContext(`${source}; splitSuspect = portfolioRiskSnapshot(state);`, context);
  assert.equal(context.splitSuspect.sufficient, false);
  assert.equal(context.splitSuspect.splitSuspected, true);
  assert.match(context.splitSuspect.reason[0], /誤計算しないため停止/);

  state.positions[0].currency = 'JPY';
  vm.runInNewContext(`${source}; unsupported = portfolioRiskSnapshot(state);`, context);
  assert.equal(context.unsupported.sufficient, false);
  assert.equal(context.unsupported.unsupportedCurrencyCount, 1);
});

test('market arena refuses low-coverage or non-USD portfolio series', () => {
  const source = functionBlock('portSeries', 'portfolioRiskSnapshot');
  const context = {
    S: {
      positions: [
        { ticker: 'A', currency: 'USD', shares: 90, price: 100 },
        { ticker: 'B', currency: 'USD', shares: 10, price: 100 }
      ],
      spark: { B: [90, 92, 94, 96, 98, 100] }
    }
  };
  vm.runInNewContext(`${source}; lowCoverage = portSeries();`, context);
  assert.equal(context.lowCoverage, null);
  context.S.spark.A = [95, 96, 97, 98, 99, 100];
  vm.runInNewContext(`${source}; complete = portSeries();`, context);
  assert.equal(Array.from(context.complete).length, 6);
  context.S.positions[0].currency = 'JPY';
  vm.runInNewContext(`${source}; foreign = portSeries();`, context);
  assert.equal(context.foreign, null);
});

test('Trade Gate takes the minimum of open-risk, cash and concentration caps and locks unsafe inputs', () => {
  const source = functionBlock('tradeGateSnapshot', 'openTradeGate');
  const now = new Date().toISOString();
  const state = {
    settings: { usdJpy: 150, fxAt: now, fxRetrievedAt: now, fxSource: 'api', fxFreshness: 'live', fxStale: false },
    cash: { usd: 2000, jpy: 0 },
    positions: [{ ticker: 'AAPL', currency: 'USD', role: 'trade', shares: 10, price: 100, stopPx: 90, syncedAt: now, priceSource: 'api', freshness: 'live' }]
  };
  const input = { ticker: 'NVDA', currency: 'USD', entryUsd: 50, stopUsd: 45, maxLossJpy: 30000, maxWeightPct: 40, bufferPct: 2 };
  const before = JSON.parse(JSON.stringify(state));
  const context = { state, input };
  vm.runInNewContext(`${source}; result = tradeGateSnapshot(input, state);`, context);
  const result = context.result;
  assert.equal(result.complete, true);
  assert.equal(result.existingOpenRiskJpy, 18000);
  assert.equal(result.riskPerShareJpy, 900);
  assert.deepEqual({ ...result.caps }, { risk: 13, cash: 40, weight: 24 });
  assert.equal(result.shares, 13);
  assert.deepEqual(Array.from(result.constraints), ['risk']);
  assert.equal(result.plannedLossJpy, 11700);
  assert.equal(result.totalOpenRiskJpy, 29700);
  assert.equal(result.orderValueUsd, 650);
  assert.equal(result.projectedCashJpy, 202500);
  assert.deepEqual(state, before);

  state.settings.fxFreshness = '';
  vm.runInNewContext(`${source}; legacyFreshness = tradeGateSnapshot(input, state);`, context);
  assert.equal(context.legacyFreshness.complete, true);
  assert.equal(context.legacyFreshness.notLive, true);
  state.settings.fxFreshness = 'live';

  state.positions[0].price = 90;
  vm.runInNewContext(`${source}; breached = tradeGateSnapshot(input, state);`, context);
  assert.equal(context.breached.complete, false);
  assert.equal(context.breached.stopBreached, true);

  state.positions[0].price = 100;
  state.positions[0].providerComparison = { status: 'divergent', differencePct: 4.2 };
  vm.runInNewContext(`${source}; divergent = tradeGateSnapshot(input, state);`, context);
  assert.equal(context.divergent.complete, false);
  assert.equal(context.divergent.providerDivergence, true);

  delete state.positions[0].providerComparison;
  state.positions[0].currency = 'JPY';
  vm.runInNewContext(`${source}; unsupported = tradeGateSnapshot(input, state);`, context);
  assert.equal(context.unsupported.complete, false);
  assert.equal(context.unsupported.unsupportedCurrencyCount, 1);

  state.positions[0].currency = 'USD';
  state.positions[0].stopPx = null;
  vm.runInNewContext(`${source}; unknownRisk = tradeGateSnapshot(input, state);`, context);
  assert.equal(context.unknownRisk.complete, false);
  assert.equal(context.unknownRisk.unknownOpenRiskCount, 1);

  state.positions[0].role = 'core';
  state.cash.usd = 0;
  vm.runInNewContext(`${source}; noCash = tradeGateSnapshot(input, state);`, context);
  assert.equal(context.noCash.complete, true);
  assert.equal(context.noCash.shares, 0);
  assert.ok(Array.from(context.noCash.constraints).includes('cash'));

  input.currency = 'JPY';
  vm.runInNewContext(`${source}; foreignEntry = tradeGateSnapshot(input, state);`, context);
  assert.equal(context.foreignEntry.complete, false);
  assert.match(context.foreignEntry.reason, /USDとして誤換算せず/);
});

test('Drawdown Guard uses fresh JPY balance points, inclusive threshold and persistent high-water mark', () => {
  const source = functionBlock('drawdownGuardMetrics', 'calc');
  const context = {
    S: {
      settings: { drawdownPct: 10 },
      history: [
        { d: '2026-07-09', netVal: 1_000_000 / 150, fx: 150, fresh: true },
        { d: '2026-07-10', netVal: 1_100_000 / 150, fx: 150, fresh: true },
        { d: '2026-07-11', netVal: 99_999, fx: 1, fresh: false }
      ],
      drawdownGuard: { peakJpy: 1_050_000, peakAt: '2026-07-01', freshPoints: 2 }
    },
    finiteOr: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    todayStr: () => '2026-07-12'
  };
  vm.runInNewContext(`${source}; result = drawdownGuardMetrics(990000);`, context);
  const result = context.result;
  assert.equal(result.armed, true);
  assert.ok(Math.abs(result.peak - 1_100_000) < 1e-6);
  assert.ok(Math.abs(result.drawdown - (-10)) < 1e-9);
  assert.equal(result.breached, true);
  assert.equal(result.validPoints, 2);
  assert.equal(result.legacyPoints, 1);

  context.S.history = [];
  context.S.drawdownGuard = { peakJpy: 1_200_000, peakAt: '2025-01-01', freshPoints: 200 };
  vm.runInNewContext(`${source}; retained = drawdownGuardMetrics(1_080_000);`, context);
  assert.equal(context.retained.peak, 1_200_000);
  assert.equal(context.retained.armed, true);
  assert.ok(Math.abs(context.retained.drawdown - (-10)) < 1e-9);
});

test('equity history uses the market observation date instead of creating weekend duplicates', () => {
  const source = functionBlock('historySessionDate', 'recordHistory');
  const context = {
    active: [
      { ticker: 'AAPL', priceAt: '2026-07-10T20:00:00.000Z' },
      { ticker: 'MSFT', priceAt: '2026-07-10T19:59:58.000Z' }
    ],
    todayStr: () => '2026-07-12'
  };
  vm.runInNewContext(`${source}; result = historySessionDate(active);`, context);
  assert.equal(context.result, '2026-07-10');
  context.active = [];
  vm.runInNewContext(`${source}; fallback = historySessionDate(active);`, context);
  assert.equal(context.fallback, '2026-07-12');
});

test('backup migration normalizes hostile numeric fields and malformed collection entries', () => {
  const payload = {
    settings: { usdJpy: '"><img src=x onerror=alert(1)>', frameJpy: '-5', drawdownPct: '999' },
    cash: { jpy: '"><img src=x onerror=alert(1)>', usd: '100' },
    plan: { dos: [null], donts: [{ id: "x' onclick='alert(1)", text: 'rule' }] },
    positions: [
      { id: 'safe', ticker: 'AAPL', currency: '"><img>', shares: 10, avgCost: 100, price: 120, stopPx: '</span><img src=x onerror=alert(1)>', takePx: '" autofocus onfocus=alert(1)', aiAdvice: { stopPx: '<img>', takePx: 'bad' } },
      { id: 'negative', ticker: 'NVDA', shares: -1, avgCost: 100, price: 120 },
      { id: 'legacy-foreign', ticker: '7203.T', shares: 100, avgCost: 2500, price: 3000 }
    ],
    journal: [{ id: 'j', ticker: 'AAPL', shares: '<img>', price: 100 }],
    events: [{ id: 'e', ticker: 'AAPL', date: null, label: null }],
    themes: [null],
    sync: { failures: {}, requestIds: ["bad' onclick='x"], marketRegime: { status: "ready' onclick='x", vix: '<img>', wti: 71.25, asOf: '<script>', cache: 'owned', cacheAgeMs: -5, refreshRequested: 'true', refreshSuppressed: true, error: '<img src=x onerror=alert(1)>' } }
  };
  const context = { payload };
  vm.runInNewContext(`${migrationBlock()}; result = migrateState(payload);`, context);
  const state = context.result;
  assert.equal(state.settings.usdJpy, 155);
  assert.equal(state.settings.frameJpy, 300000);
  assert.equal(state.settings.drawdownPct, 12);
  assert.equal(state.cash.jpy, 0);
  assert.equal(state.cash.usd, 100);
  assert.equal(state.positions.length, 2);
  assert.equal(state.positions[0].currency, 'USD');
  assert.equal(state.positions[1].currency, 'UNK');
  assert.equal(state.positions[0].stopPx, null);
  assert.equal(state.positions[0].takePx, null);
  assert.equal(state.positions[0].aiAdvice.stopPx, null);
  assert.equal(state.positions[0].aiAdvice.takePx, null);
  assert.equal(state.journal.length, 0);
  assert.equal(state.events.length, 0);
  assert.equal(state.themes.length, 0);
  assert.equal(state.plan.dos.length, 0);
  assert.match(state.plan.donts[0].id, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(Array.from(state.sync.requestIds), []);
  assert.equal(state.sync.marketRegime.status, 'error');
  assert.equal(state.sync.marketRegime.vix, null);
  assert.equal(state.sync.marketRegime.wti, 71.25);
  assert.equal(state.sync.marketRegime.asOf, '<script>');
  assert.equal(state.sync.marketRegime.cache, '');
  assert.equal(state.sync.marketRegime.cacheAgeMs, null);
  assert.equal(state.sync.marketRegime.refreshRequested, false);
  assert.equal(state.sync.marketRegime.refreshSuppressed, true);
  assert.match(html, /MAX_IMPORT_BYTES=5\*1024\*1024/);
  assert.match(html, /f\.size>MAX_IMPORT_BYTES/);
  assert.match(html, /localConnection=\{apiBase:S\.settings\?\.apiBase/);
  assert.match(html, /gistId:S\.settings\?\.gistId/);
  assert.match(html, /Object\.assign\(next\.settings,localConnection\)/);
  assert.match(html, /if\(!save\(\)\)\{S=before;renderAll\(\);toast\('端末への保存に失敗したため取込を取り消しました'\)/);
  assert.doesNotMatch(html, /String\.fromCharCode\(\.\.\./);
  assert.match(html, /safe\.settings\.apiToken='';safe\.settings\.ghToken='';safe\.settings\.cloudPass=''/);
});

test('Auto Recovery keeps bounded device-local generations and defers cross-tab updates during edits', () => {
  assert.match(html, /const RECOVERY_KEY=KEY\+'_recovery_v1'/);
  assert.match(html, /MAX_RECOVERY_ITEMS=5/);
  assert.match(html, /MAX_RECOVERY_TOTAL_BYTES=2\*1024\*1024/);
  assert.match(html, /utf8Bytes\(JSON\.stringify\(rows\)\)>MAX_RECOVERY_TOTAL_BYTES/);
  assert.match(html, /recoveryAdd\(previous,'auto'\)/);
  assert.match(html, /recoveryAdd\(JSON\.stringify\(before\),'import'\)/);
  assert.match(html, /x\.row\.kind==='import'\?'取込前固定'/);
  assert.match(html, /bootRecoveryStatus='破損した主保存から端末内復旧点へ自動復帰しました'/);
  assert.match(html, /window\.addEventListener\('storage'/);
  assert.match(html, /pendingRemoteState=next/);
  assert.match(html, /編集中の画面を閉じると反映します/);
  assert.match(html, /store\.get\(KEY\)===json/);
});

test('complete reset removes secrets, holdings and every device recovery generation', () => {
  const source = functionBlock('resetAll', 'historySessionDate');
  assert.match(source, /APIトークン・端末内復旧点を完全消去/);
  assert.match(source, /この操作は復元できません/);
  assert.match(source, /localStorage\.removeItem\(KEY\);localStorage\.removeItem\(RECOVERY_KEY\)/);
  assert.match(source, /store\.set\(RECOVERY_KEY,'\[\]'\)/);
  assert.match(source, /S=clean/);
  assert.doesNotMatch(source, /\bsave\(\)/);
});

test('cross-tab three-way merge preserves independent price and position edits', () => {
  const base = { cash: { jpy: 0, usd: 100 }, positions: [{ id: 'p1', ticker: 'AAPL', shares: 10, price: 100, stopPx: 90 }] };
  const local = JSON.parse(JSON.stringify(base));
  const remote = JSON.parse(JSON.stringify(base));
  local.positions[0].shares = 12;
  remote.positions[0].price = 120;
  remote.cash.jpy = 100000;
  const context = { base, local, remote };
  vm.runInNewContext(`${concurrentMergeBlock()}; result = mergeConcurrentState(base, local, remote);`, context);
  assert.equal(context.result.conflicts, 0);
  assert.equal(context.result.state.positions[0].shares, 12);
  assert.equal(context.result.state.positions[0].price, 120);
  assert.equal(context.result.state.positions[0].stopPx, 90);
  assert.equal(context.result.state.cash.jpy, 100000);

  const competing = JSON.parse(JSON.stringify(remote));
  competing.positions[0].shares = 11;
  context.competing = competing;
  vm.runInNewContext('collision = mergeConcurrentState(base, local, competing);', context);
  assert.equal(context.collision.state.positions[0].shares, 12);
  assert.equal(context.collision.state.positions[0].price, 120);
  assert.equal(context.collision.conflicts, 1);
});

test('service worker never caches API or health responses', () => {
  const worker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(worker, /url\.pathname === '\/healthz'/);
  assert.match(worker, /response\.ok/);
  assert.match(worker, /AbortController/);
  assert.doesNotMatch(worker, /install[\s\S]{0,180}skipWaiting/);
});

test('web app manifest has a stable scope and install icons', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.lang, 'ja-JP');
  assert.ok(!manifest.display_override.includes('window-controls-overlay'));
  assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512']);
});

test('market theme tracker exposes four instant periods and accessible expandable rows', () => {
  assert.match(html, /THEME_PERIODS=\['1d','5d','1m','1y'\]/);
  assert.equal((html.match(/fetch\(base\+'\/api\/themes'/g) || []).length, 1);
  assert.match(html, /role="tablist" aria-label="テーマランキング期間"/);
  assert.match(html, /role="tab" data-theme-period=/);
  assert.match(html, /aria-selected="\$\{p===k\?'true':'false'\}"/);
  assert.match(html, /aria-expanded="\$\{open\?'true':'false'\}"/);
  assert.match(html, /aria-controls="theme-detail-\$\{theme\.id\}"/);
  assert.match(html, /\.theme-period\{[^}]*min-height:44px/);
  assert.match(html, /\.theme-leader-table\{overflow-x:auto/);
  assert.match(html, /onkeydown="themePeriodKey\(event,'\$\{k\}'\)"/);
  assert.match(html, /THEME_TRACKER_CACHE='uscmd_theme_tracker_v1'/);
  assert.match(html, /requestId:safeText\(src\.requestId\|\|meta\.requestId,80\)/);
  assert.match(html, /coverage:\{returned,requested\}/);

  const periodSource = functionBlock('setThemePeriod', 'themePeriodKey');
  assert.doesNotMatch(periodSource, /fetch\s*\(/);
  assert.match(periodSource, /ThemeTracker\.period=period/);
});

test('theme ranking keeps complete data ahead of partial data and N-A values last', () => {
  const source = functionBlock('themeRanked', 'setThemePeriod');
  const context = {
    ThemeTracker: {
      period: '1d',
      themes: [
        { id: 'partial-high', status: 'partial', performance: { '1d': 90 } },
        { id: 'ok-low', status: 'ok', performance: { '1d': 1 } },
        { id: 'ok-high', status: 'ok', performance: { '1d': 2 } },
        { id: 'ok-na', status: 'ok', performance: { '1d': null } }
      ]
    }
  };
  vm.runInNewContext(`${source}; result = themeRanked().map(theme => theme.id);`, context);
  assert.deepEqual(Array.from(context.result), ['ok-high', 'ok-low', 'ok-na', 'partial-high']);
});

test('theme AI uses measured evidence only and persists escaped time-scoped analysis', () => {
  const analysisSource = functionBlock('analyzeTheme', 'themeLeaderRows');
  const promptSource = analysisSource.split('const base=')[0];
  assert.match(analysisSource, /themePromptContext\(theme\)/);
  assert.match(analysisSource, /\[theme:\.\.\.\].*\[price:\.\.\.\].*\[breadth:\.\.\.\]/s);
  assert.match(analysisSource, /根拠のない最新ニュース/);
  assert.match(analysisSource, /欠損を推測で補完しない/);
  assert.match(analysisSource, /base\+'\/api\/ai-analyze'/);
  assert.doesNotMatch(promptSource, /S\.positions|S\.cash|apiToken/);
  assert.match(html, /const themeEvidence=selectedThemeAiPanel\(\)/);
  assert.match(html, /S\.themeAnalyses\[id\]=\{text:safeText\(body\.text,4000\)/);
  assert.match(html, /dataAsOf:safeText\(ThemeTracker\.asOf\|\|ThemeTracker\.updatedAt,64\)/);
  assert.match(html, /旧データ時点の分析/);
  assert.match(html, /\$\{esc\(analysis\.text\)\}/);
  assert.match(html, /out\.themeAnalyses=\{\}/);
  assert.match(html, /ThemeTracker\.status==='stale'\|\|ThemeTracker\.status==='refreshing'\|\|ThemeTracker\.fromCache/);
  assert.match(html, /clientCacheState=ThemeTracker\.status==='stale'\|\|ThemeTracker\.fromCache\?'古い端末キャッシュ'/);
  assert.match(analysisSource, /if\(cur==='mkt'\)renderMkt\(\);else if\(cur==='ai'\)renderAI\(\)/);
});

test('v13 Market Theme Intelligence OS is reachable, mobile-safe and labels proxy versus observed data', () => {
  assert.match(html, /\$\{renderIntelligenceOSPanel\(\)\}[\s\S]*\$\{renderThemeTrackerPanel\(\)\}/);
  assert.match(html, /MARKET THEME INTELLIGENCE OS/);
  assert.match(html, /FLOW MAP（推定）[\s\S]*SCORE RANK[\s\S]*FLOW IN（推定）[\s\S]*FLOW OUT（推定）[\s\S]*NEXT 監視/);
  assert.match(html, /実際の資金フロー・注文フローではありません/);
  assert.match(html, /50は同日テーマ群の中央値で、資金中立を意味しません/);
  assert.match(html, /カタログ上の構造関係のみ（方向・資金量・先行性を示さない）/);
  assert.match(html, /status==='validated-association'/);
  assert.match(html, /catalogOnly:e\?\.catalogOnly===true\|\|\(e\?\.catalogRelation===true&&e\?\.eligible!==true\)/);
  assert.match(html, /@media\(max-width:360px\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)\{\.intel-edge\.pulse\{animation:none\}/);
  assert.match(html, /MUU注意/);
  assert.match(html, /日次2倍連動を目標とする別商品/);
  assert.match(html, /role="tablist" aria-label="市場テーマOS表示"/);
  assert.match(html, /onkeydown="intelligenceViewKey\(event/);
  assert.match(html, /\.intel-node\.rotation-up \.core\{fill:rgba\(47,230,167/);
  assert.match(html, /\.intel-node\.rotation-flat \.core\{fill:rgba\(246,200,95/);
  assert.match(html, /\.intel-node\.rotation-down \.core\{fill:rgba\(255,102,125/);
});

test('v13 detail exposes the API entry enum as a non-order observation label', () => {
  const labelSource = functionBlock('intelligenceEntryLabel', 'intelligenceDetailPanel');
  const context = { intelligenceDetailPanelBase: () => '<section><div class="intel-gate">gate</div></section>', selectedIntelligenceTheme: () => ({ entry: 'buy' }), esc: value => String(value) };
  vm.runInNewContext(`${labelSource}; labels = ['buy','pullback_only','watch','avoid'].map(intelligenceEntryLabel);`, context);
  assert.deepEqual(Array.from(context.labels), ['買い条件一致', '押し目限定', '監視', '回避']);
  const detailSource = functionBlock('intelligenceDetailPanel', 'renderIntelligenceOSPanel');
  assert.match(detailSource, /ENTRY（観測ラベル）/);
  assert.match(detailSource, /注文・売買指示ではありません/);
  assert.match(detailSource, /intelligenceEntryLabel\(theme\.entry\)/);
  vm.runInNewContext(`${detailSource}; rendered = intelligenceDetailPanel();`, context);
  assert.match(context.rendered, /ENTRY（観測ラベル）/);
  assert.match(context.rendered, /買い条件一致/);
  assert.ok(context.rendered.indexOf('ENTRY（観測ラベル）') < context.rendered.indexOf('gate'));
});

test('v13 map colors theme cores by estimated rotation while leaving aggregate nodes separate', () => {
  const source = functionBlock('intelligenceGraphPanel', 'intelligenceListPanel');
  assert.match(source, /theme\.estimatedRotationIndex\?\?intelligenceNetRotation\(theme\)/);
  assert.match(source, /Math\.abs\(rotation\)<=5\?'flat':rotation>5\?'up':'down'/);
  assert.match(source, /rotation-\$\{tone\}/);
  assert.match(source, /data-rotation-tone="\$\{tone\}"/);
  assert.match(source, /onclick="selectIntelligenceTheme/);
  assert.doesNotMatch(source, /setIntelligenceCategory/);
  const graphHtml = `<g class="intel-node aggregate market" role="button" onclick="setIntelligenceCategory('all')"></g><g class="intel-node" role="button" onclick="selectIntelligenceTheme('up')"></g><g class="intel-node" role="button" onclick="selectIntelligenceTheme('flat')"></g><g class="intel-node" role="button" onclick="selectIntelligenceTheme('down')"></g>`;
  const context = { IntelligenceOS: { themes: [{ id: 'up', estimatedRotationIndex: 8 }, { id: 'flat', estimatedRotationIndex: 0 }, { id: 'down', estimatedRotationIndex: -8 }] }, intelligenceGraphPanelBase: () => graphHtml, intelligenceNetRotation: () => null };
  vm.runInNewContext(`${source}; rendered = intelligenceGraphPanel();`, context);
  assert.match(context.rendered, /class="intel-node rotation-up"[^>]*data-rotation-tone="up"/);
  assert.match(context.rendered, /class="intel-node rotation-flat"[^>]*data-rotation-tone="flat"/);
  assert.match(context.rendered, /class="intel-node rotation-down"[^>]*data-rotation-tone="down"/);
  assert.match(context.rendered, /class="intel-node aggregate market"/);
  assert.doesNotMatch(context.rendered, /aggregate market rotation-/);
});

test('v13 normalizer preserves nested backend quality, ETF objects and edge states', () => {
  const start = html.indexOf('function normalizeIntelAvailability(');
  const end = html.indexOf('function adoptIntelligencePayload(', start);
  assert.ok(start >= 0 && end > start);
  const source = html.slice(start, end);
  assert.match(source, /const status=safeText\(e\?\.status,48\)\|\|'catalog-only'/);
  assert.match(source, /catalogOnly:e\?\.catalogOnly===true\|\|\(e\?\.catalogRelation===true&&e\?\.eligible!==true\)/);
  assert.match(source, /associationObserved:e\?\.associationObserved===true/);
  const context = {
    intelNumber: (value, min, max) => value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max ? null : Number(value),
    intelId: value => String(value || '').trim().toLowerCase(),
    intelSymbolList: value => (Array.isArray(value) ? value : []).map(item => String(item || '').toUpperCase()).filter(Boolean),
    normalizeTicker: value => String(value || '').toUpperCase(),
    TICKER_RE: /^[A-Z0-9][A-Z0-9.-]*$/,
    THEME_PERIODS: ['1d', '5d', '1m', '1y'],
    INTELLIGENCE_EDGE_TYPES: ['supply-chain'],
    safeText: (value, max = 1000) => String(value ?? '').slice(0, max)
  };
  vm.runInNewContext(`${source}; result = normalizeIntelligencePayload(payload);`, Object.assign(context, { payload: {
    status: 'ok', actualFundFlow: false,
    availability: { volume: { available: false, used: false } },
    meta: { quality: { coveragePct: 100 } },
    summary: { market: { id: 'market', name: 'MARKET', score: 55, coverage: { pct: 100 }, themeIds: ['gpu'] } },
    categories: [{ id: 'semiconductors', name: '半導体', themeIds: ['gpu'], coverage: { pct: 100 } }],
    themes: [{ id: 'gpu', name: 'GPU', categoryId: 'semiconductors', parentThemes: [], relatedTickers: ['NVDA'], relatedEtfs: ['SOXX'], etfs: [{ symbol: 'SOXX' }], eligible: false, scoreAvailable: true, coverage: { pct: 100 }, availability: { price: { coveragePct: 100 }, volume: { available: false, used: false } }, constituents: [{ symbol: 'NVDA', status: 'ok', coverage: { returned: 4, requested: 4 }, performance: { '1d': 1, '5d': 2, '1m': 3, '1y': 4 } }], score: 80, flowIn: 8, flowOut: 0, trend: 'up', entry: 'buy', historySamples: 100, peerStability: .95 }],
    edges: [{ id: 'e1', from: 'gpu', to: 'gpu2', type: 'supply-chain', status: 'validated-association', eligible: true, associationObserved: true }]
  } }));
  const normalized = context.result;
  assert.equal(normalized.meta.coveragePct, 100);
  assert.equal(normalized.themes[0].availability.coveragePct, 100);
  assert.equal(normalized.themes[0].eligible, false);
  assert.equal(normalized.themes[0].scoreAvailable, true);
  assert.equal(normalized.themes[0].etfs[0], 'SOXX');
  assert.equal(normalized.themes[0].constituents[0].coverage, 100);
  assert.equal(normalized.themes[0].trend, 'up');
  assert.equal(normalized.themes[0].entry, 'buy');
  assert.equal(normalized.market.name, 'MARKET');
  context.cachedPayload = JSON.parse(JSON.stringify(normalized));
  vm.runInNewContext('cached = normalizeIntelligencePayload(cachedPayload);', context);
  assert.equal(context.cached.availability.coveragePct, 100);
  assert.equal(context.cached.themes[0].availability.coveragePct, 100);
  assert.equal(context.cached.market.score, 55);
});

test('v13 five-factor gate is fail-closed and AI output is revision-scoped', () => {
  assert.match(html, /theme\.eligible===true&&theme\.scoreAvailable===true/);
  assert.match(html, /themeCoverage===100&&theme\.historySamples>=60/);
  assert.match(html, /IntelligenceOS\.actualFundFlow===false&&IntelligenceOS\.meta\.volumeUsed===false&&coverage===100/);
  assert.match(html, /defs=\[\['SCORE',[\s\S]*\['ROTATION',[\s\S]*\['ACCEL',[\s\S]*\['BREADTH',[\s\S]*\['CONFIDENCE'/);
  const analysisSource = functionBlock('requestIntelligenceAnalysis', 'intelligenceCategoryName');
  assert.match(analysisSource, /OBSERVED \/ ESTIMATED EVIDENCE/);
  assert.match(analysisSource, /各主張にevidence ID/);
  assert.match(analysisSource, /実資金移動、因果、将来の上昇確率を捏造しない/);
  assert.doesNotMatch(analysisSource, /S\.positions|S\.cash/);
  assert.match(analysisSource, /dataRevision:safeText\(IntelligenceOS\.dataRevision,96\)/);
  assert.match(html, /旧revision（現在の判定には未使用）/);
  assert.match(html, /out\.intelligenceAnalyses=\{\}/);
  assert.match(html, /SELECTED MARKET INTELLIGENCE/);
  assert.match(html, /selectedIntelligenceTheme\(\)\?intelligencePromptContext\(\):themePromptContext\(\)/);
  assert.match(html, /カタログedgeは方向・強度・先行性を示さない/);
});

test('v13 avoids simultaneous cold starts of legacy and intelligence theme endpoints', () => {
  const initSource = functionBlock('themeTrackerInit', 'fetchThemeTracker');
  assert.match(initSource, /startAfterIntelligence/);
  assert.match(initSource, /IntelligenceOS\.loading\|\|\['idle','loading','refreshing'\]\.includes\(IntelligenceOS\.status\)/);
  assert.match(initSource, /setTimeout\(startAfterIntelligence,900\)/);
});

test('v13.1 RRG normalizer keeps 21 unique frames, derives quadrants and rejects invalid coordinates', () => {
  const start = html.indexOf('function normalizeIntelAvailability(');
  const end = html.indexOf('function adoptIntelligencePayload(', start);
  const source = html.slice(start, end);
  const context = {
    intelNumber: (value, min, max) => value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max ? null : Number(value),
    intelId: value => String(value || '').trim().toLowerCase(),
    intelSymbolList: value => (Array.isArray(value) ? value : []).map(item => String(item || '').toUpperCase()).filter(Boolean),
    normalizeTicker: value => String(value || '').toUpperCase(),
    TICKER_RE: /^[A-Z0-9][A-Z0-9.-]*$/,
    THEME_PERIODS: ['1d', '5d', '1m', '1y'],
    INTELLIGENCE_EDGE_TYPES: ['supply-chain'],
    safeText: (value, max = 1000) => String(value ?? '').slice(0, max)
  };
  const dates = Array.from({ length: 24 }, (_, index) => `2026-06-${String(index + 1).padStart(2, '0')}`);
  const trail = dates.map((date, index) => ({ date, longRelativePct: index - 10, shortRelativePct: 10 - index, quadrant: 'hostile', status: 'ok', coveragePct: 100, priceMode: 'raw-close-fallback' }));
  trail.push({ date: dates.at(-1), longRelativePct: Infinity, shortRelativePct: 3, quadrant: 'leader', status: 'ok' });
  const payload = {
    status: 'ok', actualFundFlow: false,
    rrg: { status: 'ok', benchmark: 'SPY', dates: [...dates].reverse().concat(dates.at(-1)), longPeriodSessions: 63, shortPeriodSessions: 5, trailSessions: 20, quadrantCounts: {} },
    summary: { market: { id: 'market', name: 'MARKET', themeIds: ['gpu'] } }, categories: [], edges: [],
    themes: [{ id: 'gpu', name: 'GPU', categoryId: 'semiconductors', relatedTickers: ['NVDA'], coverage: { pct: 100 }, availability: {}, constituents: [], score: 70, status: 'ok', rrg: { status: 'ok', benchmark: 'SPY', longRelativePct: Infinity, shortRelativePct: 3, trail } }]
  };
  vm.runInNewContext(`${source}; result = normalizeIntelligencePayload(payload);`, Object.assign(context, { payload }));
  const normalized = context.result;
  assert.equal(normalized.rrg.dates.length, 21);
  assert.deepEqual(Array.from(normalized.rrg.dates), [...new Set(normalized.rrg.dates)].sort());
  assert.equal(normalized.themes[0].rrg.trail.length, 21);
  assert.equal(normalized.themes[0].rrg.longRelativePct, null);
  assert.equal(normalized.themes[0].rrg.quadrant, null);
  const finitePoint = normalized.themes[0].rrg.trail.find(point => point.longRelativePct != null && point.shortRelativePct != null);
  assert.equal(finitePoint.quadrant, finitePoint.longRelativePct >= 0 ? (finitePoint.shortRelativePct >= 0 ? 'leader' : 'weakening') : (finitePoint.shortRelativePct >= 0 ? 'rebound' : 'lagging'));
});

test('v13.1 RRG view exposes four quadrants, 20-day controls, accessible fallback and fixed-scale trails', () => {
  assert.match(html, /INTELLIGENCE_VIEWS=\['map','rrg','ranking','rotation-up','rotation-down','next'\]/);
  assert.match(html, /rrg:'RRG 4象限'/);
  assert.match(html, /RRG型・価格ローテーション参考図/);
  assert.match(html, /63営業日 SPY対比・対数リターン差/);
  assert.match(html, /5営業日 SPY対比・対数リターン差/);
  assert.match(html, /右上リーダー、右下調整、左上短期反発、左下弱/);
  assert.match(html, /\[-20,'-20D'\][\s\S]*\[0,'最新'\]/);
  assert.match(html, /▶ 20日再生/);
  assert.match(html, /role="group" aria-labelledby="rrg-title rrg-desc"/);
  assert.doesNotMatch(html, /class="rrg-chart"[^>]*role="img"/);
  assert.match(html, /同内容のアクセシブル一覧/);
  assert.match(html, /class="rrg-table-theme"/);
  assert.match(html, /RRG \$\{qualityStatus\.toUpperCase\(\)\}/);
  assert.match(html, /現在座標[\s\S]*完全trail[\s\S]*API available/);
  assert.match(html, /rrgFixedDomain\(baseThemes\)/);
  assert.match(html, /rrg-trail\$\{theme\.id===IntelligenceOS\.selectedId\?' selected':''\}/);
  assert.match(html, /現行固定バスケットのbackcast/);
  assert.match(html, /公式RRG指標・実資金フロー・投資助言ではありません/);
  assert.match(html, /配当を含まず、分割などの企業行動/);
  assert.match(html, /\.rrg-scroll\{overflow-x:auto/);
  assert.match(html, /\.rrg-chart\{display:block;width:100%;min-width:660px/);
});

test('v13.1 RRG playback is bounded, single-timer, reduced-motion aware and cleaned up', () => {
  const source = html.slice(html.indexOf('function rrgPointAt('), html.indexOf('function intelligenceListPanel('));
  assert.match(source, /if\(IntelligenceOS\.rrgTimer\)\{clearInterval\(IntelligenceOS\.rrgTimer\)/);
  assert.match(source, /rrgReducedMotionQuery\?\.matches/);
  assert.match(html, /rrgReducedMotionQuery\?\.addEventListener\?\.\('change'/);
  assert.match(source, /if\(IntelligenceOS\.rrgCursor>=last\)\{rrgStopPlayback\(\);return\}/);
  assert.match(source, /IntelligenceOS\.rrgCursor\+=1/);
  assert.match(source, /document\.hidden/);
  assert.match(html, /if\(t!=='mkt'\)rrgStopPlayback\(false\)/);
  assert.match(html, /visibilitychange[\s\S]*document\.hidden\)rrgStopPlayback\(false\)/);
  assert.match(html, /fetchIntelligence\(silent\)\{[\s\S]*rrgStopPlayback\(false\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)[\s\S]*\.rrg-node/);
});

test('v13.1 AI receives revision-scoped RRG movement without treating it as capital flow', () => {
  const contextSource = functionBlock('intelligenceRrgPromptContexts', 'requestIntelligenceAnalysis');
  const source = contextSource + functionBlock('requestIntelligenceAnalysis', 'intelligenceCategoryName');
  assert.match(source, /RRG-STYLE OBSERVED PRICE CONTEXT/);
  assert.match(source, /rrgTransitions/);
  assert.match(source, /priceMode:theme\.rrg\?\.priceMode/);
  assert.match(source, /RRG位置を資金流入額と呼ばず/);
  assert.match(source, /raw終値・配当除外・企業行動の注意点/);
  assert.match(source, /dataRevision:safeText\(IntelligenceOS\.dataRevision,96\)/);
  assert.doesNotMatch(source, /S\.positions|S\.cash/);
});

test('v13.1 RRG label layout is collision-aware, keeps the selection and permits thinning', () => {
  const source = functionBlock('rrgRectsOverlap', 'rrgPanelFocusKey');
  const rows = Array.from({ length: 12 }, (_, index) => ({
    theme: { id: index === 7 ? 'selected' : `theme-${index}`, name: `テーマ${index}` },
    point: { longRelativePct: 100, shortRelativePct: 100 }
  }));
  const context = { rows, bounds: { left: 0, right: 220, top: 0, bottom: 220 } };
  vm.runInNewContext(`${source}; result = rrgLabelLayout(rows, value => value, value => value, bounds, 'selected');`, context);
  const shown = Array.from(context.result.values()).filter(item => item.showLabel);
  assert.equal(context.result.get('selected').showLabel, true);
  assert.ok(shown.length < rows.length, 'dense labels should be thinned');
  for (let left = 0; left < shown.length; left += 1) {
    for (let right = left + 1; right < shown.length; right += 1) {
      const a = shown[left].rect, b = shown[right].rect;
      assert.equal(a.x < b.x + b.w + 2 && a.x + a.w + 2 > b.x && a.y < b.y + b.h + 2 && a.y + a.h + 2 > b.y, false);
    }
  }
  const panelSource = functionBlock('intelligenceRrgPanel', 'intelligenceListPanel');
  assert.match(panelSource, /renderRows=\[\.\.\.currentRows\]\.sort/);
  assert.doesNotMatch(panelSource, /selectedRow=.*\|\|currentRows\[0\]/);
  assert.match(panelSource, /詳細は同じ選択テーマを表示しています/);
  assert.match(panelSource, /class="rrg-table-theme"[\s\S]*selectIntelligenceTheme/);
});

test('v13.1 RRG partial rendering restores the active control and avoids live-region churn', () => {
  const source = functionBlock('rrgPanelFocusKey', 'rrgStopPlayback');
  const tracker = { focusCalls: 0, options: null };
  const active = { getAttribute: key => key === 'data-rrg-focus' ? 'play' : null };
  const replacement = { getAttribute: key => key === 'data-rrg-focus' ? 'play' : null, focus: options => { tracker.focusCalls += 1; tracker.options = options; } };
  const panel = { innerHTML: 'old', contains: node => node === active, querySelectorAll: () => [replacement] };
  const context = {
    tracker, panel,
    document: { activeElement: active, querySelector: selector => selector === '#intel-view-panel' ? panel : null },
    IntelligenceOS: { view: 'rrg' }, cur: 'mkt',
    safeText: value => String(value || '').slice(0, 100),
    requestAnimationFrame: callback => callback(),
    intelligenceRrgPanel: () => '<section>updated</section>'
  };
  vm.runInNewContext(`${source}; rrgRenderOnly();`, context);
  assert.equal(panel.innerHTML, '<section>updated</section>');
  assert.equal(tracker.focusCalls, 1);
  assert.equal(tracker.options.preventScroll, true);
  const panelSource = functionBlock('intelligenceRrgPanel', 'intelligenceListPanel');
  assert.doesNotMatch(panelSource, /aria-live=/);
  assert.doesNotMatch(panelSource, /class="rrg-node[\s\S]*?onkeydown=/);
  assert.match(panelSource, /role="group" aria-labelledby="rrg-title rrg-desc"/);
});

test('v13.1 RRG playback emits exactly 21 ordered frames and leaves no interval behind', () => {
  const source = functionBlock('rrgStopPlayback', 'intelligenceRrgPanel');
  const clock = { created: 0, cleared: 0, tick: null, frames: [] };
  const context = {
    clock,
    IntelligenceOS: { rrg: { dates: Array.from({ length: 21 }, (_, index) => `d${index}`) }, rrgCursor: 20, rrgPlaying: false, rrgTimer: null, view: 'rrg' },
    rrgReducedMotionQuery: { matches: false }, cur: 'mkt', document: { hidden: false }, toast: () => {},
    rrgRenderOnly: () => clock.frames.push(context.IntelligenceOS.rrgCursor),
    setInterval: callback => { clock.created += 1; clock.tick = callback; return clock.created; },
    clearInterval: () => { clock.cleared += 1; }
  };
  vm.runInNewContext(`${source}; rrgTogglePlayback(); for(let index=0;index<21;index+=1)clock.tick(); result={cursor:IntelligenceOS.rrgCursor,playing:IntelligenceOS.rrgPlaying,timer:IntelligenceOS.rrgTimer};`, context);
  assert.deepEqual(clock.frames.slice(0, 21), Array.from({ length: 21 }, (_, index) => index));
  assert.equal(clock.created, 1);
  assert.equal(clock.cleared, 1);
  assert.equal(context.result.cursor, 20);
  assert.equal(context.result.playing, false);
  assert.equal(context.result.timer, null);
});

test('v13.1 AI RRG context requires the exact reference date and breaks transitions at gaps', () => {
  const source = functionBlock('intelligenceRrgPromptContexts', 'requestIntelligenceAnalysis').replace(/\s*async\s*$/, '');
  const dates = ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17'];
  const theme = {
    status: 'partial', eligible: false,
    availability: { eligible: false, coveragePct: 80, missing: ['2026-07-15', '2026-07-17'], reason: 'gaps' },
    rrg: { status: 'partial', benchmark: 'SPY', longPeriodSessions: 63, shortPeriodSessions: 5, priceMode: 'raw-close-fallback', dividendAdjusted: false, coverage: { returned: 3, requested: 5 }, trail: [
      { date: dates[0], longRelativePct: 2, shortRelativePct: 1, status: 'ok' },
      { date: dates[1], longRelativePct: 3, shortRelativePct: 1, status: 'ok' },
      { date: dates[2], longRelativePct: null, shortRelativePct: null, status: 'unavailable' },
      { date: dates[3], longRelativePct: -2, shortRelativePct: -1, status: 'ok' },
      { date: dates[4], longRelativePct: null, shortRelativePct: null, status: 'unavailable' }
    ] }
  };
  const context = {
    theme, normalizeRrgDates: value => Array.from(value),
    rrgQuadrantFrom: (x, y) => x >= 0 ? (y >= 0 ? 'leader' : 'weakening') : (y >= 0 ? 'rebound' : 'lagging'),
    RRG_LABELS: { leader: 'リーダー', weakening: '調整', rebound: '短期反発', lagging: '弱' },
    intelligenceCoveragePct: () => 80,
    IntelligenceOS: { status: 'stale', partial: true, fromCache: true, meta: { stale: true, cache: 'stale-fallback' }, rrg: { dates, asOf: dates.at(-1), status: 'partial', benchmark: 'SPY', longPeriodSessions: 63, shortPeriodSessions: 5, trailSessions: 20, availableThemeCount: 1, themeCount: 1 } }
  };
  vm.runInNewContext(`${source}; result=intelligenceRrgPromptContexts(theme);`, context);
  assert.equal(context.result.rrgContext.currentExact, null);
  assert.equal(context.result.rrgContext.latestValidObservation.date, dates[3]);
  assert.deepEqual(Array.from(context.result.rrgContext.gapDates), [dates[2], dates[4]]);
  assert.equal(context.result.rrgContext.transitions.at(-1).continuousFromPrevious, false);
  assert.equal(context.result.qualityContext.stale, true);
  assert.deepEqual(Array.from(context.result.qualityContext.themeAvailability.missing), ['2026-07-15', '2026-07-17']);
});

test('market regime normalizer is defensive and preserves VIX WTI SPY observations without inventing data', () => {
  const source = functionBlock('normalizeRegimeInstrument', 'normalizeMarketRegimePayload') + functionBlock('normalizeMarketRegimePayload', 'marketRegimeIsStale');
  const context = {
    MARKET_REGIME_LABELS: { danger: '危険', caution: '警戒', neutral: '中立', optimistic: '楽観' },
    regimeNumber: (value, min, max) => {
      if (value == null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= min && number <= max ? number : null;
    },
    safeText: (value, max = 1000) => String(value ?? '').slice(0, max)
  };
  const trail = Array.from({ length: 25 }, (_, index) => ({ date: `2026-07-${String(index + 1).padStart(2, '0')}`, value: 20 + index }));
  context.payload = {
    status: 'partial',
    asOf: '2026-07-26T12:00:00Z',
    regime: { state: 'danger', label: '危険', optimismScore: 18, riskScore: 82, confidence: 91, referenceOnly: true, watchOnly: true, tradeEligible: false, reasons: ['VIX上昇', { text: '株価の弱含み' }] },
    instruments: {
      vix: { value: 24.5, changePct: 5, change5dPct: 8, change20dPct: 12, changesPoints: { '1d': 1.2, '5d': 1.8, '20d': 2.4 }, source: 'yahoo-spark', priceMode: 'native-index-close', trail },
      wti: { price: Infinity, changes: { '1d': -2 }, source: 'yahoo-spark', priceMode: 'native-futures-close' },
      spy: { price: 610, changes: { '1d': 1, '5d': 2, '20d': 3 }, source: 'yahoo-chart-v8-adjusted', priceMode: 'adjusted-close' }
    },
    availability: { coveragePct: 67, partial: true, missing: ['wti'] },
    meta: { cache: 'hit', cacheTier: 'partial', cacheAgeMs: 1234, refreshRequested: true, refreshSuppressed: true, source: { provider: 'Yahoo Finance', id: 'yahoo-chart', official: false, bestEffort: true, inputs: { vix: 'yahoo-spark', wti: 'yahoo-spark', spy: 'yahoo-chart-v8-adjusted' } } }
  };
  vm.runInNewContext(`${source}; result=normalizeMarketRegimePayload(payload);`, context);
  assert.equal(context.result.label, 'danger');
  assert.equal(context.result.labelText, '危険');
  assert.equal(context.result.riskScore, 82);
  assert.equal(context.result.optimismScore, 18);
  assert.equal(context.result.instruments.vix.changes['1d'], 5);
  assert.equal(context.result.instruments.vix.changesPoints['20d'], 2.4);
  assert.equal(context.result.instruments.vix.trail.length, 21);
  assert.equal(context.result.instruments.vix.source, 'yahoo-spark');
  assert.equal(context.result.instruments.vix.priceMode, 'native-index-close');
  assert.equal(context.result.instruments.wti.value, null);
  assert.equal(context.result.instruments.spy.changes['20d'], 3);
  assert.equal(context.result.instruments.spy.source, 'yahoo-chart-v8-adjusted');
  assert.equal(context.result.instruments.spy.priceMode, 'adjusted-close');
  assert.equal(context.result.availability.coveragePct, 67);
  assert.equal(context.result.meta.source, 'Yahoo Finance');
  assert.equal(context.result.meta.inputs.spy, 'yahoo-chart-v8-adjusted');
  assert.equal(context.result.meta.official, false);
  assert.equal(context.result.meta.bestEffort, true);
  assert.equal(context.result.meta.cache, 'hit');
  assert.equal(context.result.meta.cacheTier, 'partial');
  assert.equal(context.result.meta.cacheAgeMs, 1234);
  assert.equal(context.result.meta.refreshRequested, true);
  assert.equal(context.result.meta.refreshSuppressed, true);
  assert.deepEqual(Array.from(context.result.reasons), ['VIX上昇', '株価の弱含み']);
  context.gapInstrument = { trail: [{ date: '2026-07-20', value: 20 }, { date: '2026-07-21', value: null }, { date: '2026-07-22', value: 22 }] };
  vm.runInNewContext("gap=normalizeRegimeInstrument(gapInstrument,'vix');", context);
  assert.equal(context.gap.trail.length, 3);
  assert.equal(context.gap.trail[1].date, '2026-07-21');
  assert.equal(context.gap.trail[1].relativePct, null);
  context.payload.regime.state = 'certain-crash';
  vm.runInNewContext('invalid=normalizeMarketRegimePayload(payload);', context);
  assert.equal(context.invalid.label, 'unavailable');

  context.legacyPayload = {
    status: 'partial', partial: true, asOf: '2026-07-25',
    regime: { state: 'watch_only', label: 'WATCH ONLY', observedState: 'caution', observedLabel: '警戒', score: 42, confidence: 25, rationale: ['同一営業日の参考判定'], decisionEligible: false },
    indicators: {
      vix: { symbol: '^VIX', level: 27, changesPct: { '1d': 4, '5d': 7, '20d': 15 }, available: true },
      wti: { symbol: 'CL=F', level: 70, changesPct: { '1d': -1, '5d': 2, '20d': 3 }, available: true },
      spy: { symbol: 'SPY', level: 620, changesPct: { '1d': -2, '5d': -3, '20d': 1 }, available: true }
    },
    availability: { history: { complete: true }, synchronizedConfirmedSession: { current: true }, adjustedClose: { available: false } },
    meta: { quality: { coveragePct: 100 }, observationStale: false, source: { id: 'yahoo-chart' } }
  };
  vm.runInNewContext('legacy=normalizeMarketRegimePayload(legacyPayload);', context);
  assert.equal(context.legacy.label, 'caution');
  assert.equal(context.legacy.labelText, '警戒');
  assert.equal(context.legacy.riskScore, 58);
  assert.equal(context.legacy.instruments.vix.value, 27);
  assert.equal(context.legacy.instruments.vix.changes['20d'], 15);
  assert.equal(context.legacy.availability.coveragePct, 100);
  assert.equal(context.legacy.referenceOnly, true);
  assert.equal(context.legacy.meta.source, 'yahoo-chart');
  assert.deepEqual(Array.from(context.legacy.reasons), ['同一営業日の参考判定']);

  context.confirmedPayload = {
    status: 'ok', partial: false, asOf: '2026-07-25',
    regime: { state: 'neutral', label: '中立', optimismScore: 52, riskScore: 48, confidence: 100, assessmentStatus: 'confirmed', referenceOnly: false, watchOnly: false, decisionEligible: false, tradeEligible: true },
    instruments: {
      vix: { level: 17, available: true, status: 'ok' },
      wti: { level: 72, available: true, status: 'ok' },
      spy: { level: 620, available: true, status: 'ok', source: 'yahoo-chart-v8-adjusted', priceMode: 'adjusted-close' }
    },
    availability: { history: { complete: true }, synchronizedConfirmedSession: { current: true }, adjustedClose: { available: true } },
    meta: { quality: { coveragePct: 100 }, source: { provider: 'Yahoo Finance' } },
    tradeEligible: true
  };
  vm.runInNewContext('confirmed=normalizeMarketRegimePayload(confirmedPayload);', context);
  assert.equal(context.confirmed.watchOnly, false);
  assert.equal(context.confirmed.referenceOnly, false);
  assert.equal(context.confirmed.tradeEligible, false);
});

test('market regime panel is first in the market tab, mobile-safe and not color-only', () => {
  const marketRender = functionBlock('renderMkt', 'addWatch');
  assert.ok(marketRender.indexOf('renderMarketRegimePanel()') < marketRender.indexOf('renderIntelligenceOSPanel()'));
  assert.match(html, /id="market-risk-regime"/);
  assert.match(html, /MARKET RISK REGIME/);
  assert.match(html, /VIX・WTI原油・SPYの日次確定終値を複合監視/);
  assert.match(html, /WATCH ONLY \/ \$\{quality\}/);
  assert.match(html, /市場レジームを取得できませんでした[\s\S]*?再試行/);
  assert.match(html, /\.regime-instrument\{[^}]*grid-template-columns:minmax\(54px/);
  assert.match(html, /@media\(max-width:360px\)\{[\s\S]*?\.regime-instrument\{grid-template-columns:45px 54px repeat\(3,minmax\(38px,1fr\)\)/);
  assert.match(html, /aria-label="\$\{period\.toUpperCase\(\)\} \$\{word\}/);
  assert.match(html, /VIX 実線/);
  assert.match(html, /WTI 破線/);
  assert.match(html, /SPY 点線/);
  assert.match(html, /role="img" aria-labelledby="regime-pulse-title regime-pulse-desc"/);
  const panelSource = functionBlock('renderMarketRegimePanel', 'intelligenceRrgPromptContexts');
  assert.match(panelSource, /MarketRegime\.riskScore==null\?'N\/A':MarketRegime\.riskScore\.toFixed\(0\)/);
  assert.match(panelSource, /MarketRegime\.optimismScore==null\?'N\/A':MarketRegime\.optimismScore\.toFixed\(0\)/);
  assert.match(panelSource, /データ品質/);
  assert.match(panelSource, /最新確定終値/);
  assert.match(panelSource, /CONTEXT ONLY \/ \$\{quality\}/);
  assert.match(panelSource, /モデル指数（確率・期待リターンではない）/);
  assert.match(panelSource, /\$\{sourceBase\}（非公式\$\{MarketRegime\.meta\.bestEffort===true\?'・best effort':''\}）/);
  assert.match(readme, /riskScore` \/ `optimismScore`[\s\S]*?暴落確率・上昇確率・期待リターンではありません/);
  assert.match(functionBlock('marketRegimeInstrumentRow', 'marketRegimePulseChart'), /row\?\.key==='vix'\?row\?\.changesPoints/);
  assert.match(html, /change20dPoints:key==='vix'\?row\.changesPoints/);
});

test('market regime pulse uses one confirmed-session axis and breaks paths at missing observations', () => {
  const source = functionBlock('marketRegimePulseChart', 'marketRegimePromptContext');
  const dates = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'];
  const points = values => dates.map((date, index) => ({ date, relativePct: values[index] }));
  const context = {
    MarketRegime: { instruments: {
      vix: { trail: points([0, 1, null, 2, 3]) },
      wti: { trail: points([0, 1, 2, 3, 4]) },
      spy: { trail: points([0, null, 2, 3, 4]) }
    } },
    esc: value => String(value)
  };
  vm.runInNewContext(`${source}; result=marketRegimePulseChart();`, context);
  const paths = [...context.result.matchAll(/<path class="(vix|wti|spy)" d="([^"]+)"/g)].map(match => ({ key: match[1], d: match[2] }));
  const vixPaths = paths.filter(path => path.key === 'vix');
  const wtiPath = paths.find(path => path.key === 'wti');
  assert.equal(vixPaths.length, 2);
  assert.match(vixPaths[0].d, /^M18\.0,[\d.]+ L89\.0,/);
  assert.match(vixPaths[1].d, /^M231\.0,/);
  assert.doesNotMatch(vixPaths[0].d, /231\.0/);
  assert.match(wtiPath.d, /L231\.0,/);
  assert.match(context.result, /全系列を同じ確定営業日の日付軸/);
  assert.match(context.result, /欠損日は線を分割し、補間や直線接続をしません/);
});

test('market regime cache, fetch and AI context fail closed for stale or partial observations', () => {
  assert.equal((html.match(/fetch\(base\+path/g) || []).length, 1);
  assert.match(html, /const MARKET_REGIME_CACHE='uscmd_market_regime_v1'/);
  assert.match(html, /store\.get\(MARKET_REGIME_CACHE\)/);
  assert.match(html, /store\.set\(MARKET_REGIME_CACHE,JSON\.stringify\(data\)\)/);
  const decisionSource = functionBlock('marketRegimeIsStale', 'marketRegimeDecisionUsable') + functionBlock('marketRegimeDecisionUsable', 'adoptMarketRegimePayload');
  const context = {
    Date,
    MARKET_REGIME_LABELS: { danger: '危険', caution: '警戒', neutral: '中立', optimistic: '楽観' },
    MarketRegime: { status: 'ready', sourceStatus: 'ok', asOf: new Date().toISOString(), updatedAt: '', label: 'danger', fromCache: false, watchOnly: false, referenceOnly: false, availability: { stale: false, partial: false }, meta: { stale: false } }
  };
  vm.runInNewContext(`${decisionSource}; live=marketRegimeDecisionUsable(); MarketRegime.fromCache=true; cached=marketRegimeDecisionUsable(); MarketRegime.fromCache=false; MarketRegime.availability.partial=true; partial=marketRegimeDecisionUsable();`, context);
  assert.equal(context.live, true);
  assert.equal(context.cached, false);
  assert.equal(context.partial, false);
  const aiSource = functionBlock('marketRegimePromptContext', 'renderMarketRegimePanel') + functionBlock('requestIntelligenceAnalysis', 'intelligenceCategoryName') + functionBlock('analyzeTheme', 'themeLeaderRows');
  assert.match(aiSource, /VIXはSPXオプション由来の約30日予想変動率で株価方向の予測ではない/);
  assert.match(aiSource, /原油上昇または下落だけで危険・楽観を断定しない/);
  assert.match(aiSource, /CL=Fは期近先物/);
  assert.match(aiSource, /売買助言・発注条件ではない/);
  assert.match(aiSource, /partial\/stale\/watch-only\/reference-only\/N\/A/);
  assert.match(aiSource, /source:row\.source\|\|MarketRegime\.meta\.inputs/);
  assert.match(aiSource, /priceMode:row\.priceMode\|\|null/);
  assert.match(aiSource, /scoreSemantics:'complementary heuristic model indices; not probabilities or expected returns'/);
  assert.match(aiSource, /暴落確率・上昇確率・期待リターンではない/);
  assert.match(aiSource, /provenance:\{provider:MarketRegime\.meta\.source\|\|null,official:MarketRegime\.meta\.official,bestEffort:MarketRegime\.meta\.bestEffort,inputs:MarketRegime\.meta\.inputs\|\|\{\}\}/);
  assert.match(aiSource, /非公式な単一ソースをbest effortで利用/);
});

test('market regime wins the Render cold-start queue and refreshes only after fifteen minutes', () => {
  const macroInit = functionBlock('marketRegimeInit', 'fetchMarketRegime');
  const intelligenceInit = functionBlock('intelligenceInit', 'fetchIntelligence');
  const macroDelay = Number(macroInit.match(/setTimeout\(\(\)=>fetchMarketRegime\(true,false\),(\d+)\)/)?.[1]);
  const intelligenceDelay = Number(intelligenceInit.match(/setTimeout\(\(\)=>fetchIntelligence\(true\),(\d+)\)/)?.[1]);
  assert.equal(macroDelay, 15);
  assert.equal(intelligenceDelay, 45);
  assert.ok(macroDelay < intelligenceDelay);
  assert.match(html, /function refreshMarketRegimeIfAged\(\)\{[\s\S]*?15\*60\*1000/);
  assert.match(html, /if\(t==='mkt'\)refreshMarketRegimeIfAged\(\)/);
  assert.match(html, /visibilitychange[\s\S]*?else refreshMarketRegimeIfAged\(\)/);
  assert.match(functionBlock('fetchMarketRegime', 'refreshMarketRegimeIfAged'), /finally\{clearTimeout\(timer\);MarketRegime\.loading=false;renderHUD\(\)/);
});

test('global data sync updates VIX and WTI with the same manual action as stocks and FX', () => {
  assert.match(html, /id="syncbtn"[^>]+title="株価・為替・VIX・WTI原油を同期"[^>]+aria-label="株価・為替・VIX・WTI原油を同期"/);
  const fetchSource = functionBlock('fetchMarketRegime', 'marketRegimeSyncSnapshot');
  const syncSource = functionBlock('runBotSync', 'botSync');
  const panelSource = functionBlock('renderMarketRegimePanel', 'intelligenceRrgPromptContexts');
  const connectionSource = functionBlock('syncMarketRegimeText', 'renderLog');
  assert.match(fetchSource, /forceRefresh===true\?'\?refresh=1':''/);
  assert.match(syncSource, /const regimeRefresh=fetchMarketRegime\(true,!auto\)/);
  assert.match(syncSource, /await regimeRefresh/);
  assert.match(syncSource, /marketRegime=marketRegimeSyncSnapshot\(!auto\)/);
  assert.match(syncSource, /marketRegimeAnyCurrent=\['ready','partial'\]\.includes[^;]+cache!=='stale-fallback'/);
  assert.match(syncSource, /anySuccess=[^;]+marketRegimeAnyCurrent/);
  assert.match(syncSource, /marketRegimeIncomplete/);
  assert.match(syncSource, /marketRegime,batchErrors/);
  assert.match(panelSource, /fetchMarketRegime\(false,true\)/);
  assert.match(connectionSource, /VIX \/ WTI: \$\{esc\(syncMarketRegimeText\(st\)\)\}/);
  assert.match(connectionSource, /短時間内の再操作/);
  assert.match(connectionSource, /休場中や新しい終値の確定前/);
  assert.match(html, /株価・USD\/JPY・VIX・WTI 同期中/);
});

test('market regime requests share work and queue exactly one manual force behind a normal refresh', async () => {
  const start = html.indexOf('let marketRegimePromise=');
  const end = html.indexOf('async function runMarketRegimeFetch(', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const context = {
    runMarketRegimeFetch(silent, force) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      calls.push({ silent, force, resolve });
      return promise;
    }
  };
  vm.runInNewContext(html.slice(start, end), context);
  const normal1 = context.fetchMarketRegime(true, false);
  const normal2 = context.fetchMarketRegime(true, false);
  const queuedForce1 = context.fetchMarketRegime(true, true);
  const queuedForce2 = context.fetchMarketRegime(false, true);
  assert.equal(normal1, normal2);
  assert.equal(queuedForce1, queuedForce2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].force, false);
  calls[0].resolve(true);
  await normal1;
  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].force, true);
  const activeForce1 = context.fetchMarketRegime(true, true);
  const activeForce2 = context.fetchMarketRegime(false, true);
  const normalDuringForce = context.fetchMarketRegime(true, false);
  assert.equal(activeForce1, activeForce2);
  assert.equal(activeForce1, normalDuringForce);
  calls[1].resolve(true);
  await Promise.all([queuedForce1, activeForce1]);
  assert.equal(calls.length, 2);
});

test('AI analyses pin the market regime revision, reject legacy context and fail closed after it changes', () => {
  const helper = functionBlock('marketRegimeAnalysisIsOld', 'intelligenceAnalysisIsOld');
  const context = { MarketRegime: { status: 'ready', label: 'neutral', dataRevision: 'macro-r2', asOf: '2026-07-25' } };
  vm.runInNewContext(`${helper}; legacyReady=marketRegimeAnalysisIsOld({marketRegimeContextIncluded:false}); MarketRegime.status='idle'; MarketRegime.label=''; MarketRegime.dataRevision=''; idleLegacy=marketRegimeAnalysisIsOld({concl:'attack'}); Object.assign(MarketRegime,{status:'ready',label:'neutral',dataRevision:'macro-r2'}); same=marketRegimeAnalysisIsOld({marketRegimeContextIncluded:true,marketRegimeRevision:'macro-r2',marketRegimeAsOf:'2026-07-25'}); changed=marketRegimeAnalysisIsOld({marketRegimeContextIncluded:true,marketRegimeRevision:'macro-r1',marketRegimeAsOf:'2026-07-24'}); MarketRegime.status='error'; unavailable=marketRegimeAnalysisIsOld({marketRegimeContextIncluded:true,marketRegimeRevision:'macro-r2'}); MarketRegime.dataRevision=''; missingCurrent=marketRegimeAnalysisIsOld({marketRegimeContextIncluded:true,marketRegimeRevision:'macro-r2'});`, context);
  assert.equal(context.legacyReady, true);
  assert.equal(context.idleLegacy, true);
  assert.equal(context.same, false);
  assert.equal(context.changed, true);
  assert.equal(context.unavailable, true);
  assert.equal(context.missingCurrent, true);

  const intelligenceRequest = functionBlock('requestIntelligenceAnalysis', 'intelligenceCategoryName');
  const themeRequest = functionBlock('analyzeTheme', 'themeLeaderRows');
  assert.match(intelligenceRequest, /marketRegimeRevisionAtRequest=safeText\(MarketRegime\.dataRevision,96\)/);
  assert.match(intelligenceRequest, /marketRegimeRevision:marketRegimeRevisionAtRequest/);
  assert.match(themeRequest, /marketRegimeContextAtRequest=marketRegimePromptContext\(\),marketRegimeRevisionAtRequest=/);
  assert.match(themeRequest, /marketRegimeRevision:marketRegimeRevisionAtRequest/);
  assert.match(html, /MarketRegime\.promptRevision=safeText\(MarketRegime\.dataRevision,96\)/);
  assert.match(html, /marketRegimeRevision:safeText\(MarketRegime\.promptRevision,96\)/);
  assert.match(html, /marketRegimeContextIncluded:true/);
  assert.match(html, /marketRegimeContextIncluded:rm\.marketRegimeContextIncluded===true/);
  assert.match(html, /marketRegimeRevision:safeText\(a\.marketRegimeRevision,96\)/);
});

test('stale macro AI cannot drive the HUD verdict alerts or rank actions', () => {
  const calcSource = functionBlock('calc', 'renderHUD');
  const hudSource = functionBlock('renderHUD', 'renderOps');
  const rankSource = functionBlock('rankDo', 'normalizeRegimeInstrument');
  assert.match(calcSource, /aiMarketCurrent=S\.ai\?\.market&&!marketRegimeAnalysisIsOld\(S\.ai\.market\)\?S\.ai\.market:null/);
  assert.match(calcSource, /const concl=aiMarketCurrent\?\.concl/);
  assert.doesNotMatch(calcSource, /const concl=S\.ai\?\.market\?\.concl/);
  assert.match(hudSource, /\.\.\.\(aiMarketCurrent\?\.alerts\|\|\[\]\)/);
  assert.match(rankSource, /if\(marketRegimeAnalysisIsOld\(S\.ai\?\.market\)\)return toast/);
  assert.match(html, /macroAnalysisOld\?'disabled aria-disabled="true"'/);
  assert.match(html, /VIX・WTI・SPYレジームはリスクコメント専用/);
  assert.match(html, /Trade Gateや自動発注へ接続しない/);
});

test('position AI advice cannot change stop or take prices after the macro revision changes', () => {
  const source = functionBlock('adoptAdvice', 'renderAI');
  const position = { id: 'p1', ticker: 'NVDA', stopPx: 90, takePx: 130, aiAdvice: { stopPx: 100, takePx: 150, marketRegimeContextIncluded: true, marketRegimeRevision: 'old' } };
  const context = {
    S: { positions: [position] },
    marketRegimeAnalysisIsOld: () => true,
    toast: message => { context.message = message; },
    beep: () => {}, save: () => {}, renderAll: () => {}, shisa: () => {}
  };
  vm.runInNewContext(`${source}; adoptAdvice('p1');`, context);
  assert.equal(position.stopPx, 90);
  assert.equal(position.takePx, 130);
  assert.match(context.message, /再分析/);
  assert.match(html, /aiAdvice:ad\?\{[\s\S]*?marketRegimeRevision:safeText\(ad\.marketRegimeRevision,96\)/);
  assert.match(html, /p\.aiAdvice=\{[\s\S]*?marketRegimeRevision:safeText\(MarketRegime\.promptRevision,96\)/);
  assert.match(html, /adviceOld\?'disabled aria-disabled="true"'/);
  assert.match(html, /AI提案\$\{adviceOld\?'（旧市場レジーム・履歴のみ）'/);
});

test('partial VIX or SPY observations remain visible while the regime itself is unavailable', () => {
  const adoptSource = functionBlock('adoptMarketRegimePayload', 'marketRegimeInit');
  const context = {
    MarketRegime: { instruments: {}, availability: {}, meta: {} },
    Object
  };
  context.data = {
    status: 'unavailable', asOf: '2026-07-25', updatedAt: '2026-07-26', dataRevision: 'macro-partial',
    label: 'unavailable', labelText: '判定不能', riskScore: null, optimismScore: null, confidence: 20,
    reasons: [], warnings: ['WTI欠損'],
    instruments: { vix: { value: 22 }, wti: { value: null }, spy: { value: 620 } },
    referenceOnly: true, watchOnly: true, tradeEligible: false, methodology: {}, availability: { partial: true }, meta: {}
  };
  vm.runInNewContext(`${adoptSource}; adoptMarketRegimePayload(data,false); result={status:MarketRegime.status,label:MarketRegime.label,vix:MarketRegime.instruments.vix.value};`, context);
  assert.equal(context.result.status, 'partial');
  assert.equal(context.result.label, 'unavailable');
  assert.equal(context.result.vix, 22);
  const fetchSource = functionBlock('fetchMarketRegime', 'refreshMarketRegimeIfAged');
  assert.doesNotMatch(fetchSource, /data\.label==='unavailable'\|\|/);
  assert.match(fetchSource, /if\(!Object\.values\(data\.instruments\)\.some\(row=>row\.value!=null\)\)throw/);
  const panelSource = functionBlock('renderMarketRegimePanel', 'intelligenceRrgPromptContexts');
  assert.match(panelSource, /MarketRegime\.labelText\|\|MARKET_REGIME_LABELS/);
  assert.match(panelSource, /MarketRegime\.riskScore==null\?'N\/A'/);
});

test('buy signal lab has a dedicated accessible six-item tab and mobile-safe controls', () => {
  assert.match(html, /<section class="tab" id="tab-buy" role="tabpanel" aria-labelledby="nav-buy" tabindex="0" hidden>/);
  assert.match(html, /id="nav-buy" data-tab="buy"[^>]*aria-controls="tab-buy"[\s\S]*?>買い<\/button>/);
  assert.match(html, /#nav\{[^}]*grid-template-columns:repeat\(6,1fr\)/);
  assert.match(html, /const renders=\{ops:renderOps,pos:renderPos,ai:renderAI,mkt:renderMkt,buy:renderBuy,log:renderLog\}/);
  assert.match(functionBlock('switchTab', 'renderAll'), /if\(t==='buy'\)buySignalsInit\(\)/);
  assert.match(html, /\['ArrowLeft','ArrowRight','Home','End'\]/);
  assert.match(html, /@media\(max-width:520px\)\{[\s\S]*\.buy-actions\{grid-template-columns:1fr\}/);
  assert.match(html, /#tab-buy \.buy-summary,#tab-buy \.buy-list\{grid-column:1\/-1\}/);
});

test('buy signal request uses at most twenty unique local symbols and marks device context unverified', () => {
  const source = functionBlock('buySignalSymbols', 'buySignalValueText');
  const now = new Date().toISOString();
  const positions = Array.from({ length: 12 }, (_, index) => ({
    ticker: `P${index}`, shares: index + 1, avgCost: 10, price: 12, currency: 'USD', role: 'trade', stopPx: 9, takePx: 16,
    syncedAt: now, priceSource: 'api', freshness: 'live', stale: false
  }));
  const state = {
    settings: { usdJpy: 150, fxSource: 'api', fxFreshness: 'live', fxRetrievedAt: now, fxStale: false },
    cash: { jpy: 100000, usd: 1000 },
    positions,
    watch: ['P0', ...Array.from({ length: 12 }, (_, index) => `W${index}`)],
    shadow: [{ t: 'W0' }, { t: 'SHADOW' }],
    events: [{ ticker: 'P0', date: '2026-08-01', label: '<決算>' }],
    news: [{ t: 'P0', h: '<script>alert(1)</script>', src: 'device', at: '2026-07-30' }]
  };
  const context = {
    S: state,
    normalizeTicker: value => String(value || '').trim().toUpperCase().replace(/\s+/g, ''),
    TICKER_RE: /^[A-Z0-9^][A-Z0-9.^=\/-]{0,19}$/,
    safeText: (value, max = 1000) => String(value ?? '').slice(0, max),
    safeStrings: (value, maxItems = 100, maxLen = 500) => Array.isArray(value) ? value.slice(0, maxItems).map(item => String(item ?? '').slice(0, maxLen)) : []
  };
  vm.runInNewContext(`${source}; result=buySignalRequestPayload(S);`, context);
  const payload = JSON.parse(JSON.stringify(context.result));
  assert.equal(payload.mode, 'SIMULATE');
  assert.equal(payload.symbols.length, 20);
  assert.equal(new Set(payload.symbols).size, 20);
  assert.deepEqual(payload.symbols.slice(0, 3), ['P0', 'P1', 'P2']);
  assert.equal(payload.account.mode, 'SIMULATE');
  for (const key of ['equityJpy', 'cashJpy', 'usdJpy', 'riskBudgetJpy', 'existingOpenRiskJpy', 'existingTickerValueJpy', 'maxPositionPct', 'slippageBufferPct']) assert.equal(typeof payload.account[key], 'number', `${key} should be numeric`);
  assert.equal(payload.account.inputComplete, true);
  assert.deepEqual(payload.account.warnings, []);
  assert.equal(payload.context.verified, false);
  assert.equal(payload.context.source, 'device-local-unverified');
  assert.equal(payload.context.events[0].verification, 'unverified');
  assert.equal(payload.context.news[0].verification, 'unverified');
  assert.equal(payload.positions.length, 12);

  const missing = JSON.parse(JSON.stringify(state));
  missing.positions[0].price = null;
  missing.positions[0].stopPx = null;
  context.S = missing;
  vm.runInNewContext('missingResult=buySignalRequestPayload(S);', context);
  const missingPayload = JSON.parse(JSON.stringify(context.missingResult));
  assert.equal(missingPayload.positions.some(position => position.symbol === 'P0'), false);
  assert.match(missingPayload.account.warnings.join(' '), /P0.*現在値.*STOP/);
  assert.equal(missingPayload.account.existingOpenRiskJpy > 0, true);

  missing.settings.fxSource = 'manual';
  context.S = missing;
  vm.runInNewContext('missingFx=buySignalRequestPayload(S);', context);
  assert.equal(Object.hasOwn(context.missingFx.account, 'usdJpy'), false);
  assert.equal(Object.hasOwn(context.missingFx.account, 'riskBudgetJpy'), false);
  assert.equal(context.missingFx.positions.length, 0);
  assert.match(context.missingFx.account.warnings[0], /USD\/JPY/);
});

test('buy signal response is fail-closed and always exposes exactly eight checks', () => {
  const source = functionBlock('buySignalValueText', 'buySignalStatusLabel');
  const signalDefinitions = [
    { key: 'rsiRecovery', label: 'RSI売られ過ぎ反転' }, { key: 'macdGoldenCross', label: 'MACDゴールデンクロス' },
    { key: 'ema20Recovery', label: 'EMA20回復' }, { key: 'ema50Recovery', label: 'EMA50回復' },
    { key: 'volumeExpansion', label: '出来高拡大' }, { key: 'supportBounce', label: '支持帯反発' },
    { key: 'themeStrength', label: 'テーマ強度' }, { key: 'fundamentalNews', label: '決算・材料' }
  ];
  const now = new Date().toISOString().slice(0, 10);
  const context = {
    BUY_SIGNAL_DEFINITIONS: signalDefinitions,
    BUY_SIGNAL_DEFAULTS: signalDefinitions.map(row => row.label),
    safeText: (value, max = 1000) => String(value ?? '').slice(0, max),
    normalizeTicker: value => String(value || '').trim().toUpperCase().replace(/\s+/g, ''),
    TICKER_RE: /^[A-Z0-9^][A-Z0-9.^=\/-]{0,19}$/,
    buySignalTimestampFresh: value => /^\d{4}-\d{2}-\d{2}/.test(String(value || ''))
  };
  context.payload = {
    status: 'ok',
    asOf: now,
    execution: { mode: 'SIMULATE', autoOrder: false, tradingConnected: false },
    results: [{
      ticker: 'NVDA', status: 'ok', dataStatus: 'ok', available: true, active: true, asOf: now, price: 190, score: 91, decision: 'BUY_CANDIDATE',
      signals: signalDefinitions.map((definition, index) => ({
        ...definition,
        available: definition.key !== 'supportBounce',
        passed: definition.key !== 'supportBounce' && index < 6,
        value: definition.key === 'supportBounce' ? null : index,
        reason: definition.key === 'supportBounce' ? 'Volume Profile未接続のためunavailable' : ''
      })),
      indicators: {
        daily: { available: true, asOf: now, price: 190, rsi14: 58, macd: { line: 2, signal: 1, histogram: 1 }, ema20: 180, ema50: 170, ema200: 140, rvol20: 1.4 },
        weekly: { available: true, asOf: now, price: 190, rsi14: 61, macd: { line: 3, signal: 2, histogram: 1 }, ema20: 160, ema50: 140, ema200: 100, rvol20: 1.2 }
      },
      theme: { name: '<AI>' }, leveragedProduct: false, leverageBlocked: false,
      riskReward: { ratio: 2.5, passed: true }, positionPlan: { amountJpy: 100000, shares: 3, entry: 190, stop: 180, take: 215 },
      fundamental: { earningsDays: 20 }, quality: { status: 'verified', priceMode: 'adjusted', adjusted: true, sufficient: true, stale: false }, warnings: ['<注意>'], provenance: { price: 'provider' }
    }]
  };
  vm.runInNewContext(`${source}; ready=normalizeBuySignalResponse(payload,['NVDA']); partial=normalizeBuySignalResponse({...payload,status:'partial'}); stale=normalizeBuySignalResponse({...payload,results:[{...payload.results[0],status:'stale',stale:true}]}); rrFailed=normalizeBuySignalResponse({...payload,results:[{...payload.results[0],riskReward:{ratio:1.2,passed:false}}]}); technical=normalizeBuySignalResult({...payload.results[0],status:undefined,indicators:undefined,dataStatus:'ok',technical:payload.results[0].indicators}); missingKey=normalizeBuySignalResponse({...payload,results:[{...payload.results[0],signals:payload.results[0].signals.slice(0,7)}]},['NVDA']); duplicateKey=normalizeBuySignalResponse({...payload,results:[{...payload.results[0],signals:[...payload.results[0].signals.slice(0,7),payload.results[0].signals[0]]}]},['NVDA']); bad=false;try{normalizeBuySignalResponse({...payload,execution:{mode:'LIVE',autoOrder:true,tradingConnected:true}})}catch(e){bad=true}`, context);
  assert.equal(context.ready.status, 'ready');
  assert.equal(context.ready.results[0].usable, true);
  assert.equal(context.ready.results[0].signals.length, 8);
  assert.equal(context.ready.results[0].signals[1].available, true);
  assert.equal(context.ready.results[0].signals[5].available, false);
  assert.equal(context.ready.results[0].signalContractValid, true);
  assert.equal(context.ready.results[0].indicators.daily.status, 'ready');
  assert.match(context.ready.results[0].indicators.daily.ema, /20 180/);
  assert.equal(context.ready.results[0].indicators.daily.rvol, 1.4);
  assert.equal(context.technical.status, 'ready');
  assert.equal(context.technical.indicators.weekly.rvol, 1.2);
  assert.equal(context.rrFailed.results[0].riskReward.blocked, true);
  assert.equal(context.rrFailed.results[0].riskReward.eligible, false);
  assert.equal(context.partial.results[0].usable, true);
  assert.equal(context.stale.results[0].usable, false);
  assert.equal(context.missingKey.results[0].usable, false);
  assert.equal(context.duplicateKey.results[0].usable, false);
  assert.equal(context.bad, true);
  assert.equal(context.ready.execution.autoOrder, false);
  assert.equal(context.ready.execution.tradingConnected, false);
});

test('buy signal UI separates daily and weekly evidence, shows restrictions and never exposes an order action', () => {
  const cardSource = functionBlock('buySignalCard', 'addBuySignalShadow');
  const fetchSource = functionBlock('fetchBuySignals', 'renderBuy');
  const renderSource = functionBlock('renderBuy', 'renderMkt');
  assert.match(cardSource, /buySignalIndicatorHtml\(result\.indicators\.daily,'日足'\)/);
  assert.match(cardSource, /buySignalIndicatorHtml\(result\.indicators\.weekly,'週足'\)/);
  assert.match(cardSource, /8信号チェックリスト/);
  assert.match(cardSource, /レバレッジ制限/);
  assert.match(cardSource, /高値追い制限/);
  assert.match(cardSource, /決算接近制限/);
  assert.match(cardSource, /RR \$\{esc\(rr\)\}/);
  assert.match(html, /\.buy-card\.strong/);
  assert.match(html, /\.buy-card\.buy/);
  assert.match(html, /\.buy-card\.check/);
  assert.match(html, /\.buy-card\.wait/);
  assert.match(html, /\.buy-card\.avoid/);
  assert.match(cardSource, /decisionMeta=buySignalDecisionMeta\(safeDecision\)/);
  assert.match(cardSource, /\$\{!eligible\|\|shadowed\?'disabled aria-disabled="true"':''\}/);
  assert.equal((cardSource.match(/<button /g) || []).length, 3);
  assert.match(cardSource, />SHADOW追加<\/button>/);
  assert.match(cardSource, />監視追加<\/button>/);
  assert.match(cardSource, />再分析<\/button>/);
  assert.doesNotMatch(cardSource, /onclick="[^"]*(?:order|trade)/i);
  assert.match(fetchSource, /fetch\(base\+'\/api\/buy-signals',\{method:'POST'/);
  assert.match(fetchSource, /BuySignals\.results=\[\]/);
  assert.match(fetchSource, /BuySignals\.status='unavailable';BuySignals\.asOf='';BuySignals\.results=\[\]/);
  assert.match(fetchSource, /buySignalQueuedRefreshPromise=buySignalPromise\.then\(\(\)=>fetchBuySignals\(true\)\)/);
  assert.match(renderSource, /AUTO ORDER OFF/);
  assert.match(renderSource, /端末events\/newsはunverified context/);
  assert.match(renderSource, /status!=='ready'/);
  const syncSource = functionBlock('runBotSync', 'botSync');
  assert.ok((syncSource.match(/if\(cur==='buy'\)fetchBuySignals\(true\)/g) || []).length >= 2);
});

test('buy signal SHADOW is disabled and handler-defended for every hard restriction', () => {
  const gateAndCardSource = functionBlock('buySignalPrice', 'addBuySignalShadow');
  const handlerSource = functionBlock('addBuySignalShadow', 'addBuySignalWatch');
  const base = {
    symbol: 'NVDA',
    status: 'ready',
    stale: false,
    usable: true,
    available: true,
    active: true,
    activeCount: 8,
    availableCount: 8,
    price: 190,
    score: 90,
    decision: 'BUY_CANDIDATE',
    theme: 'AI半導体',
    earningsDays: 20,
    earningsBlocked: false,
    leveragedProduct: false,
    leverageBlocked: false,
    chaseBlocked: false,
    chaseText: '',
    riskReward: { ratio: 2.2, minimum: 1.8, eligible: true, blocked: false, reason: '' },
    positionPlan: { amountJpy: 100000, shares: 3, entry: 190, stop: 180, take: 215 },
    indicators: {
      daily: { status: 'ready', rsi: 58, macd: 'up', ema: 'bullish', rvol: 1.4 },
      weekly: { status: 'ready', rsi: 61, macd: 'up', ema: 'bullish', rvol: 1.2 }
    },
    signals: [],
    fundamental: {},
    quality: {},
    warnings: [],
    provenance: []
  };
  const context = {
    BUY_SIGNAL_STATUS: ['ready', 'partial', 'stale', 'unavailable'],
    BuySignals: { results: [], loading: false, focusKey: '' },
    S: { positions: [], watch: [], shadow: [] },
    globalStop: false,
    calc: () => ({ crits: context.globalStop ? 1 : 0 }),
    TICKER_RE: /^[A-Z0-9^][A-Z0-9.^=\/-]{0,19}$/,
    normalizeTicker: value => String(value || '').trim().toUpperCase(),
    todayStr: () => '2026-07-30',
    safeText: (value, max = 1000) => String(value ?? '').slice(0, max),
    esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
    toast: message => { context.lastToast = message; },
    uid: () => 'shadow-id',
    save: () => {},
    renderAll: () => {},
    botSync: () => {}
  };
  vm.runInNewContext(`${gateAndCardSource};${handlerSource}`, context);

  const blockedCases = [
    ['leveraged product', { leveragedProduct: true }],
    ['leverage block', { leverageBlocked: true }],
    ['chase block', { chaseBlocked: true }],
    ['earnings within three days', { earningsDays: 3 }],
    ['risk reward below 1.8', { riskReward: { ratio: 1.79, minimum: 1, eligible: true, blocked: false } }],
    ['global stop', {}, true],
    ['non-buy decision', { decision: 'WATCH' }],
    ['unusable data', { usable: false }],
    ['inactive result', { active: false }]
  ];
  for (const [label, override, globalStop = false] of blockedCases) {
    const result = { ...base, ...override };
    context.BuySignals.results = [result];
    context.S.shadow = [];
    context.globalStop = globalStop;
    context.result = result;
    context.stop = globalStop;
    vm.runInNewContext('card=buySignalCard(result,0,stop);addBuySignalShadow(0);', context);
    const shadowButton = context.card.match(/<button[^>]*onclick="addBuySignalShadow\(0\)"[^>]*>/)?.[0] || '';
    assert.match(shadowButton, /disabled aria-disabled="true"/, `${label} must disable SHADOW`);
    assert.equal(context.S.shadow.length, 0, `${label} must be rejected again by the handler`);
  }

  context.BuySignals.results = [{ ...base }];
  context.S.shadow = [];
  context.globalStop = false;
  vm.runInNewContext('addBuySignalShadow(0);', context);
  assert.equal(context.S.shadow.length, 1);
  assert.equal(context.S.shadow[0].t, 'NVDA');
  assert.equal(context.S.shadow[0].a, 'probe');
});

test('buy signal requests share in-flight work, queue one forced rerun and discard data after failure', async () => {
  const source = functionBlock('fetchBuySignals', 'renderBuy');
  const deferred = [];
  const responseBody = {
    status: 'ready', asOf: '2026-07-30', results: [{ symbol: 'NVDA' }],
    execution: { mode: 'SIMULATE', autoOrder: false, tradingConnected: false }
  };
  const context = {
    BuySignals: { initialized: false, loading: false, status: 'idle', asOf: '', results: [{ symbol: 'OLD' }], error: '', execution: {}, focusKey: '' },
    buySignalRequestPayload: () => ({ mode: 'SIMULATE', refresh: false, symbols: ['NVDA'], account: {}, context: { verified: false } }),
    document: { activeElement: null },
    cur: 'buy',
    renderBuy: () => { context.renders = (context.renders || 0) + 1; },
    S: { settings: { apiBase: '', apiToken: '' } },
    AbortController,
    setTimeout: () => 1,
    clearTimeout: () => {},
    safeText: (value, max = 1000) => String(value ?? '').slice(0, max),
    safeStrings: (value, maxItems = 100, maxLen = 500) => Array.isArray(value) ? value.slice(0, maxItems).map(item => String(item ?? '').slice(0, maxLen)) : [],
    buySignalInputRevision: payload => JSON.stringify({
      symbols: payload?.symbols || [],
      account: payload?.account || {},
      positions: payload?.positions || [],
      context: payload?.context || {}
    }),
    normalizeBuySignalResponse: body => body,
    fetch: (url, options) => new Promise(resolve => deferred.push({ url, options, resolve }))
  };
  vm.runInNewContext(`let buySignalPromise=null,buySignalPromiseForced=false,buySignalQueuedRefreshPromise=null;${source};p1=fetchBuySignals(false);p2=fetchBuySignals(false);q1=fetchBuySignals(true);q2=fetchBuySignals(true);`, context);
  assert.equal(context.p1, context.p2);
  assert.equal(context.q1, context.q2);
  assert.notEqual(context.p1, context.q1);
  assert.equal(deferred.length, 1);
  assert.equal(context.BuySignals.results.length, 0);
  assert.equal(JSON.parse(deferred[0].options.body).refresh, false);
  deferred[0].resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => responseBody });
  await context.p1;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deferred.length, 2);
  assert.equal(JSON.parse(deferred[1].options.body).refresh, true);
  deferred[1].resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => responseBody });
  await context.q1;
  assert.equal(context.BuySignals.status, 'ready');
  assert.equal(context.BuySignals.results[0].symbol, 'NVDA');

  context.fetch = async () => { throw new Error('network down'); };
  vm.runInNewContext('failed=fetchBuySignals(true);', context);
  await context.failed;
  assert.equal(context.BuySignals.status, 'unavailable');
  assert.equal(context.BuySignals.results.length, 0);
  assert.match(context.BuySignals.error, /network down/);
});
