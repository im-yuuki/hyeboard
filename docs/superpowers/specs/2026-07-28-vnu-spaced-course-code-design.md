# VNU Spaced Course Code Design

Status: approved for implementation planning
Date: 2026-07-28
Baseline: `feature/vnu-automatic-relogin` at `fedda4dbf39bb16b1c519875f49944a8de45b0db`

## Context

VNU's daotao portal can render a course code with visible internal whitespace, such as `INT 3103`, while users may search for the same code as `INT3103`. Hyeboard must preserve the portal's visible form without making lookup depend on that formatting difference.

This change is VNU-specific. UET and Mock parsing, display, search, and export behavior remain unchanged. Shared schemas already represent course codes as unrestricted strings, so no global semantic normalization or schema change is required. A type-only clarification is permitted only if implementation discovers exact current code evidence that requires one.

## Problem

Current VNU row gates expect the alphabetic prefix and numeric body to be contiguous. Grades, cross-transcript, and syllabus rows can therefore be discarded when the portal renders internal whitespace. Exam and catalog composite parsing can also split a spaced course code incorrectly, treating part of the code as a class number.

Current browser filtering compares uppercased strings while retaining internal whitespace. A compact query therefore does not match a spaced portal value, and the inverse also fails. Compacting the stored value would make matching work but would incorrectly change UI and export output.

## Goals

- Keep each valid VNU course row when its course token contains portal-visible internal whitespace.
- Preserve one stable display value derived from portal text for UI and exports.
- Make compact and spaced VNU course-code queries resolve the same records.
- Split verified exam/catalog composites into term, course, and optional class components without guessing.
- Keep malformed-row fallback behavior fail-closed.
- Add focused parser, browser search, export, and non-regression coverage.

## Non-goals

- Canonicalizing stored, displayed, or exported course codes to compact form.
- Changing course-code semantics in shared schemas or other university adapters.
- Adding fuzzy matching beyond case and whitespace equivalence.
- Rewriting unrelated VNU parsers.
- Changing term-code, class-number, class-ID, or exam semantics.
- Adding user-facing copy, logging, telemetry, deployment, or automatic rollout.

## Current failure modes

1. `parseGradesHtml` accepts only a contiguous letter-plus-digit prefix. A valid row containing `INT 3103` fails the row gate and disappears from both Grades and cross transcripts.
2. `parseSyllabusHtml` applies the same contiguous-token assumption and drops a matching syllabus row.
3. `parseExamsHtml` and the exam-catalog composite parser recognize a contiguous course token. In a value such as `252-INT 3103 6`, existing matching can fail or treat `3103 6` as the class remainder instead of parsing term `252`, course `INT 3103`, and class `6`.
4. Forward class lookup compares `row.courseCode.toUpperCase()` against a trimmed uppercase query without removing internal whitespace.
5. Documents search combines the name and course code into one lowercase string. Compact and spaced forms are not equivalent in its course-code branch.
6. Export serializers already pass through parsed course/class values. Any parser-side compaction would leak into JSON and CSV and lose the portal-visible form.

## Approved semantics

Each VNU course code has two representations with separate purposes:

- **Display value:** decoded portal text with HTML-originated whitespace collapsed to single ASCII spaces and edge whitespace removed. This value is stored in parsed rows, mapped through existing API models, rendered in the UI, and emitted by JSON/CSV exports.
- **Comparison key:** an ephemeral uppercase string with all ECMAScript Unicode whitespace removed. This value is used only when comparing VNU course codes.

For example, inputs `INT3103`, `INT 3103`, and `INT  3103` produce the same comparison key, `INT3103`. After HTML normalization, `INT&nbsp;3103`, `INT&#160;3103`, `INT\n3103`, and `INT<span> </span>3103` display as `INT 3103` and compare as `INT3103`.

The supplied `INT 3103` and `INT3103` examples are course-code examples, not student data. All additional fixtures use conspicuously synthetic courses, identities, and class identifiers.

## Normalization algorithm

### Portal display normalization

Reuse one VNU HTML-text boundary for table-cell text:

1. Replace tags with a text separator so adjacent text nodes do not concatenate accidentally.
2. Decode the parser's supported named and numeric HTML entities once.
3. Collapse every resulting ECMAScript whitespace run (`\s`, covering ASCII whitespace, line terminators, NBSP, and other Unicode whitespace recognized by JavaScript) to one ASCII space (`U+0020`).
4. Trim leading and trailing whitespace.

This step happens before course-token parsing. It intentionally normalizes presentation whitespace caused by entities, tags, tabs, CR/LF, or repeated spaces, but does not remove the visible separator inside the stored value. Zero-width format characters that JavaScript does not classify as whitespace are not silently removed.

### VNU comparison key

One VNU-specific pure helper accepts a string and returns:

```text
uppercase(input with every ECMAScript Unicode whitespace code point removed)
```

