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
 * `Other Info`, column C). Both are plain cells inside a single worksheet
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
 * unsupported package is worse than refusing it. Each refusal is an `Error`
 * whose `code` is the exact string below and whose message names the
 * offending detail. No partial or placeholder data is ever returned with, or
 * instead of, a refusal.
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
 *                Otherwise E_XLSX_TRUNCATED. The same code covers a part whose
 *                XML ends inside a start tag or without its closing tag — in
 *                every one of those cases the bytes stop before the structure
 *                does.
 *
 * Refusals are raised while the entry chain is walked, for every entry in the
 * package rather than only the one being fetched. That is deliberate: a
 * package holding an entry this reader cannot read is not a package it should
 * report on, and the data-descriptor case makes the walk unreliable in any
 * case. So `listEntries` refuses exactly what `readEntry` refuses.
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
 * what to cache and for how long. Element names are read unprefixed, as every
 * writer of these packages produces them.
 *
 * Usage:
 *   const xlsxRead = require('./xlsx-read');
 *   xlsxRead.readColumn('student_details.xlsx', 'xl/worksheets/sheet1.xml', 'A');
 *   // -> ['Student ID', 'S001', 'S002', ... 'S010']
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
 * The refusal codes. Exported nowhere by design — the four public functions
 * are the whole surface, and a test matches on `err.code`, never on message
 * text.
 * ------------------------------------------------------------------------- */

const CODE_UNSUPPORTED_COMPRESSION = 'E_XLSX_UNSUPPORTED_COMPRESSION';
const CODE_UNSUPPORTED_FLAGS = 'E_XLSX_UNSUPPORTED_FLAGS';
const CODE_PART_NOT_FOUND = 'E_XLSX_PART_NOT_FOUND';
const CODE_SHARED_STRINGS_UNSUPPORTED = 'E_XLSX_SHARED_STRINGS_UNSUPPORTED';
const CODE_TRUNCATED = 'E_XLSX_TRUNCATED';

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
const COLUMN_LETTER_PATTERN = /^[A-Z]{1,3}$/;
const CELL_REFERENCE_PATTERN = /^([A-Z]{1,3})([0-9]+)$/;
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
 * thrown so each call site reads as `throw refuse(...)`, keeping the control
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
 * @param {unknown} columnLetter For example `'A'`, `'c'`, or `'AA'`.
 * @returns {string} The uppercase letters.
 */
