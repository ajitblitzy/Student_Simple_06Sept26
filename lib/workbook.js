'use strict';

/**
 * lib/workbook.js - the OOXML (`.xlsx`) worksheet reader for this service.
 *
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * The three workbooks committed at the repository root are the only source of
 * student identity (`student_details.xlsx`) and of the baseline extracurricular
 * activity (`student_other_info.xlsx`), yet nothing in the service could open
 * them: the entrypoint imported `http` and touched no file at all. This module
 * is the read capability the activity feature is built on, and it is the only
 * place in the repository where ZIP or XML knowledge lives. Callers receive
 * plain row objects and never see a byte offset or a tag.
 *
 * ZERO DEPENDENCIES BY DESIGN
 * ---------------------------------------------------------------------------
 * The repository has never carried a runtime dependency, and reading two
 * columns out of a 6 KB spreadsheet does not justify introducing one, so the
 * ZIP container is walked by hand and inflated with `node:zlib` while the
 * worksheet XML is scanned with regular expressions. What keeps that safe is
 * how narrow the input is - every claim below was verified against all three
 * committed workbooks before this reader was written:
 *
 *   - Each package holds 9 ZIP entries, every one DEFLATE-compressed
 *     (method 8). `xl/worksheets/sheet1.xml` is resolved BY NAME - it happens
 *     to be the 4th entry, but no position or ordering is assumed.
 *   - There is NO `xl/sharedStrings.xml` part: every text cell is
 *     `t="inlineStr"` carrying `<is><t>TEXT</t></is>`, and no cell anywhere
 *     uses `t="s"`. A reader written against a shared-string table would
 *     return blanks for every label and every value - the exact failure this
 *     module must not have.
 *   - Numeric cells carry `t="n"` with `<v>N</v>`. There are no formulas, no
 *     merged cells and no ZIP64 records in any of the three files.
 *
 * This reader therefore implements exactly those shapes. Formula evaluation,
 * shared-string tables, number formatting, date serial numbers and merged-cell
 * expansion are deliberately absent rather than half-built; an input that
 * needs them fails loudly instead of returning something plausible.
 *
 * CONTRACT
 * ---------------------------------------------------------------------------
 * `readWorksheetRows(filePath)` returns the worksheet's rows in document order
 * - `rows[0]` is the header row - with each row an object keyed by column
 * letter and every value a string (`''` for a blank or missing cell):
 *
 *   const { readWorksheetRows } = require('./workbook');
 *   const rows = readWorksheetRows('/repo/student_other_info.xlsx');
 *   // rows[0] -> { A: 'Student ID', B: 'Hostel Status',
 *   //              C: 'Extracurricular Activity', ... }
 *   // rows[1] -> { A: 'S001', B: 'Hostel', C: 'Robotics Club', D: '2', ... }
 *
 * Values stay strings on purpose: consumers only compare text, so this module
 * makes no number-formatting or locale decision on their behalf. A blank cell
 * is `''` rather than `undefined`, which is what lets a consumer treat "blank
 * key cell" and "blank activity cell" as ordinary string checks.
 *
 * FAILURE CONTRACT
 * ---------------------------------------------------------------------------
 * Every failure throws synchronously. The read happens once while the server is
 * being constructed, so an unreadable workbook must abort construction rather
 * than degrade into empty rows. Every thrown error interpolates the offending
 * path into its `message`, carries `code === 'WORKBOOK_READ_FAILED'` and `path`
 * for programmatic handling, and preserves the underlying error as `cause`
 * where there is one. This module never logs, never writes to stdout and never
 * calls `process.exit`: turning a failure into process behaviour belongs to the
 * `require.main === module` wrapper in `server.js` alone.
 *
 * The API is synchronous, holds no mutable module state (so concurrent calls
 * cannot interfere), and never writes a file - the workbooks are read-only.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

/** Stable discriminator set on every error this module throws. */
const ERROR_CODE = 'WORKBOOK_READ_FAILED';