The helper has no HTML decoding, parsing, storage, localization, React, or network responsibility. Callers pass already parsed display values or user input. It must not mutate source values or become a global schema transform.

Case conversion follows existing JavaScript uppercase behavior. No punctuation removal, diacritic folding, substring tokenization, typo tolerance, or numeric rewriting is added.

## Parsing contracts by endpoint and table

### Grades and cross transcript

`ListPoint/listpoint_Brc1.asp` remains the shared source for own Grades and cross transcripts. The row gate must accept a complete VNU course token whose verified shape is:

```text
letter prefix (2-6 letters, including Đ)
optional internal normalized spaces
numeric body (3-4 digits)
optional contiguous alphabetic suffix
```

The parser stores the whole normalized cell text as `courseCode`; it does not store the compact comparison key. A valid spaced row must enter both the flat grades list and its term group, then flow unchanged into transcript rows. Rows that do not contain a complete recognized course token retain current skip behavior.

### Syllabus listing

`SiteManager/Syllabus/default.asp` uses the same course-token grammar and display normalization. Internal whitespace no longer causes a row to be dropped. The mapper continues to use the preserved course code in the document ID input, document name, `courseCode` field, UI detail, and exports; it must not substitute the comparison key.

### Exam schedule and class catalog

`StdExamination.asp` composite cells use the verified structure:

```text
termCode-courseCode, followed optionally by a separator and classNo
```

Parsing is anchored to the normalized full cell. `termCode` remains three digits. `courseCode` uses the grammar above. An optional `classNo` begins only after the numeric body and optional contiguous alphabetic suffix have completed, separated by normalized whitespace or the already-supported class separator. Thus `252-INT 3103 6` parses as:

```text
termCode: 252
courseCode: INT 3103
classNo: 6
```

Whitespace between the letter prefix and numeric body belongs to the course code. Whitespace after the completed numeric body or contiguous suffix separates the optional class number. A suffix attached directly to the numeric body remains part of the course code; a later separated token is the class number. Repeated spaces have already collapsed before this split.

The exam parser keeps using its existing data-row evidence. The catalog parser additionally requires the existing hidden class ID and minimum column shape. These fields distinguish real rows; the parser must not infer missing classes from unrelated columns.

If the complete verified structure does not match, preserve existing fallback behavior: retain only components supported by the recognizable prefix/remainder, omit an unproven class number, or skip the row where current row validation requires it. Never fabricate a course code, term, or class. Do not reinterpret arbitrary trailing prose as a class number unless the verified course portion and separator were recognized first.

## Search and export behavior

### Class lookup

Forward VNU class filtering compares the comparison key of the course-code query with the comparison key of each parsed row. Existing substring behavior remains otherwise unchanged, so both `INT3103` and `INT 3103` match a displayed `INT 3103` row.

Any reverse or class-result filter that compares course-code values must use the same VNU helper. The current reverse lookup by exact class ID does not compare course codes and therefore remains unchanged.

Class-number comparison retains current semantics: trim harmless edge whitespace, preserve current case handling, and require the existing exact match. Do not remove internal class-number whitespace or merge it with course-code normalization.

### Documents and syllabus search

For VNU documents, retain current document-name search behavior. Add a separate course-code comparison branch using the VNU key for both query and `DocumentItem.courseCode`. This makes compact and spaced course-code input equivalent without globally removing spaces from document titles or names.

For UET and Mock documents, keep the current lowercase substring search unchanged. The VNU helper must be selected explicitly by university context, not applied to every `DocumentItem`.

### Display and exports

UI results continue to render the parsed display value. Existing export builders remain pass-through consumers: class JSON/CSV and grade/transcript JSON/CSV must emit `INT 3103` when that is the normalized portal-visible form. Query metadata may retain the user's entered form; result fields must retain the portal form. No serializer recomputes or emits a comparison key.

## Architecture and file candidates

Responsibility boundaries:

- `packages/university-adapters/src/vnu/parser.ts`: HTML display normalization use, permissive spaced-token gates, and anchored exam/catalog composite parsing.
- `packages/university-adapters/src/vnu/parser.test.ts`: parser matrix and row-retention regressions.
- A small VNU-specific helper module under `packages/university-adapters/src/vnu/`, or an explicitly exported pure parser helper: comparison-key ownership. One implementation must be shared by VNU parser-adjacent consumers and browser filters; do not duplicate regexes in pages.
- `packages/university-adapters/src/vnu/mapper.ts`: expected to remain pass-through; change only if tests expose unintended compaction or ID instability.
- `apps/web/src/pages/lookup.tsx`: VNU course-code filtering for forward lookup and any course-code comparison discovered in reverse/class flows. Exact class-ID filtering stays unchanged.
- `apps/web/src/pages/documents.tsx`: VNU-only syllabus/document course-code search branch; name search and non-VNU behavior stay unchanged.
- `apps/web/src/lib/data-export.test.ts` and existing export code only as evidence requires: assert preserved result values without adding export normalization.
- `apps/web/tests/smoke.spec.ts` and focused web unit tests near any extracted filter helper: compact/spaced lookup, documents, and downloaded export behavior.

