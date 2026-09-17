'use strict';

/**
 * verify-tests.js - the guard that stands between `npm test` and a vacuous pass.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `node --test` with **no test files discovered** prints a zero-count summary
 * and **exits 0** - reproduced on this checkout - and that survives the script
 * layer, so `npm test` would "pass" on an empty or partially discovered suite.
 * A suite that silently stops running is worse than no suite at all, because
 * the green exit status is read as evidence. The same is true of the
 * programmatic runner used below: `run()` never sets an exit code, so a run
 * with one failing test, a nonexistent file or no files at all still leaves the
 * process exiting 0 - all three reproduced here before this file was written.
 *
 * It is wired as `scripts.test`, so the guard cannot be bypassed by using the
 * conventional command. `npm run test:raw` remains the unguarded runner for
 * reading per-test output while developing, and it is deliberately not the gate.
 *
 * It lives at the repository **root**, not under `test/`: every `.js` file
 * inside a directory named `test/` is executed as a test by the runner's
 * default discovery - verified, a plain `test/helper.js` ran and was counted as
 * a passing test - so a guard placed there would become one of the tests it
 * exists to count.
 *
 * WHAT IT GUARANTEES
 * ---------------------------------------------------------------------------
 *   1. The host runtime satisfies `engines.node` from `package.json`, checked
 *      **before a single test runs**. This is the only place the runtime
 *      contract is enforced rather than merely declared: `engines` only warns
 *      (no `.npmrc` sets `engine-strict`, and none is added) and `.nvmrc` is
 *      inert without a version manager.
 *   2. Every declared test file exists, named individually when one does not.
 *   3. The suite runs **once**, at concurrency 1. That is required rather than
 *      cosmetic: `test/server.test.js` binds the fixed `127.0.0.1:3000`, and at
 *      default concurrency a second simultaneous bind fails with `EADDRINUSE`
 *      surfacing as *cancelled* tests whose message names neither the port nor
 *      the conflict.
 *   4. Exit 0 **only** when all three conditions hold - `passed >= MIN_TESTS`,
 *      `failed === 0` and `cancelled === 0`. All three are genuinely required:
 *      an empty run produces a zero exit, and a run has been observed
 *      reporting zero failures alongside a failing status because tests were
 *      cancelled rather than failed.
 *   5. A missing `test:summary` event is a failure, not a pass - it means the
 *      suite did not execute as intended.
 *
 * Only `test()` declarations count toward `counts.passed`; assertions made
 * inside a `before`/`after` hook do not. Nothing here compensates for that -
 * the suite is written so every guarded behaviour is a declared test.
 *
 * CONVENTIONS
 * ---------------------------------------------------------------------------
 * The conventions the repository scan established in `server.js`: CommonJS
 * `require`/`module.exports` with no ESM anywhere, two-space indentation,
 * single quotes, `const`, arrow callbacks, semicolons, errors carrying a `code`,
 * `process.exitCode` rather than `process.exit`, and **zero dependencies** -
 * `node:test` is built in, and the `engines.node` range is parsed here rather
 * than by adding `semver`.
 *
 * @example <caption>The authoritative suite command and the liveness proof</caption>
 * // npm test               -> exit 0 when 45 tests pass, 0 fail, 0 cancel
 * // MIN_TESTS=46 npm test  -> exit 1, naming 45 against 46: the guard is live
 */

const { run } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

/* ---------------------------------------------------------------------------
 * Constants.
 * ------------------------------------------------------------------------- */

/** Exit status of a run that satisfied every condition. */
const EXIT_SUCCESS = 0;

/** Exit status of any other run. There is no third outcome. */
const EXIT_FAILURE = 1;

/** The manifest this guard reads `engines.node` from, beside this file. */
const MANIFEST_PATH = path.join(__dirname, 'package.json');

/**
 * The suite, named explicitly and in this order. Explicit rather than
 * discovered for two verified reasons: passing a **directory** to the runner
 * fails, and every `.js` file under `test/` is otherwise executed as a test, so
 * a helper or a stray file would silently join the suite and inflate the very
 * count this file checks.
 *
 * Each path is resolved against `__dirname`, so the guard behaves identically
 * however it is invoked - `npm test`, `node verify-tests.js`, or an absolute
 * path from an unrelated working directory.
 */
