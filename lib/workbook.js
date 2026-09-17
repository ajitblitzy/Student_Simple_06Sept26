'use strict';

/**
 * The OOXML (`.xlsx`) worksheet reader - the only place in this service where
 * ZIP or XML knowledge lives. Callers receive plain row objects and never see a
 * byte offset or a tag. It is built on `node:fs` and `node:zlib` alone: the ZIP
 * container is walked by hand and the worksheet XML is read by the single-pass
 * scanner further down this file.
 *
 * SUPPORTED SUBSET
 *   - Entries are DEFLATE-compressed (method 8) or stored (method 0), and
 *     `xl/worksheets/sheet1.xml` is resolved BY NAME: no entry position or
 *     ordering is assumed.
 *   - There is no `xl/sharedStrings.xml` part. Every text cell is
 *     `t="inlineStr"` carrying `<is><t>TEXT</t></is>`, so a reader written
 *     against a shared-string table would return blanks for every label and
 *     every value - the exact failure this module must not have.
 *   - Numeric cells carry `t="n"`, or no `t` at all, with `<v>N</v>`.
 *
 * FAIL CLOSED. Anything needing more than that subset is refused with a
 * path-bearing error rather than read into something plausible:
 *
 *   - `t="s"`, whose `<v>` is an index into a shared-string table this reader
 *     does not read, so returning it would print `'0'` where the sheet shows
 *     text.
 *   - Any other declared cell type (`b`, `d`, `e`, `str`), refused with the
 *     type and the cell named; the supported set is `inlineStr`, `n` and an
 *     absent `t`, which OOXML defines as numeric.
 *   - A formula cell: an `<f>` child means the stored `<v>` is a cached result
 *     this reader can neither recompute nor verify.
 *   - `<mergeCells>` metadata, whose blank continuation cells would otherwise
 *     read as ordinary empty values with nothing to show a merge produced them.
 *   - Malformed, truncated or unbalanced XML, so a half-written worksheet can
 *     never be mistaken for a sheet that legitimately holds fewer students.
 *   - A worksheet part declaring more than `MAX_WORKSHEET_BYTES`, refused
 *     before a byte of it is inflated.
 *   - A repeated attribute name: XML forbids one, and accepting the last copy
 *     would let a forged `r` or `t` claim a column or type the document also
 *     describes another way.
 *   - An entity reference this reader cannot account for: a bare or
 *     unterminated `&`, a name other than the five XML predefines, or a numeric
 *     reference to a code point XML does not permit.
 *
 * INTEGRITY, NOT MERELY STRUCTURE. A package can be well-formed and still not
 * be the package its own records describe, so four checks concern the bytes
 * rather than the container: the local header must agree with the selected
 * central record (name, method, relevant flags, sizes and checksum); the entry
 * data must hash to the recorded CRC-32, the only check that can see altered
 * content; nothing may follow the end of the DEFLATE stream, since trailing
 * bytes sit inside the declared compressed size where no bounds check notices
 * them; and the decoded bytes must be well-formed UTF-8, because a lenient
 * decode would replace an invalid sequence with U+FFFD in silence.
 *
 * Number formats, date serial numbers and cell styles are neither interpreted
 * nor refused: such a cell arrives as its raw stored string.
 *
 * CONTRACT. `readWorksheetRows(filePath)` returns the rows in document order -
 * `rows[0]` is the header - each keyed by column letter with string values and
 * `''` for a blank or missing cell; the export's own docblock carries the
 * worked example. Values stay strings because consumers only compare text, so
 * no number-formatting or locale decision is made for them, and `''` rather
 * than `undefined` keeps a blank key or activity cell an ordinary string check.
 *
 * FAILURES throw synchronously, always carrying `code ===
 * 'WORKBOOK_READ_FAILED'`, `path`, the offending path interpolated into
 * `message`, and any underlying error as `cause`. The read happens once while
 * the server is being constructed, so an unreadable workbook aborts
 * construction rather than degrading into empty rows. The path guarantee covers
 * an unusable ARGUMENT too: `42`, `null` or an object yields a `path` rendered
 * from the value's type alone, never by calling anything on the value, so a
 * hostile `toString` cannot hijack the diagnostic. This module never logs,
 * never writes to stdout and never calls `process.exit` - turning a failure
 * into process behaviour belongs to the `server.js` entrypoint alone.
 *
 * BOUNDED WORK. A workbook is read while the process is starting, so its cost
 * is bounded rather than trusted: the declared uncompressed size is refused
 * above `MAX_WORKSHEET_BYTES`, that same declaration is the `maxOutputLength`
 * handed to `inflateRawSync`, the inflated length is verified against it, and
 * the XML scan advances strictly forward with a capped element depth.
 *
 * The API is synchronous, holds no mutable module state, so concurrent calls
 * cannot interfere, and never writes a file - the workbooks are read-only.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

const ERROR_CODE = 'WORKBOOK_READ_FAILED';

/**
 * The worksheet part, resolved by name. Each package declares exactly one
 * sheet, so no content-type or relationship resolution is needed.
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
 * Bit 3 of an entry's general-purpose flags: the entry's CRC-32 and its two
 * sizes are not in the local header but in a data descriptor that FOLLOWS the
 * entry data, and the local header's three fields are written as zero.
 *
 * These packages never set it - all three committed workbooks carry flags `0`
 * in both headers - but a writer streaming into a non-seekable sink legally
 * does, and the central directory still holds the real values either way. So
 * the bit is not refused; it is what decides whether a zeroed local field is
 * lawful or a disagreement.
 */
