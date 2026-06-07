/**
 * Main.js — Entry/Runtime: アーカイブ処理のオーケストレーション。
 *
 * Google Apps Script ランタイムでは全 `src/*.js` が 1 つのグローバルスコープに
 * 連結される。本ファイルの top-level 関数 `archiveLabeledThreads` はそのまま
 * グローバル公開され、日次トリガーのハンドラ（`TRIGGER_HANDLER`）かつ手動実行の
 * 共通エントリとなる（4.3：呼び出し元で分岐しない）。
 *
 * 依存（GAS では同一グローバルスコープのグローバル）:
 * - `readArchiveRules()`（ConfigService）: 検証済みルール配列を返す／構成不備で throw。
 * - `listUserLabelNames()`（ArchiveService）: Gmail の全ユーザーラベル名を返す（6.1）。
 * - `expandRules(rules, allLabelNames)`（ConfigService）: 明示ルールを親とみなし
 *   配下の子孫ラベルへ展開した一意化済みルール配列を返す純粋関数（6.1）。
 * - `archiveRule(rule, now, remaining, seenThreadIds)`（ArchiveService）: 1 ルール分を
 *   処理し `{ labelName, archivedCount, candidateCount }` を返す（6.8）。
 * - `MAX_THREADS_PER_RUN`（Constants）: 実行全体の処理上限。
 *
 * setupDailyTrigger / removeAllTriggers は本ファイルに後続タスク（4.2）で追加される。
 */

/**
 * トリガー／手動共通のアーカイブエントリ（引数なし、4.3）。
 *
 * 1. `readArchiveRules()` で検証済みルールを取得。構成不備（throw）は
 *    ログに記録して正常終了（再 throw しない、Error Strategy 構成不備）。
 * 2. 明示ルール 0 件なら、ラベル取得・展開を行わず短絡終了（1.3）。
 *    Gmail への往復を避けるため、`listUserLabelNames`/`expandRules` より前で return する。
 * 3. 1 件以上なら `listUserLabelNames()` で全ラベル名を取得し（失敗時はログして
 *    正常終了、再 throw しない）、`expandRules(rules, labelNames)` で対象を子孫へ展開（6.1）。
 * 4. 残予算 `remaining` を `MAX_THREADS_PER_RUN` で初期化し、実行全体で 1 つの
 *    `seenThreadIds`（処理済みスレッド ID 集合、6.8）を生成して各ルールを順に処理。
 *    - `remaining <= 0` で以降のルールをスキップ（実行全体の予算枯渇、次回持ち越し、5.1）。
 *    - `archiveRule(rule, now, remaining, seenThreadIds)` を呼び
 *      `remaining -= result.archivedCount` を更新（5.1）。共有集合により親子両ラベル付き
 *      スレッドの実行内重複を防ぐ（6.8）。
 *    - ルール単位 try/catch でエラーを記録し次ルールへ継続（5.2）。
 * 5. 実行サマリ（処理ルール数・ルール別件数・エラー数・残予算）を標準ログへ出力（5.4）。
 *
 * @returns {void}
 */
