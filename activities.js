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
 * Usage, from `server.js`. The call belongs INSIDE an asynchronous request
 * handler: `handle` is async, so the `await` and the early `return` below are
 * only legal there, and the example is written out in full because a fragment
 * of it does not parse on its own. `server.js` additionally wraps the call in
 * the rejection boundary that owns `internal_error`, which is not reproduced
 * here — that boundary is its contract, not this module's.
 *
 *   const http = require('node:http');
 *   const activities = require('./activities');
 *
 *   const server = http.createServer(async (req, res) => {
 *     if (await activities.handle(req, res)) {
 *       return;                                     // claimed and answered
 *     }
 *     res.statusCode = 200;                         // a path this module
 *     res.setHeader('Content-Type', 'text/plain');  // declined, answered
 *     res.end('Hello, World Welcome to Sharebot!\n'); // exactly as before
 *   });
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
  /**
   * A submission a browser was made to send from somewhere other than this
   * service's own form. `403` rather than `400`: the request is perfectly
   * well-formed, and what is refused is the authority to act on it, which is
   * exactly the distinction the 400-versus-404 split already draws elsewhere
   * in this vocabulary. The sentence names the remedy without naming the
   * offending origin, so nothing a client sent is reflected back at it.
   */
  CROSS_ORIGIN_SUBMISSION: failure(
    403,
    'cross_origin_submission',
    "A submission must be sent from this service's own form, not from another origin."
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
 *
 * The input border is written as `border-color` and not as the `border`
 * shorthand for the same reason. The inventory authorizes ONE value for it —
 * the colour `#767676` — so a shorthand would smuggle in a width literal and
 * a style keyword that the inventory does not list, and an unlisted literal is
 * a deviation from the specified design values whether or not it looks
 * reasonable. The border still renders: a browser's own default supplies the
 * width and the style for a text input, and this declaration recolours them.
 * Measured in headless Chrome, the computed result is `border-color`
 * `rgb(118, 118, 118)` — exactly `#767676` — over the user agent's own
 * `2px inset`, so the specified colour is what a reader sees without this
 * stylesheet asserting a width or a style it was never given.
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
        border-color: #767676;
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
 * The message element's stable id, and the target of the `aria-describedby`
 * below. Fixed rather than generated: there is exactly one message on the page
 * at a time, and a stable id is what lets an input point at it.
 */
const MESSAGE_ELEMENT_ID = 'form-message';

/**
 * Marks the field a validation failure was about, and binds it to the reason.
 *
 * Two attributes, and both are needed. `aria-invalid` says THAT the field is
 * wrong; `aria-describedby` says WHY, by naming the message element. Without
 * the second one the reason is announced only to a reader who happens to
 * traverse the whole document — a screen-reader user who tabs straight to the
 * flagged field hears "invalid" and nothing else, even though the sentence
 * explaining it is a few nodes away. The position of the message in the
 * document therefore stops mattering, which is why it can stay above the form
 * where a sighted reader sees it first.
 *
 * Only the OFFENDING field is described. Pointing every input at the same
 * message would announce a Student ID error while the activity field was
 * focused, which is worse than saying nothing.
 *
 * Both are accessibility attributes rather than styling or script, so the
 * association costs no CSS declaration and no client-side code. The reference
 * cannot dangle: `invalidField` is non-null only on the failure page, which
 * always renders a message with this id.
 *
 * @param {string|null} invalidField The offending field name, or `null`.
 * @param {string} fieldName The field being rendered.
 * @returns {string} The attributes to splice in, or `''`.
 */
function invalidAttribute(invalidField, fieldName) {
  return invalidField === fieldName
    ? ` aria-invalid="true" aria-describedby="${MESSAGE_ELEMENT_ID}"`
    : '';
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
      : `    <p id="${MESSAGE_ELEMENT_ID}" class="${messageClass}">${escapeHtml(view.message)}</p>\n`;

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
 * Reading a header that must be declared exactly once
 *
 * `req.headers` is a CONVENIENCE, and for the headers this module makes
 * decisions on it is the wrong one. Node's normalized map keeps the FIRST
 * `Content-Type` line and silently discards every later one — measured, not
 * assumed: a request declaring `application/json` and then `text/plain`
 * presents as plain `application/json` there, while `req.headersDistinct`
 * shows both. A decision taken on the collapsed view therefore cannot tell a
 * single unambiguous declaration from two conflicting ones, and answers a
 * request whose meaning was never agreed.
 *
 * So every header this module routes or authorizes on is read through the one
 * primitive below, which reports AMBIGUITY as a state of its own. A header
 * declared twice is refused exactly like one that is absent: the endpoint does
 * not guess which line the sender meant, for the same reason it does not guess
 * at a body's format.
 * ------------------------------------------------------------------------- */

const HEADER_CONTENT_TYPE = 'content-type';
const HEADER_HOST = 'host';
const HEADER_ORIGIN = 'origin';
const HEADER_SEC_FETCH_SITE = 'sec-fetch-site';

/**
 * Reads one header, distinguishing absent from declared-more-than-once.
 *
 * `headersDistinct` is preferred because it preserves every field line.
 * `req.headers` is the fallback for a request object that does not provide it;
 * there, two lines have already been collapsed, so a value that is present but
 * not a string is the only ambiguity still detectable and is treated as one.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @param {string} name The lower-case header name.
 * @returns {{present: boolean, ambiguous: boolean, value: string|null}} Whether
 *   the header was sent at all, whether it was sent more than once, and its
 *   single value when there is exactly one.
 */
function declaration(req, name) {
  const absent = { present: false, ambiguous: false, value: null };
  const ambiguous = { present: true, ambiguous: true, value: null };

  const distinct = req.headersDistinct;
  if (distinct !== null && typeof distinct === 'object') {
    const values = distinct[name];
    if (values === undefined) {
      return absent;
    }
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') {
      return ambiguous;
    }
    return { present: true, ambiguous: false, value: values[0] };
  }

  const value = req.headers[name];
  if (value === undefined) {
    return absent;
  }
  if (typeof value !== 'string') {
    return ambiguous;
  }
  return { present: true, ambiguous: false, value };
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
 * Exactly ONE declaration is required. Zero and two both answer `null`, which
 * the caller turns into `415`: an ambiguous declaration is not a media type
 * this endpoint can honour, and picking the first line would let a sender
 * smuggle a body past the type check the endpoint is supposed to apply.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @returns {string|null} The bare media type, or `null` when the header is
 *   absent, declared more than once, or empty.
 */
function requestMediaType(req) {
  const header = declaration(req, HEADER_CONTENT_TYPE);
  if (!header.present || header.ambiguous) {
    return null;
  }

  const semicolon = header.value.indexOf(';');
  const mediaType = (semicolon === -1 ? header.value : header.value.slice(0, semicolon))
    .trim()
    .toLowerCase();

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
 * Submission intent — the cross-site forgery boundary
 *
 * `POST /activities` changes stored state, and an HTML form can be made to
 * submit across origins: a page on any other site can carry a form whose
 * action is this service and whose encoding is form-urlencoded, and a browser
 * that loads that page will send the request. Media type and field validation
 * cannot tell that request from the real form's, because it IS a real form
 * submission — of somebody else's form. Nothing else in this service stands in
 * the way: there is no authentication, no session, no cookie and no token
 * anywhere in the codebase, and the loopback bind is not a defence here, since
 * the browser making the request is itself on the loopback host.
 *
 * What a browser cannot forge is where it says the request came from. Two
 * headers carry that, both set by the browser and both unreachable from page
 * script, and this is the whole of the check:
 *
 *   `Sec-Fetch-Site`  the browser's own classification. `same-origin` and
 *                     `none` (a user-initiated navigation) are this service's
 *                     own form; `same-site` and `cross-site` are not.
 *   `Origin`          sent on every browser POST. It must parse, it must be
 *                     `http:` — this service speaks no other scheme — and its
 *                     host must equal the host the request was addressed to.
 *                     `Origin: null`, the opaque origin a sandboxed document
 *                     sends, is refused rather than interpreted.
 *
 * Comparing `Origin` against the request's own `Host` is what makes the check
 * work on any port, including the ephemeral one the endpoint suite binds, and
 * it is sound precisely because an attacker's page controls the first and the
 * browser controls the second.
 *
 * A request carrying NEITHER header is ACCEPTED, and that is a decision rather
 * than an oversight. No browser omits `Origin` on a POST, so a request without
 * it is not a browser form submission — it is `curl`, a script, or the test
 * suite, which this service is documented to serve and whose published
 * commands send no such header. The check therefore refuses forged browser
 * submissions without inventing an authentication requirement the service does
 * not have; what it cannot do is establish WHO is submitting, which stays true
 * of this feature exactly as documented.
 * ------------------------------------------------------------------------- */

/** The classifications `Sec-Fetch-Site` may carry for this service's own form. */
const SAME_ORIGIN_FETCH_SITES = new Set(['same-origin', 'none']);

/** The opaque origin. A literal value, never a missing header. */
const OPAQUE_ORIGIN = 'null';

/** The only scheme this service is reachable over, so the only one accepted. */
const SERVICE_SCHEME = 'http:';

/**
 * Decides whether a state-changing request came from this service's own form.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @returns {boolean} True when the request carries no browser origin signal at
 *   all, or carries one that names this service itself.
 */
function isSameOriginSubmission(req) {
  const fetchSite = declaration(req, HEADER_SEC_FETCH_SITE);
  if (fetchSite.present) {
    if (fetchSite.ambiguous || !SAME_ORIGIN_FETCH_SITES.has(fetchSite.value.trim().toLowerCase())) {
      return false;
    }
  }

  const origin = declaration(req, HEADER_ORIGIN);
  if (!origin.present) {
    // No browser sends a POST without this header, so there is no browser to
    // protect here. See the reasoning above.
    return true;
  }
  if (origin.ambiguous) {
    return false;
  }

  const value = origin.value.trim();
  if (value.toLowerCase() === OPAQUE_ORIGIN) {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== SERVICE_SCHEME) {
    return false;
  }

  const host = declaration(req, HEADER_HOST);
  if (!host.present || host.ambiguous) {
    return false;
  }

  return parsed.host.toLowerCase() === host.value.trim().toLowerCase();
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

    /**
     * Stops accumulation without disarming the stream.
     *
     * This is the oversize path's detachment, and the distinction from
     * `detachAll` is the whole of it. `req.resume()` below keeps the stream
     * running — measured on this runtime, an oversize request is answered
     * `413` with `Connection: keep-alive` and the connection then stays open
     * waiting for the rest of a body the sender declared, with the drain still
     * in progress. If the `'error'` listener were removed at that point, a
     * client that reset the connection mid-drain would emit `'error'` on an
     * EventEmitter with no listener for it, which THROWS and takes the process
     * down: the denial of service would be one aborted upload, and the limit
     * meant to bound a request's cost would have become the way to end the
     * service. So `'error'` and `'close'` stay attached until the stream is
     * actually finished.
     */
    function detachAccumulation() {
      req.off('data', onData);
      req.off('end', onEnd);
    }

    /** The terminal detachment, once nothing further can arrive. */
    function detachAll() {
      detachAccumulation();
      req.off('error', onError);
      req.off('close', onClose);
    }

    function onData(chunk) {
      if (done) {
        return;
      }

      receivedBytes += chunk.length;
      if (receivedBytes > MAX_BODY_BYTES) {
        done = true;
        detachAccumulation();
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
      detachAll();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }

    /**
     * Fails the read, or — once `done` — absorbs a fault that arrives too late
     * to change anything.
     *
     * The `done` guard is what makes retaining this listener safe: after the
     * `413` has been rejected, a stream error can neither reject a second time
     * nor touch `res`. It is observed and dropped, which is precisely the job.
     */
    function onError(cause) {
      if (done) {
        return;
      }
      done = true;
      detachAll();
      reject(signal(SIGNAL_REQUEST_STREAM_FAILED, 'activities: request stream failed', cause));
    }

    /**
     * Removes what the oversize path left attached.
     *
     * `'close'` is emitted once the request is complete or destroyed, whichever
     * way the drain ended, so this is the one place that can clean up after a
     * read that rejected while the stream was still live.
     */
    function onClose() {
      detachAll();
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
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
 * Server-side failure evidence
 *
 * Two faults in this file are invisible from outside the process unless they
 * are written down, and until they were, both left NO server evidence at all.
 * A `500` told its client which of the four codes applied and told the
 * operator nothing, so `reference_data_unavailable`, `store_unreadable` and
 * `store_write_failed` were indistinguishable after the fact, and the five
 * ways the workbook reader can refuse a package were indistinguishable from
 * each other. A request whose stream died mid-body left nothing whatsoever.
 *
 * WHAT MAY BE LOGGED IS AN ALLOW-LIST, NEVER A MESSAGE. `activity-store.js`
 * and `xlsx-read.js` deliberately put the offending detail in their `message`
 * — a workbook path, the configured store path, a stored record's Student ID,
 * an activity label — because that detail belongs in a diagnosis and not in a
 * response. Copying one of those messages into a log would move exactly the
 * data this feature refuses to reflect to a client into a file that outlives
 * the request. So the message, the `cause` chain and the `Error` object itself
 * are all excluded here by construction: every field below is either a
 * constant of this module or the output of a sanitizer, and a nested code is
 * emitted only if it is one of the codes named below.
 *
 * The finer distinctions survive anyway, and the way they do is the delicate
 * part. `store_unreadable` covers a dozen different faults, and a log that
 * could not tell "the document declares the wrong schema version" from "the
 * record at index 4 has a source nobody recognises" would leave an operator
 * exactly where no log at all leaves them. So each refusal is CLASSIFIED: its
 * message is tested against a fixed table of anchor phrases, and what gets
 * emitted is the TOKEN THIS FILE HOLDS for the matching phrase — never any
 * part of the message itself. Two bounded integers travel with it, parsed from
 * strictly delimited digit groups: the record index or workbook row a refusal
 * names, and the ZIP compression method or flag bits the reader rejected. An
 * array position and a compression method are positions and numbers; neither
 * is a Student ID, a label, or a path, and no other value is ever extracted.
 *
 * A refusal the table does not recognise is `unclassified`, which is the
 * failure mode worth having: it loses specificity and cannot leak anything.
 * The classifier also looks one level down the `cause` chain, because the store
 * wraps a reader refusal in its own generic sentence — without that step, an
 * unsupported compression method and a missing part would both read as
 * "a workbook column could not be read".
 *
 * The anchors couple this file to wording that lives in two modules it does
 * not own. That coupling is deliberate and is held in place by tests: the
 * endpoint suite induces representative refusals and asserts the tokens, so a
 * rewording upstream fails a test here rather than quietly degrading every
 * future log line to `unclassified`. The alternative — structured properties
 * attached at each `throw` site in `activity-store.js` and `xlsx-read.js` —
 * would be a better home for this and is a change to those modules.
 * ------------------------------------------------------------------------- */

/** The store or reader refused, and the refusal became one of the 500s. */
const EVENT_STORE_FAILURE = 'store_failure';

/** A request's own stream failed while its body was being read. */
const EVENT_REQUEST_STREAM_FAILED = 'request_stream_failed';

/**
 * The only nested codes that may be logged, by name.
 *
 * Nothing reaches a log by matching a shape or a pattern: a code is emitted
 * only if it is literally one of these. Anything else — including a code some
 * future module invents — is reported as unclassified, so the allow-list can
 * never be widened by accident.
 */
const LOGGABLE_DETAIL_CODES = new Set([
  // `xlsx-read.js` — the five refusals that define its supported subset, and
  // the distinction this log exists to preserve.
  'E_XLSX_UNSUPPORTED_COMPRESSION',
  'E_XLSX_UNSUPPORTED_FLAGS',
  'E_XLSX_PART_NOT_FOUND',
  'E_XLSX_SHARED_STRINGS_UNSUPPORTED',
  'E_XLSX_TRUNCATED',
  // `activity-store.js` — its four declared codes, for a refusal nested
  // inside another.
  'E_REFERENCE_DATA',
  'E_LABEL_INVALID',
  'E_STORE_UNREADABLE',
  'E_STORE_WRITE_FAILED',
  // The system errno a filesystem or socket fault arrives as. This is the
  // difference between "the store could not be written" and knowing whether
  // the directory was missing, read-only, or full.
  'EACCES',
  'EBUSY',
  'ECONNABORTED',
  'ECONNRESET',
  'EEXIST',
  'EIO',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENAMETOOLONG',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EPIPE',
  'EROFS',
  'ETIMEDOUT',
  'EXDEV',
]);

/** There was no underlying fault to name. */
const DETAIL_NONE = 'none';

/** There was one, and it is not on the allow-list. */
const DETAIL_UNCLASSIFIED = 'unclassified';

/**
 * The refusal classification table: an anchor phrase, and the token this file
 * emits when a message contains it.
 *
 * ONLY THE TOKEN IS EMITTED. The anchor is a search needle and never appears
 * in output, so a message's surrounding text — a path, a Student ID, a label —
 * has no route into a log line.
 *
 * Order is significant: the first match wins, so a specific phrase must precede
 * a general one that also matches it. Three pairs depend on that, and each is
 * marked where it sits. The anchors are the fixed prose of the refusals raised
 * by `activity-store.js` and `xlsx-read.js`; the interpolated values in those
 * sentences are deliberately outside every anchor.
 */
const REFUSAL_REASONS = Object.freeze([
  /* The workbook reader's own refusals, which reach here through the store's
   * wrapper and are recovered from the `cause` chain. */
  ['uses compression method ', 'zip_compression_method'],
  ['sets general-purpose bit flag 0x', 'zip_general_purpose_flag'],
  ['is a shared-string reference', 'cell_shared_string'],
  ['has no part named ', 'package_part_missing'],
  ['does not begin with a ZIP local file header', 'package_not_a_zip'],
  ['ends inside the local file header at offset', 'zip_header_truncated'],
  ['ends inside the entry name at offset', 'zip_entry_name_truncated'],
  ['but the file is', 'zip_entry_out_of_range'],
  ['trailing byte(s) at offset', 'zip_trailing_bytes'],
  ['ends inside the value of attribute', 'xml_attribute_truncated'],
  ['ends inside the <', 'xml_start_tag_truncated'],
  ['ends before the closing', 'xml_closing_tag_missing'],

  /* The store document as a whole. `exists but could not be read` precedes the
   * reference data's `could not be read (` below, which it would otherwise
   * match. */
  ['does not hold parseable JSON', 'store_json_unparseable'],
  ['is not valid UTF-8', 'store_not_utf8'],
  ['exists but could not be read', 'store_file_unreadable'],
  ['must hold a JSON object', 'store_not_an_object'],
  ['declares a schemaVersion of', 'store_schema_version'],
  ['must hold an activities array', 'store_activities_not_an_array'],
  ['share the composite key', 'store_duplicate_composite_key'],

  /* One record inside the store. `names studentId` precedes the seed's
   * `which is absent from the key set in`, which it would otherwise match. */
  ['must be an object; it is', 'record_not_an_object'],
  ['has a studentId of', 'record_student_id_malformed'],
  ['names studentId', 'record_student_id_unknown'],
  ['has a label that', 'record_label_invalid'],
  ['has the label', 'record_label_not_normalized'],
  ['has a source of', 'record_source_unrecognised'],
  ['whose submittedAt is', 'record_submitted_at_invalid'],
  ['carries submittedAt', 'record_submitted_at_on_seeded'],

  /* The workbooks as reference data. `could not be written (` precedes
   * `could not be read (` only for readability; the two cannot collide. */
  ['could not be written (', 'store_write_refused'],
  ['where a Student ID of the form S000 was expected', 'key_not_a_student_id'],
  ['repeats Student ID', 'key_repeated'],
  ['holds no Student ID', 'key_set_empty'],
  ['which is absent from the key set in', 'seed_student_unknown'],
  ['record the same activity for', 'seed_activity_duplicated'],
  ['the activity in row ', 'seed_label_invalid'],
  ['could not be read (', 'workbook_column_unreadable'],

  /* A submitted label the store re-inspected. Answered 400, so never logged
   * from the mapping boundary; present so the table is complete. */
  ['the activity label ', 'submitted_label_invalid'],
]);

/** The generic wrapper the store puts around a reader refusal. */
const REASON_WRAPPER = 'workbook_column_unreadable';

/** No anchor matched. */
const REASON_UNCLASSIFIED = 'unclassified';

/**
 * Where a refusal says the fault is: a record index, or a workbook row.
 *
 * Each pattern delimits its digits on both sides and caps them at six, so a
 * match is a position and cannot run into an interpolated value. The
 * duplicate-key refusal names two positions; the first is taken, which is the
 * one an operator edits first.
 */
const POSITION_PATTERNS = Object.freeze([
  /\bat index (\d{1,6})\b/,
  /\bindex (\d{1,6})\b/,
  /\brows (\d{1,6}) and\b/,
  /\brow (\d{1,6}) of\b/,
]);

/** The ZIP compression method a package used, as a decimal group. */
const COMPRESSION_METHOD_PATTERN = /\buses compression method (\d{1,5})\b/;

/** The ZIP general-purpose bit flag, which the reader renders as hex. */
const GENERAL_PURPOSE_FLAG_PATTERN = /\bbit flag 0x([0-9a-f]{1,4})\b/;

/** A method that is not a bare token, which the runtime should never deliver. */
const UNKNOWN_METHOD = 'UNKNOWN';

/** A request target that could not be parsed into a pathname. */
const UNPARSEABLE_PATH = 'unparseable';

/** An HTTP method token, bounded in length as well as in alphabet. */
const METHOD_TOKEN_PATTERN = /^[A-Za-z]{1,16}$/;

/** Anything outside printable US-ASCII, which no sanitized value may carry. */
const NON_PRINTABLE_PATTERN = /[^\u0020-\u007E]/g;

/** How much pathname a log line may carry. */
const MAX_LOGGED_PATH_LENGTH = 64;

/**
 * The request method, or a fixed placeholder.
 *
 * @param {unknown} method `req.method`, not assumed to be a token.
 * @returns {string} An upper-case token, or `UNKNOWN`.
 */
function safeMethod(method) {
  return typeof method === 'string' && METHOD_TOKEN_PATTERN.test(method)
    ? method.toUpperCase()
    : UNKNOWN_METHOD;
}

/**
 * The request's pathname, with the query string gone and the length bounded.
 *
 * The query is excluded because `req.url` is the raw request target and a
 * caller can put anything in it — an activity label, a Student ID, a whole
 * submission — and have it written to a log by the very fault handler that is
 * careful not to reflect input. `requestPathname` reads the pathname off a
 * parsed `URL`, which also percent-encodes anything outside the ASCII range;
 * the sanitizing pass is the floor under that rather than a substitute for it.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @returns {string} A bounded, printable pathname, or a fixed placeholder.
 */
function safePath(req) {
  const pathname = requestPathname(req);
  if (pathname === null) {
    return UNPARSEABLE_PATH;
  }

  const printable = pathname.replace(NON_PRINTABLE_PATTERN, '');
  return printable.length > MAX_LOGGED_PATH_LENGTH
    ? `${printable.slice(0, MAX_LOGGED_PATH_LENGTH)}...`
    : printable;
}

/**
 * Names the underlying fault, if it may be named at all.
 *
 * @param {unknown} error The value thrown — not assumed to be an `Error`.
 * @returns {string} An allow-listed code, or one of the two fixed placeholders.
 */
function safeDetail(error) {
  if (error === null || typeof error !== 'object') {
    return DETAIL_NONE;
  }

  const cause = error.cause;
  if (cause === null || cause === undefined || typeof cause !== 'object') {
    return DETAIL_NONE;
  }

  return typeof cause.code === 'string' && LOGGABLE_DETAIL_CODES.has(cause.code)
    ? cause.code
    : DETAIL_UNCLASSIFIED;
}

/**
 * A message's own text, or the empty string for anything that has none.
 *
 * @param {unknown} value A thrown value, not assumed to be an `Error`.
 * @returns {string} The message, or `''`.
 */
function messageOf(value) {
  return value !== null && typeof value === 'object' && typeof value.message === 'string'
    ? value.message
    : '';
}

/**
 * The first bounded integer a message delimits, or `null`.
 *
 * @param {string} message The message to search.
 * @returns {number|null} A record index or workbook row.
 */
function positionIn(message) {
  for (const pattern of POSITION_PATTERNS) {
    const match = pattern.exec(message);
    if (match !== null) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * The bounded numeric a reader refusal rejected — a compression method, or the
 * general-purpose flag bits — or `null`.
 *
 * @param {string} message The message to search.
 * @returns {number|null} The method as decimal, or the flag as an integer.
 */
function rejectedNumberIn(message) {
  const method = COMPRESSION_METHOD_PATTERN.exec(message);
  if (method !== null) {
    return Number.parseInt(method[1], 10);
  }

  const flag = GENERAL_PURPOSE_FLAG_PATTERN.exec(message);
  if (flag !== null) {
    return Number.parseInt(flag[1], 16);
  }

  return null;
}

/**
 * The token for whichever anchor a message contains first.
 *
 * @param {string} message The message to classify.
 * @returns {string|null} A token from the table, or `null` for no match.
 */
function reasonIn(message) {
  if (message === '') {
    return null;
  }
  for (const [anchor, reason] of REFUSAL_REASONS) {
    if (message.includes(anchor)) {
      return reason;
    }
  }
  return null;
}

/**
 * Classifies a refusal into the three safe values a log line carries.
 *
 * The `cause` chain is consulted when the refusal's own message classifies as
 * the store's generic wrapper, or does not classify at all. That is what
 * carries a reader's compression method, flag or missing part through the
 * wrapper the store puts around it: without this step every one of the five
 * reader refusals would read as `workbook_column_unreadable` and the
 * distinction the reader took care to make would end at the wrap.
 *
 * @param {unknown} error The value thrown.
 * @returns {{reason: string, at: number|null, number: number|null}} A token
 *   from this file's own table, and two bounded integers or `null`.
 */
function classifyRefusal(error) {
  const ownMessage = messageOf(error);
  const ownReason = reasonIn(ownMessage);

  if (ownReason !== null && ownReason !== REASON_WRAPPER) {
    return {
      reason: ownReason,
      at: positionIn(ownMessage),
      number: rejectedNumberIn(ownMessage),
    };
  }

  const causeMessage =
    error !== null && typeof error === 'object' ? messageOf(error.cause) : '';
  const causeReason = reasonIn(causeMessage);

  if (causeReason !== null) {
    return {
      reason: causeReason,
      at: positionIn(causeMessage) ?? positionIn(ownMessage),
      number: rejectedNumberIn(causeMessage),
    };
  }

  return {
    reason: ownReason ?? REASON_UNCLASSIFIED,
    at: positionIn(ownMessage),
    number: null,
  };
}

/**
 * Writes one fixed-shape line of failure evidence.
 *
 * Serialized with `JSON.stringify` so the line is one parseable record whose
 * field set never varies — always these eight keys, `null` where a value does
 * not apply — which is what makes the evidence greppable and countable. The
 * thrown value is passed in only to be classified and to have its nested code
 * looked up against the allow-list; it is never formatted as an object, and
 * neither its message nor its `cause` is ever emitted.
 *
 * @param {string} event One of the two event constants above.
 * @param {string} code The code the outcome is identified by: the public error
 *   code the client was given, or — when the request could not be answered at
 *   all — this module's own internal signal for the fault. Both are constants
 *   of this file, never anything derived from a request.
 * @param {unknown} error The value thrown, for its classification, its bounded
 *   positions and its nested code.
 * @param {import('node:http').IncomingMessage} req The request.
 * @returns {void}
 */
function logFailure(event, code, error, req) {
  const classified = classifyRefusal(error);

  console.error(
    `activities: ${JSON.stringify({
      event,
      code,
      reason: classified.reason,
      detail: safeDetail(error),
      at: classified.at,
      number: classified.number,
      method: safeMethod(req.method),
      path: safePath(req),
    })}`
  );
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
  // Intent first, before the media type and before a byte of the body is
  // read. A submission from somebody else's page is refused as a whole rather
  // than parsed and then refused: the request is well-formed, and what is
  // missing is the authority to act on it. Like the 413 and the 415, this is
  // settled before the body's format is known, so it answers the JSON envelope
  // in both modes — re-rendering the form for a cross-origin caller would
  // reflect its own input back into a page it controls, and there is no person
  // on the other end to correct anything.
  if (!isSameOriginSubmission(req)) {
    sendFailure(res, FAILURES.CROSS_ORIGIN_SUBMISSION);
    drain(req);
    return;
  }

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
      // The client went away mid-body, so there is no socket left to answer
      // on and no status worth inventing — one written here would go into a
      // void. What the request still needs is a DEFINITE end and a record that
      // it happened: the fault is logged once, in the same bounded shape as a
      // store failure, and the response is destroyed so the socket is released
      // rather than left half-open behind a request nobody will ever answer.
      // `handle` still reports this request as claimed, because it was: the
      // namespace owns it, and falling through to the caller's own response
      // would write the legacy greeting onto a dead connection.
      logFailure(EVENT_REQUEST_STREAM_FAILED, SIGNAL_REQUEST_STREAM_FAILED, error, req);
      if (!res.writableEnded) {
        res.destroy();
      }
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
 *   `true`  — this module claimed the request and has REACHED A TERMINAL STATE
 *             for it. The caller returns immediately and writes nothing
 *             further. Terminal has three shapes, and the caller cannot tell
 *             them apart because it does not need to: a response was sent; or
 *             a response had already begun and the socket was destroyed; or
 *             the request's own stream failed before it could be answered, in
 *             which case the fault is logged here and the response destroyed,
 *             so no request is ever left claimed and hanging.
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
    // The single logging point for every store and reader refusal. It is here,
    // and not at the individual `throw` sites or in `validateSubmission`,
    // because this is the one place every one of them passes through: logging
    // upstream as well would produce two lines per fault and make a count of
    // them meaningless. Only a fault that becomes a `500` is recorded — a
    // label the store rejected is a client's mistake answered `400`, and
    // writing a server-side failure line for it would bury the real faults in
    // ordinary traffic.
    if (mapped.status >= 500) {
      logFailure(EVENT_STORE_FAILURE, mapped.code, error, req);
    }
    sendFailure(res, mapped);
  }

  return true;
}

module.exports = { handle };
