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
 *   E_STORE_AT_CAPACITY    The store is at a ceiling, so a new record would
 *                          grow it past what this build can read back. Kept
 *                          apart from the write failure above because the two
 *                          have different remedies: retry the one, reclaim
 *                          room for the other. -> 500
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
/* For the ONE operation the runtime offers no API for: setting a file's ACL on
 * a platform whose access control is an ACL rather than a mode. `node:fs` can
 * `chmod` and nothing more, so the platform's own tool is invoked — see
 * `restrictStagedFileToItsOwner`. A built-in module, so the project's
 * zero-third-party-dependency posture is untouched, and the module OBJECT is
 * held rather than `execFile` destructured off it, so the call site remains a
 * property lookup a test can substitute. */
const childProcess = require('node:child_process');
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
 * Because this throws out of `require`, what an operator actually sees is
 * decided by whoever loaded the module. `server.js` catches this code at its
 * startup boundary and reports it as one `server error: E_STORE_PATH_PROTECTED`
 * line followed by the sentence below, with a non-zero exit and no stack
 * trace; a caller that loads the feature itself receives this error object
 * unchanged. Either way the `message` is the diagnosis, which is why it names
 * the variable, the file it resolved to, and what to do instead.
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
 * the record count is enforced as E_STORE_AT_CAPACITY and so is the
 * serialized byte length — a code of its own rather than the generic write
 * failure, because a full store and a broken disk need different remedies and
 * a caller told the same thing for both cannot tell which it met. None of the
 * four ever repairs, truncates or rewrites anything: a document at or over a
 * ceiling is left exactly as found, like every other refused load, and a
 * refused write stages nothing.
 *
 * HOW MUCH HEADROOM THERE IS, AND WHO IS TOLD. At human submission rates
 * neither ceiling is reachable; at machine rates the record ceiling is, and
 * the QA measurement for this build puts it at roughly 26 seconds of
 * saturating submission. A ceiling met with no prior signal is a cliff, so
 * `reportCapacityHeadroom` writes one warning line when the document first
 * crosses `CAPACITY_WARNING_RECORDS`, which gives an operator a window in
 * which to act rather than a refusal as the first news. Reclaiming space is
 * deliberately NOT a feature — editing and deleting activities are out of
 * scope for this project — so the remedy is an operator pruning the store
 * file, which `README.md` documents step by step.
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
 * The record count at which the store starts saying it is running out of room:
 * ninety per cent of the ceiling, so the last tenth of the document is a
 * warning band rather than a surprise.
 *
 * A ceiling with no approach signal is a cliff. This one is reachable in about
 * twenty-six seconds of saturating submission, which is no time at all for a
 * person to notice a store filling up, so the last thing an operator should
 * learn from is the first refusal. Ninety per cent leaves five hundred records
 * of room after the warning — enough that acting on it is still cheap, late
 * enough that an ordinary store never trips it.
 */
const CAPACITY_WARNING_RECORDS = Math.floor(MAX_ACTIVITY_RECORDS * 0.9);

/**
 * How much of the store is read per `read` call: one 64 KiB buffer, reused for
 * the life of the call rather than one allocation per chunk. Large enough that
 * a 2 MiB ceiling costs at most 32 reads, small enough that the read is
 * genuinely incremental instead of one unbounded allocation.
 */
const STORE_READ_CHUNK_BYTES = 64 * 1024;

/* ------------------------------------------------------------------------- *
 * How much of the load path may run without yielding
 *
 * This process is single-threaded and every route shares one event loop, so
 * the unit that matters is not how long a request takes but how long it runs
 * WITHOUT LETTING ANYTHING ELSE RUN. A validation loop that runs to
 * completion converts the document's size into a stall for every other
 * request in flight, including the routes that touch no store at all.
 *
 * MEASURED on this project's runtime, at 4900 records / 828 KB — a document
 * both ceilings accept: the whole load ran as ONE uninterrupted 9.2 ms
 * synchronous run (a submission's, 13.2 ms, because it stringifies as well),
 * and while four readers and four writers were in flight the preserved
 * zero-I/O `GET /` path — which performs no I/O and never touches the store —
 * went from a p50 of 0.4 ms to 7.1 ms. Nothing was slow for its own sake; one
 * request simply held the loop.
 *
 * Within that run the parse and the re-serialization are single calls into the
 * runtime, 1.4 ms and 1.9 ms, and cannot be broken up without hand-rolling a
 * JSON parser — which would be a far larger change, slower in total, and a new
 * source of divergence from `JSON.parse`. They are therefore the floor: no
 * amount of chunking can bound a run below the longest single call the runtime
 * makes. The per-record validation is the part that CAN be broken up, and at
 * 4 ms it is also the largest, so the loop yields the event loop whenever its
 * current uninterrupted run has gone on longer than the budget below.
 *
 * A BUDGET IN TIME RATHER THAN A COUNT OF RECORDS, and the difference is not
 * cosmetic. The property worth having is "no request holds the loop for longer
 * than about a millisecond", which is what this states directly; a fixed batch
 * size only approximates it, and approximates it differently on every host,
 * because what a batch costs depends on the machine, on how loaded it is and
 * on what the records contain. A count also yields on a schedule rather than
 * on need: MEASURED here, a fixed 256-record batch yielded nineteen times for
 * a 4900-record document where the budget yields a handful, and those extra
 * turns showed up as a higher `GET /` p50 under moderate read load — the work
 * was spread so thinly that an arriving request was more likely to collide
 * with some of it, for no reduction in what it collided with. Yielding only
 * when the run has actually overrun gets the bound without the smear.
 *
 * The clock is read once every `VALIDATION_CLOCK_INTERVAL_RECORDS` records
 * rather than on each one, so the measurement costs a fraction of what it
 * measures, and a document shorter than that interval never reads it at all.
 *
 * WHAT THIS IS NOT. It is not a cache and not a weakening of validation: the
 * store is still read from disk on every request, and every record is still
 * validated on every load, exactly as the specification requires. The work is
 * unchanged; only its granularity is. Every document this feature is actually
 * for — the seeded one is 11 records and about 2 KB — completes inside a single
 * budget and never yields at all, so it runs the code path it always ran.
 * ------------------------------------------------------------------------- */

/**
 * How long one uninterrupted run of record validation may last before the
 * event loop is handed back, in nanoseconds.
 *
 * A QUARTER OF A MILLISECOND, and the size was measured rather than guessed.
 * What an arriving request actually waits for is not the longest run but the
 * run it lands in the middle of, so halving the budget halves the typical
 * wait: MEASURED over HTTP at 4900 records with four readers and four writers
 * in flight, a 1 ms budget put the preserved `GET /` path at a p50 of about
 * 2.0 ms and a quarter-millisecond budget at about 1.4 ms, against 7.1 ms with
 * no budget at all and 0.4 ms idle. Going tighter still buys nothing: the
 * runtime's own atomic `JSON.parse` and `JSON.stringify` of a document at the
 * byte ceiling are 1.4 ms and 1.9 ms, so below this point they, and not
 * validation, are the longest run in the process.
 */
const VALIDATION_RUN_BUDGET_NS = 250000n;

/**
 * How many records pass between two readings of the clock. Large enough that
 * `process.hrtime.bigint()` is a rounding error against the validation it
 * paces, small enough that the budget is overshot by at most this many
 * records' work — about 0.03 ms here.
 */
const VALIDATION_CLOCK_INTERVAL_RECORDS = 32;

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
 *   - C0 apart from TAB, `\u0000`-`\u0008` and `\u000a`-`\u001f`, which
 *     includes newline, carriage return, vertical tab and form feed;
 *   - DEL and C1, `\u007f`-`\u009f`;
 *   - `\p{Zl}` LINE SEPARATOR (U+2028) and `\p{Zp}` PARAGRAPH SEPARATOR
 *     (U+2029).
 *
 * U+0009 TAB is deliberately ABSENT from this class. It is horizontal
 * whitespace — and it is the character a spreadsheet copy-paste produces, in
 * a project whose data comes from spreadsheets — so the class below collapses
 * it BEFORE this check runs, which is the step order normalization follows —
 * the specification's trim, collapse internal whitespace, then reject
 * whatever is left, preceded by the canonicalization step described at
 * `canonicalizeLabel`. A tab therefore never reaches this pattern, and no tab
 * can survive into a stored value.
 *
 * The line terminators are in this class rather than in the trim/collapse
 * class on purpose, and that is the line a tab does not cross. U+2028 and
 * U+2029 carry their own Unicode categories precisely because they break a
 * line, as do `\n` and `\r`; laundering any of them into a space would ACCEPT
 * a label carrying a line break, and two visually identical labels would then
 * dedupe differently depending on which character separated their words. A
 * label is a single line of text, so the honest answer for each of them is
 * refusal. Left out of this class entirely they would be worse than either:
 * neither trimmed, nor collapsed, nor refused, so `Chess\u2028Club` would
 * persist and produce a composite key distinct from `Chess Club`, and the
 * loader would then read it back as already normalized.
 */
