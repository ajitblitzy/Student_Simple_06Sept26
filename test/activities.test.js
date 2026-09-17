'use strict';

/**
 * test/activities.test.js - the evidence that the extracurricular-activity
 * feature works, exercised in-process on an ephemeral port.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The feature was derived from data the repository already carried but never
 * reached: `Extracurricular Activity` in column C of `student_other_info.xlsx`
 * and `Student ID` in column A of all three workbooks. Functionality without
 * evidence is unproven, so this file is that evidence - three JSON endpoints,
 * several activities per student, the write path, and referential integrity
 * enforced against the student directory.
 *
 * WHERE THE ASSERTED VALUES COME FROM
 * ---------------------------------------------------------------------------
 * Three provenances, kept distinct on purpose:
 *   - Committed data. Every student, name, activity and roster expectation for
 *     the real dataset was read out of the workbooks (`Student Details!A2:B11`,
 *     `Other Info!A2:A11`/`C2:C11`), never invented: `S001` is `Aarav Sharma`
 *     holding `Robotics Club`, `S003` is `Rohan Iyer` holding `Football Team`,
 *     and the roster is the eight groups those ten rows produce.
 *   - The wire contract. Statuses, error codes, the fixed error sentences, the
 *     `Allow` values, the media types and the 8 KiB body cap are the contract
 *     the feature promises, so they are written out here verbatim rather than
 *     derived from the data.
 *   - Synthetic values, never claimed to be workbook data. `Chess Club` is an
 *     activity no student holds, which is what makes it usable both as a
 *     request value - a filter that must match nothing, an activity a write may
 *     add - and inside injected fixtures. `Ishaan Nair` is a name given to
 *     `S009` in the case-folding fixture only (the workbook's own `S009` is
 *     `Arjun Kapoor`, a value this file deliberately does not depend on, so the
 *     fixture cannot be mistaken for the committed row).
 *
 * WHAT IT RUNS AGAINST
 * ---------------------------------------------------------------------------
 * `start()` from `server.js` - the single composition root - so the wiring
 * under test is the wiring that ships. What EVERY in-process server has in
 * common is registry isolation: each is constructed with BOTH dependencies
 * injected, so the server's own resolved `activitiesDataPath` is never opened,
 * and the repository it is handed writes to a throwaway registry under
 * `os.tmpdir()` rather than to the committed `activities.json`. How that
 * repository is built differs by case:
 *   - Committed-data cases build it with `studentDirectory.load` and
 *     `activityRepository.load` - production code reading the production
 *     workbooks - and change nothing but that registry path.
 *   - Otherwise-unreachable cases substitute it through
 *     `studentDirectory.fromRows`, `activityRepository.fromData` and its
 *     `writeFile` seam: a student holding no activity, a label collision that
 *     folds case, a registry or directory fault, and a writer that fails. Those
 *     use synthetic rows rather than a new binary fixture, which is the whole
 *     reason the seams exist.
 *
 * NON-NEGOTIABLE PROPERTIES OF THIS FILE
 * ---------------------------------------------------------------------------
 *   - EXACTLY 33 top-level tests, with no subtest, no `describe` and no `it`.
 *     Root `verify-tests.js` gates on `test:summary.counts.passed >= MIN_TESTS`
 *     with `MIN_TESTS` 45 = 33 + 8 + 4, and `README.md` documents
 *     `MIN_TESTS=46 npm test` exiting 1 as the proof that the guard is live.
 *     Subtests and `it`s count toward `passed`, so one extra declaration here
 *     would inflate the total and void that proof. Every multi-case behaviour
 *     is therefore a `for...of` case table inside ONE test body, with the case
 *     named in each assertion message so a failure stays diagnosable.
 *   - Every server binds `port: 0`. `test/server.test.js` is the suite's only
 *     binder of the default port; a second binder would fail `EADDRINUSE` and
 *     surface as *cancelled* tests naming neither the port nor the conflict.
 *   - Nothing is written inside the working tree. Every test that writes points
 *     `activitiesDataPath` at its own `fs.mkdtempSync` directory under
 *     `os.tmpdir()`, and the single `after` hook removes all of them - which is
 *     what keeps `git status --porcelain` identical across a run and what
 *     `test/workbooks.test.js` asserts when it looks for leftovers.
 *   - No assertion lives in a hook, because hook assertions do not count
 *     toward `counts.passed`. Hooks do setup and cleanup only.
 *   - No child process is spawned here; that belongs to `test/server.test.js`.
 *   - Zero dependencies: `node:` built-ins and the modules under test.
 *   - Every wait is bounded. `request` and `startServer` both carry deadlines,
 *     so a response that is never ended or a `listen` that never settles fails
 *     with what it was waiting for named instead of hanging the runner.
 *
 * The error contract is deterministic by design - one fixed sentence per code,
 * with the offending value interpolated after a colon - so the sentences are
 * asserted verbatim. A "contains" assertion would let a message drift. The
 * media type is held to the same standard: `Content-Type` is parsed to its
 * media type and compared exactly, because a substring test is satisfied by
 * `foo/application/jsonp`.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createServer, start } = require('../server');
const studentDirectory = require('../lib/studentDirectory');
const activityRepository = require('../lib/activityRepository');
const { readWorksheetRows } = require('../lib/workbook');

/* ---------------------------------------------------------------------------
 * Constants: the wire contract, the committed data, and the harness.
 * ------------------------------------------------------------------------- */

/** The checkout root, where the workbooks sit beside `server.js`. */
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * A short, stable token naming THIS checkout, derived from the absolute path of
 * its root so that two working trees of this repository never share it.
 *
 * Twelve hex characters of a SHA-256 over the root path: long enough that a
 * collision between two checkouts is not a practical concern, short enough to
 * keep a temporary directory name readable. The path is lower-cased first
 * because Windows path comparison is case-insensitive, so the same tree reached
 * through a differently-cased path must still yield the same token.
 */
const CHECKOUT_TOKEN = crypto
  .createHash('sha256')
  .update(REPO_ROOT.toLowerCase())
  .digest('hex')
  .slice(0, 12);

/**
 * The `fs.mkdtempSync` prefix for every throwaway registry directory.
 *
 * `os.tmpdir()` is HOST-WIDE, and up to 64 separate checkouts of this
 * repository run their suites side by side under that one temp root, so a bare
 * `student-activities-` prefix would put every one of them in a single
 * namespace - and `test/workbooks.test.js` fails its run if an entry with this
 * prefix survives there. Embedding `CHECKOUT_TOKEN` makes the namespace private
 * to this working tree, so a directory this file is legitimately mid-write on
 * can never fail a sibling checkout's suite, nor its suite fail this one's.
 *
 * `test/workbooks.test.js` derives the same value from the same input with the
 * identical expression. It has to be derived rather than shared: a helper
 * module cannot hold it - every `.js` file inside a directory named `test/` is
 * executed as a test by default discovery - and the two files run in separate
 * child processes, so a path computed from `__dirname` is the only thing they
 * can be relied on to agree about. The derivation MUST STAY IN STEP WITH
 * `test/workbooks.test.js`: changing it here without changing it there turns
 * that file's leftover check into one that can never fail.
 */
const TEMP_PREFIX = `student-activities-${CHECKOUT_TOKEN}-`;

/** The registry filename every temporary directory holds. */
const REGISTRY_FILENAME = 'activities.json';

/** The shipped registry state, and the seed every write test starts from. */
const EMPTY_REGISTRY = '[]\n';

/** Loopback only, and never the default port - see the header. */
const LOOPBACK_HOST = '127.0.0.1';

/** The ephemeral-port selector. `resolveConfig` preserves `0` deliberately. */
const EPHEMERAL_PORT = 0;

const JSON_MEDIA_TYPE = 'application/json';
const TEXT_MEDIA_TYPE = 'text/plain';

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

/** The routes under test, written out so a typo cannot become a `404` pass. */
const ROOT_PATH = '/';
const ACTIVITIES_PATH = '/api/activities';
const S001_PATH = '/api/students/S001/activities';
const S003_PATH = '/api/students/S003/activities';
const S999_PATH = '/api/students/S999/activities';

/** The baseline greeting, byte for byte, including the trailing newline. */
const GREETING = 'Hello, World Welcome to Sharebot!\n';

/** 34 - asserted as the `Content-Length` of `HEAD /`. */
const GREETING_BYTE_LENGTH = Buffer.byteLength(GREETING);

/** The 8 KiB body cap `lib/activityRoutes.js` enforces. */
const MAX_BODY_BYTES = 8192;

/** Comfortably over the cap, in a single `req.end()` write. */
const OVERSIZE_BODY_BYTES = 9000;

/** One character over the 64-character activity limit. */
const OVERLONG_ACTIVITY = 'x'.repeat(65);

/** Error codes, as `lib/activityRoutes.js` and `server.js` emit them. */
const CODE_INVALID_STUDENT_ID = 'INVALID_STUDENT_ID';
const CODE_MALFORMED_JSON = 'MALFORMED_JSON';
const CODE_INVALID_ACTIVITY = 'INVALID_ACTIVITY';
const CODE_UNEXPECTED_FIELD = 'UNEXPECTED_FIELD';
const CODE_STUDENT_NOT_FOUND = 'STUDENT_NOT_FOUND';
const CODE_NOT_FOUND = 'NOT_FOUND';
const CODE_METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED';
const CODE_ACTIVITY_ALREADY_RECORDED = 'ACTIVITY_ALREADY_RECORDED';
const CODE_PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE';
const CODE_UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE';
const CODE_INTERNAL_ERROR = 'INTERNAL_ERROR';

/** The fixed sentences that carry no interpolated value. */
const MESSAGE_MALFORMED_JSON = 'Request body is not valid JSON';
const MESSAGE_INVALID_ACTIVITY = 'activity must be a string of 1 to 64 characters';
const MESSAGE_PAYLOAD_TOO_LARGE = `Request body exceeds ${MAX_BODY_BYTES} bytes`;
const MESSAGE_UNSUPPORTED_MEDIA_TYPE = `Content-Type must be ${JSON_MEDIA_TYPE}`;
const MESSAGE_INTERNAL_ERROR = 'Could not persist the activity record';

/** `Allow` values: exact and ordered, because the order is part of the contract. */
const ALLOW_ROOT = 'GET, HEAD';
const ALLOW_ACTIVITIES = 'GET, HEAD';
const ALLOW_STUDENT_ACTIVITIES = 'GET, HEAD, POST';

/** Fatal-load discriminators raised by the modules under test. */
const CODE_DIRECTORY_INVALID = 'STUDENT_DIRECTORY_INVALID';
const CODE_REPOSITORY_INVALID = 'ACTIVITY_REPOSITORY_INVALID';
const CODE_WORKBOOK_READ_FAILED = 'WORKBOOK_READ_FAILED';

/**
 * The header rows `lib/workbook.js` puts at index 0 of what it returns, so an
 * injected row set has to carry them too or the loaders reject it.
 */
const DIRECTORY_HEADER_ROW = { A: 'Student ID', B: 'Name' };
const ACTIVITY_HEADER_ROW = {
  A: 'Student ID',
  B: 'Hostel Status',
  C: 'Extracurricular Activity'
};

/** `Student Details!A2:B11` values this file depends on. */
const S001_NAME = 'Aarav Sharma';
const S003_NAME = 'Rohan Iyer';

/** `Other Info!C2:C11` values this file depends on. */
const S001_ACTIVITY = 'Robotics Club';
const S003_ACTIVITY = 'Football Team';

/**
 * An activity `S003` does not hold, used wherever a write must succeed. `S004`
 * holds `Music Club` in the workbook column, which is exactly why it works
 * here: record identity is the `(studentId, activityKey)` pair, so the same
 * activity name is free for every student who does not already hold it.
 */
const NEW_ACTIVITY = 'Music Club';

/** An activity absent from the workbook column, for the injected cases. */
const UNUSED_ACTIVITY = 'Chess Club';

/** The committed per-student answer for `S001`, with the registry empty. */
const S001_PAYLOAD = {
  studentId: 'S001',
  name: S001_NAME,
  count: 1,
  activities: [{ activity: S001_ACTIVITY, source: 'workbook' }]
};

/**
 * The complete committed roster: eight groups in `activityKey` ascending order,
 * ten records in total, with `Robotics Club` and `Debate Society` holding the
 * two multi-member groups the reverse lookup exists for.
 */
