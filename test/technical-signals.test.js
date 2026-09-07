'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BACKTEST_METHOD_VERSION,
  KNOWN_LEVERAGED_SYMBOLS,
  SIGNAL_DEFINITIONS,
  TECHNICAL_METHOD_VERSION,
  aggregateWeeklyBars,
  buildBuySignalResult,
  buildPositionPlan,
  calculateTechnicalIndicators,
  detectLeveragedProduct,
  emaSeries,
  evaluateEightSignals,
  indicatorSnapshot,
  macdSeries,
  relativeVolumeSeries,
  rsiSeries,
  runTechnicalBacktest,
  sanitizeBars,
  scoreTechnicalSetup,
  strategyState
} = require('../technical-signals');

function weekdayBars(count = 1_320, options = {}) {
  const bars = [];
  const date = new Date(options.start || '2021-01-04T21:00:00Z');
  let session = 0;
  while (bars.length < count) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) {
      const trend = 60 * Math.exp(session * 0.00035);
      const cycle = 1 + Math.sin(session / 7) * 0.045 + Math.sin(session / 23) * 0.015;
      const close = trend * cycle;
      const open = close * (1 - Math.sin(session / 5) * 0.003);
      bars.push({
        timestamp: Math.floor(date.getTime() / 1000),
        at: date.toISOString(),
        sessionDate: date.toISOString().slice(0, 10),
        open,
        high: Math.max(open, close) * 1.007,
        low: Math.min(open, close) * 0.993,
        close,
        volume: 1_000_000 + (session % 17) * 10_000,
        priceMode: options.priceMode || 'adjusted'
      });
      session += 1;
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return bars;
}

function scoringIndicators(overrides = {}) {
  return {
    daily: {
      status: 'ok',
      price: 100,
      open: 98,
      ema20: 95,
      ema50: 90,
      ema200: 80,
      rsi14: 35,
      recentRsi14: [28, 29, 31, 32, 33, 35],
      macd: { line: 1, signal: 0.5, histogram: 0.5 },
      previous: {
        price: 94,
        ema20: 95,
        ema50: 95,
        rsi14: 29,
        macd: { line: 0.2, signal: 0.3, histogram: -0.1 }
      },
      rvol20: 1.7,
      high20: 110,
      priorHigh20: 109,
      priorLow20: 85,
      atr14: 3,
      change5dPct: 5,
      flags: {
        rsiRecovery: true,
        macdGoldenCross: true,
        macdHistogramImproving: true,
        ema20Recovery: true,
        ema50Recovery: true,
        volumeExpansion: true,
        bullishVolume: true
      },
      ...overrides.daily
    },
    weekly: {
      status: 'ok',
      price: 100,
      ema20: 90,
      ema50: 85,
      ema200: 75,
      rsi14: 55,
      macd: { line: 1, signal: 0.5, histogram: 0.5 },
      previous: { macd: { line: 0.7, signal: 0.5, histogram: 0.2 } },
      ...overrides.weekly
    }
  };
}

const strongTheme = {
  id: 'ai-semiconductors',
  name: 'AI半導体',
  status: 'ok',
  score: 80,
  trend: 'up',
  breadth: 65,
  confidence: 90
};

const positiveFundamental = {
  status: 'ok',
  earningsDays: 20,
  flags: {
    goodEarnings: true,
    guidanceUp: true,
    revenueGrowth: true,
    positiveCatalyst: true,
    negativeMaterial: false
  }
};

test('EMA, RSI, MACD and RVOL use deterministic warm-ups and RVOL excludes the current day', () => {
  const values = Array.from({ length: 40 }, (_, index) => index + 1);
  assert.deepEqual(emaSeries(values, 3).slice(0, 4), [null, null, 2, 3]);
  const rsi = rsiSeries(values, 14);
  assert.equal(rsi[13], null);
  assert.equal(rsi[14], 100);
  const macd = macdSeries(values);
  assert.equal(macd.line[24], null);
  assert.ok(macd.line[25] > 0);
  assert.equal(macd.signal[32], null);
  assert.ok(macd.signal[33] > 0);
  const volumes = Array.from({ length: 21 }, () => 100);
  volumes[20] = 200;
  assert.equal(relativeVolumeSeries(volumes, 20)[20], 2);
  assert.deepEqual(emaSeries([null, 1], 1), [null, null]);
});

