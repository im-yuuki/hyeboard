import type { ApiResponse, Assignment, ClassSession, Course, DashboardSummary, DocumentItem, ExamSession, Grade, NewsItem, ServiceRequest, Term, TrainingPoint, TuitionStatus, University } from "@hyeboard/schemas";
import type { VnuExamCatalogRow, VnuPointDetail, VnuProfile, VnuTranscript } from "@hyeboard/university-adapters/src/vnu/types";
import { mapExamRow, mapGpaSummary, mapGradeRow, mapProfile, mapSyllabusRow, mapTerms, mapTrainingPoints } from "@hyeboard/university-adapters/src/vnu/mapper";
import { parseExamCatalogHtml, parseExamTermOptions, parseExamsHtml, parseGradesHtml, parsePointDetailHtml, parseProfileHtml, parseStudyProgressHtml, parseSyllabusHtml } from "@hyeboard/university-adapters/src/vnu/parser";
import { createLinkedAbortController } from "./abort-deadline";
import { canReauthenticateInline, requestInlineReauth } from "./reauth";
import { readUetSessionStream } from "./uet-session-stream";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
const SESSION_KEY = "hyeboard.sessionToken";
const ACCOUNTS_KEY = "hyeboard.accounts";
const ACTIVE_ACCOUNT_KEY = "hyeboard.activeAccountId";
const UET_LOGIN_DEADLINE_MS = 3 * 60_000;

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Only these codes mean the Hyeboard session itself is dead - everything else
// (e.g. a feature that needs a learning-platform credential the user never provided) is
// a feature-specific problem that should NOT log the user out of a session
// that is otherwise perfectly valid.
const SESSION_INVALID_CODES: ReadonlySet<string> = new Set(["MISSING_SESSION", "SESSION_EXPIRED", "INVALID_SESSION", "VNU_SESSION_EXPIRED"]);

export function isSessionDeathCode(code: string | undefined): boolean {
  return code !== undefined && SESSION_INVALID_CODES.has(code);
}

// Fired only when the LAST remaining account's session dies/is signed out -
// the app shell listens for this to bounce the user to /login. If other
// accounts remain, ACCOUNT_SWITCHED_EVENT fires instead (auto-switch, no
// redirect needed).
export const SESSION_CLEARED_EVENT = "hyeboard:session-cleared";

// Fired whenever the active account changes for any reason (explicit switch,
// a new account added via login, or an account removed while another one
// remains). The app shell listens for this to re-sync universityId/palette
// and refetch data for whichever account is now active.
export const ACCOUNT_SWITCHED_EVENT = "hyeboard:account-switched";

export type StoredAccount = {
  id: string;
  universityId: string;
  token: string;
  studentCode?: string;
  addedAt: string;
};

export class ApiError extends Error {
  constructor(message: string, public readonly code?: string, public readonly status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

function readAccounts(): StoredAccount[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    return raw ? (JSON.parse(raw) as StoredAccount[]) : [];
  } catch {
    return [];
  }
}

function writeAccounts(accounts: StoredAccount[]): void {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

// One-time migration for users who had a single session stored under the old
// scheme before multi-account support existed - preserves their login
// instead of silently signing them out on the next deploy.
function migrateLegacySessionIfNeeded(): void {
  if (readAccounts().length > 0) return;
  const legacyToken = sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(SESSION_KEY);
  if (!legacyToken) return;
  const legacyUniversityId = localStorage.getItem("hyeboard.universityId") ?? "uet";
  const account: StoredAccount = { id: uuid(), universityId: legacyUniversityId, token: legacyToken, addedAt: new Date().toISOString() };
  writeAccounts([account]);
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, account.id);
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY);
}

export function listAccounts(): StoredAccount[] {
  migrateLegacySessionIfNeeded();
  return readAccounts();
}

export function getActiveAccountId(): string | null {
  migrateLegacySessionIfNeeded();
  return localStorage.getItem(ACTIVE_ACCOUNT_KEY);
}

export function getActiveAccount(): StoredAccount | undefined {
  const id = getActiveAccountId();
  return id ? readAccounts().find((account) => account.id === id) : undefined;
}

