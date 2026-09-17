'use strict';

/**
 * lib/activityRoutes.js - the HTTP-facing half of the extracurricular activity
 * feature: the module that makes a response depend on the request.
 *
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * The code scan that opened this work found a handler that declares `req` and
 * never dereferences it, answering one fixed 34-byte plain-text body to every
 * method on every path. There was no routing, no method dispatch, no path
 * parsing, no query handling and no body reading anywhere in the repository.
 * All of that is genuinely new functionality, and this file is where it lives.
 *
 * It is its own module, rather than more code inside the entrypoint, for two
 * reasons: `server.js` stays a thin entrypoint and composition root, and this
 * handler is testable as a plain function against an injected context - no
 * socket, no workbook and no filesystem required to assert a status or a body.
 *
 * WHAT IT OWNS, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * Owned here - the three JSON routes and every status they can produce:
 *
 *   GET  | HEAD  /api/students/{studentId}/activities  -> 200
 *   POST         /api/students/{studentId}/activities  -> 201 + Location
 *   GET  | HEAD  /api/activities[?activity=NAME]       -> 200
 *
 * ...together with their failures: 400 (identifier shape, malformed JSON,
 * unexpected field, invalid activity), 404 (unknown student), 405 with an exact
 * `Allow` header, 409 (already recorded), 413, 415 and 500.
 *
 * Owned by `server.js`, and deliberately not duplicated here, because no status
 * may be produced in two places: the `/` greeting and its own `405`, the single
 * `404 NOT_FOUND` fallback for every unrecognised path, the `URIError` catch for
 * a malformed percent-escape, and the startup banner. This module signals "not
 * mine" by **returning `false`** and writing nothing at all - which is what
 * keeps unknown-path handling in exactly one place and keeps that `false`
 * return reachable.
 *
 * THE BOUNDARY CONTRACT
 * ---------------------------------------------------------------------------
 * `server.js` hands over `route`, and these are the only property names this
 * module reads:
 *
 *   {
 *     method:   req.method verbatim,
 *     segments: the path split on '/', leading empty element dropped, each
 *               segment percent-decoded EXACTLY ONCE  ->
 *               ['api', 'students', 'S001', 'activities'],
 *     rawPath:  the request target with the query string removed, used only
 *               for error messages and to recover the raw identifier,
 *     query:    a URLSearchParams built over the raw query text
 *   }
 *
 * Two prohibitions follow, and both are load-bearing:
 *
 *   1. **Never decode again.** Decoding happens once, at the boundary. A second
 *      decode would turn a doubly encoded identifier such as `S%2530%2530%2531`
 *      - still `S%30%30%31` after the boundary's single decode - into `S001`
 *      and accept it. Identifiers therefore reach `directory.normalize`, which
 *      only trims and upper-cases, and an encoded slash that decoded to a
 *      literal `/` inside one segment simply fails `/^S\d{3}$/`.
 *   2. **Never call `new URL()`** on the request target. `req.url` is a request
 *      target, not a WHATWG URL, and `new URL()` resolves `../` and `./`, which
 *      can make this router match one path while a downstream consumer reads
 *      another (nodejs/node#51311). Matching is exact instead: no trailing-slash
 *      normalization, no pattern engine, no case folding of path segments.
 *
 * DEPENDENCIES
 * ---------------------------------------------------------------------------
 * This module requires nothing - no sibling module, no Node built-in and no
 * third-party package. `server.js` is the single composition root and is the
 * only file that constructs anything, so the student directory and the activity
 * repository arrive **injected** through `create({ directory, repository })`.
 * Requiring `./studentDirectory` or `./activityRepository` here would create a
 * second construction site and make this handler untestable in isolation.
 *
 * Only Node globals are used - `Buffer`, `JSON`, `console` - all of which exist
 * on the pinned 24.x runtime and on the older line the build host happens to
 * carry. Nothing here uses `URLPattern`, `Object.groupBy` or
 * `Array.prototype.toSorted`, and nothing here calls `process.exit`.
 *
 * @example
 * const activityRoutes = require('./lib/activityRoutes');
 * const apiHandler = activityRoutes.create({ directory, repository });
 * // inside the http.createServer handler in server.js:
 * if (apiHandler(req, res, route)) return;   // it answered
 * // ...otherwise server.js writes the single 404 NOT_FOUND
 */

/* ---------------------------------------------------------------------------
 * Wire-level constants.
 * ------------------------------------------------------------------------- */

/** The media type every route in this module both accepts and produces. */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * The request body cap, in **bytes**. The baseline accepted a body of any size
 * and silently discarded it; a route that actually reads bodies needs a bound,
 * and 8 KiB is orders of magnitude more than the one-field document these
 * routes accept. Counted across `data` chunks as bytes rather than characters,
 * so a multi-byte payload cannot slip past a character count.
 */
const MAX_BODY_BYTES = 8192;

/**
 * How long a caller-supplied value may be when it is interpolated into an error
 * message. Identifiers and activity names are echoed back to help a caller fix
 * a request; truncating keeps a pathological value from becoming the message.
 */
const MAX_MESSAGE_VALUE_LENGTH = 64;

/** The accepted length range of an activity name, after trimming. */
const MAX_ACTIVITY_LENGTH = 64;

/* ---------------------------------------------------------------------------
 * Route shape. Matching is exact, so every literal is named once.
 * ------------------------------------------------------------------------- */

const API_SEGMENT = 'api';
const STUDENTS_SEGMENT = 'students';
const ACTIVITIES_SEGMENT = 'activities';

/** `['api', 'activities']` - the roster route, matched by exact equality. */
const ACTIVITIES_ROUTE_SEGMENT_COUNT = 2;

