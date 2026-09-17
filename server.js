'use strict';

/**
 * The service entrypoint: the HTTP dispatcher and the single composition root of
 * the extracurricular-activity feature. It exports `resolveConfig`,
 * `createServer` and `start`; requiring it binds no port and writes nothing.
 *
 * The authority gate. Every request is judged on its `Host` authority before
 * its target is parsed and before any route sees it. A loopback bind keeps
 * remote packets out but not a remote origin: a DNS name rebound to `127.0.0.1`
 * lets a browser issue same-origin requests that arrive locally and differ only
 * in the authority they name. A loopback bind therefore answers only for
 * `localhost`, `127.0.0.1`, `::1` and its own bind value, on the port actually
 * bound; a wider bind answers only for the authorities `ALLOWED_HOSTS` names and
 * refuses to start without them. A refusal is `400 INVALID_HOST` or
 * `421 MISDIRECTED_REQUEST` with `Connection: close`.
 *
 * The routing boundary. The request target is parsed here exactly once and one
 * object is handed down - `{ method, segments, rawPath, query }` - in which
 * `segments` is the path split on `/` with the leading empty element dropped and
 * each segment percent-decoded exactly once, `rawPath` is the target with the
 * query removed and serves error messages only, and `query` is a
 * `URLSearchParams` over the raw query text. `lib/activityRoutes.js` reads those
 * four properties, never decodes again, and returns `true` when it has written a
 * response or `false` for a path it does not recognise; this file writes the one
 * `404 NOT_FOUND` for every declined path, so no status is produced twice.
 *
 * The root path is served here. `GET` and `HEAD` answer `200`,
 * `Content-Type: text/plain` and the 34-byte body
 * `Hello, World Welcome to Sharebot!\n`, whose trailing newline is part of the
 * contract and whose `Content-Length` is derived from the body so the declared
 * length cannot drift from the bytes sent. Any other method on `/` answers
 * `405` with `Allow: GET, HEAD`.
 *
 * Failure is split by caller. `createServer` throws synchronously on a
 * configuration or load failure and never listens, so it cannot produce a bind
 * error at all. `start` rejects on a bind failure and never calls
 * `process.exit`; after startup, server errors stay observable on the returned
 * server. The `require.main === module` wrapper is the only place a failure
 * becomes process behaviour: one stderr line and a non-zero exit code.
 */

const http = require('http');
const net = require('node:net');
const path = require('node:path');

const studentDirectory = require('./lib/studentDirectory');
const activityRepository = require('./lib/activityRepository');
const activityRoutes = require('./lib/activityRoutes');

/**
 * The loopback default. Nothing here widens the binding: `HOST=0.0.0.0`
 * publishes a service that authenticates nobody, so the default stays loopback
 * and the README carries the warning instead.
 */
const DEFAULT_HOST = '127.0.0.1';

const DEFAULT_PORT = 3000;
const DEFAULT_ACTIVITIES_FILENAME = 'activities.json';

/*
 * The write-path ceilings, and the environment variable that overrides each.
 * The values themselves come from `activityRepository.WRITE_LIMIT_DEFAULTS`, the
 * module that enforces them, so the default resolved here and the default
 * applied cannot drift apart; `resolveConfig` makes each one concrete so
 * `server.config` reports the ceilings actually in force. Each bounds a
 * different quantity - pending writes, activities per student, registry records
 * and registry bytes - per process and across every caller together; none is a
 * per-client rate limit.
 */
const LIMIT_ENVIRONMENT_KEYS = Object.freeze({
  maxPendingWrites: 'MAX_PENDING_WRITES',
  maxActivitiesPerStudent: 'MAX_ACTIVITIES_PER_STUDENT',
  maxRegistryRecords: 'MAX_REGISTRY_RECORDS',
  maxRegistryBytes: 'MAX_REGISTRY_BYTES'
});

const LIMIT_KEYS = Object.freeze(Object.keys(LIMIT_ENVIRONMENT_KEYS));

/**
 * A limit is validated as a whole string before conversion, for the same reason
 * a port is: `Number.parseInt` would read `'16abc'` as `16` and `'1.5'` as `1`,
 * silently enforcing a ceiling the operator never wrote. Ten digits is past
 * every sane ceiling and still inside `Number.MAX_SAFE_INTEGER`.
 */
const LIMIT_TEXT_PATTERN = /^\d{1,10}$/;

const MIN_LIMIT = 1;

const GREETING = 'Hello, World Welcome to Sharebot!\n';
const GREETING_BYTE_LENGTH = Buffer.byteLength(GREETING);

const TEXT_MEDIA_TYPE = 'text/plain';
const JSON_MEDIA_TYPE = 'application/json';
const ROOT_PATH = '/';

/*
 * `Allow` values are exact and ordered, because a `405` must name what works.
 * The per-student value is byte-identical to the one `lib/activityRoutes.js`
 * sends for that route, so one spelling serves both sides of the boundary; it is
 * needed here only for the malformed-escape case, which never reaches the API
 * handler.
 */
const ALLOW_ROOT = 'GET, HEAD';
const ALLOW_STUDENT_ACTIVITIES = 'GET, HEAD, POST';

const METHOD_GET = 'GET';
const METHOD_HEAD = 'HEAD';
const METHOD_POST = 'POST';

const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_NOT_FOUND = 404;
const STATUS_METHOD_NOT_ALLOWED = 405;

/**
 * `421 Misdirected Request` - RFC 9110 15.5.20: the request was directed at a
 * server that is unwilling to produce an authoritative response for the target
 * URI's origin. That is exactly the authority-mismatch case below, and keeping
 * it distinct from `400` is what lets an operator tell a rebound origin apart
 * from a client that sent a malformed `Host` at all.
 */
const STATUS_MISDIRECTED_REQUEST = 421;

const CODE_INVALID_STUDENT_ID = 'INVALID_STUDENT_ID';
const CODE_METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED';
const CODE_NOT_FOUND = 'NOT_FOUND';
const CODE_INVALID_HOST = 'INVALID_HOST';
const CODE_MISDIRECTED_REQUEST = 'MISDIRECTED_REQUEST';

/**
 * The two authority sentences. Both are **fixed and interpolate nothing**: the
 * `Host` header is entirely caller-controlled, so echoing it back - even
 * JSON-encoded and truncated - would reflect attacker-chosen text into a
 * response and into whatever reads it. Neither is written to stderr either;
 * per-request logging is declined system-wide, and a log line carrying this
 * value would be a terminal-control injection sink rather than a diagnostic.
 */
const MESSAGE_INVALID_HOST = 'Host header must be a single valid authority';
const MESSAGE_MISDIRECTED_REQUEST = 'Request authority is not served by this server';

/*
 * The per-student route's shape, mirrored from `lib/activityRoutes.js`, needed
 * only when a malformed percent-escape leaves no decoded segments: the raw
 * segments then decide whether the caller addressed a student (a recognised
 * path, answered by method with `405` or `400 INVALID_STUDENT_ID`) or nothing at
 * all (`404 NOT_FOUND`).
 */
const API_SEGMENT = 'api';
const STUDENTS_SEGMENT = 'students';
const ACTIVITIES_SEGMENT = 'activities';
const STUDENT_ROUTE_SEGMENT_COUNT = 4;
const STUDENT_ID_SEGMENT_INDEX = 2;

/**
 * A port is validated as a **whole string** before conversion.
 * `Number.parseInt` alone is wrong here: it reads `'1.5'` as `1` and
 * `'3000abc'` as `3000`, silently binding a port the operator never asked for.
 */
const PORT_TEXT_PATTERN = /^\d{1,5}$/;

const MIN_PORT = 0;
const MAX_PORT = 65535;
const MAX_MESSAGE_VALUE_LENGTH = 64;

