# VNU Spaced Course Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve portal-visible spacing in valid VNU course codes while making spaced and compact forms equivalent for VNU parsing, lookup, document search, and pass-through exports.

**Architecture:** A browser-safe pure module under the VNU adapter owns display whitespace collapse and comparison-key generation; parser code imports it at the HTML text boundary, and web code deep-imports it without loading the adapter barrel. One anchored composite parser recognizes the verified three-digit term, VNU course grammar, and optional observed class token, while endpoint-specific malformed fallbacks remain intact. Web filtering moves into a tested university-aware helper: only `universityId === "vnu"` gets whitespace-insensitive course comparison, while every other university retains the exact existing trim/uppercase/substring behavior. Empty document queries return the original query-data array reference without allocation. Existing serializers remain unchanged and gain preservation tests.

**Tech Stack:** TypeScript 6, ECMAScript regular expressions, React 19, TanStack Query 5, Vitest 3/4, Playwright 1.61, pnpm 11.

**Approved design:** `docs/superpowers/specs/2026-07-28-vnu-spaced-course-code-design.md`

---

## Worktree, Baseline, and Scope Guard

Run every command from:

```text
F:\Workspace\hyeboard\.worktrees\feature-vnu-automatic-relogin
```

Use immutable overall diff/privacy baseline `$BASE_SHA = "ba8d4c8b01990e00c2b8b2f67f9320fe40ade5b3"` in PowerShell. The reviewed plan is committed before Task 1; `$BASE_SHA` is not the expected implementation-start HEAD.

- [ ] **Before Task 1, capture and prove the reviewed plan commit**

```powershell
$BASE_SHA = "ba8d4c8b01990e00c2b8b2f67f9320fe40ade5b3"
$PLAN_SHA = git rev-parse HEAD
git rev-parse --show-toplevel
git rev-parse "$PLAN_SHA^"
git merge-base --is-ancestor $BASE_SHA $PLAN_SHA
git status --short
```

Expected root and plan parent:

```text
F:/Workspace/hyeboard/.worktrees/feature-vnu-automatic-relogin
ba8d4c8b01990e00c2b8b2f67f9320fe40ade5b3
```

`$PLAN_SHA` captures the reviewed plan commit without inventing its hash in advance. Its parent is exactly `$BASE_SHA`, `merge-base` exits `0`, and status is clean before implementation. Stop if the plan commit is not a direct descendant of `$BASE_SHA`, any path is dirty, or the root is `F:/Workspace/hyeboard`.

At every task:

- stage only the task allowlist; never use `git add .` or `git add -A`;
- never amend, reset, restore unrelated files, rebase, merge, push, deploy, or run `pnpm deploy`;
- do not implement or modify automatic relogin Task 7/8 behavior;
- do not modify shared schemas, UET parsing, Mock parsing, Worker routes, mapper pass-through, or export serializers;
- use only generic course code `INT 3103` and conspicuously synthetic course/class data; add no student identity fixture, HAR text, token, cookie, credential, or Authorization value.

## File Map

### Create

- `packages/university-adapters/src/vnu/course-code.ts`: pure display-collapse and comparison-key primitives; no HTML, adapter, React, network, or schema dependency.
- `packages/university-adapters/src/vnu/course-code.test.ts`: exact ECMAScript Unicode whitespace, case, punctuation, and zero-width behavior.
- `apps/web/src/lib/university-course-search.ts`: university-aware catalog and document filtering at the web data boundary.
- `apps/web/src/lib/university-course-search.test.ts`: VNU compact/spaced equivalence plus class-number and exact Mock/UET behavior regressions.

### Modify

- `packages/university-adapters/src/vnu/parser.ts:7-50,127-169,253-304,316-373`: use one display boundary, accept complete spaced course tokens, and anchor exam/catalog splits.
- `packages/university-adapters/src/vnu/parser.test.ts:1-81`: add synthetic grades/transcript, syllabus, exam, catalog, suffix, separator, entity, malformed, and fallback matrices.
- `apps/web/src/pages/lookup.tsx:1-55,146`: delegate forward course/class filtering with explicit `state.universityId`; leave exact reverse class-ID lookup unchanged.
- `apps/web/src/pages/documents.tsx:1-67`: delegate filtering with explicit `state.universityId` so VNU keys never affect UET/Mock names or codes.
- `apps/web/src/lib/data-export.test.ts:118-398`: prove unchanged JSON/CSV class, grades, and transcript serializers preserve `INT 3103`.
- `apps/web/tests/smoke.spec.ts:95-165,1824-1920,2306-2335`: preserve the existing Mock fixture/test and add explicit VNU-context lookup/documents flows, compact/spaced matching, JSON/CSV export, and no refetch.

### Explicit Non-Changes

- `packages/schemas/src/index.ts`: course-code fields already accept strings; no normalization belongs here.
- `packages/university-adapters/src/vnu/mapper.ts`: `mapGradeRow`, `mapExamRow`, and `mapSyllabusRow` already pass `courseCode` through.
- `apps/web/src/lib/data-export.ts`: `copyCourse`, `copyResult`, `createTermRows`, and `createResultRows` already pass display strings through.
- `apps/web/src/pages/lookup.tsx:51-55`: `filterCatalogRowsByClassId` remains exact after edge trim and does not compare course codes.
- No i18n copy, API request, cache key, session, automatic relogin, logging, telemetry, or deployment change.

## Dependency and Commit Order

```text
1 VNU primitive + parser
  -> 2 web search + export/browser regressions
  -> 3 repository verification (no commit)
```

Two sequential implementation commits. Each commit independently typechecks.

---

### Task 1: Add the VNU Primitive and Parse Spaced Course Codes

