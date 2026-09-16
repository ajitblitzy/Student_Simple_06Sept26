# Student_Simple_06Sept26

Student records for ten students live in three read-only spreadsheet workbooks, and a small Node.js
listener sits in front of them. Until now that listener answered every method on every path with the
same fixed plaintext greeting, and no code in the project opened a workbook or wrote anything at all.
This release adds one feature: **students can add their own extracurricular activities.** Three things
that did not exist before now do — an *intake surface*, the `/activities` namespace on the existing
listener, through which a person uses an HTML form and a script uses the same endpoint; an *activity
store*, the JSON document `activities.json`, because the repository had nowhere to put a submission
and the workbook's single-valued `Extracurricular Activity` column could not receive one without
destroying the value already in it; and a *link to Student ID*, carried on every record. That link is
enforced by code in the request path, and it can only be enforced there: no workbook declares a key
and none contains a data-validation part, so nothing in the data itself can uphold it. A submission
whose Student ID is malformed, or well-formed but naming no student, is refused rather than stored.

## Prerequisites

- **Node.js 24 "Krypton" (Active LTS).** The development and evidence release is `v24.21.0` — every
  measured value in this document was taken on it.
- **`.nvmrc` holds `24.21.0`**, so a version manager that reads it selects the evidence release
  automatically.
- **`package.json` declares the supported range `engines.node = ">=24.21.0 <25.0.0"`.** Any 24.x at or
  above the evidence release is supported. A different major is deliberately **not** claimed: the
  ceiling is `<25.0.0` because nothing here has been verified against Node 25 or later, and moving to
  a new major is a deliberate change to both files plus a re-run of the test suite.

There are **no other prerequisites**. No database, no cache, no message broker, no service to
provision, no credential to obtain, and no package to install. The project declares **zero
dependencies and zero devDependencies**; the feature uses only the runtime's built-in modules
(`node:http`, `node:fs`, `node:path`, `node:zlib`) and the built-in test runner. There is no private
registry, no authentication token, no `.npmrc`, and no internal or scoped package anywhere in this
project — so there is no registry to configure and no credential step to perform.

## Install, start, and test

```bash
# 1. Select the pinned runtime, using a version manager that reads .nvmrc:

nvm install && nvm use          # selects 24.21.0
node --version                  # must print v24.21.0

# 2. Install dependencies. There are none, so nothing is downloaded.

npm ci                          # frozen install against the committed lockfile

# 3. Start the service.

npm start                       # equivalently: node server.js
                                # prints: Server running at http://127.0.0.1:3000/

# 4. Run the tests.

npm test                        # node --test --test-concurrency=1
```

Three notes separate these commands *working* from merely *appearing* to work:

- **`npm install` generates the lockfile; `npm ci` consumes it.** `npm ci` *requires*
  `package-lock.json` to exist and fails without it — it never creates one. The lockfile was generated
  once, at implementation time, and is committed. With zero dependencies both commands download
  nothing, and `npm ci` serves as the manifest-to-lockfile consistency check.
- **The test command passes no positional argument.** Do not run `node --test test/`: on the pinned
  runtime that treats `test/` as a module to load rather than as a directory to discover, exits `1`,
  and runs no tests at all. Node discovers the test files itself, which is also why no shell glob is
  needed and none is portable.
- **There is no graceful-shutdown handler**, and the feature adds none. Stop the service with
  `Ctrl-C`, exactly as before.

## Endpoint contract

The service listens on **`127.0.0.1:3000`** and is reachable **only from the local host**. That bind
is a pair of hardcoded literals and is **unchanged by this feature** — a request to the host's
routable address on port 3000 is refused while the identical loopback request succeeds.

The feature adds three routes, all on that one listener and that one port:

| Route | Accepts | Answers |
| --- | --- | --- |
| `GET /activities` | no body | `200`, `Content-Type: text/html; charset=utf-8` — an HTML submission form. No client-side JavaScript: the form posts natively, which is why its default encoding and this endpoint's accepted media type are the same thing |
| `POST /activities` | `application/x-www-form-urlencoded` **or** `application/json`, with the two body fields `studentId` and `activity` | `201` with a `Location: /activities/{studentId}` header for a new activity; `200` carrying the existing record unchanged for a repeat |
| `GET /activities/{studentId}` | no body | `200`, `Content-Type: application/json; charset=utf-8`, body `{"studentId":"S001","activities":[…]}`. This route **never** returns HTML |

