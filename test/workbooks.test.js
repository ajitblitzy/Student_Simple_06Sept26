'use strict';

/**
 * test/workbooks.test.js - fixture invariants for the three committed workbooks.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The activity feature was derived entirely from data the repository already
 * carried: the domain is `Extracurricular Activity` in column C of
 * `student_other_info.xlsx`, the key space is `Student ID` in column A of all
 * three workbooks, and the eight activity names are the values of that column.
 * Those binaries are therefore the feature's evidence base, and a binary
 * produces no reviewable diff - a changed workbook would silently change what
 * every route returns and what `lib/studentDirectory.js` and
 * `lib/activityRepository.js` accept at load. This file is the drift detector
 * that review cannot be: it pins the row count, the key set, the header cells
 * the loaders validate, and the SHA-256 of each file. The digest test is also
 * the proof that adding the feature modified none of them.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *   - It opens no socket, spawns no child process and writes nothing at all -
 *     not a temporary directory, not `activities.json`, and never a workbook.
 *     Every assertion here is a pure read, which is why this file is safe to
 *     run beside anything else and needs no teardown.
 *   - It declares EXACTLY FOUR top-level tests and no subtests, no `describe`
 *     and no `it`. Root `verify-tests.js` gates on
 *     `test:summary.counts.passed >= MIN_TESTS` with `MIN_TESTS` 45 = 33 + 8 +
 *     4, and `README.md` documents `MIN_TESTS=46 npm test` exiting 1 as proof
 *     that the guard is live. Subtests and `it`s count toward `passed`, so an
 *     extra one here would inflate the total and void that proof. Multi-case
 *     behaviour goes in a case table inside one test body instead, with the
 *     case named in the assertion message.
 *   - It uses no hook. Assertions made inside `before`/`after` do not count
 *     toward `counts.passed`, so nothing this file promises may live in one.
 *     Each test re-reads the workbooks it needs, which costs a few kilobytes
 *     and buys complete independence between the four tests.
 *   - It asserts nothing about the contents of `activities.json`: its shipped
 *     `[]` state and its bytes after a write belong to `test/activities.test.js`.
 *
 * Every value below was verified against this checkout before being written
 * here, and every assertion interpolates the offending value into its message
 * so a failure names what drifted rather than just that something did.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readWorksheetRows } = require('../lib/workbook');

/** The checkout root, where the workbooks sit beside `server.js`. */
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * The fixture table, serving all four tests. `digest` is the SHA-256 baseline
 * recorded in the plan and recomputed on this checkout; `headers` lists only
 * the header cells the service or this suite actually depends on - exactly the
 * cells `lib/studentDirectory.js` and `lib/activityRepository.js` validate at
 * load, so a mismatch here explains a startup failure there. Columns present
 * in the sheets but unused by the feature (Gender, Hostel Status, the GPA
 * columns and the rest) are deliberately not pinned: they are free to change.
 */
const WORKBOOKS = [
  {
    file: 'student_details.xlsx',
    sheet: 'Student Details',
    digest: '3923e3d75215b4f110737ddd7793cddc045cb232c7f11618314791daa51c68fa',
    headers: { A: 'Student ID', B: 'Name' }
  },
  {
    // Read by this suite only - the service never opens it. Its key column is
    // what makes the cross-workbook invariant of test 43 assertable at all.
    file: 'student_academics.xlsx',
    sheet: 'Academics',
    digest: 'd37bbe402609edbb18a6c6056cf662f55b82ec4be1b7ddcce0070a3a97aa0285',
    headers: { A: 'Student ID' }
  },
  {
    file: 'student_other_info.xlsx',
    sheet: 'Other Info',
    digest: 'b61f46c0f6b6350c2aa908e89367b745d611ca1d94b5eca65aabff9a617f9eb0',
    headers: { A: 'Student ID', C: 'Extracurricular Activity' }
  }
];

/**
 * The key space, written out literally rather than generated, so the assertion
 * states the contract instead of restating whatever the file happens to hold.
 */
const EXPECTED_IDS = [
  'S001',
  'S002',
  'S003',
  'S004',
  'S005',
  'S006',
  'S007',
  'S008',
  'S009',
  'S010'
];

/** One header row plus one row per student in `EXPECTED_IDS`. */
const EXPECTED_ROW_COUNT = 11;

/** The temporary file the repository's atomic registry write renames from. */
const TMP_ARTIFACT_NAME = 'activities.json.tmp';

/**
 * The `fs.mkdtempSync` prefix `test/activities.test.js` uses for its throwaway
 * registry directories. A shared helper module cannot hold it - every `.js`
 * file inside a directory named `test/` is executed as a test by default
 * discovery - so the literal is duplicated here and MUST STAY IN STEP WITH
 * `test/activities.test.js`; changing it there without changing it here turns
 * part 3 of test 45 into a check that can never fail.
 */
const TEMP_PREFIX = 'student-activities-';

/** Directories the artifact walk never descends into. */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

/**
 * Depth cap for the artifact walk. The checkout is two levels deep (`lib/`,
 * `test/`), so 8 is generous while still bounding the walk absolutely - a test
 * must not be able to run away over an unexpectedly deep tree.
 */
const MAX_WALK_DEPTH = 8;

/** Directory-listing failures that mean "nothing here to see", not a fault. */
const IGNORED_WALK_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM']);

/**
 * Reads a workbook at the checkout root and returns its rows.
 *
 * @param {string} file A workbook filename relative to `REPO_ROOT`.
 * @returns {Array<Record<string, string>>} Rows in document order, header first.
 */
const rowsOf = (file) => readWorksheetRows(path.join(REPO_ROOT, file));

