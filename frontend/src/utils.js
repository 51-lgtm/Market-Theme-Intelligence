export const array = (value) => (Array.isArray(value) ? value : []);
export const number = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
export const fmt = (value, digits = 2) =>
  number(value) === null
    ? "—"
    : value.toLocaleString("ja-JP", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });
export const usd = (value) => (number(value) === null ? "—" : `$${fmt(value)}`);
export const pct = (value) =>
  number(value) === null ? "—" : `${value > 0 ? "+" : ""}${fmt(value)}%`;
export const date = (value) => {
  if (!value) return "未取得";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "未取得"
    : d.toLocaleString("ja-JP", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
};
export const sign = (value) =>
  number(value) === null
    ? ""
    : value > 0
      ? "positive"
      : value < 0
        ? "negative"
        : "";
export const scoreTone = (value) =>
  number(value) === null
    ? "muted"
    : value >= 80
      ? "green"
      : value >= 70
        ? "amber"
        : value >= 60
          ? "muted"
          : "red";
export const actionLabels = {
  BUY: "買い候補",
  BUY_MORE: "買い増し候補",
  HOLD: "保有継続",
  TRIM: "一部縮小",
  SELL: "売却検討",
  STOP: "停止",
  AVOID: "回避",
  WATCH: "監視",
  WAIT: "待機",
  buy_watch: "買い候補",
  strong_buy_watch: "強い買い監視",
  check: "監視",
  wait: "待機",
  avoid: "回避",
  unavailable: "判定不能",
};
export const actionLabel = (value) =>
  actionLabels[value] || value || "判定待ち";
export const actionTone = (value) =>
  ["BUY", "BUY_MORE", "buy_watch", "strong_buy_watch"].includes(value)
    ? "green"
    : ["SELL", "STOP", "AVOID", "avoid"].includes(value)
      ? "red"
      : ["TRIM", "WATCH", "check"].includes(value)
        ? "amber"
        : "muted";
export const statusLabel = (value) =>
  ({
    ok: "接続済み",
    partial: "データ一部不足",
    unavailable: "データ未取得",
    stale: "古いデータ",
    queued: "更新待ち",
    running: "更新中",
    error: "接続エラー",
    idle: "待機中",
    healthy: "正常",
    degraded: "一部制限",
  })[value] ||
  value ||
  "未取得";
export function readLegacyPositions(storage) {
  const raw = storage.getItem("uscmd_ultra_v3");
  if (!raw) return [];
  const value = JSON.parse(raw);
  return array(value.positions)
    .filter(
      (p) =>
        typeof p.ticker === "string" &&
        /^[A-Z][A-Z0-9.^=-]{0,14}$/.test(p.ticker) &&
        number(p.shares) !== null &&
        p.shares > 0 &&
        number(p.avgCost) !== null &&
        p.avgCost > 0,
    )
    .map((p) => ({
      ticker: p.ticker,
      shares: p.shares,
      average_cost: p.avgCost,
      ...(number(p.stopPx) !== null && p.stopPx > 0 ? { stop: p.stopPx } : {}),
    }));
}
export function closeSeries(history) {
  return array(history)
    .map((bar) => ({
      date: bar.date || bar.sessionDate || bar.at || bar.timestamp || bar.time,
      close: number(bar.close),
      volume: number(bar.volume),
    }))
    .filter((bar) => bar.close !== null && bar.close > 0);
}
export function safeLink(url) {
  try {
    const link = new URL(url);
    return ["https:", "http:"].includes(link.protocol) ? link.href : null;
  } catch {
    return null;
  }
}
export function errorText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((v) => v.msg || v.message || "入力内容を確認してください")
      .join(" / ");
  return value?.message || value?.reason || "処理を完了できませんでした";
}
export function shadowEligible(decision) {
  return (
    Boolean(decision?.id || decision?.decision_id) &&
    ["BUY", "BUY_MORE", "SELL", "STOP"].includes(decision?.action) &&
    decision?.should_execute === false
  );
}
export const onOff = value => value === true ? "ON" : value === false ? "OFF" : "未取得";
export function orderView(order) {
  const status = typeof order?.status === "string" ? order.status.toUpperCase() : "UNAVAILABLE";
  const reasonValues = [
    ...array(order?.rejection_reasons),
    ...array(order?.risk?.reasons),
    ...array(order?.reasons),
  ].filter(reason => typeof reason === "string" && reason.trim());
  return {
    status,
    label: ({PENDING: "約定待ち", REJECTED: "拒否", FILLED: "仮想約定済み", CANCELLED: "取消済み"})[status] || "状態未取得",
    tone: status === "REJECTED" ? "red" : status === "PENDING" ? "amber" : status === "FILLED" ? "green" : "muted",
    reasons: [...new Set(reasonValues)],
  };
}
