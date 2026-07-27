import { configureLogger, decryptSession, encryptSession, HyeboardError, type EncryptedSessionPayload } from "@hyeboard/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  getAdapter: vi.fn(),
  importSession: vi.fn(),
}));

vi.mock("@hyeboard/university-adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hyeboard/university-adapters")>();
  return { ...actual, getAdapter: adapterMocks.getAdapter };
});

import { createApp, createCaptchaRelayToken, resolveSession, setCaptchaRelayCoordinator, setRuntimeConfig } from "./app";
import { LocalCaptchaRelayCoordinator, type CaptchaRelayCoordinator } from "./captcha-relay";

const SESSION_SECRET = "worker-test-secret-worker-test-secret";
const VNU_STUDENT_CODE = "SYNTHETIC-STUDENT-001";
const SESSION_DEATH_CODES = ["MISSING_SESSION", "SESSION_EXPIRED", "INVALID_SESSION"];
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

async function importVnu(app: ReturnType<typeof createApp>): Promise<VnuImportResponse> {
  const response = await app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vnuUsername: "SYNTHETIC_VNU_USER", vnuPassword: "SYNTHETIC_VNU_PASSWORD" }),
  }));
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
    expect(SESSION_DEATH_CODES).not.toContain(code);
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

  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    syntheticTime = 1_800_000_000_000;
    dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => syntheticTime);
    cache = new TestCache(() => syntheticTime);
    vi.stubGlobal("caches", { default: cache });
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    adapterMocks.importSession.mockResolvedValue(importedVnu());
    app = createApp(undefined);
  });

  afterEach(() => {
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

  it("re-encrypts an equivalent session with its original expiry on a cache hit", async () => {
    const first = await importVnu(app);
    const cached = await cache.importEntry();
    const second = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(second.token).not.toBe(first.token);
    expect(second.token).not.toBe(cached.seed);
    expect(second.session).toEqual(first.session);
    const firstPayload = await decryptSession(first.token, SESSION_SECRET);
    const secondPayload = await decryptSession(second.token, SESSION_SECRET);
    expect(secondPayload).toEqual(firstPayload);
    expect(secondPayload.expiresAt).toBe("2099-01-01T00:00:00.000Z");
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
