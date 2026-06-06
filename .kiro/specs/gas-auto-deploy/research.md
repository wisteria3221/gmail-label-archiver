# Research & Design Decisions

## Summary
- **Feature**: `gas-auto-deploy`
- **Discovery Scope**: Extension（既存 clasp/GAS プロジェクトへの CI/CD 追加）
- **Key Findings**:
  - `@google/clasp` v3.3.0（2026-03 時点の最新）。Node >= 20 が必須。CLI として `npx` 実行するため、プロジェクトの CommonJS/ESM 設定は clasp 認証に無関係。
  - clasp v3 の認証ファイルは `~/.clasprc.json`、構造は v2 のフラット形式ではなく `{"tokens": {"default": {...}}}` 形式。これをそのまま GitHub Secret 化する。
  - CI 外の前提条件が 2 つ存在：(1) アカウント設定での Apps Script API 有効化、(2) OAuth 同意画面が「テスト中」のままだとリフレッシュトークンが約7日で失効する点。

## Research Log

### clasp の CI 非対話認証
- **Context**: GitHub Actions から `clasp push` を非対話で実行する必要がある。
- **Sources Consulted**: @google/clasp v3.3.0 ソース（`file_credential_store.js` / `auth.js`）、google/clasp README、Apps Script clasp ガイド、clasp issue #854（トークン形式）。
- **Findings**:
  - 認証ファイルのデフォルトパスは `path.join(os.homedir(), '.clasprc.json')`、既定アカウントキーは `"default"`。
  - v3 形式は `tokens` マップ（`type: authorized_user`, `client_id`, `client_secret`, `refresh_token`, `access_token`, `expiry_date`）。
  - `--auth <file>` は v3 で非推奨。ホームディレクトリの既定ファイルを使う。
  - `push --force`（`-f`）で上書き確認プロンプトを抑止。
  - 成功時にランナー上の `~/.clasprc.json` がトークン更新されることがあるが、CI では揮発するため問題なし（refresh_token が有効な限り）。
- **Implications**: ワークフローは Secret を `~/.clasprc.json` に書き出し、`npx @google/clasp@3 push --force` を実行する。Secret 名は `CLASPRC_JSON`。

### デプロイ対象とテスト構成（既存コードベース）
- **Context**: 何がデプロイされ、テストがどう実行されるかを確認。
- **Findings**:
  - `.clasp.json` は `scriptId` と `rootDir: "src"` を保持。`scriptId` は秘匿情報ではなくリポジトリにコミット済み。
  - `src/` に GAS ソース（`*.js` + `appsscript.json`）。`.claspignore` は存在しないが、テストは `test/`（src 外）にあるため push 対象に含まれない。
  - テストは `node:test` ベース（`test/*.test.js`）。`package.json` の `test` スクリプトは `node --test`。外部依存（dependencies）は無し。
- **Implications**: CI で `npm install`/`npm ci` は不要。`node --test`（または `npm test`）のみでテスト実行可能。clasp の追加設定（`.claspignore`）も不要。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 単一ジョブ・逐次ステップ | 1 ジョブ内で test → deploy を順に実行 | 構成が最小 | ゲートが UI 上で暗黙的 | 採用可だが下記を優先 |
| 2 ジョブ（test → deploy needs test） | test ジョブ成功を条件に deploy ジョブ実行 | ゲートが明示的、Actions UI で成否が分離表示、要件5の可視性に合致 | わずかに記述量増 | **採用** |
| GCP サービスアカウント認証 | clasp ではなく Apps Script API を SA で叩く | トークン失効に強い | GCP プロジェクト/ドメイン委任の準備が重い、スコープ外 | 不採用（要件の Out of scope） |

## Design Decisions

### Decision: 2 ジョブ構成（test ゲート → deploy）
- **Context**: 要件2（テスト通過を条件にデプロイ）と要件5（各ステップの成否可視化）。
- **Alternatives Considered**:
  1. 単一ジョブ逐次ステップ — 最小だがゲートが暗黙的。
  2. 2 ジョブ `needs` 依存 — ゲートと可視性が明示的。
- **Selected Approach**: `test` ジョブと `deploy` ジョブを定義し、`deploy.needs: test`。test 失敗時は deploy がスキップされワークフローが失敗。
- **Rationale**: GitHub Actions UI 上でテスト失敗とデプロイ失敗が区別でき、要件5の可視性を自然に満たす。ゲートが宣言的。
- **Trade-offs**: チェックアウト等が両ジョブで重複するが、無依存・短時間のため許容。
- **Follow-up**: deploy ジョブのトリガー条件を `push` かつ `ref == main` に限定する。

