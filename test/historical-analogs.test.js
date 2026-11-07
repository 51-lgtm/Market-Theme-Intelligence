'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HISTORICAL_ANALOG_METHOD_VERSION,
  HISTORICAL_ANALOG_RULES,
  buildBuySignalResult,
  buildHistoricalAnalogs,
  calculateIndicatorSeries,
  historicalAnalogMatches,
  historicalAnalogState
} = require('../technical-signals');
const { MarketDataService, parseYahooTechnicalChartHistory } = require('../market-data');
const { createApp, enforceSimulationEnvelope } = require('../server');

// Entirely artificial prices for software tests. Not market evidence and never
// fallback data for the app. Weekdays here are not an exchange calendar.
function syntheticHistory(count = 1_250) {
  const bars = [];
  const day = new Date('2021-01-04T21:00:00Z');
  let close = 100;
  while (bars.length < count) {
    if (![0, 6].includes(day.getUTCDay())) {
      close *= Math.exp(0.0001 + (bars.length % 137) * 0.000004);
      bars.push({ timestamp: day.getTime() / 1000, sessionDate: day.toISOString().slice(0, 10),
        open: close * 0.999, high: close * 1.01, low: close * 0.99, close,
        volume: 100_000, priceMode: 'adjusted' });
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return { bars, source: 'synthetic-software-test-only', interval: '1d',
    priceMode: 'adjusted', status: 'ok', partial: false, ohlcCoveragePct: 100 };
}

function optionsFor(history) {
  return { symbol: 'SYNTH', nowMs: history.bars.at(-1).timestamp * 1000 + 86_400_000 };
}

function assertSuppressed(result, status = 'unavailable') {
  assert.equal(result.status, status);
  assert.ok(result.reason);
  assert.ok(result.reasonCode);
  assert.deepEqual(result.horizons, { 5: null, 10: null, 20: null });
  assert.ok(result.samples.every(sample => sample.returnsPct === null));
  assert.equal(result.analysisOnly, true);
  assert.equal(result.tradeEligible, false);
}

test('same-symbol analogs are deterministic, pure, and auditable descriptive distributions', () => {
  const history = syntheticHistory();
  const before = JSON.stringify(history);
  const options = optionsFor(history);
  const result = buildHistoricalAnalogs(history, options);
  assert.equal(result.status, 'ok');
  assert.equal(result.methodVersion, HISTORICAL_ANALOG_METHOD_VERSION);
  assert.equal(result.methodVersion, 'same-symbol-daily-state-v1');
  assert.deepEqual(buildHistoricalAnalogs(history, options), result);
  assert.equal(JSON.stringify(history), before);
  assert.match(result.inputId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.sample.minimum, 8);
  assert.equal(result.sample.selectedCount, result.samples.length);
  assert.equal(result.sample.candidateCount,
    result.sample.selectedCount + result.sample.overlapExcludedCount);
  assert.ok(result.sample.candidateCount <= result.sample.evaluatedCount);
  assert.equal(result.period.bars, history.bars.length);
  assert.equal(result.asOf, history.bars.at(-1).sessionDate);
  assert.equal(result.currentState.comparisonStartDate, history.bars.at(-20).sessionDate);
  assert.equal(result.unit, '取引足本後');
  assert.equal(result.quality.calendarVerified, false);
  assert.equal(result.quality.volumeUsed, false);
  assert.ok(result.limitations.some(item => item.includes('独立標本ではありません')));
  assert.ok(result.limitations.some(item => item.includes('信頼区間ではありません')));
  const serialized = JSON.stringify(result);
  for (const key of ['winRate', 'targetPrice', 'take1', 'take2', 'forecast', 'probability']) {
    assert.ok(!serialized.includes(`"${key}"`));
  }
});

test('fixed EMA/RSI/ATR matching rules have explicit boundaries and no fitted parameters', () => {
  const base = { close: 100, ema20: 101, ema50: 100, rsi14: 55, atr14: 2 };
  const current = historicalAnalogState(base);
  assert.equal(current.rsiBand, 3);
  assert.equal(historicalAnalogState({ ...base, rsi14: 30 }).rsiBand, 1);
  assert.equal(historicalAnalogState({ ...base, rsi14: 45 }).rsiBand, 2);
  assert.equal(historicalAnalogState({ ...base, rsi14: 70 }).rsiBand, 4);
  assert.equal(historicalAnalogState({ ...base, rsi14: 100 }).rsiBand, 4);
  assert.equal(historicalAnalogState({ ...base, atr14: 0 }), null);
  assert.equal(historicalAnalogState({ ...base, rsi14: 101 }), null);
  assert.equal(historicalAnalogMatches(current, { ...current, atrPct: current.atrPct * 1.5 }), true);
  assert.equal(historicalAnalogMatches(current, { ...current, atrPct: current.atrPct * (2 / 3) }), true);
  assert.equal(historicalAnalogMatches(current, { ...current, atrPct: current.atrPct * 1.50001 }), false);
  assert.equal(historicalAnalogMatches(current, { ...current, atrPct: current.atrPct * 0.66 }), false);
  assert.equal(historicalAnalogMatches(current, { ...current, ema20Above50: false }), false);
  assert.equal(historicalAnalogMatches(current, { ...current, rsiBand: 2 }), false);
  assert.equal(historicalAnalogState({ ...base, ema20: 100 }).ema20Above50, false);
  assert.ok(Object.isFrozen(HISTORICAL_ANALOG_RULES));
});

test('candidate features use only the prefix, even when all future prices change', () => {
  const history = syntheticHistory();
  const index = 399;
  const baseline = historicalAnalogState(calculateIndicatorSeries(history.bars).rows[index]);
  const prefix = historicalAnalogState(calculateIndicatorSeries(history.bars.slice(0, index + 1)).rows.at(-1));
  const changed = structuredClone(history.bars);
  changed.slice(index + 1).forEach(bar => {
    for (const field of ['open', 'high', 'low', 'close']) bar[field] *= 0.01;
  });
  assert.deepEqual(prefix, baseline);
  assert.deepEqual(historicalAnalogState(calculateIndicatorSeries(changed).rows[index]), baseline);
});

test('changing outcomes without changing matched state does not choose different dates', () => {
  const history = syntheticHistory();
  const options = optionsFor(history);
  const baseline = buildHistoricalAnalogs(history, options);
  const changed = structuredClone(history);
  // The first selected signal is index 199. Only its future is changed; all
  // later prices remain rising and keep the same fixed EMA/RSI/ATR categories.
  for (const bar of changed.bars.slice(200)) {
    for (const field of ['open', 'high', 'low', 'close']) bar[field] *= 1.1;
  }
  const result = buildHistoricalAnalogs(changed, options);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.samples.map(sample => sample.signalDate), baseline.samples.map(sample => sample.signalDate));
  assert.notEqual(result.samples[0].returnsPct['5'], baseline.samples[0].returnsPct['5']);
});

test('selection is chronological and outcomes do not overlap each other or the current context', () => {
  const history = syntheticHistory();
  const result = buildHistoricalAnalogs(history, optionsFor(history));
  const indexByDate = new Map(history.bars.map((bar, index) => [bar.sessionDate, index]));
  const rows = calculateIndicatorSeries(history.bars).rows;
  const current = historicalAnalogState(rows.at(-1));
  let previousEnd = -1;
  const expectedSignalDates = [];
  for (let index = 199; index + 20 < history.bars.length - 20; index += 1) {
    if (!historicalAnalogMatches(current, historicalAnalogState(rows[index]))) continue;
    if (index - 19 <= previousEnd) continue;
    expectedSignalDates.push(history.bars[index].sessionDate);
    previousEnd = index + 20;
  }
  assert.deepEqual(result.samples.map(sample => sample.signalDate), expectedSignalDates);
  previousEnd = -1;
  for (const sample of result.samples) {
    const start = indexByDate.get(sample.startDate);
    const signal = indexByDate.get(sample.signalDate);
    const end = indexByDate.get(sample.endDate);
    assert.equal(start, signal - 19);
    assert.equal(end, signal + 20);
    assert.ok(start > previousEnd);
    assert.ok(end < history.bars.length - 20);
    for (const horizon of [5, 10, 20]) {
      assert.equal(sample.horizonEndDates[horizon], history.bars[signal + horizon].sessionDate);
    }
    previousEnd = end;
  }
});

test('median and IQR reproduce the documented close-to-close formula and linear quantiles', () => {
  const history = syntheticHistory();
  const result = buildHistoricalAnalogs(history, optionsFor(history));
  const indexByDate = new Map(history.bars.map((bar, index) => [bar.sessionDate, index]));
  const rounded = value => Math.round(value * 10_000) / 10_000;
  for (const horizon of [5, 10, 20]) {
    const returns = result.samples.map(sample => {
      const index = indexByDate.get(sample.signalDate);
      const value = 100 * (history.bars[index + horizon].close / history.bars[index].close - 1);
      assert.equal(sample.returnsPct[horizon], rounded(value));
      return value;
    }).sort((a, b) => a - b);
    const quantile = p => {
      const position = (returns.length - 1) * p;
      const lower = Math.floor(position);
      return rounded(returns[lower] + (returns[Math.ceil(position)] - returns[lower]) * (position - lower));
    };
    assert.deepEqual(result.horizons[horizon], { bars: horizon, sampleCount: returns.length,
      medianPct: quantile(0.5), p25Pct: quantile(0.25), p75Pct: quantile(0.75) });
  }
});

test('small samples suppress both summaries and individual outcomes', () => {
  const history = syntheticHistory(470);
  const result = buildHistoricalAnalogs(history, optionsFor(history));
  assertSuppressed(result, 'insufficient');
  assert.ok(result.sample.selectedCount > 0 && result.sample.selectedCount < 8);
  assert.equal(result.samples.length, result.sample.selectedCount);
  assert.equal(result.reasonCode, 'too_few_matches');
  const missing = buildHistoricalAnalogs();
  assertSuppressed(missing);
  assert.equal(missing.reasonCode, 'missing_history');
  const short = syntheticHistory(239);
  assert.equal(buildHistoricalAnalogs(short, optionsFor(short)).reasonCode, 'short_history');
});

test('adjustment, provider quality, source, interval and freshness failures fail closed', () => {
  const history = syntheticHistory();
  const options = optionsFor(history);
  const cases = [
    [{ priceMode: 'raw' }, 'unadjusted_history'],
    [{ priceMode: 'mixed' }, 'unadjusted_history'],
    [{ status: 'stale' }, 'stale_history'],
    [{ status: 'partial' }, 'incomplete_history'],
    [{ status: 'error' }, 'incomplete_history'],
    [{ status: 'unavailable' }, 'incomplete_history'],
    [{ status: 'unknown-provider-state' }, 'incomplete_history'],
    [{ status: true }, 'invalid_source_status'],
    [{ source: '' }, 'missing_source'],
    [{ interval: '1h' }, 'unsupported_interval'],
    [{ stale: true }, 'stale_history'],
    [{ cacheState: 'stale-fallback' }, 'stale_history'],
    [{ partial: true }, 'incomplete_history'],
    [{ ohlcCoveragePct: 99 }, 'incomplete_history'],
    [{ currentSessionComplete: false }, 'unconfirmed_session'],
    [{ containsOpenSession: true }, 'unconfirmed_session']
  ];
  for (const [patch, reason] of cases) {
    const result = buildHistoricalAnalogs({ ...history, ...patch }, options);
    assertSuppressed(result);
    assert.equal(result.reasonCode, reason, JSON.stringify(patch));
  }
  const mixed = structuredClone(history);
  mixed.bars[100].priceMode = 'raw';
  assert.equal(buildHistoricalAnalogs(mixed, options).reasonCode, 'unadjusted_history');
  assert.equal(buildHistoricalAnalogs(history, { ...options, nowMs: options.nowMs + 8 * 86_400_000 }).reasonCode,
    'stale_history');
  assert.equal(buildHistoricalAnalogs(history, { ...options, nowMs: history.bars.at(-1).timestamp * 1000 - 1 }).reasonCode,
    'future_history');
});

test('missing, nonnumeric, infinite, impossible or duplicate inputs are not repaired', () => {
  const mutations = [
    bar => { bar.open = null; },
    bar => { bar.open = String(bar.open); },
    bar => { bar.open = true; },
    bar => { bar.close = Infinity; },
    bar => { bar.low = NaN; },
    bar => { bar.high = 0; },
    bar => { bar.high = bar.close - 1; },
    bar => { bar.low = bar.close + 1; },
    bar => { bar.timestamp = String(bar.timestamp); },
    bar => { bar.timestamp = true; },
    bar => { bar.timestamp = null; },
    bar => { bar.timestamp = 1e300; },
    bar => { bar.timestamp += 86_400; },
    bar => { bar.sessionDate = '2021-02-30'; },
    bar => { bar.sessionDate += 'T21:00:00Z'; }
  ];
  for (const mutate of mutations) {
    const history = syntheticHistory();
    const options = optionsFor(history);
    mutate(history.bars[300]);
    const result = buildHistoricalAnalogs(history, options);
    assertSuppressed(result);
    assert.equal(result.reasonCode, 'invalid_history');
  }
  for (const mutate of [
    bars => { bars[300] = { ...bars[299] }; },
    bars => { [bars[299], bars[300]] = [bars[300], bars[299]]; }
  ]) {
    const history = syntheticHistory();
    const options = optionsFor(history);
    mutate(history.bars);
    assert.equal(buildHistoricalAnalogs(history, options).reasonCode, 'invalid_history');
  }
});

test('gaps are measured in calendar days, never silently called trading sessions', () => {
  const history = syntheticHistory();
  history.bars.splice(300, 2);
  const result = buildHistoricalAnalogs(history, optionsFor(history));
  assert.equal(result.status, 'ok');
  assert.equal(result.unit, '取引足本後');
  assert.equal(result.quality.calendarVerified, false);
  assert.ok(result.quality.maxCalendarGapDays >= 4);
  const excessive = syntheticHistory();
  excessive.bars.splice(300, 10);
  const blocked = buildHistoricalAnalogs(excessive, optionsFor(excessive));
  assertSuppressed(blocked);
  assert.equal(blocked.reasonCode, 'unverified_calendar_gap');
  assert.ok(blocked.quality.longCalendarGapCount > 0);
});

test('missing volume does not masquerade as missing price and no volume condition is inferred', () => {
  const history = syntheticHistory();
  history.bars.forEach(bar => { bar.volume = null; });
  const result = buildHistoricalAnalogs(history, optionsFor(history));
  assert.equal(result.status, 'ok');
  assert.equal(result.quality.volumeUsed, false);
});

test('price adjustment and open-session exclusion occur before analog computation', () => {
  const history = syntheticHistory();
  const timestamp = history.bars.map(bar => bar.timestamp);
  const splitFactor = index => index < 600 ? 2 : 1;
  const quotes = Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map(key => [key,
    history.bars.map((bar, index) => key === 'volume' ? bar[key] : bar[key] * splitFactor(index))]));
  const payload = { chart: { result: [{ timestamp,
    meta: { symbol: 'SYNTH', marketState: 'REGULAR', regularMarketTime: timestamp.at(-1),
      currentTradingPeriod: { regular: { start: timestamp.at(-1) - 3600, end: timestamp.at(-1) + 3600 } } },
    indicators: { quote: [quotes], adjclose: [{ adjclose: history.bars.map(bar => bar.close) }] }
  }] } };
  const parsed = parseYahooTechnicalChartHistory(payload, 'SYNTH', timestamp.at(-1) * 1000);
  assert.equal(parsed.priceMode, 'adjusted');
  assert.equal(parsed.excludedOpenSession, true);
  assert.equal(parsed.bars.length, history.bars.length - 1);
  assert.ok(Math.abs(parsed.bars[100].close - history.bars[100].close) < 0.000001);
  assert.ok(Math.abs(parsed.bars[100].open - history.bars[100].open) < 0.000001);
  const result = buildHistoricalAnalogs(parsed, optionsFor(history));
  assert.equal(result.status, 'ok');
  assert.equal(result.asOf, history.bars.at(-2).sessionDate);
  assert.equal(result.quality.excludedOpenSession, true);
  payload.chart.result[0].indicators.adjclose[0].adjclose[100] = null;
  const raw = parseYahooTechnicalChartHistory(payload, 'SYNTH', timestamp.at(-1) * 1000);
  assert.equal(raw.priceMode, 'raw');
  assert.equal(buildHistoricalAnalogs(raw, optionsFor(history)).reasonCode, 'unadjusted_history');
});

