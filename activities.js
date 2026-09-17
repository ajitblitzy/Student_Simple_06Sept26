'use strict';

/**
 * activities.js — the HTTP contract for the `/activities` namespace.
 *
 * WHAT THIS MODULE OWNS
 * ---------------------
 * The request surface, and only that. The routes of the namespace are, with
 * the methods each one accepts:
 *
 *   GET | HEAD /activities               the submission form (HTML)
 *   POST       /activities               a submission, form-encoded or JSON
 *   GET | HEAD /activities/{studentId}   one student's activities (JSON only)
 *
 * The single export is `handle`, and its BOOLEAN RESULT is the whole
 * integration surface: `true` means this module claimed the request and has
 * answered it, `false` means the request target does not resolve into the
 * namespace and the caller falls through to its own behaviour. That one bit is
 * what keeps the caller's side of the integration to a single branch, and it
 * is why NOTHING is written to `res` on the `false` path — a request this
 * module declines is left exactly as it was found, header for header.
 * `handle` is asynchronous, so a caller awaits it inside an asynchronous
 * request handler and returns early once it answers `true`.
 *
 * The form and its result pages are template literals in this file, so there
 * is no static asset and nothing is read from disk to render a page.
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
 * It does not own `internal_error` either. That 500 belongs to the
 * `try`/`catch` in `server.js`, which is the rejection boundary for anything
 * this module fails to anticipate. Everything the store can refuse IS
 * anticipated here and mapped to a code of its own, because an escaped
 * rejection would arrive as `internal_error` and mask the real cause.
 */

const store = require('./activity-store');

/* ------------------------------------------------------------------------- *
 * The namespace, and the shape of a Student ID
 * ------------------------------------------------------------------------- */

/**
 * The namespace root. This module claims this path and its sub-resources —
 * including a sub-resource that resolves to no route, which it answers `404` —
 * and declines every other path.
 */
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
 * The origin a resolved target must still carry.
 *
 * Resolving a path against the base leaves the base's origin in place. A target
 * naming a DIFFERENT authority carries that authority instead
 * (`//evil.example/activities` resolves to origin `http://evil.example`), and a
 * target naming a non-special scheme carries the opaque origin `null`
 * (`javascript:/activities`). Comparing against this value catches exactly
 * those two outcomes and nothing else.
 *
 * What it does NOT establish is that the target was a path. A target naming
 * THIS base's own authority resolves to this very origin: the authority-form
 * and absolute-form targets that spell out `localhost` both yield origin
 * `http://localhost` and pathname `/activities`, so the only thing standing
 * between those forms and the namespace is the syntax test below. The origin
 * comparison is a backstop for the foreign-authority and opaque-origin cases,
 * not a second enforcement of origin-form.
 *
 * It is kept because those are the cases where a canonicalized pathname is most
 * misleading, and because the value is derived from the base rather than written
 * out, so the pair cannot drift apart.
 */
const PATH_RESOLUTION_ORIGIN = new URL(PATH_RESOLUTION_BASE).origin;

/**
 * The syntax a request target must have before its pathname is trusted:
 * origin-form, which is the form a client addressing this service directly
 * sends.
 *
 * `URL` resolution canonicalizes; it does not validate. It yields a namespace
 * pathname for targets that are not paths at all, so without this test the
 * namespace is reachable by a target that never named it. Each form below is
 * written with the pathname it actually resolves to:
 *
 *   - `//evil.example/activities`, and `/\evil.example/activities` — a second
 *     leading slash, and a leading backslash, both begin an AUTHORITY, so the
 *     resolved URL carries that authority in place of the base's while its
 *     pathname reads `/activities`.
 *   - `http://evil.example/activities` — absolute-form, the same effect written
 *     out in full. The pair that spells out the resolution base's OWN authority
 *     is sharper still: it keeps that origin as well as the pathname, so
 *     nothing but this test distinguishes it from the path `/activities`.
 *   - `javascript:/activities` — a scheme of its own, so the resolved URL is
 *     not an HTTP URL at all, yet its pathname still reads `/activities`.
 *   - `\activities` — a leading backslash where the slash belongs, which
 *     resolves to the pathname `/activities` on this very origin.
 *   - `/activities\S001` and `/activities\` — under a special scheme a
 *     backslash IS a path separator, so these resolve to `/activities/S001`
 *     and `/activities/`, reaching the item route and the collection route
 *     respectively rather than the pathname the target spelled.
 *   - a target holding a tab, CR or LF — those characters are stripped before
 *     parsing, so `/activ<TAB>ities` resolves to `/activities`.
 *
 * Two further forms are refused here without ever having canonicalized into the
 * namespace — `*`, which resolves to `/*`, and `data:text/html,/activities`,
 * whose pathname is `text/html,/activities`. Neither is a path, so neither has
 * business being matched against the route table at all.
 *
 * Three clauses cover all of it: exactly one leading slash, which excludes
 * absolute-form, asterisk-form and every scheme form; no character the parser
 * reads as a separator immediately after that slash, which excludes both
 * authority forms; and no C0 control, space or DEL anywhere, which excludes the
 * stripped characters. A backslash is excluded outright rather than handled as
 * a separator, because a request target has no use for one.
 *
 * Characters above the ASCII range are deliberately admitted: they are
 * percent-encoded rather than interpreted, they cannot become a separator, and
 * the namespace is pure ASCII, so such a target resolves to a pathname outside
 * it and is declined on that basis instead.
 *
 * A target this pattern refuses is answered `null` by `requestPathname`, so it
 * leaves the namespace to the caller's fall-through — the same response every
 * unclaimed path receives. Some of these forms never reach a handler at all —
 * the runtime answers an invalid request line with its own `400` first — and
 * the rest arrive here, which is why the test is worth having.
 */
const ORIGIN_FORM_TARGET = /^\/(?![/\\])[^\\\u0000-\u0020\u007f]*$/;