/*
 * The code points that must never reach a log record verbatim, named by Unicode
 * general category so the set is complete rather than hand-picked: `\p{Cc}` the
 * C0 and C1 controls and DEL (CR and LF among them); `\p{Cf}` every format
 * character, which makes the bidirectional embeddings, overrides and isolates
 * unrepresentable along with the zero-width and tag characters that conceal
 * rather than reorder; `\p{Cs}` unpaired surrogates, which would otherwise reach
 * the log as U+FFFD; and `\p{Zl}`/`\p{Zp}`, the two line separators some log
 * readers break on. The u flag makes each match a whole code point, so real astral text in a path
 * is left alone. The identical pattern and sanitizeForLog live in `lib/activityRoutes.js` and
 * `lib/activityRepository.js`, the other two files that own a stderr sink; there is no shared module
 * to hold one copy, and the three must stay in step.
 */
const LOG_UNSAFE_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

const MAX_BMP_CODE_POINT = 0xffff;

const CONFIG_ERROR_CODE = 'SERVER_CONFIG_INVALID';
const UNKNOWN_ERROR_CODE = 'EUNKNOWN';
const EXIT_FAILURE = 1;

const EMPTY_OPTIONS = Object.freeze({});
const DEFAULT_ACTIVITIES_DATA_PATH = path.join(__dirname, DEFAULT_ACTIVITIES_FILENAME);
const DEFAULT_WORKBOOK_DIR = __dirname;

/* ---------------------------------------------------------------------------
 * Request-authority constants.
 *
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * Binding `127.0.0.1` keeps remote *packets* out; it does not keep a remote
 * *origin* out. An attacker serves a page on their own host, points a DNS name
 * with a tiny TTL at that host, gets a browser to load it, then re-answers the
 * name with `127.0.0.1`. The browser's next request goes to this loopback
 * service while the browser still considers it same-origin, so the attacker's
 * script reads the response - that is DNS rebinding, and the connection is
 * genuinely local, so no bind address can stop it. What distinguishes such a
 * request is the one field the browser must send and the attacker cannot
 * change: the `Host` authority names the attacker's own name, never an
 * authority this server answers for. Validating it is therefore what makes the
 * loopback default a real boundary rather than a nominal one.
 * ------------------------------------------------------------------------- */

/**
 * A bind address inside `127.0.0.0/8`. Matched as a whole string, so
 * `127.0.0.1.example` is not a loopback bind.
 */
const LOOPBACK_BIND_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Bind values that are loopback without being an IPv4 literal: the IPv6
 * loopback in both its bare and bracketed spellings, and the name every
 * platform resolves to one of the two.
 */
const LOOPBACK_BIND_NAMES = Object.freeze(['localhost', '::1', '[::1]']);

/**
 * The authority hosts a loopback bind answers for, in addition to the resolved
 * bind value itself. Deliberately the three spellings a client can legitimately
 * reach a loopback service by - not a pattern, because every member of this set
 * is a decision to serve that authority.
 */
const LOOPBACK_AUTHORITY_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);

/**
 * Rejected outright in an authority. `[^!-~]` excludes every character outside
 * printable ASCII - C0 and C1 controls, DEL, space, tab and any non-ASCII byte,
 * so an authority can carry neither a terminal control nor a Unicode
 * look-alike. The explicit list then removes userinfo (`@`) and the delimiters
 * that would make an authority carry a path, query or fragment.
 */