**Files:**
- Create: `packages/university-adapters/src/vnu/course-code.ts`
- Create: `packages/university-adapters/src/vnu/course-code.test.ts`
- Modify: `packages/university-adapters/src/vnu/parser.ts:7-50,127-169,253-304,316-373`
- Modify: `packages/university-adapters/src/vnu/parser.test.ts:1-81`

- [ ] **Step 1: Write RED primitive tests**

Create `packages/university-adapters/src/vnu/course-code.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { collapseVnuCourseCodeDisplay, vnuCourseCodeKey } from "./course-code";

const ECMASCRIPT_WHITESPACE_AND_LINE_TERMINATORS = [
  ["U+0009", "\u0009"],
  ["U+000A", "\u000a"],
  ["U+000B", "\u000b"],
  ["U+000C", "\u000c"],
  ["U+000D", "\u000d"],
  ["U+0020", "\u0020"],
  ["U+00A0", "\u00a0"],
  ["U+1680", "\u1680"],
  ["U+2000", "\u2000"],
  ["U+2001", "\u2001"],
  ["U+2002", "\u2002"],
  ["U+2003", "\u2003"],
  ["U+2004", "\u2004"],
  ["U+2005", "\u2005"],
  ["U+2006", "\u2006"],
  ["U+2007", "\u2007"],
  ["U+2008", "\u2008"],
  ["U+2009", "\u2009"],
  ["U+200A", "\u200a"],
  ["U+2028", "\u2028"],
  ["U+2029", "\u2029"],
  ["U+202F", "\u202f"],
  ["U+205F", "\u205f"],
  ["U+3000", "\u3000"],
  ["U+FEFF", "\ufeff"],
] as const;

const EXCLUDED_CONTROLS = [
  ["U+0085", "\u0085"],
  ["U+200B", "\u200b"],
] as const;

describe("VNU course-code normalization", () => {
  it.each(ECMASCRIPT_WHITESPACE_AND_LINE_TERMINATORS)("collapses ECMAScript whitespace %s for display", (_label, character) => {
    expect(collapseVnuCourseCodeDisplay(`INT${character}${character}3103`)).toBe("INT 3103");
  });

  it.each(ECMASCRIPT_WHITESPACE_AND_LINE_TERMINATORS)("removes ECMAScript whitespace %s from the comparison key", (_label, character) => {
    expect(vnuCourseCodeKey(`int${character}${character}3103`)).toBe("INT3103");
  });

  it.each([
    ["INT3103", "INT3103"],
    ["int 3103", "INT3103"],
    [" INT\u00a0\n3103a ", "INT3103A"],
    ["INT-3103", "INT-3103"],
  ])("builds the comparison key for %j", (input, expected) => {
    expect(vnuCourseCodeKey(input)).toBe(expected);
  });

  it.each(EXCLUDED_CONTROLS)("does not collapse excluded control %s", (_label, character) => {
    expect(collapseVnuCourseCodeDisplay(`INT${character}3103`)).toBe(`INT${character}3103`);
  });

  it.each(EXCLUDED_CONTROLS)("does not remove excluded control %s from the comparison key", (_label, character) => {
    expect(vnuCourseCodeKey(`int${character}3103`)).toBe(`INT${character}3103`);
  });
});
```

- [ ] **Step 2: Run the primitive test to verify RED**

Run:

```powershell
pnpm --filter @hyeboard/university-adapters exec vitest run src/vnu/course-code.test.ts
```

Expected: FAIL because `./course-code` does not exist.

- [ ] **Step 3: Implement the pure primitive**

Create `packages/university-adapters/src/vnu/course-code.ts`:

```ts
const ECMASCRIPT_WHITESPACE_RUN = /\s+/gu;

export function collapseVnuCourseCodeDisplay(value: string): string {
  return value.replace(ECMASCRIPT_WHITESPACE_RUN, " ").trim();
}

export function vnuCourseCodeKey(value: string): string {
  return value.trim().replace(ECMASCRIPT_WHITESPACE_RUN, "").toUpperCase();
}
```

Keep this as a deep-importable leaf module. Do not import from `parser.ts`, `registry.ts`, or the package barrel. Under ECMAScript 2022, `\s` covers the table-driven WhiteSpace and LineTerminator set above. It excludes `U+0085` and zero-width space (`U+200B`), as the explicit negative cases prove. The `u` flag makes intent explicit but does not broaden `\s` beyond ECMAScript's defined set.

- [ ] **Step 4: Run the primitive test to verify GREEN**

Run:

```powershell
pnpm --filter @hyeboard/university-adapters exec vitest run src/vnu/course-code.test.ts
```

Expected: PASS, including the Unicode and zero-width cases.

- [ ] **Step 5: Write RED parser matrices**

Replace the parser import in `packages/university-adapters/src/vnu/parser.test.ts` with:

```ts
import {
  isDaotaoSessionExpired,
  parseExamCatalogHtml,
  parseExamsHtml,
  parseGradesHtml,
  parsePortalNotice,
  parseSyllabusHtml,
  parseTranscriptHtml,
} from "./parser";
```

Append these helpers and suites after the existing `parseTranscriptHtml` suite:

```ts
function gradeTableRow(courseCodeHtml: string): string {
  return `<tr><td>1</td><td>${courseCodeHtml}</td><td>Synthetic Parsing</td><td>3</td><td>8</td><td>B</td><td>3</td></tr>`;
}

function examTableRow(codeHtml: string, hiddenClassId?: string): string {
  return `<tr id="1">
    <td>1${hiddenClassId ? `<input name="hidCrdID" value="${hiddenClassId}">` : ""}</td>
    <td>${codeHtml}</td><td>Synthetic Parsing</td><td>31/12/2099</td>
    <td>1(09:00)</td><td>Synthetic</td><td>LAB-SYNTHETIC</td><td>1</td>
  </tr>`;
}

function syllabusTableRow(courseCodeHtml: string): string {
  return `<tr>
    <td>1</td><td>${courseCodeHtml}</td><td>Synthetic Syllabus</td><td>3</td>
    <td><a href="synthetic.pdf">PDF</a></td><td></td><td>1 KB</td><td>31/12/2099</td>
  </tr>`;
}

describe("spaced VNU grade and transcript course codes", () => {
  it.each([
    ["INT3103", "INT3103"],
    [" INT 3103 ", "INT 3103"],
    ["INT&nbsp;3103", "INT 3103"],
    ["INT&#160;3103", "INT 3103"],
    ["INT&#xA0;3103", "INT 3103"],
    ["INT\t\r\n3103", "INT 3103"],
    ["INT<span> </span>3103", "INT 3103"],
    ["INT   3103A", "INT 3103A"],
  ])("retains and normalizes %j", (source, display) => {
    const html = `<table><tr><td>HỌC KỲ 2. MÃ HỌC KỲ 252</td></tr>${gradeTableRow(source)}</table>`;
    const grades = parseGradesHtml(html);
    const transcript = parseTranscriptHtml(html);

    expect(grades.rows.map((row) => row.courseCode)).toEqual([display]);
    expect(grades.terms[0]?.rows.map((row) => row.courseCode)).toEqual([display]);
    expect(transcript.terms[0]?.rows.map((row) => row.courseCode)).toEqual([display]);
  });

  it.each(["INT", "I3103", "INT 31", "INT 31030", "INT 3103 trailing prose"])("keeps malformed token %j out of grades", (source) => {
    expect(parseGradesHtml(`<table>${gradeTableRow(source)}</table>`).rows).toEqual([]);
  });
});

describe("spaced VNU syllabus course codes", () => {
  it.each([
    ["INT3103", "INT3103"],
    [" INT&nbsp;&nbsp;3103 ", "INT 3103"],
    ["INT\n<span> </span>3103B", "INT 3103B"],
  ])("retains and normalizes %j", (source, display) => {
    expect(parseSyllabusHtml(`<table>${syllabusTableRow(source)}</table>`)[0]).toMatchObject({
      courseCode: display,
      courseName: "Synthetic Syllabus",
    });
  });

  it.each(["INT", "1NT3103", "INT 31", "INT 3103 trailing prose"])("skips malformed token %j", (source) => {
    expect(parseSyllabusHtml(`<table>${syllabusTableRow(source)}</table>`)).toEqual([]);
  });
});

describe("VNU exam composite parsing", () => {
  it.each([
    ["252-INT3103", { termCode: "252", courseCode: "INT3103", classNo: undefined }],
    ["252-INT 3103 6", { termCode: "252", courseCode: "INT 3103", classNo: "6" }],
    ["252-INT&nbsp;3103&nbsp;15", { termCode: "252", courseCode: "INT 3103", classNo: "15" }],
    ["252-INT<span> </span>3103A CN7", { termCode: "252", courseCode: "INT 3103A", classNo: "CN7" }],
    ["241-FLF1107-01", { termCode: "241", courseCode: "FLF1107", classNo: "01" }],
    ["252-INT 3103--71", { termCode: "252", courseCode: "INT 3103", classNo: "71" }],
  ])("splits %j without compacting display", (source, expected) => {
    const [exam] = parseExamsHtml(`<table>${examTableRow(source)}</table>`);
    const [catalog] = parseExamCatalogHtml(`<table>${examTableRow(source, "SYNTHETIC-CLASS-ID")}</table>`);

    expect(exam).toMatchObject(expected);
    expect(catalog).toMatchObject({ classId: "SYNTHETIC-CLASS-ID", ...expected });
  });

  it.each([
    "25-INT 3103 6",
    "252-INT 31 6",
    "252-1NT 3103 6",
    "252-INT 3103 final group",
    "252-INT 3103 6 extra",
  ])("does not invent a class from malformed composite %j", (source) => {
    const [exam] = parseExamsHtml(`<table>${examTableRow(source)}</table>`);
    const [catalog] = parseExamCatalogHtml(`<table>${examTableRow(source, "SYNTHETIC-CLASS-ID")}</table>`);

    expect(exam).toMatchObject({ termCode: undefined, courseCode: source, classNo: undefined });
    expect(catalog?.classNo).toBeUndefined();
    if (source.startsWith("252-")) {
      expect(catalog).toMatchObject({ termCode: "252", courseCode: source.slice(4) });
    } else {
      expect(catalog).toMatchObject({ termCode: undefined, courseCode: source });
    }
  });

  it("still requires catalog row evidence and minimum columns", () => {
    expect(parseExamCatalogHtml(`<table>${examTableRow("252-INT 3103 6")}</table>`)).toEqual([]);
    expect(parseExamCatalogHtml(`<table><tr><td><input name="hidCrdID" value="SYNTHETIC-CLASS-ID"></td><td>252-INT 3103 6</td></tr></table>`)).toEqual([]);
  });
});
```

- [ ] **Step 6: Run parser tests to verify RED**

Run:

```powershell
pnpm --filter @hyeboard/university-adapters exec vitest run src/vnu/parser.test.ts
```

Expected: FAIL because current grade/syllabus gates require contiguous codes, exam/catalog parsing mis-splits `INT 3103`, and current exam parsing accepts arbitrary trailing class prose.

- [ ] **Step 7: Implement the shared display boundary and anchored grammar**

At the top of `packages/university-adapters/src/vnu/parser.ts`, add:

```ts
import { collapseVnuCourseCodeDisplay } from "./course-code";
```

Replace the final collapse in `decodeEntities`:

```ts
function decodeEntities(text: string): string {
  return collapseVnuCourseCodeDisplay(text.replace(HTML_ENTITY_RE, (entity) => {
    const token = entity.slice(1, -1).toLowerCase();
    if (token === "nbsp") return " ";
    if (token === "amp") return "&";
    if (token === "lt") return "<";
    if (token === "gt") return ">";
    if (token === "quot") return '"';

    const numericMatch = token.match(/^#(?:(x)([0-9a-f]+)|(\d+))$/i);
    if (!numericMatch) return entity;

    const codePoint = Number.parseInt(numericMatch[2] ?? numericMatch[3], numericMatch[1] ? 16 : 10);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return entity;
    return String.fromCodePoint(codePoint);
  }));
}
```

Keep `stripTags(html.replace(/<[^>]+>/g, " "))` unchanged: tags become separators before one-pass entity decoding and display collapse.

Add these parser-local grammar constants and functions immediately after `tdCells`:

```ts
const VNU_COURSE_CODE_SOURCE = String.raw`[A-Za-zĐđ]{2,6} *\d{3,4}[A-Za-zĐđ]*`;
const VNU_CLASS_TOKEN_SOURCE = String.raw`(?:\d+|[A-Za-zĐđ]+\d+)`;
const VNU_COURSE_CODE_RE = new RegExp(`^${VNU_COURSE_CODE_SOURCE}$`);
const VNU_EXAM_COMPOSITE_RE = new RegExp(
  `^(\\d{3})-(${VNU_COURSE_CODE_SOURCE})(?:[ -]+(${VNU_CLASS_TOKEN_SOURCE}))?$`,
);

function isVnuCourseCode(value: string): boolean {
  return VNU_COURSE_CODE_RE.test(value);
}

function parseExamComposite(
  raw: string,
  looseTermFallback: boolean,
): { termCode?: string; courseCode: string; classNo?: string } {
  const strict = raw.match(VNU_EXAM_COMPOSITE_RE);
  if (strict) {
    const [, termCode, courseCode, classNo] = strict;
    return { termCode, courseCode, classNo: classNo || undefined };
  }

  if (looseTermFallback) {
    const loose = raw.match(/^(\d{3})-(.+)$/);
    if (loose) return { termCode: loose[1], courseCode: loose[2].trim() };
  }
  return { courseCode: raw };
}
```

This class token is evidence-based, not speculative: current `har-notes.md` and `types.ts` document plain digits (`6`, `15`, `71`), zero-padded digits after a dash (`01`), and letter-prefixed alphanumeric groups (`CN7`). Spaces and repeated hyphens remain separators. Slash forms and arbitrary prose are not parser evidence and therefore remain fallback text without a fabricated `classNo`.

Replace the grade gate:

```ts
if (cells.length >= 7 && isVnuCourseCode(cells[1] ?? "")) {
```

Store the already-normalized cell unchanged:

```ts
courseCode: cells[1] ?? "",
```

In `parseExamsHtml`, replace `codeMatch` and its three output fields:

```ts
const code = parseExamComposite(examCode, false);
```

```ts
termCode: code.termCode,
courseCode: code.courseCode,
classNo: code.classNo,
```

Delete `parseCatalogCode`. In `parseExamCatalogHtml`, replace its call with:

```ts
const { termCode, courseCode, classNo } = parseExamComposite(cells[1] ?? "", true);
```

Replace the syllabus gate and stored value:

```ts
if (!isVnuCourseCode(codeText)) continue;
```

```ts
courseCode: codeText,
```

Do not export the regex, store comparison keys, compact display values, or alter mapper IDs.

- [ ] **Step 8: Run focused adapter GREEN checks**

Run:

```powershell
pnpm --filter @hyeboard/university-adapters exec vitest run src/vnu/course-code.test.ts src/vnu/parser.test.ts
pnpm --filter @hyeboard/university-adapters typecheck
```

Expected: both Vitest files PASS; adapter typecheck exits `0`. Existing entity-decoding and session-expiry tests remain green.

- [ ] **Step 9: Review parser ambiguity and malformed fallbacks**

Inspect the focused diff:

```powershell
git diff -- packages/university-adapters/src/vnu/course-code.ts packages/university-adapters/src/vnu/course-code.test.ts packages/university-adapters/src/vnu/parser.ts packages/university-adapters/src/vnu/parser.test.ts
git diff --check -- packages/university-adapters/src/vnu/course-code.ts packages/university-adapters/src/vnu/course-code.test.ts packages/university-adapters/src/vnu/parser.ts packages/university-adapters/src/vnu/parser.test.ts
```

Expected: `252-INT 3103 6` has one unambiguous strict split; attached alphabetic suffix remains course data; separated observed token becomes class data; malformed exam keeps the raw cell; malformed catalog keeps only its existing recognizable three-digit prefix/remainder split and never gains `classNo`. No mapper, schema, UET, Mock, or relogin file appears.

- [ ] **Step 10: Commit Task 1 only**

```powershell
git add packages/university-adapters/src/vnu/course-code.ts packages/university-adapters/src/vnu/course-code.test.ts packages/university-adapters/src/vnu/parser.ts packages/university-adapters/src/vnu/parser.test.ts
git diff --cached --name-only
git commit -m "fix(vnu): parse spaced course codes"
```

Expected staged paths: exactly the four Task 1 files.

---

### Task 2: Add University-Aware Course Search and Preserve Exports

**Files:**
- Create: `apps/web/src/lib/university-course-search.ts`
- Create: `apps/web/src/lib/university-course-search.test.ts`
- Modify: `apps/web/src/pages/lookup.tsx:1-55,146`
- Modify: `apps/web/src/pages/documents.tsx:1-67`
- Modify: `apps/web/src/lib/data-export.test.ts:118-398`
- Modify: `apps/web/tests/smoke.spec.ts:95-165,1824-1920,2306-2335`

