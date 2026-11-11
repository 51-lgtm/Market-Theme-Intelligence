'use strict';

// Public daily par yields, not intraday bond prices or an exchange-session clock.
// Only the documented Treasury annual XML endpoint is requested. No credentials,
// user URLs, scraped third-party data, or fallback providers are used.
const FEED_BASE = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml';
const SOURCE = 'U.S. Department of the Treasury';
const SOURCE_URL = 'https://home.treasury.gov/treasury-daily-interest-rate-xml-feed';
const METHODOLOGY_URL = 'https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics/treasury-yield-curve-methodology';
const LICENSE_URL = 'https://catalog.data.gov/dataset/interest-rate-statistics-daily-treasury-yield-curve-rates';
const ATOM = 'http://www.w3.org/2005/Atom';
const DATA = 'http://schemas.microsoft.com/ado/2007/08/dataservices';
const META = 'http://schemas.microsoft.com/ado/2007/08/dataservices/metadata';
const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_TOKENS = 60000;
const MAX_ENTRIES = 400;

function annualFeedUrl(year) {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new Error('invalid_year');
  return `${FEED_BASE}?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`;
}

function xmlText(text) {
  if (/&(?!#x[0-9a-fA-F]+;|#\d+;|amp;|lt;|gt;|quot;|apos;)/.test(text)) throw new Error('invalid_entity');
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity) => {
    if (!entity.startsWith('#')) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
    const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff))) throw new Error('invalid_entity');
    return String.fromCodePoint(code);
  });
}

function observationDate(raw, now, expectedYear) {
  // NEW_DATE is a date-valued Edm.DateTime. Its midnight is NOT a publication
  // timestamp and is never exposed as one or converted across time zones.
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0{1,7})?Z?)?$/.exec(raw);
  if (!match) throw new Error('invalid_observation_date');
  const [year, month, day] = match.slice(1).map(Number);
  const date = raw.slice(0, 10), parsed = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || month < 1 || month > 12 || day < 1 || parsed.getUTCDate() !== day ||
      (expectedYear !== null && year !== expectedYear) || date > new Date(now).toISOString().slice(0, 10)) throw new Error('invalid_observation_date');
  return date;
}

function observationYield(field) {
  if (!field) return null;
  const raw = field.text.trim(), nullFlag = field.attrs.get(`${META}|null`);
  if (nullFlag !== undefined && !['true', 'false', '1', '0'].includes(nullFlag)) throw new Error('invalid_null_marker');
  if (nullFlag === 'true' || nullFlag === '1') {
    if (raw) throw new Error('invalid_null_value');
    return null;
  }
  if (!raw) return null;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) throw new Error('invalid_yield');
  const value = Number(raw);
  if (!Number.isFinite(value) || value < -100 || value > 100) throw new Error('invalid_yield');
  return value === 0 ? 0 : value;
}

