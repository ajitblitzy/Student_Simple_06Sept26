'use strict';

/**
 * verify-tests.js - the guarded entry point of `npm test`.
 *
 * It supplies the exit status nothing else does: `node --test` exits 0 when it
 * discovers no test file, and the programmatic `run()` used here never sets an
 * exit code at all, so an empty or partial suite would otherwise report a pass.
 * It is wired as `scripts.test`, so the conventional command cannot bypass it;
 * `npm run test:raw` is the unguarded runner, for per-test output.
 *
 * It lives at the repository root rather than under `test/`, because default
 * discovery executes every `.js` file under `test/` as a test - a guard placed
 * there would become one of the tests it counts.
 *
 * Exit 0 requires all of the following; anything else exits 1, naming each
 * condition that did not hold:
 *
 *   - The host runtime satisfies `engines.node` from `package.json`, checked
 *     before any test runs. That check is the only enforcement of the runtime
 *     contract: `engines` merely warns with no `.npmrc` setting
 *     `engine-strict`, and `.nvmrc` is inert without a version manager.
 *   - Every declared test file exists.
 *   - `127.0.0.1:3000` is free, checked only when the declared suite includes
 *     `test/server.test.js` - the one file that binds it. A suite blocked by a
 *     port it does not own aborts here as an environmental precondition,
 *     naming the port once, instead of running and reporting failures whose
 *     titles impute a product regression.
 *   - The cumulative summary reports `passed >= MIN_TESTS` with `failed === 0`
 *     and `cancelled === 0`. The floor is 45 by default; `MIN_TESTS` may set
 *     any floor of at least 1, never 0, which a run that executed nothing
 *     would satisfy.
 *   - Every declared file emitted exactly one `test:summary` of its own.
 *
 * The suite runs at concurrency 1 because `test/server.test.js` binds the fixed
 * `127.0.0.1:3000`: a concurrent second bind fails with `EADDRINUSE`, surfacing
 * as cancelled tests that name neither the port nor the conflict.
 *
 * Only `test()` declarations count toward `passed`; an assertion made inside a
 * `before` or `after` hook does not.
 */

const { run } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

const MANIFEST_PATH = path.join(__dirname, 'package.json');

/**
 * The suite, in run order. Named explicitly rather than discovered: the runner
 * does not accept a directory argument, and every `.js` file under `test/` would
 * otherwise join the suite and inflate the count this guard checks. Each path
 * resolves against `__dirname`, so the guard behaves identically however it is
 * invoked.
 */
const TEST_FILES = [
  'test/activities.test.js',
  'test/server.test.js',
  'test/workbooks.test.js',
].map((relativePath) => path.join(__dirname, relativePath));

/**
 * The number of tests the suite declares, and a fixed floor: deriving it from
 * the run itself would make any number of executed tests "expected".
 */
const DEFAULT_MIN_TESTS = 45;

const MIN_TESTS_ENVIRONMENT_KEY = 'MIN_TESTS';

/**
 * The smallest floor an override may set. Zero is refused because `passed >= 0`
 * holds for a run that executed nothing, so an override may narrow the floor
 * for a subset but never remove it.
 */
const MINIMUM_MIN_TESTS = 1;

const TEST_CONCURRENCY = 1;
const FAILURE_DETAIL_LIMIT = 20;
const MESSAGE_EXCERPT_LIMIT = 200;
const VALUE_EXCERPT_LIMIT = 64;
const LOG_PREFIX = 'verify-tests.js';

/**
 * The one fixed network resource the suite needs, and the only declared file
 * that binds it. That bind is deliberate - `test/server.test.js` asserts the
 * default-port banner and the greeting's exact bytes against the artifact an
 * operator runs - so a busy port is reported here rather than worked around by
 * moving those assertions off the port.
 *
 * The binder is written relatively for readability and resolved against
 * `__dirname`, so the comparison in `bindsDefaultPort` never depends on the
 * working directory the guard was invoked from.
 */
const DEFAULT_PORT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const DEFAULT_PORT_BINDER_RELATIVE = 'test/server.test.js';
const DEFAULT_PORT_BINDER = path.join(__dirname, DEFAULT_PORT_BINDER_RELATIVE);

/**
 * Bounds for the port precondition: how long a `listen` may take to settle
 * before the check gives up, and how long - plus how much output - the
 * best-effort owner lookup on the abort path may consume. Both are small: this
 * work happens before any test runs and must never become the reason a gate
 * hangs.
 */
const PORT_PROBE_TIMEOUT_MS = 2000;
const PORT_OWNER_TIMEOUT_MS = 2000;
const PORT_OWNER_OUTPUT_LIMIT = 1024 * 1024;

/**
 * Marks a verdict the product did not cause.
 *
 * `ENVIRONMENTAL PRECONDITION` is the prefix a reader greps for, and
 * `test/server.test.js` opens its own conflict messages with the same words,
 * so one search finds every such report wherever it was produced. The
 * parenthetical differs deliberately between the two: this one aborts a gate
 * that ran nothing, so it says the run did not fail on the product, while that
 * file marks an individual test that did go red and says the redness is not a
 * regression. Neither file can import the other's constant - a test file
 * requiring the guard would execute the guard's module body - so the shared
 * part is the prefix, not the whole sentence.
 */
const ENVIRONMENTAL_PRECONDITION_MARKER = 'ENVIRONMENTAL PRECONDITION (not a product failure)';

