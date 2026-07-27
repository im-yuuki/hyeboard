# VNU (daotao.vnu.edu.vn) HAR Notes

Raw HAR files are not committed. These notes contain only sanitized endpoint and shape findings.

## Site

Host: `daotao.vnu.edu.vn` — classic ASP (not .NET), the shared "Cổng thông tin đào tạo đại học"
(undergraduate training portal) used across VNU member schools (not UET-specific). Distinct system
from UET's StudentHub/Canvas. Session model is classic ASP cookie auth, not bearer tokens.

## Auth

- `POST /dkmh/login.asp`: form-urlencoded body `txtLoginId` (username, often the student code),
  `txtPassword`, `chkSubmit`. On success, sets one or more session cookies (ASP session id +
  internal user-id cookies). On failure, re-renders the login form with HTTP 200 (no distinct
  error status), so credential validity must be verified by fetching an authenticated page
  afterward and checking the response isn't the login form again.
- No token/API auth path exists anywhere in the captured traffic — the whole portal is
  cookie-session based.

## Pages (all require the session cookie; paths are root-level, not under `/dkmh/`)

- `GET /StdInfo/TabStdSelf.asp`: student profile. Disabled/readonly fields: student code, full
  name, DOB, gender, degree level, training mode, program type, cohort, managing class, faculty,
  major. Also exposes a hidden `hidStdID` (internal student id) and the selected `UnivID` option
  value (internal faculty/university id) — both needed as query params for the exam page.
- `GET /ListPoint/listpoint_Brc1.asp`: transcript/grades, grouped by term (newest first, full
  history on one page, no pagination). Per-course columns: code, name, credits, 10-point score,
  letter grade, 4-point score. Trailing summary lines give total credits, cumulative credits, and
  cumulative GPA (4.0 scale). Term headers use `HỌC KỲ N - YYYY-YYYY. MÃ HỌC KỲ {maHK}`. Data
  rows have eight cells; the last cell's `detailPoint(...)` handler carries class id and term
  ordinal alongside display arguments. The shared grades parser extracts those optional ids and
  feeds both the own Grades mapping and the grouped server-side transcript model. `Brc2.asp`/`Brc3.asp` use the same table shape for double-major /
  transferred-in credits but are typically empty for most students.
- `GET /StdInfo/TabStdStudy.asp`: academic-progress tabs. Only the "Thông tin học tập" section has
  reliable per-student data: a term-by-term table of conduct/training score (0-100), term GPA, and
  cumulative GPA. Other sub-sections (commendations, discipline, scholarships, awards, overseas
  travel) render only an empty "add new" template row for most students — treated as empty state,
  not scraped as data.
- `GET /StdExamination/StdExamination.asp?selViewType=StdExam`: exam schedule. Requires
  `selUniv`/`selStd` (from the profile page's `UnivID`/`hidStdID`) and `vTermID` (an internal term
  id distinct from the grades page's term code — resolved by scraping this page's own term
  `<select>` options and matching against the target term code). Populated rows contain exam code
  (term-course composite), exam/course name, date, session+time, method (written / on-computer /
  listening+speaking), room (or "submit grade" for non-room exam types), and seat number.
- `GET /SiteManager/Syllabus/default.asp`: paginated syllabus/curriculum PDF listing (course code,
  name, credits, download link, file size, upload date). Only the first page is scraped — no
  adapter use case needs the full multi-page listing.
- `POST /Register/enrschedule.asp` and `/Register/RegisterPrint.asp`: both are dead ends for
  timetable data. One returns a "registration temporarily suspended" message; the other says
  course-registration viewing has moved entirely to a separate, uncaptured domain
  (`dangkyhoc.vnu.edu.vn`). Confirms this adapter cannot support timetable/registration.
- `GET /sitemanager/Forms/default.asp`: administrative forms list, same pagination shape as
  Syllabus, empty for the captured account. Not implemented.
- No notification, tuition/billing, or news endpoint was found anywhere in the captured traffic.

## Capability summary

