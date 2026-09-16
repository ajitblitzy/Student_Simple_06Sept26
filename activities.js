'use strict';

/**
 * activities.js — the HTTP contract for the `/activities` namespace.
 *
 * WHAT THIS MODULE OWNS
 * ---------------------
 * The request surface, and only that. This is the first code in the project
 * that reads a request — until now `req` was a declared parameter that no
 * statement dereferenced — and it carries the project's first user interface,
 * a submission form rendered from a template literal further down this file.
 *
 * Three routes, one namespace:
 *
 *   GET  /activities               the submission form (HTML)
 *   POST /activities               a submission, form-encoded or JSON
 *   GET  /activities/{studentId}   one student's activities (JSON only)
 *
 * The single export is `handle`, and its BOOLEAN RESULT is the whole
 * integration surface: `true` means this module claimed the request and has
 * answered it, `false` means the path lies outside the namespace and the
 * caller should fall through to its own behaviour. That one bit is what keeps
 * the change in `server.js` to a single branch, and it is why NOTHING is
 * written to `res` on the `false` path — a request this module declines has to
 * be left exactly as it was found, header for header.
 *
 * WHAT THIS MODULE DOES NOT OWN
 * -----------------------------
 * The domain. `activity-store.js` holds the key set, the normalization rules
 * and the persistence. This file performs NO string normalization and holds NO
 * key set of its own: it parses a request, calls `normalizeLabel`,
 * `isKnownStudent`, `addActivity` and `listActivities`, and maps their
 * outcomes onto status codes. "Validate in the HTTP layer, normalize in the
 * store" would spread one rule across two files and leave neither able to
 * enforce it.
 *
 * It does not own `internal_error` either. That fourth 500 belongs to the
 * `try`/`catch` in `server.js`, which is the rejection boundary for anything
 * this module fails to anticipate. Everything the store can refuse IS
 * anticipated here and mapped to a code of its own, because an escaped
 * rejection would arrive as `internal_error` and mask the real cause.
 *
 * GOVERNING RULE: `Ajit_AddNewFeature_Rule`
 * -----------------------------------------
 * Summarized, never reproduced. Three of its areas bear on this file.
 *
 * Its SYSTEM BOUNDARIES area is why the namespace predicate below is exact
 * rather than convenient. The path is taken from `new URL(...).pathname`, so a
 * query string cannot reach the match; a single trailing slash is stripped;
 * and the test is segment-safe. A `startsWith` against the raw `req.url` would
 * capture `/activities-old` and `/activitieslist`, and the promise that every
 * path outside this namespace behaves exactly as it did before would quietly
 * become false.
 *
 * Its TECHNICAL IMPLEMENTATION area is why every row of the response matrix is
 * implemented, in the documented validation order, behind the guarded body
 * read — those are the deliverable, not hardening to be added later.
 *
 * Its MINIMAL CHANGE AND DISCIPLINE area is why there is no framework, no
 * router library, no template engine, no static asset, no client-side
 * JavaScript, no bundler, no CORS header, no cookie, no session, no request
 * logging and no fourth endpoint. The form and the result page are template
 * literals here, so the repository root gains no asset and nothing is read
 * from disk to render a page. The only `require` is `./activity-store`: `URL`
 * and `URLSearchParams` are globals, so not even `node:querystring` is needed,
 * and `node:http` is not required because this module is handed the request
 * and response objects rather than creating a server.
 *
 * Usage, from `server.js`:
 *   const activities = require('./activities');
 *   if (await activities.handle(req, res)) return;   // claimed and answered
 */

const store = require('./activity-store');

/* ------------------------------------------------------------------------- *
 * The namespace, and the shape of a Student ID
 * ------------------------------------------------------------------------- */

/** The only path this module claims. Nothing outside it is touched. */
const NAMESPACE_PATH = '/activities';

/**
 * The prefix a sub-resource of the namespace must carry. Written with its
 * trailing slash so the membership test is segment-safe by construction:
 * `/activities-old` and `/activitieslist` share the namespace's characters but
 * not its segment boundary, and neither starts with this string.
 */
const NAMESPACE_PREFIX = `${NAMESPACE_PATH}/`;

/**
 * A base for `new URL`. Never used as an address and never sent anywhere: the
 * request target of an origin-form request is a path, and `URL` needs some
 * base to resolve it against before a pathname can be read off it.
 */
const PATH_RESOLUTION_BASE = 'http://localhost';

/**
 * The Student ID form, taken from the data rather than invented: all thirty
 * Student ID cells across the three workbooks are `S` followed by exactly
 * three digits.
 *
 * This duplicates a pattern `activity-store.js` also holds, deliberately.
 * `isKnownStudent` answers `false` for a malformed value without reading a
 * workbook, so on its own it could only ever produce a 404 — and the whole
 * point of the split is that a syntactically wrong identifier is a malformed
 * REQUEST (400) while a well-formed identifier naming no student is a
 * reference to a parent that does not exist (404). Telling those two apart is
 * an HTTP concern, so the shape test lives here. Membership of the key set
 * stays the store's to answer, and is never second-guessed here.
 */
const STUDENT_ID_PATTERN = /^S\d{3}$/;

/* ------------------------------------------------------------------------- *
 * Methods, media types and limits
 * ------------------------------------------------------------------------- */

const METHOD_GET = 'GET';
const METHOD_POST = 'POST';

/**
 * The `Allow` header value for each route that RESOLVES. A 405 always carries
 * one, and it always names the methods of the route actually addressed rather
 * than of the namespace as a whole — `Allow: GET, POST` would be a lie on
 * `/activities/{id}`, which accepts only `GET`.
 */
const ALLOW_COLLECTION = 'GET, POST';
const ALLOW_ITEM = 'GET';

/**
 * The two request media types `POST /activities` accepts. The first is what a
 * browser form posts by default, which is exactly why the form below needs no
 * client-side JavaScript: its native encoding and this endpoint's accepted
 * type are the same thing.
 */
const MEDIA_TYPE_FORM = 'application/x-www-form-urlencoded';
const MEDIA_TYPE_JSON = 'application/json';

/**
 * Response media types. Both carry an explicit charset. The legacy
 * `text/plain` response in `server.js` deliberately carries none, and is not
 * touched by this feature — a path outside this namespace must stay byte for
 * byte what it was.
 */
