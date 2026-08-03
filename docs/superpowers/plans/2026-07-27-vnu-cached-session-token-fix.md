# VNU Cached Session Token Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mint a fresh Hyeboard bearer token for every successful VNU credential import, including cache hits, without extending the cached VNU session's original expiry.

**Architecture:** Keep the credential-derived HMAC cache key and best-effort Cache API abstraction unchanged. Store an encrypted Hyeboard session token only as an opaque cache seed alongside existing non-sensitive response metadata; on a cache hit, decrypt and validate the seed, then re-encrypt the unchanged `EncryptedSessionPayload` with a fresh AES-GCM IV before responding. Any absent, expired, malformed, undecryptable, wrong-version, non-VNU, or metadata-inconsistent entry becomes a cache miss; cache read/write failures remain fail-open.

**Tech Stack:** TypeScript 6, Elysia 1.4, Web Crypto AES-GCM through `@hyeboard/core`, Cloudflare Cache API-compatible storage, Vitest 4, pnpm 11, Playwright 1.61, Wrangler 4

---

## Scope and file map

- Modify `apps/worker/src/app.test.ts`: add synthetic VNU cache, token-identity, expiry, revocation, corruption, and fail-open regression coverage.
- Modify `apps/worker/src/app.ts:688-698`: replace outward-token replay with opaque-seed cache reads, validation, fresh encryption, and independent seed/outward encryption on misses.
- Reference only `packages/core/src/index.ts:27-63,131-154`: use the existing signatures unchanged:

  ```ts
  export async function encryptSession(payload: EncryptedSessionPayload, secret: string): Promise<string>
  export async function decryptSession(token: string, secret: string): Promise<EncryptedSessionPayload>
  ```

  `encryptSession` already generates a random 12-byte AES-GCM IV. `decryptSession` already rejects malformed tokens, wrong versions, authentication failures, and expired payloads. No core change is needed.
- Do not modify frontend files, API schemas, routes, response shape, cache-key derivation, raw-page caching, revocation storage, package scripts, or dependencies.
- Use synthetic test strings only. Do not inspect HAR files, `cred.txt`, real credentials, real cookies, bearer tokens, or personal data.

## Required invariants

1. Every successful VNU import response retains `{ data: { token, session }, error: null }`.
2. A cached value has `{ seed, session }`; it never exposes an outward `token` property.
3. Cache miss creates two independently encrypted tokens from the same payload: cached `seed` and returned `token`.
4. Cache hit returns neither the seed nor a prior outward token.
5. Re-encryption preserves the entire decrypted payload, especially `expiresAt`.
6. A usable hit must decrypt to `universityId === "vnu"`, contain a non-empty `vnu.value`, and have metadata equal to the decrypted payload's university, student code, and expiry.
7. Any cache read, parsing, decryption, validation, expiry, or write failure cannot prevent normal upstream login.
8. Logout continues revoking only the exact outward token supplied by that client.

### Task 1: Add focused VNU import-cache regression tests

**Files:**
- Modify: `apps/worker/src/app.test.ts:1-232`
- Test: `apps/worker/src/app.test.ts`

- [ ] **Step 1: Add cache and request test helpers**

Add these types and helpers after `parentSession()` at line 39. They give each test an isolated Cache API-compatible store, expose only synthetic cache content, and preserve the production request/response shape.

```ts
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
  readonly store = new Map<string, Response>();
  failMatch = false;
  failPut = false;

  async match(request: Request): Promise<Response | undefined> {
    if (this.failMatch) throw new Error("synthetic cache read failure");
    return this.store.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    if (this.failPut) throw new Error("synthetic cache write failure");
    this.store.set(request.url, response.clone());
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
    return await this.store.get(this.importUrl())!.clone().json() as {
      seed: string;
      session: VnuImportResponse["session"];
    };
  }

  setImportEntry(value: unknown): void {
    this.store.set(this.importUrl(), new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
    }));
  }
}

function vnuSession(expiresAt = "2099-01-01T00:00:00.000Z"): EncryptedSessionPayload {
  return {
    version: 1,
    universityId: "vnu",
    studentCode: "SYNTHETIC-STUDENT-001",
    vnu: { kind: "cookie", value: "SYNTHETIC_VNU_COOKIE", expiresAt },
    expiresAt,
  };
}

function importedVnu(session = vnuSession()) {
  return {
    universityId: session.universityId,
    studentCode: session.studentCode,
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
```