// Bounded, namespace-aware XML reader. No DTDs/entities are expanded and only
// direct Treasury properties of Atom entries can become observations. A bad
// row fails the fetch instead of silently hiding a possibly newer observation.
function parseTreasuryFeed(xml, now = Date.now(), expectedYear = null) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml) || !Number.isFinite(now)) throw new Error('invalid_feed');
  xml = xml.replace(/^\uFEFF/, '');
  const tokens = xml.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g) || [];
  if (tokens.length > MAX_TOKENS) throw new Error('feed_too_complex');
  if (tokens.join('') !== xml) throw new Error('invalid_xml');
  const stack = [], rows = [];
  let entry = null, rootCount = 0;
  const is = (frame, ns, local) => frame?.ns === ns && frame.local === local;
  function closeFrame() {
    const frame = stack.pop();
    if (frame.field) entry.fields.set(frame.local, frame);
    if (is(frame, ATOM, 'entry') && stack.length === 1) {
      if (entry.properties !== 1 || !entry.fields.has('NEW_DATE')) throw new Error('missing_observation_date');
      const dateField = entry.fields.get('NEW_DATE');
      if (['true', '1'].includes(dateField.attrs.get(`${META}|null`))) throw new Error('invalid_observation_date');
      rows.push({ date: observationDate(dateField.text.trim(), now, expectedYear), yieldPct: observationYield(entry.fields.get('BC_10YEAR')) });
      if (rows.length > MAX_ENTRIES) throw new Error('feed_too_many_entries');
      entry = null;
    }
  }
  for (const token of tokens) {
    if (token.startsWith('<!--')) {
      if (token.slice(4, -3).includes('--')) throw new Error('invalid_xml');
      continue;
    }
    if (token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) {
      if (!stack.length) throw new Error('invalid_xml');
      const frame = stack.at(-1);
      if (frame.field) frame.text += token.slice(9, -3);
      continue;
    }
    if (!token.startsWith('<')) {
      if (!stack.length && token.trim()) throw new Error('invalid_xml');
      if (token.includes(']]>')) throw new Error('invalid_xml');
      const text = xmlText(token), frame = stack.at(-1);
      if (frame?.field) {
        frame.text += text;
        if (frame.text.length > 100) throw new Error('invalid_field');
      }
      continue;
    }
    const end = /^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(token);
    if (end) {
      if (stack.at(-1)?.name !== end[1]) throw new Error('invalid_xml');
      closeFrame();
      continue;
    }
    const start = /^<([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>$/.exec(token);
    if (!start || stack.at(-1)?.field) throw new Error('invalid_xml');
    const namespaces = new Map(stack.at(-1)?.namespaces || [['xml', 'http://www.w3.org/XML/1998/namespace']]);
    const rawAttrs = new Map();
    for (const attr of start[2].matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g)) {
      if (rawAttrs.has(attr[1])) throw new Error('invalid_xml');
      const value = xmlText(attr[2] ?? attr[3]);
      rawAttrs.set(attr[1], value);
      if (attr[1] === 'xmlns') namespaces.set('', value);
      else if (attr[1].startsWith('xmlns:')) namespaces.set(attr[1].slice(6), value);
    }
    function expand(name, attribute = false) {
      const parts = name.split(':');
      if (parts.length > 2 || parts.some(part => !/^[A-Za-z_][\w.-]*$/.test(part))) throw new Error('invalid_xml');
      const prefix = parts.length === 2 ? parts[0] : '';
      const ns = attribute && !prefix ? '' : namespaces.get(prefix);
      if (prefix && !ns) throw new Error('invalid_namespace');
      return { ns: ns || '', local: parts.at(-1) };
    }
    const frame = { name: start[1], ...expand(start[1]), namespaces, attrs: new Map(), text: '', field: false };
    for (const [name, value] of rawAttrs) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
      const { ns, local } = expand(name, true), key = `${ns}|${local}`;
      if (frame.attrs.has(key)) throw new Error('invalid_xml');
      frame.attrs.set(key, value);
    }
    if (!stack.length && (++rootCount !== 1 || !is(frame, ATOM, 'feed'))) throw new Error('invalid_atom_feed');
    if (stack.length >= MAX_DEPTH) throw new Error('feed_too_deep');
    stack.push(frame);
    if (stack.length === 2 && is(frame, ATOM, 'entry')) entry = { properties: 0, fields: new Map() };
    if (entry && stack.length === 4 && is(stack[2], ATOM, 'content') && is(frame, META, 'properties')) entry.properties++;
    if (entry && stack.length === 5 && is(stack[2], ATOM, 'content') && is(stack[3], META, 'properties') && frame.ns === DATA && ['NEW_DATE', 'BC_10YEAR'].includes(frame.local)) {
      if (entry.fields.has(frame.local)) throw new Error('duplicate_field');
      frame.field = true;
    }
    if (start[3]) closeFrame();
  }
  if (stack.length || rootCount !== 1) throw new Error('invalid_xml');
  const dates = new Map();
  for (const row of rows) {
    if (dates.has(row.date) && dates.get(row.date).yieldPct !== row.yieldPct) throw new Error('conflicting_observations');
    dates.set(row.date, row);
  }
  return [...dates.values()].sort((a, b) => b.date.localeCompare(a.date));
}

async function boundedText(response, signal) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw new Error('feed_too_large');
  if (!response.body?.getReader) throw new Error('stream_unavailable');
  const reader = response.body.getReader(), chunks = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('timeout');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('timeout');
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('feed_too_large');
      chunks.push(Buffer.from(value));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { signal.removeEventListener('abort', cancel); cancel(); }
}

