'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OfficialRiskNews, parseFeed, FEED_URL } = require('../official-risk-news');
const now = Date.parse('2026-10-30T02:00:00Z');
const item = (title = 'Policy &amp; economy', date = 'Thu, 29 Oct 2026 14:00:00 GMT', url = 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261029a.htm') => `<item><title>${title}</title><link>${url}</link><pubDate>${date}</pubDate></item>`;
const feed = (...items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items.join('')}</channel></rss>`;
const response = xml => new Response(xml, { headers: { 'content-type': 'text/xml' } });

test('official titles, dates and attribution only; no guessed impact', () => {
  const rows = parseFeed(feed(item()), now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Policy & economy');
  assert.equal(rows[0].publishedAt, '2026-10-29T14:00:00.000Z');
  assert.match(rows[0].licenseUrl, /disclaimer/);
  assert.equal(rows[0].score, undefined);
});
test('invalid dates, future dates and nonofficial links excluded; duplicates removed', () => {
  assert.equal(parseFeed(feed(item(), item(), item('bad', 'nonsense'), item('bad', 'Mon, 30 Feb 2026 14:00:00 GMT'), item('bad', '2026-10-29'), item('bad', 'Thu, 29 Oct 2027 14:00:00 GMT'), item('bad', undefined, 'https://www.federalreserve.gov.evil.test/newsevents/pressreleases/x.htm')), now).length, 1);
});
test('reject malformed XML, DTD, invalid entities and oversized feeds', () => {
  for (const xml of ['<rss><channel></rss>', '<rss/>junk', '<!DOCTYPE rss><rss/>', feed(item('&evil;')), '<rss>' + 'x'.repeat(600000) + '</rss>']) assert.throws(() => parseFeed(xml, now));
  assert.equal(parseFeed(feed(item('<![CDATA[Policy decision]]>')), now)[0].title, 'Policy decision');
});
test('single flight, fixed endpoint, cached result and isolated caller records', async () => {
  let calls = 0;
  const service = new OfficialRiskNews({ now: () => now, fetchImpl: async (url, options) => { calls++; assert.equal(url, FEED_URL); assert.equal(options.redirect, 'error'); return response(feed(item())); } });
  const [a, b] = await Promise.all([service.get(), service.get()]);
  assert.equal(calls, 1); assert.equal(a.status, 'ok'); assert.equal(b.affectsRiskScore, false);
  a.items[0].title = 'tampered';
  const c = await service.get();
  assert.equal(calls, 1); assert.equal(c.items[0].title, 'Policy & economy');
  assert.equal(c.items[0].fetchedAt, '2026-10-30T02:00:00.000Z');
});
test('failed refresh preserves old fetchedAt and marks stale; expired fallback unavailable', async () => {
  let time = now, fail = false, calls = 0;
  const service = new OfficialRiskNews({ now: () => time, ttlMs: 100, retryMs: 20, staleMs: 300, fetchImpl: async () => { calls++; if (fail) throw new Error('network'); return response(feed(item())); } });
  const first = await service.get(); fail = true; time += 101;
  const stale = await service.get();
  assert.equal(stale.status, 'stale'); assert.equal(stale.stale, true); assert.equal(stale.fetchedAt, first.fetchedAt);
  await service.get(); assert.equal(calls, 2);
  time += 300; const expired = await service.get(); assert.equal(expired.status, 'unavailable'); assert.deepEqual(expired.items, []); assert.equal(expired.fetchedAt, null);
});
test('timeout, non-OK response, redirect URL and oversized body fail closed', async () => {
  for (const fetchImpl of [async () => new Promise(() => {}), async () => new Response('error', { status: 500 }), async () => ({ ok: true, url: 'https://evil.test/' }), async () => response('x'.repeat(600000))]) {
    const service = new OfficialRiskNews({ now: () => now, timeoutMs: 10, fetchImpl });
    assert.equal((await service.get()).status, 'unavailable');
  }
});
test('bounded parser rejects extreme depth, token count and item count', () => {
  assert.throws(() => parseFeed('<rss><channel>' + '<x>'.repeat(63) + '</x>'.repeat(63) + '</channel></rss>', now), /feed_too_deep/);
  assert.throws(() => parseFeed('<rss><channel>' + '<x/>'.repeat(20000) + '</channel></rss>', now), /feed_too_complex/);
  assert.throws(() => parseFeed(feed(...Array.from({length:1001},()=>item())), now), /feed_too_many_items/);
});
test('XML entities decode once while CDATA stays literal and fragment spaces survive', () => {
  assert.equal(parseFeed(feed(item('Policy &amp;lt;review&amp;gt; &amp;amp; economy')), now)[0].title, 'Policy &lt;review&gt; &amp; economy');
  assert.equal(parseFeed(feed(item('<![CDATA[Policy &amp; economy <unchanged>]]>')), now)[0].title, 'Policy &amp; economy <unchanged>');
  assert.equal(parseFeed(feed(item('Policy <![CDATA[&amp; literal]]> &amp; economy')), now)[0].title, 'Policy &amp; literal & economy');
  assert.equal(parseFeed(feed(item('Policy &#38;lt;review&#38;gt;')), now)[0].title, 'Policy &lt;review&gt;');
});
