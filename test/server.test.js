'use strict';

/**
 * test/server.test.js - eight tests against the entrypoint that actually ships.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * This is the ONLY file in the suite that spawns `node server.js` or binds the
 * default port `127.0.0.1:3000`. Everything else is exercised in-process on an
 * ephemeral port with injected dependencies, which is fast and hermetic but
 * proves nothing about the artifact an operator runs. Two things are only
 * observable here:
 *
 *   1. **The scanned baseline survived.** Before this feature, `server.js`
 *      answered every request with `200`, `Content-Type: text/plain` and the
 *      34-byte body `Hello, World Welcome to Sharebot!\n`, and logged
 *      `Server running at http://127.0.0.1:3000/`. Tests 34 and 35 pin the
 *      banner and those bytes under the real process. The greeting's
 *      "Sharebot" wording disagrees with the project name and is preserved
 *      DELIBERATELY - assert it verbatim, never "fix" it.
 *   2. **The whole stack is wired together.** Test 36 is the only assertion
 *      that runs the entrypoint, the dispatcher, `lib/activityRoutes.js`,
 *      `lib/activityRepository.js`, `lib/studentDirectory.js`,
 *      `lib/workbook.js` and the committed workbooks in one process with
 *      nothing injected.
 *
 * Tests 38 and 39 are deliberately two tests, because the CLI wrapper and the
 * library entry point have different contracts: the `require.main === module`
 * wrapper writes one stderr line and sets a non-zero exit code, while `start()`
 * rejects and leaves its caller alive. Asserting only one would leave the other
 * free to regress.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *   - **It writes nothing.** No `POST` is issued anywhere in this file, so the
 *     committed `activities.json` and the workbooks are read-only throughout
 *     and `git status --porcelain` is identical before and after a run. The one
 *     directory it creates (test 41) is an empty `fs.mkdtempSync` directory
 *     under the system temp root, removed in the same test's `finally`.
 *   - **It declares EXACTLY EIGHT top-level tests**, with no subtest, no
 *     `describe` and no `it`. Root `verify-tests.js` gates on
 *     `test:summary.counts.passed >= MIN_TESTS` with `MIN_TESTS` 45 = 33 + 8 +
 *     4, and `README.md` documents `MIN_TESTS=46 npm test` exiting 1 as the
 *     proof that the guard is live. Subtests and `it`s count toward `passed`,
 *     so one extra here would inflate the total and void that proof. Tests 40
 *     and 41 therefore carry their several cases in tables inside one body,
 *     naming the case in every assertion message.
 *   - **It keeps no assertion in a hook.** Assertions made inside
 *     `before`/`after` do not count toward `counts.passed`. The single `after`
 *     here is a cleanup safety net and asserts nothing.
 *   - **It never modifies `server.js`.** Where the module as built differs from
 *     what the plan predicted, the test adapts and says so in a comment - see
 *     test 39 on the internal `'listening'` listener.
 *
 * PORT EXCLUSIVITY
 * ---------------------------------------------------------------------------
 * `127.0.0.1:3000` is a single shared resource. Top-level tests in a file run
 * serially and the suite runs at `--test-concurrency=1`, so only one holder can
 * exist at a time - but only if every test fully releases it. Hence the rule
 * every test below follows: `stop()` (SIGTERM, then AWAIT `'close'`) in a
 * `finally`, and a `holdPort` release in a `finally`. A second bind would fail
 * `EADDRINUSE` and surface as *cancelled* tests whose message names neither the
 * port nor the conflict.
 *
 * Every value asserted here was verified against this checkout on Node
 * v24.21.0 before being written down.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// The library entry points under test. Requiring the entrypoint is safe and
// binds nothing: `listen` sits behind `require.main === module`, which is the
// lifecycle reversal that makes this file's in-process assertions possible.
const { resolveConfig, createServer, start } = require('../server');

/* ---------------------------------------------------------------------------
 * The baseline contract, written as literals.
 *
 * These are pinned values, not derived ones. Deriving the byte length from the
 * greeting, or the banner from the host and port, would make the assertion
 * agree with whatever the code does - which is the opposite of what a
 * backward-compatibility test is for.
 * ------------------------------------------------------------------------- */

/** The entrypoint this file spawns and requires. */
const ENTRY = path.join(__dirname, '..', 'server.js');

/** The checkout root - where `server.js`, the workbooks and the registry sit. */
const REPO_ROOT = path.dirname(ENTRY);

/** The loopback default from baseline line 3. */
const HOST = '127.0.0.1';

/** The default port from baseline line 4, and this file's exclusive resource. */
const DEFAULT_PORT = 3000;

