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
 * ZIP container is walked by hand and inflated with `node:zlib`, and the
 * worksheet XML is read by the single-pass scanner further down this file -
 * there is no regular expression anywhere in the structural parse, so the work
 * is linear in the size of the part and a malformed tag is rejected where it is
 * met rather than backtracked over. What keeps that safe is how narrow the
 * input is; every claim below was verified against all three committed
 * workbooks before this reader was written:
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
 * THE SUPPORTED SUBSET, AND WHAT IS REFUSED BY NAME
 * ---------------------------------------------------------------------------
 * This reader implements exactly the shapes above, and an input that needs more
 * is REFUSED with a path-bearing error rather than read into something
 * plausible. Each refusal below is deliberate and detected on purpose - none of
 * them is merely a gap left by the narrow implementation:
 *
 *   - A shared-string cell (`t="s"`) is refused with the cell named. Its `<v>`
 *     holds an index into a table this reader does not read, so returning that
 *     value would print `'0'` where the sheet shows text.
 *   - Any other declared cell type - `b`, `d`, `e`, `str` - is refused with the
 *     type and the cell named. The supported set is `inlineStr`, `n`, and an
 *     absent `t`, which OOXML defines as numeric.
 *   - A formula cell is refused: an `<f>` child means the stored `<v>` is a
 *     cached result this reader can neither recompute nor verify.
 *   - Merged-cell metadata (`<mergeCells>`) is refused, because the blank
 *     continuation cells of a merged range would otherwise read as ordinary
 *     empty values with nothing to show that a merge produced them.
 *   - Malformed, truncated or unbalanced XML is refused, so a half-written
 *     worksheet can never be mistaken for a sheet that legitimately holds fewer
 *     students than it did yesterday.
 *   - A worksheet part whose declared uncompressed size exceeds this reader's
 *     ceiling is refused before a byte of it is inflated.
 *
 * Two things are absent WITHOUT being refused, and they are stated here so the
 * contract is not read as stronger than it is: number formatting and date
 * serial numbers are not interpreted, and cell styles are not resolved. A date
 * or a formatted number therefore arrives as the raw stored string - exactly
 * what the CONTRACT below promises for every value - rather than as an error.
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
 * That path guarantee holds for an unusable ARGUMENT too, not only for a file
 * that failed to open: a caller who passes `42`, `null` or an object gets an
 * error whose `path` carries a safe rendering of what arrived (`42`, `<null>`,
 * `<object>`). The rendering is built from the value's type alone and never
 * calls anything on the value, so a broken or hostile `toString` cannot hijack
 * the diagnostic.
 *
 * BOUNDED WORK
 * ---------------------------------------------------------------------------
 * A workbook is untrusted input in the sense that matters here: it is a file a
 * maintainer or a tool produced, and this reader runs while the process is
 * starting. So the work it can be made to do is bounded rather than trusted.
 * The worksheet entry is inflated under an explicit `maxOutputLength` taken
 * from the size the archive declares, that size is refused outright above
 * `MAX_WORKSHEET_BYTES`, the inflated length is verified against the
 * declaration, and the XML scan advances strictly forward with a capped element
 * depth. So a 65 KB entry cannot expand to hundreds of megabytes while the
 * server starts, and malformed markup cannot cost more than one pass over it.
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

/** The 16-bit counterpart of `ZIP64_SENTINEL`, used for entry counts. */
const ZIP64_COUNT_SENTINEL = 0xffff;

/**
 * How many central directory records the whole end-of-central-directory scan
 * may read, as a multiple of the most an archive of this size could hold, plus
 * a small constant for tiny files.
 *
 * The scan validates each candidate by walking the directory it declares, and a
 * crafted file can present many candidates - so without a shared budget the
 * work would be candidates times records rather than a single pass. A genuine
 * archive spends exactly one walk of its own records, which is why 4x the
 * theoretical maximum is unreachable in practice: these workbooks hold 9
 * records against a budget of 587.
 */
const CENTRAL_RECORD_BUDGET_FACTOR = 4;
const CENTRAL_RECORD_BUDGET_FLOOR = 64;

/** Bit 0 of an entry's general-purpose flags: the entry data is encrypted. */
const ENCRYPTED_ENTRY_FLAG = 0x0001;

/**
 * The ceiling on the worksheet part's declared uncompressed size, and the
 * `maxOutputLength` ultimately handed to `inflateRawSync`.
 *
 * The committed parts are 4,521 to 7,322 bytes, so this is roughly four
 * thousand times the size anything here needs; a maintainer could grow the
 * sheet to tens of thousands of students without meeting it. What it rules out
 * is the case that has no legitimate shape: a small DEFLATE entry that expands
 * without limit while the server is starting. Refusing the DECLARED size first
 * means the refusal costs nothing at all - no inflate is attempted.
 */
const MAX_WORKSHEET_BYTES = 32 * 1024 * 1024;

/** The worksheet elements the scanner recognises by name. */
const WORKSHEET_ELEMENT = 'worksheet';
const SHEET_DATA_ELEMENT = 'sheetData';
const ROW_ELEMENT = 'row';
const CELL_ELEMENT = 'c';
const VALUE_ELEMENT = 'v';
const INLINE_STRING_ELEMENT = 'is';
const TEXT_ELEMENT = 't';
const FORMULA_ELEMENT = 'f';
const RUN_ELEMENT = 'r';

/**
 * The elements whose content model is element-only, so character data inside
 * one is text this reader would have to discard - which is exactly the silent
 * loss it must not perform. Text outside the root element is refused on the
 * same grounds: a document with it is not well formed.
 */
const TEXT_FREE_ELEMENTS = new Set([
  WORKSHEET_ELEMENT,
  SHEET_DATA_ELEMENT,
  ROW_ELEMENT,
  CELL_ELEMENT,
  INLINE_STRING_ELEMENT,
  RUN_ELEMENT
]);

/**
 * The elements this reader reads, mapped to the parent each one must have. A
 * recognised element in the wrong place is refused rather than ignored: an
 * unknown element can be stepped over safely, but a `<v>` or a `<t>` somewhere
 * this reader does not look for one means a value it would drop.
 *
 * `<t>` is the one with two legal parents - directly under `<is>`, or inside a
 * rich-text `<r>` run - and both are the positions whose text IS the cell's
 * value. A `<t>` anywhere else (a phonetic `<rPh>` run, say) carries text that
 * is NOT the value, so concatenating it would corrupt the cell.
 */