/**
 * Hashes a file's bytes. Synchronous and whole-file: these packages are 5-6 KB.
 *
 * @param {string} absolutePath Path to the file to hash.
 * @returns {string} Lowercase hex SHA-256 digest.
 */
const digestOf = (absolutePath) =>
  crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');

/**
 * Walks a directory tree and collects every `activities.json.tmp` left behind.
 *
 * Bounded three ways so it cannot run away or loop: `SKIPPED_DIRECTORIES` keeps
 * it out of `.git` and `node_modules`, `MAX_WALK_DEPTH` caps recursion, and a
 * symlink is never descended into because `Dirent.isDirectory()` is false for
 * one. A directory that cannot be listed for an expected reason is skipped;
 * any other failure is rethrown, because a checkout this test cannot read is a
 * real fault rather than a clean result.
 *
 * @param {string} dir Absolute path of the directory to walk.
 * @param {number} [depth] Current recursion depth; callers pass nothing.
 * @returns {string[]} Absolute paths of the artifacts found, possibly empty.
 */
const findTmpArtifacts = (dir, depth = 0) => {
  if (depth > MAX_WALK_DEPTH) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (cause) {
    if (cause !== null && typeof cause === 'object' && IGNORED_WALK_ERRORS.has(cause.code)) {
      return [];
    }
    throw cause;
  }
  return entries.flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : findTmpArtifacts(absolute, depth + 1);
    }
    return entry.name === TMP_ARTIFACT_NAME ? [absolute] : [];
  });
};

// Test 42 - the shape of every fixture: a header row plus ten records.
test('every workbook holds a header row plus ten student records', () => {
  for (const { file, sheet, headers } of WORKBOOKS) {
    const rows = rowsOf(file);
    assert.equal(
      rows.length,
      EXPECTED_ROW_COUNT,
      `${file} (${sheet}) must hold ${EXPECTED_ROW_COUNT} rows, read ${rows.length}`
    );
    // A reader that silently dropped the header would still return ten data
    // rows, so the header is asserted here rather than only in test 44.
    assert.ok(
      rows[0] !== undefined && typeof rows[0] === 'object',
      `${file} (${sheet}) must expose a header row at index 0`
    );
    assert.notEqual(
      rows[0].A,
      '',
      `${file} (${sheet}) header cell A1 must be populated, read an empty cell`
    );
    assert.equal(
      typeof rows[0].A,
      'string',
      `${file} (${sheet}) header cell A1 must be a string, read ${typeof rows[0].A}`
    );
    assert.equal(
      Object.keys(headers).every((column) => typeof rows[0][column] === 'string'),
      true,
      `${file} (${sheet}) must expose every pinned header column as a string`
    );
  }
});

// Test 43 - the key set, and its identity across the three files, which is the
// claim the feature's referential-integrity checks rest on.
test('every workbook carries the identical Student ID key set S001 to S010', () => {
  const collected = WORKBOOKS.map(({ file, sheet }) => ({
    file,
    sheet,
    keys: rowsOf(file)
      .slice(1)
      .map((row) => row.A)
  }));

  for (const { file, sheet, keys } of collected) {
    assert.deepEqual(
      keys,
      EXPECTED_IDS,
      `${file} (${sheet}) column A rows 2-${EXPECTED_ROW_COUNT} must be ` +
        `${EXPECTED_IDS.join(', ')}, read ${keys.join(', ')}`
    );
  }

  // Equality with EXPECTED_IDS already implies cross-file identity, but the
  // pairwise comparison is stated explicitly so a failure names the two files
  // that disagree - that is the fact `lib/activityRepository.js` relies on
  // when it refuses an activity row whose key is absent from the directory.
  const pairs = collected.flatMap((left, index) =>
    collected.slice(index + 1).map((right) => [left, right])
  );
  for (const [left, right] of pairs) {
    assert.deepEqual(
      left.keys,
      right.keys,
      `${left.file} and ${right.file} must carry identical, identically ordered ` +
        `Student ID values; read ${left.keys.join(', ')} against ${right.keys.join(', ')}`
    );
  }
});

// Test 44 - the header cells the loaders validate at startup.
test('every workbook header names the columns the service reads', () => {
  for (const { file, sheet, headers } of WORKBOOKS) {
    const header = rowsOf(file)[0];
    for (const [column, label] of Object.entries(headers)) {
      assert.equal(
        header[column],
        label,
        `${file} (${sheet}) header cell ${column}1 must be '${label}', ` +
          `read '${header[column]}'`
      );
    }
  }
});

// Test 45 - the digests, which are the only drift detector a binary fixture
// has, plus the proof that the suite leaves nothing behind.
test('committed workbooks match their baseline digests and leave no temporary artifact', () => {
  for (const { file, sheet, digest } of WORKBOOKS) {
    const actual = digestOf(path.join(REPO_ROOT, file));
    assert.equal(
      actual,
      digest,
      `${file} (${sheet}) drifted from its committed baseline: ` +
        `expected SHA-256 ${digest}, read ${actual}`
    );
  }

  const artifacts = findTmpArtifacts(REPO_ROOT);
  assert.deepEqual(
    artifacts,
    [],
    `no ${TMP_ARTIFACT_NAME} may remain under ${REPO_ROOT}; found ${artifacts.join(', ')}`
  );

  // `verify-tests.js` runs activities, server, then workbooks at concurrency 1,
  // so this file executes last and any registry directory created by
  // test/activities.test.js has already been removed by its `after` hook -
  // reordering TEST_FILES would make this filter assert nothing. Only the
  // suite's own prefix is matched, so unrelated temp entries owned by other
  // processes can never fail this test.
  const leftovers = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX));
  assert.deepEqual(
    leftovers,
    [],
    `no ${TEMP_PREFIX}* entry may remain in ${os.tmpdir()}; found ${leftovers.join(', ')}`
  );
});
