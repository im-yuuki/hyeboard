# PDF Term Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a separate PDF course table for every academic term instead of one flattened final table.

**Architecture:** Narrow `pdfCourseTable` to a single `ExportDerivedTerm`, eliminating its flattened rows and term-name column. Render it during every existing term loop: the top-level report loop and a shared term-content helper used by nested result reports. Keep all export inputs, labels, CSV, JSON, printable HTML, layout, and page orientation unchanged.

**Tech Stack:** TypeScript, Vitest, pdfmake.

---

## File structure

- Modify: `apps/web/src/lib/data-export.ts` — create one-term PDF table, centralize term heading/summary/table rendering, reuse it for top-level and nested exports.
- Modify: `apps/web/src/lib/data-export.test.ts` — assert a two-term PDF model creates two isolated course tables.

### Task 1: Add failing two-term PDF regression test

**Files:**

- Modify: `apps/web/src/lib/data-export.test.ts` — PDF export describe block after `maps grades into a seven-column landscape course table...`

- [ ] **Step 1: Define a second term inside the test**

```ts
const nextTerm = {
  ...term,
  termCode: "252",
  termLabel: "Semester 2, 2025–2026",
  courses: [{ ...term.courses[0]!, courseCode: "INT2002", courseName: "Second-term course" }],
};
```

- [ ] **Step 2: Write the failing table-isolation assertion**

```ts
const definition = createPdfExportDefinition(
  createGradesExport({ surface: "grades-page", universityId: "mock", derivedTerms: [term, nextTerm] }),
  "en",
  labels,
);
const tables = (definition.content as Array<{ table?: { body: unknown[][] } }>).flatMap((item) => item.table ? [item.table] : []);

expect(tables).toHaveLength(2);
expect(JSON.stringify(tables[0])).toContain("INT1001");
expect(JSON.stringify(tables[0])).not.toContain("INT2002");
expect(JSON.stringify(tables[1])).toContain("INT2002");
expect(JSON.stringify(tables[1])).not.toContain("INT1001");
expect(JSON.stringify(tables)).not.toContain(labels.terms);
```

- [ ] **Step 3: Run the focused test; verify failure**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/data-export.test.ts -t "splits PDF course tables by term"
```

Expected: FAIL because the current renderer creates one flattened table with `labels.terms`.

### Task 2: Render a course table per term

**Files:**

- Modify: `apps/web/src/lib/data-export.ts:330-379` — replace multi-term `pdfCourseTable` and add shared term content builder.
- Modify: `apps/web/src/lib/data-export.ts:405-417` — use shared term content for top-level report.

- [ ] **Step 1: Narrow the table helper to one term**

Replace the flattened helper body with:

```ts
function pdfCourseTable(term: ExportDerivedTerm, labels: PdfExportLabels): PdfDocumentDefinition | undefined {
  if (!term.courses.length) return undefined;
  return {
    table: {
      headerRows: 1,
      widths: ["auto", "*", "auto", "auto", "auto", "auto"],
      body: [[
        { text: labels.course, bold: true, color: PDF_COLORS.accent },
        { text: labels.name, bold: true, color: PDF_COLORS.accent },
        { text: labels.credits, bold: true, color: PDF_COLORS.accent },
        { text: labels.score, bold: true, color: PDF_COLORS.accent },
        { text: labels.letter, bold: true, color: PDF_COLORS.accent },
        { text: labels.point4, bold: true, color: PDF_COLORS.accent },
      ], ...term.courses.map((course) => [
        course.courseCode,
        course.courseName,
        pdfValue(course.credits),
        pdfValue(course.point10),
        pdfValue(course.letter),
        pdfValue(course.point4),
      ])],
    },
    layout: PDF_TABLE_LAYOUT,
    fontSize: 7.5,
    margin: [0, 3, 0, 10],
  };
}
```

- [ ] **Step 2: Add shared term content builder**

```ts
function pdfTermsContent(terms: readonly ExportDerivedTerm[], labels: PdfExportLabels): PdfDocumentDefinition[] {
  return terms.flatMap((term) => {
    const summary = pdfMetadataTable({ [labels.credits]: `${term.includedCredits} / ${term.listedCredits}`, [labels.gpa]: term.termGpa4, [labels.cpa]: term.derivedCpa4 });
    const courses = pdfCourseTable(term, labels);
    return [{ text: term.termLabel, style: "subsection" }, ...(summary ? [summary] : []), ...(courses ? [courses] : [])];
  });
}
```

- [ ] **Step 3: Reuse the shared helper**

In `pdfResultContent`, replace:

```ts
const courses = result.derivedTerms && pdfCourseTable(result.derivedTerms, labels);
if (courses) content.push(courses);
```

with:

```ts
if (result.derivedTerms?.length) content.push(...pdfTermsContent(result.derivedTerms, labels));
```

In `createPdfExportDefinition`, replace the manual per-term loop and final `pdfCourseTable(document.derivedTerms, labels)` with:

```ts
content.push({ text: labels.terms, style: "section" }, ...pdfTermsContent(document.derivedTerms, labels));
```

- [ ] **Step 4: Run focused regression test; verify pass**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/data-export.test.ts -t "splits PDF course tables by term"
```

Expected: PASS.

- [ ] **Step 5: Run export unit tests**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/data-export.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 6: Run TypeScript validation**

Run:

```bash
pnpm test
```

Expected: exit code 0.

- [ ] **Step 7: Commit implementation**

```bash
git add apps/web/src/lib/data-export.ts apps/web/src/lib/data-export.test.ts
git commit -m "fix: split PDF course tables by term"
```
