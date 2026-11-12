import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { marketObservationView } from '../src/marketObservation.js';

const now=Date.parse('2026-11-10T02:00:00Z');
function fixture() {
  const instrument=(symbol,value,baseline,priceMode)=>({symbol,value,level:value,status:'ok',available:true,asOf:'2026-11-09',priceMode,changesPct:{'1d':Math.round((value/baseline-1)*100000)/1000},baselines:{'1d':{date:'2026-11-06',level:baseline,exactSession:true}}});
  return {status:'ok',asOf:'2026-11-09',updatedAt:'2026-11-10T01:55:00Z',observedAt:'2026-11-09T21:00:00Z',meta:{},availability:{synchronizedConfirmedSession:{available:true,current:true,asOf:'2026-11-09'}},indicators:{spy:instrument('SPY',605,600,'adjusted-close'),vix:instrument('^VIX',18,20,'native-index-close'),wti:instrument('CL=F',72,70,'native-futures-close')}};
}
const view=(data=fixture(),extra={})=>marketObservationView(data,{now,...extra});
const blocked=data=>{const result=view(data);assert.equal(result.eligible,false);assert.deepEqual(result.changes,[]);return result;};
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const shared=readFileSync(new URL('../src/marketObservation.js',import.meta.url),'utf8').replaceAll('export ','');

test('same confirmed date and preceding session yield observed changes, never causal flow claims',()=>{
  const result=view();assert.equal(result.eligible,true);assert.equal(result.asOf,'2026-11-09');assert.equal(result.baselineDate,'2026-11-06');assert.equal(result.retrievedText,'2026-11-10 01:55:00 UTC');
  assert.deepEqual(result.changes,['SPY +0.83%','VIX -10.00%（-2.00pt）','WTI +2.86%']);
  assert.match(result.headline,/SPY上昇とVIX低下/);assert.match(result.unconfirmed.join(' '),/未確認/);assert.match(result.unconfirmed.join(' '),/証明できない/);
  assert.match(result.scope,/好悪材料全体の評価ではありません/);assert.match(result.scope,/加点・減点しません/);assert.match(result.notes.join(' '),/最新値とは限りません/);
});

test('both confirmation endpoints must match across all three instruments',()=>{
  for(const key of ['spy','vix','wti']){
    const data=fixture();data.indicators[key].asOf='2026-11-06';blocked(data);
    const baseline=fixture();baseline.indicators[key].baselines['1d'].date='2026-11-05';blocked(baseline);
    const exact=fixture();exact.indicators[key].baselines['1d'].exactSession=false;blocked(exact);
  }
  for(const patch of [{available:false},{current:false},{asOf:'2026-11-06'},{}]){
    const data=fixture();data.availability.synchronizedConfirmedSession=patch;blocked(data);
  }
});

test('missing values, strings, booleans and non-finite numbers never create observations or fill from alternate fields',()=>{
  for(const key of ['spy','vix','wti'])for(const value of [null,undefined,'600','',false,true,NaN,Infinity,-Infinity]){
    const data=fixture();data.indicators[key].value=value;blocked(data);
    const change=fixture();change.indicators[key].changesPct['1d']=value;change.indicators[key].changes={'1d':0};blocked(change);
    const baseline=fixture();baseline.indicators[key].baselines['1d'].level=value;blocked(baseline);
  }
});

test('zero changes are real observations; invalid or nonpositive percentage baselines are not',()=>{
  const data=fixture();for(const row of Object.values(data.indicators)){row.value=row.baselines['1d'].level;row.changesPct['1d']=0;}
  assert.equal(view(data).eligible,true);assert.deepEqual(view(data).changes,['SPY 0.00%','VIX 0.00%（0.00pt）','WTI 0.00%']);
  data.indicators.wti.value=0;blocked(data);
  const negative=fixture();negative.indicators.wti.baselines['1d'].level=-37;blocked(negative);
});

test('API percent must match actual endpoint values and cannot stand in for VIX point changes',()=>{
  for(const key of ['spy','vix','wti']){const data=fixture();data.indicators[key].changesPct['1d']=5;blocked(data);}
  const data=fixture();data.indicators.vix.changesPoints={'1d':999};assert.match(view(data).changes[1],/-2.00pt/);assert.doesNotMatch(view(data).changes[1],/999/);
});

test('unadjusted, mixed, unconfirmed and wrongly identified instruments are not confirmed changes',()=>{
  for(const key of ['spy','vix','wti'])for(const [field,value] of [['priceMode','raw-close-reference'],['status','unavailable'],['available',false],['symbol','QQQ']]){const data=fixture();data.indicators[key][field]=value;blocked(data);}
  blocked({...fixture(),referenceOnly:true});blocked({...fixture(),regime:{referenceOnly:true}});
  blocked({...fixture(),status:'unavailable'});blocked({...fixture(),status:'ready'});
});

test('partial history may display independently verified one-day observations without implying completeness',()=>{
  const data=fixture();data.status='partial';data.partial=true;for(const row of Object.values(data.indicators))row.status='partial';
  const result=view(data);assert.equal(result.eligible,true);assert.equal(result.status,'partial');assert.match(result.notes.join(' '),/長期の欠測は補いません/);
});

test('stale snapshots and failed-refresh context suppress prior observation claims',()=>{
  for(const raw of [{...fixture(),status:'stale'},{...fixture(),meta:{stale:true}},{...fixture(),meta:{observationStale:true}},{...fixture(),updatedAt:'2026-11-08T01:00:00Z'}])assert.equal(blocked(raw).status,'stale');
  assert.equal(view(fixture(),{stale:true}).eligible,false);
  const row=fixture();row.indicators.spy.stale=true;assert.equal(blocked(row).status,'stale');
  const old=fixture();old.observedAt='2026-11-04T21:00:00Z';assert.equal(blocked(old).status,'stale');
});

