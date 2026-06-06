# Brief: gas-auto-deploy

## Problem
現在、Google Apps Script へのデプロイは開発者がローカルから手動で `clasp push` を実行する必要がある。コード変更のたびに手動操作が発生し、「コミットしたがデプロイし忘れた」状態（GitHub 上のソースと GAS 上の実行コードの乖離）が起こりうる。

## Current State
- clasp ベースの GAS プロジェクト。`.clasp.json` に `scriptId` と `rootDir: src` を保持
- デプロイ対象は `src/`（`Archiver.js` / `Config.js` / `Constants.js` / `Main.js` / `appsscript.json`）
- テストは `node --test`（`test/` ディレクトリ）でローカル実行可能
- `.clasprc.json`（clasp の OAuth 認証情報）は `.gitignore` 済み
- GitHub リモートは別途用意済み（ユーザー側で対応）
- CI/CD パイプラインは未整備。デプロイは完全に手動

## Desired Outcome
- main ブランチへ push すると、GitHub Actions が自動でテストを実行し、テスト通過時のみ `clasp push` で GAS にソースを反映する
- 認証情報はリポジトリにコミットされず、GitHub Secrets で安全に管理される
- デプロイの成否が GitHub Actions のログで確認できる

## Approach
GitHub Actions ワークフローを 1 本追加する。トリガーは main への push。ジョブは「テスト → デプロイ」の順で実行し、テスト失敗時はデプロイをスキップする。

clasp の CI 認証は **clasp ログイントークンを Secret 化する方式**を採用：
- ローカルで `clasp login` 済みの `~/.clasprc.json`（clasp v3 の `tokens` マップ形式）を GitHub Secret `CLASPRC_JSON` として登録
- ワークフロー内で Secret をランナーの `~/.clasprc.json` に書き出し、`npx @google/clasp@3 push --force` を実行
- デプロイ粒度は `clasp push`（ソース同期）のみ。versioned deploy（`clasp deploy`）は対象外

技術前提（viability 検証済み）：
- `@google/clasp` v3.3.0、ランナーは Node >= 20
- 認証ファイルは v3 形式（フラットな v2 形式ではなく `{ "tokens": { "default": {...} } }`）
- Apps Script API をアカウント設定（script.google.com/home/usersettings）で事前に有効化しておく必要がある（CI では実施不可・一度きりの手動作業）
- OAuth 同意画面が「テスト中」状態だとリフレッシュトークンが約7日で失効するため、公開設定にするか定期的に Secret を更新する運用が必要

## Scope
- **In**:
  - main への push をトリガーとする GitHub Actions ワークフロー（`.github/workflows/`）
  - テストジョブ（`node --test`）→ 成功時のみデプロイジョブの実行
  - clasp トークンによる非対話認証と `clasp push --force`
  - セットアップ手順のドキュメント化（Secret 登録、Apps Script API 有効化、同意画面の注意点）
- **Out**:
  - versioned deploy / `clasp deploy`（Web アプリや API 実行版の公開）
  - GCP サービスアカウント認証方式
  - GitHub リポジトリ自体の作成・リモート設定（ユーザー側で対応済み）
  - PR プレビューデプロイや複数環境（staging/prod）への出し分け

## Boundary Candidates
- CI ワークフロー定義（トリガー・ジョブ構成・テストゲート）
- clasp 認証情報の受け渡し（Secret → ランナーのファイル化）
- デプロイ実行（clasp push コマンドとオプション）
- セットアップ／運用ドキュメント

## Out of Boundary
- gmail-label-archiver のアプリケーションロジック（アーカイブ処理そのもの）
- GAS のトリガー設定（時間主導トリガー）の自動化
- テストの追加・拡充（既存の `node --test` を利用するのみ）

## Upstream / Downstream
- **Upstream**: 既存の clasp 構成（`.clasp.json`）、既存テスト（`test/`、`node --test`）、ユーザーが用意した GitHub リポジトリ
- **Downstream**: 今後の機能追加 spec はこのパイプラインに乗ることで、push 時に自動デプロイされる

## Existing Spec Touchpoints
- **Extends**: なし（新規の独立した CI/CD 関心事）
- **Adjacent**: `gmail-label-archiver`（デプロイ対象のソースを所有するが、ロジックには干渉しない）

## Constraints
- 認証情報を絶対にリポジトリにコミットしない（Secrets 管理必須）
- `@google/clasp` v3 系、ランナー Node >= 20
- Apps Script API の手動有効化と OAuth 同意画面の公開設定という、CI 外の前提条件が存在する
- 既存の `.gitignore`（`.clasprc.json` 除外）を維持する
