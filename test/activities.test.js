'use strict';

/**
 * test/activities.test.js — the endpoint-contract evidence for the
 * `/activities` namespace.
 *
 * WHAT THIS FILE COVERS
 * ---------------------
 * Every feature-originated row of the authoritative response matrix, driven
 * over real HTTP against the real composed server from `server.js`: the
 * submission form, the three routes, the validation precedence, the media-type
 * and body-size refusals, the namespace boundary, HTML escaping, and all four
 * distinct `500` codes. Each row gets its OWN named case, because a single test
 * asserting several rows lets the first failure mask the rest.
 *
 * Statuses alone are not the contract, so every case asserts the status AND the
 * error code AND the `Content-Type`, plus `Allow` and `Location` wherever the
 * matrix says they are carried.
 *
 * Every case runs against a store, a module chain and a listener of its OWN,
 * handed to it by the per-case harness below, so no case can be affected by
 * what ran before it and the file's cases can be read, reordered or run one at
 * a time without changing what they mean.
 *
 * What the file deliberately leaves to `test/lifecycle.test.js` is the
 * BYTE-LEVEL preserved response — the 34-byte body, its sha256 and the
 * charset-free `text/plain` header — which that file owns and asserts against a
 * real child process. Here the boundary is asserted as the predicate it is:
 * `handle` declining a path and writing nothing at all.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The governing rule `Ajit_AddNewFeature_Rule` — summarized here, never
 * reproduced — makes testing requirements a deliverable of adding a feature.
 * The one-sentence user request never asked for a test, so this file exists
 * because the rule does. Its consequence is that every case below is real
 * executable evidence that can fail: no `t.todo`, no `t.skip`, and no assertion
 * that holds trivially.
 *
 * The same rule's minimal-change area is why the runner is the runtime's own
 * `node:test` with `node:assert`, why no dependency is added, and why every
 * helper is local to this file rather than a fourth file in `test/` — `test/`
 * holds exactly three files, and duplicating a small request helper across two
 * of them is the accepted cost of that limit.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * It never binds the literal port 3000. Every listener it starts takes an
 * EPHEMERAL port via `listen(0)` and is closed again, so this file contends
 * with nothing — `test/lifecycle.test.js` owns port 3000 alone.
 *
 * It writes nothing into the checkout. Every store it exercises lives under one
 * temporary directory that is removed in `after`, and the three workbooks are
 * read-only fixtures whose every value is synthetic by construction, so no real
 * personal data enters this suite or its output.
 *
 * Run it with the project's single documented invocation, from the repository
 * root, with NO positional argument:
 *
 *   npm test        # node --test --test-concurrency=1
 */

/* ------------------------------------------------------------------------- *
 * THE STORE PATH MUST BE SET BEFORE THE FEATURE MODULES LOAD
 *
 * `activity-store.js` resolves its store path ONCE, at module load, defaulting
 * to `activities.json` beside itself — the developer's real store in the
 * repository root. The resolution is triggered TRANSITIVELY: requiring
 * `../server` pulls in `../activities`, which pulls in `../activity-store`.
 *
 * So the environment variable is set here, above those requires, and not in a
 * hook — a hook runs long after the module chain has already resolved its
 * path. Getting this order wrong makes the suite write into the working tree,
 * which is why the require of `node:fs` and the `mkdtempSync` below come before
 * the project requires rather than being grouped with them.
 *
 * Every CASE then gets a store path of its own, through a module chain of its
 * own, from the per-case harness further down. The value set here is only what
 * the LOAD-TIME chain resolves, and no case is ever driven through that chain.
 * ------------------------------------------------------------------------- */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** One directory for every artifact this file creates. Removed in `after`. */
const TEMPORARY_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'activities-test-'));

/**
 * The store path the LOAD-TIME module chain resolves.
 *
 * Requiring the feature below resolves a store path whether a case uses it or
 * not, so this must point inside the temporary root: otherwise the mere act of
 * loading this file would aim the store at the repository root. Nothing writes
 * it — no case is driven through the load-time chain, and each case writes the
 * store its own harness resolved.
 */
const LOAD_TIME_STORE_PATH = path.join(TEMPORARY_ROOT, 'load-time-chain', 'activities.json');

process.env.ACTIVITY_STORE = LOAD_TIME_STORE_PATH;

const { describe, it, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const fsp = require('node:fs/promises');

/**
 * The feature's module object, not a destructured `handle`. Holding the object
 * is what lets the `internal_error` cases replace the property that `server.js`
 * reads at call time.
 *
 * The binding is `let` and is REBOUND by the per-case harness to the chain the
 * running case's own server closes over, so a patch applied inside a case
 * reaches the server that case is driving rather than a chain nothing is
 * listening on. This load-time value is only what holds until the first case
 * starts.
 */
let activities = require('../activities');

/**
 * The real composed server, as the load-time chain built it. Safe to require:
 * `server.js` wraps its `listen` call in `if (require.main === module)`, so
 * loading it binds no port.
 *
 * Driving the real composition rather than a hand-rolled one matters twice
 * over: it is the code that actually ships, and the `internal_error` branch
 * lives in `server.js` and is reachable no other way. Like `activities` above
 * this binding tracks the active per-case chain; the load-time instance here is
 * never listened on, so there is no load-time listener to close.
 *
 * The export surface is itself part of the contract: `server.js` exports
 * exactly `server`, `hostname` and `port`, and the export-surface cases at the
 * end of this file consume all three rather than leaving two of them unread.
 * The hostname and the port are load-time literals that NO chain re-derives —
 * `'127.0.0.1'` and `3000`, written as literals in `server.js` and never
 * recomputed from a store path, an environment variable or a bound address —
 * so destructuring them once here is what those two cases assert against. The
 * `server` binding below is the one that must follow the active chain, which
 * is why the case that pins the surface and the instance identity resolves the
 * ACTIVE chain's module object for itself rather than reading this one.
 */
const serverModule = require('../server');
const { hostname: serviceHostname, port: servicePort } = serverModule;
let server = serverModule.server;

/* ------------------------------------------------------------------------- *
 * The contract's vocabulary, as constants rather than repeated literals
 * ------------------------------------------------------------------------- */

const HOST = '127.0.0.1';

const NAMESPACE = '/activities';

const CONTENT_TYPE_JSON = 'application/json; charset=utf-8';
const CONTENT_TYPE_HTML = 'text/html; charset=utf-8';
const MEDIA_TYPE_JSON = 'application/json';
const MEDIA_TYPE_FORM = 'application/x-www-form-urlencoded';

/** The request-body ceiling, INCLUSIVE: this many bytes is read, one more is not. */
const MAX_BODY_BYTES = 8192;

/** A Student ID present in `student_details.xlsx`, used where any key will do. */
const KNOWN_STUDENT_ID = 'S001';

/** Well-formed and absent from the key set — the `student_not_found` fixture. */
const ABSENT_STUDENT_ID = 'S999';

/**
 * The seeded labels, from `Other Info` column C rows 2-11. Each is present as a
 * `source: "workbook"` record carrying NO `submittedAt`.
 */
const SEEDED_LABELS = Object.freeze({
  S001: 'Robotics Club',
  S002: 'Debate Society',
  S003: 'Football Team',
  S004: 'Music Club',
  S005: 'Coding Club',
  S006: 'Dance Club',
  S007: 'Cricket Team',
  S008: 'Photography Club',
  S009: 'Robotics Club',
  S010: 'Debate Society',
});

const SOURCE_SUBMISSION = 'submission';
const SOURCE_WORKBOOK = 'workbook';

/* ------------------------------------------------------------------------- *
 * The HTTP client
 *
 * KEEP-ALIVE IS NOT A PERFORMANCE CHOICE — IT IS REQUIRED FOR CORRECTNESS OF
 * THE OVERSIZE CASES, and it was measured rather than assumed.
 *
 * With `agent: false` the client sends `Connection: close`. The server answers
 * an oversize body with its 413 while the client is still uploading, then tears
 * the socket down; with megabytes still inbound the operating system answers
 * that teardown with a TCP reset, and the reset DISCARDS the response already
 * sitting in the client's receive buffer. Measured on this host: a 5 MB body
 * delivered the 413 zero times out of five, surfacing as ECONNRESET with no
 * status at all.
 *
 * Through one keep-alive agent — which is what a browser and `curl` both use —
 * the same request delivers the 413 five times out of five, at 8193 bytes,
 * 64 KB, 200 KB, 1 MB, 5 MB and 20 MB alike. The difference is entirely in the
 * client's connection handling; the server sent its response in every case.
 *
 * A pooled socket left open would keep a listener alive and the runner would
 * hang instead of exiting, so every close in this file — the per-case listener
 * in `afterEach`, an isolated one in its own `t.after` — drops its connections
 * with `closeAllConnections()` before awaiting the close, and the agent itself
 * is destroyed in the final `after`. With that ordering each close completes in
 * about a millisecond and no `--test-force-exit` is needed.
 * ------------------------------------------------------------------------- */

const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });

/**
 * The ceiling on a single request, in milliseconds.
 *
 * WITHOUT A CEILING THE SUITE CANNOT FAIL, IT CAN ONLY HANG: the runner's own
 * per-test timeout defaults to Infinity, so a server that accepted a request
 * and then answered nothing — a handler that never calls `end`, a body read
 * that never settles — would leave the promise below pending for ever and take
 * the whole run with it. Every settlement path disarms the timer, so the
 * ceiling costs a cleared timeout per request and nothing else.
 *
 * The value is generous against the largest fixture this file sends (a 5 MB
 * body over loopback, measured in milliseconds) and small against any wait a
 * person would sit through. A case needing a different bound passes
 * `deadlineMs`.
 */
const REQUEST_DEADLINE_MS = 20000;

/**
 * The case currently running, and the whole of what a helper needs to reach it.
 *
 * Installed by `beforeEach` and cleared by `afterEach`, so `null` here means no
 * case is running. Subtests execute strictly one at a time, which is what makes
 * a single mutable slot the right shape for this.
 */
let harness = null;

/**
 * The ephemeral port of the case currently running.
 *
 * Every request helper defaults to it, which is what lets a case say
 * `postJson({ ... })` and reach its OWN isolated server without naming a port. A
 * helper called with no case running fails loudly here rather than silently
 * addressing whatever happened to be listening last.
 *
 * @returns {number} The running case's port.
 */
function activePort() {
  assert.ok(
    harness !== null,
    'a request helper was called with no case harness running — every request must belong to a case'
  );
  return harness.port;
}

/**
 * Issues one request and resolves with the whole response.
 *
 * Rejects on a socket failure AND on the deadline above, so a request the
 * server never answers surfaces as a failed assertion rather than as a test
 * that hangs for ever. The one exception is a write error that arrives AFTER
 * the response has started: that is the server hanging up on a request it has
 * already refused, so the error is held back and raised only if the response
 * never completes.
 *
 * @param {{method?: string, target?: string, headers?: Record<string, string>,
 *   body?: string|Buffer, port?: number, deadlineMs?: number}} [options] `port`
 *   defaults to the running case's own server, so a second server inside a case
 *   is driven by passing its own.
 * @returns {Promise<{status: number, headers: Record<string, string|string[]>,
 *   body: string}>} The status, the response headers, and the body as text.
 */
function request(options = {}) {
  const {
    method = 'GET',
    target = '/',
    headers = {},
    body,
    port: requestPort = activePort(),
    deadlineMs = REQUEST_DEADLINE_MS,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    let deferredError = null;
    let deadline = null;

    /**
     * Clears the deadline. Called from BOTH settlement funnels below, which are
     * between them the only ways out of this promise, so the timer cannot
     * outlive the request that armed it.
     */
    const disarm = () => {
      if (deadline !== null) {
        clearTimeout(deadline);
        deadline = null;
      }
    };

    const succeed = (value) => {
      if (!settled) {
        settled = true;
        disarm();
        resolve(value);
      }
    };
    const failWith = (error) => {
      if (!settled) {
        settled = true;
        disarm();
        reject(error);
      }
    };

    const clientRequest = http.request(
      { host: HOST, port: requestPort, method, path: target, headers, agent },
      (response) => {
        responseStarted = true;
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          succeed({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
        response.on('error', failWith);
      }
    );

    clientRequest.on('error', (error) => {
      if (responseStarted) {
        deferredError = error;
        return;
      }
      failWith(error);
    });

    clientRequest.on('close', () => {
      failWith(
        deferredError ??
          new Error(`${method} ${target} closed without delivering a response`)
      );
    });

    deadline = setTimeout(() => {
      // The rejection comes FIRST and the destroy second: destroying emits
      // `error` and then `close`, and both are already no-ops once the promise
      // has settled, so the reported failure names the deadline that was missed
      // rather than the teardown that missing it caused. The destroy itself is
      // not optional — an abandoned request would hold a pooled socket, and
      // through it the listener, past the end of the case.
      failWith(
        new Error(`${method} ${target} did not complete within ${deadlineMs} ms`)
      );
      clientRequest.destroy();
    }, deadlineMs);

    if (body !== undefined) {
      clientRequest.write(body);
    }
    clientRequest.end();
  });
}

/**
 * `GET` shorthand.
 *
 * @param {string} target The request target.
 * @param {{port?: number, headers?: Record<string, string>}} [options] Extras.
 * @returns {Promise<object>} The response.
 */
function get(target, options = {}) {
  return request({ method: 'GET', target, ...options });
}

/**
 * `POST /activities` with an arbitrary body and media type.
 *
 * Omitting `contentType` sends NO `Content-Type` header at all, which is the
 * fixture for the `415` that refuses to guess at a body's format.
 *
 * @param {{contentType?: string, body?: string|Buffer, port?: number}} options
 *   The media type and body to send.
 * @returns {Promise<object>} The response.
 */
function postBody(options = {}) {
  const { contentType, body, port: requestPort } = options;
  return request({
    method: 'POST',
    target: NAMESPACE,
    headers: contentType === undefined ? {} : { 'Content-Type': contentType },
    body,
    port: requestPort,
  });
}

/**
 * `POST /activities` in JSON mode.
 *
 * A string payload is sent verbatim, so a deliberately unparseable body can be
 * submitted; anything else is serialized.
 *
 * @param {unknown} payload An object to serialize, or raw body text.
 * @param {{contentType?: string, port?: number}} [options] `contentType`
 *   overrides the header so the media-type normalization cases can vary its
 *   spelling while still sending JSON.
 * @returns {Promise<object>} The response.
 */
function postJson(payload, options = {}) {
  const { contentType = MEDIA_TYPE_JSON, port: requestPort } = options;
  return postBody({
    contentType,
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    port: requestPort,
  });
}

/**
 * `POST /activities` in form-encoded mode — exactly what the served form posts.
 *
 * @param {string} studentId The `studentId` field value.
 * @param {string} activity The `activity` field value.
 * @param {{contentType?: string, port?: number}} [options] `contentType`
 *   overrides the header for the normalization cases.
 * @returns {Promise<object>} The response.
 */
function postForm(studentId, activity, options = {}) {
  const { contentType = MEDIA_TYPE_FORM, port: requestPort } = options;
  return postBody({
    contentType,
    body: new URLSearchParams({ studentId, activity }).toString(),
    port: requestPort,
  });
}

/**
 * `POST /activities` with a raw form-encoded body, for the cases that need a
 * field omitted or sent empty rather than merely wrong.
 *
 * @param {string} body The literal form-encoded body.
 * @param {{port?: number}} [options] Extras.
 * @returns {Promise<object>} The response.
 */
function postFormBody(body, options = {}) {
  return postBody({ contentType: MEDIA_TYPE_FORM, body, port: options.port });
}

/* ------------------------------------------------------------------------- *
 * Per-case isolation: a store, a module chain and a listener for every case
 *
 * EVERY case in this file gets all three from the harness below, because a
 * store shared across cases is shared state whichever way its labels are
 * chosen: a case that fails part-way leaves its writes behind, a case that
 * reads "the store" is reading whatever ran before it, and the file's cases
 * stop being reorderable. Unique labels narrow that; they do not remove it.
 *
 * A handful of cases build a SECOND chain of their own on top of the harness,
 * with `startIsolatedServer`: one needs a dependency substituted in the window
 * between eviction and require, one needs a store path whose parent directory
 * does not exist, and the rest own the whole lifetime of a deliberately broken
 * store document. Each closes its own server in its own `t.after`, and the
 * case's harness keeps serving alongside it, untouched.
 * ------------------------------------------------------------------------- */

/**
 * The COMPLETE eviction set for the feature's module chain.
 *
 * Every one of these must be evicted TOGETHER: `activity-store.js` captures the
 * store path at load, and `activities.js` and `server.js` each capture the
 * instance below them, so re-requiring only the top of the chain would hand
 * back a server still pointing at the previous store.
 *
 * The listing order is incidental and is NOT the dependency order, which runs
 * `xlsx-read` then `activity-store` then `activities` then `server`. Eviction
 * does not depend on either order: deleting a cache entry cannot fail and
 * cannot be observed by another module, and the `require` that follows rebuilds
 * the chain in true dependency order by itself. Completeness is the only
 * property this list has to have.
 */
const FEATURE_MODULE_PATHS = Object.freeze([
  '../activity-store',
  '../xlsx-read',
  '../activities',
  '../server',
]);

/**
 * Evicts the feature's modules and re-requires them against a new store path.
 *
 * The returned `activities` is the SAME object the returned `server` closes
 * over — `require('../server')` loads `../activities` on its way up, and the
 * `require('../activities')` below reads that instance back out of the CommonJS
 * registry rather than building a second one. That identity is what makes the
 * `internal_error` patch observable: the harness rebinds this file's
 * module-level `activities` to it, so patching the property reaches the very
 * chain the case is driving.
 *
 * @param {string} storePath The store the new chain should resolve.
 * @param {() => void} [prepare] Runs AFTER the eviction and BEFORE the
 *   requires. This window is the only place a module can be substituted:
 *   `activity-store.js` captures `./xlsx-read`'s exports at its own load, so a
 *   stub installed any later is never seen, and one installed any earlier is
 *   wiped by the eviction loop above.
 * @returns {{server: import('node:http').Server, activities: object}} The
 *   freshly loaded chain.
 */
function freshModuleChain(storePath, prepare) {
  process.env.ACTIVITY_STORE = storePath;
  for (const modulePath of FEATURE_MODULE_PATHS) {
    delete require.cache[require.resolve(modulePath)];
  }
  if (prepare !== undefined) {
    prepare();
  }
  return { server: require('../server').server, activities: require('../activities') };
}

/**
 * The ceiling on binding one listener, in milliseconds.
 *
 * An ephemeral bind on loopback either succeeds or errors within microseconds,
 * so this is not a wait anyone should ever observe — it exists so that a bind
 * which does neither is a failed test instead of a suspended one.
 */
const LISTEN_DEADLINE_MS = 10000;

/**
 * Binds a server to an EPHEMERAL port and resolves with the port it was given.
 *
 * BOUNDED ON EVERY OUTCOME, which `listen(0, HOST, resolve)` is not: that form
 * subscribes to success alone, so a listener error — a consumed `'error'` event
 * that no longer terminates the process because `server.js` installs its own
 * listener for exactly that reason — leaves setup pending instead of failing,
 * and the run never reports anything at all. Here `'listening'` and `'error'`
 * each remove the other, a deadline covers the case where neither arrives, and
 * every failure path shuts down a listener that may already hold a partially
 * initialized handle.
 *
 * The port is always 0. Taking a port as a parameter is exactly how this file
 * would one day bind the literal 3000 that `test/lifecycle.test.js` owns, so it
 * does not take one — and it asserts the outcome as well, because a structural
 * guarantee worth having is worth checking once per bind.
 *
 * @param {import('node:http').Server} target The server to bind.
 * @param {string} context What is being started, for the failure message.
 * @returns {Promise<number>} The ephemeral port.
 */
function listenOnEphemeralPort(target, context) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;

    const disarm = () => {
      if (deadline !== null) {
        clearTimeout(deadline);
        deadline = null;
      }
    };

    const succeed = (boundPort) => {
      if (settled) return;
      settled = true;
      disarm();
      resolve(boundPort);
    };

    const fail = (reason) => {
      if (settled) return;
      settled = true;
      disarm();
      // Best effort, and deliberately NOT awaited: a listener that failed to
      // come up may still hold a handle that would keep the runner alive after
      // the failure, but waiting on a close that might itself never call back
      // would reintroduce the hang this helper exists to prevent.
      target.close(() => {});
      reject(new Error(`${context}: ${reason}`));
    };

    const onListening = () => {
      target.off('error', onError);
      const address = target.address();
      const boundPort = address === null || typeof address === 'string' ? 0 : address.port;
      if (boundPort <= 0) {
        // A listener that came up on no TCP port at all would make every
        // request in the case address nothing, and the first failure would be
        // an unhelpful connection error rather than this one.
        fail('came up without an ephemeral TCP port');
        return;
      }
      if (boundPort === 3000) {
        fail('bound the literal port 3000, which test/lifecycle.test.js owns');
        return;
      }
      succeed(boundPort);
    };

    const onError = (error) => {
      target.off('listening', onListening);
      // The error CODE and nothing else: enough to tell a refused bind from a
      // permissions failure, without putting a stack or a path into the
      // runner's output.
      fail(`listen failed with ${error.code ?? error.name}`);
    };

    target.once('listening', onListening);
    target.once('error', onError);

    deadline = setTimeout(() => {
      target.off('listening', onListening);
      target.off('error', onError);
      fail(`listen neither succeeded nor failed within ${LISTEN_DEADLINE_MS} ms`);
    }, LISTEN_DEADLINE_MS);

    target.listen(0, HOST);
  });
}

