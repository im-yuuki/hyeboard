# VNU GPA, Export, and Resolver Improvements Design

Status: approved (Option A)
Date: 2026-07-27

## Problem and evidence

Grades currently calculates each term average with every listed credit in the denominator and substitutes zero for a missing grade. An ungraded course therefore lowers the displayed GPA as if it were a graded failure. The calculation also exists only in the Grades page, so cross transcripts and downloaded data cannot share one definition.

VNU's `ListPoint/listpoint_Brc1.asp` response reports one global cumulative GPA. It does not report authoritative per-term GPA or CPA values for cross-student transcripts. The VNU owner's progress page has exact historical values, but using that owner-only source would make identical transcript rows produce different behavior by surface. This design uses clearly labeled estimates everywhere and keeps portal-reported cumulative values separate.

Lookup results have no portable export path. Users must copy values and tables manually, bulk errors lose context outside the page, and partially completed bulk runs cannot be retained before retrying.

The current student-code resolver contains a far bisection mode based on a disproven monotonic mapping between student codes and internal IDs. The reliable evidence supports only a bounded local projection neighborhood. The resolver must remove the far mode, search that neighborhood safely, and retain exact portal-header verification.

No raw captures, credentials, personal records, or live identifiers are part of this design.

## Goals

- Use one pure academic-summary calculator for Grades, cross transcripts, and exports.
- Correct the missing-grade denominator error and expose listed versus included credits.
- Label calculated GPA and CPA values as derived estimates.
- Export every usable Grades and Lookup result as structured JSON or deterministic CSV.
- Replace far bisection with a bounded, concurrent local resolver that can never return an unverified ID.
- Make resolver concurrency and the browser's whole-run bulk limit deployer-configurable.
- Preserve the Durable Object probe budget as the authoritative security boundary.
- Keep the selected compact Option A layout usable on mobile, by keyboard, and in all themes.

## Non-goals

- No server-generated export files, background export jobs, or export persistence.
- No user-selectable resolver concurrency.
- No unbounded or cohort-wide student-ID search.
- No claim that derived CPA is authoritative.
- No resurrection of far bisection or `VNU_FAR_WALK_ENABLED` under another gate.
- No configurable Durable Object probe budget.
- No change to the worker's per-request bulk chunk limits of three code targets or five direct-ID targets.

## Architecture

The work stays split by responsibility:

- `apps/web/src/lib/term-academic-summary.ts` owns term grouping, chronology, credit eligibility, term GPA, and running CPA. It is pure and has no React, network, storage, or localization dependency.
- `apps/web/src/lib/data-export.ts` owns sanitized export models, JSON serialization, CSV flattening, escaping, filename construction, and browser download cleanup.
- `apps/web/src/components/export-menu.tsx` owns the reusable `Export` dropdown, keyboard behavior, focus handling, and user-visible download errors.
- `apps/worker/src/vnu-student-id-resolver.ts` remains the isolated resolver. Route handlers supply validated anchors, budgeted probe functions, cancellation, and parsed header values.
- The shared schemas add optional runtime university limits. Worker config parsing is centralized so Cloudflare and self-hosted entry points consume the same effective values.

Views adapt their existing `Grade` and VNU transcript row shapes into the academic calculator. The same calculated result object feeds visible metrics and both export formats; views must not recalculate values.

## Derived academic summaries

### Eligibility and formulas

Each normalized course row has a term key, credit value, and nullable 4-point grade. The calculator produces these values for each grouped term:

- `listedCredits`: sum of finite, positive credits on all listed rows, including rows whose 4-point grade is absent.
- `includedCredits`: sum of finite, positive credits only where the 4-point grade is finite and non-null.
- `termGpa4`: credit-weighted 4-point average across included rows.
- `cpa4`: running credit-weighted 4-point average across included rows from the oldest term through the current term.
- `estimateKind`: the literal `derived` marker.

The term formula is `sum(credits * point4) / includedCredits`. CPA uses the same numerator and denominator accumulated through the term. A numeric zero grade is valid and included. Missing grades, missing credits, zero credits, negative credits, and non-finite numbers contribute neither weight nor score.

Calculations retain full numeric precision without intermediate rounding. UI presentation rounds GPA and CPA to two decimal places. JSON preserves numeric calculator output; CSV uses its canonical decimal string.

