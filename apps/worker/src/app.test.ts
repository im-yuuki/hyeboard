import { configureLogger, decryptSession, encryptSession, HyeboardError, type EncryptedSessionPayload } from "@hyeboard/core";
import { DaotaoClient } from "@hyeboard/university-adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  getAdapter: vi.fn(),
  importSession: vi.fn(),
}));

vi.mock("@hyeboard/university-adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hyeboard/university-adapters")>();
  return { ...actual, getAdapter: adapterMocks.getAdapter };
});

import { createApp, createCaptchaRelayToken, isVnuFarWalkEnabled, resolveSession, setCaptchaRelayCoordinator, setRuntimeConfig, setVnuProbeBudgetCoordinator, type RuntimeConfig } from "./app";
import { LocalCaptchaRelayCoordinator, type CaptchaRelayCoordinator } from "./captcha-relay";
import { selfHostedRuntimeConfig } from "./start";
import type { VnuProbeBudgetCoordinator } from "./vnu-probe-budget";

const SESSION_SECRET = "worker-test-secret-worker-test-secret";
const VNU_STUDENT_CODE = "SYNTHETIC-STUDENT-001";
const SENTINELS = [
  "PARENT_USERNAME_SENTINEL",
  "PARENT_PASSWORD_SENTINEL",
  "CAPTCHA_ANSWER_SENTINEL",
  "UPSTREAM_CAPTCHA_ID_SENTINEL",
  "CAPTCHA_IMAGE_SENTINEL",
  "ACCOUNT_FIELD_SENTINEL",
  "ACCESS_TOKEN_SENTINEL",
  "RAW_BODY_SENTINEL",
];

function parentSession(): EncryptedSessionPayload {
  return {
    version: 1,
    universityId: "uet",
    studentCode: "ACCOUNT_FIELD_SENTINEL",
    uetParentCredential: { username: "PARENT_USERNAME_SENTINEL", password: "PARENT_PASSWORD_SENTINEL" },
    studenthub: { kind: "bearer", value: "ACCESS_TOKEN_SENTINEL", expiresAt: "2000-01-01T00:00:00.000Z" },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

type VnuImportResponse = {
  token: string;
  session: {
    universityId: string;
    studentCode?: string;
    expiresAt: string;
    authenticated: true;
  };
};

class TestCache {
  readonly store = new Map<string, { response: Response; expiresAt: number }>();
  failMatch = false;
  failPut = false;

  constructor(private readonly currentTime: () => number) {}

  async match(request: Request): Promise<Response | undefined> {
    if (this.failMatch) throw new Error("synthetic cache read failure");
    const cached = this.store.get(request.url);
    if (!cached) return undefined;
    if (cached.expiresAt <= this.currentTime()) {
      this.store.delete(request.url);
      return undefined;
    }
    return cached.response.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    if (this.failPut) throw new Error("synthetic cache write failure");
    const cacheControl = response.headers.get("Cache-Control") ?? "";
    const maxAgeMatch = /max-age=(\d+)/.exec(cacheControl);
    const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 0;
    this.store.set(request.url, {
      response: response.clone(),
      expiresAt: this.currentTime() + maxAgeSeconds * 1000,
    });
  }

  rawUrls(): string[] {
    return [...this.store.keys()].filter((key) => key.includes("/cache/vnu/raw/"));
  }

  importUrl(): string {
    const url = [...this.store.keys()].find((key) => key.includes("/cache/vnu/import/"));
    if (!url) throw new Error("VNU import cache entry was not written");
    return url;
  }

  async importEntry(): Promise<{
    seed: string;
    session: VnuImportResponse["session"];
  }> {
    return await this.store.get(this.importUrl())!.response.clone().json() as {
      seed: string;
      session: VnuImportResponse["session"];
    };
  }

  setImportEntry(value: unknown): void {
    this.store.set(this.importUrl(), {
      response: new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
      }),
      expiresAt: this.currentTime() + 3_600_000,
    });
  }
}

function vnuSession(expiresAt = "2099-01-01T00:00:00.000Z"): EncryptedSessionPayload {
  return {
    version: 1,
    universityId: "vnu",
    vnu: { kind: "cookie", value: "SYNTHETIC_VNU_COOKIE", expiresAt },
    expiresAt,
  };
}

function normalizedVnuSession(expiresAt = "2099-01-01T00:00:00.000Z"): EncryptedSessionPayload {
  return { ...vnuSession(expiresAt), studentCode: VNU_STUDENT_CODE };
}

function importedVnu(session = vnuSession()) {
  return {
    universityId: session.universityId,
    studentCode: VNU_STUDENT_CODE,
    expiresAt: session.expiresAt,
    session,
  };
}

function vnuProfileHtml(studentCode = VNU_STUDENT_CODE): string {
  return studentCode ? `<input name="StdCode" value="${studentCode}">` : "<html><body>Synthetic profile without identity</body></html>";
}

class TestVnuProbeBudget implements VnuProbeBudgetCoordinator {
  readonly identities: string[] = [];
  readonly amounts: number[] = [];
  readonly counts = new Map<string, number>();
  limit = Number.POSITIVE_INFINITY;
  unavailable = false;

  get count(): number {
    return [...this.counts.values()].reduce((total, count) => total + count, 0);
  }

  async consume(sessionIdentity: string, amount = 1): Promise<void> {
    this.identities.push(sessionIdentity);
    this.amounts.push(amount);
    if (this.unavailable) throw new Error("synthetic budget outage");
    const count = this.counts.get(sessionIdentity) ?? 0;
    if (count + amount > this.limit) {
      throw new HyeboardError("VNU_RATE_LIMITED", "Synthetic budget exhausted", 429, {
        retryAfterSeconds: 600,
        limit: 300,
        windowSeconds: 600,
      });
    }
    this.counts.set(sessionIdentity, count + amount);
  }

  async reserve(sessionIdentity: string, amount: number): Promise<void> {
    await this.consume(sessionIdentity, amount);
  }
}

async function requestVnuImport(app: ReturnType<typeof createApp>): Promise<Response> {
  return app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vnuUsername: "SYNTHETIC_VNU_USER", vnuPassword: "SYNTHETIC_VNU_PASSWORD" }),
  }));
}

async function importVnu(app: ReturnType<typeof createApp>): Promise<VnuImportResponse> {
  const response = await requestVnuImport(app);
  expect(response.status).toBe(200);
  const body = await response.json() as { data: VnuImportResponse; error: null };
  expect(body.error).toBeNull();
  expect(Object.keys(body.data).sort()).toEqual(["session", "token"]);
  expect(Object.keys(body.data.session).sort()).toEqual(["authenticated", "expiresAt", "studentCode", "universityId"]);
  return body.data;
}

