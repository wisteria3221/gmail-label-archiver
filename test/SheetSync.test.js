'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// GAS は全 src/*.js を 1 つのグローバルスコープで共有するため、Node でも
// 依存する定数・Config の関数をグローバルに載せてから SheetSync.js を読み込む。
Object.assign(globalThis, require('../src/Constants.js'));
Object.assign(globalThis, require('../src/Config.js'));

const { resolveColumns, collectExplicitRules, expandRules, labelKey } = require('../src/Config.js');
const { planMigration, planSheetSync } = require('../src/SheetSync.js');

// 旧形式（対象列なし）のサンプルシート。各行のコメントは期待する対象値。
const OLD_VALUES = [
  ['ラベル名', '保持日数'],
  ['Newsletter', 30], //     有効 → true
  ['Empty', ''], //          日数が空 → false
  ['Zero', 0], //            0 → false
  ['Negative', -5], //       負 → false
  ['Decimal', 1.5], //       小数 → false
  ['Text', 'abc'], //        数字以外 → false
  ['', 10], //               ラベル名が空 → false
  ['StringDays', ' 7 '], //  文字列の有効日数 → true
];

test('planMigration: 有効行のみ true、無効行・空ラベル行は false（4.3, 4.4）', () => {
  const plan = planMigration(OLD_VALUES, resolveColumns(OLD_VALUES[0]));
  assert.deepEqual(plan.checks, [true, false, false, false, false, false, false, true]);
});

test('planMigration: checkedCount は true の件数（4.7）', () => {
  const plan = planMigration(OLD_VALUES, resolveColumns(OLD_VALUES[0]));
  assert.equal(plan.checkedCount, 2);
});

test('planMigration: 列順に依存せずヘッダで解決した列を使う', () => {
  const values = [
    ['保持日数', 'メモ', 'ラベル名'],
    [14, 'x', 'A'],
    ['', 'y', 'B'],
  ];
  const plan = planMigration(values, resolveColumns(values[0]));
  assert.deepEqual(plan, { checks: [true, false], checkedCount: 1 });
});

test('planMigration: データ行 0 件なら空の計画', () => {
  const values = [['ラベル名', '保持日数']];
  assert.deepEqual(planMigration(values, resolveColumns(values[0])), {
    checks: [],
    checkedCount: 0,
  });
});

test('planMigration: 入力の values を変更しない', () => {
  const values = OLD_VALUES.map((r) => r.slice());
  planMigration(values, resolveColumns(values[0]));
  assert.deepEqual(values, OLD_VALUES);
});

test('planMigration: 移行前後で採用ルールが一致する（4.6）', () => {
  // 重複ラベル（大文字小文字違い・無効行が先）も含めて比較する。
  const oldValues = OLD_VALUES.concat([
    ['newsletter', 90], //  重複（後勝ちしない）
    ['Dup', 'bad'], //      無効が先
    ['DUP', 3], //          有効が後 → 採用
  ]);
  const plan = planMigration(oldValues, resolveColumns(oldValues[0]));

  // 対象列を先頭に挿入した新形式の値（syncLabelSheet の移行書き込みと同じ形）。
  const migrated = oldValues.map((row, i) =>
    [i === 0 ? HEADER_TARGET : plan.checks[i - 1]].concat(row),
  );
  assert.equal(migrated[0][0], '対象');

  const before = collectExplicitRules(oldValues, resolveColumns(oldValues[0]));
  const after = collectExplicitRules(migrated, resolveColumns(migrated[0]));
  assert.deepEqual(after.rules, before.rules);
  assert.deepEqual(before.rules, [
    { labelName: 'Newsletter', retentionDays: 30 },
    { labelName: 'StringDays', retentionDays: 7 },
    { labelName: 'DUP', retentionDays: 3 },
  ]);
});

// ---------------------------------------------------------------------------
// planSheetSync
// ---------------------------------------------------------------------------

const NEW_HEADER = ['対象', 'ラベル名', '保持日数', '適用日数', '状態'];

/** 新形式シートの値（ヘッダ込み）を作る。rows は [対象, ラベル名, 保持日数] の配列。 */
function newSheet(rows) {
  return [NEW_HEADER].concat(rows.map((r) => r.concat(['', ''])));
}

/** values から同期計画を作る（列はヘッダから解決）。 */
function plan(values, gmailLabelNames) {
  return planSheetSync(values, resolveColumns(values[0]), gmailLabelNames);
}

/**
 * 計画をシートの値に反映した結果を返す（syncLabelSheet の書き込みと同じ形）。
 * 欠けた自動列ヘッダを右端に追加 → 追記行（対象 false・保持日数 ''）→ 自動列を上書き。
 */