When a term has no included credits, its term GPA is absent. Its CPA remains the prior running estimate when one exists; otherwise CPA is absent. Listed credits remain visible so users can distinguish an ungraded term from an empty term.

The calculator does not infer official repeat, replacement, pass/fail, withdrawal, or program-exclusion rules. Every eligible listed row participates. Derived values may therefore differ from university results and must always carry the `Derived` label in UI and export metadata.

### Grouping and chronology

UET and Mock retain the existing summer rule: a term code ending in `3` groups with the corresponding term ending in `2`. Summer rows remain identifiable, but the combined group forms one GPA and CPA checkpoint.

CPA is calculated oldest to newest, independent of the selected display order. Apply the UET/Mock summer grouping first, then order recognized numeric term codes numerically. Unrecognized term keys retain stable source order rather than receiving a guessed academic position. Reversing groups for newest-first display must not change the CPA assigned to any term.

The same grouping and chronology path applies to own Grades, a single cross transcript, bulk transcript exports, and page-level exports. Tests lock the ordering and summer behavior before page integration.

### Reported values stay separate

Portal-reported values remain in the existing page-level or transcript-level summary. They are never overwritten by a derived value and never serialized under a derived key.

For VNU Brc1 data:

- `totals.gpa4` remains the portal-reported global cumulative GPA.
- Per-term GPA and CPA come only from the shared calculator and carry `estimateKind: "derived"`.
- Existing page-level portal summary values remain separate when present. The new term headers do not substitute VNU's owner-only exact progress history; they use the shared derived policy for consistency with cross transcripts.

Exports keep reported and derived sections distinct. CSV uses separate reported-cumulative and derived-term columns.

## Export design

### Covered result surfaces

An export control appears only when its result surface contains usable browser state.

| Surface | Export scope |
|---|---|
| Class lookup, forward | Submitted class query and resolved class result |
| Class lookup, reverse | Submitted internal class identifier and resolved class result |
| Student internal ID to code | Submitted ID and sanitized resolved identity |
| Student code to internal ID | Submitted code and exact resolver result |
| Own Grades term | That term's identity context, derived summary, and visible course rows |
| Own Grades page | All terms currently visible under the selected filter, in display order |
| Single cross transcript | Query, sanitized identity, reported totals, derived term summaries, and course rows |
| Bulk internal ID to code | Current completed items, including item errors |
| Bulk code to internal ID | Current completed items, including item errors and exact resolver metadata |
| Bulk internal ID to transcript | Current completed items, including transcript summaries, rows, and item errors |

Prompt, loading, unsupported, and single-result error states do not show an export control. A bulk run becomes exportable once it has at least one completed item. Cancellation or a later chunk failure does not remove that control.

Bulk run state is `complete` when every target has an item and `partial` otherwise. Partial exports include the run mode, processed count, total count, and every completed item in input order. Unprocessed targets are not mislabeled as failures. This lets a user retain successful and failed item results before retrying the remainder.

### JSON

JSON uses a versioned, structured document with stable machine keys. Common top-level keys are `schemaVersion`, `surface`, `universityId`, `query`, `run`, `identity`, `reported`, `derivedTerms`, and `results`; inapplicable optional sections are omitted. Transcript payloads keep identity, reported totals, derived term summaries, and course rows nested by term. Bulk payloads keep ordered items with `status: "ok"` plus `result`, or `status: "error"` plus `errorCode`.

The serializer builds each document from an explicit allowlist. It must not spread arbitrary query-cache or API objects into the export. Session tokens, cookies, raw HTML, portal notices, request headers, internal cache metadata, and telemetry fields have no export representation.

Identity context is optional. When sanitized state does not contain a field, the serializer omits it rather than refetching or reading another account-scoped cache entry.

### CSV

CSV is a flattened record stream with a fixed header and fixed column order. Shared leading columns cover record type, surface, run status, item index, item status, error code, query mode, query value, target, and university. Remaining columns cover:

- Identity: student code, internal student ID, student name, and managing class.
- Class results: class code, class number, internal class ID, and available resolved labels.
- Resolver results: resolved code, resolved ID, and probe count.
- Term summaries: term code, term label, estimate kind, listed credits, included credits, term GPA, derived CPA, and reported cumulative GPA where applicable.
- Course rows: course code, course name, credits, 10-point grade, letter grade, and 4-point grade.

