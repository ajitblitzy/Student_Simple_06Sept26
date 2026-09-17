'use strict';

/**
 * lib/activityRepository.js - the activity domain: merge, ordering, duplicates
 * and the one validated write this feature makes.
 *
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * The code scan that opened this work found `Extracurricular Activity` already
 * committed at `Other Info!C1:C11`, one activity per student, with `Student ID`
 * in column A of every workbook - and no code path anywhere that reached either
 * of them: the entrypoint imported `http` and touched no file. This module is
 * the domain layer over data the repository already carries. It is not a domain
 * invented beside the existing one.
 *
 * It owns three rules that belong nowhere else:
 *
 *   1. **Identity** - a record is the pair `(studentId, activityKey)`, where
 *      `activityKey` is the activity name trimmed and lower-cased. That pair is
 *      the uniqueness constraint of the whole feature.
 *   2. **Merge and ordering** - a student's activities are the one
 *      workbook-sourced record first, then that student's registry records in
 *      file order; the roster groups the same records by `activityKey`.
 *   3. **Duplicates** - there is no supersede rule. A registry record naming an
 *      activity a student already holds is a duplicate: refused on write, fatal
 *      at load with both records named.
 *
 * TWO SOURCES, ONE OF THEM WRITABLE
 * ---------------------------------------------------------------------------
 * `student_other_info.xlsx` stays authoritative for the baseline activity and
 * is **never written** - it is a hand-maintained binary fixture whose digest is
 * asserted by the test suite, and a binary produces no reviewable diff. New
 * activities land in an appendable JSON registry (`activities.json`, shipped as
 * `[]`), which is the only file this feature writes and where **each record
 * occupies one line**, so an addition stays small and reviewable rather than
 * opaque. It is not literally a one-line diff: the first record replaces `[]`
 * with a three-line array, and a later one also adds a comma to the line above
 * it. A stored registry record is exactly
 * `{"studentId": "...", "activity": "..."}`: `source` is **derived** from where
 * a record came from, never stored, which is also why a client cannot supply
 * it.
 *
 * WHAT IT RETAINS
 * ---------------------------------------------------------------------------
 * `lib/workbook.js` hands over whole rows because a ZIP entry decompresses as a
 * unit. Only columns A and C survive here: `Hostel Status`, `Library Books
 * Issued`, `Fee Status` and `Scholarship Holder` are dropped as the index is
 * built and can never reach a response payload.
 *
 * FAILURE CONTRACT
 * ---------------------------------------------------------------------------
 * Construction is strict, because it happens once while the server is being
 * built and a silently mis-read source would serve wrong data for the lifetime
 * of the process. Every one of these throws synchronously with the offending
 * source, row or record named, and `code === 'ACTIVITY_REPOSITORY_INVALID'`:
 *
 *   - a header cell that is not exactly its expected label (`A1` `Student ID`,
 *     `C1` `Extracurricular Activity`);
 *   - a `Student ID` in the activity sheet or the registry that is absent from
 *     the student directory (an activity would be served for a student the
 *     directory does not know);
 *   - a non-blank key that does not match `/^S\d{3}$/`;
 *   - a duplicate key within the activity sheet;
 *   - a duplicate `(studentId, activityKey)` within the registry or between the
 *     registry and the workbook;
 *   - a registry that is not a JSON array, is not parseable, or holds a record
 *     with keys other than `studentId`/`activity`, a non-string value, or an
 *     activity outside 1-64 characters after trimming;
 *   - an injected shape `lib/workbook.js` could never produce: a row that is not
 *     a plain object keyed by column letter, a cell holding anything but a
 *     string, or a supplied `registryRecords` that is not an array. `fromData`
 *     is the no-read equivalent of `load` and is exactly as strict as it
 *     (AAP 0.7.3), so malformed injected data is reported rather than
 *     reinterpreted as absent data.
 *
 * Three conditions are deliberately **not** fatal: a blank key cell skips the
 * row (so a maintainer may leave trailing empty rows); a blank activity cell on
 * a valid key means that student contributes no workbook record and legitimately
 * holds zero activities; and a **missing** registry file is a warning on stderr
 * with the registry treated as empty, so the service still serves the
 * workbook-sourced data. "Blank" is the empty string or a column the worksheet
 * omits - never `null`, which no reader can yield and which is fatal above.
 *
 * The write path rejects with a stable discriminator instead of a status, so
 * `lib/activityRoutes.js` selects `409` versus `500` without string matching:
 * `ACTIVITY_ALREADY_RECORDED` for a duplicate, `ACTIVITY_PERSIST_FAILED` for a
 * failed write, plus `INVALID_ACTIVITY`, `INVALID_STUDENT_ID` and
 * `STUDENT_NOT_FOUND` for arguments that never reach the queue.
 *
 * BOUNDARIES
 * ---------------------------------------------------------------------------
 * This module reads no environment variable and resolves no default -
 * `server.js` is the single composition root and hands over fully resolved
 * values. It produces no HTTP status, message or envelope; it throws or returns
 * and the routes module maps the outcome. It never logs to stdout and never
 * calls `process.exit`: turning a failure into process behaviour belongs to the
 * `require.main === module` wrapper in `server.js` alone. It imports nothing
 * beyond `./workbook`, `node:fs` and `node:path`.
 *
 * @example
 * const activityRepository = require('./lib/activityRepository');
 * const repository = activityRepository.load({
 *   workbookDir: __dirname,
 *   activitiesDataPath: path.join(__dirname, 'activities.json'),
 *   directory
 * });
 * repository.recordCount();            // 10
 * repository.listByStudent('S001');    // [{ activity: 'Robotics Club', source: 'workbook' }]
 * repository.listActivities('robotics club');
 * //   [{ activity: 'Robotics Club', count: 2, studentIds: ['S001', 'S009'] }]
 * await repository.addActivity('S003', 'Music Club');
 * //   { studentId: 'S003', activity: 'Music Club', source: 'registry' }
 */

const fs = require('node:fs');
const path = require('node:path');
const { readWorksheetRows } = require('./workbook');

/* ---------------------------------------------------------------------------
 * Constants - the whole contract of this module in one place.
 * ------------------------------------------------------------------------- */

/** The activity workbook, resolved inside the caller-supplied `workbookDir`. */
const ACTIVITY_WORKBOOK_FILENAME = 'student_other_info.xlsx';

// The only two columns of `Other Info` this module reads, and the labels their
// header cells must carry exactly. Everything else in the row is discarded.
const KEY_COLUMN = 'A';
const ACTIVITY_COLUMN = 'C';
const KEY_HEADER_LABEL = 'Student ID';
const ACTIVITY_HEADER_LABEL = 'Extracurricular Activity';

/** The two values `source` can take, derived from where a record came from. */
const SOURCE_WORKBOOK = 'workbook';
const SOURCE_REGISTRY = 'registry';

/** An activity name is 1-64 characters after trimming (AAP 0.5.4). */
const MAX_ACTIVITY_LENGTH = 64;

/** The exact key set of a stored registry record - two keys, no more. */
const STORED_RECORD_KEYS = ['studentId', 'activity'];