/**
 * The single worksheet part these workbooks carry. Each package's `xl/workbook.xml`
 * declares exactly one sheet with `sheetId="1"`, so `sheet1.xml` *is* the named
 * sheet and no `[Content_Types].xml` or relationship resolution is needed.
 */
const WORKSHEET_PART = 'xl/worksheets/sheet1.xml';

// ZIP record signatures, as stored (little-endian).
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

// Fixed record sizes, excluding the trailing variable-length fields.
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const CENTRAL_FILE_HEADER_SIZE = 46;
const LOCAL_FILE_HEADER_SIZE = 30;

/**
 * How far back the end-of-central-directory record can begin: its own 22 bytes
 * plus the maximum 65535-byte trailing archive comment.
 */
const END_OF_CENTRAL_DIRECTORY_MAX_SCAN = END_OF_CENTRAL_DIRECTORY_SIZE + 65535;

// The only compression methods these packages use, and the only two supported.
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/**
 * The sentinel a ZIP writer stores in a 32-bit field whose real value lives in
 * a ZIP64 extended record. These packages are 5-6 KB so it never appears, but
 * reading past it would silently produce garbage, so it is refused explicitly.
 */
const ZIP64_SENTINEL = 0xffffffff;

// Attribute and single-value patterns. None carries the global flag, so none
// holds `lastIndex` state between calls; the iterating patterns are created
// per call inside the functions that loop with them.
const REFERENCE_ATTRIBUTE_PATTERN = /(?:^|\s)r="([^"]*)"/;
const TYPE_ATTRIBUTE_PATTERN = /(?:^|\s)t="([^"]*)"/;
const COLUMN_LETTERS_PATTERN = /^([A-Za-z]+)/;
const VALUE_ELEMENT_PATTERN = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/;

/** The cell type that stores its text inline, in an `<is><t>` child. */
const INLINE_STRING_TYPE = 'inlineStr';

/** The five predefined XML entities; numeric references are handled separately. */
const NAMED_ENTITIES = {
  amp: '&',
  apos: '\'',
  gt: '>',
  lt: '<',
  quot: '"'
};

const UNICODE_MAX_CODE_POINT = 0x10ffff;
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;

/**
 * Summarises an arbitrary thrown value for an error detail without ever
 * throwing itself - a caller's diagnostic must not be lost to a second failure.
 *
 * @param {unknown} cause The value caught from a failing call.
 * @returns {string} A short description, or `''` when there is nothing to say.
 */
const describeCause = (cause) => {
  if (cause === null || cause === undefined) return '';
  if (cause instanceof Error && typeof cause.message === 'string' && cause.message !== '') {
    // Node's filesystem errors already begin with their code (for example
    // 'EISDIR: illegal operation on a directory, read'), so the message alone
    // is the most informative detail available.
    return cause.message;
  }
  if (typeof cause === 'object') return 'unknown error';
  return `${typeof cause} thrown: ${String(cause)}`;
};

/**
 * Builds the one error shape this module throws: what failed, the path it
 * failed on, an optional parenthesised detail, and the underlying error kept
 * as `cause` so nothing about the diagnostic is discarded.
 *
 * @param {string} summary What failed, without the path.
 * @param {string} filePath The workbook path, always interpolated into the message.
 * @param {string} [detail] Extra context rendered in parentheses.
 * @param {unknown} [cause] The underlying error, preserved as `error.cause`.
 * @returns {Error} The error to throw, carrying `code` and `path`.
 */
const createWorkbookError = (summary, filePath, detail, cause) => {
  const suffix = detail === undefined || detail === '' ? '' : ` (${detail})`;
  const message = `${summary}: ${filePath}${suffix}`;
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = ERROR_CODE;
  error.path = filePath;
  return error;
};

/**
 * Refuses a path that cannot name a file before the filesystem is touched. The
 * message reports the received *type* rather than the value, so a hostile or
 * broken `toString` cannot hijack the diagnostic.
 *
 * @param {unknown} filePath The caller-supplied path.
 * @returns {void}
 * @throws {Error} With `code === 'WORKBOOK_READ_FAILED'` when the path is unusable.
 */
