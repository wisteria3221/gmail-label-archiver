'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateRow } = require('../src/Config.js');

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