const TEST_FILES = [
  'test/activities.test.js',
  'test/server.test.js',
  'test/workbooks.test.js',
].map((relativePath) => path.join(__dirname, relativePath));

/**
 * 45 - the number of declared tests, 33 + 8 + 4 across the three files above.
 * It is a fixed floor written down on purpose: deriving it from the run itself
 * would make any number of executed tests "expected" and defeat the guard.
 */
const DEFAULT_MIN_TESTS = 45;

/** Overrides `DEFAULT_MIN_TESTS`, for subsetting the suite while developing. */
const MIN_TESTS_ENVIRONMENT_KEY = 'MIN_TESTS';

/** See guarantee 3 above: this is a correctness requirement, not a preference. */
const TEST_CONCURRENCY = 1;

/** How many failing tests are echoed before the list is truncated. */
const FAILURE_DETAIL_LIMIT = 20;

/** Characters of an assertion message echoed per failing test. */
const MESSAGE_EXCERPT_LIMIT = 200;

/** Characters of an offending configuration value echoed in a diagnostic. */
const VALUE_EXCERPT_LIMIT = 64;

/** Every line this file writes carries this prefix, on stdout and on stderr. */
const LOG_PREFIX = 'verify-tests.js';

const ERROR_CODE_MANIFEST = 'ERR_VERIFY_TESTS_MANIFEST';
const ERROR_CODE_ENGINE = 'ERR_VERIFY_TESTS_ENGINE';
const ERROR_CODE_CONFIG = 'ERR_VERIFY_TESTS_CONFIG';
const ERROR_CODE_MISSING_FILE = 'ERR_VERIFY_TESTS_MISSING_FILE';
const ERROR_CODE_RUNNER = 'ERR_VERIFY_TESTS_RUNNER';

/* ---------------------------------------------------------------------------
 * Diagnostics.
 * ------------------------------------------------------------------------- */

/**
 * Builds a guard failure, following the repository's error convention: a plain
 * `Error` whose message is prefixed with its origin and which carries a `code`
 * for programmatic discrimination. No ES class is introduced, because none is
 * used anywhere else in this codebase.
 *
 * @param {string} summary What went wrong, as one sentence.
 * @param {string} code One of the `ERROR_CODE_*` constants.
 * @param {unknown} [cause] The underlying error, when there is one.
 * @returns {Error} The failure, ready to throw.
 */
const guardError = (summary, code, cause) => {
  const message = `${LOG_PREFIX}: ${summary}`;
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
};

/**
 * Renders an untrusted value for a diagnostic: whitespace collapsed so a
 * multi-line value cannot break the one-line-per-problem output, length bounded
 * so a large value cannot flood it, and the empty string made visible rather
 * than printed as nothing.
 *
 * @param {unknown} value The value at fault.
 * @param {number} [limit] Characters to keep.
 * @returns {string} A single-line, bounded, non-empty rendering.
 */
const renderValue = (value, limit = VALUE_EXCERPT_LIMIT) => {
  const text = typeof value === 'string' ? value : String(value);
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed === '') {
    return '(empty)';
  }
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
};

/**
 * @param {string} absolutePath A path inside the checkout.
 * @returns {string} It, relative to this file and with forward slashes, so
 *   output reads the same on Windows and on POSIX.
 */
const displayPath = (absolutePath) => {
  const relativePath = path.relative(__dirname, absolutePath);
  if (relativePath === '' || relativePath.startsWith('..')) {
    return absolutePath;
  }
  return relativePath.split(path.sep).join('/');
};

/** @param {string} line Written verbatim to stdout with a trailing newline. */
const writeOut = (line) => {
  process.stdout.write(`${line}\n`);
};

/** @param {string} line Written verbatim to stderr with a trailing newline. */
const writeErr = (line) => {
  process.stderr.write(`${line}\n`);
};

/* ---------------------------------------------------------------------------
 * The `engines.node` range check - no dependency, hand-parsed.
 * ------------------------------------------------------------------------- */

/** A numeric segment, or a wildcard standing for "unspecified". */
const VERSION_SEGMENT_PATTERN = /^(?:0|[1-9]\d*|[xX*])$/;

/** An optional operator followed by a version token, e.g. `>=24.0.0`. */
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/;

