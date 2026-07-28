# VNU GPA, Export, and Resolver Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct derived VNU/UET term GPA and running CPA calculations, add safe local JSON/CSV exports to every usable Grades and Lookup result, and replace the disproven far resolver with an exact bounded concurrent search governed by runtime metadata and the existing session probe budget.

**Architecture:** Pure web modules own academic summaries and export serialization; React pages only adapt sanitized browser state and render the returned models. A central worker parser normalizes Cloudflare and self-hosted VNU settings, while the resolver owns a fixed projection-local candidate set and route handlers own validation, atomic budget reservation, cancellation, and upstream parsing. Optional university limits preserve schema compatibility and let the browser enforce the configured whole-run bulk maximum without changing worker chunk limits.

**Tech Stack:** TypeScript 6, React 19, Vite 8, TanStack Query, Radix Dropdown Menu, Tailwind CSS v4, Zod 4, Elysia 1.4, Cloudflare Workers and Durable Objects, Vitest 4/3, Playwright 1.61, pnpm 11.

**Design spec:** `docs/superpowers/specs/2026-07-27-vnu-gpa-export-resolver-design.md`

---

## Worktree and Scope Guard

Run every command from `F:\Workspace\hyeboard\.worktrees\feature-vnu-gpa-export-resolver`. Do not stage, copy, or restore files from `F:\Workspace\hyeboard` or another worktree.

Before Task 1:

```bash
git rev-parse --show-toplevel
git status --short
```

Expected root: `F:/Workspace/hyeboard/.worktrees/feature-vnu-gpa-export-resolver`. Before implementation, status must contain only this plan file. Stop and ask the user before touching any other pre-existing change. At every commit, stage only paths listed in that task; never use `git add .`, `git add -A`, amend, rebase, push, or deploy.

### Synthetic Fixture Range

Reserve `99000000`–`99999999` for synthetic eight-digit student codes and `99000000000`–`99999999999` for synthetic eleven-digit internal IDs in every new test fixture. In each test file that needs identity data, define conspicuous `SYNTHETIC_STUDENT_CODE = "99000001"` and `SYNTHETIC_INTERNAL_ID = "99000000001"` constants, then derive neighboring values instead of scattering identity-shaped literals. Existing production parsing constants, date values, arithmetic bounds, and historical fixtures are not identities; Task 9 still reports and manually classifies every newly added raw eight- or eleven-digit literal.

## File Map

### Create

- `apps/web/src/lib/term-academic-summary.ts`: pure normalization-independent grouping, UET/Mock summer merge, stable chronology, listed/included credits, weighted term GPA, and running CPA.
- `apps/web/src/lib/term-academic-summary.test.ts`: formula, eligibility, ordering, summer, own/cross equivalence, and reported-value separation tests.
- `apps/web/src/lib/data-export.ts`: allowlisted export document types/builders, deterministic JSON/CSV serializers, filename sanitation, and injectable browser download lifecycle.
- `apps/web/src/lib/data-export.test.ts`: every surface, allowlist/privacy, CSV, filename, and object-URL cleanup tests.
- `apps/web/src/components/export-menu.tsx`: reusable localized Radix `Export` menu and polite live error.
- `apps/web/src/components/export-menu.test.tsx`: static accessibility contract; Playwright covers interactive focus behavior.
- `apps/worker/src/vnu-runtime-config.ts`: canonical safe-integer parsing and effective resolver/bulk settings.
- `apps/worker/src/vnu-runtime-config.test.ts`: missing, valid, zero, malformed, overflow, and file-value normalization matrix.
- `packages/university-adapters/src/vnu/daotao-client.test.ts`: `AbortSignal` forwarding and transport-versus-cancellation semantics.

### Modify

- `apps/web/src/pages/grades.tsx:13-38,200-264` (`gradeTermKey`, `usesUetTermRules`, `summarizeGrades`, `GradesPage`): remove local GPA arithmetic; render Option A headers and page/term exports from shared summaries.
- `apps/web/src/components/shared.tsx:33-43` (`FeatureFrameProps`, `FeatureFrame`, `FeatureHeader`): accept and align an optional page-header action.
- `apps/web/src/pages/lookup.tsx:54-68,118-290` (`ClassResultRow`, `ClassResolver`, `ReverseClassResultRow`, `ReverseClassResolver`): add row-local class export models.
- `apps/web/src/pages/lookup.tsx:301-434` (`CrossStudentCodeSection`, `CrossStudentIdSection`): bind exports to submitted successful resolver results and invalidate them with input/session changes.
- `apps/web/src/pages/lookup.tsx:436-595` (`CrossTranscriptTerm`, `CrossTranscriptSection`, `StudentRecordTools`): calculate and render derived term summaries, keep portal totals separate, and add one transcript export.
- `apps/web/src/pages/lookup.tsx:597-768` (`BulkLookupResultRow`, `BulkLookupSection`, `LookupPage`): consume published bulk limits and preserve partial export models.
- `apps/web/src/lib/bulk-lookup.ts:3-96` (`parseBulkTargets`, `chunkBulkTargets`, `executeBulkLookup`): replace hardcoded whole-run 50 with the published safe-integer maximum; retain sequential 3/5 chunks and retry state.
- `apps/web/src/lib/bulk-lookup.test.ts:5-133`: configured maximum, disabled state, arbitrary safe maximum, unchanged chunks, cancellation, and partial retention.
- `apps/web/src/lib/cross-transcript-view.ts:13-66` (`CrossTranscriptView`, `deriveCrossTranscriptView`): carry shared derived summaries in success state so render and export consume one object.
- `apps/web/src/lib/cross-transcript-view.test.ts:46-76`: derived summary and reported separation assertions.
- `apps/web/src/lib/i18n.tsx:149-173,215-338,617-641,683-806`: English and Vietnamese export, derived metric, reported GPA, dynamic bulk-limit, progress, and error copy.
- `apps/web/tests/smoke.spec.ts:12-30,305-453,689-833`: metadata-aware mocks and JSON/CSV, partial, keyboard, focus, locale, theme, touch-target, and responsive coverage.
- `packages/schemas/src/index.ts:36-42,246-248`: optional `University.limits.crossLookup.bulkMaxTargets` schema and inferred types.
- `packages/university-adapters/src/vnu/daotao-client.ts:20-40,69-100` (`fetchPage`, `getTranscriptByStdIdHtml`): pass and preserve `AbortSignal` cancellation.
- `apps/worker/src/vnu-student-id-resolver.ts:3-106` (`resolveVnuStudentId`): replace all near/far walking with fixed `G ± 16` exact search and bounded deterministic concurrency.
- `apps/worker/src/vnu-student-id-resolver.test.ts:1-266`: replace far-walk tests with synthetic local-window, concurrency, ordering, cancellation, and fatal-error tests.
- `apps/worker/src/app.ts:7-134` (`RuntimeConfig`, `setRuntimeConfig`, `loadConfigFile`, far helpers): centralize effective VNU settings in Task 4 while retaining the internal far compatibility field/helper until route migration removes them atomically in Task 6.
- `apps/worker/src/app.ts:280-393` (`VNU_BULK_MODE_LIMITS`, `createVnuBulkAllowance`, `vnuBulkReservationUnits`): retain chunk limits, change code reservations to 33, and share local allowances.
- `apps/worker/src/app.ts:777-820` (`serializeUniversities`, `/api/universities`): publish optional effective VNU bulk metadata only when cross lookup is available.
- `apps/worker/src/app.ts:962-1144` (four cross-lookup routes): reserve 1/33/34 units atomically, pass request cancellation, keep bulk items sequential, and stop chunks on systemic failures.
- `apps/worker/src/app.test.ts:605-1106`: route reservation arithmetic, no-store, no-refund, cancellation, failure classification, config precedence, and far-flag removal.
- `apps/worker/src/university-capabilities.test.ts:21-91`: optional limits metadata, zero value, capability masking, and static-record immutability.
- `apps/worker/src/index.ts:11-23`: wire generated Cloudflare bindings for both settings; remove `VNU_FAR_WALK_ENABLED`.
- `apps/worker/src/start.ts:14-28,51-67` (`selfHostedRuntimeConfig`, `start`): environment-over-file precedence for both settings.
- `apps/worker/wrangler.jsonc:11-16`: defaults `VNU_CODE_LOOKUP_CONCURRENCY="16"` and `VNU_CROSS_LOOKUP_BULK_MAX_TARGETS="50"`; remove far binding.
- `apps/worker/worker-configuration.d.ts:1-28`: regenerate with Wrangler; never hand-edit.
- `apps/worker/config.json:10-14`: add synchronized non-secret `vnu` defaults.
- `apps/worker/.env.example:1-6`: document optional environment overrides without raw examples that resemble credentials.
- `scripts/package.mjs:78-93`: write the same `vnu` defaults into the standalone package.
- `README.md:20-27,43-64`: replace far-walk operations with current config, metadata, reservation, and self-host behavior.
- `docs/architecture.md:1-29`: document client-only exports, derived versus reported academic data, bounded resolver flow, and Durable Object authority.
- `packages/university-adapters/src/vnu/har-notes.md:126-201`: replace obsolete far-walk operations with qualitative evidence, bounded local-search assumptions, current reservations, and no runtime flag guidance.

### Boundaries That Must Stay Unchanged

- `apps/worker/src/vnu-probe-budget.ts` and `apps/worker/src/vnu-probe-budget-durable-object.ts`: budget limit/window and opaque per-session HMAC storage remain authoritative and non-configurable.
- `apps/worker/src/app.ts` `VNU_BULK_MODE_LIMITS`: three code targets and five direct-ID/transcript targets per request remain fixed.
- `apps/web/src/lib/api.ts` request/session clearing: export and resolver feature errors remain inline and never clear a valid session.
- Export paths: no API call, query-cache mutation, persistence, analytics, telemetry, or server storage.
- UI: existing tokens, flat rows, restrained borders, bounded overflow containers; no nested cards, gradients, glow/shadow hover effects, or side-stripe accents.

## Dependency Order

```text
term-academic-summary.ts -> Grades + cross transcript + transcript exports
data-export.ts -> export-menu.tsx -> Grades/Lookup result surfaces
vnu-runtime-config.ts -> app runtime state -> university metadata + resolver pool width
DaotaoClient AbortSignal -> resolver -> route reservation/cancellation integration
University metadata -> bulk input validation -> partial bulk exports
```

---

### Task 1: Add the Pure Derived Term Calculator

**Files:**
- Create: `apps/web/src/lib/term-academic-summary.ts`
- Create: `apps/web/src/lib/term-academic-summary.test.ts`

- [ ] **Step 1: Write the failing calculator tests**

Create `apps/web/src/lib/term-academic-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { calculateTermAcademicSummaries, newestAcademicTermsFirst, type AcademicCourseInput } from "./term-academic-summary";

type Row = { id: string; term: string; credits?: number | null; point4?: number | null; summer?: boolean };

const normalize = (rows: Row[]): AcademicCourseInput<Row>[] => rows.map((row) => ({
  termKey: row.term,
  credits: row.credits,
  point4: row.point4,
  course: row,
  isSummer: row.summer === true,
}));

describe("calculateTermAcademicSummaries", () => {
  it("uses positive finite credits as weights and preserves full precision", () => {
    const [term] = calculateTermAcademicSummaries(normalize([
      { id: "a", term: "251", credits: 2, point4: 4 },
      { id: "b", term: "251", credits: 3, point4: 3 },
    ]), "vnu");
    expect(term).toMatchObject({ listedCredits: 5, includedCredits: 5, termGpa4: 17 / 5, cpa4: 17 / 5, estimateKind: "derived" });
  });

  it("calculates running CPA oldest to newest and display reversal does not change assigned CPA", () => {
    const chronological = calculateTermAcademicSummaries(normalize([
      { id: "new", term: "252", credits: 1, point4: 4 },
      { id: "old", term: "251", credits: 3, point4: 2 },
    ]), "vnu");
    expect(chronological.map((term) => [term.termKey, term.termGpa4, term.cpa4])).toEqual([
      ["251", 2, 2],
      ["252", 4, 2.5],
    ]);
    expect(newestAcademicTermsFirst(chronological).map((term) => [term.termKey, term.cpa4])).toEqual([
      ["252", 2.5],
      ["251", 2],
    ]);
  });

  it("counts missing grades only in listed credits and includes numeric zero grades", () => {
    const [term] = calculateTermAcademicSummaries(normalize([
      { id: "missing", term: "251", credits: 3, point4: null },
      { id: "zero", term: "251", credits: 2, point4: 0 },
      { id: "graded", term: "251", credits: 1, point4: 4 },
    ]), "vnu");
    expect(term).toMatchObject({ listedCredits: 6, includedCredits: 3, termGpa4: 4 / 3, cpa4: 4 / 3 });
  });

  it("excludes missing, zero, negative, and non-finite credits", () => {
    const [term] = calculateTermAcademicSummaries(normalize([
      { id: "missing", term: "251", point4: 4 },
      { id: "zero", term: "251", credits: 0, point4: 4 },
      { id: "negative", term: "251", credits: -2, point4: 4 },
      { id: "nan", term: "251", credits: Number.NaN, point4: 4 },
      { id: "infinite-credit", term: "251", credits: Number.POSITIVE_INFINITY, point4: 4 },
      { id: "infinite-grade", term: "251", credits: 3, point4: Number.POSITIVE_INFINITY },
    ]), "vnu");
    expect(term).toMatchObject({ listedCredits: 3, includedCredits: 0 });
    expect(term.termGpa4).toBeUndefined();
    expect(term.cpa4).toBeUndefined();
  });

  it("carries prior CPA through an ungraded term and starts later when no prior grade exists", () => {
    const summaries = calculateTermAcademicSummaries(normalize([
      { id: "first-ungraded", term: "251", credits: 3, point4: null },
      { id: "graded", term: "252", credits: 2, point4: 3 },
      { id: "later-ungraded", term: "253", credits: 1, point4: null },
    ]), "vnu");
    expect(summaries.map((term) => [term.termKey, term.termGpa4, term.cpa4])).toEqual([
      ["251", undefined, undefined],
      ["252", 3, 3],
      ["253", undefined, 3],
    ]);
  });

  it("orders numeric terms while retaining unknown groups in stable source slots", () => {
    const summaries = calculateTermAcademicSummaries(normalize([
      { id: "new", term: "252", credits: 1, point4: 4 },
      { id: "unknown-a", term: "unknown-a", credits: 1, point4: 1 },
      { id: "old", term: "251", credits: 1, point4: 2 },
      { id: "unknown-b", term: "unknown-b", credits: 1, point4: 3 },
    ]), "vnu");
    expect(summaries.map((term) => term.termKey)).toEqual(["251", "unknown-a", "252", "unknown-b"]);
  });

  it("merges UET and Mock summer code 3 into code 2 as one CPA checkpoint", () => {
    const rows = normalize([
      { id: "regular", term: "20242", credits: 3, point4: 3 },
      { id: "summer", term: "20243", credits: 1, point4: 4, summer: true },
    ]);
    for (const universityId of ["uet", "mock"]) {
      const summaries = calculateTermAcademicSummaries(rows, universityId);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ termKey: "20242", includesSummer: true, listedCredits: 4, includedCredits: 4, termGpa4: 3.25, cpa4: 3.25 });
      expect(summaries[0]?.courses.map((course) => course.id)).toEqual(["regular", "summer"]);
    }
    expect(calculateTermAcademicSummaries(rows, "vnu")).toHaveLength(2);
  });

  it("produces identical summaries for normalized own-grade and cross-transcript rows", () => {
    const own = calculateTermAcademicSummaries([
      { termKey: "251", credits: 3, point4: 3.5, course: { id: "own-a" } },
      { termKey: "251", credits: 2, point4: null, course: { id: "own-b" } },
    ], "vnu");
    const cross = calculateTermAcademicSummaries([
      { termKey: "251", credits: 3, point4: 3.5, course: { id: "cross-a" } },
      { termKey: "251", credits: 2, point4: null, course: { id: "cross-b" } },
    ], "vnu");
    expect(own.map(({ courses: _courses, ...summary }) => summary)).toEqual(cross.map(({ courses: _courses, ...summary }) => summary));
  });

  it("never creates a reported cumulative field inside a derived summary", () => {
    const [summary] = calculateTermAcademicSummaries(normalize([{ id: "a", term: "251", credits: 3, point4: 3.5 }]), "vnu");
    expect(summary).not.toHaveProperty("reportedCumulativeGpa4");
    expect(summary.estimateKind).toBe("derived");
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/term-academic-summary.test.ts
```

Expected: FAIL because `./term-academic-summary` does not exist.

- [ ] **Step 3: Implement the minimal pure calculator**

Create `apps/web/src/lib/term-academic-summary.ts` with this complete API:

```ts
export type AcademicCourseInput<T> = {
  termKey: string;
  credits?: number | null;
  point4?: number | null;
  course: T;
  isSummer?: boolean;
};

export type AcademicTermSummary<T> = {
  termKey: string;
  courses: T[];
  includesSummer: boolean;
  listedCredits: number;
  includedCredits: number;
  termGpa4?: number;
  cpa4?: number;
  estimateKind: "derived";
};

type Group<T> = {
  termKey: string;
  courses: T[];
  includesSummer: boolean;
  listedCredits: number;
  includedCredits: number;
  weightedPoints: number;
  sourceIndex: number;
};

function usesUetSummerRule(universityId: string): boolean {
  return universityId === "uet" || universityId === "mock";
}

function groupedTermKey(termKey: string, universityId: string): string {
  if (usesUetSummerRule(universityId) && /^\d+3$/.test(termKey)) return `${termKey.slice(0, -1)}2`;
  return termKey;
}

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteGrade(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function chronologicalGroups<T>(groups: Group<T>[]): Group<T>[] {
  const numeric = groups
    .filter((group) => /^\d+$/.test(group.termKey))
    .sort((left, right) => Number(left.termKey) - Number(right.termKey) || left.sourceIndex - right.sourceIndex);
  let numericIndex = 0;
  return groups.map((group) => /^\d+$/.test(group.termKey) ? numeric[numericIndex++]! : group);
}

export function calculateTermAcademicSummaries<T>(
  rows: readonly AcademicCourseInput<T>[],
  universityId: string,
): AcademicTermSummary<T>[] {
  const groups = new Map<string, Group<T>>();
  rows.forEach((row, sourceIndex) => {
    const termKey = groupedTermKey(row.termKey, universityId);
    const group = groups.get(termKey) ?? {
      termKey,
      courses: [],
      includesSummer: false,
      listedCredits: 0,
      includedCredits: 0,
      weightedPoints: 0,
      sourceIndex,
    };
    group.courses.push(row.course);
    group.includesSummer ||= row.isSummer === true || (usesUetSummerRule(universityId) && row.termKey !== termKey && row.termKey.endsWith("3"));
    if (positiveFinite(row.credits)) {
      group.listedCredits += row.credits;
      if (finiteGrade(row.point4)) {
        group.includedCredits += row.credits;
        group.weightedPoints += row.credits * row.point4;
      }
    }
    groups.set(termKey, group);
  });

  let runningCredits = 0;
  let runningPoints = 0;
  return chronologicalGroups([...groups.values()]).map((group) => {
    runningCredits += group.includedCredits;
    runningPoints += group.weightedPoints;
    return {
      termKey: group.termKey,
      courses: group.courses,
      includesSummer: group.includesSummer,
      listedCredits: group.listedCredits,
      includedCredits: group.includedCredits,
      termGpa4: group.includedCredits > 0 ? group.weightedPoints / group.includedCredits : undefined,
      cpa4: runningCredits > 0 ? runningPoints / runningCredits : undefined,
      estimateKind: "derived",
    };
  });
}

export function newestAcademicTermsFirst<T>(summaries: readonly AcademicTermSummary<T>[]): AcademicTermSummary<T>[] {
  return [...summaries].reverse();
}
```

Do not round inside this module. Do not add point-10 averages, repeat/replacement rules, pass/fail rules, or reported values.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/term-academic-summary.test.ts
```

Expected: PASS, 9 calculator tests.

- [ ] **Step 5: Commit the calculator**

```bash
git add apps/web/src/lib/term-academic-summary.ts apps/web/src/lib/term-academic-summary.test.ts
git commit -m "feat(web): add derived term academic summaries"
```

---

### Task 2: Add Pure Export Models, Serializers, Download Cleanup, and `ExportMenu`

**Files:**
- Create: `apps/web/src/lib/data-export.ts`
- Create: `apps/web/src/lib/data-export.test.ts`
- Create: `apps/web/src/components/export-menu.tsx`
- Create: `apps/web/src/components/export-menu.test.tsx`
- Modify: `apps/web/src/lib/i18n.tsx:149-173,215-338,617-641,683-806`

- [ ] **Step 1: Write failing export and menu tests**

Create `apps/web/src/lib/data-export.test.ts`. Use only synthetic values and assert the complete contract below:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  CSV_HEADERS,
  buildExportFilename,
  createBulkExport,
  createClassLookupExport,
  createGradesExport,
  createResolverLookupExport,
  createTranscriptExport,
  downloadExport,
  sanitizeAsciiFilenameComponent,
  serializeExportCsv,
  serializeExportJson,
  type ExportDocument,
} from "./data-export";

const term = {
  termCode: "251",
  termLabel: "Semester 1, 2025–2026",
  estimateKind: "derived" as const,
  listedCredits: 6,
  includedCredits: 3,
  termGpa4: 3.5,
  derivedCpa4: 3.5,
  courses: [{ courseCode: "INT1001", courseName: "Reliable, \"Systems\"\nLab", credits: 3, point10: 8, letter: "B+", point4: 3.5 }],
};

const SYNTHETIC_STUDENT_CODE = "99000001";
const SYNTHETIC_INTERNAL_ID = "99000000001";
const SYNTHETIC_OWN_STUDENT_CODE = String(Number(SYNTHETIC_STUDENT_CODE) - 1);
const SYNTHETIC_OWN_INTERNAL_ID = String(Number(SYNTHETIC_INTERNAL_ID) - 1);

const profileHtml = `<input name="hidStdID" value="${SYNTHETIC_OWN_INTERNAL_ID}"><input name="StdCode" value="${SYNTHETIC_OWN_STUDENT_CODE}">`;
const targetTranscriptHtml = `<table>
  <tr><td>Sinh viên: SYNTHETIC TARGET</td><td>Mã số: ${SYNTHETIC_STUDENT_CODE}</td><td>Lớp quản lý: QH-SYNTHETIC</td></tr>
  <tr><td>HỌC KỲ 1 - 2025-2026. MÃ HỌC KỲ 251</td></tr>
  <tr><td>1</td><td>INT1001</td><td>Reliable Systems</td><td>3</td><td>8</td><td>B+</td><td>3.5</td><td></td></tr>
