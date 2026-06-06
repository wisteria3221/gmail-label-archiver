/**
 * Config.js — ConfigService: 設定シートの読取と行バリデーション。
 *
 * Google Apps Script ランタイムでは全 `src/*.js` が 1 つのグローバルスコープに
 * 連結されるため、ここで宣言する top-level 関数はそのままグローバル公開される。
 * `validateRow` は副作用のない純粋関数で、GmailApp / SpreadsheetApp /
 * PropertiesService には一切依存しない（テスト容易性のため分離）。
 *
 * `readArchiveRules` は後続タスク（2.2）で同ファイルに追加される。
 */

/**
 * @typedef {Object} ArchiveRule
 * @property {string} labelName    対象ラベル名（非空）
 * @property {number} retentionDays 受信トレイ保持日数（正の整数）
 */

/**
 * 1 行分のラベル名・保持日数を検証し、有効なら ArchiveRule に変換する純粋関数。
 * 副作用なし。`readArchiveRules` が行ごとに呼ぶ。
 *
 * - labelName: 前後空白を trim。trim 後に空なら無効（1.5）。
 * - retentionDays: 文字列は trim、空/空白のみは無効。`Number()` 変換後に
 *   `Number.isInteger` かつ `> 0` を満たす場合のみ有効（非数値→NaN・負・0・
 *   小数は無効）（1.2, 1.4）。
 *
 * @param {string} label 生のラベル名セル値
 * @param {string|number} days 生の保持日数セル値
 * @returns {ArchiveRule|null} 有効なら ArchiveRule、無効なら null
 */
function validateRow(label, days) {
  // ラベル名: 文字列化して trim。空なら無効（1.5）。
  const labelName = String(label == null ? '' : label).trim();
  if (labelName === '') {
    return null;
  }

  // 保持日数: 文字列なら trim。空/空白のみは無効（1.4）。
  const rawDays = typeof days === 'string' ? days.trim() : days;
  if (rawDays === '' || rawDays == null) {
    return null;
  }

  // 数値変換し、正の整数のみ許可（非数値→NaN・負・0・小数は無効）（1.2, 1.4）。
  const retentionDays = Number(rawDays);
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    return null;
  }

  return { labelName, retentionDays };
}

// Node-only export guard: GAS では `module` が未定義のため評価されない。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateRow };
}