const FULL_ROSTER = [
  { activity: 'Coding Club', count: 1, studentIds: ['S005'] },
  { activity: 'Cricket Team', count: 1, studentIds: ['S007'] },
  { activity: 'Dance Club', count: 1, studentIds: ['S006'] },
  { activity: 'Debate Society', count: 2, studentIds: ['S002', 'S010'] },
  { activity: 'Football Team', count: 1, studentIds: ['S003'] },
  { activity: 'Music Club', count: 1, studentIds: ['S004'] },
  { activity: 'Photography Club', count: 1, studentIds: ['S008'] },
  { activity: 'Robotics Club', count: 2, studentIds: ['S001', 'S009'] }
];

/** Eight groups over ten records - both asserted, because both can drift. */
const EXPECTED_GROUP_COUNT = 8;
const EXPECTED_RECORD_COUNT = 10;

/**
 * Directory columns the feature parses and then discards. Neither the names nor
 * the distinctive values of `S001`'s row may appear in any payload. Only
 * distinctive strings are listed: the `Age` value `20` is deliberately absent
 * because a bare numeral collides with unrelated digits and would flap.
 */
const EXCLUDED_COLUMN_NAMES = [
  'Gender',
  'Date of Birth',
  'Age',
  'Department',
  'Year',
  'Email',
  'Phone',
  'City'
];
const EXCLUDED_VALUES = [
  'Male',
  '2006-03-14',
  'Computer Science',
  'aarav.sharma@example.edu',
  '9822011001',
  'Pune'
];

/**
 * The suffix the atomic writer gives its scratch file: it writes
 * `<registry>.tmp` beside the target and renames that over the registry, and
 * removes it again when a write fails. The literal is `TEMPORARY_SUFFIX` in
 * `lib/activityRepository.js` and is duplicated here because the module does
 * not export it; test 22 reproduces that exact path, so the two MUST STAY IN
 * STEP - a rename there with no change here would leave test 22 asserting the
 * absence of a file production never creates.
 */
const REGISTRY_TEMPORARY_SUFFIX = '.tmp';

/**
 * Deadlines. Every wait in this file is bounded, because an unbounded one turns
 * a server regression - a response that is never ended, a `listen` that never
 * settles - into a test process that hangs instead of a failure naming what it
 * was waiting for. Both values are orders of magnitude above the real figures
 * on this host (a whole 33-test run is roughly 300 ms, and a load reads two
 * 6 KB workbooks), so neither can fire on a merely busy machine.
 */
const REQUEST_DEADLINE_MS = 10000;
const START_DEADLINE_MS = 15000;

/* ---------------------------------------------------------------------------
 * Inline harness. No assertion appears below this line until the first test.
 * ------------------------------------------------------------------------- */

/** Every listening server this file started, closed by the `after` hook. */
const servers = [];

/**
 * Set the moment the `after` hook begins draining `servers`. The array is
 * drained exactly once, so anything that arrives afterwards would never be
 * closed - a late bind has to close itself instead, and this flag is how it
 * knows to.
 */
let teardownStarted = false;

/** Every temporary directory this file created, removed by the `after` hook. */
const tempDirs = [];

/**
 * The read-only server shared by the tests that never write. Built in `before`
 * because building it eleven times would read the workbooks eleven times for
 * data that cannot change under a running process.
 */
let sharedServer = null;

/**
 * Creates a throwaway directory under the system temp root and remembers it for
 * cleanup. Nothing this file writes ever lands inside the checkout.
 *
 * @returns {string} The absolute path of the new directory.
 */
const mkTemp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  tempDirs.push(directory);
  return directory;
};

/**
 * Seeds an empty registry file in its own temporary directory, which is the
 * state `activities.json` ships in.
 *
 * @returns {string} The absolute path of the seeded registry file.
 */
const seedRegistry = () => {
  const file = path.join(mkTemp(), REGISTRY_FILENAME);
  fs.writeFileSync(file, EMPTY_REGISTRY, 'utf8');
  return file;
};

/**
 * Rejects if `promise` has not settled within `milliseconds`, naming what the
 * wait was for. The timer is cleared on either outcome, so a settled wait never
 * holds the event loop open and the runner still exits without
 * `--test-force-exit`.
 *
 * @param {Promise<T>} promise The wait to bound.
 * @param {number} milliseconds The deadline.
 * @param {string} description What is being waited for, for the failure message.
 * @returns {Promise<T>} The original outcome, or a rejection at the deadline.
 * @template T
 */
