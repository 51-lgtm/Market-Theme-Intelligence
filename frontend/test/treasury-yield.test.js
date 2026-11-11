import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { treasuryYieldView, createTreasuryYieldStore, TREASURY_SOURCE_URL } from '../src/treasuryYield.js';

const now = Date.parse('2026-11-09T16:30:00Z');
const fixture = () => ({ status: 'fresh', stale: false, latest: {date:'2026-11-06',yieldPct:4.22}, previous: {date:'2026-11-05',yieldPct:4.19}, changeBps:3, retrievedAt:'2026-11-09T16:20:00.000Z', checkedAt:'2026-11-09T16:25:00.000Z', calendarVerified:false, latestSessionVerified:false });
const view = (raw = fixture(), extra = {}) => treasuryYieldView(raw, {now, ...extra});
const response = (body, status=200) => ({ok: status >= 200 && status < 300, status, json: async () => body});
const shared = readFileSync(new URL('../src/treasuryYield.js',import.meta.url),'utf8').replaceAll('export ','');
const html = readFileSync(new URL('../../index.html',import.meta.url),'utf8');

test('official daily percent yield and prior publication bp difference have explicit dates and provenance', () => {
  const result = view();
  assert.equal(result.yieldText,'4.22%');
  assert.equal(result.changeText,'+3 bp');
  assert.equal(result.asOf,'2026-11-06');
  assert.equal(result.previousDate,'2026-11-05');
  assert.equal(result.previousText,'4.19%');
  assert.equal(result.retrievedText,'2026-11-09 16:20:00 UTC');
  assert.equal(result.checkedText,'2026-11-09 16:25:00 UTC');
  assert.equal(result.status,'received');
  assert.equal(result.observationAgeDays,3);
  assert.match(result.notes.join(' '),/観測日から3暦日経過/);
  assert.match(result.notes.join(' '),/土日・米国祝日/);
  assert.match(result.notes.join(' '),/最新公表日との照合は未実施/);
  assert.equal(new URL(TREASURY_SOURCE_URL).hostname,'home.treasury.gov');
});

test('null, numeric strings and malformed yields never become zero or an earlier value', () => {
  for (const yieldPct of [null,undefined,'4.22','',false,true,NaN,Infinity,-Infinity,{},101,-101]) {
    const data=fixture();data.latest.yieldPct=yieldPct;
    const result=view(data);
    assert.equal(result.yieldText,'N/A',String(yieldPct));
    assert.equal(result.changeText,'N/A');
    assert.equal(result.asOf,'2026-11-06');
    assert.equal(result.previousText,'4.19%');
    assert.match(result.notes.join(' '),/前の日の値では補完しません/);
  }
  const data=fixture();data.status='unavailable';data.latest.yieldPct=null;
  assert.equal(view(data).yieldText,'N/A');
  assert.equal(view(data).asOf,'2026-11-06');
});

test('real zero, negative and fractional bp changes retain their units without direction predictions', () => {
  const data=fixture();data.latest.yieldPct=0;data.previous.yieldPct=0;data.changeBps=0;
  assert.equal(view(data).yieldText,'0.00%');assert.equal(view(data).changeText,'0 bp');
  data.latest.yieldPct=4.16;data.previous.yieldPct=4.19;data.changeBps=-3;
  assert.equal(view(data).changeText,'-3 bp');
  data.latest.yieldPct=4.191;data.changeBps=.1;
  assert.equal(view(data).changeText,'+0.10 bp');
  for(const value of [3,'-3',null,undefined,NaN,Infinity,1]) {data.changeBps=value;assert.equal(view(data).changeText,'N/A');}
});

