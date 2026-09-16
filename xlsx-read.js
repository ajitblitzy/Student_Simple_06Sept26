'use strict';

/**
 * A focused, zero-dependency reader for the SpreadsheetML (ECMA-376 /
 * ISO-IEC 29500) workbooks this repository ships.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * A reader, not a spreadsheet library. The feature needs exactly two things
 * out of the workbooks: the authoritative Student ID key set in
 * `student_details.xlsx` (sheet `Student Details`, column A) and the
 * `Extracurricular Activity` labels in `student_other_info.xlsx` (sheet
 * `Other Info`, column C, taken with the Student ID in column A that each
 * label belongs to). All of those are plain cells inside a single worksheet
 * part, so `node:fs` and `node:zlib` cover the entire job and no package from
 * the public registry is added to a project that declares zero dependencies.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * There is NO write path here and none may be added: the feature never
 * modifies a workbook, so no package part is ever repacked and the whole
 * class of corrupt-package failure stays off the risk surface. Equally absent,
 * and deliberately so — sheet-name resolution through `xl/workbook.xml`, style
 * or theme parsing, date-serial conversion, any cache or memoization (the
 * caller owns caching), and any asynchronous variant.
 *
 * GOVERNING RULE: `Ajit_AddNewFeature_Rule`
 * -----------------------------------------
 * Its technical-implementation area is why the supported subset below is
 * declared and testable rather than a best effort: every refusal carries a
 * named `code` a test can match on, and every tolerated oddity is written
 * down. Its minimal-change and discipline area is why this module stops at
 * the four functions at the foot of the file, and why two built-in modules do
 * a job no dependency is installed for.
 *
 * THE SUPPORTED SUBSET, AND THE REFUSAL FOR EVERYTHING OUTSIDE IT
 * ---------------------------------------------------------------
 * A bespoke reader has to declare its limits, because silently mishandling an
 * unsupported package is worse than refusing it. This reader therefore FAILS
 * CLOSED: it never salvages, repairs or approximates input it cannot read.
 * Each refusal is an `Error` whose `code` is the exact string below and whose
 * message names the offending detail. No partial or placeholder data is ever
 * returned with, or instead of, a refusal.
 *
 *   Compression  DEFLATE (8) and STORED (0) are read. Any other method throws
 *                E_XLSX_UNSUPPORTED_COMPRESSION naming the method number. The
 *                bytes are NOT handed back as-is: they are still compressed,
 *                and returning them as though they were XML is a silent
 *                corruption.
 *   Flags        The general-purpose bit flag must be 0. Anything else throws
 *                E_XLSX_UNSUPPORTED_FLAGS. A set encryption bit (0x1) means
 *                the data cannot be read at all; a set data-descriptor bit
 *                (0x8) means the local header's size fields are zero and
 *                cannot be trusted, which would make the walk itself wrong.
 *   Parts        Any part present in the package can be fetched by name. A
 *                requested part that is absent throws E_XLSX_PART_NOT_FOUND
 *                naming the part.
 *   Cell types   `t="inlineStr"` with nested `<is><t>`, and `t="n"`. A
 *                `t="s"` shared-string reference throws
 *                E_XLSX_SHARED_STRINGS_UNSUPPORTED: no workbook here has an
 *                `xl/sharedStrings.xml` part, so there is no table to resolve
 *                the index against and a silently empty value would corrupt
 *                the key set.
 *   Bounds       An entry's header, name and data must all fall inside the
 *                buffer, and a package must begin with a local file header.
 *                Otherwise E_XLSX_TRUNCATED. That code covers every case in
 *                which the DECLARED BYTES AND THE STRUCTURE THEY SHOULD HOLD
 *                DISAGREE: a part whose XML ends inside a start tag or without
 *                its closing tag, an entry whose data will not inflate, and an
 *                entry whose declared compressed size overshoots its DEFLATE
 *                stream and leaves trailing junk behind it.
 *   Well-formed  An interpreted part must be valid UTF-8 and well formed
 *                where this reader relies on structure, or it throws
 *                E_XLSX_MALFORMED_XML: an attribute with no value, a stray
 *                delimiter where an attribute name belongs, an unquoted or
 *                repeated attribute, a cell whose `r` reference is present but
 *                not a well-formed in-grid reference, a row holding more cells
 *                than the grid has columns, and a `t="inlineStr"` cell with no
 *                `<t>` element. Each of those was previously salvaged, and
 *                salvage here erases, shifts or fabricates a key or a label.
 *   Ceilings     A package, a declared entry and an expanded part each have a
 *                documented size ceiling (see MAX_PACKAGE_BYTES and its two
 *                siblings). Exceeding one throws E_XLSX_LIMIT_EXCEEDED. The
 *                package is measured BEFORE it is read into memory and the
 *                part while it inflates, so neither a large file nor a small
 *                highly-compressed one can exhaust the process.
 *
 * Refusals are raised while the entry chain is walked, for every entry in the
 * package rather than only the one being fetched. That is deliberate: a
 * package holding an entry this reader cannot read is not a package it should
 * report on, and the data-descriptor case makes the walk unreliable in any
 * case. So `listEntries` refuses exactly what `readEntry` refuses.
 *
 * STRUCTURE IS ALWAYS CHECKED; VALUES ARE READ ONLY WHERE ASKED FOR
 * -----------------------------------------------------------------
 * `readSheetRows` takes an optional list of column letters, and `readColumn`
 * always uses it. When a selection is given, every cell in the worksheet is
 * still walked and structurally validated — its start tag, its `r` reference
 * and its cell type — but the TEXT of a cell outside the selection is never
 * sliced, decoded or returned. That is what lets a caller read the Student ID
 * column of `student_details.xlsx` without materialising the name, date of
 * birth, email, phone and city sitting beside it, which the feature has no
 * business holding. The two halves of the guarantee are deliberately
 * different: structure is a property of the package and is enforced
 * everywhere, while a value is personal data and is read only where the
 * caller asked for it.
 *
 * THE VALUE CONTRACT
 * ------------------
 * Every cell value is returned as a STRING, numerics included — `Age` 20
 * arrives as `'20'` and a GPA of 8.199999999999999 arrives with all of its
 * digits. The key set and the activity labels are text, so string is the
 * simpler contract, and it is also the lossless one: no float round-trip and
 * no locale in the way. A caller wanting a number converts it explicitly.
 * Nothing here converts a date serial to a date — that is out of scope.
 *
 * MODULE CHARACTERISTICS
 * ----------------------
 * Synchronous (`readFileSync`, `inflateRawSync`), stateless (no module-level
 * cache, no memoization, no mutable module state), and free of side effects:
 * it never modifies a file, never logs, and reads no environment variable.
 * Every call re-reads the file from disk, which is what lets the caller decide
 * what to cache and for how long. A caller needing two columns of one
 * worksheet should therefore ask for both in a single `readSheetRows` call
 * rather than calling `readColumn` twice, which would read, inflate and parse
 * the same package twice over. Element names are read unprefixed, as every
 * writer of these packages produces them.
 *
 * Usage — the key-set read, one column:
 *   const xlsxRead = require('./xlsx-read');
 *   const sheet = 'xl/worksheets/sheet1.xml';
 *   const ids = xlsxRead.readColumn('student_details.xlsx', sheet, 'A');
 *   // ids[0] is the header 'Student ID'; ids[1] through ids[10] are the ten
 *   // Student IDs 'S001' to 'S010', in worksheet order.
 *
 * Usage — the seed read, two columns of one worksheet in a single pass:
 *   const rows = xlsxRead.readSheetRows('student_other_info.xlsx', sheet, ['A', 'C']);
 *   // rows[0] is { A: 'Student ID', C: 'Extracurricular Activity' };
 *   // rows[1] is { A: 'S001', C: 'Robotics Club' }. No other column of the
 *   // worksheet is decoded, and rows.length is 11 for these workbooks.
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
 * The three workbooks are fixed, committed reference files, and they were
 * measured rather than guessed at: the largest package is 6,018 bytes, its
 * largest part inflates to 10,140 bytes, and all nine parts of a package come
 * to 23,790 bytes together. The ceilings below sit two to three orders of
 * magnitude above those figures, so no workbook this repository ships can
 * approach one — while a package substituted for one of them cannot consume
 * the process. Left to its defaults `inflateRawSync` will produce output up to
 * `buffer.kMaxLength`, which is how a few kilobytes of crafted DEFLATE
 * exhausts memory, and `readFileSync` will happily allocate a file of any
 * size at all.
 * ------------------------------------------------------------------------- */