The exact column order is `record_type`, `surface`, `run_status`, `item_index`, `status`, `error_code`, `query_mode`, `query_value`, `target`, `university_id`, `student_code`, `internal_student_id`, `student_name`, `managing_class`, `class_code`, `class_number`, `class_id`, `resolved_student_code`, `resolved_internal_student_id`, `probes`, `term_code`, `term_label`, `estimate_kind`, `listed_credits`, `included_credits`, `term_gpa4`, `derived_cpa4`, `reported_cumulative_gpa4`, `course_code`, `course_name`, `credits`, `point10`, `letter`, `point4`.

Simple lookup exports emit a query record followed by one result record. Transcript and Grades exports emit identity and reported-summary records first, then each term-summary record followed by its course records. Bulk exports process items in original input order. An errored item emits one item record with its stable status and error code. A successful transcript item emits its item identity, summary, and course records before the next item.

Given the same sanitized browser state, column order and row order are identical. CSV uses stable machine field names and raw enum codes rather than localized headings. Display sorting and filtering are part of browser state, so a Grades export follows the visible term and course order.

CSV encoding starts with a UTF-8 byte-order mark and uses CRLF row endings. Every field is stringified through one encoder: embedded double quotes are doubled, and fields containing a quote, comma, CR, or LF are enclosed in double quotes. Text fields that could start a spreadsheet formula after leading whitespace, including `=`, `+`, `-`, or `@`, are prefixed with an apostrophe before CSV quoting. Typed numeric values remain numeric; identifiers remain text.

### Browser download lifecycle

Downloads are created only after a user chooses JSON or CSV. `data-export.ts` serializes the already-sanitized in-memory model, creates a `Blob`, creates an object URL, triggers one download, removes the temporary anchor, and revokes the object URL on both success and failure.

Filenames use an allowlisted ASCII slug containing Hyeboard, the surface, and the current date. They contain no student name or identifier. Control characters, path separators, repeated separators, platform-reserved names, trailing dots or spaces, and overlong components are removed. The extension always matches the chosen format.

Export never refetches data. It never sends content to the worker, writes server storage, inserts a query-cache entry, or emits export content to logs, analytics, or telemetry.

## Student-code resolver

### Candidate construction

For validated positive safe-integer anchors and an eight-digit target code `T`, retain the original target string and use its numeric value to compute the arithmetic projection:

`G = ownStdId + (T - ownCode)`

If `G` is not a positive safe integer, return `VNU_CROSS_LOOKUP_NOT_CONVERGED` without a probe. Otherwise probe `G` first. Success requires exact string equality between the parsed eight-digit portal header code and the original target string. Numeric conversion is used only for projection and correction arithmetic.

If the first probe returns a valid different header code `C`, compute one corrected candidate:

`G + (T - C)`

When that candidate is a positive safe integer inside `G ± 16`, move it to the front of the remaining search order. Then search every unvisited candidate in the closed local window from `G - 16` through `G + 16`. The deterministic default order is increasing absolute distance, lower candidate before upper candidate: `G - 1`, `G + 1`, `G - 2`, `G + 2`, and so on. The prioritized correction is removed from its later default position, so no candidate is probed twice.

The full candidate set contains at most 33 internal IDs, including `G`. Candidates outside the positive safe-integer range are skipped. Exhausting all valid candidates without exact equality returns `VNU_CROSS_LOOKUP_NOT_CONVERGED`; the resolver never returns the projection or nearest observed code as a guess.

### Concurrency and deterministic behavior

The initial `G` probe runs first because its observed code may define the prioritized correction. Remaining candidates run through a bounded worker pool. Pool width is the effective `VNU_CODE_LOOKUP_CONCURRENCY`, capped by remaining candidates and the platform's active-request limit.

Candidate dispatch follows the deterministic priority order even when responses complete out of order. If multiple candidates unexpectedly return the same exact code, the earliest candidate in priority order wins. A later completion cannot overtake an unresolved earlier candidate. Once the winning exact result is known, lower-priority sibling requests are canceled.

The response's `probes` value counts candidate requests started against the local allowance, including siblings already dispatched before cancellation. It does not report the conservative reservation amount.

A concurrency value of one produces the same candidate order without parallel requests. Bulk items remain sequential. Concurrency exists only among candidates for one code resolver, never across bulk targets or browser chunks.

### Misses, fatal errors, and cancellation

A successful portal response with no parseable student-code header is a candidate miss. It does not end the search and does not supply a correction.

