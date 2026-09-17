# Student_Simple_06Sept26

A zero-dependency Node.js HTTP service, built on Node's built-in `http` module with no framework,
that serves student extracurricular-activity data keyed on `Student ID`. Student identity and each
student's baseline activity come from the committed workbooks, which the service only ever reads;
any additional activity lives in `activities.json`, the only file the service writes. The original
root greeting is unchanged, and three JSON routes are served beside it: a student's activities, the
roster of students for an activity, and a write path that records a new activity for a student.

## Prerequisites

- **Node.js 24.** `.nvmrc` pins `24.21.0` and `package.json` declares `engines.node` as
  `>=24.0.0 <25`. Nothing here is claimed for any other release line.
- **npm `>=11.0.0`**, declared as `engines.npm`.
- **No install step beyond `npm ci`.** The project has **zero dependencies**, so `npm ci` installs
  nothing and creates no `node_modules`; it exists so the committed `package-lock.json` is honoured
  and `npm audit` can run.

Neither pin is enforcement on its own: `.nvmrc` takes effect only when a version manager reads it,
and `engines` merely **warns** on a mismatch because no `.npmrc` sets `engine-strict`. The one place
the runtime contract is actually enforced is `npm test`, which refuses to run a single test when
`process.version` falls outside the declared `engines.node` range.

## Run

```bash
npm start          # equivalently: node server.js
```

The service binds `127.0.0.1:3000` and prints one readiness line to stdout:

```text
Server running at http://127.0.0.1:3000/
```

Requiring the entrypoint as a module binds no port: `listen` runs only when `server.js` is the
process entry point. `require('./server')` exposes `resolveConfig`, `createServer` (a non-listening
server) and `start` (a promise that resolves with the listening server).

## Configuration

Every value has the same precedence: an explicit `options` property passed to `createServer` or
`start`, then the environment variable, then the default below.

| Environment variable   | `options` property    | Default                           | Validation |
| ---------------------- | --------------------- | --------------------------------- | ---------- |
| `PORT`                 | `port`                | `3000`                            | Must match one to five decimal digits in full and fall in `0`–`65535`. `0` means "bind an ephemeral port". `1.5`, `3000abc`, `70000` and an empty value are startup errors, not silently coerced values. |
| `HOST`                 | `host`                | `127.0.0.1`                       | Must be non-empty after trimming. An empty value is a startup error rather than an implicit bind to every interface. |
| `ACTIVITIES_DATA_PATH` | `activitiesDataPath`  | `activities.json` beside `server.js` | A relative value is resolved against the entrypoint's directory. The file itself may be absent, but its directory must exist and be writable, or startup fails. |
| `WORKBOOK_DIR`         | `workbookDir`         | the directory of `server.js`      | Any path holding `student_details.xlsx` and `student_other_info.xlsx`. A relative value is resolved against the entrypoint's directory. |

**Relative path values resolve against the entrypoint's directory, never against the current
working directory**, so `node /path/to/server.js` reads the committed workbooks and registry no
matter where it was launched from. A rejected value fails startup with one stderr line naming the
value and a non-zero exit code.

The banner reports the host and the port actually bound, so a run with `PORT=0` prints the
ephemeral port it received.

## Endpoints

| Method       | Path                                             | Success                                              | Media type         |
| ------------ | ------------------------------------------------ | ---------------------------------------------------- | ------------------ |
| `GET`, `HEAD` | `/`                                             | `200`, the unchanged greeting (`Content-Length: 34`) | `text/plain`       |
| `GET`, `HEAD` | `/api/students/{studentId}/activities`          | `200`                                                | `application/json` |
| `POST`        | `/api/students/{studentId}/activities`          | `201` with `Location: /api/students/{studentId}/activities` | `application/json` |
| `GET`, `HEAD` | `/api/activities` — optional `?activity=NAME`   | `200`                                                | `application/json` |

- `HEAD` is handled on every `GET` route as its `GET` counterpart with the body suppressed: the same
  status and the same headers, `Content-Length` included, with zero body bytes.
- `{studentId}` is trimmed and upper-cased, then matched against `/^S\d{3}$/`, so `s001` and
  `%20S001%20` both address `S001`. The response always reports the normalized identifier. No
  padding is inferred — `S1` is malformed, not `S001`.