// Stable error discriminators. Every error this module produces carries one, so
// callers branch on `error.code` and never on a message.
const ERROR_INVALID = 'ACTIVITY_REPOSITORY_INVALID';
const ERROR_DUPLICATE = 'ACTIVITY_ALREADY_RECORDED';
const ERROR_PERSIST = 'ACTIVITY_PERSIST_FAILED';
const ERROR_INVALID_ACTIVITY = 'INVALID_ACTIVITY';
const ERROR_INVALID_STUDENT_ID = 'INVALID_STUDENT_ID';
const ERROR_STUDENT_NOT_FOUND = 'STUDENT_NOT_FOUND';

/** The scratch file the atomic writer renames over the registry. */
const TEMPORARY_SUFFIX = '.tmp';

/**
 * Worksheet rows are 1-based and `rows[0]` is the header, so a data row at
 * index `i` is worksheet row `i + 1`. Every message reports that number, which
 * is the one a maintainer sees in a spreadsheet application.
 */
const WORKSHEET_ROW_OFFSET = 1;

/**
 * Joins the two halves of a record's identity into one index key. `NUL` cannot
 * occur in a normalized `Student ID` (`/^S\d{3}$/`), so no activity name can
 * collide with a different pair by containing the separator.
 */
const PAIR_SEPARATOR = '\u0000';

/** U+FEFF, which some editors prepend to a UTF-8 file and `JSON.parse` rejects. */
const BYTE_ORDER_MARK = '\ufeff';

/**
 * The characters that must never reach a log record verbatim: the C0 controls
 * (CR and LF among them), DEL and the C1 controls, and the two Unicode line
 * separators. `sanitizeForLog` escapes every match.
 */
const LOG_UNSAFE_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

// How injected input is described in error messages when the caller names no
// source, mirroring `lib/studentDirectory.js`'s `'injected rows'`.
const INJECTED_ACTIVITY_SOURCE_LABEL = 'injected activity rows';
const INJECTED_REGISTRY_SOURCE_LABEL = 'injected registry records';

/** The directory members this module calls; `nameOf` belongs to the routes. */
const REQUIRED_DIRECTORY_MEMBERS = ['normalize', 'isValidFormat', 'has', 'ids'];

/** Swallows a settled queue result without altering the caller's promise. */
const noop = () => {};

/* ---------------------------------------------------------------------------
 * Small, side-effect-free helpers.
 * ------------------------------------------------------------------------- */

/**
 * Whether a value is a usable options/record object - not `null`, not an array,
 * not a primitive.
 *
 * @param {unknown} value The value to classify.
 * @returns {boolean} `true` for a non-null, non-array object.
 */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Describes a value's type for an error message without ever interpolating the
 * value itself, so a hostile or broken `toString` cannot hijack a diagnostic
 * and a wrong-typed activity is never echoed back.
 *
 * @param {unknown} value The value to describe.
 * @returns {string} `'null'`, `'array'`, or the `typeof` result.
 */
const describeValue = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

/**
 * Whether a value is a **row record**: a plain object keyed by column letter,
 * which is exactly what `lib/workbook.js` yields.
 *
 * Stricter than `isObject` on purpose, and only for rows. A `Date`, a `Map` or a
 * class instance passes `isObject` and carries no `A`/`C` property, so accepting
 * one would read every cell as blank and skip the row in silence - the failure
 * mode this predicate turns into a fatal error. The prototype test is what
 * distinguishes a record from those: the reader builds its rows with `{}`, and
 * an injected literal or an `Object.create(null)` row is equally acceptable.
 *
 * @param {unknown} value The candidate row.
 * @returns {boolean} `true` only for a plain, non-array record object.
 */
