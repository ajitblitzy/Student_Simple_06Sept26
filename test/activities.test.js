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
 * `before` hook — a hook runs long after the module chain has already resolved
 * its path. Getting this order wrong makes the suite write into the working
 * tree, which is why the require of `node:fs` and the `mkdtempSync` below come
 * before the project requires rather than being grouped with them.
 * ------------------------------------------------------------------------- */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** One directory for every artifact this file creates. Removed in `after`. */
const TEMPORARY_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'activities-test-'));

/** The store the shared harness server writes. Absent until a case submits. */
const PRIMARY_STORE_PATH = path.join(TEMPORARY_ROOT, 'activities.json');

process.env.ACTIVITY_STORE = PRIMARY_STORE_PATH;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fsp = require('node:fs/promises');

/**
 * The module object, not a destructured `handle`. Holding the object is what
 * lets the `internal_error` case replace the property that `server.js` reads at
 * call time, and it is deliberately captured here so that a later
 * `freshModuleChain` swap cannot move this reference off the instance the
 * shared harness server closes over.
 */
const activities = require('../activities');

/**
 * The real composed server. Safe to require: `server.js` wraps its `listen`
 * call in `if (require.main === module)`, so loading it binds no port.
 *
 * Driving the real composition rather than a hand-rolled one matters twice
 * over: it is the code that actually ships, and the `internal_error` branch
 * lives in `server.js` and is reachable no other way.
 */
const { server } = require('../server');

/* ------------------------------------------------------------------------- *
 * The contract's vocabulary, as constants rather than repeated literals
 * ------------------------------------------------------------------------- */

const HOST = '127.0.0.1';

const NAMESPACE = '/activities';

const CONTENT_TYPE_JSON = 'application/json; charset=utf-8';
const CONTENT_TYPE_HTML = 'text/html; charset=utf-8';
const MEDIA_TYPE_JSON = 'application/json';
const MEDIA_TYPE_FORM = 'application/x-www-form-urlencoded';

/**
 * The preserved fall-through response, byte for byte. The absent `charset`
 * parameter is deliberate and asserted: the legacy header carries none, and
 * every response the feature adds carries one.
 */
const LEGACY_CONTENT_TYPE = 'text/plain';
const LEGACY_BODY = 'Hello, World Welcome to Sharebot!\n';
const LEGACY_BYTE_LENGTH = 34;

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
 * The agent is destroyed in `after` BEFORE `server.close()`, because a pooled
 * socket left open would keep the listener alive and the runner would hang
 * instead of exiting. With that ordering, close completes in about a
 * millisecond and no `--test-force-exit` is needed.
 * ------------------------------------------------------------------------- */

const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });

/** The shared harness server's ephemeral port, filled in by `before`. */
let sharedPort = 0;

/**
 * Issues one request and resolves with the whole response.
 *
 * Rejects on a socket failure, so a request the server never answers surfaces
 * as a failed assertion rather than as a test that hangs until the runner's
 * ambient timeout. The one exception is a write error that arrives AFTER the
 * response has started: that is the server hanging up on a request it has
 * already refused, so the error is held back and raised only if the response
 * never completes.
 *
 * @param {{method?: string, target?: string, headers?: Record<string, string>,
 *   body?: string|Buffer, port?: number}} [options] `port` defaults to the
 *   shared harness server, so an isolated server is driven by passing its own.
 * @returns {Promise<{status: number, headers: Record<string, string|string[]>,
 *   body: string}>} The status, the response headers, and the body as text.
 */
