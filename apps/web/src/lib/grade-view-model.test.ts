import type { Grade } from "@hyeboard/schemas";
import { describe, expect, it } from "vitest";
import { ALL_GRADE_TERMS, createGradeExportTerm, decodeGradeTermKey, encodeGradeTermKey, selectVisibleGradeSummaries, sortGrades } from "./grade-view-model";
import type { AcademicTermSummary } from "./term-academic-summary";

const grades: Grade[] = [
  { id: "b", courseCode: "B", courseName: "Beta", credits: 2, point10: 9, point4: 4, termCode: "252" },
  { id: "a", courseCode: "A", courseName: "Alpha", credits: 3, point10: 8, point4: 3, termCode: "252" },
];

function summary(termKey: string, courses = grades): AcademicTermSummary<Grade> {
  return { termKey, courses, listedCredits: 5, includedCredits: 5, termGpa4: 3.5, cpa4: 3.5, includesSummer: false, estimateKind: "derived" };
}

describe("grade view model", () => {
  it("sorts text and numeric columns in both directions without mutating input", () => {
    expect(sortGrades(grades, { key: "name", direction: "asc" }).map((grade) => grade.id)).toEqual(["a", "b"]);
    expect(sortGrades(grades, { key: "point10", direction: "desc" }).map((grade) => grade.id)).toEqual(["b", "a"]);
    expect(grades.map((grade) => grade.id)).toEqual(["b", "a"]);
  });

  it("keeps missing, reserved, spaced, and raw term identities collision-safe", () => {
    for (const termCode of [undefined, "", " 251 ", "~hyeboard:all", "~hyeboard:known:reserved"]) {
      expect(decodeGradeTermKey(encodeGradeTermKey(termCode))).toBe(termCode?.trim() ? termCode : undefined);
    }
    expect(encodeGradeTermKey("unknown")).toBe("unknown");
  });

  it("selects newest, valid, and all-term views deterministically", () => {
    const summaries = [summary("252"), summary("251")];
    expect(selectVisibleGradeSummaries(summaries, undefined)).toMatchObject({ effectiveTerm: "252", visibleSummaries: [summaries[0]] });
    expect(selectVisibleGradeSummaries(summaries, "251")).toMatchObject({ effectiveTerm: "251", visibleSummaries: [summaries[1]] });
    expect(selectVisibleGradeSummaries(summaries, ALL_GRADE_TERMS)).toMatchObject({ effectiveTerm: ALL_GRADE_TERMS, visibleSummaries: summaries });
  });

  it("constructs export terms in current sorted course order", () => {
    const sorted = sortGrades(grades, { key: "name", direction: "asc" });
    const exported = createGradeExportTerm(summary("252"), "mock", "Semester", sorted);
    expect(exported.termCode).toBe("252");
    expect(exported.courses.map((course) => course.courseName)).toEqual(["Alpha", "Beta"]);
    expect(exported.courses.map((course) => Object.keys(course))).toEqual([
      ["courseCode", "courseName", "credits", "point10", "letter", "point4"],
      ["courseCode", "courseName", "credits", "point10", "letter", "point4"],
    ]);
  });
});