const isRowRecord = (value) => {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Describes a rejected row, distinguishing an array and an exotic object from a
 * primitive, since `typeof` reports `'object'` for all three.
 *
 * @param {unknown} row The row that failed `isRowRecord`.
 * @returns {string} A short description for the error message.
 */
const describeRowShape = (row) => {
  if (Array.isArray(row)) return 'array';
  if (row !== null && typeof row === 'object') return 'non-record object';
  return describeValue(row);
};

/**
 * Renders text safe to write as one log record (CWE-117).
 *
 * An activity name is free text of 1-64 characters by contract (AAP 0.5.4), and
 * that contract is deliberately **not** narrowed here - it is the *sink* that is
 * made safe. A caller who posts an activity containing CR, LF or a terminal
 * escape would otherwise see it reproduced verbatim on stderr, where a
 * line-oriented log reader would take the second line as a separate record and a
 * terminal would act on the escape. Every C0 and C1 control character, plus
 * U+2028 and U+2029 which some readers treat as line breaks, is replaced by its
 * `\uXXXX` spelling, so the record stays one line and says exactly what arrived.
 *
 * Applying this twice is harmless: the replacement text contains no control
 * character, so a second pass finds nothing to escape.
 *
 * @param {string} text The text to render.
 * @returns {string} The text with every control character escaped.
 */
const sanitizeForLog = (text) =>
  text.replace(
    LOG_UNSAFE_PATTERN,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );

/**
 * Summarises a thrown value for an error detail without throwing itself - a
 * caller's diagnostic must not be lost to a second failure.
 *
 * The result is log-safe: a thrown value can carry text that originated with a
 * caller (a writer substituted by a test, or a filesystem error naming a path),
 * so every control character is escaped here rather than at each of the six
 * call sites (CWE-117).
 *
 * @param {unknown} cause The value caught from a failing call.
 * @returns {string} A short, single-line description, never empty.
 */
const describeCause = (cause) => {
  if (cause instanceof Error && typeof cause.message === 'string' && cause.message !== '') {
    return sanitizeForLog(cause.message);
  }
  if (cause === null || cause === undefined) return 'unknown error';
  if (typeof cause === 'object') return 'unknown error';
  return `${typeof cause} thrown: ${sanitizeForLog(String(cause))}`;
};

/**
 * The case-folded, trimmed form of an activity name - the second half of a
 * record's identity, the roster's grouping key, and what the optional roster
 * filter is compared against. `'Robotics Club'`, `'robotics club'` and
 * `'  ROBOTICS CLUB  '` all key to `'robotics club'`.
 *
 * @param {string} activity The activity name as stored or supplied.
 * @returns {string} The activity key.
 */
const activityKeyOf = (activity) => activity.trim().toLowerCase();

/**
 * The index key for a record's identity pair.
 *
 * @param {string} studentId A normalized `Student ID`.
 * @param {string} activityKey The output of `activityKeyOf`.
 * @returns {string} The pair key.
 */
const pairKeyOf = (studentId, activityKey) => `${studentId}${PAIR_SEPARATOR}${activityKey}`;

/**
 * Ascending comparison of two activity keys by code unit. Deliberately not
 * `localeCompare`: the roster's group order is part of the response contract and
 * must not vary with the host's locale or ICU build.
 *
 * @param {string} left First key.
 * @param {string} right Second key.
 * @returns {number} `-1`, `0` or `1`.
 */
const compareActivityKeys = (left, right) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

/**
 * The scratch path the atomic writer uses, always **beside** the target so the
 * rename stays within one filesystem and therefore stays atomic.
 *
 * @param {string} targetPath The registry file's path.
 * @returns {string} `<target>.tmp` in the target's own directory.
 */
const temporaryPathFor = (targetPath) =>
  path.join(path.dirname(targetPath), `${path.basename(targetPath)}${TEMPORARY_SUFFIX}`);

/* ---------------------------------------------------------------------------
 * Error builders - one shape per failure class, each with a stable `code`.
 * ------------------------------------------------------------------------- */

/**
 * Builds the construction-time failure shape: which source failed, what is
 * wrong with the offending value interpolated, and any structured detail worth
 * handling programmatically.
 *
 * @param {string} source `'Activity source (<path>)'`, `'Activity registry
 *   (<path>)'`, or an injected-input label.
 * @param {string} summary What is wrong, with the offending value named.
 * @param {Record<string, unknown>} [details] Extra properties to set on the
 *   error - `row`, `record`, `studentId`, `activity`, `path` where they apply.
 * @param {unknown} [cause] The underlying error, preserved as `error.cause`.
 * @returns {Error} The error to throw, with `code === 'ACTIVITY_REPOSITORY_INVALID'`.
 */
const createRepositoryError = (source, summary, details, cause) => {
  const message = `${source}: ${summary}`;
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = ERROR_INVALID;
  error.source = source;
  if (details !== undefined) {
    Object.keys(details).forEach((key) => {
      error[key] = details[key];
    });
  }
  return error;
};

/**
 * Builds the failure for a misuse of this module's own API - a missing options
 * object, a directory that is not a directory, a `writeFile` that is not a
 * function. It shares `ERROR_INVALID` because, like a malformed source, it
 * aborts construction.
 *
 * @param {string} summary What the caller got wrong.
 * @returns {Error} The error to throw.
 */
const createUsageError = (summary) => {
  const error = new Error(`Activity repository: ${summary}`);
  error.code = ERROR_INVALID;
  return error;
};

/**
 * The refusal for a `(studentId, activityKey)` pair that is already recorded.
 * `lib/activityRoutes.js` maps this `code` to `409 ACTIVITY_ALREADY_RECORDED`
 * and composes its own client-facing sentence, so this message exists for logs
 * and names where the existing record came from.
 *
 * Because the message is written for a log, the caller's activity text is
 * escaped into it (CWE-117); `error.activity` keeps the value verbatim for any
 * caller that needs the real string.
 *
 * @param {string} studentId The normalized identifier.
 * @param {string} activity The activity the caller supplied, trimmed.
 * @param {string} origin How the existing record is described.
 * @returns {Error} The error to reject with.
 */
const createDuplicateError = (studentId, activity, origin) => {
  const error = new Error(
    `Student ${studentId} already holds activity "${sanitizeForLog(activity)}" ` +
      `(recorded by ${origin})`
  );
  error.code = ERROR_DUPLICATE;
  error.studentId = studentId;
  error.activity = activity;
  return error;
};

/**
 * The failure for a write that did not land. The index is left untouched, so the
 * rejected request is the only casualty.
 *
 * This message is the one that reaches stderr: `lib/activityRoutes.js` logs it
 * (and its stack, which embeds it) on the `500` path while the client gets only
 * the fixed sentence. The caller's activity text is therefore escaped into it,
 * so a name carrying CR, LF or a terminal escape cannot forge or split a log
 * record (CWE-117). `error.activity` keeps the value verbatim.
 *
 * @param {string} studentId The normalized identifier.
 * @param {string} activity The trimmed activity name.
 * @param {string} targetPath The registry path that could not be written.
 * @param {unknown} cause The underlying failure, preserved as `error.cause`.
 * @returns {Error} The error to reject with.
 */
const createPersistError = (studentId, activity, targetPath, cause) => {
  const error = new Error(
    `Could not persist activity "${sanitizeForLog(activity)}" for ` +
      `${KEY_HEADER_LABEL} ${studentId} ` +
      `to ${targetPath === '' ? '(no registry path configured)' : targetPath}: ${describeCause(cause)}`,
    { cause }
  );
  error.code = ERROR_PERSIST;
  error.studentId = studentId;
  error.activity = activity;
  if (targetPath !== '') error.path = targetPath;
  return error;
};

/**
 * The refusal for an activity argument that is not a 1-64 character string.
 * The routes module answers `400 INVALID_ACTIVITY` with a fixed sentence that
 * interpolates nothing, so this message may describe the type safely.
 *
 * @param {string} detail What was received.
 * @returns {Error} The error to reject with.
 */
const createInvalidActivityError = (detail) => {
  const error = new Error(
    `activity must be a string of 1 to ${MAX_ACTIVITY_LENGTH} characters after trimming (${detail})`
  );
  error.code = ERROR_INVALID_ACTIVITY;
  return error;
};

/**
 * The refusal for an identifier that cannot address a student. Two codes rather
 * than one, because keeping shape (`400`) and existence (`404`) distinguishable
 * is the point of the identifier contract.
 *
 * @param {unknown} id The identifier as received.
 * @param {boolean} wellFormed `true` when the shape was fine and only the
 *   student is unknown.
 * @returns {Error} The error to reject with.
 */
const createStudentError = (id, wellFormed) => {
  const rendered = typeof id === 'string' ? id : describeValue(id);
  const error = wellFormed
    ? new Error(`No student with ${KEY_HEADER_LABEL} ${rendered}`)
    : new Error(`${KEY_HEADER_LABEL} must match S followed by three digits: ${rendered}`);
  error.code = wellFormed ? ERROR_STUDENT_NOT_FOUND : ERROR_INVALID_STUDENT_ID;
  error.studentId = rendered;
  return error;
};

/* ---------------------------------------------------------------------------
 * Source labels.
 * ------------------------------------------------------------------------- */

/**
 * How the activity sheet is named in messages.
 *
 * @param {unknown} source The workbook path `load` read, if any.
 * @returns {string} `'Activity source (<path>)'` or the injected-input label.
 */
const activitySourceLabel = (source) =>
  typeof source === 'string' && source !== ''
    ? `Activity source (${source})`
    : `Activity source (${INJECTED_ACTIVITY_SOURCE_LABEL})`;

/**
 * How the registry is named in messages. `load` passes the file it read; an
 * injected record set is labelled as injected even when a write target is
 * configured, because the records did not come from that file.
 *
 * @param {unknown} source The registry path `load` read, if any.
 * @returns {string} `'Activity registry (<path>)'` or the injected-input label.
 */
const registrySourceLabel = (source) =>
  typeof source === 'string' && source !== ''
    ? `Activity registry (${source})`
    : `Activity registry (${INJECTED_REGISTRY_SOURCE_LABEL})`;

/* ---------------------------------------------------------------------------
 * Reading and validating the activity worksheet.
 * ------------------------------------------------------------------------- */

/**
 * Reads one of the two retained cells as a string.
 *
 * **The row contract, and why it is enforced rather than tolerated.**
 * `lib/workbook.js` yields a plain object keyed by column letter whose every
 * value is a string, and it simply **omits** a column absent from the worksheet
 * XML. So exactly two inputs mean "blank": an omitted property (`undefined`)
 * and the empty string. Everything else - `null`, a number, a boolean, an
 * object - cannot come from the reader at all; it can only come from an
 * injected row, and it is **refused** rather than coerced.
 *
 * Coercing would be the more dangerous choice, and in both columns:
 *
 *   - a `null` **key** read as `''` looks like the trailing blank row a
 *     maintainer left behind, so the row is skipped and its activity vanishes;
 *   - a `null` **activity** read as `''` makes a student who holds an activity
 *     look like one who legitimately holds none, and `GET` then answers `200`
 *     with `count` 0 - a wrong answer served confidently for the lifetime of
 *     the process.
 *
 * `fromData` is the no-read equivalent of `load` and must be exactly as strict
 * as it (AAP 0.7.3), so both cases are fatal here with the row and cell named.
 * The two genuinely non-fatal cases of AAP 0.5.5 are unaffected: a blank key
 * cell (`''` or an omitted column) still skips the row, and a blank activity
 * cell on a valid key still means that student contributes no workbook record.
 *
 * @param {unknown} row The row record handed over by the reader.
 * @param {string} column The column letter to read.
 * @param {string} source Label of the sheet, for the error message.
 * @param {number} rowNumber Worksheet row number, for the error message.
 * @returns {string} The cell's text, `''` when the cell is absent or empty.
 * @throws {Error} When the row is not a plain record object, or the cell holds
 *   anything other than a string or an omitted property.
 */
const readCell = (row, column, source, rowNumber) => {
  if (!isRowRecord(row)) {
    throw createRepositoryError(
      source,
      `row ${rowNumber} must be a plain object keyed by column letter ` +
        `(received ${describeRowShape(row)})`,
      { row: rowNumber }
    );
  }
  const value = row[column];
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw createRepositoryError(
      source,
      `cell ${column}${rowNumber} must be a string (received ${describeValue(value)})`,
      { row: rowNumber }
    );
  }
  return value;
};

