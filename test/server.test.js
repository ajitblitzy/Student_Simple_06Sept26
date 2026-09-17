'use strict';

/**
 * test/server.test.js - eight tests against the entrypoint as it ships.
 *
 * This is the ONLY file in the suite that spawns `node server.js` or binds the
 * default port `127.0.0.1:3000`; everything else runs in-process on an
 * ephemeral port with injected dependencies, which is fast and hermetic but
 * proves nothing about the artifact an operator runs. Four things are only
 * observable here: the startup banner, the greeting's exact bytes, the whole
 * module graph answering one request with nothing injected or stubbed, and the
 * two bind-conflict contracts - the `require.main === module` wrapper writes
 * one stderr line and sets a non-zero exit code, while `start()` rejects and
 * leaves its caller alive. Those two get a test each, because a single test
 * covering both would leave the other free to regress.
 *
 * The greeting's "Sharebot" wording disagrees with the project name and is
 * preserved DELIBERATELY - assert it verbatim, never "fix" it.
 *
 * The loopback bind is a real boundary, not a nominal one. A DNS rebinding
 * attack reaches a loopback service through a browser, so the request arrives
 * locally and only the `Host` authority it must carry distinguishes it; the
 * cases below exercise that gate under the real entrypoint - a rebound
 * authority refused on the greeting, on both read routes and on the append
 * route, a supported loopback authority still served, and the configuration
 * that governs a wider bind.
 *
 * WHAT CONSTRAINS EVERYTHING BELOW
 * ---------------------------------------------------------------------------
 *   - **It writes nothing inside the checkout.** No `POST` is issued anywhere
 *     in this file, so the committed `activities.json` and the workbooks are
 *     read-only throughout and `git status --porcelain` is identical before and
 *     after a run. The one directory it creates is an `fs.mkdtempSync`
 *     directory under the system temp root, holding the two registry files that
 *     make relative-path resolution observable, and it is removed in the same
 *     test's `finally`.
 *   - **It declares EXACTLY EIGHT top-level tests**, with no subtest, no
 *     `describe` and no `it`. Root `verify-tests.js` gates the run on the
 *     number of tests that passed, and subtests and `it`s count toward that
 *     total, so one extra here would inflate a number recorded outside this
 *     file. A test covering several cases therefore carries them in a table
 *     inside one body, naming the case in every assertion message.
 *   - **It keeps no assertion in a hook.** Assertions made inside
 *     `before`/`after` do not count toward the passed total. The single `after`
 *     here is a cleanup safety net and asserts nothing; the one error it can
 *     raise is a cleanup failure - a child it could not reap - which lands in
 *     the run's failure count rather than in its passed count, so the
 *     eight-test total stands either way.
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
 * Release is tracked rather than assumed: `stop()` drops a child from
 * `liveChildren` only once its `'close'` has actually arrived, so a process
 * that outlives its own `SIGKILL` stays reachable by the safety-net `after`
 * hook, which retries it and then fails the run with the port named.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// The library entry points under test. Requiring the entrypoint binds nothing:
// `listen` sits behind `require.main === module`, so these can be driven
// in-process.
const { resolveConfig, createServer, start } = require('../server');

/* ---------------------------------------------------------------------------
 * The preserved contract, written as literals.
 *
 * These are pinned values, not derived ones. Deriving the byte length from the
 * greeting, or the banner from the host and port, would make the assertion
 * agree with whatever the code does - which is the opposite of what a
 * backward-compatibility test is for. `127.0.0.1:3000` is also this file's
 * exclusive resource, and `REPO_ROOT` is where the entrypoint, the workbooks
 * and the committed registry sit.
 * ------------------------------------------------------------------------- */

const ENTRY = path.join(__dirname, '..', 'server.js');
const REPO_ROOT = path.dirname(ENTRY);
const HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const GREETING = 'Hello, World Welcome to Sharebot!\n';
const GREETING_BYTE_LENGTH = 34;
const GREETING_BYTES = Buffer.from(GREETING, 'utf8');
const BANNER = 'Server running at http://127.0.0.1:3000/';
const TEXT_MEDIA_TYPE = 'text/plain';
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

/** The roster route, the second read surface an unchecked authority exposed. */
const ACTIVITIES_PATH = '/api/activities';

/** The committed registry, asserted byte-unchanged after every rebound `POST`. */
const REGISTRY_PATH = path.join(REPO_ROOT, 'activities.json');

/* ---------------------------------------------------------------------------
 * The authority contract, written as literals for the same reason the greeting
 * is: an assertion derived from the implementation agrees with whatever the
 * implementation does.
 * ------------------------------------------------------------------------- */

/**
 * The authority a rebound browser origin presents: the attacker's own name,
 * which is the one field the attack cannot change. Reaching this service with
 * it is the whole of the DNS-rebinding exposure, so every route is probed with
 * it.
 */
const REBOUND_AUTHORITY = `attacker.example:${DEFAULT_PORT}`;

/** A loopback authority the service answers for, spelled the other legitimate way. */
const LOCALHOST_AUTHORITY = `localhost:${DEFAULT_PORT}`;

/** `421 Misdirected Request` - a parseable authority this server does not serve. */
const STATUS_MISDIRECTED_REQUEST = 421;

/** `400` - a `Host` header that is present but unusable. */
const STATUS_BAD_REQUEST = 400;

/** The two authority refusals, body included, since both sentences are fixed. */
const MISDIRECTED_BODY = '{"error":{"code":"MISDIRECTED_REQUEST",'
  + '"message":"Request authority is not served by this server"}}';
const INVALID_HOST_BODY = '{"error":{"code":"INVALID_HOST",'
  + '"message":"Host header must be a single valid authority"}}';

/* ---------------------------------------------------------------------------
 * Deadlines. Every wait in this file is bounded, so a failure is a readable
 * assertion rather than a suite that hangs until the runner is killed.
 * ------------------------------------------------------------------------- */

const READY_TIMEOUT_MS = 5000;
const CHILD_EXIT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;

/**
 * The environment variables the feature reads. They are stripped from every
 * child's environment and then re-applied per test, so no value can leak in
 * from the shell that launched the suite or out of one test into the next.
 *
 * `ALLOWED_HOSTS` belongs here for a sharper reason than tidiness: an ambient
 * value would widen the authority policy of every child, so a rebound-authority
 * assertion could pass or fail on the shell's environment rather than on the
 * code.
 */
