/**
 * Constants.js — 共有定数の単一定義（最下位レイヤ、依存なし）。
 *
 * Google Apps Script ランタイムでは全 `src/*.js` が 1 つのグローバルスコープに
 * 連結される。各定数を top-level `const` として宣言することで、
 * ConfigService / ArchiveService / Main から直接参照できる。
 *
 * 末尾の Node 用 export ガードは、GAS を壊さずに Node のテストランナーから
 * `require()` できるようにするためのもの（GAS では `module` が未定義）。
 */

/** 設定スプレッドシート ID を保持する Script Property キー。 */
const PROP_SPREADSHEET_ID = 'CONFIG_SPREADSHEET_ID';

/** 設定シート名を保持する Script Property キー（任意）。 */
const PROP_SHEET_NAME = 'CONFIG_SHEET_NAME';

/** Script Property 未指定時に用いる既定の設定シート名。 */
const DEFAULT_SHEET_NAME = 'settings';

/** 設定シートのラベル名列ヘッダ。 */
const HEADER_LABEL = 'ラベル名';

/** 設定シートの保持日数列ヘッダ。 */
const HEADER_DAYS = '保持日数';

/** 1 回の実行全体（全ルール合算）で処理するスレッド数の上限。 */
const MAX_THREADS_PER_RUN = 300;

/** `GmailApp.moveThreadsToArchive` の 1 回あたり上限（100 件）。 */
const ARCHIVE_BATCH_SIZE = 100;

/** `GmailApp.search` の 1 回あたり上限（500 件）。 */
const ARCHIVE_SEARCH_LIMIT = 500;

/** 日次トリガーが呼び出すエントリ関数名。 */
const TRIGGER_HANDLER = 'archiveLabeledThreads';

/** 日次トリガーの実行時刻（時）。 */
const TRIGGER_HOUR = 3;

// Node-only export guard: GAS では `module` が未定義のため評価されない。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PROP_SPREADSHEET_ID,
    PROP_SHEET_NAME,
    DEFAULT_SHEET_NAME,
    HEADER_LABEL,
    HEADER_DAYS,
    MAX_THREADS_PER_RUN,
    ARCHIVE_BATCH_SIZE,
    ARCHIVE_SEARCH_LIMIT,
    TRIGGER_HANDLER,
    TRIGGER_HOUR,
  };
}
