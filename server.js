/**
 * server.js — the HTTP listener, and the one place the system boundary is drawn.
 *
 * THE BOUNDARY
 * ------------
 * `activities.handle(req, res)` sees every request first and returns the one
 * bit this file routes on: `true` when it has claimed AND answered the
 * request, `false` when the path lies outside the `/activities` namespace —
 * and on `false` it has written nothing to `res`, not a status and not a
 * header. That one bit is the whole integration surface, which is why the
 * boundary reads as one `if` that returns early followed by the three
 * fall-through statements. The namespace predicate is `activities.js`'s to
 * own; no routing logic lives here. Every path outside `/activities` — `/`,
 * `/nonsense`, and the lookalikes `/activities-old` and `/activitieslist` —
 * is answered by those fall-through statements at the foot of the handler.
 *
 * ERROR OWNERSHIP, SPLIT TWO WAYS
 * -------------------------------
 * This file owns exactly two failures, and they are not interchangeable:
 *
 *   - REQUEST faults — anything thrown or rejected inside `activities.handle`
 *     that the feature does not anticipate. Owned by the `try`/`catch` around
 *     the delegation, answered `500 internal_error` in the same two-field
 *     `{ error, message }` envelope every other service-generated failure
 *     uses, and recorded as one fixed-shape log line built from allow-listed
 *     fields only.
 *   - LISTENER faults — a failure to bind, such as `EADDRINUSE`. Owned by the
 *     `'error'` listener below, which logs the code and exits non-zero instead
 *     of terminating on an unhandled `'error'` event.
 *
 * The `try` is mandatory rather than stylistic: when an `async` handler
 * rejects with nothing catching it, `server.on('error')` does not fire and
 * `uncaughtException` does not fire, so the client receives NO response at all
 * and the request hangs until the caller's own timeout, and the process then
 * terminates on the unhandled rejection.
 *
 * Every FORESEEABLE failure belongs to neither: an unreadable workbook, an
 * unreadable store, a failed write and every validation refusal are caught and
 * mapped inside `activities.js` and `activity-store.js`, and arrive here as an
 * answered response with `handle` returning `true`. That mapping is not
 * duplicated here — duplicating it would report a failure that did not happen.
 *
 * THE COMPOSITION SEAM
 * --------------------
 * The main-module guard at the foot of the file separates execution from
 * loading: running this file directly listens on the host and port below and
 * prints the readiness line, while loading it as a module binds nothing and
 * leaves the exported server for the caller to listen on.
 */

const http = require('http');
const activities = require('./activities');

const hostname = '127.0.0.1';
const port = 3000;

/* ------------------------------------------------------------------------- *
 * The rejection boundary's two fixed outputs
 *
 * A boundary reached only by something nothing anticipated cannot describe
 * what happened without describing internals. So both of its outputs are
 * built from constants and allow-listed fields rather than from the fault:
 * the body says the same thing every time, and the log line says only what a
 * fixed shape admits. Everything below exists to keep that promise without
 * ever throwing — a throw inside the `catch` would leave the request
 * unanswered, which is the exact failure the `catch` is there to stop.
 * ------------------------------------------------------------------------- */

/**
 * The `500` body, in the two-field envelope every error this service generates
 * uses.
 *
 * The response contract admits exactly one shape for a service-generated
 * error — a stable machine-readable `error` code and a fixed English `message`
 * sentence for that code — and `internal_error` is one of its rows, so this
 * boundary is no exception to it: a client parsing failures gets one schema
 * whether the fault was anticipated or not. One class of failure sits outside
 * that shape because it is answered before this handler runs: the runtime
 * rejects a request it cannot read with a bodyless response carrying no
 * envelope at all — an oversized header block gets `431` and an unparseable
 * request line gets `400`, each with no body to put an `error` code in.
 * The sentence is a literal. It is never interpolated, never derived from the
 * thrown value, and carries no stack, no filesystem path and no internal
 * detail, because a client learns nothing useful from those and an attacker
 * does. Frozen, so a fault path cannot mutate the one body every fault shares.
 */
const INTERNAL_ERROR_BODY = Object.freeze({
  error: 'internal_error',
  message: 'The request could not be completed because of an unexpected internal error.',
});

