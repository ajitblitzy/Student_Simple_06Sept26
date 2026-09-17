'use strict';

/**
 * test/store.test.js — port-free evidence for the two layers underneath the
 * extracurricular-activity feature: the zero-dependency workbook reader
 * (`xlsx-read.js`) and the store that owns persistence, normalization and the
 * Student ID link (`activity-store.js`). It also owns the cross-workbook
 * invariant assertions, because proving a workbook was not touched needs the
 * reader and the repository, not a socket.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * It binds no network port, which is what makes it safely parallel with the
 * rest of the suite. It writes nothing into the checkout: every store, every
 * staging file and every synthetic package lives under a per-case temporary
 * directory that is removed again. The three workbooks are read-only fixtures
 * — this file asserts they stay byte-identical rather than ever writing one —
 * and every value in them is synthetic by construction, so no real personal
 * data enters this suite or its output.
 *
 * Run it with the project's single documented invocation, from the repository
 * root, with no positional argument:
 *
 *   npm test        # node --test --test-concurrency=1
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { Module } = require('node:module');
const { execFileSync } = require('node:child_process');

/* ------------------------------------------------------------------------- *
 * THE ORDERING CONSTRAINT THAT HAS TO COME FIRST
 *
 * `activity-store.js` resolves its store path ONCE, at module load, from
 * `process.env.ACTIVITY_STORE`, falling back to `activities.json` beside
 * itself — which is the developer's real store in the repository root. The
 * variable is therefore set HERE, before the first `require` of that module,
 * and pointed at a temporary directory. Setting it afterwards, or leaving it
 * to default, would make this suite write into the working tree: a silent,
 * destructive failure rather than a test failure.
 *
 * `mkdtempSync` is deliberate rather than lazy — the assignment has to happen
 * before the `require` below, and a module body cannot await.
 *
 * Both of those are changes to state that OUTLIVES this file: an environment
 * variable and, through the requires, entries in the CommonJS module cache.
 * So the state is captured before it is touched and restored afterwards, and
 * the restore is reachable from the failure path as well as the success one.
 * The root `after` hook at the foot of this file does not exist yet while this
 * block runs, so a require that throws here — a syntax error in the store, a
 * missing module — would otherwise leave the temporary directory on disk and
 * `ACTIVITY_STORE` pointing into it with nothing left able to clean either up.
 * ------------------------------------------------------------------------- */

/**
 * The identifiers `freshStore` evicts, so a re-require binds a new store path
 * and empty per-process caches.
 */
const STORE_MODULE_ID = require.resolve('../activity-store');
const READER_MODULE_ID = require.resolve('../xlsx-read');

/**
 * The value `ACTIVITY_STORE` held on entry, or `undefined` when it was unset.
 * Reading an absent variable yields `undefined` while an empty one yields the
 * empty string, so the two are distinguishable and both are restored exactly.
 */
const ORIGINAL_ACTIVITY_STORE = process.env.ACTIVITY_STORE;

/**
 * Whatever the module cache already held for those two identifiers. Normally
 * nothing — the runner gives each test file its own process and this file
 * loads them first — but recording it is what makes the teardown a restore
 * rather than an assumption.
 *
 * @type {Map<string, object>}
 */
const ORIGINAL_MODULE_ENTRIES = new Map(
  [STORE_MODULE_ID, READER_MODULE_ID]
    .filter((moduleId) => require.cache[moduleId] !== undefined)
    .map((moduleId) => [moduleId, require.cache[moduleId]])
);

const BOOTSTRAP_DIRECTORY = fsSync.mkdtempSync(path.join(os.tmpdir(), 'store-test-boot-'));
process.env.ACTIVITY_STORE = path.join(BOOTSTRAP_DIRECTORY, 'activities.json');

/**
 * Undoes the bootstrap, in the only order that is safe.
 *
 * The environment variable and the module cache are released BEFORE the
 * directory is removed. Reversing those two steps would leave process-global
 * state — a variable every later `require` of the store reads, and a cached
 * store instance whose resolved path is fixed at load — pointing at a path
 * that no longer exists.
 *
 * Synchronous, and safe to call twice: it is the teardown for a completed run
 * and the cleanup for a failed load, and `force` makes the removal a no-op
 * when the directory has already gone.
 *
 * @returns {void}
 */
function releaseBootstrap() {
  if (ORIGINAL_ACTIVITY_STORE === undefined) {
    delete process.env.ACTIVITY_STORE;
  } else {
    process.env.ACTIVITY_STORE = ORIGINAL_ACTIVITY_STORE;
  }

  for (const moduleId of [STORE_MODULE_ID, READER_MODULE_ID]) {
    const original = ORIGINAL_MODULE_ENTRIES.get(moduleId);
    if (original === undefined) {
      delete require.cache[moduleId];
    } else {
      require.cache[moduleId] = original;
    }
  }

  fsSync.rmSync(BOOTSTRAP_DIRECTORY, { recursive: true, force: true });
}

/**
 * `bootstrapStore` is the store as loaded with the bootstrap path, used for
 * the pure functions that touch no file — `normalizeLabel`, `isKnownStudent`
 * — and for the export-surface and safety checks. Every case that needs its
 * own document builds an independent instance through `freshStore`.
 *
 * `xlsxRead` is the real reader. It is stateless and holds no path, so one
 * instance serves the whole file; the cases that need it to misbehave install
 * a scripted stand-in through `storeWithScriptedReader` instead of altering
 * this one.
 */
const [bootstrapStore, xlsxRead] = (() => {
  try {
    return [require('../activity-store'), require('../xlsx-read')];
  } catch (error) {
    releaseBootstrap();
    throw error;
  }
})();

/* ------------------------------------------------------------------------- *
 * Paths
 *
 * A workbook is never named by a bare relative string: the working directory
 * a runner was started from is not a guarantee, and `xlsx-read.js` uses the
 * path exactly as given rather than resolving anything itself.
 * ------------------------------------------------------------------------- */

const REPOSITORY_ROOT = path.join(__dirname, '..');

const DETAILS_WORKBOOK = path.join(REPOSITORY_ROOT, 'student_details.xlsx');
const ACADEMICS_WORKBOOK = path.join(REPOSITORY_ROOT, 'student_academics.xlsx');
const OTHER_INFO_WORKBOOK = path.join(REPOSITORY_ROOT, 'student_other_info.xlsx');

const WORKSHEET_PART = 'xl/worksheets/sheet1.xml';
const CONTENT_TYPES_PART = '[Content_Types].xml';

/* ------------------------------------------------------------------------- *
 * Reference data
 *
 * Measured against the working tree rather than derived loosely. These are
 * the expected values, so a workbook replaced by hand fails a case here
 * instead of quietly changing what the feature validates against.
 * ------------------------------------------------------------------------- */

/** The authoritative key set: column A rows 2-11 of every workbook. */
const EXPECTED_KEY_SET = ['S001', 'S002', 'S003', 'S004', 'S005', 'S006', 'S007', 'S008', 'S009', 'S010'];

/** The nine parts every one of these packages holds, in package order. */
const EXPECTED_PART_NAMES = [
  'docProps/app.xml',
  'docProps/core.xml',
  'xl/theme/theme1.xml',
  'xl/worksheets/sheet1.xml',
  'xl/styles.xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  '[Content_Types].xml',
];

/**
 * The `[Content_Types].xml` part, measured. It is byte-identical in all three
 * packages, so a single length and digest pin the part in every workbook.
 *
 * The digest is here because the alternative is a loose assertion. Checking
 * that the text starts with `<Types` and ends with `</Types>` would hold for a
 * part whose element nesting had been mangled, for one declaring the wrong
 * content type, and for a reader that inflated the middle of it incorrectly.
 * A digest of the whole part, compared against a value computed outside this
 * suite, holds for none of those.
 */
const CONTENT_TYPES_BYTE_LENGTH = 975;
const CONTENT_TYPES_SHA256 = 'ba5af858089dd3357b4e4408a86694ff0a62ec37f21ef57a3a09544dc0ab18c4';

/**
 * The `Extracurricular Activity` column, rows 2-11 of `Other Info`. These are
 * exactly the records seeding must produce: eight distinct labels, with
 * `Robotics Club` and `Debate Society` each appearing twice, and
 * `Photography Club` the longest at sixteen characters.
 */
const EXPECTED_SEED_PAIRS = [
  ['S001', 'Robotics Club'],
  ['S002', 'Debate Society'],
  ['S003', 'Football Team'],
  ['S004', 'Music Club'],
  ['S005', 'Coding Club'],
  ['S006', 'Dance Club'],
  ['S007', 'Cricket Team'],
  ['S008', 'Photography Club'],
  ['S009', 'Robotics Club'],
  ['S010', 'Debate Society'],
];

/** Header row and declared dimension of each worksheet. */
const WORKBOOK_SHAPES = [
  {
    label: 'student_details.xlsx',
    filePath: DETAILS_WORKBOOK,
    dimension: 'A1:J11',
    headers: [
      'Student ID',
      'Name',
      'Gender',
      'Date of Birth',
      'Age',
      'Department',
      'Year',
      'Email',
      'Phone',
      'City',
    ],
  },
  {
    label: 'student_academics.xlsx',
    filePath: ACADEMICS_WORKBOOK,
    dimension: 'A1:G11',
    headers: [
      'Student ID',
      'Current Semester',
      'Previous Sem GPA',
      'Current GPA',
      'Overall GPA',
      'Attendance %',
      'Result Status',
    ],
  },
  {
    label: 'student_other_info.xlsx',
    filePath: OTHER_INFO_WORKBOOK,
    dimension: 'A1:F11',
    headers: [
      'Student ID',
      'Hostel Status',
      'Extracurricular Activity',
      'Library Books Issued',
      'Fee Status',
      'Scholarship Holder',
    ],
  },
];

/** The document vocabulary the store reads and writes. */
const SCHEMA_VERSION = 1;
const SOURCE_SUBMISSION = 'submission';
const SOURCE_WORKBOOK = 'workbook';
const MAX_LABEL_LENGTH = 60;

/**
 * The store's two documented ceilings on the document itself: the bytes the
 * loader will read, and the records it will hold. Restated here rather than
 * imported for the same reason the reader's limits below are — the store
 * exports five functions and no constants, so a case that read its own limits
 * out of the module under test would pass whatever that module happened to
 * say, including a ceiling somebody had quietly raised.
 *
 * The two are mutually consistent by design, and a case asserts that rather
 * than assuming it: a worst-case record serializes to roughly 200 bytes, so
 * `MAX_ACTIVITY_RECORDS` records fit inside `MAX_STORE_BYTES` with room to
 * spare, and the writer therefore cannot produce a document its own loader
 * refuses on size.
 */
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVITY_RECORDS = 5000;

/**
 * The record count at which the store starts warning that it is running out of
 * room: ninety per cent of the ceiling. Restated here for the same reason the
 * ceilings are — a case that read the threshold out of the module under test
 * would agree with whatever that module said, including a warning somebody had
 * quietly moved to the very last record, where it would be useless.
 */
const CAPACITY_WARNING_RECORDS = 4500;

/** The suffix the store derives its staging path from. */
const TEMPORARY_SUFFIX = '.tmp';

/**
 * How many times the store attempts the publishing rename before refusing the
 * write, restated here for the same reason as the ceilings above.
 *
 * The bound exists because this platform refuses a rename whose destination
 * another descriptor holds open, so a collision is worth retrying briefly and
 * is not worth waiting out: a destination held continuously is a process
 * racing the writer rather than a state that clears. Only a collision code is
 * retried, so a refusal that would recur identically costs exactly one
 * attempt — both halves are asserted below.
 */
const MAX_PUBLISH_ATTEMPTS = 3;

/**
 * The refusal codes `activity-store.js` raises, and those the reader raises,
 * restated here so an expectation is independent of the modules under test.
 * The store's codes are the vocabulary `activities.js` maps onto a status, so
 * a code with no case behind it is a status nobody has proven the service can
 * return.
 *
 * `E_REFERENCE_DATA` needs a seam to reach: it fires only when a workbook
 * cannot be read or cannot serve as reference data, and the workbooks in this
 * repository are valid and read-only. `storeWithScriptedReader` is that seam.
 */
const E_REFERENCE_DATA = 'E_REFERENCE_DATA';
const E_LABEL_INVALID = 'E_LABEL_INVALID';
const E_STORE_UNREADABLE = 'E_STORE_UNREADABLE';
const E_STORE_WRITE_FAILED = 'E_STORE_WRITE_FAILED';
/* Apart from `E_STORE_WRITE_FAILED` because the two call for different
 * actions: a write failure is environmental and a retry may well clear it,
 * while this one says the document cannot grow and only reclaiming room will
 * clear it. A case that accepted either code for either event would pass on
 * exactly the confusion the second code was added to remove, which is why
 * every ceiling case below names this one and every write-fault case names the
 * other. */
const E_STORE_AT_CAPACITY = 'E_STORE_AT_CAPACITY';
const E_XLSX_UNSUPPORTED_COMPRESSION = 'E_XLSX_UNSUPPORTED_COMPRESSION';
const E_XLSX_UNSUPPORTED_FLAGS = 'E_XLSX_UNSUPPORTED_FLAGS';
const E_XLSX_UNSUPPORTED_SOURCE = 'E_XLSX_UNSUPPORTED_SOURCE';
const E_XLSX_PART_NOT_FOUND = 'E_XLSX_PART_NOT_FOUND';
const E_XLSX_SHARED_STRINGS_UNSUPPORTED = 'E_XLSX_SHARED_STRINGS_UNSUPPORTED';
const E_XLSX_UNSUPPORTED_CELL_TYPE = 'E_XLSX_UNSUPPORTED_CELL_TYPE';
const E_XLSX_TRUNCATED = 'E_XLSX_TRUNCATED';
const E_XLSX_MALFORMED_XML = 'E_XLSX_MALFORMED_XML';
const E_XLSX_LIMIT_EXCEEDED = 'E_XLSX_LIMIT_EXCEEDED';

/**
 * The reader's documented resource ceilings, and the last column of the
 * ECMA-376 grid. Restated here rather than imported: a test that read its own
 * limits out of the module under test would pass whatever the module happened
 * to say.
 */
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_COMPRESSED_BYTES = 1024 * 1024;
const MAX_PART_BYTES = 4 * 1024 * 1024;
const LAST_COLUMN_LETTERS = 'XFD';

/**
 * The reader's complete declared refusal vocabulary, in the reader's own
 * order. Both consumers need it whole: the membership assertion has to admit
 * every code a refusal can carry, and the translation loop drives one case per
 * code.
 */
const READER_REFUSAL_CODES = [
  E_XLSX_UNSUPPORTED_COMPRESSION,
  E_XLSX_UNSUPPORTED_FLAGS,
  E_XLSX_UNSUPPORTED_SOURCE,
  E_XLSX_PART_NOT_FOUND,
  E_XLSX_SHARED_STRINGS_UNSUPPORTED,
  E_XLSX_UNSUPPORTED_CELL_TYPE,
  E_XLSX_TRUNCATED,
  E_XLSX_MALFORMED_XML,
  E_XLSX_LIMIT_EXCEEDED,
];

/* ========================================================================= *
 * Local harness
 *
 * Everything this suite needs, in this file: the helpers below are local and
 * self-contained, so a case reads without leaving it.
 * ========================================================================= */

/**
 * Loads an independent `activity-store` instance bound to `storePath`.
 *
 * The store resolves its path once, at module load, so the environment
 * variable cannot be re-pointed at a second file within one process. Busting
 * the CommonJS cache and re-requiring is the only way to exercise another
 * path — and it also resets the module's per-process state: the key-set
 * cache, the seed snapshot, and the write mutex's chain. Every case that owns
 * a document takes its own instance, so no case can inherit another's.
 *
 * @param {string} storePath Absolute path the new instance will read and write.
 * @returns {{isKnownStudent: Function, normalizeLabel: Function, addActivity: Function, listActivities: Function, storePath: Function}}
 *   A freshly initialized store module.
 */
function freshStore(storePath) {
  process.env.ACTIVITY_STORE = storePath;
  delete require.cache[require.resolve('../activity-store')];
  delete require.cache[require.resolve('../xlsx-read')];
  return require('../activity-store');
}

/**
 * Creates a temporary directory for one case and registers its removal.
 *
 * Nothing this suite writes may land in the checkout, so every artifact — a
 * store, a staging file, a synthetic package — is created under here and the
 * whole tree is removed when the case ends, pass or fail.
 *
 * @param {import('node:test').TestContext} t The running case.
 * @returns {Promise<string>} The directory path.
 */
async function makeTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'store-test-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

/**
 * Creates a temporary directory and an independent store inside it.
 *
 * @param {import('node:test').TestContext} t The running case.
 * @param {string} [fileName] The store's file name within the directory.
 * @returns {Promise<{directory: string, store: Object, storeFile: string, temporaryFile: string}>}
 *   The directory, the store instance, its resolved path, and the staging
 *   path the store derives from it.
 */
async function makeIsolatedStore(t, fileName = 'activities.json') {
  const directory = await makeTemporaryDirectory(t);
  const storeFile = path.join(directory, fileName);
  const store = freshStore(storeFile);
  return { directory, store, storeFile, temporaryFile: storeFile + TEMPORARY_SUFFIX };
}

/* ------------------------------------------------------------------------- *
 * The reference-data seam
 *
 * `E_REFERENCE_DATA` cannot be provoked from outside the process: it fires
 * when a workbook cannot be read or cannot serve as reference data, and the
 * three workbooks here are valid, committed and read-only. Corrupting one to
 * reach the path is out of the question — they are fixtures this very file
 * asserts byte-identical, and a mutated copy of committed student data has no
 * business on disk.
 *
 * So the reader is replaced instead, for one case at a time, by a stand-in
 * that passes every call through to the real module except the ones a case has
 * scripted. Installing it through the CommonJS cache before the store is
 * required is what reaches the store's own `require('./xlsx-read')` without
 * editing a line of the implementation: the store resolves that specifier to
 * the same identifier, finds the stand-in already cached, and uses it.
 *
 * The stand-in is a real `Module` rather than a bare object, so the loader
 * sees exactly the shape it maintains itself, and the previous cache entry is
 * restored when the case ends — process-global state that a test installs and
 * leaves behind is a test that has changed the suite for every case after it.
 * ------------------------------------------------------------------------- */

/** Workbook base names, which are how a script addresses a read. */
const DETAILS_WORKBOOK_NAME = path.basename(DETAILS_WORKBOOK);
const OTHER_INFO_WORKBOOK_NAME = path.basename(OTHER_INFO_WORKBOOK);

/**
 * Builds the key a script uses for one column of one workbook.
 *
 * @param {string} workbookName A workbook base name.
 * @param {string} columnLetter The column, uppercase.
 * @returns {string} For example `student_details.xlsx!A`.
 */
function columnKey(workbookName, columnLetter) {
  return `${workbookName}!${columnLetter}`;
}

/**
 * Checked here rather than deferred to the reader: a selection it would refuse
 * as an argument fault must record no read.
 */
const COLUMN_LETTERS_PATTERN = /^[A-Za-z]{1,3}$/u;

/**
 * The column keys one `readSheetRows` call reads, in the order it named them.
 *
 * A selection that is absent addresses no column: it asks for every column,
 * and keys for columns nobody named would have `calls` claim reads that were
 * never requested. A selection the real reader would refuse as an argument
 * fault addresses none either — it is handed over unchanged so the reader's
 * own TypeError is what a case sees, and a call that never reads is not a read
 * worth recording. Both the letter shape and the A-to-XFD bound are checked
 * for that reason, against `LAST_COLUMN_LETTERS`, which this file already
 * restates because the reader exports no constants.
 *
 * @param {string} filePath The workbook the call names.
 * @param {unknown} columnLetters The call's column selection.
 * @returns {string[]} One column key per requested column, selection order.
 */
function requestedColumnKeys(filePath, columnLetters) {
  if (!Array.isArray(columnLetters) || columnLetters.length === 0) {
    return [];
  }

  /* Uppercase letters of equal length order lexicographically exactly as
   * columns do, so the bound needs no index arithmetic here. */
  const letters = columnLetters.map((letter) =>
    COLUMN_LETTERS_PATTERN.test(letter) ? String(letter).toUpperCase() : null
  );
  const addressable = letters.every(
    (letter) =>
      letter !== null &&
      (letter.length < LAST_COLUMN_LETTERS.length || letter <= LAST_COLUMN_LETTERS)
  );
  if (!addressable) {
    return [];
  }

  const workbookName = path.basename(filePath);
  return letters.map((letter) => columnKey(workbookName, letter));
}

/**
 * Builds a refusal in the shape the real reader raises one.
 *
 * Faithful on purpose: the store is contracted to translate ANY reader
 * refusal into `E_REFERENCE_DATA` and to carry the original as `cause`, so a
 * scripted fault that did not carry a reader code would test a weaker claim
 * than the one the module documents.
 *
 * @param {string} code One of `READER_REFUSAL_CODES`.
 * @returns {Error} The refusal.
 */
function scriptedReaderRefusal(code) {
  const error = new Error('xlsx-read: scripted refusal, raised by the test harness');
  error.code = code;
  return error;
}

/**
 * Loads an independent store whose reader is a scripted stand-in.
 *
 * The returned `script` is live: a case arms a fault, observes the refusal,
 * disarms it and observes the recovery, all against ONE store instance —
 * which is the only way to prove the module retries rather than caching a
 * failure for the lifetime of the process.
 *
 * BOTH of the reader entry points the store reads reference data through are
 * intercepted, because the two reads arrive through different ones: the key
 * set through `readColumn`, and the seed snapshot through ONE selective
 * `readSheetRows(workbook, part, ['A', 'C'])` that takes both of its columns
 * in a single pass. A script addresses either by column key, and every read is
 * recorded in `script.calls` as one key per column the call asked for, in the
 * order the selection names them: the seed read therefore records
 * `student_other_info.xlsx!A` and then `student_other_info.xlsx!C`. A call
 * with no selection reads every column and records nothing, per
 * `requestedColumnKeys`.
 *
 * Diversion is decided per column, over the columns a call names. An armed
 * failure on ANY of them refuses the whole call, which is what the reader
 * itself does when one column of a single pass cannot be read. Scripted
 * values replace that column's per-row values while every other requested
 * column still comes from the real workbook, so one property is under test at
 * a time. A call naming no scripted column is delegated to the real module and
 * its rows returned untouched: rows rebuilt on that path would let a reader
 * defect hide behind the harness.
 *
 * Substituted rows carry one value per row for each requested column, which is
 * how the store consumes a selective read, and the row count is the SHORTEST
 * of the requested columns' value arrays. That reproduces the length the seed
 * snapshot gets from `Math.min` over the two columns it projects out of that
 * one read, so a case that scripts one column as a two-element array while the
 * other comes from the eleven-row workbook still describes a two-row
 * worksheet.
 *
 * @param {import('node:test').TestContext} t The running case.
 * @param {string} storePath Absolute path the new instance will read and write.
 * @returns {{store: Object, script: {failures: Map<string, () => Error>, values: Map<string, string[]>, calls: string[]}}}
 *   The store, and the script driving its reader. `failures` maps a column key
 *   to a factory for the error to throw; `values` maps a column key to the
 *   values to return instead of reading; `calls` records every column key read,
 *   in order, so a case can prove a read did or did not happen again.
 */
function storeWithScriptedReader(t, storePath) {
  const script = { failures: new Map(), values: new Map(), calls: [] };

  const standInExports = {
    ...xlsxRead,
    readColumn(filePath, partName, columnLetter) {
      const key = columnKey(path.basename(filePath), columnLetter.toUpperCase());
      script.calls.push(key);

      const failure = script.failures.get(key);
      if (failure !== undefined) {
        throw failure();
      }
      if (script.values.has(key)) {
        /* A copy, so a case cannot hand the store an array it then mutates. */
        return [...script.values.get(key)];
      }
      return xlsxRead.readColumn(filePath, partName, columnLetter);
    },
    readSheetRows(filePath, partName, columnLetters = null) {
      const keys = requestedColumnKeys(filePath, columnLetters);
      script.calls.push(...keys);

      /* An armed failure on any requested column refuses the whole call,
       * because one unreadable column makes the store's single selective read
       * unusable. */
      for (const key of keys) {
        const failure = script.failures.get(key);
        if (failure !== undefined) {
          throw failure();
        }
      }

      const scriptedCount = keys.filter((key) => script.values.has(key)).length;
      if (scriptedCount === 0) {
        /* Nothing is scripted for any column this call names, so the real
         * reader's rows are returned exactly as it produced them. */
        return xlsxRead.readSheetRows(filePath, partName, columnLetters);
      }

      /* A requested column with no script still comes from the real workbook,
       * so the real single pass runs unless every requested column is
       * scripted — in which case the workbook is not read at all. */
      const realRows =
        scriptedCount < keys.length
          ? xlsxRead.readSheetRows(filePath, partName, columnLetters)
          : [];
      const letters = columnLetters.map((letter) => letter.toUpperCase());
      const columns = keys.map((key, position) => {
        if (script.values.has(key)) {
          /* A copy, so a case cannot hand the store an array it then mutates. */
          return [...script.values.get(key)];
        }
        const letter = letters[position];
        return realRows.map((row) =>
          Object.prototype.hasOwnProperty.call(row, letter) ? row[letter] : ''
        );
      });

      /* The shortest requested column decides how many rows the worksheet is
       * described as having, exactly as the store's `Math.min` does over the
       * two columns it projects out of that one read. */
      const rowCount = Math.min(...columns.map((values) => values.length));
      const rows = [];
      for (let index = 0; index < rowCount; index += 1) {
        const row = {};
        for (const [position, letter] of letters.entries()) {
          row[letter] = columns[position][index];
        }
        rows.push(row);
      }
      return rows;
    },
  };

  const previousReaderEntry = require.cache[READER_MODULE_ID];
  t.after(() => {
    if (previousReaderEntry === undefined) {
      delete require.cache[READER_MODULE_ID];
    } else {
      require.cache[READER_MODULE_ID] = previousReaderEntry;
    }
    /* The store instance held the stand-in, so it must go too; the next
     * `freshStore` then loads a store bound to the real reader. */
    delete require.cache[STORE_MODULE_ID];
  });

  const standIn = new Module(READER_MODULE_ID, module);
  standIn.filename = READER_MODULE_ID;
  standIn.loaded = true;
  standIn.exports = standInExports;

  process.env.ACTIVITY_STORE = storePath;
  delete require.cache[STORE_MODULE_ID];
  require.cache[READER_MODULE_ID] = standIn;

  return { store: require('../activity-store'), script };
}

/**
 * Writes bytes to a path and hands back exactly what was written, so a later
 * assertion can compare against them rather than against a re-serialization.
 *
 * @param {string} filePath Where to write.
 * @param {string|Buffer} contents The bytes or UTF-8 text.
 * @returns {Promise<Buffer>} The bytes as written.
 */
async function writeBytes(filePath, contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
  await fs.writeFile(filePath, bytes);
  return bytes;
}

/**
 * Reads and parses the store document.
 *
 * @param {string} filePath The store path.
 * @returns {Promise<{schemaVersion: number, activities: Array<Object>}>} The document.
 */
