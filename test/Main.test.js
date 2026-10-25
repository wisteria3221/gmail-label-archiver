'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Constants = require('../src/Constants.js');
Object.assign(globalThis, Constants);

// 統合タスク（6.5）: archiveLabeledThreads は listUserLabelNames + expandRules も
// 呼ぶ。expandRules は Config.js の実装をそのまま利用し、listUserLabelNames は
// 各テストでスタブする（GmailApp 非依存に保つ）。
const { expandRules } = require('../src/Config.js');
globalThis.expandRules = expandRules;

const { archiveLabeledThreads, setupDailyTrigger, removeAllTriggers } = require('../src/Main.js');

/**
 * 各テストで globalThis 上の readArchiveRules / archiveRule / listUserLabelNames
 * を差し替える。console.log / Logger を残さないよう、テスト後にクリーンアップする。
 * expandRules は実装（Config.js）を共有するため削除しない。
 */
function cleanup() {
  delete globalThis.readArchiveRules;
  delete globalThis.archiveRule;
  delete globalThis.listUserLabelNames;
  delete globalThis.Logger;
}

// --- 1.3: 有効ルール 0 件 → 何もせず正常終了 ---

test('empty rules: archiveRule and listUserLabelNames are never called, returns without throwing (1.3)', () => {
  let archiveCalls = 0;
  let labelListCalls = 0;
  globalThis.readArchiveRules = () => [];
  globalThis.listUserLabelNames = () => {
    labelListCalls += 1;
    return [];
  };
  globalThis.archiveRule = () => {
    archiveCalls += 1;
    return { labelName: 'x', archivedCount: 0, candidateCount: 0 };
  };

  assert.doesNotThrow(() => archiveLabeledThreads());
  assert.equal(archiveCalls, 0, 'archiveRule must not be called when there are no rules');
  assert.equal(
    labelListCalls,
    0,
    'listUserLabelNames must NOT be called when there are 0 explicit rules (short-circuit, no Gmail round trip)'
  );

  cleanup();
});

// --- 5.1: 予算の公平配分（各ルールに残予算 ÷ 残ルール数、余りは後続・2 巡目へ） ---

/**
 * 各ラベルの滞留件数 backlog を持つ archiveRule スタブを設置する。
 * 渡された予算 remaining の範囲で滞留を消化し、呼び出し履歴を calls に記録する。
 */
function installBacklogArchiveRule(backlog) {
  const calls = [];
  const left = Object.assign({}, backlog);
  globalThis.archiveRule = (rule, now, remaining) => {
    assert.ok(now instanceof Date, 'now must be a Date');
    const archived = Math.min(left[rule.labelName], remaining);
    left[rule.labelName] -= archived;
    calls.push({ labelName: rule.labelName, remaining, archived });
    return { labelName: rule.labelName, archivedCount: archived, candidateCount: archived };
  };
  return calls;
}

function setRules(names) {
  globalThis.readArchiveRules = () => names.map((n) => ({ labelName: n, retentionDays: 30 }));
  globalThis.listUserLabelNames = () => names.slice();
}

test('fair share: every rule gets an equal share when all have large backlogs (5.1)', () => {
  setRules(['A', 'B', 'C']);
  const calls = installBacklogArchiveRule({ A: 1000, B: 1000, C: 1000 });

  archiveLabeledThreads();

  assert.deepEqual(
    calls.map((c) => [c.labelName, c.remaining, c.archived]),
    [
      ['A', 100, 100],
      ['B', 100, 100],
      ['C', 100, 100],
    ]
  );
  cleanup();
});

test('fair share: unused share of an earlier rule flows to later rules (5.1)', () => {
  setRules(['A', 'B', 'C']);
  const calls = installBacklogArchiveRule({ A: 10, B: 1000, C: 1000 });

  archiveLabeledThreads();

  assert.deepEqual(
    calls.map((c) => [c.labelName, c.remaining, c.archived]),
    [
      ['A', 100, 10],
      ['B', 145, 145],
      ['C', 145, 145],
    ]
  );
  cleanup();
});

test('fair share: leftover budget goes to rules that hit their share in a second pass (5.1)', () => {
  setRules(['A', 'B', 'C']);
  const calls = installBacklogArchiveRule({ A: 1000, B: 0, C: 0 });

  archiveLabeledThreads();

  assert.deepEqual(
    calls.map((c) => [c.labelName, c.remaining, c.archived]),
    [
      ['A', 100, 100],
      ['B', 100, 0],
      ['C', 200, 0],
      ['A', 200, 200],
    ]
  );
  const total = calls.reduce((n, c) => n + c.archived, 0);
  assert.equal(total, MAX_THREADS_PER_RUN);
  cleanup();
});

test('fair share: more rules than budget gives each at least 1 until exhausted (5.1)', () => {
  const names = [];
  for (let i = 0; i < MAX_THREADS_PER_RUN + 5; i++) names.push('L' + i);
  setRules(names);
  const backlog = {};
  for (const n of names) backlog[n] = 10;
  const calls = installBacklogArchiveRule(backlog);

  archiveLabeledThreads();

  assert.equal(calls.length, MAX_THREADS_PER_RUN, 'rules beyond the budget are skipped');
  assert.ok(calls.every((c) => c.remaining === 1));
  cleanup();
});

