'use strict';

/**
 * activity-store.js — persistence and integrity for student-submitted
 * extracurricular activities.
 *
 * WHAT THIS MODULE OWNS
 * ---------------------
 *   1. The key set — which Student IDs exist, read from the authoritative
 *      identity workbook `student_details.xlsx` (sheet `Student Details`,
 *      column A). A Student ID is the FOREIGN key into that workbook.
 *   2. Normalization — the form an activity label takes once accepted, so
 *      `chess club` submitted after `Chess Club` is the same activity rather
 *      than a near-duplicate appended beside it.
 *   3. Persistence — the JSON document holding the records, the validation it
 *      is put through on every load, and the atomic write that replaces it.
 *
 * `activities.js` owns the HTTP contract: it parses a request, calls this
 * module's normalization, membership, write and read functions, and maps their
 * outcomes onto status codes. It performs no normalization, holds no key set of
 * its own, and has no use for the store's location — `storePath()` serves a
 * caller that has to name the file. The split is deliberate: "validate in the
 * HTTP layer, normalize in the store" would spread one rule across two files
 * and leave neither able to enforce it.
 *
 * Records go to a JSON document that is a runtime artifact, never committed;
 * the workbooks are READ ONLY here and are never written. It is seeded once,
 * when first materialised, from the `Extracurricular Activity` column of
 * `student_other_info.xlsx`, so it is a superset of what that column already
 * records rather than a second, disagreeing source of truth. Seeded records
 * are marked `source: "workbook"` and deliberately carry NO `submittedAt`,
 * because inventing a timestamp would fabricate provenance and make imported
 * data indistinguishable from a real submission.
 *
 * THE FAILURE VOCABULARY
 * ----------------------
 * Every refusal carries a `code`. A request-time code is what `activities.js`
 * maps to a status and what a test matches on; the last entry below is a
 * load-time configuration fault that no request can reach:
 *
 *   E_REFERENCE_DATA       A workbook could not be read, or holds data that
 *                          cannot serve as reference data. -> 500
 *   E_LABEL_INVALID        An activity label failed normalization. -> 400
 *   E_STORE_UNREADABLE     The store failed load validation. -> 500
 *   E_STORE_WRITE_FAILED   A write or rename failed, process alive. -> 500
 *   E_STORE_PATH_PROTECTED `ACTIVITY_STORE` names a tracked file of this
 *                          repository. A CONFIGURATION fault, not a request
 *                          outcome: a `RangeError` thrown at MODULE LOAD, so
 *                          `require` fails and no response can carry it, which
 *                          stops the process instead of letting the first
 *                          submission rename a document over a workbook or
 *                          over `LICENSE`. -> no status
 *
 * Messages name the offending detail for a log but carry no filesystem path
 * and no stack: the underlying fault travels as the error's `cause`, and the
 * HTTP layer sends a fixed sentence per code. An argument fault is a caller
 * bug rather than a runtime condition, so it is a plain `TypeError` or
 * `RangeError` carrying no `code` at all.
 *
 * Every failure path is NON-DESTRUCTIVE: a store this module refuses to load
 * is left exactly as found, never overwritten and never silently repaired,
 * because the document is a plain file a person can edit and a hand-edit
 * mistake should cost an error response rather than the data.
 *
 * Asynchronous where it touches the store, synchronous where it reads a
 * workbook. Single-process: the write mutex is a module-level promise chain,
 * which orders this process's writes and is not a substitute for locking
 * across processes.
 */

const fs = require('node:fs/promises');
/* The synchronous surface, for the ONE thing the promise API cannot do at
 * module load: canonicalize the configured store path before anything is read
 * or written. A module body cannot await, and the check has to complete
 * before the first export is handed out. Everything else in this file stays
 * on `node:fs/promises`. Both are the same built-in, so no dependency is
 * added. */
const fsSync = require('node:fs');
const path = require('node:path');
const xlsxRead = require('./xlsx-read');

/* ------------------------------------------------------------------------- *
 * The store location, read from `ACTIVITY_STORE`.
 *
 * Resolved ONCE, here at module load. Changing the variable later in the
 * process has no effect, which is the documented behaviour: a store path that
 * moved under a running service would split the records across two files.
 *
 * The value is used exactly as given, matching the convention `xlsx-read.js`
 * documents for its own paths, so what `storePath()` returns is precisely what
 * was configured. A relative value is therefore interpreted against the
 * working directory; an absolute one is recommended.
 *
 * The staging path is DERIVED from the resolved path rather than named
 * independently, so it follows the variable wherever it points and always
 * sits in the same directory — hence on the same filesystem, which is what
 * makes the rename in `writeDocument` atomic rather than a copy.
 *
 * The one destination the variable may NOT name is a tracked file of this
 * repository; the block immediately below refuses that at load.
 * ------------------------------------------------------------------------- */

const DEFAULT_STORE_FILE_NAME = 'activities.json';
const TEMPORARY_FILE_SUFFIX = '.tmp';

const RESOLVED_STORE_PATH =
  process.env.ACTIVITY_STORE || path.join(__dirname, DEFAULT_STORE_FILE_NAME);
const RESOLVED_TEMPORARY_PATH = RESOLVED_STORE_PATH + TEMPORARY_FILE_SUFFIX;

/* ------------------------------------------------------------------------- *
 * The destinations this module refuses to write, and the load-time check.
 *
 * `ACTIVITY_STORE` is external configuration and a write is a `rename` OVER
 * the target, not an append: a mistyped value pointing at a workbook or at
 * `LICENSE` would not corrupt that file, it would REPLACE it. The workbooks
 * and `LICENSE` are read-only to this feature, so the guarantee has to be
 * mechanical rather than a documented expectation.
 *
 * The comparison is by filesystem IDENTITY rather than by string, because a
 * file can have more than one name: `./LICENSE` and `test/../LICENSE` are
 * collapsed by resolution, but a Windows 8.3 short name, a junction, a
 * symbolic link and a mapped drive are not, and a guard that compared names
 * would refuse the spelling it expected while accepting every other spelling
 * of the same file. `canonicalizeForComparison` below is what settles that.
 *
 * The refusal is at MODULE LOAD, before a single read or write can happen,
 * and it is a `RangeError` carrying `E_STORE_PATH_PROTECTED` — see the
 * failure vocabulary in the header: it is a CONFIGURATION fault rather than a
 * request-time refusal, and `activities.js` neither maps it nor can ever meet
 * it. Failing fast is the point: a static misconfiguration should stop the
 * service starting rather than let every request rediscover it, and stopping
 * at load is what proves nothing was staged over protected data in the
 * meantime.
 * ------------------------------------------------------------------------- */

/**
 * The refusal code for a protected destination. Deliberately apart from the
 * request-time codes in the section below: those describe the outcome of a
 * request and reach a client as a status, while this one reports a
 * misconfiguration and can only ever be thrown out of `require`.
 */
const CODE_STORE_PATH_PROTECTED = 'E_STORE_PATH_PROTECTED';

/**
 * The tracked files of this repository, none of which the activity store may
 * ever write: the read-only reference data — the three workbooks and
 * `LICENSE` — and the project's own source, manifest, configuration and test
 * files. Named repository-relative, with `/` as the separator, and joined
 * against `__dirname` below, so the list reads as the repository rather than
 * as one host's paths.
 *
 * `activities.json` and `activities.json.tmp` are deliberately ABSENT: they
 * are the default store and its staging sibling, which this module exists to
 * write, and which `.gitignore` keeps untracked.
 */
const PROTECTED_REPOSITORY_FILES = [
  'student_details.xlsx',
  'student_academics.xlsx',
  'student_other_info.xlsx',
  'LICENSE',
  'server.js',
  'activities.js',
  'activity-store.js',
  'xlsx-read.js',
  'package.json',
  'package-lock.json',
  '.nvmrc',
  '.gitignore',
  'README.md',
  'test/activities.test.js',
  'test/store.test.js',
  'test/lifecycle.test.js',
];

/**
 * Whether the filesystem holding this repository compares names without
 * regard to case. The filesystem is asked rather than `process.platform`
 * consulted.
 *
 * The probe flips the case of this module's own file name and asks whether
 * that name resolves beside it. The file is guaranteed to be there: it is the
 * one being loaded. So a hit can only mean the filesystem folded the case,
 * and a miss can only mean it did not.
 *
 * A platform test — `win32 || darwin` — is wrong in both directions: a
 * case-SENSITIVE APFS or ReFS volume would be assumed to fold, and a
 * case-insensitive volume mounted under Linux would be assumed not to.
 * Folding where the filesystem does not is the damaging direction for this
 * guard, because it would false-refuse a genuinely distinct name such as
 * `license` sitting beside `LICENSE`. For a candidate that EXISTS the question
 * does not arise at all — `canonicalizeForComparison` gets the filesystem's
 * own identity for it — and this constant is applied only to the fallback
 * form below.
 *
 * `fs.existsSync` reports `false` rather than throwing for every failure, so
 * the probe cannot itself raise at module load. The platform default survives
 * for the one case the probe cannot express: a module file name with no cased
 * letter to flip, which this name is not and which only a rename could
 * introduce.
 */
const CASE_INSENSITIVE_FILESYSTEM = (() => {
  const ownName = path.basename(__filename);
  const flippedName =
    ownName === ownName.toLowerCase() ? ownName.toUpperCase() : ownName.toLowerCase();
  if (flippedName === ownName) {
    return process.platform === 'win32' || process.platform === 'darwin';
  }
  return fsSync.existsSync(path.join(__dirname, flippedName));
})();

/**
 * Builds a canonical form of a path for COMPARISON ONLY.
 *
 * Never used as a path to open. `RESOLVED_STORE_PATH` stays exactly what was
 * configured, and `storePath()` returns it verbatim, so this form exists
 * solely to decide whether two strings name one file.
 *
 * Two forms, and which one is produced depends on whether the candidate
 * exists on disk:
 *
 *   1. IT EXISTS — `fs.realpathSync.native` of the whole resolved path. That
 *      is the filesystem's own answer to "which file is this", so it collapses
 *      every alias the host offers rather than the ones this code thought to
 *      anticipate: a Windows 8.3 short name (`STUDEN~2.XLS` ->
 *      `student_details.xlsx`), the on-disk casing, a symbolic link, a
 *      junction, a substituted or mapped drive, and the `::$DATA` stream
 *      spelling of a file. No platform assumption is involved and no case
 *      folding is needed — two names of one file produce one identical string.
 *   2. IT DOES NOT EXIST — `path.resolve`, then the real path of the PARENT
 *      directory with the resolved basename rejoined, case-folded where the
 *      filesystem folds case. This is the ordinary case for a store that is
 *      about to be created, and the only reason a fallback is needed at all:
 *      there is nothing on disk to interrogate.
 *
 * The fallback is sound because of what it cannot miss. A path that does not
 * exist cannot BE an existing protected file, so the only collision left for
 * it to report is one against a protected file that is itself absent from the
 * checkout — a partial or hand-pruned tree — and that collision is still
 * caught, because both sides of the comparison are produced by this same
 * function and so take the same branch for the same file.
 *
 * All of this work happens while the module is loading. The protected map
 * this feeds is built there, once, and no request path calls it again, so the
 * filesystem interrogation costs a request nothing.
 *
 * @param {string} candidate The path to canonicalize.
 * @returns {string} A form that compares equal for two names of one file.
 */
