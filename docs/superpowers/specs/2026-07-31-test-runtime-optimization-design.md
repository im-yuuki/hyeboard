# Test Runtime Optimization Design

Status: approved
Date: 2026-07-31

## Context

The current repository test baseline is:

- `pnpm test`: 18.7 seconds for 882 tests.
- Playwright: approximately 290 seconds for 172 cases.
- Browser coverage is concentrated in one 3,153-line `smoke.spec.ts`.
- Two Playwright workers still spend most runtime in project-level serial chains.

The target is this Windows reference machine as identified at benchmark time by its reported processor model, package/core/logical-processor counts, and RAM. The earlier run reported 8 logical processors; do not infer 16 solely from the Ryzen 7 7700 model. The approved objective is to keep the same important behavioral coverage while reducing concurrent `pnpm test` plus optimized Playwright wall time to less than 60 seconds.

## Goals

- Preserve every important existing assertion at least once.
- Move browser-independent logic and model assertions to Vitest.
- Make Chromium the comprehensive integration browser.
- Keep targeted WebKit coverage for browser- and mobile-sensitive behavior.
- Split Playwright coverage into independent domain files that can run safely in parallel.
- Use test-scoped authenticated-page fixtures when authentication behavior is not under test.
- Remove timing sleeps and other avoidable serialization.
- Make the optimized suite the default Playwright path.
- Pass the exact performance gate for three consecutive no-retry runs.

## Non-goals

- Reducing coverage by deleting assertions solely to meet the runtime target.
- Preserving the current Playwright case count or one-case-per-assertion structure.
- Testing pure calculations, formatting, filtering, or state transitions through a browser when Vitest can prove them directly.
- Running every integration flow in both Chromium and WebKit.
- Adding more browser engines, visual-regression infrastructure, external test services, or production telemetry.
- Optimizing application production runtime.
- Changing product behavior to make tests easier.

## Test-layer design

### Vitest

Move assertions that do not require browser rendering, navigation, focus, storage, downloads, responsive layout, or browser networking into focused Vitest suites. This includes pure/model behavior such as:

- data transformation, grouping, sorting, filtering, and derived values;
- route-independent state transitions and error classification;
- serializers, filename construction, and export model construction;
- deterministic permission, capability, and feature-state decisions;
- helper-level locale and presentation selection where DOM behavior is irrelevant.

Extraction must preserve production boundaries. Do not duplicate application logic inside tests or replace an integration contract with a test-only implementation.

### Chromium

Chromium owns comprehensive integration coverage:

- login gate, school selection, demo login, logout, and authentication failures;
- routing and every feature route's real rendered state;
- account menu, sidebar, header search, notifications, settings, themes, and locale switching;
- grades, timetable, exams, assignments, documents, requests, training points, lookup, and export flows;
- API error rendering, session-death handling, feature-specific authentication errors, and account isolation;
- keyboard, focus, download, storage, and responsive behavior not assigned exclusively to WebKit.

Each important application integration is required once in Chromium unless it is explicitly allocated to WebKit or Vitest in the coverage map.

### WebKit

WebKit runs only targeted browser/mobile-sensitive checks:

- mobile navigation drawer opening, dismissal, focus, and viewport containment;
- responsive sidebar/header behavior and touch-target interactions;
- browser-sensitive select, menu, download, storage, and focus behavior;
- theme and locale persistence where WebKit behavior differs or has regressed;
- a minimal authenticated route and API-proxy smoke check.

Business-data assertions already covered by Vitest or Chromium are not repeated in WebKit unless needed to establish a browser-specific contract.

## Coverage allocation

