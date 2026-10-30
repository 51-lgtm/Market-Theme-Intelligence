'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(process.env.DASHBOARD_HTML||path.join(__dirname,'../index.html'),'utf8');
const block=(start,end)=>{const i=html.indexOf(`function ${start}(`),j=html.indexOf(`function ${end}(`,i+1);assert.ok(i>=0&&j>i);return html.slice(i,j)};
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

test('rebuilt inline application parses',()=>{const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];assert.equal(scripts.length,1);assert.doesNotThrow(()=>new vm.Script(scripts[0][1]));});

test('sync labels distinguish unknown, in progress, partial and failed states',()=>{
 const c={};vm.runInNewContext(block('syncOutcomeText','syncCenterPanel'),c);
 for(const state of [{},{status:'idle'},{status:'ok'}]){assert.equal(c.syncOutcomeText(state),'同期結果は未確認です');assert.equal(c.syncBenchmarkText(state),'未確認');}
 const prior={lastResponseAt:'2026-10-29T10:00:00Z'};
 assert.match(c.syncOutcomeText({...prior,status:'syncing'}),/同期中/);
 assert.match(c.syncBenchmarkText({...prior,status:'syncing'}),/前回値/);
 assert.match(c.syncOutcomeText({...prior,status:'error'}),/同期に失敗/);
 assert.match(c.syncBenchmarkText({...prior,status:'error'}),/確認できません/);
 assert.match(c.syncOutcomeText({...prior,status:'partial'}),/一部成功/);
 assert.equal(c.syncBenchmarkText({...prior,status:'partial',benchmarkError:true}),'取得失敗');
 assert.equal(c.syncBenchmarkText({...prior,status:'partial',benchmarkStale:true}),'古いキャッシュ');
 assert.match(c.syncOutcomeText({...prior,status:'ok'}),/すべての価格がLIVEであることは意味しません/);
 assert.match(c.syncBenchmarkText({...prior,status:'ok'}),/LIVE保証なし/);
});

test('sync panels preserve missing time, accepted-data semantics and escaped errors',()=>{
 let modal='';const c={S:{sync:{},settings:{}},location:{origin:'http://localhost'},esc,fmtAt:v=>v||'未取得',safeText:v=>String(v||''),openModal:v=>modal=v};
 vm.runInNewContext(block('syncMarketRegimeText','renderLog'),c);
 assert.match(c.syncCenterPanel(),/SPYベンチマーク: <span data-sync-benchmark>未確認/);
 c.openSyncDetails();assert.match(modal,/同期結果は未確認/);assert.doesNotMatch(modal,/最終同期は正常に完了しました/);
 c.S.sync={status:'partial',lastResponseAt:'2026-10-29T10:00:00Z',lastError:'<failure>'};
 c.openSyncDetails();assert.match(modal,/一部成功です/);assert.match(modal,/&lt;failure&gt;/);assert.doesNotMatch(modal,/<failure>/);
 assert.match(modal,/最終データ受入（部分更新含む）/);assert.match(modal,/データ受入時刻は価格の観測時刻ではありません/);
 assert.match(modal,/最終同期処理完了（失敗含む）/);assert.match(modal,/画面を開いた時点の記録/);
 assert.doesNotMatch(block('syncCenterPanel','renderLog'),/fmtAt\(st.lastResponseAt\|\|st.lastAttemptAt\)/);
});

test('sync lifecycle refreshes visible labels without replacing or focusing modal nodes',()=>{
 const nodes=Object.fromEntries(['outcome','benchmark','status','state'].map(key=>[key,{textContent:'',className:''}]));
 const c={S:{sync:{status:'syncing',lastResponseAt:'2026-10-29T10:00:00Z'}},$:()=>null,document:{querySelectorAll:selector=>[nodes[selector.match(/data-sync-(\w+)/)[1]]]}};
 vm.runInNewContext(block('syncOutcomeText','syncCenterPanel')+block('setSyncBusy','syncErrorText'),c);
 c.setSyncBusy(true);assert.match(nodes.outcome.textContent,/同期中/);assert.equal(nodes.status.textContent,'syncing');assert.equal(nodes.state.className,'conn-state partial');
 c.S.sync.status='partial';c.setSyncBusy(false);assert.match(nodes.outcome.textContent,/一部成功/);assert.equal(nodes.state.textContent,'一部成功');
 assert.doesNotMatch(block('setSyncBusy','syncErrorText'),/innerHTML|openModal|focus\(/);
});

test('market quote display distinguishes missing from zero without invoking pct(null)',()=>{
 const c={esc,fmtAt:v=>v||'未取得',pct:v=>(v>=0?'+':'')+v.toFixed(2)+'%'};
 vm.runInNewContext(block('marketWatchQuoteHtml','renderMkt'),c);
 assert.match(c.marketWatchQuoteHtml(null),/価格未取得/);
 assert.match(c.marketWatchQuoteHtml({price:10,changePct:null}),/\$10.00 騰落N\/A/);
 assert.match(c.marketWatchQuoteHtml({price:10,changePct:0}),/\+0.00%/);
 assert.match(c.marketWatchQuoteHtml({price:10,changePct:-1}),/redc/);
 assert.match(c.marketWatchQuoteHtml({price:null,changePct:NaN}),/価格N\/A 騰落N\/A/);
 assert.match(c.marketWatchQuoteHtml({price:10,stale:true,src:'<provider>'}),/&lt;provider&gt;/);
 assert.match(c.marketWatchQuoteHtml({price:10,stale:true}),/古いデータ/);
});

test('market section jumps use local allowlisted targets with focus and no routing',()=>{
 const calls=[],target={setAttribute:(...args)=>calls.push(['attribute',...args]),focus:options=>calls.push(['focus',options]),scrollIntoView:options=>calls.push(['scroll',options])};
 const c={document:{querySelector:selector=>{calls.push(['query',selector]);return target}}};
 vm.runInNewContext(block('jumpMarketSection','marketWatchQuoteHtml'),c);c.jumpMarketSection('market-watch-list');
 assert.equal(calls[0][1],'#tab-mkt #market-watch-list');assert.equal(calls[1][1],'tabindex');assert.equal(calls[2][1].preventScroll,true);assert.equal(calls[3][1].behavior,'auto');
 calls.length=0;c.jumpMarketSection('outside-market');assert.equal(calls.length,0);
 assert.match(html,/aria-label="市場画面のページ内移動"/);assert.match(html,/aria-label="監視するティッカーを追加"/);
 assert.match(html,/\.market-jumps button\{min-height:44px/);assert.doesNotMatch(block('jumpMarketSection','marketWatchQuoteHtml'),/location|history|fetch/);
});
