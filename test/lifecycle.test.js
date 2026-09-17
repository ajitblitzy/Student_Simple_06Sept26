'use strict';

/**
 * test/lifecycle.test.js — the PROCESS-level suite.
 *
 * SCOPE
 * -----
 * This file spawns `node server.js` as a child process, the way an operator
 * runs it: the same runtime, the same entry point, the literal port 3000. That
 * is what lets it assert the process-level facts — what the service actually
 * writes to stdout and stderr, how many times, the exit disposition of a
 * refused bind, the exit disposition of a misconfigured store path that stops
 * the service loading at all, and that the process carries on serving after a
 * refused store write — and it asserts the preserved response and the
 * `/activities` namespace boundary against that spawned instance, end to end
 * over a real socket.
 *
 * Each of `server.js`'s three failure dispositions is asserted here as the
 * exact bytes it writes: a refused bind, a refused startup, and a refused
 * store write. All three are meant to be one legible line rather than a stack
 * trace, and an assertion weaker than an exact one would pass against the very
 * dump it is named for.
 *
 * SERIAL ONLY
 * -----------
 * `port = 3000` is a bare literal in `server.js` with no environment override,
 * so this file must be the only thing binding it while it runs. The runner uses
 * a separate process per test file, which is why the project's test script is
 * `node --test --test-concurrency=1` with NO positional argument — a bare
 * `test/` directory argument makes Node treat the directory as a module to
 * load, which fails and runs no tests at all.
 *
 * CONSTRAINTS THE CASES BELOW DEPEND ON
 * -------------------------------------
 *   - NO ORPHANS. Every child is tracked, killed, and awaited to its `'close'`
 *     event, and the port is polled until it is actually released before the
 *     next child binds it. An orphan would hold port 3000 and make every later
 *     case fail for a reason that has nothing to do with the code under test.
 *   - EVERY WAIT IS BOUNDED, AND EVERY BOUND IS ENFORCED — the readiness gate,
 *     the kill, the `SIGKILL` escalation, an HTTP exchange. A deadline that
 *     expires is a reported failure carrying its diagnosis, never a wait that
 *     continues, because an unbounded wait in a test turns a legible product
 *     defect into a runner that never finishes and explains nothing.
 *   - THE PORT IS ACQUIRED FAIL-FAST, AND RELEASED PATIENTLY. A held port is an
 *     environment condition this file cannot fix, so it is reported at once,
 *     naming the port and the code. Waiting is confined to the other
 *     direction: after this file's own child is reaped, it polls until the
 *     socket that child owned is actually free.
 *   - A FAILURE MESSAGE SAYS WHAT IS NEEDED AND NO MORE. These messages
 *     outlive the run in logs and JUnit artifacts, read by people who were not
 *     there, so a child's raw output is never reproduced: diagnostics carry
 *     the exit disposition, a line count, a byte length, a short digest, and a
 *     bounded preview with paths redacted and stack frames collapsed.
 *   - NOTHING IS WRITTEN INTO THE CHECKOUT. Every child is given
 *     `ACTIVITY_STORE` pointing inside a `mkdtemp` directory that is removed
 *     afterwards. Without it a child would materialise `activities.json` in the
 *     repository root, because that is the store's documented default.
 *   - NO RELIANCE ON `--test-force-exit`. This file is child-process-driven,
 *     and the one case that requires `../server` binds port 0 and closes that
 *     listener in a `finally` on a bounded deadline, so no listener outlives
 *     the run — requiring the module binds nothing, which that case asserts.
 *     Every request is made with `agent: false` and `Connection: close`, so no
 *     keep-alive socket outlives its response; the handle that would hold the
 *     loop open is an exchange that never settled, which the deadlines below
 *     prevent. If the runner ever hangs on this file, that is a defect in this
 *     file.
 *   - THE ASSERTIONS DESCRIBE THE RESPONSE AS IT SHIPS. The `Content-Type` of
 *     the preserved response is asserted to be exactly `text/plain`, with no
 *     charset parameter, because that absence is preserved behaviour and this
 *     suite exists to notice if someone "corrects" it.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

/* ========================================================================= *
 * The service under test, and where it lives
 * ========================================================================= */

/**
 * Resolved from `__dirname` rather than written as a relative path, because
 * the working directory a runner is invoked from is not guaranteed. The child
 * is given the same directory as its `cwd` so it resolves the workbooks and
 * its default store exactly as `npm start` would.
 */
const REPOSITORY_ROOT = path.join(__dirname, '..');
const SERVER_ENTRY_POINT = path.join(REPOSITORY_ROOT, 'server.js');

/** The loopback address and the literal port the service binds. */
const HOST = '127.0.0.1';
const PORT = 3000;

/* ========================================================================= *
 * Gold values
 *
 * Written as independent literals rather than derived at run time from the
 * service's own output, because a value the service computes cannot be
 * evidence about the service. Each one therefore has to be stated here and
 * compared.
 * ========================================================================= */

/** The preserved response body: 34 bytes, trailing newline included. */
const GOLD_BODY = 'Hello, World Welcome to Sharebot!\n';
const GOLD_BODY_BYTES = 34;
const GOLD_BODY_SHA256 = '6bdf54b2103060907f4da9765e353673aa0c0d28afaad83bfe42f139963bbb10';

/**
 * The preserved `Content-Type`, asserted as an EXACT string: `text/plain` with
 * no `charset` parameter. A `startsWith` check here would silently accept
 * `text/plain; charset=utf-8`, which is a different response.
 */
const GOLD_CONTENT_TYPE = 'text/plain';
const GOLD_STATUS = 200;

/**
 * The readiness line, emitted once from the listen callback.
 *
 * It is the only line a CLEAN startup writes, which is not the same as the
 * service's only log line: a refused bind, the request boundary in `server.js`
 * and the feature's own refusal diagnostics all write to stderr when they
 * happen. So this literal is the signal that startup succeeded, and the
 * stdout-line count asserted alongside it is a claim about a process that has
 * started and failed at nothing — never a claim that the service is silent
 * under failure.
 */
const READINESS_LINE = 'Server running at http://127.0.0.1:3000/';

/**
 * The HANDLED bind failure, as `server.js`'s `'error'` listener reports it: one
 * stderr line naming the code, `process.exitCode = 1`, and nothing on stdout at
 * all.
 *
 * This literal is what makes the EADDRINUSE group load-bearing. An UNHANDLED
 * `'error'` event also exits non-zero, also writes nothing to stdout, and also
 * contains the string `EADDRINUSE` inside its crash report — so a substring
 * test cannot tell the two dispositions apart, and a case built on one would
 * pass against the very regression it is named for.
 */
const HANDLED_BIND_ERROR_LINE = 'server error: EADDRINUSE';
const HANDLED_BIND_EXIT_CODE = 1;

/**
 * Fragments that belong to Node's unhandled-`'error'`-event report and to no
 * handled disposition: the `throw er;` re-throw, the `Emitted 'error' event`
 * report, the `node:events:` / `node:net:` internal frames, the decorated
 * error's `errno:` and `syscall:` properties, and the trailing `Node.js v…`
 * footer.
 *
 * Asserting their ABSENCE is what makes the EADDRINUSE case load-bearing: it
 * fails if anyone removes the `'error'` listener from `server.js`, which is
 * exactly the regression the group exists to catch.
 */
const UNHANDLED_CRASH_MARKERS = [
  "Unhandled 'error' event",
  "Emitted 'error' event",
  'throw er;',
  'node:events:',
  'node:net:',
  'errno:',
  'syscall:',
  'Node.js v',
];

/**
 * The HANDLED startup configuration fault, as `server.js`'s startup boundary
 * reports it: the same `server error: <CODE>` shape a refused bind uses, then
 * the error's own actionable sentence, `process.exitCode = 1`, and nothing on
 * stdout.
 *
 * Two lines rather than one, deliberately. The first is the shape an operator
 * or a start script gates on and is asserted EXACTLY. The second is the only
 * part of the fault that tells a reader what to change, and is asserted by the
 * three things it must name — see `PROTECTED_FAULT_SENTENCE_MARKERS` — rather
 * than verbatim, so rewording the sentence in `activity-store.js` does not
 * fail this file while an empty or unhelpful sentence still does.
 */
const HANDLED_STARTUP_FAULT_LINE = 'server error: E_STORE_PATH_PROTECTED';
const HANDLED_STARTUP_FAULT_EXIT_CODE = 1;

/**
 * What the second line must name: the variable to change, the file it resolved
 * to, and where to point it instead. A sentence missing any of the three is not
 * actionable, which is the whole justification for printing it at all.
 */
const PROTECTED_FAULT_SENTENCE_MARKERS = [
  'ACTIVITY_STORE',
  'xlsx-read.js',
  'outside the repository',
];

/**
 * The byte ceiling for that whole report.
 *
 * Measured rather than chosen: the two lines are 226 bytes, and the
 * uncaught-throw dump this disposition replaced was 1 421 bytes across 25
 * lines. 512 leaves room for a longer protected file name while failing long
 * before anything resembling a stack dump could fit.
 */
const STARTUP_FAULT_STDERR_MAX_BYTES = 512;

/**
 * The character bound `server.js` caps that second line at, restated here so a
 * change to one without the other is caught rather than silently tolerated. The
 * real refusal sentence is comfortably inside it; the case that exercises the
 * cap fabricates a message far past it.
 */
const STARTUP_FAULT_DETAIL_MAX_CHARS = 400;

/**
 * Fragments that belong to Node's UNCAUGHT-THROW dump and to no handled
 * report: the module loader's internal frames, the runtime's version banner,
 * the re-thrown source line, and `diagnostic:` — which can only appear if the
 * error OBJECT was handed to `console.error` and printed in its inspected
 * form, rather than its `code` and `message` being printed as strings.
 *
 * Asserting their absence is what makes the group load-bearing: it fails if
 * anyone removes the startup boundary from `server.js`, which is the exact
 * regression it exists to catch.
 */
const UNCAUGHT_THROW_MARKERS = [
  'node:internal',
  'Node.js v',
  'throw error;',
  'diagnostic:',
  'RangeError:',
];

/**
 * An absolute filesystem path, in either platform's spelling: a drive letter
 * followed by a backslash, or a POSIX path of two or more segments. Not a
 * global regex, so `.test()` is stateless and cannot skip a match because of a
 * previous call's `lastIndex`.
 */
const ABSOLUTE_PATH_SHAPE = /[A-Za-z]:\\|(?:^|[\s(])\/[^\s/]+\/[^\s/]/;

/** Response media types the claimed namespace uses, for the boundary cases. */
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * A Student ID from the workbook key set (`S001`–`S010`) and the activity the
 * store seeds for it from the `Extracurricular Activity` column. Both are
 * synthetic repository data; no real student record appears in this suite.
 */
const SEEDED_STUDENT_ID = 'S001';
const SEEDED_ACTIVITY_LABEL = 'Robotics Club';
const RECORD_SOURCE_WORKBOOK = 'workbook';

/* ========================================================================= *
 * Bounded deadlines
 *
 * Every wait in this file is bounded. An unbounded wait turns a service that
 * failed to start into a suite that hangs, which is strictly worse than a
 * failure: it produces no diagnosis at all.
 * ========================================================================= */

const POLL_INTERVAL_MS = 50;
/** 100 polls x 50 ms = a 5-second readiness deadline. */
const READINESS_POLL_ATTEMPTS = 100;
/**
 * 100 polls x 50 ms = a 5-second deadline for a socket THIS FILE owned to be
 * released after its child is gone.
 *
 * A RELEASE wait, not a retry for contention. Acquiring the port is fail-fast:
 * a held port is an environment problem and is reported at once. What is waited
 * on here is different in kind — the child has already been reaped and the
 * question is whether the kernel has let go of the socket yet, which polling a
 * real bind attempt is the only honest way to answer.
 */
const PORT_RELEASE_POLL_ATTEMPTS = 100;
/** How long a child is given to close after being killed, or after a failed bind. */
const EXIT_DEADLINE_MS = 10000;
/**
 * How long a child is given to close AFTER `SIGKILL`.
 *
 * Shorter than the deadline above on purpose: a process that has been killed
 * uncatchably either goes immediately or is not going at all, and this branch
 * exists so that second case surfaces as a failed cleanup with the pid named
 * rather than as an unbounded wait — which would hang the runner and produce
 * no diagnosis whatsoever.
 */
const CLOSE_DEADLINE_MS = 5000;
/**
 * The absolute ceiling on one HTTP exchange, measured from the moment the
 * request is issued to the moment the response body ends.
 *
 * Without it a server that accepts a connection and never answers leaves the
 * promise pending forever, and a product defect becomes a suite that hangs and
 * reports nothing. Every response this file asserts on is a few hundred bytes
 * served from memory over loopback, so ten seconds is three orders of
 * magnitude of headroom.
 */
const REQUEST_DEADLINE_MS = 10000;
/**
 * The socket-inactivity ceiling for one HTTP exchange, applied through
 * `request.setTimeout`.
 *
 * It catches the same fault faster and more precisely than the absolute
 * deadline — a connection that is accepted and then goes silent trips this,
 * while the absolute deadline covers the other shape, a response that dribbles
 * bytes indefinitely without ever ending.
 */
const SOCKET_IDLE_DEADLINE_MS = 5000;
/**
 * How long a bare TCP connection attempt is given to settle.
 *
 * Generous on purpose. A refusal from a loopback address is immediate, but a
 * refusal from a routable address can take seconds to arrive, because the stack
 * retries the SYN before the reset comes back. A tighter bound would turn that
 * latency into a timeout, and `probeConnect` reports a timeout as its own
 * outcome, so the case would record the wrong observation.
 */
const CONNECT_DEADLINE_MS = 5000;
/**
 * A short settling period used where the assertion is about something NOT
 * happening — an extra log line, a second readiness line. Without it the
 * assertion would pass simply because the output had not arrived yet.
 */
const QUIET_PERIOD_MS = 300;
/**
 * How many consecutive unchanged polls make a child's captured output QUIET.
 *
 * Derived from the settling period above rather than chosen independently, so
 * the adaptive wait in `awaitOutputQuiescence` can never accept a shorter span
 * of silence than the fixed settle it replaces: at `POLL_INTERVAL_MS` per poll,
 * this many polls cover at least `QUIET_PERIOD_MS`. `Math.ceil` is what keeps
 * that true if either constant is ever retuned.
 */
const OUTPUT_QUIET_POLLS = Math.ceil(QUIET_PERIOD_MS / POLL_INTERVAL_MS);
/**
 * 100 polls x 50 ms = a 5-second ceiling on waiting for output to go quiet.
 *
 * The ceiling is what stops a child that never stops writing from turning a
 * settle into a hang. Reaching it is not itself a failure — see
 * `awaitOutputQuiescence` for why the wait returns there rather than throwing.
 */
const OUTPUT_QUIESCENCE_POLL_ATTEMPTS = 100;
/**
 * A generous per-case ceiling. It exists so a defect surfaces as a failed case
 * with a message rather than as a suite that never finishes; no healthy case
 * comes anywhere near it.
 */
const CASE_TIMEOUT_MS = 60000;

/* ========================================================================= *
 * Bounds on what a failure message may disclose
 *
 * A failing assertion in this file is retained — in a JUnit artifact, in a CI
 * log, in a pasted terminal buffer — and whoever reads it later is not
 * necessarily whoever ran it. A child's raw output can carry absolute
 * filesystem paths, stack frames naming internal module layout, and request
 * targets; the store path carries the layout of the host it ran on. None of
 * that is needed to act on a failure, and all of it survives in whatever kept
 * the report. So diagnostics here are deliberately bounded and redacted: a
 * count, a byte length, a short hash that identifies the output without
 * reproducing it, and a preview whose paths are replaced and whose stack
 * frames are collapsed.
 * ========================================================================= */

/** Enough previewed lines for a one-line disposition, or the head of a longer report. */
const OUTPUT_PREVIEW_LINES = 6;
/** Wide enough for a whole readiness or bind-error line, not for a dumped payload. */
const OUTPUT_PREVIEW_LINE_CHARS = 120;
/** Enough hex to compare two runs, not enough to reconstruct what was hashed. */
const OUTPUT_DIGEST_CHARS = 12;
const REDACTED_PATH = '<path>';
const REDACTED_TARGET = '<target>';
const REDACTED_STACK_FRAME = '<stack frame>';
const REDACTED_CODE = '<code>';
const REDACTED_SYSCALL = '<syscall>';

/* ========================================================================= *
 * Primitives
 * ========================================================================= */

/**
 * @param {number} ms Milliseconds to wait.
 * @returns {Promise<void>} Resolves after the delay. The timer is the only
 *   handle this file keeps, and it is always short-lived.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {Buffer} bytes Raw response bytes.
 * @returns {string} Lowercase hex sha256.
 */
function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Normalizes captured output to `\n` line endings, changing nothing else.
 *
 * `console.log` emits `\n` on every platform Node supports, so folding `\r\n`
 * is defensive rather than corrective: a stray carriage return must not turn
 * one line into two and fail an assertion that is really about how many times
 * the service logged.
 *
 * Nothing else is touched. In particular, blank lines are PRESERVED, which is
 * what lets the raw comparisons below be exact.
 *
 * @param {string} output Accumulated stdout or stderr.
 * @returns {string} The same output with `\n` line endings.
 */
function normalizeNewlines(output) {
  return output.replace(/\r\n/g, '\n');
}

/**
 * Splits captured output into lines, BLANK LINES INCLUDED.
 *
 * A blank line is output, and it is counted. The contract the assertions below
 * rest on is that a clean startup writes exactly ONE line to stdout, and a
 * service that emitted the readiness line followed by three blank ones has
 * written four lines, not one — filtering blanks out would silently satisfy
 * every assertion built on this helper.
 *
 * Exactly one trailing terminator is dropped — the `\n` that ends a normal
 * `console.log` — and nothing more, so `"a\n"` is one line while `"a\n\n"` is
 * two, the second of them empty.
 *
 * @param {string} output Accumulated stdout or stderr.
 * @returns {Array<string>} Every line, in order, blanks included.
 */
function outputLines(output) {
  const normalized = normalizeNewlines(output);

  if (normalized === '') {
    return [];
  }

  const withoutTerminator = normalized.endsWith('\n')
    ? normalized.slice(0, -1)
    : normalized;

  return withoutTerminator.split('\n');
}

/**
 * Races a promise against a deadline, and CLEARS THE LOSING TIMER.
 *
 * The obvious spelling of this — `Promise.race([work, sleep(ms)])` — is a
 * defect: the race settles as soon as the work finishes, but the sleep's timer
 * stays pending and keeps the event loop alive for its full duration. A suite
 * whose assertions take under a second then sits for as long as the longest
 * deadline it raced, which is indistinguishable from a hang and is the very
 * thing this file must not do. Clearing the timer in `finally` is what keeps
 * this file honest about not needing `--test-force-exit`.
 *
 * @template T
 * @param {Promise<T>} work The promise being waited on.
 * @param {number} ms The deadline in milliseconds.
 * @returns {Promise<boolean>} True when the work settled first, false when the
 *   deadline expired. A rejection from `work` propagates.
 */
function awaitWithDeadline(work, ms) {
  let timer = null;

  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });

  return Promise.race([work.then(() => true), deadline]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  });
}