**Negotiation is on the request media type, not on `Accept`.** A form-encoded `POST` gets an HTML
result page; a JSON `POST` gets a JSON body. The status codes are identical either way, so a script
and a browser receive the same diagnosis in different clothing. A missing `Content-Type` on
`POST /activities` is refused with `415` rather than guessed at.

```bash
# Form-encoded, as the browser form posts it
curl -i -X POST http://127.0.0.1:3000/activities \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'studentId=S001' --data-urlencode 'activity=Chess Club'

# JSON, as a script posts it
curl -i -X POST http://127.0.0.1:3000/activities \
  -H 'Content-Type: application/json' \
  -d '{"studentId":"S001","activity":"Chess Club"}'
```

The JSON success body:

```json
{
  "created": true,
  "record": {
    "studentId": "S001",
    "activity": "Chess Club",
    "source": "submission",
    "submittedAt": "2026-09-16T06:14:22.481Z"
  }
}
```

`created` is `true` for a `201` and `false` for a `200`. Every response that returns a record returns
it in this shape, so a record seeded from the workbook arrives as
`"source": "workbook"` with **no** `submittedAt`.

### The authoritative response matrix

Every JSON response is `application/json; charset=utf-8`; every HTML response is
`text/html; charset=utf-8`.

| Route and method | Status | Error code | Trigger | Extra headers |
| --- | --- | --- | --- | --- |
| `GET /activities` | `200` | — | the submission form (HTML) | — |
| `GET /activities/{id}` | `200` | — | `{"studentId":"S001","activities":[record,…]}` (JSON only) | — |
| `GET /activities/{id}` | `400` | `student_id_malformed` | path segment fails `/^S\d{3}$/` | — |
| `GET /activities/{id}` | `404` | `student_not_found` | well-formed, absent from the key set | — |
| `GET /activities/{id}` | `405` | `method_not_allowed` | any method other than `GET` | `Allow: GET` |
| `POST /activities` | `201` | — | `{"created":true,"record":{…}}`, or the HTML confirmation page | `Location: /activities/{studentId}` |
| `POST /activities` | `200` | — | `{"created":false,"record":{…}}`, or the HTML already-recorded page | — |
| `POST /activities` | `400` | `malformed_json` | body is not parseable JSON | — |
| `POST /activities` | `400` | `body_not_an_object` | JSON parses to `null`, an array, or a non-object | — |
| `POST /activities` | `400` | `student_id_required` | `studentId` absent, `undefined`, or `null` | — |
| `POST /activities` | `400` | `student_id_malformed` | `studentId` non-string, or fails `/^S\d{3}$/` | — |
| `POST /activities` | `400` | `activity_invalid` | `activity` absent, non-string, empty after normalization, over 60 characters, or containing a control character | — |
| `POST /activities` | `404` | `student_not_found` | well-formed `studentId` absent from the key set | — |
| `POST /activities` | `413` | `payload_too_large` | body over 8,192 bytes | — |
| `POST /activities` | `415` | `unsupported_media_type` | `Content-Type` missing, or neither accepted type | — |
| any other method on `/activities` | `405` | `method_not_allowed` | — | `Allow: GET, POST` |
| any namespace path resolving to no route | `404` | `not_found` | e.g. `/activities/S001/extra` | — |
| any route | `500` | `reference_data_unavailable` | a workbook read failed | — |
| any route | `500` | `store_unreadable` | the store failed load validation | — |
| `POST /activities` | `500` | `store_write_failed` | a write or rename failed with the process alive | — |
| any route | `500` | `internal_error` | an unexpected throw or rejection | — |

Two details of the table are easy to misread. A path is resolved to a route **before** its method is
considered, so `DELETE /activities/S001/extra` is `404 not_found` and not `405` — a `405` with an
`Allow` header would claim the resource exists and merely refuses the verb. And a `405` always names
the methods of the route actually addressed, so `POST /activities/S001` answers `Allow: GET` rather
than the namespace's `Allow: GET, POST`.

Only `POST /activities` with a **form-encoded** body renders HTML, and only for `201`, `200`, and the
validation outcomes a person filling in the form can act on — `student_id_required`,
`student_id_malformed`, `activity_invalid` and `student_not_found` — shown as the form re-displayed
with the offending field flagged. Every other outcome returns the JSON envelope in both modes:
`413` and `415` are decided before the body's format is known, an unresolved route has no form
context to re-display, and a `500` is a fault no amount of retyping fixes.

### The error envelope

Every error body the feature's own validation and store handling produces is the same two-key
envelope:

```json
{ "error": "<code>", "message": "<fixed English sentence for that code>" }
```

