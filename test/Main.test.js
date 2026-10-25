'use strict';

const test = require('node:test');
const { beforeEach } = require('node:test');
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
 * 各テストで globalThis 上の readArchiveRules / archiveRule / listUserLabelNames /
 * syncLabelSheet を差し替える。console.log / Logger を残さないよう、テスト後にクリーンアップする。
 * expandRules は実装（Config.js）を共有するため削除しない。
 */
function cleanup() {
  delete globalThis.syncLabelSheet;
  delete globalThis.readArchiveRules;
  delete globalThis.archiveRule;
  delete globalThis.listUserLabelNames;
  delete globalThis.Logger;
}

/** 成功する syncLabelSheet の既定スタブ（移行なし、追加 0 件 / 不在 0 件）。 */
function defaultSyncResult() {
  return { migrated: false, migratedCheckedCount: 0, appendedCount: 0, missingCount: 0 };
}

// 5.1: archiveLabeledThreads は冒頭で syncLabelSheet を呼ぶ。全テストに成功する既定スタブを置き、
// 同期の振る舞いを検証するテストだけが個別に差し替える（cleanup() で削除）。
beforeEach(() => {
  globalThis.syncLabelSheet = () => defaultSyncResult();
});

// --- 1.3: 有効ルール 0 件 → 何もせず正常終了 ---

