'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const block=(a,b)=>html.slice(html.indexOf('function '+a+'('),html.indexOf('function '+b+'('));
const now=Date.parse('2026-10-30T12:00:00Z');
const context={Date:class extends Date { static now(){return now;} },hAgo:s=>Number.isFinite(Date.parse(s))?Math.max(0,(now-Date.parse(s))/36e5):Infinity,agoTxt:h=>h+'h',fmtUsd:n=>'$'+n,esc:s=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;')};
vm.runInNewContext(block('portfolioXraySnapshot','xrayQuoteQuality')+block('xrayQuoteQuality','portfolioXrayMetrics')+block('portfolioQualityPanel','positionSummaryHtml'),context);
const position=(extra={})=>({ticker:'A',shares:1,price:100,currency:'USD',priceSource:'api',freshness:'live',priceAt:'2026-10-30T11:55:00Z',syncedAt:'2026-10-30T12:00:00Z',...extra});
const snapshot=positions=>{const x=context.portfolioXraySnapshot({positions,settings:{usdJpy:150}});x.rows.forEach(r=>r.quality=context.xrayQuoteQuality(r.position,r));return x;};
test('quote labels do not promote unknown, delayed or old observations into LIVE',()=>{
 for(const [extra,key] of [[{},'fresh'],[{freshness:''},'reference'],[{priceAt:null},'reference'],[{delayed:true},'reference'],[{priceAt:'2026-10-29T12:00:00Z'},'aging'],[{priceAt:'2026-10-28T12:00:00Z'},'stale'],[{priceAt:'2026-11-01T12:00:00Z'},'reference'],[{freshness:'previous-close-valid'},'reference'],[{freshness:'stale'},'stale'],[{priceSource:'manual'},'manual']])assert.equal(snapshot([position(extra)]).rows[0].quality.key,key);
});
test('quality exposure uses market value not security count and does not mutate inputs',()=>{
 const positions=[position(),position({ticker:'B',price:300,priceSource:'manual'})],before=JSON.stringify(positions),out=context.portfolioQualityPanel(snapshot(positions));
 assert.match(out,/LIVE判定の価格・1件/);assert.match(out,/\$100 <span>／ 25.0%/);assert.match(out,/\$300 <span>／ 75.0%/);assert.equal(JSON.stringify(positions),before);
});
test('unpriced and unsupported rows stop all total weights and escape their names',()=>{
 for(const extra of [{price:null},{currency:'EUR'}]){
  const out=context.portfolioQualityPanel(snapshot([position(),position({ticker:'<unsafe>',...extra})]));
  assert.match(out,/価格評価可能 1\/2件/);assert.match(out,/評価対象外 1件（&lt;unsafe&gt;）/);assert.match(out,/比率 N\/A/);assert.doesNotMatch(out,/100.0%|<unsafe>/);
 }
});
test('empty holdings are unassessed, while a genuine zero category is allowed',()=>{
 const empty=context.portfolioQualityPanel(snapshot([]));assert.match(empty,/未登録・未評価/);assert.doesNotMatch(empty,/\$0/);
 const ready=context.portfolioQualityPanel(snapshot([position()]));assert.match(ready,/\$0 <span>／ 0.0%/);
});
