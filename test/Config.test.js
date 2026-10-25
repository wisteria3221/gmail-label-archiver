'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Constants = require('../src/Constants.js');
// Hoist constant names (PROP_SPREADSHEET_ID, etc.) to global so Config.js
// free-variable references resolve under Node (GAS shares one global scope).
Object.assign(globalThis, Constants);

const { validateRow, readArchiveRules, expandRules } = require('../src/Config.js');
const { openConfigSheet, resolveColumns, labelKey } = require('../src/Config.js');

/**
 * Install per-test mocks of the GAS global services on globalThis.
 * @param {{props: Object<string,string>, sheets: Object<string,Array<Array<*>>>}} cfg
 *   props  — map of Script Property key -> value (key absent => getProperty returns null)
 *   sheets — map of sheet name -> 2D values array (name absent => getSheetByName returns null)
 */
function setupGas({ props, sheets }) {
  globalThis.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
    }),
  };
  globalThis.SpreadsheetApp = {
    openById: () => ({
      getSheetByName: (name) => {
        const data = sheets[name];
        return data ? { getDataRange: () => ({ getValues: () => data }) } : null;
      },
    }),
  };
}

test('validateRow: valid row with string days returns ArchiveRule', () => {
  assert.deepEqual(validateRow('Newsletter', '30'), {
    labelName: 'Newsletter',
    retentionDays: 30,
  });
});

test('validateRow: valid row with numeric days returns ArchiveRule (1.2)', () => {
  assert.deepEqual(validateRow('A', 7), { labelName: 'A', retentionDays: 7 });
});

test('validateRow: trims whitespace on label and days', () => {
  assert.deepEqual(validateRow('  Promo  ', ' 14 '), {
    labelName: 'Promo',
    retentionDays: 14,
  });
});

test('validateRow: empty label is invalid -> null (1.5)', () => {
  assert.equal(validateRow('', '5'), null);
});

test('validateRow: whitespace-only label is invalid -> null (1.5)', () => {
  assert.equal(validateRow('   ', '5'), null);
});

test('validateRow: empty days is invalid -> null (1.4)', () => {
  assert.equal(validateRow('A', ''), null);
});

test('validateRow: whitespace-only days is invalid -> null (1.4)', () => {
  assert.equal(validateRow('A', '  '), null);
});

test('validateRow: non-numeric days is invalid -> null (1.4)', () => {
  assert.equal(validateRow('A', 'abc'), null);
});

test('validateRow: negative days is invalid -> null (1.4)', () => {
  assert.equal(validateRow('A', '-3'), null);
});

test('validateRow: zero days is invalid -> null (1.4)', () => {
  assert.equal(validateRow('A', '0'), null);
});

test('validateRow: fractional days is invalid -> null (1.4)', () => {
  assert.equal(validateRow('A', '2.5'), null);
});

test('validateRow: numeric fractional days is invalid -> null (1.4)', () => {
  assert.equal(validateRow('A', 2.5), null);
});

// --- readArchiveRules ---

test('readArchiveRules: missing CONFIG_SPREADSHEET_ID throws (fail-fast)', () => {
  setupGas({ props: {}, sheets: {} });
  assert.throws(readArchiveRules);
});

test('readArchiveRules: empty CONFIG_SPREADSHEET_ID throws (fail-fast)', () => {
  setupGas({ props: { CONFIG_SPREADSHEET_ID: '' }, sheets: {} });
  assert.throws(readArchiveRules);
});

test('readArchiveRules: header-only sheet returns [] (1.3)', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1' },
    sheets: { settings: [['ラベル名', '保持日数']] },
  });
  assert.deepEqual(readArchiveRules().rules, []);
});

test('readArchiveRules: mixed rows returns only valid rules (1.1, 1.4, 1.5)', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1' },
    sheets: {
      settings: [
        ['ラベル名', '保持日数'],
        ['Newsletter', '30'], // valid
        ['', '10'], // invalid: empty label (1.5)
        ['Promo', 'abc'], // invalid: non-numeric days (1.4)
        ['Sale', '-1'], // invalid: negative days (1.4)
        ['Old', '0'], // invalid: zero days (1.4)
        ['  News  ', ' 7 '], // valid: trimmed
      ],
    },
  });
  assert.deepEqual(readArchiveRules().rules, [
    { labelName: 'Newsletter', retentionDays: 30 },
    { labelName: 'News', retentionDays: 7 },
  ]);
});