test('fair share: summary reports each rule once with its total across passes', () => {
  setRules(['A', 'B']);
  installBacklogArchiveRule({ A: 1000, B: 0 });
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    archiveLabeledThreads();
  } finally {
    console.log = original;
  }

  const summary = lines.find((l) => l.startsWith('📊 [サマリ]'));
  assert.ok(summary, 'summary must be logged');
  assert.ok(summary.includes('ルール 2件中 処理成功 2件'));
  assert.ok(summary.includes('[「A」300件, 「B」0件]'), summary);
  cleanup();
});

// --- 5.2: ルール単位エラー → 記録して次ルールへ継続し、最後に throw（失敗通知） ---

/** console.log を差し替えて出力行を収集する。戻り値の restore() で元に戻す。 */
function captureLog() {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  return { lines, restore: () => (console.log = original) };
}

test('per-rule error: subsequent rule still processed, then throws for failure notification (5.2)', () => {
  const rules = [
    { labelName: 'A', retentionDays: 30 },
    { labelName: 'B', retentionDays: 30 },
    { labelName: 'C', retentionDays: 30 },
  ];
  const calledLabels = [];

  globalThis.readArchiveRules = () => rules;
  globalThis.listUserLabelNames = () => ['A', 'B', 'C'];
  globalThis.archiveRule = (rule) => {
    calledLabels.push(rule.labelName);
    if (rule.labelName === 'B') {
      throw new Error('boom for B');
    }
    return { labelName: rule.labelName, archivedCount: 1, candidateCount: 1 };
  };

  const log = captureLog();
  try {
    assert.throws(() => archiveLabeledThreads(), /1件のルールでエラー/);
  } finally {
    log.restore();
  }
  assert.deepEqual(
    calledLabels,
    ['A', 'B', 'C'],
    'rule C must still be processed after rule B throws'
  );
  assert.ok(
    log.lines.some((l) => l.startsWith('📊 [サマリ]')),
    'summary must be logged before throwing'
  );

  cleanup();
});

// --- 6.1: 親ラベル指定時、展開済みの子孫ルールも順次処理される ---

test('expansion wired: descendant labels are expanded and processed (6.1)', () => {
  // 明示ルールは親ラベル「Work」のみ。Gmail には子孫「Work/Project」が存在。
  const rules = [{ labelName: 'Work', retentionDays: 30 }];
  const calledLabels = [];

  globalThis.readArchiveRules = () => rules;
  globalThis.listUserLabelNames = () => ['Work', 'Work/Project', 'Unrelated'];
  globalThis.archiveRule = (rule) => {
    calledLabels.push(rule.labelName);
    return { labelName: rule.labelName, archivedCount: 0, candidateCount: 0 };
  };

  archiveLabeledThreads();

  assert.ok(
    calledLabels.includes('Work'),
    'explicit parent rule must be processed'
  );
  assert.ok(
    calledLabels.includes('Work/Project'),
    'expanded descendant rule must also be processed (6.1)'
  );
  assert.ok(
    !calledLabels.includes('Unrelated'),
    'unrelated label without an ancestor rule must NOT be processed'
  );
  assert.equal(calledLabels.length, 2, 'exactly parent + one descendant processed');

  cleanup();
});

// --- 6.8: 実行全体で 1 つの seenThreadIds Set を全 archiveRule 呼び出しへ共有 ---

test('seenThreadIds shared: same Set instance passed to every archiveRule call (6.8)', () => {
  const rules = [
    { labelName: 'Work', retentionDays: 30 },
    { labelName: 'Home', retentionDays: 30 },
  ];
  const seenArgs = [];

  globalThis.readArchiveRules = () => rules;
  // Work には子孫が 1 つあり、合計 3 ルールへ展開される。
  globalThis.listUserLabelNames = () => ['Work', 'Work/Sub', 'Home'];
  globalThis.archiveRule = (rule, now, remaining, seenThreadIds) => {
    seenArgs.push(seenThreadIds);
    return { labelName: rule.labelName, archivedCount: 0, candidateCount: 0 };
  };

  archiveLabeledThreads();

  assert.equal(seenArgs.length, 3, 'archiveRule called once per expanded rule');
  assert.ok(seenArgs[0] instanceof Set, '4th arg must be a Set');
  for (let i = 1; i < seenArgs.length; i++) {
    assert.strictEqual(
      seenArgs[i],
      seenArgs[0],
      'every archiveRule call must receive the SAME Set instance (6.8)'
    );
  }

  cleanup();
});

// --- ラベル取得失敗 → ログして throw（失敗通知、archiveRule 未呼び出し） ---