/**
 * Counts how many of those lines are exactly the readiness line.
 *
 * Counting occurrences rather than testing for presence is the point: a
 * service that logged on every request would still "contain" the line, and the
 * contract is that it is emitted exactly once.
 *
 * @param {string} output Accumulated stdout.
 * @returns {number} The number of matching lines.
 */
function countReadinessLines(output) {
  return outputLines(output).filter((line) => line === READINESS_LINE).length;
}

/* ========================================================================= *
 * Redaction — what a retained failure report is allowed to say
 * ========================================================================= */

/**
 * One path segment: at least one token, and any number of further tokens
 * separated by single spaces.
 *
 * Space tolerance is not decoration. Absolute paths routinely contain spaces,
 * and a segment pattern that stopped at whitespace would redact the first token
 * and leave the rest of the path standing — the layout the redaction exists to
 * withhold, disclosed with only its prefix removed, which is worse than not
 * redacting at all because it reads as redacted.
 *
 * Quotes, angle brackets and pipes are excluded so a quoted path ends at its
 * closing quote, and a newline can never be crossed.
 */
const PATH_SEGMENT = '[^\\s\\\\/"\'<>|]+(?: [^\\s\\\\/"\'<>|]+)*';

/** A trailing query string, consumed as part of whatever it hangs off. */
const TRAILING_QUERY = '(?:\\?[^\\s"\'<>|]*)?';

/**
 * A Windows absolute path: a drive letter, a separator, then space-tolerant
 * segments and an optional query.
 *
 * The two guards on the root are what keep the pattern out of URLs. The drive
 * letter may not be preceded by an alphanumeric character, and the separator
 * may not be followed by a second one, so the `p://` of `http://` — a letter, a
 * colon, two slashes — cannot be taken for a drive root. Without them a URL is
 * redacted from its scheme onwards, which destroys the most informative line a
 * startup diagnostic carries.
 */
const WINDOWS_PATH = new RegExp(
  `(?<![A-Za-z0-9])[A-Za-z]:[\\\\/](?![\\\\/])(?:${PATH_SEGMENT}[\\\\/])*(?:${PATH_SEGMENT})?${TRAILING_QUERY}`,
  'g'
);

/**
 * A POSIX absolute path of TWO OR MORE segments, space-tolerant, with an
 * optional query.
 *
 * Two segments rather than one, deliberately: a single-segment rule matches the
 * lone trailing slash of `http://127.0.0.1:3000/` and would redact the readiness
 * line. Single-segment request targets are handled by their own rules below,
 * which are anchored on something a URL cannot supply.
 */
const POSIX_PATH = new RegExp(`(?:[\\\\/]${PATH_SEGMENT}){2,}[\\\\/]?${TRAILING_QUERY}`, 'g');

/**
 * A request target following an HTTP method token.
 *
 * This rule covers the METHOD-SPACE-TARGET shape wherever it turns up in a
 * child's captured output — a thrown value whose message quotes a request
 * line, a runtime or client diagnostic, any line written that way. A method
 * token is a reliable anchor for the target that follows it, and anchoring on
 * it is what lets the COMPLETE target go, query string included, whatever its
 * shape.
 *
 * `server.js` does not write that shape. Its request boundary emits one
 * structured line — `request_handler_failed method=… path=… error=… code=…` —
 * whose `path` field is already a bounded pathname with the query string
 * dropped before it is logged. A multi-segment value there is redacted by the
 * path rules above, which match a pathname wherever in a line it sits; a
 * single-segment value such as `/activities` is left standing, and carries
 * nothing to withhold once the query is gone. Both shapes are handled because
 * a redaction rule written for one log format is worth nothing on the day that
 * format changes.
 *
 * The target must begin with `/` or a scheme, so ordinary prose after a method
 * word (`DELETE failed because …`) is left alone.
 */
const REQUEST_TARGET = /\b(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT)(\s+)(?:https?:\/\/|\/)\S*/g;

/**
 * Any remaining slash-rooted token that carries a query string.
 *
 * This is the one-segment case — `/activities?token=…` — which the two-segment
 * POSIX rule cannot see. It is anchored on the `?`, so it fires only where
 * there is query data to lose, and the lookbehind keeps it out of a URL, whose
 * path is preceded by the host's last character or by the `//` of its scheme.
 */
const TARGET_WITH_QUERY = /(?<![A-Za-z0-9:\\/])[\\/][^\s"'<>|]*\?[^\s"'<>|]*/g;

/**
 * Replaces absolute filesystem paths and request targets with a marker.
 *
 * The rules are ORDERED, and the order is part of the contract: the
 * request-target rule runs first, so a target is reported as a target rather
 * than as a path. The rules that follow cover a Windows path whose segments
 * contain spaces, a POSIX path of two or more segments, and a one-segment
 * target carrying a query.
 *
 * Over-redaction is the safe direction, and it is bounded rather than
 * unlimited: no rule crosses a newline, a quote or an angle bracket, the
 * readiness line survives whole, and every previewed line is capped by
 * `OUTPUT_PREVIEW_LINE_CHARS` regardless. The cost is that a contrived prose
 * line containing a separator can be swallowed with the path beside it, which
 * is a legibility cost on a line that was disclosing a path anyway.
 *
 * Everything a reader actually acts on is reported separately and unredacted:
 * the exit code, the signal, the line count, the byte length, and the digest.
 *
 * @param {string} text One line of captured output.
 * @returns {string} The line with paths and request targets replaced.
 */
function redactPaths(text) {
  return text
    .replace(REQUEST_TARGET, `$1$2${REDACTED_TARGET}`)
    .replace(WINDOWS_PATH, REDACTED_PATH)
    .replace(POSIX_PATH, REDACTED_PATH)
    .replace(TARGET_WITH_QUERY, REDACTED_PATH);
}

/**
 * Reduces an error's `code` to a code, and nothing that merely travels with it.
 *
 * A code is a short uppercase token — `ENOENT`, `EACCES`, `EADDRINUSE`. Anything
 * else is replaced rather than passed through, because "it is the code field"
 * is not evidence that a value is safe to retain: see `syscallOperation`, where
 * exactly that assumption was wrong.
 *
 * @param {Error & {code?: unknown}} error The error to describe.
 * @returns {string} A safe code token.
 */
function errorCode(error) {
  const code = error.code;

  if (typeof code !== 'string') {
    return 'no code';
  }

  return /^[A-Z][A-Z0-9_]*$/.test(code) ? code : REDACTED_CODE;
}

/**
 * Reduces an error's `syscall` to the OPERATION it names, discarding its
 * argument.
 *
 * THIS IS NOT COSMETIC. `syscall` looks like a safe code token and is not one:
 * a failed `child_process.spawn` sets it to the operation AND its target, so
 * the field carries the absolute path of the executable that could not be
 * started. Retaining it verbatim would put that path into every diagnostic
 * mentioning the failure — precisely the disclosure the store path is reduced
 * to a basename to avoid.
 *
 * Only the leading token is kept, and only when it looks like an operation
 * name, so no argument can survive by construction rather than by a pattern
 * that has to anticipate its shape.
 *
 * @param {Error & {syscall?: unknown}} error The error to describe.
 * @returns {string} The operation name alone.
 */
function syscallOperation(error) {
  const syscall = error.syscall;

  if (typeof syscall !== 'string') {
    return 'no syscall';
  }

  const [operation] = syscall.trim().split(/\s+/, 1);
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(operation) ? operation : REDACTED_SYSCALL;
}

/**
 * Sanitizes and truncates one previewed line.
 *
 * A stack frame is collapsed whole rather than redacted piecemeal: its value
 * to a reader is that a stack was printed at all, which the collapsed marker
 * conveys, and its content is internal module layout.
 *
 * @param {string} line One line of captured output.
 * @returns {string} A line safe to retain in a failure report.
 */
function sanitizeLine(line) {
  if (/^\s*at\s/.test(line)) {
    return REDACTED_STACK_FRAME;
  }

  const redacted = redactPaths(line);

  if (redacted.length <= OUTPUT_PREVIEW_LINE_CHARS) {
    return redacted;
  }

  const withheld = redacted.length - OUTPUT_PREVIEW_LINE_CHARS;
  return `${redacted.slice(0, OUTPUT_PREVIEW_LINE_CHARS)}... (${withheld} more character(s) withheld)`;
}

/**
 * Summarizes a captured stream for a failure message.
 *
 * The summary is what a reader needs and no more: how many lines were written,
 * how many bytes, a short digest that identifies the output exactly enough to
 * compare two runs, and a bounded, sanitized preview. The full stream is never
 * reproduced, because reproducing it would put every stack frame and absolute
 * path the child printed into whatever retains the report.
 *
 * @param {string} label `'stdout'` or `'stderr'`.
 * @param {string} text The accumulated stream.
 * @returns {string} A bounded, redacted, multi-line summary.
 */
function summarizeOutput(label, text) {
  const lines = outputLines(text);
  const digest = sha256(Buffer.from(text, 'utf8')).slice(0, OUTPUT_DIGEST_CHARS);
  const header =
    `${label}: ${lines.length} line(s), ${Buffer.byteLength(text, 'utf8')} byte(s), ` +
    `sha256 ${digest}`;

  if (lines.length === 0) {
    return `${header} (empty)`;
  }

  const preview = lines
    .slice(0, OUTPUT_PREVIEW_LINES)
    .map((line) => `    | ${sanitizeLine(line)}`);

  if (lines.length > OUTPUT_PREVIEW_LINES) {
    preview.push(`    | ... ${lines.length - OUTPUT_PREVIEW_LINES} more line(s) withheld`);
  }

  return [header, ...preview].join('\n');
}

/* ========================================================================= *
 * The port: fail-fast acquisition, and waiting for this file's own release
 * ========================================================================= */

/**
 * Attempts to bind `127.0.0.1:3000` and immediately closes the listener.
 *
 * This is the pre-flight probe. It answers one question — can this suite have
 * the port — and it answers it with the ERROR CODE when it cannot, because
 * "the port is held" and "the code is broken" are different problems and a
 * reader has to be able to tell which one they are looking at.
 *
 * @returns {Promise<{available: boolean, code: string|null}>} `available` is
 *   true when the bind succeeded; `code` carries the failure code otherwise.
 */
function probePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();

    probe.once('error', (error) => {
      resolve({ available: false, code: error.code ?? error.message });
    });

    probe.once('listening', () => {
      probe.close(() => {
        resolve({ available: true, code: null });
      });
    });

    probe.listen(PORT, HOST);
  });
}

/**
 * Holds `127.0.0.1:3000` open so the probe can be shown to DETECT a held port.
 *
 * A probe that has only ever been observed succeeding is not evidence that it
 * works; this is how the pre-flight case proves the negative branch too.
 *
 * @returns {Promise<import('node:net').Server>} The listening server.
 */
function holdPort() {
  return new Promise((resolve, reject) => {
    const holder = net.createServer();
    holder.once('error', reject);
    holder.once('listening', () => resolve(holder));
    holder.listen(PORT, HOST);
  });
}

/**
 * @param {import('node:net').Server} holder A server from `holdPort`.
 * @returns {Promise<void>} Resolves once it has stopped listening.
 */
function releasePort(holder) {
  return new Promise((resolve) => {
    holder.close(() => resolve());
  });
}

/**
 * Waits, bounded, for a socket THIS FILE owned to be released.
 *
 * Called after a child has been reaped, because a process can be gone while
 * its socket is not yet reusable, and the next child would then fail to bind
 * for a reason that has nothing to do with it. Polling a real bind attempt is
 * the only honest test of "released" — a fixed sleep either wastes time or is
 * too short, and it never actually checks.
 *
 * This is NOT a retry for contention. Acquiring the port is fail-fast, through
 * `requirePortAvailable`; see the note on `PORT_RELEASE_POLL_ATTEMPTS` for why
 * the two cases are different in kind.
 *
 * @returns {Promise<{available: boolean, code: string|null}>} The final probe
 *   result, so a caller can name the code in its failure message.
 */