- [ ] **Step 1: Write RED web filter tests**

Create `apps/web/src/lib/university-course-search.test.ts`:

```ts
import type { DocumentItem } from "@hyeboard/schemas";
import type { VnuExamCatalogRow } from "@hyeboard/university-adapters/src/vnu/types";
import { describe, expect, it } from "vitest";
import { filterCatalogRowsByUniversity, filterDocumentsByUniversity } from "./university-course-search";

const catalogRows: VnuExamCatalogRow[] = [{
  classId: "SYNTHETIC-CLASS-ID",
  termCode: "252",
  courseCode: "INT 3103",
  classNo: "CN7",
  courseName: "Synthetic Search Systems",
  examDate: "31/12/2099",
}];

const documents: DocumentItem[] = [{
  id: "synthetic-document",
  name: "INT 3103 — Synthetic Syllabus",
  courseCode: "INT 3103",
}];

describe("VNU class filtering", () => {
  it.each(["INT3103", "INT 3103", " int\u00a03103 "])("matches %j against preserved display", (query) => {
    expect(filterCatalogRowsByUniversity(catalogRows, query, "", "vnu")).toEqual(catalogRows);
  });

  it("keeps class-number matching exact apart from edge trim and case", () => {
    expect(filterCatalogRowsByUniversity(catalogRows, "INT3103", " cn7 ", "vnu")).toEqual(catalogRows);
    expect(filterCatalogRowsByUniversity(catalogRows, "INT3103", "CN 7", "vnu")).toEqual([]);
    expect(filterCatalogRowsByUniversity(catalogRows, "INT3103", "CN", "vnu")).toEqual([]);
  });

  it.each(["mock", "uet"])("preserves existing spaced substring semantics for %s", (universityId) => {
    expect(filterCatalogRowsByUniversity(catalogRows, "INT3103", "", universityId)).toEqual([]);
    expect(filterCatalogRowsByUniversity(catalogRows, " INT 3103 ", "", universityId)).toEqual(catalogRows);
  });
});

describe("university-aware document filtering", () => {
  it.each([
    ["mock", ""],
    ["mock", " \t\n"],
    ["uet", ""],
    ["uet", " \t\n"],
    ["vnu", ""],
    ["vnu", " \t\n"],
  ])("returns the original items reference for %s query %j", (universityId, query) => {
    expect(filterDocumentsByUniversity(documents, query, universityId)).toBe(documents);
  });

  it.each(["INT3103", "INT 3103"])("matches VNU course query %j", (query) => {
    expect(filterDocumentsByUniversity(documents, query, "vnu")).toEqual(documents);
  });

  it("retains VNU document-name substring search", () => {
    expect(filterDocumentsByUniversity(documents, "synthetic syllabus", "vnu")).toEqual(documents);
  });

  it.each(["uet", "mock"])("retains combined lowercase substring semantics for %s", (universityId) => {
    expect(filterDocumentsByUniversity(documents, "int 3103", universityId)).toEqual(documents);
    expect(filterDocumentsByUniversity(documents, "INT3103", universityId)).toEqual([]);
    expect(filterDocumentsByUniversity(documents, "synthetic syllabus", universityId)).toEqual(documents);
  });
});
```

- [ ] **Step 2: Run the filter test to verify RED**

Run:

```powershell
pnpm --filter @hyeboard/web exec vitest run src/lib/university-course-search.test.ts
```

Expected: FAIL because `./university-course-search` does not exist.

- [ ] **Step 3: Implement the web data-boundary helper**

Create `apps/web/src/lib/university-course-search.ts`:

```ts
import type { DocumentItem } from "@hyeboard/schemas";
import { vnuCourseCodeKey } from "@hyeboard/university-adapters/src/vnu/course-code";
import type { VnuExamCatalogRow } from "@hyeboard/university-adapters/src/vnu/types";

export function filterCatalogRowsByUniversity(
  rows: readonly VnuExamCatalogRow[],
  courseCode: string,
  classNo: string,
  universityId: string,
): VnuExamCatalogRow[] {
  const classNoQuery = classNo.trim().toUpperCase();
  if (universityId === "vnu") {
    const codeQuery = vnuCourseCodeKey(courseCode);
    return rows.filter((row) => {
      if (codeQuery && !vnuCourseCodeKey(row.courseCode).includes(codeQuery)) return false;
      if (classNoQuery && (row.classNo ?? "").toUpperCase() !== classNoQuery) return false;
      return true;
    });
  }

  const codeQuery = courseCode.trim().toUpperCase();
  return rows.filter((row) => {
    if (codeQuery && !row.courseCode.toUpperCase().includes(codeQuery)) return false;
    if (classNoQuery && (row.classNo ?? "").toUpperCase() !== classNoQuery) return false;
    return true;
  });
}

export function filterDocumentsByUniversity(
  items: DocumentItem[] | undefined,
  query: string,
  universityId: string,
): DocumentItem[] | undefined {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return items;
  const lowercaseQuery = trimmedQuery.toLowerCase();

  if (universityId !== "vnu") {
    return items?.filter((item) => `${item.name} ${item.courseCode ?? ""}`.toLowerCase().includes(lowercaseQuery));
  }

  const codeQuery = vnuCourseCodeKey(trimmedQuery);
  return items?.filter((item) => (
    item.name.toLowerCase().includes(lowercaseQuery)
    || Boolean(item.courseCode && vnuCourseCodeKey(item.courseCode).includes(codeQuery))
  ));
}
```

