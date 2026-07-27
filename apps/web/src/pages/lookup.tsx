import type { VnuExamCatalogRow, VnuExamTermInfo, VnuProfile, VnuTranscriptTerm } from "@hyeboard/university-adapters/src/vnu/types";
import { VNU_EXAM_TERMS } from "@hyeboard/university-adapters/src/vnu/exam-terms";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Empty, FeatureFrame, SummaryStat, SummaryStrip } from "@/components/shared";
import { api, ApiError, type VnuBulkLookupItem, type VnuBulkLookupMode, type VnuCrossTranscriptInput } from "@/lib/api";
import { deriveBulkLookupViewState, executeBulkLookup, parseBulkTargets, type BulkLookupProgress } from "@/lib/bulk-lookup";
import { deriveCrossTranscriptInput, deriveCrossTranscriptView } from "@/lib/cross-transcript-view";
import { useLocale } from "@/lib/i18n";
import { formatTermLabel } from "@/lib/presentation";
import { useHyeboard } from "@/state";

// Newest first - matches the convention every other term picker in the app
// uses (see mapTerms in the vnu mapper). VNU_EXAM_TERMS itself stays
// oldest-first, matching how the static table was verified.
const TERMS_NEWEST_FIRST: readonly VnuExamTermInfo[] = [...VNU_EXAM_TERMS].reverse();

// Client-side mirrors of the worker's cross-lookup target gates, shared by
// the student-record forms below (the transcript form applies the same pair
// via deriveCrossTranscriptInput). The backend still rejects anything these
// miss — they exist for immediate, localized feedback without a wasted
// round-trip.
const VNU_STD_ID_INPUT_PATTERN = /^\d{1,11}$/;
const VNU_STUDENT_CODE_INPUT_PATTERN = /^\d{8}$/;

function filterCatalogRows(rows: VnuExamCatalogRow[], courseCode: string, classNo: string): VnuExamCatalogRow[] {
  const codeQuery = courseCode.trim().toUpperCase();
  const classNoQuery = classNo.trim().toUpperCase();
  return rows.filter((row) => {
    if (codeQuery && !row.courseCode.toUpperCase().includes(codeQuery)) return false;
    if (classNoQuery && (row.classNo ?? "").toUpperCase() !== classNoQuery) return false;
    return true;
  });
}

// Exact match only — no zero-padding or partial-match normalization, so a
// query can never silently land on a class the user didn't ask for. Every
// match is returned (classIds should be unique within a term's catalog, but
// uniqueness is never assumed: duplicate rows would all be listed).
function filterCatalogRowsByClassId(rows: VnuExamCatalogRow[], classId: string): VnuExamCatalogRow[] {
  const classIdQuery = classId.trim();
  if (!classIdQuery) return [];
  return rows.filter((row) => row.classId === classIdQuery);
}

function ClassResultRow({ row, expanded, onToggleDetail }: { row: VnuExamCatalogRow; expanded: boolean; onToggleDetail: () => void }) {
  const { t } = useLocale();
  return (
    <div className="list-row flex-col items-stretch gap-3 sm:flex-row sm:items-center">
      <div className="min-w-0">
        <p className="break-words text-sm font-medium">{row.courseCode}{row.classNo ? ` · ${row.classNo}` : ""} — {row.courseName}</p>
        <p className="break-words text-xs text-muted-foreground">{row.examDate || "-"}{row.room ? ` · ${row.room}` : ""}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
        <Badge className="max-w-full break-all border border-border bg-background font-mono font-normal tabular-nums text-foreground">{row.classId}</Badge>
        <Button type="button" variant="outline" size="sm" className="min-h-11" aria-expanded={expanded} onClick={onToggleDetail}>{t.lookup.pointDetailAction}</Button>
      </div>
    </div>
  );
}

// Inline drilldown for one resolved class row: the per-component grade
// breakdown (Thi cuối kỳ / Giữa kỳ, weights, attempts, scores) for the
// student's OWN class. The worker scopes StdID to the session owner — this
// panel can never be pointed at another student.
function PointDetailPanel({ classId, termOrdinal }: { classId: string; termOrdinal: string }) {
  const { t } = useLocale();
  const state = useHyeboard();
  const detailQuery = useQuery({
    queryKey: ["vnu-point-detail", state.universityId, state.sessionNonce, classId, termOrdinal],
    queryFn: async () => {
      await state.ensureSession();
      return api.vnuPointDetail({ id: classId, Term: termOrdinal });
    },
  });

  if (detailQuery.isLoading) return <Skeleton className="my-2 h-20" />;
  if (detailQuery.error) return <div className="space-y-2 py-3" role="alert"><p className="text-sm text-muted-foreground">{t.lookup.pointDetailError}</p><Button type="button" size="sm" variant="outline" className="min-h-11" onClick={() => void detailQuery.refetch()}>{t.lookup.retry}</Button></div>;
  const detail = detailQuery.data;
  if (!detail?.components.length) return <div className="py-2"><Empty text={t.lookup.pointDetailEmpty} /></div>;
  return (
    <div className="space-y-2 py-2">
      {detail.headerLabel ? <p className="text-xs text-muted-foreground">{detail.headerLabel}</p> : null}
      <div className="flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>{t.lookup.pointDetailComponentColumn}</span>
        <span>{t.lookup.pointDetailScoreColumn}</span>
      </div>
      <div className="divide-y divide-border">
        {detail.components.map((component) => (
          <div key={component.index} className="list-row">
            <div className="min-w-0">
              <p className="break-words text-sm font-medium">{component.index}. {component.nature}</p>
              <p className="break-words text-xs text-muted-foreground">
                {[
                  component.weight != null ? t.lookup.pointDetailWeight(component.weight) : undefined,
                  component.attempt != null ? t.lookup.pointDetailAttempt(component.attempt) : undefined,
                  component.notes || undefined,
                ].filter(Boolean).join(" · ") || "-"}
              </p>
            </div>
            <Badge className="shrink-0 border border-border bg-background font-normal tabular-nums text-foreground">{component.score ?? "-"}</Badge>
          </div>
        ))}
      </div>
      {detail.displayTotalEcho ? <p className="text-xs text-muted-foreground">{t.lookup.displayTotalEcho(detail.displayTotalEcho)}</p> : null}
    </div>
  );
}

