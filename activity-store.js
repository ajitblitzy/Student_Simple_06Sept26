'use strict';

/**
 * activity-store.js — persistence and integrity for student-submitted
 * extracurricular activities.
 *
 * WHAT THIS MODULE OWNS
 * ---------------------
 * The domain. Three rules live here and nowhere else:
 *
 *   1. The key set — which Student IDs exist, read from the authoritative
 *      identity workbook `student_details.xlsx` (sheet `Student Details`,
 *      column A). A Student ID is the FOREIGN key into that workbook.
 *   2. Normalization — what an activity label looks like once accepted, so
 *      `chess club` submitted after `Chess Club` is recognized as the same
 *      activity rather than appended as a near-duplicate.
 *   3. Persistence — the JSON document that holds the records, its validation
 *      on every load, and the atomic write that replaces it.
 *
 * `activities.js` owns the HTTP contract and nothing else: it parses a
 * request, calls the five functions at the foot of this file, and maps their
 * outcomes onto status codes. It performs no string normalization and holds no
 * key set of its own. That split is deliberate — "validate in the HTTP layer,
 * normalize in the store" would spread one rule across two files and leave
 * neither able to enforce it.
 *
 * WHY A SEPARATE STORE AND NOT THE EXISTING WORKBOOK COLUMN
 * ---------------------------------------------------------
 * `student_other_info.xlsx` already carries an `Extracurricular Activity`
 * column, but it holds exactly one label per student and all ten rows are
 * populated, so a submission would either destroy an existing value or pack a
 * delimited list into one cell. Writing it would also mean repacking a
 * committed binary whose diff no reviewer can read. So the workbooks are READ
 * ONLY here — this module must never write `student_details.xlsx`,
 * `student_academics.xlsx`, `student_other_info.xlsx` or `LICENSE` — and the
 * records go to a JSON document that is a runtime artifact, never committed.
 *
 * To stop that document becoming a second, disagreeing source of truth, it is
 * seeded from the workbook column the first time it is materialised, so it is
 * a superset of what the workbook already records rather than a competing
 * answer. Seeded records are marked `source: "workbook"` and deliberately
 * carry NO `submittedAt`: a label sitting in a spreadsheet was not necessarily
 * submitted by a student, and inventing a timestamp would fabricate
 * provenance and make imported data indistinguishable from a real submission.
 *
 * GOVERNING RULE: `Ajit_AddNewFeature_Rule`
 * -----------------------------------------
 * Summarized, not reproduced. Its technical-implementation area is why the
 * loader validation below implements every documented condition rather than a
 * best effort, and why the write mechanics are a temp-file-and-rename behind a
 * failure-tolerant mutex rather than a plain overwrite: both are the
 * deliverable, not optional hardening. Its minimal-change and discipline area
 * is why this module stops at five exports, reads exactly one environment
 * variable (`ACTIVITY_STORE`, the only one the whole feature adds), and
 * introduces no database, no cache library, no index, no pagination, no
 * response cache, no file locking, no surrogate identifier, and no closed
 * vocabulary of permitted activities — the existing column never carried an
 * enumeration, and inventing one here would refuse a legitimate new club.
 *
 * THE FAILURE VOCABULARY
 * ----------------------
 * Every refusal is an `Error` whose `code` is one of exactly four strings,
 * which is what `activities.js` maps to a status and what a test matches on:
 *
 *   E_REFERENCE_DATA       A workbook could not be read, or holds data that
 *                          cannot serve as reference data. -> 500
 *   E_LABEL_INVALID        An activity label failed normalization. -> 400
 *   E_STORE_UNREADABLE     The store failed load validation. -> 500
 *   E_STORE_WRITE_FAILED   A write or rename failed, process alive. -> 500
 *
 * Messages name the offending detail for a log but never carry a filesystem
 * path or a stack: the underlying fault travels as the error's `cause`, and
 * the HTTP layer sends a fixed sentence per code, so nothing internal reaches
 * a client. An argument fault is a caller bug rather than a runtime
 * condition, so it is a `TypeError` or `RangeError` and carries none of these
 * codes.
 *
 * One further refusal exists and is deliberately OUTSIDE that vocabulary:
 *
 *   E_STORE_PATH_PROTECTED  `ACTIVITY_STORE` names a tracked file of this
 *                           repository. A `RangeError`, thrown at MODULE
 *                           LOAD. -> no status
 *
 * It is a CONFIGURATION fault rather than a request outcome, so it is not in
 * the mapping `activities.js` holds and cannot be: nothing can reach a
 * request handler, because `require` itself fails and the service does not
 * start. That is the intended disposition — a store path pointing at a
 * workbook or at `LICENSE` must stop the process, not be discovered by the
 * first submission that renames a document over student data.
 *
 * Every failure path is NON-DESTRUCTIVE. A store this module refuses to load
 * is left exactly as found — never overwritten, never silently repaired —
 * because the document is a plain file a person can edit, and a hand-edit
 * mistake should cost an error response rather than the data.
 *
 * MODULE CHARACTERISTICS
 * ----------------------
 * Asynchronous where it touches the store, synchronous where it reads a
 * workbook (the reader is synchronous by design). Single-process: the write
 * mutex is a module-level promise chain, which is sufficient because the
 * process is single-threaded with no `cluster` and no `worker_threads`, and
 * insufficient for a second process — which nothing here runs, and which the
 * service's fixed port prevents in any case.
 *
 * Usage. Complete and runnable as written — this is CommonJS with no
 * top-level `await`, so the sequence lives in an async function that a
 * caller invokes.
 *
 * Note what `checkStudentId` below does NOT do: test membership alone.
 * `isKnownStudent` answers `false` for three different mistakes — a MISSING
 * value, a MALFORMED one, and a well-formed value that names NO student —
 * while the endpoint contract keeps them apart: `400 student_id_required`,
 * `400 student_id_malformed` and `404 student_not_found` respectively. So the
 * example checks presence, then form, then membership, in that order.
 * `activities.js` owns that precedence for real requests (presence before
 * type before format before existence, and an empty string counts as
 * PRESENT, hence malformed rather than missing); the sequence is mirrored
 * here only so a reader copying this block does not collapse three answers
 * into one:
 *
 *   const store = require('./activity-store');
 *
 *   const STUDENT_ID_FORM = /^S\d{3}$/;
 *
 *   function checkStudentId(studentId) {
 *     if (studentId === undefined || studentId === null) {
 *       return { status: 400, body: { error: 'student_id_required' } };
 *     }
 *     if (typeof studentId !== 'string' || !STUDENT_ID_FORM.test(studentId)) {
 *       return { status: 400, body: { error: 'student_id_malformed' } };
 *     }
 *     if (!store.isKnownStudent(studentId)) {
 *       return { status: 404, body: { error: 'student_not_found' } };
 *     }
 *     return null;
 *   }
 *
 *   async function submit(studentId, rawLabel) {
 *     const refusal = checkStudentId(studentId);
 *     if (refusal !== null) {
 *       return refusal;
 *     }
 *     let label;
 *     try {
 *       label = store.normalizeLabel(rawLabel);   // '  Chess   Club  ' -> 'Chess Club'
 *     } catch (error) {
 *       if (error.code === 'E_LABEL_INVALID') {
 *         return { status: 400, body: { error: 'activity_invalid' } };
 *       }
 *       throw error;
 *     }
 *     const { created, record } = await store.addActivity(studentId, label);
 *     return { status: created ? 201 : 200, body: record };
 *   }
 *
 *   async function list(studentId) {
 *     // A path segment is always present, so only the form and membership
 *     // legs can fire on this route; the same helper serves both.
 *     const refusal = checkStudentId(studentId);
 *     if (refusal !== null) {
 *       return refusal;
 *     }
 *     const records = await store.listActivities(studentId);
 *     return { status: 200, body: { studentId, activities: records } };
 *   }
 *
 *   // Where the records are going, for a startup log line:
 *   console.log('activity store:', store.storePath());
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
 * The store location, and the feature's single environment read.
 *
 * Resolved ONCE, here at module load. Changing the variable later in the
 * process has no effect, which is the documented behaviour: a store path that
 * moved under a running service would split the records across two files.
 *
 * The value is used exactly as given, matching the convention `xlsx-read.js`
 * documents for its own paths, so a caller asserting on `storePath()` gets
 * back precisely what it configured. A relative value is therefore
 * interpreted against the working directory; an absolute one is recommended.
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
 * failure vocabulary in the header: it is a CONFIGURATION fault, not one of
 * the four request-time refusal codes, and `activities.js` neither maps it
 * nor can ever meet it. Failing fast is the point: a static misconfiguration
 * should stop the service starting rather than let every request rediscover
 * it, and stopping at load is what proves nothing was staged over protected
 * data in the meantime.
 * ------------------------------------------------------------------------- */