const CONTENT_TYPE_HTML = 'text/html; charset=utf-8';
const CONTENT_TYPE_JSON = 'application/json; charset=utf-8';

/**
 * The request-body ceiling in bytes, INCLUSIVE: a body of exactly 8192 bytes
 * is read, 8193 is refused with 413. A legitimate submission
 * (`studentId=S001&activity=Photography+Club`) is under fifty bytes, so this
 * is three orders of magnitude of headroom while still bounding the memory any
 * one request can make this process hold.
 */
const MAX_BODY_BYTES = 8192;

/**
 * How a submission arrived, which is also how its outcome is rendered.
 * Negotiation is on the REQUEST media type and never on `Accept`, because that
 * is deterministic and directly assertable. The status code is identical
 * either way; only the representation differs.
 */
const MODE_FORM = 'form';
const MODE_JSON = 'json';

/** The two body fields a submission carries. */
const FIELD_STUDENT_ID = 'studentId';
const FIELD_ACTIVITY = 'activity';

/* ------------------------------------------------------------------------- *
 * The failure vocabulary
 *
 * Every error response is the same two-key envelope:
 *
 *     { "error": "<code>", "message": "<fixed sentence for that code>" }
 *
 * `code` is the contract a test matches on. `message` is a FIXED sentence per
 * code — not free text, not interpolated, and never carrying a stack, a
 * filesystem path, a store path or any other internal detail. Nothing else is
 * added: the offending Student ID is deliberately NOT echoed, so there is one
 * envelope shape for every failure and no reflection of submitted input back
 * to the submitter.
 *
 * Status, code and sentence are bound together in one frozen object per
 * failure rather than looked up in a table by code. A call site therefore
 * cannot pair a status with the wrong code, and cannot send a code whose
 * sentence was never written.
 * ------------------------------------------------------------------------- */

/**
 * Builds one immutable failure.
 *
 * @param {number} status The HTTP status this failure is sent with.
 * @param {string} code The stable machine-readable code.
 * @param {string} message The fixed sentence for that code.
 * @returns {{status: number, code: string, message: string}} A frozen failure.
 */
function failure(status, code, message) {
  return Object.freeze({ status, code, message });
}

const FAILURES = Object.freeze({
  MALFORMED_JSON: failure(
    400,
    'malformed_json',
    'The request body could not be parsed as JSON.'
  ),
  BODY_NOT_AN_OBJECT: failure(
    400,
    'body_not_an_object',
    'The request body must be a JSON object.'
  ),
  STUDENT_ID_REQUIRED: failure(
    400,
    'student_id_required',
    'A Student ID is required.'
  ),
  STUDENT_ID_MALFORMED: failure(
    400,
    'student_id_malformed',
    'A Student ID must be the letter S followed by exactly three digits, for example S001.'
  ),
  ACTIVITY_INVALID: failure(
    400,
    'activity_invalid',
    'An activity must be a label of 1 to 60 characters and must not contain control characters.'
  ),
  STUDENT_NOT_FOUND: failure(
    404,
    'student_not_found',
    'No student exists with that Student ID.'
  ),
  NOT_FOUND: failure(404, 'not_found', 'That resource does not exist.'),
  METHOD_NOT_ALLOWED: failure(
    405,
    'method_not_allowed',
    'That method is not allowed for this resource.'
  ),
  PAYLOAD_TOO_LARGE: failure(
    413,
    'payload_too_large',
    'The request body is larger than the 8192-byte limit.'
  ),
  UNSUPPORTED_MEDIA_TYPE: failure(
    415,
    'unsupported_media_type',
    'A submission must be sent as application/x-www-form-urlencoded or application/json.'
  ),
  REFERENCE_DATA_UNAVAILABLE: failure(
    500,
    'reference_data_unavailable',
    'The student reference data could not be read.'
  ),
  STORE_UNREADABLE: failure(
    500,
    'store_unreadable',
    'The activity store could not be read.'
  ),
  STORE_WRITE_FAILED: failure(
    500,
    'store_write_failed',
    'The activity could not be saved.'
  ),
});

/**
 * The refusals `activity-store.js` can raise, mapped to the response each
 * becomes.
 *
 * Mapping every one of them is not defensive decoration. An unmapped
 * rejection escapes to the `try`/`catch` in `server.js` and is answered
 * `internal_error`, which is a true statement about the process and a useless
 * one about the fault: a submitter told "internal error" cannot tell an
 * unreadable workbook from a full disk.
 *
 * `E_LABEL_INVALID` appears here as well as in the inline validation because
 * `addActivity` re-inspects the label it is handed rather than trusting it.
 * Normalization is idempotent, so for the already-normalized value this module
 * is contracted to pass, that check cannot fire — and if a future change ever
 * broke the contract, the mapping keeps the outcome a 400 about the label
 * instead of a 500 about the process.
 */
const STORE_FAILURES = Object.freeze({
  E_LABEL_INVALID: FAILURES.ACTIVITY_INVALID,
  E_REFERENCE_DATA: FAILURES.REFERENCE_DATA_UNAVAILABLE,
  E_STORE_UNREADABLE: FAILURES.STORE_UNREADABLE,
  E_STORE_WRITE_FAILED: FAILURES.STORE_WRITE_FAILED,
});

/**
 * Translates a thrown value into the failure it should be answered with.
 *
 * @param {unknown} error Whatever was thrown — not assumed to be an `Error`.
 * @returns {{status: number, code: string, message: string}|null} The mapped
 *   failure, or `null` when the fault is not one the store declares, in which
 *   case the caller rethrows and `server.js` owns it.
 */
function storeFailureFor(error) {
  if (error === null || typeof error !== 'object') {
    return null;
  }
  const code = error.code;
  if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(STORE_FAILURES, code)) {
    return null;
  }
  return STORE_FAILURES[code];
}

/**
 * The failure codes a person who filled in the form can actually act on, and
 * therefore the only ones rendered as HTML.
 *
 * Everything else stays the JSON envelope in both request modes: 413 and 415
 * are decided before the body's format is known, an unresolved route has no
 * form context to re-display, a 405 answers a client that chose its own
 * method, and a 500 is a fault no amount of retyping fixes.
 *
 * `malformed_json` and `body_not_an_object` are absent because they are
 * unreachable from a form submission by construction — a form body is parsed
 * with `URLSearchParams`, which accepts any string and never fails, so
 * `JSON.parse` is never reached in form mode.
 */