function ClassResolver() {
  const { t } = useLocale();
  const state = useHyeboard();
  const [courseCode, setCourseCode] = useState("");
  const [classNo, setClassNo] = useState("");
  const [termOrdinal, setTermOrdinal] = useState<string | undefined>(undefined);
  const [expandedClassId, setExpandedClassId] = useState<string | null>(null);

  // The catalog call needs no ids from the client: the worker derives
  // selStd/selUniv from the session's own profile (same hardening as
  // point-detail) and fails closed with VNU_LOGIN_REQUIRED when it can't.
  const catalogQuery = useQuery({
    queryKey: ["vnu-lookup-catalog", state.universityId, state.sessionNonce, termOrdinal],
    queryFn: async () => {
      await state.ensureSession();
      return api.vnuClassCatalog({ vTermID: termOrdinal! });
    },
    enabled: Boolean(termOrdinal),
  });

  const filteredRows = filterCatalogRows(catalogQuery.data ?? [], courseCode, classNo);

  return (
    <div className="space-y-4" id="class-forward-panel">
      <p className="max-w-[70ch] text-sm text-muted-foreground">{t.lookup.resolverDescription}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1.5"><label htmlFor="lookup-course-code" className="text-sm font-medium">{t.lookup.courseCodeLabel}</label><Input id="lookup-course-code" className="min-h-11 font-mono tabular-nums" value={courseCode} onChange={(event) => setCourseCode(event.target.value)} placeholder={t.lookup.courseCodePlaceholder} /></div>
        <div className="space-y-1.5"><label htmlFor="lookup-class-number" className="text-sm font-medium">{t.lookup.classNoLabel}</label><Input id="lookup-class-number" className="min-h-11 font-mono tabular-nums" value={classNo} onChange={(event) => setClassNo(event.target.value)} placeholder={t.lookup.classNoPlaceholder} /></div>
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-1"><label htmlFor="lookup-forward-term" className="text-sm font-medium">{t.lookup.termFieldLabel}</label><Select value={termOrdinal ?? ""} onValueChange={(value) => { setTermOrdinal(value); setExpandedClassId(null); }}>
          <SelectTrigger id="lookup-forward-term" className="min-h-11"><SelectValue placeholder={t.lookup.termPlaceholder} /></SelectTrigger>
          <SelectContent>
            {TERMS_NEWEST_FIRST.map((term) => <SelectItem key={term.ordinal} value={term.ordinal}>{t.lookup.termLabel(term)}</SelectItem>)}
          </SelectContent>
        </Select></div>
      </div>

      <div data-testid="lookup-results" className="min-h-28" aria-live="polite">
        {!termOrdinal ? (
          <Empty text={t.lookup.selectTermPrompt} />
        ) : catalogQuery.isLoading ? (
          <Skeleton className="h-40" />
        ) : catalogQuery.error ? (
          <div className="space-y-2" role="alert"><Empty text={t.lookup.classesError} /><Button type="button" variant="outline" className="min-h-11" onClick={() => void catalogQuery.refetch()}>{t.lookup.retry}</Button></div>
        ) : (
          <div>
            <div className="mb-2 flex items-end justify-between gap-3"><h3 className="text-sm font-semibold">{t.lookup.resultsTitle}</h3><p className="text-xs text-muted-foreground">{t.lookup.resultsCount(filteredRows.length)}</p></div>
              {filteredRows.length ? (
                <>
                  <div className="flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <span>{t.lookup.headers[0]}</span>
                    <span>{t.lookup.headers[1]}</span>
                  </div>
                  <div className="divide-y divide-border">
                    {filteredRows.map((row) => (
                      <div key={row.classId}>
                        <ClassResultRow row={row} expanded={expandedClassId === row.classId} onToggleDetail={() => setExpandedClassId((current) => (current === row.classId ? null : row.classId))} />
                        {expandedClassId === row.classId && termOrdinal ? <PointDetailPanel classId={row.classId} termOrdinal={termOrdinal} /> : null}
                      </div>
                    ))}
                  </div>
                </>
              ) : <Empty text={t.lookup.noMatches} />}
          </div>
        )}
      </div>
    </div>
  );
}

// Meta line mirrors CrossExamRow's field order/formatting exactly (date,
// hour, method, room, seat) so a class resolved by internal id reads
// identically to the forward exam-schedule view - now that
// parseExamCatalogHtml captures the same descriptive columns parseExamsHtml
// does, none of these fields need re-deriving here.
function ReverseClassResultRow({ row }: { row: VnuExamCatalogRow }) {
  const { t } = useLocale();
  const meta = [row.examDate || undefined, row.hour, row.method, row.room, row.seatNumber ? t.lookup.crossSeat(row.seatNumber) : undefined].filter(Boolean).join(" · ");
  return (
    <div className="list-row flex-col items-stretch gap-3 sm:flex-row sm:items-center">
      <div className="min-w-0">
        <p className="break-words text-sm font-medium">{row.courseCode}{row.classNo ? ` · ${row.classNo}` : ""} — {row.courseName}</p>
        <p className="break-words text-xs text-muted-foreground">{meta || "-"}</p>
      </div>
      <Badge className="max-w-full self-start break-all border border-border bg-background font-mono font-normal tabular-nums text-foreground sm:shrink-0 sm:self-auto">{row.classId}</Badge>
    </div>
  );
}