const DATA_DESCRIPTOR_FLAG = 0x0008;

/**
 * The flag bits that must agree between the local header and the central
 * record, because each one changes how the entry data is read: bit 0 says the
 * bytes are encrypted, and bit 3 says the local size and checksum fields are
 * deliberately zero. The remaining bits describe compression tuning and text
 * encoding hints that do not affect this reader, so a difference in them is not
 * made a failure.
 */
const LOCAL_HEADER_FLAG_MASK = ENCRYPTED_ENTRY_FLAG | DATA_DESCRIPTOR_FLAG;

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

// The worksheet elements the scanner recognises by name.
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

const INLINE_STRING_TYPE = 'inlineStr';
const NUMBER_TYPE = 'n';
const SHARED_STRING_TYPE = 's';

/**
 * A complete cell reference - column letters then a row number, anchored at
 * both ends. A prefix match would accept `r="A-not-a-row"` as column `A` and
 * let a malformed reference populate or overwrite a legitimate column, so the
 * whole attribute must match. Three letters is the sheet maximum (`XFD`).
 */
const CELL_REFERENCE_PATTERN = /^([A-Za-z]{1,3})([1-9][0-9]*)$/;

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

/**
 * The five predefined XML entities, and the ONLY named references this reader
 * resolves. A worksheet part declares no DTD - one is refused outright further
 * down - so no other name is ever defined, and a reference to one is a fault in
 * the document rather than a name this reader happens not to know.
 */
const NAMED_ENTITIES = {
  amp: '&',
  apos: '\'',
  gt: '>',
  lt: '<',
  quot: '"'
};

/**
 * How many characters an entity reference's body may hold before the reference
 * is refused as malformed, counted between `&` and `;`.
 *
 * The longest legal body these documents can need is `#x10FFFF` at eight
 * characters, and 32 leaves room for the leading zeros a numeric reference may
 * lawfully carry. It is a BOUND, not a style rule: the scan looks for the
 * terminating `;` only inside this window, so text carrying many stray
 * ampersands costs one short search each instead of a walk to the end of the
 * part per ampersand.
 */
const MAX_ENTITY_BODY_LENGTH = 32;

/** A decimal character reference body, anchored: `#65` for `A`. */
const DECIMAL_REFERENCE_PATTERN = /^#([0-9]+)$/;

/** A hexadecimal character reference body, anchored: `#x41` or `#X41` for `A`. */
const HEXADECIMAL_REFERENCE_PATTERN = /^#[xX]([0-9a-fA-F]+)$/;

const UNICODE_MAX_CODE_POINT = 0x10ffff;
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;

/**
 * The only control characters XML 1.0 permits in a document: tab, line feed and
 * carriage return. Every other code point below U+0020 is forbidden, so a
 * numeric reference naming one - `&#0;` being the notable example - is refused
 * rather than resolved into a character no conforming document may hold.
 */
const XML_CONTROL_CODE_POINTS = new Set([0x09, 0x0a, 0x0d]);

/** The lowest code point XML permits outside the three controls above. */
const XML_FIRST_PRINTABLE_CODE_POINT = 0x20;

