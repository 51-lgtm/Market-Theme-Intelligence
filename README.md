# 米国株AI司令室 Astra v2

## 2026-11-08 類似テーマ比較と時間軸別の確認点

保有カードの追加詳細で、当日を除く直前20本の高安値と基準終値の距離を表示します。調整済み履歴上の参考線で、実注文の指値・利確・損切り、将来の目標株価ではありません。高値未満と高値更新を分け、取得失敗・古い値・不正な値幅では非表示にします。

同じリクエストで取得した保有・監視銘柄（最大20）のうち、既存の固定テーマ構成銘柄、および計算設備・マイニング関連の固定比較枠 IREN/CORZ/WULF/CIFR/HUT の共通グループを比較します。固定テーマは厳密な同業分類ではありません。比較相手の自動追加や別APIへの取得は行いません。比較相手がリストにない場合は未取得として除外します。

`explicit-group-aligned-daily-peers-v1` は非レバレッジ性が確認できたUSDの調整済み日足を対象に、同じ21終値（20本騰落率）の完全な日付一致、指標基準日の一致、4暦日以内の鮮度を要求します。20本騰落率、RSI14、MACD12/26/9ヒストグラムの終値比、20日次リターンのPearson相関を表示します。対象銘柄を除いた比較相手が2以上のときだけ中央値と差（パーセントポイント）を表示します。相関は形状の将来予測ではなく同時期の連動性です。定数系列では未算出、欠測は補完しません。全市場ランキング・勝率・予想株価にはしません。

長期欄は強気側へ見直す条件・反証・確認待ちを分けた検証チェックリストです。Finnhub補助指標は取得できた場合だけ一次資料未照合の情報として別表示し、TTMと四半期の売上成長率を混同しません。取得時刻を決算の対象日や発表日時へ代用しません。SEC/会社IRによる営業キャッシュフロー・設備投資・希薄化・評価倍率の一次確認と長期価格シナリオは未完成です。

## 2026-11-07 保有判断の読みやすさ

保有カードは、指標一覧より先に「今の値動きの整理」「理由」「見方が変わる条件」を短い日本語で示します。これは確認できた日足・完成週足の記述で、売買指示や将来の利益予測ではありません。短期は検証可能な過去局面の分布、長期は業績など未接続の根拠を区別し、データ不足では方向を断定しません。リスク計算の専門用語も意味を説明し、式・細かい値は詳細に残します。

画面上の版表示と「版を確認」で、開いたままの古い画面を識別できます。公開版の確認は個人情報や市場データを含まない `/app-release.json` のみを読みます。「新版を表示」は未保存入力の注意を確認した場合だけ再読み込みし、保存済みの保有・設定を削除しません。更新を検出しても自動でページを書き換えません。端末のサイトデータ削除は不要です。

## 2026-11-07 保有画面・過去類似局面の更新

「保有」は銘柄別テクニカルを優先表示します。日足・完成週足の方向、RSI14、MACDヒストグラム、EMA20/50/200、RVOL20と基準日を並べ、詳細な資産・リスク説明は下部で開閉できます。要確認事項は折りたたみの外に残します。価格観測日時とデータ取得日時、前日比と取得来損益を区別します。

- 「分析を更新」は既存の分析APIを使う明示操作です。最大20銘柄、保有銘柄を優先し、追加の常時収集は行いません。
- 調整済み価格・鮮度・完成週を確認できない場合は指標を確定表示しません。欠測は0や中立に置き換えません。支持候補は既存計算の参考水準で、抵抗帯・出来高実数・短期足など未接続の項目は未取得と明記します。
- 既存の損切・利確はユーザーの設定値です。固定のSIMULATE利確規則を、過去分析に基づく目標価格として使いません。

### 過去の似た日足状態

同一銘柄の調整済み日足履歴を用いた記述的比較です。将来予測、類似企業比較、売買推奨、目標価格ではありません。