/** Baseline line 9, byte for byte. The trailing newline is part of it. */
const GREETING = 'Hello, World Welcome to Sharebot!\n';

/** The greeting's length in bytes, pinned as a literal rather than computed. */
const GREETING_BYTE_LENGTH = 34;

/** The greeting as bytes, for the byte-identical comparison in test 35. */
const GREETING_BYTES = Buffer.from(GREETING, 'utf8');

/** Baseline lines 12-14: the startup banner, and this file's readiness signal. */
const BANNER = 'Server running at http://127.0.0.1:3000/';

/** The greeting's media type, from baseline line 8. */
const TEXT_MEDIA_TYPE = 'text/plain';

/** The media type of every JSON route. */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * The committed answer for `S001`: one workbook-sourced activity, because
 * `activities.json` ships empty. Read out of the workbooks
 * (`Student Details!A2,B2` and `Other Info!A2,C2`) and confirmed over HTTP.
 */
const S001_PATH = '/api/students/S001/activities';
const S001_PAYLOAD = {
  studentId: 'S001',
  name: 'Aarav Sharma',
  count: 1,
  activities: [{ activity: 'Robotics Club', source: 'workbook' }]
};

/* ---------------------------------------------------------------------------
 * Deadlines. Every wait in this file is bounded, so a failure is a readable
 * assertion rather than a suite that hangs until the runner is killed.
 * ------------------------------------------------------------------------- */

/** How long the entrypoint has to print its banner. */
const READY_TIMEOUT_MS = 5000;

/** How long a child has to exit, and to finish draining its streams. */
const CHILD_EXIT_TIMEOUT_MS = 5000;

/** How long a request has to produce a complete response. */
const REQUEST_TIMEOUT_MS = 5000;

/** How long a connection probe waits before reporting it never settled. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * The environment variables the feature reads. They are stripped from every
 * child's environment and then re-applied per test, so no value can leak in
 * from the shell that launched the suite or out of one test into the next.
 */
const FEATURE_ENV_KEYS = ['PORT', 'HOST', 'ACTIVITIES_DATA_PATH', 'WORKBOOK_DIR'];

/**
 * Pinned options for every in-process `createServer`/`start` call.
 *
 * `resolveConfig` falls back to `process.env` for any option a caller omits, so
 * an ambient `WORKBOOK_DIR` or `HOST` could otherwise turn a bind-failure test
 * into a load-failure test and make the suite's verdict depend on the shell.
 * Pinning the three non-port values keeps each test's failure the one it is
 * about; `port` is always supplied explicitly by the test itself.
 */
const LIBRARY_OPTIONS = Object.freeze({
  host: HOST,
  workbookDir: REPO_ROOT,
  activitiesDataPath: path.join(REPO_ROOT, 'activities.json')
});

/**
 * `fs.mkdtempSync` prefix for test 41's foreign working directory.
 *
 * Deliberately NOT the `student-activities-` prefix `test/activities.test.js`
 * uses and `test/workbooks.test.js` scans for: this file's temp directory is
 * its own to create and remove, and sharing the prefix would couple two files
 * that have no other relationship.
 */
const FOREIGN_CWD_PREFIX = 'server-entrypoint-cwd-';

/* ---------------------------------------------------------------------------
 * The inline harness.
 *
 * All of it lives here rather than in a helper module because every `.js` file
 * inside a directory named `test/` is executed as a test by default discovery -
 * verified: a plain `test/helper.js` ran and was counted as a passing test,
 * which would inflate the count `verify-tests.js` gates on. Nothing in this
 * section asserts anything; assertions belong to the eight test bodies.
 * ------------------------------------------------------------------------- */

/** Children still running, so the safety-net `after` can reap a leak. */
const liveChildren = new Set();

/** Port holders still listening, so the same hook can release a leak. */
const liveHolders = new Set();

/**
 * A copy of this process's environment with every feature variable removed.
 *
 * @returns {Record<string, string>} The sanitized environment.
 */
const baseEnv = () => {
  const env = { ...process.env };
  for (const key of FEATURE_ENV_KEYS) {
    delete env[key];
  }
  return env;
};

/**
 * Spawns `node server.js` and starts accumulating its output immediately, so
 * nothing printed before the first `await` is missed.
 *
 * @param {{env?: Record<string, string>, cwd?: string}} [options] `env` is
 *   merged over the sanitized base environment; `cwd` defaults to this
 *   process's working directory.
 * @returns {{
 *   child: import('child_process').ChildProcess,
 *   stdout: string,
 *   stderr: string,
 *   closed: boolean,
 *   exited: boolean,
 *   code: number|null,
 *   signal: string|null,
 *   spawnError: Error|null
 * }} A handle carrying the child and everything observed about it.
 */
