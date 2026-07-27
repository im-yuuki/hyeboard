import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/lib/i18n";
import { ExportMenu, nextExportAttemptState } from "./export-menu";

describe("ExportMenu", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "en" });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders a localized 44px trigger without an empty live region", () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider>
        <ExportMenu model={{ schemaVersion: 1, surface: "grades-page", universityId: "mock", derivedTerms: [] }} />
      </LocaleProvider>,
    );
    expect(markup).toContain("Export");
    expect(markup).toContain("min-h-11");
    expect(markup).not.toContain('aria-live="polite"');
    expect(markup).not.toContain('role="status"');
  });

  it("increments repeated failures and clears state after success", () => {
    const firstFailure = nextExportAttemptState({ failed: false, attempt: 0 }, "failure");
    const repeatedFailure = nextExportAttemptState(firstFailure, "failure");

    expect(firstFailure).toEqual({ failed: true, attempt: 1 });
    expect(repeatedFailure).toEqual({ failed: true, attempt: 2 });
    expect(nextExportAttemptState(repeatedFailure, "success")).toEqual({ failed: false, attempt: 2 });
  });
});