方式 `same-symbol-daily-state-v1` は、EMA20 > EMA50の真偽、RSI帯（30・45・55・70で区切る）、ATR14/終値比が現在の2/3〜1.5倍という固定条件を使います。200本のウォームアップ後、20本の比較窓と20本先までの観測区間が互いにも現在の比較窓にも重ならない過去局面を、古い順に採用します。候補選択に将来リターンを使用しません。

5・10・20取引足本後の調整終値変化率を `100 × (その後の終値 / 基準日の終値 − 1)` で計算し、中央値と25–75%範囲を示します。分位点は `(n − 1) × p` の線形補間です。期間重複を除いた採用件数が8未満の場合、集計と各候補リターンを表示しません。8件は保守的な表示基準であり、統計的な妥当性の保証ではありません。

取得失敗・古いキャッシュ・不正または欠測OHLC・未調整/混在価格・未確定足・未来日付・7暦日超の取引足間隔などでは比較を停止します。元の履歴取得日時は計算日時と分け、未確認なら代用しません。期間、採用日、方式版、入力識別子を示し、取引所カレンダー未照合のため「営業日後」と断定しません。四分位範囲は過去観測の散らばりで、将来の信頼区間ではありません。期間の重複がなくても独立標本ではなく、企業行動による過去値改訂・現在存続する銘柄への偏り・市場環境の変化が残ります。

長期の業績ドライバー・希薄化・評価倍率の検証済みデータは未接続です。チャートだけから長期上値、成功率、目標株価を出しません。

## 2026-11-07 テクニカル表示の更新

旧画面の「買い」銘柄カードと Astra の銘柄詳細に、8時間軸の見やすいサマリーを追加しました。5分・15分・30分・1時間・5時間足・日間・週単位・月単位を並べ、買い方向は赤／ピンク、売り方向は緑で表示します。「追加のテクニカル分析」で計算条件と根拠を開閉できます。

これは表示専用の方向集約です。既存の買い候補判定、Astra Score、リスク審査、注文処理へは接続していません。参考画像と同じデータ配信元や判定式ではありません。

- 現在の実データ経路で対応するのは日足・週足です。分足・時間足・月足は「未取得」と表示し、日足を代用しません。
- 有効な RSI14・MACDヒストグラム・価格・EMA20・EMA50と、各時間足の基準日時が揃った場合だけ集約します。欠損、非有限値、矛盾した日時、古いデータは判定しません。
- RSIは55〜70を+1、30〜45を−1、その他を0。MACDはヒストグラムの正負、EMAは価格・20・50が整列した方向を各±1とし、それ以外を0。合計±3は強い買い／売り、±2は買い／売り、その他は中立です。
- データ鮮度は日足4暦日・週足14暦日を保守的な上限とします。リアルタイムや最新営業日照合の保証ではありません。
- スマートフォン向けにカード幅に合わせて文字サイズを調整し、詳細はキーボードでも開閉できます。


既存ULTRA v14を残し、React・FastAPI・SQLiteによる分析／仮想取引レイヤーを追加した個人向け研究用司令室です。**実注文を送信する機能はありません。** スコア・Confidenceは勝率や利益を保証しません。

市場データ取得、決定論的Agent、リスク審査、仮想約定・記録のコードを実装しました。OpenAIの実アカウント接続、証券会社Paper接続、長期間の運用成績は未検証です。無料価格だけではbid/ask・独立2社照合などの条件を満たせない場合があり、その場合はShadowも拒否します。

## 調査結果と互換性

