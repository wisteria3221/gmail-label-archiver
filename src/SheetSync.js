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
 * `planSheetSync` は新形式シートの全値と Gmail ラベル一覧から同期計画（追記行・
 * 自動列の値・欠けた自動列ヘッダ）を作る純粋関数で、同じく外部 API に依存しない。
 * `syncLabelSheet` はロック取得・移行・同期計画の作成・シートへの書き込みを行う
 * 唯一の副作用関数で、SpreadsheetApp / LockService と listUserLabelNames に依存する。
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

/**
 * @typedef {Object} SyncPlan
 * @property {string[]}         appendNames 末尾に追記するラベル名（Gmail 上の表記、Gmail の取得順、1.1）
 * @property {Array<number|''>} appliedDays 既存データ行＋追記行の適用日数（2.5〜2.7）
 * @property {string[]}         statuses    既存データ行＋追記行の状態（'' は正常）
 * @property {string[]}         missingHeaders 右端に追加する自動列ヘッダ（適用日数・状態のうち欠けているもの）
 * @property {number}           missingCount 状態が STATUS_MISSING の行数（5.3）
 */

/**
 * 新形式シートの全値と Gmail ラベル一覧から同期計画を作る純粋関数。
 * 副作用なし（values・gmailLabelNames は変更しない）。同じ入力に同じ出力を返す（5.4）。
 *
 * 1. `collectExplicitRules` で行を分類し明示ルールを得る。読取（readArchiveRules）と
 *    同じ判定を使うため、表示と実際のアーカイブ対象が一致する（3.7）。
 * 2. 明示ルールを `expandRules` で展開し、照合キー → 日数の対応表を作る（2.5, 3.3, 3.4）。
 * 3. 適用日数: blank 行と Gmail に無い行は ''（2.7）。それ以外は対応表の値、
 *    表に無ければ ''（2.6）。重複行は採用行と同じラベルなので同じ日数になる。
 * 4. 状態（優先順）: blank → ''、duplicate → STATUS_DUPLICATE（3.7）、
 *    Gmail に無い → STATUS_MISSING（1.5）、invalid → STATUS_INVALID_DAYS、それ以外 → ''。
 *    毎回全行を再計算するため、Gmail に戻ったラベルの状態は空に戻る（1.6）。
 * 5. 既存行の照合キーに無い Gmail ラベルを appendNames にする。Gmail 側の
 *    大文字小文字違いも照合キーで一意化する（1.2）。改名後の新名もここで追記され、
 *    旧名の行は手順 4 で STATUS_MISSING になる（1.8）。追記行の適用日数は手順 2 の
 *    表で決まり（親が明示ルールなら継承値）、状態は ''。
 *
 * @param {Array<Array<*>>} values ヘッダ込みの全セル値（新形式）
 * @param {ColumnMap} columns resolveColumns の戻り値
 * @param {string[]} gmailLabelNames Gmail の全ユーザーラベル名（listUserLabelNames の戻り値）
 * @returns {SyncPlan} appliedDays・statuses は「データ行数＋appendNames 数」の長さ
 */