// Reverse direction of ClassResolver: internal class ID -> course/class
// row(s). Shares the same per-term catalog fetch (identical queryKey/queryFn,
// so React Query dedupes when both resolvers use the same term) and the same
// hard rule that a term must be picked before anything is fetched or
// filtered — class IDs are only unique within one term's catalog, so an
// unscoped search could silently match the wrong term's class.
function ReverseClassResolver() {
  const { t } = useLocale();
  const state = useHyeboard();
  const [classId, setClassId] = useState("");
  const [termOrdinal, setTermOrdinal] = useState<string | undefined>(undefined);

  const catalogQuery = useQuery({
    queryKey: ["vnu-lookup-catalog", state.universityId, state.sessionNonce, termOrdinal],
    queryFn: async () => {
      await state.ensureSession();
      return api.vnuClassCatalog({ vTermID: termOrdinal! });
    },
    enabled: Boolean(termOrdinal),
  });

  const trimmedClassId = classId.trim();
  const matchedRows = filterCatalogRowsByClassId(catalogQuery.data ?? [], trimmedClassId);

  return (
    <div className="space-y-4" data-testid="reverse-class-lookup" id="class-reverse-panel">
      <p className="max-w-[70ch] text-sm text-muted-foreground">{t.lookup.reverseDescription}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><label htmlFor="lookup-reverse-class-id" className="text-sm font-medium">{t.lookup.reverseClassIdLabel}</label><Input id="lookup-reverse-class-id" className="min-h-11 font-mono tabular-nums" value={classId} onChange={(event) => setClassId(event.target.value)} placeholder={t.lookup.reverseClassIdPlaceholder} /></div>
        <div className="space-y-1.5"><label htmlFor="lookup-reverse-term" className="text-sm font-medium">{t.lookup.termFieldLabel}</label><Select value={termOrdinal ?? ""} onValueChange={setTermOrdinal}>
          <SelectTrigger id="lookup-reverse-term" className="min-h-11"><SelectValue placeholder={t.lookup.termPlaceholder} /></SelectTrigger>
          <SelectContent>
            {TERMS_NEWEST_FIRST.map((term) => <SelectItem key={term.ordinal} value={term.ordinal}>{t.lookup.termLabel(term)}</SelectItem>)}
          </SelectContent>
        </Select></div>
      </div>

      <div className="min-h-28" aria-live="polite">
        {!termOrdinal ? (
          <Empty text={t.lookup.selectTermPrompt} />
        ) : catalogQuery.isLoading ? (
          <Skeleton className="h-40" />
        ) : catalogQuery.error ? (
          <div className="space-y-2" role="alert"><Empty text={t.lookup.classesError} /><Button type="button" variant="outline" className="min-h-11" onClick={() => void catalogQuery.refetch()}>{t.lookup.retry}</Button></div>
        ) : !trimmedClassId ? (
          <Empty text={t.lookup.reverseEnterIdPrompt} />
        ) : !matchedRows.length ? (
          <Empty text={t.lookup.reverseNoMatch} />
        ) : (
          <div>
            <div className="mb-2 flex items-end justify-between gap-3"><h3 className="text-sm font-semibold">{t.lookup.resultsTitle}</h3><p className="text-xs text-muted-foreground">{t.lookup.resultsCount(matchedRows.length)}</p></div>
              <div className="flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <span>{t.lookup.headers[0]}</span>
                <span>{t.lookup.headers[1]}</span>
              </div>
              <div className="divide-y divide-border">
                {matchedRows.map((row, index) => <ReverseClassResultRow key={`${row.classId}-${index}`} row={row} />)}
              </div>
          </div>
        )}
      </div>
    </div>
  );
}

type ClassLookupMode = "forward" | "reverse";

