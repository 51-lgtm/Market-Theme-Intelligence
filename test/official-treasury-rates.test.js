'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OfficialTreasuryRates, TreasuryYieldService, parseTreasuryFeed, annualFeedUrl } = require('../official-treasury-rates');
const NOW = Date.parse('2026-11-12T06:00:00Z');
const HOUR = 60 * 60 * 1000;
const namespaces = 'xmlns="http://www.w3.org/2005/Atom" xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"';
const feed = (...rows) => `<?xml version="1.0" encoding="utf-8"?><feed ${namespaces}>${rows.join('')}</feed>`;
const row = (date = '2026-11-10', value = '4.98', customField = null) => `<entry><id>not-an-ordering-key</id><content type="application/xml"><m:properties><d:NEW_DATE m:type="Edm.DateTime">${date}T00:00:00</d:NEW_DATE>${customField ?? `<d:BC_10YEAR m:type="Edm.Double">${value}</d:BC_10YEAR>`}</m:properties></content></entry>`;
const goodFeed = () => feed(row('2026-11-09', '4.88'), row('2026-11-10', '4.98'));
const response = (xml = goodFeed()) => new Response(xml, { headers: { 'content-type': 'text/xml; charset=UTF-8' } });

test('annual URL has a fixed official host, path and bounded integer year', () => {
  assert.equal(annualFeedUrl(2026), 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=2026');
  for (const value of ['2026', 'https://evil.test', 2026.1, 0, 10000, NaN]) assert.throws(() => annualFeedUrl(value));
  assert.equal(TreasuryYieldService, OfficialTreasuryRates);
});

test('parser sorts actual observation dates and keeps yield percentages unscaled', () => {
  const rows = parseTreasuryFeed(feed(row('2026-11-10', '4.98'), row('2026-11-06', '4.86'), row('2026-11-09', '4.88')), NOW, 2026);
  assert.deepEqual(rows, [{ date: '2026-11-10', yieldPct: 4.98 }, { date: '2026-11-09', yieldPct: 4.88 }, { date: '2026-11-06', yieldPct: 4.86 }]);
  assert.equal(rows[0].publishedAt, undefined);
});

test('missing, blank and explicit null latest fields never silently select an older day or become zero', () => {
  for (const field of ['', '<d:BC_10YEAR/>', '<d:BC_10YEAR> </d:BC_10YEAR>', '<d:BC_10YEAR m:null="true"/>', '<d:BC_10YEAR m:null="1"/>']) {
    const rows = parseTreasuryFeed(feed(row('2026-11-09', '4.88'), row('2026-11-10', '', field)), NOW);
    assert.deepEqual(rows[0], { date: '2026-11-10', yieldPct: null });
    assert.equal(rows[1].yieldPct, 4.88);
  }
  assert.equal(parseTreasuryFeed(feed(row('2026-11-10', '0.00')), NOW)[0].yieldPct, 0);
  assert.equal(parseTreasuryFeed(feed(row('2026-11-10', '-0.01')), NOW)[0].yieldPct, -0.01);
});

test('malformed yields fail closed rather than hiding a possibly newer observation', () => {
  for (const value of ['N/A', 'NaN', 'Infinity', '4.98junk', '4,98', '4.98%', '4e0', '0x4', '1 2', '+4.98', '04.98', '.98', '101', '-101']) {
    assert.throws(() => parseTreasuryFeed(feed(row('2026-11-09', '4.88'), row('2026-11-10', value)), NOW), /invalid_yield/);
  }
  assert.throws(() => parseTreasuryFeed(feed(row(undefined, '', '<d:BC_10YEAR m:null="true">4.98</d:BC_10YEAR>')), NOW), /invalid_null_value/);
  assert.throws(() => parseTreasuryFeed(feed(row(undefined, '', '<d:BC_10YEAR m:null="yes"/>')), NOW), /invalid_null_marker/);
});

test('dates must be real calendar dates, not future, and match the requested annual period', () => {
  for (const date of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-00-01', '2026-11-00', '2026-1-10', '2026-11-13', '1900-02-29', '2026-11-10junk']) assert.throws(() => parseTreasuryFeed(feed(row(date)), NOW), /invalid_observation_date/);
  assert.throws(() => parseTreasuryFeed(feed(row('2025-11-10')), NOW, 2026), /invalid_observation_date/);
  assert.equal(parseTreasuryFeed(feed(row('2024-02-29')), NOW)[0].date, '2024-02-29');
  assert.throws(() => parseTreasuryFeed(feed(row().replace('T00:00:00', 'T12:00:00')), NOW), /invalid_observation_date/);
  assert.throws(() => parseTreasuryFeed(feed(row().replace(/<d:NEW_DATE[^>]*>[^<]*<\/d:NEW_DATE>/, '')), NOW), /missing_observation_date/);
});

test('namespace-aware fields, duplicate rows, conflicting dates and duplicate properties', () => {
  const renamed = goodFeed().replaceAll('xmlns:d=', 'xmlns:values=').replaceAll('<d:', '<values:').replaceAll('</d:', '</values:');
  assert.equal(parseTreasuryFeed(renamed, NOW)[0].yieldPct, 4.98);
  assert.equal(parseTreasuryFeed(feed(row(), row()), NOW).length, 1);
  assert.throws(() => parseTreasuryFeed(feed(row(), row('2026-11-10', '4.99')), NOW), /conflicting_observations/);
  assert.throws(() => parseTreasuryFeed(feed(row().replace('</m:properties>', '<d:BC_10YEAR>9.99</d:BC_10YEAR></m:properties>')), NOW), /duplicate_field/);
  assert.throws(() => parseTreasuryFeed(goodFeed().replace('http://schemas.microsoft.com/ado/2007/08/dataservices/metadata', 'https://evil.test'), NOW), /missing_observation_date/);
  assert.equal(parseTreasuryFeed(feed(row().replace('<d:BC_10YEAR', '<x:BC_10YEAR xmlns:x="https://evil.test"').replace('</d:BC_10YEAR>', '</x:BC_10YEAR>')), NOW)[0].yieldPct, null);
});

test('bounded XML parser rejects malformed structure, external entities and complexity', () => {
  for (const xml of ['<feed/>', goodFeed() + 'junk', goodFeed() + goodFeed(), '<!DOCTYPE feed>' + goodFeed(), '<!ENTITY a SYSTEM "file:///secret">' + goodFeed(), goodFeed().replace('4.98', '&evil;'), goodFeed().replace('4.98', '&#0;'), goodFeed().replace('</entry>', '</wrong>'), goodFeed().replace('4.98', '4<x/>.98'), goodFeed().replace('m:type="Edm.Double"', 'm:type="Edm.Double" m:type="Edm.Double"')]) assert.throws(() => parseTreasuryFeed(xml, NOW));
  assert.throws(() => parseTreasuryFeed(feed('x'.repeat(1024 * 1024)), NOW), /invalid_feed/);
  assert.throws(() => parseTreasuryFeed(feed('<x>'.repeat(32) + '</x>'.repeat(32)), NOW), /feed_too_deep/);
  assert.throws(() => parseTreasuryFeed(feed('<x/>'.repeat(60000)), NOW), /feed_too_complex/);
  assert.throws(() => parseTreasuryFeed(feed(...Array.from({ length: 401 }, () => row())), NOW), /feed_too_many_entries/);
  assert.equal(parseTreasuryFeed(goodFeed().replace('4.98', '<![CDATA[4.98]]>'), NOW)[0].yieldPct, 4.98);
  assert.equal(parseTreasuryFeed(goodFeed().replace('4.98', '4.&#57;8'), NOW)[0].yieldPct, 4.98);
});

test('one-hour cache, single flight, isolated concurrent records and explicit daily provenance', async () => {
  let calls = 0, now = NOW;
  const service = new OfficialTreasuryRates({ now: () => now, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, annualFeedUrl(2026));
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, undefined);
    return response();
  } });
  const [a, b] = await Promise.all([service.get(), service.get()]);
  assert.equal(calls, 1); assert.equal(a.status, 'fresh'); assert.equal(a.stale, false);
  assert.equal(a.latest.date, '2026-11-10'); assert.equal(a.previous.date, '2026-11-09'); assert.equal(a.changeBps, 10);
  assert.equal(a.frequency, 'daily'); assert.equal(a.intraday, false); assert.equal(a.freshnessBasis, 'retrieval-time');
  assert.equal(a.calendarVerified, false); assert.equal(a.latestSessionVerified, false);
  assert.equal(a.fetchedAt, '2026-11-12T06:00:00.000Z'); assert.equal(a.retrievedAt, a.fetchedAt);
  assert.match(a.sourceUrl, /^https:\/\/home\.treasury\.gov\//); assert.equal(a.license, 'CC0-1.0');
  a.latest.yieldPct = 99; a.feedUrls.push('bad');
  assert.equal(b.latest.yieldPct, 4.98); assert.equal(b.feedUrls.length, 1);
  now += HOUR - 1;
  const cached = await service.get(); assert.equal(calls, 1); assert.equal(cached.latest.yieldPct, 4.98);
  now += 1;
  await service.get(); assert.equal(calls, 2);
});

