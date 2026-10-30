'use strict';
// DOM only. Synthetic data, no network, no browser layout assertions.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {JSDOM}=require('/tmp/dashboard-dom-qa/node_modules/jsdom');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const dom=new JSDOM(html.replace(/<script>([\s\S]*?)<\/script>/,''),{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window;w.setTimeout=()=>1;w.setInterval=()=>1;w.requestAnimationFrame=f=>f();w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};w.fetch=async()=>{throw Error('Network disabled')};
w.eval(script+`\nIntelligenceOS.initialized=true;ThemeTracker.initialized=true;MarketRegime.initialized=true;closeModal();cur='mkt';renderMkt();window.qa={state:MovementMonitor,themes:IntelligenceOS};`);
const panel=()=>w.document.querySelector('#movement-monitor');
assert.match(panel().textContent,/対象 0銘柄/);
const now=Date.now(),symbols=['AAA','BBB','CCC'],data=t=>Object.fromEntries([...symbols,'SPY'].map(s=>[s,{price:t===now?(s==='SPY'?99:103):100,at:new Date(t).toISOString(),retrievedAt:new Date(t).toISOString(),src:'SYNTHETIC QA',currency:'USD',marketState:'open',freshness:'live',observationPairVerified:true}]));
w.movementIngest(w.qa.state,data(now-300000),symbols,now-300000);w.movementIngest(w.qa.state,data(now),symbols,now);w.qa.themes.themes=[{id:'qa',name:'<script>QA</script>',relatedTickers:symbols}];w.movementRefreshPanel();
assert.match(panel().textContent,/市場逆行/);assert.match(panel().textContent,/同方向の値動き/);assert.equal(panel().querySelectorAll('script').length,0);
panel().querySelector('details').open=true;w.movementRefreshPanel();assert.equal(panel().querySelector('details').open,true);
const realNow=w.Date.now;w.Date.now=()=>now+180000;w.movementRefreshPanel();assert.match(panel().textContent,/前回観測の検出/);assert.match(panel().textContent,/最新未確認・現在のシグナルではありません/);assert.doesNotMatch(panel().textContent,/市場逆行/);w.Date.now=realNow;
for(const points of Object.values(w.qa.state.samples))for(const q of points){q.at=new Date(Date.parse(q.at)-180000).toISOString();q.retrievedAt=q.at}w.movementRefreshPanel();assert.doesNotMatch(panel().textContent,/市場逆行/);
w.movementIngest(w.qa.state,{},symbols,Date.now());w.movementRefreshPanel();assert.match(panel().textContent,/価格取得失敗/);assert.doesNotMatch(panel().textContent,/同方向の値動き/);
w.close();console.log('PASS DOM: empty, synthetic rapid/relative/theme signals, escaped source label, preserved details state, stale removal, failed-refresh state. No network; not visual QA.');
