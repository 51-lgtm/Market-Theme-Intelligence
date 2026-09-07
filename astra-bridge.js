'use strict';

// A bounded adapter over the existing provider caches; the Python layer remains
// the only owner of Commander, risk policy and simulated execution.
async function astraEvidence(marketData, symbols, signal) {
  const macro = ['SPY', 'QQQ', 'IWM', '^VIX', '^TNX', 'DX-Y.NYB', 'BTC-USD', 'JPY=X', 'CL=F'];
  const requested = [...new Set([...symbols, ...macro])];
  const values = await Promise.allSettled([
    marketData.getSnapshot(requested, { signal }),
    marketData.getBuySignals({ symbols, signal }),
    marketData.getThemeIntelligence({ signal }),
    marketData.getMarketRegime({ signal })
  ]);
  const get = index => values[index].status === 'fulfilled' ? values[index].value : null;
  const snapshot = get(0), technical = get(1), themes = get(2), market = get(3);
  const histories = {}, news = {};
  // The successful signal call has already populated this dedicated cache.
  const context = { deadlineAt: marketData.clock() + 10000, signal };
  const cached = await marketData._getTechnicalHistories(symbols, context).catch(() => new Map());
  for (const symbol of symbols) {
    const history = cached.get(symbol);
    histories[symbol] = history ? {
      bars: history.bars || [], status: history.status || 'partial',
      as_of: history.bars?.at(-1)?.at || null, price_mode: history.priceMode || null,
      source: history.source || null, meta: history.meta || {}
    } : { bars: [], status: 'unavailable' };
    const evidence = marketData.technicalFinnhubCache?.get(symbol)?.value;
    news[symbol] = evidence?.news || [];
  }
  return {
    status: snapshot && technical ? 'partial' : 'unavailable',
    as_of: snapshot?.at || snapshot?.updatedAt || new Date().toISOString(),
    quotes: [
      ...Object.entries(snapshot?.quotes || {}).map(([symbol, quote]) => ({ ...quote, symbol })),
      ...(snapshot?.fx?.usdJpy != null ? [{ ...snapshot.fx, symbol: 'JPY=X', price: snapshot.fx.usdJpy }] : [])
    ],
    buy_signals: technical?.results || [], themes: themes?.themes || [],
    market: market || {}, histories, news, sec: {},
    provenance: { bridge: 'legacy-v14', provider_status: snapshot?.meta?.status || 'unavailable',
      technical_status: technical?.status || 'unavailable', actual_fund_flow: false }
  };
}

module.exports = { astraEvidence };