| Existing coverage area | Primary optimized layer | Required retained evidence |
| --- | --- | --- |
| Pure calculations, transforms, filters, serializers, and state models | Vitest | Input/output and edge-case assertions |
| Login gate and authentication itself | Chromium Playwright | Redirects, validation, success, failure, and session effects |
| Authenticated feature routes | Chromium Playwright with authenticated fixture | Route renders bound UI, key interaction works, errors remain scoped |
| Account menu, search, notifications, settings, themes, and locale | Chromium Playwright | Visible state and user interaction |
| Desktop navigation and sidebar collapse | Chromium Playwright | Layout, state, and accessibility behavior |
| Mobile drawer, touch layout, and viewport containment | WebKit targeted Playwright, with one Chromium integration where needed | Browser-sensitive responsive behavior |
| Keyboard, focus, select/menu, storage, and downloads | Chromium by default; WebKit only for sensitive contracts | Browser-observable behavior |
| API envelope and Worker route semantics | Vitest/worker tests | Status, payload, error, and session contracts |
| Vite-to-Worker proxy integration | One Playwright smoke per retained browser project | Request reaches the matching Worker and returns expected data |
| Stateful account/session races | Isolated Playwright or focused unit state-machine tests | No cross-test or cross-account leakage |

## No-loss mapping

Before removing or rewriting any case from `smoke.spec.ts`, create a checked-in coverage map that assigns every existing important assertion to one destination test. Each entry records:

- source test and assertion intent;
- destination layer, file, and test name;
- whether coverage is exact, consolidated, or intentionally browser-specific;
- rationale for any consolidation or browser reduction.

One destination test may cover several source assertions, and one source flow may be split across layers. No source assertion may disappear without an explicit determination that it is redundant with named retained evidence. Case-count reduction is acceptable; assertion-intent loss is not. Review must compare the map against 172 legacy two-project executions and the reviewed logical inventory of 86 tests (72 Chromium-designated + 14 targeted WebKit). Moving four pure CSV cases to Vitest leaves 68 Chromium + 14 WebKit browser tests.

## Playwright structure and fixtures

Split the monolithic spec into independent domain files, including authentication, shell/navigation, account/settings, feature routes, academic features, lookup/export, and responsive/browser-sensitive behavior. Files must not depend on execution order or state created by another file.

Use test-scoped fixtures, pages, contexts, counters, gates, and browser storage. Do not share authenticated `storageState`: these tests assert localStorage accounts, tab-local sessionStorage, account removal, refresh grants, and expiry. A test-scoped authenticated-page fixture may perform synthetic login when login is not the subject. Authentication tests must use the real path under test.

Stateful tests that mutate accounts, locale, theme, storage, downloads, or session lifecycle use fresh contexts and unique synthetic identities. Tests requiring strict internal order may remain serial inside the smallest possible describe block; unrelated files and domains remain parallel.

No test may use fixed sleeps. Wait on observable conditions: locator state, navigation, response completion, application state, or explicit readiness endpoints. Keep retries disabled for acceptance runs so failures cannot be hidden by reruns.

## Parallelism and server topology

The optimized suite uses a controlled worker count between four and six. Start at four, increase only when benchmark evidence shows lower runtime without higher variance, resource contention, or flakes. CI or lower-capacity machines may select a lower explicit count, but the approved workstation gate uses the chosen value in this range.

Each Playwright run owns one correctly coupled server pair:

- Vite listens on an explicit web port.
- Worker listens on an explicit API port.
- Vite's `/api/*` proxy target uses that exact Worker port.
- Playwright `baseURL` uses that exact Vite port.
- Startup waits for both services to become ready before tests begin.
- Teardown stops only the processes started by that run.

Ports come from one configuration source and are passed explicitly to Vite, Wrangler, and Playwright. Do not combine a reused Vite process with a different Worker port. Concurrent optional suites must receive separate paired ports to prevent cross-run traffic or false readiness.

## Commands

`pnpm test` remains the repository unit/type test command. The normal Playwright command becomes the optimized Chromium-plus-targeted-WebKit suite. Root `pnpm test:fast` starts both commands concurrently with the controlled worker configuration:

```bash
pnpm test:fast
```

An optional full/audit command may retain broader duplicated browser coverage, single-worker diagnostics, or additional projects. It is not part of the default fast path or the under-60-second gate. Command naming must clearly distinguish the default optimized suite from the optional audit suite.

## Flakiness and regression safeguards