/** `['api', 'students', '<id>', 'activities']` - four elements, in that order. */
const STUDENT_ROUTE_SEGMENT_COUNT = 4;

/** Where the `Student ID` sits in both the decoded and the raw path. */
const STUDENT_ID_SEGMENT_INDEX = 2;

/** The one query parameter this module reads, on the roster route only. */
const ACTIVITY_QUERY_PARAMETER = 'activity';

/** The one body field `POST` accepts. Any other key is refused by name. */
const ACTIVITY_BODY_FIELD = 'activity';

/**
 * `Allow` header values, exact and ordered, because a `405` is only useful when
 * it names what would have worked. `/` belongs to `server.js` and carries
 * `GET, HEAD`; these two are this module's.
 */
const ALLOW_STUDENT_ACTIVITIES = 'GET, HEAD, POST';
const ALLOW_ACTIVITIES = 'GET, HEAD';

/** The methods each route serves. `HEAD` is always the `GET` path, body suppressed. */
const METHOD_GET = 'GET';
const METHOD_HEAD = 'HEAD';
const METHOD_POST = 'POST';

/* ---------------------------------------------------------------------------
 * Status codes, error codes and the exact message of every failure.
 *
 * Every error body is exactly `{"error":{"code":"...","message":"..."}}` - two
 * keys, nothing more - and every message is one fixed sentence rather than free
 * prose, so two requests that fail the same way produce the same bytes.
 * ------------------------------------------------------------------------- */

const STATUS_OK = 200;
const STATUS_CREATED = 201;
const STATUS_BAD_REQUEST = 400;
const STATUS_NOT_FOUND = 404;
const STATUS_METHOD_NOT_ALLOWED = 405;
const STATUS_CONFLICT = 409;
const STATUS_PAYLOAD_TOO_LARGE = 413;
const STATUS_UNSUPPORTED_MEDIA_TYPE = 415;
const STATUS_INTERNAL_ERROR = 500;

const CODE_INVALID_STUDENT_ID = 'INVALID_STUDENT_ID';
const CODE_MALFORMED_JSON = 'MALFORMED_JSON';
const CODE_INVALID_ACTIVITY = 'INVALID_ACTIVITY';
const CODE_UNEXPECTED_FIELD = 'UNEXPECTED_FIELD';
const CODE_STUDENT_NOT_FOUND = 'STUDENT_NOT_FOUND';
const CODE_METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED';
const CODE_ACTIVITY_ALREADY_RECORDED = 'ACTIVITY_ALREADY_RECORDED';
const CODE_PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE';
const CODE_UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE';
const CODE_INTERNAL_ERROR = 'INTERNAL_ERROR';

/**
 * The stable discriminator `lib/activityRepository.js` sets on the one rejection
 * that is a client error rather than a server fault. Matched on `code`, never on
 * the message text: the repository's own sentence names the record's origin and
 * is a diagnostic, while the sentence this module sends is part of the HTTP
 * contract. Every other rejection is a `500`.
 */
const REPOSITORY_DUPLICATE_CODE = 'ACTIVITY_ALREADY_RECORDED';

/** The discriminator on errors this module throws from `create`. */
const CONTEXT_ERROR_CODE = 'ACTIVITY_ROUTES_INVALID';

/** Fixed sentences - no value is interpolated into any of these. */
const MESSAGE_MALFORMED_JSON = 'Request body is not valid JSON';
const MESSAGE_INVALID_ACTIVITY = 'activity must be a string of 1 to 64 characters';
const MESSAGE_PAYLOAD_TOO_LARGE = `Request body exceeds ${MAX_BODY_BYTES} bytes`;
const MESSAGE_UNSUPPORTED_MEDIA_TYPE = `Content-Type must be ${JSON_MEDIA_TYPE}`;
const MESSAGE_INTERNAL_ERROR = 'Could not persist the activity record';

/** The members each injected dependency must expose, checked once in `create`. */
const REQUIRED_DIRECTORY_MEMBERS = ['normalize', 'isValidFormat', 'has', 'nameOf'];
const REQUIRED_REPOSITORY_MEMBERS = ['listByStudent', 'listActivities', 'addActivity'];

/** Swallows an event that carries no decision - used for `req`'s `'error'`. */
const noop = () => {};

/* ---------------------------------------------------------------------------
 * Pure helpers.
 * ------------------------------------------------------------------------- */

/**
 * Describes a value for a construction-time error message, without ever
 * printing the value itself.
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
 * Whether a value is a plain object - an object that is neither `null` nor an
 * array. A JSON body that is an array, a string, a number, `true` or `null`
 * parses successfully and is still not a record, so it is refused rather than
 * indexed into.
 *
 * @param {unknown} value The value to test.
 * @returns {boolean} `true` for a non-null, non-array object.
 */
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Bounds a caller-supplied value before it is interpolated into an error
 * message. A non-string is never reached by the callers below (they pass raw
 * path segments and trimmed strings), but coercing rather than throwing keeps a
 * message-building helper from ever being the reason a request fails.
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
 * Recovers a path segment in its **raw, still-encoded** form from `rawPath`.
 *
 * An identifier echoed in an error message must be the segment as received, not
 * the decoded value: printing the decoded form would echo back whatever escape
 * sequence the caller sent, and re-encoding the decoded value would invent a
 * spelling the caller never used. `rawPath` is split the same way `server.js`
 * splits the decoded path - on `/`, leading empty element dropped - so the
 * indexes of the two arrays line up.
 *
 * @param {string} rawPath The request target with the query string removed.
 * @param {number} index The segment index, matching `route.segments`.
 * @param {string} fallback What to return when `rawPath` cannot supply it.
 * @returns {string} The raw segment, or `fallback`.
 */
