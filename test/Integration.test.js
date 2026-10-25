'use strict';

/**
 * Integration.test.js — 旧形式シートからの移行を通した結合テスト（tasks.md 5.1、要件 4.6, 5.4）。
 *
 * 他のテストは `<Source>.test.js` の 1 対 1 対応だが、このファイルは複数モジュール
 * （Constants → Config → Archiver → SheetSync → Main）をまたぐため、その規約から外して
 * 独立したファイルにしている。
 *
 * GAS と同じく実際の src モジュールをすべて globalThis に載せて 1 つのグローバルスコープを
 * 再現し、GAS サービス（SpreadsheetApp / PropertiesService / LockService / GmailApp）だけを
 * フェイクにする。シートのフェイクは Sheets の挙動（先頭 ' の文字列印、数字だけの文字列の
 * 自動変換、列挿入、入力規則は値を変えない）を再現する。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// GAS と同じ順で全 src を 1 つのグローバルスコープに載せる。
Object.assign(globalThis, require('../src/Constants.js'));
Object.assign(globalThis, require('../src/Config.js'));
Object.assign(globalThis, require('../src/Archiver.js'));
Object.assign(globalThis, require('../src/SheetSync.js'));
Object.assign(globalThis, require('../src/Main.js'));

const MS_PER_DAY_TEST = 86400000;

// ---------------------------------------------------------------------------
// GAS サービスのフェイク
// ---------------------------------------------------------------------------

/**
 * メモリ上の 2 次元配列で Sheet / Range の一部 API を再現するフェイク
 * （test/SheetSync.test.js の FakeSheet と同じ Sheets の意味論）。
 */
class FakeSheet {
  constructor(cells) {
    this.cells = cells.map((r) => r.slice());
    this.validations = [];
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
        values.forEach((v, i) =>
          v.forEach((cell, j) => {
            let stored = cell;
            if (typeof cell === 'string' && cell.charAt(0) === "'") {
              stored = cell.slice(1); // 文字列として保存する印
            } else if (typeof cell === 'string' && /^-?\d+(\.\d+)?$/.test(cell)) {
              stored = Number(cell); // Sheets の自動変換
            } else if (typeof cell === 'string' && cell.charAt(0) === '=') {
              stored = '#FORMULA'; // 数式として解釈される
            }
            this.setCell_(row - 1 + i, col - 1 + j, stored);
          }),
        );
      },
      setDataValidation: (rule) => {
        this.validations.push({ row, col, numRows, numCols, rule });
      },
    };
  }

  insertColumnBefore(col) {
    this.cells.forEach((row) => {
      while (row.length < col - 1) row.push('');
      row.splice(col - 1, 0, '');
    });
  }
}

/** SpreadsheetApp / PropertiesService / LockService を、spreadsheetId → sheet の対応で差し替える。 */
function installSheetServices(sheetsById, currentId) {
  globalThis.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k === PROP_SPREADSHEET_ID ? currentId() : null),
    }),
  };
  globalThis.SpreadsheetApp = {
    openById: (id) => ({
      getSheetByName: (name) => (name === DEFAULT_SHEET_NAME ? sheetsById[id] || null : null),
    }),
    newDataValidation: () => {
      let rule = null;
      const builder = {
        requireCheckbox: () => {
          rule = { criteria: 'CHECKBOX' };
          return builder;
        },
        build: () => rule,
      };
      return builder;
    },
  };
  globalThis.LockService = {
    getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
  };
}

/**
 * GmailApp のフェイク。ラベル一覧・検索・アーカイブを再現する。
 * search は `label:"X" in:inbox -is:starred older_than:Nd` を解釈し、ラベル（大文字小文字を
 * 区別しない完全一致）・受信トレイ・非スター・最新メッセージが N 日より古い、を満たす
 * スレッドを start/max でページングして返す。moveThreadsToArchive は受信トレイから外す。
 */