async function readDocument(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

/**
 * Reports whether a path exists, distinguishing absence from any other fault
 * so a permissions problem is not silently reported as "not there".
 *
 * @param {string} filePath The path to probe.
 * @returns {Promise<boolean>} True when the path exists.
 */
async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Asserts a file's bytes are exactly what they were.
 *
 * Every load failure in `activity-store.js` is contracted to be
 * non-destructive, and "it threw" is not evidence of that: a loader could
 * refuse a document and still have truncated it. So each refusal case
 * compares the bytes.
 *
 * @param {string} filePath The file to check.
 * @param {Buffer} expectedBytes The bytes written before the failed call.
 * @param {string} context Names the case in the failure message.
 * @returns {Promise<void>}
 */
async function assertBytesUnchanged(filePath, expectedBytes, context) {
  const actual = await fs.readFile(filePath);
  assert.ok(
    actual.equals(expectedBytes),
    `${context}: the file on disk changed. A refused load must never write, truncate or repair the store. ` +
      `Expected ${expectedBytes.length} byte(s), found ${actual.length}.`
  );
}

/* ------------------------------------------------------------------------- *
 * Output safety
 *
 * Every string this file puts into an assertion message is retained evidence:
 * the runner copies it into the spec stream, and the documented coverage
 * command copies it into a JUnit file that is kept for inspection. So a
 * failure message may name what was expected and what kind of thing arrived,
 * and nothing more.
 *
 * What it must never carry: an internal `message` or `cause` — the reader
 * names the package path and the part it refused, and the store names Student
 * IDs and activity labels, because both fill a message with the offending
 * detail for a log rather than for a report; a filesystem path, whether a
 * staging path, a temporary directory or a developer's checkout; or a value
 * read out of a workbook, since the identity workbook carries a name, a date
 * of birth, an email and a phone number on every row.
 *
 * The two describers below are the only way this file renders a caught error
 * or an unexpected value. That is what makes the rule enforceable by reading
 * the file rather than a convention each case has to remember.
 * ------------------------------------------------------------------------- */

/**
 * Describes a caught error by its declared identity alone.
 *
 * `name` and `code` are the two fields both modules document as the caller's
 * contract, and neither is derived from the data that provoked the error —
 * unlike `message`, which is deliberately specific and therefore unsafe to
 * reproduce here.
 *
 * @param {unknown} error The caught value.
 * @returns {string} For example `Error carrying E_STORE_UNREADABLE`.
 */
function describeErrorSafely(error) {
  if (!(error instanceof Error)) {
    return `a non-Error value of type ${typeof error}`;
  }
  const name = typeof error.name === 'string' ? error.name : 'Error';
  const code = typeof error.code === 'string' ? error.code : 'no code';
  return `${name} carrying ${code}`;
}

/**
 * Describes an unexpected value by type and size, never by content.
 *
 * Used where a call was expected to fail and did not. The assertion's job is
 * to report that it returned at all; serializing what it returned would put
 * whatever it had just read — a workbook row, a stored record — into the
 * retained report.
 *
 * @param {unknown} value The value that should not have been produced.
 * @returns {string} For example `an array of 11 element(s)`.
 */
function describeValueSafely(value) {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (Array.isArray(value)) {
    return `an array of ${value.length} element(s)`;
  }
  const type = typeof value;
  if (type === 'string') {
    return `a string of ${value.length} character(s)`;
  }
  if (type === 'number' || type === 'boolean') {
    return `the ${type} ${String(value)}`;
  }
  if (type === 'object') {
    return `an object with ${Object.keys(value).length} key(s)`;
  }
  return `a value of type ${type}`;
}

/**
 * Asserts a predicate over an internal error message without echoing it.
 *
 * Several cases need to prove a refusal names the rule it enforced — the
 * control-character rule rather than the length rule, the composite key
 * rather than the schema version. `assert.match` would establish that, but it
 * renders the subject string on failure, which is exactly the internal
 * message this file may not retain. Testing the predicate first and asserting
 * the boolean keeps the evidence and drops the disclosure.
 *
 * @param {unknown} error The error whose message is under test.
 * @param {RegExp} pattern What the message must contain.
 * @param {string} explanation Why the case requires it. No interpolation.
 * @returns {void}
 */
function assertMessageMentions(error, pattern, explanation) {
  const message = error instanceof Error && typeof error.message === 'string' ? error.message : '';
  assert.ok(
    pattern.test(message),
    `${explanation} (the message itself is withheld from this report by design; ` +
      `the error was ${describeErrorSafely(error)})`
  );
}

/**
 * Asserts an internal error message does NOT contain something.
 *
 * The mirror of `assertMessageMentions`, for a case that proves a refusal
 * does not carry the rejected payload back to the caller.
 * `assert.doesNotMatch` would print the whole subject string on failure —
 * that is, it would disclose the very payload the case exists to keep out.
 *
 * @param {unknown} error The error whose message is under test.
 * @param {RegExp} pattern What the message must not contain.
 * @param {string} explanation Why the case requires it. No interpolation.
 * @returns {void}
 */
function assertMessageOmits(error, pattern, explanation) {
  const message = error instanceof Error && typeof error.message === 'string' ? error.message : '';
  assert.ok(
    !pattern.test(message),
    `${explanation} (the message itself is withheld from this report by design; ` +
      `the error was ${describeErrorSafely(error)})`
  );
}

/**
 * Runs `callable` expecting a throw, and returns what was thrown.
 *
 * An `AssertionError` is re-thrown rather than returned, so a case that fails
 * to throw reports that instead of handing its own assertion failure back as
 * though it were the error under test.
 *
 * @param {() => unknown} callable The call expected to throw.
 * @param {string} context Names the case in the failure message.
 * @returns {Error} The thrown value.
 */
function captureThrow(callable, context) {
  try {
    const value = callable();
    assert.fail(`${context}: expected a throw, but the call returned ${describeValueSafely(value)}`);
  } catch (error) {
    if (error instanceof assert.AssertionError) {
      throw error;
    }
    return error;
  }
  /* Unreachable: `assert.fail` always throws. Present so every path returns. */
  throw new Error(`${context}: unreachable`);
}

/**
 * Awaits `promise` expecting a rejection, and returns the reason.
 *
 * @param {Promise<unknown>} promise The call expected to reject.
 * @param {string} context Names the case in the failure message.
 * @returns {Promise<Error>} The rejection reason.
 */
async function captureRejection(promise, context) {
  try {
    const value = await promise;
    assert.fail(
      `${context}: expected a rejection, but it resolved with ${describeValueSafely(value)}`
    );
  } catch (error) {
    if (error instanceof assert.AssertionError) {
      throw error;
    }
    return error;
  }
  throw new Error(`${context}: unreachable`);
}

/**
 * Asserts an error carries one of the declared refusal codes.
 *
 * Matching on `code` rather than on message text is the contract both modules
 * document: a message names the offending detail for a log and may be
 * rephrased, while the code is what callers and tests are entitled to.
 *
 * The failure message reports the expected code, the arrived code and the
 * error's name, and deliberately stops there. `error.message` is the one
 * field of a refusal guaranteed to be specific about what provoked it: a
 * reader refusal names the package path and the part, and a store refusal
 * names a Student ID and an activity label. That is right for a log and wrong
 * for a retained spec and JUnit artifact, so the detail stays in the process
 * and out of the report. `code` and `name` are fixed vocabulary — neither is
 * derived from the data — and the assertion's own `actual`/`expected` fields
 * hold only those two codes.
 *
 * @param {unknown} error The thrown value.
 * @param {string} expectedCode The expected `code` property.
 * @param {string} context Names the case in the failure message.
 * @returns {Error} `error`, once proven to carry the code.
 */
function assertCode(error, expectedCode, context) {
  assert.ok(
    error instanceof Error,
    `${context}: expected an Error, received ${describeErrorSafely(error)}`
  );
  assert.strictEqual(
    error.code,
    expectedCode,
    `${context}: expected code ${expectedCode}, received ${describeErrorSafely(error)}`
  );
  return error;
}

/**
 * Builds a record in the exact shape the store writes for seeded data: no
 * `submittedAt` key at all, because a label sitting in a spreadsheet has no
 * submission time and inventing one would fabricate provenance.
 *
 * @param {string} studentId The student the label belongs to.
 * @param {string} activity The normalized label.
 * @returns {{studentId: string, activity: string, source: string}} The record.
 */
function seededRecord(studentId, activity) {
  return { studentId, activity, source: SOURCE_WORKBOOK };
}

/**
 * Builds a submission record.
 *
 * @param {string} studentId The student the label belongs to.
 * @param {string} activity The normalized label.
 * @param {string} submittedAt An ISO-8601 instant in UTC.
 * @returns {{studentId: string, activity: string, source: string, submittedAt: string}} The record.
 */
function submittedRecord(studentId, activity, submittedAt) {
  return { studentId, activity, source: SOURCE_SUBMISSION, submittedAt };
}

/**
 * Wraps records in a store document.
 *
 * @param {Array<Object>} activities The records.
 * @returns {{schemaVersion: number, activities: Array<Object>}} The document.
 */
function documentOf(activities) {
  return { schemaVersion: SCHEMA_VERSION, activities };
}

/**
 * The composite key the store compares records by: `(studentId, label)` with
 * the label folded to lower case. Reimplemented here on purpose — a test that
 * imported the store's own comparison could not detect the store agreeing
 * with itself while both were wrong.
 *
 * @param {{studentId: string, activity: string}} record The record.
 * @returns {string} The comparison key.
 */
function compositeKeyOf(record) {
  return `${record.studentId}\u0000${record.activity.toLowerCase()}`;
}


/* ------------------------------------------------------------------------- *
 * Synthetic OOXML packages
 *
 * The reader's refusals are only worth asserting against a package that is
 * genuinely outside its supported subset, and such a package has to be built
 * rather than found: copying a repository workbook and corrupting the copy
 * would put a mutated version of committed student data on disk, and mutating
 * the workbook itself is forbidden outright. So every malformed fixture below
 * is assembled byte by byte, in a temporary directory, from bytes this file
 * chose.
 *
 * ZIP local file header, per APPNOTE.TXT 4.3.7 — the layout the reader walks:
 *
 *   +0  signature 0x04034b50   +14 crc-32 (the reader does not check it)
 *   +4  version needed         +18 compressed size
 *   +6  general-purpose flag   +22 uncompressed size
 *   +8  compression method     +26 file name length
 *   +10 last modified time     +28 extra field length
 *   +12 last modified date     +30 file name, then the entry data
 *
 * No central directory is appended: the reader's walk ends when the offset
 * reaches the end of the buffer, and a partial trailing record would itself
 * be a truncation.
 * ------------------------------------------------------------------------- */

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_FILE_HEADER_LENGTH = 30;
const VERSION_NEEDED_TO_EXTRACT = 20;
const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;

/**
 * Builds one ZIP local file header plus its data.
 *
 * @param {string} name The part name, for example `'xl/worksheets/sheet1.xml'`.
 * @param {string|Buffer} payload The part's uncompressed content.
 * @param {{method?: number, flag?: number, declaredCompressedSize?: number, trailingBytes?: Buffer, corruptData?: boolean}} [options]
 *   `method` defaults to DEFLATE, which is what every real workbook here uses;
 *   `flag` defaults to 0, the only value the reader accepts;
 *   `declaredCompressedSize` overrides the size field so a header can claim
 *   more bytes than the file holds;
 *   `trailingBytes` are appended after a valid DEFLATE stream and counted in
 *   the declared size, which is how an entry claims more bytes than its stream
 *   occupies;
 *   `corruptData` replaces the compressed bytes with data that is not a
 *   DEFLATE stream at all, while leaving the declared size honest.
 * @returns {Buffer} The entry, ready to concatenate.
 */
function zipLocalEntry(name, payload, options = {}) {
  const method = options.method === undefined ? COMPRESSION_DEFLATE : options.method;
  const flag = options.flag === undefined ? 0 : options.flag;
  const nameBytes = Buffer.from(name, 'utf8');
  const uncompressed = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  /* Only DEFLATE is actually compressed. Any other method — including the
   * unsupported ones this file fabricates — carries the bytes verbatim, which
   * is what makes "the reader must not hand back still-compressed bytes"
   * observable: if it ever returned the data of a method-12 entry as-is, the
   * returned text would match the payload and the case below would notice. */
  let data = method === COMPRESSION_DEFLATE ? zlib.deflateRawSync(uncompressed) : uncompressed;
  if (options.corruptData) {
    data = Buffer.alloc(data.length, 0xff);
  }
  if (options.trailingBytes !== undefined) {
    data = Buffer.concat([data, options.trailingBytes]);
  }

  const header = Buffer.alloc(LOCAL_FILE_HEADER_LENGTH);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT, 4);
  header.writeUInt16LE(flag, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(zlib.crc32(uncompressed), 14);
  header.writeUInt32LE(
    options.declaredCompressedSize === undefined ? data.length : options.declaredCompressedSize,
    18
  );
  header.writeUInt32LE(uncompressed.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);

  return Buffer.concat([header, nameBytes, data]);
}

/**
 * Writes a package assembled from entries.
 *
 * @param {string} directory The temporary directory to write into.
 * @param {string} fileName The package file name.
 * @param {Buffer[]} entries Entries from `zipLocalEntry`, or raw bytes.
 * @returns {Promise<string>} The package path.
 */
async function writePackage(directory, fileName, entries) {
  const filePath = path.join(directory, fileName);
  await fs.writeFile(filePath, Buffer.concat(entries));
  return filePath;
}

/**
 * Builds a minimal worksheet part around any number of rows.
 *
 * The namespace and the `<dimension>` element are included because a real
 * part carries them and the reader has to skip past them to reach
 * `<sheetData>`.
 *
 * Several rows matter rather than being a convenience: the reader's contract
 * is that it returns one value per row for a requested column, and no
 * single-row fixture can show whether a row missing that column shifts the
 * rows beneath it.
 *
 * @param {string[]} rowsXml Complete `<row>` elements, in document order.
 * @param {string} dimension The declared dimension.
 * @returns {string} The part's XML.
 */
function worksheetXmlOfRows(rowsXml, dimension) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="${dimension}"/>` +
    `<sheetData>${rowsXml.join('')}</sheetData>` +
    '</worksheet>'
  );
}

/**
 * Builds a minimal worksheet part around one row of cell XML.
 *
 * @param {string} cellsXml The `<c>` elements of a single row.
 * @param {string} [dimension] The declared dimension.
 * @returns {string} The part's XML.
 */
function worksheetXml(cellsXml, dimension = 'A1:C1') {
  return worksheetXmlOfRows([rowXml(1, cellsXml)], dimension);
}

/**
 * Wraps cell XML in a numbered `<row>`.
 *
 * @param {number} rowNumber The row's `r` attribute, one-based.
 * @param {string} cellsXml The row's `<c>` elements.
 * @returns {string} The row element.
 */
function rowXml(rowNumber, cellsXml) {
  return `<row r="${rowNumber}">${cellsXml}</row>`;
}

/**
 * Builds an inline-string cell — the only text form these packages use, since
 * none of them carries a shared-string table.
 *
 * `text` is inserted VERBATIM and is deliberately not escaped: the cases that
 * exercise entity decoding have to place raw `&amp;` and `&#x26;` sequences in
 * the part, which an escaping helper would turn into something else.
 *
 * @param {string} reference The cell's `r` attribute, for example `'A1'`.
 * @param {string} text The cell's character data, already XML-encoded.
 * @returns {string} The cell element.
 */
function inlineStringCell(reference, text) {
  return `<c r="${reference}" t="inlineStr"><is><t>${text}</t></is></c>`;
}

/**
 * Reads a synthetic worksheet, reporting either its rows or a declared refusal.
 *
 * Two of the cases below sit on different parsing decisions. An undeclared
 * entity reference, or a numeric reference that names no character, is a fatal
 * well-formedness error under XML 1.0, so refusing the part is the conformant
 * answer; this reader instead preserves the raw sequence verbatim — a
 * deliberate leniency of this project, so that nothing disappears without a
 * trace. What a cell that omits its `r` attribute means is genuinely open —
 * ECMA-376 implies the position — and this reader gives it the next column.
 *
 * What is NOT open is the failure those branches must never have: a value
 * silently dropped, or a value placed in a column it does not belong to. The
 * seed read pairs a Student ID from one column with an activity label from
 * another, so a shifted label credits one student with another's activity,
 * and a dropped one loses a record with no error anywhere. These cases
 * therefore assert exactly that pair of outcomes — a refusal carrying one of
 * the reader's declared codes, or the precise documented result — which
 * holds whichever way the parsing is tightened later.
 *
 * @param {string} filePath The synthetic package.
 * @param {string} context Names the case in the failure message.
 * @returns {{refused: true, code: string}|{refused: false, rows: Array<Object<string, string>>}}
 */
function readSheetRowsOutcome(filePath, context) {
  try {
    return { refused: false, rows: xlsxRead.readSheetRows(filePath, WORKSHEET_PART) };
  } catch (error) {
    assert.ok(
      error instanceof Error,
      `${context}: expected rows or an Error, received ${describeErrorSafely(error)}`
    );
    assert.ok(
      READER_REFUSAL_CODES.includes(error.code),
      `${context}: a refusal must carry one of the reader's declared codes, so a caller can ` +
        `act on it rather than guess; received ${describeErrorSafely(error)}`
    );
    return { refused: true, code: error.code };
  }
}

/* ------------------------------------------------------------------------- *
 * Git
 *
 * Two invariants can only be proven against the repository itself: that no
 * workbook was modified, and that the runtime store is untracked. Both are
 * read-only `git` queries, run with `cwd` at the repository root so they are
 * independent of where the runner was started.
 * ------------------------------------------------------------------------- */

/**
 * Runs a read-only `git` query and returns its standard output.
 *
 * `execFileSync` is used without a shell, so a pathspec such as `*.xlsx` is
 * handed to git literally and globbed by git rather than by a shell — which
 * is also why this behaves identically on every platform.
 *
 * @param {string[]} args The arguments after `git`.
 * @returns {string} Standard output, decoded as UTF-8.
 */
function git(args) {
  return execFileSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Fails with a legible message when `git` is not usable, rather than letting
 * a missing binary surface as a confusing ENOENT stack inside an assertion
 * about workbooks.
 *
 * @returns {void}
 */
function requireGit() {
  try {
    git(['--version']);
  } catch (error) {
    assert.fail(
      'git is required for the repository invariants in this group but could not be run ' +
        `(${describeErrorSafely(error)}). Run the suite from a git checkout with git on PATH.`
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Teardown of everything the bootstrap block changed: the environment
 * variable, the module cache entries, and only then the directory itself. No
 * timer, listener or open handle is left anywhere in this file, so the runner
 * exits on its own and `--test-force-exit` is never needed.
 *
 * `freshStore` re-points `ACTIVITY_STORE` on every call, so by the time this
 * runs the variable holds whichever temporary path the last case used — which
 * is exactly why the restore is unconditional rather than a check for the
 * bootstrap value.
 * ------------------------------------------------------------------------- */

after(() => {
  releaseBootstrap();
});

/* ========================================================================= *
 * Module surface and suite safety
 * ========================================================================= */

describe('module surface and suite safety', () => {
  it('exposes exactly the five store functions the feature depends on', () => {
    assert.deepStrictEqual(Object.keys(bootstrapStore).sort(), [
      'addActivity',
      'isKnownStudent',
      'listActivities',
      'normalizeLabel',
      'storePath',
    ]);
    for (const name of Object.keys(bootstrapStore)) {
      assert.strictEqual(typeof bootstrapStore[name], 'function', `${name} must be a function`);
    }
  });

  it('exposes exactly the four reader functions, including the two the invariants need', () => {
    assert.deepStrictEqual(Object.keys(xlsxRead).sort(), [
      'listEntries',
      'readColumn',
      'readEntry',
      'readSheetRows',
    ]);
    for (const name of Object.keys(xlsxRead)) {
      assert.strictEqual(typeof xlsxRead[name], 'function', `${name} must be a function`);
    }
  });

  it('never points a store at a path inside the checkout', async (t) => {
    /* The store's default is `activities.json` beside its own source, so a
     * suite that forgot to set ACTIVITY_STORE before requiring it would write
     * into the working tree. This pins both the bootstrap instance and a
     * freshly loaded one. */
    const isInsideCheckout = (candidate) => {
      /* `path.relative` returns an absolute path when the two arguments sit on
       * different volumes, which is not "inside" either — hence both checks. */
      const relative = path.relative(REPOSITORY_ROOT, candidate);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    };

    assert.strictEqual(
      isInsideCheckout(bootstrapStore.storePath()),
      false,
      `the bootstrap store resolved to ${bootstrapStore.storePath()}, which is inside the checkout`
    );

    const { store, storeFile } = await makeIsolatedStore(t);
    assert.strictEqual(store.storePath(), storeFile);
    assert.strictEqual(isInsideCheckout(store.storePath()), false);
  });

  it('answers key-set membership from the identity workbook', () => {
    for (const studentId of EXPECTED_KEY_SET) {
      assert.strictEqual(bootstrapStore.isKnownStudent(studentId), true, `${studentId} must be known`);
    }
    assert.strictEqual(bootstrapStore.isKnownStudent('S999'), false);
    assert.strictEqual(bootstrapStore.isKnownStudent('s001'), false);
    assert.strictEqual(bootstrapStore.isKnownStudent('S0012'), false);
    assert.strictEqual(bootstrapStore.isKnownStudent(''), false);
    assert.strictEqual(bootstrapStore.isKnownStudent(undefined), false);
  });
});



/* ========================================================================= *
 * Seeding, and the three states the store can be found in
 *
 * Absent, present-and-valid, and present-but-unreadable are genuinely
 * different, and each behaves differently for a read and for a write — so all
 * six combinations are asserted. The middle state is the load-bearing one: a
 * document that exists is taken as complete, which is exactly why an empty
 * `activities.json` must never be pre-created by a build.
 * ========================================================================= */

describe('seeding and the three initial store states', () => {
  it('answers a read from the seed snapshot when the store is absent, and creates no file', async (t) => {
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);
    assert.strictEqual(await exists(storeFile), false, 'the store must not exist before the read');

    const records = await store.listActivities('S001');

    assert.deepStrictEqual(records, [seededRecord('S001', 'Robotics Club')]);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(records[0], 'submittedAt'),
      false,
      'a seeded record must not carry a submittedAt key at all: the workbook records no submission time'
    );
    assert.strictEqual(
      await exists(storeFile),
      false,
      'a read must never have a write side effect — the store is created only by an actual submission'
    );
    assert.strictEqual(await exists(temporaryFile), false, 'a read must not leave a staging file');
  });

  it('materializes the document from the seed snapshot when the first submission arrives', async (t) => {
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);
    const startedAt = Date.now();

    const outcome = await store.addActivity('S001', 'Chess Club');

    const finishedAt = Date.now();
    assert.strictEqual(outcome.created, true);
    assert.strictEqual(outcome.record.studentId, 'S001');
    assert.strictEqual(outcome.record.activity, 'Chess Club');
    assert.strictEqual(outcome.record.source, SOURCE_SUBMISSION);
    assert.match(
      outcome.record.submittedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
      'submittedAt must be an ISO-8601 instant in UTC'
    );
    const submittedAtMs = Date.parse(outcome.record.submittedAt);
    assert.ok(
      submittedAtMs >= startedAt - 1000 && submittedAtMs <= finishedAt + 1000,
      `submittedAt ${outcome.record.submittedAt} must be the time of the write, not a fabricated value`
    );

    const document = await readDocument(storeFile);
    assert.strictEqual(document.schemaVersion, SCHEMA_VERSION);
    assert.strictEqual(
      document.activities.length,
      EXPECTED_SEED_PAIRS.length + 1,
      'the document must hold all ten seeded labels plus the submission'
    );
    for (const [studentId, activity] of EXPECTED_SEED_PAIRS) {
      const seeded = document.activities.find(
        (record) => record.studentId === studentId && record.activity === activity
      );
      assert.ok(seeded !== undefined, `the seeded record for ${studentId} (${activity}) is missing`);
      assert.strictEqual(seeded.source, SOURCE_WORKBOOK, `${studentId} must be marked as imported`);
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(seeded, 'submittedAt'),
        false,
        `the seeded record for ${studentId} must not claim a submission time`
      );
    }
    assert.deepStrictEqual(
      document.activities[document.activities.length - 1],
      outcome.record,
      'the submission must be appended after the seeded records, exactly as returned'
    );
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      'the staging file must not survive a successful write'
    );
  });

  it('answers a read from a present valid document rather than from the seed snapshot', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);
    const submittedAt = '2026-09-16T06:14:22.481Z';
    const records = [
      seededRecord('S002', 'Debate Society'),
      submittedRecord('S002', 'Chess Club', submittedAt),
    ];
    await writeBytes(storeFile, `${JSON.stringify(documentOf(records), null, 2)}\n`);

    assert.deepStrictEqual(await store.listActivities('S002'), records);
    assert.deepStrictEqual(
      await store.listActivities('S001'),
      [],
      'a document that exists is taken as complete, so the workbook label for S001 must not appear'
    );
  });

  it('takes a present empty document as complete, so one submission leaves exactly one record', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);
    /* An empty document is VALID, so it suppresses seeding. This is the case
     * that proves a build must never pre-create `activities.json`: doing so
     * would leave the workbook's ten labels out of the store permanently. */
    await writeBytes(storeFile, '{"schemaVersion":1,"activities":[]}');

    const outcome = await store.addActivity('S001', 'Chess Club');

    assert.strictEqual(outcome.created, true);
    const document = await readDocument(storeFile);
    assert.strictEqual(
      document.activities.length,
      1,
      'the submission must be applied to the document as read — no seeding, so one record and not eleven'
    );
    assert.deepStrictEqual(document.activities[0], outcome.record);
  });

  it('refuses a read from an unparseable store and leaves its bytes untouched', async (t) => {
    const context = 'unparseable store, read';
    const { store, storeFile } = await makeIsolatedStore(t);
    const bytes = await writeBytes(storeFile, '{ this is not a document');

    const error = await captureRejection(store.listActivities('S001'), context);

    assertCode(error, E_STORE_UNREADABLE, context);
    await assertBytesUnchanged(storeFile, bytes, context);
  });

  it('refuses a write to an unparseable store and leaves its bytes untouched', async (t) => {
    const context = 'unparseable store, write';
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);
    const bytes = await writeBytes(storeFile, '{ this is not a document');

    const error = await captureRejection(store.addActivity('S001', 'Chess Club'), context);

    assertCode(error, E_STORE_UNREADABLE, context);
    await assertBytesUnchanged(storeFile, bytes, context);
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      'a refused load must fail before anything is staged'
    );
  });

  it('seeds every one of the ten workbook labels as an imported record with no submission time', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);

    for (const [studentId, activity] of EXPECTED_SEED_PAIRS) {
      const records = await store.listActivities(studentId);
      assert.deepStrictEqual(records, [seededRecord(studentId, activity)], `the seed for ${studentId}`);
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(records[0], 'submittedAt'),
        false,
        `the seeded record for ${studentId} must not carry a submittedAt key`
      );
    }

    assert.strictEqual(
      await exists(storeFile),
      false,
      'ten reads of an absent store must still leave it uncreated'
    );
  });
});

/* ========================================================================= *
 * Reference-data failure, and the E_REFERENCE_DATA translation
 *
 * The fourth of the store's four codes. Three claims are asserted here, each
 * of which the feature rests on and none of which any other case in the suite
 * reaches:
 *
 *   1. ANY reader refusal becomes E_REFERENCE_DATA on every public path, with
 *      the original carried as `cause`. `activities.js` maps exactly that one
 *      code onto `500 reference_data_unavailable`, so a reader code arriving
 *      unwrapped would fall straight through the mapping and surface as an
 *      unhandled fault instead of a documented response.
 *   2. Neither cache is populated from a failed read. That is the difference
 *      between a transient workbook fault costing one request and it poisoning
 *      the key set for the whole remaining life of the process. The key set is
 *      what every referential-integrity check consults — the request-time
 *      lookup through `isKnownStudent`, the write guard inside `addActivity`,
 *      and the load check over every record read back — so a cache populated
 *      from a failed read would not weaken one of them, it would weaken all
 *      three at once.
 *   3. Reference data that reads cleanly but cannot serve as a key authority
 *      is refused, rather than quietly shrinking the set every submission is
 *      validated against.
 * ========================================================================= */

describe('reference-data failure and the E_REFERENCE_DATA translation', () => {
  const KEY_COLUMN = columnKey(DETAILS_WORKBOOK_NAME, 'A');
  const SEED_ID_COLUMN = columnKey(OTHER_INFO_WORKBOOK_NAME, 'A');
  const SEED_LABEL_COLUMN = columnKey(OTHER_INFO_WORKBOOK_NAME, 'C');

  const readsOf = (script, key) => script.calls.filter((candidate) => candidate === key).length;

  it('translates a failed key-set read into E_REFERENCE_DATA on all three public paths', async (t) => {
    const context = 'a key-set read that fails';
    const directory = await makeTemporaryDirectory(t);
    const storeFile = path.join(directory, 'activities.json');
    const { store, script } = storeWithScriptedReader(t, storeFile);
    script.failures.set(KEY_COLUMN, () => scriptedReaderRefusal(E_XLSX_TRUNCATED));

    /* `isKnownStudent` is the synchronous membership check a submission's
     * Student ID goes through, which is what forces a key-set read here. */
    const thrown = captureThrow(() => store.isKnownStudent('S001'), `${context} (isKnownStudent)`);
    assertCode(thrown, E_REFERENCE_DATA, `${context} (isKnownStudent)`);
    assert.strictEqual(
      thrown.cause instanceof Error ? thrown.cause.code : undefined,
      E_XLSX_TRUNCATED,
      'the originating reader refusal must travel as `cause`, so a log can name what actually failed'
    );
    assertMessageOmits(
      thrown,
      /[\\/]/u,
      'the refusal must name the workbook rather than a filesystem path, since this message is what a log receives'
    );

    assertCode(
      await captureRejection(store.listActivities('S001'), `${context} (listActivities)`),
      E_REFERENCE_DATA,
      `${context} (listActivities)`
    );
    assertCode(
      await captureRejection(store.addActivity('S001', 'Chess Club'), `${context} (addActivity)`),
      E_REFERENCE_DATA,
      `${context} (addActivity)`
    );

    assert.strictEqual(
      await exists(storeFile),
      false,
      'a reference-data failure must not create the store: there is nothing trustworthy to seed it from'
    );
    assert.strictEqual(
      await exists(storeFile + TEMPORARY_SUFFIX),
      false,
      'nor may it leave a staging file behind'
    );
  });

  it('translates each reader refusal code it is driven with, not merely one', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const { store, script } = storeWithScriptedReader(t, path.join(directory, 'activities.json'));

    /* The store documents that it translates the reader's codes rather than
     * re-exposing them, because every one of them means the same thing here —
     * the reference data cannot be trusted — and a caller acting on
     * E_XLSX_TRUNCATED would be reaching past this module's contract. */
    for (const readerCode of READER_REFUSAL_CODES) {
      const context = `a key-set read refused with ${readerCode}`;
      script.failures.set(KEY_COLUMN, () => scriptedReaderRefusal(readerCode));

      const thrown = captureThrow(() => store.isKnownStudent('S001'), context);

      assertCode(thrown, E_REFERENCE_DATA, context);
      assert.strictEqual(
        thrown.cause instanceof Error ? thrown.cause.code : undefined,
        readerCode,
        `${context}: the reader code must be preserved as the cause`
      );
      assert.notStrictEqual(
        thrown.code,
        readerCode,
        `${context}: the reader code must not be re-exposed as the store's own`
      );
    }

    script.failures.clear();
    assert.strictEqual(
      store.isKnownStudent('S001'),
      true,
      'a run of refused reads must still leave the instance able to answer'
    );
  });

  it('leaves the key-set cache unset after a failure, so the next call re-reads and succeeds', async (t) => {
    const context = 'a key-set read that fails once';
    const directory = await makeTemporaryDirectory(t);
    const { store, script } = storeWithScriptedReader(t, path.join(directory, 'activities.json'));
    script.failures.set(KEY_COLUMN, () => scriptedReaderRefusal(E_XLSX_TRUNCATED));

    assertCode(captureThrow(() => store.isKnownStudent('S001'), context), E_REFERENCE_DATA, context);
    assert.strictEqual(readsOf(script, KEY_COLUMN), 1, 'the failed call attempted exactly one read');

    script.failures.clear();

    assert.strictEqual(
      store.isKnownStudent('S001'),
      true,
      'the SAME instance must recover once the fault clears — no restart, no new module'
    );
    assert.strictEqual(
      readsOf(script, KEY_COLUMN),
      2,
      'the workbook must have been read AGAIN: a cache populated from the failed read would have answered without one'
    );

    /* A successful read is cached for the lifetime of the process, so the
     * answers below cost no further read. */
    assert.strictEqual(store.isKnownStudent('S010'), true);
    assert.strictEqual(store.isKnownStudent('S999'), false);
    assert.strictEqual(
      readsOf(script, KEY_COLUMN),
      2,
      'a successful read is cached for the lifetime of the process, so those two answers cost no further read'
    );
  });

  it('translates a failed seed read into E_REFERENCE_DATA and retries it on the next call', async (t) => {
    const context = 'a seed read that fails';
    const directory = await makeTemporaryDirectory(t);
    const storeFile = path.join(directory, 'activities.json');
    const { store, script } = storeWithScriptedReader(t, storeFile);
    script.failures.set(SEED_LABEL_COLUMN, () => scriptedReaderRefusal(E_XLSX_PART_NOT_FOUND));

    assertCode(
      await captureRejection(store.listActivities('S001'), `${context} (read)`),
      E_REFERENCE_DATA,
      `${context} (read)`
    );
    assertCode(
      await captureRejection(store.addActivity('S001', 'Chess Club'), `${context} (write)`),
      E_REFERENCE_DATA,
      `${context} (write)`
    );
    assert.strictEqual(
      await exists(storeFile),
      false,
      'a store must never be materialised from seed data that could not be read: it would be missing labels for good'
    );

    script.failures.clear();
    const seedReadsBeforeRecovery = readsOf(script, SEED_LABEL_COLUMN);

    assert.deepStrictEqual(
      await store.listActivities('S001'),
      [seededRecord('S001', 'Robotics Club')],
      'the seed snapshot must be read again rather than inherited as an empty snapshot'
    );
    assert.ok(
      readsOf(script, SEED_LABEL_COLUMN) > seedReadsBeforeRecovery,
      'the recovery must involve an actual read of the activity column'
    );
    assert.strictEqual(
      await exists(storeFile),
      false,
      'the recovered read must still not create the store — a read never writes'
    );
  });

  /**
   * Reference data that reads without error but cannot serve as reference
   * data. Each row replaces one column's values; every other column still
   * comes from the real workbook, so one property is under test at a time.
   */
  const UNUSABLE_REFERENCE_DATA = [
    {
      name: 'a key column holding a value that is not a Student ID',
      values: { [KEY_COLUMN]: ['Student ID', 'S001', 'X1'] },
    },
    {
      name: 'a key column repeating a Student ID',
      values: { [KEY_COLUMN]: ['Student ID', 'S001', 'S001'] },
    },
    {
      name: 'a key column holding no Student ID at all',
      values: { [KEY_COLUMN]: ['Student ID', '', ''] },
    },
    {
      name: 'a seed row naming a student absent from the key set',
      values: {
        [SEED_ID_COLUMN]: ['Student ID', 'S999'],
        [SEED_LABEL_COLUMN]: ['Extracurricular Activity', 'Robotics Club'],
      },
    },
    {
      name: 'a seed label that fails normalization',
      values: {
        [SEED_LABEL_COLUMN]: ['Extracurricular Activity', 'C'.repeat(MAX_LABEL_LENGTH + 1)],
      },
    },
    {
      name: 'a seed pair repeated for one student',
      values: {
        [SEED_ID_COLUMN]: ['Student ID', 'S001', 'S001'],
        [SEED_LABEL_COLUMN]: ['Extracurricular Activity', 'Robotics Club', 'robotics   club'],
      },
    },
    /* The three rows below exist because a `.trim()` applied to a cell BEFORE
     * it is validated launders malformed authoritative data into well-formed
     * data: `String.prototype.trim` strips `\n`, `\v`, `\f` and `\r` as well
     * as the horizontal whitespace normalization removes, and every one of
     * those four is a control character the store refuses. So a padded Student
     * ID became a valid Student ID — no ID is trimmed at all, which is why the
     * tab-padded ID below is still refused — and a line-break-only label
     * tested as blank and had its row skipped before the control-character
     * rule could see it.
     *
     * The label row therefore carries a NEWLINE rather than a tab. A tab is
     * horizontal whitespace, so a tab-only cell is genuinely blank and is
     * skipped by the case that follows this loop; a newline is not, and must
     * still be refused.
     *
     * Each row is built so that the LAUNDERED reading would SUCCEED — the key
     * column carries all ten IDs, the seed ID names a student who exists, the
     * seed label belongs to a row whose ID is known — which is what makes the
     * case falsifiable rather than passing on some other refusal. */
    {
      name: 'a key column holding a control-padded Student ID',
      values: {
        [KEY_COLUMN]: ['Student ID', ...EXPECTED_KEY_SET.slice(0, -1), 'S010\n'],
      },
    },
    {
      name: 'a seed ID column holding a control-padded Student ID',
      values: {
        [SEED_ID_COLUMN]: ['Student ID', 'S001\t'],
        [SEED_LABEL_COLUMN]: ['Extracurricular Activity', 'Robotics Club'],
      },
    },
    {
      name: 'a seed row whose label is a line break only',
      values: {
        [SEED_LABEL_COLUMN]: ['Extracurricular Activity', '\n'],
      },
    },
  ];

  for (const scenario of UNUSABLE_REFERENCE_DATA) {
    it(`refuses ${scenario.name}, creating no store`, async (t) => {
      const context = `reference data with ${scenario.name}`;
      const directory = await makeTemporaryDirectory(t);
      const storeFile = path.join(directory, 'activities.json');
      const { store, script } = storeWithScriptedReader(t, storeFile);
      for (const [key, values] of Object.entries(scenario.values)) {
        script.values.set(key, values);
      }

      assertCode(
        await captureRejection(store.listActivities('S001'), context),
        E_REFERENCE_DATA,
        context
      );
      assert.strictEqual(
        await exists(storeFile),
        false,
        `${context}: nothing may be written from reference data that was refused`
      );
      assert.deepStrictEqual(
        await fs.readdir(directory),
        [],
        `${context}: not the store, not a staging file, nothing`
      );
    });
  }

  it('still skips a genuinely empty cell and a horizontal-whitespace-only label, rather than refusing them', async (t) => {
    /* The mirror of the three control-character rows above, and the reason
     * validating as read is not the same as refusing everything unusual. Two
     * kinds of leniency are deliberate and must survive:
     *
     *   1. A GENUINELY EMPTY cell — the empty string the reader yields for a
     *      cell absent from a row inside the declared dimension — is skipped,
     *      because a worksheet may carry empty rows.
     *   2. A label of HORIZONTAL WHITESPACE ONLY is blank, so its row
     *      contributes no record. That is the same class `normalizeLabel`
     *      trims, which is what keeps the blank rule and the normalization
     *      rule from disagreeing about one value — a tab included, since a
     *      tab-only cell would otherwise be refused as an empty label while a
     *      space-only cell was quietly skipped.
     *
     * A trailing empty row is scripted into all three columns at once, so the
     * key authority and the seed pass both meet it. */
    const context = 'reference data with an empty trailing row and whitespace-only labels';
    const directory = await makeTemporaryDirectory(t);
    const storeFile = path.join(directory, 'activities.json');
    const { store, script } = storeWithScriptedReader(t, storeFile);
    script.values.set(KEY_COLUMN, ['Student ID', 'S001', 'S002', 'S003', '']);
    script.values.set(SEED_ID_COLUMN, ['Student ID', 'S001', 'S002', 'S003', '']);
    /* U+00A0 NO-BREAK SPACE, U+0020 SPACE and U+0009 TAB: all horizontal
     * whitespace, none of them a character the store refuses, so both of these
     * cells are blank rather than malformed. */
    script.values.set(SEED_LABEL_COLUMN, [
      'Extracurricular Activity',
      'Robotics Club',
      '\u00a0 ',
      '\t\t',
      '',
    ]);

    assert.strictEqual(
      store.isKnownStudent('S002'),
      true,
      `${context}: the empty trailing cell must be skipped, not refused — the key set must still hold every ID`
    );
    assert.deepStrictEqual(
      await store.listActivities('S001'),
      [seededRecord('S001', 'Robotics Club')],
      `${context}: the one row carrying a real label must still seed its record`
    );
    assert.deepStrictEqual(
      await store.listActivities('S002'),
      [],
      `${context}: a space-separator-only label records nothing, and must not refuse the whole read`
    );
    assert.deepStrictEqual(
      await store.listActivities('S003'),
      [],
      `${context}: a tab-only label is blank for the same reason, and must not refuse the whole read either`
    );
    assert.deepStrictEqual(
      await fs.readdir(directory),
      [],
      `${context}: a read still writes nothing`
    );
  });

  it('passes every read through when nothing is scripted, so the seam cannot mask a fault', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const storeFile = path.join(directory, 'activities.json');
    const { store, script } = storeWithScriptedReader(t, storeFile);

    assert.strictEqual(store.isKnownStudent('S001'), true);
    assert.deepStrictEqual(await store.listActivities('S008'), [
      seededRecord('S008', 'Photography Club'),
    ]);
    const outcome = await store.addActivity('S008', 'Chess Club');

    assert.strictEqual(outcome.created, true);
    assert.strictEqual((await readDocument(storeFile)).activities.length, EXPECTED_SEED_PAIRS.length + 1);

    /* The exact read pattern, which is also the documented caching contract:
     * the key column once, the two seed columns once each, and nothing more —
     * the submission that followed re-read neither workbook. */
    assert.deepStrictEqual(
      script.calls,
      [KEY_COLUMN, SEED_ID_COLUMN, SEED_LABEL_COLUMN],
      'each workbook column is read exactly once per process, in this order'
    );
  });
});

/* ========================================================================= *
 * Normalization
 *
 * `normalizeLabel` is pure and touches no file, so this group shares the
 * bootstrap instance. The store file behind it is never written here — the
 * one case that needs a round trip takes its own isolated store.
 *
 * ON TAB AND NEWLINE, because it is the one place where two rules meet:
 * whitespace is trimmed and collapsed, AND a control character is refused. A
 * tab is arguably both, so the module draws the line at HORIZONTAL
 * whitespace: the Unicode SPACE SEPARATOR category plus U+0009 TAB is
 * trimmed and collapsed, and everything left — a newline, a carriage return,
 * a vertical tab, NUL, DEL, the C1 block, U+2028 and U+2029 — is then
 * refused. The steps run in that order, which is what stops the two rules
 * cancelling each other out: a tab is laundered into a space and the label is
 * accepted, while nothing that BREAKS A LINE is ever laundered, because two
 * visually identical labels would then dedupe differently depending on which
 * character separated their words.
 *
 * The cases below therefore pin a tab as a COLLAPSE at every position, pin a
 * tab-only label as empty rather than as a control character, keep every
 * non-tab control character and both line separators as refusals, and
 * exercise the collapse of a mixed run — U+0020, U+0009, U+00A0 and U+2003
 * together.
 * ========================================================================= */

