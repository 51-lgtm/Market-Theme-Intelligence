'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(process.env.TEST_HTML||path.join(__dirname,'..','index.html'),'utf8');
function block(a,b){const i=html.indexOf(`function ${a}(`),j=html.indexOf(`function ${b}(`,i+1);assert.ok(i>=0&&j>i);return html.slice(i,j)}
const format={fmtUsd:n=>`$${n}`,fmtJpy:n=>`JPY${n}`,pct:n=>`${n}%`,esc:String};

test('holdings: missing marks, absent holdings, missing daily changes and genuine zero stay distinct',()=>{
 const context={...format};vm.runInNewContext(block('positionSummaryHtml','renderPos'),context);
 const C={fx:150,val:100,pnl:0,cost:100,dayPnl:0};
 const empty=context.positionSummaryHtml(C,{positions:[],cash:{}});
 assert.match(empty,/保有未登録/);assert.match(empty,/JPY未入力/);assert.match(empty,/USD未入力/);assert.doesNotMatch(empty,/\$0/);
 const missing=context.positionSummaryHtml(C,{positions:[{shares:1,price:null}],cash:{jpy:0,usd:0}});
 assert.match(missing,/価格評価可能 0\/1/);assert.match(missing,/<b>N\/A<\/b>/);assert.match(missing,/JPY0/);
 assert.match(context.positionSummaryHtml(C,{positions:[{shares:1,price:100,changePct:null}]}),/当日損益<\/small><b class="mut">N\/A/);
 const ready=context.positionSummaryHtml(C,{positions:[{shares:1,price:100,changePct:0}]});
 assert.match(ready,/当日損益<\/small><b class="grnc">\$0/);assert.match(ready,/評価損益<\/small><b class="grnc">\$0/);
 assert.match(context.positionSummaryHtml(C,{positions:[{shares:1,price:100,currency:'EUR'}]}),/価格評価可能 0\/1/);
 assert.deepEqual(C,{fx:150,val:100,pnl:0,cost:100,dayPnl:0});
 assert.match(block('renderPos','stressScenarioSnapshot'),/現在値未取得・取得価額で代用しません/);
});

test('holdings: fallback FX is not displayed as a confirmed yen valuation',()=>{
 const context={...format};vm.runInNewContext(block('positionSummaryHtml','renderPos'),context);
 const C={fx:150,val:100,pnl:10,cost:90,dayPnl:1},state={positions:[{shares:1,price:100,changePct:1}],settings:{usdJpy:null},cash:{}};
 const unknown=context.positionSummaryHtml(C,state);assert.match(unknown,/\$100/);assert.match(unknown,/為替未確認/);assert.doesNotMatch(unknown,/JPY15000/);
 state.settings.usdJpy=150;assert.match(context.positionSummaryHtml(C,state),/JPY15000/);
 assert.match(block('renderPos','stressScenarioSnapshot'),/為替未確認・JPY N\/A/);
});

test('X-RAY: mixed missing or unsupported holdings never present measured subtotal as total',()=>{
 const context={...format,xrayGuidance:()=> '確認'};
 vm.runInNewContext(block('portfolioXraySnapshot','xrayQuoteQuality')+block('portfolioXrayPanel','positionSummaryHtml'),context);
 const state={settings:{usdJpy:150},cash:{jpy:0,usd:0},positions:[{ticker:'A',shares:1,price:100,avgCost:90,stopPx:90,role:'trade'},{ticker:'B',shares:1,price:null,avgCost:100,role:'trade'}]};
 for(const second of [{price:null},{price:100,currency:'EUR'}]){
  Object.assign(state.positions[1],second);const x=context.portfolioXraySnapshot(state);
  assert.equal(x.rows[0].weightPct,100);assert.equal(x.remainingStopRiskJpy,1500);
  x.rows.forEach(r=>r.quality={cls:'mut',label:'fixture'});x.drawdown={armed:true,drawdown:0,dataComplete:false,dataFresh:false,peak:15000};context.portfolioXrayMetrics=()=>x;
  const out=context.portfolioXrayPanel();assert.match(out,/STOP参考損失<\/small><b class="">N\/A/);assert.match(out,/STOP COVER<\/small><b>N\/A/);assert.match(out,/保有全体は未評価/);assert.doesNotMatch(out,/aria-valuenow=/);assert.doesNotMatch(out,/class="weight">100/);assert.match(out,/STOPまで JPY1500/);assert.match(out,/class="mut">DRAWDOWN GUARD N\/A（未評価）/);
 }
 state.positions.pop();const x=context.portfolioXraySnapshot(state);x.rows.forEach(r=>r.quality={cls:'ok',label:'fixture'});context.portfolioXrayMetrics=()=>x;
 assert.match(context.portfolioXrayPanel(),/STOP参考損失<\/small><b class="">JPY1500/);assert.match(context.portfolioXrayPanel(),/aria-valuenow="100.0"/);
 x.drawdown={armed:true,drawdown:1,dataComplete:true,dataFresh:false,peak:15150};assert.match(context.portfolioXrayPanel(),/DRAWDOWN GUARD 1.0%（参考・要同期）/);
 x.drawdown.dataFresh=true;assert.match(context.portfolioXrayPanel(),/class="grnc">DRAWDOWN GUARD 1.0%/);
});

