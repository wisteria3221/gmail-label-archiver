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

// ---------------------------------------------------------------------------
// syncLabelSheet（書き込みを記録するシートのフェイクで検証）
// ---------------------------------------------------------------------------

const { syncLabelSheet } = require('../src/SheetSync.js');

/**
 * メモリ上の 2 次元配列で Sheet / Range の一部 API を再現するフェイク。
 * - getDataRange().getValues(): 1 行目〜最終行・1 列目〜最終列の矩形（空セルは ''）。
 * - getRange(row, col, numRows, numCols)（1 始まり）: setValues は寸法を検査してセルに書き、
 *   呼び出しを writes に記録する。Sheets と同じく、先頭が ' の文字列は ' を取り除いて
 *   そのまま文字列として保存し、' の無い数字だけの文字列は数値に自動変換し、
 *   ' の無い = 始まりの文字列は数式（FORMULA_SENTINEL）として保存する。
 *   setDataValidation は規則と範囲を validations に記録し、値は変えない。
 *   insertCheckboxes は公式リファレンスどおり範囲の全セルを false にする（使われないことの検証用）。
 * - insertColumnBefore(col): col 列目に空列を挿入し、右のセルをずらす。
 */
class FakeSheet {
  constructor(cells) {
    this.cells = cells.map((r) => r.slice());
    this.writes = [];
    this.checkboxes = [];
    this.validations = [];
    this.insertedColumns = [];
  }

  getLastRow() {
    for (let r = this.cells.length - 1; r >= 0; r--) {
      if (this.cells[r].some((v) => v !== '' && v !== undefined)) return r + 1;
    }
    return 0;
  }

  getLastColumn() {
    let last = 0;
    this.cells.forEach((row) => {
      for (let c = row.length - 1; c >= 0; c--) {
        if (row[c] !== '' && row[c] !== undefined) {
          last = Math.max(last, c + 1);
          break;
        }
      }
    });
    return last;
  }

  /** 現在のセル内容を矩形の値として返す（テストの比較用）。 */
  snapshot() {
    const rows = Math.max(this.getLastRow(), 1);
    const cols = Math.max(this.getLastColumn(), 1);
    const out = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const v = (this.cells[r] || [])[c];
        row.push(v === undefined ? '' : v);
      }
      out.push(row);
    }
    return out;
  }

  getDataRange() {
    return { getValues: () => this.snapshot() };
  }

  setCell_(r, c, v) {
    while (this.cells.length <= r) this.cells.push([]);
    const row = this.cells[r];
    while (row.length <= c) row.push('');
    row[c] = v;
  }

  getRange(row, col, numRows, numCols) {
    assert.ok(row >= 1 && col >= 1 && numRows >= 1 && numCols >= 1, 'getRange の引数が不正');
    return {
      setValues: (values) => {
        assert.equal(values.length, numRows, 'setValues の行数が範囲と一致');
        values.forEach((v) => assert.equal(v.length, numCols, 'setValues の列数が範囲と一致'));
        this.writes.push({ row, col, numRows, numCols, values: values.map((v) => v.slice()) });
        values.forEach((v, i) =>
          v.forEach((cell, j) => {
            let stored = cell;
            if (typeof cell === 'string' && cell.charAt(0) === "'") {
              stored = cell.slice(1); // 文字列として保存する印
            } else if (typeof cell === 'string' && /^-?\d+(\.\d+)?$/.test(cell)) {
              stored = Number(cell); // Sheets の自動変換
            } else if (typeof cell === 'string' && cell.charAt(0) === '=') {
              stored = FORMULA_SENTINEL; // 数式として解釈される
            }
            this.setCell_(row - 1 + i, col - 1 + j, stored);
          }),
        );
      },
      setDataValidation: (rule) => {
        this.validations.push({ row, col, numRows, numCols, rule });
      },
      insertCheckboxes: () => {
        this.checkboxes.push({ row, col, numRows, numCols });
        for (let i = 0; i < numRows; i++) {
          for (let j = 0; j < numCols; j++) {
            this.setCell_(row - 1 + i, col - 1 + j, false);
          }
        }
      },
    };
  }

  insertColumnBefore(col) {
    this.insertedColumns.push(col);
    this.cells.forEach((row) => {
      while (row.length < col - 1) row.push('');
      row.splice(col - 1, 0, '');
    });
  }
}