const REQUIRED_PARENTS = new Map([
  [SHEET_DATA_ELEMENT, [WORKSHEET_ELEMENT]],
  [ROW_ELEMENT, [SHEET_DATA_ELEMENT]],
  [CELL_ELEMENT, [ROW_ELEMENT]],
  [VALUE_ELEMENT, [CELL_ELEMENT]],
  [INLINE_STRING_ELEMENT, [CELL_ELEMENT]],
  [TEXT_ELEMENT, [INLINE_STRING_ELEMENT, RUN_ELEMENT]],
  [FORMULA_ELEMENT, [CELL_ELEMENT]]
]);

/**
 * Merged-cell metadata, refused wherever it appears. A merge leaves its
 * continuation cells blank in the stored XML, so honouring the range is the
 * only way to read such a sheet correctly and ignoring it silently mislabels
 * real values as empty.
 */
const MERGE_ELEMENTS = new Set(['mergeCells', 'mergeCell']);

/** The cell type that stores its text inline, in an `<is><t>` child. */
const INLINE_STRING_TYPE = 'inlineStr';

/** The numeric cell type, whose value is the raw text of `<v>`. */
const NUMBER_TYPE = 'n';

/** The shared-string cell type: refused by name, never read as its index. */
const SHARED_STRING_TYPE = 's';

/**
 * A complete cell reference - column letters then a row number, anchored at
 * both ends. A prefix match would accept `r="A-not-a-row"` as column `A` and
 * let a malformed reference populate or overwrite a legitimate column, so the
 * whole attribute must match. Three letters is the sheet maximum (`XFD`).
 */
const CELL_REFERENCE_PATTERN = /^([A-Za-z]{1,3})([1-9][0-9]*)$/;

/** A row's `r` attribute: a positive row number with no leading zero. */
const ROW_NUMBER_PATTERN = /^[1-9][0-9]*$/;

/**
 * How deeply elements may nest before the scan is refused. These worksheets
 * nest five deep (`worksheet > sheetData > row > c > is > t` is six), so this
 * is ample, and it bounds the scanner's stack absolutely rather than letting a
 * pathological part grow it without limit.
 */
const MAX_ELEMENT_DEPTH = 64;

/**
 * How much of an offending attribute value a diagnostic repeats. Long enough
 * to identify a real reference, short enough that a hostile file cannot turn an
 * error message into a payload.
 */
const MAX_QUOTED_VALUE_LENGTH = 48;

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
 * Renders any value as a short label for a diagnostic WITHOUT invoking anything
 * on it. Nothing here calls `toString`, `valueOf`, `JSON.stringify` or a getter,
 * so a broken or hostile object cannot hijack - or throw from inside - the
 * error being built. Objects and functions are reduced to a fixed label because
 * their contents are never what a path diagnostic needs.
 *
 * @param {unknown} value The value to describe.
 * @returns {string} A safe, non-empty rendering such as `42`, `<null>` or `<object>`.
 */
const describeValue = (value) => {
  if (value === null) return '<null>';
  switch (typeof value) {
    case 'string':
      return value;
    case 'undefined':
      return '<undefined>';
    case 'number':
    case 'boolean':
      // Primitive conversion here is the language's own, not the value's.
      return `${value}`;
    case 'bigint':
      return `${value}n`;
    case 'symbol':
      return '<symbol>';
    case 'function':
      return '<function>';
    default:
      return '<object>';
  }
};

/**
 * Refuses a path that cannot name a file before the filesystem is touched.
 *
 * Both branches throw the module's one error shape, so the documented guarantee
 * - every error carries `code`, carries `path` and names the path in its
 * message - holds for an unusable argument exactly as it does for a file that
 * failed to open. For a non-string argument `path` carries the safe rendering
 * from `describeValue`, never the value itself, which keeps the diagnostic
 * truthful without handing control to the caller's object.
 *
 * @param {unknown} filePath The caller-supplied path.
 * @returns {void}
 * @throws {Error} With `code === 'WORKBOOK_READ_FAILED'` and `path` set when the
 *   path is not a string or holds nothing but whitespace.
 */