| 項目 | 調査・対応 |
| --- | --- |
| GitHub | `51-lgtm/Market-Theme-Intelligence` mainは調査時v13。作業フォルダはv14で、新しい既存機能を保持 |
| Frontend | 既存は単一`index.html` PWA。旧画面を維持しReactを`/astra/`へ追加 |
| Backend | 既存Express `server.js`をloopbackのデータサービスとして再利用。FastAPIを公開入口へ追加 |
| データ取得 | Finnhub / Yahoo Spark・Chart / Nasdaq、為替Yahoo・ECB。既存キャッシュ・制限を再利用 |
| 履歴 | 従来5年OHLCVはメモリ。今回SQLiteへ最新履歴・指標スナップショットも保存 |
| スコア | 既存日足45・週足20・テーマ15・材料20と減点を維持。別にAgent統合Astra Score |
| DB・認証 | 既存はlocalStorage。今回SQLite・単一管理者JWT・HttpOnly Cookie・CSRFを追加 |
| Broker | moomoo/OpenDや証券会社注文接続は既存に存在せず。Shadow追加、Paper/Liveは未接続／禁止 |

50テーマ、RRG型マップ、VIX/WTI・為替同期、買いシグナル、バックテストなどの従来説明は[旧README](docs/LEGACY_V14.md)へ保存しました。全面書換えでなく追加型の構成です。

`riskScore` / `optimismScore`はヒューリスティックな補助指数であり、暴落確率・上昇確率・期待リターンではありません。

## Architecture

```text
React /astra/ → FastAPI /api/astra/* → 認証・CSRF
                                     ↓
旧PWA / → proxy → Node v14 providers → Market / News / SEC evidence
                                     ↓
Technical / Catalyst / Market / Theme / Portfolio → Scanner / Signals
                                     ↓ 新規イベント
                          Astra Commander (strict JSON)
                                     ↓ Broker toolなし
                          Python Risk Engine (独立拒否権)
                                     ↓
                          ShadowBroker → Journal / Analytics
                                     ↓
                          類似トレード → 次回Commander分析
```

新APIは`/api/astra/`に隔離。既存`/api/quotes`、`/api/market-regime`、`/api/buy-signals`、JSON出力との衝突を回避しています。`/api/astra-evidence`はNode内部専用で、公開FastAPIでは404です。

## Setup / Start frontend / Start backend

Node.js 22.14以上25未満、Python 3.12を使用。Windows PowerShell：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt -c requirements-lock.txt
npm ci
npm --prefix frontend ci
npm --prefix frontend run build
Copy-Item .env.example .env
```

既存`.env`がある場合は上書きせず不足項目だけ追加。`ASTRA_ADMIN_PASSWORD`は12文字以上、`ASTRA_JWT_SECRET`は32文字以上の固有ランダム値を設定してください。生成例：`python -c "import secrets; print(secrets.token_urlsafe(48))"`。秘密値をGitHubへ入れないでください。

ローカルHTTPだけ`COOKIE_SECURE=false`、公開HTTPSでは必ず`true`。

```powershell
.venv\Scripts\python.exe run_astra.py
```

新画面`http://127.0.0.1:8000/astra/`、従来画面`http://127.0.0.1:8000/`。スマホはHTTPSデプロイ後の同じURLから使用できます。従来localStorage保有は端末ごとで、自動共有されません。管理者認証後、分析用としてサーバーへ取り込んだ保有情報を参照します。

開発時は個別起動も可能：

```powershell
# ターミナル1
$env:PORT="10000"
$env:HOST="127.0.0.1"
node server.js
# ターミナル2
.venv\Scripts\python.exe -m uvicorn astra.app:create_app --factory --host 127.0.0.1 --port 8000
# ターミナル3
npm --prefix frontend run dev
```

React開発URLは`http://127.0.0.1:5173/astra/`。同一Originプロキシを利用し、ワイルドカードCORSは不要。失効セッション管理がプロセス内にあるため**Uvicornは1 worker**で運用します。旧版だけなら従来どおり`npm start`、新Reactは統合起動が必要です。

## Environment Variables

すべての値は[.env.example](.env.example)に整理。鍵のない連携先は未接続です。