function installGmail(labelNames, threadSpecs, now) {
  const threads = threadSpecs.map((t) => ({
    id: t.id,
    labels: t.labels.map((l) => l.toLowerCase()),
    inbox: true,
    starred: !!t.starred,
    last: new Date(now - t.ageDays * MS_PER_DAY_TEST),
  }));
  const gmail = { queries: [], archivedIds: [] };
  globalThis.GmailApp = {
    getUserLabels: () => labelNames.map((n) => ({ getName: () => n })),
    search: (query, start, max) => {
      gmail.queries.push(query);
      const m = /^label:"([^"]*)" in:inbox -is:starred older_than:(\d+)d$/.exec(query);
      assert.ok(m, '想定外のクエリ: ' + query);
      const label = m[1].toLowerCase();
      const days = Number(m[2]);
      const hits = threads.filter(
        (t) =>
          t.labels.includes(label) &&
          t.inbox &&
          !t.starred &&
          Date.now() - t.last.getTime() > days * MS_PER_DAY_TEST,
      );
      return hits.slice(start, start + max).map((t) => ({
        getId: () => t.id,
        getLastMessageDate: () => t.last,
        hasStarredMessages: () => t.starred,
        _t: t,
      }));
    },
    moveThreadsToArchive: (batch) => {
      batch.forEach((th) => {
        th._t.inbox = false;
        gmail.archivedIds.push(th._t.id);
      });
    },
  };
  return gmail;
}

// ---------------------------------------------------------------------------
// シナリオ
// ---------------------------------------------------------------------------

// 旧形式（対象 列なし）の設定シート。
const OLD_SHEET = [
  ['ラベル名', '保持日数'],
  ['Parent', 30], //       子孫を持つ親ラベル
  ['Parent/Own', 7], //    子の明示（親より優先）
  ['Bad', 'abc'], //       保持日数が無効（現行どおり黙ってスキップ）
  ['news', 14], //         採用される行
  ['NEWS', 60], //         大文字小文字違いの重複（上の行が優先）
  ['', 5], //              ラベル名が空
  ['Gone', 10], //         Gmail に存在しないラベル
];

// Gmail のユーザーラベル（取得順）。'007' は数値への自動変換を受けうる名前（5.4 の確認用）。
const GMAIL_LABELS = [
  'Parent',
  'Parent/Child',
  'Parent/Own',
  'Parent/Own/Leaf',
  'News',
  'Bad',
  'Bad/Sub',
  'Other',
  '007',
];

// スレッド（ageDays は最新メッセージの経過日数）。
const THREADS = [
  { id: 'p-old', labels: ['Parent'], ageDays: 40 }, //                 30 日超 → 対象
  { id: 'p-new', labels: ['Parent'], ageDays: 5 },
  { id: 'p-star', labels: ['Parent'], ageDays: 40, starred: true },
  { id: 'pc-old', labels: ['Parent/Child'], ageDays: 40 }, //          親の 30 を継承 → 対象
  { id: 'pc-mid', labels: ['Parent/Child'], ageDays: 20 },
  { id: 'both', labels: ['Parent', 'Parent/Child'], ageDays: 40 }, //   親子両方（1 回だけアーカイブ）
  { id: 'own-10', labels: ['Parent/Own'], ageDays: 10 }, //           明示 7 → 対象（継承 30 なら外れる）
  { id: 'leaf-10', labels: ['Parent/Own/Leaf'], ageDays: 10 }, //     Own の 7 を継承 → 対象
  { id: 'news-20', labels: ['News'], ageDays: 20 }, //                 news の 14 → 対象（NEWS の 60 なら外れる）
  { id: 'bad-100', labels: ['Bad'], ageDays: 100 }, //                 無効行 → 対象外
  { id: 'badsub-100', labels: ['Bad/Sub'], ageDays: 100 },
  { id: 'other-100', labels: ['Other'], ageDays: 100 },
  { id: '007-100', labels: ['007'], ageDays: 100 },
];

/** 1 ルールを比較用の文字列にする。 */
function ruleKey(rule) {
  return rule.labelName + '|' + rule.retentionDays;
}

/**
 * 現行挙動の期待値を独立に求める: 手を付けない旧形式シートのコピーを readArchiveRules で
 * 読み、Gmail のラベル一覧で expandRules する（4.6）。
 */
function expectedRulesFromOldSheet() {
  const sheets = { untouched: new FakeSheet(OLD_SHEET) };
  installSheetServices(sheets, () => 'untouched');
  const config = readArchiveRules();
  assert.deepEqual(config.invalidLabels, [], '旧形式では無効行を警告しない');
  return expandRules(config.rules, GMAIL_LABELS.slice()).map(ruleKey).sort();
}

/** 期待するアーカイブ済みスレッド: いずれかの期待ルールのラベルを持ち、非スターで日数超過。 */
function expectedArchivedIds(ruleKeys) {
  const rules = ruleKeys.map((k) => {
    const i = k.lastIndexOf('|');
    return { label: k.slice(0, i).toLowerCase(), days: Number(k.slice(i + 1)) };
  });
  return THREADS.filter(
    (t) =>
      !t.starred &&
      rules.some((r) => t.labels.some((l) => l.toLowerCase() === r.label) && t.ageDays > r.days),
  )
    .map((t) => t.id)
    .sort();
}

