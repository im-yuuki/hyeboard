# PDF Term Tables Design

## Goal

Render one course table per academic term in PDF exports.

## Approach

Replace the flattened `pdfCourseTable(terms, labels)` output with a helper that renders one table from one `ExportDerivedTerm`. The PDF definition iterates each term, emits its existing heading and GPA summary, then appends that term's course table. Reuse the existing compact layout, seven course columns, landscape orientation, labels, and PDF rendering path.

The same helper is used for the main report and nested transcript/bulk result reports, so every PDF course listing has identical term separation.

## Error handling

Terms with no courses still render their heading and summary; no empty table is emitted.

## Scope

No changes to CSV, JSON, printable HTML, labels, page orientation, or export inputs.

## Test

Add a two-term export regression test. Assert two tables exist, each contains only that term's course, and neither table includes the old term-name column.
