'use strict';

/**
 * A zero-dependency reader for SpreadsheetML (ECMA-376 / ISO-IEC 29500)
 * workbook packages, built on `node:fs` and `node:zlib` alone.
 *
 * SCOPE
 * -----
 * A reader, not a spreadsheet library: it locates a part inside a package,
 * inflates it, and returns either that part's bytes or the cell values of a
 * worksheet part.
 *
 * There is NO write path here and none may be added, so no package part is
 * ever repacked and a package opened here cannot be corrupted here. Equally
 * absent, and deliberately so — sheet-name resolution through
 * `xl/workbook.xml`, style or theme parsing, date-serial conversion, any cache
 * or memoization (the caller owns caching), and any asynchronous variant.
 *
 * FAILS CLOSED, WITH A CODED REFUSAL FOR EVERY DECLARED LIMIT
 * -----------------------------------------------------------
 * A bespoke reader has to declare its limits, because silently mishandling an
 * unsupported package is worse than refusing it. Nothing here salvages,
 * repairs or approximates input it cannot read, and no partial or placeholder
 * data is ever returned with, or instead of, a refusal. Each refusal is an
 * `Error` whose `code` is one of the exact strings below and whose message
 * names the offending detail; the function that enforces a limit documents
 * that limit in full.
 *
 *   E_XLSX_UNSUPPORTED_COMPRESSION  A compression method other than DEFLATE
 *                (8) or STORED (0). Still-compressed bytes are never handed
 *                back as though they were XML, which would be a silent
 *                corruption.
 *   E_XLSX_UNSUPPORTED_FLAGS  A general-purpose bit flag other than 0. A set
 *                encryption bit (0x1) means the data cannot be read at all; a
 *                set data-descriptor bit (0x8) means the local header's size
 *                fields are zero and cannot be trusted, which would make the
 *                walk itself wrong.
 *   E_XLSX_UNSUPPORTED_SOURCE  A package that is not a REGULAR FILE. A
 *                directory, a pipe, a socket or a device is refused naming the
 *                kind: such a source has no size that can be bounded before it
 *                is read, and several of them report a size of zero and then
 *                yield bytes without end.
 *   E_XLSX_PART_NOT_FOUND  A requested part the package does not hold. Any
 *                part it does hold can be fetched by name.
 *   E_XLSX_SHARED_STRINGS_UNSUPPORTED  A `t="s"` cell. The cell types read are
 *                `t="inlineStr"` with a nested `<is><t>`, `t="n"`, and a cell
 *                with no `t` attribute at all, which ECMA-376 makes implicitly
 *                numeric; no string table is resolved here, so there is nothing
 *                to resolve a shared-string index against and a silently empty
 *                value would corrupt the data read through this module.
 *   E_XLSX_UNSUPPORTED_CELL_TYPE  EVERY OTHER DECLARED TYPE — `b`, `d`, `e`,
 *                `str`, or any string a package cares to write — and a numeric
 *                cell whose `<v>` holds something that is not a number. A cell
 *                is read only when this reader can honour the type it declares:
 *                returning the literal verbatim would let a substituted
 *                workbook state a Student ID as `t="str"` or as a non-numeric
 *                `t="n"`, and the key set that every submission is validated
 *                against is exactly one such column of one such workbook.
 *   E_XLSX_TRUNCATED  The DECLARED BYTES AND THE STRUCTURE THEY SHOULD HOLD
 *                DISAGREE: an entry's header, name or data running past the
 *                buffer, a package that does not begin with a local file
 *                header, an entry whose data will not inflate, an entry whose
 *                declared compressed size overshoots its DEFLATE stream and
 *                leaves trailing junk behind it, and a part whose XML ends
 *                inside a start tag or without its closing tag.
 *   E_XLSX_MALFORMED_XML  An interpreted part that is not valid UTF-8, or whose
 *                structure this reader relies on is broken: an attribute with
 *                no value, a stray delimiter where an attribute name belongs,
 *                an unquoted or repeated attribute, a raw `<` inside a tag or
 *                an attribute value, character data outside the root element,
 *                an end tag that closes nothing, a cell whose `r` reference is
 *                present but not a well-formed in-grid reference, two cells of
 *                one row landing in the same column, a row holding more cells
 *                than the grid has columns, a second `<sheetData>` element, an
 *                element this reader interprets appearing outside the parent
 *                the descent below expects it in, or a `t="inlineStr"` cell
 *                with no `<t>` element. The same code refuses a COMMENT, a
 *                CDATA SECTION, a markup DECLARATION such as `<!DOCTYPE`, and
 *                any PROCESSING INSTRUCTION other than one leading
 *                `<?xml …?>`: an interpreted part is validated as XML before a
 *                single element is matched, because this reader matches
 *                elements by scanning text, so markup inside a construct it
 *                does not interpret would be read as live structure — and a
 *                commented-out `<row>` holding `S999` is well-formed XML that
 *                every other tool ignores. Salvaging any of those erases,
 *                shifts or fabricates a value.
 *   E_XLSX_LIMIT_EXCEEDED  A package, a declared entry or an expanded part past
 *                its size ceiling (the ceilings are declared below). A package
 *                is measured before it is allocated for AND AGAIN AS IT IS READ
 *                — the size a descriptor reports is a claim, not a fact, so the
 *                read itself stops one byte past the ceiling and refuses — and
 *                a part is measured while it inflates, so neither a large file,
 *                a file that grows under the reader, nor a small
 *                highly-compressed one can exhaust the process.
 *
 * Every entry is checked as the chain is walked, not only the entry being
 * fetched: a package holding an entry this reader cannot read is not a package
 * it should report on, and the data-descriptor case makes the walk unreliable
 * in any case. So `listEntries` refuses exactly what `readEntry` refuses.
 *
 * STRUCTURE IS ALWAYS CHECKED; VALUES ARE READ ONLY WHERE ASKED FOR
 * -----------------------------------------------------------------
 * `readSheetRows` takes an optional list of column letters, and `readColumn`
 * always uses it. When a selection is given, every cell in the worksheet is
 * still walked and structurally validated — its start tag, its `r` reference
 * and its cell type — but the TEXT of a cell outside the selection is never
 * sliced, decoded or returned. A caller therefore reads one column without
 * materialising the values sitting beside it in the same rows. The two halves
 * of the guarantee are deliberately different: structure is a property of the
 * package and is enforced everywhere, while a value may be data the caller has
 * no business holding and is read only where the caller asked for it.
 *
 * THE VALUE CONTRACT
 * ------------------
 * Every cell value is returned as a STRING, numerics included, carrying the
 * digits the part records. String is the lossless contract: no float
 * round-trip and no locale in the way. A caller wanting a number converts it
 * explicitly, and a date serial stays the serial the package stored — nothing
 * here converts one to a date.
 *
 * MODULE CHARACTERISTICS
 * ----------------------
 * Synchronous (`openSync`, `readSync`, `inflateRawSync`), stateless (no
 * module-level cache, no memoization, no mutable module state), and free of
 * side effects: it never modifies a file, never logs, and reads no
 * environment variable.
 * Every call re-reads the file from disk, which is what lets the caller decide
 * what to cache and for how long. A caller needing two columns of one
 * worksheet should therefore ask for both in a single `readSheetRows` call
 * rather than calling `readColumn` twice, which would read, inflate and parse
 * the same package twice over. Element names are read unprefixed.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

/* ------------------------------------------------------------------------- *
 * ZIP local file header layout (APPNOTE.TXT 4.3.7). Named rather than inlined
 * so the walk below reads as the specification it implements.
 * ------------------------------------------------------------------------- */

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_FILE_HEADER_LENGTH = 30;
const SIGNATURE_LENGTH = 4;
const OFFSET_GENERAL_PURPOSE_FLAG = 6;
const OFFSET_COMPRESSION_METHOD = 8;
const OFFSET_COMPRESSED_SIZE = 18;
const OFFSET_FILENAME_LENGTH = 26;
const OFFSET_EXTRA_FIELD_LENGTH = 28;
const OFFSET_FILENAME = 30;

const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;

const FLAG_NONE = 0;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;

/* ------------------------------------------------------------------------- *
 * Resource ceilings.
 *
 * Both reads this module performs would be unbounded left to their defaults:
 * `readFileSync` allocates a file of any size at all, and `inflateRawSync`
 * produces output up to `buffer.kMaxLength`, which is how a few kilobytes of
 * crafted DEFLATE exhausts memory. The ceilings below bound each of them, which
 * is why the package is read by a bounded loop rather than by one
 * `readFileSync`, and why the bound is the ceiling rather than the size the
 * file claims to have.
 *
 * They bound the workload this reader accepts rather than describing a limit
 * of the SpreadsheetML format: a package, a declared entry or an expanded part
 * beyond one of them is refused with E_XLSX_LIMIT_EXCEEDED even when it is a
 * perfectly valid workbook. That is the intended trade — this reader holds a
 * whole package and a whole part in memory at once, so each ceiling is the
 * memory a single call may claim, and a workload of larger workbooks needs a
 * streaming reader rather than a larger number here.
 * ------------------------------------------------------------------------- */

/** A package file larger than this is refused before it is read into memory. */
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;

/** An entry declaring more compressed bytes than this is refused unread. */
const MAX_ENTRY_COMPRESSED_BYTES = 1024 * 1024;

/** Inflation stops and refuses at this many bytes of output for one part. */
const MAX_PART_BYTES = 4 * 1024 * 1024;

/* ------------------------------------------------------------------------- *
 * The refusal codes. These exact strings are the refusal contract: a caller
 * tells one refusal from another by `err.code`, never by message text, which
 * names the offending detail and is free to change. The constants themselves
 * are module-private; the strings they hold are what a caller depends on.
 * ------------------------------------------------------------------------- */

const CODE_UNSUPPORTED_COMPRESSION = 'E_XLSX_UNSUPPORTED_COMPRESSION';
const CODE_UNSUPPORTED_FLAGS = 'E_XLSX_UNSUPPORTED_FLAGS';
const CODE_UNSUPPORTED_SOURCE = 'E_XLSX_UNSUPPORTED_SOURCE';
const CODE_PART_NOT_FOUND = 'E_XLSX_PART_NOT_FOUND';
const CODE_SHARED_STRINGS_UNSUPPORTED = 'E_XLSX_SHARED_STRINGS_UNSUPPORTED';
const CODE_UNSUPPORTED_CELL_TYPE = 'E_XLSX_UNSUPPORTED_CELL_TYPE';
const CODE_TRUNCATED = 'E_XLSX_TRUNCATED';
const CODE_MALFORMED_XML = 'E_XLSX_MALFORMED_XML';
const CODE_LIMIT_EXCEEDED = 'E_XLSX_LIMIT_EXCEEDED';

/* ------------------------------------------------------------------------- *
 * Error codes raised by the runtime, translated into the refusals above so no
 * caller ever has to match on a zlib or encoding failure of its own.
 * ------------------------------------------------------------------------- */

const RUNTIME_OUTPUT_TOO_LARGE = 'ERR_BUFFER_TOO_LARGE';
const RUNTIME_TRAILING_JUNK = 'ERR_TRAILING_JUNK_AFTER_STREAM_END';

/* SpreadsheetML vocabulary this reader recognizes. */

const CELL_TYPE_INLINE_STRING = 'inlineStr';
const CELL_TYPE_SHARED_STRING = 's';
const CELL_TYPE_NUMBER = 'n';
const ELEMENT_SHEET_DATA = 'sheetData';
const ELEMENT_ROW = 'row';
const ELEMENT_CELL = 'c';
const ELEMENT_VALUE = 'v';
const ELEMENT_TEXT = 't';
const ELEMENT_INLINE_STRING = 'is';
const ELEMENT_RICH_TEXT_RUN = 'r';

