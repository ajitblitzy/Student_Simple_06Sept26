'use strict';

/**
 * server.js - the service entrypoint, the HTTP dispatcher and the single
 * composition root of the extracurricular-activity feature.
 *
 * WHAT CHANGED, AND WHAT DELIBERATELY DID NOT
 * ---------------------------------------------------------------------------
 * The scanned baseline was fourteen lines: it required Node's built-in `http`
 * module, held a loopback host and port 3000 as fixed constants, answered one
 * 34-byte plain-text greeting to every method on every path from a handler that
 * declared `req` and never dereferenced it, and called `listen` during module
 * evaluation while exporting nothing. This file extends that one real extension
 * point - the request handler - rather than replacing the file:
 *
 *   1. The handler became a **dispatcher**: it owns `/` and the single
 *      `404 NOT_FOUND` fallback and delegates everything else to
 *      `lib/activityRoutes.js`.
 *   2. The two constants became **defaults** inside `resolveConfig`, which adds
 *      the repository's first `process.env` reads. The reason is testability:
 *      the suite binds an ephemeral port and writes its registry file outside
 *      the working tree.
 *   3. `listen` moved behind a `require.main === module` check, and
 *      `resolveConfig`, `createServer` and `start` are exported, so the routes
 *      can be exercised in-process with injected dependencies.
 *
 * Everything the scan established is kept: the built-in `http` module with **no
 * framework**, CommonJS `require`/`module.exports` with no ESM anywhere, the
 * loopback default `127.0.0.1`, port `3000`, **zero runtime dependencies**, and
 * a root-level entrypoint. Declined on purpose, because nothing here needs them:
 * signal handlers and graceful shutdown, per-request logging, metrics, tracing,
 * request timeouts, authentication, TLS and CORS.
 *
 * THE ONE PRESERVED GUARANTEE
 * ---------------------------------------------------------------------------
 * `GET /` still answers `200`, `Content-Type: text/plain` and the body
 * `Hello, World Welcome to Sharebot!\n` - 34 bytes, byte for byte. That was the
 * only externally observable contract the repository made, so it survives
 * intact, including the "Sharebot" name that disagrees with the project name.
 * What this feature intentionally narrows is the *uniformity* around it: a
 * non-`GET`/`HEAD` method on `/` is now `405` with an `Allow` header, and an
 * unrecognised path is now `404`, because method-aware routing is the point.
 *
 * THE ROUTING BOUNDARY
 * ---------------------------------------------------------------------------
 * This file parses the request target exactly once and hands one object down:
 *
 *   { method, segments, rawPath, query }
 *
 * `segments` is the path split on `/` with the leading empty element dropped and
 * **each segment percent-decoded exactly once**; `rawPath` is the target with
 * the query removed and is used only for error messages; `query` is a
 * `URLSearchParams` over the raw query text. `lib/activityRoutes.js` reads those
 * four properties, never decodes again, and returns `true` when it has written a
 * response or `false` for a path it does not recognise - and this file writes the
 * one `404 NOT_FOUND` for every such path, so no status is produced twice.
 *
 * ERROR HANDLING IS SPLIT BY CALLER
 * ---------------------------------------------------------------------------
 *   - `createServer` **throws synchronously** on a configuration or load
 *     failure. It never listens, so it cannot produce a bind error at all.
 *   - `start` **rejects** on a bind failure and never calls `process.exit`;
 *     after startup, server errors stay observable on the returned server.
 *   - The `require.main === module` wrapper is the **only** place a failure
 *     becomes process behaviour: one stderr line and a non-zero exit code.
 *
 * @example <caption>Run it</caption>
 * // node server.js   ->  Server running at http://127.0.0.1:3000/
 *
 * @example <caption>Exercise it in-process on an ephemeral port</caption>
 * const { start } = require('./server');
 * const server = await start({ port: 0, directory, repository });
 * // ... requests against server.address().port ...
 * await new Promise((resolve) => server.close(resolve));
 */

const http = require('http');
const path = require('node:path');

const studentDirectory = require('./lib/studentDirectory');
const activityRepository = require('./lib/activityRepository');
const activityRoutes = require('./lib/activityRoutes');

/* ---------------------------------------------------------------------------
 * Baseline literals, kept as defaults rather than as fixed constants.
 * ------------------------------------------------------------------------- */

