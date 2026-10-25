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

// Node-only export guard: GAS では `module` が未定義のため評価されない。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    planMigration,
    planSheetSync,
  };
}
