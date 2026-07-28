import { configureLogger, createVnuRefreshGrant, decryptSession, decryptSessionForVnuLogout, decryptVnuRefreshGrant, encryptSession, encryptVnuRefreshGrant, HyeboardError, VNU_REFRESH_GRANT_MAX_LENGTH, type EncryptedSessionPayload } from "@hyeboard/core";
import { DaotaoClient } from "@hyeboard/university-adapters";
import { authResultSchema } from "@hyeboard/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  getAdapter: vi.fn(),
  importSession: vi.fn(),
}));

vi.mock("@hyeboard/university-adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hyeboard/university-adapters")>();
  return { ...actual, getAdapter: adapterMocks.getAdapter };
});

import { createApp, createCaptchaRelayToken, requestLogPath, resolveSession, setCaptchaRelayCoordinator, setRuntimeConfig, setVnuProbeBudgetCoordinator, setVnuRefreshControlCoordinator, type RuntimeConfig } from "./app";
import { LocalCaptchaRelayCoordinator, type CaptchaRelayCoordinator } from "./captcha-relay";
import { selfHostedRuntimeConfig } from "./start";
import type { VnuProbeBudgetCoordinator } from "./vnu-probe-budget";
import {
  applyAbortRefresh,
  applyBeginRefresh,
  applyCompleteRefresh,
  applyRevokeExactLinkedPair,
  applyRevokeLinkedPairByAccess,
  checkAccessAuthoritatively,
  DurableObjectVnuRefreshControlCoordinator,
  nextVnuRefreshAlarm,
  parseVnuRefreshControlState,
  type AccessCheckResult,
  type AccessDescriptorRef,
  type BeginRefreshResult,
  type LinkedPair,
  type VnuRefreshControlCoordinator,
  type VnuRefreshControlNamespace,
  type VnuRefreshControlState,
  type VnuRefreshControlStorage,
  type VnuRefreshControlStub,
} from "./vnu-refresh-control";

const SESSION_SECRET = "worker-test-secret-worker-test-secret";
const VNU_AUTH_BODY_MAX_BYTES = VNU_REFRESH_GRANT_MAX_LENGTH
  + new TextEncoder().encode('{"refreshGrant":""}').byteLength
  + 32;
const VNU_STUDENT_CODE = "SYNTHETIC-STUDENT-001";
const SYNTHETIC_VNU_CODE = 99_000_001;
const SYNTHETIC_VNU_STD_ID = 99_000_000_001;
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function encryptRawLegacySessionFixture(payload: unknown): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(SESSION_SECRET));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12).fill(0x62);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(encoder.encode(JSON.stringify(payload))),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

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

type CoordinatorVnuImportResponse = {
  token: string;
  refreshGrant: string;
  session: {
    universityId: string;
    studentCode?: string;
    expiresAt: string;
    authenticated: true;
  };
};

type AccessOnlyVnuImportResponse = Omit<CoordinatorVnuImportResponse, "refreshGrant">;

type CoordinatorFailureMode = "outage" | "corrupted" | "storage" | "rpc";
type RefreshControlOperation = "begin" | "complete" | "abort" | "revoke-linked" | "revoke-exact";

class TestVnuImportRefreshControl implements VnuRefreshControlCoordinator {
  readonly activations: Array<{ principalKey: string; pair: LinkedPair }> = [];
  readonly checks: Array<{ principalKey: string; pair: AccessDescriptorRef }> = [];
  accessResult?: AccessCheckResult;
  readonly activePairs = new Map<string, LinkedPair>();
  readonly revokedPairs = new Map<string, LinkedPair[]>();
  readonly revocationAttempts: Array<{ principalKey: string; pair: AccessDescriptorRef }> = [];
  readonly beginAttempts: Array<{ principalKey: string; pair: LinkedPair }> = [];
  readonly completionAttempts: Array<{ principalKey: string; old: LinkedPair; next: LinkedPair }> = [];
  readonly abortAttempts: Array<{ principalKey: string; pair: LinkedPair; terminal: boolean }> = [];
  readonly exactRevocationAttempts: Array<{ principalKey: string; pair: LinkedPair }> = [];
  readonly leasedPrincipals = new Set<string>();
  beginResult?: BeginRefreshResult;
  revokeResult?: "revoked" | "mismatch" | "expired";
  failureMode?: CoordinatorFailureMode;
  failureOperation?: RefreshControlOperation;
  mutationCount = 0;
  cleanupWriteCount = 0;
  alarmUpdateCount = 0;
  staleCleanupPending = false;

  private throwIfUnavailable(operation?: RefreshControlOperation): void {
    if (!this.failureMode || (this.failureOperation && this.failureOperation !== operation)) return;
    throw new Error(`SYNTHETIC_${this.failureMode.toUpperCase()}_SENTINEL`);
  }

  async activatePair(principalKey: string, pair: LinkedPair): Promise<void> {
    this.throwIfUnavailable();
    const previous = this.activePairs.get(principalKey);
    if (previous && JSON.stringify(previous) !== JSON.stringify(pair)) {
      this.revokedPairs.set(principalKey, [...(this.revokedPairs.get(principalKey) ?? []), previous]);
    }
    this.activations.push({ principalKey, pair });
    this.activePairs.set(principalKey, pair);
    this.mutationCount += 1;
  }

  async checkAccess(principalKey: string, pair: AccessDescriptorRef): Promise<AccessCheckResult> {
    this.throwIfUnavailable();
    this.checks.push({ principalKey, pair });
    if (this.staleCleanupPending) {
      this.staleCleanupPending = false;
      this.cleanupWriteCount += 1;
      this.alarmUpdateCount += 1;
      this.mutationCount += 1;
    }
    if (this.accessResult) return this.accessResult;
    return JSON.stringify(this.activePairs.get(principalKey)) === JSON.stringify(pair) ? { kind: "active" } : { kind: "revoked" };
  }

  async beginRefresh(principalKey: string, pair: LinkedPair): Promise<BeginRefreshResult> {
    this.throwIfUnavailable("begin");
    this.beginAttempts.push({ principalKey, pair });
    if (this.beginResult) return this.beginResult;
    if (JSON.stringify(this.activePairs.get(principalKey)) !== JSON.stringify(pair)) return { kind: "revoked" };
    if (this.leasedPrincipals.has(principalKey)) return { kind: "in-progress", retryAfterSeconds: 120 };
    this.leasedPrincipals.add(principalKey);
    return { kind: "accepted", leaseExpiresAt: Date.now() + 120_000 };
  }
  async completeRefresh(principalKey: string, input: { old: LinkedPair; next: LinkedPair }): Promise<"completed" | "revoked"> {
    this.throwIfUnavailable("complete");
    this.completionAttempts.push({ principalKey, ...input });
    if (JSON.stringify(this.activePairs.get(principalKey)) !== JSON.stringify(input.old)) return "revoked";
    this.leasedPrincipals.delete(principalKey);
    this.activePairs.set(principalKey, input.next);
    this.revokedPairs.set(principalKey, [...(this.revokedPairs.get(principalKey) ?? []), input.old]);
    this.mutationCount += 1;
    return "completed";
  }
  async abortRefresh(principalKey: string, input: { pair: LinkedPair; terminal: boolean }): Promise<void> {
    this.throwIfUnavailable("abort");
    this.abortAttempts.push({ principalKey, ...input });
    this.leasedPrincipals.delete(principalKey);
    if (!input.terminal || JSON.stringify(this.activePairs.get(principalKey)) !== JSON.stringify(input.pair)) return;
    this.activePairs.delete(principalKey);
    this.revokedPairs.set(principalKey, [...(this.revokedPairs.get(principalKey) ?? []), input.pair]);
    this.mutationCount += 1;
  }
  async revokeLinkedPairByAccess(principalKey: string, pair: AccessDescriptorRef): Promise<"revoked" | "mismatch" | "expired"> {
    this.throwIfUnavailable("revoke-linked");
    this.revocationAttempts.push({ principalKey, pair });
    if (this.revokeResult) return this.revokeResult;
    if (pair.accessExpiresAt <= Date.now() && pair.grantExpiresAt <= Date.now()) return "expired";
    const active = this.activePairs.get(principalKey);
    if (JSON.stringify(active) === JSON.stringify(pair)) {
      this.leasedPrincipals.delete(principalKey);
      this.activePairs.delete(principalKey);
      this.revokedPairs.set(principalKey, [...(this.revokedPairs.get(principalKey) ?? []), pair]);
      this.mutationCount += 1;
      return "revoked";
    }
    if ((this.revokedPairs.get(principalKey) ?? []).some((revoked) => JSON.stringify(revoked) === JSON.stringify(pair))) return "revoked";
    return "mismatch";
  }
  async revokeExactLinkedPair(principalKey: string, pair: LinkedPair): Promise<"revoked" | "mismatch" | "expired"> {
    this.throwIfUnavailable("revoke-exact");
    this.exactRevocationAttempts.push({ principalKey, pair });
    if (JSON.stringify(this.activePairs.get(principalKey)) !== JSON.stringify(pair)) return "mismatch";
    this.activePairs.delete(principalKey);
    this.revokedPairs.set(principalKey, [...(this.revokedPairs.get(principalKey) ?? []), pair]);
    this.mutationCount += 1;
    return "revoked";
  }
}

class InstrumentedVnuRefreshStorage implements VnuRefreshControlStorage {
  getCount = 0;
  transactionCount = 0;
  putCount = 0;
  deleteCount = 0;
  alarmUpdateCount = 0;
  getFailure?: Error;
  transactionFailure?: Error;

  constructor(public stored: unknown) {}

  resetCounts(): void {
    this.getCount = 0;
    this.transactionCount = 0;
    this.putCount = 0;
    this.deleteCount = 0;
    this.alarmUpdateCount = 0;
  }

  async get(): Promise<unknown> {
    this.getCount += 1;
    if (this.getFailure) throw this.getFailure;
    return this.stored;
  }

  async transaction<T>(body: (
    stored: unknown,
    put: (state: VnuRefreshControlState) => Promise<void>,
    deleteState: () => Promise<void>,
    setAlarm: (at: number | undefined) => Promise<void>,
  ) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    if (this.transactionFailure) throw this.transactionFailure;
    return body(
      this.stored,
      async (state) => { this.putCount += 1; this.stored = state; },
      async () => { this.deleteCount += 1; this.stored = undefined; },
      async () => { this.alarmUpdateCount += 1; },
    );
  }
}

type ProductionAuthorityHarness = {
  coordinator: DurableObjectVnuRefreshControlCoordinator;
  storage: InstrumentedVnuRefreshStorage;
  objectNames: string[];
  checkInputs: AccessDescriptorRef[];
};

function activeAuthorityState(pair: LinkedPair, staleAccessId?: string): VnuRefreshControlState {
  return {
    active: pair,
    revokedAccess: staleAccessId ? { [staleAccessId]: 1 } : {},
    revokedGrants: {},
    window: { count: 0, resetAt: Date.now() + 60_000 },
  };
}

function emptyAuthorityState(): VnuRefreshControlState {
  return { revokedAccess: {}, revokedGrants: {}, window: { count: 0, resetAt: Date.now() + 60_000 } };
}

function productionAuthorityHarness(stored: unknown, options: { rpcFailure?: Error; expectedPrincipal?: string } = {}): ProductionAuthorityHarness {
  const storage = new InstrumentedVnuRefreshStorage(stored);
  const unrelatedStorage = new InstrumentedVnuRefreshStorage(emptyAuthorityState());
  const objectNames: string[] = [];
  const checkInputs: AccessDescriptorRef[] = [];
  const unsupported = async (): Promise<never> => { throw new Error("not used"); };
  const stubFor = (stubStorage: InstrumentedVnuRefreshStorage): VnuRefreshControlStub => ({
    activatePair: unsupported,
    async checkAccess(access) {
      checkInputs.push(access);
      if (options.rpcFailure) throw options.rpcFailure;
      return checkAccessAuthoritatively(stubStorage, access, Date.now());
    },
    beginRefresh: unsupported,
    completeRefresh: unsupported,
    abortRefresh: unsupported,
    revokeLinkedPairByAccess: unsupported,
    revokeExactLinkedPair: unsupported,
  });
  const expectedPrincipal = options.expectedPrincipal ?? "a".repeat(64);
  const namespace: VnuRefreshControlNamespace = {
    getByName(name) { objectNames.push(name); return stubFor(name === expectedPrincipal ? storage : unrelatedStorage); },
  };
  return { coordinator: new DurableObjectVnuRefreshControlCoordinator(namespace), storage, objectNames, checkInputs };
}