test('immediately preceding missing observation stays missing and cannot create a delta', () => {
  const data=fixture();data.previous.yieldPct=null;
  const result=view(data);
  assert.equal(result.yieldText,'4.22%');assert.equal(result.previousText,'N/A');assert.equal(result.previousDate,'2026-11-05');assert.equal(result.changeText,'N/A');
  for (const previous of [null,{}, {date:'2026-11-06',yieldPct:4.19},{date:'2026-11-07',yieldPct:4.19},{date:'2026-02-30',yieldPct:4.19}]) {
    assert.equal(view({...fixture(),previous}).previousDate,null);
    assert.equal(view({...fixture(),previous}).changeText,'N/A');
  }
});

test('dates reject overflow, future observations and HTML rather than interpolating API strings', () => {
  for (const date of [null,undefined,'2026-02-30','2026-02-29','2026-13-01','2026-04-31','2026-11-10','11/06/2026','2026-11-6','<img onerror=alert(1)>']) {
    const data=fixture();data.latest.date=date;
    assert.equal(view(data).asOf,null,String(date));assert.equal(view(data).yieldText,'N/A');assert.equal(view(data).changeText,'N/A');
  }
  for (const status of ['ok','ready','<script>',null,undefined]) assert.equal(view({...fixture(),status}).yieldText,'N/A');
});

test('stale flags, retrieval expiry and failed retries are visible while fresh never asserts latest publication', () => {
  assert.equal(view({...fixture(),status:'stale'}).status,'stale');
  assert.equal(view({...fixture(),stale:true}).status,'stale');
  assert.equal(view({...fixture(),retrievedAt:'2026-11-09T15:30:00Z'}).status,'stale');
  const failed=view(fixture(),{requestFailed:true});assert.equal(failed.status,'stale');assert.match(failed.notes.join(' '),/前回の取得結果/);
  assert.equal(view(fixture()).statusLabel,'取得済み / 日次公表値');
  assert.equal(view({...fixture(),retrievedAt:null}).status,'unverified');
});

test('retrieval timestamps reject future, overflow and unqualified times', () => {
  for (const retrievedAt of [undefined,null,'bad','2026-02-30T12:00:00Z','2026-11-09T24:00:00Z','2026-11-09T16:00:00','2026-11-09','2026-11-09T16:40:00Z','2026-11-09T16:60:00Z']) {
    const result=view({...fixture(),retrievedAt});assert.equal(result.retrievedText,'N/A',String(retrievedAt));assert.equal(result.status,'unverified');
  }
  for(const retrievedAt of ['2026-11-09T16:20:00Z','2026-11-09T16:20:00.1Z','2026-11-09T16:20:00.123Z']) assert.notEqual(view({...fixture(),retrievedAt}).retrievedText,'N/A');
});

test('store fetches once across view visits and only manual requests can refetch', async () => {
  let calls=0,optionsSeen;
  const store=createTreasuryYieldStore({fetcher:async (url,options)=>{assert.equal(url,'/api/treasury-yield');optionsSeen=options;calls++;return response(fixture());}});
  await store.load();await store.load();await store.load();assert.equal(calls,1);
  assert.equal(optionsSeen.credentials,'omit');assert.equal(optionsSeen.cache,'no-store');assert.deepEqual(optionsSeen.headers,{Accept:'application/json'});
  await store.load(true);assert.equal(calls,2);assert.equal(store.getState().loading,false);
});

test('duplicate clicks and StrictMode subscriptions coalesce into one request', async () => {
  let finish,calls=0;const seen=[];
  const store=createTreasuryYieldStore({fetcher:()=>{calls++;return new Promise(resolve=>finish=resolve);}});
  const unsubscribe=store.subscribe(state=>seen.push(state.loading));
  const first=store.load();assert.equal(store.load(),first);assert.equal(store.load(true),first);await Promise.resolve();assert.equal(calls,1);
  finish(response(fixture()));await first;
  assert.deepEqual(seen,[true,false]);unsubscribe();await store.load();assert.deepEqual(seen,[true,false]);
});