`profile`, `terms`, `grades`, `exams`, `trainingPoints`, `documents` (syllabus), `classLookup`, and
`crossLookup` (transcript-header identity resolution, both directions, gated — see below) are
supported. `timetable`, `courses`, `assignments`, `attendance`, `notifications`, `tuition`, `news`,
`requests` are not — no verified real data source exists for them on this portal.

## Class-code -> internal-id lookup (classLookup capability)

- The `StdExamination.asp?selViewType=StdExam&vTermID=...` rows already read for `exams` also carry
  a hidden `hidCrdID` input in the first `<td>` (STT column) holding the portal's internal 6-digit
  class id — not exposed anywhere else. Each row's second `<td>` renders as
  `"{maHK}-{courseCode} {classNo}"` (e.g. `252-PHI1002 6`), but classNo's own shape isn't
  consistent: plain digits (`6`, `15`, `71`), dash-suffixed zero-padded (`241-FLF1107-01`), and
  alphanumeric group codes (`THL1057 CN7`) have all been observed. `parseExamCatalogHtml` in
  parser.ts treats `hidCrdID`'s presence as the row-detection signal (real data rows only) rather
  than depending on any `<tr>` attribute, and falls back to trusting the raw remainder text as
  classNo instead of re-validating its shape once the `maHK-courseCode` prefix is recognized.
  `parseExamCatalogHtml` also captures the same session/hour/method/room/seat columns
  `parseExamsHtml` does (same `<tr>`s, same column order) — a class resolved by internal id (the
  reverse-lookup direction) shows identical detail to the forward exam-schedule view.
- `TabStdSelf.asp` (already scraped for `profile`) exposes both the student's real student code
  (`StdCode` input) and their internal student id (`hidStdID` hidden input) in the same response —
  no separate endpoint needed for the "your own identifiers" half of this feature.
- The `vTermID` <-> `maHK` <-> academic-year mapping has no endpoint of its own (the exam page's own
  `selTermID` `<select>` only lists terms the *current* student already has exam rows for, not the
  full historical range), so it's captured as a static, hand-verified table in exam-terms.ts instead
  of being scraped. Ordinals are assigned per session slot chronologically, not arithmetically from
  maHK — years from 2020-2021 onward have an extra "HK2" session (maHK ending in 3, still labeled
  Học kỳ 2 for display) that consumes the next ordinal rather than leaving a gap.
- Not implemented (explicitly out of scope, pending live verification): drilling into a resolved
  class id for its own detail page. Cross-student identity resolution is now implemented — see the
  cross-student lookup section below.

## Point-detail drilldown (classLookup extension, live-verified)

- `GET /ListPoint/detailPoint.asp?id={classId}&val={grade10}&StdID={stdId}&Term={ordinal}` returns a
  per-component grade breakdown popup for one class. Header line:
  "Điểm chi tiết môn học — Học kỳ N năm học YYYY-YYYY. Mã học kỳ ZZZ". Columns:
  STT | Bản chất kỳ thi (exam nature, e.g. "Thi cuối kỳ" / "Giữa kỳ") | TS (weight, e.g. 0.6/0.4) |
  Lần thi (attempt) | Điểm (score) | Ghi chú (notes, usually empty). One row per exam component.
- The "Tổng điểm" footer is cosmetic only: it echoes the request's `val=` param back verbatim, with
  no server-side validation or recomputation (verified by reloading with two different `val` values —
  components identical, footer flipped). The authoritative total must come from
  `listpoint_Brc1.asp`'s "Điểm hệ 10 cuối cùng" column. Parsers expose the footer only as
  `displayTotalEcho`, never as a total/grade.

## Cross-student lookup (crossLookup capability, live-verified)

Live re-probing (authenticated session) CORRECTED earlier notes on this surface:

- `StdExamination.asp?...&selStd={foreignStdId}` SILENTLY IGNORES `selStd` — it always renders the
  SESSION OWNER's code/name/data. The earlier claim that it was a cross-student source (an IDOR)
  was wrong: it is a self-echo, never an IDOR. The old cross-lookup exam-schedule route built on
  that assumption was removed (it returned the caller's own data for any target StdID — a silent
  self-echo bug), and no `vTermID` is needed by any cross-lookup route anymore.