test('change is basis points, handles decrease/unchanged and never skips a missing previous row', async () => {
  for (const [older, newer, expected] of [['4.88', '4.87', -1], ['4.88', '4.88', 0], ['', '4.98', null]]) {
    const service = new OfficialTreasuryRates({ now: () => NOW, fetchImpl: async () => response(feed(row('2026-11-06', '4.80'), row('2026-11-09', older), row('2026-11-10', newer))) });
    const result = await service.get();
    assert.equal(result.changeBps, expected); assert.equal(result.previous.date, '2026-11-09');
  }
});

test('a successful newer null publication replaces old data and remains unavailable on cache hits', async () => {
  let now = NOW, missing = false;
  const service = new OfficialTreasuryRates({ now: () => now, fetchImpl: async () => response(missing ? feed(row('2026-11-10', '4.98'), row('2026-11-12', '', '<d:BC_10YEAR m:null="true"/>')) : goodFeed()) });
  assert.equal((await service.get()).latest.yieldPct, 4.98);
  missing = true; now += HOUR;
  for (let index = 0; index < 2; index++) {
    const result = await service.get();
    assert.equal(result.status, 'unavailable'); assert.equal(result.error, 'latest_yield_missing');
    assert.deepEqual(result.latest, { date: '2026-11-12', yieldPct: null }); assert.equal(result.changeBps, null);
  }
});

