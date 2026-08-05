# Reusable GradeTable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a canonical shared `GradeTable` component from `apps/web/src/pages/grades.tsx` so both the personal Grades page and the Cross Transcript lookup table render identically — same header order (Course / Letter / Credits / Point 10 / Point 4), sortable columns, chevron row-click multi-open expansion, lazy detail mounting, and responsive Point 4 hiding.

**Architecture:** Define canonical `GradeTableRow` + `GradeTableDetail` types in `grade-view-model.ts`. Generalize `sortGrades` to operate on the new row type. Extract `AcademicTermSection` (term header + metrics) and `GradeTable` (table body + chevron expansion + detail panels) into shared components under `apps/web/src/components/grades/`. Rewire `GradesPage` and `CrossTranscriptSection` to map their respective data sources into canonical rows and pass them to the shared components. Remove `CrossTranscriptTerm`'s inline table. Update Playwright and unit tests to assert shared behavior across both surfaces.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, TanStack Query, Vitest, Playwright, `@hyeboard/schemas`, `@hyeboard/university-adapters`

---

### Task 1: Define canonical row types and generalize sortGrades

**Files:**
- Modify: `apps/web/src/lib/grade-view-model.ts`
- Test: `apps/web/src/lib/grade-view-model.test.ts`

- [ ] **Step 1.1: Add `GradeTableRow` and `GradeTableDetail` types**

Open `apps/web/src/lib/grade-view-model.ts`. Add after existing imports, before `sortGrades`:

```ts
export type GradeTableDetail =
  | { kind: "available"; render: () => React.ReactNode }
  | { kind: "unavailable"; render: () => React.ReactNode };

export type GradeTableRow = {
  id: string;
  courseName: string;
  credits?: number | null;
  point10?: number | null;
  letter?: string;
  point4?: number | null;
  isSummer?: boolean;
  detail: GradeTableDetail;
};
```

The `render` functions return React elements — they are closures capturing row-specific data, constructed by the consumer before passing rows to `GradeTable`.

- [ ] **Step 1.2: Generalize `sortGrades` to accept `readonly GradeTableRow[]`**

Current `sortGrades` (line 39) operates on `(grades: Grade[], ...)`. Add an overload or generic form. The simplest approach: create a new pure function that sorts `GradeTableRow[]` by the same keys. The existing `sortGrades` for `Grade[]` stays for `GradeSortState` type compatibility.

Add after the types (around line 45):

```ts
export type CanonicalSortKey = "courseName" | "credits" | "point10" | "point4";

export function sortGradeTableRows(rows: readonly GradeTableRow[], sort: GradeSortState): GradeTableRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    let comparison = 0;
    if (sort.key === "credits") comparison = (a.credits ?? -1) - (b.credits ?? -1);
    else if (sort.key === "point10") comparison = (a.point10 ?? -1) - (b.point10 ?? -1);
    else if (sort.key === "point4") comparison = (a.point4 ?? -1) - (b.point4 ?? -1);
    else comparison = a.courseName.localeCompare(b.courseName, "vi");
    if (comparison === 0) comparison = a.courseName.localeCompare(b.courseName, "vi");
    return sort.direction === "desc" ? -comparison : comparison;
  });
  return sorted;
}
```

Wait — `GradeSortState` uses `key: GradeSortKey` where `GradeSortKey = "name" | "credits" | "point10" | "point4"`. The existing key is `"name"`, not `"courseName"`. Keep using the existing `GradeSortKey` with `"name"` → map to `courseName` in the sorter:

```ts
export function sortGradeTableRows(rows: readonly GradeTableRow[], sort: GradeSortState): GradeTableRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    let comparison = 0;
    if (sort.key === "credits") comparison = (a.credits ?? -1) - (b.credits ?? -1);
    else if (sort.key === "point10") comparison = (a.point10 ?? -1) - (b.point10 ?? -1);
    else if (sort.key === "point4") comparison = (a.point4 ?? -1) - (b.point4 ?? -1);
    else comparison = a.courseName.localeCompare(b.courseName, "vi");
    if (comparison === 0) comparison = a.courseName.localeCompare(b.courseName, "vi");
    return sort.direction === "desc" ? -comparison : comparison;
  });
  return sorted;
}
```