const FEATURE_ENV_KEYS = ['PORT', 'HOST', 'ACTIVITIES_DATA_PATH', 'WORKBOOK_DIR', 'ALLOWED_HOSTS'];

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
 * `fs.mkdtempSync` prefix for the foreign working directory the path-resolution
 * test launches from. Deliberately NOT the `student-activities-` prefix the
 * other test files create and scan for: this directory is this file's own to
 * create and remove, and sharing a prefix would couple two files that have no
 * other relationship.
 */
const FOREIGN_CWD_PREFIX = 'server-entrypoint-cwd-';

/**
 * The two registry files the path-resolution proof needs.
 *
 * A missing registry is deliberately NON-FATAL: `lib/activityRepository.js`
 * warns on stderr and serves the workbook-sourced activities alone. That is
 * what would otherwise make a mis-resolved `ACTIVITIES_DATA_PATH` invisible - a
 * relative value resolved against the child's working directory finds nothing,
 * and the response is byte-identical to a correctly resolved one. Two files
 * make the resolution externally distinguishable in both directions, and both
 * live under `fs.mkdtempSync` so nothing is written inside the checkout:
 *
 *   - **The decoy** is named `activities.json` and planted IN the foreign
 *     working directory. `ACTIVITIES_DATA_PATH=activities.json` resolved
 *     against that directory would load it and answer with two activities, so
 *     the committed single-activity payload proves the value did NOT resolve
 *     against `process.cwd()`. Its record is valid on purpose: an invalid one
 *     would fail the load, which is a weaker signal than a wrong payload.
 *   - **The proof registry** sits OUTSIDE the checkout, addressed by a relative
 *     path computed from the entrypoint's directory, so its record can reach a
 *     response only if that value resolved against the entrypoint's directory.
 */
const DECOY_REGISTRY_FILENAME = 'activities.json';
const DECOY_ACTIVITY = 'Foreign Cwd Decoy Club';
const PROOF_REGISTRY_FILENAME = 'registry-proof.json';
const PROOF_ACTIVITY = 'Registry Path Proof Club';

/**
 * `S001`'s answer when the proof registry is the resolved registry: the
 * workbook record first, then the registry record.
 */
const S001_WITH_PROOF_PAYLOAD = {
  studentId: 'S001',
  name: 'Aarav Sharma',
  count: 2,
  activities: [
    { activity: 'Robotics Club', source: 'workbook' },
    { activity: PROOF_ACTIVITY, source: 'registry' }
  ]
};

/**
 * The opening words of the warning `lib/activityRepository.js` writes when the
 * resolved registry file is absent, quoted from the module as built. Its
 * ABSENCE is what proves the resolved path existed, which is the other thing a
 * served payload alone cannot show.
 */
const MISSING_REGISTRY_WARNING = 'Activity registry not found at';

/* ---------------------------------------------------------------------------
 * The inline harness.
 *
 * All of it lives here rather than in a helper module because every `.js` file
 * inside a directory named `test/` is executed as a test by default discovery,
 * which would inflate the count `verify-tests.js` gates on. Nothing in this
 * section asserts anything; assertions belong to the eight test bodies.
 * ------------------------------------------------------------------------- */

const liveChildren = new Set();
const liveHolders = new Set();

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
 *   spawnError: Error|null,
 *   signalsSent: {signal: string, delivered: boolean}[],
 *   stopFailure: string|null
 * }} A handle carrying the child and everything observed about it.
 *   `signalsSent` and `stopFailure` are teardown bookkeeping: they are what
 *   turns a child that outlived its own kill into a named failure instead of a
 *   silently leaked process holding this file's port.
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
    spawnError: null,
    signalsSent: [],
    stopFailure: null
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
 * Sends one signal and waits, bounded, for the child's `'close'`.
 *
 * The delivery flag `ChildProcess.kill` returns is kept on the handle: a
 * `false` there says the signal never reached the process, which is a different
 * diagnosis from a process that received it and ignored it.
 *
 * @param {ReturnType<typeof spawnEntry>} handle The child's handle.
 * @param {NodeJS.Signals} signal The signal to send.
 * @returns {Promise<boolean>} `true` once the child has closed.
 */
const signalAndAwaitClose = async (handle, signal) => {
  handle.signalsSent.push({ signal, delivered: handle.child.kill(signal) });
  return waitForClose(handle, CHILD_EXIT_TIMEOUT_MS);
};

/**
 * Stops a child and does not return until it is gone and its socket with it.
 *
 * `SIGTERM` first, then `SIGKILL` if the child overruns. On Windows libuv maps
 * both onto `TerminateProcess`, so the child dies at once and reports
 * `code === null` with `signal === 'SIGTERM'`; nothing here asserts on that,
 * only that `'close'` arrived. Awaiting `'close'` is what makes a port probe
 * after a shutdown deterministic instead of a race with the kernel releasing
 * the listening socket.
 *
 * THE BOOKKEEPING ORDER IS THE CONTRACT. The handle leaves `liveChildren` only
 * once `handle.closed` is true, never on the mere intention to stop it: a
 * handle dropped before closure is confirmed is a process this file can no
 * longer reach and a `127.0.0.1:3000` the safety-net `after` hook can no longer
 * release.
 *
 * A terminal failure is therefore reported on the handle rather than thrown.
 * Every caller awaits `stop` from a `finally`, where an exception would replace
 * the assertion error that sent the test into cleanup - the failure would read
 * as "could not kill a child" instead of as the behavioural defect that
 * actually broke. The unreachable child stays tracked with its diagnosis on
 * `handle.stopFailure`, and the `after` hook escalates it once every other
 * child and holder has been dealt with.
 *
 * @param {ReturnType<typeof spawnEntry>} handle The child's handle.
 * @param {{signals?: NodeJS.Signals[]}} [options] `signals` is the escalation
 *   ladder, in order; the `after` hook's retry passes `['SIGKILL']` alone
 *   because a child that already outlived both signals will not answer a
 *   second `SIGTERM` either.
 * @returns {Promise<boolean>} `true` once the child has closed - which is also
 *   when it has been untracked; `false` when the ladder was exhausted and the
 *   process may still be alive, in which case `handle.stopFailure` names why.
 */