/** The two noncharacters that close the Basic Multilingual Plane; both forbidden. */
const BMP_NONCHARACTER_FIRST = 0xfffe;

/** The first code point above the Basic Multilingual Plane. */
const SUPPLEMENTARY_FIRST = 0x10000;

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
 * Builds the one error shape this module throws: `<summary>: <path>` with an
 * optional parenthesised detail, `code` and `path` set for programmatic
 * handling, and the underlying error kept as `cause` so nothing about the
 * diagnostic is discarded.
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

/**
 * Renders a 32-bit archive field as fixed-width hexadecimal, which is how a
 * checksum and a flag word are written everywhere else and the only form in
 * which two of them can be compared by eye in a log line.
 *
 * @param {number} value An unsigned 32-bit value read from the archive.
 * @returns {string} The value as `0x` followed by eight hex digits.
 */
const asHex32 = (value) => `0x${value.toString(16).padStart(8, '0')}`;

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
 * Reads the whole workbook into memory - these files are a few kilobytes and
 * are read once per process, so one synchronous read is simplest and cheapest.
 *
 * `ENOENT` becomes 'Workbook not found: <path>'; every other failure becomes
 * 'Workbook could not be read: <path> (<detail>)', which covers `EISDIR` for a
 * directory, `EACCES`/`EPERM` for permissions and `EBUSY` for a platform lock.
 * A read failure is never swallowed.
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
 * @returns {{method: number, flags: number, crc32: number, compressedSize: number,
 *   uncompressedSize: number, localHeaderOffset: number}|null} The worksheet
 *   entry as the DIRECTORY declares it - its compression method,
 *   general-purpose flags, CRC-32, sizes and local header offset - or `null`
 *   when this directory is intact but declares no worksheet part.
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
    // The checksum the archive recorded when the entry was written. It is read
    // here, with the rest of the record, because the central directory is the
    // authoritative index: `readWorksheetXml` verifies it against the bytes it
    // actually produced, which is what turns "the offsets held up" into "the
    // data is the data this archive says it is".
    const crc32 = buffer.readUInt32LE(at + 16);
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
      worksheet = { method, flags, crc32, compressedSize, uncompressedSize, localHeaderOffset };
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
 * @returns {{method: number, flags: number, crc32: number, compressedSize: number,
 *   uncompressedSize: number, localHeaderOffset: number}} The worksheet entry's
 *   compression method, general-purpose flags, recorded CRC-32, compressed and
 *   declared uncompressed sizes, and its local header offset.
 * @throws {Error} 'Workbook has no xl/worksheets/sheet1.xml part: <path>' when a
 *   candidate's directory is intact but carries no worksheet; 'Not a valid .xlsx
 *   package: <path>' with the walk's own detail when a directory does not hold
 *   up, and with 'no ZIP end-of-central-directory record was found' when no
 *   candidate validates at all.
 */
