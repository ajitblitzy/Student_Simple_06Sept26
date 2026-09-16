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
- **A version manager is optional.** `nvm` — or any manager that reads `.nvmrc` — only *selects* the
  pinned release; it is a convenience, not a dependency of this project. Where the runtime is already
  installed host-wide and `node --version` already prints `v24.21.0`, there is nothing left to select:
  step 1 below is skipped in full and no version manager need be present at all. That is the case on
  this project's own supported environment, which installs `v24.21.0` host-wide and deliberately ships
  no version manager.

Beyond that one runtime there are **no other prerequisites**: no version manager, no database, no
cache, no message broker, no service to provision, no credential to obtain, and no package to install.
The project declares **zero dependencies and zero devDependencies**; the feature uses only the
runtime's built-in modules (`node:http`, `node:fs`, `node:path`, `node:zlib`) and the built-in test
runner. There is no private registry, no authentication token, no `.npmrc`, and no internal or scoped
package anywhere in this project — so there is no registry to configure and no credential step to
perform.

## Install, start, and test

```bash
# 1. Select the pinned runtime. Check what your shell already resolves first:

node --version                  # already v24.21.0? skip to step 2 — nothing to select

# Only if it is not, and only where a version manager that reads .nvmrc is installed:

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

Four notes separate these commands *working* from merely *appearing* to work:

- **Step 1 is conditional; steps 2 to 4 are not.** A version manager selects a runtime, so it has
  nothing to do once the pinned runtime is the one your shell resolves already — and it is
  deliberately absent from this project's supported environment, where `v24.21.0` is the default. So
  `nvm install && nvm use` answering `nvm: command not found` is **not** a failure of this project:
  confirm `node --version` prints `v24.21.0` and go straight to `npm ci`. Install a version manager
  only if you need to *change* which runtime your shell resolves.
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

Both commands below submit the **same** activity, `(S001, Chess Club)`, because what they contrast is
the two media types and not two different records. They are therefore a **sequence, not two
independent examples**: whichever runs first against a fresh store creates the record and answers
`201`, and the other then finds that composite key already present and answers `200` having written
nothing.

```bash
# Form-encoded, as the browser form posts it
curl -i -X POST http://127.0.0.1:3000/activities \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'studentId=S001' --data-urlencode 'activity=Chess Club'

# JSON, as a script posts it — the same activity again, so this one is the idempotent repeat
curl -i -X POST http://127.0.0.1:3000/activities \
  -H 'Content-Type: application/json' \
  -d '{"studentId":"S001","activity":"Chess Club"}'
