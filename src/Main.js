/**
 * Main.js — Entry/Runtime: アーカイブ処理のオーケストレーション。
 *
 * Google Apps Script ランタイムでは全 `src/*.js` が 1 つのグローバルスコープに
 * 連結される。本ファイルの top-level 関数 `archiveLabeledThreads` はそのまま
 * グローバル公開され、日次トリガーのハンドラ（`TRIGGER_HANDLER`）かつ手動実行の
 * 共通エントリとなる（4.3：呼び出し元で分岐しない）。
 *
 * 依存（GAS では同一グローバルスコープのグローバル）:
 * - `readArchiveRules()`（ConfigService）: `{ rules, invalidLabels }`（ConfigReadResult）を
 *   返す／構成不備で throw。本処理は `rules`（検証済み明示ルール配列）を使う。
 * - `listUserLabelNames()`（ArchiveService）: Gmail の全ユーザーラベル名を返す（6.1）。
 * - `expandRules(rules, allLabelNames)`（ConfigService）: 明示ルールを親とみなし
 *   配下の子孫ラベルへ展開した一意化済みルール配列を返す純粋関数（6.1）。
 * - `archiveRule(rule, now, remaining, seenThreadIds)`（ArchiveService）: 1 ルール分を
 *   処理し `{ labelName, archivedCount, candidateCount }` を返す（6.8）。
 * - `MAX_THREADS_PER_RUN`（Constants）: 実行全体の処理上限。
 *
 * 失敗時の方針: GAS のトリガー失敗通知メールは例外送出時にしか送られないため、
 * 構成不備・ラベル一覧取得失敗はログ後に再 throw し、ルール単位のエラーは全ルール処理と
 * サマリ出力を終えた後にまとめて throw する（無人運用で失敗に気づけるようにする）。
 */

/**
 * トリガー／手動共通のアーカイブエントリ（引数なし、4.3）。
 *
 * 1. `readArchiveRules()` の戻り値から検証済みルール（`rules`）を取得。構成不備（throw）は
 *    ログに記録して再 throw する（トリガー失敗通知を発火させる、Error Strategy 構成不備）。
 * 2. 明示ルール 0 件なら、ラベル取得・展開を行わず短絡終了（1.3）。
 *    Gmail への往復を避けるため、`listUserLabelNames`/`expandRules` より前で return する。
 * 3. 1 件以上なら `listUserLabelNames()` で全ラベル名を取得し（失敗時はログして
 *    再 throw）、`expandRules(rules, labelNames)` で対象を子孫へ展開（6.1）。
 * 4. 残予算 `remaining` を `MAX_THREADS_PER_RUN` で初期化し、実行全体で 1 つの
 *    `seenThreadIds`（処理済みスレッド ID 集合、6.8）を生成して、予算を公平配分しながら
 *    各ルールを処理する（先頭ルールの滞留が後続ルールを毎回締め出さないように）。
 *    - 1 巡目: 各ルールに `max(1, floor(remaining / 残ルール数))` を割り当てて
 *      `archiveRule(rule, now, 割当, seenThreadIds)` を呼ぶ。使い切らなかった分は
 *      `remaining` に残り、後続ルールの割当へ自然に回る（5.1）。
 *    - 2 巡目: 割当を使い切った（滞留が残っている可能性がある）ルールに、残った
 *      `remaining` を順に全量渡す。1 巡目でアーカイブ済みのスレッドは共有集合で除外（6.8）。
 *    - `remaining <= 0` で以降をスキップ（実行全体の予算枯渇、次回持ち越し、5.1）。
 *    - ルール単位 try/catch でエラーを記録し次ルールへ継続（5.2）。エラーのルールは
 *      2 巡目の対象外。
 * 5. 実行サマリ（処理ルール数・ルール別件数・エラー数・残予算）を標準ログへ出力（5.4）。
 * 6. ルール単位のエラーが 1 件以上あれば、サマリ出力後に throw する（失敗通知）。
 *
 * @returns {void}
 * @throws {Error} 構成不備・ラベル一覧取得失敗・ルール単位エラーが 1 件以上あった場合
 */
