'use strict';

/**
 * The activity domain: merge, ordering, duplicates and the one validated write
 * this feature makes.
 *
 * Records come from two sources. `student_other_info.xlsx` holds one activity
 * per student in column C of `Other Info`, is authoritative for it, and is
 * never written. Additional activities live in an appendable JSON registry
 * (`activities.json`, shipped as `[]`) - the only file this feature writes -
 * where a stored record is exactly `{"studentId": "...", "activity": "..."}`.
 * `source` is derived from where a record came from and never stored, which is
 * why a client cannot supply it. Rows arrive whole from `lib/workbook.js`
 * because a ZIP entry decompresses as a unit; only columns A and C survive
 * here, so no other `Other Info` column can reach a response.
 *
 * Three rules belong nowhere else:
 *
 *   1. Identity is the pair `(studentId, activityKey)`, where `activityKey` is
 *      the activity name trimmed and lower-cased. That pair is the uniqueness
 *      constraint of the whole feature.
 *   2. A student's activities are the workbook record first, then that
 *      student's registry records in file order; the roster groups the same
 *      records by `activityKey`.
 *   3. There is no supersede rule: a record naming an activity a student
 *      already holds is a duplicate - refused on write, fatal at load with
 *      both records named.
 *
 * Construction is strict, because it runs once while the server is being built
 * and a silently mis-read source would serve wrong data for the lifetime of the
 * process. Every fatal condition throws synchronously with the offending
 * source, row or record named and `code === 'ACTIVITY_REPOSITORY_INVALID'`, and
 * each is documented where it is enforced. Three are deliberately not fatal: a
 * blank key cell skips the row, a blank activity cell on a valid key means that
 * student holds zero activities, and a missing registry file warns on stderr
 * and leaves the registry empty.
 *
 * The write path rejects with a stable discriminator rather than an HTTP status,
 * so `lib/activityRoutes.js` selects `409` or `500` without matching strings:
 * `ACTIVITY_ALREADY_RECORDED`, `ACTIVITY_PERSIST_FAILED`, and
 * `INVALID_ACTIVITY`, `INVALID_STUDENT_ID` or `STUDENT_NOT_FOUND` for arguments
 * that never reach the queue.
 *
 * This module reads no environment variable and resolves no default, produces
 * no HTTP status, message or envelope, and never calls `process.exit`:
 * `server.js` is the single composition root and the routes module maps every
 * outcome.
 */

const fs = require('node:fs');
const path = require('node:path');
const { readWorksheetRows } = require('./workbook');

const ACTIVITY_WORKBOOK_FILENAME = 'student_other_info.xlsx';

// The only two columns of `Other Info` this module reads, and the labels their
// header cells must carry exactly. Everything else in the row is discarded.
const KEY_COLUMN = 'A';
const ACTIVITY_COLUMN = 'C';
const KEY_HEADER_LABEL = 'Student ID';
const ACTIVITY_HEADER_LABEL = 'Extracurricular Activity';

// `source` is derived from where a record came from, never stored.
const SOURCE_WORKBOOK = 'workbook';
const SOURCE_REGISTRY = 'registry';

const MAX_ACTIVITY_LENGTH = 64;

const STORED_RECORD_KEYS = ['studentId', 'activity'];

// Stable error discriminators. Every error this module produces carries one, so
// callers branch on `error.code` and never on a message.
const ERROR_INVALID = 'ACTIVITY_REPOSITORY_INVALID';
const ERROR_DUPLICATE = 'ACTIVITY_ALREADY_RECORDED';
const ERROR_PERSIST = 'ACTIVITY_PERSIST_FAILED';
const ERROR_INVALID_ACTIVITY = 'INVALID_ACTIVITY';
const ERROR_INVALID_STUDENT_ID = 'INVALID_STUDENT_ID';
const ERROR_STUDENT_NOT_FOUND = 'STUDENT_NOT_FOUND';

/**
 * The writer's refusal to write through a scratch entry it did not create. It
 * is internal - `persistActivity` wraps it in `ACTIVITY_PERSIST_FAILED`, which
 * is the code `lib/activityRoutes.js` maps to `500` - and it exists as its own
 * discriminator for one reason: the cleanup that follows a failed write must be
 * skipped for this failure, because removing the entry would act on the very
 * path the writer just refused to trust.
 */