- [ ] **Step 1.3: Add unit tests for sortGradeTableRows**

In `apps/web/src/lib/grade-view-model.test.ts`, add:

```ts
import { sortGradeTableRows, type GradeTableRow } from "./grade-view-model";

describe("sortGradeTableRows", () => {
  const rows: readonly GradeTableRow[] = [
    { id: "1", courseName: "Toán", credits: 3, point10: 8, letter: "B", detail: { kind: "unavailable", render: () => null } },
    { id: "2", courseName: "Anh văn", credits: 2, point10: 9, letter: "A", detail: { kind: "unavailable", render: () => null } },
    { id: "3", courseName: "Toán", credits: 4, point10: null, letter: "-", detail: { kind: "unavailable", render: () => null } },
  ];

  it("sorts by name ascending", () => {
    const result = sortGradeTableRows(rows, { key: "name", direction: "asc" });
    expect(result.map(r => r.courseName)).toEqual(["Anh văn", "Toán", "Toán"]);
  });

  it("sorts by name descending", () => {
    const result = sortGradeTableRows(rows, { key: "name", direction: "desc" });
    expect(result.map(r => r.courseName)).toEqual(["Toán", "Toán", "Anh văn"]);
  });

  it("sorts by credits ascending", () => {
    const result = sortGradeTableRows(rows, { key: "credits", direction: "asc" });
    expect(result.map(r => r.credits)).toEqual([2, 3, 4]);
  });

  it("sorts by point10 with null as -1", () => {
    const result = sortGradeTableRows(rows, { key: "point10", direction: "desc" });
    expect(result.map(r => r.point10)).toEqual([9, 8, null]);
  });

  it("does not mutate source", () => {
    const copy = [...rows];
    sortGradeTableRows(rows, { key: "name", direction: "asc" });
    expect(rows).toEqual(copy);
  });
});
```

- [ ] **Step 1.4: Run tests and commit (orchestrator handles git)**

Run: `pnpm --filter @hyeboard/web exec vitest run src/lib/grade-view-model.test.ts`
Expected: all tests pass.

---

### Task 2: Extract AcademicTermSection

**Files:**
- Create: `apps/web/src/components/grades/academic-term-section.tsx`
- Modify: `apps/web/src/pages/grades.tsx`

- [ ] **Step 2.1: Create `AcademicTermSection` component**

Create `apps/web/src/components/grades/academic-term-section.tsx`:

```tsx
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { CompactAcademicMetric } from "@/pages/grades"; // Re-export or inline — see Step 2.2

export type AcademicTermSectionProps = {
  id: string;
  label: string;
  headingLevel: "h2" | "h3" | "h4";
  termGpa?: string;
  cpa?: string;
  includedCredits?: string;
  creditRatio?: string;
  derivedLabel: string;
  hasSummer?: boolean;
  includesSummer?: boolean;
  includesSummerLabel?: string;
  action?: ReactNode;
  children: ReactNode;
};

export function AcademicTermSection({
  id, label, headingLevel: Tag, termGpa, cpa, includedCredits, creditRatio,
  derivedLabel, hasSummer, includesSummer, includesSummerLabel, action, children,
}: AcademicTermSectionProps) {
  return (
    <section aria-labelledby={id} data-testid="term-summary" className="space-y-2">
      <header data-testid="academic-term-header" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Tag id={id} className="text-base font-semibold">{label}</Tag>
          {includesSummer && includesSummerLabel ? <Badge className="border border-border bg-background text-foreground">{includesSummerLabel}</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Badge className="border border-border bg-muted text-foreground" title={derivedLabel}>{derivedLabel}</Badge>
          {termGpa != null ? <CompactAcademicMetric label={termGpaLabel} value={termGpa} /> : null}
          {cpa != null ? <CompactAcademicMetric label={cpaLabel} value={cpa} /> : null}
          {includedCredits != null ? <CompactAcademicMetric label={includedCreditsLabel} value={includedCredits} /> : null}
          {creditRatio != null ? <CompactAcademicMetric label={creditRatioLabel} value={creditRatio} /> : null}
        </div>
        {action ? <div className="ml-auto">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}
```