async function awaitPortRelease() {
  let result = { available: false, code: null };

  for (let attempt = 0; attempt < PORT_RELEASE_POLL_ATTEMPTS; attempt += 1) {
    result = await probePort();
    if (result.available) {
      return result;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return result;
}

/**
 * The one message a held port produces, phrased for a reader who has to decide
 * whether they are looking at an environment problem or a code defect.
 *
 * @param {string|null} code The code the probe reported.
 * @param {string} context What this file was about to do.
 * @returns {string} An actionable failure message naming the port and the code.
 */
function portUnavailableMessage(code, context) {
  return (
    `port ${PORT} unavailable (${code}) ${context} — this is an ENVIRONMENT ` +
    `problem, not a code defect, and it is reported immediately rather than ` +
    `waited out. Something else on this host is holding ${HOST}:${PORT}: ` +
    `server.js binds that port as a literal with no override, so this suite ` +
    `needs it exclusively. Release the holder and re-run, and run the suite as ` +
    `"node --test --test-concurrency=1" so no sibling test file can contend ` +
    `for it. (${path.basename(__filename)} is the only file in the suite that ` +
    `binds the literal port.)`
  );
}

/**
 * Requires the port NOW, with a single probe, and fails fast when it is held.
 *
 * A single probe, deliberately. A held port is an environment condition this
 * file cannot fix, so it is reported at once, naming the port and the error
 * code, instead of being waited out: a retry loop here would spend a minute in
 * silence and then report a genuinely held port as though the suite were merely
 * slow.
 *
 * @param {string} context What this file was about to do, for the message.
 * @returns {Promise<{available: boolean, code: string|null}>} The probe result.
 * @throws {Error} Immediately, when the port is held.
 */
async function requirePortAvailable(context) {
  const result = await probePort();

  if (!result.available) {
    throw new Error(portUnavailableMessage(result.code, context));
  }

  return result;
}

/**
 * Opens a bare TCP connection and reports what happened, without sending a
 * byte.
 *
 * Used for the reachability cases, where the question is whether anything is
 * listening at an address rather than what it would say. A timeout is reported
 * as its own outcome instead of being treated as a refusal, because a dropped
 * SYN and a refused connection are different observations and conflating them
 * would let a firewall masquerade as evidence about the bind.
 *
 * @param {string} host The address to reach.
 * @param {number} timeoutMs How long to wait before giving up.
 * @returns {Promise<string>} `'connected'`, `'timeout'`, or the error code.
 */
function probeConnect(host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: PORT });
    let settled = false;

    const finish = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    socket.once('connect', () => finish('connected'));
    socket.once('error', (error) => finish(error.code ?? error.message));
  });
}

/* ========================================================================= *
 * The child service: spawn, gate, stop
 * ========================================================================= */

/**
 * Every child this file has spawned, so the final cleanup can guarantee that
 * none survives the run. A handle is added the moment it is created — before
 * readiness is gated — because a child that failed to become ready is exactly
 * the one most likely to be forgotten.
 *
 * @type {Set<object>}
 */
const spawnedServices = new Set();

/**
 * Spawns `node server.js` as a child process and starts capturing its output.
 *
 * `process.execPath` rather than the string `'node'`: the child must run the
 * SAME runtime as the suite, or the evidence is about some other Node than the
 * one the assertions were measured on.
 *
 * `ACTIVITY_STORE` is always set, with no default and no exception. The store
 * path is resolved once at the child's module load, which is precisely why the
 * child-process form is the cleanest way to control it — and why forgetting it
 * would write `activities.json` into the repository root, where there is a
 * committed ignore rule to keep it out of a commit but nothing to keep it out
 * of the working tree.
 *
 * `stdin` is `'ignore'`: the service never reads it, and leaving a writable
 * pipe open would be one more handle for this process to hold.
 *
 * @param {string} storePath The value for `ACTIVITY_STORE`.
 * @returns {object} A handle carrying the child, its accumulated `stdout` and
 *   `stderr`, its recorded `exit` and `close` dispositions (each `null` until
 *   the corresponding event fires), a `closed` promise that resolves with the
 *   close disposition, and any `spawnFailures`.
 */
function spawnService(storePath) {
  const child = spawn(process.execPath, [SERVER_ENTRY_POINT], {
    cwd: REPOSITORY_ROOT,
    env: childEnvironment(storePath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const handle = {
    child,
    storePath,
    stdout: '',
    stderr: '',
    exit: null,
    close: null,
    spawnFailures: [],
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    handle.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    handle.stderr += chunk;
  });

  // BOTH lifecycle events are recorded, because they mean two different things
  // and conflating them is a real defect rather than a nicety. `'exit'` fires
  // when the process has gone. `'close'` fires once its stdio streams have ALSO
  // been closed, which is strictly later and is the only point at which the
  // captured output is COMPLETE.
  //
  // So everything in this file that reads `stdout` or `stderr` — an assertion,
  // a diagnostic, the classification of a failed start — waits on `closed`.
  // Waiting on the exit instead would let a case read a stream that had not
  // finished flushing and then pass, or fail, on the timing of a pipe rather
  // than on the disposition it is about.
  //
  // `handle.exit` is kept as a recorded fact rather than as something to wait
  // on: comparing it against `handle.close` is what tells "the process never
  // left" apart from "the process left but its stdio never closed", and the
  // cleanup path needs to say which of those it hit.
  child.once('exit', (code, signal) => {
    handle.exit = { code, signal };
  });

  handle.closed = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      handle.close = { code, signal };
      resolve(handle.close);
    });
  });

  // `spawn` reports a failure to start the executable asynchronously. Without
  // a listener that arrives as an unhandled `'error'` event and takes the
  // runner down.
  //
  // It is recorded as a CODE on the handle rather than appended to the captured
  // `stderr`, for two reasons. The captured streams must stay exactly what the
  // child wrote, because the EADDRINUSE case asserts the child's stderr is one
  // precise line and a harness-injected line would break it. And a raw
  // `error.message` carries the absolute path of the executable it could not
  // start, which a retained failure report has no business holding.
  //
  // Both fields are reduced at the point of CAPTURE, not at the point of
  // rendering, so nothing path-bearing is ever held on the handle for some
  // later reader to print. `syscall` in particular is not the safe code it
  // looks like: a failed spawn sets it to the operation AND its target — see
  // `syscallOperation`, which keeps only the operation.
  child.once('error', (error) => {
    handle.spawnFailures.push({
      code: errorCode(error),
      syscall: syscallOperation(error),
    });
  });

  spawnedServices.add(handle);
  return handle;
}

/**
 * Builds the child's environment: the parent's, MINUS the test runner's own
 * instrumentation, PLUS the store path.
 *
 * `ACTIVITY_STORE` is the reason this file controls the environment at all.
 * The removals are the reason it has to build the environment explicitly
 * rather than spreading `process.env` and moving on.
 *
 * WHY THE COVERAGE VARIABLE MATTERS. Under `--experimental-test-coverage` the
 * runner gives each test worker a `NODE_V8_COVERAGE` directory, and a spawned
 * child inherits it, writes its own V8 profile there, and has that profile
 * merged into the parent's report. `server.js` then acquires a coverage figure
 * from a process this file only spawned and never imported. That figure is not
 * coverage in the sense the report means, and it is actively misleading: the
 * `server.js` row belongs to the in-process suite, which drives the module's
 * exported server directly, so a spawned child contributing to it makes the
 * provenance of every figure in the table unreadable.
 *
 * WHY IT IS EMPTIED RATHER THAN DELETED. `child_process` propagates
 * `NODE_V8_COVERAGE` from the parent DELIBERATELY, so that coverage can span a
 * process tree even when the child is given a curated environment — and the
 * check it makes is for the variable's PRESENCE as an own property of the
 * supplied `env`, not for its value. Deleting the key therefore achieves
 * nothing: the key is absent, so the runtime copies the parent's value straight
 * back in, and the child writes its profile after all. Assigning an empty
 * string keeps the key present — so nothing is copied over it — while being
 * falsy, which is what disables the child's coverage hook.
 *
 * `NODE_TEST_CONTEXT` and `NODE_TEST_WORKER_ID` are plain deletions, and they
 * work as deletions because nothing propagates them: they tell a process it IS
 * a test worker, and the service is not one. They are runner internals with no
 * business in a service's environment.
 *
 * @param {string} storePath The value for `ACTIVITY_STORE`.
 * @returns {object} The child's environment.
 */