/* The lexical space of a numeric cell, which is the xsd:double form ECMA-376
 * writes: an optional sign, digits with an optional fraction, and an optional
 * exponent. `INF`, `-INF` and `NaN` are part of xsd:double and are deliberately
 * NOT accepted — no grid cell legitimately holds one, and accepting them would
 * hand a caller a string that looks like a label.
 *
 * The check exists because a numeric cell's text is returned VERBATIM (see THE
 * VALUE CONTRACT below), so without it `<c r="A2" t="n"><v>S999</v></c>` hands
 * back `'S999'` as faithfully as it hands back `'20'`. */
const NUMERIC_VALUE_PATTERN = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/* The elements whose position this reader depends on, and the parents ECMA-376
 * puts them under. The descent in `readSheetRows` finds each of them by
 * scanning the span of its parent, so an element of one of these names sitting
 * anywhere else is either meaningless to the reader or — the case that matters
 * — a value hiding where the scan will find it and attribute it to the wrong
 * place. `is` and `r` both appear for `<t>`: `<is><t>` is the plain inline
 * string these workbooks write, and `<is><r><t>` is the rich-text form whose
 * runs make up one logical value. */
const INTERPRETED_ELEMENT_PARENTS = new Map([
  [ELEMENT_ROW, [ELEMENT_SHEET_DATA]],
  [ELEMENT_CELL, [ELEMENT_ROW]],
  [ELEMENT_VALUE, [ELEMENT_CELL]],
  [ELEMENT_TEXT, [ELEMENT_INLINE_STRING, ELEMENT_RICH_TEXT_RUN]],
]);

/* Lexical constructs an interpreted part may not contain, with the leading XML
 * declaration handled separately because every part is entitled to one. */
const XML_COMMENT_OPEN = '<!--';
const XML_CDATA_OPEN = '<![CDATA[';
const XML_DECLARATION_OPEN = '<?xml';
const XML_NAME_START_PATTERN = /[A-Za-z_:]/;
const XML_NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9._:-]*$/;

/* The XML declaration, as XML 1.0 section 2.8 defines it and nothing wider:
 * `version` then an optional `encoding` then an optional `standalone`, in that
 * order, each value quoted, with the value sets the specification fixes. The
 * whitespace class is XML's own four characters rather than `\s`, which would
 * admit Unicode spaces no XML processor accepts.
 *
 * It is matched STRICTLY because the declaration is the one region this
 * reader skips: a permissive "everything up to the first ?>" would leave a
 * pseudo-attribute free to carry `<sheetData>…<t>S999</t>…</sheetData>`, which
 * the element matching would then find and read as the worksheet's real rows.
 * A declaration matching this pattern cannot contain `<` at all. */
const XML_WHITESPACE_CLASS = '[ \\t\\r\\n]';
const XML_DECLARATION_PATTERN = new RegExp(
  `^<\\?xml${XML_WHITESPACE_CLASS}+version${XML_WHITESPACE_CLASS}*=${XML_WHITESPACE_CLASS}*("1\\.[0-9]+"|'1\\.[0-9]+')` +
    `(?:${XML_WHITESPACE_CLASS}+encoding${XML_WHITESPACE_CLASS}*=${XML_WHITESPACE_CLASS}*("[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?` +
    `(?:${XML_WHITESPACE_CLASS}+standalone${XML_WHITESPACE_CLASS}*=${XML_WHITESPACE_CLASS}*("(?:yes|no)"|'(?:yes|no)'))?` +
    `${XML_WHITESPACE_CLASS}*\\?>$`,
  'u'
);

/** How much of an offending cell value a refusal message may quote. */
const MAX_MESSAGE_VALUE_LENGTH = 40;

/* Lexical constants for the XML scan and the column-letter arithmetic. */

const XML_WHITESPACE = ' \t\n\r';
const MAX_CODE_POINT = 0x10ffff;
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;
const ALPHABET_LENGTH = 26;
const CHAR_CODE_UPPERCASE_A = 65;
const MAX_COLUMN_LETTERS = 3;

/* Column letters are matched as ASCII and case-insensitively, against the
 * ORIGINAL input: `String.prototype.toUpperCase` folds several non-ASCII
 * letters onto ASCII ones — U+0131 DOTLESS I becomes `I`, U+017F LONG S
 * becomes `S` — so validating the folded form would admit a column the caller
 * never wrote. Three letters is only the shape; the real bound is the
 * ECMA-376 grid, whose last column is XFD at zero-based index 16383, so
 * `XFE` through `ZZZ` match the shape and are still refused. */
const ASCII_COLUMN_LETTERS_PATTERN = /^[A-Za-z]{1,3}$/;
const LAST_COLUMN_LETTERS = 'XFD';
const MAX_COLUMN_INDEX = 16383;

/* A cell reference names a column and a row, and BOTH halves are bounded: the
 * grid ends at XFD and at row 1048576. The row is matched with no leading zero
 * because a writer emits `A1` rather than `A01`, so `A0` and `A01` are as
 * malformed as `A` alone. Nothing here interprets the row number — rows are
 * returned in the order their elements appear — but a reference this reader
 * calls well formed has to actually be one. */
const CELL_REFERENCE_PATTERN = /^([A-Za-z]{1,3})([1-9][0-9]*)$/;
const MAX_ROW_NUMBER = 1048576;

/* An attribute name must be an XML Name: a letter, `_` or `:` first, then
 * letters, digits, `.`, `-`, `_` or `:`. The worksheet parts here carry `r`,
 * `s`, `t`, `spans`, `customFormat`, `ht` and namespace-prefixed names such as
 * `x14ac:dyDescent`, all of which match. `1bad` does not, and accepting it
 * would mean reading a tag this reader cannot claim to understand. */
const XML_ATTRIBUTE_NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9._:-]*$/;
const XML_ENTITY_PATTERN = /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g;
const NAMED_XML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/* ------------------------------------------------------------------------- *
 * Errors
 * ------------------------------------------------------------------------- */

/**
 * Builds a refusal carrying one of the declared codes. Returned rather than
 * thrown so each call site reads as a `throw` of `refuse`, keeping the control
 * flow obvious at the point the package is rejected.
 *
 * THE DIAGNOSTIC CONTRACT. Every refusal carries a frozen `diagnostic` beside
 * its `code` and `message`, and that object — never the message — is what a
 * caller may act on programmatically. The split is deliberate: `message`
 * names the offending detail, so it holds the package path, the entry name or
 * the part listing, which makes it a diagnosis for a person and unstable by
 * design. `diagnostic` is data:
 *
 *   reason  A stable lower-snake-case token naming WHICH refusal this is,
 *           finer-grained than `code`, which groups conditions: several
 *           distinct malformations share `E_XLSX_MALFORMED_XML`, and the token
 *           is what tells them apart. A token is part of this module's
 *           contract, so renaming one is a contract change and shows up in
 *           this file's diff. A caller that instead recovered the same
 *           distinction by searching `message` for a phrase would lose it
 *           silently the next time a sentence was reworded.
 *   detail  Always `null` here. The field exists so one shape travels the
 *           whole chain: `activity-store.js` fills it with this module's
 *           `code` when it wraps a refusal of ours. A zlib failure is folded
 *           into `message` rather than re-exposed, so there is nothing else to
 *           put in it.
 *   at      The byte offset or position the refusal names, or `null`.
 *   number  The bounded ZIP field or size the refusal rejected — a compression
 *           method, general-purpose flag bits, a declared size past a ceiling
 *           — or `null`.
 *
 * Every value in it is either a token of this file or a bounded number that
 * describes where or how much — a parser position, a byte offset, a ZIP header
 * field, a declared size. None of them is sliced out of the package's text, so
 * a caller that logs the whole object still writes no path and no cell value
 * anywhere.
 *
 * @param {string} code One of the CODE_* constants above.
 * @param {string} message Names the offending detail.
 * @param {string} reason The stable token for this refusal.
 * @param {number|null} [at] A byte offset or position, where one applies.
 * @param {number|null} [number] A rejected ZIP field or size, where one
 *   applies.
 * @returns {Error} An error carrying `code` and a frozen `diagnostic`.
 */
function refuse(code, message, reason, at = null, number = null) {
  const error = new Error(message);
  error.code = code;
  error.diagnostic = Object.freeze({ reason, detail: null, at, number });
  return error;
}

/**
 * Describes a rejected argument without stringifying a value that may be huge
 * or may throw from its own `toString`.
 *
 * @param {unknown} value The offending argument.
 * @returns {string} A short, safe description.
 */
function describeValue(value) {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return 'an empty string';
  }
  return typeof value;
}

/**
 * Guards a required string argument. An argument fault is a programmer error
 * rather than a property of the package, so it is a TypeError and carries none
 * of the declared XLSX refusal codes.
 *
 * @param {unknown} value The argument to check.
 * @param {string} parameterName Name used in the message.
 * @returns {string} `value`, once proven to be a non-empty string.
 */
function requireNonEmptyString(value, parameterName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      `xlsx-read: ${parameterName} must be a non-empty string; received ${describeValue(value)}`
    );
  }
  return value;
}

/* ------------------------------------------------------------------------- *
 * Column letters
 * ------------------------------------------------------------------------- */

/**
 * Normalizes a caller-supplied column letter to the uppercase form used as an
 * object key throughout this module.
 *
 * The letters are validated BEFORE the case fold, and the resulting index is
 * checked against the last column of the ECMA-376 grid, so the accepted set
 * is exactly the A-to-XFD range this function's message promises. A column
 * outside it is a caller fault rather than a property of a package, so it is a
 * TypeError and carries none of the declared XLSX refusal codes.
 *
 * @param {unknown} columnLetter For example `'A'`, `'c'`, or `'AA'`.
 * @returns {string} The uppercase letters.
 * @throws {TypeError} When the value is not 1 to 3 ASCII letters naming a
 *   column from A to XFD.
 */
function normalizeColumnLetter(columnLetter) {
  requireNonEmptyString(columnLetter, 'columnLetter');
  if (
    !ASCII_COLUMN_LETTERS_PATTERN.test(columnLetter) ||
    columnIndexFromLetters(columnLetter.toUpperCase()) > MAX_COLUMN_INDEX
  ) {
    throw new TypeError(
      `xlsx-read: columnLetter must be 1 to ${MAX_COLUMN_LETTERS} ASCII letters naming a column from A to ${LAST_COLUMN_LETTERS}; received ${JSON.stringify(columnLetter)}`
    );
  }
  return columnLetter.toUpperCase();
}

/**
 * Normalizes the optional column selection `readSheetRows` accepts.
 *
 * `null` or `undefined` selects every column. An array names the columns whose
 * values may be read; an empty array is a caller fault rather than a request
 * for nothing, because a row object with no keys is never what a caller wants
 * and silently returning one would hide the mistake.
 *
 * @param {unknown} columnLetters `null`, `undefined`, or an array of letters.
 * @returns {Set<string>|null} The uppercase letters, or null for every column.
 * @throws {TypeError} When the value is neither of those shapes.
 */
function normalizeColumnSelection(columnLetters) {
  if (columnLetters === null || columnLetters === undefined) {
    return null;
  }
  if (!Array.isArray(columnLetters) || columnLetters.length === 0) {
    throw new TypeError(
      `xlsx-read: columnLetters must be null or a non-empty array of column letters; received ${Array.isArray(columnLetters) ? 'an empty array' : describeValue(columnLetters)}`
    );
  }
  return new Set(columnLetters.map((letter) => normalizeColumnLetter(letter)));
}