Request-layer failures are not candidate misses. Authentication or session failures, HTTP 429 responses, upstream 5xx responses, transport failures, and explicit request cancellation stop the resolver and preserve their error semantics. They must not collapse into `VNU_CROSS_LOOKUP_NOT_CONVERGED`.

Each resolver invocation uses a child abort controller linked to the incoming request and passes its signal to every candidate fetch. Caller cancellation, a fatal probe error, or a confirmed exact winner cancels active sibling probes. Resolver cleanup removes abort listeners and settles all started work. In bulk mode, ordinary invalid-target, not-found, and not-converged outcomes remain ordered item errors. A systemic auth, rate-limit, transport, or upstream failure ends the current chunk so the browser can retain earlier chunks as partial results.

### Probe reservations

Concurrency requires conservative reservation before any Brc1 request. The reservation table is:

| Operation | Reserved units |
|---|---:|
| Direct internal ID to code | 1 |
| Direct internal ID to transcript | 1 |
| Student code to internal ID | 33 |
| Student code to transcript | 34 |
| Bulk direct-ID mode | 1 per target in the accepted chunk |
| Bulk code mode | 33 per target in the accepted chunk |

Student-code transcript lookup reserves 33 candidate units plus one final transcript fetch. A successful resolver may reuse the exact winning probe's header identity, but it still performs the separately reserved final fetch to obtain transcript rows.

The worker reserves a whole route or chunk allowance atomically before the first Brc1 request. A rejected reservation performs no Brc1 work. Candidate probes consume only the local allowance and do not make per-probe Durable Object calls. Unused units from invalid targets, header holes, early exact matches, cancellation, and failures are not refunded.

Remove all far-mode constants, branches, tests, documentation, bindings, and config handling. `VNU_FAR_WALK_ENABLED` no longer exists.

## Runtime configuration and university metadata

### Parsing rules

Two non-secret settings control the new behavior:

| Setting | Missing value | Valid values | Malformed value |
|---|---:|---|---|
| `VNU_CODE_LOOKUP_CONCURRENCY` | 16 | Any positive safe integer | Fall back to 1 |
| `VNU_CROSS_LOOKUP_BULK_MAX_TARGETS` | 50 | Zero or any positive safe integer | Disable bulk with effective value 0 |

Environment, Wrangler, and Worker binding values accept canonical base-10 ASCII integer strings only: `0` or a non-zero digit followed by digits. Whitespace, signs, decimals, exponents, hexadecimal forms, leading zeroes on non-zero values, empty strings, and values above `Number.MAX_SAFE_INTEGER` are malformed. Concurrency rejects zero because it must be positive.

Malformed config may produce a generic warning naming the setting and effective fallback. Logs, API errors, and metadata must never echo the raw value.

One central parser returns the effective concurrency and bulk limit. Cloudflare bindings, Wrangler defaults, self-hosted environment variables, and equivalent `config.json` fields all flow through that parser. Self-hosted file fields use `vnu.code_lookup_concurrency` and `vnu.cross_lookup_bulk_max_targets`; they accept JSON safe integers or canonical decimal strings and normalize them before effective-value parsing. Other JSON types are malformed. Environment variables override file values. Regenerate `apps/worker/worker-configuration.d.ts` after updating Wrangler bindings.

The resolver's actual pool width is bounded by the 33-candidate set and any lower platform request-concurrency bound. Large configured values do not create more candidates or bypass platform limits. There is no browser control for concurrency.

### Published bulk limit

Extend the runtime `University` schema with optional `limits.crossLookup.bulkMaxTargets`. The value is a non-negative safe integer representing the effective server configuration. `/api/universities` publishes it for an available VNU cross-lookup capability. Other universities may omit the structure.

The browser reads this metadata and validates the deduplicated target count for the entire run before creating chunks. Zero or a missing limit hides the bulk surface. A positive value replaces the hardcoded client limit of 50. There is no product-level ceiling; deployers may choose any positive safe integer.

Worker request validation keeps the existing limits of three code targets and five direct-ID or transcript targets. The browser still sends sequential chunks. The Durable Object budget remains the security boundary and may reject a syntactically valid chunk regardless of the published browser limit.

An arbitrary positive bulk limit can produce a long client run. Durable Object budget enforcement may pause or reject later chunks as windows fill. The UI keeps completed chunks, reports progress and retry state, and leaves partial-result export available.