test('readArchiveRules: all-invalid data rows return [] (1.4, 1.5)', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1' },
    sheets: {
      settings: [
        ['ラベル名', '保持日数'],
        ['', '10'],
        ['X', 'abc'],
      ],
    },
  });
  assert.deepEqual(readArchiveRules().rules, []);
});

test('readArchiveRules: header columns resolved by name regardless of order', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1' },
    sheets: {
      settings: [
        ['保持日数', 'ラベル名'], // swapped order
        ['30', 'Newsletter'],
      ],
    },
  });
  assert.deepEqual(readArchiveRules().rules, [
    { labelName: 'Newsletter', retentionDays: 30 },
  ]);
});

test('readArchiveRules: trims header cells when matching', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1' },
    sheets: {
      settings: [
        [' ラベル名 ', ' 保持日数 '],
        ['A', '5'],
      ],
    },
  });
  assert.deepEqual(readArchiveRules().rules, [{ labelName: 'A', retentionDays: 5 }]);
});

test('readArchiveRules: CONFIG_SHEET_NAME override is honored', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1', CONFIG_SHEET_NAME: 'custom' },
    sheets: {
      custom: [
        ['ラベル名', '保持日数'],
        ['A', '5'],
      ],
      settings: [['ラベル名', '保持日数']], // would yield [] if wrongly used
    },
  });
  assert.deepEqual(readArchiveRules().rules, [{ labelName: 'A', retentionDays: 5 }]);
});

test('readArchiveRules: absent CONFIG_SHEET_NAME uses DEFAULT_SHEET_NAME (settings)', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1' },
    sheets: {
      settings: [
        ['ラベル名', '保持日数'],
        ['A', '5'],
      ],
    },
  });
  assert.deepEqual(readArchiveRules().rules, [{ labelName: 'A', retentionDays: 5 }]);
});

test('readArchiveRules: sheet not found throws (configuration error)', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1', CONFIG_SHEET_NAME: 'missing' },
    sheets: { settings: [['ラベル名', '保持日数']] },
  });
  assert.throws(readArchiveRules);
});

test('readArchiveRules: header schema mismatch throws (configuration error)', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1' },
    sheets: {
      settings: [
        ['名前', '日数'],
        ['A', '5'],
      ],
    },
  });
  assert.throws(readArchiveRules);
});

test('readArchiveRules: old format returns { rules, invalidLabels } with empty invalidLabels (4.6)', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1' },
    sheets: {
      settings: [
        ['ラベル名', '保持日数'],
        ['Newsletter', '30'],
        ['Promo', 'abc'], // 旧形式の無効行は黙ってスキップ（警告しない）
      ],
    },
  });
  assert.deepEqual(readArchiveRules(), {
    rules: [{ labelName: 'Newsletter', retentionDays: 30 }],
    invalidLabels: [],
  });
});

test('readArchiveRules: header schema mismatch throws even with 対象 column (6.4)', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1' },
    sheets: {
      settings: [
        ['対象', 'ラベル名'], // 保持日数 列が無い
        [true, 'A'],
      ],
    },
  });
  assert.throws(readArchiveRules, /ヘッダが不正です/);
});

test('readArchiveRules: new format returns only checked & valid rows, ignores unchecked days (3.1, 3.6)', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1' },
    sheets: {
      settings: [
        ['対象', 'ラベル名', '保持日数', '適用日数', '状態'],
        [true, 'Newsletter', 30, '', ''], // checked & valid
        [false, 'Promo', 7, '', ''], // unchecked → 無視（3.6）
        [false, 'Sale', 'abc', '', ''], // unchecked & 無効日数 → 無視、警告しない（3.6）
        ['TRUE', 'Str', 5, '', ''], // 文字列 'TRUE' はチェックではない（=== true のみ）
        [true, '  News  ', ' 14 ', '', ''], // checked & valid（trim）
      ],
    },
  });
  assert.deepEqual(readArchiveRules(), {
    rules: [
      { labelName: 'Newsletter', retentionDays: 30 },
      { labelName: 'News', retentionDays: 14 },
    ],
    invalidLabels: [],
  });
});

