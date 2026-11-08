'use strict';

const METHOD = 'explicit-group-aligned-daily-peers-v1';
const DAY = 86400000;
const number = value => typeof value === 'number' && Number.isFinite(value);
const symbolOf = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const median = values => { const a = [...values].sort((x,y)=>x-y); return a.length % 2 ? a[(a.length-1)/2] : (a[a.length/2-1]+a[a.length/2])/2; };
const LIMITATIONS = Object.freeze([
  '明示された同一グループのうち、今回取得した銘柄だけを比較します。全米株の網羅調査ではありません。',
  '同じテーマは同じ事業・評価倍率を意味しません。業績・決算・希薄化・売買コストは未評価です。',
  '相関は同時期の日次騰落率の連動性で、チャートの将来形や上昇確率を示しません。20本は短い観測です。',
  '調整済み終値は企業行動で改訂されます。取引所カレンダー未照合のため欠落日を完全には検出できません。',
  '中央値は取得できた比較対象だけの値です。対象の欠測や選択によって結論が変わります。'
]);

function inspect(result, history, nowMs) {
  const fail = (code, reason) => ({ code, reason });
  if (!result || !history) return fail('missing_data', '今回の分析結果または日足履歴が未取得です。');
  if (result.leveragedProduct === true || result.leverageStatus !== 'unleveraged') return fail('leverage_unconfirmed', 'レバレッジ商品、または商品の非レバレッジ性が未確認です。');
  if (!['ok','partial'].includes(result.status) || result.stale || result.quality?.stale || history.stale || /stale/i.test(history.cacheState || '') || history.status === 'stale') return fail('stale_or_failed', '古い値または取得失敗のため比較しません。');
  if (history.partial || (history.status && !['ok','fresh'].includes(history.status)) || (history.ohlcCoveragePct != null && history.ohlcCoveragePct !== 100)) return fail('partial_history', '履歴の欠測または取得状態の問題があります。');
  if (history.priceMode !== 'adjusted' || result.quality?.adjusted !== true || history.interval !== '1d') return fail('incompatible_basis', '同じ調整済み日足の条件を確認できません。');
  if (history.containsOpenSession || history.currentSessionComplete === false) return fail('open_session', '未確定足を含むため比較しません。');
  if (typeof history.source !== 'string' || !history.source.trim()) return fail('missing_source', '履歴の取得元が未確認です。');
  if (history.currency !== 'USD') return fail('currency_unconfirmed', '米ドル建ての比較条件が未確認です。');
  if (!Array.isArray(history.bars) || history.bars.length < 21) return fail('short_history', '20本の騰落率に必要な21終値が不足しています。');
  const bars = history.bars.slice(-21);
  let previous = '';
  for (const bar of bars) {
    const date = bar?.sessionDate;
    const at = Date.parse(`${date}T00:00:00Z`);
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(at) || new Date(at).toISOString().slice(0,10) !== date || date <= previous || !number(bar.close) || bar.close <= 0 || bar.priceMode !== 'adjusted') return fail('invalid_bars', '比較窓に日付順序の異常、重複、欠測または調整条件の混在があります。');
    if (previous && at - Date.parse(previous+'T00:00:00Z') > 7*DAY) return fail('gapped_history', '比較窓に7暦日超の空白があり、同じ期間として比較できません。');
    if (bar.timestamp != null && (!number(bar.timestamp) || bar.timestamp <= 0 || Math.abs(bar.timestamp*1000)>8.64e15 || bar.timestamp*1000 > nowMs || new Date(bar.timestamp*1000).toISOString().slice(0,10) !== date)) return fail('invalid_timestamp', '取引足の時刻が不正または未来です。');
    previous = date;
  }
  const end = bars.at(-1).sessionDate;
  // Conservative US daily close boundary, including winter time. This does not
  // substitute for a trading calendar or a provider's completion flag.
  const closeBoundary = Date.parse(end+'T21:00:00Z');
  if (nowMs < closeBoundary || nowMs - closeBoundary > 4*DAY) return fail('endpoint_not_current', '直近終値の確定時刻・4暦日以内の鮮度条件を満たしません。');
  const daily = result.indicators?.daily || result.technical?.daily;
  if (!daily || daily.status !== 'ok' || daily.asOf !== end || result.asOf !== end || !number(daily.price) || Math.abs(daily.price-bars.at(-1).close) > .00011) return fail('indicator_mismatch', '日足指標と比較窓の基準日・終値が一致しません。');
  if (!number(daily.rsi14) || daily.rsi14 < 0 || daily.rsi14 > 100 || !number(daily.macd?.histogram)) return fail('missing_indicators', 'RSIまたはMACDが未取得・不正です。');
  let retrievedAt = null;
  if (history.retrievedAt != null) {
    const timestamp = typeof history.retrievedAt === 'string' ? Date.parse(history.retrievedAt) : NaN;
    if (typeof history.retrievedAt !== 'string' || !Number.isFinite(timestamp) || timestamp > nowMs) return fail('invalid_retrieval_time', '取得時刻が不正または未来です。');
    retrievedAt = new Date(timestamp).toISOString();
  }
  const returns = bars.slice(1).map((bar,i)=>bar.close/bars[i].close-1);
  const return20Pct = 100*(bars.at(-1).close/bars[0].close-1);
  const macdHistogramPct = 100*daily.macd.histogram/daily.price;
  if (returns.some(value=>!Number.isFinite(value)) || !Number.isFinite(return20Pct) || !Number.isFinite(macdHistogramPct)) return fail('numeric_overflow', '価格比の計算結果が不正なため比較を停止しました。');
  return { symbol: symbolOf(result.symbol || result.ticker), dates: bars.map(bar=>bar.sessionDate),
    asOf:end, start:bars[0].sessionDate, return20Pct, returns,
    rsi14:daily.rsi14, macdHistogramPct,
    macdState:daily.macd.histogram>0?'positive':daily.macd.histogram<0?'negative':'zero',
    source:history.source, retrievedAt };
}
function correlation(left,right) {
  const mean = values=>values.reduce((a,b)=>a+b,0)/values.length;
  const a=mean(left),b=mean(right);
  let aa=0,bb=0,ab=0;
  left.forEach((v,i)=>{const x=v-a,y=right[i]-b;aa+=x*x;bb+=y*y;ab+=x*y;});
  if (aa < 1e-24 || bb < 1e-24 || !Number.isFinite(aa*bb) || !Number.isFinite(ab)) return null;
  return Math.max(-1,Math.min(1,ab/Math.sqrt(aa*bb)));
}