function canonicalizeForComparison(candidate) {
  const absolute = path.resolve(candidate);

  try {
    return fsSync.realpathSync.native(absolute);
  } catch {
    /* Not resolvable as a whole: the candidate itself, or a directory on the
     * way to it, is absent. The parent-relative form below stands in. */
  }

  const parent = path.dirname(absolute);
  let realParent = parent;
  try {
    realParent = fsSync.realpathSync.native(parent);
  } catch {
    /* A configured-but-missing parent directory is a legitimate state: the
     * store refuses the eventual write with E_STORE_WRITE_FAILED rather than
     * creating the directory. So the resolved form stands in for the real
     * one, which still compares correctly against a protected entry built the
     * same way. */
    realParent = parent;
  }

  const rejoined = path.join(realParent, path.basename(absolute));
  return CASE_INSENSITIVE_FILESYSTEM ? rejoined.toLowerCase() : rejoined;
}

/**
 * The protected files by canonical form, mapping back to the
 * repository-relative name a refusal should quote. Built once, at load.
 *
 * Every entry goes through `canonicalizeForComparison` — the same function
 * every candidate goes through — so an entry and a candidate that name one
 * file take the same branch there and produce the same string. That symmetry
 * is what makes the lookup below a single `Map.get` rather than a scan with
 * per-platform special cases.
 *
 * @type {Map<string, string>}
 */
const PROTECTED_DESTINATIONS = new Map(
  PROTECTED_REPOSITORY_FILES.map((relativeName) => [
    canonicalizeForComparison(path.join(__dirname, ...relativeName.split('/'))),
    relativeName,
  ])
);

/**
 * Refuses a configured destination that names a protected repository file.
 *
 * Both the store path and its derived staging sibling are checked. No
 * protected name ends in `.tmp`, so the derived path can only collide through
 * a store path that already collides — but it is checked rather than reasoned
 * about, because the derivation is a string concatenation that a future
 * change to `TEMPORARY_FILE_SUFFIX` could invalidate silently.
 *
 * @param {string} candidate The configured or derived destination.
 * @param {string} role How the message should describe it.
 * @returns {void}
 * @throws {RangeError} `E_STORE_PATH_PROTECTED` when it names a protected
 *   file. The message carries the repository-relative name rather than an
 *   absolute path, so a log line stays free of host detail.
 */
function refuseProtectedDestination(candidate, role) {
  const collision = PROTECTED_DESTINATIONS.get(canonicalizeForComparison(candidate));
  if (collision === undefined) {
    return;
  }
  const error = new RangeError(
    `activity-store: ACTIVITY_STORE resolves ${role} to ${collision}, a file of this repository that the activity store must never write; point ACTIVITY_STORE at a path outside the repository`
  );
  error.code = CODE_STORE_PATH_PROTECTED;
  // Carries a diagnostic like every other refusal this module raises, so the
  // shape `diagnosticFor` documents holds for all of them rather than most.
  // This one is raised at module load and so reaches no request, but a caller
  // that reads the field defensively should not have to special-case it.
  error.diagnostic = diagnosticFor('store_path_protected', null, undefined);
  throw error;
}

refuseProtectedDestination(RESOLVED_STORE_PATH, 'the store');
refuseProtectedDestination(RESOLVED_TEMPORARY_PATH, 'the derived staging sibling');

/* ------------------------------------------------------------------------- *
 * The document and record vocabulary.
 * ------------------------------------------------------------------------- */

/**
 * The document version this module reads and writes. A document declaring any
 * other version is refused on load rather than guessed at: a shape this code
 * does not know could not be validated, and rewriting it whole in the canonical
 * form below would discard whatever the other version carried.
 */
const SCHEMA_VERSION = 1;

/** A record that arrived through the intake surface. Carries `submittedAt`. */
const SOURCE_SUBMISSION = 'submission';

/** A record seeded from the workbook column. Carries NO `submittedAt`. */
const SOURCE_WORKBOOK = 'workbook';

/**
 * The document's own keys, exhaustively. A document carrying anything else is
 * REFUSED rather than read, because this module rewrites the document whole in
 * canonical form on every change: an unrecognized key that loaded cleanly
 * would be erased by the next submission, which is data loss dressed up as a
 * successful write.
 */
const RECOGNIZED_DOCUMENT_KEYS = new Set(['schemaVersion', 'activities']);

/**
 * The union of a record's own keys across both provenances, for the same
 * reason. This set is deliberately the UNION and not the per-source shape —
 * `submittedAt` belongs to a `submission` record only. The narrower
 * per-source rule is enforced separately in `validateRecord`, which is what
 * makes the two rules together say exactly: a `workbook` record carries
 * `studentId`, `activity` and `source`; a `submission` record carries those
 * three plus `submittedAt`; nothing carries anything else.
 */
const RECOGNIZED_RECORD_KEYS = new Set(['studentId', 'activity', 'source', 'submittedAt']);

/** Indentation for the serialized document, so a person can read and edit it. */
const JSON_INDENT = 2;

/* ------------------------------------------------------------------------- *
 * The two ceilings on the document.
 *
 * WHY THEY EXIST. The store is a hand-editable file that grows by one record
 * per distinct submission, and the load path reads the whole file, decodes it,
 * parses it, allocates one canonical record per array element, and — on a
 * write — stringifies the result again. Without a bound, one oversized hand
 * edit or an unbounded stream of distinct submissions exhausts memory before
 * any shape validation has run, which is a fault no amount of later checking
 * can catch because the process is already gone.
 *
 * WHY THERE ARE TWO OF THEM, AND WHY NEITHER IMPLIES THE OTHER. They measure
 * different things: the record count bounds how much the load path ALLOCATES,
 * and the byte count bounds how much it READS. A dense document well inside
 * 2 MiB can still carry a great many records, and — the direction that is
 * easy to get wrong — a document inside the record ceiling can still exceed
 * the byte ceiling. A typical record serializes to roughly 200 bytes, so 5000
 * of them are about 1 MB; but `MAX_LABEL_LENGTH` is counted in UTF-16 CODE
 * UNITS, and `JSON.stringify` escapes an unpaired surrogate to a six-byte
 * `\uD800` sequence, so a 60-unit label can serialize to 360 bytes and 5000
 * such records to well over 2 MiB. Arithmetic over a typical record is
 * therefore NOT a guarantee, and this module does not rely on one.
 *
 * WHAT MAKES THE TWO AGREE IS A CHECK, NOT AN ESTIMATE. `writeDocument`
 * measures the serialized bytes it is about to persist and refuses over the
 * byte ceiling BEFORE anything is staged, so a submission can never publish a
 * document that this module's own loader would then refuse on size — the
 * self-unreadable store that the record ceiling alone did not prevent.
 *
 * WHY THEY ARE SAFE FOR THE REAL WORKLOAD. The expected shape is ten students
 * with a handful of activities each — the seeded document is 11 records and
 * about 2 KB — so both ceilings sit orders of magnitude above anything the
 * feature is for, and neither can refuse a legitimate document. They are a
 * bound on a runaway, not a quota on a user.
 *
 * Both are enforced on the LOAD path as E_STORE_UNREADABLE. Before a write,
 * the record count is enforced as E_STORE_WRITE_FAILED and so is the
 * serialized byte length. None of the four ever repairs, truncates or
 * rewrites anything: a document at or over a ceiling is left exactly as
 * found, like every other refused load, and a refused write stages nothing.
 * ------------------------------------------------------------------------- */

/**
 * The largest store this module will read, in bytes. Checked three times, for
 * three different failures: against the opened descriptor's size, against the
 * bytes actually delivered — so a file that grows between the two cannot slip
 * past it — and against the serialized length of a document about to be
 * written, so the writer cannot publish one the reader would refuse.
 */
const MAX_STORE_BYTES = 2 * 1024 * 1024;

/**
 * The most records a document may hold. Refused on load before the per-record
 * loop allocates anything, and refused before an append that would exceed it.
 */
const MAX_ACTIVITY_RECORDS = 5000;

/**
 * How much of the store is read per `read` call: one 64 KiB buffer, reused for
 * the life of the call rather than one allocation per chunk. Large enough that
 * a 2 MiB ceiling costs at most 32 reads, small enough that the read is
 * genuinely incremental instead of one unbounded allocation.
 */
const STORE_READ_CHUNK_BYTES = 64 * 1024;

/* ------------------------------------------------------------------------- *
 * Validation vocabulary.
 *
 * A Student ID is the literal `S` followed by exactly three decimal digits.
 * The pattern decides only whether a value is a CANDIDATE: column A of
 * `student_details.xlsx` is the authority for which identifiers actually
 * exist, and membership in that key set is checked separately.
 * ------------------------------------------------------------------------- */

const STUDENT_ID_PATTERN = /^S\d{3}$/;

const MIN_LABEL_LENGTH = 1;
const MAX_LABEL_LENGTH = 60;

/**
 * Control characters AND line separators, rejected in any label:
 *
 *   - C0, `\u0000`-`\u001f`, which includes tab, newline and carriage return;
 *   - DEL and C1, `\u007f`-`\u009f`;
 *   - `\p{Zl}` LINE SEPARATOR (U+2028) and `\p{Zp}` PARAGRAPH SEPARATOR
 *     (U+2029).
 *
 * The last two are here rather than in the trim/collapse class below on
 * purpose. They are line terminators, not spaces — Unicode gives them their
 * own categories precisely because they break a line — so laundering one into
 * a space would ACCEPT a label carrying a line break, exactly as laundering a
 * newline would. A label is a single line of text, so the honest answer for
 * both is refusal. Left out of this class entirely they would be worse than
 * either: neither trimmed, nor collapsed, nor refused, so `Chess\u2028Club`
 * would persist and produce a composite key distinct from `Chess Club`, and
 * the loader would then read it back as already normalized.
 */
const CONTROL_OR_LINE_SEPARATOR_PATTERN = /[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}]/u;

/**
 * The whitespace that is trimmed and collapsed. Deliberately the Unicode
 * SPACE SEPARATOR category and nothing else.
 *
 * This is the load-bearing choice in normalization. Using a general `\s`
 * class would silently launder a tab, a newline or a U+2028 LINE SEPARATOR
 * into a space, so a label carrying one would be ACCEPTED instead of refused.
 * Because none of those is a space separator, each survives trimming and
 * collapsing untouched and is then rejected by the check that follows — which
 * is both what the specification asks for and the only order in which the two
 * rules do not cancel each other out.
 */
const LEADING_SPACE_PATTERN = /^\p{Zs}+/u;
const TRAILING_SPACE_PATTERN = /\p{Zs}+$/u;
const INTERNAL_SPACE_RUN_PATTERN = /\p{Zs}+/gu;

/**
 * The ONLY rule by which a workbook label counts as blank, and therefore as a
 * row that records nothing.
 *
 * Deliberately the same space-separator class the three patterns above use,
 * for a reason that is the whole of the bug it replaces. The previous test was
 * `rawLabel.trim() === ''`, and `String.prototype.trim` strips `\t`, `\n`,
 * `\v`, `\f` and `\r` — every one of which is a C0 CONTROL CHARACTER that
 * `CONTROL_OR_LINE_SEPARATOR_PATTERN` exists to refuse. A cell holding a lone
 * tab therefore tested as blank and its row was SKIPPED, so `inspectLabel`
 * never saw it and the no-control-character rule was dead for exactly the
 * values most likely to arrive from a hand-edited spreadsheet.
 *
 * Matching `inspectLabel`'s trim class instead makes the two rules agree by
 * construction: a value this pattern calls blank is one `inspectLabel` would
 * also reduce to the empty string, and every value it does not call blank goes
 * through `inspectLabel` and is answered there — accepted if it normalizes,
 * refused if it carries a control character or a line separator.
 *
 * Note the `*` rather than `+`: an absent cell arrives as the empty string,
 * which is blank.
 */
