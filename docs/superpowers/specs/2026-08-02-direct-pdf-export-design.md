# Direct PDF Export Design

Status: approved
Date: 2026-08-02

## Scope

Replace the export menu's print-popup flow with a direct PDF download for all existing Grades, transcript/lookup, and bulk lookup export models. JSON and CSV remain unchanged.

## Design

`data-export.ts` remains the single sanitized export boundary. It lazily imports pdfmake only after a user selects PDF, configures pdfmake's package-owned Roboto virtual font assets (including Vietnamese glyphs), builds an A4 report definition, receives a Blob, and downloads it with the existing temporary-anchor/object-URL lifecycle. The PDF path never opens a window and never sends data to the worker.

Each report has a Hyeboard heading, localized report title and export timestamp, available query/student/term context, formal summary tables, course/result data tables with repeating headers, and a localized page-number footer. Reports select landscape when a rendered course table needs six columns; compact lookup reports stay portrait.

## Failure behavior

PDF library/font/generation/download failures reject the action, clean up any created anchor and object URL, and show the existing localized inline export error pattern. Filenames remain ASCII-sanitized, identity-free, and end in `.pdf`.

## Test coverage

Unit tests use an injected pdfmake seam to prove the Blob MIME type and `%PDF-` bytes, no `window.open`, cleanup, filename handling, and orientation selection. Playwright exercises the Grades export-menu PDF action and verifies a downloaded PDF header without a popup.

## Limitation

PDF content exists only in the browser after user action. Browser download policy can still block downloads in restrictive user-agent settings; no server or Cloudflare Browser Run fallback exists by design.