test('listUserLabelNames failure: archiveLabeledThreads throws, archiveRule never called', () => {
  let archiveCalls = 0;
  globalThis.readArchiveRules = () => [{ labelName: 'Work', retentionDays: 30 }];
  globalThis.listUserLabelNames = () => {
    throw new Error('Gmail label fetch failed');
  };
  globalThis.archiveRule = () => {
    archiveCalls += 1;
    return { labelName: 'x', archivedCount: 0, candidateCount: 0 };
  };

  assert.throws(() => archiveLabeledThreads(), /Gmail label fetch failed/);
  assert.equal(
    archiveCalls,
    0,
    'archiveRule must not run when label fetch fails'
  );

  cleanup();
});

// --- Error Strategy（構成不備）: readArchiveRules が throw → ログして再 throw（失敗通知） ---

test('config error: readArchiveRules throws → archiveLabeledThreads rethrows, archiveRule never called', () => {
  let archiveCalls = 0;
  globalThis.readArchiveRules = () => {
    throw new Error('missing CONFIG_SPREADSHEET_ID');
  };
  globalThis.archiveRule = () => {
    archiveCalls += 1;
    return { labelName: 'x', archivedCount: 0, candidateCount: 0 };
  };

  assert.throws(() => archiveLabeledThreads(), /missing CONFIG_SPREADSHEET_ID/);
  assert.equal(archiveCalls, 0, 'archiveRule must not run when config read fails');

  cleanup();
});

// --- 4.3: 引数なしで呼べる共通エントリであること ---

test('entry takes no arguments (trigger/manual common entry, 4.3)', () => {
  assert.equal(archiveLabeledThreads.length, 0, 'archiveLabeledThreads must take no parameters');
});

// --- 4.1 / 4.2: 日次トリガーの冪等なセットアップ／削除 ---

/**
 * トリガーストアを実際にモデル化したステートフルな ScriptApp モックを
 * globalThis.ScriptApp にインストールし、ストア配列を返す。
 */
function installScriptApp() {
  const store = [];
  function makeTrigger(handler) {
    return { getHandlerFunction: () => handler };
  }
  globalThis.ScriptApp = {
    getProjectTriggers: () => store.slice(),
    deleteTrigger: (t) => {
      const i = store.indexOf(t);
      if (i >= 0) store.splice(i, 1);
    },
    newTrigger: (handler) => {
      const builder = {
        timeBased: () => builder,
        everyDays: (n) => {
          builder._days = n;
          return builder;
        },
        atHour: (h) => {
          builder._hour = h;
          return builder;
        },
        create: () => {
          const t = makeTrigger(handler);
          t._days = builder._days;
          t._hour = builder._hour;
          store.push(t);
          return t;
        },
      };
      return builder;
    },
    _store: store,
  };
  return store;
}

function triggersFor(store, handler) {
  return store.filter((t) => t.getHandlerFunction() === handler);
}

function cleanupScriptApp() {
  delete globalThis.ScriptApp;
}

test('setupDailyTrigger on empty store creates exactly one daily trigger (4.1)', () => {
  const store = installScriptApp();

  setupDailyTrigger();

  const matching = triggersFor(store, TRIGGER_HANDLER);
  assert.equal(matching.length, 1, 'exactly one archiveLabeledThreads trigger after setup');
  assert.equal(matching[0]._days, 1, 'built with everyDays(1)');
  assert.equal(matching[0]._hour, TRIGGER_HOUR, 'built with atHour(TRIGGER_HOUR)');

  cleanupScriptApp();
});

test('setupDailyTrigger is idempotent: called twice still yields exactly one (4.2)', () => {
  const store = installScriptApp();

  setupDailyTrigger();
  setupDailyTrigger();

  const matching = triggersFor(store, TRIGGER_HANDLER);
  assert.equal(matching.length, 1, 'calling setup twice must still yield exactly one trigger');
  assert.equal(matching[0]._days, 1);
  assert.equal(matching[0]._hour, TRIGGER_HOUR);

  cleanupScriptApp();
});

test('setupDailyTrigger removes stale duplicates first, leaving exactly one (4.2)', () => {
  const store = installScriptApp();
  // Pre-seed two stale matching triggers.
  globalThis.ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyDays(1).atHour(TRIGGER_HOUR).create();
  globalThis.ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyDays(1).atHour(TRIGGER_HOUR).create();
  assert.equal(triggersFor(store, TRIGGER_HANDLER).length, 2, 'precondition: two stale triggers');

  setupDailyTrigger();

  assert.equal(
    triggersFor(store, TRIGGER_HANDLER).length,
    1,
    'after setup exactly one matching trigger remains'
  );

  cleanupScriptApp();
});

test('removeAllTriggers deletes matching triggers and preserves unrelated ones', () => {
  const store = installScriptApp();
  globalThis.ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyDays(1).atHour(TRIGGER_HOUR).create();
  globalThis.ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyDays(1).atHour(TRIGGER_HOUR).create();
  globalThis.ScriptApp.newTrigger('someOther').timeBased().everyDays(1).atHour(TRIGGER_HOUR).create();

  removeAllTriggers();

  assert.equal(triggersFor(store, TRIGGER_HANDLER).length, 0, 'all matching triggers removed');
  assert.equal(triggersFor(store, 'someOther').length, 1, 'unrelated trigger preserved');

  cleanupScriptApp();
});
