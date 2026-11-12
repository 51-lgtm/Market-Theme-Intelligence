// Display-only explanation of existing confirmed daily market observations.
// Never infer order flow, calculate a forecast, or feed AI/risk/execution.
// Keep the legacy inline copy identical (checked by the UI tests).
export const MARKET_OBSERVATION_LIMITS = "条件は次の確定データで確認する項目で、勝率・目標株価・売買推奨ではありません。VIXは予想変動率であり、株価方向の予測ではありません。WTIは需給・在庫など複合要因と限月ロールの影響を受け、上昇・下落だけでは判定しません。";
function observationDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null;
}
function observationTime(value, now) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !observationDate(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59 || (match[5] !== "Z" && (+match[5].slice(1, 3) > 23 || +match[5].slice(4, 6) > 59))) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now + 300000 ? time : null;
}
function observationNumber(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}
export function marketObservationView(raw, { now = Date.now(), stale = false, loading = false } = {}) {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const asOf = observationDate(data.asOf);
  const dateMs = asOf ? Date.parse(asOf + "T00:00:00Z") : null;
  const retrievedMs = observationTime(data.updatedAt, now);
  const futureDate = dateMs !== null && dateMs > now;
  const observedMs = observationTime(data.observedAt, now);
  const expired = (observedMs !== null && now - observedMs > 96 * 3600000) || (dateMs !== null && now - dateMs > 5 * 86400000) || (retrievedMs !== null && now - retrievedMs > 86400000);
  const instruments = data.indicators || data.instruments || {};
  const isStale = Object.values(instruments).some(row => row?.stale === true || row?.status === "stale") || stale || data.status === "stale" || data.meta?.stale === true || data.meta?.observationStale === true || data.availability?.stale === true || expired;
  const sync = data.availability?.synchronizedConfirmedSession;
  const missing = [];
  const specs = [["spy", "SPY", "SPY", "adjusted-close", 1, 100000], ["vix", "VIX", "^VIX", "native-index-close", 5, 200], ["wti", "WTI", "CL=F", "native-futures-close", .000001, 500]];
  const observations = specs.map(([key, label, symbol, priceMode, min, max]) => {
    const row = instruments[key] || {}, baseline = row.baselines?.["1d"] || {};
    const date = observationDate(row.asOf), baselineDate = observationDate(baseline.date);
    const value = observationNumber(Object.prototype.hasOwnProperty.call(row, "value") ? row.value : row.level, min, max);
    const baselineValue = observationNumber(baseline.level, min, max);
    const changePct = observationNumber(row.changesPct && Object.prototype.hasOwnProperty.call(row.changesPct, "1d") ? row.changesPct["1d"] : row.changes?.["1d"], -100, 10000);
    const expectedPct = value !== null && baselineValue !== null ? (value / baselineValue - 1) * 100 : null;
    const valid = row.symbol === symbol && ["ok", "partial"].includes(row.status) && row.available === true && row.stale !== true &&
      row.priceMode === priceMode && date !== null && date === asOf && baselineDate !== null && baselineDate < date && baseline.exactSession === true &&
      value !== null && baselineValue !== null && changePct !== null && expectedPct !== null && Math.abs(changePct - expectedPct) <= .0011;
    if (!valid) missing.push(label);
    return { key, label, valid, date, baselineDate, value, baselineValue, changePct, changePoints: valid ? value - baselineValue : null };
  });
  const baselineDate = observations[0].baselineDate;
  const sameBaseline = baselineDate !== null && observations.every(row => row.baselineDate === baselineDate);
  const knownStatus = ["ok", "partial"].includes(data.status);
  const eligible = knownStatus && !isStale && !futureDate && retrievedMs !== null && asOf !== null &&
    sync?.available === true && sync?.current === true && sync?.asOf === asOf &&
    data.referenceOnly !== true && data.regime?.referenceOnly !== true && sameBaseline && missing.length === 0;
  const partial = data.status === "partial" || data.partial === true;
  const notes = [];
  if (!knownStatus && data.status !== "stale") notes.push("取得状態が未確認のため、変化の比較を保留します。");
  if (loading) notes.push("再取得中。表示がある場合は前回取得したデータです。");
  if (isStale) notes.push("STALE：古い取得結果です。下記の確認条件が成立したとは判定しません。");
  if (!asOf || futureDate) notes.push("終値基準日が欠測・不正のため比較できません。");
  if (retrievedMs === null) notes.push("取得時刻が未確認・不正のため比較を保留します。");
  if (missing.length) notes.push(`${missing.join("・")}：同日確定終値、前営業日比、または価格調整情報が欠測・未確認です。補完しません。`);
  if (!sameBaseline || sync?.available !== true || sync?.current !== true || sync?.asOf !== asOf)
    notes.push("同じ確定日・比較日を確認できないため、系列を組み合わせた解釈は保留します。");
  if (data.referenceOnly === true || data.regime?.referenceOnly === true) notes.push("参考系列（未調整・混在を含む）のため、確認済みの変化として扱いません。");
  if (eligible && partial) notes.push("部分取得です。ここでは検証できた1営業日変化のみを表示し、長期の欠測は補いません。");
  notes.push("最新営業日・米国休場カレンダーとの照合は未確認。同じ日付のデータでも、最新値とは限りません。");
  const signed = (value, digits = 2) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
  const [spy, vix] = observations;
  let headline = "確認できた変化はありません。条件の成立判定は保留です。";
  if (eligible) {
    headline = spy.changePct > 0 && vix.changePct < 0 ? "SPY上昇とVIX低下が同じ確定日に観測されています。" :
      spy.changePct < 0 && vix.changePct > 0 ? "SPY下落とVIX上昇が同じ確定日に観測されています。" :
      spy.changePct > 0 ? "SPYは上昇。VIX低下は同時に確認されていません。" :
      "方向は下記のとおりです。上昇継続を断定できる観測ではありません。";
  }
  return {
    eligible, stale: isStale, status: eligible ? (partial ? "partial" : "observed") : isStale ? "stale" : "unavailable",
    statusLabel: eligible ? (partial ? "部分取得 / 1日変化を確認" : "同日確定値 / 1日変化を確認") : isStale ? "STALE / 判定保留" : "欠測・未確認 / 判定保留",
    asOf: asOf && !futureDate ? asOf : null, baselineDate: eligible ? baselineDate : null,
    retrievedText: retrievedMs === null ? "N/A" : new Date(retrievedMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC"),
    headline, notes,
    scope: "価格・変動率の限定モデルで、好悪材料全体の評価ではありません。ニュース・業績は未評価で、既存の危険・楽観スコアへ加点・減点しません。",
    changes: eligible ? observations.map(row => `${row.label} ${signed(row.changePct)}%${row.key === "vix" ? `（${signed(row.changePoints)}pt）` : ""}`) : [],
    continuation: ["次の同日確定終値で、SPYの前営業日比プラスが続くか。", "同時にVIXが低下または横ばいか。単日の一致だけでは持続性を確定しない。"],
    breakdown: ["次の確定終値でSPY下落とVIX上昇が重なるなら、上昇継続の見立てを再確認。", "日付不一致・欠測・STALEになった場合も判定を止める。原油の方向だけでは崩れと扱わない。"],
    unconfirmed: ["ショートカバー・機関投資家の買い・ガンマの影響は未確認。SPY上昇＋VIX低下だけでは証明できない。", "主体別フロー・建玉・オプション保有情報は未取得。企業材料・業績の変化と値動きの因果関係も未確認。"],
  };
}
