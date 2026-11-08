'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildPeerComparisons}=require('../peer-comparison');
// Synthetic software-test data only. Never used as a live data fallback.
function fixture() {
  const histories=new Map(),results=[];
  for(const [j,symbol] of ['AAA','BBB','CCC','DDD'].entries()) {
    const bars=[];let close=100;
    for(let d=new Date('2026-10-01T21:00:00Z');bars.length<21;d.setUTCDate(d.getUTCDate()+1)) {
      if([0,6].includes(d.getUTCDay()))continue;
      close*=1+(.001*(j+1))+.0001*(bars.length%4);
      bars.push({sessionDate:d.toISOString().slice(0,10),timestamp:d.getTime()/1000,close,priceMode:'adjusted'});
    }
    histories.set(symbol,{bars,source:'synthetic-tests-only',currency:'USD',interval:'1d',priceMode:'adjusted',status:'ok',ohlcCoveragePct:100});
    results.push({symbol,status:'partial',asOf:bars.at(-1).sessionDate,leverageStatus:'unleveraged',quality:{adjusted:true},indicators:{daily:{status:'ok',asOf:bars.at(-1).sessionDate,price:bars.at(-1).close,rsi14:55+j,macd:{histogram:.2}}}});
  }
  return {results,histories,groups:[{id:'explicit-test',label:'Test group',symbols:['AAA','BBB','CCC','ZZZ']}],nowMs:Date.parse(histories.get('AAA').bars.at(-1).sessionDate+'T22:00:00Z')};
}
test('pure explicit peer comparison uses aligned adjusted daily observations without forecasting',()=>{
 const f=fixture(),before=JSON.stringify([...f.histories]);const out=buildPeerComparisons(f).get('AAA');
 assert.equal(out.status,'ok');assert.equal(out.peers.length,2);assert.equal(out.scope.alignedPeers,2);assert.equal(out.period.closes,21);assert.equal(out.period.returns,20);assert.equal(out.analysisOnly,true);assert.equal(out.tradeEligible,false);
 assert.equal(out.peerMedianReturn20Pct,(out.peers[0].return20Pct+out.peers[1].return20Pct)/2);
 assert.equal(out.relativeReturn20Pp,out.self.return20Pct-out.peerMedianReturn20Pct);
 assert.ok(out.relativeReturn20Pp<0);assert.equal(out.peers[0].correlation20,1);
 assert.equal(out.excluded[0].symbol,'ZZZ');assert.equal(out.excluded[0].reasonCode,'not_requested');
 assert.equal(out.self.retrievedAt,null);assert.equal(JSON.stringify([...f.histories]),before);
 assert.equal(buildPeerComparisons(f).get('DDD').reasonCode,'no_explicit_group');
 for(const key of ['probability','targetPrice','score','winRate','forecast'])assert.ok(!Object.hasOwn(out,key));
 assert.ok(out.limitations.some(s=>s.includes('全米株')));
});
test('one usable peer remains partial and cannot produce a group median',()=>{
 const f=fixture();f.results=f.results.filter(r=>r.symbol!=='CCC');const out=buildPeerComparisons(f).get('AAA');
 assert.equal(out.status,'partial');assert.equal(out.peers.length,1);assert.equal(out.peerMedianReturn20Pct,null);assert.equal(out.relativeReturn20Pp,null);
});
test('gates block partial, stale, raw, mixed, incomplete, non-USD or leveraged evidence',()=>{
 const changes=[
  f=>{f.histories.get('AAA').partial=true},
  f=>{f.histories.get('AAA').stale=true},
  f=>{f.histories.get('AAA').cacheState='stale-fallback'},
  f=>{f.results[0].quality.stale=true},
  f=>{f.histories.get('AAA').priceMode='raw'},
  f=>{f.histories.get('AAA').bars[2].priceMode='raw'},
  f=>{f.histories.get('AAA').containsOpenSession=true},
  f=>{f.histories.get('AAA').currency='JPY'},
  f=>{f.results[0].leverageStatus='unavailable'},
  f=>{f.results[0].leveragedProduct=true},
  f=>{f.histories.get('AAA').ohlcCoveragePct=99},
  f=>{f.histories.get('AAA').source=null},
  f=>{f.histories.get('AAA').interval='1wk'},
  f=>{f.results[0].status='unavailable'},
 ];
 for(const change of changes){const f=fixture();change(f);const r=buildPeerComparisons(f).get('AAA');assert.equal(r.status,'unavailable');assert.equal(r.self,null);assert.equal(r.peers.length,0);assert.ok(r.reasonCode);}
});
test('malformed dates, duplicate observations, invalid prices and indicators are not repaired',()=>{
 const changes=[
  f=>{f.histories.get('AAA').bars[1].sessionDate=f.histories.get('AAA').bars[0].sessionDate},
  f=>{f.histories.get('AAA').bars[1].sessionDate='2026-02-31'},
  f=>{f.histories.get('AAA').bars[1].timestamp=-1e99},
  f=>{f.histories.get('AAA').bars[1].close='100'},
  f=>{f.histories.get('AAA').bars[1].close=NaN},
  f=>{f.histories.get('AAA').bars[1].close=0},
  f=>{f.results[0].indicators.daily.rsi14=null},
  f=>{f.results[0].indicators.daily.macd.histogram=Infinity},
  f=>{f.results[0].indicators.daily.price+=1},
  f=>{f.results[0].indicators.daily.asOf='2026-10-01'},
  f=>{f.histories.get('AAA').retrievedAt='invalid'},
  f=>{f.histories.get('AAA').retrievedAt=new Date(f.nowMs+1000).toISOString()},
 ];
 for(const change of changes){const f=fixture();change(f);const r=buildPeerComparisons(f).get('AAA');assert.equal(r.status,'unavailable');assert.equal(r.self,null);}
});
test('peer windows require every date to match, not just endpoint or an intersected subset',()=>{
 const f=fixture();const b=f.histories.get('BBB').bars[0];b.sessionDate='2026-09-30';b.timestamp=Date.parse(b.sessionDate+'T21:00:00Z')/1000;
 const r=buildPeerComparisons(f).get('AAA');assert.equal(r.peers.length,1);assert.equal(r.excluded.find(p=>p.symbol==='BBB').reasonCode,'unaligned_dates');assert.equal(r.peerMedianReturn20Pct,null);
});
test('stale endpoints and open sessions are suppressed without a guessed latest session',()=>{
 for(const shift of [5*86400000,-2*3600000]){const f=fixture();f.nowMs+=shift;assert.ok(['endpoint_not_current','invalid_timestamp'].includes(buildPeerComparisons(f).get('AAA').reasonCode));}
});
test('flat return series has undefined correlation, not a zero value or invented similarity',()=>{
 const f=fixture();f.histories.get('BBB').bars.forEach(b=>b.close=100);f.results[1].indicators.daily.price=100;
 const r=buildPeerComparisons(f).get('AAA').peers.find(p=>p.symbol==='BBB');assert.equal(r.correlation20,null);assert.equal(r.correlationStatus,'zero_variance');
});
test('explicit groups are deduplicated and absent inputs remain safe',()=>{
 const f=fixture();f.groups.push({...f.groups[0],id:'second'});f.groups[0].symbols.push('BBB');assert.equal(buildPeerComparisons(f).get('AAA').peers.length,2);
 assert.equal(buildPeerComparisons().size,0);assert.equal(buildPeerComparisons({results:null,groups:null}).size,0);
 assert.equal(buildPeerComparisons({...f,histories:null}).get('AAA').reasonCode,'missing_data');
});

test('arithmetic overflow is suppressed instead of emitting infinity',()=>{
 const f=fixture();f.histories.get('AAA').bars[0].close=Number.MIN_VALUE;
 const r=buildPeerComparisons(f).get('AAA');assert.equal(r.reasonCode,'numeric_overflow');assert.equal(r.self,null);
});
