'use strict';

/**
 * test/lifecycle.test.js — the PROCESS-level suite for Student_Simple_06Sept26.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The other two suites reason about the service from the inside: one drives
 * the store and the workbook reader directly, the other creates a server on an
 * ephemeral port inside the test process. Neither can see what a process does.
 * This file spawns `node server.js` exactly as an operator runs it — same
 * runtime, same entry point, the literal port 3000 — and asserts the four
 * things only a real process can demonstrate:
 *
 *   1. It starts, binds, and says so exactly once.
 *   2. The pre-feature response is still there, byte for byte.
 *   3. The `/activities` namespace boundary falls exactly where it was drawn,
 *      so every path outside it behaves as it always did.
 *   4. It fails the way it is documented to fail — a refused bind exits
 *      non-zero naming the code, and a refused store write answers 500 and
 *      keeps serving.
 *
 * WHY IT IS SERIAL-ONLY
 * ---------------------
 * `port = 3000` is a bare literal in `server.js` with no environment override,
 * and the feature deliberately did not externalize it. Port 3000 cannot be
 * partitioned, so this file must be the only thing binding it while it runs.
 * The runner uses a separate process per test file, which is why the project's
 * test script is `node --test --test-concurrency=1` with NO positional
 * argument — a bare `test/` directory argument makes Node treat the directory
 * as a module to load, which fails and runs no tests at all.
 *
 * THREE DISCIPLINES THIS FILE HOLDS ITSELF TO
 * -------------------------------------------
 *   - NO ORPHANS. Every child is tracked, killed, and awaited, and the port is
 *     polled until it is actually released before the next child binds it. An
 *     orphan would hold port 3000 and make every later case fail for a reason
 *     that has nothing to do with the code under test.
 *   - NOTHING IS WRITTEN INTO THE CHECKOUT. Every child is given
 *     `ACTIVITY_STORE` pointing inside a `mkdtemp` directory that is removed
 *     afterwards. Without it a child would materialise `activities.json` in the
 *     repository root, because that is the store's documented default.
 *   - NO RELIANCE ON `--test-force-exit`. This file spawns children rather than
 *     importing the service, so it holds no listener; every request is made
 *     with `agent: false` and `Connection: close` so no keep-alive socket
 *     outlives its response. If the runner ever hangs on this file, that is a
 *     defect in this file.
 *
 * GOVERNING RULE: `Ajit_AddNewFeature_Rule`
 * -----------------------------------------
 * Summarized, never reproduced. Its TESTING REQUIREMENTS area is the sole
 * reason this file exists — the request that produced the feature never asked
 * for tests — so every case here is executable evidence that can genuinely
 * fail: there is no `todo`, and the only conditional skip is the one case whose
 * precondition is about the HOST rather than about the code.
 *
 * Its SYSTEM BOUNDARIES area is why the boundary cases below are nine
 * separately named tests rather than one loop over a table: a loop stops at its
 * first failure and hides the rest, and these are precisely the cases a
 * careless route predicate breaks.
 *
 * Its MINIMAL CHANGE AND DISCIPLINE area is why the only imports are Node
 * built-ins — no test framework, no assertion library, no HTTP client, no
 * process helper — and why `test/` holds exactly three files with no shared
 * helper module between them. It is also why the assertions below describe the
 * response AS IT SHIPS rather than as it might be improved: the `Content-Type`
 * is asserted to be exactly `text/plain`, with no charset parameter, because
 * that absence is preserved behaviour and this suite exists to notice if
 * someone "corrects" it.
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

/** The bind, unchanged by the feature and deliberately loopback-only. */
const HOST = '127.0.0.1';
const PORT = 3000;

/* ========================================================================= *
 * Gold values — measured against the working tree, written as literals
 *
 * These are copied from the specification's verified measurements and
 * re-measured against this checkout. They are literals rather than values
 * derived at run time from the service's own output, because a value the
 * service computes cannot be evidence about the service.
 * ========================================================================= */

/** The preserved response body: 34 bytes, trailing newline included. */
const GOLD_BODY = 'Hello, World Welcome to Sharebot!\n';
const GOLD_BODY_BYTES = 34;
const GOLD_BODY_SHA256 = '6bdf54b2103060907f4da9765e353673aa0c0d28afaad83bfe42f139963bbb10';