test('readArchiveRules: new format lists checked-but-invalid labels in invalidLabels (3.5)', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1' },
    sheets: {
      settings: [
        ['ラベル名', '保持日数', '対象'], // 列順に依存しない
        ['Bad', 'abc', true], // checked & invalid → invalidLabels
        ['Zero', 0, true], // checked & invalid → invalidLabels
        ['Empty', '', true], // checked & invalid → invalidLabels
        ['Good', 10, true], // checked & valid
        ['', 5, true], // ラベル名が空 → 無視
      ],
    },
  });
  assert.deepEqual(readArchiveRules(), {
    rules: [{ labelName: 'Good', retentionDays: 10 }],
    invalidLabels: ['Bad', 'Zero', 'Empty'],
  });
});

test('readArchiveRules: old format and its migrated new format yield the same rules (4.6)', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1' },
    sheets: {
      settings: [
        ['ラベル名', '保持日数'],
        ['A', '5'],
        ['B', 'x'],
        ['C', 3],
      ],
    },
  });
  const oldResult = readArchiveRules();
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1' },
    sheets: {
      settings: [
        ['対象', 'ラベル名', '保持日数'],
        [true, 'A', '5'],
        [false, 'B', 'x'],
        [true, 'C', 3],
      ],
    },
  });
  assert.deepEqual(readArchiveRules().rules, oldResult.rules);
  assert.deepEqual(oldResult.rules, [
    { labelName: 'A', retentionDays: 5 },
    { labelName: 'C', retentionDays: 3 },
  ]);
});

// --- expandRules (6.1-6.6) ---

/** Sort by labelName for order-insensitive deep comparison. */
function byLabel(a, b) {
  return a.labelName < b.labelName ? -1 : a.labelName > b.labelName ? 1 : 0;
}

test('expandRules: single-level descendant inherits parent retention (6.1, 6.4)', () => {
  const rules = [{ labelName: '仕事', retentionDays: 30 }];
  const allLabelNames = ['仕事', '仕事/案件A'];
  const result = expandRules(rules, allLabelNames).sort(byLabel);
  assert.deepEqual(result, [
    { labelName: '仕事', retentionDays: 30 },
    { labelName: '仕事/案件A', retentionDays: 30 },
  ]);
});

test('expandRules: multi-level descendant covered by prefix (6.2, 6.4)', () => {
  const rules = [{ labelName: '仕事', retentionDays: 30 }];
  const allLabelNames = ['仕事', '仕事/案件A', '仕事/案件A/詳細'];
  const result = expandRules(rules, allLabelNames).sort(byLabel);
  assert.deepEqual(result, [
    { labelName: '仕事', retentionDays: 30 },
    { labelName: '仕事/案件A', retentionDays: 30 },
    { labelName: '仕事/案件A/詳細', retentionDays: 30 },
  ]);
});

test('expandRules: false-positive avoidance — 仕事 does not match 仕事中 (6.2)', () => {
  const rules = [{ labelName: '仕事', retentionDays: 30 }];
  const allLabelNames = ['仕事', '仕事中'];
  const result = expandRules(rules, allLabelNames).sort(byLabel);
  assert.deepEqual(result, [{ labelName: '仕事', retentionDays: 30 }]);
});

test('expandRules: explicit child row takes precedence over inheritance (6.5)', () => {
  const rules = [
    { labelName: '仕事', retentionDays: 30 },
    { labelName: '仕事/案件A', retentionDays: 7 },
  ];
  const allLabelNames = ['仕事', '仕事/案件A'];
  const result = expandRules(rules, allLabelNames).sort(byLabel);
  assert.deepEqual(result, [
    { labelName: '仕事', retentionDays: 30 },
    { labelName: '仕事/案件A', retentionDays: 7 },
  ]);
});

test('expandRules: longest-prefix ancestor is chosen for descendant (決定 1)', () => {
  const rules = [
    { labelName: '仕事', retentionDays: 30 },
    { labelName: '仕事/案件', retentionDays: 10 },
  ];
  const allLabelNames = ['仕事', '仕事/案件', '仕事/案件/X'];
  const result = expandRules(rules, allLabelNames).sort(byLabel);
  assert.deepEqual(result, [
    { labelName: '仕事', retentionDays: 30 },
    { labelName: '仕事/案件', retentionDays: 10 },
    { labelName: '仕事/案件/X', retentionDays: 10 },
  ]);
});

test('expandRules: no descendants returns only explicit rules (6.6)', () => {
  const rules = [{ labelName: '個人', retentionDays: 5 }];
  const allLabelNames = ['個人', '仕事', '仕事/案件A'];
  const result = expandRules(rules, allLabelNames).sort(byLabel);
  assert.deepEqual(result, [{ labelName: '個人', retentionDays: 5 }]);
});

