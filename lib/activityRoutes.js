'use strict';

/**
 * lib/activityRoutes.js - the HTTP-facing half of the extracurricular activity
 * feature: path recognition, method dispatch, body reading, JSON serialization
 * and the error envelope for the activity routes.
 *
 * Routes owned here, with every status they can produce:
 *
 *   GET | HEAD  /api/students/{studentId}/activities  -> 200
 *   POST        /api/students/{studentId}/activities  -> 201 + Location
 *   GET | HEAD  /api/activities[?activity=NAME]       -> 200
 *
 * ...together with their failures: 400 (identifier shape, malformed JSON,
 * unexpected field, invalid activity), 404 (unknown student), 405 with an exact
 * `Allow` header, 409 (already recorded), 413, 415, 500, and the two that
 * report a bound rather than a fault - 503 with `Retry-After` when the write
 * queue is full, and 507 when a quota is reached.
 *
 * No status is produced in two places, so `server.js` keeps the `/` greeting and
 * its own `405`, the single `404 NOT_FOUND` fallback for every unrecognised
 * path, and the `URIError` catch for a malformed percent-escape. This module
 * declines a path it does not recognise by **returning `false`** and writing
 * nothing at all, which is what keeps that fallback in one place and keeps the
 * `false` return reachable.
 *
 * The boundary object `server.js` hands over is `{ method, segments, rawPath,
 * query }`, and those are the only property names this module reads: `method`
 * is `req.method` verbatim, `segments` is the path split on '/' with the leading
 * empty element dropped and each segment percent-decoded **exactly once**
 * (`['api', 'students', 'S001', 'activities']`), `rawPath` is the request target
 * with the query string removed - used only for error messages and to recover
 * the raw identifier - and `query` is a `URLSearchParams` over the raw query
 * text. Two prohibitions keep that decoding honest, and both are load-bearing:
 *
 *   1. **Never decode a segment again.** A second decode would turn a doubly
 *      encoded identifier such as `S%2530%2530%2531` - still `S%30%30%31` after
 *      the boundary's single decode - into `S001` and accept it. Identifiers
 *      reach `directory.normalize`, which only trims and upper-cases, so an
 *      encoded slash that decoded to a literal `/` inside one segment simply
 *      fails `/^S\d{3}$/`.
 *   2. **Never call `new URL()`** on a request target. `req.url` is a request
 *      target, not a WHATWG URL, and `new URL()` resolves `../` and `./`, which
 *      can make this router match one path while a downstream consumer reads
 *      another (nodejs/node#51311). Matching is exact instead: no trailing-slash
 *      normalization, no pattern engine, no case folding of path segments.
 *
 * The student directory and the activity repository arrive **injected** through
 * `create({ directory, repository })`, because `server.js` is the single
 * composition root: requiring either module here would create a second
 * construction site and make this handler untestable in isolation. Nothing else
 * is required either - no Node built-in and no third-party package - and
 * nothing here calls `process.exit`.
 */

const JSON_MEDIA_TYPE = 'application/json';

/**
 * The request body cap, in **bytes**. A route that reads bodies needs a bound,
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

const MAX_ACTIVITY_LENGTH = 64;

const API_SEGMENT = 'api';
const STUDENTS_SEGMENT = 'students';
const ACTIVITIES_SEGMENT = 'activities';

const ACTIVITIES_ROUTE_SEGMENT_COUNT = 2;
const STUDENT_ROUTE_SEGMENT_COUNT = 4;
const STUDENT_ID_SEGMENT_INDEX = 2;
const ACTIVITY_QUERY_PARAMETER = 'activity';
const ACTIVITY_BODY_FIELD = 'activity';

/*
 * `Allow` header values, exact and ordered, because a `405` is only useful when
 * it names what would have worked. `/` belongs to `server.js` and carries
 * `GET, HEAD`; these two are this module's.
 */
const ALLOW_STUDENT_ACTIVITIES = 'GET, HEAD, POST';
const ALLOW_ACTIVITIES = 'GET, HEAD';

// The methods each route serves. `HEAD` is always the `GET` path, body suppressed.
const METHOD_GET = 'GET';
const METHOD_HEAD = 'HEAD';
const METHOD_POST = 'POST';

