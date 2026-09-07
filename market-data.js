'use strict';

const crypto = require('crypto');
const {
  BACKTEST_METHOD_VERSION,
  SIMULATION_EXECUTION,
  TECHNICAL_METHOD_VERSION,
  buildBuySignalResult,
  detectLeveragedProduct,
  runTechnicalBacktest
} = require('./technical-signals');

const DEFAULT_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (compatible; USCommandUltra/14.0.0; +https://render.com)',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9'
});

const DEFAULT_TTL_MS = 45_000;
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_NEGATIVE_TTL_MS = 30_000;
const DEFAULT_MAX_CACHE_ENTRIES = 250;
const DEFAULT_DEADLINE_MS = 14_000;
const DEFAULT_YAHOO_TIMEOUT_MS = 5_000;
const DEFAULT_FINNHUB_TIMEOUT_MS = 3_500;
const DEFAULT_NASDAQ_TIMEOUT_MS = 1_800;
const DEFAULT_NASDAQ_MAX_SYMBOLS = 5;
const DEFAULT_FINNHUB_CALLS_PER_MINUTE = 55;
const DEFAULT_YAHOO_BATCH_WINDOW_MS = 20;
const DEFAULT_MAX_IN_FLIGHT_ENTRIES = 500;
const DEFAULT_PROVIDER_DIVERGENCE_PCT = 1.5;
const DEFAULT_THEME_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_THEME_PARTIAL_TTL_MS = 2 * 60 * 1000;
const DEFAULT_THEME_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THEME_DEADLINE_MS = 12_000;
const DEFAULT_THEME_TIMEOUT_MS = 7_000;
const DEFAULT_THEME_BATCH_SIZE = 20;
const DEFAULT_HISTORY_CACHE_MAX_ENTRIES = 300;
const DEFAULT_INTELLIGENCE_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_INTELLIGENCE_PARTIAL_TTL_MS = 2 * 60 * 1000;
const DEFAULT_INTELLIGENCE_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTELLIGENCE_DEADLINE_MS = 20_000;
const DEFAULT_MARKET_REGIME_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MARKET_REGIME_PARTIAL_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MARKET_REGIME_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MARKET_REGIME_DEADLINE_MS = 12_000;
const DEFAULT_MARKET_REGIME_SPY_ADJUSTED_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TECHNICAL_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TECHNICAL_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TECHNICAL_DEADLINE_MS = 25_000;
const DEFAULT_TECHNICAL_TIMEOUT_MS = 8_000;
const DEFAULT_TECHNICAL_BATCH_SIZE = 20;
const DEFAULT_TECHNICAL_CHART_CONCURRENCY = 4;
const DEFAULT_TECHNICAL_CACHE_MAX_ENTRIES = 120;
const DEFAULT_TECHNICAL_FINNHUB_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TECHNICAL_FINNHUB_MAX_SYMBOLS = 8;
const MARKET_REGIME_MAX_OBSERVATION_AGE_MS = 96 * 60 * 60 * 1000;
const MARKET_REGIME_METHOD_VERSION = 'vix-wti-spy-rules-v3';
const MARKET_REGIME_SYMBOLS = Object.freeze(['^VIX', 'CL=F', 'SPY']);
const MARKET_REGIME_HORIZONS = Object.freeze([1, 5, 20]);
const RRG_LONG_SESSIONS = 63;
const RRG_SHORT_SESSIONS = 5;
const RRG_TRAIL_SESSIONS = 20;
const RRG_TRAIL_POINTS = RRG_TRAIL_SESSIONS + 1;
const RRG_METHOD_VERSION = 'rrg-spy-log-v1';
const MAX_PROVIDER_OBSERVATION_SKEW_MS = 6 * 60 * 60 * 1000;
const MAX_PREVIOUS_OBSERVATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOSES = 66;

const THEME_PERIODS = Object.freeze({
  '1d': Object.freeze({ label: '1日', kind: 'sessions', sessions: 1 }),
  '5d': Object.freeze({ label: '5日', kind: 'sessions', sessions: 5 }),
  '1m': Object.freeze({ label: '1か月', kind: 'calendar-months', months: 1 }),
  '1y': Object.freeze({ label: '1年', kind: 'calendar-years', years: 1 })
});
const THEME_CATALOG_VERSION = '2026.07.1';

const theme = (id, name, description, members) => Object.freeze({
  id,
  name,
  description,
  members: Object.freeze(members.map(member => Object.freeze({ ...member })))
});

// This deliberately small, fixed universe keeps one dashboard refresh to one
// Yahoo batch request while covering the practical themes used by the app.
const THEME_CATALOG = Object.freeze([
  theme('ai-semiconductors', 'AI半導体', 'AI計算を支えるGPU・アクセラレーター・接続半導体', [
    { symbol: 'NVDA', name: 'NVIDIA' },
    { symbol: 'AMD', name: 'Advanced Micro Devices' },
    { symbol: 'AVGO', name: 'Broadcom' },
    { symbol: 'MRVL', name: 'Marvell Technology' },
    { symbol: 'ARM', name: 'Arm Holdings' }
  ]),
  theme('ai-infrastructure', 'AIサーバー・データセンター', 'サーバー、冷却、ネットワークなどAI設備投資の中核', [
    { symbol: 'VRT', name: 'Vertiv' },
    { symbol: 'SMCI', name: 'Super Micro Computer' },
    { symbol: 'DELL', name: 'Dell Technologies' },
    { symbol: 'ANET', name: 'Arista Networks' },
    { symbol: 'HPE', name: 'Hewlett Packard Enterprise' }
  ]),
  theme('semiconductor-equipment', '半導体製造装置', '先端ロジック・ファウンドリー投資の恩恵を受ける製造装置群', [
    { symbol: 'ASML', name: 'ASML Holding' },
    { symbol: 'AMAT', name: 'Applied Materials' },
    { symbol: 'LRCX', name: 'Lam Research' },
    { symbol: 'KLAC', name: 'KLA' },
    { symbol: 'TSM', name: 'Taiwan Semiconductor' }
  ]),
  theme('memory-storage', 'メモリ・ストレージ', 'DRAM、NAND、HDD、企業向けデータストレージ', [
    { symbol: 'MU', name: 'Micron Technology' },
    { symbol: 'WDC', name: 'Western Digital' },
    { symbol: 'STX', name: 'Seagate Technology' },
    { symbol: 'SNDK', name: 'Sandisk' },
    { symbol: 'NTAP', name: 'NetApp' }
  ]),
  theme('power-infrastructure', '電力インフラ', 'データセンター需要を支える発電・送配電・電機設備', [
    { symbol: 'VST', name: 'Vistra' },
    { symbol: 'CEG', name: 'Constellation Energy' },
    { symbol: 'GEV', name: 'GE Vernova' },
    { symbol: 'ETN', name: 'Eaton' },
    { symbol: 'PWR', name: 'Quanta Services' }
  ]),
  theme('quantum-computing', '量子コンピューター', '量子ハードウェア、クラウドアクセス、周辺技術', [
    { symbol: 'IONQ', name: 'IonQ' },
    { symbol: 'RGTI', name: 'Rigetti Computing' },
    { symbol: 'QBTS', name: 'D-Wave Quantum' },
    { symbol: 'QUBT', name: 'Quantum Computing' },
    { symbol: 'IBM', name: 'IBM' }
  ]),
  theme('space-defense', '宇宙・防衛', '防衛プライム、打ち上げ、衛星通信の主要企業', [
    { symbol: 'LMT', name: 'Lockheed Martin' },
    { symbol: 'RTX', name: 'RTX' },
    { symbol: 'NOC', name: 'Northrop Grumman' },
    { symbol: 'RKLB', name: 'Rocket Lab USA' },
    { symbol: 'ASTS', name: 'AST SpaceMobile' }
  ]),
  theme('drones-autonomy', 'ドローン・自律システム', '無人航空機、防衛ドローン、eVTOLプラットフォーム', [
    { symbol: 'AVAV', name: 'AeroVironment' },
    { symbol: 'KTOS', name: 'Kratos Defense' },
    { symbol: 'ONDS', name: 'Ondas Holdings' },
    { symbol: 'JOBY', name: 'Joby Aviation' },
    { symbol: 'ACHR', name: 'Archer Aviation' }
  ]),
  theme('genomics-biotech', 'バイオ・遺伝子編集', '遺伝子編集、AI創薬、精密医療の代表企業', [
    { symbol: 'CRSP', name: 'CRISPR Therapeutics' },
    { symbol: 'NTLA', name: 'Intellia Therapeutics' },
    { symbol: 'BEAM', name: 'Beam Therapeutics' },
    { symbol: 'RXRX', name: 'Recursion Pharmaceuticals' },
    { symbol: 'VRTX', name: 'Vertex Pharmaceuticals' }
  ]),
  theme('emerging-ecommerce', '新興国EC', '中南米・東南アジア・アフリカ・アジアのECプラットフォーム', [
    { symbol: 'MELI', name: 'MercadoLibre' },
    { symbol: 'SE', name: 'Sea' },
    { symbol: 'CPNG', name: 'Coupang' },
    { symbol: 'JMIA', name: 'Jumia Technologies' },
    { symbol: 'PDD', name: 'PDD Holdings' }
  ])
]);

const INTELLIGENCE_CATALOG_VERSION = 'v13.2026-07-12.1';
const INTELLIGENCE_EFFECTIVE_AT = '2026-07-12';
const INTELLIGENCE_CATEGORIES = Object.freeze([
  { id: 'ai', name: 'AI', color: '#38e1ff' },
  { id: 'semiconductors', name: '半導体', color: '#a78bfa' },
  { id: 'data-centers', name: 'データセンター', color: '#22d3ee' },
  { id: 'energy', name: 'エネルギー', color: '#fbbf24' },
  { id: 'frontier-tech', name: '次世代技術', color: '#34d399' },
  { id: 'biotech', name: 'バイオ', color: '#fb7185' },
  { id: 'consumer-finance', name: '消費・金融', color: '#60a5fa' },
  { id: 'defensive', name: '守り', color: '#94a3b8' }
].map(entry => Object.freeze(entry)));

const intelligenceTheme = (id, name, categoryId, parentId, relatedTickers, etfs, relatedInstruments = []) => Object.freeze({
  id,
  name,
  categoryId,
  parentId: parentId || null,
  relatedTickers: Object.freeze(relatedTickers),
  etfs: Object.freeze(etfs),
  relatedInstruments: Object.freeze(relatedInstruments.map(instrument => Object.freeze({ ...instrument })))
});

// Membership is intentionally fixed and versioned. Historical calculations
// backcast today's basket; they are not an official index or point-in-time
// constituent history.
const INTELLIGENCE_THEME_CATALOG = Object.freeze([
  intelligenceTheme('ai-apps', 'AIアプリ', 'ai', null, ['MSFT', 'GOOGL', 'META', 'ADBE'], ['AIQ']),
  intelligenceTheme('ai-agents', 'AIエージェント', 'ai', 'ai-apps', ['MSFT', 'GOOGL', 'AMZN', 'CRM'], ['AIQ']),
  intelligenceTheme('ai-cloud', 'AIクラウド', 'ai', null, ['MSFT', 'AMZN', 'GOOGL', 'ORCL'], ['SKYY', 'CLOU']),
  intelligenceTheme('ai-servers', 'AIサーバー', 'ai', 'ai-cloud', ['SMCI', 'DELL', 'HPE', 'VRT'], ['AIQ']),
  intelligenceTheme('ai-semiconductors', 'AI半導体', 'ai', null, ['NVDA', 'AMD', 'AVGO', 'MRVL'], ['SMH', 'SOXX']),
  intelligenceTheme('ai-networking', 'AIネットワーク', 'ai', 'ai-servers', ['ANET', 'CSCO', 'AVGO', 'MRVL'], ['IGN']),
  intelligenceTheme('ai-inference', 'AI推論', 'ai', 'ai-semiconductors', ['NVDA', 'AMD', 'QCOM', 'ARM'], ['SMH']),
  intelligenceTheme('ai-software', 'AIソフトウェア', 'ai', 'ai-apps', ['PLTR', 'NOW', 'CRM', 'ADBE'], ['IGV', 'WCLD']),

  intelligenceTheme('gpu', 'GPU', 'semiconductors', 'ai-semiconductors', ['NVDA', 'AMD', 'INTC', 'QCOM'], ['SMH']),
  intelligenceTheme('cpu', 'CPU', 'semiconductors', 'ai-semiconductors', ['AMD', 'INTC', 'ARM', 'QCOM'], ['SOXX']),
  intelligenceTheme('asic', 'ASIC', 'semiconductors', 'ai-semiconductors', ['AVGO', 'MRVL', 'GOOGL', 'AMZN'], ['SMH']),
  intelligenceTheme('fpga', 'FPGA', 'semiconductors', 'ai-semiconductors', ['AMD', 'INTC', 'LSCC', 'MCHP'], ['SOXX']),
  intelligenceTheme('hbm', 'HBM', 'semiconductors', 'dram', ['MU', 'NVDA', 'AMD', 'AVGO'], ['SOXX'], [
    { symbol: 'MUU', name: 'Direxion Daily MU Bull 2X Shares', leveraged: true, dailyTarget: '+200%', usedInScore: false, risk: 'single-stock daily leveraged ETF; long-term returns can diverge through compounding' }
  ]),
  intelligenceTheme('dram', 'DRAM', 'semiconductors', null, ['MU', 'AMD', 'NVDA', 'WDC'], ['SOXX'], [
    { symbol: 'MUU', name: 'Direxion Daily MU Bull 2X Shares', leveraged: true, dailyTarget: '+200%', usedInScore: false, risk: 'single-stock daily leveraged ETF; long-term returns can diverge through compounding' }
  ]),
  intelligenceTheme('nand', 'NAND', 'semiconductors', null, ['SNDK', 'WDC', 'MU', 'STX'], ['SOXX']),
  intelligenceTheme('semiconductor-equipment', '半導体製造装置', 'semiconductors', null, ['ASML', 'AMAT', 'LRCX', 'KLAC'], ['SOXX', 'SMH']),

  intelligenceTheme('servers', 'サーバー', 'data-centers', 'ai-servers', ['SMCI', 'DELL', 'HPE', 'IBM'], ['SRVR']),
  intelligenceTheme('racks', 'ラック', 'data-centers', 'servers', ['VRT', 'ETN', 'MOD', 'PWR'], ['SRVR']),
  intelligenceTheme('datacenter-networking', 'ネットワーク', 'data-centers', 'ai-networking', ['ANET', 'CSCO', 'CIEN', 'AVGO'], ['IGN']),
  intelligenceTheme('optical-communications', '光通信', 'data-centers', 'datacenter-networking', ['CIEN', 'LITE', 'COHR', 'AAOI'], ['IGN']),
  intelligenceTheme('liquid-cooling', '液冷', 'data-centers', 'racks', ['VRT', 'MOD', 'CARR', 'JCI'], ['SRVR']),
  intelligenceTheme('ups-power', 'UPS・電源', 'data-centers', 'racks', ['VRT', 'ETN', 'PWR', 'HUBB'], ['GRID']),

  intelligenceTheme('utilities-power', '電力会社', 'energy', null, ['VST', 'CEG', 'NRG', 'DUK'], ['XLU']),
  intelligenceTheme('gas-turbines', 'ガスタービン', 'energy', 'utilities-power', ['GEV', 'POWL', 'BWXT', 'CW'], ['PUI']),
  intelligenceTheme('nuclear', '原子力', 'energy', 'utilities-power', ['CEG', 'VST', 'CCJ', 'LEU'], ['NLR', 'URA']),
  intelligenceTheme('smr', 'SMR', 'energy', 'nuclear', ['SMR', 'OKLO', 'BWXT', 'LEU'], ['NLR']),
  intelligenceTheme('power-grid', '送電網', 'energy', 'utilities-power', ['ETN', 'PWR', 'HUBB', 'GEV'], ['GRID']),
  intelligenceTheme('energy-storage', '蓄電池', 'energy', 'power-grid', ['TSLA', 'FLNC', 'EOSE', 'ALB'], ['LIT', 'BATT']),

  intelligenceTheme('quantum-computing', '量子コンピュータ', 'frontier-tech', null, ['IONQ', 'RGTI', 'QBTS', 'QUBT'], ['QTUM']),
  intelligenceTheme('robotics', 'ロボティクス', 'frontier-tech', null, ['ISRG', 'SYM', 'TER', 'ROK'], ['BOTZ', 'ROBO']),
  intelligenceTheme('autonomous-driving', '自動運転', 'frontier-tech', 'robotics', ['TSLA', 'MBLY', 'APTV', 'GM'], ['DRIV', 'IDRV']),
  intelligenceTheme('drones', 'ドローン', 'frontier-tech', 'robotics', ['AVAV', 'KTOS', 'ONDS', 'JOBY'], ['ARKQ']),
  intelligenceTheme('space', '宇宙', 'frontier-tech', null, ['RKLB', 'ASTS', 'LUNR', 'RDW'], ['UFO', 'ARKX']),
  intelligenceTheme('defense', '防衛', 'frontier-tech', null, ['LMT', 'RTX', 'NOC', 'GD'], ['ITA', 'XAR']),
  intelligenceTheme('cybersecurity', 'サイバーセキュリティ', 'frontier-tech', null, ['CRWD', 'PANW', 'FTNT', 'ZS'], ['CIBR', 'HACK']),
  intelligenceTheme('iot', 'IoT', 'frontier-tech', null, ['QCOM', 'NXPI', 'SWKS', 'STM'], ['SNSR']),

  intelligenceTheme('ai-drug-discovery', 'AI創薬', 'biotech', 'ai-apps', ['RXRX', 'SDGR', 'ABCL', 'TEM'], ['ARKG']),
  intelligenceTheme('gene-editing', '遺伝子編集', 'biotech', null, ['CRSP', 'NTLA', 'BEAM', 'EDIT'], ['ARKG']),
  intelligenceTheme('obesity-drugs', '肥満薬', 'biotech', null, ['LLY', 'NVO', 'AMGN', 'VKTX'], ['XBI']),
  intelligenceTheme('medical-devices', '医療機器', 'biotech', null, ['ISRG', 'BSX', 'MDT', 'SYK'], ['IHI']),
  intelligenceTheme('biopharma', 'バイオ医薬', 'biotech', null, ['VRTX', 'REGN', 'GILD', 'BIIB'], ['IBB', 'XBI']),

  intelligenceTheme('ecommerce', 'EC', 'consumer-finance', null, ['AMZN', 'MELI', 'SE', 'CPNG'], ['IBUY']),
  intelligenceTheme('fintech', 'フィンテック', 'consumer-finance', null, ['SOFI', 'HOOD', 'NU', 'AFRM'], ['FINX']),
  intelligenceTheme('payments', '決済', 'consumer-finance', 'fintech', ['V', 'MA', 'PYPL', 'XYZ'], ['IPAY']),
  intelligenceTheme('crypto-assets', '暗号資産', 'consumer-finance', 'fintech', ['COIN', 'MSTR', 'MARA', 'RIOT'], ['BITQ']),
  intelligenceTheme('neobanks', 'ネオバンク', 'consumer-finance', 'fintech', ['SOFI', 'NU', 'HOOD', 'DAVE'], ['FINX']),

  intelligenceTheme('gold', '金', 'defensive', null, ['NEM', 'B', 'AEM', 'FNV'], ['GLD', 'IAU']),
  intelligenceTheme('bonds', '債券', 'defensive', null, ['TLT', 'IEF', 'SHY', 'BND'], ['AGG', 'GOVT']),
  intelligenceTheme('defensive-utilities', '公益', 'defensive', null, ['DUK', 'SO', 'ED', 'AEP'], ['XLU', 'VPU']),
  intelligenceTheme('high-dividend', '高配当', 'defensive', null, ['VZ', 'T', 'MO', 'IBM'], ['SCHD', 'VYM'])
]);

const intelligenceEdge = (from, to, type) => Object.freeze({ from, to, type });
const INTELLIGENCE_STRUCTURAL_EDGES = Object.freeze([
  intelligenceEdge('semiconductor-equipment', 'gpu', 'supply-chain'),
  intelligenceEdge('semiconductor-equipment', 'asic', 'supply-chain'),
  intelligenceEdge('semiconductor-equipment', 'dram', 'supply-chain'),
  intelligenceEdge('ai-semiconductors', 'gpu', 'subtheme-of'),
  intelligenceEdge('gpu', 'hbm', 'demand-driver'),
  intelligenceEdge('hbm', 'dram', 'demand-driver'),
  intelligenceEdge('gpu', 'ai-inference', 'technology-enabler'),
  intelligenceEdge('asic', 'ai-inference', 'technology-enabler'),
  intelligenceEdge('ai-semiconductors', 'ai-servers', 'supply-chain'),
  intelligenceEdge('ai-networking', 'ai-cloud', 'infrastructure-dependency'),
  intelligenceEdge('ai-cloud', 'ai-apps', 'technology-enabler'),
  intelligenceEdge('ai-apps', 'ai-agents', 'subtheme-of'),
  intelligenceEdge('ai-software', 'ai-agents', 'technology-enabler'),
  intelligenceEdge('servers', 'racks', 'infrastructure-dependency'),
  intelligenceEdge('racks', 'liquid-cooling', 'demand-driver'),
  intelligenceEdge('racks', 'ups-power', 'demand-driver'),
  intelligenceEdge('datacenter-networking', 'optical-communications', 'demand-driver'),
  intelligenceEdge('ai-servers', 'datacenter-networking', 'demand-driver'),
  intelligenceEdge('ai-servers', 'utilities-power', 'demand-driver'),
  intelligenceEdge('utilities-power', 'power-grid', 'demand-driver'),
  intelligenceEdge('gas-turbines', 'utilities-power', 'supply-chain'),
  intelligenceEdge('nuclear', 'utilities-power', 'supply-chain'),
  intelligenceEdge('nuclear', 'smr', 'subtheme-of'),
  intelligenceEdge('power-grid', 'energy-storage', 'infrastructure-dependency'),
  intelligenceEdge('cpu', 'iot', 'technology-enabler'),
  intelligenceEdge('fpga', 'drones', 'technology-enabler'),
  intelligenceEdge('robotics', 'autonomous-driving', 'subtheme-of'),
  intelligenceEdge('robotics', 'drones', 'technology-enabler'),
  intelligenceEdge('defense', 'drones', 'demand-driver'),
  intelligenceEdge('defense', 'space', 'demand-driver'),
  intelligenceEdge('cybersecurity', 'ai-cloud', 'infrastructure-dependency'),
  intelligenceEdge('ai-apps', 'ai-drug-discovery', 'technology-enabler'),
  intelligenceEdge('ai-drug-discovery', 'biopharma', 'technology-enabler'),
  intelligenceEdge('gene-editing', 'biopharma', 'technology-enabler'),
  intelligenceEdge('obesity-drugs', 'biopharma', 'subtheme-of'),
  intelligenceEdge('fintech', 'payments', 'subtheme-of'),
  intelligenceEdge('fintech', 'neobanks', 'subtheme-of'),
  intelligenceEdge('crypto-assets', 'fintech', 'macro-related'),
  intelligenceEdge('payments', 'ecommerce', 'infrastructure-dependency'),
  intelligenceEdge('bonds', 'high-dividend', 'macro-related'),
  intelligenceEdge('gold', 'bonds', 'macro-related'),
  intelligenceEdge('utilities-power', 'defensive-utilities', 'subtheme-of'),
  intelligenceEdge('defensive-utilities', 'high-dividend', 'macro-related')
]);