const locateWorksheetEntry = (buffer, filePath) => {
  let firstFailure = null;
  let sawIntactDirectory = false;
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
 * Locates the worksheet entry's data and proves the LOCAL header describes the
 * same entry the central record selected.
 *
 * WHY THE TWO HEADERS ARE COMPARED AT ALL. A ZIP stores each entry's metadata
 * twice, and the two copies are written independently: the local header sits in
 * front of the data and the central record sits in the directory this reader
 * resolves the entry from. Only the directory is authoritative for SIZES - that
 * is the long-standing reason this reader slices with the central values - but
 * nothing makes the two copies agree except the writer that produced them. A
 * crafted package can therefore point a well-formed central record at a local
 * header for something else entirely: another part's name, a different
 * compression method, or an entry the local header says is encrypted. Every one
 * of those reads bytes under a description the archive contradicts elsewhere,
 * which is exactly the "plausible but wrong" outcome this module refuses, so a
 * disagreement is a failure rather than a preference for one copy.
 *
 * WHICH FIELDS MUST AGREE, AND THE ONE LAWFUL DISAGREEMENT. The name, the
 * method and the flag bits of `LOCAL_HEADER_FLAG_MASK` must match outright. The
 * CRC-32 and the two sizes must match as well, UNLESS the local header sets the
 * data-descriptor bit - the streaming form, in which those three fields are
 * written as zero on purpose and the real values live in the central record. A
 * zeroed field is accepted only in that case, and only when it is zero; a
 * different non-zero value is a disagreement whichever bit is set.
 *
 * @param {Buffer} buffer The whole workbook.
 * @param {{method: number, flags: number, crc32: number, compressedSize: number,
 *   uncompressedSize: number, localHeaderOffset: number}} entry The worksheet
 *   entry as the central directory declares it.
 * @param {string} filePath The workbook path, for error messages.
 * @returns {number} The offset at which the entry's data begins - past the
 *   local header and its own variable-length name and extra fields.
 * @throws {Error} 'Not a valid .xlsx package: <path>' when the local header lies
 *   outside the file, carries the wrong signature, declares variable-length
 *   fields the file does not hold, or contradicts the central record.
 */
const locateLocalEntryData = (buffer, entry, filePath) => {
  const { method, flags, crc32, compressedSize, uncompressedSize, localHeaderOffset } = entry;

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

  const localFlags = buffer.readUInt16LE(localHeaderOffset + 6);
  const localMethod = buffer.readUInt16LE(localHeaderOffset + 8);
  const localCrc32 = buffer.readUInt32LE(localHeaderOffset + 14);
  const localCompressedSize = buffer.readUInt32LE(localHeaderOffset + 18);
  const localUncompressedSize = buffer.readUInt32LE(localHeaderOffset + 22);
  const nameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);

  const nameAt = localHeaderOffset + LOCAL_FILE_HEADER_SIZE;
  assertWithinBuffer(buffer, nameAt, nameLength, filePath, 'the worksheet local file name');
  const localName = buffer.toString('utf8', nameAt, nameAt + nameLength);

  /**
   * @param {string} detail How the two headers disagree.
   * @returns {Error} The package error to throw.
   */
  const disagrees = (detail) => createWorkbookError('Not a valid .xlsx package', filePath, detail);

  // The central record was selected by string equality with `WORKSHEET_PART`,
  // so comparing the local name against that constant IS comparing it against
  // the selected record's own name.
  if (localName !== WORKSHEET_PART) {
    throw disagrees(
      `the local file header at offset ${localHeaderOffset} names ` +
        `"${clipQuotedValue(localName)}" while the central directory declares that ` +
        `offset to be ${WORKSHEET_PART}`
    );
  }
  if (localMethod !== method) {
    throw disagrees(
      `${WORKSHEET_PART} declares compression method ${localMethod} in its local file ` +
        `header and ${method} in the central directory`
    );
  }
  if ((localFlags & LOCAL_HEADER_FLAG_MASK) !== (flags & LOCAL_HEADER_FLAG_MASK)) {
    throw disagrees(
      `${WORKSHEET_PART} declares general-purpose flags ${asHex32(localFlags)} in its ` +
        `local file header and ${asHex32(flags)} in the central directory`
    );
  }

  // The streaming form zeroes exactly these three local fields, so a zero is
  // read as "recorded in the data descriptor" only when that bit says so.
  const streamed = (localFlags & DATA_DESCRIPTOR_FLAG) !== 0;
  const zeroedByDescriptor = (local) => streamed && local === 0;

  if (localCrc32 !== crc32 && !zeroedByDescriptor(localCrc32)) {
    throw disagrees(
      `${WORKSHEET_PART} declares CRC-32 ${asHex32(localCrc32)} in its local file header ` +
        `and ${asHex32(crc32)} in the central directory`
    );
  }
  if (
    (localCompressedSize !== compressedSize && !zeroedByDescriptor(localCompressedSize)) ||
    (localUncompressedSize !== uncompressedSize && !zeroedByDescriptor(localUncompressedSize))
  ) {
    throw disagrees(
      `${WORKSHEET_PART} declares ${localCompressedSize} compressed and ` +
        `${localUncompressedSize} uncompressed bytes in its local file header, while ` +
        `the central directory declares ${compressedSize} and ${uncompressedSize}`
    );
  }

  const at = nameAt + nameLength + extraLength;
  assertWithinBuffer(buffer, at, compressedSize, filePath, 'the worksheet entry data');
  return at;
};