describe('activity label normalization', () => {
  it('trims leading and trailing whitespace', () => {
    assert.strictEqual(bootstrapStore.normalizeLabel('  Chess Club  '), 'Chess Club');
    assert.strictEqual(bootstrapStore.normalizeLabel('Chess Club  '), 'Chess Club');
    assert.strictEqual(bootstrapStore.normalizeLabel('  Chess Club'), 'Chess Club');
    assert.strictEqual(
      bootstrapStore.normalizeLabel('\u00a0\u2003Chess Club\u2003\u00a0'),
      'Chess Club',
      'a non-breaking space and an em space are space separators, so they trim like a plain space'
    );
  });

  it('collapses every internal run of whitespace to a single space', () => {
    assert.strictEqual(bootstrapStore.normalizeLabel('Robotics   Club'), 'Robotics Club');
    assert.strictEqual(
      bootstrapStore.normalizeLabel('Robotics \u00a0 \u2003 Club'),
      'Robotics Club',
      'a mixed run of space separators collapses to exactly one space'
    );
    assert.strictEqual(
      bootstrapStore.normalizeLabel('  Inter   College   Quiz  '),
      'Inter College Quiz',
      'trimming and collapsing apply together, and every run collapses'
    );
  });

  it('collapses a tab as horizontal whitespace, at every position it can occupy', () => {
    /* A tab is horizontal whitespace and nothing else inside a single-line
     * label, so it trims and collapses exactly as a space does. This is the
     * case that separates the two candidate readings of the rule: were the
     * tab left in the control-character class it would survive the collapse
     * and be refused, and `Chess<TAB>Club` and `Chess Club` would be two
     * activities instead of one. Each position is exercised because trimming
     * and collapsing are two different steps. */
    assert.strictEqual(
      bootstrapStore.normalizeLabel('Robotics\tClub'),
      'Robotics Club',
      'an internal tab collapses to a single space'
    );
    assert.strictEqual(
      bootstrapStore.normalizeLabel('\tRobotics Club'),
      'Robotics Club',
      'a leading tab is trimmed'
    );
    assert.strictEqual(
      bootstrapStore.normalizeLabel('Robotics Club\t'),
      'Robotics Club',
      'a trailing tab is trimmed'
    );
    assert.strictEqual(
      bootstrapStore.normalizeLabel('Robotics\t\t\tClub'),
      'Robotics Club',
      'a run of tabs collapses to exactly one space'
    );
    assert.strictEqual(
      bootstrapStore.normalizeLabel('\t Robotics \t\u00a0 \u2003Club \t'),
      'Robotics Club',
      'a mixed run of tabs and space separators collapses to one ASCII space, and trims'
    );
    /* Casing is untouched by the collapse, and the composite key folds case,
     * so the tab form and the plain form are the same activity. */
    assert.strictEqual(
      bootstrapStore.normalizeLabel('robotics\tCLUB').toLowerCase(),
      bootstrapStore.normalizeLabel('Robotics Club').toLowerCase(),
      'the tab form and the plain form normalize to one composite key'
    );
  });

  it('refuses a tab-only label as empty, not as a control character', () => {
    /* The consequence of the rule above that is worth its own case: once a
     * tab is whitespace, a label of nothing but tabs normalizes to the empty
     * string, so it is refused by the emptiness rule rather than the
     * control-character rule. Both refuse it; naming which one keeps the
     * message a submitter reads honest. */
    const context = 'a label of tabs only';
    const error = captureThrow(() => bootstrapStore.normalizeLabel('\t\t'), context);
    assertCode(error, E_LABEL_INVALID, context);
    assertMessageMentions(
      error,
      /empty/,
      'the refusal must name the emptiness rule, since the tab was removed before anything could refuse it'
    );
  });

  it('refuses every C0 except TAB, plus DEL and every C1 control character, at the start, mid-string and at the end', () => {
    /* The complete ranges the store's pattern declares, generated rather than
     * sampled. A handful of representatives cannot show that the boundaries
     * sit where they are claimed to: it is the characters nobody thinks of —
     * U+000B, U+0085, U+009F — that a narrowed class would start admitting.
     *
     * U+0009 TAB is the ONE hole in C0, and it is generated out rather than
     * quietly omitted so the hole is exactly one code point wide and is
     * visible as a deliberate exclusion. The two cases above pin what a tab
     * does instead, and `HORIZONTAL_WHITESPACE` below pins that its C0
     * neighbours U+0008 and U+000A are not treated like it. */
    const TAB = 0x0009;
    const CONTROL_CHARACTER_RANGES = [
      [0x0000, 0x001f, 'C0'],
      [0x007f, 0x007f, 'DEL'],
      [0x0080, 0x009f, 'C1'],
    ];
    const controlCharacters = [];
    for (const [first, last, block] of CONTROL_CHARACTER_RANGES) {
      for (let codePoint = first; codePoint <= last; codePoint += 1) {
        if (codePoint === TAB) {
          continue;
        }
        const name = `${block} U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
        controlCharacters.push([String.fromCodePoint(codePoint), name]);
      }
    }
    assert.strictEqual(
      controlCharacters.length,
      64,
      'the generated set must be C0 less TAB (31) plus DEL (1) plus C1 (32)'
    );
    assert.ok(
      !controlCharacters.some(([character]) => character === '\t'),
      'and it must not contain the tab, which normalization collapses rather than refuses'
    );

    for (const [character, name] of controlCharacters) {
      /* Three placements, because trimming and collapsing run BEFORE the
       * control-character check and act on horizontal whitespace alone. A
       * leading or trailing control character therefore has to survive the
       * trim and then be refused; were the trim widened to a general
       * whitespace class it would strip `\n`, `\r`, `\v` and `\f` instead,
       * and the refusal would quietly stop applying at exactly the two
       * positions where a pasted value carries one. */
      for (const [placement, label] of [
        ['at the start', `${character}Chess Club`],
        ['mid-string', `Chess${character}Club`],
        ['at the end', `Chess Club${character}`],
      ]) {
        const context = `${name} ${placement}`;
        assertCode(
          captureThrow(() => bootstrapStore.normalizeLabel(label), context),
          E_LABEL_INVALID,
          context
        );
      }
    }

    /* The immediate neighbours of all three boundaries are ACCEPTED, so the
     * case pins the edges rather than merely refusing a large set: U+0020 sits
     * one above C0, U+007E one below DEL, U+00A1 one above C1, and U+00A0 —
     * also one above C1 — is a space separator, so normalization collapses it
     * instead of refusing it. U+0009 is the interior exclusion, and it
     * collapses for the same reason U+0020 does. */
    assert.strictEqual(bootstrapStore.normalizeLabel('Chess\u0020Club'), 'Chess Club');
    assert.strictEqual(bootstrapStore.normalizeLabel('Chess\u0009Club'), 'Chess Club');
    assert.strictEqual(bootstrapStore.normalizeLabel('Chess\u007eClub'), 'Chess~Club');
    assert.strictEqual(bootstrapStore.normalizeLabel('Chess\u00a1Club'), 'Chess\u00a1Club');
    assert.strictEqual(bootstrapStore.normalizeLabel('Chess\u00a0Club'), 'Chess Club');

    /* And the tab's own C0 neighbours, one on each side, so the hole cannot
     * silently widen: U+0008 BACKSPACE and U+000A LINE FEED are both refused
     * where U+0009 between them is collapsed. */
    for (const [character, name] of [
      ['\u0008', 'U+0008 BACKSPACE, one below TAB'],
      ['\u000a', 'U+000A LINE FEED, one above TAB'],
    ]) {
      assertCode(
        captureThrow(() => bootstrapStore.normalizeLabel(`Chess${character}Club`), name),
        E_LABEL_INVALID,
        name
      );
    }
  });

  it('refuses a Unicode line separator rather than laundering it into a space', () => {
    /* U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are line
     * terminators with their own Unicode categories (Zl and Zp), so they are
     * neither space separators to collapse nor characters a single-line label
     * may carry. Left unhandled they would survive normalization untouched,
     * persist, and produce a composite key distinct from the same label
     * written with a space — which is the deduplication rule defeated by an
     * invisible character. Each position is exercised because trimming,
     * collapsing and rejection are three different steps. */
    const separators = [
      ['\u2028', 'LINE SEPARATOR'],
      ['\u2029', 'PARAGRAPH SEPARATOR'],
    ];
    for (const [character, name] of separators) {
      const labels = [
        [`${character}Chess Club`, 'leading'],
        [`Chess Club${character}`, 'trailing'],
        [`Chess${character}Club`, 'internal'],
        [`Chess ${character} Club`, 'inside a space run'],
      ];
      for (const [label, position] of labels) {
        const context = `a ${name} ${position} in a label`;
        const error = captureThrow(() => bootstrapStore.normalizeLabel(label), context);
        assertCode(error, E_LABEL_INVALID, context);
        assert.match(
          error.message,
          /control character|line separator/,
          `${context}: the refusal must name the rule that rejected it`
        );
      }
    }
  });

  it('never persists a line separator, so it cannot become a distinct composite key', async (t) => {
    const context = 'a submission whose label carries a LINE SEPARATOR';
    const { store, storeFile } = await makeIsolatedStore(t, 'line-separator.json');
    /* `addActivity` inspects the label again rather than trusting it, which
     * is what makes the refusal reachable even if a caller skipped
     * `normalizeLabel`. Nothing may be written: the store must still not
     * exist afterwards. */
    const error = await captureRejection(store.addActivity('S001', 'Chess\u2028Club'), context);

    assertCode(error, E_LABEL_INVALID, context);
    assert.strictEqual(
      await exists(storeFile),
      false,
      'a refused label must not have materialized the store'
    );
    assert.deepStrictEqual(
      await store.listActivities('S001'),
      [seededRecord('S001', 'Robotics Club')],
      'the only record for S001 must still be the seeded one'
    );
  });

  it('measures the sixty-character bound in UTF-16 code units, as the intake form does', () => {
    /* The form carries `maxlength="60"`, which the browser evaluates in UTF-16
     * code units. Counting code points on the server instead would accept
     * over the JSON API a label the native form refuses to submit — one bound
     * with two answers. An astral character is the case that distinguishes
     * them: it is one code point and two code units. */
    const astralCharacter = '\u{1f680}';
    assert.strictEqual(astralCharacter.length, 2, 'an astral character is two code units');
    assert.strictEqual(Array.from(astralCharacter).length, 1, 'and one code point');

    const atTheBound = astralCharacter.repeat(MAX_LABEL_LENGTH / 2);
    assert.strictEqual(atTheBound.length, MAX_LABEL_LENGTH);
    assert.strictEqual(
      bootstrapStore.normalizeLabel(atTheBound),
      atTheBound,
      'sixty code units of astral characters is exactly at the bound and must be accepted'
    );

    const overTheBound = astralCharacter.repeat(MAX_LABEL_LENGTH / 2 + 1);
    assert.strictEqual(overTheBound.length, MAX_LABEL_LENGTH + 2);
    assert.strictEqual(
      Array.from(overTheBound).length,
      MAX_LABEL_LENGTH / 2 + 1,
      'thirty-one code points — a code-point rule would have accepted this, and the form would not'
    );

    const context = 'a label of thirty-one astral characters';
    const error = captureThrow(() => bootstrapStore.normalizeLabel(overTheBound), context);
    assertCode(error, E_LABEL_INVALID, context);
    assert.match(error.message, /60/, 'the refusal must name the bound it enforced');
    assert.match(
      error.message,
      /62/,
      'and the count it measured, which is the code-unit length the form would have reported'
    );
  });

  it('accepts a label of exactly sixty characters and refuses one of sixty-one', () => {
    const atTheBound = 'C'.repeat(MAX_LABEL_LENGTH);
    assert.strictEqual(bootstrapStore.normalizeLabel(atTheBound), atTheBound);
    assert.strictEqual(bootstrapStore.normalizeLabel(atTheBound).length, MAX_LABEL_LENGTH);

    const context = 'a label one character over the bound';
    const error = captureThrow(
      () => bootstrapStore.normalizeLabel('C'.repeat(MAX_LABEL_LENGTH + 1)),
      context
    );
    assertCode(error, E_LABEL_INVALID, context);
    assertMessageMentions(error, /60/, 'the refusal must name the bound it enforced');
  });

  it('refuses a whitespace-only label, which normalizes to empty', () => {
    /* `'\t'` and `'\t \u00a0'` belong in this list rather than in the
     * control-character one: a tab is horizontal whitespace, so a label made
     * of nothing else has no content left once it is trimmed. */
    for (const raw of ['', ' ', '   ', '\u00a0\u2003', '\t', '\t\t', '\t \u00a0']) {
      const context = `a whitespace-only label ${JSON.stringify(raw)}`;
      assertCode(captureThrow(() => bootstrapStore.normalizeLabel(raw), context), E_LABEL_INVALID, context);
    }
  });

  it('measures the length after normalization, so padding past sixty characters is still accepted', () => {
    /* Raw length 80, normalized length 60. If the bound were checked before
     * normalization this would be refused, so the case pins the order. */
    const padded = `${' '.repeat(10)}${'C'.repeat(MAX_LABEL_LENGTH)}${' '.repeat(10)}`;
    assert.strictEqual(padded.length, MAX_LABEL_LENGTH + 20);

    const normalized = bootstrapStore.normalizeLabel(padded);

    assert.strictEqual(normalized.length, MAX_LABEL_LENGTH);
    assert.strictEqual(normalized, 'C'.repeat(MAX_LABEL_LENGTH));
  });

  it('collapses an internal run before measuring, so a padded run does not exceed the bound', () => {
    /* Sixty characters of content separated by a nine-space run: raw length 69,
     * normalized length 60. Only collapsing first keeps it inside the bound. */
    const raw = `${'C'.repeat(30)}${' '.repeat(10)}${'C'.repeat(29)}`;
    assert.strictEqual(raw.length, MAX_LABEL_LENGTH + 9);

    const normalized = bootstrapStore.normalizeLabel(raw);

    assert.strictEqual(normalized, `${'C'.repeat(30)} ${'C'.repeat(29)}`);
    assert.strictEqual(normalized.length, MAX_LABEL_LENGTH);
  });

  it('refuses a label that is not a string', () => {
    for (const raw of [undefined, null, 42, true, {}, [], Symbol('x')]) {
      const context = `a label of type ${typeof raw}`;
      assertCode(captureThrow(() => bootstrapStore.normalizeLabel(raw), context), E_LABEL_INVALID, context);
    }
  });

  it('preserves the submitted casing in the value returned and in the stored record', async (t) => {
    assert.strictEqual(bootstrapStore.normalizeLabel('Chess Club'), 'Chess Club');
    assert.strictEqual(bootstrapStore.normalizeLabel('cHeSs cLuB'), 'cHeSs cLuB');

    const { store, storeFile } = await makeIsolatedStore(t);
    const label = store.normalizeLabel('  cHeSs   cLuB  ');
    assert.strictEqual(label, 'cHeSs cLuB', 'normalization must not change case');

    const outcome = await store.addActivity('S001', label);

    assert.strictEqual(outcome.record.activity, 'cHeSs cLuB');
    const document = await readDocument(storeFile);
    const stored = document.activities.find((record) => record.source === SOURCE_SUBMISSION);
    assert.strictEqual(
      stored.activity,
      'cHeSs cLuB',
      'the store keeps the label as typed; case is folded only for the composite-key comparison'
    );
  });
});


/* ========================================================================= *
 * The composite primary key
 *
 * The store's key is `(studentId, normalized label)`, compared
 * case-insensitively. `studentId` alone is the FOREIGN key into
 * `student_details.xlsx` and cannot be the store's own key, because a student
 * holds many activities — the plural the single-valued workbook column cannot
 * represent. Both halves of that claim are asserted: the same label for two
 * students is two records, and two labels for one student is two records.
 * ========================================================================= */

describe('the composite primary key and idempotent submission', () => {
  it('appends exactly one record for a new composite key and reports it as created', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);

    const outcome = await store.addActivity('S001', 'Chess Club');

    assert.strictEqual(outcome.created, true);
    const document = await readDocument(storeFile);
    const forStudent = document.activities.filter((record) => record.studentId === 'S001');
    assert.strictEqual(
      forStudent.length,
      2,
      'the seeded Robotics Club plus exactly one appended Chess Club'
    );
    assert.strictEqual(
      document.activities.filter((record) => record.activity === 'Chess Club').length,
      1
    );
  });

  it('recognizes an exact repeat, writes nothing, and returns the original submission time', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);
    const first = await store.addActivity('S001', 'Chess Club');
    const bytesAfterFirst = await fs.readFile(storeFile);

    const repeat = await store.addActivity('S001', 'Chess Club');

    assert.strictEqual(repeat.created, false, 'a repeated composite key must not be created again');
    assert.deepStrictEqual(
      repeat.record,
      first.record,
      'the record returned must be the one already stored, with its original submittedAt'
    );
    assert.strictEqual(
      repeat.record.submittedAt,
      first.record.submittedAt,
      'a repeat must not refresh the submission time'
    );
    await assertBytesUnchanged(storeFile, bytesAfterFirst, 'an idempotent repeat');
  });

  it('treats a case variant as the same composite key', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);
    const first = await store.addActivity('S001', 'Chess Club');
    const bytesAfterFirst = await fs.readFile(storeFile);

    const variant = await store.addActivity('S001', store.normalizeLabel('chess club'));

    assert.strictEqual(variant.created, false, 'comparison is case-insensitive');
    assert.strictEqual(
      variant.record.activity,
      'Chess Club',
      'the stored casing is returned, not the casing just submitted'
    );
    assert.strictEqual(variant.record.submittedAt, first.record.submittedAt);
    await assertBytesUnchanged(storeFile, bytesAfterFirst, 'a case variant');
  });

  it('treats a whitespace variant as the same composite key once normalized', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);
    await store.addActivity('S001', 'Chess Club');
    const bytesAfterFirst = await fs.readFile(storeFile);

    const variant = await store.addActivity('S001', store.normalizeLabel('  Chess   Club  '));

    assert.strictEqual(variant.created, false);
    assert.strictEqual(variant.record.activity, 'Chess Club');
    await assertBytesUnchanged(storeFile, bytesAfterFirst, 'a whitespace variant');
  });

  it('treats the same label for a different student as a different composite key', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);

    const first = await store.addActivity('S001', 'Chess Club');
    const second = await store.addActivity('S002', 'Chess Club');

    assert.strictEqual(first.created, true);
    assert.strictEqual(
      second.created,
      true,
      'studentId participates in the key, so the same label for another student is a new record'
    );
    const document = await readDocument(storeFile);
    const chessRecords = document.activities.filter((record) => record.activity === 'Chess Club');
    assert.strictEqual(chessRecords.length, 2);
    assert.deepStrictEqual(
      chessRecords.map((record) => record.studentId).sort(),
      ['S001', 'S002']
    );
  });

  it('lets one student hold many activities, which the workbook column cannot represent', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);

    const chess = await store.addActivity('S001', 'Chess Club');
    const quiz = await store.addActivity('S001', 'Quiz Club');

    assert.strictEqual(chess.created, true);
    assert.strictEqual(quiz.created, true);

    const records = await store.listActivities('S001');
    assert.deepStrictEqual(
      records.map((record) => record.activity),
      ['Robotics Club', 'Chess Club', 'Quiz Club'],
      'the seeded label plus both submissions, in document order'
    );
    assert.deepStrictEqual(
      records.map((record) => record.source),
      [SOURCE_WORKBOOK, SOURCE_SUBMISSION, SOURCE_SUBMISSION]
    );

    const document = await readDocument(storeFile);
    assert.strictEqual(document.activities.filter((record) => record.studentId === 'S001').length, 3);
  });

  it('recognizes a label that duplicates a seeded record and keeps it distinguishable from a submission', async (t) => {
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);

    const outcome = await store.addActivity('S001', 'Robotics Club');

    assert.strictEqual(outcome.created, false, 'the seeded composite key already exists');
    assert.deepStrictEqual(
      outcome.record,
      seededRecord('S001', 'Robotics Club'),
      'an import must stay marked as an import rather than being rewritten as a submission'
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(outcome.record, 'submittedAt'),
      false,
      'no submission time may be invented for a record that came from the workbook'
    );
    assert.strictEqual(
      await exists(storeFile),
      false,
      'nothing changed, so the store is still not created — seeding it would write a document nobody asked to change'
    );
    assert.strictEqual(await exists(temporaryFile), false);
  });

  it('recognizes a case variant of a seeded record without creating the store', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);

    const outcome = await store.addActivity('S008', store.normalizeLabel('photography   CLUB'));

    assert.strictEqual(outcome.created, false);
    assert.deepStrictEqual(outcome.record, seededRecord('S008', 'Photography Club'));
    assert.strictEqual(await exists(storeFile), false);
  });

  it('refuses a submission for a student who does not exist, so no record can orphan', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);

    /* The Student ID link is enforced in code and nowhere else: no workbook
     * declares a key and JSON carries no constraint. A write for an unknown
     * student would produce a document the loader then refuses forever. */
    const unknown = await captureRejection(
      store.addActivity('S999', 'Chess Club'),
      'a submission for an unknown student'
    );
    assert.ok(
      unknown instanceof RangeError,
      `a well-formed but unknown Student ID must be a RangeError, received ${unknown.constructor.name}`
    );

    const malformed = await captureRejection(
      store.addActivity('s1', 'Chess Club'),
      'a submission with a malformed Student ID'
    );
    assert.ok(
      malformed instanceof TypeError,
      `a malformed Student ID must be a TypeError, received ${malformed.constructor.name}`
    );

    assert.strictEqual(await exists(storeFile), false, 'neither refusal may create the store');
  });
});


/* ========================================================================= *
 * Load validation
 *
 * Every invariant the record shape declares is enforced on LOAD, not only at
 * submission time, because the store is a plain file a person can edit and
 * "we only ever write it correctly" says nothing about what is read back. A
 * version marker with nothing enforcing it is decoration.
 *
 * Each row below is one condition, and each is asserted three ways: the read
 * path refuses it, the write path refuses it, and the file is left
 * byte-identical — a loader could refuse a document and still have damaged
 * it, and "it threw" is not evidence that it did not.
 * ========================================================================= */

const VALID_STAMP = '2026-09-16T06:14:22.481Z';

function bodyOf(activities) {
  return `${JSON.stringify(documentOf(activities), null, 2)}\n`;
}

function rawBody(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function baseSubmission(overrides = {}) {
  return {
    studentId: 'S001',
    activity: 'Chess Club',
    source: SOURCE_SUBMISSION,
    submittedAt: VALID_STAMP,
    ...overrides,
  };
}

function baseImport(overrides = {}) {
  return { studentId: 'S001', activity: 'Robotics Club', source: SOURCE_WORKBOOK, ...overrides };
}

/**
 * Copies a record without one key, so "the field is absent" is distinct from
 * "the field is present and undefined" — `JSON.stringify` drops an undefined
 * value, but the distinction matters for how the case reads.
 *
 * @param {Object} record The record to copy.
 * @param {string} key The key to drop.
 * @returns {Object} The copy.
 */
function without(record, key) {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/**
 * Copies a record and gives it an OWN `__proto__` key.
 *
 * An object literal cannot express this — `{ __proto__: 'x' }` sets the
 * prototype instead — but `JSON.parse` can, and does: it defines `__proto__`
 * as an ordinary own enumerable property. So a hand-edited document can carry
 * one, `Object.keys` sees it, and the loader has to refuse it like any other
 * unrecognized key. `defineProperty` is what makes `JSON.stringify` emit it.
 *
 * @param {Object} record The record to copy.
 * @returns {Object} The copy, carrying an own `__proto__` key.
 */
function withOwnProtoKey(record) {
  const copy = { ...record };
  Object.defineProperty(copy, '__proto__', {
    value: 'injected',
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return copy;
}

/**
 * One row per condition the loader is contracted to detect. `body` is the
 * exact bytes placed on disk — a string, or a Buffer where the point of the
 * case is that the bytes are not decodable at all.
 */
const MALFORMED_STORE_DOCUMENTS = [
  /* --- The bytes and the outer document ---------------------------------- */
  {
    name: 'bytes that are not valid UTF-8',
    /* 0xff cannot appear in a UTF-8 sequence, so strict decoding refuses it
     * rather than substituting a replacement character. */
    body: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
  },
  { name: 'valid UTF-8 that is not parseable JSON', body: '{ "schemaVersion": 1, ' },
  { name: 'a document that is JSON null', body: 'null' },
  { name: 'a document that is a JSON array', body: '[]' },
  { name: 'a document that is a bare number', body: '42' },

  /* --- schemaVersion ----------------------------------------------------- */
  { name: 'a missing schemaVersion', body: rawBody({ activities: [] }) },
  { name: 'a schemaVersion that is a string', body: rawBody({ schemaVersion: '1', activities: [] }) },
  {
    name: 'a schemaVersion from a future build',
    body: rawBody({ schemaVersion: 2, activities: [] }),
  },

  /* --- activities -------------------------------------------------------- */
  { name: 'a missing activities array', body: rawBody({ schemaVersion: SCHEMA_VERSION }) },
  {
    name: 'an activities value that is an object rather than an array',
    body: rawBody({ schemaVersion: SCHEMA_VERSION, activities: {} }),
  },
  { name: 'a record that is a bare string', body: bodyOf(['Chess Club']) },
  { name: 'a record that is null', body: bodyOf([null]) },
  { name: 'a record that is an array', body: bodyOf([[]]) },

  /* --- studentId, the foreign key into the identity workbook ------------- */
  { name: 'a studentId that is a number', body: bodyOf([baseSubmission({ studentId: 1 })]) },
  {
    name: 'a studentId missing its zero padding',
    body: bodyOf([baseSubmission({ studentId: 'S1' })]),
  },
  { name: 'a studentId in lower case', body: bodyOf([baseSubmission({ studentId: 's001' })]) },
  { name: 'a studentId with four digits', body: bodyOf([baseSubmission({ studentId: 'S0012' })]) },
  {
    name: 'a well-formed studentId that is absent from the key set',
    body: bodyOf([baseSubmission({ studentId: 'S999' })]),
  },

  /* --- activity ---------------------------------------------------------- */
  { name: 'an activity that is a number', body: bodyOf([baseSubmission({ activity: 42 })]) },
  { name: 'an activity that is an empty string', body: bodyOf([baseSubmission({ activity: '' })]) },
  {
    name: 'an activity longer than sixty characters',
    body: bodyOf([baseSubmission({ activity: 'C'.repeat(MAX_LABEL_LENGTH + 1) })]),
  },
  {
    name: 'an activity containing a control character',
    body: bodyOf([baseSubmission({ activity: 'Chess\nClub' })]),
  },
  {
    /* A tab is not refused on submission — normalization collapses it — so a
     * stored label carrying one cannot have been written by this service. It
     * is refused on load all the same, as a value that is not in normalized
     * form, which is what keeps the loader's guarantee that every stored
     * label is already normalized true for the tab as well. */
    name: 'an activity containing an uncollapsed tab',
    body: bodyOf([baseSubmission({ activity: 'Chess\tClub' })]),
  },
  {
    /* A store written by this service can never hold one: the normalizer
     * refuses it on submission. Its presence therefore means a hand-edit, and
     * accepting it would let an invisible line break split one activity into
     * two composite keys. */
    name: 'an activity containing a Unicode line separator',
    body: bodyOf([baseSubmission({ activity: 'Chess\u2028Club' })]),
  },
  {
    name: 'an activity containing a Unicode paragraph separator',
    body: bodyOf([baseSubmission({ activity: 'Chess\u2029Club' })]),
  },
  {
    name: 'an activity of thirty-one astral characters, which is sixty-two code units',
    body: bodyOf([baseSubmission({ activity: '\u{1f680}'.repeat(MAX_LABEL_LENGTH / 2 + 1) })]),
  },
  {
    name: 'an activity with an uncollapsed internal whitespace run',
    body: bodyOf([baseSubmission({ activity: 'Chess  Club' })]),
  },
  {
    name: 'an activity with leading whitespace',
    body: bodyOf([baseSubmission({ activity: ' Chess Club' })]),
  },
  {
    name: 'an activity with trailing whitespace',
    body: bodyOf([baseSubmission({ activity: 'Chess Club ' })]),
  },

  /* --- source and submittedAt, the provenance pair ----------------------- */
  {
    name: 'a source that is neither submission nor workbook',
    body: bodyOf([baseSubmission({ source: 'import' })]),
  },
  { name: 'a missing source', body: bodyOf([without(baseSubmission(), 'source')]) },
  {
    name: 'a submission with no submittedAt',
    body: bodyOf([without(baseSubmission(), 'submittedAt')]),
  },
  {
    name: 'a submission whose submittedAt is a number',
    body: bodyOf([baseSubmission({ submittedAt: 1758003262481 })]),
  },
  {
    name: 'a submission whose submittedAt is not an instant at all',
    body: bodyOf([baseSubmission({ submittedAt: 'yesterday' })]),
  },
  {
    name: 'a submission whose submittedAt carries a timezone offset rather than UTC',
    body: bodyOf([baseSubmission({ submittedAt: '2026-09-16T06:14:22+01:00' })]),
  },
  {
    name: 'a submission whose submittedAt names an impossible calendar date',
    /* `Date.parse` accepts this and silently rolls it forward to March, so
     * only a component comparison catches it. */
    body: bodyOf([baseSubmission({ submittedAt: '2026-02-31T00:00:00Z' })]),
  },
  {
    name: 'an imported record that claims a submission time',
    body: bodyOf([baseImport({ submittedAt: VALID_STAMP })]),
  },

  /* --- the composite key ------------------------------------------------- */
  {
    name: 'two records sharing a composite key exactly',
    body: bodyOf([baseSubmission(), baseSubmission({ submittedAt: '2026-09-16T07:00:00.000Z' })]),
  },
  {
    name: 'two records sharing a composite key but for the label casing',
    body: bodyOf([baseSubmission(), baseSubmission({ activity: 'chess club' })]),
  },
  {
    name: 'two records sharing a composite key across different provenance',
    body: bodyOf([baseImport(), baseImport({ source: SOURCE_SUBMISSION, submittedAt: VALID_STAMP })]),
  },

  /* --- keys the shape does not declare -----------------------------------
   *
   * The document is rewritten WHOLE in canonical form on every change, so a
   * key the shape does not declare cannot be preserved. Reading it and
   * dropping it would therefore let the next submission erase a hand-edited
   * field silently, which is why the loader refuses the document instead. */
  {
    name: 'an unexpected top-level key beside schemaVersion and activities',
    body: rawBody({ schemaVersion: SCHEMA_VERSION, activities: [], notes: 'hand-written' }),
  },
  {
    name: 'an unexpected key on an otherwise entirely valid record',
    body: bodyOf([baseSubmission({ reviewedBy: 'registrar' })]),
  },
  {
    name: 'an unexpected key on an otherwise valid imported record',
    body: bodyOf([baseImport({ importedFrom: 'student_other_info.xlsx' })]),
  },
  {
    name: 'a record key of __proto__, which JSON.parse makes an ordinary own key',
    body: bodyOf([withOwnProtoKey(baseSubmission())]),
  },
];

describe('load validation of a hand-edited store', () => {
  for (const scenario of MALFORMED_STORE_DOCUMENTS) {
    it(`refuses a store holding ${scenario.name}, on both paths, without touching the file`, async (t) => {
      const context = `a store holding ${scenario.name}`;
      const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);
      const bytes = await writeBytes(storeFile, scenario.body);

      const readError = await captureRejection(store.listActivities('S001'), `${context} (read)`);
      assertCode(readError, E_STORE_UNREADABLE, `${context} (read)`);
      await assertBytesUnchanged(storeFile, bytes, `${context} (read)`);

      const writeError = await captureRejection(
        store.addActivity('S002', 'Quiz Club'),
        `${context} (write)`
      );
      assertCode(writeError, E_STORE_UNREADABLE, `${context} (write)`);
      await assertBytesUnchanged(storeFile, bytes, `${context} (write)`);
      assert.strictEqual(
        await exists(temporaryFile),
        false,
        `${context}: a refused load must fail before anything is staged`
      );
    });
  }

  it('loads a valid document cleanly, so the group cannot pass by refusing everything', async (t) => {
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);
    const records = [baseImport(), baseSubmission({ studentId: 'S002' })];
    await writeBytes(storeFile, bodyOf(records));

    assert.deepStrictEqual(await store.listActivities('S001'), [baseImport()]);
    assert.deepStrictEqual(await store.listActivities('S002'), [
      baseSubmission({ studentId: 'S002' }),
    ]);

    const outcome = await store.addActivity('S003', 'Quiz Club');

    assert.strictEqual(outcome.created, true);
    const document = await readDocument(storeFile);
    assert.strictEqual(document.schemaVersion, SCHEMA_VERSION);
    assert.strictEqual(document.activities.length, 3);
    assert.strictEqual(await exists(temporaryFile), false);
  });

  it('refuses a duplicate rather than silently deduplicating it, so a person resolves the edit', async (t) => {
    /* The distinction matters: dropping one of the two would destroy a
     * hand-edit nobody reviewed, and the service never writes this state, so
     * its presence always means a person edited the file. */
    const context = 'a store holding a duplicate composite key';
    const { store, storeFile } = await makeIsolatedStore(t);
    const bytes = await writeBytes(
      storeFile,
      bodyOf([baseSubmission(), baseSubmission({ activity: 'CHESS CLUB' })])
    );

    const error = await captureRejection(store.listActivities('S001'), context);

    assertCode(error, E_STORE_UNREADABLE, context);
    assertMessageMentions(
      error,
      /composite key/,
      'the refusal must name the composite key so the reader knows which rule failed'
    );
    await assertBytesUnchanged(storeFile, bytes, context);
    const document = await readDocument(storeFile);
    assert.strictEqual(
      document.activities.length,
      2,
      'both records must still be present — nothing may be deduplicated automatically'
    );
  });

  it('names the unexpected key it refused, at the document level and on a record', async (t) => {
    /* The key is what a person has to find in order to move the data
     * somewhere the store will not erase it, so the refusal names it rather
     * than reporting "the shape is wrong". Both levels are asserted because
     * they are two separate checks over two different key sets. */
    const documentContext = 'a store carrying an unexpected top-level key';
    const documentCase = await makeIsolatedStore(t, 'document-key.json');
    const documentBytes = await writeBytes(
      documentCase.storeFile,
      rawBody({ schemaVersion: SCHEMA_VERSION, activities: [], custodian: 'registrar' })
    );

    const documentError = await captureRejection(
      documentCase.store.listActivities('S001'),
      documentContext
    );

    assertCode(documentError, E_STORE_UNREADABLE, documentContext);
    assert.match(
      documentError.message,
      /custodian/,
      'the refusal must name the unexpected top-level key'
    );
    await assertBytesUnchanged(documentCase.storeFile, documentBytes, documentContext);

    const recordContext = 'a store carrying an unexpected key on a record';
    const recordCase = await makeIsolatedStore(t, 'record-key.json');
    const recordBytes = await writeBytes(
      recordCase.storeFile,
      bodyOf([baseImport(), baseSubmission({ studentId: 'S002', approvedBy: 'the registrar' })])
    );

    const recordError = await captureRejection(
      recordCase.store.addActivity('S003', 'Quiz Club'),
      recordContext
    );

    assertCode(recordError, E_STORE_UNREADABLE, recordContext);
    assert.match(recordError.message, /approvedBy/, 'the refusal must name the unexpected key');
    assert.match(
      recordError.message,
      /index 1/,
      'the refusal must name the index of the record carrying it, so it can be found'
    );
    await assertBytesUnchanged(recordCase.storeFile, recordBytes, recordContext);
    assert.strictEqual(
      await exists(recordCase.temporaryFile),
      false,
      'the refusal must come before anything is staged'
    );
  });

  it('tolerates a single leading byte order mark, which an editor readily adds', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);
    await writeBytes(storeFile, `\ufeff${bodyOf([baseImport()])}`);

    assert.deepStrictEqual(
      await store.listActivities('S001'),
      [baseImport()],
      'a BOM protects no invariant, so refusing it would be unhelpful rather than safe'
    );
  });
});


/* ========================================================================= *
 * The two ceilings on the document
 *
 * The store is a hand-editable file that grows by one record per distinct
 * submission, and the load path reads the whole of it, decodes it, parses it,
 * allocates one canonical record per element, and — on a write — stringifies
 * the result again. An unbounded document therefore exhausts memory BEFORE any
 * shape validation can report anything, which is a failure no later check can
 * catch because the process is already gone.
 *
 * So two ceilings exist, and each is asserted on BOTH sides of its boundary,
 * because a ceiling only tested from above is indistinguishable from a module
 * that refuses everything:
 *
 *   - bytes, on load, as `E_STORE_UNREADABLE`, and before a write — measured
 *     on the bytes the document would serialize to — as `E_STORE_AT_CAPACITY`;
 *   - records, on load as `E_STORE_UNREADABLE` and before an append as
 *     `E_STORE_AT_CAPACITY`.
 *
 * The write-side code is the store's own, and not the general
 * `E_STORE_WRITE_FAILED`, because a full store and a failed write are
 * different events with different remedies; `activities.js` maps it to
 * `500 store_at_capacity` so a client can tell them apart too. Every code the
 * store raises must be mapped there — an unmapped one would reach a client as
 * `500 internal_error`, which is true about the process and useless about the
 * fault — so a case below asserts the two codes are genuinely different for
 * the two events rather than interchangeable labels for one.
 *
 * Each fixture here is VALID in every other respect — the byte-ceiling
 * documents differ from a loadable one only by legal JSON whitespace, and the
 * record-ceiling documents hold nothing but well-formed records with distinct
 * composite keys — so a refusal can only be the ceiling under test and not
 * some other rule the fixture tripped on the way past.
 * ========================================================================= */

describe('the byte and record ceilings on the store document', () => {
  /**
   * Pads a document with trailing spaces to an exact byte length.
   *
   * Whitespace after a top-level JSON value is legal, so the padded text
   * parses to exactly the same document: the ONLY thing that changes is its
   * size, which is what isolates the byte ceiling from every other rule.
   *
   * @param {string} text A complete document body.
   * @param {number} byteLength The exact length to pad to.
   * @returns {string} The padded body.
   */
  const padToBytes = (text, byteLength) => {
    const baseLength = Buffer.byteLength(text, 'utf8');
    assert.ok(
      baseLength <= byteLength,
      'the padding helper cannot shrink a document, so the fixture would not describe the boundary'
    );
    return text + ' '.repeat(byteLength - baseLength);
  };

  /**
   * Builds `count` valid workbook-sourced records with distinct composite
   * keys, spread across the ten known Student IDs.
   *
   * Minified rather than indented, because the point of the record-ceiling
   * cases is a document that holds many records while staying well inside the
   * byte ceiling — which is what proves the two limits are independent.
   *
   * @param {number} count How many records to build.
   * @returns {Array<{studentId: string, activity: string, source: string}>} The records.
   */
  const recordsNumbering = (count) =>
    Array.from({ length: count }, (unused, index) =>
      seededRecord(EXPECTED_KEY_SET[index % EXPECTED_KEY_SET.length], `Club ${index}`)
    );

  /** How many of `recordsNumbering(MAX_ACTIVITY_RECORDS)` belong to one student. */
  const RECORDS_PER_STUDENT = MAX_ACTIVITY_RECORDS / EXPECTED_KEY_SET.length;

  it('loads a document padded to exactly the byte ceiling', async (t) => {
    const context = 'a store padded to exactly the byte ceiling';
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t, 'at-byte-ceiling.json');
    const bytes = await writeBytes(storeFile, padToBytes(bodyOf([baseImport()]), MAX_STORE_BYTES));

    assert.strictEqual(
      bytes.length,
      MAX_STORE_BYTES,
      `${context}: the fixture must sit exactly ON the boundary, or the case describes a different document`
    );
    assert.deepStrictEqual(
      await store.listActivities('S001'),
      [baseImport()],
      `${context}: a document at the ceiling is inside it, so it must load`
    );

    /* And the ceiling is a bound on reading, not a freeze: a submission
     * against a document at the ceiling still persists, and the rewrite is
     * canonical, so the padding is gone and the document shrinks. */
    assert.strictEqual((await store.addActivity('S002', 'Quiz Club')).created, true, context);
    const rewritten = await fs.readFile(storeFile);
    assert.ok(
      rewritten.length < MAX_STORE_BYTES,
      `${context}: the canonical rewrite must be smaller than the padded document it replaced`
    );
    assert.strictEqual(await exists(temporaryFile), false, `${context}: nothing staged may survive`);
  });

  it('refuses a document one byte past the byte ceiling, on both paths, without touching it', async (t) => {
    const context = 'a store one byte past the byte ceiling';
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t, 'over-byte-ceiling.json');
    const bytes = await writeBytes(
      storeFile,
      padToBytes(bodyOf([baseImport()]), MAX_STORE_BYTES + 1)
    );

    assert.strictEqual(
      bytes.length,
      MAX_STORE_BYTES + 1,
      `${context}: the fixture must sit exactly ONE byte past the boundary`
    );

    const readError = await captureRejection(store.listActivities('S001'), `${context} (read)`);
    assertCode(readError, E_STORE_UNREADABLE, `${context} (read)`);
    assertMessageMentions(
      readError,
      /ceiling/,
      'the refusal must name the ceiling it enforced, so an operator can tell a size refusal from a shape refusal'
    );
    assertMessageOmits(
      readError,
      /[\\/]/u,
      'and it must still name no filesystem path, since this message is what a log receives'
    );
    await assertBytesUnchanged(storeFile, bytes, `${context} (read)`);

    const writeError = await captureRejection(
      store.addActivity('S002', 'Quiz Club'),
      `${context} (write)`
    );
    assertCode(writeError, E_STORE_UNREADABLE, `${context} (write)`);
    await assertBytesUnchanged(storeFile, bytes, `${context} (write)`);
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      `${context}: an oversized document must be refused before anything is staged`
    );
  });

  it('refuses a store path that is not a regular file, instead of reading it as absent', async (t) => {
    /* ABSENCE IS THE DANGEROUS MISREADING, which is why this is a case of its
     * own. The store's answer to an absent file is to seed from the workbook
     * and, on a submission, to WRITE — so a path that exists but is not a
     * regular file must refuse rather than fall into that branch. A directory
     * is the portable way to be non-regular, and it is also the one that
     * cannot be relied on to fail at read time: opening a directory for
     * reading SUCCEEDS on Windows, so the refusal has to come from inspecting
     * the opened descriptor. */
    const context = 'a directory occupying the store path';
    const directory = await makeTemporaryDirectory(t);
    const storeFile = path.join(directory, 'activities.json');
    await fs.mkdir(storeFile);
    const store = freshStore(storeFile);

    const readError = await captureRejection(store.listActivities('S001'), `${context} (read)`);
    assertCode(readError, E_STORE_UNREADABLE, `${context} (read)`);
    assertMessageMentions(
      readError,
      /not a regular file/,
      'the refusal must say what was wrong with the path rather than reporting a generic read fault'
    );

    const writeError = await captureRejection(
      store.addActivity('S001', 'Chess Club'),
      `${context} (write)`
    );
    assertCode(
      writeError,
      E_STORE_UNREADABLE,
      `${context} (write): the load refuses first, so this is not a write failure`
    );

    assert.deepStrictEqual(
      await fs.readdir(storeFile),
      [],
      `${context}: nothing may be seeded or written inside it`
    );
    assert.deepStrictEqual(
      (await fs.readdir(directory)).sort(),
      ['activities.json'],
      `${context}: and no staging sibling may be left beside it`
    );
  });

  it('loads a document holding exactly the record ceiling and refuses one record more', async (t) => {
    const atContext = 'a store holding exactly the record ceiling';
    const atCase = await makeIsolatedStore(t, 'at-record-ceiling.json');
    const atBytes = await writeBytes(
      atCase.storeFile,
      `${JSON.stringify(documentOf(recordsNumbering(MAX_ACTIVITY_RECORDS)))}\n`
    );

    /* THE ASSERTION THAT MAKES THIS CASE ABOUT THE RECORD CEILING. Both
     * fixtures are far inside the byte ceiling, so neither refusal below can
     * be the size rule wearing the record rule's clothes. */
    assert.ok(
      atBytes.length < MAX_STORE_BYTES,
      `${atContext}: the fixture must stay inside the byte ceiling, or this case proves the wrong limit`
    );
    assert.strictEqual(
      (await atCase.store.listActivities('S001')).length,
      RECORDS_PER_STUDENT,
      `${atContext}: a document at the record ceiling is inside it, so it must load and answer`
    );

    const overContext = 'a store holding one record more than the ceiling';
    const overCase = await makeIsolatedStore(t, 'over-record-ceiling.json');
    const overBytes = await writeBytes(
      overCase.storeFile,
      `${JSON.stringify(documentOf(recordsNumbering(MAX_ACTIVITY_RECORDS + 1)))}\n`
    );

    assert.ok(
      overBytes.length < MAX_STORE_BYTES,
      `${overContext}: the fixture must stay inside the byte ceiling, or this case proves the wrong limit`
    );

    const readError = await captureRejection(
      overCase.store.listActivities('S001'),
      `${overContext} (read)`
    );
    assertCode(readError, E_STORE_UNREADABLE, `${overContext} (read)`);
    assertMessageMentions(
      readError,
      /ceiling/,
      'the refusal must name the ceiling it enforced, so an operator knows which limit was hit'
    );
    await assertBytesUnchanged(overCase.storeFile, overBytes, `${overContext} (read)`);

    const writeError = await captureRejection(
      overCase.store.addActivity('S002', 'Quiz Club'),
      `${overContext} (write)`
    );
    assertCode(writeError, E_STORE_UNREADABLE, `${overContext} (write)`);
    await assertBytesUnchanged(overCase.storeFile, overBytes, `${overContext} (write)`);
    assert.strictEqual(
      await exists(overCase.temporaryFile),
      false,
      `${overContext}: an over-full document must be refused before anything is staged`
    );
  });

  it('refuses an append at the record ceiling while a repeat and a read still succeed', async (t) => {
    /* The append ceiling exists because appending past it would write a
     * document this module's own loader then refuses FOREVER — one submission
     * turning the store unreadable. Refusing the append instead leaves the
     * previous document intact, and leaves everything that does not grow the
     * document working: an idempotent repeat appends nothing, so it must still
     * be answered, and a read never appends at all. */
    const context = 'a submission against a store already at the record ceiling';
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t, 'full.json');
    const bytes = await writeBytes(
      storeFile,
      `${JSON.stringify(documentOf(recordsNumbering(MAX_ACTIVITY_RECORDS)))}\n`
    );

    const error = await captureRejection(store.addActivity('S001', 'Brand New Club'), context);

    assertCode(error, E_STORE_AT_CAPACITY, context);
    assertMessageMentions(
      error,
      /ceiling/,
      'the refusal must name the ceiling rather than reporting a generic disk failure'
    );
    assertMessageOmits(
      error,
      /[\\/]/u,
      'and it must carry no filesystem path, since this message is what a log receives'
    );
    await assertBytesUnchanged(storeFile, bytes, context);
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      `${context}: the refusal must come before anything is staged`
    );

    /* `club 0` is the case variant of a record already in the document, so
     * the composite-key lookup finds it BEFORE the capacity check can fire —
     * which is why the ceiling is enforced after the lookup and not before. */
    const repeat = await store.addActivity('S001', 'club 0');
    assert.strictEqual(
      repeat.created,
      false,
      `${context}: an idempotent repeat appends nothing, so capacity cannot refuse it`
    );
    assert.deepStrictEqual(
      repeat.record,
      seededRecord('S001', 'Club 0'),
      `${context}: and it must answer with the record that was already there`
    );
    await assertBytesUnchanged(storeFile, bytes, `${context} (idempotent repeat)`);

    assert.strictEqual(
      (await store.listActivities('S001')).length,
      RECORDS_PER_STUDENT,
      `${context}: a full store must still answer every read it could answer before`
    );
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      `${context}: and neither the repeat nor the read may stage anything`
    );
  });

  /**
   * A label of the maximum accepted length whose SERIALIZED form is as large as
   * the rules allow — 60 UTF-16 code units of unpaired surrogates, each of
   * which `JSON.stringify` escapes to a six-byte `\\uD800` sequence, so the
   * label costs 360 bytes on disk rather than 60.
   *
   * Every rule accepts it, which is the point: `inspectLabel` counts code
   * units, refuses control characters and line separators, and trims and
   * collapses space separators — an unpaired surrogate is none of those, so
   * the label is valid, already normalized, and round-trips through
   * `JSON.parse` unchanged. It is the shape that proves the record ceiling
   * cannot stand in for the byte ceiling.
   *
   * @param {number} ordinal Distinguishes one label from another, so the
   *   composite keys stay distinct.
   * @returns {string} A valid 60-code-unit label.
   */
  const widestLabel = (ordinal) =>
    '\ud800'.repeat(59) + String.fromCharCode(0xdc00 + (ordinal % 1024));

  it('refuses a submission that would serialize past the byte ceiling, keeping the store readable', async (t) => {
    /* THE INTERACTION BETWEEN THE TWO CEILINGS, which neither of them catches
     * alone. A document can sit inside the record ceiling and still serialize
     * past the byte ceiling, because the label bound counts UTF-16 code units
     * while the byte ceiling counts UTF-8 bytes. Measured before this case
     * existed: a valid 4,755-record document of 2,097,002 bytes accepted one
     * more valid label, published 2,097,502 bytes, and the very next read
     * failed with E_STORE_UNREADABLE — a submission turning the store
     * unreadable, recoverable only by a hand edit.
     *
     * So the writer measures the bytes it is about to persist and refuses
     * before staging anything. This case fills a store to just under the
     * ceiling with the widest valid records and submits one more. */
    const context = 'a submission that would serialize past the byte ceiling';
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t, 'near-byte-ceiling.json');

    /* The document is built by arithmetic rather than by re-serializing after
     * every record: one record's cost is measured once, and the count that
     * fits follows from it. The loop below then corrects for the array's own
     * punctuation, so the fixture lands inside the ceiling by construction
     * rather than by luck. */
    const recordAt = (ordinal) =>
      seededRecord(EXPECTED_KEY_SET[ordinal % EXPECTED_KEY_SET.length], widestLabel(ordinal));
    const oneRecordCost =
      Buffer.byteLength(bodyOf([recordAt(0), recordAt(1)]), 'utf8') -
      Buffer.byteLength(bodyOf([recordAt(0)]), 'utf8');
    const records = Array.from(
      { length: Math.floor((MAX_STORE_BYTES - Buffer.byteLength(bodyOf([]), 'utf8')) / oneRecordCost) },
      (unused, ordinal) => recordAt(ordinal)
    );
    while (Buffer.byteLength(bodyOf(records), 'utf8') > MAX_STORE_BYTES) {
      records.pop();
    }

    const bytes = await writeBytes(storeFile, bodyOf(records));
    assert.ok(
      bytes.length <= MAX_STORE_BYTES,
      `${context}: the fixture must be a store the loader accepts, or the case proves nothing about writing`
    );
    assert.ok(
      records.length < MAX_ACTIVITY_RECORDS,
      `${context}: the fixture must be inside the RECORD ceiling too, so the refusal can only be the byte ceiling`
    );
    assert.ok(
      bytes.length + oneRecordCost > MAX_STORE_BYTES,
      `${context}: and one more record must not fit, or the submission below would legitimately succeed`
    );
    assert.strictEqual(
      (await store.listActivities(EXPECTED_KEY_SET[0])).length,
      Math.ceil(records.length / EXPECTED_KEY_SET.length),
      `${context}: the fixture must load before the submission, so the refusal is about the write`
    );

    /* A label no record in the fixture carries, so this is a genuinely new
     * composite key and the capacity lookup cannot answer it idempotently. */
    const error = await captureRejection(
      store.addActivity('S002', '\ud801'.repeat(60)),
      context
    );

    assertCode(error, E_STORE_AT_CAPACITY, context);
    assertMessageMentions(
      error,
      /ceiling/,
      'the refusal must name the ceiling it enforced rather than reporting a generic disk failure'
    );
    assertMessageOmits(
      error,
      /[\\/]/u,
      'and it must carry no filesystem path, since this message is what a log receives'
    );
    await assertBytesUnchanged(storeFile, bytes, context);
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      `${context}: the refusal must come before anything is staged — a staged oversized document would be adopted by the rename`
    );

    /* THE PROPERTY THE REFUSAL EXISTS FOR: the store is still readable. A
     * write that had gone through would have left every later read and write
     * refusing E_STORE_UNREADABLE. */
    assert.strictEqual(
      (await store.listActivities(EXPECTED_KEY_SET[0])).length,
      Math.ceil(records.length / EXPECTED_KEY_SET.length),
      `${context}: the store must still load after the refusal — that is the whole point of refusing`
    );

    /* And a repeat of a record already present still succeeds: it appends
     * nothing, so it serializes to the document that is already on disk. */
    const repeat = await store.addActivity(records[0].studentId, records[0].activity);
    assert.strictEqual(
      repeat.created,
      false,
      `${context}: an idempotent repeat writes nothing, so the byte ceiling cannot refuse it`
    );
    await assertBytesUnchanged(storeFile, bytes, `${context} (idempotent repeat)`);
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      `${context}: and the repeat may stage nothing either`
    );
  });

  it('reports a full store and a failed write as two different codes', async (t) => {
    /* WHY THIS CASE EXISTS. Both events refuse a submission and both leave the
     * previous document intact, and for a while both reported the same code
     * and the same sentence — so a submitter, and an operator reading a log,
     * could not tell a store that had run out of room from a disk that could
     * not be written. The two need different actions: retry clears a write
     * failure, and only reclaiming room clears a full store. The codes are
     * therefore asserted TOGETHER, in one case, because what matters is not
     * what either one is called but that they are not the same. */
    const capacityContext = 'a submission against a store at the record ceiling';
    const full = await makeIsolatedStore(t, 'distinguishable-full.json');
    await writeBytes(
      full.storeFile,
      `${JSON.stringify(documentOf(recordsNumbering(MAX_ACTIVITY_RECORDS)))}\n`
    );
    const capacityError = await captureRejection(
      full.store.addActivity('S001', 'Brand New Club'),
      capacityContext
    );
    assertCode(capacityError, E_STORE_AT_CAPACITY, capacityContext);

    /* The write fault, with room to spare in the document, so nothing about
     * capacity can be what refuses it: a directory planted at the staging path
     * cannot be opened for writing, which is deterministic on every platform
     * this project runs on. */
    const faultContext = 'a submission whose staging file cannot be opened';
    const faulted = await makeIsolatedStore(t, 'distinguishable-fault.json');
    assert.strictEqual((await faulted.store.addActivity('S001', 'Chess Club')).created, true);
    await fs.mkdir(faulted.temporaryFile);
    const writeError = await captureRejection(
      faulted.store.addActivity('S001', 'Quiz Club'),
      faultContext
    );
    assertCode(writeError, E_STORE_WRITE_FAILED, faultContext);

    assert.notStrictEqual(
      capacityError.code,
      writeError.code,
      'a full store and a failed write must not answer with the same code, or a caller cannot tell which happened'
    );
  });
});


/* ========================================================================= *
 * The cost of the whole-document work, and the warning before the ceiling
 *
 * The store is read from disk, parsed and validated in full on EVERY request,
 * which is what makes a hand edit visible immediately and a lost update
 * impossible. This process is single-threaded, so the question that decides
 * whether that design is safe is not how long the work takes but whether it
 * lets anything else run while it happens: run to completion, and one request
 * for a large document stalls every other request in flight, including the
 * routes that touch no store at all.
 *
 * MEASURED before these cases existed, at 4900 records — a document both
 * ceilings accept: a load held the event loop for one uninterrupted 9.2 ms
 * stretch, a submission for 13.2 ms, and while four readers and four writers
 * were in flight the `GET /` path — which performs no I/O whatsoever — went
 * from a p50 of 0.4 ms to 6.8 ms. The work is unchanged and still uncached;
 * what changed is that it is now broken into bounded runs.
 *
 * The cases below assert that WITHOUT A CLOCK. A latency threshold on a shared
 * build host measures the host, so instead they count the yields themselves:
 * the store hands the loop back by calling `setImmediate`, so the number of
 * those calls during one operation says whether the work was broken up, and
 * says it the same way on a fast host and a loaded one.
 * ========================================================================= */

describe('bounding the work one request may hold the event loop for', () => {
  /**
   * Builds a document of `count` valid records that is DENSE: minified, with
   * the shortest labels the rules allow, so many records occupy few bytes.
   *
   * Density is the point. The load path reads the file in 64 KiB chunks and
   * awaits each one, so a physically large document would yield for reasons
   * that have nothing to do with validation, and a case built on one could not
   * tell the two apart. Keeping the bytes small leaves validation as the only
   * thing that can yield.
   *
   * @param {number} count How many records to build.
   * @returns {string} A complete document body.
   */
  const denseDocument = (count) =>
    `${JSON.stringify(
      documentOf(
        Array.from({ length: count }, (unused, index) =>
          seededRecord(EXPECTED_KEY_SET[index % EXPECTED_KEY_SET.length], `C ${index}`)
        )
      )
    )}\n`;

  /**
   * Counts the store's yields during one operation.
   *
   * `global.setImmediate` is what `yieldToEventLoop` calls, so wrapping it
   * counts exactly the hand-backs and nothing else — verified by the small
   * document below, which counts zero, so nothing in the runtime's own file
   * handling contributes to the number. Restored in a `finally`, so a
   * rejecting operation cannot leave the global patched for the rest of the
   * suite.
   *
   * @param {() => Promise<unknown>} operation The store call to measure.
   * @returns {Promise<{yields: number, result: unknown}>} The count and the
   *   operation's own result.
   */
  const countYields = async (operation) => {
    const real = global.setImmediate;
    let yields = 0;
    global.setImmediate = (...args) => {
      yields += 1;
      return real(...args);
    };
    try {
      const result = await operation();
      return { yields, result };
    } finally {
      global.setImmediate = real;
    }
  };

  it('breaks a large document up on read, and leaves an ordinary one untouched', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t, 'yielding-read.json');

    /* THE ORDINARY DOCUMENT FIRST, because it is the assertion that keeps the
     * other one honest. Eleven records is the seeded store, and the workload
     * this feature is actually for; it must complete inside a single run and
     * pay nothing at all for the bound. */
    const ordinaryBytes = await writeBytes(storeFile, denseDocument(11));
    await store.listActivities('S001');
    const ordinary = await countYields(() => store.listActivities('S001'));
    assert.strictEqual(
      ordinary.yields,
      0,
      'a document of a handful of records must not yield once: the real workload pays nothing for the bound'
    );
    assert.strictEqual(ordinary.result.length, 2, 'and it must still answer the records it holds');

    /* THE LARGE DOCUMENT, well inside both ceilings and deliberately dense. */
    const largeCount = 4000;
    const largeBytes = await writeBytes(storeFile, denseDocument(largeCount));
    assert.ok(
      largeBytes.length < MAX_STORE_BYTES && largeCount < MAX_ACTIVITY_RECORDS,
      'the fixture must be a document this build accepts, or it proves nothing about documents it serves'
    );
    assert.ok(
      largeBytes.length > ordinaryBytes.length,
      'and it must be the larger of the two, or the comparison below is backwards'
    );

    const large = await countYields(() => store.listActivities('S001'));

    /* Not an exact count: how many times a millisecond-scale budget is spent
     * depends on the host. What is asserted is that it was spent REPEATEDLY —
     * the work was handed back more than once, so it was neither run to
     * completion nor broken at a single lucky point. */
    assert.ok(
      large.yields >= 2,
      `a large document must hand the event loop back repeatedly while it is validated; it yielded ${large.yields} times`
    );
    assert.strictEqual(
      large.result.length,
      largeCount / EXPECTED_KEY_SET.length,
      'and every record must still be validated and returned — the bound changes the granularity of the work, never the work'
    );
  });

  it('breaks a submission up too, and serializes in a run of its own', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t, 'yielding-write.json');

    /* A submission against an ordinary document yields EXACTLY ONCE, and that
     * one yield is the hand-back before serializing. `JSON.stringify` of a
     * document at the byte ceiling is a single 1.9 ms call that cannot be
     * broken up, so the only thing that can be done about it is to stop it
     * extending whatever run the validation before it was in the middle of. */
    await writeBytes(storeFile, denseDocument(11));
    await store.listActivities('S001');
    const ordinary = await countYields(() => store.addActivity('S001', 'Chess Club'));
    assert.strictEqual(ordinary.result.created, true, 'the submission must be persisted');
    assert.strictEqual(
      ordinary.yields,
      1,
      'an ordinary submission must yield once and only once: the hand-back before serializing, with nothing added for validation'
    );

    /* AN IDEMPOTENT REPEAT OF THE SAME DOCUMENT YIELDS NOTHING AT ALL, which
     * is what places the hand-back on the serialization rather than on the
     * route: a repeat appends nothing, so it never serializes, so there is
     * nothing to hand the loop back for. Asserted against the same ordinary
     * document as the append above, so the only difference between the two
     * counts is whether a write happened. */
    const repeat = await countYields(() => store.addActivity('S001', 'chess club'));
    assert.strictEqual(
      repeat.result.created,
      false,
      'the repeat must be recognized rather than appended'
    );
    assert.strictEqual(
      repeat.yields,
      0,
      'a repeat writes nothing, so it must not pay the pre-serialization hand-back at all'
    );

    /* A submission against a large document yields for its validation as well,
     * so strictly more than the one. */
    await writeBytes(storeFile, denseDocument(4000));
    const large = await countYields(() => store.addActivity('S001', 'Quiz Club'));
    assert.strictEqual(large.result.created, true, 'the submission must be persisted');
    assert.ok(
      large.yields > ordinary.yields,
      `a submission against a large document must yield more than one against a small one; it yielded ${large.yields} against ${ordinary.yields}`
    );
  });

  it('warns once when the document crosses into the last tenth of the record ceiling', async (t) => {
    /* A CEILING WITH NO APPROACH SIGNAL IS A CLIFF. This one is reachable in
     * about twenty-six seconds of saturating submission, which is no time at
     * all for a person to notice a store filling up, so the last thing an
     * operator should learn from is the first refusal. The warning is LATCHED:
     * one line when the band is crossed, then silence — a line on each of the
     * last five hundred submissions would be the noisiest evidence in the log
     * exactly when somebody is trying to read it. */
    const context = 'a store crossing into the capacity warning band';
    const { store, storeFile } = await makeIsolatedStore(t, 'warning-band.json');

    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.join(' '));
    };
    t.after(() => {
      console.warn = realWarn;
    });

    /* One record short of the band, so the submission below is the crossing. */
    await writeBytes(storeFile, denseDocument(CAPACITY_WARNING_RECORDS - 1));
    assert.strictEqual(
      (await store.addActivity('S001', 'Crossing Club')).created,
      true,
      `${context}: the crossing submission must still be accepted — a warning is not a refusal`
    );

    assert.strictEqual(
      warnings.length,
      1,
      `${context}: crossing the band must be reported exactly once`
    );
    const reported = JSON.parse(warnings[0].slice(warnings[0].indexOf('{')));
    assert.deepStrictEqual(
      reported,
      {
        event: 'store_capacity_warning',
        records: CAPACITY_WARNING_RECORDS,
        ceiling: MAX_ACTIVITY_RECORDS,
      },
      `${context}: the line must say what the store holds and what it will hold at most, and carry nothing a submitter sent`
    );

    assert.strictEqual(
      (await store.addActivity('S001', 'Second Club')).created,
      true,
      `${context}: the next submission must still be accepted`
    );
    assert.strictEqual(
      warnings.length,
      1,
      `${context}: and it must add no second line — the latch is what keeps the warning from flooding the log`
    );

    /* Pruned back below the band — which is exactly what an operator acting on
     * the warning does — and then crossed again. The latch must have re-armed,
     * or a store that fills a second time fills it silently. */
    await writeBytes(storeFile, denseDocument(10));
    assert.strictEqual((await store.addActivity('S001', 'After Pruning Club')).created, true);
    assert.strictEqual(
      warnings.length,
      1,
      `${context}: a submission well below the band must not warn`
    );

    await writeBytes(storeFile, denseDocument(CAPACITY_WARNING_RECORDS - 1));
    assert.strictEqual((await store.addActivity('S001', 'Crossing Again Club')).created, true);
    assert.strictEqual(
      warnings.length,
      2,
      `${context}: crossing the band a second time must warn again`
    );
  });
});


/* ========================================================================= *
 * The reader's supported format subset
 *
 * A bespoke reader has to declare its limits, and a declared limit is only
 * worth anything if the refusal is tested. Each case asserts the NAMED code
 * rather than merely that something threw, because the failure being guarded
 * against is a silent wrong answer — still-compressed bytes handed back as
 * though they were XML, or an empty value standing in for a key.
 *
 * Every malformed package is synthetic, assembled from bytes chosen here. The
 * repository workbooks are never copied-and-corrupted and never written.
 * ========================================================================= */

describe('the reader refuses packages outside its supported subset', () => {
  it('refuses an unsupported compression method and names it, rather than returning compressed bytes', async (t) => {
    const context = 'a package using compression method 12';
    const directory = await makeTemporaryDirectory(t);
    const payload = worksheetXml('<c r="A1" t="inlineStr"><is><t>Never Read</t></is></c>');
    /* Method 12 is BZIP2. The entry carries the payload verbatim, so if the
     * reader ever returned the data of an unsupported method as-is, the
     * assertion below would see 'Never Read' come back instead of a refusal. */
    const filePath = await writePackage(directory, 'method.xlsx', [
      zipLocalEntry(WORKSHEET_PART, payload, { method: 12 }),
    ]);

    const listError = captureThrow(() => xlsxRead.listEntries(filePath), `${context} (listEntries)`);
    assertCode(listError, E_XLSX_UNSUPPORTED_COMPRESSION, `${context} (listEntries)`);
    assertMessageMentions(
      listError,
      /\b12\b/,
      'the refusal must name the offending method number'
    );

    const readError = captureThrow(
      () => xlsxRead.readEntry(filePath, WORKSHEET_PART),
      `${context} (readEntry)`
    );
    assertCode(readError, E_XLSX_UNSUPPORTED_COMPRESSION, `${context} (readEntry)`);
    assertMessageOmits(
      readError,
      /Never Read/,
      'the refusal must not carry the entry payload back to the caller'
    );
  });

  it('refuses a set encryption bit in the general-purpose flag', async (t) => {
    const context = 'a package with the encryption bit set';
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'encrypted.xlsx', [
      zipLocalEntry(WORKSHEET_PART, worksheetXml(''), { flag: FLAG_ENCRYPTED }),
    ]);

    const error = captureThrow(() => xlsxRead.listEntries(filePath), context);

    assertCode(error, E_XLSX_UNSUPPORTED_FLAGS, context);
  });

  it('refuses a set data-descriptor bit, whose header sizes cannot be trusted', async (t) => {
    const context = 'a package with the data-descriptor bit set';
    const directory = await makeTemporaryDirectory(t);
    /* With this bit set the local header's size fields are zero, so the walk
     * would land on the wrong offset for every later entry rather than merely
     * mis-reading this one. */
    const filePath = await writePackage(directory, 'streamed.xlsx', [
      zipLocalEntry(WORKSHEET_PART, worksheetXml(''), { flag: FLAG_DATA_DESCRIPTOR }),
    ]);

    const error = captureThrow(() => xlsxRead.readEntry(filePath, WORKSHEET_PART), context);

    assertCode(error, E_XLSX_UNSUPPORTED_FLAGS, context);
  });

  it('refuses a requested part that the package does not hold, and names it', async (t) => {
    const context = 'a package without the requested part';
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'partial.xlsx', [
      zipLocalEntry(CONTENT_TYPES_PART, '<Types/>'),
    ]);

    const error = captureThrow(() => xlsxRead.readEntry(filePath, WORKSHEET_PART), context);

    assertCode(error, E_XLSX_PART_NOT_FOUND, context);
    assertMessageMentions(
      error,
      new RegExp(WORKSHEET_PART.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      'the refusal must name the missing part so a reader knows which one was asked for'
    );
    /* The package itself is fine, so the part it does hold still reads. */
    assert.deepStrictEqual(xlsxRead.listEntries(filePath), [CONTENT_TYPES_PART]);
  });

  it('refuses a shared-string reference, since no package here carries a string table', async (t) => {
    const context = 'a package with a t="s" cell';
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'shared.xlsx', [
      zipLocalEntry(WORKSHEET_PART, worksheetXml('<c r="A1" t="s"><v>0</v></c>')),
    ]);

    /* A silently empty value here would corrupt the key set, which is the one
     * thing the feature validates every submission against. */
    const rowsError = captureThrow(
      () => xlsxRead.readSheetRows(filePath, WORKSHEET_PART),
      `${context} (readSheetRows)`
    );
    assertCode(rowsError, E_XLSX_SHARED_STRINGS_UNSUPPORTED, `${context} (readSheetRows)`);

    const columnError = captureThrow(
      () => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'),
      `${context} (readColumn)`
    );
    assertCode(columnError, E_XLSX_SHARED_STRINGS_UNSUPPORTED, `${context} (readColumn)`);
  });

  it('refuses an entry whose declared size runs past the end of the file', async (t) => {
    const context = 'a package whose entry declares more bytes than the file holds';
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'truncated.xlsx', [
      zipLocalEntry(WORKSHEET_PART, worksheetXml(''), { declaredCompressedSize: 4096 }),
    ]);

    const error = captureThrow(() => xlsxRead.listEntries(filePath), context);

    assertCode(error, E_XLSX_TRUNCATED, context);
  });

  it('refuses bytes that do not begin with a local file header', async (t) => {
    const context = 'a file that is not a ZIP package';
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'plain.xlsx', [
      Buffer.from('this is not an OOXML package at all', 'utf8'),
    ]);

    const error = captureThrow(() => xlsxRead.listEntries(filePath), context);

    assertCode(error, E_XLSX_TRUNCATED, context);
  });

  it('reads a STORED entry, and tolerates both the self-closing and the paired cell form', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const cells =
      '<c r="A1" t="inlineStr"><is><t>Stored Works</t></is></c>' +
      '<c r="B1"/>' +
      '<c r="C1" t="n"><v>42</v></c>';
    const filePath = await writePackage(directory, 'stored.xlsx', [
      zipLocalEntry(WORKSHEET_PART, worksheetXml(cells), { method: COMPRESSION_STORED }),
    ]);

    assert.deepStrictEqual(xlsxRead.listEntries(filePath), [WORKSHEET_PART]);
    assert.deepStrictEqual(xlsxRead.readSheetRows(filePath, WORKSHEET_PART), [
      { A: 'Stored Works', B: '', C: '42' },
    ]);
    assert.deepStrictEqual(
      xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'),
      ['Stored Works'],
      'a STORED entry is carried verbatim and must read back unchanged'
    );
    assert.deepStrictEqual(
      xlsxRead.readColumn(filePath, WORKSHEET_PART, 'B'),
      [''],
      'a self-closing cell yields an empty value rather than being skipped'
    );
    assert.deepStrictEqual(
      xlsxRead.readColumn(filePath, WORKSHEET_PART, 'C'),
      ['42'],
      'a numeric cell arrives as the string the package stored'
    );
  });

  it('reads a DEFLATE entry, which is what every workbook in this repository uses', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'deflated.xlsx', [
      zipLocalEntry(CONTENT_TYPES_PART, '<Types/>'),
      zipLocalEntry(
        WORKSHEET_PART,
        worksheetXml('<c r="A1" t="inlineStr"><is><t>Deflated</t></is></c>')
      ),
    ]);

    assert.deepStrictEqual(xlsxRead.listEntries(filePath), [CONTENT_TYPES_PART, WORKSHEET_PART]);
    assert.strictEqual(xlsxRead.readEntry(filePath, CONTENT_TYPES_PART).toString('utf8'), '<Types/>');
    assert.deepStrictEqual(xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'), ['Deflated']);
  });

  it('rejects an argument fault as a TypeError, not as a package refusal', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'argument.xlsx', [
      zipLocalEntry(WORKSHEET_PART, worksheetXml('')),
    ]);

    /* A caller bug is not a property of the package, so it must not arrive
     * wearing one of the declared refusal codes. */
    for (const [callable, description] of [
      [() => xlsxRead.listEntries(''), 'an empty file path'],
      [() => xlsxRead.readEntry(filePath, ''), 'an empty part name'],
      [() => xlsxRead.readColumn(filePath, WORKSHEET_PART, '1'), 'a non-letter column'],
      [() => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'ABCD'), 'four column letters'],
    ]) {
      const error = captureThrow(callable, description);
      assert.ok(error instanceof TypeError, `${description} must be a TypeError`);
      assert.strictEqual(error.code, undefined, `${description} must carry no refusal code`);
    }
  });
});

/* ========================================================================= *
 * Sparse rows and escaped text
 *
 * The two properties of the reader that the store's correctness rests on and
 * that no workbook in this repository can demonstrate, because all ten of its
 * rows are fully populated and none of its labels contains a character that
 * needs escaping.
 *
 * ALIGNMENT is the first. The seed read asks for columns A and C in ONE
 * selective `readSheetRows` call, whose rows are keyed by column letter; the
 * store projects each column out of them — an empty placeholder where a row
 * carries no cell for it — and pairs the two by position. That is only sound
 * because the reader yields one entry per worksheet row: a reader that
 * skipped one would shift every later label up and credit students with
 * activities that belong to somebody else, silently, with no error anywhere.
 * One blank cell in a spreadsheet is all that takes, which is why the fixture
 * below is shaped like the workbook it stands in for.
 *
 * DECODING is the second. A label containing `&`, `<` or `"` is legitimate —
 * nothing in the normalization rules excludes them, and the service accepts
 * them from a submission — so a label could reach a workbook column escaped.
 * A raw `&amp;` surviving into the store would be stored, deduplicated and
 * served as that literal text.
 * ========================================================================= */

describe('the reader against sparse rows and escaped cell text', () => {
  it('gives a row that omits the requested column an empty placeholder, keeping later rows aligned', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    /* Shaped like `Other Info`: Student IDs in column A, activity labels in
     * column C, and two students who recorded nothing. Their column C cell is
     * ABSENT — not empty, not self-closing — which is how a generator writes a
     * trailing blank and is exactly the case a positional reader gets wrong.
     * Row 6 is an empty row, the other shape a real sheet produces. */
    const filePath = await writePackage(directory, 'sparse.xlsx', [
      zipLocalEntry(
        WORKSHEET_PART,
        worksheetXmlOfRows(
          [
            rowXml(
              1,
              inlineStringCell('A1', 'Student ID') +
                inlineStringCell('C1', 'Extracurricular Activity')
            ),
            rowXml(2, inlineStringCell('A2', 'S001') + inlineStringCell('C2', 'Robotics Club')),
            rowXml(3, inlineStringCell('A3', 'S002')),
            rowXml(4, inlineStringCell('A4', 'S003') + inlineStringCell('C4', 'Football Team')),
            rowXml(5, inlineStringCell('A5', 'S004')),
            '<row r="6"/>',
          ],
          'A1:C6'
        )
      ),
    ]);

    assert.deepStrictEqual(
      xlsxRead.readSheetRows(filePath, WORKSHEET_PART),
      [
        { A: 'Student ID', C: 'Extracurricular Activity' },
        { A: 'S001', C: 'Robotics Club' },
        { A: 'S002' },
        { A: 'S003', C: 'Football Team' },
        { A: 'S004' },
        {},
      ],
      'rows are keyed by column letter, so a row simply has no key for a column it does not carry'
    );

    const studentIds = xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A');
    const labels = xlsxRead.readColumn(filePath, WORKSHEET_PART, 'C');

    assert.deepStrictEqual(
      labels,
      ['Extracurricular Activity', 'Robotics Club', '', 'Football Team', '', ''],
      'one value per ROW, with an empty placeholder wherever the column is absent'
    );
    assert.deepStrictEqual(studentIds, ['Student ID', 'S001', 'S002', 'S003', 'S004', '']);
    assert.strictEqual(
      studentIds.length,
      labels.length,
      'the two columns must be the same length, or the seed read could not pair them at all'
    );

    /* The alignment claim over arrays, which mirrors `readColumn`'s one value
     * per row — the shape the key-set read consumes, while the row objects
     * above are the shape the seed read consumes. A reader that skipped the
     * absent cells would produce S002/Football Team here — one student
     * credited with another's activity, S003 with nothing — from two blank
     * cells and no error. */
    assert.deepStrictEqual(
      studentIds.slice(1).map((studentId, index) => [studentId, labels[index + 1]]),
      [
        ['S001', 'Robotics Club'],
        ['S002', ''],
        ['S003', 'Football Team'],
        ['S004', ''],
        ['', ''],
      ],
      'every label must still sit against the Student ID it was written for'
    );

    /* A column absent from every row is answered the same way: placeholders,
     * one per row, rather than a refusal or a short array. */
    assert.deepStrictEqual(
      xlsxRead.readColumn(filePath, WORKSHEET_PART, 'Z'),
      ['', '', '', '', '', ''],
      'a column no row carries still yields one value per row'
    );
  });

  it('decodes the five predefined XML entities in cell text', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'entities.xlsx', [
      zipLocalEntry(
        WORKSHEET_PART,
        worksheetXmlOfRows(
          [
            rowXml(
              1,
              inlineStringCell('A1', 'Arts &amp; Crafts') +
                inlineStringCell('B1', '&lt;Debate&gt; Society') +
                inlineStringCell('C1', '&quot;Chess&quot; &apos;Club&apos;')
            ),
          ],
          'A1:C1'
        )
      ),
    ]);

    assert.deepStrictEqual(
      xlsxRead.readSheetRows(filePath, WORKSHEET_PART),
      [{ A: 'Arts & Crafts', B: '<Debate> Society', C: '"Chess" \'Club\'' }],
      'an escaped label must arrive decoded; a raw &amp; reaching the store would be stored and served as literal text'
    );
    assert.deepStrictEqual(
      xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'),
      ['Arts & Crafts'],
      'decoding applies to a column read, which is the call the key-set read makes'
    );
  });

  it('decodes decimal and hexadecimal numeric character references', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'numeric-entities.xlsx', [
      zipLocalEntry(
        WORKSHEET_PART,
        worksheetXmlOfRows(
          [
            rowXml(
              1,
              inlineStringCell('A1', 'Chess &#38; Go') +
                inlineStringCell('B1', 'Chess &#x26; Go') +
                inlineStringCell('C1', 'Caf&#233; Club') +
                inlineStringCell('D1', 'Quiz &#x2014; Club') +
                inlineStringCell('E1', 'Club &#x1F600; Two')
            ),
          ],
          'A1:E1'
        )
      ),
    ]);

    assert.deepStrictEqual(
      xlsxRead.readSheetRows(filePath, WORKSHEET_PART),
      [
        {
          A: 'Chess & Go',
          B: 'Chess & Go',
          C: 'Caf\u00e9 Club',
          D: 'Quiz \u2014 Club',
          /* Outside the Basic Multilingual Plane, so it is two UTF-16 units
           * and has to be rendered from the code point rather than a char
           * code. Built here with `fromCodePoint` rather than pasted, so the
           * expectation cannot drift with this file's own encoding. */
          E: `Club ${String.fromCodePoint(0x1f600)} Two`,
        },
      ],
      'both notations, an accented Latin character, a punctuation character and a supplementary-plane one'
    );
  });

  it('never drops an unrecognized entity or a reference that names no character', async (t) => {
    const context = 'a cell carrying an unrecognized entity or an unrenderable reference';
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'unknown-entities.xlsx', [
      zipLocalEntry(
        WORKSHEET_PART,
        worksheetXmlOfRows(
          [
            rowXml(
              1,
              inlineStringCell('A1', 'Club &nbsp; One') +
                /* A lone surrogate and a value past the last code point:
                 * neither names a character that can be rendered. */
                inlineStringCell('B1', 'Club &#xD800; Two') +
                inlineStringCell('C1', 'Club &#x110000; Three')
            ),
          ],
          'A1:C1'
        )
      ),
    ]);

    const outcome = readSheetRowsOutcome(filePath, context);
    if (outcome.refused) {
      /* Refusing the part is the conformant answer and preservation is this
       * project's leniency. Either way — the helper has already checked the
       * code — the reader did not answer with a value it had quietly edited. */
      return;
    }

    assert.deepStrictEqual(
      outcome.rows,
      [
        {
          A: 'Club &nbsp; One',
          B: 'Club &#xD800; Two',
          C: 'Club &#x110000; Three',
        },
      ],
      'each reference must be left exactly as written: dropping it would lose characters from a label with no error, and guessing at it would invent them'
    );
  });

  it('keeps a cell that omits its r attribute in its own column, or refuses it', async (t) => {
    const context = 'a cell with no r attribute between two that have one';
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'implicit-reference.xlsx', [
      zipLocalEntry(
        WORKSHEET_PART,
        worksheetXmlOfRows(
          [
            rowXml(
              1,
              inlineStringCell('A1', 'S001') +
                '<c t="inlineStr"><is><t>Implicit</t></is></c>' +
                inlineStringCell('C1', 'Robotics Club')
            ),
          ],
          'A1:C1'
        )
      ),
    ]);

    const outcome = readSheetRowsOutcome(filePath, context);
    if (outcome.refused) {
      return;
    }

    assert.deepStrictEqual(
      outcome.rows,
      [{ A: 'S001', B: 'Implicit', C: 'Robotics Club' }],
      'the unreferenced cell takes the column after the previous one, per ECMA-376'
    );
    assert.deepStrictEqual(
      xlsxRead.readColumn(filePath, WORKSHEET_PART, 'C'),
      ['Robotics Club'],
      'and the explicitly referenced cell that follows it must not have been displaced — the value the store would read as an activity label stays put'
    );
    assert.deepStrictEqual(
      xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'),
      ['S001'],
      'nor may the cell before it have been consumed'
    );
  });
});