/**
 * The preserved `Content-Type`, asserted as an EXACT string. `text/plain` with
 * no `charset` parameter is what the pre-feature service sent and what it still
 * sends; a `startsWith` check here would silently accept
 * `text/plain; charset=utf-8`, which is a different response.
 */
const GOLD_CONTENT_TYPE = 'text/plain';
const GOLD_STATUS = 200;

/** The service's one and only log line, emitted once from the listen callback. */
const READINESS_LINE = 'Server running at http://127.0.0.1:3000/';

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
/** 100 polls x 50 ms = a 5-second deadline for the port to be released. */
const PORT_RELEASE_POLL_ATTEMPTS = 100;
/**
 * Up to 64 agents may validate on this host at once and port 3000 cannot be
 * partitioned, so acquiring it is take-turns. This is the bounded window this
 * file will wait for a turn, with a growing backoff, before it reports the port
 * as unavailable and names the code it saw.
 */
const PORT_ACQUIRE_ATTEMPTS = 60;
const PORT_ACQUIRE_BASE_DELAY_MS = 100;
const PORT_ACQUIRE_MAX_DELAY_MS = 1000;
/** How long a child is given to exit after being killed, or after a failed bind. */
const EXIT_DEADLINE_MS = 10000;
/**
 * How long a bare TCP connection attempt is given to settle.
 *
 * Generous on purpose: a refusal from a loopback address arrives in under a
 * millisecond, but a refusal from one of this host's routable adapter
 * addresses was measured at around two seconds — the stack retries the SYN
 * before the reset arrives. A tighter bound would turn that latency into a
 * timeout and report the wrong observation.
 */
const CONNECT_DEADLINE_MS = 5000;
/**
 * A short settling period used where the assertion is about something NOT
 * happening — an extra log line, a second readiness line. Without it the
 * assertion would pass simply because the output had not arrived yet.
 */
const QUIET_PERIOD_MS = 300;
/**
 * A generous per-case ceiling. It exists so a defect surfaces as a failed case
 * with a message rather than as a suite that never finishes; no healthy case
 * comes anywhere near it.
 */
const CASE_TIMEOUT_MS = 60000;

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
 * Splits captured output into lines.
 *
 * `console.log` emits `\n` on every platform Node supports, but this checkout
 * is developed on Windows with `core.autocrlf=true`, so the `\r?` is defensive
 * rather than decorative: a stray carriage return must not turn one line into
 * two and fail an assertion that is really about how many times the service
 * logged. The trailing empty element left by the final newline is dropped.
 *
 * @param {string} output Accumulated stdout or stderr.
 * @returns {Array<string>} The non-empty lines, in order.
 */
function outputLines(output) {
  return output.split(/\r?\n/).filter((line) => line.length > 0);
}

/**
 * Races a promise against a deadline, and CLEARS THE LOSING TIMER.
 *
 * The obvious spelling of this — `Promise.race([work, sleep(ms)])` — is a
 * defect, and it was measured as one while this file was being written: the
 * race settles as soon as the work finishes, but the sleep's timer stays
 * pending and keeps the event loop alive for its full duration. With a
 * ten-second deadline that turned a suite whose assertions took under a second
 * into a runner that sat there for eleven, which is indistinguishable from a
 * hang and is the very thing this file must not do. Clearing the timer in
 * `finally` is what keeps this file honest about not needing
 * `--test-force-exit`.
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
 * The port: probing, and waiting for a turn
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
 * Waits, bounded, for the port to become bindable.
 *
 * Used in two places: before a child is spawned, because a sibling clone may
 * hold the port for a moment, and after a child is killed, because the socket
 * is not necessarily released the instant the process exits. Polling a real
 * bind attempt is the only honest test of "released" — a fixed sleep either
 * wastes time or is too short, and it never actually checks.
 *
 * @param {number} attempts How many bind attempts to make.
 * @param {boolean} backoff Whether to grow the delay between attempts.
 * @returns {Promise<{available: boolean, code: string|null}>} The final probe
 *   result, so a caller can name the code in its failure message.
 */