</table><div>Tổng tín chỉ: 3</div>`;

function parseRfc4180Csv(input: string): { rows: string[][]; recordSeparators: string[] } {
  expect(input.charCodeAt(0)).toBe(0xfeff);
  const rows: string[][] = [];
  const recordSeparators: string[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 1;

  while (index < input.length) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (character === '"') {
        quoted = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      expect(field).toBe("");
      quoted = true;
      index += 1;
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (character === "\r") {
      expect(input[index + 1]).toBe("\n");
      row.push(field);
      rows.push(row);
      recordSeparators.push("\r\n");
      row = [];
      field = "";
      index += 2;
      continue;
    }
    expect(character).not.toBe("\n");
    field += character;
    index += 1;
  }

  expect(quoted).toBe(false);
  expect(row).toEqual([]);
  expect(field).toBe("");
  return { rows, recordSeparators };
}

describe("export models", () => {
  it.each([
    ["class-forward", createClassLookupExport({ surface: "class-forward", universityId: "vnu", query: { mode: "course-and-class", value: "INT1001 / 01" }, result: { classCode: "INT1001", classNumber: "01", classId: "000001", courseName: "Reliable Systems" } })],
    ["class-reverse", createClassLookupExport({ surface: "class-reverse", universityId: "vnu", query: { mode: "class-id", value: "000001" }, result: { classCode: "INT1001", classNumber: "01", classId: "000001", courseName: "Reliable Systems" } })],
    ["student-id-to-code", createResolverLookupExport({ surface: "student-id-to-code", universityId: "vnu", query: { mode: "stdId", value: SYNTHETIC_INTERNAL_ID }, identity: { studentCode: SYNTHETIC_STUDENT_CODE, studentName: "Synthetic Student", managingClass: "QH-SYNTHETIC" } })],
    ["student-code-to-id", createResolverLookupExport({ surface: "student-code-to-id", universityId: "vnu", query: { mode: "stdCode", value: SYNTHETIC_STUDENT_CODE }, resolver: { resolvedStudentCode: SYNTHETIC_STUDENT_CODE, resolvedInternalStudentId: SYNTHETIC_INTERNAL_ID, probes: 2 } })],
    ["grades-term", createGradesExport({ surface: "grades-term", universityId: "mock", identity: { studentCode: SYNTHETIC_STUDENT_CODE }, reported: { cumulativeGpa4: 3.48 }, derivedTerms: [term] })],
    ["grades-page", createGradesExport({ surface: "grades-page", universityId: "mock", identity: { studentCode: SYNTHETIC_STUDENT_CODE }, reported: { cumulativeGpa4: 3.48 }, derivedTerms: [term] })],
    ["cross-transcript", createTranscriptExport({ universityId: "vnu", query: { mode: "stdId", value: SYNTHETIC_INTERNAL_ID }, identity: { studentCode: SYNTHETIC_STUDENT_CODE, studentName: "Synthetic Student" }, reported: { cumulativeGpa4: 3.2, totalCredits: 90, accumulatedCredits: 84 }, derivedTerms: [term] })],
    ["bulk-id-to-code", createBulkExport({ surface: "bulk-id-to-code", universityId: "vnu", mode: "stdid-to-code", total: 1, items: [{ target: SYNTHETIC_INTERNAL_ID, status: "ok", result: { identity: { studentCode: SYNTHETIC_STUDENT_CODE } } }] })],
    ["bulk-code-to-id", createBulkExport({ surface: "bulk-code-to-id", universityId: "vnu", mode: "code-to-stdid", total: 1, items: [{ target: SYNTHETIC_STUDENT_CODE, status: "ok", result: { resolver: { resolvedStudentCode: SYNTHETIC_STUDENT_CODE, resolvedInternalStudentId: SYNTHETIC_INTERNAL_ID, probes: 2 } } }] })],
    ["bulk-id-to-transcript", createBulkExport({ surface: "bulk-id-to-transcript", universityId: "vnu", mode: "stdid-to-transcript", total: 1, items: [{ target: SYNTHETIC_INTERNAL_ID, status: "ok", result: { identity: { studentCode: SYNTHETIC_STUDENT_CODE }, reported: { cumulativeGpa4: 3.2 }, derivedTerms: [term] } }] })],
  ] as const)("builds allowlisted %s JSON", (surface, model) => {
    expect(model).toMatchObject({ schemaVersion: 1, surface, universityId: expect.any(String) });
    expect(serializeExportJson(model)).toBe(`${JSON.stringify(model, null, 2)}\n`);
  });

  it("omits arbitrary cache, session, raw HTML, notice, and telemetry fields", () => {
    const unsafe = {
      studentCode: SYNTHETIC_STUDENT_CODE,
      studentName: "Synthetic Student",
      sessionToken: "DO_NOT_EXPORT",
      cookie: "DO_NOT_EXPORT",
      html: "<table>DO_NOT_EXPORT</table>",
      notice: "DO_NOT_EXPORT",
      queryKey: ["DO_NOT_EXPORT"],
      telemetry: "DO_NOT_EXPORT",
    };
    const model = createResolverLookupExport({
      surface: "student-id-to-code",
      universityId: "vnu",
      query: { mode: "stdId", value: "1001" },
      identity: unsafe,
    });
    const json = serializeExportJson(model);
    for (const forbidden of ["sessionToken", "cookie", "<table>", "notice", "queryKey", "telemetry", "DO_NOT_EXPORT"]) expect(json).not.toContain(forbidden);
  });

  it("keeps complete and partial bulk items ordered without inventing unprocessed errors", () => {
    const model = createBulkExport({
      surface: "bulk-code-to-id",
      universityId: "vnu",
      mode: "code-to-stdid",
      total: 4,
      items: [
        { target: SYNTHETIC_STUDENT_CODE, status: "ok", result: { resolver: { resolvedStudentCode: SYNTHETIC_STUDENT_CODE, resolvedInternalStudentId: SYNTHETIC_INTERNAL_ID, probes: 2 } } },
        { target: "bad", status: "error", errorCode: "VNU_CROSS_LOOKUP_INVALID_TARGET" },
      ],
    });
    expect(model.run).toEqual({ status: "partial", mode: "code-to-stdid", processedCount: 2, totalCount: 4 });
    expect(model.results?.map((item) => "target" in item ? item.target : undefined)).toEqual([SYNTHETIC_STUDENT_CODE, "bad"]);
    expect(serializeExportJson(model)).not.toContain('"target": "unprocessed"');
  });
});

describe("CSV", () => {
  it("uses fixed headers, deterministic record order, Unicode, and formula defense", () => {
    const model = createTranscriptExport({
      universityId: "vnu",
      query: { mode: "stdId", value: "1001" },
      identity: { studentCode: SYNTHETIC_STUDENT_CODE, studentName: "  =HYPERLINK(\"bad\")", managingClass: "Lớp tổng hợp" },
      reported: { cumulativeGpa4: 3.2 },
      derivedTerms: [term],
    });
    const csv = serializeExportCsv(model);
    const parsed = parseRfc4180Csv(csv);
    expect(parsed.rows[0]).toEqual([...CSV_HEADERS]);
    expect(parsed.recordSeparators).toEqual(parsed.rows.map(() => "\r\n"));
    const header = parsed.rows[0]!;
    const column = (name: typeof CSV_HEADERS[number]) => header.indexOf(name);
    const identity = parsed.rows.slice(1).find((row) => row[column("record_type")] === "identity")!;
    expect(identity[column("student_name")]).toBe("'  =HYPERLINK(\"bad\")");
    expect(identity[column("managing_class")]).toBe("Lớp tổng hợp");
    expect(parsed.rows.slice(1).map((row) => row[0])).toEqual(["query", "identity", "reported_summary", "term_summary", "course"]);
  });

  it("round-trips embedded LF, CR, CRLF, comma, doubled quote, and an empty field while keeping record separators outside quotes", () => {
    const specialCourseName = 'LF\nCR\rCRLF\r\nComma, Quote "quoted"';
    const model = createClassLookupExport({
      surface: "class-forward",
      universityId: "vnu",
      query: { mode: "course-and-class", value: specialCourseName },
      result: { classCode: "INT1001", classId: "000001", courseName: specialCourseName },
    });
    const csv = serializeExportCsv(model);
    const parsed = parseRfc4180Csv(csv);
    const header = parsed.rows[0]!;
    const query = parsed.rows[1]!;
    const result = parsed.rows[2]!;
    const column = (name: typeof CSV_HEADERS[number]) => header.indexOf(name);

    expect(query[column("query_value")]).toBe(specialCourseName);
    expect(result[column("course_name")]).toBe(specialCourseName);
    expect(result[column("class_number")]).toBe("");
    expect(csv).toContain('"LF\nCR\rCRLF\r\nComma, Quote ""quoted"""');
    expect(parsed.recordSeparators).toEqual(["\r\n", "\r\n", "\r\n"]);
  });

  it.each([
    ["=1+1", "'=1+1"],
    [" +SUM(A1:A2)", "' +SUM(A1:A2)"],
    ["\t-2", "'\t-2"],
    ["\r@cmd", "'\r@cmd"],
  ])('defends formula-like text %j while leaving numeric values numeric', (studentName, protectedStudentName) => {
    const parsed = parseRfc4180Csv(serializeExportCsv(createTranscriptExport({
      universityId: "vnu",
      query: { mode: "stdId", value: "1001" },
      identity: { studentName, studentCode: SYNTHETIC_STUDENT_CODE },
      reported: { cumulativeGpa4: 3.2 },
      derivedTerms: [],
    })));
    const header = parsed.rows[0]!;
    const column = (name: typeof CSV_HEADERS[number]) => header.indexOf(name);
    const identity = parsed.rows.slice(1).find((row) => row[column("record_type")] === "identity")!;
    const reported = parsed.rows.slice(1).find((row) => row[column("record_type")] === "reported_summary")!;
    expect(identity[column("student_name")]).toBe(protectedStudentName);
    expect(reported[column("reported_cumulative_gpa4")]).toBe("3.2");
  });

  it("emits a simple lookup query record followed by one result record", () => {
    const csv = serializeExportCsv(createResolverLookupExport({
      surface: "student-id-to-code",
      universityId: "vnu",
      query: { mode: "stdId", value: "1001" },
      identity: { studentCode: SYNTHETIC_STUDENT_CODE },
    }));
    expect(parseRfc4180Csv(csv).rows.slice(1).map((row) => row[0])).toEqual(["query", "result"]);
  });

  it("emits every bulk success/error and transcript record in input order", () => {
    const model = createBulkExport({
      surface: "bulk-id-to-transcript",
      universityId: "vnu",
      mode: "stdid-to-transcript",
      total: 2,
      items: [
        { target: SYNTHETIC_INTERNAL_ID, status: "ok", result: { identity: { studentCode: SYNTHETIC_STUDENT_CODE }, reported: { cumulativeGpa4: 3.2 }, derivedTerms: [term] } },
        { target: "1002", status: "error", errorCode: "VNU_CROSS_LOOKUP_NOT_FOUND" },
      ],
    });
    const csv = serializeExportCsv(model);
    expect(csv.indexOf(SYNTHETIC_STUDENT_CODE)).toBeLessThan(csv.indexOf("VNU_CROSS_LOOKUP_NOT_FOUND"));
    expect(csv).toContain("complete");
  });
});

describe("filenames and browser lifecycle", () => {
  it.each([
    ["CON", "export"],
    ["LPT1", "export"],
    ["../grades///page...csv", "grades-page-csv"],
    ["report...   ", "report"],
    [`${"x".repeat(200)}.json`, "x".repeat(48)],
    ["line\u0000break", "line-break"],
  ])("sanitizes unsafe filename component %j", (input, expected) => {
    expect(sanitizeAsciiFilenameComponent(input)).toBe(expected);
  });

  it("forces the selected extension and never uses identity fields", () => {
    const model = createResolverLookupExport({
      surface: "student-id-to-code",
      universityId: "vnu",
      query: { mode: "stdId", value: "1001" },
      identity: { studentName: "Synthetic Student", studentCode: SYNTHETIC_STUDENT_CODE },
    });
    const filename = buildExportFilename(model.surface, new Date("2026-07-27T12:00:00Z"), "json");
    expect(filename).toBe("hyeboard-student-id-to-code-2026-07-27.json");
    expect(filename).not.toContain(SYNTHETIC_STUDENT_CODE);
    expect(filename).not.toMatch(/Synthetic|\.csv$/);
    expect(buildExportFilename("../CON.csv" as "grades-page", new Date("2026-07-27T12:00:00Z"), "json")).toBe("hyeboard-con-csv-2026-07-27.json");
  });

  it.each([false, true])("revokes the object URL and removes the anchor when click failure is %s", (clickFails) => {
    const remove = vi.fn();
    const revokeObjectURL = vi.fn();
    const anchor = { href: "", download: "", click: vi.fn(() => { if (clickFails) throw new Error("synthetic click failure"); }), remove };
    const appendAnchor = vi.fn();
    const environment = { createObjectURL: vi.fn(() => "blob:synthetic"), revokeObjectURL, createAnchor: vi.fn(() => anchor), appendAnchor };
    const model: ExportDocument = { schemaVersion: 1, surface: "grades-page", universityId: "mock", derivedTerms: [] };
    if (clickFails) expect(() => downloadExport(model, "json", new Date("2026-07-27T12:00:00Z"), environment)).toThrow("synthetic click failure");
    else expect(() => downloadExport(model, "json", new Date("2026-07-27T12:00:00Z"), environment)).not.toThrow();
    expect(appendAnchor).toHaveBeenCalledWith(anchor);
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
  });
});
```

Create `apps/web/src/components/export-menu.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/lib/i18n";
import { ExportMenu } from "./export-menu";

describe("ExportMenu", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "en" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders a 44px localized trigger and polite live-error region", () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider>
        <ExportMenu model={{ schemaVersion: 1, surface: "grades-page", universityId: "mock", derivedTerms: [] }} />
      </LocaleProvider>,
    );
    expect(markup).toContain("Export");
    expect(markup).toContain("min-h-11");
    expect(markup).toContain('aria-live="polite"');
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/data-export.test.ts src/components/export-menu.test.tsx
```

Expected: FAIL because `data-export.ts` and `export-menu.tsx` do not exist.

- [ ] **Step 3: Implement the complete typed export boundary**

Create `apps/web/src/lib/data-export.ts` with these exact public types and functions. Every builder copies named fields; none spreads API/query-cache objects.

```ts
export type ExportFormat = "json" | "csv";
export type ExportSurface =
  | "class-forward" | "class-reverse" | "student-id-to-code" | "student-code-to-id"
  | "grades-term" | "grades-page" | "cross-transcript"
  | "bulk-id-to-code" | "bulk-code-to-id" | "bulk-id-to-transcript";

export type ExportQuery = { mode: string; value: string };
export type ExportIdentity = { studentCode?: string; internalStudentId?: string; studentName?: string; managingClass?: string };
export type ExportReported = { cumulativeGpa4?: number; totalCredits?: number; accumulatedCredits?: number };
export type ExportCourse = { courseCode: string; courseName: string; credits?: number; point10?: number; letter?: string; point4?: number };
export type ExportDerivedTerm = {
  termCode: string;
  termLabel: string;
  estimateKind: "derived";
  listedCredits: number;
  includedCredits: number;
  termGpa4?: number;
  derivedCpa4?: number;
  courses: ExportCourse[];
};
export type ExportClassResult = { classCode: string; classNumber?: string; classId: string; courseName?: string };
export type ExportResolverResult = { resolvedStudentCode: string; resolvedInternalStudentId: string; probes: number };
export type ExportResult = { identity?: ExportIdentity; classResult?: ExportClassResult; resolver?: ExportResolverResult; reported?: ExportReported; derivedTerms?: ExportDerivedTerm[] };
export type ExportBulkItem = { target: string; status: "ok"; result: ExportResult } | { target: string; status: "error"; errorCode: string };
export type ExportRun = { status: "complete" | "partial"; mode: string; processedCount: number; totalCount: number };
export type ExportDocument = {
  schemaVersion: 1;
  surface: ExportSurface;
  universityId: string;
  query?: ExportQuery;
  run?: ExportRun;
  identity?: ExportIdentity;
  reported?: ExportReported;
  derivedTerms?: ExportDerivedTerm[];
  results?: Array<ExportResult | ExportBulkItem>;
};

type IdentityInput = ExportIdentity & Record<string, unknown>;

function identity(input: ExportIdentity | IdentityInput | undefined): ExportIdentity | undefined {
  if (!input) return undefined;
  const value = { studentCode: input.studentCode, internalStudentId: input.internalStudentId, studentName: input.studentName, managingClass: input.managingClass };
  return Object.values(value).some((field) => field !== undefined) ? value : undefined;
}

function reported(input: ExportReported | undefined): ExportReported | undefined {
  if (!input) return undefined;
  const value = { cumulativeGpa4: input.cumulativeGpa4, totalCredits: input.totalCredits, accumulatedCredits: input.accumulatedCredits };
  return Object.values(value).some((field) => field !== undefined) ? value : undefined;
}

function course(input: ExportCourse): ExportCourse {
  return { courseCode: input.courseCode, courseName: input.courseName, credits: input.credits, point10: input.point10, letter: input.letter, point4: input.point4 };
}

function derivedTerm(input: ExportDerivedTerm): ExportDerivedTerm {
  return {
    termCode: input.termCode,
    termLabel: input.termLabel,
    estimateKind: "derived",
    listedCredits: input.listedCredits,
    includedCredits: input.includedCredits,
    termGpa4: input.termGpa4,
    derivedCpa4: input.derivedCpa4,
    courses: input.courses.map(course),
  };
}

function result(input: ExportResult): ExportResult {
  return {
    identity: identity(input.identity),
    classResult: input.classResult ? { classCode: input.classResult.classCode, classNumber: input.classResult.classNumber, classId: input.classResult.classId, courseName: input.classResult.courseName } : undefined,
    resolver: input.resolver ? { resolvedStudentCode: input.resolver.resolvedStudentCode, resolvedInternalStudentId: input.resolver.resolvedInternalStudentId, probes: input.resolver.probes } : undefined,
    reported: reported(input.reported),
    derivedTerms: input.derivedTerms?.map(derivedTerm),
  };
}

export function createClassLookupExport(input: { surface: "class-forward" | "class-reverse"; universityId: string; query: ExportQuery; result: ExportClassResult }): ExportDocument {
  return { schemaVersion: 1, surface: input.surface, universityId: input.universityId, query: { mode: input.query.mode, value: input.query.value }, results: [result({ classResult: input.result })] };
}

export function createResolverLookupExport(input: { surface: "student-id-to-code" | "student-code-to-id"; universityId: string; query: ExportQuery; identity?: IdentityInput; resolver?: ExportResolverResult }): ExportDocument {
  return { schemaVersion: 1, surface: input.surface, universityId: input.universityId, query: { mode: input.query.mode, value: input.query.value }, results: [result({ identity: identity(input.identity), resolver: input.resolver })] };
}

export function createGradesExport(input: { surface: "grades-term" | "grades-page"; universityId: string; identity?: IdentityInput; reported?: ExportReported; derivedTerms: ExportDerivedTerm[] }): ExportDocument {
  return { schemaVersion: 1, surface: input.surface, universityId: input.universityId, identity: identity(input.identity), reported: reported(input.reported), derivedTerms: input.derivedTerms.map(derivedTerm) };
}

export function createTranscriptExport(input: { universityId: string; query: ExportQuery; identity?: IdentityInput; reported?: ExportReported; derivedTerms: ExportDerivedTerm[] }): ExportDocument {
  return { schemaVersion: 1, surface: "cross-transcript", universityId: input.universityId, query: { mode: input.query.mode, value: input.query.value }, identity: identity(input.identity), reported: reported(input.reported), derivedTerms: input.derivedTerms.map(derivedTerm) };
}

export function createBulkExport(input: { surface: "bulk-id-to-code" | "bulk-code-to-id" | "bulk-id-to-transcript"; universityId: string; mode: string; total: number; items: ExportBulkItem[] }): ExportDocument {
  const results = input.items.map((item): ExportBulkItem => item.status === "error"
    ? { target: item.target, status: "error", errorCode: item.errorCode }
    : { target: item.target, status: "ok", result: result(item.result) });
  return {
    schemaVersion: 1,
    surface: input.surface,
    universityId: input.universityId,
    run: { status: results.length === input.total ? "complete" : "partial", mode: input.mode, processedCount: results.length, totalCount: input.total },
    results,
  };
}

export function serializeExportJson(model: ExportDocument): string {
  return `${JSON.stringify(model, null, 2)}\n`;
}

export const CSV_HEADERS = [
  "record_type", "surface", "run_status", "item_index", "status", "error_code", "query_mode", "query_value", "target", "university_id",
  "student_code", "internal_student_id", "student_name", "managing_class", "class_code", "class_number", "class_id", "resolved_student_code",
  "resolved_internal_student_id", "probes", "term_code", "term_label", "estimate_kind", "listed_credits", "included_credits", "term_gpa4",
  "derived_cpa4", "reported_cumulative_gpa4", "course_code", "course_name", "credits", "point10", "letter", "point4",
] as const;

type CsvHeader = typeof CSV_HEADERS[number];
type CsvValue = string | number | undefined;
type CsvRow = Partial<Record<CsvHeader, CsvValue>>;
type CsvContext = { surface: ExportSurface; universityId: string; runStatus?: "complete" | "partial"; itemIndex?: number; status?: "ok" | "error"; errorCode?: string; target?: string };

function baseRow(context: CsvContext, recordType: string): CsvRow {
  return { record_type: recordType, surface: context.surface, run_status: context.runStatus, item_index: context.itemIndex, status: context.status, error_code: context.errorCode, target: context.target, university_id: context.universityId };
}

function identityRow(context: CsvContext, value: ExportIdentity, recordType = "identity"): CsvRow {
  return { ...baseRow(context, recordType), student_code: value.studentCode, internal_student_id: value.internalStudentId, student_name: value.studentName, managing_class: value.managingClass };
}

function reportedRow(context: CsvContext, value: ExportReported): CsvRow {
  return { ...baseRow(context, "reported_summary"), reported_cumulative_gpa4: value.cumulativeGpa4 };
}

function termRows(context: CsvContext, terms: readonly ExportDerivedTerm[]): CsvRow[] {
  return terms.flatMap((term) => [
    { ...baseRow(context, "term_summary"), term_code: term.termCode, term_label: term.termLabel, estimate_kind: term.estimateKind, listed_credits: term.listedCredits, included_credits: term.includedCredits, term_gpa4: term.termGpa4, derived_cpa4: term.derivedCpa4 },
    ...term.courses.map((item): CsvRow => ({ ...baseRow(context, "course"), term_code: term.termCode, term_label: term.termLabel, course_code: item.courseCode, course_name: item.courseName, credits: item.credits, point10: item.point10, letter: item.letter, point4: item.point4 })),
  ]);
}

function resultRows(context: CsvContext, value: ExportResult): CsvRow[] {
  const rows: CsvRow[] = [];
  if (value.identity) rows.push(identityRow(context, value.identity, value.derivedTerms !== undefined || value.reported !== undefined ? "identity" : "result"));
  if (value.classResult) rows.push({ ...baseRow(context, "result"), class_code: value.classResult.classCode, class_number: value.classResult.classNumber, class_id: value.classResult.classId, course_name: value.classResult.courseName });
  if (value.resolver) rows.push({ ...baseRow(context, "result"), resolved_student_code: value.resolver.resolvedStudentCode, resolved_internal_student_id: value.resolver.resolvedInternalStudentId, probes: value.resolver.probes });
  if (value.reported) rows.push(reportedRow(context, value.reported));
  if (value.derivedTerms) rows.push(...termRows(context, value.derivedTerms));
  return rows;
}

function csvRows(model: ExportDocument): CsvRow[] {
  const context: CsvContext = { surface: model.surface, universityId: model.universityId, runStatus: model.run?.status };
  const rows: CsvRow[] = [];
  if (model.query) rows.push({ ...baseRow(context, "query"), query_mode: model.query.mode, query_value: model.query.value });
  if (model.identity) rows.push(identityRow(context, model.identity));
  if (model.reported) rows.push(reportedRow(context, model.reported));
  if (model.derivedTerms) rows.push(...termRows(context, model.derivedTerms));
  model.results?.forEach((item, index) => {
    if ("status" in item) {
      const itemContext: CsvContext = { ...context, itemIndex: index + 1, status: item.status, target: item.target, errorCode: item.status === "error" ? item.errorCode : undefined };
      if (item.status === "error") rows.push(baseRow(itemContext, "item"));
      else rows.push(...resultRows(itemContext, item.result));
    } else {
      rows.push(...resultRows(context, item));
    }
  });
  return rows;
}

function encodeCsvField(value: CsvValue): string {
  if (value === undefined) return "";
  const text = typeof value === "number" ? String(value) : (/^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeExportCsv(model: ExportDocument): string {
  const lines = [CSV_HEADERS.join(","), ...csvRows(model).map((row) => CSV_HEADERS.map((header) => encodeCsvField(row[header])).join(","))];
  return `\ufeff${lines.join("\r\n")}\r\n`;
}

const RESERVED_COMPONENTS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function sanitizeAsciiFilenameComponent(value: string): string {
  const ascii = value.normalize("NFKD").replace(/[^\x20-\x7e]/g, "");
  const cleaned = ascii.replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "-").replace(/[^A-Za-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return !cleaned || RESERVED_COMPONENTS.test(cleaned) ? "export" : cleaned.toLowerCase();
}

export function buildExportFilename(surface: ExportSurface, date: Date, format: ExportFormat): string {
  const day = date.toISOString().slice(0, 10);
  return `hyeboard-${sanitizeAsciiFilenameComponent(surface)}-${day}.${format}`;
}

export type DownloadAnchor = { href: string; download: string; click(): void; remove(): void };
export type DownloadEnvironment = { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void; createAnchor(): DownloadAnchor; appendAnchor(anchor: DownloadAnchor): void };

function browserDownloadEnvironment(): DownloadEnvironment {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement("a"),
    appendAnchor: (anchor) => document.body.append(anchor as HTMLAnchorElement),
  };
}

export function downloadExport(model: ExportDocument, format: ExportFormat, date = new Date(), environment = browserDownloadEnvironment()): void {
  const content = format === "json" ? serializeExportJson(model) : serializeExportCsv(model);
  const blob = new Blob([content], { type: format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8" });
  let url: string | undefined;
  let anchor: DownloadAnchor | undefined;
  try {
    url = environment.createObjectURL(blob);
    anchor = environment.createAnchor();
    anchor.href = url;
    anchor.download = buildExportFilename(model.surface, date, format);
    environment.appendAnchor(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    if (url) environment.revokeObjectURL(url);
  }
}
```