const rawSegmentAt = (rawPath, index, fallback) => {
  if (typeof rawPath !== 'string' || rawPath === '') return fallback;
  const parts = rawPath.split('/');
  if (parts[0] === '') parts.shift();
  const part = parts[index];
  return typeof part === 'string' ? part : fallback;
};

/**
 * Whether a `Content-Type` header names JSON. Matched on the **media type
 * only**, so `application/json; charset=utf-8` is accepted while `text/plain`
 * is not, and a missing header is a refusal rather than an assumption.
 *
 * @param {unknown} header The raw `Content-Type` header value.
 * @returns {boolean} `true` when the media type is exactly `application/json`.
 */
const isJsonMediaType = (header) => {
  if (typeof header !== 'string') return false;
  return header.split(';')[0].trim().toLowerCase() === JSON_MEDIA_TYPE;
};

/* ---------------------------------------------------------------------------
 * Message builders. One per code that interpolates a value, so the exact
 * sentence exists in exactly one place.
 * ------------------------------------------------------------------------- */

/**
 * @param {string} rawValue The raw, still-encoded identifier segment.
 * @returns {string} The `400 INVALID_STUDENT_ID` sentence.
 */
const messageInvalidStudentId = (rawValue) =>
  `Student ID must match S followed by three digits: ${truncate(rawValue)}`;

/**
 * Both identifier failures render the identifier the same way, and that is the
 * contract rather than an oversight: AAP 0.6.2 fixes `<value>` for an
 * identifier as "the raw, still-encoded path segment as received, truncated to
 * 64 characters", for this `404` exactly as for the `400` above - never the
 * decoded value and never the normalized one. The normalized identifier is
 * `<id>`, and it appears in one sentence only, the `409` built by
 * `messageActivityAlreadyRecorded`.
 *
 * @param {string} rawValue The raw, still-encoded identifier segment.
 * @returns {string} The `404 STUDENT_NOT_FOUND` sentence.
 */
const messageStudentNotFound = (rawValue) =>
  `No student with Student ID ${truncate(rawValue)}`;

/**
 * @param {string} key The first offending key, in the body's own key order.
 * @returns {string} The `400 UNEXPECTED_FIELD` sentence.
 */
const messageUnexpectedField = (key) => `Unexpected field: ${key}`;

/**
 * @param {string} method The request method, verbatim.
 * @param {string} path The raw request target with the query string removed.
 * @returns {string} The `405 METHOD_NOT_ALLOWED` sentence.
 */
const messageMethodNotAllowed = (method, path) =>
  `Method ${method} is not allowed on ${path}`;

/**
 * @param {string} studentId The **normalized** identifier.
 * @param {string} activity The trimmed activity name the caller supplied.
 * @returns {string} The `409 ACTIVITY_ALREADY_RECORDED` sentence.
 */
const messageActivityAlreadyRecorded = (studentId, activity) =>
  `Student ${studentId} already holds activity ${truncate(activity)}`;

/**
 * The `Location` of a student's activity collection, sent on a `201`.
 *
 * @param {string} studentId The normalized identifier.
 * @returns {string} The collection path.
 */
const locationOf = (studentId) =>
  `/${API_SEGMENT}/${STUDENTS_SEGMENT}/${studentId}/${ACTIVITIES_SEGMENT}`;

/* ---------------------------------------------------------------------------
 * Writing a response.
 *
 * Every response this module sends goes through `sendJson`, so the media type,
 * the explicit `Content-Length` and the `HEAD` body suppression are decided in
 * one place and cannot drift between a success and a failure.
 * ------------------------------------------------------------------------- */

/**
 * Sends a JSON response.
 *
 * `Content-Length` is set **explicitly** from the serialized body rather than
 * left to `res.end()`, which is what makes `HEAD` truthful: `HEAD` is the `GET`
 * path with the body suppressed, so it must carry the same status and the same
 * headers - including the length the `GET` would have sent - while writing
 * **zero body bytes**. That is exactly `res.end()` with no argument.
 *
 * The `state.responded` guard is not decoration. A `POST` reads its body
 * asynchronously, so a mid-stream rejection from the `'data'` handler and a
 * later decision from the `'end'` handler could otherwise both try to write.
 * The first write wins and every later one is dropped.
 *
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request, read for its method.
 * @param {import('http').ServerResponse} res The response to write.
 * @param {number} status The HTTP status code.
 * @param {object} payload The value to serialize as the body.
 * @param {Record<string, string|number>} [extraHeaders] Headers to merge in -
 *   `Allow`, `Location` and `Connection` are the only ones used.
 * @returns {void}
 */
const sendJson = (state, req, res, status, payload, extraHeaders) => {
  if (state.responded) return;
  state.responded = true;

  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': JSON_MEDIA_TYPE,
    'Content-Length': Buffer.byteLength(body)
  };
  if (extraHeaders !== undefined) {
    Object.keys(extraHeaders).forEach((name) => {
      headers[name] = extraHeaders[name];
    });
  }

  res.writeHead(status, headers);
  if (req.method === METHOD_HEAD) {
    res.end();
    return;
  }
  res.end(body);
};

/**
 * Sends an error in the one envelope the contract defines: exactly
 * `{"error":{"code":"...","message":"..."}}`, two keys and no more.
 *
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response to write.
 * @param {number} status The HTTP status code.
 * @param {string} code The stable error code.
 * @param {string} message The fixed sentence for that code.
 * @param {Record<string, string|number>} [extraHeaders] Headers to merge in.
 * @returns {void}
 */
const sendError = (state, req, res, status, code, message, extraHeaders) => {
  sendJson(state, req, res, status, { error: { code, message } }, extraHeaders);
};