test('empty rules: archiveRule and listUserLabelNames are never called, returns without throwing (1.3)', () => {
  let archiveCalls = 0;
  let labelListCalls = 0;
  globalThis.readArchiveRules = () => ({ rules: [], invalidLabels: [] });
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
  globalThis.readArchiveRules = () => ({
    rules: names.map((n) => ({ labelName: n, retentionDays: 30 })),
    invalidLabels: [],
  });
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

  globalThis.readArchiveRules = () => ({ rules, invalidLabels: [] });
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

  globalThis.readArchiveRules = () => ({ rules, invalidLabels: [] });
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

  globalThis.readArchiveRules = () => ({ rules, invalidLabels: [] });
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
  globalThis.readArchiveRules = () => ({
    rules: [{ labelName: 'Work', retentionDays: 30 }],
    invalidLabels: [],
  });
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

// --- label-sheet-sync: 日次実行冒頭の同期と、同期失敗・無効行のログ／通知（5.1, 6.1, 3.5, 4.7, 5.3, 3.8） ---

test('sync step: syncLabelSheet is called before readArchiveRules (5.1)', () => {
  const order = [];
  globalThis.syncLabelSheet = () => {
    order.push('sync');
    return defaultSyncResult();
  };
  globalThis.readArchiveRules = () => {
    order.push('read');
    return { rules: [{ labelName: 'A', retentionDays: 30 }], invalidLabels: [] };
  };
  globalThis.listUserLabelNames = () => ['A'];
  globalThis.archiveRule = (rule) => ({ labelName: rule.labelName, archivedCount: 0, candidateCount: 0 });

  const log = captureLog();
  try {
    archiveLabeledThreads();
  } finally {
    log.restore();
  }
  assert.deepEqual(order, ['sync', 'read']);
  cleanup();
});

test('sync failure: archive and summary still run, then throws once (6.1)', () => {
  const calledLabels = [];
  globalThis.syncLabelSheet = () => {
    throw new Error('lock timeout');
  };
  globalThis.readArchiveRules = () => ({
    rules: [{ labelName: 'A', retentionDays: 30 }],
    invalidLabels: [],
  });
  globalThis.listUserLabelNames = () => ['A'];
  globalThis.archiveRule = (rule) => {
    calledLabels.push(rule.labelName);
    return { labelName: rule.labelName, archivedCount: 1, candidateCount: 1 };
  };

  const log = captureLog();
  let thrown;
  try {
    archiveLabeledThreads();
  } catch (err) {
    thrown = err;
  } finally {
    log.restore();
  }
  assert.ok(thrown, 'must throw after archiving when sync failed');
  assert.match(thrown.message, /ラベル一覧の同期に失敗しました/);
  assert.doesNotMatch(thrown.message, /ルールでエラー/);
  assert.deepEqual(calledLabels, ['A'], 'archive must continue after sync failure');
  const failLine =
    '⚠️ [エラー] ラベル一覧の同期に失敗しました。現在の設定でアーカイブを続行し、終了時にエラーとして通知します: lock timeout';
  assert.equal(log.lines.filter((l) => l === failLine).length, 1, log.lines.join('\n'));
  const summaryIdx = log.lines.findIndex((l) => l.startsWith('📊 [サマリ]'));
  assert.ok(summaryIdx > log.lines.indexOf(failLine), 'summary must be logged after the sync failure line');
  assert.ok(!log.lines.some((l) => l.startsWith('✅ [同期完了]')), 'no sync-complete line on failure');
  cleanup();
});

test('sync failure with 0 rules: throws instead of returning (3.8, 6.1)', () => {
  let labelListCalls = 0;
  globalThis.syncLabelSheet = () => {
    throw new Error('Gmail down');
  };
  globalThis.readArchiveRules = () => ({ rules: [], invalidLabels: [] });
  globalThis.listUserLabelNames = () => {
    labelListCalls += 1;
    return [];
  };
  globalThis.archiveRule = () => {
    throw new Error('must not be called');
  };

  const log = captureLog();
  try {
    assert.throws(() => archiveLabeledThreads(), /ラベル一覧の同期に失敗しました/);
  } finally {
    log.restore();
  }
  assert.equal(labelListCalls, 0, '0-rule short-circuit still skips listUserLabelNames');
  assert.ok(log.lines.some((l) => l.startsWith('ℹ️ [スキップ] 対象のルールが無いため')));
  cleanup();
});

test('sync failure + rule errors: a single throw mentions both causes (6.1, 5.2)', () => {
  globalThis.syncLabelSheet = () => {
    throw new Error('write failed');
  };
  globalThis.readArchiveRules = () => ({
    rules: [
      { labelName: 'A', retentionDays: 30 },
      { labelName: 'B', retentionDays: 30 },
      { labelName: 'C', retentionDays: 30 },
    ],
    invalidLabels: [],
  });
  globalThis.listUserLabelNames = () => ['A', 'B', 'C'];
  globalThis.archiveRule = (rule) => {
    if (rule.labelName !== 'B') {
      throw new Error('boom ' + rule.labelName);
    }
    return { labelName: rule.labelName, archivedCount: 0, candidateCount: 0 };
  };

  const log = captureLog();
  try {
    assert.throws(
      () => archiveLabeledThreads(),
      (err) => {
        assert.equal(
          err.message,
          'ラベル一覧の同期に失敗しました / 2件のルールでエラーが発生しました（詳細は実行ログを参照）。'
        );
        return true;
      }
    );
  } finally {
    log.restore();
  }
  assert.ok(log.lines.some((l) => l.startsWith('📊 [サマリ]')));
  cleanup();
});

test('rule errors only: message keeps the existing wording (5.2)', () => {
  globalThis.readArchiveRules = () => ({
    rules: [{ labelName: 'A', retentionDays: 30 }],
    invalidLabels: [],
  });
  globalThis.listUserLabelNames = () => ['A'];
  globalThis.archiveRule = () => {
    throw new Error('boom');
  };

  const log = captureLog();
  try {
    assert.throws(
      () => archiveLabeledThreads(),
      (err) => {
        assert.equal(err.message, '1件のルールでエラーが発生しました（詳細は実行ログを参照）。');
        return true;
      }
    );
  } finally {
    log.restore();
  }
  cleanup();
});

test('invalidLabels: one ℹ️ skip line per label, without throwing (3.5)', () => {
  globalThis.readArchiveRules = () => ({
    rules: [{ labelName: 'A', retentionDays: 30 }],
    invalidLabels: ['X', 'Work/Y'],
  });
  globalThis.listUserLabelNames = () => ['A', 'X', 'Work/Y'];
  globalThis.archiveRule = (rule) => ({ labelName: rule.labelName, archivedCount: 0, candidateCount: 0 });

  const log = captureLog();
  try {
    assert.doesNotThrow(() => archiveLabeledThreads());
  } finally {
    log.restore();
  }
  const skipLines = log.lines.filter((l) => l.includes('保持日数が無効なためスキップしました'));
  assert.deepEqual(skipLines, [
    'ℹ️ [スキップ] ラベル「X」は対象にチェックがありますが、保持日数が無効なためスキップしました（正の整数を入力してください）。',
    'ℹ️ [スキップ] ラベル「Work/Y」は対象にチェックがありますが、保持日数が無効なためスキップしました（正の整数を入力してください）。',
  ]);
  cleanup();
});

test('invalidLabels are logged even when there are 0 rules (3.5, 3.8)', () => {
  globalThis.readArchiveRules = () => ({ rules: [], invalidLabels: ['X'] });
  globalThis.listUserLabelNames = () => [];
  globalThis.archiveRule = () => {
    throw new Error('must not be called');
  };

  const log = captureLog();
  try {
    assert.doesNotThrow(() => archiveLabeledThreads());
  } finally {
    log.restore();
  }
  assert.equal(
    log.lines.filter((l) => l.startsWith('ℹ️ [スキップ] ラベル「X」は対象にチェックがありますが')).length,
    1
  );
  cleanup();
});

test('sync success without migration: logs 同期完了 once and no 移行完了 (5.3, 4.7)', () => {
  globalThis.syncLabelSheet = () => ({
    migrated: false,
    migratedCheckedCount: 0,
    appendedCount: 3,
    missingCount: 1,
  });
  globalThis.readArchiveRules = () => ({ rules: [], invalidLabels: [] });

  const log = captureLog();
  try {
    archiveLabeledThreads();
  } finally {
    log.restore();
  }
  assert.deepEqual(
    log.lines.filter((l) => l.startsWith('✅ [同期完了]')),
    ['✅ [同期完了] ラベル一覧を同期しました: 追加 3件 / Gmail に存在しない 1件']
  );
  assert.ok(!log.lines.some((l) => l.startsWith('✅ [移行完了]')), 'no migration line when not migrated');
  cleanup();
});

test('sync success with migration: logs 移行完了 then 同期完了, once each (4.7, 5.3)', () => {
  globalThis.syncLabelSheet = () => ({
    migrated: true,
    migratedCheckedCount: 5,
    appendedCount: 0,
    missingCount: 0,
  });
  globalThis.readArchiveRules = () => ({ rules: [], invalidLabels: [] });

  const log = captureLog();
  try {
    archiveLabeledThreads();
  } finally {
    log.restore();
  }
  const migLine = '✅ [移行完了] 設定シートを新しい形式に移行しました: 対象にチェック 5件';
  const syncLine = '✅ [同期完了] ラベル一覧を同期しました: 追加 0件 / Gmail に存在しない 0件';
  assert.equal(log.lines.filter((l) => l === migLine).length, 1, log.lines.join('\n'));
  assert.equal(log.lines.filter((l) => l === syncLine).length, 1, log.lines.join('\n'));
  assert.ok(log.lines.indexOf(migLine) < log.lines.indexOf(syncLine));
  cleanup();
});

test('config error after sync failure: config error is rethrown immediately (6.3, 6.4)', () => {
  let archiveCalls = 0;
  globalThis.syncLabelSheet = () => {
    throw new Error('sheet missing');
  };
  globalThis.readArchiveRules = () => {
    throw new Error('missing CONFIG_SPREADSHEET_ID');
  };
  globalThis.archiveRule = () => {
    archiveCalls += 1;
    return { labelName: 'x', archivedCount: 0, candidateCount: 0 };
  };

  const log = captureLog();
  try {
    assert.throws(() => archiveLabeledThreads(), /missing CONFIG_SPREADSHEET_ID/);
  } finally {
    log.restore();
  }
  assert.equal(archiveCalls, 0);
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