const SPACE_SEPARATOR_ONLY_PATTERN = /^\p{Zs}*$/u;

/**
 * An ISO-8601 instant in UTC, with optional sub-second precision. The capture
 * groups are not decoration: `Date.parse` accepts an impossible calendar date
 * such as `2026-02-31T00:00:00Z` and silently rolls it forward, so the
 * components have to be compared back against the parsed instant.
 */
const ISO_UTC_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

/* ------------------------------------------------------------------------- *
 * Reference data: which workbook, which part, which column.
 *
 * Only the worksheet part is ever read. No document-properties part is
 * opened, because no timestamp is taken from a workbook.
 *
 * Paths are built from `__dirname` so the workbooks are found beside this
 * module regardless of the working directory the service was started from —
 * `xlsx-read.js` uses the path exactly as given and resolves nothing itself.
 * ------------------------------------------------------------------------- */

const WORKSHEET_PART = 'xl/worksheets/sheet1.xml';

const KEY_SET_WORKBOOK = 'student_details.xlsx';
const KEY_SET_COLUMN = 'A';

const SEED_WORKBOOK = 'student_other_info.xlsx';
const SEED_STUDENT_ID_COLUMN = 'A';
const SEED_LABEL_COLUMN = 'C';

/**
 * `readColumn` returns one value per worksheet row with the header first, so
 * every scan of reference data starts at index 1.
 */
const FIRST_DATA_ROW_INDEX = 1;

/* ------------------------------------------------------------------------- *
 * The request-time refusal codes. Not exported: the functions at the foot of
 * the file are the whole surface, and a caller matches on `err.code`.
 * ------------------------------------------------------------------------- */

const CODE_REFERENCE_DATA = 'E_REFERENCE_DATA';
const CODE_LABEL_INVALID = 'E_LABEL_INVALID';
const CODE_STORE_UNREADABLE = 'E_STORE_UNREADABLE';
const CODE_STORE_WRITE_FAILED = 'E_STORE_WRITE_FAILED';

/* ------------------------------------------------------------------------- *
 * Errors
 * ------------------------------------------------------------------------- */

/**
 * Builds a refusal carrying one of the request-time refusal codes and its
 * diagnostic.
 *
 * Returned rather than thrown so each call site reads as `throw refuse(...)`,
 * keeping the control flow obvious at the point of rejection. The originating
 * fault travels as `cause`, which keeps a filesystem path out of `message`
 * while leaving the detail available to a log.
 *
 * @param {string} code One of the CODE_* constants.
 * @param {string} message Names the offending detail. No path, no stack.
 * @param {{reason: string, at?: number, cause?: unknown}} diagnosis The stable
 *   token for this refusal, the position it names where it names one, and the
 *   underlying fault where there is one. See `diagnosticFor` for what the
 *   caller may read off the result.
 * @returns {Error} An error carrying `code`, a `cause` where one was given, and
 *   a frozen `diagnostic`.
 */
function refuse(code, message, diagnosis) {
  const { reason, at = null, cause } = diagnosis;
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  error.diagnostic = diagnosticFor(reason, at, cause);
  return error;
}

/**
 * Builds the diagnostic a refusal carries — THE CONTRACT A CALLER READS.
 *
 * `message` is a diagnosis for a person: it names the offending detail, so it
 * holds the configured store path, a stored record's Student ID, an activity
 * label or a workbook name, and it is free to be reworded. `code` is stable
 * but coarse — a dozen unrelated faults are all `E_STORE_UNREADABLE`, which is
 * the right granularity for choosing an HTTP status and useless for telling an
 * operator which fault occurred. `diagnostic` closes that gap as DATA, so no
 * caller has to reconstruct the distinction by searching prose for a phrase:
 *
 *   reason  A stable lower-snake-case token naming which refusal this is. Part
 *           of this module's contract, so a rename is a contract change and
 *           shows up in this file's diff.
 *   detail  The `code` of the underlying fault — a `node:fs` errno such as
 *           `ENOENT`, or the reader's own `E_XLSX_*` code — or `null` when
 *           there was no underlying fault. This is the difference between "the
 *           store could not be written" and knowing the directory was missing,
 *           read-only or full.
 *   at      The position the refusal names: a record's index within the
 *           document, or a workbook row number. `null` when it names none.
 *   number  A bounded numeric the reader rejected, propagated from it. `null`
 *           for every refusal this module raises itself.
 *
 * A REFUSAL FROM `xlsx-read.js` IS ADOPTED RATHER THAN FLATTENED. This module
 * wraps one in a generic sentence of its own, because its callers must not act
 * on the reader's codes; without the adoption below, that wrapper would also
 * destroy the reader's much finer classification, and an unsupported
 * compression method and a missing part would be indistinguishable after the
 * fact. So a cause carrying a diagnostic of its own contributes its `reason`,
 * its `at` and its `number`, and `detail` names the reader code it came from.
 * That is what lets `activities.js` read one level — the error it was handed —
 * and still see which package fault occurred, without reaching through this
 * module into the reader behind it.
 *
 * Every field is a token or a bounded number, never a fragment of a message,
 * so a caller may log the whole object without writing a path, a Student ID or
 * a label anywhere.
 *
 * @param {string} reason This refusal's own token, used unless a wrapped
 *   refusal supplies a more specific one.
 * @param {number|null} at The position this refusal names, or `null`.
 * @param {unknown} cause The underlying fault, or `undefined`.
 * @returns {{reason: string, detail: string|null, at: number|null, number: number|null}}
 *   A frozen diagnostic.
 */
function diagnosticFor(reason, at, cause) {
  const nested = cause !== null && typeof cause === 'object' ? cause : null;
  const detail = nested !== null && typeof nested.code === 'string' ? nested.code : null;
  const inherited = nested === null ? null : nested.diagnostic;

  if (inherited !== null && inherited !== undefined && typeof inherited === 'object') {
    return Object.freeze({
      reason: typeof inherited.reason === 'string' ? inherited.reason : reason,
      detail,
      at: typeof inherited.at === 'number' ? inherited.at : at,
      number: typeof inherited.number === 'number' ? inherited.number : null,
    });
  }

  return Object.freeze({ reason, detail, at, number: null });
}

/**
 * Names the `code` of an underlying fault for a message, without assuming the
 * thing thrown was an `Error` at all.
 *
 * @param {unknown} cause The caught value.
 * @returns {string} For example `'ENOENT'` or `'an unidentified fault'`.
 */
function describeCause(cause) {
  if (cause !== null && typeof cause === 'object' && typeof cause.code === 'string') {
    return cause.code;
  }
  return 'an unidentified fault';
}

/**
 * Describes a rejected value for a message without stringifying something
 * huge, cyclic, or carrying a throwing `toString`.
 *
 * @param {unknown} value The offending value.
 * @returns {string} A short, safe description.
 */
function describeValue(value) {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'nothing';
  }
  const type = typeof value;
  if (type === 'string') {
    const clipped = value.length > 60 ? `${value.slice(0, 60)}...` : value;
    return `the string ${JSON.stringify(clipped)}`;
  }
  if (type === 'number' || type === 'boolean') {
    return `the ${type} ${String(value)}`;
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `a value of type ${type}`;
}

/* ------------------------------------------------------------------------- *
 * Normalization
 *
 * `inspectLabel` is the single implementation of the label rules, and it
 * reports its outcome instead of throwing so that each context it serves can
 * raise the code belonging to that context: the workbook seed ingest raises
 * E_REFERENCE_DATA for seed data that could not be stored, the loader raises
 * E_STORE_UNREADABLE for a stored value that fails the rules or passes them
 * without already being in normalized form, and the public `normalizeLabel`
 * raises E_LABEL_INVALID for a submission that fails them. Sharing one
 * implementation is what keeps those answers from drifting apart — a second
 * implementation of the same rule would eventually accept in one context what
 * it refuses in another.
 * ------------------------------------------------------------------------- */

/**
 * Applies the normalization rules and reports the outcome without throwing,
 * so each caller can raise the code that belongs to its own context.
 *
 * The order is exact and each step depends on the one before it:
 *
 *   1. Trim leading and trailing space separators.
 *   2. Collapse every internal run of space separators to a single space.
 *   3. Reject any remaining control character or line separator. A tab, a
 *      newline or a U+2028 LINE SEPARATOR reaches this step intact because
 *      step 2 collapses space separators only.
 *   4. Enforce the length bound, measured AFTER the two steps above, so
 *      padding cannot push a legitimate label over the limit.
 *
 * Submitted casing is preserved in the returned value — `Chess Club` is
 * stored as typed. Case is folded only for the composite-key comparison in
 * `compositeKey`, never in what is stored.
 *
 * Length is counted in UTF-16 CODE UNITS, which is `String.prototype.length`.
 * That is not an oversight in favour of code points: the intake form's
 * `maxlength="60"` is evaluated by the browser in code units, so counting
 * code points here would accept over the JSON API a label of astral
 * characters that the native form refuses to submit — one bound with two
 * answers. A character outside the Basic Multilingual Plane therefore counts
 * twice, on both sides of the wire.
 *
 * @param {unknown} raw The submitted or stored label.
 * @returns {{ok: true, value: string}|{ok: false, reason: string}} On success
 *   the normalized label; on failure a reason phrased to follow the words
 *   "the activity label", so either caller can compose a sentence from it.
 */
function inspectLabel(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, reason: `must be a string; received ${describeValue(raw)}` };
  }

  const normalized = raw
    .replace(LEADING_SPACE_PATTERN, '')
    .replace(TRAILING_SPACE_PATTERN, '')
    .replace(INTERNAL_SPACE_RUN_PATTERN, ' ');

  if (CONTROL_OR_LINE_SEPARATOR_PATTERN.test(normalized)) {
    return { ok: false, reason: 'must not contain control characters or line separators' };
  }

  const length = normalized.length;
  if (length < MIN_LABEL_LENGTH) {
    return { ok: false, reason: 'must not be empty once surrounding whitespace is removed' };
  }
  if (length > MAX_LABEL_LENGTH) {
    return {
      ok: false,
      reason: `must be at most ${MAX_LABEL_LENGTH} characters once normalized; received ${length}`,
    };
  }

  return { ok: true, value: normalized };
}

/**
 * Tests whether a value is an ISO-8601 instant in UTC.
 *
 * The component comparison is the substance of this check, not a belt-and-
 * braces extra: `Date.parse` accepts `2026-02-31T00:00:00Z` and rolls it to
 * March 3, so a finite result proves only that the string was parseable, not
 * that the date exists. Comparing the captured components back against the
 * parsed instant rejects an impossible date and also rejects the `24:00`
 * end-of-day form, which the server never writes.
 *
 * @param {unknown} value The candidate timestamp.
 * @returns {boolean} True when `value` is a real instant in canonical UTC form.
 */
function isIsoUtcInstant(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const match = ISO_UTC_INSTANT_PATTERN.exec(value);
  if (match === null) {
    return false;
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return false;
  }

  const instant = new Date(milliseconds);
  return (
    instant.getUTCFullYear() === Number(match[1]) &&
    instant.getUTCMonth() + 1 === Number(match[2]) &&
    instant.getUTCDate() === Number(match[3]) &&
    instant.getUTCHours() === Number(match[4]) &&
    instant.getUTCMinutes() === Number(match[5]) &&
    instant.getUTCSeconds() === Number(match[6])
  );
}

