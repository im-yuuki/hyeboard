import type { Grade } from "@hyeboard/schemas";
import { ChevronDown } from "lucide-react";
import { Fragment, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Empty, FeatureFrame, SummaryStat, SummaryStrip } from "@/components/shared";
import { api } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { formatTermLabel, letterForGrade, letterTone } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import { useFeatureQuery, useHyeboard } from "@/state";

const ALL_TERMS = "all";

function gradeTermKey(grade: Grade, universityId: string, unknownTermLabel: string) {
  const code = grade.termCode ?? unknownTermLabel;
  if (usesUetTermRules(universityId) && /^\d+3$/.test(code)) return `${code.slice(0, -1)}2`;
  return code;
}

function usesUetTermRules(universityId: string) {
  return universityId === "uet" || universityId === "mock";
}

function isSummerGrade(grade: Grade, universityId: string) {
  return usesUetTermRules(universityId) && Boolean(grade.termCode?.endsWith("3"));
}

function summarizeGrades(grades: Grade[]) {
  const totalCredits = grades.reduce((sum, grade) => sum + (grade.credits ?? 0), 0);
  const weightedPoint4 = grades.reduce((sum, grade) => sum + ((grade.point4 ?? 0) * (grade.credits ?? 0)), 0);
  const weightedPoint10 = grades.reduce((sum, grade) => sum + ((grade.point10 ?? 0) * (grade.credits ?? 0)), 0);
  return {
    credits: totalCredits,
    point4: totalCredits ? weightedPoint4 / totalCredits : undefined,
    point10: totalCredits ? weightedPoint10 / totalCredits : undefined,
  };
}

type GradeSortKey = "name" | "credits" | "point10" | "point4";
type GradeSortState = { key: GradeSortKey; direction: "asc" | "desc" };

function sortGradeValue(grade: Grade, key: GradeSortKey): string | number {
  if (key === "name") return grade.courseName;
  if (key === "credits") return grade.credits ?? -1;
  if (key === "point10") return grade.point10 ?? -1;
  return grade.point4 ?? -1;
}

function sortGrades(grades: Grade[], sort: GradeSortState) {
  return [...grades].sort((a, b) => {
    const left = sortGradeValue(a, sort.key);
    const right = sortGradeValue(b, sort.key);
    const base = typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right));
    const ordered = sort.direction === "asc" ? base : -base;
    return ordered || a.courseName.localeCompare(b.courseName);
  });
}

function SummerBadge() {
  const { t } = useLocale();
  return <Badge className="shrink-0 border border-border bg-background text-foreground">{t.grades.summerTerm}</Badge>;
}

function LetterBadge({ letter, large }: { letter: string | undefined; large?: boolean }) {
  if (!letter) return <span className="text-muted-foreground">-</span>;
  return (
    <Badge
      data-testid={large ? "letter-badge-detail" : "letter-badge"}
      data-tone={letterTone(letter)}
      className={cn("justify-center font-semibold tabular-nums", large ? "min-w-12 px-3 py-1 text-lg" : "min-w-9 text-sm")}
    >
      {letter}
    </Badge>
  );
}