const ERROR_TEMPORARY_PRESENT = 'ACTIVITY_REGISTRY_TEMP_PRESENT';

const TEMPORARY_SUFFIX = '.tmp';

/**
 * The creation mode of that scratch file: owner read and write, nothing else.
 *
 * Supplied explicitly because Node's default is `0o666` filtered only by the
 * process umask, and the rename installs the scratch inode's mode on the
 * registry - so a permissive umask would publish student and activity data to
 * every local account, and a deliberately restrictive registry would be
 * replaced by a permissive one (CWE-732). The scratch file is therefore never
 * created wider than owner-only; the one widening that can follow is
 * `applyTargetFileMode` restoring the mode the registry itself already had.
 */
const TEMPORARY_FILE_MODE = 0o600;

const WORKSHEET_ROW_OFFSET = 1;

/**
 * Joins the two halves of a record's identity into one index key. `NUL` cannot
 * occur in a normalized `Student ID` (`/^S\d{3}$/`), so no activity name can
 * collide with a different pair by containing the separator.
 */
const PAIR_SEPARATOR = '\u0000';

/** U+FEFF, which some editors prepend to a UTF-8 file and `JSON.parse` rejects. */
const BYTE_ORDER_MARK = '\ufeff';

/*
 * The code points that must never reach a log record verbatim, named by Unicode
 * general category so the set is complete rather than hand-picked: `\p{Cc}` the
 * C0 and C1 controls and DEL (CR and LF among them); `\p{Cf}` every format
 * character, which makes the bidirectional embeddings, overrides and isolates
 * unrepresentable along with the zero-width and tag characters that conceal
 * rather than reorder; `\p{Cs}` unpaired surrogates, which would otherwise reach
 * the log as U+FFFD; and `\p{Zl}`/`\p{Zp}`, the two line separators some log
 * readers break on. The u flag makes each match a whole code point, so a paired surrogate - an emoji in an activity name -
 * is left alone. The identical pattern and sanitizeForLog live in `lib/activityRoutes.js` and
 * `server.js`, the other two files that own a stderr sink; there is no shared module
 * to hold one copy, and the three must stay in step.
 */
const LOG_UNSAFE_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

const MAX_BMP_CODE_POINT = 0xffff;

const INJECTED_ACTIVITY_SOURCE_LABEL = 'injected activity rows';
const INJECTED_REGISTRY_SOURCE_LABEL = 'injected registry records';

const REQUIRED_DIRECTORY_MEMBERS = ['normalize', 'isValidFormat', 'has', 'ids'];

const noop = () => {};

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
 * Whether a caught value is an error carrying a particular `code`.
 *
 * A thrown value is not guaranteed to be an `Error` at all, so the shape is
 * tested before the property is read: `fs` raises objects with `code` set to a
 * `libuv` name (`'EEXIST'`, `'ENOENT'`), and this module's own errors carry
 * their stable discriminators in the same place.
 *
 * @param {unknown} value The value caught from a failing call.
 * @param {string} code The `code` to test for.
 * @returns {boolean} `true` when the value is an object whose `code` matches.
 */
const isErrorCode = (value, code) =>
  value !== null && typeof value === 'object' && value.code === code;

const describeRowShape = (row) => {
  if (Array.isArray(row)) return 'array';
  if (row !== null && typeof row === 'object') return 'non-record object';
  return describeValue(row);
};

/**
 * Escapes every code point `LOG_UNSAFE_PATTERN` matches - control, format,
 * bidirectional, surrogate or line separator - as its visible `\uXXXX` or
 * `\u{XXXXX}` spelling, so a stderr record stays one line and says exactly what
 * arrived (CWE-117). The input is free text by contract, so the sink is made
 * safe rather than the contract narrowed. Idempotent: the replacement text
 * matches nothing on a second pass.
 *
 * @param {string} text The text to render.
 * @returns {string} The text with every unsafe code point escaped.
 */
const sanitizeForLog = (text) =>
  text.replace(LOG_UNSAFE_PATTERN, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= MAX_BMP_CODE_POINT
      ? `\\u${codePoint.toString(16).padStart(4, '0')}`
      : `\\u{${codePoint.toString(16)}}`;
  });