const STATUS_OK = 200;
const STATUS_CREATED = 201;
const STATUS_BAD_REQUEST = 400;
const STATUS_NOT_FOUND = 404;
const STATUS_METHOD_NOT_ALLOWED = 405;
const STATUS_CONFLICT = 409;
const STATUS_PAYLOAD_TOO_LARGE = 413;
const STATUS_UNSUPPORTED_MEDIA_TYPE = 415;
const STATUS_INTERNAL_ERROR = 500;

/**
 * `503` for a write the service is momentarily unable to accept, and `507` for
 * one it cannot store.
 *
 * The two are deliberately different, because a client has to be able to tell
 * "try again in a moment" from "this will keep failing until records are
 * removed". `503` is the temporal one - the write queue is full and will drain.
 * `507 Insufficient Storage` is the standing one: RFC 4918 §11.5 defines it as
 * the method not being performable "because the server is unable to store the
 * representation needed to successfully complete the request", which is exactly
 * a quota that has been reached.
 *
 * Neither is a `429`. No per-client rate limiting exists here, and these
 * are not rate limits: they are finite capacity, measured per process over all
 * callers, and they say nothing about how often any one client may ask.
 */
const STATUS_SERVICE_UNAVAILABLE = 503;
const STATUS_INSUFFICIENT_STORAGE = 507;

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

/** The three codes that report a bound on the write path rather than a fault. */
const CODE_WRITE_QUEUE_FULL = 'ACTIVITY_WRITE_QUEUE_FULL';
const CODE_STUDENT_ACTIVITY_LIMIT_REACHED = 'STUDENT_ACTIVITY_LIMIT_REACHED';
const CODE_REGISTRY_FULL = 'ACTIVITY_REGISTRY_FULL';

/**
 * The stable discriminator `lib/activityRepository.js` sets on the rejection
 * that is a duplicate rather than a server fault. Matched on `code`, never on
 * the message text: the repository's own sentence names the record's origin and
 * is a diagnostic, while the sentence this module sends is part of the HTTP
 * contract. It becomes `409`; the three write-bound discriminators below become
 * `503` or `507`; and every remaining rejection becomes the one `500`.
 */
const REPOSITORY_DUPLICATE_CODE = 'ACTIVITY_ALREADY_RECORDED';

/**
 * The three discriminators the repository sets when a write is refused by a
 * **bound** rather than by anything about the request: the write queue is at
 * its ceiling, the student's collection is at its ceiling, or the registry is.
 * Matched on `code` for the same reason as the duplicate above - the
 * repository's sentence names the count and the configured limit and is a
 * diagnostic, while the sentences below are the HTTP contract.
 *
 * The same values are the HTTP codes, mirroring `REPOSITORY_DUPLICATE_CODE` and
 * `CODE_ACTIVITY_ALREADY_RECORDED`: one vocabulary across the seam, declared on
 * both sides so neither can drift silently.
 */
const REPOSITORY_QUEUE_FULL_CODE = 'ACTIVITY_WRITE_QUEUE_FULL';
const REPOSITORY_STUDENT_LIMIT_CODE = 'STUDENT_ACTIVITY_LIMIT_REACHED';
const REPOSITORY_REGISTRY_FULL_CODE = 'ACTIVITY_REGISTRY_FULL';

/**
 * `Retry-After` on the `503`, in seconds. The queue is drained by writes that
 * each take a single synchronous file rewrite, so one second is an honest
 * interval rather than a placeholder: it is longer than the queue needs and
 * short enough that a legitimate client's retry is not a penalty.
 */
const RETRY_AFTER_SECONDS = '1';

const CONTEXT_ERROR_CODE = 'ACTIVITY_ROUTES_INVALID';

const MESSAGE_MALFORMED_JSON = 'Request body is not valid JSON';
const MESSAGE_INVALID_ACTIVITY = 'activity must be a string of 1 to 64 characters';
const MESSAGE_PAYLOAD_TOO_LARGE = `Request body exceeds ${MAX_BODY_BYTES} bytes`;
const MESSAGE_UNSUPPORTED_MEDIA_TYPE = `Content-Type must be ${JSON_MEDIA_TYPE}`;
const MESSAGE_INTERNAL_ERROR = 'Could not persist the activity record';
const MESSAGE_WRITE_QUEUE_FULL = 'Too many activity writes are in flight; retry shortly';
const MESSAGE_REGISTRY_FULL = 'The activity registry has reached its configured capacity';