/**
 * Ends a request that has already been answered **without reading the rest of
 * it**: the body a rejection declined to interpret is discarded by destroying
 * the stream, never by reading it to the end.
 *
 * Four mechanics, in this order, and the order is what keeps both halves of the
 * requirement - the response delivered, the body unread - true at once. Each
 * step below was measured on the pinned runtime, 20 iterations per variant with
 * a 1 MiB upload in flight and no body consumer attached:
 *
 *   1. `'error'` is muted first. Destroying a stream the client is still
 *      writing to surfaces as `ECONNRESET` on the request - an event that
 *      carries no decision this module has not already made, and that would
 *      otherwise go unhandled.
 *   2. The stream is **paused**, so nothing here consumes another byte.
 *   3. The destroy waits for the response to **finish**, and the stream is
 *      **paused again** at that point. Both halves of this step are
 *      load-bearing. Destroying before the response has left the process resets
 *      a connection whose response the client has not read yet, and the reset
 *      discards it - 0/20 delivered. And `http.Server` dumps an unread request
 *      body of its own accord when the response finishes, which resumes the
 *      stream: pausing once and deferring without re-pausing read the entire
 *      1 MiB upload every time, which is the drain the contract forbids wearing
 *      a destroy's clothes.
 *   4. The **destroy is taken on the next event-loop turn** after that, with
 *      the guard re-checked because the stream may have ended meanwhile.
 *
 * Measured outcome of the shape below: 20/20 responses delivered, and 65536
 * body bytes read - the chunk the kernel had already handed over before the
 * decision, unchanged at a 4 MiB and a 16 MiB upload. Reading does not scale
 * with what the client is sending, which is the property the contract is after.
 *
 * The cost, stated rather than hidden: a client still writing megabytes when it
 * is refused may see the connection reset instead of its response. That is the
 * price of not reading a body nothing will look at, and `Connection: close` on
 * the response has already told that client the exchange is over.
 *
 * A request that already arrived in full, or a stream something else destroyed
 * in the meantime, needs nothing done to it: there is no body left to refuse.
 *
 * @param {import('http').IncomingMessage} req The already-answered request.
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

/**
 * Sends an error for a request whose body was **never read** - every stage up
 * to and including `Student ID` existence, plus the mid-stream `413`.
 *
 * Such a request is decided twice over, and the contract fixes both halves: a
 * request rejected before its body is read has "the response written and the
 * request stream destroyed, so a client is not left waiting for a drain that
 * will not happen" (AAP 0.6.2). The sequence below is that requirement, in
 * order, and the order is what makes it work:
 *
 *   1. **Respond first.** The status, the envelope and every header are handed
 *      to the response before the request stream is touched, so the bytes the
 *      client is waiting for are already written when the exchange ends.
 *   2. **`Connection: close` travels with that response**, and it is what makes
 *      destroying the stream safe for the response just written: the client is
 *      told this message ends the exchange, so it waits for no drain of a body
 *      this module chose not to interpret and cannot pipeline a second request
 *      behind it onto a connection that is going away. A connection whose
 *      request body was refused is not one to reuse.
 *   3. **Then abandon the request** through `abandonRequest`, which stops
 *      reading and destroys the stream. Nothing consumes the remainder of the
 *      upload, so a rejected request stops costing socket time and event-loop
 *      work at the moment it is refused, however much of it was still to come.
 *
 * Successful responses and failures raised *after* the body was fully read keep
 * default connection handling; they never pass through here.
 *
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request to answer and abandon.
 * @param {import('http').ServerResponse} res The response to write.
 * @param {number} status The HTTP status code.
 * @param {string} code The stable error code.
 * @param {string} message The fixed sentence for that code.
 * @param {Record<string, string|number>} [extraHeaders] Headers to merge in.
 * @returns {void}
 */
const sendEarlyError = (state, req, res, status, code, message, extraHeaders) => {
  if (state.responded) return;

  const headers = { Connection: 'close' };
  if (extraHeaders !== undefined) {
    Object.keys(extraHeaders).forEach((name) => {
      headers[name] = extraHeaders[name];
    });
  }
  const stillArriving = req.complete !== true;

  sendError(state, req, res, status, code, message, headers);

  if (stillArriving) {
    abandonRequest(req, res);
  }
};

/**
 * The characters that must never reach a log record verbatim: the C0 controls
 * (CR and LF among them), DEL and the C1 controls, and the two Unicode line
 * separators. `sanitizeForLog` escapes every match.
 */
const LOG_UNSAFE_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Renders text safe to write as one log record (CWE-117).
 *
 * An activity name is free text of 1-64 characters by contract (AAP 0.5.4), and
 * that contract is deliberately **not** narrowed - it is the sink that is made
 * safe. Every C0 and C1 control character, plus U+2028 and U+2029 which some log
 * readers treat as line breaks, is replaced by its `\uXXXX` spelling, so a
 * caller cannot end the record early and continue with a line of its own
 * invention, and a terminal tailing the log cannot be driven by an escape
 * sequence that arrived in a request body.
 *
 * Applying this twice is harmless: the replacement text contains no control
 * character, so a second pass finds nothing to escape.
 *
 * @param {string} text The text to render.
 * @returns {string} The text with every control character escaped.
 */
const sanitizeForLog = (text) =>
  text.replace(
    LOG_UNSAFE_PATTERN,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );

/**
 * Writes one diagnostic line to stderr for a fault that is never exposed to a
 * client.
 *
 * **One line, always.** Both halves of the record are escaped through
 * `sanitizeForLog`, because both can carry text a caller supplied: `context`
 * names the activity being recorded, and `detail` is an error message or stack
 * that embeds it - `lib/activityRepository.js` builds its persistence failure
 * around the activity name. Escaping them here rather than at each call site
 * makes this the single choke point every diagnostic passes through, so a
 * multiline stack is rendered as one escaped record instead of several lines a
 * reader could mistake for separate events (CWE-117).
 *
 * @param {string} context What was being attempted.
 * @param {unknown} error The underlying failure.
 * @returns {void}
 */