const stop = async (handle, { signals = ['SIGTERM', 'SIGKILL'] } = {}) => {
  const untrack = () => {
    liveChildren.delete(handle);
    handle.stopFailure = null;
    return true;
  };

  if (handle.closed) return untrack();

  // A spawn that never produced a process has nothing to kill and nothing to
  // leak, so it is untracked without being held against the ladder below.
  if (handle.spawnError !== null && handle.child.pid === undefined) return untrack();

  for (const signal of signals) {
    if (await signalAndAwaitClose(handle, signal)) return untrack();
  }

  const ladder = handle.signalsSent
    .map(({ signal, delivered }) => `${signal} (delivered: ${delivered})`)
    .join(', then ');
  handle.stopFailure =
    `the spawned entrypoint (pid ${handle.child.pid}) did not close within `
      + `${CHILD_EXIT_TIMEOUT_MS} ms of each of ${ladder}, so it may still be running and `
      + `may still hold ${HOST}:${DEFAULT_PORT}${describeChild(handle)}`;
  return false;
};

/**
 * Issues one request and reads the whole response.
 *
 * The body is kept as a `Buffer` because the greeting is compared as bytes, not
 * as a decoded string: a byte-for-byte guarantee cannot survive a transcoding.
 *
 * `headers` exists for the authority assertions and is the mechanism that makes
 * them possible at all: an explicit `Host` REPLACES the one the client would
 * derive from the connection, which is precisely what a rebound browser origin
 * does - it connects to `127.0.0.1` while naming the attacker's authority.
 * Verified on the pinned runtime: supplying `Host` suppresses the automatic
 * header rather than adding a second one, so `req.rawHeaders` still carries
 * exactly one. An empty or duplicated value cannot be sent this way - the
 * client substitutes its own - which is what `rawRequest` below is for.
 *
 * @param {{
 *   method?: string,
 *   path: string,
 *   port?: number,
 *   headers?: Record<string, string>
 * }} options The request.
 * @returns {Promise<{
 *   status: number,
 *   headers: Record<string, string|string[]|undefined>,
 *   body: Buffer,
 *   text: string
 * }>} The response.
 */
const httpRequest = ({ method = 'GET', path: requestPath, port = DEFAULT_PORT, headers }) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      { host: HOST, port, path: requestPath, method, headers, agent: false },
      (response) => {
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
      }
    );

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
 * Writes one request onto a raw socket and returns the response bytes.
 *
 * Needed because an HTTP client refuses to send the malformed authorities the
 * gate must refuse: `http.request` substitutes its own `Host` for an empty
 * value and will not emit a second `Host` line, and it never speaks HTTP/1.0.
 * Those three cases are only reachable by writing the request line and headers
 * directly.
 *
 * The socket is read to close - every authority refusal declares
 * `Connection: close`, so the server ends the connection itself - and the wait
 * is bounded so a missing response is a readable failure rather than a hang.
 *
 * @param {string} raw The complete request, CRLF-delimited.
 * @param {number} [port] The port to connect to.
 * @returns {Promise<{statusLine: string, status: number, text: string, raw: string}>}
 *   The response's status line, parsed status, body and full bytes.
 */
const rawRequest = (raw, port = DEFAULT_PORT) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: HOST, port });
  let received = '';
  let settled = false;

  const settle = (outcome, value) => {
    if (settled) return;
    settled = true;
    socket.removeAllListeners();
    socket.destroy();
    outcome(value);
  };

  socket.setTimeout(REQUEST_TIMEOUT_MS, () => settle(
    reject,
    new Error(
      `no response to the raw request within ${REQUEST_TIMEOUT_MS} ms; `
        + `read ${JSON.stringify(received)}`
    )
  ));
  socket.on('connect', () => socket.write(raw));
  socket.on('data', (chunk) => {
    received += chunk.toString('utf8');
  });
  socket.on('error', (error) => settle(reject, error));
  socket.on('close', () => {
    const statusLine = received.split('\r\n')[0];
    const separatorAt = received.indexOf('\r\n\r\n');
    settle(resolve, {
      statusLine,
      status: Number(statusLine.split(' ')[1]),
      text: separatorAt === -1 ? '' : received.slice(separatorAt + 4),
      raw: received
    });
  });
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

const closeServer = (server) => new Promise((resolve) => {
  server.close(() => resolve());
});

/**
 * Cleanup safety net: it asserts NOTHING, because assertions made in a hook do
 * not count toward the suite's passed-test total and this file promises exactly
 * eight counted tests. Each test already stops its own child and releases its
 * own holder in a `finally`; this reaps whatever a thrown assertion skipped, so
 * a failure cannot leave port 3000 occupied for the next file or the next run.
 *
 * Anything still tracked here either never reached its `stop` or survived its
 * escalation, because `stop` untracks a handle only on confirmed closure. Each
 * one is retried with `SIGKILL`, every holder is released whatever the children
 * did, and only then is an unreapable child reported - by throwing, which is a
 * cleanup error rather than an assertion. That distinction matters: a throwing
 * hook lands in the run's failure count and not in its passed count, so it
 * fails the run loudly through `verify-tests.js`'s `failed === 0` condition
 * without inflating the eight counted tests its `MIN_TESTS` guard gates on.
 */
