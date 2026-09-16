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
 *     the delegation, answered `500 internal_error`. Measured on the pinned
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
    // The stack goes to the log and nowhere else. The body carries the error
    // code and nothing more — no stack, no filesystem path, no internal
    // detail — because a client learns nothing useful from them and an
    // attacker does.
    console.error(`request failed ${req.method} ${req.url}:`, err);
    // Checked BEFORE writing: once headers are out the response cannot be
    // corrected, and writing anyway throws ERR_HTTP_HEADERS_SENT and kills the
    // process. Destroying the socket is the only honest signal left.
    if (res.headersSent) { res.destroy(); return; }
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'internal_error' }) + '\n');
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
// module actually bound rather than re-derived by the caller.
module.exports = { server, hostname, port };