### Decision: clasp トークンの Secret 受け渡し方式
- **Context**: 要件4（認証情報を Secrets で管理、リポジトリに永続化しない）。
- **Selected Approach**: Secret `CLASPRC_JSON`（v3 `tokens` 形式 JSON）を、シェルのクォート破壊を避けるため環境変数経由で `~/.clasprc.json` に書き出す（`printf '%s' "$CLASPRC_JSON" > "$HOME/.clasprc.json"`）。
- **Rationale**: ホームディレクトリ既定パスを使えば `--auth`（非推奨）を避けられる。env 経由ファイル化で JSON 内特殊文字の事故を防ぐ。
- **Trade-offs**: ランナー上に一時的に平文の認証情報が置かれるが、ジョブ終了で破棄される。
- **Follow-up**: Secret 不在/無効時に clasp が失敗終了し、ワークフローが失敗することを確認。

### Decision: scriptId の Secret 化とデプロイ時注入（後追い決定）
- **Context**: ユーザー方針により、デプロイ先 scriptId をリポジトリにコミットせず GitHub Secrets で管理する。clasp は `scriptId` を `.clasp.json` から読むため、CI 実行時に注入が必要。
- **Alternatives Considered**:
  1. `.clasp.json` を gitignore 化し CI で全体生成 — リポジトリに scriptId が一切残らず diff も出ないが、`.clasp.json` を git 管理から外す変更が必要。
  2. placeholder を commit し CI で scriptId を上書き — `rootDir` 等がリポジトリに見え、変更が小さい。ローカルは実 id を未コミットで保持（常に diff）。
- **Selected Approach**: 案2。コミット版 `.clasp.json` は placeholder `scriptId` を維持。deploy ジョブで Secret `GAS_SCRIPT_ID` を `env:` 経由で受け取り、`jq --arg id "$GAS_SCRIPT_ID" '.scriptId = $id'` で `.clasp.json` に注入してから `clasp push`。
- **Rationale**: 変更が最小で `rootDir` 等の設定がリポジトリに残る。`jq` は GitHub ホスト ubuntu ランナーにプリインストール済み。`env:` + `jq --arg` で scriptId がコマンド行/ログに露出しない。
- **Trade-offs**: ローカルの `.clasp.json`（実 id）が常に未コミット diff として残る。scriptId 未設定/空時は placeholder のまま clasp が失敗（早期検知される）。
- **Follow-up**: ドキュメントに `GAS_SCRIPT_ID` 登録手順を追記。

### Decision: clasp のバージョン固定（@3）
- **Context**: メジャーバージョン更新による破壊的変更（v2→v3 の認証形式変更実績）を避ける。
- **Selected Approach**: `npx @google/clasp@3 push --force` とメジャー固定で実行。
- **Rationale**: 認証ファイル形式はメジャー間で変わりうるため、Secret 形式と CLI を同一メジャーに揃える。

## Risks & Mitigations
- **リフレッシュトークンの失効（最大の運用リスク）** — OAuth 同意画面が「テスト中」だと約7日で失効。→ 同意画面を公開設定にする手順と、失効時の Secret 再登録手順をドキュメント化（要件6.3/6.4）。
- **Apps Script API 未有効化でデプロイ失敗** — CI では有効化できない。→ セットアップ手順に必須前提として明記（要件6.2）。
- **Secret の JSON 形式誤り（v2 フラット形式を貼ってしまう）** — `load("default")` が null になり「not logged in」。→ ドキュメントで v3 `tokens` 形式を明示し、`clasp login` 後の `~/.clasprc.json` をそのまま貼ると案内（要件6.1）。
- **main 以外への push での誤デプロイ** — → ワークフローのトリガーを `branches: [main]` に限定（要件1.2）。
- **連続 push による `clasp push` の並走/反映順序事故** — → ワークフローに `concurrency: { group: deploy-gas, cancel-in-progress: false }` を設定し deploy を直列化（design review Issue 1 対応）。

## References
- [@google/clasp (npm)](https://www.npmjs.com/package/@google/clasp) — v3.3.0、Node>=20、認証ファイル形式
- [google/clasp README](https://github.com/google/clasp) — Apps Script API 有効化要件、`--user`/`--auth` 仕様
- [clasp CLI ガイド](https://developers.google.com/apps-script/guides/clasp) — push/deploy の概念差
- [clasp issue #854](https://github.com/google/clasp/issues/854) — トークン形式の変更経緯