const spawnEntry = ({ env = {}, cwd } = {}) => {
  const child = spawn(process.execPath, [ENTRY], {
    cwd,
    env: { ...baseEnv(), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const handle = {
    child,
    stdout: '',
    stderr: '',
    closed: false,
    exited: false,
    code: null,
    signal: null,
    spawnError: null
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    handle.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    handle.stderr += chunk;
  });

  // Recorded rather than rethrown: an unhandled `'error'` event would abort the
  // whole test process, and the tests want the failure as an assertion.
  child.once('error', (error) => {
    handle.spawnError = error;
  });
  child.once('exit', () => {
    handle.exited = true;
  });
  child.once('close', (code, signal) => {
    handle.closed = true;
    handle.exited = true;
    handle.code = code;
    handle.signal = signal;
  });

  liveChildren.add(handle);
  return handle;
};

/**
 * Renders everything known about a child, so any rejection in this file reads
 * as a diagnosis. A child that died on `EADDRINUSE` must report a port
 * conflict, not a promise that never settled.
 *
 * @param {ReturnType<typeof spawnEntry>} handle The child's handle.
 * @returns {string} A two-line stdout/stderr dump.
 */
const describeChild = (handle) =>
  `\n  stdout: ${JSON.stringify(handle.stdout)}\n  stderr: ${JSON.stringify(handle.stderr)}`;

/**
 * Waits for the entrypoint's readiness signal: the FIRST COMPLETE LINE of its
 * stdout.
 *
 * Readiness is a line, never a chunk. Node gives no guarantee that a `'data'`
 * event aligns with a line boundary, so the accumulated buffer is only examined
 * once a newline has actually arrived - matching a partial chunk is the classic
 * flake in this pattern. A first line that is present but wrong rejects at once
 * rather than waiting out the deadline, because no later output can make it
 * right.
 *
 * Settles on whichever comes first: the banner line, a spawn `'error'`
 * (immediately - there are no streams to wait for), the child's `'close'` after
 * a premature exit (`'exit'` alone can fire while stdout and stderr are still
 * draining, which would truncate the diagnostic), or the deadline.
 *
 * @param {ReturnType<typeof spawnEntry>} handle The child's handle.
 * @returns {Promise<string>} The banner line exactly as printed.
 */
const waitForBanner = (handle) => new Promise((resolve, reject) => {
  const { child } = handle;
  let settled = false;
  let timer = null;

  const cleanup = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    child.stdout.removeListener('data', onData);
    child.removeListener('error', onError);
    child.removeListener('close', onClose);
  };

  const fail = (summary) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(new Error(`${summary}${describeChild(handle)}`));
  };

  const succeed = (line) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(line);
  };

  const check = () => {
    if (settled) return;
    const newlineAt = handle.stdout.indexOf('\n');
    if (newlineAt === -1) return;
    const firstLine = handle.stdout.slice(0, newlineAt);
    if (firstLine === BANNER) {
      succeed(firstLine);
      return;
    }
    fail(
      `the entrypoint's first stdout line was ${JSON.stringify(firstLine)}, `
        + `expected ${JSON.stringify(BANNER)}`
    );
  };

  const onData = () => check();

  const onError = (error) =>
    fail(`the entrypoint could not be spawned: ${error.message}`);

  const onClose = () =>
    fail(
      'the entrypoint exited before printing its banner '
        + `(code ${handle.code}, signal ${handle.signal})`
    );

  const onTimeout = () => {
    if (handle.exited && !handle.closed) {
      fail(
        `the entrypoint exited but its streams had not finished draining `
          + `within ${READY_TIMEOUT_MS} ms`
      );
      return;
    }
    fail(`the entrypoint did not print its banner within ${READY_TIMEOUT_MS} ms`);
  };

  if (handle.spawnError !== null) {
    fail(`the entrypoint could not be spawned: ${handle.spawnError.message}`);
    return;
  }

  timer = setTimeout(onTimeout, READY_TIMEOUT_MS);
  child.stdout.on('data', onData);
  child.once('error', onError);
  child.once('close', onClose);

  // Output may already have arrived between `spawn` and this call.
  check();
});

/**
 * Waits for a child's `'close'` - the event that guarantees the process is gone
 * AND its streams are drained, which is why every port probe and every stderr
 * assertion in this file waits for it rather than for `'exit'`.
 *
 * @param {ReturnType<typeof spawnEntry>} handle The child's handle.
 * @param {number} timeoutMs How long to wait.
 * @returns {Promise<boolean>} `true` if it closed in time, `false` on timeout.
 */
