# 米国株司令室 ULTRA v13.0

Render の無料 Web Service で動く、個人向けの米国株ポートフォリオ／リスク管理 PWA です。取得品質、損失レンジ、参考株数、STOPリスク、複合ストレス、端末内復旧に加え、50テーマの相対強度と推定ローテーションを一画面で管理します。

## v13.0 MARKET THEME INTELLIGENCE ENGINE

- 指定された50テーマを8グループで固定管理し、ランキング、ローテーション上向き／下向き、NEXT監視候補、テーマ間ネットワークを切り替えられます
- テーマを選ぶと、Score、推定ローテーション指数、速度、加速度、breadth、momentum、volatility、証拠品質、親子テーマ、関連ETF／銘柄、30営業日推移を確認できます
- 灰色の破線はテーマ間の固定カタログ構造だけを示し、強度、lag、因果、資金量を持ちません。時系列分割の検証を通過した動的edgeだけを別色・太さで表示し、テーマノード側の緑・黄・赤で推定ローテーション方向を区別します。いずれも観測された現金移動ではありません
- NEXTはデータ鮮度、構成銘柄coverage、履歴量、証拠品質、速度、加速度、breadthを通過したテーマだけを「監視候補」として表示します。自動発注は行いません
- AI分析には、取得できた数値、欠測、推定方法、親子関係、候補根拠を渡します。実測していない出来高、ニュース、時価総額、資金額をAIに推測させません
- ニュース接続や時価総額データがない場合は `null`／未接続と返し、架空のスコアで埋めません

### 「Flow」の意味

この版の標準データ経路では、注文、約定方向、ファンドフロー、過去出来高を取得していません。画面上のFlow系表示は、確定済み調整後終値の相対強度とテーマ内の上昇銘柄比率から算出した**推定ローテーション指数**です。通貨額ではなく、実際の資金流入・流出を観測した値でもありません。APIは `actualFundFlow: false`、`volumeUsed: false` と推定方法を返します。Score 50は同日の対象テーマ群の中央値付近を意味し、「資金中立」を意味しません。Confidenceは予測的中確率ではなく証拠品質です。テーマは現在の固定バスケットを過去へ当てた等ウェイト参考値で、銘柄重複があるためテーマ同士は独立ではなく、構成入替前の状態も再現しません。

## 人に渡す前の確認

知人へソース一式を私的に渡し、各自が自分のRenderへデプロイすることは技術的には可能です。ただし、次を満たしただけで法的・契約上の利用許可まで保証されるものではありません。

