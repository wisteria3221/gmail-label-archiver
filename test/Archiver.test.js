'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Constants = require('../src/Constants.js');
Object.assign(globalThis, Constants);

const {
  buildQuery,
  isOlderThan,
  hasStar,
  archiveRule,
  listUserLabelNames,
} = require('../src/Archiver.js');

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

// --- archiveRule (2.1-2.6, 3.1-3.4, 5.1, 5.4) ---

const RULE_NOW = new Date('2026-06-06T00:00:00Z');

// fake GmailThread: only the methods archiveRule is allowed to use.
// 実 GmailThread と同様に一意な getId を持たせる。
let fakeThreadSeq = 0;
function fakeThread(lastDateISO, starred) {
  const id = 'fake-' + ++fakeThreadSeq;
  return {
    getId: () => id,
    getLastMessageDate: () => new Date(lastDateISO),
    hasStarredMessages: () => starred,
  };
}

// Install a GmailApp mock that exposes ONLY search + moveThreadsToArchive.
// If archiveRule called any other (destructive) method, it would throw.
// `calls` records the order of search / archive calls (for pagination checks).
function installGmail(searchResults) {
  const archivedBatches = [];
  installGmail.calls = [];
  globalThis.GmailApp = {
    search: (q, start, max) => {
      installGmail._lastSearch = { q, start, max };
      installGmail.calls.push({ type: 'search', start, max });
      return searchResults.slice(start, start + max);
    },
    moveThreadsToArchive: (threads) => {
      installGmail.calls.push({ type: 'archive' });
      archivedBatches.push(threads);
    },
  };
  return archivedBatches;
}

function recentUnstarred() {
  return fakeThread(new Date(RULE_NOW.getTime() - 1 * DAY_MS).toISOString(), false);
}

function oldUnstarred() {
  return fakeThread(new Date(RULE_NOW.getTime() - 365 * DAY_MS).toISOString(), false);
}

test('archiveRule: mixed candidates -> only old+unstarred archived (2.2, 2.5, 2.6, 3.1)', () => {
  const old = oldUnstarred();
  const recent = fakeThread(
    new Date(RULE_NOW.getTime() - 1 * DAY_MS).toISOString(),
    false
  );
  const starred = fakeThread(
    new Date(RULE_NOW.getTime() - 365 * DAY_MS).toISOString(),
    true
  );
  const batches = installGmail([old, recent, starred]);

  const result = archiveRule(
    { labelName: 'Newsletter', retentionDays: 30 },
    RULE_NOW,
    300
  );

  assert.equal(result.archivedCount, 1);
  assert.equal(result.candidateCount, 3);
  // exactly one batch with exactly the valid thread
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
  assert.equal(batches[0][0], old);
});

test('archiveRule: query is built via buildQuery (2.1, 2.3)', () => {
  installGmail([]);
  archiveRule({ labelName: 'My Label', retentionDays: 7 }, RULE_NOW, 300);
  assert.equal(
    installGmail._lastSearch.q,
    'label:"My Label" in:inbox -is:starred older_than:7d'
  );
});

test('archiveRule: label-not-found / empty search -> 0 archived, never archives (2.4, 3.4)', () => {
  const batches = installGmail([]);
  const result = archiveRule(
    { labelName: 'Missing', retentionDays: 30 },
    RULE_NOW,
    300
  );
  assert.equal(result.archivedCount, 0);
  assert.equal(result.candidateCount, 0);
  assert.equal(batches.length, 0);
});

test('archiveRule: candidates all filtered out -> 0 archived, never archives (3.4)', () => {
  const recent = fakeThread(
    new Date(RULE_NOW.getTime() - 1 * DAY_MS).toISOString(),
    false
  );
  const batches = installGmail([recent]);
  const result = archiveRule(
    { labelName: 'Newsletter', retentionDays: 30 },
    RULE_NOW,
    300
  );
  assert.equal(result.archivedCount, 0);
  assert.equal(result.candidateCount, 1);
  assert.equal(batches.length, 0);
});

test('archiveRule: remaining cap -> archivedCount <= remaining, carry-over (5.1)', () => {
  const valids = [
    oldUnstarred(),
    oldUnstarred(),
    oldUnstarred(),
    oldUnstarred(),
    oldUnstarred(),
  ];
  const batches = installGmail(valids);
  const result = archiveRule(
    { labelName: 'Newsletter', retentionDays: 30 },
    RULE_NOW,
    2
  );
  assert.equal(result.archivedCount, 2);
  // only 2 actually archived
  const total = batches.reduce((n, b) => n + b.length, 0);
  assert.equal(total, 2);
});

test('archiveRule: each search page requests ARCHIVE_SEARCH_LIMIT regardless of remaining', () => {
  installGmail([]);
  archiveRule({ labelName: 'Newsletter', retentionDays: 30 }, RULE_NOW, 2);
  assert.equal(installGmail._lastSearch.start, 0);
  assert.equal(installGmail._lastSearch.max, ARCHIVE_SEARCH_LIMIT);
});