- [ ] **Step 2: Add the cache miss and cache hit tests**

Append this suite after the existing tests. The miss assertion proves cached seed/outward token separation. The hit assertion proves no second upstream import, fresh token identity, payload equivalence, and unchanged expiry.

```ts
describe("VNU import session cache", () => {
  let cache: TestCache;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    cache = new TestCache();
    vi.stubGlobal("caches", { default: cache });
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    adapterMocks.importSession.mockResolvedValue(importedVnu());
    app = createApp(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caches an opaque seed and returns a distinct valid token on a cache miss", async () => {
    const outward = await importVnu(app);
    const cached = await cache.importEntry();

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(cached.seed).toBeTypeOf("string");
    expect(cached.seed).not.toBe(outward.token);
    expect(cached.session).toEqual(outward.session);
    await expect(decryptSession(cached.seed, SESSION_SECRET)).resolves.toEqual(vnuSession());
    await expect(decryptSession(outward.token, SESSION_SECRET)).resolves.toEqual(vnuSession());
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
```

- [ ] **Step 3: Add exact-token revocation and device-isolation tests**

Continue inside the same `describe` block:

```ts
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
```

- [ ] **Step 4: Add corrupt, expired, and inconsistent-entry fallback tests**

Continue inside the same suite. Each case warms the cache only to capture its HMAC-derived URL, replaces the entry with synthetic invalid content, then verifies exactly one normal upstream import after mocks are cleared.

```ts
  it.each([
    ["malformed seed", async () => "not-an-encrypted-session"],
    ["wrong token version", async () => encryptSession({ ...vnuSession(), version: 2 } as unknown as EncryptedSessionPayload, SESSION_SECRET)],
    ["failed authentication tag", async () => encryptSession(vnuSession(), "different-synthetic-secret-32-bytes")],
    ["expired seed", async () => encryptSession(vnuSession("2000-01-01T00:00:00.000Z"), SESSION_SECRET)],
    ["non-VNU seed", async () => encryptSession({ ...vnuSession(), universityId: "uet", vnu: undefined }, SESSION_SECRET)],
  ])("treats a %s as a cache miss", async (_label, makeSeed) => {
    await importVnu(app);
    const previous = await cache.importEntry();
    cache.setImportEntry({ ...previous, seed: await makeSeed() });
    vi.clearAllMocks();
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    adapterMocks.importSession.mockResolvedValue(importedVnu());

    const recovered = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    await expect(decryptSession(recovered.token, SESSION_SECRET)).resolves.toEqual(vnuSession());
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

    await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 5: Add Cache API fail-open tests and close the suite**

Continue with the read/write failure cases, then close the `describe` block:

```ts
  it("falls back to upstream login when the cache read fails", async () => {
    cache.failMatch = true;

    const outward = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    await expect(decryptSession(outward.token, SESSION_SECRET)).resolves.toEqual(vnuSession());
  });

  it("returns the normal response when the cache write fails", async () => {
    cache.failPut = true;

    const outward = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    await expect(decryptSession(outward.token, SESSION_SECRET)).resolves.toEqual(vnuSession());
    expect(cache.store.size).toBe(0);
  });
});
```

- [ ] **Step 6: Run the focused tests and confirm the regression is red**

Run from repository root:

```bash
pnpm --filter @hyeboard/worker exec vitest run src/app.test.ts
```

Expected: FAIL in the new VNU suite. Current production code caches `{ token, session }`, so `cached.seed` is absent; current cache hits also replay the same outward token. Existing parent-refresh and CAPTCHA tests remain passing.

### Task 2: Store an opaque seed and mint fresh outward tokens

**Files:**
- Modify: `apps/worker/src/app.ts:688-698`
- Test: `apps/worker/src/app.test.ts`

- [ ] **Step 1: Define the private cache-entry and response types**

Add these aliases immediately above `vnuImportCacheKey()` at line 454. Keep them private to the worker; public API schemas do not change.

```ts
type AuthenticatedSessionMetadata = {
  universityId: string;
  studentCode?: string;
  expiresAt: string;
  authenticated: true;
};