const CONTROL_OR_LINE_SEPARATOR_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\p{Zl}\p{Zp}]/u;

/**
 * The whitespace that is trimmed and collapsed: the Unicode SPACE SEPARATOR
 * category plus U+0009 TAB. Horizontal whitespace, and nothing else.
 *
 * This is the load-bearing choice in normalization, and the two halves of the
 * class earn their place differently. `\p{Zs}` covers every space a keyboard
 * or a paste can produce, U+00A0 and U+2003 included, so no non-ASCII space
 * survives into a stored value. The tab joins them because inside a
 * single-line label it is horizontal whitespace and nothing else: collapsing
 * it is what makes `Chess\tClub` and `Chess Club` one activity rather than
 * two, which is the same deduplication a doubled space already gets.
 *
 * What is deliberately NOT here is every other control character. A general
 * `\s` class would also launder `\n`, `\r`, `\v`, `\f` and U+2028 into a
 * space, so a label carrying a line break would be ACCEPTED and the refusal
 * rule above would be dead for exactly the characters that matter most.
 * Because none of those is horizontal whitespace, each survives trimming and
 * collapsing untouched and is then rejected by the check above.
 */
const LEADING_SPACE_PATTERN = /^[\t\p{Zs}]+/u;
const TRAILING_SPACE_PATTERN = /[\t\p{Zs}]+$/u;
const INTERNAL_SPACE_RUN_PATTERN = /[\t\p{Zs}]+/gu;

/**
 * The invisible formatting characters that are REMOVED from a label:
 *
 *   - U+00AD SOFT HYPHEN, a discretionary line-break hint;
 *   - U+180E MONGOLIAN VOWEL SEPARATOR;
 *   - U+200B-U+200F: the zero-width space, the zero-width non-joiner and
 *     joiner, and the left-to-right and right-to-left MARKS;
 *   - U+2060-U+2064: the word joiner and the four invisible math operators;
 *   - U+FEFF, the byte-order mark in its zero-width-no-break-space role.
 *
 * These are the invisible analogue of the padding the class above already
 * trims, so they are REMOVED rather than refused. Every one of them is
 * zero-width: a paste from a web page or a spreadsheet cell carries them
 * without the submitter ever seeing one, and a refusal message about a
 * character nobody can see is not actionable — it names a fault the person
 * cannot find in their own input. Removal is also what the deduplication rule
 * needs, because none of them is `\p{Zs}` and none is a control character, so
 * without this class `Tennis Club` and `Tennis Club\u200b` both survive
 * normalization unchanged and persist as two visually identical records.
 *
 * What is deliberately NOT in this class, and why:
 *
 *   - THE BIDI CONTROLS — U+202A-U+202E, the embeddings and the overrides,
 *     U+2066-U+2069, the isolates, and U+061C ARABIC LETTER MARK. Those are
 *     DIRECTION controls: they reorder visible text rather than being
 *     padding, so a label carrying one is a label whose author meant
 *     something by it. They are accepted deliberately, and the served HTML
 *     wraps every interpolated value in a `<bdi>` element precisely so an
 *     unterminated override cannot reverse the sentence around it — see the
 *     bidi cases in `test/activities.test.js`. Removing them here would
 *     silently change an accepted, tested behaviour.
 *   - VARIATION SELECTORS, U+FE00-U+FE0F and U+E0100-U+E01EF, because they
 *     change how the preceding character RENDERS: dropping one would change
 *     the glyph the submitter chose.
 *
 * The one honest cost: an emoji ZWJ sequence is flattened to its component
 * glyphs, and a Persian or Hindi ZWNJ that shapes a word is dropped. That is
 * accepted because every member of this class is zero-width — the label read
 * back differs from the one typed only in characters that occupy no space —
 * and the alternative is two labels that render identically persisting as two
 * records, which is the near-duplicate risk normalization exists to mitigate.
 *
 * The `g` flag is what makes `String.prototype.replace` remove every
 * occurrence rather than only the first. This pattern is used with `replace`
 * and nothing else, so the `lastIndex` that a stateful `test` would leave
 * behind between calls never arises.
 */
const INVISIBLE_FORMAT_PATTERN = /[\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]/gu;

/**
 * The ONLY rule by which a workbook label counts as blank, and therefore as a
 * row that records nothing.
 *
 * Deliberately the same horizontal-whitespace class the three patterns above
 * use, and applied by `loadSeedRecords` to the CANONICALIZED cell rather than
 * to the raw one, which together make the blank rule and the normalization
 * rule agree by construction: a cell this pattern calls blank is one
 * `inspectLabel` would also reduce to the empty string, and every cell it
 * does not call blank goes through `inspectLabel` and is answered there —
 * accepted if it normalizes, refused if it carries a control character or a
 * line separator.
 *
 * Testing the canonicalized cell is what keeps that equivalence true for the
 * invisible characters `INVISIBLE_FORMAT_PATTERN` removes. A cell holding
 * nothing but a byte-order mark is blank to a reader's eye and blank to
 * `inspectLabel`, which removes the mark and then has an empty string left;
 * tested raw it would instead be a one-character label, fail normalization as
 * empty, and take the WHOLE seed down with E_REFERENCE_DATA — every request
 * answered `500 reference_data_unavailable` because one workbook cell carried
 * an invisible character. Blank means blank on both sides of the rule.
 *
 * The class is wrong in both directions if it drifts from that one. A
 * `rawLabel.trim() === ''` test would be WIDER, because
 * `String.prototype.trim` also strips `\n`, `\v`, `\f` and `\r` — every one of
 * them a character `CONTROL_OR_LINE_SEPARATOR_PATTERN` exists to refuse — so a
 * cell holding a lone newline would test as blank and have its row SKIPPED
 * before `inspectLabel` could see it, leaving the no-control-character rule
 * dead for the values most likely to arrive from a hand-edited spreadsheet. A
 * `\p{Zs}`-only test would be NARROWER, and a cell holding a lone tab would
 * then be refused as an empty label while a cell holding a lone space was
 * quietly skipped — one kind of blank cell with two answers.
 *
 * Note the `*` rather than `+`: an absent cell arrives as the empty string,
 * which is blank.
 */
const HORIZONTAL_WHITESPACE_ONLY_PATTERN = /^[\t\p{Zs}]*$/u;

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

/**
 * The store is at a ceiling, so a record that would grow it is refused.
 *
 * SEPARATE FROM `E_STORE_WRITE_FAILED`, AND THAT IS THE WHOLE POINT. Both stop
 * a submission being persisted, but they are different events with different
 * remedies and they had been reporting as one: a write that fails because the
 * directory is unwritable, the disk is full or the rename is refused is an
 * ENVIRONMENTAL fault, where retrying is the sensible next move and an
 * operator should look at the host; a refusal at a ceiling is this build
 * declining to grow a document it would no longer be able to read back, where
 * retrying is pointless and the only remedy is to reclaim space in the store.
 * Told the same code and the same sentence for both, a submitter cannot tell
 * which happened and an operator reading a log cannot either.
 *
 * Raised by both ceilings, because both are the same event — the document
 * cannot grow — measured two different ways: the record count, before the
 * append, and the serialized byte length, before anything is staged.
 *
 * NOTHING IS REPAIRED, TRUNCATED OR OVERWRITTEN on this path. The previous
 * document stays byte-identical and fully readable, so every question the
 * store could answer before a refusal it can still answer afterwards.
 */
