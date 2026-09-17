'use strict';

/**
 * lib/studentDirectory.js - the `Student ID` identity layer of the activity feature.
 *
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * The code scan that opened this work found `Student ID` sitting in column A of
 * all three committed workbooks with one identical key set, `S001`-`S010`,
 * while no code path anywhere referenced it: the entrypoint imported `http` and
 * never touched a file. This module is the layer that closes that gap. It owns
 * the identifier that organises the whole feature - the value that addresses a
 * student on both per-student routes, attributes every record returned,
 * partitions the in-memory index, and is the subject of the referential
 * integrity check on every write.
 *
 * It is a module of its own rather than code inside a route or a repository
 * because the identifier rules and the existence check are shared by the read
 * path *and* the write path, and both have to be assertable with no server
 * running and no file on disk - which is what `fromRows` is for.
 *
 * WHAT IT READS, AND WHAT IT KEEPS
 * ---------------------------------------------------------------------------
 * The source of truth for which students exist is `student_details.xlsx`, sheet
 * `Student Details`, whose verified header is:
 *
 *   A `Student ID` | B `Name` | C `Gender` | D `Date of Birth` | E `Age`
 *   F `Department` | G `Year` | H `Email` | I `Phone` | J `City`
 *
 * `lib/workbook.js` hands over whole rows, because a ZIP entry decompresses as
 * a unit - there is no way to inflate two columns of a worksheet. What this
 * module guarantees is narrower and is what the response contract depends on:
 * **only columns A and B are retained**. The two values are copied out as
 * strings and the row object is dropped, so Gender, Date of Birth, Age,
 * Department, Year, Email, Phone and City are never held in memory here and
 * cannot reach a response payload. No row object is ever stashed in the index.
 *
 * FAILURE CONTRACT
 * ---------------------------------------------------------------------------
 * Construction is strict, because it happens once while the server is being
 * built and a silently mis-read directory would serve wrong data for the
 * lifetime of the process. Each of these throws synchronously, naming the
 * offending cell, row or value:
 *
 *   - a header cell that is not exactly its expected label (guessing column
 *     positions is worse than failing);
 *   - a duplicate `Student ID` within the sheet (which row wins would be
 *     arbitrary);
 *   - a key cell that is non-blank but does not match `/^S\d{3}$/`;
 *   - a blank `Name` on a valid key, because the per-student response promises a
 *     name and there is no defensible substitute.
 *
 * One condition is deliberately *not* fatal: a **blank key cell skips the row**,
 * which is what lets a maintainer leave trailing empty rows in a workbook.
 *
 * Every error carries `code === 'STUDENT_DIRECTORY_INVALID'` for programmatic
 * handling, plus `row`/`studentId` where those apply. This module never logs,
 * never writes a file and never calls `process.exit`: turning a failure into
 * process behaviour belongs to the `require.main === module` wrapper in
 * `server.js` alone, and turning it into an HTTP status belongs to
 * `lib/activityRoutes.js`, which maps a shape failure to `400
 * INVALID_STUDENT_ID` and a missing student to `404 STUDENT_NOT_FOUND`.
 *
 * BOUNDARIES
 * ---------------------------------------------------------------------------
 * This module reads no environment variable, resolves no default and knows
 * nothing of `PORT`, `HOST` or `WORKBOOK_DIR` - `server.js` is the single
 * composition root and passes an already-resolved `workbookDir`. It opens
 * neither `student_other_info.xlsx` nor `student_academics.xlsx`, writes no
 * file, and imports nothing beyond `./workbook` and `node:path`. The API is
 * synchronous and the returned object is frozen and immutable, so concurrent
 * requests cannot interfere with one another.
 *
 * @example
 * const studentDirectory = require('./lib/studentDirectory');
 * const directory = studentDirectory.load({ workbookDir: __dirname });
 * directory.ids();                 // ['S001', 'S002', ... 'S010']
 * directory.normalize('  s001 ');  // 'S001'
 * directory.isValidFormat('S1');   // false - the stored format is fixed-width
 * directory.has('S001');           // true
 * directory.nameOf('S001');        // 'Aarav Sharma'
 */

const path = require('node:path');
const { readWorksheetRows } = require('./workbook');

/** Stable discriminator set on every error this module throws. */
const ERROR_CODE = 'STUDENT_DIRECTORY_INVALID';

/** The directory workbook, resolved inside the caller-supplied `workbookDir`. */
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