/**
 * Verifies the worksheet part's bytes against the checksum the archive recorded
 * for them, which is the one check that is about the DATA rather than about the
 * offsets that found it.
 *
 * Every structural check before this one proves the archive is self-consistent:
 * that the records fit, that the two headers agree, that the stream inflated to
 * the length it promised. None of them can tell whether the bytes themselves
 * are the bytes the writer wrote - a flipped bit in a name, an ID or an
 * activity produces a perfectly well-formed package holding altered content.
 * The CRC-32 is what closes that gap, and it is verified BEFORE the XML is
 * decoded so altered content is refused rather than parsed and served.
 *
 * @param {Buffer} content The worksheet part's uncompressed bytes.
 * @param {number} expected The CRC-32 the central directory recorded.
 * @param {string} filePath The workbook path, for error messages.
 * @returns {void}
 * @throws {Error} 'Not a valid .xlsx package: <path>' when the two differ, with
 *   both checksums named.
 */
const assertWorksheetChecksum = (content, expected, filePath) => {
  const actual = zlib.crc32(content);
  if (actual !== expected) {
    throw createWorkbookError(
      'Not a valid .xlsx package',
      filePath,
      `${WORKSHEET_PART} declares CRC-32 ${asHex32(expected)} and its ${content.length} ` +
        `bytes of data hash to ${asHex32(actual)}`
    );
  }
};

/**
 * Decodes the worksheet part as UTF-8, FAIL-CLOSED.
 *
 * `Buffer.prototype.toString('utf8')` is lossy by specification: a byte
 * sequence that is not valid UTF-8 is replaced with U+FFFD and the read
 * continues. For a document whose text IS the authoritative student name, ID
 * and activity, that is silent alteration of exactly the values this service
 * exists to report - `<t>` content holding one bad byte would arrive as a name
 * with a replacement character in it, and nothing anywhere would say so. So the
 * decode is strict instead: `TextDecoder` with `fatal: true` throws on the
 * first ill-formed sequence and the workbook is refused with its path named.
 *
 * A leading byte-order mark is consumed rather than refused - that is
 * `TextDecoder`'s default (`ignoreBOM` defaults to `false`, which means the
 * mark is honoured and removed) and it is correct: a BOM is encoding metadata,
 * not character data, and `toString('utf8')` used to leave it in the string
 * where it surfaced as text sitting outside the root element. None of the three
 * committed workbooks carries one.
 *
 * The decoder is constructed per call rather than held at module scope, which
 * keeps this module's documented "no mutable module state" property literally
 * true; the allocation happens twice per process, once per workbook read.
 *
 * @param {Buffer} content The worksheet part's uncompressed bytes.
 * @param {string} filePath The workbook path, for error messages.
 * @returns {string} The worksheet XML.
 * @throws {Error} 'Workbook worksheet part is not valid UTF-8: <path> (<detail>)'
 *   when the bytes are not well-formed UTF-8.
 */
const decodeWorksheetXml = (content, filePath) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (cause) {
    throw createWorkbookError(
      'Workbook worksheet part is not valid UTF-8',
      filePath,
      describeCause(cause),
      cause
    );
  }
};

/**
 * Inflates the worksheet entry, verifies it, and decodes it as UTF-8. Entry
 * data begins after the local header's own variable-length name and extra
 * fields, and every entry in these packages is DEFLATE (method 8); the stored
 * (method 0) branch is kept because it costs one comparison and a writer may
 * legitimately use it.
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
 * DECOMPRESSION IS ALSO EXACT. `rejectGarbageAfterEnd` makes zlib refuse bytes
 * that follow a complete DEFLATE stream instead of stopping quietly at its end:
 * without it, a crafted entry can carry a valid stream plus an arbitrary
 * appendix and still be read, so the bytes this reader accepted and the bytes
 * the archive's own records describe would not be the same span. The appendix
 * is inside the compressed size the directory declares, which is why no bounds
 * check can see it.
 *
 * @param {Buffer} buffer The whole workbook.
 * @param {{method: number, flags: number, crc32: number, compressedSize: number,
 *   uncompressedSize: number, localHeaderOffset: number}} entry The worksheet
 *   entry resolved from the central directory.
 * @param {string} filePath The workbook path, for error messages.
 * @returns {string} The worksheet XML.
 * @throws {Error} 'Not a valid .xlsx package: <path>' for a bad or truncated local
 *   header, a local header that contradicts the central record, a stored entry
 *   whose two sizes disagree, an inflated length that does not match the
 *   declaration, or data that does not match the recorded CRC-32; 'Workbook uses
 *   an unsupported ZIP compression method N: <path>' for any method other than
 *   stored or DEFLATE; 'Workbook worksheet part is too large: <path>' when the
 *   declared size exceeds the reader's ceiling; 'Workbook worksheet part could
 *   not be decompressed: <path> (<detail>)' when inflation fails, runs past the
 *   ceiling, or finds junk after the stream; and 'Workbook worksheet part is not
 *   valid UTF-8: <path> (<detail>)' when the decoded bytes are ill-formed.
 */