type VnuImportCacheEntry = {
  seed: string;
  session: AuthenticatedSessionMetadata;
};

type VnuImportResponse = {
  token: string;
  session: AuthenticatedSessionMetadata;
};
```

- [ ] **Step 2: Add cache-hit decoding, validation, and re-encryption**

Add this helper immediately after `vnuImportCacheKey()`. All property reads occur inside `try`, so malformed JSON shapes and decryption failures are indistinguishable from ordinary cache misses. The helper never checks revocation for the seed because the seed is never an outward bearer token.

```ts
async function freshVnuImportFromCache(cacheKey: string): Promise<VnuImportResponse | undefined> {
  const cached = await cacheGet<VnuImportCacheEntry>(cacheKey);
  if (!cached) return undefined;

  try {
    const session = await decryptSession(cached.seed, getSessionSecret());
    if (
      session.universityId !== "vnu"
      || !session.vnu?.value
      || cached.session.authenticated !== true
      || cached.session.universityId !== session.universityId
      || cached.session.studentCode !== session.studentCode
      || cached.session.expiresAt !== session.expiresAt
    ) return undefined;

    return {
      token: await encryptSession(session, getSessionSecret()),
      session: cached.session,
    };
  } catch {
    return undefined;
  }
}
```

`decryptSession(cached.seed, secret)` preserves the original payload object and rejects expiry before encryption. `encryptSession(session, secret)` changes only token identity through a fresh random IV; it does not mutate or extend `session.expiresAt`.

- [ ] **Step 3: Replace the VNU import branch**

Replace `apps/worker/src/app.ts:688-698` with this code:

```ts
      if (params.universityId === "vnu" && body.vnuUsername && body.vnuPassword) {
        const cacheKey = await vnuImportCacheKey(body.vnuUsername, body.vnuPassword);
        const cached = await freshVnuImportFromCache(cacheKey);
        if (cached) return ok(cached);

        const imported = await adapterInstance.importSession(body);
        const session: AuthenticatedSessionMetadata = {
          universityId: imported.universityId,
          studentCode: imported.studentCode,
          expiresAt: imported.expiresAt,
          authenticated: true,
        };
        const seed = await encryptSession(imported.session, getSessionSecret());
        const token = await encryptSession(imported.session, getSessionSecret());
        await cachePut(
          cacheKey,
          { seed, session } satisfies VnuImportCacheEntry,
          Math.floor((Date.parse(imported.session.expiresAt) - Date.now()) / 1000),
        );
        return ok({ token, session } satisfies VnuImportResponse);
      }