/**
 * Validates the header row before a single data row is read. A sheet whose
 * columns have moved would otherwise be read with guessed positions and yield a
 * blank activity for every student - the exact silent failure this check exists
 * to prevent, which is why a mismatch is fatal rather than a warning.
 *
 * Only `A1` and `C1` are checked. `B`, `D`, `E` and `F` (`Hostel Status`,
 * `Library Books Issued`, `Fee Status`, `Scholarship Holder`) are out of this
 * feature's scope, so requiring their labels would reject a sheet this module
 * can read perfectly well.
 *
 * @param {Array<Record<string, string>>} rows The worksheet's rows.
 * @param {string} source Label of the sheet.
 * @returns {void}
 * @throws {Error} When there is no header row, or either label is not exact.
 */
const assertActivityHeaderRow = (rows, source) => {
  if (rows.length === 0) {
    throw createRepositoryError(
      source,
      `no rows were found, so the header row (${KEY_COLUMN}1 "${KEY_HEADER_LABEL}", ` +
        `${ACTIVITY_COLUMN}1 "${ACTIVITY_HEADER_LABEL}") could not be validated`
    );
  }
  const header = rows[0];
  const expected = [
    { column: KEY_COLUMN, label: KEY_HEADER_LABEL },
    { column: ACTIVITY_COLUMN, label: ACTIVITY_HEADER_LABEL }
  ];
  expected.forEach(({ column, label }) => {
    const actual = readCell(header, column, source, 1);
    if (actual !== label) {
      throw createRepositoryError(
        source,
        `header cell ${column}1 must be exactly "${label}" (received "${actual}")`,
        { row: 1 }
      );
    }
  });
};

/**
 * Collects the one workbook-sourced activity per student from every populated
 * row after the validated header. There is no `A2:A11`/`C2:C11` bound, so an
 * eleventh student added by hand to both workbooks is served with no code
 * change.
 *
 * Only the key and the activity are copied out; the row object is dropped,
 * which is what keeps every other column of `Other Info` out of memory.
 *
 * @param {Array<Record<string, string>>} rows The worksheet's rows, header first.
 * @param {string} source Label of the sheet.
 * @param {{normalize: Function, isValidFormat: Function, has: Function}} directory
 *   The student directory, the single source of truth for which keys exist.
 * @returns {Map<string, {activity: string, rowNumber: number}>} The activity
 *   cell per student, keyed by normalized identifier. A student whose activity
 *   cell is blank is present with `activity === ''` so that a duplicate key is
 *   still detected on a blank row.
 * @throws {Error} On a malformed key, a duplicate key, or a key the directory
 *   does not know.
 */
const collectWorkbookActivities = (rows, source, directory) => {
  const found = new Map();
  const rowNumberOf = new Map();

  for (let index = 1; index < rows.length; index += 1) {
    const rowNumber = index + WORKSHEET_ROW_OFFSET;
    const rawKey = readCell(rows[index], KEY_COLUMN, source, rowNumber);
    const studentId = directory.normalize(rawKey);

    // A blank key cell is an empty row a maintainer left behind - skipped, not
    // fatal. Blankness is judged after trimming, which `normalize` has done.
    if (studentId === '') continue;

    if (!directory.isValidFormat(studentId)) {
      throw createRepositoryError(
        source,
        `row ${rowNumber} has a malformed ${KEY_HEADER_LABEL} "${rawKey}" - ` +
          'it must be S followed by exactly three digits',
        { row: rowNumber, studentId: rawKey }
      );
    }

    if (found.has(studentId)) {
      throw createRepositoryError(
        source,
        `duplicate ${KEY_HEADER_LABEL} ${studentId} at rows ` +
          `${rowNumberOf.get(studentId)} and ${rowNumber}`,
        { row: rowNumber, studentId }
      );
    }

    // Referential integrity: the directory decides which students exist, and an
    // activity for a student it does not know must never be served.
    if (!directory.has(studentId)) {
      throw createRepositoryError(
        source,
        `row ${rowNumber} names ${KEY_HEADER_LABEL} ${studentId}, ` +
          'which is not in the student directory',
        { row: rowNumber, studentId }
      );
    }

    // The stored spelling is kept verbatim: the response must carry the value as
    // the workbook has it, and only `activityKeyOf` folds case and whitespace.
    found.set(studentId, {
      activity: readCell(rows[index], ACTIVITY_COLUMN, source, rowNumber),
      rowNumber
    });
    rowNumberOf.set(studentId, rowNumber);
  }

  return found;
};

/* ---------------------------------------------------------------------------
 * Validating registry records and activity arguments.
 * ------------------------------------------------------------------------- */

/**
 * Validates one stored registry record and returns it with its identifier
 * normalized. Every fault here is fatal at load: silently ignoring a corrupt
 * registry would under-report a student's activities, which is worse than
 * refusing to start.
 *
 * A record must be an object carrying **exactly** `studentId` and `activity`,
 * both strings - `source` is derived at serialization time and is never stored,
 * so a file that carries it is a file written by something other than this
 * module.
 *
 * @param {unknown} record The parsed record.
 * @param {number} position The record's 1-based position, for the message.
 * @param {string} source Label of the registry.
 * @param {{normalize: Function, isValidFormat: Function, has: Function}} directory
 *   The student directory.
 * @returns {{studentId: string, activity: string}} The record, identifier
 *   normalized and activity kept verbatim.
 * @throws {Error} On a wrong shape, an unexpected or missing key, a malformed or
 *   orphan identifier, or an activity outside 1-64 characters after trimming.
 */