Wait — `CompactAcademicMetric` is currently defined in `grades.tsx` (line 19). It needs to be either:
1. Extracted to a shared location, or
2. The `AcademicTermSection` takes pre-rendered metric nodes as children.

Let me redesign `AcademicTermSection` to take the metrics as a flex row of pre-rendered ReactNodes, keeping it simpler and avoiding needing to extract `CompactAcademicMetric`:

```tsx
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

export type AcademicTermSectionProps = {
  id: string;
  label: ReactNode;
  headingLevel?: "h2" | "h3" | "h4";
  metrics?: ReactNode;
  derivedLabel: string;
  includesSummerLabel?: string;
  includesSummer?: boolean;
  action?: ReactNode;
  children: ReactNode;
};

export function AcademicTermSection({
  id, label, headingLevel: Tag = "h2", metrics, derivedLabel,
  includesSummerLabel, includesSummer, action, children,
}: AcademicTermSectionProps) {
  return (
    <section aria-labelledby={id} data-testid="term-summary" className="space-y-2">
      <header data-testid="academic-term-header" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Tag id={id} className="text-base font-semibold">{label}</Tag>
          {includesSummer && includesSummerLabel ? <Badge className="border border-border bg-background text-foreground">{includesSummerLabel}</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Badge className="border border-border bg-muted text-foreground" title={derivedLabel}>{derivedLabel}</Badge>
          {metrics}
        </div>
        {action ? <div className="ml-auto">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}
```

This is simpler — consumers pass in their own metrics row. `CompactAcademicMetric` stays in `grades.tsx` (where it currently is). Lookup reuses it by importing.

- [ ] **Step 2.2: Rewire `GradesPage` term sections**

In `grades.tsx`, in the `GradesPage` function (around line 288-304), replace the inline term header markup with `AcademicTermSection`:

Import at top:
```ts
import { AcademicTermSection } from "@/components/grades/academic-term-section";
```

Replace the section block (lines 288-304):
```tsx
// OLD:
<section key={summary.termKey} aria-labelledby={headingId} data-testid="term-summary" className="space-y-2">
  <header data-testid="academic-term-header" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-3">
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <h2 id={headingId} className="text-base font-semibold">{label}</h2>
      {summary.includesSummer ? <Badge className="border border-border bg-background text-foreground">{t.grades.includesSummer}</Badge> : null}
    </div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Badge className="border border-border bg-muted text-foreground" title={t.grades.derivedDetail}>{t.grades.derived}</Badge>
      <CompactAcademicMetric label={t.grades.termGpa} value={summary.termGpa4?.toFixed(2) ?? "-"} />
      <CompactAcademicMetric label={t.grades.cpa} value={summary.cpa4?.toFixed(2) ?? "-"} />
      <CompactAcademicMetric label={t.grades.includedCredits} value={t.grades.creditRatio(summary.includedCredits, summary.listedCredits)} />
    </div>
    {termExportModel ? <ExportMenu model={termExportModel} className="ml-auto" /> : null}
  </header>
  <GradeTable grades={sortedCourses} sort={sort} onSortChange={setSort} universityId={state.universityId} />
</section>

// NEW:
<AcademicTermSection
  key={summary.termKey}
  id={headingId}
  label={label}
  headingLevel="h2"
  includesSummer={summary.includesSummer}
  includesSummerLabel={t.grades.includesSummer}
  derivedLabel={t.grades.derived}
  metrics={<>
    <CompactAcademicMetric label={t.grades.termGpa} value={summary.termGpa4?.toFixed(2) ?? "-"} />
    <CompactAcademicMetric label={t.grades.cpa} value={summary.cpa4?.toFixed(2) ?? "-"} />
    <CompactAcademicMetric label={t.grades.includedCredits} value={t.grades.creditRatio(summary.includedCredits, summary.listedCredits)} />
  </>}
  action={termExportModel ? <ExportMenu model={termExportModel} /> : null}
>
  <GradeTable grades={sortedCourses} sort={sort} onSortChange={setSort} universityId={state.universityId} />
</AcademicTermSection>
```

