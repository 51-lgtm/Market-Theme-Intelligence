'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const block=(a,b)=>{const i=html.indexOf(`function ${a}(`),j=html.indexOf(`function ${b}(`,i+1);assert.ok(i>=0&&j>i);return html.slice(i,j)};
test('rebuilt technical indicator display keeps missing inputs separate from actual zero',()=>{
 const c={safeText:v=>String(v??'')};vm.runInNewContext(block('buySignalValueText','normalizeBuySignalResult'),c);
 for(const v of [null,undefined,'','  ',false,true,[],{},{value:null},{current:''}]){const r=c.normalizeBuySignalIndicator({rsi:v,rvol:v});assert.equal(r.rsi,null);assert.equal(r.rvol,null)}
 for(const v of [0,'0',{value:0}]){const r=c.normalizeBuySignalIndicator({rsi:v,rvol:v});assert.equal(r.rsi,0);assert.equal(r.rvol,0)}
 assert.equal(c.normalizeBuySignalIndicator({price:null,ema20:null}).ema,'N/A');
});
test('rebuilt score explanation preserves unavailable vs observed zero and exposes deductions/caps',()=>{
 const c={safeText:v=>String(v??'')};vm.runInNewContext(block('buySignalScoreExplanation','normalizeBuySignalIndicator'),c);
 assert.match(c.buySignalScoreExplanation(null),/内訳未取得/);
 const output=c.buySignalScoreExplanation({groups:[{key:'daily',points:0,maximum:45,availablePoints:10,components:[{label:'missing',available:false,passed:false,points:0},{label:'measured',available:true,passed:false,points:0}]}],rawScore:0,deductions:[{label:'partial data',points:-10}],scoreBeforeCaps:0,caps:[{key:'stale',maximum:69}],finalScore:0});
 assert.match(output,/日足: 0 \/ 45点（評価可能配点 10）/);assert.match(output,/missing: 未評価/);assert.doesNotMatch(output,/missing: 未評価 \/ 0点/);assert.match(output,/measured: 条件不成立 \/ 0点/);assert.match(output,/partial data -10点/);assert.match(output,/stale: 最大69点/);assert.match(output,/最終得点 0点/);assert.ok(output.includes('\n'));
 const missing=c.buySignalScoreExplanation({});assert.match(missing,/減点: 未取得/);assert.match(missing,/最終得点 N\/A点/);assert.doesNotMatch(missing,/減点: なし/);
 assert.match(html,/esc\(result.scoreExplanation/);assert.match(html,/得点内訳・未評価項目・品質・出所を確認/);
});
test('rebuilt AI provenance separates stored display/import/observation times and avoids stale ordering claims',()=>{
 const c={esc:v=>String(v).replaceAll('<','&lt;'),fmtAt:v=>'FMT:'+v};vm.runInNewContext(block('aiSnapshotProvenanceHtml','renderAI'),c);
 const empty=c.aiSnapshotProvenanceHtml({});assert.match(empty,/取込記録: 未記録/);assert.match(empty,/入力した市場レジーム基準: 未記録/);
 const known=c.aiSnapshotProvenanceHtml({atIso:'2026-10-29T10:00:00Z',at:'<claimed>',marketRegimeAsOf:'2026-10-28'});
 assert.match(known,/FMT:2026-10-29/);assert.match(known,/&lt;claimed>/);assert.match(known,/保存された時刻表示（回答記載または取込時の補完）/);assert.match(known,/保存済みAI回答は再生成されません/);
 const source=block('renderAI','buildPrompt');assert.match(source,/取込順・AI評価/);assert.doesNotMatch(source,/スコア順/);assert.match(source,/AI打診案/);assert.match(source,/行動メモに追加/);assert.match(source,/この保存形式では欠損得点が0保存/);
});
