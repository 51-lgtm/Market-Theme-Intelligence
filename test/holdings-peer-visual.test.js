'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('function holdingsPeerHtml('),html.indexOf('function holdingsPriceMapHtml('));
function context(){const ctx={esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),technicalTimestamp:value=>Date.parse(value),holdingsTechnicalFrame:result=>({evidenceReady:!result?.stale,period:{asOf:'2026-11-06'}}),TICKER_RE:/^[A-Z0-9.-]{1,20}$/};vm.runInNewContext(source,ctx);return ctx;}
function fixture(){const row={return20Pct:5,rsi14:60,macdHistogramPct:.2,macdState:'positive',source:'synthetic-only',retrievedAt:null};return{symbol:'SYNTH',peerComparison:{methodVersion:'explicit-group-aligned-daily-peers-v1',symbol:'SYNTH',status:'ok',asOf:'2026-11-06',analysisOnly:true,tradeEligible:false,period:{start:'2026-10-09',end:'2026-11-06',closes:21,returns:20,interval:'1d',priceMode:'adjusted',currency:'USD'},self:{...row,return20Pct:8},peers:[{...row,symbol:'PEER1',return20Pct:-4,correlation20:.8},{...row,symbol:'PEER2',return20Pct:2,correlation20:null}],peerMedianReturn20Pct:-1,relativeReturn20Pp:9,groups:[],excluded:[]}};}
test('summary is visible without expanding details and states past relative strength',()=>{
 const out=context().holdingsPeerHtml(fixture(),'a'),summary=out.slice(0,out.indexOf('<details'));
 assert.match(summary,/data-peer-summary/);assert.match(summary,/過去20本.*2銘柄.*9.00ポイント強い/);assert.match(summary,/将来予測ではありません/);
 assert.doesNotMatch(out,/<details[^>]+\sopen/);assert.match(out,/data-peer-chart/);assert.match(out,/今後の予想ではありません/);
 assert.ok(out.indexOf('data-peer-chart')>out.indexOf('<details'));
});
test('diverging bars use one zero baseline and a shared scale with visible signed numbers',()=>{
 const out=context().holdingsPeerHtml(fixture(),'a');
 assert.match(out,/SYNTH（この銘柄）/);assert.match(out,/\+8.00%/);assert.match(out,/-4.00%/);
 assert.match(out,/left:50.0000%;width:50.0000%/);assert.match(out,/left:25.0000%;width:25.0000%/);assert.match(out,/left:50.0000%;width:12.5000%/);
 assert.match(out,/全銘柄で同じ目盛り/);assert.match(out,/aria-label="同じ期間の20本騰落率の比較"/);
});
test('zero series and equal median do not imply outperforming or divide by zero',()=>{
 const r=fixture();r.peerComparison.self.return20Pct=0;r.peerComparison.peers.forEach(p=>p.return20Pct=0);r.peerComparison.peerMedianReturn20Pct=0;r.peerComparison.relativeReturn20Pp=0;
 const out=context().holdingsPeerHtml(r,'a');assert.match(out,/ほぼ同水準/);assert.match(out,/全銘柄0%のため棒はありません/);assert.doesNotMatch(out,/NaN|Infinity|0.00ポイント強い/);
});
test('unavailable, stale or malformed evidence has visible explanation but no chart',()=>{
 for(const patch of [r=>{r.stale=true},r=>{r.peerComparison=null},r=>{r.peerComparison.asOf='2026-11-05'},r=>{r.peerComparison.self.rsi14=null},r=>{r.peerComparison.peers[0].macdState='negative'}]){
  const r=fixture();patch(r);const out=context().holdingsPeerHtml(r,'a');assert.match(out.slice(0,out.indexOf('<details')),/比較できません/);assert.doesNotMatch(out,/data-peer-chart|9.00ポイント強い/);
 }
});
test('single peer or inconsistent median cannot support relative-strength summary',()=>{
 const r=fixture();r.peerComparison.peers.pop();const out=context().holdingsPeerHtml(r,'a');assert.match(out,/1銘柄だけ.*未判定/);assert.match(out,/data-peer-chart/);assert.doesNotMatch(out,/9.00ポイント強い/);
 const bad=fixture();bad.peerComparison.relativeReturn20Pp=99;assert.match(context().holdingsPeerHtml(bad,'a'),/中央値との整合を確認できず/);
});