| 変数 | 用途・既定 |
| --- | --- |
| `ASTRA_ADMIN_PASSWORD`, `ASTRA_JWT_SECRET` | 管理者認証、署名。未設定ならログイン不可 |
| `COOKIE_SECURE` | 公開はtrue。CookieはHttpOnly・SameSite=Strict、8時間 |
| `OPENAI_API_KEY` | サーバーのみのOpenAIキー |
| `OPENAI_COMMANDER_MODEL` | 既定`gpt-6-astra`。モデル名は環境変数で変更 |
| `OPENAI_AGENT_MODEL` | 任意のニュース解釈モデル。空欄なら追加LLM呼出なし |
| `OPENAI_MAX_CALLS_PER_DAY/RUN` | 20/日・3/更新。失敗も消費として計数 |
| `FINNHUB_API_KEY`, `API_TOKEN` | 既存株価・ニュース連携。キー使用時は従来API_TOKEN認証も必要 |
| `ALPHA_VANTAGE_API_KEY` | 欠落価格の低頻度EODフォールバック。ライブ価格に昇格しない |
| `SEC_USER_AGENT` | 組織名・連絡先。設定時のみSECメタデータ取得 |
| `ASTRA_UNIVERSE` | 既定16、最大100銘柄。全米株市場の網羅スキャナーではない |
| `ASTRA_REFRESH_SECONDS`, `ASTRA_BACKGROUND_JOBS` | 稼働中の定期更新。既定900秒、有効 |
| `ASTRA_DATABASE_PATH` | 既定`data/astra.sqlite3` |
| `SHADOW_INITIAL_CASH_USD` | 新規DB作成時の仮想USD資金。既定100,000 |

未実装のNEWS_API_KEYやBroker秘密鍵を「接続済み」と誤認させる設定はありません。ニュースは既存Finnhubを再利用。Astraの口座管理はUSD、従来版の円換算管理は維持します。

## OpenAI setup / Astra Agent構成

[Responses API Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)に従い、`strict:true`、全項目必須・追加項目禁止、Pydantic再検証、`should_execute`はbooleanのfalseだけに制限します。refusal・incomplete・不正JSON・非有限数・銘柄不一致は拒否。OpenAI Docsスキルで確認した仕様を実装へ反映しました。