const logInternalError = (context, error) => {
  const detail = error instanceof Error
    ? (error.stack === undefined ? error.message : error.stack)
    : String(error);
  console.error(`activityRoutes: ${sanitizeForLog(context)}: ${sanitizeForLog(detail)}`);
};

/**
 * Records an internal fault on **stderr** and answers with the one `500` the
 * contract defines - the failed registry write of AAP 0.6.2, which is the only
 * condition that reaches here.
 *
 * The response never carries an exception message, a stack or a path: a client
 * gets the fixed sentence, and the detail an operator needs goes to stderr.
 * This module never calls `process.exit` - turning a failure into process
 * behaviour belongs to the `require.main === module` wrapper in `server.js`
 * alone.
 *
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response to write.
 * @param {string} context What was being attempted, for the log line.
 * @param {unknown} error The underlying failure.
 * @returns {void}
 */
const sendInternalError = (state, req, res, context, error) => {
  logInternalError(context, error);
  sendError(state, req, res, STATUS_INTERNAL_ERROR, CODE_INTERNAL_ERROR, MESSAGE_INTERNAL_ERROR);
};

/* ---------------------------------------------------------------------------
 * Reading a request body.
 * ------------------------------------------------------------------------- */

/**
 * Collects the request body, refusing it the moment it exceeds the cap.
 *
 * The cap is enforced in the `'data'` handler on a running byte total, so an
 * oversize upload is refused **as it arrives** rather than buffered in full and
 * measured afterwards - which is the whole point of having a cap. That
 * rejection is an early one: the body has not been consumed, so it carries
 * `Connection: close` and abandons the request.
 *
 * A stream `'error'` - a client that aborted or a connection that dropped - is
 * not a request to answer: the peer is gone, so the read is simply settled and
 * the listener's presence keeps the event from going unhandled.
 *
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request to read.
 * @param {import('http').ServerResponse} res The response, for the `413`.
 * @param {(body: string) => void} onBody Called once with the decoded body when
 *   the whole body arrived within the cap.
 * @returns {void}
 */
const readRequestBody = (state, req, res, onBody) => {
  const chunks = [];
  let received = 0;
  let settled = false;

  req.on('data', (chunk) => {
    if (settled) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      settled = true;
      sendEarlyError(
        state,
        req,
        res,
        STATUS_PAYLOAD_TOO_LARGE,
        CODE_PAYLOAD_TOO_LARGE,
        MESSAGE_PAYLOAD_TOO_LARGE
      );
      return;
    }
    chunks.push(chunk);
  });

  req.on('error', () => {
    settled = true;
  });

  req.on('end', () => {
    if (settled) return;
    settled = true;
    onBody(Buffer.concat(chunks).toString('utf8'));
  });
};


/* ---------------------------------------------------------------------------
 * Path matching - exact, with no normalization of any kind.
 * ------------------------------------------------------------------------- */

/**
 * Whether the decoded segments are exactly `['api', 'activities']`.
 *
 * Equality is the whole rule. There is no trailing-slash normalization, so
 * `/api/activities/` splits to three segments, does not match, and falls through
 * as a path this module does not recognise.
 *
 * @param {string[]} segments The decoded path segments.
 * @returns {boolean} `true` for the roster route.
 */
const isActivitiesRoute = (segments) =>
  segments.length === ACTIVITIES_ROUTE_SEGMENT_COUNT
  && segments[0] === API_SEGMENT
  && segments[1] === ACTIVITIES_SEGMENT;

/**
 * Whether the decoded segments are exactly
 * `['api', 'students', '<id>', 'activities']` - four elements, in that order.
 *
 * The identifier segment is not inspected here: whatever sits in that position
 * is the caller's `Student ID` and is judged by the directory, which is what
 * keeps a malformed identifier a `400` on a recognised route rather than a
 * `404` on an unrecognised one. An encoded slash that decoded to a literal `/`
 * stays inside that one segment and simply fails the format check.
 *
 * @param {string[]} segments The decoded path segments.
 * @returns {boolean} `true` for the per-student route.
 */
const isStudentActivitiesRoute = (segments) =>
  segments.length === STUDENT_ROUTE_SEGMENT_COUNT
  && segments[0] === API_SEGMENT
  && segments[1] === STUDENTS_SEGMENT
  && segments[3] === ACTIVITIES_SEGMENT;

/* ---------------------------------------------------------------------------
 * The roster route: GET | HEAD /api/activities[?activity=NAME]
 * ------------------------------------------------------------------------- */

/**
 * Reads the optional activity filter from the parsed query.
 *
 * The filter is handed to the repository as the caller wrote it; the trimming
 * and case folding that make `?activity=debate%20society` match
 * `Debate Society` happen there, against the same `activityKey` the groups are
 * built on, so the route cannot fold case differently from the index.
 *
 * @param {{query?: URLSearchParams}} route The boundary object.
 * @returns {string|undefined} The filter, or `undefined` for no filter.
 */
const readActivityFilter = (route) => {
  const { query } = route;
  if (query === null || query === undefined || typeof query.get !== 'function') {
    return undefined;
  }
  const value = query.get(ACTIVITY_QUERY_PARAMETER);
  return value === null ? undefined : value;
};