function productionRefreshAuthorityHarness(
  stored: VnuRefreshControlState,
  principalKey: string,
  revokeGate: { markEntered: () => void; release: Promise<void> },
  options: { throwAfterComplete?: boolean; completeGate?: { markEntered: () => void; release: Promise<void> } } = {},
) {
  const storage = new InstrumentedVnuRefreshStorage(stored);
  const calls = { begin: 0, complete: 0, abort: 0, revokeLinked: 0 };
  const mutate = async <T>(transition: (state: VnuRefreshControlState | undefined, now: number) => { state: VnuRefreshControlState; result: T; changed: boolean }): Promise<T> => {
    return storage.transaction(async (raw, put, _deleteState, setAlarm) => {
      const output = transition(parseVnuRefreshControlState(raw), Date.now());
      if (output.changed) {
        await put(output.state);
        await setAlarm(nextVnuRefreshAlarm(output.state));
      }
      return output.result;
    });
  };
  const unsupported = async (): Promise<never> => { throw new Error("not used"); };
  const stub: VnuRefreshControlStub = {
    activatePair: unsupported,
    checkAccess: (pair) => checkAccessAuthoritatively(storage, pair, Date.now()),
    beginRefresh: async (pair) => { calls.begin += 1; return mutate((state, now) => applyBeginRefresh(state, pair, now)); },
    completeRefresh: async (input) => {
      calls.complete += 1;
      options.completeGate?.markEntered();
      await options.completeGate?.release;
      const result = await mutate((state, now) => applyCompleteRefresh(state, input, now));
      if (options.throwAfterComplete) throw new Error("SYNTHETIC_COMPLETION_DELIVERY_LOSS");
      return result;
    },
    abortRefresh: async (input) => { calls.abort += 1; return mutate((state, now) => applyAbortRefresh(state, input, now)); },
    revokeLinkedPairByAccess: async (pair) => {
      calls.revokeLinked += 1;
      revokeGate.markEntered();
      await revokeGate.release;
      return mutate((state, now) => applyRevokeLinkedPairByAccess(state, pair, now));
    },
    revokeExactLinkedPair: (pair) => mutate((state, now) => applyRevokeExactLinkedPair(state, pair, now)),
  };
  const namespace: VnuRefreshControlNamespace = { getByName: (name) => {
    if (name !== principalKey) throw new Error("unexpected principal");
    return stub;
  } };
  return { coordinator: new DurableObjectVnuRefreshControlCoordinator(namespace), storage, calls };
}

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
    return [...this.store.keys()].filter((key) => key.startsWith("https://hyeboard.internal/cache/vnu/raw/"));
  }

  revocationUrls(): string[] {
    return [...this.store.keys()].filter((key) => key.includes("/cache/revoked-token/"));
  }

  importUrl(): string {
    const url = [...this.store.keys()].find((key) => key.includes("/cache/vnu/import/"));
    if (!url) throw new Error("VNU import cache entry was not written");
    return url;
  }

  async importEntry(): Promise<{
    seed: string;
    session: CoordinatorVnuImportResponse["session"];
  }> {
    return await this.store.get(this.importUrl())!.response.clone().json() as {
      seed: string;
      session: CoordinatorVnuImportResponse["session"];
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

  setOnlyRawEntry(value: unknown): void {
    const rawUrls = this.rawUrls();
    if (rawUrls.length !== 1) throw new Error(`Expected one VNU raw cache entry, found ${rawUrls.length}`);
    this.store.set(rawUrls[0], {
      response: new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
      }),
      expiresAt: this.currentTime() + 300_000,
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
  readonly consumedAmounts: number[] = [];
  readonly reservedAmounts: number[] = [];
  readonly counts = new Map<string, number>();
  limit = Number.POSITIVE_INFINITY;
  unavailable = false;

  get count(): number {
    return [...this.counts.values()].reduce((total, count) => total + count, 0);
  }

  async consume(sessionIdentity: string, amount = 1): Promise<void> {
    this.consumedAmounts.push(amount);
    await this.record(sessionIdentity, amount);
  }

  async reserve(sessionIdentity: string, amount: number): Promise<void> {
    this.reservedAmounts.push(amount);
    await this.record(sessionIdentity, amount);
  }

  private async record(sessionIdentity: string, amount: number): Promise<void> {
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

}

async function requestVnuImport(app: ReturnType<typeof createApp>): Promise<Response> {
  return app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vnuUsername: "SYNTHETIC_VNU_USER", vnuPassword: "SYNTHETIC_VNU_PASSWORD" }),
  }));
}

async function requestVnuRefresh(app: ReturnType<typeof createApp>, token: string, refreshGrant: string): Promise<Response> {
  return app.handle(new Request("http://localhost/api/vnu/auth/refresh", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ refreshGrant }),
  }));
}

async function requestVnuLogout(app: ReturnType<typeof createApp>, token: string, refreshGrant?: string): Promise<Response> {
  return app.handle(new Request("http://localhost/api/vnu/auth/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(refreshGrant === undefined ? {} : { refreshGrant }),
  }));
}

async function requestVnuLogoutWithoutBody(app: ReturnType<typeof createApp>, token: string): Promise<Response> {
  return app.handle(new Request("http://localhost/api/vnu/auth/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }));
}

function enteredOperation<T>() {
  let markEntered!: () => void;
  let release!: (value: T) => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const result = new Promise<T>((resolve) => { release = resolve; });
  return { entered, markEntered, result, release };
}

function largestAcceptedWorkerPasswordLength(now: number): number {
  let low = 1;
  let high = VNU_REFRESH_GRANT_MAX_LENGTH;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    try {
      createVnuRefreshGrant({
        username: "synthetic_vnu_user",
        password: "P".repeat(candidate),
        expectedStudentCode: VNU_STUDENT_CODE,
        now,
      });
      low = candidate;
    } catch {
      high = candidate - 1;
    }
  }
  return low;
}

function chunkedJsonRequest(path: string, token: string, chunks: string[], onPull: () => void = () => undefined): Request {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull();
      if (index >= chunks.length) return controller.close();
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  }, { highWaterMark: 0 });
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("request-log privacy", () => {
  it("requestLogPath strips query identifiers and opt-in values", () => {
    expect(requestLogPath("https://hyeboard.test/api/vnu/cross-lookup/student-id?stdCode=99000002&allowCrossLookup=true"))
      .toBe("/api/vnu/cross-lookup/student-id");
  });
});

async function importVnu(app: ReturnType<typeof createApp>): Promise<CoordinatorVnuImportResponse> {
  const response = await requestVnuImport(app);
  expect(response.status).toBe(200);
  const body = await response.json() as { data: CoordinatorVnuImportResponse; error: null };
  expect(body.error).toBeNull();
  expect(Object.keys(body.data).sort()).toEqual(["refreshGrant", "session", "token"]);
  expect(Object.keys(body.data.session).sort()).toEqual(["authenticated", "expiresAt", "studentCode", "universityId"]);
  return body.data;
}

async function expectIssuedVnuAccess(token: string, expected: EncryptedSessionPayload): Promise<EncryptedSessionPayload> {
  const payload = await decryptSession(token, SESSION_SECRET);
  const { vnuRefresh, ...ordinary } = payload;
  expect(ordinary).toEqual(expected);
  expect(vnuRefresh).toMatchObject({
    version: 1,
    purpose: "vnu-refresh-access",
    accessExpiresAt: expected.expiresAt,
  });
  return payload;
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

function descriptorVnuSession(overrides: Partial<NonNullable<EncryptedSessionPayload["vnuRefresh"]>> = {}): EncryptedSessionPayload {
  const expiresAt = "2099-01-01T00:00:00.000Z";
  return {
    ...normalizedVnuSession(expiresAt),
    vnuRefresh: {
      version: 1,
      purpose: "vnu-refresh-access",
      principalKey: "a".repeat(64),
      accessTokenId: "A".repeat(22),
      grantId: `${"B".repeat(21)}A`,
      accessExpiresAt: expiresAt,
      grantExpiresAt: "2099-01-01T08:00:00.000Z",
      ...overrides,
    },
  };
}

function descriptorPairFixture(session: EncryptedSessionPayload): LinkedPair {
  const descriptor = session.vnuRefresh!;
  return {
    accessTokenId: descriptor.accessTokenId,
    accessExpiresAt: Date.parse(descriptor.accessExpiresAt),
    grantId: descriptor.grantId,
    grantExpiresAt: Date.parse(descriptor.grantExpiresAt),
  };
}

describe("VNU access authority", () => {
  let authoritySession: EncryptedSessionPayload;
  let authority: ProductionAuthorityHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    authoritySession = descriptorVnuSession();
    authority = productionAuthorityHarness(activeAuthorityState(descriptorPairFixture(authoritySession)));
    setVnuRefreshControlCoordinator(authority.coordinator);
  });

  afterEach(() => setVnuRefreshControlCoordinator(undefined));

  it("checks the exact descriptor authority before accepting an ordinary session", async () => {
    const session = descriptorVnuSession();
    const token = await encryptSession(session, SESSION_SECRET);

    await expect(resolveSession({ Authorization: `Bearer ${token}` })).resolves.toEqual({ session });
    expect(authority.objectNames).toEqual([session.vnuRefresh!.principalKey]);
    expect(authority.checkInputs).toEqual([descriptorPairFixture(session)]);
    expect(authority.storage.getCount).toBe(1);
  });

  it("performs exact read-only authority checks on three repeated active requests before upstream", async () => {
    const session = descriptorVnuSession();
    const pair = descriptorPairFixture(session);
    const getStudentProfile = vi.fn(async () => ({ id: "SYNTHETIC_PROFILE", fullName: "SYNTHETIC PROFILE", universityId: "vnu" }));
    adapterMocks.getAdapter.mockReturnValue({ getStudentProfile });
    const app = createApp(undefined);
    const token = await encryptSession(session, SESSION_SECRET);

    const responses = await Promise.all(Array.from({ length: 3 }, () => app.handle(new Request("http://localhost/api/vnu/me", {
      headers: { Authorization: `Bearer ${token}` },
    }))));

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(authority.objectNames).toEqual(Array.from({ length: 3 }, () => session.vnuRefresh!.principalKey));
    expect(authority.checkInputs).toEqual(Array.from({ length: 3 }, () => pair));
    expect(getStudentProfile).toHaveBeenCalledTimes(3);
    expect(authority.storage.getCount).toBe(3);
    expect(authority.storage.transactionCount).toBe(0);
    expect(authority.storage.putCount).toBe(0);
    expect(authority.storage.deleteCount).toBe(0);
    expect(authority.storage.alarmUpdateCount).toBe(0);
  });

  it("applies stale authority cleanup once and keeps later checks read-only", async () => {
    const session = descriptorVnuSession();
    const pair = descriptorPairFixture(session);
    authority = productionAuthorityHarness(activeAuthorityState(pair, `${"Z".repeat(21)}A`));
    setVnuRefreshControlCoordinator(authority.coordinator);
    const getStudentProfile = vi.fn(async () => ({ id: "SYNTHETIC_PROFILE", fullName: "SYNTHETIC PROFILE", universityId: "vnu" }));
    adapterMocks.getAdapter.mockReturnValue({ getStudentProfile });
    const app = createApp(undefined);
    const token = await encryptSession(session, SESSION_SECRET);

    const first = await app.handle(new Request("http://localhost/api/vnu/me", { headers: { Authorization: `Bearer ${token}` } }));
    expect(first.status).toBe(200);
    expect(authority.storage.getCount).toBe(1);
    expect(authority.storage.transactionCount).toBe(1);
    expect(authority.storage.putCount).toBe(1);
    expect(authority.storage.alarmUpdateCount).toBe(1);
    const second = await app.handle(new Request("http://localhost/api/vnu/me", { headers: { Authorization: `Bearer ${token}` } }));
    expect(second.status).toBe(200);
    expect(authority.storage.getCount).toBe(2);
    expect(authority.storage.transactionCount).toBe(1);
    expect(authority.storage.putCount).toBe(1);
    expect(authority.storage.alarmUpdateCount).toBe(1);
    expect(getStudentProfile).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["wrong namespace", { purpose: "other-purpose" }],
    ["malformed identifier", { accessTokenId: "NOT_CANONICAL" }],
    ["broken access-expiry link", { accessExpiresAt: "2099-01-01T00:00:01.000Z" }],
  ])("rejects a %s descriptor before coordinator access", async (_label, descriptorPatch) => {
    const malformed = descriptorVnuSession(descriptorPatch as never);
    const token = await encryptRawLegacySessionFixture(malformed);

    await expect(resolveSession({ Authorization: `Bearer ${token}` })).rejects.toMatchObject({ code: "INVALID_SESSION", status: 401 });
    expect(authority.checkInputs).toEqual([]);
  });

  it("rejects revoked descriptor authority without upstream access", async () => {
    authority = productionAuthorityHarness(emptyAuthorityState());
    setVnuRefreshControlCoordinator(authority.coordinator);
    const profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml");
    const token = await encryptSession(descriptorVnuSession(), SESSION_SECRET);

    await expect(resolveSession({ Authorization: `Bearer ${token}` })).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });
    expect(profileSpy).not.toHaveBeenCalled();
    profileSpy.mockRestore();
  });

  it.each([
    ["principal namespace", (_session: EncryptedSessionPayload) => descriptorVnuSession({ principalKey: "b".repeat(64) })],
    ["access ID", (_session: EncryptedSessionPayload) => descriptorVnuSession({ accessTokenId: `${"C".repeat(21)}A` })],
    ["grant ID/link", (_session: EncryptedSessionPayload) => descriptorVnuSession({ grantId: `${"D".repeat(21)}A` })],
    ["access expiry", (_session: EncryptedSessionPayload) => {
      const expiresAt = "2099-01-01T00:00:01.000Z";
      return { ...descriptorVnuSession({ accessExpiresAt: expiresAt }), expiresAt };
    }],
    ["grant expiry", (_session: EncryptedSessionPayload) => descriptorVnuSession({ grantExpiresAt: "2099-01-01T08:00:01.000Z" })],
  ])("rejects wrong %s authority without upstream or mutation", async (_label, alterSession) => {
    const activeSession = descriptorVnuSession();
    const getStudentProfile = vi.fn();
    adapterMocks.getAdapter.mockReturnValue({ getStudentProfile });
    const app = createApp(undefined);
    const token = await encryptSession(alterSession(activeSession), SESSION_SECRET);

    const response = await app.handle(new Request("http://localhost/api/vnu/me", {
      headers: { Authorization: `Bearer ${token}` },
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ data: null, error: { code: "SESSION_EXPIRED", message: "Session expired" } });
    expect(getStudentProfile).not.toHaveBeenCalled();
    expect(authority.storage.transactionCount).toBe(0);
    expect(authority.storage.putCount).toBe(0);
  });

  it.each(["corrupted", "get", "transaction", "rpc"] as const)("sanitizes production %s authority failure without upstream", async (failureMode) => {
    const sentinels = [
      `SYNTHETIC_${failureMode.toUpperCase()}_SENTINEL`,
      "UPSTREAM_PROSE_SENTINEL",
      "TOKEN_SENTINEL",
      "GRANT_SENTINEL",
      "PRINCIPAL_SENTINEL",
      "USERNAME_SENTINEL",
      "STUDENT_CODE_SENTINEL",
      "PROFILE_SENTINEL",
      "COOKIE_SENTINEL",
    ];
    const lines: string[] = [];
    configureLogger({ level: "error", mode: "node", destination: { write: (line) => lines.push(line) } });
    const pair = descriptorPairFixture(authoritySession);
    if (failureMode === "corrupted") authority = productionAuthorityHarness({ privateState: "SYNTHETIC_CORRUPTED_SENTINEL" });
    if (failureMode === "get") {
      authority = productionAuthorityHarness(activeAuthorityState(pair));
      authority.storage.getFailure = new Error("SYNTHETIC_GET_SENTINEL");
    }
    if (failureMode === "transaction") {
      authority = productionAuthorityHarness(activeAuthorityState(pair, `${"Z".repeat(21)}A`));
      authority.storage.transactionFailure = new Error("SYNTHETIC_TRANSACTION_SENTINEL");
    }
    if (failureMode === "rpc") {
      authority = productionAuthorityHarness(activeAuthorityState(pair), { rpcFailure: new Error("SYNTHETIC_RPC_SENTINEL") });
    }
    setVnuRefreshControlCoordinator(authority.coordinator);
    const getStudentProfile = vi.fn();
    adapterMocks.getAdapter.mockReturnValue({ getStudentProfile });
    const app = createApp(undefined);
    const token = await encryptSession(descriptorVnuSession(), SESSION_SECRET);

    const response = await app.handle(new Request("http://localhost/api/vnu/me", {
      headers: { Authorization: `Bearer ${token}` },
    }));
    const payloadText = await response.text();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const logText = lines.join("\n");

    expect(response.status).toBe(503);
    expect(JSON.parse(payloadText)).toEqual({
      data: null,
      error: {
        code: "VNU_REFRESH_UNAVAILABLE",
        message: "VNU reconnect is temporarily unavailable. Try again.",
        details: { retryAfterSeconds: 5 },
      },
    });
    expect(getStudentProfile).not.toHaveBeenCalled();
    expect(authority.storage.putCount).toBe(0);
    expect(authority.storage.deleteCount).toBe(0);
    expect(authority.storage.alarmUpdateCount).toBe(0);
    for (const sentinel of sentinels) {
      expect(payloadText).not.toContain(sentinel);
      expect(logText).not.toContain(sentinel);
    }
    expect(logText).not.toContain('"stack"');
    expect(logText).not.toContain('"reqId"');
    configureLogger({ level: "silent", mode: "node" });
  });

  it("never calls descriptor authority for a legacy VNU token", async () => {
    const session = normalizedVnuSession();
    const token = await encryptSession(session, SESSION_SECRET);

    await expect(resolveSession({ Authorization: `Bearer ${token}` })).resolves.toEqual({ session });
    expect(authority.checkInputs).toEqual([]);
  });

  it("keeps descriptorless VNU tokens on the existing raw cache path without refresh eligibility", async () => {
    const cache = new TestCache(() => Date.now());
    vi.stubGlobal("caches", { default: cache });
    const gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>SYNTHETIC_LEGACY_GRADES</html>");
    const session = normalizedVnuSession();
    const token = await encryptSession(session, SESSION_SECRET);
    const app = createApp(undefined);

    const first = await getVnuRawPage(app, token);
    const second = await getVnuRawPage(app, token);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ data: { html: "<html>SYNTHETIC_LEGACY_GRADES</html>" }, error: null });
    expect(gradesSpy).toHaveBeenCalledTimes(1);
    expect(authority.checkInputs).toEqual([]);
    expect(authority.storage.getCount).toBe(0);
    expect(session.vnuRefresh).toBeUndefined();
    gradesSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("fails descriptor-bearing self-hosted sessions closed", async () => {
    setVnuRefreshControlCoordinator(undefined);
    const token = await encryptSession(descriptorVnuSession(), SESSION_SECRET);

    await expect(resolveSession({ Authorization: `Bearer ${token}` })).rejects.toMatchObject({ code: "VNU_REFRESH_UNAVAILABLE", status: 503 });
  });
});