function archiveLabeledThreads() {
  // 1. 設定読取（構成不備はログして正常終了、Error Strategy 構成不備）。
  let rules;
  try {
    rules = readArchiveRules();
  } catch (err) {
    logLine(
      '⚠️ [エラー] 設定の読み取りに失敗したため処理を中止しました（設定内容を確認してください）: ' +
        errorMessage(err)
    );
    return;
  }

  // 2. 明示ルール 0 件 → ラベル取得・展開を行わず短絡終了（1.3、Gmail 往復なし）。
  if (!rules || rules.length === 0) {
    logLine('ℹ️ [スキップ] 対象のルールが無いため、処理を実行しませんでした。');
    return;
  }

  // 3. 全ラベル名を取得し、明示ルールを子孫ラベルへ展開（6.1）。
  //    ラベル取得失敗はログして正常終了（再 throw しない）。
  let labelNames;
  try {
    labelNames = listUserLabelNames();
  } catch (err) {
    logLine(
      '⚠️ [エラー] ラベル一覧の取得に失敗したため処理を中止しました: ' +
        errorMessage(err)
    );
    return;
  }
  rules = expandRules(rules, labelNames);

  // 4. 残予算と実行全体で共有する処理済みスレッド ID 集合（6.8）を初期化し順次処理。
  let remaining = MAX_THREADS_PER_RUN;
  const now = new Date();
  const seenThreadIds = new Set();
  const perRule = [];
  let processedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];

    // 実行全体の予算枯渇 → 以降のルールをスキップ（5.1、次回持ち越し）。
    if (remaining <= 0) {
      break;
    }

    try {
      const result = archiveRule(rule, now, remaining, seenThreadIds);
      remaining -= result.archivedCount;
      processedCount += 1;
      perRule.push('「' + rule.labelName + '」' + result.archivedCount + '件');
    } catch (err) {
      // ルール単位のエラーを記録し、次ルールへ継続（5.2）。
      errorCount += 1;
      perRule.push('「' + rule.labelName + '」エラー');
      logLine(
        '⚠️ [エラー] ラベル「' +
          rule.labelName +
          '」の処理中にエラーが発生しました: ' +
          errorMessage(err)
      );
    }
  }

  // 5. 実行サマリを標準ログへ出力（5.4）。
  logLine(
    '📊 [サマリ] ルール ' +
      rules.length +
      '件中 処理成功 ' +
      processedCount +
      '件 / エラー ' +
      errorCount +
      '件 / 残り処理可能 ' +
      remaining +
      '件\n   └ ルール別: [' +
      perRule.join(', ') +
      ']'
  );
}

/**
 * 日次トリガーを冪等にセットアップする（4.1, 4.2）。
 *
 * 1. `ScriptApp.getProjectTriggers()` を走査し、ハンドラが `TRIGGER_HANDLER`
 *    （`archiveLabeledThreads`）の既存トリガーを全削除する（重複排除）。
 * 2. その後、日次トリガーをちょうど 1 件作成する
 *    （`everyDays(1).atHour(TRIGGER_HOUR)`）。
 *
 * Postcondition: `archiveLabeledThreads` を指す日次トリガーがちょうど 1 件存在
 *（実行前の件数に依らず、2 回実行しても 1 件のまま）。
 *
 * @returns {void}
 */
function setupDailyTrigger() {
  // 1. 既存の同一ハンドラトリガーを全削除（重複排除）。
  removeAllTriggers();

  // 2. 日次トリガーを 1 件だけ作成（4.1/4.2）。
  ScriptApp.newTrigger(TRIGGER_HANDLER)
    .timeBased()
    .everyDays(1)
    .atHour(TRIGGER_HOUR)
    .create();
}

/**
 * 同一ハンドラ（`TRIGGER_HANDLER`）のトリガーを全削除する（運用補助）。
 * 無関係なハンドラのトリガーには手を触れない。
 *
 * @returns {void}
 */
function removeAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    const trigger = triggers[i];
    if (trigger.getHandlerFunction() === TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  }
}

/**
 * 1 行を標準ログへ出力する（5.4）。出力先は `console.log` に統一する。
 * GAS の V8 ランタイムでは `console.log` も `Logger.log` も同じ Cloud Logging
 * （実行ログ）へ書き込まれるため、両方を呼ぶと同一行が二重出力される。これを
 * 避けるため `Logger.log` には出力しない（Node/GAS 双方で 1 回のみ）。
 *
 * @param {string} line
 */
function logLine(line) {
  if (typeof console !== 'undefined' && console.log) {
    console.log(line);
  }
}

/**
 * 例外からログ用メッセージを取り出す（Error 以外も安全に文字列化）。
 *
 * @param {*} err
 * @returns {string}
 */
function errorMessage(err) {
  if (err && typeof err.message === 'string') {
    return err.message;
  }
  return String(err);
}

// Node-only export guard: GAS では `module` が未定義のため評価されない。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { archiveLabeledThreads, setupDailyTrigger, removeAllTriggers };
}
