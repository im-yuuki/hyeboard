import { describe, expect, it } from "vitest";
import { formatCurrency, formatDateTime } from "./utils";

describe("formatters", () => {
  it("preserves date formatting and invalid-value behavior", () => {
    expect(formatDateTime()).toBe("-");
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
    expect(formatDateTime("2026-01-02T03:04:00.000Z")).toBe(
      new Intl.DateTimeFormat("en", {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        month: "short",
        day: "numeric",
      }).format(new Date("2026-01-02T03:04:00.000Z")),
    );
  });

  it("preserves VND currency formatting", () => {
    expect(formatCurrency()).toBe("0 ₫");
    expect(formatCurrency(1234567)).toBe("1.234.567 ₫");
  });
});