describe("JSON error detail boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
  });

  async function rejectedImport(details: unknown): Promise<Record<string, unknown>> {
    adapterMocks.importSession.mockRejectedValue(new HyeboardError("SYNTHETIC_REJECTION", "Safe synthetic rejection", 429, details));
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    const response = await createApp(undefined).handle(new Request("http://localhost/api/mock/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(429);
    const payload = await response.json() as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return payload;
  }

  it("includes only a fully valid allow-listed detail object", async () => {
    await expect(rejectedImport({ retryAfterSeconds: 5, limit: 5, windowSeconds: 900 })).resolves.toMatchObject({
      error: { details: { retryAfterSeconds: 5, limit: 5, windowSeconds: 900 } },
    });
  });

  it.each([
    { retryAfterSeconds: 5, privateCredential: "PRIVATE_SENTINEL" },
    { reason: "OTHER_REASON" },
    "NONOBJECT_SENTINEL",
  ])("omits mixed, unknown, and nonobject details atomically", async (details) => {
    const payload = await rejectedImport(details);
    expect(payload).toMatchObject({ error: { code: "SYNTHETIC_REJECTION" } });
    expect((payload.error as Record<string, unknown>).details).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_SENTINEL");
  });

  it("omits circular details instead of failing serialization", async () => {
    const details: Record<string, unknown> = { retryAfterSeconds: 5 };
    details.circular = details;

    const payload = await rejectedImport(details);
    expect((payload.error as Record<string, unknown>).details).toBeUndefined();
  });

  it("rejects empty access-token and refresh-grant wire values", () => {
    const session = { universityId: "vnu", studentCode: VNU_STUDENT_CODE, expiresAt: "2099-01-01T00:00:00.000Z", authenticated: true };

    expect(authResultSchema.safeParse({ token: "", session }).success).toBe(false);
    expect(authResultSchema.safeParse({ token: "SYNTHETIC_TOKEN", refreshGrant: "", session }).success).toBe(false);
    expect(authResultSchema.safeParse({ token: "SYNTHETIC_TOKEN", refreshGrant: "SYNTHETIC_GRANT", session }).success).toBe(true);
  });
});