const REQUEST_FAILURE_EVENT = 'request_handler_failed';

/** What a log field holds when its value is absent or fails its allow-list. */
const LOG_FIELD_UNAVAILABLE = '-';

/**
 * 120 characters sits far above the longest target this service routes —
 * `/activities/S001` is 16 characters — so a real pathname is never
 * truncated, while an arbitrarily long target cannot grow the line unbounded.
 */
const LOG_PATH_MAX_CHARS = 120;

/**
 * The shape a log field's value must have to be emitted as it stands: one
 * bounded run of token characters. Anything else becomes the placeholder,
 * which is what stops a hostile `name` or `code` from injecting a newline, a
 * space, or a second field into the line.
 */
const LOG_TOKEN = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * A base for `new URL`. Never used as an address and never sent anywhere: a
 * request target is relative, so it needs a base before a pathname can be read
 * off it. `activities.js` parses the target the same way for routing, but its
 * helper is private to that module and normalizes for the route table rather
 * than for a log, so this one is deliberately separate.
 */
const LOG_RESOLUTION_BASE = 'http://localhost';

/**
 * Reduces a raw request target to the bounded pathname that may be logged.
 *
 * `req.url` is the untrusted request target and it carries the query string,
 * so logging it verbatim would record whatever a caller chose to park there —
 * an activity label or a Student ID among them. Parsing it and taking
 * `pathname` drops the query, the fragment, and any authority a proxy-form
 * target carried, and percent-encodes control characters on the way; the
 * filter and the length cap are belt to that brace, so the field can carry no
 * whitespace, cannot break the line's shape, and cannot grow without bound.
 *
 * @param {unknown} target A request target, not assumed to be a string.
 * @returns {string} A bounded, printable pathname, or the placeholder when the
 *   target is not a string or cannot be parsed.
 */
function loggablePath(target) {
  if (typeof target !== 'string') {
    return LOG_FIELD_UNAVAILABLE;
  }

  let pathname;
  try {
    pathname = new URL(target, LOG_RESOLUTION_BASE).pathname;
  } catch {
    return LOG_FIELD_UNAVAILABLE;
  }

  const printable = pathname.replace(/[^!-~]/g, '?');
  return printable.length > LOG_PATH_MAX_CHARS
    ? `${printable.slice(0, LOG_PATH_MAX_CHARS)}...`
    : printable;
}

/**
 * Reduces a request method to a loggable token.
 *
 * The runtime answers an unrecognized method token with its own `400` before
 * this handler runs, so this check is not expected to fire; it is here so the
 * line's shape is guaranteed by this function rather than by that assumption.
 *
 * @param {unknown} method A request method, not assumed to be a string.
 * @returns {string} The method, or the placeholder.
 */
function loggableMethod(method) {
  return typeof method === 'string' && LOG_TOKEN.test(method)
    ? method
    : LOG_FIELD_UNAVAILABLE;
}

/**
 * Reduces a thrown value to an allow-listed category and sub-code.
 *
 * What is deliberately NOT taken: the `message`, the `stack`, any `cause`, and
 * the value itself. A store or reader fault builds its message from the
 * configured store path or a record value and chains the underlying fault as a
 * `cause`, so an inspected Error here is a filesystem layout and a record
 * value in the log. The name and the code tell one category of fault from
 * another, which is all this line is for.
 *
 * @param {unknown} err Whatever was thrown — not assumed to be an `Error`.
 * @returns {{category: string, code: string}} Two token-safe fields.
 */
function loggableFault(err) {
  if (err === null || typeof err !== 'object') {
    return { category: 'primitive', code: typeof err };
  }

  const name = typeof err.name === 'string' && LOG_TOKEN.test(err.name)
    ? err.name
    : 'Error';
  const code = typeof err.code === 'string' && LOG_TOKEN.test(err.code)
    ? err.code
    : LOG_FIELD_UNAVAILABLE;

  return { category: name, code };
}