const withDeadline = (promise, milliseconds, description) => {
  let timer = null;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${milliseconds} ms waiting for ${description}`));
    }, milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
};

/**
 * Closes a listening server and resolves once it is closed. Idle keep-alive
 * sockets would otherwise hold `close()` open, and dropping them is what lets
 * the runner exit without `--test-force-exit`.
 *
 * @param {import('node:http').Server} server A listening server.
 * @returns {Promise<void>} Resolves when the server has closed.
 */
const closeServer = (server) => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
});

/**
 * Starts a server on an ephemeral loopback port through the real composition
 * root and remembers it for cleanup.
 *
 * Ownership of a late bind is settled on the underlying promise, because the
 * deadline can fail this call while `listen` is still in flight. Three
 * outcomes, and none of them leaves a listening handle behind:
 *   - it resolves in time, and the server joins `servers` for the `after` hook;
 *   - it resolves after this call gave up, or after teardown has already
 *     drained `servers`, and closes itself - `unref()` first, so the handle
 *     cannot hold the event loop open for even the moment `close()` takes;
 *   - it rejects, and the same handler absorbs the rejection, which would
 *     otherwise surface as an unhandled rejection detached from any test.
 *
 * @param {object} options Overrides passed straight to `start`, typically an
 *   injected `directory` and `repository`.
 * @returns {Promise<import('node:http').Server>} The listening server.
 */
const startServer = async (options) => {
  let abandoned = false;
  const pending = start({ port: EPHEMERAL_PORT, host: LOOPBACK_HOST, ...options });
  pending.then(
    (server) => {
      if (abandoned || teardownStarted) {
        server.unref();
        closeServer(server).catch(() => {});
        return;
      }
      servers.push(server);
    },
    () => {}
  );
  try {
    return await withDeadline(
      pending,
      START_DEADLINE_MS,
      `start() to bind an ephemeral port on ${LOOPBACK_HOST}`
    );
  } catch (error) {
    // The deadline fired, or the bind failed: whatever `listen` does from here
    // has no owner, so the handler above disowns it instead of queueing it for a
    // drain that may already have happened.
    abandoned = true;
    throw error;
  }
};

/**
 * Issues one request and resolves the whole response.
 *
 * `agent: false` opts out of the global agent's connection pooling, so no
 * keep-alive socket outlives the request and `server.close()` cannot stall.
 *
 * A request-side `'error'` is only fatal while no response has been seen: an
 * early rejection (`413`, `415`, `404` before the body is read) is answered
 * while the client may still be writing, which can surface as `ECONNRESET` or
 * `EPIPE` on the write side. Failing on that would replace the assertion the
 * test is actually making with an unrelated socket error.
 *
 * The wait is bounded by `REQUEST_DEADLINE_MS`. A handler that accepts the
 * connection and never ends its response - or ends the headers and never the
 * body - would otherwise stall this promise forever and take the whole test
 * process with it; the deadline destroys the socket and fails with the method
 * and path named, which is a diagnosis rather than a hang.
 *
 * @param {import('node:http').Server} server A listening server.
 * @param {{method?: string, path: string, headers?: object, body?: string}} options
 *   The request to issue.
 * @returns {Promise<{status: number, headers: object, text: string, bytes: number}>}
 *   The status, the response headers, the body as UTF-8 text, and the exact
 *   number of body bytes received - which is how `HEAD` is proved bodiless.
 */
const request = (server, options) => new Promise((resolve, reject) => {
  const settings = options === undefined ? {} : options;
  const method = settings.method === undefined ? METHOD_GET : settings.method;
  let responded = false;
  let settled = false;
  let timer = null;
  // One settlement only, and it always clears the timer: the deadline, a socket
  // error and a completed response all race, and whichever arrives first is the
  // outcome.
  const settle = (outcome, value) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    outcome(value);
  };
  const req = http.request(
    {
      host: LOOPBACK_HOST,
      port: server.address().port,
      path: settings.path,
      method,
      headers: settings.headers,
      agent: false
    },
    (res) => {
      responded = true;
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        chunks.push(chunk);
        bytes += chunk.length;
      });
      res.on('error', (error) => settle(reject, error));
      res.on('end', () => {
        settle(resolve, {
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
          bytes
        });
      });
    }
  );
  timer = setTimeout(() => {
    // Destroying the request tears down the socket, so the server is not left
    // writing into a response nobody is reading.
    req.destroy();
    settle(
      reject,
      new Error(
        `${method} ${settings.path} did not complete within ${REQUEST_DEADLINE_MS} ms` +
          `${responded ? ' (headers arrived; the body never ended)' : ' (no response at all)'}`
      )
    );
  }, REQUEST_DEADLINE_MS);
  req.on('error', (error) => {
    if (!responded) settle(reject, error);
  });
  if (settings.body === undefined) req.end();
  else req.end(settings.body);
});

/**
 * Parses a response body as JSON.
 *
 * @param {{text: string}} res A resolved response.
 * @returns {unknown} The parsed body.
 */
const json = (res) => JSON.parse(res.text);

/**
 * The media type of a response: the part of `Content-Type` before any
 * parameter, trimmed and case-folded, which is exactly how the contract defines
 * it - `application/json; charset=utf-8` is `application/json`.
 *
 * A missing header yields the empty string rather than `'undefined'`, so an
 * omitted `Content-Type` fails the comparison instead of accidentally matching
 * a stringified value.
 *
 * @param {{headers: object}} res A resolved response.
 * @returns {string} The parsed media type.
 */
const mediaTypeOf = (res) => {
  const header = res.headers['content-type'];
  if (typeof header !== 'string') return '';
  return header.split(';')[0].trim().toLowerCase();
};

/**
 * Asserts a response's media type EXACTLY, after parsing.
 *
 * Deliberately not a substring test: `includes('application/json')` is
 * satisfied by `foo/application/jsonp`, so a response that violates the media
 * type contract would keep the suite green. Called from test bodies only -
 * never from a hook - so its assertions count toward the run.
 *
 * @param {{headers: object}} res A resolved response.
 * @param {string} expected The media type the contract promises.
 * @param {string} label What the response is, for the failure message.
 * @returns {void}
 */
const assertMediaType = (res, expected, label) => {
  assert.equal(
    mediaTypeOf(res),
    expected,
    `${label}: Content-Type must parse to exactly "${expected}"; ` +
      `header was ${JSON.stringify(res.headers['content-type'])}`
  );
};

/**
 * Builds the error envelope every failure carries - exactly two keys, `code`
 * then `message`, in that order, so the same helper serves `deepEqual` on the
 * parsed body and `equal` on the raw text.
 *
 * @param {string} code The stable error code.
 * @param {string} message The fixed sentence for that code.
 * @returns {{error: {code: string, message: string}}} The envelope.
 */
const errorBody = (code, message) => ({ error: { code, message } });

/**
 * Issues a `POST` with an explicit body and media type.
 *
 * @param {import('node:http').Server} server A listening server.
 * @param {string} target The request path.
 * @param {string} body The raw request body.
 * @param {string} [contentType] The media type, `application/json` by default.
 * @returns {Promise<object>} The resolved response.
 */
const postRaw = (server, target, body, contentType) => request(server, {
  method: METHOD_POST,
  path: target,
  headers: { 'Content-Type': contentType === undefined ? JSON_MEDIA_TYPE : contentType },
  body
});

/**
 * Issues a `POST` whose body is the JSON serialization of `payload`.
 *
 * @param {import('node:http').Server} server A listening server.
 * @param {string} target The request path.
 * @param {unknown} payload The value to serialize as the body.
 * @returns {Promise<object>} The resolved response.
 */
const postJson = (server, target, payload) => postRaw(server, target, JSON.stringify(payload));

/**
 * Builds the production dependency pair from the committed workbooks, with the
 * registry redirected at a throwaway file.
 *
 * @param {string} registryPath An absolute path inside a temporary directory.
 * @returns {{directory: object, repository: object}} The injectable pair.
 */
const realDeps = (registryPath) => {
  const directory = studentDirectory.load({ workbookDir: REPO_ROOT });
  const repository = activityRepository.load({
    workbookDir: REPO_ROOT,
    activitiesDataPath: registryPath,
    directory
  });
  return { directory, repository };
};

/**
 * Seeds a registry, wires the real dependencies to it and starts a server -
 * the setup every write test needs in its own isolation.
 *
 * @returns {Promise<{server: object, registryPath: string}>} The server and the
 *   registry file it will rewrite.
 */
const startWritableServer = async () => {
  const registryPath = seedRegistry();
  const server = await startServer(realDeps(registryPath));
  return { server, registryPath };
};

/**
 * Sorts an object's own keys, which is how a payload's exact key set is pinned.
 *
 * @param {object} value Any object.
 * @returns {string[]} Its own enumerable keys, sorted.
 */
const sortedKeys = (value) => Object.keys(value).sort();

before(async () => {
  sharedServer = await startServer(realDeps(seedRegistry()));
});

after(async () => {
  // Flagged before the drain, not after it: a `listen` still in flight must
  // close itself rather than join an array nothing will read again.
  teardownStarted = true;
  while (servers.length > 0) {
    await closeServer(servers.pop());
  }
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    // Retries cover a Windows handle that has not been released yet. A survivor
    // here fails `test/workbooks.test.js`, which is the intended alarm.
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/* ---------------------------------------------------------------------------
 * Tests 1-11: the read paths, served from the committed workbooks.
 * ------------------------------------------------------------------------- */

test('1 activity lookup for a known Student ID returns the workbook record', async () => {
  const res = await request(sharedServer, { path: S001_PATH });
  assert.equal(res.status, STATUS_OK, `GET ${S001_PATH} must succeed; body was ${res.text}`);
  assertMediaType(res, JSON_MEDIA_TYPE, `GET ${S001_PATH}`);
  // deepEqual pins the exact key set as well as the values: an extra key in the
  // payload fails here, which is what keeps a discarded directory column out.
  assert.deepEqual(json(res), S001_PAYLOAD);
});

test('2 the Student ID path segment is trimmed and case-folded before lookup', async () => {
  const cases = [
    ['lowercase', '/api/students/s001/activities'],
    ['surrounding encoded spaces', '/api/students/%20S001%20/activities']
  ];
  for (const [label, target] of cases) {
    const res = await request(sharedServer, { path: target });
    assert.equal(res.status, STATUS_OK, `${label}: ${target} must succeed; body was ${res.text}`);
    // The response carries the normalized identifier, never the spelling sent.
    assert.deepEqual(json(res), S001_PAYLOAD, `${label}: ${target} must answer as S001 does`);
  }
});

test('3 a malformed Student ID is rejected with the exact 400 envelope', async () => {
  const expected = errorBody(
    CODE_INVALID_STUDENT_ID,
    'Student ID must match S followed by three digits: XYZ'
  );
  const res = await request(sharedServer, { path: '/api/students/XYZ/activities' });
  assert.equal(
    res.status,
    STATUS_BAD_REQUEST,
    `a malformed ID must be a 400; body was ${res.text}`
  );
  assert.deepEqual(json(res), expected);
  // The raw text pins the documented key order - `code` before `message` - which
  // a deepEqual on the parsed body cannot see.
  assert.equal(res.text, JSON.stringify(expected));

  // The 64-character cap belongs to an identifier `<value>` and to nothing
  // else: a `<path>` is rendered in full (test 26). An overlong segment is
  // sliced at exactly 64 characters, with no ellipsis and no other marker.
  const overlong = 'X'.repeat(80);
  const capped = await request(sharedServer, { path: `/api/students/${overlong}/activities` });
  assert.equal(
    capped.status,
    STATUS_BAD_REQUEST,
    `an overlong identifier must be a 400; body was ${capped.text}`
  );
  assert.deepEqual(
    json(capped),
    errorBody(
      CODE_INVALID_STUDENT_ID,
      `Student ID must match S followed by three digits: ${'X'.repeat(64)}`
    ),
    'the identifier in the message must be sliced at exactly 64 characters'
  );
});

test('4 a well-formed but unknown Student ID is a 404, not a 400', async () => {
  const expected = errorBody(CODE_STUDENT_NOT_FOUND, 'No student with Student ID S999');
  const res = await request(sharedServer, { path: S999_PATH });
  assert.equal(res.status, STATUS_NOT_FOUND, `an unknown ID must be a 404; body was ${res.text}`);
  assert.deepEqual(json(res), expected);
  assert.equal(res.text, JSON.stringify(expected));

  // Both identifier failures render `<value>` as the RAW, still-encoded segment
  // as received - never the decoded form and never the normalized one (AAP
  // 0.6.2). So a lowercase unknown identifier echoes the lowercase spelling it
  // was sent as, even though the lookup itself used the normalized `S999`. The
  // normalized identifier appears in one message only, the 409 of test 15.
  const lowercase = await request(sharedServer, { path: '/api/students/s999/activities' });
  assert.equal(
    lowercase.status,
    STATUS_NOT_FOUND,
    `a lowercase unknown ID must still be a 404; body was ${lowercase.text}`
  );
  assert.deepEqual(
    json(lowercase),
    errorBody(CODE_STUDENT_NOT_FOUND, 'No student with Student ID s999'),
    'the message must echo the raw segment, not the normalized identifier'
  );

  // A raw segment can be far longer than the identifier it normalizes to, which
  // is where the 64-character cap on an identifier `<value>` bites on this
  // message too: 22 whitespace escapes and `S999` is 70 raw characters that
  // trim to a well-formed, unknown `S999`.
  const padded = `${'%20'.repeat(22)}S999`;
  const cappedUnknown = await request(sharedServer, {
    path: `/api/students/${padded}/activities`
  });
  assert.equal(
    cappedUnknown.status,
    STATUS_NOT_FOUND,
    `a padded unknown ID must be a 404; body was ${cappedUnknown.text}`
  );
  assert.deepEqual(
    json(cappedUnknown),
    errorBody(CODE_STUDENT_NOT_FOUND, `No student with Student ID ${padded.slice(0, 64)}`),
    'the echoed raw segment must be sliced at the documented 64 characters'
  );
});

test('5 path-encoding hazards are rejected without decoding twice', async () => {
  // `S%2530%2530%2531` decodes ONCE to `S%30%30%31`; decoding that again would
  // yield `S001` and accept an identifier the caller never sent. Decoding
  // happens exactly once at the boundary in `server.js`, which is the bug this
  // case exists to prevent. `S%ZZ1` makes `decodeURIComponent` throw
  // `URIError`, and `S001%2Fx` decodes to the literal `S001/x`.
  const rawSegments = ['S%ZZ1', 'S%2530%2530%2531', 'S001%2Fx'];
  for (const rawSegment of rawSegments) {
    const target = `/api/students/${rawSegment}/activities`;
    const res = await request(sharedServer, { path: target });
    assert.equal(
      res.status,
      STATUS_BAD_REQUEST,
      `${rawSegment}: must be a 400, never a 500 from an escaped URIError; body was ${res.text}`
    );
    const body = json(res);
    assert.equal(body.error.code, CODE_INVALID_STUDENT_ID, `${rawSegment}: wrong error code`);
    assert.ok(
      body.error.message.endsWith(`: ${rawSegment}`),
      `${rawSegment}: the message must echo the raw segment; got "${body.error.message}"`
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(body, 'studentId'),
      false,
      `${rawSegment}: a rejected identifier must never reach a success payload`
    );
  }
});

test('6 a student whose activity cell is blank holds zero activities, not a 404', async () => {
  // No committed student has a blank activity cell, so this case is reachable
  // only through the injected-row seams - never by adding a binary fixture.
  const directory = studentDirectory.fromRows([
    DIRECTORY_HEADER_ROW,
    { A: 'S001', B: S001_NAME }
  ]);
  const repository = activityRepository.fromData({
    directory,
    activityRows: [ACTIVITY_HEADER_ROW, { A: 'S001', B: 'Hostel', C: '' }],
    registryRecords: [],
    activitiesDataPath: path.join(mkTemp(), REGISTRY_FILENAME)
  });
  const server = await startServer({ directory, repository });
  const res = await request(server, { path: S001_PATH });
  assert.equal(
    res.status,
    STATUS_OK,
    `a zero-activity student must be a 200; body was ${res.text}`
  );
  assert.deepEqual(json(res), {
    studentId: 'S001',
    name: S001_NAME,
    count: 0,
    activities: []
  });
});

test('7 the full roster is the eight committed groups over ten records', async () => {
  const res = await request(sharedServer, { path: ACTIVITIES_PATH });
  assert.equal(res.status, STATUS_OK, `GET ${ACTIVITIES_PATH} must succeed; body was ${res.text}`);
  assertMediaType(res, JSON_MEDIA_TYPE, `GET ${ACTIVITIES_PATH}`);
  const body = json(res);
  assert.deepEqual(body, { count: EXPECTED_GROUP_COUNT, activities: FULL_ROSTER });
  // `count` is the number of groups, so it always equals `activities.length`.
  assert.equal(body.count, body.activities.length, 'count must equal activities.length');
  assert.equal(body.count, EXPECTED_GROUP_COUNT, 'the committed data yields eight groups');
  const members = body.activities.reduce((total, group) => total + group.count, 0);
  const listed = body.activities.reduce((total, group) => total + group.studentIds.length, 0);
  assert.equal(members, EXPECTED_RECORD_COUNT, 'the group counts must sum to ten records');
  assert.equal(listed, EXPECTED_RECORD_COUNT, 'the listed Student IDs must sum to ten records');
});

test('8 the activity filter matches trimmed and case-insensitively', async () => {
  const res = await request(sharedServer, { path: `${ACTIVITIES_PATH}?activity=debate%20society` });
  assert.equal(res.status, STATUS_OK, `the filter must succeed; body was ${res.text}`);
  assert.deepEqual(json(res), {
    count: 1,
    // The label is the workbook spelling, not the spelling the caller filtered
    // with, because grouping is keyed on the case-folded activity key.
    activities: [{ activity: 'Debate Society', count: 2, studentIds: ['S002', 'S010'] }]
  });
});

test('9 a filter that matches nothing is an empty 200, not an error', async () => {
  const res = await request(sharedServer, { path: `${ACTIVITIES_PATH}?activity=Chess%20Club` });
  assert.equal(res.status, STATUS_OK, `an unmatched filter must be a 200; body was ${res.text}`);
  assert.deepEqual(json(res), { count: 0, activities: [] });
});

test('10 grouping folds case and labels the group with the workbook spelling', async () => {
  const directory = studentDirectory.fromRows([
    DIRECTORY_HEADER_ROW,
    { A: 'S001', B: S001_NAME },
    { A: 'S009', B: 'Ishaan Nair' }
  ]);
  const repository = activityRepository.fromData({
    directory,
    activityRows: [ACTIVITY_HEADER_ROW, { A: 'S001', B: 'Hostel', C: S001_ACTIVITY }],
    // Spelled in lower case on purpose: the group key folds case, so this is
    // the same group, and the workbook member came first so its spelling wins.
    registryRecords: [{ studentId: 'S009', activity: 'robotics club' }],
    activitiesDataPath: path.join(mkTemp(), REGISTRY_FILENAME)
  });
  const server = await startServer({ directory, repository });
  const res = await request(server, { path: ACTIVITIES_PATH });
  assert.equal(res.status, STATUS_OK, `the roster must succeed; body was ${res.text}`);
  assert.deepEqual(json(res), {
    count: 1,
    activities: [{ activity: S001_ACTIVITY, count: 2, studentIds: ['S001', 'S009'] }]
  });
});

test('11 HEAD answers every GET route with the GET headers and no body bytes', async () => {
  // Each route with the media type it promises: the root keeps the baseline's
  // plain text, the two API routes are JSON.
  const targets = [
    [ROOT_PATH, TEXT_MEDIA_TYPE],
    [S001_PATH, JSON_MEDIA_TYPE],
    [ACTIVITIES_PATH, JSON_MEDIA_TYPE]
  ];
  for (const [target, expectedMediaType] of targets) {
    const get = await request(sharedServer, { path: target });
    const head = await request(sharedServer, { method: METHOD_HEAD, path: target });
    assert.equal(head.status, get.status, `HEAD ${target}: status must match the GET`);
    assertMediaType(get, expectedMediaType, `GET ${target}`);
    assert.equal(
      head.headers['content-type'],
      get.headers['content-type'],
      `HEAD ${target}: content-type must match the GET`
    );
    // Two assertions rather than one, because they fail for different reasons.
    // The GET must advertise the body it actually sent - an omitted or misstated
    // `Content-Length` on the GET is a contract breach on its own - and only
    // then is HEAD-to-GET equality meaningful. Comparing the HEAD header
    // straight to the GET's byte count, as an earlier form of this test did,
    // passes an implementation that special-cases HEAD and leaves the GET header
    // wrong or missing.
    assert.equal(
      get.headers['content-length'],
      String(get.bytes),
      `GET ${target}: content-length must declare the ${get.bytes} body bytes it sent`
    );
    assert.equal(
      head.headers['content-length'],
      get.headers['content-length'],
      `HEAD ${target}: content-length must be exactly the GET's ` +
        `(${get.headers['content-length']})`
    );
    assert.equal(head.bytes, 0, `HEAD ${target}: not one body byte may be written`);
  }
  // The root's declared length is the preserved greeting's, to the byte, on both
  // methods - the one length in this file that is a fixed number rather than a
  // measurement, because the greeting is a byte-for-byte guarantee.
  const rootGet = await request(sharedServer, { path: ROOT_PATH });
  const rootHead = await request(sharedServer, { method: METHOD_HEAD, path: ROOT_PATH });
  assert.equal(
    rootGet.headers['content-length'],
    String(GREETING_BYTE_LENGTH),
    'GET / must declare the 34-byte greeting length'
  );
  assert.equal(
    rootHead.headers['content-length'],
    String(GREETING_BYTE_LENGTH),
    'HEAD / must declare the 34-byte greeting length'
  );
  assert.equal(rootGet.text, GREETING, 'GET / must still be the byte-for-byte greeting');
  assertMediaType(rootHead, TEXT_MEDIA_TYPE, `HEAD ${ROOT_PATH}`);
});