/**
 * Converts column letters to a zero-based index: A -> 0, Z -> 25, AA -> 26.
 *
 * @param {string} letters Uppercase column letters.
 * @returns {number} The zero-based column index.
 */
function columnIndexFromLetters(letters) {
  let index = 0;
  for (let position = 0; position < letters.length; position += 1) {
    const ordinal = letters.charCodeAt(position) - CHAR_CODE_UPPERCASE_A + 1;
    index = index * ALPHABET_LENGTH + ordinal;
  }
  return index - 1;
}

/**
 * The inverse of columnIndexFromLetters. Needed only for the ECMA-376 rule
 * that a cell without an `r` attribute occupies the next column in its row;
 * without it such a cell would be dropped, which is a silent data loss.
 *
 * @param {number} index Zero-based column index.
 * @returns {string} The uppercase column letters.
 */
function lettersFromColumnIndex(index) {
  let remaining = index + 1;
  let letters = '';
  while (remaining > 0) {
    const ordinal = (remaining - 1) % ALPHABET_LENGTH;
    letters = String.fromCharCode(CHAR_CODE_UPPERCASE_A + ordinal) + letters;
    remaining = Math.floor((remaining - 1) / ALPHABET_LENGTH);
  }
  return letters;
}

/**
 * Extracts the column letters from a cell reference such as `A1` or `AA11`.
 *
 * The reference is matched as written, before any case fold, for the reason
 * `normalizeColumnLetter` documents, and the column it names must lie within
 * the grid. The row component must be digits but is not otherwise
 * interpreted: rows are returned in the order their `<row>` elements appear,
 * so nothing here depends on the number.
 *
 * Returning null means the reference cannot be trusted, and the caller refuses
 * the package rather than guessing a column for it — a malformed reference
 * treated as an absent one lands the value in whatever column happens to come
 * next, which is how a key or a label silently moves.
 *
 * @param {string} reference The value of a cell's `r` attribute.
 * @returns {string|null} The uppercase column letters, or null when the
 *   reference is not a well-formed reference inside the grid — which means the
 *   column past XFD, the row zero or past 1048576, or the shape wrong.
 */
function columnLettersFromCellReference(reference) {
  const match = CELL_REFERENCE_PATTERN.exec(reference);
  if (match === null) {
    return null;
  }
  const letters = match[1].toUpperCase();
  if (columnIndexFromLetters(letters) > MAX_COLUMN_INDEX) {
    return null;
  }
  /* A digit run long enough to lose precision still fails the comparison,
   * because anything above the grid's last row is out of range whatever its
   * exact value. */
  const rowNumber = Number.parseInt(match[2], 10);
  return rowNumber > MAX_ROW_NUMBER ? null : letters;
}

/* ------------------------------------------------------------------------- *
 * XML text
 * ------------------------------------------------------------------------- */

/**
 * Decodes the five predefined XML entities and numeric character references.
 *
 * A value written with an entity or a character reference means the character
 * that reference stands for, so handing the reference back verbatim would
 * return a string the package does not hold — a raw `&amp;` surfacing in a
 * cell value is a silent data bug. An unrecognized entity or an out-of-range
 * code point is left verbatim rather than dropped, so nothing disappears
 * without a trace.
 *
 * @param {string} text Raw XML character data.
 * @returns {string} The decoded text.
 */
function decodeXmlText(text) {
  if (!text.includes('&')) {
    return text;
  }
  return text.replace(XML_ENTITY_PATTERN, (match, decimal, hexadecimal, name) => {
    if (decimal !== undefined) {
      return codePointToString(Number.parseInt(decimal, 10), match);
    }
    if (hexadecimal !== undefined) {
      return codePointToString(Number.parseInt(hexadecimal, 16), match);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_XML_ENTITIES, name)
      ? NAMED_XML_ENTITIES[name]
      : match;
  });
}

/**
 * Renders a numeric character reference, refusing lone surrogates and
 * out-of-range values by leaving the reference as written.
 *
 * @param {number} codePoint The parsed code point.
 * @param {string} original The reference exactly as it appeared.
 * @returns {string} The character, or `original` when it cannot be rendered.
 */
function codePointToString(codePoint, original) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > MAX_CODE_POINT) {
    return original;
  }
  if (codePoint >= SURROGATE_FIRST && codePoint <= SURROGATE_LAST) {
    return original;
  }
  return String.fromCodePoint(codePoint);
}

/* ------------------------------------------------------------------------- *
 * Lexical validation
 *
 * The element matching below scans TEXT. That is what keeps the walk cheap and
 * free of substrings, and it is sound for exactly one class of document: one
 * whose markup-looking text IS markup. XML offers three ways to write text that
 * looks like markup and is not — a comment, a CDATA section and a processing
 * instruction — plus a fourth, a raw `<` inside a tag, which is not well formed
 * but which a lenient scan would still walk over. In all four a crafted
 * `<row><c r="A2" t="inlineStr"><is><t>S999</t></is></c></row>` would be read
 * as a live row while every conforming parser treated it as inert text, and one
 * fabricated row in `student_details.xlsx` column A is one fabricated member of
 * the key set that authorizes submissions.
 *
 * So an interpreted part is validated ONCE, up front, and refused if it holds
 * any of them. Refusing rather than skipping is deliberate: skipping needs the
 * same lexical bookkeeping in every one of the five places this module searches
 * for an element, and a package carrying a comment inside its worksheet was not
 * written by anything this reader claims to read. The same pass settles the
 * two structural properties the span descent silently assumes — that tags
 * balance, and that a `<row>`, `<c>`, `<v>` or `<t>` element sits under the
 * parent the descent expects — because an element found in the wrong place is a
 * value attributed to the wrong cell.
 *
 * No cell text is sliced or decoded here. The pass looks at tag internals and
 * at the characters between elements; a cell's value is still read only where
 * the caller asked for it.
 * ------------------------------------------------------------------------- */

/**
 * Validates an interpreted part as XML, before a single element is matched.
 *
 * The index it returns is where the part's interpreted content begins — just
 * past the XML declaration, if there is one. Element matching starts THERE
 * rather than at zero, so no search ever re-enters the one region this pass
 * consumed whole instead of walking.
 *
 * @param {string} xml The decoded part.
 * @param {string} partName Part name, for the refusal messages.
 * @param {string} filePath Package path, for the refusal messages.
 * @returns {number} The index at which interpreted content begins.
 * @throws {Error} E_XLSX_MALFORMED_XML for a comment, a CDATA section, a
 *   markup declaration, a malformed or over-permissive XML declaration, a
 *   processing instruction, a raw `<` inside a tag, character data outside the
 *   root element, a second root, a second `<sheetData>`, an end tag that
 *   closes nothing, or an interpreted element under an unexpected parent;
 *   E_XLSX_TRUNCATED when the part ends with a tag or an element unclosed.
 */
function validateInterpretedStructure(xml, partName, filePath) {
  const contentStart = consumeXmlDeclaration(xml, partName, filePath);
  let index = contentStart;
  const open = [];
  let roots = 0;
  let sheetDataElements = 0;

  while (index < xml.length) {
    const tagStart = xml.indexOf('<', index);
    if (tagStart === -1) {
      requireNoCharacterDataOutsideRoot(xml, index, xml.length, open, partName, filePath);
      break;
    }
    requireNoCharacterDataOutsideRoot(xml, index, tagStart, open, partName, filePath);

    const marker = xml[tagStart + 1];
    if (marker === '!') {
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} holds ${describeMarkupConstruct(xml, tagStart)} at offset ${tagStart}, whose content this reader will not interpret as markup and will not skip past either`,
        'xml_markup_construct_unsupported'
      );
    }
    if (marker === '?') {
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} holds a processing instruction at offset ${tagStart}; only a leading XML declaration is accepted`,
        'xml_processing_instruction'
      );
    }
    if (marker === '/') {
      index = consumeEndTag(xml, tagStart, open, partName, filePath);
      continue;
    }

    const tag = consumeStartTagShape(xml, tagStart, partName, filePath);
    if (open.length === 0) {
      roots += 1;
      if (roots > 1) {
        throw refuse(
          CODE_MALFORMED_XML,
          `xlsx-read: part ${partName} of ${filePath} holds a second root element <${tag.name}> at offset ${tagStart}`,
          'xml_second_root_element'
        );
      }
    }
    if (tag.name === ELEMENT_SHEET_DATA) {
      sheetDataElements += 1;
      if (sheetDataElements > 1) {
        // The descent takes the FIRST `<sheetData>`, so a second one is a
        // second set of rows that either shadows the real one or is ignored.
        // Which of those it is depends on document order, which is exactly the
        // kind of thing a reader must not decide silently.
        throw refuse(
          CODE_MALFORMED_XML,
          `xlsx-read: part ${partName} of ${filePath} holds more than one <${ELEMENT_SHEET_DATA}> element, so which one holds its rows is undefined`,
          'xml_sheet_data_repeated'
        );
      }
    }
    requireExpectedParent(tag.name, open, tagStart, partName, filePath);
    if (!tag.selfClosing) {
      open.push(tag.name);
    }
    index = tag.end;
  }

  if (open.length > 0) {
    throw refuse(
      CODE_TRUNCATED,
      `xlsx-read: part ${partName} of ${filePath} ends with its <${open[open.length - 1]}> element unclosed`,
      'xml_element_unclosed'
    );
  }
  return contentStart;
}

/**
 * Consumes a leading XML declaration, which every part is entitled to, and
 * holds it to the grammar rather than skipping to the first `?>`.
 *
 * This is the one region of a part the validation below does not walk element
 * by element, which makes it the one place markup could otherwise hide: a
 * lenient skip would accept `<?xml version="1.0" hidden="<sheetData>…"?>` and
 * leave that `<sheetData>` for the element matching to find and read as the
 * worksheet's rows. So the whole declaration is matched against
 * XML_DECLARATION_PATTERN, which admits only `version`, `encoding` and
 * `standalone` with quoted values and therefore cannot contain `<`. A
 * declaration whose terminating `?>` sits inside a quoted value fails the same
 * pattern, because the region up to the first `?>` is then not a declaration.
 *
 * `<?xml` followed by anything other than whitespace — `<?xml-stylesheet`, for
 * instance — is a processing instruction rather than a declaration, and is
 * left for the scan to refuse as one.
 *
 * @param {string} xml The decoded part.
 * @param {string} partName Part name, for the refusal message.
 * @param {string} filePath Package path, for the refusal message.
 * @returns {number} The index just past the declaration, or 0.
 * @throws {Error} E_XLSX_TRUNCATED when the declaration never ends, or
 *   E_XLSX_MALFORMED_XML when it is not a well-formed XML declaration.
 */
function consumeXmlDeclaration(xml, partName, filePath) {
  if (!xml.startsWith(XML_DECLARATION_OPEN)) {
    return 0;
  }
  const following = xml[XML_DECLARATION_OPEN.length];
  if (following !== undefined && !XML_WHITESPACE.includes(following)) {
    return 0;
  }
  const end = xml.indexOf('?>', XML_DECLARATION_OPEN.length);
  if (end === -1) {
    throw refuse(
      CODE_TRUNCATED,
      `xlsx-read: part ${partName} of ${filePath} ends inside its XML declaration`,
      'xml_declaration_truncated'
    );
  }
  const declarationEnd = end + 2;
  if (!XML_DECLARATION_PATTERN.test(xml.slice(0, declarationEnd))) {
    throw refuse(
      CODE_MALFORMED_XML,
      `xlsx-read: part ${partName} of ${filePath} begins with something that is not a well-formed XML declaration; only version, encoding and standalone are permitted, in that order, with quoted values`,
      'xml_declaration_malformed'
    );
  }
  return declarationEnd;
}