/**
 * Closes a listener and drops the connections that would otherwise hold it.
 *
 * `close` waits for every open connection to end, and this file's client keeps
 * its sockets alive on purpose, so without `closeAllConnections()` the callback
 * never arrives and the runner hangs at the end of the case instead of exiting.
 *
 * @param {import('node:http').Server} target The server to close.
 * @returns {Promise<void>} Settles when the listener is closed.
 */
async function closeServer(target) {
  const closed = new Promise((resolve) => target.close(resolve));
  target.closeAllConnections();
  await closed;
}

/**
 * Starts a SECOND server inside a case, on its own ephemeral port and its own
 * store, for the cases that must prepare state before a chain loads.
 *
 * @param {string} storePath The store the isolated chain should resolve.
 * @param {() => void} [prepare] Passed through to `freshModuleChain`.
 * @returns {Promise<{port: number, storePath: string, stop: () => Promise<void>}>}
 *   A handle whose `stop` must be registered with the case's own `t.after`.
 */
async function startIsolatedServer(storePath, prepare) {
  const chain = freshModuleChain(storePath, prepare);
  // Named by its case directory rather than by the store's absolute path: the
  // name is what identifies the failure, and the path would put the filesystem
  // layout into the runner's output for nothing.
  const isolatedPort = await listenOnEphemeralPort(
    chain.server,
    `the isolated server for "${path.basename(path.dirname(storePath))}"`
  );

  return {
    port: isolatedPort,
    storePath,
    async stop() {
      await closeServer(chain.server);
      // Put the variable back to what the RUNNING case's harness resolved, so a
      // second isolated chain built later in the same case starts from the
      // case's own store rather than from this one's. Between cases the value is
      // irrelevant — `beforeEach` sets it again — but leaving a stale path in
      // place would be a trap for the next chain built inside this case.
      process.env.ACTIVITY_STORE = harness === null ? LOAD_TIME_STORE_PATH : harness.storePath;
    },
  };
}

/**
 * Creates a fresh, empty directory under the temporary root.
 *
 * @param {string} name A short name identifying the case that owns it.
 * @returns {Promise<string>} The directory's absolute path.
 */
async function makeCaseDirectory(name) {
  const directory = path.join(TEMPORARY_ROOT, name);
  await fsp.mkdir(directory, { recursive: true });
  return directory;
}

/* ------------------------------------------------------------------------- *
 * Assertions
 *
 * The matrix says every error body is exactly `{ error, message }` with a fixed
 * sentence per code, no third key, and no echo of the offending Student ID. All
 * of that is asserted in one place so that no case can quietly settle for
 * matching a status alone.
 * ------------------------------------------------------------------------- */

/**
 * The fixed English sentence the matrix binds to each error code.
 *
 * The matrix does not merely require A message — it requires THE sentence for
 * that code: fixed, not free text, not interpolated, and carrying no internal
 * detail. Asserting only that some non-empty string arrived would pass on text
 * that changed release to release, on a sentence written for a different code,
 * and on text built from the submitted input the envelope is supposed never to
 * reflect. So every sentence is stated here and compared exactly.
 *
 * These are RESTATED from the code that owns them rather than imported from
 * it — `activities.js` exports only `handle`, and a test that read its
 * expectations out of the implementation would agree with the implementation
 * by construction, whatever the implementation said.
 *
 * One entry per code the feature can send, `internal_error` included: the
 * rejection boundary in `server.js` answers with the SAME two-key envelope as
 * every other failure, so the case that induces it goes through the shared
 * `assertErrorEnvelope` like the rest and needs its sentence recorded here.
 * That one sentence is restated from the frozen `500` body in `server.js`,
 * the code that owns it; every other sentence is restated from the failure
 * table in `activities.js`. Neither source is imported, for the reason above.
 */
const EXPECTED_MESSAGES = Object.freeze({
  malformed_json: 'The request body could not be parsed as JSON.',
  body_not_an_object: 'The request body must be a JSON object.',
  student_id_required: 'A Student ID is required.',
  student_id_malformed:
    'A Student ID must be the letter S followed by exactly three digits, for example S001.',
  activity_invalid:
    'An activity must be a label of 1 to 60 characters and must not contain control characters.',
  cross_origin_submission:
    "A submission must be sent from this service's own form, not from another origin.",
  student_not_found: 'No student exists with that Student ID.',
  not_found: 'That resource does not exist.',
  method_not_allowed: 'That method is not allowed for this resource.',
  payload_too_large: 'The request body is larger than the 8192-byte limit.',
  unsupported_media_type:
    'A submission must be sent as application/x-www-form-urlencoded or application/json.',
  reference_data_unavailable: 'The student reference data could not be read.',
  store_unreadable: 'The activity store could not be read.',
  store_write_failed: 'The activity could not be saved.',
  internal_error:
    'The request could not be completed because of an unexpected internal error.',
});

/**
 * The sentence bound to one code, or a failed assertion naming the code that
 * has none.
 *
 * A code with no recorded sentence is a hole in the expectation rather than a
 * detail to skip: falling back to "any string" for an unmapped code would
 * reintroduce exactly the weakness this map exists to remove.
 *
 * @param {string} expectedCode The error code the matrix specifies.
 * @param {string} context The case name, for the failure message.
 * @returns {string} The fixed sentence for that code.
 */
function expectedMessageFor(expectedCode, context) {
  const message = EXPECTED_MESSAGES[expectedCode];
  assert.ok(
    message !== undefined,
    `${context}: no fixed sentence is recorded for the code ${JSON.stringify(expectedCode)} — add it here from the failure table in activities.js`
  );
  return message;
}

/** The five characters the page escapes, and what each becomes. */
const HTML_ENTITIES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/**
 * Escapes text the way the page does, so an expectation can be stated in plain
 * words and compared against the markup as served.
 *
 * Exactly one of the fixed sentences carries one of these characters today —
 * the apostrophe in `cross_origin_submission` — which is exactly why the
 * escaping is applied by the helper rather than baked into the map: a
 * sentence that gains an `&` or an apostrophe keeps its expectation correct
 * instead of turning into a false failure.
 *
 * @param {string} value The text to escape.
 * @returns {string} The escaped text.
 */
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

/**
 * A `<script>` open or close tag in ANY casing, with any whitespace after the
 * `<`.
 *
 * HTML tag names are case-insensitive, so `<SCRIPT>`, `<ScRiPt>` and
 * `< script>` all execute exactly as `<script>` does. A case-sensitive
 * substring check for `'<script'` misses every one of them, which would let a
 * genuine injection regression pass as clean.
 */
const SCRIPT_ELEMENT = /<\s*\/?\s*script/i;

/**
 * Substrings that would mean a response leaked something internal.
 *
 * Chosen against the actual fixed sentences rather than by reflex: a forward
 * slash is NOT banned, because `unsupported_media_type` legitimately names
 * `application/x-www-form-urlencoded` and `application/json`. What is banned is
 * a Windows path separator, a source file name, any of the store's or reader's
 * internal error codes, an errno, and the shapes a stack trace takes.
 */
const INTERNAL_DETAIL_MARKERS = Object.freeze([
  '\\',
  '.js',
  'E_STORE',
  'E_REFERENCE',
  'E_LABEL',
  'E_XLSX',
  'E_BODY',
  'ENOENT',
  'EISDIR',
  'EACCES',
  'EPERM',
  'Error:',
  ' at ',
  TEMPORARY_ROOT,
  process.cwd(),
]);

/**
 * Names a marker without reproducing it, where reproducing it would itself
 * publish the detail this file is trying to keep out of its output.
 *
 * Two of the markers above are live filesystem paths, so a failure message
 * quoting the marker verbatim would print the path regardless of what the
 * response contained. Every other entry is a fixed, harmless token that is
 * clearer quoted than described.
 */
const MARKER_DESCRIPTIONS = new Map([
  [TEMPORARY_ROOT, 'the temporary root path'],
  [process.cwd(), 'the working directory path'],
]);

/**
 * @param {string} marker One entry from `INTERNAL_DETAIL_MARKERS`.
 * @returns {string} A description safe to print.
 */
function describeMarker(marker) {
  return MARKER_DESCRIPTIONS.get(marker) ?? JSON.stringify(marker);
}

/**
 * Identifies a response body without reproducing a byte of it.
 *
 * A DETECTOR FOR LEAKED DETAIL MUST NOT PUBLISH THE LEAK IT FOUND. Test output
 * is durable — the runner prints it, the JUnit reporter writes it to a file, and
 * a retained failure artifact carries it onward — so a message that pasted the
 * offending body in whole would hand every one of those the stack trace,
 * filesystem path or store value that made the assertion fail in the first
 * place. The byte length plus a truncated digest is enough to tell two failing
 * responses apart, to recognize the same failure across runs, and to confirm a
 * fix changed the body, while carrying none of its content.
 *
 * @param {string} body The body to summarize.
 * @returns {string} A safe, bounded description of the body.
 */
function bodyFingerprint(body) {
  const digest = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  return `${Buffer.byteLength(body)} bytes, sha256:${digest.slice(0, 12)}`;
}

/**
 * Asserts a response body carries no stack trace, filesystem path or other
 * internal detail.
 *
 * @param {string} body The body to inspect.
 * @param {string} context The case name, for the failure message.
 * @returns {void}
 */
function assertNoInternalDetail(body, context) {
  for (const marker of INTERNAL_DETAIL_MARKERS) {
    // Guarded rather than asserted, so the failure message — and the digest it
    // carries — is built only for a body that actually failed.
    if (!body.includes(marker)) continue;
    assert.fail(
      `${context}: the response must not leak internal detail, but it contains ${describeMarker(marker)} (${bodyFingerprint(body)})`
    );
  }
}

/**
 * Asserts the JSON content type and returns the parsed body.
 *
 * @param {object} response A response from `request`.
 * @param {string} context The case name.
 * @returns {object} The parsed payload.
 */
function parseJsonResponse(response, context) {
  assert.strictEqual(
    response.headers['content-type'],
    CONTENT_TYPE_JSON,
    `${context}: expected the JSON content type with its charset`
  );
  try {
    return JSON.parse(response.body);
  } catch (error) {
    // Neither the body nor the parser's own message: `JSON.parse` quotes the
    // offending input back at you, so re-emitting its message would leak the
    // body through the back door. The error's NAME, the status and the
    // fingerprint identify the response without publishing it.
    return assert.fail(
      `${context}: body was not valid JSON (${error.name}) — status ${response.status}, ${bodyFingerprint(response.body)}`
    );
  }
}

/**
 * Asserts the full error envelope: status, JSON content type, exactly the two
 * keys, the code, the FIXED sentence bound to that code, and no leaked
 * internal detail.
 *
 * @param {object} response A response from `request`.
 * @param {number} expectedStatus The status the matrix specifies.
 * @param {string} expectedCode The error code the matrix specifies.
 * @param {string} context The case name.
 * @returns {object} The parsed payload.
 */
function assertErrorEnvelope(response, expectedStatus, expectedCode, context) {
  assert.strictEqual(response.status, expectedStatus, `${context}: status`);
  const payload = parseJsonResponse(response, context);

  assert.deepStrictEqual(
    Object.keys(payload).sort(),
    ['error', 'message'],
    `${context}: the envelope must carry exactly "error" and "message" — no third key, and no echo of the submitted Student ID`
  );
  assert.strictEqual(payload.error, expectedCode, `${context}: error code`);
  assert.strictEqual(typeof payload.message, 'string', `${context}: message is a string`);
  // The exact sentence, not merely a non-empty one. Truthiness would accept
  // text that drifted, text belonging to another code, and text assembled from
  // the submitted input — the three things "a fixed sentence per code" rules
  // out and the only three a reader of this envelope has no way to detect.
  assert.strictEqual(
    payload.message,
    expectedMessageFor(expectedCode, context),
    `${context}: the message must be the fixed sentence bound to ${expectedCode}`
  );
  assertNoInternalDetail(response.body, context);

  return payload;
}

/**
 * Asserts a success envelope: status, JSON content type, exactly the two
 * top-level keys, and the `created` flag.
 *
 * Used for EVERY JSON success outcome rather than the `201` alone. The `200`
 * branches — a repeat of a submission and a label already on the student
 * record — are the ones a third key would most plausibly appear on, since both
 * describe something that did NOT happen and invite an explanatory field the
 * matrix does not define.
 *
 * @param {object} response A response from `request`.
 * @param {number} expectedStatus `201` for a created record, `200` for one
 *   already on record.
 * @param {boolean} expectedCreated The `created` flag the matrix specifies.
 * @param {string} context The case name.
 * @returns {object} The parsed payload.
 */
function assertSuccessEnvelope(response, expectedStatus, expectedCreated, context) {
  assert.strictEqual(response.status, expectedStatus, `${context}: status`);
  const payload = parseJsonResponse(response, context);

  assert.deepStrictEqual(
    Object.keys(payload).sort(),
    ['created', 'record'],
    `${context}: the success envelope must carry exactly "created" and "record" — no third key`
  );
  assert.strictEqual(
    payload.created,
    expectedCreated,
    `${context}: created is ${expectedCreated}`
  );

  return payload;
}

/**
 * Asserts an HTML response: status, the content type WITH its charset, a real
 * document, and no client-side script.
 *
 * @param {object} response A response from `request`.
 * @param {number} expectedStatus The expected status.
 * @param {string} context The case name.
 * @returns {string} The markup.
 */
function assertHtmlPage(response, expectedStatus, context) {
  assert.strictEqual(response.status, expectedStatus, `${context}: status`);
  assert.strictEqual(
    response.headers['content-type'],
    CONTENT_TYPE_HTML,
    `${context}: expected the HTML content type with its charset`
  );
  assert.ok(
    response.body.startsWith('<!DOCTYPE html>'),
    `${context}: expected a complete HTML document`
  );
  // Case-insensitive, because `<SCRIPT>` and `< script>` are the same element
  // to a browser as `<script>` is, and a substring check for the lowercase
  // spelling alone would clear a page carrying either.
  assert.ok(
    !SCRIPT_ELEMENT.test(response.body),
    `${context}: the page must carry no client-side script, in any casing`
  );
  return response.body;
}

/**
 * Asserts a form-mode validation failure: the HTML page, in its error state,
 * carrying the same fixed SENTENCE and the same code the JSON envelope would
 * have carried.
 *
 * "The same diagnosis in the same words" is the property worth pinning, and the
 * words are the load-bearing half of it: a page that printed only the machine
 * code would satisfy a code check while telling the person reading it nothing,
 * and a page that invented its own phrasing would give a submitter and a
 * script two descriptions to reconcile. The sentence comes from the same map
 * the JSON assertion uses, escaped as the page escapes every dynamic value.
 *
 * @param {object} response A response from `request`.
 * @param {number} expectedStatus The status the matrix specifies.
 * @param {string} expectedCode The error code the matrix specifies.
 * @param {string} context The case name.
 * @returns {string} The markup.
 */
function assertHtmlFailure(response, expectedStatus, expectedCode, context) {
  const markup = assertHtmlPage(response, expectedStatus, context);
  assert.ok(
    markup.includes(expectedCode),
    `${context}: the page must name the same code the API uses (${expectedCode})`
  );
  assert.ok(
    markup.includes(escapeHtml(expectedMessageFor(expectedCode, context))),
    `${context}: the page must carry the same fixed sentence the JSON envelope carries for ${expectedCode}`
  );
  assert.ok(
    markup.includes('class="error"'),
    `${context}: the page must be in its error state`
  );
  return markup;
}

/**
 * Asserts a value is a real ISO-8601 instant in UTC.
 *
 * @param {unknown} value The candidate timestamp.
 * @param {string} context The case name.
 * @returns {void}
 */
function assertIsoUtcInstant(value, context) {
  assert.strictEqual(typeof value, 'string', `${context}: submittedAt is a string`);
  assert.match(
    value,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/,
    `${context}: submittedAt is an ISO-8601 instant in UTC`
  );
  assert.ok(
    Number.isFinite(Date.parse(value)),
    `${context}: submittedAt names a real instant`
  );
}

/**
 * Asserts a record is a SUBMISSION: the four keys, the server-set source, and a
 * server-generated timestamp.
 *
 * @param {object} record The record as returned.
 * @param {string} studentId The expected Student ID.
 * @param {string} activity The expected stored label.
 * @param {string} context The case name.
 * @returns {void}
 */
function assertSubmissionRecord(record, studentId, activity, context) {
  assert.deepStrictEqual(
    Object.keys(record).sort(),
    ['activity', 'source', 'studentId', 'submittedAt'],
    `${context}: a submission record carries exactly studentId, activity, source and submittedAt`
  );
  assert.strictEqual(record.studentId, studentId, `${context}: studentId`);
  assert.strictEqual(record.activity, activity, `${context}: stored label`);
  assert.strictEqual(record.source, SOURCE_SUBMISSION, `${context}: server-set source`);
  assertIsoUtcInstant(record.submittedAt, context);
}

/**
 * Asserts a record is SEEDED: three keys only, and no `submittedAt` at all.
 *
 * The absence of the key is the point rather than a detail — a seeded label was
 * not submitted by anyone, so inventing a timestamp would fabricate provenance
 * and make an import indistinguishable from a real submission.
 *
 * @param {object} record The record as returned.
 * @param {string} studentId The expected Student ID.
 * @param {string} activity The expected label.
 * @param {string} context The case name.
 * @returns {void}
 */
function assertWorkbookRecord(record, studentId, activity, context) {
  assert.deepStrictEqual(
    Object.keys(record).sort(),
    ['activity', 'source', 'studentId'],
    `${context}: a seeded record carries exactly studentId, activity and source`
  );
  assert.strictEqual(record.studentId, studentId, `${context}: studentId`);
  assert.strictEqual(record.activity, activity, `${context}: seeded label`);
  assert.strictEqual(record.source, SOURCE_WORKBOOK, `${context}: seeded source`);
  assert.ok(
    !('submittedAt' in record),
    `${context}: a seeded record must carry NO submittedAt`
  );
}

/**
 * Finds one of a student's records by its label, case-insensitively.
 *
 * @param {Array<object>} records The records returned for a student.
 * @param {string} activity The label to find.
 * @returns {object|undefined} The record, or undefined.
 */
function findRecord(records, activity) {
  return records.find(
    (record) => record.activity.toLowerCase() === activity.toLowerCase()
  );
}

/**
 * Reads one student's activities back and asserts the envelope.
 *
 * @param {string} studentId The student to read.
 * @param {string} context The case name.
 * @param {{port?: number}} [options] Extras.
 * @returns {Promise<Array<object>>} The student's records.
 */
async function readActivities(studentId, context, options = {}) {
  const response = await get(`${NAMESPACE}/${studentId}`, options);
  assert.strictEqual(response.status, 200, `${context}: read-back status`);
  const payload = parseJsonResponse(response, context);
  assert.deepStrictEqual(
    Object.keys(payload).sort(),
    ['activities', 'studentId'],
    `${context}: the read envelope is exactly studentId and activities`
  );
  assert.strictEqual(payload.studentId, studentId, `${context}: read-back studentId`);
  assert.ok(Array.isArray(payload.activities), `${context}: activities is an array`);
  return payload.activities;
}

/**
 * Asserts the process is still serving after an induced failure.
 *
 * Every induced failure in this file is followed by one of these, because a
 * failure mode that kills the service must not be able to pass as handled.
 *
 * @param {string} context The case name.
 * @param {{target?: string, expectedStatus?: number, port?: number}} [options]
 *   The probe to issue. Defaults to reading a known student, which is the
 *   strongest probe; the store-broken cases probe the form route instead,
 *   because for them a store read is legitimately still failing.
 * @returns {Promise<object>} The probe's response.
 */
async function assertStillServing(context, options = {}) {
  const {
    target = `${NAMESPACE}/${KNOWN_STUDENT_ID}`,
    expectedStatus = 200,
    port: requestPort,
  } = options;

  const response = await request({ method: 'GET', target, port: requestPort });
  assert.strictEqual(
    response.status,
    expectedStatus,
    `${context}: the process must still be serving afterwards, but ${target} answered ${response.status}`
  );
  return response;
}

/* ------------------------------------------------------------------------- *
 * The per-case harness
 *
 * `beforeEach` at the top level of the file runs before EVERY leaf case,
 * recursively through every `describe` below it, and cases run strictly one at
 * a time. So one hook is enough to give all of them a store, a module chain and
 * a listener of their own, and no case has to ask for isolation to get it —
 * which is what keeps the isolation from decaying as cases are added.
 *
 * Rebuilding the chain per case is what makes the isolation real rather than
 * cosmetic: `activity-store.js` resolves its store path at load and caches the
 * workbook key set, the seed snapshot and its write mutex in module state, so a
 * case sharing that instance inherits every one of them. Measured at about
 * 1.6 ms per case on the pinned runtime — an eviction, four requires, a bind
 * and a close — against a file that runs in well under a second.
 * ------------------------------------------------------------------------- */

/** Numbers the case directories, so two cases with one name cannot collide. */
let caseSequence = 0;