/**
 * The refusal code for a protected destination. Deliberately NOT one of the
 * four codes in the section below: those four reach a client as a status,
 * while this one can only ever be thrown out of `require`.
 */
const CODE_STORE_PATH_PROTECTED = 'E_STORE_PATH_PROTECTED';

/**
 * Every tracked file that sits beside this module: the AAP's read-only
 * reference data — the three workbooks and `LICENSE` — plus the twelve files
 * this feature's own patch commits. Named repository-relative, with `/` as
 * the separator, and joined against `__dirname` below, so the list reads as
 * the repository rather than as one host's paths.
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
 * regard to case — MEASURED, not inferred from `process.platform`.
 *
 * The probe flips the case of this module's own file name and asks whether
 * that name resolves beside it. The file is guaranteed to be there: it is the
 * one being loaded. So a hit can only mean the filesystem folded the case,
 * and a miss can only mean it did not.
 *
 * A platform guess — `win32 || darwin` — was the previous answer and is wrong
 * in both directions: a case-SENSITIVE APFS or ReFS volume would be assumed
 * to fold, and a case-insensitive volume mounted under Linux would be assumed
 * not to. Folding where the filesystem does not is the damaging direction for
 * this guard, because it would false-refuse a genuinely distinct name such as
 * `license` sitting beside `LICENSE`, so the answer comes from the filesystem
 * itself. For a candidate that EXISTS the question does not arise at all —
 * `canonicalizeForComparison` gets the filesystem's own identity for it — and
 * this constant is applied only to the fallback form below.
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
 * configured — `storePath()` returns it verbatim, and a caller asserting on
 * it gets back precisely what it set — so this form exists solely to decide
 * whether two strings name one file.
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
 * Cost matters here: this runs at module load, once per protected name plus
 * twice for the configured paths, and the test suite re-requires the module
 * dozens of times. Each call is one `realpath` — two only when the candidate
 * is absent — and the protected map it feeds is built exactly once.
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
  throw error;
}

refuseProtectedDestination(RESOLVED_STORE_PATH, 'the store');
refuseProtectedDestination(RESOLVED_TEMPORARY_PATH, 'the derived staging sibling');

/* ------------------------------------------------------------------------- *
 * The document and record vocabulary.
 * ------------------------------------------------------------------------- */