test('expandRules: result is unique by labelName (6.3)', () => {
  const rules = [{ labelName: '仕事', retentionDays: 30 }];
  // Duplicate label names in input must be absorbed by dedupe.
  const allLabelNames = ['仕事', '仕事/案件A', '仕事/案件A'];
  const result = expandRules(rules, allLabelNames);
  const names = result.map((r) => r.labelName);
  assert.equal(names.length, new Set(names).size);
  assert.deepEqual(result.sort(byLabel), [
    { labelName: '仕事', retentionDays: 30 },
    { labelName: '仕事/案件A', retentionDays: 30 },
  ]);
});

// --- expandRules: Gmail のラベル名は大文字小文字を区別しないため、展開も区別しない ---

test('expandRules: descendant is expanded even when case differs from explicit rule', () => {
  const rules = [{ labelName: 'work', retentionDays: 30 }];
  const allLabelNames = ['Work', 'Work/Sub', 'Work/Sub/Deep'];
  const result = expandRules(rules, allLabelNames).sort(byLabel);
  // 明示ルールはシートの表記のまま、展開ルールは Gmail 上の実ラベル名を使う。
  assert.deepEqual(result, [
    { labelName: 'Work/Sub', retentionDays: 30 },
    { labelName: 'Work/Sub/Deep', retentionDays: 30 },
    { labelName: 'work', retentionDays: 30 },
  ]);
});

test('expandRules: label equal to explicit rule ignoring case is not added twice', () => {
  const rules = [{ labelName: 'work', retentionDays: 30 }];
  const result = expandRules(rules, ['Work']);
  assert.deepEqual(result, [{ labelName: 'work', retentionDays: 30 }]);
});

test('expandRules: explicit child takes precedence ignoring case (6.5)', () => {
  const rules = [
    { labelName: 'Work', retentionDays: 30 },
    { labelName: 'work/sub', retentionDays: 7 },
  ];
  const result = expandRules(rules, ['Work', 'Work/Sub']).sort(byLabel);
  assert.deepEqual(result, [
    { labelName: 'Work', retentionDays: 30 },
    { labelName: 'work/sub', retentionDays: 7 },
  ]);
});

test('expandRules: explicit rules differing only in case are deduped (first wins)', () => {
  const rules = [
    { labelName: 'Work', retentionDays: 30 },
    { labelName: 'WORK', retentionDays: 7 },
  ];
  const result = expandRules(rules, ['Work', 'Work/Sub']).sort(byLabel);
  assert.deepEqual(result, [
    { labelName: 'Work', retentionDays: 30 },
    { labelName: 'Work/Sub', retentionDays: 30 },
  ]);
});

// --- openConfigSheet (6.3) ---

test('openConfigSheet: missing CONFIG_SPREADSHEET_ID throws with current message (6.3)', () => {
  setupGas({ props: {}, sheets: {} });
  assert.throws(openConfigSheet, {
    message:
      'Script Property "CONFIG_SPREADSHEET_ID" が未設定です。設定スプレッドシートの ID を登録してください。',
  });
});

test('openConfigSheet: empty CONFIG_SPREADSHEET_ID throws (6.3)', () => {
  setupGas({ props: { CONFIG_SPREADSHEET_ID: '' }, sheets: {} });
  assert.throws(openConfigSheet, /CONFIG_SPREADSHEET_ID/);
});

test('openConfigSheet: sheet not found throws with current message (6.3)', () => {
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1', CONFIG_SHEET_NAME: 'missing' },
    sheets: { settings: [['ラベル名', '保持日数']] },
  });
  assert.throws(openConfigSheet, {
    message: '設定シート "missing" が見つかりません（構成不備）。',
  });
});

test('openConfigSheet: returns the sheet named by CONFIG_SHEET_NAME', () => {
  const custom = [['ラベル名', '保持日数'], ['A', '5']];
  setupGas({
    props: { CONFIG_SPREADSHEET_ID: 'id1', CONFIG_SHEET_NAME: 'custom' },
    sheets: { custom: custom, settings: [['ラベル名', '保持日数']] },
  });
  assert.equal(openConfigSheet().getDataRange().getValues(), custom);
});