const CODE_STORE_AT_CAPACITY = 'E_STORE_AT_CAPACITY';

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
 *   detail  The `code` of the underlying fault, or `null` when there was no
 *           underlying fault. This is the difference between "the store could
 *           not be written" and knowing the directory was missing, read-only
 *           or full. Two sources, and which one it came from is legible from
 *           the code itself: a `node:fs` errno such as `ENOENT` for THIS
 *           module's own filesystem work — the staging write, the rename, the
 *           startup probe — and an `E_XLSX_*` code for anything the reader
 *           raised. A reader failure never arrives here as an errno, because
 *           `xlsx-read.js` translates its own filesystem faults into
 *           `E_XLSX_UNSUPPORTED_SOURCE`; so a missing workbook is that code
 *           with `reason: 'source_missing'`, not a bare `ENOENT`.
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
 *
 * The step order is: CANONICALIZE — remove the invisible formatting
 * characters, then put the result into Unicode NFC — then trim, then collapse
 * internal horizontal whitespace, then refuse any remaining control character
 * or line separator, then enforce the 1-to-60 bound. `canonicalizeLabel`
 * below is the first step on its own, because `compositeKey` needs it without
 * the rest.
 * ------------------------------------------------------------------------- */

/**
 * Removes the invisible formatting characters and returns the result in
 * Unicode NFC. The canonical form of a label, and the form the store holds.
 *
 * THE ORDER IS MEASURED, NOT PREFERRED. For `'e\u200b\u0301'` — an `e`, a
 * zero-width space, a combining acute — normalizing first and stripping
 * second yields U+0065 U+0301, still decomposed, because U+200B is a starter
 * with combining class 0 sitting between the base and the accent and it
 * BLOCKS the composition; stripping first and normalizing second yields
 * U+00E9. Strip-first is therefore what guarantees the returned value is
 * itself in NFC, and with it that canonicalization is idempotent —
 * `canonicalizeLabel(canonicalizeLabel(x)) === canonicalizeLabel(x)`.
 *
 * The loader depends on exactly that: it refuses any stored label that is not
 * already in normalized form, so a normalizer whose output could need
 * normalizing again would write documents its own loader then rejects.
 *
 * @param {string} value A label, or any string being compared as one.
 * @returns {string} The same text with the invisible formatting characters
 *   removed, in NFC.
 */
function canonicalizeLabel(value) {
  return value.replace(INVISIBLE_FORMAT_PATTERN, '').normalize('NFC');
}

/**
 * Applies the normalization rules and reports the outcome without throwing,
 * so each caller can raise the code that belongs to its own context.
 *
 * The order is exact and each step depends on the one before it:
 *
 *   1. Canonicalize, through `canonicalizeLabel`: remove the invisible
 *      formatting characters, then put the result into Unicode NFC. So
 *      `Caf\u00e9 Club` and `Cafe\u0301 Club` become one label, and a
 *      zero-width space cannot pad one label into two.
 *   2. Trim leading and trailing horizontal whitespace.
 *   3. Collapse every internal run of horizontal whitespace to a single
 *      space. A tab is horizontal whitespace, so `Chess\tClub` becomes
 *      `Chess Club` here and carries nothing forward for step 4 to refuse.
 *   4. Reject any remaining control character or line separator. A newline, a
 *      carriage return or a U+2028 LINE SEPARATOR reaches this step intact
 *      because step 3 collapses horizontal whitespace only.
 *   5. Enforce the length bound, measured AFTER the three steps above, so
 *      padding — visible or invisible — cannot push a legitimate label over
 *      the limit, and a decomposed accent cannot count twice.
 *
 * Step 1 runs BEFORE the trim and the collapse rather than after them, which
 * is the opposite of the obvious placement and the difference is observable:
 * `'Tennis \u200b Club'` has the zero-width space removed between two spaces,
 * so stripping after the collapse would leave the DOUBLED space `'Tennis
 * Club'` — two spaces — in the stored value, with nothing left to tidy it.
 * Canonicalizing first hands the collapse a single run to fold. Running it
 * before the emptiness check is what makes a label of nothing but invisible
 * characters refused rather than stored as a record with no visible content,
 * and running it before the bound is what measures the string the store will
 * actually keep.
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

  const normalized = canonicalizeLabel(raw)
    .replace(LEADING_SPACE_PATTERN, '')
    .replace(TRAILING_SPACE_PATTERN, '')
    .replace(INTERNAL_SPACE_RUN_PATTERN, ' ');

  if (CONTROL_OR_LINE_SEPARATOR_PATTERN.test(normalized)) {
    return { ok: false, reason: 'must not contain control characters or line separators' };
  }

  const length = normalized.length;
  if (length < MIN_LABEL_LENGTH) {
    return {
      ok: false,
      reason:
        'must not be empty once surrounding whitespace and invisible formatting characters are removed',
    };
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
 * The label is put through `canonicalizeLabel` before its case is folded.
 * Every caller inside this module passes a value `inspectLabel` has already
 * canonicalized, so for them the call is a no-op — it is defence in depth for
 * a caller that reached this comparison with a value that never went through
 * `normalizeLabel`, which is exactly the path by which a decomposed accent or
 * a zero-width space would otherwise produce a second key for one visible
 * label. The cost is 2 ms per 5000 keys measured on the supported runtime, so
 * the duplicate scan the loader runs over a full store is unaffected.
 *
 * @param {string} studentId A well-formed Student ID.
 * @param {string} normalizedLabel A label in normalized form.
 * @returns {string} The comparison key: canonical, and folded to lower case.
 */
