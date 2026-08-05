# Reusable GradeTable Design

Status: approved
Date: 2026-08-05

## Goal

Extract a canonical shared `GradeTable` component from `apps/web/src/pages/grades.tsx` so both the personal Grades page and the Cross Transcript lookup table render the same visual layout and interaction behavior. Same header order, sortable columns, chevron row-click expansion, `Set`-based multi-open, responsive hiding of Point 4, lazy detail mounting, and standard loading/error/empty/unavailable panels. No clone. No backward-compat split. Single source of truth for the grade-table UI.

## Canonical Row Contract

```ts
type GradeTableRow = {
  id: string;
  courseName: string;
  credits?: number | null;
  point10?: number | null;
  letter?: string;
  point4?: number | null;
  isSummer?: boolean;
  detail: GradeTableDetail;
};

type GradeTableDetail =
  | { kind: "available"; render: () => ReactNode }
  | { kind: "unavailable"; render: () => ReactNode };
```

`detail.kind === "available"` produces lazy detail content that mounts only when the row is expanded. `detail.kind === "unavailable"` renders a shared unavailable message but still shows the chevron — the row is expandable, the detail just conveys unavailability rather than fetched data.

## Shared GradeTable Props

| Prop | Type | Notes |
|------|------|-------|
| `rows` | `readonly GradeTableRow[]` | Sorted by consumer before passing in (see Sorting) |
| `sort` | `GradeSortState` | Current sort key and direction |
| `onSortChange` | `(sort: GradeSortState) => void` | Called on header click |
| `emptyText` | `string` | Shown when `rows` is empty |

The component owns `expandedIds: Set<string>` internally via `useState`. Each consumer initializes its own `sort` state — `GradeTable` receives it as a controlled prop.

## Column order (single canonical)

| Column | Alignment | Responsive |
|--------|-----------|------------|
| Course | Left | Always visible |
| Letter | Left | Always visible |
| Credits | Right | Always visible |
| Point 10 | Right | Always visible |
| Point 4 | Right | `max-sm:hidden` |

Sort buttons on sortable numeric columns (Credits, Point 10, Point 4). Course column has a sort button by name. Chevron button has `aria-expanded` and `aria-label="Toggle details for {courseName}"`.

No course-code second line in the Course cell. No "Details"/"Chi tiết" button in the Point 4 cell. No `table-fixed`, `min-w-[36rem]`, or `max-h-[32rem]` overrides — the table layout is natural-flow.

## Detail mounting (lazy, both surfaces)

Row detail panels mount only when the row is expanded. Collapsed rows present no query, no skeleton, no placeholder DOM. Two strategies:

- **Personal Grades surface**: `detail.render` mounts `VnuGradeDetail` (own VNU point-detail query via `api.vnuPointDetail`) for rows with `classId` + `termOrdinal`, or a generic stat panel showing Point 10 / Point 4 / Credits / term label for non-VNU rows. The generic panel serves as the fallback for universities without per-component detail APIs — it still uses the shared `detail.render` contract.

- **Cross Transcript surface**: `detail.render` mounts a component backed by opaque permit/request/cache state owned by `CrossTranscriptSection`. The permit is resolved from source coordinates (`termIndex:rowIndex`) before mapping to `GradeTableRow` — never recomputed after sorting. The cross-detail query (`api.vnuCrossDetail`) is lazy and cancellable via `AbortController`. If the detail fetch fails, the panel must surface a visible error, not silently collapse.

- **Unavailable rows**: Cross transcript rows without a `detailPermit` get `detail.kind === "unavailable"`. The chevron still renders and the panel still opens, but it displays the shared unavailable message (`t.grades.componentDetailUnavailable`).

## Header and Sorting

Sort state type:

```ts
type GradeSortKey = "courseName" | "credits" | "point10" | "point4";
type GradeSortState = { key: GradeSortKey; direction: "asc" | "desc" };
```

Each consumer initializes its own `sort` state: `{ key: "courseName", direction: "asc" }`. The existing `sortGrades` in `apps/web/src/lib/grade-view-model.ts` (line 39) is generalized from operating on `Grade` to operating on `GradeTableRow`. Null/numeric values sort as `-1` (missing). Tie-breaker is always `courseName` ascending.

Sorted order feeds both table rendering and exports — the consumer passes the same sorted `rows` to `GradeTable` and to `createGradesExport`/`createTranscriptExport`.

## Term Summary

Existing `CompactAcademicMetric` (`grades.tsx` line 19) and the term header layout (`academic-term-header` at line 295) are extracted into a shared `AcademicTermSection` that receives:

- `summary`: term GPA/CPA/credit ratio values
- `label`: term display name
- `headingLevel`: `"h2"` (personal) or `"h4"` (cross)
- `summerBadge`: whether to show the summer badge
- `optionalAction`: export menu or similar action element
- `children`: the `GradeTable` instance

The existing `CompactAcademicMetric` component stays — it is already simple and reusable. The term header markup (border-y, flex-wrap, derived badge, metrics, export slot) is what moves into `AcademicTermSection`.

## Cross Transcript Specifics

### Row identity

Row ID uses `termIndex:rowIndex` concatenation — stable across duplicate courses, sorting, and re-fetches. The current `CrossTranscriptTerm` (lookup.tsx line 530) uses `${row.courseCode}-${row.classId ?? index}`, which is fragile for duplicates. The canonical row ID becomes:

```ts
id: `${termIndex}:${rowIndex}`
```

### Permit attachment