const waitForClose = (handle, timeoutMs) => new Promise((resolve) => {
  if (handle.closed) {
    resolve(true);
    return;
  }

  const onClose = () => {
    clearTimeout(timer);
    resolve(true);
  };

  const timer = setTimeout(() => {
    handle.child.removeListener('close', onClose);
    resolve(false);
  }, timeoutMs);

  handle.child.once('close', onClose);
});

/**
 * Stops a child and does not return until it is gone and its socket with it.
 *
 * `SIGTERM` first, then `SIGKILL` if the child overruns. On Windows libuv maps
 * both onto `TerminateProcess`, so the child dies at once and reports
 * `code === null` with `signal === 'SIGTERM'`; nothing here asserts on that,
 * only that `'close'` arrived. Awaiting `'close'` is what makes test 37's
 * refusal assertion deterministic instead of a race with the kernel releasing
 * the listening socket.
 *
 * @param {ReturnType<typeof spawnEntry>} handle The child's handle.
 * @returns {Promise<void>} Resolves once the child has closed, or after the
 *   escalated kill has been given its own deadline.
 */
const stop = async (handle) => {
  liveChildren.delete(handle);
  if (handle.closed) return;

  handle.child.kill('SIGTERM');
  if (await waitForClose(handle, CHILD_EXIT_TIMEOUT_MS)) return;

  handle.child.kill('SIGKILL');
  await waitForClose(handle, CHILD_EXIT_TIMEOUT_MS);
};

/**
 * Issues one request and reads the whole response.
 *
 * The body is kept as a `Buffer` because test 35 compares bytes, not a decoded
 * string: a byte-for-byte guarantee cannot be asserted through a transcoding.
 *
 * @param {{method?: string, path: string, port?: number}} options The request.
 * @returns {Promise<{
 *   status: number,
 *   headers: Record<string, string|string[]|undefined>,
 *   body: Buffer,
 *   text: string
 * }>} The response.
 */
const httpRequest = ({ method = 'GET', path: requestPath, port = DEFAULT_PORT }) =>
  new Promise((resolve, reject) => {
    const request = http.request({ host: HOST, port, path: requestPath, method }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body,
          text: body.toString('utf8')
        });
      });
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(
        new Error(
          `no response to ${method} http://${HOST}:${port}${requestPath} `
            + `within ${REQUEST_TIMEOUT_MS} ms`
        )
      );
    });
    request.on('error', reject);
    request.end();
  });

/**
 * Occupies a port so a bind conflict can be provoked deliberately.
 *
 * An incoming connection is destroyed on arrival: a `net.Server` with no
 * connection handler keeps the socket open, and `close()` waits for open
 * connections, which would hang `release()`. After it is listening, a noop
 * `'error'` listener is attached so a late failure on a throwaway holder cannot
 * abort the test process.
 *
 * @param {number} port The port to occupy.
 * @returns {Promise<{release: () => Promise<void>}>} A holder whose `release`
 *   resolves once the port is free again.
 */
const holdPort = (port) => new Promise((resolve, reject) => {
  const holder = net.createServer();

  const onError = (error) => {
    holder.removeListener('listening', onListening);
    reject(new Error(`could not occupy ${HOST}:${port} for a conflict test: ${error.message}`));
  };

  const onListening = () => {
    holder.removeListener('error', onError);
    holder.on('error', () => {});
    const entry = {
      release: () => new Promise((resolved) => {
        liveHolders.delete(entry);
        holder.close(() => resolved());
      })
    };
    liveHolders.add(entry);
    resolve(entry);
  };

  holder.on('connection', (socket) => socket.destroy());
  holder.once('error', onError);
  holder.once('listening', onListening);
  holder.listen(port, HOST);
});

/**
 * Attempts one TCP connection and reports how it ended, so a test can assert
 * `ECONNREFUSED` rather than infer a closed port from a timeout.
 *
 * @param {number} port The port to probe.
 * @returns {Promise<string>} An error code, `'CONNECTED'`, or `'ETIMEDOUT'`.
 */
const probeConnection = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: HOST, port });

  const settle = (outcome) => {
    socket.removeAllListeners();
    socket.destroy();
    resolve(outcome);
  };

  socket.setTimeout(PROBE_TIMEOUT_MS, () => settle('ETIMEDOUT'));
  socket.once('error', (error) =>
    settle(typeof error.code === 'string' && error.code !== '' ? error.code : 'EUNKNOWN'));
  socket.once('connect', () => settle('CONNECTED'));
});

/**
 * Closes a server this file started in-process.
 *
 * @param {import('http').Server} server The listening server.
 * @returns {Promise<void>} Resolves once it has stopped listening.
 */