/** Pure, display-only. groups: [{id,label,symbols:[ticker,...]}]. Returns a Map.
 * No automatic peer discovery, network request, imputation, score, or forecast.
 */
function buildPeerComparisons({results=[],histories=new Map(),groups=[],nowMs=Date.now()}={}) {
  const now = number(nowMs) && Math.abs(nowMs)<=8.64e15 ? nowMs : Date.now();
  const rows = new Map((Array.isArray(results)?results:[]).filter(Boolean).map(row=>[symbolOf(row.symbol||row.ticker),row]));
  rows.delete('');
  const catalog = (Array.isArray(groups)?groups:[]).filter(g=>g && typeof g.id==='string' && g.id && typeof g.label==='string' && Array.isArray(g.symbols)).map(g=>({id:g.id,label:g.label,symbols:[...new Set(g.symbols.map(symbolOf).filter(Boolean))]}));
  const checked = new Map([...rows].map(([symbol,row])=>[symbol,inspect(row,histories instanceof Map?histories.get(symbol):null,now)]));
  const output = new Map();
  for (const [symbol] of rows) {
    const own=checked.get(symbol),matchingGroups=catalog.filter(g=>g.symbols.includes(symbol));
    const targetSymbols=[...new Set(matchingGroups.flatMap(g=>g.symbols))].filter(s=>s!==symbol).sort();
    const base={symbol,status:'unavailable',methodVersion:METHOD,asOf:null,period:null,evaluatedAt:new Date(now).toISOString(),groups:matchingGroups.map(({id,label})=>({id,label})),scope:{catalogSymbols:targetSymbols,requestedSymbols:[...rows.keys()].sort(),alignedPeers:0},self:null,peers:[],excluded:[],peerMedianReturn20Pct:null,relativeReturn20Pp:null,reason:null,limitations:[...LIMITATIONS],analysisOnly:true,tradeEligible:false};
    if (own.code) { output.set(symbol,{...base,reason:own.reason,reasonCode:own.code});continue; }
    if (!matchingGroups.length) { output.set(symbol,{...base,reason:'明示された比較グループがありません。事業の類似性を推測して補いません。',reasonCode:'no_explicit_group'});continue; }
    const peers=[],excluded=[];
    for (const other of targetSymbols) {
      const item=checked.get(other);
      if (!item || item.code) { excluded.push({symbol:other,reasonCode:item?.code||'not_requested',reason:item?.reason||'今回の取得対象に含まれていません。'});continue; }
      if (own.dates.some((date,i)=>date!==item.dates[i])) { excluded.push({symbol:other,reasonCode:'unaligned_dates',reason:'21終値の日付が完全一致しないため比較から除外しました。'});continue; }
      const r=correlation(own.returns,item.returns);
      peers.push({symbol:other,return20Pct:item.return20Pct,rsi14:item.rsi14,macdHistogramPct:item.macdHistogramPct,macdState:item.macdState,correlation20:r,correlationStatus:r==null?'zero_variance':'ok',source:item.source,retrievedAt:item.retrievedAt,groups:matchingGroups.filter(g=>g.symbols.includes(other)).map(g=>g.id)});
    }
    const selected=peers.length>=2;
    const peerMedian=selected?median(peers.map(p=>p.return20Pct)):null;
    output.set(symbol,{...base,status:selected?'ok':peers.length?'partial':'unavailable',asOf:own.asOf,period:{start:own.start,end:own.asOf,closes:21,returns:20,interval:'1d',priceMode:'adjusted',currency:'USD'},scope:{...base.scope,alignedPeers:peers.length},self:{return20Pct:own.return20Pct,rsi14:own.rsi14,macdHistogramPct:own.macdHistogramPct,macdState:own.macdState,source:own.source,retrievedAt:own.retrievedAt},peers,excluded,peerMedianReturn20Pct:peerMedian,relativeReturn20Pp:selected?own.return20Pct-peerMedian:null,reason:selected?'同じ21終値で比較できた対象の中央値との差です。将来の優劣ではありません。':peers.length?'比較対象は1銘柄のみ。個別値を示し、グループ中央値と相対評価は表示しません。':'同じ日付・調整条件で比較できる銘柄がありません。',reasonCode:selected?null:'insufficient_peers'});
  }
  return output;
}
module.exports={buildPeerComparisons,PEER_COMPARISON_METHOD_VERSION:METHOD};