const assertUsablePath = (filePath) => {
  if (typeof filePath !== 'string') {
    const error = new Error(
      `Workbook path must be a non-empty string (received ${typeof filePath})`
    );
    error.code = ERROR_CODE;
    throw error;
  }
  if (filePath.trim() === '') {
    const error = new Error(
      'Workbook path must be a non-empty string (received an empty string)'
    );
    error.code = ERROR_CODE;
    error.path = filePath;
    throw error;
  }
};

/**
 * Guards every offset taken from the archive itself before it is used to read
 * the buffer, so a corrupt or truncated package produces a named failure
 * instead of a `RangeError` from the Buffer accessors.
 *
 * @param {Buffer} buffer The whole workbook.
 * @param {number} at Byte offset the read starts at.
 * @param {number} length Number of bytes the read needs.
 * @param {string} filePath The workbook path, for the error message.
 * @param {string} what Which record is out of range.
 * @returns {void}
 * @throws {Error} When the requested span is not entirely inside the buffer.
 */
const assertWithinBuffer = (buffer, at, length, filePath, what) => {
  if (!Number.isSafeInteger(at) || at < 0 || at + length > buffer.length) {
    throw createWorkbookError(
      'Not a valid .xlsx package',
      filePath,
      `${what} lies outside the file`
    );
  }
};

/**
 * Reads the whole workbook into memory. These files are 5-6 KB and are read
 * once per process, so a single synchronous read is both simplest and cheapest.
 *
 * @param {string} filePath Absolute or relative path to the `.xlsx` file.
 * @returns {Buffer} The file's bytes.
 * @throws {Error} 'Workbook not found: <path>' for `ENOENT`, and
 *   'Workbook could not be read: <path> (<detail>)' for anything else -
 *   `EISDIR` when the path names a directory, `EACCES`/`EPERM` for permissions,
 *   `EBUSY` for a platform lock. A read failure is never swallowed.
 */
const readWorkbookBuffer = (filePath) => {
  try {
    return fs.readFileSync(filePath);
  } catch (cause) {
    if (cause !== null && typeof cause === 'object' && cause.code === 'ENOENT') {
      throw createWorkbookError('Workbook not found', filePath, undefined, cause);
    }
    throw createWorkbookError(
      'Workbook could not be read',
      filePath,
      describeCause(cause),
      cause
    );
  }
};

/**
 * Finds the end-of-central-directory record by scanning backwards from the
 * last position it could start at, bounded to the last 65557 bytes (the record
 * plus the largest possible trailing comment).
 *
 * @param {Buffer} buffer The whole workbook.
 * @returns {number} The record's offset, or `-1` when it is not present.
 */