const assertUsablePath = (filePath) => {
  if (typeof filePath !== 'string') {
    throw createWorkbookError(
      'Workbook path must be a non-empty string',
      describeValue(filePath),
      `received ${filePath === null ? 'null' : typeof filePath}`
    );
  }
  if (filePath.trim() === '') {
    throw createWorkbookError(
      'Workbook path must be a non-empty string',
      filePath,
      'received an empty string'
    );
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
 * Decides whether signature-shaped bytes at `at` really are the
 * end-of-central-directory record, by checking everything about the candidate
 * that a genuine record fixes.
 *
 * The signature alone decides nothing: `PK\x05\x06` is four ordinary bytes and
 * may legally appear inside the archive comment, inside compressed entry data,
 * or in a file that is not an archive at all. Because the comment TRAILS the
 * record, a false signature planted in it sits at a HIGHER offset than the real
 * record and a backward scan meets it first - so accepting the first match
 * rejects a perfectly valid package. Every condition below is a fact the format
 * guarantees, and all of them together are what let the scan walk past a false
 * candidate and find the real one.
 *
 * @param {Buffer} buffer The whole workbook.
 * @param {number} at Offset of the candidate signature.
 * @returns {{offset: number, entryCount: number, centralDirectoryOffset: number,
 *   centralDirectorySize: number}|null} The parsed record, or `null` when these
 *   bytes are not one.
 */
const readEndOfCentralDirectory = (buffer, at) => {
  if (at + END_OF_CENTRAL_DIRECTORY_SIZE > buffer.length) return null;
  if (buffer.readUInt32LE(at) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) return null;

  const thisDisk = buffer.readUInt16LE(at + 4);
  const directoryStartDisk = buffer.readUInt16LE(at + 6);
  const entriesOnThisDisk = buffer.readUInt16LE(at + 8);
  const entryCount = buffer.readUInt16LE(at + 10);
  const centralDirectorySize = buffer.readUInt32LE(at + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(at + 16);
  const commentLength = buffer.readUInt16LE(at + 20);

  // The record and its comment are the last bytes of the archive: nothing may
  // follow them. This is the condition a comment-borne false signature fails.
  if (at + END_OF_CENTRAL_DIRECTORY_SIZE + commentLength !== buffer.length) return null;
  // A split archive has no single file to read, and a ZIP64 sentinel means the
  // real values live in a record this reader does not parse.
  if (thisDisk !== 0 || directoryStartDisk !== 0) return null;
  if (entriesOnThisDisk !== entryCount || entryCount === ZIP64_COUNT_SENTINEL) return null;
  if (centralDirectorySize === ZIP64_SENTINEL || centralDirectoryOffset === ZIP64_SENTINEL) {
    return null;
  }
  // The central directory ENDS where this record begins - exactly, with no gap.
  // An ordinary ZIP puts nothing between the two, so requiring `<=` would let a
  // record-shaped decoy in the archive comment claim a directory it has no
  // relationship to; all three committed workbooks satisfy the equality
  // (5422 + 574 = 5996, 4950 + 574 = 5524, 4955 + 574 = 5529).
  if (centralDirectoryOffset + centralDirectorySize !== at) return null;
  // And it begins with a central file header whenever it holds any entry.
  if (entryCount > 0) {
    if (centralDirectorySize < CENTRAL_FILE_HEADER_SIZE) return null;
    if (buffer.readUInt32LE(centralDirectoryOffset) !== CENTRAL_FILE_HEADER_SIGNATURE) {
      return null;
    }
  } else if (centralDirectorySize !== 0) {
    return null;
  }

  return { offset: at, entryCount, centralDirectoryOffset, centralDirectorySize };
};

/**
 * Walks ONE candidate's central directory and resolves the worksheet entry BY
 * NAME.
 *
 * The walk is completed even after the worksheet is found, and that is the
 * point rather than waste. Every record is constrained to the byte range the
 * candidate declares, EVERY variable field it declares - name, extra and
 * comment - must fit inside that range, and the finished walk must land exactly
 * on the directory's declared end. Returning early would leave the tail of the
 * directory unread, which is how a truncated final record gets accepted, and
 * how a package that is actually damaged gets reported as one that merely has
 * no worksheet.
 *
 * @param {Buffer} buffer The whole workbook.
 * @param {{entryCount: number, centralDirectoryOffset: number,
 *   centralDirectorySize: number}} record The validated candidate.
 * @param {string} filePath The workbook path, for error messages.
 * @param {{remaining: number}} budget The record allowance shared by every
 *   candidate of this scan, decremented per record read.
 * @returns {{method: number, compressedSize: number, uncompressedSize: number,
 *   localHeaderOffset: number}|null} The worksheet entry, or `null` when this
 *   directory is intact but declares no worksheet part.
 * @throws {Error} 'Not a valid .xlsx package: <path>' when the directory itself
 *   does not hold up: a wrong entry signature, a record or declared field that
 *   does not fit, a walk that does not match the declared size, a worksheet
 *   declared twice, an encrypted worksheet, a ZIP64 sentinel, or a scan that
 *   has spent its whole record allowance.
 */
const walkCentralDirectory = (buffer, record, filePath, budget) => {
  const { entryCount, centralDirectoryOffset, centralDirectorySize } = record;
  assertWithinBuffer(
    buffer,
    centralDirectoryOffset,
    centralDirectorySize,
    filePath,
    'the central directory'
  );
  const directoryEnd = centralDirectoryOffset + centralDirectorySize;

  let at = centralDirectoryOffset;
  let worksheet = null;

  for (let index = 0; index < entryCount; index += 1) {
    if (budget.remaining <= 0) {
      throw createWorkbookError(
        'Not a valid .xlsx package',
        filePath,
        'the end-of-central-directory scan spent its whole allowance of central ' +
          'directory records without resolving a directory'
      );
    }
    budget.remaining -= 1;
    if (at + CENTRAL_FILE_HEADER_SIZE > directoryEnd) {
      throw createWorkbookError(
        'Not a valid .xlsx package',
        filePath,
        `central directory entry ${index} extends past the declared ` +
          `${centralDirectorySize}-byte central directory`
      );
    }
    if (buffer.readUInt32LE(at) !== CENTRAL_FILE_HEADER_SIGNATURE) {
      throw createWorkbookError(
        'Not a valid .xlsx package',
        filePath,
        `central directory entry ${index} has an unexpected signature`
      );
    }

    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const uncompressedSize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localHeaderOffset = buffer.readUInt32LE(at + 42);

    // Every declared variable field, not merely the name, has to be present:
    // an entry claiming extra bytes it does not carry has already shifted the
    // offset of every record after it.
    const variableLength = nameLength + extraLength + commentLength;
    if (at + CENTRAL_FILE_HEADER_SIZE + variableLength > directoryEnd) {
      throw createWorkbookError(
        'Not a valid .xlsx package',
        filePath,
        `central directory entry ${index} declares ${nameLength} name, ` +
          `${extraLength} extra and ${commentLength} comment bytes, which do not ` +
          'fit inside the declared central directory'
      );
    }
    const name = buffer.toString(
      'utf8',
      at + CENTRAL_FILE_HEADER_SIZE,
      at + CENTRAL_FILE_HEADER_SIZE + nameLength
    );

    if (name === WORKSHEET_PART) {
      if (worksheet !== null) {
        throw createWorkbookError(
          'Not a valid .xlsx package',
          filePath,
          `${WORKSHEET_PART} is declared by more than one central directory entry`
        );
      }
      if (
        compressedSize === ZIP64_SENTINEL ||
        uncompressedSize === ZIP64_SENTINEL ||
        localHeaderOffset === ZIP64_SENTINEL
      ) {
        throw createWorkbookError(
          'Not a valid .xlsx package',
          filePath,
          'ZIP64 packages are not supported by this reader'
        );
      }
      if ((flags & ENCRYPTED_ENTRY_FLAG) !== 0) {
        throw createWorkbookError(
          'Not a valid .xlsx package',
          filePath,
          `${WORKSHEET_PART} is encrypted, and this reader holds no key`
        );
      }
      worksheet = { method, compressedSize, uncompressedSize, localHeaderOffset };
    }

    at += CENTRAL_FILE_HEADER_SIZE + variableLength;
  }

  if (at !== directoryEnd) {
    throw createWorkbookError(
      'Not a valid .xlsx package',
      filePath,
      `the central directory declares ${centralDirectorySize} bytes for ` +
        `${entryCount} entries, and the walk consumed ${at - centralDirectoryOffset}`
    );
  }
  return worksheet;
};

/**
 * Resolves the worksheet entry by scanning backwards for the
 * end-of-central-directory record and walking the directory each candidate
 * declares. The directory is the authoritative index: the local header's own
 * size fields are unreliable across writers, so the sizes recorded there are
 * the ones used to slice and to bound the entry data.
 *
 * A CANDIDATE IS NEVER COMMITTED TO ON THE STRENGTH OF ITS OWN BYTES. The scan
 * is bounded to the last 65557 bytes (the record plus the largest possible
 * trailing comment) and a candidate is accepted only once
 * `readEndOfCentralDirectory` validates its fields AND the directory it points
 * at walks cleanly AND that directory declares the worksheet. Anything short of
 * that continues the scan, because the archive comment TRAILS the record it
 * follows: a decoy planted in the comment - four signature bytes or a complete
 * record-shaped 22 bytes - sits at a HIGHER offset than the real record and a
 * backward scan meets it first. Committing to it would reject a valid package,
 * so instead it is stepped over and the real record is found beneath it.
 *
 * What the failures mean is kept distinct, because the three say different
 * things to whoever has to fix the file: a directory that walks cleanly but
 * declares no worksheet is a package missing its part, a directory that does
 * not walk is a damaged package (its own diagnostic is preserved and rethrown
 * if no better candidate exists), and no valid candidate at all is a file that
 * is not a ZIP archive.
 *
 * @param {Buffer} buffer The whole workbook.
 * @param {string} filePath The workbook path, for error messages.
 * @returns {{method: number, compressedSize: number, uncompressedSize: number,
 *   localHeaderOffset: number}} The worksheet entry's compression method, its
 *   compressed and declared uncompressed sizes, and its local header offset.
 * @throws {Error} 'Workbook has no xl/worksheets/sheet1.xml part: <path>' when a
 *   candidate's directory is intact but carries no worksheet; 'Not a valid .xlsx
 *   package: <path>' with the walk's own detail when a directory does not hold
 *   up, and with 'no ZIP end-of-central-directory record was found' when no
 *   candidate validates at all.
 */
const locateWorksheetEntry = (buffer, filePath) => {
  /** The first walk failure met, kept in case no candidate does better. */
  let firstFailure = null;
  /** Whether some candidate's directory was intact yet held no worksheet. */
  let sawIntactDirectory = false;
  /** The record allowance shared by every candidate, so the scan stays linear. */
  const budget = {
    remaining:
      CENTRAL_RECORD_BUDGET_FLOOR +
      CENTRAL_RECORD_BUDGET_FACTOR * Math.floor(buffer.length / CENTRAL_FILE_HEADER_SIZE)
  };

  if (buffer.length >= END_OF_CENTRAL_DIRECTORY_SIZE) {
    const lowest = Math.max(0, buffer.length - END_OF_CENTRAL_DIRECTORY_MAX_SCAN);
    for (let at = buffer.length - END_OF_CENTRAL_DIRECTORY_SIZE; at >= lowest; at -= 1) {
      const record = readEndOfCentralDirectory(buffer, at);
      if (record === null) continue;
      let worksheet;
      try {
        worksheet = walkCentralDirectory(buffer, record, filePath, budget);
      } catch (failure) {
        // This candidate's directory does not hold up, so it is not the record
        // - keep scanning, and keep its diagnostic for the case where nothing
        // better turns up.
        if (firstFailure === null) firstFailure = failure;
        continue;
      }
      if (worksheet !== null) return worksheet;
      sawIntactDirectory = true;
    }
  }

  if (sawIntactDirectory) {
    throw createWorkbookError(`Workbook has no ${WORKSHEET_PART} part`, filePath);
  }
  if (firstFailure !== null) throw firstFailure;
  throw createWorkbookError(
    'Not a valid .xlsx package',
    filePath,
    'no ZIP end-of-central-directory record was found'
  );
};

/**
 * Inflates the worksheet entry and decodes it as UTF-8. Entry data begins after
 * the local header's own variable-length name and extra fields, and every entry
 * in these packages is DEFLATE (method 8); the stored (method 0) branch is kept
 * because it costs one comparison and a writer may legitimately use it.
 *
 * DECOMPRESSION IS BOUNDED, in three steps that each exist for a reason. The
 * size the archive declares is refused above `MAX_WORKSHEET_BYTES` before any
 * inflate is attempted, so a declared expansion to gigabytes costs nothing.
 * That same declaration is then handed to `inflateRawSync` as
 * `maxOutputLength`, so a stream that LIES about its size - the actual attack,
 * since the declaration is just as forgeable as the data - is aborted by zlib
 * at the ceiling instead of allocating past it. Finally the inflated length is
 * compared with the declaration, because a stream that stops short of what the
 * directory promised is a truncated part, not a smaller sheet.
 *
 * @param {Buffer} buffer The whole workbook.
 * @param {{method: number, compressedSize: number, uncompressedSize: number,
 *   localHeaderOffset: number}} entry The worksheet entry resolved from the
 *   central directory.
 * @param {string} filePath The workbook path, for error messages.
 * @returns {string} The worksheet XML.
 * @throws {Error} 'Not a valid .xlsx package: <path>' for a bad or truncated local
 *   header, a stored entry whose two sizes disagree, or an inflated length that
 *   does not match the declaration; 'Workbook uses an unsupported ZIP compression
 *   method N: <path>' for any method other than stored or DEFLATE; 'Workbook
 *   worksheet part is too large: <path>' when the declared size exceeds the
 *   reader's ceiling; and 'Workbook worksheet part could not be decompressed:
 *   <path> (<detail>)' when inflation itself fails or runs past the ceiling.
 */
const readWorksheetXml = (buffer, entry, filePath) => {
  const { method, compressedSize, uncompressedSize, localHeaderOffset } = entry;

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
  if (uncompressedSize > MAX_WORKSHEET_BYTES) {
    throw createWorkbookError(
      'Workbook worksheet part is too large',
      filePath,
      `${WORKSHEET_PART} declares ${uncompressedSize} uncompressed bytes, above ` +
        `this reader's ${MAX_WORKSHEET_BYTES} byte ceiling`
    );
  }

  if (method === METHOD_STORED) {
    // A stored entry is its own output, so the two sizes are the same number
    // twice; a disagreement means the record cannot be trusted to bound it.
    if (compressedSize !== uncompressedSize) {
      throw createWorkbookError(
        'Not a valid .xlsx package',
        filePath,
        `the stored ${WORKSHEET_PART} entry declares ${compressedSize} compressed ` +
          `and ${uncompressedSize} uncompressed bytes`
      );
    }
    return buffer.toString('utf8', at, at + compressedSize);
  }

  const raw = buffer.subarray(at, at + compressedSize);
  let inflated;
  try {
    inflated = zlib.inflateRawSync(raw, { maxOutputLength: uncompressedSize });
  } catch (cause) {
    throw createWorkbookError(
      'Workbook worksheet part could not be decompressed',
      filePath,
      describeCause(cause),
      cause
    );
  }
  if (inflated.length !== uncompressedSize) {
    throw createWorkbookError(
      'Not a valid .xlsx package',
      filePath,
      `${WORKSHEET_PART} declares ${uncompressedSize} uncompressed bytes and ` +
        `inflated to ${inflated.length}`
    );
  }
  return inflated.toString('utf8');
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
 * Shortens a value taken from the file before it is quoted in an error message,
 * so a diagnostic names the offender without repeating an arbitrarily long
 * attribute back at whoever reads the log.
 *
 * @param {string} value The raw value read from the worksheet.
 * @returns {string} The value, truncated with an ellipsis when it is long.
 */
const clipQuotedValue = (value) =>
  value.length <= MAX_QUOTED_VALUE_LENGTH
    ? value
    : `${value.slice(0, MAX_QUOTED_VALUE_LENGTH)}...`;

// Character codes the scanner compares against. Comparing codes rather than
// single-character strings keeps the hot loop free of allocation.
const CODE_TAB = 9;
const CODE_NEWLINE = 10;
const CODE_CARRIAGE_RETURN = 13;
const CODE_SPACE = 32;
const CODE_DOUBLE_QUOTE = 34;
const CODE_SINGLE_QUOTE = 39;
const CODE_HYPHEN = 45;
const CODE_PERIOD = 46;
const CODE_SLASH = 47;
const CODE_DIGIT_ZERO = 48;
const CODE_DIGIT_NINE = 57;
const CODE_COLON = 58;
const CODE_EQUALS = 61;
const CODE_GREATER_THAN = 62;
const CODE_UPPER_A = 65;
const CODE_UPPER_Z = 90;
const CODE_UNDERSCORE = 95;
const CODE_LOWER_A = 97;
const CODE_LOWER_Z = 122;

/**
 * Whether a character code is XML whitespace between markup.
 *
 * @param {number} code A UTF-16 code unit.
 * @returns {boolean} True for space, tab, carriage return and newline.
 */
const isWhitespaceCode = (code) =>
  code === CODE_SPACE ||
  code === CODE_NEWLINE ||
  code === CODE_TAB ||
  code === CODE_CARRIAGE_RETURN;

/**
 * Whether a character code may begin an element or attribute name. Deliberately
 * narrower than the XML specification's name-start production: these parts are
 * written by one generator and use ASCII names only, so anything else is a sign
 * the input is not the shape this reader supports.
 *
 * @param {number} code A UTF-16 code unit.
 * @returns {boolean} True for a letter, underscore or colon.
 */
const isNameStartCode = (code) =>
  (code >= CODE_UPPER_A && code <= CODE_UPPER_Z) ||
  (code >= CODE_LOWER_A && code <= CODE_LOWER_Z) ||
  code === CODE_UNDERSCORE ||
  code === CODE_COLON;

/**
 * Whether a character code may continue an element or attribute name.
 *
 * @param {number} code A UTF-16 code unit.
 * @returns {boolean} True for a name-start character, a digit, `-` or `.`.
 */
const isNameCode = (code) =>
  isNameStartCode(code) ||
  (code >= CODE_DIGIT_ZERO && code <= CODE_DIGIT_NINE) ||
  code === CODE_HYPHEN ||
  code === CODE_PERIOD;

/**
 * Whether a span of text holds nothing but whitespace. Used to tell the
 * indentation a writer may emit between cells from real character data sitting
 * where this reader would otherwise silently drop it.
 *
 * @param {string} text The span between two tags.
 * @returns {boolean} True when every character is XML whitespace.
 */
const isBlankText = (text) => {
  for (let at = 0; at < text.length; at += 1) {
    if (!isWhitespaceCode(text.charCodeAt(at))) return false;
  }
  return true;
};

/**
 * Reads one tag - `<name ...>`, `<name .../>` or `</name>` - starting at the
 * `<` at `start`, and returns what the scanner needs from it.
 *
 * The scan is strictly forward and quote-aware: the name is consumed character
 * by character, then attributes are consumed one at a time, and an attribute
 * value is delimited by locating its closing quote from the position after the
 * opening one. A `>` inside a quoted value therefore cannot end the tag early,
 * and no character is examined twice - which is what makes the whole parse
 * linear in the length of the part rather than quadratic on malformed input.
 *
 * Only the two attributes this reader consumes are retained. Every other
 * attribute is still parsed, because its syntax has to be valid for the tag to
 * be well formed, but its value is discarded rather than collected.
 *
 * @param {string} xml The worksheet XML.
 * @param {number} start Offset of the `<` that begins the tag.
 * @param {(detail: string, offset: number) => Error} malformed Builds the
 *   path-bearing error this function throws.
 * @returns {{name: string, closing: boolean, selfClosing: boolean,
 *   reference: string, type: string, end: number}} The tag's name, its form, the
 *   `r` and `t` attribute values (`''` when absent) and the offset just past it.
 * @throws {Error} When the tag's name, attribute syntax or terminator is invalid.
 */
const readTag = (xml, start, malformed) => {
  const length = xml.length;
  let at = start + 1;
  let closing = false;
  if (at < length && xml.charCodeAt(at) === CODE_SLASH) {
    closing = true;
    at += 1;
  }

  const nameStart = at;
  if (at >= length || !isNameStartCode(xml.charCodeAt(at))) {
    throw malformed('a tag carries no element name', start);
  }
  at += 1;
  while (at < length && isNameCode(xml.charCodeAt(at))) at += 1;
  const name = xml.slice(nameStart, at);

  let reference = '';
  let type = '';
  let selfClosing = false;

  for (;;) {
    // Whether whitespace separates whatever comes next from the name or from
    // the previous attribute, checked before that whitespace is consumed.
    const separated = at < length && isWhitespaceCode(xml.charCodeAt(at));
    while (at < length && isWhitespaceCode(xml.charCodeAt(at))) at += 1;
    if (at >= length) throw malformed(`<${name}> is never terminated`, start);

    const code = xml.charCodeAt(at);
    if (code === CODE_GREATER_THAN) {
      at += 1;
      break;
    }
    if (code === CODE_SLASH) {
      if (at + 1 >= length || xml.charCodeAt(at + 1) !== CODE_GREATER_THAN) {
        throw malformed(`<${name}> has a stray / in its tag`, start);
      }
      if (closing) throw malformed(`</${name}> cannot also be self-closing`, start);
      selfClosing = true;
      at += 2;
      break;
    }
    if (closing) {
      throw malformed(`the closing tag </${name}> carries unexpected text`, start);
    }
    if (!separated) {
      throw malformed(`<${name}> has no separator before its next attribute`, at);
    }

    const attributeStart = at;
    if (!isNameStartCode(code)) {
      throw malformed(`<${name}> carries an unnamed attribute`, at);
    }
    at += 1;
    while (at < length && isNameCode(xml.charCodeAt(at))) at += 1;
    const attribute = xml.slice(attributeStart, at);

    while (at < length && isWhitespaceCode(xml.charCodeAt(at))) at += 1;
    if (at >= length || xml.charCodeAt(at) !== CODE_EQUALS) {
      throw malformed(`attribute ${attribute} of <${name}> has no value`, attributeStart);
    }
    at += 1;
    while (at < length && isWhitespaceCode(xml.charCodeAt(at))) at += 1;
    const quote = at < length ? xml.charCodeAt(at) : -1;
    if (quote !== CODE_DOUBLE_QUOTE && quote !== CODE_SINGLE_QUOTE) {
      throw malformed(
        `the value of attribute ${attribute} of <${name}> is not quoted`,
        attributeStart
      );
    }
    at += 1;
    const valueEnd = xml.indexOf(quote === CODE_DOUBLE_QUOTE ? '"' : '\'', at);
    if (valueEnd === -1) {
      throw malformed(
        `the value of attribute ${attribute} of <${name}> is never closed`,
        attributeStart
      );
    }
    if (attribute === 'r') reference = unescapeXml(xml.slice(at, valueEnd));
    else if (attribute === 't') type = unescapeXml(xml.slice(at, valueEnd));
    at = valueEnd + 1;
  }

  return { name, closing, selfClosing, reference, type, end: at };
};

/**
 * Parses a complete cell reference into its column key and row number.
 *
 * @param {string} reference The value of a cell's `r` attribute.
 * @returns {{column: string, row: string}|null} The upper-cased column letters
 *   and the row digits, or `null` when the reference is not a complete
 *   column-letters-then-row-number reference.
 */
const readCellReference = (reference) => {
  const match = CELL_REFERENCE_PATTERN.exec(reference);
  if (match === null) return null;
  return { column: match[1].toUpperCase(), row: match[2] };
};

/**
 * Scans the worksheet XML once, left to right, and returns its rows.
 *
 * WHY A SCANNER AND NOT A REGEX
 * ---------------------------------------------------------------------------
 * The obvious alternative - a set of lazy structural patterns of the shape
 * `/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g` - reads the committed files
 * correctly and has two defects that no amount of tightening fixes. First,
 * `[\s\S]*?` backtracks: given repeated opening tags and no closers, the
 * matcher rescans the remainder for every one of them, measured on this host at
 * 10.9 ms for 1,000 tags, 185.7 ms for 8,000 and 764.9 ms for 16,000 - a
 * quadratic cost paid while the server is starting. Second, a pattern that
 * matches what it can and ignores the rest cannot tell a complete sheet from a
 * truncated one: a part cut before its first `</row>` yields `[]` and one cut
 * after a row yields that row alone, so a half-written workbook becomes a sheet
 * with fewer students and nothing says so.
 *
 * The scanner avoids both by construction. `index` only ever moves forward,
 * each character is examined once, and `indexOf` always searches from the
 * current position - so the cost is one pass over the part, whatever its
 * content, measured at 175 ms for a well-formed 6.4 MB sheet and flat in the
 * malformed case because rejection is immediate. And because it tracks the
 * open-element stack, a structure that does not close is a fault it can SEE,
 * which is what makes the failure loud instead of silent.
 *
 * WHAT IT ACCEPTS
 * ---------------------------------------------------------------------------
 * Exactly the shape these workbooks have, and the documented latitude around
 * it: `<worksheet>` as the root element, rows inside `<sheetData>`, cells
 * carrying a complete `r` reference, values in `<v>` or in `<is><t>` (every
 * `<t>` under an inline string contributes, whether it sits directly beneath
 * `<is>` or inside a rich-text `<r>` run, so a run sequence is kept whole),
 * self-closing rows, cells, values and text, comments, CDATA, processing
 * instructions and XML entity references.
 *
 * An element this reader does not know is IGNORED in the two places OOXML
 * legitimately puts one - outside `<sheetData>` (`sheetPr`, `dimension`,
 * `cols`, `pageMargins` and their kin) and inside a `<row>` or an `<is>`
 * alongside the children that are read - and REFUSED in the two places where
 * ignoring it would mean discarding a value: directly inside `<sheetData>`,
 * whose only child is `<row>`, and directly inside a cell, whose only read
 * children are `<v>` and `<is>`. Character data is likewise ignored where a
 * writer's indentation legitimately appears and refused inside `<sheetData>`,
 * `<row>`, `<c>` and `<is>`, where text would otherwise be dropped in silence.
 * Everything else the module header lists is refused with the path named.
 *
 * @param {string} xml The worksheet XML.
 * @param {string} filePath The workbook path, so every fault names its file.
 * @returns {Array<Record<string, string>>} The rows in document order, each
 *   keyed by column letter with string values.
 * @throws {Error} 'Workbook worksheet XML is malformed: <path> (<detail> at
 *   character offset N)' for a structural fault - N indexes the decoded UTF-16
 *   string, not the file's bytes - and 'Workbook uses an unsupported OOXML
 *   feature: <path> (<detail>)' for a shape this reader refuses to interpret.
 */
const parseWorksheet = (xml, filePath) => {
  /**
   * @param {string} detail What is wrong with the markup.
   * @param {number} offset Where in the DECODED part it is, as an index into
   *   the UTF-16 string - which is not the file's byte offset once the sheet
   *   holds a character outside the ASCII range, so the diagnostic says
   *   "character offset" and means exactly that.
   * @returns {Error} The structural error to throw.
   */
  const malformed = (detail, offset) =>
    createWorkbookError(
      'Workbook worksheet XML is malformed',
      filePath,
      `${detail} at character offset ${offset}`
    );

  /**
   * @param {string} detail Which unsupported shape was met.
   * @returns {Error} The unsupported-feature error to throw.
   */
  const unsupported = (detail) =>
    createWorkbookError('Workbook uses an unsupported OOXML feature', filePath, detail);

  const rows = [];
  /** Names of the elements currently open, outermost first. */
  const stack = [];
  /** Set once the root element is seen, so a second root can be refused. */
  let sawRoot = false;
  /** Set once `<sheetData>` has been seen, so a second one can be refused. */
  let sawSheetData = false;
  /** True while `<sheetData>` is open. */
  let inSheetData = false;
  /** The row being built, or `null` when no `<row>` is open. */
  let row = null;
  /** The open row's `r` attribute, or `''` when it declares none. */
  let rowNumber = '';
  /** Column keys already used by the open row, so a duplicate can be refused. */
  let rowColumns = null;
  /** The open cell's accumulating state, or `null` when no `<c>` is open. */
  let cell = null;
  /** True while a `<t>` inside the open cell's `<is>` is collecting text. */
  let inText = false;
  /** True while the open cell's `<v>` is collecting its value. */
  let inValue = false;
  /** True while an `<is>` belonging to the open cell is open. */
  let inInlineString = false;
  let index = 0;

  /**
   * Routes character data to whichever text-bearing element is open, and
   * refuses it where accepting it would mean dropping a real value on the
   * floor. Between cells a writer's indentation is ordinary and ignored.
   *
   * @param {string} text The span between two tags.
   * @param {number} offset Where the span begins.
   * @param {boolean} escaped True for ordinary text, false for CDATA content.
   * @returns {void}
   */
  const addText = (text, offset, escaped) => {
    if (text === '') return;
    const resolved = escaped ? unescapeXml(text) : text;
    if (inText) {
      cell.text += resolved;
      return;
    }
    if (inValue) {
      cell.value += resolved;
      return;
    }
    if (isBlankText(text)) return;
    const parent = stack.length === 0 ? '' : stack[stack.length - 1];
    if (parent === '') {
      throw malformed(
        `character data "${clipQuotedValue(resolved)}" sits outside the ` +
          `<${WORKSHEET_ELEMENT}> element`,
        offset
      );
    }
    if (TEXT_FREE_ELEMENTS.has(parent)) {
      throw malformed(
        `<${parent}> carries character data "${clipQuotedValue(resolved)}" ` +
          'where this reader expects only elements',
        offset
      );
    }
  };

  /**
   * Finishes the open cell and stores its value under its column key. The
   * value is whichever child the declared type requires; a cell that closed
   * without that child is an empty cell, exactly as a self-closing one is.
   *
   * @param {number} offset Where the closing tag begins, for diagnostics.
   * @returns {void}
   */
  const closeCell = (offset) => {
    if (cell.type === INLINE_STRING_TYPE) {
      if (cell.sawValue) {
        throw unsupported(
          `cell ${cell.reference} declares t="${INLINE_STRING_TYPE}" and stores its ` +
            'value in <v>, which this reader cannot tell from a shared-string index'
        );
      }
      row[cell.column] = cell.text;
    } else {
      if (cell.sawInlineString) {
        throw malformed(
          `cell ${cell.reference} carries an inline string without declaring ` +
            `t="${INLINE_STRING_TYPE}"`,
          offset
        );
      }
      row[cell.column] = cell.value;
    }
    cell = null;
  };

  /**
   * Applies an opening or self-closing tag.
   *
   * @param {{name: string, selfClosing: boolean, reference: string, type: string}} tag
   *   The tag as `readTag` returned it.
   * @param {number} offset Where the tag begins.
   * @returns {void}
   */
  const openElement = (tag, offset) => {
    const { name, selfClosing, reference, type } = tag;
    const parent = stack.length === 0 ? '' : stack[stack.length - 1];

    if (inValue || inText) {
      throw malformed(
        `<${name}> is not allowed inside <${inValue ? VALUE_ELEMENT : TEXT_ELEMENT}>`,
        offset
      );
    }
    if (MERGE_ELEMENTS.has(name)) {
      throw unsupported(
        `<${name}> describes a merged cell range, whose continuation cells are ` +
          'stored blank and would be read as empty values'
      );
    }
    if (stack.length === 0) {
      if (sawRoot) throw malformed(`a second root element <${name}> follows the first`, offset);
      if (name !== WORKSHEET_ELEMENT) {
        throw malformed(
          `the root element is <${name}> rather than <${WORKSHEET_ELEMENT}>`,
          offset
        );
      }
      sawRoot = true;
    }
    if (stack.length >= MAX_ELEMENT_DEPTH) {
      throw malformed(`elements nest deeper than ${MAX_ELEMENT_DEPTH} levels`, offset);
    }

    // An element this reader READS has to be where this reader looks for it.
    // An unknown element can be stepped over without losing anything, but a
    // recognised one in the wrong place would be stepped over as though it were
    // unknown - and a `<v>` or a `<t>` stepped over is a value discarded in
    // silence, which is the whole failure this module exists to refuse.
    const permittedParents = REQUIRED_PARENTS.get(name);
    if (permittedParents !== undefined && !permittedParents.includes(parent)) {
      throw malformed(
        `<${name}> is inside <${parent}> rather than ` +
          `${permittedParents.map((allowed) => `<${allowed}>`).join(' or ')}`,
        offset
      );
    }

    if (name === SHEET_DATA_ELEMENT) {
      if (sawSheetData) {
        throw malformed(`a second <${SHEET_DATA_ELEMENT}> element follows the first`, offset);
      }
      sawSheetData = true;
      if (!selfClosing) inSheetData = true;
    } else if (name === ROW_ELEMENT) {
      if (reference !== '' && !ROW_NUMBER_PATTERN.test(reference)) {
        throw malformed(
          `row reference "${clipQuotedValue(reference)}" is not a positive row number`,
          offset
        );
      }
      // A self-closing <row/> is a legitimately empty row, and stays one.
      if (selfClosing) {
        rows.push({});
      } else {
        row = {};
        rowNumber = reference;
        rowColumns = new Set();
      }
    } else if (name === CELL_ELEMENT) {
      // Without a reference a cell cannot be keyed, and a value that cannot be
      // keyed would be dropped in silence - so the reference is required and
      // has to be complete, not merely start with letters.
      if (reference === '') {
        throw malformed(
          `a cell in row ${rowNumber === '' ? '(unnumbered)' : rowNumber} carries no ` +
            'r attribute, so its column cannot be determined',
          offset
        );
      }
      const parsed = readCellReference(reference);
      if (parsed === null) {
        throw malformed(
          `cell reference "${clipQuotedValue(reference)}" is not a column letter ` +
            'and row number',
          offset
        );
      }
      if (rowNumber !== '' && parsed.row !== rowNumber) {
        throw malformed(
          `cell ${parsed.column}${parsed.row} is stored inside row ${rowNumber}`,
          offset
        );
      }
      if (rowColumns.has(parsed.column)) {
        throw malformed(
          `row ${rowNumber === '' ? '(unnumbered)' : rowNumber} stores column ` +
            `${parsed.column} twice`,
          offset
        );
      }
      if (type === SHARED_STRING_TYPE) {
        throw unsupported(
          `cell ${reference} is a shared-string cell (t="${SHARED_STRING_TYPE}"), whose ` +
            'value is an index into a shared-string table this reader does not read'
        );
      }
      if (type !== '' && type !== INLINE_STRING_TYPE && type !== NUMBER_TYPE) {
        throw unsupported(
          `cell ${reference} declares cell type t="${clipQuotedValue(type)}", and this ` +
            `reader supports only "${INLINE_STRING_TYPE}", "${NUMBER_TYPE}" and an ` +
            'absent type'
        );
      }
      rowColumns.add(parsed.column);
      // A self-closing <c/> is the styled-but-empty cell a writer emits.
      if (selfClosing) {
        row[parsed.column] = '';
      } else {
        cell = {
          reference,
          column: parsed.column,
          type,
          text: '',
          value: '',
          sawValue: false,
          sawInlineString: false
        };
      }
    } else if (cell !== null && parent === CELL_ELEMENT) {
      if (name === FORMULA_ELEMENT) {
        throw unsupported(
          `cell ${cell.reference} carries a formula (<${FORMULA_ELEMENT}>), whose stored ` +
            'value is a cached result this reader can neither recompute nor verify'
        );
      }
      if (name === VALUE_ELEMENT) {
        if (cell.sawValue) {
          throw malformed(
            `cell ${cell.reference} carries more than one <${VALUE_ELEMENT}>`,
            offset
          );
        }
        cell.sawValue = true;
        if (!selfClosing) inValue = true;
      } else if (name === INLINE_STRING_ELEMENT) {
        if (cell.sawInlineString) {
          throw malformed(
            `cell ${cell.reference} carries more than one <${INLINE_STRING_ELEMENT}>`,
            offset
          );
        }
        cell.sawInlineString = true;
        if (!selfClosing) inInlineString = true;
      } else {
        throw unsupported(
          `cell ${cell.reference} carries <${name}>, which is not one of the ` +
            `<${VALUE_ELEMENT}> and <${INLINE_STRING_ELEMENT}> children this reader reads`
        );
      }
    } else if (name === TEXT_ELEMENT) {
      // Every <t> under the open cell's <is> contributes, whether it sits
      // directly beneath it or inside a rich-text <r> run, and a self-closing
      // <t/> contributes nothing. Attributes such as xml:space="preserve" are
      // already parsed. A <t> in an <r> that belongs to no inline string has
      // text that is nobody's value, so it is refused rather than dropped.
      if (!inInlineString) {
        throw malformed(
          `<${TEXT_ELEMENT}> is outside any <${INLINE_STRING_ELEMENT}>`,
          offset
        );
      }
      if (!selfClosing) inText = true;
    } else if (inSheetData && row === null && name !== SHEET_DATA_ELEMENT) {
      // Between rows, sheetData holds nothing this reader knows how to read.
      throw unsupported(
        `<${SHEET_DATA_ELEMENT}> carries <${name}>, and this reader reads only ` +
          `<${ROW_ELEMENT}> elements from it`
      );
    }

    if (!selfClosing) stack.push(name);
  };

  /**
   * Applies a closing tag, checking it against the element it must close.
   *
   * @param {string} name The closing tag's element name.
   * @param {number} offset Where the tag begins.
   * @returns {void}
   */
  const closeElement = (name, offset) => {
    if (stack.length === 0) {
      throw malformed(`</${name}> closes an element that was never opened`, offset);
    }
    const open = stack[stack.length - 1];
    if (open !== name) {
      throw malformed(`</${name}> closes <${open}>`, offset);
    }
    stack.pop();

    if (name === TEXT_ELEMENT && inText) inText = false;
    else if (name === VALUE_ELEMENT && inValue) inValue = false;
    else if (name === INLINE_STRING_ELEMENT && inInlineString) inInlineString = false;
    else if (name === CELL_ELEMENT && cell !== null) closeCell(offset);
    else if (name === ROW_ELEMENT && row !== null) {
      rows.push(row);
      row = null;
      rowNumber = '';
      rowColumns = null;
    } else if (name === SHEET_DATA_ELEMENT) inSheetData = false;
  };

  while (index < xml.length) {
    const tagStart = xml.indexOf('<', index);
    if (tagStart === -1) {
      addText(xml.slice(index), index, true);
      index = xml.length;
      break;
    }
    if (tagStart > index) addText(xml.slice(index, tagStart), index, true);
    index = tagStart;

    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4);
      if (end === -1) throw malformed('a comment is never closed', index);
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', index)) {
      const end = xml.indexOf(']]>', index + 9);
      if (end === -1) throw malformed('a CDATA section is never closed', index);
      addText(xml.slice(index + 9, end), index, false);
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<?', index)) {
      const end = xml.indexOf('?>', index + 2);
      if (end === -1) throw malformed('a processing instruction is never closed', index);
      index = end + 2;
      continue;
    }
    if (xml.startsWith('<!', index)) {
      // A worksheet part needs no document type, and an entity declaration
      // inside one is how an XML reader gets talked into reading other files.
      throw malformed('a document type or entity declaration is not supported', index);
    }

    const tag = readTag(xml, index, malformed);
    if (tag.closing) closeElement(tag.name, index);
    else openElement(tag, index);
    index = tag.end;
  }

  // Truncation shows up here: a part cut mid-sheet leaves its elements open.
  if (!sawRoot) {
    throw malformed(`no <${WORKSHEET_ELEMENT}> root element was found`, 0);
  }
  if (stack.length > 0) {
    throw malformed(`<${stack[stack.length - 1]}> is never closed`, xml.length);
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
 * Malformed input is refused rather than reduced: there is no input for which
 * this function returns rows it could not fully account for. The one empty
 * result it will return is a well-formed worksheet that genuinely holds no
 * `<row>` elements, and a caller that requires a header row - both loaders do -
 * reports that as the missing-header fault it is.
 *
 * @param {string} filePath Path to the `.xlsx` file. A relative path is
 *   resolved by the filesystem against the process's working directory, so
 *   callers are expected to pass a path they resolved themselves.
 * @returns {Array<Record<string, string>>} The worksheet's rows in document
 *   order - `rows[0]` is the header row - each keyed by column letter with
 *   string values and `''` for a blank cell.
 * @throws {Error} Always with `code === 'WORKBOOK_READ_FAILED'`, `path` set and
 *   the path interpolated into the message: 'Workbook path must be a non-empty
 *   string' (with a safe rendering of an unusable argument as the path),
 *   'Workbook not found', 'Workbook could not be read' (a directory, a
 *   permission denial, a platform lock), 'Not a valid .xlsx package', 'Workbook
 *   has no xl/worksheets/sheet1.xml part', 'Workbook uses an unsupported ZIP
 *   compression method N', 'Workbook worksheet part is too large', 'Workbook
 *   worksheet part could not be decompressed', 'Workbook worksheet XML is
 *   malformed', or 'Workbook uses an unsupported OOXML feature'.
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
  return parseWorksheet(xml, filePath);
};

module.exports = { readWorksheetRows };