/* ========================================================================= *
 * The reader against the real workbooks
 *
 * The positive half of the subset: these are the exact packages the feature
 * reads at run time, so their part list, dimensions, header rows and key
 * column are pinned here. A workbook replaced by hand fails a case here
 * rather than quietly changing what every submission is validated against.
 * ========================================================================= */

describe('the reader against the three repository workbooks', () => {
  it('lists the nine parts of every workbook, in package order', () => {
    for (const workbook of WORKBOOK_SHAPES) {
      assert.deepStrictEqual(
        xlsxRead.listEntries(workbook.filePath),
        EXPECTED_PART_NAMES,
        `the part list of ${workbook.label}`
      );
    }
  });

  it('holds no shared-string part, which is why cells are inline strings', () => {
    for (const workbook of WORKBOOK_SHAPES) {
      const entries = xlsxRead.listEntries(workbook.filePath);
      assert.strictEqual(
        entries.includes('xl/sharedStrings.xml'),
        false,
        `${workbook.label} must hold no string table`
      );
      const sheet = xlsxRead.readEntry(workbook.filePath, WORKSHEET_PART).toString('utf8');
      assert.ok(
        sheet.includes('t="inlineStr"'),
        `${workbook.label} must store its text as inline strings`
      );
    }
  });

  it('returns the content-types part of every workbook byte for byte, declaring every part', () => {
    for (const workbook of WORKBOOK_SHAPES) {
      const bytes = xlsxRead.readEntry(workbook.filePath, CONTENT_TYPES_PART);

      assert.ok(Buffer.isBuffer(bytes), `${workbook.label} must return a Buffer`);
      assert.strictEqual(
        bytes.length,
        CONTENT_TYPES_BYTE_LENGTH,
        `the content-types part of ${workbook.label} must be ${CONTENT_TYPES_BYTE_LENGTH} bytes`
      );
      assert.strictEqual(
        crypto.createHash('sha256').update(bytes).digest('hex'),
        CONTENT_TYPES_SHA256,
        `the content-types part of ${workbook.label} must be byte-identical to the measured fixture — ` +
          'which is evidence about the reader inflating the whole entry correctly as well as about the file'
      );

      /* Cross-checked against the package it describes, which a digest alone
       * cannot do: every part except the two relationship parts, which an
       * extension default covers, and the content-types part itself, which
       * describes rather than is described, must carry an explicit Override.
       * A workbook that gained or lost a part therefore fails here instead of
       * at run time. */
      const xml = bytes.toString('utf8');
      const declaredOverrides = [...xml.matchAll(/<Override PartName="([^"]+)"/gu)]
        .map((match) => match[1])
        .sort();
      const partsNeedingOverride = xlsxRead
        .listEntries(workbook.filePath)
        .filter((name) => !name.endsWith('.rels') && name !== CONTENT_TYPES_PART)
        .map((name) => `/${name}`)
        .sort();

      assert.deepStrictEqual(
        declaredOverrides,
        partsNeedingOverride,
        `${workbook.label}: the declared Overrides must be exactly the parts that need one`
      );
      assert.deepStrictEqual(
        [...xml.matchAll(/<Default Extension="([^"]+)"/gu)].map((match) => match[1]).sort(),
        ['rels', 'xml'],
        `${workbook.label}: the relationship parts must be covered by extension defaults`
      );
      assert.ok(
        declaredOverrides.includes(`/${WORKSHEET_PART}`),
        `${workbook.label}: the worksheet part — the only part the running feature reads — must be declared`
      );
    }
  });

  it('recovers the declared dimension and the header row of every worksheet', () => {
    for (const workbook of WORKBOOK_SHAPES) {
      const sheet = xlsxRead.readEntry(workbook.filePath, WORKSHEET_PART).toString('utf8');
      const declared = /<dimension[^>]*\bref="([^"]+)"/.exec(sheet);
      assert.ok(declared !== null, `${workbook.label} must declare a dimension`);
      assert.strictEqual(declared[1], workbook.dimension, `the dimension of ${workbook.label}`);

      const rows = xlsxRead.readSheetRows(workbook.filePath, WORKSHEET_PART);
      assert.strictEqual(
        rows.length,
        EXPECTED_KEY_SET.length + 1,
        `${workbook.label} must hold one header row and ten data rows`
      );
      assert.deepStrictEqual(
        Object.values(rows[0]),
        workbook.headers,
        `the header row of ${workbook.label}`
      );
      assert.strictEqual(
        Object.keys(rows[0]).length,
        workbook.headers.length,
        `${workbook.label} must hold exactly ${workbook.headers.length} header cells`
      );
    }
  });

  it('returns the key column header first, followed by the ten Student IDs', () => {
    for (const workbook of WORKBOOK_SHAPES) {
      assert.deepStrictEqual(
        xlsxRead.readColumn(workbook.filePath, WORKSHEET_PART, 'A'),
        ['Student ID', ...EXPECTED_KEY_SET],
        `column A of ${workbook.label}`
      );
    }
  });

  it('reads the column letter case-insensitively', () => {
    assert.deepStrictEqual(
      xlsxRead.readColumn(OTHER_INFO_WORKBOOK, WORKSHEET_PART, 'c'),
      xlsxRead.readColumn(OTHER_INFO_WORKBOOK, WORKSHEET_PART, 'C')
    );
  });

  it('reads the activity column that the store is seeded from', () => {
    assert.deepStrictEqual(xlsxRead.readColumn(OTHER_INFO_WORKBOOK, WORKSHEET_PART, 'C'), [
      'Extracurricular Activity',
      ...EXPECTED_SEED_PAIRS.map(([, activity]) => activity),
    ]);
  });
});


