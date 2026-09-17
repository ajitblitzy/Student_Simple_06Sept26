'use strict';

/**
 * `Student ID` identity for the activity feature: normalization, format
 * validation, existence, and the student's `Name`.
 *
 * `load({ workbookDir })` reads `student_details.xlsx` (sheet `Student
 * Details`); `fromRows(rows, source)` builds the same object from rows already
 * in hand, touching no file. Both apply the same validation and return the
 * frozen index `{ normalize, isValidFormat, has, nameOf, ids }`.
 *
 * Of every column the sheet carries, only A (`Student ID`) and B (`Name`) are
 * retained. The reader can only deliver whole rows, so those two cells are
 * copied out as strings and the row itself is dropped - no other column is held
 * here, and none can reach a response payload.
 *
 * Construction is strict and synchronous. An inexact header label, a duplicate
 * key, a non-blank key failing `/^S\d{3}$/`, a blank `Name` on a valid key, or a
 * row that is not a plain record of strings throws with `code ===
 * 'STUDENT_DIRECTORY_INVALID'` and `row`/`studentId` where they apply; a blank
 * key cell only skips the row, so a workbook may carry trailing empty rows.
 *
 * The returned index is frozen, and the module reads no environment variable,
 * logs nothing, writes no file, never calls `process.exit` and decides no HTTP
 * status: `server.js` passes an already-resolved `workbookDir` and chooses what
 * a failure does to the process, and `lib/activityRoutes.js` maps a shape
 * failure to `400 INVALID_STUDENT_ID` and a missing student to `404
 * STUDENT_NOT_FOUND`.
 */

const path = require('node:path');
const { readWorksheetRows } = require('./workbook');

const ERROR_CODE = 'STUDENT_DIRECTORY_INVALID';

const DIRECTORY_WORKBOOK_FILENAME = 'student_details.xlsx';

// The only two columns this module reads, and the labels their header cells
// must carry exactly. Everything else in the row is discarded.
const KEY_COLUMN = 'A';
const NAME_COLUMN = 'B';
const KEY_HEADER_LABEL = 'Student ID';
const NAME_HEADER_LABEL = 'Name';

/**
 * The accepted `Student ID` shape: `S` followed by exactly three digits.
 * Case-sensitive and fixed-width on purpose - the stored values are `S001`
 * through `S010`, so `S1` is malformed rather than shorthand for `S001`, and
 * `s001` becomes valid only after `normalize` has upper-cased it. Callers run
 * `normalize` first and `isValidFormat` second, which is the order the routes
 * use. The pattern carries no global flag, so it holds no `lastIndex` state
 * between calls.
 */
const STUDENT_ID_PATTERN = /^S\d{3}$/;

const INJECTED_SOURCE_LABEL = 'injected rows';

const WORKSHEET_ROW_OFFSET = 1;

/**
 * Describes a value's type for an error message without ever interpolating the
 * value itself, so a hostile or broken `toString` cannot hijack a diagnostic.
 * Worded identically to `lib/activityRepository.js`'s helper of the same name,
 * because the two modules enforce one row contract and must report a breach of
 * it in the same words.
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
 * An array, a `Date`, a `Map` or a class instance is an `object` to `typeof`
 * and carries no `A`/`B` property, so accepting one would read every cell as
 * blank and skip the row in silence - the failure mode this predicate exists to
 * turn into a fatal error. The prototype test is what distinguishes a record
 * from those: the reader builds its rows with `{}`, and an injected literal or
 * an `Object.create(null)` row is equally acceptable.
 *
 * @param {unknown} value The candidate row.
 * @returns {boolean} `true` only for a plain, non-array record object.
 */
const isRowRecord = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const describeRowShape = (row) => {
  if (Array.isArray(row)) return 'array';
  if (row !== null && typeof row === 'object') return 'non-record object';
  return describeValue(row);
};

const createDirectoryError = (source, summary, details) => {
  const error = new Error(`Student directory (${source}): ${summary}`);
  error.code = ERROR_CODE;
  error.source = source;
  if (details !== undefined) {
    Object.keys(details).forEach((key) => {
      error[key] = details[key];
    });
  }
  return error;
};

/**
 * Normalizes a raw identifier to the form the index is keyed on: trimmed, then
 * upper-cased, so `'  s001 '` and `'S001'` resolve identically.
 *
 * It never percent-decodes. Decoding happens exactly once, at the HTTP
 * boundary; decoding again here would turn a doubly encoded identifier such as
 * `S%2530%2530%2531` - still `S%30%30%31` after that single decode - into
 * `S001` and accept it, so `'S%30%30%31'` normalizes unchanged and fails
 * `isValidFormat`. A non-string input yields `''`, which matches no valid
 * format and is never a key in the index, so a stray type degrades into "not a
 * valid identifier" instead of throwing.
 *
 * @param {unknown} raw The identifier as received, already decoded by the caller.
 * @returns {string} The normalized identifier, or `''` for a non-string input.
 */
const normalize = (raw) => {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase();
};

