'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../src/Constants.js');

test('Constants: Script Property keys and sheet defaults', () => {
  assert.equal(C.PROP_SPREADSHEET_ID, 'CONFIG_SPREADSHEET_ID');
  assert.equal(C.PROP_SHEET_NAME, 'CONFIG_SHEET_NAME');
  assert.equal(C.DEFAULT_SHEET_NAME, 'settings');
});

test('Constants: header column names', () => {
  assert.equal(C.HEADER_LABEL, 'ラベル名');
  assert.equal(C.HEADER_DAYS, '保持日数');
});

test('Constants: numeric caps have exact values', () => {
  assert.equal(C.MAX_THREADS_PER_RUN, 300);
  assert.equal(C.ARCHIVE_BATCH_SIZE, 100);
  assert.equal(C.ARCHIVE_SEARCH_LIMIT, 500);
});

test('Constants: caps respect GmailApp API limits', () => {
  // GmailApp.moveThreadsToArchive accepts at most 100 threads per call.
  assert.ok(C.ARCHIVE_BATCH_SIZE <= 100, 'ARCHIVE_BATCH_SIZE must be <= 100');
  // GmailApp.search returns at most 500 threads per call.
  assert.ok(C.ARCHIVE_SEARCH_LIMIT <= 500, 'ARCHIVE_SEARCH_LIMIT must be <= 500');
});

test('Constants: trigger handler and hour', () => {
  assert.equal(C.TRIGGER_HANDLER, 'archiveLabeledThreads');
  assert.ok(Number.isInteger(C.TRIGGER_HOUR), 'TRIGGER_HOUR must be an integer');
  assert.ok(C.TRIGGER_HOUR >= 0 && C.TRIGGER_HOUR <= 23, 'TRIGGER_HOUR must be in 0..23');
});
