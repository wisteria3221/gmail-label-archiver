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
  assert.equal(C.ARCHIVE_SCAN_LIMIT_PER_RULE, 1000);
});

test('Constants: caps respect GmailApp API limits', () => {
  // GmailApp.moveThreadsToArchive accepts at most 100 threads per call.
  assert.ok(C.ARCHIVE_BATCH_SIZE <= 100, 'ARCHIVE_BATCH_SIZE must be <= 100');
  // GmailApp.search returns at most 500 threads per call.
  assert.ok(C.ARCHIVE_SEARCH_LIMIT <= 500, 'ARCHIVE_SEARCH_LIMIT must be <= 500');
  // 1 ルールの走査上限は少なくとも 1 ページ分以上（ページングが機能するため）。
  assert.ok(
    C.ARCHIVE_SCAN_LIMIT_PER_RULE >= C.ARCHIVE_SEARCH_LIMIT,
    'ARCHIVE_SCAN_LIMIT_PER_RULE must be >= ARCHIVE_SEARCH_LIMIT'
  );
});

test('Constants: trigger handler and hour', () => {
  assert.equal(C.TRIGGER_HANDLER, 'archiveLabeledThreads');
  assert.ok(Number.isInteger(C.TRIGGER_HOUR), 'TRIGGER_HOUR must be an integer');
  assert.ok(C.TRIGGER_HOUR >= 0 && C.TRIGGER_HOUR <= 23, 'TRIGGER_HOUR must be in 0..23');
});

test('Constants: label hierarchy separator', () => {
  assert.equal(C.LABEL_HIERARCHY_SEPARATOR, '/');
});

test('Constants: 同期で追加する列ヘッダ', () => {
  assert.equal(C.HEADER_TARGET, '対象');
  assert.equal(C.HEADER_APPLIED_DAYS, '適用日数');
  assert.equal(C.HEADER_STATUS, '状態');
});

test('Constants: 状態列に表示する文言', () => {
  assert.equal(C.STATUS_MISSING, 'Gmail に存在しない');
  assert.equal(C.STATUS_INVALID_DAYS, '保持日数が無効（対象外）');
  assert.equal(C.STATUS_DUPLICATE, '重複（別の行の設定を適用）');
});

test('Constants: 同期ロックの待ち時間', () => {
  assert.equal(C.SYNC_LOCK_TIMEOUT_MS, 30000);
});