/**
 * Turns a case name into a unique, filesystem-safe directory name, advancing
 * the sequence above as it goes.
 *
 * The name is carried into the path rather than being replaced by the counter
 * alone, because a store left behind by a failing case is only useful evidence
 * if its directory says which case wrote it. The counter is what makes it
 * unique, since two cases may legitimately share a name.
 *
 * @param {string} caseName The running case's name.
 * @returns {string} A unique directory name under the temporary root.
 */
function caseDirectoryName(caseName) {
  caseSequence += 1;
  const slug = caseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `case-${String(caseSequence).padStart(3, '0')}-${slug}`;
}

/**
 * Builds one case's harness: its own directory, store path, module chain and
 * listener on an ephemeral port.
 *
 * The store file itself is NOT created — an absent store is the first-use state
 * every case should start from, and a pre-created empty document would be a
 * valid one, which would suppress seeding and hide the workbook's labels.
 *
 * @param {string} caseName The running case's name.
 * @returns {Promise<{port: number, storePath: string,
 *   server: import('node:http').Server}>} The running case's harness.
 */
async function startCaseHarness(caseName) {
  const directory = await makeCaseDirectory(caseDirectoryName(caseName));
  const storePath = path.join(directory, 'activities.json');
  const chain = freshModuleChain(storePath);

  // The module-level bindings follow the ACTIVE chain. Without this the
  // `internal_error` cases would patch a module object no listening server
  // closes over, and would pass while proving nothing.
  activities = chain.activities;
  server = chain.server;

  const port = await listenOnEphemeralPort(server, `the harness for "${caseName}"`);
  return { port, storePath, server };
}

before(() => {
  // Asserted once, here, rather than per case: `mkdtempSync` fixed the root at
  // load and every case directory is created inside it, so one check covers
  // every artifact the file will write. Nothing this suite creates may land in
  // the checkout — a store written there would be an untracked file in a
  // repository whose ignore policy names only the two default store paths.
  const escape = path.relative(path.join(__dirname, '..'), TEMPORARY_ROOT);
  assert.ok(
    escape.startsWith('..') || path.isAbsolute(escape),
    'every artifact this suite writes must live outside the checkout'
  );
});

beforeEach(async (t) => {
  harness = await startCaseHarness(t.name);
});

afterEach(async () => {
  const finished = harness;
  // Cleared BEFORE the close is awaited, so a helper called after the case has
  // ended fails on `activePort` rather than addressing a closing listener.
  harness = null;
  if (finished !== null) {
    await closeServer(finished.server);
  }
  process.env.ACTIVITY_STORE = LOAD_TIME_STORE_PATH;
});

after(async () => {
  // Every listener was closed by `afterEach` and the load-time chain never
  // bound one, so all that is left is the client's own socket pool: an idle
  // pooled socket holds the event loop open, and the runner would sit there
  // instead of exiting on its own.
  agent.destroy();
  await fsp.rm(TEMPORARY_ROOT, { recursive: true, force: true });
});


/* ========================================================================= *
 * GET /activities — the submission form
 *
 * This is the project's first user interface, so the assertions go past
 * "something HTML came back": the charset, the semantic structure that carries
 * the whole accessibility burden in the absence of any design system, the two
 * browser conveniences, and the absence of any script or external asset.
 * ========================================================================= */

describe('GET /activities — the submission form', () => {
  it('returns 200 with the HTML content type and its charset', async () => {
    const context = 'GET /activities';
    const response = await get(NAMESPACE);

    assertHtmlPage(response, 200, context);
    // The charset is the point of this assertion. The preserved plaintext
    // response deliberately carries none, so a feature response that also
    // omitted it would be indistinguishable from the legacy path's header.
    assert.strictEqual(response.headers['content-type'], CONTENT_TYPE_HTML, `${context}: charset present`);
  });

  it('serves a real form that posts natively to the namespace', async () => {
    const context = 'GET /activities form element';
    const markup = assertHtmlPage(await get(NAMESPACE), 200, context);

    assert.ok(markup.includes('<form method="post"'), `${context}: a real <form method="post">`);
    assert.ok(
      markup.includes(`action="${NAMESPACE}"`),
      `${context}: the form posts to the namespace it was served from`
    );
    assert.ok(
      markup.includes('<button type="submit">'),
      `${context}: a real submit button, not a <div> standing in for a control`
    );
  });

  it('serves a labelled input for each field, bound by for and id', async () => {
    const context = 'GET /activities labelling';
    const markup = assertHtmlPage(await get(NAMESPACE), 200, context);

    // Every `for` must name an `id` that exists, which is what makes the label
    // actually announce the control rather than merely sit beside it.
    for (const [inputId, fieldName] of [
      ['student-id', 'studentId'],
      ['activity', 'activity'],
    ]) {
      assert.ok(markup.includes(`id="${inputId}"`), `${context}: an input with id="${inputId}"`);
      assert.ok(markup.includes(`name="${fieldName}"`), `${context}: that input posts as ${fieldName}`);
      assert.ok(
        markup.includes(`<label for="${inputId}">`),
        `${context}: a <label for="${inputId}"> bound to it`
      );
    }
  });

  it('serves a document with lang, a charset meta and exactly one h1', async () => {
    const context = 'GET /activities document structure';
    const markup = assertHtmlPage(await get(NAMESPACE), 200, context);

    assert.ok(markup.includes('<html lang="en">'), `${context}: the root element declares its language`);
    assert.ok(markup.includes('<meta charset="utf-8">'), `${context}: a charset meta element`);

    const headings = markup.match(/<h1[\s>]/g) ?? [];
    assert.strictEqual(headings.length, 1, `${context}: exactly one <h1>, not ${headings.length}`);
  });

  it('serves the browser conveniences pattern and maxlength', async () => {
    const context = 'GET /activities browser conveniences';
    const markup = assertHtmlPage(await get(NAMESPACE), 200, context);

    // Conveniences only: the server-side validation is authoritative, and the
    // validation cases below prove it by submitting values these would refuse.
    assert.ok(markup.includes('pattern="S[0-9]{3}"'), `${context}: the Student ID pattern hint`);
    assert.ok(markup.includes('maxlength="60"'), `${context}: the activity length hint`);
  });

  it('serves no client-side script and no external asset reference', async () => {
    const context = 'GET /activities has no script or asset';
    const markup = assertHtmlPage(await get(NAMESPACE), 200, context);

    // The form posts natively, which is exactly why its default encoding and
    // the endpoint's accepted media type are the same thing. And the flat
    // repository root gains no static asset: the page is a template literal, so
    // there is nothing to fetch.
    //
    // Every pattern is case-insensitive: HTML element and attribute names are,
    // so `<LINK>` and `SRC=` would fetch exactly as their lowercase spellings
    // do while sailing past a lowercase substring check.
    for (const [description, pattern] of [
      ['a script element', SCRIPT_ELEMENT],
      ['a link element', /<\s*link/i],
      ['an asset-fetching src attribute', /\bsrc\s*=/i],
      ['a CSS @import', /@import/i],
      ['a CSS url() reference', /url\s*\(/i],
    ]) {
      assert.ok(
        !pattern.test(markup),
        `${context}: the page must not contain ${description} (${pattern})`
      );
    }
  });

  it('treats /activities/ with a trailing slash as the same route', async () => {
    const context = 'GET /activities/ (trailing slash)';
    const response = await get(`${NAMESPACE}/`);

    const markup = assertHtmlPage(response, 200, context);
    assert.ok(markup.includes('<form method="post"'), `${context}: the same form, not a sub-resource`);
  });

  it('excludes the query string before matching, so /activities?x=1 is the form', async () => {
    const context = 'GET /activities?x=1';
    const response = await get(`${NAMESPACE}?x=1`);

    // A `startsWith` against the raw request target would read this as a
    // sub-resource named "?x=1" and answer 400 or 404 instead of the form.
    const markup = assertHtmlPage(response, 200, context);
    assert.ok(markup.includes('<form method="post"'), `${context}: the query string is not a path segment`);
  });
});


/* ========================================================================= *
 * The rendered page — its inventory, its stylesheet, and its error wiring
 *
 * The page is specified down to its contents and its literal style values, so
 * these cases pin it as those things rather than as "some markup came back".
 * Three properties, each of which a well-meaning edit breaks silently:
 *
 *   The INVENTORY is a heading, two labelled fields, a submit button, and the
 *   outcome text of whichever state is being rendered. Prose beyond that is
 *   content nobody asked for, and it is invisible in a diff review once the
 *   page has grown to a hundred lines.
 *
 *   The STYLESHEET is a fixed list of sixteen declarations resolving to six
 *   colours, and every value in it is authorized individually. A shorthand is
 *   the easy way to introduce a literal nobody approved — `border` smuggles in
 *   a width and a style keyword alongside the one colour that was specified —
 *   so the declarations are compared as a LIST rather than merely counted.
 *
 *   The ERROR WIRING must connect the reason to the field. `aria-invalid` on
 *   its own says only THAT a field is wrong; a screen-reader user who tabs
 *   straight to it then hears "invalid" and no reason, because the sentence
 *   explaining it sits above the form and is never announced with the control.
 * ========================================================================= */

describe('the rendered page — inventory, stylesheet and error association', () => {
  /** The sixteen authorized declarations, in the order the page emits them. */
  const AUTHORIZED_DECLARATIONS = Object.freeze([
    ['font-family', 'system-ui, sans-serif'],
    ['color', '#1a1a1a'],
    ['background-color', '#ffffff'],
    ['max-width', '32rem'],
    ['margin', '2rem auto'],
    ['padding', '0 1rem'],
    ['margin-bottom', '0.25rem'],
    ['width', '100%'],
    ['padding', '0.5rem'],
    ['border-color', '#767676'],
    ['background-color', '#1a4f8b'],
    ['color', '#ffffff'],
    ['padding', '0.5rem 1rem'],
    ['border-radius', '4px'],
    ['color', '#b3261e'],
    ['color', '#146c2e'],
  ]);

  /**
   * The page's single inline stylesheet.
   *
   * @param {string} markup A served page.
   * @param {string} context The case name.
   * @returns {string} The text between the one `<style>` pair.
   */
  function styleBlockOf(markup, context) {
    const blocks = markup.match(/<style>([\s\S]*?)<\/style>/g) ?? [];
    assert.strictEqual(
      blocks.length,
      1,
      `${context}: exactly one inline <style> block, so a later migration to tokens has one site to change`
    );
    return blocks[0];
  }

  /**
   * Every `property: value` pair in a stylesheet, in source order.
   *
   * @param {string} styleBlock The stylesheet text.
   * @returns {Array<[string, string]>} The declarations.
   */
  function declarationsOf(styleBlock) {
    return [...styleBlock.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map(([, property, value]) => [
      property,
      value.trim(),
    ]);
  }

  it('places nothing between the heading and the form on the empty page', async () => {
    const context = 'GET /activities page inventory';
    const markup = assertHtmlPage(await get(NAMESPACE), 200, context);

    // Asserted as adjacency rather than as the absence of one sentence: any
    // prose added between the two would break this, whatever it said.
    assert.ok(
      markup.includes('<h1>Add an extracurricular activity</h1>\n    <form method="post"'),
      `${context}: the form follows the heading directly, with no instructional prose between them`
    );

    // Three paragraphs, each wrapping a control group. The page carries no
    // standalone paragraph of its own until a state supplies outcome text.
    const paragraphs = markup.match(/<p[\s>]/g) ?? [];
    assert.strictEqual(
      paragraphs.length,
      3,
      `${context}: exactly three <p> elements — the two fields and the button — not ${paragraphs.length}`
    );
  });

  it('adds exactly one paragraph, the outcome text, when a state has something to say', async () => {
    const context = 'POST /activities form-encoded failure page inventory';
    const markup = assertHtmlFailure(
      await postForm('S0012', 'Chess Club'),
      400,
      'student_id_malformed',
      context
    );

    const paragraphs = markup.match(/<p[\s>]/g) ?? [];
    assert.strictEqual(
      paragraphs.length,
      4,
      `${context}: the three control groups plus the message, and nothing else`
    );
  });

  it('serves exactly the sixteen authorized declarations, in order', async () => {
    const context = 'GET /activities stylesheet';
    const markup = assertHtmlPage(await get(NAMESPACE), 200, context);

    assert.deepStrictEqual(
      declarationsOf(styleBlockOf(markup, context)),
      AUTHORIZED_DECLARATIONS.map((pair) => [...pair]),
      `${context}: every declaration and every value is authorized individually, so an extra property or an unlisted literal is a deviation`
    );
  });

  it('resolves to exactly six unique colours', async () => {
    const context = 'GET /activities stylesheet colours';
    const markup = assertHtmlPage(await get(NAMESPACE), 200, context);
    const styleBlock = styleBlockOf(markup, context);

    const colours = new Set(styleBlock.match(/#[0-9a-f]{3,8}/g) ?? []);
    assert.deepStrictEqual(
      [...colours].sort(),
      ['#146c2e', '#1a1a1a', '#1a4f8b', '#767676', '#b3261e', '#ffffff'],
      `${context}: six unique colours, with #ffffff serving both the page background and the button text`
    );
  });

  it('styles the input border with the authorized colour and no shorthand literals', async () => {
    const context = 'GET /activities input border';
    const styleBlock = styleBlockOf(assertHtmlPage(await get(NAMESPACE), 200, context), context);

    // The inventory authorizes one value for this border: the colour. A
    // shorthand would add a width and a style keyword that nothing authorized.
    assert.ok(
      styleBlock.includes('border-color: #767676;'),
      `${context}: the border is declared as its authorized colour`
    );
    for (const unauthorized of ['border:', '1px', 'solid']) {
      assert.ok(
        !styleBlock.includes(unauthorized),
        `${context}: the stylesheet must not contain the unauthorized literal ${JSON.stringify(unauthorized)}`
      );
    }
  });

  it('binds the invalid field to the message that explains it', async () => {
    const context = 'POST /activities form-encoded failure association';
    const markup = assertHtmlFailure(
      await postForm('S0012', 'Chess Club'),
      400,
      'student_id_malformed',
      context
    );

    const described = markup.match(/aria-describedby="([^"]+)"/g) ?? [];
    assert.strictEqual(
      described.length,
      1,
      `${context}: exactly the offending field is described — pointing every input at the same message would announce a Student ID error while the activity field was focused`
    );

    const messageId = /aria-describedby="([^"]+)"/.exec(markup)[1];
    assert.ok(
      markup.includes(`<p id="${messageId}" class="error">`),
      `${context}: the reference resolves to the error message element, so the reason is announced with the control`
    );
    assert.ok(
      new RegExp(`name="studentId"[^>]*aria-invalid="true"[^>]*aria-describedby="${messageId}"`).test(
        markup
      ),
      `${context}: the Student ID input carries both the flag and the reference`
    );
    assert.ok(
      !/name="activity"[^>]*aria-(invalid|describedby)/.test(markup),
      `${context}: the field that was fine carries neither attribute`
    );
  });

  it('leaves no dangling aria reference in any page state', async () => {
    const context = 'aria references resolve in every state';

    const states = [
      ['the empty form', assertHtmlPage(await get(NAMESPACE), 200, context)],
      [
        'the confirmation page',
        assertHtmlPage(await postForm('S004', 'Aria Wiring Club'), 201, context),
      ],
      [
        'the failure page',
        assertHtmlFailure(await postForm('S0012', 'Chess Club'), 400, 'student_id_malformed', context),
      ],
    ];

    for (const [state, markup] of states) {
      for (const [, referenced] of markup.matchAll(/aria-describedby="([^"]+)"/g)) {
        assert.ok(
          markup.includes(`id="${referenced}"`),
          `${context}: ${state} references ${referenced}, which must exist on the page`
        );
      }
      // Nothing is invalid on a success page, so nothing may claim to be.
      if (state !== 'the failure page') {
        assert.ok(
          !markup.includes('aria-invalid'),
          `${context}: ${state} flags no field as invalid`
        );
      }
    }
  });
});


/* ========================================================================= *
 * POST /activities — the success paths
 *
 * These cases WRITE, so each performs every step of its own flow rather than
 * relying on a predecessor — and each runs against a store of its own, created
 * absent by the per-case harness, so nothing carries over between cases or
 * between runs. The distinct labels below are for legibility now rather than
 * for isolation; the harness owns that.
 * ========================================================================= */

describe('POST /activities — accepting a submission', () => {
  it('records a new activity with 201, a Location header and a submission record', async () => {
    const context = 'POST /activities new activity';
    const response = await postJson({ studentId: KNOWN_STUDENT_ID, activity: 'Chess Club' });

    assert.strictEqual(response.status, 201, `${context}: a new activity is created`);
    assert.strictEqual(
      response.headers.location,
      `${NAMESPACE}/${KNOWN_STUDENT_ID}`,
      `${context}: Location names the student's collection`
    );

    const payload = assertSuccessEnvelope(response, 201, true, context);
    assertSubmissionRecord(payload.record, KNOWN_STUDENT_ID, 'Chess Club', context);
  });

  it('answers a repeat submission 200 with created false and the ORIGINAL submittedAt', async () => {
    const context = 'POST /activities repeat submission';
    const label = 'Fencing Club';

    const first = await postJson({ studentId: KNOWN_STUDENT_ID, activity: label });
    assert.strictEqual(first.status, 201, `${context}: the first submission creates`);
    const originalTimestamp = parseJsonResponse(first, context).record.submittedAt;
    assertIsoUtcInstant(originalTimestamp, context);

    const repeat = await postJson({ studentId: KNOWN_STUDENT_ID, activity: label });
    assert.strictEqual(
      repeat.headers.location,
      undefined,
      `${context}: Location is sent only with the 201`
    );

    // The same exact-key envelope the 201 gets: this branch reports something
    // that did NOT happen, which is where an extra explanatory field would
    // most plausibly appear.
    const payload = assertSuccessEnvelope(repeat, 200, false, `${context}: a repeat is 200, not 201`);
    assertSubmissionRecord(payload.record, KNOWN_STUDENT_ID, label, context);
    // The exact original instant, not merely some timestamp: a re-stamped
    // record would mean the store had been rewritten on a no-op submission.
    assert.strictEqual(
      payload.record.submittedAt,
      originalTimestamp,
      `${context}: the record keeps its original submittedAt`
    );
  });

  it('deduplicates case-insensitively and adds nothing for a case variant', async () => {
    const context = 'POST /activities case variant';
    const stored = 'Sailing Club';

    const created = await postJson({ studentId: KNOWN_STUDENT_ID, activity: stored });
    assert.strictEqual(created.status, 201, `${context}: the original casing creates`);

    const variant = await postJson({ studentId: KNOWN_STUDENT_ID, activity: 'sailing club' });

    const payload = assertSuccessEnvelope(
      variant,
      200,
      false,
      `${context}: a case variant is recognized, not appended`
    );
    assert.strictEqual(
      payload.record.activity,
      stored,
      `${context}: the STORED casing is returned, not the submitted variant`
    );

    const records = await readActivities(KNOWN_STUDENT_ID, context);
    const matches = records.filter((record) => record.activity.toLowerCase() === 'sailing club');
    assert.strictEqual(matches.length, 1, `${context}: exactly one record exists for that activity`);
  });

  it('answers a submission matching a seeded label 200 with source workbook and no submittedAt', async () => {
    const context = 'POST /activities seeded label';
    const seeded = SEEDED_LABELS[KNOWN_STUDENT_ID];

    const response = await postJson({ studentId: KNOWN_STUDENT_ID, activity: seeded });

    const payload = assertSuccessEnvelope(
      response,
      200,
      false,
      `${context}: nothing is added for a label already on record`
    );
    // An import must stay distinguishable from a submission: a label sitting in
    // a spreadsheet was not necessarily submitted by anyone, so no timestamp is
    // invented for it.
    assertWorkbookRecord(payload.record, KNOWN_STUDENT_ID, seeded, context);
  });

  it('answers a form-encoded submission with the HTML confirmation page, not JSON', async () => {
    const context = 'POST /activities form mode';
    const response = await postForm('S002', 'Chess Club');

    const markup = assertHtmlPage(response, 201, context);
    assert.strictEqual(
      response.headers.location,
      `${NAMESPACE}/S002`,
      `${context}: the 201 carries Location in form mode too`
    );
    // The success state restates what was recorded, so a submitter sees the
    // label as it was stored rather than having to trust that it was.
    assert.ok(markup.includes('Chess Club'), `${context}: the page restates the activity`);
    assert.ok(markup.includes('S002'), `${context}: the page restates the Student ID`);
  });

  it('answers a form-encoded repeat with the HTML already-recorded page at 200', async () => {
    const context = 'POST /activities form mode repeat';
    const label = 'Archery Club';

    const first = await postForm('S002', label);
    const firstMarkup = assertHtmlPage(first, 201, `${context} (first)`);
    // Captured so the repeat can be told apart from it rather than merely
    // shown to mention the label, which both pages do.
    assert.ok(
      firstMarkup.includes(`Recorded ${label} for S002.`),
      `${context}: the 201 confirms that the activity WAS recorded`
    );

    const repeat = await postForm('S002', label);
    const markup = assertHtmlPage(repeat, 200, context);

    // Only a 201 may carry Location. A 200 created nothing, so a Location
    // pointing at the student's collection would be announcing a resource this
    // request did not bring into existence.
    assert.strictEqual(
      repeat.headers.location,
      undefined,
      `${context}: Location is sent only with the 201, never with the already-recorded 200`
    );

    // The page must SAY that the activity already existed and that nothing was
    // added. Asserting only that the label appears would pass on the 201
    // confirmation, on the empty form with the value pre-filled, and on any
    // page that happened to mention it — none of which tells the submitter
    // what became of their submission.
    assert.ok(
      markup.includes(`${label} was already submitted for S002, so nothing was added.`),
      `${context}: the page states the activity was already submitted and nothing was added`
    );
    assert.ok(
      !markup.includes(`Recorded ${label} for S002.`),
      `${context}: and it is NOT the 201 confirmation wording`
    );
  });

  it('ignores a client-supplied source and submittedAt, setting both on the server', async () => {
    const context = 'POST /activities server-set fields';
    const label = 'Origami Club';
    const forgedTimestamp = '1999-01-01T00:00:00Z';

    const before = Date.now();
    const response = await postJson({
      studentId: 'S004',
      activity: label,
      source: SOURCE_WORKBOOK,
      submittedAt: forgedTimestamp,
    });
    const after = Date.now();

    const record = assertSuccessEnvelope(
      response,
      201,
      true,
      `${context}: the submission is accepted`
    ).record;

    // Provenance cannot be forged from the request body: both fields are set by
    // the server, so a submitted `source` of "workbook" must not turn a real
    // submission into something that looks like an import.
    assertSubmissionRecord(record, 'S004', label, context);
    assert.notStrictEqual(
      record.submittedAt,
      forgedTimestamp,
      `${context}: the client's submittedAt must not be honoured`
    );

    const stamped = Date.parse(record.submittedAt);
    assert.ok(
      stamped >= before - 1000 && stamped <= after + 1000,
      `${context}: the server generated the timestamp itself (${record.submittedAt})`
    );

    const persisted = findRecord(await readActivities('S004', context), label);
    assert.ok(persisted !== undefined, `${context}: the record was persisted`);

    // What was WRITTEN is asserted in full, not just what was answered. A
    // response carrying a clean record while the forged values went to disk
    // would pass every assertion above: the store is the lasting artifact, so
    // the forgery has to be shown absent from IT.
    assertSubmissionRecord(persisted, 'S004', label, `${context} (persisted)`);
    assert.strictEqual(
      persisted.source,
      SOURCE_SUBMISSION,
      `${context}: what was STORED carries the server's source, not the client's`
    );
    assert.strictEqual(
      persisted.submittedAt,
      record.submittedAt,
      `${context}: the stored timestamp is the same server-generated instant that was returned`
    );
    assert.notStrictEqual(
      persisted.submittedAt,
      forgedTimestamp,
      `${context}: the client's submittedAt reached neither the response nor the store`
    );
  });
});