Permits (`detailPermit` on `VnuTranscriptRow`) map to row coordinates before rows are sorted or grouped. The mapping happens once in `CrossTranscriptSection` and feeds into the `GradeTableRow.detail` construction:

```ts
for (const [termIndex, termData] of transcriptData.terms.entries()) {
  for (const [rowIndex, row] of termData.rows.entries()) {
    const permit = row.detailPermit;
    rows.push({
      id: `${termIndex}:${rowIndex}`,
      courseName: row.courseName,
      credits: row.credits ?? null,
      point10: row.grade10 ?? null,
      letter: row.letterGrade ?? null,
      point4: row.grade4 ?? null,
      detail: permit
        ? { kind: "available", render: () => <CrossDetailPanel permit={permit} /> }
        : { kind: "unavailable", render: () => <UnavailablePanel /> },
    });
  }
}
```

Never recompute permits from sorted row positions.

### State ownership split

Kept outside `GradeTable` (owned by `CrossTranscriptSection`):
- Target form (mode toggle, input, submit button)
- Identity display (student name, code, class)
- Portal totals (`SummaryStrip` with total/accumulated credits, GPA4)
- Export model construction
- Permit → detail cache (`Map<string, VnuCrossDetailComponent[]>`)
- `AbortController` for cross-detail fetch
- Query gating (`crossDetailEnabled`, `enabled: Boolean(submitted)`)

### Removed from Cross Transcript table

- Course-code second line (`row.courseCode` in a `<p>` below `courseName`)
- `Details`/`Chi tiết` button in the Point 4 cell — replaced by chevron expansion
- `max-h-[32rem]`, `min-w-[36rem]`, `table-fixed` styling — use natural-flow layout from shared `GradeTable`
- Unsortable headers — all sortable via shared header buttons

### Letter source

Cross transcript uses `row.letterGrade` from portal data directly. Never derive a UET-style letter via `letterForGrade` for cross rows — the portal's own `letterGrade` field is the authoritative value.

## Personal Grades Specifics

Kept outside `GradeTable` (owned by `GradesPage`):
- Own grades query (`useFeatureQuery("grades", ...)`)
- Reported GPA strip (`SummaryStrip` with cumulative GPA, CPA, accumulated credits)
- Term select dropdown
- Personal export model
- Summer grouping / term-merge logic
- VNU-specific point-detail query (`api.vnuPointDetail` inside `VnuGradeDetail`)

`GradesPage` maps `Grade[]` to `GradeTableRow[]`:

```ts
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
```

### Summer badge

`isSummer` on `GradeTableRow` renders a `SummerBadge` (`Badge` with border-border, bg-background) next to the course name, matching the current behavior in `grades.tsx` line 180.

## Test coverage

### Playwright — lookup.spec.ts

- Assert identical header order (Course, Letter, Credits, Point 10, Point 4) across both personal and cross tables
- Assert chevron `aria-label="Toggle details for {course}"` on expandable rows
- Assert `aria-expanded` toggles on chevron click and row click
- Assert multiple rows can be open simultaneously (Set behavior)
- Assert Point 4 column is hidden on viewports ≤ 640px
- Assert shared grade-detail panel `data-testid="grade-detail"` renders on expansion
- Remove old `Details` button interaction assertions
- Add mobile cross-table regression test (verify no overflow, no missing columns besides Point 4)

### Playwright — grades-export.spec.ts

- Assert shared column order in exported data matches table column order
- Assert lazy detail behavior: collapsed rows produce no detail queries in network trace

### Unit — grade-view-model.test.ts

- Generic `sortGrades` operates correctly on `GradeTableRow` (not just `Grade`)
- Duplicate course rows produce distinct sort positions (tie-breaker is position-stable)
- Sort does not mutate source array
- Null values sort as `-1` (before any valid value in ascending order)

### Unit — cross row mapping

- Row IDs are `termIndex:rowIndex` and stable regardless of duplicate course codes or sort order
- Permits attached by source coordinates before sorting
- Non-permitted rows produce `detail.kind === "unavailable"`, not absent/hidden rows

## Risks

| Risk | Mitigation |
|------|------------|
| Duplicate course rows | Use source `termIndex:rowIndex` for stable key, never course code or classId |
| Permit resolved after sort | Attach permits before sort, never recompute |
| Lazy detail changes network timing vs eager personal detail | Test explicitly — both surfaces must show loading state after expand and render data without requiring the other surface's side effects |
| Cross detail fetch failure | Surface visible error; do not silently collapse the panel |
| Non-permitted cross rows | Show unavailable panel, not hidden row |
| Letter source divergence | Cross uses portal `letterGrade`; personal uses `letterForGrade` |
| Null scores | Display `-`, sort as missing (`-1`) |

## Implementation order

1. Define `GradeTableRow` and `GradeTableDetail` types in `apps/web/src/lib/grade-view-model.ts`
2. Generalize `sortGrades` to operate on `GradeTableRow`
3. Extract `AcademicTermSection` from the term header markup in `GradesPage`
4. Extract `GradeTable` as a shared component (`apps/web/src/components/grades/grade-table.tsx`)
5. Rewire `GradesPage` to map `Grade[]` → `GradeTableRow[]` and use shared `GradeTable`
6. Rewire `CrossTranscriptTerm` to map `VnuTranscriptRow[]` → `GradeTableRow[]` and use shared `GradeTable`
7. Remove `CrossTranscriptTerm`'s inline table (lines 545–603 of `lookup.tsx`)
8. Add/update tests per Test coverage section