const ERROR_CODE_MANIFEST = 'ERR_VERIFY_TESTS_MANIFEST';
const ERROR_CODE_ENGINE = 'ERR_VERIFY_TESTS_ENGINE';
const ERROR_CODE_CONFIG = 'ERR_VERIFY_TESTS_CONFIG';
const ERROR_CODE_MISSING_FILE = 'ERR_VERIFY_TESTS_MISSING_FILE';
/**
 * One code for the whole port precondition, EADDRINUSE and every other reason
 * the port could not be certified free alike: it names the condition that
 * stopped the gate - the suite's fixed port is not usable - and the message
 * carries the underlying errno.
 */
const ERROR_CODE_PORT_BUSY = 'ERR_VERIFY_TESTS_PORT_BUSY';
const ERROR_CODE_RUNNER = 'ERR_VERIFY_TESTS_RUNNER';

const guardError = (summary, code, cause) => {
  const message = `${LOG_PREFIX}: ${summary}`;
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
};

/**
 * Renders an untrusted value for a diagnostic: whitespace collapsed so one
 * problem stays on one line, length bounded, and the empty string made visible.
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

const displayPath = (absolutePath) => {
  const relativePath = path.relative(__dirname, absolutePath);
  if (relativePath === '' || relativePath.startsWith('..')) {
    return absolutePath;
  }
  return relativePath.split(path.sep).join('/');
};

const writeOut = (line) => {
  process.stdout.write(`${line}\n`);
};

const writeErr = (line) => {
  process.stderr.write(`${line}\n`);
};

const VERSION_SEGMENT_PATTERN = /^(?:0|[1-9]\d*|[xX*])$/;
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/;
const PRERELEASE_IDENTIFIER_PATTERN = /^[0-9A-Za-z-]+$/;
const NUMERIC_IDENTIFIER_PATTERN = /^(?:0|[1-9]\d*)$/;
const DIGITS_ONLY_PATTERN = /^\d+$/;

/**
 * The lowest prerelease any triple can carry - semver's `-0`, since a numeric
 * identifier sorts below every alphanumeric one and `0` is the smallest of
 * them. Frozen because it is shared by every derived bound that uses it.
 */
const LOWEST_PRERELEASE = Object.freeze([0]);

/**
 * @typedef {object} VersionSpec A parsed version token, possibly partial.
 * @property {number|null} major The major, or `null` for a wildcard.
 * @property {number|null} minor The minor, or `null` when unspecified.
 * @property {number|null} patch The patch, or `null` when unspecified.
 * @property {Array<number|string>} prerelease The prerelease identifiers in
 *   order, empty for a release version.
 */

/**
 * @typedef {object} ConcreteVersion A version with every segment fixed.
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {Array<number|string>} prerelease Empty for a release version.
 */

/**
 * @typedef {object} Comparator One primitive bound of a range.
 * @property {string} operator One of `>=`, `>`, `<=`, `<`.
 * @property {ConcreteVersion} version The bound compared against.
 */

/**
 * Parses the prerelease suffix of a version - everything after the first `-`,
 * with build metadata already removed - into the identifiers semver compares.
 *
 * @param {string} text The suffix, e.g. `rc.1` or `nightly.20260917`.
 * @returns {Array<number|string>|null} The identifiers in order, numeric ones
 *   as numbers so they compare numerically, or `null` when the suffix is not a
 *   legal prerelease: an empty identifier (`24.0.0-`, `24.0.0-rc..1`), a
 *   character semver does not allow, a numeric identifier with a leading zero,
 *   or one too large to compare exactly. Every one of those fails closed.
 */
const parsePrerelease = (text) => {
  const identifiers = [];
  for (const identifier of text.split('.')) {
    if (!PRERELEASE_IDENTIFIER_PATTERN.test(identifier)) {
      return null;
    }
    if (!DIGITS_ONLY_PATTERN.test(identifier)) {
      identifiers.push(identifier);
      continue;
    }
    // `rc.01` is invalid semver rather than a number to normalize, and a
    // number beyond the safe range could not be compared reliably.
    if (!NUMERIC_IDENTIFIER_PATTERN.test(identifier)) {
      return null;
    }
    const value = Number.parseInt(identifier, 10);
    if (!Number.isSafeInteger(value)) {
      return null;
    }
    identifiers.push(value);
  }
  return identifiers;
};

/**
 * Compares two prerelease identifiers by semver precedence: numeric against
 * numeric compares numerically, numeric is always lower than alphanumeric, and
 * alphanumeric against alphanumeric compares in ASCII order.
 *
 * @param {number|string} left
 * @param {number|string} right
 * @returns {number} Negative, zero or positive.
 */