function compositeKey(studentId, normalizedLabel) {
  return `${studentId}\u0000${canonicalizeLabel(normalizedLabel).toLowerCase()}`;
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
 * The translation is TOTAL, and it is total because the reader leaves nothing
 * uncoded: a workbook that is absent or unreadable is
 * `E_XLSX_UNSUPPORTED_SOURCE` rather than a raw errno, a part that is not a
 * worksheet is `E_XLSX_MALFORMED_XML` rather than an empty column, and even a
 * caller fault inside this module would arrive as
 * `E_XLSX_INVALID_ARGUMENT`. So the `catch` below is a single exhaustive
 * boundary rather than a best effort, and the `detail` recorded on the
 * diagnostic is always one of the reader's codes.
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
 * "Blank" means `HORIZONTAL_WHITESPACE_ONLY_PATTERN` applied to the
 * CANONICALIZED cell — empty, horizontal whitespace only, or invisible
 * formatting characters only — and nothing wider. Canonicalizing first is
 * what keeps the blank rule and the normalizer in agreement: a cell holding
 * nothing but a byte-order mark contributes no record, exactly as an empty
 * cell does, instead of reaching `inspectLabel` as a one-character label,
 * failing as empty, and failing the whole seed with E_REFERENCE_DATA — which
 * would answer every request `500 reference_data_unavailable` over one
 * invisible character in one spreadsheet cell. A cell holding a lone newline
 * is still NOT blank: it is a label carrying a control character, and it is
 * refused by `inspectLabel` like any other, rather than skipped as though the
 * row said nothing.
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
    /* Both values AS READ. Neither is trimmed before it is validated: a
     * `String.prototype.trim` made `'S001\t'` a valid Student ID and made a
     * newline-only label test as blank, so the row was skipped before
     * `inspectLabel` could refuse it.
     *
     * The blank test is the one exception, and it is not a trim: the cell is
     * CANONICALIZED for that test alone, so the invisible characters
     * `inspectLabel` removes cannot make a cell that is blank to the eye read
     * as a one-character label. The test class stays exactly the horizontal
     * whitespace the normalizer trims, so nothing that survives
     * canonicalization is laundered — a newline-only cell is still not blank
     * and is still refused. */
    const studentId = studentIds[index];
    const rawLabel = labels[index];
    const labelIsBlank = HORIZONTAL_WHITESPACE_ONLY_PATTERN.test(canonicalizeLabel(rawLabel));

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
 * The publish window
 *
 * WHY THIS EXISTS, MEASURED RATHER THAN REASONED ABOUT. A write is published
 * by renaming the staging file over the store. On Windows the call behind
 * `fs.rename` is `MoveFileEx`, and it REFUSES with EPERM
 * (`ERROR_SHARING_VIOLATION`) while any descriptor is open on the
 * destination. The read path holds exactly such a descriptor — it opens the
 * store, stats it, reads it in chunks and closes it — and it does so outside
 * the write mutex by design. So on this platform the reader wins the race and
 * the WRITER is the casualty. Measured on this host, against the service,
 * with writes at concurrency five and the store in a scratch directory: no
 * reader refused 0% of 200 submissions, ONE continuous reader refused 37%,
 * and four refused 98.5% — every refusal a well-formed submission from a
 * known student answered `500 store_write_failed` and lost. `rename(2)` on
 * POSIX succeeds regardless of open descriptors, which is why publishing
 * atomically needs a mechanism here rather than an assumption.
 *
 * WHAT THIS IS NOT. It is not a second mutex, and a read is still NOT queued
 * on the mutation chain: queueing reads there would make every
 * `GET /activities/{id}` wait behind other submissions' loads, validation,
 * stringification and staging writes, which is the cost this design
 * deliberately refuses. What is excluded is the RENAME ALONE. A read already
 * in flight when a publish begins is waited for; a read arriving while a
 * publish is in flight waits for it. A rename is one syscall over two names
 * in one directory, so this is the shortest window a read could be asked to
 * wait on, and it is bounded in both directions — the wait for reads to
 * drain gives up after `PUBLISH_DRAIN_TIMEOUT_MS` and renames anyway, so no
 * read can stall the write queue.
 *
 * WHAT IT CANNOT COVER, stated rather than papered over. A descriptor held by
 * a process OUTSIDE this one — an operator running `cat`, a backup agent, a
 * virus scanner — is invisible to an in-process counter. The bounded retry in
 * `publishStagedDocument` is the mitigation for that case, and it is a
 * mitigation rather than a guarantee: a foreign process that keeps the store
 * open continuously will still see submissions refused, with the previous
 * document intact. Coordinating across processes would need file locking,
 * which is out of scope for a single-instance loopback-only service whose
 * port is a literal.
 *
 * Only one publish can ever be in flight, because every publish happens
 * inside the write mutex below, and the barrier is opened and closed within
 * one critical section. That is what makes a single barrier variable
 * sufficient, and it is also why a write's own load can never block on a
 * barrier: no other write is publishing while this one is loading.
 * ------------------------------------------------------------------------- */

/** @type {number} How many reads hold a descriptor on the store right now. */
let activeStoreReads = 0;

/**
 * @type {Promise<void>|null} Non-null exactly while a publish is in flight. A
 * read awaits it before opening the store, so no new descriptor can appear
 * between the drain and the rename.
 */
let publishBarrier = null;

/** @type {(() => void)|null} Resolves `publishBarrier`, or null when none is open. */
let releasePublishBarrier = null;

/** @type {Array<() => void>} Waiters for `activeStoreReads` reaching zero. */
const readDrainWaiters = [];

/**
 * How long a publish waits for the reads already in flight to finish before
 * attempting the rename regardless.
 *
 * A read is a bounded operation on a local file under `MAX_STORE_BYTES` and
 * always leaves the window through a `finally`, so this deadline should never
 * elapse. It is here because the consequence of being wrong about that would
 * be the write queue stalling behind a read, which is strictly worse than the
 * EPERM this coordination exists to avoid: on timeout the rename is attempted
 * anyway, the bounded retry below still applies, and the worst outcome is the
 * refusal that was already the documented behaviour.
 */
const PUBLISH_DRAIN_TIMEOUT_MS = 100;

/**
 * How many times the rename may be attempted before the write is refused.
 *
 * Bounded, and deliberately the same shape as `MAX_STAGING_OPEN_ATTEMPTS`
 * below: a retry is a response to something else holding the destination, one
 * or two attempts clear the ordinary case, and a destination held continuously
 * is a process racing this one rather than a state to wait out. Retrying
 * forever would spin inside the write mutex and hold up every later
 * submission, so the write is refused instead and the previous document is
 * left intact.
 */
const MAX_PUBLISH_ATTEMPTS = 3;

/** The backoff before the next publish attempt, multiplied by the attempt number. */
const PUBLISH_RETRY_BACKOFF_MS = 5;

/**
 * The refusals that mean "something holds the destination right now" rather
 * than "this rename cannot work".
 *
 * EPERM is what Windows reports for a destination open elsewhere, EACCES is
 * its POSIX-side equivalent for a permission or share conflict, and EBUSY is
 * reported where the destination is held by the kernel. Anything else — a
 * missing directory (ENOENT), a cross-device path (EXDEV), a destination that
 * has become a directory (EISDIR) — will fail identically on every attempt,
 * so it is refused immediately rather than retried three times for nothing.
 */
const PUBLISH_COLLISION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Resolves after `milliseconds`, using the global timer rather than a new
 * `require`, and always settles so it can never hold a caller open.
 *
 * @param {number} milliseconds How long to wait.
 * @returns {Promise<void>}
 */
function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Registers a read that is about to open the store, waiting for any publish
 * in flight to finish first.
 *
 * The `while` rather than an `if` is load-bearing: when a barrier resolves,
 * every waiter wakes as a queued microtask, and a later publish may already
 * have opened a new barrier by the time a given waiter runs. The counter is
 * incremented with NO await between the check and the increment, so a read
 * can never register itself after a publish has begun draining.
 *
 * @returns {Promise<void>} Resolves once the read may open the store.
 */
async function enterReadWindow() {
  while (publishBarrier !== null) {
    await publishBarrier;
  }
  activeStoreReads += 1;
}

/**
 * Retires a read, releasing a publish that is waiting for the last one.
 *
 * Called from a `finally`, so a read that threw still leaves the window — a
 * leaked count would make every later publish wait out its drain deadline.
 *
 * @returns {void}
 */
function leaveReadWindow() {
  activeStoreReads -= 1;
  if (activeStoreReads > 0 || readDrainWaiters.length === 0) {
    return;
  }
  for (const resolveDrain of readDrainWaiters.splice(0)) {
    resolveDrain();
  }
}

/**
 * Waits, bounded, for every read in flight to finish.
 *
 * The timer is always cleared and the waiter always de-registered, so this
 * leaves no pending timer to hold the event loop open and no stale resolver
 * in the queue — both of which would show up as a test runner that never
 * exits.
 *
 * @returns {Promise<boolean>} True when the reads drained, false when the
 *   deadline elapsed first and the caller should proceed regardless.
 */
async function awaitReadDrain() {
  if (activeStoreReads === 0) {
    return true;
  }

  let resolveDrain;
  const drained = new Promise((resolve) => {
    resolveDrain = resolve;
  });
  readDrainWaiters.push(resolveDrain);

  let timer;
  try {
    return await Promise.race([
      drained.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), PUBLISH_DRAIN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    const queued = readDrainWaiters.indexOf(resolveDrain);
    if (queued !== -1) {
      readDrainWaiters.splice(queued, 1);
    }
  }
}

/**
 * Closes the store to new reads for the duration of a publish.
 *
 * @returns {void}
 */
function openPublishWindow() {
  publishBarrier = new Promise((resolve) => {
    releasePublishBarrier = resolve;
  });
}

/**
 * Re-opens the store to reads, whether the publish succeeded or was refused.
 *
 * Called from a `finally`: a refusal that left the barrier standing would
 * block every subsequent read for the life of the process, turning one failed
 * write into a dead read path.
 *
 * @returns {void}
 */
function closePublishWindow() {
  const release = releasePublishBarrier;
  publishBarrier = null;
  releasePublishBarrier = null;
  if (release !== null) {
    release();
  }
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
 * Decodes one chunk of the store's bytes, or flushes the decoder.
 *
 * Both jobs belong to one function because both refuse identically: whichever
 * of the two finds the bytes undecodable reports the same unreadable store,
 * and a caller that had to distinguish them would be reporting the position of
 * a fault rather than the fault.
 *
 * @param {TextDecoder} decoder The streaming decoder, stateful across calls.
 * @param {Uint8Array|undefined} bytes The chunk to decode, or `undefined` to
 *   flush — which is what refuses an incomplete sequence at end of file.
 * @returns {string} The text the chunk decoded to, which may be empty when a
 *   multi-byte sequence straddles the boundary and is carried to the next call.
 * @throws {Error} E_STORE_UNREADABLE when the bytes are not valid UTF-8.
 */
function decodeStoreBytes(decoder, bytes) {
  try {
    return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true });
  } catch (cause) {
    throw refuse(CODE_STORE_UNREADABLE, 'the activity store is not valid UTF-8', {
      reason: 'store_not_utf8',
      cause,
    });
  }
}

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
 * than silently littered with replacement characters. It happens one chunk at
 * a time, as the bytes arrive, so no request ever holds the shared event loop
 * for the length of a whole document's decode. A single leading byte order
 * mark is tolerated and dropped: this module never writes one, but a Windows
 * editor readily adds one to a hand-edited file, and refusing that outright
 * would be unhelpful without protecting any invariant.
 *
 * The descriptor is closed on every path. A failure to close cannot mask the
 * outcome: it is swallowed after a refusal, because the refusal is the useful
 * report, and only the close of an otherwise successful read can surface.
 * Nothing on this path writes, truncates, renames or repairs anything.
 *
 * This is the descriptor-holding half, and it runs INSIDE the read window
 * established by `readStoreText` — it must not be called directly, because a
 * descriptor opened outside that window is exactly what makes a concurrent
 * publish fail with EPERM.
 *
 * @returns {Promise<string|null>} The document text, or null when the store
 *   does not exist.
 * @throws {Error} E_STORE_UNREADABLE when the file exists but is not a regular
 *   file, exceeds the size ceiling, or cannot be read or decoded.
 */
async function readStoreTextThroughDescriptor() {
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

  let text;
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
     * any shared file position.
     *
     * EACH CHUNK IS DECODED AS IT ARRIVES rather than collected and decoded at
     * the end, and the difference is measurable on the shared event loop. The
     * previous form held every byte, concatenated them into one buffer and
     * then decoded all of it in a single uninterrupted run — 0.32 ms of
     * decoding for a 831 KB document, on top of the two buffers' worth of
     * peak allocation per concurrent read. Decoding 64 KiB at a time costs
     * 0.004 ms per chunk and rides on the `await` that was already there for
     * the read itself, so nothing else waits behind it, the byte collection
     * and the concatenation are gone, and only one copy of the document is
     * ever held. The decoder is stateful across calls with `stream: true`, so
     * a multi-byte sequence straddling a chunk boundary is decoded correctly
     * and an incomplete one at the end of the file is caught by the flush
     * below. */
    const chunk = Buffer.allocUnsafe(STORE_READ_CHUNK_BYTES);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let decoded = '';
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
      total += result.bytesRead;
      /* The SIZE refusal outranks the ENCODING refusal, so the chunk that
       * carried the document past the ceiling is never decoded: an oversized
       * file must be reported as oversized whatever its bytes happen to say,
       * exactly as it was when the whole buffer was decoded after the loop. */
      if (total > MAX_STORE_BYTES) {
        break;
      }
      decoded += decodeStoreBytes(decoder, chunk.subarray(0, result.bytesRead));
    }

    if (total > MAX_STORE_BYTES) {
      throw refuse(
        CODE_STORE_UNREADABLE,
        `the activity store delivered more than the ${MAX_STORE_BYTES}-byte ceiling this build reads; it is left exactly as found`,
        { reason: 'store_grew_past_ceiling' }
      );
    }

    /* The flush, which is what refuses a file whose last bytes are an
     * incomplete UTF-8 sequence. Without it a truncated final character would
     * be dropped silently and the document would parse as though the missing
     * character had never been there. */
    text = decoded + decodeStoreBytes(decoder, undefined);
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

  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Reads the store's bytes within the read window, so a descriptor on the
 * store is never open across a concurrent publish.
 *
 * This wrapper is the whole of the read path's part in the coordination
 * described under "The publish window" above, and it is deliberately the only
 * part: the descriptor work, the ceilings and the decoding are unchanged, and
 * a read still never queues on the write mutex. What it adds is that a read
 * about to open the store waits for a rename already in flight, and that a
 * rename about to run waits for this read — for the duration of that one
 * syscall and nothing more.
 *
 * `leaveReadWindow` is in a `finally`, so a refusal still retires the read. A
 * leaked count would make every later publish wait out its drain deadline
 * before renaming, which would look like a slow store rather than a bug.
 *
 * @returns {Promise<string|null>} The document text, or null when the store
 *   does not exist.
 * @throws {Error} E_STORE_UNREADABLE, exactly as the descriptor half raises it.
 */
async function readStoreText() {
  await enterReadWindow();
  try {
    return await readStoreTextThroughDescriptor();
  } finally {
    leaveReadWindow();
  }
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
 * Hands the event loop back for one turn.
 *
 * `setImmediate` and NOT a resolved promise: a microtask runs before the loop
 * ever reaches its poll phase, so awaiting one would let this function claim
 * to yield while no pending socket, timer or file callback could run — the
 * stall would be identical and the code would look as though it had been
 * fixed. A check-phase callback is the cheapest yield that genuinely lets
 * everything else proceed.
 *
 * @returns {Promise<void>} Resolves on the next turn of the event loop.
 */
function yieldToEventLoop() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Parses and fully validates a store document.
 *
 * Every record is validated on every load, which is what the store being a
 * hand-editable file requires. What is bounded is how much of that validation
 * runs at once: the loop hands the event loop back whenever its current
 * uninterrupted run has exceeded `VALIDATION_RUN_BUDGET_NS`, so a large
 * document costs its own request the same total work while costing every other
 * request in flight nothing but a few loop turns. The budget is measured from
 * the top of this function, so the run it bounds INCLUDES the atomic
 * `JSON.parse` below — which is the single longest thing that happens here and
 * would otherwise be the front of a run that then kept going.
 *
 * Refusals are unaffected — a yield is not a checkpoint, and the first
 * violation in document order is still the one reported, because the loop
 * still visits the records in order and still stops at the first one that
 * fails.
 *
 * @param {string} text The document text.
 * @param {Set<string>} keySet The authoritative key set.
 * @returns {Promise<{schemaVersion: number, activities: Array<Object>}>} The
 *   validated document, with every record in canonical form.
 * @throws {Error} E_STORE_UNREADABLE for any violation.
 */
async function parseStoreDocument(text, keySet) {
  /* Started before the parse, not after it, so the first budget covers the
   * runtime's own longest call rather than beginning once it has returned. */
  let runStarted = process.hrtime.bigint();

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
    /* The yield point. At the TOP of the iteration and never for index 0, so
     * the yield falls between two records rather than between a record and the
     * work that follows the loop, and so a document short enough to finish
     * inside one budget never yields — nor even reads the clock. */
    if (
      index > 0 &&
      index % VALIDATION_CLOCK_INTERVAL_RECORDS === 0 &&
      process.hrtime.bigint() - runStarted > VALIDATION_RUN_BUDGET_NS
    ) {
      await yieldToEventLoop();
      runStarted = process.hrtime.bigint();
    }

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
 * On Windows this mode is NOT the access control and cannot be made into it:
 * the platform derives only the read-only attribute from a mode, `fs.stat`
 * reports `0666` there whatever the file's real permissions are, and a created
 * file otherwise takes the INHERITABLE ACEs of the directory it was created
 * in. The narrowing on that platform is therefore a separate step —
 * `restrictStagedFileToItsOwner` below — and the mode is still passed because
 * it costs nothing and is the whole control wherever it means anything.
 */
const STAGING_FILE_MODE = 0o600;

/**
 * Whether this platform's file MODE is its access control.
 *
 * `process.getuid` exists exactly where POSIX ownership and mode semantics do,
 * so asking for it asks the question that actually matters rather than naming
 * platforms — a list that would have to be kept in step with every platform
 * that grows or loses those semantics. Where this holds, the staging file is
 * `chmod`ed through its descriptor and that is the end of it; where it does not,
 * the mode restricts nothing and something else has to.
 */
const PLATFORM_HONOURS_FILE_MODE = typeof process.getuid === 'function';

/**
 * Whether this platform expresses access control as an ACL that a created file
 * INHERITS from its directory — which is precisely what makes the mode above
 * insufficient and a narrowing step necessary.
 *
 * A platform test rather than a capability test, deliberately, because there is
 * no capability to probe: nothing in the runtime reports "my permissions are
 * ACLs", and the tool that sets one is named per platform anyway.
 */
const PLATFORM_RESTRICTS_BY_ACL = process.platform === 'win32';

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

/* ------------------------------------------------------------------------- *
 * Narrowing the staged file where the mode cannot
 *
 * WHY THIS EXISTS AT ALL. `STAGING_FILE_MODE` is the whole control on POSIX
 * and no control whatsoever on Windows. MEASURED on this project's Windows
 * runtime, in a directory carrying the ordinary inherited defaults: a staging
 * file created with exactly the flags and mode above lands with
 * `NT AUTHORITY\Authenticated Users:(I)(M)` and `BUILTIN\Users:(I)(M)`, and
 * the rename then publishes that ACL onto the store. Every local principal
 * could therefore READ submitted student data and — the worse half — REWRITE
 * it, which is an integrity path into the service's own responses: the loader
 * accepts any document that passes its shape checks, so forged records are
 * served back, and a deliberately invalid one forces `E_STORE_UNREADABLE` on
 * every read. Naming a private directory as the operator's responsibility did
 * not prevent any of that in the DEFAULT configuration, so the narrowing is
 * done here rather than assumed of whoever set `ACTIVITY_STORE`.
 *
 * WHY A TOOL. The runtime has no ACL API: `fs.chmod` toggles the read-only
 * attribute on that platform and nothing else, and no flag to `fs.open` can
 * supply a security descriptor. The platform's own `icacls` is the only
 * mechanism available without a native addon, which the zero-dependency
 * posture rules out.
 *
 * WHAT IT CANNOT DO, STATED RATHER THAN GLOSSED. The tool addresses a file by
 * PATH, and no by-descriptor equivalent exists, so there is a window between
 * this module creating the file and the tool opening it. The staging file is
 * created EXCLUSIVELY, and its identity is compared against the descriptor's
 * immediately before and immediately after the tool runs, so a name swapped
 * underneath it refuses the write instead of publishing a document whose
 * permissions were applied to something else. The residual window is the
 * tool's own open, it requires a store directory in which another principal
 * may delete files — exactly the arrangement the operator documentation
 * forbids — and it is why that documentation still asks for a private
 * directory even though the service no longer depends on getting one.
 * ------------------------------------------------------------------------- */

/**
 * The platform's access-control tool, by ABSOLUTE path, or `null` where the
 * platform needs none or does not have it.
 *
 * ABSOLUTE, and that is the security-relevant part. A bare `icacls` would be
 * resolved by searching the current directory and then `PATH`, so a file of
 * that name dropped beside the service would be executed in its place — a
 * privileged-path defect introduced while fixing a permissions one. The
 * location comes from the platform's own published system root, with the
 * conventional path as a fallback, and is confirmed to exist at load so a
 * missing tool is known before a submission depends on it.
 *
 * This is the one environment value the feature reads besides `ACTIVITY_STORE`,
 * and it is deliberately NOT configuration: it names where the operating system
 * keeps its own files, it cannot change what the service does, and pointing it
 * anywhere that does not hold the tool makes writes REFUSE rather than fall
 * back to something weaker.
 */
const ACL_TOOL_PATH = (() => {
  if (!PLATFORM_RESTRICTS_BY_ACL) {
    return null;
  }
  const systemRoot =
    typeof process.env.SystemRoot === 'string' && process.env.SystemRoot !== ''
      ? process.env.SystemRoot
      : 'C:\\Windows';
  const candidate = path.join(systemRoot, 'System32', 'icacls.exe');
  return fsSync.existsSync(candidate) ? candidate : null;
})();

/**
 * The single access right the staged file is left carrying: full control for
 * whoever OWNS it, and nothing for anybody else.
 *
 * `S-1-3-4` is the well-known OWNER RIGHTS identifier, and a literal SID is
 * used rather than an account name for two reasons. It needs no lookup, so the
 * write path cannot fail because a name did not resolve in a container, under a
 * virtual account or on a host that has lost its domain; and it is not
 * localized, so the grant reads the same on every installation. The owner of a
 * file this module creates always comes from this process's own token, so this
 * grant can never lock the service out of the store it just wrote.
 *
 * Paired with `/inheritance:r`, which REMOVES the ACEs the file inherited from
 * its directory — the grant alone would leave those in place, and they are the
 * whole finding.
 */
const ACL_OWNER_GRANT = '*S-1-3-4:(F)';

/**
 * How long the tool is given before the write is refused.
 *
 * Bounded because this runs inside the write mutex: a tool that never returns
 * would hold up every later submission indefinitely, so it is the write that
 * fails rather than the service that stops responding. Far above the measured
 * cost of the call — about 18 ms on this host — so a slow but working host is
 * never refused.
 */
const ACL_TOOL_TIMEOUT_MS = 10_000;

/** A bound on what the tool may write back, so its output cannot grow memory. */
const ACL_TOOL_OUTPUT_LIMIT_BYTES = 64 * 1024;

/**
 * Runs the access-control tool and resolves once it has succeeded.
 *
 * `execFile` rather than `exec`: there is no shell, so the path and the grant
 * are arguments rather than text a shell re-parses, and nothing in either can
 * be read as a command. The call goes through the module object so a test can
 * substitute it — the only way to exercise the refusal below without a host
 * that genuinely cannot set an ACL.
 *
 * @param {Array<string>} args The tool's arguments.
 * @returns {Promise<void>} Resolves when the tool exited zero.
 */
function runAclTool(args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      ACL_TOOL_PATH,
      args,
      {
        windowsHide: true,
        timeout: ACL_TOOL_TIMEOUT_MS,
        maxBuffer: ACL_TOOL_OUTPUT_LIMIT_BYTES,
      },
      (fault) => {
        if (fault === null || fault === undefined) {
          resolve();
          return;
        }
        reject(fault);
      }
    );
  });
}