- `?activity=` is compared trimmed and case-insensitively, so `?activity=debate%20society` matches
  `Debate Society`. A filter that matches nothing is `200` with `{"count": 0, "activities": []}`,
  not an error.
- Path matching is **exact**: there is no trailing-slash normalization, so `/api/activities/` is a
  `404`.
- There is **no pagination**: the roster is the whole set, and the top-level `count` always equals
  `activities.length`.

### Examples

Real requests against the committed data. The `-i` responses show the headers this service sets;
Node's own `Date`, `Connection` and `Keep-Alive` lines are omitted from the excerpts.

The greeting, preserved byte for byte:

```bash
$ curl -i http://127.0.0.1:3000/
HTTP/1.1 200 OK
Content-Type: text/plain
Content-Length: 34

Hello, World Welcome to Sharebot!
```

A student's activities. `activities.json` ships empty, so every student starts with exactly the one
activity the workbook carries:

```bash
$ curl http://127.0.0.1:3000/api/students/S001/activities
{"studentId":"S001","name":"Aarav Sharma","count":1,"activities":[{"activity":"Robotics Club","source":"workbook"}]}
```

The reverse lookup — the students who hold an activity:

```bash
$ curl "http://127.0.0.1:3000/api/activities?activity=Robotics%20Club"
{"count":1,"activities":[{"activity":"Robotics Club","count":2,"studentIds":["S001","S009"]}]}
```

Unfiltered, the committed data answers with eight groups over ten records, ordered by the
case-folded activity name:

```bash
$ curl http://127.0.0.1:3000/api/activities
{"count":8,"activities":[{"activity":"Coding Club","count":1,"studentIds":["S005"]},{"activity":"Cricket Team","count":1,"studentIds":["S007"]},{"activity":"Dance Club","count":1,"studentIds":["S006"]},{"activity":"Debate Society","count":2,"studentIds":["S002","S010"]},{"activity":"Football Team","count":1,"studentIds":["S003"]},{"activity":"Music Club","count":1,"studentIds":["S004"]},{"activity":"Photography Club","count":1,"studentIds":["S008"]},{"activity":"Robotics Club","count":2,"studentIds":["S001","S009"]}]}
```

Recording a second activity for a student. The body carries exactly one field, `activity`; the
student comes from the path:

```bash
$ curl -i -X POST http://127.0.0.1:3000/api/students/S003/activities \
    -H 'Content-Type: application/json' \
    -d '{"activity":"Music Club"}'
HTTP/1.1 201 Created
Content-Type: application/json
Location: /api/students/S003/activities

{"studentId":"S003","activity":"Music Club","source":"registry"}
```

The student then holds both, workbook record first and registry records in file order:

```bash
$ curl http://127.0.0.1:3000/api/students/S003/activities
{"studentId":"S003","name":"Rohan Iyer","count":2,"activities":[{"activity":"Football Team","source":"workbook"},{"activity":"Music Club","source":"registry"}]}
```

## Errors

Every error response carries `Content-Type: application/json` and exactly this envelope — two keys,
nothing more:

```json
{"error":{"code":"…","message":"…"}}
```

Each code has one fixed sentence, so two requests that fail the same way produce the same bytes.

| Status | Code                        | When                                                                                          | `message` |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------- | --------- |
| `400`  | `INVALID_STUDENT_ID`        | The identifier fails `/^S\d{3}$/` after normalization, or its path segment carries a malformed percent-escape | `Student ID must match S followed by three digits: <value>` |
| `400`  | `MALFORMED_JSON`            | The request body is not parseable JSON                                                         | `Request body is not valid JSON` |
| `400`  | `INVALID_ACTIVITY`          | `activity` is missing, not a string, empty or whitespace-only, or longer than 64 characters    | `activity must be a string of 1 to 64 characters` |
| `400`  | `UNEXPECTED_FIELD`          | The body carries any key other than `activity`                                                 | `Unexpected field: <key>` |
| `404`  | `STUDENT_NOT_FOUND`         | A well-formed identifier that the directory does not know                                      | `No student with Student ID <value>` |
| `404`  | `NOT_FOUND`                 | An unrecognised path                                                                           | `No route for <method> <path>` |
| `405`  | `METHOD_NOT_ALLOWED`        | A recognised path on an unsupported method; the response carries an exact `Allow` header        | `Method <method> is not allowed on <path>` |
| `409`  | `ACTIVITY_ALREADY_RECORDED` | The student already holds that activity, compared case-insensitively                            | `Student <id> already holds activity <value>` |
| `413`  | `PAYLOAD_TOO_LARGE`         | The request body exceeds 8192 bytes                                                            | `Request body exceeds 8192 bytes` |
| `415`  | `UNSUPPORTED_MEDIA_TYPE`    | A `POST` without `Content-Type: application/json`                                              | `Content-Type must be application/json` |
| `500`  | `INTERNAL_ERROR`            | An internal fault — a failed registry write, or a dependency error while serving a read. The detail goes to stderr; no exception text or stack is ever returned | `Could not persist the activity record` |

