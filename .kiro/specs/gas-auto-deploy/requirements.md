# Requirements Document

## Introduction
clasp ベースの Google Apps Script (GAS) プロジェクトにおいて、現状デプロイは開発者がローカルから手動で実行する必要があり、コミットとデプロイの乖離（GitHub 上のソースと GAS 上の実行コードの不一致）が起こりうる。本機能は、main ブランチへの push をトリガーに、テスト通過を条件として GAS にソースを自動反映する CI/CD パイプラインを GitHub Actions 上に整備する。認証情報はリポジトリにコミットせず GitHub Secrets で管理し、デプロイ粒度はソース同期（clasp push 相当）のみとする。

このパイプラインの成立には、GAS 側の API 有効化や OAuth 同意画面の設定など CI 外の前提条件が存在するため、それらの運用手順もドキュメントとして整備する。

## Boundary Context
- **In scope**:
  - main への push をトリガーとする自動デプロイの起動
  - デプロイ前のテスト実行と、テスト通過を条件としたデプロイ
  - clasp を用いた GAS へのソース同期デプロイ
  - 認証情報の GitHub Secrets による管理と非対話認証
  - デプロイ成否の可視化と失敗ハンドリング
  - デプロイ先 scriptId の Secret 管理とデプロイ時注入（リポジトリに実 scriptId をコミットしない）
  - セットアップ・運用前提のドキュメント化
- **Out of scope**:
  - versioned deploy（バージョン付きデプロイ / Web アプリ・API 実行版の公開）
  - GCP サービスアカウントによる認証方式
  - GitHub リポジトリの作成・リモート設定（ユーザー側で用意済み）
  - PR プレビューデプロイや複数環境（staging / prod）への出し分け
  - GAS の時間主導トリガー設定やアプリケーションロジックの変更
- **Adjacent expectations**:
  - デプロイ対象ソース（`gmail-label-archiver` が所有する `src/` 配下）は本機能の入力であり、その内容には干渉しない
  - 既存のテストスイート（`node --test`）をそのまま利用し、テストの追加・改変は行わない
  - clasp プロジェクト設定（`.clasp.json`）はリポジトリに placeholder の `scriptId` をコミットした状態を維持し、実 scriptId は Secret から供給する
  - `rootDir` 等 scriptId 以外の clasp 設定は既存のものを利用する

## Requirements

### Requirement 1: プッシュトリガーによる自動デプロイ起動
**Objective:** 開発者として、main ブランチへ push したときに自動でデプロイ処理が開始されてほしい。これにより手動デプロイの手間とデプロイ忘れをなくすため。

#### Acceptance Criteria
1. When main ブランチへ push が発生したとき, the デプロイパイプライン shall 自動的にデプロイ処理を起動する。
2. If push が main 以外のブランチに対して発生した場合, then the デプロイパイプライン shall GAS へのデプロイを実行しない。
3. The デプロイパイプライン shall 開発者の手動操作なしに、起動からデプロイ完了まで一連の処理を実行する。

### Requirement 2: テスト通過を条件とするデプロイゲート
**Objective:** 開発者として、テストに失敗したコードが本番の GAS に反映されないようにしてほしい。これにより壊れたコードのデプロイ事故を防ぐため。

#### Acceptance Criteria
1. When デプロイパイプラインが起動したとき, the デプロイパイプライン shall デプロイの前に既存のテストスイートを実行する。
2. While テストが成功した状態のとき, the デプロイパイプライン shall デプロイ処理へ進む。
3. If テストが失敗した場合, then the デプロイパイプライン shall デプロイ処理を実行せず、ワークフローを失敗として終了する。

### Requirement 3: clasp による GAS へのソース同期デプロイ
**Objective:** 開発者として、テスト通過後に最新ソースが GAS スクリプトへ反映されてほしい。これにより GitHub 上のコードと実行環境を一致させるため。

#### Acceptance Criteria
1. When テストが成功したとき, the デプロイパイプライン shall clasp を用いて `src/` 配下のソースを対象 GAS スクリプトへ反映する。
2. The デプロイパイプライン shall 上書き確認などの対話入力を求めずに、非対話でデプロイを完了する。
3. The デプロイパイプライン shall ソース同期のみを行い、versioned deploy（バージョン付きデプロイ）を作成しない。
4. When デプロイ処理を行うとき, the デプロイパイプライン shall Secret から取得した scriptId を `.clasp.json` に注入したうえで、その scriptId が指す GAS スクリプトをデプロイ先として決定する。

### Requirement 4: 認証情報と scriptId のセキュアな管理
**Objective:** プロジェクト管理者として、デプロイ用の認証情報を安全に管理したい。これにより認証情報の漏洩を防ぎつつ自動デプロイを成立させるため。

#### Acceptance Criteria
1. The デプロイパイプライン shall clasp の認証情報を GitHub Secrets から取得する。
2. The デプロイパイプライン shall 認証情報をリポジトリにコミット・永続化された状態で保持しない。
3. When デプロイ処理が認証情報を必要とするとき, the デプロイパイプライン shall Secret から取得した認証情報を実行環境上に展開したうえで clasp を実行する。
4. If 認証情報が存在しない、または無効な場合, then the デプロイパイプライン shall デプロイを実行せず、ワークフローを失敗として終了する。
5. The デプロイパイプライン shall デプロイ先 scriptId を GitHub Secrets から取得し、実 scriptId をリポジトリにコミット・永続化された状態で保持しない。
6. When デプロイ処理が scriptId を必要とするとき, the デプロイパイプライン shall Secret から取得した scriptId を `.clasp.json` に反映したうえで clasp を実行する。

### Requirement 5: デプロイ結果の可視化と失敗ハンドリング
**Objective:** 開発者として、デプロイの成否とその原因を確認できるようにしてほしい。これにより失敗時に迅速に対処するため。

#### Acceptance Criteria
1. The デプロイパイプライン shall テスト・認証・デプロイの各ステップの成否を実行ログとして確認可能にする。
2. When デプロイ（ソース同期）が成功したとき, the デプロイパイプライン shall ワークフローを成功ステータスで終了する。
3. If デプロイ（ソース同期）が失敗した場合, then the デプロイパイプライン shall ワークフローを失敗ステータスで終了する。
4. If 認証トークンが失効していてデプロイできない場合, then the デプロイパイプライン shall ワークフローを失敗として終了し、原因をログに記録する。

### Requirement 6: セットアップ・運用前提のドキュメント化
**Objective:** プロジェクト管理者として、自動デプロイを成立させるための前提作業と復旧手順を把握したい。これにより初期構築と継続運用を確実に行うため。

#### Acceptance Criteria
1. The セットアップドキュメント shall 認証情報および scriptId を GitHub Secret として登録する手順を記載する。
2. The セットアップドキュメント shall Apps Script API の事前有効化が必要であることと、その設定箇所を記載する。
3. The セットアップドキュメント shall OAuth 同意画面の公開設定がリフレッシュトークンの失効回避に必要であることを注意点として記載する。
4. Where 認証トークンが失効した場合, the セットアップドキュメント shall Secret の更新によってデプロイを復旧する手順を記載する。