## Selected UI: Option A

### Grades and transcript terms

Each term uses one compact header. The term label and summer indicator sit on the left. Compact Term GPA, CPA, and included-credit metrics follow. One visible `Derived` marker identifies the metric group. The credit metric always distinguishes included credits from listed credits, including when the values are equal. The `Export` dropdown aligns right.

The all-terms view repeats this header for every visible term. A page-level export in the Grades page header exports all currently visible terms. A single-term filter exports only that term at page level, while the term's own export remains available beside it.

Cross transcript term headers use the same metric and action alignment. Portal-reported cumulative GPA remains in the transcript-level summary, labeled separately from term estimates. Transcript and bulk section headers align their export action with the title rather than creating a nested action card.

### Lookup result actions

Successful class forward/reverse and student ID/code result rows place `Export` inline with the resolved value. The control belongs to the result row, not the form. Replacing or clearing a submitted query removes the stale export model with the stale result.

Bulk shows one section-level export control when completed items exist. It remains available during a later chunk, after cancellation, and after a chunk-level error. All three bulk modes use the same control and format choices.

### Interaction and visual constraints

`Export` is one button with a chevron and a menu containing JSON and CSV. The trigger and menu items support keyboard navigation, Escape dismissal, visible focus, correct accessible names, and focus return after selection or dismissal. Download failures use a polite live region; they do not rely on console output.

Headers wrap cleanly on narrow screens. Primary controls, including the `Export` trigger and menu choices, maintain a 44px touch target. Long labels and identifiers wrap without forcing page-level horizontal scroll. Transcript and Grades tables remain width-bounded inside their existing overflow containers.

The layout must work in light, dark, neutral Demo, and UET themes. It uses flat rows, restrained borders, and existing tokens. Do not add nested cards, gradients, glow effects, shadow hover effects, or side-stripe accents.

All new app-authored text is added to both English and Vietnamese dictionaries. Export machine keys and error codes remain stable and untranslated.

## Security and privacy

- Build exports from typed, sanitized browser state only. Never fetch or expose raw Brc1 HTML for export.
- Keep session credentials, Authorization headers, cookies, cache keys, portal notices, and internal request metadata out of JSON and CSV.
- Keep every cross-lookup response on `Cache-Control: no-store`, including metadata-driven limit errors and resolver failures.
- Preserve per-session Durable Object isolation. Reservation identity remains an opaque HMAC and stores no student identifier.
- Do not log target lists, returned identity fields, transcript rows, export content, or malformed raw config values.
- Use synthetic identifiers and academic rows in tests, fixtures, screenshots, and documentation.
- Export is an explicit local browser action. No export content enters server storage, browser persistence, query-cache writes, analytics, or telemetry.

## Error and state behavior

Feature-specific resolver, budget, and export errors stay inline and do not clear a valid Hyeboard session. Genuine session-death codes retain existing global handling.

Changing lookup mode, query input, university account, or session nonce invalidates the associated export model. A result from one session must never remain exportable after account switching. Bulk retry appends only results for the same mode and run; changing mode or targets resets prior progress and export state.

An export serialization or download failure leaves the visible result intact. It reports a localized live error and permits retry without refetching.

## Testing

### Academic calculator

Write failing unit tests first for:

- Credit-weighted term GPA with unequal positive credits.
- Running CPA across multiple terms in chronological order.
- Missing 4-point grades excluded from numerator and included credits while remaining in listed credits.
- A numeric zero grade included as a real grade.
- Missing, zero, negative, and non-finite credits excluded safely.
- A term with no included rows and a later graded term.
- Stable unknown-term ordering.
- Existing UET/Mock summer grouping and one combined CPA checkpoint.
- Identical calculations for normalized own Grades and cross transcript rows.
- Reported cumulative values remaining separate from derived estimates.

### Export helpers

Cover JSON structure and allowlisting for every surface. Verify bulk success/error records, partial-run metadata, identity/query/result rows, term summaries, and course rows.

CSV tests must assert the UTF-8 BOM, fixed columns, deterministic row order, CRLF endings, commas, quotes, CR/LF content, empty values, Unicode text, and formula-injection defense after leading whitespace. Filename tests cover control characters, separators, reserved names, extension mismatch attempts, overlong input, and the no-identity filename rule. Browser lifecycle tests prove object URLs are revoked after successful and failed downloads.