/* ========================================================================= *
 * Where the store lives, and when it is read
 *
 * Two properties that every other group in this file would pass without: each
 * of those cases loads an instance and then exercises it while the world holds
 * still, so an implementation that re-read `ACTIVITY_STORE` on every call, or
 * that cached the first document it parsed, would satisfy all of them.
 *
 * Both would be real defects. Re-reading the variable means a store path that
 * moved under a running service splits the records across two files, and each
 * half then looks complete to the loader. Caching the document means a second
 * writer — a person editing the file the README documents as inspectable — has
 * their edit silently discarded by the next submission, and a read reports a
 * state that is no longer on disk.
 *
 * So the environment is changed, and the file is replaced, BETWEEN two calls
 * on one instance. That is the only arrangement in which either defect is
 * visible.
 * ========================================================================= */

describe('store path resolution and per-call document reads', () => {
  it('resolves the store path once at load and ignores a later change to the environment', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const chosen = path.join(directory, 'chosen.json');
    const decoy = path.join(directory, 'decoy.json');
    const environmentOnEntry = process.env.ACTIVITY_STORE;
    t.after(() => {
      process.env.ACTIVITY_STORE = environmentOnEntry;
    });

    const store = freshStore(chosen);

    /* A complete, VALID document at the path the environment is about to name,
     * holding a record the workbook does not: `Decoy Club` for S010. If the
     * instance ever consults the environment again, this is what it returns,
     * and the assertions below say so by name rather than by absence. */
    const decoyRecord = submittedRecord('S010', 'Decoy Club', VALID_STAMP);
    const decoyBytes = await writeBytes(decoy, bodyOf([decoyRecord]));

    process.env.ACTIVITY_STORE = decoy;

    assert.strictEqual(
      store.storePath(),
      chosen,
      'the resolved path is fixed at module load, so a later environment change cannot move it'
    );
    assert.deepStrictEqual(
      await store.listActivities('S010'),
      [seededRecord('S010', 'Debate Society')],
      'the read must answer from the seed snapshot for the ABSENT chosen store, not from the valid document now named by the environment'
    );

    const outcome = await store.addActivity('S010', 'Marker Club');

    assert.strictEqual(outcome.created, true);
    assert.strictEqual(
      (await readDocument(chosen)).activities.length,
      EXPECTED_SEED_PAIRS.length + 1,
      'the submission must have been written to the path resolved at load'
    );
    await assertBytesUnchanged(
      decoy,
      decoyBytes,
      'the document at the newly configured path must be untouched'
    );
    assert.strictEqual(
      await exists(decoy + TEMPORARY_SUFFIX),
      false,
      'and nothing may have been staged beside it either'
    );
    assert.deepStrictEqual(
      (await fs.readdir(directory)).sort(),
      ['chosen.json', 'decoy.json'],
      'the directory must hold exactly the two documents, so no third file was written anywhere'
    );
  });

  it('re-reads the document on every read, so an external replacement is visible at once', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);
    const before = [submittedRecord('S003', 'Alpha Club', VALID_STAMP)];
    await writeBytes(storeFile, bodyOf(before));

    assert.deepStrictEqual(await store.listActivities('S003'), before);

    /* Replaced wholesale behind the instance's back, as a hand edit or a
     * restored backup would. Both records differ from the first document. */
    const after = [
      seededRecord('S003', 'Beta Club'),
      submittedRecord('S004', 'Gamma Club', '2026-09-16T07:00:00.000Z'),
    ];
    await writeBytes(storeFile, bodyOf(after));

    assert.deepStrictEqual(
      await store.listActivities('S003'),
      [seededRecord('S003', 'Beta Club')],
      'the same instance must answer from the document that is on disk NOW — a cached one would still report Alpha Club'
    );
    assert.deepStrictEqual(
      await store.listActivities('S004'),
      [submittedRecord('S004', 'Gamma Club', '2026-09-16T07:00:00.000Z')],
      'including records that did not exist at the time of the first read'
    );
  });

  it('re-reads the document before applying a submission, so an external edit is never overwritten', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t);
    await writeBytes(storeFile, bodyOf([submittedRecord('S003', 'Alpha Club', VALID_STAMP)]));

    /* The read is what would populate a cache, so it has to happen first for
     * this case to mean anything. */
    assert.deepStrictEqual(
      (await store.listActivities('S003')).map((record) => record.activity),
      ['Alpha Club']
    );

    const edited = [
      seededRecord('S005', 'Delta Club'),
      submittedRecord('S006', 'Epsilon Club', VALID_STAMP),
    ];
    await writeBytes(storeFile, bodyOf(edited));

    const outcome = await store.addActivity('S003', 'Zeta Club');

    assert.strictEqual(outcome.created, true);
    const document = await readDocument(storeFile);
    assert.deepStrictEqual(
      document.activities,
      [...edited, outcome.record],
      'the write must apply to the document as found on disk: both edited records preserved, the new one appended'
    );
    assert.strictEqual(
      document.activities.some((record) => record.activity === 'Alpha Club'),
      false,
      'a document cached from the earlier read would have resurrected the replaced record and destroyed the edit'
    );
  });

  it('compares the composite key against the document on disk, not against the one it last read', async (t) => {
    const context = 'an idempotent repeat against a replaced document';
    const { store, storeFile } = await makeIsolatedStore(t);
    await writeBytes(storeFile, bodyOf([submittedRecord('S003', 'Alpha Club', VALID_STAMP)]));
    await store.listActivities('S003');

    const replacement = [submittedRecord('S003', 'Omega Club', VALID_STAMP)];
    const replacementBytes = await writeBytes(storeFile, bodyOf(replacement));

    /* `Omega Club` exists only in the replacement, so recognizing it as a
     * repeat is only possible by reading the current document. */
    const outcome = await store.addActivity('S003', 'Omega Club');

    assert.strictEqual(
      outcome.created,
      false,
      'the dedupe comparison must run against the document on disk'
    );
    assert.deepStrictEqual(outcome.record, replacement[0]);
    await assertBytesUnchanged(storeFile, replacementBytes, context);
  });
});


/* ========================================================================= *
 * The reader fails closed on malformed worksheet XML
 *
 * Malformed markup is refused, never salvaged, because salvage is the
 * dangerous outcome: a valueless attribute becoming an empty string, a stray
 * delimiter stepped over, a present-but-unparseable `r` reference treated as
 * absent and given whatever column comes next, an inline string with no `<t>`
 * becoming `''`. Each of those silently erases, shifts or fabricates a value
 * in the one column the whole feature validates against. So the assertion is
 * never "it threw" — it is the named refusal code, plus evidence that no
 * salvaged value reached the caller.
 * ========================================================================= */

describe('the reader refuses malformed worksheet XML instead of salvaging it', () => {
  /**
   * Writes a one-entry package around a row of cells and returns its path.
   *
   * @param {import('node:test').TestContext} t The running case.
   * @param {string} directory The case's temporary directory.
   * @param {string} fileName The package file name.
   * @param {string} cellsXml The `<c>` elements of a single row.
   * @returns {Promise<string>} The package path.
   */
  async function packageOfCells(t, directory, fileName, cellsXml) {
    return writePackage(directory, fileName, [zipLocalEntry(WORKSHEET_PART, worksheetXml(cellsXml))]);
  }

  it('refuses a malformed attribute rather than recording or skipping it', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    /* Each of these carries a legitimate-looking value in column A. If the
     * reader salvaged the tag, `Robotics Club` would come back and the case
     * would see it instead of a refusal. */
    const malformedTags = [
      ['a valueless attribute', '<c r="A1" t="inlineStr" hidden><is><t>Robotics Club</t></is></c>'],
      ['a stray delimiter where a name belongs', '<c r="A1" ="x"><v>1</v></c>'],
      ['an unquoted attribute value', '<c r=A1 t="inlineStr"><is><t>Robotics Club</t></is></c>'],
      ['a repeated attribute', '<c r="A1" r="B1" t="inlineStr"><is><t>Robotics Club</t></is></c>'],
      [
        'attributes run together with no separating whitespace',
        '<c r="A1"t="inlineStr"><is><t>Robotics Club</t></is></c>',
      ],
      [
        'an attribute name that is not an XML name',
        '<c r="A1" 1bad="x" t="inlineStr"><is><t>Robotics Club</t></is></c>',
      ],
      [
        'a repeated __proto__ attribute, which an ordinary object would not record',
        '<c r="A1" __proto__="a" __proto__="b" t="inlineStr"><is><t>Robotics Club</t></is></c>',
      ],
    ];

    for (const [index, [description, cellsXml]] of malformedTags.entries()) {
      const context = `a worksheet with ${description}`;
      const filePath = await packageOfCells(t, directory, `malformed-${index}.xlsx`, cellsXml);

      const rowsError = captureThrow(
        () => xlsxRead.readSheetRows(filePath, WORKSHEET_PART),
        `${context} (readSheetRows)`
      );
      assertCode(rowsError, E_XLSX_MALFORMED_XML, `${context} (readSheetRows)`);

      const columnError = captureThrow(
        () => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'),
        `${context} (readColumn)`
      );
      assertCode(columnError, E_XLSX_MALFORMED_XML, `${context} (readColumn)`);
      assert.doesNotMatch(
        columnError.message,
        /Robotics Club/,
        `${context}: the refusal must not carry the salvaged cell value back to the caller`
      );
    }
  });

  it('refuses a present but malformed cell reference, while still honouring an absent one', async (t) => {
    const directory = await makeTemporaryDirectory(t);

    /* Both halves of a reference are bounded: the column ends at XFD and the
     * row at 1048576, so `A0`, `A01` and `A1048577` name no cell either. */
    for (const [index, reference] of [
      'A',
      '1',
      'A-1',
      '',
      'ZZZ1',
      'XFE1',
      'Ä1',
      'A0',
      'A01',
      'A1048577',
    ].entries()) {
      const context = `a cell whose r attribute is ${JSON.stringify(reference)}`;
      const filePath = await packageOfCells(
        t,
        directory,
        `reference-${index}.xlsx`,
        `<c r="${reference}" t="inlineStr"><is><t>S001</t></is></c>`
      );

      const error = captureThrow(() => xlsxRead.readSheetRows(filePath, WORKSHEET_PART), context);
      assertCode(error, E_XLSX_MALFORMED_XML, context);
    }

    /* The contrast that makes the refusal meaningful: a cell with NO `r` at
     * all is legal per ECMA-376 and still takes the next column, so the
     * reader is distinguishing "absent" from "present and wrong" rather than
     * refusing everything. */
    const implicit = await packageOfCells(
      t,
      directory,
      'implicit.xlsx',
      '<c t="inlineStr"><is><t>S001</t></is></c><c t="inlineStr"><is><t>Robotics Club</t></is></c>'
    );
    assert.deepStrictEqual(xlsxRead.readSheetRows(implicit, WORKSHEET_PART), [
      { A: 'S001', B: 'Robotics Club' },
    ]);
  });

  it('refuses an inline string with no <t>, but accepts an empty <t> as an empty value', async (t) => {
    const directory = await makeTemporaryDirectory(t);

    for (const [index, cellsXml] of [
      '<c r="A1" t="inlineStr"><is/></c>',
      '<c r="A1" t="inlineStr"/>',
      '<c r="A1" t="inlineStr"></c>',
    ].entries()) {
      const context = `an inline string with no <t> (${cellsXml})`;
      const filePath = await packageOfCells(t, directory, `inline-${index}.xlsx`, cellsXml);

      const error = captureThrow(
        () => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'),
        context
      );
      assertCode(error, E_XLSX_MALFORMED_XML, context);
    }

    /* A `<t></t>` element holding nothing is a legal empty value, and an
     * untyped empty cell is ordinary in a worksheet. Both must still read, or
     * this group would be passing by rejecting everything. */
    const emptyText = await packageOfCells(
      t,
      directory,
      'empty-text.xlsx',
      '<c r="A1" t="inlineStr"><is><t></t></is></c><c r="B1"/><c r="C1"><v>7</v></c>'
    );
    assert.deepStrictEqual(xlsxRead.readSheetRows(emptyText, WORKSHEET_PART), [
      { A: '', B: '', C: '7' },
    ]);
  });

  it('refuses worksheet bytes that are not valid UTF-8 rather than substituting U+FFFD', async (t) => {
    const context = 'a worksheet part holding an invalid UTF-8 sequence';
    const directory = await makeTemporaryDirectory(t);
    /* 0xFF cannot begin a UTF-8 sequence. `Buffer.prototype.toString('utf8')`
     * turns it into U+FFFD, which is exactly the silent alteration this
     * refusal exists to prevent: the label would arrive looking like a real
     * one and be stored. */
    const payload = Buffer.concat([
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Robotics',
        'utf8'
      ),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('Club</t></is></c></row></sheetData></worksheet>', 'utf8'),
    ]);
    const filePath = await writePackage(directory, 'invalid-utf8.xlsx', [
      zipLocalEntry(WORKSHEET_PART, payload),
    ]);

    const error = captureThrow(
      () => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'),
      context
    );
    assertCode(error, E_XLSX_MALFORMED_XML, context);
    assert.doesNotMatch(
      error.message,
      /\ufffd/,
      `${context}: the refusal must not have decoded the bytes at all`
    );

    /* `readEntry` hands back raw bytes and decodes nothing, so it is still
     * usable — the invalid byte survives verbatim, which is what lets an
     * inertness assertion inspect a part without interpreting it. */
    const bytes = xlsxRead.readEntry(filePath, WORKSHEET_PART);
    assert.ok(bytes.includes(0xff), `${context}: readEntry must return the bytes as they are`);
  });
});


/* ========================================================================= *
 * The cell-type subset, and the numbers that have to be numbers
 *
 * The reader's declared subset is `t="inlineStr"`, `t="n"`, and a cell with no
 * `t` at all, which ECMA-376 makes implicitly numeric. Everything else is
 * refused — and the refusal matters far more than a format nicety, because a
 * cell's text is returned VERBATIM. A type this reader does not interpret used
 * to yield the text of `<v>` unchanged, so `<c r="A2" t="str"><v>S999</v></c>`
 * in a substituted `student_details.xlsx` handed `S999` to the key-set read as
 * faithfully as the real workbook hands it `S001` — and that key set is the
 * whole of the referential integrity a submission is checked against.
 *
 * The same reasoning covers a numeric cell whose value is not a number: the
 * type is inside the subset, so only the content can give it away.
 * ========================================================================= */