async function awaitPortAvailable(attempts, backoff) {
  let result = { available: false, code: null };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await probePort();
    if (result.available) {
      return result;
    }
    const delay = backoff
      ? Math.min(PORT_ACQUIRE_BASE_DELAY_MS * (attempt + 1), PORT_ACQUIRE_MAX_DELAY_MS)
      : POLL_INTERVAL_MS;
    await sleep(delay);
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
 *   `stderr`, and a promise that resolves with its exit disposition.
 */
function spawnService(storePath) {
  const child = spawn(process.execPath, [SERVER_ENTRY_POINT], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ACTIVITY_STORE: storePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const handle = {
    child,
    storePath,
    stdout: '',
    stderr: '',
    exit: null,
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    handle.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    handle.stderr += chunk;
  });

  // Captured as a promise the instant the child exists, so a case that waits
  // for the exit cannot miss an event that fired before it started listening.
  handle.exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      handle.exit = { code, signal };
      resolve(handle.exit);
    });
  });

  // `spawn` reports a failure to start the executable asynchronously. Without
  // a listener that arrives as an unhandled `'error'` event and takes the
  // runner down; recorded into `stderr` it becomes part of the diagnosis the
  // readiness gate prints.
  child.once('error', (error) => {
    handle.stderr += `spawn failed: ${error.message}\n`;
  });

  spawnedServices.add(handle);
  return handle;
}

/**
 * Renders everything known about a child, for a failure message.
 *
 * A service that will not start has to produce its log, not a bare timeout.
 * This is what makes the difference between "readiness deadline exceeded" and
 * a message a reader can act on without reproducing the run.
 *
 * @param {object} handle A handle from `spawnService`.
 * @returns {string} A multi-line diagnostic.
 */
function describeService(handle) {
  return [
    `store path: ${handle.storePath}`,
    `exitCode: ${handle.child.exitCode}`,
    `signal: ${handle.child.signalCode}`,
    `stdout: ${JSON.stringify(handle.stdout)}`,
    `stderr: ${JSON.stringify(handle.stderr)}`,
  ].join('\n');
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
 * Waits for a turn at port 3000, spawns the service, and gates on readiness.
 *
 * The retry exists for one reason and refuses to cover any other: a sibling
 * clone on this host may take port 3000 between the probe and the child's
 * bind, which is a scheduling collision rather than a defect. So a child that
 * died naming `EADDRINUSE` is retried, and a child that died for ANY other
 * reason is reported immediately with its output — because retrying a genuine
 * failure would turn one clear diagnosis into several confusing ones.
 *
 * @param {string} storePath The value for `ACTIVITY_STORE`.
 * @returns {Promise<object>} A ready service handle.
 * @throws {Error} When the port cannot be acquired, or the service will not
 *   start for a reason other than contention.
 */
async function startService(storePath) {
  const acquisition = await awaitPortAvailable(PORT_ACQUIRE_ATTEMPTS, true);
  if (!acquisition.available) {
    throw new Error(
      `port ${PORT} unavailable (${acquisition.code}) after ` +
        `${PORT_ACQUIRE_ATTEMPTS} attempts: this is an ENVIRONMENT problem, not a ` +
        `code defect. Something else on this host is holding ${HOST}:${PORT}; ` +
        `release it and re-run. ${path.basename(__filename)} needs the port exclusively ` +
        `because server.js binds it as a literal with no override.`
    );
  }

  let lastFailure = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = spawnService(storePath);
    try {
      await awaitReadiness(handle);
      return handle;
    } catch (error) {
      lastFailure = error;
      await stopService(handle);
      const contended = handle.stderr.includes('EADDRINUSE');
      if (!contended) {
        throw error;
      }
      // Contention only: give the holder a moment and take another turn.
      await awaitPortAvailable(PORT_ACQUIRE_ATTEMPTS, true);
    }
  }

  throw lastFailure;
}

/**
 * Kills a child and awaits its exit, escalating if it ignores the first
 * signal.
 *
 * Killing without awaiting leaves a race in which the next child binds before
 * this one has gone, and the `SIGKILL` escalation covers a child that will not
 * leave on request — so a hung service cannot hang the suite. The wait is
 * bounded through `awaitWithDeadline`, which clears its own timer.
 *
 * Safe to call more than once, and safe on a child that has already exited,
 * which is what lets the final cleanup sweep every handle unconditionally.
 *
 * @param {object} handle A handle from `spawnService`.
 * @returns {Promise<void>} Resolves once the child is gone.
 */
