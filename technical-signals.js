'use strict';

const TECHNICAL_METHOD_VERSION = 'technical-eight-factor-v1';
const BACKTEST_METHOD_VERSION = 'technical-a-f-walkforward-v1';
const SIMULATION_EXECUTION = Object.freeze({
  mode: 'SIMULATE',
  autoOrder: false,
  tradingConnected: false,
  tradeEligible: false
});

const SIGNAL_DEFINITIONS = Object.freeze([
  Object.freeze({ key: 'rsiRecovery', label: 'RSI売られ過ぎ反転' }),
  Object.freeze({ key: 'macdGoldenCross', label: 'MACDゴールデンクロス' }),
  Object.freeze({ key: 'ema20Recovery', label: 'EMA20回復' }),
  Object.freeze({ key: 'ema50Recovery', label: 'EMA50回復' }),
  Object.freeze({ key: 'volumeExpansion', label: '出来高拡大' }),
  Object.freeze({ key: 'supportBounce', label: '支持帯反発' }),
  Object.freeze({ key: 'themeStrength', label: 'テーマ強度' }),
  Object.freeze({ key: 'fundamentalNews', label: '決算・材料' })
]);
const KNOWN_LEVERAGED_SYMBOLS = new Set([
  'SOXL', 'SOXS', 'TQQQ', 'SQQQ', 'UPRO', 'SPXU', 'SPXL',
  'QLD', 'QID', 'SSO', 'SDS', 'TECL', 'TECS', 'FAS', 'FAZ',
  'TNA', 'TZA', 'LABU', 'LABD', 'NUGT', 'DUST', 'BOIL', 'KOLD',
  'TMF', 'TBT', 'BITX', 'CONL', 'NVDL', 'NVDU', 'TSLL',
  'MSTU', 'MSTZ', 'MUU'
]);
const KNOWN_NON_LEVERAGED_ETFS = new Set(['SPY', 'QQQ', 'SOXX']);
const LEVERAGED_NAME_PATTERN =
  /\b(?:2x|3x)\b|\bultra(?:pro)?\b|\bdaily\b.*\b(?:bull|bear|long|short)\b|\bleveraged\b|\binverse\b/i;

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 4) => {
  const number = finite(value);
  if (number == null) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
};

function detectLeveragedProduct(symbolValue, history = {}) {
  const symbol = String(symbolValue || '').trim().toUpperCase();
  const quoteType = String(history?.quoteType || history?.instrumentType || '')
    .trim()
    .toUpperCase();
  const names = [history?.longName, history?.shortName]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const descriptiveNames = names.filter(name => name.toUpperCase() !== symbol);
  const combinedName = descriptiveNames.join(' | ');

  if (KNOWN_LEVERAGED_SYMBOLS.has(symbol)) {
    return {
      status: 'leveraged',
      leveraged: true,
      source: 'static-leveraged-symbol',
      quoteType: quoteType || null,
      name: combinedName || null,
      matchedPattern: 'known-symbol'
    };
  }
  if (combinedName && LEVERAGED_NAME_PATTERN.test(combinedName)) {
    return {
      status: 'leveraged',
      leveraged: true,
      source: 'yahoo-name-metadata',
      quoteType: quoteType || null,
      name: combinedName,
      matchedPattern: LEVERAGED_NAME_PATTERN.source
    };
  }
  if (KNOWN_NON_LEVERAGED_ETFS.has(symbol)) {
    return {
      status: 'unleveraged',
      leveraged: false,
      source: 'known-non-leveraged-etf',
      quoteType: quoteType || 'ETF',
      name: combinedName || null,
      matchedPattern: null
    };
  }
  if (quoteType === 'ETF') {
    if (!combinedName) {
      return {
        status: 'unavailable',
        leveraged: null,
        source: 'missing-etf-name-metadata',
        quoteType,
        name: null,
        matchedPattern: null
      };
    }
    return {
      status: 'unleveraged',
      leveraged: false,
      source: 'yahoo-name-metadata-no-leverage-marker',
      quoteType,
      name: combinedName,
      matchedPattern: null
    };
  }
  if (quoteType) {
    return {
      status: 'unleveraged',
      leveraged: false,
      source: 'yahoo-quote-type',
      quoteType,
      name: combinedName || null,
      matchedPattern: null
    };
  }
  return {
    status: 'unavailable',
    leveraged: null,
    source: 'missing-instrument-metadata',
    quoteType: null,
    name: combinedName || null,
    matchedPattern: null
  };
}

function sanitizeBars(values) {
  if (!Array.isArray(values)) return [];
  const byDate = new Map();
  for (const value of values) {
    const timestamp = finite(value?.timestamp) ??
      (Number.isFinite(Date.parse(String(value?.sessionDate || value?.date || value?.at || '')))
        ? Math.floor(Date.parse(String(value?.sessionDate || value?.date || value?.at || '')) / 1000)
        : null);
    const sessionDate = String(
      value?.sessionDate || value?.date ||
      (timestamp ? new Date(timestamp * 1000).toISOString().slice(0, 10) : '')
    ).slice(0, 10);
    const close = finite(value?.close);
    if (!timestamp || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate) || !(close > 0)) continue;
    const open = finite(value?.open);
    let high = finite(value?.high);
    let low = finite(value?.low);
    if (!(open > 0) || !(high > 0) || !(low > 0)) continue;
    high = Math.max(high, open, close);
    low = Math.min(low, open, close);
    const volume = finite(value?.volume);
    byDate.set(sessionDate, {
      timestamp,
      at: value?.at || new Date(timestamp * 1000).toISOString(),
      sessionDate,
      open,
      high,
      low,
      close,
      volume: volume != null && volume >= 0 ? volume : null,
      priceMode: value?.priceMode === 'adjusted' ? 'adjusted' : 'raw'
    });
  }
  return [...byDate.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function emaSeries(values, period) {
  const length = Array.isArray(values) ? values.length : 0;
  const out = new Array(length).fill(null);
  const window = Math.max(1, Math.floor(Number(period) || 0));
  if (!length || window < 1) return out;
  let seed = 0;
  for (let index = 0; index < length; index += 1) {
    const value = finite(values[index]);
    if (value == null) continue;
    if (index < window) seed += value;
    if (index === window - 1) {
      out[index] = seed / window;
      continue;
    }
    if (index >= window && out[index - 1] != null) {
      const multiplier = 2 / (window + 1);
      out[index] = (value - out[index - 1]) * multiplier + out[index - 1];
    }
  }
  return out;
}

function rsiSeries(values, period = 14) {
  const length = Array.isArray(values) ? values.length : 0;
  const out = new Array(length).fill(null);
  const window = Math.max(1, Math.floor(Number(period) || 14));
  if (length <= window) return out;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= window; index += 1) {
    const previous = finite(values[index - 1]);
    const current = finite(values[index]);
    if (previous == null || current == null) return out;
    const change = current - previous;
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  let averageGain = gains / window;
  let averageLoss = losses / window;
  const calculate = () => {
    if (averageGain === 0 && averageLoss === 0) return 50;
    if (averageLoss === 0) return 100;
    return 100 - (100 / (1 + averageGain / averageLoss));
  };
  out[window] = calculate();
  for (let index = window + 1; index < length; index += 1) {
    const previous = finite(values[index - 1]);
    const current = finite(values[index]);
    if (previous == null || current == null) continue;
    const change = current - previous;
    averageGain = ((averageGain * (window - 1)) + Math.max(0, change)) / window;
    averageLoss = ((averageLoss * (window - 1)) + Math.max(0, -change)) / window;
    out[index] = calculate();
  }
  return out;
}

function macdSeries(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fast = emaSeries(values, fastPeriod);
  const slow = emaSeries(values, slowPeriod);
  const line = values.map((_, index) => (
    fast[index] == null || slow[index] == null ? null : fast[index] - slow[index]
  ));
  const compact = [];
  const compactIndexes = [];
  line.forEach((value, index) => {
    if (value == null) return;
    compact.push(value);
    compactIndexes.push(index);
  });
  const compactSignal = emaSeries(compact, signalPeriod);
  const signal = new Array(values.length).fill(null);
  compactSignal.forEach((value, index) => {
    if (value != null) signal[compactIndexes[index]] = value;
  });
  const histogram = line.map((value, index) => (
    value == null || signal[index] == null ? null : value - signal[index]
  ));
  return { line, signal, histogram, fast, slow };
}

function relativeVolumeSeries(volumes, period = 20) {
  const length = Array.isArray(volumes) ? volumes.length : 0;
  const out = new Array(length).fill(null);
  const window = Math.max(1, Math.floor(Number(period) || 20));
  for (let index = window; index < length; index += 1) {
    const current = finite(volumes[index]);
    const prior = volumes
      .slice(index - window, index)
      .map(finite)
      .filter(value => value != null && value >= 0);
    if (current == null || prior.length !== window) continue;
    const average = prior.reduce((sum, value) => sum + value, 0) / window;
    if (average > 0) out[index] = current / average;
  }
  return out;
}

function atrSeries(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  const trueRanges = bars.map((bar, index) => {
    if (!index) return bar.high - bar.low;
    const previousClose = bars[index - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose)
    );
  });
  const window = Math.max(1, Math.floor(Number(period) || 14));
  if (trueRanges.length < window) return out;
  let value = trueRanges.slice(0, window).reduce((sum, item) => sum + item, 0) / window;
  out[window - 1] = value;
  for (let index = window; index < trueRanges.length; index += 1) {
    value = ((value * (window - 1)) + trueRanges[index]) / window;
    out[index] = value;
  }
  return out;
}