const AUTHORITY_UNSAFE_PATTERN = /[^!-~]|[@/\\?#]/;

/** The port an authority implies when it carries none, per RFC 9110 4.2.1. */
const DEFAULT_HTTP_PORT = 80;

/** How `ALLOWED_HOSTS` separates its entries. */
const ALLOWED_HOSTS_SEPARATOR = ',';

/** The allowlist of a deployment that named none. */
const EMPTY_ALLOWED_HOSTS = Object.freeze([]);

/** The three outcomes of the authority gate. */
const AUTHORITY_ALLOWED = 'ALLOWED';
const AUTHORITY_INVALID = 'INVALID';
const AUTHORITY_MISDIRECTED = 'MISDIRECTED';

const noop = () => {};

const describeValue = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a value of type ${typeof value}`;
};

/**
 * Bounds a value at 64 characters before it is interpolated into a message, so a
 * pathological value cannot become the message.
 */
const truncate = (value) => {
  const text = typeof value === 'string' ? value : String(value === undefined ? '' : value);
  return text.length > MAX_MESSAGE_VALUE_LENGTH
    ? text.slice(0, MAX_MESSAGE_VALUE_LENGTH)
    : text;
};

/**
 * Quotes a rejected value so it stays visible when it is the empty string:
 * `PORT=` must read as a named value, not as a sentence that trails off.
 */
const quoteValue = (value) => `"${truncate(value)}"`;

/**
 * Escapes every code point `LOG_UNSAFE_PATTERN` matches - control, format,
 * bidirectional, surrogate or line separator - as its visible `\uXXXX` or
 * `\u{XXXXX}` spelling, so a stderr record stays one line and says exactly what
 * was supplied (CWE-117). A rejected configuration value must be reported as
 * it arrived - a path may hold any character the filesystem accepts - so the
 * sink is made safe rather than the input. Idempotent: the replacement text
 * matches nothing on a second pass.
 *
 * @param {string} text The text to render.
 * @returns {string} The text with every unsafe code point escaped.
 */
const sanitizeForLog = (text) =>
  text.replace(LOG_UNSAFE_PATTERN, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= MAX_BMP_CODE_POINT
      ? `\\u${codePoint.toString(16).padStart(4, '0')}`
      : `\\u{${codePoint.toString(16)}}`;
  });

const createConfigError = (summary) => {
  const error = new Error(summary);
  error.code = CONFIG_ERROR_CODE;
  return error;
};

/* ---------------------------------------------------------------------------
 * Authority parsing and comparison.
 *
 * One parser serves both sides of the policy: the `Host` header of every
 * request, and every entry of the configured allowlist. That is deliberate -
 * an allowlist entry and a request authority that were normalized by different
 * code could differ in case, in a trailing dot or in IPv6 bracketing, and an
 * authority that "should" match but does not is how such a policy quietly
 * starts refusing legitimate traffic, or quietly starts accepting illegitimate
 * traffic.
 * ------------------------------------------------------------------------- */

/**
 * Normalizes an authority's host for comparison.
 *
 * Lower-cased, because a host is case-insensitive. A single trailing dot is
 * then removed **from a name only**, because `localhost.` is the fully
 * qualified spelling of `localhost` and a browser may send either - but an IP
 * literal has no fully qualified form, so stripping a dot from one would turn a
 * value that is not an address into a value that is. `[::1.]` is the case that
 * matters: dot-stripping it before the comparison would make a malformed
 * literal match the loopback set, which is why this function is told whether it
 * is normalizing a literal and `parseAuthority` validates a bracketed host
 * before it gets here.
 *
 * @param {string} host The host component, already unbracketed.
 * @param {boolean} isLiteral Whether `host` has been validated as an IP literal.
 * @returns {string} The comparison form.
 */
const normalizeAuthorityHost = (host, isLiteral) => {
  const lower = host.toLowerCase();
  if (isLiteral) return lower;
  return lower.length > 1 && lower.endsWith('.') ? lower.slice(0, -1) : lower;
};

/**
 * Parses an authority into its host and port, or reports it unusable.
 *
 * Strict on purpose: anything this returns `null` for is refused rather than
 * repaired, because a value that cannot be parsed one single way is a value two
 * components could read differently. Refused: an empty value, any character
 * outside printable ASCII, userinfo, a path/query/fragment delimiter, a stray
 * bracket, an unbracketed IPv6 literal (two colons would make the port
 * ambiguous), a **bracketed value that is not an IPv6 literal** - checked with
 * `net.isIP`, so `[::1.]` and `[not:ipv6]` are refused rather than normalized
 * into something that could match - and a port that is not one to five digits
 * inside `0`-`65535`.
 *
 * @param {unknown} value The raw authority - a `Host` header or a list entry.
 * @returns {{host: string, port: number|null}|null} The parsed authority, with
 *   `port === null` when it carried none, or `null` when it is unusable.
 */
const parseAuthority = (value) => {
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (text === '' || AUTHORITY_UNSAFE_PATTERN.test(text)) return null;

  let hostText = text;
  let portText = '';
  let isLiteral = false;

  if (text.startsWith('[')) {
    // The bracketed IPv6 form: `[::1]` or `[::1]:3000`.
    const close = text.indexOf(']');
    if (close === -1) return null;
    hostText = text.slice(1, close);
    // Brackets exist for one purpose - to delimit an IPv6 literal - so the
    // contents must actually BE one. A colon is not evidence of that:
    // `[::1.]` and `[not:ipv6]` both carry one and neither is an address, and
    // admitting them would hand a malformed value to comparison.
    if (net.isIP(hostText) !== 6) return null;
    isLiteral = true;
    const rest = text.slice(close + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) return null;
      portText = rest.slice(1);
    }
  } else {
    if (hostText.includes(']')) return null;
    const colon = text.indexOf(':');
    if (colon !== -1) {
      hostText = text.slice(0, colon);
      portText = text.slice(colon + 1);
      // A second colon means an unbracketed IPv6 literal or two ports; either
      // way the port is ambiguous.
      if (portText.includes(':')) return null;
    }
    if (hostText === '' || hostText.includes('[')) return null;
    // An IPv4 literal is a literal too, so it is not dot-normalized either.
    isLiteral = net.isIP(hostText) !== 0;
  }

  let port = null;
  if (portText !== '') {
    if (!PORT_TEXT_PATTERN.test(portText)) return null;
    port = Number(portText);
    if (port > MAX_PORT) return null;
  }

  return { host: normalizeAuthorityHost(hostText, isLiteral), port };
};

/**
 * Renders a parsed authority back to its canonical text, so the resolved
 * configuration reports the allowlist in one spelling - which is what a
 * diagnostic or an assertion can be written against.
 *
 * @param {{host: string, port: number|null}} authority The parsed authority.
 * @returns {string} `app.example`, `app.example:8080` or `[::1]:8080`.
 */
const formatAuthority = ({ host, port }) => {
  const rendered = host.includes(':') ? `[${host}]` : host;
  return port === null ? rendered : `${rendered}:${port}`;
};

/**
 * Whether a resolved bind value keeps the service on the loopback interface.
 *
 * This is the switch between the two halves of the policy: a loopback bind
 * carries an implicit set of loopback authorities, while anything wider - a
 * wildcard such as `0.0.0.0` or `::`, a specific interface address, or a
 * hostname - carries none and must name its authorities explicitly.
 *
 * @param {string} host The resolved, trimmed bind value.
 * @returns {boolean} `true` for a loopback bind.
 */
const isLoopbackBind = (host) => {
  const lower = host.toLowerCase();
  return LOOPBACK_BIND_NAMES.includes(lower) || LOOPBACK_BIND_PATTERN.test(lower);
};

/* ---------------------------------------------------------------------------
 * Configuration resolution. Precedence for every value: an explicit `options`
 * property, then the environment variable, then the default constant above.
 * ------------------------------------------------------------------------- */

/**
 * Reads one configuration value at its precedence. An explicitly `undefined`
 * option property is treated as absent, which is what lets a caller spread a
 * partial object without having to delete its empty slots.
 *
 * @param {object} options The caller's overrides.
 * @param {string} key The option property name.
 * @param {string} environmentKey The environment variable name.
 * @returns {unknown} The winning raw value, or `undefined` for "use the default".
 */
const readOption = (options, key, environmentKey) => {
  const provided = options[key];
  if (provided !== undefined) return provided;
  return process.env[environmentKey];
};

/**
 * Validates a port and returns it as a number.
 *
 * A string is validated in full before conversion, and a number passed
 * programmatically must be an integer in the same range. `0` is preserved: it
 * means "let the kernel choose", which is how the in-process suite avoids the
 * shared default port.
 *
 * @param {unknown} candidate The raw value, or `undefined` for the default.
 * @returns {number} An integer from 0 to 65535.
 * @throws {Error} With `code === 'SERVER_CONFIG_INVALID'`, naming the value.
 */
const resolvePort = (candidate) => {
  if (candidate === undefined) return DEFAULT_PORT;

  if (typeof candidate === 'number') {
    if (!Number.isInteger(candidate) || candidate < MIN_PORT || candidate > MAX_PORT) {
      throw createConfigError(
        `port must be an integer from ${MIN_PORT} to ${MAX_PORT}: ${truncate(String(candidate))}`
      );
    }
    return candidate;
  }

  if (typeof candidate !== 'string') {
    throw createConfigError(
      `port must be a number or a decimal string (received ${describeValue(candidate)})`
    );
  }

  const text = candidate.trim();
  if (!PORT_TEXT_PATTERN.test(text)) {
    throw createConfigError(
      'port must be one to five decimal digits with nothing else, not a fraction ' +
        `and not an empty value: ${quoteValue(candidate)}`
    );
  }

  const value = Number(text);
  if (value > MAX_PORT) {
    throw createConfigError(
      `port must be an integer from ${MIN_PORT} to ${MAX_PORT}: ${quoteValue(candidate)}`
    );
  }
  return value;
};

/**
 * Validates one write-path ceiling and returns it as a number.
 *
 * Shaped after `resolvePort` on purpose, because the hazard is identical: these
 * values arrive from the environment as text, and a partial parse would install
 * a ceiling nobody chose. A string must match `LIMIT_TEXT_PATTERN` in full; a
 * number passed programmatically must be an integer; either way the result must
 * be at least `MIN_LIMIT`, since a ceiling of `0` would report every write as a
 * capacity condition instead of as the configuration mistake it is.
 *
 * @param {unknown} candidate The raw value, or `undefined` for the default.
 * @param {number} fallback The default from the repository's own table.
 * @param {string} label The option name, for the message.
 * @returns {number} An integer of at least 1.
 * @throws {Error} With `code === 'SERVER_CONFIG_INVALID'`, naming the value.
 */
const resolveLimit = (candidate, fallback, label) => {
  if (candidate === undefined) return fallback;

  if (typeof candidate === 'number') {
    if (!Number.isInteger(candidate) || candidate < MIN_LIMIT) {
      throw createConfigError(
        `${label} must be an integer of at least ${MIN_LIMIT}: ${truncate(String(candidate))}`
      );
    }
    return candidate;
  }

  if (typeof candidate !== 'string') {
    throw createConfigError(
      `${label} must be a number or a decimal string (received ${describeValue(candidate)})`
    );
  }

  const text = candidate.trim();
  if (!LIMIT_TEXT_PATTERN.test(text)) {
    throw createConfigError(
      `${label} must be one to ten decimal digits with nothing else, not a fraction ` +
        `and not an empty value: ${quoteValue(candidate)}`
    );
  }

  const value = Number(text);
  if (value < MIN_LIMIT) {
    throw createConfigError(
      `${label} must be an integer of at least ${MIN_LIMIT}: ${quoteValue(candidate)}`
    );
  }
  return value;
};

/**
 * Validates a host and returns it trimmed.
 *
 * An empty or whitespace-only value is fatal rather than a silent bind to every
 * interface: `listen(port, '')` binds `0.0.0.0`, which would publish the service
 * to the network by accident.
 *
 * @param {unknown} candidate The raw value, or `undefined` for the default.
 * @returns {string} A non-empty host.
 * @throws {Error} With `code === 'SERVER_CONFIG_INVALID'`.
 */
const resolveHost = (candidate) => {
  if (candidate === undefined) return DEFAULT_HOST;

  if (typeof candidate !== 'string') {
    throw createConfigError(
      `host must be a non-empty string (received ${describeValue(candidate)})`
    );
  }

  const text = candidate.trim();
  if (text === '') {
    throw createConfigError(
      'host must be a non-empty string, never an implicit bind to every ' +
        `interface: ${quoteValue(candidate)}`
    );
  }
  return text;
};

/**
 * Resolves a path option **against this file's directory**, never against
 * `process.cwd()`. That is what makes `node /path/to/server.js` read the
 * committed workbooks and registry no matter where it was launched from; an
 * absolute value is used as given.
 *
 * @param {unknown} candidate The raw value, or `undefined` for the default.
 * @param {string} fallback The already-absolute default.
 * @param {string} label The option name, for the message.
 * @returns {string} An absolute path.
 * @throws {Error} With `code === 'SERVER_CONFIG_INVALID'`.
 */
const resolveEntrypointPath = (candidate, fallback, label) => {
  if (candidate === undefined) return fallback;

  if (typeof candidate !== 'string') {
    throw createConfigError(
      `${label} must be a non-empty string path (received ${describeValue(candidate)})`
    );
  }

  const text = candidate.trim();
  if (text === '') {
    throw createConfigError(`${label} must be a non-empty string path: ${quoteValue(candidate)}`);
  }
  return path.resolve(__dirname, text);
};

/**
 * Validates the explicit authority allowlist and returns it canonicalized.
 *
 * Accepted shapes, so the environment and a programmatic caller can each say it
 * naturally: a comma-separated string (`'app.example:8080, 10.0.0.5'`) or an
 * array of entries. Every entry passes through the same parser the `Host`
 * header does, so an unusable entry is a **startup** failure naming it rather
 * than a rule that silently never matches.
 *
 * An entry that carries a port matches only that exact `host:port`. An entry
 * that carries none matches that host on any port, which is the reverse-proxy
 * case: a proxy terminating on `:443` forwards `Host: app.example` while this
 * service listens on some other port entirely, and an operator naming
 * `app.example` means the name rather than the port.
 *
 * @param {unknown} candidate The raw value, or `undefined` for "none".
 * @returns {readonly string[]} The frozen, canonical entries.
 * @throws {Error} With `code === 'SERVER_CONFIG_INVALID'`, naming the entry.
 */
const resolveAllowedHosts = (candidate) => {
  if (candidate === undefined) return EMPTY_ALLOWED_HOSTS;

  let rawEntries;
  if (Array.isArray(candidate)) {
    rawEntries = candidate;
  } else if (typeof candidate === 'string') {
    // An empty or whitespace-only value means "none named", which is exactly
    // what an unset variable means; an exported-but-empty `ALLOWED_HOSTS` must
    // not read as an allowlist of one empty authority.
    const text = candidate.trim();
    if (text === '') return EMPTY_ALLOWED_HOSTS;
    rawEntries = text.split(ALLOWED_HOSTS_SEPARATOR);
  } else {
    throw createConfigError(
      'allowedHosts must be a comma-separated string or an array of authorities '
        + `(received ${describeValue(candidate)})`
    );
  }

  const canonical = [];
  rawEntries.forEach((entry) => {
    const authority = parseAuthority(entry);
    if (authority === null) {
      throw createConfigError(
        'allowedHosts entries must each be a host, optionally with a port, and nothing '
          + `else - no scheme, path, userinfo or whitespace: ${quoteValue(entry)}`
      );
    }
    const rendered = formatAuthority(authority);
    // Duplicates are dropped rather than refused: naming one authority twice is
    // harmless, and a deployment assembling the list from several sources
    // should not fail for saying the same thing twice.
    if (!canonical.includes(rendered)) canonical.push(rendered);
  });

  return Object.freeze(canonical);
};

/**
 * Resolves the whole configuration.
 *
 * Pure and idempotent: it reads `options` and `process.env`, mutates nothing,
 * and resolving an already-resolved object returns the same values - a trimmed
 * host stays trimmed, an in-range port stays itself, and `path.resolve` of an
 * absolute path is that path - so both `createServer` and `start` may call it.
 *
 * `directory` and `repository` are deliberately **not** part of the result: they
 * are injection-only options, read straight off `options` by `createServer`.
 *
 * One cross-value rule lives here, because it is the only place both values are
 * known: **a bind wider than loopback must name its authorities.** A loopback
 * bind carries the implicit loopback authority set, so it needs no allowlist; a
 * wildcard or interface bind carries none, and serving every authority on a
 * published socket is precisely the exposure the authority gate exists to
 * prevent. Failing here rather than per request is deliberate - an operator who
 * widens the bind learns at startup, instead of from a server that binds
 * successfully and then refuses every request it receives.
 *
 * @param {{
 *   host?: string,
 *   port?: number|string,
 *   activitiesDataPath?: string,
 *   workbookDir?: string,
 *   allowedHosts?: string|readonly string[],
 *   maxPendingWrites?: number|string,
 *   maxActivitiesPerStudent?: number|string,
 *   maxRegistryRecords?: number|string,
 *   maxRegistryBytes?: number|string
 * }} [options] Overrides, highest precedence.
 * @returns {{
 *   host: string,
 *   port: number,
 *   activitiesDataPath: string,
 *   workbookDir: string,
 *   allowedHosts: readonly string[],
 *   maxPendingWrites: number,
 *   maxActivitiesPerStudent: number,
 *   maxRegistryRecords: number,
 *   maxRegistryBytes: number
 * }} The frozen, fully concrete configuration.
 * @throws {Error} With `code === 'SERVER_CONFIG_INVALID'` on any invalid value,
 *   naming the value. It throws rather than exiting: only the CLI wrapper turns
 *   a failure into process behaviour.
 */
const resolveConfig = (options) => {
  const source = options === undefined ? EMPTY_OPTIONS : options;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw createConfigError(
      `options must be an object of configuration overrides (received ${describeValue(source)})`
    );
  }

  const host = resolveHost(readOption(source, 'host', 'HOST'));
  const port = resolvePort(readOption(source, 'port', 'PORT'));
  const activitiesDataPath = resolveEntrypointPath(
    readOption(source, 'activitiesDataPath', 'ACTIVITIES_DATA_PATH'),
    DEFAULT_ACTIVITIES_DATA_PATH,
    'activitiesDataPath'
  );
  const workbookDir = resolveEntrypointPath(
    readOption(source, 'workbookDir', 'WORKBOOK_DIR'),
    DEFAULT_WORKBOOK_DIR,
    'workbookDir'
  );
  const allowedHosts = resolveAllowedHosts(readOption(source, 'allowedHosts', 'ALLOWED_HOSTS'));

  if (allowedHosts.length === 0 && !isLoopbackBind(host)) {
    throw createConfigError(
      `host ${quoteValue(host)} binds beyond loopback, so allowedHosts must name at least `
        + 'one authority this server answers for - set ALLOWED_HOSTS, for example '
        + `ALLOWED_HOSTS="app.example:${port}". A published socket that serves every `
        + 'authority is reachable by a rebound browser origin'
    );
  }

  // The four write-path ceilings, resolved at the same precedence as everything
  // above and defaulted from the module that enforces them. They travel to the
  // repository through `createServer`'s existing `{ ...config, directory }`
  // spread, so the composition root stays the only place they are read.
  const resolved = { host, port, activitiesDataPath, workbookDir, allowedHosts };
  LIMIT_KEYS.forEach((key) => {
    resolved[key] = resolveLimit(
      readOption(source, key, LIMIT_ENVIRONMENT_KEYS[key]),
      activityRepository.WRITE_LIMIT_DEFAULTS[key],
      key
    );
  });

  return Object.freeze(resolved);
};

/**
 * Abandons a request body this file chose not to interpret.
 *
 * A `405`, a `404` or a malformed-escape `400` is decided before any body is
 * read, and the contract for a request rejected that early is exact: the
 * response is written and **the request stream is destroyed**, so a client is
 * not left waiting for a drain that will not happen and an unbounded upload
 * cannot go on consuming socket time and event-loop work after the decision.
 *
 * The order below is what keeps both halves of that - the response delivered,
 * the body unread - true at once:
 *
 *   1. `'error'` is muted first, because destroying a stream the client is
 *      still writing to surfaces as `ECONNRESET` on the request, an event that
 *      carries no decision this file has not already taken.
 *   2. The stream is paused, so nothing here consumes another byte while the
 *      response leaves.
 *   3. The destroy waits for the response to **finish** and pauses again at
 *      that point. Destroying earlier resets a connection whose response the
 *      client has not read, and the reset discards it; and `http.Server` dumps
 *      an unread body of its own accord once the response finishes, which
 *      resumes the stream, so a single pause would let the whole upload drain -
 *      the very drain the contract forbids, wearing a destroy's clothes.
 *   4. The destroy itself is taken on the next event-loop turn, with the guards
 *      re-checked because the stream may have ended meanwhile.
 *
 * Only the bytes the kernel had already handed over before the decision are ever
 * read. The accepted cost is that a client still writing when it is refused may
 * see a reset instead of its response - on a connection that `Connection:
 * close`, declared by `sendError` on the same response, has already told it was
 * ending, so it waits for no drain and cannot pipeline behind an unread body.
 * The guards keep the call idempotent.
 *
 * @param {import('http').IncomingMessage} req The request to abandon.
 * @param {import('http').ServerResponse} res The response written before this
 *   call, waited on so the destroy cannot discard it.
 * @returns {void}
 */
const abandonRequest = (req, res) => {
  if (req.complete === true || req.destroyed === true) return;
  req.on('error', noop);
  req.pause();

  const abandon = () => {
    // Undoes the runtime's own dump of the unread body, which resumed the
    // stream when the response finished.
    req.pause();
    setImmediate(() => {
      if (req.complete === true || req.destroyed === true) return;
      req.destroy();
    });
  };

  if (res.writableFinished === true) {
    abandon();
    return;
  }
  res.once('finish', abandon);
};

const sendGreeting = (req, res) => {
  res.statusCode = STATUS_OK;
  res.setHeader('Content-Type', TEXT_MEDIA_TYPE);
  res.setHeader('Content-Length', GREETING_BYTE_LENGTH);
  if (req.method === METHOD_HEAD) {
    res.end();
    return;
  }
  res.end(GREETING);
};

/**
 * Writes an error in the one envelope the contract defines: exactly
 * `{"error":{"code":"...","message":"..."}}` - two keys and no more. Any
 * `extraHeaders` are merged into the response, and `Allow` is the only one used.
 *
 * `Connection: close` is declared because a connection whose request body was
 * never interpreted is not one to reuse: it keeps a keep-alive client from
 * pipelining a second request behind a body that was never read, which is what
 * makes abandoning that body after the response a safe teardown rather than a
 * lost answer.
 */
const sendError = (req, res, status, code, message, extraHeaders) => {
  const body = JSON.stringify({ error: { code, message } });
  const headers = {
    'Content-Type': JSON_MEDIA_TYPE,
    'Content-Length': Buffer.byteLength(body),
    Connection: 'close'
  };
  if (extraHeaders !== undefined) {
    Object.keys(extraHeaders).forEach((name) => {
      headers[name] = extraHeaders[name];
    });
  }

  res.writeHead(status, headers);
  if (req.method === METHOD_HEAD) {
    res.end();
  } else {
    res.end(body);
  }
  // Order matters: the response is written first, then the unread request body
  // is abandoned. Reversing the two would tear down the stream before the
  // answer had been handed to the socket.
  abandonRequest(req, res);
};

const sendMethodNotAllowed = (req, res, method, rawPath, allow) => {
  sendError(
    req,
    res,
    STATUS_METHOD_NOT_ALLOWED,
    CODE_METHOD_NOT_ALLOWED,
    `Method ${method} is not allowed on ${rawPath}`,
    { Allow: allow }
  );
};

const sendNotFound = (req, res, method, rawPath) => {
  sendError(
    req,
    res,
    STATUS_NOT_FOUND,
    CODE_NOT_FOUND,
    `No route for ${method} ${rawPath}`
  );
};

/**
 * `400 INVALID_STUDENT_ID` for an identifier segment that cannot even be
 * decoded. The message echoes the **raw, still-encoded** segment, because
 * printing a decoded value would echo back whatever escape the caller sent.
 *
 * The sentence is identical to the one `lib/activityRoutes.js` sends for an
 * identifier that decodes but fails `/^S\d{3}$/`, so a client sees one contract
 * whichever side of the boundary rejected the identifier.
 *
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response.
 * @param {string} rawValue The raw identifier segment.
 * @returns {void}
 */
const sendInvalidStudentId = (req, res, rawValue) => {
  sendError(
    req,
    res,
    STATUS_BAD_REQUEST,
    CODE_INVALID_STUDENT_ID,
    `Student ID must match S followed by three digits: ${truncate(rawValue)}`
  );
};

/**
 * Refuses a request whose authority this server does not answer for.
 *
 * Two outcomes, kept distinct because they are two different faults and an
 * operator reading a log needs to tell them apart. Both follow the split this
 * contract already draws between a value's **shape** and its **identity** -
 * `400 INVALID_STUDENT_ID` against `404 STUDENT_NOT_FOUND`:
 *
 *   - `400 INVALID_HOST` - the `Host` header is present but unusable: empty,
 *     duplicated, or not a parseable authority. RFC 9112 3.2 requires `400` for
 *     exactly these, and the runtime supplies it only for a header missing from
 *     an HTTP/1.1 request: an empty value reaches this handler as `''`, and a
 *     second `Host` header is neither rejected nor surfaced by
 *     `req.headers.host`, which reports only the first. Both were confirmed on
 *     the pinned runtime, so both are decided here.
 *   - `421 MISDIRECTED_REQUEST` - the authority parses and is simply not one
 *     this server answers for. This is the DNS-rebinding case.
 *
 * Both go through `sendError`, so both carry the same two-key envelope, declare
 * `Connection: close` - the connection is not one to reuse, and a keep-alive
 * client must not pipeline another request behind a refusal - and abandon the
 * request body unread, since the decision was taken before a byte of it was
 * interpreted.
 *
 * @param {import('http').IncomingMessage} req The request to refuse.
 * @param {import('http').ServerResponse} res The response to write.
 * @param {string} outcome `AUTHORITY_INVALID` or `AUTHORITY_MISDIRECTED`.
 * @returns {void}
 */
const sendAuthorityRejection = (req, res, outcome) => {
  if (outcome === AUTHORITY_INVALID) {
    sendError(req, res, STATUS_BAD_REQUEST, CODE_INVALID_HOST, MESSAGE_INVALID_HOST);
    return;
  }
  sendError(
    req,
    res,
    STATUS_MISDIRECTED_REQUEST,
    CODE_MISDIRECTED_REQUEST,
    MESSAGE_MISDIRECTED_REQUEST
  );
};

/* ---------------------------------------------------------------------------
 * The authority gate.
 *
 * It runs before the request target is parsed and before anything is
 * dispatched, so an authority this server does not answer for reaches no route,
 * no identifier lookup, no body reader and no write queue. Placing it first is
 * the whole point: a gate after dispatch would already have served the data.
 * ------------------------------------------------------------------------- */

/**
 * Builds the authority policy once, from the resolved configuration.
 *
 * Two parts, and a request is allowed if **either** admits it:
 *
 *   1. `boundPortHosts` - the implicit set a loopback bind answers for
 *      (`localhost`, `127.0.0.1`, `::1`, plus the resolved bind value itself,
 *      so `HOST=127.0.0.2` answers for `127.0.0.2`). Empty for any wider bind.
 *      A member of this set matches **only on the port actually bound**, which
 *      for an ephemeral run is the port the kernel chose rather than the `0`
 *      that was configured.
 *   2. `entries` - the explicit allowlist, already parsed and validated by
 *      `resolveAllowedHosts`, which applies whatever the bind is.
 *
 * @param {{host: string, port: number, allowedHosts: readonly string[]}} config
 *   The resolved configuration.
 * @returns {{
 *   boundPortHosts: readonly string[],
 *   entries: readonly {host: string, port: number|null}[],
 *   configuredPort: number
 * }} The frozen policy.
 */
const createAuthorityPolicy = ({ host, port, allowedHosts }) => {
  const boundPortHosts = [];
  if (isLoopbackBind(host)) {
    LOOPBACK_AUTHORITY_HOSTS.forEach((loopback) => boundPortHosts.push(loopback));
    // The bind value itself, normalized the same way a `Host` header is, so
    // `HOST=127.0.0.9` answers for `127.0.0.9` and a mixed-case or bracketed
    // value answers for its own spelling. A bare `::1` does not parse as an
    // authority - an unbracketed colon-bearing value never can - and needs no
    // entry, because the implicit set above already names it.
    const bound = parseAuthority(host);
    if (bound !== null && !boundPortHosts.includes(bound.host)) boundPortHosts.push(bound.host);
  }

  // `resolveAllowedHosts` already refused anything unparseable, so every entry
  // parses here; the map is a re-parse of canonical text, not a second policy.
  const entries = allowedHosts.map((entry) => parseAuthority(entry));

  return Object.freeze({
    boundPortHosts: Object.freeze(boundPortHosts),
    entries: Object.freeze(entries),
    configuredPort: port
  });
};

/**
 * Reads the request's `Host` header without assuming the request came off a
 * socket, so a handler invoked directly cannot turn a missing header bag into a
 * thrown error and a `500`.
 *
 * @param {import('http').IncomingMessage} req The request.
 * @returns {unknown} The header value, or `undefined` when there is none.
 */
const hostHeaderOf = (req) => {
  const headers = req.headers;
  if (headers === null || typeof headers !== 'object') return undefined;
  return headers.host;
};

/**
 * Counts the request's `Host` header lines.
 *
 * `req.headers.host` collapses duplicates to the first value, so the count has
 * to come from `req.rawHeaders`. It matters because two `Host` lines make the
 * authority ambiguous - this process would judge the first while anything else
 * reading the same bytes might take the second - and RFC 9112 3.2 requires such
 * a request to be refused.
 *
 * @param {import('http').IncomingMessage} req The request.
 * @returns {number} How many `Host` header lines arrived.
 */
const countHostHeaders = (req) => {
  const raw = req.rawHeaders;
  if (!Array.isArray(raw)) return typeof hostHeaderOf(req) === 'string' ? 1 : 0;

  let count = 0;
  for (let index = 0; index < raw.length; index += 2) {
    if (typeof raw[index] === 'string' && raw[index].toLowerCase() === 'host') count += 1;
  }
  return count;
};

/**
 * The port this request actually arrived on.
 *
 * Read from the socket rather than from the configuration, because the two
 * differ exactly where it matters: `PORT=0` resolves to `0` and binds whatever
 * the kernel chose, and comparing an authority against `0` would refuse every
 * request an ephemeral run received. The configured port is the fallback for
 * the case where the socket no longer reports one.
 *
 * @param {import('http').IncomingMessage} req The request.
 * @param {number} fallback The configured port.
 * @returns {number} The port the request arrived on.
 */
const boundPortOfRequest = (req, fallback) => {
  const socket = req.socket;
  if (socket !== null && socket !== undefined && Number.isInteger(socket.localPort)) {
    return socket.localPort;
  }
  return fallback;
};

/**
 * Whether the request's protocol version obliges it to carry a `Host` header.
 *
 * HTTP/1.1 and later require one (RFC 9112 3.2); HTTP/1.0 does not. A request
 * whose version cannot be read - a handler invoked directly rather than through
 * a socket - is treated as not obliged, because there is no wire format to be
 * non-conformant with.
 *
 * @param {import('http').IncomingMessage} req The request.
 * @returns {boolean} `true` when the header is mandatory.
 */
const requiresHostHeader = (req) => {
  const major = req.httpVersionMajor;
  const minor = req.httpVersionMinor;
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  return major > 1 || (major === 1 && minor >= 1);
};

/**
 * Decides one request's authority against the policy.
 *
 * The three outcomes turn on what the client asserted, not on what it wanted:
 *
 *   - **It asserted nothing.** No `Host` header at all, which only an HTTP/1.0
 *     client may send - the runtime refuses a header-less HTTP/1.1 request with
 *     its own `400` before this handler, verified on the pinned runtime. Such a
 *     request names no origin, so there is no origin to be misdirected from and
 *     nothing to compare: it is served under the server's own authority. This
 *     cannot be the rebinding vehicle, because a browser always sends `Host`
 *     and script cannot change it - `Host` is a forbidden header name - so
 *     every request the attack can produce takes one of the two branches below.
 *     A version at or above 1.1 arriving without the header is still refused,
 *     so the rule stays true even if the parser is ever run in lenient mode.
 *   - **It asserted something unusable** - an empty value, two `Host` lines, or
 *     text that is not an authority. Refused as `400`.
 *   - **It asserted an authority.** Served only if the policy answers for it;
 *     otherwise `421`.
 *
 * @param {ReturnType<typeof createAuthorityPolicy>} policy The policy.
 * @param {import('http').IncomingMessage} req The request.
 * @returns {string} `AUTHORITY_ALLOWED`, `AUTHORITY_INVALID` or
 *   `AUTHORITY_MISDIRECTED`.
 */
const decideAuthority = (policy, req) => {
  const hostHeaders = countHostHeaders(req);
  if (hostHeaders === 0) {
    return requiresHostHeader(req) ? AUTHORITY_INVALID : AUTHORITY_ALLOWED;
  }
  // Two `Host` lines make the authority ambiguous, which is unusable rather
  // than merely unrecognised.
  if (hostHeaders > 1) return AUTHORITY_INVALID;

  const authority = parseAuthority(hostHeaderOf(req));
  if (authority === null) return AUTHORITY_INVALID;

  // An authority that carries no port means the scheme's default, so a portless
  // `Host` matches a loopback bind only when the service really is on port 80.
  const port = authority.port === null ? DEFAULT_HTTP_PORT : authority.port;
  if (
    policy.boundPortHosts.includes(authority.host)
    && port === boundPortOfRequest(req, policy.configuredPort)
  ) {
    return AUTHORITY_ALLOWED;
  }

  const named = policy.entries.some((entry) => entry !== null
    && entry.host === authority.host
    && (entry.port === null || entry.port === authority.port));

  return named ? AUTHORITY_ALLOWED : AUTHORITY_MISDIRECTED;
};

const splitPathSegments = (pathText) => {
  const parts = pathText.split('/');
  if (parts[0] === '') parts.shift();
  return parts;
};

/**
 * Whether raw segments have the per-student route's shape. Used **only** for a
 * malformed percent-escape, where there are no decoded segments to match: it
 * decides whether the caller was addressing a student, and therefore whether the
 * path is recognised at all. A recognised path is then answered by method -
 * `405` with `Allow: GET, HEAD, POST` for a method the route does not serve, and
 * `400 INVALID_STUDENT_ID` for one it does - while an unrecognised path is
 * answered with `404 NOT_FOUND`.
 *
 * @param {string[]} segments The raw path segments.
 * @returns {boolean} `true` for `['api', 'students', '<id>', 'activities']`.
 */
const isStudentActivitiesShape = (segments) =>
  segments.length === STUDENT_ROUTE_SEGMENT_COUNT
  && segments[0] === API_SEGMENT
  && segments[1] === STUDENTS_SEGMENT
  && segments[3] === ACTIVITIES_SEGMENT;

/**
 * Parses the request target once.
 *
 * The raw target is deliberately **never** handed to `new URL()`. `req.url` is a
 * request target rather than a WHATWG URL, and `new URL()` resolves `../` and
 * `./`, which can make this router match one path while a downstream consumer
 * reads another (nodejs/node#51311). Matching is exact instead: no trailing-slash
 * normalization and no pattern engine.
 *
 * Decoding happens here and **exactly once**, so a doubly encoded identifier
 * such as `S%2530%2530%2531` - still `S%30%30%31` after this single decode - can
 * never be decoded a second time into something acceptable. A malformed escape
 * is reported as `segments === null` rather than thrown, and is answered by the
 * caller; it must never surface as a `500`.
 *
 * @param {import('http').IncomingMessage} req The request.
 * @returns {{method: string, rawPath: string, rawQuery: string, rawSegments: string[], segments: string[]|null}}
 *   The parsed target, with `segments === null` when a percent-escape is
 *   malformed.
 */
const parseRequestTarget = (req) => {
  const target = typeof req.url === 'string' ? req.url : ROOT_PATH;
  const queryAt = target.indexOf('?');
  const rawPath = queryAt === -1 ? target : target.slice(0, queryAt);
  const rawQuery = queryAt === -1 ? '' : target.slice(queryAt + 1);
  const rawSegments = splitPathSegments(rawPath);
  const method = typeof req.method === 'string' ? req.method : '';

  let segments = null;
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch (error) {
    // `decodeURIComponent` raises `URIError` and nothing else; anything else is
    // a genuine fault and is not this boundary's to absorb.
    if (!(error instanceof URIError)) throw error;
    segments = null;
  }

  return { method, rawPath, rawQuery, rawSegments, segments };
};

/**
 * Builds the `http.createServer` handler.
 *
 * Ownership, so that no status is produced in two places: the authority gate
 * runs first, before the target is parsed and before any route sees the request
 * (`400 INVALID_HOST` or `421 MISDIRECTED_REQUEST`, both answered here); `/` is
 * answered here (`GET` and `HEAD` return the greeting, any other method `405`
 * with `Allow: GET, HEAD`); a malformed percent-escape is answered here;
 * everything else is offered to the API handler, and the `false` it returns for
 * a path it does not recognise is answered here with the single `404 NOT_FOUND`.
 *
 * @param {(req: import('http').IncomingMessage, res: import('http').ServerResponse, route: {method: string, segments: string[], rawPath: string, query: URLSearchParams}) => boolean} apiHandler
 *   The handler built by `lib/activityRoutes.js`.
 * @param {ReturnType<typeof createAuthorityPolicy>} authorityPolicy The policy
 *   built by `createServer` from the resolved configuration. Required: this
 *   function is module-private and `createServer` is its only caller, so there
 *   is deliberately no default - a policy-less handler could only fail open.
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => void}
 *   The request handler.
 */
const createRequestHandler = (apiHandler, authorityPolicy) => (req, res) => {
  // The authority gate, first and unconditionally. A loopback bind keeps remote
  // packets out but not a rebound remote origin, whose requests arrive locally
  // and are refused here on the one field it cannot forge - and refused before
  // the target is parsed, so nothing downstream ever sees them.
  const authority = decideAuthority(authorityPolicy, req);
  if (authority !== AUTHORITY_ALLOWED) {
    sendAuthorityRejection(req, res, authority);
    return;
  }

  const { method, rawPath, rawQuery, rawSegments, segments } = parseRequestTarget(req);

  if (rawPath === ROOT_PATH) {
    if (method === METHOD_GET || method === METHOD_HEAD) {
      sendGreeting(req, res);
      return;
    }
    sendMethodNotAllowed(req, res, method, rawPath, ALLOW_ROOT);
    return;
  }

  // A malformed escape leaves nothing to match on, so the raw shape decides
  // between a client addressing a student and a client addressing nothing, and
  // it is the path recognition that precedes the method check: `DELETE` here is
  // a `405` naming what works, and only a method the route serves gets the `400`
  // that reports the undecodable identifier.
  if (segments === null) {
    if (isStudentActivitiesShape(rawSegments)) {
      if (method !== METHOD_GET && method !== METHOD_HEAD && method !== METHOD_POST) {
        sendMethodNotAllowed(req, res, method, rawPath, ALLOW_STUDENT_ACTIVITIES);
        return;
      }
      sendInvalidStudentId(req, res, rawSegments[STUDENT_ID_SEGMENT_INDEX]);
      return;
    }
    sendNotFound(req, res, method, rawPath);
    return;
  }

  const route = { method, segments, rawPath, query: new URLSearchParams(rawQuery) };
  if (apiHandler(req, res, route)) return;

  sendNotFound(req, res, method, rawPath);
};

/**
 * Builds the server: the **single composition root** of the feature.
 *
 * This is the only place anything is constructed, so the workbooks are read
 * exactly once per server construction. Nothing is cached across servers, so a
 * second `createServer()` or `start()` in the same process runs the loaders
 * again - deliberately, because per-instance state is what lets one process
 * hold two servers over different data. `resolveConfig` runs first because it
 * is also what validates `options` as an object before any property of it is
 * read.
 *
 * Because each dependency is built only when it is not injected, the filesystem
 * reads follow from the injection itself rather than from a separate probe:
 * neither injected reads both workbooks and the registry, `directory` alone
 * leaves the activity workbook and the registry, `repository` alone leaves the
 * directory workbook, and **both injected reads nothing at all** - so
 * `workbookDir` and `activitiesDataPath` may then name paths that do not exist.
 * That is why there is deliberately no eager `existsSync`/`accessSync` here.
 *
 * @param {{
 *   host?: string,
 *   port?: number|string,
 *   activitiesDataPath?: string,
 *   workbookDir?: string,
 *   allowedHosts?: string|readonly string[],
 *   maxPendingWrites?: number|string,
 *   maxActivitiesPerStudent?: number|string,
 *   maxRegistryRecords?: number|string,
 *   maxRegistryBytes?: number|string,
 *   directory?: object,
 *   repository?: object
 * }} [options] Configuration overrides plus the two injection seams. An
 *   injected `repository` brings its own ceilings, so the four `max…` values
 *   are resolved either way but reach a repository only when this file builds
 *   one.
 * @returns {import('http').Server} A **non-listening** server, carrying the
 *   resolved configuration as the read-only property `server.config`.
 * @throws {Error} Synchronously, with `code === 'SERVER_CONFIG_INVALID'` for a
 *   configuration fault, or the loader's own error - `STUDENT_DIRECTORY_INVALID`,
 *   `ACTIVITY_REPOSITORY_INVALID`, `WORKBOOK_READ_FAILED` - for a load fault.
 *   It never listens, so it cannot produce a bind error at all.
 */
const createServer = (options) => {
  const source = options === undefined ? EMPTY_OPTIONS : options;

  const config = resolveConfig(source);
  const directory = source.directory ?? studentDirectory.load(config);
  const repository = source.repository ?? activityRepository.load({ ...config, directory });
  const apiHandler = activityRoutes.create({ directory, repository });

  // The authority policy is derived from the resolved configuration, so it is
  // fixed for the life of the server and computed once rather than per request.
  const server = http.createServer(
    createRequestHandler(apiHandler, createAuthorityPolicy(config))
  );

  // Read-only, because `start` reads its bind arguments from here and must
  // neither re-resolve nor mutate anything.
  Object.defineProperty(server, 'config', {
    value: config,
    writable: false,
    enumerable: true,
    configurable: false
  });

  return server;
};

const boundPortOf = (server, fallback) => {
  const address = server.address();
  if (address !== null && typeof address === 'object' && typeof address.port === 'number') {
    return address.port;
  }
  return fallback;
};

/**
 * Renders a resolved host as the **authority component of a URL**, which for an
 * IPv6 literal means bracketing it.
 *
 * `resolveHost` accepts any non-empty host, `::1` included, and `listen` must
 * receive that value exactly as configured - so the bracketing lives here, in
 * the banner only, and never on the path to `listen`. Without it the readiness
 * line reads `http://::1:3000/`, which `new URL()` rejects as an invalid URL and
 * no client can use.
 *
 * An IPv6 literal is recognised by the colon it must contain, which neither a
 * hostname nor an IPv4 address carries; a value that is already bracketed is
 * returned unchanged, so `[::1]` does not become `[[::1]]`.
 *
 * @param {string} host The resolved host, exactly as it will be bound.
 * @returns {string} The URL authority host: `127.0.0.1` unchanged, `::1` as
 *   `[::1]`.
 */
const bannerAuthority = (host) => {
  if (!host.includes(':')) return host;
  if (host.startsWith('[') && host.endsWith(']')) return host;
  return `[${host}]`;
};

/**
 * Builds the readiness line for a listening server.
 *
 * Built from the resolved host and the port **actually bound**, so the default
 * case reads exactly `Server running at http://127.0.0.1:3000/` while an
 * ephemeral run reports the port it got rather than the `0` it asked for.
 *
 * It only formats: writing it is the `require.main === module` wrapper's job, so
 * a programmatic `start()` stays silent.
 *
 * @param {import('http').Server} server A listening server carrying `config`.
 * @returns {string} The banner line, without a trailing newline.
 */
const readinessBanner = (server) => {
  const { host, port } = server.config;
  return `Server running at http://${bannerAuthority(host)}:${boundPortOf(server, port)}/`;
};

/**
 * Rewrites a bind failure's message so a conflict reads as a conflict, naming
 * the code and the exact address and port that could not be bound.
 *
 * The error object itself is preserved - `code`, `errno`, `syscall` and the
 * stack all survive - so a caller can still match on `code === 'EADDRINUSE'`.
 * The non-enumerable `server` property is attached so a caller can inspect or
 * close the server whose bind failed; non-enumerable, so inspecting the error
 * does not dump a whole server object.
 *
 * @param {unknown} cause The failure the server emitted.
 * @param {string} host The host that was being bound.
 * @param {number} port The port that was being bound.
 * @param {import('http').Server} server The server that failed to bind.
 * @returns {Error} The annotated error, ready to reject with.
 */
const describeBindFailure = (cause, host, port, server) => {
  const failure = cause instanceof Error ? cause : new Error(String(cause));
  const code = typeof failure.code === 'string' && failure.code !== ''
    ? failure.code
    : UNKNOWN_ERROR_CODE;

  failure.message = `Cannot listen on ${host}:${port} (${code}): ${failure.message}`;
  Object.defineProperty(failure, 'server', {
    value: server,
    writable: false,
    enumerable: false,
    configurable: true
  });

  return failure;
};

/**
 * Builds the server and starts listening.
 *
 * `'error'` and `'listening'` are attached as **one-shot** listeners immediately
 * before `listen`, and whichever fires first settles the promise; both are
 * removed once it has settled, so a later error can neither try to re-settle an
 * already-settled promise nor be swallowed by a handler that outlived its
 * purpose. After startup, server errors are observable where they belong - on
 * the returned server, for the caller to handle.
 *
 * It never calls `process.exit` and writes **nothing to stdout**: a
 * configuration or load fault throws synchronously out of `createServer`, a
 * bind fault rejects, and the readiness banner is the CLI's signal rather than
 * the library's. Only the `require.main === module` wrapper turns a failure into
 * process behaviour or writes the banner, which keeps a programmatic caller
 * silent and promise settlement free of any console side effect.
 *
 * @param {Parameters<typeof createServer>[0]} [options] As `createServer`.
 * @returns {Promise<import('http').Server>} Resolves with the **listening**
 *   server once it is bound.
 * @throws {Error} Synchronously, for a configuration or load fault.
 */
const start = (options) => {
  const server = createServer(options);
  const { host, port } = server.config;

  return new Promise((resolve, reject) => {
    const settle = () => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
    };

    const onListening = () => {
      settle();
      resolve(server);
    };

    const onError = (error) => {
      settle();
      reject(describeBindFailure(error, host, port, server));
    };

    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(port, host);
  });
};

