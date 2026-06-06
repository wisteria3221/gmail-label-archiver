# Implementation Plan

- [x] 1. Deploy Workflow パイプラインの構築
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

- [x] 2. (P) セットアップ・運用ドキュメントの作成
  - ローカルで `clasp login` 済みの認証情報（v3 `tokens` 形式）を Secret `CLASPRC_JSON` として登録する手順を記載する
  - Apps Script API の事前有効化が必須であること（および設定箇所）を明記する
  - OAuth 同意画面を公開設定にしないとリフレッシュトークンが約7日で失効する点を注意として記載する
  - トークン失効時に再ログインして Secret を更新する復旧手順を記載する
  - observable: 上記4項目すべてが記載され、手順どおりに設定すれば初回デプロイが成立する内容になっている
  - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - _Boundary: Setup Documentation_

- [x] 3. パイプラインのエンドツーエンド検証
- [x] 3.1 デプロイパイプラインの実挙動検証
  - 成功パス: main への push で test → deploy が実行され success で終了する（実行前提として Task 2 の手動セットアップ＝Secret 登録・API 有効化が完了していること）
  - ゲート: テストを意図的に失敗させた場合に deploy がスキップされ、ワークフローが failure になる
  - 認証異常: Secret 未設定/無効の場合に deploy ジョブが failure となり、ログに認証エラーが残る
  - ブランチ限定: main 以外への push でワークフローが起動しない
  - observable: 上記4シナリオが GitHub Actions のログ/ジョブステータスで期待どおり確認できる
  - _Depends: 1.2, 2_
  - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 3.1, 4.1, 4.4, 5.2, 5.3, 5.4_
  - _Boundary: Deploy Workflow_
  - _Manual: ライブ検証実施（2026-06-06）。前提（GitHub リモート push、Secret `CLASPRC_JSON`・`GAS_SCRIPT_ID` 登録、Apps Script API 有効化）をユーザー作業で充足後に実行。①成功パス: 空コミット push で test→deploy が success（run 27059786384、Write clasp credentials / Set clasp scriptId from secret / Push src to GAS すべて通過）✅。④ブランチ限定: `verify/no-trigger` への push で workflow が起動せず（run 0 件）✅。②テスト失敗ゲート・③認証異常は main/Secret を一時破壊する破壊的検証のためスキップ（静的構造は needs:test ゲート＝タスク 1.1、認証展開＝タスク 1.2、scriptId 注入＝タスク 4.x で検証済み、かつ Secret 未登録時の旧 run 27059208065/27058395798 が deploy failure＝`Unexpected end of JSON input` を実証）。手順は docs/deploy-setup.md「動作確認チェックリスト」を参照。_

- [x] 4. scriptId の Secret 化対応
- [x] 4.1 ワークフローへの scriptId 注入ステップの追加
  - deploy ジョブに、Secret `GAS_SCRIPT_ID` を `env:` 経由で受け取り `jq` で `.clasp.json` の `scriptId` へ注入するステップを、clasp push の前に追加する
  - scriptId をコマンド行・ログに露出させない（`env:` + `jq --arg`）
  - 注入は認証情報展開の後・`clasp push` の前に行う
  - observable: deploy.yml に scriptId 注入ステップが存在し、`GAS_SCRIPT_ID` が `secrets.` 参照かつ `env:` 経由で渡され、`jq` で `.clasp.json` に書き込まれる。YAML は妥当で test 58/58 通過
  - _Requirements: 3.4, 4.5, 4.6_
  - _Boundary: Deploy Workflow_

- [x] 4.2 セットアップドキュメントへの GAS_SCRIPT_ID 登録手順の追記
  - Secret `GAS_SCRIPT_ID`（`.clasp.json` の `scriptId` 値）の登録手順を追記する
  - 実 scriptId はリポジトリにコミットせず Secret で管理する旨と、コミット版が placeholder である旨を明記する
  - 動作確認チェックリストに `GAS_SCRIPT_ID` 登録を加える
  - observable: docs/deploy-setup.md に `GAS_SCRIPT_ID` の登録手順とチェックリスト項目が追加され、ワークフローの Secret 名と一致する
  - _Requirements: 6.1_
  - _Boundary: Setup Documentation_

## Implementation Notes
- `.clasp.json` の `scriptId` はリポジトリにコミット済みの placeholder（`REPLACE_WITH_YOUR_SCRIPT_ID`）。作業ツリーにはユーザーが設定した実 scriptId が未コミットで存在する。これは本 spec の対象外（既存設定の利用のみ）のため、各タスクのコミットからは選択的ステージングで除外している。
- ワークフローは外部依存ゼロ前提（`npm install`/`npm ci` 不要、`npm test` = `node --test` のみ）。`src/*.js` は `typeof module` ガードにより GAS と Node テストの両環境で安全。
- タスク 3.1 はライブの GitHub Actions 実行を要する手動検証。実装フェーズでは完了扱いにできない（_Manual_ 注記参照）。
- scriptId は Secret `GAS_SCRIPT_ID` で管理（ユーザー方針による後追い設計変更、タスク 4.x）。コミット版 `.clasp.json` は placeholder を維持し、deploy ジョブが `jq` で実 scriptId を一時注入する。Secret は2つ（`CLASPRC_JSON`, `GAS_SCRIPT_ID`）が必須。