const readWorksheetXml = (buffer, entry, filePath) => {
  const { method, crc32, compressedSize, uncompressedSize } = entry;

  const at = locateLocalEntryData(buffer, entry, filePath);

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

  let content;
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
    content = buffer.subarray(at, at + compressedSize);
  } else {
    const raw = buffer.subarray(at, at + compressedSize);
    try {
      content = zlib.inflateRawSync(raw, {
        maxOutputLength: uncompressedSize,
        rejectGarbageAfterEnd: true
      });
    } catch (cause) {
      throw createWorkbookError(
        'Workbook worksheet part could not be decompressed',
        filePath,
        describeCause(cause),
        cause
      );
    }
    if (content.length !== uncompressedSize) {
      throw createWorkbookError(
        'Not a valid .xlsx package',
        filePath,
        `${WORKSHEET_PART} declares ${uncompressedSize} uncompressed bytes and ` +
          `inflated to ${content.length}`
      );
    }
  }

  assertWorksheetChecksum(content, crc32, filePath);
  return decodeWorksheetXml(content, filePath);
};

/**
 * Whether a code point is one XML 1.0 permits a document to contain - the
 * `Char` production - which is what a numeric character reference is checked
 * against before it is resolved.
 *
 * Three ranges are excluded and each exclusion matters here: the C0 controls
 * apart from tab, line feed and carriage return; the surrogate code points,
 * which are a UTF-16 encoding mechanism and not characters at all; and the two
 * noncharacters closing the Basic Multilingual Plane.
 *
 * @param {number} codePoint A Unicode code point taken from a character reference.
 * @returns {boolean} True when a conforming XML document may hold it.
 */
const isXmlCharacter = (codePoint) =>
  XML_CONTROL_CODE_POINTS.has(codePoint) ||
  (codePoint >= XML_FIRST_PRINTABLE_CODE_POINT && codePoint < SURROGATE_FIRST) ||
  (codePoint > SURROGATE_LAST && codePoint < BMP_NONCHARACTER_FIRST) ||
  (codePoint >= SUPPLEMENTARY_FIRST && codePoint <= UNICODE_MAX_CODE_POINT);

/**
 * Resolves the body of ONE entity reference - the characters between `&` and
 * `;` - or refuses it.
 *
 * There is no fall-through here on purpose. Anything that is not one of the
 * five predefined names or a numeric reference to a code point XML permits is a
 * fault in the document, and leaving it in the text as written would make an
 * authoritative value quietly wrong: a name stored as `Ren&eacute;e` would be
 * served with five stray characters in it, and `&#0;` would put a character in
 * a value that no conforming document may carry. Refusing is what makes a
 * corrupt part look corrupt.
 *
 * @param {string} body The characters between the `&` and the `;`.
 * @param {(detail: string, offset: number) => Error} malformed Builds the
 *   path-bearing malformed-XML error this function throws.
 * @param {number} offset Where the surrounding text begins, for the diagnostic.
 * @returns {string} The character the reference denotes.
 * @throws {Error} When the reference names nothing this reader defines, is not a
 *   syntactically valid numeric reference, or denotes a code point XML forbids.
 */
const resolveEntityReference = (body, malformed, offset) => {
  if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];

  const decimal = DECIMAL_REFERENCE_PATTERN.exec(body);
  const hexadecimal = decimal === null ? HEXADECIMAL_REFERENCE_PATTERN.exec(body) : null;
  if (decimal === null && hexadecimal === null) {
    throw malformed(
      `"&${clipQuotedValue(body)};" is not one of the five predefined XML entities ` +
        'and is not a numeric character reference',
      offset
    );
  }

  const codePoint = decimal === null
    ? Number.parseInt(hexadecimal[1], 16)
    : Number.parseInt(decimal[1], 10);
  if (!isXmlCharacter(codePoint)) {
    throw malformed(
      `"&${clipQuotedValue(body)};" refers to a code point XML does not permit in a ` +
        'document',
      offset
    );
  }
  return String.fromCodePoint(codePoint);
};