```

This keeps the HMAC key unchanged. The two calls to `encryptSession` guarantee independent IV generation. `cachePut` already skips non-positive TTLs and catches Cache API failures. TTL derives from `imported.session.expiresAt`, the encrypted payload's authoritative original expiry.

- [ ] **Step 4: Run focused worker tests and type checks**

Run:

```bash
pnpm --filter @hyeboard/worker exec vitest run src/app.test.ts
pnpm --filter @hyeboard/worker test
```

Expected:

- First command: all `apps/worker/src/app.test.ts` tests PASS.
- Second command: both worker TypeScript configurations pass; normal Vitest and Workers-pool suites pass with zero failures.
- VNU tests explicitly prove miss/hit token inequality, decrypted-payload equality, unchanged expiry, exact-token revocation, device isolation, corrupt/expired fallback, fail-open cache behavior, and unchanged JSON shape.

- [ ] **Step 5: Review the implementation diff before recording the change**

Inspect only these intended paths:

```bash
git diff -- apps/worker/src/app.ts apps/worker/src/app.test.ts
git status --short -- apps/worker/src/app.ts apps/worker/src/app.test.ts
```

Expected: only the VNU cache implementation and focused worker tests appear. No frontend, core, package, HAR, credential, environment, or generated artifact changes appear.

- [ ] **Step 6: Commit only the two implementation paths**

If the execution workflow requires a checkpoint commit, stage exact paths only:

```bash
git add apps/worker/src/app.ts apps/worker/src/app.test.ts
git commit -m "fix(worker): mint fresh tokens for cached VNU sessions"
```

Never use `git add .`, `git add -A`, broad directory staging, amend, force-push, or history rewriting. Leave unrelated workspace changes unstaged. This plan-authoring task itself does not stage, commit, or push anything.

### Task 3: Run repository-wide release verification

**Files:**
- Verify: `apps/worker/src/app.ts`
- Verify: `apps/worker/src/app.test.ts`
- No source changes expected

- [ ] **Step 1: Re-run focused worker verification**

```bash
pnpm --filter @hyeboard/worker test
```

Expected: worker TypeScript checks, Node-runtime Vitest tests, and Workers-pool tests all exit 0 with no failures.

- [ ] **Step 2: Build every target**

```bash
pnpm build
```

Expected: web typecheck/Vite build, worker Cloudflare and Node typechecks, and Node package build all exit 0. No frontend source change is required.

- [ ] **Step 3: Run all monorepo tests**

```bash
pnpm test
```

Expected: recursive package typechecks and tests exit 0 with no failures.

- [ ] **Step 4: Run browser regression coverage**

```bash
pnpm --filter @hyeboard/web exec playwright test
```

Expected: all Chromium and mobile-Safari Playwright tests pass. Login gate, demo login, navigation, theming, search, notifications, grades, and feature routes remain unchanged. If reused servers on ports 5173 or 8787 serve stale code, stop those known processes before rerunning; do not change application code to compensate for stale servers.

- [ ] **Step 5: Verify the deploy bundle without deploying**

```bash
pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run
```

Expected: Wrangler builds and validates the Worker bundle successfully, reports a dry run, and performs no deployment.

- [ ] **Step 6: Confirm final scope**

```bash
git diff --check -- apps/worker/src/app.ts apps/worker/src/app.test.ts
```

Expected: no whitespace errors; only the two exact implementation paths are changed if no checkpoint commit was made, or both are clean if the optional exact-path checkpoint commit was made. Do not stage, commit, or push as part of verification.

## Regression acceptance matrix

| Scenario | Required proof |
|---|---|
| Cache miss | One upstream import; cached `{ seed, session }`; returned token decrypts; token differs from seed; response keys unchanged. |
| Cache hit | No second upstream import; fresh token differs from seed and first outward token; decrypted payload equals first payload; `expiresAt` unchanged. |
| Logout then relogin | Old exact token returns `SESSION_EXPIRED`; independently minted token remains valid; cache-hit relogin returns another distinct usable token. |
| Expired cache seed | `decryptSession` rejects it; one normal upstream import runs; expired payload is never re-encrypted or extended. |
| Corrupt cache seed | Malformed, wrong-version, wrong-key/auth-tag, and non-VNU seeds each fall back to one normal upstream import. |
| Inconsistent metadata | University, student code, or expiry mismatch falls back to one normal upstream import. |
| Cache read failure | Normal upstream login succeeds with unchanged response shape. |
| Cache write failure | Normal upstream login succeeds with a valid outward token; no cache entry is required. |
| Frontend/API compatibility | No frontend files or route/schema shapes change; Playwright remains green. |

## Self-review outcome

- **Spec coverage:** Complete. Tasks cover fresh token identity on miss and hit, opaque non-replayed seed, original-expiry preservation, VNU payload/metadata validation, exact-token revocation, device isolation, cache-miss fallback for all invalid-entry classes, positive bounded TTL, fail-open cache reads/writes, unchanged API shape, synthetic-only tests, and all required verification commands.
- **Placeholder scan:** Passed. No TODO, TBD, deferred implementation, unspecified error handling, or placeholder code remains.
- **Type consistency:** Passed. Production and test snippets use current `EncryptedSessionPayload`, `encryptSession(payload, secret)`, `decryptSession(token, secret)`, Elysia `app.handle(Request)`, Vitest APIs, and current import response fields. `seed` exists only in `VnuImportCacheEntry`; outward responses retain `token`.
- **Scope check:** One worker subsystem and one focused test file. No frontend or core modification needed; no project split warranted.