The actual surface strings are fixed union members and contain no identity. Keep `sanitizeAsciiFilenameComponent` public only for boundary tests; pages call `downloadExport`, not the sanitizer.

- [ ] **Step 4: Add localized reusable `ExportMenu`**

Add these keys to both dictionaries in `apps/web/src/lib/i18n.tsx` under a new top-level `exports` object:

```ts
exports: {
  action: "Export",
  json: "Download JSON",
  csv: "Download CSV",
  failed: "The export could not be downloaded. Your result is unchanged; try again.",
},
```

Vietnamese values:

```ts
exports: {
  action: "Xuất dữ liệu",
  json: "Tải JSON",
  csv: "Tải CSV",
  failed: "Không thể tải dữ liệu xuất. Kết quả vẫn được giữ nguyên; hãy thử lại.",
},
```

Create `apps/web/src/components/export-menu.tsx`:

```tsx
import { ChevronDown, Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { downloadExport, type ExportDocument, type ExportFormat } from "@/lib/data-export";
import { useLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function ExportMenu({ model, className }: { model: ExportDocument; className?: string }) {
  const { t } = useLocale();
  const [error, setError] = useState<string | undefined>();

  const choose = (format: ExportFormat) => {
    setError(undefined);
    try {
      downloadExport(model, format);
    } catch {
      setError(t.exports.failed);
    }
  };

  return (
    <div className={cn("min-w-0", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="min-h-11 gap-2">
            <Download className="h-4 w-4" aria-hidden="true" />
            {t.exports.action}
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem className="min-h-11" onSelect={() => choose("json")}>{t.exports.json}</DropdownMenuItem>
          <DropdownMenuItem className="min-h-11" onSelect={() => choose("csv")}>{t.exports.csv}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="mt-1 max-w-72 text-xs text-destructive" role="status" aria-live="polite">{error}</p>
    </div>
  );
}
```