/**
 * Parses a version token into a possibly partial triple.
 *
 * A leading `v` is accepted, because `process.version` carries one. A
 * prerelease or build suffix is **ignored** rather than rejected: the guard
 * compares release triples, so `v25.0.0-nightly` is treated as `25.0.0` and
 * correctly falls outside `<25`.
 *
 * @param {unknown} raw The token, e.g. `24.21.0`, `v24.21.0`, `24.x` or `24`.
 * @returns {{major: number, minor: (number|null), patch: (number|null)}|null}
 *   The triple with unspecified segments as `null`, or `null` when the token is
 *   not a version this guard can read. An all-wildcard token yields a `null`
 *   `major`, which callers treat as "any version".
 */
const parseVersionSpec = (raw) => {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim().replace(/^[vV]/, '');
  if (trimmed === '') {
    return null;
  }
  const core = trimmed.split(/[-+]/)[0];
  const segments = core.split('.');
  if (segments.length < 1 || segments.length > 3) {
    return null;
  }
  const parsed = [];
  for (const segment of segments) {
    if (!VERSION_SEGMENT_PATTERN.test(segment)) {
      return null;
    }
    // A wildcard, and every segment after one, is unspecified: `24.x.7` is
    // `24.x`, exactly as semver reads it.
    const wildcard = /^[xX*]$/.test(segment) || parsed.includes(null);
    parsed.push(wildcard ? null : Number.parseInt(segment, 10));
  }
  return {
    major: parsed.length > 0 ? parsed[0] : null,
    minor: parsed.length > 1 ? parsed[1] : null,
    patch: parsed.length > 2 ? parsed[2] : null,
  };
};

/**
 * @param {{major: number, minor: (number|null), patch: (number|null)}} spec
 * @returns {{major: number, minor: number, patch: number}} The spec with
 *   unspecified segments zero-filled, which is how semver reads a bound such as
 *   `<25` (`<25.0.0`) or `>=24` (`>=24.0.0`).
 */
const toConcrete = (spec) => ({
  major: spec.major === null ? 0 : spec.major,
  minor: spec.minor === null ? 0 : spec.minor,
  patch: spec.patch === null ? 0 : spec.patch,
});

/**
 * The next version above a partial spec - the exclusive upper bound implied by
 * its least specified segment. `24` yields `25.0.0`; `24.1` yields `24.2.0`;
 * `24.1.2` yields `24.1.3`.
 *
 * @param {{major: number, minor: (number|null), patch: (number|null)}} spec
 * @returns {{major: number, minor: number, patch: number}}
 */
const nextVersionAbove = (spec) => {
  if (spec.minor === null) {
    return { major: spec.major + 1, minor: 0, patch: 0 };
  }
  if (spec.patch === null) {
    return { major: spec.major, minor: spec.minor + 1, patch: 0 };
  }
  return { major: spec.major, minor: spec.minor, patch: spec.patch + 1 };
};

/**
 * The exclusive upper bound of a caret range, following semver's rules for a
 * zero major: `^24.1.2` allows `<25.0.0`, `^0.3.1` allows `<0.4.0`, `^0.0.3`
 * allows `<0.0.4`.
 *
 * @param {{major: number, minor: (number|null), patch: (number|null)}} spec
 * @returns {{major: number, minor: number, patch: number}}
 */
const caretUpperBound = (spec) => {
  if (spec.major > 0 || spec.minor === null) {
    return { major: spec.major + 1, minor: 0, patch: 0 };
  }
  if (spec.minor > 0 || spec.patch === null) {
    return { major: 0, minor: spec.minor + 1, patch: 0 };
  }
  return { major: 0, minor: 0, patch: spec.patch + 1 };
};

/**
 * Compares two concrete triples.
 *
 * @param {{major: number, minor: number, patch: number}} left
 * @param {{major: number, minor: number, patch: number}} right
 * @returns {number} Negative, zero or positive, as `Array#sort` expects.
 */
const compareVersions = (left, right) => {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
};

/**
 * Expands one range token into the primitive comparators it means. Every
 * supported form reduces to `>=`, `>`, `<=` or `<` against a concrete triple,
 * which is all the comparison below needs.
 *
 * Supported: `*`, `x`, a bare or `=`-prefixed version (exact when complete, a
 * range when partial), `>=`, `>`, `<=`, `<`, `^` and `~`. Anything else returns
 * `null` so the caller can **fail closed** - a guard that cannot read the
 * declared range must not report a pass.
 *
 * @param {string} token One whitespace-delimited token of a range.
 * @returns {Array<{operator: string, version: {major: number, minor: number, patch: number}}>|null}
 *   The comparators, an empty array for "any version", or `null` when the token
 *   is unsupported.
 */