const findEndOfCentralDirectory = (buffer) => {
  if (buffer.length < END_OF_CENTRAL_DIRECTORY_SIZE) return -1;
  const lowest = Math.max(0, buffer.length - END_OF_CENTRAL_DIRECTORY_MAX_SCAN);
  for (let at = buffer.length - END_OF_CENTRAL_DIRECTORY_SIZE; at >= lowest; at -= 1) {
    if (buffer.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return at;
  }
  return -1;
};

/**
 * Walks the central directory and resolves the worksheet entry BY NAME. The
 * directory is the authoritative index: the local header's own size fields are
 * unreliable across writers, so the compressed size recorded here is the one
 * used to slice the entry data.
 *
 * @param {Buffer} buffer The whole workbook.
 * @param {string} filePath The workbook path, for error messages.
 * @returns {{method: number, compressedSize: number, localHeaderOffset: number}}
 *   The worksheet entry's compression method, compressed size and local header offset.
 * @throws {Error} 'Not a valid .xlsx package: <path>' when no end-of-central-directory
 *   record is found, an entry signature is wrong, a record is truncated, or a ZIP64
 *   sentinel is present; 'Workbook has no xl/worksheets/sheet1.xml part: <path>' when
 *   the package is well-formed but carries no worksheet.
 */
const locateWorksheetEntry = (buffer, filePath) => {
  const endOfCentralDirectory = findEndOfCentralDirectory(buffer);
  if (endOfCentralDirectory < 0) {
    throw createWorkbookError(
      'Not a valid .xlsx package',
      filePath,
      'no ZIP end-of-central-directory record was found'
    );
  }

  const entryCount = buffer.readUInt16LE(endOfCentralDirectory + 10);
  let at = buffer.readUInt32LE(endOfCentralDirectory + 16);

  for (let index = 0; index < entryCount; index += 1) {
    assertWithinBuffer(
      buffer,
      at,
      CENTRAL_FILE_HEADER_SIZE,
      filePath,
      `central directory entry ${index}`
    );
    if (buffer.readUInt32LE(at) !== CENTRAL_FILE_HEADER_SIGNATURE) {
      throw createWorkbookError(
        'Not a valid .xlsx package',
        filePath,
        `central directory entry ${index} has an unexpected signature`
      );
    }

    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localHeaderOffset = buffer.readUInt32LE(at + 42);

    assertWithinBuffer(
      buffer,
      at + CENTRAL_FILE_HEADER_SIZE,
      nameLength,
      filePath,
      `the name of central directory entry ${index}`
    );
    const name = buffer.toString(
      'utf8',
      at + CENTRAL_FILE_HEADER_SIZE,
      at + CENTRAL_FILE_HEADER_SIZE + nameLength
    );

    if (name === WORKSHEET_PART) {
      if (compressedSize === ZIP64_SENTINEL || localHeaderOffset === ZIP64_SENTINEL) {
        throw createWorkbookError(
          'Not a valid .xlsx package',
          filePath,
          'ZIP64 packages are not supported by this reader'
        );
      }
      return { method, compressedSize, localHeaderOffset };
    }

    at += CENTRAL_FILE_HEADER_SIZE + nameLength + extraLength + commentLength;
  }

  throw createWorkbookError(`Workbook has no ${WORKSHEET_PART} part`, filePath);
};

/**
 * Inflates the worksheet entry and decodes it as UTF-8. Entry data begins after
 * the local header's own variable-length name and extra fields, and every entry
 * in these packages is DEFLATE (method 8); the stored (method 0) branch is kept
 * because it costs one comparison and a writer may legitimately use it.
 *
 * @param {Buffer} buffer The whole workbook.
 * @param {{method: number, compressedSize: number, localHeaderOffset: number}} entry
 *   The worksheet entry resolved from the central directory.
 * @param {string} filePath The workbook path, for error messages.
 * @returns {string} The worksheet XML.
 * @throws {Error} 'Not a valid .xlsx package: <path>' for a bad or truncated local
 *   header, 'Workbook uses an unsupported ZIP compression method N: <path>' for any
 *   method other than stored or DEFLATE, and 'Workbook worksheet part could not be
 *   decompressed: <path> (<detail>)' when inflation itself fails.
 */
const readWorksheetXml = (buffer, entry, filePath) => {
  const { method, compressedSize, localHeaderOffset } = entry;

  assertWithinBuffer(
    buffer,
    localHeaderOffset,
    LOCAL_FILE_HEADER_SIZE,
    filePath,
    'the worksheet local file header'
  );
  if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw createWorkbookError(
      'Not a valid .xlsx package',
      filePath,
      'the worksheet local file header has an unexpected signature'
    );
  }

  const nameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const at = localHeaderOffset + LOCAL_FILE_HEADER_SIZE + nameLength + extraLength;
  assertWithinBuffer(buffer, at, compressedSize, filePath, 'the worksheet entry data');

  if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
    throw createWorkbookError(
      `Workbook uses an unsupported ZIP compression method ${method}`,
      filePath
    );
  }

  const raw = buffer.subarray(at, at + compressedSize);
  try {
    return (method === METHOD_DEFLATE ? zlib.inflateRawSync(raw) : raw).toString('utf8');
  } catch (cause) {
    throw createWorkbookError(
      'Workbook worksheet part could not be decompressed',
      filePath,
      describeCause(cause),
      cause
    );
  }
};