describe('the reader refuses a cell whose declared type it cannot honour', () => {
  /**
   * Writes a package whose worksheet holds a real header row and one row of
   * cells beneath it.
   *
   * The header row is not decoration: a key-set read returns the header first
   * and the keys after it, so a fixture with only one row cannot show whether
   * an injected value would have arrived as a key.
   *
   * @param {string} directory The case's temporary directory.
   * @param {string} fileName The package file name.
   * @param {string} cellsXml The `<c>` elements of the second row.
   * @returns {Promise<string>} The package path.
   */
  async function packageOfSecondRow(directory, fileName, cellsXml) {
    return writePackage(directory, fileName, [
      zipLocalEntry(
        WORKSHEET_PART,
        worksheetXmlOfRows(
          [rowXml(1, inlineStringCell('A1', 'Student ID')), rowXml(2, cellsXml)],
          'A1:B2'
        )
      ),
    ]);
  }

  it('refuses every cell type outside the subset, wherever in the row the cell sits', async (t) => {
    const directory = await makeTemporaryDirectory(t);

    /* `b`, `d`, `e` and `str` are real ECMA-376 types this reader does not
     * interpret; `inlineString`, `N` and `S` are near-misses of the two it
     * does, which is exactly what a substituted package would reach for; and
     * an empty `t` is a type attribute that names nothing. */
    for (const [index, declaredType] of [
      'str',
      'b',
      'd',
      'e',
      'inlineString',
      'N',
      'S',
      '',
    ].entries()) {
      const context = `a cell declaring t=${JSON.stringify(declaredType)}`;
      const inSelection = await packageOfSecondRow(
        directory,
        `cell-type-${index}.xlsx`,
        `<c r="A2" t="${declaredType}"><v>S999</v></c>`
      );

      const error = assertCode(
        captureThrow(() => xlsxRead.readColumn(inSelection, WORKSHEET_PART, 'A'), context),
        E_XLSX_UNSUPPORTED_CELL_TYPE,
        context
      );
      assertMessageMentions(
        error,
        /A2/u,
        'the refusal must name the cell whose type it declined, so a substituted workbook can be found'
      );
      assertMessageOmits(
        error,
        /S999/u,
        'the refusal must not carry the value the cell tried to state back to its caller'
      );

      /* And again for a cell in a column nobody asked for. A declared type is
       * a property of the package rather than of the request, so a package
       * holding a cell this reader cannot honour is not one it reports on —
       * the same rule the shared-string refusal already followed. */
      const outsideSelection = await packageOfSecondRow(
        directory,
        `cell-type-outside-${index}.xlsx`,
        `${inlineStringCell('A2', 'S001')}<c r="B2" t="${declaredType}"><v>S999</v></c>`
      );
      const outsideContext = `${context}, in a column that was not requested`;
      assertCode(
        captureThrow(
          () => xlsxRead.readColumn(outsideSelection, WORKSHEET_PART, 'A'),
          outsideContext
        ),
        E_XLSX_UNSUPPORTED_CELL_TYPE,
        outsideContext
      );
    }
  });

  it('keeps the shared-string refusal on its own code, so the two faults stay tellable apart', async (t) => {
    const context = 'a t="s" cell once every other type is refused too';
    const directory = await makeTemporaryDirectory(t);
    /* `t="s"` names a construct that IS resolvable in principle and that this
     * reader chooses not to resolve, because no package here carries the
     * string table it would need. That is a different statement from "this
     * type is outside the subset", and a caller that wants to tell a missing
     * string table from an unreadable cell needs the two codes separate. */
    const filePath = await packageOfSecondRow(
      directory,
      'shared-string-still-distinct.xlsx',
      '<c r="A2" t="s"><v>0</v></c>'
    );

    assertCode(
      captureThrow(() => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'), context),
      E_XLSX_SHARED_STRINGS_UNSUPPORTED,
      context
    );
    assert.notStrictEqual(
      E_XLSX_SHARED_STRINGS_UNSUPPORTED,
      E_XLSX_UNSUPPORTED_CELL_TYPE,
      'the two refusals must not collapse into one code'
    );
  });

  it('refuses a numeric cell holding text, which is how a key would be smuggled through t="n"', async (t) => {
    const directory = await makeTemporaryDirectory(t);

    for (const [index, [description, cellsXml]] of [
      ['an explicit t="n" cell', '<c r="A2" t="n"><v>S999</v></c>'],
      ['an untyped cell, which ECMA-376 makes numeric', '<c r="A2"><v>S999</v></c>'],
    ].entries()) {
      const context = `${description} holding text`;
      const filePath = await packageOfSecondRow(directory, `numeric-text-${index}.xlsx`, cellsXml);

      const error = assertCode(
        captureThrow(() => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'), context),
        E_XLSX_UNSUPPORTED_CELL_TYPE,
        context
      );
      assertMessageMentions(
        error,
        /A2/u,
        'the refusal must name the cell whose value disagreed with its type'
      );
    }

    /* The contrast that makes those two refusals meaningful: the identical
     * fixture with a number in the cell reads straight through, so the cases
     * above are refusing the CONTENT rather than the shape of the fixture. */
    const numeric = await packageOfSecondRow(
      directory,
      'numeric-number.xlsx',
      '<c r="A2" t="n"><v>999</v></c>'
    );
    assert.deepStrictEqual(
      xlsxRead.readColumn(numeric, WORKSHEET_PART, 'A'),
      ['Student ID', '999'],
      'a numeric cell holding a number still reads, and still arrives as the string the package stored'
    );
  });

  it('reads every numeric form a writer produces, and refuses text that only looks numeric', async (t) => {
    const directory = await makeTemporaryDirectory(t);

    /* All of these are in the lexical space of a numeric cell. The two long
     * floats are the exact values `student_academics.xlsx` stores for GPA, and
     * they must survive digit for digit: the value contract is a verbatim
     * string precisely so no float round-trip can alter one. */
    for (const [index, value] of [
      '20',
      '0',
      '-3',
      '+7',
      '7.9',
      '8.199999999999999',
      '8.800000000000001',
      '.5',
      '92.',
      '1e3',
      '1.5E-7',
    ].entries()) {
      const filePath = await packageOfSecondRow(
        directory,
        `numeric-ok-${index}.xlsx`,
        `<c r="A2" t="n"><v>${value}</v></c>`
      );
      assert.deepStrictEqual(
        xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'),
        ['Student ID', value],
        `the numeric literal ${JSON.stringify(value)} must read back exactly as written`
      );
    }

    /* And none of these is a number, however much the first two resemble one.
     * A tolerant reader that trimmed them would be inventing a value, and one
     * that returned them unchanged is the defect this group exists for. */
    for (const [index, value] of [
      ' 20',
      '20 ',
      'NaN',
      'INF',
      '-INF',
      '0x10',
      '1,5',
      '--3',
      '1e',
      '1.2.3',
      'S001',
    ].entries()) {
      const context = `a numeric cell holding ${JSON.stringify(value)}`;
      const filePath = await packageOfSecondRow(
        directory,
        `numeric-bad-${index}.xlsx`,
        `<c r="A2" t="n"><v>${value}</v></c>`
      );
      assertCode(
        captureThrow(() => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'), context),
        E_XLSX_UNSUPPORTED_CELL_TYPE,
        context
      );
    }
  });

  it('tolerates a blank numeric cell, which states no value to disagree with its type', async (t) => {
    const context = 'a worksheet of blank numeric cells';
    const directory = await makeTemporaryDirectory(t);
    /* A blank cell is ordinary in a worksheet — a row inside the declared
     * dimension with nothing in that column — and it asserts no value at all,
     * so there is nothing for the lexical check to disagree with. Refusing it
     * would refuse a legitimate workbook, which is the opposite failure to the
     * one this group guards against. */
    const filePath = await writePackage(directory, 'blank-numeric.xlsx', [
      zipLocalEntry(
        WORKSHEET_PART,
        worksheetXml(
          '<c r="A1" t="n"/><c r="B1" t="n"></c><c r="C1" t="n"><v/></c><c r="D1"><v></v></c>',
          'A1:D1'
        )
      ),
    ]);

    assert.deepStrictEqual(
      xlsxRead.readSheetRows(filePath, WORKSHEET_PART),
      [{ A: '', B: '', C: '', D: '' }],
      context
    );
  });
});

/* ========================================================================= *
 * Markup that only looks like markup
 *
 * The reader finds elements by scanning text, which is sound for exactly one
 * class of document: one whose markup-looking text IS markup. XML offers three
 * ways to write text that is not — a comment, a CDATA section and a processing
 * instruction — and a fourth arrives through a raw `<` inside a tag. In every
 * one of them a crafted `<row>` carrying `S999` stays well-formed XML that
 * every conforming parser treats as inert, while a scanning reader walks
 * straight into it. One fabricated row in the key column is one fabricated
 * member of the key set, so the part is now validated as XML before a single
 * element is matched, and refused rather than salvaged.
 *
 * The first case below is the one that keeps the rest honest: it reads the
 * injected row with nothing hiding it, proving the payload every later fixture
 * conceals is a payload this reader would otherwise have returned.
 * ========================================================================= */

describe('the reader refuses markup it does not interpret rather than reading through it', () => {
  /** A real header row, so an injected value would arrive as a key. */
  const HEADER_ROW = rowXml(1, inlineStringCell('A1', 'Student ID'));

  /** The row every fixture in this group tries to smuggle past the reader. */
  const INJECTED_ROW = rowXml(2, inlineStringCell('A2', 'S999'));

  /** What the reader must never return for column A in this group. */
  const INJECTED_COLUMN = ['Student ID', 'S999'];

  /**
   * Writes a package around one worksheet part given verbatim.
   *
   * @param {string} directory The case's temporary directory.
   * @param {string} fileName The package file name.
   * @param {string} xml The worksheet part.
   * @returns {Promise<string>} The package path.
   */
  async function packageOfPart(directory, fileName, xml) {
    return writePackage(directory, fileName, [zipLocalEntry(WORKSHEET_PART, xml)]);
  }

  /**
   * Asserts a worksheet is refused with a code, and that the injected key did
   * not reach the caller by any of the three interpreted entry points.
   *
   * @param {string} filePath The synthetic package.
   * @param {string} expectedCode The refusal the case expects.
   * @param {string} context Names the case in the failure message.
   * @returns {Error} The refusal from the column read.
   */
  function assertRefusedEverywhere(filePath, expectedCode, context) {
    const refusal = assertCode(
      captureThrow(() => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'), `${context} (readColumn)`),
      expectedCode,
      `${context} (readColumn)`
    );
    assertCode(
      captureThrow(
        () => xlsxRead.readSheetRows(filePath, WORKSHEET_PART),
        `${context} (readSheetRows)`
      ),
      expectedCode,
      `${context} (readSheetRows)`
    );
    assertCode(
      captureThrow(
        () => xlsxRead.readSheetRows(filePath, WORKSHEET_PART, ['A']),
        `${context} (readSheetRows with a selection)`
      ),
      expectedCode,
      `${context} (readSheetRows with a selection)`
    );
    return refusal;
  }

  it('would read the injected row if nothing hid it, so every refusal below is a real one', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const filePath = await packageOfPart(
      directory,
      'injection-unhidden.xlsx',
      worksheetXmlOfRows([HEADER_ROW, INJECTED_ROW], 'A1:A2')
    );

    assert.deepStrictEqual(
      xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'),
      INJECTED_COLUMN,
      'the payload the rest of this group hides must be one the reader really would return, or those cases prove nothing'
    );
  });

  it('refuses an XML comment rather than reading the row hiding inside it', async (t) => {
    const context = 'a worksheet with a commented-out row after the header';
    const directory = await makeTemporaryDirectory(t);
    const filePath = await packageOfPart(
      directory,
      'injection-comment.xlsx',
      worksheetXmlOfRows([HEADER_ROW, `<!-- ${INJECTED_ROW} -->`], 'A1:A2')
    );

    const error = assertRefusedEverywhere(filePath, E_XLSX_MALFORMED_XML, context);
    assertMessageMentions(
      error,
      /comment/u,
      'the refusal must say which construct it declined, so a substituted package can be diagnosed'
    );
    assertMessageOmits(
      error,
      /S999/u,
      'the refusal must not carry the commented payload back to its caller'
    );
  });

  it('refuses a CDATA section, whether it hides a row or only a value', async (t) => {
    const directory = await makeTemporaryDirectory(t);

    for (const [index, [description, rowsXml]] of [
      ['a CDATA section hiding a whole row', [HEADER_ROW, `<![CDATA[${INJECTED_ROW}]]>`]],
      [
        'a CDATA section inside a cell value',
        [HEADER_ROW, '<row r="2"><c r="A2" t="inlineStr"><is><t><![CDATA[S999]]></t></is></c></row>'],
      ],
    ].entries()) {
      const context = `a worksheet with ${description}`;
      const filePath = await packageOfPart(
        directory,
        `injection-cdata-${index}.xlsx`,
        worksheetXmlOfRows(rowsXml, 'A1:A2')
      );

      const error = assertRefusedEverywhere(filePath, E_XLSX_MALFORMED_XML, context);
      assertMessageMentions(error, /CDATA/u, 'the refusal must say which construct it declined');
    }
  });

  it('refuses a processing instruction, while still accepting a leading XML declaration', async (t) => {
    const directory = await makeTemporaryDirectory(t);

    for (const [index, [description, rowsXml]] of [
      ['a processing instruction hiding a row', [HEADER_ROW, `<?hidden ${INJECTED_ROW} ?>`]],
      ['a stylesheet instruction, whose name only begins like a declaration', [
        '<?xml-stylesheet href="x.xsl"?>',
        HEADER_ROW,
      ]],
    ].entries()) {
      const context = `a worksheet with ${description}`;
      const filePath = await packageOfPart(
        directory,
        `injection-pi-${index}.xlsx`,
        worksheetXmlOfRows(rowsXml, 'A1:A2')
      );

      const error = assertRefusedEverywhere(filePath, E_XLSX_MALFORMED_XML, context);
      assertMessageMentions(
        error,
        /processing instruction/u,
        'the refusal must say which construct it declined'
      );
    }

    /* The leading declaration every part is entitled to — `worksheetXmlOfRows`
     * writes one, and `xl/theme/theme1.xml` in each workbook carries one — must
     * still be accepted, or this rule would refuse the packages it protects. */
    const declared = await packageOfPart(
      directory,
      'declaration-accepted.xlsx',
      worksheetXmlOfRows([HEADER_ROW], 'A1:A1')
    );
    assert.deepStrictEqual(
      xlsxRead.readColumn(declared, WORKSHEET_PART, 'A'),
      ['Student ID'],
      'a part beginning with an XML declaration must still read'
    );
  });

  it('refuses markup hidden inside the XML declaration, and holds the declaration to its grammar', async (t) => {
    const directory = await makeTemporaryDirectory(t);

    /* The declaration is the one region the validation consumes whole instead
     * of walking element by element, which makes it the one place markup could
     * hide from it. A pseudo-attribute carrying a complete `<sheetData>` is
     * read by the element matching as the worksheet's rows — and because the
     * matching takes the FIRST `<sheetData>`, the injected rows win outright
     * rather than merely being appended. So the declaration is matched against
     * the grammar XML 1.0 fixes for it, which admits only version, encoding
     * and standalone with quoted values and therefore cannot contain `<`. */
    const hidden = `<sheetData>${INJECTED_ROW}</sheetData>`;
    const injected = await packageOfPart(
      directory,
      'injection-declaration.xlsx',
      `<?xml version="1.0" hidden="${hidden}"?>` +
        `<worksheet><sheetData>${HEADER_ROW}${rowXml(2, inlineStringCell('A2', 'S001'))}` +
        '</sheetData></worksheet>'
    );

    const error = assertRefusedEverywhere(
      injected,
      E_XLSX_MALFORMED_XML,
      'a declaration whose pseudo-attribute holds a whole sheetData element'
    );
    assertMessageMentions(
      error,
      /XML declaration/u,
      'the refusal must say that the declaration itself was not well formed'
    );

    /* Every other way a declaration can be wrong, each of which a skip to the
     * first `?>` would have accepted. The last one hides the terminating `?>`
     * inside a quoted value, so the region up to the first `?>` is not a
     * declaration at all. */
    for (const [index, [description, declaration]] of [
      ['a pseudo-attribute that is not part of the grammar', '<?xml version="1.0" hidden="x"?>'],
      ['no version at all', '<?xml encoding="UTF-8"?>'],
      ['the pseudo-attributes out of order', '<?xml encoding="UTF-8" version="1.0"?>'],
      ['an unquoted version', '<?xml version=1.0?>'],
      ['a standalone value outside yes and no', '<?xml version="1.0" standalone="maybe"?>'],
      ['a terminating ?> hidden inside a value', '<?xml version="1.0" encoding="?>"?>'],
    ].entries()) {
      const context = `a declaration with ${description}`;
      const filePath = await packageOfPart(
        directory,
        `declaration-bad-${index}.xlsx`,
        `${declaration}<worksheet><sheetData>${HEADER_ROW}</sheetData></worksheet>`
      );

      assertCode(
        captureThrow(() => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'), context),
        E_XLSX_MALFORMED_XML,
        context
      );
    }

    /* And every form the grammar does permit must still read, or this rule
     * would refuse the packages it exists to protect: `xl/theme/theme1.xml` in
     * each of the three workbooks carries the version-only form, and
     * `xl/worksheets/sheet1.xml` carries no declaration at all. */
    for (const [index, [description, declaration]] of [
      ['version only, as every theme part in this repository writes it', '<?xml version="1.0"?>'],
      ['version and encoding', '<?xml version="1.0" encoding="UTF-8"?>'],
      [
        'version, encoding and standalone',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      ],
      ['single-quoted values', "<?xml version='1.0' encoding='UTF-8'?>"],
      ['whitespace around every equals sign', '<?xml  version = "1.0"  encoding = "UTF-8" ?>'],
      ['no declaration at all, as every worksheet part in this repository', ''],
    ].entries()) {
      const filePath = await packageOfPart(
        directory,
        `declaration-ok-${index}.xlsx`,
        `${declaration}<worksheet><sheetData>${HEADER_ROW}</sheetData></worksheet>`
      );

      assert.deepStrictEqual(
        xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'),
        ['Student ID'],
        `a part declaring ${description} must still read`
      );
    }
  });

  it('refuses a markup declaration, including a DOCTYPE that defines an entity', async (t) => {
    const context = 'a worksheet preceded by a DOCTYPE defining an entity';
    const directory = await makeTemporaryDirectory(t);
    /* A DOCTYPE is refused for the same reason as a comment — this reader does
     * not interpret it and will not skip it — and refusing it also keeps
     * entity definitions of every kind outside the door, which is the surface
     * an XML parser has to be configured against. */
    const filePath = await packageOfPart(
      directory,
      'injection-doctype.xlsx',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<!DOCTYPE worksheet [<!ENTITY injected "S999">]>' +
        `<worksheet><sheetData>${HEADER_ROW}</sheetData></worksheet>`
    );

    const error = assertRefusedEverywhere(filePath, E_XLSX_MALFORMED_XML, context);
    assertMessageMentions(
      error,
      /markup declaration/u,
      'the refusal must say which construct it declined'
    );
  });

  it('refuses a raw < inside an attribute value, where a row would otherwise hide from the scan', async (t) => {
    const context = 'a row whose attribute value holds a complete cell element';
    const directory = await makeTemporaryDirectory(t);
    /* XML forbids a raw `<` in an attribute value, so nothing legitimate is
     * lost. What is gained: the value below ends with `>` and holds a whole
     * `<c>` element, which a scan for the next cell inside this row would find
     * and read as real. The single quotes keep it inside the double-quoted
     * attribute, so the document is otherwise shaped exactly like a real row. */
    const filePath = await packageOfPart(
      directory,
      'injection-attribute.xlsx',
      worksheetXmlOfRows(
        [
          HEADER_ROW,
          '<row r="2" customFormat="' +
            "<c r='A2' t='inlineStr'><is><t>S999</t></is></c>" +
            `">${inlineStringCell('A2', 'S001')}</row>`,
        ],
        'A1:A2'
      )
    );

    const error = assertRefusedEverywhere(filePath, E_XLSX_MALFORMED_XML, context);
    assertMessageMentions(
      error,
      /attribute value/u,
      'the refusal must say where the stray delimiter was found'
    );
  });

  it('refuses two cells of one row landing in the same column, rather than keeping the last', async (t) => {
    const directory = await makeTemporaryDirectory(t);

    /* Keeping the last silently is how an appended duplicate overwrites a real
     * Student ID or activity label with no error anywhere. The third case
     * pairs an unreferenced cell with an explicit one, because the implicit
     * "next column" rule is the other way two cells reach one column. */
    for (const [index, [description, cellsXml, column]] of [
      [
        'two cells with the same reference',
        `${inlineStringCell('A2', 'S001')}${inlineStringCell('A2', 'S999')}`,
        'A',
      ],
      [
        'two cells with the same reference in a column nobody asked for',
        `${inlineStringCell('A2', 'S001')}${inlineStringCell('B2', 'x')}${inlineStringCell('B2', 'y')}`,
        'A',
      ],
      [
        'an unreferenced cell colliding with an explicit one',
        `<c t="inlineStr"><is><t>S001</t></is></c>${inlineStringCell('A2', 'S999')}`,
        'A',
      ],
    ].entries()) {
      const context = `a row holding ${description}`;
      const filePath = await packageOfPart(
        directory,
        `duplicate-cell-${index}.xlsx`,
        worksheetXmlOfRows([HEADER_ROW, `<row r="2">${cellsXml}</row>`], 'A1:B2')
      );

      const error = assertCode(
        captureThrow(
          () => xlsxRead.readColumn(filePath, WORKSHEET_PART, column),
          context
        ),
        E_XLSX_MALFORMED_XML,
        context
      );
      assertMessageMentions(
        error,
        /two cells/u,
        'the refusal must say that one cell of the row was stated twice'
      );
    }
  });

  it('refuses an interpreted element sitting somewhere the reader does not read it', async (t) => {
    const directory = await makeTemporaryDirectory(t);

    /* Each of these is well-formed XML whose elements are in the wrong place,
     * and each puts a value where one of the reader's span searches would find
     * it: a row outside `<sheetData>`, a cell inside another cell — where the
     * first `</c>` would end the outer cell and both texts would run together
     * — and a `<t>` under `<v>`, which an inline-string read would pick up. */
    for (const [index, [description, xml]] of [
      [
        'a row outside sheetData',
        `<worksheet><sheetPr>${INJECTED_ROW}</sheetPr><sheetData>${HEADER_ROW}</sheetData></worksheet>`,
      ],
      [
        'a cell nested inside another cell',
        `<worksheet><sheetData>${HEADER_ROW}<row r="2"><c r="A2" t="inlineStr"><is><t>S001</t></is>` +
          '<c r="A2" t="inlineStr"><is><t>S999</t></is></c></c></row></sheetData></worksheet>',
      ],
      [
        'a text element under a value element',
        `<worksheet><sheetData>${HEADER_ROW}` +
          '<row r="2"><c r="A2" t="inlineStr"><v><t>S999</t></v></c></row></sheetData></worksheet>',
      ],
    ].entries()) {
      const context = `a worksheet with ${description}`;
      const filePath = await packageOfPart(directory, `misplaced-${index}.xlsx`, xml);

      const error = assertRefusedEverywhere(filePath, E_XLSX_MALFORMED_XML, context);
      assertMessageMentions(
        error,
        /only inside/u,
        'the refusal must name the parent the element was expected in'
      );
    }
  });

  it('refuses a second sheetData element, whose rows would shadow the real ones', async (t) => {
    const context = 'a worksheet holding two sheetData elements';
    const directory = await makeTemporaryDirectory(t);
    /* The descent takes the FIRST `<sheetData>`, so a second set of rows either
     * shadows the real one or is ignored depending on document order — which
     * is not something a reader may decide silently. Here the injected rows
     * come first, which is the order that wins. */
    const filePath = await packageOfPart(
      directory,
      'two-sheetdata.xlsx',
      '<worksheet>' +
        `<sheetData>${HEADER_ROW}${INJECTED_ROW}</sheetData>` +
        `<sheetData>${HEADER_ROW}</sheetData>` +
        '</worksheet>'
    );

    const error = assertRefusedEverywhere(filePath, E_XLSX_MALFORMED_XML, context);
    assertMessageMentions(
      error,
      /more than one/u,
      'the refusal must say that the part held more than one of the element it reads rows from'
    );
  });

  it('refuses character data outside the root element and an end tag that closes nothing', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const body = worksheetXmlOfRows([HEADER_ROW], 'A1:A1');

    for (const [index, [description, xml]] of [
      ['text after the root element', `${body}S999`],
      ['text before the root element', body.replace('<worksheet', 'S999<worksheet')],
      ['an end tag with nothing open', `${body}</worksheet>`],
    ].entries()) {
      const context = `a worksheet with ${description}`;
      const filePath = await packageOfPart(directory, `epilog-${index}.xlsx`, xml);

      assertCode(
        captureThrow(() => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'), context),
        E_XLSX_MALFORMED_XML,
        context
      );
    }

    /* Whitespace around the root is legal and has to stay legal: every
     * `xl/theme/theme1.xml` in this repository ends with a newline. */
    const padded = await packageOfPart(directory, 'padded.xlsx', `${body}\n  \n`);
    assert.deepStrictEqual(
      xlsxRead.readColumn(padded, WORKSHEET_PART, 'A'),
      ['Student ID'],
      'whitespace after the root element must not be mistaken for character data'
    );
  });

  it('still reads the forms a real worksheet writes', async (t) => {
    const directory = await makeTemporaryDirectory(t);

    /* The group would be worthless if it passed by refusing everything, and
     * each of these is a shape the reader must keep reading: the rich-text
     * form of an inline string, whose runs make up one logical value; an
     * attribute value holding a raw `>`, which XML permits and a scan for the
     * next `>` would mistake for the end of the tag; and a self-closing
     * element among elements the reader does not interpret at all. */
    const richText = await packageOfPart(
      directory,
      'rich-text.xlsx',
      worksheetXmlOfRows(
        ['<row r="1"><c r="A1" t="inlineStr"><is><r><t>Robotics</t></r><r><t> Club</t></r></is></c></row>'],
        'A1:A1'
      )
    );
    assert.deepStrictEqual(
      xlsxRead.readColumn(richText, WORKSHEET_PART, 'A'),
      ['Robotics Club'],
      'the runs of a rich-text inline string make up one value'
    );

    const awkwardAttribute = await packageOfPart(
      directory,
      'attribute-with-gt.xlsx',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet><sheetPr><outlinePr summaryBelow="1"/></sheetPr><cols><col min="1" max="1"/></cols>' +
        `<sheetData><row r="1" customFormat="a>b">${inlineStringCell('A1', 'S001')}</row></sheetData>` +
        '<pageMargins left="0.7"/></worksheet>'
    );
    assert.deepStrictEqual(
      xlsxRead.readColumn(awkwardAttribute, WORKSHEET_PART, 'A'),
      ['S001'],
      'a raw > inside an attribute value is legal XML and must not end the tag'
    );
  });
});

/* ========================================================================= *
 * The reader bounds what it reads, inflates and expands
 *
 * `inflateRawSync` left to its defaults will produce output up to
 * `buffer.kMaxLength` and will silently accept trailing bytes after the first
 * valid stream, and `readFileSync` will allocate a file of any size. Against
 * fixed reference files of six kilobytes, that is an unbounded cost for no
 * benefit: a substituted package could exhaust the process. The ceilings are
 * asserted from the outside — a fixture just past each one — and the
 * expansion case is deliberately tiny on disk, because that is the shape of
 * the attack the ceiling exists for.
 * ========================================================================= */

describe('the reader bounds the resources one package may consume', () => {
  it('refuses a package larger than the documented ceiling', async (t) => {
    const context = `a package of ${MAX_PACKAGE_BYTES + 64} bytes`;
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'oversized.xlsx', [
      zipLocalEntry(WORKSHEET_PART, Buffer.alloc(MAX_PACKAGE_BYTES + 64, 0x41), {
        method: COMPRESSION_STORED,
      }),
    ]);

    const listError = captureThrow(() => xlsxRead.listEntries(filePath), `${context} (listEntries)`);
    assertCode(listError, E_XLSX_LIMIT_EXCEEDED, `${context} (listEntries)`);

    const readError = captureThrow(
      () => xlsxRead.readEntry(filePath, WORKSHEET_PART),
      `${context} (readEntry)`
    );
    assertCode(readError, E_XLSX_LIMIT_EXCEEDED, `${context} (readEntry)`);
  });

  it('refuses an entry declaring more compressed bytes than one entry may hold', async (t) => {
    const context = `an entry declaring ${MAX_ENTRY_COMPRESSED_BYTES + 64} compressed bytes`;
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'big-entry.xlsx', [
      zipLocalEntry(WORKSHEET_PART, Buffer.alloc(MAX_ENTRY_COMPRESSED_BYTES + 64, 0x41), {
        method: COMPRESSION_STORED,
      }),
    ]);

    /* The walk itself is fine — the package is well formed and inside the
     * package ceiling — so this is specifically the per-entry bound. */
    assert.deepStrictEqual(xlsxRead.listEntries(filePath), [WORKSHEET_PART]);

    const error = captureThrow(() => xlsxRead.readEntry(filePath, WORKSHEET_PART), context);
    assertCode(error, E_XLSX_LIMIT_EXCEEDED, context);
  });

  it('refuses a small entry that would expand past the per-part ceiling', async (t) => {
    const context = 'a highly compressible entry expanding past the part ceiling';
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'bomb.xlsx', [
      zipLocalEntry(WORKSHEET_PART, Buffer.alloc(MAX_PART_BYTES + 1024, 0x41)),
    ]);

    /* The point of the ceiling: the file on disk is trivially small, so no
     * check on the package size could have caught this one. */
    const { size } = await fs.stat(filePath);
    assert.ok(
      size < 64 * 1024,
      `${context}: the fixture must stay small to prove the expansion is what is bounded; it is ${size} bytes`
    );

    const error = captureThrow(() => xlsxRead.readEntry(filePath, WORKSHEET_PART), context);
    assertCode(error, E_XLSX_LIMIT_EXCEEDED, context);
  });

  it('refuses an entry whose declared size overshoots its DEFLATE stream', async (t) => {
    const context = 'an entry with trailing bytes after the end of its stream';
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'trailing.xlsx', [
      zipLocalEntry(WORKSHEET_PART, worksheetXml('<c r="A1" t="inlineStr"><is><t>S001</t></is></c>'), {
        trailingBytes: Buffer.from([0x01, 0x02, 0x03, 0x04]),
      }),
    ]);

    /* The default `inflateRawSync` accepts this silently and returns the
     * worksheet, which means the local header's size field disagrees with the
     * stream and nothing notices — including for every entry after it. */
    const error = captureThrow(() => xlsxRead.readEntry(filePath, WORKSHEET_PART), context);
    assertCode(error, E_XLSX_TRUNCATED, context);
  });

  it('refuses entry data that is not a DEFLATE stream at all', async (t) => {
    const context = 'an entry whose compressed bytes will not inflate';
    const directory = await makeTemporaryDirectory(t);
    const filePath = await writePackage(directory, 'corrupt.xlsx', [
      zipLocalEntry(WORKSHEET_PART, worksheetXml(''), { corruptData: true }),
    ]);

    const error = captureThrow(() => xlsxRead.readEntry(filePath, WORKSHEET_PART), context);
    assertCode(error, E_XLSX_TRUNCATED, context);
  });

  it('still reads every real workbook, which sits far inside all three ceilings', async () => {
    for (const workbook of WORKBOOK_SHAPES) {
      const { size } = await fs.stat(workbook.filePath);
      assert.ok(
        size < MAX_PACKAGE_BYTES,
        `${workbook.label} must sit inside the package ceiling; it is ${size} bytes`
      );
      assert.deepStrictEqual(
        xlsxRead.readColumn(workbook.filePath, WORKSHEET_PART, 'A'),
        ['Student ID', ...EXPECTED_KEY_SET],
        `${workbook.label} must still read with the ceilings in force`
      );
    }
  });

  it('validates a tag carrying many attributes in linear time, so a part inside the ceilings cannot block it', async (t) => {
    const directory = await makeTemporaryDirectory(t);

    /* The lexical validation must find the end of every tag, which means
     * walking its attribute values. Doing that by searching BACKWARDS for a
     * stray `<` from the end of each value rescans the whole tag once per
     * attribute: quadratic in the length of one tag, and this reader is
     * synchronous and runs inside the request process, so a part of a few
     * hundred kilobytes — well inside the four-megabyte package and part
     * ceilings, and accepted rather than refused — would block the service for
     * as long as the scan took. Measured on the quadratic form: 291 KiB of
     * attributes took 731ms, and each doubling of the input quadrupled it.
     *
     * The assertion is a RATIO against this machine's own measurement of the
     * small fixture rather than a fixed millisecond budget, because a budget
     * either fails on a loaded host or passes a regression on a fast one.
     * Sixteen times the input costs sixteen times the work when the scan is
     * linear and two hundred and fifty-six when it is quadratic, so the
     * threshold sits far from both. Two guards keep it from firing on noise
     * alone: the baseline is floored, and a run fast in absolute terms passes
     * whatever its ratio — the quadratic form could not be fast in absolute
     * terms at this size. */
    const SMALL_ATTRIBUTE_COUNT = 1000;
    const LARGE_ATTRIBUTE_COUNT = 16000;
    const GROWTH_ALLOWANCE = 60;
    const BASELINE_FLOOR_MS = 2;
    const ABSOLUTE_ALLOWANCE_MS = 25;
    const REPEATS = 3;

    /**
     * Builds a worksheet whose ROOT element carries many well-formed, unique
     * attributes. The root is deliberate: the reader interprets no attribute
     * of `<worksheet>`, so the only code that walks them is the validation
     * under test.
     *
     * @param {number} count How many attributes to write.
     * @returns {string} The part's XML.
     */
    function partWithAttributes(count) {
      const attributes = [];
      for (let index = 0; index < count; index += 1) {
        attributes.push(` a${index}="value${index}"`);
      }
      return (
        `<worksheet${attributes.join('')}>` +
        `<sheetData>${rowXml(1, inlineStringCell('A1', 'Student ID'))}</sheetData></worksheet>`
      );
    }

    /**
     * Reads a package repeatedly and returns the fastest run, which is the
     * measurement least disturbed by anything else on the host.
     *
     * @param {string} filePath The package to read.
     * @returns {number} Milliseconds.
     */
    function fastestReadMs(filePath) {
      let fastest = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < REPEATS; attempt += 1) {
        const started = process.hrtime.bigint();
        const column = xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A');
        const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
        assert.deepStrictEqual(
          column,
          ['Student ID'],
          'the fixture must be ACCEPTED and read, so the time measured is validation work rather than an early refusal'
        );
        fastest = Math.min(fastest, elapsed);
      }
      return fastest;
    }

    const small = await writePackage(directory, 'attributes-small.xlsx', [
      zipLocalEntry(WORKSHEET_PART, partWithAttributes(SMALL_ATTRIBUTE_COUNT)),
    ]);
    const large = await writePackage(directory, 'attributes-large.xlsx', [
      zipLocalEntry(WORKSHEET_PART, partWithAttributes(LARGE_ATTRIBUTE_COUNT)),
    ]);

    const baselineMs = Math.max(fastestReadMs(small), BASELINE_FLOOR_MS);
    const largeMs = fastestReadMs(large);

    assert.ok(
      largeMs <= ABSOLUTE_ALLOWANCE_MS || largeMs <= baselineMs * GROWTH_ALLOWANCE,
      `${LARGE_ATTRIBUTE_COUNT} attributes took ${largeMs.toFixed(1)}ms against a ${baselineMs.toFixed(1)}ms ` +
        `baseline for ${SMALL_ATTRIBUTE_COUNT}: ${(largeMs / baselineMs).toFixed(1)} times the time for ` +
        `${LARGE_ATTRIBUTE_COUNT / SMALL_ATTRIBUTE_COUNT} times the input, which is superlinear rather than linear`
    );
  });

  it('refuses a source whose bytes cannot be bounded before they are read', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    /* A ceiling checked against a descriptor's reported size is only a ceiling
     * while that size describes a finite run of bytes. A directory, a device or
     * a pipe either reports nothing useful or yields bytes until something
     * closes it, so the source is refused before anything is read at all.
     *
     * Which of these can even be opened differs by platform — a directory
     * opens on Windows and fails with EISDIR elsewhere — so a candidate the
     * platform refuses to open is passed over, and the case asserts that at
     * least one was really exercised rather than passing by skipping them all. */
    const candidates = [[directory, 'a directory']];
    candidates.push(
      process.platform === 'win32'
        ? ['\\\\.\\NUL', 'the NUL device']
        : ['/dev/zero', 'the zero device']
    );

    let exercised = 0;
    for (const [candidate, description] of candidates) {
      let descriptor;
      try {
        descriptor = fsSync.openSync(candidate, 'r');
      } catch {
        continue;
      }
      fsSync.closeSync(descriptor);
      exercised += 1;

      const context = `${description} offered as a package`;
      const error = assertCode(
        captureThrow(() => xlsxRead.listEntries(candidate), context),
        E_XLSX_UNSUPPORTED_SOURCE,
        context
      );
      assertMessageMentions(
        error,
        /regular file/u,
        'the refusal must say that the source was not a regular file'
      );
      assertCode(
        captureThrow(() => xlsxRead.readEntry(candidate, WORKSHEET_PART), `${context} (readEntry)`),
        E_XLSX_UNSUPPORTED_SOURCE,
        `${context} (readEntry)`
      );
    }

    assert.ok(
      exercised > 0,
      'no non-regular source could be opened on this platform, so this case proved nothing'
    );
  });

  it('bounds the read itself, so a descriptor under-reporting its size cannot lift the ceiling', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const oversized = path.join(directory, 'grown.xlsx');
    await fs.writeFile(oversized, Buffer.alloc(MAX_PACKAGE_BYTES + 64, 0x41));
    const honest = await writePackage(directory, 'honest.xlsx', [
      zipLocalEntry(WORKSHEET_PART, worksheetXml(inlineStringCell('A1', 'Student ID'), 'A1:A1')),
    ]);

    /* Enforcing the ceiling once, against `fstat`, and then reading without a
     * bound would leave it defeatable two ways. Those are two operations on a
     * filesystem other processes can write to, so the size can be stale by the
     * time the bytes are read — and a source that misreports its size defeats
     * the check outright. Reproducing either for real from one synchronous
     * thread is not possible, so the descriptor is made to report the stale
     * number directly: zero, which is what several non-regular sources report,
     * and a small value, which is what a file that has since grown reports.
     * The file on disk is past the ceiling in both.
     *
     * One mock, whose reported size the loop moves, because two overlapping
     * mocks of one method do not unwind in a defined order. `t.mock` restores
     * it when the case ends whatever happens, and the restore below makes the
     * final assertion run against the real `fstatSync`. */
    const realFstatSync = fsSync.fstatSync;
    let reportedSize = 0;
    t.mock.method(fsSync, 'fstatSync', (...args) => {
      const stats = realFstatSync(...args);
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        size: reportedSize,
      });
    });

    for (const [size, description] of [
      [0, 'a descriptor reporting no bytes at all'],
      [64, 'a descriptor reporting the size the file had before it grew'],
    ]) {
      reportedSize = size;
      const context = `${description} for a file past the package ceiling`;

      const error = assertCode(
        captureThrow(() => xlsxRead.listEntries(oversized), context),
        E_XLSX_LIMIT_EXCEEDED,
        context
      );
      assertMessageMentions(
        error,
        /yielded more than/u,
        'the refusal must say the ceiling was reached while reading, not merely that the metadata claimed too much'
      );
    }

    /* And the bound is on the bytes rather than on the claim in both
     * directions: with the descriptor still reporting nothing, a package well
     * inside the ceiling reads exactly as it always did. */
    reportedSize = 0;
    assert.deepStrictEqual(
      xlsxRead.readColumn(honest, WORKSHEET_PART, 'A'),
      ['Student ID'],
      'a package inside the ceiling must still read when its descriptor under-reports its size'
    );

    t.mock.restoreAll();

    assertCode(
      captureThrow(
        () => xlsxRead.listEntries(oversized),
        'the same oversized file with honest metadata'
      ),
      E_XLSX_LIMIT_EXCEEDED,
      'the same oversized file with honest metadata'
    );
  });
});


/* ========================================================================= *
 * The column contract, from A to XFD
 *
 * The reader's own message promises columns A to XFD, and a length check of
 * one-to-three letters is a different promise: it admits XFE through ZZZ,
 * which name no column at all. Case folding before validation is the second
 * half of the same gap — several non-ASCII letters uppercase onto ASCII ones,
 * so `ı` would be accepted as column I.
 * ========================================================================= */

describe('the reader accepts exactly the columns its contract promises', () => {
  it('accepts XFD, the last column of the grid, and reads it as empty', () => {
    const column = xlsxRead.readColumn(DETAILS_WORKBOOK, WORKSHEET_PART, LAST_COLUMN_LETTERS);
    assert.strictEqual(
      column.length,
      EXPECTED_KEY_SET.length + 1,
      'one value per worksheet row, header included'
    );
    assert.deepStrictEqual(
      new Set(column),
      new Set(['']),
      'no row of these workbooks has a cell in the last column of the grid'
    );
  });

  it('rejects a column past XFD, and a non-ASCII letter that would fold onto one', () => {
    /* These two fold onto ASCII letters, which is why the original input has
     * to be validated before any case fold rather than after it. */
    assert.strictEqual('\u0131'.toUpperCase(), 'I', 'U+0131 folds onto I');
    assert.strictEqual('\u017f'.toUpperCase(), 'S', 'U+017F folds onto S');

    for (const columnLetter of ['XFE', 'XZZ', 'ZZZ', '\u0131', '\u017f', 'A1', ' A']) {
      const context = `column ${JSON.stringify(columnLetter)}`;
      const error = captureThrow(
        () => xlsxRead.readColumn(DETAILS_WORKBOOK, WORKSHEET_PART, columnLetter),
        context
      );
      /* A caller argument fault, not a property of the package, so it must
       * stay a TypeError carrying none of the declared refusal codes. */
      assert.ok(error instanceof TypeError, `${context} must be a TypeError`);
      assert.strictEqual(error.code, undefined, `${context} must carry no refusal code`);
      assert.match(
        error.message,
        /A to XFD/,
        `${context}: the message must state the range that is accepted`
      );
    }
  });

  it('rejects a column selection that is not a non-empty array of column letters', () => {
    for (const selection of [[], 'A', {}, ['A', 'XFE'], ['A', ''], 0]) {
      const context = `selection ${JSON.stringify(selection)}`;
      const error = captureThrow(
        () => xlsxRead.readSheetRows(DETAILS_WORKBOOK, WORKSHEET_PART, selection),
        context
      );
      assert.ok(error instanceof TypeError, `${context} must be a TypeError`);
      assert.strictEqual(error.code, undefined, `${context} must carry no refusal code`);
    }

    /* Omitting the argument and passing null explicitly both mean "every
     * column". */
    assert.deepStrictEqual(
      xlsxRead.readSheetRows(DETAILS_WORKBOOK, WORKSHEET_PART, null),
      xlsxRead.readSheetRows(DETAILS_WORKBOOK, WORKSHEET_PART)
    );
  });
});


/* ========================================================================= *
 * A column read materialises only the column it was asked for
 *
 * `student_details.xlsx` holds a name, a date of birth, an email, a phone
 * number and a city beside every Student ID. The feature validates submissions
 * against column A and has no business holding the rest, so a key-set read
 * must not decode it — while the package's STRUCTURE must still be checked
 * everywhere, or a malformed worksheet would pass unnoticed. These cases pin
 * both halves, and the last one pins the cost: one file read, one inflate and
 * one parse per workbook for the whole seed fill.
 * ========================================================================= */