const expandComparator = (token) => {
  const match = COMPARATOR_PATTERN.exec(token.trim());
  if (match === null) {
    return null;
  }
  const operator = match[1] === undefined ? '=' : match[1];
  const spec = parseVersionSpec(match[2]);
  if (spec === null) {
    return null;
  }
  if (spec.major === null) {
    // `*`, `x` and `x.y.z` place no bound at all.
    return [];
  }
  const concrete = toConcrete(spec);
  switch (operator) {
    case '>=':
      return [{ operator: '>=', version: concrete }];
    case '>':
      // `>24` means "above everything 24.x", i.e. `>=25.0.0`; `>24.21.0` is
      // the plain comparison.
      return spec.patch === null
        ? [{ operator: '>=', version: nextVersionAbove(spec) }]
        : [{ operator: '>', version: concrete }];
    case '<':
      return [{ operator: '<', version: concrete }];
    case '<=':
      return spec.patch === null
        ? [{ operator: '<', version: nextVersionAbove(spec) }]
        : [{ operator: '<=', version: concrete }];
    case '^':
      return [
        { operator: '>=', version: concrete },
        { operator: '<', version: caretUpperBound(spec) },
      ];
    case '~':
      return [
        { operator: '>=', version: concrete },
        {
          operator: '<',
          version: spec.minor === null
            ? { major: spec.major + 1, minor: 0, patch: 0 }
            : { major: spec.major, minor: spec.minor + 1, patch: 0 },
        },
      ];
    case '=':
      return spec.patch === null
        ? [
          { operator: '>=', version: concrete },
          { operator: '<', version: nextVersionAbove(spec) },
        ]
        : [
          { operator: '>=', version: concrete },
          { operator: '<=', version: concrete },
        ];
    default:
      return null;
  }
};

/**
 * Parses a whole range into alternatives, each alternative being comparators
 * that must all hold. `>=24.0.0 <25` yields one alternative of two comparators;
 * `18.x || >=20` yields two alternatives.
 *
 * Hyphen ranges (`1.2.3 - 2.3.4`) are **not** supported and yield `null`, which
 * fails the check loudly instead of quietly mis-reading the contract.
 *
 * @param {unknown} raw The `engines.node` value.
 * @returns {Array<Array<{operator: string, version: {major: number, minor: number, patch: number}}>>|null}
 *   The alternatives, or `null` when the range is unsupported.
 */
const parseRange = (raw) => {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const alternatives = [];
  for (const group of trimmed.split('||')) {
    const tokens = group.trim().split(/[\s,]+/).filter((token) => token !== '');
    if (tokens.length === 0 || tokens.includes('-')) {
      return null;
    }
    const comparators = [];
    for (const token of tokens) {
      const expanded = expandComparator(token);
      if (expanded === null) {
        return null;
      }
      comparators.push(...expanded);
    }
    alternatives.push(comparators);
  }
  return alternatives;
};

/**
 * @param {{major: number, minor: number, patch: number}} version
 * @param {Array<{operator: string, version: {major: number, minor: number, patch: number}}>} comparators
 * @returns {boolean} Whether every comparator holds. An empty list holds.
 */
const satisfiesComparators = (version, comparators) => comparators.every((comparator) => {
  const order = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case '>=':
      return order >= 0;
    case '>':
      return order > 0;
    case '<=':
      return order <= 0;
    case '<':
      return order < 0;
    default:
      return false;
  }
});

/**
 * Decides whether a runtime version falls inside a declared range.
 *
 * @param {string} versionText A version, with or without a leading `v`.
 * @param {string} rangeText The range, as declared in `engines.node`.
 * @returns {boolean} Whether the version satisfies the range.
 * @throws {Error} When either side cannot be parsed. Failing closed is
 *   deliberate: an unreadable contract is not a satisfied contract.
 */
