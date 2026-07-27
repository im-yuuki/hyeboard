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
- `GET /ListPoint/listpoint_Brc1.asp?selStd={stdId}` (stdId zero-padded to 11 digits) HONORS
  `selStd` — it renders THAT student's transcript page. Verified live with foreign StdIDs plus the
  no-param self case. This is the ONLY verified student-role
  StdID -> identity source, and simultaneously the worst IDOR on the portal: the response contains
  the target's FULL transcript, not just the header. Hyeboard therefore never forwards this HTML —
  the worker parses the identity header server-side and only the resolved fields cross the wire.
- Brc1 identity header shape (verbatim, three adjacent header cells):
  `Sinh viên: {full name}` | `Mã số: {8-digit code}` | `Lớp quản lý: {managing class}`.
  `parseTranscriptHeader` in parser.ts extracts all three, failing closed to `{}` when the
  `Mã số:` label is absent (invalid StdID / portal notice page).
- `detailPoint.asp?StdID=` cross-student behavior remains as previously verified (unchanged; still
  not exposed by Hyeboard).

### Resolver runtime status (StdID <-> student code)

- Cross-lookup runtime policy parses code-lookup concurrency and the bulk-target maximum from
  deployment configuration. Concurrency is not yet consumed by route execution. When
  `crossLookup` is available, capability metadata publishes the configured bulk maximum.
- The legacy student-code resolver remains temporarily internal while its replacement is integrated.
  Current public documentation therefore does not promise a search span, scheduling model, or
  request-budget semantics.

### Wide-span probe evidence (qualitative)

No identifiers, codes, or per-pair deltas are recorded here; only response-shape conclusions remain:

- Internal-ID space crosses intake cohorts with discontinuous student-code prefixes, so no global
  code-to-ID slope exists.
- Within a cohort, observed drift can change direction outside the immediate projection
  neighborhood.
- Consequence: wide bisection, long linear correction, and other far-search assumptions are
  rejected. Current runtime policy does not treat wide-span monotonicity as valid.
- Reverse directions from a known internal ID remain direct operations and do not depend on
  monotonicity.

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