test('year boundary retrieves at most current plus preceding annual feed using actual dates', async () => {
  for (const current of [feed(), feed(row('2026-01-02', '4.19'))]) {
    const calls = [], now = Date.parse('2026-01-02T23:00:00Z');
    const service = new OfficialTreasuryRates({ now: () => now, fetchImpl: async url => {
      calls.push(url);
      return response(url === annualFeedUrl(2026) ? current : feed(row('2025-12-30', '4.14'), row('2025-12-31', '4.18')));
    } });
    const result = await service.get();
    assert.deepEqual(calls, [annualFeedUrl(2026), annualFeedUrl(2025)]);
    assert.deepEqual(result.feedUrls, calls); assert.equal(result.status, 'fresh');
    if (current === feed()) { assert.equal(result.latest.date, '2025-12-31'); assert.equal(result.previous.date, '2025-12-30'); }
    else { assert.equal(result.latest.date, '2026-01-02'); assert.equal(result.previous.date, '2025-12-31'); assert.equal(result.changeBps, 1); }
  }
});

test('missing current-year row stays missing across the year boundary', async () => {
  const service = new OfficialTreasuryRates({ now: () => Date.parse('2026-01-02T23:00:00Z'), fetchImpl: async url => response(url === annualFeedUrl(2026) ? feed(row('2026-01-02', '')) : feed(row('2025-12-31', '4.18'))) });
  const result = await service.get();
  assert.equal(result.status, 'unavailable'); assert.equal(result.latest.date, '2026-01-02');
  assert.equal(result.previous.date, '2025-12-31'); assert.equal(result.changeBps, null);
});

test('HTTP refresh failure keeps original retrieval time, marks cache stale, backs off, then expires', async () => {
  let now = NOW, fail = false, calls = 0;
  const service = new OfficialTreasuryRates({ now: () => now, ttlMs: 100, retryMs: 20, staleMs: 300, fetchImpl: async () => { calls++; return fail ? new Response('unavailable', { status: 503 }) : response(); } });
  const first = await service.get(); fail = true; now += 101;
  const stale = await service.get();
  assert.equal(stale.status, 'stale'); assert.equal(stale.stale, true); assert.equal(stale.error, 'fetch_failed');
  assert.equal(stale.fetchedAt, first.fetchedAt); assert.deepEqual(stale.latest, first.latest);
  assert.notEqual(stale.checkedAt, first.checkedAt);
  await service.get(); assert.equal(calls, 2);
  now += 300;
  const expired = await service.get();
  assert.equal(expired.status, 'unavailable'); assert.equal(expired.latest, null); assert.equal(expired.previous, null); assert.equal(expired.changeBps, null); assert.equal(expired.retrievedAt, null);
});

test('failed refresh preserves cache for malformed or missing dated rows but not valid null rows', async () => {
  let now = NOW, xml = goodFeed();
  const service = new OfficialTreasuryRates({ now: () => now, fetchImpl: async () => response(xml) });
  await service.get(); now += HOUR;
  xml = feed(row('2026-02-30', '9.99'));
  const result = await service.get();
  assert.equal(result.status, 'stale'); assert.equal(result.latest.yieldPct, 4.98);
});

test('timeout, HTTP errors, redirect, MIME type, response size and UTF-8 errors fail closed', async () => {
  const cases = [
    async () => new Promise(() => {}),
    async () => new Response('forbidden', { status: 403 }),
    async () => ({ ok: true, url: 'https://evil.test/' }),
    async () => new Response(goodFeed(), { headers: { 'content-type': 'text/html' } }),
    async () => new Response(goodFeed(), { headers: { 'content-type': 'text/xml', 'content-length': '1048577' } }),
    async () => response('x'.repeat(1048577)),
    async () => new Response(new Uint8Array([0xc0, 0x80]), { headers: { 'content-type': 'text/xml' } }),
    async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/xml' }), body: null }),
    async () => response(feed()),
  ];
  for (const fetchImpl of cases) {
    const service = new OfficialTreasuryRates({ now: () => NOW, timeoutMs: 15, fetchImpl });
    const result = await service.get();
    assert.equal(result.status, 'unavailable'); assert.equal(result.error, 'fetch_failed'); assert.equal(result.latest, null);
  }
});

test('a stalled response stream is subject to the same request deadline', async () => {
  let cancelled = false;
  const service = new OfficialTreasuryRates({ now: () => NOW, timeoutMs: 15, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('<feed>')); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/xml' } }) });
  const result = await service.get();
  assert.equal(result.status, 'unavailable'); assert.equal(result.error, 'fetch_failed');
  assert.equal(cancelled, true);
});