`error` is the stable machine-readable code and is what a test should match on. `message` is a fixed
sentence per code — not free text, not interpolated, and never carrying a stack trace, a filesystem
path or any other internal detail. The body carries **no additional fields**: the offending Student ID
is deliberately **not** echoed, so there is one envelope shape for every failure and no reflection of
submitted input back to the submitter.

**One documented exception.** `internal_error` is answered by the rejection boundary in `server.js`
rather than by the feature's own vocabulary, and it carries **`error` only** — the body is exactly
`{"error":"internal_error"}`. That boundary is reached only by a fault nothing anticipated, so it has
nothing it can safely describe; a `message` appearing there would mean it had started describing a
fault it cannot characterise. There are exactly **four distinct `500` codes** in total:
`reference_data_unavailable`, `store_unreadable`, `store_write_failed` and `internal_error`.

The request-body limit is **8,192 bytes, and it is inclusive** — a body of exactly 8,192 bytes is
read, and 8,193 is refused with `413 payload_too_large`. A legitimate submission
(`studentId=S001&activity=Photography+Club`) is under fifty bytes, so this is three orders of
magnitude of headroom while still bounding the memory any one request can make the process hold. An
oversized body is drained and refused; the process keeps serving.

### Where the feature's reach begins and ends

**Every path and method outside the `/activities` namespace still returns the pre-existing response,
byte for byte:** `200`, `Content-Type: text/plain` (with no `charset` parameter), and the 34-byte body
`Hello, World Welcome to Sharebot!\n`. The previously universal response is *narrowed*, not replaced —
it remains the answer for `/`, `/index.html`, `/students/S001` and any other arbitrary path, on any
method.

The namespace predicate is segment-safe, and the consequence is worth stating explicitly:

| Path | Belongs to the feature? | Result |
| --- | --- | --- |
| `/activities` | Yes | routed by method |
| `/activities/` | Yes — a single trailing slash is stripped | routed by method, same as `/activities` |
| `/activities?x=1` | Yes — the query string is excluded before matching | routed by method |
| `/activities/S001` | Yes | routed by method |
| **`/activities-old`** | **No** — not a segment boundary | the unchanged 34-byte plaintext greeting |
| **`/activitieslist`** | **No** | the unchanged 34-byte plaintext greeting |
| `/activities/S001/extra` | Yes, but resolves to no route | `404 not_found` |

The two emphasised rows are the ones a loose route predicate would silently capture, which is why the
test suite asserts them individually against the recorded response.

### Attribution — read this before exposing the service

The service has **no authentication, no authorization, and no session mechanism**, and this feature
adds none. There is no credential, no token, no cookie, no principal and no role anywhere in the
codebase. **A submission is attributed to a student by the Student ID the submitter types into the
form or puts in the request body, and by nothing else.** That Student ID is self-asserted and is
checked only for *existence*: the service confirms that `S001` is a real student, never that the
submitter is `S001`.

The consequence, stated plainly: **any process on the local host can submit an activity on behalf of
any student, and can read back any student's activities.** That is acceptable here for exactly two
reasons, and both are load-bearing — the listener is confined to loopback, and every record in the
data is synthetic. Identity verification would become a **prerequisite**, not an improvement, before
this surface is exposed off-host or used with real student records.

## The activity data model

Activity records are kept in a JSON document — `activities.json` by default — organised as a flat
array:

```json
{
  "schemaVersion": 1,
  "activities": [
    { "studentId": "S001", "activity": "Robotics Club", "source": "workbook" },
    { "studentId": "S001", "activity": "Chess Club", "source": "submission",
      "submittedAt": "2026-09-16T06:14:22.481Z" }
  ]
}
```

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `studentId` | string | yes | matches `/^S\d{3}$/` **and** must exist in the key set below |
| `activity` | string | yes | 1 to 60 characters after normalization; no control characters |
| `source` | string | yes | `"submission"` or `"workbook"`. Server-set; **never** accepted from the client |
| `submittedAt` | string | only when `source` is `"submission"` | ISO-8601 UTC, generated by the server; never accepted from the client. **Absent** on a seeded record |
| `schemaVersion` | number | yes (document level) | the literal `1`. A document declaring any other version is refused rather than guessed at |

Every one of these rules is enforced when the store is **loaded**, not only when a submission
arrives — the store is a plain file a person can edit, so a document that breaks any of them is
refused with `500 store_unreadable` and is **left exactly as found**, never silently overwritten or
deduplicated.

### The Student ID rule

`student_details.xlsx`, sheet `Student Details`, column A rows 2–11 is the **authority** for the key
set. It currently holds `S001` through `S010`. All three workbooks agree today, but naming one
authority removes the ambiguity of which to trust if they ever diverge.