/* ========================================================================= *
 * Media-type normalization
 *
 * The header is split at the first `;`, trimmed and lowercased before
 * comparison. A browser form sends a charset parameter, so a comparison against
 * the raw header would reject the very client this feature exists for.
 * ========================================================================= */

describe('POST /activities — media-type normalization', () => {
  for (const [spelling, label] of [
    ['application/json', 'Alpha Club'],
    ['Application/JSON', 'Beta Club'],
    ['application/json; charset=utf-8', 'Gamma Club'],
  ]) {
    it(`accepts JSON sent as ${JSON.stringify(spelling)}`, async () => {
      const context = `POST /activities with Content-Type ${spelling}`;
      const response = await postJson(
        { studentId: 'S006', activity: label },
        { contentType: spelling }
      );

      const payload = assertSuccessEnvelope(response, 201, true, `${context}: accepted as JSON`);
      assertSubmissionRecord(payload.record, 'S006', label, context);
    });
  }

  for (const [spelling, label] of [
    ['application/x-www-form-urlencoded', 'Delta Club'],
    ['Application/X-WWW-Form-Urlencoded', 'Epsilon Club'],
    ['application/x-www-form-urlencoded; charset=UTF-8', 'Zeta Club'],
  ]) {
    it(`accepts a form body sent as ${JSON.stringify(spelling)}`, async () => {
      const context = `POST /activities with Content-Type ${spelling}`;
      const response = await postForm('S006', label, { contentType: spelling });

      // Accepted AND recognized as form mode, which is what the HTML response
      // proves — a spelling that fell through to JSON mode would answer 400.
      const markup = assertHtmlPage(response, 201, context);
      assert.ok(markup.includes(label), `${context}: the confirmation names the activity`);
    });
  }
});


/* ========================================================================= *
 * The response mode follows the REQUEST media type, never `Accept`
 *
 * Negotiation on the request's own `Content-Type` is what makes the mode
 * deterministic: the form gets a page because it POSTS a form, and a script
 * gets JSON because it POSTS JSON, whatever either of them happens to send in
 * `Accept`. The read route proves the rule for a request with no body; these
 * two prove it for the route that has one, in both directions — which is the
 * only way to tell a `Content-Type` decision from an `Accept` decision that
 * merely agrees with it in the common case.
 * ========================================================================= */

describe('POST /activities — the response mode ignores Accept', () => {
  it('answers a form-encoded submission with HTML even when Accept asks for JSON', async () => {
    const context = 'POST /activities form body with Accept: application/json';
    const label = 'Orienteering Club';
    const response = await request({
      method: 'POST',
      target: NAMESPACE,
      headers: { 'Content-Type': MEDIA_TYPE_FORM, Accept: MEDIA_TYPE_JSON },
      body: new URLSearchParams({ studentId: 'S009', activity: label }).toString(),
    });

    // An implementation honouring `Accept` would answer this one in JSON,
    // which is precisely the browser case it would break: a form post carries
    // whatever `Accept` the browser chose, and the submitter needs the page.
    const markup = assertHtmlPage(response, 201, context);
    assert.ok(markup.includes(label), `${context}: the confirmation page names the activity`);
    assert.strictEqual(
      response.headers.location,
      `${NAMESPACE}/S009`,
      `${context}: the 201 still carries Location`
    );
  });

  it('answers a JSON submission with JSON even when Accept asks for HTML', async () => {
    const context = 'POST /activities JSON body with an HTML Accept header';
    const label = 'Bouldering Club';
    const response = await request({
      method: 'POST',
      target: NAMESPACE,
      headers: {
        'Content-Type': MEDIA_TYPE_JSON,
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      body: JSON.stringify({ studentId: 'S009', activity: label }),
    });

    const payload = assertSuccessEnvelope(response, 201, true, context);
    assertSubmissionRecord(payload.record, 'S009', label, context);
    assert.ok(!response.body.includes('<!DOCTYPE'), `${context}: no document was rendered`);
  });
});


/* ========================================================================= *
 * GET /activities/{studentId} — reading one student's activities
 *
 * JSON only. This route has no form to re-display, so it never renders HTML in
 * either request mode, and negotiation is on the REQUEST media type rather than
 * on `Accept` — which a `GET` with no body simply does not carry.
 * ========================================================================= */

describe('GET /activities/{studentId} — reading activities back', () => {
  it('returns 200 with the studentId and activities envelope in JSON', async () => {
    const context = 'GET /activities/S001';
    const response = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}`);

    assert.strictEqual(response.status, 200, `${context}: status`);
    const payload = parseJsonResponse(response, context);
    assert.deepStrictEqual(
      Object.keys(payload).sort(),
      ['activities', 'studentId'],
      `${context}: the envelope is exactly studentId and activities`
    );
    assert.strictEqual(payload.studentId, KNOWN_STUDENT_ID, `${context}: the addressed student`);
    assert.ok(Array.isArray(payload.activities), `${context}: activities is an array`);
    for (const record of payload.activities) {
      assert.strictEqual(record.studentId, KNOWN_STUDENT_ID, `${context}: every record is this student's`);
    }
  });

  it('reflects a prior submission alongside the seeded workbook record', async () => {
    const context = 'GET /activities/S001 read-back';
    const label = 'Curling Club';

    const created = await postJson({ studentId: KNOWN_STUDENT_ID, activity: label });
    assert.strictEqual(created.status, 201, `${context}: the submission was accepted`);

    const records = await readActivities(KNOWN_STUDENT_ID, context);

    const submitted = findRecord(records, label);
    assert.ok(submitted !== undefined, `${context}: the submission is readable back`);
    assertSubmissionRecord(submitted, KNOWN_STUDENT_ID, label, `${context} (submission)`);

    // The store is a superset of the workbook column rather than a competing
    // answer, so the seeded label is still here after a submission.
    const seededLabel = SEEDED_LABELS[KNOWN_STUDENT_ID];
    const seeded = findRecord(records, seededLabel);
    assert.ok(seeded !== undefined, `${context}: the seeded record survives alongside it`);
    assertWorkbookRecord(seeded, KNOWN_STUDENT_ID, seededLabel, `${context} (seeded)`);
  });

  it('never returns HTML, even for a request asking for it in Accept', async () => {
    const context = 'GET /activities/S001 with an HTML Accept header';
    const response = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}`, {
      headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
    });

    assert.strictEqual(response.status, 200, `${context}: status`);
    assert.strictEqual(
      response.headers['content-type'],
      CONTENT_TYPE_JSON,
      `${context}: negotiation is on the request media type, never on Accept`
    );
    assert.ok(!response.body.includes('<!DOCTYPE'), `${context}: no document was rendered`);
    parseJsonResponse(response, context);
  });

  it('treats /activities/S001/ with a trailing slash as the same route', async () => {
    const context = 'GET /activities/S001/ (trailing slash)';
    const response = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}/`);

    assert.strictEqual(response.status, 200, `${context}: the same route, not an unresolved path`);
    const payload = parseJsonResponse(response, context);
    assert.strictEqual(payload.studentId, KNOWN_STUDENT_ID, `${context}: the same student`);
  });

  for (const malformed of ['s001', 'S1', 'S0012', 'ABC']) {
    it(`answers 400 student_id_malformed for the path segment ${JSON.stringify(malformed)}`, async () => {
      const context = `GET /activities/${malformed}`;
      const response = await get(`${NAMESPACE}/${malformed}`);

      assertErrorEnvelope(response, 400, 'student_id_malformed', context);
    });
  }

  it('answers 404 student_not_found for a well-formed but absent Student ID', async () => {
    const context = `GET /activities/${ABSENT_STUDENT_ID}`;
    const response = await get(`${NAMESPACE}/${ABSENT_STUDENT_ID}`);

    // The split is load-bearing: a syntactically wrong identifier is a
    // malformed request, while a well-formed one naming no student is a
    // reference to a parent that does not exist.
    assertErrorEnvelope(response, 404, 'student_not_found', context);
  });

  for (const method of ['POST', 'PUT', 'DELETE']) {
    it(`answers 405 with the route-correct Allow: GET for ${method} /activities/S001`, async () => {
      const context = `${method} /activities/${KNOWN_STUDENT_ID}`;
      const response = await request({
        method,
        target: `${NAMESPACE}/${KNOWN_STUDENT_ID}`,
        headers: { 'Content-Type': MEDIA_TYPE_JSON },
        body: '{}',
      });

      assertErrorEnvelope(response, 405, 'method_not_allowed', context);
      // The route addressed accepts only GET, so `Allow: GET, POST` would be a
      // lie about this resource even though it is true of the namespace root.
      assert.strictEqual(
        response.headers.allow,
        'GET',
        `${context}: Allow names this route's methods, not the namespace's`
      );
    });
  }

  it('answers from the workbook seed when the store does not exist, and creates no file', async (t) => {
    const context = 'GET /activities/S005 against an absent store';
    const directory = await makeCaseDirectory('read-creates-nothing');
    const storePath = path.join(directory, 'activities.json');

    const isolated = await startIsolatedServer(storePath);
    t.after(() => isolated.stop());

    const records = await readActivities('S005', context, { port: isolated.port });
    assert.strictEqual(records.length, 1, `${context}: exactly the one seeded record`);
    assertWorkbookRecord(records[0], 'S005', SEEDED_LABELS.S005, context);

    // Reading must have NO write side effect. A store pre-created by a read
    // would be a valid empty document, which would then suppress seeding and
    // lose the workbook's labels permanently.
    await assert.rejects(
      () => fsp.access(storePath),
      `${context}: the read must not have created the store`
    );
    await assert.rejects(
      () => fsp.access(`${storePath}.tmp`),
      `${context}: the read must not have created the staging file either`
    );
  });
});


/* ========================================================================= *
 * Structural refusals — decided before any field is looked at
 *
 * A body that is not JSON at all, and a body that is JSON but not an object.
 * Both are answered in JSON in BOTH request modes, because neither is reachable
 * from a form submission: a form body is parsed with `URLSearchParams`, which
 * accepts any string and never throws.
 * ========================================================================= */

describe('POST /activities — structural refusals', () => {
  it('answers 400 malformed_json for a body that is not parseable JSON', async () => {
    const context = 'POST /activities with body {bad';
    const response = await postJson('{bad');

    assertErrorEnvelope(response, 400, 'malformed_json', context);
  });

  it('answers 400 malformed_json for a truly zero-byte body declared as JSON', async () => {
    const context = 'POST /activities with an accepted media type and NO body at all';
    // No body is written, so the request really carries zero bytes rather than
    // a short one. Every other accepted-media-type case in this file sends at
    // least one byte, which leaves the body reader's empty-stream path — it
    // resolves with nothing accumulated — otherwise unexercised.
    const response = await postBody({ contentType: MEDIA_TYPE_JSON });

    // The empty string is not JSON, so this is the ordinary parse refusal. It
    // must NOT be mistaken for an empty object and fall through to the field
    // checks, and it must not be answered 413 or 415 either.
    assertErrorEnvelope(response, 400, 'malformed_json', context);
    await assertStillServing(context);
  });

  it('answers a truly zero-byte FORM body with student_id_required as HTML', async () => {
    const context = 'POST /activities form-encoded with NO body at all';
    const response = await postBody({ contentType: MEDIA_TYPE_FORM });

    // The same empty stream in the other mode: `URLSearchParams('')` yields no
    // parameters at all and never throws, so the request fails on presence of
    // the first field — and because it is a form submission, on a page the
    // person who submitted it can act on.
    assertHtmlFailure(response, 400, 'student_id_required', context);
    await assertStillServing(context);
  });

  for (const [description, rawBody] of [
    ['null', 'null'],
    ['an array', '[]'],
    ['a number', '42'],
    ['a string', '"x"'],
  ]) {
    it(`answers 400 body_not_an_object when the body parses to ${description}`, async () => {
      const context = `POST /activities with body ${rawBody}`;
      const response = await postJson(rawBody);

      // An array is refused rather than interpreted: this endpoint records one
      // activity per request, and quietly taking the first element would
      // discard the rest without saying so.
      assertErrorEnvelope(response, 400, 'body_not_an_object', context);
    });
  }

  it('reaches student_id_required rather than malformed_json for a form body of "null"', async () => {
    const context = 'POST /activities form-encoded body null';
    const response = await postFormBody('null');

    // Proof that the two structural codes are unreachable in form mode by
    // construction: `URLSearchParams('null')` yields a parameter named "null"
    // with an empty value, so neither field is present and the request fails on
    // presence instead.
    assertHtmlFailure(response, 400, 'student_id_required', context);
  });
});

/* ========================================================================= *
 * Student ID validation — presence, then type, then format, then existence
 *
 * The order is load-bearing. Presence precedes type so an omitted field and a
 * numeric one are told apart, and NO string operation runs until the type check
 * has passed — calling `.trim()` or a regex test on a number, an object or
 * `null` would throw, and an uncaught throw here is the hung-request failure
 * this design exists to prevent.
 * ========================================================================= */

describe('POST /activities — Student ID validation precedence', () => {
  it('answers 400 student_id_required when studentId is omitted entirely', async () => {
    const context = 'POST /activities with no studentId key';
    const response = await postJson({ activity: 'Chess Club' });

    assertErrorEnvelope(response, 400, 'student_id_required', context);
  });

  it('answers 400 student_id_required when studentId is null', async () => {
    const context = 'POST /activities with studentId null';
    const response = await postJson({ studentId: null, activity: 'Chess Club' });

    // `null` is an absent value rather than a wrong one, so presence catches it
    // before the type check does.
    assertErrorEnvelope(response, 400, 'student_id_required', context);
  });

  for (const [description, value] of [
    ['a number', 123],
    ['an object', {}],
    ['an array', []],
    ['a boolean', true],
  ]) {
    it(`answers 400 student_id_malformed when studentId is ${description}`, async () => {
      const context = `POST /activities with a studentId that is ${description}`;
      const response = await postJson({ studentId: value, activity: 'Chess Club' });

      // Present but not a string: refused on type, before any string operation
      // could be attempted on it.
      assertErrorEnvelope(response, 400, 'student_id_malformed', context);
    });
  }

  for (const malformed of ['s1', 'S1', 'S0012', 'ABC', '', 'S00A']) {
    it(`answers 400 student_id_malformed for the value ${JSON.stringify(malformed)}`, async () => {
      const context = `POST /activities with studentId ${JSON.stringify(malformed)}`;
      const response = await postJson({ studentId: malformed, activity: 'Chess Club' });

      assertErrorEnvelope(response, 400, 'student_id_malformed', context);
    });
  }

  it('answers 404 student_not_found for a well-formed Student ID that names no student', async () => {
    const context = `POST /activities with studentId ${ABSENT_STUDENT_ID}`;
    const response = await postJson({ studentId: ABSENT_STUDENT_ID, activity: 'Chess Club' });

    // Asserted DISTINCTLY from the 400s above, because that is the whole point
    // of the split: this identifier is shaped correctly and simply refers to a
    // parent that does not exist.
    assertErrorEnvelope(response, 404, 'student_not_found', context);
  });

  it('reports the malformed activity first when both fields are wrong', async () => {
    const context = 'POST /activities with an absent student AND an invalid activity';
    const response = await postJson({ studentId: ABSENT_STUDENT_ID, activity: '' });

    // Existence is checked last, and deliberately so: answering
    // student_not_found here would send a submitter chasing the wrong field.
    assertErrorEnvelope(response, 400, 'activity_invalid', context);
  });
});

/* ========================================================================= *
 * Activity validation
 * ========================================================================= */