function planSheetSync(values, columns, gmailLabelNames) {
  // 1. 行の分類と明示ルール（読取と共通の判定）。
  const ruleSet = collectExplicitRules(values, columns);

  // 2. 展開後のルールを照合キー → 日数の対応表にする。
  const daysByKey = {};
  const expanded = expandRules(ruleSet.rules, gmailLabelNames);
  for (let i = 0; i < expanded.length; i++) {
    daysByKey[labelKey(expanded[i].labelName)] = expanded[i].retentionDays;
  }

  // Gmail ラベルの照合キー集合。
  const gmailKeys = {};
  for (let g = 0; g < gmailLabelNames.length; g++) {
    gmailKeys[labelKey(gmailLabelNames[g])] = true;
  }

  // 3. 4. 既存データ行の適用日数と状態。
  const appliedDays = [];
  const statuses = [];
  const sheetKeys = {};
  let missingCount = 0;
  for (let r = 1; r < values.length; r++) {
    const cls = ruleSet.rowClasses[r - 1];
    if (cls === 'blank') {
      appliedDays.push('');
      statuses.push('');
      continue;
    }
    const rawLabel = values[r][columns.label];
    const key = labelKey(String(rawLabel == null ? '' : rawLabel).trim());
    sheetKeys[key] = true;
    const inGmail = Object.prototype.hasOwnProperty.call(gmailKeys, key);

    // 適用日数: Gmail に無い行は空（2.7）、設定が無ければ空（2.6）。
    appliedDays.push(inGmail ? lookupDays_(daysByKey, key) : '');

    // 状態: duplicate → missing → invalid → 正常 の優先順。
    if (cls === 'duplicate') {
      statuses.push(STATUS_DUPLICATE);
    } else if (!inGmail) {
      statuses.push(STATUS_MISSING);
      missingCount++;
    } else if (cls === 'invalid') {
      statuses.push(STATUS_INVALID_DAYS);
    } else {
      statuses.push('');
    }
  }

  // 5. 既存行に無い Gmail ラベルを Gmail の順・表記で追記（照合キーで一意化、1.1, 1.2）。
  const appendNames = [];
  for (let a = 0; a < gmailLabelNames.length; a++) {
    const name = gmailLabelNames[a];
    const key = labelKey(name);
    if (Object.prototype.hasOwnProperty.call(sheetKeys, key)) {
      continue;
    }
    sheetKeys[key] = true;
    appendNames.push(name);
    appliedDays.push(lookupDays_(daysByKey, key));
    statuses.push('');
  }

  // 欠けている自動列ヘッダ（適用日数 → 状態 の順）。
  const missingHeaders = [];
  if (columns.appliedDays === -1) {
    missingHeaders.push(HEADER_APPLIED_DAYS);
  }
  if (columns.status === -1) {
    missingHeaders.push(HEADER_STATUS);
  }

  return { appendNames, appliedDays, statuses, missingHeaders, missingCount };
}

/**
 * 照合キー → 日数の対応表から日数を引く。表に無ければ ''（2.6）。
 * @param {Object<string, number>} daysByKey
 * @param {string} key 照合キー
 * @returns {number|''}
 */
function lookupDays_(daysByKey, key) {
  return Object.prototype.hasOwnProperty.call(daysByKey, key) ? daysByKey[key] : '';
}

/**
 * @typedef {Object} SyncResult
 * @property {boolean} migrated             旧形式から移行したか
 * @property {number}  migratedCheckedCount 移行で対象にした行数（未移行なら 0、4.7）
 * @property {number}  appendedCount        末尾に追記した行数（5.3）
 * @property {number}  missingCount         状態が STATUS_MISSING の行数（5.3）
 */

/**
 * スクリプトロックを取得し、必要なら旧形式を移行してから、Gmail ラベル一覧と
 * 設定シートを同期する。失敗は throw する（ログ・継続判断は呼び出し側）。
 *
 * 書き込むのは次の 4 種類だけで、既存行の 対象・ラベル名・保持日数 には
 * 書き込まない（1.3, 1.4, 2.3, 4.2）。
 *   (d) 移行時: 先頭に列を挿入し、A 列へ [対象, ...チェック値] を 1 回で書く（4.1）。
 *   (c) 欠けた自動列ヘッダ（適用日数・状態）を右端に追加する（2.1）。
 *   (a) appendNames を最終行の下に一括で追記する（対象 false・保持日数 ''、1.1, 4.5）。
 *       ラベル名は常に先頭に ' を付けて文字列として書く（数式・数値/日付への自動変換を防ぐ）。
 *   (b) 適用日数・状態 列のデータ行を一括で上書きする（2.5〜2.8）。
 * 最後に 対象 列のデータ行へチェックボックスの入力規則を設定する（値は変えない、2.2）。
 * 2 回目以降は追記・ヘッダ追加が空になり、同じ値が書かれるだけなので内容は変わらない（5.4）。
 * システムラベルは listUserLabelNames（getUserLabels）が返さないため追記されない（1.7）。
 *
 * @returns {SyncResult}
 * @throws {Error} ロック取得のタイムアウト、構成不備（6.3）、ヘッダ不正（6.4）、
 *   Gmail / Sheets API の失敗。
 */
function syncLabelSheet() {
  // 1. 同時実行を防ぐ。取得できなければ waitLock が throw する（取得前なので解放不要）。
  const lock = LockService.getScriptLock();
  lock.waitLock(SYNC_LOCK_TIMEOUT_MS);
  try {
    return syncLabelSheetLocked_();
  } finally {
    lock.releaseLock();
  }
}