- Retries remain zero during benchmarks and required verification.
- Tests use locators and observable readiness, never fixed delays.
- Network mocks and fixtures are deterministic, synthetic, and local.
- Mutable browser state and fixture data are test-scoped; only immutable Vite/Worker infrastructure is shared.
- No test relies on file order, worker assignment, prior login, or another test's downloaded data.
- Stateful serial blocks stay minimal and documented by dependency reason.
- Port selection, proxy target, and readiness checks fail fast on mismatch.
- Worker count changes require three-run timing and flake comparison.
- Any assertion moved to Vitest retains at least one browser integration check for the surrounding user-visible flow.
- Failures must produce traces or equivalent diagnostics without enabling retries.

## Benchmark gates

Benchmark from the repository root on the runtime-identified reference machine. Record and compare processor model/package/core/logical counts and RAM before every attempt; fail on a difference. Use the default optimized configuration, no retries, no unrelated dev servers on selected ports, and no other intentional CPU-heavy workload.

One measured run is concurrent wall-clock duration from the common start until both commands finish, including their resource contention:

```bash
pnpm test:fast
```

Acceptance requires all of the following:

1. Both commands pass in each run.
2. Playwright reports zero retries and zero flaky tests.
3. Each concurrent run completes in less than 60.0 seconds; an average below 60 seconds is insufficient if any run reaches 60.0 seconds. A sequential diagnostic reports the sum of both elapsed times and cannot satisfy acceptance.
4. The gate passes three consecutive runs without changing code, configuration, worker count, or selected projects between runs.
5. Every assertion from 172 legacy project executions maps through the 86-test logical inventory to passing evidence: 68 Chromium + 14 WebKit + 4 pure CSV Vitest cases.
6. `pnpm test` retains all existing test coverage after migrations; moved tests may change package totals, but no unit or contract assertion is silently dropped.

Record common-start elapsed time, runtime topology, configured worker count, ports, and strict Playwright JSON counts/results/retries/flakes/failures by project under ignored `apps/web/test-results/runtime-benchmark/`. Fail before each attempt if a port is occupied; after each attempt poll for release and fail on a leak; never kill an unknown process. A failed, retried, flaky, topology-changed, leaked, or 60.0-second-or-slower run resets the consecutive-run count.

The reproducible gate runs through the repository's available Node.js runtime (`node scripts/benchmark-test-runtime.mjs`). It spawns unit and browser commands concurrently, preserves both exit codes, and imports the same validated runtime configuration as Playwright.

## Risks

- Excessive consolidation can hide assertion loss. The reviewed no-loss map prevents deletion by case count alone.
- Broad authenticated fixtures can bypass session behavior. Real authentication remains mandatory wherever auth is under test.
- Higher worker counts can create CPU, memory, port, or upstream contention. Parallelism stays bounded and benchmarked.
- Shared storage can create order-dependent flakes. Mutable state stays test-scoped.
- Reduced WebKit scope can miss engine-specific regressions. Targeted browser-sensitive contracts and a proxy smoke remain.
- Incorrect Vite/Worker coupling can produce stale or cross-run API traffic. One-source paired ports and dual readiness checks are mandatory.
- Fast local caches can distort results. Three unchanged consecutive runs establish sustained performance rather than a single best result.

## Acceptance criteria

- Default Playwright execution uses split independent domain files, four to six controlled workers, comprehensive Chromium, and targeted WebKit.
- Pure/model assertions run in Vitest; browser-observable contracts remain in Playwright.
- Authenticated fixtures bypass login only when authentication is outside the test's purpose.
- Stateful tests remain isolated, and serialization is limited to proven local dependencies.
- No fixed sleep remains in the optimized suite.
- Vite and Worker ports are explicitly paired with the correct proxy and Playwright base URL.
- Every important existing assertion has reviewed retained coverage at least once.
- Three consecutive no-retry concurrent runs each pass both commands in wall-clock time below 60.0 seconds on the runtime-identified reference machine.
- Optional full/audit coverage, if retained, does not slow or alter the default optimized path.
