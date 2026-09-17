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
 * enforced against the student directory. Every value asserted here was read
 * out of the committed workbooks (`Student Details!A2:B11`,
 * `Other Info!A2:A11`/`C2:C11`), never invented: `S001` is `Aarav Sharma`
 * holding `Robotics Club`, `S003` is `Rohan Iyer` holding `Football Team`, and
 * the roster is the eight groups those ten rows produce.
 *
 * WHAT IT RUNS AGAINST
 * ---------------------------------------------------------------------------
 * `start()` from `server.js` - the single composition root - so the wiring
 * under test is the wiring that ships. Dependencies are injected only where the
 * committed data cannot reach a case at all: a student holding no activity, a
 * label collision that folds case, a registry fault, and a writer that fails.
 * Those go through `studentDirectory.fromRows`, `activityRepository.fromData`
 * and its `writeFile` seam rather than through a new binary fixture, which is
 * the whole reason those seams exist.
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
 *
 * The error contract is deterministic by design - one fixed sentence per code,
 * with the offending value interpolated after a colon - so the sentences are
 * asserted verbatim. A "contains" assertion would let a message drift.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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
 * The `fs.mkdtempSync` prefix for every throwaway registry directory. A shared
 * helper module cannot hold it - every `.js` file inside a directory named
 * `test/` is executed as a test by default discovery - so the literal is
 * duplicated in `test/workbooks.test.js` and MUST STAY IN STEP WITH IT: that
 * file fails the run if an entry with this prefix survives in `os.tmpdir()`.
 */
const TEMP_PREFIX = 'student-activities-';

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

/** An activity no student holds, used wherever a write must succeed. */
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

/* ---------------------------------------------------------------------------
 * Inline harness. No assertion appears below this line until the first test.
 * ------------------------------------------------------------------------- */

/** Every listening server this file started, closed by the `after` hook. */
const servers = [];

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
 * Starts a server on an ephemeral loopback port through the real composition
 * root and remembers it for cleanup.
 *
 * @param {object} options Overrides passed straight to `start`, typically an
 *   injected `directory` and `repository`.
 * @returns {Promise<import('node:http').Server>} The listening server.
 */