/**
 * Describes a tool failure in a form a message may carry.
 *
 * Deliberately narrow. The tool reports a refusal on stderr QUOTING THE FILE
 * IT WAS GIVEN, and the fault object carries the whole command line in `cmd`,
 * so neither may reach a message this module composes — every message here is
 * contracted to be free of filesystem paths. An exit status, an errno or the
 * fact that it was killed is the whole of what is useful and the whole of what
 * is safe. The fault itself still travels as the refusal's `cause`, where a
 * developer can inspect it.
 *
 * @param {unknown} fault The rejection from `runAclTool`.
 * @returns {string} For example `'ENOENT'`, `'ETIMEDOUT'` or `'exit status 5'`.
 */
function describeToolFault(fault) {
  if (fault === null || typeof fault !== 'object') {
    return 'an unidentified fault';
  }
  if (typeof fault.code === 'string') {
    return fault.code;
  }
  if (fault.killed === true) {
    return 'ETIMEDOUT';
  }
  if (typeof fault.code === 'number') {
    return `exit status ${fault.code}`;
  }
  return 'an unidentified fault';
}

/**
 * Refuses the write unless the staging PATH still names the file this module
 * holds open.
 *
 * The identity is the filesystem's own — the device and the file's serial
 * within it — read as BIGINTS because on this platform the serial EXCEEDS what
 * a double represents exactly: one measured here was 10133099161951476, well
 * past 2^53, so a plain `stat` would compare two rounded numbers and could
 * call two different files the same one.
 *
 * @param {{dev: bigint, ino: bigint}} held The descriptor's own identity.
 * @returns {Promise<void>}
 * @throws {Error} E_STORE_WRITE_FAILED when the path names something else, or
 *   when it cannot be inspected at all.
 */