const closeServer = (server) => new Promise((resolve) => {
  server.close(() => resolve());
});

/**
 * Cleanup safety net, and nothing else: it asserts NOTHING, because assertions
 * made in a hook do not count toward `test:summary.counts.passed` and this file
 * promises exactly eight counted tests. Each test already stops its own child
 * and releases its own holder in a `finally`; this reaps whatever a thrown
 * assertion skipped, so a failure cannot leave port 3000 occupied for the next
 * file or the next run.
 */
after(async () => {
  for (const handle of [...liveChildren]) {
    await stop(handle);
  }
  for (const holder of [...liveHolders]) {
    await holder.release();
  }
});

/* ---------------------------------------------------------------------------
 * Tests 34-37 - the spawned entrypoint.
 * ------------------------------------------------------------------------- */

// Test 34 - the banner is both a preserved behaviour and this file's readiness
// signal, which is exactly why its format was kept verbatim rather than
// reformatted when `listen` moved behind the entry-point check.
test('the entrypoint prints the baseline startup banner as its first stdout line', async () => {
  const entry = spawnEntry();
  try {
    const line = await waitForBanner(entry);
    assert.equal(
      line,
      BANNER,
      `the readiness line must be ${JSON.stringify(BANNER)}, read ${JSON.stringify(line)}`
    );
    // Re-read from the accumulated buffer and take element 0, so output that
    // arrived later cannot mask a wrong first line.
    assert.equal(
      entry.stdout.split('\n')[0],
      BANNER,
      `the first accumulated stdout line must be ${JSON.stringify(BANNER)}, `
        + `read ${JSON.stringify(entry.stdout)}`
    );
    assert.equal(
      entry.stderr,
      '',
      `a healthy start must print nothing on stderr, read ${JSON.stringify(entry.stderr)}`
    );
  } finally {
    await stop(entry);
  }
});

// Test 35 - the backward-compatibility guarantee, and the only externally
// observable contract the repository made before this feature. Asserted on
// bytes rather than on a decoded string, because "34 bytes, byte for byte" is
// the promise. The "Sharebot" wording is preserved deliberately.
test('GET / still answers the byte-identical 34-byte baseline greeting', async () => {
  const entry = spawnEntry();
  try {
    await waitForBanner(entry);
    const response = await httpRequest({ path: '/' });

    assert.equal(response.status, 200, `GET / must answer 200, read ${response.status}`);
    assert.equal(
      response.headers['content-type'],
      TEXT_MEDIA_TYPE,
      `GET / must answer ${TEXT_MEDIA_TYPE}, read ${JSON.stringify(response.headers['content-type'])}`
    );
    assert.equal(
      response.headers['content-length'],
      String(GREETING_BYTE_LENGTH),
      `GET / must declare Content-Length ${GREETING_BYTE_LENGTH}, `
        + `read ${JSON.stringify(response.headers['content-length'])}`
    );
    assert.ok(
      response.body.equals(GREETING_BYTES),
      `GET / must answer the greeting byte for byte, read ${JSON.stringify(response.text)}`
    );
    assert.equal(
      response.body.length,
      GREETING_BYTE_LENGTH,
      `the greeting must be ${GREETING_BYTE_LENGTH} bytes, read ${response.body.length}`
    );
  } finally {
    await stop(entry);
  }
});

// Test 36 - the new functionality under the artifact that ships. This is the
// only assertion in the suite that proves the entrypoint, the dispatcher,
// `lib/activityRoutes.js`, `lib/activityRepository.js`,
// `lib/studentDirectory.js`, `lib/workbook.js` and the committed workbooks are
// wired together, with nothing injected and nothing stubbed.
test('the activity route answers from the committed workbooks under the real entrypoint', async () => {
  const entry = spawnEntry();
  try {
    await waitForBanner(entry);
    const response = await httpRequest({ path: S001_PATH });

    assert.equal(
      response.status,
      200,
      `GET ${S001_PATH} must answer 200, read ${response.status} with body ${JSON.stringify(response.text)}`
    );
    assert.equal(
      response.headers['content-type'],
      JSON_MEDIA_TYPE,
      `GET ${S001_PATH} must answer ${JSON_MEDIA_TYPE}, `
        + `read ${JSON.stringify(response.headers['content-type'])}`
    );
    // `assert/strict`'s deepEqual is deep-strict, so an extra or missing key
    // fails here too: no directory column beyond `Name` may reach a payload.
    assert.deepEqual(
      JSON.parse(response.text),
      S001_PAYLOAD,
      `GET ${S001_PATH} must answer the committed S001 payload, read ${JSON.stringify(response.text)}`
    );
  } finally {
    await stop(entry);
  }
});