/** How `fromRows` describes its input when the caller names no source. */
const INJECTED_SOURCE_LABEL = 'injected rows';

/**
 * Worksheet rows are 1-based and `rows[0]` is the header, so a data row at
 * index `i` is worksheet row `i + 1`. Every message reports that number, which
 * is the one a maintainer sees in a spreadsheet application.
 */
const WORKSHEET_ROW_OFFSET = 1;

/**
 * Builds the one error shape this module throws: what failed, which source it
 * failed in, and any structured detail worth handling programmatically.
 *
 * @param {string} source Path of the workbook, or `'injected rows'`.
 * @param {string} summary What is wrong, with the offending value interpolated.
 * @param {Record<string, unknown>} [details] Extra properties to set on the
 *   error - `row` and `studentId` where they apply.
 * @returns {Error} The error to throw, carrying `code === 'STUDENT_DIRECTORY_INVALID'`.
 */
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
 * Normalizes a raw identifier to the form the index is keyed on: **trimmed,
 * then upper-cased**, so `'  s001 '` and `'S001'` resolve identically.
 *
 * This function deliberately does **not** percent-decode. Decoding happens
 * exactly once, at the HTTP boundary in `server.js`; decoding a second time
 * here would let a doubly encoded identifier such as `S%2530%2530%2531` - still
 * `S%30%30%31` after the boundary's single decode - be turned into `S001` and
 * accepted, which is precisely the hazard the single-decode rule exists to
 * prevent. `'S%30%30%31'` therefore normalizes to `'S%30%30%31'` and fails
 * `isValidFormat`.
 *
 * A non-string input yields `''` rather than throwing, so a stray type from any
 * caller degrades into "not a valid identifier" instead of crashing the server.
 * `''` can never match `STUDENT_ID_PATTERN` and is never a key in the index.
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
 * `lib/workbook.js` yields a string for every cell it parsed and simply omits a
 * cell that is absent from the worksheet XML, so `undefined` and `''` both mean
 * "blank" and are normalized to `''` here. Any other type can only come from an
 * injected row, and it is refused rather than coerced: silently treating a
 * numeric key as blank would skip a row a maintainer believes is present.
 *
 * @param {unknown} row The row object handed over by the reader.
 * @param {string} column The column letter to read.
 * @param {string} source Path of the workbook, or `'injected rows'`.
 * @param {number} rowNumber Worksheet row number, for the error message.
 * @returns {string} The cell's text, `''` when the cell is blank or absent.
 * @throws {Error} When the row is not an object, or the cell holds a non-string.
 */
const readCell = (row, column, source, rowNumber) => {
  if (row === null || typeof row !== 'object') {
    throw createDirectoryError(
      source,
      `row ${rowNumber} must be an object keyed by column letter (received ${typeof row})`,
      { row: rowNumber }
    );
  }
  const value = row[column];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw createDirectoryError(
      source,
      `cell ${column}${rowNumber} must be a string (received ${typeof value})`,
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
 * Every populated row after the header is read - there is no `A2:A11` bound, so
 * an eleventh student added by hand to the workbooks is served with no code
 * change. Only the key and the name are copied out; the row object itself is
 * dropped, which is what keeps every other column out of memory.
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
 * all. `load` delegates here after reading the workbook, and tests use it to
 * assert every validation rule - header mismatch, duplicate key, malformed key,
 * blank name, skipped blank row - without adding a binary fixture.
 *
 * @param {Array<Record<string, string>>} rows The worksheet's rows, `rows[0]`
 *   being the header row, each keyed by column letter with string values.
 * @param {string} [source] How the input is described in error messages;
 *   `load` passes the workbook path, and the default is `'injected rows'`.
 * @returns {{
 *   normalize: (raw: unknown) => string,
 *   isValidFormat: (id: unknown) => boolean,
 *   has: (id: unknown) => boolean,
 *   nameOf: (id: unknown) => string|undefined,
 *   ids: () => string[]
 * }} The frozen directory.
 * @throws {Error} With `code === 'STUDENT_DIRECTORY_INVALID'` on any fatal
 *   condition in the failure contract above.
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
 * Reads the directory workbook and builds the directory from it. This is what
 * `server.js` calls when no `directory` is injected, and the only path in this
 * module that touches the filesystem.
 *
 * @param {{workbookDir: string}} options The resolved directory holding
 *   `student_details.xlsx`. `server.js` resolves it; this module applies no
 *   default and reads no environment variable.
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