async function refuseIfStagingPathMoved(held) {
  let atPath;
  try {
    atPath = await fs.stat(RESOLVED_TEMPORARY_PATH, { bigint: true });
  } catch (cause) {
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      `the activity store could not be written (${describeCause(cause)}); its staging path could not be confirmed to still name the file being written, the previous document is intact and the submission was not persisted`,
      { reason: 'staging_path_unconfirmable', cause }
    );
  }

  if (atPath.dev !== held.dev || atPath.ino !== held.ino) {
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      'the activity store could not be written (its staging path stopped naming the file being written, so another process replaced it mid-write); the previous document is intact and the submission was not persisted',
      { reason: 'staging_path_swapped' }
    );
  }
}

/**
 * Leaves the staged file readable and writable by its owner alone, on the
 * platform where the mode cannot say so.
 *
 * Called BEFORE a single byte of the document is written, so the file is never
 * a world-writable file that happens to contain student data — at the moment it
 * is widest it is also empty. The rename carries the resulting ACL onto the
 * store, which is what makes one call per write sufficient rather than a second
 * pass over the published document.
 *
 * FAILS CLOSED, on every branch. A tool that is absent, that cannot be run,
 * that times out or that exits non-zero — a filesystem with no ACL to set would
 * present as the last of these — refuses the write with the same
 * `E_STORE_WRITE_FAILED` a full disk gets, so the previous document stays intact
 * and the caller sees `500 store_write_failed` and may safely retry. What must
 * never happen is the other outcome: publishing a document this module could not
 * protect while reporting success.
 *
 * @param {import('node:fs/promises').FileHandle} handle The staging descriptor.
 * @returns {Promise<void>}
 * @throws {Error} E_STORE_WRITE_FAILED when the restriction could not be applied
 *   and proved to have been applied to this file. The caller closes and removes
 *   the staging file.
 */