/* ---------------------------------------------------------------------------
 * Tests 12-24: the write path. Each test owns its registry file, so no test
 * depends on another's writes and every file-byte assertion is deterministic.
 * ------------------------------------------------------------------------- */

test('12 a POST records a second activity and stores exactly two fields', async () => {
  const { server, registryPath } = await startWritableServer();
  const created = await postJson(server, S003_PATH, { activity: NEW_ACTIVITY });
  assert.equal(created.status, STATUS_CREATED, `the POST must be a 201; body was ${created.text}`);
  assertMediaType(created, JSON_MEDIA_TYPE, `POST ${S003_PATH} (201)`);
  assert.equal(
    created.headers.location,
    S003_PATH,
    'the 201 must point Location at the collection it created into'
  );
  assert.deepEqual(json(created), {
    studentId: 'S003',
    activity: NEW_ACTIVITY,
    source: 'registry'
  });

  const read = await request(server, { path: S003_PATH });
  assert.equal(read.status, STATUS_OK, `the follow-up GET must succeed; body was ${read.text}`);
  const body = json(read);
  assert.equal(body.count, 2, 'the student must now hold two activities');
  assert.equal(body.name, S003_NAME, 'the response must still carry the directory name');
  // The workbook record keeps its position and its spelling; the registry
  // record follows it in file order.
  assert.deepEqual(body.activities, [
    { activity: S003_ACTIVITY, source: 'workbook' },
    { activity: NEW_ACTIVITY, source: 'registry' }
  ]);

  const stored = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.deepEqual(stored, [{ studentId: 'S003', activity: NEW_ACTIVITY }]);
  // `source` is derived at serialization time, so it is never stored.
  assert.deepEqual(
    Object.keys(stored[0]),
    ['studentId', 'activity'],
    'a stored record holds exactly studentId and activity, in that order'
  );
});

test('13 a POST for an unknown student is refused and writes nothing', async () => {
  const { server, registryPath } = await startWritableServer();
  const before = fs.readFileSync(registryPath);
  const res = await postJson(server, S999_PATH, { activity: NEW_ACTIVITY });
  assert.equal(
    res.status,
    STATUS_NOT_FOUND,
    `an unknown student must be a 404; body was ${res.text}`
  );
  assert.deepEqual(
    json(res),
    errorBody(CODE_STUDENT_NOT_FOUND, 'No student with Student ID S999')
  );
  assert.ok(
    fs.readFileSync(registryPath).equals(before),
    'the registry file must be byte-unchanged after a refused write'
  );
});

test('14 every invalid activity form is refused with one fixed sentence', async () => {
  const { server, registryPath } = await startWritableServer();
  const before = fs.readFileSync(registryPath);
  // The contract states the requirement rather than echoing the offending
  // value, so a wrong-typed value never appears in the message.
  const cases = [
    ['a missing activity key', '{}'],
    ['an empty string', JSON.stringify({ activity: '' })],
    ['a whitespace-only string', JSON.stringify({ activity: '   ' })],
    ['a number', JSON.stringify({ activity: 42 })],
    ['null', JSON.stringify({ activity: null })],
    ['an object', JSON.stringify({ activity: {} })],
    ['65 characters', JSON.stringify({ activity: OVERLONG_ACTIVITY })]
  ];
  for (const [label, body] of cases) {
    const res = await postRaw(server, S003_PATH, body);
    assert.equal(res.status, STATUS_BAD_REQUEST, `${label}: must be a 400; body was ${res.text}`);
    assert.deepEqual(
      json(res),
      errorBody(CODE_INVALID_ACTIVITY, MESSAGE_INVALID_ACTIVITY),
      `${label}: must carry the fixed INVALID_ACTIVITY envelope`
    );
  }
  assert.ok(
    fs.readFileSync(registryPath).equals(before),
    'no invalid activity form may leave a trace in the registry file'
  );
});

test('15 posting the activity the workbook already records is a 409', async () => {
  const { server, registryPath } = await startWritableServer();
  const before = fs.readFileSync(registryPath);
  const res = await postJson(server, S003_PATH, { activity: S003_ACTIVITY });
  assert.equal(res.status, STATUS_CONFLICT, `a duplicate must be a 409; body was ${res.text}`);
  assert.deepEqual(
    json(res),
    errorBody(
      CODE_ACTIVITY_ALREADY_RECORDED,
      `Student S003 already holds activity ${S003_ACTIVITY}`
    )
  );
  assert.ok(
    fs.readFileSync(registryPath).equals(before),
    'a refused duplicate must leave the registry file byte-unchanged'
  );
});

test('16 a duplicate of a registry activity is caught with the case folded', async () => {
  const { server, registryPath } = await startWritableServer();
  const first = await postJson(server, S003_PATH, { activity: NEW_ACTIVITY });
  assert.equal(
    first.status,
    STATUS_CREATED,
    `the first POST must be a 201; body was ${first.text}`
  );
  const second = await postJson(server, S003_PATH, { activity: NEW_ACTIVITY.toLowerCase() });
  assert.equal(
    second.status,
    STATUS_CONFLICT,
    `the case-folded repeat must be a 409; body was ${second.text}`
  );
  // The message interpolates the trimmed value the caller supplied, not the
  // stored spelling, so the caller sees what was rejected.
  assert.deepEqual(
    json(second),
    errorBody(
      CODE_ACTIVITY_ALREADY_RECORDED,
      `Student S003 already holds activity ${NEW_ACTIVITY.toLowerCase()}`
    )
  );
  const stored = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.deepEqual(stored, [{ studentId: 'S003', activity: NEW_ACTIVITY }]);
});

test('17 an unparseable body is a 400 MALFORMED_JSON', async () => {
  const { server } = await startWritableServer();
  const res = await postRaw(server, S003_PATH, '{');
  assert.equal(res.status, STATUS_BAD_REQUEST, `a bad body must be a 400; body was ${res.text}`);
  assert.deepEqual(json(res), errorBody(CODE_MALFORMED_JSON, MESSAGE_MALFORMED_JSON));
});

test('18 any key other than activity is refused and named', async () => {
  const { server, registryPath } = await startWritableServer();
  const before = fs.readFileSync(registryPath);
  // One offending key per case, placed first in the body's own key order, so the
  // key the message names is unambiguous. `source` is derived and `studentId`
  // comes from the path, which is why neither may be supplied.
  const cases = [
    ['source', 'registry'],
    ['studentId', 'S003'],
    ['role', 'Captain']
  ];
  for (const [key, value] of cases) {
    const payload = {};
    payload[key] = value;
    payload.activity = UNUSED_ACTIVITY;
    const res = await postJson(server, S003_PATH, payload);
    assert.equal(res.status, STATUS_BAD_REQUEST, `${key}: must be a 400; body was ${res.text}`);
    assert.deepEqual(
      json(res),
      errorBody(CODE_UNEXPECTED_FIELD, `Unexpected field: ${key}`),
      `${key}: the message must name the offending key`
    );
  }
  assert.ok(
    fs.readFileSync(registryPath).equals(before),
    'a body carrying an unexpected field must not be persisted'
  );
});

test('19 Content-Type is matched on the media type alone', async () => {
  const { server } = await startWritableServer();
  const body = JSON.stringify({ activity: NEW_ACTIVITY });
  const refused = await postRaw(server, S003_PATH, body, TEXT_MEDIA_TYPE);
  assert.equal(
    refused.status,
    STATUS_UNSUPPORTED_MEDIA_TYPE,
    `${TEXT_MEDIA_TYPE} must be a 415; body was ${refused.text}`
  );
  assert.deepEqual(
    json(refused),
    errorBody(CODE_UNSUPPORTED_MEDIA_TYPE, MESSAGE_UNSUPPORTED_MEDIA_TYPE)
  );
  // A charset parameter is part of the header, not part of the media type, so
  // the accepted case runs last - it is the one that writes.
  const accepted = await postRaw(server, S003_PATH, body, `${JSON_MEDIA_TYPE}; charset=utf-8`);
  assert.equal(
    accepted.status,
    STATUS_CREATED,
    `a charset parameter must still be accepted; body was ${accepted.text}`
  );
  assert.deepEqual(json(accepted), {
    studentId: 'S003',
    activity: NEW_ACTIVITY,
    source: 'registry'
  });
});

/* ---------------------------------------------------------------------------
 * Synthetic dispatch - read by tests 20, 21, 25 and 26.
 *
 * AAP 0.6.2 requires a request answered before its body is read to be answered
 * and its stream **destroyed**, never read to the end. Over a socket the two
 * behaviours look alike: both deliver the response and both close the
 * connection, and the byte counts that do separate them sit on the server's
 * own socket rather than in the response. So those four tests drive the shipped
 * handler through the server's own `'request'` event with a synthetic request
 * and response, which makes "paused, then destroyed, and never resumed"
 * directly observable and free of timing. The doubles implement only the
 * members `server.js` and `lib/activityRoutes.js` actually touch.
 * ------------------------------------------------------------------------- */

/**
 * The smallest emitter those handlers need: `on`, `once`, `emit`, and the
 * listener count test 21 reads to prove no body consumer was ever attached.
 *
 * @returns {object} The emitter.
 */
const syntheticEmitter = () => {
  const listeners = new Map();
  const target = {
    on(name, handler) {
      const existing = listeners.get(name);
      if (existing === undefined) listeners.set(name, [handler]);
      else existing.push(handler);
      return target;
    },
    once(name, handler) {
      const wrapper = (...args) => {
        listeners.set(name, listeners.get(name).filter((entry) => entry !== wrapper));
        handler(...args);
      };
      return target.on(name, wrapper);
    },
    emit(name, ...args) {
      const handlers = listeners.get(name);
      if (handlers === undefined) return false;
      handlers.slice().forEach((handler) => handler(...args));
      return true;
    },
    listenerCount(name) {
      const handlers = listeners.get(name);
      return handlers === undefined ? 0 : handlers.length;
    }
  };
  return target;
};

/**
 * A request whose body has **not** fully arrived - the state every early
 * rejection is decided in - counting what the handler does to the stream.
 *
 * @param {string} method The request method.
 * @param {string} url The raw request target.
 * @param {object} [headers] The request headers.
 * @returns {object} The synthetic request, with a `calls` tally.
 */
