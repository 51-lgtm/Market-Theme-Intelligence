米国株司令室 + Astra v2：独立した無料プレビュー用コード
基準: 51-lgtm/Market-Theme-Intelligence / codex/astra-v2-free-20260907
固定元commit: 5c7fd291462c6206570b356d7d34fd370e7b631d
UI改善パッチを適用。元サイト・GitHub・Renderには変更していません。

これは公開済みサイトではなく、独立サービス作成用のソースコードです。
新規リポジトリ/別サービス/別URLとして扱い、既存サービスを上書きしないこと。
新規無料設定: render-free-preview.yaml（既存render.yamlは旧Nodeのみ、render-astra.yamlはAIキー入力を含むため今回使わない）。
DockerfileはReact UIをbuildし、Python FastAPIを公開、Nodeを内部127.0.0.1だけで起動します。
/ は改善済み旧司令室、/astra/ はAstra v2。旧 / はAstraログイン保護の対象外です。
別URLなので旧サイトのlocalStorageは自動移行しません。保有データを自動コピーしません。

無料限定の安全条件
- plan: free のみ。ディスク/DB/worker/外部有料APIは作成しない。
- APIキーを設定しない。AI呼出予算0、背景更新停止。AI生成機能は利用不可と表示されます。
- 手動データ更新は外部の公開市場データへアクセスし得るため、この検証では実行しません。
- 実売買/自動売買/ペーパーブローカー無効。新規Shadow注文も無効。表示されるShadow初期資金は実資産ではありません。
- 独自の12文字以上の管理パスワードと32文字以上のJWT秘密が必要。実キーはこのZIPに含みません。
- HTTPS Cookieを維持。Renderが提供するRENDER_EXTERNAL_URLを使用し、元サイトURLを指定しない。
- この無料プレビューへ実口座情報、重要な保有/取引/リスク記録を保存しない。

重要な未解決事項
Render無料サービスは休止/再起動/再デプロイでSQLiteの記録が消失し得ます。
履歴だけでなくShadow残高・注文・ポジション・Kill状態・AI予算記録も消失し得ます。
JSONエクスポートは一部テーブルのみ（各最大1万件）であり、完全なバックアップ/復元機能ではありません。
この設計のまま永続記録を前提とした本番運用は不可。無料の永続ストレージ設計は未実装です。

無料枠も完全な無課金保証ではありません。支払方法登録済みアカウントでは帯域/ビルド枠超過請求の可能性があります。
公式資料: https://render.com/docs/free および https://render.com/docs/faq （2026-10-30確認）
750時間/月はワークスペース共通なので元サイトと新サイトで共有します。枠不足は停止を選択し、有料へ自動変更しないこと。
支払方法/請求上限/無料枠が確認できるまでは公開しない。休止回避の定期アクセスは追加しない。

ローカル検証（実キー不要）
npm ci --ignore-scripts
npm run check
npm --prefix frontend ci --ignore-scripts
npm --prefix frontend test
npm --prefix frontend run build
python -m venv .venv
.venv/bin/pip install -r requirements-dev.txt -c requirements-lock.txt
.venv/bin/python -m pytest tests_astra -q

Docker実ビルド/Render実デプロイ/実ブラウザ表示確認は未実施。
UIテストとFastAPIテストは実売買を行わない架空データ/モックです。

この成果物の検証結果（2026-10-30）
Node 191/191、Astra React 5/5、Vite production build成功。
Python 96/96（既存84、起動停止モック11、build後資産配信/認証1）。
旧UI jsdom検証3群成功（同期/市場、AI、保有/Ops）。依存pip check正常。
初回Pythonは実行環境のSOCKS対応不足で失敗。プロキシ設定を変えず試験venvにsocksio追加後全成功。
socksioはこの実行環境用の補助で、プロジェクト依存を勝手に変更していません。
起動試験はモックであり実Docker起動の代わりではありません。実ブラウザの寸法/スクロール/見た目は未検証。
無料ホストのリソース上限でPython+Nodeの稼働が収まるかは未測定です。