/**
 * The Student ID form: `S` followed by exactly three digits.
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
 * `HEAD` is first-class on every route that answers `GET`, and it is a method
 * constant here rather than a special case at one gate because both read
 * routes test for it.
 *
 * It is GET minus the content: the same status, the same headers, no body. A
 * general-purpose server is required to support it alongside GET, and a client
 * that only wants to know whether a resource resolves — or how large its
 * representation is — has no other method to ask with. Refusing it inside this
 * namespace was also internally inconsistent: the caller's preserved
 * fall-through never reads `req.method`, so `HEAD /` and `HEAD /anything-else`
 * have always been answered `200`, and the namespace was the one place that
 * turned the same request into a `405`. That is the inconsistency closed here.
 */
const METHOD_HEAD = 'HEAD';

/**
 * The `Allow` header value for each route that RESOLVES. A 405 always carries
 * one, and it always names the methods of the route actually addressed rather
 * than of the namespace as a whole — `Allow: GET, HEAD, POST` would be a lie
 * on `/activities/{id}`, which accepts no submission.
 */
const ALLOW_COLLECTION = 'GET, HEAD, POST';
const ALLOW_ITEM = 'GET, HEAD';

/**
 * The request media types `POST /activities` accepts. The form encoding is
 * what a browser form posts by default, which is exactly why the form below
 * needs no client-side JavaScript: its native encoding and this endpoint's
 * accepted type are the same thing.
 */
const MEDIA_TYPE_FORM = 'application/x-www-form-urlencoded';
const MEDIA_TYPE_JSON = 'application/json';