async function killService(handle) {
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill();

    const exited = await awaitWithDeadline(handle.exited, EXIT_DEADLINE_MS);

    if (!exited) {
      handle.child.kill('SIGKILL');
      await handle.exited;
    }
  }

  spawnedServices.delete(handle);
}

/**
 * Kills a child and then waits for port 3000 to be bindable again.
 *
 * The port poll is a separate step from the kill because the two are separate
 * facts: a process can be gone while its socket is not yet reusable, and the
 * next child would then fail to bind for a reason that has nothing to do with
 * it. For a child that never held the port — the refused second instance
 * below — use `killService` instead, or this would wait out the whole release
 * deadline against the instance that legitimately holds it.
 *
 * @param {object} handle A handle from `spawnService`.
 * @returns {Promise<void>} Resolves once the child is gone and the port is
 *   free.
 */
async function stopService(handle) {
  await killService(handle);
  await awaitPortAvailable(PORT_RELEASE_POLL_ATTEMPTS, false);
}

/* ========================================================================= *
 * Talking to the service
 * ========================================================================= */

/**
 * Issues one HTTP request and reads the whole response.
 *
 * `agent: false` with an explicit `Connection: close` is deliberate. Node's
 * global agent keeps connections alive, and a keep-alive socket outliving its
 * response is exactly the kind of lingering handle that makes a test runner sit
 * there after its last assertion and look like a hang. One socket per request,
 * closed by the server when it answers.
 *
 * The body is returned as RAW BYTES. The gold value is a byte count and a
 * hash, so decoding first would let an encoding change slip through
 * unnoticed — the one thing a byte-for-byte assertion exists to catch.
 *
 * @param {{method?: string, path: string, headers?: object, host?: string}} options
 *   The request line and headers. `host` defaults to loopback.
 * @param {string|undefined} body An optional request body.
 * @returns {Promise<{status: number, headers: object, raw: Buffer, text: string}>}
 *   The complete response.
 */
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: options.host ?? HOST,
        port: PORT,
        method: options.method ?? 'GET',
        path: options.path,
        agent: false,
        headers: { Connection: 'close', ...(options.headers ?? {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            raw,
            text: raw.toString('utf8'),
          });
        });
      }
    );

    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Asserts that a response is the preserved pre-feature response, exactly.
 *
 * Shared by the many paths that must still receive it, which is not the same
 * thing as collapsing those paths into one case: each path is still its own
 * named test that fails on its own, and this only spares the file nine copies
 * of the same four assertions. All four are asserted every time — status,
 * exact `Content-Type`, byte length, and hash — because each catches a
 * different kind of drift.
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
 * This is the mechanism chosen to make a write fail, and the choice is
 * deliberate: `fs.chmod` cannot make a directory unwritable on Windows, where
 * it only toggles the read-only flag on files, so a permission-based approach
 * would silently do nothing and the case would pass for the wrong reason. A
 * missing parent fails both the staging write and the rename, on every
 * platform, with `ENOENT`.
 *
 * @param {string} name A short name distinguishing one child's store.
 * @returns {string} An absolute path whose parent is absent.
 */
function unwritableStorePath(name) {
  return path.join(temporaryRoot, name, 'absent-directory', 'activities.json');
}

before(
  async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-test-'));

    // THE PRE-FLIGHT PROBE. It runs before anything binds, and its failure is
    // phrased as an environment problem because that is what it is: every case
    // in this file needs port 3000, and a held port would otherwise surface as
    // an opaque assertion failure somewhere further down, sending a reader to
    // look for a defect in code that is working.
    const acquisition = await awaitPortAvailable(PORT_ACQUIRE_ATTEMPTS, true);
    assert.strictEqual(
      acquisition.available,
      true,
      `port ${PORT} unavailable (${acquisition.code}) — this is an ENVIRONMENT ` +
        `problem, not a code defect. Something else on this host is holding ` +
        `${HOST}:${PORT}. server.js binds that port as a literal with no override, ` +
        `so this suite needs it exclusively; release the holder and re-run. Run ` +
        `the suite as "node --test --test-concurrency=1" so no sibling test file ` +
        `can contend for it.`
    );
  },
  { timeout: CASE_TIMEOUT_MS }
);

after(
  async () => {
    // Unconditional sweep. Every handle is stopped even if a case already
    // stopped it, because `stopService` is safe to repeat and an orphan
    // holding port 3000 would poison whatever runs next on this host.
    for (const handle of [...spawnedServices]) {
      await stopService(handle);
    }

    if (temporaryRoot !== null) {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = null;
    }
  },
  { timeout: CASE_TIMEOUT_MS }
);