```

Run top to bottom against a fresh store, the form command answers `201 Created` with
`Location: /activities/S001` and — being form-encoded — an HTML confirmation page rather than JSON.
The JSON command answers `201` with this body when it is the one that runs **first** against a fresh
store:

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

Run **second**, as the block above has it, that same command submits a composite key that already
exists. Nothing is written, no `Location` header is sent, the status is `200 OK`, and the record
returned is the one the first command stored — carrying its **original** `submittedAt`, not a new one:

```json
{
  "created": false,
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
`"source": "workbook"` with **no** `submittedAt`. To watch the JSON command create rather than repeat,
submit a different activity, or point `ACTIVITY_STORE` at a store file that does not exist yet inside a
directory that does — see **Configuration** below.

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
| `POST /activities` | `403` | `cross_origin_submission` | the browser reported the submission as coming from somewhere other than this service: an `Origin` that is `null`, unparseable, not `http:`, or whose host is not the host the request was addressed to, or a `Sec-Fetch-Site` of `same-site` or `cross-site` | — |
| `POST /activities` | `404` | `student_not_found` | well-formed `studentId` absent from the key set | — |
| `POST /activities` | `413` | `payload_too_large` | body over 8,192 bytes | — |
| `POST /activities` | `415` | `unsupported_media_type` | `Content-Type` missing, **declared more than once**, or neither accepted type | — |
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
`403`, `413` and `415` are all decided before the body's format is known, an unresolved route has no
form context to re-display, and a `500` is a fault no amount of retyping fixes.

**`403 cross_origin_submission`, and why a script is unaffected by it.** `POST /activities` changes
stored state, and an HTML form can be made to submit across origins — a page on any other site can
carry a form whose action is this service, and the browser that loads it will send the request.
Nothing else here stands in the way: there is no authentication, session, cookie or token anywhere in
the service, and the loopback bind is no defence, because the browser making such a request is itself
on the loopback host. So a submission is refused when the browser's own `Origin` or `Sec-Fetch-Site`
header says it came from somewhere other than this service. A request carrying **neither** header is
accepted, which is deliberate: no browser omits `Origin` on a POST, so a request without one is not a
browser form submission but `curl`, a script, or the test suite — every `curl` example in this
document works unchanged, and none of them needs a token or a prior `GET`. What this check does
**not** do is establish *who* is submitting; the Student ID remains self-asserted, exactly as the
attribution section below describes.

### The error envelope

Every **JSON** error response carries the same two-key envelope — whichever route produced it, and
whether or not the fault was one the feature anticipated:

```json
{ "error": "<code>", "message": "<fixed English sentence for that code>" }
```

`error` is the stable machine-readable code and is what a test should match on. `message` is a fixed
sentence per code — not free text, not interpolated, and never carrying a stack trace, a filesystem
path or any other internal detail. A JSON error body carries **no additional fields**, and in
particular the offending Student ID is **not** echoed back into it.

That includes `internal_error`, the one code answered by the rejection boundary in `server.js` rather
than by the feature's own vocabulary. That boundary is reached only by a fault nothing anticipated, so
its sentence is a literal about the outcome and never about the fault:

```json
{
  "error": "internal_error",
  "message": "The request could not be completed because of an unexpected internal error."
}
```

The same fault is recorded server-side as one line of allow-listed fields, for example
`request_handler_failed method=GET path=/activities/S001 error=Error code=-`. It carries the stable
event code, the request method, the request **pathname** with the query string dropped, and the
thrown value's name and code — never its message, its stack or its `cause`, because those name source
and store paths and can carry record values. There are exactly **four distinct `500` codes** in
total: `reference_data_unavailable`, `store_unreadable`, `store_write_failed` and `internal_error`.

**The envelope is a statement about JSON responses.** A form-encoded `POST /activities` whose outcome
a person can act on answers with HTML instead, as the paragraph above sets out, and that page
deliberately re-displays the submitted `studentId` and `activity` so the form can be corrected rather
than retyped — every value it interpolates is HTML-escaped first. So the no-echo and no-extra-fields
guarantees describe the JSON envelope; in HTML mode the submitted values are shown back by design, and
a client that wants the envelope for every failure sends `application/json`.

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
deduplicated. The shape is **exact**: a document or a record carrying any key outside the fields
above is refused the same way, naming the unexpected key and, for a record, its index, rather than
being dropped on load and then erased by the next write.

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
on every request before anything is persisted.

That mechanism is **layered, and the layers answer to different callers**. The HTTP layer owns the
*user-facing* check: it runs before the store is called at all, and it is the only place that can turn
a bad reference into the `400`/`404` split above. The store then **revalidates independently**, because
it is reachable by more than one caller and is backed by a file a person can edit — every write
re-checks the Student ID's format *and* its membership of the key set before a record is appended, and
every load re-checks both properties for every record already in the document, refusing the whole
document with `500 store_unreadable` rather than serving one that names an unknown student. Neither
layer relies on the other having run. That is why the HTTP check is not optional even though the store
repeats it, and why a hand-edited store naming `S999` is refused instead of returned.

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
- any string containing a control character, U+2028 LINE SEPARATOR or U+2029 PARAGRAPH SEPARATOR is
  rejected as `400 activity_invalid` — a tab, a newline and either line separator are refused,
  never laundered into a space, because laundering a line terminator would let two visually
  identical labels dedupe differently;
- the 1-to-60-character bound is enforced **after** the two steps above, and is measured in
  **UTF-16 code units** — exactly how the form's `maxlength="60"` is evaluated, so the JSON API and
  the native form agree on the boundary for every label, astral characters included;
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

**No workbook is ever written.** All three remain byte-identical. A consumer reading only the
workbook therefore sees the pre-feature value, which stays true rather than becoming wrong; the store
is where activities added after this release are found.

**What the running feature actually reads.** Column A of `student_details.xlsx` for the key set, and
columns A and C of `student_other_info.xlsx` — the Student ID beside the label, since a seeded record
needs both — read together in a single pass the first time seed data is needed. Each workbook is
opened, inflated and parsed at most once per process, and `student_academics.xlsx` is not read by the
service at all; only the test suite's join assertion touches it.

**No value outside those columns is ever extracted.** The reader is asked for those columns by name
and walks the worksheet by position, so no other cell's text becomes a value: a student's name, date
of birth, email, phone, city and academic record are never read out of the worksheet, never held as
data, and never exposed by any endpoint. To be precise about the one thing that is unavoidable — the
worksheet part is decompressed and decoded as a whole, because refusing a malformed or mis-encoded
workbook means reading it — so those bytes do pass through the process; what does not happen is any
of them being extracted, stored, logged or served.

## Configuration

`ACTIVITY_STORE` is the feature's **only** environment variable, and the only `process.env` read
anywhere in this project.

- It **overrides the store path**.
- It **defaults to `activities.json` beside the source**, next to `activity-store.js`.
- The path is **resolved once at module load**, so changing the variable mid-process has no effect.
  A relative value is interpreted against the working directory; an absolute path is recommended.
- Its **directory must already exist and be writable**, or a submission that has to **persist a new
  record** returns `500 store_write_failed`. The directory is not created for you. The failure is
  scoped to that case: a submission repeating an existing composite key performs no write and still
  returns `200` with the existing record — including a repeat of a seeded label while the store
  file is still absent — and `GET /activities/{id}` never writes at all.
- A write stages the whole document to **`${resolvedStorePath}.tmp`** and then renames it over the
  target, so a reader sees either the previous document or the new one and never a partial write.
  The staging path is *derived* from the resolved path, so the temp sibling follows `ACTIVITY_STORE`
  wherever it points and always sits in the same directory — hence on the same filesystem, which is
  what makes the rename atomic. With the default store path the staging file is `activities.json.tmp`.
- It **may not name a protected file of this project**. The configured value is canonicalized once
  at load — a relative form is resolved, and the comparison is case-insensitive on Windows and
  macOS — and both it and the derived `.tmp` sibling are compared against every tracked file: the
  three `.xlsx` workbooks, `LICENSE`, and the project's own source, test and configuration files. A
  protected destination is refused at module load, before any store read or write, with a
  `RangeError` carrying `code: 'E_STORE_PATH_PROTECTED'` that names `ACTIVITY_STORE` and the
  protected file, so the service fails fast at startup instead of renaming a store document over
  student data. The check exists because a write is a `rename` **over** the target: a mistyped
  variable would not append to a workbook or to `LICENSE`, it would replace it. `activities.json`
  and `activities.json.tmp` are of course still accepted — they are the default.
- The store is **deliberately untracked**. `.gitignore` covers `activities.json` and
  `activities.json.tmp`, and the store must **never** be committed: committed bytes remain
  recoverable from history indefinitely, so a real student record committed here could not be erased
  without rewriting history.

Create a scratch directory **outside the checkout** and point the store at it:

```bash
mkdir -p /tmp/student-simple-activities
ACTIVITY_STORE=/tmp/student-simple-activities/activities.json npm start
```

On Windows PowerShell the equivalents are
`New-Item -ItemType Directory -Force C:\Temp\student-simple-activities` and
`$env:ACTIVITY_STORE='C:\Temp\student-simple-activities\activities.json'; npm start`.

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
the working tree.

The command **verifies that rather than trusting it**, and it fails closed. It compares **filesystem
identity** — device and inode, not path strings — and refuses to run if the evidence root is the
worktree, sits anywhere beneath it, or is a shared directory such as `/tmp` itself. Identity is the
load-bearing detail: this host is case-insensitive while Git Bash preserves whatever spelling the
caller used, so `/TMP/...` and `/tmp/...` are the same directory under two different strings and a
string comparison would let the second one through. Every refusal happens *before* any directory is
created, because creating one inside the checkout is itself the contamination.

That refusal is the containment mechanism: the ignore policy covers `coverage/` and `*.log`, but it
deliberately carries **no pattern for a JUnit report**, so a run pointed at the checkout would
otherwise leave a stageable `results.xml` behind. Run directories are retained for inspection, so
prune `EVIDENCE_ROOT` on whatever schedule suits.

```bash
set -euo pipefail
: "${EVIDENCE_ROOT:?set EVIDENCE_ROOT to a writable directory outside the checkout}"

# Identity key for an existing directory: device:inode where the host reports it,
# otherwise the case-folded physical path. Comparing path strings is not enough.
# This host is case-insensitive while Git Bash preserves the caller's spelling, so
# /TMP/... and /tmp/... are one directory under two different strings, and a string
# compare would wave the second one through.
fold() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
dirkey() {
  local phys key
  phys="$(cd "$1" 2>/dev/null && pwd -P)" || return 1
  key="$(stat -Lc '%d:%i' "$phys" 2>/dev/null || true)"
  case "$key" in
    ''|*:0) key="fold:$(fold "$phys")" ;;
  esac
  printf '%s\n' "$key"
}

worktree="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
worktree_key="$(dirkey "$worktree")"
if [ -z "$worktree_key" ]; then
  echo "cannot identify the worktree; refusing to guess" >&2; exit 1
fi

# EVIDENCE_ROOT need not exist yet, so split it into its nearest existing ancestor
# and the remainder. ${base%/} keeps a root-level remainder from becoming "//var/tmp".
base="$EVIDENCE_ROOT"; rest=""
while [ ! -d "$base" ]; do
  rest="/$(basename "$base")$rest"
  parent="$(dirname "$base")"
  if [ "$parent" = "$base" ]; then
    echo "EVIDENCE_ROOT has no existing ancestor: $EVIDENCE_ROOT" >&2; exit 1
  fi
  base="$parent"
done
base="$(cd "$base" && pwd -P)"
base_key="$(dirkey "$base")"
evidence="${base%/}$rest"
if [ -z "$evidence" ]; then evidence="/"; fi

# Refuse the worktree itself and anything beneath it. Two tests, because neither
# alone is enough: the identity key settles "is this the very same directory",
# including through a symlink, and the case-folded prefix settles "is this beneath
# it" for the alias spellings `pwd -P` hands back verbatim. On a case-sensitive
# host the fold can only ever over-refuse, which is the safe direction here.
inside=no
if [ "$base_key" = "$worktree_key" ]; then inside=yes; fi
case "$(fold "$base")/" in "$(fold "$worktree")"/*) inside=yes ;; esac
if [ "$inside" = yes ]; then
  echo "refusing: EVIDENCE_ROOT resolves inside the worktree ($worktree)" >&2; exit 1
fi

# Refuse a shared directory itself; each run needs a private directory of its own.
# The folded-string test catches one that does not exist yet (so it has no inode);
# the key test catches an alias of one that does, such as /TMP for /tmp.
evidence_fold="$(printf '%s' "$evidence" | tr '[:upper:]' '[:lower:]')"
for shared in / /tmp /var/tmp /dev/shm "${HOME:-}"; do
  [ -n "$shared" ] || continue
  shared_fold="$(printf '%s' "$shared" | tr '[:upper:]' '[:lower:]')"
  if [ "$evidence_fold" = "$shared_fold" ]; then
    echo "refusing: EVIDENCE_ROOT is the shared directory $shared" >&2; exit 1
  fi
  if [ -z "$rest" ] && [ -d "$shared" ] && [ "$(dirkey "$shared")" = "$base_key" ]; then
    echo "refusing: EVIDENCE_ROOT is the shared directory $shared" >&2; exit 1
  fi
done

mkdir -p "$evidence"
RUN="$(mktemp -d "$evidence/testrun-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
node --test --test-concurrency=1 --experimental-test-coverage \
     --test-reporter=spec  --test-reporter-destination=stdout \
     --test-reporter=junit --test-reporter-destination="$RUN/results.xml"
echo "evidence retained in $RUN"
```

The timestamped `mktemp -d` template guarantees a fresh directory even for two runs in the same
second, so one run never overwrites another's results. A coverage gate must assert that `server.js`
appears as a **row** in the per-file table, not merely that a percentage cleared — a suite that
spawns the service as a child process prints an empty file table and an "all files 100%" summary, so
a gate reading only the percentage would pass a run that executed none of the file.