// Adds a new account or, if one already exists for this university+student
// code, updates its token in place - either way it becomes the active
// account. This is what every login flow (Google automation, manual token,
// VNU, mock demo) calls on success, so logging into a different account
// never discards previously-saved ones.
export function upsertAccount(universityId: string, token: string, studentCode?: string): StoredAccount {
  const accounts = readAccounts();
  const matchIndex = accounts.findIndex((account) => account.universityId === universityId && (account.studentCode ?? "") === (studentCode ?? ""));
  const account: StoredAccount = matchIndex >= 0
    ? { ...accounts[matchIndex], token, studentCode: studentCode ?? accounts[matchIndex].studentCode }
    : { id: uuid(), universityId, token, studentCode, addedAt: new Date().toISOString() };
  if (matchIndex >= 0) accounts[matchIndex] = account;
  else accounts.push(account);
  writeAccounts(accounts);
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, account.id);
  window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT));
  return account;
}

export function switchAccount(id: string): void {
  if (!readAccounts().some((account) => account.id === id)) return;
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, id);
  window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT));
}

// Removes an account entirely (e.g. sign-out, or a dead session detected via
// a 401). If the removed account was the active one, auto-switches to
// another remaining account if any exist, otherwise fires
// SESSION_CLEARED_EVENT so the app bounces to /login.
export function removeAccount(id: string): void {
  const accounts = readAccounts().filter((account) => account.id !== id);
  writeAccounts(accounts);
  const activeId = localStorage.getItem(ACTIVE_ACCOUNT_KEY);
  if (activeId !== id) return;
  const next = accounts[0];
  if (next) {
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, next.id);
    window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT));
  } else {
    localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
    window.dispatchEvent(new CustomEvent(SESSION_CLEARED_EVENT));
  }
}

export function getSessionToken(): string | null {
  return getActiveAccount()?.token ?? null;
}

// Used only for silent token refresh (see meta.refreshedToken handling in
// request() below) - updates the active account's token in place without
// touching the accounts list or firing any switch event. New logins go
// through upsertAccount() instead.
export function setSessionToken(token: string): void {
  const activeId = getActiveAccountId();
  if (!activeId) return;
  const accounts = readAccounts();
  const index = accounts.findIndex((account) => account.id === activeId);
  if (index === -1) return;
  accounts[index] = { ...accounts[index], token };
  writeAccounts(accounts);
}

// Signs out of the active account only. If other accounts remain, switches
// to one of them instead of forcing a login redirect (see removeAccount).
export function clearSessionToken(): void {
  const activeId = getActiveAccountId();
  if (activeId) removeAccount(activeId);
  else window.dispatchEvent(new CustomEvent(SESSION_CLEARED_EVENT));
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getSessionToken();
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  let payload: ApiResponse<T>;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError(`Request failed: ${response.status} ${response.statusText}`, undefined, response.status);
  }
  if (!response.ok || payload.error) {
    const code = payload.error?.code;
    const sessionDied = isSessionDeathCode(code);
    // The worker's lazy upstream refresh can stall on a StudentHub CAPTCHA
    // its server-side OCR couldn't solve. With stored credentials that is
    // recoverable inline too, so it joins the re-auth path instead of
    // surfacing a dead-end error - but it never clears the session on its
    // own, because the Hyeboard session itself is still valid.
    const refreshNeedsCaptcha = code === "STUDENTHUB_CAPTCHA_REQUIRED";
    if (sessionDied || refreshNeedsCaptcha) {
      // A recoverable UET session death shows the inline re-auth dialog
      // (see components/reauth.tsx) instead of signing the user out.
      if (canReauthenticateInline(getActiveAccount()?.universityId)) requestInlineReauth();
      else if (sessionDied) clearSessionToken();
    }
    throw new ApiError(payload.error?.message ?? `Request failed: ${response.status}`, code, response.status);
  }
  // Silent session refresh: the worker may refresh an expired UET upstream
  // credential through Google automation or the parent direct CAPTCHA API,
  // then return a fresh encrypted token via meta.refreshedToken.
  const refreshedToken = payload.meta?.refreshedToken;
  if (typeof refreshedToken === "string" && refreshedToken) setSessionToken(refreshedToken);
  return payload.data as T;
}

function queryString(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const rendered = query.toString();
  return rendered ? `?${rendered}` : "";
}

async function vnuRaw(page: string, params: Record<string, string | undefined> = {}) {
  return request<{ html: string }>(`/api/vnu/raw/${page}${queryString(params)}`);
}