const syntheticRequest = (method, url, headers) => {
  const req = syntheticEmitter();
  req.method = method;
  req.url = url;
  // A real `IncomingMessage` exposes header names lower-cased, and the handlers
  // read them that way, so the double must too.
  req.headers = {};
  const supplied = headers === undefined ? {} : headers;
  Object.keys(supplied).forEach((name) => {
    req.headers[name.toLowerCase()] = supplied[name];
  });
  // `complete` false is the point: a body still on the wire is what the
  // contract is about, and what the abandon guard keys on.
  req.complete = false;
  req.destroyed = false;
  req.calls = { paused: 0, resumed: 0, destroyed: 0 };
  req.pause = () => { req.calls.paused += 1; return req; };
  req.resume = () => { req.calls.resumed += 1; return req; };
  req.destroy = () => {
    req.calls.destroyed += 1;
    req.destroyed = true;
    return req;
  };
  return req;
};

/**
 * A response that records what was written and emits `'finish'` the way a real
 * one does - which the abandon path waits for before it destroys anything.
 *
 * @returns {object} The synthetic response.
 */
const syntheticResponse = () => {
  const res = syntheticEmitter();
  res.statusCode = 0;
  res.headers = {};
  res.body = '';
  res.writableFinished = false;
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
  };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    const supplied = headers === undefined ? {} : headers;
    Object.keys(supplied).forEach((name) => {
      res.headers[name.toLowerCase()] = supplied[name];
    });
    return res;
  };
  res.end = (chunk) => {
    if (chunk !== undefined) res.body += String(chunk);
    process.nextTick(() => {
      res.writableFinished = true;
      res.emit('finish');
    });
    return res;
  };
  return res;
};

/**
 * Invokes the real request handler on a listening server with the doubles
 * above. Returns synchronously, so a caller can emit body chunks before the
 * exchange settles.
 *
 * @param {import('node:http').Server} server A server built by the real root.
 * @param {string} method The request method.
 * @param {string} target The raw request target.
 * @param {object} [headers] The request headers.
 * @returns {{req: object, res: object}} The doubles the handler was given.
 */
const dispatchSynthetic = (server, method, target, headers) => {
  const req = syntheticRequest(method, target, headers);
  const res = syntheticResponse();
  server.emit('request', req, res);
  return { req, res };
};

/**
 * Waits out the response's `'finish'` tick and the deferred destroy after it.
 *
 * @returns {Promise<void>} Resolved once the exchange has settled.
 */
const settleSynthetic = () => new Promise((resolve) => {
  setImmediate(() => setImmediate(() => setImmediate(resolve)));
});

test('20 a body over 8 KiB is refused with the size named', async () => {
  const { server, registryPath } = await startWritableServer();
  const before = fs.readFileSync(registryPath);
  // Sent in a single `req.end()`. The server answers and then abandons the
  // request, so any client-side ECONNRESET is tolerated by the harness rather
  // than failing the assertion this test is making.
  const res = await postRaw(server, S003_PATH, `{"activity":"${'y'.repeat(OVERSIZE_BODY_BYTES)}"}`);
  assert.equal(
    res.status,
    STATUS_PAYLOAD_TOO_LARGE,
    `an oversize body must be a 413; body was ${res.text}`
  );
  assert.deepEqual(json(res), errorBody(CODE_PAYLOAD_TOO_LARGE, MESSAGE_PAYLOAD_TOO_LARGE));
  assert.ok(
    fs.readFileSync(registryPath).equals(before),
    'an oversize body must not be persisted'
  );
  assert.equal(
    res.headers.connection,
    'close',
    'a body refused mid-stream must declare Connection: close'
  );

  // The cap is only half the requirement. The other half is that the rest of
  // the upload is never read: the stream is paused and destroyed once the
  // response has left, never resumed into a drain (AAP 0.6.2).
  const refused = dispatchSynthetic(server, METHOD_POST, S003_PATH, {
    'Content-Type': JSON_MEDIA_TYPE
  });
  refused.req.emit('data', Buffer.alloc(OVERSIZE_BODY_BYTES, 0x79));
  await settleSynthetic();
  assert.equal(
    refused.res.statusCode,
    STATUS_PAYLOAD_TOO_LARGE,
    'the cap must trip as the body arrives, not after it is buffered in full'
  );
  assert.equal(refused.res.headers.connection, 'close');
  assert.equal(
    refused.req.calls.resumed,
    0,
    'a refused upload must never be resumed, which is what a drain is'
  );
  assert.equal(
    refused.req.calls.destroyed,
    1,
    'the refused request stream must be destroyed exactly once'
  );
  assert.ok(
    refused.req.calls.paused >= 1,
    'the stream must be paused before the destroy, so nothing reads it meanwhile'
  );
});

test('21 the Student ID is resolved before the body is read at all', async () => {
  const { server } = await startWritableServer();
  // Unknown student, oversize body, unparseable body: the fixed order is path,
  // method, ID shape, ID existence, media type, size, parse, unexpected keys,
  // activity, duplicate, persistence - so this is a 404, not a 413 and not a
  // 400. This is the one test that pins that order.
  const res = await postRaw(server, S999_PATH, `{${'z'.repeat(OVERSIZE_BODY_BYTES)}`);
  assert.equal(
    res.status,
    STATUS_NOT_FOUND,
    `existence must be settled first; got ${res.status} with body ${res.text}`
  );
  assert.deepEqual(
    json(res),
    errorBody(CODE_STUDENT_NOT_FOUND, 'No student with Student ID S999')
  );
  assert.equal(
    res.headers.connection,
    'close',
    'a request settled before its body was read must declare Connection: close'
  );

  // "Before the body is read at all" is literal, and this is what proves it:
  // the route attaches no `'data'` consumer before answering, and then abandons
  // the stream - paused, then destroyed - instead of draining the 9000 bytes
  // the client declared (AAP 0.6.2).
  const unread = dispatchSynthetic(server, METHOD_POST, S999_PATH, {
    'Content-Type': JSON_MEDIA_TYPE
  });
  assert.equal(
    unread.req.listenerCount('data'),
    0,
    'an unknown student must be settled before any body consumer is attached'
  );
  await settleSynthetic();
  assert.equal(unread.res.statusCode, STATUS_NOT_FOUND);
  assert.equal(
    unread.req.calls.resumed,
    0,
    'the body of a rejected request must never be read to its end'
  );
  assert.equal(
    unread.req.calls.destroyed,
    1,
    'the rejected request stream must be destroyed exactly once'
  );
});

test('22 a failed write is a 500 that leaks nothing and leaves no artifact', async () => {
  const registryDir = mkTemp();
  const registryPath = path.join(registryDir, REGISTRY_FILENAME);
  fs.writeFileSync(registryPath, EMPTY_REGISTRY, 'utf8');
  // The scratch path the atomic writer uses: `<registry>.tmp`, in the
  // registry's own directory, which is what makes the rename atomic.
  const temporaryPath = `${registryPath}${REGISTRY_TEMPORARY_SUFFIX}`;
  let scratchArtifactExisted = false;
  const directory = studentDirectory.fromRows([
    DIRECTORY_HEADER_ROW,
    { A: 'S001', B: S001_NAME }
  ]);
  const repository = activityRepository.fromData({
    directory,
    activityRows: [ACTIVITY_HEADER_ROW, { A: 'S001', B: 'Hostel', C: S001_ACTIVITY }],
    registryRecords: [],
    activitiesDataPath: registryPath,
    // The double reaches the production writer's mid-flight state before it
    // fails: the scratch file is on disk, the rename has not happened. A stub
    // that threw first would leave the directory clean whatever the repository
    // did next, so the "no artifact" assertion below would hold even with the
    // cleanup deleted - which is the one thing this test exists to prove.
    writeFile: (target, contents) => {
      fs.writeFileSync(`${target}${REGISTRY_TEMPORARY_SUFFIX}`, contents, 'utf8');
      scratchArtifactExisted = fs.existsSync(`${target}${REGISTRY_TEMPORARY_SUFFIX}`);
      throw new Error('injected write failure');
    }
  });
  const server = await startServer({ directory, repository });
  const res = await postJson(server, S001_PATH, { activity: UNUSED_ACTIVITY });
  assert.equal(
    res.status,
    STATUS_INTERNAL_ERROR,
    `a failed write must be a 500; body was ${res.text}`
  );
  assertMediaType(res, JSON_MEDIA_TYPE, `POST ${S001_PATH} (500)`);
  assert.deepEqual(json(res), errorBody(CODE_INTERNAL_ERROR, MESSAGE_INTERNAL_ERROR));
  // Asserted, not assumed: if the writer stopped producing the scratch file the
  // cleanup assertion would silently stop testing anything.
  assert.equal(
    scratchArtifactExisted,
    true,
    `the injected writer must leave ${temporaryPath} on disk before it fails, ` +
      'or the cleanup assertion proves nothing'
  );
  assert.equal(
    res.text.includes('injected write failure'),
    false,
    'a 500 must not echo the underlying exception message'
  );
  assert.equal(
    /\bat \w/.test(res.text),
    false,
    'a 500 must not carry a stack frame'
  );

  // The activity is free text of 1-64 characters by contract, so a name carrying
  // CR/LF and a terminal escape is a valid request - and this is the one path
  // that writes it to stderr. The sink is what must be safe: the diagnostic has
  // to stay a single record so a log reader cannot be handed a line the caller
  // wrote, and the fixed 500 envelope must not change because of it.
  const forgedLine = 'FORGED activityRoutes: nothing went wrong';
  const smuggledActivity = `Chess\r\n${forgedLine}\u001b[31m`;
  const captured = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, encoding, callback) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  };
  let smuggled = null;
  try {
    smuggled = await postJson(server, S001_PATH, { activity: smuggledActivity });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(
    smuggled.status,
    STATUS_INTERNAL_ERROR,
    `the injected writer must fail this write too; body was ${smuggled.text}`
  );
  assert.deepEqual(
    json(smuggled),
    errorBody(CODE_INTERNAL_ERROR, MESSAGE_INTERNAL_ERROR),
    'escaping the log record must leave the fixed 500 envelope untouched'
  );
  const diagnostic = captured.join('');
  const diagnosticLines = diagnostic.split('\n').filter((line) => line !== '');
  assert.equal(
    diagnosticLines.length,
    1,
    `the diagnostic must occupy exactly one line; got ${JSON.stringify(diagnostic)}`
  );
  assert.equal(
    diagnosticLines.some((line) => line.startsWith(forgedLine)),
    false,
    `no log line may begin with caller-supplied text; got ${JSON.stringify(diagnostic)}`
  );
  assert.equal(
    /[\u0000-\u0009\u000b-\u001f]/.test(diagnostic),
    false,
    `no control character may survive into the record; got ${JSON.stringify(diagnostic)}`
  );
  assert.ok(
    diagnostic.includes('\\u000d\\u000a') && diagnostic.includes('\\u001b'),
    `CR, LF and ESC must appear escaped; got ${JSON.stringify(diagnostic)}`
  );

  const read = await request(server, { path: S001_PATH });
  assert.deepEqual(
    json(read).activities,
    [{ activity: S001_ACTIVITY, source: 'workbook' }],
    'the in-memory index must be untouched by a write that failed'
  );
  // The exact path first - the one the writer really created - then the whole
  // directory, so a scratch file under any other name is caught too.
  assert.equal(
    fs.existsSync(temporaryPath),
    false,
    `a failed write must remove ${temporaryPath}`
  );
  const leftovers = fs
    .readdirSync(registryDir)
    .filter((name) => name.endsWith(REGISTRY_TEMPORARY_SUFFIX));
  assert.deepEqual(
    leftovers,
    [],
    `a failed write must discard its temporary file; found ${leftovers.join(', ')}`
  );
  // The registry itself is still the empty array it was seeded with: the failed
  // write must not have renamed anything over it.
  assert.equal(
    fs.readFileSync(registryPath, 'utf8'),
    EMPTY_REGISTRY,
    'a failed write must leave the registry file exactly as it was'
  );
});