const FORM_RENDERABLE_CODES = new Set([
  FAILURES.STUDENT_ID_REQUIRED.code,
  FAILURES.STUDENT_ID_MALFORMED.code,
  FAILURES.ACTIVITY_INVALID.code,
  FAILURES.STUDENT_NOT_FOUND.code,
]);

/* ------------------------------------------------------------------------- *
 * Internal signals for the body read
 *
 * Not part of the response vocabulary and never sent to a client: these two
 * codes only travel from the body reader to its immediate caller, which
 * decides what the client is told.
 * ------------------------------------------------------------------------- */

const SIGNAL_BODY_TOO_LARGE = 'E_BODY_TOO_LARGE';
const SIGNAL_REQUEST_STREAM_FAILED = 'E_REQUEST_STREAM_FAILED';

/** Which of the two page states a rendered message represents. */
const MESSAGE_SUCCESS = 'success';
const MESSAGE_ERROR = 'error';

/* ------------------------------------------------------------------------- *
 * HTML escaping — a security requirement, not a nicety
 * ------------------------------------------------------------------------- */

const HTML_ENTITIES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

const HTML_SPECIAL_CHARACTERS = /[&<>"']/g;

/**
 * Escapes a value for interpolation into markup.
 *
 * This is load-bearing rather than tidy. A valid activity label may
 * legitimately contain `&`, `<`, `>`, `"` or `'` — nothing in the store's
 * normalization rules excludes them — so interpolating a label or a Student ID
 * straight into the result page would permit script injection THROUGH A VALUE
 * THE FEATURE ITSELF ACCEPTED. The attack needs no malformed request at all.
 *
 * All five characters are converted, which covers HTML text context and
 * double-quoted attribute context with one function. Every attribute in the
 * templates below is double-quoted, so there is no third context to get wrong,
 * and an escaped `"` cannot terminate an attribute early.
 *
 * A non-string is answered with the empty string rather than coerced: the only
 * values reaching markup are submitted strings and this module's own fixed
 * sentences, so a non-string here would mean a bug, and rendering the word
 * "undefined" into a form field would hide it.
 *
 * @param {unknown} value The value to place into markup.
 * @returns {string} The escaped text, or `''` for anything not a string.
 */
function escapeHtml(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(HTML_SPECIAL_CHARACTERS, (character) => HTML_ENTITIES[character]);
}

/* ------------------------------------------------------------------------- *
 * The page — this project's first user interface
 *
 * One page serves every state a submitter can reach: the empty form, the
 * confirmation, the already-recorded notice and the validation error. It is a
 * heading, two labelled text inputs and a submit button, and nothing more.
 *
 * No component library, design system or token source exists anywhere in this
 * repository, and no design was supplied, so semantic HTML carries the whole
 * burden: `lang` on the root element, a `<meta charset>`, exactly one `<h1>`, a
 * real `<form method="post">` with a real `<button type="submit">`, and a
 * `<label for>` bound to every `<input id>`. No `<div>` stands in for a
 * control, and there is no `<script>` of any kind — the form posts natively,
 * which is precisely why its default encoding and the endpoint's accepted media
 * type are the same thing.
 *
 * Outcome is conveyed as TEXT. The colour classes are reinforcement; a reader
 * who cannot perceive them loses nothing, because the sentence says what
 * happened.
 * ------------------------------------------------------------------------- */

/**
 * The page's entire stylesheet: one inline `<style>` block, SIXTEEN
 * declarations, six unique colours (`#ffffff` serves both the page background
 * and the button text). Keeping it to a single site means a later migration to
 * design tokens has exactly one place to change.
 *
 * There are deliberately no breakpoints, no elevation or z-index, no
 * transitions, and no icon or image assets. Vertical rhythm between a label
 * and its input comes from a `<br>` in the markup rather than from
 * `display: block` on the label, because a seventeenth declaration is not
 * available to spend.
 */
const STYLE_BLOCK = `      body {
        font-family: system-ui, sans-serif;
        color: #1a1a1a;
        background-color: #ffffff;
        max-width: 32rem;
        margin: 2rem auto;
        padding: 0 1rem;
      }
      label {
        margin-bottom: 0.25rem;
      }
      input {
        width: 100%;
        padding: 0.5rem;
        border: 1px solid #767676;
      }
      button {
        background-color: #1a4f8b;
        color: #ffffff;
        padding: 0.5rem 1rem;
      }
      input,
      button {
        border-radius: 4px;
      }
      .error {
        color: #b3261e;
      }
      .success {
        color: #146c2e;
      }`;

/**
 * Marks the field a validation failure was about.
 *
 * `aria-invalid` is an accessibility attribute, not styling and not script, so
 * flagging the field costs no CSS declaration and no client-side code. The
 * message above the form names the same field in words, so the flag is
 * reinforcement rather than the only signal.
 *
 * @param {string|null} invalidField The offending field name, or `null`.
 * @param {string} fieldName The field being rendered.
 * @returns {string} The attribute to splice in, or `''`.
 */
function invalidAttribute(invalidField, fieldName) {
  return invalidField === fieldName ? ' aria-invalid="true"' : '';
}

/**
 * Renders the page in one of its four states.
 *
 * Every dynamic value passes through `escapeHtml` on its way in — the two
 * submitted field values, which are arbitrary client input, and the message,
 * which is not but is escaped anyway so that no future caller can introduce
 * an unescaped path by supplying a message built from input.
 *
 * @param {{message: string|null, kind: string, studentId: string, activity: string, invalidField: string|null}} view
 *   `message` is `null` for the plain form. `kind` selects the colour class.
 *   `studentId` and `activity` are pre-filled back into the inputs so a
 *   correction does not mean retyping. `invalidField` flags one input.
 * @returns {string} A complete HTML document.
 */
function renderPage(view) {
  const messageClass = view.kind === MESSAGE_ERROR ? MESSAGE_ERROR : MESSAGE_SUCCESS;
  const messageMarkup =
    view.message === null
      ? ''
      : `    <p class="${messageClass}">${escapeHtml(view.message)}</p>\n`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Extracurricular activities</title>
    <style>
${STYLE_BLOCK}
    </style>
  </head>
  <body>
    <h1>Add an extracurricular activity</h1>
    <p>Enter your Student ID and the activity you would like recorded, then submit the form.</p>
${messageMarkup}    <form method="post" action="${NAMESPACE_PATH}">
      <p>
        <label for="student-id">Your Student ID, for example S001</label><br>
        <input id="student-id" name="${FIELD_STUDENT_ID}" type="text" pattern="S[0-9]{3}" value="${escapeHtml(
    view.studentId
  )}"${invalidAttribute(view.invalidField, FIELD_STUDENT_ID)}>
      </p>
      <p>
        <label for="activity">The activity, for example Chess Club</label><br>
        <input id="activity" name="${FIELD_ACTIVITY}" type="text" maxlength="60" value="${escapeHtml(
    view.activity
  )}"${invalidAttribute(view.invalidField, FIELD_ACTIVITY)}>
      </p>
      <p>
        <button type="submit">Add activity</button>
      </p>
    </form>
  </body>
