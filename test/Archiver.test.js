'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildQuery, isOlderThan, hasStar } = require('../src/Archiver.js');

const DAY_MS = 86400000;

// --- buildQuery (2.1, 2.3, 2.6) ---

test('buildQuery: basic rule quotes label and emits full query', () => {
  assert.equal(
    buildQuery({ labelName: 'Newsletter', retentionDays: 30 }),
    'label:"Newsletter" in:inbox -is:starred older_than:30d'
  );
});

test('buildQuery: label with spaces stays quoted', () => {
  assert.equal(
    buildQuery({ labelName: 'My Label', retentionDays: 7 }),
    'label:"My Label" in:inbox -is:starred older_than:7d'
  );
});

test('buildQuery: hierarchical label is quoted correctly', () => {
  assert.equal(
    buildQuery({ labelName: 'Work/Reports', retentionDays: 14 }),
    'label:"Work/Reports" in:inbox -is:starred older_than:14d'
  );
});

// --- isOlderThan (2.2 = latest message date basis, 2.5 = age <= retention excluded) ---

const NOW = new Date('2026-06-06T00:00:00Z');

test('isOlderThan: age exactly == retentionDays -> false (excluded, 2.5)', () => {
  const last = new Date(NOW.getTime() - 30 * DAY_MS);
  assert.equal(isOlderThan(last, 30, NOW), false);
});

test('isOlderThan: age slightly > retentionDays -> true (2.5)', () => {
  // retentionDays days + 1 hour before now
  const last = new Date(NOW.getTime() - (30 * DAY_MS + 3600000));
  assert.equal(isOlderThan(last, 30, NOW), true);
});

test('isOlderThan: recent message well within retention -> false', () => {
  const last = new Date(NOW.getTime() - 1 * DAY_MS);
  assert.equal(isOlderThan(last, 30, NOW), false);
});

test('isOlderThan: far older message -> true', () => {
  const last = new Date(NOW.getTime() - 365 * DAY_MS);
  assert.equal(isOlderThan(last, 30, NOW), true);
});

test('isOlderThan: age just under threshold (retention days - 1 hour) -> false', () => {
  const last = new Date(NOW.getTime() - (30 * DAY_MS - 3600000));
  assert.equal(isOlderThan(last, 30, NOW), false);
});

// --- hasStar (2.6) ---

test('hasStar: thread with starred messages -> true', () => {
  assert.equal(hasStar({ hasStarredMessages: () => true }), true);
});

test('hasStar: thread without starred messages -> false', () => {
  assert.equal(hasStar({ hasStarredMessages: () => false }), false);
});