- `GET /ListPoint/listpoint_Brc1.asp?selStd={stdId}` (stdId zero-padded to 11 digits, e.g.
  `00000020000`) HONORS `selStd` — it renders THAT student's transcript page. Verified live with
  two foreign StdIDs plus the no-param self case. This is the ONLY verified student-role
  StdID -> identity source, and simultaneously the worst IDOR on the portal: the response contains
  the target's FULL transcript, not just the header. Hyeboard therefore never forwards this HTML —
  the worker parses the identity header server-side and only the resolved fields cross the wire.
- Brc1 identity header shape (verbatim, three adjacent header cells):
  `Sinh viên: {full name}` | `Mã số: {8-digit code}` | `Lớp quản lý: {managing class, e.g. QH-20XX-I/CQ-I-XXX0}`.
  `parseTranscriptHeader` in parser.ts extracts all three, failing closed to `{}` when the
  `Mã số:` label is absent (invalid StdID / portal notice page).
- `detailPoint.asp?StdID=` cross-student behavior remains as previously verified (unchanged; still
  not exposed by Hyeboard).

### Anchor/drift model (StdID <-> student code)

- Three anchor pairs were verified live within one cohort (values withheld — real student
  identifiers). Codes and StdIDs run near-parallel within a cohort, drifting roughly ±2 per 60
  IDs; offset-only mapping is therefore unreliable, which motivates the oracle-walk design.
- No portal endpoint maps a public code back to an internal StdID, so
  `GET /api/vnu/cross-lookup/student-id` walks the Brc1 oracle server-side from the caller's OWN
  `(StdID, code)` profile anchor. The verified near gate is `VERIFIED_NEAR_CODE_DELTA = 64`;
  targets within that gate use local linear correction (`guess += targetCode - headerCode`) with
  at most 8 exact-verification probes. Wider targets use a mirrored interval in the target
  direction: projected StdID = own StdID + code delta, with an additional
  `ceil(abs(delta) * 0.02) + 64` margin. The resolver bisects that interval for at most 12 probes,
  tracks the closest valid header, then uses a separate far post-bisection linear-refinement
  threshold of 10 code values and performs at most 10 linear-correction probes. One visited set
  spans both stages; the exported reachable and bulk-reserved hard maximum is 22 probes
  (12 bisection + 10 linear), and probes are spaced ~250ms apart. A malformed/header-less
  response aborts immediately; oscillation or exhaustion returns
  `VNU_CROSS_LOOKUP_NOT_CONVERGED` (404), never a guessed id. A resolved id is returned
  zero-padded to the portal's 11-digit shape with the total probe count.
- IMPORTANT RELEASE GATE: wide-span monotonic increase of `code(StdID)`, required by bisection,
  is now live-DISPROVEN — see "Wide-span probe evidence" below; it no longer merely lacks
  verification. Only short cohort-local drift has ever held. Far-target walking therefore stays
  disabled: only the literal environment or Cloudflare binding string
  `VNU_FAR_WALK_ENABLED=true` permits it, config-file values and all other string variants
  cannot, and no deployment should set it. The committed Cloudflare deployment default remains
  `false`.
- All cross-lookup routes share a per-session Brc1 probe budget: 300 upstream oracle fetches per fixed
  600-second window. Each fetch consumes one unit immediately before the upstream request. The
  Durable Object name is an HMAC of session-bound material, so no cookie or student identifier is
  present in its name or storage. The object stores only fixed-window `{ count, resetAt }` state;
  serialized Durable Object handling plus an atomic storage transaction makes the cap authoritative
  across Worker isolates and colos. Confirmed exhaustion fails before a fetch with
  `VNU_RATE_LIMITED` (429) and window retry detail. Durable Object or storage unavailability fails
  closed with `VNU_PROBE_BUDGET_UNAVAILABLE` (503) and a short retry hint. Neither error invalidates
  the Hyeboard session.