/**
 * Resolves every XML entity reference in extracted text, and REFUSES any `&`
 * that does not begin a valid one.
 *
 * The scan is single-pass and strictly forward: resolution continues after the
 * `;` of each reference and never re-reads what it produced, so an escaped
 * escape such as `&amp;lt;` resolves to the literal text `&lt;` rather than to
 * `<`. That property is the reason a document cannot smuggle markup through two
 * layers of escaping.
 *
 * FAIL-CLOSED, and worth saying why. XML gives `&` exactly one meaning - it
 * starts a reference - so a bare `&`, an unterminated reference and an
 * undefined name are all faults rather than text. Passing them through was the
 * quiet failure mode this reader must not have: the values in these documents
 * ARE the student names, IDs and activities the service reports, and a value
 * that arrives subtly altered is worse than a workbook that fails to load. The
 * three committed workbooks contain no `&` at all, so nothing legitimate here
 * depends on the lenient behaviour.
 *
 * @param {string} text Raw text taken from between two XML tags, or from inside
 *   an attribute's quotes.
 * @param {(detail: string, offset: number) => Error} malformed Builds the
 *   path-bearing malformed-XML error this function throws.
 * @param {number} offset Where that text begins in the decoded part, used only
 *   for the diagnostic.
 * @returns {string} The text with every entity reference resolved.
 * @throws {Error} When an `&` does not begin a complete, defined reference.
 */
const unescapeXml = (text, malformed, offset) => {
  let at = text.indexOf('&');
  if (at === -1) return text;

  let resolved = '';
  let from = 0;
  while (at !== -1) {
    resolved += text.slice(from, at);
    // The body is bounded, so the hunt for the terminating ';' searches a short
    // window rather than the rest of the part - which is what keeps text full
    // of stray ampersands linear instead of quadratic.
    const limit = Math.min(text.length, at + 1 + MAX_ENTITY_BODY_LENGTH + 1);
    const terminator = text.slice(at + 1, limit).indexOf(';');
    if (terminator === -1) {
      throw malformed(
        `"${clipQuotedValue(text.slice(at, limit))}" is not a complete XML entity ` +
          'reference',
        offset
      );
    }
    resolved += resolveEntityReference(text.slice(at + 1, at + 1 + terminator), malformed, offset);
    from = at + 1 + terminator + 1;
    at = text.indexOf('&', from);
  }
  return resolved + text.slice(from);
};

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
 * attribute is still parsed AND still validated - its name, its quoting and
 * its entity references all have to be well formed for the tag to be - and
 * only its resolved value is discarded rather than collected. Validating just
 * the consumed attributes would accept `s="&undefined;"` beside a `t` that had
 * passed, which is a broken document read as a sound one.
 *
 * A REPEATED ATTRIBUTE NAME IS REFUSED, which XML requires and this reader
 * needs for a sharper reason: `r` and `t` decide a cell's column and its type,
 * and a scanner that simply assigns as it goes keeps whichever copy came last.
 * `<c r="A1" r="B1">` would then write a forged value into column B while the
 * document also claims column A, with nothing in the output to show that two
 * answers existed. Every attribute name is checked, not only those two, because
 * a duplicate anywhere means the tag is not well formed.
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
  /**
   * The names already seen on this tag, tracked in two stages so the scan stays
   * allocation-free for the tags these worksheets actually hold: `firstName`
   * covers a tag with one attribute and the comparison against it covers a
   * second, and the `Set` is created only once a third arrives. A cell carries
   * `r`, `s` and `t` at most, so the allocation is rare and the check is exact
   * either way.
   */
  let firstName = '';
  let seenNames = null;

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

    if (firstName === '') {
      firstName = attribute;
    } else if (seenNames === null) {
      if (attribute === firstName) {
        throw malformed(`<${name}> carries attribute ${attribute} twice`, attributeStart);
      }
      seenNames = new Set([firstName, attribute]);
    } else if (seenNames.has(attribute)) {
      throw malformed(`<${name}> carries attribute ${attribute} twice`, attributeStart);
    } else {
      seenNames.add(attribute);
    }

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
    // EVERY attribute's value is resolved under the same fail-closed rules,
    // not only the two this reader keeps. An undefined or unterminated
    // reference makes the document not well formed wherever it sits, so a
    // scanner that validated only the attributes it consumes would accept
    // `s="&undefined;"` sitting beside a `t` it had just checked - and a
    // worksheet whose markup is broken would still be read as sound. The
    // resolved text is retained for `r` and `t` and discarded for the rest,
    // which is the same "parse it because its syntax must be valid, keep only
    // what is needed" rule the name and the quoting already follow.
    const value = unescapeXml(xml.slice(at, valueEnd), malformed, attributeStart);
    if (attribute === 'r') reference = value;
    else if (attribute === 't') type = value;
    at = valueEnd + 1;
  }

  return { name, closing, selfClosing, reference, type, end: at };
};