Both helper branches select VNU behavior only when `universityId === "vnu"`. Catalog filtering for every other university remains byte-for-behavior equivalent to the deleted local function: `courseCode.trim().toUpperCase()` against `row.courseCode.toUpperCase().includes(codeQuery)`, with unchanged trim/uppercase exact class-number matching. Document filtering accepts the mutable `DocumentItem[] | undefined` shape supplied by `docs.data`, returns that exact reference for every empty trimmed query, and returns the mutable array produced by `filter` otherwise. This keeps `{ ...docs, data: filteredDocs }` compatible with `MiniPanel`'s `T[] | undefined` contract without casts or `MiniPanel` changes. It does not normalize stored `DocumentItem` values or globally alter shared components.

- [ ] **Step 4: Wire lookup and documents without touching reverse class-ID behavior**

In `apps/web/src/pages/lookup.tsx`, add:

```ts
import { filterCatalogRowsByUniversity } from "@/lib/university-course-search";
```

Delete only the local `filterCatalogRows` function at lines 37-45. Keep `filterCatalogRowsByClassId` unchanged. Replace the forward call with:

```ts
const filteredRows = filterCatalogRowsByUniversity(catalogQuery.data ?? [], courseCode, classNo, state.universityId);
```

In `apps/web/src/pages/documents.tsx`, add:

```ts
import { filterDocumentsByUniversity } from "@/lib/university-course-search";
```

Replace `filteredDocs` with:

```ts
const filteredDocs = filterDocumentsByUniversity(docs.data, docSearch, state.universityId);
```

- [ ] **Step 5: Run web filter GREEN checks**

Run:

```powershell
pnpm --filter @hyeboard/web exec vitest run src/lib/university-course-search.test.ts
pnpm --filter @hyeboard/web typecheck
```

Expected: filter suite PASS, including exact-reference checks for empty/whitespace Mock, UET, and VNU document queries; web typecheck exits `0`. `docs.data`, `filteredDocs`, the query spread, and `MiniPanel` remain type-compatible without casts. Deep import resolves through the existing workspace package pattern already used by `lookup.tsx` for VNU types and exam terms.

- [ ] **Step 6: Add pass-through export characterization assertions**

Append inside `describe("export models", ...)` in `apps/web/src/lib/data-export.test.ts`:

```ts
it("preserves spaced VNU course display in class, grades, and transcript JSON and CSV", () => {
  const spacedTerm: ExportDerivedTerm = {
    ...term,
    courses: [{ courseCode: "INT 3103", courseName: "Synthetic Parsing", credits: 3 }],
  };
  const models = [
    createClassLookupExport({
      surface: "class-forward",
      universityId: "vnu",
      query: { mode: "course-and-class", value: "INT3103 / 6" },
      result: { classCode: "INT 3103", classNumber: "6", classId: "SYNTHETIC-CLASS-ID", courseName: "Synthetic Parsing" },
    }),
    createGradesExport({ surface: "grades-page", universityId: "vnu", derivedTerms: [spacedTerm] }),
    createTranscriptExport({
      universityId: "vnu",
      query: { mode: "stdId", value: "SYNTHETIC-TARGET" },
      derivedTerms: [spacedTerm],
    }),
  ];

  for (const model of models) {
    const json = serializeExportJson(model);
    const csv = parseRfc4180Csv(serializeExportCsv(model));
    const header = csv.rows[0]!;
    const classCode = header.indexOf("class_code");
    const courseCode = header.indexOf("course_code");

    expect(json).toContain("INT 3103");
    expect(csv.rows.slice(1).some((row) => row[classCode] === "'INT 3103" || row[courseCode] === "'INT 3103")).toBe(true);
  }
});
```

Run before changing production export code:

```powershell
pnpm --filter @hyeboard/web exec vitest run src/lib/data-export.test.ts
```

Expected: PASS immediately. This is characterization evidence that serializers are already pass-through; if it fails, fix the test fixture or expose an existing compaction site, but do not add normalization to `data-export.ts`.

- [ ] **Step 7: Preserve the existing Mock browser fixture and add an explicit VNU lookup mode**

Leave `openMockedLookup` and `test("lookup successful single results export both formats without refetch and clear stale actions", ...)` unchanged, including their `SYN9900` course fixture, Mock `universityId`, reverse lookup, transcript rows, and export assertions. The unit matrix above supplies the separate Mock regression: stored `INT 3103` matches spaced input but not compact `INT3103` under existing substring semantics.

Add a small shell-context helper after `openMockedLookup`:

```ts
async function switchDemoShellToVnu(page: import("@playwright/test").Page): Promise<void> {
  await loginDemo(page);
  await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<Record<string, unknown>>;
    const activeAccountId = localStorage.getItem("hyeboard.activeAccountId");
    localStorage.setItem("hyeboard.accounts", JSON.stringify(accounts.map((account) => (
      account.id === activeAccountId ? { ...account, universityId: "vnu" } : account
    ))));
    localStorage.setItem("hyeboard.universityId", "vnu");
    window.dispatchEvent(new CustomEvent("hyeboard:account-switched"));
  });
}
```

The demo login exists only to obtain the local authenticated app shell. The helper then changes both the exact active account's `universityId` and the app university context before feature navigation; it is not a Mock-context proof.

Add an explicit lookup helper:

```ts
async function openMockedVnuLookup(page: import("@playwright/test").Page): Promise<() => number> {
  let examRequests = 0;
  await page.route("**/api/vnu/raw/exams**", async (route) => {
    examRequests += 1;
    const html = `<table><tr><td>1</td><td>252-INT&nbsp;3103-CN7</td><td>Synthetic Search Systems</td><td>31/12/2099</td><td>9(09:00)</td><td>Synthetic</td><td>LAB-SYNTHETIC</td><td>1</td><td><input name="hidCrdID" value="SYNTHETIC-VNU-CLASS-ID"></td></tr></table>`;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { html }, error: null }) });
  });
  await page.route("**/api/vnu/raw/profile", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { html: "<main></main>" }, error: null }) });
  });
  await switchDemoShellToVnu(page);
  await page.goto("/lookup");
  await expect(page.getByRole("heading", { name: "Lookup", exact: true })).toBeVisible();
  return () => examRequests;
}
```