/** フェイクで数式として保存されたセルの値。 */
const FORMULA_SENTINEL = '#FORMULA';

/** フェイクの DataValidationBuilder が作るチェックボックス規則。 */
const CHECKBOX_RULE = { criteria: 'CHECKBOX' };

/**
 * syncLabelSheet 用に GAS のグローバル（PropertiesService / SpreadsheetApp /
 * LockService / listUserLabelNames）を差し替える。
 * @returns {{sheet: FakeSheet, lock: {waits: number[], released: number}}}
 */
function setupSync({ cells, labels, lockThrows = false, labelsThrow = false }) {
  const sheet = new FakeSheet(cells);
  const lock = { waits: [], released: 0 };
  globalThis.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k === PROP_SPREADSHEET_ID ? 'id1' : null),
    }),
  };
  globalThis.SpreadsheetApp = {
    openById: () => ({ getSheetByName: () => sheet }),
    newDataValidation: () => {
      let rule = null;
      const builder = {
        requireCheckbox: () => {
          rule = CHECKBOX_RULE;
          return builder;
        },
        build: () => rule,
      };
      return builder;
    },
  };
  globalThis.LockService = {
    getScriptLock: () => ({
      waitLock: (ms) => {
        lock.waits.push(ms);
        if (lockThrows) throw new Error('ロックのタイムアウト');
      },
      releaseLock: () => {
        lock.released++;
      },
    }),
  };
  globalThis.listUserLabelNames = () => {
    if (labelsThrow) throw new Error('Gmail 取得失敗');
    return labels.slice();
  };
  return { sheet, lock };
}

/**
 * 既存データ行（2〜lastExistingRow 行目）の利用者列・ラベル名列（1 始まりの列番号）に
 * 触れる書き込みが無いことを検査する（1.3, 1.4, 2.3）。
 */
function assertNoUserCellWrites(writes, lastExistingRow, protectedCols) {
  writes.forEach((w) => {
    const rowHit = w.row <= lastExistingRow && w.row + w.numRows - 1 >= 2;
    protectedCols.forEach((c) => {
      const colHit = w.col <= c && w.col + w.numCols - 1 >= c;
      assert.ok(!(rowHit && colHit), '既存行の保護列 ' + c + ' に書き込んだ: ' + JSON.stringify(w));
    });
  });
}

const OLD_SHEET = [
  ['ラベル名', '保持日数'],
  ['Newsletter', 30], // 有効 → 対象 true
  ['Bad', 'abc'], //     無効 → 対象 false、値はそのまま
  ['Gone', 5], //        有効だが Gmail に無い → STATUS_MISSING
];
const OLD_LABELS = ['Newsletter', 'Bad', 'Fresh', 'Newsletter/Sub'];

test('syncLabelSheet: 旧形式は対象列を挿入して移行し、残りのラベルを追記する（4.1, 4.2, 4.5）', () => {
  const { sheet } = setupSync({ cells: OLD_SHEET, labels: OLD_LABELS });
  const result = syncLabelSheet();

  assert.deepEqual(sheet.insertedColumns, [1]);
  assert.deepEqual(sheet.snapshot(), [
    ['対象', 'ラベル名', '保持日数', '適用日数', '状態'],
    [true, 'Newsletter', 30, 30, ''],
    [false, 'Bad', 'abc', '', ''],
    [true, 'Gone', 5, '', STATUS_MISSING],
    [false, 'Fresh', '', '', ''],
    [false, 'Newsletter/Sub', '', 30, ''],
  ]);
  assert.deepEqual(result, {
    migrated: true,
    migratedCheckedCount: 2,
    appendedCount: 2,
    missingCount: 1,
  });
});

test('syncLabelSheet: 移行の対象列はヘッダとチェック値を 1 回の setValues で書く', () => {
  const { sheet } = setupSync({ cells: OLD_SHEET, labels: OLD_LABELS });
  syncLabelSheet();
  assert.deepEqual(sheet.writes[0], {
    row: 1,
    col: 1,
    numRows: 4,
    numCols: 1,
    values: [['対象'], [true], [false], [true]],
  });
  // 移行の書き込み以降は既存行の 対象・ラベル名・保持日数 に触れない（4.2）。
  assertNoUserCellWrites(sheet.writes.slice(1), 4, [1, 2, 3]);
});

