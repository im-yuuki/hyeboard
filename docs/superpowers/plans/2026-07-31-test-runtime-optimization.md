---
status: not-started
phase: 0
updated: 2026-07-31
---

# Test Runtime Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every important test assertion at least once while making three consecutive zero-retry `pnpm test:fast` runs complete in under 60.0 seconds each on this reference machine as identified by runtime-reported processor model, logical-processor count, and memory.

**Architecture:** Vitest owns pure transformations, serializers, state models, races, and CSV contracts. Fully parallel Chromium owns comprehensive integration; explicitly tagged `@webkit` tests own only 14 mobile/browser-sensitive contracts. All browser fixtures and contexts are test-scoped. No shared `storageState` is allowed because this suite asserts account-local `localStorage`, tab-local `sessionStorage`, account removal, and session expiry. One deterministic Vite/Wrangler pair uses fixed, correctly coupled ports with no server reuse. The configured worker count is the single source consumed by Playwright and the benchmark.

**Tech Stack:** TypeScript 6, Vitest 4, Playwright 1.61, Chromium, WebKit, Vite 8, Wrangler 4, pnpm 11, Node.js.

**Approved design:** `docs/superpowers/specs/2026-07-31-test-runtime-optimization-design.md`

---

## Goal

Reduce the measured baseline from 18.7 seconds plus approximately 290 seconds to a strict concurrent wall time below 60.0 seconds without assertion-intent loss, retries, sleeps, sharding, push, or deployment. `test:fast` starts `pnpm test` and default Playwright together; elapsed time runs from their common launch until both exit, so CPU/server contention is part of the gate. Sequential diagnostics must report the sum instead and cannot satisfy acceptance.

## Context & Decisions