test('X-RAY: missing FX overrides a misleading legacy DD complete flag',()=>{
 const x={rows:[{ticker:'A',weightPct:100,marketValueUsd:100,supportedCurrency:true,validMark:true,hasNumericStop:false,position:{role:'core'},quality:{cls:'mut',label:'fixture'}}],fxValid:false,unpricedCount:0,unsupportedCurrencyCount:0,drawdown:{armed:true,drawdown:0,dataComplete:true,dataFresh:true},stopCoveragePct:null,hhi:null,effectiveN:null};
 const context={...format,portfolioXrayMetrics:()=>x,xrayGuidance:()=> '確認'};vm.runInNewContext(block('portfolioXrayPanel','positionSummaryHtml'),context);
 assert.match(context.portfolioXrayPanel(),/class="mut">DRAWDOWN GUARD N\/A（未評価）/);
 assert.doesNotMatch(context.portfolioXrayPanel(),/DRAWDOWN GUARD 0.0%/);
});

test('X-RAY: zero positions and no assessed numeric stops display unknown risk',()=>{
 const context={...format,xrayGuidance:()=> '確認'};vm.runInNewContext(block('portfolioXraySnapshot','xrayQuoteQuality')+block('portfolioXrayPanel','positionSummaryHtml'),context);
 for(const positions of [[],[{ticker:'A',shares:1,price:100,role:'core'}]]){
  const x=context.portfolioXraySnapshot({positions,settings:{usdJpy:150},cash:{jpy:0,usd:0}});x.rows.forEach(r=>r.quality={cls:'mut',label:'fixture'});context.portfolioXrayMetrics=()=>x;
  assert.match(context.portfolioXrayPanel(),/STOP参考損失<\/small><b class="">N\/A/);
  assert.match(context.portfolioXrayPanel(),/未評価/);
 }
});

test('operations: readiness is display-only and missing inputs are never assessed',()=>{
 const context={};vm.runInNewContext(block('hasActiveHoldings','renderOps'),context);
 for(const state of [{},{positions:[]},{positions:[{shares:0}]},{positions:[{shares:null}]}])assert.equal(context.hasActiveHoldings(state),false);
 const state={positions:[{shares:1,price:100,currency:'USD'}],settings:{usdJpy:150}};
 assert.equal(context.opsDisplayState(state).healthReady,true);state.positions[0].price=null;assert.equal(context.opsDisplayState(state).valuationReady,false);assert.equal(context.opsDisplayState(state).healthReady,false);
 state.positions[0].price=100;state.positions[0].currency='EUR';assert.equal(context.opsDisplayState(state).valuationReady,false);state.positions[0].currency='USD';state.settings.usdJpy=null;assert.equal(context.opsDisplayState(state).valuationReady,true);assert.equal(context.opsDisplayState(state).healthReady,false);
 const source=block('renderOps','roll');assert.match(source,/if\(healthReady\|\|valuationReady\)requestAnimationFrame/);assert.match(source,/保有・価格データ未評価/);assert.match(source,/安全性・利益の確率ではありません/);
 assert.match(source,/healthNode\?\.isConnected/);assert.match(source,/roll\(healthNode,C.health/);assert.match(source,/roll\(pnlNode,C.pnl/);assert.doesNotMatch(source,/roll\(\$\('#healthnum'\)/);
 assert.match(block('voiceBrief','setConcl'),/保有未登録のため、保有の健全度・損益は未評価/);
});