/**
 * Names the `<!`-introduced construct at an offset, for the refusal message.
 *
 * @param {string} xml The decoded part.
 * @param {number} tagStart Index of the `<`.
 * @returns {string} A short description, with an article.
 */
function describeMarkupConstruct(xml, tagStart) {
  if (xml.startsWith(XML_COMMENT_OPEN, tagStart)) {
    return 'an XML comment';
  }
  if (xml.startsWith(XML_CDATA_OPEN, tagStart)) {
    return 'a CDATA section';
  }
  return 'a markup declaration';
}

/**
 * Refuses character data outside the root element, and tolerates whitespace.
 *
 * Text between elements is ordinary once a root is open — it is the cell
 * content this reader reads elsewhere — so the check applies only at depth
 * zero, where XML permits nothing but whitespace. It walks by index rather
 * than slicing, so no run of text is copied to be inspected.
 *
 * @param {string} xml The decoded part.
 * @param {number} from First index to inspect.
 * @param {number} to One past the last index to inspect.
 * @param {string[]} open The elements currently open.
 * @param {string} partName Part name, for the refusal message.
 * @param {string} filePath Package path, for the refusal message.
 * @returns {void}
 * @throws {Error} E_XLSX_MALFORMED_XML for non-whitespace outside the root.
 */
function requireNoCharacterDataOutsideRoot(xml, from, to, open, partName, filePath) {
  if (open.length > 0) {
    return;
  }
  for (let at = from; at < to; at += 1) {
    if (!XML_WHITESPACE.includes(xml[at])) {
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} holds character data outside its root element at offset ${at}`,
        'xml_character_data_outside_root'
      );
    }
  }
}

/**
 * Reads a start tag's SHAPE — its name, whether it closes itself, and where it
 * ends — without interpreting its attributes.
 *
 * Attributes are deliberately not validated here: `parseStartTag` does that,
 * with the strictness its own refusals document, for the tags this reader
 * actually interprets. What this function must get exactly right is the END of
 * the tag, because everything after it is classified relative to that point.
 * Hence the quote awareness — an attribute value may legitimately contain `>` —
 * and hence the refusal of a raw `<` anywhere inside the tag: XML forbids it in
 * an attribute value, and tolerating it would leave markup hiding in a place
 * the element matching below would find and treat as real.
 *
 * @param {string} xml The decoded part.
 * @param {number} tagStart Index of the `<`.
 * @param {string} partName Part name, for the refusal messages.
 * @param {string} filePath Package path, for the refusal messages.
 * @returns {{name: string, selfClosing: boolean, end: number}}
 * @throws {Error} E_XLSX_MALFORMED_XML for a bad element name or a raw `<`,
 *   E_XLSX_TRUNCATED when the tag never ends.
 */
function consumeStartTagShape(xml, tagStart, partName, filePath) {
  const nameStart = tagStart + 1;
  if (nameStart >= xml.length) {
    throw refuse(
      CODE_TRUNCATED,
      `xlsx-read: part ${partName} of ${filePath} ends with an unterminated "<" at offset ${tagStart}`,
      'xml_tag_unterminated'
    );
  }
  if (!XML_NAME_START_PATTERN.test(xml[nameStart])) {
    throw refuse(
      CODE_MALFORMED_XML,
      `xlsx-read: part ${partName} of ${filePath} has ${JSON.stringify(xml[nameStart])} where an element name belongs at offset ${nameStart}`,
      'xml_element_name_invalid'
    );
  }

  let index = nameStart;
  while (index < xml.length && !isTagNameBoundary(xml[index])) {
    index += 1;
  }
  const name = xml.slice(nameStart, index);
  if (!XML_NAME_PATTERN.test(name)) {
    throw refuse(
      CODE_MALFORMED_XML,
      `xlsx-read: part ${partName} of ${filePath} has ${JSON.stringify(name)} where an XML element name belongs at offset ${nameStart}`,
      'xml_element_name_invalid'
    );
  }

  let selfClosing = false;
  let closed = false;
  while (index < xml.length) {
    const character = xml[index];
    if (character === '"' || character === "'") {
      /* The value is walked FORWARD, one character at a time, and the walk
       * ends at the closing quote. Searching backwards for a `<` from the end
       * of each value instead would rescan the whole tag once per attribute,
       * which is quadratic in the length of a tag and would let a part of a
       * few hundred kilobytes — well inside every ceiling — block this
       * synchronous reader, and with it the request that called it. Every
       * character of a tag is visited exactly once here. */
      let cursor = index + 1;
      while (cursor < xml.length && xml[cursor] !== character) {
        if (xml[cursor] === '<') {
          throw refuse(
            CODE_MALFORMED_XML,
            `xlsx-read: part ${partName} of ${filePath} has a raw "<" inside an attribute value on <${name}> at offset ${cursor}`,
            'xml_attribute_value_raw_lt'
          );
        }
        cursor += 1;
      }
      if (cursor >= xml.length) {
        throw refuse(
          CODE_TRUNCATED,
          `xlsx-read: part ${partName} of ${filePath} ends inside an attribute value on <${name}>`,
          'xml_attribute_truncated'
        );
      }
      index = cursor + 1;
      continue;
    }
    if (character === '<') {
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} has a raw "<" inside the <${name}> tag at offset ${index}`,
        'xml_tag_raw_lt'
      );
    }
    if (character === '>') {
      index += 1;
      closed = true;
      break;
    }
    if (character === '/' && xml[index + 1] === '>') {
      index += 2;
      selfClosing = true;
      closed = true;
      break;
    }
    index += 1;
  }
  if (!closed) {
    throw refuse(
      CODE_TRUNCATED,
      `xlsx-read: part ${partName} of ${filePath} ends inside the <${name}> start tag`,
      'xml_start_tag_truncated'
    );
  }
  return { name, selfClosing, end: index };
}

/**
 * Matches an end tag against the innermost open element.
 *
 * The two failures are told apart rather than lumped together, because they
 * mean different things about the bytes. An end tag naming an element that IS
 * open but not innermost means the inner element was never closed, which is the
 * same disagreement between declared bytes and structure that E_XLSX_TRUNCATED
 * covers everywhere else in this module. An end tag naming nothing that is open
 * is a document saying something wrong, which is E_XLSX_MALFORMED_XML.
 *
 * @param {string} xml The decoded part.
 * @param {number} tagStart Index of the `<`.
 * @param {string[]} open The elements currently open; mutated on a match.
 * @param {string} partName Part name, for the refusal messages.
 * @param {string} filePath Package path, for the refusal messages.
 * @returns {number} The index just past the end tag.
 * @throws {Error} E_XLSX_MALFORMED_XML or E_XLSX_TRUNCATED.
 */
