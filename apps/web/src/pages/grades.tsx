import type { Grade } from "@hyeboard/schemas";
import { ChevronDown } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExportMenu } from "@/components/export-menu";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, FeatureFrame, SummaryStat, SummaryStrip } from "@/components/shared";
import { api } from "@/lib/api";
import { createGradesExport } from "@/lib/data-export";
import { ALL_GRADE_TERMS, createGradeExportTerm, decodeGradeTermKey, encodeGradeTermKey, isSummerGrade, selectVisibleGradeSummaries, sortGrades, type GradeSortKey, type GradeSortState } from "@/lib/grade-view-model";
import { useLocale } from "@/lib/i18n";
import { formatTermLabel, letterForGrade, letterTone } from "@/lib/presentation";
import { calculateTermAcademicSummaries, newestAcademicTermsFirst } from "@/lib/term-academic-summary";
import { cn } from "@/lib/utils";
import { useFeatureQuery, useHyeboard } from "@/state";

function CompactAcademicMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </span>
  );
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

function VnuGradeDetail({ classId, termOrdinal }: { classId: string; termOrdinal: string }) {
  const { t } = useLocale();
  const state = useHyeboard();
  const detailQuery = useQuery({
    queryKey: ["vnu-point-detail", state.universityId, state.sessionNonce, classId, termOrdinal],
    queryFn: async () => {
      await state.ensureSession();
      return api.vnuPointDetail({ id: classId, Term: termOrdinal });
    },
  });
  if (detailQuery.isLoading) return <div className="px-4 py-3" role="status"><Skeleton className="h-12" /><span className="sr-only">{t.grades.componentDetailLoading}</span></div>;
  if (detailQuery.error) return <div className="px-4 py-3" role="alert"><p className="text-sm text-muted-foreground">{t.grades.componentDetailError}</p></div>;
  if (!detailQuery.data?.components.length) return <div className="px-4 py-3"><Empty text={t.grades.componentDetailEmpty} /></div>;
  return (
    <div className="divide-y divide-border bg-muted/30 px-4">
      {detailQuery.data.components.map((component) => (
        <div key={component.index} className="list-row">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{component.nature || "-"}</p>
            <p className="text-xs text-muted-foreground">{[
              component.weight != null ? t.grades.componentWeight(component.weight) : undefined,
              component.attempt != null ? t.grades.componentAttempt(component.attempt) : undefined,
            ].filter(Boolean).join(" · ") || "-"}</p>
          </div>
          <Badge className="shrink-0 border border-border bg-background font-normal tabular-nums text-foreground">{component.score ?? "-"}</Badge>
        </div>
      ))}
    </div>
  );
}