test('fingerprints identify price input changes, not private account data or optional evidence', () => {
  const history = syntheticHistory();
  const options = optionsFor(history);
  const baseline = buildHistoricalAnalogs(history, options);
  const evidence = { ...history, news: [{ text: 'Unrelated evidence' }], account: { equity: 1234 } };
  assert.deepEqual(buildHistoricalAnalogs(evidence, options), baseline);
  const changed = structuredClone(history);
  changed.bars[10].high *= 1.01;
  assert.notEqual(buildHistoricalAnalogs(changed, options).inputId, baseline.inputId);
  assert.notEqual(buildHistoricalAnalogs(history, { ...options, symbol: 'OTHER' }).inputId, baseline.inputId);
});

test('retrieval time is independently validated and never fabricated from evaluation or cache times', () => {
  const history = syntheticHistory();
  const options = optionsFor(history);
  const without = buildHistoricalAnalogs({ ...history, cacheState: 'hit', cacheAgeMs: 100 }, options);
  assert.equal(without.retrievedAt, null);
  assert.equal(without.quality.retrievalTimeStatus, 'unavailable');
  const retrievedAt = new Date(options.nowMs - 1000).toISOString();
  const withTime = buildHistoricalAnalogs({ ...history, retrievedAt }, options);
  assert.equal(withTime.status, 'ok');
  assert.equal(withTime.retrievedAt, retrievedAt);
  assert.notEqual(withTime.retrievedAt, withTime.evaluatedAt);
  assert.equal(withTime.quality.retrievalTimeStatus, 'verified');
  assert.equal(buildHistoricalAnalogs({ ...history, retrieved_at: retrievedAt }, options).retrievedAt, retrievedAt);
  for (const value of [
    true, options.nowMs, 'not-a-date', '2025-02-30T10:00:00Z', '2025-01-01T24:00:00Z',
    '2025-10-17', '2025-10-17T10:00:00', new Date(options.nowMs + 1).toISOString(),
    new Date(history.bars.at(-1).timestamp * 1000 - 1).toISOString()
  ]) {
    const result = buildHistoricalAnalogs({ ...history, retrievedAt: value }, options);
    assertSuppressed(result);
    assert.equal(result.reasonCode, 'invalid_retrieval_time');
  }
});

