# デプロイ・CI 運用

GitHub Actions による GAS への自動デプロイの運用方針とパターン。詳細なセットアップ手順は `docs/deploy-setup.md`、設計の根拠は `.kiro/specs/gas-auto-deploy/` を参照。ここでは「なぜそうしているか」と日常運用で守るべきパターンに絞る。

## 方針

- main への push のみがデプロイの起点。手動 push や PR ではデプロイしない（環境の出し分けやプレビューデプロイは持たない）。
- 「テスト → デプロイ」の一方向ゲート。壊れたコードを GAS に流さないことが最優先。
- デプロイ粒度は `clasp push`（ソース同期）のみ。versioned deploy（`clasp deploy`）は意図的に対象外。
- 機密（認証情報・実 scriptId）は一切リポジトリに置かず、Secret 経由でランナー上に揮発的に展開する。

## CI フロー

```
main へ push → test ジョブ（npm test）→ [成功時のみ] deploy ジョブ → clasp push --force
```

- ワークフロー定義は `.github/workflows/deploy.yml` の 1 本のみ。
- `deploy` は `needs: test` でゲートされる。テスト失敗時は deploy がスキップされ、ワークフロー全体が failure になる。
- `concurrency: deploy-gas` / `cancel-in-progress: false` で deploy を直列化する。連続 push 時に `clasp push` が並走して GAS 側を競合更新するのを防ぐため、実行中のデプロイは中断せず順番待ちにする。

## Secret とその WHY

自動デプロイには 2 つの Repository Secret が**両方**必要。片方欠けると deploy が失敗する。

| Secret | 用途 | WHY |
| --- | --- | --- |
| `CLASPRC_JSON` | clasp の OAuth 認証情報（`~/.clasprc.json` 全文） | 非対話で `clasp push` を成立させるため。GCP サービスアカウントではなく clasp ログイントークン方式を採用。 |
| `GAS_SCRIPT_ID` | デプロイ先 GAS プロジェクトの実 scriptId | 実 scriptId をリポジトリにコミットせず、デプロイ時にのみ注入してリポジトリを可搬・公開可能に保つため。 |

ワークフロー内の受け渡しパターン（`deploy.yml`）:

- 認証展開: `env: CLASPRC_JSON` 経由で受け取り `printf '%s' "$CLASPRC_JSON" > "$HOME/.clasprc.json"`。コマンド行やログにトークンを露出させない。
- scriptId 注入: `env: GAS_SCRIPT_ID` 経由で受け取り `jq --arg id "$GAS_SCRIPT_ID" '.scriptId = $id' .clasp.json` で `.clasp.json` の `scriptId` のみ差し替え（`rootDir` 等は保持）。
- 順序は「認証展開 → scriptId 注入 → `clasp push`」。注入は push より前に必ず行う。
- いずれもランナー上のファイルはジョブ終了で揮発し、リポジトリには永続化しない。

## .clasp.json の placeholder パターン

- コミット版 `.clasp.json` の `scriptId` は placeholder（`REPLACE_WITH_YOUR_SCRIPT_ID`）に固定し、実 scriptId はコミットしない。
- 実 scriptId は `GAS_SCRIPT_ID` でのみ管理し、CI が注入する。ローカルで実値に書き換えても**コミットしない**こと（push 時に placeholder へ戻す／追跡対象外の `.clasp.json` を使う）。
- `.clasprc.json` は `.gitignore` 済み。認証情報は常に Secret 経由でのみ扱う。

## clasp / ランナーのバージョン固定

- clasp は v3 系に固定（`npx @google/clasp@3`）。Node 20 ランナー前提。
- 認証ファイルは v3 の `tokens` マップ形式（`{"tokens": {"default": {...}}}`）。v2 のフラット形式を `CLASPRC_JSON` に貼ると `default` を読めず "not logged in" 相当で失敗する。Secret 登録・更新は必ず `clasp login`（v3）で生成したファイルの全文を verbatim で使う。

## CI 外の前提（一度きりの手動作業）

CI では自動化できないため、初回セットアップで手動実施する（詳細は `docs/deploy-setup.md`）。

- Apps Script API の有効化: <https://script.google.com/home/usersettings> で ON。未設定だと `clasp push` が API エラーで失敗する。
- OAuth 同意画面の公開設定: 「テスト中」のままだとリフレッシュトークンが**約 7 日で失効**する。失効を避けるため「公開（In production）」に切り替えるのが推奨。テスト中で運用する場合は定期的な Secret 更新を受け入れる。

## トークン失効時の復旧

`deploy` の `clasp push` が認証エラー（invalid_grant / not logged in 相当）で失敗し、Actions ログに原因が残る。復旧パターン:

1. ローカルで再ログイン: `npx @google/clasp@3 login`（`~/.clasprc.json` が更新される）。
2. Secret `CLASPRC_JSON` を新しい `~/.clasprc.json` の全文で更新する。
3. 失敗したワークフローを `Re-run jobs` で再実行、または main へ新規 push する。

失効頻度を根本的に下げたい場合は OAuth 同意画面を公開設定にする。

## 失敗ハンドリングの原則

- 各ステップ（test / 認証展開 / scriptId 注入 / push）の成否は Actions 実行ログで確認できる。
- 失敗は抑制しない（`|| true` 等で握りつぶさない）。clasp の非0終了をそのまま job の failure として伝播させ、デプロイ未完了を可視化する。

---
_運用パターンと判断の根拠を記述する。網羅的な手順は `docs/deploy-setup.md` に委ねる。_