For class catalog, intercept only the needed exams payload. The generic empty profile response is a defensive intercept if that route is requested; it contains no name, student code, internal ID, or other synthetic identity field.

Add this separate test beside the existing successful lookup export test:

```ts
test("VNU class lookup matches compact and spaced codes and exports preserved display", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  const examRequests = await openMockedVnuLookup(page);
  await page.getByLabel("Course code").fill("INT3103");
  await page.getByLabel("Term").click();
  await page.getByRole("option", { name: "Semester 2, 2025–2026 (supplementary)" }).click();
  const row = page.getByTestId("lookup-results").locator(".list-row").filter({ hasText: "Synthetic Search Systems" });
  await expect(row).toContainText("INT 3103 · CN7");
  const requestsAfterCompactSearch = examRequests();
  await page.getByLabel("Course code").fill(" INT 3103 ");
  await expect(row).toContainText("INT 3103 · CN7");
  expect(examRequests()).toBe(requestsAfterCompactSearch);

  const exported = await expectExportFormats(page, "class-forward", apiRequestCount, {
    sourcePath: "/api/vnu/raw/exams",
    assertCsv: expectClassCsvMatchesJson,
  });
  expect(exported).toMatchObject({
    surface: "class-forward",
    universityId: "vnu",
    results: [{ classResult: { classCode: "INT 3103", classNumber: "CN7", classId: "SYNTHETIC-VNU-CLASS-ID" } }],
  });
});
```

- [ ] **Step 8: Add an explicit VNU documents browser flow without identity fixtures**

Add this helper after `openMockedVnuLookup`:

```ts
async function openMockedVnuDocuments(page: import("@playwright/test").Page): Promise<() => number> {
  let syllabusRequests = 0;
  await page.route("**/api/vnu/raw/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/vnu/raw/syllabus") syllabusRequests += 1;
    const html = path === "/api/vnu/raw/syllabus"
      ? `<table><tr><td>1</td><td>INT&nbsp;3103</td><td>Synthetic Syllabus</td><td>3</td><td><a href="synthetic.pdf">PDF</a></td><td></td><td>1 KB</td><td>31/12/2099</td></tr></table>`
      : "<main></main>";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { html }, error: null }) });
  });
  await switchDemoShellToVnu(page);
  await page.goto("/documents");
  await expect(page.getByText("INT 3103 — Synthetic Syllabus")).toBeVisible();
  return () => syllabusRequests;
}
```

Add this test near the existing document route coverage:

```ts
test("VNU spaced course codes match compact document searches without refetch", async ({ page }) => {
  const syllabusRequests = await openMockedVnuDocuments(page);
  const search = page.getByLabel("Search documents");
  const document = page.getByText("INT 3103 — Synthetic Syllabus");

  await search.fill("INT3103");
  await expect(document).toBeVisible();
  const requestsAfterCompactSearch = syllabusRequests();
  await search.fill("INT 3103");
  await expect(document).toBeVisible();
  await search.fill("Synthetic Syllabus");
  await expect(document).toBeVisible();
  expect(syllabusRequests()).toBe(requestsAfterCompactSearch);
});
```

Both VNU helpers switch the exact active account and app context before navigation. Raw responses contain only course/document data plus generic empty HTML; no profile field, person name, student code, internal ID, credential, or portal login is introduced.

- [ ] **Step 9: Run web unit/typecheck and targeted serial Playwright on both projects**

Run:

```powershell
pnpm --filter @hyeboard/web exec vitest run src/lib/university-course-search.test.ts src/lib/data-export.test.ts
pnpm --filter @hyeboard/web typecheck
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --workers=1 --grep "lookup successful single results export both formats|VNU class lookup matches compact and spaced codes and exports preserved display|VNU spaced course codes match compact document searches"
```

Expected: both Vitest files PASS; web typecheck exits `0`; Playwright reports six passes total—three exact named tests in both `chromium` and `mobile-safari`—with one worker and no API count changes during filtering or download.

If Playwright attaches to stale servers on ports 5173/8787, stop only those worktree test servers, then rerun the same command. Do not start jobs through `Start-Job` or `Start-Process`.

- [ ] **Step 10: Review VNU-only web scope**

```powershell
git diff -- apps/web/src/lib/university-course-search.ts apps/web/src/lib/university-course-search.test.ts apps/web/src/pages/lookup.tsx apps/web/src/pages/documents.tsx apps/web/src/lib/data-export.test.ts apps/web/tests/smoke.spec.ts
git diff --check -- apps/web/src/lib/university-course-search.ts apps/web/src/lib/university-course-search.test.ts apps/web/src/pages/lookup.tsx apps/web/src/pages/documents.tsx apps/web/src/lib/data-export.test.ts apps/web/tests/smoke.spec.ts
```

Expected: catalog and document course-code comparison use `vnuCourseCodeKey` only when `universityId === "vnu"`; ClassResolver passes `state.universityId` explicitly; class number remains edge-trimmed case-insensitive exact; reverse class ID remains exact. Empty or whitespace-only document queries return the exact original `docs.data` reference for Mock, UET, and VNU, preserving current allocation behavior and `MiniPanel` type compatibility. Mock/UET catalog lookup remains the original trim/uppercase substring comparison, proven by spaced-match and compact-nonmatch regressions; Mock/UET document search retains combined lowercase substring behavior. Existing Mock E2E data/assertions remain unchanged; separate browser helpers prove VNU context and VNU export identity. Rendering and exports keep `INT 3103`; no serializer or API function changes.

- [ ] **Step 11: Commit Task 2 only**