test('bars with missing OHLC are rejected rather than silently filled from close', () => {
  const base = {
    timestamp: Date.parse('2026-07-27T20:00:00Z') / 1000,
    sessionDate: '2026-07-27',
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 100,
    priceMode: 'adjusted'
  };
  assert.equal(sanitizeBars([base]).length, 1);
  assert.equal(sanitizeBars([{ ...base, volume: null }])[0].volume, null);
  for (const field of ['open', 'high', 'low']) {
    const invalid = { ...base };
    delete invalid[field];
    assert.equal(sanitizeBars([invalid]).length, 0, `${field} is required`);
  }
});

test('indicator flags keep RSI recovery independent from the current range and require strict 3-bar MACD improvement', () => {
  const previous = {
    sessionDate: '2026-07-29',
    close: 99,
    open: 100,
    ema20: 100,
    ema50: 90,
    ema200: 80,
    rsi14: 45,
    macd: { line: -0.2, signal: -0.1, histogram: -0.1 },
    rvol20: 1,
    high20: 110,
    low20: 85,
    priorHigh20: 109,
    priorLow20: 86,
    atr14: 3
  };
  const row = {
    ...previous,
    sessionDate: '2026-07-30',
    close: 101,
    open: 100,
    ema20: 100.2,
    ema50: 90.2,
    rsi14: 50,
    macd: { line: -0.05, signal: -0.04, histogram: -0.01 },
    rvol20: 1.6
  };
  const recentRows = [
    { rsi14: 28, macd: { histogram: -0.3 } },
    { rsi14: 45, macd: { histogram: -0.1 } },
    row
  ];
  const snapshot = indicatorSnapshot(row, '1d', 1_300, previous, recentRows);
  assert.equal(snapshot.flags.rsi.recoveringFromOversold, true);
  assert.equal(snapshot.flags.rsi.nearOversold, false);
  assert.equal(snapshot.macd.histogramImproving, true);
  assert.equal(snapshot.macd.goldenCross, false);
  assert.equal(snapshot.flags.ema.priceAbove20, true);
  assert.equal(snapshot.flags.ema.ema20CrossUp, true);
  assert.equal(snapshot.flags.ema.slopeUp20, true);
  assert.equal(snapshot.flags.ema.bullishAlignment, true);

  const nonStrict = indicatorSnapshot(
    { ...row, macd: { ...row.macd, histogram: -0.1 } },
    '1d',
    1_300,
    previous,
    [
      { rsi14: 28, macd: { histogram: -0.2 } },
      { rsi14: 45, macd: { histogram: -0.1 } },
      { ...row, macd: { ...row.macd, histogram: -0.1 } }
    ]
  );
  assert.equal(nonStrict.macd.histogramImproving, false);
});

test('leverage detection uses static symbols, Yahoo names, and fails closed for metadata-less ETFs', () => {
  for (const [symbol, name] of [
    ['QLD', 'ProShares Ultra QQQ'],
    ['SSO', 'ProShares Ultra S&P500'],
    ['MSTU', 'T-Rex 2X Long MSTR Daily Target ETF']
  ]) {
    const result = detectLeveragedProduct(symbol, {
      quoteType: 'ETF',
      longName: name
    });
    assert.equal(result.status, 'leveraged', symbol);
    assert.equal(result.source, 'static-leveraged-symbol', symbol);
  }
  assert.equal(detectLeveragedProduct('TEST', {
    quoteType: 'ETF',
    longName: 'Example 2X Daily Long Index ETF'
  }).source, 'yahoo-name-metadata');
  assert.equal(detectLeveragedProduct('SOXL', {}).status, 'leveraged');
  assert.equal(detectLeveragedProduct('NVDA', { quoteType: 'EQUITY' }).status, 'unleveraged');
  assert.equal(detectLeveragedProduct('SPY', { quoteType: 'ETF' }).status, 'unleveraged');
  assert.equal(detectLeveragedProduct('MYST', { quoteType: 'ETF' }).status, 'unavailable');
});