describe('POST /activities — activity validation', () => {
  it('answers 400 activity_invalid when activity is omitted entirely', async () => {
    const context = 'POST /activities with no activity key';
    const response = await postJson({ studentId: KNOWN_STUDENT_ID });

    assertErrorEnvelope(response, 400, 'activity_invalid', context);
  });

  it('answers 400 activity_invalid when activity is null', async () => {
    const context = 'POST /activities with activity null';
    const response = await postJson({ studentId: KNOWN_STUDENT_ID, activity: null });

    assertErrorEnvelope(response, 400, 'activity_invalid', context);
  });

  for (const [description, value] of [
    ['a number', 42],
    ['an object', {}],
    ['an array', []],
  ]) {
    it(`answers 400 activity_invalid when activity is ${description}`, async () => {
      const context = `POST /activities with an activity that is ${description}`;
      const response = await postJson({ studentId: KNOWN_STUDENT_ID, activity: value });

      assertErrorEnvelope(response, 400, 'activity_invalid', context);
    });
  }

  it('answers 400 activity_invalid for an empty activity', async () => {
    const context = 'POST /activities with an empty activity';
    const response = await postJson({ studentId: KNOWN_STUDENT_ID, activity: '' });

    assertErrorEnvelope(response, 400, 'activity_invalid', context);
  });

  it('answers 400 activity_invalid for a whitespace-only activity', async () => {
    const context = 'POST /activities with a whitespace-only activity';
    const response = await postJson({ studentId: KNOWN_STUDENT_ID, activity: '     ' });

    // Empty once surrounding whitespace is removed, which is the same mistake
    // as sending nothing — normalization runs before the emptiness check.
    assertErrorEnvelope(response, 400, 'activity_invalid', context);
  });

  for (const [description, value] of [
    ['a tab', 'Chess\tClub'],
    ['a newline', 'Chess\nClub'],
    ['a NUL', 'Chess\u0000Club'],
    ['a DEL', 'Chess\u007fClub'],
  ]) {
    it(`answers 400 activity_invalid for an activity containing ${description}`, async () => {
      const context = `POST /activities with an activity containing ${description}`;
      const response = await postJson({ studentId: KNOWN_STUDENT_ID, activity: value });

      // A control character is NOT laundered into a space by normalization:
      // only space separators are trimmed and collapsed, so the character
      // survives to be refused.
      assertErrorEnvelope(response, 400, 'activity_invalid', context);
    });
  }

  it('accepts an activity of exactly 60 characters', async () => {
    const context = 'POST /activities with a 60-character activity';
    const label = 'A'.repeat(60);

    const response = await postJson({ studentId: 'S007', activity: label });

    assert.strictEqual(response.status, 201, `${context}: the bound is inclusive at 60`);
    assertSubmissionRecord(parseJsonResponse(response, context).record, 'S007', label, context);
  });

  it('answers 400 activity_invalid for an activity of 61 characters', async () => {
    const context = 'POST /activities with a 61-character activity';
    const response = await postJson({ studentId: 'S007', activity: 'B'.repeat(61) });

    assertErrorEnvelope(response, 400, 'activity_invalid', context);
  });

  it('accepts 30 astral characters, which is 60 UTF-16 code units', async () => {
    const context = 'POST /activities with a 30-character astral activity';
    const label = '\u{1f680}'.repeat(30);

    // The two cases above use BMP characters, where a code point and a code
    // unit are the same thing, so neither can tell the two candidate rules
    // apart. This fixture can, and its arithmetic is asserted rather than
    // asserted about: an astral character is ONE code point and TWO code
    // units, so this label is AT the bound by the code-unit rule and at half
    // of it by the code-point rule.
    assert.strictEqual(label.length, 60, `${context}: the fixture is 60 UTF-16 code units`);
    assert.strictEqual(
      Array.from(label).length,
      30,
      `${context}: the same fixture is only 30 code points`
    );

    const response = await postJson({ studentId: 'S007', activity: label });

    assert.strictEqual(
      response.status,
      201,
      `${context}: the bound is inclusive at 60 code units, whichever plane the characters come from`
    );
    const record = parseJsonResponse(response, context).record;
    assertSubmissionRecord(record, 'S007', label, context);
    // Surrogate pairs must survive the round trip whole: a label re-encoded or
    // split mid-pair would arrive here as a different string of the same
    // length, which only an exact comparison catches.
    const persisted = findRecord(await readActivities('S007', context), label);
    assert.ok(persisted !== undefined, `${context}: the astral label is readable back`);
    assert.strictEqual(
      persisted.activity,
      label,
      `${context}: re-reading the store neither refuses the stored astral label nor rewrites it`
    );
  });

  it('answers 400 activity_invalid for 31 astral characters, which is 62 UTF-16 code units', async () => {
    const context = 'POST /activities with a 31-character astral activity';
    const label = '\u{1f680}'.repeat(31);

    assert.strictEqual(label.length, 62, `${context}: the fixture is 62 UTF-16 code units`);
    // This is the case that bites. Measured in code points the label is 31 —
    // comfortably inside the limit — so the earlier code-point rule ACCEPTED
    // it over the JSON API while the form's maxlength="60", counted in code
    // units by the browser, would never have let a person submit it. One
    // bound, two answers; the code-unit answer is the one that holds.
    assert.strictEqual(
      Array.from(label).length,
      31,
      `${context}: only 31 code points, so a code-point rule would have let this through`
    );

    const response = await postJson({ studentId: 'S007', activity: label });

    assertErrorEnvelope(response, 400, 'activity_invalid', context);
  });

  it('refuses at exactly the 60-code-unit bound the served form advertises', async () => {
    const context = 'POST /activities against the served form maxlength';
    const markup = assertHtmlPage(await get(NAMESPACE), 200, context);

    // Both sides of one bound in a single case: the attribute as the browser
    // receives it, then the authoritative server check either side of it. The
    // browser evaluates maxlength in UTF-16 code units, so the convenience and
    // the check agree only if the server counts the same units.
    assert.ok(
      markup.includes('maxlength="60"'),
      `${context}: the form advertises the 60 bound the server enforces`
    );

    const atBound = '\u{1f3b8}'.repeat(30);
    const overBound = '\u{1f3b8}'.repeat(31);
    assert.strictEqual(atBound.length, 60, `${context}: 30 astral characters are 60 code units`);
    assert.strictEqual(overBound.length, 62, `${context}: 31 astral characters are 62 code units`);

    const accepted = await postJson({ studentId: 'S007', activity: atBound });
    assert.strictEqual(
      accepted.status,
      201,
      `${context}: what the form would let a person submit, the server records`
    );
    assertSubmissionRecord(parseJsonResponse(accepted, context).record, 'S007', atBound, context);

    const refused = await postJson({ studentId: 'S007', activity: overBound });
    assertErrorEnvelope(refused, 400, 'activity_invalid', `${context} (two code units over)`);
  });

  it('measures the 60-character bound AFTER normalization, so padding does not count', async () => {
    const context = 'POST /activities with a padded 60-character activity';
    const label = 'C'.repeat(60);

    const response = await postJson({ studentId: 'S008', activity: `   ${label}   ` });

    assert.strictEqual(
      response.status,
      201,
      `${context}: surrounding whitespace is removed before the length is measured`
    );
    const record = parseJsonResponse(response, context).record;
    assertSubmissionRecord(record, 'S008', label, context);
    assert.strictEqual(record.activity, label, `${context}: the stored label is trimmed`);
  });

  it('collapses internal whitespace runs before storing', async () => {
    const context = 'POST /activities with collapsible internal whitespace';
    const response = await postJson({ studentId: 'S008', activity: 'Kabaddi     Team' });

    assert.strictEqual(response.status, 201, `${context}: accepted`);
    assert.strictEqual(
      parseJsonResponse(response, context).record.activity,
      'Kabaddi Team',
      `${context}: every run of internal space becomes a single space`
    );
  });
});

/* ========================================================================= *
 * Form-mode presence semantics, and which failures render HTML
 *
 * A form body always yields strings, so "present" means the KEY arrived:
 * `studentId=` is present with an empty value, which is a different mistake
 * from omitting the field altogether.
 * ========================================================================= */

describe('POST /activities — form-mode validation rendering', () => {
  it('answers an omitted form field with student_id_required as HTML', async () => {
    const context = 'POST /activities form-encoded with studentId omitted';
    const response = await postFormBody('activity=Chess+Club');

    assertHtmlFailure(response, 400, 'student_id_required', context);
  });

  it('answers an empty form field value with student_id_malformed as HTML', async () => {
    const context = 'POST /activities form-encoded with studentId=';
    const response = await postFormBody('studentId=&activity=Chess+Club');

    // Present but empty, so the failure is format rather than presence.
    assertHtmlFailure(response, 400, 'student_id_malformed', context);
  });

  it('answers an invalid form activity with activity_invalid as HTML', async () => {
    const context = 'POST /activities form-encoded with an over-long activity';
    const response = await postForm(KNOWN_STUDENT_ID, 'D'.repeat(61));

    assertHtmlFailure(response, 400, 'activity_invalid', context);
  });

  it('answers an absent student in form mode with student_not_found as HTML', async () => {
    const context = 'POST /activities form-encoded with an absent Student ID';
    const response = await postForm(ABSENT_STUDENT_ID, 'Chess Club');

    // The fourth and last form-renderable code: a 404 a person can act on by
    // correcting the field, unlike every other failure in the matrix.
    assertHtmlFailure(response, 404, 'student_not_found', context);
  });

  it('re-displays the submitted values so a correction does not mean retyping', async () => {
    const context = 'POST /activities form-encoded failure re-displays input';
    const response = await postForm('S0012', 'Chess Club');

    const markup = assertHtmlFailure(response, 400, 'student_id_malformed', context);
    assert.ok(markup.includes('value="S0012"'), `${context}: the Student ID is pre-filled back`);
    assert.ok(markup.includes('value="Chess Club"'), `${context}: the activity is pre-filled back`);
    assert.ok(
      markup.includes('aria-invalid="true"'),
      `${context}: the offending field is flagged for assistive technology`
    );
  });
});

/* ========================================================================= *
 * The same Student ID rules on both routes
 *
 * The read route validates a Student ID exactly as a submission's is — same
 * shape test, same key-set lookup, same split — so an identifier behaves
 * identically whichever route it arrives on.
 * ========================================================================= */

describe('the Student ID rules are identical on the read and write routes', () => {
  it('answers 400 student_id_malformed on BOTH routes for the same malformed value', async () => {
    const context = 'malformed Student ID on both routes';
    const malformed = 'S0012';

    const read = await get(`${NAMESPACE}/${malformed}`);
    const write = await postJson({ studentId: malformed, activity: 'Chess Club' });

    const readPayload = assertErrorEnvelope(read, 400, 'student_id_malformed', `${context} (read)`);
    const writePayload = assertErrorEnvelope(write, 400, 'student_id_malformed', `${context} (write)`);
    assert.deepStrictEqual(
      readPayload,
      writePayload,
      `${context}: the same identifier produces the same envelope on either route`
    );
  });

  it('answers 404 student_not_found on BOTH routes for the same absent value', async () => {
    const context = 'absent Student ID on both routes';

    const read = await get(`${NAMESPACE}/${ABSENT_STUDENT_ID}`);
    const write = await postJson({ studentId: ABSENT_STUDENT_ID, activity: 'Chess Club' });

    const readPayload = assertErrorEnvelope(read, 404, 'student_not_found', `${context} (read)`);
    const writePayload = assertErrorEnvelope(write, 404, 'student_not_found', `${context} (write)`);
    assert.deepStrictEqual(
      readPayload,
      writePayload,
      `${context}: the same identifier produces the same envelope on either route`
    );
  });
});


/* ========================================================================= *
 * Media type — refused, never guessed at
 * ========================================================================= */

describe('POST /activities — media type', () => {
  it('answers 415 unsupported_media_type for Content-Type: text/plain', async () => {
    const context = 'POST /activities with Content-Type text/plain';
    const response = await postBody({ contentType: 'text/plain', body: 'x' });

    assertErrorEnvelope(response, 415, 'unsupported_media_type', context);
  });

  it('answers 415 unsupported_media_type when Content-Type is missing entirely', async () => {
    const context = 'POST /activities with no Content-Type header';
    const response = await postBody({ body: 'studentId=S001&activity=Chess+Club' });

    // Refused rather than sniffed. Guessing wrong turns a client's mistake into
    // a stored value nobody intended, and this body would have parsed.
    assertErrorEnvelope(response, 415, 'unsupported_media_type', context);
  });

  it('answers 415 as the JSON envelope even when the body itself is form-encoded', async () => {
    const context = 'POST /activities with a form body declared text/plain';
    const response = await postBody({
      contentType: 'text/plain',
      body: new URLSearchParams({ studentId: KNOWN_STUDENT_ID, activity: 'Chess Club' }).toString(),
    });

    // 415 is settled before the body's format is known, so there is no form
    // context to render and the envelope is JSON in both modes.
    assertErrorEnvelope(response, 415, 'unsupported_media_type', context);
    assert.ok(!response.body.includes('<!DOCTYPE'), `${context}: no HTML page is rendered for a 415`);
  });

  it('answers 415 for a media type that merely resembles an accepted one', async () => {
    const context = 'POST /activities with Content-Type application/json-patch+json';
    const response = await postBody({
      contentType: 'application/json-patch+json',
      body: JSON.stringify({ studentId: KNOWN_STUDENT_ID, activity: 'Chess Club' }),
    });

    // The comparison is on the whole media type, not a prefix of it.
    assertErrorEnvelope(response, 415, 'unsupported_media_type', context);
  });
});

/* ========================================================================= *
 * A Content-Type declared more than once
 *
 * `req.headers` is a collapsed view: for `content-type` Node keeps the FIRST
 * field line and silently discards every later one, while `headersDistinct`
 * and `rawHeaders` retain them all. Measured on this runtime — a request
 * declaring `application/json` and then `text/plain` presents as plain
 * `application/json` in the collapsed map.
 *
 * So a check written against that map cannot tell one unambiguous declaration
 * from two contradictory ones, and it answers the request according to
 * whichever line happened to arrive first. That is a decision the sender never
 * made, and it is made on the strength of a header the endpoint is supposed to
 * be enforcing. Exactly one declaration is required; zero and two are both
 * refused, and the third case below is the one a first-line-wins
 * implementation passes while getting the answer for the wrong reason.
 * ========================================================================= */

describe('POST /activities — a Content-Type declared more than once', () => {
  /** A label no accepting case submits, so its absence is meaningful. */
  const REFUSED_LABEL = 'Ambiguous Club';

  /**
   * Posts with several `Content-Type` field lines. An array header value makes
   * `http.request` emit one line per element — verified against a raw socket
   * read on the server side.
   *
   * @param {string[]} declarations The media types to declare, in order.
   * @returns {Promise<object>} The response.
   */
  function postWithDeclarations(declarations) {
    return postBody({
      contentType: declarations,
      body: JSON.stringify({ studentId: KNOWN_STUDENT_ID, activity: REFUSED_LABEL }),
    });
  }

  it('answers 415 for two conflicting declarations', async () => {
    const context = 'POST /activities declaring application/json then text/plain';
    const response = await postWithDeclarations([MEDIA_TYPE_JSON, 'text/plain']);

    assertErrorEnvelope(response, 415, 'unsupported_media_type', context);
  });

  it('answers 415 when the accepted type is declared SECOND', async () => {
    const context = 'POST /activities declaring text/plain then application/json';
    const response = await postWithDeclarations(['text/plain', MEDIA_TYPE_JSON]);

    // Both orderings must answer the same way. An implementation reading the
    // collapsed header agrees with this case by accident and disagrees with
    // the one above, which is exactly the ambiguity being refused.
    assertErrorEnvelope(response, 415, 'unsupported_media_type', context);
  });

  it('answers 415 even when the duplicate declarations agree', async () => {
    const context = 'POST /activities declaring application/json twice';
    const response = await postWithDeclarations([MEDIA_TYPE_JSON, MEDIA_TYPE_JSON]);

    // Refused on ambiguity rather than on disagreement: the endpoint requires
    // one declaration, and does not adjudicate between several.
    assertErrorEnvelope(response, 415, 'unsupported_media_type', context);
  });

  it('answers 415 for duplicate form-encoded declarations too', async () => {
    const context = 'POST /activities declaring the form media type twice';
    const response = await postBody({
      contentType: [MEDIA_TYPE_FORM, MEDIA_TYPE_FORM],
      body: new URLSearchParams({ studentId: KNOWN_STUDENT_ID, activity: REFUSED_LABEL }).toString(),
    });

    assertErrorEnvelope(response, 415, 'unsupported_media_type', context);
    assert.ok(!response.body.includes('<!DOCTYPE'), `${context}: the JSON envelope, not a page`);
  });

  it('stores nothing from an ambiguously declared submission', async () => {
    const context = 'an ambiguous declaration persists nothing';
    await postWithDeclarations([MEDIA_TYPE_JSON, 'text/plain']);

    const records = await readActivities(KNOWN_STUDENT_ID, context);
    assert.strictEqual(
      findRecord(records, REFUSED_LABEL),
      undefined,
      `${context}: the body was never read, so no record can exist for it`
    );
    await assertStillServing(context);
  });
});

/* ========================================================================= *
 * The cross-origin submission boundary
 *
 * `POST /activities` changes stored state, and an HTML form can be made to
 * submit across origins: a page on any other site can carry a form whose
 * action is this service and whose encoding is the one this endpoint accepts,
 * and the browser that loads that page will send the request. Field validation
 * cannot tell it apart from the real form's, because it IS a real form
 * submission — of somebody else's form. Nothing else in this service stands in
 * the way: no authentication, no session, no cookie, no token; and the
 * loopback bind is no defence, because the browser making the request is on
 * the loopback host itself.
 *
 * What a browser cannot forge is where it says a request came from, and these
 * cases pin both halves of that: a submission whose `Origin` or
 * `Sec-Fetch-Site` names somewhere else is refused, while a request carrying
 * NEITHER header is accepted — that is the documented non-browser client, and
 * every published `curl` command is one, so an over-broad check would refuse
 * the very callers the endpoint is specified to serve.
 * ========================================================================= */

describe('POST /activities — the cross-origin submission boundary', () => {
  const FOREIGN_ORIGIN = 'http://evil.example';
  const REFUSED_LABEL = 'Forged Club';

  /**
   * Posts a form-encoded submission with browser-shaped headers added.
   *
   * @param {Record<string, string>} headers The origin signals to send.
   * @param {{studentId?: string, activity?: string}} [fields] The submission.
   * @returns {Promise<object>} The response.
   */
  function postFromBrowser(headers, fields = {}) {
    const { studentId = KNOWN_STUDENT_ID, activity = REFUSED_LABEL } = fields;
    return request({
      method: 'POST',
      target: NAMESPACE,
      headers: { 'Content-Type': MEDIA_TYPE_FORM, ...headers },
      body: new URLSearchParams({ studentId, activity }).toString(),
    });
  }

  /** This service's own origin, as a browser on the harness port would send it. */
  function ownOrigin() {
    return `http://${HOST}:${activePort()}`;
  }

  it('refuses a form submission from another origin with 403 cross_origin_submission', async () => {
    const context = 'POST /activities with a foreign Origin';
    const response = await postFromBrowser({
      Origin: FOREIGN_ORIGIN,
      'Sec-Fetch-Site': 'cross-site',
    });

    assertErrorEnvelope(response, 403, 'cross_origin_submission', context);
    // The envelope in both modes: the decision is taken before the body's
    // format matters, and re-rendering the form would reflect a caller's own
    // input into a page that caller controls.
    assert.ok(!response.body.includes('<!DOCTYPE'), `${context}: no page is rendered for a 403`);
    assert.ok(
      !response.body.includes('evil.example'),
      `${context}: the refused origin is not echoed back`
    );
  });

  it('refuses a submission whose Origin alone is foreign', async () => {
    const context = 'POST /activities with a foreign Origin and no Sec-Fetch-Site';
    const response = await postFromBrowser({ Origin: FOREIGN_ORIGIN });

    // Not every browser sends `Sec-Fetch-Site`, so `Origin` must be sufficient
    // on its own.
    assertErrorEnvelope(response, 403, 'cross_origin_submission', context);
  });

  it('refuses the opaque Origin: null a sandboxed document sends', async () => {
    const context = 'POST /activities with Origin: null';
    const response = await postFromBrowser({ Origin: 'null' });

    // Refused rather than interpreted: an opaque origin names nothing, and
    // treating it as "no origin" would hand a sandboxed page the non-browser
    // client's acceptance.
    assertErrorEnvelope(response, 403, 'cross_origin_submission', context);
  });

  it('refuses an Origin whose host matches but whose scheme does not', async () => {
    const context = 'POST /activities with an https Origin for an http service';
    const response = await postFromBrowser({ Origin: `https://${HOST}:${activePort()}` });

    // A different scheme is a different origin, whatever the host says. This
    // service speaks only http.
    assertErrorEnvelope(response, 403, 'cross_origin_submission', context);
  });

  it('refuses an Origin declared more than once', async () => {
    const context = 'POST /activities declaring two Origins';
    const response = await postFromBrowser({ Origin: [ownOrigin(), FOREIGN_ORIGIN] });

    // Ambiguity is refused here for the same reason it is refused on the media
    // type: the endpoint does not choose between two declarations.
    assertErrorEnvelope(response, 403, 'cross_origin_submission', context);
  });

  for (const site of ['cross-site', 'same-site']) {
    it(`refuses a submission the browser classifies as ${site}`, async () => {
      const context = `POST /activities with Sec-Fetch-Site: ${site}`;
      const response = await postFromBrowser({ 'Sec-Fetch-Site': site });

      // `same-site` matters as much as `cross-site`: on loopback there are no
      // subdomains, so anything the browser calls same-site-but-not-same-origin
      // reached this service from a different port or scheme.
      assertErrorEnvelope(response, 403, 'cross_origin_submission', context);
    });
  }

  it('refuses a cross-origin submission in JSON mode as well', async () => {
    const context = 'POST /activities JSON with a foreign Origin';
    const response = await request({
      method: 'POST',
      target: NAMESPACE,
      headers: { 'Content-Type': MEDIA_TYPE_JSON, Origin: FOREIGN_ORIGIN },
      body: JSON.stringify({ studentId: KNOWN_STUDENT_ID, activity: REFUSED_LABEL }),
    });

    assertErrorEnvelope(response, 403, 'cross_origin_submission', context);
  });

  it('refuses before the media type, so an unaccepted type does not mask it', async () => {
    const context = 'POST /activities cross-origin with an unaccepted media type';
    const response = await request({
      method: 'POST',
      target: NAMESPACE,
      headers: { 'Content-Type': 'text/plain', Origin: FOREIGN_ORIGIN },
      body: 'anything',
    });

    // Authority to submit is settled first: a foreign submission is refused as
    // a whole rather than parsed and then refused on its content type.
    assertErrorEnvelope(response, 403, 'cross_origin_submission', context);
  });

  it('persists nothing from any refused submission', async () => {
    const context = 'a refused cross-origin submission persists nothing';
    const records = await readActivities(KNOWN_STUDENT_ID, context);

    assert.strictEqual(
      findRecord(records, REFUSED_LABEL),
      undefined,
      `${context}: none of the refusals above may have reached the store`
    );
    await assertStillServing(context);
  });

  it('accepts the real form: an Origin naming this service, classified same-origin', async () => {
    const context = 'POST /activities from this service own form';
    const response = await postFromBrowser(
      { Origin: ownOrigin(), 'Sec-Fetch-Site': 'same-origin' },
      { studentId: 'S004', activity: 'Origin Gated Club' }
    );

    // The browser path this feature exists for. Its `Origin` is whatever host
    // the page was served from, which is the host the request is addressed to,
    // which is why the comparison works on an ephemeral port as well as on
    // the fixed one.
    const markup = assertHtmlPage(response, 201, context);
    assert.ok(
      markup.includes('Origin Gated Club'),
      `${context}: the confirmation restates what was recorded`
    );
  });

  it('accepts a user-initiated navigation, which the browser classifies as none', async () => {
    const context = 'POST /activities with Sec-Fetch-Site: none';
    const response = await postFromBrowser(
      { Origin: ownOrigin(), 'Sec-Fetch-Site': 'none' },
      { studentId: 'S004', activity: 'Bookmark Club' }
    );

    assertHtmlPage(response, 201, context);
  });

  it('accepts a script sending neither header, so the documented curl commands still work', async () => {
    const context = 'POST /activities with no origin signal at all';
    const response = await postJson({ studentId: 'S009', activity: 'Scripted Club' });

    // The non-browser client, and the reason the check keys on a signal being
    // WRONG rather than on it being absent: no browser omits `Origin` on a
    // POST, so a request without one is not a browser form submission. Every
    // published curl example is one of these.
    assert.strictEqual(response.status, 201, `${context}: accepted, exactly as documented`);
    assertSubmissionRecord(
      parseJsonResponse(response, context).record,
      'S009',
      'Scripted Club',
      context
    );
  });

  it('leaves reads open, because a read changes nothing', async () => {
    const context = 'GET /activities/S004 with a foreign Origin';
    const response = await request({
      method: 'GET',
      target: `${NAMESPACE}/S004`,
      headers: { Origin: FOREIGN_ORIGIN, 'Sec-Fetch-Site': 'cross-site' },
    });

    // The boundary is on the state-changing method only. Adding it to reads
    // would refuse a request that alters nothing, and the service's read
    // exposure is documented as it stands rather than half-fixed here.
    assert.strictEqual(response.status, 200, `${context}: reads are unaffected`);
    parseJsonResponse(response, context);
  });
});