- A Student ID is the literal `S` followed by exactly three decimal digits, zero-padded. The format
  is taken from the data, where all thirty Student ID cells across the three workbooks have that form.
- A **malformed** ID — `s1`, `S1`, `S0012`, `ABC`, or a non-string — is `400 student_id_malformed`.
- A **well-formed ID naming no student** — `S999` — is `404 student_not_found`.

That split is deliberate: a syntactically wrong identifier is a malformed *request*, while a
well-formed identifier with no matching student is a reference to a parent that does not exist.
Separating them tells a submitter which of the two mistakes they made.

**Enforcement is code in the request path, and can only be code.** No workbook declares a key, none
contains a data-validation part, and a JSON file offers no constraint mechanism either. The three-way
agreement of the Student ID sets is an observed regularity, not a rule the data can uphold. Calling
Student ID a "primary key" therefore describes an intention; the mechanism is the validation that runs
on every request before anything is persisted. There is no second line of defence.

### Provenance: why `source` exists

A label sitting in a workbook was not necessarily submitted by a student, and certainly not at the
moment the workbook was generated. Giving such a record a `submittedAt` would fabricate provenance and
make imported data indistinguishable from a real submission. So a seeded record is marked
`"source": "workbook"` and carries **no** `submittedAt`, while a record that arrived through
`POST /activities` is marked `"source": "submission"` and carries a server-generated timestamp. A
seeded record can still be matched, so a student who submits a label they already hold still receives
the idempotent `200` — what changes is that the response distinguishes a pre-existing import from
their own earlier submission.

### Cardinality and the store's key

**A student may hold many activities.** The workbook column is single-valued; the store is a flat
array of records precisely so it can represent the plural that column cannot.

The store's own key is the **composite `(studentId, normalized activity label)`**, compared
**case-insensitively**. `studentId` alone is the **foreign key** into `student_details.xlsx` — the
link to the student — and is *not* the store's own identifier, because a student holds several
records. No surrogate identifier is introduced: the composite is stable, human-readable and derivable
from the submission itself.

### Normalization

Applied before a record is stored:

- leading and trailing whitespace is trimmed;
- every run of internal whitespace is collapsed to a single space;
- any string containing a control character is rejected as `400 activity_invalid` — a tab or a newline
  is refused, never laundered into a space;
- the 1-to-60-character bound is enforced **after** the two steps above;
- the submitted casing is **preserved** in the stored value, so `Chess Club` is stored as typed;
- comparison for the composite key is **case-insensitive**, so `chess club` submitted after
  `Chess Club` is recognised as the same activity.

**No closed vocabulary is imposed.** Any activity name is accepted. The existing column is
unconstrained free text, and an enumeration invented here would reject a legitimate new club while
claiming a constraint the data never carried. Case-insensitive deduplication is the mitigation for
near-duplicates instead. The 60-character bound is generous against the data: the longest existing
label, `Photography Club`, is sixteen characters.

### Idempotency

Re-submitting an existing composite key **changes nothing**: the store is not written, and the
response is `200` carrying the existing record with its **original** `submittedAt` — or with
`source: "workbook"` and no timestamp if it was seeded. A new composite key appends one record and
responds `201`. The distinction lives in the status code, which is what makes it observable from
outside the process, and it makes a retry after a failed write safe.

### Relationship to the workbooks

**`activities.json` is the current record for submitted activities.** When the store is first
materialised it is **seeded** from the `Extracurricular Activity` column of `student_other_info.xlsx`,
so it begins as a superset of what that column records and never becomes a second, disagreeing source
of truth. A read of a student with no submissions therefore still returns their seeded label, and a
read never creates the store file.

**No workbook is ever written.** All three remain byte-identical — the feature reads column A of
`student_details.xlsx` for the key set and column C of `student_other_info.xlsx` once for the seed,
and nothing else. A consumer reading only the workbook therefore sees the pre-feature value, which
stays true rather than becoming wrong; the store is where activities added after this release are
found. No endpoint exposes a student's name, date of birth, email, phone, city or academic record.

## Configuration

`ACTIVITY_STORE` is the feature's **only** environment variable, and the only `process.env` read
anywhere in this project.

- It **overrides the store path**.
- It **defaults to `activities.json` beside the source**, next to `activity-store.js`.
- The path is **resolved once at module load**, so changing the variable mid-process has no effect.
  A relative value is interpreted against the working directory; an absolute path is recommended.
- Its **directory must already exist and be writable**, or every submission returns
  `500 store_write_failed`. The directory is not created for you.