How the placeholders render: `<value>` for an identifier is the raw, still-encoded path segment as
received, truncated to 64 characters, and for an activity it is the trimmed name the caller supplied;
`<path>` is the raw request target with the query string removed, so a `404` for `/api/unknown?x=1`
reads `No route for GET /api/unknown`; `<key>` is the first offending key in the body's own key
order; `<method>` is the request method verbatim; `<id>` is the normalized identifier.

`Allow` values are exact and ordered:

| Path                                   | `Allow`           |
| -------------------------------------- | ----------------- |
| `/`                                    | `GET, HEAD`       |
| `/api/students/{studentId}/activities` | `GET, HEAD, POST` |
| `/api/activities`                      | `GET, HEAD`       |

`Content-Type` is matched on the media type only, so `application/json; charset=utf-8` is accepted.
An error response also declares `Connection: close`, because a connection whose request body was
never interpreted is not one to reuse.

**Validation order is fixed**, so a request with several faults gets one predictable response: path,
then method, then identifier shape, then identifier existence, then — for `POST` only — media type,
body size, JSON parse, unexpected keys, `activity` validity, the duplicate check and finally
persistence. A `POST` to an unknown student carrying an oversize, unparseable body therefore answers
`404`, not `413` or `400`.

## Activity data

### Workbook sources, read-only

| Workbook                   | Sheet             | Columns read                                           | Used for |
| -------------------------- | ----------------- | ------------------------------------------------------ | -------- |
| `student_other_info.xlsx`  | `Other Info`      | A `Student ID`, C `Extracurricular Activity`           | One baseline activity per student, served with `source: "workbook"` |
| `student_details.xlsx`     | `Student Details` | A `Student ID`, B `Name`                               | Which students exist, and the `name` in the per-student response |

Every populated row after the validated header row is read, so there is no fixed row bound: a
student added by hand to both workbooks is served without a code change.

**No other directory column is retained or serialized.** A worksheet is decompressed as a unit, so
Gender, Date of Birth, Age, Department, Year, Email, Phone and City are parsed and then discarded as
the index is built; none of them is held in memory beyond that or appears in any response.
`student_academics.xlsx` is **not opened by the service** at all — only by the test suite, for a
cross-workbook key-set check. The workbook binaries are never written.

### The registry, `activities.json`

A JSON array, shipped **empty** — no participation record is invented, so every student holds
exactly the one workbook activity until something is posted. Each stored record is exactly two
fields:

```json
[
  {"studentId": "S001", "activity": "Robotics Club"}
]
```

That block shows the record **shape** only. Written as it stands it would not load, because
`Robotics Club` is already S001's workbook activity and a duplicate in the registry is a fatal
startup error: a hand-added record has to name an activity the student does not already hold.

`source` is **not stored and must not be sent**: it is derived at serialization time from where a
record came, which is why a body supplying it is refused with `400 UNEXPECTED_FIELD`.

Field rules:

| Field       | Rules |
| ----------- | ----- |
| `studentId` | Matches `/^S\d{3}$/` after trimming and upper-casing, and must exist in `student_details.xlsx`. On a `POST` it is taken from the path only, never from the body. |
| `activity`  | Free text: a string of 1 to 64 characters after trimming. It is **not** a closed enumeration. |

The eight names the committed workbook happens to use are the **observed catalog, not a list of
allowed values**: `Robotics Club`, `Debate Society`, `Football Team`, `Music Club`, `Coding Club`,
`Dance Club`, `Cricket Team`, `Photography Club`.

