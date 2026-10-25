/**
 * Main.js — Entry/Runtime: アーカイブ処理のオーケストレーション。
 *
 * Google Apps Script ランタイムでは全 `src/*.js` が 1 つのグローバルスコープに
 * 連結される。本ファイルの top-level 関数 `archiveLabeledThreads` はそのまま
 * グローバル公開され、日次トリガーのハンドラ（`TRIGGER_HANDLER`）かつ手動実行の
 * 共通エントリとなる（4.3：呼び出し元で分岐しない）。
 *
 * 依存（GAS では同一グローバルスコープのグローバル）:
 * - `syncLabelSheet()`（SheetSync）: Gmail のラベル一覧を設定シートへ同期し（旧形式は移行）、
 *   `{ migrated, migratedCheckedCount, appendedCount, missingCount }` を返す／失敗で throw。
 *   日次実行の冒頭で呼ぶ（5.1）。
 * - `readArchiveRules()`（ConfigService）: `{ rules, invalidLabels }`（ConfigReadResult）を
 *   返す／構成不備で throw。`rules`（検証済み明示ルール配列）を処理し、`invalidLabels`
 *   （チェックありで保持日数が無効なラベル名）はスキップのログに使う（3.5）。
 * - `listUserLabelNames()`（ArchiveService）: Gmail の全ユーザーラベル名を返す（6.1）。
 * - `expandRules(rules, allLabelNames)`（ConfigService）: 明示ルールを親とみなし
 *   配下の子孫ラベルへ展開した一意化済みルール配列を返す純粋関数（6.1）。
 * - `archiveRule(rule, now, remaining, seenThreadIds)`（ArchiveService）: 1 ルール分を
 *   処理し `{ labelName, archivedCount, candidateCount }` を返す（6.8）。
 * - `MAX_THREADS_PER_RUN`（Constants）: 実行全体の処理上限。
 *
 * 失敗時の方針: GAS のトリガー失敗通知メールは例外送出時にしか送られないため、
 * 構成不備・ラベル一覧取得失敗はログ後に再 throw し、シート同期の失敗とルール単位のエラーは
 * 全ルール処理とサマリ出力を終えた後にまとめて 1 回 throw する（無人運用で失敗に気づけるようにする）。
 */

/**
 * トリガー／手動共通のアーカイブエントリ（引数なし、4.3）。
 *
 * 0. `syncLabelSheet()` でラベル一覧を設定シートへ同期する（5.1）。成功時は、移行したときだけ
 *    移行完了（4.7）、常に同期完了（5.3）をログに出す。失敗時はエラーをログに出して
 *    `syncFailed` を記録し、現在の設定のままアーカイブを続行する（6.1）。
 * 1. `readArchiveRules()` の戻り値から検証済みルール（`rules`）と無効行（`invalidLabels`）を
 *    取得し、無効行はラベルごとに `ℹ️ [スキップ]` を 1 行出す（3.5）。構成不備（throw）は
 *    ログに記録してその場で再 throw する（トリガー失敗通知を発火させる、6.3, 6.4）。
 * 2. 明示ルール 0 件なら、ラベル取得・展開を行わず短絡終了（1.3, 3.8）。
 *    Gmail への往復を避けるため、`listUserLabelNames`/`expandRules` より前で抜ける。
 *    `syncFailed` なら return の代わりに throw する（6.1）。
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
 * 6. `syncFailed` またはルール単位のエラーが 1 件以上あれば、サマリ出力後に 1 回だけ throw する
 *    （失敗通知、6.1）。両方あればメッセージに原因を併記する。
 *
 * @returns {void}
 * @throws {Error} 構成不備・ラベル一覧取得失敗・シート同期失敗・ルール単位エラーが 1 件以上あった場合
 */
function archiveLabeledThreads() {
  // 0. ラベル一覧をシートへ同期する（5.1）。失敗してもアーカイブは続行し、終了時に throw する（6.1）。
  let syncFailed = false;
  try {
    logSyncResult(syncLabelSheet());
  } catch (err) {
    syncFailed = true;
    logLine(
      '⚠️ [エラー] ラベル一覧の同期に失敗しました。現在の設定でアーカイブを続行し、終了時にエラーとして通知します: ' +
        errorMessage(err)
    );
  }

  // 1. 設定読取（構成不備はログして再 throw、Error Strategy 構成不備、6.3, 6.4）。
  let rules;
  let invalidLabels;
  try {
    const config = readArchiveRules();
    rules = config.rules;
    invalidLabels = config.invalidLabels || [];
  } catch (err) {
    logLine(
      '⚠️ [エラー] 設定の読み取りに失敗したため処理を中止しました（設定内容を確認してください）: ' +
        errorMessage(err)
    );
    throw err;
  }

  // チェックありで保持日数が無効な行は、ラベルごとに 1 行ログしてスキップする（3.5、throw しない）。
  for (let i = 0; i < invalidLabels.length; i++) {
    logLine(
      'ℹ️ [スキップ] ラベル「' +
        invalidLabels[i] +
        '」は対象にチェックがありますが、保持日数が無効なためスキップしました（正の整数を入力してください）。'
    );
  }

  // 2. 明示ルール 0 件 → ラベル取得・展開を行わず短絡終了（1.3, 3.8、Gmail 往復なし）。
  //    同期に失敗していた場合は、return の代わりに throw して失敗通知を発火させる（6.1）。
  if (!rules || rules.length === 0) {
    logLine('ℹ️ [スキップ] 対象のルールが無いため、処理を実行しませんでした。');
    if (syncFailed) {
      throw new Error(buildFailureMessage(true, 0));
    }
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

  // 6. 同期失敗またはルール単位のエラーがあれば、全ルール処理・サマリ出力後に 1 回だけ throw
  //    （失敗通知、6.1）。両方あればメッセージに併記する。
  if (syncFailed || errorCount > 0) {
    throw new Error(buildFailureMessage(syncFailed, errorCount));
  }
}

/**
 * 同期結果を移行・同期のログに出す（4.7, 5.3、1 出来事 1 行）。
 * 移行したときだけ移行完了を出し、同期完了は常に出す。
 *
 * @param {{migrated: boolean, migratedCheckedCount: number, appendedCount: number, missingCount: number}} result
 */
function logSyncResult(result) {
  if (result.migrated) {
    logLine(
      '✅ [移行完了] 設定シートを新しい形式に移行しました: 対象にチェック ' +
        result.migratedCheckedCount +
        '件'
    );
  }
  logLine(
    '✅ [同期完了] ラベル一覧を同期しました: 追加 ' +
      result.appendedCount +
      '件 / Gmail に存在しない ' +
      result.missingCount +
      '件'
  );
}

/**
 * 日次実行の終了時に throw するメッセージを組み立てる（6.1）。
 * 同期失敗とルール単位のエラーが重なったときは ` / ` で併記する。
 *
 * @param {boolean} syncFailed
 * @param {number} errorCount
 * @returns {string}
 */
function buildFailureMessage(syncFailed, errorCount) {
  const ruleMessage = errorCount + '件のルールでエラーが発生しました（詳細は実行ログを参照）。';
  if (syncFailed && errorCount > 0) {
    return 'ラベル一覧の同期に失敗しました / ' + ruleMessage;
  }
  if (syncFailed) {
    return 'ラベル一覧の同期に失敗しました（詳細は実行ログを参照）。';
  }
  return ruleMessage;
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
