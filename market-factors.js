/* Display-only, editorial evidence balance. No forecast or execution connection. */
(function(root) {
'use strict';
const CATEGORIES = [ ['price','価格・変動率'], ['inflation','インフレ'], ['policy','金融政策・景気'], ['labor','雇用'], ['earnings','企業業績・資金調達'], ['credit','信用・流動性'], ['flows','ポジション・需給'] ];
const METHOD = 'evidence-balance-v1';
function validTime(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s) && Number.isFinite(Date.parse(s)); }
function sourceUrl(s) {try {const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password&&['www.bls.gov','www.federalreserve.gov','www.dol.gov','www.sec.gov'].includes(u.hostname)?u.href:null;}catch(_){return null;}}
function evaluate(evidence, price, now=Date.now()) {
 const rejected=[], seen=new Set(), accepted=[];
 for(const row of Array.isArray(evidence)?evidence:[]) {
  const key=row?.eventId;
  const valid=row && typeof key==='string' && CATEGORIES.some(([id])=>id===row.category) && row.category!=='price' && sourceUrl(row.url) &&
   validTime(row.publishedAt) && validTime(row.retrievedAt) && validTime(row.expiresAt) && Date.parse(row.publishedAt)<=Date.parse(row.retrievedAt) && Date.parse(row.retrievedAt)<=now && Date.parse(row.publishedAt)<=now && Date.parse(row.expiresAt)>now &&
   Date.parse(row.expiresAt)>Date.parse(row.retrievedAt) && typeof row.title==='string' && typeof row.fact==='string' && typeof row.counter==='string' && typeof row.targetPeriod==='string' &&
   [0,1].includes(row.support) && [0,1].includes(row.pressure) && row.verified===true;
  if(!valid || seen.has(key)) { rejected.push({title:row?.title||'資料',reason:seen.has(key)?'同じ事象の重複を除外':'期限切れ・日時・出典・根拠の未確認'});continue; }
  seen.add(key); accepted.push({...row,url:sourceUrl(row.url)});
 }
 if(price?.eligible===true && typeof price.asOf==='string' && typeof price.baselineDate==='string' && Number.isFinite(price.spy) && Number.isFinite(price.vix)) {
  const support=price.spy>0&&price.vix<=0?1:0,pressure=price.spy<0&&price.vix>=0?1:0;
  accepted.push({eventId:'daily-price-'+price.asOf,category:'price',title:'株価と予想変動率の同日確認',fact:`SPY ${price.spy.toFixed(2)}%、VIX ${price.vix.toFixed(2)}%（前営業日比）`,support,pressure,targetPeriod:price.baselineDate+' → '+price.asOf,publishedAt:null,retrievedAt:price.retrievedAt,expiresAt:null,url:'https://finance.yahoo.com/',counter:'価格反応であり原因ではありません。反対方向への転換で評価を見直します。',channel:'価格確認',verified:true});
 }
 const groups=CATEGORIES.map(([id,label])=>{const rows=accepted.filter(r=>r.category===id);return{id,label,rows,known:rows.length>0,support:rows.length?Math.min(1,rows.reduce((s,r)=>s+r.support,0)):null,pressure:rows.length?Math.min(1,rows.reduce((s,r)=>s+r.pressure,0)):null};});
 const covered=groups.filter(g=>g.known).length, support=groups.reduce((s,g)=>s+(g.support??0),0),pressure=groups.reduce((s,g)=>s+(g.pressure??0),0),net=covered?support-pressure:null;
 return{method:METHOD,groups,rejected,covered,total:groups.length,support:covered?support:null,pressure:covered?pressure:null,net,complete:covered===groups.length,headline:!covered?'判断保留：有効な根拠がありません':net>0?'確認できた範囲は支援材料優勢':net<0?'確認できた範囲は圧迫材料優勢':'確認できた範囲は拮抗',shortTerm:net>0?'価格の上昇継続を確認してから判断。好材料だけで高値を追わない。':net<0?'新規買いを急ぐ根拠は弱い。悪材料の後退と価格の持ち直しを確認。':'方向を決め打ちせず、次の公表値と価格反応を待つ。',longTerm:'企業別の売上・利益・キャッシュフロー・設備投資・希薄化・評価倍率の一次照合が必要。この市場点数から長期目標株価は算出しません。'};
}
root.MarketFactors={evaluate,CATEGORIES,METHOD};
if(typeof module==='object'&&module.exports)module.exports=root.MarketFactors;
})(typeof globalThis!=='undefined'?globalThis:this);