async function vnuDashboard(): Promise<DashboardSummary> {
  const [profilePage, gradesPage, progressPage] = await Promise.all([
    vnuRaw("profile"),
    vnuRaw("grades"),
    vnuRaw("progress"),
  ]);
  const profile = parseProfileHtml(profilePage.html);
  const grades = parseGradesHtml(gradesPage.html);
  const progress = parseStudyProgressHtml(progressPage.html);
  const terms = mapTerms(grades);
  return {
    student: mapProfile(profile, "vnu"),
    currentTerm: terms[0],
    todaySchedule: [],
    courses: [],
    assignments: [],
    grades: grades.rows.map(mapGradeRow),
    gpa: mapGpaSummary(grades, progress),
    exams: [],
    notifications: [],
  };
}

async function vnuTerms(): Promise<Term[]> {
  return mapTerms(parseGradesHtml((await vnuRaw("grades")).html));
}

async function vnuGrades(): Promise<Grade[]> {
  return parseGradesHtml((await vnuRaw("grades")).html).rows.map(mapGradeRow);
}

async function vnuExams(termCode?: string): Promise<ExamSession[]> {
  const basePage = await vnuRaw("exam-base");
  const options = parseExamTermOptions(basePage.html);
  const option = termCode
    ? options.find((item) => item.label.startsWith(`${termCode}.`))
    : (options.find((item) => item.selected) ?? options[0]);
  if (!option) return [];
  // selStd/selUniv are derived server-side from the session's own profile
  // (same hardening as point-detail) — the client only chooses the term.
  const page = await vnuRaw("exams", { vTermID: option.value });
  return parseExamsHtml(page.html).map(mapExamRow);
}

// Raw profile fetch for the Lookup page - needs the hidden internalStudentId
// (hidStdID) and internalUnivId fields that the schema-typed Student (see
// mapProfile) intentionally doesn't carry.
async function vnuOwnProfile(): Promise<VnuProfile> {
  return parseProfileHtml((await vnuRaw("profile")).html);
}

async function vnuClassCatalog(params: { vTermID: string }): Promise<VnuExamCatalogRow[]> {
  const page = await vnuRaw("exams", params);
  return parseExamCatalogHtml(page.html);
}

// Per-component grade breakdown for one of the student's OWN classes. The
// worker derives StdID from the session server-side — there is intentionally
// no stdId param here. val is omitted entirely: the popup footer only echoes
// it back unvalidated, so sending nothing keeps displayTotalEcho absent
// instead of surfacing a cosmetic number as if it were data.
async function vnuPointDetail(params: { id: string; Term: string }): Promise<VnuPointDetail> {
  const page = await vnuRaw("point-detail", params);
  return parsePointDetailHtml(page.html);
}

export type VnuCrossStudentCode = { studentCode?: string; studentName?: string; className?: string };

export type VnuCrossTranscript = Omit<VnuTranscript, "notice">;

function sanitizeCrossStudentCode(result: VnuCrossStudentCode): VnuCrossStudentCode {
  return { studentCode: result.studentCode, studentName: result.studentName, className: result.className };
}

function sanitizeCrossTranscript(result: VnuTranscript): VnuCrossTranscript {
  return { header: result.header, terms: result.terms, totals: result.totals };
}

// Cross-student StdID -> student-code resolver (crossLookup capability, vnu
// only). The dedicated worker route requires the explicit
// allowCrossLookup=true flag (sent here as the client-side acknowledgement),
// rejects self-targets, and never caches. The worker fetches the target
// student's transcript page (listpoint_Brc1.asp — the only verified
// student-role StdID -> identity source), parses the identity header itself,
// and returns only the resolved fields — their raw transcript HTML (and the
// grade table inside it) never reaches the client. A StdID that resolves to
// no identity header fails with the stable VNU_CROSS_LOOKUP_NOT_FOUND code.
async function vnuCrossStudentCode(params: { stdId: string }): Promise<VnuCrossStudentCode> {
  return sanitizeCrossStudentCode(await request<VnuCrossStudentCode>(`/api/vnu/cross-lookup/student-code${queryString({ stdId: params.stdId, allowCrossLookup: "true" })}`));
}

export type VnuCrossStudentId = { stdId: string; stdCode: string; probes: number };

// Cross-student student-code -> StdID resolver (crossLookup capability, vnu
// only) — the reverse direction of vnuCrossStudentCode. The worker walks the
// Brc1 oracle from the caller's own (StdID, code) anchor pair and returns
// the zero-padded 11-digit internal id plus how many probes the walk took.
// Same gating: explicit allowCrossLookup=true, self-target rejection, never
// cached. An unresolvable code fails with VNU_CROSS_LOOKUP_NOT_CONVERGED
// (surfaced as an inline empty state, not a session error).
async function vnuCrossStudentId(params: { stdCode: string }): Promise<VnuCrossStudentId> {
  return request<VnuCrossStudentId>(`/api/vnu/cross-lookup/student-id${queryString({ stdCode: params.stdCode, allowCrossLookup: "true" })}`);
}