const validateStoredRecord = (record, position, source, directory) => {
  if (!isObject(record)) {
    throw createRepositoryError(
      source,
      `record ${position} must be an object with exactly the keys ` +
        `"${STORED_RECORD_KEYS.join('" and "')}" (received ${describeValue(record)})`,
      { record: position }
    );
  }

  const keys = Object.keys(record);
  const unexpected = keys.find((key) => !STORED_RECORD_KEYS.includes(key));
  if (unexpected !== undefined) {
    throw createRepositoryError(
      source,
      `record ${position} carries an unexpected field "${unexpected}" - a stored ` +
        `record holds exactly "${STORED_RECORD_KEYS.join('" and "')}"`,
      { record: position }
    );
  }
  const missing = STORED_RECORD_KEYS.find((key) => !keys.includes(key));
  if (missing !== undefined) {
    throw createRepositoryError(
      source,
      `record ${position} is missing the required field "${missing}"`,
      { record: position }
    );
  }

  if (typeof record.studentId !== 'string') {
    throw createRepositoryError(
      source,
      `record ${position} has a ${KEY_HEADER_LABEL} that is not a string ` +
        `(received ${describeValue(record.studentId)})`,
      { record: position }
    );
  }
  const studentId = directory.normalize(record.studentId);
  if (!directory.isValidFormat(studentId)) {
    throw createRepositoryError(
      source,
      `record ${position} has a malformed ${KEY_HEADER_LABEL} "${record.studentId}" - ` +
        'it must be S followed by exactly three digits',
      { record: position, studentId: record.studentId }
    );
  }
  if (!directory.has(studentId)) {
    throw createRepositoryError(
      source,
      `record ${position} names ${KEY_HEADER_LABEL} ${studentId}, ` +
        'which is not in the student directory',
      { record: position, studentId }
    );
  }

  if (typeof record.activity !== 'string') {
    throw createRepositoryError(
      source,
      `record ${position} (${studentId}) has an activity that is not a string ` +
        `(received ${describeValue(record.activity)})`,
      { record: position, studentId }
    );
  }
  const trimmed = record.activity.trim();
  if (trimmed === '' || trimmed.length > MAX_ACTIVITY_LENGTH) {
    throw createRepositoryError(
      source,
      `record ${position} (${studentId}) has an invalid activity "${record.activity}" - ` +
        `it must be a string of 1 to ${MAX_ACTIVITY_LENGTH} characters after trimming`,
      { record: position, studentId, activity: record.activity }
    );
  }

  return { studentId, activity: record.activity };
};

/**
 * Validates the `activity` argument of a write and returns it trimmed, which is
 * the form that is stored - so a hand-typed `'  Music Club '` lands in the file
 * as `'Music Club'` rather than preserving the caller's whitespace.
 *
 * The routes module has its own copy of this rule and answers `400
 * INVALID_ACTIVITY` before calling here; this check exists because the
 * repository is also called directly (by tests and by any future caller) and a
 * write must never be able to store a value the read path would reject.
 *
 * @param {unknown} activity The caller's activity name.
 * @returns {string} The trimmed activity name.
 * @throws {Error} With `code === 'INVALID_ACTIVITY'` for a non-string, a blank
 *   or whitespace-only string, or a value longer than 64 characters.
 */
const validateActivityValue = (activity) => {
  if (typeof activity !== 'string') {
    throw createInvalidActivityError(`received ${describeValue(activity)}`);
  }
  const trimmed = activity.trim();
  if (trimmed === '') {
    throw createInvalidActivityError('received a blank string');
  }
  if (trimmed.length > MAX_ACTIVITY_LENGTH) {
    throw createInvalidActivityError(`received ${trimmed.length} characters`);
  }
  return trimmed;
};

/**
 * Confirms the injected directory exposes the members this module calls, before
 * any row is read. A missing member would otherwise surface much later as a
 * `TypeError` in the middle of index construction.
 *
 * @param {unknown} directory The injected student directory.
 * @returns {void}
 * @throws {Error} When the directory is absent or incomplete.
 */
const assertDirectory = (directory) => {
  if (!isObject(directory)) {
    throw createUsageError(
      `a student directory is required (received ${describeValue(directory)})`
    );
  }
  const missing = REQUIRED_DIRECTORY_MEMBERS.find((member) => typeof directory[member] !== 'function');
  if (missing !== undefined) {
    throw createUsageError(`the student directory must expose a ${missing}() function`);
  }
};

/* ---------------------------------------------------------------------------
 * Persistence - the only file this feature writes.
 * ------------------------------------------------------------------------- */

/**
 * Serializes the whole registry. A full rewrite is safe at this size (a handful
 * of records, roughly 100 bytes each) and cannot leave a partial append, which
 * an append-in-place could.
 *
 * The format is one record per line, two-space indented, newline-terminated, so
 * an addition is a **small, reviewable diff**: the added record is a single line
 * of its own. It is not exactly one changed line - writing the first record
 * replaces `[]` with `[`, the record, and `]`, and writing a later one appends a
 * comma to the previous record's line - but no record is ever reflowed, so a
 * review reads the addition rather than a rewritten file. Only the two stored
 * keys are written, in a fixed order: `source` is derived and never stored.
 *
 * @param {Array<{studentId: string, activity: string}>} records The registry in
 *   file order.
 * @returns {string} The file's contents, ending in a newline.
 */
const serializeRegistry = (records) => {
  if (records.length === 0) return '[]\n';
  const lines = records.map(
    (record) => `  ${JSON.stringify({ studentId: record.studentId, activity: record.activity })}`
  );
  return `[\n${lines.join(',\n')}\n]\n`;
};

/**
 * The default writer: write the scratch file beside the target, then rename it
 * over the target. `fs.renameSync` within one directory is atomic, so a reader
 * sees either the old registry or the new one and never a half-written file.
 *
 * Tests substitute this through `fromData`'s `writeFile` option to exercise the
 * persistence-failure and queue-recovery paths; the signature is deliberately
 * `fs.writeFileSync`-shaped so a substitute can delegate to a real write.
 *
 * @param {string} targetPath The registry file to replace.
 * @param {string} contents The serialized registry.
 * @returns {void}
 * @throws {Error} Whatever the filesystem raises; the caller rejects that one
 *   request and removes the scratch file.
 */
const writeRegistryAtomically = (targetPath, contents) => {
  const temporaryPath = temporaryPathFor(targetPath);
  fs.writeFileSync(temporaryPath, contents, 'utf8');
  fs.renameSync(temporaryPath, targetPath);
};

/**
 * **Attempts** to remove the scratch file after a failed write, on a best-effort
 * basis (AAP 0.6.6): the caller is already rejecting a request, and a cleanup
 * failure must not replace that diagnostic with a second one.
 *
 * Removal is therefore attempted, not guaranteed. A missing file is a no-op, and
 * a filesystem that refuses the removal - a permission denial, or a lock another
 * process holds on the scratch path - leaves the artifact in place and is
 * reported on stderr below. What the suite asserts is the ordinary path: after a
 * write that failed in the writer, no `activities.json.tmp` remains beside the
 * registry, and none remains anywhere under the checkout.
 *
 * @param {string} targetPath The registry file the write was aiming at.
 * @returns {void}
 */
const discardTemporaryArtifact = (targetPath) => {
  const temporaryPath = temporaryPathFor(targetPath);
  try {
    // `force` makes a missing file a no-op, which is the common case: most write
    // failures happen before or during the scratch write.
    fs.rmSync(temporaryPath, { force: true });
  } catch (cause) {
    // Reported rather than swallowed, so an undeletable artifact is visible to an
    // operator without turning cleanup into a second failure for the client. The
    // whole record is escaped to one line: the path is configuration and the
    // cause is a filesystem message, and neither may break the log format.
    process.stderr.write(
      `${sanitizeForLog(
        `Could not remove the temporary activity registry file ${temporaryPath}: ` +
          `${describeCause(cause)}`
      )}\n`
    );
  }
};