function applyPlan(values, syncPlan) {
  const out = values.map((r) => r.slice());
  out[0] = out[0].concat(syncPlan.missingHeaders);
  const width = out[0].length;
  for (let i = 1; i < out.length; i++) {
    while (out[i].length < width) out[i].push('');
  }
  let cols = resolveColumns(out[0]);
  syncPlan.appendNames.forEach((name) => {
    const row = new Array(width).fill('');
    row[cols.target] = false;
    row[cols.label] = name;
    out.push(row);
  });
  cols = resolveColumns(out[0]);
  for (let i = 1; i < out.length; i++) {
    out[i][cols.appliedDays] = syncPlan.appliedDays[i - 1];
    out[i][cols.status] = syncPlan.statuses[i - 1];
  }
  return out;
}

test('planSheetSync: 未登録ラベルを Gmail の順・表記で追記し、大文字小文字違いは追記しない（1.1, 1.2）', () => {
  const values = newSheet([
    [false, 'Work', ''],
    [false, 'news', ''],
  ]);
  const p = plan(values, ['Zeta', 'WORK', 'News', 'Alpha', 'alpha']);
  assert.deepEqual(p.appendNames, ['Zeta', 'Alpha']);
  // 既存 2 行 + 追記 2 行
  assert.equal(p.appliedDays.length, 4);
  assert.equal(p.statuses.length, 4);
  assert.deepEqual(p.statuses, ['', '', '', '']);
  assert.equal(p.missingCount, 0);
});

test('planSheetSync: Gmail に無い行は STATUS_MISSING・適用日数は空、戻れば状態は空（1.5, 1.6, 2.7）', () => {
  const values = newSheet([
    [true, 'Gone', 30],
    [false, 'Keep', ''],
  ]);
  const p1 = plan(values, ['Keep']);
  assert.deepEqual(p1.statuses, [STATUS_MISSING, '']);
  assert.deepEqual(p1.appliedDays, ['', '']);
  assert.equal(p1.missingCount, 1);

  // 前回の計画を反映したシートで、ラベルが Gmail に戻った場合。
  const synced = applyPlan(values, p1);
  const p2 = plan(synced, ['Keep', 'gone']);
  assert.deepEqual(p2.statuses, ['', '']);
  assert.deepEqual(p2.appliedDays, [30, '']);
  assert.deepEqual(p2.appendNames, []);
  assert.equal(p2.missingCount, 0);
});

test('planSheetSync: 改名で旧名の行は STATUS_MISSING、新名は追記される（1.8）', () => {
  const values = newSheet([[true, 'OldName', 7]]);
  const p = plan(values, ['NewName']);
  assert.deepEqual(p.appendNames, ['NewName']);
  assert.deepEqual(p.statuses, [STATUS_MISSING, '']);
  assert.deepEqual(p.appliedDays, ['', '']);
  assert.equal(p.missingCount, 1);
});

test('planSheetSync: 親の明示ルールを未チェックの子・追記される子が継承し、子の明示が優先（2.5, 3.3, 3.4）', () => {
  const values = newSheet([
    [true, 'Parent', 30],
    [false, 'Parent/Child', 99], // 未チェックの日数は無視 → 継承 30
    [true, 'Parent/Own', 5], //     子の明示が優先
    [false, 'Parent/Own/Leaf', ''], // 最も近い明示祖先 Own の 5
  ]);
  const gmail = ['Parent', 'Parent/Child', 'Parent/Own', 'Parent/Own/Leaf', 'Parent/New', 'parent/own/new2'];
  const p = plan(values, gmail);
  assert.deepEqual(p.appendNames, ['Parent/New', 'parent/own/new2']);
  assert.deepEqual(p.appliedDays, [30, 30, 5, 5, 30, 5]);
  assert.deepEqual(p.statuses, ['', '', '', '', '', '']);
});

test('planSheetSync: 明示設定も継承も無い行・追記行の適用日数は空（2.6）', () => {
  const values = newSheet([
    [false, 'Plain', 10],
    [true, 'Other', 3],
  ]);
  const p = plan(values, ['Plain', 'Other', 'Fresh', 'Plainer/Child']);
  assert.deepEqual(p.appliedDays, ['', 3, '', '']);
});

test('planSheetSync: 重複行は STATUS_DUPLICATE で採用行と同じ日数を表示（3.7）', () => {
  const values = newSheet([
    [false, 'Dup', ''], //   上が未チェック → duplicate
    [true, 'DUP', 12], //    explicit
    [true, 'dup', 40], //    両方有効の下 → duplicate
  ]);
  const p = plan(values, ['Dup']);
  assert.deepEqual(p.statuses, [STATUS_DUPLICATE, '', STATUS_DUPLICATE]);
  assert.deepEqual(p.appliedDays, [12, 12, 12]);
  assert.deepEqual(p.appendNames, []);
});

test('planSheetSync: 重複かつ Gmail に無い行は STATUS_DUPLICATE を優先', () => {
  const values = newSheet([
    [true, 'X', 1],
    [true, 'x', 2],
  ]);
  const p = plan(values, []);
  assert.deepEqual(p.statuses, [STATUS_MISSING, STATUS_DUPLICATE]);
  assert.equal(p.missingCount, 1);
});

