# 技術スタック

## アーキテクチャ

Google Apps Script (GAS) の単一プロジェクト。`src/*.js` は GAS ランタイム上で 1 つのグローバルスコープに連結され、各ファイルの top-level 関数がそのままグローバル公開される。サービス境界は「ファイル単位の責務分割」で表現する（クラスやモジュールではなく、Constants → Config → Archiver → Main の一方向依存レイヤ）。日次の時間トリガーまたは手動実行から単一エントリ `archiveLabeledThreads` が起動するイベント駆動型。

## コア技術

- **言語**: JavaScript（GAS V8 ランタイム / ES2019 相当の構文）
- **プラットフォーム**: Google Apps Script（`GmailApp` / `SpreadsheetApp` / `PropertiesService` / `ScriptApp`）
- **デプロイツール**: clasp v3（`npx @google/clasp@3`）
- **ローカル実行**: Node.js 20（テスト実行のみ）

## 主要ライブラリ

外部 npm 依存はなし（`package.json` に dependencies なし）。利用 API はすべて GAS 組み込みサービスで、`appsscript.json` の `oauthScopes`（Gmail / Spreadsheets / script.scriptapp）で宣言する。

## 開発標準

### 型安全性

TypeScript は使わず、純粋な JavaScript + JSDoc で型を表現する。`@typedef`（例: `ArchiveRule` / `ArchiveResult`）と関数の `@param` / `@returns` を必須とし、契約・前提条件・要件参照（例: `5.1`）を JSDoc に明記する。

### コード品質

- リンタ/フォーマッタの自動化設定は未導入。既存の整形（2 スペースインデント、セミコロン、文字列連結スタイル）に揃える。
- 副作用のある GAS API 依存関数と、純粋関数（`validateRow` / `buildQuery` / `isOlderThan` / `hasStar`）を意図的に分離し、純粋関数をテスト容易にする。
- 実行ログは絵文字 + タグ付きの日本語に統一（例: `✅ [アーカイブ完了]`、`⚠️ [エラー]`、`📊 [サマリ]`）。出力は `console.log` のみに統一し `Logger.log` は使わない（V8 では両者が同一の Cloud Logging に書き込まれ二重出力になるため）。

### テスト

- `node --test`（Node 標準テストランナー）で `test/*.test.js` を実行。テストフレームワークの外部依存なし。
- GAS API 依存部はテスト用のフェイク/スタブをテスト内で組み立て、純粋関数は直接検証する。
- テストはデプロイのゲート（`needs: test`）であり、失敗時はデプロイされない。

## 開発環境

### 必須ツール

- Node.js 20
- clasp v3（ローカル push / clone 用、`npx @google/clasp@3`）
- Google アカウントと OAuth 同意（初回実行時に Gmail / Spreadsheet / トリガー権限を承認）

### よく使うコマンド

```bash
# テスト: npm test               # node --test で純粋ロジックの単体テスト
# 反映: npx @google/clasp@3 push # src/ を GAS プロジェクトへ同期
```

## 重要な技術的判断

- **GAS グローバルスコープ前提**: モジュール import せず top-level 宣言で関数・定数を共有する。各ファイル末尾の `module.exports` は `typeof module !== 'undefined'` ガードで囲み、Node のテストからのみ `require()` 可能にする（GAS では評価されない）。
- **権威的再判定**: Gmail 検索（`label:... in:inbox -is:starred older_than:Nd`）は候補抽出にのみ使い、確定は `isOlderThan`（厳密超過）＋ `!hasStar` でコード側が行う。
- **実行予算管理**: `MAX_THREADS_PER_RUN`（実行全体上限）を残予算として各ルールに渡し、`ARCHIVE_BATCH_SIZE` 単位でアーカイブ。超過分は処理せず次回へ持ち越す。
- **フェイルファスト vs 継続**: 構成不備（Script Property 未設定・シート不在・ヘッダ不一致）は例外で即停止しログして正常終了。ルール単位のエラーは記録して次ルールへ継続。
- **CI からの scriptId 注入**: コミット版 `.clasp.json` の `scriptId` は placeholder。GitHub Actions が Secret（`GAS_SCRIPT_ID` / `CLASPRC_JSON`）から認証情報と実 scriptId を注入し `clasp push --force` で同期する。実 scriptId・認証情報はリポジトリに永続化しない。

---
_標準とパターンを記述する。すべての依存を列挙しない_