- A write stages the whole document to **`${resolvedStorePath}.tmp`** and then renames it over the
  target, so a reader sees either the previous document or the new one and never a partial write.
  The staging path is *derived* from the resolved path, so the temp sibling follows `ACTIVITY_STORE`
  wherever it points and always sits in the same directory — hence on the same filesystem, which is
  what makes the rename atomic. With the default store path the staging file is `activities.json.tmp`.
- The store is **deliberately untracked**. `.gitignore` covers `activities.json` and
  `activities.json.tmp`, and the store must **never** be committed: committed bytes remain
  recoverable from history indefinitely, so a real student record committed here could not be erased
  without rewriting history.

Point the store at a scratch directory **outside the checkout**:

```bash
ACTIVITY_STORE=/tmp/scratch/activities.json npm start
```

Using a path outside the working tree is the recommended form. A store configured *inside* the
checkout under a name other than the two the ignore policy covers would be staged by default, which
is how submitted data reaches a commit by accident.

The **host and port remain hardcoded literals** — `127.0.0.1` and `3000` — and are **not**
configurable by any environment variable, flag or config file. That is a recognised gap, deliberately
left out of scope for this change: externalising them is a worthwhile improvement but is not what was
asked for, and widening the bind would expose an unauthenticated write endpoint.

## Testing

```bash
npm test                        # node --test --test-concurrency=1
```

The runner is the **built-in `node:test` with `node:assert`**, so the suite adds **no dependency** —
which is what keeps the zero-dependency posture true and keeps an installed `node_modules/` out of the
repository.

**Why concurrency is pinned to `1`.** `port = 3000` is a single unshareable literal in `server.js`
with no override, and the test runner executes each test file in a separate process. Two files both
binding that port collide with `EADDRINUSE` and a non-zero exit. Only `test/lifecycle.test.js`
actually needs the literal port; `test/activities.test.js` binds port `0` and takes whatever ephemeral
port it is given. The suite is small enough that serialising the whole run is the simpler correct
setting.

**Port 3000 must be free** before the suite runs. `test/lifecycle.test.js` performs a `node:net`
pre-flight probe that binds `127.0.0.1:3000` and immediately closes it; if the port is held the run
fails fast and names the port and the error code, instead of surfacing an environment problem as a
confusing assertion failure deep inside the suite.

The three test files and their division of labour:

| File | Port | Asserts |
| --- | --- | --- |
| `test/store.test.js` | **none** — reads and writes a temporary store via `ACTIVITY_STORE`, so it is safely parallel | store behaviour: seeding and all three initial states, normalization, composite-key dedupe, the load-validation refusals, the workbook reader's supported format subset, the write mechanics (atomic replacement, a configured store path and its derived temp sibling, a stale temp file, concurrent submissions, recovery after a transient write fault), and the four workbook invariants |
| `test/activities.test.js` | **ephemeral** — creates its own server on port `0` and closes it afterwards, so it contends for nothing | every feature-originated row of the response matrix, one named case each and in both request modes where HTML applies: the form's content type, `201` with `Location`, the idempotent `200` with its original `submittedAt`, a seeded record's `source`, read-back, the route-correct `Allow`, the `413` boundary at 8,192 and 8,193 bytes, the validation precedence order, and a `<script>` label served escaped |
| `test/lifecycle.test.js` | **the literal `3000`** — spawns `node server.js`, so it must run serially | process behaviour: the readiness line emitted exactly once with its exact text, `GET /` byte for byte against the recorded sha256, each namespace-boundary lookalike individually, and the `EADDRINUSE` disposition of a second instance |

**The tests must run on the same host as the service.** The loopback bind refuses off-host requests,
so a split runner-and-service topology is impossible and a container-published port would not reach
the listener either.

Machine-readable evidence is a separate, self-contained command. `EVIDENCE_ROOT` must be set by the
caller to a writable directory **outside the checkout**, and is deliberately **not** defaulted,
because the correct location differs per environment and a wrong default is how artifacts end up in
the working tree:

```bash
: "${EVIDENCE_ROOT:?set EVIDENCE_ROOT to a writable directory outside the checkout}"
mkdir -p "$EVIDENCE_ROOT"
RUN="$(mktemp -d "$EVIDENCE_ROOT/testrun-XXXXXX")"
node --test --test-concurrency=1 --experimental-test-coverage \
     --test-reporter=spec  --test-reporter-destination=stdout \
     --test-reporter=junit --test-reporter-destination="$RUN/results.xml"
echo "evidence retained in $RUN"
```

