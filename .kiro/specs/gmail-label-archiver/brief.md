# Brief: gmail-label-archiver

## Problem
受信トレイに残り続けるメールを手作業でアーカイブするのは手間で、放置すると受信トレイが肥大化する。利用者（個人の Gmail ユーザー = 本人）は、メールの種類ごとに「どれくらい受信トレイに置いておくか」を変えたいが、Gmail 標準のフィルタには「ラベル付与から N 日後にアーカイブ」という時間ベースの自動化機能がない。

## Current State
- greenfield プロジェクト（specs / steering 未作成、テンプレートのみ存在）。
- 既存コードなし。clasp による Apps Script ローカル開発をこれから立ち上げる。
- 現状は手動アーカイブ、または Gmail フィルタによる即時アーカイブしか手段がない。

## Desired Outcome
- Google スプレッドシートで「ラベル → 受信トレイ保持日数」の対応表を管理できる。
- 1 日 1 回の時間トリガーで Apps Script が自動実行され、各ラベルが付いたスレッドのうち指定日数を超えたものを受信トレイから外す（標準アーカイブ）。
- コードを変更せずに、スプレッドシートの編集だけで対象ラベルと保持日数を増減・調整できる。

## Approach
Google Apps Script（`GmailApp` + `SpreadsheetApp`）+ 時間駆動トリガー（1 日 1 回）。設定はスプレッドシートの設定シートで `ラベル名 | 保持日数` の表として保持。スクリプトは各行を読み、Gmail 検索演算子（例: `label:<name> older_than:<days>d -in:inbox` 相当の条件、もしくは `label:<name> in:inbox older_than:<days>d`）で対象スレッドを取得し、受信トレイから外す（`moveThreadsToArchive` / INBOX ラベル除去）。clasp でローカル管理し Git にコミット可能にする。

**なぜこの方式か**: 設定をスプレッドシートに分離することで、運用者がコードを触らずラベルと日数を調整でき、保守コストが最小。標準の `GmailApp` / `SpreadsheetApp` のみで完結し外部依存・追加コストがゼロ。

## Scope
- **In**:
  - スプレッドシート設定シート（`ラベル名 | 保持日数`）の読み取り
  - ラベル＋経過日数条件での対象スレッド抽出（Gmail 検索）
  - 受信トレイから外す標準アーカイブ処理
  - 1 日 1 回の時間トリガー設定（セットアップ関数）
  - clasp プロジェクト構成（appsscript.json、.clasp.json 等）
- **Out**:
  - 通知・実行ログ機能（最小限方針。Apps Script 標準実行ログのみ）
  - メールの削除・転送・ラベル付け替えなどアーカイブ以外の操作
  - 複数アカウント対応、共有ドメイン管理
  - Web UI / ダッシュボード

## Boundary Candidates
- 設定読み取り（スプレッドシート → 設定オブジェクト）
- アーカイブ実行ロジック（ラベル＋日数 → 対象スレッド抽出 → アーカイブ）
- トリガー / セットアップ（時間トリガー登録、初回セットアップ）
- clasp / デプロイ構成

## Out of Boundary
- 通知・ログ基盤（今回は対象外、将来の拡張余地）
- アーカイブ以外のメール操作（削除・移動・自動返信など）

## Upstream / Downstream
- **Upstream**: Google Workspace / Gmail アカウント、Apps Script 実行環境、設定用スプレッドシート。
- **Downstream**: 将来的に通知・ログ機能、対象条件の高度化（送信者・サイズ等）を追加する場合の土台。

## Existing Spec Touchpoints
- **Extends**: なし（新規・初スペック）
- **Adjacent**: なし

## Constraints
- Google Apps Script ランタイム（V8）。Gmail / Spreadsheet サービスの利用権限が必要。
- Apps Script の実行時間上限（1 実行あたり最大 6 分）を考慮し、大量スレッド時はバッチ処理・件数上限を設計で扱う。
- clasp によるローカル管理（要 Node.js / clasp ログイン）。
- 外部ライブラリ・課金サービスへの依存なし。