| Decision | Rationale | Source |
| --- | --- | --- |
| Preserve assertion intent, not the current 172-case shape | Consolidation is allowed only when named retained evidence proves the same contract | Approved design §§ Goals, No-loss mapping |
| Use Vitest for pure/model/race decisions | Browser startup and navigation add no evidence for deterministic logic | Approved design § Test-layer design |
| Run comprehensive Chromium and targeted WebKit | Cross-engine duplication caused most of the current 290-second runtime | Approved design §§ Chromium, WebKit |
| Select WebKit with project-level `grep: /@webkit/`; exclude it from Chromium with `grepInvert` only after replacements pass | Explicit tags make the inventoried 72 Chromium-only + 14 WebKit source allocation reviewable; four pure Chromium CSV cases then move to Vitest | [Projects/filtering](https://playwright.dev/docs/test-projects#test-filtering), [grep API](https://playwright.dev/docs/api/class-testconfig#test-config-grep), [tags](https://playwright.dev/docs/test-annotations#tag-tests), `ref:close-blush-quokka` |
| Set `fullyParallel: true`, zero retries, and benchmark configured workers from 4 through 6 | A monolithic file otherwise uses one worker per project; accepted tuning must become config, script, and report input | [Fully parallel](https://playwright.dev/docs/test-parallel#parallelize-tests-in-a-single-file), [workers](https://playwright.dev/docs/api/class-testconfig#test-config-workers), `ref:close-blush-quokka` |
| Do not add local sharding first | Full parallelism and balanced files should remove present serialization without duplicated runner/server overhead | [Sharding](https://playwright.dev/docs/test-sharding), `ref:close-blush-quokka` |
| Reuse one fixed server pair within a run, but never reuse pre-existing processes | Playwright starts a `webServer` array once per invocation; all test-scoped contexts may share those immutable servers | [webServer](https://playwright.dev/docs/test-webserver), `ref:close-blush-quokka` |
| Use strict explicit ports and `reuseExistingServer: false` | A stale Vite process can proxy to the wrong Worker and produce false readiness or cross-run traffic | [webServer](https://playwright.dev/docs/test-webserver), `ref:close-blush-quokka` |
| Use test-scoped login/setup fixtures; do not share `storageState` | Although state can cover cookies/localStorage, Playwright documents separate `sessionStorage` handling; this suite deliberately tests both stores and account/session mutation | [`storageState`](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state), [sessionStorage](https://playwright.dev/docs/auth#session-storage), [fixtures](https://playwright.dev/docs/test-fixtures), `ref:close-blush-quokka` |
| Keep retries at zero in config, commands, and benchmark script | Retries hide flakes and invalidate the acceptance gate | Approved design §§ Flakiness, Benchmark gates |
| Parse Playwright JSON, not console prose | Per-project counts, outcomes, retries, and flaky status must be machine-validated | [JSON reporter](https://playwright.dev/docs/test-reporters#json-reporter) |

Research basis: Playwright configuration and fixture choices above follow the findings from delegation `close-blush-quokka` (`ref:close-blush-quokka`). The concrete 86-test allocation and extraction boundaries come from `driving-tan-scorpion` (`ref:driving-tan-scorpion`).

## Worktree and Scope Guard

Run every implementation and verification command from:

```text
F:\Workspace\hyeboard\.worktrees\test-runtime-under-60s
```

- Stage only paths named by the active task. Never use `git add .` or `git add -A`.
- Keep product behavior unchanged. Extractions must become production dependencies, not test-only copies.
- Use synthetic local fixtures only. Add no HAR data, real identity, token, cookie, credential, or upstream call.
- Do not push, merge, rebase, deploy, or run `pnpm deploy`.
- Do not weaken timeouts, assertions, or error checks to obtain a faster number.
- Do not use `page.waitForTimeout`, fixed timers, retries, or test-order dependencies.

## File Map

### Create

- `apps/web/tests/coverage-map.md`: one reviewed row per original assertion intent, including parameter and project expansion, destination test, disposition, and rationale.
- `apps/web/tests/fixtures/base.ts`: test-scoped storage reset, demo login/page, navigation, overflow, and viewport helpers.
- `apps/web/tests/fixtures/vnu.ts`: test-scoped VNU session/new-tab/reconnect factories; each factory returns local counters and release promises.
- `apps/web/tests/fixtures/lookup.ts`: test-scoped lookup setup, synthetic records, modes, and response helpers.
- `apps/web/tests/helpers/export.ts`: download, request-count, RFC 4180, JSON/CSV equivalence, menu, and theme helpers.
- `apps/web/tests/auth-login.spec.ts`: unauthenticated gate, school-specific login, auth failures, CAPTCHA, inline re-auth, and plaintext-storage contracts.
- `apps/web/tests/vnu-session-lifecycle.spec.ts`: account switching, logout, session death, refresh, and cross-account isolation.
- `apps/web/tests/shell-dashboard.spec.ts`: account menu, navigation, search, notifications, theme, locale, settings, dashboard, and shell accessibility.
- `apps/web/tests/lookup.spec.ts`: class/student lookup UI, one bulk happy path, one cancellation/refresh integration, pagination, and downloads.
- `apps/web/tests/grades-export.spec.ts`: grades term selection/sorting plus one end-to-end JSON/CSV/download/menu contract.
- `apps/web/tests/timetable-features.spec.ts`: timetable layouts, feature-route UI, and proxy smoke.
- `apps/web/tests/responsive-accessibility.spec.ts`: viewport, touch-target, overflow, focus, and internal-scroll contracts.
- `apps/web/playwright.audit.config.ts`: temporary legacy two-project monolith runner retained until final mapping and replacement pass.
- `apps/web/src/lib/playwright-runtime-config.ts`: pure parsing and validation for ports, proxy target, and the controlled 4-6 worker range.
- `apps/web/src/lib/playwright-runtime-config.test.ts`: valid defaults/overrides plus invalid worker and port combinations.
- `apps/web/src/lib/account-action-state.ts`: pure ownership/generation reducer for stale account-action completion decisions extracted from React state.
- `apps/web/src/lib/account-action-state.test.ts`: pending, failed, superseded, switched-account, and closed-owner race matrices.
- `apps/web/src/lib/grade-view-model.ts`: pure grade sorting, selected-term derivation, and export-view construction extracted from the page.
- `apps/web/src/lib/grade-view-model.test.ts`: sort direction, term identity, summer merge inputs, and current/all-term export selection.
- `scripts/benchmark-test-runtime.mjs`: concurrent three-run gate, topology/port validation, shared runtime-config import, JSON parsing, and fail-fast acceptance checks.

### Modify

- `apps/web/playwright.config.ts:3-36`: one validated port source, correct proxy environment, strict non-reused servers, `fullyParallel`, configured workers, zero retries, Chromium `grepInvert`, and WebKit `grep` after replacement verification.
- `apps/web/vite.config.ts:25-31`: consume the exact Playwright Worker target supplied to Vite; retain the development fallback.
- `package.json:7-28`: add concurrent `test:fast` using existing `concurrently`; keep direct unit and Playwright commands available for diagnosis.
- `apps/web/src/state.tsx:75-264`: delegate account-action ownership and stale-completion decisions to the tested pure model.
- `apps/web/src/pages/grades.tsx:37-100,279-383`: delegate sorting and export-view derivation to the tested pure model.
- `apps/web/src/lib/bulk-lookup.test.ts`: absorb bulk sequencing, retry, reset, pagination, malformed-result, and cancellation intent removed from repeated browser flows.
- `apps/web/src/lib/data-export.test.ts`: absorb CSV parser/record parity, exact ordering, allowlist, filename, and model assertions removed from browser-only checks.
- `apps/web/src/lib/term-academic-summary.test.ts`: absorb newest/default term, summer merge, collision-safe identity, GPA, CPA, and missing-grade assertions.
- `apps/web/src/lib/api.test.ts`: retain session-death classification, active/inactive account isolation, token rotation, and stale-response races at request/state boundaries.
- `apps/web/src/lib/vnu-refresh.test.ts`: retain refresh policy, no-replay, cancellation, and late-completion races.

### Delete only after coverage-map review and replacement pass

- `apps/web/tests/smoke.spec.ts`: remove only after every row in `coverage-map.md` names passing retained evidence.
- `apps/web/playwright.audit.config.ts`: remove in the same final transition only after the original affected flows and full legacy audit pass.

### Explicit Non-Changes

- No schema, adapter, Worker route, API envelope, product copy, styling, or production runtime change.
- No new browser engine, visual snapshots, cloud service, production telemetry, or sharded local runner.
- No persistence of real authentication artifacts. Generated reports remain under ignored test-output paths.

## Coverage Inventory and Migration Mapping

`apps/web/tests/coverage-map.md` is the authoritative no-loss ledger. The source currently expands to 172 two-project executions. The reviewed logical inventory is exactly **86 tests: 72 designated Chromium-only and 14 tagged `@webkit`** (`ref:driving-tan-scorpion`). Four of the 72 are pure CSV contracts moved to Vitest, leaving a final Playwright count of **82: 68 Chromium + 14 WebKit**. Reconcile all three views without blindly retaining duplicate engines.

The inventory has eight extraction domains. Move the four pure CSV contract cases from the proposed `csv-contract.spec.ts` domain into `src/lib/data-export.test.ts`; keep the other seven browser specs and counts:

| Extraction domain | Destination | Retained allocation |
| --- | --- | --- |
| CSV contract | `src/lib/data-export.test.ts` | 4 pure Vitest cases; 0 browser |
| Authentication/login | `tests/auth-login.spec.ts` | 7 Chromium, 3 WebKit |
| VNU session lifecycle | `tests/vnu-session-lifecycle.spec.ts` | 23 Chromium |
| Shell/dashboard | `tests/shell-dashboard.spec.ts` | 13 Chromium, 3 WebKit |
| Lookup | `tests/lookup.spec.ts` | 18 Chromium, 1 WebKit |
| Grades/export | `tests/grades-export.spec.ts` | 4 Chromium, 1 WebKit |
| Timetable/features | `tests/timetable-features.spec.ts` | 2 Chromium, 2 WebKit |
| Responsive/accessibility | `tests/responsive-accessibility.spec.ts` | 1 Chromium, 4 WebKit |

Keep the exact shared boundaries from the inventory: `tests/fixtures/base.ts`, `tests/fixtures/vnu.ts`, `tests/fixtures/lookup.ts`, and `tests/helpers/export.ts`. Fixtures are test-scoped only. Counters, gates, route handlers, pages, contexts, account identity, and release callbacks must remain test-local. Do not create or consume shared authenticated `storageState`.

Use these required destinations:

| Current source area in `smoke.spec.ts` | Required destination evidence |
| --- | --- |
| 680-710: CSV parser and exact-record helper self-tests | `data-export.test.ts`: RFC 4180 controls/quotes, injected/reordered record rejection, JSON/CSV model parity |
| 712-767: login gate and school-specific sections | `auth-login.spec.ts`: `redirects an anonymous dashboard request`, `renders each school's supported login path` |
| 769-877: VNU plaintext, expiry cleanup, grant import | `auth-login.spec.ts` browser storage checks plus `api.test.ts` account/grant state assertions |
| 907-969: new-tab grant absence and active/inactive descriptor removal matrix | `api.test.ts` expanded active/inactive/live/expired matrix; `vnu-session-lifecycle.spec.ts` new-tab integration |
| 1016-1080: reconnect status, localization, refetch, inactive account | `vnu-refresh.test.ts` and `api.test.ts` model/request assertions; one localized status/refetch flow in `vnu-session-lifecycle.spec.ts` |
| 1082-1412: revoke failure, stale owner, newer action, route/menu close, account switch races | `account-action-state.test.ts` complete generation/ownership matrix; one failed revoke and one superseded-action browser integration |
| 1414-1489: concurrent expiry and six inline nonterminal errors | `api.test.ts` classification matrix; `vnu-session-lifecycle.spec.ts` concurrent-switch and table-driven inline UI evidence |
| 1491-1528: accent, account menu/sign-out, demo dashboard | `auth-login.spec.ts` real demo-login assertion; dashboard and shell assertions in `shell-dashboard.spec.ts` |
| 1530-1665: mobile containment, status labels, theme, sidebar, drawer | `shell-dashboard.spec.ts` and `responsive-accessibility.spec.ts`, with only inventory-marked cases tagged `@webkit` |
| 1667-1712: header search and capability-gated Lookup absence | `shell-dashboard.spec.ts` search integration; `lookup.spec.ts` capability-gated route/nav assertion |
| 1714-1785: lookup groups, own detail, limits, deduplication | `lookup.spec.ts` visible controls/key interaction; pure limit/deduplication matrix in `bulk-lookup.test.ts` |
| 1786-2268: bulk modes, chunks, partial export, 429, cancellation, refresh, reset, account freshness, pagination, malformed success | `bulk-lookup.test.ts` and `data-export.test.ts` own full model/race matrix; `lookup.spec.ts` keeps one full mode/download flow, one refresh/cancel flow, and pagination rendering |
| 2270-2434: single lookup exports, spaced codes, stale errors, client validation | `lookup.spec.ts` keeps each visible form once and one real download; existing `university-course-search.test.ts`, `data-export.test.ts`, and input-model tests own permutations |
| 2436-2442: notifications | `shell-dashboard.spec.ts`: menu opens and renders notification/empty state |
| 2444-2618: grade terms, sorting, GPA/CPA, exports, collision-safe terms, metadata gate | `grade-view-model.test.ts`, `term-academic-summary.test.ts`, and `data-export.test.ts`; `grades-export.spec.ts` keeps selection/sort/render and one metadata-gated export integration |
| 2620-2746: export keyboard/theme/print/failure/localization/responsive menu | `data-export.test.ts` owns model/serializer/failure decisions; Chromium keeps keyboard/print/localized failure, WebKit keeps tagged focus/download/menu containment contract |
| 2748-2790: desktop/mobile/tablet timetable | `timetable-features.spec.ts`: one Chromium desktop contract and two tagged WebKit responsive contracts |
| 2792-2841: every feature route and key document/course/exam interactions | `timetable-features.spec.ts`: one Chromium route assertion set; no raw JSON and empty-state checks retained |
| 2843-2856: VNU document search without refetch | `university-course-search.test.ts` exact filtering; one `lookup.spec.ts` bound search/no-refetch integration |
| 2858-2987: mobile login labels, CAPTCHA, inline re-auth | `auth-login.spec.ts`, with exactly the three inventory-marked cases tagged `@webkit` |
| 2989-3153: About, three viewport loop, headings, aria-current, search label, touch targets, mobile tables, focus rings | `shell-dashboard.spec.ts` semantic checks and `responsive-accessibility.spec.ts` exact 1 Chromium + 4 WebKit allocation |

For every ledger row, record: source title and line, assertion intent, original projects/parameters, destination layer/file/test, `exact`/`consolidated`/`browser-specific`, and rationale. A source row can name multiple destinations. A destination can satisfy several source rows only when all individual assertions are listed.

## Dependency and Commit Order

```text
0 deterministic baseline + budgets
  -> 1 inventory + pure migrations
    -> 2 test-scoped fixtures + replacement specs
      -> 3 replacement proof + optimized filtering
        -> 4 monolith removal
          -> 5 benchmark gate and tuning
```

Five implementation commits. Each commit must pass its focused tests and `pnpm test` before the next commit. Benchmark tuning does not change coverage allocation without updating the ledger in the same commit.

---

## Phase 0: Deterministic Baseline and Budgets [IN PROGRESS]

### Task 0: Measure before restructuring

**Files:**
- Create: `apps/web/playwright.audit.config.ts`
- Modify: `apps/web/playwright.config.ts` only for explicit paired ports, strict port behavior, `reuseExistingServer: false`, and `retries: 0`
- Record: ignored `apps/web/test-results/runtime-benchmark/phase0/`

- [ ] **0.1 Record actual machine topology** ← CURRENT

Before every Phase 0 and acceptance attempt, query Windows processor data at runtime. Record processor model string, socket/package count, core count, summed logical-processor count, RAM, OS, Node, pnpm, and Playwright versions in the attempt JSON. Do not infer topology from “Ryzen 7 7700”: the earlier benchmark reported 8 logical processors even though that model commonly exposes 16. This machine's runtime report is authoritative. Fail the series if model, package/core/logical counts, or RAM differ between attempts; report both snapshots rather than normalizing them.

- [ ] **0.2 Enforce deterministic Windows ports**

Before every attempt, inspect TCP listeners for 5173 and 8787 (or the configured pair). If either is occupied, fail before launch and print PID/local endpoint; never stop or kill an unknown process. Start Playwright with strict fixed ports and `reuseExistingServer: false`. After every success or failure, poll both ports for release for up to 15 seconds; fail the attempt as a server leak if either remains bound, again without killing it.

- [ ] **0.3 Capture exact baseline and representative slices**

Run zero-retry `pnpm test`, the legacy two-project suite through `playwright.audit.config.ts`, one representative Chromium slice (`friendly demo login`, VNU lifecycle, lookup bulk, grades export, desktop route), and one representative mobile-Safari/WebKit slice (login label/CAPTCHA, drawer, export menu, timetable mobile, internal table scroll). Use Playwright JSON output under `apps/web/test-results/runtime-benchmark/phase0/`; record elapsed, selected/listed/executed/passed/skipped/failed/flaky counts per project and strict parse status. Preserve the monolith and legacy project behavior.

- [ ] **0.4 Apply intermediate budgets**

Use these non-negotiable checkpoints:

| Checkpoint | Budget |
| --- | --- |
| Phase 0 | Measurement only; exact baseline and slices must parse and pass |
| After each pure extraction | `pnpm test` ≤ 25.0 s; affected original browser flow passes; representative slice no more than 10% slower than Phase 0 |
| Before changing project grep or deleting monolith | Replacement Playwright ≤ 40.0 s and concurrent `pnpm test:fast` ≤ 55.0 s for three unchanged runs |
| Final acceptance | Three consecutive concurrent `pnpm test:fast` runs each < 60.0 s |

The 55-second pre-deletion target provides a 5-second margin for normal contention. A result from sequential execution is diagnostic only: report `unit elapsed + Playwright elapsed`, not `max(...)`.

Expected: deterministic baseline artifacts exist; machine identity and ports are validated; no source test is removed or filtered.

## Phase 1: Inventory and Pure-Test Migration [PENDING]

### Task 1: Freeze the no-loss coverage ledger

**Files:**
- Create: `apps/web/tests/coverage-map.md`
- Read: `apps/web/tests/smoke.spec.ts`

- [ ] **1.1 Expand the baseline inventory**

List every top-level test, loop case, and parameter case. Reconcile 172 legacy two-project executions to the reviewed logical inventory of 86: 72 designated Chromium-only + 14 `@webkit`; then record four pure CSV cases moving from Chromium to Vitest, producing 68 Chromium + 14 WebKit. Split tests containing unrelated assertions into multiple intent rows.

- [ ] **1.2 Assign every intent to retained evidence**

Apply the migration table above. Mark repeated WebKit business-data checks `consolidated` into Chromium or Vitest; mark mobile/focus/storage/download/select/menu checks `browser-specific` only when retained in `@webkit` coverage.

- [ ] **1.3 Review the ledger before moving tests**

Verify no intent lacks a destination and every destination has an exact planned test name. Keep the ledger reviewable in the first implementation commit; do not delete `smoke.spec.ts` yet.

### Task 2: Move pure grade and account-action logic behind tested production boundaries

**Files:**
- Create: `apps/web/src/lib/account-action-state.ts`
- Create: `apps/web/src/lib/account-action-state.test.ts`
- Create: `apps/web/src/lib/grade-view-model.ts`
- Create: `apps/web/src/lib/grade-view-model.test.ts`
- Modify: `apps/web/src/state.tsx`
- Modify: `apps/web/src/pages/grades.tsx`

- [ ] **2.1 Write RED race-model tests**

Cover exact pending account, failed revoke ownership, route/menu owner closure, stale older completion after newer success, account switch, and grant cleanup decisions. Assert returned state/actions, not React internals.

- [ ] **2.2 Implement the minimal account-action model and wire `state.tsx` to it**

Keep effects and storage writes in `state.tsx`; move only deterministic ownership/generation transitions. Then run the original affected revoke, stale-owner, route/menu-close, and account-switch flows from `smoke.spec.ts` through the audit config. Remove or filter nothing.

- [ ] **2.3 Write RED grade-view tests**

Cover ascending/descending course and point sorting, newest/default/all-term selection, raw collision-safe term identity, and export ordering.

- [ ] **2.4 Implement the minimal grade view model and wire `grades.tsx` to it**

Use existing `term-academic-summary.ts` and `data-export.ts`; do not duplicate GPA or serializer logic. Then run the original affected grade term, sorting, GPA/CPA, and export flows through the audit config. Remove or filter nothing.

- [ ] **2.5 Run focused and repository tests**

```powershell
pnpm --filter @hyeboard/web exec vitest run src/lib/account-action-state.test.ts src/lib/grade-view-model.test.ts src/lib/term-academic-summary.test.ts src/lib/data-export.test.ts src/lib/bulk-lookup.test.ts src/lib/api.test.ts src/lib/vnu-refresh.test.ts
pnpm test
```

Expected: both commands and original affected browser flows pass; migrated assertions appear in the ledger with exact test names; Phase 0 intermediate budgets hold.

### Task 3: Complete pure/model migration for bulk, exports, terms, and session races

**Files:**
- Modify: `apps/web/src/lib/bulk-lookup.test.ts`
- Modify: `apps/web/src/lib/data-export.test.ts`
- Modify: `apps/web/src/lib/term-academic-summary.test.ts`
- Modify: `apps/web/src/lib/api.test.ts`
- Modify: `apps/web/src/lib/vnu-refresh.test.ts`
- Modify: `apps/web/tests/coverage-map.md`

- [ ] **3.1 Add failing tests for unmapped pure intents**

Add only gaps identified by the ledger: exact bulk retry/reset/pagination inputs, partial ordering, malformed response stripping, all four pure CSV contract cases, CSV parity/order, filename construction, collision-safe terms, session-death classification, refresh no-replay, cancellation, and late completion. CSV parsing and record equivalence stay in Vitest, not a Playwright spec.

- [ ] **3.2 Make the smallest production changes needed for testability**

Prefer exporting an existing pure helper. Extract only when logic currently lives inside a page closure. Never recreate production behavior in the test. After each extraction, run its original affected `smoke.spec.ts` flows through `playwright.audit.config.ts`; do not batch all legacy proof at phase end.

- [ ] **3.3 Run all web Vitest and repository tests**

```powershell
pnpm --filter @hyeboard/web exec vitest run src
pnpm test
```

Expected: pass with no removed existing unit assertion.

- [ ] **3.4 Commit Phase 1**

```powershell
git add apps/web/tests/coverage-map.md apps/web/src/lib/account-action-state.ts apps/web/src/lib/account-action-state.test.ts apps/web/src/lib/grade-view-model.ts apps/web/src/lib/grade-view-model.test.ts apps/web/src/state.tsx apps/web/src/pages/grades.tsx apps/web/src/lib/bulk-lookup.test.ts apps/web/src/lib/data-export.test.ts apps/web/src/lib/term-academic-summary.test.ts apps/web/src/lib/api.test.ts apps/web/src/lib/vnu-refresh.test.ts
git commit -m "test(web): migrate browser-independent coverage to Vitest"
```

## Phase 2: Test-Scoped Runtime and Fixtures [PENDING]

### Task 4: Fix server coupling and controlled parallelism

**Files:**
- Create: `apps/web/src/lib/playwright-runtime-config.ts`
- Create: `apps/web/src/lib/playwright-runtime-config.test.ts`
- Modify: `apps/web/playwright.config.ts`
- Modify: `apps/web/vite.config.ts`
- Modify: `package.json`

- [ ] **4.1 Add a config-level validation test or import check**

Validate worker count is an integer from 4 through 6, Vite and Worker ports differ, both ports are explicit, and Vite receives `VITE_PROXY_TARGET=http://127.0.0.1:<worker-port>`.

- [ ] **4.2 Configure deterministic servers**

Set `fullyParallel: true`, the validated initial configured worker value `4`, and `retries: 0`. Keep both readiness URLs. Preserve Phase 0's `reuseExistingServer: false`, Vite `--strictPort`, occupied-port failure, and exact Vite→Worker proxy coupling. Do not pass a separate worker value from benchmark commands.

- [ ] **4.3 Prepare, but do not activate, optimized project filtering**

Define the final Chromium `grepInvert: /@webkit/` and WebKit `grep: /@webkit/` shape in the ledger and replacement tests, but keep the legacy audit config and monolith unfiltered until all replacements pass. Keep traces on failure. Do not add a third project or local shards.

- [ ] **4.4 Prove proxy correctness before suite migration**

Run one existing API-backed Chromium test with ports overridden to an unused pair, then repeat with the Worker port intentionally occupied or mismatched and verify startup fails instead of passing against another process.

```powershell
$env:PW_VITE_PORT = "5175"
$env:PW_WORKER_PORT = "8789"
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --project=chromium --grep "friendly demo login" --retries=0
```

Expected: selected test passes through the paired proxy using the configured worker count; mismatch probe fails fast. Clear both port environment variables afterward.

- [ ] **4.5 Add the concurrent fast-path command**

Add root `test:fast` through the Node benchmark runner, which starts `pnpm test` and zero-retry default Playwright concurrently, captures both exits independently, and succeeds only when both pass strict JSON/count/runtime validation. This command is the acceptance workload; direct commands remain diagnostics.

### Task 5: Add isolated test-scoped fixtures

**Files:**
- Create: `apps/web/tests/fixtures/base.ts`
- Create: `apps/web/tests/fixtures/vnu.ts`
- Create: `apps/web/tests/fixtures/lookup.ts`
- Create: `apps/web/tests/helpers/export.ts`

- [ ] **5.1 Build test-scoped base and authenticated-page setup**

Move storage reset, `loginDemo`, `clickVisibleNavigationLink`, overflow/viewport assertions, and optional `loginDemoPage` into `fixtures/base.ts`. Each test receives a fresh page/context and performs its own synthetic setup. Do not create a worker-scoped page/context, auth import, account, or `storageState` file.

- [ ] **5.2 Extract VNU and lookup factories without shared state**

Move the exact VNU/new-tab/reconnect and lookup factories listed in the inventory into `fixtures/vnu.ts` and `fixtures/lookup.ts`. Every invocation returns test-local counters, request maps, promise gates, and release callbacks. Keep new-tab pages in the originating test context so localStorage is shared while sessionStorage remains tab-local.

- [ ] **5.3 Keep storage semantics explicit**

Use per-test `addInitScript` only where a scenario requires pre-navigation sessionStorage. Auth, plaintext deletion, account removal, grant import, and expiry tests must establish and inspect their own real test state. No test may inherit shared authenticated state.

- [ ] **5.4 Replace sleeps with observable readiness helpers**

Replace the 350 ms sidebar sleep with transition completion/computed layout polling. Helpers may wait on locator state, response, request settlement, navigation, event, or explicit readiness only.

- [ ] **5.5 Commit Phase 2**

```powershell
git add apps/web/playwright.config.ts apps/web/playwright.audit.config.ts apps/web/vite.config.ts package.json apps/web/src/lib/playwright-runtime-config.ts apps/web/src/lib/playwright-runtime-config.test.ts apps/web/tests/fixtures/base.ts apps/web/tests/fixtures/vnu.ts apps/web/tests/fixtures/lookup.ts apps/web/tests/helpers/export.ts
git commit -m "test(web): add deterministic parallel Playwright fixtures"
```

## Phase 3: Comprehensive Chromium Split [PENDING]

### Task 6: Split authentication and account/session coverage

**Files:**
- Create: `apps/web/tests/auth-login.spec.ts`
- Create: `apps/web/tests/vnu-session-lifecycle.spec.ts`
- Modify: `apps/web/tests/coverage-map.md`

- [ ] **6.1 Move authentication-purpose tests to base Playwright**

Use the real demo login or targeted network stubs. Retain the exact inventory allocation: 7 Chromium and 3 `@webkit`. Cover anonymous redirect, school sections, success/failure, plaintext absence, storage cleanup, CAPTCHA, and inline re-auth. Never use authenticated setup when login/session establishment is the assertion.

- [ ] **6.2 Keep only browser-observable account/session races**

Retain the inventory's 23 Chromium VNU lifecycle cases until consolidation is separately proven in the ledger. Point each later-consolidated permutation to its passing Vitest matrix and named browser evidence.

- [ ] **6.3 Prove file independence**

Run each file alone, then together with the configured worker count and repeated scheduling through `--repeat-each=2`. Results must not depend on prior storage, test order, or worker assignment.

```powershell
pnpm --filter @hyeboard/web exec playwright test tests/auth-login.spec.ts tests/vnu-session-lifecycle.spec.ts --project=chromium --retries=0
pnpm --filter @hyeboard/web exec playwright test tests/auth-login.spec.ts tests/vnu-session-lifecycle.spec.ts --project=chromium --repeat-each=2 --retries=0
```

Expected: pass, zero retries, no shared-state failures.

### Task 7: Split fixture-backed Chromium domains

**Files:**
- Create: `apps/web/tests/shell-dashboard.spec.ts`
- Create: `apps/web/tests/lookup.spec.ts`
- Create: `apps/web/tests/grades-export.spec.ts`
- Create: `apps/web/tests/timetable-features.spec.ts`
- Create: `apps/web/tests/responsive-accessibility.spec.ts`
- Modify: `apps/web/tests/coverage-map.md`

- [ ] **7.1 Build shell/dashboard suite**

Use test-scoped setup. Preserve the inventory's 13 Chromium + 3 WebKit shell/dashboard cases: navigation, search, notifications, account menu, settings, theme/locale, headings, aria-current, labels, focus, and dashboard behavior.

- [ ] **7.2 Build lookup suite**

Keep each visible form and validation state once, one full bulk mode with chunk/render/download evidence, one refresh/cancellation integration, one pagination rendering flow, and spaced-course search/no-refetch. Move permutations and serializer comparisons to named Vitest tests.

- [ ] **7.3 Build grades/export suite**

Keep newest-term rendering, one term switch and row expansion, one sort interaction, metadata-gated export availability, one JSON/CSV download with filename/focus/no-refetch evidence, keyboard menu behavior, print behavior, and localized local failure.

- [ ] **7.4 Build Chromium responsive suite**

Build `timetable-features.spec.ts` with 2 Chromium + 2 WebKit and `responsive-accessibility.spec.ts` with 1 Chromium + 4 WebKit exactly as inventoried. Keep the generated viewport loop intact. Tag only the 14 inventory-marked WebKit tests across all domain files.

- [ ] **7.5 Run all new Chromium files with configured workers**

```powershell
pnpm --filter @hyeboard/web exec playwright test tests/auth-login.spec.ts tests/vnu-session-lifecycle.spec.ts tests/shell-dashboard.spec.ts tests/lookup.spec.ts tests/grades-export.spec.ts tests/timetable-features.spec.ts tests/responsive-accessibility.spec.ts --project=chromium --retries=0
```

Expected: replacements pass with configured workers and no fixed sleeps. Run matching original `smoke.spec.ts` flows through `playwright.audit.config.ts` after each pure extraction/domain replacement; do not activate grep or delete the monolith.

- [ ] **7.6 Commit Phase 3**

```powershell
git add apps/web/tests/auth-login.spec.ts apps/web/tests/vnu-session-lifecycle.spec.ts apps/web/tests/shell-dashboard.spec.ts apps/web/tests/lookup.spec.ts apps/web/tests/grades-export.spec.ts apps/web/tests/timetable-features.spec.ts apps/web/tests/responsive-accessibility.spec.ts apps/web/tests/coverage-map.md
git commit -m "test(web): split comprehensive Chromium integration coverage"
```

## Phase 4: Targeted WebKit and Monolith Removal [PENDING]

### Task 8: Prove and activate explicitly tagged WebKit contracts

**Files:**
- Modify: `apps/web/playwright.config.ts`
- Read: seven replacement domain specs
- Modify: `apps/web/tests/coverage-map.md`

- [ ] **8.1 Verify the exact 14 `@webkit` flows**

Every selected title must carry the explicit `@webkit` tag. Reconcile the per-file allocation to 3 auth-login, 3 shell-dashboard, 1 lookup, 1 grades-export, 2 timetable-features, and 4 responsive-accessibility. Do not create a separate catch-all WebKit spec or repeat business data beyond each browser contract.

- [ ] **8.2 Verify project selection with list output**

```powershell
pnpm --filter @hyeboard/web exec playwright test --list --project=chromium
pnpm --filter @hyeboard/web exec playwright test --list --project=webkit
```

Expected: Chromium lists exactly 68 tests and no `@webkit` title; WebKit lists exactly 14 tagged tests. The four removed Chromium CSV cases have passing Vitest destinations. Counts match `coverage-map.md`. Activate `grepInvert`/`grep` only now, after every replacement and corresponding legacy flow passes.

- [ ] **8.3 Run targeted WebKit alone and combined**

```powershell
pnpm --filter @hyeboard/web exec playwright test --project=webkit --retries=0
pnpm --filter @hyeboard/web exec playwright test --retries=0
```

Expected: pass, zero retries, zero flaky tests.

### Task 9: Review no-loss evidence and delete the monolith

**Files:**
- Delete: `apps/web/tests/smoke.spec.ts`
- Modify: `apps/web/tests/coverage-map.md`

- [ ] **9.1 Reconcile every original assertion**

Compare the ledger against all 172 legacy project expansions, all 86 inventoried logical tests, and the final 82-browser + 4-Vitest allocation. Each important assertion must name a passing destination. Any redundant row must name the exact retained test proving it; `redundant` alone is invalid. Run the full legacy audit config once more before deletion.

- [ ] **9.2 Pass the pre-deletion runtime margin**

Run the replacement suite and three unchanged concurrent `pnpm test:fast` attempts with JSON evidence. Require Playwright ≤ 40.0 seconds and `test:fast` ≤ 55.0 seconds each. Keep `smoke.spec.ts` and `playwright.audit.config.ts` if any mapping, parse, count, retry/flaky, failure, port, topology, or budget check fails.

- [ ] **9.3 Delete legacy files only after reconciliation and budget proof**

Search optimized tests for forbidden timing and serialization:

```powershell
git grep -n -E 'waitForTimeout|setTimeout|describe\.serial|test\.slow' -- apps/web/tests
git grep -n 'serial' -- apps/web/tests
git grep -n "@webkit" -- apps/web/tests
```

Expected: first command returns no optimized-suite match; second returns only intentional titles/documentation.

- [ ] **9.4 Run default unit and Playwright commands**

```powershell
pnpm test
pnpm --filter @hyeboard/web exec playwright test --retries=0
```

Expected: both pass; Playwright reports zero retries and zero flaky tests.

- [ ] **9.5 Commit Phase 4**

```powershell
git add apps/web/playwright.config.ts apps/web/tests/coverage-map.md
git rm apps/web/tests/smoke.spec.ts apps/web/playwright.audit.config.ts
git commit -m "test(web): target WebKit browser-sensitive coverage"
```

## Phase 5: Runtime Gate and Evidence [PENDING]

### Task 10: Add the reproducible benchmark gate

**Files:**
- Create: `scripts/benchmark-test-runtime.mjs`
- Read: `package.json` Phase 2 `test:fast` command

- [ ] **10.1 Implement strict concurrent timing and machine/config discovery**

The Node script must run from the repository root and import the same validated runtime config used by `apps/web/playwright.config.ts`. Record the effective host, ports, and worker count in every result. Query and compare actual processor model/package/core/logical counts and RAM before every attempt; fail on any difference. Candidate worker measurements may use `--workers=4|5|6`; final acceptance uses the committed default without an override.

Use the Phase 2 `test:fast` command, which starts these commands together and requires both to succeed:

```powershell
pnpm test
pnpm --filter @hyeboard/web exec playwright test --retries=0 --reporter=json
```

Use a monotonic stopwatch around `pnpm test:fast`; elapsed begins before the common launch and ends only after both children finish. This intentionally includes resource contention. Preserve both exit codes. A sequential diagnostic may time each command separately, but must report their sum and cannot count toward acceptance.

- [ ] **10.2 Enforce Windows port ownership and cleanup per attempt**

Before every attempt, fail if either configured port has a listener; report endpoint/PID and never kill it. After every success or failure, poll both ports for release for up to 15 seconds and fail on a leak. The next attempt must repeat preflight; no attempt inherits a server.

- [ ] **10.3 Write and strictly parse ignored JSON artifacts**

Set `PLAYWRIGHT_JSON_OUTPUT_FILE` to a unique path per attempt under existing ignored `apps/web/test-results/runtime-benchmark/run-N/`. Parse the reporter artifact according to Playwright's JSON schema. Record listed/executed/passed/skipped/failed/flaky counts separately for Chromium and WebKit, every result retry ordinal, unexpected outcomes, command exits, configured workers, topology, ports, and elapsed time. Fail on missing/unparseable JSON, unknown project, duplicate test identity, count mismatch from 68 Chromium + 14 WebKit, any retry ordinal above zero, any flaky/unexpected/failed result, or nonzero exit.

- [ ] **10.4 Enforce consecutive-run semantics**

Fail immediately and reset the count when either command fails, JSON validation fails, topology changes, a port is occupied/leaked, any retry/flaky result appears, project counts differ, or concurrent wall time is greater than or equal to 60.0 seconds. Do not average away a failed gate. Do not change code, projects, configured workers, or config between accepted runs.

- [ ] **10.5 Run the acceptance benchmark**

Before starting, close known owned dev servers normally and avoid other CPU-heavy work. Never kill an unknown listener. Then run:

```powershell
pnpm benchmark:test-runtime
```

Expected: three consecutive rows with unchanged runtime-reported topology and configured workers, 68 Chromium + 14 WebKit, both commands passing, zero retries/flakes/failures, released ports, and concurrent wall time `< 60.0 s`.

### Task 11: Apply evidence-driven fallback only if the target is missed

**Files:**
- Modify only files implicated by measured timings
- Modify: `apps/web/tests/coverage-map.md` when allocation changes

- [ ] **11.1 Capture a timing breakdown without changing coverage**

Use Playwright JSON output to rank slow tests, setup time, and project totals. Confirm server startup, proxy readiness, worker utilization, and fixture import counts. Do not add sharding yet.

- [ ] **11.2 Remove remaining avoidable browser work**

For top slow flows, consolidate repeated navigation into one domain flow, use the test-scoped authenticated-page fixture where auth is not asserted, and move remaining deterministic branches to production-backed Vitest tests. Keep one surrounding Chromium integration and every browser-sensitive WebKit contract.

- [ ] **11.3 Benchmark worker counts 5 and 6 separately**

Change the validated worker config to one candidate at a time and run three unchanged zero-retry trials. The benchmark must discover and report that value; never override it on the command line. Adopt a higher count only when every run is faster than the four-worker set without greater variance, contention, failures, or flakes. Commit the accepted value into final config before acceptance; record rejected candidates.

- [ ] **11.4 Stop rather than weaken the gate**

If six workers and the remaining safe migrations still miss 60.0 seconds, mark the plan blocked with timing evidence. Do not delete assertions, enable retries, reuse external servers, raise the limit, or introduce local sharding without a separately approved design change.

- [ ] **11.5 Commit accepted fallback tuning before restarting the three-run gate**

Stage only measured changes from the explicit file map, update the coverage ledger in the same commit when allocation moved, and rerun focused tests before committing:

```powershell
git diff --name-only
git add apps/web/playwright.config.ts apps/web/tests/coverage-map.md apps/web/tests/auth-login.spec.ts apps/web/tests/vnu-session-lifecycle.spec.ts apps/web/tests/shell-dashboard.spec.ts apps/web/tests/lookup.spec.ts apps/web/tests/grades-export.spec.ts apps/web/tests/timetable-features.spec.ts apps/web/tests/responsive-accessibility.spec.ts apps/web/src/lib/account-action-state.ts apps/web/src/lib/account-action-state.test.ts apps/web/src/lib/grade-view-model.ts apps/web/src/lib/grade-view-model.test.ts apps/web/src/lib/bulk-lookup.test.ts apps/web/src/lib/data-export.test.ts apps/web/src/lib/term-academic-summary.test.ts apps/web/src/lib/api.test.ts apps/web/src/lib/vnu-refresh.test.ts
git commit -m "test(web): tune optimized suite from runtime evidence"
```

Skip this commit when no fallback change was required. Restart acceptance counting after this commit; earlier timings no longer qualify.

### Task 12: Final verification and commit

**Files:**
- All implementation paths named above

- [ ] **12.1 Run repository verification**

```powershell
pnpm build
pnpm test
pnpm --filter @hyeboard/web exec playwright test --retries=0
pnpm benchmark:test-runtime
git status --short
```

Expected: build passes; tests pass; default Playwright has zero retries/flakes; all three combined benchmark runs are below 60.0 seconds; status contains only intentional implementation paths and ignored reports do not appear.

- [ ] **12.2 Review final coverage and scope**

Confirm `coverage-map.md` has no pending row, default project selection matches the ledger, no fixed sleep exists, server reuse is disabled, proxy ports are coupled, generated auth/report files are untracked, and no deploy/push configuration changed.

- [ ] **12.3 Commit benchmark infrastructure and final tuning**

```powershell
git add scripts/benchmark-test-runtime.mjs
git commit -m "test: enforce the under-60-second runtime gate"
```

Do not push or deploy.

## Acceptance Checklist

- [ ] All assertions from 172 legacy project executions map through the exact 86-test inventory (72 Chromium-designated + 14 WebKit) to 68 Chromium + 14 WebKit + 4 pure CSV Vitest cases.
- [ ] Pure/model/race logic runs in Vitest through production modules.
- [ ] Chromium is comprehensive; WebKit runs only explicit `@webkit` browser/mobile contracts.
- [ ] `fullyParallel` is enabled with one controlled worker count from four through six; config, Playwright, benchmark, and report agree on the accepted value.
- [ ] Every fixture/page/context is test-scoped; authentication tests use the login path under test.
- [ ] No shared authenticated `storageState` exists; required sessionStorage setup uses per-test init scripts.
- [ ] No fixed sleep, retry, hidden serial block, order dependency, or local shard exists.
- [ ] Vite, Worker, and Playwright share one explicit port source; servers use strict ports and `reuseExistingServer: false`.
- [ ] Before every attempt, occupied ports fail without process termination; after every attempt, both ports release or the attempt fails.
- [ ] JSON artifacts under ignored `apps/web/test-results/runtime-benchmark/` strictly prove per-project counts, zero retries/flakes/failures, exits, ports, topology, and configured workers.
- [ ] Runtime-reported processor model/package/core/logical counts and RAM match across every accepted attempt; no Ryzen-model topology assumption is used.
- [ ] `pnpm test` and default Playwright pass with zero retries and zero flaky tests.
- [ ] Three consecutive unchanged concurrent `pnpm test:fast` runs each complete below 60.0 seconds; timing spans common start through both completions and includes contention.
- [ ] No push or deployment occurs.