async function getVnuSession(app: ReturnType<typeof createApp>, token: string): Promise<Response> {
  return app.handle(new Request("http://localhost/api/vnu/auth/session", {
    headers: { Authorization: `Bearer ${token}` },
  }));
}

async function getVnuRawPage(app: ReturnType<typeof createApp>, token: string, page = "grades"): Promise<Response> {
  return app.handle(new Request(`http://localhost/api/vnu/raw/${page}`, {
    headers: { Authorization: `Bearer ${token}` },
  }));
}

describe("lazy parent session refresh", () => {
  let logOutput: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    logOutput = [];
    configureLogger({
      level: "debug",
      mode: "node",
      destination: { write: (line: string) => logOutput.push(line) },
    });
  });

  afterEach(() => configureLogger({ level: "silent", mode: "node" }));

  it("refreshes without browser context or a human CAPTCHA callback", async () => {
    const refreshedSession = {
      ...parentSession(),
      studenthub: { kind: "bearer" as const, value: "NEW_ACCESS_TOKEN_SENTINEL", expiresAt: "2098-01-01T00:00:00.000Z" },
    };
    adapterMocks.importSession.mockResolvedValue({
      universityId: "uet",
      studentCode: refreshedSession.studentCode,
      expiresAt: refreshedSession.expiresAt,
      session: refreshedSession,
    });
    const token = await encryptSession(parentSession(), SESSION_SECRET);

    const resolved = await resolveSession({ Authorization: `Bearer ${token}` });

    expect(adapterMocks.importSession.mock.calls[0]).toEqual([{
      uetGoogleEmail: "PARENT_USERNAME_SENTINEL",
      uetGooglePassword: "PARENT_PASSWORD_SENTINEL",
    }]);
    expect(resolved.refreshedToken).toBeTypeOf("string");
    await expect(decryptSession(resolved.refreshedToken!, SESSION_SECRET)).resolves.toEqual(refreshedSession);
    expect(logOutput.join("\n")).toBe("");
  });

  it.each([
    ["STUDENTHUB_CAPTCHA_REQUIRED", 422],
    ["STUDENTHUB_CAPTCHA_REJECTED", 422],
    ["STUDENTHUB_CAPTCHA_TIMEOUT", 408],
  ])("propagates %s unchanged without session-death semantics", async (code, status) => {
    const token = await encryptSession(parentSession(), SESSION_SECRET);
    const error = new HyeboardError(code, `Refresh failed ${SENTINELS.join(" ")}`, status);
    adapterMocks.importSession.mockRejectedValue(error);

    let caught: unknown;
    try {
      await resolveSession({ Authorization: `Bearer ${token}` });
    } catch (value) {
      caught = value;
    }

    expect(caught).toBe(error);
    expect(caught).toMatchObject({ code, status });
    expect(adapterMocks.importSession.mock.calls[0]).toHaveLength(1);
    await expect(decryptSession(token, SESSION_SECRET)).resolves.toEqual(parentSession());
    for (const sentinel of SENTINELS) expect(logOutput.join("\n")).not.toContain(sentinel);
  });
});

describe("UET CAPTCHA SSE cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
  });

  it("cancels and removes an active relay when the response reader is cancelled", async () => {
    const relayId = "HYEB_RELAY_ID_SENTINEL";
    const upstreamCaptchaId = "UPSTREAM_CAPTCHA_ID_SENTINEL";
    const coordinator = new LocalCaptchaRelayCoordinator(() => relayId, 60_000);
    setCaptchaRelayCoordinator(coordinator);
    let finishImport!: () => void;
    const importFinished = new Promise<void>((resolve) => { finishImport = resolve; });
    adapterMocks.importSession.mockImplementation(async (_body, context) => {
      try {
        void upstreamCaptchaId;
        await context.onCaptchaNeeded("data:image/png;base64,SU1BR0VfU0VOVElORUw=");
        throw new Error("unexpected answer");
      } finally {
        finishImport();
      }
    });
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    const app = createApp(undefined);
    const response = await app.handle(new Request("http://localhost/api/uet/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uetGoogleEmail: "PH00000001", uetGooglePassword: "fake-password" }),
    }));
    const reader = response.body!.getReader();

    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    const payload = JSON.parse(/^data: (.+)$/m.exec(text)?.[1] ?? "null") as Record<string, unknown>;
    expect(/^event: captcha_required$/m.test(text)).toBe(true);
    expect(payload.challengeId).toMatch(new RegExp(`^${relayId}\\.[0-9a-f]{64}$`));
    expect(payload.image).toBe("data:image/png;base64,SU1BR0VfU0VOVElORUw=");
    expect(Object.keys(payload).sort()).toEqual(["challengeId", "image"]);
    expect(text).not.toContain(upstreamCaptchaId);

    await reader.cancel();
    await importFinished;
    await expect(coordinator.answer(relayId, "LATE_ANSWER_SENTINEL")).rejects.toMatchObject({
      code: "STUDENTHUB_CAPTCHA_CHALLENGE_NOT_FOUND",
      status: 404,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("awaits asynchronous coordinator answers before accepting the solve request", async () => {
    let releaseAnswer!: () => void;
    const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve; });
    const answer = vi.fn(async () => { await answerGate; });
    const coordinator: CaptchaRelayCoordinator = {
      prepare: async () => { throw new Error("not used"); },
      answer,
    };
    setCaptchaRelayCoordinator(coordinator);
    const app = createApp(undefined);
    const relayToken = await createCaptchaRelayToken("HYEB_RELAY_ID_SENTINEL");
    let settled = false;
    const responsePromise = app.handle(new Request("http://localhost/api/uet/auth/solve-captcha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId: relayToken, answer: "ANSWER_SENTINEL" }),
    })).then((response) => {
      settled = true;
      return response;
    });

    await vi.waitFor(() => expect(answer).toHaveBeenCalledWith("HYEB_RELAY_ID_SENTINEL", "ANSWER_SENTINEL"));
    expect(settled).toBe(false);
    releaseAnswer();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { accepted: true }, error: null });
  });

  it("rejects malformed and forged relay tokens before coordinator access", async () => {
    const answer = vi.fn();
    setCaptchaRelayCoordinator({
      prepare: async () => { throw new Error("not used"); },
      answer,
    });
    const app = createApp(undefined);
    const validToken = await createCaptchaRelayToken("HYEB_RELAY_ID_SENTINEL");
    const forgedToken = `${validToken.slice(0, -1)}${validToken.endsWith("0") ? "1" : "0"}`;
    const bodies = [];

    for (const challengeId of ["malformed-token", forgedToken]) {
      const response = await app.handle(new Request("http://localhost/api/uet/auth/solve-captcha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, answer: "ANSWER_SENTINEL" }),
      }));
      expect(response.status).toBe(404);
      bodies.push(await response.json());
    }

    expect(bodies[0]).toEqual(bodies[1]);
    expect(answer).not.toHaveBeenCalled();
  });

  it.each([
    [{ challengeId: "x".repeat(161), answer: "A" }],
    [{ challengeId: "token", answer: "" }],
    [{ challengeId: "token", answer: "A".repeat(65) }],
  ])("rejects solve request bounds before coordinator access", async (body) => {
    const answer = vi.fn();
    setCaptchaRelayCoordinator({
      prepare: async () => { throw new Error("not used"); },
      answer,
    });
    const app = createApp(undefined);

    const response = await app.handle(new Request("http://localhost/api/uet/auth/solve-captcha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(422);
    expect(answer).not.toHaveBeenCalled();
  });
});