/**
 * Answers the reverse lookup: students grouped by activity.
 *
 * Grouping, labelling and ordering all belong to the repository - this function
 * copies out only the three documented fields per group. The per-group `count`
 * is taken from the group's own membership and the top-level `count` from the
 * number of groups, so both counts are derived from the data they describe and
 * `count === activities.length` cannot drift.
 *
 * A filter that matches nothing is `200` with `count` 0 and an empty list: a
 * filter matching nothing is not an error, and there is no pagination and no
 * omission marker - the answer is the whole set.
 *
 * The read is **not** wrapped in a `500`. AAP 0.6.2 defines exactly one
 * `INTERNAL_ERROR`, for a failed registry write, and its fixed sentence says
 * `Could not persist the activity record` - a sentence a read that persisted
 * nothing must never be able to send. Unusable dependencies are refused where
 * the contract puts them instead: `create` asserts every member this module
 * calls, on both dependencies, before a single request is served, and the
 * repository answers this lookup from the in-memory index it built at load.
 *
 * @param {{directory: object, repository: object}} deps The injected context.
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response.
 * @param {{method: string, segments: string[], rawPath: string, query: URLSearchParams}} route
 *   The boundary object.
 * @param {string} method The request method.
 * @param {string} rawPath The query-stripped raw request target.
 * @returns {void}
 */
const handleActivitiesRoute = (deps, state, req, res, route, method, rawPath) => {
  if (method !== METHOD_GET && method !== METHOD_HEAD) {
    sendEarlyError(
      state,
      req,
      res,
      STATUS_METHOD_NOT_ALLOWED,
      CODE_METHOD_NOT_ALLOWED,
      messageMethodNotAllowed(method, rawPath),
      { Allow: ALLOW_ACTIVITIES }
    );
    return;
  }

  // Copied group by group: the payload carries exactly `activity`, `count` and
  // `studentIds`, and the membership list is copied so a caller cannot reach
  // the repository's own array through the response.
  const activities = deps.repository.listActivities(readActivityFilter(route)).map((group) => {
    const studentIds = group.studentIds.slice();
    return { activity: group.activity, count: studentIds.length, studentIds };
  });

  sendJson(state, req, res, STATUS_OK, { count: activities.length, activities });
};

/* ---------------------------------------------------------------------------
 * The per-student route: GET | HEAD | POST
 * /api/students/{studentId}/activities
 * ------------------------------------------------------------------------- */

/**
 * Answers a student's activities.
 *
 * The response carries exactly `studentId`, `name`, `count` and `activities`,
 * and each record exactly `activity` and `source`. Nothing else is serialized:
 * the directory row behind `name` also holds Gender, Date of Birth, Age,
 * Department, Year, Email, Phone and City, and none of them may reach a
 * payload, which is why the fields are copied out one by one rather than spread
 * from a source object.
 *
 * `studentId` is the **normalized** identifier, so `s001` and `%20S001%20`
 * answer with `S001`. A student holding no activity is `200` with `count` 0 and
 * an empty list - never `404`, which is reserved for a student the directory
 * does not know.
 *
 * Neither lookup is wrapped in a `500`: the one `INTERNAL_ERROR` AAP 0.6.2
 * defines belongs to a failed registry write, and its sentence -
 * `Could not persist the activity record` - would be untrue coming from a read.
 * Both dependencies are already proven usable before any request arrives, by
 * the `create` assertions over `REQUIRED_DIRECTORY_MEMBERS` and
 * `REQUIRED_REPOSITORY_MEMBERS`, and both calls below answer from memory for an
 * identifier this route has already validated and resolved.
 *
 * @param {{directory: object, repository: object}} deps The injected context.
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response.
 * @param {string} studentId The normalized, existing identifier.
 * @returns {void}
 */
const handleStudentActivitiesRead = (deps, state, req, res, studentId) => {
  const activities = deps.repository.listByStudent(studentId).map((record) => ({
    activity: record.activity,
    source: record.source
  }));
  // The directory is the source of truth for existence and has already
  // answered `has(studentId)`, so the name is present by contract.
  const name = deps.directory.nameOf(studentId);

  sendJson(state, req, res, STATUS_OK, {
    studentId,
    name,
    count: activities.length,
    activities
  });
};

/**
 * Validates a parsed `POST` body and answers every way it can be wrong.
 *
 * The order is fixed so that a body with several faults produces one
 * predictable response: a non-record body, then the first unexpected key, then
 * the `activity` value itself.
 *
 * `POST` accepts **exactly one key**. `studentId` comes from the path alone and
 * `source` is derived from where a record came from, so a body offering either -
 * or anything else, such as `role` or `since` - is refused by name rather than
 * silently dropped, which is what a caller working from stale documentation
 * needs to see.
 *
 * A value of the wrong type is never echoed back: `INVALID_ACTIVITY` states the
 * requirement instead.
 *
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response.
 * @param {string} body The decoded request body.
 * @returns {string|undefined} The trimmed activity name, or `undefined` when a
 *   response has already been written.
 */
const parseActivityBody = (state, req, res, body) => {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    // The parser's own complaint is deliberately not carried into the response
    // and not logged: a body a client sent wrong is a client error, and the
    // fixed sentence is the whole of what the contract promises for it.
    sendError(state, req, res, STATUS_BAD_REQUEST, CODE_MALFORMED_JSON, MESSAGE_MALFORMED_JSON);
    return undefined;
  }

  // An array, a string, a number, a boolean or `null` parses successfully and
  // is still not a record. It carries no `activity`, so it fails the same way a
  // record without one does rather than crashing on a property read.
  if (!isPlainObject(parsed)) {
    sendError(state, req, res, STATUS_BAD_REQUEST, CODE_INVALID_ACTIVITY, MESSAGE_INVALID_ACTIVITY);
    return undefined;
  }

  const unexpected = Object.keys(parsed).find((key) => key !== ACTIVITY_BODY_FIELD);
  if (unexpected !== undefined) {
    sendError(
      state,
      req,
      res,
      STATUS_BAD_REQUEST,
      CODE_UNEXPECTED_FIELD,
      messageUnexpectedField(unexpected)
    );
    return undefined;
  }

  const value = parsed[ACTIVITY_BODY_FIELD];
  if (typeof value !== 'string') {
    sendError(state, req, res, STATUS_BAD_REQUEST, CODE_INVALID_ACTIVITY, MESSAGE_INVALID_ACTIVITY);
    return undefined;
  }

  const activity = value.trim();
  if (activity === '' || activity.length > MAX_ACTIVITY_LENGTH) {
    sendError(state, req, res, STATUS_BAD_REQUEST, CODE_INVALID_ACTIVITY, MESSAGE_INVALID_ACTIVITY);
    return undefined;
  }

  return activity;
};

