'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// GAS は全 src/*.js を 1 つのグローバルスコープで共有するため、Node でも
// 依存する定数・Config の関数をグローバルに載せてから SheetSync.js を読み込む。
Object.assign(globalThis, require('../src/Constants.js'));
Object.assign(globalThis, require('../src/Config.js'));

const { resolveColumns, collectExplicitRules } = require('../src/Config.js');
const { planMigration } = require('../src/SheetSync.js');

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