Radix supplies arrow-key navigation, Escape dismissal, trigger focus return, and menu accessible roles. Do not log caught export data or errors.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/data-export.test.ts src/components/export-menu.test.tsx
pnpm --filter @hyeboard/web typecheck
```

Expected: both test files PASS and web typecheck exits 0.

- [ ] **Step 6: Commit export primitives**

```bash
git add apps/web/src/lib/data-export.ts apps/web/src/lib/data-export.test.ts apps/web/src/components/export-menu.tsx apps/web/src/components/export-menu.test.tsx apps/web/src/lib/i18n.tsx
git commit -m "feat(web): add safe local data exports"
```

---

### Task 3: Integrate Derived Summaries and Term/Page Exports into Grades

**Files:**
- Modify: `apps/web/src/components/shared.tsx:33-43` (`FeatureFrameProps`, `FeatureFrame`, `FeatureHeader`)
- Modify: `apps/web/src/pages/grades.tsx:1-38,200-264` (`gradeTermKey`, `summarizeGrades`, `GradesPage`)
- Modify: `apps/web/src/lib/i18n.tsx:149-173,617-641`
- Modify: `apps/web/tests/smoke.spec.ts:412-453`

- [ ] **Step 1: Write the failing Grades end-to-end test**

Add this helper near `loginDemo` in `apps/web/tests/smoke.spec.ts`:

```ts
async function downloadText(download: import("@playwright/test").Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
```

Add this test after the current Grades test:

```ts
test("grades render derived term GPA and CPA and export current page and term state", async ({ page }) => {
  await loginDemo(page);
  await page.goto("/grades");

  const newestHeader = page.getByTestId("academic-term-header").first();
  await expect(newestHeader).toContainText("Derived");
  await expect(newestHeader).toContainText("Term GPA 3.45");
  await expect(newestHeader).toContainText("CPA 3.43");
  await expect(newestHeader).toContainText("Included credits 6 / 6 listed");
  await expect(page.getByText("Portal cumulative GPA")).toBeVisible();

  const pageExport = page.getByTestId("grades-page-export");
  const pageDownloadPromise = page.waitForEvent("download");
  await pageExport.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  const pageDownload = await pageDownloadPromise;
  expect(pageDownload.suggestedFilename()).toMatch(/^hyeboard-grades-page-\d{4}-\d{2}-\d{2}\.json$/);
  const pageModel = JSON.parse(await downloadText(pageDownload)) as { surface: string; reported: { cumulativeGpa4: number }; derivedTerms: Array<{ estimateKind: string; termGpa4: number; derivedCpa4: number }> };
  expect(pageModel).toMatchObject({ surface: "grades-page", reported: { cumulativeGpa4: 3.48 } });
  expect(pageModel.derivedTerms).toHaveLength(1);
  expect(pageModel.derivedTerms[0]).toMatchObject({ estimateKind: "derived", termGpa4: 3.45, derivedCpa4: 37.7 / 11 });

  const termDownloadPromise = page.waitForEvent("download");
  await newestHeader.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Download CSV" }).click();
  const termDownload = await termDownloadPromise;
  const csv = await downloadText(termDownload);
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain("grades-term");
  expect(csv).toContain("\r\n");

  await page.getByRole("combobox", { name: "Term" }).click();
  await page.getByRole("option", { name: "All terms" }).click();
  await expect(page.getByTestId("academic-term-header")).toHaveCount(2);
  const allTermsDownloadPromise = page.waitForEvent("download");
  await pageExport.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  const allTermsModel = JSON.parse(await downloadText(await allTermsDownloadPromise)) as { derivedTerms: Array<{ termCode: string }> };
  expect(allTermsModel.derivedTerms.map((term) => term.termCode)).toEqual(["20251", "20242"]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts -g "grades render derived term GPA" --workers=1
```

Expected: FAIL because the compact derived header and export controls are absent.

- [ ] **Step 3: Let `FeatureFrame` accept a page-header action**

Replace `FeatureFrameProps`, `FeatureFrame`, and `FeatureHeader` in `apps/web/src/components/shared.tsx`:

```tsx
type FeatureFrameProps<T> = {
  title: string;
  description: string;
  query: { data?: T; error: Error | null; isLoading: boolean };
  actions?: ReactNode;
  children: (data: T) => ReactNode;
};

export function FeatureFrame<T>({ title, description, query, actions, children }: FeatureFrameProps<T>) {
  const { t } = useLocale();
  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <QueryErrorPanel error={query.error} />;
  return <div className="animate-page space-y-4"><FeatureHeader title={title} description={description} actions={actions} />{query.data ? children(query.data) : <Empty text={t.common.noData} />}</div>;
}

export function FeatureHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">{description}</p>
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
```

- [ ] **Step 4: Replace local Grades arithmetic with shared summaries and export adapters**

Update imports in `apps/web/src/pages/grades.tsx` to include `useMemo`, `ExportMenu`, calculator functions, and export types/builders. Delete `gradeTermKey` and `summarizeGrades`; `calculateTermAcademicSummaries` now owns grouping and arithmetic. Retain `usesUetTermRules` because the existing `isSummerGrade` helper still calls it. Do not delete or rename that dependency in this task; alternatively, rewrite `isSummerGrade` to inline the exact `universityId === "uet" || universityId === "mock"` predicate before deleting `usesUetTermRules`, then typecheck the web package in the same step.

Add these complete adapters above `GradesPage`:

```ts
import { ExportMenu } from "@/components/export-menu";
import { createGradesExport, type ExportDerivedTerm } from "@/lib/data-export";
import { calculateTermAcademicSummaries, newestAcademicTermsFirst, type AcademicTermSummary } from "@/lib/term-academic-summary";

function gradeExportTerm(
  summary: AcademicTermSummary<Grade>,
  universityId: string,
  termLabel: string,
  sortedCourses: Grade[],
): ExportDerivedTerm {
  return {
    termCode: summary.termKey,
    termLabel,
    estimateKind: summary.estimateKind,
    listedCredits: summary.listedCredits,
    includedCredits: summary.includedCredits,
    termGpa4: summary.termGpa4,
    derivedCpa4: summary.cpa4,
    courses: sortedCourses.map((grade) => ({
      courseCode: grade.courseCode,
      courseName: grade.courseName,
      credits: grade.credits ?? undefined,
      point10: grade.point10 ?? undefined,
      letter: letterForGrade(grade, universityId),
      point4: grade.point4 ?? undefined,
    })),
  };
}

function CompactAcademicMetric({ label, value }: { label: string; value: string }) {
  return <span className="whitespace-nowrap text-sm"><span className="text-muted-foreground">{label}</span> <strong className="font-semibold tabular-nums">{value}</strong></span>;
}
```

Inside `GradesPage`, compute summaries once before returning JSX:

```tsx
const summaries = useMemo(() => newestAcademicTermsFirst(calculateTermAcademicSummaries(
  (query.data ?? []).map((grade) => ({
    termKey: grade.termCode ?? "unknown",
    credits: grade.credits,
    point4: grade.point4,
    course: grade,
    isSummer: Boolean(grade.termCode?.endsWith("3")),
  })),
  state.universityId,
)), [query.data, state.universityId]);
const summaryByKey = new Map(summaries.map((summary) => [summary.termKey, summary]));
const termKeys = summaries.map((summary) => summary.termKey);
const newestTerm = termKeys[0];
const effectiveTerm = selectedTerm && (selectedTerm === ALL_TERMS || summaryByKey.has(selectedTerm)) ? selectedTerm : newestTerm;
const visibleSummaries = effectiveTerm === ALL_TERMS ? summaries : summaries.filter((summary) => summary.termKey === effectiveTerm);
const student = state.dashboard.data?.student;
const reported = state.dashboard.data?.gpa;
const exportTerms = visibleSummaries.map((summary) => {
  const label = summary.termKey === "unknown" ? t.grades.unknownTerm : formatTermLabel(summary.termKey, state.universityId, t.terms);
  return gradeExportTerm(summary, state.universityId, label, sortGrades(summary.courses, sort));
});
const pageExport = exportTerms.length ? createGradesExport({
  surface: "grades-page",
  universityId: state.universityId,
  identity: student ? { studentCode: student.studentCode, studentName: student.fullName, managingClass: student.className } : undefined,
  reported: reported ? { cumulativeGpa4: reported.gpa ?? undefined, totalCredits: reported.totalCredits, accumulatedCredits: reported.totalAccumulatedCredits } : undefined,
  derivedTerms: exportTerms,
}) : undefined;
```

Pass `actions={pageExport ? <div data-testid="grades-page-export"><ExportMenu model={pageExport} /></div> : undefined}` to `FeatureFrame`. Replace the body callback's local grouping with the already computed `visibleSummaries` and render each term using this compact header:

```tsx
{visibleSummaries.map((summary) => {
  const sortedGrades = sortGrades(summary.courses, sort);
  const displayTerm = summary.termKey === "unknown" ? t.grades.unknownTerm : formatTermLabel(summary.termKey, state.universityId, t.terms);
  const exportTerm = gradeExportTerm(summary, state.universityId, displayTerm, sortedGrades);
  const termExport = createGradesExport({
    surface: "grades-term",
    universityId: state.universityId,
    identity: student ? { studentCode: student.studentCode, studentName: student.fullName, managingClass: student.className } : undefined,
    reported: reported ? { cumulativeGpa4: reported.gpa ?? undefined, totalCredits: reported.totalCredits, accumulatedCredits: reported.totalAccumulatedCredits } : undefined,
    derivedTerms: [exportTerm],
  });
  return (
    <section key={summary.termKey} className="space-y-2" aria-labelledby={`grades-term-${summary.termKey}`}>
      <header data-testid="academic-term-header" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 id={`grades-term-${summary.termKey}`} className="break-words text-base font-semibold">{displayTerm}</h2>
          {summary.includesSummer ? <Badge className="border border-border bg-background text-foreground">{t.grades.includesSummer}</Badge> : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
          <Badge data-tone="neutral" title={t.grades.derivedDetail}>{t.grades.derived}</Badge>
          <CompactAcademicMetric label={t.grades.termGpa} value={summary.termGpa4?.toFixed(2) ?? "-"} />
          <CompactAcademicMetric label={t.grades.cpa} value={summary.cpa4?.toFixed(2) ?? "-"} />
          <CompactAcademicMetric label={t.grades.includedCredits} value={t.grades.creditRatio(summary.includedCredits, summary.listedCredits)} />
        </div>
        <ExportMenu model={termExport} className="ml-auto" />
      </header>
      <GradeTable grades={sortedGrades} sort={sort} onSortChange={setSort} universityId={state.universityId} />
    </section>
  );
})}
```

Keep the top `SummaryStrip`, but label `reported.gpa` as `t.grades.reportedCumulativeGpa` and `reported.cpa` as `t.grades.reportedSecondaryGpa`. Never replace either with `summary.termGpa4` or `summary.cpa4`. Change the term selector to `className="min-h-11 w-full sm:w-[220px]"`.

- [ ] **Step 5: Add English and Vietnamese Grades copy**

Add matching keys in both dictionaries:

```ts
derived: "Derived",
reportedCumulativeGpa: "Portal cumulative GPA",
reportedSecondaryGpa: "Portal secondary GPA",
includedCredits: "Included credits",
creditRatio: (included: number, listed: number) => `${included} / ${listed} listed`,
derivedDetail: "Calculated from listed graded courses; university exclusion and repeat rules are not inferred.",
```

Vietnamese:

```ts
derived: "Ước tính",
reportedCumulativeGpa: "GPA tích lũy từ cổng trường",
reportedSecondaryGpa: "GPA phụ từ cổng trường",
includedCredits: "Tín chỉ được tính",
creditRatio: (included: number, listed: number) => `${included} / ${listed} đã liệt kê`,
derivedDetail: "Tính từ các môn đã có điểm; không suy đoán quy tắc loại trừ hoặc học lại của trường.",
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/term-academic-summary.test.ts src/lib/data-export.test.ts
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts -g "grades (default|render derived)" --workers=1
pnpm --filter @hyeboard/web typecheck
```

Expected: calculator/export unit tests PASS; existing Grades behavior and new derived/export test PASS; web typecheck exits 0.

- [ ] **Step 7: Commit Grades integration**

```bash
git add apps/web/src/components/shared.tsx apps/web/src/pages/grades.tsx apps/web/src/lib/i18n.tsx apps/web/tests/smoke.spec.ts
git commit -m "feat(web): show and export derived grade summaries"
```

---

### Task 4: Add Central Runtime Config and Optional University Limits Metadata

**Files:**
- Create: `apps/worker/src/vnu-runtime-config.ts`
- Create: `apps/worker/src/vnu-runtime-config.test.ts`
- Modify: `packages/schemas/src/index.ts:36-42,246-248`
- Modify: `apps/worker/src/app.ts:17-86,128-134,786-792`
- Modify: `apps/worker/src/app.test.ts:15-17,1080-1105`
- Modify: `apps/worker/src/university-capabilities.test.ts:21-91`
- Modify: `apps/worker/src/index.ts:11-20`
- Modify: `apps/worker/src/start.ts:14-28`
- Modify: `apps/worker/wrangler.jsonc:11-16`
- Modify: `apps/worker/config.json:10-14`
- Modify: `apps/worker/worker-configuration.d.ts` (generated)
- Modify: `apps/worker/.env.example:1-6`
- Modify: `scripts/package.mjs:78-93`

- [ ] **Step 1: Write failing config and metadata tests**

Create `apps/worker/src/vnu-runtime-config.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { normalizeSelfHostedInteger, parseVnuRuntimeConfig } from "./vnu-runtime-config";

describe("parseVnuRuntimeConfig", () => {
  it("uses documented missing defaults", () => {
    expect(parseVnuRuntimeConfig({})).toEqual({ codeLookupConcurrency: 16, crossLookupBulkMaxTargets: 50 });
  });

  it.each(["1", "16", "32", String(Number.MAX_SAFE_INTEGER)])("accepts positive canonical concurrency %s", (value) => {
    expect(parseVnuRuntimeConfig({ codeLookupConcurrency: value }).codeLookupConcurrency).toBe(Number(value));
  });

  it.each(["0", "", " 16", "16 ", "+16", "-1", "1.0", "1e2", "0x10", "01", String(Number.MAX_SAFE_INTEGER + 1)])("falls concurrency %j back to one", (value) => {
    expect(parseVnuRuntimeConfig({ codeLookupConcurrency: value }).codeLookupConcurrency).toBe(1);
  });

  it.each(["0", "1", "50", String(Number.MAX_SAFE_INTEGER)])("accepts canonical bulk maximum %s without a product ceiling", (value) => {
    expect(parseVnuRuntimeConfig({ crossLookupBulkMaxTargets: value }).crossLookupBulkMaxTargets).toBe(Number(value));
  });

  it.each(["", " 50", "50 ", "+50", "-1", "1.5", "5e1", "0x32", "050", String(Number.MAX_SAFE_INTEGER + 1)])("disables bulk for malformed value %j", (value) => {
    expect(parseVnuRuntimeConfig({ crossLookupBulkMaxTargets: value }).crossLookupBulkMaxTargets).toBe(0);
  });

  it("warns with only setting name and fallback", () => {
    const warn = vi.fn();
    parseVnuRuntimeConfig({ codeLookupConcurrency: "raw-secret-like-value", crossLookupBulkMaxTargets: "another-raw-value" }, warn);
    expect(warn.mock.calls).toEqual([
      ["VNU_CODE_LOOKUP_CONCURRENCY", 1],
      ["VNU_CROSS_LOOKUP_BULK_MAX_TARGETS", 0],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("raw-secret-like-value");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("another-raw-value");
  });
});

describe("normalizeSelfHostedInteger", () => {
  it.each([
    [undefined, undefined],
    [0, "0"],
    [16, "16"],
    [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
    ["16", "16"],
    [" 16", " 16"],
    [-1, ""],
    [1.5, ""],
    [Number.MAX_SAFE_INTEGER + 1, ""],
    [true, ""],
    [null, ""],
    [{}, ""],
  ])("normalizes file value %j to %j", (input, expected) => {
    expect(normalizeSelfHostedInteger(input)).toBe(expected);
  });
});
```

In `apps/worker/src/university-capabilities.test.ts`, widen the payload type and replace the final coordinator test with these two tests, preserving its required last-test ordering:

```ts
type UniversitiesPayload = {
  data: Array<{
    id: string;
    capabilities: Record<string, boolean>;
    limits?: { crossLookup?: { bulkMaxTargets: number } };
  }>;
};

it("omits runtime limits when the authoritative coordinator is unavailable", async () => {
  const universities = await listUniversities(createApp(undefined));
  const vnu = universities.find((university) => university.id === "vnu");
  expect(vnu?.capabilities.crossLookup).toBe(false);
  expect(vnu?.limits).toBeUndefined();
});

it("publishes effective optional VNU limits without mutating other universities once the coordinator is installed", async () => {
  setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: "9007199254740991" });
  const coordinator: VnuProbeBudgetCoordinator = { async consume() {}, async reserve() {} };
  setVnuProbeBudgetCoordinator(coordinator);
  const universities = await listUniversities(createApp(undefined));
  expect(universities.find((university) => university.id === "vnu")).toMatchObject({
    capabilities: { crossLookup: true },
    limits: { crossLookup: { bulkMaxTargets: Number.MAX_SAFE_INTEGER } },
  });
  expect(universities.find((university) => university.id === "mock")?.limits).toBeUndefined();
  expect(universities.find((university) => university.id === "uet")?.limits).toBeUndefined();

  setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: "0" });
  const disabledBulkUniversities = await listUniversities(createApp(undefined));
  expect(disabledBulkUniversities.find((university) => university.id === "vnu")?.limits?.crossLookup?.bulkMaxTargets).toBe(0);
});
```

Add a worker test in `apps/worker/src/app.test.ts` for file/environment precedence:

```ts
it("normalizes self-hosted VNU file values and gives environment values precedence", () => {
  const fileConfig = {
    VNU_CODE_LOOKUP_CONCURRENCY: "16",
    VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: "75",
  };
  expect(selfHostedRuntimeConfig({
    HYEB_SESSION_SECRET: SESSION_SECRET,
    VNU_CODE_LOOKUP_CONCURRENCY: "32",
  }, fileConfig)).toMatchObject({
    VNU_CODE_LOOKUP_CONCURRENCY: "32",
    VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: "75",
  });
});
```

Keep `isVnuFarWalkEnabled` in the `app.ts` test import through Task 4. Replace the old self-hosted environment-wiring cases with direct compatibility-helper assertions so the field remains internal while routes still compile:

```ts
it.each([undefined, "false", "1", "TRUE", "True", " true", "true "])('keeps the internal far compatibility helper disabled for %j', (value) => {
  expect(isVnuFarWalkEnabled(value)).toBe(false);
});

it('recognizes literal true only for the temporary internal route compatibility path', () => {
  expect(isVnuFarWalkEnabled("true")).toBe(true);
});
```

Keep the existing route-level default/explicit tests until Task 6. Do not expose the legacy field through `start.ts`, `index.ts`, Wrangler bindings, `config.json`, `.env.example`, package output, metadata, or documentation. Task 6 deletes the route arguments, field, helper, and these compatibility tests together.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @hyeboard/worker exec vitest run src/vnu-runtime-config.test.ts
pnpm --filter @hyeboard/worker exec vitest run src/university-capabilities.test.ts src/app.test.ts -t "Runtime|runtime|limits|self-hosted VNU|far compatibility"
```

Expected: the complete runtime-config file fails because the parser does not exist, including `normalizeSelfHostedInteger` coverage; focused metadata/config integration tests also fail.

- [ ] **Step 3: Implement canonical effective-value parsing**

Create `apps/worker/src/vnu-runtime-config.ts`:

```ts
export type EffectiveVnuRuntimeConfig = {
  codeLookupConcurrency: number;
  crossLookupBulkMaxTargets: number;
};

export type VnuRuntimeConfigInput = {
  codeLookupConcurrency?: string;
  crossLookupBulkMaxTargets?: string;
};

export type VnuConfigWarning = (setting: "VNU_CODE_LOOKUP_CONCURRENCY" | "VNU_CROSS_LOOKUP_BULK_MAX_TARGETS", effectiveFallback: number) => void;

const CANONICAL_INTEGER = /^(?:0|[1-9]\d*)$/;

function safeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !CANONICAL_INTEGER.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseVnuRuntimeConfig(input: VnuRuntimeConfigInput, warn?: VnuConfigWarning): EffectiveVnuRuntimeConfig {
  const concurrency = input.codeLookupConcurrency === undefined ? 16 : safeInteger(input.codeLookupConcurrency);
  const bulkMaximum = input.crossLookupBulkMaxTargets === undefined ? 50 : safeInteger(input.crossLookupBulkMaxTargets);
  const codeLookupConcurrency = concurrency !== undefined && concurrency > 0 ? concurrency : 1;
  const crossLookupBulkMaxTargets = bulkMaximum !== undefined ? bulkMaximum : 0;
  if (input.codeLookupConcurrency !== undefined && codeLookupConcurrency === 1 && input.codeLookupConcurrency !== "1") warn?.("VNU_CODE_LOOKUP_CONCURRENCY", 1);
  if (input.crossLookupBulkMaxTargets !== undefined && bulkMaximum === undefined) warn?.("VNU_CROSS_LOOKUP_BULK_MAX_TARGETS", 0);
  return { codeLookupConcurrency, crossLookupBulkMaxTargets };
}

export function normalizeSelfHostedInteger(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return "";
}
```

No warning receives the malformed value.

- [ ] **Step 4: Extend the shared University schema compatibly**

Insert before `universitySchema` in `packages/schemas/src/index.ts`:

```ts
export const universityLimitsSchema = z.object({
  crossLookup: z.object({
    bulkMaxTargets: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).optional(),
});
```

Add `limits: universityLimitsSchema.optional()` to `universitySchema`, then export:

```ts
export type UniversityLimits = z.infer<typeof universityLimitsSchema>;
```

Optional nesting keeps old university payloads and universities without cross lookup valid.

- [ ] **Step 5: Centralize Worker and self-hosted config flow**

In `apps/worker/src/app.ts`, add these fields beside the temporary internal `VNU_FAR_WALK_ENABLED?: string` field:

```ts
VNU_CODE_LOOKUP_CONCURRENCY?: string;
VNU_CROSS_LOOKUP_BULK_MAX_TARGETS?: string;
```

Update the structured `config.json` comment above `loadConfigFile` to list the `vnu.code_lookup_concurrency` and `vnu.cross_lookup_bulk_max_targets` fields.

Import `normalizeSelfHostedInteger`, `parseVnuRuntimeConfig`, and `EffectiveVnuRuntimeConfig`. Keep one parsed state beside `runtimeConfig`:

```ts
let runtimeConfig: RuntimeConfig = {};
let effectiveVnuRuntimeConfig: EffectiveVnuRuntimeConfig = parseVnuRuntimeConfig({});

export function setRuntimeConfig(config: RuntimeConfig): void {
  runtimeConfig = config;
  effectiveVnuRuntimeConfig = parseVnuRuntimeConfig({
    codeLookupConcurrency: config.VNU_CODE_LOOKUP_CONCURRENCY,
    crossLookupBulkMaxTargets: config.VNU_CROSS_LOOKUP_BULK_MAX_TARGETS,
  }, (setting, effectiveFallback) => getLogger().warn({ setting, effectiveFallback }, "invalid VNU runtime setting; using safe fallback"));
}

export function getEffectiveVnuRuntimeConfig(): EffectiveVnuRuntimeConfig {
  return effectiveVnuRuntimeConfig;
}
```

Keep `isVnuFarWalkEnabled` and `vnuFarWalkEnabled` unchanged through this commit because the three resolver route call sites still pass `farWalkEnabled`. Keep `VNU_FAR_WALK_ENABLED` only in the internal `RuntimeConfig` type; do not read it from the config file. In `loadConfigFile`, after browser parsing, add:

```ts
if (cfg.vnu && typeof cfg.vnu === "object" && !Array.isArray(cfg.vnu)) {
  r.VNU_CODE_LOOKUP_CONCURRENCY = normalizeSelfHostedInteger(cfg.vnu.code_lookup_concurrency);
  r.VNU_CROSS_LOOKUP_BULK_MAX_TARGETS = normalizeSelfHostedInteger(cfg.vnu.cross_lookup_bulk_max_targets);
}
```

In `apps/worker/src/start.ts`, return:

```ts
VNU_CODE_LOOKUP_CONCURRENCY: environment.VNU_CODE_LOOKUP_CONCURRENCY ?? fileConfig.VNU_CODE_LOOKUP_CONCURRENCY,
VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: environment.VNU_CROSS_LOOKUP_BULK_MAX_TARGETS ?? fileConfig.VNU_CROSS_LOOKUP_BULK_MAX_TARGETS,
```

In `apps/worker/src/start.ts`, omit the far field from the returned environment/file merge so self-hosted runtime input cannot publish it. In `apps/worker/src/index.ts`, remove its Cloudflare mapping and wire only:

```ts
VNU_CODE_LOOKUP_CONCURRENCY: cfEnv.VNU_CODE_LOOKUP_CONCURRENCY,
VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: cfEnv.VNU_CROSS_LOOKUP_BULK_MAX_TARGETS,
```

- [ ] **Step 6: Publish effective metadata only for an available VNU capability**

Replace `serializeUniversities` in `apps/worker/src/app.ts`:

```ts
function serializeUniversities() {
  const universities = listUniversities();
  return universities.map((university) => {
    if (!probeBudgetCoordinatorInstalled && university.capabilities.crossLookup) {
      return { ...university, limits: undefined, capabilities: { ...university.capabilities, crossLookup: false } };
    }
    if (probeBudgetCoordinatorInstalled && university.id === "vnu" && university.capabilities.crossLookup) {
      return {
        ...university,
        limits: { crossLookup: { bulkMaxTargets: effectiveVnuRuntimeConfig.crossLookupBulkMaxTargets } },
      };
    }
    return university;
  });
}
```

This copies adapter records; never mutate registry objects. Publish zero as zero. Omit limits when capability masking makes cross lookup unavailable.

- [ ] **Step 7: Synchronize Cloudflare, self-hosted, and packaged defaults**

Replace the far var in `apps/worker/wrangler.jsonc`:

```json
"VNU_CODE_LOOKUP_CONCURRENCY": "16",
"VNU_CROSS_LOOKUP_BULK_MAX_TARGETS": "50"
```

Add to `apps/worker/config.json`:

```json
"vnu": {
  "code_lookup_concurrency": 16,
  "cross_lookup_bulk_max_targets": 50
},
```

Add the same object to the `config` literal in `scripts/package.mjs`:

```js
vnu: {
  code_lookup_concurrency: 16,
  cross_lookup_bulk_max_targets: 50,
},
```

Append to `apps/worker/.env.example`:

```dotenv
# Optional non-secret overrides; config.json carries the same defaults.
# VNU_CODE_LOOKUP_CONCURRENCY=16
# VNU_CROSS_LOOKUP_BULK_MAX_TARGETS=50
```

Generate bindings from the worktree root:

```bash
pnpm --filter @hyeboard/worker exec wrangler types
```

Expected: `apps/worker/worker-configuration.d.ts` contains both new string bindings in `Cloudflare.Env` and `NodeJS.ProcessEnv`, and contains no far binding. Do not edit generated lines by hand.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @hyeboard/worker exec vitest run src/vnu-runtime-config.test.ts
pnpm --filter @hyeboard/worker exec vitest run src/university-capabilities.test.ts src/app.test.ts -t "Runtime|runtime|limits|self-hosted VNU|far compatibility"
pnpm --filter @hyeboard/worker typecheck
pnpm --filter @hyeboard/schemas typecheck
```

Expected: the complete runtime-config test file PASS, including every `normalizeSelfHostedInteger` case; focused integration tests PASS; both typechecks exit 0. Task 4 therefore commits a type-correct compatibility state: routes still pass the internal far argument, but no deployment/config surface publishes its flag.

- [ ] **Step 9: Commit runtime config and metadata**

```bash
git add packages/schemas/src/index.ts apps/worker/src/vnu-runtime-config.ts apps/worker/src/vnu-runtime-config.test.ts apps/worker/src/app.ts apps/worker/src/app.test.ts apps/worker/src/university-capabilities.test.ts apps/worker/src/index.ts apps/worker/src/start.ts apps/worker/wrangler.jsonc apps/worker/worker-configuration.d.ts apps/worker/config.json apps/worker/.env.example scripts/package.mjs
git commit -m "feat(worker): configure VNU lookup runtime limits"
```

---

### Task 5: Replace Far Walking with a Bounded Exact Concurrent Resolver

**Files:**
- Modify: `apps/worker/src/vnu-student-id-resolver.ts:3-106`
- Modify: `apps/worker/src/vnu-student-id-resolver.test.ts:1-266`
- Modify: `packages/university-adapters/src/vnu/daotao-client.ts:20-40,69-100`
- Create: `packages/university-adapters/src/vnu/daotao-client.test.ts`

- [ ] **Step 1: Replace resolver tests with the failing local-window contract**

Replace `apps/worker/src/vnu-student-id-resolver.test.ts`. Keep all identifiers synthetic. The test file must contain these helpers and cases:

```ts
import { HyeboardError } from "@hyeboard/core";
import { describe, expect, it, vi } from "vitest";
import { resolveVnuStudentId, VNU_STUDENT_ID_RESOLVER_MAX_PROBES, VNU_STUDENT_ID_RESOLVER_PLATFORM_CONCURRENCY } from "./vnu-student-id-resolver";

const SYNTHETIC_STUDENT_CODE = "99000001";
const SYNTHETIC_INTERNAL_ID = "99000000001";
const OWN_STD_ID = Number(SYNTHETIC_INTERNAL_ID);
const OWN_CODE = SYNTHETIC_STUDENT_CODE;

function syntheticCode(delta: number): string {
  return String(Number(SYNTHETIC_STUDENT_CODE) + delta);
}

function projected(targetCode: string): number {
  return OWN_STD_ID + (Number(targetCode) - Number(OWN_CODE));
}

function options(targetCode: string, fetchStudentCode: (stdId: number, signal: AbortSignal) => Promise<string | undefined>, concurrency = 16, signal?: AbortSignal) {
  return { ownStdId: OWN_STD_ID, ownCode: Number(OWN_CODE), targetCode, fetchStudentCode, concurrency, signal };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe("resolveVnuStudentId", () => {
  it("resolves a +89 code delta whose true ID is projection error +2", async () => {
    const target = syntheticCode(89);
    const guess = projected(target);
    const fetchStudentCode = vi.fn(async (stdId: number) => stdId === guess ? syntheticCode(87) : stdId === guess + 2 ? target : undefined);
    await expect(resolveVnuStudentId(options(target, fetchStudentCode, 1))).resolves.toEqual({ stdId: String(guess + 2).padStart(11, "0"), stdCode: target, probes: 2 });
    expect(fetchStudentCode.mock.calls.map(([stdId]) => stdId)).toEqual([guess, guess + 2]);
  });

  it("returns exact success at the initial projection", async () => {
    const target = syntheticCode(10);
    const fetchStudentCode = vi.fn(async () => target);
    await expect(resolveVnuStudentId(options(target, fetchStudentCode))).resolves.toMatchObject({ stdCode: target, probes: 1 });
    expect(fetchStudentCode).toHaveBeenCalledOnce();
  });

  it("temporarily accepts a numeric target, omitted concurrency, and ignored far flag with a serial default", async () => {
    const numericTarget = Number(syntheticCode(5));
    const guess = projected(String(numericTarget));
    let active = 0;
    let maximumActive = 0;
    const fetchStudentCode = vi.fn(async (stdId: number) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return stdId === guess + 1 ? String(numericTarget) : undefined;
    });
    await expect(resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: Number(OWN_CODE),
      targetCode: numericTarget,
      fetchStudentCode,
      farWalkEnabled: true,
    })).resolves.toMatchObject({ stdId: String(guess + 1).padStart(11, "0"), stdCode: String(numericTarget) });
    expect(maximumActive).toBe(1);
  });

  it("prioritizes one in-window first-probe correction and removes its default duplicate", async () => {
    const target = syntheticCode(20);
    const guess = projected(target);
    const calls: number[] = [];
    const fetchStudentCode = async (stdId: number) => {
      calls.push(stdId);
      if (stdId === guess) return syntheticCode(17);
      if (stdId === guess + 3) return target;
      return undefined;
    };
    await resolveVnuStudentId(options(target, fetchStudentCode, 1));
    expect(calls.slice(0, 2)).toEqual([guess, guess + 3]);
    expect(new Set(calls).size).toBe(calls.length);
  });

  it("treats headerless projection and local holes as misses", async () => {
    const target = syntheticCode(5);
    const guess = projected(target);
    const fetchStudentCode = vi.fn(async (stdId: number) => stdId === guess + 2 ? target : undefined);
    await expect(resolveVnuStudentId(options(target, fetchStudentCode, 1))).resolves.toMatchObject({ stdId: String(guess + 2).padStart(11, "0"), probes: 5 });
  });

  it("requires exact eight-character header equality", async () => {
    const target = syntheticCode(5);
    await expect(resolveVnuStudentId(options(target, async () => syntheticCode(6), 32))).rejects.toMatchObject({ code: "VNU_CROSS_LOOKUP_NOT_CONVERGED" });
    const leadingZeroTarget = "04001005";
    await expect(resolveVnuStudentId({ ...options(leadingZeroTarget, async () => "4001005", 1), ownCode: 4_001_000, ownStdId: 100_000 })).rejects.toMatchObject({ code: "VNU_CROSS_LOOKUP_NOT_CONVERGED" });
  });

  it("exhausts exactly the valid closed G ± 16 set without guessing", async () => {
    const target = syntheticCode(5);
    const calls: number[] = [];
    await expect(resolveVnuStudentId(options(target, async (stdId) => { calls.push(stdId); return undefined; }, 32))).rejects.toMatchObject({ code: "VNU_CROSS_LOOKUP_NOT_CONVERGED", status: 404 });
    const guess = projected(target);
    expect(calls).toHaveLength(33);
    expect(new Set(calls).size).toBe(33);
    expect(Math.min(...calls)).toBe(guess - 16);
    expect(Math.max(...calls)).toBe(guess + 16);
    expect(VNU_STUDENT_ID_RESOLVER_MAX_PROBES).toBe(33);
  });

  it("skips unsafe projection/window values and makes no request for an invalid projection", async () => {
    const fetchStudentCode = vi.fn(async () => undefined);
    await expect(resolveVnuStudentId({ ...options("99999999", fetchStudentCode), ownStdId: Number.MAX_SAFE_INTEGER, ownCode: 1 })).rejects.toMatchObject({ code: "VNU_CROSS_LOOKUP_NOT_CONVERGED" });
    expect(fetchStudentCode).not.toHaveBeenCalled();
  });

  it("dispatches in priority order and lets the earliest exact candidate win despite out-of-order completion", async () => {
    const target = syntheticCode(5);
    const guess = projected(target);
    const lower = deferred<string | undefined>();
    const fetchStudentCode = vi.fn(async (stdId: number) => {
      if (stdId === guess) return undefined;
      if (stdId === guess - 1) return lower.promise;
      if (stdId === guess + 1) return target;
      return undefined;
    });
    const resolution = resolveVnuStudentId(options(target, fetchStudentCode, 2));
    await vi.waitFor(() => expect(fetchStudentCode.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(fetchStudentCode.mock.calls.slice(0, 3).map(([stdId]) => stdId)).toEqual([guess, guess - 1, guess + 1]);
    lower.resolve(target);
    await expect(resolution).resolves.toMatchObject({ stdId: String(guess - 1).padStart(11, "0") });
  });

  it.each([1, 16, 32, 7, Number.MAX_SAFE_INTEGER])("bounds configured concurrency %s by candidates and platform limit", async (concurrency) => {
    let active = 0;
    let maximumActive = 0;
    await expect(resolveVnuStudentId(options(syntheticCode(5), async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return undefined;
    }, concurrency))).rejects.toMatchObject({ code: "VNU_CROSS_LOOKUP_NOT_CONVERGED" });
    expect(maximumActive).toBeLessThanOrEqual(Math.min(concurrency, 32, VNU_STUDENT_ID_RESOLVER_PLATFORM_CONCURRENCY));
    expect(maximumActive).toBeGreaterThan(0);
  });

  it("counts every started sibling and aborts lower-priority work after the deterministic winner", async () => {
    const target = syntheticCode(5);
    const guess = projected(target);
    const aborted: number[] = [];
    const fetchStudentCode = (stdId: number, signal: AbortSignal) => new Promise<string | undefined>((resolve, reject) => {
      if (stdId === guess) return resolve(undefined);
      if (stdId === guess - 1) return resolve(target);
      signal.addEventListener("abort", () => { aborted.push(stdId); reject(signal.reason); }, { once: true });
    });
    const result = await resolveVnuStudentId(options(target, fetchStudentCode, 4));
    expect(result.stdId).toBe(String(guess - 1).padStart(11, "0"));
    expect(result.probes).toBeGreaterThanOrEqual(2);
    expect(aborted.length).toBeGreaterThan(0);
  });

  it("links caller cancellation, aborts siblings, and preserves the caller reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException("caller stopped", "AbortError");
    const fetchStudentCode = (_stdId: number, signal: AbortSignal) => new Promise<string | undefined>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const resolution = resolveVnuStudentId(options(syntheticCode(5), fetchStudentCode, 4, controller.signal));
    controller.abort(reason);
    await expect(resolution).rejects.toBe(reason);
  });

  it("aborts active siblings and propagates a fatal probe error", async () => {
    const fatal = new HyeboardError("VNU_RATE_LIMITED", "synthetic", 429);
    let siblingAborted = false;
    const target = syntheticCode(5);
    const guess = projected(target);
    const fetchStudentCode = (stdId: number, signal: AbortSignal) => {
      if (stdId === guess) return Promise.resolve(undefined);
      if (stdId === guess - 1) return Promise.reject(fatal);
      return new Promise<string | undefined>((_resolve, reject) => signal.addEventListener("abort", () => { siblingAborted = true; reject(signal.reason); }, { once: true }));
    };
    await expect(resolveVnuStudentId(options(target, fetchStudentCode, 4))).rejects.toBe(fatal);
    expect(siblingAborted).toBe(true);
  });

  it.each(["VNU_LOGIN_REQUIRED", "VNU_SESSION_EXPIRED", "VNU_RATE_LIMITED", "VNU_UPSTREAM_UNAVAILABLE", "VNU_REQUEST_FAILED"])("propagates fatal %s instead of returning a miss", async (code) => {
    const fatal = new HyeboardError(code, "synthetic", code === "VNU_RATE_LIMITED" ? 429 : 502);
    await expect(resolveVnuStudentId(options(syntheticCode(5), async () => { throw fatal; }))).rejects.toBe(fatal);
  });
});
```

Write `packages/university-adapters/src/vnu/daotao-client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaotaoClient } from "./daotao-client";

const SYNTHETIC_INTERNAL_ID = "99000000001";

describe("DaotaoClient cancellation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes AbortSignal to Brc1 fetch", async () => {
    const fetchMock = vi.fn(async () => new Response("<html></html>"));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await new DaotaoClient().getTranscriptByStdIdHtml(SYNTHETIC_INTERNAL_ID, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`selStd=${SYNTHETIC_INTERNAL_ID}`), expect.objectContaining({ signal: controller.signal }));
  });

  it("preserves explicit cancellation instead of mapping it to upstream unavailable", async () => {
    const controller = new AbortController();
    const reason = new DOMException("synthetic cancel", "AbortError");
    vi.stubGlobal("fetch", vi.fn(async () => { controller.abort(reason); throw reason; }));
    await expect(new DaotaoClient().getTranscriptByStdIdHtml(SYNTHETIC_INTERNAL_ID, controller.signal)).rejects.toBe(reason);
  });

  it("still maps a transport failure to VNU_UPSTREAM_UNAVAILABLE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("synthetic transport"); }));
    await expect(new DaotaoClient().getTranscriptByStdIdHtml(SYNTHETIC_INTERNAL_ID)).rejects.toMatchObject({ code: "VNU_UPSTREAM_UNAVAILABLE", status: 502 });
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @hyeboard/worker exec vitest run src/vnu-student-id-resolver.test.ts
pnpm --filter @hyeboard/university-adapters exec vitest run src/vnu/daotao-client.test.ts
```

Expected: FAIL. Resolver assertions reject the far/linear implementation; adapter assertions reject Brc1 methods without a signal.

- [ ] **Step 3: Implement the complete bounded resolver**

Replace `apps/worker/src/vnu-student-id-resolver.ts`:

```ts
import { HyeboardError } from "@hyeboard/core";

const LOCAL_RADIUS = 16;
export const VNU_STUDENT_ID_RESOLVER_MAX_PROBES = 33;
export const VNU_STUDENT_ID_RESOLVER_PLATFORM_CONCURRENCY = 6;

export type VnuStudentIdResolution = { stdId: string; stdCode: string; probes: number };
export type VnuStudentIdResolverOptions = {
  ownStdId: number;
  ownCode: number;
  /** Temporary Task 5 route bridge. Task 6 narrows this back to string. */
  targetCode: string | number;
  /** Temporary Task 5 route bridge. Task 6 makes this required. */
  concurrency?: number;
  fetchStudentCode: (stdId: number, signal: AbortSignal) => Promise<string | undefined>;
  signal?: AbortSignal;
  platformConcurrencyLimit?: number;
  /** Temporary ignored call-site bridge. Task 6 removes this with the last legacy route arguments. */
  farWalkEnabled?: boolean;
};

type Outcome = "miss" | "exact";

function notConverged(): HyeboardError {
  return new HyeboardError("VNU_CROSS_LOOKUP_NOT_CONVERGED", "Could not resolve an exact internal student id inside the verified local projection window.", 404);
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The lookup was cancelled.", "AbortError");
}

function orderedLocalCandidates(projection: number, observedCode: string | undefined, targetCode: string): number[] {
  const defaults: number[] = [];
  for (let distance = 1; distance <= LOCAL_RADIUS; distance += 1) {
    for (const candidate of [projection - distance, projection + distance]) if (positiveSafeInteger(candidate)) defaults.push(candidate);
  }
  if (!observedCode || !/^\d{8}$/.test(observedCode) || observedCode === targetCode) return defaults;
  const correction = projection + (Number(targetCode) - Number(observedCode));
  if (!positiveSafeInteger(correction) || Math.abs(correction - projection) > LOCAL_RADIUS || correction === projection) return defaults;
  return [correction, ...defaults.filter((candidate) => candidate !== correction)];
}

function resolution(stdId: number, targetCode: string, probes: number): VnuStudentIdResolution {
  return { stdId: String(stdId).padStart(11, "0"), stdCode: targetCode, probes };
}

export async function resolveVnuStudentId(options: VnuStudentIdResolverOptions): Promise<VnuStudentIdResolution> {
  const { ownStdId, ownCode, fetchStudentCode } = options;
  // Temporary compatibility normalization for the pre-Task 6 numeric route calls.
  const targetCode = String(options.targetCode);
  const concurrency = options.concurrency ?? 1;
  if (!positiveSafeInteger(ownStdId) || !positiveSafeInteger(ownCode) || !/^\d{8}$/.test(targetCode)) throw notConverged();
  if (!positiveSafeInteger(concurrency)) throw new Error("VNU resolver concurrency must be a positive safe integer");
  if (options.signal?.aborted) throw abortReason(options.signal);

  const projection = ownStdId + (Number(targetCode) - ownCode);
  if (!positiveSafeInteger(projection)) throw notConverged();

  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(abortReason(options.signal!));
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  let probes = 0;

  try {
    probes += 1;
    let projectedCode: string | undefined;
    try {
      projectedCode = await fetchStudentCode(projection, controller.signal);
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      throw error;
    }
    if (projectedCode === targetCode) return resolution(projection, targetCode, probes);
    if (options.signal?.aborted) throw abortReason(options.signal);

    const candidates = orderedLocalCandidates(projection, projectedCode, targetCode);
    const platformLimit = options.platformConcurrencyLimit ?? VNU_STUDENT_ID_RESOLVER_PLATFORM_CONCURRENCY;
    if (!positiveSafeInteger(platformLimit)) throw new Error("VNU resolver platform concurrency limit must be a positive safe integer");
    const width = Math.min(concurrency, platformLimit, candidates.length);
    const outcomes: Array<Outcome | undefined> = new Array(candidates.length);
    let dispatchIndex = 0;
    let decisionIndex = 0;
    let winningIndex: number | undefined;
    let fatalError: unknown;
    let hasFatalError = false;

    const decideSettledPrefix = () => {
      while (decisionIndex < outcomes.length && outcomes[decisionIndex] !== undefined) {
        if (outcomes[decisionIndex] === "exact") {
          winningIndex = decisionIndex;
          controller.abort(new DOMException("Exact resolver winner selected.", "AbortError"));
          return;
        }
        decisionIndex += 1;
      }
    };

    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = dispatchIndex;
        if (index >= candidates.length) return;
        dispatchIndex += 1;
        const candidate = candidates[index]!;
        probes += 1;
        try {
          const observed = await fetchStudentCode(candidate, controller.signal);
          outcomes[index] = observed === targetCode ? "exact" : "miss";
          decideSettledPrefix();
        } catch (error) {
          if (controller.signal.aborted && (winningIndex !== undefined || hasFatalError || options.signal?.aborted)) return;
          hasFatalError = true;
          fatalError = error;
          controller.abort(error);
          return;
        }
      }
    };

    await Promise.allSettled(Array.from({ length: width }, () => worker()));
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (hasFatalError) throw fatalError;
    if (winningIndex !== undefined) return resolution(candidates[winningIndex]!, targetCode, probes);
    throw notConverged();
  } finally {
    options.signal?.removeEventListener("abort", onCallerAbort);
    if (!controller.signal.aborted) controller.abort(new DOMException("Resolver cleanup.", "AbortError"));
  }
}
```

After temporary boundary normalization, `targetCode` remains an exact string through equality and output. Numeric conversion appears only in projection/correction arithmetic. Headerless and malformed headers are misses. No far mode, delay, bisection, nearest result, or second correction exists. Task 5's `targetCode: string | number`, optional `concurrency` defaulting conservatively to `1`, and ignored `farWalkEnabled` are explicit compile-only compatibility bridges for current routes, which still pass numeric targets, omit concurrency, and pass the legacy flag. No resolver branch reads `farWalkEnabled`. Task 6 migrates every resolver route, then removes all three compatibility concessions atomically; final contract stays strict.

- [ ] **Step 4: Thread `AbortSignal` through `DaotaoClient`**

Change `fetchPage` and Brc1 method signatures in `packages/university-adapters/src/vnu/daotao-client.ts`:

```ts
private async fetchPage(path: string, signal?: AbortSignal): Promise<string> {
  const cookie = this.cookie();
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      redirect: "follow",
      headers: { "User-Agent": BROWSER_USER_AGENT, ...(cookie ? { Cookie: cookie } : {}) },
      signal,
    });
  } catch {
    if (signal?.aborted) throw abortReason(signal);
    throw new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", "Could not reach daotao.vnu.edu.vn. The portal may be down or your network may be blocking it.", 502);
  }
  if (response.status === 429) throw new HyeboardError("VNU_RATE_LIMITED", "daotao.vnu.edu.vn is rate-limiting requests. Wait a few minutes and try again.", 429);
  if (response.status >= 500) throw new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", `daotao.vnu.edu.vn returned ${response.status}. Try again later.`, 502);
  if (!response.ok) throw new HyeboardError("VNU_REQUEST_FAILED", `daotao.vnu.edu.vn rejected the request with HTTP ${response.status}.`, response.status);
  const html = await response.text();
  if (hasLoginForm(html)) throw new HyeboardError("VNU_SESSION_EXPIRED", "The university portal session has expired. Sign in again.", 401);
  return html;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The VNU request was cancelled.", "AbortError");
}