/**
 * Summarises a thrown value for an error detail without throwing itself - a
 * caller's diagnostic must not be lost to a second failure.
 *
 * The result is log-safe: a thrown value can carry text that originated with a
 * caller (a writer substituted by a test, or a filesystem error naming a path),
 * so every unsafe code point - control, format, bidirectional or line separator
 * - is escaped here rather than at each of the six call sites (CWE-117).
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

const createUsageError = (summary) => {
  const error = new Error(`Activity repository: ${summary}`);
  error.code = ERROR_INVALID;
  return error;
};

/**
 * The refusal for a `(studentId, activityKey)` pair that is already recorded.
 * `lib/activityRoutes.js` maps this `code` to `409` and composes its own
 * client-facing sentence, so this message exists for logs: it names where the
 * existing record came from, the activity text is escaped into it, and
 * `error.activity` keeps that value verbatim.
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
 * so a name carrying CR, LF, a terminal escape or a bidirectional override
 * cannot forge, split or visually reorder a log record (CWE-117).
 * `error.activity` keeps the value verbatim.
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
 * The refusal raised when the scratch path is already occupied.
 *
 * The writer creates `<registry>.tmp` exclusively, so an entry already sitting
 * there is one this process did not create: a symbolic link planted by a local
 * actor to have the registry's contents written through it into another file
 * (CWE-59), or the artifact of a process that died mid-write. Neither is
 * followed and neither is deleted - the entry is left exactly as found, with
 * its path named, so an operator can see what is there before removing it.
 *
 * `persistActivity` wraps this in `ACTIVITY_PERSIST_FAILED`, so the client gets
 * the same fixed `500` sentence as any other write failure and learns nothing
 * about the filesystem.
 *
 * @param {string} temporaryPath The occupied scratch path.
 * @returns {Error} The error to throw, with `code ===
 *   'ACTIVITY_REGISTRY_TEMP_PRESENT'`.
 */
const createTemporaryArtifactError = (temporaryPath) => {
  const error = new Error(
    `the scratch file ${temporaryPath} already exists, so it was not created by ` +
      'this write; refusing to write through it or remove it - inspect it and ' +
      'delete it by hand once you know what it is'
  );
  error.code = ERROR_TEMPORARY_PRESENT;
  error.path = temporaryPath;
  return error;
};

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

const activitySourceLabel = (source) =>
  typeof source === 'string' && source !== ''
    ? `Activity source (${source})`
    : `Activity source (${INJECTED_ACTIVITY_SOURCE_LABEL})`;

const registrySourceLabel = (source) =>
  typeof source === 'string' && source !== ''
    ? `Activity registry (${source})`
    : `Activity registry (${INJECTED_REGISTRY_SOURCE_LABEL})`;

/**
 * Reads one of the two retained cells as a string.
 *
 * Exactly two inputs mean blank: an omitted column (`undefined`) and the empty
 * string. Anything else is refused rather than coerced, because coercing it to
 * `''` would either skip the row as a trailing blank one or report a student who
 * holds an activity as holding none - a wrong answer served confidently for the
 * lifetime of the process. Both genuinely blank forms still behave as blanks: a
 * blank key cell skips the row, and a blank activity cell on a valid key means
 * that student contributes no workbook record.
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

// Persistence. The registry is the only file this feature writes; the workbook
// binaries are never written, not here and not by the write path.

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
 * Writes one line to stderr, escaped to a single log record.
 *
 * The scratch path comes from configuration and a filesystem message can carry
 * a path with it, so neither is allowed to end the record early or to move a
 * terminal cursor (CWE-117).
 *
 * @param {string} message The diagnostic, already composed.
 * @returns {void}
 */
const reportArtifactProblem = (message) => {
  process.stderr.write(`${sanitizeForLog(message)}\n`);
};