/**
 * Confirms the registry's own directory exists and is writable, so a
 * misconfigured path fails while the server is being constructed rather than on
 * the first write attempt hours later. This runs only when the repository is
 * built from files - `fromData` performs no file access at all, and an injected
 * repository must be able to name paths that do not exist.
 *
 * The existence half is exact; the writability half is advisory by nature, since
 * a platform may report a directory writable and still refuse a particular file.
 * That residual case is what the write path's rejection covers.
 *
 * @param {string} filePath The resolved registry path.
 * @returns {void}
 * @throws {Error} With `code === 'ACTIVITY_REPOSITORY_INVALID'` when the parent
 *   is missing, is not a directory, or cannot be written.
 */
const assertRegistryLocationUsable = (filePath) => {
  const source = registrySourceLabel(filePath);
  const directoryPath = path.dirname(filePath);

  let stats;
  try {
    stats = fs.statSync(directoryPath);
  } catch (cause) {
    throw createRepositoryError(
      source,
      `the registry's directory ${directoryPath} cannot be inspected, so an ` +
        `activity could never be persisted (${describeCause(cause)})`,
      { path: filePath },
      cause
    );
  }
  if (!stats.isDirectory()) {
    throw createRepositoryError(
      source,
      `the registry's parent ${directoryPath} is not a directory`,
      { path: filePath }
    );
  }

  try {
    fs.accessSync(directoryPath, fs.constants.W_OK);
  } catch (cause) {
    throw createRepositoryError(
      source,
      `the registry's directory ${directoryPath} is not writable, so an activity ` +
        `could never be persisted (${describeCause(cause)})`,
      { path: filePath },
      cause
    );
  }
};

/**
 * Reads and parses the registry file.
 *
 * A **missing** file is not fatal: the registry is treated as empty and a
 * warning names the path, so a fresh checkout that has not created
 * `activities.json` still serves every workbook-sourced activity. Every other
 * fault is fatal, because a registry that cannot be read in full would
 * under-report a student's activities.
 *
 * @param {string} filePath The resolved registry path.
 * @returns {unknown[]} The parsed records in file order, or `[]` when the file
 *   is absent.
 * @throws {Error} With `code === 'ACTIVITY_REPOSITORY_INVALID'` when the file
 *   cannot be read, is not valid JSON, or does not hold a JSON array.
 */
const readRegistryFile = (filePath) => {
  const source = registrySourceLabel(filePath);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (cause) {
    if (cause !== null && typeof cause === 'object' && cause.code === 'ENOENT') {
      // One line, with the configured path escaped into it: test 28 matches this
      // warning by the path it names, and a path is never allowed to end the
      // record early.
      process.stderr.write(
        `${sanitizeForLog(
          `Activity registry not found at ${filePath}; continuing with the ` +
            'workbook-sourced activities only'
        )}\n`
      );
      return [];
    }
    throw createRepositoryError(
      source,
      `the file could not be read (${describeCause(cause)})`,
      { path: filePath },
      cause
    );
  }

  // Strip a UTF-8 byte order mark: some editors add one, and `JSON.parse`
  // rejects it, which would turn a hand edit into a fatal start-up failure for a
  // file whose JSON is otherwise perfectly valid.
  const text = raw.charCodeAt(0) === BYTE_ORDER_MARK.charCodeAt(0) ? raw.slice(1) : raw;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw createRepositoryError(
      source,
      `the file does not contain valid JSON (${describeCause(cause)})`,
      { path: filePath },
      cause
    );
  }

  if (!Array.isArray(parsed)) {
    throw createRepositoryError(
      source,
      'the file must contain a JSON array of records ' +
        `(received ${describeValue(parsed)})`,
      { path: filePath }
    );
  }

  return parsed;
};


/* ---------------------------------------------------------------------------
 * The repository itself.
 * ------------------------------------------------------------------------- */

/**
 * Builds the repository from data the caller supplies, touching no file for
 * reading at all. `load` delegates here after reading the workbook and the
 * registry, and tests use it to reach every case real data cannot express - a
 * student with zero activities, a duplicate at load, a failing writer - without
 * adding a binary fixture.
 *
 * Both in-memory views are built **once**, here: per-request filesystem I/O
 * would be pure cost for twenty rows that cannot change under a running
 * process. `addActivity` keeps both views in step, in that order, only after a
 * write has landed.
 *
 * @param {{
 *   directory: {normalize: Function, isValidFormat: Function, has: Function, ids: Function},
 *   activityRows: Array<Record<string, string>>,
 *   registryRecords?: Array<{studentId: string, activity: string}>,
 *   activitiesDataPath?: string,
 *   writeFile?: (targetPath: string, contents: string) => void|Promise<void>,
 *   activitySource?: string,
 *   registrySource?: string
 * }} options
 *   `directory` is the injected student directory, the single source of truth
 *   for which identifiers exist. `activityRows` is the activity worksheet with
 *   the header row at index 0, each row a plain object keyed by column letter
 *   with string values. `registryRecords` is the registry in file order;
 *   **omitting it** means an empty registry, while a supplied value must be an
 *   array - `null` and every other non-array is refused. `activitiesDataPath`
 *   is the already-resolved write target; a repository built without one serves
 *   reads and rejects writes. `writeFile` replaces the atomic writer and may be
 *   synchronous or asynchronous. `activitySource` and `registrySource` are
 *   optional labels used only in error messages.
 * @returns {{
 *   listByStudent: (id: unknown) => Array<{activity: string, source: string}>,
 *   listActivities: (filter?: unknown) => Array<{activity: string, count: number, studentIds: string[]}>,
 *   addActivity: (id: unknown, activity: unknown) => Promise<{studentId: string, activity: string, source: string}>,
 *   recordCount: () => number
 * }} The frozen repository.
 * @throws {Error} With `code === 'ACTIVITY_REPOSITORY_INVALID'` on any fatal
 *   condition in this module's failure contract.
 */