function request(options = {}) {
  const {
    method = 'GET',
    target = '/',
    headers = {},
    body,
    port: requestPort = sharedPort,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    let deferredError = null;

    const succeed = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const failWith = (error) => {
      if (!settled) {
        settled = true;
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
 * Isolated servers, for the cases that need their own store state
 *
 * Four cases cannot share the harness store: one proves a read never CREATES
 * the file, and three need the store broken in a specific way. Each gets its
 * own directory and its own module chain, so no case can contaminate another
 * and none of them can disturb the shared harness.
 * ------------------------------------------------------------------------- */

/**
 * The feature's module chain, in dependency order. Every one of these must be
 * evicted together: `activity-store.js` captures the store path at load, and
 * `activities.js` and `server.js` each capture the instance below them, so
 * re-requiring only the top of the chain would hand back a server still
 * pointing at the previous store.
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
 * The module-level `activities` and `server` captured at the top of this file
 * are unaffected: they are references to the ORIGINAL objects, and the shared
 * harness server closes over the original `activities` module object. So the
 * `internal_error` patch keeps working no matter how many isolated chains have
 * been built since.
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
 * Starts an isolated server on its own ephemeral port and its own store.
 *
 * @param {string} storePath The store the isolated chain should resolve.
 * @param {() => void} [prepare] Passed through to `freshModuleChain`.
 * @returns {Promise<{port: number, storePath: string, stop: () => Promise<void>}>}
 *   A handle whose `stop` must be registered with the case's own `t.after`.
 */
async function startIsolatedServer(storePath, prepare) {
  const chain = freshModuleChain(storePath, prepare);
  await new Promise((resolve) => chain.server.listen(0, HOST, resolve));

  return {
    port: chain.server.address().port,
    storePath,
    async stop() {
      const closed = new Promise((resolve) => chain.server.close(resolve));
      // Pooled keep-alive sockets would otherwise hold this listener open and
      // `close` would never call back.
      chain.server.closeAllConnections();
      await closed;
      // Leave the variable as the rest of the file expects to find it. The
      // shared harness resolved its own path at load and is indifferent, but a
      // later isolated chain reads this value's replacement, not this one.
      process.env.ACTIVITY_STORE = PRIMARY_STORE_PATH;
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
 * Asserts a response body carries no stack trace, filesystem path or other
 * internal detail.
 *
 * @param {string} body The body to inspect.
 * @param {string} context The case name, for the failure message.
 * @returns {void}
 */
function assertNoInternalDetail(body, context) {
  for (const marker of INTERNAL_DETAIL_MARKERS) {
    assert.ok(
      !body.includes(marker),
      `${context}: the response must not leak internal detail, but it contains ${JSON.stringify(marker)}: ${body}`
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
    return assert.fail(`${context}: body was not valid JSON (${error.message}): ${response.body}`);
  }
}

/**
 * Asserts the full error envelope: status, JSON content type, exactly the two
 * keys, the code, a non-empty fixed sentence, and no leaked internal detail.
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
  assert.ok(payload.message.length > 0, `${context}: message is non-empty`);
  assertNoInternalDetail(response.body, context);

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
  assert.ok(
    !response.body.includes('<script'),
    `${context}: the page must carry no client-side script`
  );
  return response.body;
}

/**
 * Asserts a form-mode validation failure: the HTML page, in its error state,
 * naming the same code the JSON envelope would have carried.
 *
 * A person reading the page and a script reading the envelope get the same
 * diagnosis in the same words, which is the property worth pinning — and the
 * code in the page is what makes the assertion specific rather than merely
 * "some error was rendered".
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
    markup.includes('class="error"'),
    `${context}: the page must be in its error state`
  );
  return markup;
}

/**
 * Asserts the preserved fall-through response, byte for byte.
 *
 * @param {object} response A response from `request`.
 * @param {string} context The case name.
 * @returns {void}
 */
function assertLegacyResponse(response, context) {
  assert.strictEqual(response.status, 200, `${context}: the legacy status`);
  assert.strictEqual(
    response.headers['content-type'],
    LEGACY_CONTENT_TYPE,
    `${context}: the legacy header carries NO charset parameter`
  );
  assert.strictEqual(response.body, LEGACY_BODY, `${context}: the legacy body, verbatim`);
  assert.strictEqual(
    Buffer.byteLength(response.body),
    LEGACY_BYTE_LENGTH,
    `${context}: the legacy body is exactly ${LEGACY_BYTE_LENGTH} bytes`
  );
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
 * The shared harness
 * ------------------------------------------------------------------------- */

before(async () => {
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  sharedPort = server.address().port;

  assert.ok(sharedPort > 0, 'the harness must have been given an ephemeral port');
  assert.notStrictEqual(
    sharedPort,
    3000,
    'this file must never bind the literal port 3000 — test/lifecycle.test.js owns it'
  );
});

after(async () => {
  // Order matters: pooled sockets first, then the listener, or `close` never
  // calls back and the runner hangs instead of exiting on its own.
  agent.destroy();
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;

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
    for (const forbidden of ['<script', '<link', 'src=', '@import', 'url(']) {
      assert.ok(
        !markup.includes(forbidden),
        `${context}: the page must not contain ${JSON.stringify(forbidden)}`
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
 * POST /activities — the success paths
 *
 * These cases WRITE, so each one owns a label no other case submits, and the
 * multi-step cases perform both steps themselves rather than relying on a
 * predecessor. The shared store begins every run absent, because the temporary
 * root is freshly created at load, so nothing carries over between runs either.
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

    const payload = parseJsonResponse(response, context);
    assert.deepStrictEqual(
      Object.keys(payload).sort(),
      ['created', 'record'],
      `${context}: the success envelope is exactly created and record`
    );
    assert.strictEqual(payload.created, true, `${context}: created is true`);
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
    assert.strictEqual(repeat.status, 200, `${context}: a repeat is 200, not 201`);
    assert.strictEqual(
      repeat.headers.location,
      undefined,
      `${context}: Location is sent only with the 201`
    );

    const payload = parseJsonResponse(repeat, context);
    assert.strictEqual(payload.created, false, `${context}: created is false`);
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
    assert.strictEqual(variant.status, 200, `${context}: a case variant is recognized, not appended`);

    const payload = parseJsonResponse(variant, context);
    assert.strictEqual(payload.created, false, `${context}: created is false`);
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
    assert.strictEqual(response.status, 200, `${context}: nothing is added for a label already on record`);

    const payload = parseJsonResponse(response, context);
    assert.strictEqual(payload.created, false, `${context}: created is false`);
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
    assertHtmlPage(first, 201, `${context} (first)`);

    const repeat = await postForm('S002', label);
    const markup = assertHtmlPage(repeat, 200, context);
    assert.ok(
      markup.includes(label),
      `${context}: the already-recorded page names the activity`
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

    assert.strictEqual(response.status, 201, `${context}: the submission is accepted`);
    const record = parseJsonResponse(response, context).record;

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
    assert.strictEqual(
      persisted.source,
      SOURCE_SUBMISSION,
      `${context}: what was STORED carries the server's source, not the client's`
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

      assert.strictEqual(response.status, 201, `${context}: accepted as JSON`);
      const payload = parseJsonResponse(response, context);
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

describe('every path outside the namespace keeps the preserved response', () => {
  for (const outside of ['/', '/nonsense', '/activities-old', '/activitieslist', '/activitiesx', '/index.html', '/students/S001']) {
    it(`serves the 34-byte plaintext greeting for ${outside}`, async () => {
      const context = `GET ${outside}`;
      const response = await get(outside);

      // The previously universal response is NARROWED, not replaced. A path
      // that merely shares the namespace's characters as text is not claimed,
      // which is precisely what a loose route predicate would break.
      assertLegacyResponse(response, context);
    });
  }

  it('keeps the preserved response for a non-GET method outside the namespace', async () => {
    const context = 'POST /activities-old';
    const response = await request({
      method: 'POST',
      target: '/activities-old',
      headers: { 'Content-Type': MEDIA_TYPE_JSON },
      body: JSON.stringify({ studentId: KNOWN_STUDENT_ID, activity: 'Chess Club' }),
    });

    // Outside the namespace the method is irrelevant, exactly as it was before
    // the feature existed.
    assertLegacyResponse(response, context);
  });
});


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

    // `assertHtmlPage` already refuses any occurrence of "<script"; these
    // assertions additionally prove the value was RENDERED, escaped, rather
    // than silently dropped — a page that discarded it would also pass the
    // absence check on its own.
    const markup = assertHtmlPage(response, 201, context);
    assert.ok(markup.includes('&lt;script&gt;'), `${context}: the opening tag is escaped`);
    assert.ok(markup.includes('&lt;/script&gt;'), `${context}: the closing tag is escaped`);
    assert.ok(!markup.includes('<script'), `${context}: no raw script tag survives`);
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
 * disk. Each has its own case, each induces its fault by a real mechanism
 * rather than by asserting on a mock, and each is followed by a probe proving
 * the service is STILL SERVING — a failure mode that kills the process must not
 * be able to pass here.
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
    // Deliberately never created, so BOTH the staging write and the rename fail.
    const storePath = path.join(directory, 'absent-subdirectory', 'activities.json');

    const isolated = await startIsolatedServer(storePath);
    t.after(() => isolated.stop());

    const refused = await postJson(
      { studentId: KNOWN_STUDENT_ID, activity: 'Luge Club' },
      { port: isolated.port }
    );
    assertErrorEnvelope(refused, 500, 'store_write_failed', context);

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

    // The first two column reads fail, every later one delegates to the real
    // reader. Two, because both routes are exercised and each makes exactly one
    // key-set read before giving up.
    let failuresRemaining = 2;
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

    assert.strictEqual(inducedFailures, 2, `${context}: both routes really did attempt the read`);

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
    // here. `server.js` logs the induced error to stderr, which is expected
    // output for this case and not a failure.
    activities.handle = async () => {
      throw new Error('induced handler failure');
    };

    const response = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}`);

    assert.strictEqual(response.status, 500, `${context}: status`);
    assert.strictEqual(
      response.headers['content-type'],
      CONTENT_TYPE_JSON,
      `${context}: the boundary answers in JSON`
    );

    const payload = JSON.parse(response.body);
    // The boundary envelope carries the code and NOTHING ELSE — deliberately
    // one key, not the two-key envelope `activities.js` sends. Pinned exactly,
    // because a `message` appearing here would mean the boundary had started
    // describing a fault it cannot safely describe.
    assert.deepStrictEqual(
      Object.keys(payload),
      ['error'],
      `${context}: the boundary body is exactly { error }`
    );
    assert.strictEqual(payload.error, 'internal_error', `${context}: the code`);

    assertNoInternalDetail(response.body, context);
    assert.ok(
      !response.body.includes('induced'),
      `${context}: the underlying error message must not reach the client`
    );

    activities.handle = originalHandle;

    const recovered = await get(`${NAMESPACE}/${KNOWN_STUDENT_ID}`);
    assert.strictEqual(recovered.status, 200, `${context}: a normal request still succeeds`);
    parseJsonResponse(recovered, `${context} (recovered)`);
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