if (INTELLIGENCE_THEME_CATALOG.length !== 50) {
  throw new Error(`Theme Intelligence catalog must contain exactly 50 themes, got ${INTELLIGENCE_THEME_CATALOG.length}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(String(value || '').replace(/[$,%+\s]/g, '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoFromUnix(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : fallback;
}

function normalizeCloses(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map(parseNumber)
    .filter(value => Number.isFinite(value) && value > 0)
    .slice(-MAX_CLOSES)
    .map(value => +value.toFixed(6));
}

function timestampAgeMs(value, nowMs) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : null;
}

function compareProviders(primary, secondary, thresholdPct, checkedAt) {
  const primaryPrice = parseNumber(primary?.price);
  const secondaryPrice = parseNumber(secondary?.price);
  if (!(primaryPrice > 0) || !(secondaryPrice > 0)) return null;

  const mean = (Math.abs(primaryPrice) + Math.abs(secondaryPrice)) / 2;
  const differencePct = +((Math.abs(primaryPrice - secondaryPrice) / mean) * 100).toFixed(3);
  const primaryAt = Date.parse(String(primary?.at || ''));
  const secondaryAt = Date.parse(String(secondary?.at || ''));
  const observationSkewMs = Number.isFinite(primaryAt) && Number.isFinite(secondaryAt)
    ? Math.abs(primaryAt - secondaryAt)
    : null;
  const primaryCurrency = String(primary?.currency || '').toUpperCase();
  const secondaryCurrency = String(secondary?.currency || '').toUpperCase();
  const currencyCompatible = !primaryCurrency || !secondaryCurrency || primaryCurrency === secondaryCurrency;
  const sessionKind = quote => {
    const state = String(quote?.marketState || 'unknown').toLowerCase();
    if (state === 'open') return 'live';
    if (['pre', 'post', 'closed'].includes(state)) return 'regular-close';
    if (state === 'reference') return 'reference';
    return 'unknown';
  };
  const primarySession = sessionKind(primary);
  const secondarySession = sessionKind(secondary);
  const oneSessionUnknown = (primarySession === 'unknown') !== (secondarySession === 'unknown');
  const sessionCompatible = (primarySession === secondarySession && primarySession !== 'unknown') ||
    (oneSessionUnknown &&
      observationSkewMs != null && observationSkewMs <= 15 * 60 * 1000);
  const timeCompatible = observationSkewMs == null || observationSkewMs <= MAX_PROVIDER_OBSERVATION_SKEW_MS;
  const comparable = currencyCompatible && sessionCompatible && timeCompatible;
  let reason = null;
  if (!currencyCompatible) reason = 'currency-mismatch';
  else if (!sessionCompatible) reason = 'session-mismatch';
  else if (!timeCompatible) reason = 'observation-time-mismatch';

  return {
    status: comparable ? (differencePct >= thresholdPct ? 'divergent' : 'aligned') : 'inconclusive',
    sources: [primary.src || 'primary', secondary.src || 'secondary'],
    differencePct,
    thresholdPct,
    observationSkewMs,
    sessionKind: secondarySession !== 'unknown' ? secondarySession : primarySession,
    reason,
    checkedAt
  };
}

function quoteFreshness(quote, cacheState, cacheAgeMs, nowMs, ttlMs = DEFAULT_TTL_MS) {
  const quoteAgeMs = timestampAgeMs(quote?.at, nowMs);
  const retrievalAgeMs = timestampAgeMs(quote?.retrievedAt, nowMs);
  const marketState = String(quote?.marketState || 'unknown').toLowerCase();
  const transportAgeMs = retrievalAgeMs ?? cacheAgeMs;
  const transportFresh = cacheState !== 'stale-fallback' &&
    transportAgeMs != null && transportAgeMs <= ttlMs;
  let marketRecency = 'unknown';
  if (quoteAgeMs != null) {
    if (marketState === 'open') marketRecency = quoteAgeMs > 30 * 60 * 1000 ? 'aged' : 'current';
    else if (['pre', 'post', 'closed'].includes(marketState)) marketRecency = quoteAgeMs > MAX_PREVIOUS_OBSERVATION_AGE_MS ? 'aged' : 'previous-session';
    else if (marketState === 'reference') marketRecency = quoteAgeMs > MAX_PREVIOUS_OBSERVATION_AGE_MS ? 'aged' : 'reference';
  }
  let status = 'unverified';
  if (cacheState === 'stale-fallback' || !transportFresh || marketRecency === 'aged') {
    status = 'stale';
  } else if (marketRecency === 'reference') {
    status = 'reference';
  } else if (quote?.delayed) {
    status = 'delayed';
  } else if (marketRecency === 'current') {
    status = 'live';
  } else if (marketRecency === 'previous-session') {
    status = 'previous-close-valid';
  } else if (quoteAgeMs != null && quoteAgeMs <= 30 * 60 * 1000) {
    // Providers without session metadata may still prove a recent observation.
    status = 'live';
  }

  return {
    status,
    quoteAgeMs,
    marketAgeMs: quoteAgeMs,
    retrievalAgeMs,
    transportAgeMs,
    transportFresh,
    marketRecency,
    cacheAgeMs,
    cacheState,
    marketState
  };
}

function inferMarketState(meta, nowMs) {
  const now = nowMs / 1000;
  const periods = meta?.currentTradingPeriod || {};
  const within = p => p && Number(p.start) <= now && now < Number(p.end);
  if (within(periods.regular)) return 'open';
  if (within(periods.pre)) return 'pre';
  if (within(periods.post)) return 'post';
  return 'closed';
}

function previousCloseFromSeries(price, closes) {
  if (!closes.length) return null;
  const last = closes.at(-1);
  const tolerance = Math.max(Math.abs(price) * 0.002, 0.001);
  if (closes.length > 1 && Math.abs(last - price) <= tolerance) return closes.at(-2);
  return last;
}

function quoteFromChart(chart, retrievedAt, nowMs = Date.now()) {
  const meta = chart?.meta;
  if (!meta) return null;

  const rawCloses = chart?.indicators?.quote?.[0]?.close || [];
  const closes = normalizeCloses(rawCloses);
  const price = parseNumber(meta.regularMarketPrice) ?? closes.at(-1);
  if (!Number.isFinite(price)) return null;

  const previousClose = previousCloseFromSeries(price, closes);
  const changePct = previousClose
    ? +(((price / previousClose) - 1) * 100).toFixed(2)
    : 0;

  return {
    price: +price,
    changePct,
    previousClose: previousClose == null ? null : +previousClose,
    at: isoFromUnix(meta.regularMarketTime, retrievedAt),
    retrievedAt,
    closes,
    currency: meta.currency || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    name: meta.longName || meta.shortName || null,
    marketState: inferMarketState(meta, nowMs),
    delayed: false,
    src: 'yahoo-spark'
  };
}

function parseYahooSpark(payload, retrievedAt, nowMs = Date.now()) {
  const out = new Map();
  const rows = payload?.spark?.result;
  if (!Array.isArray(rows)) return out;

  for (const row of rows) {
    const symbol = normalizeSymbol(row?.symbol);
    const chart = row?.response?.[0];
    const quote = quoteFromChart(chart, retrievedAt, nowMs);
    if (symbol && quote) out.set(symbol, quote);
  }
  return out;
}

function normalizeHistoryPoints(chart, symbol = '') {
  const timestamps = Array.isArray(chart?.timestamp) ? chart.timestamp : [];
  const rawCloses = Array.isArray(chart?.indicators?.quote?.[0]?.close)
    ? chart.indicators.quote[0].close
    : [];
  const adjustedCloses = Array.isArray(chart?.indicators?.adjclose?.[0]?.adjclose)
    ? chart.indicators.adjclose[0].adjclose
    : [];
  const volumes = Array.isArray(chart?.indicators?.quote?.[0]?.volume)
    ? chart.indicators.quote[0].volume
    : [];
  const byTimestamp = new Map();
  const length = Math.min(timestamps.length, rawCloses.length);
  const preserveNonPositive = normalizeSymbol(symbol) === 'CL=F';
  for (let index = 0; index < length; index += 1) {
    const timestamp = Number(timestamps[index]);
    const rawClose = parseNumber(rawCloses[index]);
    const adjustedClose = parseNumber(adjustedCloses[index]);
    const volume = parseNumber(volumes[index]);
    const validAdjusted = Number.isFinite(adjustedClose) && (preserveNonPositive || adjustedClose > 0);
    const validRaw = Number.isFinite(rawClose) && (preserveNonPositive || rawClose > 0);
    const useAdjusted = validAdjusted;
    const close = useAdjusted ? adjustedClose : rawClose;
    if (!Number.isFinite(timestamp) || timestamp <= 0 || (!validAdjusted && !validRaw)) continue;
    byTimestamp.set(timestamp, {
      timestamp,
      at: new Date(timestamp * 1000).toISOString(),
      sessionDate: new Date(timestamp * 1000).toISOString().slice(0, 10),
      close: +close.toFixed(6),
      rawClose: validRaw ? +rawClose.toFixed(6) : null,
      priceMode: useAdjusted ? 'adjusted' : 'raw',
      volume: Number.isFinite(volume) && volume >= 0 ? Math.round(volume) : null
    });
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function consistentHistoryPoints(history) {
  const points = Array.isArray(history?.points) ? history.points : [];
  const adjustedOnly = history?.priceMode === 'adjusted';
  return points.flatMap(point => {
    const selectedClose = adjustedOnly ? parseNumber(point?.close) : parseNumber(point?.rawClose);
    if (!(selectedClose > 0)) return [];
    return [{
      ...point,
      close: selectedClose,
      priceMode: adjustedOnly ? 'adjusted' : 'raw'
    }];
  });
}

function calendarTargetTimestamp(endTimestamp, period) {
  const end = new Date(endTimestamp * 1000);
  const day = end.getUTCDate();
  if (period.months) {
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() - period.months);
    const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
    end.setUTCDate(Math.min(day, lastDay));
  } else if (period.years) {
    const month = end.getUTCMonth();
    end.setUTCDate(1);
    end.setUTCFullYear(end.getUTCFullYear() - period.years);
    const lastDay = new Date(Date.UTC(end.getUTCFullYear(), month + 1, 0)).getUTCDate();
    end.setUTCMonth(month);
    end.setUTCDate(Math.min(day, lastDay));
  }
  return Math.floor(end.getTime() / 1000);
}

function calculatePeriodPerformance(points, periodKey) {
  const period = THEME_PERIODS[periodKey];
  if (!period || !Array.isArray(points) || points.length < 2) return null;
  const endIndex = points.length - 1;
  const end = points[endIndex];
  let baselineIndex = -1;

  if (period.kind === 'sessions') {
    baselineIndex = endIndex - period.sessions;
  } else {
    const targetTimestamp = calendarTargetTimestamp(end.timestamp, period);
    for (let index = endIndex - 1; index >= 0; index -= 1) {
      if (points[index].timestamp <= targetTimestamp) {
        baselineIndex = index;
        break;
      }
    }
  }

  if (baselineIndex < 0) return null;
  const baseline = points[baselineIndex];
  if (!(baseline.close > 0) || !(end.close > 0)) return null;
  return {
    valuePct: ((end.close / baseline.close) - 1) * 100,
    baselinePrice: baseline.close,
    baselineAt: baseline.at,
    baselineDate: baseline.sessionDate || baseline.at.slice(0, 10),
    endPrice: end.close,
    endAt: end.at,
    endDate: end.sessionDate || end.at.slice(0, 10),
    sessions: endIndex - baselineIndex,
    priceMode: baseline.priceMode === 'adjusted' && end.priceMode === 'adjusted' ? 'adjusted' : 'raw-fallback'
  };
}

function sameUtcDate(left, right) {
  return new Date(left).toISOString().slice(0, 10) === new Date(right).toISOString().slice(0, 10);
}

function parseYahooThemeHistory(payload, nowMs = Date.now()) {
  const histories = new Map();
  const rows = payload?.spark?.result;
  if (!Array.isArray(rows)) return histories;
  for (const row of rows) {
    const symbol = normalizeSymbol(row?.symbol);
    const chart = row?.response?.[0];
    const allPoints = normalizeHistoryPoints(chart, symbol);
    const marketState = inferMarketState(chart?.meta, nowMs);
    const regularMarketTime = Number(chart?.meta?.regularMarketTime) * 1000;
    const currentRegularPeriod = chart?.meta?.currentTradingPeriod?.regular || {};
    const regularMarketTimeSeconds = Number(chart?.meta?.regularMarketTime);
    const regularMarketTimeIsCurrent = Number.isFinite(regularMarketTimeSeconds) &&
      Number(currentRegularPeriod.start) <= regularMarketTimeSeconds &&
      regularMarketTimeSeconds <= Number(currentRegularPeriod.end);
    const hasOpenSessionPoint = marketState === 'open' && allPoints.length > 0 &&
      Number.isFinite(regularMarketTime) && regularMarketTimeIsCurrent &&
      sameUtcDate(allPoints.at(-1).timestamp * 1000, regularMarketTime);
    const points = hasOpenSessionPoint ? allPoints.slice(0, -1) : allPoints;
    if (symbol && points.length) {
      const adjusted = points.filter(point => point.priceMode === 'adjusted').length;
      const raw = points.length - adjusted;
      histories.set(symbol, {
        points,
        currency: chart?.meta?.currency || 'USD',
        exchange: chart?.meta?.fullExchangeName || chart?.meta?.exchangeName || null,
        priceMode: raw === 0 ? 'adjusted' : (adjusted ? 'mixed' : 'raw'),
        source: 'yahoo-spark',
        excludedOpenSession: hasOpenSessionPoint,
        volumeAvailable: points.some(point => Number.isFinite(point.volume))
      });
    }
  }
  return histories;
}

function parseYahooChartHistory(payload, symbol, nowMs = Date.now()) {
  const normalized = normalizeSymbol(symbol);
  const chart = payload?.chart?.result?.[0];
  if (!normalized || !chart) return null;
  const histories = parseYahooThemeHistory({
    spark: {
      result: [{ symbol: normalized, response: [chart] }]
    }
  }, nowMs);
  const history = histories.get(normalized);
  return history ? { ...history, source: 'yahoo-chart-v8-adjusted' } : null;
}

function normalizeTechnicalBars(chart) {
  const timestamps = Array.isArray(chart?.timestamp) ? chart.timestamp : [];
  const quote = chart?.indicators?.quote?.[0] || {};
  const opens = Array.isArray(quote.open) ? quote.open : [];
  const highs = Array.isArray(quote.high) ? quote.high : [];
  const lows = Array.isArray(quote.low) ? quote.low : [];
  const closes = Array.isArray(quote.close) ? quote.close : [];
  const volumes = Array.isArray(quote.volume) ? quote.volume : [];
  const adjusted = Array.isArray(chart?.indicators?.adjclose?.[0]?.adjclose)
    ? chart.indicators.adjclose[0].adjclose
    : [];
  const candidates = [];
  const length = Math.min(timestamps.length, closes.length);
  for (let index = 0; index < length; index += 1) {
    const timestamp = Number(timestamps[index]);
    const rawClose = parseNumber(closes[index]);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || !(rawClose > 0)) continue;
    const rawOpen = parseNumber(opens[index]);
    const rawHigh = parseNumber(highs[index]);
    const rawLow = parseNumber(lows[index]);
    if (!(rawOpen > 0) || !(rawHigh > 0) || !(rawLow > 0)) continue;
    const open = rawOpen;
    const high = rawHigh;
    const low = rawLow;
    const adjustedClose = parseNumber(adjusted[index]);
    const volume = parseNumber(volumes[index]);
    candidates.push({
      timestamp,
      at: new Date(timestamp * 1000).toISOString(),
      sessionDate: new Date(timestamp * 1000).toISOString().slice(0, 10),
      rawOpen: open,
      rawHigh: Math.max(high, open, rawClose),
      rawLow: Math.min(low, open, rawClose),
      rawClose,
      adjustedClose: adjustedClose > 0 ? adjustedClose : null,
      volume: Number.isFinite(volume) && volume >= 0 ? Math.round(volume) : null
    });
  }
  const useAdjusted = candidates.length > 0 &&
    candidates.every(point => point.adjustedClose > 0 && point.rawClose > 0);
  return candidates.map(point => {
    const factor = useAdjusted ? point.adjustedClose / point.rawClose : 1;
    return {
      timestamp: point.timestamp,
      at: point.at,
      sessionDate: point.sessionDate,
      open: +(point.rawOpen * factor).toFixed(6),
      high: +(point.rawHigh * factor).toFixed(6),
      low: +(point.rawLow * factor).toFixed(6),
      close: +(useAdjusted ? point.adjustedClose : point.rawClose).toFixed(6),
      rawClose: +point.rawClose.toFixed(6),
      volume: point.volume,
      priceMode: useAdjusted ? 'adjusted' : 'raw'
    };
  });
}

function parseYahooTechnicalHistory(payload, nowMs = Date.now()) {
  const histories = new Map();
  const rows = payload?.spark?.result;
  if (!Array.isArray(rows)) return histories;
  for (const row of rows) {
    const symbol = normalizeSymbol(row?.symbol);
    const chart = row?.response?.[0];
    const allBars = normalizeTechnicalBars(chart);
    const expectedBars = Array.isArray(chart?.timestamp)
      ? chart.timestamp.filter((timestamp, index) => (
          Number(timestamp) > 0 &&
          (parseNumber(chart?.indicators?.quote?.[0]?.close?.[index]) ?? 0) > 0
        )).length
      : 0;
    const marketState = inferMarketState(chart?.meta, nowMs);
    const regularMarketTime = Number(chart?.meta?.regularMarketTime) * 1000;
    const currentRegularPeriod = chart?.meta?.currentTradingPeriod?.regular || {};
    const regularMarketTimeSeconds = Number(chart?.meta?.regularMarketTime);
    const regularMarketTimeIsCurrent = Number.isFinite(regularMarketTimeSeconds) &&
      Number(currentRegularPeriod.start) <= regularMarketTimeSeconds &&
      regularMarketTimeSeconds <= Number(currentRegularPeriod.end);
    const hasOpenSessionBar = marketState === 'open' && allBars.length > 0 &&
      Number.isFinite(regularMarketTime) && regularMarketTimeIsCurrent &&
      sameUtcDate(allBars.at(-1).timestamp * 1000, regularMarketTime);
    const bars = hasOpenSessionBar ? allBars.slice(0, -1) : allBars;
    if (!symbol || !bars.length) continue;
    const adjusted = bars.every(bar => bar.priceMode === 'adjusted');
    histories.set(symbol, {
      bars,
      currency: chart?.meta?.currency || 'USD',
      exchange: chart?.meta?.fullExchangeName || chart?.meta?.exchangeName || null,
      quoteType: chart?.meta?.quoteType || chart?.meta?.instrumentType || null,
      instrumentType: chart?.meta?.instrumentType || chart?.meta?.quoteType || null,
      longName: chart?.meta?.longName || null,
      shortName: chart?.meta?.shortName || null,
      priceMode: adjusted ? 'adjusted' : 'raw',
      source: 'yahoo-spark-5y-1d',
      range: '5y',
      interval: '1d',
      excludedOpenSession: hasOpenSessionBar,
      volumeAvailable: bars.some(bar => Number.isFinite(bar.volume)),
      ohlcCoveragePct: expectedBars
        ? Math.round((allBars.length / expectedBars) * 100)
        : 0,
      partial: expectedBars > allBars.length
    });
  }
  return histories;
}

function parseYahooTechnicalChartHistory(payload, requestedSymbol, nowMs = Date.now()) {
  const chart = payload?.chart?.result?.[0];
  const symbol = normalizeSymbol(chart?.meta?.symbol || requestedSymbol);
  if (!chart || !symbol) return null;
  const parsed = parseYahooTechnicalHistory({
    spark: {
      result: [{ symbol, response: [chart] }]
    }
  }, nowMs);
  const history = parsed.get(symbol);
  return history
    ? { ...history, source: 'yahoo-chart-v8-5y-1d' }
    : null;
}

function performanceValues(periods) {
  return Object.fromEntries(Object.keys(THEME_PERIODS).map(key => [key, periods[key]?.valuePct ?? null]));
}

function themeSignals(leaders) {
  const signals = {};
  for (const key of Object.keys(THEME_PERIODS)) {
    const available = leaders
      .map(leader => ({ symbol: leader.symbol, valuePct: leader.performance[key] }))
      .filter(item => Number.isFinite(item.valuePct));
    const sorted = [...available].sort((left, right) => right.valuePct - left.valuePct);
    const positive = available.filter(item => item.valuePct > 0).length;
    const negative = available.filter(item => item.valuePct < 0).length;
    signals[key] = {
      available: available.length,
      positive,
      negative,
      flat: available.length - positive - negative,
      breadthPct: available.length ? Math.round((positive / available.length) * 100) : null,
      best: sorted[0] || null,
      worst: sorted.at(-1) || null
    };
  }
  return signals;
}

function buildThemePayload(histories, retrievedAt) {
  const unavailable = new Set();
  const periodGaps = [];
  const themes = THEME_CATALOG.map(entry => {
    const leaders = entry.members.map(member => {
      const history = histories.get(member.symbol);
      const historyPoints = consistentHistoryPoints(history);
      if (!historyPoints.length) {
        unavailable.add(member.symbol);
        return {
          symbol: member.symbol,
          name: member.name,
          price: null,
          currency: 'USD',
          exchange: null,
          at: null,
          sessionDate: null,
          freshness: 'unavailable',
          status: 'unavailable',
          historyPriceMode: null,
          performance: performanceValues({}),
          periods: Object.fromEntries(Object.keys(THEME_PERIODS).map(key => [key, null]))
        };
      }

      const periods = Object.fromEntries(Object.keys(THEME_PERIODS).map(key => {
        const detail = calculatePeriodPerformance(historyPoints, key);
        if (!detail) periodGaps.push({ symbol: member.symbol, period: key });
        return [key, detail];
      }));
      const latest = historyPoints.at(-1);
      const complete = Object.values(periods).every(Boolean);
      return {
        symbol: member.symbol,
        name: member.name,
        price: latest.rawClose || latest.close,
        currency: history.currency || 'USD',
        exchange: history.exchange || null,
        at: latest.at,
        sessionDate: latest.sessionDate,
        freshness: 'close-valid',
        status: complete ? 'ok' : 'partial',
        historyPriceMode: history.priceMode,
        performance: performanceValues(periods),
        periods
      };
    });

    const performance = {};
    const coverage = {};
    for (const key of Object.keys(THEME_PERIODS)) {
      const values = leaders.map(leader => leader.performance[key]).filter(Number.isFinite);
      performance[key] = values.length
        ? +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6)
        : null;
      coverage[key] = { returned: values.length, requested: leaders.length };
    }
    const returned = leaders.filter(leader => leader.freshness !== 'unavailable').length;
    const complete = returned === leaders.length && leaders.every(leader => leader.status === 'ok');
    const periods = Object.fromEntries(Object.keys(THEME_PERIODS).map(key => {
      const details = leaders.map(leader => leader.periods[key]).filter(Boolean);
      const baselineDates = details.map(detail => detail.baselineAt).sort();
      const endDates = details.map(detail => detail.endAt).sort();
      return [key, {
        valuePct: performance[key],
        coverage: coverage[key],
        baselineAt: baselineDates[0] || null,
        endAt: endDates.at(-1) || null,
        baselineRange: baselineDates.length ? { from: baselineDates[0], to: baselineDates.at(-1) } : null,
        endRange: endDates.length ? { from: endDates[0], to: endDates.at(-1) } : null
      }];
    }));
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      catalogVersion: THEME_CATALOG_VERSION,
      symbols: entry.members.map(member => member.symbol),
      performance,
      periods,
      coverage,
      signals: themeSignals(leaders),
      leaders,
      status: returned === 0 ? 'unavailable' : (complete ? 'ok' : 'partial')
    };
  });

  const requestedSymbols = [...new Set(THEME_CATALOG.flatMap(entry => entry.members.map(member => member.symbol)))];
  const returnedSymbols = requestedSymbols.length - unavailable.size;
  const latestAt = themes
    .flatMap(entry => entry.leaders.map(leader => leader.at))
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const status = returnedSymbols === 0
    ? 'unavailable'
    : (unavailable.size || periodGaps.length ? 'partial' : 'ok');

  return {
    updatedAt: retrievedAt,
    asOf: latestAt,
    dataRevision: themeDataRevision(themes),
    status,
    partial: status !== 'ok',
    errors: [...unavailable].sort(),
    themes,
    meta: {
      source: 'yahoo-chart',
      catalogVersion: THEME_CATALOG_VERSION,
      requestedSymbols: requestedSymbols.length,
      returnedSymbols,
      periodGaps,
      periods: THEME_PERIODS,
      method: 'equal-weight arithmetic mean of available constituents',
      batching: {
        maxSymbolsPerRequest: DEFAULT_THEME_BATCH_SIZE,
        coldRefreshRequests: Math.ceil(requestedSymbols.length / DEFAULT_THEME_BATCH_SIZE),
        retry: 'missing symbols only, once on alternate host'
      },
      pricePolicy: {
        performance: 'adjusted close preferred; a whole-symbol raw-close series is used when adjusted history is incomplete (pointwise mixing is forbidden)',
        currentPrice: 'latest confirmed raw session close',
        openSession: 'in-progress daily bar is excluded while the regular market is open',
        timestamps: 'provider timestamps identify trading sessions; returned values are session closes'
      },
      adjustedSymbols: [...histories.entries()]
        .filter(([, history]) => history.priceMode === 'adjusted')
        .map(([symbol]) => symbol)
        .sort(),
      rawFallbackSymbols: [...histories.entries()]
        .filter(([, history]) => history.priceMode !== 'adjusted')
        .map(([symbol]) => symbol)
        .sort(),
      excludedOpenSessionSymbols: [...histories.entries()]
        .filter(([, history]) => history.excludedOpenSession)
        .map(([symbol]) => symbol)
        .sort()
    }
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function themeDataRevision(themes) {
  const fingerprint = themes.map(entry => [
    entry.id,
    entry.leaders.map(leader => [leader.symbol, leader.at, leader.performance])
  ]);
  const digest = crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex').slice(0, 16);
  return `theme-market-v1:${digest}`;
}

function selectThemePayload(payload, ids, options = {}) {
  const selectedIds = ids?.length ? new Set(ids) : null;
  const themes = cloneJson(payload.themes)
    .filter(entry => !selectedIds || selectedIds.has(entry.id));
  const selectedSymbols = new Set(themes.flatMap(entry => entry.symbols));
  const returnedSymbols = new Set(themes.flatMap(entry => entry.leaders
    .filter(leader => leader.freshness !== 'unavailable')
    .map(leader => leader.symbol)));
  const errors = payload.errors.filter(symbol => selectedSymbols.has(symbol));
  const periodGaps = (payload.meta.periodGaps || []).filter(gap => selectedSymbols.has(gap.symbol));
  const stale = Boolean(options.stale);
  if (stale) {
    for (const entry of themes) {
      if (entry.status === 'ok') entry.status = 'partial';
      for (const leader of entry.leaders) leader.cacheState = 'stale-fallback';
    }
  }
  const unavailable = returnedSymbols.size === 0;
  const partial = unavailable || stale || themes.some(entry => entry.status !== 'ok');
  const status = unavailable ? 'unavailable' : (partial ? 'partial' : 'ok');
  const asOf = themes.flatMap(entry => entry.leaders.map(leader => leader.at)).filter(Boolean).sort().at(-1) || null;
  const requestedCount = selectedSymbols.size;
  const returnedCount = returnedSymbols.size;
  const durationMs = Math.max(0, Number(options.durationMs) || 0);
  const payloadMeta = cloneJson(payload.meta);
  for (const key of ['adjustedSymbols', 'rawFallbackSymbols', 'excludedOpenSessionSymbols']) {
    payloadMeta[key] = (payloadMeta[key] || []).filter(symbol => selectedSymbols.has(symbol));
  }
  return {
    updatedAt: payload.updatedAt,
    asOf,
    dataRevision: themeDataRevision(themes),
    status,
    partial,
    errors,
    themes,
    meta: {
      ...payloadMeta,
      requestedSymbols: requestedCount,
      returnedSymbols: returnedCount,
      periodGaps,
      cache: options.cache || 'refreshed',
      stale,
      ageMs: Number.isFinite(options.ageMs) ? Math.max(0, options.ageMs) : 0,
      durationMs,
      status: unavailable ? 'error' : (partial ? 'partial' : 'ok'),
      quality: {
        coveragePct: requestedCount ? Math.round((returnedCount / requestedCount) * 100) : 100,
        fresh: stale ? 0 : returnedCount,
        live: 0,
        closeValid: stale ? 0 : returnedCount,
        stale: stale ? returnedCount : 0,
        failed: errors.length,
        delayed: 0,
        aged: 0,
        reference: 0,
        unverified: periodGaps.length,
        consensusWarnings: 0,
        grade: unavailable ? 'unavailable' : (stale ? 'stale' : (partial ? 'partial' : 'close-valid'))
      }
    }
  };
}

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const rounded = (value, digits = 6) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function marketRegimeClassification(score) {
  if (!Number.isFinite(score)) return { id: 'unavailable', label: '判定不能' };
  if (score <= 29) return { id: 'danger', label: '危険' };
  if (score <= 44) return { id: 'caution', label: '警戒' };
  if (score <= 64) return { id: 'neutral', label: '中立' };
  return { id: 'optimistic', label: '楽観' };
}

function marketRegimePriceMode(history, symbol = '') {
  if (symbol === '^VIX') return history?.priceMode === 'mixed' ? 'mixed-native-close-reference' : 'native-index-close';
  if (symbol === 'CL=F') return history?.priceMode === 'mixed' ? 'mixed-native-close-reference' : 'native-futures-close';
  if (history?.priceMode === 'adjusted') return 'adjusted-close';
  if (history?.priceMode === 'mixed') return 'mixed-close-reference';
  return 'raw-close-reference';
}

function marketRegimePointClose(history, point) {
  const selected = history?.priceMode === 'adjusted'
    ? parseNumber(point?.close)
    : parseNumber(point?.rawClose);
  return Number.isFinite(selected) ? selected : null;
}

function marketRegimePlausibleLevel(symbol, value) {
  if (!Number.isFinite(value)) return false;
  if (symbol === '^VIX') return value >= 5 && value <= 200;
  if (symbol === 'CL=F') return value >= -100 && value <= 500;
  if (symbol === 'SPY') return value >= 1 && value <= 100_000;
  return value > 0;
}

function marketRegimeInstrument(symbol, history, canonicalDates, asOf) {
  const points = Array.isArray(history?.points) ? history.points : [];
  const byDate = new Map(points.flatMap(point => {
    const date = point?.sessionDate || point?.at?.slice?.(0, 10);
    return date ? [[date, point]] : [];
  }));
  const endIndex = canonicalDates.indexOf(asOf);
  const endPoint = byDate.get(asOf) || null;
  const level = marketRegimePointClose(history, endPoint);
  const plausible = marketRegimePlausibleLevel(symbol, level);
  const changesPct = {};
  const changesPoints = {};
  const baselines = {};
  const missingHorizons = [];

  for (const sessions of MARKET_REGIME_HORIZONS) {
    const key = `${sessions}d`;
    const baselineDate = endIndex >= sessions ? canonicalDates[endIndex - sessions] : null;
    const baselinePoint = baselineDate ? byDate.get(baselineDate) : null;
    const baseline = marketRegimePointClose(history, baselinePoint);
    const valid = plausible && marketRegimePlausibleLevel(symbol, baseline) && level > 0 && baseline > 0;
    changesPct[key] = valid ? rounded(((level / baseline) - 1) * 100, 3) : null;
    changesPoints[key] = valid ? rounded(level - baseline, 3) : null;
    baselines[key] = {
      date: baselineDate,
      level: valid ? rounded(baseline, 6) : null,
      exactSession: Boolean(baselineDate && baselinePoint && valid)
    };
    if (!Number.isFinite(changesPct[key])) missingHorizons.push(key);
  }

  const priceMode = marketRegimePriceMode(history, symbol);
  const endTrailIndex = canonicalDates.indexOf(asOf);
  const trailDates = endTrailIndex >= 0
    ? canonicalDates.slice(Math.max(0, endTrailIndex - 20), endTrailIndex + 1)
    : [];
  const trail = trailDates.map(date => {
    const point = byDate.get(date);
    const value = marketRegimePointClose(history, point);
    return {
      date,
      value: marketRegimePlausibleLevel(symbol, value) ? rounded(value, 6) : null
    };
  });
  const names = {
    '^VIX': 'VIX',
    'CL=F': 'WTI原油',
    SPY: 'S&P 500 (SPY)'
  };
  const priceBasis = symbol === '^VIX'
    ? { id: 'native-index-close', adjustmentApplicable: false, note: 'VIX指数のネイティブ終値' }
    : (symbol === 'CL=F'
        ? { id: 'continuous-front-month-futures-close', adjustmentApplicable: false, note: '限月ロールの影響を含む連続先物系列' }
        : { id: 'etf-close', adjustmentApplicable: true, note: '未調整時は配当・分割の影響を含み得るETF終値' });
  const instrumentContract = symbol === '^VIX'
    ? { instrumentType: 'volatility-index', tradable: false, spot: true, continuousContract: false, rollAdjusted: false }
    : (symbol === 'CL=F'
        ? { instrumentType: 'continuous-front-month-futures', tradable: false, spot: false, continuousContract: true, rollAdjusted: false }
        : { instrumentType: 'exchange-traded-fund', tradable: true, spot: false, continuousContract: false, rollAdjusted: false });
  return {
    symbol,
    name: names[symbol] || symbol,
    value: plausible ? rounded(level, 6) : null,
    level: plausible ? rounded(level, 6) : null,
    asOf,
    status: !endPoint || !plausible ? 'unavailable' : (missingHorizons.length ? 'partial' : 'ok'),
    changes: changesPct,
    changesPct,
    changesPoints,
    trail,
    baselines,
    historySamples: points.filter(point => {
      const date = point?.sessionDate || point?.at?.slice?.(0, 10);
      return date && date <= asOf;
    }).length,
    priceMode,
    source: history?.source || 'yahoo-spark',
    priceBasis,
    adjustmentApplicable: priceBasis.adjustmentApplicable,
    ...instrumentContract,
    adjusted: priceMode === 'adjusted-close',
    plausible,
    missingHorizons,
    available: Boolean(endPoint && plausible),
    invalidReason: !endPoint
      ? 'exact-common-session-missing'
      : (!Number.isFinite(level)
          ? 'close-missing'
          : (!plausible ? 'implausible-level' : null)),
    returnUndefinedReason: symbol === 'CL=F' && plausible && level <= 0
      ? 'nonpositive-futures-level'
      : (missingHorizons.length ? 'exact-positive-endpoint-missing' : null)
  };
}

function scoreMarketRegime(indicators) {
  const vix = indicators?.vix || {};
  const wti = indicators?.wti || {};
  const spy = indicators?.spy || {};
  const contributions = [];
  const add = (factor, value, points, reason) => {
    if (!Number.isFinite(value) || !Number.isFinite(points)) return;
    contributions.push({ factor, value: rounded(value, 3), points, reason });
  };

  const vixLevel = vix.level;
  if (Number.isFinite(vixLevel)) {
    if (vixLevel >= 35) add('vix-level', vixLevel, -25, 'VIXが35以上で非常に高い予想変動域');
    else if (vixLevel >= 30) add('vix-level', vixLevel, -20, 'VIXが30以上で高いストレス域');
    else if (vixLevel >= 25) add('vix-level', vixLevel, -14, 'VIXが25以上で強い警戒域');
    else if (vixLevel > 20) add('vix-level', vixLevel, -7, 'VIXが20を上回る高ボラティリティ域');
    else if (vixLevel < 12) add('vix-level', vixLevel, 15, 'VIXが12未満の低ボラティリティ域');
    else if (vixLevel <= 16) add('vix-level', vixLevel, 8, 'VIXが16以下の比較的穏やかな領域');
    else add('vix-level', vixLevel, 0, 'VIXが通常域');
  }

  const vixRules = [
    ['1d', 20, 10, -10, -6, -15, -8, 6, 3, 2, 1, -3, -1],
    ['5d', 30, 15, -12, -7, -20, -10, 8, 4, 5, 3, -7, -3],
    ['20d', 50, 25, -10, -6, -25, -12, 7, 3, 10, 5, -12, -5]
  ];
  const vixChangeContributions = [];
  for (const [key, high, elevated, highPoints, elevatedPoints, low, easing, lowPoints, easingPoints,
    pointHigh, pointElevated, pointLow, pointEasing] of vixRules) {
    const value = vix.changesPct?.[key];
    const pointsChange = vix.changesPoints?.[key];
    if (!Number.isFinite(value)) continue;
    const detail = Number.isFinite(pointsChange) ? `（${pointsChange >= 0 ? '+' : ''}${pointsChange}pt）` : '';
    if (value >= high || pointsChange >= pointHigh) vixChangeContributions.push({ factor: `vix-${key}`, value, points: highPoints, reason: `VIXが${key}で急上昇${detail}` });
    else if (value >= elevated || pointsChange >= pointElevated) vixChangeContributions.push({ factor: `vix-${key}`, value, points: elevatedPoints, reason: `VIXが${key}で上昇${detail}` });
    else if (value <= low || pointsChange <= pointLow) vixChangeContributions.push({ factor: `vix-${key}`, value, points: lowPoints, reason: `VIXが${key}で大きく低下${detail}` });
    else if (value <= easing || pointsChange <= pointEasing) vixChangeContributions.push({ factor: `vix-${key}`, value, points: easingPoints, reason: `VIXが${key}で低下${detail}` });
  }
  const strongestVixChange = (
    vixChangeContributions.filter(contribution => contribution.points < 0)
      .sort((left, right) => left.points - right.points)[0] ||
    vixChangeContributions.filter(contribution => contribution.points > 0)
      .sort((left, right) => right.points - left.points)[0]
  );
  if (strongestVixChange) add(strongestVixChange.factor, strongestVixChange.value, strongestVixChange.points, strongestVixChange.reason);

  const spyRules = [
    ['1d', -3, -1.5, -12, -7, 1.5, 0.75, 6, 3],
    ['5d', -7, -4, -14, -9, 5, 2.5, 10, 6],
    ['20d', -15, -8, -16, -11, 12, 7, 13, 8]
  ];
  const spyChangeContributions = [];
  for (const [key, severe, weak, severePoints, weakPoints, strong, positive, strongPoints, positivePoints] of spyRules) {
    const value = spy.changesPct?.[key];
    if (!Number.isFinite(value)) continue;
    if (value <= severe) spyChangeContributions.push({ factor: `spy-${key}`, value, points: severePoints, reason: `SPYが${key}で急落` });
    else if (value <= weak) spyChangeContributions.push({ factor: `spy-${key}`, value, points: weakPoints, reason: `SPYが${key}で下落` });
    else if (value >= strong) spyChangeContributions.push({ factor: `spy-${key}`, value, points: strongPoints, reason: `SPYが${key}で強く上昇` });
    else if (value >= positive) spyChangeContributions.push({ factor: `spy-${key}`, value, points: positivePoints, reason: `SPYが${key}で上昇` });
  }
  const strongestSpyChange = (
    spyChangeContributions.filter(contribution => contribution.points < 0)
      .sort((left, right) => left.points - right.points)[0] ||
    spyChangeContributions.filter(contribution => contribution.points > 0)
      .sort((left, right) => right.points - left.points)[0]
  );
  if (strongestSpyChange) add(strongestSpyChange.factor, strongestSpyChange.value, strongestSpyChange.points, strongestSpyChange.reason);
  else {
    const representativeSpyChange = MARKET_REGIME_HORIZONS
      .map(sessions => spy.changesPct?.[`${sessions}d`])
      .filter(Number.isFinite)
      .sort((left, right) => Math.abs(right) - Math.abs(left))[0];
    if (Number.isFinite(representativeSpyChange)) {
      add(
        'spy-threshold-range',
        representativeSpyChange,
        0,
        'SPYの1・5・20日変化は警戒・楽観の判定閾値内'
      );
    }
  }

  const oilStressRules = [
    { key: '1d', oil: 7, vix: 10, spy: -2, points: -5 },
    { key: '5d', oil: 12, vix: 15, spy: -4, points: -8 },
    { key: '20d', oil: 20, vix: 25, spy: -8, points: -10 }
  ];
  const confirmedOilShock = oilStressRules
    .filter(rule => Number.isFinite(wti.changesPct?.[rule.key]) &&
      wti.changesPct[rule.key] >= rule.oil &&
      ((Number.isFinite(vix.changesPct?.[rule.key]) && vix.changesPct[rule.key] >= rule.vix) ||
       (Number.isFinite(spy.changesPct?.[rule.key]) && spy.changesPct[rule.key] <= rule.spy)))
    .sort((left, right) => left.points - right.points)[0];
  if (confirmedOilShock) {
    add(
      `wti-up-${confirmedOilShock.key}`,
      wti.changesPct[confirmedOilShock.key],
      confirmedOilShock.points,
      `WTI急騰をVIX上昇またはSPY下落が確認（${confirmedOilShock.key}）`
    );
  } else if (MARKET_REGIME_HORIZONS.some(sessions => (wti.changesPct?.[`${sessions}d`] || 0) > 0)) {
    add('wti-up-unconfirmed', Math.max(...MARKET_REGIME_HORIZONS.map(sessions => wti.changesPct?.[`${sessions}d`] || 0)), 0,
      '原油上昇だけでは危険判定にしない');
  }

  const oilCollapseRules = [
    { key: '1d', oil: -10, vixStress: 5, spyStress: -1, vixRelief: -5, spyRelief: 1, riskPoints: -4, reliefPoints: 2 },
    { key: '5d', oil: -15, vixStress: 10, spyStress: -3, vixRelief: -8, spyRelief: 2, riskPoints: -7, reliefPoints: 4 },
    { key: '20d', oil: -25, vixStress: 15, spyStress: -5, vixRelief: -10, spyRelief: 4, riskPoints: -10, reliefPoints: 6 }
  ];
  const oilCollapseCandidates = oilCollapseRules
    .filter(rule => Number.isFinite(wti.changesPct?.[rule.key]) && wti.changesPct[rule.key] <= rule.oil)
    .map(rule => {
      const vixChange = vix.changesPct?.[rule.key];
      const spyChange = spy.changesPct?.[rule.key];
      const demandScare = (Number.isFinite(vixChange) && vixChange >= rule.vixStress) ||
        (Number.isFinite(spyChange) && spyChange <= rule.spyStress);
      const disinflationRelief = (Number.isFinite(vixChange) && vixChange <= rule.vixRelief) &&
        (Number.isFinite(spyChange) && spyChange >= rule.spyRelief);
      return {
        ...rule,
        context: demandScare ? 'demand-scare' : (disinflationRelief ? 'disinflation' : 'unconfirmed')
      };
    });
  const oilDemandScare = oilCollapseCandidates
    .filter(candidate => candidate.context === 'demand-scare')
    .sort((left, right) => left.riskPoints - right.riskPoints)[0];
  const oilRelief = oilCollapseCandidates
    .filter(candidate => candidate.context === 'disinflation')
    .sort((left, right) => right.reliefPoints - left.reliefPoints)[0];
  const oilUnconfirmed = oilCollapseCandidates
    .filter(candidate => candidate.context === 'unconfirmed')
    .sort((left, right) => left.riskPoints - right.riskPoints)[0];
  if (oilDemandScare) {
    add(`wti-down-demand-scare-${oilDemandScare.key}`, wti.changesPct[oilDemandScare.key], oilDemandScare.riskPoints,
      `WTI急落をVIX上昇またはSPY下落が伴う需要不安として警戒（${oilDemandScare.key}）`);
  } else if (oilRelief) {
    add(`wti-down-disinflation-${oilRelief.key}`, wti.changesPct[oilRelief.key], oilRelief.reliefPoints,
      `WTI急落とVIX低下・SPY上昇の組合せをインフレ緩和として評価（${oilRelief.key}）`);
  } else if (oilUnconfirmed) {
    add(`wti-down-unconfirmed-${oilUnconfirmed.key}`, wti.changesPct[oilUnconfirmed.key], 0,
      `WTI急落だけでは需要不安か供給要因かを断定しない（${oilUnconfirmed.key}）`);
  }
  if (!contributions.some(contribution => contribution.factor.startsWith('wti-'))) {
    const representativeWtiChange = MARKET_REGIME_HORIZONS
      .map(sessions => wti.changesPct?.[`${sessions}d`])
      .filter(Number.isFinite)
      .sort((left, right) => Math.abs(right) - Math.abs(left))[0];
    if (Number.isFinite(representativeWtiChange)) {
      add(
        'wti-threshold-range',
        representativeWtiChange,
        0,
        'WTIは確認済みの急騰・急落条件に該当せず、単独では危険判定にしない'
      );
    }
  }

  const rawScore = 50 + contributions.reduce((sum, contribution) => sum + contribution.points, 0);
  let score = Math.round(clamp(rawScore, 0, 100));
  let vixCap = 100;
  if (Number.isFinite(vixLevel)) {
    if (vixLevel >= 40) vixCap = 20;
    else if (vixLevel >= 30) vixCap = 29;
    else if (vixLevel >= 25) vixCap = 44;
    else if (vixLevel > 20) vixCap = 64;
    const previousVix = vix.trail?.at?.(-2)?.value;
    if (Number.isFinite(previousVix) && previousVix >= 30 && vixLevel < 30) vixCap = Math.min(vixCap, 44);
    else if (Number.isFinite(previousVix) && previousVix >= 25 && vixLevel < 25) vixCap = Math.min(vixCap, 64);
  }
  if (score > vixCap) {
    add('vix-hard-cap', vixLevel, vixCap - score, `VIX水準による楽観上限 ${vixCap}`);
    score = vixCap;
  }
  const classification = marketRegimeClassification(score);
  const componentPoints = {};
  for (const contribution of contributions) {
    const component = contribution.factor.split('-')[0];
    componentPoints[component] = (componentPoints[component] || 0) + contribution.points;
  }
  const ranked = [...contributions]
    .filter(contribution => contribution.points !== 0)
    .sort((left, right) => Math.abs(right.points) - Math.abs(left.points));
  const rationaleContributions = ranked.slice(0, 5);
  if (rationaleContributions.length < 3) {
    const includedReasons = new Set(rationaleContributions.map(contribution => contribution.reason));
    for (const contribution of contributions.filter(candidate => candidate.points === 0)) {
      if (includedReasons.has(contribution.reason)) continue;
      rationaleContributions.push(contribution);
      includedReasons.add(contribution.reason);
      if (rationaleContributions.length >= 3) break;
    }
  }

  return {
    score,
    classification,
    contributions,
    componentPoints,
    rationale: rationaleContributions.map(contribution => contribution.reason),
    scale: { minimum: 0, maximum: 100, direction: '0=danger, 100=optimistic' }
  };
}

function buildMarketRegimePayload(histories, retrievedAt) {
  const source = histories instanceof Map ? histories : new Map();
  const historiesBySymbol = new Map(MARKET_REGIME_SYMBOLS.map(symbol => [symbol, source.get(symbol)]));
  const spyAdjustedRefreshFallback = historiesBySymbol.get('SPY')?.refreshFallback === true;
  const spyAdjustedRefreshFallbackAgeMs = spyAdjustedRefreshFallback &&
    Number.isFinite(Number(historiesBySymbol.get('SPY')?.refreshFallbackCacheAgeMs))
    ? Math.max(0, Number(historiesBySymbol.get('SPY').refreshFallbackCacheAgeMs))
    : null;
  const datesFor = history => new Set((Array.isArray(history?.points) ? history.points : []).flatMap(point => {
    const date = point?.sessionDate || point?.at?.slice?.(0, 10);
    return date ? [date] : [];
  }));
  const spyHistory = historiesBySymbol.get('SPY');
  const spyDates = [...datesFor(spyHistory)].sort();
  const vixDates = datesFor(historiesBySymbol.get('^VIX'));
  const oilDates = datesFor(historiesBySymbol.get('CL=F'));
  const commonDates = spyDates.filter(date => vixDates.has(date) && oilDates.has(date));
  const commonAsOf = commonDates.at(-1) || null;
  const vixSpyDates = spyDates.filter(date => vixDates.has(date));
  const fallbackVixDates = [...vixDates].sort();
  const asOf = commonAsOf || vixSpyDates.at(-1) || fallbackVixDates.at(-1) || null;
  const canonicalDates = spyDates.length ? spyDates : fallbackVixDates;
  const latestSpyDate = spyDates.at(-1) || null;
  const synchronizationLagSessions = commonAsOf && latestSpyDate
    ? spyDates.filter(date => date > commonAsOf).length
    : null;

  const emptyIndicator = symbol => ({
    symbol,
    name: symbol === '^VIX' ? 'VIX' : (symbol === 'CL=F' ? 'WTI原油' : 'S&P 500 (SPY)'),
    value: null,
    level: null,
    asOf,
    status: 'unavailable',
    changes: { '1d': null, '5d': null, '20d': null },
    changesPct: { '1d': null, '5d': null, '20d': null },
    changesPoints: { '1d': null, '5d': null, '20d': null },
    trail: [],
    baselines: {},
    historySamples: 0,
    priceMode: marketRegimePriceMode(historiesBySymbol.get(symbol), symbol),
    source: historiesBySymbol.get(symbol)?.source || 'yahoo-spark',
    priceBasis: symbol === '^VIX'
      ? { id: 'native-index-close', adjustmentApplicable: false, note: 'VIX指数のネイティブ終値' }
      : (symbol === 'CL=F'
          ? { id: 'continuous-front-month-futures-close', adjustmentApplicable: false, note: '限月ロールの影響を含む連続先物系列' }
          : { id: 'etf-close', adjustmentApplicable: true, note: '未調整時は配当・分割の影響を含み得るETF終値' }),
    adjustmentApplicable: symbol === 'SPY',
    instrumentType: symbol === '^VIX'
      ? 'volatility-index'
      : (symbol === 'CL=F' ? 'continuous-front-month-futures' : 'exchange-traded-fund'),
    tradable: symbol === 'SPY',
    spot: symbol === '^VIX',
    continuousContract: symbol === 'CL=F',
    rollAdjusted: false,
    adjusted: false,
    plausible: false,
    missingHorizons: ['1d', '5d', '20d'],
    available: false,
    invalidReason: 'common-confirmed-session-unavailable'
  });
  const instrument = symbol => asOf
    ? marketRegimeInstrument(symbol, historiesBySymbol.get(symbol), canonicalDates, asOf)
    : emptyIndicator(symbol);
  const indicators = {
    vix: instrument('^VIX'),
    wti: instrument('CL=F'),
    spy: instrument('SPY')
  };

  const observedAt = asOf
    ? ((Array.isArray(spyHistory?.points)
        ? spyHistory.points.find(point => (point.sessionDate || point.at?.slice?.(0, 10)) === asOf)?.at
        : null) ||
       historiesBySymbol.get('^VIX')?.points?.find(point => (point.sessionDate || point.at?.slice?.(0, 10)) === asOf)?.at)
    : null;
  const retrievedMs = Date.parse(String(retrievedAt || ''));
  const observedMs = Date.parse(String(observedAt || ''));
  const validClock = Number.isFinite(retrievedMs) && Number.isFinite(observedMs);
  const ageMs = validClock ? Math.max(0, retrievedMs - observedMs) : null;
  const futureSkewMs = validClock ? observedMs - retrievedMs : null;
  const observationStale = !validClock || futureSkewMs > 24 * 60 * 60 * 1000 ||
    ageMs > MARKET_REGIME_MAX_OBSERVATION_AGE_MS || (synchronizationLagSessions != null && synchronizationLagSessions !== 0);

  const allMetrics = Object.values(indicators).flatMap(value => [
    value.level,
    ...MARKET_REGIME_HORIZONS.map(sessions => value.changesPct[`${sessions}d`])
  ]);
  const availableMetrics = allMetrics.filter(Number.isFinite).length;
  const missingMetrics = allMetrics.length - availableMetrics;
  const missingSymbols = MARKET_REGIME_SYMBOLS.filter(symbol => !historiesBySymbol.get(symbol));
  const invalidSymbols = Object.values(indicators)
    .filter(value => !value.available || !value.plausible)
    .map(value => value.symbol);
  const spyPriceMode = indicators.spy.priceMode;
  const mixedNative = [indicators.vix, indicators.wti]
    .some(instrument => instrument.priceMode === 'mixed-native-close-reference');
  const referenceOnly = spyPriceMode !== 'adjusted-close' || mixedNative;
  const priceMode = mixedNative
    ? 'mixed-native-close-reference'
    : (referenceOnly ? spyPriceMode : 'instrument-native-with-adjusted-spy');
  const dataComplete = Boolean(commonAsOf) && missingMetrics === 0 && invalidSymbols.length === 0;
  const assessmentAvailable = dataComplete && !observationStale && synchronizationLagSessions === 0;
  const riskOverride = !assessmentAvailable && !observationStale &&
    Number.isFinite(indicators.vix.level) && indicators.vix.level >= 25;
  const stateAvailable = assessmentAvailable || riskOverride;
  const rawScored = scoreMarketRegime(indicators);
  const previousRawScores = [];
  if (assessmentAvailable) {
    const endIndex = canonicalDates.indexOf(asOf);
    for (const offset of [1, 2]) {
      const previousDate = endIndex >= offset ? canonicalDates[endIndex - offset] : null;
      if (!previousDate) continue;
      const previousIndicators = {
        vix: marketRegimeInstrument('^VIX', historiesBySymbol.get('^VIX'), canonicalDates, previousDate),
        wti: marketRegimeInstrument('CL=F', historiesBySymbol.get('CL=F'), canonicalDates, previousDate),
        spy: marketRegimeInstrument('SPY', historiesBySymbol.get('SPY'), canonicalDates, previousDate)
      };
      const previousComplete = Object.values(previousIndicators).every(value =>
        Number.isFinite(value.level) &&
        MARKET_REGIME_HORIZONS.every(sessions => Number.isFinite(value.changesPct[`${sessions}d`]))
      );
      if (previousComplete) {
        previousRawScores.push({
          date: previousDate,
          score: scoreMarketRegime(previousIndicators).score
        });
      }
    }
  }
  let scored = rawScored;
  const previousScore = previousRawScores[0]?.score;
  if (Number.isFinite(previousScore) && rawScored.score > previousScore + 12) {
    const cappedScore = previousScore + 12;
    const hysteresisContribution = {
      factor: 'risk-improvement-hysteresis',
      value: rawScored.score,
      points: cappedScore - rawScored.score,
      reason: '危険状態からの改善は1確定営業日あたり最大12点'
    };
    scored = {
      ...rawScored,
      score: cappedScore,
      classification: marketRegimeClassification(cappedScore),
      contributions: [...rawScored.contributions, hysteresisContribution],
      componentPoints: {
        ...rawScored.componentPoints,
        hysteresis: (rawScored.componentPoints.hysteresis || 0) + hysteresisContribution.points
      },
      rationale: [hysteresisContribution.reason, ...rawScored.rationale].slice(0, 5),
      rawScoreBeforeHysteresis: rawScored.score
    };
  }
  const status = riskOverride
    ? 'partial'
    : (!asOf || availableMetrics < 4
        ? 'unavailable'
        : (assessmentAvailable && !referenceOnly ? 'ok' : 'partial'));
  const completeness = allMetrics.length ? availableMetrics / allMetrics.length : 0;
  const priceConfidenceCap = !referenceOnly ? 85 : ((mixedNative || spyPriceMode === 'mixed-close-reference') ? 50 : 65);
  const confidence = Math.round(clamp(
    Math.min(100 * completeness * (observationStale ? 0.25 : 1), priceConfidenceCap),
    0,
    100
  ));
  const warnings = [];
  if (!commonAsOf) warnings.push('VIX・WTI・SPYの共通確定営業日がありません。');
  if (synchronizationLagSessions > 0) warnings.push('共通営業日がSPYの最新確定日より古いため参考判定です。');
  if (missingMetrics) warnings.push(`同一営業日の1D・5D・20D履歴が${missingMetrics}項目不足しています。`);
  if (referenceOnly) warnings.push('SPYが未調整または混在終値のため、配当・分割の影響を含む参考判定です。');
  if (observationStale) warnings.push('市場観測が古い、時刻が不正、または最新営業日に同期していません。');
  if (invalidSymbols.length) warnings.push(`非正値・極端値・欠損を検出: ${[...new Set(invalidSymbols)].join(', ')}`);
  if (indicators.wti.returnUndefinedReason) warnings.push('WTIがゼロ以下または正の厳密な比較点を欠くため、変化率は定義せず参考表示にします。');
  if (spyAdjustedRefreshFallback) {
    warnings.push('SPY調整後終値の再取得に失敗したため、同一営業日の正常キャッシュを有効期限内で再利用しています。');
  }
  warnings.push('VIX先物の期間構造は取得していません。スポットVIXと履歴のみの参考モデルです。');

  const revisionInput = {
    method: MARKET_REGIME_METHOD_VERSION,
    asOf,
    priceMode,
    indicators: Object.fromEntries(Object.entries(indicators).map(([key, value]) => [
      key,
      { level: value.level, changesPct: value.changesPct, priceMode: value.priceMode, source: value.source, trail: value.trail }
    ])),
    previousRawScores,
    finalScore: stateAvailable ? scored.score : null
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(revisionInput)).digest('hex').slice(0, 20);

  return {
    updatedAt: retrievedAt,
    asOf,
    observedAt: observedAt || null,
    dataRevision: `market-regime-v3:${digest}`,
    status,
    partial: status !== 'ok',
    regime: {
      state: stateAvailable ? scored.classification.id : 'unavailable',
      label: stateAvailable ? scored.classification.label : '判定不能',
      labelJa: stateAvailable ? scored.classification.label : '判定不能',
      optimismScore: stateAvailable ? scored.score : null,
      riskScore: stateAvailable ? 100 - scored.score : null,
      score: stateAvailable ? scored.score : null,
      confidence,
      assessmentStatus: riskOverride
        ? 'partial'
        : (assessmentAvailable ? (referenceOnly ? 'reference_only' : 'confirmed') : 'unavailable'),
      referenceOnly,
      watchOnly: referenceOnly || !assessmentAvailable,
      displayEligible: stateAvailable,
      tradeEligible: false,
      decisionEligible: false,
      dangerOverride: riskOverride,
      rationale: stateAvailable ? scored.rationale : [],
      reasons: stateAvailable ? scored.rationale : [],
      contributions: stateAvailable ? scored.contributions : [],
      componentPoints: stateAvailable ? scored.componentPoints : {},
      previousRawScores,
      scale: scored.scale
    },
    indicators,
    instruments: indicators,
    actualFundFlow: false,
    tradingSignal: null,
    tradeEligible: false,
    referenceOnly,
    watchOnly: referenceOnly || !assessmentAvailable,
    action: 'monitor_only',
    warnings,
    availability: {
      synchronizedConfirmedSession: {
        available: Boolean(commonAsOf),
        current: synchronizationLagSessions === 0,
        asOf: commonAsOf,
        latestSpyDate,
        lagSessions: synchronizationLagSessions
      },
      adjustedClose: {
        available: !referenceOnly,
        priceMode,
        displayEligible: assessmentAvailable,
        tradeEligible: false
      },
      history: {
        complete: dataComplete,
        availableMetrics,
        requiredMetrics: allMetrics.length,
        missingMetrics
      },
      vixTermStructure: {
        available: false,
        used: false,
        reason: 'VIX futures term structure is not fetched; spot VIX history only.'
      },
      actualFundFlow: { available: false, used: false },
      tradingSignal: { available: false, value: null }
    },
    methodology: {
      version: MARKET_REGIME_METHOD_VERSION,
      symbols: { vix: '^VIX', oil: 'CL=F', equities: 'SPY' },
      horizons: ['1d', '5d', '20d'],
      canonicalCalendar: 'SPY confirmed sessions',
      synchronization: 'exact same confirmed session and exact SPY 1/5/20-session endpoints; no fill and no nearest-date substitution',
      priceSelection: 'VIX index close and CL=F continuous-futures close are native EOD inputs. SPY Yahoo Chart v8 adjusted close is preferred; Spark raw SPY or any mixed history is reference-only.',
      scoreDirection: '0=danger, 100=optimistic',
      thresholds: { danger: [0, 29], caution: [30, 44], neutral: [45, 64], optimistic: [65, 100] },
      vixInterpretation: 'VIX is a 30-day expected-volatility measure, not an equity direction forecast; level and changes are combined with SPY.',
      oilInterpretation: 'Oil has supply, demand, inventory and financial drivers. A rise alone is neutral; only a sharp rise confirmed by VIX stress or SPY weakness adds danger. A sharp fall adds demand-slowdown caution only with VIX stress or SPY weakness, can be disinflation relief with falling VIX and rising SPY, and is otherwise unconfirmed.',
      futuresLimitation: 'CL=F is a rolling front-month futures series; contract rolls and adjustment choices can affect returns.',
      vixTermStructureUsed: false,
      sourceLimitations: 'Yahoo endpoints are unofficial best-effort single-source observations; adjusted SPY availability does not make the assessment trade-eligible.',
      actualFundFlow: false,
      predictive: false,
      investmentAdvice: false
    },
    meta: {
      status: status === 'unavailable' ? 'error' : status,
      durationMs: 0,
      cache: 'refreshed',
      stale: false,
      observationStale,
      observationAgeMs: ageMs,
      maximumObservationAgeMs: MARKET_REGIME_MAX_OBSERVATION_AGE_MS,
      synchronizationLagSessions,
      requestedSymbols: MARKET_REGIME_SYMBOLS.length,
      returnedSymbols: MARKET_REGIME_SYMBOLS.length - missingSymbols.length,
      source: {
        provider: 'Yahoo Finance',
        id: indicators.spy.source === 'yahoo-chart-v8-adjusted'
          ? 'yahoo-spark+chart-v8-adjusted'
          : 'yahoo-spark',
        inputs: {
          vix: indicators.vix.source,
          wti: indicators.wti.source,
          spy: indicators.spy.source
        },
        adjustedSpyUsed: indicators.spy.source === 'yahoo-chart-v8-adjusted',
        adjustedSpyRefreshFallback: spyAdjustedRefreshFallback,
        adjustedSpyRefreshFallbackAgeMs: spyAdjustedRefreshFallbackAgeMs,
        official: false,
        bestEffort: true
      },
      quality: {
        coveragePct: Math.round(completeness * 100),
        fresh: observationStale
          ? 0
          : Math.max(0, MARKET_REGIME_SYMBOLS.length - missingSymbols.length - (spyAdjustedRefreshFallback ? 1 : 0)),
        live: 0,
        closeValid: observationStale ? 0 : MARKET_REGIME_SYMBOLS.length - missingSymbols.length,
        stale: observationStale ? MARKET_REGIME_SYMBOLS.length - missingSymbols.length : 0,
        failed: missingSymbols.length + invalidSymbols.length,
        delayed: spyAdjustedRefreshFallback ? 1 : 0,
        aged: observationStale ? 1 : 0,
        reference: referenceOnly ? 1 : 0,
        unverified: missingMetrics,
        consensusWarnings: 0,
        grade: status === 'unavailable'
          ? 'unavailable'
          : (assessmentAvailable && !referenceOnly ? 'close-valid' : (assessmentAvailable ? 'reference-only' : 'watch-only'))
      }
    }
  };
}

function selectMarketRegimePayload(payload, options = {}) {
  const selected = JSON.parse(JSON.stringify(payload));
  const stale = Boolean(options.stale);
  const durationMs = Number.isFinite(options.durationMs) ? Math.max(0, options.durationMs) : 0;
  if (stale && selected.status !== 'unavailable') {
    selected.status = 'partial';
    selected.partial = true;
    selected.regime.state = 'unavailable';
    selected.regime.label = '判定不能';
    selected.regime.labelJa = '判定不能';
    selected.regime.optimismScore = null;
    selected.regime.riskScore = null;
    selected.regime.score = null;
    selected.regime.assessmentStatus = 'unavailable';
    selected.regime.referenceOnly = true;
    selected.regime.watchOnly = true;
    selected.regime.displayEligible = false;
    selected.regime.tradeEligible = false;
    selected.regime.decisionEligible = false;
    selected.regime.rationale = [];
    selected.regime.reasons = [];
    selected.regime.contributions = [];
    selected.regime.componentPoints = {};
    selected.referenceOnly = true;
    selected.watchOnly = true;
    selected.tradeEligible = false;
    selected.warnings = [...new Set([
      ...(selected.warnings || []),
      '古いキャッシュ観測のため、レジームは参考表示のみです。'
    ])];
  }
  selected.meta = {
    ...(selected.meta || {}),
    status: selected.status === 'unavailable' ? 'error' : selected.status,
    durationMs,
    cache: options.cache || 'refreshed',
    cacheTier: options.cacheTier || selected.meta?.cacheTier || null,
    stale,
    cacheAgeMs: Number.isFinite(options.ageMs) ? Math.max(0, options.ageMs) : 0,
    refreshRequested: options.refreshRequested === true,
    refreshSuppressed: options.refreshSuppressed === true,
    observationStale: stale || selected.meta?.observationStale === true,
    quality: {
      ...(selected.meta?.quality || {}),
      fresh: stale ? 0 : (selected.meta?.quality?.fresh || 0),
      closeValid: stale ? 0 : (selected.meta?.quality?.closeValid || 0),
      stale: stale
        ? Math.max(1, selected.meta?.returnedSymbols || 0)
        : (selected.meta?.quality?.stale || 0),
      grade: selected.status === 'unavailable' ? 'unavailable' : (stale ? 'stale' : selected.meta?.quality?.grade)
    }
  };
  return selected;
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function robustScale(values, center) {
  const mad = median(values.map(value => Math.abs(value - center)));
  return Math.max(0.005, 1.4826 * (mad || 0));
}

function calculateRotationScore(feature, peerR5, peerR20) {
  if (!feature || !peerR5.length || !peerR20.length) return null;
  const median5 = median(peerR5);
  const median20 = median(peerR20);
  const scale5 = robustScale(peerR5, median5);
  const scale20 = robustScale(peerR20, median20);
  const z5 = clamp((feature.r5 - median5) / scale5, -3, 3);
  const z20 = clamp((feature.r20 - median20) / scale20, -3, 3);
  const estimatedRotationIndex = clamp(
    0.45 * (z5 / 3) + 0.30 * (z20 / 3) + 0.15 * feature.breadth5 + 0.10 * feature.breadth20,
    -1,
    1
  );
  return {
    median5,
    median20,
    scale5,
    scale20,
    z5,
    z20,
    estimatedRotationIndex: estimatedRotationIndex * 100,
    score: clamp(50 + 50 * estimatedRotationIndex, 0, 100),
    momentum: clamp((0.6 * (z5 / 3) + 0.4 * (z20 / 3)) * 100, -100, 100)
  };
}

function peerSetHash(ids) {
  return crypto.createHash('sha256').update([...ids].sort().join('|')).digest('hex').slice(0, 12);
}

function peerStability(sets) {
  if (sets.length < 3 || sets.some(set => !(set instanceof Set) || !set.size)) return 0;
  const union = new Set(sets.flatMap(set => [...set]));
  const intersection = [...sets[0]].filter(value => sets.slice(1).every(set => set.has(value)));
  return union.size ? intersection.length / union.size : 0;
}

function instrumentFeatures(history, dates) {
  const features = new Map();
  const points = consistentHistoryPoints(history);
  const pointByDate = new Map(points.map(point => [
    point.sessionDate || point.at?.slice(0, 10),
    point
  ]).filter(([date]) => date));
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const current = pointByDate.get(date);
    if (!date || !(current?.close > 0)) continue;
    const period = sessions => {
      const baselineDate = dates[index - sessions];
      const baseline = pointByDate.get(baselineDate);
      if (!baseline || !(baseline.close > 0)) return null;
      const simple = clamp((current.close / baseline.close) - 1, -0.5, 0.5);
      return {
        simple,
        log: Math.log1p(simple),
        baselineDate,
        priceMode: current.priceMode === 'adjusted' && baseline.priceMode === 'adjusted'
          ? 'adjusted-close'
          : 'raw-close-fallback'
      };
    };
    const oneDay = period(1);
    const fiveDay = period(5);
    const twentyDay = period(20);
    features.set(date, {
      date,
      oneDay,
      fiveDay,
      twentyDay,
      priceMode: oneDay?.priceMode === 'adjusted-close' &&
          fiveDay?.priceMode === 'adjusted-close' && twentyDay?.priceMode === 'adjusted-close'
        ? 'adjusted-close'
        : 'raw-close-fallback'
    });
  }
  return features;
}

function themeRawFeatures(entry, featureBySymbol, dates) {
  return dates.map(date => {
    const members = entry.relatedTickers
      .map(symbol => ({ symbol, feature: featureBySymbol.get(symbol)?.get(date) }))
      .filter(item => item.feature?.fiveDay && item.feature?.twentyDay && item.feature?.oneDay);
    const coveragePct = (members.length / entry.relatedTickers.length) * 100;
    const adjustedMembers = members.filter(item => item.feature.priceMode === 'adjusted-close').length;
    const adjustedCoveragePct = (adjustedMembers / entry.relatedTickers.length) * 100;
    if (entry.relatedTickers.length < 4 || coveragePct < 80) {
      return {
        date,
        eligible: false,
        coveragePct,
        available: members.length,
        adjustedCoveragePct,
        priceMode: adjustedCoveragePct === 100 ? 'adjusted-close' : 'raw-close-fallback'
      };
    }
    const simple5 = members.map(item => item.feature.fiveDay.simple);
    const simple20 = members.map(item => item.feature.twentyDay.simple);
    const dailyLogs = members.map(item => item.feature.oneDay.log);
    const breadth = values => (
      (values.filter(value => value > 0).length - values.filter(value => value < 0).length) / values.length
    );
    return {
      date,
      eligible: true,
      coveragePct,
      available: members.length,
      adjustedCoveragePct,
      priceMode: adjustedCoveragePct === 100 ? 'adjusted-close' : 'raw-close-fallback',
      r5: mean(members.map(item => item.feature.fiveDay.log)),
      r20: mean(members.map(item => item.feature.twentyDay.log)),
      breadth5: breadth(simple5),
      breadth20: breadth(simple20),
      dailyLogReturn: mean(dailyLogs),
      dailyReturnPct: (Math.exp(mean(dailyLogs)) - 1) * 100
    };
  });
}

function rrgQuadrant(longRelativePct, shortRelativePct) {
  if (!Number.isFinite(longRelativePct) || !Number.isFinite(shortRelativePct)) return null;
  if (longRelativePct >= 0 && shortRelativePct >= 0) return 'leader';
  if (longRelativePct >= 0) return 'weakening';
  if (shortRelativePct >= 0) return 'rebound';
  return 'lagging';
}

function rrgCloseSeries(history) {
  const points = consistentHistoryPoints(history);
  return {
    priceMode: history?.priceMode === 'adjusted' ? 'adjusted-close' : 'raw-close-fallback',
    closes: new Map(points
      .filter(point => (point.close > 0) && (point.sessionDate || point.at?.slice(0, 10)))
      .map(point => [point.sessionDate || point.at.slice(0, 10), point.close]))
  };
}

function buildThemeRrg(entry, closeBySymbol, benchmarkSeries, dates, rrgDates) {
  const benchmarkCloses = benchmarkSeries.closes;
  const dateIndex = new Map(dates.map((date, index) => [date, index]));
  const trail = rrgDates.map(date => {
    const index = dateIndex.get(date);
    const longBaseDate = dates[index - RRG_LONG_SESSIONS];
    const shortBaseDate = dates[index - RRG_SHORT_SESSIONS];
    const benchmarkCurrent = benchmarkCloses.get(date);
    const benchmarkLongBase = benchmarkCloses.get(longBaseDate);
    const benchmarkShortBase = benchmarkCloses.get(shortBaseDate);
    const members = entry.relatedTickers.map(symbol => {
      const series = closeBySymbol.get(symbol),closes=series?.closes;
      const current = closes?.get(date);
      const longBase = closes?.get(longBaseDate);
      const shortBase = closes?.get(shortBaseDate);
      return current > 0 && longBase > 0 && shortBase > 0
        ? { longLog: Math.log(current / longBase), shortLog: Math.log(current / shortBase), priceMode: series.priceMode }
        : null;
    }).filter(Boolean);
    const coveragePct = (members.length / entry.relatedTickers.length) * 100;
    const available = Number.isInteger(index) && coveragePct >= 80 && benchmarkCurrent > 0 &&
      benchmarkLongBase > 0 && benchmarkShortBase > 0;
    if (!available) {
      return {
        date,
        longRelativePct: null,
        shortRelativePct: null,
        quadrant: null,
        coveragePct: rounded(coveragePct),
        status: 'unavailable'
      };
    }
    const longRelativePct = (mean(members.map(member => member.longLog)) -
      Math.log(benchmarkCurrent / benchmarkLongBase)) * 100;
    const shortRelativePct = (mean(members.map(member => member.shortLog)) -
      Math.log(benchmarkCurrent / benchmarkShortBase)) * 100;
    return {
      date,
      longRelativePct: rounded(longRelativePct),
      shortRelativePct: rounded(shortRelativePct),
      quadrant: rrgQuadrant(longRelativePct, shortRelativePct),
      coveragePct: rounded(coveragePct),
      priceMode: benchmarkSeries.priceMode === 'adjusted-close' && members.every(member => member.priceMode === 'adjusted-close')
        ? 'adjusted-close'
        : 'raw-close-fallback',
      status: coveragePct === 100 ? 'ok' : 'partial'
    };
  });
  const current = trail.at(-1);
  const valid = trail.filter(point => Number.isFinite(point.longRelativePct) && Number.isFinite(point.shortRelativePct));
  const first = valid[0];
  const previous = valid.length > 1 ? valid.at(-2) : null;
  let quadrantSessions = 0;
  if (current?.quadrant) {
    for (let index = trail.length - 1; index >= 0 && trail[index]?.quadrant === current.quadrant; index -= 1) {
      quadrantSessions += 1;
    }
  }
  const currentAvailable = Number.isFinite(current?.longRelativePct) && Number.isFinite(current?.shortRelativePct);
  const priceMode = valid.length && valid.every(point => point.priceMode === 'adjusted-close')
    ? 'adjusted-close'
    : 'raw-close-fallback';
  return {
    status: currentAvailable
      ? (trail.length === RRG_TRAIL_POINTS && trail.every(point => point.status === 'ok') ? 'ok' : 'partial')
      : 'unavailable',
    benchmark: 'SPY',
    priceMode,
    dividendAdjusted: priceMode === 'adjusted-close',
    qualityWarning: priceMode === 'adjusted-close'
      ? null
      : 'Yahoo Spark raw close fallback: dividends are excluded and corporate actions can distort historical comparisons.',
    asOf: currentAvailable ? current.date : null,
    longPeriodSessions: RRG_LONG_SESSIONS,
    shortPeriodSessions: RRG_SHORT_SESSIONS,
    trailSessions: RRG_TRAIL_SESSIONS,
    longRelativePct: currentAvailable ? current.longRelativePct : null,
    shortRelativePct: currentAvailable ? current.shortRelativePct : null,
    quadrant: currentAvailable ? current.quadrant : null,
    previousQuadrant: previous?.quadrant || null,
    quadrantSessions,
    movement: currentAvailable && first ? {
      longDeltaPct: rounded(current.longRelativePct - first.longRelativePct),
      shortDeltaPct: rounded(current.shortRelativePct - first.shortRelativePct),
      fromDate: first.date,
      toDate: current.date
    } : null,
    coverage: {
      returned: valid.length,
      requested: RRG_TRAIL_POINTS,
      pct: rounded((valid.length / RRG_TRAIL_POINTS) * 100)
    },
    trail
  };
}

function buildRrgData(histories, dates) {
  const closeBySymbol = new Map([...histories].map(([symbol, history]) => [symbol, rrgCloseSeries(history)]));
  const benchmarkSeries = closeBySymbol.get('SPY') || rrgCloseSeries(null);
  const benchmarkCloses = benchmarkSeries.closes;
  const rrgDates = dates.filter((date, index) => index >= RRG_LONG_SESSIONS &&
    benchmarkCloses.get(date) > 0 && benchmarkCloses.get(dates[index - RRG_LONG_SESSIONS]) > 0 &&
    benchmarkCloses.get(dates[index - RRG_SHORT_SESSIONS]) > 0).slice(-RRG_TRAIL_POINTS);
  const byTheme = new Map(INTELLIGENCE_THEME_CATALOG.map(entry => [
    entry.id,
    buildThemeRrg(entry, closeBySymbol, benchmarkSeries, dates, rrgDates)
  ]));
  return { dates: rrgDates, byTheme, benchmarkPriceMode: benchmarkSeries.priceMode };
}

function intelligenceConfidence({ coveragePct, historySamples, breadth5, breadth20, partial }) {
  const coverage = clamp(coveragePct / 100, 0, 1);
  const history = clamp(historySamples / 60, 0, 1);
  const breadthEvidence = clamp((Math.abs(breadth5 || 0) + Math.abs(breadth20 || 0)) / 1.6, 0, 1);
  const raw = 70 + 10 * coverage + 10 * history + 6 * breadthEvidence;
  return rounded(partial ? Math.min(69, raw) : Math.min(96, raw));
}

function trendDetailFromScore(score, velocity) {
  if (!Number.isFinite(score)) return 'flat';
  if (score >= 75 && (velocity ?? 0) > 0) return 'strong-up';
  if (score >= 58) return 'up';
  if (score <= 25 && (velocity ?? 0) < 0) return 'strong-down';
  if (score <= 42) return 'down';
  return 'flat';
}

function publicTrend(trendDetail) {
  if (trendDetail === 'strong-up') return 'up';
  if (trendDetail === 'strong-down') return 'down';
  return trendDetail;
}

function entryFromMetrics(metric) {
  if (!Number.isFinite(metric?.score)) return 'avoid';
  if (!metric.eligible) return 'watch';
  const fiveFactorGate = metric.score >= 65 && metric.estimatedRotationIndex >= 15 &&
    metric.flowVelocity > 0.75 && metric.acceleration > 0 && metric.breadth >= 65 &&
    metric.confidence >= 80;
  if (fiveFactorGate) return 'buy';
  if (metric.score >= 58 && metric.estimatedRotationIndex >= 5 && metric.breadth >= 55 &&
      metric.confidence >= 75) return 'pullback_only';
  if (metric.score < 35 || metric.estimatedRotationIndex <= -15 || metric.acceleration < -1) return 'avoid';
  if (metric.score >= 45) return 'watch';
  return 'avoid';
}

function instrumentIntelligenceDetail(symbol, history, metadata = {}) {
  const historyPoints = consistentHistoryPoints(history);
  if (!historyPoints.length) {
    return {
      symbol,
      name: metadata.name || symbol,
      price: null,
      asOf: null,
      status: 'unavailable',
      priceMode: null,
      performance: performanceValues({}),
      periods: Object.fromEntries(Object.keys(THEME_PERIODS).map(key => [key, null])),
      coverage: { returned: 0, requested: 4 },
      ...metadata
    };
  }
  const periods = Object.fromEntries(Object.keys(THEME_PERIODS).map(key => [key, calculatePeriodPerformance(historyPoints, key)]));
  const returned = Object.values(periods).filter(Boolean).length;
  const latest = historyPoints.at(-1);
  return {
    symbol,
    name: metadata.name || symbol,
    price: latest.rawClose || latest.close,
    asOf: latest.sessionDate || latest.at,
    status: returned === 4 ? 'ok' : (returned ? 'partial' : 'unavailable'),
    priceMode: history.priceMode,
    performance: performanceValues(periods),
    periods,
    coverage: { returned, requested: 4 },
    ...metadata
  };
}

function rankValues(values) {
  const order = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
  const ranks = new Array(values.length);
  for (let cursor = 0; cursor < order.length;) {
    let end = cursor + 1;
    while (end < order.length && order[end].value === order[cursor].value) end += 1;
    const rank = (cursor + end - 1) / 2 + 1;
    for (let index = cursor; index < end; index += 1) ranks[order[index].index] = rank;
    cursor = end;
  }
  return ranks;
}

function pearson(left, right) {
  if (left.length !== right.length || left.length < 3) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.length; index += 1) {
    const x = left[index] - leftMean;
    const y = right[index] - rightMean;
    numerator += x * y;
    leftSquare += x * x;
    rightSquare += y * y;
  }
  const denominator = Math.sqrt(leftSquare * rightSquare);
  return denominator > 0 ? numerator / denominator : null;
}

function spearman(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 3) return null;
  return pearson(rankValues(pairs.map(pair => pair[0])), rankValues(pairs.map(pair => pair[1])));
}

function laggedPairs(source, target, lag) {
  const pairs = [];
  for (let index = lag; index < Math.min(source.length, target.length); index += 1) {
    const left = source[index - lag];
    const right = target[index];
    if (Number.isFinite(left) && Number.isFinite(right)) pairs.push([left, right]);
  }
  return pairs;
}

function chronologicalAssociationWindows(pairs) {
  const recent = Array.isArray(pairs) ? pairs.slice(-160) : [];
  if (recent.length < 160) return null;
  return {
    train: recent.slice(0, 100),
    validation: recent.slice(100, 160),
    pairs: recent
  };
}

function revisionMaterial(value) {
  const excluded = new Set([
    '_internal',
    'ageMs',
    'cache',
    'dataRevision',
    'durationMs',
    'evidenceIds',
    'evidenceRevision',
    'lastUpdated',
    'observedEvidence',
    'retrievedAt',
    'revision',
    'updatedAt'
  ]);
  const visit = current => {
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== 'object') return current;
    return Object.fromEntries(Object.entries(current)
      .filter(([key]) => !excluded.has(key))
      .map(([key, nested]) => [key, visit(nested)]));
  };
  return visit(value);
}

function finalizeIntelligenceRevision(payload) {
  const material = revisionMaterial(payload);
  const digest = crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16);
  const revision = `theme-intelligence-v3:${digest}`;
  payload.dataRevision = revision;
  if (payload.meta) payload.meta.evidenceRevision = revision;
  for (const theme of payload.themes || []) {
    theme.dataRevision = revision;
    theme.evidenceIds = [
      `${revision}:theme:${theme.id}:return:1d`,
      `${revision}:theme:${theme.id}:breadth5`,
      `${revision}:theme:${theme.id}:score`,
      `${revision}:theme:${theme.id}:velocity`,
      `${revision}:theme:${theme.id}:rrg-long`,
      `${revision}:theme:${theme.id}:rrg-short`
    ];
  }
  for (const edge of payload.edges || []) edge.revision = revision;
  for (const candidate of payload.nextCandidates || []) {
    candidate.revision = revision;
    candidate.evidenceIds = [
      `${revision}:theme:${candidate.themeId}:score`,
      `${revision}:theme:${candidate.themeId}:breadth5`,
      `${revision}:theme:${candidate.themeId}:velocity`
    ];
  }
  payload.observedEvidence = (payload.themes || []).flatMap(theme => [
    { id: `${revision}:theme:${theme.id}:return:1d`, revision, type: 'observed-price', themeId: theme.id, metric: 'returnPct', value: theme.history.at(-1)?.returnPct ?? null, unit: 'percent', asOf: theme.history.at(-1)?.date || payload.asOf, source: theme.scorePriceMode === 'adjusted-close' ? 'yahoo-spark-adjusted-close' : 'yahoo-spark-raw-close', estimated: false },
    { id: `${revision}:theme:${theme.id}:breadth5`, revision, type: 'observed-breadth', themeId: theme.id, metric: 'breadth5', value: theme.breadth5, unit: 'ratio', asOf: theme.history.at(-1)?.date || payload.asOf, source: 'yahoo-spark', estimated: false },
    { id: `${revision}:theme:${theme.id}:score`, revision, type: 'estimated-rotation', themeId: theme.id, metric: 'score', value: theme.score, unit: 'proxy point', asOf: theme.history.at(-1)?.date || payload.asOf, source: 'relative-strength-breadth-model', estimated: true },
    { id: `${revision}:theme:${theme.id}:velocity`, revision, type: 'estimated-rotation', themeId: theme.id, metric: 'flowVelocity', value: theme.flowVelocity, unit: 'score points/session', asOf: theme.history.at(-1)?.date || payload.asOf, source: 'relative-strength-breadth-model', estimated: true },
    { id: `${revision}:theme:${theme.id}:rrg-long`, revision, type: 'observed-relative-price', themeId: theme.id, metric: 'rrgLongRelativePct', value: theme.rrg?.longRelativePct ?? null, unit: 'log-return percentage point versus SPY', asOf: theme.rrg?.asOf || payload.asOf, source: theme.rrg?.priceMode === 'adjusted-close' ? 'yahoo-spark-adjusted-close' : 'yahoo-spark-raw-close', estimated: false },
    { id: `${revision}:theme:${theme.id}:rrg-short`, revision, type: 'observed-relative-price', themeId: theme.id, metric: 'rrgShortRelativePct', value: theme.rrg?.shortRelativePct ?? null, unit: 'log-return percentage point versus SPY', asOf: theme.rrg?.asOf || payload.asOf, source: theme.rrg?.priceMode === 'adjusted-close' ? 'yahoo-spark-adjusted-close' : 'yahoo-spark-raw-close', estimated: false }
  ]);
  for (const edge of (payload.edges || []).filter(edge => edge.eligible)) {
    payload.observedEvidence.push({
      id: `${revision}:${edge.id}:association`,
      revision,
      type: 'estimated-lag-association',
      edgeId: edge.id,
      metric: 'strength',
      value: edge.strength,
      unit: 'Spearman association x100',
      asOf: payload.asOf,
      source: 'relative-strength-breadth-model',
      estimated: true
    });
  }
  return payload;
}

function applyValidatedEdgeAssociations(payload) {
  const internal = payload._internal;
  if (!internal) return payload;
  const catalogById = new Map(INTELLIGENCE_THEME_CATALOG.map(entry => [entry.id, entry]));
  const themeById = new Map(payload.themes.map(theme => [theme.id, theme]));
  const validated = [];

  for (const edge of payload.edges) {
    const sourceCatalog = catalogById.get(edge.from);
    const targetCatalog = catalogById.get(edge.to);
    const sourceTheme = themeById.get(edge.from);
    const targetTheme = themeById.get(edge.to);
    const overlap = sourceCatalog.relatedTickers.filter(symbol => targetCatalog.relatedTickers.includes(symbol));
    edge.sharedTickers = overlap;
    if (payload.status !== 'ok') {
      edge.status = 'global-partial';
      edge.reason = 'Dynamic association is disabled for a partial/stale universe.';
      continue;
    }
    if (overlap.length) {
      edge.status = 'overlap-excluded';
      edge.reason = 'Shared constituents would create mechanical correlation.';
      continue;
    }
    if (!sourceTheme?.eligible || !targetTheme?.eligible || sourceTheme.confidence < 75 || targetTheme.confidence < 75) {
      edge.status = 'quality-gate';
      edge.reason = 'Theme history, coverage, confidence, or peer stability gate was not met.';
      continue;
    }
    const source = internal.innovations.get(edge.from) || [];
    const target = internal.innovations.get(edge.to) || [];
    const sourceRecent = source.filter(Number.isFinite).slice(-160);
    const targetRecent = target.filter(Number.isFinite).slice(-160);
    const zeroRatio = values => values.length
      ? values.filter(value => Math.abs(value) < 1e-12).length / values.length
      : 1;
    if (zeroRatio(sourceRecent) > 0.2 || zeroRatio(targetRecent) > 0.2) {
      edge.status = 'zero-return-gate';
      edge.reason = 'Too many zero-return sessions for a stable lag estimate.';
      continue;
    }

    let best = null;
    for (let lag = 1; lag <= 5; lag += 1) {
      const windows = chronologicalAssociationWindows(laggedPairs(source, target, lag));
      if (!windows) continue;
      const { train, validation, pairs } = windows;
      const rhoTrain = spearman(train);
      const rhoValidation = spearman(validation);
      if (!Number.isFinite(rhoTrain) || !Number.isFinite(rhoValidation)) continue;
      if (!best || rhoTrain > best.rhoTrain) {
        best = { lag, rhoTrain, rhoValidation, nTrain: train.length, nValidation: validation.length, pairs };
      }
    }
    if (!best || best.nTrain < 80 || best.nValidation < 40 || best.rhoTrain < 0.45 ||
        best.rhoValidation < 0.35 || Math.abs(best.rhoTrain - best.rhoValidation) > 0.2) {
      edge.status = 'association-unvalidated';
      edge.reason = 'Time-split lag association did not meet the preregistered stability thresholds.';
      continue;
    }
    const previousRho = spearman(best.pairs.slice(-80, -40));
    const recentRho = spearman(best.pairs.slice(-40));
    if (!(previousRho > 0 && recentRho > 0) || Math.abs(previousRho - recentRho) > 0.35) {
      edge.status = 'recent-instability';
      edge.reason = 'Recent and preceding association windows were not stable.';
      continue;
    }
    const strength = Math.min(best.rhoTrain, best.rhoValidation) * 100;
    edge.edgeType = 'catalog-with-validated-association';
    edge.associationObserved = true;
    edge.strength = rounded(strength);
    edge.propagationFlow = rounded(sourceTheme.estimatedRotationIndex * (strength / 100));
    edge.flowScore = edge.propagationFlow;
    edge.confidence = rounded(Math.min(sourceTheme.confidence, targetTheme.confidence, 70 + strength * 0.3));
    edge.lagDays = best.lag;
    edge.lagSessions = best.lag;
    edge.eligible = true;
    edge.status = 'validated-association';
    edge.reason = 'Positive lag association survived chronological train/validation checks; it is not causal fund flow.';
    edge.correlation = {
      method: 'Spearman on daily cross-sectional return innovations',
      train: rounded(best.rhoTrain),
      validation: rounded(best.rhoValidation),
      previousWindow: rounded(previousRho),
      recentWindow: rounded(recentRho),
      nTrain: best.nTrain,
      nValidation: best.nValidation
    };
    validated.push(edge);
  }

  const permitted = new Set();
  const outgoing = new Map();
  for (const edge of [...validated].sort((left, right) => right.strength - left.strength)) {
    if (permitted.size >= 30) break;
    const count = outgoing.get(edge.from) || 0;
    if (count >= 2) continue;
    permitted.add(edge.id);
    outgoing.set(edge.from, count + 1);
  }
  for (const edge of validated) {
    if (permitted.has(edge.id)) continue;
    edge.edgeType = 'catalog';
    edge.associationObserved = false;
    edge.strength = null;
    edge.propagationFlow = null;
    edge.flowScore = null;
    edge.confidence = null;
    edge.lagDays = null;
    edge.lagSessions = null;
    edge.eligible = false;
    edge.status = 'association-cap';
    edge.reason = 'Validated association omitted by the top-two outgoing/global-thirty display cap.';
    delete edge.correlation;
  }
  delete payload._internal;
  return finalizeIntelligenceRevision(payload);
}

function aggregateIntelligenceThemes(id, name, color, themes) {
  const available = themes.filter(theme => Number.isFinite(theme.score));
  const slots = themes.flatMap(theme => theme.relatedTickers);
  const uniqueSymbols = new Set(slots);
  const metricMean = key => rounded(mean(available.map(theme => theme[key]).filter(Number.isFinite)));
  const coveragePct = themes.length ? (available.length / themes.length) * 100 : 0;
  const score = metricMean('score');
  const flowVelocity = metricMean('flowVelocity');
  const trendDetail = trendDetailFromScore(score, flowVelocity);
  return {
    id,
    name,
    color,
    themeIds: themes.map(theme => theme.id),
    score,
    estimatedRotationIndex: metricMean('estimatedRotationIndex'),
    flowIn: metricMean('flowIn'),
    flowOut: metricMean('flowOut'),
    flowVelocity,
    acceleration: metricMean('acceleration'),
    breadth: metricMean('breadth'),
    confidence: metricMean('confidence'),
    momentum: metricMean('momentum'),
    volatility: metricMean('volatility'),
    trend: publicTrend(trendDetail),
    trendDetail,
    eligible: coveragePct >= 80 && available.every(theme => theme.eligible),
    coverage: { returned: available.length, requested: themes.length, pct: rounded(coveragePct) },
    aggregationMode: 'equal-weight-themes-with-overlap',
    slotCount: slots.length,
    uniqueSymbolCount: uniqueSymbols.size,
    overlapPct: slots.length ? rounded((1 - uniqueSymbols.size / slots.length) * 100) : 0,
    overlapWarning: 'Themes can share constituents; aggregate values are not a unique-symbol index.'
  };
}

function intelligenceObservationFreshness(histories, retrievedAt) {
  const benchmarkPoints = consistentHistoryPoints(histories.get('SPY'));
  const latest = benchmarkPoints.at(-1) || null;
  const observedAt = latest?.at || null;
  const asOf = latest?.sessionDate || observedAt?.slice(0, 10) || null;
  const retrievedMs = Date.parse(String(retrievedAt || ''));
  const observedMs = Date.parse(String(observedAt || ''));
  const validClock = Number.isFinite(retrievedMs) && Number.isFinite(observedMs);
  const futureSkewMs = validClock ? observedMs - retrievedMs : null;
  const ageMs = validClock ? Math.max(0, retrievedMs - observedMs) : null;
  const stale = !latest || !validClock || futureSkewMs > 24 * 60 * 60 * 1000 ||
    ageMs > MAX_PREVIOUS_OBSERVATION_AGE_MS;
  return {
    status: !latest ? 'unavailable' : (stale ? 'stale' : 'close-valid'),
    stale,
    benchmark: 'SPY',
    asOf,
    observedAt,
    retrievedAt,
    ageMs,
    maximumAgeMs: MAX_PREVIOUS_OBSERVATION_AGE_MS,
    transportCacheIndependent: true,
    reason: !latest
      ? 'SPY confirmed daily history is unavailable.'
      : (!validClock
          ? 'Observation or retrieval timestamp is invalid.'
          : (futureSkewMs > 24 * 60 * 60 * 1000
              ? 'Observation timestamp is implausibly ahead of retrieval time.'
              : (ageMs > MAX_PREVIOUS_OBSERVATION_AGE_MS
                  ? 'Latest confirmed SPY session is older than the market-observation limit.'
                  : null)))
  };
}

function buildIntelligencePayload(histories, retrievedAt) {
  const observationFreshness = intelligenceObservationFreshness(histories, retrievedAt);
  const spyDates = consistentHistoryPoints(histories.get('SPY'))
    .map(point => point.sessionDate || point.at?.slice(0, 10))
    .filter(Boolean);
  const dates = [...new Set(spyDates)].sort();
  const featureBySymbol = new Map([...histories].map(([symbol, history]) => [
    symbol,
    instrumentFeatures(history, dates)
  ]));
  const rawByTheme = new Map(INTELLIGENCE_THEME_CATALOG.map(entry => [
    entry.id,
    themeRawFeatures(entry, featureBySymbol, dates)
  ]));
  const rrgData = buildRrgData(histories, dates);
  const rrgDates = rrgData.dates;
  const rrgByTheme = rrgData.byTheme;
  const scoreByTheme = new Map(INTELLIGENCE_THEME_CATALOG.map(entry => [entry.id, new Array(dates.length).fill(null)]));
  const peerSets = new Array(dates.length).fill(null);
  const innovations = new Map(INTELLIGENCE_THEME_CATALOG.map(entry => [entry.id, new Array(dates.length).fill(null)]));

  for (let index = 0; index < dates.length; index += 1) {
    const peers = INTELLIGENCE_THEME_CATALOG
      .map(entry => ({ id: entry.id, feature: rawByTheme.get(entry.id)[index] }))
      .filter(item => item.feature?.eligible && Number.isFinite(item.feature.r5) && Number.isFinite(item.feature.r20));
    const peerIds = new Set(peers.map(item => item.id));
    peerSets[index] = peerIds;
    if (peers.length < 20) continue;
    const peerR5 = peers.map(item => item.feature.r5);
    const peerR20 = peers.map(item => item.feature.r20);
    const dailyMedian = median(peers.map(item => item.feature.dailyLogReturn));
    for (const item of peers) {
      const rotation = calculateRotationScore(item.feature, peerR5, peerR20);
      if (!rotation) continue;
      scoreByTheme.get(item.id)[index] = {
        date: dates[index],
        ...item.feature,
        ...rotation,
        peerCount: peers.length,
        peerSetHash: peerSetHash(peerIds)
      };
      innovations.get(item.id)[index] = item.feature.dailyLogReturn - dailyMedian;
    }
  }

  for (const entry of INTELLIGENCE_THEME_CATALOG) {
    const scores = scoreByTheme.get(entry.id);
    let historySamples = 0;
    for (let index = 0; index < scores.length; index += 1) {
      const metric = scores[index];
      if (!metric) continue;
      historySamples += 1;
      const stability = peerStability([peerSets[index], peerSets[index - 5], peerSets[index - 10]]);
      const prior = scores[index - 5];
      const priorPrior = scores[index - 10];
      let velocity = null;
      let acceleration = null;
      if (stability >= 0.9 && prior) {
        velocity = (metric.score - prior.score) / 5;
        if (priorPrior) {
          const previousVelocity = (prior.score - priorPrior.score) / 5;
          acceleration = (velocity - previousVelocity) / 5;
        }
      }
      const partial = metric.coveragePct < 100;
      const scoreAvailable = historySamples >= 20 && metric.coveragePct >= 80;
      metric.historySamples = historySamples;
      metric.peerStability = stability;
      metric.flowVelocity = velocity;
      metric.acceleration = acceleration;
      metric.confidence = intelligenceConfidence({
        coveragePct: metric.coveragePct,
        historySamples,
        breadth5: metric.breadth5,
        breadth20: metric.breadth20,
        partial
      });
      metric.scoreAvailable = scoreAvailable;
      metric.flowIn = Math.max(0, metric.estimatedRotationIndex);
      metric.flowOut = Math.max(0, -metric.estimatedRotationIndex);
      metric.breadth = ((metric.breadth5 + metric.breadth20) / 2 + 1) * 50;
      const recentReturns = rawByTheme.get(entry.id)
        .slice(Math.max(0, index - 19), index + 1)
        .map(item => item?.dailyReturnPct)
        .filter(Number.isFinite);
      if (recentReturns.length >= 20) {
        const averageReturn = mean(recentReturns);
        const variance = mean(recentReturns.map(value => (value - averageReturn) ** 2));
        metric.volatility = Math.sqrt(variance) * Math.sqrt(252);
      } else {
        metric.volatility = null;
      }
      metric.trendDetail = trendDetailFromScore(metric.score, velocity);
      metric.trend = publicTrend(metric.trendDetail);
      metric.eligible = historySamples >= 60 && metric.coveragePct === 100 &&
        metric.adjustedCoveragePct === 100 && metric.priceMode === 'adjusted-close' &&
        metric.confidence >= 75 && stability >= 0.9 && !observationFreshness.stale;
      metric.entry = entryFromMetrics(metric);
    }
  }

  const asOf = dates.at(-1) || null;
  const scoringSymbols = [...new Set(INTELLIGENCE_THEME_CATALOG.flatMap(entry => entry.relatedTickers))];
  const scoringMissingSymbols = scoringSymbols.filter(symbol => !histories.has(symbol)).sort();
  const missingSymbols = [...new Set(INTELLIGENCE_THEME_CATALOG.flatMap(entry => [
    ...entry.relatedTickers,
    ...entry.etfs,
    ...entry.relatedInstruments.map(instrument => instrument.symbol)
  ]))].filter(symbol => !histories.has(symbol)).sort();

  const themes = INTELLIGENCE_THEME_CATALOG.map(entry => {
    const series = scoreByTheme.get(entry.id);
    const current = series.at(-1);
    const rawCurrent = rawByTheme.get(entry.id).at(-1);
    const constituents = entry.relatedTickers.map(symbol => instrumentIntelligenceDetail(symbol, histories.get(symbol), {
      usedInScore: true
    }));
    const etfs = entry.etfs.map(symbol => instrumentIntelligenceDetail(symbol, histories.get(symbol), {
      instrumentType: 'ETF',
      usedInScore: false
    }));
    const relatedInstruments = entry.relatedInstruments.map(instrument => instrumentIntelligenceDetail(
      instrument.symbol,
      histories.get(instrument.symbol),
      { ...instrument, instrumentType: instrument.leveraged ? 'leveraged-ETF' : 'related-instrument' }
    ));
    const currentCoverage = rawCurrent?.coveragePct || 0;
    const rrg = rrgByTheme.get(entry.id);
    if (rrg && observationFreshness.stale) {
      rrg.stale = true;
      if (rrg.status === 'ok') rrg.status = 'partial';
      rrg.qualityWarning = [rrg.qualityWarning, observationFreshness.reason]
        .filter(Boolean)
        .join(' ');
    }
    const coverageStatus = !current
      ? (currentCoverage >= 80 ? 'partial' : 'unavailable')
      : (currentCoverage === 100 && constituents.every(item => item.status === 'ok') ? 'ok' : 'partial');
    const status = observationFreshness.stale && coverageStatus === 'ok' ? 'partial' : coverageStatus;
    const history = series.slice(-30).map((metric, offset) => {
      const date = dates[dates.length - Math.min(30, dates.length) + offset];
      if (!metric) {
        const raw = rawByTheme.get(entry.id)[dates.indexOf(date)];
        return {
          date,
          score: null,
          estimatedRotationIndex: null,
          flowIn: null,
          flowOut: null,
          flowVelocity: null,
          acceleration: null,
          breadth: null,
          momentum: null,
          returnPct: raw?.dailyReturnPct ?? null,
          volumeImpulse: null,
          confidence: null,
          peerCount: peerSets[dates.indexOf(date)]?.size || 0,
          peerSetHash: peerSets[dates.indexOf(date)] ? peerSetHash(peerSets[dates.indexOf(date)]) : null,
          peerStability: null,
          coveragePct: raw?.coveragePct ?? 0,
          adjustedCoveragePct: raw?.adjustedCoveragePct ?? 0,
          priceMode: raw?.priceMode || null,
          status: 'unavailable'
        };
      }
      return {
        date: metric.date,
        score: rounded(metric.score),
        estimatedRotationIndex: rounded(metric.estimatedRotationIndex),
        flowIn: rounded(metric.flowIn),
        flowOut: rounded(metric.flowOut),
        flowVelocity: rounded(metric.flowVelocity),
        acceleration: rounded(metric.acceleration),
        breadth: rounded(metric.breadth),
        momentum: rounded(metric.momentum),
        returnPct: rounded(metric.dailyReturnPct),
        volumeImpulse: null,
        confidence: rounded(metric.confidence),
        peerCount: metric.peerCount,
        peerSetHash: metric.peerSetHash,
        peerStability: rounded(metric.peerStability),
        coveragePct: rounded(metric.coveragePct),
        adjustedCoveragePct: rounded(metric.adjustedCoveragePct),
        priceMode: metric.priceMode,
        status: metric.coveragePct === 100 ? 'ok' : 'partial'
      };
    });
    return {
      id: entry.id,
      name: entry.name,
      categoryId: entry.categoryId,
      parentId: entry.parentId,
      parentThemes: entry.parentId ? [entry.parentId] : [],
      childThemes: INTELLIGENCE_THEME_CATALOG.filter(child => child.parentId === entry.id).map(child => child.id),
      catalogVersion: INTELLIGENCE_CATALOG_VERSION,
      updatedAt: retrievedAt,
      relatedTickers: [...entry.relatedTickers],
      constituentSymbols: [...entry.relatedTickers],
      constituents,
      etfSymbols: [...entry.etfs],
      relatedEtfs: [...entry.etfs],
      etfs,
      relatedInstruments,
      score: rounded(current?.score),
      estimatedRotationIndex: rounded(current?.estimatedRotationIndex),
      actualFundFlow: false,
      flowMethod: 'price-breadth-estimated-rotation',
      flowProxy: null,
      flowIn: rounded(current?.flowIn),
      flowOut: rounded(current?.flowOut),
      flowVelocity: rounded(current?.flowVelocity),
      acceleration: rounded(current?.acceleration),
      breadth: rounded(current?.breadth),
      breadth5: rounded(current?.breadth5),
      breadth20: rounded(current?.breadth20),
      volatility: rounded(current?.volatility),
      confidence: rounded(current?.confidence),
      momentum: rounded(current?.momentum),
      trend: current?.trend || 'flat',
      trendDetail: current?.trendDetail || 'flat',
      entry: current?.entry || 'avoid',
      entrySignal: current?.entry === 'buy'
        ? 'momentum'
        : (current?.entry === 'pullback_only' ? 'pullback-only' : (current?.entry || 'avoid')),
      eligible: Boolean(current?.eligible),
      scoreAvailable: Boolean(current?.scoreAvailable),
      scorePriceMode: current?.priceMode || null,
      decisionPriceEligible: Boolean(current?.priceMode === 'adjusted-close' && current?.adjustedCoveragePct === 100),
      historySamples: current?.historySamples || 0,
      peerCount: current?.peerCount || 0,
      peerSetHash: current?.peerSetHash || null,
      peerStability: rounded(current?.peerStability),
      rrg,
      marketCapWeight: null,
      newsScore: null,
      newsCount: 0,
      newsConnected: false,
      coverage: {
        returned: rawCurrent?.available || 0,
        requested: entry.relatedTickers.length,
        pct: rounded(currentCoverage)
      },
      history,
      status,
      availability: {
        price: {
          available: Boolean(current),
          coveragePct: rounded(currentCoverage),
          priceMode: current?.priceMode || null,
          decisionEligible: Boolean(current?.priceMode === 'adjusted-close' && current?.adjustedCoveragePct === 100),
          observationFreshness
        },
        volume: { available: false, used: false, reason: 'Yahoo Spark does not provide volume history.' },
        flowProxy: { available: false, value: null, reason: 'Actual fund/order flow is unavailable; rotation is estimated from price and breadth only.' },
        rotationProxy: { available: Boolean(current), estimated: true, unit: 'proxy point' },
        rrg: {
          available: rrg?.status !== 'unavailable',
          status: rrg?.status || 'unavailable',
          coveragePct: rrg?.coverage?.pct ?? 0,
          benchmark: 'SPY',
          reason: rrg?.status === 'unavailable' ? 'SPY or exact 63/5-session close endpoints are incomplete.' : (rrg?.qualityWarning || null)
        },
        marketCapWeight: { available: false, value: null, used: false, reason: 'Point-in-time market-cap history is not connected.' },
        newsScore: { available: false, value: null, newsCount: 0, connected: false, used: false, reason: 'Verified news scoring is not connected.' }
      }
    };
  });

  const rrgAvailableThemes = themes.filter(theme => theme.rrg?.status !== 'unavailable');
  const rrgQuadrants = ['leader', 'weakening', 'rebound', 'lagging'];
  const rrg = {
    status: rrgDates.length === RRG_TRAIL_POINTS && rrgAvailableThemes.length === themes.length &&
      rrgAvailableThemes.every(theme => theme.rrg.status === 'ok') ? 'ok' :
      (rrgAvailableThemes.length ? 'partial' : 'unavailable'),
    benchmark: 'SPY',
    benchmarkName: 'S&P 500 ETF',
    benchmarkPriceMode: rrgData.benchmarkPriceMode,
    priceMode: rrgAvailableThemes.length && rrgAvailableThemes.every(theme => theme.rrg.priceMode === 'adjusted-close')
      ? 'adjusted-close'
      : 'raw-close-fallback',
    dividendAdjusted: rrgAvailableThemes.length > 0 && rrgAvailableThemes.every(theme => theme.rrg.dividendAdjusted === true),
    stale: observationFreshness.stale,
    observationFreshness,
    asOf: rrgDates.at(-1) || null,
    dates: rrgDates,
    longPeriodSessions: RRG_LONG_SESSIONS,
    shortPeriodSessions: RRG_SHORT_SESSIONS,
    trailSessions: RRG_TRAIL_SESSIONS,
    availableThemeCount: rrgAvailableThemes.length,
    themeCount: themes.length,
    quadrantCounts: Object.fromEntries(rrgQuadrants.map(quadrant => [
      quadrant,
      rrgAvailableThemes.filter(theme => theme.rrg.quadrant === quadrant).length
    ])),
    methodology: {
      name: 'RRG-style relative rotation graph',
      version: RRG_METHOD_VERSION,
      xAxis: '100 × (63-session equal-weight theme log return minus SPY log return)',
      yAxis: '100 × (5-session equal-weight theme log return minus SPY log return)',
      constituentWeighting: 'equal-weight current fixed basket',
      priceMode: 'adjusted-close preferred; whole-series Yahoo Spark raw fallback is labeled and reference-only',
      dividendsIncludedWhenRaw: false,
      corporateActionAdjustedWhenRaw: false,
      officialRrg: false,
      currentBasketBackcast: true,
      lookahead: false,
      actualFundFlow: false
    }
  };

  const categoryAggregates = INTELLIGENCE_CATEGORIES.map(category => aggregateIntelligenceThemes(
    category.id,
    category.name,
    category.color,
    themes.filter(theme => theme.categoryId === category.id)
  ));
  const marketAggregate = aggregateIntelligenceThemes('market', 'MARKET', '#e2e8f0', themes);
  const scoringAvailable = themes.some(theme => Number.isFinite(theme.score));
  const scoringComplete = themes.every(theme => theme.status === 'ok') && scoringMissingSymbols.length === 0;
  const adjustedDecisionComplete = themes.every(theme => theme.decisionPriceEligible === true);
  const topStatus = !scoringAvailable
    ? 'unavailable'
    : (scoringComplete && adjustedDecisionComplete && rrg.status === 'ok' && !observationFreshness.stale
        ? 'ok'
        : 'partial');

  const candidateEligible = topStatus === 'ok';
  const nextCandidates = candidateEligible
    ? themes.filter(theme => theme.eligible && theme.coverage.pct === 100 && theme.historySamples >= 60 &&
      theme.confidence >= 80 && theme.score >= 50 && theme.score <= 80 && theme.estimatedRotationIndex >= 10 &&
      theme.flowVelocity > 0.75 && theme.acceleration > 0.2 && theme.breadth >= 65 &&
      theme.breadth5 >= 0.6 && theme.peerStability >= 0.9)
      .sort((left, right) => (right.flowVelocity + right.acceleration) - (left.flowVelocity + left.acceleration))
      .slice(0, 8)
      .map((theme, index) => ({
        themeId: theme.id,
        rank: index + 1,
        score: theme.score,
        reason: 'Fresh 100% basket passed score, estimated rotation, velocity, acceleration, breadth, confidence, and peer-stability gates.',
      }))
    : [];

  const structuralEdges = INTELLIGENCE_STRUCTURAL_EDGES.map((edge, index) => ({
    id: `edge:${edge.from}:${edge.to}`,
    from: edge.from,
    fromTheme: edge.from,
    to: edge.to,
    toTheme: edge.to,
    type: edge.type,
    relationKind: edge.type,
    edgeType: 'catalog',
    catalogRelation: true,
    observed: false,
    predictive: false,
    strength: null,
    propagationFlow: null,
    flowScore: null,
    confidence: null,
    lagDays: null,
    eligible: false,
    status: 'catalog-only',
    reason: 'Structural relationship only; no validated lag association is asserted.',
    lastUpdated: retrievedAt,
    order: index
  }));

  const requestedSymbols = [...new Set(INTELLIGENCE_THEME_CATALOG.flatMap(entry => [
    ...entry.relatedTickers,
    ...entry.etfs,
    ...entry.relatedInstruments.map(instrument => instrument.symbol)
  ]))];
  return {
    updatedAt: retrievedAt,
    asOf,
    dataRevision: null,
    status: topStatus,
    partial: topStatus !== 'ok',
    actualFundFlow: false,
    flowProxy: null,
    methodology: {
      method: 'relative-strength-breadth proxy',
      flowMethod: 'price-breadth-estimated-rotation',
      label: '推定ローテーション指数',
      actualFundFlow: false,
      formula: 'I=.45*(robustZ(r5)/3)+.30*(robustZ(r20)/3)+.15*B5+.10*B20; score=clip(50+50I,0,100)',
      lookahead: false,
      confirmedDailyBarsOnly: true,
      memberReturnClipPct: 50,
      minimumMembers: 4,
      minimumMemberCoveragePct: 80,
      minimumPeerThemes: 20,
      sessionSynchronization: 'SPY canonical sessions with exact 1/5/20-session endpoints; missing endpoints are not filled',
      decisionPriceRequirement: '100% adjusted-close endpoints; raw/mixed close results are reference-only',
      volumeUsed: false,
      marketCapUsed: false,
      newsUsed: false,
      rrg: rrg.methodology,
      score50Meaning: 'Cross-sectional peer median, not neutral actual fund flow.'
    },
    availability: {
      price: {
        available: scoringMissingSymbols.length < scoringSymbols.length,
        source: 'yahoo-spark',
        official: false,
        bestEffort: true,
        decisionEligible: adjustedDecisionComplete && !observationFreshness.stale,
        observationFreshness,
        reason: adjustedDecisionComplete
          ? observationFreshness.reason
          : 'One or more scoring baskets use raw/mixed close history; decision outputs are fail-closed.'
      },
      volume: { available: false, used: false, reason: 'Yahoo Spark does not provide volume history.' },
      actualFundFlow: { available: false, value: false, reason: 'Fund subscriptions, redemptions, and order flow are not connected.' },
      rrg: {
        available: rrg.status !== 'unavailable',
        status: rrg.status,
        benchmark: 'SPY',
        availableThemeCount: rrg.availableThemeCount,
        themeCount: rrg.themeCount
      },
      marketCapWeight: { available: false, value: null, used: false },
      newsScore: { available: false, value: null, newsCount: 0, connected: false, used: false }
    },
    summary: { market: marketAggregate },
    rrg,
    categories: categoryAggregates,
    themes,
    edges: structuralEdges,
    nextCandidates,
    observedEvidence: [],
    errors: missingSymbols,
    meta: {
      status: topStatus === 'unavailable' ? 'error' : topStatus,
      source: 'yahoo-spark',
      provider: { name: 'Yahoo Finance Spark', official: false, bestEffort: true },
      cache: 'refreshed',
      stale: false,
      marketObservation: observationFreshness,
      observationStale: observationFreshness.stale,
      catalogVersion: INTELLIGENCE_CATALOG_VERSION,
      evidenceRevision: null,
      membershipVersion: INTELLIGENCE_CATALOG_VERSION,
      effectiveAt: INTELLIGENCE_EFFECTIVE_AT,
      currentBasketBackcast: true,
      officialIndex: false,
      overlapWarning: 'Theme baskets overlap; theme scores are not statistically independent.',
      requestedSymbols: requestedSymbols.length,
      returnedSymbols: requestedSymbols.length - missingSymbols.length,
      scoringSymbols: scoringSymbols.length,
      scoringReturnedSymbols: scoringSymbols.length - scoringMissingSymbols.length,
      scoringMissingSymbols,
      themeCount: themes.length,
      categoryCount: categoryAggregates.length,
      durationMs: 0,
      units: {
        score: 'proxy point 0..100',
        estimatedRotationIndex: 'proxy point -100..100',
        flowIn: 'estimated rotation intensity 0..100, not currency',
        flowOut: 'estimated rotation intensity 0..100, not currency',
        flowVelocity: 'score points/session',
        acceleration: 'score points/session^2',
        breadth: 'percent 0..100',
        breadth5: 'ratio -1..1',
        breadth20: 'ratio -1..1',
        confidence: 'evidence quality 0..100, not probability',
        rrgLongRelativePct: 'percent 63-session relative to SPY',
        rrgShortRelativePct: 'percent 5-session relative to SPY'
      },
      quality: {
        coveragePct: requestedSymbols.length ? Math.round(((requestedSymbols.length - missingSymbols.length) / requestedSymbols.length) * 100) : 0,
        fresh: themes.filter(theme => theme.status === 'ok').length,
        live: 0,
        closeValid: themes.filter(theme => theme.status === 'ok').length,
        stale: 0,
        failed: themes.filter(theme => theme.status === 'unavailable').length,
        delayed: 0,
        aged: 0,
        reference: 0,
        unverified: themes.filter(theme => theme.status === 'partial').length,
        consensusWarnings: 0,
        grade: topStatus === 'unavailable'
          ? 'unavailable'
          : (observationFreshness.stale ? 'stale' : (topStatus === 'ok' ? 'close-valid' : 'partial'))
      }
    },
    _internal: { dates, rawByTheme, scoreByTheme, innovations, peerSets }
  };
}

function selectIntelligencePayload(payload, options = {}) {
  const selected = cloneJson(payload);
  delete selected._internal;
  const stale = Boolean(options.stale);
  const durationMs = Math.max(0, Number(options.durationMs) || 0);
  const ageMs = Number.isFinite(options.ageMs) ? Math.max(0, options.ageMs) : 0;
  selected.actualFundFlow = false;
  selected.flowProxy = null;
  selected.meta = {
    ...(selected.meta || {}),
    cache: options.cache || 'refreshed',
    stale,
    ageMs,
    durationMs
  };

  if (stale) {
    selected.status = selected.status === 'unavailable' ? 'unavailable' : 'partial';
    selected.partial = true;
    if (selected.rrg?.status === 'ok') selected.rrg.status = 'partial';
    if (selected.availability?.rrg) {
      selected.availability.rrg.status = selected.rrg?.status || 'partial';
      selected.availability.rrg.stale = true;
    }
    selected.nextCandidates = [];
    for (const theme of selected.themes || []) {
      theme.cacheState = 'stale-fallback';
      theme.eligible = false;
      theme.entry = theme.status === 'unavailable' ? 'avoid' : 'watch';
      theme.entrySignal = theme.entry;
      if (theme.status === 'ok') theme.status = 'partial';
      if (theme.rrg?.status === 'ok') theme.rrg.status = 'partial';
      if (theme.availability?.rrg) {
        theme.availability.rrg.status = theme.rrg?.status || 'partial';
        theme.availability.rrg.stale = true;
      }
    }
    for (const edge of selected.edges || []) {
      if (!edge.eligible) continue;
      edge.edgeType = 'catalog';
      edge.associationObserved = false;
      edge.strength = null;
      edge.propagationFlow = null;
      edge.flowScore = null;
      edge.confidence = null;
      edge.lagDays = null;
      edge.lagSessions = null;
      edge.eligible = false;
      edge.status = 'stale-disabled';
      edge.reason = 'Dynamic association is disabled because this response uses stale cached observations.';
      delete edge.correlation;
    }
    const quality = selected.meta.quality || {};
    const availableThemes = (selected.themes || []).filter(theme => theme.status !== 'unavailable').length;
    selected.meta.quality = {
      ...quality,
      fresh: 0,
      closeValid: 0,
      stale: availableThemes,
      grade: selected.status === 'unavailable' ? 'unavailable' : 'stale'
    };
  }
  selected.meta.status = selected.status === 'unavailable' ? 'error' : selected.status;
  return stale ? finalizeIntelligenceRevision(selected) : selected;
}

function bestIntelligenceThemeForSymbol(payload, symbol) {
  const normalized = normalizeSymbol(symbol);
  const candidates = (payload?.themes || []).filter(theme => {
    if (theme?.status !== 'ok') return false;
    const related = Array.isArray(theme.relatedTickers)
      ? theme.relatedTickers
      : (Array.isArray(theme.constituents) ? theme.constituents : []);
    return related.some(entry => normalizeSymbol(
      typeof entry === 'string' ? entry : (entry?.symbol || entry?.ticker)
    ) === normalized);
  });
  candidates.sort((left, right) => {
    const scoreDifference = (parseNumber(right?.score) ?? -Infinity) -
      (parseNumber(left?.score) ?? -Infinity);
    if (scoreDifference) return scoreDifference;
    return (parseNumber(right?.confidence) ?? -Infinity) -
      (parseNumber(left?.confidence) ?? -Infinity);
  });
  if (!candidates.length) return null;
  const selected = candidates[0];
  return {
    id: selected.id,
    name: selected.name,
    status: 'ok',
    score: selected.score,
    estimatedRotationIndex: selected.estimatedRotationIndex ?? selected.netFlow ?? null,
    breadth: selected.breadth,
    confidence: selected.confidence,
    trend: selected.trend,
    asOf: selected.asOf || payload?.asOf || null
  };
}

function technicalUnavailableResult(symbol, reason, kind = 'signal') {
  const normalized = normalizeSymbol(symbol);
  const leverageDetection = detectLeveragedProduct(normalized, {});
  const common = {
    symbol: normalized,
    ticker: normalized,
    status: 'unavailable',
    available: false,
    active: false,
    asOf: null,
    warnings: [String(reason || 'Technical history is unavailable.')],
    execution: { ...SIMULATION_EXECUTION },
    tradeEligible: false
  };
  if (kind === 'backtest') {
    return {
      ...common,
      backtest: {
        status: 'unavailable',
        methodVersion: BACKTEST_METHOD_VERSION,
        reason: String(reason || 'Technical history is unavailable.'),
        strategies: []
      },
      quality: {
        priceMode: null,
        dailyBars: 0,
        source: null,
        cacheState: null,
        stale: false
      },
      provenance: {
        source: null,
        range: '5y',
        interval: '1d',
        methodVersion: BACKTEST_METHOD_VERSION
      }
    };
  }
  const unavailableSignals = [
    ['rsiRecovery', 'RSI売られ過ぎ反転'],
    ['macdGoldenCross', 'MACDゴールデンクロス'],
    ['ema20Recovery', 'EMA20回復'],
    ['ema50Recovery', 'EMA50回復'],
    ['volumeExpansion', '出来高拡大'],
    ['supportBounce', '支持帯反発'],
    ['themeStrength', 'テーマ強度'],
    ['fundamentalNews', '決算・材料']
  ].map(([key, label]) => ({
    key,
    label,
    available: false,
    passed: null,
    active: null,
    state: null,
    status: 'unavailable',
    value: null,
    detail: String(reason || 'Technical history is unavailable.'),
    reason: String(reason || 'Technical history is unavailable.')
  }));
  return {
    ...common,
    dataStatus: 'unavailable',
    price: null,
    score: 0,
    decision: 'unavailable',
    recommendation: 'unavailable',
    signals: {
      ...Object.fromEntries(unavailableSignals.map(signal => [signal.key, 'unavailable'])),
      active: 0,
      available: 0,
      total: 8,
      checks: unavailableSignals
    },
    signalsList: unavailableSignals,
    indicators: { daily: null, weekly: null },
    technical: {
      daily: null,
      weekly: null,
      supportCandidates: [],
      vwap: { status: 'unavailable', available: false },
      volumeProfile: { status: 'unavailable', available: false }
    },
    scoreBreakdown: {
      maximum: 100,
      groups: [],
      rawScore: 0,
      deductions: [],
      caps: [],
      finalScore: 0
    },
    theme: { status: 'unavailable', id: null, name: null, score: null },
    fundamental: {
      status: 'unavailable',
      metrics: null,
      earnings: [],
      earningsCalendar: [],
      news: [],
      reason: 'Finnhub補助データは未接続です'
    },
    quality: {
      coveragePct: 0,
      dailyBars: 0,
      weeklyBars: 0,
      priceMode: null,
      adjusted: false,
      stale: false,
      sufficient: false,
      source: null,
      cacheState: null,
      cacheAgeMs: null
    },
    riskReward: null,
    riskRewardDetail: {
      available: false,
      ratio: null,
      minimum: 1.8,
      eligible: false,
      passed: false,
      blocked: true,
      entry: null,
      stop: null,
      take: null
    },
    positionPlan: {
      mode: 'SIMULATE',
      available: false,
      amount: 0,
      amountJpy: 0,
      amountUsd: 0,
      shares: 0,
      entry: null,
      stop: null,
      take: null,
      reason: String(reason || 'Technical history is unavailable.'),
      tradeEligible: false
    },
    leveragedProduct: leverageDetection.leveraged === true,
    leverageStatus: leverageDetection.status,
    leverageBlocked: leverageDetection.status !== 'unleveraged',
    leverageProvenance: leverageDetection,
    chaseBlocked: false,
    earningsDays: null,
    earningsBlocked: false,
    reasons: [],
    provenance: {
      source: null,
      priceMode: null,
      range: '5y',
      interval: '1d',
      methodVersion: TECHNICAL_METHOD_VERSION,
      leverage: leverageDetection,
      vwap: { available: false, reason: 'Intraday bars are not connected.' },
      volumeProfile: { available: false, reason: 'Price-at-volume history is not connected.' }
    }
  };
}

async function mapLimit(items, concurrency, worker) {
  const values = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      values[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return values;
}

class MarketDataService {
  constructor(options = {}) {
    this.fetch = options.fetch || global.fetch;
    if (typeof this.fetch !== 'function') throw new Error('A fetch implementation is required');
    this.now = options.now || Date.now;
    this.clock = options.clock || Date.now;
    this.pause = options.sleep || sleep;
    this.ttlMs = Number(options.ttlMs || process.env.QUOTE_CACHE_TTL_MS) || DEFAULT_TTL_MS;
    this.staleMs = Number(options.staleMs || process.env.QUOTE_STALE_TTL_MS) || DEFAULT_STALE_MS;
    this.timeoutMs = Number(options.timeoutMs || process.env.UPSTREAM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    this.negativeTtlMs = Number(options.negativeTtlMs || process.env.QUOTE_NEGATIVE_TTL_MS) || DEFAULT_NEGATIVE_TTL_MS;
    this.maxCacheEntries = Number(options.maxCacheEntries || process.env.QUOTE_CACHE_MAX_ENTRIES) || DEFAULT_MAX_CACHE_ENTRIES;
    this.deadlineMs = Number(options.deadlineMs || process.env.MARKET_DATA_DEADLINE_MS) || DEFAULT_DEADLINE_MS;
    this.yahooTimeoutMs = Number(options.yahooTimeoutMs || process.env.YAHOO_TIMEOUT_MS) || DEFAULT_YAHOO_TIMEOUT_MS;
    this.finnhubTimeoutMs = Number(options.finnhubTimeoutMs || process.env.FINNHUB_TIMEOUT_MS) || DEFAULT_FINNHUB_TIMEOUT_MS;
    this.nasdaqTimeoutMs = Number(options.nasdaqTimeoutMs || process.env.NASDAQ_TIMEOUT_MS) || DEFAULT_NASDAQ_TIMEOUT_MS;
    this.nasdaqMaxSymbols = Number(options.nasdaqMaxSymbols || process.env.NASDAQ_MAX_SYMBOLS) || DEFAULT_NASDAQ_MAX_SYMBOLS;
    this.finnhubCallsPerMinute = Number(options.finnhubCallsPerMinute || process.env.FINNHUB_CALLS_PER_MINUTE) || DEFAULT_FINNHUB_CALLS_PER_MINUTE;
    const configuredBatchWindow = Number(options.yahooBatchWindowMs ?? process.env.YAHOO_BATCH_WINDOW_MS);
    const configuredInFlightLimit = Number(options.maxInFlightEntries ?? process.env.MARKET_DATA_MAX_IN_FLIGHT);
    const configuredDivergence = Number(options.providerDivergencePct ?? process.env.PROVIDER_DIVERGENCE_PCT);
    this.yahooBatchWindowMs = Number.isFinite(configuredBatchWindow)
      ? Math.min(1_000, Math.max(0, configuredBatchWindow))
      : DEFAULT_YAHOO_BATCH_WINDOW_MS;
    this.maxInFlightEntries = Number.isFinite(configuredInFlightLimit)
      ? Math.min(5_000, Math.max(10, Math.floor(configuredInFlightLimit)))
      : DEFAULT_MAX_IN_FLIGHT_ENTRIES;
    this.providerDivergencePct = Number.isFinite(configuredDivergence)
      ? Math.min(25, Math.max(0.1, configuredDivergence))
      : DEFAULT_PROVIDER_DIVERGENCE_PCT;
    this.themeTtlMs = Number(options.themeTtlMs || process.env.THEME_CACHE_TTL_MS) || DEFAULT_THEME_CACHE_TTL_MS;
    this.themePartialTtlMs = Number(options.themePartialTtlMs || process.env.THEME_PARTIAL_CACHE_TTL_MS) || DEFAULT_THEME_PARTIAL_TTL_MS;
    this.themeStaleMs = Number(options.themeStaleMs || process.env.THEME_STALE_TTL_MS) || DEFAULT_THEME_STALE_MS;
    this.themeDeadlineMs = Number(options.themeDeadlineMs || process.env.THEME_DATA_DEADLINE_MS) || DEFAULT_THEME_DEADLINE_MS;
    this.themeTimeoutMs = Number(options.themeTimeoutMs || process.env.THEME_UPSTREAM_TIMEOUT_MS) || DEFAULT_THEME_TIMEOUT_MS;
    this.themeBatchSize = Math.min(20, Math.max(1,
      Number(options.themeBatchSize || process.env.THEME_YAHOO_BATCH_SIZE) || DEFAULT_THEME_BATCH_SIZE
    ));
    this.historyCacheMaxEntries = Math.max(50,
      Number(options.historyCacheMaxEntries || process.env.HISTORY_CACHE_MAX_ENTRIES) || DEFAULT_HISTORY_CACHE_MAX_ENTRIES
    );
    this.intelligenceTtlMs = Number(options.intelligenceTtlMs || process.env.INTELLIGENCE_CACHE_TTL_MS) || DEFAULT_INTELLIGENCE_CACHE_TTL_MS;
    this.intelligencePartialTtlMs = Number(options.intelligencePartialTtlMs || process.env.INTELLIGENCE_PARTIAL_CACHE_TTL_MS) || DEFAULT_INTELLIGENCE_PARTIAL_TTL_MS;
    this.intelligenceStaleMs = Number(options.intelligenceStaleMs || process.env.INTELLIGENCE_STALE_TTL_MS) || DEFAULT_INTELLIGENCE_STALE_MS;
    this.intelligenceDeadlineMs = Number(options.intelligenceDeadlineMs || process.env.INTELLIGENCE_DATA_DEADLINE_MS) || DEFAULT_INTELLIGENCE_DEADLINE_MS;
    this.marketRegimeTtlMs = Number(options.marketRegimeTtlMs || process.env.MARKET_REGIME_CACHE_TTL_MS) || DEFAULT_MARKET_REGIME_CACHE_TTL_MS;
    this.marketRegimePartialTtlMs = Number(options.marketRegimePartialTtlMs || process.env.MARKET_REGIME_PARTIAL_CACHE_TTL_MS) || DEFAULT_MARKET_REGIME_PARTIAL_TTL_MS;
    this.marketRegimeStaleMs = Number(options.marketRegimeStaleMs || process.env.MARKET_REGIME_STALE_TTL_MS) || DEFAULT_MARKET_REGIME_STALE_MS;
    this.marketRegimeDeadlineMs = Number(options.marketRegimeDeadlineMs || process.env.MARKET_REGIME_DATA_DEADLINE_MS) || DEFAULT_MARKET_REGIME_DEADLINE_MS;
    this.marketRegimeSpyAdjustedTtlMs = Number(
      options.marketRegimeSpyAdjustedTtlMs || process.env.MARKET_REGIME_SPY_ADJUSTED_TTL_MS
    ) || DEFAULT_MARKET_REGIME_SPY_ADJUSTED_TTL_MS;
    this.technicalTtlMs = Number(
      options.technicalTtlMs || process.env.TECHNICAL_CACHE_TTL_MS
    ) || DEFAULT_TECHNICAL_CACHE_TTL_MS;
    this.technicalStaleMs = Number(
      options.technicalStaleMs || process.env.TECHNICAL_STALE_TTL_MS
    ) || DEFAULT_TECHNICAL_STALE_MS;
    this.technicalDeadlineMs = Number(
      options.technicalDeadlineMs || process.env.TECHNICAL_DATA_DEADLINE_MS
    ) || DEFAULT_TECHNICAL_DEADLINE_MS;
    this.technicalTimeoutMs = Number(
      options.technicalTimeoutMs || process.env.TECHNICAL_UPSTREAM_TIMEOUT_MS
    ) || DEFAULT_TECHNICAL_TIMEOUT_MS;
    this.technicalBatchSize = Math.min(20, Math.max(1,
      Number(options.technicalBatchSize || process.env.TECHNICAL_YAHOO_BATCH_SIZE) ||
        DEFAULT_TECHNICAL_BATCH_SIZE
    ));
    this.technicalChartConcurrency = Math.min(6, Math.max(1,
      Number(options.technicalChartConcurrency || process.env.TECHNICAL_CHART_CONCURRENCY) ||
        DEFAULT_TECHNICAL_CHART_CONCURRENCY
    ));
    this.technicalCacheMaxEntries = Math.max(20,
      Number(options.technicalCacheMaxEntries || process.env.TECHNICAL_CACHE_MAX_ENTRIES) ||
        DEFAULT_TECHNICAL_CACHE_MAX_ENTRIES
    );
    this.technicalFinnhubCacheTtlMs = Number(
      options.technicalFinnhubCacheTtlMs || process.env.TECHNICAL_FINNHUB_CACHE_TTL_MS
    ) || DEFAULT_TECHNICAL_FINNHUB_CACHE_TTL_MS;
    this.technicalFinnhubMaxSymbols = Math.min(20, Math.max(0,
      Number(options.technicalFinnhubMaxSymbols ?? process.env.TECHNICAL_FINNHUB_MAX_SYMBOLS) ||
        DEFAULT_TECHNICAL_FINNHUB_MAX_SYMBOLS
    ));
    this.finnhubKey = options.finnhubKey ?? process.env.FINNHUB_API_KEY ?? '';
    this.cache = new Map();
    this.negativeCache = new Map();
    this.themeCache = null;
    this.themeInFlight = null;
    this.historyCache = new Map();
    this.intelligenceCache = null;
    this.intelligenceInFlight = null;
    this.marketRegimeCache = null;
    this.marketRegimePartialCache = null;
    this.marketRegimeInFlight = null;
    this.marketRegimeInFlightForce = false;
    this.marketRegimeForceQueued = null;
    this.marketRegimeSpyAdjustedCache = null;
    this.marketRegimeSpyAdjustedInFlight = null;
    this.technicalHistoryCache = new Map();
    this.technicalHistoryInFlight = null;
    this.technicalFinnhubCache = new Map();
    this.technicalFinnhubInFlight = new Map();
    // Provider work is deliberately detached from any one HTTP client. Each
    // caller races the shared promise with its own deadline/AbortSignal.
    this.inFlight = new Map();
    this.yahooFlights = new Map();
    this.yahooPending = new Map();
    this.yahooFlushTimer = null;
    this.yahooQueue = Promise.resolve();
    this.stats = new Map();
    this.circuits = new Map();
    this.finnhubBudget = { startedAt: this.clock(), count: 0 };
    this.coalescing = {
      sharedJoins: 0,
      yahooJoins: 0,
      yahooBatches: 0,
      yahooSymbolsRequested: 0,
      yahooUniqueFetched: 0,
      capacityDrops: 0
    };
    this.consensus = {
      checks: 0,
      divergences: 0,
      inconclusive: 0,
      lastDivergenceAt: null,
      lastDifferencePct: null
    };
  }

  _provider(name) {
    if (!this.stats.has(name)) {
      this.stats.set(name, {
        requests: 0,
        successes: 0,
        failures: 0,
        lastStatus: null,
        lastLatencyMs: null,
        lastOkAt: null,
        lastErrorAt: null,
        lastError: null,
        consecutiveFailures: 0,
        recoveries: 0,
        lastRecoveredAt: null,
        circuitTrips: 0,
        lastCircuitAt: null
      });
    }
    return this.stats.get(name);
  }

  _record(name, { ok, status, latencyMs, error }) {
    const stat = this._provider(name);
    stat.requests += 1;
    stat.lastStatus = status ?? null;
    stat.lastLatencyMs = latencyMs;
    if (ok) {
      if (stat.consecutiveFailures > 0) {
        stat.recoveries += 1;
        stat.lastRecoveredAt = new Date(this.now()).toISOString();
      }
      stat.successes += 1;
      stat.consecutiveFailures = 0;
      stat.lastOkAt = new Date(this.now()).toISOString();
      stat.lastError = null;
    } else {
      stat.failures += 1;
      stat.consecutiveFailures += 1;
      stat.lastErrorAt = new Date(this.now()).toISOString();
      stat.lastError = String(error?.message || error || 'upstream error').slice(0, 180);
    }
  }

  _contextActive(context) {
    return !context?.signal?.aborted && (!context?.deadlineAt || this.clock() < context.deadlineAt);
  }

  _abortError(message, code = 'ABORTED') {
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = code;
    return error;
  }

  _circuitError(provider, until) {
    const error = new Error(`${provider} circuit is open`);
    error.code = 'CIRCUIT_OPEN';
    error.retryAt = new Date(until).toISOString();
    return error;
  }

  _circuitUntil(provider) {
    const until = this.circuits.get(provider) || 0;
    if (until && this.clock() >= until) {
      this.circuits.delete(provider);
      return 0;
    }
    return until;
  }

  _tripCircuit(provider, error) {
    const status = Number(error?.status) || 0;
    const retryMs = Number(error?.retryAfterMs) || 0;
    if (error?.code === 'CLIENT_ABORT' || error?.code === 'DEADLINE') return;
    const shouldTrip = error?.name === 'AbortError' || status === 403 || status === 429 || status >= 500;
    if (!shouldTrip) return;
    let duration = retryMs || (status === 429 ? 60_000 : 15_000);
    if (provider === 'nasdaq') duration = Math.max(duration, 120_000);
    const until = this.clock() + Math.min(duration, 10 * 60_000);
    const previousUntil = this.circuits.get(provider) || 0;
    this.circuits.set(provider, Math.max(previousUntil, until));
    if (!previousUntil || previousUntil <= this.clock()) {
      const stat = this._provider(provider);
      stat.circuitTrips += 1;
      stat.lastCircuitAt = new Date(this.now()).toISOString();
    }
  }

  _takeFinnhubBudget() {
    const now = this.clock();
    if (now - this.finnhubBudget.startedAt >= 60_000) {
      this.finnhubBudget = { startedAt: now, count: 0 };
    }
    if (this.finnhubBudget.count >= this.finnhubCallsPerMinute) {
      this.circuits.set('finnhub', this.finnhubBudget.startedAt + 60_000);
      return false;
    }
    this.finnhubBudget.count += 1;
    return true;
  }

  _raceContext(promise, context) {
    if (!context) return promise;
    if (!this._contextActive(context)) {
      const cancelled = Boolean(context.signal?.aborted);
      return Promise.reject(this._abortError(
        cancelled ? 'market data request was cancelled' : 'market data deadline reached',
        cancelled ? 'CLIENT_ABORT' : 'DEADLINE'
      ));
    }
    const remaining = Math.max(1, context.deadlineAt - this.clock());
    let timer;
    let onAbort;
    const stopped = new Promise((_, reject) => {
      timer = setTimeout(() => reject(this._abortError('market data deadline reached', 'DEADLINE')), remaining);
      if (context.signal) {
        onAbort = () => reject(this._abortError('market data request was cancelled', 'CLIENT_ABORT'));
        context.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    return Promise.race([promise, stopped]).finally(() => {
      clearTimeout(timer);
      if (onAbort) context.signal.removeEventListener('abort', onAbort);
    });
  }

  _sharedContext() {
    return { deadlineAt: this.clock() + this.deadlineMs, signal: null };
  }

  _sharedQuote(provider, symbol, loader, callerContext) {
    const key = `${provider}:${symbol}`;
    let work = this.inFlight.get(key);
    if (work) {
      this.coalescing.sharedJoins += 1;
    } else if (this.inFlight.size >= this.maxInFlightEntries) {
      this.coalescing.capacityDrops += 1;
      work = Promise.resolve(null);
    } else {
      const sharedContext = this._sharedContext();
      work = Promise.resolve()
        .then(() => loader(sharedContext))
        .then(quote => {
          if (quote) this._setCache(symbol, quote);
          return quote || null;
        })
        .catch(() => null)
        .finally(() => {
          if (this.inFlight.get(key) === work) this.inFlight.delete(key);
        });
      this.inFlight.set(key, work);
    }
    return this._raceContext(work, callerContext);
  }

  async _requestJson(provider, url, options = {}) {
    if (typeof options === 'number') options = { timeoutMs: options };
    const timeoutMs = Number(options.timeoutMs) || this.timeoutMs;
    const context = options.context || null;
    const openUntil = this._circuitUntil(provider);
    if (openUntil) throw this._circuitError(provider, openUntil);
    if (!this._contextActive(context)) {
      const cancelled = Boolean(context?.signal?.aborted);
      throw this._abortError(
        cancelled ? `${provider} request was cancelled` : 'market data deadline reached',
        cancelled ? 'CLIENT_ABORT' : 'DEADLINE'
      );
    }

    const started = this.clock();
    const remaining = context?.deadlineAt ? context.deadlineAt - started : timeoutMs;
    const effectiveTimeout = Math.max(1, Math.min(timeoutMs, remaining));
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeout);
    const externalAbort = () => controller.abort();
    if (context?.signal) context.signal.addEventListener('abort', externalAbort, { once: true });
    let status = null;
    try {
      const operation = (async () => {
        const response = await this.fetch(url, {
          headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) },
          signal: controller.signal,
          redirect: 'follow'
        });
        status = response.status;
        if (!response.ok) {
          const error = new Error(`${provider} returned HTTP ${response.status}`);
          error.status = response.status;
          const retryAfter = response.headers?.get?.('retry-after');
          if (retryAfter) {
            const seconds = Number(retryAfter);
            const dateMs = Date.parse(retryAfter);
            error.retryAfterMs = Number.isFinite(seconds)
              ? Math.max(0, seconds * 1000)
              : (Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 0);
          }
          throw error;
        }
        return response.json();
      })();
      const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => {
        const code = context?.signal?.aborted ? 'CLIENT_ABORT' : (timedOut ? 'UPSTREAM_TIMEOUT' : 'ABORTED');
        reject(this._abortError(
          code === 'CLIENT_ABORT' ? `${provider} request was cancelled` : `${provider} timed out after ${effectiveTimeout}ms`,
          code
        ));
      }, { once: true }));
      const payload = await Promise.race([operation, aborted]);
      this._record(provider, { ok: true, status, latencyMs: this.clock() - started });
      return payload;
    } catch (error) {
      const normalized = error?.name === 'AbortError'
        ? error
        : error;
      this._tripCircuit(provider, normalized);
      this._record(provider, {
        ok: false,
        status,
        latencyMs: this.clock() - started,
        error: normalized
      });
      throw normalized;
    } finally {
      clearTimeout(timer);
      if (context?.signal) context.signal.removeEventListener('abort', externalAbort);
    }
  }

  _setCache(symbol, quote) {
    if (!quote) return;
    const previous = this.cache.get(symbol)?.value;
    const value = {
      ...quote,
      closes: normalizeCloses(quote.closes?.length ? quote.closes : (previous?.closes || []))
    };
    this.cache.delete(symbol);
    this.cache.set(symbol, { savedAt: this.now(), value });
    this.negativeCache.delete(symbol);
    while (this.cache.size > this.maxCacheEntries) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  _cacheValue(symbol, maxAgeMs) {
    return this._cacheLookup(symbol, maxAgeMs)?.value || null;
  }

  _cacheLookup(symbol, maxAgeMs) {
    const entry = this.cache.get(symbol);
    if (!entry || this.now() - entry.savedAt > maxAgeMs) return null;
    this.cache.delete(symbol);
    this.cache.set(symbol, entry);
    return {
      savedAt: entry.savedAt,
      ageMs: Math.max(0, this.now() - entry.savedAt),
      value: { ...entry.value, closes: [...(entry.value.closes || [])] }
    };
  }

  _isNegativeCached(symbol) {
    const expiresAt = this.negativeCache.get(symbol);
    if (!expiresAt) return false;
    if (this.now() >= expiresAt) {
      this.negativeCache.delete(symbol);
      return false;
    }
    return true;
  }

  _setNegativeCache(symbol) {
    const now = this.now();
    for (const [key, expiresAt] of this.negativeCache) {
      if (now >= expiresAt) this.negativeCache.delete(key);
    }
    this.negativeCache.delete(symbol);
    this.negativeCache.set(symbol, now + this.negativeTtlMs);
    while (this.negativeCache.size > this.maxCacheEntries) {
      this.negativeCache.delete(this.negativeCache.keys().next().value);
    }
  }

  _mergeYahooQuote(symbol, quote) {
    const current = this._cacheValue(symbol, this.ttlMs);
    if (current?.src === 'finnhub') {
      const checkedAt = new Date(this.now()).toISOString();
      const providerComparison = compareProviders(current, quote, this.providerDivergencePct, checkedAt);
      if (providerComparison) {
        this.consensus.checks += 1;
        this.consensus.lastDifferencePct = providerComparison.differencePct;
        if (providerComparison.status === 'divergent') {
          this.consensus.divergences += 1;
          this.consensus.lastDivergenceAt = checkedAt;
        } else if (providerComparison.status === 'inconclusive') {
          this.consensus.inconclusive += 1;
        }
      }
      this._setCache(symbol, {
        ...current,
        closes: quote.closes || [],
        name: current.name || quote.name,
        exchange: current.exchange || quote.exchange,
        currency: current.currency || quote.currency,
        marketState: current.marketState && current.marketState !== 'unknown'
          ? current.marketState
          : quote.marketState,
        providerComparison
      });
      return this._cacheValue(symbol, this.ttlMs);
    }
    this._setCache(symbol, quote);
    return quote;
  }

  _queueYahooSymbol(symbol) {
    const existing = this.yahooFlights.get(symbol);
    if (existing) {
      this.coalescing.yahooJoins += 1;
      return existing.promise;
    }
    if (this.yahooFlights.size >= this.maxInFlightEntries) {
      this.coalescing.capacityDrops += 1;
      return Promise.resolve(null);
    }

    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const entry = { promise, resolve };
    this.yahooFlights.set(symbol, entry);
    this.yahooPending.set(symbol, entry);

    if (!this.yahooFlushTimer) {
      this.yahooFlushTimer = setTimeout(() => {
        this.yahooFlushTimer = null;
        void this._flushYahooBatch();
      }, this.yahooBatchWindowMs);
    }
    return promise;
  }

  async _flushYahooBatch() {
    if (!this.yahooPending.size) return;
    const batch = this.yahooPending;
    this.yahooPending = new Map();
    const symbols = [...batch.keys()];
    const context = this._sharedContext();
    this.coalescing.yahooBatches += 1;
    this.coalescing.yahooUniqueFetched += symbols.length;

    const task = this.yahooQueue.then(() => (
      this._contextActive(context) ? this._yahooSpark(symbols, context) : new Map()
    ));
    this.yahooQueue = task.then(() => undefined, () => undefined);

    let result;
    try {
      result = await this._raceContext(task, context);
    } catch (_) {
      result = new Map();
    }

    for (const [symbol, entry] of batch) {
      const quote = result.get(symbol) || null;
      let merged = null;
      try {
        merged = quote ? this._mergeYahooQuote(symbol, quote) : null;
      } catch (_) {
        merged = null;
      } finally {
        entry.resolve(merged);
        if (this.yahooFlights.get(symbol) === entry) this.yahooFlights.delete(symbol);
      }
    }
  }

  yahooSpark(symbols, context) {
    if (!this._contextActive(context)) {
      return Promise.reject(this._abortError('market data deadline reached', context?.signal?.aborted ? 'CLIENT_ABORT' : 'DEADLINE'));
    }
    const unique = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
    this.coalescing.yahooSymbolsRequested += unique.length;
    const combined = Promise.all(unique.map(async symbol => [symbol, await this._queueYahooSymbol(symbol)]))
      .then(entries => new Map(entries.filter(([, quote]) => quote)));
    return this._raceContext(combined, context);
  }

  async _yahooSpark(symbols, context) {
    const unique = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
    const collected = new Map();
    let remaining = unique;

    for (const host of ['query1', 'query2']) {
      if (!remaining.length || !this._contextActive(context)) break;
      const params = new URLSearchParams({
        symbols: remaining.join(','),
        range: '3mo',
        interval: '1d'
      });
      try {
        const payload = await this._requestJson(
          `yahoo-${host}`,
          `https://${host}.finance.yahoo.com/v7/finance/spark?${params}`,
          { timeoutMs: this.yahooTimeoutMs, context }
        );
        const retrievedAt = new Date(this.now()).toISOString();
        const parsed = parseYahooSpark(payload, retrievedAt, this.now());
        for (const [symbol, quote] of parsed) collected.set(symbol, quote);
        remaining = remaining.filter(symbol => !collected.has(symbol));
      } catch (_) {
        // The next Yahoo host and independent providers are deliberate fallbacks.
      }
      if (remaining.length && this._contextActive(context)) await this.pause(300);
    }
    return collected;
  }

  _themeCacheLookup(maxAgeMs) {
    if (!this.themeCache) return null;
    const ageMs = Math.max(0, this.now() - this.themeCache.savedAt);
    if (ageMs > maxAgeMs) return null;
    return { ageMs, value: this.themeCache.value };
  }

  _intelligenceCacheLookup(maxAgeMs) {
    if (!this.intelligenceCache) return null;
    const ageMs = Math.max(0, this.now() - this.intelligenceCache.savedAt);
    if (ageMs > maxAgeMs) return null;
    return { ageMs, value: this.intelligenceCache.value };
  }

  _marketRegimeCacheLookup(maxAgeMs, tier = 'complete') {
    const cache = tier === 'partial' ? this.marketRegimePartialCache : this.marketRegimeCache;
    if (!cache) return null;
    const ageMs = Math.max(0, this.now() - cache.savedAt);
    if (ageMs > maxAgeMs) return null;
    return { ageMs, savedAt: cache.savedAt, tier, value: cache.value };
  }

  _historyCacheLookup(symbol, maxAgeMs) {
    const entry = this.historyCache.get(symbol);
    if (!entry) return null;
    const ageMs = Math.max(0, this.now() - entry.savedAt);
    if (ageMs > maxAgeMs) return null;
    this.historyCache.delete(symbol);
    this.historyCache.set(symbol, entry);
    return entry.value;
  }

  _setHistoryCache(symbol, history) {
    this.historyCache.delete(symbol);
    this.historyCache.set(symbol, { savedAt: this.now(), value: history });
    while (this.historyCache.size > this.historyCacheMaxEntries) {
      this.historyCache.delete(this.historyCache.keys().next().value);
    }
  }

  async _yahooThemeHistory(symbols, context, options = {}) {
    const collected = new Map();
    const unique = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
    const missing = [];
    const bypassCache = options.bypassCache === true;
    for (const symbol of unique) {
      const cached = bypassCache
        ? null
        : this._historyCacheLookup(symbol, Math.min(this.themeTtlMs, this.intelligenceTtlMs));
      if (cached) collected.set(symbol, cached);
      else missing.push(symbol);
    }
    for (let offset = 0; offset < missing.length; offset += this.themeBatchSize) {
      let remaining = missing.slice(offset, offset + this.themeBatchSize);
      for (const host of ['query1', 'query2']) {
        if (!remaining.length || !this._contextActive(context)) break;
        const requested = new Set(remaining);
        const params = new URLSearchParams({
          symbols: remaining.join(','),
          range: '2y',
          interval: '1d',
          events: 'div,splits',
          includePrePost: 'false'
        });
        try {
          const payload = await this._requestJson(
            `yahoo-${host}`,
            `https://${host}.finance.yahoo.com/v7/finance/spark?${params}`,
            { timeoutMs: this.themeTimeoutMs, context }
          );
          const parsed = parseYahooThemeHistory(payload, this.now());
          for (const [symbol, history] of parsed) {
            if (requested.has(symbol)) {
              collected.set(symbol, history);
              this._setHistoryCache(symbol, history);
            }
          }
          remaining = remaining.filter(symbol => !collected.has(symbol));
        } catch (_) {
          // One batch against the second Yahoo host is the only retry. Individual
          // symbol retries would create an expensive N+1 pattern on Render.
        }
        if (remaining.length && this._contextActive(context)) await this.pause(250);
      }
    }
    return collected;
  }

  _technicalHistoryCacheLookup(symbol, maxAgeMs) {
    const entry = this.technicalHistoryCache.get(symbol);
    if (!entry) return null;
    const ageMs = Math.max(0, this.now() - entry.savedAt);
    if (ageMs > maxAgeMs) return null;
    this.technicalHistoryCache.delete(symbol);
    this.technicalHistoryCache.set(symbol, entry);
    return {
      ageMs,
      value: {
        ...entry.value,
        bars: (entry.value?.bars || []).map(bar => ({ ...bar }))
      }
    };
  }

  _setTechnicalHistoryCache(symbol, history) {
    if (!history?.bars?.length) return;
    this.technicalHistoryCache.delete(symbol);
    this.technicalHistoryCache.set(symbol, {
      savedAt: this.now(),
      value: {
        ...history,
        bars: history.bars.map(bar => ({ ...bar }))
      }
    });
    while (this.technicalHistoryCache.size > this.technicalCacheMaxEntries) {
      this.technicalHistoryCache.delete(this.technicalHistoryCache.keys().next().value);
    }
  }

  async _yahooTechnicalHistory(symbols, context) {
    const collected = new Map();
    const unique = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
    for (let offset = 0; offset < unique.length; offset += this.technicalBatchSize) {
      let remaining = unique.slice(offset, offset + this.technicalBatchSize);
      for (const host of ['query1', 'query2']) {
        if (!remaining.length || !this._contextActive(context)) break;
        const requested = new Set(remaining);
        const params = new URLSearchParams({
          symbols: remaining.join(','),
          range: '5y',
          interval: '1d',
          events: 'div,splits',
          includePrePost: 'false'
        });
        try {
          const payload = await this._requestJson(
            `yahoo-technical-${host}`,
            `https://${host}.finance.yahoo.com/v7/finance/spark?${params}`,
            { timeoutMs: this.technicalTimeoutMs, context }
          );
          const parsed = parseYahooTechnicalHistory(payload, this.now());
          for (const [symbol, history] of parsed) {
            if (!requested.has(symbol)) continue;
            collected.set(symbol, history);
            this._setTechnicalHistoryCache(symbol, history);
          }
          remaining = remaining.filter(symbol => !collected.has(symbol));
        } catch (error) {
          if (error?.code === 'CLIENT_ABORT' || error?.code === 'DEADLINE') throw error;
          // One retry on the second Yahoo host is deliberate. Per-symbol
          // retries would create an N+1 burst on Render's shared IP.
        }
        if (remaining.length && this._contextActive(context)) await this.pause(250);
      }
    }
    const chartFallbackSymbols = unique.filter(symbol => !collected.has(symbol));
    await mapLimit(
      chartFallbackSymbols,
      this.technicalChartConcurrency,
      async symbol => {
        for (const host of ['query1', 'query2']) {
          if (!this._contextActive(context)) break;
          const params = new URLSearchParams({
            range: '5y',
            interval: '1d',
            events: 'div,splits',
            includePrePost: 'false'
          });
          try {
            const payload = await this._requestJson(
              `yahoo-technical-chart-${host}`,
              `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`,
              { timeoutMs: this.technicalTimeoutMs, context }
            );
            const history = parseYahooTechnicalChartHistory(payload, symbol, this.now());
            if (history) {
              collected.set(symbol, history);
              this._setTechnicalHistoryCache(symbol, history);
              return;
            }
          } catch (error) {
            if (error?.code === 'CLIENT_ABORT' || error?.code === 'DEADLINE') throw error;
          }
          if (host === 'query1' && this._contextActive(context)) await this.pause(100);
        }
      }
    );
    return collected;
  }

  async _getTechnicalHistories(symbols, context, options = {}) {
    const unique = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
    const forceRefresh = options.forceRefresh === true;
    const initiallyFresh = new Set();
    if (!forceRefresh) {
      for (const symbol of unique) {
        if (this._technicalHistoryCacheLookup(symbol, this.technicalTtlMs)) {
          initiallyFresh.add(symbol);
        }
      }
    }

    let activeSatisfiedForce = false;
    if (this.technicalHistoryInFlight) {
      const active = this.technicalHistoryInFlight;
      try {
        await this._raceContext(active.promise, context);
        activeSatisfiedForce = forceRefresh && active.force === true &&
          unique.every(symbol => active.symbols.has(symbol));
      } catch (error) {
        if (error?.code === 'CLIENT_ABORT') throw error;
      }
    }

    let missing = unique.filter(symbol => {
      if (forceRefresh && !activeSatisfiedForce) return true;
      return !this._technicalHistoryCacheLookup(symbol, this.technicalTtlMs);
    });
    const refreshed = new Set();
    if (missing.length && this._contextActive(context)) {
      const sharedContext = {
        deadlineAt: this.clock() + this.technicalDeadlineMs,
        signal: null
      };
      const active = {
        promise: null,
        symbols: new Set(missing),
        force: forceRefresh
      };
      const task = this.yahooQueue.then(() => this._yahooTechnicalHistory(missing, sharedContext));
      this.yahooQueue = task.then(() => undefined, () => undefined);
      active.promise = task.finally(() => {
        if (this.technicalHistoryInFlight === active) this.technicalHistoryInFlight = null;
      });
      this.technicalHistoryInFlight = active;
      try {
        const loaded = await this._raceContext(active.promise, context);
        for (const symbol of loaded.keys()) refreshed.add(symbol);
      } catch (error) {
        if (error?.code === 'CLIENT_ABORT') throw error;
      }
    }

    const histories = new Map();
    for (const symbol of unique) {
      const fresh = this._technicalHistoryCacheLookup(symbol, this.technicalTtlMs);
      if (fresh) {
        histories.set(symbol, {
          ...fresh.value,
          cacheState: refreshed.has(symbol) || (forceRefresh && !initiallyFresh.has(symbol))
            ? 'refreshed'
            : 'hit',
          cacheAgeMs: fresh.ageMs,
          stale: false
        });
        continue;
      }
      const stale = this._technicalHistoryCacheLookup(symbol, this.technicalStaleMs);
      if (stale) {
        histories.set(symbol, {
          ...stale.value,
          cacheState: 'stale-fallback',
          cacheAgeMs: stale.ageMs,
          stale: true
        });
      }
    }
    return histories;
  }

  async _refreshThemes(context) {
    const symbols = [...new Set(THEME_CATALOG.flatMap(entry => entry.members.map(member => member.symbol)))];
    const task = this.yahooQueue.then(() => this._yahooThemeHistory(symbols, context));
    this.yahooQueue = task.then(() => undefined, () => undefined);
    const histories = await this._raceContext(task, context);
    return buildThemePayload(histories, new Date(this.now()).toISOString());
  }

  async getThemes(options = {}) {
    const startedAt = this.clock();
    const ids = Array.isArray(options.ids) ? [...new Set(options.ids)] : null;
    const currentCache = this.themeCache;
    const freshTtl = currentCache?.value?.status === 'ok'
      ? this.themeTtlMs
      : Math.min(this.themeTtlMs, this.themePartialTtlMs);
    const fresh = this._themeCacheLookup(freshTtl);
    if (fresh) {
      return selectThemePayload(fresh.value, ids, {
        cache: 'hit',
        ageMs: fresh.ageMs,
        durationMs: this.clock() - startedAt
      });
    }

    const callerContext = {
      deadlineAt: this.clock() + this.themeDeadlineMs,
      signal: options.signal || null
    };
    let work = this.themeInFlight;
    if (!work) {
      const sharedContext = { deadlineAt: this.clock() + this.themeDeadlineMs, signal: null };
      work = Promise.resolve()
        .then(() => this._refreshThemes(sharedContext))
        .then(payload => {
          if (payload.meta.returnedSymbols > 0) {
            this.themeCache = { savedAt: this.now(), value: payload };
          }
          return payload;
        })
        .finally(() => {
          if (this.themeInFlight === work) this.themeInFlight = null;
        });
      this.themeInFlight = work;
    }

    let refreshed;
    try {
      refreshed = await this._raceContext(work, callerContext);
    } catch (error) {
      if (error?.code === 'CLIENT_ABORT') throw error;
      const stale = this._themeCacheLookup(this.themeStaleMs);
      if (stale) {
        return selectThemePayload(stale.value, ids, {
          cache: 'stale-fallback',
          stale: true,
          ageMs: stale.ageMs,
          durationMs: this.clock() - startedAt
        });
      }
      throw error;
    }

    if (refreshed.meta.returnedSymbols === 0) {
      const stale = this._themeCacheLookup(this.themeStaleMs);
      if (stale) {
        return selectThemePayload(stale.value, ids, {
          cache: 'stale-fallback',
          stale: true,
          ageMs: stale.ageMs,
          durationMs: this.clock() - startedAt
        });
      }
    }
    return selectThemePayload(refreshed, ids, {
      cache: 'refreshed',
      ageMs: 0,
      durationMs: this.clock() - startedAt
    });
  }

  async _refreshThemeIntelligence(context) {
    const symbols = [...new Set([
      'SPY',
      ...INTELLIGENCE_THEME_CATALOG.flatMap(entry => [
        ...entry.relatedTickers,
        ...entry.etfs,
        ...entry.relatedInstruments.map(instrument => instrument.symbol)
      ])
    ])];
    const task = this.yahooQueue.then(() => this._yahooThemeHistory(symbols, context));
    this.yahooQueue = task.then(() => undefined, () => undefined);
    const histories = await this._raceContext(task, context);
    const payload = buildIntelligencePayload(histories, new Date(this.now()).toISOString());
    return applyValidatedEdgeAssociations(payload);
  }

  async getThemeIntelligence(options = {}) {
    const startedAt = this.clock();
    const currentCache = this.intelligenceCache;
    const cachedMeta = currentCache?.value?.meta;
    const cacheHasCompleteScoringUniverse = currentCache?.value?.status !== 'unavailable' &&
      currentCache?.value?.rrg?.status !== 'unavailable' && cachedMeta?.observationStale !== true &&
      Number(cachedMeta?.scoringReturnedSymbols) === Number(cachedMeta?.scoringSymbols);
    const freshTtl = cacheHasCompleteScoringUniverse
      ? this.intelligenceTtlMs
      : Math.min(this.intelligenceTtlMs, this.intelligencePartialTtlMs);
    const fresh = this._intelligenceCacheLookup(freshTtl);
    if (fresh) {
      return selectIntelligencePayload(fresh.value, {
        cache: 'hit',
        ageMs: fresh.ageMs,
        durationMs: this.clock() - startedAt
      });
    }

    const callerContext = {
      deadlineAt: this.clock() + this.intelligenceDeadlineMs,
      signal: options.signal || null
    };
    let work = this.intelligenceInFlight;
    if (!work) {
      const sharedContext = { deadlineAt: this.clock() + this.intelligenceDeadlineMs, signal: null };
      work = Promise.resolve()
        .then(() => this._refreshThemeIntelligence(sharedContext))
        .then(payload => {
          if ((payload.meta?.scoringReturnedSymbols || 0) > 0 && payload.status !== 'unavailable' &&
              payload.meta?.observationStale !== true) {
            this.intelligenceCache = { savedAt: this.now(), value: payload };
          }
          return payload;
        })
        .finally(() => {
          if (this.intelligenceInFlight === work) this.intelligenceInFlight = null;
        });
      this.intelligenceInFlight = work;
    }

    let refreshed;
    try {
      refreshed = await this._raceContext(work, callerContext);
    } catch (error) {
      if (error?.code === 'CLIENT_ABORT') throw error;
      const stale = this._intelligenceCacheLookup(this.intelligenceStaleMs);
      if (stale) {
        return selectIntelligencePayload(stale.value, {
          cache: 'stale-fallback',
          stale: true,
          ageMs: stale.ageMs,
          durationMs: this.clock() - startedAt
        });
      }
      throw error;
    }

    if (refreshed.status === 'unavailable' || refreshed.meta?.observationStale === true ||
        (refreshed.meta?.scoringReturnedSymbols || 0) === 0) {
      const stale = this._intelligenceCacheLookup(this.intelligenceStaleMs);
      if (stale) {
        return selectIntelligencePayload(stale.value, {
          cache: 'stale-fallback',
          stale: true,
          ageMs: stale.ageMs,
          durationMs: this.clock() - startedAt
        });
      }
    }
    return selectIntelligencePayload(refreshed, {
      cache: 'refreshed',
      ageMs: 0,
      durationMs: this.clock() - startedAt
    });
  }

  _marketRegimeSpyAdjustedCacheLookup() {
    const entry = this.marketRegimeSpyAdjustedCache;
    if (!entry) return { hit: false, value: null, ageMs: null };
    const ageMs = Math.max(0, this.now() - entry.savedAt);
    if (ageMs > this.marketRegimeSpyAdjustedTtlMs) return { hit: false, value: null, ageMs };
    return { hit: true, value: entry.value, ageMs };
  }

  async _loadMarketRegimeSpyAdjustedHistory(context) {
    const params = new URLSearchParams({
      range: '2y',
      interval: '1d',
      events: 'div,splits',
      includePrePost: 'false',
      includeAdjustedClose: 'true'
    });
    try {
      const payload = await this._requestJson(
        'yahoo-chart-v8-spy',
        `https://query1.finance.yahoo.com/v8/finance/chart/SPY?${params}`,
        { timeoutMs: this.themeTimeoutMs, context }
      );
      const history = parseYahooChartHistory(payload, 'SPY', this.now());
      return history?.priceMode === 'adjusted' && history.points.length >= 21
        ? history
        : null;
    } catch (_) {
      return null;
    }
  }

  async _getMarketRegimeSpyAdjustedHistory(context, options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const priorCached = this._marketRegimeSpyAdjustedCacheLookup();
    const cached = forceRefresh ? { hit: false, value: null } : priorCached;
    if (cached.hit) return cached.value;
    let work = this.marketRegimeSpyAdjustedInFlight;
    if (!work) {
      const sharedContext = { deadlineAt: this.clock() + this.marketRegimeDeadlineMs, signal: null };
      work = Promise.resolve()
        .then(() => this._loadMarketRegimeSpyAdjustedHistory(sharedContext))
        .then(history => {
          if (history || !forceRefresh) {
            this.marketRegimeSpyAdjustedCache = { savedAt: this.now(), value: history || null };
          }
          return history || null;
        })
        .finally(() => {
          if (this.marketRegimeSpyAdjustedInFlight === work) this.marketRegimeSpyAdjustedInFlight = null;
        });
      this.marketRegimeSpyAdjustedInFlight = work;
    }
    const refreshed = await this._raceContext(work, context);
    if (refreshed || !forceRefresh || !priorCached.hit || !priorCached.value) return refreshed;
    const requiredSessionDate = String(options.requiredSessionDate || '');
    const cachedSessionDate = String(priorCached.value?.points?.at(-1)?.sessionDate || '');
    if (!requiredSessionDate || cachedSessionDate !== requiredSessionDate) return null;
    return {
      ...priorCached.value,
      refreshFallback: true,
      refreshFallbackCacheAgeMs: priorCached.ageMs
    };
  }

  async _refreshMarketRegime(context, options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const task = this.yahooQueue.then(async () => {
      const histories = new Map(await this._yahooThemeHistory(
        MARKET_REGIME_SYMBOLS,
        context,
        { bypassCache: forceRefresh }
      ));
      const sparkSpy = histories.get('SPY');
      if (sparkSpy?.priceMode !== 'adjusted') {
        let adjustedSpy = null;
        try {
          adjustedSpy = await this._getMarketRegimeSpyAdjustedHistory(context, {
            forceRefresh,
            requiredSessionDate: sparkSpy?.points?.at(-1)?.sessionDate || null
          });
        } catch (_) {
          adjustedSpy = null;
        }
        if (adjustedSpy) histories.set('SPY', adjustedSpy);
      }
      return histories;
    });
    this.yahooQueue = task.then(() => undefined, () => undefined);
    const histories = await this._raceContext(task, context);
    return buildMarketRegimePayload(histories, new Date(this.now()).toISOString());
  }

  _cacheMarketRegimePayload(payload) {
    const completeObservation = payload.asOf &&
      payload.meta?.observationStale !== true &&
      Number(payload.meta?.returnedSymbols) === MARKET_REGIME_SYMBOLS.length &&
      payload.availability?.history?.complete === true &&
      payload.availability?.synchronizedConfirmedSession?.current === true;
    const currentPartialObservation = payload.asOf && (payload.meta?.returnedSymbols || 0) > 0 &&
      payload.meta?.observationStale !== true;
    if (completeObservation) {
      const adjustedFallbackAgeMs = payload.meta?.source?.adjustedSpyRefreshFallback === true
        ? Number(payload.meta.source.adjustedSpyRefreshFallbackAgeMs)
        : 0;
      this.marketRegimeCache = {
        savedAt: this.now() -
          (Number.isFinite(adjustedFallbackAgeMs) ? Math.max(0, adjustedFallbackAgeMs) : 0),
        value: payload
      };
      this.marketRegimePartialCache = null;
    } else if (currentPartialObservation) {
      this.marketRegimePartialCache = { savedAt: this.now(), value: payload };
    }
    return payload;
  }

  _startMarketRegimeRefresh(forceRefresh) {
    if (this.marketRegimeInFlight) return this.marketRegimeInFlight;
    const sharedContext = { deadlineAt: this.clock() + this.marketRegimeDeadlineMs, signal: null };
    let work;
    work = Promise.resolve()
      .then(() => this._refreshMarketRegime(sharedContext, { forceRefresh: forceRefresh === true }))
      .then(payload => this._cacheMarketRegimePayload(payload))
      .finally(() => {
        if (this.marketRegimeInFlight === work) {
          this.marketRegimeInFlight = null;
          this.marketRegimeInFlightForce = false;
        }
      });
    this.marketRegimeInFlight = work;
    this.marketRegimeInFlightForce = forceRefresh === true;
    return work;
  }

  _startMarketRegimeForceAfterActive() {
    const active = this.marketRegimeInFlight;
    if (!active) return this._startMarketRegimeRefresh(true);
    if (this.marketRegimeInFlightForce) return active;
    return active.catch(() => undefined).then(() => this._startMarketRegimeForceAfterActive());
  }

  _queueMarketRegimeForceRefresh() {
    if (this.marketRegimeForceQueued) return this.marketRegimeForceQueued;
    let queued;
    queued = Promise.resolve()
      .then(() => this._startMarketRegimeForceAfterActive())
      .finally(() => {
        if (this.marketRegimeForceQueued === queued) this.marketRegimeForceQueued = null;
      });
    this.marketRegimeForceQueued = queued;
    return queued;
  }

  async getMarketRegime(options = {}) {
    const startedAt = this.clock();
    const forceRefresh = options.forceRefresh === true;
    const freshComplete = this._marketRegimeCacheLookup(this.marketRegimeTtlMs, 'complete');
    const freshPartial = this._marketRegimeCacheLookup(
      Math.min(this.marketRegimeTtlMs, this.marketRegimePartialTtlMs),
      'partial'
    );
    const fresh = [freshComplete, freshPartial]
      .filter(Boolean)
      .sort((left, right) => right.savedAt - left.savedAt)[0] || null;
    const refreshFloorMs = Math.min(this.marketRegimeTtlMs, this.ttlMs);
    const forcedWorkPending = forceRefresh && Boolean(
      this.marketRegimeForceQueued ||
      (this.marketRegimeInFlight && this.marketRegimeInFlightForce)
    );
    const suppressForcedRefresh = forceRefresh && !forcedWorkPending &&
      fresh && fresh.ageMs <= refreshFloorMs;
    if (fresh && (!forceRefresh || suppressForcedRefresh)) {
      return selectMarketRegimePayload(fresh.value, {
        cache: 'hit',
        cacheTier: fresh.tier,
        ageMs: fresh.ageMs,
        durationMs: this.clock() - startedAt,
        refreshRequested: forceRefresh,
        refreshSuppressed: suppressForcedRefresh
      });
    }

    let queuedBehindNormal = false;
    let work;
    if (forceRefresh) {
      if (this.marketRegimeForceQueued) {
        work = this.marketRegimeForceQueued;
        queuedBehindNormal = true;
      } else if (this.marketRegimeInFlight) {
        if (this.marketRegimeInFlightForce) work = this.marketRegimeInFlight;
        else {
          work = this._queueMarketRegimeForceRefresh();
          queuedBehindNormal = true;
        }
      } else {
        work = this._startMarketRegimeRefresh(true);
      }
    } else {
      work = this.marketRegimeInFlight || this._startMarketRegimeRefresh(false);
    }
    const callerContext = {
      deadlineAt: this.clock() + this.marketRegimeDeadlineMs * (queuedBehindNormal ? 2 : 1),
      signal: options.signal || null
    };

    let refreshed;
    try {
      refreshed = await this._raceContext(work, callerContext);
    } catch (error) {
      if (error?.code === 'CLIENT_ABORT') throw error;
      const stale = [
        this._marketRegimeCacheLookup(this.marketRegimeStaleMs, 'complete'),
        this._marketRegimeCacheLookup(this.marketRegimeStaleMs, 'partial')
      ].filter(Boolean).sort((left, right) => right.savedAt - left.savedAt)[0] || null;
      if (stale) {
        return selectMarketRegimePayload(stale.value, {
          cache: 'stale-fallback',
          cacheTier: stale.tier,
          stale: true,
          ageMs: stale.ageMs,
          durationMs: this.clock() - startedAt,
          refreshRequested: forceRefresh
        });
      }
      throw error;
    }

    const hasCurrentObservation = refreshed.asOf &&
      (refreshed.meta?.returnedSymbols || 0) > 0 &&
      refreshed.meta?.observationStale !== true;
    if (!hasCurrentObservation) {
      const stale = [
        this._marketRegimeCacheLookup(this.marketRegimeStaleMs, 'complete'),
        this._marketRegimeCacheLookup(this.marketRegimeStaleMs, 'partial')
      ].filter(Boolean).sort((left, right) => right.savedAt - left.savedAt)[0] || null;
      if (stale) {
        return selectMarketRegimePayload(stale.value, {
          cache: 'stale-fallback',
          cacheTier: stale.tier,
          stale: true,
          ageMs: stale.ageMs,
          durationMs: this.clock() - startedAt,
          refreshRequested: forceRefresh
        });
      }
    }
    return selectMarketRegimePayload(refreshed, {
      cache: 'refreshed',
      cacheTier: refreshed.availability?.history?.complete === true &&
        refreshed.availability?.synchronizedConfirmedSession?.current === true
        ? 'complete'
        : 'partial',
      ageMs: 0,
      durationMs: this.clock() - startedAt,
      refreshRequested: forceRefresh
    });
  }

  _technicalFinnhubCacheLookup(symbol) {
    const entry = this.technicalFinnhubCache.get(symbol);
    if (!entry) return null;
    const ageMs = Math.max(0, this.now() - entry.savedAt);
    if (ageMs > this.technicalFinnhubCacheTtlMs) return null;
    this.technicalFinnhubCache.delete(symbol);
    this.technicalFinnhubCache.set(symbol, entry);
    return { ageMs, value: cloneJson(entry.value) };
  }

  _setTechnicalFinnhubCache(symbol, value) {
    this.technicalFinnhubCache.delete(symbol);
    this.technicalFinnhubCache.set(symbol, {
      savedAt: this.now(),
      value: cloneJson(value)
    });
    while (this.technicalFinnhubCache.size > this.technicalCacheMaxEntries) {
      this.technicalFinnhubCache.delete(this.technicalFinnhubCache.keys().next().value);
    }
  }

  async _finnhubTechnicalRequest(provider, path, params, context) {
    if (!this.finnhubKey || !this._contextActive(context) ||
        this._circuitUntil(provider) || !this._takeFinnhubBudget()) return null;
    try {
      return await this._requestJson(
        provider,
        `https://finnhub.io/api/v1/${path}?${new URLSearchParams(params)}`,
        {
          timeoutMs: this.finnhubTimeoutMs,
          context,
          headers: { 'X-Finnhub-Token': this.finnhubKey }
        }
      );
    } catch (error) {
      if (error?.code === 'CLIENT_ABORT' || error?.code === 'DEADLINE') throw error;
      return null;
    }
  }

  async _loadFinnhubTechnicalEvidence(symbol, context) {
    if (!this.finnhubKey) {
      return {
        status: 'unavailable',
        metrics: null,
        earnings: [],
        earningsCalendar: [],
        news: [],
        earningsDays: null,
        flags: {
          goodEarnings: null,
          guidanceUp: null,
          revenueGrowth: null,
          positiveCatalyst: null,
          negativeMaterial: null
        },
        reason: 'FINNHUB_API_KEY is not configured.',
        provenance: { source: null, pointInTimeHistory: false }
      };
    }
    const now = new Date(this.now());
    const to = now.toISOString().slice(0, 10);
    const fromDate = new Date(now);
    fromDate.setUTCDate(fromDate.getUTCDate() - 30);
    const calendarToDate = new Date(now);
    calendarToDate.setUTCDate(calendarToDate.getUTCDate() + 90);
    const from = fromDate.toISOString().slice(0, 10);
    const calendarTo = calendarToDate.toISOString().slice(0, 10);
    const [newsPayload, earningsPayload, calendarPayload, metricsPayload] = await Promise.all([
      this._finnhubTechnicalRequest(
        'finnhub-company-news',
        'company-news',
        { symbol, from, to },
        context
      ),
      this._finnhubTechnicalRequest(
        'finnhub-company-earnings',
        'stock/earnings',
        { symbol, limit: '4' },
        context
      ),
      this._finnhubTechnicalRequest(
        'finnhub-earnings-calendar',
        'calendar/earnings',
        { symbol, from: to, to: calendarTo },
        context
      ),
      this._finnhubTechnicalRequest(
        'finnhub-basic-metrics',
        'stock/metric',
        { symbol, metric: 'all' },
        context
      )
    ]);
    const news = (Array.isArray(newsPayload) ? newsPayload : [])
      .slice(0, 20)
      .flatMap(item => {
        const headline = String(item?.headline || '').trim().slice(0, 500);
        if (!headline) return [];
        const datetime = Number(item?.datetime);
        return [{
          headline,
          summary: String(item?.summary || '').trim().slice(0, 1_000),
          source: String(item?.source || '').slice(0, 120),
          url: /^https?:\/\//i.test(String(item?.url || '')) ? String(item.url).slice(0, 1_000) : null,
          at: Number.isFinite(datetime) && datetime > 0
            ? new Date(datetime * 1000).toISOString()
            : null,
          category: String(item?.category || '').slice(0, 80)
        }];
      });
    const earnings = (Array.isArray(earningsPayload) ? earningsPayload : [])
      .slice(0, 8)
      .map(item => ({
        period: String(item?.period || '').slice(0, 10),
        actual: parseNumber(item?.actual),
        estimate: parseNumber(item?.estimate),
        surprise: parseNumber(item?.surprise),
        surprisePercent: parseNumber(item?.surprisePercent),
        quarter: parseNumber(item?.quarter),
        year: parseNumber(item?.year)
      }));
    const calendar = (Array.isArray(calendarPayload?.earningsCalendar)
      ? calendarPayload.earningsCalendar
      : [])
      .filter(item => !item?.symbol || normalizeSymbol(item.symbol) === symbol)
      .slice(0, 10)
      .map(item => ({
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(item?.date || '')) ? item.date : null,
        hour: String(item?.hour || '').slice(0, 20),
        epsActual: parseNumber(item?.epsActual),
        epsEstimate: parseNumber(item?.epsEstimate),
        revenueActual: parseNumber(item?.revenueActual),
        revenueEstimate: parseNumber(item?.revenueEstimate),
        quarter: parseNumber(item?.quarter),
        year: parseNumber(item?.year)
      }))
      .filter(item => item.date);
    const rawMetrics = metricsPayload?.metric && typeof metricsPayload.metric === 'object'
      ? metricsPayload.metric
      : null;
    const pickMetric = (...keys) => {
      for (const key of keys) {
        const value = parseNumber(rawMetrics?.[key]);
        if (value != null) return value;
      }
      return null;
    };
    const metrics = rawMetrics
      ? {
          marketCapitalization: pickMetric('marketCapitalization'),
          peTtm: pickMetric('peTTM'),
          psTtm: pickMetric('psTTM'),
          revenueGrowthTtmYoy: pickMetric('revenueGrowthTTMYoy', 'revenueGrowthQuarterlyYoy'),
          grossMarginTtm: pickMetric('grossMarginTTM'),
          netProfitMarginTtm: pickMetric('netProfitMarginTTM'),
          high52Week: pickMetric('52WeekHigh'),
          low52Week: pickMetric('52WeekLow')
        }
      : null;
    const latestEarnings = earnings
      .filter(item => item.period)
      .sort((left, right) => right.period.localeCompare(left.period))[0] || null;
    const headlineText = news.map(item => `${item.headline} ${item.summary}`).join(' ').toLowerCase();
    const guidanceUp = /\b(raise[ds]?|raising|increas(?:e|es|ed|ing))\b.{0,40}\b(guidance|outlook|forecast)\b|\b(guidance|outlook|forecast)\b.{0,40}\b(raise[ds]?|higher|above)\b/i
      .test(headlineText);
    const positiveCatalyst = /\b(beat|beats|record|approval|approved|contract win|upgrade|breakthrough|partnership|surge)\b/i
      .test(headlineText);
    const negativeMaterial = /\b(miss|misses|cut guidance|lower(?:s|ed)? outlook|downgrade|investigation|lawsuit|recall|default|bankrupt|offering|dilution)\b/i
      .test(headlineText) ||
      (latestEarnings?.surprise != null && latestEarnings.surprise < 0);
    const goodEarnings = latestEarnings
      ? (
          latestEarnings.surprise != null
            ? latestEarnings.surprise > 0
            : (
                latestEarnings.actual != null && latestEarnings.estimate != null
                  ? latestEarnings.actual > latestEarnings.estimate
                  : null
              )
        )
      : null;
    const revenueGrowth = metrics?.revenueGrowthTtmYoy == null
      ? null
      : metrics.revenueGrowthTtmYoy > 0;
    const businessDaysUntil = dateValue => {
      const target = new Date(`${dateValue}T00:00:00Z`);
      const start = new Date(`${to}T00:00:00Z`);
      if (!Number.isFinite(target.getTime())) return null;
      if (target < start) return -1;
      let days = 0;
      const cursor = new Date(start);
      while (cursor < target) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        if (![0, 6].includes(cursor.getUTCDay())) days += 1;
      }
      return days;
    };
    const earningsDays = calendar
      .map(item => businessDaysUntil(item.date))
      .filter(value => value != null && value >= 0)
      .sort((left, right) => left - right)[0] ?? null;
    const availableParts = [newsPayload, earningsPayload, calendarPayload, metricsPayload]
      .filter(value => value != null).length;
    const value = {
      status: availableParts === 4 ? 'ok' : (availableParts ? 'partial' : 'unavailable'),
      metrics,
      earnings,
      earningsCalendar: calendar,
      news,
      earningsDays,
      flags: {
        goodEarnings,
        guidanceUp: newsPayload == null ? null : guidanceUp,
        revenueGrowth,
        positiveCatalyst: newsPayload == null ? null : positiveCatalyst,
        negativeMaterial: newsPayload == null && latestEarnings == null ? null : negativeMaterial
      },
      reason: availableParts
        ? 'Current Finnhub evidence; not historical point-in-time evidence.'
        : 'Finnhub auxiliary endpoints were unavailable.',
      provenance: {
        source: 'finnhub',
        retrievedAt: new Date(this.now()).toISOString(),
        currentOnly: true,
        pointInTimeHistory: false,
        endpoints: {
          companyNews: newsPayload != null,
          companyEarnings: earningsPayload != null,
          earningsCalendar: calendarPayload != null,
          basicMetrics: metricsPayload != null
        }
      }
    };
    this._setTechnicalFinnhubCache(symbol, value);
    return value;
  }

  async _getFinnhubTechnicalEvidence(symbol, context) {
    const cached = this._technicalFinnhubCacheLookup(symbol);
    if (cached) return { ...cached.value, cacheState: 'hit', cacheAgeMs: cached.ageMs };
    let work = this.technicalFinnhubInFlight.get(symbol);
    if (!work) {
      const sharedContext = {
        deadlineAt: this.clock() + this.technicalDeadlineMs,
        signal: null
      };
      work = Promise.resolve()
        .then(() => this._loadFinnhubTechnicalEvidence(symbol, sharedContext))
        .finally(() => {
          if (this.technicalFinnhubInFlight.get(symbol) === work) {
            this.technicalFinnhubInFlight.delete(symbol);
          }
        });
      this.technicalFinnhubInFlight.set(symbol, work);
    }
    const value = await this._raceContext(work, context);
    return { ...value, cacheState: 'refreshed', cacheAgeMs: 0 };
  }

  async _getFinnhubTechnicalEvidenceBatch(symbols, context) {
    const unique = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
    const out = new Map();
    if (!this.finnhubKey) {
      unique.forEach(symbol => out.set(symbol, {
        status: 'unavailable',
        metrics: null,
        earnings: [],
        earningsCalendar: [],
        news: [],
        earningsDays: null,
        flags: {
          goodEarnings: null,
          guidanceUp: null,
          revenueGrowth: null,
          positiveCatalyst: null,
          negativeMaterial: null
        },
        reason: 'FINNHUB_API_KEY is not configured.',
        provenance: { source: null, pointInTimeHistory: false }
      }));
      return out;
    }
    const selected = unique.slice(0, this.technicalFinnhubMaxSymbols);
    const rows = await mapLimit(selected, 2, async symbol => {
      try {
        return [symbol, await this._getFinnhubTechnicalEvidence(symbol, context)];
      } catch (error) {
        if (error?.code === 'CLIENT_ABORT') throw error;
        return [symbol, {
          status: 'unavailable',
          metrics: null,
          earnings: [],
          earningsCalendar: [],
          news: [],
          earningsDays: null,
          flags: {
            goodEarnings: null,
            guidanceUp: null,
            revenueGrowth: null,
            positiveCatalyst: null,
            negativeMaterial: null
          },
          reason: 'Finnhub auxiliary request failed.',
          provenance: { source: 'finnhub', pointInTimeHistory: false }
        }];
      }
    });
    rows.forEach(([symbol, value]) => out.set(symbol, value));
    unique.slice(this.technicalFinnhubMaxSymbols).forEach(symbol => out.set(symbol, {
      status: 'unavailable',
      metrics: null,
      earnings: [],
      earningsCalendar: [],
      news: [],
      earningsDays: null,
      flags: {
        goodEarnings: null,
        guidanceUp: null,
        revenueGrowth: null,
        positiveCatalyst: null,
        negativeMaterial: null
      },
      reason: 'Deferred by the low-load Finnhub per-request symbol cap.',
      provenance: { source: 'finnhub', deferred: true, pointInTimeHistory: false }
    }));
    return out;
  }

  async _technicalIntelligencePayload(options = {}) {
    if (options.intelligencePayload?.themes) return options.intelligencePayload;
    const cached = this._intelligenceCacheLookup(this.intelligenceTtlMs);
    if (cached) {
      return selectIntelligencePayload(cached.value, {
        cache: 'hit',
        ageMs: cached.ageMs,
        durationMs: 0
      });
    }
    try {
      return await this.getThemeIntelligence({ signal: options.signal });
    } catch (_) {
      return null;
    }
  }

  async getBuySignals(options = {}) {
    const startedAt = this.clock();
    const symbols = [...new Set((options.symbols || [])
      .map(normalizeSymbol)
      .filter(Boolean))]
      .slice(0, 20);
    if (!symbols.length) {
      return {
        status: 'unavailable',
        asOf: null,
        updatedAt: new Date(this.now()).toISOString(),
        methodology: TECHNICAL_METHOD_VERSION,
        results: [],
        execution: { ...SIMULATION_EXECUTION },
        tradeEligible: false,
        meta: {
          status: 'error',
          durationMs: this.clock() - startedAt,
          quality: { requested: 0, returned: 0, failed: 0 }
        }
      };
    }
    const context = {
      deadlineAt: this.clock() + this.technicalDeadlineMs,
      signal: options.signal || null
    };
    const historiesPromise = this._getTechnicalHistories(symbols, context, {
      forceRefresh: options.forceRefresh === true
    });
    const intelligencePromise = this._technicalIntelligencePayload({
      signal: options.signal,
      intelligencePayload: options.intelligencePayload
    });
    const evidencePromise = this._getFinnhubTechnicalEvidenceBatch(symbols, context);
    const [historiesResult, intelligenceResult, evidenceResult] = await Promise.allSettled([
      historiesPromise,
      intelligencePromise,
      evidencePromise
    ]);
    if (options.signal?.aborted) throw this._abortError('technical signal request was cancelled', 'CLIENT_ABORT');
    const histories = historiesResult.status === 'fulfilled' ? historiesResult.value : new Map();
    const intelligence = intelligenceResult.status === 'fulfilled' ? intelligenceResult.value : null;
    const evidence = evidenceResult.status === 'fulfilled' ? evidenceResult.value : new Map();
    const leveragedCatalog = new Set(INTELLIGENCE_THEME_CATALOG.flatMap(entry =>
      (entry.relatedInstruments || [])
        .filter(instrument => instrument?.leveraged === true)
        .map(instrument => normalizeSymbol(instrument.symbol))
    ));
    const results = symbols.map(symbol => {
      const history = histories.get(symbol);
      if (!history) {
        return technicalUnavailableResult(
          symbol,
          '5年日足OHLCVを取得できませんでした。'
        );
      }
      const existingPosition = (Array.isArray(options.positions) ? options.positions : [])
        .find(position => normalizeSymbol(position?.symbol || position?.ticker) === symbol);
      const positionShares = Math.max(0, parseNumber(existingPosition?.shares) ?? 0);
      const positionPrice = parseNumber(existingPosition?.price);
      const usdJpy = parseNumber(options.account?.usdJpy);
      const derivedTickerValueJpy = positionShares > 0 && positionPrice > 0 && usdJpy > 0
        ? positionShares * positionPrice * usdJpy
        : null;
      const account = {
        ...(options.account || {}),
        existingTickerValueJpy: derivedTickerValueJpy ??
          (parseNumber(options.account?.existingTickerValueJpy) ?? 0)
      };
      return buildBuySignalResult({
        symbol,
        history,
        theme: bestIntelligenceThemeForSymbol(intelligence, symbol),
        fundamental: evidence.get(symbol),
        earningsDays: evidence.get(symbol)?.earningsDays,
        account,
        leveragedProduct: leveragedCatalog.has(symbol),
        nowMs: this.now()
      });
    });
    const available = results.filter(result => result.status !== 'unavailable').length;
    const stale = results.filter(result => result.status === 'stale').length;
    const partial = results.filter(result => result.status === 'partial').length;
    const status = !available ? 'unavailable' : (available === results.length && !stale && !partial ? 'ok' : 'partial');
    const asOf = results.map(result => result.asOf).filter(Boolean).sort().at(-1) || null;
    return {
      status,
      asOf,
      updatedAt: new Date(this.now()).toISOString(),
      methodology: TECHNICAL_METHOD_VERSION,
      results,
      execution: { ...SIMULATION_EXECUTION },
      tradeEligible: false,
      meta: {
        status: status === 'unavailable' ? 'error' : status,
        durationMs: this.clock() - startedAt,
        requestedSymbols: symbols.length,
        returnedSymbols: available,
        range: '5y',
        interval: '1d',
        provider: {
          name: 'Yahoo Finance Chart v8 / Spark probe',
          official: false,
          bestEffort: true
        },
        optionalEvidence: {
          finnhubConfigured: Boolean(this.finnhubKey),
          pointInTimeHistory: false
        },
        unverifiedClientContextUsedForScore: false,
        quality: {
          requested: symbols.length,
          returned: available,
          fresh: results.filter(result => result.status === 'ok').length,
          stale,
          failed: results.length - available,
          unverified: partial,
          aged: 0,
          delayed: 0,
          reference: 0,
          consensusWarnings: 0
        }
      }
    };
  }

  async getTechnicalBacktest(options = {}) {
    const startedAt = this.clock();
    const symbols = [...new Set((options.symbols || [])
      .map(normalizeSymbol)
      .filter(Boolean))]
      .slice(0, 20);
    if (!symbols.length) {
      return {
        status: 'unavailable',
        asOf: null,
        updatedAt: new Date(this.now()).toISOString(),
        methodology: BACKTEST_METHOD_VERSION,
        results: [],
        execution: { ...SIMULATION_EXECUTION },
        tradeEligible: false,
        meta: {
          status: 'error',
          durationMs: this.clock() - startedAt,
          quality: { requested: 0, returned: 0, failed: 0 }
        }
      };
    }
    const requested = [...new Set([...symbols, 'SPY'])];
    const context = {
      deadlineAt: this.clock() + this.technicalDeadlineMs,
      signal: options.signal || null
    };
    const histories = await this._getTechnicalHistories(requested, context, {
      forceRefresh: options.forceRefresh === true
    });
    if (options.signal?.aborted) throw this._abortError('technical backtest was cancelled', 'CLIENT_ABORT');
    const benchmark = histories.get('SPY');
    const results = symbols.map(symbol => {
      const history = histories.get(symbol);
      if (!history) {
        return technicalUnavailableResult(
          symbol,
          '5年日足OHLCVを取得できませんでした。',
          'backtest'
        );
      }
      let backtest;
      try {
        backtest = runTechnicalBacktest(history.bars, {
          benchmarkBars: benchmark?.bars || [],
          commissionBps: options.commissionBps,
          slippageBps: options.slippageBps,
          priceMode: history.priceMode,
          signal: options.signal
        });
      } catch (error) {
        if (error?.code === 'CLIENT_ABORT') throw error;
        backtest = {
          status: 'unavailable',
          methodVersion: BACKTEST_METHOD_VERSION,
          reason: String(error?.message || 'Backtest calculation failed.').slice(0, 300),
          strategies: []
        };
      }
      const status = backtest.status === 'unavailable'
        ? 'unavailable'
        : (history.stale || history.priceMode !== 'adjusted' || !benchmark ? 'partial' : 'ok');
      const warnings = [];
      if (!benchmark) warnings.push('SPY欠損のため急落/通常レジームはunknownです。銘柄自身で代用しません。');
      if (history.priceMode !== 'adjusted') warnings.push('未調整価格のバックテストは参考値です。');
      if (history.stale) warnings.push('stale履歴のバックテストです。');
      return {
        symbol,
        ticker: symbol,
        status,
        available: backtest.status !== 'unavailable',
        active: false,
        asOf: history.bars?.at(-1)?.sessionDate || null,
        backtest,
        warnings,
        quality: {
          priceMode: history.priceMode,
          dailyBars: history.bars?.length || 0,
          source: history.source,
          cacheState: history.cacheState,
          cacheAgeMs: history.cacheAgeMs,
          stale: history.stale === true,
          benchmarkAvailable: Boolean(benchmark)
        },
        provenance: {
          source: history.source,
          benchmark: benchmark ? 'SPY' : null,
          range: '5y',
          interval: '1d',
          methodVersion: BACKTEST_METHOD_VERSION,
          pointInTimeMaterial: false
        },
        execution: { ...SIMULATION_EXECUTION },
        tradeEligible: false
      };
    });
    const available = results.filter(result => result.status !== 'unavailable').length;
    const partial = results.filter(result => result.status === 'partial').length;
    const status = !available ? 'unavailable' : (available === results.length && !partial ? 'ok' : 'partial');
    return {
      status,
      asOf: results.map(result => result.asOf).filter(Boolean).sort().at(-1) || null,
      updatedAt: new Date(this.now()).toISOString(),
      methodology: BACKTEST_METHOD_VERSION,
      results,
      execution: { ...SIMULATION_EXECUTION },
      tradeEligible: false,
      meta: {
        status: status === 'unavailable' ? 'error' : status,
        durationMs: this.clock() - startedAt,
        requestedSymbols: symbols.length,
        returnedSymbols: available,
        benchmarkAvailable: Boolean(benchmark),
        quality: {
          requested: symbols.length,
          returned: available,
          fresh: results.filter(result => result.status === 'ok').length,
          stale: results.filter(result => result.quality?.stale).length,
          failed: results.length - available,
          unverified: partial,
          aged: 0,
          delayed: 0,
          reference: 0,
          consensusWarnings: 0
        }
      }
    };
  }

  async finnhubQuote(symbol, context) {
    if (!this.finnhubKey || symbol === 'JPY=X') return null;
    if (!this._contextActive(context) || this._circuitUntil('finnhub') || !this._takeFinnhubBudget()) return null;
    try {
      const params = new URLSearchParams({ symbol });
      const payload = await this._requestJson('finnhub', `https://finnhub.io/api/v1/quote?${params}`, {
        timeoutMs: this.finnhubTimeoutMs,
        context,
        headers: { 'X-Finnhub-Token': this.finnhubKey }
      });
      const price = parseNumber(payload?.c);
      if (!price || price <= 0) return null;
      const previousClose = parseNumber(payload?.pc);
      return {
        price,
        previousClose,
        changePct: previousClose ? +(((price / previousClose) - 1) * 100).toFixed(2) : +(parseNumber(payload?.dp) || 0).toFixed(2),
        at: isoFromUnix(payload?.t, new Date(this.now()).toISOString()),
        retrievedAt: new Date(this.now()).toISOString(),
        closes: [],
        currency: 'USD',
        exchange: null,
        name: null,
        marketState: 'unknown',
        delayed: false,
        src: 'finnhub'
      };
    } catch (_) {
      return null;
    }
  }

  async nasdaqQuote(symbol, context) {
    if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return null;
    for (const assetClass of ['stocks', 'etf']) {
      if (!this._contextActive(context)) return null;
      try {
        const payload = await this._requestJson(
          'nasdaq',
          `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=${assetClass}`,
          { timeoutMs: this.nasdaqTimeoutMs, context }
        );
        const data = payload?.data;
        const primary = data?.primaryData;
        const price = parseNumber(primary?.lastSalePrice);
        if (!data || !price) continue;
        const changePct = parseNumber(primary?.percentageChange) || 0;
        const previousClose = changePct === -100 ? null : price / (1 + changePct / 100);
        const retrievedAt = new Date(this.now()).toISOString();
        const tradeTime = Date.parse(primary?.lastTradeTimestamp || '');
        return {
          price,
          changePct: +changePct.toFixed(2),
          previousClose: previousClose == null ? null : +previousClose.toFixed(4),
          at: Number.isFinite(tradeTime) ? new Date(tradeTime).toISOString() : retrievedAt,
          retrievedAt,
          closes: [],
          currency: 'USD',
          exchange: data.exchange || null,
          name: data.companyName || null,
          marketState: String(data.marketStatus || 'unknown').toLowerCase(),
          delayed: primary.isRealTime === false || String(primary.isRealTime).toLowerCase() === 'false',
          src: 'nasdaq'
        };
      } catch (_) {
        // Some ETFs return no data for the stocks asset class, so try the next class.
      }
    }
    return null;
  }

  async fallbackFx(context) {
    if (!this._contextActive(context)) return null;
    try {
      const payload = await this._requestJson(
        'frankfurter',
        'https://api.frankfurter.dev/v2/rates?base=USD&quotes=JPY&providers=ECB',
        { timeoutMs: Math.min(3_000, this.timeoutMs), context }
      );
      const rate = Array.isArray(payload) ? payload[0] : null;
      const price = parseNumber(rate?.rate);
      if (price) {
        const retrievedAt = new Date(this.now()).toISOString();
        return {
          price,
          changePct: 0,
          previousClose: null,
          at: rate.date ? new Date(`${rate.date}T00:00:00Z`).toISOString() : retrievedAt,
          retrievedAt,
          closes: [],
          currency: 'JPY',
          exchange: 'ECB reference rate',
          name: 'USD/JPY',
          marketState: 'reference',
          delayed: true,
          src: 'frankfurter'
        };
      }
    } catch (_) {
      // Continue to the second independent FX fallback.
    }

    if (!this._contextActive(context)) return null;
    try {
      const payload = await this._requestJson('open-er-api', 'https://open.er-api.com/v6/latest/USD', {
        timeoutMs: Math.min(3_000, this.timeoutMs),
        context
      });
      const price = parseNumber(payload?.rates?.JPY);
      if (!price || payload?.result !== 'success') return null;
      const retrievedAt = new Date(this.now()).toISOString();
      return {
        price,
        changePct: 0,
        previousClose: null,
        at: isoFromUnix(payload.time_last_update_unix, retrievedAt),
        retrievedAt,
        closes: [],
        currency: 'JPY',
        exchange: 'ExchangeRate-API reference rate',
        name: 'USD/JPY',
        marketState: 'reference',
        delayed: true,
        src: 'open-er-api'
      };
    } catch (_) {
      return null;
    }
  }

  async _loadMissing(symbols, context) {
    // A configured official provider is always preferred. Each symbol has one
    // provider flight, even when callers requested different overlapping sets.
    if (this.finnhubKey && this._contextActive(context)) {
      const stockSymbols = symbols.filter(symbol => symbol !== 'JPY=X');
      await mapLimit(stockSymbols, 3, symbol => this._sharedQuote(
        'finnhub',
        symbol,
        sharedContext => this.finnhubQuote(symbol, sharedContext),
        context
      ));
    }

    // Yahoo also supplies chart history when Finnhub supplied the live quote.
    // Its short batching window unions overlapping request sets, while the
    // symbol-flight map lets later callers join a batch already in progress.
    const yahooTargets = symbols.filter(symbol => {
      const current = this._cacheValue(symbol, this.ttlMs);
      return !current || (symbol !== 'JPY=X' && (current.closes || []).length < 2);
    });
    if (yahooTargets.length && this._contextActive(context)) {
      try { await this.yahooSpark(yahooTargets, context); }
      catch (error) {
        if (error?.code === 'CLIENT_ABORT' || error?.code === 'DEADLINE') throw error;
      }
    }

    let missing = symbols.filter(symbol => !this._cacheValue(symbol, this.ttlMs));
    const fxMissing = missing.includes('JPY=X');
    missing = missing.filter(symbol => symbol !== 'JPY=X');

    // FX is more important than a slow per-symbol fallback, so rescue it first.
    if (fxMissing && !this._cacheValue('JPY=X', this.ttlMs) && this._contextActive(context)) {
      await this._sharedQuote(
        'fx-fallback',
        'JPY=X',
        sharedContext => this.fallbackFx(sharedContext),
        context
      );
    }

    const nasdaqSymbols = missing.slice(0, this.nasdaqMaxSymbols);
    if (nasdaqSymbols.length && this._contextActive(context)) {
      await mapLimit(nasdaqSymbols, 2, symbol => this._sharedQuote(
        'nasdaq',
        symbol,
        sharedContext => this.nasdaqQuote(symbol, sharedContext),
        context
      ));
    }

    if (this._contextActive(context)) {
      for (const symbol of symbols) {
        if (!this._cacheValue(symbol, this.ttlMs)) this._setNegativeCache(symbol);
      }
    }
  }

  async getSnapshot(symbols, options = {}) {
    const deadlineStarted = this.clock();
    const context = {
      deadlineAt: deadlineStarted + this.deadlineMs,
      signal: options.signal || null
    };
    const unique = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
    const initialFresh = new Set(unique.filter(symbol => this._cacheLookup(symbol, this.ttlMs)));
    const negativeHits = new Set(unique.filter(symbol => !initialFresh.has(symbol) && this._isNegativeCached(symbol)));
    const missing = unique.filter(symbol => !initialFresh.has(symbol) && !negativeHits.has(symbol));
    const coalescingStarted = { ...this.coalescing };
    let deadlineExceeded = false;
    let cancelled = false;
    if (missing.length && this._contextActive(context)) {
      try {
        await this._loadMissing(missing, context);
      } catch (error) {
        deadlineExceeded = error?.code === 'DEADLINE' || this.clock() >= context.deadlineAt;
        cancelled = error?.code === 'CLIENT_ABORT' || Boolean(context.signal?.aborted);
      }
    } else if (context.signal?.aborted) {
      cancelled = true;
    }
    if (!deadlineExceeded && this.clock() >= context.deadlineAt) {
      deadlineExceeded = missing.some(symbol => !this._cacheValue(symbol, this.ttlMs));
    }

    const quotes = {};
    const errors = [];
    const stale = [];
    const symbolDiagnostics = {};
    let cached = 0;
    let fx = null;
    let refreshed = 0;
    let staleFallbacks = 0;
    let fresh = 0;
    let live = 0;
    let closeValid = 0;
    let aged = 0;
    let reference = 0;
    let unverified = 0;
    let consensusWarnings = 0;

    for (const symbol of unique) {
      let lookup = this._cacheLookup(symbol, this.ttlMs);
      let quote = lookup?.value || null;
      let cacheState = initialFresh.has(symbol) ? 'hit' : 'refreshed';
      if (quote) {
        if (initialFresh.has(symbol)) cached += 1;
        else refreshed += 1;
      } else {
        lookup = this._cacheLookup(symbol, this.staleMs);
        quote = lookup?.value || null;
        if (quote) {
          quote.stale = true;
          cacheState = 'stale-fallback';
          staleFallbacks += 1;
          stale.push(symbol);
        }
      }

      if (!quote) {
        errors.push(symbol);
        symbolDiagnostics[symbol] = {
          status: 'unavailable',
          source: null,
          cacheState: negativeHits.has(symbol) ? 'negative-cache' : 'miss',
          cacheAgeMs: null,
          quoteAgeMs: null,
          retrievalAgeMs: null,
          transportAgeMs: null,
          transportFresh: false,
          marketRecency: 'unknown',
          marketState: 'unknown',
          delayed: false,
          providerConsensus: 'not-checked'
        };
        continue;
      }

      const freshness = quoteFreshness(quote, cacheState, lookup?.ageMs ?? null, this.now(), this.ttlMs);
      if (['live', 'previous-close-valid'].includes(freshness.status)) fresh += 1;
      if (freshness.status === 'live') live += 1;
      if (freshness.status === 'previous-close-valid') closeValid += 1;
      if (freshness.status === 'stale' && cacheState !== 'stale-fallback') aged += 1;
      if (freshness.status === 'reference') reference += 1;
      if (freshness.status === 'unverified') unverified += 1;
      if (quote.providerComparison?.status === 'divergent') consensusWarnings += 1;
      quote = {
        ...quote,
        closes: normalizeCloses(quote.closes),
        freshness: freshness.status,
        ageMs: freshness.quoteAgeMs,
        cacheState
      };
      symbolDiagnostics[symbol] = {
        status: freshness.status,
        source: quote.src || null,
        cacheState,
        cacheAgeMs: freshness.cacheAgeMs,
        quoteAgeMs: freshness.quoteAgeMs,
        retrievalAgeMs: freshness.retrievalAgeMs,
        transportAgeMs: freshness.transportAgeMs,
        transportFresh: freshness.transportFresh,
        marketRecency: freshness.marketRecency,
        marketState: freshness.marketState,
        delayed: Boolean(quote.delayed),
        providerConsensus: quote.providerComparison?.status || 'not-checked'
      };

      if (symbol === 'JPY=X') {
        fx = {
          usdJpy: Math.round(quote.price * 100) / 100,
          price: quote.price,
          changePct: quote.changePct,
          at: quote.at,
          retrievedAt: quote.retrievedAt,
          delayed: quote.delayed,
          stale: Boolean(quote.stale),
          src: quote.src,
          closes: [...quote.closes],
          currency: quote.currency || 'JPY',
          exchange: quote.exchange || null,
          name: quote.name || 'USD/JPY',
          marketState: quote.marketState || 'unknown',
          freshness: freshness.status,
          ageMs: freshness.quoteAgeMs,
          transportFresh: freshness.transportFresh,
          cacheState
        };
      } else {
        quotes[symbol] = quote;
      }
    }

    const providerSources = [...new Set([
      ...Object.values(quotes).map(quote => quote.src),
      fx?.src
    ].filter(Boolean))];

    const returned = Object.keys(quotes).length + (fx ? 1 : 0);
    const baseStatus = errors.length
      ? (returned ? 'partial' : 'error')
      : (stale.length ? 'partial' : 'ok');
    const delayed = Object.values(quotes).filter(quote => quote.delayed).length + (fx?.delayed ? 1 : 0);
    const coveragePct = unique.length ? Math.round((returned / unique.length) * 100) : 100;
    const status = baseStatus === 'error'
      ? 'error'
      : (baseStatus === 'partial' || aged || delayed || consensusWarnings || unverified || reference ? 'partial' : 'ok');
    const grade = status === 'error'
      ? 'unavailable'
      : (stale.length
          ? 'stale'
          : (errors.length
              ? 'partial'
              : (consensusWarnings
                  ? 'divergent'
                  : (aged
                      ? 'aged'
                      : (delayed ? 'delayed' : (unverified ? 'unverified' : (reference ? 'reference' : (live === returned ? 'live' : (closeValid === returned ? 'close-valid' : 'mixed-valid')))))))));
    const coalescingDelta = {};
    for (const key of Object.keys(this.coalescing)) {
      coalescingDelta[key] = Math.max(0, this.coalescing[key] - (coalescingStarted[key] || 0));
    }
    const activeCircuits = [...this.circuits.entries()]
      .filter(([, until]) => this.clock() < until)
      .map(([provider]) => provider)
      .sort();

    return {
      quotes,
      fx,
      errors,
      stale,
      meta: {
        status,
        requested: unique.length,
        returned,
        cached,
        sources: providerSources,
        durationMs: this.clock() - deadlineStarted,
        deadlineMs: this.deadlineMs,
        deadlineExceeded,
        cancelled,
        quality: {
          coveragePct,
          fresh,
          live,
          closeValid,
          stale: stale.length,
          failed: errors.length,
          delayed,
          aged,
          reference,
          unverified,
          consensusWarnings,
          grade
        },
        symbols: symbolDiagnostics,
        delivery: {
          cache: {
            hits: cached,
            refreshed,
            staleFallbacks,
            negativeHits: negativeHits.size
          },
          upstream: coalescingDelta,
          activeCircuits
        }
      },
      at: new Date(this.now()).toISOString()
    };
  }

  status() {
    const providers = {};
    for (const [name, value] of this.stats) {
      const openUntil = this._circuitUntil(name);
      providers[name] = {
        ...value,
        successRatePct: value.requests ? Math.round((value.successes / value.requests) * 100) : 100,
        health: openUntil ? 'circuit-open' : (value.lastError ? 'degraded' : 'healthy')
      };
    }
    const circuits = {};
    for (const [name, until] of this.circuits) {
      if (this.clock() < until) circuits[name] = new Date(until).toISOString();
    }
    const cacheAges = [...this.cache.values()].map(entry => Math.max(0, this.now() - entry.savedAt));
    const freshCacheEntries = cacheAges.filter(age => age <= this.ttlMs).length;
    const staleCacheEntries = cacheAges.filter(age => age > this.ttlMs && age <= this.staleMs).length;
    const expiredCacheEntries = cacheAges.filter(age => age > this.staleMs).length;
    const themeCacheAgeMs = this.themeCache ? Math.max(0, this.now() - this.themeCache.savedAt) : null;
    const themeFreshTtlMs = this.themeCache?.value?.status === 'ok'
      ? this.themeTtlMs
      : Math.min(this.themeTtlMs, this.themePartialTtlMs);
    const intelligenceCacheAgeMs = this.intelligenceCache
      ? Math.max(0, this.now() - this.intelligenceCache.savedAt)
      : null;
    const intelligenceFreshTtlMs = this.intelligenceCache?.value?.status === 'ok' && this.intelligenceCache?.value?.rrg?.status !== 'unavailable'
      ? this.intelligenceTtlMs
      : Math.min(this.intelligenceTtlMs, this.intelligencePartialTtlMs);
    const marketRegimeCacheAgeMs = this.marketRegimeCache
      ? Math.max(0, this.now() - this.marketRegimeCache.savedAt)
      : null;
    const marketRegimePartialCacheAgeMs = this.marketRegimePartialCache
      ? Math.max(0, this.now() - this.marketRegimePartialCache.savedAt)
      : null;
    const completeRegimeCacheState = this.marketRegimeCache
      ? (marketRegimeCacheAgeMs <= this.marketRegimeTtlMs ? 'fresh' : 'stale-available')
      : 'empty';
    const partialRegimeCacheState = this.marketRegimePartialCache
      ? (marketRegimePartialCacheAgeMs <= Math.min(this.marketRegimeTtlMs, this.marketRegimePartialTtlMs)
          ? 'fresh'
          : 'stale-available')
      : 'empty';
    const spyAdjustedCacheAgeMs = this.marketRegimeSpyAdjustedCache
      ? Math.max(0, this.now() - this.marketRegimeSpyAdjustedCache.savedAt)
      : null;
    return {
      cacheEntries: this.cache.size,
      cache: {
        freshEntries: freshCacheEntries,
        staleAvailableEntries: staleCacheEntries,
        expiredEntries: expiredCacheEntries,
        oldestAgeMs: cacheAges.length ? Math.max(...cacheAges) : null
      },
      negativeCacheEntries: this.negativeCache.size,
      inFlight: this.inFlight.size + this.yahooFlights.size,
      ttlMs: this.ttlMs,
      staleTtlMs: this.staleMs,
      negativeTtlMs: this.negativeTtlMs,
      deadlineMs: this.deadlineMs,
      yahooBatchWindowMs: this.yahooBatchWindowMs,
      maxInFlightEntries: this.maxInFlightEntries,
      nasdaqMaxSymbols: this.nasdaqMaxSymbols,
      providerDivergencePct: this.providerDivergencePct,
      themes: {
        catalogSize: THEME_CATALOG.length,
        symbols: new Set(THEME_CATALOG.flatMap(entry => entry.members.map(member => member.symbol))).size,
        cacheState: this.themeCache
          ? (themeCacheAgeMs <= themeFreshTtlMs ? 'fresh' : 'stale-available')
          : 'empty',
        cacheAgeMs: themeCacheAgeMs,
        inFlight: Boolean(this.themeInFlight),
        ttlMs: this.themeTtlMs,
        partialTtlMs: this.themePartialTtlMs,
        staleTtlMs: this.themeStaleMs,
        deadlineMs: this.themeDeadlineMs,
        batchSize: this.themeBatchSize
      },
      themeIntelligence: {
        catalogSize: INTELLIGENCE_THEME_CATALOG.length,
        categoryCount: INTELLIGENCE_CATEGORIES.length,
        scoringSymbols: new Set(INTELLIGENCE_THEME_CATALOG.flatMap(entry => entry.relatedTickers)).size,
        cacheState: this.intelligenceCache
          ? (intelligenceCacheAgeMs <= intelligenceFreshTtlMs ? 'fresh' : 'stale-available')
          : 'empty',
        cacheAgeMs: intelligenceCacheAgeMs,
        inFlight: Boolean(this.intelligenceInFlight),
        ttlMs: this.intelligenceTtlMs,
        partialTtlMs: this.intelligencePartialTtlMs,
        staleTtlMs: this.intelligenceStaleMs,
        deadlineMs: this.intelligenceDeadlineMs,
        batchSize: this.themeBatchSize,
        actualFundFlow: false,
        volumeUsed: false
      },
      marketRegime: {
        symbols: [...MARKET_REGIME_SYMBOLS],
        methodVersion: MARKET_REGIME_METHOD_VERSION,
        cacheState: partialRegimeCacheState === 'fresh'
          ? 'partial-fresh'
          : (completeRegimeCacheState === 'fresh'
              ? 'complete-fresh'
              : (completeRegimeCacheState === 'stale-available' || partialRegimeCacheState === 'stale-available'
                  ? 'stale-available'
                  : 'empty')),
        cacheAgeMs: [marketRegimeCacheAgeMs, marketRegimePartialCacheAgeMs]
          .filter(Number.isFinite)
          .sort((left, right) => left - right)[0] ?? null,
        completeCache: {
          state: completeRegimeCacheState,
          ageMs: marketRegimeCacheAgeMs
        },
        partialCache: {
          state: partialRegimeCacheState,
          ageMs: marketRegimePartialCacheAgeMs
        },
        spyAdjustedHistory: {
          cacheState: this.marketRegimeSpyAdjustedCache
            ? (spyAdjustedCacheAgeMs <= this.marketRegimeSpyAdjustedTtlMs ? 'fresh' : 'expired')
            : 'empty',
          cacheAgeMs: spyAdjustedCacheAgeMs,
          available: Boolean(this.marketRegimeSpyAdjustedCache?.value),
          inFlight: Boolean(this.marketRegimeSpyAdjustedInFlight),
          ttlMs: this.marketRegimeSpyAdjustedTtlMs,
          source: 'yahoo-chart-v8-adjusted'
        },
        inFlight: Boolean(this.marketRegimeInFlight),
        ttlMs: this.marketRegimeTtlMs,
        partialTtlMs: this.marketRegimePartialTtlMs,
        staleTtlMs: this.marketRegimeStaleMs,
        deadlineMs: this.marketRegimeDeadlineMs,
        actualFundFlow: false,
        tradingSignal: false
      },
      finnhubBudget: {
        used: this.finnhubBudget.count,
        limit: this.finnhubCallsPerMinute,
        resetAt: new Date(this.finnhubBudget.startedAt + 60_000).toISOString()
      },
      coalescing: {
        ...this.coalescing,
        providerInFlight: this.inFlight.size,
        yahooInFlight: this.yahooFlights.size,
        yahooPending: this.yahooPending.size
      },
      consensus: { ...this.consensus },
      circuits,
      providers
    };
  }
}