test('planSheetSync: チェックありで日数無効の行は STATUS_INVALID_DAYS、Gmail に無ければ STATUS_MISSING', () => {
  const values = newSheet([
    [true, 'Bad', 'abc'],
    [true, 'BadGone', 0],
  ]);
  const p = plan(values, ['Bad']);
  assert.deepEqual(p.statuses, [STATUS_INVALID_DAYS, STATUS_MISSING]);
  assert.deepEqual(p.appliedDays, ['', '']);
});

test('planSheetSync: ラベル名が空の行は適用日数・状態とも空で、照合キーにも使わない', () => {
  const values = newSheet([
    [true, '', 5],
    [false, '  ', ''],
  ]);
  const p = plan(values, ['A']);
  assert.deepEqual(p.statuses, ['', '', '']);
  assert.deepEqual(p.appliedDays, ['', '', '']);
  assert.deepEqual(p.appendNames, ['A']);
  assert.equal(p.missingCount, 0);
});

test('planSheetSync: 欠けている自動列ヘッダを 適用日数・状態 の順で返す', () => {
  const v1 = [['対象', 'ラベル名', '保持日数'], [false, 'A', '']];
  assert.deepEqual(plan(v1, ['A']).missingHeaders, [HEADER_APPLIED_DAYS, HEADER_STATUS]);
  const v2 = [['状態', '対象', 'ラベル名', '保持日数'], ['', false, 'A', '']];
  assert.deepEqual(plan(v2, ['A']).missingHeaders, [HEADER_APPLIED_DAYS]);
  const v3 = [['対象', 'ラベル名', '保持日数', '適用日数'], [false, 'A', '', '']];
  assert.deepEqual(plan(v3, ['A']).missingHeaders, [HEADER_STATUS]);
  assert.deepEqual(plan(newSheet([[false, 'A', '']]), ['A']).missingHeaders, []);
});

test('planSheetSync: 入力の values・gmailLabelNames を変更しない', () => {
  const values = newSheet([[true, 'A', 3], [false, 'Gone', '']]);
  const copy = values.map((r) => r.slice());
  const gmail = ['A', 'A/B'];
  plan(values, gmail);
  assert.deepEqual(values, copy);
  assert.deepEqual(gmail, ['A', 'A/B']);
});

test('planSheetSync: 計画を反映したシートを再入力すると追記・ヘッダ追加が無く自動列が一致（5.4, 2.8）', () => {
  const values = [
    ['対象', 'ラベル名', '保持日数'], // 自動列なし
    [true, 'Parent', 30],
    [false, 'Parent/Child', ''],
    [true, 'Bad', 'x'],
    [false, 'Gone', ''],
    [true, 'parent', 9],
    [false, '', ''],
  ];
  const gmail = ['Parent', 'Parent/Child', 'Bad', 'Parent/New', 'Solo', 'SOLO'];
  const first = plan(values, gmail);
  const synced = applyPlan(values, first);

  const second = plan(synced, gmail);
  assert.deepEqual(second.appendNames, []);
  assert.deepEqual(second.missingHeaders, []);
  const cols = resolveColumns(synced[0]);
  const rows = synced.slice(1);
  assert.deepEqual(second.appliedDays, rows.map((r) => r[cols.appliedDays]));
  assert.deepEqual(second.statuses, rows.map((r) => r[cols.status]));
  assert.equal(second.missingCount, first.missingCount);

  // 3 回目も同じ結果（同じ入力に同じ出力）。
  assert.deepEqual(applyPlan(synced, second), synced);
});

test('planSheetSync: 表示する適用日数が collectExplicitRules → expandRules の日数と全 Gmail ラベルで一致（3.7）', () => {
  const values = newSheet([
    [false, 'Team', ''],
    [true, 'team', 20],
    [true, 'Team/Sub', 'bad'],
    [true, 'TEAM/sub', 4],
    [false, 'Team/Sub/Deep', 77],
    [true, 'Other', 2],
    [true, 'Other', 8],
    [false, 'Gone', ''],
    [true, 'Lonely', 6],
  ]);
  const gmail = ['Team', 'Team/Sub', 'Team/Sub/Deep', 'Team/Extra', 'Other', 'Other/Kid', 'Lonely', 'Unset'];
  const columns = resolveColumns(values[0]);
  const p = planSheetSync(values, columns, gmail);
  const synced = applyPlan(values, p);
  const syncedCols = resolveColumns(synced[0]);

  const expected = {};
  expandRules(collectExplicitRules(values, columns).rules, gmail).forEach((r) => {
    expected[labelKey(r.labelName)] = r.retentionDays;
  });

  gmail.forEach((name) => {
    const key = labelKey(name);
    const want = Object.prototype.hasOwnProperty.call(expected, key) ? expected[key] : '';
    const shownRows = synced
      .slice(1)
      .filter((r) => labelKey(String(r[syncedCols.label]).trim()) === key);
    assert.ok(shownRows.length > 0, name + ' の行がある');
    shownRows.forEach((r) => {
      assert.equal(r[syncedCols.appliedDays], want, name + ' の適用日数');
    });
  });
});