// --- archiveRule pagination: 除外対象が検索先頭を占めても後続ページの対象へ届く ---

test('archiveRule: paginates past a full page of non-qualifying threads to reach targets', () => {
  // 先頭 1 ページ分は「最近の返信あり」で除外対象、その後ろに本来の対象がある。
  const results = [];
  for (let i = 0; i < ARCHIVE_SEARCH_LIMIT; i++) results.push(recentUnstarred());
  const old1 = oldUnstarred();
  const old2 = oldUnstarred();
  results.push(old1, old2);
  const batches = installGmail(results);

  const result = archiveRule(
    { labelName: 'Newsletter', retentionDays: 30 },
    RULE_NOW,
    300
  );

  assert.equal(result.archivedCount, 2);
  assert.equal(result.candidateCount, ARCHIVE_SEARCH_LIMIT + 2);
  assert.deepEqual(batches.flat(), [old1, old2]);
  const searches = installGmail.calls.filter((c) => c.type === 'search');
  assert.deepEqual(
    searches.map((c) => c.start),
    [0, ARCHIVE_SEARCH_LIMIT]
  );
});

test('archiveRule: small remaining still reaches targets behind non-qualifying threads', () => {
  const results = [recentUnstarred(), recentUnstarred(), recentUnstarred()];
  const old1 = oldUnstarred();
  results.push(old1);
  const batches = installGmail(results);

  const result = archiveRule(
    { labelName: 'Newsletter', retentionDays: 30 },
    RULE_NOW,
    1
  );

  assert.equal(result.archivedCount, 1);
  assert.deepEqual(batches.flat(), [old1]);
});

test('archiveRule: stops searching once remaining targets are confirmed', () => {
  const results = [];
  for (let i = 0; i < ARCHIVE_SEARCH_LIMIT * 2; i++) results.push(oldUnstarred());
  installGmail(results);

  const result = archiveRule(
    { labelName: 'Newsletter', retentionDays: 30 },
    RULE_NOW,
    3
  );

  assert.equal(result.archivedCount, 3);
  const searches = installGmail.calls.filter((c) => c.type === 'search');
  assert.equal(searches.length, 1, 'no further page once remaining is satisfied');
});

test('archiveRule: scanning is bounded by ARCHIVE_SCAN_LIMIT_PER_RULE', () => {
  const results = [];
  for (let i = 0; i < ARCHIVE_SCAN_LIMIT_PER_RULE + ARCHIVE_SEARCH_LIMIT; i++) {
    results.push(recentUnstarred());
  }
  results.push(oldUnstarred());
  const batches = installGmail(results);

  const result = archiveRule(
    { labelName: 'Newsletter', retentionDays: 30 },
    RULE_NOW,
    300
  );

  assert.equal(result.archivedCount, 0);
  assert.equal(result.candidateCount, ARCHIVE_SCAN_LIMIT_PER_RULE);
  assert.equal(batches.length, 0);
  const searches = installGmail.calls.filter((c) => c.type === 'search');
  const requested = searches.reduce((n, c) => n + c.max, 0);
  assert.ok(
    requested <= ARCHIVE_SCAN_LIMIT_PER_RULE,
    'must not request more threads than the per-rule scan limit'
  );
});

test('archiveRule: archives only after all search pages are fetched (keeps offsets stable)', () => {
  // アーカイブで in:inbox から外れると後続ページの offset がずれるため、
  // 全ページの走査が終わってからアーカイブする。
  const results = [];
  for (let i = 0; i < ARCHIVE_SEARCH_LIMIT; i++) results.push(oldUnstarred());
  for (let i = 0; i < 10; i++) results.push(oldUnstarred());
  installGmail(results);

  archiveRule({ labelName: 'Newsletter', retentionDays: 30 }, RULE_NOW, 300);

  const types = installGmail.calls.map((c) => c.type);
  const lastSearch = types.lastIndexOf('search');
  const firstArchive = types.indexOf('archive');
  assert.ok(firstArchive > lastSearch, 'no archive call may precede a search call');
});

test('archiveRule: duplicate thread across pages is archived only once', () => {
  const dup = oldUnstarredWithId('dup');
  const results = [];
  for (let i = 0; i < ARCHIVE_SEARCH_LIMIT - 1; i++) results.push(recentUnstarred());
  results.push(dup, dup);
  const batches = installGmail(results);

  const result = archiveRule(
    { labelName: 'Newsletter', retentionDays: 30 },
    RULE_NOW,
    300,
    new Set()
  );

  assert.equal(result.archivedCount, 1);
  assert.deepEqual(batches.flat(), [dup]);
});

test('archiveRule: remaining <= 0 -> 0 archived, search NOT called (5.1)', () => {
  let searched = false;
  globalThis.GmailApp = {
    search: () => {
      searched = true;
      return [];
    },
    moveThreadsToArchive: () => {},
  };
  const result = archiveRule(
    { labelName: 'Newsletter', retentionDays: 30 },
    RULE_NOW,
    0
  );
  assert.equal(result.archivedCount, 0);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.labelName, 'Newsletter');
  assert.equal(searched, false);
});

