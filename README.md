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

Started that way — from the command line, with `server.js` as the process entry point — the service
binds `127.0.0.1:3000` and prints one readiness line to stdout:

```text
Server running at http://127.0.0.1:3000/
```

Requiring the entrypoint as a module binds no port and prints no banner: `listen` runs only when
`server.js` is the process entry point. `require('./server')` exposes `resolveConfig`,
`createServer` (a non-listening server) and `start` (a promise that resolves with the listening
server). Which failures reach stderr and which are thrown or rejected instead is set out under
[How a rejected value surfaces](#how-a-rejected-value-surfaces).

## Configuration

Every value has the same precedence: an explicit `options` property passed to `createServer` or
`start`, then the environment variable, then the default below.

| Environment variable   | `options` property    | Default                           | Validation |
| ---------------------- | --------------------- | --------------------------------- | ---------- |
| `PORT`                 | `port`                | `3000`                            | Must match one to five decimal digits in full and fall in `0`–`65535`. `0` means "bind an ephemeral port". `1.5`, `3000abc`, `70000` and an empty value are startup errors, not silently coerced values. |
| `HOST`                 | `host`                | `127.0.0.1`                       | Must be non-empty after trimming. An empty or whitespace-only value is a startup error rather than an implicit bind to every interface. Any other value is accepted, including one beyond loopback — see the warning under [Security](#security) before using one. |
| `ACTIVITIES_DATA_PATH` | `activitiesDataPath`  | `activities.json` beside `server.js` | A relative value is resolved against the entrypoint's directory. The file itself may be absent, but its directory must exist and be writable, or startup fails. Writability is checked by creating and immediately removing a probe file there, so a directory whose permissions or ACLs refuse writes is caught wherever the service runs — see [Operational notes](#operational-notes). |
| `WORKBOOK_DIR`         | `workbookDir`         | the directory of `server.js`      | Any path holding `student_details.xlsx` and `student_other_info.xlsx`. A relative value is resolved against the entrypoint's directory. |

**Relative path values resolve against the entrypoint's directory, never against the current
working directory**, so `node /path/to/server.js` reads the committed workbooks and registry no
matter where it was launched from.

Those four are the whole configuration surface of the service. `createServer` and `start` accept two
further properties, `directory` and `repository`, but they are an injection seam for tests rather
than configuration: they are read straight off the options object and are deliberately not part of
what `resolveConfig` returns.

`MIN_TESTS` is the one further environment variable this project reads, and it configures the
**test guard rather than the service**; it is documented with the rest of the verification surface
under [Verification](#verification).

### How a rejected value surfaces

A rejected configuration value — or a data source that cannot be loaded — surfaces differently
depending on which entry point resolved it, and the difference is deliberate:

- **Programmatically, nothing is written to stderr and no exit code is set.** `resolveConfig` and
  `createServer` **throw synchronously**: `code === 'SERVER_CONFIG_INVALID'` for a configuration
  fault, and the loader's own `WORKBOOK_READ_FAILED`, `STUDENT_DIRECTORY_INVALID` or
  `ACTIVITY_REPOSITORY_INVALID` for a data fault. `createServer` never listens, so it cannot
  produce a bind error at all; `start` additionally **rejects** its promise when the bind itself
  fails, naming the host, the port and the code — `EADDRINUSE` among them. Library code never
  calls `process.exit`.
- **From the command line** — `npm start`, or any `node server.js` run where this file is the
  process entry point — that same failure becomes process behaviour in exactly one place: one line
  on stderr, prefixed `server.js:` and naming the offending value, and exit code `1`.

```bash
PORT=abc node server.js; echo "exit=$?"
```

```text
server.js: port must be one to five decimal digits with nothing else, not a fraction and not an empty value: "abc"
exit=1
```

The startup banner belongs to that same command-line path: `npm start` prints it from the resolved
host and the port actually bound, so a CLI run with `PORT=0` reports the ephemeral port it
received. A programmatic `start()` prints no banner — it resolves with the listening server, whose
`config` property carries the resolved values and whose `address()` reports the bound port.

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
- A **known student holding no activity** answers `200` with `{"count": 0, "activities": []}`,
  never `404`. The two are kept distinguishable on purpose: `404 STUDENT_NOT_FOUND` means the
  directory does not know the identifier at all. No committed student is in that state — each holds
  the one activity the workbook carries — so it arises for a student whose `Extracurricular
  Activity` cell in `student_other_info.xlsx` is blank.
- `?activity=` is compared trimmed and case-insensitively, so `?activity=debate%20society` matches
  `Debate Society`. A filter that matches nothing is `200` with `{"count": 0, "activities": []}`,
  not an error.
- Path matching is **exact**: there is no trailing-slash normalization, so `/api/activities/` is a
  `404`.
- There is **no pagination**: the roster is the whole set, and the top-level `count` always equals
  `activities.length`.

### Examples

Real requests against the committed data. Every `bash` block below is a command that can be copied
and run as it stands; the block after it is the response that command produced, so no response text
is ever mixed into a block meant for a shell. The `-i` transcripts show the headers the service
sets itself — `Content-Type` and `Content-Length` are set explicitly on every response it writes,
and `Location` on the `201` — while Node's own `Date`, `Connection` and `Keep-Alive` lines are
omitted.

The greeting, preserved byte for byte:

```bash
curl -i http://127.0.0.1:3000/
```

```text
HTTP/1.1 200 OK
Content-Type: text/plain
Content-Length: 34

Hello, World Welcome to Sharebot!
```

A student's activities. `activities.json` ships empty, so every student starts with exactly the one
activity the workbook carries:

```bash
curl http://127.0.0.1:3000/api/students/S001/activities
```

```json
{"studentId":"S001","name":"Aarav Sharma","count":1,"activities":[{"activity":"Robotics Club","source":"workbook"}]}
```

The reverse lookup — the students who hold an activity:

```bash
curl "http://127.0.0.1:3000/api/activities?activity=Robotics%20Club"
```

```json
{"count":1,"activities":[{"activity":"Robotics Club","count":2,"studentIds":["S001","S009"]}]}
```

Unfiltered, the committed data answers with eight groups over ten records, ordered by the
case-folded activity name:

```bash
curl http://127.0.0.1:3000/api/activities
```

```json
{"count":8,"activities":[{"activity":"Coding Club","count":1,"studentIds":["S005"]},{"activity":"Cricket Team","count":1,"studentIds":["S007"]},{"activity":"Dance Club","count":1,"studentIds":["S006"]},{"activity":"Debate Society","count":2,"studentIds":["S002","S010"]},{"activity":"Football Team","count":1,"studentIds":["S003"]},{"activity":"Music Club","count":1,"studentIds":["S004"]},{"activity":"Photography Club","count":1,"studentIds":["S008"]},{"activity":"Robotics Club","count":2,"studentIds":["S001","S009"]}]}
```

Recording a second activity for a student. The body carries exactly one field, `activity`; the
student comes from the path:

```bash
curl -i -X POST http://127.0.0.1:3000/api/students/S003/activities \
    -H 'Content-Type: application/json' \
    -d '{"activity":"Music Club"}'
```

```text
HTTP/1.1 201 Created
Content-Type: application/json
Content-Length: 64
Location: /api/students/S003/activities

{"studentId":"S003","activity":"Music Club","source":"registry"}
```

The student then holds both, workbook record first and registry records in file order:

```bash
curl http://127.0.0.1:3000/api/students/S003/activities
```

```json
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
| `500`  | `INTERNAL_ERROR`            | An internal fault — a failed registry write, the only condition that produces a `500`. The detail goes to stderr; no exception text or stack is ever returned | `Could not persist the activity record` |

Those eleven are the whole error contract: no other status and no other code is produced by any
route, and the table is the complete list rather than a selection from one.

How the placeholders render: `<value>` for an identifier is the raw, still-encoded path segment as
received, truncated to 64 characters — never the decoded form and never the normalized one. Both
identifier codes render it that way: `INVALID_STUDENT_ID` echoes the segment that failed the shape
check, and `STUDENT_NOT_FOUND` echoes the segment the directory did not know, which is why
`GET /api/students/s999/activities` answers `No student with Student ID s999`. For an activity
`<value>` is the trimmed name the caller supplied, truncated the same way; `<path>` is the raw
request target with the query string removed and is **not** truncated, so a `404` for
`/api/unknown?x=1` reads `No route for GET /api/unknown` and a long unrecognised target is named in
full — the 64-character cap applies only to identifier and activity values; `<key>` is the first
offending key in the body's own key order; `<method>` is the request method verbatim; and `<id>`,
the normalized identifier, appears in exactly one sentence — `ACTIVITY_ALREADY_RECORDED`.

`Allow` values are exact and ordered:

| Path                                   | `Allow`           |
| -------------------------------------- | ----------------- |
| `/`                                    | `GET, HEAD`       |
| `/api/students/{studentId}/activities` | `GET, HEAD, POST` |
| `/api/activities`                      | `GET, HEAD`       |

`Content-Type` is matched on the media type only, so `application/json; charset=utf-8` is accepted.
An error answered before the request body has been read declares `Connection: close` and abandons
the request stream: every stage through identifier existence — the `405`s with their `Allow`,
`INVALID_STUDENT_ID`, `STUDENT_NOT_FOUND`, the `415`, and the root `405` and unrecognised-path `404`
the entrypoint writes — plus the mid-stream `413`. A connection whose body was never interpreted is
not one to reuse, and declaring that is what stops a keep-alive client pipelining behind a discarded
body. Errors decided after the body was fully read — `MALFORMED_JSON`, `UNEXPECTED_FIELD`,
`INVALID_ACTIVITY`, `ACTIVITY_ALREADY_RECORDED`, `INTERNAL_ERROR` — and every successful response
keep default connection handling.

**Validation order is fixed**, so a request with several faults gets one predictable response: path
recognition, then method, then identifier shape, then identifier existence, then — for `POST` only —
media type, body size, JSON parse, unexpected keys, `activity` validity, the duplicate check and
finally persistence. A `POST` to an unknown student carrying an oversize, unparseable body therefore
answers `404`, not `413` or `400`.

Nothing precedes path recognition: the first question asked of any request is which route it names,
and the `Host` header is not consulted at any stage. Identifier shape and existence are decided
before a single body byte is read, which is what makes that `404` outrank both the size cap and the
parse failure.

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
  written to stderr, and the workbook-sourced data is still served. Every other fault is a **fatal
  startup error**, because silently ignoring a corrupt registry would under-report a student's
  activities. Each such error is prefixed `Activity registry (<path>):`, so the file is always
  named; how precisely the fault itself can be located depends on what went wrong:
  - a **file-level** fault has no record to point at, so the file and the fault are all it reports
    — `the file does not contain valid JSON (…)` for content that will not parse, or `the file must
    contain a JSON array of records (received object)` for a root that is not an array;
  - a **record-level** fault also names the offending record by its 1-based position in file order.
    A record failing field validation, a duplicate record, or a `studentId` absent from the
    directory reads as, for example, `record 1 names Student ID S999, which is not in the student
    directory`.
- The registry's **directory** is a different matter: it must exist and be writable at startup, so a
  misconfigured `ACTIVITIES_DATA_PATH` fails while the server is being built rather than on the
  first `POST` hours later. Writability is established by **writing**, not by asking: startup
  creates a uniquely named probe file — `.activities-registry-probe-<pid>-<random>` — in that
  directory, writes no bytes to it, and removes it again immediately, so nothing of it survives a
  normal run. Asking would not be dependable, which is why the probe exists: a `W_OK` access check
  consults mode bits, so on Windows a deny-write ACL stays invisible to it and such a directory
  would start a server that could never persist an activity. A directory that **refuses** the probe
  is the fatal `Activity registry (<path>): the registry's directory <dir> is not writable, so an
  activity could never be persisted (…)`. A probe that **cannot be completed** for any other reason
  — the directory has just been removed, the filesystem is full — is the fatal `Activity registry
  (<path>): the registry's directory <dir> could not be probed for writability, so an activity
  could never be persisted (…)`. If the probe file is created and then cannot be **removed**,
  startup carries on — writability is already proven — and the reason is written to stderr as
  `Could not remove the activity registry writability probe file <path>: …`; that file is empty, so
  it is safe to delete by hand. None of this promises that a later write will succeed: permissions
  changed under a running process, a full disk or a lock still surface as a `500 INTERNAL_ERROR`
  for the one request that meets them.
- The same integrity rules apply to the workbooks: a header cell that is not exactly its expected
  label, a malformed or duplicate `Student ID`, a blank `Name`, an activity row naming a student the
  directory does not know, or a workbook that is missing or unreadable all abort startup with the
  file, row or record named.
- A write rewrites the whole registry to `activities.json.tmp` beside the target and renames it over
  the file, so a failed write can never leave a partial append. After a failed write that scratch
  file is removed on a **best-effort basis**: removal is always attempted, a file that was never
  created is a no-op, and if the removal itself fails the `.tmp` artifact stays on disk and the
  reason is written to stderr as `Could not remove the temporary activity registry file <path>: …`.
  That failure is reported rather than raised, so a cleanup problem cannot replace the
  `500 INTERNAL_ERROR` the request is already being rejected with — but it does mean an artifact
  can survive, and an undeletable `activities.json.tmp` is a signal to look at the stderr log and
  the file's permissions. Writes are serialized on a single queue, so two concurrent `POST`s of the
  same activity produce one `201` and one `409`.
- That queue is **unbounded**, and so is what it writes. There is no ceiling on the writes in flight,
  on the activities one student may hold, or on the registry's record count or byte size, so the
  registry, each per-student response and the cost of the full-file rewrite every write performs all
  grow with however many activities are posted. Nothing reclaims a record: shrinking the registry is
  a hand edit of `activities.json` while the service is stopped. That growth is an accepted risk of
  the loopback-only deployment model — see [Accepted risks](#accepted-risks).
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
`0` **only** when at least `MIN_TESTS` tests passed, none failed and none was cancelled. It also
refuses to run anything when `process.version` falls outside `engines.node`, which is the one place
the runtime contract is enforced rather than merely declared.

The guard exists because a bare `node --test` that discovers no test file prints a zero count and
still **exits 0**, so an exit status alone cannot prove the suite ran.

`npm run test:raw` is the same three files through `node --test` with no guard; use it to read
per-test output while developing, not as the gate. Both commands name the test files explicitly,
because passing a directory to `node --test` fails and because every `.js` file inside `test/` would
otherwise be executed as a test. Keep the `--test-concurrency=1` the script already carries — the
reason is the next subsection.

### One runner at a time: the suite owns `127.0.0.1:3000`

`test/server.test.js` binds the default address deliberately. It is the only place the shipped
entrypoint's startup banner, the greeting's exact 34 bytes and both bind-conflict paths are
observable at all, so the address is fixed and **no environment variable moves it** — `PORT` and
`HOST` are stripped from every child that file spawns. The practical consequence is a rule about the
host rather than about the code:

- Only **one** runner of this suite may be active on a machine at a time. A second `npm test`, a
  second checkout of this repository, or anything else listening on `127.0.0.1:3000` blocks it.
- A default-configuration `npm start` holds that same address. **Stop it before running the suite.**

`npm test` checks this before it runs anything. When the port is already held it exits `1` having
executed **no test**, with a single line on stderr:

```text
verify-tests.js: ENVIRONMENTAL PRECONDITION (not a product failure): 127.0.0.1:3000 is already in
use, held by pid 80612. test/server.test.js must bind that exact address … No test was run. Free
the port, or wait for the run holding it to finish, then re-run `npm test`.
```

That line is the whole report: the address is named once, the holder is identified where the host
permits it (`netstat -ano` on Windows, `lsof` elsewhere) and degrades to the command you can run
yourself when it does not. Without the check the suite ran anyway and reported **seven** failing
tests whose titles — the baseline greeting, the activity route, the port being released after
shutdown — read as product breakage when nothing was wrong with the product.

Two limits of the check are worth knowing:

- It applies only when the suite being run actually includes `test/server.test.js`, so a subset that
  omits it is never blocked by a port it does not touch.
- A port that is free when the check runs can still be taken before the suite binds it. Nothing
  running on a shared host can close that window, so instead each affected failure message begins
  with the same `ENVIRONMENTAL PRECONDITION` words — one search finds every such report, however it
  was produced, and a blocked run stays distinguishable from a regression.

`--test-concurrency=1` is what keeps that single fixed bind exclusive: at concurrency 1 the
port-binding file cannot overlap any other file in the suite. The raw runner is defined with the
flag for that reason, and it should stay. It is no longer load-bearing for temporary directories —
each one now names the process that created it, so the fixture suite's leftover check excludes a
directory a concurrently running sibling is still using while continuing to fail for one whose owner
has exited.

### `MIN_TESTS` — the guard's minimum passing count

`MIN_TESTS` configures the **test guard only**. The service never reads it, which is why it is not
in the [Configuration](#configuration) table: setting it changes what `npm test` accepts as a
complete run and nothing about a running server.

| Environment variable | Default                            | Validation |
| -------------------- | ---------------------------------- | ---------- |
| `MIN_TESTS`          | `45`, the number of declared tests | A **positive decimal integer**, `1` or greater. It is resolved **before any test is executed**, so a rejected value runs nothing at all: `0`, an empty value, a negative number, a fraction, a non-numeric string, or a value too large to compare against a test count each fail with one line on stderr naming the value and exit code `1`. |

`0` is rejected rather than read as "no minimum" for the same reason the guard exists at all: a
floor of zero is met by a run that executed nothing, which is precisely the vacuous pass being
guarded against. The override is there for **local subsetting** — running one test file while
developing, against a floor that matches it — and `npm test` applies the full suite's floor of `45`
whenever the variable is unset.

Raising the minimum above what the suite can meet is also how a reviewer confirms the guard is
live. This must exit `1`:

```bash
MIN_TESTS=46 npm test
```

### The suite leaves the working tree untouched

Every test that writes points its registry path at a fresh directory under the system temp
directory and removes it afterwards; no test writes to a workbook or to the committed
`activities.json`. Check that rather than assume it, by capturing the working-tree state before the
run and comparing it with the state after — to a path **outside the checkout**, so the capture does
not alter what it is measuring:

```bash
git status --porcelain > /tmp/tree-before.txt
npm test
git status --porcelain > /tmp/tree-after.txt
diff /tmp/tree-before.txt /tmp/tree-after.txt && echo "working tree unchanged"
```

The requirement is that the two captures are **identical**, not that either is empty: a checkout
carrying uncommitted work of its own legitimately reports lines, and demanding zero would fail a
perfectly clean run for an unrelated reason. Zero lines is the right expectation only in a
committed, clean checkout, which is where a pipeline would run this. Two declared tests back the
comparison up whatever else is uncommitted: one asserts the SHA-256 of each of the three workbooks
against its recorded baseline together with the absence of any `activities.json.tmp` or leftover
temporary directory, and another asserts that same absence on the write-failure path specifically.

`npm audit` needs registry access; a network failure there is not a feature failure. The suite's one
environmental precondition — a free `127.0.0.1:3000`, and so a stopped `npm start` — is covered
above in [One runner at a time](#one-runner-at-a-time-the-suite-owns-1270013000).

There is no linter, formatter, type checker, coverage tool or CI pipeline in this project;
`node --check` is the static gate.

## Security

The service binds `127.0.0.1` by default, and **that loopback default is the only access control
there is**: no authentication, no authorization, no TLS, no CORS and no rate limiting exists
anywhere in this project. Every process on the host reaches the activity API anonymously.

To publish the service deliberately, name the interface:

```bash
HOST=0.0.0.0 npm start
```

That start **succeeds**: `HOST` is validated for being a non-empty string and nothing else, so
widening the bind is a decision the service will carry out rather than refuse.

**Setting `HOST=0.0.0.0` publishes the service to the network while it authenticates nobody.** Put
exactly, any client that can reach the bound address then has all of the following without
presenting a credential:

- **Read the `Student ID` of every student holding an activity** — all ten, `S001` through `S010`,
  in the committed data, since each holds one. A single `GET /api/activities` returns those
  identifiers grouped by activity, and an identifier is the whole of what is needed to address a
  student.
- **Read each student's `Name`**, together with every activity recorded for that student and which
  source each record came from, through `GET /api/students/{studentId}/activities`.
- **Read the complete activity roster in one request** — every activity with its member count and
  the `Student ID`s holding it — through `GET /api/activities`.
- **Write a new activity record for any existing student**, through
  `POST /api/students/{studentId}/activities`. The record is appended to `activities.json` on disk
  and so survives a restart, and no route deletes or edits a record: undoing one means editing that
  file by hand.

What such a client cannot obtain is the rest of a directory row. The only directory field retained
and serialized is `Name`, so no Gender, Date of Birth, Age, Department, Year, Email, Phone or City
value can leave the process, and `student_academics.xlsx` is never opened by the service at all.
That bound limits the exposure; it is not a substitute for access control. Widening the bind is the
change that would require authentication, authorization, TLS and rate limiting together, and none of
them is implemented here.

### Accepted risks

These are known exposures that this service does **not** mitigate. Each is recorded rather than
fixed, because the mitigation is access control or a quota subsystem and neither is part of this
service; the loopback default is what keeps them out of reach.

| Exposure | What it is | Why it is accepted |
| -------- | ---------- | ------------------ |
| **DNS rebinding** (CWE-346) | A loopback bind keeps remote *packets* out, not a remote *origin*. An attacker serves a page under a DNS name with a very short TTL, then re-answers that name with `127.0.0.1`; the browser's next request reaches this service over a genuinely local connection while the browser still treats it as same-origin, so the attacker's script reads the response. No bind address can refuse such a request. | Refusing it means validating the request's `Host` authority, which is an access-control mechanism. Authentication, authorization, CORS and rate limiting are all out of scope for this service, and the loopback bind plus the warning above is the whole of the access-control model. The exposure is bounded by what any local process already has: `Name` and activity records, and no other directory field. |
| **Unbounded write workload** (CWE-770) | Every valid `POST` allocates response state and a task on the single-writer queue, and nothing caps how many may be in flight, so queue depth, memory and latency grow with however many requests a caller sends at once. | A quota or rate limit is out of scope. On a loopback-only service every caller is already a local process, which has cheaper ways to consume the same resources. |
| **Unbounded registry growth** (CWE-770) | Nothing caps the activities one student may hold, or the registry's record count or byte size, so `activities.json`, each per-student response and the cost of the full-file rewrite every write performs all grow without limit. No route deletes a record. | Same reason. Shrinking the registry is a hand edit of `activities.json` with the service stopped, and a registry of any size still loads and is served in full. |

None of the three is reachable from off the host while the default `HOST=127.0.0.1` stands. Widening
the bind makes all three remotely reachable at once, which is what the warning above is about.