const satisfiesRange = (versionText, rangeText) => {
  const spec = parseVersionSpec(versionText);
  if (spec === null || spec.major === null) {
    throw guardError(
      `the runtime version could not be parsed: ${renderValue(versionText)}`,
      ERROR_CODE_ENGINE,
    );
  }
  const alternatives = parseRange(rangeText);
  if (alternatives === null) {
    throw guardError(
      `the declared engines.node range is not one this guard can parse, so the runtime contract cannot be checked: ${renderValue(rangeText)}`,
      ERROR_CODE_ENGINE,
    );
  }
  const version = toConcrete(spec);
  return alternatives.some((comparators) => satisfiesComparators(version, comparators));
};

/**
 * Reads and parses `package.json` beside this file.
 *
 * @returns {Record<string, unknown>} The parsed manifest.
 * @throws {Error} When it cannot be read or is not valid JSON, with the path
 *   named - a guard cannot check a contract it cannot load.
 */
const readManifest = () => {
  let text;
  try {
    text = fs.readFileSync(MANIFEST_PATH, 'utf8');
  } catch (cause) {
    throw guardError(
      `package.json could not be read at ${MANIFEST_PATH}: ${renderValue(cause && cause.message, MESSAGE_EXCERPT_LIMIT)}`,
      ERROR_CODE_MANIFEST,
      cause,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (cause) {
    throw guardError(
      `package.json is not valid JSON at ${MANIFEST_PATH}: ${renderValue(cause && cause.message, MESSAGE_EXCERPT_LIMIT)}`,
      ERROR_CODE_MANIFEST,
      cause,
    );
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw guardError(
      `package.json does not contain a JSON object at ${MANIFEST_PATH}`,
      ERROR_CODE_MANIFEST,
    );
  }
  return manifest;
};

/**
 * Reads the declared runtime range from the manifest rather than hard-coding
 * it, so the guard and `engines.node` cannot drift apart.
 *
 * @returns {string} The trimmed `engines.node` range.
 * @throws {Error} When the field is absent or is not a non-empty string.
 */
const readEngineRange = () => {
  const manifest = readManifest();
  const engines = manifest.engines;
  const range = engines !== null && typeof engines === 'object' && !Array.isArray(engines)
    ? engines.node
    : undefined;
  if (typeof range !== 'string' || range.trim() === '') {
    throw guardError(
      `package.json declares no engines.node range at ${MANIFEST_PATH}, so the runtime contract cannot be checked`,
      ERROR_CODE_ENGINE,
    );
  }
  return range.trim();
};

/**
 * The runtime-contract check, and the first thing the guard does. It runs
 * before any test because a pass reported from an unsupported runtime is not
 * evidence of anything: the suite would be exercising APIs and behaviour the
 * project does not claim to support.
 *
 * @param {string} [version] The runtime to check, `process.version` by default.
 * @returns {{version: string, range: string}} The version checked and the range
 *   it satisfied.
 * @throws {Error} When the runtime is outside the range, naming both the
 *   detected version and the requirement, or when either cannot be parsed.
 */
const assertRuntimeSupported = (version = process.version) => {
  const range = readEngineRange();
  if (!satisfiesRange(version, range)) {
    throw guardError(
      `Node ${renderValue(version)} is outside the declared engines.node range "${range}", so no test was run - install the pinned runtime (see .nvmrc) and retry`,
      ERROR_CODE_ENGINE,
    );
  }
  return { version, range };
};

/* ---------------------------------------------------------------------------
 * Configuration and preconditions.
 * ------------------------------------------------------------------------- */

/**
 * Resolves the minimum number of passing tests: `DEFAULT_MIN_TESTS` unless the
 * environment overrides it for local subsetting.
 *
 * The override is validated as a **non-negative integer** and rejected
 * otherwise, including the empty string. That strictness is the point: `''`
 * coerces to `0` and any other non-numeric value to `NaN`, and both would make
 * `passed >= MIN_TESTS` trivially or permanently satisfied - a guard that can
 * never fail.
 *
 * @param {Record<string, (string|undefined)>} [environment] `process.env` by
 *   default; injectable so the rule is assertable without mutating the process.
 * @returns {number} The floor the run must clear.
 * @throws {Error} When the override is present but is not a non-negative
 *   integer, naming the offending value.
 */
const resolveMinTests = (environment = process.env) => {
  const raw = environment === null || typeof environment !== 'object'
    ? undefined
    : environment[MIN_TESTS_ENVIRONMENT_KEY];
  if (raw === undefined) {
    return DEFAULT_MIN_TESTS;
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : String(raw).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw guardError(
      `${MIN_TESTS_ENVIRONMENT_KEY} must be a non-negative integer: ${renderValue(raw)}`,
      ERROR_CODE_CONFIG,
    );
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value)) {
    throw guardError(
      `${MIN_TESTS_ENVIRONMENT_KEY} is too large to compare against a test count: ${renderValue(raw)}`,
      ERROR_CODE_CONFIG,
    );
  }
  return value;
};

/**
 * Requires every declared test file to exist as a regular file before the run
 * starts. A missing file is otherwise reported by the runner as one ordinary
 * failing test, which reads as a broken test rather than as a suite that is not
 * there at all.
 *
 * @param {string[]} files Absolute paths to check, in suite order.
 * @returns {string[]} The same paths, once all of them are present.
 * @throws {Error} Naming the first path that is missing or is not a file.
 */
const assertTestFilesPresent = (files) => {
  if (!Array.isArray(files) || files.length === 0) {
    throw guardError(
      'no test file is declared, so the suite cannot prove anything',
      ERROR_CODE_MISSING_FILE,
    );
  }
  for (const file of files) {
    let stats;
    try {
      stats = fs.statSync(file);
    } catch (cause) {
      throw guardError(
        `declared test file is missing: ${file}`,
        ERROR_CODE_MISSING_FILE,
        cause,
      );
    }
    if (!stats.isFile()) {
      throw guardError(
        `declared test file is not a regular file: ${file}`,
        ERROR_CODE_MISSING_FILE,
      );
    }
  }
  return files;
};

/* ---------------------------------------------------------------------------
 * Running the suite.
 * ------------------------------------------------------------------------- */

/**
 * Reads one count off a summary payload defensively. An absent or non-numeric
 * count becomes `NaN`, which every condition below treats as a failure rather
 * than as a satisfied comparison.
 *
 * @param {unknown} counts The `counts` object of a `test:summary` event.
 * @param {string} key One of `passed`, `failed`, `cancelled`, `skipped`, `todo`.
 * @returns {number} The count, or `NaN`.
 */
const countOf = (counts, key) => {
  const value = counts === null || typeof counts !== 'object' ? undefined : counts[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
};

/**
 * @param {number} count A possibly unreadable count.
 * @returns {string} It, or the word `unknown`, so a diagnostic never prints
 *   `NaN` at a reader.
 */
const describeCount = (count) => (Number.isNaN(count) ? 'unknown' : String(count));

/**
 * @param {unknown} counts The `counts` object of a `test:summary` event.
 * @returns {string} A compact, fixed-order rendering of the counts that matter.
 */
const formatCounts = (counts) => {
  const passed = describeCount(countOf(counts, 'passed'));
  const failed = describeCount(countOf(counts, 'failed'));
  const cancelled = describeCount(countOf(counts, 'cancelled'));
  const skipped = describeCount(countOf(counts, 'skipped'));
  const todo = describeCount(countOf(counts, 'todo'));
  return `${passed} passed, ${failed} failed, ${cancelled} cancelled, ${skipped} skipped, ${todo} todo`;
};

/**
 * Summarizes one failing test for the diagnostic list.
 *
 * @param {unknown} event A `test:fail` payload.
 * @returns {{name: string, file: string, message: string}} The failure, bounded.
 */
const describeFailure = (event) => {
  const data = event === null || typeof event !== 'object' ? {} : event;
  const details = data.details === null || typeof data.details !== 'object' ? {} : data.details;
  const error = details.error;
  const detail = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error === undefined ? 'no error detail was reported' : error);
  return {
    name: typeof data.name === 'string' && data.name !== '' ? data.name : '(unnamed test)',
    file: typeof data.file === 'string' && data.file !== '' ? displayPath(data.file) : '(unknown file)',
    message: renderValue(detail, MESSAGE_EXCERPT_LIMIT),
  };
};

/**
 * Runs the suite once through the programmatic runner and collects everything
 * the verdict needs.
 *
 * Two mechanics here are load-bearing and were verified rather than assumed:
 *
 *   - `concurrency: 1`, because `test/server.test.js` binds the fixed
 *     `127.0.0.1:3000` (guarantee 3 in the file header).
 *   - The returned stream is **consumed**. Without a consumer, `end` never
 *     fires and this promise would never settle; the `data` listener is that
 *     consumer, and it deliberately does nothing with the events beyond letting
 *     them flow.
 *
 * Each file emits its own `test:summary`, and the aggregate arrives last with
 * no `file` property - which is how the two are told apart here.
 *
 * @param {string[]} files Absolute paths, already checked for existence.
 * @param {{runner?: Function}} [options] `runner` replaces `node:test`'s `run`;
 *   it exists so the verdict logic can be exercised without a real suite.
 * @returns {Promise<{aggregate: (object|null), last: (object|null), fileSummaries: object[], failures: Array<{name: string, file: string, message: string}>, failureTotal: number}>}
 *   Resolves once the run has ended.
 * @throws {Error} Rejects when the runner cannot be started or the stream
 *   fails, which is a guard failure rather than a test failure.
 */
const runSuite = (files, options = {}) => new Promise((resolve, reject) => {
  const runner = typeof options.runner === 'function' ? options.runner : run;
  const state = {
    aggregate: null,
    last: null,
    fileSummaries: [],
    failures: [],
    failureTotal: 0,
  };

  let stream;
  try {
    stream = runner({ files, concurrency: TEST_CONCURRENCY });
  } catch (cause) {
    reject(guardError(
      `the test runner could not be started: ${renderValue(cause && cause.message, MESSAGE_EXCERPT_LIMIT)}`,
      ERROR_CODE_RUNNER,
      cause,
    ));
    return;
  }

  if (stream === null || typeof stream !== 'object' || typeof stream.on !== 'function') {
    reject(guardError(
      'the test runner did not return an event stream, so no verdict can be reached',
      ERROR_CODE_RUNNER,
    ));
    return;
  }

  stream.on('test:summary', (event) => {
    state.last = event;
    const file = event === null || typeof event !== 'object' ? undefined : event.file;
    if (typeof file === 'string' && file !== '') {
      state.fileSummaries.push(event);
      writeOut(`${LOG_PREFIX}:   ${displayPath(file)} - ${formatCounts(event.counts)}`);
    } else {
      state.aggregate = event;
    }
  });

  stream.on('test:fail', (event) => {
    state.failureTotal += 1;
    if (state.failures.length < FAILURE_DETAIL_LIMIT) {
      state.failures.push(describeFailure(event));
    }
  });

  // The consumer that makes `end` fire. See the note above.
  stream.on('data', () => {});

  stream.once('error', (cause) => {
    reject(guardError(
      `the test runner stream failed: ${renderValue(cause && cause.message, MESSAGE_EXCERPT_LIMIT)}`,
      ERROR_CODE_RUNNER,
      cause,
    ));
  });

  stream.once('end', () => {
    resolve(state);
  });
});

/* ---------------------------------------------------------------------------
 * The verdict.
 * ------------------------------------------------------------------------- */

/**
 * Applies the guard to an aggregate summary. Exit 0 requires all three
 * conditions, and a missing summary is a failure in its own right.
 *
 * @param {object|null|undefined} summary The aggregate `test:summary` payload.
 * @param {number} minTests The floor from `resolveMinTests`.
 * @returns {{ok: boolean, reasons: string[], counts: (unknown|null)}} The
 *   verdict, with one reason per condition that did not hold.
 */
const evaluateRun = (summary, minTests) => {
  if (summary === null || summary === undefined || typeof summary !== 'object'
    || summary.counts === null || typeof summary.counts !== 'object') {
    return {
      ok: false,
      reasons: ['no aggregate test:summary event was emitted, so the suite did not execute as intended'],
      counts: null,
    };
  }

  const counts = summary.counts;
  const passed = countOf(counts, 'passed');
  const failed = countOf(counts, 'failed');
  const cancelled = countOf(counts, 'cancelled');
  const reasons = [];

  if (failed !== 0) {
    reasons.push(`failed is ${describeCount(failed)}, expected 0`);
  }
  // Cancelled tests are their own condition: a run has been observed reporting
  // zero failures while tests were cancelled, which a failure check alone
  // would pass.
  if (cancelled !== 0) {
    reasons.push(`cancelled is ${describeCount(cancelled)}, expected 0`);
  }
  // Written as `!(passed >= minTests)` so an unreadable count, which compares
  // false either way, is reported as a failure instead of slipping through.
  if (!(passed >= minTests)) {
    reasons.push(`passed is ${describeCount(passed)}, at least ${minTests} required`);
  }

  return { ok: reasons.length === 0, reasons, counts };
};

/**
 * Echoes the failing tests, bounded, so a red run is diagnosable from this
 * output alone without re-running `npm run test:raw`.
 *
 * @param {{failures: Array<{name: string, file: string, message: string}>, failureTotal: number}} outcome
 * @returns {void}
 */
const reportFailures = (outcome) => {
  for (const failure of outcome.failures) {
    writeErr(`${LOG_PREFIX}:   FAILED ${failure.file} > ${failure.name}: ${failure.message}`);
  }
  const hidden = outcome.failureTotal - outcome.failures.length;
  if (hidden > 0) {
    writeErr(`${LOG_PREFIX}:   ... and ${hidden} further failing test(s); run \`npm run test:raw\` for the full output`);
  }
};

/**
 * Turns any thrown value into one stderr line. Mirrors `server.js`'s
 * `reportStartupFailure`: the message is collapsed to a single line, and no
 * stack is printed, because the message names the problem and the fix.
 *
 * @param {unknown} error The guard failure.
 * @returns {void}
 */
const reportGuardFailure = (error) => {
  const detail = error instanceof Error && typeof error.message === 'string'
    ? error.message
    : `${LOG_PREFIX}: ${String(error)}`;
  writeErr(detail.replace(/\s+/g, ' '));
};

/* ---------------------------------------------------------------------------
 * Entry point.
 * ------------------------------------------------------------------------- */

/**
 * The whole guard, in the order the contract requires: runtime first, then
 * configuration, then preconditions, then the single run, then the verdict.
 *
 * It returns an exit status instead of setting one, so the status is a value
 * the caller can assert rather than a side effect it has to observe.
 *
 * @param {{files?: string[], environment?: Record<string, (string|undefined)>, version?: string, runner?: Function}} [options]
 *   Injection seams, all defaulted to the real thing: the declared suite,
 *   `process.env`, `process.version` and `node:test`'s `run`.
 * @returns {Promise<number>} `EXIT_SUCCESS` only when every condition held.
 */
const main = async (options = {}) => {
  try {
    const files = Array.isArray(options.files) ? options.files : TEST_FILES;

    // Fails fast, before anything is executed: an unsupported runtime cannot
    // produce evidence this project is willing to stand behind.
    const runtime = assertRuntimeSupported(options.version === undefined ? process.version : options.version);
    const minTests = resolveMinTests(options.environment === undefined ? process.env : options.environment);
    assertTestFilesPresent(files);

    writeOut(`${LOG_PREFIX}: Node ${runtime.version} satisfies engines.node "${runtime.range}"`);
    writeOut(`${LOG_PREFIX}: running ${files.length} test file(s) at concurrency ${TEST_CONCURRENCY}, requiring at least ${minTests} passing test(s)`);

    const outcome = await runSuite(files, options);
    const verdict = evaluateRun(outcome.aggregate === null ? outcome.last : outcome.aggregate, minTests);

    if (!verdict.ok) {
      reportFailures(outcome);
      writeErr(`${LOG_PREFIX}: FAIL - ${verdict.reasons.join('; ')}`);
      return EXIT_FAILURE;
    }

    writeOut(`${LOG_PREFIX}: PASS - ${formatCounts(verdict.counts)} (minimum ${minTests} passing, 0 failed, 0 cancelled)`);
    return EXIT_SUCCESS;
  } catch (error) {
    reportGuardFailure(error);
    return EXIT_FAILURE;
  }
};

/**
 * Exported for in-process verification of the pieces that decide a verdict -
 * the range parser, the `MIN_TESTS` rule and the guard itself - which cannot be
 * reached through the command line without running the whole suite. Requiring
 * this module has **no side effect**: nothing is checked and no test is run
 * unless this file is the process entry point, the same lifecycle `server.js`
 * uses.
 */
module.exports = {
  TEST_FILES,
  DEFAULT_MIN_TESTS,
  parseVersionSpec,
  satisfiesRange,
  readEngineRange,
  assertRuntimeSupported,
  resolveMinTests,
  assertTestFilesPresent,
  runSuite,
  evaluateRun,
  main,
};

if (require.main === module) {
  // `process.exitCode` rather than `process.exit`, so the diagnostics written
  // above are flushed in full before the process ends, and the run ends on its
  // own once the runner's children have exited.
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    reportGuardFailure(error);
    process.exitCode = EXIT_FAILURE;
  });
}

