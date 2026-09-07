# Astra v2 実装・最終レビュー記録

確認日：2026-09-08。これは実装検証の記録であり、投資成績の検証や本番稼働保証ではありません。

## 検証結果

| 検証 | 結果 |
| --- | --- |
| 旧Express/PWA/指標/テーマ/バックテスト・新bridge | 174 tests passed、失敗・skipなし |
| FastAPI/認証/Agent/Commander/Risk/Shadow/Journal/HTTPS導入 | 84 tests passed、失敗・skipなし |
| React UIロジック | 5 tests passed |
| Node構文検査・React production build | 成功 |
| npm audit（root・frontend） | 既知の脆弱性0件（確認時） |
| pip check | 依存不整合なし。Python脆弱性監査を行った意味ではない |
| 実ブラウザ | 全主要画面、JMIA詳細、390pxスマホ、実データ更新、旧画面proxyを確認 |
| Browser console | error 0件 |

FastAPI/Starletteのテスト用依存で非推奨警告2件あり。失敗ではなく、警告を隠していません。OpenAI/証券会社の実鍵を使った疎通、DockerイメージのLinuxビルド、Render本番デプロイはこの環境では未検証です。

## レビューで修正した項目

- 価格0・NaN・未来時刻・naive日時、期限切れ・独立2社照合の不足を拒否。
- AIのshould_executeは厳密なfalseのみ。数値0、自由文JSON、追加キーを拒否。
- SQLite transactionとidempotencyにより重複資金予約・重複約定を防止。
- エントリー後に到着した別の価格観測のみ仮想約定。遡及約定・過去日付のexitを拒否。
- 最新価格とAgent材料の両方を照合し、分析中に材料・保有情報が変われば旧判断を実行しない。
- kill中でも検証済み価格による既存Shadowポジションの損切り・全決済を許可。新規建て条件で出口を塞がない。
- SELL/STOP判断は対応する既存Shadowポジションのみ全決済。TRIM/部分決済は未実装で無効。
- 未確定週足を週足判定に混入させず、NYSE休日・短縮取引日を考慮。
- 取引時系列とタイムゾーンを統一。履歴不足を完璧な類似パターンと評価しない。
- レガシーquote辞書のticker欠落を補い、VIX/WTI/FX等の実データ表示を修復。
- 古いPWA Service Workerが新React画面を旧HTMLで上書きしないよう除外。
- CSP外部フォントエラー、銘柄詳細の非同期競合、未接続なのに接続済みとなる表示を修正。
- qsを6.16.0へ固定して既知のDoS脆弱性を修正。上流例外のmessage/stackをログへ出さず鍵流出を防止。
- README更新で失われたriskScore/optimismScoreの非確率の注意書きを復元。旧テストは削除していない。
- RenderのHTTPS終端と内部HTTPの差を、検証済みASTRA_PUBLIC_ORIGIN / RENDER_EXTERNAL_URLで扱う。任意のforwarded headerは信頼せず、Origin/CSRF検査とIPレート制限を維持。
- Docker最終イメージにNode実行用libstdc++6を明示し、ビルド時node --versionで起動依存を検査。

## 完成扱いにしていない事項

1. 100〜300件の実時間Shadow蓄積と統計的有効性はまだ未検証。fixtureの約定を運用実績と数えていない。
2. 無料価格では最新bid/ask・独立2社・決算確認等が不足し、Shadow注文も拒否され得る。安全条件は緩和していない。
3. 完成版Strategy Fの2年以上のpoint-in-time検証は、過去ニュース/テーマ/決算データ不足のため未完成。A〜Eの既存エンジンを維持。
4. PaperBrokerは未接続、LiveBrokerは常に拒否。実注文API、unlock、認証情報の自動探索はない。
5. Nigeria macro/IR詳細、実資金フロー、テーマ波及の確率校正は未接続/未検証。スコアを実流入額や勝率と表記しない。
6. 無料RenderのSQLiteは休止・再起動・再デプロイで失われる。長期JournalとKill状態の永続運用には永続ストレージが必要。
7. 単一管理者用。マルチユーザー分離、外部DB、汎用JSON restore、brokerの部分約定照合は未実装。

## 受け入れ・導入

mainへ自動反映しない追加型リリース。旧Node用render.yamlを維持し、新AstraはDocker用render-astra.yamlを使用。GitHubへはフォルダ階層ごと配置し、ZIPそのものを置くだけでは動きません。

GitHub連携の書き込み権限不足に対して、所有者がログインしたGitHub画面から専用ブランチ `codex/astra-v2-free-20260907` へソースを配置しています。mainと既存Renderサービスは変更していません。実行用50ファイルはGit blob IDで配布manifestとの一致を検証済みです。

新規Render設定はDocker / Free（月額$0）で準備し、OpenAI呼び出し上限を0、実売買と自動売買をfalseに設定。管理者パスワードとJWT署名秘密鍵は所有者による入力待ちです。この記録時点で新サービスの作成・本番デプロイ・公開疎通は未完了です。

秘密鍵・.env・SQLite・テスト取引DB・node_modulesは配布対象外。`scripts/package-release.ps1`（PowerShell 7）で明示allowlistからZIPを作り、各ファイルSHA-256と展開後byte同一性を検証できます。

全体自己評価：75/100。P0の実装・安全性テストと主要UIは完了しましたが、外部データ契約・実API疎通・永続運用・長期検証が残っています。
