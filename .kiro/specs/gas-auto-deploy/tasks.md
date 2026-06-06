# Implementation Plan

- [ ] 1. Deploy Workflow パイプラインの構築
- [x] 1.1 push トリガーとテストゲートの構築
  - main ブランチへの push でのみ起動するようトリガーを限定する
  - `concurrency` グループ（`deploy-gas`, `cancel-in-progress: false`）を設定し、連続 push 時にデプロイを直列化する
  - Node 20 ランタイム上で既存テストスイート（`node --test`）を実行する test ジョブを定義する（外部依存インストールは不要）
  - 各ステップの成否が実行ログで確認できるようにする
  - observable: main 以外の push ではワークフローが起動せず、main への push で test ジョブが実行され成否がログに表示される
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 5.1_
  - _Boundary: Deploy Workflow_

- [x] 1.2 デプロイジョブの構築（認証展開と clasp によるソース同期）
  - test ジョブの成功（`needs: test`）を条件にデプロイジョブを実行する
  - Secret `CLASPRC_JSON` を環境変数経由でランナー上の認証ファイルに展開し、コマンド行に認証情報を出さない
  - clasp v3（メジャー固定）で `push --force` を実行し、`src` を既存 `.clasp.json` の `scriptId` が指す GAS プロジェクトへ同期する（versioned deploy は行わない）
  - 認証不在/無効・push 失敗時はジョブを失敗終了させ、成功時は success とする
  - observable: test 成功後に `src` が GAS へ反映されジョブが success、Secret 不正時は deploy ジョブが failure となり原因がログに残る
  - _Requirements: 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 5.2, 5.3, 5.4_
  - _Boundary: Deploy Workflow_

- [ ] 2. (P) セットアップ・運用ドキュメントの作成
  - ローカルで `clasp login` 済みの認証情報（v3 `tokens` 形式）を Secret `CLASPRC_JSON` として登録する手順を記載する
  - Apps Script API の事前有効化が必須であること（および設定箇所）を明記する
  - OAuth 同意画面を公開設定にしないとリフレッシュトークンが約7日で失効する点を注意として記載する
  - トークン失効時に再ログインして Secret を更新する復旧手順を記載する
  - observable: 上記4項目すべてが記載され、手順どおりに設定すれば初回デプロイが成立する内容になっている
  - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - _Boundary: Setup Documentation_

- [ ] 3. パイプラインのエンドツーエンド検証
- [ ] 3.1 デプロイパイプラインの実挙動検証
  - 成功パス: main への push で test → deploy が実行され success で終了する（実行前提として Task 2 の手動セットアップ＝Secret 登録・API 有効化が完了していること）
  - ゲート: テストを意図的に失敗させた場合に deploy がスキップされ、ワークフローが failure になる
  - 認証異常: Secret 未設定/無効の場合に deploy ジョブが failure となり、ログに認証エラーが残る
  - ブランチ限定: main 以外への push でワークフローが起動しない
  - observable: 上記4シナリオが GitHub Actions のログ/ジョブステータスで期待どおり確認できる
  - _Depends: 1.2, 2_
  - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 3.1, 4.1, 4.4, 5.2, 5.3, 5.4_
  - _Boundary: Deploy Workflow_
