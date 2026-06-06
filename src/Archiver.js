/**
 * Archiver.js — ArchiveService: ルール単位の対象抽出・権威的判定・バッチアーカイブ。
 *
 * Google Apps Script ランタイムでは全 `src/*.js` が 1 つのグローバルスコープに
 * 連結されるため、ここで宣言する top-level 関数はそのままグローバル公開される。
 *
 * 本ファイルの `buildQuery` / `isOlderThan` / `hasStar` は純粋関数（`hasStar` は
 * 渡されたスレッドのメソッドのみ呼ぶ薄いラッパ）で、GmailApp などのグローバル
 * サービスには一切依存しない（テスト容易性のため分離）。
 *
 * `archiveRule`（GmailApp 依存の抽出・アーカイブ本体）は後続タスク（3.2）で
 * 同ファイルに追加される。
 */

/**
 * @typedef {Object} ArchiveRule
 * @property {string} labelName    対象ラベル名（非空）
 * @property {number} retentionDays 受信トレイ保持日数（正の整数）
 */

/** 1 日のミリ秒数（経過日数換算用）。 */
const MS_PER_DAY = 86400000;

/**
 * ルールから Gmail 検索クエリ文字列を生成する純粋関数（副作用なし）。
 * ラベル名は常に二重引用符で囲む（空白・階層ラベル対応）。
 *
 * @param {ArchiveRule} rule
 * @returns {string} `label:"<labelName>" in:inbox -is:starred older_than:<retentionDays>d`
 */
function buildQuery(rule) {
  return (
    'label:"' +
    rule.labelName +
    '" in:inbox -is:starred older_than:' +
    rule.retentionDays +
    'd'
  );
}

/**
 * 最新メッセージ日時が保持日数のしきい値より古いかを判定する純粋関数（副作用なし）。
 *
 * 経過日数 = (now - lastMessageDate) のミリ秒差 / 86400000。
 * 経過日数が保持日数を「厳密に超える」場合のみ true。ちょうど保持日数以下なら
 * false（除外、2.5）。基準は常にスレッド内最新メッセージの日時（2.2）。
 *
 * @param {Date} lastMessageDate スレッド内最新メッセージの日時（2.2）
 * @param {number} retentionDays 保持日数（正の整数）
 * @param {Date} now 経過日数判定の基準時刻
 * @returns {boolean} 経過日数が保持日数を超えていれば true（アーカイブ対象）
 */
function isOlderThan(lastMessageDate, retentionDays, now) {
  const elapsedDays = (now.getTime() - lastMessageDate.getTime()) / MS_PER_DAY;
  return elapsedDays > retentionDays;
}

/**
 * スレッドにスター付きメッセージが存在するかを判定する（`hasStarredMessages` ラッパ）。
 * 渡された引数のメソッドのみを呼ぶ薄いラッパ（純粋・グローバル非依存）。
 *
 * @param {GmailThread} thread GmailThread 相当のオブジェクト
 * @returns {boolean} スター付きが 1 件でもあれば true（対象から除外、2.6）
 */
function hasStar(thread) {
  return thread.hasStarredMessages();
}

// Node-only export guard: GAS では `module` が未定義のため評価されない。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildQuery, isOlderThan, hasStar };
}
