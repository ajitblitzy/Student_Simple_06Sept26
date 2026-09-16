/**
 * server.js — the HTTP listener, and the one place the system boundary is drawn.
 *
 * WHAT CHANGED, AND WHAT DID NOT
 * ------------------------------
 * This file used to answer every method on every path with the same fixed
 * 34-byte greeting: `req` was a declared parameter that no statement
 * dereferenced, and there was no routing, no asynchrony, no failure handling
 * and no export. The `/activities` feature is integrated here by a single
 * delegation branch, and by nothing else.
 *
 * `activities.handle` returns `true` when it has claimed AND answered the
 * request, `false` when the path lies outside its namespace — and on `false` it
 * has written nothing to `res`, not a status and not a header. That one bit is
 * the whole integration surface, which is why the boundary reads as one `if`
 * that returns early followed by the three legacy statements, untouched. Every
 * path outside `/activities` — `/`, `/nonsense`, and the lookalikes
 * `/activities-old` and `/activitieslist` — therefore still receives that
 * greeting byte for byte. The namespace predicate is `activities.js`'s to own;
 * no routing logic lives here.
 *
 * ERROR OWNERSHIP, SPLIT TWO WAYS
 * -------------------------------
 * This file owns exactly two failures, and they are not interchangeable:
 *
 *   - REQUEST faults — anything thrown or rejected inside `activities.handle`
 *     that the feature did not anticipate. Owned by the `try`/`catch` around
 *     the delegation, answered `500 internal_error` in the same two-field
 *     `{ error, message }` envelope every other failure uses, and recorded as
 *     one fixed-shape log line built from allow-listed fields only. Measured
 *     on the pinned
 *     runtime: when an `async` handler rejects with nothing catching it,
 *     `server.on('error')` does not fire, `uncaughtException` does not fire,
 *     the client receives NO response at all and the request hangs until the
 *     caller's own timeout, and the process then terminates. The `try` is
 *     therefore mandatory, not stylistic.
 *   - LISTENER faults — a failure to bind, such as `EADDRINUSE`. Owned by the
 *     `'error'` listener below, which logs the code and exits non-zero instead
 *     of terminating on an unhandled `'error'` event.
 *
 * Every FORESEEABLE failure belongs to neither: an unreadable workbook, an
 * unreadable store, a failed write and every validation refusal are caught and
 * mapped inside `activities.js` and `activity-store.js`, and arrive here as an
 * answered response with `handle` returning `true`. That mapping is not
 * duplicated here — doing so would report a failure that did not happen.
 *
 * THE COMPOSITION SEAM
 * --------------------
 * `server.listen` used to run at module top level, so merely loading this file
 * bound TCP port 3000 as a side effect while yielding an object with no keys —
 * nothing could be driven by a test harness. The main-module guard and
 * `module.exports` fix that: `node server.js` behaves identically because the
 * guard is true, while loading the module from a harness binds nothing. This is
 * a declared, deliberate behaviour change.
 *
 * GOVERNING RULE: `Ajit_AddNewFeature_Rule`
 * -----------------------------------------
 * Summarized, never reproduced. Its SYSTEM BOUNDARIES area is why the boundary
 * is one early-returning `if` above three untouched statements rather than
 * logic woven through them. Its MINIMAL CHANGE AND DISCIPLINE area is why the
 * host and port stay bare literals that read no environment variable, why the
 * greeting's wording and its charset-less `text/plain` header are left exactly
 * as found, and why there is no request logging, no metrics, no health
 * endpoint, no graceful-shutdown handler, no CORS header and no second route.
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
 * The `500` body, in the two-field envelope EVERY error response uses.
 *
 * The authoritative response matrix admits exactly one error shape — a stable
 * machine-readable `error` code and a fixed English `message` sentence for
 * that code — and `internal_error` is one of its rows, so this boundary is no
 * exception to it: a client parsing failures gets one schema whether the fault
 * was anticipated or not. The sentence is a literal. It is never interpolated,
 * never derived from the thrown value, and carries no stack, no filesystem
 * path and no internal detail, because a client learns nothing useful from
 * those and an attacker does. Frozen, so a fault path cannot mutate the one
 * body every fault shares.
 */
const INTERNAL_ERROR_BODY = Object.freeze({
  error: 'internal_error',
  message: 'The request could not be completed because of an unexpected internal error.',
});

/** The stable event code that opens the request-failure log line. */
const REQUEST_FAILURE_EVENT = 'request_handler_failed';

/** What a log field holds when its value is absent or fails its allow-list. */
const LOG_FIELD_UNAVAILABLE = '-';

/** The ceiling on the logged pathname, in characters. */
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
    // destructured at require time, so the exported seam stays patchable: the
    // suite replaces this property to drive the `catch` below, which is
    // otherwise unreachable because every foreseeable fault is already mapped
    // upstream. Decided on the return value alone; `res` is never inspected.
    if (await activities.handle(req, res)) return;
  } catch (err) {
    // One pre-formatted line, from allow-listed fields only — never the thrown
    // value itself, and never the raw request target. What the naive form
    // emits instead was measured on this codebase: `console.error(msg, err)`
    // printed the Error's inspected form, which named the absolute path of
    // every source file in the stack, and `${req.url}` would have carried the
    // query string a caller controls. Both are the operator's log rather than
    // the client's response, and both are exactly where a store path or a
    // submitted label leaks without anyone noticing.
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
    // Returns so control never reaches the legacy response below.
    return;
  }

  // PRESERVED VERBATIM — the three statements below are character-identical to
  // the pre-feature file, down to the absent `charset` parameter. The body is
  // exactly 34 bytes and `test/lifecycle.test.js` asserts its sha256, so this
  // is the fall-through for every request `activities.handle` declined.
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello, World Welcome to Sharebot!\n');
});

/**
 * Listener faults only — a failure to bind, overwhelmingly `EADDRINUSE`.
 *
 * Without this listener an unhandled `'error'` event terminates the process on
 * a stack trace, which reads as a crash rather than as "the port is held"; the
 * test harness's pre-flight check depends on the difference. `process.exitCode`
 * rather than `process.exit()` so the log is flushed before the process leaves:
 * a failed bind holds no handle, so the loop drains immediately and the exit is
 * still non-zero.
 *
 * This cannot substitute for the request-level `try`/`catch` above, and that
 * `catch` cannot substitute for this: a rejected handler never reaches here.
 */
server.on('error', (err) => {
  console.error(`server error: ${err.code ?? err.message}`);
  process.exitCode = 1;
});

// Listening is now a main-module behaviour rather than a load-time side effect.
// The call and its readiness line are preserved unchanged — the guard's braces
// and the two spaces of indentation they impose are the only difference — so
// `node server.js` still prints exactly one `Server running at ...` line.
if (require.main === module) {
  server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);
  });
}

// The composition seam. `server` is the live instance, so a harness can listen
// on an ephemeral port; `hostname` and `port` are exported as the values this
// module actually bound rather than re-derived by the caller. All three have a
// consumer: `test/activities.test.js` listens on the exported `server` and
// asserts this export's exact key set, that `hostname` is the loopback literal
// the listener binds, and that `port` is 3000 — so a drift in either literal
// fails a test rather than passing unnoticed.
module.exports = { server, hostname, port };
