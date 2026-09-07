'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { astraEvidence } = require('../astra-bridge');
const { safeErrorKind } = require('../server');

test('server diagnostic errors cannot expose provider credentials or arbitrary names', () => {
  const error = new Error('Authorization: Bearer secret-test-key');
  assert.equal(safeErrorKind(error), 'Error');
  error.name = 'secret-test-key';
  assert.equal(safeErrorKind(error), 'Error');
  assert.equal(safeErrorKind(new TypeError('secret-test-key')), 'TypeError');
  assert.equal(safeErrorKind(null), 'Error');
});

test('Astra adapter reuses legacy data and preserves observation time and missing fields', async () => {
  const calls = [];
  const at = '2026-07-10T20:00:00.000Z';
  const service = {
    clock: () => 10,
    getSnapshot: async symbols => { calls.push(symbols); return {quotes: {MU: {price:100,at}}, at}; },
    getBuySignals: async ({symbols}) => ({results:symbols.map(ticker => ({ticker, dataStatus:'partial'}))}),
    getThemeIntelligence: async () => ({themes:[{id:'hbm',score:null}]}),
    getMarketRegime: async () => ({status:'unavailable'}),
    _getTechnicalHistories: async () => new Map([['MU',{bars:[{at,close:100}],status:'partial',priceMode:'raw'}]]),
    technicalFinnhubCache: new Map()
  };
  const result = await astraEvidence(service,['MU'],new AbortController().signal);
  assert.equal(calls.length,1);
  assert.ok(calls[0].includes('^VIX') && calls[0].includes('CL=F') && calls[0].includes('JPY=X'));
  assert.equal(result.quotes[0].at,at);
  assert.equal(result.quotes[0].symbol,'MU');
  assert.equal(result.quotes[0].bid,undefined);
  assert.equal(result.buy_signals[0].dataStatus,'partial');
  assert.deepEqual(result.news.MU,[]);
  assert.equal(result.provenance.actual_fund_flow,false);
});

test('Astra adapter upstream failures return unavailable without fake values', async () => {
  const fail = async () => {throw new Error('offline');};
  const result = await astraEvidence({clock:()=>0,getSnapshot:fail,getBuySignals:fail,getThemeIntelligence:fail,getMarketRegime:fail,_getTechnicalHistories:fail},['MU']);
  assert.equal(result.status,'unavailable');
  assert.deepEqual(result.quotes,[]);
  assert.equal(result.histories.MU.status,'unavailable');
});

test('legacy service worker does not cache Astra navigation as the legacy app', () => {
  const sw = fs.readFileSync(require.resolve('../sw.js'),'utf8');
  assert.match(sw,/astra/);
  const index = fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(index,/href="\/astra\/"/);
});