/**
 * Removes a scratch file **this writer created**, whose descriptor it has just
 * closed. `fs.unlinkSync` removes the directory entry itself and never follows
 * it, so this cannot reach through a link.
 *
 * A failure is reported rather than raised: the caller is already failing a
 * write, and a cleanup problem must not replace that diagnostic with a second
 * one. The message keeps the prefix `README.md` documents, because an operator
 * greps for it.
 *
 * The removal names the path rather than the descriptor, because Node exposes no
 * descriptor-relative unlink. The window is narrow and its worst case is
 * bounded: a directory entry substituted in the meantime would be unlinked
 * instead of this one, and an unlink neither writes nor truncates, so nothing
 * can be clobbered through it.
 *
 * @param {string} temporaryPath The scratch file to remove.
 * @returns {void}
 */
const removeOwnTemporaryFile = (temporaryPath) => {
  try {
    fs.unlinkSync(temporaryPath);
  } catch (cause) {
    // Already gone is success, and the common case when the failure happened
    // before anything was written.
    if (isErrorCode(cause, 'ENOENT')) return;
    reportArtifactProblem(
      `Could not remove the temporary activity registry file ${temporaryPath}: ` +
        `${describeCause(cause)}`
    );
  }
};

/**
 * Aligns the scratch file's permissions with the registry it is about to
 * replace, through the **descriptor** rather than the path, so the mode cannot
 * be applied to something that took the path's place mid-write.
 *
 * The scratch file is created `0o600` and stays there unless a registry already
 * exists as a regular file, in which case that file's own mode is reapplied -
 * the rename then leaves the registry's permissions exactly as the operator set
 * them instead of replacing them with whatever the process umask produced
 * (CWE-732). A first write, with no registry to inherit from, therefore lands
 * at owner-only.
 *
 * Neither an unreadable target nor a refused `fchmod` fails the write: both
 * leave the scratch file at `0o600`, which is the restrictive direction and
 * cannot expose data. A symbolic link or a directory at the target path is
 * deliberately not inherited from - only a regular file's mode is meaningful
 * here.
 *
 * @param {number} descriptor The open scratch-file descriptor.
 * @param {string} targetPath The registry the scratch file will replace.
 * @returns {void}
 */
const applyTargetFileMode = (descriptor, targetPath) => {
  let stats;
  try {
    stats = fs.lstatSync(targetPath);
  } catch (cause) {
    // A registry that does not exist yet is the ordinary first write and says
    // nothing; metadata that cannot be read is worth a line, because the
    // operator's chosen permissions are about to be replaced by owner-only ones.
    if (!isErrorCode(cause, 'ENOENT')) {
      reportArtifactProblem(
        `Could not read the permissions of ${targetPath} (${describeCause(cause)}); ` +
          'its replacement will be readable by its owner alone'
      );
    }
    return;
  }
  if (!stats.isFile()) return;
  const mode = stats.mode & 0o777;
  if (mode === TEMPORARY_FILE_MODE) return;
  try {
    fs.fchmodSync(descriptor, mode);
  } catch (cause) {
    reportArtifactProblem(
      `Could not reapply the permissions of ${targetPath} to its replacement ` +
        `(${describeCause(cause)}); the registry will be readable by its owner alone`
    );
  }
};

/**
 * The default writer: create the scratch file beside the target, write it,
 * close it, then rename it over the target. `fs.renameSync` within one
 * directory is atomic, so a reader sees either the old registry or the new one
 * and never a half-written file.
 *
 * **The scratch file is created exclusively.** `'wx'` is
 * `O_WRONLY | O_CREAT | O_EXCL`, which fails with `EEXIST` rather than opening
 * whatever already sits at the path - including a symbolic link, even a dangling
 * one. That is what closes the link-following hole a predictable scratch name
 * otherwise leaves open: the registry's own directory must be writable for any
 * write to work at all, so a local actor able to create an entry there could
 * previously have had the registry's contents written straight through a link of
 * their choosing, truncating the victim, before the link itself was renamed over
 * the registry (CWE-59). Every byte now goes to the **descriptor** this call
 * owns, so the path is resolved exactly once, by the create that either wins or
 * fails.
 *
 * A pre-existing entry is refused, never followed and never deleted: see
 * `createTemporaryArtifactError`. Everything the writer itself created is its
 * own to clean up, which it does before re-throwing, so a failed write leaves no
 * artifact behind and the caller's best-effort cleanup has nothing left to do.
 *
 * Tests substitute this through `fromData`'s `writeFile` option to exercise the
 * persistence-failure and queue-recovery paths; the signature is deliberately
 * `fs.writeFileSync`-shaped so a substitute can delegate to a real write.
 *
 * @param {string} targetPath The registry file to replace.
 * @param {string} contents The serialized registry.
 * @returns {void}
 * @throws {Error} `ACTIVITY_REGISTRY_TEMP_PRESENT` when the scratch path is
 *   already occupied, or whatever the filesystem raises otherwise; the caller
 *   rejects that one request and leaves the index untouched.
 */