function childEnvironment(storePath) {
  const environment = { ...process.env };

  for (const name of ['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) {
    delete environment[name];
  }

  environment.NODE_V8_COVERAGE = '';
  environment.ACTIVITY_STORE = storePath;
  return environment;
}

/**
 * Describes a child's store WITHOUT disclosing where it is.
 *
 * What a reader needs from a failure is which store the child was given and
 * whether that store was the writable one or the deliberately unwritable one —
 * the two categories this file creates. The absolute path answers neither
 * question and discloses the host's filesystem layout to whatever retains the
 * report, so it is reduced to its basename plus the category.
 *
 * The category is decided by a string comparison, never by touching the
 * filesystem: `writableStorePath` puts a store directly in the temporary root,
 * `unwritableStorePath` puts it two levels below under a directory that is
 * never created, and `protectedStorePath` names a tracked file of the
 * repository itself.
 *
 * @param {string} storePath The child's `ACTIVITY_STORE` value.
 * @returns {string} A path-free description.
 */
function describeStore(storePath) {
  if (temporaryRoot !== null && path.dirname(storePath) === temporaryRoot) {
    return `${path.basename(storePath)} (writable, directly inside the suite's temporary root)`;
  }

  // Named third because a protected destination is the one category that does
  // not live under the temporary root at all, and reporting it as the
  // unwritable case would send a reader looking for a missing directory.
  if (path.dirname(storePath) === REPOSITORY_ROOT) {
    return `${path.basename(storePath)} (a tracked file of the repository — the protected case)`;
  }

  return `${path.basename(storePath)} (parent directory absent — the deliberately unwritable case)`;
}

/**
 * Renders everything known about a child, for a failure message, bounded and
 * redacted.
 *
 * A service that will not start has to produce a diagnosis, not a bare
 * timeout. This is what makes the difference between "readiness deadline
 * exceeded" and a message a reader can act on without reproducing the run.
 *
 * What it reports is deliberately asymmetric. The facts a reader acts on —
 * exit code, signal, whether the child closed, how much it wrote — are exact
 * and unredacted. The child's raw output is not reproduced: it is summarized
 * and previewed under the bounds above, because these messages outlive the run
 * that produced them and a full capture can carry absolute paths, stack frames
 * naming internal module layout, and request targets. See `summarizeOutput`.
 *
 * @param {object} handle A handle from `spawnService`.
 * @returns {string} A multi-line diagnostic safe to retain.
 */
function describeService(handle) {
  const disposition = (event) =>
    event === null ? 'not seen' : `code ${event.code}, signal ${event.signal}`;

  const lines = [
    `store: ${describeStore(handle.storePath)}`,
    `pid: ${handle.child.pid ?? 'none — the child never started'}`,
    `exitCode: ${handle.child.exitCode}`,
    `signal: ${handle.child.signalCode}`,
    `exit event: ${disposition(handle.exit)}`,
    `close event: ${disposition(handle.close)}`,
    summarizeOutput('stdout', handle.stdout),
    summarizeOutput('stderr', handle.stderr),
  ];

  if (handle.spawnFailures.length > 0) {
    // A code and an operation, both already reduced at capture. The raw
    // `error.message` names the absolute path of the executable that could not
    // be started, and so does the raw `syscall`; the pair below is what
    // actually identifies the fault. Sanitized once more on the way out, so
    // this line stays safe even if a future caller pushes an unreduced record.
    const failures = handle.spawnFailures
      .map((failure) => `${failure.code} (${failure.syscall})`)
      .join(', ');
    lines.push(`spawn failures: ${redactPaths(failures)}`);
  }

  return lines.join('\n');
}

/**
 * Waits, bounded, for the child to log its readiness line.
 *
 * Two things make this a gate rather than a delay. It polls for the LINE, so
 * it returns as soon as the service is actually listening instead of after a
 * guessed interval. And it checks on every poll whether the child has already
 * exited — a service that died on startup would otherwise burn the whole
 * deadline before failing, and would fail with the wrong story.
 *
 * @param {object} handle A handle from `spawnService`.
 * @returns {Promise<void>} Resolves once the readiness line has been seen.
 * @throws {Error} When the child exits first, or the deadline passes.
 */
async function awaitReadiness(handle) {
  for (let attempt = 0; attempt < READINESS_POLL_ATTEMPTS; attempt += 1) {
    if (handle.stdout.includes(READINESS_LINE)) {
      return;
    }
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      // The process has gone, but its stdio may still be flushing, and the
      // whole value of this failure is the output it carries. Wait for
      // `'close'` — bounded — so the diagnosis is built from the COMPLETE
      // streams rather than from whatever had arrived by the time the exit was
      // noticed. This is also what makes the caller's contention
      // classification trustworthy: it reads the same stderr.
      await awaitWithDeadline(handle.closed, CLOSE_DEADLINE_MS);
      throw new Error(
        `the service exited before it became ready\n${describeService(handle)}`
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `the service did not log its readiness line within ` +
      `${(READINESS_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s\n${describeService(handle)}`
  );
}

/**
 * Waits, bounded, for a child's captured output to STOP GROWING.
 *
 * This is the adaptive form of the settling period, for the one assertion that
 * can have it: a case that has already awaited everything it asked the service
 * to do, where the only thing still outstanding is an asynchronous flush of the
 * child's stdio pipes. Polling for silence instead of sleeping through a
 * guessed interval is what makes it wait LONGER on a host that is still
 * flushing, and no longer than it has to on one that finished immediately.
 *
 * Both streams are measured together, as one length. A stray line on stderr
 * violates "serving requests adds no output" exactly as much as a stray line on
 * stdout, so one wait covers both rather than settling the first and leaving
 * the second to luck.
 *
 * Two properties are deliberate, and neither is an implementation detail.
 *
 * It CANNOT be weaker than the fixed settle it replaces. Returning takes
 * `OUTPUT_QUIET_POLLS` consecutive unchanged measurements, derived from
 * `QUIET_PERIOD_MS`, so the shortest silence it will accept is the same span a
 * `sleep(QUIET_PERIOD_MS)` observed — a contended host only makes it wait for
 * more than that, never less.
 *
 * And on exhausting `OUTPUT_QUIESCENCE_POLL_ATTEMPTS` it RETURNS rather than
 * throwing. Output that never stops growing is precisely the defect the
 * caller's assertions exist to report, and they report it exactly — naming the
 * readiness count, the line count and a redacted preview. A throw here would
 * replace that diagnosis with a helper's own timeout message, which says less
 * about the failure and would be actively misleading about which failure it was.
 *
 * @param {object} handle A handle from `spawnService`.
 * @returns {Promise<void>} Resolves once the captured output has been unchanged
 *   for a full quiet window, or once the ceiling is reached — the caller's
 *   assertions render judgement either way.
 */
async function awaitOutputQuiescence(handle) {
  const measure = () => handle.stdout.length + handle.stderr.length;

  // The baseline is taken BEFORE the first sleep, so the first unchanged poll
  // already attests to a whole `POLL_INTERVAL_MS` of silence rather than to a
  // single instant.
  let previous = measure();
  let quietPolls = 0;

  for (let attempt = 0; attempt < OUTPUT_QUIESCENCE_POLL_ATTEMPTS; attempt += 1) {
    await sleep(POLL_INTERVAL_MS);

    const current = measure();
    // Any growth resets the window rather than shortening it: the point is a
    // full quiet span at the END of the output, not a quiet span somewhere.
    quietPolls = current === previous ? quietPolls + 1 : 0;
    previous = current;

    if (quietPolls >= OUTPUT_QUIET_POLLS) {
      return;
    }
  }
}

/**
 * Requires port 3000, spawns the service, and gates on readiness.
 *
 * Both waits here are the documented ones. The port is required with a single
 * probe and a held port fails immediately, naming the port and the code — a
 * retry loop here would contradict the stated fail-fast contract and would
 * spend a minute doing it. Readiness is then gated on a bounded deadline that
 * also notices a dead child.
 *
 * A child that dies naming `EADDRINUSE` is reported as the environment problem
 * it is, not retried: the probe said the port was free a moment earlier, so
 * something else on this host took it, and that is exactly the condition the
 * contract says to report at once. The classification reads the child's stderr,
 * which `awaitReadiness` has already completed by waiting for `'close'`.
 *
 * @param {string} storePath The value for `ACTIVITY_STORE`.
 * @returns {Promise<object>} A ready service handle.
 * @throws {Error} When the port is held, or the service will not start.
 */
async function startService(storePath) {
  await requirePortAvailable('before spawning the service');

  const handle = spawnService(storePath);

  try {
    await awaitReadiness(handle);
    return handle;
  } catch (startupFailure) {
    // The child is reaped before anything is thrown, so a service that failed
    // to become ready cannot survive as an orphan holding the port. A cleanup
    // fault is APPENDED to the diagnosis rather than replacing it: the startup
    // error is the primary one, and a cleanup failure that masked it would send
    // a reader after the wrong problem.
    let cleanupNote = '';
    try {
      await stopService(handle);
    } catch (cleanupFailure) {
      cleanupNote = `\ncleanup after the failed start also failed: ${cleanupFailure.message}`;
    }

    if (handle.stderr.includes('EADDRINUSE')) {
      throw new Error(
        `${portUnavailableMessage('EADDRINUSE', 'when the service tried to bind')}` +
          `\nThe pre-flight probe found the port free moments earlier, so it was ` +
          `taken between the probe and the bind.${cleanupNote}`,
        { cause: startupFailure }
      );
    }

    if (cleanupNote === '') {
      throw startupFailure;
    }

    throw new Error(`${startupFailure.message}${cleanupNote}`, { cause: startupFailure });
  }
}

/**
 * Kills a child and awaits its CLOSE, escalating if it ignores the first
 * signal, and failing if it ignores the second.
 *
 * Killing without awaiting leaves a race in which the next child binds before
 * this one has gone, and the `SIGKILL` escalation covers a child that will not
 * leave on request — so a hung service cannot hang the suite.
 *
 * EVERY WAIT IS BOUNDED, INCLUDING THE LAST ONE. Both waits go through
 * `awaitWithDeadline`, which clears its own timer, and that includes the wait
 * after `SIGKILL`: this is the cleanup path, where an unbounded wait produces
 * no assertion, no diagnosis and a runner that never finishes. A child that
 * survives `SIGKILL` is therefore a reported failure naming its pid, which is
 * the honest outcome — it is a condition this file cannot fix and must not
 * conceal.
 *
 * It waits for `'close'` rather than `'exit'` so the diagnosis it may have to
 * print is built from complete output.
 *
 * Safe to call more than once, and safe on a child that has already gone,
 * which is what lets the final cleanup sweep every handle unconditionally.
 * The handle is untracked only once the child is confirmed closed, so a child
 * this function could not reap stays visible to the sweep and to the
 * no-orphans case at the end of the file.
 *
 * @param {object} handle A handle from `spawnService`.
 * @returns {Promise<void>} Resolves once the child is closed.
 * @throws {Error} When the child does not close even after `SIGKILL`.
 */
async function killService(handle) {
  if (handle.close === null) {
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill();
    }

    let closed = await awaitWithDeadline(handle.closed, EXIT_DEADLINE_MS);

    if (!closed) {
      handle.child.kill('SIGKILL');
      closed = await awaitWithDeadline(handle.closed, CLOSE_DEADLINE_MS);
    }

    if (!closed) {
      // Which of the two failures it is matters to whoever reads this, so it
      // is named rather than left to be inferred from the dump below: a child
      // that never exited is still running and still holding the port, while a
      // child that exited without closing has gone but left a pipe open, which
      // is a different problem with different consequences.
      const shape =
        handle.exit === null
          ? `it never exited, so it may still be holding port ${PORT}`
          : `it exited (code ${handle.exit.code}, signal ${handle.exit.signal}) but its ` +
            `stdio never closed, so its captured output cannot be trusted to be complete`;

      throw new Error(
        `the service did not close within ${CLOSE_DEADLINE_MS / 1000}s of SIGKILL ` +
          `(pid ${handle.child.pid}): ${shape}. This suite cannot guarantee it left ` +
          `no process behind, and an orphan would fail whatever runs next on this ` +
          `host\n${describeService(handle)}`
      );
    }
  }

  spawnedServices.delete(handle);
}

/**
 * Kills a child and then waits for port 3000 to be bindable again, FAILING if
 * it never is.
 *
 * The port poll is a separate step from the kill because the two are separate
 * facts: a process can be gone while its socket is not yet reusable, and the
 * next child would then fail to bind for a reason that has nothing to do with
 * it. For a child that never held the port — the refused second instance
 * below — use `killService` instead, or this would wait out the whole release
 * deadline against the instance that legitimately holds it.
 *
 * The final probe's RESULT is honoured rather than discarded. Cleanup is not
 * complete until the socket is released, so a probe that still reports the port
 * held fails here: returning as though cleanup had succeeded would hand the
 * next child a bind failure with no explanation attached to it.
 *
 * @param {object} handle A handle from `spawnService`.
 * @returns {Promise<{available: boolean, code: string|null}>} The final probe
 *   result, available.
 * @throws {Error} When the child cannot be reaped, or the port is still held.
 */
async function stopService(handle) {
  await killService(handle);

  const released = await awaitPortRelease();

  if (!released.available) {
    throw new Error(
      `port ${PORT} was still held (${released.code}) ` +
        `${(PORT_RELEASE_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s after the service ` +
        `was stopped. Cleanup is not complete until the socket is released, because ` +
        `the next child binds the same literal port and would fail for a reason that ` +
        `has nothing to do with it\n${describeService(handle)}`
    );
  }

  return released;
}

/* ========================================================================= *
 * Talking to the service
 * ========================================================================= */

/**
 * Issues one HTTP request and reads the whole response.
 *
 * `agent: false` with an explicit `Connection: close` is deliberate, and what
 * it buys is ISOLATION. Node's global agent keeps connections alive, so
 * without this the socket one case finished with is the socket the next case
 * is handed, and an exchange would be asserted over a connection whose state
 * it did not establish — a half-consumed response or a server-side close
 * arriving mid-flight belongs to the case that caused it, not to the case that
 * inherits it. One connection per request, opened for it and closed by the
 * server when it answers, keeps every observation attributable to the case
 * that made it.
 *
 * Two things it is NOT for, because both were plausible and both are wrong.
 * It is not queue avoidance: the default agent's socket limits are unbounded,
 * so a request is given a new connection rather than made to wait behind a
 * busy one. And it is not what keeps this file off `--test-force-exit`: a
 * socket the agent parks in its free list is unrefed and holds no reference on
 * the event loop. The handle that would genuinely hang this file belongs to an
 * exchange that never settled, which is what the deadlines below and the
 * `req.destroy()` in `fail` exist to prevent.
 *
 * The body is returned as RAW BYTES. The gold value is a byte count and a
 * hash, so decoding first would let an encoding change slip through
 * unnoticed — the one thing a byte-for-byte assertion exists to catch.
 *
 * EVERY EXCHANGE IS DEADLINED, and a response that never completes is a
 * FAILURE rather than a wait. Settling only on the response's `'end'` event
 * would leave two product defects with no assertion to fail: a service that
 * accepts a connection and never answers, and a response whose socket closes
 * before the body is complete. Either would leave the promise and its socket
 * pending until the runner's ambient timeout fired somewhere else entirely,
 * turning a legible defect into a hang with no diagnosis. Both reject here,
 * naming the request and what was observed.
 *
 * Three guards, because they catch different shapes of the same fault: an
 * ABSOLUTE deadline on the whole exchange, a SOCKET-INACTIVITY deadline via
 * `request.setTimeout`, and a completeness check on the response itself. Every
 * settlement path clears the timer, for the reason `awaitWithDeadline`
 * documents — a pending timer keeps the event loop alive and is
 * indistinguishable from a hang.
 *
 * @param {{method?: string, path: string, headers?: object, host?: string}} options
 *   The request line and headers. `host` defaults to loopback.
 * @param {string|undefined} body An optional request body.
 * @returns {Promise<{status: number, headers: object, raw: Buffer, text: string}>}
 *   The complete response.
 */
function request(options, body) {
  const method = options.method ?? 'GET';
  const target = options.path;
  const description = `${method} ${target}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;

    const clearDeadline = () => {
      if (deadline !== null) {
        clearTimeout(deadline);
        deadline = null;
      }
    };

    const succeed = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearDeadline();
      resolve(value);
    };

    // Destroying the request before rejecting is what stops a timed-out
    // exchange from leaving a socket open behind the failure.
    const fail = (message) => {
      if (settled) {
        return;
      }
      settled = true;
      clearDeadline();
      req.destroy();
      reject(new Error(message));
    };

    const req = http.request(
      {
        host: options.host ?? HOST,
        port: PORT,
        method,
        path: target,
        agent: false,
        headers: { Connection: 'close', ...(options.headers ?? {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', (error) =>
          fail(`${description}: the response stream failed (${error.code ?? error.message})`)
        );
        res.once('end', () => {
          const raw = Buffer.concat(chunks);
          succeed({
            status: res.statusCode,
            headers: res.headers,
            raw,
            text: raw.toString('utf8'),
          });
        });
        // `'close'` always follows `'end'` on a complete response, where the
        // `settled` guard makes this a no-op. It fires WITHOUT `'end'` when the
        // response was cut short, and `res.complete` is how that is told apart
        // from a clean finish.
        //
        // A backstop rather than the primary guard, and measured as one: both
        // ways of cutting a response short on this runtime — destroying the
        // socket mid-body, and half-closing it gracefully mid-body — reach the
        // `'error'` handler above as `ECONNRESET`. This settles the remaining
        // shape, a close that arrives with neither an error nor an `'end'`, so
        // that no arrangement of those three events can leave the promise
        // pending.
        res.once('close', () => {
          if (!res.complete) {
            fail(
              `${description}: the response closed before the body was complete ` +
                `(status ${res.statusCode}, ${Buffer.concat(chunks).length} byte(s) received)`
            );
          }
        });
      }
    );

    deadline = setTimeout(() => {
      fail(`${description}: no complete response within ${REQUEST_DEADLINE_MS / 1000}s`);
    }, REQUEST_DEADLINE_MS);

    req.setTimeout(SOCKET_IDLE_DEADLINE_MS, () => {
      fail(
        `${description}: the socket was idle for ${SOCKET_IDLE_DEADLINE_MS / 1000}s — ` +
          `the service accepted the connection and stopped answering`
      );
    });

    req.on('error', (error) =>
      fail(`${description}: the request failed (${error.code ?? error.message})`)
    );

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Asserts that a response is the preserved response, exactly.
 *
 * Shared by the paths that must still receive it, which is not the same thing
 * as collapsing those paths into one case: each path is still its own named
 * test that fails on its own. Every call asserts all four properties — the
 * status, the exact `Content-Type`, the byte length, and the sha256 of the raw
 * body — because each catches a different kind of drift.
 *
 * @param {{status: number, headers: object, raw: Buffer}} response A response
 *   from `request`.
 * @param {string} label The path or request being described, for the message.
 */
function assertPreservedResponse(response, label) {
  assert.strictEqual(
    response.status,
    GOLD_STATUS,
    `${label} must still answer ${GOLD_STATUS}`
  );
  assert.strictEqual(
    response.headers['content-type'],
    GOLD_CONTENT_TYPE,
    `${label} must still answer with Content-Type exactly "${GOLD_CONTENT_TYPE}" — ` +
      `no charset parameter, because the pre-feature response carried none and ` +
      `this feature deliberately did not tidy it`
  );
  assert.strictEqual(
    response.raw.length,
    GOLD_BODY_BYTES,
    `${label} must still answer exactly ${GOLD_BODY_BYTES} bytes`
  );
  assert.strictEqual(
    sha256(response.raw),
    GOLD_BODY_SHA256,
    `${label} must still answer the gold body byte for byte ` +
      `(received ${JSON.stringify(response.raw.toString('utf8'))})`
  );
}

/**
 * Asserts that a response is NOT the preserved response.
 *
 * The claimed half of the boundary needs this as its own statement. Asserting
 * only that a claimed path returns some 200 would pass if the namespace
 * quietly stopped being routed at all, since the fall-through answers 200 too.
 *
 * @param {{status: number, headers: object, raw: Buffer}} response A response
 *   from `request`.
 * @param {string} label The path being described, for the message.
 */
function assertNotPreservedResponse(response, label) {
  assert.notStrictEqual(
    sha256(response.raw),
    GOLD_BODY_SHA256,
    `${label} is inside the /activities namespace and must be answered by the ` +
      `feature, not by the preserved fall-through response`
  );
  assert.notStrictEqual(
    response.headers['content-type'],
    GOLD_CONTENT_TYPE,
    `${label} is inside the /activities namespace and must not carry the ` +
      `preserved "${GOLD_CONTENT_TYPE}" content type`
  );
}


/* ========================================================================= *
 * Suite-wide setup and teardown
 * ========================================================================= */

/**
 * The directory every child's store lives in. Created in `before`, removed in
 * `after`, and never inside the checkout: the suite must leave the working
 * tree exactly as it found it, and a stray `activities.json` in the repository
 * root would be the visible symptom of a child spawned without
 * `ACTIVITY_STORE`.
 *
 * @type {string|null}
 */
let temporaryRoot = null;

/**
 * A writable store path for a child, inside the temporary root.
 *
 * The directory already exists, so both the staging write and the rename
 * succeed — which is what makes the contrast with the unwritable case below
 * meaningful rather than accidental.
 *
 * @param {string} name A short name distinguishing one child's store.
 * @returns {string} An absolute path inside the temporary root.
 */
function writableStorePath(name) {
  return path.join(temporaryRoot, `${name}.json`);
}

/**
 * A store path whose PARENT DIRECTORY does not exist, and is never created.
 *
 * An absent parent directory makes the write fail with `ENOENT` on every
 * platform, which a permission bit does not: on Windows `fs.chmod` only
 * toggles a FILE's read-only flag and cannot make a directory unwritable at
 * all.
 *
 * What the service observes is the STAGING WRITE failing, and only that.
 * `activity-store.js` writes the document to `<store>.tmp` and then renames it
 * over the store, awaiting each in turn, so with the parent absent the
 * `writeFile` rejects and the rename is never attempted. One refused step is
 * the whole fault, and both steps surface to a client as the single code
 * `store_write_failed`.
 *
 * @param {string} name A short name distinguishing one child's store.
 * @returns {string} An absolute path whose parent is absent.
 */
function unwritableStorePath(name) {
  return path.join(temporaryRoot, name, 'absent-directory', 'activities.json');
}

/**
 * A store path naming a TRACKED FILE of this repository, which the store
 * refuses outright.
 *
 * `xlsx-read.js` is chosen for two reasons. It is on the protected list, so the
 * refusal is the one under test rather than an incidental filesystem error. And
 * a write to the store is a `rename` OVER the target, so a file that is
 * genuinely needed by the next case is the honest subject: the assertions below
 * hash it before and after to show it was never touched.
 *
 * The file is never modified by anything here. It is not created, not opened
 * for writing and not renamed over — the point of the case is that the service
 * refuses before any of that can happen.
 *
 * @returns {string} The absolute path of a protected repository file.
 */
function protectedStorePath() {
  return path.join(REPOSITORY_ROOT, 'xlsx-read.js');
}

/**
 * Runs `node` with the given arguments to completion and returns everything it
 * wrote.
 *
 * Separate from `spawnService` because the subject is different: that helper
 * spawns the service and hands back a live handle to interrogate while it runs,
 * whereas these children are expected to be GONE by the time anything is
 * asserted — they refuse to start, or they load a module and print one thing.
 * Bending `spawnService` to both shapes would put a readiness gate and a port
 * release in the path of a child that binds nothing.
 *
 * Bounded and reaped: the wait is deadlined, and a child that outlives its
 * deadline is killed and reported rather than waited on, so no case here can
 * hang the runner or leave a process behind.
 *
 * @param {Array<string>} args The arguments for `process.execPath`.
 * @param {string} storePath The value for `ACTIVITY_STORE`.
 * @param {string} [cwd] The child's working directory. Defaults to the
 *   repository root, which is what `npm start` uses; a case that runs a COPY of
 *   the entry point beside a stub module passes that copy's directory instead,
 *   so the copy's relative require resolves to the stub rather than to the real
 *   feature.
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string}>}
 *   The child's exit disposition and its complete output.
 * @throws {Error} When the child does not close within the deadline.
 */
async function runNodeToCompletion(args, storePath, cwd = REPOSITORY_ROOT) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: childEnvironment(storePath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const result = { code: null, signal: null, stdout: '', stderr: '' };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    result.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    result.stderr += chunk;
  });

  // A failure to start the executable arrives asynchronously; without a
  // listener it is an unhandled `'error'` event that takes the runner down.
  // Reduced at capture, like `spawnService` does, so nothing path-bearing is
  // held for a later reader to print.
  const spawnFailures = [];
  child.once('error', (error) => {
    spawnFailures.push(errorCode(error));
  });

  // `'close'` rather than `'exit'`: every assertion below reads the captured
  // output, and only `'close'` guarantees the pipes have finished flushing.
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      result.code = code;
      result.signal = signal;
      resolve();
    });
  });

  if (!(await awaitWithDeadline(closed, EXIT_DEADLINE_MS))) {
    child.kill('SIGKILL');
    await awaitWithDeadline(closed, CLOSE_DEADLINE_MS);
    throw new Error(
      `a child that should have exited on its own did not close within ` +
        `${EXIT_DEADLINE_MS / 1000}s (pid ${child.pid}); it was killed. ` +
        `${summarizeOutput('stdout', result.stdout)}; ` +
        `${summarizeOutput('stderr', result.stderr)}`
    );
  }

  if (spawnFailures.length > 0) {
    throw new Error(
      `the child could not be started (${spawnFailures.join(', ')}), so nothing ` +
        `it was supposed to report can be asserted`
    );
  }

  return result;
}

before(
  async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-test-'));

    // THE PRE-FLIGHT PROBE. It runs before anything binds, it is a SINGLE
    // bind attempt, and a held port fails the hook immediately, naming the port
    // and the code.
    //
    // Its failure is phrased as an environment problem because that is what it
    // is — every case in this file needs port 3000, and a held port would
    // otherwise surface as an opaque assertion failure somewhere further down,
    // sending a reader to look for a defect in code that is working.
    const acquisition = await probePort();
    assert.strictEqual(
      acquisition.available,
      true,
      portUnavailableMessage(acquisition.code, 'at the suite pre-flight probe')
    );
  },
  { timeout: CASE_TIMEOUT_MS }
);

after(
  async () => {
    // Unconditional sweep. Every handle is stopped even if a case already
    // stopped it, because `stopService` is safe to repeat and an orphan
    // holding port 3000 would poison whatever runs next on this host.
    //
    // FAILURE-ISOLATED, because cleanup actions are independent and one that
    // throws must not skip the rest. A single `await` in a loop would abandon
    // every handle after the first failure AND leave the temporary directory
    // on disk — turning one reported problem into three unreported ones. So
    // each action runs, its failure is collected, and the collection is
    // reported once at the end.
    const failures = [];

    for (const handle of [...spawnedServices]) {
      try {
        await stopService(handle);
      } catch (error) {
        failures.push(error.message);
      }
    }

    if (temporaryRoot !== null) {
      try {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      } catch (error) {
        failures.push(
          `the suite's temporary root could not be removed (${error.code ?? error.message})`
        );
      }
      temporaryRoot = null;
    }

    if (failures.length > 0) {
      throw new Error(`suite cleanup did not complete:\n${failures.join('\n')}`);
    }
  },
  { timeout: CASE_TIMEOUT_MS }
);