1. `.env`、APIキー、`API_TOKEN`、GitHubトークン、保有データを書き出したJSONを配布物へ入れないでください。このリポジトリは `.env` を無視し、`.env.example` には空欄だけを置いています。APIキーは各自で取得し、RenderのSecret環境変数へ保存してください（[AnthropicのAPIキー安全ガイド](https://support.claude.com/en/articles/9767949-api-key-best-practices-keeping-your-keys-safe-and-secure)）。
2. 受取人には自分のAPIキーと長い固有の `API_TOKEN` を設定してもらってください。1つの公開Render URLと共通トークンを不特定多数へ配る運用は、枠・課金・保有情報の安全面から非推奨です。
3. 価格データの再表示・再配布条件をデータ提供者へ確認してください。[Finnhubの料金・利用区分](https://finnhub.io/pricing-stock-api-market-data)では個人向けプランがPersonal Use表記です。`FINNHUB_API_KEY` を設定してもテーマ履歴はYahoo Sparkを使用します。Yahooの無保証エンドポイントを利用する構成は、公開・商用・再配布用途の権利を意味しません（[Yahoo利用規約](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html?ncid=mbr_idnedulnk00000001)、[Yahoo API利用条件](https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apitnc/index.html)）。公開配布や商用提供では、用途に合う表示・再配布ライセンスを持つデータ契約へ差し替えてください。
4. `package.json` は現在 `UNLICENSED` です。第三者へ改変・再配布を認めるなら、MIT、私的利用限定、商用ライセンスなど、意図に合うソフトウェアライセンスを所有者が明示してください。
5. これは情報整理・監視用で、投資助言、将来成績の保証、注文執行システムではありません。利用者自身の判断と責任で使用してください。
6. 保有情報、APIトークン、GitHubトークン、クラウド合言葉は利用端末の `localStorage` に保存されます。共有端末や信頼できないブラウザー拡張では使わず、端末ロックを有効にしてください。AI直結を実行すると、画面に示す分析コンテキスト（保有、取得単価、ルール、テーマ証拠）が設定したAI提供者へ送信されます。受取人へ事前に説明し、各提供者のプライバシー条件を確認してください。

## v12.1 MARKET THEME TRACKER

- 市場タブへ、10テーマと主要50銘柄の実測ランキングを追加。`1D`、`5D`、`1M`、`1Y`を切り替えて比較できます
- テーマ行をタップすると、主要5銘柄それぞれの4期間パフォーマンス、基準日、coverage、データ状態を展開します
- 1D／5Dは取引セッション、1M／1Yは暦基準日以前の直近取引日を使用し、相場中の未確定日足はランキングから除外します
- 調整後終値を優先し、取得不能、部分取得、raw終値フォールバック、古い正常キャッシュを明示します
- 4期間を1回で取得し、切替や展開では再通信しません。15分キャッシュ、同時取得共有、Yahooの20銘柄単位バッチで無料Renderの負荷を抑えます
- テーマ詳細の「このテーマをAI分析」から、実測4期間、主要銘柄、breadth、基準日だけを根拠にテーマ別分析を生成できます。AI分析は実測値と分離して保存します
- 過去成績は将来の結果を保証せず、テーマ内の相関・集中リスクがあることを画面に常時表示します

## v12.0.1 Renderアップロード修正

- `market-data.js` をルート直下へ配置し、GitHubの「Add files via upload」でフォルダを選び忘れても `MODULE_NOT_FOUND` にならない構成へ変更
- Renderのビルドは `server.js` とルート直下の `market-data.js` を検査します。`lib` フォルダは不要です
- 配布ZIPは全ファイルが直下にあります。展開後のファイルをすべてGitHubリポジトリのルートへアップロードしてください
- GitHub上で `server.js`、`market-data.js`、`package.json`、`package-lock.json`、`index.html` が同じ階層に見えることを確認してからRenderを再デプロイします

## v12 の追加進化

- `RISK ENGINE 95` を追加。最大61終値から1日ヒストリカルVaR 95%、Expected Shortfall、年率ボラティリティ、SPYベータを計算
- `TRADE GATE` を追加。既存open risk、利用可能現金、最大保有比率、STOP距離、ギャップ余裕を同時に満たす参考株数を表示
- `DATA SENTINEL` を追加。価格基準時刻・取得時刻・キャッシュ時刻を分離し、live、前日終値、参考、遅延、未検証、stale、取得不能を区別
- FinnhubとYahooの価格を、通貨・市場セッション・観測時刻が比較可能な場合だけ照合し、大きな価格差を警告
- USD/JPYの最大66終値を返し、履歴が十分な場合は株式と為替を組み合わせた円換算リスクを計測
- `AUTO RECOVERY` を追加。変更前の端末内5世代、取込前固定点、主保存破損時の自動復帰、保存後の読戻し検証に対応
- 別タブの価格同期と株数・STOP編集を3方向マージし、異なる項目の同時更新を両方保持
- JSON取込がAPI接続先、APIトークン、GitHubトークン、合言葉、Gist IDを書き換えないよう防御
- 非USD銘柄をUSDとして誤換算せず、対応レートがない場合はNAV・Stress・Risk・Trade Gateを明示停止
- 市場観測日を履歴キーにして、土日の同期で同じ終値を別日実績として重複計上しない

### v12 の使い方

1. 再デプロイ前に「記録」からJSONを書き出します。v12起動後は同じRender URLなら従来の端末内データを引き継ぎます。
2. 「保有」で株数、平均取得、価格通貨、数値STOPを確認し、右上の同期を実行します。
3. `PORTFOLIO X-RAY` と `RISK ENGINE 95` で、構成、既知／未知STOPリスク、履歴カバー率、損失分布を確認します。
4. `TRADE GATE` へエントリー価格、STOP、総許容損失、最大比率を入力します。LIVE条件を満たさない場合は評価用と表示されます。
5. 「記録 → DATA CONNECTION」でlive／終値／参考／未検証／provider差とTRACE IDを確認できます。
6. 「記録 → 端末内復旧」から最大5世代の状態へ戻せます。別端末向けにはJSONまたは暗号化クラウド保存を併用してください。

## v11 で追加したこと

- PORTFOLIO X-RAYで保有比率、集中度、損切り発動時の予定損失、データ品質を一画面化
- 株価ショックとUSD/JPYショックを組み合わせるSTRESS LABを追加し、円換算純資産への影響を即時計算
- 過去の純資産ピークから現在のドローダウンを監視し、ユーザー設定の防御ライン超過を警告
- 同時利用者の重複銘柄リクエストを短時間で統合し、Render共有IPと上流APIへの不要な通信を削減
- API応答へ追跡IDと品質情報を付け、障害調査と接続センターの透明性を強化
- 共有時にアプリ固有のカードが表示されるソーシャルプレビューを追加

### X-RAY・STRESS・DRAWDOWNの使い方

1. 「保有」で各銘柄の株数・現在値・損切り発動価格を登録し、同期します。
2. `PORTFOLIO X-RAY` で株式内構成比、STOPカバー率、現在値からSTOPまでの参考損失を確認します。STOP未設定銘柄は損失ゼロではなく「未計量」として表示します。
3. `STRESS LAB` で株価とUSD/JPYのショックを組み合わせます。結果は試算だけで、保有データを書き換えません。
4. `DRAWDOWN GUARD` は新鮮な円換算純資産履歴が2日分できると監視を開始します。入出金を調整しない残高比較であり、運用成績そのものではありません。
5. 「記録 → DATA CONNECTION」で取得品質、fresh/stale/failed件数、障害調査用TRACE IDを確認できます。

## 検証済み

- 自動テスト70件すべて成功
- `npm audit --omit=dev` で既知脆弱性0件
- MARKET THEME INTELLIGENCE APIを実Yahoo通信で確認。50テーマ、8分類、43構造edge、Score構成138銘柄、ETF等を含む全183シンボルを取得し、HTTP 200・警告0・約3.8秒（検証時）
- APIと画面の両方で `actualFundFlow: false`、出来高・ニュース・時価総額未接続、stale/partial時のNEXT・5条件ゲート停止、内部計算field非公開を確認
- 50テーマの主要銘柄について1D・5D・1M・1Y、30営業日履歴、親子テーマ、ETF、MUU注意、AI evidence/revisionを検証
- AAPL・NVDA・MSFT・SPY・USD/JPYの実API取得を確認
- MARKET THEME TRACKERの主要50銘柄を実APIで取得し、既存10テーマすべての4期間計算とcoverageを確認
- 同時2リクエストの重複銘柄をYahoo 1回へ統合し、片方の切断が共有取得を止めないことを確認
- 祝日、早仕舞い、プレ市場、相場中の古い観測、provider不一致、非USD、STOP到達、保存破損、多タブ競合をfixture化
- 数値fixtureでNAV、HHI、STOP参考損失、株価×為替の交差効果、VaR、Expected Shortfall、ベータ、参考株数を検算

## v10 で直したこと

- 株価を銘柄ごとに大量並列取得して `429 Too Many Requests` になっていた処理を、1回のバッチ取得へ変更
- 廃止・拒否されていた Yahoo Quote v7 と Stooq CSV 依存を撤去
- 3か月前比を「前日比」と誤表示していた騰落率計算を、直近2営業日の終値で修正
- 株価と為替を独立して取得し、一部だけ失敗した場合も成功分を反映
- 最終正常値の stale-if-error キャッシュ、失敗キャッシュ、同時処理共有、タイムアウトを追加
- 1同期全体を14秒で打ち切り、切断後の上流通信、Finnhubの分間枠、障害プロバイダーの連続呼出しを抑制
- 古いキャッシュを正常扱いせず、「最終応答」と「最後に新鮮な値を得た時刻」を分離
- 36銘柄以上の後続バッチが失敗しても、先に取得済みの価格を保持して部分反映
- 0銘柄更新を成功扱いする画面側の不具合を修正
- Render のコールドスタート、401・429・5xx、HTML応答、タイムアウトを画面に明示
- データ接続センター、ソース／最終成功／失敗銘柄／遅延値表示を追加
- 週末でも「市場時刻」と「取得時刻」を混同せず、更新停止と誤判定しないよう修正
- 保有追加・監視追加の直後に即時同期、オンライン復帰・画面復帰時に再同期
- PWA キャッシュ更新、アクセシビリティ、狭幅・PCレイアウト、保存データ移行を改善
- `/healthz`、Render Blueprint、Node バージョン固定、自動テストを追加

## ローカル起動

必要環境は Node.js `22.14.0` 以上、`25` 未満です。

```bash
npm ci
npm run check
npm start
```

ブラウザで `http://localhost:10000` を開きます。診断は次のURLです。

- 生存確認: `http://localhost:10000/healthz`
- 市場データ診断: `http://localhost:10000/api/diagnose?symbols=AAPL,NVDA`

## Render へ再デプロイ

1. このフォルダの全ファイルを、Render が参照している Git リポジトリのルートへ置き換えます。
2. `node_modules` はアップロードしません。
3. `render.yaml` を使うか、Dashboard で次を設定します。
   - Runtime: `Node`
   - Build Command: `npm ci --omit=dev && npm run build`
   - Start Command: `npm start`
   - Health Check Path: `/healthz`
4. デプロイ後、アプリの「記録 → DATA CONNECTION → 今すぐ同期」で確認します。

Render の無料 Web Service は、外部から15分間アクセスがないと停止し、次回アクセス時の復帰に約1分かかります。画面を閉じている間の常時更新や常時通知は無料枠だけでは実行できません。詳細は [Render公式の無料枠説明](https://render.com/docs/free) を確認してください。

## 環境変数

| 変数 | 必須 | 用途 |
|---|---:|---|
| `FINNHUB_API_KEY` | 推奨 | 米国株の優先データ源。無料枠は Personal Use 向けです |
| `ANTHROPIC_API_KEY` | 任意 | AI直結機能 |
| `ANTHROPIC_MODEL` | 任意 | AIモデル名 |
| `API_TOKEN` | 条件付き必須 | `/api` をBearer認証で保護。FinnhubまたはAIキーを使う場合は必須。アプリ設定にも同じ値を入力 |
| `ALLOWED_ORIGINS` | 任意 | 別ドメインのフロントを許可する場合のみ、カンマ区切りで指定 |
| `MARKET_DATA_DEADLINE_MS` | 任意 | 1同期の上限。既定14,000ms |
| `QUOTE_RATE_LIMIT_PER_MINUTE` | 任意 | IPごとの株価API上限。既定12回/分 |
| `THEME_RATE_LIMIT_PER_MINUTE` | 任意 | IPごとのテーマAPI上限。既定18回/分 |
| `THEME_CACHE_TTL_MS` | 任意 | テーマ履歴の正常キャッシュ。既定900,000ms（15分） |
| `INTELLIGENCE_RATE_LIMIT_PER_MINUTE` | 任意 | 50テーマOS APIのIPごとの上限。既定6回/分 |
| `INTELLIGENCE_CACHE_TTL_MS` | 任意 | 50テーマOSの正常キャッシュ。既定900,000ms（15分） |
| `INTELLIGENCE_DATA_DEADLINE_MS` | 任意 | 50テーマOSの一括取得上限。既定20,000ms |
| `FINNHUB_CALLS_PER_MINUTE` | 任意 | サーバー全体のFinnhub予算。既定55回/分 |
| `YAHOO_BATCH_WINDOW_MS` | 任意 | 同時要求を1バッチへまとめる待機窓。既定20ms |
| `MARKET_DATA_MAX_IN_FLIGHT` | 任意 | 共有中の上流取得管理数。既定500 |
| `PROVIDER_DIVERGENCE_PCT` | 任意 | 比較可能なFinnhub／Yahoo価格差の警告閾値。既定1.5% |

秘密値はファイルへ書かず、Render の Environment Variables に保存してください。

### 市場データの順序

`FINNHUB_API_KEY` がある場合、米国株の現在値は Finnhub を優先し、チャート履歴だけを Yahoo で補完します。未設定時は Yahoo Spark を best-effort で使い、最大5銘柄だけ Nasdaq 表示データへ短時間フォールバックします。USD/JPY は Yahoo、失敗時は Frankfurter の ECB 日次参考値、さらに独立した為替APIの順です。全体期限に達した場合は、取得済みデータまたは古い正常キャッシュを直ちに返します。

長期運用では Finnhub キーの設定を推奨します。Yahoo の無保証エンドポイントは仕様変更や共有IP制限の影響を受ける可能性があり、利用条件の確認も必要です。Finnhub は [公式料金・利用区分](https://finnhub.io/pricing)、Frankfurter は [公式API](https://frankfurter.dev/) を参照してください。

## データ保存と安全性

- 保有株や日誌は端末の `localStorage` に保存され、Render の一時ファイルシステムには保存しません。
- 変更前の状態を端末内へ最大5世代保存し、主保存が壊れた場合は正常な復旧点を探します。保存後は読戻し一致も検証します。
- 複数タブで異なる項目が同時更新された場合は3方向マージし、同じ項目の競合は操作中のタブを優先して警告します。
- JSON書出では APIトークン、GitHubトークン、クラウド合言葉を自動除外します。
- JSON取込は5MBに制限し、許可した項目だけを型・範囲検証して復元します。不正なHTMLや壊れた数値・配列は保存前に無害化または破棄し、現在の接続先・各トークン・合言葉・Gist IDは上書きしません。
- Secret Gist 保存はブラウザ内で AES-GCM 暗号化してから送信します。合言葉を失うと復元できません。
- `FINNHUB_API_KEY` または `ANTHROPIC_API_KEY` を設定する場合、公開URLから枠や課金を消費されないよう `API_TOKEN` も必須です。起動後に「記録 → 設定 → APIトークン」へ同じ値を入力してください。外部キーを一切使わない場合だけ、両方を未設定にできます。

## 注意

表示値はデータ源によりリアルタイム、前日終値、遅延、日次参考値が混在します。アプリ内にソース、価格基準時刻、取得時刻、品質を表示します。STOP価格は約定価格を保証せず、急変時は大きく乖離する可能性があります（[FINRA公式の注意事項](https://www.finra.org/investors/insights/stop-orders-factors-consider-during-volatile-markets)）。売買執行前には必ず証券会社の正式な価格と注文種別を確認してください。本アプリは投資助言・注文執行システムではありません。