const writeRegistryAtomically = (targetPath, contents) => {
  const temporaryPath = temporaryPathFor(targetPath);

  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', TEMPORARY_FILE_MODE);
  } catch (cause) {
    if (isErrorCode(cause, 'EEXIST')) throw createTemporaryArtifactError(temporaryPath);
    throw cause;
  }

  // From here the scratch file exists and belongs to this call, so every exit
  // path either renames it onto the target or removes it again.
  let open = true;
  let renamed = false;
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    applyTargetFileMode(descriptor, targetPath);
    // Closed before the rename, in that order: Windows refuses to rename a file
    // with an open handle, and a close failure must be seen as a write failure
    // rather than hidden behind a successful rename.
    open = false;
    fs.closeSync(descriptor);
    fs.renameSync(temporaryPath, targetPath);
    renamed = true;
  } finally {
    if (!renamed) {
      if (open) {
        try {
          fs.closeSync(descriptor);
        } catch (cause) {
          reportArtifactProblem(
            `Could not close the temporary activity registry file ${temporaryPath}: ` +
              `${describeCause(cause)}`
          );
        }
      }
      removeOwnTemporaryFile(temporaryPath);
    }
  }
};

/**
 * Removes the scratch file after a failed write, best-effort: the caller is
 * already rejecting a request, and a cleanup failure must not replace that
 * diagnostic with a second one. The entry is inspected with `fs.lstatSync`
 * before anything is removed, and only a plain regular file is unlinked; a
 * symbolic link or a directory at the scratch path is something no write here
 * creates, so it is left exactly as found and reported instead (CWE-59). The
 * default writer already removes the artifact it created, so this normally
 * finds nothing; it is the only cleanup for an injected `writeFile`. A missing
 * file is a no-op; a filesystem that refuses the removal - a permission denial,
 * or a lock another process holds on the scratch path - leaves the artifact in
 * place and is reported on stderr.
 *
 * @param {string} targetPath The registry file the write was aiming at.
 * @returns {void}
 */