getTranscriptByStdIdHtml(stdId: string, signal?: AbortSignal): Promise<string> {
  const query = new URLSearchParams({ selStd: stdId.padStart(11, "0") });
  return this.fetchPage(`/ListPoint/listpoint_Brc1.asp?${query.toString()}`, signal);
}
```

Other `fetchPage` callers remain valid because `signal` is optional.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @hyeboard/worker exec vitest run src/vnu-student-id-resolver.test.ts
pnpm --filter @hyeboard/university-adapters exec vitest run src/vnu/daotao-client.test.ts
pnpm --filter @hyeboard/university-adapters typecheck
pnpm --filter @hyeboard/worker typecheck
```

Expected: local-window and cancellation suites PASS; adapter and Worker typechecks exit 0. Compatibility test proves numeric target acceptance, omitted concurrency's serial default, exact string normalization, and ignored far-flag acceptance. Worker routes compile against this temporary API before Task 6 exists, so Task 5 commit is independently type-correct.

- [ ] **Step 6: Commit resolver and cancellation primitives**

```bash
git add apps/worker/src/vnu-student-id-resolver.ts apps/worker/src/vnu-student-id-resolver.test.ts packages/university-adapters/src/vnu/daotao-client.ts packages/university-adapters/src/vnu/daotao-client.test.ts
git commit -m "refactor(worker): bound VNU student resolver search"
```

---

### Task 6: Integrate Atomic Reservations, Resolver Config, Cancellation, and Fatal Chunk Semantics

**Files:**
- Modify: `apps/worker/src/app.ts:374-393,557-600,962-1144`
- Modify: `apps/worker/src/app.test.ts:605-1106`
- Modify: `apps/worker/src/vnu-student-id-resolver.ts:12-24` (remove Task 5's ignored compatibility property after route arguments are gone)
- Modify: `apps/worker/src/vnu-student-id-resolver.test.ts:1-290` (remove Task 5's temporary compatibility case after final call-site migration)

- [ ] **Step 1: Write failing route and budget tests**

Replace old per-probe/far tests in `apps/worker/src/app.test.ts` with these reservation assertions:

First, replace the describe block's existing `profileHtml` and `targetTranscriptHtml` declarations with these reserved-range fixtures, then replace the existing request helpers so they accept an optional signal:

```ts
const SYNTHETIC_STUDENT_CODE = "99000001";
const SYNTHETIC_INTERNAL_ID = "99000000001";

async function authorizedRequest(
  query: string,
  route = "transcript",
  sessionCookie = "SYNTHETIC_TRANSCRIPT_COOKIE",
  signal?: AbortSignal,
  captureRequestSignal?: (signal: AbortSignal) => void,
): Promise<Response> {
  const session = { ...vnuSession(), vnu: { ...vnuSession().vnu!, value: sessionCookie } };
  const token = await encryptSession(session, SESSION_SECRET);
  const request = new Request(`http://localhost/api/vnu/cross-lookup/${route}?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  captureRequestSignal?.(request.signal);
  return app.handle(request);
}

async function bulkRawRequest(body: string, session?: EncryptedSessionPayload, signal?: AbortSignal): Promise<Response> {
  const token = session ? await encryptSession(session, SESSION_SECRET) : undefined;
  return app.handle(new Request("http://localhost/api/vnu/cross-lookup/bulk", {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body,
    signal,
  }));
}
```

Pass the optional signal through `bulkRequest` to `bulkRawRequest` as its third argument.

```ts
it("removes cross-lookup query targets from request-log metadata", () => {
  expect(requestLogPath(`https://hyeboard.example/api/vnu/cross-lookup/student-id?stdCode=${SYNTHETIC_STUDENT_CODE}&allowCrossLookup=true`)).toBe("/api/vnu/cross-lookup/student-id");
});

it.each([
  ["student-code", `stdId=${SYNTHETIC_INTERNAL_ID}&allowCrossLookup=true`, 1],
  ["student-id", `stdCode=${SYNTHETIC_STUDENT_CODE}&allowCrossLookup=true`, 33],
] as const)("reserves %s allowance atomically before Brc1", async (route, query, expectedUnits) => {
  const response = await authorizedRequest(query, route);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(probeBudget.amounts).toEqual([expectedUnits]);
  expect(transcriptSpy).toHaveBeenCalled();
});

it.each([
  [`stdId=${SYNTHETIC_INTERNAL_ID}&allowCrossLookup=true`, 1, 1],
  [`stdCode=${SYNTHETIC_STUDENT_CODE}&allowCrossLookup=true`, 34, 2],
] as const)("reserves transcript allowance %s once and performs the expected final fetch", async (query, expectedUnits, expectedFetches) => {
  const response = await authorizedRequest(query);
  expect(response.status).toBe(200);
  expect(probeBudget.amounts).toEqual([expectedUnits]);
  expect(transcriptSpy).toHaveBeenCalledTimes(expectedFetches);
});

it("rejects a single-route reservation before any Brc1 work and does not refund it", async () => {
  probeBudget.limit = 32;
  const response = await authorizedRequest(`stdCode=${SYNTHETIC_STUDENT_CODE}&allowCrossLookup=true`, "student-id");
  expect(response.status).toBe(429);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(probeBudget.amounts).toEqual([33]);
  expect(transcriptSpy).not.toHaveBeenCalled();
});

it("keeps ordinary bulk item failures ordered but rethrows systemic failures to stop the chunk", async () => {
  transcriptSpy
    .mockResolvedValueOnce("<html>headerless</html>")
    .mockRejectedValueOnce(new HyeboardError("VNU_RATE_LIMITED", "synthetic", 429))
    .mockResolvedValueOnce(targetTranscriptHtml);
  const response = await bulkRequest({ mode: "stdid-to-code", targets: ["1001", "1002", "1003"], allowCrossLookup: true });
  expect(response.status).toBe(429);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(transcriptSpy.mock.calls.map(([target]) => target)).toEqual(["1001", "1002"]);
});

it("keeps code-mode bulk targets sequential while candidate probes overlap", async () => {
  const secondStudentCode = String(Number(SYNTHETIC_STUDENT_CODE) + 49);
  let maximumCandidateFetches = 0;
  let activeCandidateFetches = 0;
  let activeFirstItemFetches = 0;
  let itemOverlap = false;
  transcriptSpy.mockImplementation(async (stdId: string) => {
    const numericId = Number(stdId);
    activeCandidateFetches += 1;
    if (numericId < Number(SYNTHETIC_INTERNAL_ID) + 30) activeFirstItemFetches += 1;
    else if (activeFirstItemFetches > 0) itemOverlap = true;
    maximumCandidateFetches = Math.max(maximumCandidateFetches, activeCandidateFetches);
    await new Promise((resolve) => setTimeout(resolve, 1));
    activeCandidateFetches -= 1;
    if (numericId < Number(SYNTHETIC_INTERNAL_ID) + 30) activeFirstItemFetches -= 1;
    const code = Number(SYNTHETIC_STUDENT_CODE) + numericId - Number(SYNTHETIC_INTERNAL_ID);
    return `<table><tr><td>Mã số: ${code}</td></tr></table>`;
  });
  const response = await bulkRequest({ mode: "code-to-stdid", targets: [SYNTHETIC_STUDENT_CODE, secondStudentCode], allowCrossLookup: true });
  const payload = await response.json() as { data: { items: Array<{ target: string }> } };
  expect(response.status).toBe(200);
  expect(payload.data.items.map((item) => item.target)).toEqual([SYNTHETIC_STUDENT_CODE, secondStudentCode]);
  expect(maximumCandidateFetches).toBeGreaterThan(1);
  expect(itemOverlap).toBe(false);
  expect(probeBudget.amounts).toEqual([66]);
});

it("passes the abortable Request signal to a direct route and preserves no-store error handling", async () => {
  const controller = new AbortController();
  const reason = new DOMException("synthetic caller cancellation", "AbortError");
  let requestSignal: AbortSignal | undefined;
  let observedSignal: AbortSignal | undefined;
  let settled = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  transcriptSpy.mockImplementation((_stdId, signal) => {
    observedSignal = signal;
    markStarted();
    return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => {
      settled = true;
      reject(signal!.reason);
    }, { once: true }));
  });

  const responsePromise = authorizedRequest(
    `stdId=${SYNTHETIC_INTERNAL_ID}&allowCrossLookup=true`,
    "student-code",
    "SYNTHETIC_TRANSCRIPT_COOKIE",
    controller.signal,
    (signal) => { requestSignal = signal; },
  );
  await started;
  controller.abort(reason);
  const response = await responsePromise;

  const capturedRequestSignal = requestSignal as AbortSignal | undefined;
  const capturedObservedSignal = observedSignal as AbortSignal | undefined;
  if (!capturedRequestSignal || !capturedObservedSignal) throw new Error("Expected request and upstream signals");
  expect(capturedRequestSignal).not.toBe(controller.signal); // Request constructs a dependent signal.
  expect(capturedObservedSignal).toBe(capturedRequestSignal);
  expect(capturedObservedSignal.aborted).toBe(true);
  expect(capturedObservedSignal.reason).toMatchObject({ name: "AbortError", message: "synthetic caller cancellation" });
  expect(settled).toBe(true);
  expect(response.status).toBe(500);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  await expect(response.json()).resolves.toMatchObject({ error: { code: "INTERNAL_ERROR" } });
});

it("aborts and settles every started resolver candidate when the route Request is cancelled", async () => {
  setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CODE_LOOKUP_CONCURRENCY: "4" });
  const controller = new AbortController();
  const startedSignals: AbortSignal[] = [];
  const settledSignals: AbortSignal[] = [];
  let markCandidatesStarted!: () => void;
  const candidatesStarted = new Promise<void>((resolve) => { markCandidatesStarted = resolve; });
  transcriptSpy.mockImplementation(async (_stdId, signal) => {
    if (transcriptSpy.mock.calls.length === 1) return `<table><tr><td>Mã số: ${String(Number(SYNTHETIC_STUDENT_CODE) - 1)}</td></tr></table>`;
    startedSignals.push(signal!);
    if (startedSignals.length === 4) markCandidatesStarted();
    return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => {
      settledSignals.push(signal!);
      reject(signal!.reason);
    }, { once: true }));
  });

  const responsePromise = authorizedRequest(`stdCode=${SYNTHETIC_STUDENT_CODE}&allowCrossLookup=true`, "student-id", "SYNTHETIC_TRANSCRIPT_COOKIE", controller.signal);
  await candidatesStarted;
  controller.abort(new DOMException("synthetic route cancellation", "AbortError"));
  const response = await responsePromise;

  expect(startedSignals).toHaveLength(4);
  expect(startedSignals.every((signal) => signal.aborted)).toBe(true);
  expect(settledSignals).toHaveLength(startedSignals.length);
  expect(response.status).toBe(500);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

