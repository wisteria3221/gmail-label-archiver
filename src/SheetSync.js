/**
 * SheetSync.js — SheetSyncService: 設定シートの移行・同期の計画と書き込み。
 *
 * Google Apps Script ランタイムでは全 `src/*.js` が 1 つのグローバルスコープに
 * 連結されるため、ここで宣言する top-level 関数はそのままグローバル公開される。
 *
 * 依存レイヤ: Constants → Config → Archiver → SheetSync → Main。
 * 利用してよいのは自分より左のファイルの関数・定数のみ（Config の `validateRow` など）。
 * シートの「読み取り」は Config、「書き込み」はこのファイルが担う。
 *
 * `planMigration` は旧形式（`対象` 列なし）のデータ行から移行時の対象値を決める
 * 純粋関数で、SpreadsheetApp / GmailApp には依存しない（テスト容易性のため分離）。
 */

/**
 * @typedef {Object} MigrationPlan
 * @property {boolean[]} checks       データ行ごとの対象値（validateRow が有効なら true、4.3/4.4）
 * @property {number}    checkedCount true の件数（4.7）
 */

/**
 * 旧形式（`対象` 列なし）のデータ行から移行時の対象値を決める純粋関数。
 * 副作用なし（values は変更しない）。
 *
 * - ラベル名が空でなく `validateRow` が有効な行 → true（4.3）。
 * - それ以外（日数が空・0・負・小数・数字以外、ラベル名が空）→ false。
 *   保持日数の値は変更しない（4.4）。
 * 旧形式の読取と同じ `validateRow` で判定するため、移行後の新形式シートの
 * 採用ルールは移行前と一致する（4.6）。
 *
 * @param {Array<Array<*>>} values ヘッダ込みの全セル値
 * @param {ColumnMap} columns resolveColumns の戻り値（label・days を使う）
 * @returns {MigrationPlan} checks は values の 2 行目以降と同じ長さ
 */
function planMigration(values, columns) {
  const checks = [];
  let checkedCount = 0;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    // validateRow はラベル名が空（trim 後）なら null を返すため、空ラベル行も false。
    const checked = validateRow(row[columns.label], row[columns.days]) !== null;
    checks.push(checked);
    if (checked) {
      checkedCount++;
    }
  }
  return { checks, checkedCount };
}

// Node-only export guard: GAS では `module` が未定義のため評価されない。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    planMigration,
  };
}