test('weekly bars include a confirmed Friday but exclude Monday-Thursday as incomplete', () => {
  const bars = weekdayBars(1_320);
  const weeks = aggregateWeeklyBars(bars);
  assert.ok(weeks.length >= 250);
  let fridayIndex = bars.length - 1;
  while (fridayIndex > 1 &&
    new Date(`${bars[fridayIndex].sessionDate}T00:00:00Z`).getUTCDay() !== 5) {
    fridayIndex -= 1;
  }
  const fridayBars = bars.slice(0, fridayIndex + 1);
  const thursdayBars = bars.slice(0, fridayIndex);
  const friday = calculateTechnicalIndicators(fridayBars);
  const thursday = calculateTechnicalIndicators(thursdayBars);
  assert.equal(friday.weekly.completedOnly, true);
  assert.equal(friday.weekly.partialCurrentWeekExcluded, false);
  assert.equal(friday.weekly.asOf, fridayBars.at(-1).sessionDate);
  assert.equal(thursday.weekly.partialCurrentWeekExcluded, true);
  assert.ok(thursday.weekly.asOf < thursdayBars.at(-1).sessionDate);
  assert.equal(friday.vwap.available, false);
  assert.equal(friday.volumeProfile.available, false);
});

test('eight tri-state signals use the exact contract and allow only confirmed technical support without volume profile', () => {
  const signals = evaluateEightSignals(scoringIndicators(), strongTheme, positiveFundamental);
  assert.deepEqual(signals.map(signal => signal.key), [
    'rsiRecovery',
    'macdGoldenCross',
    'ema20Recovery',
    'ema50Recovery',
    'volumeExpansion',
    'supportBounce',
    'themeStrength',
    'fundamentalNews'
  ]);
  assert.equal(signals.length, 8);
  assert.equal(SIGNAL_DEFINITIONS.length, 8);
  assert.equal(signals[0].state, true);
  assert.equal(signals[5].state, null);
  assert.equal(signals[5].available, false);
  assert.match(signals[5].reason, /Volume Profile/);

  const missing = evaluateEightSignals(scoringIndicators(), null, null);
  assert.equal(missing[6].state, null);
  assert.equal(missing[7].state, null);

  const bounceIndicators = scoringIndicators({
    daily: {
      price: 102,
      open: 99,
      low: 99.5,
      previous: {
        price: 98,
        ema20: 99,
        ema50: 95,
        rsi14: 35,
        macd: { line: 0.2, signal: 0.3, histogram: -0.1 }
      }
    }
  });
  bounceIndicators.supportCandidates = [
    { type: 'ema200', role: 'major', value: 100, distancePct: 2 }
  ];
  bounceIndicators.volumeProfile = { status: 'unavailable', available: false };
  const bounce = evaluateEightSignals(bounceIndicators, strongTheme, positiveFundamental);
  assert.equal(bounce[5].state, true);
  assert.equal(bounce[5].value, 100);

  const noBreadthRequired = evaluateEightSignals(
    scoringIndicators(),
    { status: 'ok', id: 'theme', name: 'Theme', score: 80, trend: 'flat' },
    positiveFundamental
  );
  assert.equal(noBreadthRequired[6].state, true);
  const partialTheme = evaluateEightSignals(
    scoringIndicators(),
    { status: 'partial', id: 'theme', score: 90, trend: 'up' },
    positiveFundamental
  );
  assert.equal(partialTheme[6].state, null);
});

test('score allocation is exactly daily45 weekly20 theme15 fundamental/news20', () => {
  const score = scoreTechnicalSetup(
    scoringIndicators(),
    strongTheme,
    positiveFundamental,
    { earningsDays: 20, partial: false, stale: false }
  );
  assert.deepEqual(score.groups.map(group => [group.key, group.maximum, group.points]), [
    ['daily', 45, 45],
    ['weekly', 20, 20],
    ['theme', 15, 15],
    ['fundamentalNews', 20, 20]
  ]);
  assert.equal(score.rawScore, 100);
  assert.equal(score.scoreBeforeCaps, 100);
  const missingBreadth = scoreTechnicalSetup(
    scoringIndicators(),
    { ...strongTheme, breadth: null },
    positiveFundamental
  );
  const breadth = missingBreadth.groups
    .find(group => group.key === 'theme').components
    .find(component => component.key === 'themeBreadth60');
  assert.equal(breadth.available, false);
  assert.equal(breadth.value, null);
});

