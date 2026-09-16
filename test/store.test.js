'use strict';

/**
 * test/store.test.js — port-free evidence for the two layers underneath the
 * extracurricular-activity feature: the zero-dependency workbook reader
 * (`xlsx-read.js`) and the store that owns persistence, normalization and the
 * Student ID link (`activity-store.js`). It also owns the cross-workbook
 * invariant assertions, because proving a workbook was not touched needs the
 * reader and the repository, not a socket.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The governing rule `Ajit_AddNewFeature_Rule` — summarized here, never
 * reproduced — mandates testing requirements as a deliverable of adding a
 * feature; the one-sentence user request never asked for a test. The
 * consequence is that every case below is real executable evidence that can
 * fail: no `t.todo`, no `t.skip`, and no assertion that holds trivially. The
 * same rule's minimal-change area is why the runner is the runtime's own
 * `node:test` with `node:assert`, why no dependency is added, and why every
 * helper this suite needs is local to this file rather than a fourth file in
 * `test/`.
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
 * before the `require` two lines below, and a module body cannot await. The
 * directory is removed by the root `after` hook at the foot of this file.
 * ------------------------------------------------------------------------- */

const BOOTSTRAP_DIRECTORY = fsSync.mkdtempSync(path.join(os.tmpdir(), 'store-test-boot-'));
process.env.ACTIVITY_STORE = path.join(BOOTSTRAP_DIRECTORY, 'activities.json');

/**
 * The store as loaded with the bootstrap path. Used for the pure functions
 * that touch no file — `normalizeLabel`, `isKnownStudent` — and for the
 * export-surface and safety checks. Every case that needs its own document
 * builds an independent instance through `freshStore`.
 */
const bootstrapStore = require('../activity-store');

/** The reader is stateless and holds no path, so one instance serves the file. */
const xlsxRead = require('../xlsx-read');

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

/** The suffix the store derives its staging path from. */
const TEMPORARY_SUFFIX = '.tmp';

/** The four refusal codes `activity-store.js` raises, and the reader's five. */
const E_LABEL_INVALID = 'E_LABEL_INVALID';
const E_STORE_UNREADABLE = 'E_STORE_UNREADABLE';
const E_STORE_WRITE_FAILED = 'E_STORE_WRITE_FAILED';
const E_XLSX_UNSUPPORTED_COMPRESSION = 'E_XLSX_UNSUPPORTED_COMPRESSION';
const E_XLSX_UNSUPPORTED_FLAGS = 'E_XLSX_UNSUPPORTED_FLAGS';
const E_XLSX_PART_NOT_FOUND = 'E_XLSX_PART_NOT_FOUND';
const E_XLSX_SHARED_STRINGS_UNSUPPORTED = 'E_XLSX_SHARED_STRINGS_UNSUPPORTED';
const E_XLSX_TRUNCATED = 'E_XLSX_TRUNCATED';

/* ========================================================================= *
 * Local harness
 *
 * Everything this suite needs, in this file. The rule's minimal-change area
 * caps `test/` at three files, so a shared helper module is not available and
 * a small amount of duplication between the three is the accepted cost.
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
    assert.fail(`${context}: expected a throw, but the call returned ${JSON.stringify(value)}`);
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
    assert.fail(`${context}: expected a rejection, but it resolved with ${JSON.stringify(value)}`);
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
 * @param {unknown} error The thrown value.
 * @param {string} expectedCode The expected `code` property.
 * @param {string} context Names the case in the failure message.
 * @returns {Error} `error`, once proven to carry the code.
 */