function consumeEndTag(xml, tagStart, open, partName, filePath) {
  const nameStart = tagStart + 2;
  let index = nameStart;
  while (index < xml.length && !isTagNameBoundary(xml[index])) {
    index += 1;
  }
  const name = xml.slice(nameStart, index);
  while (index < xml.length && XML_WHITESPACE.includes(xml[index])) {
    index += 1;
  }
  if (index >= xml.length) {
    throw refuse(
      CODE_TRUNCATED,
      `xlsx-read: part ${partName} of ${filePath} ends inside an end tag at offset ${tagStart}`,
      'xml_end_tag_truncated'
    );
  }
  if (xml[index] !== '>' || !XML_NAME_PATTERN.test(name)) {
    throw refuse(
      CODE_MALFORMED_XML,
      `xlsx-read: part ${partName} of ${filePath} has a malformed end tag at offset ${tagStart}`,
      'xml_end_tag_malformed'
    );
  }

  const innermost = open.length === 0 ? undefined : open[open.length - 1];
  if (innermost === undefined) {
    throw refuse(
      CODE_MALFORMED_XML,
      `xlsx-read: part ${partName} of ${filePath} has an end tag </${name}> at offset ${tagStart} that closes no open element`,
      'xml_end_tag_unmatched'
    );
  }
  if (innermost !== name) {
    if (open.includes(name)) {
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: part ${partName} of ${filePath} closes <${name}> at offset ${tagStart} while <${innermost}> is still open, so <${innermost}> is never closed`,
        'xml_end_tag_misnested'
      );
    }
    throw refuse(
      CODE_MALFORMED_XML,
      `xlsx-read: part ${partName} of ${filePath} has an end tag </${name}> at offset ${tagStart} where </${innermost}> belongs`,
      'xml_end_tag_mismatched'
    );
  }
  open.pop();
  return index + 1;
}

/**
 * Holds an interpreted element to the parent ECMA-376 puts it under.
 *
 * Only the four names the descent searches for are constrained; every other
 * element in a worksheet — `sheetPr`, `cols`, `pageMargins` and the rest — is
 * walked for its shape and otherwise left alone.
 *
 * @param {string} name The element's name.
 * @param {string[]} open The elements currently open.
 * @param {number} tagStart Index of the `<`, for the refusal message.
 * @param {string} partName Part name, for the refusal message.
 * @param {string} filePath Package path, for the refusal message.
 * @returns {void}
 * @throws {Error} E_XLSX_MALFORMED_XML when the parent is not one the reader
 *   expects.
 */
function requireExpectedParent(name, open, tagStart, partName, filePath) {
  const expected = INTERPRETED_ELEMENT_PARENTS.get(name);
  if (expected === undefined) {
    return;
  }
  const parent = open.length === 0 ? undefined : open[open.length - 1];
  if (parent === undefined || !expected.includes(parent)) {
    throw refuse(
      CODE_MALFORMED_XML,
      `xlsx-read: part ${partName} of ${filePath} has a <${name}> element at offset ${tagStart} inside ${parent === undefined ? 'no element' : `<${parent}>`}; this reader reads <${name}> only inside ${expected.map((candidate) => `<${candidate}>`).join(' or ')}`,
      'xml_element_unexpected_parent'
    );
  }
}

/**
 * Reports whether a character ends an element name inside a tag.
 *
 * @param {string} character One character of the part.
 * @returns {boolean} True at whitespace, `/` or `>`.
 */
function isTagNameBoundary(character) {
  return character === '>' || character === '/' || XML_WHITESPACE.includes(character);
}

/**
 * Finds the start of the next `<tagName` element inside a span, requiring a
 * real delimiter after the name so a search for `<c` never matches `<cols`.
 *
 * The span is given as indexes into the whole document rather than as a
 * substring, which is what lets the walk descend into a row and a cell without
 * ever copying their text. See the module header: a value is only ever
 * extracted for a column the caller asked for.
 *
 * A plain scan is sound here only because `validateInterpretedStructure` has
 * already refused every part in which markup-looking text is not markup. That
 * pass is a precondition of this function, not an optional extra.
 *
 * @param {string} xml The document being scanned.
 * @param {string} tagName Unprefixed element name.
 * @param {number} fromIndex Where to start looking.
 * @param {number} endIndex One past the last index the element may start at.
 * @returns {number} The index of the `<`, or -1 when there is no further
 *   occurrence inside the span.
 */
function findElementStart(xml, tagName, fromIndex, endIndex) {
  const needle = `<${tagName}`;
  let index = fromIndex;
  while (index < endIndex) {
    index = xml.indexOf(needle, index);
    if (index === -1 || index + needle.length >= endIndex) {
      return -1;
    }
    const delimiter = xml[index + needle.length];
    if (delimiter === '>' || delimiter === '/' || XML_WHITESPACE.includes(delimiter)) {
      return index;
    }
    index += needle.length;
  }
  return -1;
}

/**
 * Parses a start tag's attributes and reports where its content begins.
 *
 * Attributes are parsed properly rather than pattern-matched, because the XML
 * grammar allows neither shortcut: attribute order is not fixed, so nothing
 * may assume one attribute follows another; and an attribute value is
 * permitted to contain a raw `>`, which a scan for the next `>` would take
 * for the end of the tag.
 *
 * Every attribute must be well formed — a name, an `=`, and a quoted value,
 * appearing once. Anything else is refused rather than repaired, because a
 * repaired attribute reaches the caller looking exactly like a real one.
 *
 * The attribute map has a NULL PROTOTYPE, which is what makes the duplicate
 * check total: assigning `__proto__` on an ordinary object invokes the
 * inherited setter instead of creating an own property, so a repeated
 * `__proto__` attribute would slip past a `hasOwnProperty` test and past the
 * map entirely.
 *
 * @param {string} xml The document being scanned.
 * @param {number} startIndex Index of the `<`.
 * @param {string} tagName Unprefixed element name.
 * @param {number} endIndex One past the last index the tag may occupy.
 * @param {string} partName Part name, for the refusal message.
 * @param {string} filePath Package path, for the refusal message.
 * @returns {{attributes: Object<string, string>, selfClosing: boolean, contentStart: number}}
 * @throws {Error} E_XLSX_MALFORMED_XML for a malformed attribute, or
 *   E_XLSX_TRUNCATED when the span ends inside the tag.
 */
function parseStartTag(xml, startIndex, tagName, endIndex, partName, filePath) {
  const attributes = Object.create(null);
  let index = startIndex + 1 + tagName.length;
  let selfClosing = false;
  let closed = false;
  let separated = false;

  while (index < endIndex) {
    const character = xml[index];
    if (character === '>') {
      index += 1;
      closed = true;
      break;
    }
    if (character === '/' && xml[index + 1] === '>') {
      index += 2;
      selfClosing = true;
      closed = true;
      break;
    }
    if (XML_WHITESPACE.includes(character)) {
      index += 1;
      separated = true;
      continue;
    }
    if (!separated) {
      // `<c r="A1"t="inlineStr">` is not well-formed XML. Reading it anyway
      // would mean this reader accepting a tag no writer produces and no
      // parser agrees on, which is precisely the salvage this module refuses.
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} runs two attributes together with no separating whitespace on <${tagName}> at offset ${index}`,
        'xml_attributes_unseparated',
        index
      );
    }

    let nameEnd = index;
    while (
      nameEnd < endIndex &&
      xml[nameEnd] !== '=' &&
      xml[nameEnd] !== '/' &&
      xml[nameEnd] !== '>' &&
      !XML_WHITESPACE.includes(xml[nameEnd])
    ) {
      nameEnd += 1;
    }
    if (nameEnd === index) {
      // A stray delimiter where an attribute name belongs. Stepping over it
      // would keep the scan moving, but it would also accept a tag whose
      // remaining attributes may now be read wrongly — and a cell's `r` and
      // `t` are exactly what decide where its value lands and how it is
      // interpreted. Refuse instead.
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} has ${JSON.stringify(xml[index])} where an attribute name belongs on <${tagName}> at offset ${index}`,
        'xml_attribute_name_invalid',
        index
      );
    }
    const attributeName = xml.slice(index, nameEnd);
    if (!XML_ATTRIBUTE_NAME_PATTERN.test(attributeName)) {
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} has ${JSON.stringify(attributeName)} where an XML attribute name belongs on <${tagName}>`,
        'xml_attribute_name_invalid'
      );
    }
    if (Object.prototype.hasOwnProperty.call(attributes, attributeName)) {
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} repeats attribute ${attributeName} on <${tagName}>, so which value applies is undefined`,
        'xml_attribute_repeated'
      );
    }
    index = nameEnd;
    while (index < endIndex && XML_WHITESPACE.includes(xml[index])) {
      index += 1;
    }
    // Reaching the end of the span here is a truncation, not a malformed
    // attribute: the bytes ran out before the document said anything wrong.
    if (index >= endIndex) {
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: part ${partName} of ${filePath} ends after attribute ${attributeName} on <${tagName}>`,
        'xml_attribute_truncated'
      );
    }
    if (xml[index] !== '=') {
      // A valueless attribute is not well-formed XML. Recording it as empty
      // is indistinguishable, to every caller, from an attribute that really
      // carried an empty value — which for `r` means a cell reference this
      // reader would then treat as absent.
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} has attribute ${attributeName} with no value on <${tagName}>`,
        'xml_attribute_value_missing'
      );
    }
    index += 1;
    while (index < endIndex && XML_WHITESPACE.includes(xml[index])) {
      index += 1;
    }
    if (index >= endIndex) {
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: part ${partName} of ${filePath} ends before the value of attribute ${attributeName} on <${tagName}>`,
        'xml_attribute_truncated'
      );
    }
    const quote = xml[index];
    if (quote !== '"' && quote !== "'") {
      // XML requires a quoted value. An unquoted one has no defined end, so
      // reading up to the next delimiter is a guess about where the value
      // stops rather than a fact about the document.
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} has an unquoted value for attribute ${attributeName} on <${tagName}>`,
        'xml_attribute_value_unquoted'
      );
    }
    const valueEnd = xml.indexOf(quote, index + 1);
    if (valueEnd === -1 || valueEnd >= endIndex) {
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: part ${partName} of ${filePath} ends inside the value of attribute ${attributeName} on <${tagName}>`,
        'xml_attribute_truncated'
      );
    }
    attributes[attributeName] = decodeXmlText(xml.slice(index + 1, valueEnd));
    index = valueEnd + 1;
    separated = false;
  }

  if (!closed) {
    throw refuse(
      CODE_TRUNCATED,
      `xlsx-read: part ${partName} of ${filePath} ends inside the <${tagName}> start tag`,
      'xml_start_tag_truncated'
    );
  }
  return { attributes, selfClosing, contentStart: index };
}

/**
 * Finds the closing tag that ends an element's content. Safe as a plain
 * search because XML escapes `<` inside character data, so `</tagName>`
 * cannot occur in text.
 *
 * @param {string} xml The document being scanned.
 * @param {string} tagName Unprefixed element name.
 * @param {number} fromIndex Where the element's content starts.
 * @param {number} endIndex One past the last index the closing tag may end at,
 *   which is the end of the enclosing element's content.
 * @param {string} partName Part name, for the refusal message.
 * @param {string} filePath Package path, for the refusal message.
 * @returns {{contentEnd: number, nextIndex: number}}
 * @throws {Error} E_XLSX_TRUNCATED when no closing tag falls inside the span.
 */
function findClosingTag(xml, tagName, fromIndex, endIndex, partName, filePath) {
  const closing = `</${tagName}>`;
  const contentEnd = xml.indexOf(closing, fromIndex);
  if (contentEnd === -1 || contentEnd + closing.length > endIndex) {
    throw refuse(
      CODE_TRUNCATED,
      `xlsx-read: part ${partName} of ${filePath} ends before the closing ${closing} tag`,
      'xml_closing_tag_missing'
    );
  }
  return { contentEnd, nextIndex: contentEnd + closing.length };
}

/**
 * Concatenates the text of every `<t>` element inside a fragment, decoding
 * entities as it goes. One `<t>` covers the `<is><t>` form these workbooks
 * use; several cover the rich-text `<is><r><t>` form, whose runs make up one
 * logical value.
 *
 * The count is returned alongside the text because the two cases the text
 * alone cannot tell apart matter: a `<t></t>` element holding an empty string
 * is a legal empty value, while a cell that declares itself an inline string
 * and carries no `<t>` at all is malformed, and the caller refuses it.
 *
 * This is the ONLY place a cell's text becomes a JavaScript string, and it is
 * reached only for a column the caller asked for.
 *
 * @param {string} xml The document being scanned.
 * @param {number} fromIndex Where the cell's content starts.
 * @param {number} endIndex Where the cell's content ends.
 * @param {string} partName Part name, for the refusal message.
 * @param {string} filePath Package path, for the refusal message.
 * @returns {{text: string, count: number}} The concatenated text and the
 *   number of `<t>` elements it came from.
 */
function collectTextElements(xml, fromIndex, endIndex, partName, filePath) {
  let text = '';
  let count = 0;
  let cursor = fromIndex;
  for (;;) {
    const start = findElementStart(xml, ELEMENT_TEXT, cursor, endIndex);
    if (start === -1) {
      return { text, count };
    }
    const tag = parseStartTag(xml, start, ELEMENT_TEXT, endIndex, partName, filePath);
    count += 1;
    if (tag.selfClosing) {
      cursor = tag.contentStart;
      continue;
    }
    const closing = findClosingTag(
      xml,
      ELEMENT_TEXT,
      tag.contentStart,
      endIndex,
      partName,
      filePath
    );
    text += decodeXmlText(xml.slice(tag.contentStart, closing.contentEnd));
    cursor = closing.nextIndex;
  }
}

/**
 * Builds the refusal for an inline string with no `<t>` element.
 *
 * Built in one place so the same refusal is raised whether or not the cell's
 * text was read: a cell outside the caller's selection is held to the
 * structure it declares without its value ever being decoded.
 *
 * @param {string} reference The cell's reference or column, for the message.
 * @param {string} partName Part name, for the refusal message.
 * @param {string} filePath Package path, for the refusal message.
 * @returns {Error} The refusal, ready to throw.
 */
function malformedInlineString(reference, partName, filePath) {
  return refuse(
    CODE_MALFORMED_XML,
    `xlsx-read: cell ${reference} in part ${partName} of ${filePath} declares t="${CELL_TYPE_INLINE_STRING}" but holds no <${ELEMENT_TEXT}> element`,
    'cell_inline_string_empty'
  );
}

/**
 * Checks that an inline-string cell carries at least one `<t>` element,
 * WITHOUT reading its text.
 *
 * This is how a cell outside the caller's selection is still held to the
 * structure it declares: the check looks for the element, so a malformed cell
 * is refused whether or not anyone asked for its value, and a student's name
 * or email never becomes a string on the way to finding that out.
 *
 * @param {string} xml The document being scanned.
 * @param {number} contentStart Where the cell's content starts, or -1 when the
 *   cell is self-closing.
 * @param {number} contentEnd Where the cell's content ends.
 * @param {string} reference The cell's reference or column, for the message.
 * @param {string} partName Part name, for the refusal message.
 * @param {string} filePath Package path, for the refusal message.
 * @returns {void}
 * @throws {Error} E_XLSX_MALFORMED_XML when no `<t>` element is present.
 */
function requireInlineStringElement(xml, contentStart, contentEnd, reference, partName, filePath) {
  const found =
    contentStart === -1 ? -1 : findElementStart(xml, ELEMENT_TEXT, contentStart, contentEnd);
  if (found === -1) {
    throw malformedInlineString(reference, partName, filePath);
  }
}

/* ------------------------------------------------------------------------- *
 * ZIP package walk
 * ------------------------------------------------------------------------- */