const fromData = (options) => {
  if (!isObject(options)) {
    throw createUsageError(
      `fromData requires an options object (received ${describeValue(options)})`
    );
  }

  const {
    directory,
    activityRows,
    registryRecords,
    activitiesDataPath,
    writeFile,
    activitySource,
    registrySource
  } = options;

  const activityLabel = activitySourceLabel(activitySource);
  const registryLabel = registrySourceLabel(registrySource);

  assertDirectory(directory);

  if (!Array.isArray(activityRows)) {
    throw createRepositoryError(
      activityLabel,
      'activityRows must be an array of row objects with the header row first ' +
        `(received ${describeValue(activityRows)})`
    );
  }

  // Omission is the one permitted shorthand for "no registry records", because
  // `fromData` is called by tests and by any future caller that has only
  // workbook data. A *supplied* value must be the array `load` would have
  // passed: `null` is not an empty registry, it is a caller who meant to supply
  // records and supplied nothing, and accepting it as empty would make injected
  // construction more permissive than construction from a file (AAP 0.7.3) and
  // hide the mistake behind an under-reported activity list.
  const registryInput = registryRecords === undefined ? [] : registryRecords;
  if (!Array.isArray(registryInput)) {
    throw createRepositoryError(
      registryLabel,
      'registryRecords must be an array of records, or omitted entirely for an ' +
        `empty registry (received ${describeValue(registryRecords)})`
    );
  }

  if (activitiesDataPath !== undefined && activitiesDataPath !== null
      && (typeof activitiesDataPath !== 'string' || activitiesDataPath.trim() === '')) {
    throw createUsageError(
      'activitiesDataPath must be a non-empty string naming the registry file ' +
        `(received ${describeValue(activitiesDataPath)})`
    );
  }
  if (writeFile !== undefined && typeof writeFile !== 'function') {
    throw createUsageError(
      `writeFile must be a function (received ${describeValue(writeFile)})`
    );
  }

  /** The resolved write target, `''` when this repository serves reads only. */
  const registryPath = typeof activitiesDataPath === 'string' ? activitiesDataPath : '';
  /** The writer in force - the atomic one unless a caller injected another. */
  const persistRegistry = typeof writeFile === 'function' ? writeFile : writeRegistryAtomically;

  // View 1: a student's records in emitted order - the workbook record first,
  // then that student's registry records in file order. Each entry is frozen and
  // carries exactly the two fields a response serializes.
  const byStudent = new Map();

  // View 2: the reverse direction - one group per `activityKey`, labelled with
  // the spelling of its first member in emitted order, holding its members'
  // identifiers in emitted order.
  const byActivity = new Map();

  // The identity index: `(studentId, activityKey)` -> how the record that holds
  // it is described. Membership enforces uniqueness; the value lets a duplicate
  // failure name **both** records.
  const recordedPairs = new Map();

  /** The registry exactly as it will be re-serialized, in file order. */
  const registryStore = [];

  /** Group keys in ascending order, recomputed only when a group appears. */
  let sortedGroupKeys = null;

  let total = 0;

  /**
   * Adds one record to both views. Callers check the identity pair first, which
   * is what lets a duplicate failure differ between load (fatal) and write
   * (`409`) while the indexing itself stays in one place.
   *
   * @param {string} studentId The normalized identifier.
   * @param {string} activity The activity name in its stored spelling.
   * @param {string} source `'workbook'` or `'registry'`.
   * @param {string} origin How this record is described in a duplicate message.
   * @returns {void}
   */
  const indexRecord = (studentId, activity, source, origin) => {
    const activityKey = activityKeyOf(activity);

    const entry = Object.freeze({ activity, source });
    const records = byStudent.get(studentId);
    if (records === undefined) byStudent.set(studentId, [entry]);
    else records.push(entry);

    const group = byActivity.get(activityKey);
    if (group === undefined) {
      // First member in emitted order fixes the group's label, which makes the
      // workbook spelling canonical whenever a workbook record is present.
      byActivity.set(activityKey, { label: activity, studentIds: [studentId] });
      sortedGroupKeys = null;
    } else {
      group.studentIds.push(studentId);
    }

    recordedPairs.set(pairKeyOf(studentId, activityKey), origin);
    total += 1;
  };

  /**
   * How an already-recorded pair is described, or `undefined` when the pair is
   * free.
   *
   * @param {string} studentId The normalized identifier.
   * @param {string} activityKey The output of `activityKeyOf`.
   * @returns {string|undefined} The existing record's origin label.
   */
  const originOf = (studentId, activityKey) =>
    recordedPairs.get(pairKeyOf(studentId, activityKey));

  /**
   * The group keys in ascending order, cached until a new group appears.
   *
   * @returns {string[]} The sorted keys.
   */
  const groupKeys = () => {
    if (sortedGroupKeys === null) {
      sortedGroupKeys = Array.from(byActivity.keys()).sort(compareActivityKeys);
    }
    return sortedGroupKeys;
  };

  // ---- Pass 1: the workbook records -------------------------------------
  // Iterating `directory.ids()` rather than the worksheet is what makes
  // within-group ordering follow workbook row order without re-deriving it, and
  // it is why the directory exposes `ids()` at all.
  assertActivityHeaderRow(activityRows, activityLabel);
  const workbookActivities = collectWorkbookActivities(activityRows, activityLabel, directory);
  directory.ids().forEach((studentId) => {
    const found = workbookActivities.get(studentId);
    if (found === undefined) return;
    // A blank activity cell on a valid key is not an error: that student
    // contributes no workbook record and legitimately holds zero activities.
    if (found.activity.trim() === '') return;
    indexRecord(
      studentId,
      found.activity,
      SOURCE_WORKBOOK,
      `the activity workbook row ${found.rowNumber}`
    );
  });

  // ---- Pass 2: the registry records, in file order -----------------------
  registryInput.forEach((raw, index) => {
    const position = index + 1;
    const record = validateStoredRecord(raw, position, registryLabel, directory);
    const activityKey = activityKeyOf(record.activity);
    const existing = originOf(record.studentId, activityKey);
    if (existing !== undefined) {
      // There is no supersede rule, so a duplicate in the data is fatal and the
      // message names both records - the hand edit that produced it is the only
      // way to reach this state.
      throw createRepositoryError(
        registryLabel,
        `record ${position} duplicates activity "${record.activity}" for ` +
          `${KEY_HEADER_LABEL} ${record.studentId}, which is already recorded by ${existing}`,
        { record: position, studentId: record.studentId, activity: record.activity }
      );
    }
    indexRecord(record.studentId, record.activity, SOURCE_REGISTRY, `registry record ${position}`);
    registryStore.push({ studentId: record.studentId, activity: record.activity });
  });

  // Warm the ordering cache while construction is still the only thing running.
  groupKeys();

  /* ---- The single-writer queue ------------------------------------------
   * Every write is enqueued as **its own task** rather than chained onto the
   * previous promise: `tail` swallows a rejection so one failed write cannot
   * poison every later one, while the caller still receives the rejection.
   */
  let tail = Promise.resolve();

  /**
   * Runs `task` after every previously enqueued task has settled.
   *
   * @param {() => Promise<unknown>} task The critical section to run.
   * @returns {Promise<unknown>} The task's own settlement.
   */
  const enqueue = (task) => {
    const result = tail.then(task, task);
    tail = result.then(noop, noop);
    return result;
  };

  /**
   * The critical section of a write, in the one order that keeps the file and
   * the index honest:
   *
   *   1. re-check the identity pair **inside** the section, which is what makes
   *      two concurrent identical writes produce one success and one duplicate
   *      refusal rather than two records;
   *   2. serialize the whole registry;
   *   3. hand it to the writer, which writes the scratch file and renames it
   *      over the target;
   *   4. update both views **only after** the rename, so a record is never
   *      visible to a reader that was never persisted;
   *   5. resolve with the created record.
   *
   * @param {string} studentId The normalized, existing identifier.
   * @param {string} activity The validated, trimmed activity name.
   * @returns {Promise<{studentId: string, activity: string, source: string}>}
   *   The created record.
   * @throws {Error} `ACTIVITY_ALREADY_RECORDED` for a duplicate,
   *   `ACTIVITY_PERSIST_FAILED` when the write did not land.
   */
  const persistActivity = async (studentId, activity) => {
    const activityKey = activityKeyOf(activity);
    const existing = originOf(studentId, activityKey);
    if (existing !== undefined) {
      throw createDuplicateError(studentId, activity, existing);
    }

    if (registryPath === '') {
      // A read-only repository: refused as a persistence failure rather than
      // pretended to succeed, and it can only happen through direct misuse -
      // `server.js` always resolves a registry path.
      throw createPersistError(
        studentId,
        activity,
        registryPath,
        new Error('no activities registry path is configured for this repository')
      );
    }

    // Built with `concat`, never by mutating the store: a failed write must
    // leave the in-memory registry exactly as it was.
    const contents = serializeRegistry(registryStore.concat([{ studentId, activity }]));

    try {
      // `await` covers both writer shapes - the synchronous default and an
      // injected asynchronous one - and a synchronous throw lands here too.
      await persistRegistry(registryPath, contents);
    } catch (cause) {
      discardTemporaryArtifact(registryPath);
      throw createPersistError(studentId, activity, registryPath, cause);
    }

    registryStore.push({ studentId, activity });
    indexRecord(studentId, activity, SOURCE_REGISTRY, `registry record ${registryStore.length}`);

    return Object.freeze({ studentId, activity, source: SOURCE_REGISTRY });
  };

  /**
   * A student's activities in emitted order: the workbook record first, then
   * that student's registry records in file order.
   *
   * An unknown or malformed identifier yields an empty list rather than an
   * error, because a student legitimately holding zero activities and an unknown
   * student are distinguished by the **directory**, not here - the routes check
   * existence first and answer `404` only for a student the directory does not
   * know.
   *
   * @param {unknown} id The identifier, normalized here so a caller that has
   *   not normalized still resolves.
   * @returns {Array<{activity: string, source: string}>} A fresh array of frozen
   *   records, so a caller cannot mutate the index.
   */
  const listByStudent = (id) => {
    const records = byStudent.get(directory.normalize(id));
    return records === undefined ? [] : records.slice();
  };

  /**
   * The reverse direction: students grouped by activity.
   *
   * Groups are keyed on `activityKey`, so `Robotics Club` and `robotics club`
   * are one group; each group is labelled with the spelling of its first member
   * in emitted order; groups come back in `activityKey` ascending order; and
   * within a group the workbook-sourced identifiers appear in workbook row order
   * before the registry-sourced ones in registry file order.
   *
   * @param {unknown} [filter] An optional activity name, compared trimmed and
   *   case-insensitively against `activityKey`. Absent, non-string or blank
   *   after trimming means no filter; a filter matching nothing yields an empty
   *   list, which is not an error. There is no pagination and no omission
   *   marker - the result is the whole set.
   * @returns {Array<{activity: string, count: number, studentIds: string[]}>}
   *   Fresh objects with fresh identifier arrays.
   */
  const listActivities = (filter) => {
    const wanted = typeof filter === 'string' ? activityKeyOf(filter) : '';
    const groups = [];
    groupKeys().forEach((activityKey) => {
      if (wanted !== '' && activityKey !== wanted) return;
      const group = byActivity.get(activityKey);
      groups.push({
        activity: group.label,
        count: group.studentIds.length,
        studentIds: group.studentIds.slice()
      });
    });
    return groups;
  };

  /**
   * Records an additional activity for a student and persists it.
   *
   * Validation runs **before** anything is enqueued, so a bad argument never
   * occupies the writer: the identifier is normalized, format-checked and
   * resolved against the directory, and the activity must be a 1-64 character
   * string after trimming. `studentId` comes from the caller's argument alone -
   * this function reads no request body and accepts no `source` or `studentId`
   * field from an object.
   *
   * @param {unknown} id The student's identifier.
   * @param {unknown} activity The activity name.
   * @returns {Promise<{studentId: string, activity: string, source: string}>}
   *   The created record, which is what the route serializes.
   *   Rejects with `code` `'INVALID_STUDENT_ID'`, `'STUDENT_NOT_FOUND'`,
   *   `'INVALID_ACTIVITY'`, `'ACTIVITY_ALREADY_RECORDED'` or
   *   `'ACTIVITY_PERSIST_FAILED'`. Never throws synchronously, so a caller can
   *   rely on a single rejection path.
   */
  const addActivity = (id, activity) => {
    let studentId;
    let value;
    try {
      studentId = directory.normalize(id);
      if (!directory.isValidFormat(studentId)) throw createStudentError(id, false);
      if (!directory.has(studentId)) throw createStudentError(studentId, true);
      value = validateActivityValue(activity);
    } catch (error) {
      return Promise.reject(error);
    }
    return enqueue(() => persistActivity(studentId, value));
  };

  /**
   * The total number of records held across every student and both sources - 10
   * for the committed data, one per student with an empty registry.
   *
   * @returns {number} The record count.
   */
  const recordCount = () => total;

  return Object.freeze({ listByStudent, listActivities, addActivity, recordCount });
};