/**
 * Reports whether an identifier has the accepted shape. This is a pure format
 * check and says nothing about existence: a well-formed unknown identifier
 * passes here and fails `has`, which is what keeps `400` (shape) and `404`
 * (existence) distinguishable to a client.
 *
 * Case-sensitive by design - `'s001'` is `false` until `normalize` has been
 * applied - and no padding is inferred, so `'S1'` and `'S0001'` are both
 * `false`.
 *
 * @param {unknown} id The identifier to check, normally the output of `normalize`.
 * @returns {boolean} `true` only for `S` followed by exactly three digits.
 */
const isValidFormat = (id) => typeof id === 'string' && STUDENT_ID_PATTERN.test(id);

/**
 * Reads one of the two retained cells as a string.
 *
 * Exactly two inputs mean blank: an omitted property and `''`. Any other value
 * - `null`, a number, an object - is refused rather than coerced: coerced to
 * `''` it would make a populated row read as empty, dropping that student out
 * of the directory unnoticed.
 *
 * @param {unknown} row The row record handed over by the reader.
 * @param {string} column The column letter to read.
 * @param {string} source Path of the workbook, or `'injected rows'`.
 * @param {number} rowNumber Worksheet row number, for the error message.
 * @returns {string} The cell's text, `''` when the cell is absent or empty.
 * @throws {Error} When the row is not a plain record object, or the cell holds
 *   anything other than a string or an omitted property.
 */
const readCell = (row, column, source, rowNumber) => {
  if (!isRowRecord(row)) {
    throw createDirectoryError(
      source,
      `row ${rowNumber} must be a plain object keyed by column letter ` +
        `(received ${describeRowShape(row)})`,
      { row: rowNumber }
    );
  }
  const value = row[column];
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw createDirectoryError(
      source,
      `cell ${column}${rowNumber} must be a string (received ${describeValue(value)})`,
      { row: rowNumber }
    );
  }
  return value;
};

/**
 * Validates the header row before a single data row is read, because a sheet
 * whose columns have moved would otherwise be read with guessed positions and
 * yield blank names for every student. Both labels must match exactly.
 *
 * @param {Array<Record<string, string>>} rows The worksheet's rows.
 * @param {string} source Path of the workbook, or `'injected rows'`.
 * @returns {void}
 * @throws {Error} When there is no header row, or either label is not exact.
 */
const assertHeaderRow = (rows, source) => {
  if (rows.length === 0) {
    throw createDirectoryError(
      source,
      `no rows were found, so the header row (${KEY_COLUMN}1 "${KEY_HEADER_LABEL}", ` +
        `${NAME_COLUMN}1 "${NAME_HEADER_LABEL}") could not be validated`
    );
  }
  const header = rows[0];
  const expected = [
    { column: KEY_COLUMN, label: KEY_HEADER_LABEL },
    { column: NAME_COLUMN, label: NAME_HEADER_LABEL }
  ];
  expected.forEach(({ column, label }) => {
    const actual = readCell(header, column, source, 1);
    if (actual !== label) {
      throw createDirectoryError(
        source,
        `header cell ${column}1 must be exactly "${label}" (received "${actual}")`,
        { row: 1 }
      );
    }
  });
};

/**
 * Builds the identity index from already-validated rows.
 *
 * Every populated row after the header is read, with no fixed row bound. Only
 * the key and the name are copied out; the row object itself is dropped, which
 * is what keeps every other column out of memory.
 *
 * @param {Array<Record<string, string>>} rows The worksheet's rows, header first.
 * @param {string} source Path of the workbook, or `'injected rows'`.
 * @returns {{byId: Map<string, string>, order: string[]}} The name index keyed
 *   by normalized identifier, and the identifiers in worksheet row order.
 * @throws {Error} On a malformed key, a duplicate key, or a blank name.
 */
const buildIndex = (rows, source) => {
  const byId = new Map();
  const order = [];
  const rowNumberOf = new Map();

  for (let index = 1; index < rows.length; index += 1) {
    const rowNumber = index + WORKSHEET_ROW_OFFSET;
    const rawKey = readCell(rows[index], KEY_COLUMN, source, rowNumber);
    const studentId = normalize(rawKey);

    // A blank key cell is an empty row a maintainer left behind - skipped, not
    // fatal. Blankness is judged after trimming, which `normalize` has done.
    if (studentId === '') continue;

    if (!isValidFormat(studentId)) {
      throw createDirectoryError(
        source,
        `row ${rowNumber} has a malformed ${KEY_HEADER_LABEL} "${rawKey}" - ` +
          'it must be S followed by exactly three digits',
        { row: rowNumber, studentId: rawKey }
      );
    }

    if (byId.has(studentId)) {
      throw createDirectoryError(
        source,
        `duplicate ${KEY_HEADER_LABEL} ${studentId} at rows ` +
          `${rowNumberOf.get(studentId)} and ${rowNumber}`,
        { row: rowNumber, studentId }
      );
    }

    const name = readCell(rows[index], NAME_COLUMN, source, rowNumber);
    if (name.trim() === '') {
      throw createDirectoryError(
        source,
        `row ${rowNumber} (${studentId}) has a blank ${NAME_HEADER_LABEL}, ` +
          'which the per-student response cannot substitute for',
        { row: rowNumber, studentId }
      );
    }

    // Only these two strings survive. `name` keeps its stored spelling and
    // spacing, because the response must carry the value as the workbook has
    // it; trimming above was for blank detection only.
    byId.set(studentId, name);
    order.push(studentId);
    rowNumberOf.set(studentId, rowNumber);
  }

  return { byId, order };
};