/**
 * Resolves XML entity references in extracted text: the five predefined named
 * entities plus decimal (`&#65;`) and hexadecimal (`&#x41;`) character
 * references. One pass over the text means an escaped escape such as
 * `&amp;lt;` resolves to the literal `&lt;` rather than to `<`.
 *
 * An unknown named entity, an out-of-range code point or a lone surrogate is
 * left exactly as written: silently dropping it would corrupt a value, and this
 * reader has no business rejecting a cell over it.
 *
 * @param {string} text Raw text taken from between two XML tags.
 * @returns {string} The text with entity references resolved.
 */
const unescapeXml = (text) => {
  if (text === '' || text.indexOf('&') === -1) return text;
  return text.replace(
    /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g,
    (match, decimal, hexadecimal, name) => {
      if (name !== undefined) {
        const replacement = Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
          ? NAMED_ENTITIES[name]
          : undefined;
        return replacement === undefined ? match : replacement;
      }
      const codePoint = decimal === undefined
        ? Number.parseInt(hexadecimal, 16)
        : Number.parseInt(decimal, 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > UNICODE_MAX_CODE_POINT) {
        return match;
      }
      if (codePoint >= SURROGATE_FIRST && codePoint <= SURROGATE_LAST) return match;
      return String.fromCodePoint(codePoint);
    }
  );
};

/**
 * Reads the first matching attribute out of a tag's attribute text.
 *
 * The patterns anchor on a preceding space or the start of the text, so `r=`
 * cannot be matched inside another attribute's name, and no pattern assumes
 * `r` is the first or only attribute - these cells carry `r`, `s` and `t`.
 *
 * @param {string|undefined} attributes The raw attribute text of a tag.
 * @param {RegExp} pattern A non-global pattern whose first group is the value.
 * @returns {string} The attribute value, or `''` when the attribute is absent.
 */
const readAttribute = (attributes, pattern) => {
  if (typeof attributes !== 'string' || attributes === '') return '';
  const match = pattern.exec(attributes);
  return match === null ? '' : match[1];
};

/**
 * Extracts the column-letter key from a cell reference: `'A2'` becomes `'A'`,
 * `'AB10'` becomes `'AB'`. Keys are upper-cased so a row object's shape never
 * depends on how a writer cased the reference.
 *
 * @param {string} reference The value of a cell's `r` attribute.
 * @returns {string} The column letters, or `''` when the reference is unparseable.
 */
const readColumnKey = (reference) => {
  if (reference === '') return '';
  const match = COLUMN_LETTERS_PATTERN.exec(reference);
  return match === null ? '' : match[1].toUpperCase();
};

/**
 * Reads an inline string cell's text. All `<t>` nodes in the cell are
 * concatenated, which yields the single `<is><t>` child these workbooks use and
 * also keeps a rich-text run sequence (`<is><r><t>...`) intact rather than
 * returning only its first fragment. `<t>` is matched with any attributes
 * (`xml:space="preserve"` is legal and common) and a self-closing `<t/>`
 * contributes nothing.
 *
 * @param {string} content The cell's inner XML.
 * @returns {string} The cell's text, or `''` when it carries none.
 */
const readInlineString = (content) => {
  const textPattern = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let text = '';
  let match = textPattern.exec(content);
  while (match !== null) {
    if (match[1] !== undefined) text += unescapeXml(match[1]);
    match = textPattern.exec(content);
  }
  return text;
};

/**
 * Reads a cell's `<v>` value as a string. This is the path for `t="n"` cells
 * and for an untyped cell (OOXML defaults an absent `t` to number), as well as
 * for any other non-inline type such as `t="str"` or `t="b"`. Values are left
 * as written - `'20'`, `'8.199999999999999'` - because consumers compare text
 * and number formatting is not this module's decision.
 *
 * @param {string} content The cell's inner XML.
 * @returns {string} The raw value, or `''` when the cell carries no `<v>`.
 */
const readStoredValue = (content) => {
  const match = VALUE_ELEMENT_PATTERN.exec(content);
  if (match === null || match[1] === undefined) return '';
  return unescapeXml(match[1]);
};