// Test 37 - the port is this file's shared resource, so its release is asserted
// rather than assumed. Awaiting `'close'` inside `stop` is what makes the
// refusal deterministic instead of a race with the kernel.
test('the default port is released once the entrypoint has shut down', async () => {
  const entry = spawnEntry();
  let stopped = false;
  try {
    await waitForBanner(entry);

    // Prove it genuinely held the port before proving it let go of it.
    const served = await httpRequest({ path: '/' });
    assert.equal(
      served.status,
      200,
      `the running entrypoint must serve ${HOST}:${DEFAULT_PORT}, read ${served.status}`
    );

    await stop(entry);
    stopped = true;
    assert.ok(
      entry.closed,
      `the entrypoint must have closed after SIGTERM (code ${entry.code}, signal ${entry.signal})`
    );

    const outcome = await probeConnection(DEFAULT_PORT);
    assert.equal(
      outcome,
      'ECONNREFUSED',
      `a connection to ${HOST}:${DEFAULT_PORT} must be refused after shutdown, read ${outcome}`
    );
  } finally {
    if (!stopped) await stop(entry);
  }
});

/* ---------------------------------------------------------------------------
 * Tests 38-39 - both bind-conflict paths.
 *
 * The CLI wrapper and the library entry point answer the same failure
 * differently on purpose, so each contract gets its own test. Asserting only
 * one would leave the other free to regress into the baseline's behaviour,
 * where a bind failure surfaced as an unhandled `'error'` event whose message
 * named neither the address nor the cause.
 * ------------------------------------------------------------------------- */

// Test 38 - the `require.main === module` wrapper: one diagnostic line on
// stderr plus a non-zero exit code, and no banner.
test('the CLI path reports a bind conflict on stderr and exits non-zero', async () => {
  const holder = await holdPort(DEFAULT_PORT);
  let entry = null;
  try {
    entry = spawnEntry();

    assert.ok(
      await waitForClose(entry, CHILD_EXIT_TIMEOUT_MS),
      `the entrypoint must exit within ${CHILD_EXIT_TIMEOUT_MS} ms when ${HOST}:${DEFAULT_PORT} `
        + `is already held${describeChild(entry)}`
    );
    assert.equal(
      entry.signal,
      null,
      `the entrypoint must exit of its own accord, not on a signal, read ${entry.signal}`
    );
    assert.ok(
      entry.code !== null && entry.code !== 0,
      `the entrypoint must exit non-zero on a bind conflict, read ${entry.code}${describeChild(entry)}`
    );
    assert.ok(
      entry.stderr.includes('EADDRINUSE'),
      `stderr must name EADDRINUSE, read ${JSON.stringify(entry.stderr)}`
    );
    assert.ok(
      entry.stderr.includes(`${HOST}:${DEFAULT_PORT}`),
      `stderr must name ${HOST}:${DEFAULT_PORT}, read ${JSON.stringify(entry.stderr)}`
    );
    assert.equal(
      entry.stderr.trimEnd().split('\n').length,
      1,
      `the wrapper must write exactly one diagnostic line, read ${JSON.stringify(entry.stderr)}`
    );
    assert.equal(
      entry.stdout,
      '',
      `a failed start must print no banner, read ${JSON.stringify(entry.stdout)}`
    );
  } finally {
    if (entry !== null) await stop(entry);
    await holder.release();
  }
});

