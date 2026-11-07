import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { technicalConsensus, TECHNICAL_FRAMES } from '../src/technicalSummary.js';
const now = Date.parse('2026-11-07T12:00:00Z');
const period = { status: 'ok', available: true, asOf: '2026-11-06', rsi14: 60, macd: {histogram: 1}, price: 120, ema20: 110, ema50: 100 };
const run = (p = period, frame = 'daily', context = {}) => technicalConsensus(p, frame, context, now);
test('eight ordered frames never substitute daily evidence for unsupported periods', () => {
  assert.deepEqual(TECHNICAL_FRAMES.map(v => v[1]), ['5分','15分','30分','1時間','5時間足','日間','週単位','月単位']);
  for (const [frame] of TECHNICAL_FRAMES) if (!['daily','weekly'].includes(frame)) assert.equal(run(period, frame).label, '未取得');
});
test('strict three-family consensus shows buy, sell, neutral without trading decisions', () => {
  assert.equal(run().label, '強い買い');
  assert.equal(run({...period, rsi14: 50}).label, '買い');
  assert.equal(run({...period, rsi14: 40}).label, '中立');
  const sell = {...period, rsi14: 40, macd: {histogram:-1}, price:90};
  sell.ema20=100; sell.ema50=110;
  assert.equal(run(sell).label, '強い売り');
  assert.equal(run({...sell, rsi14:50}).label, '売り');
  assert.equal(run({...period, rsi14:0, macd:{histogram:0}, price:110}).label, '中立');
});
test('missing, malformed and non-finite indicators cannot create ratings', () => {
  for (const value of [null, undefined, NaN, Infinity, '60', true]) {
    assert.equal(run({...period,rsi14:value}).label,'未取得');
    assert.equal(run({...period,macd:{histogram:value}}).label,'未取得');
    assert.equal(run({...period,ema50:value}).label,'未取得');
  }
  for (const value of [-1,101]) assert.equal(run({...period,rsi14:value}).label,'未取得');
  assert.equal(run({...period,price:0}).label,'未取得');
});
test('status and per-frame timestamps fail closed including stale/future evidence', () => {
  for (const status of ['stale','unavailable','error','partial',undefined]) assert.equal(run({...period,status}).label,'未取得');
  for (const status of ['stale','unavailable','error']) assert.equal(run(period,'daily',{status}).label,'未取得');
  assert.equal(run(period,'daily',{stale:true}).label,'未取得');
  assert.equal(run({...period,available:false}).label,'未取得');
  for (const asOf of [null,undefined,'invalid','2026-11-10','2026-10-01']) assert.equal(run({...period,asOf}).label,'未取得');
  assert.equal(run({...period,asOf:'2026-10-28'},'daily').label,'未取得');
  assert.equal(run({...period,asOf:'2026-10-28'},'weekly').label,'強い買い');
  assert.equal(run({...period,asOf:'2026-10-20'},'weekly').label,'未取得');
});
test('legacy inline consensus stays identical to React and details retain raw indicators', () => {
  const html = readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const source = readFileSync(new URL('../src/technicalSummary.js',import.meta.url),'utf8').replaceAll('export ','');
  assert.ok(html.includes(source));
  const sandbox={}; vm.createContext(sandbox); vm.runInContext(source,sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.technicalConsensus(period,'daily',{},now))),run());
  assert.match(html,/\$\{technicalSummaryHtml\(result\)\}/);
  assert.match(html,/追加のテクニカル分析/);
});
test('conservative daily four-day and weekly fourteen-day freshness boundaries', () => {
  for (const [frame, days] of [['daily',4],['weekly',14]]) {
    const atBoundary = new Date(now-days*86400000).toISOString();
    const tooOld = new Date(now-days*86400000-1).toISOString();
    assert.equal(run({...period,asOf:atBoundary},frame).label,'強い買い');
    assert.equal(run({...period,asOf:tooOld},frame).label,'未取得');
  }
  assert.equal(run({...period,asOf:'2026-11-02'},'daily').label,'未取得');
});
test('date validation rejects overflow, ambiguous dates and invalid ISO times', () => {
  for (const asOf of ['2026-02-30','2026-02-29','2026-04-31','2026-13-01','2026-00-01','2026-11-00','11/06/2026','2026-11-6','2026-11-06T12:00:00','2026-11-06T24:00:00Z','2026-11-06T12:60:00Z','2026-11-06T12:00:60Z','2026-11-06T12:00:00+24:00','2026-11-06T12:00:00+01:60','2026-02-30T12:00:00Z']) {
    // A nearby clock catches parsers that silently roll February 30 into March.
    const nearby = Date.parse(asOf);
    const clock = Number.isFinite(nearby) ? nearby+1000 : now;
    assert.equal(technicalConsensus({...period,asOf},'daily',{},clock).label,'未取得',asOf);
  }
  for (const asOf of ['2026-11-06','2026-11-06T12:00:00Z','2026-11-06T12:00:00.123Z','2026-11-06T12:00:00-05:00']) assert.equal(run({...period,asOf}).label,'強い買い');
  assert.equal(technicalConsensus({...period,asOf:'2024-02-29'},'daily',{},Date.parse('2024-03-01')).label,'強い買い');
});
test('technical aggregate stale/unavailable status also blocks otherwise valid periods', () => {
  for (const technicalStatus of ['stale','unavailable','error']) assert.equal(run(period,'daily',{status:'ok',technicalStatus}).label,'未取得');
  const app=readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
  assert.match(app,/technicalStatus: technical\.status/);
});
test('legacy render rechecks cached period freshness and aggregate statuses', () => {
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const source=readFileSync(new URL('../src/technicalSummary.js',import.meta.url),'utf8').replaceAll('export ','');
  const renderer=html.slice(html.indexOf('function technicalSummaryHtml('),html.indexOf('function buySignalIndicatorHtml('));
  let clock=now;
  class ClockDate extends Date { static now(){return clock;} }
  const sandbox={Date:ClockDate,esc:value=>String(value),buySignalIndicatorHtml:()=>''};
  vm.createContext(sandbox);vm.runInContext(source+'\n'+renderer,sandbox);
  const result={status:'ready',technicalPeriods:{daily:{...period},weekly:{...period}},indicators:{daily:{},weekly:{}},
    technicalSummary:[{key:'daily',label:'日間',verdict:{label:'強い買い',tone:'buy'}}]};
  assert.match(sandbox.technicalSummaryHtml(result),/technical-verdict buy/);
  clock=now+15*86400000;
  assert.doesNotMatch(sandbox.technicalSummaryHtml(result),/technical-verdict buy/);
  clock=now;
  for(const key of ['technicalStatus','indicatorsStatus']) for(const status of ['stale','unavailable','error']) {
    assert.doesNotMatch(sandbox.technicalSummaryHtml({...result,[key]:status}),/technical-verdict buy/);
  }
  assert.doesNotMatch(sandbox.technicalSummaryHtml({...result,technicalPeriods:undefined}),/technical-verdict buy/);
  assert.match(html,/technicalStatus:source\.technical\?\.status,indicatorsStatus:source\.indicators\?\.status/);
});