test('buy-signal integration and the API envelope retain analysis without changing trading fields', () => {
  const history = syntheticHistory();
  const options = optionsFor(history);
  const result = buildBuySignalResult({ ...options, history });
  assert.deepEqual(result.historicalAnalogs, buildHistoricalAnalogs(history, options));
  const without = { ...result };
  delete without.historicalAnalogs;
  const oldEnvelope = enforceSimulationEnvelope({ status: 'ok', results: [without] });
  const newEnvelope = enforceSimulationEnvelope({ status: 'ok', results: [result] });
  assert.deepEqual(newEnvelope.results[0].historicalAnalogs, result.historicalAnalogs);
  delete newEnvelope.results[0].historicalAnalogs;
  assert.deepEqual(newEnvelope, oldEnvelope);
});

test('missing upstream history includes an explicit unavailable analog result without extra reads', async () => {
  const service = new MarketDataService({ fetch: () => { throw new Error('Network forbidden in this test'); } });
  let historyReads = 0;
  service._getTechnicalHistories = async () => { historyReads += 1; return new Map(); };
  service._technicalIntelligencePayload = async () => null;
  service._getFinnhubTechnicalEvidenceBatch = async () => new Map();
  const result = await service.getBuySignals({ symbols: ['SYNTH'] });
  assert.equal(historyReads, 1);
  assert.equal(result.results[0].historicalAnalogs.reasonCode, 'missing_history');
  assertSuppressed(result.results[0].historicalAnalogs);
});

test('/api/buy-signals carries the new field through the real route without extra providers', async () => {
  const history = syntheticHistory();
  const row = buildBuySignalResult({ ...optionsFor(history), history });
  const { app } = createApp({ env: {}, marketData: {
    getBuySignals: async () => ({ status: 'partial', results: [row] }),
    status: () => ({})
  } });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/buy-signals?symbols=SYNTH`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.results[0].historicalAnalogs, row.historicalAnalogs);
    assert.equal(body.tradeEligible, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