async function restrictStagedFileToItsOwner(handle) {
  if (ACL_TOOL_PATH === null) {
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      "the activity store could not be written (this platform's access-control tool could not be located, so the staging file's inherited permissions could not be narrowed to its owner); the previous document is intact and the submission was not persisted",
      { reason: 'staging_acl_tool_unavailable' }
    );
  }

  let held;
  try {
    held = await handle.stat({ bigint: true });
  } catch (cause) {
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      `the activity store could not be written (${describeCause(cause)}); its staging file could not be identified before its permissions were narrowed, the previous document is intact and the submission was not persisted`,
      { reason: 'staging_uninspectable', cause }
    );
  }

  await refuseIfStagingPathMoved(held);

  try {
    await runAclTool([RESOLVED_TEMPORARY_PATH, '/inheritance:r', '/grant:r', ACL_OWNER_GRANT]);
  } catch (cause) {
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      `the activity store could not be written (${describeToolFault(cause)}); its staging file could not be restricted to its owner, the previous document is intact and the submission was not persisted`,
      { reason: 'staging_acl_not_restricted', cause }
    );
  }

  /* The same check again, and not for symmetry: the tool acted on a NAME, so
   * this is what establishes that the permissions it set belong to the file
   * about to become the store rather than to something that took the name in
   * between. */
  await refuseIfStagingPathMoved(held);
}

/**
 * Proves the opened staging descriptor is the regular file this module just
 * created, and restricts it to its owner.
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
 *   - `uid` — only where the platform has the concept, which is where
 *     `PLATFORM_HONOURS_FILE_MODE` holds. It refuses a file owned by someone
 *     else, which a freshly created file cannot be unless the directory itself
 *     is not the operator's.
 *
 * THEN THE NARROWING, one mechanism per platform, because the two platforms
 * express access control differently and neither expression works on the
 * other:
 *
 *   - Where the MODE is the control, `chmod` to `STAGING_FILE_MODE` runs
 *     through the DESCRIPTOR, not the path, so it cannot be redirected to
 *     another file between the two calls. It makes the mode exactly `0600`
 *     whatever the umask, and it also corrects the one case creation cannot: a
 *     mode is applied only to a file being created, so without this a file that
 *     somehow survived to become the store would keep a mode from elsewhere.
 *   - Where access control is an inherited ACL, `restrictStagedFileToItsOwner`
 *     replaces what the directory donated with a single grant to the file's
 *     owner. Without it the mode above restricts nothing at all on that
 *     platform and the store is published world-writable — see that function's
 *     own note for the measurement.
 *
 * Both run BEFORE any byte of the document is written, so the file is never
 * widely accessible while it holds data.
 *
 * @param {import('node:fs/promises').FileHandle} handle The staging descriptor.
 * @returns {Promise<void>}
 * @throws {Error} E_STORE_WRITE_FAILED when the descriptor fails any check, or
 *   its mode cannot be set, or its inherited permissions cannot be narrowed.
 *   The caller closes and removes the file.
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
  if (PLATFORM_HONOURS_FILE_MODE && stats.uid !== process.getuid()) {
    throw refuse(
      CODE_STORE_WRITE_FAILED,
      'the activity store could not be written (its staging file is owned by another user, so it must not be written or renamed onto the store); the previous document is intact and the submission was not persisted',
      { reason: 'staging_foreign_owner' }
    );
  }

  if (PLATFORM_HONOURS_FILE_MODE) {
    /* The mode IS the access control here, and it is set through the
     * descriptor so no second path resolution can redirect it. */
    try {
      await handle.chmod(STAGING_FILE_MODE);
    } catch (cause) {
      throw refuse(
        CODE_STORE_WRITE_FAILED,
        `the activity store could not be written (${describeCause(cause)}); its staging file could not be restricted to its owner, the previous document is intact and the submission was not persisted`,
        { reason: 'staging_mode_not_restricted', cause });
    }
  } else if (PLATFORM_RESTRICTS_BY_ACL) {
    /* The mode restricts NOTHING here — the file carries whatever its
     * directory donated — so the ACL is what has to be narrowed. */
    await restrictStagedFileToItsOwner(handle);
  }
}

/**
 * Removes the staging file this call created, best effort.
 *
 * NOT RECURSIVE, and that is deliberate. The staging file is ours by
 * construction — created exclusively by this write — but the staging PATH can
 * be occupied by something that is not ours: a directory planted there is
 * this project's portable write-fault mechanism, and `fs.rm` without
 * `recursive` refuses to remove one. So an obstruction is left exactly where
 * it was while our own file is cleared.
 *
 * Every failure is swallowed. This runs while a more important failure is
 * already on its way to the caller, and replacing that failure with "the
 * staging file could not be removed" would report the cleanup instead of the
 * fault. `force` keeps a removal that already happened from raising at all.
 *
 * @returns {Promise<void>} Always resolves.
 */
async function discardStagedDocument() {
  await fs.rm(RESOLVED_TEMPORARY_PATH, { force: true }).catch(() => {});
}

/**
 * Publishes the staged document by renaming it over the store, inside the
 * publish window and with a bounded retry.
 *
 * THE THREE PARTS, each answering something measured on this host:
 *
 *   1. THE WINDOW. `openPublishWindow` stops new reads from opening the store
 *      and `awaitReadDrain` waits for the ones in flight, because a
 *      descriptor open on the destination makes `fs.rename` fail EPERM on
 *      Windows. This is what turns a 37%-to-98.5% write failure rate under
 *      ordinary read traffic into none: the collision is removed rather than
 *      retried past. The window is closed in a `finally`, so a refusal can
 *      never leave the read path blocked.
 *   2. THE BOUNDED RETRY. A descriptor held by a process outside this one is
 *      invisible to the counter, so a collision code is retried up to
 *      `MAX_PUBLISH_ATTEMPTS` with a short backoff — the same idiom as the
 *      EEXIST retry in `openStagingFileExclusively`. Verified directly: a
 *      rename refused while the destination was held open succeeded as soon
 *      as the descriptor closed. Only a collision code is retried; anything
 *      that will fail identically every time is refused at once.
 *   3. THE CLEANUP. When the publish is finally refused, the staged file is
 *      REMOVED. Leaving it behind was permitted — a partial staging file is
 *      never read, and the next write clears it — but it left a complete
 *      document sitting at rest beside the store indefinitely whenever the
 *      last write of a busy period failed, which is resource residue with no
 *      purpose. Nothing about the previous document changes: it is intact,
 *      and the submission is simply not persisted.
 *
 * @returns {Promise<void>} Resolves once the store has been replaced.
 * @throws {Error} E_STORE_WRITE_FAILED when every attempt was refused. The
 *   previous document is intact and nothing is left staged.
 */