/*
 * The members each injected dependency must expose, checked once in `create`.
 * `reserveWrite` is required rather than probed for: a repository without it
 * would leave the write path with no boundary bound, and a control that
 * silently switches itself off is worse than one that refuses to start.
 */
const REQUIRED_DIRECTORY_MEMBERS = ['normalize', 'isValidFormat', 'has', 'nameOf'];
const REQUIRED_REPOSITORY_MEMBERS = [
  'listByStudent',
  'listActivities',
  'addActivity',
  'reserveWrite'
];

const noop = () => {};

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

const messageInvalidStudentId = (rawValue) =>
  `Student ID must match S followed by three digits: ${truncate(rawValue)}`;

/**
 * Both identifier failures render the identifier the same way, and that is the
 * contract rather than an oversight: this `404` echoes the raw, still-encoded
 * path segment as received and truncated, exactly as the `400` above does -
 * never the decoded value and never the normalized one. The normalized
 * identifier reaches one sentence only, the `409` built by
 * `messageActivityAlreadyRecorded`.
 */
const messageStudentNotFound = (rawValue) =>
  `No student with Student ID ${truncate(rawValue)}`;

const messageUnexpectedField = (key) => `Unexpected field: ${key}`;

const messageMethodNotAllowed = (method, path) =>
  `Method ${method} is not allowed on ${path}`;

const messageActivityAlreadyRecorded = (studentId, activity) =>
  `Student ${studentId} already holds activity ${truncate(activity)}`;

/**
 * The `507` sentence for a student whose collection is full. The configured
 * ceiling is deliberately not interpolated: it is operator configuration rather
 * than a property of the request, and one sentence per code keeps two identical
 * failures byte-identical whatever the deployment. The count and the limit stay
 * in the repository's own internal diagnostic.
 *
 * @param {string} studentId The **normalized** identifier.
 * @returns {string} The `507 STUDENT_ACTIVITY_LIMIT_REACHED` sentence.
 */
const messageStudentActivityLimit = (studentId) =>
  `Student ${studentId} has reached the maximum number of recorded activities`;

const locationOf = (studentId) =>
  `/${API_SEGMENT}/${STUDENTS_SEGMENT}/${studentId}/${ACTIVITIES_SEGMENT}`;

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
 * `{"error":{"code":"...","message":"..."}}` - two keys, nothing more - with
 * one fixed sentence per code, so two requests that fail the same way produce
 * the same bytes. The arguments are `sendJson`'s, with `code` and `message`
 * forming that envelope.
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
 * requirement - the response delivered, the body unread - true at once:
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
 *      discards it. And `http.Server` dumps an unread request body of its own
 *      accord when the response finishes, which resumes the stream: pausing
 *      once and deferring without re-pausing reads the upload to its end, which
 *      is the drain the contract forbids wearing a destroy's clothes.
 *   4. The **destroy is taken on the next event-loop turn** after that, with
 *      the guard re-checked because the stream may have ended meanwhile.
 *
 * The only body bytes this shape reads are the chunk the kernel had already
 * handed over before the decision, so reading does not scale with what the
 * client is sending. The cost, stated rather than hidden: a client still
 * writing when it is refused may see the connection reset instead of its
 * response - the price of not reading a body nothing will look at.
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
 * Such a request is decided twice over, and both halves are contractual: the
 * response is written, and the request stream is destroyed rather than drained,
 * so a client is never left waiting for a drain that will not happen. The
 * sequence below is that behaviour, in order, and the order is what makes it
 * work:
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

/*
 * The code points that must never reach a log record verbatim, named by Unicode
 * general category so the set is complete rather than hand-picked: `\p{Cc}` the
 * C0 and C1 controls and DEL (CR and LF among them); `\p{Cf}` every format
 * character, which makes the bidirectional embeddings, overrides and isolates
 * unrepresentable along with the zero-width and tag characters that conceal
 * rather than reorder; `\p{Cs}` unpaired surrogates, which would otherwise reach
 * the log as U+FFFD; and `\p{Zl}`/`\p{Zp}`, the two line separators some log
 * readers break on. The u flag makes each match a whole code point, so a paired surrogate - an emoji in an activity name -
 * is left alone. The identical pattern and sanitizeForLog live in `lib/activityRepository.js` and
 * `server.js`, the other two files that own a stderr sink; there is no shared module
 * to hold one copy, and the three must stay in step.
 */
