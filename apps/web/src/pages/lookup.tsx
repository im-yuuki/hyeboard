import type { VnuExamCatalogRow, VnuExamTermInfo, VnuProfile } from "@hyeboard/university-adapters/src/vnu/types";
import { VNU_EXAM_TERMS } from "@hyeboard/university-adapters/src/vnu/exam-terms";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, FeatureFrame, SummaryStat, SummaryStrip } from "@/components/shared";
import { api, ApiError } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { useHyeboard } from "@/state";

// Newest first - matches the convention every other term picker in the app
// uses (see mapTerms in the vnu mapper). VNU_EXAM_TERMS itself stays
// oldest-first, matching how the static table was verified.
const TERMS_NEWEST_FIRST: readonly VnuExamTermInfo[] = [...VNU_EXAM_TERMS].reverse();

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
    <div className="list-row">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{row.courseCode}{row.classNo ? ` · ${row.classNo}` : ""} — {row.courseName}</p>
        <p className="truncate text-xs text-muted-foreground">{row.examDate || "-"}{row.room ? ` · ${row.room}` : ""}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge className="border border-border bg-background font-mono font-normal text-foreground">{row.classId}</Badge>
        <Button type="button" variant="outline" size="sm" aria-expanded={expanded} onClick={onToggleDetail}>{t.lookup.pointDetailAction}</Button>
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
  if (detailQuery.error) return <p className="py-2 text-sm text-muted-foreground">{detailQuery.error.message}</p>;
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
              <p className="truncate text-sm font-medium">{component.index}. {component.nature}</p>
              <p className="truncate text-xs text-muted-foreground">
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
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{t.lookup.resolverTitle}</h2>
        <p className="text-sm text-muted-foreground">{t.lookup.resolverDescription}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input value={courseCode} onChange={(event) => setCourseCode(event.target.value)} placeholder={t.lookup.courseCodePlaceholder} aria-label={t.lookup.courseCodeLabel} />
        <Input value={classNo} onChange={(event) => setClassNo(event.target.value)} placeholder={t.lookup.classNoPlaceholder} aria-label={t.lookup.classNoLabel} />
        <Select value={termOrdinal ?? ""} onValueChange={(value) => { setTermOrdinal(value); setExpandedClassId(null); }}>
          <SelectTrigger aria-label={t.lookup.termFieldLabel}><SelectValue placeholder={t.lookup.termPlaceholder} /></SelectTrigger>
          <SelectContent>
            {TERMS_NEWEST_FIRST.map((term) => <SelectItem key={term.ordinal} value={term.ordinal}>{t.lookup.termLabel(term)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div data-testid="lookup-results">
        {!termOrdinal ? (
          <Empty text={t.lookup.selectTermPrompt} />
        ) : catalogQuery.isLoading ? (
          <Skeleton className="h-40" />
        ) : catalogQuery.error ? (
          <p className="text-sm text-muted-foreground">{catalogQuery.error.message}</p>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t.lookup.resultsTitle}</CardTitle>
              <CardDescription>{t.lookup.resultsCount(filteredRows.length)}</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
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
            </CardContent>
          </Card>
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
    <div className="list-row">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{row.courseCode}{row.classNo ? ` · ${row.classNo}` : ""} — {row.courseName}</p>
        <p className="truncate text-xs text-muted-foreground">{meta || "-"}</p>
      </div>
      <Badge className="shrink-0 border border-border bg-background font-mono font-normal text-foreground">{row.classId}</Badge>
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
    <div className="space-y-3" data-testid="reverse-class-lookup">
      <div>
        <h2 className="text-base font-semibold">{t.lookup.reverseTitle}</h2>
        <p className="text-sm text-muted-foreground">{t.lookup.reverseDescription}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input value={classId} onChange={(event) => setClassId(event.target.value)} placeholder={t.lookup.reverseClassIdPlaceholder} aria-label={t.lookup.reverseClassIdLabel} />
        <Select value={termOrdinal ?? ""} onValueChange={setTermOrdinal}>
          <SelectTrigger aria-label={t.lookup.termFieldLabel}><SelectValue placeholder={t.lookup.termPlaceholder} /></SelectTrigger>
          <SelectContent>
            {TERMS_NEWEST_FIRST.map((term) => <SelectItem key={term.ordinal} value={term.ordinal}>{t.lookup.termLabel(term)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div>
        {!termOrdinal ? (
          <Empty text={t.lookup.selectTermPrompt} />
        ) : catalogQuery.isLoading ? (
          <Skeleton className="h-40" />
        ) : catalogQuery.error ? (
          <p className="text-sm text-muted-foreground">{catalogQuery.error.message}</p>
        ) : !trimmedClassId ? (
          <Empty text={t.lookup.reverseEnterIdPrompt} />
        ) : !matchedRows.length ? (
          <Empty text={t.lookup.reverseNoMatch} />
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t.lookup.resultsTitle}</CardTitle>
              <CardDescription>{t.lookup.resultsCount(matchedRows.length)}</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <span>{t.lookup.headers[0]}</span>
                <span>{t.lookup.headers[1]}</span>
              </div>
              <div className="divide-y divide-border">
                {matchedRows.map((row, index) => <ReverseClassResultRow key={`${row.classId}-${index}`} row={row} />)}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
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
  const isSelfTarget = Boolean(trimmedStdId) && trimmedStdId === profile.internalStudentId;

  const codeQuery = useQuery({
    queryKey: ["vnu-cross-student-code", state.universityId, state.sessionNonce, submitted],
    queryFn: async () => {
      await state.ensureSession();
      return api.vnuCrossStudentCode(submitted!);
    },
    enabled: Boolean(submitted),
  });

  const submit = () => {
    if (!trimmedStdId || isSelfTarget) return;
    setSubmitted({ stdId: trimmedStdId });
  };

  const result = codeQuery.data;

  return (
    <Card data-testid="cross-student-code">
      <CardHeader>
        <CardTitle className="text-base">{t.lookup.crossCodeTitle}</CardTitle>
        <CardDescription>{t.lookup.crossCodeDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input value={stdId} onChange={(event) => setStdId(event.target.value)} placeholder={t.lookup.crossStdIdPlaceholder} aria-label={t.lookup.crossStdIdLabel} />
          <Button type="button" onClick={submit} disabled={!trimmedStdId || isSelfTarget}>{t.lookup.crossSubmit}</Button>
        </div>
        {isSelfTarget ? <Empty text={t.lookup.crossCodeSelfTarget} /> : null}
        {!isSelfTarget && submitted ? (
          codeQuery.isLoading ? (
            <Skeleton className="h-20" />
          ) : codeQuery.error ? (
            <p className="text-sm text-muted-foreground">{codeQuery.error.message}</p>
          ) : result?.notice ? (
            <Empty text={result.notice} />
          ) : !result?.studentCode ? (
            <Empty text={t.lookup.crossCodeNotFound} />
          ) : (
            <div className="divide-y divide-border">
              <div className="list-row">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{result.studentName ?? t.lookup.crossCodeResolvedTitle}</p>
                  <p className="truncate text-xs text-muted-foreground">{[t.lookup.crossCodeResolvedFrom(submitted.stdId), result.className || undefined].filter(Boolean).join(" · ")}</p>
                </div>
                <Badge className="shrink-0 border border-border bg-background font-mono font-normal text-foreground">{result.studentCode}</Badge>
              </div>
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
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
  const isSelfTarget = Boolean(trimmedStdCode) && trimmedStdCode === profile.studentCode;

  const idQuery = useQuery({
    queryKey: ["vnu-cross-student-id", state.universityId, state.sessionNonce, submitted],
    queryFn: async () => {
      await state.ensureSession();
      return api.vnuCrossStudentId(submitted!);
    },
    enabled: Boolean(submitted),
  });

  const submit = () => {
    if (!trimmedStdCode || isSelfTarget) return;
    setSubmitted({ stdCode: trimmedStdCode });
  };

  const result = idQuery.data;
  const notConverged = idQuery.error instanceof ApiError && idQuery.error.code === "VNU_CROSS_LOOKUP_NOT_CONVERGED";

  return (
    <Card data-testid="cross-student-id">
      <CardHeader>
        <CardTitle className="text-base">{t.lookup.crossIdTitle}</CardTitle>
        <CardDescription>{t.lookup.crossIdDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input value={stdCode} onChange={(event) => setStdCode(event.target.value)} placeholder={t.lookup.crossIdStdCodePlaceholder} aria-label={t.lookup.crossIdStdCodeLabel} />
          <Button type="button" onClick={submit} disabled={!trimmedStdCode || isSelfTarget}>{t.lookup.crossSubmit}</Button>
        </div>
        {isSelfTarget ? <Empty text={t.lookup.crossIdSelfTarget} /> : null}
        {!isSelfTarget && submitted ? (
          idQuery.isLoading ? (
            <Skeleton className="h-20" />
          ) : notConverged ? (
            <Empty text={t.lookup.crossIdNotConverged} />
          ) : idQuery.error ? (
            <p className="text-sm text-muted-foreground">{idQuery.error.message}</p>
          ) : result ? (
            <div className="divide-y divide-border">
              <div className="list-row">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.lookup.crossIdResolvedTitle}</p>
                  <p className="truncate text-xs text-muted-foreground">{[t.lookup.crossIdResolvedFrom(result.stdCode), t.lookup.crossIdProbes(result.probes)].join(" · ")}</p>
                </div>
                <Badge className="shrink-0 border border-border bg-background font-mono font-normal text-foreground">{result.stdId}</Badge>
              </div>
            </div>
          ) : null
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
          <div className="space-y-2">
            <h2 className="text-base font-semibold">{t.lookup.ownIdsTitle}</h2>
            <p className="text-sm text-muted-foreground">{t.lookup.ownIdsDescription}</p>
            <SummaryStrip testId="lookup-own-ids">
              <SummaryStat label={t.lookup.studentCodeLabel} value={profile.studentCode ?? "-"} />
              <SummaryStat label={t.lookup.internalIdLabel} value={profile.internalStudentId ?? "-"} />
            </SummaryStrip>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span>{t.lookup.internalIdLabel}</span>
              <span className="font-mono font-medium text-foreground">{profile.internalStudentId ?? "-"}</span>
              <ArrowLeftRight size={14} aria-hidden="true" />
              <span>{t.lookup.studentCodeLabel}</span>
              <span className="font-mono font-medium text-foreground">{profile.studentCode ?? "-"}</span>
            </p>
          </div>
          <ClassResolver />
          <ReverseClassResolver />
          {crossLookupEnabled ? <CrossStudentCodeSection profile={profile} /> : null}
          {crossLookupEnabled ? <CrossStudentIdSection profile={profile} /> : null}
        </div>
      )}
    </FeatureFrame>
  );
}