test('23 one failed write does not poison the writes that follow it', async () => {
  const registryPath = path.join(mkTemp(), REGISTRY_FILENAME);
  fs.writeFileSync(registryPath, EMPTY_REGISTRY, 'utf8');
  const directory = studentDirectory.fromRows([
    DIRECTORY_HEADER_ROW,
    { A: 'S001', B: S001_NAME }
  ]);
  let attempts = 0;
  const repository = activityRepository.fromData({
    directory,
    activityRows: [ACTIVITY_HEADER_ROW, { A: 'S001', B: 'Hostel', C: S001_ACTIVITY }],
    registryRecords: [],
    activitiesDataPath: registryPath,
    // Fails once, then writes for real. A plain write stands in for the atomic
    // writer, which is internal to the repository and not exported.
    writeFile: (target, contents) => {
      attempts += 1;
      if (attempts === 1) throw new Error('injected write failure');
      fs.writeFileSync(target, contents, 'utf8');
    }
  });
  const server = await startServer({ directory, repository });
  const failed = await postJson(server, S001_PATH, { activity: UNUSED_ACTIVITY });
  assert.equal(
    failed.status,
    STATUS_INTERNAL_ERROR,
    `the first write must fail; body was ${failed.text}`
  );
  // The same repository and the same queue: each POST is enqueued as its own
  // task, so the rejection above cannot settle this one.
  const recovered = await postJson(server, S001_PATH, { activity: UNUSED_ACTIVITY });
  assert.equal(
    recovered.status,
    STATUS_CREATED,
    `the retry must succeed on the same queue; body was ${recovered.text}`
  );
  const read = await request(server, { path: S001_PATH });
  assert.deepEqual(json(read).activities, [
    { activity: S001_ACTIVITY, source: 'workbook' },
    { activity: UNUSED_ACTIVITY, source: 'registry' }
  ]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(registryPath, 'utf8')),
    [{ studentId: 'S001', activity: UNUSED_ACTIVITY }],
    'exactly the recovered record must be on disk'
  );
});

test('24 two concurrent posts of one activity produce one record', async () => {
  const { server, registryPath } = await startWritableServer();
  const [first, second] = await Promise.all([
    postJson(server, S003_PATH, { activity: NEW_ACTIVITY }),
    postJson(server, S003_PATH, { activity: NEW_ACTIVITY })
  ]);
  const statuses = [first.status, second.status].sort();
  // The duplicate re-check runs inside the writer's critical section, so the
  // second request cannot slip past it between the check and the rename.
  assert.deepEqual(
    statuses,
    [STATUS_CREATED, STATUS_CONFLICT],
    `exactly one 201 and one 409 were expected; got ${statuses.join(', ')}`
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(registryPath, 'utf8')),
    [{ studentId: 'S003', activity: NEW_ACTIVITY }],
    'only one record may reach the registry file'
  );
});

/* ---------------------------------------------------------------------------
 * Tests 25-27: method dispatch, unknown paths and the response schemas.
 * ------------------------------------------------------------------------- */

test('25 an unsupported method is a 405 carrying the exact Allow header', async () => {
  const cases = [
    ['DELETE', S001_PATH, ALLOW_STUDENT_ACTIVITIES],
    [METHOD_POST, ACTIVITIES_PATH, ALLOW_ACTIVITIES],
    // The baseline answered the greeting to every method; method-aware routing
    // is the point of the feature, so `/` now refuses anything else.
    ['PUT', ROOT_PATH, ALLOW_ROOT],
    // A malformed percent-escape does not stop the path being recognised - the
    // raw shape is what recognises it - so the fixed order still applies:
    // method before identifier shape (AAP 0.6.2). This is a 405 naming what
    // the route serves, where GET on the same target is the 400 of test 5.
    ['DELETE', '/api/students/S%ZZ1/activities', ALLOW_STUDENT_ACTIVITIES],
    // The same branch, with a path past the 64-character mark: the entrypoint
    // writes this `405` itself, and `<path>` is rendered in full there too -
    // the cap is for identifier and activity values only (test 3).
    ['DELETE', `/api/students/%ZZ${'q'.repeat(70)}/activities`, ALLOW_STUDENT_ACTIVITIES]
  ];
  for (const [method, target, allow] of cases) {
    const res = await request(sharedServer, { method, path: target });
    assert.equal(
      res.status,
      STATUS_METHOD_NOT_ALLOWED,
      `${method} ${target}: must be a 405; body was ${res.text}`
    );
    // The header string is asserted exactly: the order is part of the contract.
    assert.equal(
      res.headers.allow,
      allow,
      `${method} ${target}: Allow must be exactly "${allow}"`
    );
    assert.deepEqual(
      json(res),
      errorBody(CODE_METHOD_NOT_ALLOWED, `Method ${method} is not allowed on ${target}`),
      `${method} ${target}: the message must name the method and the path`
    );
  }

  // The entrypoint writes the root `405` itself, and it abandons an unread body
  // on the same terms the routes do: paused, then destroyed, never resumed
  // (AAP 0.6.2). One pattern, both files.
  const refusedRoot = dispatchSynthetic(sharedServer, 'PUT', ROOT_PATH);
  await settleSynthetic();
  assert.equal(refusedRoot.res.statusCode, STATUS_METHOD_NOT_ALLOWED);
  assert.equal(refusedRoot.res.headers.allow, ALLOW_ROOT);
  assert.equal(refusedRoot.res.headers.connection, 'close');
  assert.equal(
    refusedRoot.req.calls.resumed,
    0,
    'the entrypoint must not drain the body of a method it refuses'
  );
  assert.equal(
    refusedRoot.req.calls.destroyed,
    1,
    'the refused request stream must be destroyed exactly once'
  );
});

test('26 an unrecognised path is a 404 naming the query-stripped target', async () => {
  // There is no trailing-slash normalization, which is why `/api/activities/`
  // is a 404 rather than the roster, and the query string never reaches the
  // message.
  const cases = [
    ['/api/unknown', '/api/unknown'],
    ['/api/activities/', '/api/activities/'],
    ['/nope', '/nope'],
    ['/api/unknown?x=1', '/api/unknown'],
    // `<path>` is never shortened: the 64-character cap applies to identifier
    // and activity values only (test 3), so a target well past it is named in
    // full.
    [`/api/${'q'.repeat(90)}`, `/api/${'q'.repeat(90)}`],
    [`/api/${'r'.repeat(90)}?drop=me`, `/api/${'r'.repeat(90)}`]
  ];
  for (const [target, expectedPath] of cases) {
    const res = await request(sharedServer, { path: target });
    assert.equal(res.status, STATUS_NOT_FOUND, `${target}: must be a 404; body was ${res.text}`);
    assert.deepEqual(
      json(res),
      errorBody(CODE_NOT_FOUND, `No route for ${METHOD_GET} ${expectedPath}`),
      `${target}: the message must render the raw target with the query removed`
    );
  }

  // The single `404` fallback abandons an unread body too, rather than reading
  // an upload nothing will look at to its end (AAP 0.6.2).
  const gone = dispatchSynthetic(sharedServer, METHOD_GET, '/nope');
  await settleSynthetic();
  assert.equal(gone.res.statusCode, STATUS_NOT_FOUND);
  assert.equal(gone.res.headers.connection, 'close');
  assert.equal(
    gone.req.calls.resumed,
    0,
    'the 404 fallback must not drain the body of an unrecognised request'
  );
  assert.equal(
    gone.req.calls.destroyed,
    1,
    'the unrecognised request stream must be destroyed exactly once'
  );
});

test('27 every payload carries exactly its documented keys and no discarded column', async () => {
  const { server } = await startWritableServer();
  const perStudent = await request(server, { path: S001_PATH });
  const roster = await request(server, { path: ACTIVITIES_PATH });
  const created = await postJson(server, S003_PATH, { activity: UNUSED_ACTIVITY });
  const failure = await request(server, { path: S999_PATH });
  // The unknown path is answered by `server.js`, every other response here by
  // `lib/activityRoutes.js`. Both writers are covered on purpose: the media type
  // and the envelope are one contract written in two places, so a drift in
  // either would otherwise go unnoticed.
  const unroutable = await request(server, { path: '/nope' });
  assert.equal(created.status, STATUS_CREATED, `the POST must succeed; body was ${created.text}`);
  assert.equal(
    unroutable.status,
    STATUS_NOT_FOUND,
    `an unrecognised path must be a 404; body was ${unroutable.text}`
  );

  // Every JSON response, success and failure, from both writers.
  assertMediaType(perStudent, JSON_MEDIA_TYPE, `GET ${S001_PATH}`);
  assertMediaType(roster, JSON_MEDIA_TYPE, `GET ${ACTIVITIES_PATH}`);
  assertMediaType(created, JSON_MEDIA_TYPE, `POST ${S003_PATH} (201)`);
  assertMediaType(failure, JSON_MEDIA_TYPE, `GET ${S999_PATH} (404, activityRoutes.js)`);
  assertMediaType(unroutable, JSON_MEDIA_TYPE, 'GET /nope (404, server.js)');

  assert.deepEqual(
    sortedKeys(json(perStudent)),
    ['activities', 'count', 'name', 'studentId'],
    'the per-student payload carries exactly these four keys'
  );
  assert.deepEqual(
    sortedKeys(json(perStudent).activities[0]),
    ['activity', 'source'],
    'an activity entry carries exactly activity and source'
  );
  assert.deepEqual(
    sortedKeys(json(roster)),
    ['activities', 'count'],
    'the roster payload carries exactly these two keys'
  );
  assert.deepEqual(
    sortedKeys(json(roster).activities[0]),
    ['activity', 'count', 'studentIds'],
    'a roster group carries exactly activity, count and studentIds'
  );
  assert.deepEqual(
    sortedKeys(json(created)),
    ['activity', 'source', 'studentId'],
    'the created record carries exactly these three keys'
  );
  assert.deepEqual(sortedKeys(json(failure)), ['error'], 'an error payload carries only error');
  assert.deepEqual(
    sortedKeys(json(failure).error),
    ['code', 'message'],
    'the error envelope carries exactly code and message'
  );
  assert.deepEqual(
    sortedKeys(json(unroutable)),
    ['error'],
    'the error payload written by server.js carries only error'
  );
  assert.deepEqual(
    sortedKeys(json(unroutable).error),
    ['code', 'message'],
    'the error envelope written by server.js carries exactly code and message'
  );

  // Gender, Date of Birth, Age, Department, Year, Email, Phone and City are
  // parsed with the worksheet and then discarded, so neither a column name nor
  // a distinctive value from S001's row may appear in any response.
  const payloads = [
    ['per-student', perStudent.text],
    ['roster', roster.text],
    ['created', created.text],
    ['error', failure.text],
    ['unroutable', unroutable.text]
  ];
  for (const [label, text] of payloads) {
    for (const column of EXCLUDED_COLUMN_NAMES) {
      assert.equal(
        text.includes(column),
        false,
        `${label}: the discarded column name "${column}" must not be serialized`
      );
    }
    for (const value of EXCLUDED_VALUES) {
      assert.equal(
        text.includes(value),
        false,
        `${label}: the discarded value "${value}" must not be serialized`
      );
    }
  }
});

/* ---------------------------------------------------------------------------
 * Tests 28-33: load-time behaviour and the injection seam. None of these can
 * be reached through a socket, which is why the seams exist.
 * ------------------------------------------------------------------------- */