/**
 * ロック取得後の同期本体（syncLabelSheet からのみ呼ぶ）。
 * @returns {SyncResult}
 */
function syncLabelSheetLocked_() {
  // 2. 設定シートを読み、列をヘッダで解決する。必須列が無ければ構成不備（6.4）。
  const sheet = openConfigSheet();
  let values = sheet.getDataRange().getValues();
  let columns = resolveColumns(values[0] || []);
  assertRequiredColumns(columns);

  // 3. 旧形式（対象 列なし）なら移行する。新形式なら何もしない（4.8）。
  let migrated = false;
  let migratedCheckedCount = 0;
  if (columns.target === -1) {
    const migration = planMigration(values, columns);
    sheet.insertColumnBefore(1);
    // 挿入直後にヘッダとチェック値を 1 回で書く（途中失敗時の残骸を最小にする）。
    const column = [[HEADER_TARGET]].concat(migration.checks.map((c) => [c]));
    sheet.getRange(1, 1, column.length, 1).setValues(column);
    // 列番号がずれるため読み直して再解決する。
    values = sheet.getDataRange().getValues();
    columns = resolveColumns(values[0] || []);
    migrated = true;
    migratedCheckedCount = migration.checkedCount;
  }

  // 4. 同期計画（純粋関数）。
  const plan = planSheetSync(values, columns, listUserLabelNames());

  // 5. 欠けた自動列ヘッダを右端に追加し、手元の値も同じ形にして列を再解決する（2.1）。
  if (plan.missingHeaders.length > 0) {
    const startCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, startCol, 1, plan.missingHeaders.length).setValues([plan.missingHeaders]);
    values = values.map((row) => row.slice());
    for (let r = 0; r < values.length; r++) {
      while (values[r].length < startCol - 1) {
        values[r].push('');
      }
    }
    values[0] = values[0].concat(plan.missingHeaders);
    columns = resolveColumns(values[0]);
  }
  const width = values[0].length;
  const existingCount = values.length - 1; // 既存データ行数

  // 6. 未登録ラベルを最終行の下に一括で追記する（対象 false・保持日数 ''、1.1, 4.5）。
  if (plan.appendNames.length > 0) {
    const rows = plan.appendNames.map((name) => {
      const row = new Array(width).fill('');
      row[columns.target] = false;
      row[columns.label] = asTextLiteral_(name);
      return row;
    });
    sheet.getRange(values.length + 1, 1, rows.length, width).setValues(rows);
  }

  // 7. 適用日数・状態 列のデータ行（既存行＋追記行）を列ごとに一括で上書きする。
  const dataCount = existingCount + plan.appendNames.length;
  if (dataCount > 0) {
    sheet
      .getRange(2, columns.appliedDays + 1, dataCount, 1)
      .setValues(plan.appliedDays.map((d) => [d]));
    sheet
      .getRange(2, columns.status + 1, dataCount, 1)
      .setValues(plan.statuses.map((s) => [s]));

    // 8. 対象 列のデータ行にチェックボックスの入力規則を設定する（2.2）。
    // insertCheckboxes は範囲の全セルを false にするため使わない。入力規則の設定は
    // 値を変えないので、利用者のチェックや移行で設定した値は残る（1.3, 4.3）。
    const checkboxRule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
    sheet.getRange(2, columns.target + 1, dataCount, 1).setDataValidation(checkboxRule);
  }

  return {
    migrated,
    migratedCheckedCount,
    appendedCount: plan.appendNames.length,
    missingCount: plan.missingCount,
  };
}

/**
 * セルに文字列として書くため、先頭に ' を付ける。
 * Sheets は自動書式のセルで先頭の ' を「文字列として保存する」印として取り除き、
 * getValues は元の文字列を返す。数式（= + - @ 始まり）や数値・日付（例: 2024, 007,
 * 1/2）への自動変換を防ぐため、次回の照合キーが Gmail の名前と一致し続ける（5.4）。
 * @param {string} text
 * @returns {string}
 */
function asTextLiteral_(text) {
  return "'" + text;
}

// Node-only export guard: GAS では `module` が未定義のため評価されない。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    planMigration,
    planSheetSync,
    syncLabelSheet,
  };
}