/**
 * archiveLabeledThreads を 1 回実行する。archiveRule は本物を呼びつつ、渡されたルールを記録する。
 * スレッドは毎回同じ初期状態から用意し、実行間でアーカイブ対象を比較できるようにする。
 */
function runDaily() {
  const gmail = installGmail(GMAIL_LABELS, THREADS, Date.now());
  const realArchiveRule = require('../src/Archiver.js').archiveRule;
  const seenRules = [];
  globalThis.archiveRule = (rule, now, remaining, seenThreadIds) => {
    const key = ruleKey(rule);
    if (!seenRules.includes(key)) seenRules.push(key);
    return realArchiveRule(rule, now, remaining, seenThreadIds);
  };
  const logs = [];
  const origLog = console.log;
  console.log = (line) => logs.push(String(line));
  try {
    archiveLabeledThreads();
  } finally {
    console.log = origLog;
    globalThis.archiveRule = realArchiveRule;
  }
  return {
    rules: seenRules.slice().sort(),
    archivedIds: gmail.archivedIds.slice().sort(),
    queriedLabels: gmail.queries.map((q) => /^label:"([^"]*)"/.exec(q)[1]),
    logs,
  };
}

test('結合: 旧形式シートを移行しても、アーカイブ対象は移行前の現行挙動と一致し、2 回目の実行でシートは変わらない（4.6, 5.4）', () => {
  const expectedRules = expectedRulesFromOldSheet();
  // 期待値自体の妥当性（取り違えた場合に気付けるよう具体値も固定する）。
  assert.deepEqual(expectedRules, [
    'Gone|10',
    'Parent/Child|30',
    'Parent/Own/Leaf|7',
    'Parent/Own|7',
    'Parent|30',
    'news|14',
  ]);
  const expectedIds = expectedArchivedIds(expectedRules);
  assert.deepEqual(expectedIds, ['both', 'leaf-10', 'news-20', 'own-10', 'p-old', 'pc-old']);

  // 本番の設定シート（旧形式）。
  const sheet = new FakeSheet(OLD_SHEET);
  installSheetServices({ prod: sheet }, () => 'prod');

  // --- 1 回目: 移行・全ラベル追記・自動列の書き込みが行われる ---
  const run1 = runDaily();
  const afterRun1 = sheet.snapshot();
  assert.deepEqual(afterRun1, [
    ['対象', 'ラベル名', '保持日数', '適用日数', '状態'],
    [true, 'Parent', 30, 30, ''],
    [true, 'Parent/Own', 7, 7, ''],
    [false, 'Bad', 'abc', '', ''],
    [true, 'news', 14, 14, ''],
    [true, 'NEWS', 60, 14, STATUS_DUPLICATE],
    [false, '', 5, '', ''],
    [true, 'Gone', 10, '', STATUS_MISSING],
    [false, 'Parent/Child', '', 30, ''],
    [false, 'Parent/Own/Leaf', '', 7, ''],
    [false, 'Bad/Sub', '', '', ''],
    [false, 'Other', '', '', ''],
    [false, '007', '', '', ''],
  ]);
  assert.ok(
    run1.logs.some((l) => l.includes('[移行完了]') && l.includes('対象にチェック 5件')),
    '1 回目は移行完了をログに出す',
  );
  assert.ok(run1.logs.some((l) => l.includes('[同期完了]') && l.includes('追加 5件')));

  // アーカイブ処理に渡ったルールが、移行前の現行挙動（旧形式の読取＋展開）と一致する（4.6）。
  assert.deepEqual(run1.rules, expectedRules);
  assert.deepEqual(run1.queriedLabels.slice().sort(), expectedRules.map((k) => k.split('|')[0]).sort());
  assert.deepEqual(run1.archivedIds, expectedIds);

  // --- 2 回目: 移行は行われず、シートの内容は 1 回目の後と同じ（5.4） ---
  const run2 = runDaily();
  assert.deepEqual(sheet.snapshot(), afterRun1, '2 回目の実行でシートの内容が変わらない');
  assert.ok(!run2.logs.some((l) => l.includes('[移行完了]')), '2 回目は移行しない');
  assert.ok(run2.logs.some((l) => l.includes('[同期完了]') && l.includes('追加 0件')));

  // 2 回目もアーカイブ対象のルール・スレッドは同じ。
  assert.deepEqual(run2.rules, expectedRules);
  assert.deepEqual(run2.archivedIds, expectedIds);
});