/**
 * Records an activity for a student.
 *
 * The repository owns the write: it re-checks the identity pair inside its
 * single-writer critical section, rewrites the registry atomically and updates
 * its index only after the rename. This function's whole job is to map that one
 * settlement onto HTTP.
 *
 * The mapping is by the error's **stable `code`**, never by its message text:
 * the duplicate discriminator becomes `409` with this contract's sentence, and
 * every other failure becomes the one `500`, with the real error on stderr. The
 * chain ends in a catch of its own, so neither a rejection nor a failure while
 * writing the response can ever become an unhandled rejection.
 *
 * @param {{directory: object, repository: object}} deps The injected context.
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response.
 * @param {string} studentId The normalized, existing identifier.
 * @param {string} activity The validated, trimmed activity name.
 * @returns {void}
 */
const recordActivity = (deps, state, req, res, studentId, activity) => {
  Promise.resolve()
    .then(() => deps.repository.addActivity(studentId, activity))
    .then((record) => {
      if (!isPlainObject(record)) {
        throw new Error('addActivity resolved without a record');
      }
      // Copied field by field: the response carries exactly these three keys.
      sendJson(
        state,
        req,
        res,
        STATUS_CREATED,
        {
          studentId: record.studentId,
          activity: record.activity,
          source: record.source
        },
        { Location: locationOf(studentId) }
      );
    })
    .catch((error) => {
      if (error !== null && typeof error === 'object' && error.code === REPOSITORY_DUPLICATE_CODE) {
        sendError(
          state,
          req,
          res,
          STATUS_CONFLICT,
          CODE_ACTIVITY_ALREADY_RECORDED,
          messageActivityAlreadyRecorded(studentId, activity)
        );
        return;
      }
      // The activity is caller-supplied free text and this string is a log
      // context, so it is escaped where it is interpolated as well as at the
      // sink - the sink's pass over an already-escaped value changes nothing.
      sendInternalError(
        state,
        req,
        res,
        `recording "${sanitizeForLog(activity)}" for ${studentId}`,
        error
      );
    })
    .catch((error) => {
      // Reached only if writing the response above itself failed - the client is
      // already unanswerable, so this is a log and nothing more.
      logInternalError('writing a response', error);
    });
};

/**
 * Handles a `POST` from the media-type check onwards, in the fixed order:
 * media type, then body size, then parsing and field validation, then the
 * write. The identifier has already been validated and resolved by the caller,
 * which is why an unknown student outranks an oversize or unparseable body.
 *
 * @param {{directory: object, repository: object}} deps The injected context.
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response.
 * @param {string} studentId The normalized, existing identifier.
 * @returns {void}
 */
const handleStudentActivitiesCreate = (deps, state, req, res, studentId) => {
  if (!isJsonMediaType(req.headers['content-type'])) {
    sendEarlyError(
      state,
      req,
      res,
      STATUS_UNSUPPORTED_MEDIA_TYPE,
      CODE_UNSUPPORTED_MEDIA_TYPE,
      MESSAGE_UNSUPPORTED_MEDIA_TYPE
    );
    return;
  }

  readRequestBody(state, req, res, (body) => {
    const activity = parseActivityBody(state, req, res, body);
    if (activity === undefined) return;
    recordActivity(deps, state, req, res, studentId, activity);
  });
};

/**
 * Dispatches the per-student route through the fixed validation order: method,
 * then identifier **shape**, then identifier **existence**, then the method's
 * own work.
 *
 * Shape before existence is what keeps the two failures distinguishable to a
 * client - `400` says "that is not an identifier", `404` says "that identifier
 * is not one of ours" - and doing both before any body is read is what makes a
 * `POST` to an unknown student a `404` rather than a `413` or a `400`, however
 * large or broken its body.
 *
 * The identifier echoed in either failure - the `400 INVALID_STUDENT_ID` and
 * the `404 STUDENT_NOT_FOUND` alike - is the **raw, still-encoded** segment
 * recovered from `rawPath` and capped at 64 characters, per AAP 0.6.2, never
 * the decoded value and never the normalized one: a caller sees back exactly
 * what they sent, down to the escape sequence they wrote. The normalized
 * identifier reaches a message in one place only, the `409` sentence, and it
 * reaches the `200` and `201` payloads as the `studentId` field.
 *
 * @param {{directory: object, repository: object}} deps The injected context.
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response.
 * @param {string} method The request method.
 * @param {string} rawPath The query-stripped raw request target.
 * @param {string[]} segments The decoded path segments.
 * @returns {void}
 */
