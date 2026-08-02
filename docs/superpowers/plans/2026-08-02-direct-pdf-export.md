# Direct PDF Export Implementation Plan

**Goal:** Download formal localized PDFs from every existing export menu without a print popup or server generation.

## Steps

1. Add pdfmake as a web dependency and declare its browser build modules for TypeScript.
2. Extend `apps/web/src/lib/data-export.ts` with a lazy pdfmake loader, package VFS font setup, formal report-definition builder, orientation resolver, and direct Blob download lifecycle.
3. Replace the export-menu print item with an asynchronous PDF download action and localized PDF error state.
4. Add English and Vietnamese menu/report labels in `apps/web/src/lib/i18n.tsx`.
5. Update export unit and Playwright coverage for direct PDF bytes, no popup, orientation, sanitized filenames, and the menu download action.
6. Verify with web unit tests/build, repository tests, Playwright, and Worker deploy dry-run.

## Boundaries

- Preserve JSON and CSV serialization and downloads.
- Do not use `window.open`, DOM rasterization, server generation, or Cloudflare Browser Run.
- Keep the PDF dependency out of the initial bundle through dynamic import.
- Keep existing sanitized export models and identity-free filenames.