/** The only document version this build reads or writes. */
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
 * Validation vocabulary.
 *
 * The Student ID form is taken from the data rather than invented: all thirty
 * Student ID cells across the three workbooks are `S` followed by exactly
 * three digits.
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
 * The four refusal codes. Not exported: the five functions at the foot of the
 * file are the whole surface, and a caller matches on `err.code`.
 * ------------------------------------------------------------------------- */

const CODE_REFERENCE_DATA = 'E_REFERENCE_DATA';
const CODE_LABEL_INVALID = 'E_LABEL_INVALID';
const CODE_STORE_UNREADABLE = 'E_STORE_UNREADABLE';
const CODE_STORE_WRITE_FAILED = 'E_STORE_WRITE_FAILED';

/* ------------------------------------------------------------------------- *
 * Errors
 * ------------------------------------------------------------------------- */

/**
 * Builds a refusal carrying one of the four declared codes.
 *
 * Returned rather than thrown so each call site reads as `throw refuse(...)`,
 * keeping the control flow obvious at the point of rejection. The originating
 * fault travels as `cause`, which keeps a filesystem path out of `message`
 * while leaving the detail available to a log.
 *
 * @param {string} code One of the CODE_* constants.
 * @param {string} message Names the offending detail. No path, no stack.
 * @param {unknown} [cause] The underlying error, when there is one.
 * @returns {Error} An error whose `code` property is `code`.
 */