/* ========================================================================= *
 * Body size — the limit is INCLUSIVE at 8192 bytes
 *
 * The naive implementation of this limit crashes the process: responding from
 * inside the body-read handler and then continuing to receive chunks throws
 * ERR_HTTP_HEADERS_SENT on the next chunk. The alternative of destroying the
 * request means the client never sees the 413 at all. So each case below
 * asserts that the client ACTUALLY RECEIVED the 413, and every one is followed
 * by a normal request proving the process is still serving — together, those
 * two assertions are what tell the correct implementation from both wrong ones.
 * ========================================================================= */

describe('POST /activities — the 8192-byte body limit', () => {
  it('READS and accepts a valid JSON body of exactly 8192 bytes', async () => {
    const context = 'POST /activities with a valid body of exactly 8192 bytes';
    const label = 'Padded Club';
    const head = `{"studentId":"S009","activity":"${label}"`;
    const tail = '}';
    // Insignificant whitespace pads the document to the boundary exactly; a
    // JSON parser ignores it, so this is a legitimate submission that happens
    // to be as large as the limit allows.
    const body = head + ' '.repeat(MAX_BODY_BYTES - head.length - tail.length) + tail;
    assert.strictEqual(
      Buffer.byteLength(body),
      MAX_BODY_BYTES,
      `${context}: the fixture is exactly ${MAX_BODY_BYTES} bytes`
    );

    const response = await postBody({ contentType: MEDIA_TYPE_JSON, body });

    assert.strictEqual(
      response.status,
      201,
      `${context}: a body at the inclusive limit is read and honoured, not refused`
    );
    assertSubmissionRecord(parseJsonResponse(response, context).record, 'S009', label, context);
  });

  it('READS a body of exactly 8192 bytes and rejects it as malformed_json, not 413', async () => {
    const context = 'POST /activities with an unparseable body of exactly 8192 bytes';
    const body = Buffer.alloc(MAX_BODY_BYTES, 0x78);
    assert.strictEqual(body.length, MAX_BODY_BYTES, `${context}: the fixture is exactly 8192 bytes`);

    const response = await postBody({ contentType: MEDIA_TYPE_JSON, body });

    // The boundary is inclusive, so this body is READ — and then fails on its
    // content. A 413 here would mean the limit was being applied exclusively.
    assertErrorEnvelope(response, 400, 'malformed_json', context);
    await assertStillServing(context);
  });

  it('answers 413 payload_too_large for a body of 8193 bytes — one over the limit', async () => {
    const context = 'POST /activities with a body of 8193 bytes';
    const body = Buffer.alloc(MAX_BODY_BYTES + 1, 0x78);

    const response = await postBody({ contentType: MEDIA_TYPE_JSON, body });

    assertErrorEnvelope(response, 413, 'payload_too_large', context);
    await assertStillServing(context);
  });

  for (const [description, size] of [
    ['200 KB', 200 * 1024],
    ['5 MB', 5 * 1024 * 1024],
  ]) {
    it(`delivers the 413 to the client for a ${description} body and keeps serving`, async () => {
      const context = `POST /activities with a ${description} body`;
      const response = await postBody({
        contentType: MEDIA_TYPE_JSON,
        body: Buffer.alloc(size, 0x78),
      });

      // Receiving the response is the substance of this case. An
      // implementation that destroyed the request instead would leave the
      // client with a connection reset and no status at all, and one that
      // responded from the data handler would have terminated the process
      // before this line ran.
      assertErrorEnvelope(response, 413, 'payload_too_large', context);
      await assertStillServing(context);
    });
  }

  it('answers 413 as the JSON envelope for an oversize FORM body, not as HTML', async () => {
    const context = 'POST /activities with an oversize form-encoded body';
    const response = await postBody({
      contentType: MEDIA_TYPE_FORM,
      body: `studentId=${KNOWN_STUDENT_ID}&activity=${'x'.repeat(MAX_BODY_BYTES)}`,
    });

    // Like 415, a 413 is decided before the body's format is known, so form
    // mode gets the JSON envelope rather than a re-rendered page.
    assertErrorEnvelope(response, 413, 'payload_too_large', context);
    assert.ok(!response.body.includes('<!DOCTYPE'), `${context}: no HTML page is rendered for a 413`);
    await assertStillServing(context);
  });

  it('keeps serving correctly after a run of oversize bodies back to back', async () => {
    const context = 'POST /activities with consecutive oversize bodies';

    for (const size of [MAX_BODY_BYTES + 1, 64 * 1024, 1024 * 1024]) {
      const response = await postBody({
        contentType: MEDIA_TYPE_JSON,
        body: Buffer.alloc(size, 0x78),
      });
      assertErrorEnvelope(response, 413, 'payload_too_large', `${context} (${size} bytes)`);
    }

    // A single surviving request proves the process is alive; a correct
    // submission afterwards proves nothing was left in a broken state.
    const accepted = await postJson({ studentId: 'S010', activity: 'Rowing Club' });
    assert.strictEqual(accepted.status, 201, `${context}: normal submissions still work afterwards`);
    assertSubmissionRecord(
      parseJsonResponse(accepted, context).record,
      'S010',
      'Rowing Club',
      context
    );
    await assertStillServing(context);
  });
});


/* ========================================================================= *
 * A request stream that fails part way
 *
 * Both cases here need something no pooled keep-alive client will do: declare
 * a body and then abandon it. They therefore drive a raw socket, and they are
 * the only cases in this file that do.
 *
 * The first is the oversize DRAIN, and it is subtler than the 413 cases above.
 * Measured on this runtime: an oversize request is answered `413` with
 * `Connection: keep-alive`, and the runtime then holds the connection open
 * waiting for the rest of the body the sender declared, with the drain still
 * running. Anything that disarmed the request stream's error handling at the
 * moment of the 413 would leave that window unguarded, and a client that reset
 * mid-drain would emit `'error'` on an EventEmitter with no listener for it —
 * which throws, and ends the process. One abandoned upload would then be a
 * denial of service, delivered through the very limit that exists to bound
 * what one request can cost.
 *
 * The second is a stream that fails BEFORE the limit is reached, which is the
 * ordinary "client went away" case. Nothing can be sent to a client that is
 * gone, so the observable requirement is not a status: it is that the request
 * reaches a definite end and that the fault is written down. A silent return
 * leaves an operator with no evidence the request ever happened.
 * ========================================================================= */

describe('POST /activities — a request stream that fails part way', () => {
  // Required here rather than at the top of the file because these are the
  // only cases that need a connection they can abandon; every other case in
  // this file goes through the shared keep-alive client.
  const net = require('node:net');

  /** How long a case waits for a condition it cannot be notified of. */
  const CONDITION_TIMEOUT_MS = 5000;

  /**
   * Pauses.
   *
   * @param {number} ms How long.
   * @returns {Promise<void>}
   */
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Waits for a condition, or fails the case saying what it waited for.
   *
   * @param {() => boolean} condition The condition to poll.
   * @param {string} description What is being waited for.
   * @returns {Promise<void>}
   */
  async function waitFor(condition, description) {
    const deadline = Date.now() + CONDITION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (condition()) {
        return;
      }
      await delay(10);
    }
    assert.fail(`timed out after ${CONDITION_TIMEOUT_MS}ms waiting for ${description}`);
  }

  /**
   * Opens a raw connection to the harness server and sends a request head that
   * declares a body length, without delivering it.
   *
   * @param {number} declaredLength The `Content-Length` to declare.
   * @returns {Promise<{socket: import('node:net').Socket, send: (bytes: number|string) => void, received: () => string}>}
   *   The socket, a writer, and a reader of everything received so far.
   */
  async function openDeclaredSubmission(declaredLength) {
    const socket = net.connect(activePort(), HOST);
    let received = '';

    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
    });
    // A socket this case is going to reset will report that reset. It is the
    // point of the case, not a failure of it.
    socket.on('error', () => {});

    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    socket.write(
      `POST ${NAMESPACE} HTTP/1.1\r\nHost: ${HOST}:${activePort()}\r\n` +
        `Content-Type: ${MEDIA_TYPE_JSON}\r\nContent-Length: ${declaredLength}\r\n\r\n`
    );

    return {
      socket,
      send(bytes) {
        socket.write(typeof bytes === 'number' ? Buffer.alloc(bytes, 0x78) : bytes);
      },
      received: () => received,
    };
  }

  it('keeps the request stream guarded through the oversize drain, and survives an abort in it', async (t) => {
    const context = 'POST /activities aborted during the oversize drain';

    // The server-side request object is captured so the abort can be applied
    // to the exact stream the body reader was draining — a client-side reset
    // alone races the runtime's own teardown and proves nothing either way.
    let captured = null;
    const capture = (incoming) => {
      if (captured === null) {
        captured = incoming;
      }
    };
    server.prependListener('request', capture);

    const link = await openDeclaredSubmission(5 * 1024 * 1024);
    t.after(() => {
      server.removeListener('request', capture);
      link.socket.destroy();
    });

    link.send(64 * 1024);
    await waitFor(() => link.received().includes('\r\n\r\n'), 'the 413 response head');

    assert.match(
      link.received().split('\r\n')[0],
      /^HTTP\/1\.1 413 /,
      `${context}: the client is told the body was too large`
    );
    assert.ok(captured !== null, `${context}: the server-side request was captured`);
    assert.strictEqual(
      captured.readableEnded,
      false,
      `${context}: megabytes were declared and kilobytes sent, so the drain is still in progress`
    );
    assert.ok(
      captured.listenerCount('error') >= 1,
      `${context}: the request stream must still carry an error listener while it drains — without one, the abort below is an unhandled 'error' event and the process dies`
    );

    // The abort itself. With the drain guarded this is observed and dropped;
    // unguarded it throws out of the emit and terminates the process, so the
    // assertions after it are the ones that matter.
    captured.destroy(Object.assign(new Error('client reset'), { code: 'ECONNRESET' }));
    await delay(50);

    await assertStillServing(context);
    const accepted = await postJson({ studentId: 'S006', activity: 'Post Abort Club' });
    assert.strictEqual(
      accepted.status,
      201,
      `${context}: and submissions are still honoured afterwards`
    );
  });

  it('records a failed request stream once, in a bounded shape, and keeps serving', async (t) => {
    const context = 'POST /activities whose stream fails mid-body';

    const logged = [];
    const originalError = console.error;
    console.error = (...args) => {
      logged.push(args.map((argument) => String(argument)).join(' '));
    };
    t.after(() => {
      console.error = originalError;
    });

    const link = await openDeclaredSubmission(4096);
    t.after(() => link.socket.destroy());

    // A partial body well under the limit, then a reset: the read fails while
    // it is still accumulating, which is the path that used to return with no
    // response, no teardown and no evidence.
    link.send('{"studentId"');
    await delay(50);
    link.socket.resetAndDestroy();

    await waitFor(
      () => logged.some((line) => line.includes('request_stream_failed')),
      'the stream-failure event to be recorded'
    );

    console.error = originalError;

    const line = logged.find((candidate) => candidate.includes('request_stream_failed'));
    const record = JSON.parse(line.slice(line.indexOf('{')));

    assert.deepStrictEqual(
      Object.keys(record).sort(),
      ['at', 'code', 'detail', 'event', 'method', 'number', 'path', 'reason'],
      `${context}: one fixed-shape record, so the evidence is countable and greppable`
    );
    assert.strictEqual(record.event, 'request_stream_failed', `${context}: the event`);
    assert.strictEqual(record.method, 'POST', `${context}: the method`);
    assert.strictEqual(record.path, NAMESPACE, `${context}: the pathname, with no query string`);
    assert.match(
      record.detail,
      /^(?:[A-Z][A-Z_]*|none|unclassified)$/,
      `${context}: the underlying fault is named by an allow-listed token, never by its message`
    );

    // What must NOT be in the evidence: this is a log, so it outlives the
    // request, and the store's and reader's messages carry store paths,
    // workbook paths, Student IDs and activity labels by design.
    for (const marker of ['\\', '.js', ' at ', 'Error:', TEMPORARY_ROOT]) {
      assert.ok(
        !line.includes(marker),
        `${context}: the log line must not carry ${JSON.stringify(marker)}`
      );
    }

    assert.strictEqual(
      logged.filter((candidate) => candidate.includes('request_stream_failed')).length,
      1,
      `${context}: recorded exactly once — a second line would make a count of these meaningless`
    );

    await assertStillServing(context);
  });
});


/* ========================================================================= *
 * Methods, unresolved paths, and the namespace boundary
 *
 * Route resolution happens BEFORE the method is considered. That ordering is
 * why an unknown path under an unsupported verb is a 404 and not a 405: a 405
 * carrying `Allow` would assert that the resource exists and merely refuses
 * that verb, and nothing exists there under any verb.
 * ========================================================================= */

describe('POST and GET are the only methods on /activities', () => {
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    it(`answers 405 with Allow: GET, POST for ${method} /activities`, async () => {
      const context = `${method} /activities`;
      const response = await request({ method, target: NAMESPACE });

      assertErrorEnvelope(response, 405, 'method_not_allowed', context);
      assert.strictEqual(
        response.headers.allow,
        'GET, POST',
        `${context}: Allow names the namespace root's two methods`
      );
    });
  }

  it('answers 405 with Allow: GET, POST for HEAD /activities', async () => {
    const context = 'HEAD /activities';
    const response = await request({ method: 'HEAD', target: NAMESPACE });

    // A HEAD response carries no body by definition, so the status, the
    // content type and the Allow header are the whole observable contract here.
    assert.strictEqual(response.status, 405, `${context}: status`);
    assert.strictEqual(response.headers.allow, 'GET, POST', `${context}: Allow`);
    assert.strictEqual(
      response.headers['content-type'],
      CONTENT_TYPE_JSON,
      `${context}: the envelope's content type is still announced`
    );
    assert.strictEqual(response.body, '', `${context}: a HEAD response has no body`);
  });
});

describe('a path inside the namespace that names no route is 404', () => {
  it('answers 404 not_found for GET /activities/S001/extra', async () => {
    const context = 'GET /activities/S001/extra';
    const response = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}/extra`);

    assertErrorEnvelope(response, 404, 'not_found', context);
    assert.strictEqual(
      response.headers.allow,
      undefined,
      `${context}: no Allow header, because no resource exists to allow anything on`
    );
  });

  it('answers 404 not_found — not 405 — for DELETE /activities/S001/extra', async () => {
    const context = 'DELETE /activities/S001/extra';
    const response = await request({ method: 'DELETE', target: `${NAMESPACE}/${KNOWN_STUDENT_ID}/extra` });

    // An unknown path AND an unsupported method at once. The path loses,
    // because resolution runs first.
    assertErrorEnvelope(response, 404, 'not_found', context);
    assert.strictEqual(response.headers.allow, undefined, `${context}: still no Allow header`);
  });

  it('answers 404 not_found for a deeply nested namespace path', async () => {
    const context = 'GET /activities/S001/extra/deeper';
    const response = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}/extra/deeper`);

    assertErrorEnvelope(response, 404, 'not_found', context);
  });
});

/* ------------------------------------------------------------------------- *
 * The boundary, asserted directly on `handle`
 *
 * The boolean return value is the entire integration surface with `server.js`,
 * and `false` carries a second promise beyond the boolean: that NOTHING was
 * written to the response — not a status, not a header. That is what keeps the
 * legacy response byte-identical, and it cannot be observed over HTTP, because
 * by then `server.js` has already written its own response.
 * ------------------------------------------------------------------------- */

/**
 * A response double that records every write instead of performing one.
 *
 * @returns {{written: object, res: object}} The record, and the double to pass
 *   to `handle`.
 */
function recordingResponse() {
  const written = { statusCode: null, headers: {}, ended: false, body: null, destroyed: false };

  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      written.headers[name] = value;
    },
    end(body) {
      written.ended = true;
      written.body = body ?? null;
    },
    destroy() {
      written.destroyed = true;
    },
  };

  Object.defineProperty(res, 'statusCode', {
    get: () => written.statusCode ?? 200,
    set: (value) => {
      written.statusCode = value;
    },
  });

  return { written, res };
}

/**
 * A minimal request double. Enough for the boundary predicate, which reads only
 * the method and the target before deciding.
 *
 * @param {string} url The request target.
 * @param {string} [method] The method.
 * @returns {object} The double.
 */
function recordingRequest(url, method = 'GET') {
  return { method, url, headers: {}, resume() {}, on() {}, off() {} };
}

describe('handle() claims only the /activities namespace', () => {
  for (const outside of ['/', '/nonsense', '/activities-old', '/activitieslist', '/activitiesx', '/students/S001']) {
    it(`returns false and writes nothing for ${outside}`, async () => {
      const context = `handle(${outside})`;
      const { written, res } = recordingResponse();

      const claimed = await activities.handle(recordingRequest(outside), res);

      assert.strictEqual(claimed, false, `${context}: the path lies outside the namespace`);
      assert.strictEqual(written.statusCode, null, `${context}: no status was written`);
      assert.deepStrictEqual(written.headers, {}, `${context}: no header was written`);
      assert.strictEqual(written.ended, false, `${context}: the response was not ended`);
      assert.strictEqual(written.destroyed, false, `${context}: the socket was not touched`);
    });
  }

  it('returns false for a request target it cannot even parse', async () => {
    const context = 'handle() with an unparseable target';
    const { written, res } = recordingResponse();

    const claimed = await activities.handle(recordingRequest(''), res);

    // The conservative direction: a request this module cannot name is left to
    // behave exactly as it did before the feature existed.
    assert.strictEqual(claimed, false, `${context}: not claimed`);
    assert.strictEqual(written.ended, false, `${context}: nothing written`);
  });

  for (const claimedPath of ['/activities', '/activities/', '/activities?x=1', '/activities#frag', '/activities/S001']) {
    it(`returns true for ${claimedPath}`, async () => {
      const context = `handle(${claimedPath})`;
      const { written, res } = recordingResponse();

      const claimed = await activities.handle(recordingRequest(claimedPath), res);

      // A `startsWith` against the raw target would misclassify the query and
      // fragment forms; parsing the pathname first is what makes them the same
      // route as the bare namespace.
      assert.strictEqual(claimed, true, `${context}: claimed by the feature`);
      assert.strictEqual(written.ended, true, `${context}: and answered`);
    });
  }
});

/* ------------------------------------------------------------------------- *
 * The byte-level legacy response is NOT asserted here
 *
 * What the fall-through actually returns — the 200, the `text/plain` header
 * with no charset parameter, the 34-byte body and its sha256 — belongs to
 * `test/lifecycle.test.js`, which owns the preserved response and asserts it
 * against a real `node server.js` child process for `/`, `/nonsense`,
 * `/index.html`, `/students/S001`, `/activities-old`, `/activitieslist`, an
 * arbitrary unrelated path, and a non-GET method. Repeating those assertions
 * here would give one contract two owners that could disagree, and the copy
 * driving an in-process listener would be the weaker of the two.
 *
 * This file's stake in the boundary is the predicate, and the suite above is
 * it: `handle` returns `false` for every lookalike path AND writes nothing to
 * the response — which is what leaves the legacy response byte-identical, and
 * which cannot be observed over HTTP at all, because by then `server.js` has
 * already written its own.
 * ------------------------------------------------------------------------- */


/* ========================================================================= *
 * HTML escaping — a security property, not a presentation detail
 *
 * A valid activity label may legitimately contain `&`, `<`, `>`, `"` or `'`:
 * nothing in the normalization rules excludes them, so all five reach the page
 * through a value the feature itself ACCEPTED. The attack needs no malformed
 * request at all, which is why these cases submit values that are perfectly
 * legal and then assert on what the page contains.
 * ========================================================================= */

