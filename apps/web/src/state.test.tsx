import { describe, expect, it } from "vitest";
import { shouldInvalidateAccountQuery } from "@/lib/query-scope";

describe("shouldInvalidateAccountQuery", () => {
  const query = (queryKey: readonly unknown[], active = true) => ({
    queryKey,
    isActive: () => active,
  });

  it("invalidates active feature queries", () => {
    expect(
      shouldInvalidateAccountQuery(query(["dashboard", "uet", undefined, 1])),
    ).toBe(true);
    expect(
      shouldInvalidateAccountQuery(query(["grades", "vnu", "251", 1])),
    ).toBe(true);
  });

  it("keeps static and inactive queries cached", () => {
    expect(shouldInvalidateAccountQuery(query(["universities"]))).toBe(false);
    expect(
      shouldInvalidateAccountQuery(
        query(["grades", "vnu", undefined, 1], false),
      ),
    ).toBe(false);
    expect(
      shouldInvalidateAccountQuery(query(["unknown", "uet", undefined, 1])),
    ).toBe(false);
  });
});