describe("VNU import session cache", () => {
  let cache: TestCache;
  let app: ReturnType<typeof createApp>;
  let syntheticTime: number;
  let dateNowSpy: ReturnType<typeof vi.spyOn>;
  let profileSpy: ReturnType<typeof vi.spyOn>;
  let gradesSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.getAdapter.mockReset();
    adapterMocks.importSession.mockReset();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    syntheticTime = 1_800_000_000_000;
    dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => syntheticTime);
    cache = new TestCache(() => syntheticTime);
    vi.stubGlobal("caches", { default: cache });
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    adapterMocks.importSession.mockResolvedValue(importedVnu());
    profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml").mockResolvedValue(vnuProfileHtml());
    gradesSpy = undefined;
    app = createApp(undefined);
  });

  afterEach(() => {
    gradesSpy?.mockRestore();
    profileSpy.mockRestore();
    dateNowSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("expires cached responses at their deterministic max-age boundary", async () => {
    const request = new Request("https://hyeboard.internal/cache/synthetic-expiry");
    await cache.put(request, new Response("cached", {
      headers: { "Cache-Control": "public, max-age=1" },
    }));

    await expect(cache.match(request).then((response) => response?.text())).resolves.toBe("cached");
    syntheticTime += 1_000;
    await expect(cache.match(request)).resolves.toBeUndefined();
  });

  it("derives a positive import-cache TTL and expires it at the exact boundary", async () => {
    const expiresAt = new Date(syntheticTime + 2_500).toISOString();
    const session = vnuSession(expiresAt);
    adapterMocks.importSession.mockResolvedValue(importedVnu(session));

    const first = await importVnu(app);
    const cacheUrl = cache.importUrl();
    expect(cache.store.get(cacheUrl)?.response.headers.get("Cache-Control")).toBe("public, max-age=2");
    await expect(decryptSession(first.token, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession(expiresAt));

    syntheticTime += 1_999;
    await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);

    syntheticTime += 1;
    const boundaryLogin = await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(boundaryLogin.session.expiresAt).toBe(expiresAt);
  });

  it("skips the import cache when the derived TTL is non-positive", async () => {
    const expiresAt = new Date(syntheticTime + 999).toISOString();
    const session = vnuSession(expiresAt);
    adapterMocks.importSession.mockResolvedValue(importedVnu(session));

    const outward = await importVnu(app);

    expect(cache.store.size).toBe(0);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    await expect(decryptSession(outward.token, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession(expiresAt));
  });

  it("normalizes verified VNU identity before caching and reuses it on the next import", async () => {
    const imported = importedVnu();
    expect(imported.session.studentCode).toBeUndefined();
    adapterMocks.importSession.mockResolvedValue(imported);

    const first = await importVnu(app);
    const cached = await cache.importEntry();
    const firstSession = await decryptSession(first.token, SESSION_SECRET);

    expect(imported.session.studentCode).toBeUndefined();
    expect(firstSession.studentCode).toBe(VNU_STUDENT_CODE);
    expect(cached.session.studentCode).toBe(firstSession.studentCode);
    await expect(decryptSession(cached.seed, SESSION_SECRET)).resolves.toEqual(firstSession);

    const second = await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(second.session).toEqual(cached.session);
    await expect(decryptSession(second.token, SESSION_SECRET)).resolves.toEqual(firstSession);
  });

  it("caches an opaque seed and returns a distinct valid token on a cache miss", async () => {
    const outward = await importVnu(app);
    const cached = await cache.importEntry();

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(cached.seed).toBeTypeOf("string");
    expect(cached.seed).not.toBe(outward.token);
    expect(cached.session).toEqual(outward.session);
    await expect(decryptSession(cached.seed, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());
    await expect(decryptSession(outward.token, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());
    expect(Object.keys(cached).sort()).toEqual(["seed", "session"]);
  });

  it("validates a cache hit live and returns a fresh equivalent token without mutating the cache", async () => {
    const first = await importVnu(app);
    const cached = await cache.importEntry();
    const cacheUrl = cache.importUrl();
    const storedBefore = cache.store.get(cacheUrl)!;
    const bytesBefore = await storedBefore.response.clone().text();
    const second = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(second.token).not.toBe(first.token);
    expect(second.token).not.toBe(cached.seed);
    expect(second.session).toEqual(first.session);
    expect(second.session).toEqual(cached.session);
    const firstPayload = await decryptSession(first.token, SESSION_SECRET);
    const secondPayload = await decryptSession(second.token, SESSION_SECRET);
    expect(secondPayload).toEqual(firstPayload);
    expect(secondPayload.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect(await cache.store.get(cacheUrl)!.response.clone().text()).toBe(bytesBefore);
    expect(cache.store.get(cacheUrl)!.expiresAt).toBe(storedBefore.expiresAt);
  });

  it("repairs a definitively expired cached upstream session and reuses the replacement", async () => {
    const repairedSession: EncryptedSessionPayload = {
      ...vnuSession(),
      vnu: { kind: "cookie", value: "REPAIRED_SYNTHETIC_VNU_COOKIE", expiresAt: "2099-01-01T00:00:00.000Z" },
    };
    const first = await importVnu(app);
    const oldCached = await cache.importEntry();
    profileSpy
      .mockRejectedValueOnce(new HyeboardError("VNU_SESSION_EXPIRED", "Synthetic upstream session expired", 401))
      .mockResolvedValueOnce(vnuProfileHtml());
    adapterMocks.importSession.mockImplementationOnce(async () => {
      expect(await cache.importEntry()).toEqual(oldCached);
      return importedVnu(repairedSession);
    });

    const repaired = await importVnu(app);
    const replacement = await cache.importEntry();
    const cachedRelogin = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(profileSpy).toHaveBeenCalledTimes(2);
    expect(replacement.seed).not.toBe(oldCached.seed);
    expect(repaired.token).not.toBe(replacement.seed);
    expect(cachedRelogin.token).not.toBe(replacement.seed);
    expect(cachedRelogin.token).not.toBe(repaired.token);
    await expect(decryptSession(first.token, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());
    const normalizedRepaired = { ...repairedSession, studentCode: VNU_STUDENT_CODE };
    await expect(decryptSession(repaired.token, SESSION_SECRET)).resolves.toEqual(normalizedRepaired);
    await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(normalizedRepaired);
    await expect(decryptSession(cachedRelogin.token, SESSION_SECRET)).resolves.toEqual(normalizedRepaired);
  });

  it("does not cache or expose a runtime VNU_SESSION_EXPIRED response", async () => {
    const expiryNoticeSentinel = "SYNTHETIC_EXPIRY_NOTICE_SENTINEL";
    const outward = await importVnu(app);
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockRejectedValue(
      new HyeboardError("VNU_SESSION_EXPIRED", "The university portal session has expired. Sign in again.", 401),
    );

    const response = await getVnuRawPage(app, outward.token);
    const responseText = await response.text();

    expect(response.status).toBe(401);
    expect(JSON.parse(responseText)).toMatchObject({
      data: null,
      error: { code: "VNU_SESSION_EXPIRED" },
    });
    expect(responseText).not.toContain(expiryNoticeSentinel);
    expect(cache.rawUrls()).toEqual([]);
    expect(gradesSpy).toHaveBeenCalledTimes(1);
  });

  it("uses separate raw-cache keys for old and repaired VNU cookies", async () => {
    const repairedSession: EncryptedSessionPayload = {
      ...vnuSession(),
      vnu: { kind: "cookie", value: "REPAIRED_SYNTHETIC_VNU_COOKIE", expiresAt: "2099-01-01T00:00:00.000Z" },
    };
    const oldOutward = await importVnu(app);
    profileSpy.mockRejectedValueOnce(
      new HyeboardError("VNU_SESSION_EXPIRED", "The university portal session has expired. Sign in again.", 401),
    );
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(repairedSession));
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>SYNTHETIC_GRADES</html>");

    const repairedOutward = await importVnu(app);
    const oldPayload = await decryptSession(oldOutward.token, SESSION_SECRET);
    const repairedPayload = await decryptSession(repairedOutward.token, SESSION_SECRET);
    const oldResponse = await getVnuRawPage(app, oldOutward.token);
    const repairedResponse = await getVnuRawPage(app, repairedOutward.token);
    const rawUrls = cache.rawUrls();

    expect(oldPayload.vnu?.value).toBe("SYNTHETIC_VNU_COOKIE");
    expect(repairedPayload.vnu?.value).toBe("REPAIRED_SYNTHETIC_VNU_COOKIE");
    expect(oldPayload.vnu?.value).not.toBe(repairedPayload.vnu?.value);
    expect(oldResponse.status).toBe(200);
    expect(repairedResponse.status).toBe(200);
    expect(rawUrls).toHaveLength(2);
    expect(new Set(rawUrls).size).toBe(2);
    expect(gradesSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing", ""],
    ["mismatched", "OTHER-SYNTHETIC-STUDENT"],
  ])("repairs a cache hit with %s live profile identity", async (_label, liveStudentCode) => {
    const repairedSession: EncryptedSessionPayload = {
      ...vnuSession(),
      vnu: { kind: "cookie", value: `REPAIRED_${liveStudentCode || "MISSING"}_COOKIE`, expiresAt: "2099-01-01T00:00:00.000Z" },
    };
    await importVnu(app);
    const oldCached = await cache.importEntry();
    profileSpy.mockResolvedValueOnce(vnuProfileHtml(liveStudentCode));
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(repairedSession));

    const recovered = await importVnu(app);
    const replacement = await cache.importEntry();

    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(replacement.seed).not.toBe(oldCached.seed);
    const normalizedRepaired = { ...repairedSession, studentCode: VNU_STUDENT_CODE };
    await expect(decryptSession(recovered.token, SESSION_SECRET)).resolves.toEqual(normalizedRepaired);
    await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(normalizedRepaired);
  });

  it.each([
    ["rate limit", "VNU_RATE_LIMITED", 429],
    ["upstream unavailable", "VNU_UPSTREAM_UNAVAILABLE", 502],
  ])("propagates transient profile validation %s without login or cache mutation", async (_label, code, status) => {
    await importVnu(app);
    const cacheUrl = cache.importUrl();
    const storedBefore = cache.store.get(cacheUrl)!;
    const bytesBefore = await storedBefore.response.clone().text();
    profileSpy.mockRejectedValueOnce(new HyeboardError(code, "Synthetic transient validation failure", status));

    const response = await requestVnuImport(app);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ data: null, error: { code } });
    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(await cache.store.get(cacheUrl)!.response.clone().text()).toBe(bytesBefore);
    expect(cache.store.get(cacheUrl)!.expiresAt).toBe(storedBefore.expiresAt);
  });

  it("preserves the old cache when recovery login fails", async () => {
    await importVnu(app);
    const cacheUrl = cache.importUrl();
    const storedBefore = cache.store.get(cacheUrl)!;
    const bytesBefore = await storedBefore.response.clone().text();
    profileSpy.mockRejectedValueOnce(new HyeboardError("VNU_SESSION_EXPIRED", "Synthetic upstream session expired", 401));
    adapterMocks.importSession.mockRejectedValueOnce(new HyeboardError("INVALID_VNU_CREDENTIAL", "Synthetic credentials rejected", 401));

    const response = await requestVnuImport(app);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ data: null, error: { code: "INVALID_VNU_CREDENTIAL" } });
    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(await cache.store.get(cacheUrl)!.response.clone().text()).toBe(bytesBefore);
    expect(cache.store.get(cacheUrl)!.expiresAt).toBe(storedBefore.expiresAt);
  });

  it("keeps a cached relogin usable after the old outward token is revoked", async () => {
    const oldLogin = await importVnu(app);
    const independentLogin = await importVnu(app);

    const logout = await app.handle(new Request("http://localhost/api/vnu/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${oldLogin.token}` },
    }));
    expect(logout.status).toBe(200);

    const oldSession = await getVnuSession(app, oldLogin.token);
    expect(oldSession.status).toBe(401);
    await expect(oldSession.json()).resolves.toMatchObject({
      data: null,
      error: { code: "SESSION_EXPIRED" },
    });

    const independentSession = await getVnuSession(app, independentLogin.token);
    expect(independentSession.status).toBe(200);

    const relogin = await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(relogin.token).not.toBe(oldLogin.token);
    expect(relogin.token).not.toBe(independentLogin.token);
    const freshSession = await getVnuSession(app, relogin.token);
    expect(freshSession.status).toBe(200);
    await expect(freshSession.json()).resolves.toEqual({
      data: {
        universityId: "vnu",
        studentCode: "SYNTHETIC-STUDENT-001",
        expiresAt: "2099-01-01T00:00:00.000Z",
        authenticated: true,
      },
      error: null,
    });
  });

  it.each([
    ["malformed seed", async () => "not-an-encrypted-session"],
    ["wrong token version", async () => encryptSession({ ...normalizedVnuSession(), version: 2 } as unknown as EncryptedSessionPayload, SESSION_SECRET)],
    ["failed authentication tag", async () => encryptSession(normalizedVnuSession(), "different-synthetic-secret-32-bytes")],
    ["expired seed", async () => encryptSession(normalizedVnuSession("2000-01-01T00:00:00.000Z"), SESSION_SECRET)],
    ["non-VNU seed", async () => encryptSession({ ...normalizedVnuSession(), universityId: "uet", vnu: undefined }, SESSION_SECRET)],
    ["non-cookie VNU credential", async () => encryptSession({ ...normalizedVnuSession(), vnu: { ...normalizedVnuSession().vnu!, kind: "bearer" } }, SESSION_SECRET)],
  ])("treats a %s as a cache miss", async (_label, makeSeed) => {
    await importVnu(app);
    const previous = await cache.importEntry();
    cache.setImportEntry({ ...previous, seed: await makeSeed() });
    vi.clearAllMocks();
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    adapterMocks.importSession.mockResolvedValue(importedVnu());

    const recovered = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    await expect(decryptSession(recovered.token, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());
    const replacement = await cache.importEntry();
    expect(Object.keys(replacement).sort()).toEqual(["seed", "session"]);
    expect(replacement.session).toEqual(recovered.session);
    await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());

    const cachedRelogin = await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(cachedRelogin.token).not.toBe(recovered.token);
    expect(cachedRelogin.token).not.toBe(replacement.seed);
    expect(cachedRelogin.session).toEqual(recovered.session);
    await expect(decryptSession(cachedRelogin.token, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());
  });

  it.each([
    ["university", { universityId: "uet" }],
    ["student code", { studentCode: "OTHER-SYNTHETIC-STUDENT" }],
    ["expiry", { expiresAt: "2098-01-01T00:00:00.000Z" }],
  ])("treats inconsistent %s metadata as a cache miss", async (_label, metadataPatch) => {
    await importVnu(app);
    const previous = await cache.importEntry();
    cache.setImportEntry({ ...previous, session: { ...previous.session, ...metadataPatch } });
    vi.clearAllMocks();
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    adapterMocks.importSession.mockResolvedValue(importedVnu());

    const recovered = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    const replacement = await cache.importEntry();
    expect(Object.keys(replacement).sort()).toEqual(["seed", "session"]);
    expect(replacement.session).toEqual(recovered.session);
    await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());

    const cachedRelogin = await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(cachedRelogin.token).not.toBe(recovered.token);
    expect(cachedRelogin.token).not.toBe(replacement.seed);
    expect(cachedRelogin.session).toEqual(recovered.session);
    await expect(decryptSession(cachedRelogin.token, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());
  });

  it("falls back to upstream login when the cache read fails", async () => {
    cache.failMatch = true;

    const outward = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    await expect(decryptSession(outward.token, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());
  });

  it("returns the normal response when the cache write fails", async () => {
    cache.failPut = true;

    const outward = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    await expect(decryptSession(outward.token, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());
    expect(cache.store.size).toBe(0);
  });
});

describe("VNU cross-transcript route", () => {
  let cache: TestCache;
  let app: ReturnType<typeof createApp>;
  let profileSpy: ReturnType<typeof vi.spyOn>;
  let transcriptSpy: ReturnType<typeof vi.spyOn>;
  let probeBudget: TestVnuProbeBudget;

  const profileHtml = `<input name="hidStdID" value="1000"><input name="StdCode" value="20000000">`;
  const targetTranscriptHtml = `<table>
    <tr><td>Sinh viên: SYNTHETIC TARGET</td><td>Mã số: 20000001</td><td>Lớp quản lý: QH-SYNTHETIC</td></tr>
    <tr><td>HỌC KỲ 1 - 2025-2026. MÃ HỌC KỲ 251</td></tr>
    <tr><td>1</td><td>INT1001</td><td>Reliable Systems</td><td>3</td><td>8</td><td>B+</td><td>3.5</td><td></td></tr>
  </table><div>Tổng tín chỉ: 3</div>`;

  async function authorizedRequest(query: string, route = "transcript", sessionCookie = "SYNTHETIC_TRANSCRIPT_COOKIE"): Promise<Response> {
    const session = { ...vnuSession(), vnu: { ...vnuSession().vnu!, value: sessionCookie } };
    const token = await encryptSession(session, SESSION_SECRET);
    return app.handle(new Request(`http://localhost/api/vnu/cross-lookup/${route}?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    }));
  }

  async function bulkRequest(body: unknown, session: EncryptedSessionPayload = { ...vnuSession(), vnu: { ...vnuSession().vnu!, value: "SYNTHETIC_TRANSCRIPT_COOKIE" } }): Promise<Response> {
    return bulkRawRequest(JSON.stringify(body), session);
  }

  async function bulkRawRequest(body: string, session?: EncryptedSessionPayload): Promise<Response> {
    const token = session ? await encryptSession(session, SESSION_SECRET) : undefined;
    return app.handle(new Request("http://localhost/api/vnu/cross-lookup/bulk", {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body,
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    cache = new TestCache(() => Date.now());
    vi.stubGlobal("caches", { default: cache });
    probeBudget = new TestVnuProbeBudget();
    setVnuProbeBudgetCoordinator(probeBudget);
    profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml").mockResolvedValue(profileHtml);
    transcriptSpy = vi.spyOn(DaotaoClient.prototype, "getTranscriptByStdIdHtml").mockResolvedValue(targetTranscriptHtml);
    app = createApp(undefined);
  });

  afterEach(() => {
    profileSpy.mockRestore();
    transcriptSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("rejects invalid target combinations before reading the own profile", async () => {
    const response = await authorizedRequest("stdId=1001&stdCode=20000001&allowCrossLookup=true");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_QUERY_INCOMPLETE" } });
    expect(profileSpy).not.toHaveBeenCalled();
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["neither target", "allowCrossLookup=true"],
    ["malformed StdID", "stdId=abc&allowCrossLookup=true"],
    ["empty StdID", "stdId=&allowCrossLookup=true"],
    ["malformed student code", "stdCode=1234567&allowCrossLookup=true"],
  ])("rejects %s before reading the own profile or transcript oracle", async (_label, query) => {
    const response = await authorizedRequest(query);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_QUERY_INCOMPLETE" } });
    expect(profileSpy).not.toHaveBeenCalled();
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "stdId=1001"],
    ["incorrect", "stdId=1001&allowCrossLookup=1"],
  ])("rejects %s explicit opt-in before reading the own profile or transcript oracle", async (_label, query) => {
    const response = await authorizedRequest(query);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED" } });
    expect(profileSpy).not.toHaveBeenCalled();
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-VNU session before profile or transcript access", async () => {
    const token = await encryptSession(parentSession(), SESSION_SECRET);
    const response = await app.handle(new Request("http://localhost/api/vnu/cross-lookup/transcript?stdId=1001&allowCrossLookup=true", {
      headers: { Authorization: `Bearer ${token}` },
    }));

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SESSION_UNIVERSITY_MISMATCH" } });
    expect(profileSpy).not.toHaveBeenCalled();
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["normalized zero-padded own StdID", "stdId=00000001000&allowCrossLookup=true"],
    ["own student code", "stdCode=20000000&allowCrossLookup=true"],
  ])("rejects %s before transcript oracle access", async (_label, query) => {
    const response = await authorizedRequest(query);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_SELF_TARGET" } });
    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("rejects a normalized zero-padded own StdID on the student-code route before oracle access", async () => {
    const response = await authorizedRequest("stdId=00000001000&allowCrossLookup=true", "student-code");

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_SELF_TARGET" } });
    expect(probeBudget.count).toBe(0);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  // Regression: Number("not-a-number") is NaN and NaN never equals the
  // target, so a truthy-but-malformed own-profile id silently bypassed the
  // old self-target guard — the route then spent budget and fetched Brc1
  // with an unverified caller identity. Identity parsing now fails closed.
  it.each([
    ["student-code", "stdId=1002&allowCrossLookup=true"],
    ["student-id", "stdCode=20000001&allowCrossLookup=true"],
    ["transcript", "stdId=1002&allowCrossLookup=true"],
  ])("fails closed on a malformed own-profile identity for %s without budget or Brc1 access", async (route, query) => {
    profileSpy.mockResolvedValue(`<input name="hidStdID" value="not-a-number"><input name="StdCode" value="20000000">`);

    const response = await authorizedRequest(query, route);

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_LOGIN_REQUIRED" } });
    expect(probeBudget.count).toBe(0);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed own-profile identity for bulk without budget or Brc1 access", async () => {
    profileSpy.mockResolvedValue(`<input name="hidStdID" value="not-a-number"><input name="StdCode" value="20000000">`);

    const response = await bulkRequest({ mode: "stdid-to-code", targets: ["1002"], allowCrossLookup: true });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_LOGIN_REQUIRED" } });
    expect(probeBudget.count).toBe(0);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("returns parsed JSON only and spends one probe for direct StdID mode", async () => {
    const response = await authorizedRequest("stdId=1001&allowCrossLookup=true");
    const body = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.data).toMatchObject({
      header: { studentCode: "20000001", studentName: "SYNTHETIC TARGET" },
      terms: [{ maHK: "251", rows: [{ courseCode: "INT1001", grade10: 8 }] }],
      totals: { totalCredits: 3 },
    });
    expect(JSON.stringify(body)).not.toContain("<table>");
    expect(transcriptSpy).toHaveBeenCalledTimes(1);
    expect(probeBudget.count).toBe(1);
  });

  it("removes upstream notice prose from transcript responses", async () => {
    const upstreamNoticeSentinel = "UPSTREAM_NOTICE_SENTINEL_DO_NOT_EXPOSE";
    transcriptSpy.mockResolvedValue(`${targetTranscriptHtml}<script>alert('${upstreamNoticeSentinel}')</script>`);

    const response = await authorizedRequest("stdId=1001&allowCrossLookup=true");
    const payload = await response.text();

    expect(response.status).toBe(200);
    expect(payload).not.toContain(upstreamNoticeSentinel);
    expect(payload).not.toContain("notice");
  });

  it("spends resolver probes plus one separate transcript fetch for student-code mode", async () => {
    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true");
    const body = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.data).toMatchObject({ header: { studentCode: "20000001" }, terms: [{ maHK: "251" }] });
    expect(JSON.stringify(body)).not.toContain("<table>");
    expect(transcriptSpy).toHaveBeenCalledTimes(2);
    expect(transcriptSpy).toHaveBeenNthCalledWith(1, "1001");
    expect(transcriptSpy).toHaveBeenNthCalledWith(2, "00000001001");
    expect(probeBudget.count).toBe(2);
  });

  it("blocks the final transcript fetch when resolver probes exhaust the budget", async () => {
    probeBudget.limit = 1;

    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true");

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_RATE_LIMITED" } });
    expect(transcriptSpy).toHaveBeenCalledTimes(1);
    expect(transcriptSpy).toHaveBeenCalledWith("1001");
  });

  it("keeps separate budget identifiers and counters for separate VNU sessions", async () => {
    probeBudget.limit = 1;

    const first = await authorizedRequest("stdId=1001&allowCrossLookup=true", "transcript", "SYNTHETIC_SESSION_A");
    const exhaustedFirst = await authorizedRequest("stdId=1002&allowCrossLookup=true", "transcript", "SYNTHETIC_SESSION_A");
    const second = await authorizedRequest("stdId=1002&allowCrossLookup=true", "transcript", "SYNTHETIC_SESSION_B");

    expect(first.status).toBe(200);
    expect(exhaustedFirst.status).toBe(429);
    expect(second.status).toBe(200);
    expect(new Set(probeBudget.identities).size).toBe(2);
    expect([...probeBudget.counts.values()].sort()).toEqual([1, 1]);
    expect(transcriptSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["headerless transcript", `<table><tr><td>1</td><td>INT1001</td><td>Foreign grade</td><td>3</td><td>8</td><td>B+</td><td>3.5</td><td></td></tr></table>`],
    ["invalid portal response", "<html><body>not a transcript</body></html>"],
  ])("returns no foreign result for an %s", async (_label, html) => {
    transcriptSpy.mockResolvedValue(html);

    const response = await authorizedRequest("stdId=1001&allowCrossLookup=true");
    const body = await response.json() as { data: unknown; error: { code: string } };

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({ data: null, error: { code: "VNU_CROSS_LOOKUP_NOT_FOUND" } });
    expect(JSON.stringify(body)).not.toContain("Foreign grade");
  });

  it("shares one HMAC budget across student-code and student-id routes for the same session", async () => {
    const byId = await authorizedRequest("stdId=1002&allowCrossLookup=true", "student-code");
    const byCode = await authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id");

    expect(byId.status).toBe(200);
    expect(byCode.status).toBe(200);
    expect(byId.headers.get("Cache-Control")).toBe("no-store");
    expect(byCode.headers.get("Cache-Control")).toBe("no-store");
    expect(probeBudget.count).toBe(2);
    expect(new Set(probeBudget.identities).size).toBe(1);
    expect(probeBudget.identities[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(probeBudget.identities.join(" ")).not.toContain("SYNTHETIC_TRANSCRIPT_COOKIE");
    expect(probeBudget.identities.join(" ")).not.toMatch(/20000001|1002/);
  });

  it.each([
    ["student-code", "stdId=bad&allowCrossLookup=true"],
    ["student-id", "stdCode=bad&allowCrossLookup=true"],
  ])("sets no-store on %s resolver errors", async (route, query) => {
    const response = await authorizedRequest(query, route);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("maps a headerless portal notice to not-found without exposing its prose", async () => {
    const upstreamNoticeSentinel = "UPSTREAM_NOTICE_SENTINEL_DO_NOT_EXPOSE";
    transcriptSpy.mockResolvedValue(`<script>alert('${upstreamNoticeSentinel}')</script>`);

    const response = await authorizedRequest("stdId=1001&allowCrossLookup=true", "student-code");
    const payload = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload).toContain("VNU_CROSS_LOOKUP_NOT_FOUND");
    expect(payload).not.toContain(upstreamNoticeSentinel);
  });

  it("rejects confirmed exhaustion before the upstream Brc1 fetch without session-death semantics", async () => {
    probeBudget.limit = 0;

    const response = await authorizedRequest("stdId=1002&allowCrossLookup=true", "student-code");
    const body = await response.json() as { error: { code: string; details: Record<string, unknown> } };

    expect(response.status).toBe(429);
    expect(body.error).toMatchObject({ code: "VNU_RATE_LIMITED", details: { retryAfterSeconds: 600 } });
    expect(transcriptSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("SYNTHETIC_TRANSCRIPT_COOKIE");
    expect(JSON.stringify(body)).not.toMatch(/20000001|1002/);
  });

  it("reports budget unavailability as 503 without session-death semantics", async () => {
    probeBudget.unavailable = true;

    const response = await authorizedRequest("stdId=1002&allowCrossLookup=true", "student-code");
    const body = await response.json() as { error: { code: string; details: Record<string, unknown> } };

    expect(response.status).toBe(503);
    expect(body.error).toMatchObject({ code: "VNU_PROBE_BUDGET_UNAVAILABLE", details: { retryAfterSeconds: 5 } });
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  describe("bulk lookup", () => {
    it("runs authentication, university, explicit opt-in, body, then own-profile guards", async () => {
      const missingSession = await bulkRawRequest("{");
      expect(missingSession.status).toBe(401);
      await expect(missingSession.json()).resolves.toMatchObject({ error: { code: "MISSING_SESSION" } });

      const wrongUniversity = await bulkRawRequest("{", parentSession());
      expect(wrongUniversity.status).toBe(403);
      await expect(wrongUniversity.json()).resolves.toMatchObject({ error: { code: "SESSION_UNIVERSITY_MISMATCH" } });

      const missingOptIn = await bulkRequest({ mode: "stdid-to-code", targets: ["1001"], allowCrossLookup: false });
      expect(missingOptIn.status).toBe(400);
      await expect(missingOptIn.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED" } });

      const malformed = await bulkRequest({ mode: "unknown", targets: ["1001"], allowCrossLookup: true });
      expect(malformed.status).toBe(400);
      expect(profileSpy).not.toHaveBeenCalled();

      profileSpy.mockResolvedValueOnce("<html>no profile identity</html>");
      const noProfile = await bulkRequest({ mode: "stdid-to-code", targets: ["1001"], allowCrossLookup: true });
      expect(noProfile.status).toBe(401);
      expect(transcriptSpy).not.toHaveBeenCalled();
      expect(probeBudget.count).toBe(0);
    });

    it.each([
      ["string", "true", 400],
      ["number", 1, 400],
      ["boolean", true, 200],
    ] as const)("accepts only boolean true for allowCrossLookup (%s)", async (_label, allowCrossLookup, status) => {
      const response = await bulkRequest({ mode: "stdid-to-code", targets: ["1001"], allowCrossLookup });

      expect(response.status).toBe(status);
      if (status === 400) await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED" } });
    });

    it.each([
      ["stdid-to-code", 6],
      ["stdid-to-transcript", 6],
      ["code-to-stdid", 4],
    ] as const)("rejects an oversized %s chunk at the chunk boundary", async (mode, size) => {
      const target = mode === "code-to-stdid" ? "20000001" : "1001";
      const response = await bulkRequest({ mode, targets: Array.from({ length: size }, () => target), allowCrossLookup: true });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_CHUNK_TOO_LARGE" } });
      expect(profileSpy).not.toHaveBeenCalled();
      expect(transcriptSpy).not.toHaveBeenCalled();
    });

    it.each([
      ["stdid-to-code", []],
      ["stdid-to-transcript", []],
      ["code-to-stdid", []],
    ] as const)("rejects empty targets for %s", async (mode, targets) => {
      const response = await bulkRequest({ mode, targets, allowCrossLookup: true });
      expect(response.status).toBe(400);
    });

    it("isolates malformed, self, not-found, and successful direct-code targets in input order", async () => {
      transcriptSpy.mockImplementation(async (stdId: string) => stdId === "1002"
        ? `<table><tr><td>Sinh viên: LATER TARGET</td><td>Mã số: 20000002</td><td>Lớp quản lý: QH-LATER</td></tr></table>`
        : "<html>headerless</html>");

      const response = await bulkRequest({ mode: "stdid-to-code", targets: ["bad", "1000", "1001", "1002"], allowCrossLookup: true });
      const payload = await response.json() as { data: { items: Array<Record<string, unknown>> } };

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(payload.data.items).toEqual([
        { target: "bad", status: "error", errorCode: "VNU_CROSS_LOOKUP_INVALID_TARGET" },
        { target: "1000", status: "error", errorCode: "VNU_CROSS_LOOKUP_SELF_TARGET" },
        { target: "1001", status: "error", errorCode: "VNU_CROSS_LOOKUP_NOT_FOUND" },
        { target: "1002", status: "ok", result: { studentCode: "20000002", studentName: "LATER TARGET", className: "QH-LATER" } },
      ]);
      expect(transcriptSpy.mock.calls.map((call: unknown[]) => call[0] as string)).toEqual(["1001", "1002"]);
      expect(probeBudget.amounts).toEqual([4]);
      expect(JSON.stringify(payload)).not.toContain("<html>");
    });

    it("reserves the resolver hard maximum once per code target without per-fetch double charging", async () => {
      transcriptSpy.mockImplementation(async (stdId: string) => {
        const code = 20_000_000 + Number(stdId) - 1_000;
        return `<table><tr><td>Sinh viên: TARGET</td><td>Mã số: ${code}</td><td>Lớp quản lý: QH-TARGET</td></tr></table>`;
      });

      const response = await bulkRequest({ mode: "code-to-stdid", targets: ["20000001", "20000002"], allowCrossLookup: true });
      const payload = await response.json() as { data: { items: Array<Record<string, unknown>> } };

      expect(response.status).toBe(200);
      expect(payload.data.items).toMatchObject([
        { target: "20000001", status: "ok", result: { stdId: "00000001001", probes: 1 } },
        { target: "20000002", status: "ok", result: { stdId: "00000001002", probes: 1 } },
      ]);
      expect(probeBudget.amounts).toEqual([44]);
      expect(transcriptSpy).toHaveBeenCalledTimes(2);
    });

    it("rejects the whole chunk reservation before any Brc1 request", async () => {
      probeBudget.limit = 4;
      const response = await bulkRequest({ mode: "stdid-to-transcript", targets: ["1001", "1002", "1003", "1004", "1005"], allowCrossLookup: true });

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_RATE_LIMITED" } });
      expect(transcriptSpy).not.toHaveBeenCalled();
    });

    it("fails with 503 before Brc1 when the reservation service is unavailable", async () => {
      probeBudget.unavailable = true;
      const response = await bulkRequest({ mode: "stdid-to-code", targets: ["1001"], allowCrossLookup: true });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_PROBE_BUDGET_UNAVAILABLE" } });
      expect(transcriptSpy).not.toHaveBeenCalled();
    });

    it("returns full parsed transcript models and no raw HTML", async () => {
      const response = await bulkRequest({ mode: "stdid-to-transcript", targets: ["1001"], allowCrossLookup: true });
      const payload = await response.json() as { data: { items: Array<Record<string, unknown>> } };

      expect(response.status).toBe(200);
      expect(payload.data.items).toMatchObject([{ target: "1001", status: "ok", result: { header: { studentCode: "20000001" }, terms: [{ maHK: "251" }], totals: { totalCredits: 3 } } }]);
      expect(JSON.stringify(payload)).not.toContain("<table>");
      expect(probeBudget.amounts).toEqual([1]);
    });

    it("removes upstream notice prose from bulk transcript results", async () => {
      const upstreamNoticeSentinel = "UPSTREAM_NOTICE_SENTINEL_DO_NOT_EXPOSE";
      transcriptSpy.mockResolvedValue(`${targetTranscriptHtml}<font color="red">${upstreamNoticeSentinel}</font>`);

      const response = await bulkRequest({ mode: "stdid-to-transcript", targets: ["1001"], allowCrossLookup: true });
      const payload = await response.text();

      expect(response.status).toBe(200);
      expect(payload).not.toContain(upstreamNoticeSentinel);
      expect(payload).not.toContain("notice");
    });

    it("keeps reservations isolated between sessions", async () => {
      probeBudget.limit = 1;
      const first = await bulkRequest({ mode: "stdid-to-code", targets: ["1001"], allowCrossLookup: true }, { ...vnuSession(), vnu: { ...vnuSession().vnu!, value: "BULK_SESSION_A" } });
      const exhausted = await bulkRequest({ mode: "stdid-to-code", targets: ["1002"], allowCrossLookup: true }, { ...vnuSession(), vnu: { ...vnuSession().vnu!, value: "BULK_SESSION_A" } });
      const second = await bulkRequest({ mode: "stdid-to-code", targets: ["1002"], allowCrossLookup: true }, { ...vnuSession(), vnu: { ...vnuSession().vnu!, value: "BULK_SESSION_B" } });

      expect([first.status, exhausted.status, second.status]).toEqual([200, 429, 200]);
      expect(new Set(probeBudget.identities).size).toBe(2);
    });
  });

  it("keeps far walking disabled by default before any Brc1 fetch", async () => {
    const response = await authorizedRequest("stdCode=20000065&allowCrossLookup=true", "student-id");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_NOT_CONVERGED" } });
    expect(probeBudget.count).toBe(0);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("permits far walking only when the test environment sets literal true", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_FAR_WALK_ENABLED: "true" });
    transcriptSpy.mockImplementation(async (stdId: string) => {
      const studentCode = 20_000_000 + Number(stdId) - 1_000;
      return `<table><tr><td>Sinh viên: SYNTHETIC TARGET</td><td>Mã số: ${studentCode}</td><td>Lớp quản lý: QH-SYNTHETIC</td></tr></table>`;
    });

    const response = await authorizedRequest("stdCode=20000100&allowCrossLookup=true", "student-id");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { stdId: "00000001100", stdCode: "20000100" } });
    expect(probeBudget.count).toBeGreaterThan(0);
  });

  it.each([true, "true", 1, "1", "TRUE", "True"])("ignores config-file far-walk value %j", (configValue) => {
    const fileConfig = { VNU_FAR_WALK_ENABLED: configValue } as unknown as RuntimeConfig;

    const config = selfHostedRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET }, fileConfig);

    expect(config.VNU_FAR_WALK_ENABLED).toBeUndefined();
    expect(isVnuFarWalkEnabled(config.VNU_FAR_WALK_ENABLED)).toBe(false);
  });

  it.each([undefined, "false", "1", "TRUE", "True", " true", "true "])("rejects non-literal environment value %j", (environmentValue) => {
    const config = selfHostedRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      VNU_FAR_WALK_ENABLED: environmentValue,
    }, {});

    expect(isVnuFarWalkEnabled(config.VNU_FAR_WALK_ENABLED)).toBe(false);
  });

  it("enables far walking for the exact environment string true", () => {
    const config = selfHostedRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      VNU_FAR_WALK_ENABLED: "true",
    }, {});

    expect(isVnuFarWalkEnabled(config.VNU_FAR_WALK_ENABLED)).toBe(true);
  });
});