/**
 * Builds the one line the request boundary logs.
 *
 * One `console.error` argument, and a string rather than the thrown value:
 * handing an object to `console.error` prints its inspected form — name,
 * message, stack with absolute source paths, and recursively any `cause` — and
 * can run a custom inspection the thrown object defines. A single
 * pre-formatted string can do none of that.
 *
 * Every field is resolved inside the `try` because reading a property off an
 * arbitrary thrown value can itself throw, and this function must not: it runs
 * inside the `catch` that owns unanswered requests, so a throw here would
 * produce the hung socket that `catch` prevents. The fields are assigned as
 * they resolve, because a partial line beats no line at all.
 *
 * @param {import('node:http').IncomingMessage} req The failed request.
 * @param {unknown} err Whatever was thrown.
 * @returns {string} `request_handler_failed method=… path=… error=… code=…`
 */
function requestFailureLine(req, err) {
  let method = LOG_FIELD_UNAVAILABLE;
  let path = LOG_FIELD_UNAVAILABLE;
  let fault = { category: LOG_FIELD_UNAVAILABLE, code: LOG_FIELD_UNAVAILABLE };

  try {
    method = loggableMethod(req.method);
    path = loggablePath(req.url);
    fault = loggableFault(err);
  } catch {
    // Left as whatever resolved before the throw. There is nothing safe to say
    // about a value whose own property access fails.
  }

  return `${REQUEST_FAILURE_EVENT} method=${method} path=${path}` +
    ` error=${fault.category} code=${fault.code}`;
}

const server = http.createServer(async (req, res) => {
  try {
    // The delegation branch — the only place the feature can claim a request.
    // `handle` is read off the module object at call time rather than
    // destructured at require time, so the exported seam stays late-bound and
    // a caller holding this same module instance can substitute it. The branch
    // is decided on the return value alone; `res` is never inspected.
    if (await activities.handle(req, res)) return;
  } catch (err) {
    // One pre-formatted line, from allow-listed fields only — never the thrown
    // value itself, whose inspected form names the absolute path of every
    // source file in its stack, and never the raw request target, whose query
    // string is caller-controlled and can carry a Student ID or an activity
    // label. The operator's log is exactly where such a value leaks unnoticed.
    console.error(requestFailureLine(req, err));
    // Checked BEFORE writing: once headers are out the response cannot be
    // corrected, and writing anyway throws ERR_HTTP_HEADERS_SENT and kills the
    // process. Destroying the socket is the only honest signal left.
    if (res.headersSent) { res.destroy(); return; }
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // The shared two-field envelope. The body carries the stable code and its
    // fixed sentence and nothing else — no stack, no filesystem path, no
    // internal detail — because a client learns nothing useful from those and
    // an attacker does.
    res.end(JSON.stringify(INTERNAL_ERROR_BODY) + '\n');
    return;
  }

  // The fall-through for every request `activities.handle` declined: `200`
  // with a `Content-Type: text/plain` that carries no `charset` parameter, and
  // a body of exactly 34 bytes. Both the header and the body are exact — the
  // header down to that absent parameter, the body down to its final newline.
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello, World Welcome to Sharebot!\n');
});

/**
 * Listener faults only — a failure to bind, overwhelmingly `EADDRINUSE`.
 *
 * Without this listener an unhandled `'error'` event terminates the process on
 * a stack trace, which reads as a crash rather than naming the condition that
 * caused it. `process.exitCode` rather than `process.exit()` so the log is
 * flushed before the process leaves: a failed bind holds no handle, so the loop
 * drains immediately and the exit is still non-zero.
 *
 * This cannot substitute for the request-level `try`/`catch` above, and that
 * `catch` cannot substitute for this: a rejected handler never reaches here.
 */
server.on('error', (err) => {
  console.error(`server error: ${err.code ?? err.message}`);
  process.exitCode = 1;
});

// Direct execution listens on the host and port above and prints exactly one
// `Server running at ...` readiness line; loading this file as a module binds
// nothing.
if (require.main === module) {
  server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);
  });
}

// The composition seam. `server` is the live instance — the listening one under
// direct execution, and unbound when this file is loaded as a module, so a
// caller can listen on a port of its own choosing. `hostname` and `port` are
// the values the guarded `listen` call above uses, exported so a caller can
// address the service without re-deriving the literals.
module.exports = { server, hostname, port };
