# Research & Design Decisions

## Summary
- **Feature**: `gmail-label-archiver`
- **Discovery Scope**: New Feature（greenfield、ただしスコープは限定的）
- **Key Findings**:
  - Google Apps Script の `GmailApp` / `SpreadsheetApp` / `ScriptApp`（時間トリガー）のみで全要件を満たせる。外部依存・課金なし。
  - Gmail 検索演算子による事前絞り込み（`label: in:inbox -is:starred older_than:`）と、コード側の権威的判定（最新メッセージ日時・スター有無）を組み合わせることで、要件 2.2 / 2.6 を正確に満たせる。
  - アーカイブ実行は受信トレイから外す操作のため、検索条件 `in:inbox` により未処理分は次回実行で自然に再取得される。よって「件数上限＋次回持ち越し」（要件 5.1）は専用の状態管理なしで実現できる。

## Research Log

### Gmail 検索・アーカイブ API（GmailApp）
- **Context**: ラベル＋経過日数＋スター除外で対象スレッドを抽出し、受信トレイから外す方法を確定する。
- **Sources Consulted**: Google Apps Script `GmailApp` / `GmailThread` リファレンス（既知の確立した API）。
- **Findings**:
  - `GmailApp.search(query, start, max)` は Gmail 検索演算子をそのまま受け付ける。1 回あたり最大 500 件取得。
  - `GmailApp.moveThreadsToArchive(threads)` は受信トレイから外す（INBOX ラベル除去）。**1 回あたり最大 100 スレッド**のため分割呼び出しが必要。
  - `GmailThread.getLastMessageDate()` でスレッド内最新メッセージ日時を取得でき、要件 2.2 の「最新メッセージ日時基準」を権威的に判定可能。
  - `GmailThread.hasStarredMessages()` でスレッド内のスター有無を判定でき、要件 2.6 を権威的に判定可能。
  - 検索演算子 `older_than:Nd` は「いずれかのメッセージが N 日より古い」を意味し近似的。よって検索は事前絞り込みに用い、最終判定はコード側（`getLastMessageDate`）で行う。
  - `older_than` の粒度は日単位（`d`）。保持日数は整数日として扱う。
- **Implications**: 検索クエリは効率のための事前フィルタ、コード側チェックを正本とする二段構えにする。

### ラベル名の表記（検索演算子）
- **Context**: ラベル名に空白や階層（`/`）が含まれる場合の検索クエリ表現。
- **Findings**: `label:"<ラベル名>"` のように二重引用符で囲めば空白入りラベルも安全に指定できる。ネストラベルは `親/子` 形式で表現される。
- **Implications**: クエリ生成時はラベル名を常に二重引用符で囲む。

### 時間トリガー（ScriptApp）
- **Context**: 1 日 1 回の自動実行と重複登録防止。
- **Findings**:
  - `ScriptApp.newTrigger('<fn>').timeBased().everyDays(1).atHour(<h>).create()` で日次トリガーを作成。
  - `ScriptApp.getProjectTriggers()` で既存トリガーを列挙でき、同一ハンドラ関数のトリガーを削除してから作成することで重複を防止できる。
- **Implications**: セットアップ関数は「既存の同一ハンドラトリガーを全削除 → 1 件作成」を冪等に行う。

### 設定スプレッドシートの参照方式
- **Context**: スクリプトがどの設定シートを読むかを決める方式（要件 1）。
- **Findings / Alternatives**:
  - 案A: コンテナバインドスクリプト + `getActiveSpreadsheet()` — 設定シートにスクリプトが付随。手軽だが特定シートに密結合し、clasp standalone 管理と相性が悪い。
  - 案B: スタンドアロンスクリプト + Script Properties に `CONFIG_SPREADSHEET_ID` を保持し `openById()` — シートとコードが疎結合で clasp 管理に適し、テスト時も差し替えやすい。