/**
 * The loopback default from baseline line 3. This feature does **not** widen
 * the binding: setting `HOST=0.0.0.0` publishes a service that authenticates
 * nobody, which is why the default stays here and the README carries the
 * warning instead.
 */
const DEFAULT_HOST = '127.0.0.1';

/** The default port from baseline line 4. */
const DEFAULT_PORT = 3000;

/** The appendable activity registry, resolved against this file's directory. */
const DEFAULT_ACTIVITIES_FILENAME = 'activities.json';

/**
 * Baseline line 9, byte for byte - the repository's only pre-existing response
 * contract. The trailing newline is part of it.
 */
const GREETING = 'Hello, World Welcome to Sharebot!\n';

/**
 * 34. Derived from `GREETING` rather than written as a literal, so the declared
 * `Content-Length` can never drift from the bytes actually sent.
 */
const GREETING_BYTE_LENGTH = Buffer.byteLength(GREETING);

/* ---------------------------------------------------------------------------
 * Wire-level constants.
 * ------------------------------------------------------------------------- */

/** The greeting's media type, from baseline line 8. */
const TEXT_MEDIA_TYPE = 'text/plain';

/** The media type of every error this file writes. */
const JSON_MEDIA_TYPE = 'application/json';

/** The only path this file serves itself, matched by exact string equality. */
const ROOT_PATH = '/';

/** `Allow` for `/`: exact and ordered, because a `405` must name what works. */
const ALLOW_ROOT = 'GET, HEAD';

const METHOD_GET = 'GET';
const METHOD_HEAD = 'HEAD';

const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_NOT_FOUND = 404;
const STATUS_METHOD_NOT_ALLOWED = 405;

const CODE_INVALID_STUDENT_ID = 'INVALID_STUDENT_ID';
const CODE_METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED';
const CODE_NOT_FOUND = 'NOT_FOUND';

/**
 * The per-student route's shape, mirrored from `lib/activityRoutes.js`. It is
 * needed here for exactly one case: a malformed percent-escape cannot be decoded
 * into `segments`, so the *raw* segments decide whether the caller was addressing
 * a student (`400 INVALID_STUDENT_ID`) or nothing at all (`404 NOT_FOUND`).
 */
const API_SEGMENT = 'api';
const STUDENTS_SEGMENT = 'students';
const ACTIVITIES_SEGMENT = 'activities';
const STUDENT_ROUTE_SEGMENT_COUNT = 4;
const STUDENT_ID_SEGMENT_INDEX = 2;

/* ---------------------------------------------------------------------------
 * Configuration constants.
 * ------------------------------------------------------------------------- */

/**
 * A port is validated as a **whole string** before conversion.
 * `Number.parseInt` alone is wrong here: it reads `'1.5'` as `1` and
 * `'3000abc'` as `3000`, silently binding a port the operator never asked for.
 */
const PORT_TEXT_PATTERN = /^\d{1,5}$/;

/** `0` is preserved and means "ephemeral port" - the in-process tests need it. */
const MIN_PORT = 0;
const MAX_PORT = 65535;

/** How long a caller-supplied value may be inside a message. */
const MAX_MESSAGE_VALUE_LENGTH = 64;

/** The stable discriminator on every configuration failure this file raises. */
const CONFIG_ERROR_CODE = 'SERVER_CONFIG_INVALID';

/** Stands in for a bind failure that carries no `code` of its own. */
const UNKNOWN_ERROR_CODE = 'EUNKNOWN';

/** The exit code the CLI wrapper sets when startup fails. */
const EXIT_FAILURE = 1;

/** Shared empty options, so `createServer()` and `createServer({})` are one path. */
const EMPTY_OPTIONS = Object.freeze({});

/** The resolved defaults for the two path options, both already absolute. */
const DEFAULT_ACTIVITIES_DATA_PATH = path.join(__dirname, DEFAULT_ACTIVITIES_FILENAME);
const DEFAULT_WORKBOOK_DIR = __dirname;

/** Swallows an event that carries no decision - used for a drained request. */
const noop = () => {};

/* ---------------------------------------------------------------------------
 * Small pure helpers.
 * ------------------------------------------------------------------------- */

/**
 * Describes a value's type for an error message without printing the value,
 * which is what keeps a message deterministic when the value is an object.
 *
 * @param {unknown} value The value to describe.
 * @returns {string} A short type description.
 */