/* ------------------------------------------------------------------------- *
 * Records and the composite key
 * ------------------------------------------------------------------------- */

/**
 * Builds the composite key that identifies a record.
 *
 * The store's primary key is `(studentId, normalized activity label)`,
 * compared case-insensitively — `studentId` alone cannot be it, because a
 * student may hold many activities. No surrogate identifier is introduced:
 * the composite is stable, human-readable, and derivable from the submission
 * itself, so there is nothing for one to buy.
 *
 * The separator is a NUL, which cannot occur in either component: a Student
 * ID matches `/^S\d{3}$/` and a label has already had control characters
 * refused. So no pair of distinct components can collide on one key.
 *
 * @param {string} studentId A well-formed Student ID.
 * @param {string} normalizedLabel A label in normalized form.
 * @returns {string} The comparison key.
 */
function compositeKey(studentId, normalizedLabel) {
  return `${studentId}\u0000${normalizedLabel.toLowerCase()}`;
}

/**
 * Copies a record into its canonical shape.
 *
 * Two jobs. It guarantees the `submittedAt` KEY IS ABSENT on a workbook
 * record rather than present and undefined, which is what makes
 * `'submittedAt' in record === false` hold for seeded data and keeps
 * fabricated provenance out of the document. And it hands callers their own
 * object, so nothing can reach in and mutate the cached seed snapshot or a
 * document mid-write.
 *
 * @param {{studentId: string, activity: string, source: string, submittedAt?: string}} record
 *   A record already proven valid.
 * @returns {{studentId: string, activity: string, source: string, submittedAt?: string}}
 *   A fresh object in canonical key order.
 */
function cloneRecord(record) {
  const copy = {
    studentId: record.studentId,
    activity: record.activity,
    source: record.source,
  };
  if (record.source === SOURCE_SUBMISSION) {
    copy.submittedAt = record.submittedAt;
  }
  return copy;
}

/* ------------------------------------------------------------------------- *
 * Reference data, and the two caches
 *
 * Both caches hold data from files this module never writes, so they are
 * immutable for the lifetime of the process and are invalidated only by
 * restarting it — the right granularity for a file that changes only by
 * commit. Re-reading and re-parsing an OOXML package on every request would
 * be real cost for data that cannot change while the process is running.
 *
 * NEITHER CACHE IS EVER POPULATED FROM A FAILED READ. Each is assigned only
 * after the read and every check on it have fully succeeded, so a transient
 * workbook failure costs one request rather than poisoning the process for
 * its remaining lifetime.
 *
 * The store itself is deliberately NOT cached — see the mutex section.
 * ------------------------------------------------------------------------- */

/** @type {Set<string>|null} The key set, or null while it has not been read. */
let cachedKeySet = null;

/**
 * @type {Array<{studentId: string, activity: string, source: string}>|null}
 * The seed snapshot, or null while it has not been read.
 */
let cachedSeedRecords = null;

/**
 * Reads one column of one workbook, translating every refusal the reader can
 * raise into this module's reference-data code.
 *
 * The reader decodes only the column named here, so a key-set read does not
 * materialise the name, date of birth, email, phone or city sitting in the
 * same rows.
 *
 * The reader's own codes are deliberately not re-exposed: a caller acting on
 * `E_XLSX_TRUNCATED` would be reaching past this module's contract, and all
 * of them mean the same thing here — the reference data cannot be trusted.
 * The original travels as `cause`.
 *
 * @param {string} workbookFileName A workbook beside this module.
 * @param {string} columnLetter The column to read.
 * @returns {string[]} The column's values, header first.
 * @throws {Error} E_REFERENCE_DATA for any failure to read the column.
 */
function readWorkbookColumn(workbookFileName, columnLetter) {
  try {
    return xlsxRead.readColumn(path.join(__dirname, workbookFileName), WORKSHEET_PART, columnLetter);
  } catch (cause) {
    throw refuse(
      CODE_REFERENCE_DATA,
      `column ${columnLetter} of ${workbookFileName} could not be read (${describeCause(cause)})`,
      { reason: 'workbook_column_unreadable', cause }
    );
  }
}

/**
 * Returns the authoritative Student ID key set, reading it on first use.
 *
 * `student_details.xlsx` is named as the authority because it is the identity
 * workbook, which makes it the natural registrar of who exists. Naming one
 * authority removes the ambiguity of which workbook to trust where their
 * Student ID columns disagree.
 *
 * A GENUINELY EMPTY cell — the empty string, which is what the reader yields
 * for a cell that is absent from a row inside the declared dimension — is
 * skipped, since a worksheet may carry empty rows. Every other value is
 * tested AS READ: nothing is trimmed first, because trimming would launder a
 * malformed authority into a well-formed one. `'S001\n'` is not a Student ID
 * and `/^S\d{3}$/` is the literal rule, so a cell padded with a control
 * character or a space is refused rather than quietly accepted as the ID it
 * resembles.
 *
 * A value that is not a Student ID, a repeated Student ID, or a column with
 * no Student ID at all is refused: none of those can serve as a key
 * authority, and accepting one would either admit an unverifiable reference
 * or silently shrink the set every submission is checked against.
 *
 * @returns {Set<string>} Every distinct Student ID the authority's column
 *   holds, one entry per non-blank cell below the header.
 * @throws {Error} E_REFERENCE_DATA when the workbook cannot be read or cannot
 *   serve as the key authority.
 */
function loadKeySet() {
  if (cachedKeySet !== null) {
    return cachedKeySet;
  }

  const column = readWorkbookColumn(KEY_SET_WORKBOOK, KEY_SET_COLUMN);
  const keys = new Set();

  for (let index = FIRST_DATA_ROW_INDEX; index < column.length; index += 1) {
    /* AS READ. The `.trim()` that used to stand here made `'S001\n'` a valid
     * Student ID, because `String.prototype.trim` strips control characters,
     * and an authority whose keys are laundered before validation is not an
     * authority. Only the empty string is skipped — that is the reader's
     * answer for an absent cell, which is how a blank row inside a declared
     * dimension arrives, and it is the one value that means "no key here"
     * rather than "a key of the wrong shape". */
    const value = column[index];
    if (value === '') {
      continue;
    }
    if (!STUDENT_ID_PATTERN.test(value)) {
      throw refuse(
        CODE_REFERENCE_DATA,
        `row ${index + 1} of ${KEY_SET_WORKBOOK} holds ${describeValue(value)} where a Student ID of the form S000 was expected`,
        { reason: 'key_not_a_student_id', at: index + 1 }
      );
    }
    if (keys.has(value)) {
      throw refuse(
        CODE_REFERENCE_DATA,
        `${KEY_SET_WORKBOOK} repeats Student ID ${value} at row ${index + 1}; the key authority must hold each Student ID once`,
        { reason: 'key_repeated', at: index + 1 }
      );
    }
    keys.add(value);
  }

  if (keys.size === 0) {
    throw refuse(
      CODE_REFERENCE_DATA,
      `column ${KEY_SET_COLUMN} of ${KEY_SET_WORKBOOK} holds no Student ID, so no submission could be validated against it`,
      { reason: 'key_set_empty' }
    );
  }

  cachedKeySet = keys;
  return cachedKeySet;
}

/**
 * Returns the seed snapshot, reading it on first use.
 *
 * One record per student whose `Extracurricular Activity` cell holds a label,
 * each marked `source: "workbook"` with no `submittedAt`. These are the
 * records the store is materialised from, so every one of them must satisfy
 * the same invariants the loader enforces — otherwise materialising the
 * document would produce a store that the loader then refuses forever. That
 * is why a malformed label, an unknown Student ID, or a repeated
 * `(student, label)` pair is refused here at the source rather than written
 * out and discovered later.
 *
 * A student whose activity cell is blank simply contributes no record, which
 * is the honest reading of an empty cell: nothing was recorded for them.
 * "Blank" means `SPACE_SEPARATOR_ONLY_PATTERN` — empty, or space separators
 * only — and nothing wider. A cell holding a lone tab is NOT blank: it is a
 * label carrying a control character, and it is refused by `inspectLabel`
 * like any other, rather than skipped as though the row said nothing.
 *
 * The Student ID is likewise validated AS READ, with no trim, and its shape is
 * checked before its membership so a control-padded value is reported as a
 * malformed ID rather than as an ID absent from the key set — two different
 * mistakes with two different fixes.
 *
 * @returns {Array<{studentId: string, activity: string, source: string}>} The
 *   snapshot, in worksheet order. Treat as immutable; `cloneRecord` hands out
 *   copies.
 * @throws {Error} E_REFERENCE_DATA when a workbook cannot be read, or holds
 *   seed data that could not be stored.
 */
function loadSeedRecords() {
  if (cachedSeedRecords !== null) {
    return cachedSeedRecords;
  }

  const keySet = loadKeySet();

  /* Both columns come from ONE read, inflate and parse of one immutable
   * workbook. Asking for them separately would repeat the whole read, inflate
   * and parse over the same bytes — the reader is stateless by design and
   * holds no cache — on the very request that materialises the seed, blocking
   * the single event loop while it does. Naming both columns in one call also
   * keeps the read minimal in the other direction: no cell of a column this
   * feature has no use for is decoded. */
  const seedColumns = [SEED_STUDENT_ID_COLUMN, SEED_LABEL_COLUMN];
  let seedRows;
  try {
    seedRows = xlsxRead.readSheetRows(
      path.join(__dirname, SEED_WORKBOOK),
      WORKSHEET_PART,
      seedColumns
    );
  } catch (cause) {
    throw refuse(
      CODE_REFERENCE_DATA,
      `columns ${seedColumns.join(' and ')} of ${SEED_WORKBOOK} could not be read (${describeCause(cause)})`,
      { reason: 'workbook_column_unreadable', cause }
    );
  }

  /* A row with no cell in a column contributes the empty string rather than
   * being skipped, so both columns stay aligned with each other and with the
   * worksheet's own row order. */
  const columnOf = (columnLetter) =>
    seedRows.map((row) =>
      Object.prototype.hasOwnProperty.call(row, columnLetter) ? row[columnLetter] : ''
    );
  const studentIds = columnOf(SEED_STUDENT_ID_COLUMN);
  const labels = columnOf(SEED_LABEL_COLUMN);
  const rowCount = Math.min(studentIds.length, labels.length);

  const records = [];
  const firstIndexByKey = new Map();

  for (let index = FIRST_DATA_ROW_INDEX; index < rowCount; index += 1) {
    /* Both values AS READ. Neither is trimmed before it is validated: a trim
     * made `'S001\t'` a valid Student ID and made a control-only label test as
     * blank, so the row was skipped before `inspectLabel` could refuse it. */
    const studentId = studentIds[index];
    const rawLabel = labels[index];
    const labelIsBlank = SPACE_SEPARATOR_ONLY_PATTERN.test(rawLabel);

    /* An entirely empty row inside the declared dimension: no ID, no label,
     * nothing recorded. Only a genuinely empty ID cell qualifies, so a padded
     * one falls through to the shape check below rather than vanishing. */
    if (studentId === '' && labelIsBlank) {
      continue;
    }
    /* Shape before membership. A malformed ID could never be in the key set,
     * so reporting it as "absent from the key set" would name the wrong fault
     * and send a reader looking in the wrong workbook. */
    if (!STUDENT_ID_PATTERN.test(studentId)) {
      throw refuse(
        CODE_REFERENCE_DATA,
        `row ${index + 1} of ${SEED_WORKBOOK} holds ${describeValue(studentId)} where a Student ID of the form S000 was expected`,
        { reason: 'seed_student_id_malformed', at: index + 1 }
      );
    }
    if (!keySet.has(studentId)) {
      throw refuse(
        CODE_REFERENCE_DATA,
        `row ${index + 1} of ${SEED_WORKBOOK} names ${describeValue(studentId)}, which is absent from the key set in ${KEY_SET_WORKBOOK}`,
        { reason: 'seed_student_unknown', at: index + 1 }
      );
    }
    if (labelIsBlank) {
      continue;
    }

    const inspected = inspectLabel(rawLabel);
    if (!inspected.ok) {
      throw refuse(
        CODE_REFERENCE_DATA,
        `the activity in row ${index + 1} of ${SEED_WORKBOOK} ${inspected.reason}`,
        { reason: 'seed_label_invalid', at: index + 1 }
      );
    }

    const key = compositeKey(studentId, inspected.value);
    const firstIndex = firstIndexByKey.get(key);
    if (firstIndex !== undefined) {
      throw refuse(
        CODE_REFERENCE_DATA,
        `rows ${firstIndex + 1} and ${index + 1} of ${SEED_WORKBOOK} record the same activity for ${studentId}, which cannot be seeded as two records`,
        { reason: 'seed_activity_duplicated', at: firstIndex + 1 }
      );
    }
    firstIndexByKey.set(key, index);

    records.push({
      studentId,
      activity: inspected.value,
      source: SOURCE_WORKBOOK,
    });
  }

  cachedSeedRecords = records;
  return cachedSeedRecords;
}