describe('a column read decodes only the columns it was asked for', () => {
  it('returns only the requested key for the identity workbook, leaving the personal columns undecoded', () => {
    const keyRows = xlsxRead.readSheetRows(DETAILS_WORKBOOK, WORKSHEET_PART, ['A']);

    assert.strictEqual(keyRows.length, EXPECTED_KEY_SET.length + 1);
    for (const [index, row] of keyRows.entries()) {
      assert.deepStrictEqual(
        Object.keys(row),
        ['A'],
        `row ${index + 1} must carry the requested column and nothing else`
      );
    }
    assert.deepStrictEqual(keyRows.map((row) => row.A), ['Student ID', ...EXPECTED_KEY_SET]);

    /* The synthetic markers of the columns beside the key: an `example.edu`
     * address, a phone in the contiguous run, a city. None may appear in what
     * a key-set read produces. */
    const selective = JSON.stringify(keyRows);
    for (const marker of ['example.edu', '98220110', 'Date of Birth', 'Email', 'Phone', 'City']) {
      assert.ok(
        !selective.includes(marker),
        `a key-set read must not materialise ${marker}`
      );
    }

    /* The scope of this claim, stated so it is not read as more than it is:
     * the reader decodes and validates the worksheet part as a whole — it must,
     * to refuse malformed or mis-encoded XML — and what it does not do is
     * EXTRACT an unrelated cell's text into a value. The walk descends by
     * index, so no substring of a row or of an unselected cell is created
     * either.
     *
     * And the control: an unfiltered read of the same workbook does contain
     * them, so the assertion above is about the selection rather than about
     * the workbook being empty. */
    const everything = JSON.stringify(xlsxRead.readSheetRows(DETAILS_WORKBOOK, WORKSHEET_PART));
    for (const marker of ['example.edu', '98220110', 'Email']) {
      assert.ok(
        everything.includes(marker),
        `an unfiltered read is expected to contain ${marker}, or this comparison proves nothing`
      );
    }
  });

  it('reads two columns of one worksheet in a single pass', () => {
    const rows = xlsxRead.readSheetRows(OTHER_INFO_WORKBOOK, WORKSHEET_PART, ['A', 'C']);

    assert.deepStrictEqual(rows, [
      { A: 'Student ID', C: 'Extracurricular Activity' },
      ...EXPECTED_SEED_PAIRS.map(([studentId, activity]) => ({ A: studentId, C: activity })),
    ]);
  });

  it('does not extract the value of a column it was not asked for', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    /* Column A is sound. Column B declares itself numeric and holds text,
     * which is a fault in the cell's VALUE and in nothing else: its start tag,
     * its reference, its type attribute and its `<v>` element are all well
     * formed, so every check the reader makes on structure passes over it
     * without complaint. Only extracting that value can discover it. A read of
     * column A therefore succeeds, and that success is the evidence that
     * column B's text was never turned into a value — the reason the reader
     * can read a Student ID without materialising the name, date of birth,
     * email, phone and city sitting beside it.
     *
     * The fixture is deliberately a value-level fault rather than a structural
     * one. A structural fault — an unclosed `<v>`, say — is refused for every
     * caller by the lexical validation the part passes through before any
     * element is matched, so it could no longer distinguish "not extracted"
     * from "not reached".
     *
     * What this does NOT claim: that the part's bytes are never in the
     * process. Refusing mis-encoded or malformed XML requires reading it. The
     * guarantee is about extraction. */
    const filePath = await writePackage(directory, 'unread-column.xlsx', [
      zipLocalEntry(
        WORKSHEET_PART,
        worksheetXml(
          '<c r="A1" t="inlineStr"><is><t>S001</t></is></c><c r="B1" t="n"><v>Robotics Club</v></c>'
        )
      ),
    ]);

    assert.deepStrictEqual(xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'), ['S001']);

    /* Asking for that column, or for every column, does surface it. */
    for (const [description, call] of [
      ['readColumn on the faulty column', () => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'B')],
      ['readSheetRows with no selection', () => xlsxRead.readSheetRows(filePath, WORKSHEET_PART)],
    ]) {
      assertCode(captureThrow(call, description), E_XLSX_UNSUPPORTED_CELL_TYPE, description);
    }
  });

  it('still refuses an inline string with no <t> in a column it was not asked for', async (t) => {
    const context = 'a t="inlineStr" cell with no <t> outside the selection';
    const directory = await makeTemporaryDirectory(t);
    /* The other half of the boundary: a cell must honour the STRUCTURE it
     * declares wherever it sits, because a worksheet that malformed is not one
     * this reader can report on. Establishing that needs only the presence of
     * the `<t>` element, never its text, so failing closed here costs no
     * data minimization. */
    const filePath = await writePackage(directory, 'unread-inline.xlsx', [
      zipLocalEntry(
        WORKSHEET_PART,
        worksheetXml(
          '<c r="A1" t="inlineStr"><is><t>S001</t></is></c><c r="B1" t="inlineStr"><is/></c>'
        )
      ),
    ]);

    const error = captureThrow(() => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'), context);
    assertCode(error, E_XLSX_MALFORMED_XML, context);
    assert.ok(
      error.message.includes('B1'),
      `${context}: the refusal must name the offending cell; received: ${error.message}`
    );
  });

  it('still refuses a shared-string cell that sits outside the selection', async (t) => {
    const context = 'a t="s" cell in a column that was not requested';
    const directory = await makeTemporaryDirectory(t);
    /* Structure is a property of the package, not of the caller's request: a
     * package carrying a string table this reader cannot resolve is refused
     * whichever column is asked for. */
    const filePath = await writePackage(directory, 'unread-shared.xlsx', [
      zipLocalEntry(
        WORKSHEET_PART,
        worksheetXml('<c r="A1" t="inlineStr"><is><t>S001</t></is></c><c r="B1" t="s"><v>0</v></c>')
      ),
    ]);

    const error = captureThrow(() => xlsxRead.readColumn(filePath, WORKSHEET_PART, 'A'), context);
    assertCode(error, E_XLSX_SHARED_STRINGS_UNSUPPORTED, context);
  });

  it('opens and inflates each workbook exactly once while filling the seed snapshot', async (t) => {
    const { store, storeFile } = await makeIsolatedStore(t, 'seed-io.json');
    const fsModule = require('node:fs');
    const realOpenSync = fsModule.openSync;
    const realInflateRawSync = zlib.inflateRawSync;
    const openedPackages = [];
    let inflateCalls = 0;

    /* The reader holds the `node:fs` and `node:zlib` module objects, so
     * counting on those objects counts its real calls. Both are restored
     * whatever the case does, and nothing else in this file depends on them
     * while it runs. */
    fsModule.openSync = (target, ...rest) => {
      if (String(target).endsWith('.xlsx')) {
        openedPackages.push(path.basename(String(target)));
      }
      return realOpenSync(target, ...rest);
    };
    zlib.inflateRawSync = (...args) => {
      inflateCalls += 1;
      return realInflateRawSync(...args);
    };
    t.after(() => {
      fsModule.openSync = realOpenSync;
      zlib.inflateRawSync = realInflateRawSync;
    });

    /* One read, which needs the key set and the seed snapshot: the key
     * authority once, the seed workbook once — NOT once per column. */
    const records = await store.listActivities('S001');
    assert.deepStrictEqual(records, [seededRecord('S001', 'Robotics Club')]);

    assert.deepStrictEqual(
      openedPackages.sort(),
      ['student_details.xlsx', 'student_other_info.xlsx'],
      'the seed fill must read the key authority once and the seed workbook once'
    );
    assert.strictEqual(
      inflateCalls,
      2,
      'two columns of one worksheet must cost one inflate, not one per column'
    );
    assert.strictEqual(
      await exists(storeFile),
      false,
      'a read must still create no store file'
    );

    /* Both caches are filled, so a second read costs no I/O at all. */
    const before = openedPackages.length;
    const inflatesBefore = inflateCalls;
    await store.listActivities('S002');
    assert.strictEqual(openedPackages.length, before, 'a cached read must open no workbook');
    assert.strictEqual(inflateCalls, inflatesBefore, 'a cached read must inflate nothing');
  });
});


/* ========================================================================= *
 * Write mechanics
 *
 * The document is rewritten whole on every change, because JSON offers
 * neither an append nor a transaction. What makes that safe is a
 * temp-file-and-rename behind a single-process mutex, and each of those two
 * mechanisms has a failure mode worth pinning: a partial document left behind
 * by a crashed write, and a promise chain left permanently rejected by a
 * failed one.
 * ========================================================================= */

describe('atomic replacement and the write mutex', () => {
  it('leaves a complete document and no staging file after a successful write', async (t) => {
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);

    await store.addActivity('S001', 'Chess Club');

    const text = await fs.readFile(storeFile, 'utf8');
    const document = JSON.parse(text);
    assert.strictEqual(document.schemaVersion, SCHEMA_VERSION);
    assert.strictEqual(
      text.endsWith('\n'),
      true,
      'the document is written as a complete text file, newline included'
    );
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      'the staging file must have been renamed onto the store, not copied or left behind'
    );

    /* A second write replaces the document wholesale and still leaves nothing
     * staged, so the mechanism is not a one-off. */
    await store.addActivity('S001', 'Quiz Club');
    assert.strictEqual((await readDocument(storeFile)).activities.length, 12);
    assert.strictEqual(await exists(temporaryFile), false);
  });

  it('honours a configured store path and stages beside it, not beside the source', async (t) => {
    const directory = await makeTemporaryDirectory(t);
    const nested = path.join(directory, 'nested');
    await fs.mkdir(nested);
    const configured = path.join(nested, 'submissions.json');
    const store = freshStore(configured);

    assert.strictEqual(
      store.storePath(),
      configured,
      'storePath() must return exactly what was configured, so a caller knows which file it is exercising'
    );

    /* The staging path is DERIVED from the resolved path rather than named
     * independently. Proving that needs an observation, not a claim: a
     * directory planted at exactly the derived name must be what the write
     * collides with. If the writer staged anywhere else, this would succeed. */
    const derived = `${configured}${TEMPORARY_SUFFIX}`;
    await fs.mkdir(derived);
    const blocked = await captureRejection(
      store.addActivity('S001', 'Chess Club'),
      'a directory occupying the derived staging path'
    );
    assertCode(blocked, E_STORE_WRITE_FAILED, 'a directory occupying the derived staging path');
    await fs.rm(derived, { recursive: true, force: true });

    await store.addActivity('S001', 'Chess Club');

    assert.strictEqual(await exists(configured), true, 'the store must be written where configured');
    assert.strictEqual(await exists(derived), false, 'the staging file must not survive the write');
    assert.deepStrictEqual(
      (await fs.readdir(nested)).sort(),
      ['submissions.json'],
      'the directory must hold the store and nothing else'
    );

    /* That the staging file sits in the STORE's own directory — which is what
     * keeps the rename on one filesystem, and therefore atomic — is proven by
     * observing the filesystem, not by comparing two paths this case computed
     * for itself. The listing is taken INSIDE the rename, which is the one
     * moment a staged file provably exists: the rename is what would adopt it,
     * and a publish refused for good removes it, so a listing taken after the
     * refusal reports nothing. Observing it here rather than afterwards is
     * what keeps this assertion about WHERE the implementation stages instead
     * of about what it leaves lying around. */
    const frozen = 'a rename refused after the staging file was written';
    const listingsAtPublish = [];
    t.mock.method(fs, 'rename', async () => {
      listingsAtPublish.push((await fs.readdir(nested)).sort());
      const refusal = new Error('scripted rename refusal, raised by the test harness');
      refusal.code = 'EPERM';
      throw refusal;
    });

    assertCode(
      await captureRejection(store.addActivity('S001', 'Quiz Club'), frozen),
      E_STORE_WRITE_FAILED,
      frozen
    );
    assert.deepStrictEqual(
      listingsAtPublish[0],
      ['submissions.json', 'submissions.json.tmp'],
      'the staged document must be observable in the store directory, under the name derived from the configured path'
    );
    assert.deepStrictEqual(
      (await fs.readdir(nested)).sort(),
      ['submissions.json'],
      'and a publish refused for good must leave nothing staged at rest beside it'
    );

    t.mock.restoreAll();

    assert.strictEqual(
      (await store.addActivity('S001', 'Quiz Club')).created,
      true,
      'and once the rename works the submission goes through'
    );
    assert.deepStrictEqual(
      (await fs.readdir(nested)).sort(),
      ['submissions.json'],
      'consuming the staging file again'
    );
  });

  it('replaces a stale staging file rather than ever reading it, and never inherits its mode', async (t) => {
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);
    /* What a dead process might have left: a truncated document, or bytes
     * that are not a document at all. Either way the next write replaces it,
     * so its contents can never be mistaken for the store. */
    await writeBytes(temporaryFile, '{"schemaVersion":1,"activities":[{"studentId":"S9');

    /* And planted PERMISSIVE, which is the second half of what a stale file
     * can donate. A writer that truncated this file in place would keep its
     * mode, and the rename would then publish the store with it — so the
     * store's own mode is what proves the staging file was recreated rather
     * than reused. Windows honours only the write bit through `chmod`, hence
     * the gate: the platform cannot express the fixture. */
    const posix = typeof process.getuid === 'function';
    await fs.chmod(temporaryFile, 0o666);
    if (posix) {
      assert.strictEqual(
        (await fs.stat(temporaryFile)).mode & 0o777,
        0o666,
        'the fixture must actually be permissive, or this case proves nothing about inheritance'
      );
    }

    const outcome = await store.addActivity('S001', 'Chess Club');

    assert.strictEqual(outcome.created, true);
    const document = await readDocument(storeFile);
    assert.strictEqual(document.activities.length, EXPECTED_SEED_PAIRS.length + 1);
    assert.ok(
      document.activities.every((record) => EXPECTED_KEY_SET.includes(record.studentId)),
      'no fragment of the stale staging file may have survived into the store'
    );
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      'the stale staging file must have been consumed by the rename'
    );

    const stored = await fs.stat(storeFile);
    assert.strictEqual(stored.nlink, 1, 'the published store must carry exactly one name');
    if (posix) {
      assert.strictEqual(
        stored.mode & 0o777,
        0o600,
        'the store must be owner-only: a stale staging file truncated in place would have donated its permissive mode to it'
      );
    }
  });

  /* ----------------------------------------------------------------------- *
   * The staging path as an attack surface, and the mode of what it becomes
   *
   * The staging name is derived and therefore PREDICTABLE, which is exactly
   * what another local process needs in order to occupy it first. Opening it
   * by pathname for writing implies `O_TRUNC`, so a symbolic or hard LINK
   * planted there would have its TARGET truncated — a file the store was
   * never configured to touch — and the truncation would happen before the
   * rename, so nothing later could undo it.
   *
   * The two cases below plant a link at that name and assert the property
   * that matters: the SENTINEL the link points at is byte-identical
   * afterwards. "It threw" would not establish that, and neither would a
   * successful submission on its own — a write that followed the link would
   * also succeed, and the damage would be to a file no assertion was looking
   * at.
   *
   * `fs.link` needs no privilege on NTFS or on POSIX. `fs.symlink` does need
   * one on Windows, so that case degrades to a hard link rather than passing
   * with nothing asserted — an unprivileged host still gets a real
   * measurement instead of a green tick.
   * ----------------------------------------------------------------------- */

  /**
   * Plants a second NAME for `targetPath` at `linkPath`, preferring a
   * symbolic link and falling back to a hard link where the platform refuses
   * one without privilege.
   *
   * @param {string} targetPath The file the link points at.
   * @param {string} linkPath The staging path to occupy.
   * @returns {Promise<'symbolic'|'hard'>} Which kind was actually planted.
   */
  const plantLinkAt = async (targetPath, linkPath) => {
    try {
      await fs.symlink(targetPath, linkPath);
      return 'symbolic';
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
        throw error;
      }
      /* No symlink privilege on this host. A hard link needs none and proves
       * the stronger half of the property: it is not a link object at all,
       * just a second name for the file, so no no-follow flag can describe
       * it and only exclusive creation refuses it. */
      await fs.link(targetPath, linkPath);
      return 'hard';
    }
  };

  /**
   * Submits one activity against a store whose staging path is occupied by a
   * link to a sentinel, and asserts the sentinel survived it.
   *
   * @param {import('node:test').TestContext} t The running case.
   * @param {string} fileName The store's file name.
   * @param {'hard'|'either'} kind `hard` plants a hard link; `either` prefers
   *   a symbolic link and falls back to a hard one.
   * @returns {Promise<void>}
   */
  const assertStagingLinkIsNotFollowed = async (t, fileName, kind) => {
    const context = 'a link occupying the derived staging path';
    const { store, storeFile, temporaryFile, directory } = await makeIsolatedStore(t, fileName);
    const sentinelPath = path.join(directory, 'sentinel.txt');
    const sentinelBytes = await writeBytes(
      sentinelPath,
      'bytes belonging to a file the store was never configured to write\n'
    );

    const planted =
      kind === 'hard'
        ? ((await fs.link(sentinelPath, temporaryFile)), 'hard')
        : await plantLinkAt(sentinelPath, temporaryFile);
    if (planted === 'hard') {
      assert.strictEqual(
        (await fs.stat(temporaryFile)).nlink,
        2,
        `${context}: the fixture must really be a second name for the sentinel, or the case proves nothing`
      );
    } else {
      assert.strictEqual(
        (await fs.lstat(temporaryFile)).isSymbolicLink(),
        true,
        `${context}: the fixture must really be a symbolic link, or the case proves nothing`
      );
    }

    const outcome = await store.addActivity('S001', 'Chess Club');

    /* THE ASSERTION THE CASE EXISTS FOR. A writer that opened the staging
     * path by name would have truncated the sentinel through the link and
     * then succeeded, so success alone says nothing. */
    const sentinelAfter = await fs.readFile(sentinelPath);
    assert.ok(
      sentinelAfter.equals(sentinelBytes),
      `${context}: the link target's bytes changed, so the write followed the planted link and truncated a file it was never pointed at`
    );

    assert.strictEqual(
      outcome.created,
      true,
      `${context}: the submission must still be persisted — a planted link is cleared, not a denial of service`
    );
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      `${context}: the planted name must be gone, consumed by the rename of the file that replaced it`
    );
    const document = await readDocument(storeFile);
    assert.ok(
      document.activities.some(
        (record) => record.studentId === 'S001' && record.activity === 'Chess Club'
      ),
      `${context}: the store must hold the new record`
    );
    const stored = await fs.stat(storeFile);
    assert.strictEqual(
      stored.nlink,
      1,
      `${context}: the staged file that became the store had exactly one name, so nothing else could observe or truncate it`
    );
    assert.ok(
      (await fs.readFile(sentinelPath)).equals(sentinelBytes),
      `${context}: and the sentinel is still intact after the rename as well`
    );
  };

  it('never writes through a hard link planted at the staging path', async (t) => {
    await assertStagingLinkIsNotFollowed(t, 'hard-linked.json', 'hard');
  });

  it('never writes through a symbolic link planted at the staging path', async (t) => {
    await assertStagingLinkIsNotFollowed(t, 'sym-linked.json', 'either');
  });

  it('publishes the store as a private regular file, and stages it as one too', async (t) => {
    /* The store holds submitted student data, and loopback-only reachability
     * protects it from the network and not from another local principal. So
     * the staging file is created `0600` and the rename carries that mode
     * onto the store.
     *
     * Both platforms get a real assertion. POSIX can state the mode exactly.
     * Windows honours only the write bit and inherits the directory's ACLs,
     * so what is assertable there is that the published file is a regular
     * file with exactly one name — which is the property a planted link or an
     * adopted directory would break. */
    const context = 'a store published by a successful write';
    const posix = typeof process.getuid === 'function';
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t, 'private.json');

    await store.addActivity('S001', 'Chess Club');

    const stored = await fs.stat(storeFile);
    assert.strictEqual(stored.isFile(), true, `${context}: the store must be a regular file`);
    assert.strictEqual(stored.nlink, 1, `${context}: with exactly one name`);
    if (posix) {
      assert.strictEqual(
        stored.mode & 0o777,
        0o600,
        `${context}: the store must be readable and writable by its owner alone, whatever the umask`
      );
      assert.strictEqual(
        stored.uid,
        process.getuid(),
        `${context}: and owned by the process that wrote it`
      );
    }

    /* The STAGED file's own mode, which is only observable while a staged
     * file exists — so it is statted INSIDE the rename, the moment before the
     * publish would adopt it, and the rename is then refused. Statting it
     * afterwards is not an option: a publish refused for good removes the
     * staged file. This is the file that becomes the store, so a permissive
     * mode here would be published by the next successful rename. */
    let stagedAtPublish;
    t.mock.method(fs, 'rename', async () => {
      if (stagedAtPublish === undefined) {
        stagedAtPublish = await fs.stat(temporaryFile);
      }
      const refusal = new Error('scripted rename refusal, raised by the test harness');
      refusal.code = 'EPERM';
      throw refusal;
    });

    assertCode(
      await captureRejection(store.addActivity('S001', 'Quiz Club'), context),
      E_STORE_WRITE_FAILED,
      context
    );

    const staged = stagedAtPublish;
    assert.notStrictEqual(
      staged,
      undefined,
      `${context}: the publish must have been attempted, or there was no staged file to describe`
    );
    assert.strictEqual(staged.isFile(), true, `${context}: the staged file must be a regular file`);
    assert.strictEqual(staged.nlink, 1, `${context}: with exactly one name`);
    if (posix) {
      assert.strictEqual(
        staged.mode & 0o777,
        0o600,
        `${context}: the staged file must be owner-only before it ever becomes the store`
      );
    }
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      `${context}: and the refused publish must leave nothing staged at rest`
    );

    t.mock.restoreAll();
  });

  it('serializes twenty-five concurrent submissions with no lost update and no duplicate key', async (t) => {
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);
    /* S004's seeded label is `Music Club`, so repeating it exercises the
     * idempotent path against a record that is already there. Without the
     * mutex, two interleaved read-modify-write cycles would each load the
     * same document and the second rename would discard the first's record. */
    const seededLabel = 'Music Club';
    const distinctLabels = Array.from({ length: 20 }, (unused, index) => `Concurrent Club ${index}`);
    const repeats = Array.from({ length: 5 }, () => seededLabel);

    const outcomes = await Promise.all(
      [...distinctLabels, ...repeats].map((label) => store.addActivity('S004', label))
    );

    assert.strictEqual(outcomes.length, 25);
    assert.strictEqual(
      outcomes.filter((outcome) => outcome.created).length,
      20,
      'each distinct label must be created exactly once'
    );
    assert.strictEqual(
      outcomes.filter((outcome) => !outcome.created).length,
      5,
      'each repeat of an existing composite key must be recognized, not appended'
    );

    const document = await readDocument(storeFile);
    const forStudent = document.activities.filter((record) => record.studentId === 'S004');
    assert.strictEqual(
      forStudent.length,
      21,
      'twenty submissions plus the one seeded record — a lost update would show up as fewer'
    );
    assert.strictEqual(
      document.activities.length,
      EXPECTED_SEED_PAIRS.length + 20,
      'the other nine seeded records must be untouched'
    );

    const keys = document.activities.map(compositeKeyOf);
    assert.strictEqual(
      new Set(keys).size,
      keys.length,
      'the document must hold no duplicate composite key'
    );
    for (const label of distinctLabels) {
      assert.strictEqual(
        forStudent.filter((record) => record.activity === label).length,
        1,
        `${label} must appear exactly once`
      );
    }
    assert.strictEqual(
      forStudent.filter((record) => record.activity === seededLabel).length,
      1,
      'the repeated label must still be the single seeded record'
    );
    assert.strictEqual(
      forStudent.find((record) => record.activity === seededLabel).source,
      SOURCE_WORKBOOK,
      'the repeats must not have rewritten an import as a submission'
    );
    assert.strictEqual(await exists(temporaryFile), false, 'no staging file may be left behind');
  });

  it('reports a write failure, keeps the previous document intact, and does not jam the queue', async (t) => {
    const context = 'a write that cannot reach the disk';
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);
    const first = await store.addActivity('S005', 'Chess Club');
    assert.strictEqual(first.created, true);
    const intactBytes = await fs.readFile(storeFile);

    /* THE FAULT MECHANISM, deterministic on every platform this project runs
     * on: a DIRECTORY is planted at the staging path, so `writeFile` cannot
     * open it (EISDIR) and the rename is never reached. The fault also has to
     * leave a previous document on disk, because proving that document intact
     * is half of what this case asserts. */
    await fs.mkdir(temporaryFile);

    const error = await captureRejection(store.addActivity('S005', 'Quiz Club'), context);

    assertCode(error, E_STORE_WRITE_FAILED, context);
    await assertBytesUnchanged(storeFile, intactBytes, context);
    assert.deepStrictEqual(
      (await store.listActivities('S005')).map((record) => record.activity),
      ['Coding Club', 'Chess Club'],
      'the refused submission must not appear, and the earlier ones must still be there'
    );

    /* Clear the fault. A naive `chain = chain.then(task)` would have left the
     * mutex permanently rejected, and every later submission would
     * short-circuit on that stale rejection instead of running — one
     * transient disk error jamming the service until restart. */
    await fs.rm(temporaryFile, { recursive: true, force: true });

    const recovered = await store.addActivity('S005', 'Quiz Club');

    assert.strictEqual(recovered.created, true, 'the next submission after a cleared fault must run');
    assert.deepStrictEqual(
      (await store.listActivities('S005')).map((record) => record.activity),
      ['Coding Club', 'Chess Club', 'Quiz Club']
    );
    assert.strictEqual(await exists(temporaryFile), false);
  });

  it('translates a failed rename, keeps the previous document, and clears the staged bytes', async (t) => {
    const context = 'a staging write that succeeds and a rename that refuses';
    const { store, storeFile, temporaryFile, directory } = await makeIsolatedStore(t);
    const first = await store.addActivity('S007', 'Chess Club');
    assert.strictEqual(first.created, true);
    const intactBytes = await fs.readFile(storeFile);

    /* THE RENAME, which only a runtime mock reaches after a SUCCESSFUL write.
     * The rename is what makes the replacement atomic, and it is the step that
     * fails in the field: a destination held open, a permission on the
     * destination rather than the directory, a store path that has become a
     * directory. No filesystem state makes `writeFile` succeed and `rename`
     * fail for the same reason on every platform this project runs on, and a
     * fixture that fails differently on Windows than on Linux has proven
     * nothing on either. The mock is installed on the `node:fs/promises`
     * namespace object that `activity-store.js` itself holds, so the call site
     * under test is the real one, and `t.mock` restores it when the case ends
     * whatever happens. */
    let renameCalls = 0;
    t.mock.method(fs, 'rename', async () => {
      renameCalls += 1;
      const refusal = new Error('scripted rename refusal, raised by the test harness');
      refusal.code = 'EPERM';
      throw refusal;
    });

    const error = await captureRejection(store.addActivity('S007', 'Quiz Club'), context);

    assertCode(error, E_STORE_WRITE_FAILED, context);
    assert.strictEqual(
      renameCalls,
      MAX_PUBLISH_ATTEMPTS,
      `the publish must retry a collision and give up at ${MAX_PUBLISH_ATTEMPTS} attempts — retrying forever would spin inside the write mutex and hold up every later submission`
    );
    assert.strictEqual(
      error.cause instanceof Error ? error.cause.code : undefined,
      'EPERM',
      'the originating failure must travel as `cause`, so a log can distinguish a refused rename from a refused write'
    );
    await assertBytesUnchanged(storeFile, intactBytes, context);

    /* The staged document held the submission the publish could not adopt, and
     * once the publish is refused for good it is REMOVED. Leaving it was
     * permitted — nothing ever reads a staging file, and the next write clears
     * it — but it parked a complete document at rest beside the store for as
     * long as no further write arrived, which on a service whose last write
     * failed is indefinitely. What the staging file must never do is
     * contribute to a read, and that is asserted below. */
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      'a publish refused after every attempt must leave nothing staged at rest'
    );
    assert.deepStrictEqual(
      (await fs.readdir(directory)).sort(),
      ['activities.json'],
      'the store alone, with no staging residue anywhere in its directory'
    );

    assert.deepStrictEqual(
      (await store.listActivities('S007')).map((record) => record.activity),
      ['Cricket Team', 'Chess Club'],
      'the refused submission must not appear in a read: a staging file is never read, and this one is gone besides'
    );

    t.mock.restoreAll();

    const recovered = await store.addActivity('S007', 'Quiz Club');

    assert.strictEqual(
      recovered.created,
      true,
      'the next submission after a cleared fault must run — a chain left rejected would short-circuit it'
    );
    assert.deepStrictEqual(
      (await store.listActivities('S007')).map((record) => record.activity),
      ['Cricket Team', 'Chess Club', 'Quiz Club']
    );
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      'the retry must have consumed the staging file through the rename that finally succeeded'
    );
  });

  it('publishes every concurrent submission while read loops run continuously', async (t) => {
    /* THE DEFECT THIS CASE EXISTS FOR, and why the concurrency case above
     * could not see it. That case fires twenty-five submissions through one
     * `Promise.all` and never interleaves a READ, so the only contention it
     * creates is between writers — which the mutex already orders. The
     * publishing rename, though, is refused by this platform while ANY
     * descriptor is open on the destination, and the read path holds exactly
     * such a descriptor, deliberately outside the mutex. Measured on this host
     * before the publish window existed: one continuous reader refused 37% of
     * concurrent submissions and four refused 98.5%, every refusal a valid
     * submission from a known student answered `store_write_failed` and lost,
     * while every read succeeded. So the reader won the race and the writer
     * paid for it, and no writer-only case could ever have caught it. */
    const context = 'twenty concurrent submissions against four continuous read loops';
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);

    let stop = false;
    let reads = 0;
    const readFailures = [];
    const loops = Array.from({ length: 4 }, () =>
      (async () => {
        while (!stop) {
          try {
            await store.listActivities('S003');
            reads += 1;
          } catch (error) {
            readFailures.push(error);
          }
        }
      })()
    );

    const labels = Array.from({ length: 20 }, (unused, index) => `Interleaved Club ${index}`);
    /* `allSettled` rather than `all`: a refusal is the defect under test, so it
     * has to be collected and named rather than thrown from the first one. */
    const outcomes = await Promise.allSettled(
      labels.map((label) => store.addActivity('S003', label))
    );
    stop = true;
    await Promise.all(loops);

    assert.deepStrictEqual(
      outcomes
        .filter((outcome) => outcome.status === 'rejected')
        .map((outcome) => `${outcome.reason.code} (${outcome.reason.diagnostic?.detail})`),
      [],
      `${context}: every submission must be published — a refusal here is a record lost, not a request slowed`
    );
    assert.strictEqual(
      outcomes.filter((outcome) => outcome.value.created).length,
      labels.length,
      `${context}: each distinct label must be created exactly once`
    );

    assert.ok(reads > 0, `${context}: the read loops must have run, or this case proves nothing`);
    assert.deepStrictEqual(
      readFailures.map((error) => error.code),
      [],
      `${context}: and no read may fail while writes are publishing`
    );

    const document = await readDocument(storeFile);
    const forStudent = document.activities.filter((record) => record.studentId === 'S003');
    assert.strictEqual(
      forStudent.length,
      labels.length + 1,
      `${context}: twenty submissions plus the one seeded record — a lost update would show up as fewer`
    );
    const keys = document.activities.map(compositeKeyOf);
    assert.strictEqual(
      new Set(keys).size,
      keys.length,
      `${context}: the document must hold no duplicate composite key`
    );
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      `${context}: and nothing staged may be left at rest`
    );
  });

  it('publishes on a retry when the first attempt hits a collision that clears', async (t) => {
    /* What the bound is FOR. A descriptor held by something outside this
     * module — an operator running `cat`, a backup agent, a scanner — is
     * invisible to the read window, so a retry is the only cover for it. The
     * collision is scripted rather than timed: a real foreign descriptor
     * released mid-backoff would make this case a race, and a race that
     * usually passes proves less than nothing. */
    const context = 'a publish whose first attempt collides and whose second succeeds';
    const { store, temporaryFile } = await makeIsolatedStore(t);
    const realRename = fs.rename;

    let renameCalls = 0;
    t.mock.method(fs, 'rename', async (from, to) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        const refusal = new Error('scripted collision, raised by the test harness');
        refusal.code = 'EPERM';
        throw refusal;
      }
      return realRename(from, to);
    });

    const outcome = await store.addActivity('S010', 'Quiz Club');

    assert.strictEqual(
      outcome.created,
      true,
      `${context}: the submission must be published rather than refused`
    );
    assert.strictEqual(renameCalls, 2, `${context}: the second attempt is what published it`);

    t.mock.restoreAll();

    assert.deepStrictEqual(
      (await store.listActivities('S010')).map((record) => record.activity),
      ['Debate Society', 'Quiz Club'],
      `${context}: and the record is in the document a read returns`
    );
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      `${context}: with nothing staged left behind`
    );
  });

  it('refuses a publish whose failure cannot clear after a single attempt', async (t) => {
    /* The other half of the retry predicate. A refusal that would recur
     * identically — a cross-device rename, a destination that has become a
     * directory, a missing directory — is decided on the first attempt, so
     * retrying it three times would hold the write mutex three times as long
     * for exactly the same answer. Only a collision code is worth a second
     * look. */
    const context = 'a rename refused with a code that cannot clear';
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);
    await store.addActivity('S009', 'Chess Club');
    const intactBytes = await fs.readFile(storeFile);

    let renameCalls = 0;
    t.mock.method(fs, 'rename', async () => {
      renameCalls += 1;
      const refusal = new Error('scripted rename refusal, raised by the test harness');
      refusal.code = 'EXDEV';
      throw refusal;
    });

    const error = await captureRejection(store.addActivity('S009', 'Quiz Club'), context);

    assertCode(error, E_STORE_WRITE_FAILED, context);
    assert.strictEqual(
      renameCalls,
      1,
      `${context}: a refusal that cannot clear must cost exactly one attempt`
    );
    assert.strictEqual(
      error.diagnostic.detail,
      'EXDEV',
      `${context}: and the errno must reach the diagnostic unchanged, so a log can tell the two apart`
    );
    await assertBytesUnchanged(storeFile, intactBytes, context);
    assert.strictEqual(
      await exists(temporaryFile),
      false,
      `${context}: with nothing staged left at rest`
    );

    t.mock.restoreAll();
  });

  it('keeps serving reads while a write fault persists', async (t) => {
    const context = 'a read taken while the staging path is blocked';
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);
    await store.addActivity('S006', 'Chess Club');
    const intactBytes = await fs.readFile(storeFile);
    await fs.mkdir(temporaryFile);

    const failed = await captureRejection(store.addActivity('S006', 'Quiz Club'), context);
    assertCode(failed, E_STORE_WRITE_FAILED, context);

    /* A read needs no write, so a blocked staging path must not affect it. */
    assert.deepStrictEqual(
      (await store.listActivities('S006')).map((record) => record.activity),
      ['Dance Club', 'Chess Club']
    );
    await assertBytesUnchanged(storeFile, intactBytes, context);
    await fs.rm(temporaryFile, { recursive: true, force: true });
  });

  it('answers a read while a submission is still writing, instead of queueing it behind the write', async (t) => {
    /* The mutex covers WRITES. A read is published to it by the atomic
     * rename, so it must not queue on the mutation chain — if it did, every
     * `GET /activities/{id}` would wait behind other submissions' loads,
     * validation, stringification, staging writes and renames.
     *
     * This is deterministic rather than a race: `node:fs/promises.writeFile`
     * is a writable, configurable property, so the submission is parked
     * INSIDE the critical section on a promise this case resolves itself. The
     * read is then raced against a deadline, so a regression fails with this
     * message rather than hanging the runner — `node:test` imposes no
     * timeout of its own. The timer is always cleared, and the parked write
     * is always released, so the case leaves no open handle either way. */
    const context = 'a read taken while a submission holds the write mutex';
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t, 'unqueued.json');
    const fsPromises = require('node:fs/promises');
    const realWriteFile = fsPromises.writeFile;

    let announceWriteStarted;
    const writeStarted = new Promise((resolve) => {
      announceWriteStarted = resolve;
    });
    let releaseWrite;
    const writeHeld = new Promise((resolve) => {
      releaseWrite = resolve;
    });

    /* Confined to this case and auto-restored by the runner when it ends. No
     * helper in this file may write through `fs.writeFile` while it stands. */
    t.mock.method(fsPromises, 'writeFile', async (...args) => {
      announceWriteStarted();
      await writeHeld;
      return realWriteFile(...args);
    });

    const submission = store.addActivity('S001', 'Chess Club');
    await writeStarted;
    assert.strictEqual(
      await exists(storeFile),
      false,
      `${context}: the staging write has not been renamed yet, so the store must not exist`
    );

    const TIMED_OUT = Symbol('the read did not resolve while the write was pending');
    const READ_DEADLINE_MS = 2000;
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), READ_DEADLINE_MS);
    });
    /* Settled rather than raced raw, so the losing promise can never surface
     * as an unhandled rejection. */
    const settledRead = store.listActivities('S001').then(
      (value) => value,
      (error) => error
    );

    let read = TIMED_OUT;
    let outcome;
    try {
      read = await Promise.race([settledRead, deadline]);
    } finally {
      clearTimeout(timer);
      releaseWrite();
      outcome = await submission.catch((error) => error);
    }

    assert.notStrictEqual(
      read,
      TIMED_OUT,
      `${context}: the read did not resolve within ${READ_DEADLINE_MS}ms while a write was pending, so reads are queued on the mutation chain`
    );
    assert.deepStrictEqual(
      read,
      [seededRecord('S001', 'Robotics Club')],
      'the read must answer from the document as it stands before the pending rename'
    );

    assert.strictEqual(outcome.created, true, 'the parked submission must still complete');
    assert.deepStrictEqual(
      (await store.listActivities('S001')).map((record) => record.activity),
      ['Robotics Club', 'Chess Club'],
      'once the rename lands, the next read sees the new document — old-or-new, never partial'
    );
    assert.strictEqual(await exists(temporaryFile), false, 'no staging file may be left behind');
  });

  it('refuses a submission whose store directory does not exist, without creating one', async (t) => {
    const context = 'a store configured under a directory that does not exist';
    const directory = await makeTemporaryDirectory(t);
    const missing = path.join(directory, 'absent', 'activities.json');
    const store = freshStore(missing);

    const error = await captureRejection(store.addActivity('S001', 'Chess Club'), context);

    assertCode(error, E_STORE_WRITE_FAILED, context);
    assert.strictEqual(
      await exists(path.join(directory, 'absent')),
      false,
      'the store must not create its own directory: a configured path is the operator to provide it'
    );
    assert.deepStrictEqual(await fs.readdir(directory), []);
  });
});