/* ========================================================================= *
 * The node:net pre-flight probe
 *
 * Declared first so it runs before anything binds the port. The `before` hook
 * above has already gated the suite on the probe; these cases assert that the
 * probe itself works in BOTH directions, because a check that has only ever
 * been seen to pass is not evidence.
 * ========================================================================= */

describe('the node:net pre-flight probe', () => {
  test(
    'reports port 3000 as bindable before any instance is spawned',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      // A single probe, deliberately: this case asserts the probe's positive
      // branch, and a retry loop would also hide a port that was held at the
      // first attempt — which is the condition the contract says to report.
      const result = await probePort();

      assert.strictEqual(
        result.available,
        true,
        portUnavailableMessage(result.code, 'before any instance is spawned')
      );
      assert.strictEqual(
        result.code,
        null,
        'a successful probe reports no error code'
      );
    }
  );

  test(
    'detects a held port and names the error code instead of failing opaquely',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const holder = await holdPort();

      try {
        const result = await probePort();

        assert.strictEqual(
          result.available,
          false,
          'the probe must report a port that is already held as unavailable'
        );
        assert.strictEqual(
          result.code,
          'EADDRINUSE',
          'the probe must surface the code, so a held port reads as an ' +
            'environment problem rather than a code defect'
        );
      } finally {
        // Released in `finally` so a failed assertion above cannot leave the
        // port held for every case that follows.
        await releasePort(holder);
      }

      // A release wait, not an acquisition retry: the holder above was this
      // file's own listener, and the question is whether the socket has been
      // let go yet.
      const afterRelease = await awaitPortRelease();
      assert.strictEqual(
        afterRelease.available,
        true,
        'the port must be bindable again once the holder has closed'
      );
    }
  );
});

/* ========================================================================= *
 * What a retained failure message is allowed to say
 *
 * These cases bind no port, spawn no child and touch no file: they call the
 * redaction helpers directly and assert what comes out. A sanitizer is only as
 * good as its adversarial cases, and the diagnostics these helpers produce
 * outlive the run — in JUnit artifacts and CI logs read by people who were not
 * there — so a silent regression in one of them is invisible until the artifact
 * has already been kept.
 *
 * The cases assert in BOTH directions. A disclosure must go, and the two lines
 * a reader actually needs — the readiness line and the handled bind error —
 * must survive untouched, because over-redaction that eats them turns a useful
 * diagnostic into a useless one.
 * ========================================================================= */

describe('what a retained failure message is allowed to say', () => {
  test(
    'a Windows path whose segments contain spaces is redacted whole',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      // The shape a failed spawn reports: an operation followed by the absolute
      // path of the executable, whose segments contain spaces. Every segment
      // must go — a pattern that stopped at whitespace would leave the tail of
      // the path standing, which is worse than not redacting at all because it
      // reads as redacted.
      const line = 'spawn C:\\Program Files\\Definitely Missing\\node.exe';

      assert.strictEqual(
        redactPaths(line),
        `spawn ${REDACTED_PATH}`,
        'every segment of a space-bearing Windows path must go, not just the first'
      );
      for (const fragment of ['Program', 'Files', 'Definitely', 'Missing', 'node.exe']) {
        assert.strictEqual(
          redactPaths(line).includes(fragment),
          false,
          `the redacted line must not retain ${JSON.stringify(fragment)}`
        );
      }
    }
  );

  test(
    'a POSIX path whose segments contain spaces is redacted whole',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      const line = "open '/home/my user/activity store/activities.json'";

      assert.strictEqual(
        redactPaths(line),
        `open '${REDACTED_PATH}'`,
        'a quoted POSIX path with spaces must go whole, and the quotes must bound it'
      );
      for (const fragment of ['home', 'my user', 'activity store', 'activities.json']) {
        assert.strictEqual(
          redactPaths(line).includes(fragment),
          false,
          `the redacted line must not retain ${JSON.stringify(fragment)}`
        );
      }
    }
  );

  test(
    "a path-bearing error.syscall is reduced to its operation alone",
    { timeout: CASE_TIMEOUT_MS },
    () => {
      // `syscall` LOOKS like a safe code and is not one: a failed spawn sets it
      // to the operation AND its absolute target, so retaining the field
      // verbatim would disclose the executable's path in every diagnostic that
      // mentions the failure.
      const error = Object.assign(new Error('spawn ENOENT'), {
        code: 'ENOENT',
        syscall: 'spawn C:\\Program Files\\Definitely Missing\\node.exe',
      });

      assert.strictEqual(
        syscallOperation(error),
        'spawn',
        'only the leading operation token survives, so no argument can ride along'
      );
      assert.strictEqual(errorCode(error), 'ENOENT', 'a real code token is kept as-is');

      const rendered = describeService({
        child: { pid: 4242, exitCode: null, signalCode: null },
        storePath: writableStorePath('redaction-probe'),
        stdout: '',
        stderr: '',
        exit: null,
        close: null,
        spawnFailures: [{ code: errorCode(error), syscall: syscallOperation(error) }],
      });

      assert.strictEqual(
        rendered.includes('spawn failures: ENOENT (spawn)'),
        true,
        'the diagnostic still identifies the fault by code and operation'
      );
      for (const fragment of ['Program', 'Files', 'Definitely', 'Missing', 'node.exe']) {
        assert.strictEqual(
          rendered.includes(fragment),
          false,
          `the rendered diagnostic must not retain ${JSON.stringify(fragment)}`
        );
      }
    }
  );

  test(
    'a one-segment request target keeps neither its path nor its query',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      // The single-segment case a two-segment path rule cannot see. Query data
      // is the part that matters here: a target can carry a token.
      const redacted = redactPaths('/activities?token=top-secret');

      assert.strictEqual(redacted, REDACTED_PATH, 'the whole target goes, query included');
      assert.strictEqual(
        redacted.includes('top-secret'),
        false,
        'query data must not survive redaction'
      );
    }
  );

  test(
    'a multi-segment request target keeps neither its path nor its query',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      const redacted = redactPaths('/activities/S001?token=top-secret');

      assert.strictEqual(redacted, REDACTED_PATH, 'the whole target goes, query included');
      for (const fragment of ['S001', 'token', 'top-secret']) {
        assert.strictEqual(
          redacted.includes(fragment),
          false,
          `the redacted target must not retain ${JSON.stringify(fragment)}`
        );
      }
    }
  );

  test(
    'the structured request-failure line keeps its event and method, and loses everything from the path onwards',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      // The shape `server.js` writes when a request fails, field for field:
      // `request_handler_failed method=… path=… error=… code=…`. The event code
      // and the method are worth keeping — together they say that a request
      // failed and what kind — while the pathname is not, because a route path
      // names a student.
      //
      // The trailing `error=` and `code=` fields go WITH the pathname, and the
      // whole line is asserted so that stays visible rather than being
      // discovered later: path segments are space-tolerant, because a Windows
      // path has spaces in it, so the segment that starts at `/activities`
      // runs on through the spaces that follow it. That is the over-redaction
      // `redactPaths` declares as its safe direction, and what it costs here
      // is legibility on a line that was disclosing a route path anyway — the
      // exit disposition, the line count, the byte length and the digest are
      // all reported unredacted elsewhere in the same diagnostic.
      const redacted = redactPaths(
        `request_handler_failed method=GET path=/activities/${SEEDED_STUDENT_ID}` +
          ' error=Error code=-'
      );

      assert.strictEqual(
        redacted,
        `request_handler_failed method=GET path=${REDACTED_PATH}`,
        'the event code and the method survive so the line stays greppable, and ' +
          'the pathname and the fields after it are replaced by the marker'
      );
      for (const fragment of [SEEDED_STUDENT_ID, '/activities']) {
        assert.strictEqual(
          redacted.includes(fragment),
          false,
          `the redacted line must not retain ${JSON.stringify(fragment)}`
        );
      }
    }
  );

  test(
    'a request target quoted after an HTTP method is redacted, and the method is kept',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      // Not the server's own line — this is the method-space-target shape that
      // can arrive from anywhere else in a child's output, a thrown value whose
      // message quotes a request line being the likeliest source. The rule
      // exists so a line written that way cannot carry a target, or the query
      // hanging off it, past redaction.
      const redacted = redactPaths(
        'Error: handler failed for GET /activities/S001?token=top-secret'
      );

      assert.strictEqual(
        redacted.includes(`GET ${REDACTED_TARGET}`),
        true,
        'the method survives so a reader knows what kind of request failed'
      );
      for (const fragment of ['S001', 'token', 'top-secret', '/activities']) {
        assert.strictEqual(
          redacted.includes(fragment),
          false,
          `the redacted line must not retain ${JSON.stringify(fragment)}`
        );
      }
    }
  );

  test(
    'ordinary prose following a method word is not mistaken for a target',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      // The target rule is anchored on a target that begins with `/` or a
      // scheme, precisely so a method word in prose costs nothing.
      const line = 'DELETE failed because the directory is absent';

      assert.strictEqual(
        redactPaths(line),
        line,
        'a method word followed by prose must be left exactly as written'
      );
    }
  );

  test(
    'the two lines a reader actually needs survive redaction untouched',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      // The other direction. A drive-letter pattern loose enough to match the
      // `p:` inside `http://` would redact this line from its scheme onwards,
      // so leaving it untouched is the condition being asserted.
      assert.strictEqual(
        redactPaths(READINESS_LINE),
        READINESS_LINE,
        'the readiness line is the single most informative line in a startup ' +
          'diagnostic and must pass through redaction unchanged'
      );
      assert.strictEqual(
        redactPaths(HANDLED_BIND_ERROR_LINE),
        HANDLED_BIND_ERROR_LINE,
        'the handled bind error line is what distinguishes a held port from a ' +
          'crash, and must pass through redaction unchanged'
      );
      assert.strictEqual(
        redactPaths('Error: listen EADDRINUSE: address already in use 127.0.0.1:3000'),
        'Error: listen EADDRINUSE: address already in use 127.0.0.1:3000',
        'a bind error naming the address is diagnosis, not disclosure'
      );
    }
  );

  test(
    'a stack frame is collapsed whole rather than redacted piecemeal',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      const frame = '    at Server.setupListenHandle [as _listen2] (node:net:2328:16)';

      assert.strictEqual(
        sanitizeLine(frame),
        REDACTED_STACK_FRAME,
        'the value of a frame to a reader is that a stack was printed at all'
      );
    }
  );

  test(
    'a previewed line is truncated to the documented bound and says how much it withheld',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      const long = 'x'.repeat(OUTPUT_PREVIEW_LINE_CHARS + 40);
      const sanitized = sanitizeLine(long);

      assert.strictEqual(
        sanitized.startsWith('x'.repeat(OUTPUT_PREVIEW_LINE_CHARS)),
        true,
        'the bound is a prefix, so what is shown is what was written'
      );
      assert.strictEqual(
        sanitized.includes('40 more character(s) withheld'),
        true,
        'a reader is told the line was cut and by how much, rather than guessing'
      );
    }
  );

  test(
    'a captured stream is summarized and bounded, never reproduced',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      // Eight lines, one of them path-bearing, against a six-line preview
      // bound: the summary must count all eight, preview six, say so, and
      // disclose nothing from the path.
      const captured =
        'line one\n' +
        'reading C:\\Program Files\\secret store\\activities.json failed\n' +
        'line three\n\n' +
        'line five\nline six\nline seven\nline eight\n';
      const summary = summarizeOutput('stderr', captured);

      assert.strictEqual(
        summary.startsWith(
          `stderr: 8 line(s), ${Buffer.byteLength(captured, 'utf8')} byte(s), sha256 `
        ),
        true,
        'the header counts every line — the blank one included — and the bytes'
      );
      assert.strictEqual(
        new RegExp(`sha256 [0-9a-f]{${OUTPUT_DIGEST_CHARS}}$`, 'm').test(summary),
        true,
        `the digest is exactly ${OUTPUT_DIGEST_CHARS} hex characters — enough to ` +
          `compare two runs, not enough to reconstruct anything`
      );
      assert.strictEqual(
        summary.includes(`... 2 more line(s) withheld`),
        true,
        'the preview is bounded and says how many lines it withheld'
      );
      for (const fragment of ['Program', 'secret store', 'activities.json']) {
        assert.strictEqual(
          summary.includes(fragment),
          false,
          `the summary must not retain ${JSON.stringify(fragment)}`
        );
      }
      assert.strictEqual(
        summary.includes('line eight'),
        false,
        'nothing past the preview bound appears, so the stream is never reproduced'
      );
    }
  );

  test(
    'a store path is reduced to its basename and a category, in both categories',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      const writable = describeStore(writableStorePath('redaction-probe'));
      const unwritable = describeStore(unwritableStorePath('redaction-probe'));

      assert.strictEqual(
        writable,
        "redaction-probe.json (writable, directly inside the suite's temporary root)",
        'a reader needs which store and which category, not where it is'
      );
      assert.strictEqual(
        unwritable,
        'activities.json (parent directory absent — the deliberately unwritable case)',
        'the unwritable case is named as such, which is the fact that explains a 500'
      );
      for (const description of [writable, unwritable]) {
        assert.strictEqual(
          description.includes(temporaryRoot),
          false,
          'the absolute path of the temporary root must never appear'
        );
        assert.strictEqual(
          description.includes(os.tmpdir()),
          false,
          "nor the host's temporary directory, which is filesystem layout"
        );
      }
    }
  );
});

