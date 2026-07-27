import { describe, expect, it } from "vitest";
import type { VnuCrossTranscript } from "./api";
import { deriveCrossTranscriptInput, deriveCrossTranscriptView, mapCrossTranscriptError } from "./cross-transcript-view";

const profile = { internalStudentId: "1000", studentCode: "20000000" };
const transcript: VnuCrossTranscript = {
  header: { studentCode: "20000001", studentName: "Synthetic Student" },
  terms: [{ maHK: "251", rows: [{ courseCode: "INT1001", courseName: "Reliable Systems" }] }],
  totals: {},
};

describe("cross-transcript input", () => {
  it("parses a valid internal-ID target and normalizes whitespace", () => {
    expect(deriveCrossTranscriptInput("stdId", " 1001 ", profile)).toEqual({
      input: "1001",
      isValid: true,
      isSelfTarget: false,
      target: { mode: "stdId", stdId: "1001" },
    });
  });

  it("parses a valid student-code target", () => {
    expect(deriveCrossTranscriptInput("stdCode", "20000001", profile)).toEqual({
      input: "20000001",
      isValid: true,
      isSelfTarget: false,
      target: { mode: "stdCode", stdCode: "20000001" },
    });
  });

  it.each([
    ["stdId" as const, "abc"],
    ["stdCode" as const, "1234567"],
  ])("rejects malformed %s input", (mode, input) => {
    expect(deriveCrossTranscriptInput(mode, input, profile)).toMatchObject({ isValid: false, isSelfTarget: false });
  });

  it.each([
    ["stdId" as const, "00000001000"],
    ["stdCode" as const, "20000000"],
  ])("recognizes own %s input", (mode, input) => {
    expect(deriveCrossTranscriptInput(mode, input, profile)).toMatchObject({ isValid: true, isSelfTarget: true });
  });
});

describe("cross-transcript view", () => {
  const validInput = deriveCrossTranscriptInput("stdId", "1001", profile);
  const view = (overrides: Partial<Parameters<typeof deriveCrossTranscriptView>[0]> = {}) => deriveCrossTranscriptView({
    input: validInput,
    submitted: true,
    isLoading: false,
    hasError: false,
    transcript,
    ...overrides,
  });

  it("models prompt, invalid, and ready-to-submit states", () => {
    expect(view({ input: deriveCrossTranscriptInput("stdId", "", profile), submitted: false })).toEqual({ kind: "prompt" });
    expect(view({ input: deriveCrossTranscriptInput("stdId", "abc", profile), submitted: false })).toEqual({ kind: "invalid" });
    expect(view({ submitted: false })).toEqual({ kind: "ready" });
  });

  it("models loading, not-found, no-rows, and success states", () => {
    expect(view({ isLoading: true })).toEqual({ kind: "loading" });
    expect(view({ transcript: { ...transcript, header: {} } })).toEqual({ kind: "notFound" });
    expect(view({ transcript: { ...transcript, terms: [] } })).toEqual({ kind: "noRows" });
    expect(view()).toMatchObject({ kind: "success", rowCount: 1, transcript });
  });

  it("models translated error categories without exposing API messages", () => {
    expect(view({ hasError: true, errorCode: "VNU_RATE_LIMITED" })).toEqual({ kind: "error", errorKind: "rateLimited" });
    expect(view({ hasError: true, errorCode: "VNU_PROBE_BUDGET_UNAVAILABLE" })).toEqual({ kind: "error", errorKind: "temporarilyUnavailable" });
    expect(view({ hasError: true, errorCode: "UNEXPECTED_TECHNICAL_ERROR" })).toEqual({ kind: "error", errorKind: "generic" });
    expect(mapCrossTranscriptError("VNU_CROSS_LOOKUP_NOT_FOUND")).toBe("notFound");
  });
});