/**
 * Builds a fresh document from the seed snapshot.
 *
 * Every record is a copy, so the document a submission is about to be applied
 * to shares no object with the cached snapshot.
 *
 * @returns {{schemaVersion: number, activities: Array<Object>}} A document
 *   holding the workbook's labels and nothing else.
 * @throws {Error} E_REFERENCE_DATA propagated from the seed read.
 */
function materializeSeedDocument() {
  return {
    schemaVersion: SCHEMA_VERSION,
    activities: loadSeedRecords().map(cloneRecord),
  };
}


/* ------------------------------------------------------------------------- *
 * Loading the store
 *
 * Every invariant the record shape declares is enforced HERE, on load, and
 * not only at submission time. The store is a plain file a person can edit,
 * so "we only ever write it correctly" is not a guarantee about what is read
 * back. A version marker with nothing enforcing it is decoration.
 *
 * Nothing in this section writes, truncates, renames or repairs the file. A
 * document that fails any check is left exactly as found and reported, so a
 * hand-edit mistake costs an error response rather than the data.
 * ------------------------------------------------------------------------- */

/**
 * Reads the store's bytes, within the size ceiling, and decodes them as UTF-8.
 *
 * An absent file is NOT an error — it is the first-use state, and the caller
 * answers from the seed snapshot instead. Anything else that stops the bytes
 * being read is a genuine fault: a store that exists but cannot be read must
 * not be mistaken for one that does not exist, because the caller's response
 * to absence is to seed and write, which would discard it.
 *
 * THE ORDER OF THE CHECKS IS THE SUBSTANCE, and each one is here for a
 * measured reason rather than for symmetry:
 *
 *   1. `open` for reading. Only ENOENT means absent. A path whose PARENT is
 *      missing also reports ENOENT, and that is the same answer for the same
 *      reason: there is no store to read.
 *   2. `stat` THE DESCRIPTOR, and refuse anything that is not a regular file.
 *      This is load-bearing, not belt-and-braces: opening a DIRECTORY with
 *      `'r'` SUCCEEDS on Windows, so a read error cannot be relied on to
 *      report it, and "not a regular file" must never be answered as
 *      "absent", because absence seeds and writes. Statting the open
 *      descriptor rather than the path is what makes the answer describe the
 *      file that is actually about to be read.
 *   3. Refuse a size over `MAX_STORE_BYTES` before a single byte is read, so
 *      an oversized document costs a `stat` rather than an allocation.
 *   4. Read from the ALREADY-OPEN descriptor in bounded chunks, accepting at
 *      most `MAX_STORE_BYTES + 1` bytes, and refuse if that many arrive. The
 *      one extra byte is what distinguishes "exactly at the ceiling" from
 *      "over it" without reading the whole of an oversized file. This closes
 *      the check-then-use window (CWE-367) that a size test alone leaves: a
 *      file that grows between the `stat` and the read must not slip past the
 *      ceiling, and because the reads go to the same descriptor the `stat`
 *      described, they cannot be redirected to a different file either.
 *
 * Decoding is strict, so a file that is not valid UTF-8 is refused rather
 * than silently littered with replacement characters. A single leading byte
 * order mark is tolerated and dropped: this module never writes one, but a
 * Windows editor readily adds one to a hand-edited file, and refusing that
 * outright would be unhelpful without protecting any invariant.
 *
 * The descriptor is closed on every path. A failure to close cannot mask the
 * outcome: it is swallowed after a refusal, because the refusal is the useful
 * report, and only the close of an otherwise successful read can surface.
 * Nothing on this path writes, truncates, renames or repairs anything.
 *
 * @returns {Promise<string|null>} The document text, or null when the store
 *   does not exist.
 * @throws {Error} E_STORE_UNREADABLE when the file exists but is not a regular
 *   file, exceeds the size ceiling, or cannot be read or decoded.
 */
async function readStoreText() {
  let handle;
  try {
    handle = await fs.open(RESOLVED_STORE_PATH, 'r');
  } catch (cause) {
    if (describeCause(cause) === 'ENOENT') {
      return null;
    }
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity store exists but could not be read (${describeCause(cause)})`,
      { reason: 'store_file_unreadable', cause }
    );
  }

  let bytes;
  let readSucceeded = false;
  try {
    let stats;
    try {
      stats = await handle.stat();
    } catch (cause) {
      throw refuse(
        CODE_STORE_UNREADABLE,
        `the activity store exists but could not be read (${describeCause(cause)}); its descriptor could not be inspected`,
        { reason: 'store_descriptor_uninspectable', cause });
    }

    if (!stats.isFile()) {
      throw refuse(
        CODE_STORE_UNREADABLE,
        'the activity store exists but could not be read: the path is not a regular file, and it must not be treated as absent, because absence would seed and write over it',
        { reason: 'store_not_regular_file' }
      );
    }
    if (stats.size > MAX_STORE_BYTES) {
      throw refuse(
        CODE_STORE_UNREADABLE,
        `the activity store holds ${stats.size} bytes, over the ${MAX_STORE_BYTES}-byte ceiling this build reads; it is left exactly as found`,
        { reason: 'store_too_large' }
      );
    }

    /* One buffer for the whole read, and a cap of one byte past the ceiling:
     * enough to PROVE the file is over it, never enough to hold an unbounded
     * file. `position` is passed explicitly so the reads are independent of
     * any shared file position. */
    const chunk = Buffer.allocUnsafe(STORE_READ_CHUNK_BYTES);
    const collected = [];
    let total = 0;
    for (;;) {
      const remaining = MAX_STORE_BYTES + 1 - total;
      if (remaining === 0) {
        break;
      }
      let result;
      try {
        result = await handle.read(chunk, 0, Math.min(chunk.length, remaining), total);
      } catch (cause) {
        throw refuse(
          CODE_STORE_UNREADABLE,
          `the activity store exists but could not be read (${describeCause(cause)})`,
          { reason: 'store_file_unreadable', cause });
      }
      if (result.bytesRead === 0) {
        break;
      }
      collected.push(Buffer.from(chunk.subarray(0, result.bytesRead)));
      total += result.bytesRead;
    }

    if (total > MAX_STORE_BYTES) {
      throw refuse(
        CODE_STORE_UNREADABLE,
        `the activity store delivered more than the ${MAX_STORE_BYTES}-byte ceiling this build reads; it is left exactly as found`,
        { reason: 'store_grew_past_ceiling' }
      );
    }

    bytes = Buffer.concat(collected, total);
    readSucceeded = true;
  } finally {
    try {
      await handle.close();
    } catch (closeFault) {
      /* A close that fails after a refusal must not replace it: the refusal
       * names what was actually wrong with the store, and this names the
       * descriptor. Only a close failure on an otherwise successful read has
       * anything new to report, and it is reported as an unreadable store
       * because the bytes cannot be trusted to be complete. */
      if (readSucceeded) {
        throw refuse(
          CODE_STORE_UNREADABLE,
          `the activity store exists but could not be read (${describeCause(closeFault)}); its descriptor could not be closed after reading, so the bytes cannot be trusted to be complete`,
          { reason: 'store_descriptor_close_failed', cause: closeFault });
      }
    }
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw refuse(CODE_STORE_UNREADABLE, 'the activity store is not valid UTF-8', {
      reason: 'store_not_utf8',
      cause,
    });
  }

  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Finds the first own key of `value` that `recognized` does not contain.
 *
 * `Object.keys` is deliberate: it enumerates OWN enumerable keys only, which
 * is exactly what `JSON.parse` produces — including a `__proto__` key, which
 * `JSON.parse` materialises as an ordinary own property rather than as a
 * prototype assignment, and which therefore has to be caught here like any
 * other unrecognized key.
 *
 * @param {Object} value The parsed object to inspect.
 * @param {Set<string>} recognized The keys the shape declares.
 * @returns {string|null} The first unrecognized key, or null when there is
 *   none.
 */
function findUnexpectedKey(value, recognized) {
  for (const key of Object.keys(value)) {
    if (!recognized.has(key)) {
      return key;
    }
  }
  return null;
}

/**
 * Validates one record and returns it in canonical form.
 *
 * Messages name the record's index, and the offending value where naming it
 * helps, because an index is what a person needs in order to find the record
 * in a document they are about to hand-edit.
 *
 * A key beyond the four the shape declares is REFUSED, before anything is
 * canonicalized. Carrying it over is impossible — the document is rewritten
 * whole in canonical form on every change — and dropping it silently is
 * worse: the read would succeed and the next submission would erase a
 * hand-edited field without anyone being told. Refusing leaves the file
 * exactly as found and puts the decision back with the person who edited it.
 *
 * @param {unknown} raw The parsed array element.
 * @param {number} index Its position in `activities`.
 * @param {Set<string>} keySet The authoritative key set.
 * @returns {{studentId: string, activity: string, source: string, submittedAt?: string}}
 *   The validated record.
 * @throws {Error} E_STORE_UNREADABLE for any violation.
 */
function validateRecord(raw, index, keySet) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} must be an object; it is ${describeValue(raw)}`,
      { reason: 'record_not_an_object', at: index }
    );
  }

  /* The record's own key names are checked against the recognized field-name
   * set before any field value is examined, so an unrecognized key is
   * reported as itself rather than as whatever field-level complaint happens
   * to follow it. That set is the union across both provenances; the
   * per-source provenance rule further down narrows it, and is what refuses a
   * `workbook` record that carries `submittedAt`, with a message that names
   * the provenance conflict rather than the key. */
  const unexpectedRecordKey = findUnexpectedKey(raw, RECOGNIZED_RECORD_KEYS);
  if (unexpectedRecordKey !== null) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} carries the unexpected key ${JSON.stringify(unexpectedRecordKey)}; a record holds studentId, activity, source and submittedAt only, and the document is rewritten whole on every change, so an unrecognized key would be erased by the next submission rather than kept`,
      { reason: 'record_unexpected_key', at: index }
    );
  }

  const studentId = raw.studentId;
  if (typeof studentId !== 'string' || !STUDENT_ID_PATTERN.test(studentId)) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} has a studentId of ${describeValue(studentId)}, which is not a Student ID of the form S000`,
      { reason: 'record_student_id_malformed', at: index }
    );
  }
  if (!keySet.has(studentId)) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} names studentId ${studentId}, which is absent from the key set in ${KEY_SET_WORKBOOK}`,
      { reason: 'record_student_id_unknown', at: index }
    );
  }

  const inspected = inspectLabel(raw.activity);
  if (!inspected.ok) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} has a label that ${inspected.reason}`,
      { reason: 'record_label_invalid', at: index }
    );
  }
  if (inspected.value !== raw.activity) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} has the label ${describeValue(raw.activity)}, which is not in normalized form; the store is only ever written normalized, so this indicates a hand-edit`,
      { reason: 'record_label_not_normalized', at: index }
    );
  }

  const source = raw.source;
  if (source !== SOURCE_SUBMISSION && source !== SOURCE_WORKBOOK) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} has a source of ${describeValue(source)}; expected "${SOURCE_SUBMISSION}" or "${SOURCE_WORKBOOK}"`,
      { reason: 'record_source_unrecognised', at: index }
    );
  }

  const record = { studentId, activity: inspected.value, source };

  if (source === SOURCE_SUBMISSION) {
    if (!isIsoUtcInstant(raw.submittedAt)) {
      throw refuse(
        CODE_STORE_UNREADABLE,
        `the activity at index ${index} is a ${SOURCE_SUBMISSION} whose submittedAt is ${describeValue(raw.submittedAt)}; an ISO-8601 instant in UTC was expected`,
        { reason: 'record_submitted_at_invalid', at: index }
      );
    }
    record.submittedAt = raw.submittedAt;
  } else if (Object.prototype.hasOwnProperty.call(raw, 'submittedAt')) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} is sourced from the ${SOURCE_WORKBOOK} yet carries submittedAt; a seeded record must not claim a submission time`,
      { reason: 'record_submitted_at_on_seeded', at: index }
    );
  }

  return record;
}

/**
 * Parses and fully validates a store document.
 *
 * @param {string} text The document text.
 * @param {Set<string>} keySet The authoritative key set.
 * @returns {{schemaVersion: number, activities: Array<Object>}} The validated
 *   document, with every record in canonical form.
 * @throws {Error} E_STORE_UNREADABLE for any violation.
 */
function parseStoreDocument(text, keySet) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      'the activity store does not hold parseable JSON',
      { reason: 'store_json_unparseable', cause }
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity store must hold a JSON object; it holds ${describeValue(parsed)}`,
      { reason: 'store_not_an_object' }
    );
  }

  /* Checked before the two fields below, and for the same reason the record
   * check is: this module writes `schemaVersion` and `activities` and nothing
   * else, so a third top-level key would survive one read and be erased by
   * the next write. Together with the presence-and-type checks that follow,
   * this says the document's own keys are exactly those two. */
  const unexpectedDocumentKey = findUnexpectedKey(parsed, RECOGNIZED_DOCUMENT_KEYS);
  if (unexpectedDocumentKey !== null) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity store carries the unexpected top-level key ${JSON.stringify(unexpectedDocumentKey)}; this build reads schemaVersion and activities only, and the document is rewritten whole on every change, so an unrecognized key would be erased by the next submission rather than kept`,
      { reason: 'store_unexpected_key' }
    );
  }

  const version = parsed.schemaVersion;
  if (typeof version !== 'number' || version !== SCHEMA_VERSION) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity store declares a schemaVersion of ${describeValue(version)}; this build reads version ${SCHEMA_VERSION} only`,
      { reason: 'store_schema_version' }
    );
  }

  const activities = parsed.activities;
  if (!Array.isArray(activities)) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity store must hold an activities array; it holds ${describeValue(activities)}`,
      { reason: 'store_activities_not_an_array' }
    );
  }

  /* The record ceiling, refused HERE: after the array has been recognized as
   * an array and BEFORE the loop below allocates one canonical record per
   * element. This is what bounds the canonical array, and with it the
   * re-stringification a later write performs over the same document — the
   * byte ceiling alone does not, because a dense document well inside 2 MiB
   * can still carry a great many records. */
  if (activities.length > MAX_ACTIVITY_RECORDS) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity store holds ${activities.length} activities, over the ${MAX_ACTIVITY_RECORDS}-record ceiling this build reads; it is left exactly as found`,
      { reason: 'store_too_many_activities' }
    );
  }

  const records = [];
  const firstIndexByKey = new Map();

  for (let index = 0; index < activities.length; index += 1) {
    const record = validateRecord(activities[index], index, keySet);
    const key = compositeKey(record.studentId, record.activity);
    const firstIndex = firstIndexByKey.get(key);

    if (firstIndex !== undefined) {
      throw refuse(
        CODE_STORE_UNREADABLE,
        `the activities at index ${firstIndex} and index ${index} share the composite key (${record.studentId}, ${describeValue(record.activity)}) compared case-insensitively; this service never writes that state, so it must be resolved by hand rather than deduplicated automatically`,
        { reason: 'store_duplicate_composite_key', at: firstIndex }
      );
    }
    firstIndexByKey.set(key, index);
    records.push(record);
  }

  return { schemaVersion: SCHEMA_VERSION, activities: records };
}