async function publishStagedDocument() {
  openPublishWindow();
  try {
    for (let attempt = 1; ; attempt += 1) {
      await awaitReadDrain();
      try {
        await fs.rename(RESOLVED_TEMPORARY_PATH, RESOLVED_STORE_PATH);
        return;
      } catch (cause) {
        if (
          !PUBLISH_COLLISION_CODES.has(describeCause(cause)) ||
          attempt >= MAX_PUBLISH_ATTEMPTS
        ) {
          await discardStagedDocument();
          throw refuse(
            CODE_STORE_WRITE_FAILED,
            `the activity store could not be written (${describeCause(cause)}); the previous document is intact and the submission was not persisted`,
            { reason: 'store_write_refused', cause }
          );
        }
        await delay(PUBLISH_RETRY_BACKOFF_MS * attempt);
      }
    }
  } finally {
    closePublishWindow();
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
 * degrades into a cross-filesystem copy. The rename itself runs inside the
 * publish window — see `publishStagedDocument` — because on Windows it is
 * refused outright while a reader holds the destination open.
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
 * PERMISSIONS. The staging file is restricted to its owner BEFORE any byte of
 * the document is written, by whichever mechanism the platform actually
 * honours: where the mode is the control it is created `0600` and `chmod`ed to
 * `0600` through the descriptor so the umask cannot loosen it, and where access
 * control is an inherited ACL the ACEs the directory donated are replaced with
 * a single grant to the owner. The rename then carries that onto the store,
 * which is why the store is never published wider than the staging file was.
 * A restriction that cannot be applied REFUSES the write rather than publishing
 * an unprotected document.
 *
 * On failure with the process alive, the previous document is left intact and
 * the submission is simply not persisted; retrying is safe, because a
 * submission is idempotent by composite key. NO FAILURE PATH LEAVES A STAGING
 * FILE AT REST: a write that never completed removes it, a descriptor that
 * could not be closed removes it, and a publish refused after every attempt
 * removes it. So the only staging file that can exist is one belonging to a
 * write in flight, or one left by a process that died — and that one is still
 * never read, only cleared and recreated by the next write. Durability beyond
 * the rename is not attempted: there is no fsync here, matching the specified
 * mechanics for a loopback-only service whose store is a runtime artifact.
 *
 * @param {{schemaVersion: number, activities: Array<Object>}} document The
 *   document to persist.
 * @returns {Promise<void>}
 * @throws {Error} E_STORE_AT_CAPACITY when the document would serialize past
 *   the byte ceiling — a refusal to grow the store rather than a fault, so it
 *   carries its own code — and E_STORE_WRITE_FAILED when the staging file
 *   cannot be created privately or fails verification, or when the write or
 *   the rename fails.
 */
async function writeDocument(document) {
  /* Hand the event loop back BEFORE serializing. `JSON.stringify` of a
   * document at the byte ceiling is a single 1.9 ms call into the runtime and
   * cannot be broken up, so the least it can be made to cost everything else
   * is to be a run of its OWN: without this yield it continues whatever run
   * the caller's validation loop was in the middle of, and the two add up.
   * MEASURED at 4900 records: the longest run a submission imposed fell from
   * 3.7 ms to about the serialization alone. One loop turn per submission is
   * the entire price, and a submission is already several file operations long.
   */
  await yieldToEventLoop();

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
      CODE_STORE_AT_CAPACITY,
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
       * it cannot remove anyone else's file. */
      await discardStagedDocument();
    } else if (closeFault !== undefined) {
      /* The bytes reached the disk but the descriptor did not close, so the
       * rename is not attempted and this staged file will never be adopted.
       * It is removed for the same reason a refused publish removes its own:
       * nothing reads it, and leaving it would park a complete document at
       * rest beside the store. The removal is best effort — an unclosed
       * descriptor may itself prevent it — and the refusal below is reported
       * either way. */
      await discardStagedDocument();
      throw refuse(
        CODE_STORE_WRITE_FAILED,
        `the activity store could not be written (${describeCause(closeFault)}); its staging file was written but the descriptor could not be closed, the previous document is intact and the submission was not persisted`,
        { reason: 'staging_close_failed', cause: closeFault });
    }
  }

  await publishStagedDocument();
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
 * A read is held off for the RENAME itself, and only for that, by the publish
 * window above — because this platform refuses a rename whose destination a
 * reader holds open, so the publication the paragraph above relies on would
 * otherwise not happen at all. That window is a different mechanism from this
 * chain and is deliberately far narrower: one syscall, not a critical
 * section.
 *
 * The module-level promise chain below IS the write queue: each critical
 * section runs behind the one queued before it, which is sufficient
 * coordination for one single-threaded process. What deliberately does not
 * exist is anything beyond it and the one-syscall publish window — no general
 * reader/writer lock, no separate queue for reads, no cross-process or file
 * lock, and no cache of the store. Ordering
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
 * The capacity warning
 *
 * The one thing this module writes to a stream rather than returning or
 * throwing, and it is here because this is the only place the record count is
 * known. `activities.js` maps refusals onto statuses and writes the failure
 * evidence for them, but it never sees how full the store is: `addActivity`
 * answers a submission that succeeded with nothing but the record, and adding
 * the count to that answer would put an operational measure into the response
 * contract to avoid putting one line into a log.
 *
 * LATCHED, so it cannot flood. One line when the document first crosses the
 * warning band, and then silence — a warning repeated on every one of the last
 * five hundred submissions would be five hundred lines saying what the first
 * already said, and it would be the noisiest exactly when an operator is
 * trying to read the log. The latch is re-armed when the count falls back
 * below the band, so a store that is pruned and fills again warns again.
 *
 * The line carries two numbers and no submitted data: what the store holds and
 * what it will hold at most. Neither is derived from a request, so nothing a
 * submitter sent can reach the log through it — the same rule the failure
 * evidence in `activities.js` is built on.
 * ------------------------------------------------------------------------- */

/** @type {boolean} Whether the warning has already been written for this band. */
let capacityWarningIssued = false;

/**
 * Warns once when the store crosses into the last tenth of its record ceiling.
 *
 * @param {number} records How many records the document now holds.
 * @returns {void}
 */
function reportCapacityHeadroom(records) {
  if (records < CAPACITY_WARNING_RECORDS) {
    capacityWarningIssued = false;
    return;
  }
  if (capacityWarningIssued) {
    return;
  }
  capacityWarningIssued = true;
  console.warn(
    `activity-store: ${JSON.stringify({
      event: 'store_capacity_warning',
      records,
      ceiling: MAX_ACTIVITY_RECORDS,
    })}`
  );
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
 * Canonical, case-insensitive deduplication is the mitigation for
 * near-duplicates instead: the label is put into Unicode NFC with the
 * invisible formatting characters removed, so a precomposed `é` and an `e`
 * followed by a combining acute are one activity rather than two records that
 * render identically.
 *
 * @param {unknown} raw The submitted label, for example `'  Chess   Club  '`.
 * @returns {string} The normalized label, for example `'Chess Club'`, in
 *   canonical form and with the submitted casing preserved.
 * @throws {Error} E_LABEL_INVALID when the label is not a string, is empty
 *   once canonicalized and trimmed, carries a control character or a line
 *   separator, or falls outside the 1-to-60-character bound — counted in
 *   UTF-16 code units, as the intake form's `maxlength` is — once normalized.
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
 * @throws {Error} E_LABEL_INVALID, E_REFERENCE_DATA, E_STORE_UNREADABLE,
 *   E_STORE_AT_CAPACITY or E_STORE_WRITE_FAILED.
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
     * rather than destructive, and the failure says WHICH of the two it is —
     * `E_STORE_AT_CAPACITY`, the store cannot grow, and not the environmental
     * `E_STORE_WRITE_FAILED` that a retry might well clear.
     *
     * Placed AFTER the lookup above deliberately. An idempotent repeat of a
     * record that is already present appends nothing, so it must still
     * succeed at capacity; only a genuinely new record is refused. Reads are
     * untouched — `listActivities` never reaches this code — so a store at
     * capacity keeps answering every question it could answer before. */
    if (document.activities.length >= MAX_ACTIVITY_RECORDS) {
      throw refuse(
        CODE_STORE_AT_CAPACITY,
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
    /* AFTER the write, never before it: the warning reports what the store
     * now holds, and a refused write changed nothing to report. */
    reportCapacityHeadroom(document.activities.length);

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
 * validation, stringification, staging writes and renames. The one thing a
 * read does wait for is a rename already in flight, for the duration of that
 * syscall: see "The publish window" above for why the platform requires it
 * and what it costs.
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