/* ========================================================================= *
 * Startup and the readiness contract
 *
 * One child serves this whole group, and the ORDER of the cases is part of
 * their meaning: the "exactly one line" case runs while the child has served
 * no requests at all, and the "still exactly once" case runs after it has
 * served several. Reversing them would make the first unfalsifiable.
 * ========================================================================= */

describe('startup and the readiness contract', () => {
  /** @type {object} */
  let service;

  before(
    async () => {
      service = await startService(writableStorePath('startup'));
    },
    { timeout: CASE_TIMEOUT_MS }
  );

  after(
    async () => {
      await stopService(service);
    },
    { timeout: CASE_TIMEOUT_MS }
  );

  test(
    'logs a readiness line whose text is exactly the documented line',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      const lines = outputLines(service.stdout);

      assert.ok(
        lines.length >= 1,
        `the service logged nothing on stdout\n${describeService(service)}`
      );
      assert.strictEqual(
        lines[0],
        READINESS_LINE,
        'the readiness line must be exactly the documented text, including the ' +
          'trailing slash and the loopback address'
      );
    }
  );

  test(
    'prints exactly one line on stdout for a clean startup with no requests served',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      // No request has been issued to this child yet — the case above only read
      // its captured output. The settling period is what makes the assertion
      // real: without it, a second line could simply not have arrived.
      await sleep(QUIET_PERIOD_MS);

      // The raw comparison is the strongest form of "exactly one line", and it
      // is the assertion the contract actually calls for: the whole of stdout
      // is the readiness line and its single terminating newline. Nothing is
      // filtered out on the way — a blank line the service printed would fail
      // here, as it should, because a blank line is still output.
      assert.strictEqual(
        normalizeNewlines(service.stdout),
        `${READINESS_LINE}\n`,
        `stdout must be exactly the readiness line and one terminating newline — ` +
          `${outputLines(service.stdout).length} line(s) were written\n` +
          `${describeService(service)}`
      );
      assert.deepStrictEqual(
        outputLines(service.stdout),
        [READINESS_LINE],
        'the startup line is the service\'s only signal — the feature adds no ' +
          'request logging, no metrics and no health endpoint'
      );
      assert.strictEqual(
        service.stderr,
        '',
        `a clean startup must write nothing to stderr\n${describeService(service)}`
      );
    }
  );

  test(
    'is still alive after readiness',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      assert.strictEqual(
        service.child.exitCode,
        null,
        `the service must still be running after it reported readiness\n${describeService(service)}`
      );
      assert.strictEqual(
        service.child.signalCode,
        null,
        'the service must not have been signalled'
      );
    }
  );

  test(
    'emits the readiness line exactly once, even after serving several requests',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      // Traffic across both halves of the boundary — the preserved
      // fall-through, the claimed collection, and a claimed item — because
      // neither serving a request nor routing one into the namespace may add a
      // log line or repeat the readiness line.
      await request({ path: '/' });
      await request({ path: '/activities' });
      await request({ path: `/activities/${SEEDED_STUDENT_ID}` });
      // All three requests above are already awaited, so the only thing still
      // outstanding is an asynchronous flush of the child's stdio. That is a
      // thing that finishes, so it is waited FOR rather than slept through:
      // bounded, never accepting a shorter silence than `QUIET_PERIOD_MS`, and
      // waiting longer than that on a host still writing.
      await awaitOutputQuiescence(service);

      assert.strictEqual(
        countReadinessLines(service.stdout),
        1,
        `the readiness line must appear exactly once across the whole run\n${describeService(service)}`
      );
      assert.strictEqual(
        normalizeNewlines(service.stdout),
        `${READINESS_LINE}\n`,
        `after serving requests, stdout must STILL be exactly the readiness line ` +
          `and one newline — not one readiness line among others\n${describeService(service)}`
      );
      assert.deepStrictEqual(
        outputLines(service.stdout),
        [READINESS_LINE],
        `serving requests must add no log output at all\n${describeService(service)}`
      );
      assert.strictEqual(
        service.stderr,
        '',
        `serving valid requests must write nothing to stderr\n${describeService(service)}`
      );
    }
  );

  test(
    'loading the file as a module prints no readiness line and binds nothing',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      // The other half of the readiness contract, and the half that is easy to
      // lose. The line is emitted from inside the `require.main === module`
      // guard, so a caller that LOADS the service must see nothing: it has not
      // started anything, and a readiness line would be a claim about a
      // listener that does not exist. Anyone driving the exported seam — which
      // is how this file asserts the loopback bind, and how a harness reaches
      // the service when the literal port is unavailable — depends on that
      // silence being deliberate rather than incidental.
      //
      // Asserted in a CHILD process because the question is about what a fresh
      // load writes to stdout. In this process the module is already in the
      // CommonJS registry from the case that requires it, so a second require
      // would print nothing for a reason that has nothing to do with the guard.
      const result = await runNodeToCompletion(
        ['-e', "console.log('listening=' + require('./server').server.listening);"],
        writableStorePath('module-load-silence')
      );

      assert.deepStrictEqual(
        outputLines(result.stdout),
        ['listening=false'],
        `loading the module must print exactly the caller's own line — no readiness ` +
          `line, and nothing bound. stdout was ${JSON.stringify(result.stdout)}`
      );
      assert.strictEqual(
        countReadinessLines(result.stdout),
        0,
        'the readiness line belongs to direct execution alone: a module load has ' +
          'started no listener and must claim no readiness'
      );
      assert.strictEqual(
        normalizeNewlines(result.stderr),
        '',
        `and a clean module load must write nothing to stderr. stderr was ` +
          `${JSON.stringify(result.stderr)}`
      );
      assert.strictEqual(
        result.code,
        0,
        'a module load that binds nothing holds no handle, so the process leaves ' +
          'of its own accord with a clean status'
      );
    }
  );
});


/* ========================================================================= *
 * One running instance: the preserved response, the namespace boundary, and
 * loopback-only reachability
 *
 * The instance's store lives outside the checkout and nothing below writes to
 * it, so the read cases answer from the workbook seed.
 * ========================================================================= */

describe('a running instance', () => {
  /** @type {object} */
  let service;

  before(
    async () => {
      service = await startService(writableStorePath('running'));
    },
    { timeout: CASE_TIMEOUT_MS }
  );

  after(
    async () => {
      await stopService(service);
    },
    { timeout: CASE_TIMEOUT_MS }
  );

  /* ----------------------------------------------------------------------- *
   * The preserved response, byte for byte
   *
   * The compatibility contract: every method on every path outside the
   * `/activities` namespace answers the same 200, `text/plain`, 34-byte body.
   * Each path is its own case, so a route predicate that captured one of them
   * reports exactly which one.
   * ----------------------------------------------------------------------- */

  describe('the preserved response', () => {
    test(
      'GET / answers 200 text/plain with the gold 34-byte body',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const response = await request({ path: '/' });

        assertPreservedResponse(response, 'GET /');
        // Asserted on raw bytes above; this decoded comparison is what turns a
        // hash mismatch into a readable diff when someone edits the greeting.
        assert.strictEqual(
          response.raw.toString('utf8'),
          GOLD_BODY,
          'the preserved body text must be unchanged, trailing newline included'
        );
      }
    );

    test(
      'the preserved Content-Type carries no charset parameter',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const response = await request({ path: '/' });
        const contentType = response.headers['content-type'];

        // Exact equality, deliberately not `startsWith`: a `startsWith` check
        // would accept `text/plain; charset=utf-8`, which is a different
        // response. The absence of the parameter is preserved behaviour, and
        // this case exists to notice if it is ever "corrected".
        assert.strictEqual(
          contentType,
          GOLD_CONTENT_TYPE,
          `the preserved response must send Content-Type exactly ` +
            `"${GOLD_CONTENT_TYPE}" (received ${JSON.stringify(contentType)})`
        );
        assert.strictEqual(
          contentType.includes('charset'),
          false,
          'the pre-feature response carried no charset parameter and this ' +
            'feature deliberately did not add one'
        );
      }
    );

    test(
      'GET /nonsense answers the identical gold response',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        assertPreservedResponse(await request({ path: '/nonsense' }), 'GET /nonsense');
      }
    );

    test(
      'GET /index.html answers the identical gold response',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        assertPreservedResponse(await request({ path: '/index.html' }), 'GET /index.html');
      }
    );

    test(
      'GET /students/S001 answers the identical gold response and exposes no student data',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const response = await request({ path: `/students/${SEEDED_STUDENT_ID}` });

        assertPreservedResponse(response, `GET /students/${SEEDED_STUDENT_ID}`);
        // This path is outside the `/activities` namespace and names no route,
        // so it must answer with nothing about a student — asserted on the
        // absence of the seeded label as well as on the hash.
        assert.strictEqual(
          response.raw.toString('utf8').includes(SEEDED_ACTIVITY_LABEL),
          false,
          'no route outside the /activities namespace may return student data'
        );
      }
    );

    test(
      'POST / answers the identical gold response, because the fall-through is method-agnostic',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const response = await request(
          {
            method: 'POST',
            path: '/',
            headers: { 'Content-Type': 'application/json' },
          },
          JSON.stringify({ studentId: SEEDED_STUDENT_ID, activity: 'Chess Club' })
        );

        // A well-formed submission sent to a path outside the namespace is
        // still answered by the preserved response, and is NOT stored. The
        // feature claims requests by path first, never by method or body.
        assertPreservedResponse(response, 'POST /');
      }
    );
  });

  /* ----------------------------------------------------------------------- *
   * The namespace boundary, one named case per path
   *
   * The boundary is SEGMENT-SAFE: a path belongs to the feature only when its
   * normalized pathname is `/activities` or begins with `/activities/`.
   *
   * The two halves assert opposite things. A path outside the namespace must
   * still receive the legacy 34-byte body — `/activities-old` and
   * `/activitieslist` share the namespace's characters but not its segment
   * boundary, and a `startsWith` predicate against the raw request target
   * would capture both. A path inside it must be answered by the feature, and
   * the claimed cases assert what the route actually returned rather than
   * merely that it was not the legacy body, so a namespace that stopped being
   * routed altogether — which would also answer 200 — cannot pass.
   * ----------------------------------------------------------------------- */

  describe('the namespace boundary', () => {
    test(
      '/activities-old is NOT claimed: it still answers the legacy 34-byte body',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        // One character past the namespace and therefore outside it, so this
        // path must fall through to the preserved response — which is what a
        // `startsWith('/activities')` predicate gets wrong.
        assertPreservedResponse(await request({ path: '/activities-old' }), 'GET /activities-old');
      }
    );

    test(
      '/activitieslist is NOT claimed: it still answers the legacy 34-byte body',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        assertPreservedResponse(await request({ path: '/activitieslist' }), 'GET /activitieslist');
      }
    );

    test(
      'an arbitrary unrelated path is NOT claimed: it still answers the legacy 34-byte body',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        assertPreservedResponse(
          await request({ path: '/not-a-feature-path' }),
          'GET /not-a-feature-path'
        );
      }
    );

    test(
      '/activities IS claimed: it is routed by method and serves the submission form',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const response = await request({ path: '/activities' });

        assertNotPreservedResponse(response, 'GET /activities');
        assert.strictEqual(response.status, 200, 'GET /activities must answer 200');
        assert.strictEqual(
          response.headers['content-type'],
          HTML_CONTENT_TYPE,
          'the form is served as HTML with an explicit charset, unlike the ' +
            'charset-less preserved response'
        );
        assert.strictEqual(
          response.text.includes('<form method="post" action="/activities">'),
          true,
          'the served page must be the real submission form, not a stub'
        );
      }
    );

    test(
      '/activities/ IS claimed and resolves to the same route as /activities',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const withSlash = await request({ path: '/activities/' });
        const withoutSlash = await request({ path: '/activities' });

        assertNotPreservedResponse(withSlash, 'GET /activities/');
        assert.strictEqual(withSlash.status, 200, 'GET /activities/ must answer 200');
        // Compared against the sibling route's own answer rather than against a
        // hard-coded page hash: the assertion here is that one trailing slash
        // is stripped, and it must keep holding when the page's markup changes.
        assert.strictEqual(
          sha256(withSlash.raw),
          sha256(withoutSlash.raw),
          'a single trailing slash is stripped before matching, so /activities/ ' +
            'and /activities are the same route'
        );
      }
    );

    test(
      '/activities?x=1 IS claimed: the query string is excluded from the pathname before matching',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const withQuery = await request({ path: '/activities?x=1' });
        const withoutQuery = await request({ path: '/activities' });

        assertNotPreservedResponse(withQuery, 'GET /activities?x=1');
        assert.strictEqual(withQuery.status, 200, 'GET /activities?x=1 must answer 200');
        assert.strictEqual(
          sha256(withQuery.raw),
          sha256(withoutQuery.raw),
          'the pathname is taken from a parsed URL, so a query string cannot ' +
            'reach the match — a predicate tested against the raw request ' +
            'target would misclassify this path'
        );
      }
    );

    test(
      '/activities/S001 IS claimed: it answers one student\'s activities as JSON',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const response = await request({ path: `/activities/${SEEDED_STUDENT_ID}` });

        assertNotPreservedResponse(response, `GET /activities/${SEEDED_STUDENT_ID}`);
        assert.strictEqual(response.status, 200, 'the read route must answer 200');
        assert.strictEqual(
          response.headers['content-type'],
          JSON_CONTENT_TYPE,
          'the read route answers JSON only, in either request mode'
        );

        const payload = JSON.parse(response.text);
        assert.strictEqual(
          payload.studentId,
          SEEDED_STUDENT_ID,
          'the payload names the student it is about'
        );
        // This instance's store does not exist yet, so the read is answered
        // from the workbook seed — which is also the evidence that a read has
        // no write side effect.
        assert.deepStrictEqual(
          payload.activities,
          [
            {
              studentId: SEEDED_STUDENT_ID,
              activity: SEEDED_ACTIVITY_LABEL,
              source: RECORD_SOURCE_WORKBOOK,
            },
          ],
          'an unmaterialised store answers from the workbook seed, and a seeded ' +
            'record carries source "workbook" and no submittedAt'
        );
      }
    );

    test(
      '/activities/S001/ IS claimed and resolves to the same route as /activities/S001',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const withSlash = await request({ path: `/activities/${SEEDED_STUDENT_ID}/` });
        const withoutSlash = await request({ path: `/activities/${SEEDED_STUDENT_ID}` });

        assertNotPreservedResponse(withSlash, `GET /activities/${SEEDED_STUDENT_ID}/`);
        assert.strictEqual(withSlash.status, 200, 'the trailing-slash form must answer 200');
        assert.strictEqual(
          sha256(withSlash.raw),
          sha256(withoutSlash.raw),
          'a single trailing slash is stripped, so the item route is the same ' +
            'route with or without it'
        );
      }
    );

    test(
      '/activities/S001/extra IS claimed but resolves to no route: 404 not_found, never 405',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const response = await request({ path: `/activities/${SEEDED_STUDENT_ID}/extra` });

        assertNotPreservedResponse(response, `GET /activities/${SEEDED_STUDENT_ID}/extra`);
        assert.strictEqual(
          response.status,
          404,
          'a path inside the namespace that names no route is a 404'
        );
        assert.strictEqual(
          JSON.parse(response.text).error,
          'not_found',
          'the error code identifies an unresolved path'
        );
        // Route resolution happens before the method is considered, so no
        // `Allow` header may appear here: an `Allow` would assert that the
        // resource exists and merely refuses the verb, and nothing exists here
        // under any verb.
        assert.strictEqual(
          response.headers.allow,
          undefined,
          'a 404 must not carry an Allow header'
        );
      }
    );

    test(
      'an unsupported method on /activities/S001/extra is still 404, not 405',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        // The same unresolved path with a method the namespace never accepts.
        // Both facts are wrong about this request, and the contract fixes which
        // one wins: the path resolves first, so this is a 404.
        const response = await request({
          method: 'DELETE',
          path: `/activities/${SEEDED_STUDENT_ID}/extra`,
        });

        assert.strictEqual(response.status, 404, 'route resolution precedes the method check');
        assert.strictEqual(JSON.parse(response.text).error, 'not_found');
        assert.strictEqual(response.headers.allow, undefined);
      }
    );
  });

  /* ----------------------------------------------------------------------- *
   * Loopback-only reachability
   *
   * The listener is bound to `127.0.0.1`. Widening it would expose a write
   * endpoint that has no authentication, no authorization and no session
   * mechanism of any kind — a submission is attributed to whatever Student ID
   * the submitter types, and the service checks only that the ID names a real
   * student, never that the submitter is that student. Loopback is therefore
   * not a default that happens to be in place; it is the containment this
   * feature relies on.
   * ----------------------------------------------------------------------- */

  describe('loopback-only reachability', () => {
    test(
      'the service is reachable on 127.0.0.1:3000',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const outcome = await probeConnect(HOST, CONNECT_DEADLINE_MS);
        assert.strictEqual(
          outcome,
          'connected',
          `a TCP connection to ${HOST}:${PORT} must be accepted (observed: ${outcome})`
        );

        assertPreservedResponse(
          await request({ path: '/', host: HOST }),
          `GET / over ${HOST}:${PORT}`
        );
      }
    );

    test(
      'the bind is the loopback address rather than every interface',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        // EVIDENCE THAT DOES NOT DEPEND ON THIS HOST'S ADDRESSES, taken through
        // the seam `server.js` exports for exactly this purpose. Requiring the
        // module binds nothing — `server.listen` sits behind the main-module
        // guard — so the exported server can be listened on port 0 and asked
        // what it actually bound. `address()` is the kernel's answer rather than
        // the service's: a listener opened with the exported `hostname` reports
        // `127.0.0.1`, where a bind widened to every interface would report the
        // wildcard `0.0.0.0`. Port 0 because the running instance still holds
        // 3000.
        //
        // The store path is redirected into the temporary root BEFORE the
        // require: `activity-store.js` resolves `ACTIVITY_STORE` once at module
        // load and its default sits in the checkout, and nothing in this file
        // may write there.
        process.env.ACTIVITY_STORE = writableStorePath('in-process-bind');
        const composed = require('../server');

        assert.strictEqual(
          composed.hostname,
          HOST,
          'the exported bind host is the loopback literal this suite asserts against'
        );
        assert.strictEqual(
          composed.port,
          PORT,
          'the exported bind port is the literal this suite asserts against'
        );
        assert.strictEqual(
          composed.server.listening,
          false,
          'requiring the module must not have bound anything'
        );

        const bound = await new Promise((resolve, reject) => {
          // Detached on success, so the module-level server object is not left
          // carrying a one-shot rejection handler for the rest of the run.
          const onError = (error) => reject(error);

          composed.server.once('error', onError);
          composed.server.listen(0, composed.hostname, () => {
            composed.server.off('error', onError);
            resolve(composed.server.address());
          });
        });

        try {
          assert.strictEqual(
            bound.address,
            HOST,
            `a listener opened with the exported hostname must bind the loopback ` +
              `address, not the wildcard (observed: ${bound.address}); widening ` +
              `the bind would expose an unauthenticated write endpoint`
          );
          assert.strictEqual(bound.family, 'IPv4', 'the loopback bind is IPv4');
        } finally {
          // Bounded like every other wait here, and awaited rather than fired
          // and forgotten: a listener left open in this process is the one
          // handle that would make the runner sit there after its last
          // assertion.
          const closed = await awaitWithDeadline(
            new Promise((resolve) => composed.server.close(() => resolve())),
            CLOSE_DEADLINE_MS
          );
          assert.strictEqual(
            closed,
            true,
            `the in-process listener must close within ${CLOSE_DEADLINE_MS}ms`
          );
        }

        // AND THE SAME INVARIANT AGAINST A REAL PROCESS, wherever this host can
        // supply an address to be refused from. The addresses are resolved at
        // run time rather than written down, because the set a host holds is
        // its own business; holding none is a normal state, and it costs this
        // case nothing, because the assertions above already carry the
        // invariant. One address is enough: the failure guarded against is a
        // widened bind, and a bind widened to every interface answers on all of
        // them, so the first address detects it while each further probe only
        // repeats that evidence at the cost of another refusal-or-timeout wait.
        const nonLoopback = [];
        for (const interfaces of Object.values(os.networkInterfaces())) {
          for (const entry of interfaces ?? []) {
            if (entry.family === 'IPv4' && !entry.internal) {
              nonLoopback.push(entry.address);
            }
          }
        }

        for (const address of nonLoopback.slice(0, 1)) {
          const outcome = await probeConnect(address, CONNECT_DEADLINE_MS);

          // `connected` is the only failing outcome. A refusal and a dropped
          // SYN are reported separately by `probeConnect` and both are
          // acceptable evidence here — the service is not answering on that
          // address either way — but they are not conflated, so the message
          // says which was observed.
          assert.notStrictEqual(
            outcome,
            'connected',
            `the listener is bound to ${HOST} only, so ${address}:${PORT} must not ` +
              `accept a connection (observed: ${outcome}); widening the bind would ` +
              `expose an unauthenticated write endpoint`
          );
        }

        // And the running instance is still answering on loopback, which is what
        // makes everything above evidence about the BIND rather than about a
        // service that had simply stopped.
        assertPreservedResponse(
          await request({ path: '/', host: HOST }),
          `GET / over ${HOST}:${PORT} after the bind-address assertions`
        );
      }
    );
  });
});