function archiveLabeledThreads() {
  // 1. 設定読取（構成不備はログして再 throw、Error Strategy 構成不備）。
  let rules;
  try {
    rules = readArchiveRules().rules;
  } catch (err) {
    logLine(
      '⚠️ [エラー] 設定の読み取りに失敗したため処理を中止しました（設定内容を確認してください）: ' +
        errorMessage(err)
    );
    throw err;
  }

  // 2. 明示ルール 0 件 → ラベル取得・展開を行わず短絡終了（1.3、Gmail 往復なし）。
  if (!rules || rules.length === 0) {
    logLine('ℹ️ [スキップ] 対象のルールが無いため、処理を実行しませんでした。');
    return;
  }

  // 3. 全ラベル名を取得し、明示ルールを子孫ラベルへ展開（6.1）。
  //    ラベル取得失敗はログして再 throw（失敗通知）。
  let labelNames;
  try {
    labelNames = listUserLabelNames();
  } catch (err) {
    logLine(
      '⚠️ [エラー] ラベル一覧の取得に失敗したため処理を中止しました: ' +
        errorMessage(err)
    );
    throw err;
  }
  rules = expandRules(rules, labelNames);

  // 4. 残予算と実行全体で共有する処理済みスレッド ID 集合（6.8）を初期化し、予算を公平配分して処理。
  let remaining = MAX_THREADS_PER_RUN;
  const now = new Date();
  const seenThreadIds = new Set();
  const archivedByRule = [];
  const attempted = [];
  const failed = [];
  const hitShare = [];
  let errorCount = 0;

  // ルール i を budget 件までで処理し、結果を集計する。エラーは記録して継続（5.2）。
  const runRule = (i, budget) => {
    const rule = rules[i];
    attempted[i] = true;
    try {
      const result = archiveRule(rule, now, budget, seenThreadIds);
      remaining -= result.archivedCount;
      archivedByRule[i] = (archivedByRule[i] || 0) + result.archivedCount;
      return result.archivedCount;
    } catch (err) {
      errorCount += 1;
      failed[i] = true;
      logLine(
        '⚠️ [エラー] ラベル「' +
          rule.labelName +
          '」の処理中にエラーが発生しました: ' +
          errorMessage(err)
      );
      return 0;
    }
  };

  // 1 巡目: 残予算 ÷ 残ルール数（最低 1）を割り当てる。余りは後続ルールへ回る（5.1）。
  for (let i = 0; i < rules.length; i++) {
    if (remaining <= 0) {
      break;
    }
    const share = Math.max(1, Math.floor(remaining / (rules.length - i)));
    hitShare[i] = runRule(i, share) >= share;
  }

  // 2 巡目: 割当を使い切ったルールへ、残った予算を順に全量渡す（5.1）。
  for (let i = 0; i < rules.length; i++) {
    if (remaining <= 0) {
      break;
    }
    if (hitShare[i] && !failed[i]) {
      runRule(i, remaining);
    }
  }

  // ルール別件数（複数巡の合算）。予算枯渇で未着手のルールは含めない。
  const perRule = [];
  let processedCount = 0;
  for (let i = 0; i < rules.length; i++) {
    if (!attempted[i]) {
      continue;
    }
    if (failed[i]) {
      perRule.push('「' + rules[i].labelName + '」エラー');
    } else {
      processedCount += 1;
      perRule.push('「' + rules[i].labelName + '」' + (archivedByRule[i] || 0) + '件');
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

  // 6. ルール単位のエラーがあれば、全ルール処理・サマリ出力後に throw（失敗通知）。
  if (errorCount > 0) {
    throw new Error(
      errorCount + '件のルールでエラーが発生しました（詳細は実行ログを参照）。'
    );
  }
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