const discardTemporaryArtifact = (targetPath) => {
  const temporaryPath = temporaryPathFor(targetPath);

  let stats;
  try {
    stats = fs.lstatSync(temporaryPath);
  } catch (cause) {
    // Nothing there is the common case: most write failures happen before or
    // during the scratch write, and the writer cleans up its own artifact.
    if (isErrorCode(cause, 'ENOENT')) return;
    // Reported rather than swallowed, so an undeletable artifact is visible to an
    // operator without turning cleanup into a second failure for the client. The
    // whole record is escaped to one line: the path is configuration and the
    // cause is a filesystem message, and neither may break the log format.
    reportArtifactProblem(
      `Could not remove the temporary activity registry file ${temporaryPath}: ` +
        `it could not be inspected (${describeCause(cause)})`
    );
    return;
  }

  if (!stats.isFile()) {
    reportArtifactProblem(
      `Could not remove the temporary activity registry file ${temporaryPath}: ` +
        'it is not a regular file, so it was not created by this service and has ' +
        'been left in place - inspect it by hand'
    );
    return;
  }

  removeOwnTemporaryFile(temporaryPath);
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
      // One line, with the configured path escaped into it, so the path it names
      // can never end the record early.
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

/**
 * Builds the repository from data the caller supplies, reading no file at all.
 * `load` delegates here after reading the workbook and the registry; supplying
 * the data directly reaches the cases real data cannot express - a student with
 * zero activities, a duplicate at load, a failing writer - without a binary
 * fixture.
 *
 * Both in-memory views are built once, here: per-request filesystem I/O would be
 * pure cost for twenty rows that cannot change under a running process.
 * `addActivity` keeps both views in step, and only after a write has landed.
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

  // Omission is the one permitted shorthand for "no registry records". A
  // supplied value must be the array `load` would have passed: `null` is not an
  // empty registry, it is a caller who meant to supply records and supplied
  // nothing, and accepting it as empty would make injected construction more
  // permissive than construction from a file and hide the mistake behind an
  // under-reported activity list.
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

  const registryPath = typeof activitiesDataPath === 'string' ? activitiesDataPath : '';
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

  const registryStore = [];

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

  const originOf = (studentId, activityKey) =>
    recordedPairs.get(pairKeyOf(studentId, activityKey));

  const groupKeys = () => {
    if (sortedGroupKeys === null) {
      sortedGroupKeys = Array.from(byActivity.keys()).sort(compareActivityKeys);
    }
    return sortedGroupKeys;
  };

  // The workbook records, indexed in the order the ACTIVITY workbook holds
  // them. A workbook-sourced member's emitted position is its row in the sheet
  // the record came from, so the order is taken from `rowNumber` - captured per
  // row by `collectWorkbookActivities` - rather than from the directory
  // workbook's own row order. The two coincide in the committed data only
  // because the key columns happen to be ordered identically across the
  // workbooks, and nothing asserts that: deriving the order from the directory
  // made a re-ordered `Other Info` silently emit its members in
  // `Student Details` order.
  assertActivityHeaderRow(activityRows, activityLabel);
  const workbookActivities = collectWorkbookActivities(activityRows, activityLabel, directory);
  Array.from(workbookActivities.entries())
    .sort((left, right) => left[1].rowNumber - right[1].rowNumber)
    .forEach(([studentId, found]) => {
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

  groupKeys();

  // The single-writer queue. Every write is enqueued as its own task rather than
  // chained onto the previous promise: `tail` swallows a rejection so one failed
  // write cannot poison every later one, while the caller still receives its
  // own rejection.
  let tail = Promise.resolve();

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
   * Step 1 refuses **before** anything is written, so it leaves the registry
   * file and both views exactly as they were.
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
      // The one failure that must NOT be followed by cleanup is the writer
      // refusing to touch a scratch entry it did not create: removing it here
      // would act on exactly the path the writer just declined to trust, and
      // would erase what an operator needs to see (CWE-59).
      if (!isErrorCode(cause, ERROR_TEMPORARY_PRESENT)) {
        discardTemporaryArtifact(registryPath);
      }
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
   * within a group the workbook-sourced identifiers appear in the **activity**
   * workbook's row order - the sheet those records came from - before the
   * registry-sourced ones in registry file order.
   *
   * @param {unknown} [filter] An optional activity name, compared trimmed and
   *   case-insensitively against `activityKey`. **Absence is what disables
   *   filtering**, not a particular value: omitting the argument, or passing
   *   anything that is not a string, returns the whole set, while **any string
   *   is a filter** - including one that is empty or whitespace-only, which
   *   matches nothing because every activity is 1-64 characters after trimming
   *   and so no group can key on the empty string. A filter matching nothing
   *   yields an empty list, which is not an error. There is no pagination and no
   *   omission marker.
   * @returns {Array<{activity: string, count: number, studentIds: string[]}>}
   *   Fresh objects with fresh identifier arrays.
   */
  const listActivities = (filter) => {
    // Presence is carried separately from the key, because `activityKeyOf('')`
    // is `''`: folding the two together made a present-but-blank filter -
    // `?activity=` or `?activity=%20` at the boundary - read as no filter at all
    // and answer with the whole roster, where the contract makes it a filter
    // that matches nothing.
    const filtered = typeof filter === 'string';
    const wanted = filtered ? activityKeyOf(filter) : '';
    const groups = [];
    groupKeys().forEach((activityKey) => {
      if (filtered && activityKey !== wanted) return;
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

  return Object.freeze({
    listByStudent,
    listActivities,
    addActivity,
    recordCount
  });
};

/**
 * Reads the activity workbook and the registry file, then builds the repository
 * from them. This is what `server.js` calls when no `repository` is injected,
 * and the only path in this module that reads the filesystem. Extra properties
 * on `options` are ignored, because the composition root passes its whole
 * resolved configuration (`host` and `port` included) alongside the directory.
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
