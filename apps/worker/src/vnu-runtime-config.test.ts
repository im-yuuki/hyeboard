import { describe, expect, it, vi } from "vitest";

import { normalizeSelfHostedInteger, parseVnuRuntimeConfig } from "./vnu-runtime-config";

describe("parseVnuRuntimeConfig", () => {
  it("uses documented missing defaults", () => {
    expect(parseVnuRuntimeConfig({})).toEqual({ codeLookupConcurrency: 16, crossLookupBulkMaxTargets: 50 });
  });

  it.each(["1", "16", "32", String(Number.MAX_SAFE_INTEGER)])("accepts positive canonical concurrency %s", (value) => {
    expect(parseVnuRuntimeConfig({ codeLookupConcurrency: value }).codeLookupConcurrency).toBe(Number(value));
  });

  it.each(["0", "", " 16", "16 ", "+16", "-1", "1.0", "1e2", "0x10", "01", String(Number.MAX_SAFE_INTEGER + 1)])("falls concurrency %j back to one", (value) => {
    expect(parseVnuRuntimeConfig({ codeLookupConcurrency: value }).codeLookupConcurrency).toBe(1);
  });

  it.each(["0", "1", "50", String(Number.MAX_SAFE_INTEGER)])("accepts canonical bulk maximum %s without a product ceiling", (value) => {
    expect(parseVnuRuntimeConfig({ crossLookupBulkMaxTargets: value }).crossLookupBulkMaxTargets).toBe(Number(value));
  });

  it.each(["", " 50", "50 ", "+50", "-1", "1.5", "5e1", "0x32", "050", String(Number.MAX_SAFE_INTEGER + 1)])("disables bulk for malformed value %j", (value) => {
    expect(parseVnuRuntimeConfig({ crossLookupBulkMaxTargets: value }).crossLookupBulkMaxTargets).toBe(0);
  });

  it("warns with only setting name and fallback", () => {
    const warn = vi.fn();
    parseVnuRuntimeConfig({ codeLookupConcurrency: "raw-secret-like-value", crossLookupBulkMaxTargets: "another-raw-value" }, warn);

    expect(warn.mock.calls).toEqual([
      ["VNU_CODE_LOOKUP_CONCURRENCY", 1],
      ["VNU_CROSS_LOOKUP_BULK_MAX_TARGETS", 0],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("raw-secret-like-value");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("another-raw-value");
  });
});

describe("normalizeSelfHostedInteger", () => {
  it.each([
    [undefined, undefined],
    [0, "0"],
    [16, "16"],
    [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
    ["16", "16"],
    [" 16", " 16"],
    [-1, ""],
    [1.5, ""],
    [Number.MAX_SAFE_INTEGER + 1, ""],
    [true, ""],
    [null, ""],
    [{}, ""],
  ])("normalizes file value %j to %j", (input, expected) => {
    expect(normalizeSelfHostedInteger(input)).toBe(expected);
  });
});