after(async () => {
  const failures = [];

  for (const handle of [...liveChildren]) {
    if (!(await stop(handle, { signals: ['SIGKILL'] }))) {
      failures.push(handle.stopFailure);
    }
  }

  for (const holder of [...liveHolders]) {
    try {
      await holder.release();
    } catch (error) {
      failures.push(`a port holder could not be released: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} leaked test resource(s) could not be cleaned up, so `
        + `${HOST}:${DEFAULT_PORT} may still be occupied: ${failures.join(' | ')}`
    );
  }
});

/* ---------------------------------------------------------------------------
 * The spawned entrypoint.
 * ------------------------------------------------------------------------- */

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

// The authority cases live on `/` on purpose: it is the one path that predates
// the feature, so "the gate refuses a rebound origin" and "the gate refuses
// nothing an ordinary client sends" have to be true at the same time.
test('GET / still answers the byte-identical 34-byte baseline greeting to a served authority', async () => {
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

    // The rebinding case itself. The connection is to `127.0.0.1` - exactly as
    // a rebound browser's would be, which is why no bind address can refuse it
    // - while the authority names the attacker. It must be refused before the
    // route runs, and the refusal must carry none of the greeting.
    const rebound = await httpRequest({ path: '/', headers: { Host: REBOUND_AUTHORITY } });
    assert.equal(
      rebound.status,
      STATUS_MISDIRECTED_REQUEST,
      `Host: ${REBOUND_AUTHORITY} must be refused with ${STATUS_MISDIRECTED_REQUEST}, `
        + `read ${rebound.status} with body ${JSON.stringify(rebound.text)}`
    );
    assert.equal(
      rebound.headers['content-type'],
      JSON_MEDIA_TYPE,
      `a refused authority must answer ${JSON_MEDIA_TYPE}, `
        + `read ${JSON.stringify(rebound.headers['content-type'])}`
    );
    assert.equal(
      rebound.text,
      MISDIRECTED_BODY,
      `the refusal must be the fixed envelope, read ${JSON.stringify(rebound.text)}`
    );
    assert.equal(
      rebound.headers.connection,
      'close',
      `a refused authority must declare Connection: close, `
        + `read ${JSON.stringify(rebound.headers.connection)}`
    );
    assert.ok(
      !rebound.text.includes('Sharebot'),
      `a refused authority must not receive the greeting, read ${JSON.stringify(rebound.text)}`
    );

    // The other half: every authority a legitimate client can present on this
    // bind is still served, so the gate is a boundary rather than an outage.
    const named = await httpRequest({ path: '/', headers: { Host: LOCALHOST_AUTHORITY } });
    assert.equal(
      named.status,
      200,
      `Host: ${LOCALHOST_AUTHORITY} is a supported loopback authority and must answer 200, `
        + `read ${named.status} with body ${JSON.stringify(named.text)}`
    );
    assert.ok(
      named.body.equals(GREETING_BYTES),
      `Host: ${LOCALHOST_AUTHORITY} must receive the greeting byte for byte, `
        + `read ${JSON.stringify(named.text)}`
    );

    // The port is part of the authority, not decoration: a loopback host on a
    // port this process is not listening on was addressed at something else.
    // `%d` is a real port number, so the value is well-formed - what fails is
    // the comparison against the port actually bound.
    const wrongPort = await httpRequest({ path: '/', headers: { Host: `${HOST}:${DEFAULT_PORT + 1}` } });
    assert.equal(
      wrongPort.status,
      STATUS_MISDIRECTED_REQUEST,
      `Host: ${HOST}:${DEFAULT_PORT + 1} must be refused on a server bound to ${DEFAULT_PORT}, `
        + `read ${wrongPort.status}`
    );

    // A portless authority means the scheme default, port 80, which this
    // service is not on.
    const portless = await httpRequest({ path: '/', headers: { Host: HOST } });
    assert.equal(
      portless.status,
      STATUS_MISDIRECTED_REQUEST,
      `Host: ${HOST} implies port 80 and must be refused on ${DEFAULT_PORT}, `
        + `read ${portless.status}`
    );

    // Userinfo is not part of an authority, and a value carrying it is unusable
    // rather than merely unrecognised - hence 400, not 421.
    const userinfo = await httpRequest({
      path: '/',
      headers: { Host: `admin@${HOST}:${DEFAULT_PORT}` }
    });
    assert.equal(
      userinfo.status,
      STATUS_BAD_REQUEST,
      `Host: admin@${HOST}:${DEFAULT_PORT} must be a ${STATUS_BAD_REQUEST}, read ${userinfo.status}`
    );
    assert.equal(
      userinfo.text,
      INVALID_HOST_BODY,
      `an unusable authority must be the fixed INVALID_HOST envelope, `
        + `read ${JSON.stringify(userinfo.text)}`
    );

    // Brackets delimit an IPv6 literal, so their contents must be one. `[::1]`
    // is a supported loopback authority and is served; the two malformed forms
    // are refused rather than repaired, because a parser that normalized them -
    // stripping that trailing dot, say - would make a value that is not an
    // address match the loopback set.
    const bracketedCases = [
      {
        host: `[::1]:${DEFAULT_PORT}`,
        status: 200,
        why: '::1 is a supported loopback authority on the bound port'
      },
      {
        host: `[::1.]:${DEFAULT_PORT}`,
        status: STATUS_BAD_REQUEST,
        why: '::1. is not an IPv6 literal, and a trailing dot must not be normalized off one'
      },
      {
        host: `[not:ipv6]:${DEFAULT_PORT}`,
        status: STATUS_BAD_REQUEST,
        why: 'a colon inside brackets is not evidence of an address'
      }
    ];
    for (const { host, status, why } of bracketedCases) {
      const result = await httpRequest({ path: '/', headers: { Host: host } });
      assert.equal(
        result.status,
        status,
        `Host: ${host} must answer ${status} because ${why}; read ${result.status} with body `
          + `${JSON.stringify(result.text)}`
      );
    }

    // Three cases an HTTP client will not send, so they go on the wire directly.
    // Each names what the gate decided and why that is the right decision.
    const rawCases = [
      {
        label: 'an HTTP/1.0 request asserting no authority',
        raw: 'GET / HTTP/1.0\r\n\r\n',
        status: 200,
        // It names no origin, so there is none to be misdirected from, and a
        // browser cannot produce it: `Host` is a forbidden header name, so the
        // rebinding vehicle always lands in one of the cases above.
        why: 'a request that asserts no authority is served under the server\'s own'
      },
      {
        label: 'an HTTP/1.0 request asserting a rebound authority',
        raw: `GET / HTTP/1.0\r\nHost: ${REBOUND_AUTHORITY}\r\n\r\n`,
        status: STATUS_MISDIRECTED_REQUEST,
        why: 'asserting an authority subjects it to the policy, whatever the protocol version'
      },
      {
        label: 'an empty Host value',
        raw: 'GET / HTTP/1.1\r\nHost: \r\n\r\n',
        status: STATUS_BAD_REQUEST,
        why: 'an asserted-but-empty authority is unusable; the runtime passes it through'
      },
      {
        label: 'two Host header lines',
        raw: `GET / HTTP/1.1\r\nHost: ${HOST}:${DEFAULT_PORT}\r\nHost: ${REBOUND_AUTHORITY}\r\n\r\n`,
        status: STATUS_BAD_REQUEST,
        // `req.headers.host` reports only the first, so a gate that trusted it
        // would judge one authority while the bytes carry two.
        why: 'two Host lines make the authority ambiguous (RFC 9112 3.2), and the runtime allows them'
      }
    ];
    for (const { label, raw, status, why } of rawCases) {
      const result = await rawRequest(raw);
      assert.equal(
        result.status,
        status,
        `${label}: must answer ${status} because ${why}; read ${JSON.stringify(result.statusLine)} `
          + `with body ${JSON.stringify(result.text)}`
      );
    }
  } finally {
    await stop(entry);
  }
});

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
    assert.deepEqual(
      JSON.parse(response.text),
      S001_PAYLOAD,
      `GET ${S001_PATH} must answer the committed S001 payload, read ${JSON.stringify(response.text)}`
    );

    // The same three capabilities through a rebound authority. This is what the
    // gate is for: without it, the payload just asserted - a student's name,
    // their activities, and every Student ID on the roster - is readable by any
    // page that rebound a DNS name at this loopback service.
    const registryBefore = fs.readFileSync(REGISTRY_PATH);
    for (const target of [S001_PATH, ACTIVITIES_PATH]) {
      const refused = await httpRequest({ path: target, headers: { Host: REBOUND_AUTHORITY } });
      assert.equal(
        refused.status,
        STATUS_MISDIRECTED_REQUEST,
        `GET ${target} with Host: ${REBOUND_AUTHORITY} must be refused with `
          + `${STATUS_MISDIRECTED_REQUEST}, read ${refused.status} with body `
          + `${JSON.stringify(refused.text)}`
      );
      assert.equal(
        refused.text,
        MISDIRECTED_BODY,
        `GET ${target}: the refusal must be the fixed envelope, read ${JSON.stringify(refused.text)}`
      );
      // The refusal is asserted to carry no data, not merely a different status:
      // a body leaking the name or an identifier would be the same exposure at a
      // different status code.
      for (const secret of ['Aarav Sharma', 'S001', 'Robotics Club']) {
        assert.ok(
          !refused.text.includes(secret),
          `GET ${target} with a rebound authority must leak nothing, but the body named `
            + `${JSON.stringify(secret)}: ${JSON.stringify(refused.text)}`
        );
      }
    }

    // The append route, the one capability that writes. The probe deliberately
    // carries the WRONG media type, so the request is unwritable by
    // construction: with the gate it is refused as a misdirected authority, and
    // without the gate it would reach the route and be refused as an
    // unsupported media type. Either way nothing can be persisted, and the
    // status distinguishes the two outcomes exactly - which is what proves the
    // gate runs BEFORE dispatch rather than somewhere inside it.
    const reboundPost = await httpRequest({
      method: 'POST',
      path: S001_PATH,
      headers: { Host: REBOUND_AUTHORITY, 'Content-Type': 'text/plain' }
    });
    assert.equal(
      reboundPost.status,
      STATUS_MISDIRECTED_REQUEST,
      `POST ${S001_PATH} with Host: ${REBOUND_AUTHORITY} must be refused with `
        + `${STATUS_MISDIRECTED_REQUEST} before the route sees it - a 415 would mean the `
        + `authority was checked after dispatch. Read ${reboundPost.status} with body `
        + `${JSON.stringify(reboundPost.text)}`
    );
    assert.ok(
      fs.readFileSync(REGISTRY_PATH).equals(registryBefore),
      `the committed registry ${REGISTRY_PATH} must be byte-unchanged by a refused POST`
    );

    // The control for that comparison: the identical request from a served
    // authority DOES reach the route, and is refused there on its media type.
    // Without this, a gate that refused every POST would pass the assertion
    // above for the wrong reason.
    const servedPost = await httpRequest({
      method: 'POST',
      path: S001_PATH,
      headers: { Host: `${HOST}:${DEFAULT_PORT}`, 'Content-Type': 'text/plain' }
    });
    assert.equal(
      servedPost.status,
      415,
      `POST ${S001_PATH} from a served authority must reach the route and be refused on its `
        + `media type (415), read ${servedPost.status} with body ${JSON.stringify(servedPost.text)}`
    );
    assert.ok(
      fs.readFileSync(REGISTRY_PATH).equals(registryBefore),
      `the committed registry ${REGISTRY_PATH} must be byte-unchanged by this test`
    );
  } finally {
    await stop(entry);
  }
});

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
 * Both bind-conflict paths, one test each: a single test covering both would
 * leave the other free to regress into an unhandled `'error'` event whose
 * message names neither the address nor the cause.
 * ------------------------------------------------------------------------- */

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

