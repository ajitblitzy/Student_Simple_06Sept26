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
 * Listed in ascending order, which is what lets test 43 compare a sorted copy
 * of each workbook's keys against it without caring about row order.
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
 * A short, stable token naming THIS checkout, derived from the absolute path of
 * its root so that two working trees of this repository never share it.
 *
 * Twelve hex characters of a SHA-256 over the root path: long enough that a
 * collision between two checkouts is not a practical concern, short enough to
 * keep a temporary directory name readable. The path is lower-cased first
 * because Windows path comparison is case-insensitive, so the same tree reached
 * through a differently-cased path must still yield the same token.
 */
const CHECKOUT_TOKEN = crypto
  .createHash('sha256')
  .update(REPO_ROOT.toLowerCase())
  .digest('hex')
  .slice(0, 12);

/**
 * The `fs.mkdtempSync` prefix `test/activities.test.js` uses for its throwaway
 * registry directories, and the namespace part 3 of test 45 inspects.
 *
 * `os.tmpdir()` is HOST-WIDE, and on this host up to 64 separate checkouts of
 * this repository run their suites side by side under that one temp root. A
 * bare `student-activities-` prefix is therefore a shared namespace, and
 * asserting that it is empty asserts something about other checkouts: a sibling
 * that is legitimately mid-write fails this suite, which is a false failure in
 * a file whose whole job is detecting real drift. Embedding `CHECKOUT_TOKEN`
 * makes the namespace private to this working tree, so the assertion covers
 * exactly the directories this suite created and nothing else.
 *
 * `test/activities.test.js` derives the same value from the same input with the
 * identical expression. It has to be derived rather than shared: a helper
 * module cannot hold it - every `.js` file inside a directory named `test/` is
 * executed as a test by default discovery - and the two files run in separate
 * child processes, so a path computed from `__dirname` is the only thing they
 * can be relied on to agree about. The derivation MUST STAY IN STEP WITH
 * `test/activities.test.js`; changing it there without changing it here turns
 * part 3 of test 45 into a check that can never fail.
 */
const TEMP_PREFIX = `student-activities-${CHECKOUT_TOKEN}-`;

/**
 * The only directories the artifact walk does not descend into. Both are
 * machine-managed and neither can hold a registry write: `.git` is object
 * storage and `node_modules` is an install target this dependency-free project
 * never populates. Everything else under the checkout is inspected.
 */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

/**
 * Runaway stop for the artifact walk, not a scope limit. The checkout is two
 * levels deep (`lib/`, `test/`) and symlinks are never followed, so a finite
 * tree cannot reach this depth; exceeding it means the walk is looping, which
 * is a fault. It therefore THROWS rather than returning - a bound that returns
 * "nothing found" would report a tree it never finished walking as clean.
 */
const WALK_DEPTH_LIMIT = 64;

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
 * Walks a directory tree collecting every `activities.json.tmp` left behind,
 * and - just as importantly - every directory it could not inspect.
 *
 * "No artifact found" and "nowhere left to look" are different results, and
 * conflating them is how a cleanup check passes over a tree it never read. So
 * the walk reports both: `artifacts` is what it found, and `unverified` names
 * every directory whose contents remain unknown. Test 45 fails on a non-empty
 * `unverified` exactly as it fails on a non-empty `artifacts`, because an
 * uninspected directory is an unproven claim rather than a clean one.
 *
 * The walk covers the whole checkout apart from `SKIPPED_DIRECTORIES`. A
 * symlink is not descended into - `Dirent.isDirectory()` is false for one, and
 * for a Windows junction too - which keeps the walk inside this tree and
 * finite; a symlink whose target lies within the checkout is still covered,
 * because the walk reaches that target as a real directory. `ENOENT` below the
 * root is the one benign listing failure: an entry that disappeared between the
 * `readdir` that named it and the descent into it holds nothing, which is a
 * complete answer rather than a missing one. `ENOENT` on the root itself, and
 * every other error at any level - `EACCES`, `EPERM`, `ENOTDIR` - leaves real
 * contents unread and is reported as unverified.
 *
 * @param {string} dir Absolute path of the directory to walk.
 * @param {number} [depth] Current recursion depth; callers pass nothing.
 * @returns {{artifacts: string[], unverified: string[]}} Absolute paths of the
 *   artifacts found, and `path (CODE)` for every directory left uninspected.
 *   Both arrays are empty when the whole tree was read and held no artifact.
 */