it("stops an aborted bulk request before any later item starts", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  transcriptSpy.mockImplementation((stdId, signal) => {
    calls.push(stdId);
    markStarted();
    return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  });
  const secondId = String(Number(SYNTHETIC_INTERNAL_ID) + 1);
  const session = { ...vnuSession(), vnu: { ...vnuSession().vnu!, value: "SYNTHETIC_TRANSCRIPT_COOKIE" } };
  const responsePromise = bulkRawRequest(JSON.stringify({ mode: "stdid-to-code", targets: [SYNTHETIC_INTERNAL_ID, secondId], allowCrossLookup: true }), session, controller.signal);
  await started;
  controller.abort(new DOMException("synthetic bulk cancellation", "AbortError"));
  const response = await responsePromise;

  expect(calls).toEqual([SYNTHETIC_INTERNAL_ID]);
  expect(response.status).toBe(500);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

it("propagates a fatal concurrent candidate, aborts sibling fetches, and keeps the route error no-store", async () => {
  setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CODE_LOOKUP_CONCURRENCY: "4" });
  const fatal = new HyeboardError("VNU_RATE_LIMITED", "synthetic", 429);
  let candidateCalls = 0;
  let siblingAborts = 0;
  let releaseFatal!: () => void;
  const siblingsStarted = new Promise<void>((resolve) => { releaseFatal = resolve; });
  transcriptSpy.mockImplementation(async (_stdId, signal) => {
    if (transcriptSpy.mock.calls.length === 1) return `<table><tr><td>Mã số: ${String(Number(SYNTHETIC_STUDENT_CODE) - 1)}</td></tr></table>`;
    candidateCalls += 1;
    if (candidateCalls === 1) {
      await siblingsStarted;
      throw fatal;
    }
    if (candidateCalls === 4) releaseFatal();
    return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => {
      siblingAborts += 1;
      reject(signal!.reason);
    }, { once: true }));
  });

  const response = await authorizedRequest(`stdCode=${SYNTHETIC_STUDENT_CODE}&allowCrossLookup=true`, "student-id");
  expect(candidateCalls).toBe(4);
  expect(siblingAborts).toBe(3);
  expect(response.status).toBe(429);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_RATE_LIMITED" } });
});
```

Update existing expectations:

```ts
expect(probeBudget.amounts).toEqual([66]); // two bulk code targets, 33 each
expect(probeBudget.amounts).toEqual([5]);  // five direct targets, unchanged
expect(probeBudget.amounts).toEqual([1]);  // one direct transcript target, unchanged
```

Keep existing session-HMAC isolation, malformed/self/not-found item ordering, raw-HTML exclusion, notice exclusion, and no-store tests.

- [ ] **Step 2: Run focused Worker tests and verify RED**

Run:

```bash
pnpm --filter @hyeboard/worker exec vitest run src/app.test.ts -t "request-log|reserves|reservation|ordinary bulk|sequential|cross-transcript|abortable Request|cancelled|fatal concurrent"
```

Expected: FAIL because single routes still consume per probe, code reservations are 22, request cancellation is not passed/settled across every route shape, and bulk catches systemic failures as item errors.

- [ ] **Step 3: Replace allowance and failure-classification helpers**

In `apps/worker/src/app.ts`, delete `consumeVnuOracleProbe`. Keep `reserveVnuOracleProbes` as the only Durable Object boundary used by cross-lookup routes. Replace bulk-only allowance code with:

```ts
export function requestLogPath(requestUrl: string): string {
  return new URL(requestUrl).pathname;
}

type VnuProbeAllowance = { consume(): void };

function createVnuProbeAllowance(units: number): VnuProbeAllowance {
  let remaining = units;
  return {
    consume() {
      if (remaining <= 0) throw new Error("Reserved VNU probe allowance exhausted");
      remaining -= 1;
    },
  };
}

function vnuBulkReservationUnits(body: VnuBulkLookupBody): number {
  const unitsPerTarget = body.mode === "code-to-stdid" ? VNU_STUDENT_ID_RESOLVER_MAX_PROBES : 1;
  return body.targets.length * unitsPerTarget;
}

function isVnuBulkItemError(error: unknown): error is HyeboardError {
  return error instanceof HyeboardError && [
    "VNU_CROSS_LOOKUP_NOT_FOUND",
    "VNU_CROSS_LOOKUP_NOT_CONVERGED",
  ].includes(error.code);
}
```

Migrate every resolver call first: pass route/query target as a string without numeric coercion and pass `concurrency: effectiveVnuRuntimeConfig.codeLookupConcurrency` explicitly. This includes student-code-to-ID, code-target transcript, and bulk code-to-ID calls. After all calls use that final shape, atomically narrow resolver options and remove legacy far support in the same Task 6 commit:

```ts
export type VnuStudentIdResolverOptions = {
  ownStdId: number;
  ownCode: number;
  targetCode: string;
  concurrency: number;
  fetchStudentCode: (stdId: number, signal: AbortSignal) => Promise<string | undefined>;
  signal?: AbortSignal;
  platformConcurrencyLimit?: number;
};
```

Delete Task 5's `String(options.targetCode)` compatibility normalization and `options.concurrency ?? 1`; destructure now-exact `targetCode` and `concurrency` directly. Remove `farWalkEnabled: vnuFarWalkEnabled()` from all resolver calls, then delete `vnuFarWalkEnabled`, `isVnuFarWalkEnabled`, `RuntimeConfig.VNU_FAR_WALK_ENABLED`, their imports/tests, and Task 5's ignored property. Task 4 already removed all external wiring. Route migration plus API narrowing/removal is one atomic, typechecked Task 6 change; do not commit an intermediate mismatch.

Delete Task 5's `"temporarily accepts a numeric target..."` resolver test in this same change; it documents only the previous commit's bridge and must not weaken or fail compilation against the final type. Keep all local-window, exact-string, configured-concurrency, ordering, and cancellation tests. Add `apps/worker/src/vnu-student-id-resolver.test.ts` to Task 6 staging.

Import `requestLogPath` in `app.test.ts`. In `onRequest`, replace `url: request.url` with `url: requestLogPath(request.url)`. This prevents GET target identifiers and opt-in query values from entering debug logs; bulk bodies were already never logged.

Invalid and self targets remain pre-fetch item errors. Authentication/session, 429, upstream 5xx, transport, explicit cancellation, allowance defects, and unknown failures are never converted to item errors.

- [ ] **Step 4: Integrate the two single resolver routes**

For both student GET handlers, change each existing handler signature from `async ({ headers, query, set })` to `async ({ headers, query, set, request })`. After all validation, own-identity parsing, and self-target rejection, use these complete request blocks.

Student ID to code:

```ts
await reserveVnuOracleProbes(session, 1);
const client = new DaotaoClient(session);
const html = await client.getTranscriptByStdIdHtml(query.stdId, request.signal);
const { studentCode, studentName, className } = parseTranscriptHeader(html);
if (!studentCode) throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_FOUND", "The portal did not return a student for that identifier.", 404);
return ok({ studentCode, studentName, className });
```

Student code to ID:

```ts
await reserveVnuOracleProbes(session, VNU_STUDENT_ID_RESOLVER_MAX_PROBES);
const allowance = createVnuProbeAllowance(VNU_STUDENT_ID_RESOLVER_MAX_PROBES);
const client = new DaotaoClient(session);
return ok(await resolveVnuStudentId({
  ownStdId: ownIdentity.ownStdId,
  ownCode: ownIdentity.ownCode,
  targetCode: query.stdCode,
  concurrency: effectiveVnuRuntimeConfig.codeLookupConcurrency,
  signal: request.signal,
  fetchStudentCode: async (stdId, signal) => {
    allowance.consume();
    return parseTranscriptHeader(await client.getTranscriptByStdIdHtml(String(stdId), signal)).studentCode;
  },
}));
```

No per-candidate Durable Object call remains.

- [ ] **Step 5: Integrate direct and code transcript reservations**

For the transcript GET handler, change the existing handler signature from `async ({ headers, query, set })` to `async ({ headers, query, set, request })`. After transcript route validation and self-target checks:

```ts
const reservedUnits = query.stdCode ? VNU_STUDENT_ID_RESOLVER_MAX_PROBES + 1 : 1;
await reserveVnuOracleProbes(session, reservedUnits);
const allowance = createVnuProbeAllowance(reservedUnits);
const client = new DaotaoClient(session);
let targetStdId = query.stdId;
if (query.stdCode) {
  const resolvedTarget = await resolveVnuStudentId({
    ownStdId: ownIdentity.ownStdId,
    ownCode: ownIdentity.ownCode,
    targetCode: query.stdCode,
    concurrency: effectiveVnuRuntimeConfig.codeLookupConcurrency,
    signal: request.signal,
    fetchStudentCode: async (stdId, signal) => {
      allowance.consume();
      return parseTranscriptHeader(await client.getTranscriptByStdIdHtml(String(stdId), signal)).studentCode;
    },
  });
  targetStdId = resolvedTarget.stdId;
}
allowance.consume();
const transcript = parseVnuCrossLookupTranscript(await client.getTranscriptByStdIdHtml(targetStdId!, request.signal));
if (!transcript.header.studentCode) throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_FOUND", "The portal did not return a student for that identifier.", 404);
return ok(transcript);
```

The separate final transcript fetch always happens for code mode, even when the winning probe already parsed identity.

- [ ] **Step 6: Integrate bulk allowances while keeping items sequential**

Use `createVnuProbeAllowance(reservedUnits)`. At each loop start, preserve the existing `waitBetweenBulkItems`, then stop on caller cancellation:

```ts
if (request.signal.aborted) throw request.signal.reason ?? new DOMException("Bulk lookup cancelled.", "AbortError");
```

Pass `request.signal` to direct Brc1 calls. Replace the code resolver call with:

```ts
const resolution = await resolveVnuStudentId({
  ownStdId: ownIdentity.ownStdId,
  ownCode: ownIdentity.ownCode!,
  targetCode: target,
  concurrency: effectiveVnuRuntimeConfig.codeLookupConcurrency,
  signal: request.signal,
  fetchStudentCode: async (stdId, signal) => {
    allowance.consume();
    return parseTranscriptHeader(await client.getTranscriptByStdIdHtml(String(stdId), signal)).studentCode;
  },
});
```

Replace the catch body:

```ts
} catch (error) {
  if (!isVnuBulkItemError(error)) throw error;
  items.push({ target, status: "error", errorCode: error.code });
}
```

The outer `for` remains sequential. Candidate requests overlap only inside one resolver invocation. A systemic failure rejects the current chunk; previously completed browser chunks remain client state and become a partial export in Task 8.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @hyeboard/worker exec vitest run src/vnu-student-id-resolver.test.ts src/app.test.ts -t "resolveVnuStudentId|request-log|reserves|reservation|ordinary bulk|sequential|cross-transcript|abortable Request|cancelled|fatal concurrent"
pnpm --filter @hyeboard/worker typecheck
```

Expected: resolver/route tests PASS and worker typecheck exits 0. Every cross-lookup success and error response retains `Cache-Control: no-store` through the existing `onRequest` hook.

Worker typecheck is Task 6's commit gate: it proves every route supplies a string target and explicit configured concurrency after temporary Task 5 API removal. Together with Task 5 Step 5's Worker typecheck, both commits compile independently while final resolver contract remains strict.

- [ ] **Step 8: Commit route and budget integration**

```bash
git add apps/worker/src/app.ts apps/worker/src/app.test.ts apps/worker/src/vnu-student-id-resolver.ts apps/worker/src/vnu-student-id-resolver.test.ts
git commit -m "feat(worker): reserve bounded VNU lookup probes"
```

---

### Task 7: Add Lookup Single-Result Exports and Derived Transcript Metrics

**Files:**
- Modify: `apps/web/src/lib/cross-transcript-view.ts:13-66`
- Modify: `apps/web/src/lib/cross-transcript-view.test.ts:46-76`
- Modify: `apps/web/src/pages/lookup.tsx:1-595`
- Modify: `apps/web/src/lib/i18n.tsx:215-310,683-778`
- Modify: `apps/web/tests/smoke.spec.ts:12-30,342-402`

- [ ] **Step 1: Write failing derived-transcript unit tests**

Update imports in `apps/web/src/lib/cross-transcript-view.test.ts` and add:

```ts
import { calculateTermAcademicSummaries, newestAcademicTermsFirst } from "./term-academic-summary";

it("carries one shared derived summary object while keeping reported totals separate", () => {
  const derivedTerms = newestAcademicTermsFirst(calculateTermAcademicSummaries(
    transcript.terms.flatMap((term) => term.rows.map((row) => ({
      termKey: term.maHK,
      credits: row.credits,
      point4: row.grade4,
      course: row,
    }))),
    "vnu",
  ));
  const success = deriveCrossTranscriptView({
    input: deriveCrossTranscriptInput("stdId", "1001", profile),
    submitted: true,
    isLoading: false,
    hasError: false,
    transcript: { ...transcript, totals: { gpa4: 3.2 } },
    derivedTerms,
  });
  expect(success).toMatchObject({ kind: "success", derivedTerms: [{ estimateKind: "derived" }] });
  expect(success.kind === "success" ? success.transcript.totals.gpa4 : undefined).toBe(3.2);
  expect(success.kind === "success" ? success.derivedTerms[0]?.termGpa4 : undefined).not.toBe(success.kind === "success" ? success.transcript.totals.gpa4 : undefined);
});
```

Pass `derivedTerms: []` from the existing `view` helper so all union calls stay typed.

- [ ] **Step 2: Add failing mocked Lookup export coverage**

Extend `openMockedLookup` in `apps/web/tests/smoke.spec.ts` so the mocked university metadata includes a positive limit:

```ts
const SYNTHETIC_STUDENT_CODE = "99000001";
const SYNTHETIC_INTERNAL_ID = "99000000001";

mock.limits = { crossLookup: { bulkMaxTargets: 50 } };
```

Place both constants once at test-file scope, beside existing fixture constants, and reuse them in Tasks 7–9.

Add these routes before `loginDemo(page)`:

```ts
await page.route("**/api/vnu/raw/exams?*", async (route) => {
  const html = `<table><tr>
    <td><input name="hidCrdID" value="000001">1</td>
    <td>251-INT1001 01</td><td>Reliable Systems</td><td>27/07/2026</td>
    <td>1(08:00)</td><td>Written</td><td>R101</td><td>12</td>
  </tr></table>`;
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { html } }) });
});
await page.route("**/api/vnu/cross-lookup/student-code?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { studentCode: SYNTHETIC_STUDENT_CODE, studentName: "Synthetic Student", className: "QH-SYNTHETIC" } }) }));
await page.route("**/api/vnu/cross-lookup/student-id?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { stdId: SYNTHETIC_INTERNAL_ID, stdCode: SYNTHETIC_STUDENT_CODE, probes: 2 } }) }));
await page.route("**/api/vnu/cross-lookup/transcript?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
  header: { studentCode: SYNTHETIC_STUDENT_CODE, studentName: "Synthetic Student", className: "QH-SYNTHETIC" },
  totals: { totalCredits: 6, accumulatedCredits: 3, gpa4: 3.2 },
  terms: [{ maHK: "251", rows: [
    { courseCode: "INT1001", courseName: "Reliable Systems", credits: 3, grade10: 8, letterGrade: "B+", grade4: 3.5 },
    { courseCode: "INT1002", courseName: "Pending Systems", credits: 3 },
  ] }],
} }) }));
```

Because the payload type in the helper currently declares only `capabilities`, widen it to include `limits?: { crossLookup?: { bulkMaxTargets: number } }`.

Add this download helper:

```ts
async function expectJsonExport(section: import("@playwright/test").Locator, page: import("@playwright/test").Page, surface: string) {
  const downloadPromise = page.waitForEvent("download");
  await section.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  const model = JSON.parse(await downloadText(await downloadPromise)) as { surface: string };
  expect(model.surface).toBe(surface);
}
```

Add the test:

```ts
test("lookup successful single results and transcript export without refetching", async ({ page }) => {
  let transcriptRequests = 0;
  page.on("request", (request) => { if (request.url().includes("/api/vnu/cross-lookup/transcript")) transcriptRequests += 1; });
  await openMockedLookup(page);
  await expect(page.getByTestId("lookup-results").getByRole("button", { name: "Export" })).toHaveCount(0);
  await expect(page.getByTestId("cross-student-code").getByRole("button", { name: "Export" })).toHaveCount(0);

  await page.getByLabel("Term").first().click();
  await page.getByRole("option").first().click();
  await page.getByLabel("Course code").fill("INT1001");
  await expectJsonExport(page.getByTestId("lookup-results"), page, "class-forward");

  await page.getByRole("button", { name: "Class ID to course" }).click();
  await page.getByLabel("Term").click();
  await page.getByRole("option").first().click();
  await page.getByLabel("Internal class ID").fill("000001");
  await expectJsonExport(page.getByTestId("reverse-class-lookup"), page, "class-reverse");

  const codeSection = page.getByTestId("cross-student-code");
  await codeSection.getByLabel("Target internal student ID").fill(SYNTHETIC_INTERNAL_ID);
  await codeSection.getByRole("button", { name: "Look up" }).click();
  await expect(codeSection.getByText(SYNTHETIC_STUDENT_CODE)).toBeVisible();
  await expectJsonExport(codeSection, page, "student-id-to-code");
  await codeSection.getByLabel("Target internal student ID").fill(String(Number(SYNTHETIC_INTERNAL_ID) + 1));
  await expect(codeSection.getByRole("button", { name: "Export" })).toHaveCount(0);

  await page.getByRole("button", { name: "Code → ID" }).click();
  const idSection = page.getByTestId("cross-student-id");
  await idSection.getByLabel("Target student code").fill(SYNTHETIC_STUDENT_CODE);
  await idSection.getByRole("button", { name: "Look up" }).click();
  await expect(idSection.getByText(SYNTHETIC_INTERNAL_ID)).toBeVisible();
  await expectJsonExport(idSection, page, "student-code-to-id");
  await idSection.getByLabel("Target student code").fill(String(Number(SYNTHETIC_STUDENT_CODE) + 1));
  await expect(idSection.getByRole("button", { name: "Export" })).toHaveCount(0);

  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  const transcriptSection = page.getByTestId("cross-transcript");
  await transcriptSection.getByLabel("Target internal student ID").fill(SYNTHETIC_INTERNAL_ID);
  await transcriptSection.getByRole("button", { name: "View transcript" }).click();
  await expect(transcriptSection.getByText("Portal cumulative GPA")).toBeVisible();
  await expect(transcriptSection.getByTestId("academic-term-header")).toContainText("Derived");
  await expect(transcriptSection.getByTestId("academic-term-header")).toContainText("3 / 6 listed");
  expect(transcriptRequests).toBe(1);
  await expectJsonExport(transcriptSection, page, "cross-transcript");
  expect(transcriptRequests).toBe(1);
  await transcriptSection.getByLabel("Target internal student ID").fill(String(Number(SYNTHETIC_INTERNAL_ID) + 1));
  await expect(transcriptSection.getByRole("button", { name: "Export" })).toHaveCount(0);
});

test("lookup single-result errors never expose stale export actions", async ({ page }) => {
  await openMockedLookup(page);
  await page.route("**/api/vnu/cross-lookup/student-code?*", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_CROSS_LOOKUP_NOT_FOUND", message: "synthetic" } }) }));
  const section = page.getByTestId("cross-student-code");
  await section.getByLabel("Target internal student ID").fill("123457");
  await section.getByRole("button", { name: "Look up" }).click();
  await expect(section.getByText("The portal did not render a student code")).toBeVisible();
  await expect(section.getByRole("button", { name: "Export" })).toHaveCount(0);
});
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/cross-transcript-view.test.ts
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts -g "lookup (successful single results|single-result errors)" --workers=1
```

Expected: FAIL. Unit assertions cannot find `derivedTerms`; Playwright cannot find export controls or derived transcript metrics.

- [ ] **Step 4: Carry shared transcript summaries through the view model**

In `apps/web/src/lib/cross-transcript-view.ts`, import `VnuTranscriptRow` and `AcademicTermSummary`, then change success and options types:

```ts
export type CrossTranscriptView =
  | { kind: "prompt" | "ready" | "invalid" | "selfTarget" | "loading" | "notFound" | "noRows" }
  | { kind: "error"; errorKind: CrossTranscriptErrorKind }
  | { kind: "success"; transcript: VnuCrossTranscript; rowCount: number; derivedTerms: AcademicTermSummary<VnuTranscriptRow>[] };

export function deriveCrossTranscriptView(options: {
  input: CrossTranscriptInputState;
  submitted: boolean;
  isLoading: boolean;
  errorCode?: string;
  hasError: boolean;
  transcript?: VnuCrossTranscript;
  derivedTerms: AcademicTermSummary<VnuTranscriptRow>[];
}): CrossTranscriptView {
  const { input, submitted, isLoading, errorCode, hasError, transcript, derivedTerms } = options;
  if (!input.input) return { kind: "prompt" };
  if (!input.isValid) return { kind: "invalid" };
  if (input.isSelfTarget) return { kind: "selfTarget" };
  if (!submitted) return { kind: "ready" };
  if (isLoading) return { kind: "loading" };
  if (hasError) {
    const errorKind = mapCrossTranscriptError(errorCode);
    return errorKind === "notFound" ? { kind: "notFound" } : { kind: "error", errorKind };
  }
  if (!transcript?.header.studentCode) return { kind: "notFound" };
  const rowCount = transcript.terms.reduce((count, term) => count + term.rows.length, 0);
  if (rowCount === 0) return { kind: "noRows" };
  return { kind: "success", transcript, rowCount, derivedTerms };
}
```

- [ ] **Step 5: Add exact class and resolver export models**

In `apps/web/src/pages/lookup.tsx`, import `ExportMenu`, all export builders/types, and the academic calculator. Extend `ClassResultRow` and `ReverseClassResultRow` with `exportModel: ExportDocument`; render `<ExportMenu model={exportModel} />` beside the ID badge.

Build the forward model in the `filteredRows.map` call:

```ts
const exportModel = createClassLookupExport({
  surface: "class-forward",
  universityId: state.universityId,
  query: { mode: "course-and-class", value: [termOrdinal, courseCode.trim(), classNo.trim()].filter(Boolean).join(" | ") },
  result: { classCode: row.courseCode, classNumber: row.classNo, classId: row.classId, courseName: row.courseName },
});
```

Build the reverse model from `termOrdinal`, `trimmedClassId`, and each matched row with `surface: "class-reverse"`, `query.mode: "class-id"`, and `query.value: `${termOrdinal} | ${trimmedClassId}``.

In `CrossStudentCodeSection`, create a model only from the submitted successful pair:

```ts
const exportModel = submitted && result?.studentCode ? createResolverLookupExport({
  surface: "student-id-to-code",
  universityId: state.universityId,
  query: { mode: "stdId", value: submitted.stdId },
  identity: { studentCode: result.studentCode, studentName: result.studentName, managingClass: result.className },
}) : undefined;
```

Render the badge and menu in one wrapping action group. In `CrossStudentIdSection`:

```ts
const exportModel = submitted && result ? createResolverLookupExport({
  surface: "student-code-to-id",
  universityId: state.universityId,
  query: { mode: "stdCode", value: submitted.stdCode },
  resolver: { resolvedStudentCode: result.stdCode, resolvedInternalStudentId: result.stdId, probes: result.probes },
}) : undefined;
```

Existing input handlers already set `submitted` to null, so stale exports disappear on query changes. TanStack keys include university and `sessionNonce`, so account/session changes clear result data before a replacement request resolves.

