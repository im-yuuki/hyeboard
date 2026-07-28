import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, commitVnuRefresh, getActiveAccount, isSessionDeathCode, listAccounts, shouldInvalidateVnuRefreshQuery, shouldRetryQuery, switchAccount, VNU_REFRESH_COMMITTED_EVENT, type StoredAccount } from "./api";
import { ApiError as SharedApiError, markVnuRefreshAttempted, wasVnuRefreshAttempted } from "./api-types";
import { readVnuRefreshGrant, storeVnuRefreshGrant, VNU_REQUEST_NOT_REPLAYED } from "./vnu-refresh";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const ACCOUNT: StoredAccount = {
  id: "vnu-account",
  universityId: "vnu",
  token: "stored-session-token",
  studentCode: "SYNTHETIC-STUDENT",
  addedAt: "2026-07-27T00:00:00.000Z",
};

const SECOND_ACCOUNT: StoredAccount = {
  id: "vnu-account-99",
  universityId: "vnu",
  token: "stored-session-token-99",
  studentCode: "SYNTHETIC-STUDENT-99",
  addedAt: "2099-12-31T00:00:00.000Z",
};

const UET_ACCOUNT: StoredAccount = {
  ...ACCOUNT,
  id: "uet-account",
  universityId: "uet",
  token: "stored-uet-session-token",
};

function seedAccount(): void {
  localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT]));
  localStorage.setItem("hyeboard.activeAccountId", ACCOUNT.id);
}

function rejectNextRequest(code: string, status: number): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    data: null,
    error: { code, message: `Synthetic ${code}` },
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  })));
}

async function requestCrossLookup(): Promise<void> {
  await api.vnuCrossStudentId({ stdCode: "SYNTHETIC-STUDENT" });
}

