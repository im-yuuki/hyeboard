export type StatusTone = "neutral" | "warning" | "danger" | "success" | "accent";

export interface StatusLabels {
  notStarted: string;
  inProgress: string;
  missing: string;
  submitted: string;
  graded: string;
  late: string;
  active: string;
  completed: string;
  upcoming: string;
  paid: string;
  unpaid: string;
  partial: string;
  credit: string;
  available: string;
}

export interface TermLabels {
  semester: (semester: number, year: string) => string;
  summer: (year: string) => string;
}

const statusTones: Record<keyof StatusLabels, StatusTone> = {
  notStarted: "neutral",
  inProgress: "warning",
  missing: "danger",
  submitted: "success",
  graded: "success",
  late: "warning",
  active: "accent",
  completed: "success",
  upcoming: "neutral",
  paid: "success",
  unpaid: "danger",
  partial: "warning",
  credit: "neutral",
  available: "neutral",
};

const statusKeys = new Map<string, keyof StatusLabels>([
  ["not_started", "notStarted"],
  ["in_progress", "inProgress"],
  ["missing", "missing"],
  ["submitted", "submitted"],
  ["graded", "graded"],
  ["late", "late"],
  ["active", "active"],
  ["completed", "completed"],
  ["upcoming", "upcoming"],
  ["paid", "paid"],
  ["unpaid", "unpaid"],
  ["partial", "partial"],
  ["credit", "credit"],
  ["available", "available"],
]);

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[\s-]+/g, "_");
}

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function humanizeUnknown(value: string): string {
  return capitalizeFirst(value.trim().replace(/[\s_-]+/g, " "));
}

export function formatStatus(status: string | undefined, labels: StatusLabels): { label: string; tone: StatusTone } {
  const value = status?.trim();
  if (!value) return { label: "-", tone: "neutral" };

  const normalized = normalizeKey(value);
  const key = statusKeys.get(normalized);
  if (key) return { label: labels[key], tone: statusTones[key] };

  return { label: capitalizeFirst(normalized.replace(/_+/g, " ")), tone: "neutral" };
}

export function formatExamDetail(value: string | undefined, knownMap: Record<string, string>): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return knownMap[normalizeKey(trimmed)] ?? humanizeUnknown(trimmed);
}

export function formatTermLabel(term: string, universityId: string, labels: TermLabels): string {
  if (universityId !== "uet" && universityId !== "mock") return term;

  // StudentHub uses both YYYYS ("20251") and short YYS ("252") term codes.
  const match = /^(\d{4})([123])$/.exec(term) ?? /^(\d{2})([123])$/.exec(term);
  if (!match) return term;

  const startYear = match[1].length === 4 ? Number(match[1]) : 2000 + Number(match[1]);
  const year = `${startYear}–${startYear + 1}`;
  const semester = Number(match[2]);
  return semester === 3 ? labels.summer(year) : labels.semester(semester, year);
}

export interface GradeLetterSource {
  letter?: string;
  point4?: number | null;
}

// Official VNU 4.0-scale bijection ("Quy chế đào tạo đại học" letter bands).
const point4LetterScale: ReadonlyArray<readonly [number, string]> = [
  [4.0, "A+"],
  [3.7, "A"],
  [3.5, "B+"],
  [3.0, "B"],
  [2.5, "C+"],
  [2.0, "C"],
  [1.5, "D+"],
  [1.0, "D"],
  [0, "F"],
];

const POINT4_MATCH_EPSILON = 0.01;

export function letterForGrade(grade: GradeLetterSource, universityId: string): string | undefined {
  const explicitLetter = grade.letter?.trim();
  if (explicitLetter) return explicitLetter;
  if (universityId !== "uet" && universityId !== "mock") return undefined;
  const point4 = grade.point4;
  if (point4 == null) return undefined;

  const entry = point4LetterScale.find(([value]) => Math.abs(value - point4) <= POINT4_MATCH_EPSILON);
  return entry?.[1];
}

const letterTones = new Map<string, StatusTone>([
  ["A+", "success"],
  ["A", "success"],
  ["B+", "accent"],
  ["B", "accent"],
  ["C+", "warning"],
  ["C", "warning"],
  ["D+", "neutral"],
  ["D", "neutral"],
  ["F", "danger"],
]);

export function letterTone(letter: string | undefined): StatusTone {
  if (!letter) return "neutral";
  return letterTones.get(letter) ?? "neutral";
}