test('archiveRule: batching -> each moveThreadsToArchive call <= ARCHIVE_BATCH_SIZE (3.1)', () => {
  const valids = [];
  for (let i = 0; i < 150; i++) valids.push(oldUnstarred());
  const batches = installGmail(valids);
  const result = archiveRule(
    { labelName: 'Newsletter', retentionDays: 30 },
    RULE_NOW,
    300
  );
  assert.equal(result.archivedCount, 150);
  let total = 0;
  for (const b of batches) {
    assert.ok(b.length <= ARCHIVE_BATCH_SIZE, 'batch exceeds ARCHIVE_BATCH_SIZE');
    total += b.length;
  }
  assert.equal(total, 150);
});

test('archiveRule: non-destructive -> only search + moveThreadsToArchive used (3.2, 3.3)', () => {
  // mock exposes ONLY the two allowed methods; any other call throws.
  const valids = [oldUnstarred(), oldUnstarred()];
  installGmail(valids);
  assert.doesNotThrow(() => {
    archiveRule({ labelName: 'Newsletter', retentionDays: 30 }, RULE_NOW, 300);
  });
});

test('archiveRule: returns correct ArchiveResult shape', () => {
  installGmail([oldUnstarred()]);
  const result = archiveRule(
    { labelName: 'Newsletter', retentionDays: 30 },
    RULE_NOW,
    300
  );
  assert.deepEqual(Object.keys(result).sort(), [
    'archivedCount',
    'candidateCount',
    'labelName',
  ]);
  assert.equal(result.labelName, 'Newsletter');
  assert.equal(typeof result.archivedCount, 'number');
  assert.equal(typeof result.candidateCount, 'number');
});

// --- archiveRule dedup via seenThreadIds (6.7, 6.8) ---

// fake GmailThread with an id, for the dedup path.
function fakeThreadWithId(id, lastDateISO, starred) {
  return {
    getId: () => id,
    getLastMessageDate: () => new Date(lastDateISO),
    hasStarredMessages: () => starred,
  };
}

function oldUnstarredWithId(id) {
  return fakeThreadWithId(
    id,
    new Date(RULE_NOW.getTime() - 365 * DAY_MS).toISOString(),
    false
  );
}

test('archiveRule: pre-seeded seenThreadIds excludes that thread from archive/count (6.8)', () => {
  const t1 = oldUnstarredWithId('t1');
  const t2 = oldUnstarredWithId('t2');
  const batches = installGmail([t1, t2]);
  const seen = new Set(['t1']);

  const result = archiveRule(
    { labelName: 'Newsletter', retentionDays: 30 },
    RULE_NOW,
    300,
    seen
  );

  // only t2 archived; t1 excluded because already seen
  assert.equal(result.archivedCount, 1);
  assert.equal(result.candidateCount, 2);
  const total = batches.reduce((n, b) => n + b.length, 0);
  assert.equal(total, 1);
  assert.equal(batches[0][0], t2);
});

test('archiveRule: archived thread ids are added to seenThreadIds (6.8)', () => {
  const t1 = oldUnstarredWithId('a1');
  const t2 = oldUnstarredWithId('a2');
  installGmail([t1, t2]);
  const seen = new Set();

  archiveRule(
    { labelName: 'Newsletter', retentionDays: 30 },
    RULE_NOW,
    300,
    seen
  );

  assert.ok(seen.has('a1'));
  assert.ok(seen.has('a2'));
  assert.equal(seen.size, 2);
});

test('archiveRule: shared seenThreadIds across calls prevents double-count (parent/child, 6.8)', () => {
  // Same thread object hit by both parent and child rule.
  const shared = oldUnstarredWithId('shared');

  // First (parent) call.
  const batches1 = installGmail([shared]);
  const seen = new Set();
  const r1 = archiveRule(
    { labelName: '仕事', retentionDays: 30 },
    RULE_NOW,
    300,
    seen
  );
  assert.equal(r1.archivedCount, 1);
  assert.equal(batches1.reduce((n, b) => n + b.length, 0), 1);

  // Second (child) call sees the same thread again but it's already in seen.
  const batches2 = installGmail([shared]);
  const r2 = archiveRule(
    { labelName: '仕事/案件A', retentionDays: 30 },
    RULE_NOW,
    300,
    seen
  );
  assert.equal(r2.archivedCount, 0);
  assert.equal(batches2.length, 0);
  assert.equal(seen.size, 1);
});

// --- listUserLabelNames (6.1) ---

test('listUserLabelNames: maps label objects to name strings (6.1)', () => {
  globalThis.GmailApp = {
    getUserLabels: () => [
      { getName: () => '仕事' },
      { getName: () => '仕事/案件A' },
    ],
  };
  assert.deepEqual(listUserLabelNames(), ['仕事', '仕事/案件A']);
});

test('listUserLabelNames: empty label list -> empty array (6.1)', () => {
  globalThis.GmailApp = { getUserLabels: () => [] };
  assert.deepEqual(listUserLabelNames(), []);
});