test('syncLabelSheet: 新形式は列を挿入せず、既存行の利用者列に書き込まない（4.8, 1.3, 1.4, 2.3）', () => {
  const cells = [
    ['メモ', '状態', 'ラベル名', '対象', '保持日数', '適用日数'],
    ['m1', 'old', 'Work', true, 7, 99],
    ['', '', 'Work/Sub', false, 3, ''],
    ['m3', '', 'Dead', true, 'x', ''],
  ];
  const { sheet } = setupSync({ cells, labels: ['Work', 'Work/Sub', 'New'] });
  const result = syncLabelSheet();

  assert.deepEqual(sheet.insertedColumns, []);
  assert.deepEqual(result, {
    migrated: false,
    migratedCheckedCount: 0,
    appendedCount: 1,
    missingCount: 1,
  });
  // 保護する列: メモ(1)・ラベル名(3)・対象(4)・保持日数(5)
  assertNoUserCellWrites(sheet.writes, 4, [1, 3, 4, 5]);
  assert.deepEqual(sheet.snapshot(), [
    ['メモ', '状態', 'ラベル名', '対象', '保持日数', '適用日数'],
    ['m1', '', 'Work', true, 7, 7],
    ['', '', 'Work/Sub', false, 3, 7],
    ['m3', STATUS_MISSING, 'Dead', true, 'x', ''],
    ['', '', 'New', false, '', ''],
  ]);
});

test('syncLabelSheet: 2 回目は何も追記せず、シートの内容が変わらない（5.4）', () => {
  const { sheet } = setupSync({ cells: OLD_SHEET, labels: OLD_LABELS.concat(['=Formula']) });
  syncLabelSheet();
  const afterFirst = sheet.snapshot();
  const second = syncLabelSheet();

  assert.deepEqual(sheet.snapshot(), afterFirst);
  assert.deepEqual(sheet.insertedColumns, [1]);
  assert.deepEqual(second, {
    migrated: false,
    migratedCheckedCount: 0,
    appendedCount: 0,
    missingCount: 1,
  });
});

test('syncLabelSheet: 追記するラベル名にはすべて \' を付けて書く', () => {
  const cells = [NEW_HEADER];
  const { sheet } = setupSync({ cells, labels: ['=SUM(A1)', '+x', '-y', '@z', 'plain'] });
  syncLabelSheet();
  const appended = sheet.writes.find((w) => w.row === 2 && w.numRows === 5);
  assert.ok(appended, '追記の書き込みがある');
  assert.deepEqual(
    appended.values.map((r) => r[1]),
    ["'=SUM(A1)", "'+x", "'-y", "'@z", "'plain"],
  );
  appended.values.forEach((r) => {
    assert.equal(r[0], false, '追記行の対象は false');
    assert.equal(r[2], '', '追記行の保持日数は空');
  });
});

test('syncLabelSheet: 対象列のデータ行にチェックボックスを適用する（2.2）', () => {
  const cells = [
    ['ラベル名', '対象', '保持日数', '適用日数', '状態'],
    ['A', true, 1, 1, ''],
  ];
  const { sheet } = setupSync({ cells, labels: ['A', 'B', 'C'] });
  syncLabelSheet();
  assert.deepEqual(sheet.validations, [
    { row: 2, col: 2, numRows: 3, numCols: 1, rule: CHECKBOX_RULE },
  ]);
  assert.deepEqual(sheet.checkboxes, [], 'insertCheckboxes は値を false にするため使わない');
});

test('syncLabelSheet: 新形式の既存の対象 true は同期後も true のまま（1.3）', () => {
  const cells = [
    ['対象', 'ラベル名', '保持日数', '適用日数', '状態'],
    [true, 'A', 1, '', ''],
    [false, 'B', '', '', ''],
    [true, 'C', 'bad', '', ''],
  ];
  const { sheet } = setupSync({ cells, labels: ['A', 'B', 'C', 'D'] });
  syncLabelSheet();
  assert.deepEqual(
    sheet.snapshot().slice(1).map((r) => r[0]),
    [true, false, true, false],
  );
});