const compareIdentifiers = (left, right) => {
  const leftIsNumeric = typeof left === 'number';
  const rightIsNumeric = typeof right === 'number';
  if (leftIsNumeric && rightIsNumeric) {
    return left - right;
  }
  if (leftIsNumeric !== rightIsNumeric) {
    return leftIsNumeric ? -1 : 1;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/**
 * Compares two prerelease lists at an equal `major.minor.patch`, by semver
 * precedence: a version carrying a prerelease is **lower** than the same triple
 * without one, identifiers are compared pairwise, and when every compared
 * identifier is equal the shorter list is lower (`1.0.0-rc < 1.0.0-rc.1`).
 *
 * @param {Array<number|string>} left
 * @param {Array<number|string>} right
 * @returns {number} Negative, zero or positive.
 */
const comparePrerelease = (left, right) => {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const order = compareIdentifiers(left[index], right[index]);
    if (order !== 0) {
      return order;
    }
  }
  return left.length - right.length;
};

/**
 * Parses a version token into a possibly partial triple and its prerelease.
 *
 * A leading `v` is accepted, because `process.version` carries one. Build
 * metadata (`+build.7`) is discarded, because semver gives it no precedence. A
 * prerelease (`-rc.1`, `-nightly.20260917`) is kept and compared: node-semver
 * sorts a prerelease below its own release and admits it only where the range
 * names a prerelease of the same triple, so discarding it here would let
 * `v24.0.0-rc.1` pass a `>=24.0.0 <25` gate that npm rejects. A prerelease
 * qualifies one exact triple, so it is rejected on a partial or wildcard token
 * (`24-rc`, `24.x-rc`) rather than quietly dropped.
 *
 * @param {unknown} raw The token, e.g. `24.21.0`, `v24.21.0`, `24.x`, `24` or
 *   `24.0.0-rc.1`.
 * @returns {VersionSpec|null} The triple with unspecified segments as `null`
 *   and an always-present `prerelease` list, empty for a release; or `null`
 *   when the token is not a version this guard can read, which every caller
 *   turns into a refusal rather than a pass. An all-wildcard token yields a
 *   `null` `major`, which callers treat as "any version".
 */
const parseVersionSpec = (raw) => {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim().replace(/^[vV]/, '');
  if (trimmed === '') {
    return null;
  }
  // The first `-` opens the prerelease and any later one belongs to it, so the
  // split is positional rather than a character class.
  const withoutBuild = trimmed.split('+')[0];
  const boundary = withoutBuild.indexOf('-');
  const core = boundary === -1 ? withoutBuild : withoutBuild.slice(0, boundary);
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
  const prerelease = boundary === -1 ? [] : parsePrerelease(withoutBuild.slice(boundary + 1));
  if (prerelease === null) {
    return null;
  }
  // `24-rc` and `24.x-rc` are not versions: there is no single triple for the
  // prerelease to qualify, and npm's parser rejects them too.
  if (prerelease.length > 0 && (parsed.length !== 3 || parsed.includes(null))) {
    return null;
  }
  return {
    major: parsed.length > 0 ? parsed[0] : null,
    minor: parsed.length > 1 ? parsed[1] : null,
    patch: parsed.length > 2 ? parsed[2] : null,
    prerelease,
  };
};

/**
 * @param {VersionSpec} spec
 * @returns {ConcreteVersion} The spec with unspecified segments zero-filled -
 *   how semver reads `>=24` as `>=24.0.0` - and with its prerelease carried
 *   through unchanged, so `>=24.0.0-rc.0` keeps meaning `rc.0` instead of
 *   collapsing to `24.0.0`. A *derived* exclusive upper bound needs one further
 *   refinement; see `withLowestPrerelease`.
 */
const toConcrete = (spec) => ({
  major: spec.major === null ? 0 : spec.major,
  minor: spec.minor === null ? 0 : spec.minor,
  patch: spec.patch === null ? 0 : spec.patch,
  prerelease: spec.prerelease,
});

/**
 * The next version above a partial spec - the exclusive upper bound implied by
 * its least specified segment. `24` yields `25.0.0`; `24.1` yields `24.2.0`;
 * `24.1.2` yields `24.1.3`.
 *
 * @param {VersionSpec} spec
 * @returns {ConcreteVersion} A release version: the bound is a triple, and any
 *   prerelease it should exclude is applied by the caller.
 */
const nextVersionAbove = (spec) => {
  if (spec.minor === null) {
    return { major: spec.major + 1, minor: 0, patch: 0, prerelease: [] };
  }
  if (spec.patch === null) {
    return { major: spec.major, minor: spec.minor + 1, patch: 0, prerelease: [] };
  }
  return { major: spec.major, minor: spec.minor, patch: spec.patch + 1, prerelease: [] };
};

/**
 * The exclusive upper bound of a caret range, following semver's rules for a
 * zero major: `^24.1.2` bounds at `25.0.0`, `^0.3.1` at `0.4.0` and `^0.0.3` at
 * `0.0.4`.
 *
 * @param {VersionSpec} spec
 * @returns {ConcreteVersion} A release version, as `nextVersionAbove` returns.
 */
const caretUpperBound = (spec) => {
  if (spec.major > 0 || spec.minor === null) {
    return { major: spec.major + 1, minor: 0, patch: 0, prerelease: [] };
  }
  if (spec.minor > 0 || spec.patch === null) {
    return { major: 0, minor: spec.minor + 1, patch: 0, prerelease: [] };
  }
  return { major: 0, minor: 0, patch: spec.patch + 1, prerelease: [] };
};

/**
 * Lowers a derived exclusive upper bound to the first prerelease of its own
 * triple - semver's `-0` suffix. This is what npm's desugaring does, and it is
 * load-bearing: `24.x` becomes `>=24.0.0 <25.0.0-0`, and that `-0` is what puts
 * `25.0.0-rc.1` outside the range. A plain `<25.0.0` would admit it, because a
 * prerelease sorts below its own release.
 *
 * It applies only to bounds this guard *derives*: a partial `<` or `<=`, a bare
 * or `=`-prefixed partial, `^` and `~`. A bound written out in full (`<25.0.0`)
 * is left exactly as declared, which is also what npm does.
 *
 * @param {ConcreteVersion} version The derived bound.
 * @returns {ConcreteVersion} It, lowered to the first prerelease of that triple.
 */
const withLowestPrerelease = (version) => ({
  major: version.major,
  minor: version.minor,
  patch: version.patch,
  prerelease: LOWEST_PRERELEASE,
});

/**
 * Compares two concrete versions by full semver precedence - triple first, then
 * the prerelease, so `24.0.0-rc.1` is below `24.0.0`.
 *
 * @param {ConcreteVersion} left
 * @param {ConcreteVersion} right
 * @returns {number} Negative, zero or positive, as `Array#sort` expects.
 */
const compareVersions = (left, right) => {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  if (left.patch !== right.patch) {
    return left.patch - right.patch;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
};

/**
 * Expands one range token into the primitive comparators it means: `>=`, `>`,
 * `<=` or `<` against a concrete version, which is all the comparison needs.
 *
 * Supported: `*`, `x`, a bare or `=`-prefixed version (exact when complete, a
 * range when partial), `>=`, `>`, `<=`, `<`, `^` and `~`, each against a
 * version token. Anything else - an inequality against a wildcard included -
 * returns `null` so the caller fails closed: a guard that cannot read the
 * declared range must not report a pass. The desugaring matches npm's, `-0`
 * upper bounds included, so a prerelease runtime is judged by the same rules;
 * see `withLowestPrerelease`.
 *
 * @param {string} token One whitespace-delimited token of a range.
 * @returns {Comparator[]|null} The comparators, an empty array for "any
 *   version", or `null` when the token is unsupported.
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
    // `*`, `x` and `x.y.z` place no bound at all. An inequality against a
    // wildcard is a different thing entirely - npm desugars `>x` and `<x` to
    // `<0.0.0-0`, which nothing satisfies - so it is refused rather than read
    // as "any version", which would invert its meaning.
    return operator === '>' || operator === '<' ? null : [];
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
      // `<24` and `<24.1` exclude the prereleases of their own bound too, which
      // is the `-0` npm desugars them to; `<24.21.0` is taken as written.
      return spec.patch === null
        ? [{ operator: '<', version: withLowestPrerelease(concrete) }]
        : [{ operator: '<', version: concrete }];
    case '<=':
      return spec.patch === null
        ? [{ operator: '<', version: withLowestPrerelease(nextVersionAbove(spec)) }]
        : [{ operator: '<=', version: concrete }];
    case '^':
      return [
        { operator: '>=', version: concrete },
        { operator: '<', version: withLowestPrerelease(caretUpperBound(spec)) },
      ];
    case '~':
      return [
        { operator: '>=', version: concrete },
        {
          operator: '<',
          version: withLowestPrerelease(spec.minor === null
            ? { major: spec.major + 1, minor: 0, patch: 0, prerelease: [] }
            : { major: spec.major, minor: spec.minor + 1, patch: 0, prerelease: [] }),
        },
      ];
    case '=':
      return spec.patch === null
        ? [
          { operator: '>=', version: concrete },
          { operator: '<', version: withLowestPrerelease(nextVersionAbove(spec)) },
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
 * @returns {Comparator[][]|null} The alternatives, or `null` when the range is
 *   unsupported.
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
 * @param {ConcreteVersion} version
 * @param {Comparator[]} comparators
 * @returns {boolean} Whether every comparator holds by semver precedence. An
 *   empty list holds. Precedence alone is not the whole rule for a prerelease
 *   version; see `alternativeAdmitsPrerelease`.
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
 * Applies node-semver's prerelease rule, exactly as npm does when
 * `includePrerelease` is not set: a version that carries a prerelease is inside
 * a range only where the alternative it satisfied **names** a prerelease of the
 * same `major.minor.patch`. That is what keeps `24.0.0-rc.1` out of
 * `>=24.0.0 <25` while letting it into `>=24.0.0-rc.0 <25`, and it keeps an
 * unrelated nightly such as `24.9.0-pre` out of both.
 *
 * It is applied per alternative rather than across the range, because a
 * prerelease opted into by one alternative says nothing about another.
 *
 * @param {ConcreteVersion} version The version under test, prerelease non-empty.
 * @param {Comparator[]} comparators One alternative, already satisfied by
 *   precedence.
 * @returns {boolean} Whether that alternative admits this prerelease.
 */
const alternativeAdmitsPrerelease = (version, comparators) => comparators.some((comparator) => (
  comparator.version.prerelease.length > 0
  && comparator.version.major === version.major
  && comparator.version.minor === version.minor
  && comparator.version.patch === version.patch
));

/**
 * Decides whether a runtime version falls inside a declared range, by the same
 * rules npm's semver applies - precedence for a release version, and precedence
 * plus the opt-in of `alternativeAdmitsPrerelease` for a prerelease one.
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
  return alternatives.some((comparators) => {
    if (!satisfiesComparators(version, comparators)) {
      return false;
    }
    // A release version is inside as soon as every bound holds. A prerelease
    // has to have been asked for as well, or an rc build of an in-range triple
    // would pass a range that npm reads as excluding it.
    return version.prerelease.length === 0 || alternativeAdmitsPrerelease(version, comparators);
  });
};

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
 * The runtime-contract check, and the first thing the guard does: it runs before
 * any test, because a pass reported from an unsupported runtime is not evidence
 * of anything the project claims to support.
 *
 * @param {string} [version] The runtime to check, `process.version` by default.
 * @returns {{version: string, range: string}} The version checked and the range
 *   it satisfied.
 * @throws {Error} When the runtime is outside the range, or either side cannot
 *   be parsed. A refusal names the detected version and the requirement, and a
 *   prerelease refusal also names the prerelease rule that excluded it, since
 *   its numbers alone look inside the range.
 */
const assertRuntimeSupported = (version = process.version) => {
  const range = readEngineRange();
  if (!satisfiesRange(version, range)) {
    const spec = parseVersionSpec(version);
    const prereleaseNote = spec !== null && spec.prerelease.length > 0
      ? ' - this runtime is a prerelease build, and a prerelease is inside a range only where the range itself names a prerelease of the same major.minor.patch, which is how npm reads engines.node'
      : '';
    throw guardError(
      `Node ${renderValue(version)} is outside the declared engines.node range "${range}"${prereleaseNote}, so no test was run - install the pinned runtime (see .nvmrc) and retry`,
      ERROR_CODE_ENGINE,
    );
  }
  return { version, range };
};

/**
 * Resolves the minimum number of passing tests: `DEFAULT_MIN_TESTS` unless the
 * environment overrides it for local subsetting.
 *
 * The override must be an integer of at least 1, and is rejected otherwise.
 * Zero and the empty string, which coerces to `0`, would leave the comparison
 * trivially satisfied by a run that executed nothing; any other non-numeric
 * text coerces to `NaN`, which no count can be compared against at all. The
 * match is anchored and digits-only, so `1e3`, ` 4.5`, `+5` and `-1` are text
 * here, not numbers.
 *
 * @param {Record<string, (string|undefined)>} [environment] `process.env` by
 *   default; injectable so the rule is assertable without mutating the process.
 * @returns {number} The floor the run must clear, always 1 or more.
 * @throws {Error} When the override is present but is not an integer of at
 *   least 1, or is too large to compare against a test count, naming the
 *   offending value in either case.
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
      `${MIN_TESTS_ENVIRONMENT_KEY} must be a positive integer of at least 1: ${renderValue(raw)}`,
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
  if (value < MINIMUM_MIN_TESTS) {
    throw guardError(
      `${MIN_TESTS_ENVIRONMENT_KEY} must be at least ${MINIMUM_MIN_TESTS}, because a floor of zero is satisfied by a run that executed no test at all: ${renderValue(raw)}`,
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

const describeCount = (count) => (Number.isNaN(count) ? 'unknown' : String(count));

const formatCounts = (counts) => {
  const passed = describeCount(countOf(counts, 'passed'));
  const failed = describeCount(countOf(counts, 'failed'));
  const cancelled = describeCount(countOf(counts, 'cancelled'));
  const skipped = describeCount(countOf(counts, 'skipped'));
  const todo = describeCount(countOf(counts, 'todo'));
  return `${passed} passed, ${failed} failed, ${cancelled} cancelled, ${skipped} skipped, ${todo} todo`;
};

/**
 * @param {unknown} event A `test:fail` payload.
 * @returns {{name: string, file: string, message: string}} That failing test
 *   summarized for the diagnostic list, every field bounded.
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
 * The run is at `concurrency: 1`, because `test/server.test.js` binds the fixed
 * `127.0.0.1:3000`. The returned stream must be consumed or `end` never fires
 * and this promise never settles; the `data` listener is that consumer.
 *
 * A file that ran emits its own `test:summary` carrying a `file`, while the
 * cumulative summary arrives with no `file` - which is how the two are told
 * apart. Both are kept and both are checked: the cumulative one is the only
 * source of the verdict's counts, and the per-file ones show that every
 * declared file actually ran (`auditFileSummaries`). Neither stands in for the
 * other.
 *
 * @param {string[]} files Absolute paths, already checked for existence.
 * @param {{runner?: Function}} [options] `runner` replaces `node:test`'s `run`;
 *   it exists so the verdict logic can be exercised without a real suite.
 * @returns {Promise<{aggregate: (object|null), fileSummaries: object[], failures: Array<{name: string, file: string, message: string}>, failureTotal: number}>}
 *   Resolves once the run has ended.
 * @throws {Error} Rejects when the runner cannot be started or the stream
 *   fails, which is a guard failure rather than a test failure.
 */
const runSuite = (files, options = {}) => new Promise((resolve, reject) => {
  const runner = typeof options.runner === 'function' ? options.runner : run;
  const state = {
    aggregate: null,
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

/**
 * Applies the counts half of the guard to the cumulative summary: all three
 * conditions must hold, and a missing summary is a failure in its own right
 * rather than something another event can stand in for. The other half - that
 * every declared file actually reported - is `auditFileSummaries`.
 *
 * @param {object|null|undefined} summary The cumulative `test:summary` payload.
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
  // Cancelled tests are their own condition: a run can report zero failures
  // while tests were cancelled, which a failure check alone would pass.
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
 * Normalizes a path for comparison. The runner echoes back the exact string it
 * was given, but that is not a contract worth depending on: a relative path, a
 * different separator or - on Windows - a different case must still be
 * recognized as the file that was declared.
 *
 * @param {string} filePath A declared path, or one reported by the runner.
 * @returns {string} A key two spellings of the same file share.
 */
const summaryPathKey = (filePath) => {
  const resolved = path.resolve(filePath);
  // Windows paths are case-insensitive, so `C:\...` and `c:\...` are one file.
  // Every other platform's are case-sensitive and must not be folded.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * Requires exactly one per-file `test:summary` from every declared file.
 *
 * The aggregate alone is not evidence that the suite ran: a file that exits part
 * way through, and a file that declares no test at all, each emit no per-file
 * summary while still contributing to the aggregate's `passed` with `failed` at
 * 0, so a whole file can fail to run behind a clean-looking total. Two
 * summaries for one file are refused because the total would then include that
 * file twice.
 *
 * @param {string[]} files The declared suite, in order.
 * @param {object[]} fileSummaries The per-file `test:summary` payloads
 *   collected by `runSuite`, each carrying a non-empty `file`.
 * @returns {string[]} One reason per file that did not report exactly one
 *   summary, in suite order; empty when every declared file reported one.
 */
const auditFileSummaries = (files, fileSummaries) => {
  const summariesPerFile = new Map();
  for (const summary of fileSummaries) {
    const file = summary === null || typeof summary !== 'object' ? undefined : summary.file;
    if (typeof file !== 'string' || file === '') {
      continue;
    }
    const key = summaryPathKey(file);
    const already = summariesPerFile.get(key);
    summariesPerFile.set(key, already === undefined ? 1 : already + 1);
  }
  const reasons = [];
  for (const file of files) {
    const seen = summariesPerFile.get(summaryPathKey(file));
    if (seen === undefined) {
      reasons.push(`${displayPath(file)} emitted no test:summary of its own, so that file did not run to completion`);
    } else if (seen > 1) {
      reasons.push(`${displayPath(file)} emitted ${seen} test:summary events, so its counts are reported more than once`);
    }
  }
  return reasons;
};

/* ---------------------------------------------------------------------------
 * The port precondition.
 *
 * `test/server.test.js` binds `127.0.0.1:3000` deliberately - it is the only
 * place the shipped entrypoint's banner, greeting bytes and bind-conflict
 * contracts are observable - so a host that already has a listener there turns
 * seven of that file's tests red with titles about the greeting, the activity
 * route and shutdown. Read alone, those titles impute a product regression to
 * what is only a resource the suite does not own. The checks below turn that
 * into one abort, before anything runs and before any output claims a run.
 * ------------------------------------------------------------------------- */

/**
 * Decides whether the port precondition applies to this run.
 *
 * It applies only when the declared suite actually contains the file that
 * binds the default port. `main({ files })` is a supported seam, and a subset
 * that omits `test/server.test.js` never touches the port, so aborting such a
 * run over a busy port would refuse work that would have succeeded.
 *
 * Spellings are compared through `summaryPathKey`, which resolves a relative
 * path and folds case on win32, so any spelling of the binder is recognized.
 *
 * @param {unknown} files The declared suite, as passed to `main`.
 * @returns {boolean} `true` when the suite includes the default-port binder.
 */
const bindsDefaultPort = (files) => {
  if (!Array.isArray(files)) {
    return false;
  }
  const binderKey = summaryPathKey(DEFAULT_PORT_BINDER);
  return files.some((file) => typeof file === 'string'
    && file !== ''
    && summaryPathKey(file) === binderKey);
};

/**
 * The command a reader can run to identify the holder themselves, used
 * whenever the lookup below cannot name one.
 *
 * @param {number} port The port to look up.
 * @returns {string} A platform-appropriate, copy-pasteable hint.
 */
const portOwnerHint = (port) => (process.platform === 'win32'
  ? `identify it with \`netstat -ano | findstr :${port}\``
  : `identify it with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\``);

/**
 * Extracts the listening pids for one port from `netstat -ano` output.
 *
 * Every row is matched on its own terms rather than by column slicing, because
 * the column widths shift with the address family: `Proto`, `Local Address`,
 * `Foreign Address`, `State`, `PID`. UDP rows carry no state and fall out on
 * the field count, and the port is taken from after the last `:` so
 * `127.0.0.1:3000`, `0.0.0.0:3000` and `[::]:3000` are all recognized - a
 * wildcard holder blocks the loopback bind just as a loopback holder does.
 *
 * The `LISTENING` literal is the English state name; on a localized Windows
 * nothing matches, which degrades to the hint rather than misreporting.
 *
 * @param {string} output The captured stdout of `netstat -ano`.
 * @param {number} port The port whose holders are wanted.
 * @returns {string[]} The distinct pids found, possibly empty.
 */
const windowsListenerPids = (output, port) => {
  const pids = [];
  for (const line of String(output).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[3] !== 'LISTENING') {
      continue;
    }
    const localPort = fields[1].slice(fields[1].lastIndexOf(':') + 1);
    if (localPort !== String(port) || !DIGITS_ONLY_PATTERN.test(fields[4]) || pids.includes(fields[4])) {
      continue;
    }
    pids.push(fields[4]);
  }
  return pids;
};

/**
 * Best-effort identification of what holds the port, for the abort message
 * only.
 *
 * Everything here is failure-tolerant by construction: the tool may be absent,
 * restricted, localized or slow, and none of that may turn a clear
 * environmental diagnostic into a crash inside the guard's own failure path.
 * Any failure - including `lsof`'s non-zero exit when it matches nothing -
 * degrades to `portOwnerHint`. This runs only when the gate is already
 * aborting, so it cannot affect a passing run.
 *
 * @param {number} port The port that could not be bound.
 * @returns {string} The holding pid(s), or the hint command; never empty, and
 *   never a second rendering of the `host:port` the caller has already named.
 */
const describeDefaultPortOwner = (port) => {
  const onWindows = process.platform === 'win32';
  try {
    const output = execFileSync(
      onWindows ? 'netstat' : 'lsof',
      onWindows ? ['-ano'] : ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      {
        encoding: 'utf8',
        timeout: PORT_OWNER_TIMEOUT_MS,
        maxBuffer: PORT_OWNER_OUTPUT_LIMIT,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    const pids = onWindows
      ? windowsListenerPids(output, port)
      : String(output)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => DIGITS_ONLY_PATTERN.test(line));
    if (pids.length === 0) {
      return `owner not identified, ${portOwnerHint(port)}`;
    }
    return `held by pid ${pids.join(', ')}`;
  } catch {
    // Binding nothing: the failure is the lookup's, not the run's, and the
    // hint is the answer in every one of its forms.
    return `owner not identified, ${portOwnerHint(port)}`;
  }
};

/**
 * Binds a throwaway listener to decide whether the suite's fixed port is free,
 * and releases it again before resolving.
 *
 * Ordering matters twice. The `'error'` listener is attached BEFORE `listen`,
 * because `EADDRINUSE` arrives as an event and an unhandled `'error'` aborts
 * the process - the guard would die where it is supposed to report. And the
 * close on the success path is AWAITED: resolving while the probe still held
 * the socket would hand the suite a port this check itself occupies, which is
 * the exact failure being prevented.
 *
 * TOCTOU: a port found free here can be taken between this release and the
 * suite's own bind. Nothing running on a shared host can close that window, so
 * it is not pretended away - `test/server.test.js` carries the same
 * environmental-precondition marker on its own bind-failure paths, and that is
 * what covers the race.
 *
 * @param {string} host The host to bind.
 * @param {number} port The port to bind.
 * @param {number} timeoutMs Bound on the whole probe, so a `listen` that never
 *   settles cannot hang the gate.
 * @returns {Promise<void>} Resolves once the port was bound AND released.
 * @throws {Error} With `ERROR_CODE_PORT_BUSY`: the port is held, could not be
 *   probed, did not settle in time, or could not be released again.
 */
const probePort = (host, port, timeoutMs) => new Promise((resolve, reject) => {
  const probe = net.createServer();
  let settled = false;
  let timer = null;

  const cleanup = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    probe.removeListener('error', onError);
    probe.removeListener('listening', onListening);
    // A throwaway handle can still emit after the verdict is decided; a noop
    // keeps such a late event from aborting the process.
    probe.on('error', () => {});
  };

  const fail = (error) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    reject(error);
    // Release the handle however the probe ended. `close` on a probe that
    // never listened only reports `ERR_SERVER_NOT_RUNNING` to this callback,
    // which is nothing to act on, and the verdict is already rejected.
    probe.close(() => {});
  };

  const onError = (error) => {
    const code = typeof error.code === 'string' && error.code !== '' ? error.code : 'an unnamed listen error';
    if (code === 'EADDRINUSE') {
      fail(guardError(
        `${ENVIRONMENTAL_PRECONDITION_MARKER}: ${host}:${port} is already in use, ${describeDefaultPortOwner(port)}. `
          + `${DEFAULT_PORT_BINDER_RELATIVE} must bind that exact address - the banner and greeting it asserts are `
          + 'only observable there, so the address is fixed and no environment variable moves it. '
          + 'No test was run. Free the port, or wait for the run holding it to finish, then re-run `npm test`.',
        ERROR_CODE_PORT_BUSY,
        error,
      ));
      return;
    }
    // Fail closed on anything else - `EACCES`, `EADDRNOTAVAIL`, a host that
    // does not resolve. The port could not be certified free, and running the
    // suite on an unknown precondition is what this check exists to prevent.
    // The errno is named; the message is not repeated, since it echoes the
    // address already named here.
    fail(guardError(
      `${ENVIRONMENTAL_PRECONDITION_MARKER}: ${host}:${port} could not be probed before the run (${code}), `
        + 'so the port the suite needs cannot be certified free. No test was run.',
      ERROR_CODE_PORT_BUSY,
      error,
    ));
  };

  const onListening = () => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    probe.close((closeError) => {
      if (closeError) {
        reject(guardError(
          `${ENVIRONMENTAL_PRECONDITION_MARKER}: ${host}:${port} was free, but the pre-flight probe could not release it `
            + `(${renderValue(closeError.code === undefined ? closeError.message : closeError.code)}), `
            + 'so the suite would have met a port this check still held. No test was run.',
          ERROR_CODE_PORT_BUSY,
          closeError,
        ));
        return;
      }
      resolve();
    });
  };

  timer = setTimeout(() => fail(guardError(
    `${ENVIRONMENTAL_PRECONDITION_MARKER}: the pre-flight probe of ${host}:${port} did not settle within `
      + `${timeoutMs} ms, so the port the suite needs cannot be certified free. No test was run.`,
    ERROR_CODE_PORT_BUSY,
  )), timeoutMs);

  probe.once('error', onError);
  probe.once('listening', onListening);
  probe.listen(port, host);
});

/**
 * The precondition itself: the suite's fixed port must be free before the run,
 * whenever the run includes the file that binds it.
 *
 * It is deliberately not a skip and not a retry. Skipping the port-dependent
 * tests would let the contract they hold regress unnoticed, and retrying would
 * make the gate's duration depend on a neighbour's run. Aborting with one
 * named diagnostic is the only outcome that keeps a blocked run and a broken
 * product distinguishable.
 *
 * @param {unknown} files The declared suite, as passed to `main`.
 * @param {{host?: string, port?: number, timeoutMs?: number}} [probe] Probe
 *   target and bound, defaulted to the suite's own; injectable so the check is
 *   exercisable in process without contending for the real port.
 * @returns {Promise<boolean>} `true` when the port was probed and found free,
 *   `false` when the declared suite does not include the binder and the check
 *   therefore does not apply.
 * @throws {Error} With `ERROR_CODE_PORT_BUSY` when the port cannot be
 *   certified free, carrying the environmental-precondition marker, the
 *   `host:port` named once, its owner where identifiable, and the remedy.
 */
const assertDefaultPortAvailable = async (files, probe = {}) => {
  if (!bindsDefaultPort(files)) {
    return false;
  }
  const settings = probe === null || typeof probe !== 'object' ? {} : probe;
  const host = typeof settings.host === 'string' && settings.host !== '' ? settings.host : DEFAULT_PORT_HOST;
  const port = Number.isInteger(settings.port) ? settings.port : DEFAULT_PORT;
  const timeoutMs = Number.isInteger(settings.timeoutMs) && settings.timeoutMs > 0
    ? settings.timeoutMs
    : PORT_PROBE_TIMEOUT_MS;
  await probePort(host, port, timeoutMs);
  return true;
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
 * Turns any thrown value into one stderr line, collapsed to a single line with
 * no stack, because the message names the problem and the fix.
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

/**
 * The whole guard, in the order the contract requires: runtime, configuration,
 * preconditions, the single run, then the verdict. It returns an exit status
 * instead of setting one, so the status is a value the caller can assert.
 *
 * @param {{files?: string[], environment?: Record<string, (string|undefined)>, version?: string, runner?: Function}} [options]
 *   Injection seams, all defaulted to the real thing: the declared suite,
 *   `process.env`, `process.version` and `node:test`'s `run`.
 * @returns {Promise<number>} `EXIT_SUCCESS` only when the cumulative summary
 *   cleared every condition of `evaluateRun` and every declared file reported
 *   exactly one summary of its own; `EXIT_FAILURE` otherwise, with one stderr
 *   line naming every reason.
 */
const main = async (options = {}) => {
  try {
    const files = Array.isArray(options.files) ? options.files : TEST_FILES;

    const runtime = assertRuntimeSupported(options.version === undefined ? process.version : options.version);
    const minTests = resolveMinTests(options.environment === undefined ? process.env : options.environment);
    assertTestFilesPresent(files);
    // Last precondition, and the only one about the host rather than the
    // repository: it aborts before the lines below, so an aborted gate never
    // prints that it is running a suite it did not run.
    await assertDefaultPortAvailable(files);

    writeOut(`${LOG_PREFIX}: Node ${runtime.version} satisfies engines.node "${runtime.range}"`);
    writeOut(`${LOG_PREFIX}: running ${files.length} test file(s) at concurrency ${TEST_CONCURRENCY}, requiring at least ${minTests} passing test(s)`);

    const outcome = await runSuite(files, options);
    // The verdict is the **cumulative** aggregate and nothing else. Falling
    // back to the last per-file summary would let a single file's counts
    // certify the whole suite, and `evaluateRun(null, ...)` already reports an
    // absent aggregate as the failure it is.
    const verdict = evaluateRun(outcome.aggregate, minTests);
    // Whole-suite counts are necessary but not sufficient: a file that exits
    // early or declares nothing contributes to them without running. See
    // `auditFileSummaries`.
    const coverage = auditFileSummaries(files, outcome.fileSummaries);

    if (!verdict.ok || coverage.length > 0) {
      reportFailures(outcome);
      writeErr(`${LOG_PREFIX}: FAIL - ${verdict.reasons.concat(coverage).join('; ')}`);
      return EXIT_FAILURE;
    }

    writeOut(`${LOG_PREFIX}: PASS - ${formatCounts(verdict.counts)} (minimum ${minTests} passing, 0 failed, 0 cancelled, ${files.length} file(s) each summarized once)`);
    return EXIT_SUCCESS;
  } catch (error) {
    reportGuardFailure(error);
    return EXIT_FAILURE;
  }
};

/**
 * Exported so the pieces that decide a verdict - the range parser, the
 * `MIN_TESTS` rule and the guard itself - can be exercised in process without
 * running the whole suite. Requiring this module has no side effect: nothing is
 * checked and no test runs unless this file is the process entry point.
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
  bindsDefaultPort,
  describeDefaultPortOwner,
  assertDefaultPortAvailable,
  runSuite,
  evaluateRun,
  auditFileSummaries,
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