function GradeDetail({ grade, universityId }: { grade: Grade; universityId: string }) {
  const { t } = useLocale();
  const hasVnuDetailIdentity = universityId === "vnu" && Boolean(grade.classId && grade.termOrdinal);
  if (hasVnuDetailIdentity) return <VnuGradeDetail classId={grade.classId!} termOrdinal={grade.termOrdinal!} />;
  if (universityId === "vnu") return <div className="px-4 py-3"><Empty text={t.grades.componentDetailUnavailable} /></div>;
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
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
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
  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
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
    <div className="overflow-x-auto rounded-xl border border-border">
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
            const expanded = expandedIds.has(grade.id);
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
                        className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground max-lg:-mx-1.5 max-lg:-my-2 max-lg:p-2"
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
  const summaries = useMemo(
    () => newestAcademicTermsFirst(calculateTermAcademicSummaries(
      (query.data ?? []).map((grade) => ({
        termKey: encodeGradeTermKey(grade.termCode),
        credits: grade.credits,
        point4: grade.point4,
        course: grade,
        isSummer: isSummerGrade(grade, state.universityId),
      })),
      state.universityId,
    )),
    [query.data, state.universityId],
  );
  const termLabel = (rawTermCode: string | undefined) => rawTermCode
    ? formatTermLabel(rawTermCode, state.universityId, t.terms)
    : t.grades.unknownTerm;
  const { effectiveTerm, visibleSummaries } = selectVisibleGradeSummaries(summaries, selectedTerm);
  const visibleTermViews = visibleSummaries.map((summary) => {
    const rawTermCode = decodeGradeTermKey(summary.termKey);
    const label = termLabel(rawTermCode);
    const sortedCourses = sortGrades(summary.courses, sort);
    const exportTerm = createGradeExportTerm(summary, state.universityId, label, sortedCourses);
    return { summary, rawTermCode, label, sortedCourses, exportTerm };
  });
  const exportIdentity = state.dashboard.data?.student ? {
    studentCode: state.dashboard.data.student.studentCode,
    studentName: state.dashboard.data.student.fullName,
    managingClass: state.dashboard.data.student.className,
  } : undefined;
  const exportReported = gpa ? {
    cumulativeGpa4: gpa.gpa ?? undefined,
    totalCredits: gpa.totalCredits,
    accumulatedCredits: gpa.totalAccumulatedCredits,
  } : undefined;
  const exportsReady = !state.dashboard.isPending;
  const pageExportModel = summaries.length && exportsReady ? createGradesExport({
    surface: "grades-page",
    universityId: state.universityId,
    identity: exportIdentity,
    reported: exportReported,
    derivedTerms: visibleTermViews.map((view) => view.exportTerm),
  }) : undefined;

  return (
    <FeatureFrame
      title={t.grades.title}
      description={t.grades.description}
      query={query}
      actions={pageExportModel ? <div data-testid="grades-page-export"><ExportMenu model={pageExportModel} /></div> : undefined}
    >
      {() => (
          <div className="space-y-6">
            <SummaryStrip testId="grades-summary">
              <SummaryStat label={t.grades.reportedCumulativeGpa} value={gpa?.gpa?.toFixed(2) ?? "-"} detail={t.grades.gpaDetail} />
              <SummaryStat label={t.grades.reportedSecondaryGpa} value={gpa?.cpa?.toFixed(2) ?? "-"} detail={state.universityId === "vnu" ? t.grades.cpaDetailVnu : t.grades.cpaDetailOther} />
              <SummaryStat label={t.grades.credits} value={String(gpa?.totalAccumulatedCredits ?? "-")} detail={t.grades.creditsCompleted} />
            </SummaryStrip>
            {summaries.length ? (
              <Select value={effectiveTerm ?? ""} onValueChange={setSelectedTerm}>
                <SelectTrigger className="min-h-11 w-full sm:w-[260px]" aria-label={t.exams.term} data-testid="grades-term-select">
                  <SelectValue placeholder={t.exams.term} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_GRADE_TERMS}>{t.grades.allTerms}</SelectItem>
                  {summaries.map((summary) => (
                    <SelectItem key={summary.termKey} value={summary.termKey}>{termLabel(decodeGradeTermKey(summary.termKey))}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {!summaries.length ? <Empty text={t.grades.noGrades} /> : null}
            {visibleTermViews.map(({ summary, label, sortedCourses, exportTerm }) => {
              const termExportModel = exportsReady ? createGradesExport({
                surface: "grades-term",
                universityId: state.universityId,
                identity: exportIdentity,
                reported: exportReported,
                derivedTerms: [exportTerm],
              }) : undefined;
              const headingId = `grade-term-${encodeURIComponent(summary.termKey)}`;
              return (
              <section key={summary.termKey} aria-labelledby={headingId} data-testid="term-summary" className="space-y-2">
                <header data-testid="academic-term-header" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h2 id={headingId} className="text-base font-semibold">{label}</h2>
                    {summary.includesSummer ? <Badge className="border border-border bg-background text-foreground">{t.grades.includesSummer}</Badge> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Badge className="border border-border bg-muted text-foreground" title={t.grades.derivedDetail}>{t.grades.derived}</Badge>
                    <CompactAcademicMetric label={t.grades.termGpa} value={summary.termGpa4?.toFixed(2) ?? "-"} />
                    <CompactAcademicMetric label={t.grades.cpa} value={summary.cpa4?.toFixed(2) ?? "-"} />
                    <CompactAcademicMetric label={t.grades.includedCredits} value={t.grades.creditRatio(summary.includedCredits, summary.listedCredits)} />
                  </div>
                  {termExportModel ? <ExportMenu model={termExportModel} className="ml-auto" /> : null}
                </header>
                <GradeTable grades={sortedCourses} sort={sort} onSortChange={setSort} universityId={state.universityId} />
              </section>
            );})}
          </div>
      )}
    </FeatureFrame>
  );
}