test('syncLabelSheet: 移行で true にした対象は同じ実行の最後まで true のまま（4.3）', () => {
  const { sheet } = setupSync({ cells: OLD_SHEET, labels: OLD_LABELS });
  syncLabelSheet();
  assert.deepEqual(
    sheet.snapshot().slice(1).map((r) => r[0]),
    [true, false, true, false, false],
  );
  assert.deepEqual(sheet.validations, [
    { row: 2, col: 1, numRows: 5, numCols: 1, rule: CHECKBOX_RULE },
  ]);
  assert.deepEqual(sheet.checkboxes, []);
});

test('syncLabelSheet: データ行が 0 件ならチェックボックスを適用しない', () => {
  const { sheet } = setupSync({ cells: [NEW_HEADER], labels: [] });
  const result = syncLabelSheet();
  assert.deepEqual(sheet.validations, []);
  assert.deepEqual(sheet.checkboxes, []);
  assert.deepEqual(sheet.writes, []);
  assert.equal(result.appendedCount, 0);
});

test('syncLabelSheet: 欠けた自動列ヘッダを右端に追加する（2.1）', () => {
  const cells = [
    ['対象', 'ラベル名', '保持日数', 'メモ'],
    [true, 'A', 10, 'note'],
  ];
  const { sheet } = setupSync({ cells, labels: ['A'] });
  syncLabelSheet();
  assert.deepEqual(sheet.writes[0], {
    row: 1,
    col: 5,
    numRows: 1,
    numCols: 2,
    values: [['適用日数', '状態']],
  });
  assert.deepEqual(sheet.snapshot(), [
    ['対象', 'ラベル名', '保持日数', 'メモ', '適用日数', '状態'],
    [true, 'A', 10, 'note', 10, ''],
  ]);
});

test('syncLabelSheet: ラベル名か保持日数の列が無ければ throw し、書き込まない（6.4）', () => {
  [
    [['対象', '保持日数'], [true, 3]],
    [['対象', 'ラベル名'], [true, 'A']],
  ].forEach((cells) => {
    const { sheet, lock } = setupSync({ cells, labels: ['A'] });
    assert.throws(syncLabelSheet, /ヘッダが不正です/);
    assert.deepEqual(sheet.writes, []);
    assert.deepEqual(sheet.insertedColumns, []);
    assert.equal(lock.released, 1, '取得後の失敗でもロックを解放する');
  });
});

test('syncLabelSheet: ロック取得がタイムアウトしたら throw し、解放もシート操作もしない', () => {
  const { sheet, lock } = setupSync({ cells: OLD_SHEET, labels: OLD_LABELS, lockThrows: true });
  assert.throws(syncLabelSheet, /ロックのタイムアウト/);
  assert.deepEqual(lock.waits, [SYNC_LOCK_TIMEOUT_MS]);
  assert.equal(lock.released, 0);
  assert.deepEqual(sheet.writes, []);
  assert.deepEqual(sheet.insertedColumns, []);
});

test('syncLabelSheet: 成功時はロックを SYNC_LOCK_TIMEOUT_MS で取得し 1 回解放する', () => {
  const { lock } = setupSync({ cells: OLD_SHEET, labels: OLD_LABELS });
  syncLabelSheet();
  assert.deepEqual(lock.waits, [SYNC_LOCK_TIMEOUT_MS]);
  assert.equal(lock.released, 1);
});

test('syncLabelSheet: ラベル一覧の取得失敗は throw し、ロックは解放する', () => {
  const { lock } = setupSync({ cells: [NEW_HEADER], labels: [], labelsThrow: true });
  assert.throws(syncLabelSheet, /Gmail 取得失敗/);
  assert.equal(lock.released, 1);
});

test('syncLabelSheet: 数字・記号始まりのラベル名もそのまま読み戻され、2 回目に重複追記しない（5.4）', () => {
  const tricky = ['2024', '007', '@Action', '=SUM(A1)'];
  const { sheet } = setupSync({ cells: OLD_SHEET, labels: OLD_LABELS.concat(tricky) });
  syncLabelSheet();
  const afterFirst = sheet.snapshot();
  const labelsShown = afterFirst.slice(1).map((r) => r[1]);
  tricky.forEach((name) => {
    assert.ok(labelsShown.includes(name), name + ' が文字列のまま保存される');
  });

  const second = syncLabelSheet();
  assert.equal(second.appendedCount, 0);
  assert.deepEqual(sheet.snapshot(), afterFirst);
});
