'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const block=(start,end)=>{const a=html.indexOf('function '+start+'('),b=html.indexOf('function '+end+'(',a+1);assert.ok(a>=0&&b>a);return html.slice(a,b)};
const now=Date.parse('2026-11-07T12:00:00Z');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const period=(extra={})=>({status:'ok',available:true,asOf:'2026-11-06',price:110,rsi14:60,macd:{histogram:0.2,line:1,signal:0.8},ema20:105,ema50:100,ema200:90,rvol20:1.25,bars:250,...extra});
const result=(extra={})=>({symbol:'DEMO',status:'ready',stale:false,technicalPeriods:{daily:period(),weekly:period({asOf:'2026-10-30',completedOnly:true})},supportCandidates:[{type:'recent20Low',value:95}],quality:{source:'synthetic-fixture'},qualityAdjusted:true,...extra});
function context(){
  const ctx={Date:class extends Date{static now(){return now}},esc,normalizeTicker:value=>String(value||'').trim().toUpperCase(),safeText:(value,max=1000)=>String(value??'').slice(0,max),TICKER_RE:/^[A-Z0-9^][A-Z0-9.^=\/-]{0,19}$/,S:{positions:[{id:'fixture-a',ticker:'DEMO',shares:1,price:110,avgCost:100,currency:'USD',priceSource:'fixture',freshness:'previous-close-valid',priceAt:'2026-11-06T21:00:00Z',syncedAt:'2026-11-07T11:59:00Z'}]},BuySignals:{initialized:true,loading:false,status:'ready',results:[result()],inputRevision:'fixture',error:''},buySignalInputRevision:()=> 'fixture',buySignalRequestPayload:()=>({symbols:['DEMO']}),fmtAt:value=>value||'未取得',hAgo:value=>Number.isFinite(Date.parse(value))?(now-Date.parse(value))/36e5:Infinity,agoTxt:value=>value+'h'};
  vm.runInNewContext(block('technicalTimestamp','normalizeBuySignalIndicator')+block('buyTechnicalPeriod','normalizeBuySignalResult')+block('holdingsTechnicalFrame','buySignalIndicatorHtml')+block('xrayQuoteQuality','portfolioXrayMetrics'),ctx);
  return ctx;
}
test('holdings uses real daily and weekly evidence with explicit periods, dates and units',()=>{
  const c=context(),out=c.holdingsTechnicalCard(result(),'fixture-a');
  for(const text of ['日足','週足','完成週のみ','2026-11-06','2026-10-30','RSI（14・日足）','60.0','0.2000','1.25倍','EMA20','EMA50','EMA200','$105.00','$100.00','$90.00','直前20本の平均比','直近20本の安値 $95.00','抵抗帯：</b>未取得','出来高の実数：</b>未取得','synthetic-fixture'])assert.ok(out.includes(text),text);
  assert.match(out,/日足も週足も、上向きです/);assert.doesNotMatch(out,/強い買い|強い売り/);assert.doesNotMatch(out,/勝率|目標価格|TRADE GATE|take1|take2/);
  assert.match(out,/<details[^>]+data-holdings-details="technical-fixture-a"/);
  assert.doesNotMatch(out,/<details[^>]+\sopen(?:\s|>)/);
});
test('stale, errored, missing and invalid timestamp evidence never presents directional or numeric confidence',()=>{
  const c=context();
  for(const r of [null,result({stale:true}),result({status:'unavailable'}),result({technicalStatus:'error'}),result({indicatorsStatus:'stale'}),result({qualityAdjusted:false}),result({qualityAdjusted:undefined}),result({technicalPeriods:{daily:period({asOf:'2026-10-01'}),weekly:period({asOf:'2026-10-01'})}}),result({technicalPeriods:{daily:period({asOf:'2026-02-30'}),weekly:period({asOf:'2026-02-30'})}})]){
    const out=c.holdingsTechnicalCard(r,'fixture');assert.match(out,/未取得/);assert.doesNotMatch(out,/>強い買い<|>強い売り<|\$105.00|1.25倍|0.2000|60.0/);
  }
});
test('partial individual indicators remain explicit while aggregate remains unavailable',()=>{
  const c=context(),r=result({technicalPeriods:{daily:period({status:'partial',available:false,rsi14:null,ema200:null,rvol20:null}),weekly:period({status:'partial',available:false,macd:{histogram:null}})}}),out=c.holdingsTechnicalCard(r,'fixture');
  assert.equal(c.holdingsTechnicalFrame(r,'daily').verdict.tone,'unavailable');
  assert.match(out,/\$105.00/);assert.match(out,/取得済みの指標のみ/);assert.doesNotMatch(out.split('<details')[0],/>強い買い<|1.25倍|\$90.00/);
  const malformed=result({technicalPeriods:{daily:period({rsi14:NaN,macd:{histogram:Infinity},ema20:'105',ema50:0,ema200:-1,rvol20:-4})}});
  const invalid=c.holdingsTechnicalCard(malformed,'fixture');assert.doesNotMatch(invalid,/NaN|Infinity|\$105.00|\$0.00|-4.00倍/);
  const zero=c.holdingsTechnicalCard(result({technicalPeriods:{daily:period({rsi14:0,macd:{histogram:0},rvol20:0})}}),'fixture');assert.match(zero,/0.0000/);assert.match(zero,/0.00倍/);
});
test('raw extra evidence is preserved without synthesis or coercion and supports are allowlisted',()=>{
  const c=context(),p=period({rvol20:null}),before=JSON.stringify(p),normalized=c.buyTechnicalPeriod(p);
  assert.equal(normalized.ema200,90);assert.equal(normalized.rvol20,undefined);assert.equal(normalized.macd.line,1);assert.equal(JSON.stringify(p),before);
  assert.deepEqual(JSON.parse(JSON.stringify(c.holdingsSupportCandidates([{type:'recent20Low',value:95},{type:'arbitrary',value:10},{type:'ema20',value:'100'},{type:'pivotS1',value:NaN},{type:'ema50',value:-2}]))),[{type:'recent20Low',value:95}]);
  const out=c.holdingsTechnicalCard(result({symbol:'<bad>',quality:{source:'<script>bad()</script>'}}),'"bad');assert.match(out,/&lt;script&gt;/);assert.doesNotMatch(out,/<script>|aria-label="<bad>/);
});
test('overview counts unique held symbols only, never holdings weight or overall buy advice',()=>{
  const c=context();c.S.positions.push({...c.S.positions[0],id:'duplicate'}, {ticker:'OTHER',shares:1});c.BuySignals.results.push(result({symbol:'WATCH-ONLY'}));
  const out=c.holdingsTechnicalOverview(true);assert.match(out,/上向き 1/);assert.match(out,/判断できない 1/);assert.match(out,/日足 1\/2銘柄/);assert.match(out,/最大20銘柄/);assert.match(out,/onclick="fetchBuySignals\(true\)"/);
  assert.equal(c.holdingsTechnicalResult('DEMO',false),null);c.BuySignals.loading=true;assert.equal(c.holdingsTechnicalResult('DEMO',true),null);assert.match(c.holdingsTechnicalOverview(true),/分析中/);
  c.BuySignals.loading=false;c.BuySignals.status='unavailable';c.BuySignals.error='fixture error';assert.equal(c.holdingsTechnicalResult('DEMO',true),null);assert.match(c.holdingsTechnicalOverview(true),/fixture error/);
  c.S.positions=[];assert.match(c.holdingsTechnicalOverview(true),/保有を追加/);
});
test('price observation and retrieval differ; a fresh retrieval never promotes previous close to live',()=>{
  const c=context(),out=c.holdingsQuoteMeta(c.S.positions[0]);
  assert.match(out,/終値・参考値/);assert.match(out,/価格観測 2026-11-06T21:00:00Z \/ 取得 2026-11-07T11:59:00Z/);assert.doesNotMatch(out,/LIVE/);
  const old=c.holdingsQuoteMeta({...c.S.positions[0],priceAt:'2026-10-01T21:00:00Z'});assert.match(old,/古い値（要同期）/);
  assert.match(html,/#tickerwrap\{background:#20131e;isolation:isolate\}/);assert.match(block('renderHUD','hasActiveHoldings'),/取得<br>/);
});
test('real holdings renderer places evidence before collapsed risk while preserving controls and warnings',()=>{
  const c=context(),root={innerHTML:'',querySelectorAll:()=>[]};
  Object.assign(c,{$:()=>root,calc:()=>({issues:[{sev:'crit',msg:'DEMO STOP要確認'},{sev:'warn',msg:'fixture warning'}],fx:150}),monMigrate:()=>{},monCalc:()=>({line:'fixture',stage:0}),monSVG:()=>'',spark:()=>'',fmtUsd:value=>'$'+value,fmtJpy:value=>'JPY'+value,pct:value=>value+'%',marketRegimeAnalysisIsOld:()=>false,positionSummaryHtml:()=>'<div>集計fixture</div>',riskPanel:()=>'<div id="risk-engine">risk fixture</div>',portfolioXrayPanel:()=>'<div id="portfolio-xray">xray fixture</div>',portfolioXrayMetrics:()=>({}),xrayGuidance:()=> 'guidance fixture',ranchPanel:()=>'<div>ranch fixture</div>',evoFlush:()=>{}});
  vm.runInNewContext(block('renderPos','stressScenarioSnapshot'),c);c.renderPos();const out=root.innerHTML;
  assert.ok(out.indexOf('保有株、今どう見る？')<out.indexOf('class="pos '));assert.ok(out.indexOf('holdings-tech')<out.indexOf('id="risk-engine"'));assert.ok(out.indexOf('DEMO STOP要確認')<out.indexOf('data-holdings-details="risk"'));
  assert.match(out,/<details[^>]+data-holdings-details="risk"/);assert.doesNotMatch(out,/<details[^>]+\sopen(?:\s|>)/);
  for(const text of ['前日比','取得来損益','openPos(\'fixture-a\')','openTradeGate()','openStressLab()','setCash(\'jpy\'','setCash(\'usd\''])assert.ok(out.includes(text),text);
  assert.doesNotMatch(block('renderPos','stressScenarioSnapshot'),/rsi14\(\(S.spark/);
  assert.doesNotMatch(block('switchTab','renderAll'),/t==='pos'.*fetchBuySignals|t==='pos'.*buySignalsInit/);
});
test('technical refresh changes only technical slots and preserves disclosure state',()=>{
  const c=context(),openNode={dataset:{holdingsDetails:'technical-fixture-a'},open:true},closedNode={dataset:{holdingsDetails:'risk'},open:false},slot={dataset:{holdingsSymbol:'DEMO',holdingsKey:'fixture-a'},innerHTML:''},overview={innerHTML:'',setAttribute:(key,value)=>{overview[key]=value}},root={querySelector:()=>overview,querySelectorAll:selector=>selector==='[data-holdings-details][open]'?[openNode]:selector==='[data-holdings-symbol]'?[slot]:selector==='[data-holdings-details]'?[openNode,closedNode]:[]};
  Object.assign(c,{$:()=>root,document:{activeElement:null}});c.refreshHoldingsTechnicalView();assert.match(slot.innerHTML,/日足も週足も、上向きです/);assert.equal(openNode.open,true);assert.equal(closedNode.open,false);assert.equal(overview['aria-busy'],'false');
  c.BuySignals.loading=true;c.refreshHoldingsTechnicalView();assert.doesNotMatch(slot.innerHTML,/>上向き</);assert.equal(overview['aria-busy'],'true');
});

test('weekly evidence requires explicitly completed weeks and raw prices are suppressed',()=>{
  const c=context();
  for(const completedOnly of [undefined,false,'true']){
    const r=result({technicalPeriods:{daily:period(),weekly:period({completedOnly})}}),frame=c.holdingsTechnicalFrame(r,'weekly');
    assert.equal(frame.verdict.tone,'unavailable');assert.equal(frame.evidenceReady,false);assert.match(frame.verdict.reason,/完成週/);assert.equal(c.holdingsTechnicalFrame(r,'daily').verdict.tone,'buy');
  }
  const frame=c.holdingsTechnicalFrame(result({qualityAdjusted:false}),'daily');assert.equal(frame.evidenceReady,false);assert.equal(frame.verdict.tone,'unavailable');assert.match(frame.verdict.reason,/調整済み/);
});
function historicalFixture(){
  const day=offset=>new Date(Date.parse('2024-01-01T00:00:00Z')+offset*864e5).toISOString().slice(0,10);
  const samples=Array.from({length:8},(_,i)=>({startDate:day(i*60),signalDate:day(i*60+19),endDate:day(i*60+39),horizonEndDates:{5:day(i*60+24),10:day(i*60+29),20:day(i*60+39)},returnsPct:{5:i+.5,10:i+1,20:i+2}}));
  return{status:'ok',symbol:'DEMO',methodVersion:'same-symbol-daily-state-v1',asOf:'2026-11-06',source:'synthetic-fixture',inputId:'sha256:'+'a'.repeat(64),period:{start:day(0),end:'2026-11-06',bars:720},currentState:{comparisonStartDate:'2026-10-10',asOf:'2026-11-06'},sample:{evaluatedCount:500,candidateCount:40,selectedCount:8,overlapExcludedCount:32,minimum:8},samples,horizons:Object.fromEntries([5,10,20].map(k=>[k,{bars:k,sampleCount:8,medianPct:3.5+k/10,p25Pct:1.75+k/10,p75Pct:5.25+k/10}])),quality:{priceMode:'adjusted'},analysisOnly:true,tradeEligible:false};
}
test('historical comparison shows only validated observed distributions and disclosure boundaries',()=>{
  const c=context(),raw=historicalFixture(),before=JSON.stringify(raw),h=c.holdingsHistoricalAnalogs(raw,'DEMO');assert.equal(h.status,'ok');assert.equal(JSON.stringify(raw),before);
  const out=c.holdingsHistoricalHtml(result({historicalAnalogs:h}),'fixture');
  for(const text of ['5取引足本後の中央値','10取引足本後の中央値','20取引足本後の中央値','+4.00%','+2.25%','+5.75%','8件採用 / 40候補','重複除外 32件','採用した基準日','same-symbol-daily-state-v1','予測区間・信頼区間ではありません','独立標本ではありません','取引所カレンダー未照合','長期シナリオは未対応','業績推移・希薄化・評価倍率'])assert.ok(out.includes(text),text);
  assert.match(out,/data-holdings-details="history-fixture"/);assert.doesNotMatch(out,/<details[^>]+\sopen(?:\s|>)/);
});
test('historical comparison rejects unknown methods, bad counts, dates, overlaps and invalid summaries',()=>{
  const c=context();
  const changes=[h=>h.status='unknown',h=>h.symbol='OTHER',h=>h.methodVersion='new-unverified',h=>h.sample.selectedCount=9,h=>h.sample.candidateCount=41,h=>h.sample.minimum=7,h=>h.samples.pop(),h=>h.samples[0].startDate='2024-02-30',h=>h.samples[1].startDate=h.samples[0].endDate,h=>h.currentState.comparisonStartDate=h.samples.at(-1).endDate,h=>h.period.end='2026-11-05',h=>h.inputId='hash-unknown',h=>h.quality.priceMode='raw',h=>h.analysisOnly=false,h=>h.horizons[5]=null,h=>h.horizons[5].bars=10,h=>h.horizons[5].sampleCount=7,h=>h.horizons[5].medianPct=Infinity,h=>h.horizons[5].medianPct='4',h=>h.horizons[5].p25Pct=7,h=>h.horizons[5].medianPct=4.1,h=>h.samples[0].returnsPct[5]=NaN,h=>h.samples[0].horizonEndDates[10]=h.samples[0].signalDate];
  for(const change of changes){const raw=historicalFixture();change(raw);const h=c.holdingsHistoricalAnalogs(raw,'DEMO');assert.equal(h.status,'unavailable',String(change));assert.equal(h.horizons,null);assert.doesNotMatch(c.holdingsHistoricalHtml(result({historicalAnalogs:h}),'fixture'),/取引足本後の中央値|\+4.00%/)}
});
test('insufficient samples and stale or mismatched current evidence never show historical returns',()=>{
  const c=context(),raw=historicalFixture();raw.status='insufficient';raw.sample.selectedCount=7;raw.sample.candidateCount=39;raw.samples.pop();raw.samples.forEach(row=>row.returnsPct=null);raw.horizons={5:null,10:null,20:null};raw.reason='標本不足';
  const h=c.holdingsHistoricalAnalogs(raw,'DEMO');assert.equal(h.status,'insufficient');const out=c.holdingsHistoricalHtml(result({historicalAnalogs:h}),'fixture');assert.match(out,/7件採用/);assert.match(out,/標本不足/);assert.doesNotMatch(out,/取引足本後の中央値|\+4.00%/);
  raw.horizons[5]={bars:5,sampleCount:7,medianPct:1,p25Pct:0,p75Pct:2};assert.equal(c.holdingsHistoricalAnalogs(raw,'DEMO').status,'unavailable');
  const good=c.holdingsHistoricalAnalogs(historicalFixture(),'DEMO');
  for(const r of [result({stale:true,historicalAnalogs:good}),result({qualityAdjusted:false,historicalAnalogs:good}),result({historicalAnalogs:{...good,asOf:'2026-11-05'}})])assert.doesNotMatch(c.holdingsHistoricalHtml(r,'fixture'),/取引足本後の中央値|\+4.00%/);
});
test('foreign currency holdings do not label local indicator prices as USD',()=>{
  const c=context();c.S.positions[0].currency='JPY';assert.equal(c.holdingsTechnicalResult('DEMO',true),null);
});
test('actual synthetic backend result survives normalization and renders historical evidence',()=>{
  const {buildBuySignalResult}=require('../technical-signals');
  const dates=[],day=new Date('2026-11-06T21:00:00Z');while(dates.length<1250){if(![0,6].includes(day.getUTCDay()))dates.push(new Date(day));day.setUTCDate(day.getUTCDate()-1)}dates.reverse();
  let close=100;const bars=dates.map((date,i)=>{close*=Math.exp(.0001+(i%137)*.000004);return{timestamp:date.getTime()/1000,sessionDate:date.toISOString().slice(0,10),open:close*.999,high:close*1.01,low:close*.99,close,volume:100000,priceMode:'adjusted'}});
  const history={bars,source:'synthetic-software-test-only',interval:'1d',priceMode:'adjusted',status:'ok',partial:false,ohlcCoveragePct:100},raw=buildBuySignalResult({symbol:'DEMO',nowMs:now,history});
  const c=context();c.buySignalTimestampFresh=()=>true;
  const definitions=html.slice(html.indexOf('const BUY_SIGNAL_DEFINITIONS='),html.indexOf('const BuySignals='));
  const formatters=html.slice(html.indexOf('function buySignalValueText('),html.indexOf('// Display-only consensus.'));
  vm.runInNewContext(definitions+formatters+block('normalizeBuySignalIndicator','buyTechnicalPeriod')+block('normalizeBuySignalResult','buySignalStatusLabel'),c);
  const normalized=c.normalizeBuySignalResult(raw);assert.equal(normalized.historicalAnalogs.status,'ok');assert.equal(normalized.historicalAnalogs.sample.selectedCount,26);
  const out=c.holdingsHistoricalHtml(normalized,'fixture');assert.match(out,/5取引足本後の中央値/);assert.match(out,/26件採用/);assert.match(out,/2026-11-06/);
});

test('first glance states a plain conclusion, one reason and a caution before any raw indicator grid',()=>{
  const c=context(),out=c.holdingsTechnicalCard(result(),'fixture'),first=out.split('<details')[0];
  for(const text of ['今の値動き','売買推奨ではありません','日足も週足も、上向きです','理由','株価は20日平均より上','注意','決算・最新ニュースは未評価','見直す条件','株価が20日平均を下回る','長期（数か月〜年）は判断できません','業績推移・希薄化・評価倍率'])assert.ok(first.includes(text),text);
  assert.doesNotMatch(first,/holdings-indicators|holdings-frame-row|強い買い|強い売り|目標価格|勝率|成功率|買い増し|売却推奨/);
  assert.ok(first.indexOf('<h3>')<first.indexOf('理由'));assert.ok(first.indexOf('理由')<first.indexOf('注意'));
});
test('opposing daily and weekly directions and neutral mixtures are described without a trade decision',()=>{
  const c=context(),down=period({price:80,ema20:90,ema50:100,rsi14:40,macd:{histogram:-1},completedOnly:true});
  const mixed=c.holdingsTechnicalCard(result({technicalPeriods:{daily:period(),weekly:down}}),'fixture').split('<details')[0];
  assert.match(mixed,/日足は上向き。週足は下向き/);assert.match(mixed,/日足と方向がそろっていません/);assert.doesNotMatch(mixed,/売り|買い|反発する|上昇する/);
  const lower=c.holdingsTechnicalCard(result({technicalPeriods:{daily:down,weekly:down}}),'fixture').split('<details')[0];
  assert.match(lower,/日足も週足も、下向きです/);assert.match(lower,/株価は20日平均より下/);assert.match(lower,/株価が20日平均を上回る/);
  const neutral=c.holdingsTechnicalCard(result({technicalPeriods:{daily:period({rsi14:40}),weekly:period()}}),'fixture').split('<details')[0];
  assert.match(neutral,/日足の方向は、まだそろっていません/);assert.doesNotMatch(neutral,/日足も週足も、上向き/);
});
test('extreme RSI and quiet volume remain cautions, not reversal predictions',()=>{
  const c=context();
  for(const [rsi14,expected] of [[75,'過熱域'],[20,'売られすぎ']]){
    const out=c.holdingsTechnicalCard(result({technicalPeriods:{daily:period({rsi14,rvol20:.5}),weekly:period()}}),'fixture');
    assert.match(out,new RegExp(expected));assert.match(out,/出来高は直前20本の平均より少なめ/);assert.doesNotMatch(out,/反発する|下落する|買い時|売り時/);
  }
});
test('unavailable conclusion explains the actual blocker and never promotes partial data',()=>{
  const c=context(),first=r=>c.holdingsTechnicalCard(r,'fixture').split('<details')[0];
  assert.match(first(null),/分析データが未取得.*分析を更新/);
  assert.match(first(result({stale:true})),/保存された分析が古い/);
  assert.match(first(result({qualityAdjusted:false})),/調整済み価格を確認できない/);
  assert.match(first(result({technicalPeriods:{daily:period({rsi14:null}),weekly:period()}})),/勢い（RSI）が不足または不正/);
  assert.match(first(result({technicalPeriods:{daily:period({asOf:'2026-10-01'}),weekly:period()}})),/鮮度上限（4暦日）/);
  for(const r of [null,result({stale:true}),result({qualityAdjusted:false}),result({technicalPeriods:{daily:period({rsi14:null}),weekly:period()}})])assert.doesNotMatch(first(r),/日足も週足も、上向き|\$105.00|中央値は/);
  c.BuySignals.loading=true;assert.match(first(null),/分析を更新中/);
  c.BuySignals.loading=false;c.BuySignals.error='synthetic network failure';assert.match(first(null),/取得に失敗.*synthetic network failure/);
  c.S.positions[0].currency='JPY';assert.match(c.holdingsTechnicalCard(null,'fixture-a'),/通貨には分析表示が未対応/);
});
test('visible short horizon uses only gated historical observations and names daily bars, not a forecast',()=>{
  const c=context(),good=c.holdingsHistoricalAnalogs(historicalFixture(),'DEMO');
  const out=c.holdingsShortHorizon(result({historicalAnalogs:good}));
  assert.match(out,/同じ銘柄で条件が似た過去8件/);assert.match(out,/日足20本後（おおむね数週間）/);assert.match(out,/中央値は\+5.50%/);assert.match(out,/今後の予想や予測範囲ではありません/);assert.doesNotMatch(out,/20営業日|目標|勝率|上昇確率/);
  for(const r of [result({stale:true,historicalAnalogs:good}),result({qualityAdjusted:false,historicalAnalogs:good}),result({historicalAnalogs:{...good,asOf:'2026-11-05'}})])assert.doesNotMatch(c.holdingsShortHorizon(r),/中央値|\+5.50%/);
  const small={...good,status:'insufficient',sample:{...good.sample,selectedCount:7},horizons:null};assert.match(c.holdingsShortHorizon(result({historicalAnalogs:small})),/7件。8件未満/);assert.doesNotMatch(c.holdingsShortHorizon(result({historicalAnalogs:small})),/中央値/);
  const rejected=c.holdingsHistoricalAnalogs({...historicalFixture(),methodVersion:'unsupported'},'DEMO');assert.doesNotMatch(c.holdingsShortHorizon(result({historicalAnalogs:rejected})),/中央値/);
  for(const patch of [{medianPct:NaN},{medianPct:'5.5'},{p25Pct:99},{sampleCount:7},{bars:5}]){
    const malformed={...good,horizons:{...good.horizons,20:{...good.horizons[20],...patch}}};
    assert.doesNotMatch(c.holdingsShortHorizon(result({historicalAnalogs:malformed})),/中央値|NaN|Infinity/);
  }
});
test('risk detail explains retrospective loss, dispersion and beta without interpreting them as forecasts',()=>{
  const c=context();Object.assign(c,{fmtJpy:value=>'JPY'+value,portfolioRiskSnapshot:()=>({hasPositions:true,sufficient:true,coverageOk:true,decisionReady:true,sampleCount:40,tailCount:2,mode:'jpy',varPct:2,expectedShortfallPct:3,annualVolPct:25,beta:1.2,varJpy:200,expectedShortfallJpy:300,coveragePct:100,reason:[]})});
  vm.runInNewContext(block('riskEnginePanel','riskPanel'),c);const out=c.riskEnginePanel();
  for(const text of ['保有全体の過去の値動き','現在の保有を過去の価格に当てはめる','今後の損失予測ではありません','最大損失ではありません','1年後の損失率ではありません','次の値動きの倍率ではありません','95%は過去分布を区切る計算条件で、安全性の点数ではありません','日付対応は未確認'])assert.ok(out.includes(text),text);
  c.portfolioRiskSnapshot=()=>({hasPositions:true,sufficient:false,decisionReady:false,reason:['価格未取得のため停止']});assert.match(c.riskEnginePanel(),/保有全体のリスクは判断できません。価格未取得のため停止/);
});

test('neutral first-glance caution prioritizes the observed daily conflict over the weekly difference',()=>{
  const c=context(),first=p=>c.holdingsTechnicalCard(result({technicalPeriods:{daily:p,weekly:period({completedOnly:true})}}),'fixture').split('<details')[0];
  const caution=out=>out.match(/<div class="caution"><dt>注意<\/dt><dd>(.*?)<\/dd>/)?.[1];
  const mixed=first(period({rsi14:75,macd:{histogram:-.2}}));
  assert.match(mixed,/日足の方向は、まだそろっていません/);assert.match(mixed,/株価は20日平均より上/);
  assert.equal(caution(mixed),'勢いの変化は下向き側です（MACD）。');assert.doesNotMatch(caution(mixed),/週足/);
  const rsiOpposes=first(period({rsi14:40}));assert.match(caution(rsiOpposes),/最近の下げが上げより優勢.*RSI/);
  const noTrend=first(period({price:103,rsi14:60,macd:{histogram:-.2}}));assert.match(noTrend,/最近の上げが下げより優勢/);assert.match(caution(noTrend),/勢いの変化は下向き側.*MACD/);
  const incomplete=first(period({rsi14:75,macd:{histogram:null}}));assert.match(incomplete,/方向を判断できません/);assert.doesNotMatch(caution(incomplete),/MACD.*下向き|勢いの変化は下向き/);
});

test('one holding keeps the overview to refresh and data status without redundant counts or explanation',()=>{
  const c=context(),out=c.holdingsTechnicalOverview(true);
  assert.match(out,/保有株、今どう見る？/);assert.match(out,/分析を更新/);assert.match(out,/日足 1\/1銘柄/);assert.match(out,/表示の範囲・更新について/);
  assert.doesNotMatch(out,/holdings-counts|銘柄ごとに、今の方向・理由・見直す条件を確認/);
  c.S.positions.push({...c.S.positions[0],id:'duplicate'});assert.doesNotMatch(c.holdingsTechnicalOverview(true),/holdings-counts/);
  c.S.positions.push({id:'other',ticker:'OTHER',shares:1});assert.match(c.holdingsTechnicalOverview(true),/holdings-counts/);
});

test('price map shows measured prior-window anchors, not orders or fabricated targets',()=>{
 const c=context(),r=result({technicalPeriods:{daily:period({priorHigh20:120,priorLow20:90}),weekly:period()}}),out=c.holdingsPriceMapHtml(r,'fixture');
 for(const text of ['直前20本の値幅の内側','$120.00','$90.00','9.09%','-18.18%','当日の足を除く','注文価格・利確や損切りの指定ではなく','手数料'])assert.ok(out.includes(text),text);
 assert.equal(c.holdingsPriceMapHtml({...r,stale:true},'fixture'),'');
 assert.equal(c.holdingsPriceMapHtml(result(),'fixture'),'');
 assert.equal(c.holdingsPriceMapHtml(result({technicalPeriods:{daily:period({priorHigh20:90,priorLow20:120}),weekly:period()}}),'fixture'),'');
 assert.match(c.holdingsPriceMapHtml(result({technicalPeriods:{daily:period({price:125,priorHigh20:120,priorLow20:90}),weekly:period()}}),'fixture'),/次の上値目標は.*決められません/);
});
test('long-term evidence keeps quarterly and TTM separate and refuses synthetic freshness',()=>{
 const c=context(),raw={status:'partial',provenance:{source:'finnhub',retrievedAt:'2026-11-07T10:00:00Z'},metrics:{revenueGrowthTtmYoy:12,revenueGrowthQuarterlyYoy:25,peTtm:-5,psTtm:'100'}};
 const e=c.holdingsFundamentalEvidence(raw),out=c.holdingsLongTermHtml(result({fundamentalEvidence:e}),'fixture');
 for(const text of ['長期の上値はまだ判断できません','この銘柄で成立したという評価ではありません','直近12か月売上の前年同期比','直近四半期売上の前年同期比','12.00%','25.00%','一次資料との照合前','会計基準は未確認','増資による希薄化'])assert.ok(out.includes(text),text);
 assert.doesNotMatch(out,/100.00倍/);
 for(const patch of [{stale:true},{provenance:{source:'other',retrievedAt:'2026-11-07T10:00:00Z'}},{provenance:{source:'finnhub',retrievedAt:'2026-11-01T10:00:00Z'}}])assert.equal(c.holdingsFundamentalEvidence({...raw,...patch}).status,'unavailable');
 assert.doesNotMatch(c.holdingsLongTermHtml(result({stale:true,fundamentalEvidence:e}),'fixture'),/12.00%/);
});
function peerFixture(){
 const row={return20Pct:5,rsi14:60,macdHistogramPct:.2,macdState:'positive',source:'synthetic-peer-fixture',retrievedAt:null};
 return{methodVersion:'explicit-group-aligned-daily-peers-v1',symbol:'DEMO',status:'ok',asOf:'2026-11-06',analysisOnly:true,tradeEligible:false,period:{start:'2026-10-09',end:'2026-11-06',closes:21,returns:20,interval:'1d',priceMode:'adjusted',currency:'USD'},self:{...row,return20Pct:8},peers:[{...row,symbol:'PEER1',correlation20:.8},{...row,symbol:'PEER2',correlation20:null}],peerMedianReturn20Pct:5,relativeReturn20Pp:3,groups:[{id:'example',label:'Example'}],excluded:[]};
}
test('peer display uses aligned measured differences and never treats correlation as a forecast',()=>{
 const c=context(),out=c.holdingsPeerHtml(result({peerComparison:peerFixture()}),'fixture');
 for(const text of ['3.00ポイント強い','PEER1','PEER2','連動性 0.80','連動性 未算出','同じ21終値','将来の優劣や売買推奨ではありません','企業価値の直接比較ではありません','最大20銘柄内','取得時刻：未確認'])assert.ok(out.includes(text),text);
 assert.doesNotMatch(out,/勝率|目標株価|全米株を/);
 for(const patch of [{asOf:'2026-11-05'},{methodVersion:'unknown'},{tradeEligible:true},{self:{...peerFixture().self,rsi14:NaN}},{self:{...peerFixture().self,macdState:'negative'}}])assert.doesNotMatch(c.holdingsPeerHtml(result({peerComparison:{...peerFixture(),...patch}}),'fixture'),/3.00ポイント|連動性 0.80/);
 assert.doesNotMatch(c.holdingsPeerHtml(result({stale:true,peerComparison:peerFixture()}),'fixture'),/3.00ポイント/);
 assert.doesNotMatch(c.holdingsPeerHtml(result({peerComparison:{...peerFixture(),peerMedianReturn20Pct:999}}),'fixture'),/3.00ポイント/);
 const h=peerFixture();h.groups[0].label='<img src=x onerror=alert(1)>';h.peers[0].source='<script>';
 assert.doesNotMatch(c.holdingsPeerHtml(result({peerComparison:h}),'fixture'),/<img|<script>/);
});