/**
 * Loads the current document, or materialises one from the seed snapshot when
 * the store does not exist yet.
 *
 * Seeding happens ONLY for an absent store. A store that exists is taken as
 * complete, which is why the build must never pre-create an empty document:
 * an empty document is valid, so it would suppress seeding and leave the
 * workbook's labels out of the store permanently.
 *
 * @param {Set<string>} keySet The authoritative key set.
 * @returns {Promise<{schemaVersion: number, activities: Array<Object>}>} The
 *   document to read from or apply a submission to.
 * @throws {Error} E_STORE_UNREADABLE or E_REFERENCE_DATA.
 */
async function loadDocument(keySet) {
  const text = await readStoreText();
  if (text === null) {
    return materializeSeedDocument();
  }
  return parseStoreDocument(text, keySet);
}

/* ------------------------------------------------------------------------- *
 * Writing the store
 *
 * The staging file is created EXCLUSIVELY and written THROUGH the resulting
 * descriptor, never opened by pathname with truncation. The distinction is
 * the whole of the protection: `fs.writeFile(path, ...)` implies `O_TRUNC`,
 * so it opens whatever is already at the predictable `${store}.tmp` name and
 * truncates it — and if a local process has put a symbolic or hard LINK
 * there, what gets truncated is the link's TARGET, a file this module was
 * never pointed at. Exclusive creation cannot do that: it refuses with
 * EEXIST whenever anything exists at the name, follows no final symbolic
 * link, and hands back a descriptor for a file this module itself created.
 * ------------------------------------------------------------------------- */

/**
 * The flags the staging file is created with.
 *
 *   O_CREAT | O_EXCL   Create it, and FAIL with EEXIST if anything is already
 *                      there. This is what replaces truncation: a planted
 *                      link is never opened, so its target is never touched.
 *                      Exclusive creation also never follows a final symbolic
 *                      link, on POSIX and on Windows alike.
 *   O_WRONLY           The write path never reads the staging file. A stale
 *                      one is replaced, never parsed.
 *   O_NOFOLLOW         Refuses even to open a symbolic link, on the platforms
 *                      that define it. MEASURED on this project's Windows
 *                      runtime: `fs.constants.O_NOFOLLOW` is `undefined`
 *                      there, and `undefined` in a bitwise OR would poison
 *                      the whole mask to `NaN`-then-0 semantics, so the
 *                      `|| 0` is REQUIRED rather than defensive. Windows loses
 *                      nothing by it: O_EXCL already refuses to open anything
 *                      that exists, link or not.
 */
const STAGING_OPEN_FLAGS =
  fsSync.constants.O_CREAT |
  fsSync.constants.O_EXCL |
  fsSync.constants.O_WRONLY |
  (fsSync.constants.O_NOFOLLOW || 0);

/**
 * The mode the staging file — and therefore the store it is renamed onto — is
 * created with: read and write for the owner, nothing for anyone else.
 *
 * Without it the file is created `0666 & ~umask`, which is commonly
 * world-readable `0644`, and the store holds submitted student data. The
 * service being reachable only over loopback protects it from the network and
 * not at all from another local principal.
 *
 * On Windows the mode is not an ACL: only the write bit is honoured, and the
 * file inherits the ACLs of its directory. That is why the operator
 * documentation requires a PRIVATE directory for `ACTIVITY_STORE` rather than
 * a shared temporary one — on that platform the directory is the control.
 */
const STAGING_FILE_MODE = 0o600;

/**
 * How many times the exclusive create may be retried after removing what it
 * collided with.
 *
 * Bounded, and small, because each retry is a response to something else
 * having occupied the name: one retry handles the ordinary case of a stale
 * file or a planted link, and a name that keeps being re-occupied is a
 * process racing this one rather than a state to clear. Retrying forever
 * there would spin inside the write mutex and hold up every later
 * submission, so the write is refused instead and the previous document is
 * left intact.
 */
const MAX_STAGING_OPEN_ATTEMPTS = 3;

/**
 * Creates the staging file exclusively, clearing whatever occupies the name.
 *
 * The EEXIST path is the substance. `fs.unlink` removes a NAME, never the
 * file a link points at — measured on this host for both a symbolic link and
 * a hard link, with the target's bytes intact afterwards — so clearing the
 * collision cannot damage whatever a planter aimed the link at. Both
 * documented behaviours survive: a stale staging file left by a dead process
 * is replaced and never read, and a planted link's target is never truncated.
 *
 * The unlink FAILS CLOSED. When it cannot remove what is there — a DIRECTORY
 * at the staging path reports EPERM on Windows and EISDIR on POSIX, and it is
 * also the portable write-fault mechanism this project's tests use — the
 * write is refused and the obstruction is left exactly where it was. Nothing
 * here removes a directory or retries past the attempt bound.
 *
 * @returns {Promise<import('node:fs/promises').FileHandle>} A descriptor for
 *   a file this call created.
 * @throws {Error} E_STORE_WRITE_FAILED when the staging file cannot be
 *   created, including when the name is held by something unremovable or is
 *   re-occupied faster than the attempt bound allows.
 */
async function openStagingFileExclusively() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fs.open(RESOLVED_TEMPORARY_PATH, STAGING_OPEN_FLAGS, STAGING_FILE_MODE);
    } catch (cause) {
      if (describeCause(cause) !== 'EEXIST' || attempt >= MAX_STAGING_OPEN_ATTEMPTS) {
        throw refuse(
          CODE_STORE_WRITE_FAILED,
          `the activity store could not be written (${describeCause(cause)}); its staging file could not be created, the previous document is intact and the submission was not persisted`,
          { reason: 'store_write_refused', cause });
      }
      try {
        await fs.unlink(RESOLVED_TEMPORARY_PATH);
      } catch (unlinkCause) {
        throw refuse(
          CODE_STORE_WRITE_FAILED,
          `the activity store could not be written (${describeCause(unlinkCause)}); its staging path is occupied by something that could not be cleared, the previous document is intact and the submission was not persisted`,
          { reason: 'staging_path_not_cleared', cause: unlinkCause });
      }
    }
  }
}