function normalizeColumnLetter(columnLetter) {
  requireNonEmptyString(columnLetter, 'columnLetter');
  const normalized = columnLetter.toUpperCase();
  if (!COLUMN_LETTER_PATTERN.test(normalized)) {
    throw new TypeError(
      `xlsx-read: columnLetter must be 1 to ${MAX_COLUMN_LETTERS} letters (A to XFD); received ${JSON.stringify(columnLetter)}`
    );
  }
  return normalized;
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
 * @param {string} reference The value of a cell's `r` attribute.
 * @returns {string|null} The uppercase column letters, or null when the
 *   reference is not of that form.
 */
function columnLettersFromCellReference(reference) {
  const match = CELL_REFERENCE_PATTERN.exec(reference.toUpperCase());
  return match === null ? null : match[1];
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
 * Finds the start of the next `<tagName` element, requiring a real delimiter
 * after the name so a search for `<c` never matches `<cols`.
 *
 * @param {string} xml The document being scanned.
 * @param {string} tagName Unprefixed element name.
 * @param {number} fromIndex Where to start looking.
 * @returns {number} The index of the `<`, or -1 when there is no further
 *   occurrence.
 */
function findElementStart(xml, tagName, fromIndex) {
  const needle = `<${tagName}`;
  let index = fromIndex;
  while (index < xml.length) {
    index = xml.indexOf(needle, index);
    if (index === -1) {
      return -1;
    }
    const delimiter = xml[index + needle.length];
    if (delimiter === undefined) {
      return -1;
    }
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
 * @param {string} xml The document being scanned.
 * @param {number} startIndex Index of the `<`.
 * @param {string} tagName Unprefixed element name.
 * @param {string} partName Part name, for the refusal message.
 * @param {string} filePath Package path, for the refusal message.
 * @returns {{attributes: Object<string, string>, selfClosing: boolean, contentStart: number}}
 */
function parseStartTag(xml, startIndex, tagName, partName, filePath) {
  const attributes = {};
  let index = startIndex + 1 + tagName.length;
  let selfClosing = false;
  let closed = false;

  while (index < xml.length) {
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
      continue;
    }

    let nameEnd = index;
    while (
      nameEnd < xml.length &&
      xml[nameEnd] !== '=' &&
      xml[nameEnd] !== '/' &&
      xml[nameEnd] !== '>' &&
      !XML_WHITESPACE.includes(xml[nameEnd])
    ) {
      nameEnd += 1;
    }
    if (nameEnd === index) {
      // A stray delimiter where an attribute name should be. Step over it
      // rather than stall: guaranteed forward progress matters more than
      // salvaging a tag that is already malformed, and a reader that hangs is
      // worse than one that returns what it could read.
      index += 1;
      continue;
    }
    const attributeName = xml.slice(index, nameEnd);
    index = nameEnd;
    while (index < xml.length && XML_WHITESPACE.includes(xml[index])) {
      index += 1;
    }
    if (xml[index] !== '=') {
      // A valueless attribute is not well-formed XML, but recording it as
      // empty and moving on keeps one malformed attribute from costing the
      // whole sheet.
      attributes[attributeName] = '';
      continue;
    }
    index += 1;
    while (index < xml.length && XML_WHITESPACE.includes(xml[index])) {
      index += 1;
    }
    const quote = xml[index];
    if (quote === '"' || quote === "'") {
      const valueEnd = xml.indexOf(quote, index + 1);
      if (valueEnd === -1) {
        throw refuse(
          CODE_TRUNCATED,
          `xlsx-read: part ${partName} of ${filePath} ends inside the value of attribute ${attributeName} on <${tagName}>`
        );
      }
      attributes[attributeName] = decodeXmlText(xml.slice(index + 1, valueEnd));
      index = valueEnd + 1;
      continue;
    }
    let valueEnd = index;
    while (
      valueEnd < xml.length &&
      xml[valueEnd] !== '/' &&
      xml[valueEnd] !== '>' &&
      !XML_WHITESPACE.includes(xml[valueEnd])
    ) {
      valueEnd += 1;
    }
    attributes[attributeName] = decodeXmlText(xml.slice(index, valueEnd));
    index = valueEnd;
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
 * @param {string} partName Part name, for the refusal message.
 * @param {string} filePath Package path, for the refusal message.
 * @returns {{contentEnd: number, nextIndex: number}}
 */
function findClosingTag(xml, tagName, fromIndex, partName, filePath) {
  const closing = `</${tagName}>`;
  const contentEnd = xml.indexOf(closing, fromIndex);
  if (contentEnd === -1) {
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
 * @param {string} fragment A cell's inner XML.
 * @param {string} partName Part name, for the refusal message.
 * @param {string} filePath Package path, for the refusal message.
 * @returns {string} The concatenated text, empty when there is no `<t>`.
 */
function collectTextElements(fragment, partName, filePath) {
  let text = '';
  let cursor = 0;
  for (;;) {
    const start = findElementStart(fragment, ELEMENT_TEXT, cursor);
    if (start === -1) {
      return text;
    }
    const tag = parseStartTag(fragment, start, ELEMENT_TEXT, partName, filePath);
    if (tag.selfClosing) {
      cursor = tag.contentStart;
      continue;
    }
    const closing = findClosingTag(fragment, ELEMENT_TEXT, tag.contentStart, partName, filePath);
    text += decodeXmlText(fragment.slice(tag.contentStart, closing.contentEnd));
    cursor = closing.nextIndex;
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
 * Decompresses one walked entry.
 *
 * @param {Buffer} buffer The whole package.
 * @param {{name: string, method: number, dataStart: number, compressedSize: number}} entry
 * @returns {Buffer} The entry's bytes.
 */
function decompressEntry(buffer, entry) {
  const compressed = buffer.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === COMPRESSION_DEFLATE) {
    // Raw inflate: ZIP entry data carries no zlib wrapper, so the wrapped
    // variant would reject the very first byte.
    return zlib.inflateRawSync(compressed);
  }
  // STORED. Copied rather than handed back as a view, so the returned buffer
  // does not keep the whole package alive in memory.
  return Buffer.from(compressed);
}


/* ------------------------------------------------------------------------- *
 * Cells
 * ------------------------------------------------------------------------- */

/**
 * Resolves one cell to its string value.
 *
 * The cases, all of them declared rather than left to chance:
 *   - `t="inlineStr"` — the text of the nested `<is><t>` element(s).
 *   - `t="n"` — the text of `<v>`, returned verbatim as a string so a float
 *     such as 8.199999999999999 keeps every digit it was written with.
 *   - `t="s"` — refused. The index would need an `xl/sharedStrings.xml` part
 *     to resolve against, no workbook here has one, and an empty value in its
 *     place would corrupt the key set.
 *   - no `t` at all — implicitly numeric per ECMA-376, so the text of `<v>`.
 *   - any other `t` (`b`, `d`, `e`, `str`) — the text of `<v>` verbatim. That
 *     is the literal the package stored, so it is faithful rather than lossy;
 *     no interpretation and no date-serial conversion is applied.
 *   - empty, self-closing, or holding no `<v>` — the empty string, without
 *     throwing.
 * A cell's `s` style index is read by nothing here: no style parsing.
 *
 * @param {string} cellXml The cell's inner XML, empty when self-closing.
 * @param {string} reference The cell's `r` attribute, for messages.
 * @param {Object<string, string>} attributes The cell's attributes.
 * @param {string} partName Part name, for the refusal messages.
 * @param {string} filePath Package path, for the refusal messages.
 * @returns {string} The cell's value.
 */
function cellValue(cellXml, reference, attributes, partName, filePath) {
  const type = attributes.t;

  if (type === CELL_TYPE_SHARED_STRING) {
    throw refuse(
      CODE_SHARED_STRINGS_UNSUPPORTED,
      `xlsx-read: cell ${reference} in part ${partName} of ${filePath} is a shared-string reference (t="s"), which this reader does not resolve because the package has no xl/sharedStrings.xml part`
    );
  }
  if (cellXml.length === 0) {
    return '';
  }
  if (type === CELL_TYPE_INLINE_STRING) {
    return collectTextElements(cellXml, partName, filePath);
  }

  const valueStart = findElementStart(cellXml, ELEMENT_VALUE, 0);
  if (valueStart === -1) {
    return '';
  }
  const valueTag = parseStartTag(cellXml, valueStart, ELEMENT_VALUE, partName, filePath);
  if (valueTag.selfClosing) {
    return '';
  }
  const valueClose = findClosingTag(
    cellXml,
    ELEMENT_VALUE,
    valueTag.contentStart,
    partName,
    filePath
  );
  return decodeXmlText(cellXml.slice(valueTag.contentStart, valueClose.contentEnd));
}

/**
 * Reads the cells of one `<row>` into an object keyed by column letter.
 *
 * Rows are sparse in general, so a missing cell simply has no key and cannot
 * shift the columns that are present — keying is by column letter, never by
 * position in the row. A cell whose `r` attribute is absent takes the next
 * column after the previous cell, which is the ECMA-376 rule and keeps such a
 * cell from being dropped.
 *
 * The object is a plain `{}` with the ordinary prototype, so a caller can
 * compare it against an object literal with a strict deep-equality assertion.
 * Column letters match /^[A-Z]{1,3}$/, so no cell reference can produce a key
 * that reaches the prototype.
 *
 * @param {string} rowXml The row's inner XML.
 * @param {string} partName Part name, for the refusal messages.
 * @param {string} filePath Package path, for the refusal messages.
 * @returns {Object<string, string>} Cell values keyed by column letter.
 */
function parseRow(rowXml, partName, filePath) {
  const cells = {};
  let cursor = 0;
  let nextImplicitColumn = 0;

  for (;;) {
    const cellStart = findElementStart(rowXml, ELEMENT_CELL, cursor);
    if (cellStart === -1) {
      return cells;
    }
    const tag = parseStartTag(rowXml, cellStart, ELEMENT_CELL, partName, filePath);

    let cellXml = '';
    if (tag.selfClosing) {
      cursor = tag.contentStart;
    } else {
      const closing = findClosingTag(rowXml, ELEMENT_CELL, tag.contentStart, partName, filePath);
      cellXml = rowXml.slice(tag.contentStart, closing.contentEnd);
      cursor = closing.nextIndex;
    }

    const reference = typeof tag.attributes.r === 'string' ? tag.attributes.r : '';
    let columnLetters = reference.length === 0 ? null : columnLettersFromCellReference(reference);
    if (columnLetters === null) {
      columnLetters = lettersFromColumnIndex(nextImplicitColumn);
    }
    nextImplicitColumn = columnIndexFromLetters(columnLetters) + 1;

    cells[columnLetters] = cellValue(
      cellXml,
      reference.length === 0 ? columnLetters : reference,
      tag.attributes,
      partName,
      filePath
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
 * @param {string} filePath Path to the .xlsx package, used exactly as given.
 * @returns {string[]} The part names, for example
 *   `['docProps/app.xml', ..., '[Content_Types].xml']` (9 names for each
 *   workbook in this repository, with `[Content_Types].xml` last).
 * @throws {TypeError} When `filePath` is not a non-empty string.
 * @throws {Error} E_XLSX_UNSUPPORTED_FLAGS, E_XLSX_UNSUPPORTED_COMPRESSION or
 *   E_XLSX_TRUNCATED when the package falls outside the supported subset.
 */
function listEntries(filePath) {
  requireNonEmptyString(filePath, 'filePath');
  const buffer = fs.readFileSync(filePath);
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

  const buffer = fs.readFileSync(filePath);
  const entries = walkPackageEntries(buffer, filePath);
  const entry = entries.find((candidate) => candidate.name === partName);
  if (entry === undefined) {
    throw refuse(
      CODE_PART_NOT_FOUND,
      `xlsx-read: ${filePath} has no part named ${partName}; it holds ${entries.length} part(s): ${entries.map((candidate) => candidate.name).join(', ')}`
    );
  }
  return decompressEntry(buffer, entry);
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
 * @param {string} filePath Path to the .xlsx package, used exactly as given.
 * @param {string} partName The worksheet part, normally
 *   `'xl/worksheets/sheet1.xml'`.
 * @returns {Array<Object<string, string>>} For example
 *   `[{A: 'Student ID', B: 'Name', ...}, {A: 'S001', B: 'Aarav Sharma', ...}]`.
 * @throws {TypeError} When an argument is not a non-empty string.
 * @throws {Error} E_XLSX_SHARED_STRINGS_UNSUPPORTED for a `t="s"` cell, or any
 *   of the refusals listed on `readEntry`.
 */
function readSheetRows(filePath, partName) {
  const xml = readEntry(filePath, partName).toString('utf8');

  const sheetDataStart = findElementStart(xml, ELEMENT_SHEET_DATA, 0);
  if (sheetDataStart === -1) {
    return [];
  }
  const sheetDataTag = parseStartTag(xml, sheetDataStart, ELEMENT_SHEET_DATA, partName, filePath);
  if (sheetDataTag.selfClosing) {
    return [];
  }
  const sheetDataClose = findClosingTag(
    xml,
    ELEMENT_SHEET_DATA,
    sheetDataTag.contentStart,
    partName,
    filePath
  );
  const sheetData = xml.slice(sheetDataTag.contentStart, sheetDataClose.contentEnd);

  const rows = [];
  let cursor = 0;
  for (;;) {
    const rowStart = findElementStart(sheetData, ELEMENT_ROW, cursor);
    if (rowStart === -1) {
      return rows;
    }
    const rowTag = parseStartTag(sheetData, rowStart, ELEMENT_ROW, partName, filePath);
    if (rowTag.selfClosing) {
      rows.push({});
      cursor = rowTag.contentStart;
      continue;
    }
    const rowClose = findClosingTag(sheetData, ELEMENT_ROW, rowTag.contentStart, partName, filePath);
    rows.push(parseRow(sheetData.slice(rowTag.contentStart, rowClose.contentEnd), partName, filePath));
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
 * @param {string} filePath Path to the .xlsx package, used exactly as given.
 * @param {string} partName The worksheet part, normally
 *   `'xl/worksheets/sheet1.xml'`.
 * @param {string} columnLetter The column, case-insensitive, for example `'A'`
 *   or `'C'`.
 * @returns {string[]} For example
 *   `['Student ID', 'S001', 'S002', ... 'S010']` for column A of
 *   `student_details.xlsx`.
 * @throws {TypeError} When an argument is not a non-empty string, or
 *   `columnLetter` is not 1 to 3 letters.
 * @throws {Error} Any of the refusals listed on `readSheetRows`.
 */
function readColumn(filePath, partName, columnLetter) {
  const normalized = normalizeColumnLetter(columnLetter);
  return readSheetRows(filePath, partName).map((row) =>
    Object.prototype.hasOwnProperty.call(row, normalized) ? row[normalized] : ''
  );
}

module.exports = { readSheetRows, readColumn, readEntry, listEntries };