function rollingRangeSeries(bars, period = 20) {
  const high = new Array(bars.length).fill(null);
  const low = new Array(bars.length).fill(null);
  const priorHigh = new Array(bars.length).fill(null);
  const priorLow = new Array(bars.length).fill(null);
  const window = Math.max(1, Math.floor(Number(period) || 20));
  for (let index = 0; index < bars.length; index += 1) {
    if (index >= window - 1) {
      const current = bars.slice(index - window + 1, index + 1);
      high[index] = Math.max(...current.map(bar => bar.high));
      low[index] = Math.min(...current.map(bar => bar.low));
    }
    if (index >= window) {
      const prior = bars.slice(index - window, index);
      priorHigh[index] = Math.max(...prior.map(bar => bar.high));
      priorLow[index] = Math.min(...prior.map(bar => bar.low));
    }
  }
  return { high, low, priorHigh, priorLow };
}

function isoWeekKey(sessionDate) {
  const date = new Date(`${sessionDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return '';
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function aggregateWeeklyBars(values) {
  const bars = sanitizeBars(values);
  const groups = new Map();
  for (const bar of bars) {
    const key = isoWeekKey(bar.sessionDate);
    if (!key) continue;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        ...bar,
        weekStart: key,
        volume: bar.volume == null ? null : bar.volume
      });
      continue;
    }
    current.timestamp = bar.timestamp;
    current.at = bar.at;
    current.sessionDate = bar.sessionDate;
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
    current.priceMode = current.priceMode === 'adjusted' && bar.priceMode === 'adjusted'
      ? 'adjusted'
      : 'raw';
    current.volume = current.volume == null || bar.volume == null
      ? null
      : current.volume + bar.volume;
  }
  return [...groups.values()];
}

function calculateIndicatorSeries(values) {
  const bars = sanitizeBars(values);
  const closes = bars.map(bar => bar.close);
  const volumes = bars.map(bar => bar.volume);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const ema200 = emaSeries(closes, 200);
  const rsi14 = rsiSeries(closes, 14);
  const macd = macdSeries(closes, 12, 26, 9);
  const rvol20 = relativeVolumeSeries(volumes, 20);
  const atr14 = atrSeries(bars, 14);
  const range20 = rollingRangeSeries(bars, 20);
  const change = (index, sessions) => (
    index >= sessions && bars[index - sessions]?.close > 0
      ? ((bars[index].close / bars[index - sessions].close) - 1) * 100
      : null
  );
  const rows = bars.map((bar, index) => ({
    ...bar,
    ema20: ema20[index],
    ema50: ema50[index],
    ema200: ema200[index],
    rsi14: rsi14[index],
    macd: {
      line: macd.line[index],
      signal: macd.signal[index],
      histogram: macd.histogram[index]
    },
    rvol20: rvol20[index],
    atr14: atr14[index],
    high20: range20.high[index],
    low20: range20.low[index],
    priorHigh20: range20.priorHigh[index],
    priorLow20: range20.priorLow[index],
    change1dPct: change(index, 1),
    change5dPct: change(index, 5),
    change20dPct: change(index, 20)
  }));
  return { bars, rows };
}

function indicatorSnapshot(row, timeframe, barCount, previous = null, recentRows = []) {
  if (!row) {
    return {
      timeframe,
      status: 'unavailable',
      available: false,
      bars: barCount || 0,
      asOf: null,
      price: null,
      ema20: null,
      ema50: null,
      ema200: null,
      rsi14: null,
      macd: { line: null, signal: null, histogram: null },
      rvol20: null,
      high20: null,
      low20: null,
      priorHigh20: null,
      priorLow20: null,
      atr14: null,
      change1dPct: null,
      change5dPct: null,
      change20dPct: null
    };
  }
  const recentRsi = recentRows
    .map(item => finite(item?.rsi14))
    .filter(value => value != null);
  const recentHistogram = recentRows
    .map(item => finite(item?.macd?.histogram))
    .filter(value => value != null);
  const lastThreeHistogram = recentHistogram.slice(-3);
  const rsiRecovery = row.rsi14 != null && previous?.rsi14 != null &&
    recentRsi.slice(0, -1).some(value => value <= 30) &&
    row.rsi14 > previous.rsi14;
  const macdGoldenCross = row.macd?.line != null && row.macd?.signal != null &&
    previous?.macd?.line != null && previous?.macd?.signal != null &&
    previous.macd.line <= previous.macd.signal && row.macd.line > row.macd.signal;
  const macdDeadCross = row.macd?.line != null && row.macd?.signal != null &&
    previous?.macd?.line != null && previous?.macd?.signal != null &&
    previous.macd.line >= previous.macd.signal && row.macd.line < row.macd.signal;
  const macdHistogramImproving = lastThreeHistogram.length === 3 &&
    lastThreeHistogram.every(value => value < 0) &&
    lastThreeHistogram[0] < lastThreeHistogram[1] &&
    lastThreeHistogram[1] < lastThreeHistogram[2];
  const macdHistogramWeakening = lastThreeHistogram.length === 3 &&
    lastThreeHistogram.every(value => value > 0) &&
    lastThreeHistogram[0] > lastThreeHistogram[1] &&
    lastThreeHistogram[1] > lastThreeHistogram[2];
  const ema20CrossUp = row.ema20 != null && previous?.ema20 != null &&
    previous.close <= previous.ema20 && row.close > row.ema20;
  const ema50CrossUp = row.ema50 != null && previous?.ema50 != null &&
    previous.close <= previous.ema50 && row.close > row.ema50;
  const ema20HeldTwo = row.ema20 != null && previous?.ema20 != null &&
    previous.close > previous.ema20 && row.close > row.ema20;
  const ema50HeldTwo = row.ema50 != null && previous?.ema50 != null &&
    previous.close > previous.ema50 && row.close > row.ema50;
  const ema20Recovery = ema20CrossUp || ema20HeldTwo;
  const ema50Recovery = ema50CrossUp || ema50HeldTwo;
  const volumeExpansion = row.rvol20 != null && row.rvol20 >= 1.5 &&
    (row.close > row.open || (previous?.close != null && row.close > previous.close));
  const bullishVolume = volumeExpansion;
  const rsiFlags = {
    oversold: row.rsi14 == null ? null : row.rsi14 <= 30,
    nearOversold: row.rsi14 == null ? null : row.rsi14 > 30 && row.rsi14 <= 35,
    recoveringFromOversold: row.rsi14 == null || previous?.rsi14 == null ||
      recentRsi.length < 2 ? null : rsiRecovery,
    bullishZone: row.rsi14 == null ? null : row.rsi14 >= 50 && row.rsi14 < 70,
    overheated: row.rsi14 == null ? null : row.rsi14 >= 70,
    extremeOverheated: row.rsi14 == null ? null : row.rsi14 >= 80
  };
  const macdFlags = {
    goldenCross: row.macd?.signal == null || previous?.macd?.signal == null
      ? null
      : macdGoldenCross,
    deadCross: row.macd?.signal == null || previous?.macd?.signal == null
      ? null
      : macdDeadCross,
    histogramImproving: lastThreeHistogram.length < 3 ? null : macdHistogramImproving,
    histogramWeakening: lastThreeHistogram.length < 3 ? null : macdHistogramWeakening
  };
  const emaFlags = {
    priceAbove20: row.ema20 == null ? null : row.close > row.ema20,
    priceAbove50: row.ema50 == null ? null : row.close > row.ema50,
    priceAbove200: row.ema200 == null ? null : row.close > row.ema200,
    priceAboveEma20: row.ema20 == null ? null : row.close > row.ema20,
    priceAboveEma50: row.ema50 == null ? null : row.close > row.ema50,
    priceAboveEma200: row.ema200 == null ? null : row.close > row.ema200,
    ema20CrossUp: row.ema20 == null || previous?.ema20 == null ? null : ema20CrossUp,
    ema50CrossUp: row.ema50 == null || previous?.ema50 == null ? null : ema50CrossUp,
    slopeUp20: row.ema20 == null || previous?.ema20 == null ? null : row.ema20 > previous.ema20,
    slopeUp50: row.ema50 == null || previous?.ema50 == null ? null : row.ema50 > previous.ema50,
    ema20SlopeUp: row.ema20 == null || previous?.ema20 == null ? null : row.ema20 > previous.ema20,
    ema50SlopeUp: row.ema50 == null || previous?.ema50 == null ? null : row.ema50 > previous.ema50,
    bullishAlignment: [row.ema20, row.ema50, row.ema200].some(value => value == null)
      ? null
      : row.ema20 > row.ema50 && row.ema50 > row.ema200,
    bearishAlignment: [row.ema20, row.ema50, row.ema200].some(value => value == null)
      ? null
      : row.ema20 < row.ema50 && row.ema50 < row.ema200
  };
  const available = row.ema200 != null && row.rsi14 != null && row.macd?.signal != null;
  return {
    timeframe,
    status: available ? 'ok' : 'partial',
    available,
    bars: barCount,
    asOf: row.sessionDate,
    price: round(row.close, 4),
    open: round(row.open, 4),
    high: round(row.high, 4),
    low: round(row.low, 4),
    ema20: round(row.ema20, 4),
    ema50: round(row.ema50, 4),
    ema200: round(row.ema200, 4),
    rsi14: round(row.rsi14, 2),
    rsi: round(row.rsi14, 2),
    macd: {
      dif: round(row.macd?.line, 4),
      dea: round(row.macd?.signal, 4),
      line: round(row.macd?.line, 4),
      signal: round(row.macd?.signal, 4),
      histogram: round(row.macd?.histogram, 4),
      goldenCross: macdFlags.goldenCross,
      deadCross: macdFlags.deadCross,
      histogramImproving: macdFlags.histogramImproving,
      histogramWeakening: macdFlags.histogramWeakening,
      state: row.macd?.line == null || row.macd?.signal == null
        ? 'unavailable'
        : (row.macd.line > row.macd.signal ? 'bullish' : 'bearish')
    },
    rvol20: round(row.rvol20, 2),
    rvol: round(row.rvol20, 2),
    high20: round(row.high20, 4),
    low20: round(row.low20, 4),
    priorHigh20: round(row.priorHigh20, 4),
    priorLow20: round(row.priorLow20, 4),
    atr14: round(row.atr14, 4),
    change1dPct: round(row.change1dPct, 2),
    change5dPct: round(row.change5dPct, 2),
    change20dPct: round(row.change20dPct, 2),
    riseFromLow20Pct: row.low20 > 0 ? round(((row.close / row.low20) - 1) * 100, 2) : null,
    declineFromHigh20Pct: row.high20 > 0
      ? round(((row.high20 - row.close) / row.high20) * 100, 2)
      : null,
    ema: row.ema20 == null || row.ema50 == null || row.ema200 == null
      ? 'unavailable'
      : (row.close > row.ema20 && row.ema20 > row.ema50 && row.ema50 > row.ema200
          ? 'bullish-aligned'
          : (row.close < row.ema20 && row.close < row.ema50 && row.close < row.ema200
              ? 'below-all'
              : 'mixed')),
    previous: previous
      ? {
          price: round(previous.close, 4),
          open: round(previous.open, 4),
          high: round(previous.high, 4),
          low: round(previous.low, 4),
          ema20: round(previous.ema20, 4),
          ema50: round(previous.ema50, 4),
          ema200: round(previous.ema200, 4),
          rsi14: round(previous.rsi14, 2),
          macd: {
            line: round(previous.macd?.line, 4),
            signal: round(previous.macd?.signal, 4),
            histogram: round(previous.macd?.histogram, 4)
          }
        }
      : null,
    flags: {
      rsi: rsiFlags,
      macd: macdFlags,
      ema: emaFlags,
      volume: {
        expansion: row.rvol20 == null ? null : volumeExpansion,
        bullish: row.rvol20 == null ? null : bullishVolume
      },
      rsiRecovery: rsiFlags.recoveringFromOversold,
      macdGoldenCross: macdFlags.goldenCross,
      macdDeadCross: macdFlags.deadCross,
      macdHistogramImproving: macdFlags.histogramImproving,
      macdHistogramWeakening: macdFlags.histogramWeakening,
      ema20Recovery: row.ema20 == null || previous?.ema20 == null ? null : ema20Recovery,
      ema50Recovery: row.ema50 == null || previous?.ema50 == null ? null : ema50Recovery,
      volumeExpansion: row.rvol20 == null ? null : volumeExpansion,
      bullishVolume: row.rvol20 == null ? null : bullishVolume
    },
    recentRsi14: recentRsi.map(value => round(value, 2))
  };
}

function calculateTechnicalIndicators(values) {
  const daily = calculateIndicatorSeries(values);
  const allWeeklyBars = aggregateWeeklyBars(daily.bars);
  const latestDailyDate = daily.bars.at(-1)?.sessionDate || '';
  const latestDailyWeek = isoWeekKey(latestDailyDate);
  const latestDailyWeekday = /^\d{4}-\d{2}-\d{2}$/.test(latestDailyDate)
    ? new Date(`${latestDailyDate}T00:00:00Z`).getUTCDay()
    : null;
  // Only a confirmed Friday close completes the latest weekly bar. If the
  // latest session is Monday-Thursday, including a Friday holiday, exclude it.
  const latestWeekCompleted = latestDailyWeekday === 5;
  const weeklyBars = allWeeklyBars.filter(bar => (
    bar.weekStart < latestDailyWeek ||
    (latestWeekCompleted && bar.weekStart === latestDailyWeek)
  ));
  const weekly = calculateIndicatorSeries(weeklyBars);
  const dailyRows = daily.rows;
  const weeklyRows = weekly.rows;
  const dailySnapshot = indicatorSnapshot(
    dailyRows.at(-1),
    '1d',
    daily.bars.length,
    dailyRows.at(-2),
    dailyRows.slice(-6)
  );
  const weeklySnapshot = indicatorSnapshot(
    weeklyRows.at(-1),
    '1wk',
    weekly.bars.length,
    weeklyRows.at(-2),
    weeklyRows.slice(-6)
  );
  const pivot = dailySnapshot.priorHigh20 > 0 && dailySnapshot.priorLow20 > 0 &&
    dailySnapshot.price > 0
    ? (dailySnapshot.priorHigh20 + dailySnapshot.priorLow20 + dailySnapshot.price) / 3
    : null;
  const pivotS1 = pivot == null ? null : 2 * pivot - dailySnapshot.priorHigh20;
  const pivotS2 = pivot == null
    ? null
    : pivot - (dailySnapshot.priorHigh20 - dailySnapshot.priorLow20);
  const supports = [
    { type: 'ema20', role: 'auxiliary', value: dailySnapshot.ema20 },
    { type: 'ema50', role: 'auxiliary', value: dailySnapshot.ema50 },
    { type: 'ema200', role: 'major', value: dailySnapshot.ema200 },
    { type: 'recent20Low', role: 'major', value: dailySnapshot.low20 },
    { type: 'pivotS1', role: 'major-pivot', value: pivotS1 },
    { type: 'pivotS2', role: 'major-pivot', value: pivotS2 }
  ].filter(item => item.value > 0 && item.value < dailySnapshot.price)
    .map(item => ({
      ...item,
      distancePct: round(((dailySnapshot.price / item.value) - 1) * 100, 2)
    }))
    .sort((left, right) => left.distancePct - right.distancePct);
  return {
    daily: dailySnapshot,
    weekly: {
      ...weeklySnapshot,
      completedOnly: true,
      partialCurrentWeekExcluded: allWeeklyBars.length > weeklyBars.length
    },
    supportCandidates: supports,
    vwap: {
      status: 'unavailable',
      available: false,
      reason: 'Intraday bars are not connected; VWAP is not inferred from daily bars.'
    },
    volumeProfile: {
      status: 'unavailable',
      available: false,
      reason: 'Price-at-volume history is not connected.'
    },
    _series: { daily, weekly }
  };
}

function makeSignal(definition, available, passed, value, detail, reason) {
  const state = available ? Boolean(passed) : null;
  return {
    key: definition.key,
    label: definition.label,
    available: Boolean(available),
    passed: state,
    active: state,
    state,
    status: state == null ? 'unavailable' : (state ? 'active' : 'inactive'),
    value: value ?? null,
    detail: String(detail || ''),
    reason: String(reason || '')
  };
}

function fundamentalSignalFlags(fundamental) {
  const source = fundamental && typeof fundamental === 'object' ? fundamental : {};
  const flags = source.flags && typeof source.flags === 'object' ? source.flags : {};
  const normalize = value => value === true ? true : value === false ? false : null;
  const normalized = {
    goodEarnings: normalize(flags.goodEarnings),
    guidanceUp: normalize(flags.guidanceUp),
    revenueGrowth: normalize(flags.revenueGrowth),
    positiveCatalyst: normalize(flags.positiveCatalyst),
    negativeMaterial: normalize(flags.negativeMaterial)
  };
  return {
    available: Object.values(normalized).some(value => typeof value === 'boolean'),
    ...normalized
  };
}

function evaluateEightSignals(indicators, theme, fundamental) {
  const daily = indicators?.daily || {};
  const definitions = Object.fromEntries(SIGNAL_DEFINITIONS.map(item => [item.key, item]));
  const flags = daily.flags || {};
  const themeAvailable = theme?.status === 'ok' && finite(theme?.score) != null &&
    Boolean(theme?.trend);
  const themeScore = finite(theme?.score);
  const fundamentalFlags = fundamentalSignalFlags(fundamental);
  const supportCandidates = Array.isArray(indicators?.supportCandidates)
    ? indicators.supportCandidates
    : [];
  const majorSupports = supportCandidates.filter(candidate =>
    ['ema200', 'recent20Low', 'pivotS1', 'pivotS2'].includes(candidate?.type) &&
    finite(candidate?.value) > 0
  );
  const supportBounceCandidate = majorSupports.find(candidate => {
    const support = finite(candidate.value);
    const low = finite(daily.low);
    const close = finite(daily.price);
    const open = finite(daily.open);
    const previousClose = finite(daily.previous?.price);
    if (!(support > 0) || !(low > 0) || !(close > support)) return false;
    const touchedSupport = low >= support * 0.97 && low <= support * 1.03;
    const rejectedHigher = close >= support * 1.01;
    const bullishRejection = (open != null && close > open) ||
      (previousClose != null && close > previousClose);
    return touchedSupport && rejectedHigher && bullishRejection;
  }) || null;
  const supportFromVolumeProfile = indicators?.volumeProfile?.available === true &&
    indicators?.volumeProfile?.bounceConfirmed === true;
  const supportBouncePassed = Boolean(supportBounceCandidate || supportFromVolumeProfile);
  const supportBounceAvailable = supportBouncePassed ||
    indicators?.volumeProfile?.available === true;
  const fundamentalPassed = [
    fundamentalFlags.goodEarnings,
    fundamentalFlags.guidanceUp,
    fundamentalFlags.revenueGrowth,
    fundamentalFlags.positiveCatalyst
  ].some(value => value === true) && fundamentalFlags.negativeMaterial !== true;
  return [
    makeSignal(
      definitions.rsiRecovery,
      flags.rsiRecovery != null,
      flags.rsiRecovery === true && daily.rsi14 >= 30 && daily.rsi14 <= 40,
      daily.rsi14,
      flags.rsiRecovery == null
        ? ''
        : `現在RSI ${daily.rsi14} / 直近6本 ${daily.recentRsi14?.join(', ') || 'N/A'}`,
      flags.rsiRecovery == null
        ? 'RSI履歴が不足しています'
        : '現在30〜40、直近5本に30以下、前日より上昇の3条件'
    ),
    makeSignal(
      definitions.macdGoldenCross,
      flags.macdGoldenCross != null || flags.macdHistogramImproving != null,
      flags.macdGoldenCross === true || flags.macdHistogramImproving === true,
      daily.macd?.histogram,
      flags.macdGoldenCross == null
        ? ''
        : `DIF ${daily.macd?.line} / DEA ${daily.macd?.signal}`,
      flags.macdGoldenCross == null && flags.macdHistogramImproving == null
        ? 'MACDの当日・前日値が不足しています'
        : 'ゴールデンクロス、または負のhistogramが3本連続で厳密改善'
    ),
    makeSignal(
      definitions.ema20Recovery,
      flags.ema20Recovery != null,
      flags.ema20Recovery === true,
      daily.ema20,
      flags.ema20Recovery == null ? '' : `終値 ${daily.price} / EMA20 ${daily.ema20}`,
      flags.ema20Recovery == null
        ? 'EMA20の当日・前日値が不足しています'
        : 'EMA20の上抜け、または終値がEMA20上を2日維持'
    ),
    makeSignal(
      definitions.ema50Recovery,
      flags.ema50Recovery != null,
      flags.ema50Recovery === true,
      daily.ema50,
      flags.ema50Recovery == null ? '' : `終値 ${daily.price} / EMA50 ${daily.ema50}`,
      flags.ema50Recovery == null
        ? 'EMA50の当日・前日値が不足しています'
        : 'EMA50の上抜け、または終値がEMA50上を2日維持'
    ),
    makeSignal(
      definitions.volumeExpansion,
      flags.volumeExpansion != null,
      flags.volumeExpansion === true,
      daily.rvol20,
      flags.volumeExpansion == null ? '' : `RVOL20 ${daily.rvol20}x`,
      flags.volumeExpansion == null
        ? '出来高履歴が不足しています'
        : '当日を除く直前20日平均の1.5倍以上'
    ),
    makeSignal(
      definitions.supportBounce,
      supportBounceAvailable,
      supportBouncePassed,
      supportBounceCandidate ? round(supportBounceCandidate.value, 4) : null,
      supportBounceCandidate
        ? `${supportBounceCandidate.type} ${round(supportBounceCandidate.value, 4)}で反発を確認`
        : '',
      supportBouncePassed
        ? '支持候補への当日タッチ、支持上への終値反発、上向き終値を確認'
        : (indicators?.volumeProfile?.available === true
            ? '接続済みVolume Profileでも反発を確認できません'
            : '日足の明確な反発を確認できず、Volume Profile未接続のためunavailable')
    ),
    makeSignal(
      definitions.themeStrength,
      themeAvailable,
      themeScore >= 75 && ['up', 'flat'].includes(String(theme?.trend || '').toLowerCase()),
      themeScore == null ? null : round(themeScore, 1),
      themeAvailable
        ? `${theme.name || theme.id || 'theme'} score ${round(themeScore, 1)} / breadth ${round(theme.breadth, 1)}%`
        : '',
      themeAvailable
        ? 'score>=75、trend=up/flatの2条件'
        : 'status=okのテーマスコアまたはtrendがありません'
    ),
    makeSignal(
      definitions.fundamentalNews,
      fundamentalFlags.available,
      fundamentalPassed,
      fundamentalFlags.available
        ? [
            fundamentalFlags.goodEarnings,
            fundamentalFlags.guidanceUp,
            fundamentalFlags.revenueGrowth,
            fundamentalFlags.positiveCatalyst
          ].filter(value => value === true).length
        : null,
      fundamentalFlags.available
        ? '好決算・guidance上方・売上成長・positive catalystを確認'
        : '',
      fundamentalFlags.available
        ? (fundamentalFlags.negativeMaterial ? 'negative materialを検出' : 'Finnhub現在材料による判定')
        : 'Finnhub補助データがありません'
    )
  ];
}

function scoreTechnicalSetup(indicators, theme, fundamental, options = {}) {
  const daily = indicators?.daily || {};
  const weekly = indicators?.weekly || {};
  const dailyFlags = daily.flags || {};
  const weeklyFlags = weekly.flags || {};
  const fundamentalFlags = fundamentalSignalFlags(fundamental);
  const component = (key, label, maximum, state, value = null) => ({
    key,
    label,
    maximum,
    available: state === true || state === false,
    passed: state === true,
    value,
    points: state === true ? maximum : 0
  });
  const dailyComponents = [
    component(
      'rsiRecovery',
      'RSI反転',
      10,
      dailyFlags.rsiRecovery == null || daily.rsi14 == null
        ? null
        : dailyFlags.rsiRecovery === true && daily.rsi14 >= 30 && daily.rsi14 <= 40,
      daily.rsi14
    ),
    component('macdGoldenCross', 'MACD GC', 12, dailyFlags.macdGoldenCross, daily.macd?.histogram),
    component(
      'macdHistogramImproving',
      'MACD histogram改善',
      5,
      dailyFlags.macdHistogramImproving,
      daily.macd?.histogram
    ),
    component('ema20Recovery', 'EMA20回復', 8, dailyFlags.ema20Recovery, daily.ema20),
    component('ema50Recovery', 'EMA50回復', 5, dailyFlags.ema50Recovery, daily.ema50),
    component('volumeExpansion', '出来高拡大', 5, dailyFlags.volumeExpansion, daily.rvol20)
  ];
  const weeklyMacdUp = weekly.macd?.histogram == null || weekly.previous?.macd?.histogram == null
    ? null
    : weekly.macd.histogram > weekly.previous.macd.histogram;
  const weeklyComponents = [
    component('weeklyRsi50', '週足RSI>=50', 5, weekly.rsi14 == null ? null : weekly.rsi14 >= 50, weekly.rsi14),
    component('weeklyMacdUp', '週足MACD上向き', 7, weeklyMacdUp, weekly.macd?.histogram),
    component('weeklyAboveEma20', '週足price>EMA20', 4, weekly.price == null || weekly.ema20 == null
      ? null
      : weekly.price > weekly.ema20, weekly.ema20),
    component('weeklyAboveEma50', '週足price>EMA50', 4, weekly.price == null || weekly.ema50 == null
      ? null
      : weekly.price > weekly.ema50, weekly.ema50)
  ];
  const themeReady = theme?.status === 'ok';
  const themeComponents = [
    component('themeScore75', 'テーマscore>=75', 8, !themeReady || finite(theme?.score) == null
      ? null
      : finite(theme.score) >= 75, round(theme?.score, 1)),
    component('themeTrendUp', 'テーマtrend up', 4, !themeReady || !theme?.trend
      ? null
      : String(theme.trend).toLowerCase() === 'up', theme?.trend || null),
    component('themeBreadth60', 'テーマbreadth>=60%', 3, !themeReady || finite(theme?.breadth) == null
      ? null
      : finite(theme.breadth) >= 60, round(theme?.breadth, 1))
  ];
  const fundamentalComponents = [
    component('goodEarnings', '好決算', 7, fundamentalFlags.goodEarnings),
    component('guidanceUp', 'guidance up', 5, fundamentalFlags.guidanceUp),
    component('revenueGrowth', '売上成長', 4, fundamentalFlags.revenueGrowth),
    component('positiveCatalyst', 'positive catalyst', 4, fundamentalFlags.positiveCatalyst)
  ];
  const groups = [
    { key: 'daily', maximum: 45, components: dailyComponents },
    { key: 'weekly', maximum: 20, components: weeklyComponents },
    { key: 'theme', maximum: 15, components: themeComponents },
    { key: 'fundamentalNews', maximum: 20, components: fundamentalComponents }
  ].map(group => ({
    ...group,
    points: group.components.reduce((sum, item) => sum + item.points, 0),
    availablePoints: group.components
      .filter(item => item.available)
      .reduce((sum, item) => sum + item.maximum, 0)
  }));
  const rawScore = groups.reduce((sum, group) => sum + group.points, 0);
  const deductions = [];
  const addDeduction = (key, label, points, active, value = null) => {
    if (active) deductions.push({ key, label, points: -Math.abs(points), value });
  };
  addDeduction('rsi70', 'RSI>=70', 10, daily.rsi14 >= 70, daily.rsi14);
  addDeduction('rsi80', 'RSI>=80 追加', 10, daily.rsi14 >= 80, daily.rsi14);
  addDeduction('fiveDay20', '5日騰落>=20%', 10, daily.change5dPct >= 20, daily.change5dPct);
  const distanceToHigh20 = daily.high20 > 0
    ? ((daily.high20 - daily.price) / daily.high20) * 100
    : null;
  addDeduction(
    'near20High',
    '20日高値以内3%',
    5,
    distanceToHigh20 != null && distanceToHigh20 >= 0 && distanceToHigh20 <= 3,
    round(distanceToHigh20, 2)
  );
  const earningsDays = finite(options.earningsDays);
  addDeduction(
    'earningsNear',
    '決算<=3営業日',
    10,
    earningsDays != null && earningsDays >= 0 && earningsDays <= 3,
    earningsDays
  );
  const dailyMacdDeath = daily.macd?.deadCross === true;
  const weeklyMacdDeath = weekly.macd?.deadCross === true;
  addDeduction(
    'bothMacdDeath',
    '日週両MACD DC',
    15,
    dailyMacdDeath && weeklyMacdDeath
  );
  const belowAll = daily.price != null &&
    [daily.ema20, daily.ema50, daily.ema200].every(value => value != null && daily.price < value);
  addDeduction('belowAllEma', 'priceがEMA20/50/200全下', 10, belowAll);
  addDeduction(
    'negativeMaterial',
    'negative material',
    20,
    fundamentalFlags.negativeMaterial === true
  );
  addDeduction('partial', 'partial data', 10, options.partial === true);
  addDeduction('stale', 'stale data', 15, options.stale === true);
  return {
    maximum: 100,
    groups,
    rawScore,
    deductions,
    scoreBeforeCaps: clamp(
      rawScore + deductions.reduce((sum, item) => sum + item.points, 0),
      0,
      100
    ),
    diagnostics: {
      distanceToHigh20Pct: round(distanceToHigh20, 2),
      earningsDays,
      dailyMacdDeath,
      weeklyMacdDeath,
      belowAllEma: belowAll
    }
  };
}

function buildPositionPlan(indicators, account = {}) {
  const daily = indicators?.daily || {};
  const entry = finite(daily.price);
  const priorLow = finite(daily.priorLow20);
  const recentLow = finite(daily.low20) ?? priorLow;
  const ema20 = finite(daily.ema20);
  if (!(entry > 0) || !(recentLow > 0) || !(ema20 > 0)) {
    return {
      mode: 'SIMULATE',
      available: false,
      amount: 0,
      amountJpy: 0,
      amountUsd: 0,
      shares: 0,
      entry: round(entry, 4),
      entryLow: null,
      entryHigh: null,
      ema20RecoveryPrice: round(ema20, 4),
      breakoutPrice: round(daily.priorHigh20, 4),
      chaseLimitPrice: null,
      stop: null,
      stopPx: null,
      take: null,
      take1: null,
      take2: null,
      take1Px: null,
      take2Px: null,
      riskPerShare: null,
      rewardPerShare: null,
      riskReward: null,
      currency: 'JPY',
      reason: 'entry/20日安値/EMA20が不足しています',
      remainderRule: null,
      tradeEligible: false
    };
  }
  const ema200 = finite(daily.ema200);
  const stopCandidates = [
    recentLow,
    entry * 0.93,
    ema200 > 0 && ema200 < entry ? ema200 : null
  ].filter(value => value > 0 && value < entry);
  const technicalStop = Math.max(...stopCandidates);
  const stop = clamp(technicalStop, entry * 0.9, entry * 0.99);
  const riskPerShare = entry - stop;
  const take1 = entry * 1.14;
  const take2 = entry * 1.25;
  const rewardPerShare = take1 - entry;
  const riskReward = riskPerShare > 0 ? rewardPerShare / riskPerShare : null;
  const ema20RecoveryPrice = ema20;
  const breakoutPrice = finite(daily.priorHigh20);
  const chaseLimitPrice = Math.max(entry, Math.min(entry * 1.03, ema20 * 1.08));
  const entryLow = Math.min(entry, Math.max(ema20, entry * 0.98));
  const entryHigh = Math.max(entryLow, chaseLimitPrice);
  const usdJpy = finite(account?.usdJpy);
  const equityJpy = finite(account?.equityJpy);
  const cashJpy = finite(account?.cashJpy);
  const configuredRisk = finite(account?.riskBudgetJpy);
  const riskBudgetJpy = configuredRisk ?? (equityJpy == null ? null : equityJpy * 0.01);
  const existingOpenRiskJpy = Math.max(0, finite(account?.existingOpenRiskJpy) ?? 0);
  const existingTickerValueJpy = Math.max(0, finite(account?.existingTickerValueJpy) ?? 0);
  const maxPositionPct = clamp(finite(account?.maxPositionPct) ?? 10, 0.1, 100);
  const slippageBufferPct = clamp(finite(account?.slippageBufferPct) ?? 2, 0, 25);
  const accountAvailable = usdJpy > 0 && equityJpy != null && cashJpy != null && riskBudgetJpy != null;
  const leveragedProduct = account?.leveragedProduct === true;
  const leverageUnknown = account?.leverageStatus === 'unavailable';
  let shares = 0;
  let reason = '';
  if (leveragedProduct) {
    reason = 'レバレッジ商品は新規買い増しをシミュレーションしません';
  } else if (leverageUnknown) {
    reason = 'ETFのレバレッジ判定メタデータが不足しているため新規買い数量を算出しません';
  } else if (accountAvailable) {
    const remainingRiskJpy = Math.max(0, riskBudgetJpy - existingOpenRiskJpy);
    const positionCapacityJpy = Math.max(0, equityJpy * maxPositionPct / 100 - existingTickerValueJpy);
    const cashCapacityJpy = Math.max(0, cashJpy / (1 + slippageBufferPct / 100));
    const riskShares = Math.floor(remainingRiskJpy / (riskPerShare * usdJpy));
    const positionShares = Math.floor(positionCapacityJpy / (entry * usdJpy));
    const cashShares = Math.floor(cashCapacityJpy / (entry * usdJpy));
    shares = Math.max(0, Math.min(riskShares, positionShares, cashShares));
    if (!shares) reason = remainingRiskJpy <= 0
      ? '既存オープンリスクがリスク予算以上です'
      : '現金・集中上限・リスク予算から購入可能株数を確保できません';
  } else {
    reason = '口座枠またはUSD/JPYが未設定のため株数は算出しません';
  }
  const amountUsd = shares * entry;
  const amountJpy = usdJpy > 0 ? amountUsd * usdJpy : 0;
  return {
    mode: 'SIMULATE',
    available: accountAvailable,
    amount: round(amountJpy, 0) || 0,
    amountJpy: round(amountJpy, 0) || 0,
    amountUsd: round(amountUsd, 2) || 0,
    shares,
    entry: round(entry, 4),
    entryLow: round(entryLow, 4),
    entryHigh: round(entryHigh, 4),
    ema20RecoveryPrice: round(ema20RecoveryPrice, 4),
    breakoutPrice: round(breakoutPrice, 4),
    chaseLimitPrice: round(chaseLimitPrice, 4),
    stop: round(stop, 4),
    stopPx: round(stop, 4),
    take: round(take1, 4),
    take1: round(take1, 4),
    take2: round(take2, 4),
    take1Px: round(take1, 4),
    take2Px: round(take2, 4),
    riskPerShare: round(riskPerShare, 4),
    rewardPerShare: round(rewardPerShare, 4),
    riskReward: round(riskReward, 2),
    currency: 'JPY',
    reason,
    remainderRule: 'take1で50%を利確し、残りはEMA20終値割れまたはtake2で終了するSIMULATE規則',
    constraints: {
      riskBudgetJpy: round(riskBudgetJpy, 0),
      existingOpenRiskJpy: round(existingOpenRiskJpy, 0),
      maxPositionPct,
      slippageBufferPct
    },
    tradeEligible: false
  };
}

function normalizeTheme(theme) {
  if (!theme || typeof theme !== 'object') {
    return { status: 'unavailable', id: null, name: null, score: null };
  }
  return {
    id: String(theme.id || ''),
    name: String(theme.name || theme.id || ''),
    status: theme.status === 'ok' ? 'ok' : (theme.status || 'unavailable'),
    score: round(theme.score, 1),
    estimatedRotationIndex: round(theme.estimatedRotationIndex ?? theme.netFlow, 1),
    breadth: round(theme.breadth, 1),
    confidence: round(theme.confidence, 1),
    trend: theme.trend || null,
    asOf: theme.asOf || null
  };
}

function buildBuySignalResult(input = {}) {
  const symbol = String(input.symbol || '').trim().toUpperCase();
  const history = input.history && typeof input.history === 'object' ? input.history : {};
  const bars = sanitizeBars(history.bars);
  const indicators = calculateTechnicalIndicators(bars);
  const theme = normalizeTheme(input.theme);
  const fundamental = input.fundamental && typeof input.fundamental === 'object'
    ? input.fundamental
    : {
        status: 'unavailable',
        metrics: null,
        earnings: [],
        earningsCalendar: [],
        news: [],
        earningsDays: null,
        flags: {
          goodEarnings: null,
          guidanceUp: null,
          revenueGrowth: null,
          positiveCatalyst: null,
          negativeMaterial: null
        },
        reason: 'Finnhub補助データは未接続です'
      };
  const signalsList = evaluateEightSignals(indicators, theme, fundamental);
  const daily = indicators.daily;
  const weekly = indicators.weekly;
  const warnings = [];
  const priceMode = history.priceMode === 'adjusted' &&
    bars.every(bar => bar.priceMode === 'adjusted') ? 'adjusted' : 'raw';
  const latestTimestamp = Date.parse(`${daily.asOf || ''}T23:59:59Z`);
  const nowMs = finite(input.nowMs) ?? Date.now();
  const stale = history.stale === true ||
    String(history.cacheState || '').toLowerCase().includes('stale') ||
    (Number.isFinite(latestTimestamp) && nowMs - latestTimestamp > 7 * 24 * 60 * 60 * 1000);
  const sufficient = bars.length >= 1_000 && indicators.weekly.bars >= 200 &&
    daily.available && weekly.available;
  const leverageDetection = input.leveragedProduct === true
    ? {
        status: 'leveraged',
        leveraged: true,
        source: 'theme-catalog',
        quoteType: history.quoteType || history.instrumentType || null,
        name: history.longName || history.shortName || null,
        matchedPattern: 'catalog-flag'
      }
    : detectLeveragedProduct(symbol, history);
  const leverageStatus = leverageDetection.status;
  const leveragedProduct = leverageDetection.leveraged === true;
  const leverageUnknown = leverageStatus === 'unavailable';
  const partial = history.partial === true || priceMode !== 'adjusted' ||
    signalsList.some(signal => signal.state == null) ||
    theme.status !== 'ok' ||
    !['ok'].includes(fundamental.status) ||
    leverageUnknown;
  const earningsDays = finite(
    input.earningsDays ?? fundamental.earningsDays ?? fundamental.daysToEarnings
  );
  const chaseBlocked = daily.rsi14 >= 80 || daily.change5dPct >= 25;
  const earningsBlocked = earningsDays != null && earningsDays >= 0 && earningsDays <= 3;
  if (leveragedProduct) warnings.push('日次レバレッジ商品はBUY判定を禁止します');
  if (daily.rsi14 >= 80) warnings.push('RSI>=80のため高値追いを禁止します');
  if (daily.change5dPct >= 25) warnings.push('5日騰落>=25%のため高値追いを禁止します');
  if (earningsBlocked) warnings.push(`決算まで${earningsDays}営業日のためBUY判定を制限します`);
  if (priceMode !== 'adjusted') warnings.push('未調整終値のため企業行動を跨ぐ判定を確定しません');
  if (stale) warnings.push('最終日足が古いため判定を確定しません');
  if (!sufficient) warnings.push('5年評価に必要な日足・完成週足の履歴が不足しています');
  if (leverageUnknown) {
    warnings.push('ETFのレバレッジ判定メタデータが不足しているためBUY判定を制限します');
  }
  const positionPlan = buildPositionPlan(indicators, {
    ...(input.account || {}),
    leveragedProduct,
    leverageStatus
  });
  const riskReward = finite(positionPlan.riskReward);
  const riskRewardDetail = {
    available: riskReward != null,
    ratio: riskReward,
    minimum: 1.8,
    eligible: riskReward != null && riskReward >= 1.8,
    passed: riskReward != null && riskReward >= 1.8,
    blocked: riskReward == null || riskReward < 1.8,
    reason: riskReward == null
      ? 'entry/stop/take1からRRを計算できません'
      : (riskReward >= 1.8 ? 'take1 ÷ risk が1.8以上' : 'take1 ÷ risk が1.8未満'),
    entry: positionPlan.entry,
    stop: positionPlan.stop,
    take: positionPlan.take1
  };
  const scoreBreakdown = scoreTechnicalSetup(indicators, theme, fundamental, {
    earningsDays,
    partial,
    stale
  });
  let score = scoreBreakdown.scoreBeforeCaps;
  const caps = [];
  if (riskRewardDetail.blocked) caps.push({ key: 'risk-reward', maximum: 79, decisionMaximum: 'check' });
  if (chaseBlocked) caps.push({ key: 'chase-block', maximum: 79, decisionMaximum: 'check' });
  if (earningsBlocked) caps.push({ key: 'earnings', maximum: 79, decisionMaximum: 'check' });
  if (leveragedProduct) caps.push({ key: 'leveraged-product', maximum: 79, decisionMaximum: 'check' });
  if (leverageUnknown) caps.push({ key: 'leverage-unavailable', maximum: 79, decisionMaximum: 'check' });
  if (stale) caps.push({ key: 'stale', maximum: 69, decisionMaximum: 'wait' });
  caps.forEach(cap => { score = Math.min(score, cap.maximum); });
  score = Math.round(score);
  let decision = score >= 90
    ? 'strong_buy_watch'
    : (score >= 80
        ? 'buy_watch'
        : (score >= 70 ? 'check' : (score >= 55 ? 'wait' : 'avoid')));
  if (!sufficient) decision = 'unavailable';
  const active = ['strong_buy_watch', 'buy_watch'].includes(decision) &&
    !leveragedProduct && !leverageUnknown && !chaseBlocked && !earningsBlocked &&
    !riskRewardDetail.blocked && !stale && positionPlan.shares > 0;
  const activeSignals = signalsList.filter(signal => signal.state === true).length;
  const availableSignals = signalsList.filter(signal => signal.state != null).length;
  const coveragePct = Math.round(
    (availableSignals / SIGNAL_DEFINITIONS.length) * 100
  );
  scoreBreakdown.caps = caps;
  scoreBreakdown.finalScore = score;
  const signalStates = Object.fromEntries(signalsList.map(signal => [
    signal.key,
    signal.state == null ? 'unavailable' : signal.state
  ]));
  const reasons = [
    ...scoreBreakdown.groups.flatMap(group => group.components
      .filter(component => component.passed)
      .map(component => `${component.label} +${component.points}`)),
    ...caps.map(cap => `${cap.key} cap ${cap.maximum}`)
  ].slice(0, 16);
  return {
    symbol,
    ticker: symbol,
    status: !sufficient ? 'unavailable' : (stale ? 'stale' : (partial ? 'partial' : 'ok')),
    dataStatus: !sufficient ? 'unavailable' : (stale ? 'stale' : (partial ? 'partial' : 'ok')),
    stale,
    available: sufficient && !stale,
    active,
    asOf: daily.asOf,
    price: daily.price,
    score,
    decision,
    recommendation: decision,
    signals: {
      ...signalStates,
      active: activeSignals,
      available: availableSignals,
      total: SIGNAL_DEFINITIONS.length,
      checks: signalsList
    },
    signalsList,
    scoreBreakdown,
    deductions: scoreBreakdown.deductions,
    caps,
    indicators: { daily, weekly },
    technical: {
      daily,
      weekly,
      supportCandidates: indicators.supportCandidates,
      vwap: indicators.vwap,
      volumeProfile: indicators.volumeProfile
    },
    theme,
    fundamental,
    earningsDays,
    earningsBlocked,
    quality: {
      coveragePct,
      dailyBars: bars.length,
      weeklyBars: indicators.weekly.bars,
      priceMode,
      adjusted: priceMode === 'adjusted',
      stale,
      sufficient,
      source: history.source || null,
      cacheState: history.cacheState || null,
      cacheAgeMs: finite(history.cacheAgeMs),
      completedWeeklyOnly: true,
      currentWeekExcluded: weekly.partialCurrentWeekExcluded === true
    },
    riskReward,
    riskRewardDetail,
    positionPlan,
    leveragedProduct,
    leverageStatus,
    leverageBlocked: leverageStatus !== 'unleveraged',
    leverageProvenance: leverageDetection,
    chaseBlocked,
    warnings,
    reasons,
    provenance: {
      source: history.source || null,
      priceMode,
      range: '5y',
      interval: '1d',
      methodVersion: TECHNICAL_METHOD_VERSION,
      themeSource: theme.status === 'ok' ? 'theme-intelligence' : null,
      fundamentalsSource: fundamental.status === 'ok' || fundamental.status === 'partial'
        ? 'finnhub'
        : null,
      leverage: leverageDetection,
      vwap: { available: false, reason: 'Intraday bars are not connected.' },
      volumeProfile: { available: false, reason: 'Price-at-volume history is not connected.' }
    },
    execution: { ...SIMULATION_EXECUTION },
    tradeEligible: false
  };
}

function weeklyRowsByDailyDate(dailyBars, weeklyRows) {
  const byDate = new Map();
  let weeklyIndex = -1;
  for (const bar of dailyBars) {
    const currentWeek = isoWeekKey(bar.sessionDate);
    while (
      weeklyIndex + 1 < weeklyRows.length &&
      String(weeklyRows[weeklyIndex + 1]?.weekStart || isoWeekKey(weeklyRows[weeklyIndex + 1]?.sessionDate)) < currentWeek
    ) {
      weeklyIndex += 1;
    }
    byDate.set(bar.sessionDate, weeklyIndex >= 0 ? weeklyRows[weeklyIndex] : null);
  }
  return byDate;
}

function backtestSignalFlags(rows, index) {
  const row = rows[index];
  const previous = rows[index - 1];
  if (!row) return {};
  const priorFive = rows.slice(Math.max(0, index - 5), index);
  const rsiRecovery = row.rsi14 != null && previous?.rsi14 != null &&
    row.rsi14 > 30 && row.rsi14 <= 40 && row.rsi14 > previous.rsi14 &&
    priorFive.some(item => item.rsi14 != null && item.rsi14 <= 30);
  const macdGoldenCross = row.macd?.line != null && row.macd?.signal != null &&
    previous?.macd?.line != null && previous?.macd?.signal != null &&
    previous.macd.line <= previous.macd.signal && row.macd.line > row.macd.signal;
  const ema20Recovery = row.ema20 != null && previous?.ema20 != null && (
    (previous.close <= previous.ema20 && row.close > row.ema20) ||
    (previous.close > previous.ema20 && row.close > row.ema20)
  );
  const volumeExpansion = row.rvol20 != null && row.rvol20 >= 1.5 &&
    (row.close > row.open || (previous?.close != null && row.close > previous.close));
  return {
    rsiOversold: row.rsi14 != null && row.rsi14 <= 30,
    rsiRecovery,
    macdGoldenCross,
    ema20Recovery,
    volumeExpansion
  };
}

function strategyState(id, rows, index) {
  const flags = backtestSignalFlags(rows, index);
  return {
    A: flags.rsiOversold === true,
    B: flags.rsiRecovery === true,
    C: flags.rsiRecovery === true && flags.macdGoldenCross === true,
    D: flags.rsiRecovery === true && flags.macdGoldenCross === true &&
      flags.ema20Recovery === true,
    E: flags.rsiRecovery === true && flags.macdGoldenCross === true &&
      flags.ema20Recovery === true && flags.volumeExpansion === true
  }[id] === true;
}

function benchmarkRegime(row, benchmarkRowsByDate) {
  const benchmark = benchmarkRowsByDate.get(row.sessionDate);
  if (!benchmark) return 'unknown';
  const belowLongTrend = benchmark.ema200 != null && benchmark.close < benchmark.ema200;
  const shortShock = benchmark.change5dPct != null && benchmark.change5dPct <= -5;
  const mediumShock = benchmark.change20dPct != null && benchmark.change20dPct <= -10;
  const drawdown = benchmark.high20 > 0
    ? ((benchmark.close / benchmark.high20) - 1) * 100
    : null;
  return mediumShock || (belowLongTrend && shortShock) || (drawdown != null && drawdown <= -12)
    ? 'crash'
    : 'normal';
}

function summarizeTrades(trades) {
  if (!trades.length) {
    return {
      signalCount: 0,
      trades: 0,
      winRatePct: null,
      totalReturnPct: 0,
      averageGainPct: null,
      averageLossPct: null,
      averageReturnPct: null,
      rewardRisk: null,
      profitFactor: null,
      maxDrawdownPct: 0
    };
  }
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const trade of trades) {
    equity *= 1 + trade.returnPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, (equity / peak - 1) * 100);
    if (trade.returnPct > 0) grossProfit += trade.returnPct;
    else grossLoss += Math.abs(trade.returnPct);
  }
  const gains = trades.filter(trade => trade.returnPct > 0).map(trade => trade.returnPct);
  const losses = trades.filter(trade => trade.returnPct < 0).map(trade => trade.returnPct);
  const averageGainPct = gains.length
    ? gains.reduce((sum, value) => sum + value, 0) / gains.length
    : null;
  const averageLossPct = losses.length
    ? losses.reduce((sum, value) => sum + value, 0) / losses.length
    : null;
  return {
    signalCount: trades.length,
    trades: trades.length,
    winRatePct: round((trades.filter(trade => trade.returnPct > 0).length / trades.length) * 100, 1),
    totalReturnPct: round((equity - 1) * 100, 2),
    averageGainPct: round(averageGainPct, 2),
    averageLossPct: round(averageLossPct, 2),
    averageReturnPct: round(
      trades.reduce((sum, trade) => sum + trade.returnPct, 0) / trades.length,
      2
    ),
    rewardRisk: averageGainPct != null && averageLossPct != null && averageLossPct < 0
      ? round(averageGainPct / Math.abs(averageLossPct), 2)
      : null,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 2) : (grossProfit > 0 ? null : 0),
    maxDrawdownPct: round(maxDrawdown, 2)
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('technical backtest was cancelled');
  error.name = 'AbortError';
  error.code = 'CLIENT_ABORT';
  throw error;
}

function simulateStrategy(id, dailyRows, evaluationStart, splitDate, costs, benchmarkRowsByDate, signal) {
  const trades = [];
  let cursor = dailyRows.findIndex(row => row.sessionDate >= evaluationStart);
  if (cursor < 0) return trades;
  while (cursor < dailyRows.length - 21) {
    if (cursor % 64 === 0) throwIfAborted(signal);
    const signalRow = dailyRows[cursor];
    if (!strategyState(id, dailyRows, cursor)) {
      cursor += 1;
      continue;
    }
    const entryIndex = cursor + 1;
    const entryBar = dailyRows[entryIndex];
    const rawEntry = entryBar?.open;
    if (!(rawEntry > 0)) {
      cursor += 1;
      continue;
    }
    const entry = rawEntry * (1 + costs.entryBps / 10_000);
    const returns = {};
    const exits = {};
    for (const horizon of [5, 10, 20]) {
      const exitIndex = entryIndex + horizon - 1;
      const rawExit = dailyRows[exitIndex]?.close;
      if (!(rawExit > 0)) continue;
      const exit = rawExit * (1 - costs.exitBps / 10_000);
      returns[horizon] = round(((exit / entry) - 1) * 100, 4);
      exits[horizon] = {
        date: dailyRows[exitIndex].sessionDate,
        price: round(exit, 4)
      };
    }
    if (Object.keys(returns).length !== 3) {
      cursor += 1;
      continue;
    }
    trades.push({
      signalDate: signalRow.sessionDate,
      entryDate: entryBar.sessionDate,
      entry: round(entry, 4),
      returns,
      exits,
      sample: signalRow.sessionDate < splitDate ? 'train' : 'test',
      regime: benchmarkRegime(signalRow, benchmarkRowsByDate)
    });
    cursor += 1;
  }
  return trades;
}

function horizonSummary(trades, horizon) {
  return summarizeTrades(trades
    .filter(trade => finite(trade?.returns?.[horizon]) != null)
    .map(trade => ({ ...trade, returnPct: trade.returns[horizon] })));
}

function runTechnicalBacktest(values, options = {}) {
  throwIfAborted(options.signal);
  const bars = sanitizeBars(values);
  const daily = calculateIndicatorSeries(bars);
  if (daily.bars.length < 700) {
    return {
      status: 'unavailable',
      methodVersion: BACKTEST_METHOD_VERSION,
      reason: '2年評価と指標ウォームアップに必要な日足が不足しています',
      strategies: []
    };
  }
  const weeklyBars = aggregateWeeklyBars(daily.bars);
  const weekly = calculateIndicatorSeries(weeklyBars);
  // This map is intentionally built even though A-E use daily inputs only:
  // it validates that any future multi-timeframe extension sees completed
  // prior weeks and never the final values of an in-progress week.
  weeklyRowsByDailyDate(daily.bars, weekly.rows);
  const endDate = daily.bars.at(-1).sessionDate;
  const end = new Date(`${endDate}T00:00:00Z`);
  const evaluationStartDate = new Date(end);
  evaluationStartDate.setUTCFullYear(evaluationStartDate.getUTCFullYear() - 2);
  const evaluationStart = evaluationStartDate.toISOString().slice(0, 10);
  const evaluationRows = daily.rows.filter(row => row.sessionDate >= evaluationStart);
  if (evaluationRows.length < 400) {
    return {
      status: 'unavailable',
      methodVersion: BACKTEST_METHOD_VERSION,
      reason: '直近2年の取引日が不足しています',
      strategies: []
    };
  }
  const splitIndex = Math.max(1, Math.min(
    evaluationRows.length - 1,
    Math.floor(evaluationRows.length * 0.7)
  ));
  const splitDate = evaluationRows[splitIndex].sessionDate;
  const benchmarkBars = sanitizeBars(options.benchmarkBars);
  const benchmark = calculateIndicatorSeries(benchmarkBars);
  const benchmarkRowsByDate = new Map(benchmark.rows.map(row => [row.sessionDate, row]));
  const commissionBps = clamp(finite(options.commissionBps) ?? 0, 0, 500);
  const slippageBps = clamp(finite(options.slippageBps) ?? 10, 0, 500);
  const costs = {
    entryBps: commissionBps + slippageBps,
    exitBps: commissionBps + slippageBps
  };
  const names = {
    A: 'RSI<=30',
    B: 'RSI<=30から反転',
    C: 'B + MACDゴールデンクロス',
    D: 'C + EMA20回復',
    E: 'D + RVOL>=1.5・陽線'
  };
  const strategies = Object.keys(names).map(id => {
    throwIfAborted(options.signal);
    const trades = simulateStrategy(
      id,
      daily.rows,
      evaluationStart,
      splitDate,
      costs,
      benchmarkRowsByDate,
      options.signal
    );
    const train = trades.filter(trade => trade.sample === 'train');
    const test = trades.filter(trade => trade.sample === 'test');
    const normal = trades.filter(trade => trade.regime === 'normal');
    const crash = trades.filter(trade => trade.regime === 'crash');
    const unknown = trades.filter(trade => trade.regime === 'unknown');
    const horizons = Object.fromEntries([5, 10, 20].map(horizon => [
      String(horizon),
      {
        sessions: horizon,
        all: horizonSummary(trades, horizon),
        train: horizonSummary(train, horizon),
        test: horizonSummary(test, horizon),
        regimes: {
          normal: horizonSummary(normal, horizon),
          crash: horizonSummary(crash, horizon),
          unknown: horizonSummary(unknown, horizon)
        }
      }
    ]));
    return {
      id,
      name: names[id],
      status: trades.length ? 'ok' : 'partial',
      signalCount: trades.length,
      horizons,
      all: horizons['20'].all,
      train: horizons['20'].train,
      test: horizons['20'].test,
      regimes: horizons['20'].regimes,
      trades
    };
  });
  strategies.push({
    id: 'F',
    name: '完成版スコア80以上',
    status: 'unavailable',
    reason: 'Point-in-timeのニュース・決算・ファンダメンタル履歴が未接続で、将来情報混入を防ぐため検証しません。',
    all: null,
    train: null,
    test: null,
    regimes: null,
    trades: []
  });
  return {
    status: 'ok',
    methodVersion: BACKTEST_METHOD_VERSION,
    window: {
      warmupStart: daily.bars[0].sessionDate,
      evaluationStart,
      end: endDate,
      sessions: evaluationRows.length
    },
    split: {
      method: 'chronological-70-30',
      trainPct: 70,
      testPct: 30,
      splitDate
    },
    assumptions: {
      signalObservedAt: 'confirmed daily close',
      entryExecution: 'next-session open',
      returnMeasurement: 'adjusted close after +5/+10/+20 sessions',
      overlappingSignals: true,
      commissionBpsPerSide: commissionBps,
      slippageBpsPerSide: slippageBps,
      benchmark: benchmarkBars.length ? 'SPY' : 'unavailable',
      priceMode: options.priceMode || 'unknown',
      dividendsAndSplits: options.priceMode === 'adjusted' ? 'adjusted-price series' : 'not reliably adjusted',
      pointInTimeConstituents: false,
      survivorshipWarning: 'Current requested symbols are backcast; delisted securities are absent.'
    },
    strategies
  };
}

module.exports = {
  BACKTEST_METHOD_VERSION,
  KNOWN_LEVERAGED_SYMBOLS,
  KNOWN_NON_LEVERAGED_ETFS,
  SIGNAL_DEFINITIONS,
  SIMULATION_EXECUTION,
  TECHNICAL_METHOD_VERSION,
  aggregateWeeklyBars,
  atrSeries,
  backtestSignalFlags,
  buildBuySignalResult,
  buildPositionPlan,
  calculateIndicatorSeries,
  calculateTechnicalIndicators,
  detectLeveragedProduct,
  emaSeries,
  evaluateEightSignals,
  fundamentalSignalFlags,
  indicatorSnapshot,
  isoWeekKey,
  macdSeries,
  relativeVolumeSeries,
  rollingRangeSeries,
  rsiSeries,
  runTechnicalBacktest,
  sanitizeBars,
  scoreTechnicalSetup,
  strategyState,
  summarizeTrades
};