/**
 * Reads the activity workbook and the registry file, then builds the repository
 * from them. This is what `server.js` calls when no `repository` is injected,
 * and the only path in this module that reads the filesystem.
 *
 * Extra properties on `options` are ignored, because the composition root passes
 * its whole resolved configuration (`host` and `port` included) alongside the
 * directory.
 *
 * @param {{
 *   workbookDir: string,
 *   activitiesDataPath: string,
 *   directory: {normalize: Function, isValidFormat: Function, has: Function, ids: Function},
 *   writeFile?: (targetPath: string, contents: string) => void|Promise<void>
 * }} options
 *   `workbookDir` is the already-resolved directory holding
 *   `student_other_info.xlsx`; `activitiesDataPath` is the already-resolved
 *   registry path. This module applies no default and reads no environment
 *   variable.
 * @returns {ReturnType<typeof fromData>} The frozen repository.
 * @throws {Error} With `code === 'ACTIVITY_REPOSITORY_INVALID'` when an option is
 *   unusable or a source's data is invalid, and with
 *   `code === 'WORKBOOK_READ_FAILED'` - propagated unchanged from
 *   `lib/workbook.js` with the path named - when the workbook is missing,
 *   unreadable or not an `.xlsx` package. A **missing** registry file is not an
 *   error: it warns on stderr and loads the workbook-sourced data alone.
 */
const load = (options) => {
  if (!isObject(options)) {
    throw createUsageError(
      'load requires an options object with workbookDir, activitiesDataPath and ' +
        `directory (received ${describeValue(options)})`
    );
  }

  const { workbookDir, activitiesDataPath, directory, writeFile } = options;

  if (typeof workbookDir !== 'string' || workbookDir.trim() === '') {
    throw createUsageError(
      'workbookDir must be a non-empty string naming the directory that holds ' +
        `${ACTIVITY_WORKBOOK_FILENAME} (received ${describeValue(workbookDir)})`
    );
  }
  if (typeof activitiesDataPath !== 'string' || activitiesDataPath.trim() === '') {
    throw createUsageError(
      'activitiesDataPath must be a non-empty string naming the registry file ' +
        `(received ${describeValue(activitiesDataPath)})`
    );
  }
  assertDirectory(directory);

  const activityWorkbookPath = path.join(workbookDir, ACTIVITY_WORKBOOK_FILENAME);
  // Read failures propagate unchanged: they already carry the path, a stable
  // `code` and the underlying `cause`, and wrapping them would only bury that.
  // The workbook is never written - not here, not by the write path, not ever.
  const activityRows = readWorksheetRows(activityWorkbookPath);
  const registryRecords = readRegistryFile(activitiesDataPath);

  // Checked after the reads, so a corrupt source is reported as a data fault
  // rather than as a location fault: the data is what a maintainer just edited.
  assertRegistryLocationUsable(activitiesDataPath);

  return fromData({
    directory,
    activityRows,
    registryRecords,
    activitiesDataPath,
    writeFile,
    activitySource: activityWorkbookPath,
    registrySource: activitiesDataPath
  });
};

module.exports = { load, fromData };