/* ========================================================================= *
 * PHASE 1 — the node:net pre-flight probe
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
      const result = await awaitPortAvailable(PORT_ACQUIRE_ATTEMPTS, true);

      assert.strictEqual(
        result.available,
        true,
        `port ${PORT} unavailable (${result.code}) — an environment problem: ` +
          `something else on this host holds ${HOST}:${PORT}`
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

      const afterRelease = await awaitPortAvailable(PORT_RELEASE_POLL_ATTEMPTS, false);
      assert.strictEqual(
        afterRelease.available,
        true,
        'the port must be bindable again once the holder has closed'
      );
    }
  );
});

/* ========================================================================= *
 * PHASE 2 — startup and the readiness contract
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
      // Three requests across both halves of the boundary: the preserved
      // fall-through, the claimed collection, and a claimed item. A service
      // that logged per request — or re-logged readiness — would be caught here
      // and nowhere else.
      await request({ path: '/' });
      await request({ path: '/activities' });
      await request({ path: `/activities/${SEEDED_STUDENT_ID}` });
      await sleep(QUIET_PERIOD_MS);

      assert.strictEqual(
        countReadinessLines(service.stdout),
        1,
        `the readiness line must appear exactly once across the whole run\n${describeService(service)}`
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
});


/* ========================================================================= *
 * PHASES 3, 4 and 7 — the preserved response, the namespace boundary, and
 * loopback-only reachability
 *
 * One running instance serves all three groups: none of them writes anything
 * that another could observe, so sharing a child costs nothing and spares the
 * run a spawn and a port hand-off per group. The child's store lives in the
 * temporary root, so the read cases answer from the workbook seed and the
 * checkout is untouched.
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
   * PHASE 3 — the preserved response, byte for byte
   *
   * This is the regression evidence for the promise that the feature narrowed
   * the previously universal response rather than replacing it. Each path is
   * its own case, so a predicate that captured one of them reports exactly
   * which one.
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
        // The feature added no roster route. A path that merely looks like one
        // must not answer with anything about a student, so this also asserts
        // the absence of the seeded label rather than only the hash.
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
   * PHASE 4 — the namespace boundary, one named case per path
   *
   * This is the group that catches a loose route predicate, and it is written
   * as nine separate cases rather than one loop over a table on purpose: a
   * loop reports its first failure and hides every case after it, and the
   * whole value here is knowing exactly WHICH path moved.
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
        // Measured identical to `/` before the feature, and this is the single
        // assertion that catches a `startsWith('/activities')` predicate.
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
   * PHASE 7 — loopback-only reachability
   *
   * The bind is `127.0.0.1` and the feature deliberately left it alone.
   * Widening it would expose a write endpoint that has no authentication, no
   * authorization and no session mechanism of any kind — a submission is
   * attributed to whatever Student ID the submitter types, and the feature
   * checks only that the ID names a real student, never that the submitter is
   * that student. Loopback is therefore not a default that happens to be in
   * place; it is the containment this feature relies on.
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
      'the service is NOT reachable on a non-loopback address of this host',
      { timeout: CASE_TIMEOUT_MS },
      async (t) => {
        // Resolved at run time rather than hard-coded, because the addresses a
        // host holds are its own business. This is the ONE conditional skip in
        // this file, and it is appropriate precisely because its condition is
        // about the host rather than about the code: on a host with no routable
        // IPv4 address there is nothing to refuse from, and asserting anyway
        // would make the suite fragile for a reason unrelated to the service.
        const addresses = [];
        for (const interfaces of Object.values(os.networkInterfaces())) {
          for (const entry of interfaces ?? []) {
            if (entry.family === 'IPv4' && !entry.internal) {
              addresses.push(entry.address);
            }
          }
        }

        if (addresses.length === 0) {
          t.skip(
            'this host has no non-loopback IPv4 address, so there is no address ' +
              'from which to observe the refusal'
          );
          return;
        }

        // ONE address is sufficient and is all this case spends time on. The
        // failure being guarded against is a widened bind, and a bind widened
        // to every interface would answer on all of these addresses, so the
        // first one detects it. Probing all of them was measured at roughly two
        // seconds each on this host — six seconds of refusal latency for
        // evidence the first address already gives, on a port that other work
        // on this host is waiting to take a turn at.
        const address = addresses[0];
        const outcome = await probeConnect(address, CONNECT_DEADLINE_MS);

        // `connected` is the only failing outcome. A refusal and a dropped SYN
        // are reported separately by `probeConnect` and both are acceptable
        // evidence here — the service is not answering on that address either
        // way — but they are not conflated, so the message says which was
        // observed.
        assert.notStrictEqual(
          outcome,
          'connected',
          `the listener is bound to ${HOST} only, so ${address}:${PORT} must not ` +
            `accept a connection (observed: ${outcome}); widening the bind would ` +
            `expose an unauthenticated write endpoint`
        );

        // And the same instance is still answering on loopback, which is what
        // makes the refusal above evidence about the BIND rather than about a
        // service that had simply stopped.
        assertPreservedResponse(
          await request({ path: '/', host: HOST }),
          `GET / over ${HOST}:${PORT} after the non-loopback probe`
        );
      }
    );
  });
});

/* ===== end of the running-instance group ===== */