test('failed first reads do not loop; an explicit retry can recover', async () => {
  let calls=0;const store=createTreasuryYieldStore({fetcher:async()=>{if(++calls===1)throw new Error('offline');return response(fixture());}});
  await store.load();assert.equal(store.getState().requestFailed,true);assert.equal(store.getState().payload,null);
  await store.load();assert.equal(calls,1);await store.load(true);assert.equal(store.getState().requestFailed,false);assert.equal(calls,2);
});

test('failed refresh retains only marked stale prior values while a missing publication replaces them', async () => {
  let mode='ok';const store=createTreasuryYieldStore({fetcher:async()=>{if(mode==='offline')throw new Error('offline');if(mode==='missing'){const f=fixture();f.latest.yieldPct=null;f.status='unavailable';return response(f,503);}return response(fixture());}});
  await store.load();mode='offline';await store.load(true);
  const failed=store.getState();assert.equal(view(failed.payload,{requestFailed:failed.requestFailed}).status,'stale');
  mode='missing';await store.load(true);assert.equal(store.getState().requestFailed,false);assert.equal(view(store.getState().payload).yieldText,'N/A');
});

test('HTML errors and invalid response statuses are never rendered as trusted observations', async () => {
  for(const bad of [response({status:'ok'}),response({status:'fresh'},403),response(['fresh']),{ok:true,status:200,json:async()=>{throw new Error('<html>');}}]) {
    const store=createTreasuryYieldStore({fetcher:async()=>bad});await store.load();assert.equal(store.getState().requestFailed,true);assert.equal(store.getState().payload,null);
  }
});

test('legacy shares exact validation and request semantics and displays untrusted text safely', () => {
  assert.ok(html.includes(shared));
  const renderer=html.slice(html.indexOf('function renderTreasuryYieldPanel()'),html.indexOf('OfficialTreasuryYieldStore.subscribe('));
  const raw=fixture();raw.sourceUrl='javascript:alert(1)';raw.source='<script>alert(1)</script>';raw.error='<img onerror=alert(1)>';raw.latest.date='<img onerror=alert(1)>';
  const sandbox={state:{payload:raw,loading:false,requestFailed:false},esc:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
  vm.createContext(sandbox);vm.runInContext(shared+'\nconst OfficialTreasuryYieldStore={getState:()=>state};\n'+renderer,sandbox);
  const out=sandbox.renderTreasuryYieldPanel();assert.doesNotMatch(out,/<script>|<img|javascript:|onerror=/);assert.match(out,/N\/A/);assert.match(out,/rel="noopener noreferrer"/);assert.match(out,/前回公表データ日/);
  assert.match(html,/\$\{renderMarketRegimePanel\(\)\}\s+\$\{renderTreasuryYieldPanel\(\)\}/);
  assert.match(html,/if\(t==='mkt'\)fetchTreasuryYield\(\)/);
  assert.doesNotMatch(shared,/setInterval|localStorage|visibilitychange|setCsrf/);
});

test('React mounts independent display-only panel with relative-change TNX labeling', () => {
  const app=readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
  const panel=readFileSync(new URL('../src/TreasuryYieldPanel.jsx',import.meta.url),'utf8');
  assert.match(app,/<MarketStrip market=\{data\?\.market\} \/>\s+<TreasuryYieldPanel \/>/);
  assert.match(app,/米10年債 \(\^TNX参考\)/);assert.match(app,/相対変化/);
  assert.match(panel,/treasuryStore\.load\(\)/);assert.match(panel,/treasuryStore\.load\(true\)/);assert.match(panel,/return unsubscribe/);
  assert.doesNotMatch(panel,/setInterval|dangerouslySetInnerHTML/);
});

test('synchronous transport errors release the request lock for a manual retry', async () => {
  let calls=0;const store=createTreasuryYieldStore({fetcher:()=>{if(++calls===1)throw new Error('transport');return Promise.resolve(response(fixture()));}});
  await store.load();assert.equal(store.getState().requestFailed,true);await store.load(true);assert.equal(store.getState().requestFailed,false);assert.equal(calls,2);
});