class OfficialTreasuryRates {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, ttlMs = 60 * 60 * 1000, timeoutMs = 8000, retryMs = 60 * 1000, staleMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    Object.assign(this, { fetchImpl, now, ttlMs, timeoutMs, retryMs, staleMs });
    this.cache = null;
    this.lastFailureAt = null;
    this.inFlight = null;
  }
  snapshot(status, error = null) {
    const now = this.now(), usable = this.cache && now - this.cache.at <= this.staleMs;
    const latest = usable ? { ...this.cache.rows[0] } : null;
    const previous = usable && this.cache.rows[1] ? { ...this.cache.rows[1] } : null;
    const missing = latest && latest.yieldPct === null;
    return {
      status: missing ? 'unavailable' : status,
      stale: status === 'stale',
      fetchedAt: usable ? new Date(this.cache.at).toISOString() : null,
      retrievedAt: usable ? new Date(this.cache.at).toISOString() : null,
      checkedAt: new Date(now).toISOString(), latest, previous,
      changeBps: latest?.yieldPct != null && previous?.yieldPct != null ? Number(((latest.yieldPct - previous.yieldPct) * 100).toFixed(8)) : null,
      source: SOURCE, sourceUrl: SOURCE_URL, methodologyUrl: METHODOLOGY_URL,
      feedUrls: usable ? [...this.cache.feedUrls] : [],
      license: 'CC0-1.0', licenseUrl: LICENSE_URL,
      frequency: 'daily', intraday: false, freshnessBasis: 'retrieval-time',
      calendarVerified: false, latestSessionVerified: false,
      error: error || (missing ? 'latest_yield_missing' : null),
    };
  }
  get() {
    // Every caller receives independent records, including concurrent callers.
    if (this.inFlight) return this.inFlight.then(result => structuredClone(result));
    const now = this.now(), usable = this.cache && now - this.cache.at <= this.staleMs;
    if (this.lastFailureAt !== null && now - this.lastFailureAt < this.retryMs) return Promise.resolve(this.snapshot(usable ? 'stale' : 'unavailable', 'fetch_failed'));
    if (usable && now - this.cache.at < this.ttlMs) return Promise.resolve(this.snapshot('fresh'));
    this.inFlight = this.refresh().finally(() => { this.inFlight = null; });
    return this.inFlight.then(result => structuredClone(result));
  }
  async refresh() {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.timeoutMs); });
    try {
      const result = await Promise.race([timeout, (async () => {
        const year = new Date(this.now()).getUTCFullYear(), feedUrls = [];
        const fetchYear = async value => {
          const url = annualFeedUrl(value);
          const response = await this.fetchImpl(url, { signal: controller.signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'application/atom+xml, application/xml, text/xml' } });
          if (!response.ok || (response.url && response.url !== url) || !/^(?:application\/(?:atom\+)?xml|text\/xml)(?:\s*;|$)/i.test(response.headers?.get('content-type') || '')) throw new Error('invalid_response');
          const rows = parseTreasuryFeed(await boundedText(response, controller.signal), this.now(), value);
          feedUrls.push(url);
          return rows;
        };
        let rows = await fetchYear(year);
        // At the year boundary, use actual prior-year observations, never a
        // guessed previous weekday. Null rows count: they must not be skipped.
        if (rows.length < 2) rows = rows.concat(await fetchYear(year - 1));
        if (!rows.length) throw new Error('no_observations');
        return { rows: rows.slice(0, 2), feedUrls };
      })()]);
      this.cache = { at: this.now(), ...result };
      this.lastFailureAt = null;
      return this.snapshot('fresh');
    } catch (_) {
      this.lastFailureAt = this.now();
      return this.snapshot(this.cache && this.now() - this.cache.at <= this.staleMs ? 'stale' : 'unavailable', 'fetch_failed');
    } finally { clearTimeout(timer); }
  }
}

module.exports = { OfficialTreasuryRates, TreasuryYieldService: OfficialTreasuryRates, parseTreasuryFeed, annualFeedUrl };