function ClassIdentifierTools() {
  const { t } = useLocale();
  const [mode, setMode] = useState<ClassLookupMode>("forward");
  return (
    <Card data-testid="class-identifier-tools">
      <CardHeader>
        <CardTitle className="text-base">{t.lookup.classIdentifiersTitle}</CardTitle>
        <CardDescription className="max-w-[70ch]">{t.lookup.classIdentifiersDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 rounded-lg border border-border p-1" role="group" aria-label={t.lookup.classModeLabel}>
          <Button type="button" variant={mode === "forward" ? "default" : "ghost"} className="min-h-11 min-w-0 whitespace-normal px-2" aria-pressed={mode === "forward"} aria-controls="class-forward-panel" onClick={() => setMode("forward")}>{t.lookup.resolverTitle}</Button>
          <Button type="button" variant={mode === "reverse" ? "default" : "ghost"} className="min-h-11 min-w-0 whitespace-normal px-2" aria-pressed={mode === "reverse"} aria-controls="class-reverse-panel" onClick={() => setMode("reverse")}>{t.lookup.reverseMode}</Button>
        </div>
        {mode === "forward" ? <ClassResolver /> : <ReverseClassResolver />}
      </CardContent>
    </Card>
  );
}

// Cross-student StdID -> student-code resolver (crossLookup capability, vnu
// only). The heading/description state the intent openly — this is deliberate
// transparency about behavior the upstream portal itself permits, not a
// hidden shortcut. The worker route requires allowCrossLookup=true, rejects
// self-targeting, and never caches; the client mirrors the self-target check
// early so the user gets an inline answer without a wasted round-trip. The
// worker parses the target student's transcript-page header server-side and
// returns only the resolved code/name/class.
function CrossStudentCodeSection({ profile }: { profile: VnuProfile }) {
  const { t } = useLocale();
  const state = useHyeboard();
  const [stdId, setStdId] = useState("");
  const [submitted, setSubmitted] = useState<{ stdId: string } | null>(null);

  const trimmedStdId = stdId.trim();
  const isValid = VNU_STD_ID_INPUT_PATTERN.test(trimmedStdId);
  // Numeric comparison, so leading-zero spellings of the caller's own id
  // still count as self-targeting (same normalization as the worker).
  const isSelfTarget = isValid && Number(trimmedStdId) === Number(profile.internalStudentId);

  const codeQuery = useQuery({
    queryKey: ["vnu-cross-student-code", state.universityId, state.sessionNonce, submitted],
    queryFn: async () => {
      await state.ensureSession();
      return api.vnuCrossStudentCode(submitted!);
    },
    enabled: Boolean(submitted),
  });

  const submit = () => {
    if (!isValid || isSelfTarget) return;
    setSubmitted({ stdId: trimmedStdId });
  };

  const result = codeQuery.data;
  const codeError = codeQuery.error instanceof ApiError && codeQuery.error.code === "VNU_CROSS_LOOKUP_NOT_FOUND"
    ? t.lookup.crossCodeNotFound
    : codeQuery.error instanceof ApiError && codeQuery.error.code === "VNU_RATE_LIMITED"
      ? t.lookup.crossTranscriptRateLimited
      : codeQuery.error instanceof ApiError && codeQuery.error.code === "VNU_PROBE_BUDGET_UNAVAILABLE"
        ? t.lookup.crossTranscriptUnavailable
        : t.lookup.crossLookupError;

  return (
    <section data-testid="cross-student-code" className="space-y-4" aria-labelledby="cross-code-heading">
      <div className="space-y-1"><h3 id="cross-code-heading" className="text-sm font-semibold">{t.lookup.crossCodeTitle}</h3><p className="max-w-[70ch] text-sm text-muted-foreground">{t.lookup.crossCodeDescription}</p></div>
        <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <div className="space-y-1.5"><label htmlFor="cross-code-stdid" className="text-sm font-medium">{t.lookup.crossStdIdLabel}</label><Input id="cross-code-stdid" className="min-h-11 font-mono tabular-nums" inputMode="numeric" value={stdId} onChange={(event) => { setStdId(event.target.value); setSubmitted(null); }} placeholder={t.lookup.crossStdIdPlaceholder} aria-invalid={trimmedStdId.length > 0 && !isValid} /></div>
          <Button type="submit" className="min-h-11 sm:self-end" disabled={!isValid || isSelfTarget}>{t.lookup.crossSubmit}</Button>
        </form>
        <div className="min-h-20" aria-live="polite">{trimmedStdId && !isValid ? <Empty text={t.lookup.crossCodeInvalidStdId} /> : isSelfTarget ? <Empty text={t.lookup.crossCodeSelfTarget} /> : submitted ? (
          codeQuery.isLoading ? (
            <Skeleton className="h-20" />
          ) : codeQuery.error ? (
            <div className="space-y-2" role="alert"><Empty text={codeError} /><Button type="button" variant="outline" className="min-h-11" onClick={() => void codeQuery.refetch()}>{t.lookup.retry}</Button></div>
          ) : !result?.studentCode ? (
            <Empty text={t.lookup.crossCodeNotFound} />
          ) : (
            <div className="divide-y divide-border">
              <div className="list-row flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{result.studentName ?? t.lookup.crossCodeResolvedTitle}</p>
                  <p className="break-words text-xs text-muted-foreground">{[t.lookup.crossCodeResolvedFrom(submitted.stdId), result.className || undefined].filter(Boolean).join(" · ")}</p>
                </div>
                <Badge className="max-w-full shrink-0 break-all border border-border bg-background font-mono font-normal tabular-nums text-foreground">{result.studentCode}</Badge>
              </div>
            </div>
          )
        ) : <Empty text={t.lookup.crossCodePrompt} />}</div>
    </section>
  );
}

// Cross-student student-code -> StdID resolver (crossLookup capability, vnu
// only) — the reverse direction of CrossStudentCodeSection. No portal
// endpoint maps a public code back to an internal id, so the worker walks
// the transcript oracle from the caller's own anchor pair; the resolved id
// and the probe count are the only results. Same transparency + gating story
// as the sibling section; an unresolvable code renders an explicit empty
// state (VNU_CROSS_LOOKUP_NOT_CONVERGED), never a guessed id.
function CrossStudentIdSection({ profile }: { profile: VnuProfile }) {
  const { t } = useLocale();
  const state = useHyeboard();
  const [stdCode, setStdCode] = useState("");
  const [submitted, setSubmitted] = useState<{ stdCode: string } | null>(null);

  const trimmedStdCode = stdCode.trim();
  const isValid = VNU_STUDENT_CODE_INPUT_PATTERN.test(trimmedStdCode);
  // Numeric comparison, matching the worker's normalized self-target check.
  const isSelfTarget = isValid && Number(trimmedStdCode) === Number(profile.studentCode);

  const idQuery = useQuery({
    queryKey: ["vnu-cross-student-id", state.universityId, state.sessionNonce, submitted],
    queryFn: async () => {
      await state.ensureSession();
      return api.vnuCrossStudentId(submitted!);
    },
    enabled: Boolean(submitted),
  });

  const submit = () => {
    if (!isValid || isSelfTarget) return;
    setSubmitted({ stdCode: trimmedStdCode });
  };

  const result = idQuery.data;
  const notConverged = idQuery.error instanceof ApiError && idQuery.error.code === "VNU_CROSS_LOOKUP_NOT_CONVERGED";
  const idError = idQuery.error instanceof ApiError && idQuery.error.code === "VNU_RATE_LIMITED"
    ? t.lookup.crossTranscriptRateLimited
    : idQuery.error instanceof ApiError && idQuery.error.code === "VNU_PROBE_BUDGET_UNAVAILABLE"
      ? t.lookup.crossTranscriptUnavailable
      : t.lookup.crossLookupError;

  return (
    <section data-testid="cross-student-id" className="space-y-4" aria-labelledby="cross-id-heading">
      <div className="space-y-1"><h3 id="cross-id-heading" className="text-sm font-semibold">{t.lookup.crossIdTitle}</h3><p className="max-w-[70ch] text-sm text-muted-foreground">{t.lookup.crossIdDescription}</p></div>
        <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <div className="space-y-1.5"><label htmlFor="cross-id-code" className="text-sm font-medium">{t.lookup.crossIdStdCodeLabel}</label><Input id="cross-id-code" className="min-h-11 font-mono tabular-nums" inputMode="numeric" value={stdCode} onChange={(event) => { setStdCode(event.target.value); setSubmitted(null); }} placeholder={t.lookup.crossIdStdCodePlaceholder} aria-invalid={trimmedStdCode.length > 0 && !isValid} /></div>
          <Button type="submit" className="min-h-11 sm:self-end" disabled={!isValid || isSelfTarget}>{t.lookup.crossSubmit}</Button>
        </form>
        <div className="min-h-20" aria-live="polite">{trimmedStdCode && !isValid ? <Empty text={t.lookup.crossIdInvalidStdCode} /> : isSelfTarget ? <Empty text={t.lookup.crossIdSelfTarget} /> : submitted ? (
          idQuery.isLoading ? (
            <Skeleton className="h-20" />
          ) : notConverged ? (
            <Empty text={t.lookup.crossIdNotConverged} />
          ) : idQuery.error ? (
            <div className="space-y-2" role="alert"><Empty text={idError} /><Button type="button" variant="outline" className="min-h-11" onClick={() => void idQuery.refetch()}>{t.lookup.retry}</Button></div>
          ) : result ? (
            <div className="divide-y divide-border">
              <div className="list-row flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{t.lookup.crossIdResolvedTitle}</p>
                  <p className="break-words text-xs text-muted-foreground">{[t.lookup.crossIdResolvedFrom(result.stdCode), t.lookup.crossIdProbes(result.probes)].join(" · ")}</p>
                </div>
                <Badge className="max-w-full shrink-0 break-all border border-border bg-background font-mono font-normal tabular-nums text-foreground">{result.stdId}</Badge>
              </div>
            </div>
          ) : null
        ) : <Empty text={t.lookup.crossIdPrompt} />}</div>
    </section>
  );
}

function CrossTranscriptTerm({ term }: { term: VnuTranscriptTerm }) {
  const { t } = useLocale();
  return (
    <section className="space-y-2" aria-labelledby={`cross-transcript-term-${term.maHK}`}>
      <h3 id={`cross-transcript-term-${term.maHK}`} className="text-sm font-semibold">{formatTermLabel(term.maHK, "vnu", t.terms)}</h3>
      <div data-testid="cross-transcript-table" className="max-h-[32rem] overflow-auto rounded-xl border border-border">
        <table className="w-full min-w-[36rem] table-fixed text-sm">
          <colgroup><col /><col className="w-20" /><col className="w-20" /><col className="w-20" /><col className="w-20" /></colgroup>
          <thead className="bg-muted text-xs font-medium text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">{t.grades.course}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t.grades.credits}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t.grades.point10}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t.grades.letter}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t.grades.point4}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {term.rows.map((row, index) => (
              <tr key={`${row.courseCode}-${row.classId ?? index}`}>
                <td className="min-w-0 px-3 py-2">
                  <p className="break-words font-medium">{row.courseName}</p>
                  <p className="break-all font-mono text-xs text-muted-foreground">{row.courseCode}</p>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{row.credits ?? "-"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{row.grade10 ?? "-"}</td>
                <td className="px-3 py-2 text-right"><Badge data-tone={row.letterGrade ? "neutral" : undefined} className="min-w-9 justify-center tabular-nums">{row.letterGrade ?? "-"}</Badge></td>
                <td className="px-3 py-2 text-right tabular-nums">{row.grade4 ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CrossTranscriptSection({ profile }: { profile: VnuProfile }) {
  const { t } = useLocale();
  const state = useHyeboard();
  const [mode, setMode] = useState<VnuCrossTranscriptInput["mode"]>("stdId");
  const [stdId, setStdId] = useState("");
  const [stdCode, setStdCode] = useState("");
  const [submitted, setSubmitted] = useState<VnuCrossTranscriptInput | null>(null);
  const inputState = deriveCrossTranscriptInput(mode, mode === "stdId" ? stdId : stdCode, profile);

  const transcriptQuery = useQuery({
    queryKey: ["vnu-cross-transcript", state.universityId, state.sessionNonce, submitted],
    queryFn: async () => {
      await state.ensureSession();
      return api.vnuCrossTranscript(submitted!);
    },
    enabled: Boolean(submitted),
  });

  const submit = () => {
    if (!inputState.target) return;
    setSubmitted(inputState.target);
  };
  const transcriptView = deriveCrossTranscriptView({
    input: inputState,
    submitted: Boolean(submitted),
    isLoading: transcriptQuery.isLoading,
    hasError: Boolean(transcriptQuery.error),
    errorCode: transcriptQuery.error instanceof ApiError ? transcriptQuery.error.code : undefined,
    transcript: transcriptQuery.data,
  });
  const translatedError = transcriptView.kind === "error"
    ? transcriptView.errorKind === "rateLimited"
      ? t.lookup.crossTranscriptRateLimited
      : transcriptView.errorKind === "temporarilyUnavailable"
        ? t.lookup.crossTranscriptUnavailable
        : t.lookup.crossTranscriptError
    : t.lookup.crossTranscriptError;

  return (
    <section data-testid="cross-transcript" className="space-y-4" aria-labelledby="cross-transcript-heading">
      <div className="space-y-1"><h3 id="cross-transcript-heading" className="text-sm font-semibold">{t.lookup.crossTranscriptTitle}</h3><p className="max-w-[70ch] text-sm text-muted-foreground">{t.lookup.crossTranscriptDescription}</p></div>
        <div className="grid min-h-11 grid-cols-2 rounded-lg border border-border p-1 sm:inline-grid" role="group" aria-label={t.lookup.crossTranscriptModeLabel}>
          <Button type="button" size="sm" variant={mode === "stdId" ? "default" : "ghost"} className="min-h-11" aria-pressed={mode === "stdId"} onClick={() => { setMode("stdId"); setSubmitted(null); }}>{t.lookup.crossTranscriptStdIdMode}</Button>
          <Button type="button" size="sm" variant={mode === "stdCode" ? "default" : "ghost"} className="min-h-11" aria-pressed={mode === "stdCode"} onClick={() => { setMode("stdCode"); setSubmitted(null); }}>{t.lookup.crossTranscriptStdCodeMode}</Button>
        </div>
        <form className="grid gap-3 sm:grid-cols-[1fr_auto]" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <div className="space-y-1.5">
            <label htmlFor="cross-transcript-target" className="text-sm font-medium">{mode === "stdId" ? t.lookup.crossStdIdLabel : t.lookup.crossIdStdCodeLabel}</label>
            <Input
              id="cross-transcript-target"
              className="min-h-11 font-mono tabular-nums"
              inputMode="numeric"
              value={mode === "stdId" ? stdId : stdCode}
              onChange={(event) => { if (mode === "stdId") setStdId(event.target.value); else setStdCode(event.target.value); setSubmitted(null); }}
              placeholder={mode === "stdId" ? t.lookup.crossStdIdPlaceholder : t.lookup.crossIdStdCodePlaceholder}
              aria-invalid={inputState.input.length > 0 && !inputState.isValid}
            />
          </div>
          <Button type="submit" className="min-h-11 sm:self-end" disabled={!inputState.target}>{t.lookup.crossTranscriptSubmit}</Button>
        </form>

        <div className="min-h-24" aria-live="polite">{transcriptView.kind === "prompt" ? <Empty text={t.lookup.crossTranscriptPrompt} />
          : transcriptView.kind === "invalid" ? <Empty text={mode === "stdId" ? t.lookup.crossTranscriptInvalidStdId : t.lookup.crossTranscriptInvalidStdCode} />
          : transcriptView.kind === "selfTarget" ? <Empty text={t.lookup.crossTranscriptSelfTarget} />
          : transcriptView.kind === "loading" ? <Empty text={t.lookup.crossTranscriptLoading} />
          : transcriptView.kind === "error" ? <div className="space-y-2" role="alert"><Empty text={translatedError} /><Button type="button" variant="outline" className="min-h-11" onClick={() => void transcriptQuery.refetch()}>{t.lookup.retry}</Button></div>
          : transcriptView.kind === "notFound" ? <Empty text={t.lookup.crossTranscriptNoStudent} />
          : transcriptView.kind === "noRows" ? <Empty text={t.lookup.crossTranscriptNoRows} />
          : transcriptView.kind === "success" ? (
            <div className="space-y-5">
              <div className="list-row border-y border-border px-0">
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold">{transcriptView.transcript.header.studentName ?? transcriptView.transcript.header.studentCode}</p>
                  <p className="break-words text-xs text-muted-foreground">{[transcriptView.transcript.header.studentCode, transcriptView.transcript.header.className].filter(Boolean).join(" · ")}</p>
                </div>
              </div>
              <SummaryStrip testId="cross-transcript-totals">
                <SummaryStat label={t.lookup.crossTranscriptTotalCredits} value={transcriptView.transcript.totals.totalCredits ?? "-"} />
                <SummaryStat label={t.lookup.crossTranscriptAccumulatedCredits} value={transcriptView.transcript.totals.accumulatedCredits ?? "-"} />
                <SummaryStat label={t.lookup.crossTranscriptGpa4} value={transcriptView.transcript.totals.gpa4 ?? "-"} />
              </SummaryStrip>
              {transcriptView.transcript.terms.filter((term) => term.rows.length > 0).map((term) => <CrossTranscriptTerm key={term.maHK} term={term} />)}
            </div>
          ) : null}</div>
    </section>
  );
}

type StudentLookupMode = "id-to-code" | "code-to-id" | "transcript";

function StudentRecordTools({ profile, crossLookupEnabled }: { profile: VnuProfile; crossLookupEnabled: boolean }) {
  const { t } = useLocale();
  const [mode, setMode] = useState<StudentLookupMode>("id-to-code");
  return (
    <Card data-testid="student-record-tools">
      <CardHeader>
        <CardTitle className="text-base">{t.lookup.studentRecordsTitle}</CardTitle>
        <CardDescription className="max-w-[70ch]">{t.lookup.studentRecordsDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-2" aria-labelledby="own-identifiers-heading">
          <h3 id="own-identifiers-heading" className="text-sm font-semibold">{t.lookup.ownIdsTitle}</h3>
          <SummaryStrip testId="lookup-own-ids">
            <SummaryStat label={t.lookup.studentCodeLabel} value={<span className="break-all font-mono text-xl tabular-nums sm:text-2xl">{profile.studentCode ?? "-"}</span>} />
            <SummaryStat label={t.lookup.internalIdLabel} value={<span className="break-all font-mono text-xl tabular-nums sm:text-2xl">{profile.internalStudentId ?? "-"}</span>} />
          </SummaryStrip>
        </section>
        {crossLookupEnabled ? (
          <>
            <div className="border-t border-border pt-5">
              <div className="grid grid-cols-3 rounded-lg border border-border p-1" role="group" aria-label={t.lookup.studentModeLabel}>
                <Button type="button" variant={mode === "id-to-code" ? "default" : "ghost"} className="min-h-11 min-w-0 whitespace-normal px-2" aria-pressed={mode === "id-to-code"} onClick={() => setMode("id-to-code")}>{t.lookup.studentModeIdToCode}</Button>
                <Button type="button" variant={mode === "code-to-id" ? "default" : "ghost"} className="min-h-11 min-w-0 whitespace-normal px-2" aria-pressed={mode === "code-to-id"} onClick={() => setMode("code-to-id")}>{t.lookup.studentModeCodeToId}</Button>
                <Button type="button" variant={mode === "transcript" ? "default" : "ghost"} className="min-h-11 min-w-0 whitespace-normal px-2" aria-pressed={mode === "transcript"} onClick={() => setMode("transcript")}>{t.lookup.studentModeTranscript}</Button>
              </div>
            </div>
            {mode === "id-to-code" ? <CrossStudentCodeSection profile={profile} /> : mode === "code-to-id" ? <CrossStudentIdSection profile={profile} /> : <CrossTranscriptSection profile={profile} />}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BulkLookupResultRow({ item, mode }: { item: VnuBulkLookupItem; mode: VnuBulkLookupMode }) {
  const { t } = useLocale();
  if (item.status === "error") {
    const message = item.errorCode === "VNU_CROSS_LOOKUP_SELF_TARGET"
      ? t.lookup.bulkErrorSelf
      : item.errorCode === "VNU_CROSS_LOOKUP_NOT_FOUND" || item.errorCode === "VNU_CROSS_LOOKUP_NOT_CONVERGED"
        ? t.lookup.bulkErrorNotFound
        : item.errorCode === "VNU_CROSS_LOOKUP_INVALID_TARGET"
          ? t.lookup.bulkErrorInvalid
          : t.lookup.bulkErrorGeneric;
    return <div className="list-row flex-col items-stretch gap-1 sm:flex-row sm:items-center"><span className="break-all font-mono text-sm tabular-nums">{item.target}</span><span className="break-words text-sm text-muted-foreground sm:text-right">{message}</span></div>;
  }

  const result = item.result;
  let primary = "-";
  let secondary = t.lookup.bulkCompletedItem;
  if (mode === "stdid-to-code" && "studentCode" in result) {
    primary = result.studentCode ?? "-";
    secondary = [result.studentName, result.className].filter(Boolean).join(" · ") || t.lookup.bulkCompletedItem;
  } else if (mode === "code-to-stdid" && "stdId" in result) {
    primary = result.stdId;
    secondary = t.lookup.crossIdProbes(result.probes);
  } else if ("header" in result) {
    primary = result.header.studentCode ?? "-";
    const rowCount = result.terms.reduce((total, term) => total + term.rows.length, 0);
    secondary = t.lookup.bulkTranscriptRows(rowCount);
  }
  return (
    <div className="list-row flex-col items-stretch gap-2 sm:flex-row sm:items-center">
      <div className="min-w-0"><p className="break-all font-mono text-sm tabular-nums">{item.target}</p><p className="break-words text-xs text-muted-foreground">{secondary}</p></div>
      <Badge className="max-w-full self-start break-all border border-border bg-background font-mono font-normal tabular-nums text-foreground sm:shrink-0 sm:self-auto">{primary}</Badge>
    </div>
  );
}

function BulkLookupSection() {
  const { t } = useLocale();
  const state = useHyeboard();
  const [mode, setMode] = useState<VnuBulkLookupMode>("stdid-to-code");
  const [rawTargets, setRawTargets] = useState("");
  const [active, setActive] = useState(false);
  const [progress, setProgress] = useState<BulkLookupProgress>({ processed: 0, total: 0, items: [] });
  const [remainingTargets, setRemainingTargets] = useState<string[]>([]);
  const [requestError, setRequestError] = useState<string | undefined>();
  const abortController = useRef<AbortController | null>(null);
  const parsed = parseBulkTargets(rawTargets);
  const viewState = deriveBulkLookupViewState(parsed, active, progress.processed);

  const reset = () => {
    abortController.current?.abort();
    abortController.current = null;
    setActive(false);
    setRawTargets("");
    setProgress({ processed: 0, total: 0, items: [] });
    setRemainingTargets([]);
    setRequestError(undefined);
  };

  const run = async () => {
    if (parsed.error) return;
    const controller = new AbortController();
    abortController.current = controller;
    setActive(true);
    setRequestError(undefined);
    const retrying = remainingTargets.length > 0;
    const pendingTargets = retrying ? remainingTargets : parsed.targets;
    const initialProgress = retrying ? progress : { processed: 0, total: parsed.targets.length, items: [] };
    setProgress(initialProgress);
    try {
      await state.ensureSession();
      const execution = await executeBulkLookup({
        mode,
        targets: pendingTargets,
        signal: controller.signal,
        initialProgress,
        requestChunk: api.vnuCrossLookupBulk,
        onProgress: setProgress,
      });
      setProgress(execution.progress);
      setRemainingTargets(execution.remainingTargets);
      if (execution.error) setRequestError(execution.error instanceof ApiError ? execution.error.code : "VNU_CROSS_LOOKUP_FAILED");
    } catch (error) {
      if (!controller.signal.aborted) {
        setRemainingTargets(pendingTargets);
        setRequestError(error instanceof ApiError ? error.code : "VNU_CROSS_LOOKUP_FAILED");
      }
    } finally {
      if (abortController.current === controller) abortController.current = null;
      setActive(false);
    }
  };

  const validationMessage = parsed.error === "tooMany"
    ? t.lookup.bulkTooMany
    : t.lookup.bulkEmpty;
  const requestErrorMessage = requestError === "VNU_RATE_LIMITED"
    ? t.lookup.bulkRateLimited
    : requestError === "VNU_PROBE_BUDGET_UNAVAILABLE"
      ? t.lookup.bulkUnavailable
      : t.lookup.bulkRequestFailed;

  return (
    <Card data-testid="bulk-lookup" aria-busy={active}>
      <CardHeader>
        <CardTitle className="text-base">{t.lookup.bulkTitle}</CardTitle>
        <CardDescription>{t.lookup.bulkDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(12rem,0.45fr)_1fr]">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="bulk-lookup-mode">{t.lookup.bulkModeLabel}</label>
            <Select value={mode} onValueChange={(value) => { setMode(value as VnuBulkLookupMode); setProgress({ processed: 0, total: 0, items: [] }); setRemainingTargets([]); setRequestError(undefined); }} disabled={active}>
              <SelectTrigger id="bulk-lookup-mode" className="min-h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="stdid-to-code">{t.lookup.bulkModeIdToCode}</SelectItem>
                <SelectItem value="code-to-stdid">{t.lookup.bulkModeCodeToId}</SelectItem>
                <SelectItem value="stdid-to-transcript">{t.lookup.bulkModeIdToTranscript}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="bulk-lookup-targets">{t.lookup.bulkTargetsLabel}</label>
            <Textarea id="bulk-lookup-targets" className="min-h-32 font-mono" value={rawTargets} disabled={active} onChange={(event) => { setRawTargets(event.target.value); setProgress({ processed: 0, total: 0, items: [] }); setRemainingTargets([]); setRequestError(undefined); }} placeholder={t.lookup.bulkTargetsPlaceholder} aria-invalid={parsed.error === "tooMany"} />
          </div>
        </div>
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <Button type="button" className="min-h-11" disabled={active || Boolean(parsed.error)} onClick={() => void run()}>{remainingTargets.length ? t.lookup.bulkRetry : t.lookup.bulkRun}</Button>
          {active ? <Button type="button" variant="outline" className="min-h-11" onClick={() => abortController.current?.abort()}>{t.lookup.bulkCancel}</Button> : null}
          <Button type="button" variant="ghost" className="min-h-11" disabled={active && progress.processed === 0} onClick={reset}>{t.lookup.bulkReset}</Button>
        </div>

        <div className="min-h-20" aria-live="polite">{active ? <div className="space-y-2"><p id="bulk-lookup-progress-label" className="text-sm text-muted-foreground">{t.lookup.bulkProgress(progress.processed, progress.total)}</p><Progress value={progress.total ? progress.processed / progress.total * 100 : 0} aria-labelledby="bulk-lookup-progress-label" /></div> : null}
        {requestError ? <div role="alert"><Empty text={requestErrorMessage} /></div>
          : viewState === "empty" ? <Empty text={t.lookup.bulkEmpty} />
          : viewState === "validation" ? <Empty text={validationMessage} />
          : viewState === "loading" && progress.items.length === 0 ? <Empty text={t.lookup.bulkLoading} />
          : null}</div>
        {progress.items.length > 0 ? (
          <div aria-live="polite" className="max-h-[32rem] overflow-auto">
            <div className="flex items-center justify-between border-b border-border pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"><span>{t.lookup.bulkTargetColumn}</span><span>{viewState === "completed" ? t.lookup.bulkCompleted(progress.processed) : t.lookup.bulkProgress(progress.processed, progress.total)}</span></div>
            <div className="divide-y divide-border">{progress.items.map((item, index) => <BulkLookupResultRow key={`${item.target}-${index}`} item={item} mode={mode} />)}</div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function LookupPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const profileQuery = useQuery({
    queryKey: ["vnu-lookup-profile", state.universityId, state.sessionNonce],
    queryFn: async () => { await state.ensureSession(); return api.vnuOwnProfile(); },
  });
  // Fail-closed while the universities list is still loading: the section
  // only renders once the active university's capabilities affirmatively
  // claim crossLookup (vnu only — see the adapter honesty rule).
  const crossLookupEnabled = state.universities.data?.find((university) => university.id === state.universityId)?.capabilities.crossLookup === true;

  return (
    <FeatureFrame title={t.lookup.title} description={t.lookup.description} query={profileQuery}>
      {(profile) => (
        <div className="space-y-6">
          <ClassIdentifierTools />
          <StudentRecordTools profile={profile} crossLookupEnabled={crossLookupEnabled} />
          {crossLookupEnabled ? <BulkLookupSection /> : null}
        </div>
      )}
    </FeatureFrame>
  );
}