/** A package file larger than this is refused before it is read into memory. */
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;

/** An entry declaring more compressed bytes than this is refused unread. */
const MAX_ENTRY_COMPRESSED_BYTES = 1024 * 1024;

/** Inflation stops and refuses at this many bytes of output for one part. */
const MAX_PART_BYTES = 4 * 1024 * 1024;

/* ------------------------------------------------------------------------- *
 * The refusal codes. Exported nowhere by design — the four public functions
 * are the whole surface, and a test matches on `err.code`, never on message
 * text.
 * ------------------------------------------------------------------------- */

const CODE_UNSUPPORTED_COMPRESSION = 'E_XLSX_UNSUPPORTED_COMPRESSION';
const CODE_UNSUPPORTED_FLAGS = 'E_XLSX_UNSUPPORTED_FLAGS';
const CODE_PART_NOT_FOUND = 'E_XLSX_PART_NOT_FOUND';
const CODE_SHARED_STRINGS_UNSUPPORTED = 'E_XLSX_SHARED_STRINGS_UNSUPPORTED';
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
const ELEMENT_SHEET_DATA = 'sheetData';
const ELEMENT_ROW = 'row';
const ELEMENT_CELL = 'c';
const ELEMENT_VALUE = 'v';
const ELEMENT_TEXT = 't';

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
 * @param {string} code One of the CODE_* constants above.
 * @param {string} message Names the offending detail.
 * @returns {Error} An error whose `code` property is `code`.
 */
