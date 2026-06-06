'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Constants = require('../src/Constants.js');
// Hoist constant names (PROP_SPREADSHEET_ID, etc.) to global so Config.js
// free-variable references resolve under Node (GAS shares one global scope).
Object.assign(globalThis, Constants);

const { validateRow, readArchiveRules } = require('../src/Config.js');

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
  assert.deepEqual(readArchiveRules(), []);
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
  assert.deepEqual(readArchiveRules(), [
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
  assert.deepEqual(readArchiveRules(), []);
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
  assert.deepEqual(readArchiveRules(), [
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
  assert.deepEqual(readArchiveRules(), [{ labelName: 'A', retentionDays: 5 }]);
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
  assert.deepEqual(readArchiveRules(), [{ labelName: 'A', retentionDays: 5 }]);
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
  assert.deepEqual(readArchiveRules(), [{ labelName: 'A', retentionDays: 5 }]);
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
