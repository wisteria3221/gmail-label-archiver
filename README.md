# gmail-label-archiver

Gmail の指定ラベルが付いたスレッドを、ラベルごとに設定した保持日数を超えたら受信トレイから自動でアーカイブする Google Apps Script (GAS) ツールです。アーカイブ対象・保持日数は Google スプレッドシートで管理し、日次トリガーで無人運用できます。

## 特徴

- **ラベル単位の保持期間管理** — 「このラベルは 30 日、別のラベルは 7 日」といったルールをスプレッドシートで宣言的に設定。
- **親ラベル指定で配下も対象** — 親ラベル（例: `仕事`）を指定すると、配下の子孫ラベル（`仕事/案件A`、`仕事/案件A/議事録` など）にも同じ保持日数を自動適用。
- **非破壊なアーカイブのみ** — 受信トレイから外す（標準アーカイブ）だけ。削除・ゴミ箱移動・既読変更・他ラベルの変更は一切行いません。
- **スター付き・新着を保護** — スター付きスレッド、保持日数を超えていないスレッドは対象外。
- **権威的な再判定** — Gmail 検索の近似フィルタに頼らず、最新メッセージ日時とスター有無をコード側で再判定してからアーカイブ。
- **実行予算と持ち越し** — 1 回の実行で処理する上限（既定 300 件）を超えた分は受信トレイに残し、次回実行へ持ち越し。予算はルール間で公平に配分されるため、滞留の多いラベルが他のラベルを締め出さない。
- **冪等な日次トリガー** — セットアップを何度実行してもトリガーは常に 1 件。
- **自動デプロイ** — `main` への push でテスト通過を条件に GitHub Actions が GAS へ同期。

## 仕組み

日次トリガー（または手動実行）で `archiveLabeledThreads` が呼ばれ、以下を実行します。

1. **設定読取** — Script Property が指すスプレッドシートを読み、各行を検証して有効なルール（ラベル名・保持日数）を取得。構成不備（ID 未設定・シート不在・ヘッダ不一致）はログに記録したうえで例外として終了（トリガー失敗通知メールが届く）。有効ルールが 0 件なら何もせず終了。
2. **親ラベルの展開** — Gmail の全ユーザーラベルを取得し、各ルールのラベル名を親とみなして配下の子孫ラベルへ保持日数を継承したルールを追加。子孫に明示ルールがあればそちらを優先し、複数の祖先がある場合は最も近い（最長一致の）親を採用。ラベル名の照合は大文字小文字を区別しない（Gmail と同じ）。
3. **ルールごとに処理** — 各ラベルについて `label:"<ラベル名>" in:inbox -is:starred older_than:<保持日数>d` で候補を検索。検索条件はメッセージ単位で効くため（最近の返信があるスレッド等もヒットする）、`ARCHIVE_SEARCH_LIMIT` 件ずつページングし、1 ルールあたり最大 `ARCHIVE_SCAN_LIMIT_PER_RULE` 件まで走査する。
4. **権威的再判定** — 候補のうち「最新メッセージが保持日数を厳密に超える」かつ「スター無し」のスレッドだけを確定対象にする。親子両方のラベルが付いたスレッドなど、複数ルールにヒットするスレッドは 1 回の実行内で 1 回だけ処理・計数する。
5. **バッチアーカイブ** — 確定対象を 100 件単位で `moveThreadsToArchive`。実行全体の予算をルール間で公平に配分（各ルールに「残予算 ÷ 残ルール数」を割当て、使い残しは後続ルールへ、割当を使い切ったルールには 2 巡目で残りを配分）し、超過分は次回へ持ち越し。
6. **サマリ出力** — 処理ルール数・ルール別件数・エラー数・残予算を実行ログへ出力。ルール単位のエラーは記録のうえ次のルールへ継続し、1 件以上あればサマリ出力後に例外として終了（トリガー失敗通知メールで気づける）。

## 設定スプレッドシート

1 行目をヘッダ、2 行目以降をデータ行として読みます。

| ラベル名 | 保持日数 |
|---|---|
| アーカイブ/ニュースレター | 30 |
| アーカイブ/通知 | 7 |

- **ラベル名** — 対象の Gmail ラベル名（空白・階層ラベル `親/子` も可）。空欄の行はスキップ。親ラベルを指定すると配下の子孫ラベルにも同じ保持日数が適用される（子孫を個別の行で指定するとそちらが優先）。
- ラベル名に二重引用符 `"` を含むラベルは Gmail 検索を正しく組めないため、実行ログに `ℹ️ [スキップ]` を出して処理対象外になる。

> **複数のルールに該当するスレッド**: 1 つのスレッドに複数の対象ラベルが付いている場合（例: フィルタで `A` と `A/B` の両方が付いた）、それぞれのルールで判定され、**最も短い保持日数を満たした時点でアーカイブ**されます。例えば `A`=7 日・`A/B`=30 日なら、そのスレッドは 7 日超でアーカイブされます。長く残したいスレッドには短い保持日数のラベルを付けないか、スターを付けてください。
- **保持日数** — 正の整数のみ有効。非数値・負数・0・小数の行はスキップ。

> ヘッダ名（`ラベル名` / `保持日数`）は完全一致が必要です。列の順序は問いません（ヘッダ名で解決）。
> 検証用のサンプルは [docs/sample-settings.csv](docs/sample-settings.csv) を参照。