- `GET /api/vnu/cross-lookup/transcript` accepts exactly one of `stdId` or `stdCode` plus the same
  explicit opt-in. Direct-StdID mode consumes one budget unit for its transcript fetch. Student-code
  mode uses the shared far resolver (one unit per Brc1 oracle request), then deliberately performs
  one additional budgeted fetch for the final transcript. Its wire payload is parsed JSON only:
  identity `header` (`studentCode`, optional `studentName`/`className`), `terms` containing
  maHK-grouped parsed grade `rows`, and `totals` (`totalCredits`, `accumulatedCredits`, `gpa4`). Portal
  notice prose is never included in a foreign-student wire DTO. A missing identity header fails closed
  with stable `VNU_CROSS_LOOKUP_NOT_FOUND` (404) and never returns parsed grade rows. Raw Brc1 HTML never leaves the worker. Transcript successes and errors send
  `Cache-Control: no-store`; no transcript response or parsed data enters the application cache.
- All cross-lookup routes are gated identically: session guard, vnu-only, the literal
  `allowCrossLookup=true` opt-in (400 otherwise), own-profile-derived self-target rejection (400),
  and never cached. The resolver wire shapes are `{ studentCode, studentName?, className? }`
  (StdID -> code) and `{ stdId, stdCode, probes }` (code -> StdID); transcript shape is described above.
- `POST /api/vnu/cross-lookup/bulk` runs only parsed, ordered chunks (up to 5 direct-ID
  or transcript targets, or 3 code-resolver targets). Before any Brc1 request, one
  Durable Object transaction reserves the entire conservative allowance: 1 unit per
  direct target and the resolver's declared 22-unit hard maximum per code target.
  Item fetches spend this local allowance and never charge the Durable Object again.
  Reservations intentionally do not refund malformed, self, failed, or early-resolved
  items; this conservative loss prevents check-then-consume races.
  Malformed target strings remain in their original chunk and produce the per-item
  `VNU_CROSS_LOOKUP_INVALID_TARGET` code; only an empty run or more than 50 unique client targets
  prevents the whole run.

### Wide-span probe evidence (qualitative)

Wide-span live probes across wide spans from the caller's anchor settle the far-walk
release gate above. No identifiers, codes, or per-pair deltas are recorded here — shapes only:

- The StdID space spans multiple intake cohorts, with large student-code prefix jumps at cohort
  boundaries. No single code<->StdID slope exists across the space.
- Even WITHIN one cohort, `code(StdID)` stops being monotonic outside the immediate local neighborhood from the
  anchor: the local drift slope changes sign, so wide probes oscillate instead of converging.
- Consequence: neither bisection nor the linear far-walk can converge reliably at wide spans.
  `VNU_FAR_WALK_ENABLED` must remain `false` on every deployment. The near walk (near-anchor walk)
  remains the only verified-convergent range.
- Safety property: the resolver can never return a WRONG id in any mode — success requires
  exact equality between a probed header code and the target code. Far mode is unreliable
  (fails to converge), never incorrect.
- The reverse directions (StdID -> code, StdID -> transcript) are unaffected: each resolves
  with exactly one oracle fetch at arbitrary distance and never depends on monotonicity.

## Raw-proxy hardening (worker-side)

Because `listpoint_Brc1.asp` provably does not session-bind `selStd` (and `detailPoint.asp` does
not bind `StdID`), the worker's self-scoped `/api/vnu/raw/:page` proxy never honors
client-supplied `selStd`/`selUniv` for any key. For `exams` (and `point-detail` before it) both
ids are derived server-side from the session owner's own `TabStdSelf.asp` profile (`hidStdID` /
selected `UnivID`), the request fails closed with a 401 when the profile cannot provide them, and
the client params are stripped before cache keying so a smuggled value cannot even fragment cache
entries. The frontend therefore sends only `vTermID` (a term selector, not a per-student id).
Cross-student access remains available exclusively through the dedicated, explicitly gated
`/api/vnu/cross-lookup/*` routes above — the raw proxy can no longer be turned into an ungated
version of the same IDOR.
