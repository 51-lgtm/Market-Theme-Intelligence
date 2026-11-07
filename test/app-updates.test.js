'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validRelease, releaseState, readRelease, activateAndReload } = require('../app-updates');
const { createApp } = require('../server');

test('release comparison never labels invalid or unknown metadata as current', () => {
  assert.equal(releaseState('2026-11-07-clarity-1', '2026-11-07-clarity-1'), 'current');
  assert.equal(releaseState('old', 'new'), 'available');
  for (const value of [null, '', {}, '<script>', 'a'.repeat(65)]) {
    assert.equal(validRelease(value), false);
    assert.equal(releaseState('old', value), 'unknown');
  }
});
test('release lookup reads only first-party metadata without caching', async () => {
  let input;
  const latest = await readRelease(async (...args) => { input = args; return { ok: true, json: async () => ({ release: 'version-2' }) }; });
  assert.equal(latest, 'version-2');
  assert.equal(input[0], '/app-release.json');
  assert.equal(input[1].cache, 'no-store');
  await assert.rejects(readRelease(async () => ({ ok: false })), /release_unavailable/);
  await assert.rejects(readRelease(async () => ({ ok: true, json: async () => ({ release: null }) })), /release_invalid/);
});
test('explicit update waits for worker activation and reloads at most once', async () => {
  let listener, reloads = 0, posted;
  const nav = { serviceWorker: {
    addEventListener(type, fn) { assert.equal(type, 'controllerchange'); listener = fn; },
    removeEventListener(type, fn) { assert.equal(fn, listener); }
  } };
  const updating = activateAndReload({ waiting: { postMessage(value) { posted = value; } } }, nav, () => reloads++);
  assert.equal(posted, 'SKIP_WAITING');
  assert.equal(reloads, 0);
  listener(); listener();
  await updating;
  assert.equal(reloads, 1);
  await activateAndReload(null, {}, () => reloads++);
  assert.equal(reloads, 2);
});
test('worker activation timeout preserves the open page', async () => {
  let expire, reloads = 0, removed = 0;
  const nav = { serviceWorker: { addEventListener() {}, removeEventListener() { removed++; } } };
  const updating = activateAndReload({ waiting: { postMessage() {} } }, nav, () => reloads++, {
    setTimeout(fn) { expire = fn; return 1; }, clearTimeout() {}
  });
  expire();
  await assert.rejects(updating, /activation_timeout/);
  assert.equal(reloads, 0); assert.equal(removed, 1);
});
test('release UI cannot clear saved holdings or reload automatically', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app-updates.js'), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|caches\.delete|unregister\(/);
  assert.match(source, /refresh\.addEventListener\('click'[\s\S]+win\.confirm\(/);
  assert.match(source, /保存済みの保有情報は消しません/);
  assert.match(source, /公開版を確認できません/);
});
test('worker activation removes only old application caches and never forces activation', async () => {
  const handlers = {}, removed = [];
  let claimed = 0, awaited;
  const source = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');
  vm.runInNewContext(source, {
    self: { addEventListener(type, fn) { handlers[type] = fn; }, clients: { claim: () => claimed++ } },
    caches: { keys: async () => ['uscmd-old', 'astra-private', 'uscmd-v14-holdings-clarity-20261107'], delete: async key => removed.push(key) },
    Set
  });
  handlers.activate({ waitUntil(promise) { awaited = promise; } }); await awaited;
  assert.deepEqual(removed, ['uscmd-old']); assert.equal(claimed, 1);
  assert.doesNotMatch(source, /install[\s\S]{0,180}skipWaiting/);
});
test('public release metadata is uncached and never calls a market provider', async () => {
  let calls = 0;
  const { app } = createApp({ env: { API_TOKEN: 'test-only-secret' }, marketData: { getSnapshot() { calls++; throw Error('unexpected'); }, status() { return {}; } } });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const response = await fetch(base + '/app-release.json');
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
    const body = await response.json();
    assert.equal(body.release, '2026-11-07-clarity-1');
    assert.deepEqual(Object.keys(body).sort(), ['release', 'requestId']); assert.equal(calls, 0);
    const script = await fetch(base + '/app-updates.js');
    assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/);
    assert.match(await script.text(), /Display-only release notice/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