const findTmpArtifacts = (dir, depth = 0) => {
  if (depth > WALK_DEPTH_LIMIT) {
    throw new Error(
      `artifact walk exceeded ${WALK_DEPTH_LIMIT} levels at ${dir}; the checkout ` +
        'is two levels deep, so the walk is following a cycle rather than a tree'
    );
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (cause) {
    const code =
      cause !== null && typeof cause === 'object' && cause.code !== undefined
        ? String(cause.code)
        : 'UNKNOWN';
    if (code === 'ENOENT' && depth > 0) return { artifacts: [], unverified: [] };
    return { artifacts: [], unverified: [`${dir} (${code})`] };
  }

  const found = { artifacts: [], unverified: [] };
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const nested = findTmpArtifacts(absolute, depth + 1);
      found.artifacts.push(...nested.artifacts);
      found.unverified.push(...nested.unverified);
      continue;
    }
    if (entry.name === TMP_ARTIFACT_NAME) found.artifacts.push(absolute);
  }
  return found;
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

    // The shape of what the reader returned, asserted against the real bytes
    // rather than against a synthetic sheet. `lib/workbook.js` refuses a cell
    // whose `r` attribute is not a complete column-letters-plus-row-number
    // reference, so a key here that is not column letters would mean a
    // malformed reference had been accepted and had claimed a real column.
    rows.forEach((parsed, offset) => {
      for (const [column, value] of Object.entries(parsed)) {
        assert.match(
          column,
          /^[A-Z]{1,3}$/,
          `${file} (${sheet}) row ${offset + 1} is keyed by '${column}', which is not ` +
            'a column letter'
        );
        assert.equal(
          typeof value,
          'string',
          `${file} (${sheet}) cell ${column}${offset + 1} must be a string, read ` +
            `${typeof value}`
        );
      }
    });

    // Every column this feature depends on is populated in every data row, so
    // a blank one would mean the reader dropped a cell it had parsed - the
    // failure that would silently shorten a student's activity list.
    for (let index = 1; index < rows.length; index += 1) {
      for (const column of Object.keys(headers)) {
        assert.notEqual(
          rows[index][column],
          '',
          `${file} (${sheet}) cell ${column}${index + 1} must be populated, read an ` +
            'empty cell'
        );
      }
    }
  }
});

// Test 43 - the key set, and its identity across the three files, which is the
// claim the feature's referential-integrity checks rest on.
//
// The comparison is on SORTED COPIES, because what the feature depends on is
// the set of keys each file carries, not the order the rows happen to be in:
// nothing in `lib/studentDirectory.js` or `lib/activityRepository.js` reads a
// key by position, and a workbook whose rows were saved in another order would
// otherwise fail here for a reason this test is not about. Sorting copies
// rather than sets keeps the comparison a multiset one, so a duplicated or
// missing key still fails; row order and byte drift are test 45's digests.
test('every workbook carries the identical Student ID key set S001 to S010', () => {
  const collected = WORKBOOKS.map(({ file, sheet }) => {
    const keys = rowsOf(file)
      .slice(1)
      .map((row) => row.A);
    return { file, sheet, keys, sortedKeys: [...keys].sort() };
  });

  for (const { file, sheet, keys, sortedKeys } of collected) {
    assert.deepEqual(
      sortedKeys,
      EXPECTED_IDS,
      `${file} (${sheet}) column A rows 2-${EXPECTED_ROW_COUNT} must be the set ` +
        `${EXPECTED_IDS.join(', ')} in any order, read ${keys.join(', ')}`
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
      left.sortedKeys,
      right.sortedKeys,
      `${left.file} and ${right.file} must carry identical Student ID sets; ` +
        `read ${left.keys.join(', ')} against ${right.keys.join(', ')}`
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
      // Exactly as stored: no trimming, no case folding, no collapsing of
      // interior spaces. `Attendance %` and `Extracurricular Activity` are
      // compared byte for byte by the loaders, so any normalisation the reader
      // applied here would turn into a startup failure there.
      assert.equal(
        header[column].length,
        label.length,
        `${file} (${sheet}) header cell ${column}1 must be stored verbatim; read ` +
          `${header[column].length} characters against ${label.length}`
      );
    }

    // Reading the same file twice must produce the same rows. The reader holds
    // no module-level parse state - no pattern carrying `lastIndex` between
    // calls, no cache - so two reads of one snapshot cannot diverge, and the
    // two loaders that each read their own workbook cannot interfere.
    assert.deepEqual(
      rowsOf(file),
      rowsOf(file),
      `${file} (${sheet}) must read identically twice in a row`
    );
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

  const walk = findTmpArtifacts(REPO_ROOT);

  // Completeness is asserted first: "found no artifact" only means anything
  // once every directory that could hold one has actually been read, so a
  // directory the walk could not list fails here rather than passing as clean.
  assert.deepEqual(
    walk.unverified,
    [],
    `every directory under ${REPO_ROOT} except ` +
      `${[...SKIPPED_DIRECTORIES].join(' and ')} must be readable for the ` +
      `${TMP_ARTIFACT_NAME} check to mean anything; could not inspect ` +
      `${walk.unverified.join(', ')}`
  );
  assert.deepEqual(
    walk.artifacts,
    [],
    `no ${TMP_ARTIFACT_NAME} may remain under ${REPO_ROOT}; found ${walk.artifacts.join(', ')}`
  );

  // `verify-tests.js` runs activities, server, then workbooks at concurrency 1,
  // so this file executes last and any registry directory created by
  // test/activities.test.js has already been removed by its `after` hook -
  // reordering TEST_FILES would make this filter assert nothing.
  //
  // The filter is on TEMP_PREFIX, which carries this checkout's own token, so
  // it matches only the directories THIS suite created: the system temp root is
  // shared with up to 64 sibling checkouts of this repository and with every
  // other process on the host, and none of them can fail this assertion.
  const tempRoot = os.tmpdir();
  const leftovers = fs.readdirSync(tempRoot).filter((name) => name.startsWith(TEMP_PREFIX));
  assert.deepEqual(
    leftovers,
    [],
    `no ${TEMP_PREFIX}* entry may remain in ${tempRoot}; found ${leftovers.join(', ')}`
  );
});