/**
 * Writes one diagnostic line and marks the process failed - the **only** place
 * in the module where a failure becomes process behaviour.
 *
 * `process.exitCode` is set rather than `process.exit` called, so pending writes
 * to stderr are not truncated by an immediate exit.
 *
 * **The whole detail is neutralized before it is written** (CWE-117). It is not
 * a fixed sentence: a configuration failure interpolates the rejected `PORT`,
 * `HOST`, `ACTIVITIES_DATA_PATH` or `WORKBOOK_DIR` value, and a load failure
 * interpolates a path or a registry record, so environment-supplied text reaches
 * this sink verbatim. `sanitizeForLog` escapes every control, format,
 * bidirectional and line-separator code point to its visible spelling, so a
 * value carrying ESC cannot repaint the operator's terminal, one carrying
 * U+202E cannot reorder the sentence that rejected it, and one carrying CR or LF
 * cannot forge a second record.
 *
 * Escaping runs **before** the whitespace collapse, in that order and not the
 * reverse: escaping first means CR, LF and TAB survive the record as `\u000d`,
 * `\u000a` and `\u0009` - visible evidence of what was configured - while the
 * collapse then reduces runs of ordinary spaces so the line stays deterministic.
 * Collapsing first would erase that evidence, and neither step alone is enough:
 * the collapse cannot neutralize a control character (ESC and every bidi control
 * are non-whitespace), and escaping does not by itself make a multi-space value
 * render identically every run.
 *
 * @param {unknown} error The configuration, load or bind failure.
 * @returns {void}
 */
const reportStartupFailure = (error) => {
  const detail = error instanceof Error && typeof error.message === 'string'
    ? error.message
    : String(error);
  process.stderr.write(`server.js: ${sanitizeForLog(detail).replace(/\s+/g, ' ')}\n`);
  process.exitCode = EXIT_FAILURE;
};

module.exports = { resolveConfig, createServer, start };

// Nothing listens and nothing is written to stdout unless this file is the
// process entry point, which is what lets a caller start and close servers
// in-process, on an ephemeral port, with injected dependencies.
//
// This wrapper is the only place the module writes to either standard stream:
// the readiness banner on success, one diagnostic line plus a non-zero exit code
// on failure. The banner is printed here rather than inside `start` so the
// library entry point stays silent, and the `.catch` stays last so a bind
// rejection is still mapped to that diagnostic line.
if (require.main === module) {
  try {
    start()
      .then((server) => {
        console.log(readinessBanner(server));
      })
      .catch(reportStartupFailure);
  } catch (error) {
    reportStartupFailure(error);
  }
}
