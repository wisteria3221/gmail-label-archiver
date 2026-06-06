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
 * - `archiveRule(rule, now, remaining)`（ArchiveService）: 1 ルール分を処理し
 *   `{ labelName, archivedCount, candidateCount }` を返す。
 * - `MAX_THREADS_PER_RUN`（Constants）: 実行全体の処理上限。
 *
 * setupDailyTrigger / removeAllTriggers は本ファイルに後続タスク（4.2）で追加される。
 */

/**
 * トリガー／手動共通のアーカイブエントリ（引数なし、4.3）。
 *
 * 1. `readArchiveRules()` で検証済みルールを取得。構成不備（throw）は
 *    ログに記録して正常終了（再 throw しない、Error Strategy 構成不備）。
 * 2. 有効ルール 0 件なら何もせず正常終了（1.3）。
 * 3. 残予算 `remaining` を `MAX_THREADS_PER_RUN` で初期化し、各ルールを順に処理。
 *    - `remaining <= 0` で以降のルールをスキップ（実行全体の予算枯渇、次回持ち越し、5.1）。
 *    - `archiveRule` を呼び `remaining -= result.archivedCount` を更新（5.1）。
 *    - ルール単位 try/catch でエラーを記録し次ルールへ継続（5.2）。
 * 4. 実行サマリ（処理ルール数・ルール別件数・エラー数・残予算）を標準ログへ出力（5.4）。
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
      'archiveLabeledThreads: 設定読取に失敗したため終了しました（構成不備）: ' +
        errorMessage(err)
    );
    return;
  }

  // 2. 有効ルール 0 件 → 何もせず正常終了（1.3）。
  if (!rules || rules.length === 0) {
    logLine('archiveLabeledThreads: 対象ルールがないため何もしません（1.3）。');
    return;
  }

  // 3. 残予算管理つきでルールを順次処理。
  let remaining = MAX_THREADS_PER_RUN;
  const now = new Date();
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
      const result = archiveRule(rule, now, remaining);
      remaining -= result.archivedCount;
      processedCount += 1;
      perRule.push(rule.labelName + '=' + result.archivedCount);
    } catch (err) {
      // ルール単位のエラーを記録し、次ルールへ継続（5.2）。
      errorCount += 1;
      perRule.push(rule.labelName + '=ERROR');
      logLine(
        'archiveLabeledThreads: ルール処理でエラー label="' +
          rule.labelName +
          '": ' +
          errorMessage(err)
      );
    }
  }

  // 4. 実行サマリを標準ログへ出力（5.4）。
  logLine(
    'archiveLabeledThreads サマリ: rules_total=' +
      rules.length +
      ' processed=' +
      processedCount +
      ' errors=' +
      errorCount +
      ' remaining=' +
      remaining +
      ' per_rule=[' +
      perRule.join(', ') +
      ']'
  );
}

/**
 * 1 行を標準ログへ出力する（5.4）。`console.log`（Node/GAS 双方）に加え、
 * GAS 環境で `Logger` が定義されていれば `Logger.log` にも出力する。
 *
 * @param {string} line
 */
function logLine(line) {
  if (typeof console !== 'undefined' && console.log) {
    console.log(line);
  }
  if (typeof Logger !== 'undefined' && Logger.log) {
    Logger.log(line);
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
  module.exports = { archiveLabeledThreads };
}