function GradeDetail({ grade, universityId }: { grade: Grade; universityId: string }) {
  const { t } = useLocale();
  const termLabel = grade.termCode ? formatTermLabel(grade.termCode, universityId, t.terms) : t.grades.unknownTerm;
  const stats: Array<{ label: string; value: string }> = [
    { label: t.grades.point10, value: grade.point10 != null ? String(grade.point10) : "-" },
    { label: t.grades.point4, value: grade.point4 != null ? String(grade.point4) : "-" },
    { label: t.grades.credits, value: grade.credits != null ? String(grade.credits) : "-" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-border bg-muted/30 px-4 py-3">
      <LetterBadge letter={letterForGrade(grade, universityId)} large />
      {stats.map((stat) => (
        <div key={stat.label}>
          <p className="text-xs text-muted-foreground">{stat.label}</p>
          <p className="text-sm font-medium tabular-nums">{stat.value}</p>
        </div>
      ))}
      <div>
        <p className="text-xs text-muted-foreground">{t.exams.term}</p>
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{termLabel}</p>
          {isSummerGrade(grade, universityId) ? <SummerBadge /> : null}
        </div>
      </div>
      {/* Extension point: per-component score breakdown (midterm/final weights
          from the VNU point-detail API) slots in here as additional stat
          blocks once that data source lands. Never fabricate component
          scores in the meantime. */}
    </div>
  );
}

function GradeTable({ grades, sort, onSortChange, universityId }: { grades: Grade[]; sort: GradeSortState; onSortChange: (sort: GradeSortState) => void; universityId: string }) {
  const { t } = useLocale();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const sortableHeaders: Array<{ key: GradeSortKey; label: string; align?: "right"; className?: string }> = [
    { key: "name", label: t.grades.course },
    { key: "credits", label: t.grades.credits, align: "right" },
    { key: "point10", label: t.grades.point10, align: "right" },
    { key: "point4", label: t.grades.point4, align: "right", className: "max-sm:hidden" },
  ];
  const [courseHeader, ...numericHeaders] = sortableHeaders;
  const changeSort = (key: GradeSortKey) => {
    const direction = sort.key === key && sort.direction === "asc" ? "desc" : "asc";
    onSortChange({ key, direction });
  };
  const toggleExpanded = (id: string) => setExpandedId((current) => (current === id ? null : id));
  if (!grades.length) return <Empty text={t.grades.noGrades} />;
  const renderSortableHeader = (header: (typeof sortableHeaders)[number]) => (
    <th
      key={header.key}
      className={cn("px-3 py-2 font-medium", header.align === "right" ? "text-right" : "text-left", header.className)}
      aria-sort={sort.key === header.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" onClick={() => changeSort(header.key)} className={cn("inline-flex items-center gap-1 hover:text-foreground", header.align === "right" && "justify-end")}>
        {header.label}
        <span className="text-[10px]">{sort.key === header.key ? (sort.direction === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted text-muted-foreground">
          <tr>
            {renderSortableHeader(courseHeader)}
            <th className="px-3 py-2 text-left font-medium">{t.grades.letter}</th>
            {numericHeaders.map(renderSortableHeader)}
          </tr>
        </thead>
        <tbody>
          {grades.map((grade) => {
            const expanded = expandedId === grade.id;
            return (
              <Fragment key={grade.id}>
                <tr
                  className="table-row-motion cursor-pointer border-t border-border"
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button")) return;
                    toggleExpanded(grade.id);
                  }}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(grade.id)}
                        aria-expanded={expanded}
                        aria-label={t.grades.toggleDetails(grade.courseName)}
                        className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground"
                      >
                        <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
                      </button>
                      <span>{grade.courseName}</span>
                      {isSummerGrade(grade, universityId) ? <SummerBadge /> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2"><LetterBadge letter={letterForGrade(grade, universityId)} /></td>
                  <td className="px-3 py-2 text-right tabular-nums">{grade.credits ?? "-"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{grade.point10 ?? "-"}</td>
                  <td className="px-3 py-2 text-right tabular-nums max-sm:hidden">{grade.point4 ?? "-"}</td>
                </tr>
                <tr>
                  <td colSpan={5} className="p-0">
                    <div className="collapsible-panel" data-open={expanded} data-testid="grade-detail">
                      <div>
                        <GradeDetail grade={grade} universityId={universityId} />
                      </div>
                    </div>
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function GradesPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const [sort, setSort] = useState<GradeSortState>({ key: "name", direction: "asc" });
  const [selectedTerm, setSelectedTerm] = useState<string | undefined>(undefined);
  const query = useFeatureQuery("grades", () => api.grades(state.universityId));
  const gpa = state.dashboard.data?.gpa;
  return (
    <FeatureFrame title={t.grades.title} description={t.grades.description} query={query}>
      {(items) => {
        const byTerm = items.reduce<Record<string, Grade[]>>((acc, g) => {
          const key = gradeTermKey(g, state.universityId, t.grades.unknownTerm);
          (acc[key] ??= []).push(g);
          return acc;
        }, {});
        const termKeys = Object.keys(byTerm).sort((a, b) => b.localeCompare(a));
        const newestTerm = termKeys[0];
        const effectiveTerm = selectedTerm && (selectedTerm === ALL_TERMS || byTerm[selectedTerm]) ? selectedTerm : newestTerm;
        const visibleTerms = effectiveTerm === ALL_TERMS ? termKeys : termKeys.filter((term) => term === effectiveTerm);
        return (
          <div className="space-y-6">
            <SummaryStrip testId="grades-summary">
              <SummaryStat label={t.dashboard.gpa} value={gpa?.gpa?.toFixed(2) ?? "-"} detail={t.grades.gpaDetail} />
              <SummaryStat label={t.grades.cpa} value={gpa?.cpa?.toFixed(2) ?? "-"} detail={state.universityId === "vnu" ? t.grades.cpaDetailVnu : t.grades.cpaDetailOther} />
              <SummaryStat label={t.grades.credits} value={String(gpa?.totalAccumulatedCredits ?? "-")} detail={t.grades.creditsCompleted} />
            </SummaryStrip>
            {termKeys.length ? (
              <Select value={effectiveTerm ?? ""} onValueChange={setSelectedTerm}>
                <SelectTrigger className="h-9 w-[220px]" aria-label={t.exams.term} data-testid="grades-term-select">
                  <SelectValue placeholder={t.exams.term} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_TERMS}>{t.grades.allTerms}</SelectItem>
                  {termKeys.map((term) => (
                    <SelectItem key={term} value={term}>{formatTermLabel(term, state.universityId, t.terms)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {visibleTerms.map((term) => {
              const grades = byTerm[term];
              const summary = summarizeGrades(grades);
              const includesSummer = usesUetTermRules(state.universityId) && grades.some((grade) => grade.termCode && grade.termCode !== term && grade.termCode.endsWith("3"));
              const sortedGrades = sortGrades(grades, sort);
              const displayTerm = formatTermLabel(term, state.universityId, t.terms);
              return (
              <div key={term} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold">{displayTerm}</h2>
                  {includesSummer ? <Badge className="border border-border bg-background text-foreground">{t.grades.includesSummer}</Badge> : null}
                </div>
                <SummaryStrip testId="term-summary">
                  <SummaryStat label={t.grades.termGpa} value={summary.point4?.toFixed(2) ?? "-"} />
                  <SummaryStat label={t.grades.average10} value={summary.point10?.toFixed(2) ?? "-"} />
                  <SummaryStat label={t.grades.credits} value={String(summary.credits || "-")} />
                </SummaryStrip>
                <GradeTable grades={sortedGrades} sort={sort} onSortChange={setSort} universityId={state.universityId} />
              </div>
            );})}
          </div>
        );
      }}
    </FeatureFrame>
  );
}
