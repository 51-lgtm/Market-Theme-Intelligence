// Display-only Treasury observations. Keep the legacy inline copy identical.
// These values never feed risk scores, AI prompts, or execution.
export const TREASURY_SOURCE_URL = "https://home.treasury.gov/treasury-daily-interest-rate-xml-feed";
export const TREASURY_METHOD_NOTE = "米財務省のDaily Treasury Par Yield Curve Rates（10年・日次公表値）。^TNXの市場指標とは別系列で、リアルタイム金利ではありません。1bp = 0.01ポイント。危険スコア・AI・発注には接続しません。";

function treasuryDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}
function treasuryTime(value, now) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(value);
  if (!match || !treasuryDate(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now + 300000 ? value : null;
}
function treasuryNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= -20 && value <= 100 ? value : null;
}
export function treasuryYieldView(raw, { now = Date.now(), requestFailed = false } = {}) {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const recognized = ["fresh", "stale", "unavailable"].includes(data.status);
  const retrievedAt = treasuryTime(data.retrievedAt, now);
  const checkedAt = treasuryTime(data.checkedAt, now);
  const date = treasuryDate(data.latest?.date);
  const asOf = date && date <= new Date(now).toISOString().slice(0, 10) ? date : null;
  const yieldPct = recognized && asOf ? treasuryNumber(data.latest?.yieldPct) : null;
  const priorDate = treasuryDate(data.previous?.date);
  const previousDate = priorDate && asOf && priorDate < asOf ? priorDate : null;
  const previousYieldPct = recognized && previousDate ? treasuryNumber(data.previous?.yieldPct) : null;
  const expectedBps = yieldPct !== null && previousYieldPct !== null ? Math.round((yieldPct - previousYieldPct) * 10000) / 100 : null;
  const changeBps = expectedBps !== null && typeof data.changeBps === "number" && Number.isFinite(data.changeBps) && Math.abs(data.changeBps - expectedBps) < 0.005 ? expectedBps : null;
  const stale = data.stale === true || data.status === "stale" || (retrievedAt !== null && now - Date.parse(retrievedAt) >= 3600000) || (requestFailed && asOf !== null);
  const missing = yieldPct === null;
  const observationAgeDays = asOf ? Math.floor((Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z") - Date.parse(asOf + "T00:00:00Z")) / 86400000) : null;
  const notes = [];
  if (observationAgeDays !== null) notes.push(`観測日から${observationAgeDays}暦日経過（UTC日付基準）。${data.latestSessionVerified === true ? "" : "最新の公表値かは未確認です。"}`);
  if (requestFailed) notes.push("再取得できませんでした。表示が残っている場合は前回の取得結果です。");
  if (missing) notes.push(asOf ? "公表データ日の10年利回りは欠測です。前の日の値では補完しません。" : "公表データを取得できていません。N/Aは0%ではありません。");
  if (stale) notes.push("STALE：古い取得結果です。最新値として扱わないでください。");
  if (!retrievedAt && asOf) notes.push("取得日時を確認できません。");
  if (yieldPct !== null && previousYieldPct === null) notes.push("前回公表値が欠測・未取得のため、前回比はN/Aです。");
  else if (yieldPct !== null && changeBps === null) notes.push("前回比を検証できないため、変化幅はN/Aです。");
  notes.push("土日・米国祝日などには新しい値が公表されない場合があります。");
  if (data.calendarVerified !== true || data.latestSessionVerified !== true)
    notes.push("休場日カレンダー・最新公表日との照合は未実施です。取得日時は観測日・公表時刻ではありません。");
  return {
    status: missing ? "unavailable" : stale ? "stale" : !retrievedAt || data.status === "unavailable" ? "unverified" : "received",
    statusLabel: missing ? "欠測・未取得" : stale ? "STALE / 古い取得結果" : !retrievedAt || data.status === "unavailable" ? "取得状態未確認" : "取得済み / 日次公表値",
    asOf, yieldPct, previousDate, previousYieldPct, changeBps, retrievedAt, checkedAt, observationAgeDays, notes,
    yieldText: yieldPct === null ? "N/A" : `${yieldPct.toFixed(2)}%`,
    previousText: previousYieldPct === null ? "N/A" : `${previousYieldPct.toFixed(2)}%`,
    changeText: changeBps === null ? "N/A" : `${changeBps > 0 ? "+" : ""}${changeBps.toFixed(2).replace(/\.00$/, "")} bp`,
    retrievedText: retrievedAt ? new Date(retrievedAt).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "N/A",
    checkedText: checkedAt ? new Date(checkedAt).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "N/A",
  };
}

// One first-view read per page session; subsequent reads require a manual retry.
// Coalesces rapid clicks and React StrictMode mounts. No polling or persistence.
export function createTreasuryYieldStore({ fetcher = (...args) => fetch(...args), endpoint = "/api/treasury-yield" } = {}) {
  let state = { payload: null, loading: false, attempted: false, requestFailed: false };
  let request = null;
  const listeners = new Set();
  const notify = () => listeners.forEach(listener => listener(state));
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    load(force = false) {
      if (request) return request;
      if (state.attempted && !force) return Promise.resolve(state);
      state = { ...state, loading: true, attempted: true };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      request = Promise.resolve().then(async () => {
        try {
          const response = await fetcher(typeof endpoint === "function" ? endpoint() : endpoint, {
            headers: { Accept: "application/json" }, credentials: "omit", cache: "no-store", signal: controller.signal,
          });
          const body = await response.json();
          if (!body || typeof body !== "object" || Array.isArray(body) || !["fresh", "stale", "unavailable"].includes(body.status) || (!response.ok && response.status !== 503)) throw new Error("treasury_unavailable");
          state = { ...state, payload: body, requestFailed: false };
        } catch (_) {
          state = { ...state, requestFailed: true };
        } finally {
          clearTimeout(timer);
          state = { ...state, loading: false };
          request = null;
          notify();
        }
        return state;
      });
      notify();
      return request;
    },
  };
}