### Resolver

Use synthetic oracle responses to cover:

- A target code delta of `+89` whose true ID is projection error `+2`.
- Exact success at the initial projection.
- A first-probe correction inside the local window receiving priority.
- Headerless holes at the projection and among remaining candidates.
- Exact-header equality as the only success condition.
- Full local-window exhaustion returning `VNU_CROSS_LOOKUP_NOT_CONVERGED`.
- Deterministic candidate dispatch and winner selection under out-of-order completion.
- Concurrency 1, 16, 32, and custom values, including values above the 33-candidate cap.
- No duplicate candidates after correction prioritization.
- Caller cancellation, fatal sibling cancellation, and exact-winner sibling cleanup.
- Authentication, session, 429, transport, and 5xx failures propagating instead of becoming misses.
- At most 33 candidate units and no far-mode branch or flag.

### Worker and metadata

Worker tests cover missing, valid, zero, malformed, and overflow config values for both settings without raw-value echo. Test Cloudflare and self-hosted config precedence through the same parser. Verify `/api/universities` publishes the effective optional bulk limit and preserves capability masking when the coordinator is unavailable.

Reservation tests assert one atomic reservation before Brc1 work, 33 units for code-to-ID, 34 for code-to-transcript, 33 per bulk code target, unchanged direct-ID costs, and no refund. A rejected or unavailable reservation must perform no Brc1 request. Preserve `no-store` on every cross-lookup response and prove session-budget isolation.

Bulk tests keep item execution sequential while demonstrating resolver-only concurrency. Systemic resolver failures stop the chunk; ordinary per-item failures retain ordered status/error records.

### UI and end-to-end

Add UI coverage for JSON and CSV export from class forward/reverse, both student identifier directions, own Grades term and page scopes, a single cross transcript, and all bulk modes. Assert configured whole-run maximum behavior, zero-limit hiding, absent-limit hiding, unchanged 3/5 chunking, partial export after cancellation or rejected later chunk, and no refetch during export.

Verify derived term metrics, listed/included credit distinction, portal-reported separation, all-terms repeated headers, current-filter page export, responsive wrapping, 44px targets, bounded tables, keyboard menu operation, focus return, live errors, both locales, dark mode, and UET theming.

## Release gates

Run from the repository root:

```bash
pnpm build
pnpm test
pnpm --filter @hyeboard/web exec playwright test --workers=1
pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run
git diff --check
git status --short
```

Then review the complete diff. Confirm generated Worker types match Wrangler config, `VNU_FAR_WALK_ENABLED` has no remaining active source, config, test, or operational documentation reference outside this historical design record, and no export path refetches or persists data.

Perform manual browser review at 390x844, 768x1024, and 1440x900. Check Grades single-term/all-terms, cross transcript, class and student identifier results, completed and partial bulk runs, both export formats, keyboard-only use, both locales, light/dark modes, and neutral/UET themes.

Before release, scan the diff, fixtures, snapshots, downloads, and logs for personal data, live identifiers, raw HTML, credentials, tokens, and HAR-derived content. Review reservation arithmetic, cancellation cleanup, object URL cleanup, CSV formula defense, API metadata compatibility, and the absence of unbounded search or client-controlled concurrency.

## Acceptance criteria

- Missing grades no longer count as zero or enter the GPA denominator.
- Every displayed per-term GPA and CPA uses the shared pure calculator and is marked `Derived`.
- Portal-reported cumulative GPA remains separately labeled and serialized.
- Every usable result surface offers one JSON/CSV export control with no network request.
- Partial bulk results remain exportable after cancellation or a rejected chunk.
- CSV output is deterministic, BOM-prefixed, quoted safely, and protected from spreadsheet formula execution.
- The resolver probes only the 33-candidate local window and returns only an exact portal-header match.
- Far bisection and `VNU_FAR_WALK_ENABLED` are removed.
- Resolver concurrency is centrally configured, bounded, cancelable, and unavailable as a UI control.
- The browser enforces the published whole-run bulk maximum; zero disables bulk; worker chunk limits remain 3/5.
- Durable Object reservations remain authoritative, atomic, per session, non-refundable, and ahead of Brc1 work.
- Arbitrarily large configured bulk limits remain possible but may produce long runs subject to Durable Object pauses or chunk rejection.
- Automated, manual, privacy, diff, and dry-run release gates pass before deployment.