const LOG_UNSAFE_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

const MAX_BMP_CODE_POINT = 0xffff;

/**
 * Escapes every code point `LOG_UNSAFE_PATTERN` matches - control, format,
 * bidirectional, surrogate or line separator - as its visible `\uXXXX` or
 * `\u{XXXXX}` spelling, so a stderr record stays one line and says exactly what
 * arrived (CWE-117). The input is free text by contract, so the sink is made
 * safe rather than the contract narrowed. Idempotent: the replacement text
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
 * Records an internal fault on **stderr** and answers with the one fixed `500`
 * the contract defines.
 *
 * What reaches here is every write-path outcome this module cannot attribute to
 * the caller: an `addActivity` rejection whose `code` is not the duplicate
 * discriminator - a failed registry write is the common one, not the only one -
 * and an `addActivity` that resolves without a record, which `recordActivity`
 * turns into a throw so it lands here rather than becoming a malformed `201`.
 * Read paths never pass through: they answer from the in-memory index and are
 * not wrapped, so the `Could not persist the activity record` sentence can only
 * be sent to a request that tried to persist something.
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

// The roster route: GET | HEAD /api/activities[?activity=NAME]

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
 * The read is **not** wrapped in a `500`. The contract defines exactly one
 * `INTERNAL_ERROR`, and its fixed sentence - `Could not persist the activity
 * record` - is one a read that persisted nothing must never be able to send.
 * Unusable dependencies are refused earlier instead: `create` asserts every
 * member this module calls, on both dependencies, before a single request is
 * served, and the repository answers this lookup from the in-memory index it
 * built at load.
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

// The per-student route: GET | HEAD | POST /api/students/{studentId}/activities

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
 * Neither lookup is wrapped in a `500`, for the reason given on
 * `handleActivitiesRoute`: the one `INTERNAL_ERROR` belongs to the write path.
 * `create` has already proven both dependencies usable, and both calls below
 * answer from memory for an identifier this route validated and resolved.
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

/* ---------------------------------------------------------------------------
 * Write admission - the bound on pending and persisted work.
 *
 * Validation judges one request. These two functions judge what a request would
 * *cost*: how much write work is already in flight, and how much has already
 * accumulated. Without them every syntactically valid `POST` allocated pending
 * promise and response state and a task on the repository's serialized queue,
 * and every accepted one grew the registry, the in-memory views, the per-student
 * response and the cost of the next full-file rewrite - all of it a function of
 * how many requests a caller chose to send (CWE-770, CWE-400).
 *
 * The bounds themselves live in `lib/activityRepository.js`, which owns the
 * queue and the file and is therefore the only place that can count either.
 * This module's part is to ask **before it reads a body** and to render the
 * answer as HTTP.
 * ------------------------------------------------------------------------- */

/**
 * Renders a write refusal - the object `repository.checkWriteAdmission` returns,
 * or the error `repository.addActivity` rejects with - as the response it
 * deserves.
 *
 * Dispatch is on the stable `code` alone, never on a message, exactly as the
 * duplicate mapping is. A refusal this module does not recognise yields `null`,
 * which keeps an unknown discriminator from being answered with a sentence that
 * describes something else; such a rejection falls through to the caller's
 * existing handling.
 *
 * @param {unknown} refusal The refusal or rejection to classify.
 * @param {string} studentId The normalized identifier, for the per-student
 *   sentence.
 * @returns {{status: number, code: string, message: string, headers?: Record<string, string>}|null}
 *   The response to send, or `null` when this is not a write-admission refusal.
 */
