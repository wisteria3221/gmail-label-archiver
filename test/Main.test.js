'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Constants = require('../src/Constants.js');
Object.assign(globalThis, Constants);

const { archiveLabeledThreads } = require('../src/Main.js');

/**
 * 各テストで globalThis 上の readArchiveRules / archiveRule を差し替える。
 * console.log / Logger を残さないよう、テスト後にクリーンアップする。
 */
function cleanup() {
  delete globalThis.readArchiveRules;
  delete globalThis.archiveRule;
  delete globalThis.Logger;
}

// --- 1.3: 有効ルール 0 件 → 何もせず正常終了 ---

test('empty rules: archiveRule is never called and returns without throwing (1.3)', () => {
  let archiveCalls = 0;
  globalThis.readArchiveRules = () => [];
  globalThis.archiveRule = () => {
    archiveCalls += 1;
    return { labelName: 'x', archivedCount: 0, candidateCount: 0 };
  };

  assert.doesNotThrow(() => archiveLabeledThreads());
  assert.equal(archiveCalls, 0, 'archiveRule must not be called when there are no rules');

  cleanup();
});

// --- 5.1: 残予算が各ルールへ正しく伝播（前ルールの archivedCount だけ減る） ---

test('ample budget: remaining decreases by previous rule archivedCount (5.1)', () => {
  const rules = [
    { labelName: 'A', retentionDays: 30 },
    { labelName: 'B', retentionDays: 30 },
    { labelName: 'C', retentionDays: 30 },
  ];
  const archivedByLabel = { A: 10, B: 25, C: 0 };
  const remainingArgs = [];

  globalThis.readArchiveRules = () => rules;
  globalThis.archiveRule = (rule, now, remaining) => {
    remainingArgs.push({ labelName: rule.labelName, remaining });
    assert.ok(now instanceof Date, 'now must be a Date');
    return {
      labelName: rule.labelName,
      archivedCount: archivedByLabel[rule.labelName],
      candidateCount: archivedByLabel[rule.labelName],
    };
  };

  archiveLabeledThreads();

  assert.equal(remainingArgs.length, 3, 'archiveRule called once per rule');
  assert.equal(remainingArgs[0].remaining, MAX_THREADS_PER_RUN);
  assert.equal(remainingArgs[1].remaining, MAX_THREADS_PER_RUN - 10);
  assert.equal(remainingArgs[2].remaining, MAX_THREADS_PER_RUN - 10 - 25);

  cleanup();
});

// --- 5.1: 予算枯渇 → 以降のルールをスキップ ---

test('budget exhaustion: later rules are skipped (5.1)', () => {
  const rules = [
    { labelName: 'A', retentionDays: 30 },
    { labelName: 'B', retentionDays: 30 },
    { labelName: 'C', retentionDays: 30 },
  ];
  const calledLabels = [];

  globalThis.readArchiveRules = () => rules;
  globalThis.archiveRule = (rule) => {
    calledLabels.push(rule.labelName);
    // First rule consumes the entire budget.
    const archived = rule.labelName === 'A' ? MAX_THREADS_PER_RUN : 0;
    return {
      labelName: rule.labelName,
      archivedCount: archived,
      candidateCount: archived,
    };
  };

  assert.doesNotThrow(() => archiveLabeledThreads());
  assert.deepEqual(calledLabels, ['A'], 'rules B and C must be skipped once budget is 0');

  cleanup();
});

// --- 5.2: ルール単位エラー → 記録して次ルールへ継続 ---

test('per-rule error: subsequent rule still processed, no throw (5.2)', () => {
  const rules = [
    { labelName: 'A', retentionDays: 30 },
    { labelName: 'B', retentionDays: 30 },
    { labelName: 'C', retentionDays: 30 },
  ];
  const calledLabels = [];

  globalThis.readArchiveRules = () => rules;
  globalThis.archiveRule = (rule) => {
    calledLabels.push(rule.labelName);
    if (rule.labelName === 'B') {
      throw new Error('boom for B');
    }
    return { labelName: rule.labelName, archivedCount: 1, candidateCount: 1 };
  };

  assert.doesNotThrow(() => archiveLabeledThreads());
  assert.deepEqual(
    calledLabels,
    ['A', 'B', 'C'],
    'rule C must still be processed after rule B throws'
  );

  cleanup();
});

// --- Error Strategy（構成不備）: readArchiveRules が throw → 終了（再throwしない） ---

test('config error: readArchiveRules throws → archiveLabeledThreads does not throw, archiveRule never called', () => {
  let archiveCalls = 0;
  globalThis.readArchiveRules = () => {
    throw new Error('missing CONFIG_SPREADSHEET_ID');
  };
  globalThis.archiveRule = () => {
    archiveCalls += 1;
    return { labelName: 'x', archivedCount: 0, candidateCount: 0 };
  };

  assert.doesNotThrow(() => archiveLabeledThreads());
  assert.equal(archiveCalls, 0, 'archiveRule must not run when config read fails');

  cleanup();
});

// --- 4.3: 引数なしで呼べる共通エントリであること ---

test('entry takes no arguments (trigger/manual common entry, 4.3)', () => {
  assert.equal(archiveLabeledThreads.length, 0, 'archiveLabeledThreads must take no parameters');
});