/**
 * Reads one cell's value according to its declared type.
 *
 * @param {string|undefined} attributes The cell tag's attribute text.
 * @param {string|undefined} content The cell's inner XML; `undefined` for `<c .../>`.
 * @returns {string} The cell's value, `''` when the expected child is missing.
 */
const readCellValue = (attributes, content) => {
  if (typeof content !== 'string' || content === '') return '';
  const type = readAttribute(attributes, TYPE_ATTRIBUTE_PATTERN);
  return type === INLINE_STRING_TYPE ? readInlineString(content) : readStoredValue(content);
};

/**
 * Builds one row object from a row's inner XML. Cells are keyed by column
 * letter; a cell with no parseable `r` attribute has no defensible key and is
 * skipped rather than guessed at.
 *
 * Both cell forms are handled: `<c ...>...</c>` and the self-closing `<c .../>` a
 * writer emits for a styled-but-empty cell, which yields `''`.
 *
 * @param {string|undefined} rowContent The row's inner XML; `undefined` for `<row .../>`.
 * @returns {Record<string, string>} The row keyed by column letter.
 */
const parseRow = (rowContent) => {
  const row = {};
  if (typeof rowContent !== 'string' || rowContent === '') return row;
  const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match = cellPattern.exec(rowContent);
  while (match !== null) {
    const column = readColumnKey(readAttribute(match[1], REFERENCE_ATTRIBUTE_PATTERN));
    if (column !== '') row[column] = readCellValue(match[1], match[2]);
    match = cellPattern.exec(rowContent);
  }
  return row;
};

/**
 * Parses every `<row>` element in document order, so `rows[0]` is the header
 * row the consumers validate and everything after it is a data row. A
 * self-closing `<row .../>` is a legitimately empty row and yields `{}` rather
 * than crashing the parse.
 *
 * @param {string} xml The worksheet XML.
 * @returns {Array<Record<string, string>>} The rows, in document order.
 */
const parseRows = (xml) => {
  const rows = [];
  const rowPattern = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let match = rowPattern.exec(xml);
  while (match !== null) {
    rows.push(parseRow(match[2]));
    match = rowPattern.exec(xml);
  }
  return rows;
};

/**
 * Reads the worksheet of an `.xlsx` workbook and returns its rows.
 *
 * This is the module's whole public contract and the function both
 * `lib/studentDirectory.js` and `lib/activityRepository.js` call. The read is
 * synchronous and complete: the returned rows are a point-in-time snapshot, and
 * a failure to produce them throws rather than yielding an empty array, so a
 * caller constructing the server aborts instead of serving blank data.
 *
 * @param {string} filePath Path to the `.xlsx` file. A relative path is
 *   resolved by the filesystem against the process's working directory, so
 *   callers are expected to pass a path they resolved themselves.
 * @returns {Array<Record<string, string>>} The worksheet's rows in document
 *   order - `rows[0]` is the header row - each keyed by column letter with
 *   string values and `''` for a blank cell.
 * @throws {Error} Always with `code === 'WORKBOOK_READ_FAILED'`, `path` set and
 *   the path interpolated into the message: 'Workbook not found', 'Workbook
 *   could not be read' (a directory, a permission denial, a platform lock),
 *   'Not a valid .xlsx package', 'Workbook has no xl/worksheets/sheet1.xml
 *   part', 'Workbook uses an unsupported ZIP compression method N', or
 *   'Workbook worksheet part could not be decompressed'.
 *
 * @example
 * const { readWorksheetRows } = require('./workbook');
 * const rows = readWorksheetRows(path.join(workbookDir, 'student_other_info.xlsx'));
 * rows[0].C;        // 'Extracurricular Activity'
 * rows[1].A;        // 'S001'
 * rows[1].C;        // 'Robotics Club'
 */
const readWorksheetRows = (filePath) => {
  assertUsablePath(filePath);
  const buffer = readWorkbookBuffer(filePath);
  const entry = locateWorksheetEntry(buffer, filePath);
  const xml = readWorksheetXml(buffer, entry, filePath);
  return parseRows(xml);
};

module.exports = { readWorksheetRows };