/* ========================================================================= *
 * PHASE 5 — the EADDRINUSE disposition
 *
 * Before this feature, a refused bind terminated the process on an unhandled
 * `'error'` event and a raw stack trace, which reads as a crash rather than as
 * "the port is held". The feature added a listener that logs the code and
 * exits non-zero, and that difference is what lets a pre-flight check — this
 * file's, or an operator's — report an environment problem instead of leaving
 * a stack trace for a reader to interpret.
 *
 * The second instance is spawned with `spawnService` rather than
 * `startService`, deliberately: `startService` waits for a free port and
 * retries on contention, which are exactly the behaviours that would defeat
 * this case. Here the collision IS the subject.
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
    'a second instance exits non-zero and names EADDRINUSE instead of crashing',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      refusedInstance = spawnService(writableStorePath('addrinuse-refused'));

      const exited = await awaitWithDeadline(refusedInstance.exited, EXIT_DEADLINE_MS);

      // Bounded, and the `after` hook kills it regardless, so a service that
      // wrongly kept running cannot hang the suite — it fails this assertion
      // and is reaped.
      assert.strictEqual(
        exited,
        true,
        `the second instance must exit rather than keep running with a refused ` +
          `bind\n${describeService(refusedInstance)}`
      );
      assert.strictEqual(
        typeof refusedInstance.exit.code,
        'number',
        `the second instance must exit of its own accord with a status code, not ` +
          `be terminated by a signal\n${describeService(refusedInstance)}`
      );
      assert.strictEqual(
        refusedInstance.exit.signal,
        null,
        'no signal was sent to it — it left on its own'
      );
      assert.notStrictEqual(
        refusedInstance.exit.code,
        0,
        `a refused bind must be a non-zero exit\n${describeService(refusedInstance)}`
      );

      const output = `${refusedInstance.stdout}${refusedInstance.stderr}`;
      assert.strictEqual(
        output.includes('EADDRINUSE'),
        true,
        `the refused instance must name the error code in its output so the ` +
          `cause is legible\n${describeService(refusedInstance)}`
      );
      assert.strictEqual(
        countReadinessLines(refusedInstance.stdout),
        0,
        'an instance that never bound must not claim readiness'
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
 * created, so the staging write and the rename both fail with `ENOENT`. This
 * is chosen over `fs.chmod` because `chmod` cannot make a directory unwritable
 * on Windows — it only toggles the read-only flag on files — and a
 * permission-based attempt would quietly do nothing, leaving these cases
 * passing for the wrong reason. A missing parent fails on every platform.
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
 * Leaving the host as it was found
 *
 * Declared last so it runs after every group has torn its instance down. An
 * orphan holding port 3000 is the single most expensive thing this file could
 * leave behind on a host where other work needs the same port, so the
 * condition is asserted rather than assumed — the suite-wide `after` hook
 * sweeps, and this case is the evidence that the sweep was not needed.
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

    const result = await awaitPortAvailable(PORT_RELEASE_POLL_ATTEMPTS, false);
    assert.strictEqual(
      result.available,
      true,
      `port ${PORT} is still held (${result.code}) after every instance was ` +
        `stopped, which means this suite leaked a process`
    );
  }
);

