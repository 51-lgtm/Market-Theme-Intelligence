const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
test('isolated preview selects free compute and disables paid AI and execution', () => {
 const config = read('render-free-preview.yaml');
 assert.match(config, /name: us-command-astra-preview-new/);
 assert.match(config, /plan: free/);
 assert.doesNotMatch(config, /disk:|databases:|type: worker|envVarGroups:/);
 for (const key of ['AUTO_TRADE','LIVE_TRADING','PAPER_TRADING','SHADOW_TRADING','ASTRA_BACKGROUND_JOBS']) {
  assert.ok(config.includes(`key: ${key}\n        value: "false"`), key);
 }
 for (const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','FINNHUB_API_KEY','ALPHA_VANTAGE_API_KEY']) {
  assert.ok(config.includes(`key: ${key}\n        value: ""`), key);
 }
 for (const key of ['OPENAI_MAX_CALLS_PER_DAY','OPENAI_MAX_CALLS_PER_RUN']) {
  assert.ok(config.includes(`key: ${key}\n        value: "0"`), key);
 }
 assert.ok(config.includes('key: ASTRA_ADMIN_PASSWORD\n        sync: false'));
 assert.ok(config.includes('key: ASTRA_JWT_SECRET\n        generateValue: true'));
});
test('preview interface warns before users rely on ephemeral records or export', () => {
 const jsx = read('frontend/src/App.jsx');
 assert.match(jsx, /無料プレビュー用コピー/);
 assert.match(jsx, /JSON出力は完全復元用バックアップではありません/);
 assert.match(jsx, /Shadow口座・注文・ポジション・Kill Switch/);
 assert.doesNotMatch(jsx, /SHADOW TRADING ENABLED/);
});