```powershell
git add apps/web/src/lib/university-course-search.ts apps/web/src/lib/university-course-search.test.ts apps/web/src/pages/lookup.tsx apps/web/src/pages/documents.tsx apps/web/src/lib/data-export.test.ts apps/web/tests/smoke.spec.ts
git diff --cached --name-only
git commit -m "fix(web): match spaced VNU course codes"
```

Expected staged paths: exactly the six Task 2 files.

---

### Task 3: Run Full Verification and Privacy Review

**Files:**
- Verify only: Task 1-2 implementation files plus this plan
- Do not modify: source, tests, spec, generated output, lockfile, or runtime configuration during this task

- [ ] **Step 1: Re-run focused adapter and web tests**

```powershell
pnpm --filter @hyeboard/university-adapters exec vitest run src/vnu/course-code.test.ts src/vnu/parser.test.ts
pnpm --filter @hyeboard/web exec vitest run src/lib/university-course-search.test.ts src/lib/data-export.test.ts
```

Expected: all focused suites PASS.

- [ ] **Step 2: Re-run targeted serial Playwright across both configured projects**

```powershell
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --workers=1 --grep "lookup successful single results export both formats|VNU class lookup matches compact and spaced codes and exports preserved display|VNU spaced course codes match compact document searches"
```

Expected: six passes total across `chromium` and `mobile-safari`; no retries or failures.

- [ ] **Step 3: Run full repository build and tests**

```powershell
pnpm build
pnpm test
```

Expected: web, Worker, Node package, and all workspace checks/tests exit `0`. No deployment command follows.

- [ ] **Step 4: Check diff hygiene and exact path allowlist**

```powershell
$BASE_SHA = "ba8d4c8b01990e00c2b8b2f67f9320fe40ade5b3"
git diff --check "$BASE_SHA"
git diff --name-only "$BASE_SHA"
git status --short
```

Expected implementation paths, plus this plan:

```text
apps/web/src/lib/data-export.test.ts
apps/web/src/lib/university-course-search.test.ts
apps/web/src/lib/university-course-search.ts
apps/web/src/pages/documents.tsx
apps/web/src/pages/lookup.tsx
apps/web/tests/smoke.spec.ts
docs/superpowers/plans/2026-07-28-vnu-spaced-course-code.md
packages/university-adapters/src/vnu/course-code.test.ts
packages/university-adapters/src/vnu/course-code.ts
packages/university-adapters/src/vnu/parser.test.ts
packages/university-adapters/src/vnu/parser.ts
```

`git diff --check` emits no output. The baseline-to-HEAD diff includes the reviewed plan commit plus both implementation commits. `git status --short` emits no output after implementation commits. No source outside this allowlist, approved spec, lockfile, build output, Playwright report, or main-worktree path appears.

- [ ] **Step 5: Scan added lines for secrets, credentials, PII-shaped identities, and unsafe artifacts**

```powershell
$BASE_SHA = "ba8d4c8b01990e00c2b8b2f67f9320fe40ade5b3"
$added = git diff --unified=0 "$BASE_SHA" | Where-Object { $_ -match '^\+' -and $_ -notmatch '^\+\+\+' }
$added | Select-String -Pattern '(?i)(authorization\s*:|cookie\s*:|bearer\s+[A-Za-z0-9._-]+|password\s*[=:]|sessiontoken\s*[=:])'
$added | Select-String -Pattern '(?<!\d)(\d{8}|\d{11})(?!\d)'
git diff --name-only "$BASE_SHA" | Select-String -Pattern '(?i)(\.har$|\.env|\.dev\.vars|playwright-report|test-results|\.wrangler|dist/)'
```

Expected: all three scans emit no output. Generic course code `INT 3103`, synthetic nonnumeric class/document IDs, dates, and existing test constants are not student identity data. If any match appears, inspect and remove newly introduced sensitive content rather than allowlisting it casually.

- [ ] **Step 6: Final semantic review**

Confirm all statements:

- display collapse replaces tags with separators, decodes supported entities once, collapses ECMAScript `\s` runs to ASCII space, and trims;
- comparison key trims, removes every ECMAScript `\s`, uppercases, and leaves punctuation/zero-width formats untouched;
- grades, grouped terms, cross transcript, syllabus, exams, and catalog preserve display strings;
- course grammar is 2-6 ASCII letters or `Đ/đ`, optional normalized internal spaces, 3-4 digits, then optional attached letters;
- class grammar contains only observed digits or letter-prefixed alphanumeric tokens, with existing whitespace/hyphen separators;
- malformed exam fallback keeps the raw cell; malformed catalog fallback keeps only the existing three-digit term/remainder split; neither invents `classNo`;
- forward lookup receives explicit university context and uses VNU key substring matching only for `vnu`; Mock/UET retain the exact prior trim/uppercase substring behavior; class number and reverse class ID retain existing semantics;
- VNU document names use existing lowercase substring matching, while only the course-code branch uses VNU keys;
- empty or whitespace-only document queries return the exact original `DocumentItem[] | undefined` reference for every university, with no copied array allocation or cast at the `DocumentsPage`/`MiniPanel` boundary;
- UET/Mock parser and document semantics, shared schemas, mappers, serializers, Worker routes, and automatic relogin Task 7/8 behavior remain unchanged;
- JSON/CSV result fields and UI show `INT 3103`; query metadata may retain entered `INT3103` or `INT 3103`;
- no user-facing copy, i18n key, log, telemetry, raw HTML payload expansion, identity, credential, token, push, or deployment was added.

This plan is already reviewed and committed before Task 1. After Task 3, stop. Report both implementation commit hashes and verification results. Do not create a verification-only commit, push, deploy, merge, amend, rebase, change the branch base, or touch the main worktree.