describe('HTML escaping of submitted values', () => {
  it('escapes a script tag submitted as an activity label', async () => {
    const context = 'POST /activities form-encoded with a <script> label';
    const response = await postForm('S003', '<script>alert(1)</script>');

    // `assertHtmlPage` already refuses a script tag in any casing; these
    // assertions additionally prove the value was RENDERED, escaped, rather
    // than silently dropped — a page that discarded it would also pass the
    // absence check on its own.
    const markup = assertHtmlPage(response, 201, context);
    assert.ok(markup.includes('&lt;script&gt;'), `${context}: the opening tag is escaped`);
    assert.ok(markup.includes('&lt;/script&gt;'), `${context}: the closing tag is escaped`);
    assert.ok(!SCRIPT_ELEMENT.test(markup), `${context}: no raw script tag survives`);
  });

  it('escapes a MIXED-CASE script tag, which a browser would run exactly as lowercase', async () => {
    const context = 'POST /activities form-encoded with a <ScRiPt> label';
    // A different payload from the lowercase case above on purpose: labels are
    // deduplicated case-insensitively, so submitting the same characters in
    // another casing would be answered 200 with the FIRST case's stored
    // spelling and would prove nothing about this one.
    const label = '<ScRiPt>alert(2)</ScRiPt>';

    const response = await postForm('S003', label);

    // The escaping is not case-sensitive either, so the mixed-case spelling
    // must come back as entities exactly as the lowercase one does. An
    // implementation that matched only `<script` before escaping would emit
    // this payload raw, and a lowercase-only absence check would clear it.
    const markup = assertHtmlPage(response, 201, context);
    assert.ok(markup.includes('&lt;ScRiPt&gt;'), `${context}: the mixed-case opening tag is escaped`);
    assert.ok(markup.includes('&lt;/ScRiPt&gt;'), `${context}: the mixed-case closing tag is escaped`);
    assert.ok(
      !SCRIPT_ELEMENT.test(markup),
      `${context}: no raw script tag survives in any casing`
    );
  });

  it('escapes all five special characters to their entity forms', async () => {
    const context = 'POST /activities form-encoded with every special character';
    const label = 'A&B <C> "D" \'E\'';

    const response = await postForm('S003', label);

    const markup = assertHtmlPage(response, 201, context);
    for (const entity of ['&amp;', '&lt;C&gt;', '&quot;D&quot;', '&#39;E&#39;']) {
      assert.ok(markup.includes(entity), `${context}: expected ${entity} in the page`);
    }
    assert.ok(!markup.includes('<C>'), `${context}: the angle brackets do not survive raw`);
  });

  it('escapes a double quote in the Student ID field so it cannot break out of the attribute', async () => {
    const context = 'POST /activities form-encoded with a quoted Student ID';
    const response = await postForm('S"1', 'Chess Club');

    // Every attribute in the template is double-quoted, so a surviving raw
    // quote would terminate the attribute early and let the rest of the value
    // become markup.
    const markup = assertHtmlFailure(response, 400, 'student_id_malformed', context);
    assert.ok(markup.includes('value="S&quot;1"'), `${context}: the quote is escaped in the attribute`);
    assert.ok(!markup.includes('value="S"1"'), `${context}: the attribute is not broken out of`);
  });

  it('escapes a double quote in the activity field of a re-rendered error page', async () => {
    const context = 'POST /activities form-encoded with a quoted activity and a bad Student ID';
    const response = await postForm('S0012', 'Choir "A" Club');

    const markup = assertHtmlFailure(response, 400, 'student_id_malformed', context);
    assert.ok(
      markup.includes('value="Choir &quot;A&quot; Club"'),
      `${context}: the activity value is escaped for attribute context`
    );
    assert.ok(
      !markup.includes('value="Choir "A" Club"'),
      `${context}: the activity attribute is not broken out of`
    );
  });

  it('escapes a submitted value on the 400 error page that re-displays it', async () => {
    const context = 'POST /activities form-encoded with markup in an over-long activity';
    // Over the 60-character bound, so this takes the HTML error path — which
    // re-displays the offending value rather than clearing it.
    const response = await postForm(KNOWN_STUDENT_ID, `<b>${'x'.repeat(60)}</b>`);

    const markup = assertHtmlFailure(response, 400, 'activity_invalid', context);
    assert.ok(markup.includes('&lt;b&gt;'), `${context}: the markup in the rejected value is escaped`);
    assert.ok(!markup.includes('<b>'), `${context}: no raw element survives from the rejected value`);
  });

  it('round-trips a quoted label through the JSON response without corruption', async () => {
    const context = 'POST /activities with a quoted label in JSON mode';
    const label = 'Quiz "Bowl" Club';

    const response = await postJson({ studentId: 'S005', activity: label });

    // Serialization, not concatenation: a value carrying a quote or a backslash
    // cannot break out of the document it is written into.
    assert.strictEqual(response.status, 201, `${context}: accepted`);
    const record = parseJsonResponse(response, context).record;
    assertSubmissionRecord(record, 'S005', label, context);
    assert.strictEqual(record.activity, label, `${context}: the label survives the round trip exactly`);
  });

  it('round-trips a backslash-bearing label through the JSON response', async () => {
    const context = 'POST /activities with a backslash in the label';
    const label = 'Judo \\ Club';

    const response = await postJson({ studentId: 'S005', activity: label });

    assert.strictEqual(response.status, 201, `${context}: accepted`);
    assert.strictEqual(
      parseJsonResponse(response, context).record.activity,
      label,
      `${context}: the backslash survives serialization`
    );
  });

  it('returns an escaped label unchanged when it is read back as JSON', async () => {
    const context = 'GET /activities/S003 after submitting markup';
    const label = '<em>Kendo</em> Club';

    const created = await postJson({ studentId: 'S003', activity: label });
    assert.strictEqual(created.status, 201, `${context}: the submission was accepted`);

    // The JSON read route is not HTML, so it must NOT entity-escape: escaping
    // belongs to the markup path alone, and a JSON consumer that received
    // entities would have to un-escape them to recover the stored value.
    const records = await readActivities('S003', context);
    const stored = findRecord(records, label);
    assert.ok(stored !== undefined, `${context}: the record is readable back`);
    assert.strictEqual(stored.activity, label, `${context}: JSON carries the raw stored label`);
  });
});


/* ========================================================================= *
 * The four distinct 500 codes
 *
 * There are FOUR, not one, and telling them apart is the point: a submitter
 * told "internal error" cannot distinguish an unreadable workbook from a full
 * disk. Each has its own case, each is driven over real HTTP against the real
 * composed server, and each is followed by a probe proving the service is STILL
 * SERVING — a failure mode that kills the process must not be able to pass
 * here.
 *
 * Each fault is induced at the narrowest mechanism that produces the real
 * failure, and for two of the four that mechanism reaches INTO the process
 * rather than sitting on disk. `store_unreadable` and `store_write_failed` are
 * induced by breaking the actual store file and its directory, but
 * `reference_data_unavailable` SUBSTITUTES `xlsx-read` through the CommonJS
 * cache, and `internal_error` REPLACES `activities.handle`. Neither of those
 * two is reachable from outside: a client cannot corrupt a committed workbook,
 * and every foreseeable request fault is already caught and mapped upstream, so
 * substitution is the only door in. What no case does is assert against a
 * double — every assertion below is made on the HTTP response the real server
 * sent, and the substitutes exist only to make the real code take its error
 * path.
 *
 * A valid store document, used as the "previous document" wherever a case needs
 * one to still be intact afterwards. Every field satisfies the loader: the
 * Student ID is in the key set, the label is already normalized, and a
 * `workbook` record correctly carries no `submittedAt`.
 * ========================================================================= */

const VALID_STORE_DOCUMENT = `${JSON.stringify(
  {
    schemaVersion: 1,
    activities: [{ studentId: 'S001', activity: 'Robotics Club', source: 'workbook' }],
  },
  null,
  2
)}\n`;

describe('500 store_unreadable — the store exists but cannot be used', () => {
  for (const [description, contents] of [
    ['is not valid JSON', 'this is not json at all\n'],
    ['declares an unsupported schemaVersion', '{"schemaVersion":2,"activities":[]}\n'],
    ['is missing its activities array', '{"schemaVersion":1}\n'],
    ['holds a record for an unknown student', '{"schemaVersion":1,"activities":[{"studentId":"S999","activity":"Chess Club","source":"workbook"}]}\n'],
    ['holds a workbook record carrying a submittedAt', '{"schemaVersion":1,"activities":[{"studentId":"S001","activity":"Chess Club","source":"workbook","submittedAt":"2026-01-01T00:00:00Z"}]}\n'],
  ]) {
    it(`answers 500 store_unreadable on BOTH routes when the store ${description}`, async (t) => {
      const context = `store that ${description}`;
      const directory = await makeCaseDirectory(`unreadable-${description.replace(/[^a-z]+/gi, '-')}`);
      const storePath = path.join(directory, 'activities.json');
      await fsp.writeFile(storePath, contents, { encoding: 'utf8' });

      const isolated = await startIsolatedServer(storePath);
      t.after(() => isolated.stop());

      const read = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}`, { port: isolated.port });
      assertErrorEnvelope(read, 500, 'store_unreadable', `${context} (read)`);

      const write = await postJson(
        { studentId: KNOWN_STUDENT_ID, activity: 'Chess Club' },
        { port: isolated.port }
      );
      assertErrorEnvelope(write, 500, 'store_unreadable', `${context} (write)`);

      // The SAME fault in form mode, which the matrix answers in JSON too: a
      // 500 is a fault the form cannot help with, so there is no field to flag
      // and no page to re-render. Exercised explicitly because the renderer is
      // reached by the request mode rather than by the status, so a 500 wrongly
      // routed into the HTML path would only ever show up here.
      const formWrite = await postForm(KNOWN_STUDENT_ID, 'Chess Club', { port: isolated.port });
      assertErrorEnvelope(formWrite, 500, 'store_unreadable', `${context} (form-mode write)`);
      assert.ok(
        !formWrite.body.includes('<!DOCTYPE'),
        `${context}: a 500 is never rendered as a page, even for a form submission`
      );

      // The file is preserved for inspection, never silently replaced or
      // repaired: a hand-edit mistake must cost an error response rather than
      // the data.
      assert.strictEqual(
        await fsp.readFile(storePath, 'utf8'),
        contents,
        `${context}: the malformed document was left exactly as found`
      );
      await assert.rejects(
        () => fsp.access(`${storePath}.tmp`),
        `${context}: no staging file was written either`
      );

      // The form route touches no store, so it proves the process is alive even
      // while every store access is legitimately still failing.
      await assertStillServing(context, { target: NAMESPACE, port: isolated.port });
    });
  }
});

describe('500 store_write_failed — the write cannot complete', () => {
  it('answers 500, leaves the previous document intact, and recovers once the fault clears', async (t) => {
    const context = 'store_write_failed';
    const directory = await makeCaseDirectory('write-failed');
    const storePath = path.join(directory, 'activities.json');
    const stagingPath = `${storePath}.tmp`;

    await fsp.writeFile(storePath, VALID_STORE_DOCUMENT, { encoding: 'utf8' });

    // THE MECHANISM, chosen for this platform: a DIRECTORY is created at the
    // staging path, so `writeFile` to it fails with EISDIR. `fs.chmod` is
    // ineffective on Windows, and a store path with a missing parent directory
    // would fail the write just as well but could not leave a PREVIOUS document
    // intact to assert about — this way the existing store is genuinely at risk
    // and demonstrably untouched.
    await fsp.mkdir(stagingPath);

    const isolated = await startIsolatedServer(storePath);
    t.after(() => isolated.stop());

    const refused = await postJson(
      { studentId: KNOWN_STUDENT_ID, activity: 'Kite Club' },
      { port: isolated.port }
    );
    assertErrorEnvelope(refused, 500, 'store_write_failed', context);

    // The same refusal reached from the form, answered in JSON rather than as a
    // re-rendered page — the mode-specific half of this row of the matrix.
    const formRefused = await postForm(KNOWN_STUDENT_ID, 'Kite Club', { port: isolated.port });
    assertErrorEnvelope(formRefused, 500, 'store_write_failed', `${context} (form mode)`);
    assert.ok(
      !formRefused.body.includes('<!DOCTYPE'),
      `${context}: a form-mode 500 is the JSON envelope, not a page`
    );

    assert.strictEqual(
      await fsp.readFile(storePath, 'utf8'),
      VALID_STORE_DOCUMENT,
      `${context}: the previous document is intact and the submission was not persisted`
    );

    // Reading still works while writing does not — the two failures are
    // independent, and the process is plainly alive.
    const stillReadable = await readActivities(KNOWN_STUDENT_ID, `${context} (read during fault)`, {
      port: isolated.port,
    });
    assert.ok(
      findRecord(stillReadable, 'Robotics Club') !== undefined,
      `${context}: the existing record is still readable during the write fault`
    );
    assert.strictEqual(
      findRecord(stillReadable, 'Kite Club'),
      undefined,
      `${context}: the refused submission was not persisted`
    );

    // Clear the fault. A retry must succeed, which is also what proves the
    // write mutex did not jam on the failure: a naive promise chain would stay
    // rejected and short-circuit every later submission.
    await fsp.rmdir(stagingPath);

    const accepted = await postJson(
      { studentId: KNOWN_STUDENT_ID, activity: 'Kite Club' },
      { port: isolated.port }
    );
    assert.strictEqual(accepted.status, 201, `${context}: the retry succeeds once the fault clears`);
    assertSubmissionRecord(
      parseJsonResponse(accepted, context).record,
      KNOWN_STUDENT_ID,
      'Kite Club',
      context
    );

    const afterRecovery = await readActivities(KNOWN_STUDENT_ID, `${context} (after recovery)`, {
      port: isolated.port,
    });
    assert.ok(
      findRecord(afterRecovery, 'Kite Club') !== undefined,
      `${context}: the retried submission is now persisted`
    );
    assert.ok(
      findRecord(afterRecovery, 'Robotics Club') !== undefined,
      `${context}: and the pre-existing record survived the whole episode`
    );
    await assertStillServing(context, { port: isolated.port });
  });

  it('answers 500 store_write_failed when the store directory does not exist', async (t) => {
    const context = 'store_write_failed with a missing parent directory';
    const directory = await makeCaseDirectory('write-failed-missing-parent');
    // The subdirectory is deliberately never created, so the STAGING WRITE to
    // `<store>.tmp` is what fails and the rename is never attempted at all.
    // That is the whole of what this case can observe, and it is enough: the
    // write path refuses, reports `store_write_failed`, and keeps serving.
    const storePath = path.join(directory, 'absent-subdirectory', 'activities.json');

    const isolated = await startIsolatedServer(storePath);
    t.after(() => isolated.stop());

    const refused = await postJson(
      { studentId: KNOWN_STUDENT_ID, activity: 'Luge Club' },
      { port: isolated.port }
    );
    assertErrorEnvelope(refused, 500, 'store_write_failed', context);

    const formRefused = await postForm(KNOWN_STUDENT_ID, 'Luge Club', { port: isolated.port });
    assertErrorEnvelope(formRefused, 500, 'store_write_failed', `${context} (form mode)`);
    assert.ok(
      !formRefused.body.includes('<!DOCTYPE'),
      `${context}: a form-mode 500 is the JSON envelope, not a page`
    );

    // Reading is unaffected: an absent store is the first-use state, answered
    // from the workbook seed.
    const records = await readActivities(KNOWN_STUDENT_ID, context, { port: isolated.port });
    assertWorkbookRecord(
      findRecord(records, SEEDED_LABELS[KNOWN_STUDENT_ID]),
      KNOWN_STUDENT_ID,
      SEEDED_LABELS[KNOWN_STUDENT_ID],
      context
    );
    await assertStillServing(context, { port: isolated.port });
  });
});

describe('500 reference_data_unavailable — the workbook cannot be read', () => {
  it('answers 500, then retries the read on the next request rather than caching the failure', async (t) => {
    const context = 'reference_data_unavailable';
    const directory = await makeCaseDirectory('reference-data');
    const storePath = path.join(directory, 'activities.json');

    const readerPath = require.resolve('../xlsx-read');
    const realReader = require('../xlsx-read');
    const savedCacheEntry = require.cache[readerPath];
    t.after(() => {
      require.cache[readerPath] = savedCacheEntry;
    });

    // The first three column reads fail, every later one delegates to the real
    // reader. Three, because the read route, the JSON write and the form-mode
    // write are each exercised, and each makes exactly one key-set read before
    // giving up.
    let failuresRemaining = 3;
    let inducedFailures = 0;

    const stubEntry = {
      id: readerPath,
      filename: readerPath,
      loaded: true,
      children: [],
      paths: [],
      exports: {
        readColumn(...args) {
          if (failuresRemaining > 0) {
            failuresRemaining -= 1;
            inducedFailures += 1;
            const error = new Error('induced workbook read failure');
            error.code = 'E_XLSX_TRUNCATED';
            throw error;
          }
          return realReader.readColumn(...args);
        },
        readSheetRows: (...args) => realReader.readSheetRows(...args),
        readEntry: (...args) => realReader.readEntry(...args),
        listEntries: (...args) => realReader.listEntries(...args),
      },
    };

    // Installed in the window between eviction and require, which is the only
    // moment `activity-store.js` can be made to capture it.
    const isolated = await startIsolatedServer(storePath, () => {
      require.cache[readerPath] = stubEntry;
    });
    t.after(() => isolated.stop());

    const read = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}`, { port: isolated.port });
    assertErrorEnvelope(read, 500, 'reference_data_unavailable', `${context} (read)`);

    const write = await postJson(
      { studentId: KNOWN_STUDENT_ID, activity: 'Chess Club' },
      { port: isolated.port }
    );
    assertErrorEnvelope(write, 500, 'reference_data_unavailable', `${context} (write)`);

    // And in form mode, where the matrix still says JSON: the reference data is
    // unreadable, so there is no key set to validate against and nothing a
    // re-rendered field could fix.
    const formWrite = await postForm(KNOWN_STUDENT_ID, 'Chess Club', { port: isolated.port });
    assertErrorEnvelope(
      formWrite,
      500,
      'reference_data_unavailable',
      `${context} (form-mode write)`
    );
    assert.ok(
      !formWrite.body.includes('<!DOCTYPE'),
      `${context}: a form-mode 500 is the JSON envelope, not a page`
    );

    assert.strictEqual(
      inducedFailures,
      3,
      `${context}: the read route, the JSON write and the form-mode write each really did attempt the read`
    );

    // The load-bearing assertion, and the reason the fault is induced on the
    // SAME module instance rather than by re-requiring a clean one: a failed
    // read must not leave a partially populated key set behind, so the NEXT
    // request has to retry and succeed. Re-requiring would have produced a
    // fresh instance whose caches were empty by construction, proving nothing.
    const recovered = await readActivities(KNOWN_STUDENT_ID, `${context} (recovered)`, {
      port: isolated.port,
    });
    assertWorkbookRecord(
      findRecord(recovered, SEEDED_LABELS[KNOWN_STUDENT_ID]),
      KNOWN_STUDENT_ID,
      SEEDED_LABELS[KNOWN_STUDENT_ID],
      context
    );

    const accepted = await postJson(
      { studentId: KNOWN_STUDENT_ID, activity: 'Polo Club' },
      { port: isolated.port }
    );
    assert.strictEqual(
      accepted.status,
      201,
      `${context}: a submission succeeds once the reference data reads cleanly`
    );
    assertSubmissionRecord(
      parseJsonResponse(accepted, context).record,
      KNOWN_STUDENT_ID,
      'Polo Club',
      context
    );
    await assertStillServing(context, { port: isolated.port });
  });
});

/* ========================================================================= *
 * The evidence a mapped 500 leaves behind
 *
 * A 500 tells its client which of the four codes applied. `store_unreadable`
 * alone covers a dozen distinct faults, and `reference_data_unavailable`
 * covers every way a workbook package can be refused, so a log that recorded
 * only the public code would leave an operator where no log at all leaves
 * them: knowing the store is unreadable, and nothing about why.
 *
 * These cases induce representative faults through the REAL store and the REAL
 * reader — a genuinely broken document, a genuinely unwritable path, and a
 * genuinely mutated package — and assert that each leaves its own
 * distinguishable record. They are also what holds the classifier's coupling
 * in place: it recognises refusals by anchor phrases that live in
 * `activity-store.js` and `xlsx-read.js`, so a rewording there fails a case
 * here rather than silently degrading every future log line to
 * `unclassified`.
 *
 * And they assert the other half, which matters more: those refusals carry
 * workbook paths, store paths, Student IDs and activity labels in their
 * messages by design, because that detail belongs in a diagnosis and not in a
 * response. A log outlives the request, so none of it may appear there.
 * ========================================================================= */