describe("frontend session-death policy", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("CustomEvent", class<T = unknown> {
      readonly detail: T | null;
      constructor(readonly type: string, init?: CustomEventInit<T>) {
        this.detail = init?.detail ?? null;
      }
    });
    seedAccount();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["VNU_RATE_LIMITED", "VNU_PROBE_BUDGET_UNAVAILABLE"])("preserves stored session and account state for %s", async (code) => {
    rejectNextRequest(code, code === "VNU_RATE_LIMITED" ? 429 : 503);

    await expect(requestCrossLookup()).rejects.toMatchObject({ code });

    expect(isSessionDeathCode(code)).toBe(false);
    expect(listAccounts()).toEqual([ACCOUNT]);
    expect(getActiveAccount()).toEqual(ACCOUNT);
    expect(localStorage.getItem("hyeboard.activeAccountId")).toBe(ACCOUNT.id);
  });

  it("keeps a code-less 401 inline without removing the account", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: null,
      error: { message: "Synthetic code-less failure" },
    }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(requestCrossLookup()).rejects.toMatchObject({ code: undefined, status: 401 });
    expect(listAccounts()).toEqual([ACCOUNT]);
    expect(getActiveAccount()).toEqual(ACCOUNT);
  });

  it.each(["MISSING_SESSION", "SESSION_EXPIRED", "INVALID_SESSION"])("clears stored state for genuine session-death code %s", async (code) => {
    rejectNextRequest(code, 401);

    await expect(requestCrossLookup()).rejects.toMatchObject({ code });

    expect(isSessionDeathCode(code)).toBe(true);
    expect(listAccounts()).toEqual([]);
    expect(getActiveAccount()).toBeUndefined();
    expect(localStorage.getItem("hyeboard.activeAccountId")).toBeNull();
  });

  it("removes the originating account when bulk lookup returns top-level VNU_SESSION_EXPIRED", async () => {
    rejectNextRequest("VNU_SESSION_EXPIRED", 401);

    await expect(api.vnuCrossLookupBulk("stdid-to-transcript", ["1001", "1002"])).rejects.toMatchObject({
      code: "VNU_SESSION_EXPIRED",
    });

    expect(isSessionDeathCode("VNU_SESSION_EXPIRED")).toBe(false);
    expect(listAccounts()).toEqual([]);
    expect(getActiveAccount()).toBeUndefined();
    expect(localStorage.getItem("hyeboard.activeAccountId")).toBeNull();
  });

  it("strips upstream notice prose from every cross-lookup response shape", async () => {
    const upstreamNoticeSentinel = "UPSTREAM_NOTICE_SENTINEL_DO_NOT_EXPOSE";
    const transcript = {
      header: { studentCode: "20000001" },
      terms: [{ maHK: "251", rows: [] }],
      totals: {},
      notice: upstreamNoticeSentinel,
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { studentCode: "20000001", notice: upstreamNoticeSentinel }, error: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: transcript, error: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [{ target: "1001", status: "ok", result: transcript }] }, error: null }))));

    const studentCode = await api.vnuCrossStudentCode({ stdId: "1001" });
    const crossTranscript = await api.vnuCrossTranscript({ mode: "stdId", stdId: "1001" });
    const bulk = await api.vnuCrossLookupBulk("stdid-to-transcript", ["1001"]);

    expect(JSON.stringify({ studentCode, crossTranscript, bulk })).not.toContain(upstreamNoticeSentinel);
    expect(studentCode).toEqual({ studentCode: "20000001", studentName: undefined, className: undefined });
    expect(crossTranscript).not.toHaveProperty("notice");
    expect(bulk[0]?.status === "ok" ? bulk[0].result : undefined).not.toHaveProperty("notice");
  });

  it("removes only the inactive originating UET account when its request dies late", async () => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([UET_ACCOUNT, SECOND_ACCOUNT]));
    localStorage.setItem("hyeboard.activeAccountId", UET_ACCOUNT.id);
    let releaseResponse!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { releaseResponse = resolve; })));

    const pending = requestCrossLookup();
    switchAccount(SECOND_ACCOUNT.id);
    releaseResponse(new Response(JSON.stringify({ data: null, error: { code: "INVALID_SESSION", message: "Synthetic expired request" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(pending).rejects.toMatchObject({ code: "INVALID_SESSION" });
    expect(getActiveAccount()).toEqual(SECOND_ACCOUNT);
    expect(listAccounts()).toEqual([SECOND_ACCOUNT]);
  });

  it("writes a late refresh to the unchanged originating account after an account switch", async () => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT, SECOND_ACCOUNT]));
    let releaseResponse!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { releaseResponse = resolve; })));

    const pending = requestCrossLookup();
    switchAccount(SECOND_ACCOUNT.id);
    releaseResponse(new Response(JSON.stringify({
      data: { stdCode: "SYNTHETIC-STUDENT", stdId: "99000000101", probes: 1 },
      error: null,
      meta: { refreshedToken: "late-refreshed-session-token" },
    }), { headers: { "Content-Type": "application/json" } }));

    await expect(pending).resolves.toBeUndefined();
    expect(getActiveAccount()).toEqual(SECOND_ACCOUNT);
    expect(listAccounts()).toEqual([{ ...ACCOUNT, token: "late-refreshed-session-token" }, SECOND_ACCOUNT]);
  });

  it("does not overwrite a same-account relogin with a late refresh", async () => {
    let releaseResponse!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { releaseResponse = resolve; })));

    const pending = requestCrossLookup();
    const reloggedAccount = { ...ACCOUNT, token: "relogged-session-token" };
    localStorage.setItem("hyeboard.accounts", JSON.stringify([reloggedAccount]));
    releaseResponse(new Response(JSON.stringify({
      data: { stdCode: "SYNTHETIC-STUDENT", stdId: "99000000101", probes: 1 },
      error: null,
      meta: { refreshedToken: "stale-refreshed-session-token" },
    }), { headers: { "Content-Type": "application/json" } }));

    await expect(pending).resolves.toBeUndefined();
    expect(getActiveAccount()).toEqual(reloggedAccount);
  });

  it("does not remove a same-account relogin when the old request expires late", async () => {
    let releaseResponse!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { releaseResponse = resolve; })));

    const pending = requestCrossLookup();
    const reloggedAccount = { ...ACCOUNT, token: "relogged-session-token" };
    localStorage.setItem("hyeboard.accounts", JSON.stringify([reloggedAccount]));
    releaseResponse(new Response(JSON.stringify({
      data: null,
      error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic old session expiry" },
    }), { status: 401, headers: { "Content-Type": "application/json" } }));

    await expect(pending).rejects.toMatchObject({ code: "VNU_SESSION_EXPIRED" });
    expect(listAccounts()).toEqual([reloggedAccount]);
    expect(getActiveAccount()).toEqual(reloggedAccount);
  });

  it("still applies a refresh to the unchanged initiating account", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { stdCode: "SYNTHETIC-STUDENT", stdId: "99000000101", probes: 1 },
      error: null,
      meta: { refreshedToken: "same-account-refreshed-token" },
    }), { headers: { "Content-Type": "application/json" } })));

    await requestCrossLookup();

    expect(getActiveAccount()).toEqual({ ...ACCOUNT, token: "same-account-refreshed-token" });
  });

  it("re-exports one ApiError identity and keeps refresh marker private", () => {
    expect(ApiError).toBe(SharedApiError);
    const error = new ApiError("Synthetic failure", "VNU_REFRESH_UNAVAILABLE", 503, { retryAfterSeconds: 7 });
    expect(error).toBeInstanceOf(SharedApiError);
    expect(markVnuRefreshAttempted(error)).toBe(error);
    expect(wasVnuRefreshAttempted(error)).toBe(true);
    expect(error.details).toEqual({ retryAfterSeconds: 7 });
    expect(Object.keys(error)).not.toContain("vnuRefreshAttempted");
    expect(JSON.stringify(error)).not.toContain("vnuRefreshAttempted");
  });

  it("propagates sanitized worker details into ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: null,
      error: { code: "VNU_RATE_LIMITED", message: "Synthetic limited", details: { retryAfterSeconds: 9, limit: 5, windowSeconds: 900, privateToken: "must-not-propagate" } },
    }), { status: 429, headers: { "Content-Type": "application/json" } })));

    const error = await requestCrossLookup().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ details: { retryAfterSeconds: 9, limit: 5, windowSeconds: 900 } });
    expect((error as ApiError).details).toEqual({ retryAfterSeconds: 9, limit: 5, windowSeconds: 900 });
    expect(JSON.stringify(error)).not.toContain("privateToken");
  });

  it("preserves only allowed details from a plain-JSON UET stream-start error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: null,
      error: {
        code: "UET_UPSTREAM_UNAVAILABLE",
        message: "Synthetic pre-stream failure",
        details: {
          retryAfterSeconds: 11,
          limit: 5,
          windowSeconds: 900,
          privateToken: "must-not-propagate",
          internalReason: "must-not-propagate",
        },
      },
    }), { status: 503, headers: { "Content-Type": "application/json" } })));

    const error = await api.importUetGoogleSession({
      uetGoogleEmail: "synthetic-user@example.invalid",
      uetGooglePassword: "synthetic-password",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "UET_UPSTREAM_UNAVAILABLE",
      status: 503,
      details: { retryAfterSeconds: 11, limit: 5, windowSeconds: 900 },
    });
    expect((error as ApiError).details).toEqual({ retryAfterSeconds: 11, limit: 5, windowSeconds: 900 });
    expect(JSON.stringify(error)).not.toContain("privateToken");
    expect(JSON.stringify(error)).not.toContain("internalReason");
  });

  it("refreshes one safe GET then replays once with rotated token and preserved options", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        token: "rotated-token-alpha",
        refreshGrant: "rotated-grant-alpha",
        session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
      }, error: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], error: null })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.timetable("vnu", "SYNTHETIC-TERM")).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/vnu/timetable?termCode=SYNTHETIC-TERM");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/vnu/auth/refresh");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(fetchMock.mock.calls[0]?.[0]);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${ACCOUNT.token}` });
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer rotated-token-alpha" });
    expect(getActiveAccount()?.token).toBe("rotated-token-alpha");
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("rotated-grant-alpha");
    const committedEvents = vi.mocked(window.dispatchEvent).mock.calls
      .map(([event]) => event as unknown as { type: string; detail: unknown })
      .filter((event) => event.type === VNU_REFRESH_COMMITTED_EVENT);
    expect(committedEvents).toEqual([{ type: VNU_REFRESH_COMMITTED_EVENT, detail: { accountId: ACCOUNT.id } }]);
  });

  it("replays a safe GET at most once when the rotated token also expires", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic initial expiry" } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        token: "rotated-token-alpha",
        refreshGrant: "rotated-grant-alpha",
        session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
      }, error: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic replay expiry" } }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await api.timetable("vnu").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "VNU_SESSION_EXPIRED" });
    expect(wasVnuRefreshAttempted(error)).toBe(true);
    expect(shouldRetryQuery(0, error)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/vnu/auth/refresh"))).toHaveLength(1);
  });

  it.each([
    ["charged GET", () => api.vnuCrossStudentId({ stdCode: "SYNTHETIC-STUDENT" })],
    ["bulk POST", () => api.vnuCrossLookupBulk("code-to-stdid", ["SYNTHETIC-STUDENT"])],
  ])("refreshes %s but never replays it", async (_label, invoke) => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        token: "rotated-token-alpha",
        refreshGrant: "rotated-grant-alpha",
        session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
      }, error: null })));
    vi.stubGlobal("fetch", fetchMock);

    const rejection = invoke();
    await expect(rejection).rejects.toMatchObject({ code: VNU_REQUEST_NOT_REPLAYED });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never refreshes auth or unlisted non-GET requests", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    rejectNextRequest("VNU_SESSION_EXPIRED", 401);

    await expect(api.importSession("vnu", { vnuUsername: "synthetic-user", vnuPassword: "synthetic-password" })).rejects.toMatchObject({ code: "VNU_SESSION_EXPIRED" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
  });

  it.each(["switch", "replace", "remove", "manual-relogin"])("does not replay or signal success after a %s race", async (race) => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    let releaseRefresh!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseRefresh = resolve; }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = api.vnuCrossStudentId({ stdCode: "SYNTHETIC-STUDENT" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    if (race === "switch") {
      localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT, SECOND_ACCOUNT]));
      localStorage.setItem("hyeboard.activeAccountId", SECOND_ACCOUNT.id);
    }
    if (race === "replace") {
      localStorage.setItem("hyeboard.accounts", JSON.stringify([{ ...ACCOUNT, token: "replacement-token" }]));
    }
    if (race === "remove") {
      localStorage.setItem("hyeboard.accounts", "[]");
      localStorage.removeItem("hyeboard.activeAccountId");
      sessionStorage.removeItem(`hyeboard.vnu.refreshGrant.${ACCOUNT.id}`);
    }
    if (race === "manual-relogin") {
      localStorage.setItem("hyeboard.accounts", JSON.stringify([{ ...ACCOUNT, token: "manual-relogin-token" }]));
      storeVnuRefreshGrant(ACCOUNT.id, "manual-relogin-grant");
    }
    const grantBeforeRelease = readVnuRefreshGrant(ACCOUNT.id);
    const accountsBeforeRelease = localStorage.getItem("hyeboard.accounts");
    const dispatchEvent = vi.mocked(window.dispatchEvent);
    dispatchEvent.mockClear();

    releaseRefresh(new Response(JSON.stringify({ data: {
      token: "late-rotated-token",
      refreshGrant: "late-rotated-grant",
      session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
    }, error: null })));

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "VNU_SESSION_EXPIRED" });
    expect(error).not.toMatchObject({ code: VNU_REQUEST_NOT_REPLAYED });
    expect(wasVnuRefreshAttempted(error)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("hyeboard.accounts")).toBe(accountsBeforeRelease);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe(grantBeforeRelease);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it.each([
    [429, "VNU_REFRESH_RATE_LIMITED"],
    [503, "VNU_REFRESH_UNAVAILABLE"],
    [502, "VNU_UPSTREAM_UNAVAILABLE"],
  ])("marks refresh HTTP %s so Query does not retry", async (status, code) => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code, message: "Synthetic refresh failure" } }), { status }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await api.timetable("vnu").catch((caught: unknown) => caught);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ code });
    expect(wasVnuRefreshAttempted(error)).toBe(true);
    expect(shouldRetryQuery(0, error)).toBe(false);
    expect(listAccounts()).toEqual([ACCOUNT]);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
  });

  it("normalizes and marks refresh network failure without Query retry", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }))
      .mockRejectedValueOnce(new TypeError("synthetic offline"));
    vi.stubGlobal("fetch", fetchMock);

    const error = await api.timetable("vnu").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "VNU_REFRESH_NETWORK_ERROR", status: 503 });
    expect(wasVnuRefreshAttempted(error)).toBe(true);
    expect(shouldRetryQuery(0, error)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows one Query retry only for unrelated unmarked transient failures", () => {
    const transient = new ApiError("Synthetic transient", "UNRELATED_TRANSIENT", 503);
    expect(shouldRetryQuery(0, transient)).toBe(true);
    expect(shouldRetryQuery(1, transient)).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("dead", "INVALID_SESSION", 401))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("manual", VNU_REQUEST_NOT_REPLAYED))).toBe(false);
  });

  it("suppresses Query retry for both exact unmarked recovery triggers", () => {
    expect(shouldRetryQuery(0, new ApiError("expired", "VNU_SESSION_EXPIRED", 401))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("missing", "VNU_LOGIN_REQUIRED", 401, { reason: "MISSING_VNU_CREDENTIAL" }))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("broad", "VNU_LOGIN_REQUIRED", 401))).toBe(true);
    expect(shouldRetryQuery(0, new ApiError("profile", "VNU_PROFILE_INCOMPLETE", 500))).toBe(true);
  });

  it("does not retry or remove a switched origin when no refresh grant exists", async () => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT, SECOND_ACCOUNT]));
    localStorage.setItem("hyeboard.activeAccountId", ACCOUNT.id);
    let releaseResponse!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { releaseResponse = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = api.timetable("vnu");
    switchAccount(SECOND_ACCOUNT.id);
    releaseResponse(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }));

    const error = await pending.catch((caught: unknown) => caught);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: "VNU_SESSION_EXPIRED" });
    expect(shouldRetryQuery(0, error)).toBe(false);
    expect(listAccounts()).toEqual([ACCOUNT, SECOND_ACCOUNT]);
    expect(getActiveAccount()).toEqual(SECOND_ACCOUNT);
  });

  it("invalidates only active queries belonging to the recovered VNU account", () => {
    const query = (queryKey: readonly unknown[], active = true) => ({ queryKey, isActive: () => active });
    expect(shouldInvalidateVnuRefreshQuery(query(["dashboard", "vnu", undefined, 4]), ACCOUNT.id, ACCOUNT.id)).toBe(true);
    expect(shouldInvalidateVnuRefreshQuery(query(["grades", "vnu", "SYNTHETIC-TERM", 4]), ACCOUNT.id, ACCOUNT.id)).toBe(true);
    expect(shouldInvalidateVnuRefreshQuery(query(["dashboard", "uet", undefined, 4]), ACCOUNT.id, ACCOUNT.id)).toBe(false);
    expect(shouldInvalidateVnuRefreshQuery(query(["universities"]), ACCOUNT.id, ACCOUNT.id)).toBe(false);
    expect(shouldInvalidateVnuRefreshQuery(query(["vnu-cross-student-id", "vnu"]), ACCOUNT.id, ACCOUNT.id)).toBe(false);
    expect(shouldInvalidateVnuRefreshQuery(query(["unrelated", "vnu"]), ACCOUNT.id, ACCOUNT.id)).toBe(false);
    expect(shouldInvalidateVnuRefreshQuery(query(["unrelated", "vnu"], false), ACCOUNT.id, ACCOUNT.id)).toBe(false);
    expect(shouldInvalidateVnuRefreshQuery(query(["dashboard", "vnu"]), ACCOUNT.id, SECOND_ACCOUNT.id)).toBe(false);
  });

  it("rolls a rotated grant back when account persistence fails", () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const originalSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === "hyeboard.accounts") throw new Error("Synthetic storage failure");
      originalSetItem(key, value);
    });

    expect(() => commitVnuRefresh(ACCOUNT, {
      token: "rotated-token-alpha",
      refreshGrant: "rotated-grant-alpha",
      session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
    })).toThrow("Synthetic storage failure");
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
  });
});