モデルは[GPT-6 Astra公式情報](https://developers.openai.com/api/docs/models/gpt-6-astra)を参照。キー設定だけでは権限・残高・実応答成功は保証されず、UIも「設定済み」とだけ表示します。

| Agent | 担当 |
| --- | --- |
| Technical | 日足・週足RSI/MACD/EMA/ATR/RVOLを再利用、SMA/Bollinger/gap/52週高安/breakout追加 |
| Catalyst | 現在ニュース・決算フラグ・SECの分類。URL/見出し/SEC accessionで重複排除 |
| Market | 既存VIX/WTI/SPYを5段階レジームへ変換。QQQ/IWM/BTC/米10年金利/USDを補助表示 |
| Theme | AI、AIサーバー、半導体、メモリ、電力、Bitcoin、miners、量子、宇宙、原子力、DC、Robotics |
| Scanner | 複数Agentとregime補正ウェイトでランキング。不足成分を除外再正規化して水増ししない |
| Portfolio | 取得単価・保有数・STOP・材料・過熱からBUY_MORE/HOLD/TRIM/SELL/STOPの分析支援 |
| Risk | LLMから独立した決定論的Python。最終拒否権を保持 |

通常Astra ScoreはTechnical25/Catalyst25/Theme15/Market15/Momentum10/RR10%。risk-offは市場・RR比重を増加。既存買いシグナルスコアとは別指標です。Themeの24h/7dは保存スコアの**ポイント差**でリターン%ではありません。比較履歴がない間はnull。Bitcoin/minersは関連銘柄カタログ実装済みですが、同じバスケットの測定データがないためスコアはnullです。

## Market data / Signal Engine / AI cost

無料・best-effort経路を使用。データの表示・再配布権は各提供者の契約で別途確認してください。Flowは価格による推定ローテーションで、実測資金流入額ではありません。履歴不足はpartial/unavailable、価格観測時刻と取得時刻を分離。本物のintraday VWAPや出来高プロファイルを日足から捏造しません。週足チャートはNYSE完成週のみです。

RVOL・価格変化・MACD・RSI・breakout・52週高値・ニュース・SEC・決算・テーマ変化・STOP接近を検知。同じ営業日・同じ材料を永続IDで重複抑止します。自動分析は新規イベント中心、同一証拠・モデルを15分キャッシュ。下位Agentは基本Pythonで、任意のニュースLLM分類は別キャッシュ。全銘柄を常時Astraへ送信しません。

SECは提出フォームと日時などを取得し、フォーム名だけで好決算や希薄化を断定しません。[SEC fair-access方針](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)を踏まえ4req/s以下。IR本文、Nigeriaインフレ、USD/NGN、JumiaPay業績など未接続項目はJMIA画面で未取得です。

## Risk Engine / Kill Switch

既定：最大5ポジション、1銘柄20%、1取引リスク1%、日次損失3%、口座DD10%、連敗5。spread0.5%、平均出来高10万、価格×平均出来高100万USD、slippage0.5%、2社価格乖離0.5%、鮮度120秒、cooldown900秒、RR最低1.8。環境変数の比率は`0.01=1%`です。

株数は`許容損失 / (entry上限 - STOP)`を基本に現金・集中・提案株数・手数料で制限。confidence/regimeで0.25R/0.5R/1Rまで縮小し、1Rを超えません。LLMに設定変更権限はありません。

NYSE祝日/短縮取引、古い価格、無効数値、口座評価不足、provider不一致、API/Broker異常、過大spread、重複、日次損失/DD/連敗を検査。RSI80以上・5日25%以上・決算3営業日以内・レバレッジ/商品不明も買い不可。通常株STOP距離10%を上限とします。

重大異常はDBにKillを保存。解除は管理者認証＋CSRF＋`RESET KILL SWITCH`明示入力のみ。LLMには解除経路がありません。Killは新規を停止し、検証済み価格による仮想STOP・既存決済を妨げません。DB自体を失えばKill状態も失われるため永続化が必要です。

## Shadow Trading / Trade Journal

保存済みCommander判断から「Shadowリスク審査へ」を実行。BUYは仮想エントリー、SELL/STOPは一致する既存仮想ポジションの全決済を安全確認後に記録します。TRIMの部分決済は未実装。ブラウザの任意価格・株数・自由文を発注指示にしません。分析中/分析後に市場証拠や保有が変われば再分析が必要です。

`PENDING → FILLED / REJECTED`をSQLiteトランザクション、idempotency key、UNIQUE制約で処理。シグナル価格では約定せず、**注文後の新しい観測ask＋slippage**で約定。entry範囲外・審査拒否・15分失効なら予約資金を返却。既定片道commission1bps/slippage2bpsで、ShadowBroker生成時に設定できます。

entry時のRSI/MACD/VWAP/ATR/RVOL/出来高・Agentスコア・regime・setup・材料・理由・STOP/targetsと、exit時の損益・保有期間を記録。MFE/MAEは観測価格のみ。+1/3/5/10/20 **NYSE営業日**の最初の観測を保存し、欠測を後日補完しません。

100〜300件以上を蓄積できるDBですが架空取引は初期投入しません。無料価格だけで独立2社・bid/ask等が揃わなければ約定0件となります。無料サービスで常時・高精度追跡を保証しません。

## Strategy Analytics / Backtest

CLOSEDのSetup別件数、勝率、平均利益/損失、期待値、PF、DD、Sharpe、平均保有期間、MFE/MAEを計算。損失ゼロPFはnull。DDは初期資金固定の実現損益曲線、Sharpeは非年率・取引単位・無リスク金利0。30件未満は少数標本表示。銘柄・Setup・指標による類似比較で欠損を完全一致扱いしません。

旧バックテストA〜Eを維持。Astra完成戦略の2年以上のpoint-in-time検証は未完成で、当時のニュース/テーマ/決算予定の履歴が必要です。完成版Fの成績を捏造していません。パラメータの自動最適化やモデル自動再学習は未実装です。

## Paper / Live

BrokerInterface、ShadowBroker、PaperBroker、LiveBrokerを分離。Paperは未接続、Liveは注文ネットワークコードを持ちません。

```dotenv
BROKER_MODE=shadow
AUTO_TRADE=false
LIVE_TRADING=false
MANUAL_APPROVAL=true
SHADOW_TRADING=true
PAPER_TRADING=false
```

`LIVE_TRADING=true`や`AUTO_TRADE=true`は起動拒否。**フラグだけでLiveにできません。** sandbox接続、約定照合、取消/部分約定、時刻同期、リスク監査、長期検証、手動承認、障害復旧訓練後の別工程です。

## Database / Backup

SQLite WAL・パラメータ化SQL・追加migration v2。既存localStorageを破壊せず、保有取込は分析用だけです。Shadow口座と実保有を混ぜません。実保有の証券会社実現損益は未接続ならnull。

positions/trades/trade_events/shadow_trades/signals/technical_snapshots/technical_history/market_histories/news/themes/theme_scores/ai_decisions/agent_outputs/market_regimes/risk_events/orders/executions/system_events等を保存。拡張用テーブルの存在はマルチユーザー機能完成を意味しません。

復元分析はstaleで、更新前のBUYに利用不可。market_historiesは最新取得の最大5年OHLCV、technical_historyは銘柄・観測日単位。JSON exportは鍵を含まず各テーブル最大10,000件。完全復旧にはSQLite online backupを利用してください。稼働中にDB本体だけコピーするとWALを逃す可能性があります。汎用JSON restoreは未実装です。

## API / Security / Observability

`POST /api/astra/auth/login`、`GET /auth/session`。変更系はセッションのCSRFを`X-CSRF-Token`へ設定。

GET：dashboard/market/scanner/signals/themes/portfolio/ticker/{ticker}/commander/ai/shadow/trades/trade-events/strategies/risk/orders/system/settings/system/events/export/schema。

POST：refresh/portfolio/import/commander/analyze/shadow/shadow/{trade_id}/close/risk/kill/risk/reset。POST ordersは常に403。SSE `/events`は更新通知で、Tick配信・注文命令ではありません。

JWT issuer/audience/期限検査、HttpOnly Secure Strict Cookie、CSRF/Origin、256KiB入力制限、型検証、レート制限、CSP、Reactエスケープ、URL検査、SQL識別子allowlist。鍵はfrontendに出さず、外部記事を命令として扱わず、Commanderにbroker toolを渡しません。

signal/AI/risk rejected/仮想order/execution/kill/API errorを記録。例外ログ・応答に鍵やAuthorizationを出しません。市場GETのみ制限付きbackoff/retry。OpenAI失敗は注文なしで処理し、注文系を危険に自動retryしません。設定画面にSystem Healthを表示。

単一所有者用で、マルチテナントSaaS認可はありません。旧PWAのlocalStorage設定は別のセキュリティモデルです。共用端末・同じ管理者パスワードの不特定多数配布を避けてください。

## Testing

```powershell
npm run check
.venv\Scripts\python.exe -m pytest tests_astra -q
npm --prefix frontend test
npm --prefix frontend run build
.venv\Scripts\python.exe -m pip check
```

ブラウザはPlaywrightを別途用意し`node scripts/ui-smoke.cjs`。インストール済みパスをPLAYWRIGHT_MODULE、Linux等のPythonをASTRA_PYTHONで指定可能。一時DB・ランダム認証・AIキーなしで実市場更新、各画面、390pxスマホ、console、旧画面proxyを確認し、`artifacts/`へ保存します。単体テストfixtureを実画面・本番DBに混ぜません。

## Deployment / Render

新AstraはPython+Nodeのため**Docker runtime**です。既存render.yamlは旧Node用のまま。新サービスは[render-astra.yaml](render-astra.yaml)とルートDockerfileを使用。Rubyでは動きません。

1. astra/、frontend/、scripts/、Dockerfile、requirements、従来ファイルを階層ごとGitHubへ配置。ZIPそのものを置くだけでは動きません。
2. 新Web ServiceをDocker、Root Directoryはルート、Dockerfile `./Dockerfile`、health check `/healthz`で作成。
3. Renderに管理者password/JWT secret、COOKIE_SECURE=trueを設定。OpenAIキーは任意。
4. `https://サービス名.onrender.com/astra/`へアクセス。従来画面は`/`。

HTTPSログインとCSRFのOrigin確認には、Renderが自動設定する`RENDER_EXTERNAL_URL`を使用します。独自ドメインを使う場合だけ`ASTRA_PUBLIC_ORIGIN=https://公開ドメイン`を指定してください（パス・認証情報・query・fragmentは不可）。ローカルでは両方未設定のまま、実際のリクエストOriginと照合します。転送されたIPヘッダーを全信頼する設定への変更は不要です。[Render標準環境変数](https://render.com/docs/environment-variables)

無料Renderは15分無通信で休止し、休止/再起動/再デプロイでSQLiteを失います。無料Web Serviceに永続ディスクはありません。**無料版はプレビュー向けで、Journal/Kill/継続観測の長期保存に不適切です。** [Render無料枠公式制限](https://render.com/docs/free)

継続検証には永続ディスクの保存領域をASTRA_DATABASE_PATHへ指定するか、外部DB adapterの別途実装が必要です。外部DB移行は未実装。停止回避keepaliveは組み込んでいません。OpenAI料金はRender無料枠とは別です。

## 未完成部分と次の工程

P0の安全なShadow閉ループ基盤、P1決定論的Agent、P2主要画面を実装しました。Broker sandbox、真正なbid/ask・独立2社データ契約、長期Shadow蓄積、完成版point-in-timeバックテスト、Nigeria/IR詳細、Live、マルチユーザー、外部DBは未完成です。mockで接続済みと表示しません。実資金を扱う前に独立レビューと利用者自身の判断が必要です。

検証件数、修正した安全性問題、未検証事項は[最終レビュー](docs/FINAL_REVIEW.md)を参照してください。配布ZIPはPowerShell 7で`./scripts/package-release.ps1`を実行して生成できます。


### Local proposal: risk context / official announcements (2026-10-30)

`GET /api/official-risk-news` adds Federal Reserve monetary-policy RSS titles,
publication times and original links, separately from the daily risk heuristic.
No sentiment score, price feed, AI-generated story or order integration is added.
Source: https://www.federalreserve.gov/feeds/feeds.htm . The Board's public-domain
redistribution/attribution policy: https://www.federalreserve.gov/disclaimer.htm .
The original English title and agency attribution are preserved; no photos/logos
or third-party articles are copied. No key or paid API is required. This limited
feed is not breaking market-news coverage. The module uses a fixed URL, timeout,
body cap, deduplication and validated Fed HTTPS links. Cache is 15 minutes; errors
retain explicitly stale data for at most 7 days, not a newly timestamped result.

Risk values and quote-provider permissions are not newly validated by this change.
Yahoo's unofficial endpoint availability is NOT evidence of public redistribution
permission; public rollout still needs a source/rights review. The existing rule
weights are unchanged and uncalibrated, not crash probabilities or win rates.

`calendarVerified:false` and `latestSessionVerified:false` explicitly expose that
matching received SPY/VIX/WTI session dates do not prove the latest exchange
session. No live open/closed state is fabricated. JST/ET clock and acquisition
time are separate from the US session date. Holidays, early closes, simultaneous
source delays and intraday developments remain limitations. Exact exchange-
calendar verification and licensed live data are not implemented in this patch.

Focused checks: `node --test test/risk-context.test.js test/official-risk-news.test.js test/official-risk-news-route.test.js`.