describe('500 diagnostics — what a mapped failure records, and what it must not', () => {
  /** The fixed field set every record carries, sorted. */
  const RECORD_KEYS = Object.freeze([
    'at',
    'code',
    'detail',
    'event',
    'method',
    'number',
    'path',
    'reason',
  ]);

  /**
   * Runs a block with `console.error` captured.
   *
   * @param {() => Promise<void>} block The work to run.
   * @returns {Promise<string[]>} Everything written while it ran.
   */
  async function capturingLog(block) {
    const captured = [];
    const original = console.error;
    console.error = (...args) => {
      captured.push(args.map((argument) => String(argument)).join(' '));
    };
    try {
      await block();
    } finally {
      console.error = original;
    }
    return captured;
  }

  /**
   * Asserts exactly one failure record was written, and returns it parsed.
   *
   * @param {string[]} captured Lines from `capturingLog`.
   * @param {string} context The case name.
   * @returns {object} The parsed record.
   */
  function soleRecord(captured, context) {
    const failures = captured.filter((line) => line.includes('"event":"store_failure"'));
    assert.strictEqual(
      failures.length,
      1,
      `${context}: exactly one record per mapped failure — logging upstream as well would make a count of these meaningless. Saw: ${JSON.stringify(captured)}`
    );

    const line = failures[0];
    const record = JSON.parse(line.slice(line.indexOf('{')));
    assert.deepStrictEqual(Object.keys(record).sort(), RECORD_KEYS, `${context}: the fixed shape`);
    assert.strictEqual(record.event, 'store_failure', `${context}: the event`);

    // Never anywhere in the line, `path` included: a filesystem path, a source
    // file name, a workbook name, the store's own name, or the shapes a stack
    // trace and a formatted Error take. Every one of these appears in the
    // refusal's message, which is exactly why the message is not logged.
    for (const forbidden of ['\\', '.js', '.xlsx', ' at ', 'Error:', 'activities.json', TEMPORARY_ROOT]) {
      assert.ok(
        !line.includes(forbidden),
        `${context}: the record must not carry ${JSON.stringify(forbidden)}, but it reads ${line}`
      );
    }

    // `path` is the request target, which the failure-handling contract says to
    // log — with the query removed and the length bounded. For a read route
    // that pathname necessarily contains the Student ID being addressed,
    // because the Student ID IS the resource identifier, so it is asserted as
    // the request's own pathname rather than treated as a leak.
    assert.match(
      record.path,
      /^\/activities(?:\/[A-Za-z0-9%._-]{0,32})?$/,
      `${context}: path is the bounded request pathname and nothing else`
    );
    return record;
  }

  /**
   * Asserts none of a fixture's own values reached the classification.
   *
   * Scoped to every field EXCEPT `path`, because those are the fields derived
   * from the refusal — and the refusal's message is where a stored Student ID,
   * an activity label or a rejected value lives. This is the assertion that
   * would fail if the classifier ever emitted captured text instead of one of
   * its own tokens.
   *
   * @param {object} record A record from `soleRecord`.
   * @param {string[]} values The values the fixture put in the document.
   * @param {string} context The case name.
   * @returns {void}
   */
  function assertClassificationCarriesNoValues(record, values, context) {
    const { path: requestPath, ...classification } = record;
    assert.ok(typeof requestPath === 'string', `${context}: path is present`);

    const serialized = JSON.stringify(classification);
    for (const value of values) {
      assert.ok(
        !serialized.includes(value),
        `${context}: the classification must not carry the fixture value ${JSON.stringify(value)}, but it reads ${serialized}`
      );
    }
  }

  /**
   * Stands up an isolated service over a store written verbatim.
   *
   * @param {object} t The test context, for teardown.
   * @param {string} name The case's directory name.
   * @param {string} contents The exact bytes to write to the store.
   * @returns {Promise<object>} The isolated server handle.
   */
  async function serviceOverStore(t, name, contents) {
    const directory = await makeCaseDirectory(name);
    const storePath = path.join(directory, 'activities.json');
    await fsp.writeFile(storePath, contents, 'utf8');
    const isolated = await startIsolatedServer(storePath);
    t.after(() => isolated.stop());
    return isolated;
  }

  for (const [name, label, document, expectedReason, expectedAt, leakCandidates] of [
    [
      'diag-schema',
      'a document declaring the wrong schema version',
      JSON.stringify({ schemaVersion: 2, activities: [] }),
      'store_schema_version',
      null,
      ['schemaVersion'],
    ],
    [
      'diag-not-array',
      'a document whose activities is not an array',
      JSON.stringify({ schemaVersion: 1, activities: {} }),
      'store_activities_not_an_array',
      null,
      ['must hold', 'it holds'],
    ],
    [
      'diag-record-source',
      'a record at index 1 with an unrecognised source',
      JSON.stringify({
        schemaVersion: 1,
        activities: [
          { studentId: 'S001', activity: 'Robotics Club', source: 'workbook' },
          { studentId: 'S002', activity: 'Debate Society', source: 'guesswork' },
        ],
      }),
      'record_source_unrecognised',
      1,
      ['S001', 'S002', 'Robotics Club', 'Debate Society', 'guesswork'],
    ],
    [
      'diag-record-id',
      'a record at index 0 with a malformed Student ID',
      JSON.stringify({
        schemaVersion: 1,
        activities: [{ studentId: 'nope', activity: 'Robotics Club', source: 'workbook' }],
      }),
      'record_student_id_malformed',
      0,
      ['S001', 'nope', 'Robotics Club'],
    ],
  ]) {
    it(`distinguishes ${label} as ${expectedReason}`, async (t) => {
      const context = `store_unreadable / ${expectedReason}`;
      const isolated = await serviceOverStore(t, name, document);

      const captured = await capturingLog(async () => {
        const response = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}`, { port: isolated.port });
        assertErrorEnvelope(response, 500, 'store_unreadable', context);
      });

      const record = soleRecord(captured, context);
      assert.strictEqual(record.code, 'store_unreadable', `${context}: the public code`);
      assert.strictEqual(record.reason, expectedReason, `${context}: the classified reason`);
      assert.strictEqual(
        record.at,
        expectedAt,
        `${context}: the record index the refusal named, so two bad records are told apart`
      );
      assert.strictEqual(record.number, null, `${context}: no package numeric applies`);
      assertClassificationCarriesNoValues(record, leakCandidates, context);
    });
  }

  it('records a refused write as store_write_refused with its errno', async (t) => {
    const context = 'store_write_failed / store_write_refused';
    const directory = await makeCaseDirectory('diag-write');
    // A parent directory that does not exist, so both the temp write and the
    // rename fail and the errno is the informative part.
    const storePath = path.join(directory, 'absent-directory', 'activities.json');
    const isolated = await startIsolatedServer(storePath);
    t.after(() => isolated.stop());

    const captured = await capturingLog(async () => {
      const response = await postJson(
        { studentId: 'S004', activity: 'Unwritable Club' },
        { port: isolated.port }
      );
      assertErrorEnvelope(response, 500, 'store_write_failed', context);
    });

    const record = soleRecord(captured, context);
    assert.strictEqual(record.code, 'store_write_failed', `${context}: the public code`);
    assert.strictEqual(record.reason, 'store_write_refused', `${context}: the classified reason`);
    assert.strictEqual(
      record.detail,
      'ENOENT',
      `${context}: the errno distinguishes a missing directory from a read-only or full one`
    );
    assert.strictEqual(record.method, 'POST', `${context}: the method`);
  });

  for (const [name, label, expectedReason, expectedDetail, expectedNumber, breakPackage] of [
    [
      'diag-compression',
      'an unsupported compression method',
      'zip_compression_method',
      'E_XLSX_UNSUPPORTED_COMPRESSION',
      99,
      (bytes) => {
        bytes.writeUInt16LE(99, 8);
      },
    ],
    [
      'diag-flags',
      'a set general-purpose bit flag',
      'zip_general_purpose_flag',
      'E_XLSX_UNSUPPORTED_FLAGS',
      1,
      (bytes) => {
        bytes.writeUInt16LE(1, 6);
      },
    ],
  ]) {
    it(`carries ${label} through the store's wrapper as ${expectedReason}`, async (t) => {
      const context = `reference_data_unavailable / ${expectedReason}`;
      const directory = await makeCaseDirectory(name);

      // A real copy of the real workbook with its first local file header
      // mutated, read by the REAL reader. The refusal under test is the one
      // the reader actually raises, not a hand-written imitation of it.
      const workbook = await fsp.readFile(
        path.join(__dirname, '..', 'student_details.xlsx')
      );
      breakPackage(workbook);
      const brokenWorkbook = path.join(directory, 'student_details.xlsx');
      await fsp.writeFile(brokenWorkbook, workbook);

      const readerPath = require.resolve('../xlsx-read');
      const realReader = require('../xlsx-read');
      const savedCacheEntry = require.cache[readerPath];
      t.after(() => {
        require.cache[readerPath] = savedCacheEntry;
      });

      // The only substitution is WHICH FILE the key-set read opens. Every
      // refusal, every message and every code still comes from the real
      // reader parsing real bytes.
      const isolated = await startIsolatedServer(
        path.join(directory, 'activities.json'),
        () => {
          require.cache[readerPath] = {
            id: readerPath,
            filename: readerPath,
            loaded: true,
            children: [],
            paths: [],
            exports: {
              readColumn: (file, part, column) =>
                realReader.readColumn(
                  file.includes('student_details') ? brokenWorkbook : file,
                  part,
                  column
                ),
              readSheetRows: (...args) => realReader.readSheetRows(...args),
              readEntry: (...args) => realReader.readEntry(...args),
              listEntries: (...args) => realReader.listEntries(...args),
            },
          };
        }
      );
      t.after(() => isolated.stop());

      const captured = await capturingLog(async () => {
        const response = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}`, { port: isolated.port });
        assertErrorEnvelope(response, 500, 'reference_data_unavailable', context);
      });

      const record = soleRecord(captured, context);
      assert.strictEqual(
        record.code,
        'reference_data_unavailable',
        `${context}: the public code`
      );
      // The point of the case: the store wraps this refusal in its own generic
      // sentence, and the reader's distinction must survive that wrap.
      assert.strictEqual(
        record.reason,
        expectedReason,
        `${context}: the reader's refusal mode, not the wrapper's generic one`
      );
      assert.strictEqual(record.detail, expectedDetail, `${context}: the reader's own code`);
      assert.strictEqual(
        record.number,
        expectedNumber,
        `${context}: the bounded numeric the reader rejected`
      );
      // The reader's message names the package it was reading and the entry
      // inside it. Neither may reach the classification.
      assertClassificationCarriesNoValues(
        record,
        ['student_details', 'sheet1', 'Content_Types', 'DEFLATE', 'only flag 0'],
        context
      );
    });
  }

  it("names a missing package part rather than the wrapper's generic refusal", async (t) => {
    const context = 'reference_data_unavailable / package_part_missing';
    const directory = await makeCaseDirectory('diag-part');

    const readerPath = require.resolve('../xlsx-read');
    const realReader = require('../xlsx-read');
    const savedCacheEntry = require.cache[readerPath];
    t.after(() => {
      require.cache[readerPath] = savedCacheEntry;
    });

    const isolated = await startIsolatedServer(
      path.join(directory, 'activities.json'),
      () => {
        require.cache[readerPath] = {
          id: readerPath,
          filename: readerPath,
          loaded: true,
          children: [],
          paths: [],
          exports: {
            // A part the package genuinely does not hold, so the real reader
            // raises its real E_XLSX_PART_NOT_FOUND against real bytes.
            readColumn: (file, part, column) =>
              realReader.readColumn(file, 'xl/worksheets/sheet9.xml', column),
            readSheetRows: (...args) => realReader.readSheetRows(...args),
            readEntry: (...args) => realReader.readEntry(...args),
            listEntries: (...args) => realReader.listEntries(...args),
          },
        };
      }
    );
    t.after(() => isolated.stop());

    const captured = await capturingLog(async () => {
      const response = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}`, { port: isolated.port });
      assertErrorEnvelope(response, 500, 'reference_data_unavailable', context);
    });

    const record = soleRecord(captured, context);
    assert.strictEqual(record.reason, 'package_part_missing', `${context}: the refusal mode`);
    assert.strictEqual(
      record.detail,
      'E_XLSX_PART_NOT_FOUND',
      `${context}: the reader's own code`
    );
    // The refusal's message names the part it wanted AND lists every part the
    // package does hold — a list of paths. None of it may appear.
    assertClassificationCarriesNoValues(
      record,
      ['sheet9', 'sheet1', 'docProps', 'Content_Types', 'student_details'],
      context
    );
  });

  it('answers a client with no diagnostic detail at all, whatever it records', async (t) => {
    const context = 'the client learns nothing the log knows';
    const isolated = await serviceOverStore(
      t,
      'diag-client',
      JSON.stringify({ schemaVersion: 7, activities: [] })
    );

    const captured = await capturingLog(async () => {
      const response = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}`, { port: isolated.port });
      const payload = assertErrorEnvelope(response, 500, 'store_unreadable', context);

      // The division of labour: the operator gets the classification, the
      // client gets a fixed sentence and nothing else.
      assert.ok(
        !payload.message.includes('schemaVersion'),
        `${context}: the response names no internal detail`
      );
      assert.ok(!payload.message.includes('7'), `${context}: nor the offending value`);
    });

    const record = soleRecord(captured, context);
    assert.strictEqual(record.reason, 'store_schema_version', `${context}: the log does know`);
    assertClassificationCarriesNoValues(record, ['schemaVersion'], context);
  });
});

describe('500 internal_error — the rejection boundary in server.js', () => {
  it('answers 500 internal_error for an unexpected rejection, then keeps serving', async (t) => {
    const context = 'internal_error';
    const originalHandle = activities.handle;
    t.after(() => {
      activities.handle = originalHandle;
    });

    // This works only because `server.js` reads `activities.handle` off the
    // module object AT CALL TIME rather than destructuring it at require time —
    // verified against the implementation before this case was written. It is
    // also the ONLY way to reach the boundary: every foreseeable fault is
    // already caught and mapped upstream, so nothing a client can send gets
    // here. `server.js` writes one sanitized line to stderr for this fault,
    // which is expected output for this case and not a failure; the case below
    // is the one that pins that line's content.
    activities.handle = async () => {
      throw new Error('induced handler failure');
    };

    const response = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}`);

    // The boundary is NOT an exception to the envelope. The authoritative
    // matrix admits exactly one error shape — a stable `error` code and a
    // fixed `message` sentence for it — and `internal_error` is one of its
    // rows, so the shared assertion is reused deliberately: it requires the
    // status, the JSON content type, exactly those two keys, a non-empty
    // sentence, and no leaked internal detail. Asserting the same shape here
    // as for the other thirteen codes is what stops the boundary drifting
    // into a second response schema a client would have to special-case.
    const payload = assertErrorEnvelope(response, 500, 'internal_error', context);

    assert.ok(
      !response.body.includes('induced'),
      `${context}: the underlying error message must not reach the client`
    );
    assert.ok(
      !payload.message.includes('induced'),
      `${context}: the sentence is a fixed literal, not the thrown message`
    );

    activities.handle = originalHandle;

    const recovered = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}`);
    assert.strictEqual(recovered.status, 200, `${context}: a normal request still succeeds`);
    parseJsonResponse(recovered, `${context} (recovered)`);
  });

  it('logs one sanitized line: no Error object, no stack, no query string', async (t) => {
    const context = 'internal_error log line';
    const originalHandle = activities.handle;
    const originalConsoleError = console.error;
    const calls = [];

    // Restored here as well as inline below, so an assertion that throws
    // mid-case cannot leave the suite with a swallowed console or a rejecting
    // `handle` for every later case.
    t.after(() => {
      console.error = originalConsoleError;
      activities.handle = originalHandle;
    });

    // Shaped like the faults that could actually reach this boundary rather
    // than a bare `new Error`: a message naming a filesystem path, an
    // errno-style code, and a nested `cause`. Everything except the name and
    // the code must be dropped, because handing the value to `console.error`
    // as a second argument prints its inspected form — the message, the stack
    // with the absolute path of every source file in it, and the cause.
    const pathInMessage = 'C:\\scratch\\clone-11\\activities.json';
    activities.handle = async () => {
      const fault = new Error(`induced failure writing ${pathInMessage}`);
      fault.code = 'E_STORE_WRITE_FAILED';
      fault.cause = new Error('EACCES: permission denied');
      throw fault;
    };

    // The submitted-looking values go in the QUERY STRING, which is the half
    // of the request target the log must drop: a caller can park a Student ID
    // or an activity label there and would otherwise have it recorded on any
    // unexpected fault.
    const queryLabel = 'Confidential Chess Club';
    const target =
      `${NAMESPACE}/${KNOWN_STUDENT_ID}` +
      `?studentId=${KNOWN_STUDENT_ID}&activity=${encodeURIComponent(queryLabel)}`;

    // Captured rather than silenced: the assertion is about what the boundary
    // writes, so it has to be read back.
    console.error = (...args) => {
      calls.push(args);
    };
    const response = await get(target);
    console.error = originalConsoleError;

    assert.strictEqual(response.status, 500, `${context}: the request was still answered`);
    assert.strictEqual(calls.length, 1, `${context}: the boundary logs exactly once per fault`);

    const [args] = calls;
    assert.strictEqual(
      args.length,
      1,
      `${context}: one pre-formatted argument — a second argument is how the Error object, its stack and its cause get printed`
    );
    assert.strictEqual(
      typeof args[0],
      'string',
      `${context}: the argument is a string, never the thrown value`
    );

    const line = args[0];
    assert.ok(!line.includes('\n'), `${context}: one line, so nothing can inject a second`);
    assert.ok(
      line.startsWith('request_handler_failed '),
      `${context}: the line opens with the stable event code, but was ${JSON.stringify(line)}`
    );
    assert.ok(
      line.includes(`path=${NAMESPACE}/${KNOWN_STUDENT_ID} `),
      `${context}: the bounded pathname is logged, and the trailing space proves nothing was appended to it`
    );
    assert.ok(
      line.includes('method=GET'),
      `${context}: the method the AAP asks for is logged`
    );
    assert.ok(
      line.includes('code=E_STORE_WRITE_FAILED'),
      `${context}: the allow-listed fault code survives, because it is the whole diagnostic value of the line`
    );

    // Each forbidden substring is a distinct leak the naive line produced:
    // the query string and its values, the thrown message, the nested cause,
    // a stack frame, and a source path.
    for (const forbidden of [
      queryLabel,
      'Confidential',
      '?',
      'studentId=',
      'activity=',
      'induced failure',
      'EACCES',
      ' at ',
      '.js',
      pathInMessage,
      'C:\\',
    ]) {
      assert.ok(
        !line.includes(forbidden),
        `${context}: the log line must not contain ${JSON.stringify(forbidden)}, but was ${JSON.stringify(line)}`
      );
    }

    activities.handle = originalHandle;
    await assertStillServing(context);
  });

  it('destroys the socket rather than corrupting a response already begun', async (t) => {
    const context = 'internal_error after the response has started';
    const originalHandle = activities.handle;
    t.after(() => {
      activities.handle = originalHandle;
    });

    // A rejection AFTER headers are out cannot be corrected into a 500, so the
    // boundary destroys the socket instead. The observable consequence is that
    // the client gets no complete response — which is the honest signal, and is
    // asserted here as a rejection rather than as a status.
    activities.handle = async (req, res) => {
      res.writeHead(200, { 'Content-Type': CONTENT_TYPE_JSON });
      res.write('{"partial":');
      throw new Error('induced failure mid-response');
    };

    await assert.rejects(
      () => get(`${NAMESPACE}/${KNOWN_STUDENT_ID}`),
      `${context}: a response that had already started is destroyed, not rewritten`
    );

    activities.handle = originalHandle;
    await assertStillServing(context);
  });
});


/* ========================================================================= *
 * The composition seam — the exported surface
 *
 * `server.js` exports three symbols and this file is their only caller, so an
 * export nothing reads here is an export nothing reads at all: a drift in
 * either literal would pass unnoticed, and the README documents both of them.
 * The harness already consumes `server` by listening on it, so what these
 * cases add is a consumer for `hostname` and `port`, plus a pin on the export
 * surface itself — the AAP fixes it at exactly these three names.
 *
 * They also record, in passing, that requiring the module bound nothing: the
 * port this suite answers on is the ephemeral one the harness asked for, not
 * the 3000 the export names.
 * ========================================================================= */

describe('the composition seam — the exported surface', () => {
  it('exports exactly the live server, the bound hostname and the bound port', () => {
    const context = 'export surface';

    // THE ACTIVE CHAIN'S MODULE OBJECT, NOT THE LOAD-TIME ONE. `serverModule`
    // at the top of this file is the object the load-time chain published, and
    // `startCaseHarness` has since evicted `../server` and re-required it for
    // this case — that rebinding is required, because it is what lets the
    // `internal_error` cases patch the module the listening server closes over.
    // So the load-time object names an instance nothing is listening on, while
    // this read returns the object the case's own listener was published by.
    // The `require` resolves the registry entry the harness's own `require`
    // just populated rather than building a fourth chain, which is precisely
    // why it yields the live module object.
    const activeModule = require('../server');

    // Pinned on the ACTIVE object for the same reason: a surface checked on a
    // module nothing is serving would not be the surface this suite is served
    // by. The AAP fixes it at exactly these three names.
    assert.deepStrictEqual(
      Object.keys(activeModule).sort(),
      ['hostname', 'port', 'server'],
      `${context}: exactly these three symbols — none missing, and no fourth`
    );
    assert.ok(
      activeModule.server instanceof http.Server,
      `${context}: the exported server is a live http.Server`
    );
    assert.strictEqual(
      activeModule.server,
      server,
      `${context}: it is the very instance this suite listens on, not a copy`
    );
  });

  it('exports the loopback hostname the listener is actually bound to', () => {
    const context = 'exported hostname';

    assert.strictEqual(
      serviceHostname,
      '127.0.0.1',
      `${context}: the bind stays loopback-only, so the literal must be preserved`
    );
    assert.strictEqual(
      serviceHostname,
      HOST,
      `${context}: it is the host this suite connects to`
    );
    assert.strictEqual(
      server.address().address,
      serviceHostname,
      `${context}: the export is the address the listener holds, not one re-derived by the caller`
    );
  });

  it('exports the fixed port 3000, which is not the ephemeral port the harness bound', () => {
    const context = 'exported port';

    assert.strictEqual(typeof servicePort, 'number', `${context}: a number, not a string`);
    assert.strictEqual(servicePort, 3000, `${context}: the preserved literal`);
    assert.strictEqual(
      server.address().port,
      activePort(),
      `${context}: the live port is the one the harness asked the OS for`
    );
    assert.notStrictEqual(
      server.address().port,
      servicePort,
      `${context}: requiring the module bound nothing, so 3000 stays free for test/lifecycle.test.js`
    );
  });
});