const describeValue = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a value of type ${typeof value}`;
};

/**
 * Bounds a caller-supplied value before it is interpolated into a message, so a
 * pathological value cannot become the message.
 *
 * @param {unknown} value The value to interpolate.
 * @returns {string} The value as a string, at most 64 characters long.
 */
const truncate = (value) => {
  const text = typeof value === 'string' ? value : String(value === undefined ? '' : value);
  return text.length > MAX_MESSAGE_VALUE_LENGTH
    ? text.slice(0, MAX_MESSAGE_VALUE_LENGTH)
    : text;
};

/**
 * Quotes a rejected configuration value so it is visible in the message even
 * when it is the empty string - `PORT=` must read as a named value, not as a
 * sentence that trails off.
 *
 * @param {unknown} value The offending value.
 * @returns {string} The value, truncated and wrapped in double quotes.
 */
const quoteValue = (value) => `"${truncate(value)}"`;

/**
 * Builds a fatal configuration error. Configuration faults **throw**; only the
 * CLI wrapper turns a throw into process behaviour.
 *
 * @param {string} summary The one-sentence diagnosis, naming the value.
 * @returns {Error} The error, carrying `code === 'SERVER_CONFIG_INVALID'`.
 */
const createConfigError = (summary) => {
  const error = new Error(summary);
  error.code = CONFIG_ERROR_CODE;
  return error;
};

/* ---------------------------------------------------------------------------
 * Configuration resolution.
 *
 * Precedence for every value: an explicit `options` property, then the
 * environment variable, then the literal the scanned file carried.
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
 * Resolves the whole configuration.
 *
 * Pure and idempotent: it reads `options` and `process.env`, mutates nothing,
 * and resolving an already-resolved object returns the same values - a trimmed
 * host stays trimmed, an in-range port stays itself, and `path.resolve` of an
 * absolute path is that path. Both `createServer` and `start` therefore may call
 * it, and a test may assert it directly.
 *
 * `directory` and `repository` are deliberately **not** part of the result: they
 * are injection-only options, read straight off `options` by `createServer`.
 *
 * @param {{
 *   host?: string,
 *   port?: number|string,
 *   activitiesDataPath?: string,
 *   workbookDir?: string
 * }} [options] Overrides, highest precedence.
 * @returns {{host: string, port: number, activitiesDataPath: string, workbookDir: string}}
 *   The frozen, fully concrete configuration.
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

  return Object.freeze({ host, port, activitiesDataPath, workbookDir });
};

/* ---------------------------------------------------------------------------
 * Writing a response.
 *
 * Only two shapes are written here - the preserved greeting and the JSON error
 * envelope - so both live in one place and cannot drift.
 * ------------------------------------------------------------------------- */

/**
 * Drains a request body this file chose not to interpret.
 *
 * A `405` or a `404` is decided before any body is read, and a client may still
 * be uploading one. Destroying the request would reset the connection and
 * discard the response just written, so the request is put into flowing mode
 * with no consumer instead: the upload completes, the drain genuinely happens,
 * and the response survives. `'error'` is muted first so an upload the client
 * abandons mid-drain does not surface as an unhandled event. This mirrors
 * `lib/activityRoutes.js`, where the behaviour was measured.
 *
 * @param {import('http').IncomingMessage} req The request to drain.
 * @returns {void}
 */
const drainRequest = (req) => {
  if (req.complete === true) return;
  req.on('error', noop);
  req.resume();
};

/**
 * Writes the preserved greeting - the implementation of baseline lines 7-9,
 * unchanged apart from an explicit `Content-Length` and the `HEAD` suppression.
 *
 * `Content-Length` is set rather than left to `res.end()` so the declared length
 * does not depend on what the body argument happens to be, which is what makes
 * `HEAD /` truthful: the same status and the same headers as the `GET`,
 * `Content-Length: 34` included, with **zero body bytes** written.
 *
 * @param {import('http').IncomingMessage} req The request, read for its method.
 * @param {import('http').ServerResponse} res The response to write.
 * @returns {void}
 */
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
 * `{"error":{"code":"...","message":"..."}}` - two keys and no more.
 *
 * `Connection: close` is declared because a connection whose request body was
 * never interpreted is not one to reuse; it keeps a keep-alive client from
 * pipelining a second request behind a body that was discarded.
 *
 * @param {import('http').IncomingMessage} req The request to answer and drain.
 * @param {import('http').ServerResponse} res The response to write.
 * @param {number} status The HTTP status code.
 * @param {string} code The stable error code.
 * @param {string} message The fixed sentence for that code.
 * @param {Record<string, string|number>} [extraHeaders] Headers to merge in -
 *   `Allow` is the only one used.
 * @returns {void}
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
  drainRequest(req);
};

/**
 * `405` for a recognised path on an unsupported method, with the exact `Allow`.
 *
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response.
 * @param {string} method The request method, verbatim.
 * @param {string} rawPath The query-stripped raw request target.
 * @param {string} allow The exact, ordered `Allow` header value.
 * @returns {void}
 */
const sendMethodNotAllowed = (req, res, method, rawPath, allow) => {
  sendError(
    req,
    res,
    STATUS_METHOD_NOT_ALLOWED,
    CODE_METHOD_NOT_ALLOWED,
    `Method ${method} is not allowed on ${truncate(rawPath)}`,
    { Allow: allow }
  );
};

/**
 * The single `404 NOT_FOUND` for every unrecognised path, wherever it came
 * from - a path this file does not own, or one `lib/activityRoutes.js` declined
 * by returning `false`, whether or not it began with `api`.
 *
 * The path is rendered from the **raw** target with the query removed, so
 * `/api/unknown?x=1` reads `No route for GET /api/unknown`.
 *
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response.
 * @param {string} method The request method, verbatim.
 * @param {string} rawPath The query-stripped raw request target.
 * @returns {void}
 */
const sendNotFound = (req, res, method, rawPath) => {
  sendError(
    req,
    res,
    STATUS_NOT_FOUND,
    CODE_NOT_FOUND,
    `No route for ${method} ${truncate(rawPath)}`
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

/* ---------------------------------------------------------------------------
 * The dispatcher.
 * ------------------------------------------------------------------------- */

/**
 * Splits a path on `/` and drops the leading empty element, so `/api/activities`
 * becomes `['api', 'activities']`. Applied identically to the decoded and the
 * raw path, which is what keeps the two arrays' indexes aligned - the contract
 * `lib/activityRoutes.js` relies on to recover a raw identifier.
 *
 * @param {string} pathText The path to split.
 * @returns {string[]} The segments.
 */
const splitPathSegments = (pathText) => {
  const parts = pathText.split('/');
  if (parts[0] === '') parts.shift();
  return parts;
};

/**
 * Whether raw segments have the per-student route's shape. Used **only** for a
 * malformed percent-escape, where there are no decoded segments to match: it
 * decides whether the caller was addressing a student, and therefore whether the
 * answer is `400 INVALID_STUDENT_ID` or `404 NOT_FOUND`.
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
 * normalization, no pattern engine - four exact routes need neither.
 *
 * Decoding happens here and **exactly once**. Domain modules receive decoded
 * segments and only trim and case-fold, so a doubly encoded identifier such as
 * `S%2530%2530%2531` - still `S%30%30%31` after this single decode - can never be
 * decoded a second time into something acceptable. A malformed escape is
 * reported as `segments === null` rather than thrown, and is answered by the
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
 * Builds the `http.createServer` handler - the dispatcher that replaced the
 * baseline's single unconditional response.
 *
 * Ownership, so that no status is produced in two places:
 *
 *   - `/` is answered **here**: `GET` and `HEAD` return the preserved greeting,
 *     any other method returns `405` with `Allow: GET, HEAD`.
 *   - A malformed percent-escape is answered **here**, per the shape above.
 *   - Everything else is offered to the API handler, which writes a response and
 *     returns `true`, or returns `false` for a path it does not recognise.
 *   - A `false` return is answered **here** with the single `404 NOT_FOUND`.
 *
 * @param {(req: import('http').IncomingMessage, res: import('http').ServerResponse, route: {method: string, segments: string[], rawPath: string, query: URLSearchParams}) => boolean} apiHandler
 *   The handler built by `lib/activityRoutes.js`.
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => void}
 *   The request handler.
 */
const createRequestHandler = (apiHandler) => (req, res) => {
  const { method, rawPath, rawQuery, rawSegments, segments } = parseRequestTarget(req);

  // `/` - the one path this file serves itself, matched by string equality on
  // the query-stripped target, so `/?x=1` is still the root.
  if (rawPath === ROOT_PATH) {
    if (method === METHOD_GET || method === METHOD_HEAD) {
      sendGreeting(req, res);
      return;
    }
    sendMethodNotAllowed(req, res, method, rawPath, ALLOW_ROOT);
    return;
  }

  // A malformed escape: there is nothing to match on, so the raw shape decides
  // between a client addressing a student and a client addressing nothing.
  if (segments === null) {
    if (isStudentActivitiesShape(rawSegments)) {
      sendInvalidStudentId(req, res, rawSegments[STUDENT_ID_SEGMENT_INDEX]);
      return;
    }
    sendNotFound(req, res, method, rawPath);
    return;
  }

  // The boundary object, and the only four properties the API handler reads.
  const route = { method, segments, rawPath, query: new URLSearchParams(rawQuery) };
  if (apiHandler(req, res, route)) return;

  sendNotFound(req, res, method, rawPath);
};

/* ---------------------------------------------------------------------------
 * The composition root and the lifecycle.
 * ------------------------------------------------------------------------- */

/**
 * Builds the server: the **single composition root** of the feature.
 *
 * This is the only place anything is constructed, so the workbooks are read
 * exactly once per process and a test that injects dependencies exercises the
 * same wiring production uses.
 *
 * Because each dependency is built only when it is not injected, the filesystem
 * checks follow from the injection itself rather than from a separate probe:
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
 *   directory?: object,
 *   repository?: object
 * }} [options] Configuration overrides plus the two injection seams.
 * @returns {import('http').Server} A **non-listening** server, carrying the
 *   resolved configuration as the read-only property `server.config`.
 * @throws {Error} Synchronously, with `code === 'SERVER_CONFIG_INVALID'` for a
 *   configuration fault, or the loader's own error - `STUDENT_DIRECTORY_INVALID`,
 *   `ACTIVITY_REPOSITORY_INVALID`, `WORKBOOK_READ_FAILED` - for a load fault.
 *   It never listens, so it cannot produce a bind error at all.
 */
const createServer = (options) => {
  const source = options === undefined ? EMPTY_OPTIONS : options;

  // Resolved first: it is also what validates `source` as an object, before any
  // property of it is read.
  const config = resolveConfig(source);
  const directory = source.directory ?? studentDirectory.load(config);
  const repository = source.repository ?? activityRepository.load({ ...config, directory });
  const apiHandler = activityRoutes.create({ directory, repository });

  const server = http.createServer(createRequestHandler(apiHandler));

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

/**
 * The port actually bound, which is what makes the banner truthful for an
 * ephemeral run.
 *
 * @param {import('http').Server} server The listening server.
 * @param {number} fallback The configured port, used only if the address is
 *   unavailable.
 * @returns {number} The bound port.
 */
const boundPortOf = (server, fallback) => {
  const address = server.address();
  if (address !== null && typeof address === 'object' && typeof address.port === 'number') {
    return address.port;
  }
  return fallback;
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
 * It never calls `process.exit`: a configuration or load fault **throws
 * synchronously** out of `createServer`, a bind fault **rejects**, and only the
 * `require.main === module` wrapper turns either into process behaviour.
 *
 * @param {Parameters<typeof createServer>[0]} [options] As `createServer`.
 * @returns {Promise<import('http').Server>} Resolves with the **listening**
 *   server once it is bound, having logged the startup banner.
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
      // The baseline banner, unchanged in string and format, and still the
      // readiness signal - emitted from the resolved host and the port actually
      // bound, so an ephemeral run reports what it got.
      console.log(`Server running at http://${host}:${boundPortOf(server, port)}/`);
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
 * Writes one diagnostic line and marks the process failed. This is the **only**
 * place in the module where a failure becomes process behaviour, and it replaces
 * the baseline's misleading unhandled `'error'` event.
 *
 * `process.exitCode` is set rather than `process.exit` called, so pending writes
 * to stderr are not truncated by an immediate exit.
 *
 * @param {unknown} error The configuration, load or bind failure.
 * @returns {void}
 */
const reportStartupFailure = (error) => {
  const detail = error instanceof Error && typeof error.message === 'string'
    ? error.message
    : String(error);
  process.stderr.write(`server.js: ${detail.replace(/\s+/g, ' ')}\n`);
  process.exitCode = EXIT_FAILURE;
};

module.exports = { resolveConfig, createServer, start };

// Requiring this module has no side effect: nothing listens and no port is
// bound unless this file is the process entry point. That reversal of the
// baseline's start-on-import lifecycle is what lets the suite start and close
// servers in-process, on an ephemeral port, with injected dependencies.
if (require.main === module) {
  try {
    start().catch(reportStartupFailure);
  } catch (error) {
    reportStartupFailure(error);
  }
}