test('all exact deductions are cumulative and separately auditable', () => {
  const indicators = scoringIndicators({
    daily: {
      price: 80,
      ema20: 90,
      ema50: 95,
      ema200: 100,
      rsi14: 85,
      change5dPct: 26,
      high20: 81,
      macd: { line: -1, signal: 0, histogram: -1, deadCross: true },
      flags: {
        rsiRecovery: false,
        macdGoldenCross: false,
        macdHistogramImproving: false,
        ema20Recovery: false,
        ema50Recovery: false,
        volumeExpansion: false,
        bullishVolume: false
      }
    },
    weekly: {
      macd: { line: -1, signal: 0, histogram: -1, deadCross: true },
      previous: { macd: { line: -0.5, signal: 0, histogram: -0.5 } }
    }
  });
  const score = scoreTechnicalSetup(
    indicators,
    strongTheme,
    {
      ...positiveFundamental,
      flags: { ...positiveFundamental.flags, negativeMaterial: true }
    },
    { earningsDays: 2, partial: true, stale: true }
  );
  assert.deepEqual(score.deductions.map(item => [item.key, item.points]), [
    ['rsi70', -10],
    ['rsi80', -10],
    ['fiveDay20', -10],
    ['near20High', -5],
    ['earningsNear', -10],
    ['bothMacdDeath', -15],
    ['belowAllEma', -10],
    ['negativeMaterial', -20],
    ['partial', -10],
    ['stale', -15]
  ]);
  assert.equal(score.scoreBeforeCaps, 0);
});

test('position plan uses fixed +14%/+25% targets, enforces a 10% maximum stop loss and never reverse-engineers RR', () => {
  const plan = buildPositionPlan({
    daily: {
      price: 100,
      ema20: 96,
      ema50: 90,
      priorLow20: 92,
      priorHigh20: 120,
      high20: 120,
      atr14: 3
    }
  }, {
    equityJpy: 10_000_000,
    cashJpy: 2_000_000,
    usdJpy: 150,
    riskBudgetJpy: 100_000,
    existingOpenRiskJpy: 25_000,
    existingTickerValueJpy: 0,
    maxPositionPct: 10,
    slippageBufferPct: 2
  });
  assert.equal(plan.mode, 'SIMULATE');
  assert.equal(plan.tradeEligible, false);
  assert.ok(plan.stop >= plan.entry * 0.9);
  assert.equal(plan.take, plan.take1);
  assert.ok(plan.take2 > plan.take1);
  assert.equal(plan.riskReward, 2);
  assert.ok(plan.shares > 0);
  assert.ok(plan.amountJpy <= 1_000_000);

  const blocked = buildPositionPlan({
    daily: {
      price: 100,
      ema20: 96,
      ema50: 90,
      priorLow20: 92,
      priorHigh20: 120,
      high20: 120,
      atr14: 3
    }
  }, {
    equityJpy: 10_000_000,
    cashJpy: 2_000_000,
    usdJpy: 150,
    riskBudgetJpy: 100_000,
    leveragedProduct: true
  });
  assert.equal(blocked.shares, 0);
  assert.equal(blocked.amount, 0);
});