const describeWriteRefusal = (refusal, studentId) => {
  if (refusal === null || typeof refusal !== 'object') return null;

  if (refusal.code === REPOSITORY_QUEUE_FULL_CODE) {
    return {
      status: STATUS_SERVICE_UNAVAILABLE,
      code: CODE_WRITE_QUEUE_FULL,
      message: MESSAGE_WRITE_QUEUE_FULL,
      // The one header that makes a 503 actionable: the queue drains, so the
      // client is told when to come back rather than left to guess.
      headers: { 'Retry-After': RETRY_AFTER_SECONDS }
    };
  }

  if (refusal.code === REPOSITORY_STUDENT_LIMIT_CODE) {
    return {
      status: STATUS_INSUFFICIENT_STORAGE,
      code: CODE_STUDENT_ACTIVITY_LIMIT_REACHED,
      message: messageStudentActivityLimit(studentId)
    };
  }

  if (refusal.code === REPOSITORY_REGISTRY_FULL_CODE) {
    return {
      status: STATUS_INSUFFICIENT_STORAGE,
      code: CODE_REGISTRY_FULL,
      message: MESSAGE_REGISTRY_FULL
    };
  }

  return null;
};

/**
 * Whether a value is a live write reservation the repository handed out.
 *
 * @param {unknown} value The candidate.
 * @returns {boolean} `true` for an admitted reservation handle.
 */
const isWriteReservation = (value) =>
  isPlainObject(value) && value.admitted === true && typeof value.release === 'function';

/**
 * **Acquires** the write capacity a `POST` needs, or refuses the request,
 * **before a single body byte is read**.
 *
 * Acquiring rather than checking is the point, and it is what a check could
 * never do: a check answers "is there room", and by the time the caller acts on
 * that answer every other caller has been told the same thing - so N
 * simultaneous requests would all pass a gate over an empty queue and all go on
 * to hold a socket, listeners and up to 8 KiB of buffered body before any of
 * them was counted. A reservation is *taken*, so N requests take N distinct
 * slots and the next is refused immediately. The slot then covers the expensive
 * part of a write - the request in progress - and not merely the task it
 * eventually becomes.
 *
 * The position is equally deliberate: after the identifier has been validated
 * and resolved, and before the media type is examined or any body is buffered.
 * A refusal is therefore an *early* error, carrying `Connection: close` and
 * abandoning the request stream like every other pre-body rejection, so a
 * client is not left writing an upload into a request that has already been
 * answered.
 *
 * Nothing is logged here. A refusal is an expected, client-visible condition,
 * and writing a line per refused request would turn a flood of them into a
 * second, unbounded resource (CWE-779) - the very failure mode this mechanism
 * exists to prevent.
 *
 * A repository that refuses without a discriminator this module recognises is
 * treated as a refusal all the same, answered as a queue-full `503`: no slot was
 * acquired, so proceeding would be proceeding unbounded. That branch is
 * unreachable with this project's repository and exists so the control cannot
 * fail open.
 *
 * @param {{directory: object, repository: object}} deps The injected context.
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response.
 * @param {string} studentId The normalized, existing identifier.
 * @returns {{admitted: true, release: () => void}|null} The acquired
 *   reservation, or `null` when a refusal has been written and the caller must
 *   stop.
 */