`packages/schemas/src/index.ts` is outside the semantic change boundary because its course-code fields are already strings. No worker route or API envelope change is expected. The implementation plan must confirm imports/exports for the chosen helper and the exact web test location before editing; this design does not invent line-number commitments.

## Error and fallback behavior

- A valid spaced course token is accepted and preserved instead of causing row loss.
- Malformed grades or syllabus rows continue to be skipped under existing row validation.
- Malformed exam/catalog composites never gain guessed term, course, or class values.
- Existing loose fallback remains available only to preserve information already present in the source cell; it must not split an ambiguous remainder into a fabricated class.
- Missing optional class numbers remain `undefined`.
- Search normalization cannot throw and does not change session, query, or error handling.
- No parse failure causes raw upstream HTML to enter browser payloads beyond existing established raw routes.

## Test matrix

### Parser unit tests

Use table-driven, synthetic fixtures covering:

| Input form | Expected display | Expected comparison/split |
|---|---|---|
| `INT3103` | `INT3103` | key `INT3103` |
| `INT 3103` | `INT 3103` | key `INT3103` |
| repeated internal ASCII spaces | one internal ASCII space | same compact key |
| `&nbsp;` and numeric NBSP entity | one internal ASCII space | same compact key |
| tab, CR/LF, and tag-separated text | one internal ASCII space | same compact key |
| contiguous alphabetic suffix | suffix preserved in course code | suffix remains in key |
| `252-INT 3103 6` | course `INT 3103` | term `252`, class `6` |
| hyphen-separated and alphanumeric class forms | course preserved | existing class form preserved |
| no optional class number | course preserved | class absent |
| malformed term/course composites | no invented value | existing fallback or row skip |

Add explicit regressions proving that spaced grades rows remain in both `rows` and term groups, spaced transcript rows remain present, and spaced syllabus rows remain present. Include leading/trailing whitespace, repeated separators, missing numeric body, invalid prefix, trailing prose, and ambiguous malformed composites.

### Web unit and end-to-end tests

- Compact and spaced forward course-code inputs return the same VNU class rows.
- Class-number filtering remains exact after edge trimming.
- Reverse class-ID results continue to display the preserved spaced course code.
- Compact and spaced document/syllabus searches return the same VNU document.
- Document-name search remains unchanged.
- JSON and CSV class exports preserve `INT 3103` in result fields.
- JSON and CSV grade/transcript exports preserve `INT 3103` in course rows.
- VNU result rendering shows `INT 3103`, never the compact comparison key.
- UET and Mock parser/search fixtures retain existing behavior.
- English and Vietnamese coverage changes only if implementation introduces user-facing copy; none is expected.

## Security and privacy

- Do not copy HAR bodies, upstream HTML captures, real names, student codes, internal `StdID` values, tokens, cookies, or Authorization data into this design, fixtures, logs, snapshots, or test output.
- Use conspicuously synthetic identifiers and generic course names. `INT 3103` and `INT3103` are permitted because the user supplied them as course-code examples.
- Do not add logging, telemetry, or parser diagnostics.
- Do not add raw upstream HTML to normal browser API payloads. Existing established VNU raw routes remain unchanged.
- Comparison keys stay ephemeral and contain no new user or session data.

## Acceptance criteria

- VNU grades, transcript, syllabus, exam, and catalog parsing accepts verified course tokens with internal whitespace.
- Portal-originated whitespace becomes one ASCII display space; the preserved display value flows unchanged through UI and JSON/CSV exports.
- One pure VNU helper removes all JavaScript-recognized Unicode whitespace and uppercases only for comparison.
- Compact and spaced VNU queries match the same class and syllabus/document records.
- `252-INT 3103 6` splits into term `252`, course `INT 3103`, and class `6`.
- Course-versus-class boundaries follow the anchored verified grammar; malformed input never produces fabricated components.
- Class-number, term, and class-ID semantics remain unchanged.
- Shared schemas receive no global normalization; UET and Mock behavior remains unchanged.
- Parser, web unit, export, and Playwright regressions cover the approved matrix with synthetic data only.
- No user-facing copy, logs, raw payload exposure, PII, or secrets are added.

## Rollout

After written approval of this design, create a separate implementation plan that names exact edits and test order. Implement under review, then run the full repository build and test suite plus Playwright. Review the final diff for VNU-only scope, display preservation, malformed-row behavior, export fidelity, and privacy.

No commit, push, deployment, or automatic rollout is part of this design task. Any later deployment requires an explicit request and the repository's normal build, test, Playwright, and deployment gates.