test('result contract exposes object+list signals, exact decisions and automatic leverage/stale caps', () => {
  const bars = weekdayBars();
  const nowMs = Date.parse(`${bars.at(-1).sessionDate}T23:00:00Z`);
  const result = buildBuySignalResult({
    symbol: 'SOXL',
    history: {
      bars,
      priceMode: 'adjusted',
      source: 'fixture',
      cacheState: 'refreshed'
    },
    theme: strongTheme,
    fundamental: positiveFundamental,
    account: {
      equityJpy: 10_000_000,
      cashJpy: 2_000_000,
      usdJpy: 150,
      riskBudgetJpy: 100_000
    },
    nowMs
  });
  assert.equal(KNOWN_LEVERAGED_SYMBOLS.has('SOXL'), true);
  assert.equal(result.signals.total, 8);
  assert.equal(result.signals.checks, result.signalsList);
  assert.equal(result.dataStatus, result.status);
  assert.equal(result.leverageBlocked, true);
  assert.equal(result.score <= 79, true);
  assert.ok(['check', 'wait', 'avoid'].includes(result.decision));
  assert.equal(result.positionPlan.shares, 0);
  assert.equal(result.positionPlan.amount, 0);
  assert.equal(result.leverageStatus, 'leveraged');
  assert.equal(result.leverageProvenance.source, 'static-leveraged-symbol');
  assert.equal(result.tradeEligible, false);
  assert.equal(result.execution.mode, 'SIMULATE');
  assert.equal(result.provenance.methodVersion, TECHNICAL_METHOD_VERSION);

  const stale = buildBuySignalResult({
    symbol: 'NVDA',
    history: {
      bars,
      priceMode: 'adjusted',
      source: 'fixture',
      cacheState: 'stale'
    },
    theme: strongTheme,
    fundamental: positiveFundamental,
    nowMs
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.score <= 69, true);
  assert.ok(['wait', 'avoid'].includes(stale.decision));

  const unknownEtf = buildBuySignalResult({
    symbol: 'MYST',
    history: {
      bars,
      quoteType: 'ETF',
      priceMode: 'adjusted',
      source: 'fixture',
      cacheState: 'refreshed'
    },
    theme: strongTheme,
    fundamental: positiveFundamental,
    account: {
      equityJpy: 10_000_000,
      cashJpy: 2_000_000,
      usdJpy: 150,
      riskBudgetJpy: 100_000
    },
    nowMs
  });
  assert.equal(unknownEtf.leverageStatus, 'unavailable');
  assert.equal(unknownEtf.leverageBlocked, true);
  assert.ok(unknownEtf.caps.some(cap => cap.key === 'leverage-unavailable'));
  assert.equal(unknownEtf.positionPlan.shares, 0);
  assert.equal(unknownEtf.provenance.leverage.source, 'missing-etf-name-metadata');
});

test('backtest flags implement A-E exactly', () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({
    close: 90 + index,
    open: 89 + index,
    rsi14: [35, 28, 29, 30, 31, 32, 35][index],
    ema20: 97,
    rvol20: index === 6 ? 1.6 : 1,
    macd: index === 5
      ? { line: -0.2, signal: -0.1, histogram: -0.1 }
      : (index === 6
          ? { line: 0.1, signal: 0, histogram: 0.1 }
          : { line: -1, signal: 0, histogram: -1 })
  }));
  rows[5].close = 96;
  rows[5].ema20 = 97;
  rows[6].open = 96;
  rows[6].close = 98;
  rows[6].ema20 = 97;
  assert.equal(strategyState('A', rows, 3), true);
  assert.equal(strategyState('B', rows, 6), true);
  assert.equal(strategyState('C', rows, 6), true);
  assert.equal(strategyState('D', rows, 6), true);
  assert.equal(strategyState('E', rows, 6), true);
});

test('A-E backtests use next open, +5/+10/+20 returns, 70/30 and unknown regime without SPY; F fails closed', () => {
  const bars = weekdayBars();
  const result = runTechnicalBacktest(bars, {
    benchmarkBars: [],
    commissionBps: 2,
    slippageBps: 8,
    priceMode: 'adjusted'
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.methodVersion, BACKTEST_METHOD_VERSION);
  assert.equal(result.split.method, 'chronological-70-30');
  assert.equal(result.strategies.length, 6);
  for (const strategy of result.strategies.slice(0, 5)) {
    assert.match(strategy.id, /^[A-E]$/);
    assert.deepEqual(Object.keys(strategy.horizons), ['5', '10', '20']);
    for (const trade of strategy.trades) {
      assert.ok(trade.entryDate > trade.signalDate);
      assert.ok(trade.exits[5].date >= trade.entryDate);
      assert.ok(trade.exits[10].date > trade.exits[5].date);
      assert.ok(trade.exits[20].date > trade.exits[10].date);
      assert.equal(trade.regime, 'unknown');
    }
  }
  assert.equal(result.strategies.at(-1).id, 'F');
  assert.equal(result.strategies.at(-1).status, 'unavailable');
  assert.match(result.strategies.at(-1).reason, /Point-in-time/);
  assert.equal(result.assumptions.entryExecution, 'next-session open');
});

test('backtest cooperatively aborts before doing CPU work', () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => runTechnicalBacktest(weekdayBars(), { signal: controller.signal }),
    error => error?.code === 'CLIENT_ABORT'
  );
});