const handleStudentActivitiesRoute = (deps, state, req, res, method, rawPath, segments) => {
  if (method !== METHOD_GET && method !== METHOD_HEAD && method !== METHOD_POST) {
    sendEarlyError(
      state,
      req,
      res,
      STATUS_METHOD_NOT_ALLOWED,
      CODE_METHOD_NOT_ALLOWED,
      messageMethodNotAllowed(method, rawPath),
      { Allow: ALLOW_STUDENT_ACTIVITIES }
    );
    return;
  }

  const decodedId = segments[STUDENT_ID_SEGMENT_INDEX];
  const rawId = rawSegmentAt(rawPath, STUDENT_ID_SEGMENT_INDEX, decodedId);
  const studentId = deps.directory.normalize(decodedId);

  if (!deps.directory.isValidFormat(studentId)) {
    sendEarlyError(
      state,
      req,
      res,
      STATUS_BAD_REQUEST,
      CODE_INVALID_STUDENT_ID,
      messageInvalidStudentId(rawId)
    );
    return;
  }

  if (!deps.directory.has(studentId)) {
    sendEarlyError(
      state,
      req,
      res,
      STATUS_NOT_FOUND,
      CODE_STUDENT_NOT_FOUND,
      messageStudentNotFound(rawId)
    );
    return;
  }

  if (method === METHOD_POST) {
    handleStudentActivitiesCreate(deps, state, req, res, studentId);
    return;
  }

  handleStudentActivitiesRead(deps, state, req, res, studentId);
};

/* ---------------------------------------------------------------------------
 * The exported factory.
 * ------------------------------------------------------------------------- */

/**
 * Builds the construction-time error for an unusable injected context.
 *
 * @param {string} summary What is wrong.
 * @returns {Error} The error to throw, carrying `code === 'ACTIVITY_ROUTES_INVALID'`.
 */
const createContextError = (summary) => {
  const error = new Error(`Activity routes: ${summary}`);
  error.code = CONTEXT_ERROR_CODE;
  return error;
};

/**
 * Confirms an injected dependency exposes the members this module calls, before
 * a single request is served. A missing member would otherwise surface as a
 * `TypeError` in the middle of a request, long after the wiring mistake was
 * made.
 *
 * @param {unknown} dependency The injected object.
 * @param {string[]} members The member names that must be functions.
 * @param {string} label How the dependency is named in the error.
 * @returns {void}
 * @throws {Error} When the dependency is absent or incomplete.
 */
const assertDependency = (dependency, members, label) => {
  if (!isPlainObject(dependency)) {
    throw createContextError(`a ${label} is required (received ${describeValue(dependency)})`);
  }
  const missing = members.find((member) => typeof dependency[member] !== 'function');
  if (missing !== undefined) {
    throw createContextError(`the ${label} must expose a ${missing}() function`);
  }
};

/**
 * Creates the API request handler.
 *
 * Both dependencies are **injected**: `server.js` is the single composition
 * root, so the workbooks are read exactly once per process and a test can
 * exercise these routes against data no workbook expresses - a student with
 * zero activities, a registry duplicate, a writer that fails - through the same
 * wiring production uses.
 *
 * The returned handler decides recognition and writes, or declines,
 * **synchronously**, so `server.js` can act on its boolean immediately; a
 * `POST` continues reading its body and persisting after `true` has already
 * been returned.
 *
 * @param {{
 *   directory: {
 *     normalize: (raw: unknown) => string,
 *     isValidFormat: (id: unknown) => boolean,
 *     has: (id: unknown) => boolean,
 *     nameOf: (id: unknown) => string|undefined
 *   },
 *   repository: {
 *     listByStudent: (id: unknown) => Array<{activity: string, source: string}>,
 *     listActivities: (filter?: unknown) => Array<{activity: string, count: number, studentIds: string[]}>,
 *     addActivity: (id: unknown, activity: unknown) => Promise<{studentId: string, activity: string, source: string}>
 *   }
 * }} context The injected student directory and activity repository.
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse, route: {method: string, segments: string[], rawPath: string, query: URLSearchParams}) => boolean}
 *   The handler: `true` when it has written a response, `false` for a path it
 *   does not recognise.
 * @throws {Error} With `code === 'ACTIVITY_ROUTES_INVALID'` when either
 *   dependency is missing or incomplete.
 */
const create = (context) => {
  if (!isPlainObject(context)) {
    throw createContextError(
      'create requires an options object carrying a directory and a repository ' +
        `(received ${describeValue(context)})`
    );
  }

  const { directory, repository } = context;
  assertDependency(directory, REQUIRED_DIRECTORY_MEMBERS, 'student directory');
  assertDependency(repository, REQUIRED_REPOSITORY_MEMBERS, 'activity repository');

  const deps = { directory, repository };

  return (req, res, route) => {
    const boundary = isPlainObject(route) ? route : {};
    const segments = Array.isArray(boundary.segments) ? boundary.segments : [];
    const rawPath = typeof boundary.rawPath === 'string' ? boundary.rawPath : '';
    // `route.method` is `req.method` as the boundary received it; the request's
    // own method is the fallback so a caller that builds a route object by hand
    // still dispatches, and either way the method a message names is verbatim.
    const method = typeof boundary.method === 'string' && boundary.method !== ''
      ? boundary.method
      : String(req.method === undefined ? '' : req.method);

    // One write state per request: the first response wins, so an asynchronous
    // body rejection can never be followed by a second response.
    const state = { responded: false };

    if (isActivitiesRoute(segments)) {
      handleActivitiesRoute(deps, state, req, res, boundary, method, rawPath);
      return true;
    }

    if (isStudentActivitiesRoute(segments)) {
      handleStudentActivitiesRoute(deps, state, req, res, method, rawPath, segments);
      return true;
    }

    // Not this module's path - and deliberately not answered here, whether or
    // not it begins with `api`. `server.js` owns the single `404 NOT_FOUND`
    // fallback, so unknown-path handling lives in exactly one place.
    return false;
  };
};

module.exports = { create };