- [ ] **Step 6: Calculate one transcript summary object for UI and export**

Add these helpers in `lookup.tsx`:

```ts
function CompactAcademicMetric({ label, value }: { label: string; value: string }) {
  return <span className="whitespace-nowrap text-sm"><span className="text-muted-foreground">{label}</span> <strong className="font-semibold tabular-nums">{value}</strong></span>;
}

function transcriptAcademicTerms(transcript: VnuCrossTranscript | undefined) {
  if (!transcript) return [];
  return newestAcademicTermsFirst(calculateTermAcademicSummaries(
    transcript.terms.flatMap((term) => term.rows.map((row) => ({ termKey: term.maHK, credits: row.credits, point4: row.grade4, course: row }))),
    "vnu",
  ));
}

function transcriptExportTerm(summary: AcademicTermSummary<VnuTranscriptRow>, termLabel: string): ExportDerivedTerm {
  return {
    termCode: summary.termKey,
    termLabel,
    estimateKind: summary.estimateKind,
    listedCredits: summary.listedCredits,
    includedCredits: summary.includedCredits,
    termGpa4: summary.termGpa4,
    derivedCpa4: summary.cpa4,
    courses: summary.courses.map((row) => ({ courseCode: row.courseCode, courseName: row.courseName, credits: row.credits, point10: row.grade10, letter: row.letterGrade, point4: row.grade4 })),
  };
}
```

Update the top imports to include `useMemo`, `VnuTranscriptRow`, `VnuCrossTranscript`, `AcademicTermSummary`, and every export type referenced by these helpers. Keep this metric helper page-local; the Grades page has its own page-local copy, so neither page imports the other.

In `CrossTranscriptSection`:

```tsx
const derivedTerms = useMemo(() => transcriptAcademicTerms(transcriptQuery.data), [transcriptQuery.data]);
```

Pass `derivedTerms` to `deriveCrossTranscriptView`. When the view is successful, derive export terms from that same `transcriptView.derivedTerms` array and create:

```ts
const exportModel = transcriptView.kind === "success" && submitted ? createTranscriptExport({
  universityId: state.universityId,
  query: submitted.mode === "stdId" ? { mode: "stdId", value: submitted.stdId } : { mode: "stdCode", value: submitted.stdCode },
  identity: {
    studentCode: transcriptView.transcript.header.studentCode,
    studentName: transcriptView.transcript.header.studentName,
    managingClass: transcriptView.transcript.header.className,
  },
  reported: {
    cumulativeGpa4: transcriptView.transcript.totals.gpa4,
    totalCredits: transcriptView.transcript.totals.totalCredits,
    accumulatedCredits: transcriptView.transcript.totals.accumulatedCredits,
  },
  derivedTerms: transcriptView.derivedTerms.map((summary) => transcriptExportTerm(summary, formatTermLabel(summary.termKey, "vnu", t.terms))),
}) : undefined;
```

Align `ExportMenu` with the transcript section title. Change the reported summary label from `crossTranscriptGpa4` to `crossTranscriptReportedGpa4`. Replace `CrossTranscriptTerm` props with `{ summary: AcademicTermSummary<VnuTranscriptRow> }`, find no raw term summary elsewhere, and render the same Option A metric block used by Grades:

```tsx
<header data-testid="academic-term-header" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-3">
  <h3 id={`cross-transcript-term-${summary.termKey}`} className="break-words text-sm font-semibold">{formatTermLabel(summary.termKey, "vnu", t.terms)}</h3>
  <Badge data-tone="neutral" title={t.grades.derivedDetail}>{t.grades.derived}</Badge>
  <CompactAcademicMetric label={t.grades.termGpa} value={summary.termGpa4?.toFixed(2) ?? "-"} />
  <CompactAcademicMetric label={t.grades.cpa} value={summary.cpa4?.toFixed(2) ?? "-"} />
  <CompactAcademicMetric label={t.grades.includedCredits} value={t.grades.creditRatio(summary.includedCredits, summary.listedCredits)} />
</header>
```

Keep the existing table inside `max-h-[32rem] overflow-auto` and render `summary.courses`. Do not put an export control on individual cross-transcript terms; the approved surface is the single transcript, and its action belongs beside the section title.

- [ ] **Step 7: Add reported-label translations**

Replace the English and Vietnamese transcript GPA keys:

```ts
crossTranscriptReportedGpa4: "Portal cumulative GPA (4.0)",
```

```ts
crossTranscriptReportedGpa4: "GPA tích lũy từ cổng trường (hệ 4)",
```

All export machine keys, record types, and API error codes remain untranslated.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/term-academic-summary.test.ts src/lib/cross-transcript-view.test.ts src/lib/data-export.test.ts
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts -g "lookup (groups|successful single results|single-result errors)" --workers=1
```

Expected: unit tests PASS; class forward/reverse, both student directions, and single transcript JSON export PASS with no transcript refetch.

- [ ] **Step 9: Commit Lookup single-result integration**

```bash
git add apps/web/src/lib/cross-transcript-view.ts apps/web/src/lib/cross-transcript-view.test.ts apps/web/src/pages/lookup.tsx apps/web/src/lib/i18n.tsx apps/web/tests/smoke.spec.ts
git commit -m "feat(web): export VNU lookup results and transcripts"
```

---

### Task 8: Enforce the Published Bulk Maximum and Export Complete or Partial Runs

**Files:**
- Modify: `apps/web/src/lib/bulk-lookup.ts:3-96`
- Modify: `apps/web/src/lib/bulk-lookup.test.ts:5-133`
- Modify: `apps/web/src/pages/lookup.tsx:597-768`
- Modify: `apps/web/src/lib/i18n.tsx:311-338,779-806`
- Modify: `apps/web/tests/smoke.spec.ts:12-30,342-402`

- [ ] **Step 1: Write failing configured-limit unit tests**

Replace hardcoded-limit tests in `apps/web/src/lib/bulk-lookup.test.ts` and update all `parseBulkTargets` calls to pass a limit:

```ts
it("trims and deduplicates before enforcing the configured whole-run maximum", () => {
  expect(parseBulkTargets(" 12\n34\n12\n\n 34 \n56", 3)).toEqual({ targets: ["12", "34", "56"] });
  expect(parseBulkTargets("12\n34\n56", 2)).toEqual({ targets: ["12", "34", "56"], error: "tooMany" });
});

it.each([0, undefined])("disables bulk input when metadata maximum is %s", (maximum) => {
  expect(parseBulkTargets("1001", maximum)).toEqual({ targets: ["1001"], error: "disabled" });
});

it("has no product ceiling below Number.MAX_SAFE_INTEGER", () => {
  const input = Array.from({ length: 51 }, (_, index) => String(index + 1)).join("\n");
  expect(parseBulkTargets(input, Number.MAX_SAFE_INTEGER)).toEqual({ targets: Array.from({ length: 51 }, (_, index) => String(index + 1)) });
});

it("retains unchanged three/five request chunks regardless of whole-run maximum", () => {
  const targets = ["1", "2", "3", "4", "5", "6", "7"];
  expect(chunkBulkTargets("code-to-stdid", targets)).toEqual([["1", "2", "3"], ["4", "5", "6"], ["7"]]);
  expect(chunkBulkTargets("stdid-to-code", targets)).toEqual([["1", "2", "3", "4", "5"], ["6", "7"]]);
  expect(chunkBulkTargets("stdid-to-transcript", targets)).toEqual([["1", "2", "3", "4", "5"], ["6", "7"]]);
});
```

Keep sequential execution, cancellation, mixed item, later-429/503, and retry tests. Pass a positive maximum to their input parsing.

- [ ] **Step 2: Add failing complete/partial bulk Playwright tests**

Change the helper signature:

```ts
async function openMockedLookup(page: import("@playwright/test").Page, bulkMaximum: number | null = 50) {
```

Inside the university route, use:

```ts
if (bulkMaximum === null) delete mock.limits;
else mock.limits = { crossLookup: { bulkMaxTargets: bulkMaximum } };
```

Add:

```ts
const syntheticStudentCodes = (count: number) => Array.from({ length: count }, (_, index) => String(Number(SYNTHETIC_STUDENT_CODE) + index));
const syntheticInternalIds = (count: number) => Array.from({ length: count }, (_, index) => String(Number(SYNTHETIC_INTERNAL_ID) + index));
const studentCodeForInternalId = (internalId: string) => String(Number(SYNTHETIC_STUDENT_CODE) + Number(internalId) - Number(SYNTHETIC_INTERNAL_ID));
const internalIdForStudentCode = (studentCode: string) => String(Number(SYNTHETIC_INTERNAL_ID) + Number(studentCode) - Number(SYNTHETIC_STUDENT_CODE));

for (const [label, bulkMaximum] of [["zero", 0], ["missing", null]] as const) {
  test(`bulk hides when the published limit is ${label}`, async ({ page }) => {
    await openMockedLookup(page, bulkMaximum);
    await expect(page.getByTestId("bulk-lookup")).toHaveCount(0);
    await expect(page.getByTestId("cross-student-code")).toBeVisible();
  });
}

test("bulk enforces configured deduplicated count", async ({ page }) => {
  await openMockedLookup(page, 2);
  const bulk = page.getByTestId("bulk-lookup");
  await bulk.getByLabel("Targets, one per line").fill("1001\n1002\n1001\n1003");
  await expect(bulk.getByText("Use no more than 2 unique identifiers at once.")).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Run bulk lookup" })).toBeDisabled();
});

test("bulk keeps 3/5 chunks and exports every completed mode", async ({ page }) => {
  const chunks: Array<{ mode: string; targets: string[] }> = [];
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    const body = route.request().postDataJSON() as { mode: string; targets: string[] };
    chunks.push({ mode: body.mode, targets: body.targets });
    const items = body.targets.map((target) => body.mode === "code-to-stdid"
      ? { target, status: "ok", result: { stdId: internalIdForStudentCode(target), stdCode: target, probes: 2 } }
      : body.mode === "stdid-to-transcript"
        ? { target, status: "ok", result: { header: { studentCode: studentCodeForInternalId(target) }, totals: { gpa4: 3.2 }, terms: [{ maHK: "251", rows: [{ courseCode: "INT1001", courseName: "Reliable Systems", credits: 3, grade4: 3.5 }] }] } }
        : { target, status: "ok", result: { studentCode: studentCodeForInternalId(target) } });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { items } }) });
  });
  await openMockedLookup(page, 7);
  const bulk = page.getByTestId("bulk-lookup");

  const cases = [
    { option: "Internal IDs to student codes", targets: syntheticInternalIds(6), surface: "bulk-id-to-code", sizes: [5, 1] },
    { option: "Student codes to internal IDs", targets: syntheticStudentCodes(4), surface: "bulk-code-to-id", sizes: [3, 1] },
    { option: "Internal IDs to transcripts", targets: syntheticInternalIds(6), surface: "bulk-id-to-transcript", sizes: [5, 1] },
  ] as const;

  for (const item of cases) {
    await bulk.getByRole("combobox", { name: "Lookup mode" }).click();
    await page.getByRole("option", { name: item.option }).click();
    await bulk.getByLabel("Targets, one per line").fill(item.targets.join("\n"));
    await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
    await expect(bulk.getByText(`${item.targets.length} completed`)).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await bulk.getByRole("button", { name: "Export" }).click();
    await page.getByRole("menuitem", { name: "Download JSON" }).click();
    const model = JSON.parse(await downloadText(await downloadPromise)) as { surface: string; run: { status: string; processedCount: number; totalCount: number }; results: unknown[] };
    expect(model).toMatchObject({ surface: item.surface, run: { status: "complete", processedCount: item.targets.length, totalCount: item.targets.length } });
    expect(model.results).toHaveLength(item.targets.length);
    const modeChunks = chunks.filter((chunk) => chunk.mode === (item.option === "Student codes to internal IDs" ? "code-to-stdid" : item.option === "Internal IDs to transcripts" ? "stdid-to-transcript" : "stdid-to-code"));
    expect(modeChunks.map((chunk) => chunk.targets.length)).toEqual(item.sizes);
    await bulk.getByRole("button", { name: "Reset" }).click();
  }
});

test("bulk exports prior chunks as partial after a later reservation rejection", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    calls += 1;
    const body = route.request().postDataJSON() as { targets: string[] };
    if (calls === 2) {
      await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_RATE_LIMITED", message: "synthetic" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { items: body.targets.map((target) => ({ target, status: "ok", result: { studentCode: studentCodeForInternalId(target) } })) } }) });
  });
  await openMockedLookup(page, 6);
  const bulk = page.getByTestId("bulk-lookup");
  await bulk.getByLabel("Targets, one per line").fill(syntheticInternalIds(6).join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await expect(bulk.getByText("This chunk could not reserve enough probe units.")).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await bulk.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  const model = JSON.parse(await downloadText(await downloadPromise)) as { run: { status: string; processedCount: number; totalCount: number }; results: unknown[] };
  expect(model.run).toEqual({ status: "partial", mode: "stdid-to-code", processedCount: 5, totalCount: 6 });
  expect(model.results).toHaveLength(5);
  await expect(bulk.getByRole("button", { name: "Retry remaining" })).toBeVisible();
});

test("bulk keeps prior chunks exportable during and after cancellation", async ({ page }) => {
  let calls = 0;
  let markSecondStarted!: () => void;
  let releaseSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    calls += 1;
    const body = route.request().postDataJSON() as { targets: string[] };
    if (calls === 2) {
      markSecondStarted();
      await secondGate;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { items: body.targets.map((target) => ({ target, status: "ok", result: { studentCode: studentCodeForInternalId(target) } })) } }) }).catch(() => undefined);
  });
  await openMockedLookup(page, 6);
  const bulk = page.getByTestId("bulk-lookup");
  await bulk.getByLabel("Targets, one per line").fill(syntheticInternalIds(6).join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await secondStarted;
  await expect(bulk.getByText("5 of 6 processed")).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  await bulk.getByRole("button", { name: "Cancel" }).click();
  releaseSecond();
  await expect(bulk.getByRole("button", { name: "Retry remaining" })).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await bulk.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  const model = JSON.parse(await downloadText(await downloadPromise)) as { run: { status: string; processedCount: number; totalCount: number } };
  expect(model.run).toEqual({ status: "partial", mode: "stdid-to-code", processedCount: 5, totalCount: 6 });
});
```

The unit and Playwright cancellation tests together prove canceled work remains retryable and prior completed items remain downloadable.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/bulk-lookup.test.ts
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts -g "bulk (hides|enforces|keeps|exports prior)" --workers=1
```

Expected: FAIL. Unit assertions reject hardcoded 50; Playwright shows ignored limits and missing bulk exports.

- [ ] **Step 4: Parameterize whole-run validation without changing chunks**

In `apps/web/src/lib/bulk-lookup.ts`:

```ts
export type BulkTargetError = "empty" | "tooMany" | "disabled";

export function parseBulkTargets(raw: string, bulkMaxTargets: number | undefined): ParsedBulkTargets {
  const targets = [...new Set(raw.split(/\r?\n/).map((target) => target.trim()).filter(Boolean))];
  if (!Number.isSafeInteger(bulkMaxTargets) || bulkMaxTargets === undefined || bulkMaxTargets <= 0) return { targets, error: "disabled" };
  if (targets.length === 0) return { targets, error: "empty" };
  if (targets.length > bulkMaxTargets) return { targets, error: "tooMany" };
  return { targets };
}
```

Leave `chunkBulkTargets` exactly at three for `code-to-stdid` and five for both direct modes. `executeBulkLookup` remains sequential and preserves `initialProgress`, completed items, and `remainingTargets`.

- [ ] **Step 5: Build allowlisted bulk export items from completed browser state**

Add `createBulkExport` and `type ExportBulkItem` to the `@/lib/data-export` import in `lookup.tsx`, then add:

```ts
function bulkSurface(mode: VnuBulkLookupMode): "bulk-id-to-code" | "bulk-code-to-id" | "bulk-id-to-transcript" {
  if (mode === "code-to-stdid") return "bulk-code-to-id";
  if (mode === "stdid-to-transcript") return "bulk-id-to-transcript";
  return "bulk-id-to-code";
}

function bulkExportItem(item: VnuBulkLookupItem, mode: VnuBulkLookupMode, termLabel: (termCode: string) => string): ExportBulkItem {
  if (item.status === "error") return { target: item.target, status: "error", errorCode: item.errorCode };
  const value = item.result;
  if (mode === "stdid-to-code" && "studentCode" in value) {
    return { target: item.target, status: "ok", result: { identity: { studentCode: value.studentCode, studentName: value.studentName, managingClass: value.className } } };
  }
  if (mode === "code-to-stdid" && "stdId" in value) {
    return { target: item.target, status: "ok", result: { resolver: { resolvedStudentCode: value.stdCode, resolvedInternalStudentId: value.stdId, probes: value.probes } } };
  }
  if ("header" in value) {
    const summaries = transcriptAcademicTerms(value);
    return {
      target: item.target,
      status: "ok",
      result: {
        identity: { studentCode: value.header.studentCode, studentName: value.header.studentName, managingClass: value.header.className },
        reported: { cumulativeGpa4: value.totals.gpa4, totalCredits: value.totals.totalCredits, accumulatedCredits: value.totals.accumulatedCredits },
        derivedTerms: summaries.map((summary) => transcriptExportTerm(summary, termLabel(summary.termKey))),
      },
    };
  }
  throw new Error(`Unexpected successful bulk result for mode ${mode}`);
}
```

This throws only for an impossible client/type mismatch; it never spreads API results.

- [ ] **Step 6: Consume metadata and preserve one partial model across later work**

Change `BulkLookupSection` props to `{ bulkMaxTargets: number }`, then:

```tsx
const parsed = parseBulkTargets(rawTargets, bulkMaxTargets);
const exportModel = progress.items.length > 0 ? createBulkExport({
  surface: bulkSurface(mode),
  universityId: state.universityId,
  mode,
  total: progress.total,
  items: progress.items.map((item) => bulkExportItem(item, mode, (termCode) => formatTermLabel(termCode, "vnu", t.terms))),
}) : undefined;
```

Put `ExportMenu` in a wrapping `CardHeader` title row whenever `exportModel` exists. Keep it rendered during `active`, after cancellation, and after `requestError`. Do not clear `progress` when retrying. Existing mode and textarea change handlers must keep clearing progress, remaining targets, and errors.

In `LookupPage`:

```tsx
const activeUniversity = state.universities.data?.find((university) => university.id === state.universityId);
const crossLookupEnabled = activeUniversity?.capabilities.crossLookup === true;
const bulkMaxTargets = crossLookupEnabled ? activeUniversity?.limits?.crossLookup?.bulkMaxTargets : undefined;
```

Render `<BulkLookupSection bulkMaxTargets={bulkMaxTargets} />` only when `bulkMaxTargets` is a positive safe integer. Missing and zero limits hide bulk while leaving single cross lookup available.

- [ ] **Step 7: Make bulk copy depend on the configured maximum**

English:

```ts
bulkDescription: (maximum: number) => `Process up to ${maximum} identifiers in sequential batches. Each target reports its own result.`,
bulkTooMany: (maximum: number) => `Use no more than ${maximum} unique identifiers at once.`,
```

Vietnamese:

```ts
bulkDescription: (maximum: number) => `Xử lý tối đa ${maximum} mã theo từng nhóm tuần tự. Mỗi mã có kết quả riêng.`,
bulkTooMany: (maximum: number) => `Mỗi lần chỉ dùng tối đa ${maximum} mã duy nhất.`,
```

Call both functions with `bulkMaxTargets`. Keep mode labels and stable error codes unchanged.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/bulk-lookup.test.ts src/lib/data-export.test.ts src/lib/term-academic-summary.test.ts
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts -g "bulk (hides|enforces|keeps|exports prior)" --workers=1
pnpm --filter @hyeboard/web typecheck
```

Expected: configured-limit and partial-state tests PASS; all three modes export; request sizes remain 3/5; web typecheck exits 0.

- [ ] **Step 9: Commit bulk metadata and exports**

```bash
git add apps/web/src/lib/bulk-lookup.ts apps/web/src/lib/bulk-lookup.test.ts apps/web/src/pages/lookup.tsx apps/web/src/lib/i18n.tsx apps/web/tests/smoke.spec.ts
git commit -m "feat(web): export configured VNU bulk results"
```

---

### Task 9: Complete Documentation, End-to-End Matrix, Privacy Review, and Release Gates

**Files:**
- Modify: `apps/web/src/components/export-menu.tsx`
- Modify: `apps/web/tests/smoke.spec.ts`
- Modify: `README.md:20-27,43-64`
- Modify: `docs/architecture.md:1-29`
- Modify: `packages/university-adapters/src/vnu/har-notes.md:126-201`
- Include: `docs/superpowers/plans/2026-07-27-vnu-gpa-export-resolver.md`

- [ ] **Step 1: Add failing deterministic export-menu and all-format assertions**

Replace `expectJsonExport` in `apps/web/tests/smoke.spec.ts` with:

```ts
function trackApiRequestCounts(page: import("@playwright/test").Page) {
  const counts = new Map<string, number>();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) counts.set(path, (counts.get(path) ?? 0) + 1);
  });
  return (path: string) => counts.get(path) ?? 0;
}

function parseDownloadedRfc4180Csv(input: string): string[][] {
  expect(input.charCodeAt(0)).toBe(0xfeff);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 1;
  while (index < input.length) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') { field += '"'; index += 2; continue; }
      if (character === '"') { quoted = false; index += 1; continue; }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"') { expect(field).toBe(""); quoted = true; index += 1; continue; }
    if (character === ",") { row.push(field); field = ""; index += 1; continue; }
    if (character === "\r") {
      expect(input[index + 1]).toBe("\n");
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 2;
      continue;
    }
    expect(character).not.toBe("\n");
    field += character;
    index += 1;
  }
  expect(quoted).toBe(false);
  expect(row).toEqual([]);
  expect(field).toBe("");
  return rows;
}