function assertCode(error, expectedCode, context) {
  assert.ok(error instanceof Error, `${context}: expected an Error, received ${typeof error}`);
  assert.strictEqual(
    error.code,
    expectedCode,
    `${context}: expected code ${expectedCode}, received ${String(error.code)} — ${error.message}`
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
 * @param {{method?: number, flag?: number, declaredCompressedSize?: number}} [options]
 *   `method` defaults to DEFLATE, which is what every real workbook here uses;
 *   `flag` defaults to 0, the only value the reader accepts;
 *   `declaredCompressedSize` overrides the size field so a header can claim
 *   more bytes than the file holds.
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
  const data = method === COMPRESSION_DEFLATE ? zlib.deflateRawSync(uncompressed) : uncompressed;

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
 * Builds a minimal worksheet part around one row of cell XML.
 *
 * The namespace and the `<dimension>` element are included because a real
 * part carries them and the reader has to skip past them to reach
 * `<sheetData>`.
 *
 * @param {string} cellsXml The `<c>` elements of a single row.
 * @param {string} [dimension] The declared dimension.
 * @returns {string} The part's XML.
 */
function worksheetXml(cellsXml, dimension = 'A1:C1') {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="${dimension}"/>` +
    `<sheetData><row r="1">${cellsXml}</row></sheetData>` +
    '</worksheet>'
  );
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
        `(${error.code || error.message}). Run the suite from a git checkout with git on PATH.`
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Teardown of the bootstrap directory created before the requires above. No
 * timer, listener or open handle is left anywhere in this file, so the runner
 * exits on its own and `--test-force-exit` is never needed.
 * ------------------------------------------------------------------------- */

after(async () => {
  await fs.rm(BOOTSTRAP_DIRECTORY, { recursive: true, force: true });
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
 * Normalization
 *
 * `normalizeLabel` is pure and touches no file, so this group shares the
 * bootstrap instance. The store file behind it is never written here — the
 * one case that needs a round trip takes its own isolated store.
 *
 * ON TAB AND NEWLINE, because it is the one place where two rules meet:
 * whitespace is trimmed and collapsed, AND a control character is refused. A
 * tab is both. `activity-store.js` resolves this by trimming and collapsing
 * the Unicode SPACE SEPARATOR category only, so a tab, a newline or a
 * carriage return survives untouched and is then refused by the
 * control-character rule. That is the only order in which the two rules do
 * not cancel each other out: laundering a tab into a space would ACCEPT a
 * label carrying a control character and leave the refusal rule dead for the
 * three control characters most likely to arrive. The cases below therefore
 * pin a tab as a refusal, and exercise the collapse of a mixed run with
 * genuine space separators — U+0020, U+00A0 and U+2003.
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

  it('refuses a tab, which is a control character rather than whitespace to launder', () => {
    const context = 'a tab inside a label';
    const error = captureThrow(() => bootstrapStore.normalizeLabel('Robotics\tClub'), context);
    assertCode(error, E_LABEL_INVALID, context);
    assert.match(
      error.message,
      /control character/,
      'the refusal must name the control-character rule, not the length or emptiness rule'
    );
  });

  it('refuses every control character, including one embedded mid-string', () => {
    const controlCharacters = [
      ['\u0000', 'NUL'],
      ['\u0007', 'BEL'],
      ['\u001f', 'UNIT SEPARATOR'],
      ['\n', 'LINE FEED'],
      ['\r', 'CARRIAGE RETURN'],
      ['\u007f', 'DELETE'],
    ];
    for (const [character, name] of controlCharacters) {
      const context = `${name} embedded mid-string`;
      const error = captureThrow(
        () => bootstrapStore.normalizeLabel(`Chess${character}Club`),
        context
      );
      assertCode(error, E_LABEL_INVALID, context);
    }
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
    assert.match(error.message, /60/, 'the refusal must name the bound it enforced');
  });

  it('refuses a whitespace-only label, which normalizes to empty', () => {
    for (const raw of ['', ' ', '   ', '\u00a0\u2003']) {
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

/** A timestamp in the exact form the store writes. */
const VALID_STAMP = '2026-09-16T06:14:22.481Z';

/** Serializes a document body the way a person or the store would write one. */
function bodyOf(activities) {
  return `${JSON.stringify(documentOf(activities), null, 2)}\n`;
}

/** Serializes any value as the whole store document. */
function rawBody(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A well-formed submission record, for mutating one field at a time. */
function baseSubmission(overrides = {}) {
  return {
    studentId: 'S001',
    activity: 'Chess Club',
    source: SOURCE_SUBMISSION,
    submittedAt: VALID_STAMP,
    ...overrides,
  };
}

/** A well-formed imported record, for mutating one field at a time. */
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
    body: bodyOf([baseSubmission({ activity: 'Chess\tClub' })]),
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
    assert.match(
      error.message,
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
    assert.match(listError.message, /\b12\b/, 'the refusal must name the offending method number');

    const readError = captureThrow(
      () => xlsxRead.readEntry(filePath, WORKSHEET_PART),
      `${context} (readEntry)`
    );
    assertCode(readError, E_XLSX_UNSUPPORTED_COMPRESSION, `${context} (readEntry)`);
    assert.doesNotMatch(
      readError.message,
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
    assert.ok(
      error.message.includes(WORKSHEET_PART),
      `the refusal must name the missing part; received: ${error.message}`
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

  it('returns parseable content-type bytes for every workbook', () => {
    for (const workbook of WORKBOOK_SHAPES) {
      const bytes = xlsxRead.readEntry(workbook.filePath, CONTENT_TYPES_PART);
      assert.ok(Buffer.isBuffer(bytes), `${workbook.label} must return a Buffer`);
      const xml = bytes.toString('utf8').trim();
      /* No XML declaration is asserted, deliberately: measured against these
       * packages, this part opens directly with its root element. An
       * assertion for a declaration would be an invented expectation. */
      assert.ok(
        xml.startsWith('<Types'),
        `${workbook.label}: the part must open with its root element; it begins ${JSON.stringify(xml.slice(0, 40))}`
      );
      assert.ok(
        xml.endsWith('</Types>'),
        `${workbook.label}: the part must be a complete, closed document`
      );
      assert.ok(
        xml.includes(WORKSHEET_PART) || xml.includes(`/${WORKSHEET_PART}`),
        `${workbook.label}: the worksheet part must be declared`
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
    assert.strictEqual(
      path.dirname(derived),
      path.dirname(configured),
      'the staging file must sit in the store directory, so the rename stays on one filesystem'
    );
    assert.strictEqual(await exists(derived), false, 'the staging file must not survive the write');
    assert.deepStrictEqual(
      (await fs.readdir(nested)).sort(),
      ['submissions.json'],
      'the directory must hold the store and nothing else'
    );
  });

  it('overwrites a stale staging file rather than ever reading it', async (t) => {
    const { store, storeFile, temporaryFile } = await makeIsolatedStore(t);
    /* What a dead process might have left: a truncated document, or bytes
     * that are not a document at all. Either way the next write truncates and
     * replaces it, so its contents can never be mistaken for the store. */
    await writeBytes(temporaryFile, '{"schemaVersion":1,"activities":[{"studentId":"S9');

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

    /* THE FAULT MECHANISM, chosen because it genuinely fails on every
     * platform this project runs on: a DIRECTORY is planted at the staging
     * path, so `writeFile` cannot open it (EISDIR) and the rename is never
     * reached. `fs.chmod` was rejected as the mechanism — it is effectively
     * inert on Windows, where this suite also has to fail for the right
     * reason. Pointing the store at a missing parent directory fails too, but
     * it leaves no previous document to prove intact, which is half of what
     * this case exists to assert. */
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
 * The four workbook invariants
 *
 * These are the properties the feature must not break. It writes no workbook,
 * so they hold by construction rather than by care — which is exactly why
 * they are asserted: the checks catch a workbook replaced by hand, or a
 * future change that starts writing one, rather than a fault in today's code.
 *
 * The group runs after the submission groups above, so the byte-identity
 * check below is taken after real submissions have been exercised. It also
 * performs its own submission, so it does not depend on that ordering.
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
     * rather than a shell. */
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
    /* The fixtures are only safe to read, log and assert on because every
     * value in them is invented: emails on the reserved example.edu domain
     * and phone numbers in one contiguous run. If a workbook were ever
     * repopulated with real records this case fails, and the whole suite's
     * treatment of that data would have to be reconsidered. */
    const rows = xlsxRead.readSheetRows(DETAILS_WORKBOOK, WORKSHEET_PART);
    const emails = rows.slice(1).map((row) => row.H);
    const phones = rows.slice(1).map((row) => row.I);

    assert.strictEqual(emails.length, 10);
    for (const email of emails) {
      assert.ok(
        email.endsWith('@example.edu'),
        `every fixture email must sit on the reserved example.edu domain; found ${JSON.stringify(email)}`
      );
    }
    assert.deepStrictEqual(
      phones,
      Array.from({ length: 10 }, (unused, index) => String(9822011001 + index)),
      'the fixture phone numbers must be the contiguous synthetic run'
    );
  });
});