/**
 * Proves the opened staging descriptor is the private regular file this
 * module just created, and pins its mode.
 *
 * Exclusive creation already establishes most of this, so each check states
 * what it adds rather than repeating it:
 *
 *   - `isFile()` — nothing else may be adopted as a staging file. A
 *     descriptor that is not a regular file could not be renamed onto the
 *     store meaningfully in any case.
 *   - `nlink === 1` — the file has exactly ONE name, which is the one this
 *     module holds. A HARD link is the one plant O_EXCL and O_NOFOLLOW cannot
 *     describe on their own: it is not a link object, it is a second name for
 *     an existing file, and it reports `nlink >= 2`. Measured working on NTFS
 *     as well as POSIX.
 *   - `uid` — POSIX only, gated on `typeof process.getuid === 'function'`
 *     because Windows has no such concept and the property is meaningless
 *     there. It refuses a file owned by someone else, which a freshly created
 *     file cannot be unless the directory itself is not the operator's.
 *
 * `chmod` to `STAGING_FILE_MODE` is POSIX only and runs through the
 * DESCRIPTOR, not the path, so it cannot be redirected to another file
 * between the two calls. It makes the mode exactly `0600` whatever the
 * umask, and it also corrects the one case creation cannot: a mode is applied
 * only to a file being created, so without this a file that somehow survived
 * to become the store would keep a mode from elsewhere.
 *
 * @param {import('node:fs/promises').FileHandle} handle The staging descriptor.
 * @returns {Promise<void>}
 * @throws {Error} E_STORE_WRITE_FAILED when the descriptor fails any check or
 *   its mode cannot be set. The caller closes and removes the file.
 */
async function verifyStagingDescriptor(handle) {
  let stats;
  try {
    stats = await handle.stat();
  } catch (cause) {
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      `the activity store could not be written (${describeCause(cause)}); its staging file could not be inspected before writing, the previous document is intact and the submission was not persisted`,
      { reason: 'staging_uninspectable', cause });
  }

  if (!stats.isFile()) {
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      'the activity store could not be written (its staging path is not a regular file, so it must not be written or renamed onto the store); the previous document is intact and the submission was not persisted',
      { reason: 'staging_not_regular_file' }
    );
  }
  if (stats.nlink !== 1) {
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      `the activity store could not be written (its staging file carries ${stats.nlink} names rather than one, so writing it would reach another file through a link); the previous document is intact and the submission was not persisted`,
      { reason: 'staging_multiply_linked' }
    );
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      'the activity store could not be written (its staging file is owned by another user, so it must not be written or renamed onto the store); the previous document is intact and the submission was not persisted',
      { reason: 'staging_foreign_owner' }
    );
  }

  /* POSIX only. Windows honours just the write bit through `chmod`, and
   * calling it there would claim a restriction the platform does not apply —
   * the directory's inherited ACLs are the control on that platform, which is
   * why the operator documentation requires a private directory. */
  if (typeof process.getuid === 'function') {
    try {
      await handle.chmod(STAGING_FILE_MODE);
    } catch (cause) {
      throw refuse(
        CODE_STORE_WRITE_FAILED,
        `the activity store could not be written (${describeCause(cause)}); its staging file could not be restricted to its owner, the previous document is intact and the submission was not persisted`,
        { reason: 'staging_mode_not_restricted', cause });
    }
  }
}

/**
 * Replaces the store with `document`, atomically.
 *
 * The whole document is serialized to the staging path and then renamed over
 * the store, because JSON offers neither an append nor a transaction. The
 * rename is what makes the replacement atomic: a concurrent reader sees
 * either the previous document or the new one, never a half-written file.
 * Both paths sit in the same directory by construction, so the rename never
 * degrades into a cross-filesystem copy.
 *
 * The staging name is deliberately NOT process-scoped. A name carrying a PID
 * looks safer but is worse: a file left behind by a dead process would carry
 * that process's PID, so no later process would ever reuse or clean it, and
 * orphans would accumulate while escaping an ignore rule written for one
 * fixed name. A single derived name is safe because every write is serialized
 * behind the mutex, and because a stale staging file is never READ — it is
 * REMOVED and recreated by the next write — so its contents can never be
 * mistaken for the store.
 *
 * WHY EXCLUSIVITY AND AN UNLINK REPLACE TRUNCATION. The name is predictable
 * by design, and a predictable name is one another local process can occupy
 * first. Opening it by pathname for writing implies `O_TRUNC`, so a symbolic
 * or hard LINK planted there would have its TARGET truncated — a file this
 * module was never configured to touch — before the rename. Creating the file
 * exclusively instead refuses with EEXIST whenever anything is there, follows
 * no final symbolic link, and yields a descriptor for a file this module
 * created itself; the collision is then cleared with `fs.unlink`, which
 * removes the NAME and never the file a link points at. From the caller's
 * point of view the documented stale-temp behaviour is unchanged: a leftover
 * staging file does not block a write, is never read, and never contributes a
 * byte to the store. What changed is that it is now removed rather than
 * truncated in place — which is also what stops it donating its MODE to the
 * document that becomes the store.
 *
 * MODE. The staging file is created `0600` and, on POSIX, `chmod`ed to `0600`
 * through the descriptor so the umask cannot loosen it; the rename carries
 * that mode onto the store. Windows honours only the write bit and otherwise
 * inherits the directory's ACLs, so on that platform the private directory
 * required of `ACTIVITY_STORE` is the control rather than the mode.
 *
 * On failure with the process alive, the previous document is left intact and
 * the submission is simply not persisted; retrying is safe, because a
 * submission is idempotent by composite key. A failed RENAME deliberately
 * leaves the staged file on disk: it holds the document that was not adopted,
 * nothing reads it, and the next write removes it. Durability beyond the
 * rename is not attempted: there is no fsync here, matching the specified
 * mechanics for a loopback-only service whose store is a runtime artifact.
 *
 * @param {{schemaVersion: number, activities: Array<Object>}} document The
 *   document to persist.
 * @returns {Promise<void>}
 * @throws {Error} E_STORE_WRITE_FAILED when the document would serialize past
 *   the byte ceiling, when the staging file cannot be created privately or
 *   fails verification, or when the write or the rename fails.
 */
async function writeDocument(document) {
  const serialized = `${JSON.stringify(document, null, JSON_INDENT)}\n`;

  /* THE BYTE CEILING, MEASURED ON THE BYTES ABOUT TO BE PERSISTED, and before
   * anything is staged or opened.
   *
   * The record ceiling does not imply this one. `MAX_LABEL_LENGTH` counts
   * UTF-16 code units while this counts UTF-8 bytes, and `JSON.stringify`
   * escapes an unpaired surrogate to a six-byte `\uD800` sequence, so a
   * document inside the record ceiling can still serialize past the byte
   * ceiling. Without this check such a write SUCCEEDS and publishes a store
   * that every later read and write then refuses as E_STORE_UNREADABLE — the
   * store made unreadable by a submission, which is exactly the outcome the
   * ceilings exist to prevent, and unrecoverable without a hand edit.
   *
   * Refusing here instead leaves the previous document byte-identical and
   * still readable, stages nothing, and reports the ordinary
   * `store_write_failed` a caller already handles. `Buffer.byteLength` is the
   * measure rather than `String.length` because the ceiling is a byte ceiling
   * and a serialized document may carry multi-byte characters. */
  const serializedByteLength = Buffer.byteLength(serialized, 'utf8');
  if (serializedByteLength > MAX_STORE_BYTES) {
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      `the activity store could not be written (the document would serialize to ${serializedByteLength} bytes, over the ${MAX_STORE_BYTES}-byte ceiling this build reads, so writing it would leave a store nothing could read); nothing was staged, the previous document is intact and the submission was not persisted`,
      { reason: 'document_too_large' }
    );
  }

  const handle = await openStagingFileExclusively();

  /* Everything from here to the successful write owns a file this call
   * created, so a failure removes it: leaving a half-written or unverified
   * staging file behind would hand the next write something to clear, and
   * leaving a file this module rejected on disk claims nothing useful. A
   * failed RENAME is the one exception, below. */
  let written = false;
  try {
    await verifyStagingDescriptor(handle);
    /* THROUGH THE DESCRIPTOR. The first argument is the open handle, not the
     * path, so the bytes land in the file that was verified a moment ago and
     * no second path resolution can redirect them. `fs.writeFile` is used
     * rather than `handle.writeFile` because it is the module's established
     * write call and the only one a caller can observe. */
    await fs.writeFile(handle, serialized, { encoding: 'utf8' });
    written = true;
  } catch (cause) {
    if (cause instanceof Error && cause.code === CODE_STORE_WRITE_FAILED) {
      throw cause;
    }
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      `the activity store could not be written (${describeCause(cause)}); the previous document is intact and the submission was not persisted`,
      { reason: 'store_write_refused', cause });
  } finally {
    /* Closed before the rename on every path: a descriptor left open would
     * leak for the life of the process, and on Windows an open handle can
     * itself block the rename. A close fault is reported only when there is
     * nothing more important to report. */
    let closeFault;
    try {
      await handle.close();
    } catch (fault) {
      closeFault = fault;
    }

    if (!written) {
      /* Ours by construction — created exclusively by this call — so removing
       * it cannot remove anyone else's file. `force` keeps a removal that
       * already happened from masking the original failure. */
      await fs.rm(RESOLVED_TEMPORARY_PATH, { force: true }).catch(() => {});
    } else if (closeFault !== undefined) {
      throw refuse(
        CODE_STORE_WRITE_FAILED,
        `the activity store could not be written (${describeCause(closeFault)}); its staging file was written but the descriptor could not be closed, the previous document is intact and the submission was not persisted`,
        { reason: 'staging_close_failed', cause: closeFault });
    }
  }

  try {
    await fs.rename(RESOLVED_TEMPORARY_PATH, RESOLVED_STORE_PATH);
  } catch (cause) {
    /* NOT cleaned up. The staged document is what the rename failed to adopt,
     * it is never read, and the next write removes it — and leaving it is the
     * documented consequence a test asserts. */
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      `the activity store could not be written (${describeCause(cause)}); the previous document is intact and the submission was not persisted`,
      { reason: 'store_write_refused', cause }
    );
  }
}

/* ------------------------------------------------------------------------- *
 * The write mutex
 *
 * The store is the one file that changes, so it is NEVER cached: it is read
 * from disk on every submission and on every read, because a stale in-memory
 * copy would produce a lost update. A re-read costs one file read and one
 * parse of a document this module wrote itself, which is cheap measured
 * against the record a lost update discards without telling anyone.
 *
 * What this critical section covers is exactly the WRITES. A submission's
 * whole read-modify-write runs inside it, because two interleaved cycles
 * would each load the same document and the second rename would discard the
 * first's record. A READ is deliberately outside it: the write is published
 * by an atomic rename, so a reader already sees either the complete previous
 * document or the complete new one and never a partial change. Queueing
 * reads on the mutation chain would buy nothing and cost everything — every
 * read would wait behind other submissions' loads, validation,
 * stringification, staging writes and renames.
 *
 * The module-level promise chain below IS the write queue: each critical
 * section runs behind the one queued before it, which is sufficient
 * coordination for one single-threaded process. What deliberately does not
 * exist is anything beyond it — no reader/writer lock, no separate queue for
 * reads, no cross-process or file lock, and no cache of the store. Ordering
 * writes across processes is out of scope, and a chain held in one module's
 * scope could not do it: it says nothing about a second process writing the
 * same path.
 * ------------------------------------------------------------------------- */