const readCellReference = (reference) => {
  const match = CELL_REFERENCE_PATTERN.exec(reference);
  if (match === null) return null;
  return { column: match[1].toUpperCase(), row: match[2] };
};

/**
 * Scans the worksheet XML once, left to right, and returns its rows.
 *
 * WHY A SINGLE FORWARD PASS RATHER THAN STRUCTURAL PATTERNS
 * Lazy patterns of the shape `/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g` read
 * these files correctly and carry two defects that no amount of tightening
 * fixes. First, `[\s\S]*?` backtracks: given repeated opening tags and no
 * closers, the matcher rescans the remainder for every one of them - a
 * quadratic cost paid while the server is starting. Second, a pattern that
 * matches what it can and ignores the rest cannot tell a complete sheet from a
 * truncated one: a part cut before its first `</row>` yields `[]` and one cut
 * after a row yields that row alone, so a half-written workbook becomes a sheet
 * with fewer students and nothing says so.
 *
 * The scanner avoids both by construction. `index` only ever moves forward,
 * each character is examined once, and `indexOf` always searches from the
 * current position, so the cost is one pass over the part whatever its content,
 * and a malformed part is rejected where the fault is met rather than
 * backtracked over. And because it tracks the open-element stack, a structure
 * that does not close is a fault it can SEE, which is what makes the failure
 * loud instead of silent.
 *
 * WHAT IT ACCEPTS
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
  const malformed = (detail, offset) =>
    createWorkbookError(
      'Workbook worksheet XML is malformed',
      filePath,
      `${detail} at character offset ${offset}`
    );

  const unsupported = (detail) =>
    createWorkbookError('Workbook uses an unsupported OOXML feature', filePath, detail);

  const rows = [];
  const stack = [];
  let sawRoot = false;
  let sawSheetData = false;
  let inSheetData = false;
  let row = null;
  let rowNumber = '';
  let rowColumns = null;
  let cell = null;
  let inText = false;
  let inValue = false;
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
    // CDATA content is literal by definition, so it is the one span that is not
    // entity-resolved; ordinary text is, under the fail-closed rules.
    const resolved = escaped ? unescapeXml(text, malformed, offset) : text;
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
 * Reads the worksheet of an `.xlsx` workbook and returns its rows. This is the
 * module's whole public contract.
 *
 * The read is synchronous and complete: the rows are a point-in-time snapshot,
 * and malformed input is refused rather than reduced, so there is no input for
 * which this function returns rows it could not fully account for and no
 * failure that yields an empty array instead of throwing - a caller
 * constructing the server aborts rather than serving blank data. The one empty
 * result it will return is a well-formed worksheet that genuinely holds no
 * `<row>` elements, which a caller requiring a header row reports as the
 * missing-header fault it is.
 *
 * @param {string} filePath Path to the `.xlsx` file. A relative path is
 *   resolved by the filesystem against the process's working directory, so
 *   callers are expected to pass a path they resolved themselves.
 * @returns {Array<Record<string, string>>} The worksheet's rows in document
 *   order - `rows[0]` is the header row - each keyed by column letter with
 *   string values and `''` for a blank cell.
 * @throws {Error} Always with `code === 'WORKBOOK_READ_FAILED'`, `path` set and
 *   the path interpolated into the message, for an unusable path argument, a
 *   file that cannot be read, a package that is not a valid `.xlsx` (including
 *   a local header contradicting the central record and data that does not
 *   match the recorded CRC-32), a missing worksheet part, an unsupported
 *   compression method, a worksheet part that is too large, will not
 *   decompress or is followed by junk, one that is not valid UTF-8, malformed
 *   worksheet XML, and an unsupported OOXML feature.
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