module.exports = {
  MarketDataService,
  INTELLIGENCE_CATEGORIES,
  INTELLIGENCE_CATALOG_VERSION,
  INTELLIGENCE_STRUCTURAL_EDGES,
  INTELLIGENCE_THEME_CATALOG,
  MARKET_REGIME_HORIZONS,
  MARKET_REGIME_MAX_OBSERVATION_AGE_MS,
  MARKET_REGIME_METHOD_VERSION,
  MARKET_REGIME_SYMBOLS,
  RRG_LONG_SESSIONS,
  RRG_METHOD_VERSION,
  RRG_SHORT_SESSIONS,
  RRG_TRAIL_SESSIONS,
  RRG_TRAIL_POINTS,
  THEME_CATALOG,
  THEME_CATALOG_VERSION,
  THEME_PERIODS,
  applyValidatedEdgeAssociations,
  buildIntelligencePayload,
  buildMarketRegimePayload,
  buildRrgData,
  buildThemeRrg,
  buildThemePayload,
  calculatePeriodPerformance,
  chronologicalAssociationWindows,
  compareProviders,
  inferMarketState,
  mapLimit,
  marketRegimeClassification,
  normalizeCloses,
  normalizeHistoryPoints,
  normalizeTechnicalBars,
  normalizeSymbol,
  parseNumber,
  parseYahooChartHistory,
  parseYahooSpark,
  parseYahooTechnicalChartHistory,
  parseYahooTechnicalHistory,
  parseYahooThemeHistory,
  previousCloseFromSeries,
  quoteFromChart,
  quoteFreshness,
  rrgQuadrant,
  scoreMarketRegime,
  selectMarketRegimePayload,
  selectIntelligencePayload,
  timestampAgeMs
};
