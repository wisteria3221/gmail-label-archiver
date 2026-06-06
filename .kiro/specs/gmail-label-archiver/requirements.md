# Requirements Document

## Introduction

個人の Gmail ユーザーが、メールの種類（ラベル）ごとに「受信トレイに残しておく日数」を変えて自動アーカイブできるようにする機能。Google スプレッドシートで「ラベル名 → 受信トレイ保持日数」の対応表を管理し、1 日 1 回の時間トリガーで Google Apps Script を自動実行する。各ラベルが付いたスレッドのうち指定日数を超えたものを受信トレイから外す（標準アーカイブ = INBOX ラベルの除去）。利用者はコードを変更せず、スプレッドシートの編集だけで対象ラベルと保持日数を調整できる。

本ドキュメントでは、システムの主体を **Gmail Label Archiver** と呼ぶ。

## Boundary Context

- **In scope**: 設定シート（`ラベル名 | 保持日数`）の読み取り / ラベル＋経過日数条件での対象スレッド抽出（スター付きスレッドの除外を含む）/ 受信トレイから外す標準アーカイブ / 1 日 1 回の時間トリガーの登録・実行 / 一部の不正設定や大量メールに対する安全な継続実行
- **Out of scope**: 通知機能やリッチな実行ログ基盤（標準実行ログへの最小限の出力のみ）/ アーカイブ以外のメール操作（削除・転送・既読変更・ラベル付け替え）/ 複数アカウント対応 / Web UI・ダッシュボード
- **Adjacent expectations**: 利用者が事前に Gmail でラベルを作成・付与していること、設定用スプレッドシートを用意し Gmail Label Archiver から参照可能にしていること、Apps Script に Gmail / Spreadsheet サービスの利用権限を付与していることを前提とする。これらの準備自体は本機能の責務に含めない。

## Requirements

### Requirement 1: 設定（ラベル・保持日数）の管理と読み取り
**Objective:** As a Gmail ユーザー, I want スプレッドシートでラベルごとの保持日数を管理する, so that コードを変更せずに対象ラベルと保持期間を調整できる

#### Acceptance Criteria
1. When Gmail Label Archiver が実行される, the Gmail Label Archiver shall 指定された設定シートから各データ行の「ラベル名」と「保持日数」を読み取る
2. The Gmail Label Archiver shall 保持日数を「日単位の経過日数のしきい値」として解釈する
3. While 設定シートにデータ行が 1 件も存在しない, the Gmail Label Archiver shall アーカイブ処理を行わずに正常終了する
4. If ある行の保持日数が数値でない、負の値、または空である, then the Gmail Label Archiver shall その行をスキップし、残りの行の処理を継続する
5. If ある行のラベル名が空である, then the Gmail Label Archiver shall その行をスキップし、残りの行の処理を継続する

### Requirement 2: アーカイブ対象スレッドの抽出
**Objective:** As a Gmail ユーザー, I want 指定ラベルかつ指定日数を超えたスレッドだけを対象にする, so that 新しいメールや必要なメールは受信トレイに残る

#### Acceptance Criteria
1. When ある設定行を処理する, the Gmail Label Archiver shall そのラベルが付き、かつ受信トレイに存在し、かつ経過日数が保持日数を超えたスレッドのみを対象として抽出する
2. The Gmail Label Archiver shall 経過日数の基準をスレッド内の最新メッセージの日時とする
3. The Gmail Label Archiver shall 受信トレイに存在しないスレッドを対象から除外する
4. If 指定されたラベルが Gmail アカウントに存在しない, then the Gmail Label Archiver shall その行をスキップし、残りの行の処理を継続する
5. While あるスレッドの経過日数が保持日数以下である, the Gmail Label Archiver shall そのスレッドを対象から除外する
6. While あるスレッドにスター（重要マーク）が付いている, the Gmail Label Archiver shall 他の条件を満たしていてもそのスレッドを対象から除外する

### Requirement 3: 受信トレイからのアーカイブ実行
**Objective:** As a Gmail ユーザー, I want 対象スレッドを受信トレイから外す, so that 受信トレイが整理され、メール本文は保持される

#### Acceptance Criteria
1. When 対象スレッドが抽出された, the Gmail Label Archiver shall 各対象スレッドを受信トレイから外す（標準アーカイブ）
2. The Gmail Label Archiver shall アーカイブ時にスレッドに付与された INBOX 以外の既存ラベルを変更しない
3. The Gmail Label Archiver shall メールの削除・転送・既読状態の変更を行わない
4. While 抽出された対象スレッドが 0 件である, the Gmail Label Archiver shall 何もせずに正常終了する

### Requirement 4: 自動実行スケジュールとセットアップ
**Objective:** As a Gmail ユーザー, I want 1 日 1 回の自動実行を設定する, so that 手作業なしに受信トレイが整理され続ける

#### Acceptance Criteria
1. The Gmail Label Archiver shall 1 日 1 回の時間トリガーで自動実行するためのセットアップ手段を提供する
2. When セットアップが実行される, the Gmail Label Archiver shall 重複したトリガーを作成せずに 1 日 1 回のトリガーを登録する
3. Where 利用者が手動で実行する, the Gmail Label Archiver shall 時間トリガーと同一のアーカイブ処理を実行する

### Requirement 5: 実行の堅牢性と運用制約
**Objective:** As a Gmail ユーザー, I want 大量メールや一部の不正設定があっても安全に動作する, so that 1 件の失敗で処理全体が止まらない

#### Acceptance Criteria
1. If 1 回の実行で対象スレッドが多く Apps Script の実行時間上限に達するおそれがある, then the Gmail Label Archiver shall 1 回あたりの処理件数に上限を設け、未処理分を次回以降の実行に持ち越す
2. If ある設定行の処理中にエラーが発生する, then the Gmail Label Archiver shall そのエラーを記録し、残りの設定行の処理を継続する
3. The Gmail Label Archiver shall 外部ライブラリや課金サービスに依存せず、Gmail サービスと Spreadsheet サービスのみで動作する
4. The Gmail Label Archiver shall 各実行の処理結果（処理対象ラベルと件数）を Apps Script の標準実行ログに出力する
