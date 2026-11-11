'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createApp}=require('../server');
test('official Treasury read route preserves status, nulls and no-store',async()=>{
 for(const status of ['fresh','stale','unavailable']){
  const payload={status,latest:{date:'2026-11-10',yieldPct:status==='unavailable'?null:4.98},previous:null,changeBps:null,retrievedAt:null};
  const {app}=createApp({env:{},treasuryRates:{get:async()=>payload}});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/treasury-yield`);assert.equal(r.status,status==='unavailable'?503:200);assert.equal(r.headers.get('cache-control'),'no-store');const body=await r.json();assert.equal(typeof body.requestId,'string');delete body.requestId;assert.deepEqual(body,payload);}finally{await new Promise(resolve=>server.close(resolve));}
 }
});
