# 自動デプロイ セットアップ・運用ガイド

本ドキュメントは、GitHub Actions による GAS（Google Apps Script）への自動デプロイを成立させるための、CI 外の前提作業と運用・復旧手順をまとめたものです。

## デプロイの仕組み（前提知識）

- **トリガー**: `main` ブランチへの push をトリガーにワークフロー（`.github/workflows/deploy.yml`）が起動します。`main` 以外への push や PR では起動しません。
- **テストゲート**: ワークフローはまず `test` ジョブで `npm test`（`node --test`）を実行します。`deploy` ジョブは `needs: test` でゲートされており、**テストが成功した場合のみ**デプロイへ進みます。テスト失敗時はデプロイがスキップされ、ワークフローは失敗で終了します。
- **デプロイ内容**: `deploy` ジョブが Secret `CLASPRC_JSON` をランナー上の `~/.clasprc.json` に展開し、続いて Secret `GAS_SCRIPT_ID` の値を `jq` で `.clasp.json` の `scriptId` フィールドへ注入したうえで、`npx @google/clasp@3 push --force` を実行して `.clasp.json` の `scriptId` が指す GAS プロジェクトへ `src/` 配下を同期します（ソース同期のみ。バージョン付きデプロイは行いません）。
- **scriptId の扱い**: リポジトリにコミットされている `.clasp.json` の `scriptId` は placeholder（`REPLACE_WITH_YOUR_SCRIPT_ID`）であり、実際の scriptId はリポジトリに含めません。実 scriptId は Secret `GAS_SCRIPT_ID` でのみ管理し、デプロイ時にワークフローが注入します。したがって自動デプロイには `CLASPRC_JSON` と `GAS_SCRIPT_ID` の **両方** の Secret が必要です。
- **clasp バージョン**: clasp v3 系（`@google/clasp@3`、Node 20）に固定しています。認証ファイルの形式は v3 仕様（後述の `tokens` 形式）です。

自動デプロイを成立させるには、以下の **5 つの前提作業 / 運用手順** が必要です。順に実施してください。

---

## 1. GitHub Secret `CLASPRC_JSON` の登録（要件 6.1）

ワークフローはローカルで `clasp login` 済みの認証情報を GitHub Secret `CLASPRC_JSON` から取得します。以下の手順で登録します。

### 手順

1. **ローカルで clasp v3 にログインする**

   clasp v3 を使ってログインします（メジャーバージョンをワークフローと揃えるため `@3` を指定）。

   ```sh
   npx @google/clasp@3 login
   ```

   ブラウザが開くので、対象の GAS プロジェクトを所有する Google アカウントで認証を完了します。成功すると認証情報がホームディレクトリの `~/.clasprc.json` に保存されます。

2. **`~/.clasprc.json` の内容を確認する**

   clasp v3 の `~/.clasprc.json` は次のような **`tokens` マップ形式**です（値はアカウントごとに異なります。下記はあくまで構造を示すサンプルで、実在のトークンではありません）。

   ```json
   {
     "tokens": {
       "default": {
         "type": "authorized_user",
         "client_id": "<client_id>",
         "client_secret": "<client_secret>",
         "refresh_token": "<refresh_token>",
         "access_token": "<access_token>",
         "token_type": "Bearer",
         "expiry_date": 0
       }
     }
   }
   ```

   > **注意（よくある失敗）**: clasp v2 の旧形式は `tokens` でラップされていないフラットな形式（トップレベルに `access_token` / `refresh_token` が並ぶ）です。**旧 v2 フラット形式を貼り付けると、clasp v3 は既定アカウント `default` を読み込めず "not logged in" 相当のエラーで失敗します。** 必ず `clasp login`（v3）で生成された、`{"tokens": {"default": {...}}}` 形式のファイルを使ってください。

3. **ファイルの内容をそのまま Secret に登録する**

   GitHub リポジトリの画面で次の順に進みます。

   - `Settings` → `Secrets and variables` → `Actions` → `New repository secret`

   - **Name**: `CLASPRC_JSON`（ワークフローが参照する名前と完全一致させること。大文字・アンダースコア含めて正確に）
   - **Secret**: `~/.clasprc.json` の**全文をそのまま（verbatim で）**貼り付ける。整形・改変・一部抜粋はしないこと。

   `Add secret` を押して保存します。

   ローカルで内容をコピーする場合の例:

   ```sh
   # macOS
   cat ~/.clasprc.json | pbcopy
   # Linux (xclip がある場合)
   cat ~/.clasprc.json | xclip -selection clipboard
   ```

> 認証情報はリポジトリにはコミットせず、必ず Secret 経由でのみ受け渡します。ランナー上に展開された `~/.clasprc.json` はジョブ終了時に破棄されます。

---

## 2. GitHub Secret `GAS_SCRIPT_ID` の登録（要件 6.1）

ワークフローはデプロイ先 GAS プロジェクトの scriptId を GitHub Secret `GAS_SCRIPT_ID` から取得し、`.clasp.json` の `scriptId` フィールドへ注入します。リポジトリにコミットされている `.clasp.json` の `scriptId` は placeholder（`REPLACE_WITH_YOUR_SCRIPT_ID`）であり、**実 scriptId はリポジトリにはコミットせず、本 Secret でのみ管理します**。以下の手順で登録します。

### `GAS_SCRIPT_ID` とは

- デプロイ先 GAS プロジェクトの **scriptId** です。ローカルの（リポジトリには追跡されない）`.clasp.json` の `scriptId` の値、または Apps Script プロジェクトの URL（`https://script.google.com/.../projects/<scriptId>/edit` の `<scriptId>` 部分）から取得できます。`clasp` で初期セットアップ（`clasp clone` / `clasp create`）を行った場合は、生成された `.clasp.json` の `scriptId` に該当します。