/**
 * The response media types for everything this module answers. Both carry an
 * explicit charset. A request whose path falls outside the namespace is
 * answered by the caller, which sets its own headers: this module writes none
 * on that path, so nothing here reaches a response it did not claim.
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
    'An activity must be a label of 1 to 60 characters and must not contain a line break or any other control character; a tab counts as a space.'
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
  /* A FULL STORE IS NOT A FAILED WRITE, and telling a submitter otherwise
   * costs them the only useful thing the response carries. Both refuse the
   * submission, but a write failure is an environmental fault — an unwritable
   * directory, a full disk, a refused rename — where retrying is the sensible
   * next move, while this one says the store has reached the size this build
   * can read back, where retrying is pointless and somebody has to reclaim
   * room in it. The store has always drawn that line internally; until now the
   * response collapsed the two into one code and one sentence, so a client
   * could not tell a store that was full from a disk that was broken.
   *
   * The status stays `500`: the submission genuinely could not be honoured and
   * nothing the submitter sent was wrong, so no 4xx describes it, and the
   * documented status set is left as it was. */
  STORE_AT_CAPACITY: failure(
    500,
    'store_at_capacity',
    'The activity store has reached the capacity this service accepts, so the activity could not be saved.'
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
  E_STORE_AT_CAPACITY: FAILURES.STORE_AT_CAPACITY,
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
 * Everything else stays the JSON envelope in both request modes: a 415 refuses
 * the declared media type, so no accepted mode exists to render into; a 413
 * refuses the body unread, so there are no submitted values to re-display; an
 * unresolved route has no form context to re-display, a 405 answers a client
 * that chose its own method, and a 500 is a fault no amount of retyping fixes.
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

/**
 * Every character `escapeHtml` rewrites: the five markup-significant ones
 * above, and the C0 control characters together with DEL.
 *
 * THE C1 RANGE `\u0080-\u009f` IS DELIBERATELY ABSENT, and "completing" the
 * set would CORRUPT values that survive intact today. HTML's
 * numeric-character-reference rules REMAP the references `&#128;` through
 * `&#159;` onto the Windows-1252 repertoire, so `&#128;` parses back as
 * U+20AC EURO SIGN and not as U+0080. Emitting a C1 character raw is therefore
 * the only form in which an attribute can carry it back unchanged, and a
 * rejected submission is re-displayed precisely so it can be corrected — so
 * raw is what it stays. The same remap is why the range cannot simply be
 * escaped "for symmetry" with the C0 range below, which has no such table.
 */
const HTML_ESCAPED_CHARACTERS = /[&<>"'\u0000-\u001f\u007f]/g;

/**
 * Escapes a value for interpolation into markup.
 *
 * This is load-bearing rather than tidy. A valid activity label may
 * legitimately contain `&`, `<`, `>`, `"` or `'` — nothing in the store's
 * normalization rules excludes them — so interpolating a label or a Student ID
 * straight into the result page would permit script injection THROUGH A VALUE
 * THE FEATURE ITSELF ACCEPTED. The attack needs no malformed request at all.
 *
 * All five are converted to their entity forms, which covers HTML text context
 * and double-quoted attribute context with one function. Every attribute in
 * the templates below is double-quoted, so there is no third context to get
 * wrong, and an escaped `"` cannot terminate an attribute early.
 *
 * The C0 control characters and DEL are converted as well, as DECIMAL NUMERIC
 * REFERENCES, and that part is a fidelity requirement rather than a security
 * one. A refused submission is re-displayed so a correction does not mean
 * retyping, which puts its raw characters inside a `value="…"` attribute: a
 * raw U+0000 there makes the parser substitute U+FFFD — an
 * `unexpected-null-character` parse error the specification mandates — and a
 * raw CR, LF or CRLF is newline-normalised before the attribute value is even
 * assembled, after which a single-line input strips what survives. Either way
 * the correction field ends up holding something other than what was
 * submitted. A numeric reference is opaque to both of those passes, so the
 * attribute carries the submitted characters and the response body carries no
 * raw control byte at all.
 *
 * U+0000 is the one character this still cannot round-trip, and no escaping
 * can: `&#0;` is DEFINED to yield U+FFFD, so HTML has no representation for a
 * NUL in any form. What the reference buys there is the well-formed response
 * body, not fidelity.
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
  return value.replace(
    HTML_ESCAPED_CHARACTERS,
    (character) => HTML_ENTITIES[character] ?? `&#${character.charCodeAt(0)};`
  );
}

/* ------------------------------------------------------------------------- *
 * The page
 *
 * One page serves every state a submitter can reach: the empty form, the
 * confirmation, the already-recorded notice and the validation error. It is a
 * heading, a labelled text input for each submitted field, and a submit
 * button, and nothing more.
 *
 * Semantic HTML carries the whole burden: `lang` on the root element, a
 * `<meta charset>`, exactly one `<h1>`, a real `<form method="post">` with a
 * real `<button type="submit">`, and a `<label for>` bound to every `<input
 * id>`. No `<div>` stands in for a control, and there is no `<script>` of any
 * kind — the form posts natively, which is precisely why its default encoding
 * and the endpoint's accepted media type are the same thing.
 *
 * Outcome is conveyed as TEXT. The colour classes are reinforcement; a reader
 * who cannot perceive them loses nothing, because the sentence says what
 * happened.
 * ------------------------------------------------------------------------- */

/**
 * The page's entire stylesheet: one inline `<style>` block. Keeping it to a
 * single site means a later migration to design tokens has exactly one place
 * to change.
 *
 * Every value the design specifies is here, unchanged: the typeface, the six
 * colours, the 32rem column with its 1rem gutters, the 2rem auto centring, the
 * label's 0.25rem, the input's full width and 0.5rem padding, the button's
 * 0.5rem 1rem, and the 4px radius on both controls.
 *
 * Seven further declarations are here for one reason, which is worth stating
 * because the block was once written without them: a specified value that a
 * user-agent default overrides or derives is not a value the design delivers.
 * Each of these exists so a specified value actually reaches the screen, and
 * every one of them draws on the palette above — no colour enters here that
 * the design did not already name.
 *
 *   `box-sizing: border-box` on the controls makes `width: 100%` mean the
 *   column. Under the default content-box it means the column PLUS the padding
 *   and the border, which put each field 20px past the 32rem measure and 4px
 *   outside any viewport under 552px, taking the right gutter with it.
 *
 *   `border: 1px solid #767676` on the input paints that colour. Declaring the
 *   colour alone leaves the browser's `inset` style in force, and `inset`
 *   derives a light and a dark edge FROM the colour instead of painting it —
 *   so the specified grey appeared at no pixel, and the pale derived edge sat
 *   at 1.64:1 against the page, under the 3:1 a boundary needs to be seen.
 *
 *   `border: 1px solid #1a4f8b` on the button replaces a browser default of
 *   `2px outset` in pure black, which painted three colours the design never
 *   named onto its primary action. Flat, in the button's own fill colour.
 *
 *   `font: inherit` on the controls carries the specified typeface into them.
 *   Form controls do not inherit a font, so both fields and the button rendered
 *   in the browser's own face at its own fixed 13.3333px — smaller than the
 *   label above them, and pinned there when a reader doubles the text size.
 *
 *   `color: #1a1a1a` on the input makes the text a student types the same
 *   colour as the rest of the page, rather than the browser's pure black.
 *
 *   `display: block` on the label is what lets its 0.25rem apply at all: a
 *   vertical margin does nothing on an inline box, so the specified spacing
 *   rendered as nothing and the gap came from a `<br>` in the markup. With the
 *   label a block, that `<br>` is gone and the declaration does the work.
 *
 *   The `:focus-visible` ring is a real indicator instead of a borrowed one.
 *   The browser's own outline is drawn over the control's border footprint, so
 *   whether focus could be seen depended on how pale that border happened to
 *   be. Two pixels of the button's blue, held 2px clear of the control, is
 *   visible on both controls without depending on anything inherited.
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
        display: block;
        margin-bottom: 0.25rem;
      }
      input {
        width: 100%;
        padding: 0.5rem;
        border: 1px solid #767676;
        color: #1a1a1a;
      }
      button {
        background-color: #1a4f8b;
        color: #ffffff;
        padding: 0.5rem 1rem;
        border: 1px solid #1a4f8b;
      }
      input,
      button {
        box-sizing: border-box;
        font: inherit;
        border-radius: 4px;
      }
      input:focus-visible,
      button:focus-visible {
        outline: 2px solid #1a4f8b;
        outline-offset: 2px;
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
 * The mobile layout viewport.
 *
 * A document that declares none is laid out by a mobile browser against its
 * own default layout viewport — around 980 CSS pixels — and the result is then
 * scaled down to fit the screen, so a form that is perfectly usable at any
 * desktop width arrives on a phone conspicuously shrunk. There are no
 * breakpoints to opt into here, and none are being introduced: the whole of
 * what this element says is that the layout viewport is the device's width.
 *
 * It declares no asset, runs no script and adds no CSS declaration, so the
 * page stays self-contained and the style inventory stays exactly as
 * authorized.
 */
const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">';

/**
 * The page's icon declaration. Its entire purpose is to PREVENT A REQUEST.
 *
 * A document that declares no icon makes the browser ask for `/favicon.ico` of
 * its own accord, so every page view costs two round trips rather than one.
 * The second one is worse than wasted: the path is outside this namespace, so
 * it is answered by the preserved legacy response — 34 bytes of `text/plain` —
 * which an image decoder then rejects, leaving the browser to fall back to its
 * default tab icon after paying for bytes it could never use. Narrowing that
 * response to a `204` or a `404` is not available: it is preserved byte for
 * byte for every path outside the namespace, which is why the request is
 * stopped at the document instead of answered differently at the server.
 *
 * An EMPTY `data:` URL is what stops it without introducing an asset. The URL
 * carries its own payload inline, and that payload is zero bytes, so there is
 * nothing to fetch: the page still issues no subresource request of any kind,
 * and the repository root still gains no static file.
 */
const ICON_LINK = '<link rel="icon" href="data:,">';

/** The feature's own name, and the tail of every title the page serves. */
const PAGE_TITLE = 'Extracurricular activities';

/**
 * What separates an outcome from the feature's name in a title.
 *
 * Written as an escape sequence rather than as the character itself so this
 * source file stays ASCII. The served bytes are identical either way, and a
 * literal em dash is one more thing an editor, a terminal or a checkout with
 * the wrong encoding assumption can corrupt silently.
 */
const TITLE_SEPARATOR = ' \u2014 ';

/**
 * The outcome each result page announces in its title.
 *
 * Every outcome this feature produces is a FULL PAGE NAVIGATION — the page
 * ships no client-side script, so nothing is ever updated in place — which
 * makes the title the first thing a screen reader announces after a submission
 * and the only label the tab, the window and the history entry carry. A title
 * that named the feature alone would say where the reader is and nothing about
 * what just happened, identically on all eight screens this feature can serve.
 *
 * The distinction drawn is the one a submitter acts on: recorded, already
 * recorded, or something to fix. The failure prefix deliberately does NOT name
 * the offending field or repeat the reason — the message element carries both,
 * bound to the field by `aria-describedby`, and a title long enough to restate
 * them is a title that gets read out in full before every page.
 */
const TITLE_CREATED = 'Activity recorded';
const TITLE_ALREADY_RECORDED = 'Activity already recorded';
const TITLE_FAILURE = 'Problem with your submission';

/**
 * Composes one page title, outcome first.
 *
 * Outcome first because that is the part a narrow tab still shows, and the
 * part a screen reader reaches before a listener has decided whether to keep
 * listening.
 *
 * @param {string|null} outcome One of the prefixes above, or `null` for the
 *   plain form, which has no outcome to announce and so carries the feature's
 *   name alone.
 * @returns {string} The composed title.
 */
function pageTitle(outcome) {
  return outcome === null ? PAGE_TITLE : `${outcome}${TITLE_SEPARATOR}${PAGE_TITLE}`;
}

/**
 * The format hint the browser's own validation bubble reads out for the
 * Student ID field.
 *
 * `pattern="S[0-9]{3}"` is a convenience, but it is a convenience that
 * INTERCEPTS. For a non-empty malformed Student ID the browser blocks the
 * submission outright — no request leaves it at all — so the authoritative
 * server-side check never runs, and the sentence it would have produced never
 * reaches the page as document text bound to the field by `aria-invalid` and
 * `aria-describedby`. All the submitter gets is the browser's transient
 * bubble, and a bubble with no `title` to read from says only "Please match
 * the requested format." while never stating what the format is.
 *
 * This is the failure's OWN sentence, read from the failure table rather than
 * rewritten for the bubble, so the hint a blocked submission shows and the
 * message a submission that does reach the server shows cannot drift apart. An
 * EMPTY Student ID is not tested by `pattern` — there is no `required`
 * attribute — so that case still reaches the server and still renders the full
 * message, which is why this hint supplements the server path rather than
 * standing in for it.
 */
const STUDENT_ID_FORMAT_HINT = FAILURES.STUDENT_ID_MALFORMED.message;

/* ------------------------------------------------------------------------- *
 * An outcome sentence as SEGMENTS, so a submitted value cannot reach past
 * itself
 *
 * A sentence built by concatenation is one run of text to the bidi algorithm,
 * and a submitted label is free to carry a paragraph-level direction control
 * such as U+202E RIGHT-TO-LEFT OVERRIDE. Unterminated, that override escapes
 * the label and reverses the REMAINDER OF THIS MODULE'S OWN SENTENCE,
 * including the Student ID: `Recorded Chess <U+202E> buLC for S003.` renders
 * as `Recorded Chess .300S rof CLub`, so the one channel that says what
 * happened to which student becomes unreadable.
 *
 * Rejecting the character is not the answer and is not available: U+202E is
 * Unicode category Cf, not a control character and not a line separator, so
 * the label is legitimately accepted and correctly stored. The gap is in
 * rendering, and `<bdi>` closes it — it isolates its contents from the
 * surrounding text's direction resolution and contributes no characters of its
 * own, so the message element's TEXT stays exactly the sentence it was.
 *
 * Which is why a message travels to `renderPage` as a LIST rather than as
 * markup. Handing `renderPage` a pre-built, pre-escaped HTML string would
 * destroy the invariant its own contract rests on — that every value it
 * interpolates is escaped inside it — and would leave the next caller free to
 * pass a string built from input. A list of segments carries the one thing
 * `renderPage` cannot otherwise know, which segments are submitted values, and
 * nothing else.
 * ------------------------------------------------------------------------- */

/**
 * A fragment of a sentence THIS MODULE wrote: joining words, punctuation, a
 * fixed failure sentence. Escaped, never isolated — isolating the connective
 * tissue of a sentence from itself would be meaningless.
 *
 * @param {string} text The fixed fragment.
 * @returns {{text: string, isolate: boolean}} One segment.
 */
function fixed(text) {
  return { text, isolate: false };
}

/**
 * A value that CAME FROM OUTSIDE — a stored label, a Student ID — spliced into
 * the sentence. Escaped and isolated, because its direction resolution must
 * not reach the words around it.
 *
 * @param {string} text The submitted or stored value.
 * @returns {{text: string, isolate: boolean}} One segment.
 */
function isolated(text) {
  return { text, isolate: true };
}

/**
 * Renders the page in one of its four states.
 *
 * Every dynamic value passes through `escapeHtml` on its way in — the two
 * submitted field values, which are arbitrary client input, the title, and
 * every segment of the message. The last two are this module's own text or
 * values it has already accepted, and are escaped anyway so that no future
 * caller can introduce an unescaped path by supplying either one built from
 * input.
 *
 * @param {{title: string, message: Array<{text: string, isolate: boolean}>|null, kind: string, studentId: string, activity: string, invalidField: string|null}} view
 *   `title` is the composed document title, which distinguishes the outcome
 *   because every outcome arrives as a full page navigation. `message` is
 *   `null` for the plain form, and otherwise the sentence's segments in order;
 *   an isolated segment is wrapped in `<bdi>` here. `kind` selects the colour
 *   class. `studentId` and `activity` are pre-filled back into the inputs so a
 *   correction does not mean retyping. `invalidField` flags one input.
 * @returns {string} A complete HTML document.
 */
function renderPage(view) {
  const messageClass = view.kind === MESSAGE_ERROR ? MESSAGE_ERROR : MESSAGE_SUCCESS;
  const messageText =
    view.message === null
      ? null
      : view.message
          .map((segment) =>
            segment.isolate
              ? `<bdi>${escapeHtml(segment.text)}</bdi>`
              : escapeHtml(segment.text)
          )
          .join('');
  const messageMarkup =
    messageText === null
      ? ''
      : `    <p id="${MESSAGE_ELEMENT_ID}" class="${messageClass}">${messageText}</p>\n`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    ${VIEWPORT_META}
    ${ICON_LINK}
    <title>${escapeHtml(view.title)}</title>
    <style>
${STYLE_BLOCK}
    </style>
  </head>
  <body>
    <h1>Add an extracurricular activity</h1>
${messageMarkup}    <form method="post" action="${NAMESPACE_PATH}">
      <p>
        <label for="student-id">Your Student ID, for example S001</label>
        <input id="student-id" name="${FIELD_STUDENT_ID}" type="text" pattern="S[0-9]{3}" title="${escapeHtml(
    STUDENT_ID_FORMAT_HINT
  )}" value="${escapeHtml(
    view.studentId
  )}"${invalidAttribute(view.invalidField, FIELD_STUDENT_ID)}>
      </p>
      <p>
        <label for="activity">The activity, for example Chess Club</label>
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

function renderEmptyForm() {
  return renderPage({
    title: pageTitle(null),
    message: null,
    kind: MESSAGE_SUCCESS,
    studentId: '',
    activity: '',
    invalidField: null,
  });
}

/**
 * The value `activity-store.js` writes into a record it seeded from the
 * workbook column. Mirrored as a literal here rather than imported, because
 * the store exports functions and not this marker, and read here to choose the
 * accurate sentence for the already-recorded page: a label that came from the
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
 * `created` decides the title as well as the sentence. The two outcomes differ
 * in what they did — one appended a record, the other found one and left the
 * store alone — and a reader who hears only the title has to be told which.
 *
 * @param {boolean} created True when a record was appended, false when an
 *   identical one already existed and nothing was written.
 * @param {{studentId: string, activity: string, source: string, submittedAt?: string}} record
 *   The record as the store returned it.
 * @returns {string} A complete HTML document.
 */
function renderOutcome(created, record) {
  // Both values came from outside this module — the label as the submitter
  // spelled it, the Student ID as they typed it — so both are isolated in
  // every sentence below. The stored label is no safer than the submitted one:
  // it IS the submitted one, normalized.
  const activity = isolated(record.activity);
  const studentId = isolated(record.studentId);

  let message;
  if (created) {
    message = [fixed('Recorded '), activity, fixed(' for '), studentId, fixed('.')];
  } else if (record.source === RECORD_SOURCE_WORKBOOK) {
    message = [
      activity,
      fixed(' is already on the student record for '),
      studentId,
      fixed(', so nothing was added.'),
    ];
  } else {
    message = [
      activity,
      fixed(' was already submitted for '),
      studentId,
      fixed(', so nothing was added.'),
    ];
  }

  return renderPage({
    title: pageTitle(created ? TITLE_CREATED : TITLE_ALREADY_RECORDED),
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
 * It is ONE fixed segment, and correctly so: a failure sentence and a failure
 * code are both this module's own text, and per section 0.8.2.5 no error
 * message interpolates the submitted value at all. There is nothing here to
 * isolate. The submitted values still reach the page, but as the inputs'
 * `value` attributes, where direction resolution cannot escape the attribute.
 *
 * @param {{status: number, code: string, message: string}} outcome The failure.
 * @param {{studentId: string, activity: string}} submitted The values as they
 *   arrived, so a correction does not mean retyping.
 * @param {string|null} invalidField The field to flag.
 * @returns {string} A complete HTML document.
 */
function renderFailure(outcome, submitted, invalidField) {
  return renderPage({
    title: pageTitle(TITLE_FAILURE),
    message: [fixed(`${outcome.message} (${outcome.code})`)],
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
  // `Content-Length` is set explicitly, and only because of HEAD. Measured on
  // the pinned runtime (Node v24.21.0), `res.end(body)` computes and emits the
  // header by itself for a GET or a POST, but on a HEAD response — where the
  // runtime knows it must write no body — it omits the header ENTIRELY, so a
  // HEAD would announce nothing about the size of the representation a GET
  // would have returned, which is the one thing a HEAD is most often asked
  // for. Set here it survives on a HEAD while the runtime still writes zero
  // body bytes. The value is `Buffer.byteLength` of the same string `res.end`
  // receives, which is byte for byte what the runtime already computed for
  // GET and POST, so no existing response changes on the wire.
  res.setHeader('Content-Length', Buffer.byteLength(body));

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
 * This is the single most consequential predicate in the feature, because it
 * decides who answers. A request it declines is answered by the caller's own
 * fixed response — one status, one header, one 34-byte body, identical for
 * every method on every path — and that response is the service's contract for
 * everything outside `/activities`.
 *
 * So the predicate claims exactly two things: the namespace root, and a
 * sub-resource of it named by an origin-form target. Anything broader hands
 * the feature requests the fall-through owns; anything looser lets a target
 * that never named the namespace reach the store behind it.
 * ------------------------------------------------------------------------- */

const ROUTE_OUTSIDE = 'outside';
const ROUTE_COLLECTION = 'collection';
const ROUTE_ITEM = 'item';
const ROUTE_UNRESOLVED = 'unresolved';

/**
 * Reduces a request target to the pathname the route table is matched against.
 *
 * One admission test and two normalizations, each deliberate:
 *
 *   0. The target must be origin-form — `ORIGIN_FORM_TARGET` above states the
 *      syntax and why each clause of it is there. The test comes FIRST because
 *      `URL` resolution canonicalizes rather than validates: it reads an
 *      authority, a foreign scheme or a backslash separator out of a target and
 *      still yields a pathname, and a pathname obtained that way names the
 *      namespace without the target ever having done so.
 *   1. The pathname is read from a parsed `URL`, so the query string and any
 *      fragment are gone before matching. A `startsWith` against the raw
 *      `req.url` would misclassify `/activities?x=1` as a sub-resource named
 *      `?x=1`. The resolved origin is then compared with the base's, which
 *      catches a foreign authority or an opaque origin and nothing more — step
 *      0 already refuses every target that could reach it, including the
 *      same-authority forms the comparison cannot see. `PATH_RESOLUTION_ORIGIN`
 *      states its exact reach.
 *   2. A single trailing slash is stripped, so `/activities/` is `/activities`
 *      and `/activities/S001/` is `/activities/S001`. The root `/` keeps its
 *      slash: stripping it would leave the empty string, which matches nothing
 *      here anyway, but a pathname that no longer starts with `/` is a
 *      surprise waiting for the next reader.
 *
 * Percent-encoding is left encoded, which is what the route table matches
 * against: `%2f` and `%5c` are not separators, so `/activities%2fS001` is one
 * segment that is not the namespace root and is therefore outside it. Dot
 * segments ARE resolved, because they resolve within the fixed base: both
 * `/x/../activities` and `/%2e%2e/activities` name the namespace root, and
 * that is the route they reach.
 *
 * `null` means this module will not name the target: it is not origin-form, or
 * it will not parse at all. The caller treats that as outside the namespace,
 * which is the conservative direction — the request is answered by the
 * fall-through, the one response that holds for every path the feature does
 * not claim. Some such targets never reach a handler in the first place,
 * because the runtime answers an invalid request line with its own `400`; the
 * rest arrive here and are declined.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @returns {string|null} The normalized pathname, or `null` when the target is
 *   not an origin-form path this module will match on.
 */
function requestPathname(req) {
  const target = req.url;
  if (typeof target !== 'string' || !ORIGIN_FORM_TARGET.test(target)) {
    return null;
  }

  let resolved;
  try {
    resolved = new URL(target, PATH_RESOLUTION_BASE);
  } catch {
    return null;
  }

  if (resolved.origin !== PATH_RESOLUTION_ORIGIN) {
    return null;
  }

  const pathname = resolved.pathname;
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
 * `/activitieslist` — does not, and is answered `ROUTE_OUTSIDE`, which the
 * caller answers with its own fixed fall-through response: the one the service
 * gives for every path this feature does not claim.
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
 * decisions on it is the wrong one. It is a COLLAPSED view, and how it
 * collapses depends on the field name: a singleton field such as
 * `Content-Type` or `Host` keeps its first line and silently discards every
 * later one, while a field such as `Origin` or `Accept` arrives joined into
 * one comma-separated string. Either way a single unambiguous declaration is
 * indistinguishable from two conflicting ones, so a decision taken on that
 * view answers a request whose meaning was never agreed.
 * `req.headersDistinct` keeps every field line, which is what makes the
 * difference visible at all.
 *
 * So every header this module decides on is read through the one primitive
 * below, which reports THREE states: absent, exactly one value, or ambiguous
 * because it was declared more than once. Each caller maps those states onto
 * its own policy; the media-type check is the one that treats absent and
 * ambiguous alike, answering `415` rather than guessing which line the sender
 * meant.
 * ------------------------------------------------------------------------- */

const HEADER_CONTENT_TYPE = 'content-type';

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
 * the equivalent forms of `application/x-www-form-urlencoded`. Senders differ
 * in exactly this: a native HTML form posts the bare type with no parameters,
 * while other clients append `charset` or another parameter and vary in case.
 * Normalizing is what lets one comparison accept every spelling of the two
 * accepted types; comparing the raw header would refuse legitimate clients
 * over punctuation the type does not depend on.
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
 * Reading the request body
 *
 * The obvious implementations of a size limit either end the process or never
 * deliver the status, so the shape below is prescribed rather than preferred.
 * Two failures it avoids:
 *
 *   Writing the 413 from inside the `data` handler and then continuing to
 *   receive chunks writes to `res` again once the headers are already sent.
 *   That throws ERR_HTTP_HEADERS_SENT inside the `'data'` listener, where
 *   nothing catches it, so the next chunk terminates the process.
 *
 *   Calling `req.destroy()` on exceeding the limit makes the client observe a
 *   connection reset and never read the 413 at all, so the one thing the limit
 *   was supposed to communicate is the one thing that does not arrive.
 *
 * What works: stop accumulating, detach the accumulation listener, drain the
 * remainder, and reject exactly once. The drain consumes the body the sender
 * declared, so the request completes and the connection is left correctly
 * framed and reusable rather than torn down mid-message. The response is then
 * written by the caller from the rejection path alone, where `send`'s guard
 * makes a second write impossible.
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
     * `detachAll` is the whole of it. Only the two listeners that carry a
     * successful read come off: `'data'`, which accumulates, and `'end'`,
     * which would resolve a promise that has already rejected. `'error'` and
     * `'close'` stay attached, because `req.resume()` below keeps the stream
     * running until the body the sender declared has been drained, and the
     * read has to stay observable for the whole of that span. A fault during
     * the drain is delivered to `onError`, where the `done` guard absorbs it
     * rather than rejecting a second time or touching `res`, and `'close'`
     * performs the terminal detachment whichever way the drain ended.
     * Detaching them here would end the observation early — a request stream
     * carries its error nowhere once nothing is listening for it — and leave
     * the cleanup with nothing to trigger it.
     */
    function detachAccumulation() {
      req.off('data', onData);
      req.off('end', onEnd);
    }

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
 * repository, and JSON offers no constraint mechanism either, so the link
 * between an activity and a student is enforced only in code — here, and at
 * two further points inside `activity-store.js` that do not rely on this one
 * having run: a write guard on every Student ID `addActivity` appends, and a
 * load check over every record already in the document.
 *
 * This layer owns the user-facing half of that work, and it is the only one
 * of the three that can turn a bad reference into the `400`/`404` split
 * above. The store's two refuse as faults — `500 internal_error` for the
 * write guard, `500 store_unreadable` for the load check — because they exist
 * to protect a document a person can hand-edit, not to answer a submitter.
 * That is what makes this check mandatory rather than redundant.
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
 * in both modes: a 415 refuses the declared media type itself, so there is no
 * accepted mode to render into; a 413 knows the mode but has no read body, so
 * there are no submitted values to re-display and the envelope is the
 * deliberate representation; a 405 answers a method the client chose, an
 * unresolved path has no form context, and a 500 is a fault no correction
 * addresses.
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
 * `Location` is sent only with the `201`, and the Student ID interpolated into
 * it is the one submitted value that reaches a response header. That is safe
 * precisely because it has already matched `/^S\d{3}$/`: an `S` and three
 * digits cannot carry a separator, a newline or a control character into the
 * header. The activity label, which is free text, never appears in a header at
 * all.
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
 * A mapped `500`, and a request whose stream dies mid-body, are invisible from
 * outside this process unless they are written down here. A `500` tells its
 * client which code applied and tells the operator nothing, so without this
 * evidence `reference_data_unavailable`, `store_unreadable` and
 * `store_write_failed` are indistinguishable after the fact, as is every way
 * the workbook reader can refuse a package; and a failed request stream is
 * recorded nowhere else at all.
 *
 * NOTHING A MESSAGE CARRIES IS EVER LOGGED. `activity-store.js`
 * and `xlsx-read.js` deliberately put the offending detail in their `message`
 * — a workbook path, the configured store path, a stored record's Student ID,
 * an activity label — because that detail belongs in a diagnosis and not in a
 * response. Copying one of those messages into a log would move exactly the
 * data this feature refuses to reflect to a client into a file that outlives
 * the request. So the message, the `cause` chain and the `Error` object itself
 * are all excluded here by construction: every field below is either a
 * constant of this module or a value taken from the store's declared
 * diagnostic and re-checked against the shape a field of that name may hold.
 *
 * THE DISTINCTION IS READ, NOT RECONSTRUCTED. `store_unreadable` covers a
 * dozen different faults, and a log that could not tell "the document declares
 * the wrong schema version" from "the record at index 4 has a source nobody
 * recognises" would leave an operator exactly where no log at all leaves them.
 * Each refusal therefore arrives already classified: `activity-store.js`
 * attaches a `diagnostic` where it raises the refusal — a stable token, the
 * code of the fault underneath it, and up to two bounded numbers — and it
 * adopts the reader's own diagnostic when it wraps a reader refusal, so a
 * rejected compression method and a missing part stay distinguishable through
 * that wrapper. This module reads that one object off the error it was handed.
 * It holds no table of refusals, inspects no message, and does not walk the
 * `cause` chain into a module it does not depend on: `activity-store.js` is
 * its only neighbour, and the store's diagnostic is the whole of what it
 * consumes.
 *
 * What it does do is CHECK. A field is emitted only if it still has the shape
 * a field of that name may hold — a lower-snake-case token, an upper-case
 * code, a non-negative integer — and anything else is reported as
 * `unclassified` or `none`. That check is not distrust of the store; it is
 * what keeps this function total for a thrown value that turns out not to be
 * a store refusal at all, which is precisely the case the request boundary
 * exists to survive.
 * ------------------------------------------------------------------------- */

/* The `event` field of a log line: which kind of failure the line records, and
 * the value a consumer filters on to count one kind without matching the
 * other. */

const EVENT_STORE_FAILURE = 'store_failure';
const EVENT_REQUEST_STREAM_FAILED = 'request_stream_failed';

/**
 * The shape a `reason` token may have.
 *
 * A token is emitted for matching this, not for appearing on a list of the
 * refusals that exist today. `activity-store.js` and `xlsx-read.js` own that
 * vocabulary and extend it whenever they add a refusal, so a list kept here
 * would be a second copy of theirs — and a stale copy is worse than none,
 * because it silently downgrades every new refusal to `unclassified` while
 * looking maintained.
 */
const REASON_TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * The shape a `detail` code may have.
 *
 * What makes this field safe to write out is the producer contract:
 * `activity-store.js` declares `detail` to be the code of a module or runtime
 * fault — a `node:fs` errno, or a declared `E_*` code — and never a fragment
 * of anything a caller sent. This pattern is the check underneath that
 * contract rather than a substitute for it. It rejects whatever falls outside
 * the shape of a code, so a path, a sentence or a mixed-case value fails at
 * its first lower-case letter, space or separator and is reported as
 * unclassified; a bare upper-case word would satisfy the shape, which is why
 * the contract, not this pattern, is what keeps submitted text out of the
 * field.
 */
const DETAIL_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,47}$/;

/* The two values `detail` takes when it names no code. They are distinct on
 * purpose: `none` says the failure had no fault underneath it, `unclassified`
 * says it had one this module would not write out, and collapsing them would
 * hide the second behind the first. */

const DETAIL_NONE = 'none';
const DETAIL_UNCLASSIFIED = 'unclassified';

/* The `reason` reported for a thrown value that carries no diagnostic, or
 * whose token did not survive the check above. */

const REASON_UNCLASSIFIED = 'unclassified';

const UNKNOWN_METHOD = 'UNKNOWN';

const UNPARSEABLE_PATH = 'unparseable';

/**
 * The shape an HTTP method must have to be written to a log record as itself.
 * `req.method` is client-controlled, and a value outside this shape is replaced
 * by a fixed placeholder rather than truncated, so the length ceiling only has
 * to sit clear of real method tokens — a few characters each — while keeping a
 * fabricated one out of the record entirely.
 */
const METHOD_TOKEN_PATTERN = /^[A-Za-z]{1,16}$/;

const NON_PRINTABLE_PATTERN = /[^\u0020-\u007E]/g;

/**
 * The ceiling on the pathname a log record carries. The request target is
 * client-controlled, so the pathname is truncated rather than logged whole and
 * a caller cannot inflate a record with a long target. This namespace's own
 * paths — the collection, and one Student ID under it — fit well inside it.
 */
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
 * The diagnostic a refusal arrived with, or `null` for a value carrying none.
 *
 * One property access on the error this module was handed. A refusal from
 * `activity-store.js` always carries one, and the store has already folded a
 * wrapped reader refusal into it, so there is nothing further down to reach
 * for.
 *
 * @param {unknown} error The value thrown — not assumed to be an `Error`.
 * @returns {object|null} The diagnostic, or `null`.
 */
function diagnosticOf(error) {
  if (error === null || typeof error !== 'object') {
    return null;
  }

  const diagnostic = error.diagnostic;
  return diagnostic !== null && typeof diagnostic === 'object' ? diagnostic : null;
}

/**
 * A reason token that still has the shape of one, or the placeholder.
 *
 * @param {unknown} reason The diagnostic's `reason`, not assumed to be a token.
 * @returns {string} The token, or `unclassified`.
 */
function safeReason(reason) {
  return typeof reason === 'string' && REASON_TOKEN_PATTERN.test(reason)
    ? reason
    : REASON_UNCLASSIFIED;
}

/**
 * A position a log line may carry, or `null`.
 *
 * A record index, a workbook row, a byte offset and a ZIP header field are all
 * non-negative integers, and an integer is the one thing a submitted label, a
 * Student ID or a filesystem path cannot be. That is what lets these two
 * fields be emitted exactly as the producer set them while no other value from
 * a refusal can be emitted at all.
 *
 * @param {unknown} value The diagnostic's `at` or `number`.
 * @returns {number|null} The integer, or `null`.
 */
function safePosition(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * The `code` of the fault behind one of this module's own body-read signals.
 *
 * Narrow on purpose. It answers for this module's own body-read signal codes
 * and nothing else, so a refusal that arrived without a diagnostic is reported
 * as carrying no detail rather than having its `cause` inspected here. A
 * body-read signal is the one case where the fault underneath belongs to THIS
 * module: the request stream failed, and this file is what built the signal and
 * attached that fault to it, so reading its `code` reads a value put there
 * here. Without it, a socket reset and a client that simply stopped sending
 * would record identically.
 *
 * @param {unknown} error The value thrown.
 * @returns {unknown} The cause's `code`, or `null`.
 */
function ownSignalCause(error) {
  if (error === null || typeof error !== 'object') {
    return null;
  }
  if (error.code !== SIGNAL_BODY_TOO_LARGE && error.code !== SIGNAL_REQUEST_STREAM_FAILED) {
    return null;
  }

  const cause = error.cause;
  return cause !== null && typeof cause === 'object' ? cause.code : null;
}

/**
 * The code of the fault underneath a failure, where it may be named at all.
 *
 * @param {unknown} error The value thrown, for the body-read signal case.
 * @param {object|null} diagnostic The refusal's diagnostic, or `null`.
 * @returns {string} A code, or one of the two fixed placeholders.
 */
function safeDetail(error, diagnostic) {
  const code = diagnostic !== null ? diagnostic.detail : ownSignalCause(error);
  if (code === null || code === undefined) {
    return DETAIL_NONE;
  }

  return typeof code === 'string' && DETAIL_CODE_PATTERN.test(code)
    ? code
    : DETAIL_UNCLASSIFIED;
}

/**
 * Reads the classification a refusal arrived with, and checks it.
 *
 * `activity-store.js` documents the object this reads — a `reason` token, the
 * `detail` code of the fault underneath, and `at` and `number` as bounded
 * positions — and documents that it adopts the reader's diagnostic when it
 * wraps a reader refusal. So a rejected compression method arrives here
 * already named as one, and this module needs no knowledge of the reader to
 * record it.
 *
 * Each field is then re-checked against the shape a field of that name may
 * hold. A thrown value with no diagnostic is not a store refusal, and the
 * request boundary must answer for those too, so it classifies as
 * `unclassified` with no positions rather than failing here.
 *
 * @param {unknown} error The value thrown.
 * @returns {{reason: string, detail: string, at: number|null, number: number|null}}
 *   A checked classification, safe to write to a log verbatim.
 */
function classifyRefusal(error) {
  const diagnostic = diagnosticOf(error);

  return {
    reason: diagnostic === null ? REASON_UNCLASSIFIED : safeReason(diagnostic.reason),
    detail: safeDetail(error, diagnostic),
    at: diagnostic === null ? null : safePosition(diagnostic.at),
    number: diagnostic === null ? null : safePosition(diagnostic.number),
  };
}

/**
 * Writes one fixed-shape line of failure evidence.
 *
 * Serialized with `JSON.stringify` so the line is one parseable record whose
 * field set never varies — the same keys every time, `null` where a value does
 * not apply — which is what makes the evidence greppable and countable, and
 * what lets a consumer count one `event` without matching another. The thrown
 * value is passed in only to be classified: it is never formatted as an
 * object, and neither its message nor its `cause` is ever emitted.
 *
 * @param {string} event Which kind of failure this records, from the event
 *   constants above.
 * @param {string} code The code the outcome is identified by: the public error
 *   code the client was given, or — when the request could not be answered at
 *   all — this module's own internal signal for the fault. Both are constants
 *   of this file, never anything derived from a request.
 * @param {unknown} error The value thrown, for its classification.
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
      detail: classified.detail,
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
  // The media type first, and with it the submission mode, before a byte of
  // the body is read: an unaccepted type is refused as a whole rather than
  // parsed and then refused. The mode decided here renders the outcomes a
  // person filling in the form can act on — the two successes and the
  // validation refusals. A protocol refusal or a fault answers the JSON
  // envelope in either mode, exactly as the matrix specifies.
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
  if (req.method === METHOD_GET || req.method === METHOD_HEAD) {
    // A HEAD is served by rendering exactly what a GET renders and handing it
    // to `send`. No body-suppression code is needed and none should be added:
    // `node:http` marks a HEAD response `_hasBody = false` and discards the
    // body itself, so the runtime writes only the headers. Rendering the same
    // document is what makes those headers — the content type and the
    // `Content-Length` `send` sets — describe the representation a GET would
    // have returned, rather than an empty one.
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
 * `GET | HEAD /activities/{studentId}` — one student's activities.
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
  if (req.method !== METHOD_GET && req.method !== METHOD_HEAD) {
    sendFailure(res, FAILURES.METHOD_NOT_ALLOWED, { Allow: ALLOW_ITEM });
    drain(req);
    return;
  }

  // Nothing below this gate tests the method, and that is deliberate: a HEAD
  // takes the identical path a GET takes — the same shape test, the same
  // key-set lookup, the same store read — so it produces the same 400, 404 or
  // 200 a GET would, with the body dropped by the runtime. Short-circuiting a
  // HEAD ahead of the lookup would make it answer a different question from
  // the GET it is supposed to preview.

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
 *   `false` — the request target does not resolve into the namespace, which
 *             happens in two ways. Either this module will not name the
 *             target at all — it is not origin-form, it will not parse, or
 *             its resolved origin is foreign or opaque — or the normalized
 *             pathname it does name lies outside the namespace. NOTHING has
 *             been written to `res` in either case, not a status and not a
 *             header, because both returns sit ahead of every write, so the
 *             caller's own response is exactly what it always was.
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