test('openConfigSheet: absent CONFIG_SHEET_NAME opens DEFAULT_SHEET_NAME', () => {
  const settings = [['ラベル名', '保持日数']];
  setupGas({ props: { CONFIG_SPREADSHEET_ID: 'id1' }, sheets: { settings: settings } });
  assert.equal(openConfigSheet().getDataRange().getValues(), settings);
});

// --- resolveColumns (2.4) ---

test('resolveColumns: resolves all five columns in canonical order (2.4)', () => {
  assert.deepEqual(
    resolveColumns(['対象', 'ラベル名', '保持日数', '適用日数', '状態']),
    { target: 0, label: 1, days: 2, appliedDays: 3, status: 4 }
  );
});

test('resolveColumns: is independent of column order (2.4)', () => {
  assert.deepEqual(
    resolveColumns(['状態', '保持日数', '適用日数', 'ラベル名', '対象']),
    { target: 4, label: 3, days: 1, appliedDays: 2, status: 0 }
  );
});

test('resolveColumns: ignores surrounding whitespace in header cells (2.4)', () => {
  assert.deepEqual(
    resolveColumns([' 対象', 'ラベル名 ', '  保持日数  ', '\t適用日数', '状態\n']),
    { target: 0, label: 1, days: 2, appliedDays: 3, status: 4 }
  );
});

test('resolveColumns: missing columns resolve to -1 (legacy two-column sheet)', () => {
  assert.deepEqual(resolveColumns(['ラベル名', '保持日数']), {
    target: -1,
    label: 0,
    days: 1,
    appliedDays: -1,
    status: -1,
  });
});

test('resolveColumns: partially missing columns resolve to -1 (6.4)', () => {
  assert.deepEqual(resolveColumns(['メモ', '対象', '状態', null, '']), {
    target: 1,
    label: -1,
    days: -1,
    appliedDays: -1,
    status: 2,
  });
});

test('resolveColumns: empty header resolves every column to -1', () => {
  assert.deepEqual(resolveColumns([]), {
    target: -1,
    label: -1,
    days: -1,
    appliedDays: -1,
    status: -1,
  });
});

test('resolveColumns: duplicated header name resolves to the first occurrence', () => {
  assert.equal(resolveColumns(['ラベル名', 'ラベル名', '保持日数']).label, 0);
});

// --- labelKey ---

test('labelKey: returns lower-cased match key', () => {
  assert.equal(labelKey('Work/Sub'), 'work/sub');
  assert.equal(labelKey('仕事'), '仕事');
});

// ---------------------------------------------------------------------------
// collectExplicitRules（行の分類と明示ルールの決定、3.1, 3.2, 3.4, 3.5, 3.6, 3.7, 4.6）
// ---------------------------------------------------------------------------

const { collectExplicitRules } = require('../src/Config.js');

const NEW_HEADER = ['対象', 'ラベル名', '保持日数', '適用日数', '状態'];
const OLD_HEADER = ['ラベル名', '保持日数'];

function classify(values) {
  return collectExplicitRules(values, resolveColumns(values[0]));
}

test('collectExplicitRules: upper unchecked + lower checked valid -> lower explicit, upper duplicate (3.7)', () => {
  const result = classify([
    NEW_HEADER,
    [false, 'News', 10, '', ''],
    [true, 'News', 30, '', ''],
  ]);
  assert.deepEqual(result.rules, [{ labelName: 'News', retentionDays: 30 }]);
  assert.deepEqual(result.rowClasses, ['duplicate', 'explicit']);
  assert.deepEqual(result.invalidLabels, []);
});

test('collectExplicitRules: upper checked-invalid + lower valid -> upper duplicate, not in invalidLabels (3.5, 3.7)', () => {
  const result = classify([
    NEW_HEADER,
    [true, 'News', 'abc', '', ''],
    [true, 'News', 30, '', ''],
  ]);
  assert.deepEqual(result.rules, [{ labelName: 'News', retentionDays: 30 }]);
  assert.deepEqual(result.rowClasses, ['duplicate', 'explicit']);
  assert.deepEqual(result.invalidLabels, []);
});

test('collectExplicitRules: both checked valid -> upper explicit, lower duplicate (3.7)', () => {
  const result = classify([
    NEW_HEADER,
    [true, 'News', 7, '', ''],
    [true, 'News', 30, '', ''],
  ]);
  assert.deepEqual(result.rules, [{ labelName: 'News', retentionDays: 7 }]);
  assert.deepEqual(result.rowClasses, ['explicit', 'duplicate']);
});