### 手順

1. **scriptId を確認する**

   ローカルの `.clasp.json` の `scriptId` フィールドの値を控えます。

   ```sh
   jq -r '.scriptId' .clasp.json
   ```

   > 注意: リポジトリにコミットされている `.clasp.json` の `scriptId` は placeholder（`REPLACE_WITH_YOUR_SCRIPT_ID`）です。実 scriptId はローカルの追跡対象外 `.clasp.json` か Apps Script プロジェクトの URL から取得してください。

2. **scriptId を Secret に登録する**

   GitHub リポジトリの画面で次の順に進みます。

   - `Settings` → `Secrets and variables` → `Actions` → `New repository secret`

   - **Name**: `GAS_SCRIPT_ID`（ワークフローが参照する名前と完全一致させること。大文字・アンダースコア含めて正確に）
   - **Secret**: 確認した scriptId の値（例: `<your-script-id>`）。前後の空白や引用符を含めないこと。

   `Add secret` を押して保存します。

> 実 scriptId はリポジトリにコミットせず、必ず Secret 経由でのみ受け渡します。コミットされた `.clasp.json` は placeholder のままに保ち、ワークフローがデプロイ時に `GAS_SCRIPT_ID` の値を注入します。**自動デプロイを成立させるには、`CLASPRC_JSON`（前項）と本 `GAS_SCRIPT_ID` の両方の Secret が登録されている必要があります。**

---

## 3. Apps Script API の事前有効化（要件 6.2）

`clasp push` を実行するには、認証に使う Google アカウントで **Apps Script API が有効化されている必要があります**。これは CI からは有効化できないため、事前にブラウザで設定してください。

### 手順

1. ブラウザで以下を開きます。

   <https://script.google.com/home/usersettings>

2. **「Google Apps Script API」**のトグルを **ON** にします。

3. `clasp login` で認証したアカウントと同じアカウントで設定していることを確認します。

> 有効化していない場合、`deploy` ジョブの `clasp push` が API エラーで失敗します（User has not enabled the Apps Script API 相当）。この前提は CI では自動化できないため、初回セットアップ時に必ず実施してください。

---

## 4. OAuth 同意画面の公開設定（リフレッシュトークン失効の回避・要件 6.3）

> **重要な運用上の注意**

`clasp login` で得られるリフレッシュトークンの寿命は、認証に使う Google Cloud プロジェクトの **OAuth 同意画面の公開ステータス**に依存します。

- 同意画面が **「テスト中（Testing）」**のままの場合、**リフレッシュトークンは約 7 日で失効**します。失効すると CI の `deploy` ジョブが認証エラーで失敗し続けるようになります。
- これを回避するには、OAuth 同意画面を **「公開（本番 / In production）」**ステータスにしてください。公開設定にすると、リフレッシュトークンの短期失効が起きなくなります。

### 対応方針（いずれか）

- **推奨**: Google Cloud Console の `APIs & Services` → `OAuth consent screen` で、同意画面を **公開（In production）** に切り替える。これにより約 7 日での自動失効を回避できます。
- **代替**: 同意画面を「テスト中」のまま運用する場合は、**約 7 日ごとにトークンが失効する**ことを前提とし、後述の「5. トークン失効時の復旧手順」で定期的に Secret を更新する運用を受け入れてください。

---

## 5. トークン失効時の復旧手順（要件 6.4）

リフレッシュトークンが失効すると、`deploy` ジョブの `clasp push` が認証エラー（invalid_grant / not logged in 相当）で失敗します。Actions の実行ログにエラーが記録されます。以下の手順で復旧します。

### 手順

1. **ローカルで再ログインする**

   ```sh
   npx @google/clasp@3 login
   ```

   ブラウザで対象アカウントの認証を再度完了します。`~/.clasprc.json` が新しいトークンで更新されます。

2. **Secret `CLASPRC_JSON` を更新する**

   GitHub リポジトリの `Settings` → `Secrets and variables` → `Actions` を開き、既存の `CLASPRC_JSON` を選んで `Update`（更新）します。更新後の `~/.clasprc.json` の**全文をそのまま**貼り付けて保存します（「1. GitHub Secret の登録」と同じ要領）。

3. **失敗したワークフローを再実行する**

   GitHub の `Actions` タブから、失敗した `Deploy to GAS` の実行を開き、`Re-run jobs`（再実行）を行います。あるいは `main` に新しい push を行うと、新しい Secret でデプロイが再試行されます。

> 根本的に失効頻度を下げたい場合は、「4. OAuth 同意画面の公開設定」を実施してください。同意画面が「テスト中」のままだと、約 7 日ごとに本手順での再登録が必要になります。

---

## チェックリスト（初回セットアップ）

- [ ] ローカルで `clasp login`（v3）が完了し、`~/.clasprc.json` が `{"tokens": {"default": {...}}}` 形式である
- [ ] Secret `CLASPRC_JSON` に `~/.clasprc.json` の全文を verbatim で登録した
- [ ] Secret `GAS_SCRIPT_ID` にデプロイ先 GAS プロジェクトの実 scriptId を登録した（コミット版 `.clasp.json` は placeholder のまま）
- [ ] <https://script.google.com/home/usersettings> で Apps Script API を有効化した
- [ ] OAuth 同意画面を公開設定にした（または約 7 日ごとの Secret 更新運用を受け入れた）
- [ ] `main` への push でワークフローが起動し、テスト通過後に GAS へ反映されることを確認した

上記をすべて満たすと、`main` への push でテスト通過を条件とした GAS への自動デプロイが成立します。