Record identity is the pair `(studentId, activityKey)`, where `activityKey` is the activity name
trimmed and lower-cased. A student may therefore hold several activities, but never the same one
twice: a repeat — of the workbook value or of an earlier registry record, in any casing — is refused
with `409 ACTIVITY_ALREADY_RECORDED` and nothing is written. Grouping on the roster route uses that
same key, so `Robotics Club` and `robotics club` are one group; the label shown is the spelling of
the group's first member, and groups are ordered by `activityKey` ascending.

### Operational notes

- The workbooks and the registry are read **once, at startup**, so an edit to any of them is picked
  up only on restart. Twenty data rows cannot change under a running process, so per-request
  filesystem I/O would be pure cost.
- **Edit the workbooks while the service is stopped.** A read taken while a workbook is being
  rewritten can load a coherent-looking but partial snapshot; header validation catches a reshaped
  sheet, but nothing protects a running service from a file that was half-written at the instant it
  was read.
- A **missing** `activities.json` is tolerated: the registry is treated as empty, a warning is
  written to stderr, and the workbook-sourced data is still served. Malformed JSON, a non-array
  root, a record failing field validation, a duplicate record, or a `studentId` absent from the
  directory is a **fatal startup error** naming the offending record — silently ignoring a corrupt
  registry would under-report a student's activities.
- The registry's **directory** is a different matter: it must exist and be writable at startup, so a
  misconfigured `ACTIVITIES_DATA_PATH` fails while the server is being built rather than on the
  first `POST` hours later.
- The same integrity rules apply to the workbooks: a header cell that is not exactly its expected
  label, a malformed or duplicate `Student ID`, a blank `Name`, an activity row naming a student the
  directory does not know, or a workbook that is missing or unreadable all abort startup with the
  file, row or record named.
- A write rewrites the whole registry to `activities.json.tmp` beside the target and renames it over
  the file, so a failed write can never leave a partial append, and no `.tmp` artifact is left
  behind. Writes are serialized on a single queue, so two concurrent `POST`s of the same activity
  produce one `201` and one `409`.
- Writes are **single-process**. Two processes sharing one registry file would interleave; this
  service does not coordinate between instances.

## Verification

```bash
npm test                 # node verify-tests.js — the authoritative command
npm run test:raw         # the unguarded runner, for reading per-test output
npm ci                   # honours the lockfile; installs nothing (zero dependencies)
npm audit                # expect: found 0 vulnerabilities
for f in server.js verify-tests.js lib/*.js test/*.test.js; do node --check "$f" || exit 1; done
```

`npm test` runs `verify-tests.js`, which runs the three test files once at concurrency 1 and exits
`0` **only** when all 45 tests passed, none failed and none was cancelled. It also refuses to run
anything when `process.version` falls outside `engines.node`, which is the one place the runtime
contract is enforced rather than merely declared.

The guard exists because a bare `node --test` that discovers no test file prints a zero count and
still **exits 0**, so an exit status alone cannot prove the suite ran. To confirm the guard is live,
raise the minimum above what the suite can meet — this must exit `1`:

```bash
MIN_TESTS=46 npm test
```

`npm run test:raw` is the same three files through `node --test` with no guard; use it to read
per-test output while developing, not as the gate. Both commands name the test files explicitly,
because passing a directory to `node --test` fails and because every `.js` file inside `test/` would
otherwise be executed as a test.

`npm audit` needs registry access; a network failure there is not a feature failure. Note that
`test/server.test.js` deliberately spawns the real entrypoint on `127.0.0.1:3000`, so stop a running
`npm start` before running the suite.

There is no linter, formatter, type checker, coverage tool or CI pipeline in this project;
`node --check` is the static gate.

## Security

The service binds `127.0.0.1` by default, and **that loopback default is the only access control
there is**: no authentication, no authorization, no TLS, no CORS and no rate limiting exists
anywhere in this project. Every process on the host reaches the activity API anonymously, and any
client that reaches it can also `POST` new activity records.

**Setting `HOST=0.0.0.0` publishes the service to the network while it authenticates nobody.** The
exposure is bounded — the only directory field retained and serialized is `Name`, so no Gender, Date
of Birth, Age, Department, Year, Email, Phone or City value can leave the process — but the bound is
not a substitute for access control. Widening the bind is the change that would require
authentication, authorization, TLS and rate limiting together, and none of them is implemented here.