test('collectExplicitRules: same name differing only in case is treated as the same label (3.7)', () => {
  const result = classify([
    NEW_HEADER,
    [true, 'News', 7, '', ''],
    [true, 'NEWS', 30, '', ''],
    [false, 'news', '', '', ''],
  ]);
  assert.deepEqual(result.rules, [{ labelName: 'News', retentionDays: 7 }]);
  assert.deepEqual(result.rowClasses, ['explicit', 'duplicate', 'duplicate']);
});

test('collectExplicitRules: unchecked rows days are ignored and rows become none (3.1, 3.6)', () => {
  const result = classify([
    NEW_HEADER,
    [false, 'A', 30, '', ''],
    [false, 'B', 'abc', '', ''],
    ['', 'C', 5, '', ''],
    ['TRUE', 'D', 5, '', ''],
    [true, 'E', 14, '', ''],
  ]);
  assert.deepEqual(result.rules, [{ labelName: 'E', retentionDays: 14 }]);
  assert.deepEqual(result.rowClasses, ['none', 'none', 'none', 'none', 'explicit']);
  assert.deepEqual(result.invalidLabels, []);
});

test('collectExplicitRules: checked row with invalid days is invalid and listed in row order (3.4, 3.5)', () => {
  const result = classify([
    NEW_HEADER,
    [true, 'Z', 0, '', ''],
    [true, 'A', 30, '', ''],
    [true, 'Y', '', '', ''],
  ]);
  assert.deepEqual(result.rules, [{ labelName: 'A', retentionDays: 30 }]);
  assert.deepEqual(result.rowClasses, ['invalid', 'explicit', 'invalid']);
  assert.deepEqual(result.invalidLabels, ['Z', 'Y']);
});

test('collectExplicitRules: blank labels are blank regardless of target (3.2)', () => {
  const result = classify([
    NEW_HEADER,
    [true, '', 30, '', ''],
    [false, '   ', '', '', ''],
    [true, 'A', 30, '', ''],
  ]);
  assert.deepEqual(result.rules, [{ labelName: 'A', retentionDays: 30 }]);
  assert.deepEqual(result.rowClasses, ['blank', 'blank', 'explicit']);
  assert.deepEqual(result.invalidLabels, []);
});

test('collectExplicitRules: header-only sheet returns empty sets', () => {
  assert.deepEqual(classify([NEW_HEADER]), {
    rules: [],
    invalidLabels: [],
    rowClasses: [],
  });
});

test('collectExplicitRules: old format treats every row as candidate; invalid rows are none (4.6)', () => {
  const result = classify([
    OLD_HEADER,
    ['A', 30],
    ['B', 'abc'],
    ['', 5],
    ['a', 7],
  ]);
  assert.deepEqual(result.rules, [{ labelName: 'A', retentionDays: 30 }]);
  assert.deepEqual(result.rowClasses, ['explicit', 'none', 'blank', 'duplicate']);
  assert.deepEqual(result.invalidLabels, []);
});

test('collectExplicitRules: old format and migrated new format yield identical rules (4.6)', () => {
  const oldValues = [
    OLD_HEADER,
    ['Newsletter', 30],
    ['Promo', '7'],
    ['Broken', 'abc'],
    ['', 10],
    ['promo', 99],
    ['Work/Reports', 14],
    ['Zero', 0],
  ];
  // planMigration 後を手書きで再現: 有効行は true、無効行は false。既存の値は変えない。
  const migratedValues = [
    ['対象', 'ラベル名', '保持日数', '適用日数', '状態'],
    [true, 'Newsletter', 30, '', ''],
    [true, 'Promo', '7', '', ''],
    [false, 'Broken', 'abc', '', ''],
    [false, '', 10, '', ''],
    [true, 'promo', 99, '', ''],
    [true, 'Work/Reports', 14, '', ''],
    [false, 'Zero', 0, '', ''],
  ];
  const oldResult = classify(oldValues);
  const newResult = classify(migratedValues);
  assert.deepEqual(oldResult.rules, [
    { labelName: 'Newsletter', retentionDays: 30 },
    { labelName: 'Promo', retentionDays: 7 },
    { labelName: 'Work/Reports', retentionDays: 14 },
  ]);
  assert.deepEqual(newResult.rules, oldResult.rules);
  assert.deepEqual(newResult.invalidLabels, []);
});