</html>
`;
}

/**
 * The empty form, as served by `GET /activities`.
 *
 * @returns {string} A complete HTML document.
 */
function renderEmptyForm() {
  return renderPage({
    message: null,
    kind: MESSAGE_SUCCESS,
    studentId: '',
    activity: '',
    invalidField: null,
  });
}

/**
 * The value `activity-store.js` writes into a record it seeded from the
 * workbook column. Mirrored here — not imported, because the store's surface
 * is its five functions — and used for exactly one purpose: choosing between
 * two sentences on the already-recorded page. A label that came from the
 * student record was never submitted by anyone, and telling a submitter it was
 * "already submitted" would be false.
 */
const RECORD_SOURCE_WORKBOOK = 'workbook';

/**
 * The confirmation page, for both `201` and `200`.
 *
 * The success state restates what was recorded, so a submitter can see the
 * label as it was stored — normalized, with their casing preserved. The
 * Student ID is kept in the form and the activity field is cleared, because
 * the likely next action is recording a second activity.
 *
 * @param {boolean} created True when a record was appended, false when an
 *   identical one already existed and nothing was written.
 * @param {{studentId: string, activity: string, source: string, submittedAt?: string}} record
 *   The record as the store returned it.
 * @returns {string} A complete HTML document.
 */
function renderOutcome(created, record) {
  let message;
  if (created) {
    message = `Recorded ${record.activity} for ${record.studentId}.`;
  } else if (record.source === RECORD_SOURCE_WORKBOOK) {
    message =
      `${record.activity} is already on the student record for ${record.studentId}, ` +
      'so nothing was added.';
  } else {
    message =
      `${record.activity} was already submitted for ${record.studentId}, ` +
      'so nothing was added.';
  }

  return renderPage({
    message,
    kind: MESSAGE_SUCCESS,
    studentId: record.studentId,
    activity: '',
    invalidField: null,
  });
}

/**
 * The form re-displayed with the offending field flagged.
 *
 * The message is the failure's own fixed sentence followed by its code, so a
 * person reading the page and a script reading the JSON envelope get the same
 * diagnosis in the same words rather than two descriptions to reconcile.
 *
 * @param {{status: number, code: string, message: string}} outcome The failure.
 * @param {{studentId: string, activity: string}} submitted The values as they
 *   arrived, so a correction does not mean retyping.
 * @param {string|null} invalidField The field to flag.
 * @returns {string} A complete HTML document.
 */
function renderFailure(outcome, submitted, invalidField) {
  return renderPage({
    message: `${outcome.message} (${outcome.code})`,
    kind: MESSAGE_ERROR,
    studentId: submitted.studentId,
    activity: submitted.activity,
    invalidField,
  });
}


/* ------------------------------------------------------------------------- *
 * Sending a response
 *
 * Every write goes through `send`, which is guarded: once a response has
 * started, nothing can start it again. That guard is not theoretical. The body
 * reader below detaches its listener and drains the remainder of an oversized
 * request, and a late chunk that reached `res` after the 413 had been written
 * would throw ERR_HTTP_HEADERS_SENT and terminate the process — the exact
 * failure this shape exists to prevent.
 * ------------------------------------------------------------------------- */

/**
 * Writes one response, once.
 *
 * @param {import('node:http').ServerResponse} res The response.
 * @param {number} statusCode The status to send.
 * @param {string} contentType The full `Content-Type` value, charset included.
 * @param {string} body The body to send.
 * @param {Record<string, string>} [extraHeaders] Headers beyond the content
 *   type, such as `Allow` or `Location`.
 * @returns {void}
 */
function send(res, statusCode, contentType, body, extraHeaders) {
  if (res.headersSent || res.writableEnded) {
    return;
  }

  res.statusCode = statusCode;
  res.setHeader('Content-Type', contentType);

  if (extraHeaders !== undefined) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      res.setHeader(name, value);
    }
  }

  res.end(body);
}

/**
 * Sends a JSON document.
 *
 * The payload is serialized with `JSON.stringify` and never by string
 * concatenation, so a value carrying a quote or a backslash cannot break out
 * of the document it is written into. The trailing newline matches the
 * envelope `server.js` sends and keeps command-line output readable; it is
 * insignificant whitespace to any JSON parser.
 *
 * @param {import('node:http').ServerResponse} res The response.
 * @param {number} statusCode The status to send.
 * @param {unknown} payload A JSON-serializable value.
 * @param {Record<string, string>} [extraHeaders] Headers beyond the content
 *   type.
 * @returns {void}
 */
function sendJson(res, statusCode, payload, extraHeaders) {
  send(res, statusCode, CONTENT_TYPE_JSON, `${JSON.stringify(payload)}\n`, extraHeaders);
}

/**
 * Sends an HTML document.
 *
 * @param {import('node:http').ServerResponse} res The response.
 * @param {number} statusCode The status to send.
 * @param {string} markup A complete document, already escaped.
 * @param {Record<string, string>} [extraHeaders] Headers beyond the content
 *   type.
 * @returns {void}
 */
function sendHtml(res, statusCode, markup, extraHeaders) {
  send(res, statusCode, CONTENT_TYPE_HTML, markup, extraHeaders);
}

/**
 * Sends the two-key error envelope.
 *
 * The body is exactly `error` and `message` — no third key, and in particular
 * no echo of the submitted Student ID, so one shape covers every failure and
 * nothing a client sent is reflected back at it.
 *
 * @param {import('node:http').ServerResponse} res The response.
 * @param {{status: number, code: string, message: string}} outcome The failure.
 * @param {Record<string, string>} [extraHeaders] Headers beyond the content
 *   type, such as `Allow` on a 405.
 * @returns {void}
 */
function sendFailure(res, outcome, extraHeaders) {
  sendJson(res, outcome.status, { error: outcome.code, message: outcome.message }, extraHeaders);
}

/**
 * Discards whatever remains of a request body.
 *
 * Called on the paths that answer without reading the body — an unaccepted
 * media type, a method the route refuses. `resume` with no `data` listener
 * attached throws the bytes away as they arrive, at bounded memory, which lets
 * the connection close cleanly instead of the peer seeing a reset while it is
 * still writing.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @returns {void}
 */
function drain(req) {
  req.resume();
}

/* ------------------------------------------------------------------------- *
 * The namespace boundary
 *
 * This is the single most consequential predicate in the feature. Everything
 * outside it must behave exactly as it did before this feature existed, and a
 * loose test is how that promise quietly stops being true.
 * ------------------------------------------------------------------------- */

const ROUTE_OUTSIDE = 'outside';
const ROUTE_COLLECTION = 'collection';
const ROUTE_ITEM = 'item';
const ROUTE_UNRESOLVED = 'unresolved';

/**
 * Reduces a request target to the pathname the route table is matched against.
 *
 * Two normalizations, both deliberate:
 *
 *   1. The pathname is read from a parsed `URL`, so the query string and any
 *      fragment are gone before matching. A `startsWith` against the raw
 *      `req.url` would misclassify `/activities?x=1` as a sub-resource named
 *      `?x=1`.
 *   2. A single trailing slash is stripped, so `/activities/` is `/activities`
 *      and `/activities/S001/` is `/activities/S001`. The root `/` keeps its
 *      slash: stripping it would leave the empty string, which matches nothing
 *      here anyway, but a pathname that no longer starts with `/` is a
 *      surprise waiting for the next reader.
 *
 * An unparseable target is answered `null`, which the caller treats as outside
 * the namespace. That is the conservative direction: a request this module
 * cannot even name is left to behave exactly as it did before the feature
 * existed. In practice the runtime rejects a malformed request line with its
 * own 400 before a handler runs, so this is a floor rather than a path.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @returns {string|null} The normalized pathname, or `null` when the target
 *   cannot be parsed.
 */
function requestPathname(req) {
  const target = req.url;
  if (typeof target !== 'string' || target.length === 0) {
    return null;
  }

  let pathname;
  try {
    pathname = new URL(target, PATH_RESOLUTION_BASE).pathname;
  } catch {
    return null;
  }

  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * Decodes one path segment, tolerating a segment that is not valid
 * percent-encoding.
 *
 * `decodeURIComponent` throws `URIError` on a stray `%`, and an uncaught throw
 * in the request path is the hung-request failure this feature is careful to
 * avoid. A segment that cannot be decoded is used as it arrived, where it
 * fails the Student ID shape test and is answered `400 student_id_malformed` —
 * which is the truth about it.
 *
 * @param {string} segment The raw path segment.
 * @returns {string} The decoded segment, or the raw one when it will not
 *   decode.
 */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Resolves a normalized pathname to a route.
 *
 * The predicate is segment-safe: the request belongs to this feature only when
 * the pathname EQUALS `/activities` or BEGINS WITH `/activities/`. A path that
 * merely shares those characters as text — `/activities-old`,
 * `/activitieslist` — does not, and is answered `ROUTE_OUTSIDE` so the caller
 * falls through to the response it has always given.
 *
 * Resolution is by PATH ONLY; the method is not consulted here. That ordering
 * is why `DELETE /activities/S001/extra` is a `404` and not a `405`: a `405`
 * carrying `Allow` would assert that the resource exists and merely refuses
 * that verb, and no resource exists at that path under any verb.
 *
 * @param {string} pathname A pathname from `requestPathname`.
 * @returns {{kind: string, studentId?: string}} `ROUTE_COLLECTION` for the
 *   namespace root, `ROUTE_ITEM` with the single addressed segment,
 *   `ROUTE_UNRESOLVED` for a path inside the namespace that names no route, or
 *   `ROUTE_OUTSIDE`.
 */
function resolveRoute(pathname) {
  if (pathname === NAMESPACE_PATH) {
    return { kind: ROUTE_COLLECTION };
  }

  if (!pathname.startsWith(NAMESPACE_PREFIX)) {
    return { kind: ROUTE_OUTSIDE };
  }

  const remainder = pathname.slice(NAMESPACE_PREFIX.length);
  if (remainder.length === 0 || remainder.includes('/')) {
    return { kind: ROUTE_UNRESOLVED };
  }

  return { kind: ROUTE_ITEM, studentId: decodeSegment(remainder) };
}

/* ------------------------------------------------------------------------- *
 * The request media type
 * ------------------------------------------------------------------------- */

/**
 * Reads the request's media type in comparable form.
 *
 * Normalized before comparison — parameters split off at the first `;`,
 * surrounding space trimmed, lowercased — so `application/json`,
 * `Application/JSON` and `application/json; charset=utf-8` all match, as do
 * the equivalent forms of `application/x-www-form-urlencoded`. A browser form
 * sends a charset parameter, so a comparison against the raw header would
 * reject the very client this feature is built for.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @returns {string|null} The bare media type, or `null` when the header is
 *   absent or empty.
 */
function requestMediaType(req) {
  const header = req.headers['content-type'];
  if (typeof header !== 'string') {
    return null;
  }

  const semicolon = header.indexOf(';');
  const mediaType = (semicolon === -1 ? header : header.slice(0, semicolon)).trim().toLowerCase();

  return mediaType.length === 0 ? null : mediaType;
}

/**
 * Chooses the submission mode from the request media type.
 *
 * A MISSING `Content-Type` is treated exactly like an unaccepted one: this
 * endpoint refuses rather than guessing at a body's format, because guessing
 * wrong turns a client's mistake into a stored value nobody intended.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @returns {string|null} `MODE_FORM`, `MODE_JSON`, or `null` when the media
 *   type is absent or unaccepted.
 */
function submissionMode(req) {
  const mediaType = requestMediaType(req);
  if (mediaType === MEDIA_TYPE_FORM) {
    return MODE_FORM;
  }
  if (mediaType === MEDIA_TYPE_JSON) {
    return MODE_JSON;
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Reading the request body
 *
 * The obvious implementation of a size limit CRASHES THE PROCESS, so the shape
 * below is prescribed rather than preferred. Two measured failures it avoids:
 *
 *   Writing the 413 from inside the `data` handler and then continuing to
 *   receive chunks throws ERR_HTTP_HEADERS_SENT on the next chunk and
 *   terminates the process — reproduced with a 200 KB body.
 *
 *   Calling `req.destroy()` on exceeding the limit makes the client observe a
 *   connection reset and never see the 413 at all, so the one thing the limit
 *   was supposed to communicate is the one thing that does not arrive.
 *
 * What works, verified against bodies of 8192 B, 9000 B, 200 KB and 5 MB with
 * the process surviving every one: stop accumulating, detach the listener,
 * drain the remainder so the socket closes cleanly, and reject exactly once.
 * The response is then written by the caller from the rejection path alone,
 * where `send`'s guard makes a second write impossible.
 * ------------------------------------------------------------------------- */

/**
 * Builds one of the two internal body-read signals.
 *
 * @param {string} code `SIGNAL_BODY_TOO_LARGE` or
 *   `SIGNAL_REQUEST_STREAM_FAILED`.
 * @param {string} message A description for a log, never for a client.
 * @param {unknown} [cause] The underlying error, when there is one.
 * @returns {Error} An error carrying `code`.
 */
function signal(code, message, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

/**
 * Reads the request body as UTF-8 text, refusing anything over the limit.
 *
 * The limit is INCLUSIVE: a body of exactly `MAX_BODY_BYTES` resolves, one byte
 * more rejects. Counting is in BYTES, taken from the buffer chunks as they
 * arrive rather than from the `Content-Length` header, because a header can
 * disagree with what is actually sent and only the bytes cost memory.
 *
 * @param {import('node:http').IncomingMessage} req The request, a Readable.
 * @returns {Promise<string>} The body as text.
 * @throws {Error} `SIGNAL_BODY_TOO_LARGE` when the limit is exceeded, or
 *   `SIGNAL_REQUEST_STREAM_FAILED` when the request stream fails.
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    let done = false;

    function detach() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    }

    function onData(chunk) {
      if (done) {
        return;
      }

      receivedBytes += chunk.length;
      if (receivedBytes > MAX_BODY_BYTES) {
        done = true;
        detach();
        drain(req);
        reject(
          signal(
            SIGNAL_BODY_TOO_LARGE,
            `activities: request body exceeded ${MAX_BODY_BYTES} bytes`
          )
        );
        return;
      }

      chunks.push(chunk);
    }

    function onEnd() {
      if (done) {
        return;
      }
      done = true;
      detach();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }

    function onError(cause) {
      if (done) {
        return;
      }
      done = true;
      detach();
      reject(signal(SIGNAL_REQUEST_STREAM_FAILED, 'activities: request stream failed', cause));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}


/* ------------------------------------------------------------------------- *
 * Reading the submitted fields
 *
 * A form body always yields strings. A JSON body yields whatever was sent:
 * the top level may be `null`, an array or a number, and a field may be a
 * number, an object or `null`. Calling `.trim()` or a regex test on any of
 * those THROWS, and an uncaught throw in the request path leaves the client
 * with no response at all — the request hangs until its own timeout. So the
 * two shapes are read into one candidate here and typed afterwards, in the
 * order the validation demands.
 * ------------------------------------------------------------------------- */

/** The values to pre-fill when a failure happened before any field was read. */
const EMPTY_SUBMISSION = Object.freeze({ studentId: '', activity: '' });

/**
 * Tests whether a thrown value carries a particular code.
 *
 * @param {unknown} value The value thrown.
 * @param {string} code The code to test for.
 * @returns {boolean} True only for an object carrying exactly that code.
 */
function hasCode(value, code) {
  return value !== null && typeof value === 'object' && value.code === code;
}

/**
 * A value's form-field representation.
 *
 * Only a string can be re-displayed in an input. A number or an object came
 * from a JSON submission, which is answered in JSON and never re-renders the
 * form, so the empty string is never actually shown for one of them — it
 * simply guarantees that nothing but text reaches the markup.
 *
 * @param {unknown} value The submitted value.
 * @returns {string} The value if it is a string, otherwise `''`.
 */
function displayValue(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Reads a form-encoded body.
 *
 * `URLSearchParams` accepts any string and never throws, which is why
 * `malformed_json` and `body_not_an_object` are unreachable in form mode.
 * Presence is the KEY being present: `studentId=` sends an empty value, which
 * is present but malformed, and is a different mistake from omitting the field
 * altogether.
 *
 * @param {string} body The raw body text.
 * @returns {{studentIdPresent: boolean, studentIdValue: unknown, activityPresent: boolean, activityValue: unknown}}
 *   The candidate fields, untyped and unvalidated.
 */
function readFormFields(body) {
  const params = new URLSearchParams(body);
  return {
    studentIdPresent: params.has(FIELD_STUDENT_ID),
    studentIdValue: params.get(FIELD_STUDENT_ID),
    activityPresent: params.has(FIELD_ACTIVITY),
    activityValue: params.get(FIELD_ACTIVITY),
  };
}

/**
 * Parses a body into candidate fields, or reports why it cannot be.
 *
 * The two structural refusals happen here, before any field is looked at:
 * a body that is not JSON at all, and a body that is JSON but not an object.
 * A JSON array of submissions is refused rather than interpreted, because this
 * endpoint records one activity per request and quietly taking the first
 * element would discard the rest without saying so.
 *
 * @param {string} body The raw body text.
 * @param {string} mode `MODE_FORM` or `MODE_JSON`.
 * @returns {{ok: true, candidate: object}|{ok: false, outcome: {status: number, code: string, message: string}}}
 *   The candidate fields, or the structural failure.
 */
function parseSubmission(body, mode) {
  if (mode === MODE_FORM) {
    return { ok: true, candidate: readFormFields(body) };
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, outcome: FAILURES.MALFORMED_JSON };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, outcome: FAILURES.BODY_NOT_AN_OBJECT };
  }

  const studentIdValue = parsed[FIELD_STUDENT_ID];
  const activityValue = parsed[FIELD_ACTIVITY];

  return {
    ok: true,
    candidate: {
      studentIdPresent: studentIdValue !== undefined && studentIdValue !== null,
      studentIdValue,
      activityPresent: activityValue !== undefined && activityValue !== null,
      activityValue,
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Validation — the order is load-bearing
 *
 * For each field: presence, then type, then format. Then, once BOTH fields
 * have passed all three, existence.
 *
 * Presence precedes type so that an omitted `studentId` is
 * `student_id_required` while a `studentId` of `123` is
 * `student_id_malformed` — two different mistakes, told apart. No string
 * operation runs until the type check has passed, which is what keeps a
 * numeric or object field from throwing instead of being answered.
 *
 * Existence is last because it is the only check that reads a workbook, and
 * because a submission that is malformed in two ways should be told about the
 * malformed part first: `student_not_found` on a request whose activity was
 * also invalid would send a submitter chasing the wrong field.
 *
 * The 400-versus-404 split is deliberate throughout. A syntactically wrong
 * identifier is a malformed REQUEST; a well-formed identifier naming no
 * student is a reference to a parent that does not exist. Keeping them apart
 * tells a submitter which of the two mistakes they made.
 *
 * All of this runs BEFORE `addActivity` is called. No schema file, no key
 * declaration and no workbook data-validation part exists anywhere in this
 * repository, and JSON offers no constraint mechanism either, so this is the
 * only place the link between an activity and a student can be enforced.
 * There is no second line of defence.
 * ------------------------------------------------------------------------- */

/**
 * Builds a validation refusal.
 *
 * @param {{status: number, code: string, message: string}} outcome The failure.
 * @param {string} invalidField The field to flag on a re-rendered form.
 * @returns {{ok: false, outcome: object, invalidField: string}} The refusal.
 */
function invalid(outcome, invalidField) {
  return { ok: false, outcome, invalidField };
}

/**
 * Validates the candidate fields in the documented order.
 *
 * Normalization is delegated to `activity-store.js`, which owns the rules and
 * checks the length bound after normalizing rather than before — no label
 * processing happens in this file.
 *
 * @param {{studentIdPresent: boolean, studentIdValue: unknown, activityPresent: boolean, activityValue: unknown}} candidate
 *   The fields as read from the body.
 * @returns {{ok: true, studentId: string, activity: string}|{ok: false, outcome: object, invalidField: string}}
 *   The validated pair, or the first failure found.
 * @throws {Error} `E_REFERENCE_DATA` when the key set cannot be read, which
 *   the caller maps to a 500. A label refusal is returned rather than thrown.
 */
function validateSubmission(candidate) {
  if (!candidate.studentIdPresent) {
    return invalid(FAILURES.STUDENT_ID_REQUIRED, FIELD_STUDENT_ID);
  }
  if (typeof candidate.studentIdValue !== 'string') {
    return invalid(FAILURES.STUDENT_ID_MALFORMED, FIELD_STUDENT_ID);
  }
  const studentId = candidate.studentIdValue;
  if (!STUDENT_ID_PATTERN.test(studentId)) {
    return invalid(FAILURES.STUDENT_ID_MALFORMED, FIELD_STUDENT_ID);
  }

  if (!candidate.activityPresent) {
    return invalid(FAILURES.ACTIVITY_INVALID, FIELD_ACTIVITY);
  }
  if (typeof candidate.activityValue !== 'string') {
    return invalid(FAILURES.ACTIVITY_INVALID, FIELD_ACTIVITY);
  }

  let activity;
  try {
    activity = store.normalizeLabel(candidate.activityValue);
  } catch (error) {
    const mapped = storeFailureFor(error);
    if (mapped === null) {
      throw error;
    }
    return invalid(mapped, FIELD_ACTIVITY);
  }

  if (!store.isKnownStudent(studentId)) {
    return invalid(FAILURES.STUDENT_NOT_FOUND, FIELD_STUDENT_ID);
  }

  return { ok: true, studentId, activity };
}

/* ------------------------------------------------------------------------- *
 * Answering
 * ------------------------------------------------------------------------- */

/**
 * Answers a failure in the mode the request arrived in.
 *
 * A form submitter gets the form back with the offending field flagged, but
 * only for the outcomes retyping can fix. Everything else is the JSON envelope
 * in both modes: 413 and 415 are settled before the body's format is known, a
 * 405 answers a method the client chose, an unresolved path has no form
 * context, and a 500 is a fault no correction addresses.
 *
 * @param {import('node:http').ServerResponse} res The response.
 * @param {string} mode `MODE_FORM` or `MODE_JSON`.
 * @param {{status: number, code: string, message: string}} outcome The failure.
 * @param {{studentId: string, activity: string}} submitted Values to pre-fill.
 * @param {string|null} invalidField The field to flag, when there is one.
 * @returns {void}
 */
function respondToFailure(res, mode, outcome, submitted, invalidField) {
  if (mode === MODE_FORM && FORM_RENDERABLE_CODES.has(outcome.code)) {
    sendHtml(res, outcome.status, renderFailure(outcome, submitted, invalidField));
    return;
  }
  sendFailure(res, outcome);
}

/**
 * Answers a successful submission.
 *
 * `201` means a record was appended and persisted; `200` means an identical
 * one already existed and the store was not touched. The distinction is
 * carried by the status code, which is what makes idempotency observable from
 * outside the process rather than something a caller has to infer.
 *
 * `Location` is sent only with the `201`, and its interpolated Student ID has
 * already matched `/^S\d{3}$/`, so no submitted text can reach a header.
 *
 * @param {import('node:http').ServerResponse} res The response.
 * @param {string} mode `MODE_FORM` or `MODE_JSON`.
 * @param {boolean} created Whether a record was appended.
 * @param {{studentId: string, activity: string, source: string, submittedAt?: string}} record
 *   The record as the store returned it. A seeded record carries
 *   `source: "workbook"` and no `submittedAt`, and is passed through as-is.
 * @returns {void}
 */
function respondToOutcome(res, mode, created, record) {
  const status = created ? 201 : 200;
  const headers = created ? { Location: `${NAMESPACE_PREFIX}${record.studentId}` } : undefined;

  if (mode === MODE_FORM) {
    sendHtml(res, status, renderOutcome(created, record), headers);
    return;
  }
  sendJson(res, status, { created, record }, headers);
}

/* ------------------------------------------------------------------------- *
 * The routes
 * ------------------------------------------------------------------------- */

/**
 * `POST /activities` — accept a submission.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @param {import('node:http').ServerResponse} res The response.
 * @returns {Promise<void>} Resolves once the response has been written.
 * @throws {Error} A store refusal, which `handle` maps to a 500.
 */
async function handleSubmission(req, res) {
  const mode = submissionMode(req);
  if (mode === null) {
    sendFailure(res, FAILURES.UNSUPPORTED_MEDIA_TYPE);
    drain(req);
    return;
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch (error) {
    if (hasCode(error, SIGNAL_BODY_TOO_LARGE)) {
      // The one place a 413 is written, and the reason the body reader rejects
      // instead of responding: here the response is written exactly once, and
      // `send`'s guard means a chunk still in flight cannot touch `res`.
      sendFailure(res, FAILURES.PAYLOAD_TOO_LARGE);
      return;
    }
    if (hasCode(error, SIGNAL_REQUEST_STREAM_FAILED)) {
      // The client went away mid-body. There is no socket left to answer on,
      // so the request is claimed and closed without a response — inventing a
      // status here would only be written into a void.
      return;
    }
    throw error;
  }

  const parsed = parseSubmission(body, mode);
  if (!parsed.ok) {
    respondToFailure(res, mode, parsed.outcome, EMPTY_SUBMISSION, null);
    return;
  }

  const submitted = {
    studentId: displayValue(parsed.candidate.studentIdValue),
    activity: displayValue(parsed.candidate.activityValue),
  };

  const validated = validateSubmission(parsed.candidate);
  if (!validated.ok) {
    respondToFailure(res, mode, validated.outcome, submitted, validated.invalidField);
    return;
  }

  const { created, record } = await store.addActivity(validated.studentId, validated.activity);
  respondToOutcome(res, mode, created, record);
}

/**
 * `/activities` — the namespace root: the form, and submissions to it.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @param {import('node:http').ServerResponse} res The response.
 * @returns {Promise<void>} Resolves once the response has been written.
 * @throws {Error} A store refusal, which `handle` maps to a 500.
 */
async function handleCollection(req, res) {
  if (req.method === METHOD_GET) {
    sendHtml(res, 200, renderEmptyForm());
    return;
  }

  if (req.method === METHOD_POST) {
    await handleSubmission(req, res);
    return;
  }

  sendFailure(res, FAILURES.METHOD_NOT_ALLOWED, { Allow: ALLOW_COLLECTION });
  drain(req);
}

/**
 * `GET /activities/{studentId}` — one student's activities.
 *
 * JSON only: this route never renders HTML, in either request mode, because
 * there is no form for a read to re-display.
 *
 * The Student ID is validated exactly as a submission's is — same shape test,
 * same key-set lookup, same 400-versus-404 split — so an identifier behaves
 * identically whichever route it arrives on. Reading has no write side effect:
 * when the store does not exist, the store answers from the workbook seed and
 * no file is created.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @param {import('node:http').ServerResponse} res The response.
 * @param {string} studentId The addressed path segment, decoded.
 * @returns {Promise<void>} Resolves once the response has been written.
 * @throws {Error} A store refusal, which `handle` maps to a 500.
 */
async function handleItem(req, res, studentId) {
  if (req.method !== METHOD_GET) {
    sendFailure(res, FAILURES.METHOD_NOT_ALLOWED, { Allow: ALLOW_ITEM });
    drain(req);
    return;
  }

  if (!STUDENT_ID_PATTERN.test(studentId)) {
    sendFailure(res, FAILURES.STUDENT_ID_MALFORMED);
    return;
  }

  if (!store.isKnownStudent(studentId)) {
    sendFailure(res, FAILURES.STUDENT_NOT_FOUND);
    return;
  }

  const activities = await store.listActivities(studentId);
  sendJson(res, 200, { studentId, activities });
}

/* ------------------------------------------------------------------------- *
 * The integration surface
 * ------------------------------------------------------------------------- */

/**
 * Handles a request if, and only if, it belongs to the `/activities`
 * namespace.
 *
 * The return value is the entire contract with `server.js`:
 *
 *   `true`  — this module claimed the request and has answered it. The caller
 *             returns immediately and writes nothing further.
 *   `false` — the path lies outside the namespace. NOTHING has been written to
 *             `res`, not a status and not a header, so the caller's own
 *             response is exactly what it always was.
 *
 * Route resolution happens before the method is considered, and both happen
 * before any I/O. Every store refusal is mapped to its own status here; a
 * fault the store does not declare is rethrown deliberately, so the rejection
 * boundary in `server.js` owns it and answers `internal_error`. Swallowing it
 * into some nearest-fitting code would report a failure that did not happen.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @param {import('node:http').ServerResponse} res The response.
 * @returns {Promise<boolean>} True when the request was claimed and answered.
 * @throws {Error} Only a fault outside the store's declared vocabulary, for
 *   the caller's rejection boundary to handle.
 */
async function handle(req, res) {
  const pathname = requestPathname(req);
  if (pathname === null) {
    return false;
  }

  const route = resolveRoute(pathname);
  if (route.kind === ROUTE_OUTSIDE) {
    return false;
  }

  try {
    if (route.kind === ROUTE_COLLECTION) {
      await handleCollection(req, res);
    } else if (route.kind === ROUTE_ITEM) {
      await handleItem(req, res, route.studentId);
    } else {
      // Inside the namespace, but naming no route — `/activities/S001/extra`.
      // A 404 rather than a 405: an `Allow` header would assert the resource
      // exists and merely refuses the verb, and nothing exists here.
      sendFailure(res, FAILURES.NOT_FOUND);
      drain(req);
    }
  } catch (error) {
    const mapped = storeFailureFor(error);
    if (mapped === null) {
      throw error;
    }
    sendFailure(res, mapped);
  }

  return true;
}

module.exports = { handle };