const admitWrite = (deps, state, req, res, studentId) => {
  const reservation = deps.repository.reserveWrite(studentId);
  if (isWriteReservation(reservation)) return reservation;

  const refusal = isPlainObject(reservation) ? reservation.refusal : null;
  const response = describeWriteRefusal(refusal, studentId) ?? {
    status: STATUS_SERVICE_UNAVAILABLE,
    code: CODE_WRITE_QUEUE_FULL,
    message: MESSAGE_WRITE_QUEUE_FULL,
    headers: { 'Retry-After': RETRY_AFTER_SECONDS }
  };

  sendEarlyError(
    state,
    req,
    res,
    response.status,
    response.code,
    response.message,
    response.headers
  );
  return null;
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
 * the duplicate discriminator becomes `409` with this contract's sentence, the
 * three write-bound discriminators become the `503` or `507` that
 * `describeWriteRefusal` selects, and every remaining failure becomes the one
 * `500`, with the real error on stderr. A bound reached here rather than at the
 * boundary gate is either a race the gate cannot close - several requests pass
 * it and then read their bodies concurrently - or the registry's byte ceiling,
 * which only the repository can judge. The chain ends in a catch of its own, so
 * neither a rejection nor a failure while writing the response can ever become
 * an unhandled rejection.
 *
 * @param {{directory: object, repository: object}} deps The injected context.
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response.
 * @param {string} studentId The normalized, existing identifier.
 * @param {string} activity The validated, trimmed activity name.
 * @param {{admitted: true, release: () => void}} reservation The write slot this
 *   request acquired at the boundary. It is handed to `addActivity`, which owns
 *   its release from that point on.
 * @returns {void}
 */
const recordActivity = (deps, state, req, res, studentId, activity, reservation) => {
  Promise.resolve()
    .then(() => deps.repository.addActivity(studentId, activity, reservation))
    .then((record) => {
      if (!isPlainObject(record)) {
        throw new Error('addActivity resolved without a record');
      }
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

      // A bound reached between the boundary's gate and the repository's own
      // check - or one only the repository can judge, the registry's size,
      // which is measured on the bytes a write would produce. The body has
      // already been read by now, so this is an ordinary response rather than
      // an early one, and it is emphatically not a `500`: nothing failed, the
      // write was declined, and the sentence has to say so.
      const refusal = describeWriteRefusal(error, studentId);
      if (refusal !== null) {
        sendError(
          state,
          req,
          res,
          refusal.status,
          refusal.code,
          refusal.message,
          refusal.headers
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
 * Handles a `POST` from write admission onwards, in the fixed order: admission,
 * then media type, then body size, then parsing and field validation, then the
 * write. The identifier has already been validated and resolved by the caller,
 * which is why an unknown student outranks an oversize or unparseable body.
 *
 * **Admission comes first, ahead of the media type**, and that placement is the
 * decision rather than an accident. Every stage after it interprets the
 * request - and interpreting a request means buffering up to 8 KiB of it - so
 * running admission first is what makes the bound worth having: while the
 * service is at capacity it reads no body at all. The cost, stated plainly: a
 * request that is *also* malformed is told it was refused for capacity rather
 * than told what was wrong with it, which is correct precedence for load
 * shedding and is deterministic either way. Identifier shape and existence
 * still outrank admission, so a `POST` to an unknown student is a `404` whatever
 * the service's load.
 *
 * @param {{directory: object, repository: object}} deps The injected context.
 * @param {{responded: boolean}} state Per-request write state.
 * @param {import('http').IncomingMessage} req The request.
 * @param {import('http').ServerResponse} res The response.
 * @param {string} studentId The normalized, existing identifier.
 * @returns {void}
 */
const handleStudentActivitiesCreate = (deps, state, req, res, studentId) => {
  const reservation = admitWrite(deps, state, req, res, studentId);
  if (reservation === null) return;

  // The slot is held from here until one of exactly two things happens: the
  // repository takes ownership of it along with the write, or this request ends
  // without one. `res`'s `'close'` covers every case of the second kind in one
  // place - a `415`, a `413`, a `400` from parsing or validation, a client that
  // disconnects mid-upload, and a half-open request the runtime eventually
  // times out - which is what makes a leaked slot impossible to write by
  // forgetting a branch. Releasing is idempotent, so the guard below is about
  // ownership rather than about safety.
  let transferred = false;
  res.once('close', () => {
    if (!transferred) reservation.release();
  });

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
    // Ownership passes with the call: `addActivity` releases the slot on every
    // outcome from here, so this request must not.
    transferred = true;
    recordActivity(deps, state, req, res, studentId, activity, reservation);
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
 * recovered from `rawPath` and capped at 64 characters, never the decoded value
 * and never the normalized one: a caller sees back exactly what they sent, down
 * to the escape sequence they wrote. The normalized identifier reaches a
 * message in one place only, the `409` sentence, and it reaches the `200` and
 * `201` payloads as the `studentId` field.
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
 * Creates the API request handler - this module's only export.
 *
 * Both dependencies are **injected**, because `server.js` is the single
 * composition root: the workbooks are read exactly once per process, and a test
 * can exercise these routes against data no workbook expresses - a student with
 * zero activities, a registry duplicate, a writer that fails - through the same
 * wiring production uses.
 *
 * The returned handler decides recognition and writes, or declines,
 * **synchronously**, so its caller can act on the boolean immediately; a `POST`
 * continues reading its body and persisting after `true` has been returned.
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
 *     addActivity: (id: unknown, activity: unknown, reservation?: {admitted: true, release: () => void}) => Promise<{studentId: string, activity: string, source: string}>,
 *     reserveWrite: (id: unknown) => {admitted: true, release: () => void}|{admitted: false, refusal: {code: string}}
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