test('malformed and future dates and acquisition times fail closed',()=>{
  for(const date of ['2026-02-30','2026-02-29','2026-13-01','2026-11-11','11/09/2026',null,'<script>'])blocked({...fixture(),asOf:date});
  for(const updatedAt of ['2026-11-10','2026-11-10T02:00:00','2026-11-10T02:60:00Z','2026-11-10T24:00:00Z','2026-11-10T02:00:00+99:00','2026-02-30T02:00:00Z','2026-11-10T02:10:00Z',null])blocked({...fixture(),updatedAt});
});

test('upside, stress and mixed observations use descriptive branches with no target or probability',()=>{
  const stress=fixture();stress.indicators.spy.value=594;stress.indicators.spy.changesPct['1d']=-1;stress.indicators.vix.value=22;stress.indicators.vix.changesPct['1d']=10;
  assert.match(view(stress).headline,/SPY下落とVIX上昇/);
  const mixed=fixture();mixed.indicators.vix.value=22;mixed.indicators.vix.changesPct['1d']=10;assert.match(view(mixed).headline,/VIX低下は同時に確認されていません/);
  const text=JSON.stringify(view());assert.doesNotMatch(text,/勝率\s*\d|目標株価\s*\d|機関投資家.*買っている|ショートカバー.*発生/);
  assert.match(view().continuation.join(' '),/次の同日確定終値/);assert.match(view().breakdown.join(' '),/見立てを再確認/);
});

test('missing snapshot still displays future checks, uncertainty and N/A without inferring from cached summary scores',()=>{
  const result=view(null);assert.equal(result.eligible,false);assert.equal(result.asOf,null);assert.equal(result.retrievedText,'N/A');assert.equal(result.changes.length,0);assert.equal(result.continuation.length,2);assert.match(result.headline,/保留/);
  blocked({riskScore:90,optimismScore:10,asOf:'2026-11-09',updatedAt:'2026-11-10T01:55:00Z'});
});

test('legacy mirrors exact validator and renders four named sections with escaped metadata',()=>{
  assert.ok(html.includes(shared));
  const renderer=html.slice(html.indexOf('function renderMarketObservationCard()'),html.indexOf('/* ---- End market observation card ---- */'));
  const data=fixture();data.asOf='<img onerror=alert(1)>';data.updatedAt='<script>';data.meta.source='<svg onload=alert(1)>';
  class FixtureDate extends Date{static now(){return now;}}
  const sandbox={Date:FixtureDate,MarketObservationPayload:data,MarketRegime:{loading:false},marketRegimeIsStale:()=>false,esc:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
  vm.createContext(sandbox);vm.runInContext(shared+'\n'+renderer,sandbox);const output=sandbox.renderMarketObservationCard();
  for(const title of ['確認できた変化','上昇継続の確認条件','崩れる条件','未確認の需給'])assert.ok(output.includes(title));
  assert.doesNotMatch(output,/<img|<script|<svg|onerror|onload/);assert.match(output,/現時点の成立宣言ではありません/);assert.match(output,/危険スコア・AI・発注には接続しません/);
});

test('new card only uses an already-successful market-regime response, creates no fetch or risk wiring',()=>{
  assert.match(html,/MarketObservationPayload=body;adoptMarketRegimePayload\(data,false\)/);
  assert.match(html,/\$\{renderTreasuryYieldPanel\(\)\}\s+\$\{renderMarketObservationCard\(\)\}/);
  assert.doesNotMatch(shared,/fetch\(|setInterval|localStorage|tradeEligible|riskScore\s*:/);
  const prompt=html.slice(html.indexOf('function marketRegimePromptContext()'),html.indexOf('function renderMarketRegimePanel()'));
  assert.doesNotMatch(prompt,/MarketObservationPayload|marketObservationView|renderMarketObservationCard/);
});

test('actual backend builder supplies the exact baseline contract consumed by the new card',()=>{
  const {buildMarketRegimePayload}=createRequire(import.meta.url)('../../market-data.js');
  const dates=[],cursor=new Date('2026-09-28T21:00:00Z');
  while(dates.length<30){if(![0,6].includes(cursor.getUTCDay()))dates.push(cursor.toISOString().slice(0,10));cursor.setUTCDate(cursor.getUTCDate()+1);}
  const histories=new Map([['SPY',i=>500+i],['^VIX',i=>20-i*.1],['CL=F',i=>70+i*.05]].map(([symbol,price])=>[symbol,{priceMode:'adjusted',points:dates.map((date,index)=>({sessionDate:date,at:date+'T21:00:00Z',timestamp:Date.parse(date+'T21:00:00Z')/1000,close:price(index),rawClose:price(index),priceMode:'adjusted'}))}]));
  const retrievedAt=dates.at(-1)+'T23:00:00Z';
  const payload=buildMarketRegimePayload(histories,retrievedAt);
  assert.equal(payload.status,'ok');
  const result=marketObservationView(payload,{now:Date.parse(retrievedAt)});
  assert.equal(result.eligible,true);assert.equal(result.asOf,dates.at(-1));assert.equal(result.baselineDate,dates.at(-2));assert.equal(result.changes.length,3);
  assert.match(result.headline,/SPY上昇とVIX低下/);
});

test('render preparation cannot mutate the existing scores, observations or flags',()=>{
  const data=fixture();data.regime={riskScore:42,optimismScore:58,tradeEligible:false};
  const before=JSON.stringify(data);view(data);assert.equal(JSON.stringify(data),before);
});
