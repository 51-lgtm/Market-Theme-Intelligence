// Display-only consensus. Never used by Commander, risk checks, or execution.
// Keep the inline legacy copy in index.html equivalent (covered by parity tests).
export const TECHNICAL_FRAMES = [
  ["5m", "5分"], ["15m", "15分"], ["30m", "30分"], ["1h", "1時間"],
  ["5h", "5時間足"], ["daily", "日間"], ["weekly", "週単位"], ["monthly", "月単位"],
];
// Accept calendar dates or timezone-qualified ISO timestamps, never permissive
// Date.parse formats or overflow dates (for example February 30).
function technicalTimestamp(value) {
  if (typeof value !== "string") return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return NaN;
  if (hour !== undefined && (+hour > 23 || +minute > 59 || +second > 59)) return NaN;
  if (zone && zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4, 6) > 59)) return NaN;
  return Date.parse(value);
}
export function technicalConsensus(period, frame, context = {}, now = Date.now()) {
  const missing = (reason) => ({ label: "未取得", tone: "unavailable", arrow: "—", reason });
  if (!["daily", "weekly"].includes(frame)) return missing("この時間足のデータは未接続です。日足からの代用はしません。");
  const p = period || {};
  const blocked = ["stale", "error", "unavailable"];
  if (context.stale === true || blocked.includes(context.status) || blocked.includes(context.technicalStatus) || blocked.includes(context.indicatorsStatus) || p.stale === true ||
      p.available === false || !["ok", "ready"].includes(p.status))
    return missing("指標が未取得・不足、または古いため判定できません。");
  const timestamp = technicalTimestamp(p.asOf);
  const age = now - timestamp;
  if (!Number.isFinite(timestamp) || !Number.isFinite(now) || age < -300000 || age > (frame === "daily" ? 4 : 14) * 86400000)
    return missing("更新日時を確認できない、またはデータが古いため判定できません。");
  const values = [p.rsi14, p.macd?.histogram, p.price, p.ema20, p.ema50];
  if (!values.every(v => typeof v === "number" && Number.isFinite(v)) ||
      p.rsi14 < 0 || p.rsi14 > 100 || [p.price, p.ema20, p.ema50].some(v => v <= 0))
    return missing("RSI・MACD・EMAの3系統が揃うまで判定しません。");
  // RSI extremes stay neutral to avoid presenting overbought/oversold as an entry.
  const votes = [
    p.rsi14 >= 55 && p.rsi14 <= 70 ? 1 : p.rsi14 >= 30 && p.rsi14 <= 45 ? -1 : 0,
    Math.sign(p.macd.histogram),
    p.price > p.ema20 && p.ema20 > p.ema50 ? 1 : p.price < p.ema20 && p.ema20 < p.ema50 ? -1 : 0,
  ];
  const score = votes.reduce((a, b) => a + b, 0);
  return { label: score === 3 ? "強い買い" : score >= 2 ? "買い" : score === -3 ? "強い売り" : score <= -2 ? "売り" : "中立",
    tone: score >= 2 ? "buy" : score <= -2 ? "sell" : "neutral",
    arrow: score >= 2 ? "↗" : score <= -2 ? "↘" : "→",
    reason: `指標基準日 ${p.asOf} · RSI / MACD / EMAの方向一致（表示専用）` };
}
export const TECHNICAL_METHOD = "RSIは55〜70を買い方向、30〜45を売り方向、それ以外は中立。MACDはヒストグラムの正負、EMAは価格・20・50の順序で評価します。3系統すべてが必要で、全一致は強い買い／売り、2系統一致かつ反対なしは買い／売り、それ以外は中立です。鮮度の保守的な上限として、日足4暦日・週足14暦日を超えるデータは未取得。表示専用の指標集約で、売買推奨・発注判断ではありません。";
