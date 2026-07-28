import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, getActiveAccount, isSessionDeathCode, listAccounts, switchAccount, type StoredAccount } from "./api";

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
    vi.stubGlobal("CustomEvent", class {
      constructor(readonly type: string) {}
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

  it.each(["MISSING_SESSION", "SESSION_EXPIRED", "INVALID_SESSION"])("clears stored state for genuine session-death code %s", async (code) => {
    rejectNextRequest(code, 401);

    await expect(requestCrossLookup()).rejects.toMatchObject({ code });

    expect(isSessionDeathCode(code)).toBe(true);
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

  it("does not clear a newly active account when an old account request dies late", async () => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT, SECOND_ACCOUNT]));
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
    expect(listAccounts()).toEqual([ACCOUNT, SECOND_ACCOUNT]);
  });

  it("does not write an old account refresh into a newly active account", async () => {
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
    expect(listAccounts()).toEqual([ACCOUNT, SECOND_ACCOUNT]);
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
});