test('28 a missing registry file warns and serves the workbook data anyway', async () => {
  const missingRegistry = path.join(mkTemp(), REGISTRY_FILENAME);
  const directory = studentDirectory.load({ workbookDir: REPO_ROOT });
  const collected = [];
  const originalWrite = process.stderr.write;
  let repository = null;
  let failure = null;
  // The warning is written straight to stderr, so it is captured for the
  // duration of the call and the original is restored no matter what happens.
  process.stderr.write = (chunk, encoding, callback) => {
    collected.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  };
  try {
    repository = activityRepository.load({
      workbookDir: REPO_ROOT,
      activitiesDataPath: missingRegistry,
      directory
    });
  } catch (error) {
    failure = error;
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(failure, null, `a missing registry must not be fatal; threw ${failure}`);
  assert.equal(
    repository.recordCount(),
    EXPECTED_RECORD_COUNT,
    'the ten workbook-sourced records must still be served'
  );
  const warning = collected.join('');
  assert.notEqual(warning, '', 'a missing registry must produce a warning on stderr');
  assert.ok(
    warning.includes(missingRegistry),
    `the warning must name the missing path; got "${warning}"`
  );
});

test('29 a corrupt registry file aborts the load and names the fault', async () => {
  const directory = studentDirectory.load({ workbookDir: REPO_ROOT });
  const cases = [
    ['malformed JSON', '{', 'does not contain valid JSON'],
    ['a non-array root', '{}', 'must contain a JSON array of records'],
    [
      'an orphan studentId',
      '[{"studentId":"S999","activity":"Chess Club"}]',
      'record 1 names Student ID S999, which is not in the student directory'
    ],
    [
      'an invalid activity',
      '[{"studentId":"S001","activity":""}]',
      'record 1 (S001) has an invalid activity'
    ],
    [
      'a duplicate of the workbook value',
      '[{"studentId":"S001","activity":"Robotics Club"}]',
      'record 1 duplicates activity "Robotics Club" for Student ID S001'
    ]
  ];
  for (const [label, contents, expected] of cases) {
    const registryPath = path.join(mkTemp(), REGISTRY_FILENAME);
    fs.writeFileSync(registryPath, contents, 'utf8');
    assert.throws(
      () => activityRepository.load({
        workbookDir: REPO_ROOT,
        activitiesDataPath: registryPath,
        directory
      }),
      (error) => {
        assert.equal(error.code, CODE_REPOSITORY_INVALID, `${label}: wrong error code`);
        assert.ok(
          error.message.includes(expected),
          `${label}: the message must state "${expected}"; got "${error.message}"`
        );
        assert.ok(
          error.message.includes(registryPath),
          `${label}: the message must name the registry file; got "${error.message}"`
        );
        return true;
      },
      `${label}: the load must abort rather than under-report a student's activities`
    );
  }
});

test('30 the student directory refuses every row set it cannot key', async () => {
  const cases = [
    [
      'a header mismatch',
      [{ A: 'ID', B: 'Name' }, { A: 'S001', B: S001_NAME }],
      'header cell A1 must be exactly "Student ID" (received "ID")'
    ],
    [
      'a duplicate key',
      [DIRECTORY_HEADER_ROW, { A: 'S001', B: S001_NAME }, { A: 'S001', B: S003_NAME }],
      'duplicate Student ID S001 at rows 2 and 3'
    ],
    [
      'a malformed key',
      [DIRECTORY_HEADER_ROW, { A: 'S1', B: S001_NAME }],
      'row 2 has a malformed Student ID "S1"'
    ],
    [
      'a blank Name',
      [DIRECTORY_HEADER_ROW, { A: 'S001', B: '' }],
      'row 2 (S001) has a blank Name'
    ],
    // The row shapes `lib/workbook.js` can never yield. Each one used to be read
    // as a blank cell and silently skipped, which loses a student the caller
    // believes was supplied: `fromRows` must be exactly as strict as `load`.
    [
      'a null key cell',
      [DIRECTORY_HEADER_ROW, { A: null, B: S001_NAME }],
      'cell A2 must be a string (received null)'
    ],
    [
      'a null Name cell',
      [DIRECTORY_HEADER_ROW, { A: 'S001', B: null }],
      'cell B2 must be a string (received null)'
    ],
    [
      'a non-string key cell',
      [DIRECTORY_HEADER_ROW, { A: 1, B: S001_NAME }],
      'cell A2 must be a string (received number)'
    ],
    [
      'an array row',
      [DIRECTORY_HEADER_ROW, ['S001', S001_NAME]],
      'row 2 must be a plain object keyed by column letter (received array)'
    ],
    [
      'a non-record object row',
      [DIRECTORY_HEADER_ROW, new Date()],
      'row 2 must be a plain object keyed by column letter (received non-record object)'
    ]
  ];
  for (const [label, rows, expected] of cases) {
    assert.throws(
      () => studentDirectory.fromRows(rows),
      (error) => {
        assert.equal(error.code, CODE_DIRECTORY_INVALID, `${label}: wrong error code`);
        assert.ok(
          error.message.includes(expected),
          `${label}: the message must state "${expected}"; got "${error.message}"`
        );
        return true;
      },
      `${label}: the directory must abort rather than guess`
    );
  }

  // The one non-fatal row shape stays non-fatal, so the strictness above cannot
  // drift into rejecting real data: a blank key cell is the trailing empty row a
  // maintainer left behind, and an omitted column is what the reader yields for a
  // cell absent from the worksheet XML.
  const skipping = studentDirectory.fromRows([
    DIRECTORY_HEADER_ROW,
    { A: '', B: '' },
    {},
    { A: 'S001', B: S001_NAME }
  ]);
  assert.deepEqual(
    skipping.ids(),
    ['S001'],
    'a blank or absent key cell must skip its row rather than fail the load'
  );
});

test('31 the activity source refuses a reshaped sheet and an unknown student', async () => {
  const directory = studentDirectory.fromRows([
    DIRECTORY_HEADER_ROW,
    { A: 'S001', B: S001_NAME }
  ]);
  const cases = [
    [
      'a C1 header mismatch',
      [
        { A: 'Student ID', B: 'Hostel Status', C: 'Activity' },
        { A: 'S001', B: 'Hostel', C: S001_ACTIVITY }
      ],
      'header cell C1 must be exactly "Extracurricular Activity" (received "Activity")'
    ],
    [
      'a duplicate key',
      [
        ACTIVITY_HEADER_ROW,
        { A: 'S001', B: 'Hostel', C: S001_ACTIVITY },
        { A: 'S001', B: 'Hostel', C: UNUSED_ACTIVITY }
      ],
      'duplicate Student ID S001 at rows 2 and 3'
    ],
    [
      'a student absent from the directory',
      [ACTIVITY_HEADER_ROW, { A: 'S002', B: 'Day Scholar', C: 'Debate Society' }],
      'row 2 names Student ID S002, which is not in the student directory'
    ],
    // The row shapes `lib/workbook.js` can never yield. A null key used to be
    // read as a blank cell and the row skipped; a null activity used to make a
    // student who holds an activity look like one who holds none, which `GET`
    // would then answer with `count` 0 for the life of the process.
    [
      'a null key cell',
      [ACTIVITY_HEADER_ROW, { A: null, B: 'Hostel', C: UNUSED_ACTIVITY }],
      'cell A2 must be a string (received null)'
    ],
    [
      'a null activity cell',
      [ACTIVITY_HEADER_ROW, { A: 'S001', B: 'Hostel', C: null }],
      'cell C2 must be a string (received null)'
    ],
    [
      'an array row',
      [ACTIVITY_HEADER_ROW, ['S001', 'Hostel', S001_ACTIVITY]],
      'row 2 must be a plain object keyed by column letter (received array)'
    ],
    [
      'a non-record object row',
      [ACTIVITY_HEADER_ROW, new Date()],
      'row 2 must be a plain object keyed by column letter (received non-record object)'
    ]
  ];
  for (const [label, activityRows, expected] of cases) {
    assert.throws(
      () => activityRepository.fromData({
        directory,
        activityRows,
        registryRecords: [],
        activitiesDataPath: path.join(mkTemp(), REGISTRY_FILENAME)
      }),
      (error) => {
        assert.equal(error.code, CODE_REPOSITORY_INVALID, `${label}: wrong error code`);
        assert.ok(
          error.message.includes(expected),
          `${label}: the message must state "${expected}"; got "${error.message}"`
        );
        return true;
      },
      `${label}: an activity must never be served for a student the directory does not know`
    );
  }

  // A supplied registry must be the array `load` would have passed. `null` is a
  // caller who meant to supply records and supplied none, not an empty registry:
  // accepting it would make injected construction more permissive than
  // construction from a file and under-report every student's activities.
  const workbookOnlyRows = [ACTIVITY_HEADER_ROW, { A: 'S001', B: 'Hostel', C: S001_ACTIVITY }];
  for (const supplied of [null, 'not an array', 42, {}]) {
    assert.throws(
      () => activityRepository.fromData({
        directory,
        activityRows: workbookOnlyRows,
        registryRecords: supplied,
        activitiesDataPath: path.join(mkTemp(), REGISTRY_FILENAME)
      }),
      (error) => {
        assert.equal(
          error.code,
          CODE_REPOSITORY_INVALID,
          `registryRecords ${JSON.stringify(supplied)}: wrong error code`
        );
        assert.ok(
          error.message.includes('registryRecords must be an array of records'),
          `registryRecords ${JSON.stringify(supplied)}: got "${error.message}"`
        );
        return true;
      },
      `registryRecords ${JSON.stringify(supplied)} must be refused, not read as empty`
    );
  }

  // Omission remains the one shorthand for an empty registry, so a caller with
  // workbook data alone still builds.
  const workbookOnly = activityRepository.fromData({
    directory,
    activityRows: workbookOnlyRows,
    activitiesDataPath: path.join(mkTemp(), REGISTRY_FILENAME)
  });
  assert.equal(
    workbookOnly.recordCount(),
    1,
    'omitting registryRecords must build a repository holding the workbook record alone'
  );
});

test('32 an unreadable or malformed workbook fails with the path named', async () => {
  const workingDirectory = mkTemp();

  const notAPackage = path.join(workingDirectory, 'not-a-package.xlsx');
  fs.writeFileSync(notAPackage, 'not a zip', 'utf8');

  // This is the only test that assembles archives, so the compressor is
  // required here rather than at the top of the file.
  const zlib = require('node:zlib');

  /**
   * Assembles a minimal, valid one-entry ZIP package: local file header, the
   * entry data, the central directory record pointing back at it, then the
   * end-of-central-directory record. The CRC and the timestamps are left zero
   * deliberately - the reader resolves its entry by name and validates
   * structure, and checks neither.
   *
   * Each option forges exactly one field, which is what lets the reader's
   * fail-closed branches be reached without a hand-assembled buffer per case:
   * a package must be refused when it declares a part far larger than the
   * reader's ceiling, when its DEFLATE stream expands past what it declared,
   * when a central record claims variable-length bytes it does not carry, or
   * when the walked records do not fill the declared directory. And it must
   * still be READ when the only oddity is a legal archive comment.
   *
   * @param {string} body The entry's content.
   * @param {{entryName?: string, stored?: boolean, declaredSize?: number,
   *   declaredExtra?: number, comment?: Buffer, padding?: Buffer,
   *   flags?: number, duplicate?: boolean}} [options]
   * @returns {Buffer} The package bytes.
   */
  const buildPackage = (body, options = {}) => {
    const {
      entryName = 'xl/worksheets/sheet1.xml',
      stored = false,
      declaredSize,
      declaredExtra = 0,
      comment = Buffer.alloc(0),
      padding = Buffer.alloc(0),
      flags = 0,
      duplicate = false
    } = options;
    const name = Buffer.from(entryName, 'utf8');
    const content = Buffer.from(body, 'utf8');
    const data = stored ? content : zlib.deflateRawSync(content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(stored ? 0 : 8, 8);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const localPart = Buffer.concat([localHeader, name, data]);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(stored ? 0 : 8, 10);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(declaredSize === undefined ? content.length : declaredSize, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(declaredExtra, 30);
    centralHeader.writeUInt32LE(0, 42);
    const record = Buffer.concat([centralHeader, name]);
    // Two records naming one part: which of them describes the data is a
    // question the package does not answer, so it may not be guessed at.
    const centralPart = duplicate ? Buffer.concat([record, record]) : record;
    const entries = duplicate ? 2 : 1;

    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(0x06054b50, 0);
    endRecord.writeUInt16LE(entries, 8);
    endRecord.writeUInt16LE(entries, 10);
    endRecord.writeUInt32LE(centralPart.length + padding.length, 12);
    endRecord.writeUInt32LE(localPart.length, 16);
    endRecord.writeUInt16LE(comment.length, 20);
    return Buffer.concat([localPart, centralPart, padding, endRecord, comment]);
  };

  /**
   * Writes a built package into the working directory.
   *
   * @param {string} name The filename to write.
   * @param {string} body The worksheet part's content.
   * @param {object} [options] Passed straight to `buildPackage`.
   * @returns {string} The absolute path written.
   */
  const packageAt = (name, body, options) => {
    const target = path.join(workingDirectory, name);
    fs.writeFileSync(target, buildPackage(body, options));
    return target;
  };

  /**
   * Wraps cells in the worksheet shell the reader requires.
   *
   * @param {string} inner The `<row>` elements.
   * @returns {string} A complete worksheet part.
   */
  const sheet = (inner) => `<worksheet><sheetData>${inner}</sheetData></worksheet>`;

  /** One well-formed inline-string row, the control every forgery deviates from. */
  const validRow = '<row r="1"><c r="A1" t="inlineStr"><is><t>S001</t></is></c></row>';

  /** A megabyte of spaces: compresses tiny, so a small entry declares a big part. */
  const expandsLarge = ' '.repeat(1024 * 1024);

  const cases = [
    ['a missing file', path.join(workingDirectory, 'absent.xlsx'), 'Workbook not found'],
    ['a non-ZIP file', notAPackage, 'Not a valid .xlsx package'],
    [
      'a package with no worksheet part',
      packageAt('no-worksheet.xlsx', 'an entry that is not a worksheet', {
        entryName: 'note.txt',
        stored: true
      }),
      'has no xl/worksheets/sheet1.xml part'
    ],
    // A directory raises EISDIR for every user, which makes it the
    // deterministic stand-in for an unreadable file: a mode-based permission
    // test would pass silently for root.
    ['a directory rather than a file', workingDirectory, 'Workbook could not be read'],
    // Truncated markup must never come back as fewer students. The first cut
    // lands before any row closes, which a pattern-matching parser reports as
    // an empty sheet; the second lands after a complete row, which it reports
    // as a one-row sheet. Both are the same fault and both must be refused.
    [
      'a worksheet part truncated before its first row closes',
      packageAt(
        'truncated-empty.xlsx',
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Student ID'
      ),
      'Workbook worksheet XML is malformed'
    ],
    [
      'a worksheet part truncated after a complete row',
      packageAt('truncated-partial.xlsx', `<worksheet><sheetData>${validRow}<row r="2"><c r="A2"`),
      'Workbook worksheet XML is malformed'
    ],
    [
      'unbalanced worksheet markup',
      packageAt(
        'unbalanced.xlsx',
        sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></row></c>')
      ),
      'Workbook worksheet XML is malformed'
    ],
    // A shared-string cell stores an index into a table this reader does not
    // read, so returning its <v> would print '0' where the sheet shows text.
    [
      'a shared-string cell',
      packageAt('shared-string.xlsx', sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>')),
      'shared-string cell (t="s")'
    ],
    [
      'an unsupported cell type',
      packageAt('boolean-cell.xlsx', sheet('<row r="1"><c r="A1" t="b"><v>1</v></c></row>')),
      'declares cell type t="b"'
    ],
    [
      'a formula cell',
      packageAt(
        'formula.xlsx',
        sheet('<row r="1"><c r="A1"><f>SUM(B1:B2)</f><v>42</v></c></row>')
      ),
      'carries a formula'
    ],
    [
      'merged-cell metadata',
      packageAt(
        'merged.xlsx',
        `<worksheet><sheetData>${validRow}</sheetData>` +
          '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>'
      ),
      'merged cell range'
    ],
    // A reference that merely STARTS with letters must not be read as that
    // column: a forged one would otherwise populate or overwrite a real key.
    [
      'a partial cell reference',
      packageAt(
        'forged-reference.xlsx',
        sheet('<row r="1"><c r="A-not-a-row" t="inlineStr"><is><t>forged</t></is></c></row>')
      ),
      'is not a column letter and row number'
    ],
    [
      'a duplicated column in one row',
      packageAt(
        'duplicate-column.xlsx',
        sheet(
          '<row r="1"><c r="A1" t="inlineStr"><is><t>real</t></is></c>' +
            '<c r="A1" t="inlineStr"><is><t>forged</t></is></c></row>'
        )
      ),
      'stores column A twice'
    ],
    [
      'a cell with no reference at all',
      packageAt(
        'unkeyed-cell.xlsx',
        sheet('<row r="1"><c t="inlineStr"><is><t>unkeyed</t></is></c></row>')
      ),
      'carries no r attribute'
    ],
    // Character data the reader has nowhere to put is refused rather than
    // dropped, both outside the root element and inside every element-only
    // context - otherwise a document that is not well formed still yields rows.
    [
      'character data before the root element',
      packageAt('text-before-root.xlsx', `junk${sheet(validRow)}`),
      `sits outside the <worksheet> element`
    ],
    [
      'character data after the root element',
      packageAt('text-after-root.xlsx', `${sheet(validRow)}junk`),
      `sits outside the <worksheet> element`
    ],
    [
      'character data directly inside a row',
      packageAt('text-in-row.xlsx', sheet('<row r="1">stray</row>')),
      'carries character data "stray"'
    ],
    // A recognised element in a place the reader does not look for one must
    // fail closed: stepping over it as though it were unknown discards a value.
    [
      'a value element outside a cell',
      packageAt('value-in-row.xlsx', sheet('<row r="1"><v>discarded</v></row>')),
      '<v> is inside <row> rather than <c>'
    ],
    [
      'a value element inside an inline string',
      packageAt(
        'value-in-inline-string.xlsx',
        sheet('<row r="1"><c r="A1" t="inlineStr"><is><v>discarded</v></is></c></row>')
      ),
      '<v> is inside <is> rather than <c>'
    ],
    [
      'a text element outside any inline string',
      packageAt('text-in-run.xlsx', sheet('<row r="1"><r><t>discarded</t></r></row>')),
      '<t> is outside any <is>'
    ],
    [
      'an inline string outside a cell',
      packageAt(
        'inline-string-in-row.xlsx',
        sheet('<row r="1"><is><t>discarded</t></is></row>')
      ),
      '<is> is inside <row> rather than <c>'
    ],
    [
      'a row outside sheetData',
      packageAt('row-outside-sheetdata.xlsx', `<worksheet>${validRow}</worksheet>`),
      '<row> is inside <worksheet> rather than <sheetData>'
    ],
    // A worksheet part needs no document type, and an entity declaration inside
    // one is how an XML reader gets talked into reading other files.
    [
      'a worksheet part carrying a document type declaration',
      packageAt('doctype.xlsx', `<!DOCTYPE worksheet [<!ENTITY x "y">]>${sheet(validRow)}`),
      'document type or entity declaration is not supported'
    ],
    // The element stack is bounded, so nesting cannot be used to grow it.
    [
      'worksheet markup nested past the depth cap',
      packageAt('deeply-nested.xlsx', `<worksheet>${'<sheetPr>'.repeat(70)}`),
      'elements nest deeper than'
    ],
    // Resource bounds: the declared size is refused above the ceiling before
    // anything is inflated, and a stream that lies about its size is stopped
    // at the declaration rather than allowed to allocate past it.
    [
      'a worksheet part declaring more than the reader will inflate',
      packageAt('too-large.xlsx', sheet(validRow), { declaredSize: 33 * 1024 * 1024 }),
      'Workbook worksheet part is too large'
    ],
    [
      'a DEFLATE stream that expands past its declared size',
      packageAt('expanding.xlsx', expandsLarge, { declaredSize: 64 }),
      'could not be decompressed'
    ],
    [
      'a DEFLATE stream that stops short of its declared size',
      packageAt('short-stream.xlsx', sheet(validRow), {
        declaredSize: Buffer.byteLength(sheet(validRow)) + 10
      }),
      'inflated to'
    ],
    [
      'a stored entry whose two sizes disagree',
      packageAt('stored-mismatch.xlsx', sheet(validRow), { stored: true, declaredSize: 12 }),
      'compressed and 12 uncompressed bytes'
    ],
    // Central-directory integrity: a record must carry every variable-length
    // byte it declares, and the walked records must fill the declared range.
    [
      'a central record declaring extra bytes it does not carry',
      packageAt('short-record.xlsx', sheet(validRow), { declaredExtra: 20 }),
      'which do not fit inside the declared central directory'
    ],
    [
      'a central directory the walked records do not fill',
      packageAt('short-walk.xlsx', sheet(validRow), { padding: Buffer.alloc(40, 0) }),
      'the walk consumed'
    ],
    [
      'a worksheet part declared by two central records',
      packageAt('duplicate-entry.xlsx', sheet(validRow), { duplicate: true }),
      'declared by more than one central directory entry'
    ],
    [
      'an encrypted worksheet entry',
      packageAt('encrypted.xlsx', sheet(validRow), { flags: 0x0001 }),
      'is encrypted'
    ]
  ];
  for (const [label, target, expected] of cases) {
    assert.throws(
      () => readWorksheetRows(target),
      (error) => {
        assert.equal(error.code, CODE_WORKBOOK_READ_FAILED, `${label}: wrong error code`);
        assert.ok(
          error.message.includes(expected),
          `${label}: the message must state "${expected}"; got "${error.message}"`
        );
        assert.ok(
          error.message.includes(target),
          `${label}: the message must name the path; got "${error.message}"`
        );
        assert.equal(error.path, target, `${label}: the error must carry the path`);
        return true;
      },
      `${label}: a failed read must abort construction with the path named`
    );
  }

  // The mirror image of the cases above: `PK\x05\x06` is four ordinary bytes
  // and may legally sit inside an archive comment, which trails the record it
  // follows. A backward scan therefore meets the decoy FIRST, and a reader
  // that accepts the first signature-shaped bytes rejects a valid package. The
  // real record must still be found, and the sheet must still be read.
  const decoyComment = Buffer.concat([
    Buffer.from('release notes ', 'utf8'),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.alloc(30, 0x41)
  ]);
  const commented = packageAt('commented.xlsx', sheet(validRow), { comment: decoyComment });
  assert.deepEqual(
    readWorksheetRows(commented),
    [{ A: 'S001' }],
    'a legal archive comment containing the end-of-central-directory signature must ' +
      'not hide the real record'
  );

  // The same decoy, but complete: a full 22-byte record shape inside the
  // comment, signature and all fields. Field-level validation alone does not
  // dismiss it - it takes tying the candidate to a central directory that
  // actually walks and actually declares the worksheet, and stepping over the
  // candidate when it does not.
  const recordShapedComment = Buffer.alloc(22);
  recordShapedComment.writeUInt32LE(0x06054b50, 0);
  const recordDecoy = packageAt('record-decoy.xlsx', sheet(validRow), {
    comment: recordShapedComment
  });
  assert.deepEqual(
    readWorksheetRows(recordDecoy),
    [{ A: 'S001' }],
    'a legal archive comment holding a complete record-shaped decoy must not hide ' +
      'the real end-of-central-directory record'
  );

  // An unusable ARGUMENT is reported exactly like an unusable file: same code,
  // and a `path` carrying a safe rendering of what arrived. The rendering is
  // built from the value's type, so a hostile `toString` cannot reach it.
  const argumentCases = [
    ['a number', 42, '42', 'received number'],
    ['null', null, '<null>', 'received null'],
    ['an object', { toString: () => 'hijacked' }, '<object>', 'received object'],
    ['whitespace only', '   ', '   ', 'received an empty string']
  ];
  for (const [label, argument, rendered, detail] of argumentCases) {
    assert.throws(
      () => readWorksheetRows(argument),
      (error) => {
        assert.equal(error.code, CODE_WORKBOOK_READ_FAILED, `${label}: wrong error code`);
        assert.equal(error.path, rendered, `${label}: the error must carry a safe path`);
        assert.ok(
          error.message.includes(rendered) && error.message.includes(detail),
          `${label}: the message must name the value and its type; got "${error.message}"`
        );
        return true;
      },
      `${label}: an unusable path argument must fail with the documented shape`
    );
  }
});

test('33 injecting both dependencies reads no file at all', async () => {
  const registryPath = seedRegistry();
  const { directory, repository } = realDeps(registryPath);
  const missing = path.join(mkTemp(), 'no-such-dir');
  // Both dependencies are supplied, so neither path is opened, checked, nor
  // created - which is exactly what lets a test point them at nothing.
  const server = createServer({
    directory,
    repository,
    workbookDir: missing,
    activitiesDataPath: path.join(missing, REGISTRY_FILENAME)
  });
  assert.ok(server instanceof http.Server, 'createServer must return an http.Server');
  assert.equal(
    server.config.workbookDir,
    missing,
    'the resolved configuration must carry the path it was given'
  );
  assert.equal(
    fs.existsSync(missing),
    false,
    'a nonexistent workbook directory must be neither touched nor created'
  );
  // `createServer` never listens, so there is nothing here to close.
  assert.equal(server.listening, false, 'createServer must return a non-listening server');
});