- [ ] **Step 2.3: Export `CompactAcademicMetric` from grades.tsx**

Add `export` to the function at line 19:
```ts
export function CompactAcademicMetric({ label, value }: { label: string; value: string }) {
```

This way lookup.tsx can also import it.

- [ ] **Step 2.4: Run typecheck**

Run: `pnpm test` (full typecheck)
Expected: no errors.

---

### Task 3: Extract shared GradeTable component

**Files:**
- Create: `apps/web/src/components/grades/grade-table.tsx`
- Modify: `apps/web/src/pages/grades.tsx`

- [ ] **Step 3.1: Create `GradeTable` component**

Create `apps/web/src/components/grades/grade-table.tsx`:

```tsx
import type { GradeSortKey, GradeSortState } from "@/lib/grade-view-model";
import type { GradeTableRow } from "@/lib/grade-view-model";
import { sortGradeTableRows } from "@/lib/grade-view-model";
import { ChevronDown } from "lucide-react";
import { Fragment, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Empty } from "@/components/shared";
import { cn } from "@/lib/utils";
import { useLocale } from "@/lib/i18n";
import { SummerBadge } from "@/pages/grades";

export type GradeTableProps = {
  rows: readonly GradeTableRow[];
  sort: GradeSortState;
  onSortChange: (sort: GradeSortState) => void;
  emptyText: string;
};

const sortableHeaders: Array<{ key: GradeSortKey; labelKey: string; align?: "right"; className?: string }> = [
  { key: "name", labelKey: "course" },
  { key: "credits", labelKey: "credits", align: "right" },
  { key: "point10", labelKey: "point10", align: "right" },
  { key: "point4", labelKey: "point4", align: "right", className: "max-sm:hidden" },
];

export function GradeTable({ rows, sort, onSortChange, emptyText }: GradeTableProps) {
  const { t } = useLocale();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const sorted = sortGradeTableRows(rows, sort);
  if (!sorted.length) return <Empty text={emptyText} />;

  const changeSort = (key: GradeSortKey) => {
    const direction = sort.key === key && sort.direction === "asc" ? "desc" : "asc";
    onSortChange({ key, direction });
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">
              <button type="button" onClick={() => changeSort("name")} className="inline-flex items-center gap-1 hover:text-foreground">
                {t.grades.course}
                <span className="text-[10px]">{sort.key === "name" ? (sort.direction === "asc" ? "▲" : "▼") : ""}</span>
              </button>
            </th>
            <th className="px-3 py-2 text-left font-medium">{t.grades.letter}</th>
            <th className="px-3 py-2 text-right font-medium">
              <button type="button" onClick={() => changeSort("credits")} className="inline-flex items-center gap-1 justify-end hover:text-foreground">
                {t.grades.credits}
                <span className="text-[10px]">{sort.key === "credits" ? (sort.direction === "asc" ? "▲" : "▼") : ""}</span>
              </button>
            </th>
            <th className="px-3 py-2 text-right font-medium">
              <button type="button" onClick={() => changeSort("point10")} className="inline-flex items-center gap-1 justify-end hover:text-foreground">
                {t.grades.point10}
                <span className="text-[10px]">{sort.key === "point10" ? (sort.direction === "asc" ? "▲" : "▼") : ""}</span>
              </button>
            </th>
            <th className="px-3 py-2 text-right font-medium max-sm:hidden">
              <button type="button" onClick={() => changeSort("point4")} className="inline-flex items-center gap-1 justify-end hover:text-foreground">
                {t.grades.point4}
                <span className="text-[10px]">{sort.key === "point4" ? (sort.direction === "asc" ? "▲" : "▼") : ""}</span>
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const expanded = expandedIds.has(row.id);
            return (
              <Fragment key={row.id}>
                <tr
                  className="table-row-motion cursor-pointer border-t border-border"
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button")) return;
                    toggleExpanded(row.id);
                  }}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(row.id)}
                        aria-expanded={expanded}
                        aria-label={t.grades.toggleDetails(row.courseName)}
                        className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground max-lg:-mx-1.5 max-lg:-my-2 max-lg:p-2"
                      >
                        <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
                      </button>
                      <span>{row.courseName}</span>
                      {row.isSummer ? <SummerBadge /> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {row.letter ? (
                      <Badge
                        data-testid="letter-badge"
                        className="min-w-9 justify-center text-sm font-semibold tabular-nums"
                      >
                        {row.letter}
                      </Badge>
                    ) : <span className="text-muted-foreground">-</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.credits ?? "-"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.point10 ?? "-"}</td>
                  <td className="px-3 py-2 text-right tabular-nums max-sm:hidden">{row.point4 ?? "-"}</td>
                </tr>
                <tr>
                  <td colSpan={5} className="p-0">
                    <div className="collapsible-panel" data-open={expanded} data-testid="grade-detail">
                      <div>
                        {expanded ? row.detail.render() : null}
                      </div>
                    </div>
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

Note: `SummerBadge` is currently defined in `grades.tsx`. Export it:

```ts
export function SummerBadge() { ... }
```

And import it into `grade-table.tsx`:
```ts
import { SummerBadge } from "@/pages/grades";
```

- [ ] **Step 3.2: Rewire `GradesPage` to use `GradeTable`**

In `grades.tsx`, the `GradeTable` function (lines 112-197) should now use the shared component. The personal GradeTable function becomes a thin wrapper/remapping:

Replace the entire `GradeTable` function (lines 112-197) with:

```tsx
import { GradeTable } from "@/components/grades/grade-table";
import type { GradeTableRow } from "@/lib/grade-view-model";