function refuse(code, message, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
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
 * One implementation, two callers. `normalizeLabel` throws E_LABEL_INVALID
 * for a submission that fails the rules; the loader raises
 * E_STORE_UNREADABLE for a stored value that fails them, or that passes them
 * but is not already in normalized form. Sharing `inspectLabel` is what keeps
 * those two answers from drifting apart — a second implementation of the same
 * rule would eventually accept on submission what it refuses on load.
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
 * commit. Parsing an OOXML package on every request would be real cost on a
 * path that previously performed no I/O at all.
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
      cause
    );
  }
}

/**
 * Returns the authoritative Student ID key set, reading it on first use.
 *
 * `student_details.xlsx` is named as the authority because it is the identity
 * workbook, which makes it the natural registrar of who exists. All three
 * workbooks currently agree, but naming one removes the ambiguity of which to
 * trust if they ever diverge.
 *
 * A blank trailing cell is tolerated and skipped, since a worksheet may carry
 * empty rows inside its declared dimension. A non-blank value that is not a
 * Student ID, a repeated Student ID, or a column with no Student ID at all is
 * refused: none of those can serve as a key authority, and accepting one
 * would either admit an unverifiable reference or silently shrink the set
 * every submission is checked against.
 *
 * @returns {Set<string>} The key set, for example `{S001 ... S010}`.
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
    const value = column[index].trim();
    if (value === '') {
      continue;
    }
    if (!STUDENT_ID_PATTERN.test(value)) {
      throw refuse(
        CODE_REFERENCE_DATA,
        `row ${index + 1} of ${KEY_SET_WORKBOOK} holds ${describeValue(value)} where a Student ID of the form S000 was expected`
      );
    }
    if (keys.has(value)) {
      throw refuse(
        CODE_REFERENCE_DATA,
        `${KEY_SET_WORKBOOK} repeats Student ID ${value} at row ${index + 1}; the key authority must hold each Student ID once`
      );
    }
    keys.add(value);
  }

  if (keys.size === 0) {
    throw refuse(
      CODE_REFERENCE_DATA,
      `column ${KEY_SET_COLUMN} of ${KEY_SET_WORKBOOK} holds no Student ID, so no submission could be validated against it`
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
 * A student with a blank activity cell simply contributes no record, which is
 * the honest reading of an empty cell: nothing was recorded for them.
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
   * workbook. Two `readWorkbookColumn` calls would do all three twice over for
   * the same bytes — the reader is stateless by design and holds no cache — and
   * this runs on the first request that needs seed data, blocking the single
   * event loop while it does. Asking the reader for both columns at once also
   * keeps the read minimal in the other direction: no cell of the four columns
   * this feature has no use for is decoded. */
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
      cause
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
    const studentId = studentIds[index].trim();
    const rawLabel = labels[index];
    const labelIsBlank = rawLabel.trim() === '';

    if (studentId === '' && labelIsBlank) {
      continue;
    }
    if (!keySet.has(studentId)) {
      throw refuse(
        CODE_REFERENCE_DATA,
        `row ${index + 1} of ${SEED_WORKBOOK} names ${describeValue(studentId)}, which is absent from the key set in ${KEY_SET_WORKBOOK}`
      );
    }
    if (labelIsBlank) {
      continue;
    }

    const inspected = inspectLabel(rawLabel);
    if (!inspected.ok) {
      throw refuse(
        CODE_REFERENCE_DATA,
        `the activity in row ${index + 1} of ${SEED_WORKBOOK} ${inspected.reason}`
      );
    }

    const key = compositeKey(studentId, inspected.value);
    const firstIndex = firstIndexByKey.get(key);
    if (firstIndex !== undefined) {
      throw refuse(
        CODE_REFERENCE_DATA,
        `rows ${firstIndex + 1} and ${index + 1} of ${SEED_WORKBOOK} record the same activity for ${studentId}, which cannot be seeded as two records`
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
 * Reads the store's bytes and decodes them as UTF-8.
 *
 * An absent file is NOT an error — it is the first-use state, and the caller
 * answers from the seed snapshot instead. Anything else that stops the bytes
 * being read is a genuine fault: a store that exists but cannot be read must
 * not be mistaken for one that does not exist, because the caller's response
 * to absence is to seed and write, which would discard it.
 *
 * Decoding is strict, so a file that is not valid UTF-8 is refused rather
 * than silently littered with replacement characters. A single leading byte
 * order mark is tolerated and dropped: this module never writes one, but a
 * Windows editor readily adds one to a hand-edited file, and refusing that
 * outright would be unhelpful without protecting any invariant.
 *
 * @returns {Promise<string|null>} The document text, or null when the store
 *   does not exist.
 * @throws {Error} E_STORE_UNREADABLE when the file exists but cannot be read
 *   or decoded.
 */
async function readStoreText() {
  let bytes;
  try {
    bytes = await fs.readFile(RESOLVED_STORE_PATH);
  } catch (cause) {
    if (describeCause(cause) === 'ENOENT') {
      return null;
    }
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity store exists but could not be read (${describeCause(cause)})`,
      cause
    );
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw refuse(CODE_STORE_UNREADABLE, 'the activity store is not valid UTF-8', cause);
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
      `the activity at index ${index} must be an object; it is ${describeValue(raw)}`
    );
  }

  /* The key set is checked FIRST, so an unrecognized key is reported as
   * itself rather than as whatever field-level complaint happens to follow
   * it. The per-source provenance rule further down narrows this union: it is
   * what refuses a `workbook` record that carries `submittedAt`, with a
   * message that names the provenance conflict rather than the key. */
  const unexpectedRecordKey = findUnexpectedKey(raw, RECOGNIZED_RECORD_KEYS);
  if (unexpectedRecordKey !== null) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} carries the unexpected key ${JSON.stringify(unexpectedRecordKey)}; a record holds studentId, activity, source and submittedAt only, and the document is rewritten whole on every change, so an unrecognized key would be erased by the next submission rather than kept`
    );
  }

  const studentId = raw.studentId;
  if (typeof studentId !== 'string' || !STUDENT_ID_PATTERN.test(studentId)) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} has a studentId of ${describeValue(studentId)}, which is not a Student ID of the form S000`
    );
  }
  if (!keySet.has(studentId)) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} names studentId ${studentId}, which is absent from the key set in ${KEY_SET_WORKBOOK}`
    );
  }

  const inspected = inspectLabel(raw.activity);
  if (!inspected.ok) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} has a label that ${inspected.reason}`
    );
  }
  if (inspected.value !== raw.activity) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} has the label ${describeValue(raw.activity)}, which is not in normalized form; the store is only ever written normalized, so this indicates a hand-edit`
    );
  }

  const source = raw.source;
  if (source !== SOURCE_SUBMISSION && source !== SOURCE_WORKBOOK) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} has a source of ${describeValue(source)}; expected "${SOURCE_SUBMISSION}" or "${SOURCE_WORKBOOK}"`
    );
  }

  const record = { studentId, activity: inspected.value, source };

  if (source === SOURCE_SUBMISSION) {
    if (!isIsoUtcInstant(raw.submittedAt)) {
      throw refuse(
        CODE_STORE_UNREADABLE,
        `the activity at index ${index} is a ${SOURCE_SUBMISSION} whose submittedAt is ${describeValue(raw.submittedAt)}; an ISO-8601 instant in UTC was expected`
      );
    }
    record.submittedAt = raw.submittedAt;
  } else if (Object.prototype.hasOwnProperty.call(raw, 'submittedAt')) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity at index ${index} is sourced from the ${SOURCE_WORKBOOK} yet carries submittedAt; a seeded record must not claim a submission time`
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
      cause
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity store must hold a JSON object; it holds ${describeValue(parsed)}`
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
      `the activity store carries the unexpected top-level key ${JSON.stringify(unexpectedDocumentKey)}; this build reads schemaVersion and activities only, and the document is rewritten whole on every change, so an unrecognized key would be erased by the next submission rather than kept`
    );
  }

  const version = parsed.schemaVersion;
  if (typeof version !== 'number' || version !== SCHEMA_VERSION) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity store declares a schemaVersion of ${describeValue(version)}; this build reads version ${SCHEMA_VERSION} only`
    );
  }

  const activities = parsed.activities;
  if (!Array.isArray(activities)) {
    throw refuse(
      CODE_STORE_UNREADABLE,
      `the activity store must hold an activities array; it holds ${describeValue(activities)}`
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
        `the activities at index ${firstIndex} and index ${index} share the composite key (${record.studentId}, ${describeValue(record.activity)}) compared case-insensitively; this service never writes that state, so it must be resolved by hand rather than deduplicated automatically`
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
 * ------------------------------------------------------------------------- */

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
 * behind the mutex, and because a stale staging file is never READ — only
 * truncated and overwritten by the next write — so its contents can never be
 * mistaken for the store.
 *
 * On failure with the process alive, the previous document is left intact and
 * the submission is simply not persisted; retrying is safe, because a
 * submission is idempotent by composite key. Durability beyond the rename is
 * not attempted: there is no fsync here, matching the specified mechanics for
 * a loopback-only service whose store is a runtime artifact.
 *
 * @param {{schemaVersion: number, activities: Array<Object>}} document The
 *   document to persist.
 * @returns {Promise<void>}
 * @throws {Error} E_STORE_WRITE_FAILED when the write or the rename fails.
 */
async function writeDocument(document) {
  const serialized = `${JSON.stringify(document, null, JSON_INDENT)}\n`;
  try {
    await fs.writeFile(RESOLVED_TEMPORARY_PATH, serialized, { encoding: 'utf8' });
    await fs.rename(RESOLVED_TEMPORARY_PATH, RESOLVED_STORE_PATH);
  } catch (cause) {
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      `the activity store could not be written (${describeCause(cause)}); the previous document is intact and the submission was not persisted`,
      cause
    );
  }
}

/* ------------------------------------------------------------------------- *
 * The write mutex
 *
 * The store is the one file that changes, so it is NEVER cached: it is read
 * from disk on every submission and on every read, because a stale in-memory
 * copy would produce a lost update. At ten students and one small document
 * that costs nothing worth optimizing.
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
 * A module-level promise chain is sufficient for one single-threaded process
 * and is not a substitute for file locking across processes, which is out of
 * scope. Nothing else coordinates: there is no reader/writer lock, no queue
 * and no cache anywhere in this module's store path.
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
 * of the four codes. `activities.js` validates a request before it gets here,
 * so these guards should be unreachable in production — they exist so that a
 * future caller's mistake surfaces as itself instead of as a store that has
 * been quietly corrupted.
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
 * This is the one referential-integrity check the feature has. No workbook in
 * this repository declares a key or carries a data-validation part, and JSON
 * offers no constraint mechanism either, so the link between an activity and
 * a student can only be enforced in code — here, before anything is written.
 * There is no second line of defence.
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
    throw refuse(CODE_LABEL_INVALID, `the activity label ${inspected.reason}`);
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
 * Exposed so a test can assert which file it is exercising rather than
 * inferring it, and so an operator can see where submissions are going. The
 * staging file is this path plus a `.tmp` suffix.
 *
 * @returns {string} The path resolved once at module load, from the
 *   ACTIVITY_STORE environment variable when it was set and otherwise
 *   `activities.json` beside this module.
 */
function storePath() {
  return RESOLVED_STORE_PATH;
}

module.exports = { isKnownStudent, normalizeLabel, addActivity, listActivities, storePath };
