import { describe, expect, it } from "vitest";
import { formatStatus, formatTermLabel, letterForGrade, letterTone, type StatusLabels, type TermLabels } from "./presentation";

const statusLabels: StatusLabels = {
  notStarted: "Not started",
  inProgress: "In progress",
  missing: "Missing",
  submitted: "Submitted",
  graded: "Graded",
  late: "Late",
  active: "Active",
  completed: "Completed",
  upcoming: "Upcoming",
  paid: "Paid",
  unpaid: "Unpaid",
  partial: "Partially paid",
  credit: "Credit",
  available: "Available",
};

const termLabels: TermLabels = {
  semester: (semester, year) => `Semester ${semester}, ${year}`,
  summer: (year) => `Summer semester, ${year}`,
};

describe("formatStatus", () => {
  it.each([
    ["not_started", "Not started", "neutral"],
    ["in_progress", "In progress", "warning"],
    ["missing", "Missing", "danger"],
    ["submitted", "Submitted", "success"],
    ["graded", "Graded", "success"],
    ["late", "Late", "warning"],
    ["active", "Active", "accent"],
    ["completed", "Completed", "success"],
    ["upcoming", "Upcoming", "neutral"],
    ["paid", "Paid", "success"],
    ["unpaid", "Unpaid", "danger"],
    ["partial", "Partially paid", "warning"],
    ["credit", "Credit", "neutral"],
    ["available", "Available", "neutral"],
  ] as const)("formats %s with its semantic tone", (status, label, tone) => {
    expect(formatStatus(status, statusLabels)).toEqual({ label, tone });
  });

  it.each([
    ["awaiting_department_review", "Awaiting department review"],
    ["ON-HOLD", "On hold"],
    ["custom status", "Custom status"],
    ["constructor", "Constructor"],
  ])("preserves unknown status meaning for %s", (status, label) => {
    expect(formatStatus(status, statusLabels)).toEqual({ label, tone: "neutral" });
  });

  it.each([undefined, ""])("uses a neutral placeholder for %s", (status) => {
    expect(formatStatus(status, statusLabels)).toEqual({ label: "-", tone: "neutral" });
  });
});

describe("formatTermLabel", () => {
  it.each(["uet", "mock"])("formats verified %s term codes", (universityId) => {
    expect(formatTermLabel("20251", universityId, termLabels)).toBe("Semester 1, 2025–2026");
    expect(formatTermLabel("20252", universityId, termLabels)).toBe("Semester 2, 2025–2026");
    expect(formatTermLabel("20253", universityId, termLabels)).toBe("Summer semester, 2025–2026");
  });

  it.each(["uet", "mock"])("formats short YYS %s term codes", (universityId) => {
    expect(formatTermLabel("251", universityId, termLabels)).toBe("Semester 1, 2025–2026");
    expect(formatTermLabel("252", universityId, termLabels)).toBe("Semester 2, 2025–2026");
    expect(formatTermLabel("243", universityId, termLabels)).toBe("Summer semester, 2024–2025");
  });

  it.each([
    ["20251", "vnu"],
    ["252", "vnu"],
    ["2025", "uet"],
    ["20254", "uet"],
    ["254", "uet"],
    ["abc", "uet"],
    ["", "uet"],
  ])("leaves unverified or malformed term %s for %s verbatim", (term, universityId) => {
    expect(formatTermLabel(term, universityId, termLabels)).toBe(term);
  });
});

describe("letterForGrade", () => {
  it("prefers the explicit upstream letter when present", () => {
    expect(letterForGrade({ letter: "B+", point4: 4.0 }, "vnu")).toBe("B+");
    expect(letterForGrade({ letter: "P", point4: null }, "vnu")).toBe("P");
  });

  it.each([
    [4.0, "A+"],
    [3.7, "A"],
    [3.5, "B+"],
    [3.0, "B"],
    [2.5, "C+"],
    [2.0, "C"],
    [1.5, "D+"],
    [1.0, "D"],
    [0, "F"],
  ])("derives %s -> %s from the official VNU 4.0 scale for uet/mock", (point4, letter) => {
    expect(letterForGrade({ point4 }, "uet")).toBe(letter);
    expect(letterForGrade({ point4 }, "mock")).toBe(letter);
  });

  it("tolerates small floating-point drift within the epsilon", () => {
    expect(letterForGrade({ point4: 3.699 }, "uet")).toBe("A");
    expect(letterForGrade({ point4: 3.701 }, "uet")).toBe("A");
  });

  it("never fabricates a letter for off-scale or missing values", () => {
    expect(letterForGrade({ point4: 3.2 }, "uet")).toBeUndefined();
    expect(letterForGrade({ point4: 3.65 }, "uet")).toBeUndefined();
    expect(letterForGrade({ point4: null }, "uet")).toBeUndefined();
    expect(letterForGrade({}, "uet")).toBeUndefined();
    expect(letterForGrade({ point4: 4.0 }, "vnu")).toBeUndefined();
  });
});

describe("letterTone", () => {
  it.each([
    ["A+", "success"],
    ["A", "success"],
    ["B+", "accent"],
    ["B", "accent"],
    ["C+", "warning"],
    ["C", "warning"],
    ["D+", "neutral"],
    ["D", "neutral"],
    ["F", "danger"],
    ["P", "neutral"],
    [undefined, "neutral"],
  ] as const)("maps %s to the %s tone", (letter, tone) => {
    expect(letterTone(letter)).toBe(tone);
  });
});