/* ========================================================================= *
 * The destinations the store refuses to be pointed at
 *
 * `ACTIVITY_STORE` is unrestricted external configuration and a write is a
 * `rename` OVER the target: a value naming a workbook or `LICENSE` would not
 * corrupt that file, it would REPLACE it. So the store canonicalizes the
 * configured value once, at module load, and refuses a tracked repository
 * file before any read or write can happen.
 *
 * Every case below therefore observes the refusal as a throw from `require` —
 * `freshStore` sets the variable and re-requires — and the point of the group
 * is the assertion AFTER the throw: the protected file's bytes on disk are
 * still exactly what they were. A refusal that threw but had already staged a
 * document over a workbook would pass a code check and fail these.
 *
 * Two kinds of alias are covered, because they are defeated by different
 * things. A TEXTUAL alias — `./LICENSE`, `test/../LICENSE`, a case variant
 * where the filesystem folds case — is collapsed by resolution. A FILESYSTEM
 * alias is a second real NAME for one file: a Windows 8.3 short name, a
 * junction, a directory symlink. No string transformation reaches those, and
 * a guard that canonicalized only the parent directory and rejoined the
 * configured basename let every one of them through, which is what the
 * short-name and directory-link cases below exercise.
 *
 * `ACTIVITY_STORE` is restored to the bootstrap path after every refusal, so
 * no later case in this file inherits a protected value.
 * ========================================================================= */

/** The refusal a protected destination raises at load, before a read or write. */
const E_STORE_PATH_PROTECTED = 'E_STORE_PATH_PROTECTED';

/** The safe value every case in the group below restores. */
const BOOTSTRAP_STORE_PATH = path.join(BOOTSTRAP_DIRECTORY, 'activities.json');

/**
 * Expects `require` of the store to refuse `configuredPath` at load, and
 * restores a safe `ACTIVITY_STORE` whether it did or not.
 *
 * @param {string} configuredPath The value to configure.
 * @param {string} context Names the case in the failure message.
 * @returns {Error} The thrown value.
 */
function captureProtectedRefusal(configuredPath, context) {
  try {
    return captureThrow(() => freshStore(configuredPath), context);
  } finally {
    freshStore(BOOTSTRAP_STORE_PATH);
  }
}

/**
 * Derives the Windows 8.3 short-name candidates for a long file name.
 *
 * Used only as the FALLBACK discovery path, for a host where `dir /x` is not
 * available: the shape is `FIRST6~N.EXT`, and the `~N` index depends on the
 * order the directory's names were created, so candidates rather than one
 * answer. Nothing here is treated as a fact — every candidate is checked
 * against the filesystem by `probeFilesystemAlias` before it is used.
 *
 * @param {string} longName The name as committed, for example
 *   `student_details.xlsx`.
 * @returns {string[]} The candidate aliases, most likely first.
 */
function deriveShortNameCandidates(longName) {
  const extension = path.extname(longName);
  const stem = path.basename(longName, extension);
  /* 8.3 generation strips the characters a short name may not carry, then
   * takes the first six of what is left and the first three of the
   * extension. */
  const stemPart = stem.replace(/[^A-Za-z0-9_-]/g, '').toUpperCase().slice(0, 6);
  const extensionPart = extension.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 3);
  if (stemPart === '') {
    return [];
  }
  const candidates = [];
  for (let index = 1; index <= 6; index += 1) {
    candidates.push(extensionPart === '' ? `${stemPart}~${index}` : `${stemPart}~${index}.${extensionPart}`);
  }
  return candidates;
}

/**
 * Discovers whether the filesystem exposes a second NAME for one file, and
 * which name that is.
 *
 * A textual alias — `./x`, `a/../x` — is collapsed by `path.resolve` and is
 * covered above. This finds the other kind, which no string normalization
 * reaches: a volume with 8.3 name generation gives a file a second real name,
 * so one file answers to two names.
 *
 * The alias is DISCOVERED rather than assumed. `dir /x` is asked first,
 * because it is the authority on which short names a directory holds, and
 * every token of its output is then verified by `fs.realpathSync.native` —
 * which is what decides identity, so a size or a timestamp in that output
 * cannot be mistaken for a name. When `dir /x` is unavailable (any
 * non-Windows host, where `cmd` does not exist) the derived candidates are
 * probed the same way, and a host with no short name for the file yields
 * `alias: null` with every probe recorded.
 *
 * @param {string} directory The directory holding the file.
 * @param {string} longName The file's committed name.
 * @returns {{alias: string|null, primary: string|null, protectedRealPath: string, outcomes: Map<string, {realPath: string|null, code: string|null}>}}
 *   The verified alias when one exists, the first candidate probed, the real
 *   path the alias would have to resolve to, and every probe's outcome.
 */
function probeFilesystemAlias(directory, longName) {
  const protectedRealPath = fsSync.realpathSync.native(path.join(directory, longName));

  const candidates = [];
  const addCandidate = (value) => {
    /* A name, not a path and not a stream spelling: anything carrying a
     * separator or a colon came from the listing's date, time or size
     * columns rather than from its name column. */
    if (value === '' || /[\\/:<>|"]/.test(value)) {
      return;
    }
    if (value.toLowerCase() === longName.toLowerCase()) {
      return;
    }
    if (!candidates.includes(value)) {
      candidates.push(value);
    }
  };

  try {
    const listing = execFileSync('cmd', ['/c', 'dir', '/x', longName], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    });
    for (const token of listing.split(/\s+/)) {
      addCandidate(token);
    }
  } catch (error) {
    /* No `dir /x` on this host — `cmd` itself is absent off Windows. The
     * derived candidates below are the whole discovery path there, and the
     * failure is recorded so the disposition below can name it. */
    assert.ok(
      typeof error.code === 'string' || typeof error.status === 'number',
      `listing ${longName} with dir /x failed without a reportable cause: ${error.message}`
    );
  }

  const derived = deriveShortNameCandidates(longName);
  for (const candidate of derived) {
    addCandidate(candidate);
  }

  const outcomes = new Map();
  let alias = null;
  for (const candidate of candidates) {
    let outcome;
    try {
      outcome = { realPath: fsSync.realpathSync.native(path.join(directory, candidate)), code: null };
    } catch (error) {
      outcome = { realPath: null, code: error.code === undefined ? 'UNKNOWN' : error.code };
    }
    outcomes.set(candidate, outcome);
    if (alias === null && outcome.realPath === protectedRealPath) {
      alias = candidate;
    }
  }

  return {
    alias,
    primary: derived.length > 0 ? derived[0] : null,
    protectedRealPath,
    outcomes,
  };
}

/**
 * Removes a directory link — a Windows junction or a POSIX directory symlink
 * — without ever following it.
 *
 * `fs.unlink` removes the link itself on both (measured on this host: a
 * junction unlinks cleanly and the target's contents survive). ENOENT is
 * tolerated, because the case registers this cleanup before it knows whether
 * the link could be created; every other failure is raised, so a leaked
 * junction fails loudly instead of being left in a temporary directory.
 *
 * @param {string} linkPath The link to remove.
 * @returns {Promise<void>}
 */
async function removeDirectoryLink(linkPath) {
  try {
    await fs.unlink(linkPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Asserts a protected-destination refusal is the declared one.
 *
 * @param {unknown} error The thrown value.
 * @param {string} repositoryRelativeName The name the message must quote.
 * @param {string} context Names the case in the failure message.
 * @returns {void}
 */
function assertProtectedRefusal(error, repositoryRelativeName, context) {
  assert.ok(
    error instanceof RangeError,
    `${context}: a configuration fault must be a RangeError, received ${error && error.constructor && error.constructor.name}`
  );
  assertCode(error, E_STORE_PATH_PROTECTED, context);
  assert.ok(
    error.message.includes(repositoryRelativeName),
    `${context}: the refusal must name ${repositoryRelativeName}; it said "${error.message}"`
  );
  assert.ok(
    error.message.includes('ACTIVITY_STORE'),
    `${context}: the refusal must name the variable that caused it; it said "${error.message}"`
  );
  assert.strictEqual(
    error.message.includes(REPOSITORY_ROOT),
    false,
    `${context}: the refusal must quote the repository-relative name, not an absolute path`
  );
}

/**
 * Captures what is on disk at `filePath` before a call that must not touch
 * it: whether it is there at all, and its exact bytes if it is.
 *
 * The one legitimate destination this group exercises inside the checkout is
 * the default `activities.json` and its derived staging sibling, and those
 * are runtime-generated paths the service itself writes at exactly that
 * location. Whether they exist when this file starts is therefore a property
 * of the machine it runs on, not of the code under test: a clean checkout has
 * neither, and a developer who has run the documented `npm start` and
 * submitted once has the first. Capturing the state first is what lets the
 * assertion afterwards say UNCHANGED — which is the guard's actual intent —
 * rather than ABSENT, which would fail that developer for a file this suite
 * never touched.
 *
 * Bytes rather than existence alone, because the stronger comparison costs
 * nothing here and catches the two faults existence cannot: a store rewritten
 * in place, and one truncated. Both still exist.
 *
 * @param {string} filePath The path to capture.
 * @returns {Promise<{existed: boolean, bytes: Buffer|null}>} The state, with
 *   `bytes` null exactly when the path was absent.
 */
async function captureAmbientState(filePath) {
  if (!(await exists(filePath))) {
    return { existed: false, bytes: null };
  }
  return { existed: true, bytes: await fs.readFile(filePath) };
}

/**
 * Asserts a path is exactly as `captureAmbientState` found it, in both
 * directions: a path that was absent must still be absent — the clean
 * checkout every CI run starts from, whose strength must not be diluted —
 * and a path that was there must still be there with identical bytes.
 *
 * The failure message names what the suite did to the path, since the fault
 * being reported is the suite's own write, removal or repair. Per the output
 * safety rule above it quotes the repository-relative name and never the
 * absolute path it was given.
 *
 * @param {string} filePath The path that was captured.
 * @param {{existed: boolean, bytes: Buffer|null}} before The state
 *   `captureAmbientState` returned before the call under test.
 * @param {string} repositoryRelativeName The name the message may quote.
 * @returns {Promise<void>}
 */
async function assertAmbientStateUnchanged(filePath, before, repositoryRelativeName) {
  const existsNow = await exists(filePath);

  if (!before.existed) {
    assert.strictEqual(
      existsNow,
      false,
      `this suite created ${repositoryRelativeName}: it was not in the checkout when the case started and is now. Nothing here may write the developer's store.`
    );
    return;
  }

  assert.strictEqual(
    existsNow,
    true,
    `this suite removed ${repositoryRelativeName}: it was in the checkout when the case started and is gone. The developer's own store must be left exactly as it was found.`
  );
  await assertBytesUnchanged(
    filePath,
    before.bytes,
    `this suite modified ${repositoryRelativeName}, which was already in the checkout when the case started`
  );
}

describe('the store refuses a protected destination', () => {
  const PROTECTED_CASES = [
    { relativeName: 'student_details.xlsx', filePath: DETAILS_WORKBOOK },
    { relativeName: 'student_academics.xlsx', filePath: ACADEMICS_WORKBOOK },
    { relativeName: 'student_other_info.xlsx', filePath: OTHER_INFO_WORKBOOK },
    { relativeName: 'LICENSE', filePath: path.join(REPOSITORY_ROOT, 'LICENSE') },
  ];

  it('refuses each workbook and LICENSE at load, and leaves their bytes untouched', async () => {
    for (const { relativeName, filePath } of PROTECTED_CASES) {
      const context = `ACTIVITY_STORE pointing at ${relativeName}`;
      const bytesBefore = await fs.readFile(filePath);

      const error = captureProtectedRefusal(filePath, context);

      assertProtectedRefusal(error, relativeName, context);
      /* The refusal must land before anything is staged or renamed over the
       * file, so the bytes on disk must be unchanged. */
      await assertBytesUnchanged(filePath, bytesBefore, context);
      assert.strictEqual(
        await exists(`${filePath}${TEMPORARY_SUFFIX}`),
        false,
        `${context}: no staging sibling may have been created beside a protected file`
      );
    }
  });

  it('refuses an alias of a protected file: a relative form and a .. traversal', async () => {
    const relativeToCwd = path.relative(process.cwd(), DETAILS_WORKBOOK);
    assert.strictEqual(
      path.isAbsolute(relativeToCwd),
      false,
      'this case needs the runner to have been started on the same volume as the checkout, which the documented invocation is'
    );

    /* Both forms name a protected file without spelling it canonically:
     * `path.resolve` is what collapses them, which is why the comparison
     * canonicalizes rather than comparing the configured string. The
     * traversal form is concatenated rather than joined because `path.join`
     * would collapse the `..` before the store ever saw it. */
    const aliases = [
      {
        description: 'a ./-prefixed relative alias of student_details.xlsx',
        value: `.${path.sep}${relativeToCwd}`,
        relativeName: 'student_details.xlsx',
        filePath: DETAILS_WORKBOOK,
      },
      {
        description: 'an absolute path reaching LICENSE through a .. traversal',
        value: `${REPOSITORY_ROOT}${path.sep}test${path.sep}..${path.sep}LICENSE`,
        relativeName: 'LICENSE',
        filePath: path.join(REPOSITORY_ROOT, 'LICENSE'),
      },
    ];

    for (const alias of aliases) {
      const bytesBefore = await fs.readFile(alias.filePath);

      const error = captureProtectedRefusal(alias.value, alias.description);

      assertProtectedRefusal(error, alias.relativeName, alias.description);
      await assertBytesUnchanged(alias.filePath, bytesBefore, alias.description);
    }
  });

  it('refuses a filesystem alias of a protected workbook: a short name is the same file under another name', async () => {
    /* The kind of alias `path.resolve` cannot reach. A volume with 8.3 name
     * generation gives `student_details.xlsx` a second real name for the same
     * file, so only canonicalizing the WHOLE configured candidate detects it:
     * a guard that canonicalizes the parent directory and rejoins the
     * configured basename has nothing to compare that second name against,
     * loads happily, and renames a store document over the workbook on the
     * first submission.
     *
     * The alias is discovered at runtime rather than written down: it is a
     * property of the volume and of the order the directory's names were
     * created, so hard-coding it would assert a coincidence. On a host that
     * exposes no short name for the file, the honest assertion is that the
     * candidate alias names nothing at all — the disposition that belongs to
     * the host it runs on, exactly as the case-folding case below does. */
    const probe = probeFilesystemAlias(REPOSITORY_ROOT, 'student_details.xlsx');
    const probeReport = [...probe.outcomes]
      .map(([candidate, outcome]) => `${candidate} -> ${outcome.realPath === null ? outcome.code : outcome.realPath}`)
      .join('; ');

    if (probe.alias === null) {
      assert.ok(
        probe.primary !== null,
        'the 8.3 candidate derivation produced no candidate for student_details.xlsx, so this case probed nothing'
      );
      const primaryOutcome = probe.outcomes.get(probe.primary);
      assert.ok(
        primaryOutcome.code === 'ENOENT' || primaryOutcome.realPath !== null,
        `this host exposes no alias for student_details.xlsx, so ${probe.primary} must resolve to nothing (ENOENT) or to some other existing file; realpathSync.native reported ${primaryOutcome.code}. Probes: ${probeReport}`
      );
      assert.notStrictEqual(
        primaryOutcome.realPath,
        probe.protectedRealPath,
        `${probe.primary} resolves to the protected workbook, so it is an alias and must have been refused. Probes: ${probeReport}`
      );
      return;
    }

    const configured = path.join(REPOSITORY_ROOT, probe.alias);
    const context = `ACTIVITY_STORE pointing at the filesystem alias ${probe.alias} of student_details.xlsx`;
    const bytesBefore = await fs.readFile(DETAILS_WORKBOOK);

    const error = captureProtectedRefusal(configured, context);

    assertProtectedRefusal(error, 'student_details.xlsx', context);
    await assertBytesUnchanged(DETAILS_WORKBOOK, bytesBefore, context);
    assert.strictEqual(
      await exists(`${configured}${TEMPORARY_SUFFIX}`),
      false,
      `${context}: no staging sibling may have been created beside the alias`
    );
    assert.strictEqual(
      await exists(`${DETAILS_WORKBOOK}${TEMPORARY_SUFFIX}`),
      false,
      `${context}: no staging sibling may have been created beside the workbook either`
    );
  });

  it('refuses a protected file reached through a directory link, on every platform', async (t) => {
    /* A junction on Windows, a directory symlink elsewhere, pointing at the
     * repository root. The configured value then contains no `..`, no `.` and
     * no short name — it is a perfectly ordinary path that happens to arrive
     * at `LICENSE`, which only `realpath` of the whole candidate can tell.
     *
     * The link lives in a per-case temporary directory and is removed by this
     * case's own cleanup. A recursive removal of that directory does not
     * follow the link, so neither the cleanup nor the runner can reach into
     * the checkout through it. */
    const directory = await makeTemporaryDirectory(t);
    const link = path.join(directory, 'repository-link');
    t.after(async () => {
      await removeDirectoryLink(link);
    });

    let linkFailure = null;
    try {
      if (process.platform === 'win32') {
        /* A junction, not a symbolic link: `mklink /J` needs no privilege,
         * while `mklink /D` needs either elevation or developer mode. */
        execFileSync('cmd', ['/c', 'mklink', '/J', link, REPOSITORY_ROOT], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        fsSync.symlinkSync(REPOSITORY_ROOT, link, 'dir');
      }
    } catch (error) {
      linkFailure = error;
    }

    const licensePath = path.join(REPOSITORY_ROOT, 'LICENSE');
    const bytesBefore = await fs.readFile(licensePath);

    if (linkFailure !== null) {
      /* A host that cannot create a directory link is a disposition, not a
       * pass: the reason is asserted so the log says which one it was, and
       * nothing is left behind claiming the guard was exercised. */
      assert.ok(
        typeof linkFailure.code === 'string' || typeof linkFailure.status === 'number',
        `creating a directory link at ${link} failed without a reportable cause: ${linkFailure.message}`
      );
      assert.strictEqual(
        await exists(link),
        false,
        `creating the directory link reported ${String(linkFailure.code)} yet something exists at ${link}`
      );
      await assertBytesUnchanged(licensePath, bytesBefore, 'a host that cannot create a directory link');
      return;
    }

    const linkedLicense = path.join(link, 'LICENSE');
    assert.strictEqual(
      fsSync.realpathSync.native(linkedLicense),
      fsSync.realpathSync.native(licensePath),
      'the link must reach the repository, or this case proves nothing'
    );

    const context = 'ACTIVITY_STORE pointing at LICENSE through a directory link';
    const error = captureProtectedRefusal(linkedLicense, context);

    assertProtectedRefusal(error, 'LICENSE', context);
    await assertBytesUnchanged(licensePath, bytesBefore, context);
    assert.strictEqual(
      await exists(`${linkedLicense}${TEMPORARY_SUFFIX}`),
      false,
      `${context}: no staging sibling may have been created through the link`
    );
    assert.strictEqual(
      await exists(`${licensePath}${TEMPORARY_SUFFIX}`),
      false,
      `${context}: no staging sibling may have been created in the checkout either`
    );

    /* The link is not a blanket refusal of everything it reaches: a
     * legitimate store name inside the linked directory is still accepted,
     * which is what proves the guard resolves identity rather than refusing
     * links. Requiring the module neither reads nor writes, so nothing is
     * created by this. */
    const throughLink = path.join(link, 'accepted-through-a-link.json');
    try {
      const accepted = freshStore(throughLink);
      assert.strictEqual(
        accepted.storePath(),
        throughLink,
        'a non-protected name inside the linked directory must load, and storePath() must return it verbatim'
      );
    } finally {
      freshStore(BOOTSTRAP_STORE_PATH);
    }
    assert.strictEqual(
      await exists(path.join(REPOSITORY_ROOT, 'accepted-through-a-link.json')),
      false,
      'loading the module must not create the store, so nothing may appear in the checkout'
    );
  });

  it('folds case exactly where the filesystem does, so a case variant cannot slip past', async () => {
    /* Where the filesystem folds case, `license` and `LICENSE` name ONE file,
     * so the variant must be refused. Where it does not, they are two
     * different files and the variant names nothing tracked, so refusing it
     * would be wrong — the case asserts the disposition that belongs to the
     * host it runs on rather than skipping on either.
     *
     * Which disposition that is, is MEASURED rather than guessed from
     * `process.platform`, because the store measures it too: it canonicalizes
     * an existing candidate through `realpath`, so the filesystem's own answer
     * for this very name is what decides. A platform guess would disagree with
     * the implementation on a case-SENSITIVE APFS or ReFS volume, and on a
     * case-insensitive volume mounted under Linux. */
    const variant = path.join(REPOSITORY_ROOT, 'license');
    const licensePath = path.join(REPOSITORY_ROOT, 'LICENSE');
    let variantRealPath = null;
    try {
      variantRealPath = fsSync.realpathSync.native(variant);
    } catch (error) {
      assert.strictEqual(
        error.code,
        'ENOENT',
        `resolving ${variant} must either succeed or report ENOENT; it reported ${String(error.code)}`
      );
    }
    const caseInsensitive = variantRealPath === fsSync.realpathSync.native(licensePath);
    const bytesBefore = await fs.readFile(licensePath);
    const context = 'ACTIVITY_STORE pointing at a lower-case LICENSE';

    if (caseInsensitive) {
      const error = captureProtectedRefusal(variant, context);
      assertProtectedRefusal(error, 'LICENSE', context);
    } else {
      try {
        const store = freshStore(variant);
        assert.strictEqual(
          store.storePath(),
          variant,
          'on a case-sensitive filesystem the variant is a different file and is accepted'
        );
      } finally {
        freshStore(BOOTSTRAP_STORE_PATH);
      }
    }

    await assertBytesUnchanged(licensePath, bytesBefore, context);
    assert.strictEqual(
      await exists(variant),
      caseInsensitive,
      caseInsensitive
        ? 'on this filesystem the variant resolves to the existing LICENSE'
        : 'nothing may have created a second lower-case file'
    );
  });

  it('compares the whole canonical name rather than a prefix, and checks the derived staging path too', async () => {
    /* The store path AND its derived `${path}.tmp` sibling are both checked.
     * No protected name ends in `.tmp`, so the derived path cannot collide
     * unless the store path itself already does — there is no constructible
     * case for the derived leg alone, and it is checked anyway so that a
     * future change to the suffix cannot silently open one.
     *
     * What IS constructible is the neighbouring mistake: a name that merely
     * BEGINS with a protected name. `LICENSE.tmp` is not tracked, so a
     * prefix- or substring-based guard would refuse it wrongly. Requiring the
     * module performs no read and no write, so nothing is created here. */
    const neighbour = path.join(REPOSITORY_ROOT, 'LICENSE.tmp');
    const licenseBytes = await fs.readFile(path.join(REPOSITORY_ROOT, 'LICENSE'));

    try {
      const store = freshStore(neighbour);
      assert.strictEqual(store.storePath(), neighbour);
    } finally {
      freshStore(BOOTSTRAP_STORE_PATH);
    }

    assert.strictEqual(
      await exists(neighbour),
      false,
      'loading the module must not create the store, so nothing may appear in the checkout'
    );
    await assertBytesUnchanged(
      path.join(REPOSITORY_ROOT, 'LICENSE'),
      licenseBytes,
      'a store configured at LICENSE.tmp'
    );
  });

  it('still accepts a store outside the checkout and the default store name inside it', async (t) => {
    /* The guard must refuse protected files and nothing else, so both
     * legitimate destinations are asserted: a store in a temporary directory
     * outside the checkout, exercised through a real write, and the default
     * `activities.json` beside the source — the store this module exists to
     * write, and deliberately NOT protected. */
    const { store, storeFile } = await makeIsolatedStore(t, 'accepted.json');
    assert.strictEqual(store.storePath(), storeFile);

    const outcome = await store.addActivity('S007', 'Chess Club');
    assert.strictEqual(outcome.created, true, 'a legitimate destination must still be writable');
    assert.strictEqual(await exists(storeFile), true);

    /* Loading the module performs no read and no write, so the developer's
     * own store — the one artifact this module exists to write, and the one
     * destination here deliberately NOT protected — must be left exactly as
     * it was FOUND. Found rather than absent: `activities.json` and its
     * staging sibling are runtime-generated paths the service creates at
     * precisely this location, so their presence is the documented outcome of
     * running the service once and says nothing about this suite. Both are
     * captured before the load and asserted unchanged after it, in both
     * directions — absent stays absent, which is the clean checkout CI runs
     * and the stronger half of the guard, and present stays byte-identical,
     * which is the half that catches a write to a developer's real data. */
    const defaultStore = path.join(REPOSITORY_ROOT, 'activities.json');
    const defaultStoreStaging = `${defaultStore}${TEMPORARY_SUFFIX}`;
    const defaultStoreBefore = await captureAmbientState(defaultStore);
    const defaultStoreStagingBefore = await captureAmbientState(defaultStoreStaging);

    try {
      const inTree = freshStore(defaultStore);
      assert.strictEqual(
        inTree.storePath(),
        defaultStore,
        'the default store name must load without a refusal'
      );
    } finally {
      freshStore(BOOTSTRAP_STORE_PATH);
    }

    await assertAmbientStateUnchanged(defaultStore, defaultStoreBefore, 'activities.json');
    await assertAmbientStateUnchanged(
      defaultStoreStaging,
      defaultStoreStagingBefore,
      `activities.json${TEMPORARY_SUFFIX}`
    );
  });
});


/* ========================================================================= *
 * The workbook invariants
 *
 * These are the properties the feature must not break. It writes no workbook,
 * so they hold by construction rather than by care — which is exactly why
 * they are asserted: the checks catch a workbook replaced by hand, or a
 * future change that starts writing one.
 *
 * The byte-identity check below performs its own submission, so it is taken
 * after the store has really read the workbooks and written its document, and
 * depends on no ordering between groups.
 * ========================================================================= */

describe('the workbook invariants the feature must not break', () => {
  it('keeps the Student ID key sets identical across all three workbooks, with no orphan', () => {
    const [details, academics, otherInfo] = WORKBOOK_SHAPES.map((workbook) => {
      const column = xlsxRead.readColumn(workbook.filePath, WORKSHEET_PART, 'A');
      /* Index 0 is the header; the key set is the rows beneath it. */
      return new Set(column.slice(1).filter((value) => value.trim() !== ''));
    });

    assert.strictEqual(details.size, 10, 'student_details.xlsx must hold ten Student IDs');
    assert.strictEqual(academics.size, 10, 'student_academics.xlsx must hold ten Student IDs');
    assert.strictEqual(otherInfo.size, 10, 'student_other_info.xlsx must hold ten Student IDs');

    assert.deepStrictEqual([...details].sort(), EXPECTED_KEY_SET);

    const difference = (left, right) => [...left].filter((key) => !right.has(key)).sort();
    const named = [
      ['details', details],
      ['academics', academics],
      ['other_info', otherInfo],
    ];
    /* Every direction, not a sample: a one-sided check would miss an orphan
     * in the other workbook, and an equal-size check would miss two
     * compensating differences. */
    for (const [leftName, left] of named) {
      for (const [rightName, right] of named) {
        assert.deepStrictEqual(
          difference(left, right),
          [],
          `${leftName} holds Student IDs absent from ${rightName}`
        );
      }
    }

    const union = new Set([...details, ...academics, ...otherInfo]);
    assert.strictEqual(union.size, 10, 'the union of the three key sets must still be ten keys');
    for (const [name, keys] of named) {
      assert.deepStrictEqual(
        difference(union, keys),
        [],
        `${name} is missing a Student ID that another workbook holds`
      );
    }
  });

  it('keeps the cross-workbook join at ten rows and twenty-one distinct columns', () => {
    const headerRows = WORKBOOK_SHAPES.map((workbook) => {
      const rows = xlsxRead.readSheetRows(workbook.filePath, WORKSHEET_PART);
      return { label: workbook.label, headers: Object.values(rows[0]), dataRows: rows.length - 1 };
    });

    /* The arithmetic IS the assertion: counted from the header rows actually
     * present rather than from a remembered total, so a workbook that gained
     * or lost a column fails here. 10 + 7 + 6 = 23 raw columns, less the two
     * repeated `Student ID` key columns, is 21 distinct. */
    const rawColumnCount = headerRows.reduce((total, workbook) => total + workbook.headers.length, 0);
    assert.strictEqual(rawColumnCount, 23, 'the three header rows must contribute 23 raw columns');

    const keyColumnCount = headerRows.filter((workbook) => workbook.headers[0] === 'Student ID').length;
    assert.strictEqual(keyColumnCount, 3, 'every workbook must be keyed by Student ID in column A');

    const distinctColumnCount = rawColumnCount - (keyColumnCount - 1);
    assert.strictEqual(
      distinctColumnCount,
      21,
      'the join must yield 21 distinct columns — 23 raw, less the two repeated key columns'
    );

    const nonKeyHeaders = headerRows.flatMap((workbook) => workbook.headers.slice(1));
    assert.strictEqual(
      new Set([...nonKeyHeaders, 'Student ID']).size,
      21,
      'the 21 distinct column names must be genuinely distinct, so the count is not hiding a collision'
    );

    for (const workbook of headerRows) {
      assert.strictEqual(workbook.dataRows, 10, `${workbook.label} must hold ten data rows`);
    }
  });

  it('keeps every workbook inert: no macro part, no external link, no formula', () => {
    for (const workbook of WORKBOOK_SHAPES) {
      /* Proving a part is ABSENT needs the part list, which no amount of rows
       * and columns could show — which is why `listEntries` is exported. */
      const entries = xlsxRead.listEntries(workbook.filePath);
      assert.deepStrictEqual(
        entries.filter((name) => name.toLowerCase().includes('vbaproject')),
        [],
        `${workbook.label} must hold no macro part`
      );
      assert.deepStrictEqual(
        entries.filter((name) => name.toLowerCase().includes('externallink')),
        [],
        `${workbook.label} must hold no external link part`
      );

      const sheet = xlsxRead.readEntry(workbook.filePath, WORKSHEET_PART).toString('utf8');
      assert.strictEqual(
        /<f[\s>/]/.test(sheet),
        false,
        `${workbook.label} must hold no formula element: nothing in it may compute`
      );
      assert.strictEqual(
        sheet.includes('<dataValidation'),
        false,
        `${workbook.label} declares no constraint, which is why the activity column is free text`
      );
      assert.strictEqual(
        sheet.includes('<sheetProtection'),
        false,
        `${workbook.label} must carry no sheet protection`
      );

      const contentTypes = xlsxRead.readEntry(workbook.filePath, CONTENT_TYPES_PART).toString('utf8');
      assert.strictEqual(
        contentTypes.toLowerCase().includes('vbaproject'),
        false,
        `${workbook.label} must not declare a macro content type`
      );
    }
  });

  it('leaves every workbook byte-identical after submissions have been exercised', async (t) => {
    requireGit();
    const { store, storeFile } = await makeIsolatedStore(t);

    /* A real submission, so the assertion is taken after the store has read
     * the workbooks and written its own document. */
    const outcome = await store.addActivity('S007', 'Chess Club');
    assert.strictEqual(outcome.created, true);
    assert.strictEqual(await exists(storeFile), true);

    /* Scoped to `*.xlsx` deliberately: asserting a globally clean tree would
     * fail on an unrelated untracked file that has nothing to do with this
     * feature. The pathspec is passed as an argv element, so git globs it
     * rather than a shell.
     *
     * This is the one place in the file where captured output is reproduced in
     * a failure message, and it is deliberate rather than overlooked. The
     * pathspec confines what git can report to the three committed workbook
     * names this file already holds in `WORKBOOK_SHAPES`, so it carries no
     * personal data, no record value and no absolute path, and it is the only
     * thing that tells a reader WHICH workbook changed. */
    const status = git(['status', '--porcelain', '--', '*.xlsx']);
    const changed = status.split('\n').filter((line) => line.trim() !== '');
    assert.deepStrictEqual(
      changed,
      [],
      `no workbook may be modified by this feature; git reported:\n${status}`
    );
  });

  it('keeps the runtime store and its staging sibling untracked', () => {
    requireGit();
    /* Both names matter: the staging file holds the same submitted data as
     * the store, so tracking either would put student submissions into
     * history, where committed bytes stay recoverable indefinitely. */
    for (const runtimePath of ['activities.json', 'activities.json.tmp']) {
      const error = captureThrow(
        () => git(['ls-files', '--error-unmatch', runtimePath]),
        `${runtimePath} must not be tracked`
      );
      assert.notStrictEqual(
        error.status,
        0,
        `git ls-files --error-unmatch ${runtimePath} must fail: the runtime store is never committed`
      );
    }

    /* The control: a file that IS tracked resolves, so the assertion above
     * cannot be passing because the query is broken. */
    assert.match(git(['ls-files', '--error-unmatch', 'package.json']), /package\.json/);
  });

  it('keeps the workbook fixtures synthetic, so no real personal data enters this suite', () => {
    /* The fixtures are only safe to read, assert on and retain evidence about
     * because every value in them is invented: emails on the reserved
     * example.edu domain and phone numbers in one contiguous run. If a
     * workbook were ever repopulated with real records this case fails, and
     * the whole suite's treatment of that data would have to be reconsidered.
     *
     * WHICH IS WHY THE SHAPE OF ITS OUTPUT MATTERS AS MUCH AS THE CHECK. A
     * failure here means real personal data is present, so it has to report
     * WHERE without reporting WHAT. A message naming the offending email, or
     * a collection assertion that renders the whole actual list, would take
     * the moment the guard detects real student records and turn it into the
     * disclosure of those records — into a spec stream, and into the JUnit
     * file the documented evidence command retains. A worksheet row number is
     * all anyone needs in order to open the workbook and look. So every
     * assertion below compares an aggregate — a count, or a list of row
     * numbers — and never a value. */
    const rows = xlsxRead.readSheetRows(DETAILS_WORKBOOK, WORKSHEET_PART);
    const dataRows = rows.slice(1);

    /* Which columns hold the sensitive fields is asserted rather than assumed:
     * a guard pointed at a column that has moved would pass while checking
     * nothing, which is the one failure mode a safety check must not have. */
    assert.strictEqual(rows[0].H, 'Email', 'the email column must still be H');
    assert.strictEqual(rows[0].I, 'Phone', 'the phone column must still be I');
    assert.strictEqual(
      dataRows.length,
      EXPECTED_KEY_SET.length,
      'the identity workbook must still hold exactly ten data rows'
    );

    /* Worksheet row numbers: index 0 of `dataRows` is worksheet row 2. */
    const worksheetRow = (index) => index + 2;

    const SYNTHETIC_EMAIL_DOMAIN = /@example\.edu$/u;
    const rowsOutsideReservedDomain = dataRows
      .map((row, index) => (SYNTHETIC_EMAIL_DOMAIN.test(row.H ?? '') ? null : worksheetRow(index)))
      .filter((rowNumber) => rowNumber !== null);
    assert.deepStrictEqual(
      rowsOutsideReservedDomain,
      [],
      'every fixture email must sit on the reserved example.edu domain. The worksheet rows this ' +
        'assertion reports as its actual value hold an address outside it, which may be a real ' +
        'one — the addresses themselves are deliberately withheld from this report, so open ' +
        'student_details.xlsx at those rows to see them'
    );

    /* The phone run is compared row by row into a list of offending row
     * numbers rather than with one collection assertion over the values: a
     * deep-equality failure prints both arrays in full, which is precisely the
     * disclosure this case exists to prevent. */
    const FIRST_SYNTHETIC_PHONE = 9822011001;
    const rowsOutsideSyntheticPhoneRun = dataRows
      .map((row, index) =>
        row.I === String(FIRST_SYNTHETIC_PHONE + index) ? null : worksheetRow(index)
      )
      .filter((rowNumber) => rowNumber !== null);
    assert.deepStrictEqual(
      rowsOutsideSyntheticPhoneRun,
      [],
      'the fixture phone numbers must be the contiguous synthetic run 9822011001-9822011010, one ' +
        'per row in order. The worksheet rows this assertion reports as its actual value depart ' +
        'from it and may hold real numbers — the numbers themselves are withheld by design'
    );

    /* Controls, so neither predicate can be passing because it cannot fail.
     * An aggregate that reports "no offending rows" is worth exactly as much
     * as its ability to report one. */
    assert.strictEqual(
      SYNTHETIC_EMAIL_DOMAIN.test('someone@example.com'),
      false,
      'the domain predicate must reject an address outside example.edu'
    );
    assert.strictEqual(
      SYNTHETIC_EMAIL_DOMAIN.test('someone@example.edu.attacker.test'),
      false,
      'the domain predicate must be anchored, so a lookalike suffix does not satisfy it'
    );
    assert.notStrictEqual(
      String(FIRST_SYNTHETIC_PHONE),
      String(FIRST_SYNTHETIC_PHONE + 1),
      'the phone expectation must advance by row, so a single repeated number would be caught'
    );
  });
});
