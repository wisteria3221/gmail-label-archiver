/**
 * Archiver.js — ArchiveService: ルール単位の対象抽出・権威的判定・バッチアーカイブ。
 *
 * Google Apps Script ランタイムでは全 `src/*.js` が 1 つのグローバルスコープに
 * 連結されるため、ここで宣言する top-level 関数はそのままグローバル公開される。
 *
 * 本ファイルの `buildQuery` / `isOlderThan` / `hasStar` は純粋関数（`hasStar` は
 * 渡されたスレッドのメソッドのみ呼ぶ薄いラッパ）で、GmailApp などのグローバル
 * サービスには一切依存しない（テスト容易性のため分離）。
 *
 * `archiveRule`（GmailApp 依存の抽出・アーカイブ本体）は後続タスク（3.2）で
 * 同ファイルに追加される。
 */

/**
 * @typedef {Object} ArchiveRule
 * @property {string} labelName    対象ラベル名（非空）
 * @property {number} retentionDays 受信トレイ保持日数（正の整数）
 */

/** 1 日のミリ秒数（経過日数換算用）。 */
const MS_PER_DAY = 86400000;

/**
 * ルールから Gmail 検索クエリ文字列を生成する純粋関数（副作用なし）。
 * ラベル名は常に二重引用符で囲む（空白・階層ラベル対応）。
 *
 * @param {ArchiveRule} rule
 * @returns {string} `label:"<labelName>" in:inbox -is:starred older_than:<retentionDays>d`
 */
function buildQuery(rule) {
  return (
    'label:"' +
    rule.labelName +
    '" in:inbox -is:starred older_than:' +
    rule.retentionDays +
    'd'
  );
}

/**
 * 最新メッセージ日時が保持日数のしきい値より古いかを判定する純粋関数（副作用なし）。
 *
 * 経過日数 = (now - lastMessageDate) のミリ秒差 / 86400000。
 * 経過日数が保持日数を「厳密に超える」場合のみ true。ちょうど保持日数以下なら
 * false（除外、2.5）。基準は常にスレッド内最新メッセージの日時（2.2）。
 *
 * @param {Date} lastMessageDate スレッド内最新メッセージの日時（2.2）
 * @param {number} retentionDays 保持日数（正の整数）
 * @param {Date} now 経過日数判定の基準時刻
 * @returns {boolean} 経過日数が保持日数を超えていれば true（アーカイブ対象）
 */
function isOlderThan(lastMessageDate, retentionDays, now) {
  const elapsedDays = (now.getTime() - lastMessageDate.getTime()) / MS_PER_DAY;
  return elapsedDays > retentionDays;
}

/**
 * スレッドにスター付きメッセージが存在するかを判定する（`hasStarredMessages` ラッパ）。
 * 渡された引数のメソッドのみを呼ぶ薄いラッパ（純粋・グローバル非依存）。
 *
 * @param {GmailThread} thread GmailThread 相当のオブジェクト
 * @returns {boolean} スター付きが 1 件でもあれば true（対象から除外、2.6）
 */
function hasStar(thread) {
  return thread.hasStarredMessages();
}

/**
 * @typedef {Object} ArchiveResult
 * @property {string} labelName      対象ラベル名
 * @property {number} archivedCount  実際に受信トレイから外した件数
 * @property {number} candidateCount 検索でヒットした候補件数
 */

/**
 * 1 ルール分の対象を抽出し、残予算の範囲内で標準アーカイブする。
 *
 * 1. 残予算 `remaining ≤ 0` なら検索せず空動作（予算枯渇、5.1）。
 * 2. `buildQuery(rule)` でクエリを生成し、`ARCHIVE_SEARCH_LIMIT` 件ずつ
 *    `GmailApp.search` でページングして候補を取得する。検索の `older_than` /
 *    `-is:starred` はメッセージ単位で効くため、「最近の返信がある」「一部だけ
 *    スター付き」のスレッドもヒットし、新しい順の先頭を占めうる。先頭ページだけ
 *    では後続の本来の対象へ届かないため、次ページへ進む。
 *    確定対象が `remaining` 件に達した時点、検索結果が尽きた時点、または走査件数が
 *    `ARCHIVE_SCAN_LIMIT_PER_RULE` に達した時点で打ち切る。
 * 3. 候補をコード側で権威的に再判定（2.2/2.5/2.6/6.8）：
 *    最新メッセージ日時が保持日数を超え（`isOlderThan`）かつ非スター（`!hasStar`）
 *    かつ `seenThreadIds` に未出のスレッドのみ確定対象とする（検索の近似フィルタを
 *    補正し、親子両ラベル付きスレッドやページ間の重複を防ぐ）。
 *    確定した各スレッドの ID を `seenThreadIds` に追記する（6.8）。
 * 4. 確定対象は残予算 `remaining` 件まで（`archivedCount ≤ remaining`、5.1）。
 * 5. 全ページの走査後に `ARCHIVE_BATCH_SIZE`（100）単位で `GmailApp.moveThreadsToArchive`
 *    を呼ぶ（走査途中でアーカイブすると `in:inbox` から外れて offset がずれるため）。
 *    標準アーカイブのみ（削除・既読変更・他ラベル変更は行わない、3.1–3.3）。
 * 6. 確定対象 0 件（ラベル不在で検索 0 件含む）なら `moveThreadsToArchive` を
 *    呼ばずに `archivedCount` 0 で返す（2.4/3.4）。
 * 7. ラベル名・件数を標準ログへ出力する（5.4）。
 *
 * @param {ArchiveRule} rule 検証済みルール（`labelName` 非空、`retentionDays > 0`）
 * @param {Date} now 経過日数判定の基準時刻（テスト容易性のため注入）
 * @param {number} remaining この呼び出しで処理してよい残件数（実行全体の残予算、`≥ 0`）
 * @param {Set<string>} [seenThreadIds] 実行全体で共有する処理済みスレッド ID 集合（6.8）。
 *   省略時はローカルな空 `Set` で代替するため、従来どおりの 3 引数挙動になる。
 *   既出 ID のスレッドは確定対象から除外し、アーカイブしたスレッド ID を追記する。
 * @returns {ArchiveResult} `candidateCount` は走査した（検索で取得した）候補の総数
 * @throws {Error} 検索・アーカイブ API が回復不能な失敗をした場合（呼び出し側でルール単位に捕捉）
 */