// `start()` REJECTS on a bind conflict rather than exiting the process, and
// `server.js` attaches the `http.Server` whose bind failed to the rejected
// error as a non-enumerable `server` property, so its leftover listener state
// is asserted directly on that handle.
//
// The `'listening'` count is compared against a freshly constructed
// `http.createServer()` rather than against zero, because an `http.Server`
// carries one internal `'listening'` listener attached by its own constructor
// (a plain `net.Server` carries none). Equality with a fresh server is what
// "start()'s one-shot listener was removed" means, and it holds whatever Node
// does with its internals.
test('the library path rejects a bind conflict and leaves the caller intact', async () => {
  const holder = await holdPort(DEFAULT_PORT);
  try {
    let failure = null;
    let sentinel = 'the statement after the rejection never ran';

    await assert.rejects(
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
 * The configuration contract. Both tests below carry several cases in a table
 * inside ONE body, so the file's counted-test total stays at eight, and every
 * assertion message names its case.
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

/**
 * A rejected port that carries the three things a diagnostic must never pass
 * through to a terminal or a log reader: `ESC [ 2 J` (the sequence that clears a
 * screen), CR LF (which would end the record and start one the caller wrote),
 * and U+202E (a right-to-left override, which reorders everything after it
 * without being a control character or whitespace at all).
 *
 * Environment values are operator-supplied text, not a closed alphabet, and this
 * is the one line printed when startup fails - so the sink is what has to be
 * safe (CWE-117). Kept under the 64-character cap the message applies to an
 * interpolated value, so the assertions below see the whole value rather than a
 * truncation of it.
 */
const HOSTILE_PORT = '\u001b[2J3000\r\nFORGED: server.js: ready\u202e';

/** Every code point the neutralized diagnostic must not contain verbatim. */
const RAW_LOG_UNSAFE_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

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

  // The library error keeps the value VERBATIM: neutralization belongs to the
  // sink that prints it, not to the message, so a caller catching this error can
  // still compare it against what it passed in.
  assert.throws(
    () => createServer({ ...LIBRARY_OPTIONS, port: HOSTILE_PORT }),
    (error) => {
      assert.equal(
        error.code,
        'SERVER_CONFIG_INVALID',
        `the hostile port must be a configuration error, read ${JSON.stringify(error.code)}`
      );
      assert.ok(
        error.message.includes('\u001b') && error.message.includes('\u202e'),
        'the thrown message must carry the rejected value verbatim, read '
          + `${JSON.stringify(error.message)}`
      );
      return true;
    },
    'createServer must refuse a port carrying terminal and bidi controls'
  );

  // The same value through the artifact an operator runs, which is where the
  // controls would land on a terminal. The wrapper must escape the whole detail
  // before writing it, so nothing in the value can repaint the screen, reorder
  // the sentence that rejected it, or forge a second diagnostic line.
  const hostile = spawnEntry({ env: { PORT: HOSTILE_PORT } });
  try {
    assert.ok(
      await waitForClose(hostile, CHILD_EXIT_TIMEOUT_MS),
      `PORT=<hostile>: the entrypoint must exit within ${CHILD_EXIT_TIMEOUT_MS} ms`
        + `${describeChild(hostile)}`
    );
    assert.ok(
      hostile.code !== null && hostile.code !== 0,
      `PORT=<hostile>: the entrypoint must exit non-zero, read ${hostile.code}`
        + `${describeChild(hostile)}`
    );
    assert.equal(
      hostile.stdout,
      '',
      `PORT=<hostile>: no banner may be printed, read ${JSON.stringify(hostile.stdout)}`
    );
    assert.equal(
      hostile.stderr.trimEnd().split('\n').length,
      1,
      'PORT=<hostile>: the wrapper must write exactly one diagnostic line, read '
        + `${JSON.stringify(hostile.stderr)}`
    );
    assert.equal(
      RAW_LOG_UNSAFE_PATTERN.test(hostile.stderr.trimEnd()),
      false,
      'PORT=<hostile>: no control, format or separator code point may survive into '
        + `the diagnostic, read ${JSON.stringify(hostile.stderr)}`
    );
    for (const escaped of ['\\u001b', '\\u000d', '\\u000a', '\\u202e']) {
      assert.ok(
        hostile.stderr.includes(escaped),
        `PORT=<hostile>: ${escaped} must appear escaped in the diagnostic, read `
          + `${JSON.stringify(hostile.stderr)}`
      );
    }
    assert.ok(
      hostile.stderr.startsWith('server.js: '),
      'PORT=<hostile>: the diagnostic must still be the wrapper\'s own line, read '
        + `${JSON.stringify(hostile.stderr)}`
    );
    assert.equal(
      hostile.stderr.includes('\nFORGED'),
      false,
      'PORT=<hostile>: no line may begin with caller-supplied text, read '
        + `${JSON.stringify(hostile.stderr)}`
    );
    // Neutralized, not discarded: the operator still sees which value was
    // rejected, which is why the port digits inside it survive.
    assert.ok(
      hostile.stderr.includes('3000'),
      'PORT=<hostile>: the readable part of the rejected value must survive, read '
        + `${JSON.stringify(hostile.stderr)}`
    );
  } finally {
    await stop(hostile);
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
 * Host values that must be refused, on BOTH paths that can supply one.
 *
 * An empty or whitespace-only host must never become a silent bind to every
 * interface: `listen(port, '')` binds `0.0.0.0`, which would publish a service
 * that authenticates nobody. Refusing it programmatically is only half the
 * contract - `HOST` is read from the environment by every operator who runs
 * `node server.js`, and an environment value that were ignored, or an empty one
 * mistaken for "not set" and quietly replaced by the default, would leave the
 * programmatic assertion green while the shipped entrypoint accepted it.
 *
 * `cliQuoted` is the rejected value as the CLI wrapper prints it, pinned as a
 * literal rather than recomputed: `reportStartupFailure` collapses every run of
 * whitespace in the diagnostic into a single space, so the whitespace-only host
 * is reported as `" "` while the empty one is reported as `""`. Quoting is what
 * makes an empty value visible at all.
 */
const INVALID_HOST_CASES = [
  { value: '', cliQuoted: '""' },
  { value: '   ', cliQuoted: '" "' }
];

/**
 * Authority allowlist entries that must be refused at startup, and why each
 * one matters rather than being pedantry.
 *
 * An entry the policy cannot parse is worse than useless: it would sit in the
 * configuration looking like permission while matching nothing, so an operator
 * would widen the bind, believe an authority was named, and get a service that
 * refuses every request - or, with a looser parser, one that admitted more than
 * the entry says. Both are startup failures instead.
 */
const INVALID_ALLOWED_HOSTS = [
  { value: '', why: 'an empty entry names no authority' },
  { value: '   ', why: 'a whitespace-only entry names no authority' },
  { value: 'app example', why: 'an authority cannot contain whitespace' },
  { value: 'app.example:70000', why: 'a port must be inside 0-65535' },
  { value: 'app.example:https', why: 'a port must be decimal digits' },
  { value: 'admin@app.example', why: 'userinfo is not part of an authority' },
  { value: 'http://app.example', why: 'a scheme is not part of an authority' },
  { value: 'app.example/activities', why: 'a path is not part of an authority' },
  { value: '[::1', why: 'an unclosed bracket is not an authority' },
  { value: 'app.example:1:2', why: 'two ports are ambiguous' },
  // Brackets promise an IPv6 literal. An entry that does not hold one could
  // never match a request authority, so it would sit in the configuration
  // looking like permission while permitting nothing.
  { value: '[not:ipv6]', why: 'a bracketed value must be an IPv6 literal' },
  { value: '[::1.]', why: 'a malformed literal must not be repaired into a valid one' }
];

/** A named authority that is nothing like a loopback spelling. */
const NAMED_AUTHORITY = 'activities.internal';

test('an empty or unlisted wider host is fatal and relative paths resolve against the entrypoint directory', async () => {
  for (const { value, cliQuoted } of INVALID_HOST_CASES) {
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

    const rejected = spawnEntry({ env: { HOST: value } });
    try {
      assert.ok(
        await waitForClose(rejected, CHILD_EXIT_TIMEOUT_MS),
        `HOST=${label}: the entrypoint must exit within ${CHILD_EXIT_TIMEOUT_MS} ms`
          + `${describeChild(rejected)}`
      );
      assert.equal(
        rejected.signal,
        null,
        `HOST=${label}: the entrypoint must exit of its own accord, not on a signal, `
          + `read ${rejected.signal}`
      );
      assert.ok(
        rejected.code !== null && rejected.code !== 0,
        `HOST=${label}: the entrypoint must exit non-zero, read ${rejected.code}`
          + `${describeChild(rejected)}`
      );
      assert.equal(
        rejected.stdout,
        '',
        `HOST=${label}: a refused host must print no banner, read ${JSON.stringify(rejected.stdout)}`
      );
      assert.match(
        rejected.stderr,
        /host/i,
        `HOST=${label}: stderr must identify the host setting it rejected, `
          + `read ${JSON.stringify(rejected.stderr)}`
      );
      assert.ok(
        rejected.stderr.includes(cliQuoted),
        `HOST=${label}: stderr must show the rejected value as ${cliQuoted}, `
          + `read ${JSON.stringify(rejected.stderr)}`
      );
      assert.equal(
        rejected.stderr.trimEnd().split('\n').length,
        1,
        `HOST=${label}: the wrapper must write exactly one diagnostic line, `
          + `read ${JSON.stringify(rejected.stderr)}`
      );
    } finally {
      await stop(rejected);
    }
  }

  // A bind beyond loopback with no authority named. `0.0.0.0` is the value the
  // README warns about: it publishes the service to a network that
  // authenticates nobody, and a published socket that answers for every
  // authority is reachable by a rebound browser origin. It must fail while the
  // server is being BUILT - nothing may listen first.
  assert.throws(
    () => createServer({ ...LIBRARY_OPTIONS, host: '0.0.0.0' }),
    (error) => {
      assert.equal(
        error.code,
        'SERVER_CONFIG_INVALID',
        `host 0.0.0.0 with no allowlist must be a configuration error, `
          + `read ${JSON.stringify(error.code)}`
      );
      assert.match(
        error.message,
        /ALLOWED_HOSTS/,
        `the message must name the setting that would permit it, `
          + `read ${JSON.stringify(error.message)}`
      );
      return true;
    },
    'a wildcard bind with no authority allowlist must be refused'
  );

  // The same bind, with the authority it will answer for named, is accepted -
  // the rule is "name them", not "never widen". `createServer` does not listen,
  // so asserting this publishes nothing.
  const widened = createServer({
    ...LIBRARY_OPTIONS,
    host: '0.0.0.0',
    allowedHosts: `${NAMED_AUTHORITY}:${DEFAULT_PORT}`
  });
  assert.deepEqual(
    widened.config.allowedHosts,
    [`${NAMED_AUTHORITY}:${DEFAULT_PORT}`],
    `a named allowlist must reach the resolved configuration, `
      + `read ${JSON.stringify(widened.config.allowedHosts)}`
  );
  assert.equal(
    widened.listening,
    false,
    'createServer must not listen, so this assertion may not publish a socket'
  );

  // And through the artifact an operator runs, because `HOST` is read from the
  // environment by every `node server.js`. Nothing binds: configuration is
  // resolved before any `listen`, so this cannot contend for the default port.
  const widenedCli = spawnEntry({ env: { HOST: '0.0.0.0' } });
  try {
    assert.ok(
      await waitForClose(widenedCli, CHILD_EXIT_TIMEOUT_MS),
      `HOST=0.0.0.0: the entrypoint must exit within ${CHILD_EXIT_TIMEOUT_MS} ms`
        + `${describeChild(widenedCli)}`
    );
    assert.ok(
      widenedCli.code !== null && widenedCli.code !== 0,
      `HOST=0.0.0.0: the entrypoint must exit non-zero rather than publish the service, `
        + `read ${widenedCli.code}${describeChild(widenedCli)}`
    );
    assert.equal(
      widenedCli.stdout,
      '',
      `HOST=0.0.0.0: no banner may be printed, read ${JSON.stringify(widenedCli.stdout)}`
    );
    assert.match(
      widenedCli.stderr,
      /ALLOWED_HOSTS/,
      `HOST=0.0.0.0: stderr must name the setting that would permit the bind, `
        + `read ${JSON.stringify(widenedCli.stderr)}`
    );
  } finally {
    await stop(widenedCli);
  }

  // Every allowlist entry is validated at startup, so a rule that could never
  // match is a failure rather than a false sense of permission.
  for (const { value, why } of INVALID_ALLOWED_HOSTS) {
    const label = JSON.stringify(value);
    assert.throws(
      () => resolveConfig({ ...LIBRARY_OPTIONS, allowedHosts: [value] }),
      (error) => {
        assert.equal(
          error.code,
          'SERVER_CONFIG_INVALID',
          `allowedHosts ${label}: must be a configuration error, read ${JSON.stringify(error.code)}`
        );
        return true;
      },
      `allowedHosts ${label} must be refused: ${why}`
    );
  }

  // Entries are canonicalized once, by the same parser the `Host` header goes
  // through, so a listed authority and a request authority cannot disagree on
  // case, spacing or IPv6 bracketing.
  assert.deepEqual(
    resolveConfig({
      ...LIBRARY_OPTIONS,
      allowedHosts: ` ${NAMED_AUTHORITY.toUpperCase()} , app.example:8080 , [::1]:8080 `
    }).allowedHosts,
    [NAMED_AUTHORITY, 'app.example:8080', '[::1]:8080'],
    'a comma-separated allowlist must be trimmed, lower-cased and kept in order'
  );

  // The allowlist admits what it names, on a real server. An entry carrying no
  // port matches the name on whatever port the service is on, which is the
  // reverse-proxy case; an authority nobody named is still refused.
  const named = await start({
    ...LIBRARY_OPTIONS,
    port: 0,
    allowedHosts: [NAMED_AUTHORITY]
  });
  try {
    const namedPort = named.address().port;
    const admitted = await httpRequest({
      path: '/',
      port: namedPort,
      headers: { Host: NAMED_AUTHORITY }
    });
    assert.equal(
      admitted.status,
      200,
      `Host: ${NAMED_AUTHORITY} is on the allowlist and must be served, read ${admitted.status}`
    );
    const unlisted = await httpRequest({
      path: '/',
      port: namedPort,
      headers: { Host: REBOUND_AUTHORITY }
    });
    assert.equal(
      unlisted.status,
      STATUS_MISDIRECTED_REQUEST,
      `Host: ${REBOUND_AUTHORITY} is not on the allowlist and must be refused, `
        + `read ${unlisted.status}`
    );
    // The implicit loopback set survives alongside an explicit allowlist: an
    // allowlist adds authorities, it does not replace the ones a loopback bind
    // already answers for.
    const loopback = await httpRequest({ path: '/', port: namedPort });
    assert.equal(
      loopback.status,
      200,
      `${HOST}:${namedPort} must still be served when an allowlist is configured, `
        + `read ${loopback.status}`
    );
  } finally {
    await closeServer(named);
  }

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

  // End to end from a working directory that holds none of the project files:
  // once proving where a relative value did NOT resolve, once proving where it
  // DID.
  const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), FOREIGN_CWD_PREFIX));
  const decoyRegistry = path.join(foreignCwd, DECOY_REGISTRY_FILENAME);
  const proofRegistry = path.join(foreignCwd, PROOF_REGISTRY_FILENAME);
  try {
    // A valid registry for a real student, so that loading it would succeed and
    // show up as an extra activity rather than as a start-up failure.
    fs.writeFileSync(
      decoyRegistry,
      `${JSON.stringify([{ studentId: 'S001', activity: DECOY_ACTIVITY }], null, 2)}\n`,
      'utf8'
    );
    fs.writeFileSync(
      proofRegistry,
      `${JSON.stringify([{ studentId: 'S001', activity: PROOF_ACTIVITY }], null, 2)}\n`,
      'utf8'
    );

    // The negative half: relative values resolved against the entrypoint's
    // directory, so the committed workbooks are read (nothing readable sits in
    // the working directory) and the committed `activities.json` is the
    // registry rather than the identically named decoy one directory away.
    const entry = spawnEntry({
      cwd: foreignCwd,
      env: { WORKBOOK_DIR: '.', ACTIVITIES_DATA_PATH: DECOY_REGISTRY_FILENAME }
    });
    try {
      assert.deepEqual(
        fs.readdirSync(foreignCwd).sort(),
        [DECOY_REGISTRY_FILENAME, PROOF_REGISTRY_FILENAME].sort(),
        `the foreign working directory must hold only this test's two registry files, `
          + `read ${JSON.stringify(fs.readdirSync(foreignCwd))}`
      );
      assert.equal(
        fs.readdirSync(foreignCwd).filter((name) => name.endsWith('.xlsx')).length,
        0,
        'the foreign working directory must hold no workbook, or a cwd-resolved '
          + 'WORKBOOK_DIR could satisfy the request too'
      );

      await waitForBanner(entry);
      const response = await httpRequest({ path: S001_PATH });
      assert.equal(
        response.status,
        200,
        `launched from ${foreignCwd}, GET ${S001_PATH} must answer 200, `
          + `read ${response.status} with body ${JSON.stringify(response.text)}`
      );
      // Deep-strict on the WHOLE payload, not just `name`: the decoy holds a
      // second activity for this very student, so a registry path resolved
      // against the working directory would answer `count: 2` carrying
      // `DECOY_ACTIVITY`. Equality with the committed single-activity payload
      // is therefore the assertion that distinguishes the two resolutions,
      // which a `name` check could not.
      assert.deepEqual(
        JSON.parse(response.text),
        S001_PAYLOAD,
        `launched from ${foreignCwd}, the committed workbooks and the committed registry `
          + `must be the sources - a payload carrying ${JSON.stringify(DECOY_ACTIVITY)} would `
          + `mean ACTIVITIES_DATA_PATH resolved against the working directory. `
          + `Read ${JSON.stringify(response.text)}`
      );
      // The other half: a resolved path that does not exist is not an error,
      // only a warning, so its absence is what proves the resolved registry
      // path was found rather than merely harmless.
      assert.ok(
        !entry.stderr.includes(MISSING_REGISTRY_WARNING),
        `launched from ${foreignCwd}, the resolved registry path must exist, so no `
          + `${JSON.stringify(MISSING_REGISTRY_WARNING)} warning may be printed, `
          + `read ${JSON.stringify(entry.stderr)}`
      );
      assert.equal(
        entry.stderr,
        '',
        `launched from ${foreignCwd}, a healthy start must print nothing on stderr, `
          + `read ${JSON.stringify(entry.stderr)}`
      );
    } finally {
      await stop(entry);
    }

    // The positive half, which the case above can only establish negatively:
    // the value is relative and addresses a registry OUTSIDE the checkout,
    // computed from the entrypoint's directory, so its record can reach a
    // response only if the value resolved there.
    const relativeProofPath = path.relative(REPO_ROOT, proofRegistry);
    const cwdResolvedCandidate = path.resolve(foreignCwd, relativeProofPath);
    assert.ok(
      !path.isAbsolute(relativeProofPath),
      `the registry path under test must be relative for this proof to mean anything, `
        + `read ${JSON.stringify(relativeProofPath)}`
    );
    assert.notEqual(
      cwdResolvedCandidate,
      proofRegistry,
      `resolving ${JSON.stringify(relativeProofPath)} against the working directory must `
        + `reach somewhere else, or the two resolutions would be indistinguishable`
    );
    assert.equal(
      fs.existsSync(cwdResolvedCandidate),
      false,
      `nothing may exist at ${cwdResolvedCandidate}, the path a cwd-relative resolution `
        + `would reach, or a wrong resolution could still serve the proof record`
    );

    const relativeEntry = spawnEntry({
      cwd: foreignCwd,
      env: { WORKBOOK_DIR: '.', ACTIVITIES_DATA_PATH: relativeProofPath }
    });
    try {
      await waitForBanner(relativeEntry);
      const response = await httpRequest({ path: S001_PATH });
      assert.equal(
        response.status,
        200,
        `with ACTIVITIES_DATA_PATH=${JSON.stringify(relativeProofPath)}, GET ${S001_PATH} `
          + `must answer 200, read ${response.status} with body ${JSON.stringify(response.text)}`
      );
      assert.deepEqual(
        JSON.parse(response.text),
        S001_WITH_PROOF_PAYLOAD,
        `with ACTIVITIES_DATA_PATH=${JSON.stringify(relativeProofPath)}, the record in `
          + `${proofRegistry} must be served, which it can be only if the relative value `
          + `resolved against ${REPO_ROOT}. Read ${JSON.stringify(response.text)}`
      );
      assert.ok(
        !relativeEntry.stderr.includes(MISSING_REGISTRY_WARNING),
        `with ACTIVITIES_DATA_PATH=${JSON.stringify(relativeProofPath)}, the resolved path `
          + `must exist, read ${JSON.stringify(relativeEntry.stderr)}`
      );
    } finally {
      await stop(relativeEntry);
    }
  } finally {
    fs.rmSync(foreignCwd, { recursive: true, force: true });
  }
});