/* ========================================================================= *
 * The EADDRINUSE disposition
 *
 * A refused bind is HANDLED: `server.js`'s `'error'` listener logs the code and
 * sets a non-zero exit status instead of letting the process terminate on an
 * unhandled `'error'` event and a raw stack trace. That difference is what lets
 * a pre-flight check — this file's, or an operator's — report an environment
 * problem instead of leaving a stack trace for a reader to interpret.
 *
 * WHAT THESE CASES HAVE TO BE CAREFUL ABOUT. The two dispositions are easy to
 * confuse, because almost everything observable about them agrees: with the
 * port held, BOTH the handled listener and a listener with no `'error'` handler
 * exit with status 1, send no signal, write nothing to stdout, and produce
 * output containing the string `EADDRINUSE`. They differ in exactly one
 * respect: the handled disposition writes ONE line,
 * `server error: EADDRINUSE`, and the unhandled one writes a re-thrown
 * stack-trace report. So these cases assert the stderr exactly and reject the
 * crash markers by name. Anything weaker passes against the regression it is
 * named for, which is worse than having no case at all — it reports protection
 * that is not there.
 *
 * The second instance is spawned with `spawnService` rather than
 * `startService`, deliberately, and for two independent reasons.
 * `startService` REQUIRES the port before spawning and fails fast when it is
 * held — against the holder above that is precisely the collision this group
 * is about, so it would abort the case instead of producing it. And it then
 * gates on a readiness line that a refused bind never writes, so it would
 * report a startup failure where the refusal IS the subject.
 * ========================================================================= */

describe('the EADDRINUSE disposition', () => {
  /** @type {object} */
  let holdingInstance;
  /** @type {object|null} */
  let refusedInstance = null;

  before(
    async () => {
      holdingInstance = await startService(writableStorePath('addrinuse-holder'));
    },
    { timeout: CASE_TIMEOUT_MS }
  );

  after(
    async () => {
      // The refused instance is reaped first, and with `killService` rather
      // than `stopService`: it never held the port, so waiting for the port to
      // be released here would only wait out the instance that legitimately
      // holds it. The kill is unconditional, which is what guarantees that an
      // instance which somehow survived the bind failure cannot outlive this
      // group.
      if (refusedInstance !== null) {
        await killService(refusedInstance);
        refusedInstance = null;
      }
      await stopService(holdingInstance);
    },
    { timeout: CASE_TIMEOUT_MS }
  );

  test(
    'a second instance exits non-zero with the HANDLED listener disposition',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      refusedInstance = spawnService(writableStorePath('addrinuse-refused'));

      // `closed`, not `exited`. Every assertion below reads the child's
      // captured output, and the exit event can arrive before its stdio has
      // finished flushing — which would let this case read a partial stderr
      // and pass, or fail, on the timing of a pipe rather than on the
      // disposition it is about. `'close'` is emitted once the process has gone
      // AND its streams are closed, so the capture is complete.
      //
      // Bounded, and the `after` hook kills it regardless, so a service that
      // wrongly kept running cannot hang the suite — it fails this assertion
      // and is reaped.
      const closed = await awaitWithDeadline(refusedInstance.closed, EXIT_DEADLINE_MS);

      assert.strictEqual(
        closed,
        true,
        `the second instance must exit rather than keep running with a refused ` +
          `bind\n${describeService(refusedInstance)}`
      );
      assert.strictEqual(
        typeof refusedInstance.close.code,
        'number',
        `the second instance must exit of its own accord with a status code, not ` +
          `be terminated by a signal\n${describeService(refusedInstance)}`
      );
      assert.strictEqual(
        refusedInstance.close.signal,
        null,
        'no signal was sent to it — it left on its own'
      );
      assert.strictEqual(
        refusedInstance.close.code,
        HANDLED_BIND_EXIT_CODE,
        `the handled listener sets process.exitCode = ${HANDLED_BIND_EXIT_CODE} and lets ` +
          `the loop drain, so the exit status is exactly that\n${describeService(refusedInstance)}`
      );

      // THE ASSERTION THAT MAKES THIS CASE LOAD-BEARING.
      //
      // stderr must be EXACTLY the handled line and its newline. A test for
      // `output.includes('EADDRINUSE')` cannot distinguish the disposition this
      // group exists to protect from an unhandled `'error'` event: that also
      // exits 1, also writes nothing to stdout, and also contains the string
      // `EADDRINUSE`, inside a multi-line re-thrown stack trace. Only the exact
      // comparison separates them.
      assert.deepStrictEqual(
        outputLines(refusedInstance.stderr),
        [HANDLED_BIND_ERROR_LINE],
        `a refused bind must be reported by server.js's own 'error' listener as ` +
          `the single line "${HANDLED_BIND_ERROR_LINE}". More than one line means the ` +
          `listener is gone and Node is printing an unhandled-error report, which is ` +
          `the pre-feature crash this disposition replaced\n${describeService(refusedInstance)}`
      );
      assert.strictEqual(
        normalizeNewlines(refusedInstance.stderr),
        `${HANDLED_BIND_ERROR_LINE}\n`,
        `stderr must be exactly that line and one terminating newline\n` +
          `${describeService(refusedInstance)}`
      );

      // And nothing at all on stdout: an instance that never bound never
      // reached its listen callback, so it has no readiness to claim.
      assert.strictEqual(
        normalizeNewlines(refusedInstance.stdout),
        '',
        `an instance that never bound must write nothing to stdout\n${describeService(refusedInstance)}`
      );
      assert.strictEqual(
        countReadinessLines(refusedInstance.stdout),
        0,
        'an instance that never bound must not claim readiness'
      );
    }
  );

  test(
    'the refused instance emits no unhandled-error report, no stack frame and no Node internals',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      // The negative half of the same contract, as its own named case so it
      // fails on its own and says which marker appeared.
      //
      // The case above already pins stderr exactly, which implies all of this;
      // stating it separately is deliberate, because the implication runs the
      // wrong way for a reader. If someone deletes the `'error'` listener from
      // server.js, this case names the crash for what it is instead of
      // reporting a string mismatch and leaving the reader to recognise a Node
      // stack trace in the diff.
      assert.notStrictEqual(
        refusedInstance,
        null,
        'this case reads the instance the preceding case spawned'
      );

      for (const marker of UNHANDLED_CRASH_MARKERS) {
        assert.strictEqual(
          refusedInstance.stderr.includes(marker),
          false,
          `the refused instance's stderr must not contain ${JSON.stringify(marker)} — ` +
            `that fragment belongs to Node's unhandled-'error'-event report, so its ` +
            `presence means server.js's listener is no longer handling the refused ` +
            `bind\n${describeService(refusedInstance)}`
        );
      }

      assert.strictEqual(
        /^\s*at\s/m.test(refusedInstance.stderr),
        false,
        `the refused instance must print no stack frame: a handled bind failure is ` +
          `one legible line, and a stack trace is what the pre-feature crash produced\n` +
          `${describeService(refusedInstance)}`
      );
    }
  );

  test(
    'the first instance is unaffected and still serving after the refused bind',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      assertPreservedResponse(
        await request({ path: '/' }),
        'GET / on the holding instance after a second instance was refused'
      );
      assert.strictEqual(
        holdingInstance.child.exitCode,
        null,
        `another process failing to bind must not disturb the holder\n${describeService(holdingInstance)}`
      );
      assert.strictEqual(
        countReadinessLines(holdingInstance.stdout),
        1,
        'the holder logged readiness once and has logged nothing since'
      );
      assert.strictEqual(
        holdingInstance.stderr,
        '',
        `the holder must not have logged an error of its own\n${describeService(holdingInstance)}`
      );
    }
  );
});


/* ========================================================================= *
 * PHASE 6 — the unwritable-store disposition
 *
 * A failure mode that kills the service passes no test here. The contract is
 * that a refused write is answered `500 store_write_failed`, that the previous
 * document is left intact, and that the process carries on serving — so this
 * group asserts the response AND the survival, and asserts the survival on
 * both halves of the boundary.
 *
 * THE MECHANISM: the store path's PARENT DIRECTORY does not exist and is never
 * created, so the staging write to `<store>.tmp` fails with `ENOENT` before the
 * rename over the store is reached — `activity-store.js` awaits the two in that
 * order, so the first refusal is the only one that happens. An absent parent is
 * used because it fails that way on every platform, which a permission bit does
 * not: on Windows `fs.chmod` reaches a file's read-only flag and cannot make a
 * directory unwritable at all.
 * ========================================================================= */