## セットアップ

### 前提

- Google アカウント（個人 Gmail）
- [clasp](https://github.com/google/clasp) v3（`npx @google/clasp@3`）と Node.js 24（`.node-version` で指定）

### 手順

1. **Apps Script プロジェクトを用意** — Apps Script で新規プロジェクトを作成し（または既存プロジェクトを使い）、URL（`https://script.google.com/.../projects/<scriptId>/edit`）から `scriptId` を控える。
2. **ローカル用プロジェクトファイルを作成** — `.clasp.json` をコピーして `.clasp.json.local` を作り、`scriptId` を実 scriptId に書き換える。
   ```sh
   jq --arg id '<scriptId>' '.scriptId = $id' .clasp.json > .clasp.json.local
   ```
   > リポジトリにコミットされている [.clasp.json](.clasp.json) の `scriptId` は placeholder（`REPLACE_WITH_YOUR_SCRIPT_ID`）で、**書き換えずにそのまま維持します**（自動デプロイでは Secret から注入されます。下記参照）。`.clasp.json.local` は `.gitignore` 済みです。リポジトリ直下で `clasp create` / `clasp clone` を実行すると `.clasp.json` が上書きされるため避けてください。
3. **ソースを反映** — `npx @google/clasp@3 -P .clasp.json.local push` で `src/` を Apps Script へ同期。
4. **Script Property を登録** — Apps Script エディタ → プロジェクトの設定 → スクリプト プロパティ:
   - `CONFIG_SPREADSHEET_ID` = 設定スプレッドシートの ID（**必須**）
   - `CONFIG_SHEET_NAME` = シート名（任意。省略時は `settings`）
5. **日次トリガーを作成** — Apps Script エディタで `setupDailyTrigger` を 1 回実行（既定で毎日 3 時台に実行）。初回実行時に OAuth 同意（Gmail / Spreadsheet / トリガー権限）を承認。
6. **動作確認** — `archiveLabeledThreads` を手動実行し、実行ログと Gmail の状態を確認。

手動での統合検証手順は [docs/manual-verification.md](docs/manual-verification.md) を参照してください。

## 自動デプロイ（GitHub Actions）

`main` への push をトリガーに、テスト通過を条件として GAS へ自動デプロイします（[.github/workflows/deploy.yml](.github/workflows/deploy.yml)）。

- `test` ジョブで `npm test` を実行し、成功時のみ `deploy` ジョブへ進む（`needs: test` ゲート）。
- `deploy` ジョブは Secret から認証情報と scriptId を展開し、`clasp push --force` で `src/` を同期。

必要な GitHub Secrets:

| Secret | 内容 |
|---|---|
| `CLASPRC_JSON` | `clasp login`（v3）で生成された `~/.clasprc.json` の全文（`{"tokens": {"default": {...}}}` 形式） |
| `GAS_SCRIPT_ID` | デプロイ先 GAS プロジェクトの実 scriptId（コミット版 `.clasp.json` の placeholder に注入される） |

セットアップ・運用・トークン失効時の復旧手順は [docs/deploy-setup.md](docs/deploy-setup.md) に詳述しています。

## 開発

```sh
npm test   # node --test で純粋ロジックの単体テストを実行
```

### プロジェクト構成

| パス | 役割 |
|---|---|
| [src/Constants.js](src/Constants.js) | 共有定数（Script Property キー、ヘッダ名、各種上限、トリガー設定） |
| [src/Config.js](src/Config.js) | 設定シートの読取と行バリデーション（ConfigService） |
| [src/Archiver.js](src/Archiver.js) | ルール単位の対象抽出・権威的判定・バッチアーカイブ（ArchiveService） |
| [src/Main.js](src/Main.js) | エントリポイント・オーケストレーション・トリガー管理 |
| [src/appsscript.json](src/appsscript.json) | GAS マニフェスト（タイムゾーン・ランタイム・OAuth スコープ） |
| [test/](test/) | 各サービスの単体テスト |

> GAS ランタイムでは `src/*.js` が 1 つのグローバルスコープに連結されるため、各ファイルの top-level 関数はそのままグローバル公開されます。各ファイル末尾の `module.exports` ガードは、Node のテストランナーから `require()` できるようにするためのもので、GAS では評価されません。

### 主な定数（[src/Constants.js](src/Constants.js)）

| 定数 | 既定値 | 意味 |
|---|---|---|
| `MAX_THREADS_PER_RUN` | 300 | 1 回の実行全体で処理するスレッド数の上限 |
| `ARCHIVE_BATCH_SIZE` | 100 | `moveThreadsToArchive` の 1 回あたり件数 |
| `ARCHIVE_SEARCH_LIMIT` | 500 | `GmailApp.search` の 1 回あたり上限（ページサイズ） |
| `ARCHIVE_SCAN_LIMIT_PER_RULE` | 1000 | 1 ルールあたりに走査する候補スレッド数の上限（実行時間対策） |
| `TRIGGER_HOUR` | 3 | 日次トリガーの実行時刻（時） |
| `DEFAULT_SHEET_NAME` | `settings` | シート名未指定時の既定シート名 |

## ライセンス

このリポジトリにライセンスは指定されていません。
