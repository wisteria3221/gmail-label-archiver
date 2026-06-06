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

/**
 * Script Property が指す設定シートを読み、検証済みの `ArchiveRule[]` を返す。
 *
 * 処理:
 * 1. `CONFIG_SPREADSHEET_ID`（必須）を取得。未設定/空ならフェイルファストで例外。
 * 2. `CONFIG_SHEET_NAME`（任意）を取得。未設定/空なら `DEFAULT_SHEET_NAME`。
 * 3. スプレッドシートを開き対象シートを取得。シート不在なら例外（構成不備）。
 * 4. 全値を読み、1 行目をヘッダとみなしヘッダ名で列を解決。期待ヘッダ
 *    （`ラベル名`/`保持日数`）が見つからなければ例外（スキーマ不一致）。
 * 5. 2 行目以降を `validateRow` に通し、有効行のみ収集して返す。
 *
 * @returns {ArchiveRule[]} 有効な行のみ。データ0件・全行無効なら空配列（1.3）。
 * @throws {Error} CONFIG_SPREADSHEET_ID 未設定、シート/スプレッドシート不在、
 *   またはヘッダスキーマ不一致の場合（構成不備＝フェイルファスト）。
 */
function readArchiveRules() {
  const props = PropertiesService.getScriptProperties();

  // 1. 必須: スプレッドシート ID。未設定/空はフェイルファスト（構成不備）。
  const spreadsheetId = props.getProperty(PROP_SPREADSHEET_ID);
  if (!spreadsheetId) {
    throw new Error(
      'Script Property "' +
        PROP_SPREADSHEET_ID +
        '" が未設定です。設定スプレッドシートの ID を登録してください。'
    );
  }

  // 2. 任意: シート名。未設定/空なら既定値。
  const sheetNameProp = props.getProperty(PROP_SHEET_NAME);
  const sheetName = sheetNameProp || DEFAULT_SHEET_NAME;

  // 3. シート取得。不在なら構成不備として例外。
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error(
      '設定シート "' + sheetName + '" が見つかりません（構成不備）。'
    );
  }

  // 4. 全値読取。1 行目をヘッダとして列インデックスをヘッダ名で解決。
  const values = sheet.getDataRange().getValues();
  const header = values.length > 0 ? values[0] : [];
  const labelCol = findHeaderColumn_(header, HEADER_LABEL);
  const daysCol = findHeaderColumn_(header, HEADER_DAYS);
  if (labelCol === -1 || daysCol === -1) {
    throw new Error(
      'ヘッダが不正です。期待: "' +
        HEADER_LABEL +
        '" / "' +
        HEADER_DAYS +
        '"（スキーマ不一致＝構成不備）。'
    );
  }

  // 5. 2 行目以降をデータ行として検証。無効行は黙ってスキップ（1.4, 1.5）。
  const rules = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const rule = validateRow(row[labelCol], row[daysCol]);
    if (rule !== null) {
      rules.push(rule);
    }
  }
  return rules;
}

/**
 * ヘッダ行から、指定ヘッダ名に一致する列インデックスを返す（trim 比較）。
 * @param {Array<*>} header ヘッダ行のセル値配列
 * @param {string} name 期待ヘッダ名
 * @returns {number} 一致する列インデックス。見つからなければ -1。
 */
function findHeaderColumn_(header, name) {
  for (let i = 0; i < header.length; i++) {
    if (String(header[i] == null ? '' : header[i]).trim() === name) {
      return i;
    }
  }
  return -1;
}

// Node-only export guard: GAS では `module` が未定義のため評価されない。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateRow, readArchiveRules };
}