describe('the unwritable-store disposition', () => {
  /** @type {object} */
  let service;
  /** @type {string} */
  let storePath;

  before(
    async () => {
      storePath = unwritableStorePath('unwritable');
      service = await startService(storePath);
    },
    { timeout: CASE_TIMEOUT_MS }
  );

  after(
    async () => {
      await stopService(service);
    },
    { timeout: CASE_TIMEOUT_MS }
  );

  test(
    'POST /activities answers 500 store_write_failed when the store cannot be written',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      // A submission that is valid in every respect: S001 is in the workbook
      // key set and the label is well within the bound. The only thing wrong
      // with it is the store, which is the point.
      const response = await request(
        {
          method: 'POST',
          path: '/activities',
          headers: { 'Content-Type': 'application/json' },
        },
        JSON.stringify({ studentId: SEEDED_STUDENT_ID, activity: 'Chess Club' })
      );

      assert.strictEqual(
        response.status,
        500,
        `a refused write is a server fault, not a client one\n${describeService(service)}`
      );
      assert.strictEqual(
        response.headers['content-type'],
        JSON_CONTENT_TYPE,
        'the failure envelope is JSON'
      );

      const payload = JSON.parse(response.text);
      assert.strictEqual(
        payload.error,
        'store_write_failed',
        'the code must name the write failure specifically, not a generic fault'
      );
      assert.strictEqual(
        typeof payload.message,
        'string',
        'every error body carries the fixed sentence for its code'
      );
      // The envelope must not leak internals. The store path is the detail most
      // likely to escape into a message, and a client learns nothing useful
      // from it.
      assert.strictEqual(
        response.text.includes(storePath),
        false,
        'no filesystem path may appear in an error body'
      );
      assert.strictEqual(
        response.text.includes('ENOENT'),
        false,
        'no underlying system error code may appear in an error body'
      );
    }
  );

  test(
    'a form-encoded submission receives the same JSON 500 envelope',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      // HTML is rendered only for outcomes a person filling in the form can
      // act on. A 500 is not one of them — no amount of retyping fixes an
      // unwritable store — so both request modes get the JSON envelope.
      const response = await request(
        {
          method: 'POST',
          path: '/activities',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
        `studentId=${SEEDED_STUDENT_ID}&activity=Chess+Club`
      );

      assert.strictEqual(response.status, 500, 'the form mode fails the same way');
      assert.strictEqual(
        response.headers['content-type'],
        JSON_CONTENT_TYPE,
        'a 500 is answered with the JSON envelope in both request modes'
      );
      assert.strictEqual(JSON.parse(response.text).error, 'store_write_failed');
    }
  );

  test(
    'the service continues serving GET / immediately after the failed write',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      assertPreservedResponse(
        await request({ path: '/' }),
        'GET / immediately after a failed store write'
      );
    }
  );

  test(
    'GET /activities/S001 still answers from the workbook seed after the failed write',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const response = await request({ path: `/activities/${SEEDED_STUDENT_ID}` });

      // Per contract: the store was never created, so the read is answered
      // from the seed. The refused submission is absent, which is also the
      // evidence that the failure persisted nothing.
      assert.strictEqual(
        response.status,
        200,
        `a read is unaffected by a failed write\n${describeService(service)}`
      );
      assert.strictEqual(response.headers['content-type'], JSON_CONTENT_TYPE);

      const payload = JSON.parse(response.text);
      assert.deepStrictEqual(
        payload,
        {
          studentId: SEEDED_STUDENT_ID,
          activities: [
            {
              studentId: SEEDED_STUDENT_ID,
              activity: SEEDED_ACTIVITY_LABEL,
              source: RECORD_SOURCE_WORKBOOK,
            },
          ],
        },
        'the read answers the workbook seed, and carries no trace of the ' +
          'submission the failed write refused'
      );
    }
  );

  test(
    'the process is still alive after the failed write',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      assert.strictEqual(
        service.child.exitCode,
        null,
        `a refused write must not end the process\n${describeService(service)}`
      );
      assert.strictEqual(
        service.child.signalCode,
        null,
        'and it must not have been signalled'
      );
      assert.strictEqual(
        countReadinessLines(service.stdout),
        1,
        'it is the same process that started, not a restarted one'
      );
    }
  );

  test(
    'neither the store nor its staging sibling was created by the failed write',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      // The write is documented as non-destructive. With nothing there to
      // preserve, the observable form of that promise is that nothing was
      // left behind — including the `.tmp` staging file, which would hold the
      // same submitted data as the store itself.
      await assert.rejects(
        () => fs.access(storePath),
        (error) => error.code === 'ENOENT',
        'the store must not exist after a write that failed'
      );
      await assert.rejects(
        () => fs.access(`${storePath}.tmp`),
        (error) => error.code === 'ENOENT',
        'the staging sibling must not survive a failed write'
      );
      await assert.rejects(
        () => fs.access(path.dirname(storePath)),
        (error) => error.code === 'ENOENT',
        'the service must not create the missing directory on its own'
      );
    }
  );
});


/* ========================================================================= *
 * The protected-store startup disposition
 *
 * The third failure `server.js` owns, and the only one that happens before
 * there is a listener to report it or a request to answer with: an
 * `ACTIVITY_STORE` naming a tracked file of this repository is refused while
 * `activity-store.js` is loading, so the fault comes out of the feature
 * require rather than out of a handler.
 *
 * WHAT MAKES THIS GROUP LOAD-BEARING. Left uncaught, that throw becomes Node's
 * default uncaught-throw dump — measured at 1 421 bytes across 25 lines, with
 * 10 stack frames, 7 of them the CommonJS loader's internals, the absolute
 * path of three source files, the inspected error object, and the runtime's
 * version banner. Every one of those facts is correct and none of them is
 * diagnosis: what an operator needs is the code and the sentence naming the
 * variable, the file and the remedy. So these cases assert the report EXACTLY
 * and reject the dump's markers BY NAME, which is what fails if the startup
 * boundary is ever removed.
 *
 * The disposition is the same one a refused bind gets — one `server error:
 * <CODE>` line, a non-zero exit, nothing on stdout, no stack trace — because a
 * reader gating on that shape should not have to parse a line for one startup
 * fault and a stack dump for the other.
 *
 * This group binds NO port: the child refuses before it can listen, and the
 * module-consumer case loads the file without executing it as a program. It
 * still sits behind the file's pre-flight probe, because the probe gates the
 * file rather than the case.
 * ========================================================================= */

describe('the protected-store startup disposition', () => {
  /** @type {object|null} */
  let refusedInstance = null;

  /** The protected file's digest, taken BEFORE anything is spawned. */
  let protectedFileDigestBefore = null;

  before(
    async () => {
      // Hashed first, so the comparison at the end is against the file as it
      // was before a service was ever pointed at it.
      protectedFileDigestBefore = sha256(await fs.readFile(protectedStorePath()));

      // `spawnService`, not `startService`: this child is REFUSED, so it never
      // writes a readiness line and gating on one would report a startup
      // failure where the refusal is the subject.
      refusedInstance = spawnService(protectedStorePath());

      // `closed`, not `exited`: every case below reads the captured output, and
      // only `'close'` guarantees the pipes have finished flushing.
      const closed = await awaitWithDeadline(refusedInstance.closed, EXIT_DEADLINE_MS);
      assert.strictEqual(
        closed,
        true,
        `an instance given a protected store must refuse to start and leave, not ` +
          `keep running\n${describeService(refusedInstance)}`
      );
    },
    { timeout: CASE_TIMEOUT_MS }
  );

  after(
    async () => {
      if (refusedInstance !== null) {
        // `killService` rather than `stopService`: this child never held port
        // 3000, so waiting for the port to be released here would only wait out
        // whatever legitimately holds it. The call is unconditional and safe on
        // a child that has already gone, which is what keeps the no-orphans
        // case at the foot of this file honest.
        await killService(refusedInstance);
        refusedInstance = null;
      }
    },
    { timeout: CASE_TIMEOUT_MS }
  );

  test(
    'the instance exits non-zero, writes nothing to stdout, and claims no readiness',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      assert.strictEqual(
        typeof refusedInstance.close.code,
        'number',
        `it must exit of its own accord with a status code, not be terminated by a ` +
          `signal\n${describeService(refusedInstance)}`
      );
      assert.strictEqual(
        refusedInstance.close.signal,
        null,
        'no signal was sent to it — it left on its own'
      );
      assert.strictEqual(
        refusedInstance.close.code,
        HANDLED_STARTUP_FAULT_EXIT_CODE,
        `the startup boundary sets process.exitCode = ${HANDLED_STARTUP_FAULT_EXIT_CODE} and ` +
          `lets the loop drain, so the exit status is exactly that — a misconfigured ` +
          `service must not exit 0 and look like a clean run to a start script\n` +
          `${describeService(refusedInstance)}`
      );

      assert.strictEqual(
        normalizeNewlines(refusedInstance.stdout),
        '',
        `an instance that never composed the service must write nothing to stdout\n` +
          `${describeService(refusedInstance)}`
      );
      assert.strictEqual(
        countReadinessLines(refusedInstance.stdout),
        0,
        'an instance that never bound must not claim readiness'
      );
    }
  );

  test(
    'stderr is exactly the handled line and one actionable sentence',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      const lines = outputLines(refusedInstance.stderr);

      assert.strictEqual(
        lines.length,
        2,
        `the refusal must be reported as exactly two lines — the handled shape and ` +
          `the sentence that says what to change — and ${lines.length} were written. ` +
          `More than two means the uncaught-throw dump is back\n` +
          `${describeService(refusedInstance)}`
      );
      assert.strictEqual(
        lines[0],
        HANDLED_STARTUP_FAULT_LINE,
        `the first line must be exactly "${HANDLED_STARTUP_FAULT_LINE}" — the same ` +
          `shape the 'error' listener uses for a refused bind, so one gate reads both`
      );

      for (const marker of PROTECTED_FAULT_SENTENCE_MARKERS) {
        assert.strictEqual(
          lines[1].includes(marker),
          true,
          `the sentence must name ${JSON.stringify(marker)}: a refusal that does not ` +
            `name the variable, the file it resolved to and where to point it instead ` +
            `is not actionable, and being actionable is the only reason it is printed ` +
            `at all. Received ${JSON.stringify(lines[1])}`
        );
      }
    }
  );

  test(
    'the refusal prints no stack frame, no Node internals and no filesystem path',
    { timeout: CASE_TIMEOUT_MS },
    () => {
      // The negative half of the same contract, as its own named case so it
      // fails on its own and says which marker appeared. The case above pins
      // the line count, which implies all of this; stating it separately is
      // deliberate, because the implication runs the wrong way for a reader —
      // this case names the dump for what it is instead of reporting a count
      // mismatch and leaving them to recognise a stack trace in the diff.
      for (const marker of UNCAUGHT_THROW_MARKERS) {
        assert.strictEqual(
          refusedInstance.stderr.includes(marker),
          false,
          `stderr must not contain ${JSON.stringify(marker)} — that fragment belongs ` +
            `to Node's uncaught-throw dump, so its presence means the startup ` +
            `boundary in server.js is no longer catching the configuration fault\n` +
            `${describeService(refusedInstance)}`
        );
      }

      assert.strictEqual(
        /^\s*at\s/m.test(refusedInstance.stderr),
        false,
        `the refusal must print no stack frame: a handled startup fault is one legible ` +
          `line plus its sentence, and a stack trace is what this disposition replaced\n` +
          `${describeService(refusedInstance)}`
      );

      // A misconfiguration report is read by whoever operates the host and
      // retained wherever their logs go, so it names the repository-relative
      // file and never the checkout's location on disk.
      assert.strictEqual(
        ABSOLUTE_PATH_SHAPE.test(refusedInstance.stderr),
        false,
        `the refusal must disclose no absolute path: the uncaught-throw dump it ` +
          `replaced carried three, and the message names the repository-relative file ` +
          `instead\n${describeService(refusedInstance)}`
      );
      assert.strictEqual(
        redactPaths(refusedInstance.stderr),
        refusedInstance.stderr,
        'and this suite\'s own path redactor finds nothing in it to remove, which is ' +
          'the same statement made by the tool that has to sanitize everything else'
      );

      assert.ok(
        Buffer.byteLength(refusedInstance.stderr, 'utf8') <= STARTUP_FAULT_STDERR_MAX_BYTES,
        `the whole report must stay within ${STARTUP_FAULT_STDERR_MAX_BYTES} bytes and it ` +
          `was ${Buffer.byteLength(refusedInstance.stderr, 'utf8')} — the dump this ` +
          `replaced was 1421\n${describeService(refusedInstance)}`
      );
    }
  );

  test(
    'the protected file is byte-identical and nothing was staged beside it',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      // Why the guard exists at all: a write is a `rename` OVER the target, so
      // a mistyped variable would not append to this file, it would replace it.
      // Refusing at load is what proves nothing was staged in the meantime.
      assert.strictEqual(
        sha256(await fs.readFile(protectedStorePath())),
        protectedFileDigestBefore,
        'a protected destination must be left byte-identical — the refusal happens ' +
          'before the store is read or written, so the file is never opened for ' +
          'writing and never renamed over'
      );
      await assert.rejects(
        () => fs.access(`${protectedStorePath()}.tmp`),
        (error) => error.code === 'ENOENT',
        'and the derived staging sibling must not have been created beside it'
      );
    }
  );

  test(
    'a hostile startup message is reported as one bounded line, never as two',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      // The sanitisation, asserted against an input no file in this repository
      // can produce. The real refusal composes a single well-behaved sentence,
      // so the boundary's promise — ONE bounded line, whatever the message was
      // built from — would otherwise rest on a message that could never test
      // it. A log line an error can extend at will is a log line an error can
      // forge a second entry in.
      //
      // THE MECHANISM: `server.js` is copied into the temporary root beside a
      // stub `./activities` that throws a fabricated fault carrying the
      // allow-listed code. Nothing else is needed, because the file's only
      // other require is the built-in `http` — and nothing in the checkout is
      // touched, since the copy and the stub both live under the temporary
      // root.
      const stubRoot = path.join(temporaryRoot, 'hostile-message');
      await fs.mkdir(stubRoot, { recursive: true });
      await fs.copyFile(SERVER_ENTRY_POINT, path.join(stubRoot, 'server.js'));

      // A newline, a Unicode line separator, a control character, a run of
      // spaces, and a message far past the 400-character bound.
      const hostile =
        'refused:\\nsecond line\\u2028third line\\u0007bell    spaced ' + 'x'.repeat(600);
      await fs.writeFile(
        path.join(stubRoot, 'activities.js'),
        `const error = new RangeError("${hostile}");\n` +
          `error.code = "E_STORE_PATH_PROTECTED";\n` +
          `throw error;\n`,
        'utf8'
      );

      const result = await runNodeToCompletion(
        [path.join(stubRoot, 'server.js')],
        writableStorePath('hostile-message'),
        stubRoot
      );

      const lines = outputLines(result.stderr);

      assert.strictEqual(
        lines.length,
        2,
        `a message carrying newlines and control characters must still be reported as ` +
          `exactly two lines, and ${lines.length} were written — a message that can add ` +
          `a line can forge a log entry. stderr was ${JSON.stringify(result.stderr)}`
      );
      assert.strictEqual(
        lines[0],
        HANDLED_STARTUP_FAULT_LINE,
        'the gateable first line is unaffected by whatever the message contains'
      );
      assert.ok(
        lines[1].length <= STARTUP_FAULT_DETAIL_MAX_CHARS + 3,
        `the sentence must be capped at ${STARTUP_FAULT_DETAIL_MAX_CHARS} characters plus ` +
          `the truncation marker, and it was ${lines[1].length}`
      );
      assert.strictEqual(
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(lines[1]),
        false,
        'no control character or line separator may survive into the reported line'
      );
      assert.strictEqual(
        /  /.test(lines[1]),
        false,
        'runs of whitespace are collapsed, so the line cannot be padded into ' +
          'something that reads as two fields'
      );
      assert.strictEqual(
        result.code,
        HANDLED_STARTUP_FAULT_EXIT_CODE,
        'and the disposition is unchanged: a non-zero exit, however the message was built'
      );
      assert.strictEqual(
        normalizeNewlines(result.stdout),
        '',
        'with nothing on stdout'
      );
    }
  );

  test(
    'a caller that loads the service as a module receives the fault itself',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      // The deliberate asymmetry in the boundary. Direct execution IS the
      // program, so it reports and leaves. A caller that requires the file is
      // composing the service itself and can do more with the error object than
      // this process could do with a line: inspect the code, report it in its
      // own terms, or decide to carry on. Reporting a line and handing back a
      // module with nothing in it would hide the fault from exactly the caller
      // best placed to act on it.
      const result = await runNodeToCompletion(
        [
          '-e',
          "try { require('./server'); console.log('resolved'); } " +
            "catch (error) { console.log('threw ' + error.code); }",
        ],
        protectedStorePath()
      );

      assert.deepStrictEqual(
        outputLines(result.stdout),
        ['threw E_STORE_PATH_PROTECTED'],
        `requiring the file must reject with the configuration fault, carrying its ` +
          `code, rather than resolving to a module that cannot serve. stdout was ` +
          `${JSON.stringify(result.stdout)}`
      );
      assert.strictEqual(
        normalizeNewlines(result.stderr),
        '',
        `and the module path must print nothing of its own — the caller decides what ` +
          `to report. stderr was ${JSON.stringify(result.stderr)}`
      );
    }
  );
});


/* ========================================================================= *
 * Leaving the host as it was found
 *
 * The invariant this file closes on: no child it spawned is still tracked, and
 * port 3000 is bindable again. An orphan would hold the port and fail whatever
 * runs next on this host.
 * ========================================================================= */

test(
  'no instance is left holding port 3000 once every group has finished',
  { timeout: CASE_TIMEOUT_MS },
  async () => {
    assert.strictEqual(
      spawnedServices.size,
      0,
      `every spawned service must have been reaped by its own group; ` +
        `${spawnedServices.size} handle(s) remain`
    );

    const result = await awaitPortRelease();
    assert.strictEqual(
      result.available,
      true,
      `port ${PORT} is still held (${result.code}) after every instance was ` +
        `stopped, which means this suite leaked a process`
    );
  }
);