/** @type {Promise<unknown>} The tail of the chain. Never left rejected. */
let chain = Promise.resolve();

/**
 * Runs `task` as a critical section, after every task queued before it.
 *
 * The tail handling is the substance. Passing `task` as BOTH handlers runs it
 * whether the previous task settled or failed, and parking a caught
 * continuation in `chain` means the tail is never a rejected promise — while
 * the caller still receives the real rejection. A naive
 * `chain = chain.then(task)` would leave the chain rejected after one failed
 * write, and every later submission would short-circuit on that stale
 * rejection instead of running: one transient disk error would jam the
 * service until it restarted.
 *
 * @template T
 * @param {() => Promise<T>} task The critical section. Takes no argument: the
 *   value or error handed over from the previous task is not its business.
 * @returns {Promise<T>} The task's own outcome.
 */
function serialize(task) {
  const result = chain.then(task, task);
  chain = result.catch(() => {});
  return result;
}

/* ------------------------------------------------------------------------- *
 * Argument guards
 *
 * A caller passing the wrong shape is a programmer error, not a runtime
 * condition, so these throw plain `TypeError` and `RangeError` and carry none
 * of the refusal codes. `activities.js` validates a request before it gets
 * here, so these guards should be unreachable in production — they exist so
 * that a future caller's mistake surfaces as itself instead of as a store that
 * has been quietly corrupted.
 * ------------------------------------------------------------------------- */

/**
 * Guards the Student ID of a WRITE.
 *
 * A write is held to the full standard — well-formed and present in the key
 * set — because appending a record for an unknown student would produce a
 * document that this module's own loader refuses from then on, turning one
 * bad call into a permanently unreadable store. A read is held only to the
 * shape, since it cannot corrupt anything.
 *
 * @param {unknown} studentId The value to check.
 * @param {Set<string>} keySet The authoritative key set.
 * @returns {string} `studentId`, once proven usable.
 * @throws {TypeError} When it is not a well-formed Student ID.
 * @throws {RangeError} When it is well-formed but names no known student.
 */
function requireKnownStudentId(studentId, keySet) {
  if (typeof studentId !== 'string' || !STUDENT_ID_PATTERN.test(studentId)) {
    throw new TypeError(
      `activity-store: studentId must be a Student ID of the form S000; received ${describeValue(studentId)}`
    );
  }
  if (!keySet.has(studentId)) {
    throw new RangeError(
      `activity-store: studentId ${studentId} names no known student; callers check isKnownStudent first`
    );
  }
  return studentId;
}

/* ------------------------------------------------------------------------- *
 * The public API
 * ------------------------------------------------------------------------- */

/**
 * Tests whether a Student ID names a student who exists.
 *
 * No workbook in this repository declares a key or carries a data-validation
 * part, and JSON offers no constraint mechanism either, so the link between an
 * activity and a student is enforced only in code — at three points that do
 * not rely on one another having run. This lookup is the request-time check,
 * which `activities.js` runs before the store is asked to write anything.
 * `requireKnownStudentId` is the write guard, re-checking the shape and the
 * key-set membership of every ID `addActivity` is about to append.
 * `validateRecord` is the load check, re-checking both properties for every
 * record already in the document, on every load.
 *
 * This one is still not optional. It is the only one of the three whose answer
 * `activities.js` can turn into the documented `404 student_not_found`: the
 * write guard throws a programmer-error type that surfaces as
 * `500 internal_error`, and the load check refuses the whole document with
 * `500 store_unreadable`. The other two protect the document; only this one
 * answers the submitter.
 *
 * A value that is not a well-formed Student ID is answered `false` without
 * touching a workbook: no such value can be in the key set, so reading the
 * file could not change the answer. A well-formed value triggers the key-set
 * read on first use and can therefore surface E_REFERENCE_DATA.
 *
 * @param {unknown} studentId The candidate, for example `'S001'`.
 * @returns {boolean} True only for a Student ID present in
 *   `student_details.xlsx`.
 * @throws {Error} E_REFERENCE_DATA when the key set cannot be read.
 */
function isKnownStudent(studentId) {
  if (typeof studentId !== 'string' || !STUDENT_ID_PATTERN.test(studentId)) {
    return false;
  }
  return loadKeySet().has(studentId);
}

/**
 * Normalizes an activity label, or refuses it.
 *
 * The length bound is checked HERE, after normalization, by the code that
 * performs the normalization — checking it anywhere else would measure a
 * string that the store is not going to keep.
 *
 * No closed vocabulary is imposed. The existing workbook column is
 * unconstrained free text, and an enumeration invented here would refuse a
 * legitimate new club while claiming a constraint the data never carried.
 * Case-insensitive deduplication is the mitigation for near-duplicates
 * instead.
 *
 * @param {unknown} raw The submitted label, for example `'  Chess   Club  '`.
 * @returns {string} The normalized label, for example `'Chess Club'`, with
 *   the submitted casing preserved.
 * @throws {Error} E_LABEL_INVALID when the label is not a string, is empty
 *   once trimmed, carries a control character or a line separator, or falls
 *   outside the 1-to-60-character bound — counted in UTF-16 code units, as
 *   the intake form's `maxlength` is — once normalized.
 */
function normalizeLabel(raw) {
  const inspected = inspectLabel(raw);
  if (!inspected.ok) {
    throw refuse(CODE_LABEL_INVALID, `the activity label ${inspected.reason}`, {
      reason: 'submitted_label_invalid',
    });
  }
  return inspected.value;
}

/**
 * Records an activity for a student, or recognizes one already recorded.
 *
 * The whole read-modify-write runs as one critical section, so two concurrent
 * submissions cannot interleave and lose an update.
 *
 * A submission whose composite key already exists leaves the store EXACTLY as
 * it was — no write at all — and returns the record that was already there,
 * with its original `submittedAt` if it was a submission, or with
 * `source: "workbook"` and no timestamp if it was seeded. That distinction is
 * observable in the caller's status code, which is what makes it assertable.
 * Where the store does not exist yet and the submission duplicates a seeded
 * label, "unmodified" means the file is still not created: seeding it would
 * write a document nobody asked to change.
 *
 * The label is inspected again here rather than trusted. Normalization is
 * idempotent, so this is a no-op for the already-normalized value a caller is
 * contracted to pass, and it is the difference between a contract slip
 * costing an error response and it writing a value the loader would refuse
 * from then on.
 *
 * `source` and `submittedAt` are set by this function and are never accepted
 * from a caller, so submitted input cannot forge provenance.
 *
 * @param {string} studentId A Student ID present in the key set.
 * @param {string} normalizedLabel A label as returned by `normalizeLabel`.
 * @returns {Promise<{created: boolean, record: {studentId: string, activity: string, source: string, submittedAt?: string}}>}
 *   `created` is true when a record was appended and persisted, false when an
 *   identical one already existed.
 * @throws {TypeError|RangeError} When an argument breaks the contract.
 * @throws {Error} E_LABEL_INVALID, E_REFERENCE_DATA, E_STORE_UNREADABLE or
 *   E_STORE_WRITE_FAILED.
 */
function addActivity(studentId, normalizedLabel) {
  return serialize(async () => {
    const keySet = loadKeySet();
    requireKnownStudentId(studentId, keySet);
    const label = normalizeLabel(normalizedLabel);

    const document = await loadDocument(keySet);
    const key = compositeKey(studentId, label);
    const existing = document.activities.find(
      (candidate) => compositeKey(candidate.studentId, candidate.activity) === key
    );

    if (existing !== undefined) {
      return { created: false, record: cloneRecord(existing) };
    }

    /* The append is refused AT CAPACITY, and this is the only place it can
     * be. Appending past `MAX_ACTIVITY_RECORDS` would produce a document that
     * this module's own loader then refuses FOREVER — one write turning the
     * store unreadable, which is precisely the outcome the load-side ceiling
     * exists to prevent. Refusing before the write instead means: the
     * previous document stays intact and readable, a retry is pointless
     * rather than destructive, and the failure is the ordinary
     * `store_write_failed` a caller already handles.
     *
     * Placed AFTER the lookup above deliberately. An idempotent repeat of a
     * record that is already present appends nothing, so it must still
     * succeed at capacity; only a genuinely new record is refused. Reads are
     * untouched — `listActivities` never reaches this code — so a store at
     * capacity keeps answering every question it could answer before. */
    if (document.activities.length >= MAX_ACTIVITY_RECORDS) {
      throw refuse(
        CODE_STORE_WRITE_FAILED,
        `the activity store already holds ${document.activities.length} activities, at the ${MAX_ACTIVITY_RECORDS}-record ceiling this build writes, so it could not be written (no record was appended); the previous document is intact and the submission was not persisted`,
        { reason: 'store_activity_limit_reached' }
      );
    }

    const record = {
      studentId,
      activity: label,
      source: SOURCE_SUBMISSION,
      submittedAt: new Date().toISOString(),
    };

    document.activities.push(record);
    await writeDocument(document);

    return { created: true, record: cloneRecord(record) };
  });
}

/**
 * Lists one student's activities.
 *
 * Reading NEVER has a write side effect: when the store does not exist, the
 * answer comes from the seed snapshot and no file is created. So a fresh
 * checkout answers with the labels the workbook records, and the store is
 * created only by an actual submission.
 *
 * The store is read from disk on every call and is never cached, so a read
 * always answers from the current document. It does NOT enter the write
 * mutex: a submission publishes its document with an atomic rename, so a
 * reader observes either the document before that submission or the one
 * after it — never a partially applied change — and that guarantee comes
 * from the rename rather than from the queue. Keeping reads out of the chain
 * is what stops every `GET` waiting behind other submissions' reads,
 * validation, stringification, staging writes and renames.
 *
 * Unlike a write, this does not require the Student ID to be known: a caller
 * owns the decision to refuse an unknown student, and an identifier that
 * matches no record simply has no activities. The returned records are
 * copies, so mutating them cannot affect the store or the cached snapshot.
 *
 * @param {string} studentId The student whose activities to return.
 * @returns {Promise<Array<{studentId: string, activity: string, source: string, submittedAt?: string}>>}
 *   The student's records in document order; empty when there are none.
 * @throws {TypeError} When `studentId` is not a string.
 * @throws {Error} E_REFERENCE_DATA or E_STORE_UNREADABLE.
 */
async function listActivities(studentId) {
  if (typeof studentId !== 'string') {
    throw new TypeError(
      `activity-store: studentId must be a string; received ${describeValue(studentId)}`
    );
  }

  const keySet = loadKeySet();
  const document = await loadDocument(keySet);

  return document.activities
    .filter((record) => record.studentId === studentId)
    .map(cloneRecord);
}

/**
 * Returns the resolved store path.
 *
 * The path is resolved once at module load and returned verbatim, exactly as
 * it was configured — neither absolutized nor canonicalized here, so it names
 * the file a caller asked for. The staging file this module writes before the
 * rename is this path plus a `.tmp` suffix.
 *
 * @returns {string} The path resolved once at module load, from the
 *   ACTIVITY_STORE environment variable when it was set and otherwise
 *   `activities.json` beside this module.
 */
function storePath() {
  return RESOLVED_STORE_PATH;
}

module.exports = { isKnownStudent, normalizeLabel, addActivity, listActivities, storePath };