/**
 * Walks the chain of local file headers and describes every entry in the
 * package, in the order the entries physically appear.
 *
 * No part's position in the package is assumed, so the walk must reach the end
 * of the chain rather than stop early: the part a caller asks for may be the
 * last entry, and the last entry has to be reachable. The walk stops cleanly
 * at the first signature that is not a local file header, which is where the
 * central directory begins.
 *
 * Every entry is checked against the supported subset as it is walked, so the
 * package is refused whichever function the caller reached for.
 *
 * @param {Buffer} buffer The whole package.
 * @param {string} filePath Package path, for the refusal messages.
 * @returns {Array<{name: string, method: number, dataStart: number, compressedSize: number}>}
 */
function walkPackageEntries(buffer, filePath) {
  const entries = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + SIGNATURE_LENGTH > buffer.length) {
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: ${filePath} has ${buffer.length - offset} trailing byte(s) at offset ${offset}, too few to hold a header signature`,
        'zip_trailing_bytes',
        offset
      );
    }
    if (buffer.readUInt32LE(offset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      break;
    }
    if (offset + LOCAL_FILE_HEADER_LENGTH > buffer.length) {
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: ${filePath} ends inside the local file header at offset ${offset}`,
        'zip_header_truncated',
        offset
      );
    }

    const flag = buffer.readUInt16LE(offset + OFFSET_GENERAL_PURPOSE_FLAG);
    const method = buffer.readUInt16LE(offset + OFFSET_COMPRESSION_METHOD);
    const compressedSize = buffer.readUInt32LE(offset + OFFSET_COMPRESSED_SIZE);
    const nameLength = buffer.readUInt16LE(offset + OFFSET_FILENAME_LENGTH);
    const extraLength = buffer.readUInt16LE(offset + OFFSET_EXTRA_FIELD_LENGTH);
    const nameStart = offset + OFFSET_FILENAME;
    const nameEnd = nameStart + nameLength;

    if (nameEnd > buffer.length) {
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: ${filePath} ends inside the entry name at offset ${nameStart}`,
        'zip_entry_name_truncated',
        nameStart
      );
    }
    const name = buffer.toString('utf8', nameStart, nameEnd);

    // Flags are checked before anything is trusted, because a set
    // data-descriptor bit leaves the size fields at zero and would send the
    // walk to the wrong offset for every later entry.
    if (flag !== FLAG_NONE) {
      throw refuse(
        CODE_UNSUPPORTED_FLAGS,
        `xlsx-read: entry ${name} in ${filePath} sets general-purpose bit flag 0x${flag.toString(16)}${describeFlag(flag)}; only flag 0 is supported`,
        'zip_general_purpose_flag',
        offset,
        flag
      );
    }
    if (method !== COMPRESSION_STORED && method !== COMPRESSION_DEFLATE) {
      throw refuse(
        CODE_UNSUPPORTED_COMPRESSION,
        `xlsx-read: entry ${name} in ${filePath} uses compression method ${method}; only ${COMPRESSION_DEFLATE} (DEFLATE) and ${COMPRESSION_STORED} (STORED) are supported`,
        'zip_compression_method',
        offset,
        method
      );
    }

    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > buffer.length || dataEnd > buffer.length) {
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: entry ${name} in ${filePath} declares ${compressedSize} byte(s) at offset ${dataStart} but the file is ${buffer.length} byte(s)`,
        'zip_entry_out_of_range',
        dataStart,
        compressedSize
      );
    }

    entries.push({ name, method, dataStart, compressedSize });
    offset = dataEnd;
  }

  if (entries.length === 0) {
    throw refuse(
      CODE_TRUNCATED,
      `xlsx-read: ${filePath} does not begin with a ZIP local file header and is not a readable OOXML package`,
      'package_not_a_zip'
    );
  }
  return entries;
}

/**
 * Names the bits a rejected flag has set, so the message says what is wrong
 * rather than only that something is.
 *
 * @param {number} flag The general-purpose bit flag as read.
 * @returns {string} A parenthesized description, or an empty string.
 */
function describeFlag(flag) {
  const reasons = [];
  if ((flag & FLAG_ENCRYPTED) !== 0) {
    reasons.push('the encryption bit is set, so the data cannot be read');
  }
  if ((flag & FLAG_DATA_DESCRIPTOR) !== 0) {
    reasons.push('the data-descriptor bit is set, so the header sizes cannot be trusted');
  }
  return reasons.length === 0 ? '' : ` (${reasons.join('; ')})`;
}

/**
 * Reads a package into memory, refusing one too large to be a workbook and one
 * whose source cannot be bounded at all.
 *
 * Three controls, and the order they run in is the point:
 *
 *   1. The source must be a REGULAR FILE. A directory, a FIFO, a socket or a
 *      device has no length to measure — several of them report a size of zero
 *      and then produce bytes until something closes them — so a ceiling
 *      checked against such a descriptor's metadata is not a ceiling at all.
 *   2. The size is taken from the OPEN DESCRIPTOR rather than from a separate
 *      `statSync` on the path, so the file that is measured is the file that is
 *      then read, and it is measured BEFORE the allocation: refusing a 2 GB
 *      file has to cost nothing, which it only does while nothing has been
 *      allocated for it.
 *   3. The read itself is bounded independently of that measurement. This is
 *      the control step 2 cannot provide: `fstat` and the read are two separate
 *      operations on a filesystem other processes can write to, so a file may
 *      grow between them, and a source that misreports its size defeats step 2
 *      outright. `readDescriptorBounded` therefore treats the reported size as
 *      a hint for how much to allocate and the CEILING as the only limit it
 *      trusts — it stops one byte past the ceiling and refuses that byte.
 *
 * @param {string} filePath Path to the package, used exactly as given.
 * @returns {Buffer} The whole package.
 * @throws {Error} E_XLSX_UNSUPPORTED_SOURCE when the source is not a regular
 *   file, or E_XLSX_LIMIT_EXCEEDED when its bytes are past the ceiling —
 *   whether that is what the descriptor reported or what the read found.
 */
function readPackageBuffer(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) {
      throw refuse(
        CODE_UNSUPPORTED_SOURCE,
        `xlsx-read: ${filePath} is ${describeSourceKind(stats)} rather than a regular file, so the bytes it would yield cannot be bounded before they are read`,
        'source_not_regular_file'
      );
    }
    if (stats.size > MAX_PACKAGE_BYTES) {
      throw refuse(
        CODE_LIMIT_EXCEEDED,
        `xlsx-read: ${filePath} is ${stats.size} byte(s), past the ${MAX_PACKAGE_BYTES}-byte ceiling for a workbook package`,
        'package_too_large',
        null,
        stats.size
      );
    }
    return readDescriptorBounded(descriptor, filePath, stats.size);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Names the kind of a rejected source, so the refusal says what was opened
 * rather than only that it was wrong.
 *
 * @param {import('node:fs').Stats} stats The descriptor's metadata.
 * @returns {string} A short description, with an article.
 */
function describeSourceKind(stats) {
  if (stats.isDirectory()) {
    return 'a directory';
  }
  if (stats.isFIFO()) {
    return 'a pipe';
  }
  if (stats.isSocket()) {
    return 'a socket';
  }
  if (stats.isCharacterDevice()) {
    return 'a character device';
  }
  if (stats.isBlockDevice()) {
    return 'a block device';
  }
  if (stats.isSymbolicLink()) {
    return 'a symbolic link';
  }
  return 'not a regular file';
}

/**
 * Reads an open descriptor to its end, under the package ceiling.
 *
 * The buffer starts at the size the descriptor reported and DOUBLES while
 * bytes keep arriving, which is what makes the ceiling enforceable without
 * allocating it: a six-kilobyte workbook costs six kilobytes, and a source
 * that claims to be empty and then streams is still stopped at the ceiling
 * rather than at `buffer.kMaxLength`.
 *
 * Capacity always leaves room for ONE BYTE PAST the ceiling. That byte is the
 * whole mechanism: it can only be filled by a source holding more than the
 * ceiling allows, so seeing it is proof rather than inference, and a source
 * holding exactly `MAX_PACKAGE_BYTES` bytes still reads — the ceiling is
 * inclusive here exactly as it is in the size check above.
 *
 * Only the bytes actually read are ever exposed: the buffer is allocated
 * uninitialized for speed, and the slack at its end is either copied away or,
 * when the read filled it exactly, absent.
 *
 * @param {number} descriptor An open, readable descriptor positioned at 0.
 * @param {string} filePath Package path, for the refusal message.
 * @param {number} declaredSize The size the descriptor reported, used only to
 *   size the first allocation.
 * @returns {Buffer} Exactly the bytes read.
 * @throws {Error} E_XLSX_LIMIT_EXCEEDED when the source holds more than
 *   MAX_PACKAGE_BYTES bytes, whatever its metadata said.
 */
function readDescriptorBounded(descriptor, filePath, declaredSize) {
  const ceiling = MAX_PACKAGE_BYTES;
  let capacity = Math.min(Math.max(declaredSize, 1), ceiling) + 1;
  let buffer = Buffer.allocUnsafe(capacity);
  let filled = 0;

  for (;;) {
    if (filled === capacity) {
      if (capacity > ceiling) {
        // The reserved byte past the ceiling has been filled, so the source
        // holds at least ceiling + 1 bytes. Nothing further is read.
        throw refuse(
          CODE_LIMIT_EXCEEDED,
          `xlsx-read: ${filePath} yielded more than the ${ceiling}-byte ceiling for a workbook package (its descriptor reported ${declaredSize} byte(s) before the read)`,
          'package_grew_past_ceiling'
        );
      }
      capacity = Math.min(capacity * 2, ceiling + 1);
      const grown = Buffer.allocUnsafe(capacity);
      buffer.copy(grown, 0, 0, filled);
      buffer = grown;
    }
    const read = fs.readSync(descriptor, buffer, filled, capacity - filled, null);
    if (read === 0) {
      break;
    }
    filled += read;
  }

  return filled === buffer.length ? buffer : Buffer.from(buffer.subarray(0, filled));
}

/**
 * Decompresses one walked entry, under the documented ceilings.
 *
 * Each control here guards a failure the defaults permit: an over-large
 * declared compressed size is refused before a byte is inflated;
 * `maxOutputLength` stops an expansion that would otherwise run to
 * `buffer.kMaxLength`; and `rejectGarbageAfterEnd` refuses an entry whose
 * declared size overshoots its DEFLATE stream, which the default silently
 * accepts and which means the local header cannot be trusted for this entry
 * or for the offsets of the entries after it.
 *
 * @param {Buffer} buffer The whole package.
 * @param {{name: string, method: number, dataStart: number, compressedSize: number}} entry
 * @param {string} filePath Package path, for the refusal messages.
 * @returns {Buffer} The entry's bytes.
 * @throws {Error} E_XLSX_LIMIT_EXCEEDED past a ceiling, or E_XLSX_TRUNCATED
 *   when the declared bytes and the stream they should hold disagree.
 */