function archiveRule(rule, now, remaining, seenThreadIds) {
  // 省略時はローカル Set で代替（3 引数呼び出しは従来挙動を維持、6.8）。
  seenThreadIds = seenThreadIds || new Set();
  // 1. 予算枯渇：検索せず空動作（5.1）。
  if (remaining <= 0) {
    logSummary(rule.labelName, 0, 0);
    return { labelName: rule.labelName, archivedCount: 0, candidateCount: 0 };
  }

  // 2–4. ページングしながら権威的再判定（最新日時超過 かつ 非スター かつ
  //      seenThreadIds 未出、2.2/2.5/2.6/6.8）。getId が無いモック（3 引数の既存
  //      テスト）でも壊れないよう存在ガードする。
  const query = buildQuery(rule);
  const targets = [];
  let candidateCount = 0;
  while (
    targets.length < remaining &&
    candidateCount < ARCHIVE_SCAN_LIMIT_PER_RULE
  ) {
    const pageSize = Math.min(
      ARCHIVE_SEARCH_LIMIT,
      ARCHIVE_SCAN_LIMIT_PER_RULE - candidateCount
    );
    const page = GmailApp.search(query, candidateCount, pageSize);
    candidateCount += page.length;

    for (let i = 0; i < page.length && targets.length < remaining; i++) {
      const thread = page[i];
      const id = thread.getId ? thread.getId() : undefined;
      if (
        isOlderThan(thread.getLastMessageDate(), rule.retentionDays, now) &&
        !hasStar(thread) &&
        !(id !== undefined && seenThreadIds.has(id))
      ) {
        targets.push(thread);
        if (id !== undefined) {
          seenThreadIds.add(id);
        }
      }
    }

    // 検索結果が尽きた（最終ページ）なら打ち切り。
    if (page.length < pageSize) {
      break;
    }
  }

  // 5–6. 全ページ走査後に 100 件単位で標準アーカイブ。対象 0 件なら呼ばない（2.4/3.4）。
  for (let i = 0; i < targets.length; i += ARCHIVE_BATCH_SIZE) {
    GmailApp.moveThreadsToArchive(targets.slice(i, i + ARCHIVE_BATCH_SIZE));
  }

  const archivedCount = targets.length;

  // 7. 1 行サマリを標準ログへ出力（5.4）。
  logSummary(rule.labelName, archivedCount, candidateCount);

  return { labelName: rule.labelName, archivedCount, candidateCount };
}

/**
 * ルール処理結果の 1 行サマリを標準ログへ出力する（5.4）。出力先は
 * `console.log` に統一する。GAS の V8 ランタイムでは `console.log` も
 * `Logger.log` も同じ Cloud Logging（実行ログ）へ書き込まれるため、両方を
 * 呼ぶと同一行が二重出力される。これを避けるため `Logger.log` には出力しない。
 *
 * @param {string} labelName
 * @param {number} archivedCount
 * @param {number} candidateCount
 */
function logSummary(labelName, archivedCount, candidateCount) {
  const line =
    '✅ [アーカイブ完了] ラベル「' +
    labelName +
    '」: アーカイブ ' +
    archivedCount +
    '件 / 候補 ' +
    candidateCount +
    '件';
  if (typeof console !== 'undefined' && console.log) {
    console.log(line);
  }
}

/**
 * Gmail の全ユーザー作成ラベル名を返す薄いラッパ（`GmailApp.getUserLabels`、6.1）。
 * `getUserLabels` はユーザー作成ラベルのみを返す（システムラベルは含まれない）ため
 * 追加のフィルタは不要。ラベルオブジェクト配列をラベル名文字列配列へ変換するだけの
 * 薄いラッパ（余計なロジックを持たない）。
 *
 * @returns {string[]} ユーザー作成ラベル名の配列（システムラベルは含まない）
 */
function listUserLabelNames() {
  return GmailApp.getUserLabels().map((l) => l.getName());
}

// Node-only export guard: GAS では `module` が未定義のため評価されない。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildQuery,
    isOlderThan,
    hasStar,
    archiveRule,
    listUserLabelNames,
  };
}