export type VnuCrossTranscriptInput =
  | { mode: "stdId"; stdId: string }
  | { mode: "stdCode"; stdCode: string };

async function vnuCrossTranscript(input: VnuCrossTranscriptInput): Promise<VnuCrossTranscript> {
  const target = input.mode === "stdId" ? { stdId: input.stdId } : { stdCode: input.stdCode };
  return sanitizeCrossTranscript(await request<VnuTranscript>(`/api/vnu/cross-lookup/transcript${queryString({ ...target, allowCrossLookup: "true" })}`));
}

export type VnuBulkLookupMode = "stdid-to-code" | "code-to-stdid" | "stdid-to-transcript";
export type VnuBulkLookupResult = VnuCrossStudentCode | VnuCrossStudentId | VnuCrossTranscript;
export type VnuBulkLookupItem =
  | { target: string; status: "ok"; result: VnuBulkLookupResult }
  | { target: string; status: "error"; errorCode: string };

async function vnuCrossLookupBulk(mode: VnuBulkLookupMode, targets: string[], signal?: AbortSignal): Promise<VnuBulkLookupItem[]> {
  const response = await request<{ items: VnuBulkLookupItem[] }>("/api/vnu/cross-lookup/bulk", {
    method: "POST",
    body: JSON.stringify({ mode, targets, allowCrossLookup: true }),
    signal,
  });
  return response.items.map((item) => {
    if (item.status === "error") return item;
    if (mode === "stdid-to-code") return { ...item, result: sanitizeCrossStudentCode(item.result as VnuCrossStudentCode) };
    if (mode === "stdid-to-transcript") return { ...item, result: sanitizeCrossTranscript(item.result as VnuTranscript) };
    const result = item.result as VnuCrossStudentId;
    return { ...item, result: { stdId: result.stdId, stdCode: result.stdCode, probes: result.probes } };
  });
}

async function vnuDocuments(): Promise<DocumentItem[]> {
  return parseSyllabusHtml((await vnuRaw("syllabus")).html).map(mapSyllabusRow);
}

async function vnuTrainingPoints(): Promise<TrainingPoint[]> {
  return mapTrainingPoints(parseStudyProgressHtml((await vnuRaw("progress")).html));
}