const startServer = async (options) => {
  const server = await start({ port: EPHEMERAL_PORT, host: LOOPBACK_HOST, ...options });
  servers.push(server);
  return server;
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
 * @param {import('node:http').Server} server A listening server.
 * @param {{method?: string, path: string, headers?: object, body?: string}} options
 *   The request to issue.
 * @returns {Promise<{status: number, headers: object, text: string, bytes: number}>}
 *   The status, the response headers, the body as UTF-8 text, and the exact
 *   number of body bytes received - which is how `HEAD` is proved bodiless.
 */
const request = (server, options) => new Promise((resolve, reject) => {
  const settings = options === undefined ? {} : options;
  let responded = false;
  const req = http.request(
    {
      host: LOOPBACK_HOST,
      port: server.address().port,
      path: settings.path,
      method: settings.method === undefined ? METHOD_GET : settings.method,
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
      res.on('error', reject);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
          bytes
        });
      });
    }
  );
  req.on('error', (error) => {
    if (!responded) reject(error);
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
  while (servers.length > 0) {
    const server = servers.pop();
    // Idle keep-alive sockets would otherwise hold `close()` open; dropping
    // them is what lets the runner exit without `--test-force-exit`.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
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
  assert.ok(
    String(res.headers['content-type']).includes(JSON_MEDIA_TYPE),
    `GET ${S001_PATH} must be JSON; content-type was ${res.headers['content-type']}`
  );
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
});

test('4 a well-formed but unknown Student ID is a 404, not a 400', async () => {
  const expected = errorBody(CODE_STUDENT_NOT_FOUND, 'No student with Student ID S999');
  const res = await request(sharedServer, { path: S999_PATH });
  assert.equal(res.status, STATUS_NOT_FOUND, `an unknown ID must be a 404; body was ${res.text}`);
  assert.deepEqual(json(res), expected);
  assert.equal(res.text, JSON.stringify(expected));
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
  const targets = [ROOT_PATH, S001_PATH, ACTIVITIES_PATH];
  for (const target of targets) {
    const get = await request(sharedServer, { path: target });
    const head = await request(sharedServer, { method: METHOD_HEAD, path: target });
    assert.equal(head.status, get.status, `HEAD ${target}: status must match the GET`);
    assert.equal(
      head.headers['content-type'],
      get.headers['content-type'],
      `HEAD ${target}: content-type must match the GET`
    );
    assert.equal(
      head.headers['content-length'],
      String(Buffer.byteLength(get.text)),
      `HEAD ${target}: content-length must be the length the GET body had`
    );
    assert.equal(head.bytes, 0, `HEAD ${target}: not one body byte may be written`);
  }
  // The root's declared length is the preserved greeting's, to the byte, and it
  // is still the plain-text media type the baseline sent.
  const rootHead = await request(sharedServer, { method: METHOD_HEAD, path: ROOT_PATH });
  assert.equal(
    rootHead.headers['content-length'],
    String(GREETING_BYTE_LENGTH),
    'HEAD / must declare the 34-byte greeting length'
  );
  assert.ok(
    String(rootHead.headers['content-type']).includes(TEXT_MEDIA_TYPE),
    `HEAD / must stay ${TEXT_MEDIA_TYPE}; got ${rootHead.headers['content-type']}`
  );
});

/* ---------------------------------------------------------------------------
 * Tests 12-24: the write path. Each test owns its registry file, so no test
 * depends on another's writes and every file-byte assertion is deterministic.
 * ------------------------------------------------------------------------- */

test('12 a POST records a second activity and stores exactly two fields', async () => {
  const { server, registryPath } = await startWritableServer();
  const created = await postJson(server, S003_PATH, { activity: NEW_ACTIVITY });
  assert.equal(created.status, STATUS_CREATED, `the POST must be a 201; body was ${created.text}`);
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

test('20 a body over 8 KiB is refused with the size named', async () => {
  const { server, registryPath } = await startWritableServer();
  const before = fs.readFileSync(registryPath);
  // Sent in a single `req.end()`. The server answers and drains the request, so
  // any client-side ECONNRESET is tolerated by the harness rather than failing
  // the assertion this test is making.
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
});

test('22 a failed write is a 500 that leaks nothing and leaves no artifact', async () => {
  const registryDir = mkTemp();
  const registryPath = path.join(registryDir, REGISTRY_FILENAME);
  fs.writeFileSync(registryPath, EMPTY_REGISTRY, 'utf8');
  const directory = studentDirectory.fromRows([
    DIRECTORY_HEADER_ROW,
    { A: 'S001', B: S001_NAME }
  ]);
  const repository = activityRepository.fromData({
    directory,
    activityRows: [ACTIVITY_HEADER_ROW, { A: 'S001', B: 'Hostel', C: S001_ACTIVITY }],
    registryRecords: [],
    activitiesDataPath: registryPath,
    writeFile: () => {
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
  assert.deepEqual(json(res), errorBody(CODE_INTERNAL_ERROR, MESSAGE_INTERNAL_ERROR));
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

  const read = await request(server, { path: S001_PATH });
  assert.deepEqual(
    json(read).activities,
    [{ activity: S001_ACTIVITY, source: 'workbook' }],
    'the in-memory index must be untouched by a write that failed'
  );
  const leftovers = fs.readdirSync(registryDir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(
    leftovers,
    [],
    `a failed write must discard its temporary file; found ${leftovers.join(', ')}`
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
    ['PUT', ROOT_PATH, ALLOW_ROOT]
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
});

test('26 an unrecognised path is a 404 naming the query-stripped target', async () => {
  // There is no trailing-slash normalization, which is why `/api/activities/`
  // is a 404 rather than the roster, and the query string never reaches the
  // message.
  const cases = [
    ['/api/unknown', '/api/unknown'],
    ['/api/activities/', '/api/activities/'],
    ['/nope', '/nope'],
    ['/api/unknown?x=1', '/api/unknown']
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
});

test('27 every payload carries exactly its documented keys and no discarded column', async () => {
  const { server } = await startWritableServer();
  const perStudent = await request(server, { path: S001_PATH });
  const roster = await request(server, { path: ACTIVITIES_PATH });
  const created = await postJson(server, S003_PATH, { activity: UNUSED_ACTIVITY });
  const failure = await request(server, { path: S999_PATH });
  assert.equal(created.status, STATUS_CREATED, `the POST must succeed; body was ${created.text}`);

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

  // Gender, Date of Birth, Age, Department, Year, Email, Phone and City are
  // parsed with the worksheet and then discarded, so neither a column name nor
  // a distinctive value from S001's row may appear in any response.
  const payloads = [
    ['per-student', perStudent.text],
    ['roster', roster.text],
    ['created', created.text],
    ['error', failure.text]
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
});

test('32 an unreadable or malformed workbook fails with the path named', async () => {
  const workingDirectory = mkTemp();

  const notAPackage = path.join(workingDirectory, 'not-a-package.xlsx');
  fs.writeFileSync(notAPackage, 'not a zip', 'utf8');

  // A minimal, valid ZIP package holding one STORED entry that is not the
  // worksheet part: local file header, then the central directory entry that
  // points back at it, then the end-of-central-directory record. The CRC and
  // the timestamps are left zero deliberately - the reader locates its entry by
  // name and throws before it inflates or verifies anything.
  const entryName = Buffer.from('note.txt', 'utf8');
  const entryData = Buffer.from('an entry that is not a worksheet', 'utf8');
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt32LE(entryData.length, 18);
  localHeader.writeUInt32LE(entryData.length, 22);
  localHeader.writeUInt16LE(entryName.length, 26);
  const localPart = Buffer.concat([localHeader, entryName, entryData]);
  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt32LE(entryData.length, 20);
  centralHeader.writeUInt32LE(entryData.length, 24);
  centralHeader.writeUInt16LE(entryName.length, 28);
  centralHeader.writeUInt32LE(0, 42);
  const centralPart = Buffer.concat([centralHeader, entryName]);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralPart.length, 12);
  endRecord.writeUInt32LE(localPart.length, 16);
  const withoutWorksheet = path.join(workingDirectory, 'no-worksheet.xlsx');
  fs.writeFileSync(withoutWorksheet, Buffer.concat([localPart, centralPart, endRecord]));

  const cases = [
    ['a missing file', path.join(workingDirectory, 'absent.xlsx'), 'Workbook not found'],
    ['a non-ZIP file', notAPackage, 'Not a valid .xlsx package'],
    ['a package with no worksheet part', withoutWorksheet, 'has no xl/worksheets/sheet1.xml part'],
    // A directory raises EISDIR for every user, which makes it the
    // deterministic stand-in for an unreadable file: a mode-based permission
    // test would pass silently for root.
    ['a directory rather than a file', workingDirectory, 'Workbook could not be read']
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
        return true;
      },
      `${label}: a failed read must abort construction with the path named`
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
