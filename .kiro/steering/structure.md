# プロジェクト構成

## 構成方針

責務ごとにファイルを分割したレイヤ構成。GAS ランタイムでは全 `src/*.js` が 1 グローバルスコープに連結されるため、ファイルは物理的な分離だが、依存は一方向（下位レイヤほど依存が少ない）に保つ。最下位 `Constants` に共有定数を集約し、上位は下位のグローバル関数・定数を直接参照する。

## ディレクトリパターン

### ソース（GAS 同期対象）
**場所**: `/src/`
**役割**: GAS にデプロイされる本体。`.clasp.json` の `rootDir` がここを指す。1 ファイル = 1 サービス/責務。
**依存レイヤ**: `Constants.js`（共有定数・依存なし）→ `Config.js`（設定読取・行検証 = ConfigService）→ `Archiver.js`（対象抽出・権威的判定・バッチアーカイブ = ArchiveService）→ `Main.js`（エントリ・オーケストレーション・トリガー管理）。`appsscript.json` は GAS マニフェスト（タイムゾーン・ランタイム・OAuth スコープ）。

### テスト
**場所**: `/test/`
**役割**: `src/` の各ファイルに 1 対 1 対応する単体テスト（`<Source>.test.js`）。`node --test` で実行。GAS API 依存部はテスト内のフェイクで代替し、純粋関数は直接検証。

### ドキュメント
**場所**: `/docs/`
**役割**: 運用手順・検証手順・サンプル（`deploy-setup.md` / `manual-verification.md` / `sample-settings.csv`）。README から参照される補助資料。

### CI / デプロイ
**場所**: `/.github/workflows/`
**役割**: `main` への push で test → deploy を実行する GitHub Actions（`deploy.yml`）。

## 命名規則

- **ソースファイル**: PascalCase（`Constants.js` / `Config.js` / `Archiver.js` / `Main.js`）。サービス相当の責務単位。
- **テストファイル**: `<Source>.test.js`（対応するソースと同名 + `.test`）。
- **関数**: lowerCamelCase（`archiveLabeledThreads` / `readArchiveRules` / `buildQuery`）。ファイル内専用の補助関数は末尾アンダースコア（`findHeaderColumn_`）。
- **定数**: UPPER_SNAKE_CASE（`MAX_THREADS_PER_RUN`）。Script Property キーは `PROP_` 接頭辞、ヘッダ名は `HEADER_` 接頭辞。

## モジュール / エクスポートのパターン

GAS では import を使わず、top-level の `const` / `function` 宣言でグローバル共有する。Node テストから利用するため、各ファイル末尾に以下のガードを置く（GAS では `module` 未定義のため評価されない）。

```javascript
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { /* そのファイルの公開関数・定数 */ };
}
```

## コード構成の原則

- **一方向依存を守る**: 下位レイヤは上位を参照しない（`Constants` ← `Config` / `Archiver` ← `Main`）。新しい共有定数は `Constants.js` に追加する（マジックナンバーをファイル内に直書きしない）。
- **純粋関数を分離する**: GAS API（`GmailApp` 等）に触れない判定・整形ロジックは純粋関数として切り出し、テスト容易性を確保する。
- **JSDoc で契約を明示する**: `@typedef` / `@param` / `@returns` と前提条件・要件参照を関数の上に記述する。
- **ログ形式を踏襲する**: 新規ログは絵文字 + タグ + 日本語の既存パターンに合わせ、`console.log` 経由（`logLine` / `logSummary` パターン）で出力する。

---
_ファイルツリーではなくパターンを記述する。パターンに沿った新規ファイルは更新を要しない_
