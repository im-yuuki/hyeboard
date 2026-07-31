import type { Grade } from "@hyeboard/schemas";
import { letterForGrade } from "./presentation";
import type { AcademicTermSummary } from "./term-academic-summary";
import type { ExportDerivedTerm } from "./data-export";

export const ALL_GRADE_TERMS = "~hyeboard:all";
const MISSING_TERM_KEY = "~hyeboard:missing";
const ESCAPED_TERM_PREFIX = "~hyeboard:known:";

export type GradeSortKey = "name" | "credits" | "point10" | "point4";
export type GradeSortState = Readonly<{ key: GradeSortKey; direction: "asc" | "desc" }>;

export function encodeGradeTermKey(termCode: string | undefined): string {
  const trimmedTermCode = termCode?.trim();
  if (!trimmedTermCode) return MISSING_TERM_KEY;
  const rawTermCode = termCode!;
  if (rawTermCode === trimmedTermCode && rawTermCode !== MISSING_TERM_KEY && rawTermCode !== ALL_GRADE_TERMS && !rawTermCode.startsWith(ESCAPED_TERM_PREFIX)) return rawTermCode;
  return `${ESCAPED_TERM_PREFIX}${encodeURIComponent(rawTermCode)}`;
}

export function decodeGradeTermKey(termKey: string): string | undefined {
  if (termKey === MISSING_TERM_KEY) return undefined;
  if (termKey.startsWith(ESCAPED_TERM_PREFIX)) return decodeURIComponent(termKey.slice(ESCAPED_TERM_PREFIX.length));
  return termKey;
}

export function isSummerGrade(grade: Grade, universityId: string): boolean {
  const usesUetRules = universityId === "uet" || universityId === "mock";
  return usesUetRules && Boolean(grade.termCode?.endsWith("3"));
}

function sortGradeValue(grade: Grade, key: GradeSortKey): string | number {
  if (key === "name") return grade.courseName;
  if (key === "credits") return grade.credits ?? -1;
  if (key === "point10") return grade.point10 ?? -1;
  return grade.point4 ?? -1;
}

export function sortGrades(grades: readonly Grade[], sort: GradeSortState): Grade[] {
  return [...grades].sort((leftGrade, rightGrade) => {
    const left = sortGradeValue(leftGrade, sort.key);
    const right = sortGradeValue(rightGrade, sort.key);
    const comparison = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    const ordered = sort.direction === "asc" ? comparison : -comparison;
    return ordered || leftGrade.courseName.localeCompare(rightGrade.courseName);
  });
}

export function selectVisibleGradeSummaries<T extends AcademicTermSummary<Grade>>(
  summaries: readonly T[],
  selectedTerm: string | undefined,
): Readonly<{ effectiveTerm: string | undefined; visibleSummaries: T[] }> {
  const newestTerm = summaries[0]?.termKey;
  const selectedSummaryExists = summaries.some((summary) => summary.termKey === selectedTerm);
  const effectiveTerm = selectedTerm === ALL_GRADE_TERMS || selectedSummaryExists ? selectedTerm : newestTerm;
  const visibleSummaries = effectiveTerm === ALL_GRADE_TERMS ? [...summaries] : summaries.filter((summary) => summary.termKey === effectiveTerm);
  return { effectiveTerm, visibleSummaries };
}

export function createGradeExportTerm(
  summary: AcademicTermSummary<Grade>,
  universityId: string,
  label: string,
  sortedCourses: readonly Grade[],
): ExportDerivedTerm {
  return {
    termCode: decodeGradeTermKey(summary.termKey) ?? "unknown",
    termLabel: label,
    estimateKind: "derived",
    listedCredits: summary.listedCredits,
    includedCredits: summary.includedCredits,
    termGpa4: summary.termGpa4,
    derivedCpa4: summary.cpa4,
    courses: sortedCourses.map((grade) => ({
      courseCode: grade.courseCode,
      courseName: grade.courseName,
      credits: grade.credits,
      point10: grade.point10 ?? undefined,
      letter: letterForGrade(grade, universityId),
      point4: grade.point4 ?? undefined,
    })),
  };
}