/**
 * Builds the directory from rows supplied by the caller, touching no file at
 * all. `load` delegates here after reading the workbook, and the validation is
 * identical either way: injected construction is no more permissive than
 * construction from a file, so a row shape the reader could never yield is
 * rejected rather than reinterpreted as absent data.
 *
 * @param {Array<Record<string, string>>} rows The worksheet's rows, `rows[0]`
 *   being the header row. Each row must be a plain object keyed by column
 *   letter whose values are strings; an absent column may be omitted, and `''`
 *   is a blank cell. A `null` cell, a non-string cell, an array row or any other
 *   object is a fatal malformed row, not a blank one.
 * @param {string} [source] How the input is described in error messages;
 *   `load` passes the workbook path, and the default is `'injected rows'`.
 * @returns {{normalize: Function, isValidFormat: Function, has: Function,
 *   nameOf: Function, ids: Function}} The frozen directory; each method is
 *   documented at its own definition.
 * @throws {Error} With `code === 'STUDENT_DIRECTORY_INVALID'` on an inexact
 *   header label, a malformed or duplicate key, a blank `Name`, or a malformed
 *   row.
 */
const fromRows = (rows, source) => {
  const label = typeof source === 'string' && source !== '' ? source : INJECTED_SOURCE_LABEL;

  if (!Array.isArray(rows)) {
    throw createDirectoryError(
      label,
      `rows must be an array of row objects (received ${rows === null ? 'null' : typeof rows})`
    );
  }

  assertHeaderRow(rows, label);
  const { byId, order } = buildIndex(rows, label);

  /**
   * Whether an identifier exists in the directory. The caller is expected to
   * pass an already-normalized identifier; one that is not is normalized here,
   * which is harmless because `normalize` is idempotent and this check is never
   * the format gate - `isValidFormat` runs before it in the routes.
   *
   * @param {unknown} id The identifier to resolve.
   * @returns {boolean} `true` when the directory holds that identifier.
   */
  const has = (id) => byId.has(normalize(id));

  /**
   * The stored `Name` for an existing identifier.
   *
   * @param {unknown} id The identifier to resolve.
   * @returns {string|undefined} The name, or `undefined` when the identifier is
   *   unknown - callers check `has` first and answer `404 STUDENT_NOT_FOUND`.
   */
  const nameOf = (id) => byId.get(normalize(id));

  /**
   * Every identifier, in worksheet row order, which is the order the activity
   * roster's within-group ordering depends on.
   *
   * @returns {string[]} A fresh copy, so a caller cannot mutate the index.
   */
  const ids = () => order.slice();

  return Object.freeze({ normalize, isValidFormat, has, nameOf, ids });
};

/**
 * Reads the directory workbook and builds the directory from it - the only path
 * in this module that touches the filesystem.
 *
 * @param {{workbookDir: string}} options The resolved directory holding
 *   `student_details.xlsx`. It must already be resolved: no default is applied
 *   and no environment variable is consulted here.
 * @returns {ReturnType<typeof fromRows>} The frozen directory.
 * @throws {Error} With `code === 'STUDENT_DIRECTORY_INVALID'` when
 *   `workbookDir` is unusable or the sheet's data is invalid, and with
 *   `code === 'WORKBOOK_READ_FAILED'` - propagated from `lib/workbook.js` with
 *   the path named - when the file is missing, unreadable or not a workbook.
 */
const load = (options) => {
  if (options === null || typeof options !== 'object') {
    throw createDirectoryError(
      DIRECTORY_WORKBOOK_FILENAME,
      `load requires an options object with a workbookDir (received ${typeof options})`
    );
  }
  const { workbookDir } = options;
  if (typeof workbookDir !== 'string' || workbookDir.trim() === '') {
    throw createDirectoryError(
      DIRECTORY_WORKBOOK_FILENAME,
      'workbookDir must be a non-empty string naming the directory that holds ' +
        `${DIRECTORY_WORKBOOK_FILENAME} (received ${typeof workbookDir})`
    );
  }

  const filePath = path.join(workbookDir, DIRECTORY_WORKBOOK_FILENAME);
  // Read failures propagate unchanged: they already carry the path, a stable
  // `code` and the underlying `cause`, and wrapping them would only bury that.
  const rows = readWorksheetRows(filePath);
  return fromRows(rows, filePath);
};

module.exports = { load, fromRows };