- **Implications**: 案B を採用（下記 Design Decision 参照）。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 単一ファイル手続き型 | 全ロジックを 1 ファイルに記述 | 最小構成 | 設定読取・抽出・アーカイブ・トリガーが混在し責務不明瞭 | 却下 |
| 関数モジュール分割（採用） | 設定 / アーカイブ / エントリ・トリガー を別ファイルに分離（GASグローバルスコープ上の論理モジュール） | 責務が明確、レビュー・テスト容易 | GAS はファイル間 import 概念がなくグローバル共有 | 採用。依存方向は規約で担保 |

## Design Decisions

### Decision: 設定参照はスタンドアロン + Script Properties 方式
- **Context**: 要件 1（スプレッドシートで設定管理）と clasp ローカル管理の両立。
- **Alternatives Considered**:
  1. コンテナバインド + `getActiveSpreadsheet()`
  2. スタンドアロン + Script Properties に Spreadsheet ID 保持 + `openById()`
- **Selected Approach**: 案2。Script Properties に `CONFIG_SPREADSHEET_ID`（必須）と `CONFIG_SHEET_NAME`（任意、既定 `settings`）を保持。設定シートはヘッダ行＋`ラベル名 | 保持日数` のデータ行。
- **Rationale**: コードと設定シートが疎結合になり、clasp standalone プロジェクトとして Git 管理しやすい。シート差し替え・複数環境対応も容易。
- **Trade-offs**: 初回に Script Property の設定が必要（セットアップ手順に含める）。
- **Follow-up**: ID 未設定時は明示的なエラーで停止（フェイルファスト）。

### Decision: 抽出は「検索演算子による事前絞り込み + コード側の権威的判定」の二段構え
- **Context**: 要件 2.2（最新メッセージ日時基準）と 2.6（スター除外）を正確に満たす。
- **Selected Approach**: クエリ `label:"<name>" in:inbox -is:starred older_than:<days>d` で候補を絞り、各スレッドを `getLastMessageDate()`（しきい値超過か）と `hasStarredMessages()`（スター無し）でコード側確認してからアーカイブ対象にする。
- **Rationale**: `older_than` / `-is:starred` は近似・効率化に有効だが、スレッド単位の正確な判定はコード側 API が権威的。
- **Trade-offs**: スレッドごとに軽量な API 呼び出しが増えるが、件数上限により実行時間内に収まる。

### Decision: 件数上限と次回持ち越しは検索条件で自然実現
- **Context**: 要件 5.1（実行時間上限対策・持ち越し）。
- **Selected Approach**: 1 ルールあたり / 1 実行あたりの処理スレッド数に上限（`MAX_THREADS_PER_RUN`）を設け、`moveThreadsToArchive` を 100 件単位で分割実行。アーカイブ済みは `in:inbox` に該当しなくなるため、残りは次回実行で再取得される。
- **Rationale**: 専用の進捗状態（カーソル等）を持たずに持ち越しを実現でき、設計が単純。
- **Trade-offs**: 大量滞留時はドレインに複数日要するが、日次運用では許容範囲。

## Risks & Mitigations
- **実行時間上限（消費者アカウント 6 分）超過** — 件数上限 + 100 件バッチ分割で 1 実行を短く保つ。
- **ラベル不在・不正な保持日数行** — 行単位で try/catch・バリデーションし、スキップして他行を継続（要件 1.4 / 1.5 / 2.4 / 5.2）。
- **OAuth スコープ不足でアーカイブ失敗** — マニフェスト `appsscript.json` に必要スコープを明示し、初回認可で付与。
- **誤アーカイブ（必要メールを外す）** — スター除外 + 最新メッセージ日時基準のコード判定で保守的に動作。アーカイブは削除ではなく可逆。

## References
- Google Apps Script `GmailApp` リファレンス（`search`, `moveThreadsToArchive`）— 検索・アーカイブ API の上限と挙動。
- Google Apps Script `GmailThread` リファレンス（`getLastMessageDate`, `hasStarredMessages`）— スレッド単位の権威的判定。
- Google Apps Script `ScriptApp` リファレンス（`newTrigger`, `getProjectTriggers`）— 時間トリガー管理。
- Gmail 検索演算子（`label:`, `in:inbox`, `is:starred`, `older_than:`）— 事前絞り込みクエリ。