describe("VNU recoverability classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
  });

  afterEach(() => configureLogger({ level: "silent", mode: "node" }));

  it("marks only a missing VNU credential with the recoverable reason", async () => {
    const token = await encryptSession({ ...normalizedVnuSession(), vnu: undefined }, SESSION_SECRET);
    const response = await getVnuRawPage(createApp(undefined), token);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      data: null,
      error: {
        code: "VNU_LOGIN_REQUIRED",
        message: "VNU data needs an active university portal credential.",
        details: { reason: "MISSING_VNU_CREDENTIAL" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it.each([
    ["Hyeboard", new HyeboardError("SYNTHETIC_VNU_FAILURE", "UPSTREAM_PROSE_SENTINEL TOKEN_SENTINEL GRANT_SENTINEL", 502)],
    ["unexpected", new Error("UPSTREAM_PROSE_SENTINEL TOKEN_SENTINEL GRANT_SENTINEL PRINCIPAL_SENTINEL USERNAME_SENTINEL STUDENT_CODE_SENTINEL PROFILE_SENTINEL COOKIE_SENTINEL")],
  ])("uses constant private-free VNU logging for %s route failures", async (_label, routeFailure) => {
    const lines: string[] = [];
    configureLogger({ level: "error", mode: "node", destination: { write: (line) => lines.push(line) } });
    adapterMocks.getAdapter.mockReturnValue({ getStudentProfile: vi.fn(async () => { throw routeFailure; }) });
    const app = createApp(undefined);
    const token = await encryptSession(normalizedVnuSession(), SESSION_SECRET);

    const response = await app.handle(new Request("http://localhost/api/vnu/me", {
      headers: { Authorization: `Bearer ${token}` },
    }));
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const output = lines.join("\n");
    expect(output).toContain('"operation":"route"');
    expect(output).toContain('"msg":"VNU request failed"');
    expect(output).not.toContain('"reqId"');
    expect(output).not.toContain('"stack"');
    for (const sentinel of ["UPSTREAM_PROSE_SENTINEL", "TOKEN_SENTINEL", "GRANT_SENTINEL", "PRINCIPAL_SENTINEL", "USERNAME_SENTINEL", "STUDENT_CODE_SENTINEL", "PROFILE_SENTINEL", "COOKIE_SENTINEL"]) {
      expect(output).not.toContain(sentinel);
    }
    for (const line of lines) {
      const { level: _level, time: _time, pid: _pid, hostname: _hostname, ...stable } = JSON.parse(line) as Record<string, unknown>;
      expect(stable).toEqual(expect.objectContaining({ operation: "route", msg: "VNU request failed" }));
      expect(Object.keys(stable).sort()).toEqual(["code", "msg", "operation", "status"]);
    }
  });

  it("replaces an untrusted status-bearing error code at the VNU boundary", async () => {
    const privateCode = "PRIVATE_CODE_SENTINEL";
    const privateMessage = "PRIVATE_MESSAGE_SENTINEL";
    const routeFailure = Object.assign(new Error(privateMessage), { status: 422, code: privateCode, details: { privateId: "PRIVATE_ID_SENTINEL" } });
    const lines: string[] = [];
    configureLogger({ level: "warn", mode: "node", destination: { write: (line) => lines.push(line) } });
    adapterMocks.getAdapter.mockReturnValue({ getStudentProfile: vi.fn(async () => { throw routeFailure; }) });
    const app = createApp(undefined);
    const token = await encryptSession(normalizedVnuSession(), SESSION_SECRET);

    const response = await app.handle(new Request("http://localhost/api/vnu/me", { headers: { Authorization: `Bearer ${token}` } }));
    const responseText = await response.text();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const logText = lines.join("\n");

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({
      data: null,
      error: { code: "INTERNAL_ERROR", message: "Unexpected API error" },
    });
    for (const privateValue of [privateCode, privateMessage, "PRIVATE_ID_SENTINEL"]) {
      expect(responseText).not.toContain(privateValue);
      expect(logText).not.toContain(privateValue);
    }
    expect(JSON.parse(lines[0]!)).toMatchObject({ operation: "route", code: "INTERNAL_ERROR", status: 500, msg: "VNU request failed" });
  });
});

describe("lazy parent session refresh", () => {
  let logOutput: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    configureLogger({ level: "silent", mode: "node" });
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  let refreshControl: TestVnuImportRefreshControl;

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
    refreshControl = new TestVnuImportRefreshControl();
    setVnuRefreshControlCoordinator(refreshControl);
    profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml").mockResolvedValue(vnuProfileHtml());
    gradesSpy = undefined;
    app = createApp(undefined);
  });

  afterEach(() => {
    gradesSpy?.mockRestore();
    profileSpy.mockRestore();
    dateNowSpy.mockRestore();
    vi.unstubAllGlobals();
    setVnuRefreshControlCoordinator(undefined);
    configureLogger({ level: "silent", mode: "node" });
  });

  it("normalizes the username and activates a linked access/grant pair before returning artifacts", async () => {
    const response = await app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vnuUsername: "  SYNTHETIC-VNU-USER  ", vnuPassword: "SYNTHETIC-PASSWORD-BYTES" }),
    }));
    const body = await response.json() as { data: CoordinatorVnuImportResponse; error: null };

    expect(response.status).toBe(200);
    expect(adapterMocks.importSession).toHaveBeenCalledWith({
      vnuUsername: "synthetic-vnu-user",
      vnuPassword: "SYNTHETIC-PASSWORD-BYTES",
    });
    const access = await decryptSession(body.data.token, SESSION_SECRET);
    const grant = await decryptVnuRefreshGrant(body.data.refreshGrant!, SESSION_SECRET, syntheticTime);
    expect(grant).toMatchObject({
      username: "synthetic-vnu-user",
      password: "SYNTHETIC-PASSWORD-BYTES",
      expectedStudentCode: VNU_STUDENT_CODE,
    });
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt)).toBe(8 * 60 * 60 * 1000);
    expect(access.vnuRefresh).toMatchObject({ grantId: grant.grantId, grantExpiresAt: grant.expiresAt });
    expect(refreshControl.activations).toEqual([{
      principalKey: access.vnuRefresh!.principalKey,
      pair: {
        accessTokenId: access.vnuRefresh!.accessTokenId,
        accessExpiresAt: Date.parse(access.vnuRefresh!.accessExpiresAt),
        grantId: grant.grantId,
        grantExpiresAt: Date.parse(grant.expiresAt),
      },
    }]);
  });

  it.each([
    ["refresh", "/api/vnu/auth/refresh", {}],
    ["refresh extras", "/api/vnu/auth/refresh", { refreshGrant: "x", extra: true }],
    ["logout extras", "/api/vnu/auth/logout", { extra: true }],
  ])("rejects malformed strict %s bodies with no-store", async (_label, path, body) => {
    const imported = await importVnu(app);
    const response = await app.handle(new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.revocationAttempts).toEqual([]);
  });

  it("requires a JSON object logout body while accepting an explicit empty object", async () => {
    const imported = await importVnu(app);
    const missing = await requestVnuLogoutWithoutBody(app, imported.token);
    expect(missing.status).toBe(400);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.revocationAttempts).toEqual([]);

    const explicitEmpty = await requestVnuLogout(app, imported.token);
    expect(explicitEmpty.status).toBe(200);
    expect(explicitEmpty.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.revocationAttempts).toHaveLength(1);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it.each(["refresh", "logout"] as const)("bounds chunked %s bodies by actual bytes before grant authority or upstream", async (operation) => {
    const imported = await importVnu(app);
    const path = `/api/vnu/auth/${operation}`;
    const oversized = JSON.stringify({ refreshGrant: "X".repeat(VNU_AUTH_BODY_MAX_BYTES) });
    const response = await app.handle(chunkedJsonRequest(path, imported.token, [oversized.slice(0, 4_000), oversized.slice(4_000)]));
    const responseText = await response.text();
    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(responseText)).toEqual({ data: null, error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." } });
    expect(responseText).not.toContain("X".repeat(32));
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it.each(["refresh", "logout"] as const)("rejects unauthenticated %s before consuming its body stream", async (operation) => {
    let pulls = 0;
    const response = await app.handle(chunkedJsonRequest(`/api/vnu/auth/${operation}`, "tampered", [JSON.stringify({ refreshGrant: "PRIVATE_GRANT_SENTINEL" })], () => { pulls += 1; }));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(pulls).toBe(0);
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(0);
  });

  it("accepts a valid refresh body at the exact streaming byte ceiling", async () => {
    const imported = await importVnu(app);
    const json = JSON.stringify({ refreshGrant: imported.refreshGrant });
    const body = json + " ".repeat(VNU_AUTH_BODY_MAX_BYTES - new TextEncoder().encode(json).byteLength);
    const response = await app.handle(chunkedJsonRequest("/api/vnu/auth/refresh", imported.token, [body.slice(0, 4_096), body.slice(4_096)]));
    expect(new TextEncoder().encode(body)).toHaveLength(VNU_AUTH_BODY_MAX_BYTES);
    expect(response.status).toBe(200);
    expect(refreshControl.beginAttempts).toHaveLength(1);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
  });

  it("accepts the largest producer-issued grant through the shared field and body ceilings", async () => {
    const password = "P".repeat(largestAcceptedWorkerPasswordLength(syntheticTime));
    const importedResponse = await app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vnuUsername: "SYNTHETIC_VNU_USER", vnuPassword: password }),
    }));
    const importedBody = await importedResponse.json() as { data: CoordinatorVnuImportResponse; error: null };
    expect(importedResponse.status).toBe(200);
    expect(importedBody.data.refreshGrant.length).toBeLessThanOrEqual(VNU_REFRESH_GRANT_MAX_LENGTH);
    const json = JSON.stringify({ refreshGrant: importedBody.data.refreshGrant });
    const padded = json + " ".repeat(VNU_AUTH_BODY_MAX_BYTES - new TextEncoder().encode(json).byteLength);
    const refreshed = await app.handle(chunkedJsonRequest("/api/vnu/auth/refresh", importedBody.data.token, [padded]));
    expect(refreshed.status).toBe(200);
  });

  it("fails oversized producer credentials before authority activation or artifact return", async () => {
    const privatePassword = `PRIVATE_OVERSIZE_PASSWORD_${"X".repeat(7_000)}`;
    const response = await app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vnuUsername: "SYNTHETIC_VNU_USER", vnuPassword: privatePassword }),
    }));
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ data: null, error: { code: "VNU_REFRESH_GRANT_TOO_LARGE", message: "The VNU reconnect credentials are too large to store safely." } });
    expect(text).not.toContain("PRIVATE_OVERSIZE_PASSWORD");
    expect(refreshControl.activations).toEqual([]);
    expect(refreshControl.mutationCount).toBe(0);
    expect(text).not.toContain("token");
    expect(text).not.toContain("refreshGrant");
  });

  it("rejects a refresh grant field one character above the canonical maximum before authority", async () => {
    const imported = await importVnu(app);
    const response = await requestVnuRefresh(app, imported.token, "X".repeat(VNU_REFRESH_GRANT_MAX_LENGTH + 1));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
  });

  it("maps authenticated descriptorless legacy refresh to grant-invalid without authority or login", async () => {
    const token = await encryptSession(normalizedVnuSession(), SESSION_SECRET);
    const loginCount = adapterMocks.importSession.mock.calls.length;
    const response = await requestVnuRefresh(app, token, "not-a-grant");
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_GRANT_INVALID" } });
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.exactRevocationAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(loginCount);
  });

  it("logs out an authenticated expired descriptorless legacy token idempotently", async () => {
    const expired = normalizedVnuSession(new Date(syntheticTime - 1).toISOString());
    const token = await encryptSession(expired, SESSION_SECRET);
    const first = await requestVnuLogout(app, token);
    const second = await requestVnuLogout(app, token);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(second.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(cache.revocationUrls()).toHaveLength(0);
  });

  it("rejects invalid outward access artifacts before grant, authority, or upstream stages", async () => {
    const imported = await importVnu(app);
    const payload = await decryptSession(imported.token, SESSION_SECRET);
    const wrongPurpose = await encryptRawLegacySessionFixture({
      ...payload,
      vnuRefresh: { ...payload.vnuRefresh!, purpose: "other-purpose" },
    });
    const tampered = `${imported.token.slice(0, -1)}${imported.token.endsWith("A") ? "B" : "A"}`;
    const loginCount = adapterMocks.importSession.mock.calls.length;
    for (const token of ["malformed", tampered, imported.refreshGrant, wrongPurpose]) {
      const response = await requestVnuRefresh(app, token, imported.refreshGrant);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_SESSION" } });
    }
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.exactRevocationAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(loginCount);
  });

  it("never sends a malformed descriptor-bearing logout token through legacy fallback", async () => {
    const imported = await importVnu(app);
    const payload = await decryptSession(imported.token, SESSION_SECRET);
    const malformedDescriptor = await encryptRawLegacySessionFixture({
      ...payload,
      vnuRefresh: { ...payload.vnuRefresh!, grantId: "NOT_CANONICAL" },
    });
    const response = await requestVnuLogout(app, malformedDescriptor);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_SESSION" } });
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("refresh rotates both artifacts once and preserves the original grant lifetime", async () => {
    const imported = await importVnu(app);
    const before = await decryptVnuRefreshGrant(imported.refreshGrant, SESSION_SECRET, syntheticTime);
    const rotatedSession = { ...vnuSession(), vnu: { kind: "cookie" as const, value: "SYNTHETIC_ROTATED_COOKIE", expiresAt: vnuSession().expiresAt } };
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(rotatedSession));

    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    const body = await response.json() as { data: CoordinatorVnuImportResponse; error: null };
    const after = await decryptVnuRefreshGrant(body.data.refreshGrant, SESSION_SECRET, syntheticTime);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.data.token).not.toBe(imported.token);
    expect(body.data.refreshGrant).not.toBe(imported.refreshGrant);
    expect(after).toMatchObject({ issuedAt: before.issuedAt, expiresAt: before.expiresAt, username: before.username, password: before.password });
    expect(after.grantId).not.toBe(before.grantId);
    expect(refreshControl.beginAttempts).toHaveLength(1);
    expect(refreshControl.completionAttempts).toHaveLength(1);
    expect(refreshControl.abortAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
  });

  it("accepts expired outward access only on refresh while ordinary access remains expired", async () => {
    const expiresAt = new Date(syntheticTime - 1).toISOString();
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(vnuSession(expiresAt)));
    const imported = await importVnu(app);
    expect((await getVnuRawPage(app, imported.token)).status).toBe(401);
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
    expect((await requestVnuRefresh(app, imported.token, imported.refreshGrant)).status).toBe(200);
  });

  it("treats expired upstream cookie metadata independently from outward access expiry", async () => {
    const session = normalizedVnuSession();
    session.vnu = { ...session.vnu!, expiresAt: new Date(syntheticTime - 1).toISOString() };
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(session));
    const imported = await importVnu(app);
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("rejects malformed, expired, and wrong-purpose grants before authority or upstream login", async () => {
    const imported = await importVnu(app);
    const loginCount = adapterMocks.importSession.mock.calls.length;
    const expired = createVnuRefreshGrant({ username: "SYNTHETIC_VNU_USER", password: "SYNTHETIC_PASSWORD", expectedStudentCode: VNU_STUDENT_CODE, now: syntheticTime - 8 * 60 * 60 * 1000 - 1 });
    const expiredToken = await encryptVnuRefreshGrant(expired, SESSION_SECRET);
    for (const grant of ["not-a-grant", expiredToken, imported.token]) {
      const response = await requestVnuRefresh(app, imported.token, grant);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_GRANT_INVALID" } });
    }
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(loginCount);
  });

  it("rejects principal and grant linkage mismatches without authority mutation or upstream login", async () => {
    const imported = await importVnu(app);
    const grant = await decryptVnuRefreshGrant(imported.refreshGrant, SESSION_SECRET, syntheticTime);
    const wrongPrincipal = await encryptVnuRefreshGrant({ ...grant, username: "other_synthetic_user" }, SESSION_SECRET);
    const otherGrant = createVnuRefreshGrant({ username: grant.username, password: grant.password, expectedStudentCode: grant.expectedStudentCode, now: syntheticTime });
    const wrongLink = await encryptVnuRefreshGrant({ ...grant, grantId: otherGrant.grantId }, SESSION_SECRET);
    const loginCount = adapterMocks.importSession.mock.calls.length;
    for (const mismatched of [wrongPrincipal, wrongLink]) {
      const response = await requestVnuRefresh(app, imported.token, mismatched);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_IDENTITY_MISMATCH" } });
    }
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.exactRevocationAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(loginCount);
  });

  it("revokes only the linked pair when signed access identity mismatches the grant before lease", async () => {
    const imported = await importVnu(app);
    const payload = await decryptSession(imported.token, SESSION_SECRET);
    const mismatchedToken = await encryptSession({ ...payload, studentCode: "OTHER_SYNTHETIC_STUDENT" }, SESSION_SECRET);
    const response = await requestVnuRefresh(app, mismatchedToken, imported.refreshGrant);
    expect(response.status).toBe(409);
    expect(refreshControl.exactRevocationAttempts).toEqual([{ principalKey: payload.vnuRefresh!.principalKey, pair: descriptorPairFixture(payload) }]);
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: "revoked" } as BeginRefreshResult, 401, "VNU_REFRESH_GRANT_REVOKED", undefined],
    [{ kind: "in-progress", retryAfterSeconds: 7 } as BeginRefreshResult, 503, "VNU_REFRESH_UNAVAILABLE", { retryAfterSeconds: 7 }],
    [{ kind: "rate-limited", retryAfterSeconds: 8, limit: 5, windowSeconds: 900 } as BeginRefreshResult, 429, "VNU_REFRESH_RATE_LIMITED", { retryAfterSeconds: 8, limit: 5, windowSeconds: 900 }],
  ])("maps begin result $result.kind without upstream login", async (result, status, code, details) => {
    const imported = await importVnu(app);
    refreshControl.beginResult = result;
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code, ...(details ? { details } : {}) } });
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["INVALID_VNU_CREDENTIAL", 401, true],
    ["VNU_REFRESH_IDENTITY_MISMATCH", 409, true],
    ["VNU_RATE_LIMITED", 429, false],
    ["VNU_UPSTREAM_UNAVAILABLE", 502, false],
    ["VNU_REQUEST_FAILED", 502, false],
  ])("aborts leased refresh with terminal=%s for %s", async (code, status, terminal) => {
    const imported = await importVnu(app);
    adapterMocks.importSession.mockRejectedValueOnce(new HyeboardError(code, "PRIVATE_UPSTREAM_PROSE_SENTINEL", status));
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    const responseText = await response.clone().text();
    expect(response.status).toBe(status);
    expect(responseText).not.toContain("PRIVATE_UPSTREAM_PROSE_SENTINEL");
    expect(refreshControl.abortAttempts).toHaveLength(1);
    expect(refreshControl.abortAttempts[0].terminal).toBe(terminal);
  });

  it.each([
    ["network", () => new Error("PRIVATE_NETWORK_PROSE_SENTINEL")],
    ["adapter cancellation", () => new DOMException("PRIVATE_ABORT_PROSE_SENTINEL", "AbortError")],
  ])("retryably aborts and sanitizes a raw %s refresh transport failure before same-artifact retry", async (_label, makeFailure) => {
    const imported = await importVnu(app);
    const payload = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = payload.vnuRefresh!.principalKey;
    const oldPair = descriptorPairFixture(payload);
    const lines: string[] = [];
    configureLogger({ level: "warn", mode: "node", destination: { write: (line) => lines.push(line) } });
    adapterMocks.importSession.mockRejectedValueOnce(makeFailure());

    const failed = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    const failedText = await failed.text();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failed.status).toBe(502);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(failedText)).toEqual({ data: null, error: { code: "VNU_REQUEST_FAILED", message: "The VNU reconnect request failed. Try again." } });
    for (const privateValue of ["PRIVATE_NETWORK_PROSE_SENTINEL", "PRIVATE_ABORT_PROSE_SENTINEL"]) {
      expect(failedText).not.toContain(privateValue);
      expect(lines.join("\n")).not.toContain(privateValue);
    }
    expect(lines).toHaveLength(1);
    const { level: _level, time: _time, pid: _pid, hostname: _hostname, ...stableLog } = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(stableLog).toEqual({ operation: "route", code: "VNU_REQUEST_FAILED", status: 502, msg: "VNU request failed" });
    expect(refreshControl.abortAttempts).toEqual([{ principalKey, pair: oldPair, terminal: false }]);
    expect(refreshControl.activePairs.get(principalKey)).toEqual(oldPair);
    expect(refreshControl.leasedPrincipals.has(principalKey)).toBe(false);
    expect(refreshControl.completionAttempts).toEqual([]);
    expect(cache.revocationUrls()).toEqual([]);

    adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
    const retry = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("Cache-Control")).toBe("no-store");
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(3);
    expect(refreshControl.beginAttempts).toHaveLength(2);
    expect(refreshControl.abortAttempts).toHaveLength(1);
    expect(refreshControl.completionAttempts).toHaveLength(1);
  });

  it("terminally aborts the exact leased pair when live login returns another student", async () => {
    const imported = await importVnu(app);
    adapterMocks.importSession.mockResolvedValueOnce({
      ...importedVnu(),
      studentCode: "OTHER_SYNTHETIC_STUDENT",
    });
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_IDENTITY_MISMATCH" } });
    expect(refreshControl.abortAttempts).toHaveLength(1);
    expect(refreshControl.abortAttempts[0]).toMatchObject({ pair: refreshControl.beginAttempts[0].pair, terminal: true });
  });

  it("allows only one upstream login for concurrent refresh requests", async () => {
    const imported = await importVnu(app);
    const gate = enteredOperation<ReturnType<typeof importedVnu>>();
    adapterMocks.importSession.mockImplementationOnce(async () => {
      gate.markEntered();
      return gate.result;
    });
    const first = requestVnuRefresh(app, imported.token, imported.refreshGrant);
    await gate.entered;
    const second = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(second.status).toBe(503);
    await expect(second.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_UNAVAILABLE", details: { retryAfterSeconds: 120 } } });
    gate.release(importedVnu());
    expect((await first).status).toBe(200);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
  });

  it("logout first defeats a late refresh completion", async () => {
    const imported = await importVnu(app);
    const gate = enteredOperation<ReturnType<typeof importedVnu>>();
    adapterMocks.importSession.mockImplementationOnce(async () => {
      gate.markEntered();
      return gate.result;
    });
    const refreshing = requestVnuRefresh(app, imported.token, imported.refreshGrant);
    await gate.entered;
    const logout = await requestVnuLogout(app, imported.token);
    gate.release(importedVnu());
    const late = await refreshing;
    expect(logout.status).toBe(200);
    expect(logout.headers.get("Cache-Control")).toBe("no-store");
    expect(late.status).toBe(401);
    expect(late.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.completionAttempts).toHaveLength(1);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
  });

  it("lets refresh complete before an entered old-descriptor logout without revoking the next pair", async () => {
    const imported = await importVnu(app);
    const oldPayload = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = oldPayload.vnuRefresh!.principalKey;
    const oldPair = descriptorPairFixture(oldPayload);
    const gate = enteredOperation<void>();
    const authority = productionRefreshAuthorityHarness(activeAuthorityState(oldPair), principalKey, { markEntered: gate.markEntered, release: gate.result });
    setVnuRefreshControlCoordinator(authority.coordinator);
    const oldLogoutPromise = requestVnuLogout(app, imported.token);
    await gate.entered;

    adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
    const refreshed = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    const refreshedBody = await refreshed.json() as { data: CoordinatorVnuImportResponse; error: null };
    const nextPayload = await decryptSession(refreshedBody.data.token, SESSION_SECRET);
    const nextPair = descriptorPairFixture(nextPayload);
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("Cache-Control")).toBe("no-store");
    expect((authority.storage.stored as VnuRefreshControlState).active).toEqual(nextPair);
    expect(authority.calls).toEqual({ begin: 1, complete: 1, abort: 0, revokeLinked: 1 });
    authority.storage.resetCounts();

    gate.release();
    const oldLogout = await oldLogoutPromise;
    expect(oldLogout.status).toBe(200);
    expect(oldLogout.headers.get("Cache-Control")).toBe("no-store");
    expect(authority.storage.transactionCount).toBe(1);
    expect(authority.storage.putCount).toBe(0);
    expect(authority.storage.deleteCount).toBe(0);
    expect(authority.storage.alarmUpdateCount).toBe(0);
    expect((authority.storage.stored as VnuRefreshControlState).active).toEqual(nextPair);
    expect(cache.revocationUrls()).toEqual([]);
    expect(authority.calls).toEqual({ begin: 1, complete: 1, abort: 0, revokeLinked: 1 });
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);

    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>SYNTHETIC_NEXT_PAIR_ACTIVE</html>");
    expect((await getVnuRawPage(app, refreshedBody.data.token)).status).toBe(200);
    expect(gradesSpy).toHaveBeenCalledTimes(1);

    authority.storage.resetCounts();
    const newLogout = await requestVnuLogout(app, refreshedBody.data.token, refreshedBody.data.refreshGrant);
    expect(newLogout.status).toBe(200);
    expect(newLogout.headers.get("Cache-Control")).toBe("no-store");
    expect((authority.storage.stored as VnuRefreshControlState).active).toBeUndefined();
    expect(authority.storage.transactionCount).toBe(1);
    expect(authority.storage.putCount).toBe(1);
    expect(authority.storage.alarmUpdateCount).toBe(1);
    expect(authority.calls).toEqual({ begin: 1, complete: 1, abort: 0, revokeLinked: 2 });
    expect(cache.revocationUrls()).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
  });

  it("keeps committed rotation authoritative when completion delivery fails", async () => {
    const imported = await importVnu(app);
    const oldPayload = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = oldPayload.vnuRefresh!.principalKey;
    const unusedRevokeGate = enteredOperation<void>();
    unusedRevokeGate.release();
    const authority = productionRefreshAuthorityHarness(
      activeAuthorityState(descriptorPairFixture(oldPayload)),
      principalKey,
      { markEntered: unusedRevokeGate.markEntered, release: unusedRevokeGate.result },
      { throwAfterComplete: true },
    );
    setVnuRefreshControlCoordinator(authority.coordinator);
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
    const lost = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    const lostText = await lost.text();
    const state = authority.storage.stored as VnuRefreshControlState;
    expect(lost.status).toBe(503);
    expect(lost.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(lostText)).toMatchObject({ error: { code: "VNU_REFRESH_UNAVAILABLE" } });
    expect(lostText).not.toContain("SYNTHETIC_COMPLETION_DELIVERY_LOSS");
    expect(state.active).toBeDefined();
    expect(state.revokedAccess[oldPayload.vnuRefresh!.accessTokenId]).toBe(Date.parse(oldPayload.vnuRefresh!.accessExpiresAt));
    expect(state.revokedGrants[oldPayload.vnuRefresh!.grantId]).toBe(Date.parse(oldPayload.vnuRefresh!.grantExpiresAt));
    expect(authority.calls).toEqual({ begin: 1, complete: 1, abort: 1, revokeLinked: 0 });
    await expect(authority.coordinator.checkAccess(principalKey, state.active!)).resolves.toEqual({ kind: "active" });
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("settles an in-flight committed completion before late request cancellation", async () => {
    const imported = await importVnu(app);
    const oldPayload = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = oldPayload.vnuRefresh!.principalKey;
    const unusedRevokeGate = enteredOperation<void>();
    unusedRevokeGate.release();
    const completionGate = enteredOperation<void>();
    const authority = productionRefreshAuthorityHarness(
      activeAuthorityState(descriptorPairFixture(oldPayload)),
      principalKey,
      { markEntered: unusedRevokeGate.markEntered, release: unusedRevokeGate.result },
      { completeGate: { markEntered: completionGate.markEntered, release: completionGate.result } },
    );
    setVnuRefreshControlCoordinator(authority.coordinator);
    const controller = new AbortController();
    let refreshRequest!: Request;
    adapterMocks.importSession.mockImplementationOnce(async (input) => {
      expect(input.signal).toBe(refreshRequest.signal);
      return importedVnu();
    });
    refreshRequest = new Request("http://localhost/api/vnu/auth/refresh", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ refreshGrant: imported.refreshGrant }),
    });
    const refreshing = app.handle(refreshRequest);
    await completionGate.entered;
    controller.abort(new DOMException("SYNTHETIC_LATE_ABORT", "AbortError"));
    completionGate.release();
    const response = await refreshing;
    const body = await response.json() as { data: CoordinatorVnuImportResponse; error: null };
    expect(response.status).toBe(200);
    expect(authority.calls).toEqual({ begin: 1, complete: 1, abort: 0, revokeLinked: 0 });
    expect((authority.storage.stored as VnuRefreshControlState).active).toEqual(descriptorPairFixture(await decryptSession(body.data.token, SESSION_SECRET)));
    expect((await getVnuSession(app, body.data.token)).status).toBe(200);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("does not abort after complete authoritatively rejects a logged-out pair", async () => {
    const imported = await importVnu(app);
    const gate = enteredOperation<ReturnType<typeof importedVnu>>();
    adapterMocks.importSession.mockImplementationOnce(async () => {
      gate.markEntered();
      return gate.result;
    });
    const refreshing = requestVnuRefresh(app, imported.token, imported.refreshGrant);
    await gate.entered;
    expect((await requestVnuLogout(app, imported.token)).status).toBe(200);
    refreshControl.failureMode = "outage";
    refreshControl.failureOperation = "abort";
    gate.release(importedVnu());
    const response = await refreshing;
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_GRANT_REVOKED" } });
    expect(refreshControl.completionAttempts).toHaveLength(1);
    expect(refreshControl.abortAttempts).toEqual([]);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("cancellation before completion aborts retryably and leaves the grant usable", async () => {
    const imported = await importVnu(app);
    const oldPayload = await decryptSession(imported.token, SESSION_SECRET);
    const gate = enteredOperation<ReturnType<typeof importedVnu>>();
    let refreshRequest!: Request;
    adapterMocks.importSession.mockImplementationOnce(async (input) => {
      expect(input.signal).toBe(refreshRequest.signal);
      gate.markEntered();
      return gate.result;
    });
    const abort = new AbortController();
    refreshRequest = new Request("http://localhost/api/vnu/auth/refresh", {
      method: "POST",
      signal: abort.signal,
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ refreshGrant: imported.refreshGrant }),
    });
    const refreshing = app.handle(refreshRequest);
    await gate.entered;
    abort.abort();
    gate.release(importedVnu());
    const cancelled = await refreshing;
    expect(cancelled.status).toBe(503);
    await expect(cancelled.json()).resolves.toMatchObject({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE" } });
    expect(refreshControl.abortAttempts.at(-1)?.terminal).toBe(false);
    expect(refreshControl.completionAttempts).toEqual([]);
    expect(refreshControl.activePairs.get(oldPayload.vnuRefresh!.principalKey)).toEqual(descriptorPairFixture(oldPayload));
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
    expect((await requestVnuRefresh(app, imported.token, imported.refreshGrant)).status).toBe(200);
  });

  it("fails closed with sanitized no-store responses when refresh or logout authority is unavailable", async () => {
    const imported = await importVnu(app);
    refreshControl.failureMode = "outage";
    for (const response of [
      await requestVnuRefresh(app, imported.token, imported.refreshGrant),
      await requestVnuLogout(app, imported.token),
    ]) {
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(JSON.parse(text)).toMatchObject({ error: { code: "VNU_REFRESH_UNAVAILABLE" } });
      expect(text).not.toContain("SYNTHETIC_OUTAGE_SENTINEL");
    }
  });

  it.each(["begin", "complete"] as const)("fails closed for a separate %s coordinator outage", async (operation) => {
    const imported = await importVnu(app);
    const begin = vi.spyOn(refreshControl, "beginRefresh");
    const complete = vi.spyOn(refreshControl, "completeRefresh");
    const abort = vi.spyOn(refreshControl, "abortRefresh");
    refreshControl.failureMode = "outage";
    refreshControl.failureOperation = operation;
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_UNAVAILABLE" } });
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(operation === "begin" ? 1 : 2);
    expect(refreshControl.beginAttempts).toHaveLength(operation === "begin" ? 0 : 1);
    expect(refreshControl.completionAttempts).toHaveLength(0);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(operation === "complete" ? 1 : 0);
    expect(abort).toHaveBeenCalledTimes(operation === "complete" ? 1 : 0);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("fails closed when exact pre-lease revocation is unavailable", async () => {
    const imported = await importVnu(app);
    const payload = await decryptSession(imported.token, SESSION_SECRET);
    const mismatched = await encryptSession({ ...payload, studentCode: "OTHER_SYNTHETIC_STUDENT" }, SESSION_SECRET);
    refreshControl.failureMode = "outage";
    refreshControl.failureOperation = "revoke-exact";
    const revokeExact = vi.spyOn(refreshControl, "revokeExactLinkedPair");
    const response = await requestVnuRefresh(app, mismatched, imported.refreshGrant);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.exactRevocationAttempts).toHaveLength(0);
    expect(revokeExact).toHaveBeenCalledTimes(1);
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("fails closed when retryable abort is unavailable", async () => {
    const imported = await importVnu(app);
    refreshControl.failureMode = "outage";
    refreshControl.failureOperation = "abort";
    const abort = vi.spyOn(refreshControl, "abortRefresh");
    adapterMocks.importSession.mockRejectedValueOnce(new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", "PRIVATE_ABORT_PROSE", 502));
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_UNAVAILABLE" } });
    expect(refreshControl.beginAttempts).toHaveLength(1);
    expect(refreshControl.abortAttempts).toHaveLength(0);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("fails closed when linked logout revocation is unavailable", async () => {
    const imported = await importVnu(app);
    refreshControl.failureMode = "outage";
    refreshControl.failureOperation = "revoke-linked";
    const revoke = vi.spyOn(refreshControl, "revokeLinkedPairByAccess");
    const response = await requestVnuLogout(app, imported.token);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.revocationAttempts).toHaveLength(0);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("fails closed for descriptor-bearing refresh and logout when self-hosted authority is absent", async () => {
    const imported = await importVnu(app);
    setVnuRefreshControlCoordinator(undefined);
    const loginCount = adapterMocks.importSession.mock.calls.length;
    for (const response of [
      await requestVnuRefresh(app, imported.token, imported.refreshGrant),
      await requestVnuLogout(app, imported.token),
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_UNAVAILABLE" } });
    }
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(loginCount);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("allowlists route errors and logs only stable fields for unknown upstream failures", async () => {
    const imported = await importVnu(app);
    const lines: string[] = [];
    configureLogger({ level: "warn", mode: "node", destination: { write: (line) => lines.push(line) } });
    adapterMocks.importSession.mockRejectedValueOnce(new HyeboardError(
      "PRIVATE_UPSTREAM_CODE_SENTINEL",
      "PRIVATE_UPSTREAM_MESSAGE_SENTINEL",
      418,
      { reason: "PRIVATE_DETAIL_SENTINEL", privateId: "PRIVATE_ID_SENTINEL" },
    ));
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    const text = await response.text();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(text)).toEqual({ data: null, error: { code: "VNU_REQUEST_FAILED", message: "The VNU reconnect request failed. Try again." } });
    for (const privateValue of ["PRIVATE_UPSTREAM_CODE_SENTINEL", "PRIVATE_UPSTREAM_MESSAGE_SENTINEL", "PRIVATE_DETAIL_SENTINEL", "PRIVATE_ID_SENTINEL"]) {
      expect(text).not.toContain(privateValue);
      expect(lines.join("\n")).not.toContain(privateValue);
    }
    for (const line of lines) {
      const { level: _level, time: _time, pid: _pid, hostname: _hostname, ...stable } = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(stable).sort()).toEqual(["code", "msg", "operation", "status"]);
    }
  });

  it("validates optional logout grants before the sole authoritative mutation", async () => {
    const imported = await importVnu(app);
    const grant = await decryptVnuRefreshGrant(imported.refreshGrant, SESSION_SECRET, syntheticTime);
    const wrongPrincipal = await encryptVnuRefreshGrant({ ...grant, username: "other_synthetic_user" }, SESSION_SECRET);
    const wrongStudent = await encryptVnuRefreshGrant({ ...grant, expectedStudentCode: "OTHER_SYNTHETIC_STUDENT" }, SESSION_SECRET);
    const otherGrant = createVnuRefreshGrant({ username: grant.username, password: grant.password, expectedStudentCode: grant.expectedStudentCode, now: syntheticTime });
    const wrongId = await encryptVnuRefreshGrant({ ...grant, grantId: otherGrant.grantId }, SESSION_SECRET);
    const shiftedIssuedAt = new Date(Date.parse(grant.issuedAt) + 1_000).toISOString();
    const shiftedExpiresAt = new Date(Date.parse(grant.expiresAt) + 1_000).toISOString();
    const wrongExpiry = await encryptVnuRefreshGrant({ ...grant, issuedAt: shiftedIssuedAt, expiresAt: shiftedExpiresAt }, SESSION_SECRET);
    const malformed = await requestVnuLogout(app, imported.token, "not-a-grant");
    expect(malformed.status).toBe(401);
    for (const wrong of [wrongPrincipal, wrongStudent, wrongId, wrongExpiry]) {
      const mismatch = await requestVnuLogout(app, imported.token, wrong);
      expect(mismatch.status).toBe(409);
      expect(mismatch.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(refreshControl.exactRevocationAttempts).toEqual([]);
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.abortAttempts).toEqual([]);
    expect(refreshControl.completionAttempts).toEqual([]);
    expect(cache.revocationUrls()).toEqual([]);

    const success = await requestVnuLogout(app, imported.token, imported.refreshGrant);
    expect(success.status).toBe(200);
    expect(success.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.revocationAttempts).toHaveLength(1);
    expect(refreshControl.exactRevocationAttempts).toEqual([]);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it.each([
    ["expired", async (imported: CoordinatorVnuImportResponse) => {
      const grant = await decryptVnuRefreshGrant(imported.refreshGrant, SESSION_SECRET, syntheticTime);
      const expired = createVnuRefreshGrant({
        username: grant.username,
        password: grant.password,
        expectedStudentCode: grant.expectedStudentCode,
        now: syntheticTime - 8 * 60 * 60 * 1000 - 1,
      });
      return encryptVnuRefreshGrant(expired, SESSION_SECRET);
    }],
    ["wrong-purpose", async (imported: CoordinatorVnuImportResponse) => imported.token],
  ])("rejects a production-backed %s optional logout grant before every authority operation and write", async (_label, makeInvalidGrant) => {
    const imported = await importVnu(app);
    const payload = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = payload.vnuRefresh!.principalKey;
    const authority = productionAuthorityHarness(activeAuthorityState(descriptorPairFixture(payload)), { expectedPrincipal: principalKey });
    setVnuRefreshControlCoordinator(authority.coordinator);
    const coordinatorSpies = [
      vi.spyOn(authority.coordinator, "activatePair"),
      vi.spyOn(authority.coordinator, "checkAccess"),
      vi.spyOn(authority.coordinator, "beginRefresh"),
      vi.spyOn(authority.coordinator, "completeRefresh"),
      vi.spyOn(authority.coordinator, "abortRefresh"),
      vi.spyOn(authority.coordinator, "revokeLinkedPairByAccess"),
      vi.spyOn(authority.coordinator, "revokeExactLinkedPair"),
    ];

    const response = await requestVnuLogout(app, imported.token, await makeInvalidGrant(imported));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_GRANT_INVALID" } });
    for (const spy of coordinatorSpies) expect(spy).not.toHaveBeenCalled();
    expect(authority.objectNames).toEqual([]);
    expect(authority.storage.getCount).toBe(0);
    expect(authority.storage.transactionCount).toBe(0);
    expect(authority.storage.putCount).toBe(0);
    expect(authority.storage.deleteCount).toBe(0);
    expect(authority.storage.alarmUpdateCount).toBe(0);
    expect(cache.revocationUrls()).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
  });

  it("logs out from an expired authenticated descriptor without a tab grant", async () => {
    const expiresAt = new Date(syntheticTime - 1).toISOString();
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(vnuSession(expiresAt)));
    const imported = await importVnu(app);
    const payload = await decryptSessionForVnuLogout(imported.token, SESSION_SECRET);
    const response = await requestVnuLogout(app, imported.token);
    expect(response.status).toBe(200);
    expect(refreshControl.revocationAttempts).toEqual([{ principalKey: payload.vnuRefresh!.principalKey, pair: descriptorPairFixture(payload) }]);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("accepts a fully expired descriptor after lazy authority cleanup without mutation", async () => {
    const shortSession = vnuSession(new Date(syntheticTime + 1_000).toISOString());
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(shortSession));
    const imported = await importVnu(app);
    const payload = await decryptSessionForVnuLogout(imported.token, SESSION_SECRET);
    const principalKey = payload.vnuRefresh!.principalKey;
    refreshControl.activePairs.delete(principalKey);
    const mutationCount = refreshControl.mutationCount;
    syntheticTime = Date.parse(payload.vnuRefresh!.grantExpiresAt) + 1;
    const response = await requestVnuLogout(app, imported.token);
    expect(response.status).toBe(200);
    expect(refreshControl.revocationAttempts).toHaveLength(1);
    expect(refreshControl.mutationCount).toBe(mutationCount);
  });

  it.each(["expired", "mismatch"] as const)("rejects live-half authority %s instead of claiming idempotent logout", async (authorityResult) => {
    const expiresAt = new Date(syntheticTime - 1).toISOString();
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(vnuSession(expiresAt)));
    const imported = await importVnu(app);
    refreshControl.revokeResult = authorityResult;
    const response = await requestVnuLogout(app, imported.token);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_GRANT_REVOKED" } });
    expect(refreshControl.revocationAttempts).toHaveLength(1);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("uses submitted request-local credentials after a live verified cache hit", async () => {
    const first = await importVnu(app);
    const second = await importVnu(app);
    const secondGrant = await decryptVnuRefreshGrant(second.refreshGrant, SESSION_SECRET, syntheticTime);
    const firstAccess = await decryptSession(first.token, SESSION_SECRET);
    const secondAccess = await decryptSession(second.token, SESSION_SECRET);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(secondGrant).toMatchObject({
      username: "synthetic_vnu_user",
      password: "SYNTHETIC_VNU_PASSWORD",
      expectedStudentCode: VNU_STUDENT_CODE,
    });
    expect(refreshControl.activations).toHaveLength(2);
    expect(refreshControl.activePairs.get(secondAccess.vnuRefresh!.principalKey)).toEqual(descriptorPairFixture(secondAccess));
    expect(refreshControl.revokedPairs.get(firstAccess.vnuRefresh!.principalKey)).toContainEqual(descriptorPairFixture(firstAccess));

    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>SYNTHETIC_ACTIVE_GRADES</html>");
    const oldResponse = await getVnuRawPage(app, first.token);
    const newResponse = await getVnuRawPage(app, second.token);
    expect(oldResponse.status).toBe(401);
    expect(newResponse.status).toBe(200);
    expect(gradesSpy).toHaveBeenCalledTimes(1);
  });

  it("returns no access or grant artifact when pair activation fails", async () => {
    const active = await importVnu(app);
    const activePayload = await decryptSession(active.token, SESSION_SECRET);
    const activePair = descriptorPairFixture(activePayload);
    const revokedBefore = structuredClone(refreshControl.revokedPairs.get(activePayload.vnuRefresh!.principalKey) ?? []);
    const mutationCountBefore = refreshControl.mutationCount;
    refreshControl.failureMode = "outage";

    const response = await requestVnuImport(app);
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({
      data: null,
      error: {
        code: "VNU_REFRESH_UNAVAILABLE",
        message: "VNU reconnect is temporarily unavailable. Try again.",
        details: { retryAfterSeconds: 5 },
      },
    });
    expect(refreshControl.activePairs.get(activePayload.vnuRefresh!.principalKey)).toEqual(activePair);
    expect(refreshControl.revokedPairs.get(activePayload.vnuRefresh!.principalKey) ?? []).toEqual(revokedBefore);
    expect(refreshControl.mutationCount).toBe(mutationCountBefore);
    for (const privateValue of ["token", "refreshGrant", "session", "SYNTHETIC_VNU_COOKIE", "SYNTHETIC_VNU_USER", "SYNTHETIC_VNU_PASSWORD"]) {
      expect(text).not.toContain(privateValue);
    }
  });

  it("authoritatively revokes the current descriptor pair before successful logout", async () => {
    const imported = await importVnu(app);
    const access = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = access.vnuRefresh!.principalKey;
    const pair = descriptorPairFixture(access);

    const logout = await app.handle(new Request("http://localhost/api/vnu/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: "{}",
    }));

    expect(logout.status).toBe(200);
    await expect(logout.json()).resolves.toEqual({ data: { authenticated: false }, error: null });
    expect(refreshControl.activePairs.has(principalKey)).toBe(false);
    expect(refreshControl.revokedPairs.get(principalKey)).toContainEqual(pair);
    expect(cache.revocationUrls()).toHaveLength(0);

    const repeatedLogout = await app.handle(new Request("http://localhost/api/vnu/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(repeatedLogout.status).toBe(200);
    expect(refreshControl.revokedPairs.get(principalKey)).toEqual([pair]);

    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>UPSTREAM_SHOULD_NOT_RUN</html>");
    const rejected = await getVnuRawPage(app, imported.token);
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ data: null, error: { code: "SESSION_EXPIRED", message: "Session expired" } });
    expect(gradesSpy).not.toHaveBeenCalled();
  });

  it("fails logout atomically when authoritative pair revocation is unavailable", async () => {
    const imported = await importVnu(app);
    const access = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = access.vnuRefresh!.principalKey;
    const pair = descriptorPairFixture(access);
    const mutationCountBefore = refreshControl.mutationCount;
    refreshControl.failureMode = "outage";

    const logout = await app.handle(new Request("http://localhost/api/vnu/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: "{}",
    }));

    expect(logout.status).toBe(503);
    await expect(logout.json()).resolves.toEqual({
      data: null,
      error: {
        code: "VNU_REFRESH_UNAVAILABLE",
        message: "VNU reconnect is temporarily unavailable. Try again.",
        details: { retryAfterSeconds: 5 },
      },
    });
    expect(refreshControl.activePairs.get(principalKey)).toEqual(pair);
    expect(refreshControl.revokedPairs.get(principalKey) ?? []).not.toContainEqual(pair);
    expect(refreshControl.mutationCount).toBe(mutationCountBefore);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("fails a descriptor-pair mismatch before writing legacy token revocation", async () => {
    const imported = await importVnu(app);
    const access = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = access.vnuRefresh!.principalKey;
    const pair = descriptorPairFixture(access);
    refreshControl.activePairs.set(principalKey, { ...pair, grantId: `${"Z".repeat(21)}A` });

    const logout = await app.handle(new Request("http://localhost/api/vnu/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: "{}",
    }));

    expect(logout.status).toBe(401);
    await expect(logout.json()).resolves.toEqual({ data: null, error: { code: "VNU_REFRESH_GRANT_REVOKED", message: "The VNU reconnect grant has been revoked." } });
    expect(cache.revocationUrls()).toEqual([]);

    refreshControl.activePairs.set(principalKey, pair);
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>SYNTHETIC_ACTIVE_AFTER_MISMATCH</html>");
    const stillActive = await getVnuRawPage(app, imported.token);
    expect(stillActive.status).toBe(200);
    expect(gradesSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves legacy descriptorless VNU logout revocation without coordinator access", async () => {
    const legacySession = normalizedVnuSession();
    const legacyToken = await encryptSession(legacySession, SESSION_SECRET);

    const logout = await app.handle(new Request("http://localhost/api/vnu/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${legacyToken}`, "Content-Type": "application/json" },
      body: "{}",
    }));

    expect(logout.status).toBe(200);
    await expect(logout.json()).resolves.toEqual({ data: { authenticated: false }, error: null });
    expect(cache.revocationUrls()).toHaveLength(1);
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(refreshControl.checks).toEqual([]);

    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>LEGACY_UPSTREAM_SHOULD_NOT_RUN</html>");
    const rejected = await getVnuRawPage(app, legacyToken);
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ data: null, error: { code: "SESSION_EXPIRED", message: "Session expired" } });
    expect(gradesSpy).not.toHaveBeenCalled();
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(refreshControl.checks).toEqual([]);
  });

  it("preserves an access-only response when no coordinator is installed", async () => {
    setVnuRefreshControlCoordinator(undefined);

    const response = await requestVnuImport(app);
    const body = await response.json() as { data: AccessOnlyVnuImportResponse; error: null };

    expect(response.status).toBe(200);
    expect(Object.keys(body.data).sort()).toEqual(["session", "token"]);
    await expect(decryptSession(body.data.token, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());
  });

  it.each([
    ["missing internal student ID", `<select name="UnivID"><option value="77" selected>SYNTHETIC FACULTY</option></select>`],
    ["malformed internal university ID", `<input name="hidStdID" value="99000000001"><select name="UnivID"><option value="MALFORMED" selected>SYNTHETIC FACULTY</option></select>`],
  ])("returns profile incomplete for %s without exam upstream access", async (_label, profileHtml) => {
    const imported = await importVnu(app);
    profileSpy.mockResolvedValueOnce(profileHtml);
    const examSpy = vi.spyOn(DaotaoClient.prototype, "getExamsHtml");

    const response = await app.handle(new Request("http://localhost/api/vnu/raw/exams?vTermID=SYNTHETIC_TERM", {
      headers: { Authorization: `Bearer ${imported.token}` },
    }));
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({
      data: null,
      error: { code: "VNU_PROFILE_INCOMPLETE", message: "The university portal profile is incomplete." },
    });
    for (const privateValue of ["99000000001", "MALFORMED", "SYNTHETIC FACULTY", "77"]) expect(responseText).not.toContain(privateValue);
    expect(examSpy).not.toHaveBeenCalled();
    examSpy.mockRestore();
  });

  it("returns the exact profile-incomplete envelope for point detail without an own internal ID", async () => {
    const imported = await importVnu(app);
    profileSpy.mockResolvedValueOnce(`<input name="StdCode" value="PRIVATE_STUDENT_CODE_SENTINEL">`);
    const pointSpy = vi.spyOn(DaotaoClient.prototype, "getPointDetailHtml");

    const response = await app.handle(new Request("http://localhost/api/vnu/raw/point-detail?id=PRIVATE_CLASS_ID_SENTINEL&Term=1", {
      headers: { Authorization: `Bearer ${imported.token}` },
    }));
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({ data: null, error: { code: "VNU_PROFILE_INCOMPLETE", message: "The university portal profile is incomplete." } });
    for (const privateValue of ["PRIVATE_STUDENT_CODE_SENTINEL", "PRIVATE_CLASS_ID_SENTINEL"]) expect(responseText).not.toContain(privateValue);
    expect(pointSpy).not.toHaveBeenCalled();
    pointSpy.mockRestore();
  });

  it("returns the exact profile-incomplete envelope when verified import identity is missing", async () => {
    adapterMocks.importSession.mockResolvedValue({
      universityId: "vnu",
      studentCode: undefined,
      expiresAt: vnuSession().expiresAt,
      session: vnuSession(),
    });

    const response = await requestVnuImport(app);
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({
      data: null,
      error: { code: "VNU_PROFILE_INCOMPLETE", message: "The university portal profile is incomplete." },
    });
    for (const privateValue of [VNU_STUDENT_CODE, "SYNTHETIC_VNU_USER", "SYNTHETIC_VNU_PASSWORD", "SYNTHETIC_VNU_COOKIE"]) {
      expect(responseText).not.toContain(privateValue);
    }
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
    await expectIssuedVnuAccess(first.token, normalizedVnuSession(expiresAt));

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
    await expectIssuedVnuAccess(outward.token, normalizedVnuSession(expiresAt));
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
    await expect(decryptSession(cached.seed, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());

    const second = await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(second.session).toEqual(cached.session);
    const secondSession = await expectIssuedVnuAccess(second.token, normalizedVnuSession());
    expect(secondSession.vnuRefresh).not.toEqual(firstSession.vnuRefresh);
  });

  it("caches an opaque seed and returns a distinct valid token on a cache miss", async () => {
    const outward = await importVnu(app);
    const cached = await cache.importEntry();

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(cached.seed).toBeTypeOf("string");
    expect(cached.seed).not.toBe(outward.token);
    expect(cached.session).toEqual(outward.session);
    await expect(decryptSession(cached.seed, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());
    await expectIssuedVnuAccess(outward.token, normalizedVnuSession());
    expect(Object.keys(cached).sort()).toEqual(["seed", "session"]);
  });

  it("validates a cache hit live and returns a fresh equivalent token without mutating the cache", async () => {
    const probeBudget = new TestVnuProbeBudget();
    setVnuProbeBudgetCoordinator(probeBudget);
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
    expect(secondPayload).toMatchObject(normalizedVnuSession());
    expect(secondPayload.vnuRefresh).not.toEqual(firstPayload.vnuRefresh);
    expect(secondPayload.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect(await cache.store.get(cacheUrl)!.response.clone().text()).toBe(bytesBefore);
    expect(cache.store.get(cacheUrl)!.expiresAt).toBe(storedBefore.expiresAt);
    expect(probeBudget.count).toBe(0);
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
    await expectIssuedVnuAccess(first.token, normalizedVnuSession());
    const normalizedRepaired = { ...repairedSession, studentCode: VNU_STUDENT_CODE };
    await expectIssuedVnuAccess(repaired.token, normalizedRepaired);
    await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(normalizedRepaired);
    await expectIssuedVnuAccess(cachedRelogin.token, normalizedRepaired);
  });

  it("repairs a cache hit when the real profile client receives a standalone HTTP 200 expiry notice", async () => {
    const expiryNoticeSentinel = "CACHE_HIT_PROFILE_EXPIRY_SENTINEL";
    const expiryNotice = "Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.";
    const expiryNoticeHtml = `<html><body><table data-synthetic-marker="${expiryNoticeSentinel}"><tr><td>${expiryNotice}</td></tr></table></body></html>`;
    const repairedSession: EncryptedSessionPayload = {
      ...vnuSession(),
      vnu: { kind: "cookie", value: "REPAIRED_HTTP_BOUNDARY_COOKIE", expiresAt: "2099-01-01T00:00:00.000Z" },
    };
    await importVnu(app);
    const oldCached = await cache.importEntry();
    profileSpy.mockRestore();
    const upstreamFetch = vi.fn(async () => new Response(expiryNoticeHtml, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }));
    vi.stubGlobal("fetch", upstreamFetch);
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(repairedSession));

    const response = await requestVnuImport(app);
    const responseText = await response.text();
    const payload = JSON.parse(responseText) as { data: CoordinatorVnuImportResponse; error: null };
    const replacement = await cache.importEntry();

    expect(response.status).toBe(200);
    expect(payload.error).toBeNull();
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledWith(
      "https://daotao.vnu.edu.vn/StdInfo/TabStdSelf.asp",
      expect.objectContaining({ headers: expect.objectContaining({ Cookie: "SYNTHETIC_VNU_COOKIE" }) }),
    );
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(replacement.seed).not.toBe(oldCached.seed);
    const normalizedRepaired = { ...repairedSession, studentCode: VNU_STUDENT_CODE };
    await expectIssuedVnuAccess(payload.data.token, normalizedRepaired);
    await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(normalizedRepaired);
    expect(replacement.session).toEqual(payload.data.session);
    expect(responseText).not.toContain(expiryNoticeSentinel);
    expect(responseText).not.toContain(expiryNotice);
  });

  it("does not cache or expose a runtime VNU_SESSION_EXPIRED response", async () => {
    const expiryNoticeSentinel = "SYNTHETIC_EXPIRY_NOTICE_SENTINEL";
    const expiryNotice = "Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.";
    const expiryNoticeHtml = `<html><body><table data-synthetic-marker="${expiryNoticeSentinel}"><tr><td>${expiryNotice}</td></tr></table></body></html>`;
    let upstreamHtmlAtFetchBoundary: string | undefined;
    const upstreamFetch = vi.fn(async () => {
      upstreamHtmlAtFetchBoundary = expiryNoticeHtml;
      return new Response(upstreamHtmlAtFetchBoundary, { status: 200, headers: { "Content-Type": "text/html" } });
    });
    const outward = await importVnu(app);
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml");
    vi.stubGlobal("fetch", upstreamFetch);

    const response = await getVnuRawPage(app, outward.token);
    const responseText = await response.text();

    expect(response.status).toBe(401);
    expect(JSON.parse(responseText)).toMatchObject({
      data: null,
      error: { code: "VNU_SESSION_EXPIRED" },
    });
    expect(upstreamHtmlAtFetchBoundary).toContain(expiryNoticeSentinel);
    expect(upstreamHtmlAtFetchBoundary).toContain(expiryNotice);
    expect(responseText).not.toContain(expiryNoticeSentinel);
    expect(responseText).not.toContain(expiryNotice);
    expect(cache.rawUrls()).toEqual([]);
    expect(gradesSpy).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a legacy expiry page from the raw cache without an upstream call or notice leak", async () => {
    const expiryNoticeSentinel = "LEGACY_CACHED_EXPIRY_NOTICE_SENTINEL";
    const expiryNotice = "Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.";
    const token = await encryptSession(vnuSession(), SESSION_SECRET);
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html><body>NORMAL_CACHED_GRADES</body></html>");

    const seedResponse = await getVnuRawPage(app, token);
    const normalCacheHit = await getVnuRawPage(app, token);
    expect(seedResponse.status).toBe(200);
    expect(normalCacheHit.status).toBe(200);
    await expect(normalCacheHit.json()).resolves.toEqual({ data: { html: "<html><body>NORMAL_CACHED_GRADES</body></html>" }, error: null });
    expect(gradesSpy).toHaveBeenCalledTimes(1);

    cache.setOnlyRawEntry({
      html: `<html><body><table data-synthetic-marker="${expiryNoticeSentinel}"><tr><td>${expiryNotice}</td></tr></table></body></html>`,
    });
    gradesSpy.mockClear();

    const response = await getVnuRawPage(app, token);
    const responseText = await response.text();

    expect(response.status).toBe(401);
    expect(JSON.parse(responseText)).toMatchObject({ data: null, error: { code: "VNU_SESSION_EXPIRED" } });
    expect(responseText).not.toContain(expiryNoticeSentinel);
    expect(responseText).not.toContain(expiryNotice);
    expect(gradesSpy).not.toHaveBeenCalled();
  });

  it("rejects the replaced access pair before raw-cache or upstream access", async () => {
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
    expect(oldResponse.status).toBe(401);
    expect(repairedResponse.status).toBe(200);
    expect(rawUrls).toHaveLength(1);
    expect(gradesSpy).toHaveBeenCalledTimes(1);
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
    await expectIssuedVnuAccess(recovered.token, normalizedRepaired);
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
      headers: { Authorization: `Bearer ${oldLogin.token}`, "Content-Type": "application/json" },
      body: "{}",
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
    ["wrong token version", async () => encryptRawLegacySessionFixture({ ...normalizedVnuSession(), version: 2 })],
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
    await expectIssuedVnuAccess(recovered.token, normalizedVnuSession());
    const replacement = await cache.importEntry();
    expect(Object.keys(replacement).sort()).toEqual(["seed", "session"]);
    expect(replacement.session).toEqual(recovered.session);
    await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());

    const cachedRelogin = await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(cachedRelogin.token).not.toBe(recovered.token);
    expect(cachedRelogin.token).not.toBe(replacement.seed);
    expect(cachedRelogin.session).toEqual(recovered.session);
    await expectIssuedVnuAccess(cachedRelogin.token, normalizedVnuSession());
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
    await expectIssuedVnuAccess(cachedRelogin.token, normalizedVnuSession());
  });

  it("falls back to upstream login when the cache read fails", async () => {
    cache.failMatch = true;

    const outward = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    await expectIssuedVnuAccess(outward.token, normalizedVnuSession());
  });

  it("returns the normal response when the cache write fails", async () => {
    cache.failPut = true;

    const outward = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    await expectIssuedVnuAccess(outward.token, normalizedVnuSession());
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

  async function authorizedRequest(query: string, route = "transcript", sessionCookie = "SYNTHETIC_TRANSCRIPT_COOKIE", signal?: AbortSignal): Promise<Response> {
    const session = { ...vnuSession(), vnu: { ...vnuSession().vnu!, value: sessionCookie } };
    const token = await encryptSession(session, SESSION_SECRET);
    return app.handle(new Request(`http://localhost/api/vnu/cross-lookup/${route}?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
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
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(responseText)).toEqual({ data: null, error: { code: "VNU_PROFILE_INCOMPLETE", message: "The university portal profile is incomplete." } });
    for (const privateValue of ["not-a-number", "20000000"]) expect(responseText).not.toContain(privateValue);
    expect(probeBudget.count).toBe(0);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed own-profile identity for bulk without budget or Brc1 access", async () => {
    profileSpy.mockResolvedValue(`<input name="hidStdID" value="not-a-number"><input name="StdCode" value="20000000">`);

    const response = await bulkRequest({ mode: "stdid-to-code", targets: ["1002"], allowCrossLookup: true });
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({ data: null, error: { code: "VNU_PROFILE_INCOMPLETE", message: "The university portal profile is incomplete." } });
    for (const privateValue of ["not-a-number", "20000000"]) expect(responseText).not.toContain(privateValue);
    expect(probeBudget.count).toBe(0);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("returns profile incomplete when a required own student code is missing", async () => {
    profileSpy.mockResolvedValue(`<input name="hidStdID" value="1000">`);

    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id");
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({ data: null, error: { code: "VNU_PROFILE_INCOMPLETE", message: "The university portal profile is incomplete." } });
    for (const privateValue of ["1000", "20000001"]) expect(responseText).not.toContain(privateValue);
    expect(probeBudget.count).toBe(0);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("returns the exact profile-incomplete envelope when bulk mode requires a missing own student code", async () => {
    profileSpy.mockResolvedValue(`<input name="hidStdID" value="1000">`);

    const response = await bulkRequest({ mode: "code-to-stdid", targets: ["20000001"], allowCrossLookup: true });
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({ data: null, error: { code: "VNU_PROFILE_INCOMPLETE", message: "The university portal profile is incomplete." } });
    for (const privateValue of ["1000", "20000001"]) expect(responseText).not.toContain(privateValue);
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
    expect(probeBudget.reservedAmounts).toEqual([1]);
    expect(probeBudget.consumedAmounts).toEqual([]);
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

  it("cross-transcript by code reserves 34 and performs a separate final fetch", async () => {
    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true");
    const body = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.data).toMatchObject({ header: { studentCode: "20000001" }, terms: [{ maHK: "251" }] });
    expect(JSON.stringify(body)).not.toContain("<table>");
    expect(transcriptSpy).toHaveBeenCalledTimes(2);
    expect(transcriptSpy.mock.calls.map((call: unknown[]) => call[0])).toEqual(["1001", "00000001001"]);
    expect(probeBudget.reservedAmounts).toEqual([34]);
    expect(probeBudget.consumedAmounts).toEqual([]);
  });

  it("rejects a 34-unit transcript reservation before resolver or final fetch", async () => {
    probeBudget.limit = 33;

    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true");

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_RATE_LIMITED" } });
    expect(transcriptSpy).not.toHaveBeenCalled();
    expect(probeBudget.reservedAmounts).toEqual([34]);
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
    expect(probeBudget.count).toBe(34);
    expect(probeBudget.reservedAmounts).toEqual([1, 33]);
    expect(probeBudget.consumedAmounts).toEqual([]);
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

  it("student-id reserves exact 33 before Brc1 and limit 32 starts no upstream work", async () => {
    probeBudget.limit = 32;

    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id");

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(probeBudget.reservedAmounts).toEqual([33]);
    expect(probeBudget.consumedAmounts).toEqual([]);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("direct abortable Request passes exact cancellation reason and settles started work", async () => {
    const controller = new AbortController();
    const reason = new DOMException("synthetic direct cancellation", "AbortError");
    const observedReasons: unknown[] = [];
    let settled = false;
    transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => {
      try {
        return await new Promise<string>((_resolve, reject) => signal?.addEventListener("abort", () => {
          observedReasons.push(signal.reason);
          reject(signal.reason);
        }, { once: true }));
      } finally {
        settled = true;
      }
    });

    const responsePromise = authorizedRequest("stdId=1001&allowCrossLookup=true", "student-code", undefined, controller.signal);
    await vi.waitFor(() => expect(transcriptSpy).toHaveBeenCalledOnce());
    controller.abort(reason);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(observedReasons).toEqual([reason]);
    expect(settled).toBe(true);
  });

  it("resolver route cancelled at configured concurrency 4 aborts and settles every started candidate", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CODE_LOOKUP_CONCURRENCY: "4" });
    const controller = new AbortController();
    const reason = { cancelled: "resolver request" };
    const candidateSignals: AbortSignal[] = [];
    let settledCandidates = 0;
    transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => {
      if (transcriptSpy.mock.calls.length === 1) return "<html>headerless</html>";
      candidateSignals.push(signal!);
      try {
        return await new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      } finally {
        settledCandidates += 1;
      }
    });

    const responsePromise = authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id", undefined, controller.signal);
    await vi.waitFor(() => expect(candidateSignals).toHaveLength(4));
    controller.abort(reason);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(candidateSignals.every((signal) => signal.aborted && signal.reason === reason)).toBe(true);
    expect(settledCandidates).toBe(4);
  });

  it("fatal concurrent candidate aborts siblings and propagates exact 429 with no-store", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CODE_LOOKUP_CONCURRENCY: "4" });
    const fatal = new HyeboardError("VNU_RATE_LIMITED", "synthetic candidate limit", 429);
    const siblingSignals: AbortSignal[] = [];
    let settledSiblings = 0;
    transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => {
      if (transcriptSpy.mock.calls.length === 1) return "<html>headerless</html>";
      if (transcriptSpy.mock.calls.length === 2) throw fatal;
      siblingSignals.push(signal!);
      try {
        return await new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      } finally {
        settledSiblings += 1;
      }
    });

    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id");

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_RATE_LIMITED" } });
    expect(siblingSignals).toHaveLength(3);
    expect(siblingSignals.every((signal) => signal.aborted && signal.reason === fatal)).toBe(true);
    expect(settledSiblings).toBe(3);
  });

  it("candidate session expiry aborts siblings and propagates 401 instead of not-converged", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CODE_LOOKUP_CONCURRENCY: "4" });
    const fatal = new HyeboardError("VNU_SESSION_EXPIRED", "synthetic candidate expiry", 401);
    const siblingSignals: AbortSignal[] = [];
    transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => {
      if (transcriptSpy.mock.calls.length === 1) return "<html>headerless</html>";
      if (transcriptSpy.mock.calls.length === 2) throw fatal;
      siblingSignals.push(signal!);
      return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });

    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id");

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_SESSION_EXPIRED" } });
    expect(siblingSignals).toHaveLength(3);
    expect(siblingSignals.every((signal) => signal.aborted && signal.reason === fatal)).toBe(true);
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
      expect(noProfile.status).toBe(500);
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

    it("propagates terminal transcript expiry for the whole chunk and stops later targets", async () => {
      transcriptSpy
        .mockRejectedValueOnce(new HyeboardError("VNU_SESSION_EXPIRED", "Synthetic upstream session expired", 401))
        .mockResolvedValueOnce(targetTranscriptHtml);

      const response = await bulkRequest({ mode: "stdid-to-transcript", targets: ["1001", "1002"], allowCrossLookup: true });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        data: null,
        error: { code: "VNU_SESSION_EXPIRED" },
      });
      expect(transcriptSpy).toHaveBeenCalledTimes(1);
      expect(transcriptSpy).toHaveBeenCalledWith("1001", expect.any(AbortSignal));
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
      expect(probeBudget.reservedAmounts).toEqual([66]);
      expect(probeBudget.consumedAmounts).toEqual([]);
      expect(transcriptSpy).toHaveBeenCalledTimes(2);
    });

    it("rejects the whole chunk reservation before any Brc1 request", async () => {
      probeBudget.limit = 4;
      const response = await bulkRequest({ mode: "stdid-to-transcript", targets: ["1001", "1002", "1003", "1004", "1005"], allowCrossLookup: true });

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_RATE_LIMITED" } });
      expect(transcriptSpy).not.toHaveBeenCalled();
    });

    it("five direct targets reserve 5 atomically", async () => {
      const response = await bulkRequest({ mode: "stdid-to-code", targets: ["1001", "1002", "1003", "1004", "1005"], allowCrossLookup: true });

      expect(response.status).toBe(200);
      expect(probeBudget.reservedAmounts).toEqual([5]);
      expect(probeBudget.consumedAmounts).toEqual([]);
    });

    it("ordinary bulk systemic failure aborts chunk and starts no later item", async () => {
      const fatal = new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", "synthetic outage", 503);
      transcriptSpy.mockImplementation(async (stdId: string) => {
        if (stdId === "1002") throw fatal;
        return targetTranscriptHtml;
      });

      const response = await bulkRequest({ mode: "stdid-to-code", targets: ["1001", "1002", "1003"], allowCrossLookup: true });

      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(transcriptSpy.mock.calls.map((call: unknown[]) => call[0])).toEqual(["1001", "1002"]);
    });

    it("bulk targets stay sequential while each resolver overlaps configured candidate probes", async () => {
      setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CODE_LOOKUP_CONCURRENCY: "4" });
      profileSpy.mockResolvedValue(`<input name="hidStdID" value="${SYNTHETIC_VNU_STD_ID}"><input name="StdCode" value="${SYNTHETIC_VNU_CODE}">`);
      const targetCodes = [SYNTHETIC_VNU_CODE + 100, SYNTHETIC_VNU_CODE + 200];
      const projectedIds = targetCodes.map((code) => SYNTHETIC_VNU_STD_ID + code - SYNTHETIC_VNU_CODE);
      let activeCandidates = 0;
      const activeCandidatesByTarget = [0, 0];
      let maxActiveCandidates = 0;
      let secondStartedBeforeFirstSettled = false;
      transcriptSpy.mockImplementation(async (stdIdText: string, signal?: AbortSignal) => {
        const stdId = Number(stdIdText);
        const targetIndex = Math.abs(stdId - projectedIds[0]) <= 16 ? 0 : 1;
        if (targetIndex === 1 && activeCandidatesByTarget[0] > 0) secondStartedBeforeFirstSettled = true;
        if (stdId === projectedIds[targetIndex]) return "<html>headerless</html>";
        activeCandidates += 1;
        activeCandidatesByTarget[targetIndex] += 1;
        maxActiveCandidates = Math.max(maxActiveCandidates, activeCandidates);
        try {
          if (stdId === projectedIds[targetIndex] - 1) {
            await Promise.resolve();
            return `<table><tr><td>Mã số: ${targetCodes[targetIndex]}</td></tr></table>`;
          }
          return await new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
        } finally {
          activeCandidates -= 1;
          activeCandidatesByTarget[targetIndex] -= 1;
        }
      });

      const response = await bulkRequest({ mode: "code-to-stdid", targets: targetCodes.map(String), allowCrossLookup: true });
      const payload = await response.json() as { data: { items: Array<{ target: string; status: string }> } };

      expect(response.status).toBe(200);
      expect(payload.data.items.map(({ target, status }) => ({ target, status }))).toEqual(targetCodes.map((target) => ({ target: String(target), status: "ok" })));
      expect(probeBudget.reservedAmounts).toEqual([66]);
      expect(maxActiveCandidates).toBe(4);
      expect(secondStartedBeforeFirstSettled).toBe(false);
    });

    it("per-item nonconverged remains isolated and ordered", async () => {
      profileSpy.mockResolvedValue(`<input name="hidStdID" value="${SYNTHETIC_VNU_STD_ID}"><input name="StdCode" value="${SYNTHETIC_VNU_CODE}">`);
      const missingCode = SYNTHETIC_VNU_CODE + 100;
      const foundCode = SYNTHETIC_VNU_CODE + 200;
      const foundStdId = SYNTHETIC_VNU_STD_ID + 200;
      transcriptSpy.mockImplementation(async (stdIdText: string) => Number(stdIdText) === foundStdId
        ? `<table><tr><td>Mã số: ${foundCode}</td></tr></table>`
        : "<html>headerless</html>");

      const response = await bulkRequest({ mode: "code-to-stdid", targets: [String(missingCode), String(foundCode)], allowCrossLookup: true });
      const payload = await response.json() as { data: { items: Array<Record<string, unknown>> } };

      expect(response.status).toBe(200);
      expect(payload.data.items).toMatchObject([
        { target: String(missingCode), status: "error", errorCode: "VNU_CROSS_LOOKUP_NOT_CONVERGED" },
        { target: String(foundCode), status: "ok", result: { stdId: String(foundStdId) } },
      ]);
    });

    it("aborted bulk request starts no later item", async () => {
      const controller = new AbortController();
      const reason = { cancelled: "bulk" };
      transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
      const token = await encryptSession(vnuSession(), SESSION_SECRET);
      const responsePromise = app.handle(new Request("http://localhost/api/vnu/cross-lookup/bulk", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "stdid-to-code", targets: ["1001", "1002", "1003"], allowCrossLookup: true }),
        signal: controller.signal,
      }));
      await vi.waitFor(() => expect(transcriptSpy).toHaveBeenCalledOnce());
      controller.abort(reason);

      const response = await responsePromise;
      expect(response.status).toBe(500);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(transcriptSpy).toHaveBeenCalledOnce();
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

  it("normalizes self-hosted VNU file values and gives environment values precedence", () => {
    const fileConfig: RuntimeConfig = {
      VNU_CODE_LOOKUP_CONCURRENCY: "16",
      VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: "75",
    };

    expect(selfHostedRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      VNU_CODE_LOOKUP_CONCURRENCY: "32",
    }, fileConfig)).toMatchObject({
      VNU_CODE_LOOKUP_CONCURRENCY: "32",
      VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: "75",
    });
  });

});