export const api = {
  universities: () => request<University[]>("/api/universities"),
  dashboard: (universityId: string, termCode?: string) => universityId === "vnu" ? vnuDashboard() : request<DashboardSummary>(`/api/${universityId}/dashboard${termCode ? `?termCode=${encodeURIComponent(termCode)}` : ""}`),
  terms: (universityId: string) => universityId === "vnu" ? vnuTerms() : request<Term[]>(`/api/${universityId}/terms`),
  timetable: (universityId: string, termCode?: string) => request<ClassSession[]>(`/api/${universityId}/timetable${termCode ? `?termCode=${encodeURIComponent(termCode)}` : ""}`),
  courses: (universityId: string) => request<Course[]>(`/api/${universityId}/courses`),
  assignments: (universityId: string) => request<Assignment[]>(`/api/${universityId}/assignments`),
  grades: (universityId: string) => universityId === "vnu" ? vnuGrades() : request<Grade[]>(`/api/${universityId}/grades`),
  exams: (universityId: string, termCode?: string) => universityId === "vnu" ? vnuExams(termCode) : request<ExamSession[]>(`/api/${universityId}/exams${termCode ? `?termCode=${encodeURIComponent(termCode)}` : ""}`),
  documents: (universityId: string) => universityId === "vnu" ? vnuDocuments() : request<DocumentItem[]>(`/api/${universityId}/documents`),
  tuition: (universityId: string) => request<TuitionStatus>(`/api/${universityId}/tuition`),
  news: (universityId: string) => request<NewsItem[]>(`/api/${universityId}/news`),
  trainingPoints: (universityId: string) => universityId === "vnu" ? vnuTrainingPoints() : request<TrainingPoint[]>(`/api/${universityId}/training-points`),
  requests: (universityId: string) => request<ServiceRequest[]>(`/api/${universityId}/requests`),
  // vnu (daotao)-only class-code -> internal-id lookup tool - see the
  // classLookup capability flag, gated in the UI before these are called.
  vnuOwnProfile: () => vnuOwnProfile(),
  vnuClassCatalog: (params: { vTermID: string }) => vnuClassCatalog(params),
  vnuPointDetail: (params: { id: string; Term: string }) => vnuPointDetail(params),
  vnuCrossStudentCode: (params: { stdId: string }) => vnuCrossStudentCode(params),
  vnuCrossStudentId: (params: { stdCode: string }) => vnuCrossStudentId(params),
  vnuCrossTranscript: (input: VnuCrossTranscriptInput) => vnuCrossTranscript(input),
  vnuCrossLookupBulk: (mode: VnuBulkLookupMode, targets: string[], signal?: AbortSignal) => vnuCrossLookupBulk(mode, targets, signal),
  importSession: async (universityId: string, body: { studentCode?: string; studenthubGoogleCredential?: string; studenthubToken?: string; studenthubCookie?: string; canvasToken?: string; canvasCookie?: string; canvasCsrfToken?: string; vnuUsername?: string; vnuPassword?: string }) => {
    const data = await request<{ token: string; session?: { studentCode?: string } }>(`/api/${universityId}/auth/import-session`, { method: "POST", body: JSON.stringify(body) });
    upsertAccount(universityId, data.token, data.session?.studentCode);
    return data;
  },
  // UET Google automation can take 90s+; parent direct login may pause for a
  // human CAPTCHA answer. Both use the Worker's SSE route. VNU, manual
  // token/cookie, and mock imports use the plain JSON request above.
  importUetGoogleSession: async (
    body: { uetGoogleEmail: string; uetGooglePassword: string; uetGoogleCookies?: unknown },
    onProgress?: (message: string) => void,
    // Called when the parent/guardian direct-login flow hits a CAPTCHA that
    // server-side OCR couldn't confidently solve (see the adapter's
    // Worker-safe CAPTCHA resolver). Resolve with the user's typed answer.
    // The signal aborts if the stream fails or closes before submission.
    onCaptchaNeeded?: (imageDataUrl: string, signal: AbortSignal) => Promise<string>,
    callerSignal?: AbortSignal,
  ) => {
    const linkedAbort = createLinkedAbortController(
      callerSignal,
      UET_LOGIN_DEADLINE_MS,
      new ApiError("Sign-in was cancelled.", "UET_LOGIN_CANCELLED", 499),
      new ApiError("Sign-in took longer than three minutes and was cancelled.", "GOOGLE_AUTOMATION_TIMEOUT", 408),
    );
    try {
      const token = getSessionToken();
      const response = await fetch(`${API_BASE_URL}/api/uet/auth/import-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: linkedAbort.signal,
      });
      if (!response.ok || !response.body) {
        // Errors thrown before the stream starts (rate limiting, missing
        // server config) still come back as plain JSON, not SSE.
        let payload: ApiResponse<unknown> | undefined;
        try {
          payload = (await response.json()) as ApiResponse<unknown>;
        } catch {
          // Body wasn't JSON either — fall through to the generic error below.
        }
        throw new ApiError(payload?.error?.message ?? `Request failed: ${response.status}`, payload?.error?.code, response.status);
      }
      const reader = response.body.getReader();
      const data = await readUetSessionStream(reader, {
        onProgress,
        onCaptchaNeeded,
        submitCaptcha: (challengeId, answer) => request("/api/uet/auth/solve-captcha", {
          method: "POST",
          body: JSON.stringify({ challengeId, answer }),
          signal: linkedAbort.signal,
        }),
        createError: (message, code, status) => new ApiError(message, code, status),
      });
      upsertAccount("uet", data.token, data.session?.studentCode);
      return { token: data.token };
    } catch (error) {
      if (linkedAbort.signal.aborted && linkedAbort.signal.reason instanceof Error) throw linkedAbort.signal.reason;
      throw error;
    } finally {
      linkedAbort.dispose();
    }
  },
  // Best-effort server-side revocation (also invalidates any persisted uetGoogleCredential
  // embedded in the token). Must never throw - logout has to succeed locally even if this
  // network call fails, so callers should not need to wrap this in their own try/catch.
  logout: async (universityId: string) => {
    try {
      await request<{ authenticated: false }>(`/api/${universityId}/auth/logout`, { method: "POST" });
    } catch {
      // Ignore - the local session is cleared regardless of server-side outcome.
    }
  },
};
