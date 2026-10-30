'use strict';

// The Board permits redistribution of its public-domain information with attribution.
// Do not fetch third-party articles, logos, images, or user-supplied URLs.
const FEED_URL = 'https://www.federalreserve.gov/feeds/press_monetary.xml';
const SOURCE_URL = 'https://www.federalreserve.gov/feeds/feeds.htm';
const LICENSE_URL = 'https://www.federalreserve.gov/disclaimer.htm';
const SOURCE = 'Board of Governors of the Federal Reserve System';
const MAX_BYTES = 512 * 1024;
const MAX_DEPTH = 64;
const MAX_TOKENS = 20000;
const MAX_ITEMS = 1000;

function decodeText(raw) {
  return raw.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (!entity.startsWith('#')) return named[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

// A deliberately small, non-expanding RSS reader. Reject malformed XML and all DTDs;
// only direct title/link/pubDate text in RSS items is collected, never HTML markup.
function parseFeed(xml, now = Date.now()) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('invalid_feed');
  const tokens = xml.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g) || [];
  if (tokens.length > MAX_TOKENS) throw new Error('feed_too_complex');
  if (tokens.join('') !== xml) throw new Error('invalid_xml');
  const stack = [], items = [];
  let item = null, rootCount = 0;
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!--')) continue;
    if (token.startsWith('<![CDATA[')) {
      if (!stack.length) throw new Error('invalid_xml');
      if (item && stack.length === 4 && ['title', 'link', 'pubDate'].includes(stack[3])) item[stack[3]] += token.slice(9, -3);
      continue;
    }
    if (token.startsWith('<')) {
      const end = /^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(token);
      if (end) {
        if (stack.pop() !== end[1]) throw new Error('invalid_xml');
        if (end[1] === 'item' && stack.length === 2 && stack[0] === 'rss' && stack[1] === 'channel') {
          if (items.length >= MAX_ITEMS) throw new Error('feed_too_many_items');
          items.push(item); item = null;
        }
        continue;
      }
      const start = /^<([A-Za-z_][\w:.-]*)(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*(\/?)>$/.exec(token);
      if (!start) throw new Error('invalid_xml');
      if (!stack.length && (++rootCount !== 1 || start[1] !== 'rss')) throw new Error('invalid_rss');
      if (!start[2]) {
        if (stack.length >= MAX_DEPTH) throw new Error('feed_too_deep');
        stack.push(start[1]);
        if (stack.length === 3 && stack[0] === 'rss' && stack[1] === 'channel' && stack[2] === 'item') item = { title: '', link: '', pubDate: '' };
      }
      continue;
    }
    if (!stack.length && token.trim()) throw new Error('invalid_xml');
    if (/&(?!#x[0-9a-f]+;|#\d+;|amp;|lt;|gt;|quot;|apos;)/i.test(token)) throw new Error('invalid_entity');
    if (item && stack.length === 4 && ['title', 'link', 'pubDate'].includes(stack[3])) item[stack[3]] += decodeText(token);
  }
  if (stack.length || rootCount !== 1) throw new Error('invalid_xml');
  const seen = new Set();
  return items.flatMap(item => {
    // Ordinary XML text has been decoded exactly once; CDATA is literal.
    // Normalize whitespace only after joining fragments so boundaries survive.
    const plainText = value => value.replace(/\s+/g, ' ').trim();
    const title = plainText(item.title).slice(0, 500), link = plainText(item.link), date = plainText(item.pubDate);
    // Require a timezone; date-only strings must never become midnight pseudo-timestamps.
    if (!title || !/(?:GMT|UTC|[+-]\d{4}|Z|[+-]\d{2}:\d{2})$/i.test(date)) return [];
    const rfc = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(GMT|UTC|[+-]\d{4})$/i.exec(date);
    const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i.exec(date);
    if (!rfc && !iso) return [];
    const year = Number(rfc ? rfc[3] : iso[1]), month = rfc ? 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ').indexOf(rfc[2].toLowerCase()) + 1 : Number(iso[2]), day = Number(rfc ? rfc[1] : iso[3]);
    const hour = Number((rfc || iso)[4]), minute = Number((rfc || iso)[5]), second = Number((rfc || iso)[6] || 0);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (year < 1900 || month < 1 || month > 12 || day < 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return [];
    const timestamp = Date.parse(date);
    if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60 * 1000) return [];
    let url;
    try { url = new URL(link); } catch { return []; }
    if (url.protocol !== 'https:' || url.hostname !== 'www.federalreserve.gov' || url.port || url.username || url.password || !url.pathname.startsWith('/newsevents/pressreleases/')) return [];
    url.hash = '';
    if (seen.has(url.href)) return [];
    seen.add(url.href);
    return [{ title, url: url.href, publishedAt: new Date(timestamp).toISOString(), source: SOURCE, sourceUrl: SOURCE_URL, license: 'public-domain-unless-otherwise-indicated', licenseUrl: LICENSE_URL }];
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 12);
}

async function boundedText(response, signal) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw new Error('feed_too_large');
  if (!response.body?.getReader) throw new Error('stream_unavailable');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('timeout');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('feed_too_large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

class OfficialRiskNews {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, ttlMs = 15 * 60 * 1000, timeoutMs = 6000, retryMs = 60 * 1000, staleMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    Object.assign(this, { fetchImpl, now, ttlMs, timeoutMs, retryMs, staleMs });
    this.cache = null;
    this.lastFailureAt = null;
    this.inFlight = null;
  }
  snapshot(status, error = null) {
    const usable = this.cache && this.now() - this.cache.at <= this.staleMs;
    return { status, stale: status === 'stale', fetchedAt: usable ? new Date(this.cache.at).toISOString() : null,
      retrievedAt: usable ? new Date(this.cache.at).toISOString() : null, checkedAt: new Date(this.now()).toISOString(), items: usable ? this.cache.items.map(item => ({ ...item, fetchedAt: new Date(this.cache.at).toISOString() })) : [],
      source: SOURCE, sourceUrl: SOURCE_URL, feedUrl: FEED_URL, licenseUrl: LICENSE_URL,
      coverage: 'Federal Reserve monetary policy releases only; not a complete market-news feed',
      assessment: 'not-assessed', affectsRiskScore: false, error };
  }
  get() {
    if (this.inFlight) return this.inFlight;
    if (this.lastFailureAt !== null && this.now() - this.lastFailureAt < this.retryMs) return Promise.resolve(this.snapshot(this.cache && this.now() - this.cache.at <= this.staleMs ? 'stale' : 'unavailable', 'fetch_failed'));
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return Promise.resolve(this.snapshot('ok'));
    this.inFlight = this.refresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async refresh() {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.timeoutMs); });
    try {
      const items = await Promise.race([timeout, (async () => {
        const response = await this.fetchImpl(FEED_URL, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
        if (!response.ok || (response.url && response.url !== FEED_URL)) throw new Error('invalid_response');
        const rows = parseFeed(await boundedText(response, controller.signal), this.now());
        if (!rows.length) throw new Error('no_valid_items');
        return rows;
      })()]);
      this.cache = { at: this.now(), items };
      this.lastFailureAt = null;
      return this.snapshot('ok');
    } catch (_) {
      this.lastFailureAt = this.now();
      return this.snapshot(this.cache && this.now() - this.cache.at <= this.staleMs ? 'stale' : 'unavailable', 'fetch_failed');
    } finally { clearTimeout(timer); }
  }
}

module.exports = { OfficialRiskNews, parseFeed, FEED_URL };