// Test 39 - the library path: `start()` REJECTS, never exits the process.
//
// Listener route taken: the PREFERRED one. `server.js` attaches the failed
// `http.Server` to the rejected error as a non-enumerable `server` property, so
// the handle is reachable through the documented API and the leftover-state
// assertion can be made directly on it.
//
// One adaptation, per the standing instruction to adapt to the module as built
// rather than change it: the plan predicted `listenerCount('listening') === 0`,
// but that is unreachable for an `http.Server` on this runtime. A FRESH
// `http.createServer()` already carries one internal `'listening'` listener -
// Node's own `setupConnectionsTracking`, attached by the constructor (a plain
// `net.Server` carries none). Verified on Node v24.21.0: fresh count 1, count
// after a failed bind 1. The assertion therefore compares against a fresh
// server's count, which is what "our one-shot listener was removed" actually
// means and stays true if Node changes its internals.
test('the library path rejects a bind conflict and leaves the caller intact', async () => {
  const holder = await holdPort(DEFAULT_PORT);
  try {
    let failure = null;
    let sentinel = 'the statement after the rejection never ran';

    await assert.rejects(
      // `start` builds the real directory and repository from the committed
      // workbooks and reads the committed `activities.json` - read-only, and no
      // `POST` is issued anywhere in this file, so nothing is written.
      async () => { await start({ ...LIBRARY_OPTIONS, port: DEFAULT_PORT }); },
      (error) => {
        failure = error;
        assert.equal(
          error.code,
          'EADDRINUSE',
          `the rejection must carry code EADDRINUSE, read ${JSON.stringify(error.code)}`
        );
        assert.ok(
          error.message.includes(HOST) && error.message.includes(String(DEFAULT_PORT)),
          `the rejection must name ${HOST}:${DEFAULT_PORT}, read ${JSON.stringify(error.message)}`
        );
        return true;
      },
      `start() must reject when ${HOST}:${DEFAULT_PORT} is already held`
    );

    // The calling process is still executing: `start` never called
    // `process.exit`, and the failure did not escape as an uncaught event.
    sentinel = 'the caller survived the rejection';
    assert.equal(
      sentinel,
      'the caller survived the rejection',
      'the test process must still be executing after start() rejected'
    );

    assert.ok(
      failure !== null && failure.server instanceof http.Server,
      'the rejection must expose the server whose bind failed, so a caller can inspect it'
    );
    assert.equal(
      failure.server.listening,
      false,
      'the server whose bind failed must not report itself as listening'
    );
    assert.equal(
      failure.server.listenerCount('error'),
      0,
      `start()'s one-shot 'error' listener must be removed once the promise has settled, `
        + `read ${failure.server.listenerCount('error')}`
    );

    const fresh = http.createServer(() => {});
    assert.equal(
      failure.server.listenerCount('listening'),
      fresh.listenerCount('listening'),
      `start()'s one-shot 'listening' listener must be removed once the promise has settled: `
        + `read ${failure.server.listenerCount('listening')} against a fresh server's `
        + `${fresh.listenerCount('listening')}`
    );
  } finally {
    await holder.release();
  }
});

/* ---------------------------------------------------------------------------
 * Tests 40-41 - the configuration contract.
 *
 * Several cases each, held in tables inside ONE test body so the file's
 * counted-test total stays at eight. Every assertion message names its case.
 * ------------------------------------------------------------------------- */

/**
 * Port values that must be refused outright.
 *
 * Whole-string validation is the point: `Number.parseInt` alone would read
 * `'1.5'` as `1` and `'3000abc'` as `3000`, silently binding a port the
 * operator never asked for, and `'70000'` is well-formed but out of range.
 * `''` is included because an exported-but-empty `PORT` must fail loudly rather
 * than fall back to a default.
 */
const INVALID_PORTS = ['abc', '70000', '1.5', '3000abc', ''];

// Test 40 - every invalid port is fatal and names itself; `0` is accepted and
// means "let the kernel choose", which is what the in-process suite relies on.
test('an invalid port is a fatal configuration error and 0 binds an ephemeral port', async () => {
  for (const value of INVALID_PORTS) {
    const label = JSON.stringify(value);
    assert.throws(
      () => createServer({ ...LIBRARY_OPTIONS, port: value }),
      (error) => {
        assert.equal(
          error.code,
          'SERVER_CONFIG_INVALID',
          `port ${label}: the failure must be a configuration error, read ${JSON.stringify(error.code)}`
        );
        if (value === '') {
          // `includes('')` is trivially true, so the empty case asserts that
          // the message identifies WHICH setting was rejected instead.
          assert.match(
            error.message,
            /port/i,
            `port ${label}: the message must identify the port configuration, `
              + `read ${JSON.stringify(error.message)}`
          );
        } else {
          assert.ok(
            error.message.includes(value),
            `port ${label}: the message must name the offending value verbatim, `
              + `read ${JSON.stringify(error.message)}`
          );
        }
        return true;
      },
      `port ${label}: createServer must refuse it`
    );
  }

  // The environment-variable path, proven through the real process: a bad
  // `PORT` must fail startup, not be coerced into something bindable.
  const rejected = spawnEntry({ env: { PORT: 'abc' } });
  try {
    assert.ok(
      await waitForClose(rejected, CHILD_EXIT_TIMEOUT_MS),
      `PORT=abc: the entrypoint must exit within ${CHILD_EXIT_TIMEOUT_MS} ms${describeChild(rejected)}`
    );
    assert.ok(
      rejected.code !== null && rejected.code !== 0,
      `PORT=abc: the entrypoint must exit non-zero, read ${rejected.code}${describeChild(rejected)}`
    );
    assert.ok(
      rejected.stderr.includes('abc'),
      `PORT=abc: stderr must name the offending value, read ${JSON.stringify(rejected.stderr)}`
    );
    assert.equal(
      rejected.stdout,
      '',
      `PORT=abc: no banner may be printed, read ${JSON.stringify(rejected.stdout)}`
    );
  } finally {
    await stop(rejected);
  }

  // The accepted case. `0` is preserved through resolution rather than
  // normalized away, so the configured value and the bound value differ.
  const ephemeral = await start({ ...LIBRARY_OPTIONS, port: 0 });
  try {
    const address = ephemeral.address();
    assert.ok(
      address !== null && typeof address === 'object',
      `port 0: the server must report an address object, read ${JSON.stringify(address)}`
    );
    assert.ok(
      address.port > 0,
      `port 0: the kernel must have chosen a real port, read ${address.port}`
    );
    assert.notEqual(
      address.port,
      DEFAULT_PORT,
      `port 0: an ephemeral bind must not land on the default port ${DEFAULT_PORT}`
    );
    assert.equal(
      ephemeral.config.port,
      0,
      `port 0: the configured value must be preserved, read ${ephemeral.config.port}`
    );
  } finally {
    await closeServer(ephemeral);
  }
});