function refuse(code, message) {
  const error = new Error(message);
  error.code = code;
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
 * `null` or `undefined` means "every column", which is the behaviour every
 * caller had before the selection existed. An array names the columns whose
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
 * The labels in these workbooks need none of this today, but an activity name
 * containing `&` could reach a workbook later, and a raw `&amp;` surfacing in
 * a key or a seed label would be a silent data bug. An unrecognized entity or
 * an out-of-range code point is left verbatim rather than dropped, so nothing
 * disappears without a trace.
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

/**
 * Finds the start of the next `<tagName` element inside a span, requiring a
 * real delimiter after the name so a search for `<c` never matches `<cols`.
 *
 * The span is given as indexes into the whole document rather than as a
 * substring, which is what lets the walk descend into a row and a cell without
 * ever copying their text. See the module header: a value is only ever
 * extracted for a column the caller asked for.
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
 * Attributes are parsed properly rather than pattern-matched, for two reasons
 * measured against these files: the cells carry `r`, `s` and `t` in that
 * order, so nothing may assume `t` follows `r`; and an attribute value is
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
        `xlsx-read: part ${partName} of ${filePath} runs two attributes together with no separating whitespace on <${tagName}> at offset ${index}`
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
        `xlsx-read: part ${partName} of ${filePath} has ${JSON.stringify(xml[index])} where an attribute name belongs on <${tagName}> at offset ${index}`
      );
    }
    const attributeName = xml.slice(index, nameEnd);
    if (!XML_ATTRIBUTE_NAME_PATTERN.test(attributeName)) {
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} has ${JSON.stringify(attributeName)} where an XML attribute name belongs on <${tagName}>`
      );
    }
    if (Object.prototype.hasOwnProperty.call(attributes, attributeName)) {
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} repeats attribute ${attributeName} on <${tagName}>, so which value applies is undefined`
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
        `xlsx-read: part ${partName} of ${filePath} ends after attribute ${attributeName} on <${tagName}>`
      );
    }
    if (xml[index] !== '=') {
      // A valueless attribute is not well-formed XML. Recording it as empty
      // is indistinguishable, to every caller, from an attribute that really
      // carried an empty value — which for `r` means a cell reference this
      // reader would then treat as absent.
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} has attribute ${attributeName} with no value on <${tagName}>`
      );
    }
    index += 1;
    while (index < endIndex && XML_WHITESPACE.includes(xml[index])) {
      index += 1;
    }
    if (index >= endIndex) {
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: part ${partName} of ${filePath} ends before the value of attribute ${attributeName} on <${tagName}>`
      );
    }
    const quote = xml[index];
    if (quote !== '"' && quote !== "'") {
      // XML requires a quoted value. An unquoted one has no defined end, so
      // reading up to the next delimiter is a guess about where the value
      // stops rather than a fact about the document.
      throw refuse(
        CODE_MALFORMED_XML,
        `xlsx-read: part ${partName} of ${filePath} has an unquoted value for attribute ${attributeName} on <${tagName}>`
      );
    }
    const valueEnd = xml.indexOf(quote, index + 1);
    if (valueEnd === -1 || valueEnd >= endIndex) {
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: part ${partName} of ${filePath} ends inside the value of attribute ${attributeName} on <${tagName}>`
      );
    }
    attributes[attributeName] = decodeXmlText(xml.slice(index + 1, valueEnd));
    index = valueEnd + 1;
    separated = false;
  }

  if (!closed) {
    throw refuse(
      CODE_TRUNCATED,
      `xlsx-read: part ${partName} of ${filePath} ends inside the <${tagName}> start tag`
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
      `xlsx-read: part ${partName} of ${filePath} ends before the closing ${closing} tag`
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
 * One function because two call sites raise it: the value path, which has the
 * text in hand, and the skip path, which deliberately does not.
 *
 * @param {string} reference The cell's reference or column, for the message.
 * @param {string} partName Part name, for the refusal message.
 * @param {string} filePath Package path, for the refusal message.
 * @returns {Error} The refusal, ready to throw.
 */
function malformedInlineString(reference, partName, filePath) {
  return refuse(
    CODE_MALFORMED_XML,
    `xlsx-read: cell ${reference} in part ${partName} of ${filePath} declares t="${CELL_TYPE_INLINE_STRING}" but holds no <${ELEMENT_TEXT}> element`
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
 * The walk must reach the end of the chain rather than stop early: in all
 * three workbooks the worksheet is the 4th entry and `[Content_Types].xml` is
 * the LAST, so no part's position may be assumed. It stops cleanly at the
 * first signature that is not a local file header, which is where the central
 * directory begins.
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
        `xlsx-read: ${filePath} has ${buffer.length - offset} trailing byte(s) at offset ${offset}, too few to hold a header signature`
      );
    }
    if (buffer.readUInt32LE(offset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      break;
    }
    if (offset + LOCAL_FILE_HEADER_LENGTH > buffer.length) {
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: ${filePath} ends inside the local file header at offset ${offset}`
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
        `xlsx-read: ${filePath} ends inside the entry name at offset ${nameStart}`
      );
    }
    const name = buffer.toString('utf8', nameStart, nameEnd);

    // Flags are checked before anything is trusted, because a set
    // data-descriptor bit leaves the size fields at zero and would send the
    // walk to the wrong offset for every later entry.
    if (flag !== FLAG_NONE) {
      throw refuse(
        CODE_UNSUPPORTED_FLAGS,
        `xlsx-read: entry ${name} in ${filePath} sets general-purpose bit flag 0x${flag.toString(16)}${describeFlag(flag)}; only flag 0 is supported`
      );
    }
    if (method !== COMPRESSION_STORED && method !== COMPRESSION_DEFLATE) {
      throw refuse(
        CODE_UNSUPPORTED_COMPRESSION,
        `xlsx-read: entry ${name} in ${filePath} uses compression method ${method}; only ${COMPRESSION_DEFLATE} (DEFLATE) and ${COMPRESSION_STORED} (STORED) are supported`
      );
    }

    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > buffer.length || dataEnd > buffer.length) {
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: entry ${name} in ${filePath} declares ${compressedSize} byte(s) at offset ${dataStart} but the file is ${buffer.length} byte(s)`
      );
    }

    entries.push({ name, method, dataStart, compressedSize });
    offset = dataEnd;
  }

  if (entries.length === 0) {
    throw refuse(
      CODE_TRUNCATED,
      `xlsx-read: ${filePath} does not begin with a ZIP local file header and is not a readable OOXML package`
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
 * Reads a package into memory, refusing one too large to be a workbook.
 *
 * The size is taken from the open descriptor rather than from a separate
 * `statSync` on the path, so the file that is measured is exactly the file
 * that is then read — and it is measured BEFORE the allocation, which is the
 * only point at which refusing a 2 GB file still costs nothing.
 *
 * @param {string} filePath Path to the package, used exactly as given.
 * @returns {Buffer} The whole package.
 * @throws {Error} E_XLSX_LIMIT_EXCEEDED when the file is past the ceiling.
 */
function readPackageBuffer(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(descriptor);
    if (size > MAX_PACKAGE_BYTES) {
      throw refuse(
        CODE_LIMIT_EXCEEDED,
        `xlsx-read: ${filePath} is ${size} byte(s), past the ${MAX_PACKAGE_BYTES}-byte ceiling for a workbook package`
      );
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Decompresses one walked entry, under the documented ceilings.
 *
 * Three controls, and each of them guards a failure the defaults permit:
 * the declared compressed size is refused before a byte is inflated;
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
      `xlsx-read: entry ${entry.name} in ${filePath} declares ${entry.compressedSize} compressed byte(s), past the ${MAX_ENTRY_COMPRESSED_BYTES}-byte ceiling for one entry`
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
          `xlsx-read: entry ${entry.name} in ${filePath} expands past the ${MAX_PART_BYTES}-byte ceiling for one part`
        );
      }
      if (cause.code === RUNTIME_TRAILING_JUNK) {
        throw refuse(
          CODE_TRUNCATED,
          `xlsx-read: entry ${entry.name} in ${filePath} declares ${entry.compressedSize} compressed byte(s) but its DEFLATE stream ends before that, leaving trailing bytes the header does not account for`
        );
      }
      throw refuse(
        CODE_TRUNCATED,
        `xlsx-read: entry ${entry.name} in ${filePath} declares ${entry.compressedSize} compressed byte(s) that could not be inflated (${cause.code || cause.message})`
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
 *   - `t="n"` — the text of `<v>`, returned verbatim as a string so a float
 *     such as 8.199999999999999 keeps every digit it was written with.
 *   - `t="s"` — refused by `parseRow` before this function is reached, since
 *     the type is known there and the refusal must hold for every cell in the
 *     worksheet rather than only for a cell whose value is being read.
 *   - no `t` at all — implicitly numeric per ECMA-376, so the text of `<v>`.
 *   - any other `t` (`b`, `d`, `e`, `str`) — the text of `<v>` verbatim. That
 *     is the literal the package stored, so it is faithful rather than lossy;
 *     no interpretation and no date-serial conversion is applied.
 *   - empty, self-closing, or holding no `<v>` — the empty string, without
 *     throwing. An untyped empty cell is ordinary in a worksheet; an inline
 *     string with no text is not, which is why only the former is tolerated.
 * A cell's `s` style index is read by nothing here: no style parsing.
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
 * @throws {Error} E_XLSX_MALFORMED_XML for an inline string with no `<t>`.
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
  return decodeXmlText(xml.slice(valueTag.contentStart, valueClose.contentEnd));
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
 * was asked for — the start tag, the reference, the cell type and the presence
 * of an inline string's `<t>` element are all checked. Only the VALUE is
 * conditional: outside the selection the cell's text is never sliced, decoded
 * or stored, which is what keeps a Student ID read from materialising the
 * personal data in the columns beside it.
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
 * @throws {Error} E_XLSX_MALFORMED_XML for a malformed reference, a row
 *   running past the grid or an inline string with no `<t>`, or
 *   E_XLSX_SHARED_STRINGS_UNSUPPORTED for a `t="s"` cell anywhere in the row.
 */
function parseRow(xml, rowStart, rowEnd, partName, filePath, selection) {
  const cells = {};
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
          `xlsx-read: part ${partName} of ${filePath} holds a row with more cells than the A to ${LAST_COLUMN_LETTERS} grid has columns`
        );
      }
      columnLetters = lettersFromColumnIndex(nextImplicitColumn);
    } else {
      columnLetters = columnLettersFromCellReference(reference);
      if (columnLetters === null) {
        throw refuse(
          CODE_MALFORMED_XML,
          `xlsx-read: part ${partName} of ${filePath} has cell reference ${JSON.stringify(reference)}, which is not a well-formed reference within the A to ${LAST_COLUMN_LETTERS} grid`
        );
      }
    }
    nextImplicitColumn = columnIndexFromLetters(columnLetters) + 1;

    // The shared-string refusal belongs here rather than in `cellValue`: the
    // type is already in hand, and a package carrying a string table this
    // reader cannot resolve is not one it should report on — including when
    // the `t="s"` cell sits in a column the caller did not ask for.
    if (tag.attributes.t === CELL_TYPE_SHARED_STRING) {
      throw refuse(
        CODE_SHARED_STRINGS_UNSUPPORTED,
        `xlsx-read: cell ${reference === undefined ? columnLetters : reference} in part ${partName} of ${filePath} is a shared-string reference (t="${CELL_TYPE_SHARED_STRING}"), which this reader does not resolve because the package has no xl/sharedStrings.xml part`
      );
    }


    const describedAs = reference === undefined ? columnLetters : reference;

    if (selection !== null && !selection.has(columnLetters)) {
      // Skipped for its VALUE only. An inline string still has to carry the
      // element it declares, and that is settled by looking for the element
      // rather than by reading what is inside it.
      if (tag.attributes.t === CELL_TYPE_INLINE_STRING) {
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
      `xlsx-read: part ${partName} of ${filePath} is not valid UTF-8, so its text cannot be read without altering it`
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Public API — exactly these four functions, per `Ajit_AddNewFeature_Rule`
 * ------------------------------------------------------------------------- */

/**
 * Lists the part names in a package, in the order the entries physically
 * appear.
 *
 * This is what proves a part is ABSENT — that there is no `vbaProject` and no
 * `externalLink` part, which no amount of rows and columns could express.
 *
 * Each workbook in this repository holds nine parts, beginning with
 * `docProps/app.xml` and ending with `[Content_Types].xml`; the worksheet is
 * the fourth. Nothing here assumes that order — the whole entry chain is
 * walked — but it is why the last entry has to be reachable.
 *
 * @param {string} filePath Path to the .xlsx package, used exactly as given.
 * @returns {string[]} The part names, in package order.
 * @throws {TypeError} When `filePath` is not a non-empty string.
 * @throws {Error} E_XLSX_UNSUPPORTED_FLAGS, E_XLSX_UNSUPPORTED_COMPRESSION,
 *   E_XLSX_LIMIT_EXCEEDED or E_XLSX_TRUNCATED when the package falls outside
 *   the supported subset.
 */
function listEntries(filePath) {
  requireNonEmptyString(filePath, 'filePath');
  const buffer = readPackageBuffer(filePath);
  return walkPackageEntries(buffer, filePath).map((entry) => entry.name);
}

/**
 * Reads one part of a package and returns its decompressed bytes.
 *
 * The primitive the other three functions are built on, and public because
 * the inertness assertions need a part's raw text — keeping ZIP parsing in
 * this one place rather than reimplemented in a test, where the second
 * implementation would drift from this one.
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
      `xlsx-read: ${filePath} has no part named ${partName}; it holds ${entries.length} part(s): ${entries.map((candidate) => candidate.name).join(', ')}`
    );
  }
  return decompressEntry(buffer, entry, filePath);
}

/**
 * Reads a worksheet part into rows of cell values keyed by column letter.
 *
 * One object per `<row>` element, in document order, so the first object is
 * the header row of these workbooks. Gaps in row numbering are not padded —
 * a row absent from the part produces no object — and a column absent from a
 * row produces no key on that row's object.
 *
 * A part with no `<sheetData>` element yields an empty array rather than an
 * error, so asking a non-worksheet part for rows is answered with "no rows"
 * instead of a throw.
 *
 * `columnLetters` narrows WHICH VALUES are read, and nothing else. Omit it, or
 * pass null, and every column is returned as before. Pass `['A', 'C']` and
 * each row object carries at most those two keys, while every cell in the
 * worksheet is still structurally validated — that is the difference between
 * not reading a student's email and not noticing that the worksheet is
 * malformed. Reading two columns this way costs one file read, one inflate
 * and one parse; two `readColumn` calls would cost two of each, because this
 * module holds no cache.
 *
 * @param {string} filePath Path to the .xlsx package, used exactly as given.
 * @param {string} partName The worksheet part, normally
 *   `'xl/worksheets/sheet1.xml'`.
 * @param {string[]|null} [columnLetters] Columns whose values to read, or null
 *   for every column.
 * @returns {Array<Object<string, string>>} One object per `<row>` element, in
 *   document order. For column A of `student_details.xlsx` the first object is
 *   `{ A: 'Student ID' }` and the second is `{ A: 'S001' }`. With no selection
 *   each object instead carries every populated column of its row, which for
 *   that workbook means ten keys, A through J, holding the ten header cells on
 *   the first object and one student's row on each of the ten after it.
 * @throws {TypeError} When an argument is not a non-empty string, or
 *   `columnLetters` is neither null nor a non-empty array of column letters.
 * @throws {Error} E_XLSX_SHARED_STRINGS_UNSUPPORTED for a `t="s"` cell,
 *   E_XLSX_MALFORMED_XML for undecodable or malformed worksheet XML, or any of
 *   the refusals listed on `readEntry`.
 */
function readSheetRows(filePath, partName, columnLetters = null) {
  const selection = normalizeColumnSelection(columnLetters);
  const xml = decodePartText(readEntry(filePath, partName), partName, filePath);

  const sheetDataStart = findElementStart(xml, ELEMENT_SHEET_DATA, 0, xml.length);
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
 * Reads one column of a worksheet, header first.
 *
 * Exactly one value is returned per `<row>` element, in document order, so
 * index 0 is the header row and index i stays aligned with the i-th row. A
 * row that has no cell in the requested column contributes the empty string
 * rather than being skipped, because skipping it would shift every later
 * value and quietly misalign the caller's rows.
 *
 * Only the requested column is decoded. Reading the Student ID column of
 * `student_details.xlsx` therefore does not materialise the name, date of
 * birth, email, phone or city held in the same rows, which is the data
 * boundary the feature is documented to keep.
 *
 * @param {string} filePath Path to the .xlsx package, used exactly as given.
 * @param {string} partName The worksheet part, normally
 *   `'xl/worksheets/sheet1.xml'`.
 * @param {string} columnLetter The column, case-insensitive, for example `'A'`
 *   or `'C'`.
 * @returns {string[]} Eleven values for column A of `student_details.xlsx`:
 *   the header `'Student ID'` at index 0, then `'S001'` through `'S010'` at
 *   indexes 1 to 10.
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
