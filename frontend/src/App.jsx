import React, { useState, useEffect, useCallback, useRef } from "react";
import { api, setCsrf } from "./api.js";
import {
  array,
  number,
  fmt,
  usd,
  pct,
  date,
  sign,
  scoreTone,
  actionLabel,
  actionTone,
  statusLabel,
  readLegacyPositions,
  closeSeries,
  safeLink,
  shadowEligible,
  onOff,
  orderView,
} from "./utils.js";

const NAV = [
  ["dashboard", "grid", "司令室"],
  ["scanner", "scan", "スキャナー"],
  ["portfolio", "briefcase", "ポートフォリオ"],
  ["shadow", "layers", "Shadow Trade"],
  ["strategies", "chart", "戦略分析"],
  ["signals", "pulse", "シグナル"],
  ["settings", "settings", "設定・システム"],
];
const DEFAULT_SYMBOLS = [
  "SPY",
  "QQQ",
  "SOXX",
  "MU",
  "SNDK",
  "NVDA",
  "VRT",
  "ANET",
  "RKLB",
  "JMIA",
  "POET",
];
const REGIMES = {
  STRONG_RISK_ON: "強いリスクオン",
  RISK_ON: "リスクオン",
  NEUTRAL: "中立",
  RISK_OFF: "リスクオフ",
  STRONG_RISK_OFF: "強いリスクオフ",
};
function Icon({ name = "grid", size = 20 }) {
  const paths = {
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    scan: "M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5 M8 15l3-5 3 3 3-6",
    briefcase: "M3 7h18v13H3z M8 7V4h8v3 M3 12l9 3 9-3",
    layers: "M12 3 2 8l10 5 10-5-10-5 M2 12l10 5 10-5 M2 16l10 5 10-5",
    chart: "M4 3v17h17 M8 15l4-5 4 3 5-8",
    pulse: "M2 12h4l3-8 5 16 3-8h5",
    settings:
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
    refresh: "M20 7a8 8 0 1 0 0 10 M20 3v5h-5",
    arrow: "M5 12h14 M14 7l5 5-5 5",
    back: "M19 12H5 M10 7l-5 5 5 5",
    shield: "M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4 M8 12l3 3 5-6",
    close: "m6 6 12 12 M18 6 6 18",
    menu: "M3 6h18 M3 12h18 M3 18h18",
    lock: "M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4",
    star: "M12 2l2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2",
    download: "M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4",
    alert: "M12 3 2 21h20L12 3 M12 9v5 M12 17v1",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.grid} />
    </svg>
  );
}
function Badge({ children, tone = "muted" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Empty({
  title = "まだデータがありません",
  text = "データ更新後に、取得できた情報を表示します。",
  icon = "scan",
}) {
  return (
    <div className="empty">
      <span>
        <Icon name={icon} size={26} />
      </span>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
function Panel({ title, kicker, actions, children, className = "" }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <div>
          {kicker && <div className="eyebrow">{kicker}</div>}
          <h2>{title}</h2>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
function Score({ value, large = false }) {
  return (
    <span className={`score ${scoreTone(value)} ${large ? "large" : ""}`}>
      {number(value) === null ? "—" : fmt(value, 0)}
    </span>
  );
}
function KeyValue({ label, value, tone = "" }) {
  return (
    <div className="key-value">
      <span>{label}</span>
      <strong className={tone}>{value ?? "—"}</strong>
    </div>
  );
}
function ErrorBoundaryFallback() {
  return (
    <div className="fatal">
      表示を再開できませんでした。
      <button onClick={() => location.reload()}>再読み込み</button>
    </div>
  );
}
class Boundary extends React.Component {
  constructor(p) {
    super(p);
    this.state = { error: false };
  }
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? <ErrorBoundaryFallback /> : this.props.children;
  }
}

export default function App() {
  return (
    <Boundary>
      <Workspace />
    </Boundary>
  );
}
function Workspace() {
  const [session, setSession] = useState(null),
    [page, setPage] = useState("dashboard"),
    [data, setData] = useState(null),
    [records, setRecords] = useState({}),
    [detail, setDetail] = useState(null),
    [ticker, setTicker] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(""),
    [menu, setMenu] = useState(false),
    [confirmShadow, setConfirmShadow] = useState(null),
    [refreshing, setRefreshing] = useState(false);
  const alive = useRef(true),
    loading = useRef(false),
    lastLoad = useRef(0),
    refreshStarted = useRef(0),
    tickerRequest = useRef(0);
  const notify = useCallback((text) => {
    setNotice(text);
    setTimeout(() => {
      if (alive.current) setNotice("");
    }, 7000);
  }, []);
  const load = useCallback(async (silent = false) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const next = await api("/dashboard");
      if (alive.current) {
        setData(next);
        lastLoad.current = Date.now();
        if (!silent) setError("");
        if (
          refreshStarted.current &&
          ((next.as_of && Date.parse(next.as_of) > refreshStarted.current - 1000) || next.system?.jobs?.refresh_running === false)
        ) {
          setRefreshing(false);
          refreshStarted.current = 0;
        }
      }
    } catch (e) {
      if (alive.current) {
        if (e.status === 401) setSession({ authenticated: false });
        else if (!silent) setError(e.message);
      }
    } finally {
      loading.current = false;
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    api("/auth/session")
      .then((s) => {
        if (alive.current) {
          setSession(s);
          setCsrf(s.csrf_token);
        }
      })
      .catch((e) => {
        if (alive.current) {
          setSession({ authenticated: false });
          setError(e.message);
        }
      });
    return () => {
      alive.current = false;
      tickerRequest.current += 1;
    };
  }, []);
  useEffect(() => {
    if (!session?.authenticated) return;
    load();
    const timer = setInterval(() => load(true), refreshing ? 3500 : 30000);
    return () => clearInterval(timer);
  }, [session?.authenticated, load, refreshing]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const stream = new EventSource("/api/astra/events", {
      withCredentials: true,
    });
    const receiveUpdate = () => {
      if (Date.now() - lastLoad.current > 2500) load(true);
    };
    stream.addEventListener("update", receiveUpdate);
    return () => stream.close();
  }, [session?.authenticated, load]);
  useEffect(() => {
    if (
      !session?.authenticated ||
      ["dashboard", "scanner", "portfolio", "signals", "jmia"].includes(page)
    )
      return;
    let active = true;
    const paths =
      page === "settings"
        ? ["system", "settings", "risk", "system/events"]
        : page === "shadow"
          ? ["shadow", "trades", "orders"]
          : ["strategies"];
    Promise.all(paths.map(async (path) => [path, await api("/" + path)]))
      .then((values) => {
        if (active)
          setRecords((prev) => ({ ...prev, ...Object.fromEntries(values) }));
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [page, session?.authenticated, data?.as_of, data?.revision]);
  const mutation = async (path, body, key, success) => {
    setBusy(key || path);
    setError("");
    try {
      const result = await api(path, {
        method: "POST",
        body,
        timeout: path.includes("analyze") ? 90000 : 30000,
      });
      if (String(result.status).toUpperCase() === "REJECTED") {
        setError("Risk Engine: " + array(result.reasons || result.risk?.reasons).join(" / "));
        await load(true);
        return null;
      }
      if (success) notify(success);
      await load(true);
      return result;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy("");
    }
  };
  const refresh = async () => {
    const result = await mutation("/refresh", {}, "refresh");
    if (result) {
      setRefreshing(true);
      refreshStarted.current = Date.now();
      notify(
        "市場・ニュース・シグナルの更新を開始しました。完了すると画面に反映します。",
      );
    }
  };
  const openTicker = async (symbol) => {
    const request = ++tickerRequest.current;
    setTicker(symbol);
    setDetail(null);
    setError("");
    setMenu(false);
    try {
      const next = await api("/ticker/" + encodeURIComponent(symbol));
      if (alive.current && request === tickerRequest.current) setDetail(next);
    } catch (e) {
      if (alive.current && request === tickerRequest.current) {
        setError(e.message);
        setDetail({ticker: symbol, data_status: "unavailable"});
      }
    }
  };
  const analyze = async (symbol) => {
    const request = tickerRequest.current;
    const result = await mutation(
      "/commander/analyze",
      { ticker: symbol },
      "analyze:" + symbol,
    );
    if (result && alive.current && request === tickerRequest.current) {
      notify(
        result.status === "unavailable"
          ? "Commander未接続です。設定と分析データを確認してください。"
          : "Commanderの分析結果を受信しました。",
      );
      setDetail((prev) =>
        prev?.ticker === symbol
          ? {
              ...prev,
              commander: result.decision || result,
              decision_id: result.decision_id || result.id,
            }
          : prev,
      );
    }
  };
  const navigate = (id) => {
    tickerRequest.current += 1;
    setPage(id);
    setTicker(null);
    setDetail(null);
    setError("");
    setMenu(false);
    if (id === "jmia") openTicker("JMIA");
  };
  const isKilled = data?.risk?.kill_switch?.active === true;
  if (session === null)
    return (
      <div className="boot">
        <div className="astra-symbol">
          <Icon name="star" size={42} />
        </div>
        <h1>
          ASTRA <span>v2</span>
        </h1>
        <p>司令室へ接続中</p>
        <div className="loading-line" />
      </div>
    );
  if (!session.authenticated)
    return (
      <Login
        session={session}
        error={error}
        onLogin={(s) => {
          setSession(s);
          setCsrf(s.csrf_token);
          setError("");
        }}
      />
    );
  return (
    <div className="app-shell">
      {menu && (
        <button
          className="nav-scrim"
          aria-label="ナビゲーションを閉じる"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <a className="brand" href="/astra/" aria-label="Astra 司令室">
          <span className="brand-mark">
            <Icon name="star" size={26} />
          </span>
          <span>
            ASTRA<span className="brand-version">v2</span>
            <small>US EQUITY COMMAND</small>
          </span>
        </a>
        <div className="nav-caption">WORKSPACE</div>
        <nav>
          {NAV.map(([id, icon, label]) => (
            <button
              key={id}
              className={page === id && !ticker ? "active" : ""}
              onClick={() => navigate(id)}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {id === "signals" && array(data?.signals).length > 0 && (
                <em>{Math.min(array(data?.signals).length, 99)}</em>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-caption focus-caption">PRIORITY WATCH</div>
        <button
          className={`focus-link ${ticker === "JMIA" ? "active" : ""}`}
          onClick={() => navigate("jmia")}
        >
          <span className="ticker-avatar">J</span>
          <span>
            JMIA<small>専用分析ダッシュボード</small>
          </span>
          <Icon name="arrow" size={16} />
        </button>
        <div className="sidebar-bottom">
          <div className="simulation">
            <span className={`status-dot ${data?.system?.shadow_trading === true ? "" : "dim"}`} />
            {data?.system?.mode ? `${String(data.system.mode).toUpperCase()} MODE` : "MODE 未取得"}
            <small>{data?.system?.mode === "paper" ? "Paper Broker 未接続" : `Shadow Trading ${onOff(data?.system?.shadow_trading)}`}</small>
          </div>
          <a href="/" className="legacy-link">
            従来の米国株司令室 <Icon name="arrow" size={14} />
          </a>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="icon-button mobile-menu"
              aria-label="メニューを開く"
              onClick={() => setMenu(true)}
            >
              <Icon name="menu" />
            </button>
            <span className="breadcrumb">WORKSPACE</span>
            <span className="divider">/</span>
            <strong>
              {ticker
                ? `${ticker} 銘柄分析`
                : NAV.find((n) => n[0] === page)?.[2] || "司令室"}
            </strong>
          </div>
          <div className="topbar-actions">
            <Badge tone={isKilled ? "red" : "green"}>
              <Icon name="shield" size={12} />
              {isKilled ? "新規取引停止" : "Risk Engine ON"}
            </Badge>
            <button
              className="button compact"
              onClick={refresh}
              disabled={!!busy || refreshing}
            >
              <span className={busy === "refresh" || refreshing ? "spin" : ""}>
                <Icon name="refresh" size={15} />
              </span>
              {refreshing ? "更新中" : "データ更新"}
            </button>
          </div>
        </header>
        <div className="main-content">
          {error && (
            <div className="banner error" role="alert">
              <Icon name="alert" size={18} />
              <span>{error}</span>
              <button aria-label="エラーを閉じる" onClick={() => setError("")}>
                <Icon name="close" size={15} />
              </button>
            </div>
          )}
          {isKilled && (
            <div className="banner error">
              <Icon name="shield" />
              <span>
                <strong>Kill Switch作動中</strong> —{" "}
                {array(data.risk.kill_switch.reasons).join(" / ") ||
                  "新規の仮想エントリーを停止しています。設定画面で状態を確認してください。"}
              </span>
            </div>
          )}
          {ticker ? (
            <TickerDetail
              row={detail}
              ticker={ticker}
              onBack={() => {
                tickerRequest.current += 1;
                setTicker(null);
                setDetail(null);
                if (page === "jmia") setPage("dashboard");
              }}
              onAnalyze={analyze}
              busy={busy}
              onShadow={setConfirmShadow}
              killed={isKilled}
              shadowEnabled={data?.system?.mode === "shadow" && data?.system?.shadow_trading === true}
            />
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    {page === "dashboard"
                      ? "INTELLIGENCE, WITH DISCIPLINE"
                      : "ASTRA WORKSPACE"}
                  </div>
                  <h1>
                    {
                      {
                        dashboard: "トレーディング司令室",
                        scanner: "機会を、見逃さない。",
                        portfolio: "ポートフォリオ",
                        shadow: "判断を、記録で検証する。",
                        strategies: "戦略アナリティクス",
                        signals: "シグナル・ストリーム",
                        settings: "設定とシステム状態",
                      }[page]
                    }
                  </h1>
                  <p>
                    {
                      {
                        dashboard:
                          "市場からシグナルへ。複数の視点を統合し、独立したリスク審査へ。",
                        scanner:
                          "テクニカル・材料・テーマ・市場環境を横断して候補を抽出。",
                        portfolio:
                          "新規エントリーと同じ精度で、保有ポジションのリスクを管理。",
                        shadow:
                          "実際の市場データに基づく仮想取引。実注文は送信しません。",
                        strategies:
                          "勝率だけでなく、期待値と損失の大きさまで確認。",
                        signals:
                          "分析を発火する価格変動、出来高、材料の変化を記録。",
                        settings:
                          "認証、データ接続、リスク制限、運用状態を一か所で確認。",
                      }[page]
                    }
                  </p>
                </div>
                <div className="updated">
                  <span
                    className={`status-dot ${data?.status === "ok" ? "" : "dim"}`}
                  />
                  {statusLabel(data?.status)}
                  <small>最終更新 {date(data?.as_of)}</small>
                </div>
              </div>
              {page === "dashboard" && (
                <>
                  <MarketStrip market={data?.market} />
                  <div className="dashboard-top">
                    <CommanderPanel
                      commander={data?.commander}
                      system={data?.system}
                      onTicker={openTicker}
                    />
                    <RiskOverview risk={data?.risk} market={data?.market} />
                  </div>
                  <Scanner
                    rows={data?.scanner}
                    onTicker={openTicker}
                    compact
                    onAll={() => navigate("scanner")}
                  />
                  <div className="dashboard-bottom">
                    <Themes rows={data?.themes} />
                    <SignalList
                      rows={data?.signals}
                      compact
                      onTicker={openTicker}
                    />
                  </div>
                </>
              )}
              {page === "scanner" && (
                <Scanner rows={data?.scanner} onTicker={openTicker} />
              )}
              {page === "portfolio" && (
                <Portfolio
                  rows={data?.portfolio}
                  onTicker={openTicker}
                  onImport={(positions) =>
                    mutation(
                      "/portfolio/import",
                      { positions },
                      "import",
                      "既存ポジションを分析用として取り込みました。",
                    )
                  }
                  busy={busy}
                />
              )}
              {page === "shadow" && (
                <ShadowPage
                  rows={records.shadow?.items}
                  trades={records.trades?.items}
                  orders={records.orders?.items}
                  busy={busy}
                  onTicker={openTicker}
                  onClose={async (id) => {
    const r = await mutation(
                      "/shadow/" + encodeURIComponent(id) + "/close",
                      { idempotency_key: crypto.randomUUID() },
                      "close:" + id,
                      "仮想決済を記録しました。",
                    );
                    if (r && String(r.status).toUpperCase() === "CLOSED")
                      setRecords((p) => ({
                        ...p,
                        shadow: {
                          items: array(p.shadow?.items).map((t) =>
                            t.id === id ? { ...t, ...r } : t,
                          ),
                        },
                      }));
                  }}
                />
              )}
              {page === "strategies" && (
                <Strategies rows={records.strategies?.items} />
              )}
              {page === "signals" && (
                <SignalList rows={data?.signals} onTicker={openTicker} />
              )}
              {page === "settings" && (
                <Settings
                  data={records}
                  dashboard={data}
                  session={session}
                  busy={busy}
                  onMutation={mutation}
                  onLogout={async () => {
                    const r = await mutation("/auth/logout", {}, "logout");
                    if (r) {
                      setCsrf("");
                      setSession({ authenticated: false });
                    }
                  }}
                />
              )}
            </>
          )}
          <footer className="footer">
            <span>
              ASTRA v2 <span className="footer-dot">·</span> 分析支援 / SHADOW
              ONLY
            </span>
            <span>
              データの不足・遅延は明示し、リスク審査で新規エントリーを制限します。
            </span>
          </footer>
        </div>
      </main>
      {notice && (
        <div className="toast" role="status">
          <Icon name="shield" size={18} />
          {notice}
        </div>
      )}
      {confirmShadow && (
        <Modal
          title="Shadow Tradeを記録"
          onClose={() => setConfirmShadow(null)}
        >
          <p>
            {confirmShadow.ticker} の保存済みAI判断を独立したRisk
            Engineへ送ります。最新価格・流動性・スプレッドなどの条件が不足すると拒否されます。
          </p>
          <div className="info-note">
            仮想取引です。実際のBrokerへの注文は送信しません。
          </div>
          <button
            className="button primary full"
            disabled={!!busy}
            onClick={async () => {
              const id = confirmShadow.decision_id || confirmShadow.id;
              const r = await mutation(
                "/shadow",
                { decision_id: id, idempotency_key: crypto.randomUUID() },
                "shadow",
                "リスク審査の結果を記録しました。",
              );
              if (r) setConfirmShadow(null);
            }}
          >
            {["SELL", "STOP"].includes(confirmShadow.action) ? "安全確認して仮想ポジションを全決済" : "リスク審査して仮想エントリー"}
          </button>
        </Modal>
      )}
    </div>
  );
}

function Login({ session, error, onLogin }) {
  const [password, setPassword] = useState(""),
    [loading, setLoading] = useState(false),
    [message, setMessage] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      const s = await api("/auth/login", {
        method: "POST",
        body: { password },
      });
      setPassword("");
      if (s.authenticated) onLogin(s);
      else {
        const next = await api("/auth/session");
        if (next.authenticated) onLogin(next);
        else setMessage("認証を確認できませんでした。");
      }
    } catch (e) {
      setMessage(e.message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="login-page">
      <div className="login-art">
        <div className="orbital o1" />
        <div className="orbital o2" />
        <div className="orbital o3" />
        <span className="login-star">
          <Icon name="star" size={75} />
        </span>
        <div className="login-copy">
          <div className="eyebrow">US EQUITY COMMAND</div>
          <h1>
            判断に、
            <br />
            <span>確かな根拠を。</span>
          </h1>
          <p>
            Market → Signal → Intelligence → Risk
            <br />
            米国株AI司令室 Astra v2
          </p>
          <div className="login-principles">
            <span>独立したリスク審査</span>
            <span>Shadowで継続検証</span>
            <span>証拠に基づく分析</span>
          </div>
        </div>
      </div>
      <div className="login-form-wrap">
        <div className="brand login-brand">
          <span className="brand-mark">
            <Icon name="star" size={26} />
          </span>
          <span>
            ASTRA<span className="brand-version">v2</span>
            <small>INTELLIGENCE WORKSPACE</small>
          </span>
        </div>
        <div className="login-form">
          <Badge tone="green">
            <Icon name="lock" size={12} />
            PRIVATE WORKSPACE
          </Badge>
          <h2>司令室へログイン</h2>
          <p>管理者パスワードで、安全なセッションを開始します。</p>
          <form onSubmit={submit}>
            <label htmlFor="password">管理者パスワード</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="パスワードを入力"
            />
            {(message || error) && (
              <div className="form-error" role="alert">
                {message || error}
              </div>
            )}
            <button
              className="button primary full"
              type="submit"
              disabled={loading || !password}
            >
              {loading ? "認証中…" : "司令室を開く"}
              <Icon name="arrow" size={17} />
            </button>
          </form>
          <p className="login-help">
            初回設定では、サーバー側の管理者パスワードと認証用シークレットを設定してください。APIキーはこの画面に入力しません。
          </p>
          <a className="text-link" href="/">
            従来の司令室へ <Icon name="arrow" size={14} />
          </a>
        </div>
        <div className="login-foot">
          SHADOW TRADING ENABLED <span>LIVE TRADING OFF</span>
        </div>
      </div>
    </div>
  );
}

function MarketStrip({ market }) {
  const metrics = market?.instruments || market?.metrics || market?.quotes || market?.indicators || {};
  const get = (keys) => {
    for (const key of keys) {
      const value = Array.isArray(metrics)
        ? metrics.find((x) => (x.ticker || x.symbol || x.name) === key)
        : metrics[key];
      if (value !== undefined)
        return typeof value === "number" ? { price: value } : value;
    }
    for (const key of keys) {
      if (market?.[key] !== undefined)
        return typeof market[key] === "number"
          ? { price: market[key] }
          : market[key];
    }
    return {};
  };
  const items = [
    ["SPY", ["SPY", "spy"]],
    ["QQQ", ["QQQ", "qqq"]],
    ["IWM", ["IWM", "iwm"]],
    ["VIX", ["VIX", "^VIX", "vix"]],
    ["WTI原油", ["WTI", "CL=F"]],
    ["BTC", ["BTC", "BTC-USD", "btc"]],
    ["米10年債", ["Treasury Yield", "TNX", "^TNX", "treasury_yield"]],
    ["USD", ["USD", "DX-Y.NYB", "usd"]],
    ["USD/JPY", ["USD/JPY", "JPY=X"]],
    ["RISK SCORE", ["risk_score", "fear_risk_score"]],
  ];
  return (
    <div className="market-strip">
      {items.map(([label, keys]) => {
        const q = get(keys),
          value = q.price ?? q.value;
        return (
          <div className="market-stat" key={label}>
            <span>{label}</span>
            <strong>{fmt(value, label === "BTC" ? 0 : 2)}</strong>
            <small className={sign(q.change_pct ?? q.changePct ?? q.change)}>
              {number(q.change_pct ?? q.changePct ?? q.change) === null
                ? (label === "RISK SCORE" && number(value) !== null ? "リスク指数 / 確率ではありません" : statusLabel(q.status || q.data_status || "unavailable"))
                : pct(q.change_pct ?? q.changePct ?? q.change)}
            </small>
          </div>
        );
      })}
    </div>
  );
}
function CommanderPanel({ commander, system, onTicker }) {
  const c = commander || {},
    summary = c.market_summary || c.summary || c.today_strategy || c.strategy;
  const latest = c.decision || array(c.decisions)[0];
  return (
    <Panel
      title="Astra Commander"
      kicker="MULTI-AGENT INTELLIGENCE"
      className="commander-panel"
      actions={
        <Badge tone="muted">
          <span className="status-dot dim" />
          {system?.openai_configured ? "APIキー設定済み" : "APIキー未設定"}
        </Badge>
      }
    >
      <div className="commander-body">
        <div className="commander-orbit">
          <Icon name="star" size={36} />
        </div>
        <div>
          <div className="commander-label">TODAY'S STRATEGY</div>
          <h3>
            {typeof summary === "string"
              ? summary
              : "判断の前に、証拠を揃える。"}
          </h3>
          <p>
            {c.comment ||
              c.reason ||
              (!system?.openai_configured
                ? "CommanderモデルとOpenAI接続を設定すると、重要シグナルを起点に統合分析します。"
                : "有効なシグナルとAgentの分析結果を待っています。")}
          </p>
        </div>
      </div>
      <div className="commander-bottom">
        <div>
          <span>BEST OPPORTUNITY</span>
          {latest?.ticker ? (
            <button
              className="ticker-link"
              onClick={() => onTicker(latest.ticker)}
            >
              {latest.ticker} <Icon name="arrow" size={13} />
            </button>
          ) : (
            <strong>{c.best_opportunity || "分析待ち"}</strong>
          )}
        </div>
        <div>
          <span>RISK LEVEL</span>
          <strong>{c.risk_level || "評価待ち"}</strong>
        </div>
        <div>
          <span>PORTFOLIO ACTION</span>
          <strong>{c.portfolio_action || "評価待ち"}</strong>
        </div>
      </div>
      {array(c.avoid).length > 0 && (
        <div className="commander-avoid">回避対象：{c.avoid.join(" / ")}</div>
      )}
    </Panel>
  );
}
function RiskOverview({ risk, market }) {
  const regime = market?.regime || market?.market_regime,
    active = risk?.kill_switch?.active;
  return (
    <Panel
      title="市場とリスク"
      kicker="REGIME & PROTECTION"
      className="risk-overview"
    >
      <div className="regime-block">
        <span
          className={`regime-pulse ${regime?.includes("OFF") ? "red" : ""}`}
        />
        <div>
          <span>MARKET REGIME</span>
          <strong>{REGIMES[regime] || "評価待ち"}</strong>
          <small>{regime || "UNAVAILABLE"}</small>
        </div>
      </div>
      <div className="risk-divider" />
      <KeyValue
        label="Market Score"
        value={<Score value={market?.score ?? market?.market_score} />}
      />
      <KeyValue
        label="Kill Switch"
        value={active ? "作動中" : "待機"}
        tone={active ? "negative" : "positive"}
      />
      <KeyValue label="Live Trading" value="OFF" />
      <KeyValue label="注文前審査" value="必須" />
      <p className="micro-copy">AIの判断を独立したRisk Engineが審査します。</p>
    </Panel>
  );
}
function Scanner({ rows, onTicker, compact = false, onAll }) {
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  let items = array(rows).filter(
    (r) =>
      !search || String(r.ticker).toUpperCase().includes(search.toUpperCase()),
  );
  if (filter === "watch")
    items = items.filter((r) => (r.astra_score ?? r.total_score) >= 70);
  if (filter === "complete")
    items = items.filter((r) => r.data_status === "ok");
  items = [...items].sort(
    (a, b) =>
      (b.astra_score ?? b.total_score ?? -1) -
      (a.astra_score ?? a.total_score ?? -1),
  );
  if (compact) items = items.slice(0, 7);
  return (
    <Panel
      title="Astra Top Picks"
      kicker="OPPORTUNITY SCANNER"
      actions={
        compact ? (
          <button className="text-link" onClick={onAll}>
            すべて表示 <Icon name="arrow" size={14} />
          </button>
        ) : (
          <Badge>{items.length} 銘柄</Badge>
        )
      }
    >
      {!compact && (
        <div className="table-toolbar">
          <div className="segment">
            <button
              className={filter === "all" ? "active" : ""}
              onClick={() => setFilter("all")}
            >
              すべて
            </button>
            <button
              className={filter === "watch" ? "active" : ""}
              onClick={() => setFilter("watch")}
            >
              70点以上
            </button>
            <button
              className={filter === "complete" ? "active" : ""}
              onClick={() => setFilter("complete")}
            >
              データ完備
            </button>
          </div>
          <input
            aria-label="ティッカーを検索"
            className="search-input"
            placeholder="Tickerを検索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}
      {items.length ? (
        <div className="table-scroll">
          <table className="scanner-table">
            <thead>
              <tr>
                <th>#</th>
                <th>TICKER</th>
                <th>PRICE / CHANGE</th>
                <th>RVOL</th>
                <th>TECH</th>
                <th>CATALYST</th>
                <th>THEME</th>
                <th>MARKET</th>
                <th>ASTRA</th>
                <th>ACTION</th>
                <th>CONF.</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r, i) => (
                <tr key={r.ticker} onClick={() => onTicker(r.ticker)}>
                  <td className="rank-cell">
                    {String(i + 1).padStart(2, "0")}
                  </td>
                  <td>
                    <button
                      className="ticker-link"
                      onClick={(e) => {
                        e.stopPropagation();
                        onTicker(r.ticker);
                      }}
                    >
                      {r.ticker}
                      <Icon name="arrow" size={12} />
                    </button>
                    <small>{r.setup || statusLabel(r.data_status)}</small>
                  </td>
                  <td>
                    <strong>{usd(r.price)}</strong>
                    <small className={sign(r.change)}>{pct(r.change)}</small>
                  </td>
                  <td>
                    {number(r.rvol) === null ? "—" : `${fmt(r.rvol, 1)}×`}
                  </td>
                  {[
                    "technical_score",
                    "catalyst_score",
                    "theme_score",
                    "market_score",
                  ].map((k) => (
                    <td key={k}>
                      <Score value={r[k]} />
                    </td>
                  ))}
                  <td>
                    <div className="astra-score">
                      <Score value={r.astra_score ?? r.total_score} />
                      <span>{r.tier || "—"}</span>
                    </div>
                  </td>
                  <td>
                    <Badge tone={actionTone(r.action)}>
                      {actionLabel(r.action)}
                    </Badge>
                    {r.data_status !== "ok" && (
                      <small className="data-note">
                        {statusLabel(r.data_status)}
                      </small>
                    )}
                  </td>
                  <td>
                    {number(r.confidence) === null
                      ? "—"
                      : `${fmt(r.confidence, 0)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={search ? "該当する銘柄がありません" : "候補を待っています"}
          text="データ更新で市場情報を取得し、Signal Engineが候補を評価します。未取得の指標を仮の数値で補いません。"
        />
      )}
      <div className="panel-foot">
        スコアは分析支援です。買い候補も、データ鮮度・流動性・リスク制限の審査を通過する必要があります。
      </div>
    </Panel>
  );
}
function Themes({ rows }) {
  const items = [...array(rows)]
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, 12);
  return (
    <Panel
      title="テーマ・ローテーション"
      kicker="CAPITAL & CONVICTION"
      actions={<span className="muted-text">{array(rows).length} THEMES</span>}
    >
      {items.length ? (
        <div className="theme-list">
          {items.map((t, i) => (
            <div className="theme-row" key={t.id || t.name || i}>
              <span className="theme-rank">{i + 1}</span>
              <div className="theme-title">
                <strong>{t.name || t.id}</strong>
                <div className="theme-track">
                  <span
                    style={{
                      width: `${Math.max(0, Math.min(100, number(t.score) ?? 0))}%`,
                    }}
                  />
                </div>
              </div>
              <div className="theme-change">
                <small>24H / 7D</small>
                <span className={sign(t.change_24h)}>{fmt(t.change_24h)} pt</span>
                <span className={sign(t.change_7d)}>{fmt(t.change_7d)} pt</span>
              </div>
              <Score value={t.score} />
            </div>
          ))}
        </div>
      ) : (
        <Empty
          title="テーマ情報を待っています"
          text="テーマの強度と24時間・7日変化を蓄積します。比較対象の履歴がない変化率は未取得です。"
          icon="layers"
        />
      )}
    </Panel>
  );
}
function SignalList({ rows, compact = false, onTicker }) {
  const items = compact ? array(rows).slice(0, 6) : array(rows);
  return (
    <Panel
      title="重要シグナル"
      kicker="LIVE SIGNAL FEED"
      actions={<Badge>{items.length} EVENTS</Badge>}
    >
      {items.length ? (
        <div className="signal-list">
          {items.map((s, i) => (
            <div className="signal-row" key={s.id || i}>
              <span
                className={`signal-symbol ${s.severity === "critical" ? "red" : ""}`}
              >
                <Icon name="pulse" size={16} />
              </span>
              <div className="signal-copy">
                <div>
                  {s.ticker && (
                    <button
                      className="ticker-link"
                      onClick={() => onTicker(s.ticker)}
                    >
                      {s.ticker}
                    </button>
                  )}
                  <strong>
                    {s.label || s.type || s.signal_type || array(s.kinds).join(" / ") || "Market Signal"}
                  </strong>
                </div>
                <p>
                  {s.description ||
                    s.reason ||
                    s.message ||
                    array(s.reasons).join(" / ") ||
                    "詳細データを銘柄画面で確認"}
                </p>
                <small>{date(s.timestamp || s.as_of || s.created_at)}</small>
              </div>
              <Badge
                tone={
                  s.severity === "critical"
                    ? "red"
                    : s.severity === "high"
                      ? "amber"
                      : "muted"
                }
              >
                {s.severity || s.status || "検知"}
              </Badge>
            </div>
          ))}
        </div>
      ) : (
        <Empty
          title="新しいシグナルはありません"
          text="出来高・テクニカル・重要ニュースなどの条件が発火すると、ここに記録されます。"
          icon="pulse"
        />
      )}
    </Panel>
  );
}
function Portfolio({ rows, onTicker, onImport, busy }) {
  const [preview, setPreview] = useState(null),
    [localError, setLocalError] = useState("");
  const items = array(rows);
  const valued = items.filter((p) => number(p.unrealized_pnl) !== null);
  const pnl =
    items.length && valued.length === items.length
      ? valued.reduce((s, p) => s + p.unrealized_pnl, 0)
      : null;
  const importLocal = () => {
    try {
      const ps = readLegacyPositions(localStorage);
      if (!ps.length) {
        setLocalError("この端末に取り込める従来版の保有データがありません。");
        return;
      }
      setPreview(ps);
      setLocalError("");
    } catch {
      setLocalError(
        "端末の保有データを読み取れませんでした。従来版のJSONを確認してください。",
      );
    }
  };
  return (
    <>
      <div className="summary-cards">
        <Summary label="保有銘柄" value={items.length} />
        <Summary label="含み損益 / USD" value={usd(pnl)} tone={sign(pnl)} />
        <Summary
          label="管理モード"
          value="OBSERVATION"
          note="分析用の保有情報"
        />
      </div>
      <Panel
        title="保有ポジション"
        kicker="PORTFOLIO INTELLIGENCE"
        actions={
          <button
            className="button compact"
            disabled={!!busy}
            onClick={importLocal}
          >
            <Icon name="download" size={14} />
            従来版から取り込む
          </button>
        }
      >
        {localError && <div className="info-note">{localError}</div>}
        {items.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    "TICKER",
                    "株数",
                    "取得単価",
                    "現在値",
                    "含み損益",
                    "実現損益",
                    "ASTRA ACTION",
                    "STOP",
                    "TARGET",
                    "RISK",
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((p, i) => (
                  <tr key={p.ticker || i}>
                    <td>
                      <button
                        className="ticker-link"
                        onClick={() => onTicker(p.ticker)}
                      >
                        {p.ticker}
                      </button>
                      <small>{statusLabel(p.data_status)}</small>
                    </td>
                    <td>{fmt(p.shares, 2)}</td>
                    <td>{usd(p.average_cost)}</td>
                    <td>{usd(p.current_price ?? p.price)}</td>
                    <td className={sign(p.unrealized_pnl)}>
                      {usd(p.unrealized_pnl)}
                    </td>
                    <td className={sign(p.realized_pnl)}>
                      {usd(p.realized_pnl)}
                    </td>
                    <td>
                      <Badge tone={actionTone(p.astra_action || p.action)}>
                        {actionLabel(p.astra_action || p.action)}
                      </Badge>
                    </td>
                    <td>{usd(p.stop)}</td>
                    <td>{usd(p.target || array(p.targets)[0])}</td>
                    <td>{pct(p.risk_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="保有ポジションは未登録です"
            text="従来版のこの端末の保有データを、明示操作で取り込めます。元のデータは変更しません。"
            icon="briefcase"
          />
        )}
      </Panel>
      {preview && (
        <Modal title="保有情報の取り込み" onClose={() => setPreview(null)}>
          <p>
            {preview.length}{" "}
            銘柄をサーバーのポートフォリオへ分析用として登録します。実際の証券口座や注文には反映しません。
          </p>
          <div className="import-list">
            {preview.map((p) => (
              <KeyValue
                key={p.ticker}
                label={p.ticker}
                value={`${fmt(p.shares, 2)} 株 / ${usd(p.average_cost)}`}
              />
            ))}
          </div>
          <button
            className="button primary full"
            disabled={!!busy}
            onClick={async () => {
              const r = await onImport(preview);
              if (r) setPreview(null);
            }}
          >
            この保有情報を取り込む
          </button>
        </Modal>
      )}
    </>
  );
}
function Summary({ label, value, note, tone = "" }) {
  return (
    <div className="summary-card">
      <span>{label}</span>
      <strong className={tone}>{value ?? "—"}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
function ShadowPage({ rows, trades, orders, busy, onTicker, onClose }) {
  const [close, setClose] = useState(null),
    items = array(rows),
    closed = items.filter((t) => String(t.status).toLowerCase() === "closed"),
    open = items.filter((t) => String(t.status).toLowerCase() === "open");
  return (
    <>
      <div className="summary-cards">
        <Summary
          label="蓄積したShadow Trade"
          value={items.length}
          note="仮想エントリーの検証記録"
        />
        <Summary label="追跡中" value={open.length} />
        <Summary label="決済済み" value={closed.length} />
      </div>
      <div className="info-note">
        保存済みCommander判断から銘柄詳細画面で仮想エントリーできます。約定条件はサーバー側で再確認され、取得できない条件があれば拒否されます。
      </div>
      <Panel title="仮想エントリー審査・約定待ち" kicker="SHADOW ORDER STATUS" className="orders-panel" actions={<Badge>{array(orders).filter(order => orderView(order).status === "PENDING").length} 約定待ち</Badge>}>
        {array(orders).length ? <div className="table-scroll"><table>
          <thead><tr>{["TICKER", "STATUS", "審査日時", "株数", "仮想予約資金", "理由・待機条件", "審査時の価格日時"].map(label => <th key={label}>{label}</th>)}</tr></thead>
          <tbody>{array(orders).map((order, index) => {const view = orderView(order);return <tr key={order.id || index}>
            <td><button className="ticker-link" onClick={() => onTicker(order.ticker)} disabled={!order.ticker}>{order.ticker || "—"}</button></td>
            <td><Badge tone={view.tone}>{view.label}</Badge></td>
            <td>{date(order.created_at)}</td><td>{fmt(order.shares, 0)}</td><td>{usd(order.reserved_cash)}</td>
            <td className="order-reasons">{view.reasons.length ? view.reasons.join(" / ") : view.status === "PENDING" ? "次の検証可能な価格で、約定条件を再確認します。" : "—"}</td>
            <td>{date(order.submitted_quote_as_of)}</td>
          </tr>;})}</tbody>
        </table></div> : <Empty title="審査済みの仮想エントリーはありません" text="約定待ち・Risk Engineでの拒否をここで確認できます。審査受付と仮想約定は別の状態として記録されます。" icon="shield"/>}
        <div className="panel-foot">約定待ちは未約定です。審査を通過しても、次の価格観測時に鮮度・リスク・エントリー条件を再確認します。</div>
      </Panel>
      <Panel
        title="Shadow Trade Journal"
        kicker="DECISION → RISK → VIRTUAL EXECUTION"
      >
        {items.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    "TICKER / SETUP",
                    "STATUS",
                    "ENTRY",
                    "STOP",
                    "損益",
                    "+1D",
                    "+3D",
                    "+5D",
                    "+10D",
                    "+20D",
                    "操作",
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((t) => {
                  const returns =
                    t.horizon_returns || t.performance || t.returns || {};
                  return (
                    <tr key={t.id}>
                      <td>
                        <button
                          className="ticker-link"
                          onClick={() => onTicker(t.ticker)}
                        >
                          {t.ticker}
                        </button>
                        <small>
                          {t.setup || t.entry_context?.setup || "—"}
                        </small>
                        <small>
                          {date(
                            t.entry_timestamp || t.opened_at || t.timestamp,
                          )}
                        </small>
                      </td>
                      <td>
                        <Badge tone={String(t.status).toLowerCase() === "open" ? "green" : "muted"}>
                          {String(t.status).toLowerCase() === "open"
                            ? "追跡中"
                            : String(t.status).toLowerCase() === "closed"
                              ? "決済済み"
                              : t.status || "未取得"}
                        </Badge>
                      </td>
                      <td>{usd(t.entry_price ?? t.entry)}</td>
                      <td>{usd(t.stop)}</td>
                      <td className={sign(t.profit ?? t.pnl)}>
                        {usd(t.profit ?? t.pnl)}
                      </td>
                      {[1, 3, 5, 10, 20].map((d) => (
                        <td
                          key={d}
                          className={sign(returns[d]?.return_pct ?? returns[d] ?? returns[`${d}d`])}
                        >
                          {pct(returns[d]?.return_pct ?? returns[d] ?? returns[`${d}d`])}
                        </td>
                      ))}
                      <td>
                        <button
                          className="button compact"
                          disabled={!!busy || String(t.status).toLowerCase() !== "open"}
                          onClick={() => setClose(t)}
                        >
                          仮想決済
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="最初の判断を、検証記録へ。"
            text="まだShadow Tradeはありません。銘柄のCommander分析を確認し、Risk Engineの審査を通過すると仮想取引を記録します。"
            icon="layers"
          />
        )}
      </Panel>
      <Panel
        title="Trade Events"
        kicker="AUDIT JOURNAL"
        className="section-gap"
      >
        {array(trades).length ? (
          <div className="signal-list">
            {array(trades)
              .slice(0, 50)
              .map((t, i) => (
                <div className="signal-row" key={t.id || i}>
                  <span className="signal-symbol">
                    <Icon name="layers" size={16} />
                  </span>
                  <div className="signal-copy">
                    <strong>
                      {t.ticker} ·{" "}
                      {t.event_type || t.action || t.status || "Trade"}
                    </strong>
                    <p>{t.exit_reason || t.reason || t.setup || "取引記録"}</p>
                    <small>{date(t.timestamp || t.created_at)}</small>
                  </div>
                  <span className={sign(t.profit ?? t.pnl)}>
                    {usd(t.profit ?? t.pnl)}
                  </span>
                </div>
              ))}
          </div>
        ) : (
          <Empty
            title="取引イベントはありません"
            text="エントリー・決済時の判断材料とその後の結果を保存します。"
          />
        )}
      </Panel>
      {close && (
        <Modal
          title={`${close.ticker} を仮想決済`}
          onClose={() => setClose(null)}
        >
          <p>
            最新の市場価格を取得し、追跡中のShadow
            Tradeを決済します。価格が古い場合や取得できない場合は、決済を実行しません。
          </p>
          <button
            className="button primary full"
            disabled={!!busy}
            onClick={async () => {
              await onClose(close.id);
              setClose(null);
            }}
          >
            最新価格で仮想決済
          </button>
        </Modal>
      )}
    </>
  );
}
function Strategies({ rows }) {
  const items = array(rows);
  return (
    <>
      <Panel
        title="Setup別パフォーマンス"
        kicker="STRATEGY ANALYTICS"
        actions={<Badge>{items.length} SETUPS</Badge>}
      >
        {items.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    "SETUP",
                    "件数",
                    "勝率",
                    "平均利益",
                    "平均損失",
                    "期待値",
                    "PF",
                    "最大DD",
                    "SHARPE",
                    "平均保有日数",
                    "MFE",
                    "MAE",
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((s, i) => (
                  <tr key={s.setup || i}>
                    <td>
                      <strong>{s.setup || s.name}</strong>
                    </td>
                    <td>{fmt(s.trade_count, 0)}</td>
                    <td>{pct(s.win_rate)}</td>
                    <td className="positive">{fmt(s.average_win)}</td>
                    <td className="negative">{fmt(s.average_loss)}</td>
                    <td className={sign(s.expectancy)}>{fmt(s.expectancy)}</td>
                    <td>{fmt(s.profit_factor)}</td>
                    <td className="negative">
                      {pct(s.maximum_drawdown ?? s.max_drawdown)}
                    </td>
                    <td>{fmt(s.sharpe_ratio)}</td>
                    <td>{fmt(s.average_holding_period, 1)}</td>
                    <td>{pct(s.mfe ?? s.average_mfe)}</td>
                    <td>{pct(s.mae ?? s.average_mae)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="戦略評価のための記録を蓄積中"
            text="決済済みShadow Tradeから、Setupごとの勝率・期待値・ドローダウンを計算します。取引が不足する指標は未取得です。"
            icon="chart"
          />
        )}
      </Panel>
      <div className="analytics-note">
        <Icon name="chart" size={25} />
        <div>
          <h3>結果だけでなく、判断の質を振り返る</h3>
          <p>
            エントリー時の市場環境・テクニカル・ニュース・リスクを残し、現在のSetupと過去の類似取引を比較します。件数の少ない成績は、その不確実性も含めて評価します。
          </p>
        </div>
      </div>
    </>
  );
}
function Modal({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.focus();
    const key = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const nodes = ref.current?.querySelectorAll(
          'button,input,a[href],select,textarea,[tabindex="0"]',
        );
        const a = Array.from(nodes || []).filter((x) => !x.disabled);
        if (!a.length) return;
        if (e.shiftKey && document.activeElement === a[0]) {
          e.preventDefault();
          a.at(-1).focus();
        } else if (!e.shiftKey && document.activeElement === a.at(-1)) {
          e.preventDefault();
          a[0].focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      before?.focus?.();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="閉じる" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function TickerDetail({
  row,
  ticker,
  onBack,
  onAnalyze,
  busy,
  onShadow,
  killed,
}) {
  const [frame, setFrame] = useState("daily");
  if (!row)
    return (
      <div className="detail-loading">
        <button className="text-link" onClick={onBack}>
          <Icon name="back" size={16} />
          戻る
        </button>
        <div className="empty">
          <div className="loading-line" />
          <strong>{ticker} の分析を取得中</strong>
        </div>
      </div>
    );
  const tech = row.technical || {},
    daily = tech.daily || tech,
    weekly = tech.weekly || {},
    current = frame === "daily" ? daily : weekly;
  const commander =
    row.commander?.decision || row.commander || row.decision || {};
  const decision = {
    ...commander,
    ticker,
    decision_id: row.decision_id || row.commander?.decision_id || row.commander?.id || commander.decision_id || commander.id,
  };
  const history = frame === "daily" ? row.history : row.weekly;
  const news = array(row.news),
    sec = array(row.sec),
    riskFlags = [...array(row.risk_flags), ...array(commander.risk_flags)];
  return (
    <>
      <button className="text-link detail-back" onClick={onBack}>
        <Icon name="back" size={16} />
        一覧に戻る
      </button>
      <div className="ticker-heading">
        <div className="ticker-identity">
          <span className="ticker-avatar big">{ticker[0]}</span>
          <div>
            <div className="eyebrow">
              {row.name || "US EQUITY INTELLIGENCE"}
            </div>
            <h1>
              {ticker}
              <Badge tone={scoreTone(row.astra_score ?? row.total_score)}>
                {row.tier || statusLabel(row.data_status)}
              </Badge>
            </h1>
          </div>
        </div>
        <div className="ticker-price">
          <strong>{usd(row.price)}</strong>
          <span className={sign(row.change)}>{pct(row.change)}</span>
          <small>{date(row.as_of)}</small>
        </div>
        <button
          className="button primary"
          onClick={() => onAnalyze(ticker)}
          disabled={!!busy}
        >
          <Icon name="star" size={17} />
          {busy === "analyze:" + ticker ? "統合分析中…" : "Commander分析"}
        </button>
      </div>
      <div className="detail-scores">
        {[
          ["Astra Score", row.astra_score ?? row.total_score],
          ["Technical", row.technical_score],
          ["Catalyst", row.catalyst_score],
          ["Theme", row.theme_score],
          ["Market", row.market_score],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <Score large value={value} />
          </div>
        ))}
      </div>
      <div className="detail-main">
        <Panel
          title="Price & Volume"
          kicker="MARKET STRUCTURE"
          actions={
            <div className="segment">
              <button
                className={frame === "daily" ? "active" : ""}
                onClick={() => setFrame("daily")}
              >
                日足
              </button>
              <button
                className={frame === "weekly" ? "active" : ""}
                onClick={() => setFrame("weekly")}
              >
                週足
              </button>
            </div>
          }
        >
          <PriceChart history={history} ticker={ticker} />
          <div className="indicator-grid">
            {[
              ["RSI14", fmt(current.rsi14, 1)],
              [
                "MACD",
                current.macd?.goldenCross
                  ? "GC"
                  : current.macd?.deadCross
                    ? "DC"
                    : current.macdTrend ||
                      current.macd_trend ||
                      fmt(current.macd?.histogram, 3),
              ],
              ["VWAP", usd(current.vwap)],
              [
                "RVOL",
                number(current.rvol20 ?? current.rvol) === null
                  ? "—"
                  : `${fmt(current.rvol20 ?? current.rvol, 1)}×`,
              ],
              ["EMA20", usd(current.ema20)],
              ["EMA50", usd(current.ema50)],
              ["EMA200", usd(current.ema200)],
              ["ATR14", fmt(current.atr14 ?? current.atr)],
            ].map(([label, value]) => (
              <KeyValue key={label} label={label} value={value} />
            ))}
          </div>
          <div className="panel-foot">
            {frame === "daily" ? "日足" : "週足"} ·
            履歴が足りない指標・未接続のVWAPは「—」で表示します。
          </div>
        </Panel>
        <Panel
          title="Trade Decision"
          kicker="COMMANDER → RISK"
          actions={
            <Badge tone={actionTone(commander.action || row.action)}>
              {actionLabel(commander.action || row.action)}
            </Badge>
          }
        >
          <div className="decision-content">
            <KeyValue label="Setup" value={commander.setup || row.setup} />
            <KeyValue
              label="Confidence"
              value={
                number(commander.confidence ?? row.confidence) === null
                  ? "—"
                  : `${fmt(commander.confidence ?? row.confidence, 0)}%`
              }
            />
            <KeyValue
              label="Entry"
              value={
                commander.entry
                  ? `${usd(commander.entry.min)} – ${usd(commander.entry.max)}`
                  : "—"
              }
            />
            <KeyValue label="Stop" value={usd(commander.stop)} />
            <KeyValue
              label="Targets"
              value={
                array(commander.targets).length
                  ? commander.targets.map(usd).join(" / ")
                  : "—"
              }
            />
            <KeyValue
              label="Risk / Reward"
              value={fmt(commander.risk_reward, 2)}
            />
            <KeyValue
              label="上限株数（AI案）"
              value={fmt(commander.position_size, 0)}
            />
            <div className="decision-reasons">
              {array(commander.reasons).length ? (
                commander.reasons.map((r, i) => (
                  <p key={i}>
                    <span /> {r}
                  </p>
                ))
              ) : (
                <p className="muted-text">有効な統合分析はまだありません。</p>
              )}
            </div>
            {riskFlags.length > 0 && (
              <div className="risk-flags">
                {[...new Set(riskFlags)].map((flag, i) => (
                  <span key={i}>
                    {typeof flag === "string"
                      ? flag
                      : flag.reason || flag.code || "リスク情報"}
                  </span>
                ))}
              </div>
            )}
            <button
              className="button primary full"
              disabled={!!busy || (killed && !["SELL", "STOP"].includes(decision.action)) || !shadowEligible(decision)}
              onClick={() => onShadow(decision)}
            >
              <Icon name="shield" size={16} />
              Shadowリスク審査へ
            </button>
            <p className="micro-copy">
              Risk
              Engineが株数を再計算します。AIの提案は発注指示ではありません。
            </p>
          </div>
        </Panel>
      </div>
      {ticker === "JMIA" && (
        <JmiaPanel
          data={row.jmia}
          action={commander.action || row.action}
          confidence={commander.confidence ?? row.confidence}
        />
      )}
      <div className="detail-lower">
        <Panel title="ニュース・Catalyst" kicker="MATERIAL EVIDENCE">
          <EvidenceList
            items={news}
            empty="ニュース接続または該当する記事がありません。"
          />
          <div className="catalyst-tags">
            {array(row.catalysts?.items || row.catalysts)
              .slice(0, 10)
              .map((c, i) => (
                <Badge
                  key={i}
                  tone={
                    c.sentiment === "positive"
                      ? "green"
                      : c.sentiment === "negative"
                        ? "red"
                        : "muted"
                  }
                >
                  {c.type || c.label || c.title || "Catalyst"}
                </Badge>
              ))}
          </div>
        </Panel>
        <Panel title="SEC・開示情報" kicker="PRIMARY SOURCES">
          <EvidenceList
            items={sec}
            empty="SEC/IR情報は未取得です。取得失敗を材料なしとは解釈しません。"
          />
        </Panel>
        <Panel title="過去の類似トレード" kicker="JOURNAL MEMORY">
          {array(row.similar_trades).length ? (
            <div className="similar-trades">
              {row.similar_trades.map((t, i) => (
                <div key={t.id || i}>
                  <strong>
                    {t.ticker} <small>{t.setup}</small>
                  </strong>
                  <span className={sign(t.profit_pct)}>
                    {pct(t.profit_pct)}
                  </span>
                  <small>{date(t.timestamp || t.entry_timestamp)}</small>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="比較できる記録はまだありません"
              text="Shadow Tradeの蓄積後、Setupと市場環境が近い過去取引を表示します。"
              icon="layers"
            />
          )}
        </Panel>
        <Panel title="構造と支持・抵抗" kicker="TECHNICAL CONTEXT">
          <div className="decision-content">
            <KeyValue
              label="サポート"
              value={usd(daily.low20 ?? daily.recentLow20 ?? daily.support)}
            />
            <KeyValue
              label="レジスタンス"
              value={usd(
                daily.high20 ?? daily.recentHigh20 ?? daily.resistance,
              )}
            />
            <KeyValue
              label="52週高値"
              value={usd(row.technical?.extended?.high52w ?? daily.high52w ?? daily.high_52w)}
            />
            <KeyValue
              label="52週安値"
              value={usd(row.technical?.extended?.low52w ?? daily.low52w ?? daily.low_52w)}
            />
            <KeyValue
              label="出来高"
              value={fmt(daily.volume ?? row.volume, 0)}
            />
            <KeyValue
              label="テーマ"
              value={
                row.theme?.name ||
                array(row.theme?.names).join(" / ") ||
                "未取得"
              }
            />
          </div>
        </Panel>
      </div>
    </>
  );
}
function PriceChart({ history, ticker }) {
  const bars = closeSeries(history).slice(-120);
  if (bars.length < 2)
    return (
      <Empty
        title="チャート履歴は未取得です"
        text="検証済みの日足・週足履歴が2本以上ある場合にチャートを表示します。"
        icon="chart"
      />
    );
  const w = 760,
    h = 240,
    left = 18,
    right = 62,
    top = 20,
    bottom = 40,
    lo = Math.min(...bars.map((b) => b.close)),
    hi = Math.max(...bars.map((b) => b.close)),
    spread = hi - lo || hi * 0.02,
    low = lo - spread * 0.08,
    high = hi + spread * 0.08;
  const x = (i) => left + (i / (bars.length - 1)) * (w - left - right),
    y = (v) => top + ((high - v) / (high - low)) * (h - top - bottom);
  const path = bars
    .map(
      (b, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(b.close).toFixed(2)}`,
    )
    .join(" ");
  const maxVolume = Math.max(1, ...bars.map((b) => b.volume || 0));
  const tone = bars.at(-1).close >= bars[0].close ? "#42d5aa" : "#ef858e";
  return (
    <div className="price-chart">
      <svg
        viewBox={`0 0 ${w} ${h + 65}`}
        role="img"
        aria-label={`${ticker} 終値と出来高チャート`}
      >
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity=".19" />
            <stop offset="100%" stopColor={tone} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const py = top + f * (h - top - bottom),
            price = high - f * (high - low);
          return (
            <g key={f}>
              <line
                x1={left}
                x2={w - right}
                y1={py}
                y2={py}
                stroke="#1e2a3b"
                strokeDasharray="3 5"
              />
              <text x={w - right + 12} y={py + 4} fill="#8a99ad" fontSize="11">
                {fmt(price)}
              </text>
            </g>
          );
        })}
        <path
          d={`${path} L${x(bars.length - 1)},${h - bottom} L${left},${h - bottom} Z`}
          fill="url(#chart-fill)"
        />
        <path
          d={path}
          fill="none"
          stroke={tone}
          strokeWidth="2.3"
          strokeLinejoin="round"
        />
        <circle
          cx={x(bars.length - 1)}
          cy={y(bars.at(-1).close)}
          r="4"
          fill={tone}
        />
        {bars.map(
          (b, i) =>
            b.volume !== null && (
              <rect
                key={i}
                x={x(i) - 2}
                y={h + 36 - (b.volume / maxVolume) * 35}
                width={Math.max(1, ((w - left - right) / bars.length) * 0.6)}
                height={(b.volume / maxVolume) * 35}
                fill={
                  i === 0 || b.close >= bars[i - 1].close
                    ? "#244d4b"
                    : "#553842"
                }
              />
            ),
        )}
        <text x={left} y={h + 60} fill="#8a99ad" fontSize="10">
          {String(bars[0].date || "").slice(0, 10)}
        </text>
        <text
          x={w - right}
          y={h + 60}
          textAnchor="end"
          fill="#8a99ad"
          fontSize="10"
        >
          {String(bars.at(-1).date || "").slice(0, 10)}
        </text>
      </svg>
    </div>
  );
}
function EvidenceList({ items, empty }) {
  return items.length ? (
    <div className="evidence-list">
      {items.slice(0, 12).map((n, i) => {
        const link = safeLink(n.url || n.link || n.document_url);
        return (
          <article key={n.id || i}>
            <div>
              <Badge
                tone={
                  n.sentiment === "positive"
                    ? "green"
                    : n.sentiment === "negative"
                      ? "red"
                      : "muted"
                }
              >
                {n.form || n.source || n.category || "NEWS"}
              </Badge>
              <time>
                {date(
                  n.timestamp || n.published_at || n.datetime || n.filing_date,
                )}
              </time>
            </div>
            {link ? (
              <a href={link} target="_blank" rel="noopener noreferrer">
                {n.headline || n.title || n.form || "開示情報"}{" "}
                <Icon name="arrow" size={12} />
              </a>
            ) : (
              <strong>{n.headline || n.title || n.form || "開示情報"}</strong>
            )}
            {n.summary && <p>{n.summary}</p>}
          </article>
        );
      })}
    </div>
  ) : (
    <Empty title="未取得" text={empty} icon="layers" />
  );
}
function JmiaPanel({ data, action, confidence }) {
  const d = data || {};
  const metrics = [
    ["Nigeria macro", d.nigeria_macro],
    ["USD / NGN", d.usd_ngn],
    ["Nigeria inflation", d.nigeria_inflation],
    ["Cash", d.cash],
    ["資金調達 / 希薄化", d.dilution],
    ["E-commerce", d.ecommerce],
    ["物流", d.logistics],
    ["JumiaPay", d.jumiapay],
    ["収益性", d.profitability],
    ["黒字化進捗", d.path_to_profitability],
  ];
  return (
    <Panel
      title="JMIA Priority Intelligence"
      kicker="AFRICA · COMMERCE · PAYMENTS"
      className="jmia-panel"
      actions={
        <Badge tone={actionTone(action)}>
          {actionLabel(action)}{" "}
          {number(confidence) !== null ? `${fmt(confidence, 0)}%` : ""}
        </Badge>
      }
    >
      <p className="jmia-summary">
        {d.summary ||
          "株価・技術指標に加え、Nigeriaのマクロ環境、資金繰り、希薄化、物流・決済の収益性を監視します。未接続の項目は推定しません。"}
      </p>
      <div className="jmia-metrics">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>
              {typeof value === "string"
                ? value
                : number(value) !== null
                  ? fmt(value)
                  : value?.summary || value?.value || "未取得"}
            </strong>
          </div>
        ))}
      </div>
      <div className="panel-foot">
        JMIA専用の分析支援です。推奨の実現・利益を保証するものではありません。
      </div>
    </Panel>
  );
}
function Settings({ data, dashboard, session, busy, onMutation, onLogout }) {
  const [reason, setReason] = useState(""),
    [reset, setReset] = useState("");
  const system = data.system || dashboard?.system || {},
    settings = data.settings || {},
    risk = data.risk || dashboard?.risk || {};
  const limits = risk.limits || {};
  const labels = {
    max_positions: "最大ポジション数",
    max_position_pct: "1銘柄の最大比率",
    max_risk_per_trade: "1取引の最大リスク",
    max_daily_loss: "1日最大損失",
    max_drawdown: "最大ドローダウン",
    max_consecutive_losses: "最大連続損失",
    max_spread_pct: "最大スプレッド比率",
    minimum_liquidity: "最低流動性",
    minimum_average_volume: "最低平均出来高",
    maximum_slippage_pct: "最大スリッページ比率",
    cooldown_seconds: "クールダウン（秒）",
    max_quote_age_seconds: "価格鮮度上限（秒）",
  };
  return (
    <>
      <div className="settings-grid">
        <Panel title="AI・データ接続" kicker="CONNECTIONS">
          <div className="decision-content">
            <KeyValue
              label="Commander"
              value={
                system.commander_model || settings.commander_model || "未設定"
              }
            />
            <KeyValue
              label="Agent Model"
              value={settings.agent_model || "未設定"}
            />
            <KeyValue
              label="OpenAI"
              value={
                <Badge tone={system.openai_configured ? "green" : "muted"}>
                  {system.openai_configured ? "設定済み" : "未設定"}
                </Badge>
              }
            />
            <KeyValue
              label="Market Data"
              value={
                settings.market_data_provider ||
                system.market_data_provider ||
                "Legacy Bridge"
              }
            />
            <KeyValue
              label="Database"
              value={
                typeof system.database === "string"
                  ? system.database
                  : system.database?.status || "状態未取得"
              }
            />
            <KeyValue label="Broker Mode" value={String(settings.mode || system.mode || "未取得").toUpperCase()} />
            <KeyValue label="Live Trading" value="OFF" />
            <KeyValue label="Manual Approval" value={onOff(settings.manual_approval ?? system.manual_approval)} />
            <p className="micro-copy">
              APIキー・モデル・運用制限はサーバーの環境変数で管理します。キーの値を画面には表示しません。
            </p>
          </div>
        </Panel>
        <Panel title="Risk Engine制限" kicker="DETERMINISTIC LIMITS">
          <div className="decision-content">
            {Object.keys(limits).length ? (
              Object.entries(limits)
                .filter(([, v]) => typeof v !== "object")
                .map(([key, value]) => (
                  <KeyValue
                    key={key}
                    label={labels[key] || key}
                    value={
                      typeof value === "boolean"
                        ? value
                          ? "ON"
                          : "OFF"
                        : String(value)
                    }
                  />
                ))
            ) : (
              <p className="muted-text">
                リスク制限を取得中、または未取得です。
              </p>
            )}
            <p className="micro-copy">
              これらの上限をCommanderが変更することはできません。
            </p>
          </div>
        </Panel>
        <Panel
          title="Kill Switch"
          kicker="HUMAN CONTROL"
          actions={
            <Badge tone={risk.kill_switch?.active ? "red" : "green"}>
              {risk.kill_switch?.active ? "作動中" : "待機"}
            </Badge>
          }
        >
          <div className="decision-content">
            {array(risk.kill_switch?.reasons).map((r, i) => (
              <p className="negative" key={i}>
                {typeof r === "string" ? r : r.reason || r.code}
              </p>
            ))}
            <label htmlFor="kill-reason">新規エントリーを停止する理由</label>
            <input
              id="kill-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              placeholder="例：価格データの確認が必要"
            />
            <button
              className="button danger full"
              disabled={!!busy || !reason.trim()}
              onClick={async () => {
                const r = await onMutation(
                  "/risk/kill",
                  { reason: reason.trim() },
                  "kill",
                  "新規エントリーを停止しました。",
                );
                if (r) setReason("");
              }}
            >
              <Icon name="shield" size={16} />
              新規エントリーを停止
            </button>
            <div className="risk-divider" />
            <label htmlFor="reset-ack">
              解除には「RESET KILL SWITCH」と入力
            </label>
            <input
              id="reset-ack"
              value={reset}
              onChange={(e) => setReset(e.target.value)}
              autoComplete="off"
              placeholder="RESET KILL SWITCH"
            />
            <button
              className="button full"
              disabled={
                !!busy ||
                reset !== "RESET KILL SWITCH" ||
                !risk.kill_switch?.active
              }
              onClick={async () => {
                const r = await onMutation(
                  "/risk/reset",
                  { acknowledgement: reset },
                  "reset",
                  "Kill Switchの解除操作を記録しました。",
                );
                if (r) setReset("");
              }}
            >
              確認して解除
            </button>
            <p className="micro-copy">
              解除しても各取引のRisk Engine審査は継続します。
            </p>
          </div>
        </Panel>
        <Panel title="ワークスペース" kicker="DATA & SESSION">
          <div className="decision-content">
            <KeyValue
              label="認証"
              value={session.authenticated ? "有効" : "未認証"}
            />
            <KeyValue label="セッション" value="HttpOnly Cookie" />
            <a className="button full" href="/api/astra/export">
              <Icon name="download" size={16} />
              Journal・分析データをJSON出力
            </a>
            <a className="button full" href="/">
              従来の米国株司令室を開く <Icon name="arrow" size={16} />
            </a>
            <button
              className="button full"
              disabled={!!busy}
              onClick={onLogout}
            >
              ログアウト
            </button>
            <p className="micro-copy">
              保有データの移行はポートフォリオ画面から行えます。
            </p>
          </div>
        </Panel>
      </div>
      <Panel
        title="Background Jobs & System Events"
        kicker="OBSERVABILITY"
        className="section-gap"
      >
        <div className="job-grid">
          {Object.entries(system.jobs || {}).map(([name, job]) => (
            <div key={name}>
              <strong>{name}</strong>
              <Badge tone={job?.status === "error" ? "red" : "muted"}>
                {typeof job === "boolean" ? (job ? "ON" : "OFF") : typeof job === "number" ? String(job) : statusLabel(typeof job === "string" ? job : job?.status)}
              </Badge>
              <small>{date(job?.last_run || job?.updated_at)}</small>
            </div>
          ))}
        </div>
        {array(data["system/events"]?.items).length ? (
          <div className="system-events">
            {data["system/events"].items.slice(0, 40).map((event, i) => (
              <div key={event.id || i}>
                <time>{date(event.timestamp)}</time>
                <Badge tone={event.level === "error" ? "red" : "muted"}>
                  {event.kind || event.type || event.event_type || event.level || "EVENT"}
                </Badge>
                <span>
                  {event.message ||
                    event.reason ||
                    event.ticker ||
                    "システムイベントを記録"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            title="システムイベントはまだありません"
            text="Signal発火・AI判断・リスク拒否・データ取得エラーなどを記録します。"
            icon="pulse"
          />
        )}
      </Panel>
    </>
  );
}