/**
 * Host values that must be refused. An empty or whitespace-only host must
 * never become a silent bind to every interface: `listen(port, '')` binds
 * `0.0.0.0`, which would publish a service that authenticates nobody.
 */
const INVALID_HOSTS = ['', '   '];

// Test 41 - the host is fatal when empty, and both path options resolve against
// the entrypoint's directory rather than the caller's working directory.
test('an empty host is fatal and relative paths resolve against the entrypoint directory', async () => {
  for (const value of INVALID_HOSTS) {
    const label = JSON.stringify(value);
    assert.throws(
      () => createServer({ ...LIBRARY_OPTIONS, host: value }),
      (error) => {
        assert.equal(
          error.code,
          'SERVER_CONFIG_INVALID',
          `host ${label}: the failure must be a configuration error, read ${JSON.stringify(error.code)}`
        );
        assert.match(
          error.message,
          /host/i,
          `host ${label}: the message must identify the host configuration, `
            + `read ${JSON.stringify(error.message)}`
        );
        return true;
      },
      `host ${label}: createServer must refuse it rather than bind every interface`
    );
  }

  // Resolution asserted directly on the pure function. Both values are
  // relative, and both must land beside `server.js`.
  const config = resolveConfig({
    host: HOST,
    port: 0,
    workbookDir: '.',
    activitiesDataPath: 'activities.json'
  });
  assert.ok(
    path.isAbsolute(config.workbookDir),
    `workbookDir must resolve to an absolute path, read ${JSON.stringify(config.workbookDir)}`
  );
  assert.ok(
    path.isAbsolute(config.activitiesDataPath),
    `activitiesDataPath must resolve to an absolute path, read ${JSON.stringify(config.activitiesDataPath)}`
  );
  assert.equal(
    config.workbookDir,
    REPO_ROOT,
    `workbookDir '.' must resolve to the entrypoint's directory ${REPO_ROOT}, `
      + `read ${JSON.stringify(config.workbookDir)}`
  );
  assert.equal(
    config.activitiesDataPath,
    path.join(REPO_ROOT, 'activities.json'),
    `activitiesDataPath 'activities.json' must resolve beside the entrypoint, `
      + `read ${JSON.stringify(config.activitiesDataPath)}`
  );

  // End to end from a working directory that holds none of the project files.
  // Resolution against `process.cwd()` would find nothing there, so a served
  // payload proves the values resolved against the entrypoint's directory.
  const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), FOREIGN_CWD_PREFIX));
  const entry = spawnEntry({
    cwd: foreignCwd,
    env: { WORKBOOK_DIR: '.', ACTIVITIES_DATA_PATH: 'activities.json' }
  });
  try {
    assert.deepEqual(
      fs.readdirSync(foreignCwd),
      [],
      `the foreign working directory must be empty for this proof to mean anything, `
        + `read ${JSON.stringify(fs.readdirSync(foreignCwd))}`
    );

    await waitForBanner(entry);
    const response = await httpRequest({ path: S001_PATH });
    assert.equal(
      response.status,
      200,
      `launched from ${foreignCwd}, GET ${S001_PATH} must answer 200, `
        + `read ${response.status} with body ${JSON.stringify(response.text)}`
    );
    assert.equal(
      JSON.parse(response.text).name,
      S001_PAYLOAD.name,
      `launched from ${foreignCwd}, the committed workbooks must still be the source, `
        + `read ${JSON.stringify(response.text)}`
    );
  } finally {
    await stop(entry);
    fs.rmSync(foreignCwd, { recursive: true, force: true });
  }
});