async function expectExportFormats(
  page: import("@playwright/test").Page,
  surface: string,
  relevantRequestCount: () => number,
) {
  const exportRoot = page.locator(`[data-export-surface="${surface}"]`).first();
  const trigger = exportRoot.getByRole("button", { name: "Export" });
  const requestsBeforeExport = relevantRequestCount();
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Download JSON" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  const jsonPromise = page.waitForEvent("download");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  const jsonModel = JSON.parse(await downloadText(await jsonPromise)) as { surface: string; reported?: { cumulativeGpa4?: number }; derivedTerms?: unknown[]; run?: { status: string; processedCount: number; totalCount: number }; results?: unknown[] };
  expect(jsonModel.surface).toBe(surface);
  expect(relevantRequestCount()).toBe(requestsBeforeExport);
  await expect(trigger).toBeFocused();

  const csvPromise = page.waitForEvent("download");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Download CSV" }).click();
  const csv = await downloadText(await csvPromise);
  const csvRows = parseDownloadedRfc4180Csv(csv);
  const csvHeader = csvRows[0]!;
  expect(csvHeader.slice(0, 3)).toEqual(["record_type", "surface", "run_status"]);
  const surfaceColumn = csvHeader.indexOf("surface");
  expect(surfaceColumn).toBeGreaterThanOrEqual(0);
  const csvRecords = csvRows.slice(1);
  expect(csvRecords.length).toBeGreaterThan(0);
  expect(csvRecords.every((row) => row[surfaceColumn] === surface)).toBe(true);
  expect(relevantRequestCount()).toBe(requestsBeforeExport);
  await expect(trigger).toBeFocused();
  return jsonModel;
}
```

Update the focused tests from Tasks 3, 7, and 8 to call `expectExportFormats` for every surface:

```ts
// In the Grades test, after the newest term header is visible:
const gradesPageModel = await expectExportFormats(page, "grades-page", () => apiRequestCount("/api/grades"));
expect(gradesPageModel.reported?.cumulativeGpa4).toBe(3.48);
expect(gradesPageModel.derivedTerms).toHaveLength(1);
await expectExportFormats(page, "grades-term", () => apiRequestCount("/api/grades"));

// In the Lookup single-result test, immediately after each result assertion:
await expectExportFormats(page, "class-forward", () => apiRequestCount("/api/vnu/raw/exams"));
await expectExportFormats(page, "class-reverse", () => apiRequestCount("/api/vnu/raw/exams"));
await expectExportFormats(page, "student-id-to-code", () => apiRequestCount("/api/vnu/cross-lookup/student-code"));
await expectExportFormats(page, "student-code-to-id", () => apiRequestCount("/api/vnu/cross-lookup/student-id"));
await expectExportFormats(page, "cross-transcript", () => apiRequestCount("/api/vnu/cross-lookup/transcript"));

// In the completed-bulk cases loop, after completion is visible:
const bulkModel = await expectExportFormats(page, item.surface, () => apiRequestCount("/api/vnu/cross-lookup/bulk"));
expect(bulkModel.run).toMatchObject({ status: "complete", processedCount: item.targets.length, totalCount: item.targets.length });
expect(bulkModel.results).toHaveLength(item.targets.length);

// In both partial-bulk tests, after the retained Export trigger is visible:
const partialModel = await expectExportFormats(page, "bulk-id-to-code", () => apiRequestCount("/api/vnu/cross-lookup/bulk"));
expect(partialModel.run).toMatchObject({ status: "partial", processedCount: 5, totalCount: 6 });
```

At the start of each Grades, single-Lookup, and bulk test, before navigation or `openMockedLookup`, declare `const apiRequestCount = trackApiRequestCounts(page);`. Delete superseded one-format blocks and the transcript-only counter from Task 7. Retain the Grades all-terms display-order assertion and partial-run count/order assertions. The callback snapshot is checked after JSON and again after CSV, proving unchanged relevant API request counts for Grades, class forward/reverse, both student directions, transcript, every complete bulk mode, and both partial bulk states without hidden fixture-only models.

Add interaction coverage:

```ts
test("export menu reports local failures, remains responsive, and localizes without losing results", async ({ page }) => {
  await loginDemo(page);
  await page.goto("/grades");
  const resultText = page.getByText("Web Application Development");
  await expect(resultText).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("button", { name: "Toggle light and dark mode" }).click();
  await page.goto("/grades");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  const themedTrigger = page.locator('[data-export-surface="grades-page"]').getByRole("button", { name: "Export" });
  await themedTrigger.click();
  await expect(page.getByRole("menuitem", { name: "Download JSON" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => { document.documentElement.dataset.theme = "uet"; });
  await themedTrigger.click();
  const uetMenuBackground = await page.getByRole("menu").evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(uetMenuBackground).not.toBe("rgba(0, 0, 0, 0)");
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => { throw new Error("synthetic download failure"); },
    });
  });
  const exportRoot = page.locator('[data-export-surface="grades-page"]');
  await exportRoot.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  await expect(exportRoot.getByRole("status")).toContainText("The export could not be downloaded");
  await expect(resultText).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("combobox", { name: "Language" }).click();
  await page.getByRole("option", { name: "Tiếng Việt" }).click();
  await page.goto("/grades");
  await expect(page.getByRole("button", { name: "Xuất dữ liệu" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Xuất dữ liệu" }).first().click();
  await expect(page.getByRole("menuitem", { name: "Tải JSON" })).toBeVisible();
  for (const menuItem of [page.getByRole("menuitem", { name: "Tải JSON" }), page.getByRole("menuitem", { name: "Tải CSV" })]) {
    const menuItemBox = await menuItem.boundingBox();
    expect(menuItemBox).not.toBeNull();
    expect(menuItemBox!.height).toBeGreaterThanOrEqual(43.9);
  }
  await page.keyboard.press("Escape");

  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expectNoPageOverflow(page);
    const box = await page.getByRole("button", { name: "Xuất dữ liệu" }).first().boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(43.9);
  }
});
```

Run the new tests plus an operational-document assertion:

```bash
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts -g "export menu reports|lookup successful|grades render|bulk keeps" --workers=1
git grep -n "VNU_FAR_WALK_ENABLED" -- README.md apps packages scripts
```

Expected: FAIL. Playwright cannot find `data-export-surface`; the grep command also finds obsolete runtime documentation/source until all prior removal edits and this documentation task are complete.

- [ ] **Step 2: Add the deterministic export root and preserve accessible behavior**

Change the root element in `ExportMenu`:

```tsx
<div className={cn("min-w-0", className)} data-export-surface={model.surface}>
```

Do not put `aria-hidden` on this root. Keep the visible localized trigger label, Radix menu roles, 44px targets, polite status, error retry, and focus return.

- [ ] **Step 3: Update operational documentation**

Replace README local-development VNU config with:

```txt
HYEB_SESSION_SECRET=replace-with-at-least-32-random-bytes
HYEB_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
VNU_CODE_LOOKUP_CONCURRENCY=16
VNU_CROSS_LOOKUP_BULK_MAX_TARGETS=50
```

Replace the deployment configuration paragraph with concise, current behavior:

```md
Non-secret runtime configuration lives in `dist/config.json`; environment variables override matching file values. VNU resolver settings use `vnu.code_lookup_concurrency` and `vnu.cross_lookup_bulk_max_targets` in JSON, or `VNU_CODE_LOOKUP_CONCURRENCY` and `VNU_CROSS_LOOKUP_BULK_MAX_TARGETS` in the environment. Canonical non-negative base-10 safe integers are accepted; concurrency must be positive. Missing values default to 16 and 50. Malformed concurrency falls back to 1, while malformed bulk configuration disables bulk with 0. There is no product ceiling below JavaScript's safe-integer bound.

VNU cross lookup requires the Cloudflare `VNU_PROBE_BUDGET` Durable Object. Self-hosted Node/Bun deployments fail cross lookup closed and omit its runtime limit metadata. The browser hides bulk when metadata is missing or zero, enforces the published whole-run maximum, and still sends sequential chunks of three code targets or five direct-ID/transcript targets. The Worker atomically reserves 1 unit for direct lookups, 33 for code-to-ID, and 34 for code-to-transcript before Brc1 work. Reservations are per session, authoritative, and non-refundable.

Exports are explicit browser-only JSON or CSV downloads built from sanitized result models. They do not refetch, persist, or send result content to the server. Derived term GPA/CPA values exclude missing grades and remain labeled separately from portal-reported cumulative values.
```

Update `docs/architecture.md` to describe this flow:

```md
## Academic Summaries and Exports

`apps/web/src/lib/term-academic-summary.ts` is the single pure definition of listed credits, included credits, derived term GPA, and running CPA. Grades and cross-transcript views normalize their rows into it. Portal-reported cumulative values stay separate; derived values never claim university authority.

`apps/web/src/lib/data-export.ts` builds versioned allowlisted documents from already-sanitized browser state. JSON preserves structure and calculator precision. CSV uses fixed machine columns, UTF-8 BOM, CRLF, deterministic order, formula defense, and text-safe identifiers. Downloads use temporary object URLs and always revoke them. No export path contacts an API or writes browser/server persistence.

## VNU Cross-Lookup Boundary

The code-to-ID resolver probes only the arithmetic projection and its closed ±16 neighborhood. It verifies exact eight-digit header equality, uses bounded projection-local concurrency, and cancels siblings after a deterministic winner or fatal failure. It never performs a far/cohort search or returns an approximation.

Every route or accepted bulk chunk reserves its conservative Brc1 allowance once through the per-session Durable Object before upstream work. Candidate probes consume only that local allowance. Direct routes reserve 1 unit, code-to-ID reserves 33, and code-to-transcript reserves 34. Browser bulk runs use optional `/api/universities` limit metadata, but fixed Worker chunk validation and Durable Object enforcement remain the security boundary.
```

Replace the obsolete `Anchor/drift model (StdID <-> student code)` and `Wide-span probe evidence (qualitative)` operational text in `packages/university-adapters/src/vnu/har-notes.md` with:

```md
### Projection/local-window model (StdID <-> student code)

- Live evidence shows that student codes and internal IDs can remain near-parallel only inside a short cohort-local neighborhood. The Worker therefore projects from the authenticated caller's own pair, probes the projection, then probes only the closed projection ±16 window. Success requires exact equality with the requested eight-digit code; headerless, malformed, and nonmatching responses are misses.
- The complete candidate set contains at most 33 IDs. Projection-local probes use bounded deterministic concurrency, stop after the earliest-priority exact winner, and abort started siblings after a winner, caller cancellation, or fatal upstream failure. No wide-span monotonicity, cohort slope, approximation, or nearest-result assumption remains.
- Wide-span qualitative probes disproved the former assumptions: cohort boundaries introduce large prefix jumps, and even within a cohort the local slope changes sign outside the immediate neighborhood. Bisection and long linear correction therefore cannot converge reliably. This evidence supports deleting wide/far operation rather than retaining a deployment gate.
- Every route or bulk chunk reserves its conservative allowance atomically through the per-session Durable Object before Brc1 work. Direct ID-to-code and ID-to-transcript operations reserve 1 unit per target, code-to-ID reserves 33, and code-to-transcript reserves 34. Candidate requests spend only the local reservation; reservations are non-refundable.
- `GET /api/vnu/cross-lookup/transcript` accepts exactly one target plus explicit opt-in. Code mode resolves inside the bounded local window, then performs one separate final transcript fetch. Wire responses contain parsed identity, term rows, and totals only; raw HTML and portal notice prose never leave the Worker.
- `POST /api/vnu/cross-lookup/bulk` preserves ordered sequential items and fixed request limits of three code targets or five direct-ID/transcript targets. Ordinary not-found/not-converged outcomes remain item errors. Authentication, session, rate-limit, upstream, transport, cancellation, allowance, and unknown failures stop the chunk.

### Wide-span probe evidence (qualitative)

No identifiers, codes, or per-pair deltas are recorded here; only response-shape conclusions remain:

- Internal-ID space crosses intake cohorts with discontinuous student-code prefixes, so no global code-to-ID slope exists.
- Within a cohort, observed drift can change direction outside the immediate projection neighborhood.
- Consequence: wide bisection and long linear correction assumptions are disproven. Only exact bounded local verification is supported.
- Reverse directions from a known internal ID remain one-fetch operations and do not depend on monotonicity.
```

Remove old probe counts, delay values, release-gate instructions, and all operational flag-name references from this adapter note. The approved design spec and this implementation plan remain historical records; README, architecture, adapter notes, source comments, examples, and runtime configuration must not present the retired flag as operable.

Do not add sample names, live identifiers, raw HTML, headers, cookies, tokens, captures, or downloaded payloads to documentation.

- [ ] **Step 4: Run the focused final feature matrix**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/term-academic-summary.test.ts src/lib/data-export.test.ts src/lib/bulk-lookup.test.ts src/lib/cross-transcript-view.test.ts src/components/export-menu.test.tsx
pnpm --filter @hyeboard/university-adapters exec vitest run src/vnu/daotao-client.test.ts
pnpm --filter @hyeboard/worker exec vitest run src/vnu-runtime-config.test.ts src/vnu-student-id-resolver.test.ts src/university-capabilities.test.ts src/app.test.ts
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts -g "export|grades|lookup|bulk" --workers=1
```

Expected: all focused suites PASS. JSON and CSV are exercised for every listed successful surface; prompt/loading/single-error states have no export; partial bulk retains export.

- [ ] **Step 5: Verify generated bindings and standalone package synchronization**

Run:

```bash
pnpm --filter @hyeboard/worker exec wrangler types
git diff --exit-code -- apps/worker/worker-configuration.d.ts
pnpm package
pnpm --filter @hyeboard/worker check:node-package
```

Expected: regenerated Worker types produce no diff; standalone package builds with synchronized `vnu` config; Node package checks pass. `dist/` remains ignored and must not be staged.

- [ ] **Step 6: Run complete automated gates**

Run from the worktree root, serially:

```bash
pnpm build
pnpm test
pnpm --filter @hyeboard/web exec playwright test --workers=1
pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run
git diff --check
```

Expected: every command exits 0. Playwright starts Worker and Vite itself. If ports 5173/8787 contain stale processes, stop only those worktree dev processes, then rerun serially.

- [ ] **Step 7: Scan far-mode removal, privacy, and security boundaries**

Run:

```bash
BASE_SHA=4b4553a9248a7e18db1710b41dec5244b23af973
test "$(git rev-parse "$BASE_SHA")" = "$BASE_SHA"
if git grep -n -E "VNU_FAR_WALK_ENABLED|FAR_LINEAR|BISECTION_PROBE|farWalkEnabled" -- ':!docs/superpowers/specs/2026-07-27-vnu-gpa-export-resolver-design.md' ':!docs/superpowers/plans/2026-07-27-vnu-gpa-export-resolver.md'; then exit 1; fi
if git diff --no-ext-diff "$BASE_SHA" -- . ':!docs/superpowers/specs/*' ':!docs/superpowers/plans/*' | rg -n "(?i)(authorization:[[:space:]]*bearer[[:space:]]+[A-Za-z0-9._-]{16,}|set-cookie:|saml(response|assertion)|BEGIN (RSA|EC|OPENSSH) PRIVATE KEY)" | rg -vi "synthetic|do_not_export|fake|example"; then exit 1; fi
if git diff -U0 "$BASE_SHA" -- apps/worker/src/app.ts | rg -n "^\+.*(url:[[:space:]]*request\.url|getLogger\(\).*(stdCode|stdId|targets))"; then exit 1; fi
if rg -n "\b([T]BD|[T]ODO)\b|[i]mplement later|[f]ill in details|[a]dd appropriate error handling|[w]rite tests for the above|[s]imilar to Task" docs/superpowers/plans/2026-07-27-vnu-gpa-export-resolver.md; then exit 1; fi
```

Expected: base resolves exactly; all guarded scans print no matches and exit 0. Never replace `BASE_SHA` with a branch name, merge base, or mutable ref. Never weaken a scan to hide a real secret, target-log, PII, retired operational flag, or placeholder finding.

Print the raw identity-literal diff report:

```bash
BASE_SHA=4b4553a9248a7e18db1710b41dec5244b23af973
git diff -U0 "$BASE_SHA" -- . ':!docs/superpowers/specs/*' ':!docs/superpowers/plans/*' | rg -n -P '^\+.*(?<![0-9_])(?:(?:[0-9]_?){10}[0-9]|(?:[0-9]_?){7}[0-9])(?![0-9_])' || true
```

Expected: output is reviewed line by line, not required to be empty. In implementation review notes, report each match as exactly one of: reserved-range `SYNTHETIC_STUDENT_CODE`/`SYNTHETIC_INTERNAL_ID`; a value derived from those constants; a non-identity date/arithmetic/parser boundary; or a defect removed before staging. Any unexplained identity-shaped literal, any fixture outside the documented reserved ranges, or any real-looking name/HTML/download payload blocks completion.

Then inspect boundaries:

```bash
BASE_SHA=4b4553a9248a7e18db1710b41dec5244b23af973
git diff --stat "$BASE_SHA"
git diff --name-only "$BASE_SHA"
git diff "$BASE_SHA" -- apps/worker/src/app.ts apps/worker/src/vnu-student-id-resolver.ts apps/web/src/lib/data-export.ts apps/web/src/lib/term-academic-summary.ts packages/schemas/src/index.ts
```

Confirm: fixed ±16/33 search; exact string equality; effective pool bounded by candidate/platform limits; 1/33/34 reservations; no per-probe Durable Object call; no refund; systemic chunk stop; no-store on every cross route; optional metadata; no export refetch/persistence/logging; CSV formula defense; object URL cleanup.

- [ ] **Step 8: Perform manual responsive export review**

Run the worktree dev servers with `pnpm dev`, then inspect synthetic/demo data only at 390x844, 768x1024, and 1440x900:

1. Grades newest term, all terms, and single-term filter: compact Option A headers wrap; one Derived marker; Term GPA, CPA, and included/listed credits remain readable; page and term exports match visible order.
2. Class forward/reverse and both student resolver directions: Export stays inline with the resolved value; changing input removes stale actions.
3. Single transcript: portal cumulative GPA remains separate; each term shows derived metrics; table scroll stays inside its container; one section export downloads both formats.
4. All bulk modes: complete run, cancellation after a completed chunk, later rejected chunk, and retry; partial export remains available and contains only completed ordered items.
5. Keyboard only: Tab to trigger, Enter/Space open, arrows move, Escape closes, selection returns focus, visible focus ring remains.
6. English and Vietnamese; light and dark modes; neutral Demo and UET themes. No page-level horizontal overflow, nested cards, gradients, glow, hover shadow, or side stripe.
7. Every trigger and menu item measures at least 44px high. Long identifiers and labels wrap; filenames contain no person name or identifier.

Stop dev servers after review. Do not retain downloaded files, screenshots, traces, reports, or logs containing result data inside the repository.

- [ ] **Step 9: Commit docs, complete E2E coverage, and this plan**

Before staging:

```bash
git status --short
```

Expected: only Task 9 paths plus this plan are modified/untracked; build, package, Playwright, Wrangler, and download artifacts are ignored.

```bash
git add apps/web/src/components/export-menu.tsx apps/web/tests/smoke.spec.ts README.md docs/architecture.md packages/university-adapters/src/vnu/har-notes.md docs/superpowers/plans/2026-07-27-vnu-gpa-export-resolver.md
git commit -m "test: verify VNU GPA exports and resolver"
git diff --check
git status --short
```

Expected final status: empty. Review `git log --oneline -9` and confirm nine sequential commits match Tasks 1–9. No push or deployment belongs to implementation. Any release action requires a separate explicit user confirmation.

## Plan Self-Review

- **Spec coverage:** Tasks 1–3 cover one derived weighted GPA/running CPA path, missing-grade exclusion, listed/included credits, stable chronology, summer grouping, reported separation, Option A Grades layout, and Grades exports. Tasks 2, 7, and 8 cover every export surface, partial state, allowlisting, deterministic JSON/CSV, formula defense, filename safety, object URL cleanup, keyboard/focus/error behavior, and no-refetch state invalidation. Tasks 4–6 cover parser defaults/fallbacks, safe-integer range without a product ceiling, optional metadata, Cloudflare/self-host/package synchronization, fixed ±16/33 exact search, bounded concurrency, direct/resolver/bulk request cancellation, fatal sibling settlement, 1/33/34 atomic reservations, no refund, no-store, and sequential bulk items. Task 9 covers README, architecture, adapter evidence notes, generated types, smoke mocking, complete automated/manual/privacy gates, and no automatic release.
- **Placeholder scan:** No incomplete instruction markers or deferred implementation language remains. Every source-changing step contains complete types, function bodies, replacement blocks, or exact call-site construction.
- **Type consistency:** `AcademicTermSummary` fields stay `termGpa4`, `cpa4`, `listedCredits`, `includedCredits`, and `estimateKind`; export conversion consistently maps `cpa4` to `derivedCpa4`. `usesUetTermRules` remains while `isSummerGrade` depends on it. Runtime config fields stay `VNU_CODE_LOOKUP_CONCURRENCY` and `VNU_CROSS_LOOKUP_BULK_MAX_TARGETS`; metadata stays `limits.crossLookup.bulkMaxTargets`. Task 5 temporarily normalizes numeric route targets to exact strings and defaults omitted concurrency to `1`; Task 6 restores required string targets and required configured numeric concurrency for every route. `AbortSignal` remains threaded throughout.
- **Task dependencies:** Each task consumes only APIs committed by earlier tasks. Task 4 retains only the internal far field/helper while removing external wiring and typechecks. Task 5 uses explicit temporary target-type, concurrency-default, and ignored-far compatibility bridges and typechecks independently. Task 6 migrates every route, removes all bridges plus their temporary test, helper, field, and legacy tests atomically, then typechecks independently. Daotao cancellation lands before route signal threading; metadata lands before browser bulk enforcement; export primitives and calculator land before page integration.
- **CSV review:** Unit and Playwright helpers parse quoted records instead of splitting lines/commas. Formula cases assert exact apostrophe-prefixed fields after leading whitespace/control characters and an unchanged parsed numeric field. Download tests resolve the parsed `surface` header and require every emitted record row to carry the exact surface. Tests also distinguish CRLF record separators from embedded LF, CR, and CRLF and cover comma, doubled quote, and empty fields exactly.
- **Privacy:** New identity fixtures use the documented reserved ranges through `SYNTHETIC_STUDENT_CODE` and `SYNTHETIC_INTERNAL_ID`. The immutable-base raw-diff report classifies every added eight-/eleven-digit literal. Plan contains no real PII, credentials, session material, raw capture values, or HAR-derived content.