function GradesGradeTable({ grades, sort, onSortChange, universityId, emptyText }: { grades: Grade[]; sort: GradeSortState; onSortChange: (sort: GradeSortState) => void; universityId: string; emptyText: string }) {
  const rows: GradeTableRow[] = grades.map((grade) => ({
    id: grade.id,
    courseName: grade.courseName,
    credits: grade.credits,
    point10: grade.point10,
    letter: letterForGrade(grade, universityId),
    point4: grade.point4,
    isSummer: isSummerGrade(grade, universityId),
    detail: { kind: "available", render: () => <GradeDetail grade={grade} universityId={universityId} /> },
  }));
  return <GradeTable rows={rows} sort={sort} onSortChange={onSortChange} emptyText={emptyText} />;
}
```

Update the call site (line 302) from `<GradeTable grades={sortedCourses} sort={sort} onSortChange={setSort} universityId={state.universityId} />` to `<GradesGradeTable grades={sortedCourses} sort={sort} onSortChange={setSort} universityId={state.universityId} emptyText={t.grades.noGrades} />`.

Also rename the old inline `LetterBadge` component — it's used in both `GradeDetail` (not shared) and `GradeTable` (shared). The shared `GradeTable` inline-renders its own simpler letter badge (see template above). The `GradeDetail` keeps using the local `LetterBadge`. No conflict.

- [ ] **Step 3.3: Remove old `GradeTable` function**

Remove lines 112-197 from `grades.tsx` (replaced by `GradesGradeTable` above). Also remove the old `chevron`-related inline button/label logic since `GradeTable` now owns it. But keep `GradeDetail` and `VnuGradeDetail` — they are used by the detail renderer.

- [ ] **Step 3.4: Export `SummerBadge`**

In `grades.tsx`, add `export` to the function (line 28):
```ts
export function SummerBadge() {
```

- [ ] **Step 3.5: Run typecheck**

Run: `pnpm test`
Expected: no errors across web package.

---

### Task 4: Rewire CrossTranscriptTerm to use shared components

**Files:**
- Modify: `apps/web/src/pages/lookup.tsx`

- [ ] **Step 4.1: Import shared components**

At top of `lookup.tsx`, add imports:
```ts
import { GradeTable } from "@/components/grades/grade-table";
import { AcademicTermSection } from "@/components/grades/academic-term-section";
import type { GradeTableRow } from "@/lib/grade-view-model";
import { CompactAcademicMetric } from "@/pages/grades";
```

- [ ] **Step 4.2: Create row mapping function and shared state**

In `CrossTranscriptSection` (line 583), the `expandedPermit` state (line 590) is currently `string | undefined`. Change to:

```ts
const [expandedPermit, setExpandedPermit] = useState<Set<string>>(new Set());
```

Remove the old `const togglePermit = (permit: string) => setExpandedPermit((prev) => prev === permit ? undefined : permit);` logic.

- [ ] **Step 4.3: Map `summary.courses` to `GradeTableRow[]` in `CrossTranscriptTerm`**

In `CrossTranscriptTerm` (line 531), replace the inline table markup with mapping + shared components.

The function body should become:

```tsx
function CrossTranscriptTerm({ summary, permits, expandedPermits, details, onToggle }: {
  summary: AcademicTermSummary<VnuTranscriptRow>;
  permits: Map<string, string>;
  expandedPermits: Set<string>;
  details: Map<string, VnuCrossDetailComponent[]>;
  onToggle: (permit: string) => void;
}) {
  const { t } = useLocale();
  const label = formatTermLabel(summary.termKey, "vnu", t.terms);
  const headingId = `cross-transcript-term-${summary.termKey}`;

  const rows: GradeTableRow[] = summary.courses.map((row, index) => {
    const permitKey = `${summary.termKey}:${row.courseCode}:${row.classId ?? index}`;
    const permit = permits.get(permitKey);
    const id = `${summary.termKey}:${index}`;
    return {
      id,
      courseName: row.courseName,
      credits: row.credits ?? null,
      point10: row.grade10 ?? null,
      letter: row.letterGrade ?? null,
      point4: row.grade4 ?? null,
      detail: permit
        ? { kind: "available" as const, render: () => {
            const components = details.get(permit);
            if (!components) return <div className="px-4 py-3"><Skeleton className="h-12" /></div>;
            if (!components.length) return <div className="px-4 py-3"><Empty text={t.lookup.pointDetailEmpty} /></div>;
            return (
              <div className="divide-y divide-border bg-muted/30 px-4">
                {components.map((component) => (
                  <div key={component.index} className="list-row">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">{component.nature || "-"}</p>
                      <p className="text-xs text-muted-foreground">
                        {[
                          component.weight != null ? t.lookup.pointDetailWeight(component.weight) : undefined,
                          component.attempt != null ? t.lookup.pointDetailAttempt(component.attempt) : undefined,
                        ].filter(Boolean).join(" · ") || "-"}
                      </p>
                    </div>
                    <Badge className="shrink-0 border border-border bg-background font-normal tabular-nums text-foreground">{component.score ?? "-"}</Badge>
                  </div>
                ))}
              </div>
            );
          }}
        : { kind: "unavailable" as const, render: () => <div className="px-4 py-3"><Empty text={t.grades.componentDetailUnavailable} /></div> },
    };
  });

  return (
    <AcademicTermSection
      id={headingId}
      label={label}
      headingLevel="h4"
      includesSummer={false}
      derivedLabel={t.grades.derived}
      metrics={<>
        <CompactAcademicMetric label={t.grades.termGpa} value={summary.termGpa4?.toFixed(2) ?? "-"} />
        <CompactAcademicMetric label={t.grades.cpa} value={summary.cpa4?.toFixed(2) ?? "-"} />
        <CompactAcademicMetric label={t.grades.includedCredits} value={t.grades.creditRatio(summary.includedCredits, summary.listedCredits)} />
      </>}
    >
      <GradeTable rows={rows} sort={{ key: "name", direction: "asc" }} onSortChange={() => {}} emptyText={t.grades.noGrades} />
    </AcademicTermSection>
  );
}
```

Note: Cross transcript doesn't support sorting yet — `onSortChange` is a no-op. A future task can add sort state to `CrossTranscriptSection`.

- [ ] **Step 4.4: Remove old `CrossTranscriptTerm` table markup**

Remove all the inline `<div data-testid="cross-transcript-table">` through `</table>` markup that was replaced. The old markup spans from the end of the header to the closing `</section>` — replaced by the `AcademicTermSection` + `GradeTable` above.

- [ ] **Step 4.5: Update the old `expandedPermit` state and `onToggle` in `CrossTranscriptSection`**

In `CrossTranscriptSection` (line 586-591):

Old:
```ts
const [expandedPermit, setExpandedPermit] = useState<string>();
```
New:
```ts
const [expandedPermits, setExpandedPermits] = useState<Set<string>>(new Set());
```

Old `onToggle` (around line 640 in current code) — find the pattern like `onToggle={(permit) => setExpandedPermit(permit)}` and replace with set-based toggle:
```ts
onToggle={(permit) => setExpandedPermits((prev) => { const next = new Set(prev); if (next.has(permit)) next.delete(permit); else next.add(permit); return next; })}
```

Also update the prop on `CrossTranscriptTerm` from `expandedPermit` → `expandedPermits`:
```tsx
<CrossTranscriptTerm
  key={summary.termKey}
  summary={summary}
  permits={permits}
  expandedPermits={expandedPermits}
  details={details}
  onToggle={(permit) => setExpandedPermits((prev) => { const next = new Set(prev); if (next.has(permit)) next.delete(permit); else next.add(permit); return next; })}
/>
```

- [ ] **Step 4.6: Remove old imports**

Remove any imports in `lookup.tsx` that were only used by the old inline cross-transcript table (e.g., if `table-fixed` or other old-only imports remain).

- [ ] **Step 4.7: Run typecheck**

Run: `pnpm test`
Expected: no type errors.

---

### Task 5: Update tests

**Files:**
- Modify: `apps/web/tests/lookup.spec.ts`
- Modify: `apps/web/tests/grades-export.spec.ts`
- Modify: `apps/web/src/lib/grade-view-model.test.ts`

- [ ] **Step 5.1: Update lookup.spec.ts**

Search for test interactions using the old cross-transcript table:
- Remove assertions targeting `cross-transcript-table` old structure
- Update `Details` button interactions to use chevron `Toggle details for` accessible name
- Add assertions: header order is Course → Letter → Credits → Point 10 → Point 4
- Add sort header assertions
- Add multi-open test (expand two rows, verify both panels visible)
- Verify `data-testid="grade-detail"` renders on expansion
- Add mobile viewport check: Point 4 column hidden below `sm`

Run after changes:
```bash
pnpm --filter @hyeboard/web exec playwright test lookup.spec.ts
```

- [ ] **Step 5.2: Update grades-export.spec.ts**

Add assertion: exported data column order matches new shared header order. Add lazy-detail test: intercept network, verify no point-detail request before expansion, verify one request after expansion.

- [ ] **Step 5.3: Run unit tests**

Run: `pnpm --filter @hyeboard/web exec vitest run src/lib/grade-view-model.test.ts`
Expected: all sortGradeTableRows tests pass.

- [ ] **Step 5.4: Full test suite**

Run: `pnpm test`
Expected: all tests pass across all packages.

---