function decompressEntry(buffer, entry, filePath) {
  if (entry.compressedSize > MAX_ENTRY_COMPRESSED_BYTES) {
    throw refuse(
      CODE_LIMIT_EXCEEDED,
      `xlsx-read: entry ${entry.name} in ${filePath} declares ${entry.compressedSize} compressed byte(s), past the ${MAX_ENTRY_COMPRESSED_BYTES}-byte ceiling for one entry`,
      'zip_entry_too_large',
      null,
      entry.compressedSize
    );
  }
  const compressed = buffer.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === COMPRESSION_DEFLATE) {
    try {
      // Raw inflate: ZIP entry data carries no zlib wrapper, so the wrapped
      // variant would reject the very first byte.
      return zlib.inflateRawSync(compressed, {
        maxOutputLength: MAX_PART_BYTES,
        rejectGarbageAfterEnd: true,
      });
    } catch (cause) {
      if (cause.code === RUNTIME_OUTPUT_TOO_LARGE) {
        throw refuse(
          CODE_LIMIT_EXCEEDED,
          `xlsx-read: entry ${entry.name} in ${filePath} expands past the ${MAX_PART_BYTES}-byte ceiling for one part`,
          'part_too_large'
        );
      }
      if (cause.code === RUNTIME_TRAILING_JUNK) {
        throw refuse(
          CODE_TRUNCATED,
          `xlsx-read: entry ${entry.name} in ${filePath} declares ${entry.compressedSize} compressed byte(s) but its DEFLATE stream ends before that, leaving trailing bytes the header does not account for`,
          'zip_entry_stream_short',
          null,
          entry.compressedSize
        );
      }
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: entry ${entry.name} in ${filePath} declares ${entry.compressedSize} compressed byte(s) that could not be inflated (${cause.code || cause.message})`,
        'zip_entry_inflate_failed',
        null,
        entry.compressedSize
      );
    }
  }
  // STORED. Copied rather than handed back as a view, so the returned buffer
  // does not keep the whole package alive in memory. The part ceiling needs no
  // separate check here: a stored entry's expanded size IS its compressed
  // size, which the ceiling above already bounds.
  return Buffer.from(compressed);
}


/* ------------------------------------------------------------------------- *
 * Cells
 * ------------------------------------------------------------------------- */

/**
 * Resolves one cell to its string value.
 *
 * The cases, all of them declared rather than left to chance:
 *   - `t="inlineStr"` — the text of the nested `<is><t>` element(s). At least
 *     one `<t>` is REQUIRED: a cell declaring itself an inline string and
 *     carrying none is malformed, and returning `''` for it would put an
 *     empty label or an empty key where a real one was expected.
 *   - `t="n"`, or no `t` at all, which ECMA-376 makes implicitly numeric — the
 *     text of `<v>`, returned verbatim as a string so a float such as
 *     8.199999999999999 keeps every digit it was written with. The text must
 *     actually be a number: a numeric cell holding `S999` is refused with
 *     E_XLSX_UNSUPPORTED_CELL_TYPE rather than handed back, because verbatim
 *     return is exactly what would make that string indistinguishable from a
 *     Student ID read out of the key column.
 *   - `t="s"`, and every type outside the subset — refused by `parseRow`
 *     before this function is reached, since the type is known there and the
 *     refusal must hold for every cell in the worksheet rather than only for a
 *     cell whose value is being read.
 *   - empty, self-closing, holding no `<v>`, or holding an empty `<v></v>` —
 *     the empty string, without throwing. A blank cell is ordinary in a
 *     worksheet and states no value to disagree with its type; an inline
 *     string with no text is not, which is why only the former is tolerated.
 * A cell's `s` style index is read by nothing here: no style parsing.
 *
 * WHY THE LEXICAL CHECK LIVES HERE, while the TYPE check lives in `parseRow`:
 * a declared type is a property of the package and is checked for every cell,
 * selected or not. A value's content can only be checked by reading the value,
 * and reading the value of a column the caller did not ask for is precisely
 * what this module promises not to do — the name, date of birth, email, phone
 * and city beside a Student ID must not be materialised to find out whether
 * they are numbers. The attack the check exists for runs through a value that
 * IS read: the key column, which every submission is validated against.
 *
 * @param {string} xml The document being scanned.
 * @param {number} contentStart Where the cell's content starts, or -1 when the
 *   cell is self-closing.
 * @param {number} contentEnd Where the cell's content ends.
 * @param {string} reference The cell's `r` attribute, for messages.
 * @param {Object<string, string>} attributes The cell's attributes.
 * @param {string} partName Part name, for the refusal messages.
 * @param {string} filePath Package path, for the refusal messages.
 * @returns {string} The cell's value.
 * @throws {Error} E_XLSX_MALFORMED_XML for an inline string with no `<t>`, or
 *   E_XLSX_UNSUPPORTED_CELL_TYPE for a numeric cell whose value is not a
 *   number.
 */
function cellValue(xml, contentStart, contentEnd, reference, attributes, partName, filePath) {
  const type = attributes.t;
  const empty = contentStart === -1 || contentStart === contentEnd;

  if (type === CELL_TYPE_INLINE_STRING) {
    if (empty) {
      throw malformedInlineString(reference, partName, filePath);
    }
    const collected = collectTextElements(xml, contentStart, contentEnd, partName, filePath);
    if (collected.count === 0) {
      throw malformedInlineString(reference, partName, filePath);
    }
    return collected.text;
  }
  if (empty) {
    return '';
  }

  const valueStart = findElementStart(xml, ELEMENT_VALUE, contentStart, contentEnd);
  if (valueStart === -1) {
    return '';
  }
  const valueTag = parseStartTag(xml, valueStart, ELEMENT_VALUE, contentEnd, partName, filePath);
  if (valueTag.selfClosing) {
    return '';
  }
  const valueClose = findClosingTag(
    xml,
    ELEMENT_VALUE,
    valueTag.contentStart,
    contentEnd,
    partName,
    filePath
  );
  const value = decodeXmlText(xml.slice(valueTag.contentStart, valueClose.contentEnd));
  if (value.length === 0) {
    return '';
  }
  if (!NUMERIC_VALUE_PATTERN.test(value)) {
    throw refuse(
      CODE_UNSUPPORTED_CELL_TYPE,
      `xlsx-read: cell ${reference} in part ${partName} of ${filePath} declares ${type === undefined ? 'no cell type, which ECMA-376 makes numeric,' : `t="${type}"`} but its <${ELEMENT_VALUE}> element holds ${JSON.stringify(truncateForMessage(value))}, which is not a number`,
      'cell_value_not_numeric'
    );
  }
  return value;
}

/**
 * Shortens a value for a refusal message.
 *
 * A refusal names the offending detail, and a cell's text is bounded by
 * nothing, so the message takes a prefix rather than whatever the package
 * chose to put there. Short enough to read in a test failure, long enough to
 * identify what was wrong.
 *
 * @param {string} value The offending text.
 * @returns {string} The text, or a prefix of it with an ellipsis.
 */
function truncateForMessage(value) {
  return value.length <= MAX_MESSAGE_VALUE_LENGTH
    ? value
    : `${value.slice(0, MAX_MESSAGE_VALUE_LENGTH)}…`;
}

/**
 * Reads the cells of one `<row>` into an object keyed by column letter.
 *
 * Rows are sparse in general, so a missing cell simply has no key and cannot
 * shift the columns that are present — keying is by column letter, never by
 * position in the row. A cell whose `r` attribute is ABSENT takes the next
 * column after the previous cell, which is the ECMA-376 rule and keeps such a
 * cell from being dropped. A cell whose `r` attribute is PRESENT but not a
 * well-formed in-grid reference is refused rather than given that same
 * treatment: the two are different faults, and silently treating the second
 * as the first puts the value in whichever column happens to come next.
 *
 * Every cell is walked and structurally validated whether or not its column
 * was asked for — the start tag, the reference, the uniqueness of its column
 * within the row, the cell type and the presence of an inline string's `<t>`
 * element are all checked. Only the VALUE is conditional: outside the
 * selection the cell's text is never sliced, decoded or stored, which is what
 * keeps a Student ID read from materialising the personal data in the columns
 * beside it.
 *
 * The object is a plain `{}` with the ordinary prototype, so a caller can
 * compare it against an object literal with a strict deep-equality assertion.
 * Every key comes from a validated A-to-XFD column, so no cell reference can
 * produce a key that reaches the prototype.
 *
 * @param {string} xml The document being scanned.
 * @param {number} rowStart Where the row's content starts.
 * @param {number} rowEnd Where the row's content ends.
 * @param {string} partName Part name, for the refusal messages.
 * @param {string} filePath Package path, for the refusal messages.
 * @param {Set<string>|null} selection Columns whose values may be read, or
 *   null for every column.
 * @returns {Object<string, string>} Cell values keyed by column letter.
 * @throws {Error} E_XLSX_MALFORMED_XML for a malformed reference, two cells in
 *   one column, a row running past the grid or an inline string with no `<t>`;
 *   E_XLSX_SHARED_STRINGS_UNSUPPORTED for a `t="s"` cell anywhere in the row;
 *   or E_XLSX_UNSUPPORTED_CELL_TYPE for any other unsupported cell type
 *   anywhere in the row, and for a numeric cell in the selection whose value
 *   is not a number.
 */
function parseRow(xml, rowStart, rowEnd, partName, filePath, selection) {
  const cells = {};
  /* Every column this row has already placed a cell in, selected or not. The
   * returned object cannot serve as that record: outside a selection a cell
   * contributes no key, so two unselected duplicates would go unnoticed. */
  const seenColumns = new Set();
  let cursor = rowStart;
  let nextImplicitColumn = 0;

  for (;;) {
    const cellStart = findElementStart(xml, ELEMENT_CELL, cursor, rowEnd);
    if (cellStart === -1) {
      return cells;
    }
    const tag = parseStartTag(xml, cellStart, ELEMENT_CELL, rowEnd, partName, filePath);

    let contentStart = -1;
    let contentEnd = -1;
    if (tag.selfClosing) {
      cursor = tag.contentStart;
    } else {
      const closing = findClosingTag(
        xml,
        ELEMENT_CELL,
        tag.contentStart,
        rowEnd,
        partName,
        filePath
      );
      contentStart = tag.contentStart;
      contentEnd = closing.contentEnd;
      cursor = closing.nextIndex;
    }

    const reference = tag.attributes.r;
    let columnLetters;
    if (reference === undefined) {
      if (nextImplicitColumn > MAX_COLUMN_INDEX) {
        throw refuse(
          CODE_MALFORMED_XML,
          `xlsx-read: part ${partName} of ${filePath} holds a row with more cells than the A to ${LAST_COLUMN_LETTERS} grid has columns`,
          'row_wider_than_grid'
        );
      }
      columnLetters = lettersFromColumnIndex(nextImplicitColumn);
    } else {
      columnLetters = columnLettersFromCellReference(reference);
      if (columnLetters === null) {
        throw refuse(
          CODE_MALFORMED_XML,
          `xlsx-read: part ${partName} of ${filePath} has cell reference ${JSON.stringify(reference)}, which is not a well-formed reference within the A to ${LAST_COLUMN_LETTERS} grid`,
          'cell_reference_malformed'
        );
      }
    }
    nextImplicitColumn = columnIndexFromLetters(columnLetters) + 1;

    const describedAs = reference === undefined ? columnLetters : reference;

    // Two cells landing in one column is the row saying two different things
    // about the same cell. Silently keeping the last one is how an injected
    // duplicate overwrites a real Student ID or activity label, so the row is
    // refused instead — and the check covers EVERY cell, including one whose
    // column the caller did not ask for, because it is a property of the
    // package rather than of the request.
    if (seenColumns.has(columnLetters)) {
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} holds two cells in column ${columnLetters} of one row (the second is ${describedAs}), so which value that cell holds is undefined`,
        'cell_column_repeated'
      );
    }
    seenColumns.add(columnLetters);

    // The type refusals belong here rather than in `cellValue`: the type is
    // already in hand, and a package whose cells this reader cannot honour is
    // not one it should report on — including when the offending cell sits in
    // a column the caller did not ask for.
    //
    // The shared-string case keeps its own code because it names a specific,
    // resolvable-in-principle construct this reader chooses not to resolve.
    const declaredType = tag.attributes.t;
    if (declaredType === CELL_TYPE_SHARED_STRING) {
      throw refuse(
        CODE_SHARED_STRINGS_UNSUPPORTED,
        `xlsx-read: cell ${describedAs} in part ${partName} of ${filePath} is a shared-string reference (t="${CELL_TYPE_SHARED_STRING}"), which this reader does not resolve because the package has no xl/sharedStrings.xml part`,
        'cell_shared_string'
      );
    }

    // Everything else outside the subset. `b`, `d`, `e` and `str` are real
    // ECMA-376 types this reader does not interpret, and a `t` holding
    // anything at all is a type it has never heard of; in both cases the old
    // behaviour was to hand back the text of `<v>` verbatim. That is how a
    // substituted workbook states `S999` as `t="str"` and has it accepted as a
    // member of the authoritative key set, so the cell is refused before any
    // value is produced from it.
    if (
      declaredType !== undefined &&
      declaredType !== CELL_TYPE_INLINE_STRING &&
      declaredType !== CELL_TYPE_NUMBER
    ) {
      throw refuse(
        CODE_UNSUPPORTED_CELL_TYPE,
        `xlsx-read: cell ${describedAs} in part ${partName} of ${filePath} declares t=${JSON.stringify(truncateForMessage(declaredType))}, which is outside the supported subset: t="${CELL_TYPE_INLINE_STRING}", t="${CELL_TYPE_NUMBER}", or no t attribute at all`,
        'cell_type_unsupported'
      );
    }

    if (selection !== null && !selection.has(columnLetters)) {
      // Skipped for its VALUE only. An inline string still has to carry the
      // element it declares, and that is settled by looking for the element
      // rather than by reading what is inside it.
      if (declaredType === CELL_TYPE_INLINE_STRING) {
        requireInlineStringElement(xml, contentStart, contentEnd, describedAs, partName, filePath);
      }
      continue;
    }

    cells[columnLetters] = cellValue(
      xml,
      contentStart,
      contentEnd,
      describedAs,
      tag.attributes,
      partName,
      filePath
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Interpreted text
 * ------------------------------------------------------------------------- */

/**
 * Decodes a part's bytes as UTF-8, refusing bytes that are not.
 *
 * `Buffer.prototype.toString('utf8')` substitutes U+FFFD for every invalid
 * sequence, so a corrupted byte inside a Student ID or an activity label would
 * arrive as a plausible-looking string and be stored. A fatal `TextDecoder`
 * has exactly one failure mode — invalid encoded data — so any throw from it
 * means precisely that.
 *
 * @param {Buffer} bytes The part's bytes.
 * @param {string} partName Part name, for the refusal message.
 * @param {string} filePath Package path, for the refusal message.
 * @returns {string} The decoded text.
 * @throws {Error} E_XLSX_MALFORMED_XML when the bytes are not valid UTF-8.
 */
function decodePartText(bytes, partName, filePath) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw refuse(
      CODE_MALFORMED_XML,
      `xlsx-read: part ${partName} of ${filePath} is not valid UTF-8, so its text cannot be read without altering it`,
      'part_not_utf8'
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * Lists the part names in a package, in the order the entries physically
 * appear.
 *
 * The listing is how a caller establishes which parts a package holds and,
 * equally, that a given part is ABSENT — something no reading of rows and
 * columns could express. The whole entry chain is walked, so a part's position
 * in the package does not affect whether it appears here.
 *
 * @param {string} filePath Path to the .xlsx package, used exactly as given.
 * @returns {string[]} The part names, in package order.
 * @throws {TypeError} When `filePath` is not a non-empty string.
 * @throws {Error} E_XLSX_UNSUPPORTED_SOURCE, E_XLSX_UNSUPPORTED_FLAGS,
 *   E_XLSX_UNSUPPORTED_COMPRESSION, E_XLSX_LIMIT_EXCEEDED or E_XLSX_TRUNCATED
 *   when the source or the package falls outside the supported subset.
 */
function listEntries(filePath) {
  requireNonEmptyString(filePath, 'filePath');
  const buffer = readPackageBuffer(filePath);
  return walkPackageEntries(buffer, filePath).map((entry) => entry.name);
}

/**
 * Reads one part of a package and returns its decompressed bytes.
 *
 * Public because a caller may need the raw bytes of any part, not only the
 * cell values of a worksheet — reading the package's own XML, for instance.
 * Offering it keeps ZIP parsing in this one place, rather than reimplemented
 * by a caller in a second implementation that would drift from this one.
 *
 * @param {string} filePath Path to the .xlsx package, used exactly as given.
 * @param {string} partName The part to read, for example
 *   `'xl/worksheets/sheet1.xml'` or `'[Content_Types].xml'`. Where a package
 *   holds the same name twice, the first entry wins.
 * @returns {Buffer} The part's bytes.
 * @throws {TypeError} When an argument is not a non-empty string.
 * @throws {Error} E_XLSX_PART_NOT_FOUND when the part is absent, or one of the
 *   package-level refusals listed on `listEntries`.
 */
function readEntry(filePath, partName) {
  requireNonEmptyString(filePath, 'filePath');
  requireNonEmptyString(partName, 'partName');

  const buffer = readPackageBuffer(filePath);
  const entries = walkPackageEntries(buffer, filePath);
  const entry = entries.find((candidate) => candidate.name === partName);
  if (entry === undefined) {
    throw refuse(
      CODE_PART_NOT_FOUND,
      `xlsx-read: ${filePath} has no part named ${partName}; it holds ${entries.length} part(s): ${entries.map((candidate) => candidate.name).join(', ')}`,
      'package_part_missing'
    );
  }
  return decompressEntry(buffer, entry, filePath);
}

/**
 * Reads a worksheet part into rows of cell values keyed by column letter.
 *
 * One object per `<row>` element, in document order, so the first object is
 * the part's first row — the header row of a worksheet that carries one. Gaps
 * in row numbering are not padded — a row absent from the part produces no
 * object — and a column absent from a row produces no key on that row's
 * object.
 *
 * A part with no `<sheetData>` element yields an empty array rather than an
 * error, so asking a non-worksheet part for rows is answered with "no rows"
 * instead of a throw.
 *
 * `columnLetters` narrows WHICH VALUES are read, and nothing else. Omit it, or
 * pass null, and every populated column of each row is returned. Pass
 * `['A', 'C']` and each row object carries at most those two keys, while every
 * cell in the worksheet is still structurally validated — that is the
 * difference between not reading a value and not noticing that the worksheet
 * is malformed. Reading two columns this way costs one file read, one inflate
 * and one parse; two `readColumn` calls would cost two of each, because this
 * module holds no cache.
 *
 * @param {string} filePath Path to the .xlsx package, used exactly as given.
 * @param {string} partName The worksheet part, normally
 *   `'xl/worksheets/sheet1.xml'`.
 * @param {string[]|null} [columnLetters] Columns whose values to read, or null
 *   for every column.
 * @returns {Array<Object<string, string>>} One object per `<row>` element, in
 *   document order, keyed by uppercase column letter. With a selection each
 *   object carries at most the selected columns; with no selection it carries
 *   every populated column of its row.
 * @throws {TypeError} When an argument is not a non-empty string, or
 *   `columnLetters` is neither null nor a non-empty array of column letters.
 * @throws {Error} E_XLSX_SHARED_STRINGS_UNSUPPORTED for a `t="s"` cell,
 *   E_XLSX_UNSUPPORTED_CELL_TYPE for any other unsupported cell type or a
 *   numeric cell whose value is not a number, E_XLSX_MALFORMED_XML for
 *   undecodable or malformed worksheet XML — including a comment, a CDATA
 *   section, a processing instruction or a markup declaration, none of which
 *   this reader interprets or skips — or any of the refusals listed on
 *   `readEntry`.
 */
function readSheetRows(filePath, partName, columnLetters = null) {
  const selection = normalizeColumnSelection(columnLetters);
  const xml = decodePartText(readEntry(filePath, partName), partName, filePath);
  /* Before a single element is matched: the scanning below is only sound on a
   * part whose markup-looking text is markup, and whose tags balance. The
   * offset it returns is where interpreted content begins, so the search below
   * never re-enters the XML declaration the pass consumed as a whole. */
  const contentStart = validateInterpretedStructure(xml, partName, filePath);

  const sheetDataStart = findElementStart(xml, ELEMENT_SHEET_DATA, contentStart, xml.length);
  if (sheetDataStart === -1) {
    return [];
  }
  const sheetDataTag = parseStartTag(
    xml,
    sheetDataStart,
    ELEMENT_SHEET_DATA,
    xml.length,
    partName,
    filePath
  );
  if (sheetDataTag.selfClosing) {
    return [];
  }
  const sheetDataClose = findClosingTag(
    xml,
    ELEMENT_SHEET_DATA,
    sheetDataTag.contentStart,
    xml.length,
    partName,
    filePath
  );

  /* The walk descends by INDEX from here down: no substring is taken for
   * `<sheetData>`, for a row, or for a cell. The only text this function turns
   * into a string is a selected cell's value, which is what makes the
   * data-scope claim in the module header true rather than approximate. */
  const rows = [];
  let cursor = sheetDataTag.contentStart;
  for (;;) {
    const rowStart = findElementStart(xml, ELEMENT_ROW, cursor, sheetDataClose.contentEnd);
    if (rowStart === -1) {
      return rows;
    }
    const rowTag = parseStartTag(
      xml,
      rowStart,
      ELEMENT_ROW,
      sheetDataClose.contentEnd,
      partName,
      filePath
    );
    if (rowTag.selfClosing) {
      rows.push({});
      cursor = rowTag.contentStart;
      continue;
    }
    const rowClose = findClosingTag(
      xml,
      ELEMENT_ROW,
      rowTag.contentStart,
      sheetDataClose.contentEnd,
      partName,
      filePath
    );
    rows.push(parseRow(xml, rowTag.contentStart, rowClose.contentEnd, partName, filePath, selection));
    cursor = rowClose.nextIndex;
  }
}

/**
 * Reads one column of a worksheet, one value per row.
 *
 * Exactly one value is returned per `<row>` element, in document order, so
 * index 0 holds the part's first row — the header row of a worksheet that
 * carries one — and index i stays aligned with the i-th row. A row that has no
 * cell in the requested column contributes the empty string rather than being
 * skipped, because skipping it would shift every later value and quietly
 * misalign the caller's rows.
 *
 * Only the requested column is decoded, so the values held in the other
 * columns of the same rows are never materialised.
 *
 * @param {string} filePath Path to the .xlsx package, used exactly as given.
 * @param {string} partName The worksheet part, normally
 *   `'xl/worksheets/sheet1.xml'`.
 * @param {string} columnLetter The column, case-insensitive, for example `'A'`
 *   or `'C'`.
 * @returns {string[]} One value per `<row>` element in the part, in document
 *   order — the cell's value, or the empty string for a row with no cell in
 *   that column.
 * @throws {TypeError} When an argument is not a non-empty string, or
 *   `columnLetter` does not name a column from A to XFD.
 * @throws {Error} Any of the refusals listed on `readSheetRows`.
 */
function readColumn(filePath, partName, columnLetter) {
  const normalized = normalizeColumnLetter(columnLetter);
  return readSheetRows(filePath, partName, [normalized]).map((row) =>
    Object.prototype.hasOwnProperty.call(row, normalized) ? row[normalized] : ''
  );
}

module.exports = { readSheetRows, readColumn, readEntry, listEntries };
