'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
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

test('v13 keeps v12 risk controls and remains v3-storage compatible', () => {
  assert.match(html, /PORTFOLIO X-RAY/);
  assert.match(html, /id="portfolio-xray"/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /STRESS LAB — WHAT IF/);
  assert.equal((html.match(/<button[^>]+data-stress-preset/g) || []).length, 5);
  assert.match(html, /id="stress-results" aria-live="polite"/);
  assert.match(html, /drawdownPct/);
  assert.match(html, /円換算残高DD／入出金未調整／履歴最大180日・最高残高継続/);
  assert.match(html, /<meta property="og:image" content="\/og\.png">/);
  assert.match(html, /TRACE ID/);
  assert.match(html, /qualityParts/);
  assert.match(html, /RISK ENGINE 95/);
  assert.match(html, /TRADE GATE — POSITION SIZER/);
  assert.match(html, /AUTO RECOVERY — DEVICE LOCAL/);
  assert.match(html, /STOP価格での約定は保証されず/);
  assert.match(html, /function orderPlanner\(pre\)\{\s*openTradeGate\(pre\|\|\{\}\)/);
  assert.doesNotMatch(html, /function opToPos\(/);
  assert.match(html, /US COMMAND ULTRA v13\.0 — MARKET THEME INTELLIGENCE EDITION/);
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
    sync: { failures: {}, requestIds: ["bad' onclick='x"] }
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
