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
| `HOST`                 | `host`                | `127.0.0.1`                       | Must be non-empty after trimming. An empty value is a startup error rather than an implicit bind to every interface. A value beyond loopback additionally requires `ALLOWED_HOSTS` — see [Security](#security). |
| `ALLOWED_HOSTS`        | `allowedHosts`        | none — the loopback default needs none | The authorities this server answers for, beyond the loopback set a loopback bind already answers for: a comma-separated list, or an array programmatically. Each entry is a host with an optional port (`app.example`, `app.example:8080`, `[::1]:8080`) and nothing else — a scheme, path, userinfo or whitespace is a startup error naming the entry. An entry carrying a port matches only that exact `host:port`; an entry carrying none matches that host on any port. **Required when `HOST` reaches beyond loopback**, where startup fails without it. |
| `ACTIVITIES_DATA_PATH` | `activitiesDataPath`  | `activities.json` beside `server.js` | A relative value is resolved against the entrypoint's directory. The file itself may be absent, but its directory must exist and be writable, or startup fails. |
| `WORKBOOK_DIR`         | `workbookDir`         | the directory of `server.js`      | Any path holding `student_details.xlsx` and `student_other_info.xlsx`. A relative value is resolved against the entrypoint's directory. |

**Relative path values resolve against the entrypoint's directory, never against the current
working directory**, so `node /path/to/server.js` reads the committed workbooks and registry no
matter where it was launched from.

`HOST` selects the interface to bind; `ALLOWED_HOSTS` is a different question — which `Host`
authorities the service will answer for once a request arrives. The two are related by one rule:
the default loopback bind answers for the loopback authorities without being told, and any wider
bind must name its authorities or startup fails. Both halves are set out under
[Security](#security).

### Write-path limits

`POST` is the one route that consumes resources a request does not release: pending write work while
it is queued, and a registry record for good afterwards. Four ceilings bound both, and all four are
configurable at the same precedence as the values above.

| Environment variable         | `options` property        | Default  | Bounds |
| ---------------------------- | ------------------------- | -------- | ------ |
| `MAX_PENDING_WRITES`         | `maxPendingWrites`        | `16`     | Writes in flight at once, where a write is in flight from the moment its `POST` is admitted — before the body is read — until it settles. A `POST` that cannot acquire capacity is refused with `503` without its body being read at all. |
| `MAX_ACTIVITIES_PER_STUDENT` | `maxActivitiesPerStudent` | `32`     | Activities one student may hold, counting the workbook record — which is also the size of that student's `GET` response. |
| `MAX_REGISTRY_RECORDS`       | `maxRegistryRecords`      | `1000`   | Records `activities.json` may hold in total. |
| `MAX_REGISTRY_BYTES`         | `maxRegistryBytes`        | `262144` | Serialized size of `activities.json`. Measured on the bytes a write would actually produce, so it also bounds the cost of the full-file rewrite each write performs. |

Each must be an integer of at least 1, validated as a whole string exactly as `PORT` is: `0`, `1.5`,
`16abc` and an empty value are startup errors rather than silently different ceilings. The record
ceiling normally binds before the byte ceiling — 1000 records of a 64-character activity serialize to
roughly 100 KB — so the byte ceiling is the backstop that catches a registry already larger than its
record count suggests.

`MAX_PENDING_WRITES` is **acquired, not merely checked**. A `POST` takes one unit of that capacity
before its body is read and holds it until the write settles or the request ends, so a slow or
abandoned upload occupies a slot for as long as it occupies the process, and at most
`MAX_PENDING_WRITES` requests can be reading a body at once. Checking instead of acquiring would
admit every request in a simultaneous burst, since none of them has enqueued a write yet.

These are **finite capacity, not rate limiting**: they are per process, they count every caller
together, and they say nothing about how often any one client may ask. No per-client rate limiter,
request timeout or connection cap is part of this service. A ceiling that has been reached is
reported to the client and **not** logged, because a line per refused request would make a flood of
them a second unbounded resource.

**What is observable, and what is not.** The ceilings in force are on `server.config`
(`maxPendingWrites`, `maxActivitiesPerStudent`, `maxRegistryRecords`, `maxRegistryBytes`). Of the
counts behind them, only the per-student one is visible over HTTP — as the `count` of
`GET /api/students/{studentId}/activities`. The number of writes currently in flight and the
registry's byte size are **not** exposed by any route, and the roster's counts include the
workbook-sourced records, so they cannot be read as the registry's own record count; that count is
`activities.json`'s array length, read from the file. Programmatically, the repository's
`checkWriteAdmission(studentId)` reports which ceiling would refuse a write without acquiring
anything.

A registry that is *already* past a ceiling — a hand edit, or a ceiling lowered afterwards — still
loads and is still served in full. Only further writes are refused; nothing is truncated, and no
record is ever deleted or reclaimed by the service.

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
| `400`  | `INVALID_HOST`              | The `Host` header is present but unusable: empty, sent twice, or not an authority — judged before the target is parsed; see [Request authority validation](#request-authority-validation) | `Host header must be a single valid authority` |
| `421`  | `MISDIRECTED_REQUEST`       | The authority parses and is not one this server answers for — the DNS-rebinding case; see [Request authority validation](#request-authority-validation) | `Request authority is not served by this server` |
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
| `503`  | `ACTIVITY_WRITE_QUEUE_FULL` | A `POST` arrived while `maxPendingWrites` writes were already in flight — counting from the moment each was admitted, so a request still uploading its body counts. The response carries `Retry-After: 1`, and the capacity is released as those requests finish | `Too many activity writes are in flight; retry shortly` |
| `507`  | `STUDENT_ACTIVITY_LIMIT_REACHED` | The student already holds `maxActivitiesPerStudent` activities. `<id>` is the normalized identifier; the configured ceiling is deliberately not disclosed | `Student <id> has reached the maximum number of recorded activities` |
| `507`  | `ACTIVITY_REGISTRY_FULL`    | The registry has reached `maxRegistryRecords` records, or the write would take it past `maxRegistryBytes`                                       | `The activity registry has reached its configured capacity` |

The two authority codes are decided before anything else and are documented in full under [Security](#security). The last three report a **bound rather than a fault**, which is why none of them is a `500` and none
is a `409`: nothing failed and nothing conflicted, the write was declined. `503` is the temporal one
— the queue drains, so it names when to retry — while `507 Insufficient Storage` (RFC 4918 §11.5) is
the standing one, and it keeps failing until records are removed by hand or a ceiling is raised.
Every one of them writes nothing: no record, no rewrite, and no `activities.json.tmp`.

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
the normalized identifier, appears in exactly two sentences — `ACTIVITY_ALREADY_RECORDED` and
`STUDENT_ACTIVITY_LIMIT_REACHED`. No message interpolates a configured ceiling: a client can do
nothing with the number, so each of the three bound codes keeps one fixed sentence whatever the
deployment.

`Allow` values are exact and ordered:

| Path                                   | `Allow`           |
| -------------------------------------- | ----------------- |
| `/`                                    | `GET, HEAD`       |
| `/api/students/{studentId}/activities` | `GET, HEAD, POST` |
| `/api/activities`                      | `GET, HEAD`       |

`Content-Type` is matched on the media type only, so `application/json; charset=utf-8` is accepted.
An error answered before the request body has been read declares `Connection: close` and abandons
the request stream: the authority gate (`INVALID_HOST`, `MISDIRECTED_REQUEST`), every stage through identifier existence — the `405`s with their `Allow`,
`INVALID_STUDENT_ID`, `STUDENT_NOT_FOUND`, the `415`, and the root `405` and unrecognised-path `404`
the entrypoint writes — plus **write admission**, whose `503 ACTIVITY_WRITE_QUEUE_FULL` and `507`
quota refusals are decided one stage earlier still, and the mid-stream `413`. A connection whose body
was never interpreted is not one to reuse, and declaring that is what stops a keep-alive client
pipelining behind a discarded body. Errors decided after the body was fully read — `MALFORMED_JSON`,
`UNEXPECTED_FIELD`, `INVALID_ACTIVITY`, `ACTIVITY_ALREADY_RECORDED`, `INTERNAL_ERROR`, and the two
bound codes when they are reached *after* admission (a `507` from the byte ceiling, which can only be
measured once the write is serialized, or either code from a ceiling reached while the body was being
read) — and every successful response keep default connection handling.

**Validation order is fixed**, so a request with several faults gets one predictable response: `Host` authority, then path,
then method, then identifier shape, then identifier existence, then — for `POST` only — **write
admission**, media type, body size, JSON parse, unexpected keys, `activity` validity, the duplicate
check and finally persistence. A `POST` to an unknown student carrying an oversize, unparseable body
therefore answers `404`, not `413` or `400`.

Write admission sits where it does on purpose: every stage after it interprets the request, and
interpreting a request means buffering up to 8 KiB of it, so refusing first is what makes the bound
worth having — a service at capacity reads no body at all. Two consequences follow, both
deterministic. A request that is also malformed is told it was refused for capacity rather than told
what was wrong with it; and a student at their ceiling gets `507` even for an oversize or unparseable
body, where an unbounded service would have answered `413` or `400`. Identifier shape and existence
still outrank admission, so an unknown student is a `404` whatever the load. The registry's byte
ceiling is the one bound that cannot be judged before the write is serialized, so it is enforced at
the persistence step instead — after the body has been read, and still before anything is written.

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
  first `POST` hours later.
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
- That queue is **bounded**, and so is what it writes. `MAX_PENDING_WRITES` caps the writes in
  flight; `MAX_ACTIVITIES_PER_STUDENT`, `MAX_REGISTRY_RECORDS` and `MAX_REGISTRY_BYTES` cap what
  accumulates. Without them the registry, each per-student response and the cost of the full-file
  rewrite every write performs would all grow with however many activities were posted, and nothing
  reclaims a record — so the ceilings, and raising them deliberately, are the whole of the retention
  policy. The defaults and their validation are under
  [Write-path limits](#write-path-limits); the statuses a caller sees are `503` and `507` in
  [Errors](#errors).
- **Growing the registry on purpose** is a configuration change, not a code change: raise the
  relevant ceiling, restart, and the previously refused writes are accepted. Shrinking it is a hand
  edit of `activities.json` while the service is stopped — the service never deletes a record, and a
  registry left above a lowered ceiling still loads and is served in full.
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
otherwise be executed as a test.

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

`npm audit` needs registry access; a network failure there is not a feature failure. Note that
`test/server.test.js` deliberately spawns the real entrypoint on `127.0.0.1:3000`, so stop a running
`npm start` before running the suite.

There is no linter, formatter, type checker, coverage tool or CI pipeline in this project;
`node --check` is the static gate.

## Security

The service binds `127.0.0.1` by default, and **that loopback default is the only access control
there is**: no authentication, no authorization, no TLS, no CORS and no rate limiting exists
anywhere in this project. Every process on the host reaches the activity API anonymously.

### Request authority validation

A loopback bind keeps remote *packets* out. On its own it does not keep a remote *origin* out,
because of DNS rebinding: an attacker serves a page from their own host under a DNS name with a
very short TTL, then re-answers that name with `127.0.0.1`. The browser's next request goes to this
service over a genuinely local connection while the browser still treats it as same-origin, so the
attacker's script reads the response. No bind address can refuse such a request — it arrives from
`127.0.0.1` — and the one thing that distinguishes it is the authority it must carry, which names
the attacker's host rather than anything this service answers for. Browsers always send `Host` and
script cannot change it, so that field is reliable here.

Every request is therefore judged on its `Host` authority **before its target is parsed and before
any route sees it**, which is why a refused request reaches no route, no student lookup, no body
reader and no write queue:

| Bind | Authorities answered for |
| ---- | ------------------------ |
| Loopback (the default `127.0.0.1`, any `127.x.y.z`, `localhost`, `::1`) | `localhost`, `127.0.0.1`, `::1` and the configured bind value itself — each **only on the port actually bound**, so a request for `localhost:3001` on a service listening on `3000` is refused, as is a portless authority (which means port 80) — plus anything `ALLOWED_HOSTS` adds |
| Anything wider (`0.0.0.0`, `::`, a specific interface address, a hostname) | Exactly what `ALLOWED_HOSTS` names, and nothing implicit. **Startup fails when it names nothing**, rather than publishing a socket that answers for every authority |

Comparison is case-insensitive and accepts `[::1]` as `::1`. A bracketed host must actually be an
IPv6 literal, so `[::1.]` and `[not:ipv6]` are refused rather than repaired. One trailing dot is
ignored on a **name** (`localhost.` is `localhost`, the fully qualified spelling a browser may
send) and never on an IP literal, which has no fully qualified form. The same parser reads the
`Host` header and every `ALLOWED_HOSTS` entry, so a listed authority and a request authority cannot
disagree about spelling, and an entry that could never match is a startup error rather than a false
sense of permission.

Two refusals, both carrying the standard envelope and `Connection: close`, and both with a fixed
sentence that echoes nothing the caller sent:

| Status | Code | When | `message` |
| ------ | ---- | ---- | --------- |
| `400`  | `INVALID_HOST`        | The `Host` header is present but unusable: empty, sent twice, or not an authority (a scheme, path, userinfo, whitespace or an unparseable port) | `Host header must be a single valid authority` |
| `421`  | `MISDIRECTED_REQUEST` | The authority parses and is simply not one this server answers for — the DNS-rebinding case | `Request authority is not served by this server` |

An HTTP/1.0 request that sends no `Host` at all asserts no origin, so there is nothing to compare
and it is served under the server's own authority; an HTTP/1.1 request without one is refused by
the runtime before the service sees it. What this does **not** do is authenticate anybody: it
confines the service to the authorities it was configured for, which is what makes the loopback
default a real boundary rather than a nominal one. Everything below still applies.

To publish the service deliberately, name the authority as well as the interface:

```bash
HOST=0.0.0.0 ALLOWED_HOSTS=activities.internal:3000 npm start
```

**Setting `HOST=0.0.0.0` publishes the service to the network while it authenticates nobody.** Put
exactly, any client that can reach the bound address and addresses it by an authority
`ALLOWED_HOSTS` names then has all of the following without presenting a credential:

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
That bound limits the exposure; it is not a substitute for access control. Nor is authority
validation: it decides which authorities are answered for, never who is asking. Widening the bind
is the change that would require authentication, authorization, TLS and rate limiting together, and
none of them is implemented here.
