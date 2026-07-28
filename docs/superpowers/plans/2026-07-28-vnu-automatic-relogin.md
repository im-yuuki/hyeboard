# VNU Automatic Relogin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transparently recover eligible VNU requests with an eight-hour encrypted tab-scoped refresh grant while preserving exact-account, no-credential-storage, no-unsafe-replay, and authoritative revocation guarantees.

**Architecture:** Core owns purpose-bound encrypted refresh grants plus a self-sufficient internal access descriptor containing the HMAC principal, exact linked access/grant IDs, and both expiries. One HMAC-addressed Durable Object atomically owns each principal's active/revoked linked pair, leases, and five-attempt fixed window; ordinary active checks are authoritative read-only operations, while exact descriptor revocation can remove an account without the tab-scoped browser grant. Worker routes reject cross-principal/link mismatches without mutation, revoke a cryptographically linked identity mismatch through exact authority, and perform live login around one leased atomic rotation. Web code stores one opaque grant per local account in `sessionStorage`, coordinates one refresh per `(accountId, failedToken)`, replays only explicit safe GETs, and exposes refresh-without-replay to bulk state as client-only control flow.

**Tech Stack:** TypeScript 6, Web Crypto, Zod 4, Elysia 1.4, Cloudflare Workers/Durable Objects, React 19, TanStack Query 5, Vitest 4/3, Playwright 1.61, pnpm 11.

**Approved design:** `docs/superpowers/specs/2026-07-28-vnu-automatic-relogin-design.md`

---

## Worktree, Baseline, and Execution Guard

Run every command from:

```text
F:\Workspace\hyeboard\.worktrees\feature-vnu-automatic-relogin
```

Use immutable baseline `$BASE_SHA = "c0cdaf6"` in PowerShell. Runtime-config files may be dirty in `F:\Workspace\hyeboard`, outside this worktree. Never inspect, copy, restore, stage, or modify those outside-worktree changes.

- [ ] **Before Task 1, prove worktree and baseline**

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
git merge-base --is-ancestor c0cdaf6 HEAD
git status --short
```

Expected:

```text
F:/Workspace/hyeboard/.worktrees/feature-vnu-automatic-relogin
c0cdaf6
```

`merge-base` exits `0`. Status contains only this plan file before implementation. Stop if HEAD differs, another file is dirty, or root points at `F:/Workspace/hyeboard`.

At every task:

- stage only that task's allowlist;
- never use `git add .` or `git add -A`;
- never amend, rebase, reset, restore unrelated files, push, deploy, or run `pnpm deploy`;
- keep each task independently typechecking before commit;
- use conspicuous values such as `SYNTHETIC-VNU-USER`, `SYNTHETIC-VNU-PASSWORD`, `SYNTHETIC-STUDENT-CODE`, `SYNTHETIC-GRANT-ID-AAAAAA`; do not add plausible raw eight- or eleven-digit identities, credential-like random strings, or copied portal data.

## Protocol Constants and Error Vocabulary

Use these spellings everywhere. Do not add aliases.

```ts
export const VNU_REFRESH_REASON = "MISSING_VNU_CREDENTIAL" as const;
export const VNU_REQUEST_NOT_REPLAYED = "VNU_REQUEST_NOT_REPLAYED" as const;

export type VnuRefreshErrorCode =
  | "VNU_REFRESH_GRANT_INVALID"
  | "VNU_REFRESH_GRANT_REVOKED"
  | "INVALID_VNU_CREDENTIAL"
  | "VNU_REFRESH_IDENTITY_MISMATCH"
  | "VNU_REFRESH_RATE_LIMITED"
  | "VNU_REFRESH_UNAVAILABLE";
```

`VNU_REQUEST_NOT_REPLAYED` exists only in web memory. Worker must never emit it.

Terminal refresh failures:

```text
VNU_REFRESH_GRANT_INVALID
VNU_REFRESH_GRANT_REVOKED
INVALID_VNU_CREDENTIAL
VNU_REFRESH_IDENTITY_MISMATCH
```

Retryable refresh failures:

```text
VNU_REFRESH_RATE_LIMITED
VNU_REFRESH_UNAVAILABLE
existing VNU 429/5xx/network/timeout mappings
```

`VNU_SESSION_EXPIRED` remains session death only when no usable grant exists or terminal recovery removes the unchanged account. `VNU_LOGIN_REQUIRED` is refreshable only with details exactly `{ reason: "MISSING_VNU_CREDENTIAL" }`. Never broadly add `VNU_LOGIN_REQUIRED` to session-death codes.

## File Map

### Create

- `apps/worker/src/vnu-refresh-control.ts`: Worker-safe state/RPC contracts, pure transitions, HMAC principal derivation, coordinator, stable fail-closed errors; no `cloudflare:workers` import.
- `apps/worker/src/vnu-refresh-control.test.ts`: principal privacy, namespace failures, result mapping, read-only storage instrumentation.
- `apps/worker/src/vnu-refresh-control-durable-object.ts`: Cloudflare-only Durable Object implementation importing contracts/transitions from `vnu-refresh-control.ts`.
- `apps/worker/test/vnu-refresh-control-durable-object.workers.ts`: real Workers/Miniflare concurrency, transaction, privacy, race, and response-loss tests.
- `apps/web/src/lib/api-types.ts`: acyclic `ApiError`, `StoredAccount`, request/auth result types shared by `api.ts` and `vnu-refresh.ts`.
- `apps/web/src/lib/vnu-refresh.ts`: per-account grant storage, exact recoverability, request policies, single-flight/ref-count cancellation, guarded commit.
- `apps/web/src/lib/vnu-refresh.test.ts`: storage, policy, joining, replay, account races, cancellation, multi-account behavior.

### Modify

- `packages/core/src/index.ts`, `packages/core/src/session.test.ts`: grant payload, refresh-linked access descriptor/payload validation, purpose-limited expired-token decode, HKDF-separated keys, fixed lifetime and rotation.
- `packages/schemas/src/index.ts`: sanitized error details and import/refresh response schemas/types.
- `apps/worker/src/app.ts`, `apps/worker/src/app.test.ts`: classification, verified atomic issuance, authoritative descriptor checks, refresh/logout routes, legacy behavior, stable JSON responses/log privacy.
- `apps/worker/src/vnu-student-id-resolver.test.ts`: profile-incomplete pass-through vocabulary where route tests currently enumerate systemic errors.
- `packages/university-adapters/src/vnu/adapter.ts`: normalize username input and preserve verified identity behavior; no credential persistence.
- `apps/worker/src/index.ts`: Cloudflare binding installation and Durable Object export.
- `apps/worker/test/captcha-relay-worker.ts`, `apps/worker/vitest.workers.config.ts`: refresh-control test export and Miniflare binding.
- `apps/worker/wrangler.jsonc`, `apps/worker/worker-configuration.d.ts`: `VNU_REFRESH_CONTROL` binding, ordered `v3` migration, generated types.
- `apps/web/src/lib/api.ts`, `apps/web/src/lib/api.test.ts`: typed details, policy-aware request flow, atomic account/grant import, exact-account revoke/remove.
- `apps/web/src/state.tsx`, `apps/web/src/main.tsx`: async logout/removal, reconnect state, one query invalidation, Query retry policy.
- `apps/web/src/pages/login.tsx`: component-only VNU credentials until success and atomic grant storage.
- `apps/web/src/components/layout.tsx`, `apps/web/src/pages/settings.tsx`: awaited active/nonactive VNU revocation and visible failures.
- `apps/web/src/lib/bulk-lookup.ts`, `apps/web/src/lib/bulk-lookup.test.ts`, `apps/web/src/lib/api.test.ts`, `apps/web/src/lib/vnu-refresh.test.ts`, `apps/web/src/pages/lookup.tsx`: refresh-without-replay, joined-flight bulk cancellation, and retry-remaining state.
- `apps/web/src/lib/i18n.tsx`, `apps/web/tests/smoke.spec.ts`: EN/VI status and browser flows.
- `README.md`, `docs/architecture.md`, `docs/har-security.md`: credential/grant lifecycle, self-host limitation, privacy boundaries.

### Explicit Non-Changes

- No UET inline reauthentication behavior, UET credential keys, CAPTCHA flow, or UET lazy refresh changes.
- No encrypted refresh grant or grant credentials in `localStorage`, access-token payload, query cache/key, URL, export, analytics, logs, rendered diagnostics, or Worker error details. The encrypted access payload contains only the purpose-safe internal `principalKey`, exact access/grant IDs, and access/grant expiries required for authoritative linkage and grantless revocation.
- No automatic replay for bulk POST or any charged cross-lookup GET.
- No server-side credential vault and no credentials in Durable Object storage.
- No account ID accepted by Worker refresh/logout authority.
- No `cloudflare:workers` import reaches `app.ts`, Node/self-host TypeScript, or ordinary Node Vitest graph.
- No SSE contract change: refresh is JSON-only, and UET `uet-session-stream.ts` behavior remains unchanged.

## Dependency and Commit Order

```text
1 core grant crypto
  -> 2 Durable Object authority
  -> 3 Worker classification + issuance
  -> 4 Worker refresh/logout
  -> 5 web coordinator/request layer
  -> 6 UI/login/logout/i18n
  -> 7 bulk integration
  -> 8 docs/full verification
```

Eight sequential commits. Each task's GREEN command includes its package typecheck.

---

### Task 1: Add Purpose-Bound Refresh-Grant Cryptography

**Files:**
- Modify: `packages/core/src/index.ts:108-154`
- Modify: `packages/core/src/session.test.ts:1-33`

- [ ] **Step 1: Write RED grant tests**

Append this complete suite to `packages/core/src/session.test.ts`; update its import to include the named symbols used below:

```ts
import {
  createVnuRefreshGrant,
  decryptSession,
  decryptVnuRefreshGrant,
  encryptSession,
  encryptVnuRefreshGrant,
  rotateVnuRefreshGrant,
  type EncryptedSessionPayload,
} from "./index";

const GRANT_SECRET = "synthetic-core-secret-with-at-least-32-chars";
const NOW = Date.parse("2036-01-02T03:04:05.000Z");

describe("VNU refresh grants", () => {
  it("round trips an exact purpose-bound eight-hour payload", async () => {
    const payload = createVnuRefreshGrant({
      username: "  SYNTHETIC-VNU-USER  ",
      password: "SYNTHETIC-VNU-PASSWORD",
      expectedStudentCode: "SYNTHETIC-STUDENT-CODE",
      now: NOW,
      randomBytes: () => new Uint8Array(16).fill(0x5a),
    });
    const grant = await encryptVnuRefreshGrant(payload, GRANT_SECRET);
    await expect(decryptVnuRefreshGrant(grant, GRANT_SECRET, NOW + 1)).resolves.toEqual(payload);
    expect(payload).toMatchObject({ version: 1, purpose: "vnu-refresh", universityId: "vnu", username: "synthetic-vnu-user" });
    expect(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)).toBe(8 * 60 * 60 * 1000);
    expect(payload.grantId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("separates access-token and refresh-grant cryptographic domains", async () => {
    const session: EncryptedSessionPayload = {
      version: 1,
      universityId: "vnu",
      studentCode: "SYNTHETIC-STUDENT-CODE",
      vnu: { kind: "cookie", value: "SYNTHETIC-COOKIE" },
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const payload = createVnuRefreshGrant({
      username: "SYNTHETIC-VNU-USER",
      password: "SYNTHETIC-VNU-PASSWORD",
      expectedStudentCode: "SYNTHETIC-STUDENT-CODE",
      now: NOW,
      randomBytes: () => new Uint8Array(16).fill(0x31),
    });
    const access = await encryptSession(session, GRANT_SECRET);
    const grant = await encryptVnuRefreshGrant(payload, GRANT_SECRET);
    await expect(decryptVnuRefreshGrant(access, GRANT_SECRET, NOW)).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_INVALID", status: 401 });
    await expect(decryptSession(grant, GRANT_SECRET)).rejects.toMatchObject({ code: "INVALID_SESSION", status: 401 });
  });

  it.each([
    ["malformed", "not-a-grant"],
    ["tampered", "AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAA"],
  ])("returns one sanitized error for %s ciphertext", async (_label, grant) => {
    await expect(decryptVnuRefreshGrant(grant, GRANT_SECRET, NOW)).rejects.toEqual(expect.objectContaining({
      code: "VNU_REFRESH_GRANT_INVALID",
      message: "The VNU reconnect grant is invalid or expired.",
      status: 401,
      details: undefined,
    }));
  });

  it("rejects wrong secret, purpose, version, university, malformed timestamps, empty fields, and expiry identically", async () => {
    const valid = createVnuRefreshGrant({
      username: "SYNTHETIC-VNU-USER",
      password: "SYNTHETIC-VNU-PASSWORD",
      expectedStudentCode: "SYNTHETIC-STUDENT-CODE",
      now: NOW,
      randomBytes: () => new Uint8Array(16).fill(0x44),
    });
    const shapes = [
      { ...valid, purpose: "access" },
      { ...valid, version: 2 },
      { ...valid, universityId: "uet" },
      { ...valid, issuedAt: "invalid" },
      { ...valid, expiresAt: new Date(NOW + 1).toISOString() },
      { ...valid, username: "" },
      { ...valid, password: "" },
      { ...valid, expectedStudentCode: "" },
      { ...valid, grantId: "short" },
    ];
    for (const shape of shapes) {
      const encrypted = await encryptVnuRefreshGrant(shape as never, GRANT_SECRET, { validate: false });
      await expect(decryptVnuRefreshGrant(encrypted, GRANT_SECRET, NOW)).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_INVALID", details: undefined });
    }
    const encrypted = await encryptVnuRefreshGrant(valid, GRANT_SECRET);
    await expect(decryptVnuRefreshGrant(encrypted, `${GRANT_SECRET}-wrong`, NOW)).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_INVALID" });
    await expect(decryptVnuRefreshGrant(encrypted, GRANT_SECRET, Date.parse(valid.expiresAt))).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_INVALID" });
  });

  it("uses independent IVs and rotates ID without extending original lifetime", async () => {
    const original = createVnuRefreshGrant({
      username: "SYNTHETIC-VNU-USER",
      password: "SYNTHETIC-VNU-PASSWORD",
      expectedStudentCode: "SYNTHETIC-STUDENT-CODE",
      now: NOW,
      randomBytes: () => new Uint8Array(16).fill(0x21),
    });
    const first = await encryptVnuRefreshGrant(original, GRANT_SECRET);
    const second = await encryptVnuRefreshGrant(original, GRANT_SECRET);
    expect(first.split(".")[0]).not.toBe(second.split(".")[0]);
    const rotated = rotateVnuRefreshGrant(original, () => new Uint8Array(16).fill(0x22));
    expect(rotated.grantId).not.toBe(original.grantId);
    expect(rotated.issuedAt).toBe(original.issuedAt);
    expect(rotated.expiresAt).toBe(original.expiresAt);
  });
});
```

In the same RED suite add these access-token cases before implementation:

- `createVnuRefreshAccessDescriptor()` normalizes username, derives a 64-lowercase-hex `principalKey` with HMAC-SHA-256 under a dedicated label/key context, creates an independent 128-bit base64url `accessTokenId`, and carries the exact linked `grantId`, canonical `accessExpiresAt`, and canonical `grantExpiresAt`. Assert serialized descriptor contains none of username, password, student code, cookie, or plausible identity text.
- Descriptor validation rejects extra/missing keys, wrong version/purpose, malformed `principalKey`, malformed IDs, and descriptor/grant mismatch with `INVALID_SESSION`.
- Descriptor validation rejects either noncanonical expiry and requires `accessExpiresAt === EncryptedSessionPayload.expiresAt`; issuance tests require descriptor grant expiry equals decrypted grant expiry. Add a grantless descriptor round trip proving the Worker can reconstruct the complete linked pair without a browser grant.
- `decryptSessionForVnuRefresh()` verifies ordinary access-token AES-GCM authentication and exact payload shape but permits an expired outer `expiresAt`; `decryptSession()` rejects the same token with `SESSION_EXPIRED`. Wrong key, tampering, malformed shape, and wrong descriptor purpose still fail.
- Both token decoders require canonical ISO timestamps: parse each string, require a finite time, then require `new Date(parsed).toISOString() === original` exactly. Include offset, missing milliseconds, impossible date, and trailing-text rejection fixtures.
- Ordinary request code cannot import or opt into an `allowExpired` flag. Export narrowly named `decryptSessionForVnuRefresh()` and `decryptSessionForVnuLogout()` entry points used only by Task 4's matching routes.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @hyeboard/core exec vitest run src/session.test.ts
```

Expected: FAIL at module collection because `createVnuRefreshGrant`, `encryptVnuRefreshGrant`, `decryptVnuRefreshGrant`, and `rotateVnuRefreshGrant` are not exported.

- [ ] **Step 3: Add minimal grant implementation**

Add these declarations beside the existing session helpers in `packages/core/src/index.ts`. Keep existing `deriveKey()` unchanged for access tokens; grant encryption must call only `deriveVnuRefreshGrantKey()`.

```ts
const VNU_REFRESH_LIFETIME_MS = 8 * 60 * 60 * 1000;
const VNU_REFRESH_SALT = new TextEncoder().encode("hyeboard:vnu-refresh:v1:salt");
const VNU_REFRESH_INFO = new TextEncoder().encode("hyeboard:vnu-refresh:v1:aes-gcm");
const VNU_REFRESH_AAD = new TextEncoder().encode("hyeboard:vnu-refresh:v1");
const VNU_GRANT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const VNU_PRINCIPAL_PATTERN = /^[0-9a-f]{64}$/;

export type VnuRefreshGrantPayload = {
  version: 1;
  purpose: "vnu-refresh";
  grantId: string;
  universityId: "vnu";
  username: string;
  password: string;
  expectedStudentCode: string;
  issuedAt: string;
  expiresAt: string;
};

export type VnuRefreshAccessDescriptor = {
  version: 1;
  purpose: "vnu-refresh-access";
  principalKey: string;
  accessTokenId: string;
  grantId: string;
  accessExpiresAt: string;
  grantExpiresAt: string;
};

type RandomBytes = (length: number) => Uint8Array;

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function invalidVnuRefreshGrant(): HyeboardError {
  return new HyeboardError("VNU_REFRESH_GRANT_INVALID", "The VNU reconnect grant is invalid or expired.", 401);
}

function normalizeVnuUsername(username: string): string {
  return username.trim().toLowerCase();
}

function assertStrongSecret(secret: string): void {
  if (secret.length < 32) throw new HyeboardError("WEAK_SESSION_SECRET", "HYEB_SESSION_SECRET must be at least 32 characters", 500);
}

async function deriveVnuRefreshGrantKey(secret: string): Promise<CryptoKey> {
  assertStrongSecret(secret);
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(VNU_REFRESH_SALT), info: toArrayBuffer(VNU_REFRESH_INFO) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function assertVnuRefreshGrantPayload(value: unknown): asserts value is VnuRefreshGrantPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidVnuRefreshGrant();
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  const expectedKeys = ["expectedStudentCode", "expiresAt", "grantId", "issuedAt", "password", "purpose", "universityId", "username", "version"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw invalidVnuRefreshGrant();
  if (payload.version !== 1 || payload.purpose !== "vnu-refresh" || payload.universityId !== "vnu") throw invalidVnuRefreshGrant();
  if (typeof payload.grantId !== "string" || !VNU_GRANT_ID_PATTERN.test(payload.grantId)) throw invalidVnuRefreshGrant();
  for (const key of ["username", "password", "expectedStudentCode"] as const) {
    if (typeof payload[key] !== "string" || payload[key].length === 0) throw invalidVnuRefreshGrant();
  }
  const issuedAt = typeof payload.issuedAt === "string" ? Date.parse(payload.issuedAt) : Number.NaN;
  const expiresAt = typeof payload.expiresAt === "string" ? Date.parse(payload.expiresAt) : Number.NaN;
  if (payload.username !== normalizeVnuUsername(payload.username as string)) throw invalidVnuRefreshGrant();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) throw invalidVnuRefreshGrant();
  if (new Date(issuedAt).toISOString() !== payload.issuedAt || new Date(expiresAt).toISOString() !== payload.expiresAt) throw invalidVnuRefreshGrant();
  if (expiresAt - issuedAt !== VNU_REFRESH_LIFETIME_MS) throw invalidVnuRefreshGrant();
}

export function createVnuRefreshGrant(input: {
  username: string;
  password: string;
  expectedStudentCode: string;
  now?: number;
  randomBytes?: RandomBytes;
}): VnuRefreshGrantPayload {
  const now = input.now ?? Date.now();
  const random = input.randomBytes ?? defaultRandomBytes;
  const payload: VnuRefreshGrantPayload = {
    version: 1,
    purpose: "vnu-refresh",
    grantId: toBase64Url(random(16)),
    universityId: "vnu",
    username: normalizeVnuUsername(input.username),
    password: input.password,
    expectedStudentCode: input.expectedStudentCode,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + VNU_REFRESH_LIFETIME_MS).toISOString(),
  };
  assertVnuRefreshGrantPayload(payload);
  return payload;
}

export function rotateVnuRefreshGrant(payload: VnuRefreshGrantPayload, randomBytes: RandomBytes = defaultRandomBytes): VnuRefreshGrantPayload {
  assertVnuRefreshGrantPayload(payload);
  return { ...payload, grantId: toBase64Url(randomBytes(16)) };
}

export async function encryptVnuRefreshGrant(
  payload: VnuRefreshGrantPayload,
  secret: string,
  options: { validate?: boolean } = {},
): Promise<string> {
  if (options.validate !== false) assertVnuRefreshGrantPayload(payload);
  const iv = defaultRandomBytes(12);
  const key = await deriveVnuRefreshGrantKey(secret);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(VNU_REFRESH_AAD) },
    key,
    toArrayBuffer(encoded),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

export async function decryptVnuRefreshGrant(token: string, secret: string, now = Date.now()): Promise<VnuRefreshGrantPayload> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalidVnuRefreshGrant();
    const iv = fromBase64Url(parts[0]);
    if (iv.byteLength !== 12) throw invalidVnuRefreshGrant();
    const key = await deriveVnuRefreshGrantKey(secret);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(VNU_REFRESH_AAD) },
      key,
      toArrayBuffer(fromBase64Url(parts[1])),
    );
    const payload: unknown = JSON.parse(new TextDecoder().decode(decrypted));
    assertVnuRefreshGrantPayload(payload);
    if (Date.parse(payload.expiresAt) <= now) throw invalidVnuRefreshGrant();
    return payload;
  } catch (error) {
    if (error instanceof HyeboardError && error.code === "WEAK_SESSION_SECRET") throw error;
    throw invalidVnuRefreshGrant();
  }
}
```

Extend `EncryptedSessionPayload` with optional `vnuRefresh?: VnuRefreshAccessDescriptor`. It is internal and appears only inside encrypted access tokens. Export one `deriveVnuRefreshPrincipal(username,secret)` implementation and make `createVnuRefreshAccessDescriptor({username,grantId,accessExpiresAt,grantExpiresAt,secret,randomBytes})` call it with a dedicated HMAC protocol label; neither returns normalized username. Worker control code re-exports/imports this function rather than reimplementing HMAC. `assertEncryptedSessionPayload()` validates full session shape, descriptor purpose, exact keys, canonical ISO values, `descriptor.accessExpiresAt === payload.expiresAt`, and that descriptor-bearing sessions are VNU sessions with a nonempty VNU credential. `decryptSession()` and purpose-limited `decryptSessionForVnuRefresh()`/`decryptSessionForVnuLogout()` share one private cryptographic decoder; refresh and logout may skip final outward-expiry rejection, while ordinary resolution never can. Logout decode exists only to recover a validated encrypted descriptor; it does not accept malformed/unauthenticated tokens. Never expose a general `allowExpired` flag or loosen ordinary request validation.

Implementation note: HKDF's raw input is `HYEB_SESSION_SECRET`; salt, info, and AES-GCM AAD are fixed protocol labels. This is domain separation. Do not derive the grant key by reusing the existing plain SHA-256 access-token key. HMAC principal derivation uses a separate protocol label from both encryption domains. Grant lifetime remains exactly eight hours from manual login; access-token rotation never extends it.

- [ ] **Step 4: Run GREEN and package typecheck**

```bash
pnpm --filter @hyeboard/core test
```

Expected: all core tests PASS and TypeScript exits `0`.

- [ ] **Step 5: Commit Task 1 only**

```bash
git add packages/core/src/index.ts packages/core/src/session.test.ts
git diff --cached --check
git commit -m "feat(core): add purpose-bound VNU refresh grants"
```

Expected: one commit; no other paths staged.

---

### Task 2: Add Authoritative VNU Refresh Durable Object

**Files:**
- Create: `apps/worker/src/vnu-refresh-control.ts`
- Create: `apps/worker/src/vnu-refresh-control.test.ts`
- Create: `apps/worker/src/vnu-refresh-control-durable-object.ts`
- Create: `apps/worker/test/vnu-refresh-control-durable-object.workers.ts`
- Modify: `apps/worker/src/app.ts` (Worker-safe coordinator injection/default only)
- Modify: `apps/worker/src/index.ts:4-24`
- Modify: `apps/worker/test/captcha-relay-worker.ts:1-3`
- Modify: `apps/worker/vitest.workers.config.ts:7-20`
- Verify only: `apps/worker/package.json:14,21` already defines `test:workers` and includes it in `test`; do not edit or stage it.
- Modify: `apps/worker/wrangler.jsonc:28-49`
- Regenerate: `apps/worker/worker-configuration.d.ts`

- [ ] **Step 1: Write RED Worker-safe contract/coordinator tests**

Create `apps/worker/src/vnu-refresh-control.test.ts`. This ordinary Vitest file imports only `vnu-refresh-control.ts`; it must not import the Durable Object implementation or `cloudflare:workers`. Test pure transitions for atomic access/grant pairs, plus coordinator principal derivation and fail-closed result mapping. Use these pair fixtures:

```ts
import { describe, expect, it } from "vitest";
import {
  applyAbortRefresh,
  applyBeginRefresh,
  applyCompleteRefresh,
  applyActivatePair,
  applyRevokeExactLinkedPair,
  applyRevokeLinkedPairByAccess,
  type VnuRefreshControlState,
} from "./vnu-refresh-control";

const NOW = Date.parse("2036-02-03T04:05:06.000Z");
const EXPIRY = NOW + 8 * 60 * 60 * 1000;
const OLD = { accessTokenId: "A".repeat(22), accessExpiresAt: EXPIRY - 60_000, grantId: "B".repeat(22), grantExpiresAt: EXPIRY };
const NEXT = { accessTokenId: "C".repeat(22), accessExpiresAt: EXPIRY + 60_000, grantId: "D".repeat(22), grantExpiresAt: EXPIRY };

describe("VNU refresh control transitions", () => {
  it("activates one linked pair and revokes both IDs of the replaced pair", () => {
    const first = applyActivatePair(undefined, OLD, NOW);
    const second = applyActivatePair(first.state, NEXT, NOW + 1);
    expect(second.state.active).toEqual(NEXT);
    expect(second.state.revokedAccess[OLD.accessTokenId]).toBe(OLD.accessExpiresAt);
    expect(second.state.revokedGrants[OLD.grantId]).toBe(OLD.grantExpiresAt);
    expect(second.state).not.toHaveProperty("username");
    expect(second.state).not.toHaveProperty("password");
  });

  it("leases once for two minutes and consumes one attempt before upstream work", () => {
    const registered = applyActivatePair(undefined, OLD, NOW).state;
    const first = applyBeginRefresh(registered, OLD, NOW);
    expect(first.result).toEqual({ kind: "accepted", leaseExpiresAt: NOW + 120_000 });
    expect(first.state.window).toEqual({ count: 1, resetAt: NOW + 900_000 });
    const duplicate = applyBeginRefresh(first.state, OLD, NOW + 1);
    expect(duplicate.result).toEqual({ kind: "in-progress", retryAfterSeconds: 120 });
    expect(duplicate.state.window.count).toBe(1);
  });

  it("restores eligibility after lease expiry and enforces five attempts per fifteen minutes", () => {
    let state = applyActivatePair(undefined, OLD, NOW).state;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const begin = applyBeginRefresh(state, OLD, NOW + attempt * 120_001);
      expect(begin.result.kind).toBe("accepted");
      state = begin.state;
    }
    const limited = applyBeginRefresh(state, OLD, NOW + 5 * 120_001);
    expect(limited.result).toEqual({ kind: "rate-limited", retryAfterSeconds: 300, limit: 5, windowSeconds: 900 });
  });

  it("completes rotation atomically and rejects the old ID through expiry", () => {
    const registered = applyActivatePair(undefined, OLD, NOW).state;
    const leased = applyBeginRefresh(registered, OLD, NOW).state;
    const completed = applyCompleteRefresh(leased, { old: OLD, next: NEXT }, NOW + 1);
    expect(completed.result).toEqual({ kind: "completed" });
    expect(completed.state.active).toEqual(NEXT);
    expect(completed.state.revokedAccess[OLD.accessTokenId]).toBe(OLD.accessExpiresAt);
    expect(completed.state.revokedGrants[OLD.grantId]).toBe(OLD.grantExpiresAt);
    expect(applyBeginRefresh(completed.state, OLD, NOW + 2).result).toEqual({ kind: "revoked" });
  });

  it("releases retryable failures and revokes definitive failures", () => {
    const registered = applyActivatePair(undefined, OLD, NOW).state;
    const leased = applyBeginRefresh(registered, OLD, NOW).state;
    const retryable = applyAbortRefresh(leased, { pair: OLD, terminal: false }, NOW + 1);
    expect(retryable.state.lease).toBeUndefined();
    expect(retryable.state.active).toEqual(OLD);
    const leasedAgain = applyBeginRefresh(retryable.state, OLD, NOW + 2).state;
    const terminal = applyAbortRefresh(leasedAgain, { pair: OLD, terminal: true }, NOW + 3);
    expect(terminal.state.active).toBeUndefined();
    expect(terminal.state.revokedAccess[OLD.accessTokenId]).toBe(OLD.accessExpiresAt);
    expect(terminal.state.revokedGrants[OLD.grantId]).toBe(OLD.grantExpiresAt);
  });

  it("grantless logout revokes only the exact active descriptor pair idempotently", () => {
    const registered = applyActivatePair(undefined, OLD, NOW).state;
    const leased = applyBeginRefresh(registered, OLD, NOW).state;
    const first = applyRevokeLinkedPairByAccess(leased, OLD, NOW + 1);
    const second = applyRevokeLinkedPairByAccess(first.state, OLD, NOW + 2);
    expect(second.result).toEqual({ kind: "revoked" });
    expect(second.state.active).toBeUndefined();
    expect(second.state.lease).toBeUndefined();
    expect(second.state.revokedAccess[OLD.accessTokenId]).toBe(OLD.accessExpiresAt);
    expect(second.state.revokedGrants[OLD.grantId]).toBe(OLD.grantExpiresAt);
    expect(applyCompleteRefresh(second.state, { old: OLD, next: NEXT }, NOW + 3).result).toEqual({ kind: "revoked" });
  });

  it("mismatched artifacts cannot revoke another pair, while an exact linked identity mismatch revokes its own pair", () => {
    const registered = applyActivatePair(undefined, OLD, NOW).state;
    const wrongLink = { ...OLD, grantId: "Z".repeat(22) };
    const denied = applyRevokeLinkedPairByAccess(registered, wrongLink, NOW + 1);
    expect(denied.result).toEqual({ kind: "mismatch" });
    expect(denied.state).toEqual(registered);
    const revoked = applyRevokeExactLinkedPair(registered, OLD, NOW + 2);
    expect(revoked.result).toEqual({ kind: "revoked" });
    expect(revoked.state.active).toBeUndefined();
    expect(revoked.state.revokedAccess[OLD.accessTokenId]).toBe(OLD.accessExpiresAt);
    expect(revoked.state.revokedGrants[OLD.grantId]).toBe(OLD.grantExpiresAt);
  });
});
```

Extend every assertion above to check `changed` explicitly. Exact semantic mutations (`activate`, accepted begin, completion, lease release, terminal revoke, first exact revoke) assert `changed:true`. Same-pair activation, duplicate/in-progress/rate-limited/revoked begin, late completion, absent-lease abort, mismatched revoke, repeated revoke, already-revoked revoke, and a pair with both expiries `<= now` assert `changed:false` plus exact state equality with the input snapshot. Call each no-op once with stale cleanup candidates present and prove it still does not smuggle housekeeping into a mutation result; read cleanup/alarm owns that write separately.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @hyeboard/worker exec vitest run src/vnu-refresh-control.test.ts
```

Expected: FAIL because Worker-safe contracts/transitions do not exist.

- [ ] **Step 3: Implement Worker-safe contracts and pure transitions**

Create `apps/worker/src/vnu-refresh-control.ts` with all public contracts, pure transitions, HMAC principal derivation, coordinator mapping, and stable errors. This file is Worker-safe Web API TypeScript and must not import `cloudflare:workers`. The following shape is normative; update the remainder of the transition pseudocode in this step to use complete `LinkedPair` values rather than independent grant IDs:

```ts
export const VNU_REFRESH_ATTEMPT_LIMIT = 5;
export const VNU_REFRESH_WINDOW_MS = 15 * 60 * 1000;
export const VNU_REFRESH_LEASE_MS = 2 * 60 * 1000;
export const VNU_REFRESH_STATE_KEY = "vnu-refresh-control";

export type LinkedPair = { accessTokenId: string; accessExpiresAt: number; grantId: string; grantExpiresAt: number };
// Reconstructed entirely from the authenticated encrypted access descriptor.
export type AccessDescriptorRef = LinkedPair;
export type RefreshLease = { pair: LinkedPair; expiresAt: number };
export type RefreshWindow = { count: number; resetAt: number };
export type VnuRefreshControlState = {
  active?: LinkedPair;
  lease?: RefreshLease;
  revokedAccess: Record<string, number>;
  revokedGrants: Record<string, number>;
  window: RefreshWindow;
};

export type BeginRefreshResult =
  | { kind: "accepted"; leaseExpiresAt: number }
  | { kind: "in-progress"; retryAfterSeconds: number }
  | { kind: "rate-limited"; retryAfterSeconds: number; limit: 5; windowSeconds: 900 }
  | { kind: "revoked" };
export type MutationResult = { kind: "activated" | "completed" | "aborted" | "revoked" | "mismatch" | "expired" };
export type AccessCheckResult = { kind: "active" } | { kind: "revoked" };
export type TransitionOutput<T> = { state: VnuRefreshControlState; result: T; changed: boolean };

export function assertLinkedPair(value: unknown): asserts value is LinkedPair {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid VNU refresh pair");
  const pair = value as Record<string, unknown>;
  const keys = Object.keys(pair).sort();
  const expected = ["accessExpiresAt", "accessTokenId", "grantExpiresAt", "grantId"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("Invalid VNU refresh pair");
  if (typeof pair.accessTokenId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(pair.accessTokenId)) throw new Error("Invalid VNU refresh pair");
  if (typeof pair.grantId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(pair.grantId)) throw new Error("Invalid VNU refresh pair");
  if (!Number.isSafeInteger(pair.accessExpiresAt) || (pair.accessExpiresAt as number) <= 0) throw new Error("Invalid VNU refresh pair");
  if (!Number.isSafeInteger(pair.grantExpiresAt) || (pair.grantExpiresAt as number) <= 0) throw new Error("Invalid VNU refresh pair");
}

export const assertAccessDescriptorRef = assertLinkedPair;

export function parseVnuRefreshControlState(value: unknown): VnuRefreshControlState | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid VNU refresh state");
  const state = value as Record<string, unknown>;
  const allowed = new Set(["active", "lease", "revokedAccess", "revokedGrants", "window"]);
  if (Object.keys(state).some((key) => !allowed.has(key))) throw new Error("Invalid VNU refresh state");
  if (state.active !== undefined) assertLinkedPair(state.active);
  if (state.lease !== undefined) {
    if (!state.lease || typeof state.lease !== "object" || Array.isArray(state.lease)) throw new Error("Invalid VNU refresh state");
    const lease = state.lease as Record<string, unknown>;
    if (Object.keys(lease).sort().join(",") !== "expiresAt,pair") throw new Error("Invalid VNU refresh state");
    assertLinkedPair(lease.pair);
    if (!Number.isSafeInteger(lease.expiresAt) || (lease.expiresAt as number) <= 0) throw new Error("Invalid VNU refresh state");
  }
  for (const name of ["revokedAccess", "revokedGrants"] as const) {
    const map = state[name];
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("Invalid VNU refresh state");
    if (Object.entries(map).some(([id, expiry]) => !/^[A-Za-z0-9_-]{22}$/.test(id) || !Number.isSafeInteger(expiry) || (expiry as number) <= 0)) throw new Error("Invalid VNU refresh state");
  }
  if (!state.window || typeof state.window !== "object" || Array.isArray(state.window)) throw new Error("Invalid VNU refresh state");
  const window = state.window as Record<string, unknown>;
  if (Object.keys(window).sort().join(",") !== "count,resetAt" || !Number.isSafeInteger(window.count) || (window.count as number) < 0 || !Number.isSafeInteger(window.resetAt) || (window.resetAt as number) <= 0) throw new Error("Invalid VNU refresh state");
  return state as VnuRefreshControlState;
}

export function samePair(left: LinkedPair | undefined, right: LinkedPair): boolean {
  return Boolean(left && left.accessTokenId === right.accessTokenId && left.accessExpiresAt === right.accessExpiresAt && left.grantId === right.grantId && left.grantExpiresAt === right.grantExpiresAt);
}

export function sameVnuRefreshState(left: VnuRefreshControlState | undefined, right: VnuRefreshControlState): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function emptyState(now: number): VnuRefreshControlState {
  return { revokedAccess: {}, revokedGrants: {}, window: { count: 0, resetAt: now + VNU_REFRESH_WINDOW_MS } };
}

export function cleanVnuRefreshState(input: VnuRefreshControlState | undefined, now: number): VnuRefreshControlState {
  const source = input ?? emptyState(now);
  const revokedAccess = Object.fromEntries(Object.entries(source.revokedAccess).filter(([, expiresAt]) => expiresAt > now));
  const revokedGrants = Object.fromEntries(Object.entries(source.revokedGrants).filter(([, expiresAt]) => expiresAt > now));
  // Keep the link through grant expiry even after access expiry so purpose-limited
  // logout can revoke the still-live grant from the expired encrypted descriptor.
  const active = source.active && source.active.grantExpiresAt > now ? source.active : undefined;
  const lease = source.lease && source.lease.expiresAt > now ? source.lease : undefined;
  const window = now >= source.window.resetAt ? { count: 0, resetAt: now + VNU_REFRESH_WINDOW_MS } : source.window;
  return { active, lease, revokedAccess, revokedGrants, window };
}

function unchanged<T>(stored: VnuRefreshControlState | undefined, now: number, result: T): TransitionOutput<T> {
  // Materialize only for the return value. changed:false forbids persistence.
  return { state: stored ?? emptyState(now), result, changed: false };
}

function changed<T>(stored: VnuRefreshControlState | undefined, state: VnuRefreshControlState, result: T): TransitionOutput<T> {
  return { state, result, changed: !sameVnuRefreshState(stored, state) };
}

function revokeExact(state: VnuRefreshControlState, pair: LinkedPair): VnuRefreshControlState {
  return {
    ...state,
    active: undefined,
    lease: state.lease && samePair(state.lease.pair, pair) ? undefined : state.lease,
    revokedAccess: { ...state.revokedAccess, [pair.accessTokenId]: pair.accessExpiresAt },
    revokedGrants: { ...state.revokedGrants, [pair.grantId]: pair.grantExpiresAt },
  };
}

export function applyActivatePair(stored: VnuRefreshControlState | undefined, pair: LinkedPair, now: number) {
  assertLinkedPair(pair);
  if (samePair(stored?.active, pair) && stored?.lease === undefined) return unchanged(stored, now, { kind: "activated" } as const);
  const state = cleanVnuRefreshState(stored, now);
  const replaced = state.active && (state.active.accessTokenId !== pair.accessTokenId || state.active.grantId !== pair.grantId)
    ? revokeExact(state, state.active)
    : state;
  return changed(stored, { ...replaced, active: pair, lease: undefined }, { kind: "activated" } as const);
}

export function applyBeginRefresh(stored: VnuRefreshControlState | undefined, pair: LinkedPair, now: number): TransitionOutput<BeginRefreshResult> {
  assertLinkedPair(pair);
  const state = cleanVnuRefreshState(stored, now);
  if (state.revokedAccess[pair.accessTokenId] || state.revokedGrants[pair.grantId] || !samePair(state.active, pair)) return unchanged(stored, now, { kind: "revoked" });
  if (state.lease && samePair(state.lease.pair, pair)) return unchanged(stored, now, { kind: "in-progress", retryAfterSeconds: Math.max(1, Math.ceil((state.lease.expiresAt - now) / 1000)) });
  if (state.window.count >= VNU_REFRESH_ATTEMPT_LIMIT) return unchanged(stored, now, { kind: "rate-limited", retryAfterSeconds: Math.max(1, Math.ceil((state.window.resetAt - now) / 1000)), limit: 5, windowSeconds: 900 });
  const leaseExpiresAt = now + VNU_REFRESH_LEASE_MS;
  return changed(stored, { ...state, lease: { pair, expiresAt: leaseExpiresAt }, window: { ...state.window, count: state.window.count + 1 } }, { kind: "accepted", leaseExpiresAt });
}

export function applyCompleteRefresh(stored: VnuRefreshControlState | undefined, input: { old: LinkedPair; next: LinkedPair }, now: number) {
  assertLinkedPair(input.old);
  assertLinkedPair(input.next);
  if (input.next.grantExpiresAt !== input.old.grantExpiresAt) throw new Error("VNU refresh grant expiry changed");
  const state = cleanVnuRefreshState(stored, now);
  if (!samePair(state.active, input.old) || !state.lease || !samePair(state.lease.pair, input.old)) return unchanged(stored, now, { kind: "revoked" } as const);
  const revoked = revokeExact(state, input.old);
  return changed(stored, { ...revoked, active: input.next }, { kind: "completed" } as const);
}

export function applyAbortRefresh(stored: VnuRefreshControlState | undefined, input: { pair: LinkedPair; terminal: boolean }, now: number) {
  assertLinkedPair(input.pair);
  const state = cleanVnuRefreshState(stored, now);
  if (state.revokedAccess[input.pair.accessTokenId] || state.revokedGrants[input.pair.grantId]) return unchanged(stored, now, { kind: "revoked" } as const);
  if (!state.lease || !samePair(state.lease.pair, input.pair) || !samePair(state.active, input.pair)) return unchanged(stored, now, { kind: "aborted" } as const);
  if (!input.terminal) return changed(stored, { ...state, lease: undefined }, { kind: "aborted" } as const);
  return changed(stored, revokeExact(state, state.active), { kind: "revoked" } as const);
}

export function applyRevokeLinkedPairByAccess(stored: VnuRefreshControlState | undefined, pair: AccessDescriptorRef, now: number) {
  assertLinkedPair(pair);
  if (pair.accessExpiresAt <= now && pair.grantExpiresAt <= now) return unchanged(stored, now, { kind: "expired" } as const);
  const state = cleanVnuRefreshState(stored, now);
  if (state.revokedAccess[pair.accessTokenId] && state.revokedGrants[pair.grantId]) return unchanged(stored, now, { kind: "revoked" } as const);
  if (!samePair(state.active, pair)) return unchanged(stored, now, { kind: "mismatch" } as const);
  return changed(stored, revokeExact(state, pair), { kind: "revoked" } as const);
}

export const applyRevokeExactLinkedPair = applyRevokeLinkedPairByAccess;

export function applyCheckAccess(stored: VnuRefreshControlState | undefined, access: AccessDescriptorRef, now: number) {
  assertAccessDescriptorRef(access);
  const state = cleanVnuRefreshState(stored, now);
  const changed = stored !== undefined && !sameVnuRefreshState(stored, state);
  const active = samePair(state.active, access) && access.accessExpiresAt > now;
  return { state, changed, result: { kind: active && !state.revokedAccess[access.accessTokenId] && !state.revokedGrants[access.grantId] ? "active" : "revoked" } as AccessCheckResult };
}

```

Keep this Durable Object implementation for Step 4 GREEN; do not create it before the Workers RED run. `apps/worker/src/vnu-refresh-control-durable-object.ts` imports contracts/transitions above; `vnu-refresh-control.ts` never imports it:

```ts
import { DurableObject } from "cloudflare:workers";
import {
  applyAbortRefresh, applyActivatePair, applyBeginRefresh, applyCheckAccess,
  applyCompleteRefresh, applyRevokeExactLinkedPair, applyRevokeLinkedPairByAccess,
  cleanVnuRefreshState, nextVnuRefreshAlarm, parseVnuRefreshControlState,
  sameVnuRefreshState, VNU_REFRESH_STATE_KEY,
  type AccessDescriptorRef, type LinkedPair, type TransitionOutput, type VnuRefreshControlState,
} from "./vnu-refresh-control";

export class VnuRefreshControlDurableObject extends DurableObject<Env> {
  private async mutate<T>(transition: (state: VnuRefreshControlState | undefined, now: number) => TransitionOutput<T>): Promise<T> {
    return this.ctx.storage.transaction(async (transaction) => {
      const stored = parseVnuRefreshControlState(await transaction.get(VNU_REFRESH_STATE_KEY));
      const output = transition(stored, Date.now());
      if (output.changed) {
        await transaction.put(VNU_REFRESH_STATE_KEY, output.state);
        const nextAlarm = nextVnuRefreshAlarm(output.state);
        if (nextAlarm === undefined) await transaction.deleteAlarm();
        else await transaction.setAlarm(nextAlarm);
      }
      return output.result;
    });
  }

  activatePair(pair: LinkedPair) { return this.mutate((state, now) => applyActivatePair(state, pair, now)); }
  async checkAccess(access: AccessDescriptorRef) {
    // Steady active path: one authoritative read, zero transaction/put/alarm mutation.
    const stored = parseVnuRefreshControlState(await this.ctx.storage.get(VNU_REFRESH_STATE_KEY));
    const checked = applyCheckAccess(stored, access, Date.now());
    if (!checked.changed) return checked.result;
    // Lazy cleanup races must re-read and decide inside one transaction.
    return this.mutate((current, now) => {
      const retry = applyCheckAccess(current, access, now);
      return { state: retry.state, result: retry.result, changed: retry.changed };
    });
  }
  beginRefresh(pair: LinkedPair) { return this.mutate((state, now) => applyBeginRefresh(state, pair, now)); }
  completeRefresh(input: { old: LinkedPair; next: LinkedPair }) { return this.mutate((state, now) => applyCompleteRefresh(state, input, now)); }
  abortRefresh(input: { pair: LinkedPair; terminal: boolean }) { return this.mutate((state, now) => applyAbortRefresh(state, input, now)); }
  revokeLinkedPairByAccess(pair: AccessDescriptorRef) { return this.mutate((state, now) => applyRevokeLinkedPairByAccess(state, pair, now)); }
  revokeExactLinkedPair(pair: LinkedPair) { return this.mutate((state, now) => applyRevokeExactLinkedPair(state, pair, now)); }
  async alarm() { await this.mutate((state, now) => {
    const next = cleanVnuRefreshState(state, now);
    return { state: next, result: undefined, changed: state !== undefined && !sameVnuRefreshState(state, next) };
  }); }
}
```

Every mutation receives a whole state snapshot and performs read plus transition inside one storage transaction. Every transition returns explicit `changed`; `mutate()` performs `put` and `setAlarm`/`deleteAlarm` only when `changed === true`. No-op branches return `changed:false` against the original stored snapshot and must not persist incidental lazy cleanup. Exact-pair activation repeats, duplicate/in-progress/rate-limited/revoked begins, late completion, absent lease abort, already-revoked revoke, fully expired-pair revoke, mismatch, and repeated alarm cleanup therefore cause zero `put`, `setAlarm`, and `deleteAlarm` calls. `checkAccess()` is deliberately different: a parsed active/nonexpired state returns after direct storage `get`; only an actual stale-state inequality retries cleanup through `mutate()`. No credential or identity field exists in the stored type. Parse corruption, direct read failure, cleanup transaction failure, alarm failure, and RPC rejection are caught by the coordinator and become the same sanitized `VNU_REFRESH_UNAVAILABLE`; none may fall back to cache.
Each exported transition validates every supplied `LinkedPair`/`AccessDescriptorRef` before reading or mutating state, as shown above.

Grant expiry controls refresh eligibility. `completeRefresh()` requires `next.grantExpiresAt === old.grantExpiresAt`; rotated access expiry follows current outward-session policy but cannot alter or extend the fixed eight-hour grant. Revoked access IDs are retained through their access expiry; revoked grant IDs through grant expiry.

- [ ] **Step 4: Run coordinator GREEN, then add RED real-Durable-Object Workers tests and implementation**

The Step 1 ordinary test must also contain these exact principal/privacy and fail-closed assertions; Step 3 implements them:

```ts
import { describe, expect, it, vi } from "vitest";
import { DurableObjectVnuRefreshControlCoordinator, deriveVnuRefreshPrincipal, vnuRefreshUnavailable } from "./vnu-refresh-control";

const SECRET = "synthetic-worker-secret-with-at-least-32-chars";

describe("VNU refresh coordinator", () => {
  it("derives a stable lowercase HMAC name without raw username", async () => {
    const first = await deriveVnuRefreshPrincipal(" SYNTHETIC-VNU-USER ", SECRET);
    const second = await deriveVnuRefreshPrincipal("synthetic-vnu-user", SECRET);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain("synthetic");
  });

  it("isolates principals and maps namespace rejection to sanitized 503", async () => {
    const getByName = vi.fn(() => ({ activatePair: vi.fn().mockRejectedValue(new Error("SENSITIVE-UPSTREAM-TEXT")) }));
    const coordinator = new DurableObjectVnuRefreshControlCoordinator({ getByName });
    await expect(coordinator.activatePair("a".repeat(64), {
      accessTokenId: "A".repeat(22), accessExpiresAt: 41,
      grantId: "B".repeat(22), grantExpiresAt: 42,
    })).rejects.toEqual(vnuRefreshUnavailable());
    expect(getByName).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
  });
});
```

Run:

```bash
pnpm --filter @hyeboard/worker exec vitest run src/vnu-refresh-control.test.ts
```

Expected after Step 3: PASS in ordinary Vitest with no Cloudflare module loaded.

The coordinator contracts in `apps/worker/src/vnu-refresh-control.ts` are:

```ts
import { deriveVnuRefreshPrincipal, HyeboardError } from "@hyeboard/core";
export { deriveVnuRefreshPrincipal } from "@hyeboard/core";
export interface VnuRefreshControlStub {
  activatePair(pair: LinkedPair): Promise<{ kind: "activated" }>;
  checkAccess(access: AccessDescriptorRef): Promise<AccessCheckResult>;
  beginRefresh(pair: LinkedPair): Promise<BeginRefreshResult>;
  completeRefresh(input: { old: LinkedPair; next: LinkedPair }): Promise<{ kind: "completed" } | { kind: "revoked" }>;
  abortRefresh(input: { pair: LinkedPair; terminal: boolean }): Promise<{ kind: "aborted" | "revoked" }>;
  revokeLinkedPairByAccess(pair: AccessDescriptorRef): Promise<{ kind: "revoked" | "mismatch" | "expired" }>;
  revokeExactLinkedPair(pair: LinkedPair): Promise<{ kind: "revoked" | "mismatch" | "expired" }>;
}

export interface VnuRefreshControlNamespace { getByName(name: string): VnuRefreshControlStub; }
export interface VnuRefreshControlCoordinator {
  activatePair(principalKey: string, pair: LinkedPair): Promise<void>;
  checkAccess(principalKey: string, access: AccessDescriptorRef): Promise<AccessCheckResult>;
  beginRefresh(principalKey: string, pair: LinkedPair): Promise<BeginRefreshResult>;
  completeRefresh(principalKey: string, input: { old: LinkedPair; next: LinkedPair }): Promise<"completed" | "revoked">;
  abortRefresh(principalKey: string, input: { pair: LinkedPair; terminal: boolean }): Promise<void>;
  revokeLinkedPairByAccess(principalKey: string, pair: AccessDescriptorRef): Promise<"revoked" | "mismatch" | "expired">;
  revokeExactLinkedPair(principalKey: string, pair: LinkedPair): Promise<"revoked" | "mismatch" | "expired">;
}

export function vnuRefreshUnavailable(): HyeboardError {
  return new HyeboardError("VNU_REFRESH_UNAVAILABLE", "VNU reconnect is temporarily unavailable. Try again.", 503, { retryAfterSeconds: 5 });
}

export class DurableObjectVnuRefreshControlCoordinator implements VnuRefreshControlCoordinator {
  constructor(private readonly namespace: VnuRefreshControlNamespace) {}
  private stub(principalKey: string): VnuRefreshControlStub {
    if (!/^[0-9a-f]{64}$/.test(principalKey)) throw vnuRefreshUnavailable();
    return this.namespace.getByName(principalKey);
  }
  private async call<T>(principalKey: string, operation: (stub: VnuRefreshControlStub) => Promise<T>): Promise<T> {
    try { return await operation(this.stub(principalKey)); } catch { throw vnuRefreshUnavailable(); }
  }
  activatePair(principalKey: string, pair: LinkedPair) { return this.call(principalKey, async (stub) => { await stub.activatePair(pair); }); }
  checkAccess(principalKey: string, access: AccessDescriptorRef) { return this.call(principalKey, (stub) => stub.checkAccess(access)); }
  beginRefresh(principalKey: string, pair: LinkedPair) { return this.call(principalKey, (stub) => stub.beginRefresh(pair)); }
  completeRefresh(principalKey: string, input: { old: LinkedPair; next: LinkedPair }) { return this.call(principalKey, async (stub) => (await stub.completeRefresh(input)).kind); }
  abortRefresh(principalKey: string, input: { pair: LinkedPair; terminal: boolean }) { return this.call(principalKey, async (stub) => { await stub.abortRefresh(input); }); }
  revokeLinkedPairByAccess(principalKey: string, pair: AccessDescriptorRef) { return this.call(principalKey, async (stub) => (await stub.revokeLinkedPairByAccess(pair)).kind); }
  revokeExactLinkedPair(principalKey: string, pair: LinkedPair) { return this.call(principalKey, async (stub) => (await stub.revokeExactLinkedPair(pair)).kind); }
}
```

`principalKey` is already HMAC-derived by core and must exactly match the descriptor. Coordinator methods accept that opaque key directly and validate `^[0-9a-f]{64}$`; manual issuance derives it once from normalized username. Do not HMAC the descriptor key again and do not pass raw username to RPC methods.

Create `apps/worker/test/vnu-refresh-control-durable-object.workers.ts` first. For the intentional RED state, add the `VnuRefreshControlDurableObject` export path to existing `apps/worker/test/captcha-relay-worker.ts`; add `VNU_REFRESH_CONTROL` with `className: "VnuRefreshControlDurableObject"` and `useSQLite: true` to existing `vitest.workers.config.ts`. Using `env`, `runInDurableObject`, and `reset`, test:

1. Concurrent activation/check is authoritative and stores one complete pair, never a half pair.
2. Concurrent refresh and logout produce either completed-next-pair or revoked-old-pair, never active old access with next grant or vice versa. Logout before completion defeats late completion; logout using an old descriptor after completed rotation is a mismatch and cannot revoke the new pair.
3. Exact descriptor identity matching: wrong principal namespace, wrong access ID, wrong grant ID, or wrong expiry returns nonactive/mismatch without changing either namespace. The matching complete pair is active.
4. Response-delivery loss after committed completion leaves old access and grant revoked and next pair active.
5. Storage entries and serialized RPC arguments contain no username, password, student code, cookie, raw access token, or synthetic identity sentinel.
6. Five-attempt window and two-minute lease remain atomic under concurrent calls.
7. `revokeLinkedPairByAccess()` with an exact active descriptor revokes that access ID and linked grant ID atomically; repeating it returns success with `changed:false`. A mismatched access/grant/expiry returns `mismatch` with `changed:false`. A complete authenticated pair whose access and grant expiries are both `<= now` returns `expired` with `changed:false`, including after lazy cleanup removed state. If either expiry remains live, absent/mismatched state is never treated as expired success. `revokeExactLinkedPair()` has the same exact-match boundary for a pre-lease cryptographically linked student-identity failure.
8. Storage instrumentation wraps `get`, `transaction`, transaction `put`, `setAlarm`, and `deleteAlarm` with exact counters. After activation, reset counters and call matching `checkAccess()` three times: expect `{get:3,transaction:0,put:0,setAlarm:0,deleteAlarm:0}` and unchanged alarm. Insert one expired revoked entry, reset counters, call once, and expect exactly one cleanup transaction, one `put`, and exactly one alarm operation; the next active check adds one `get` and zero writes/alarm changes. Add an exact access-before-grant-expiry case: seed an active pair with `accessExpiresAt <= now < grantExpiresAt`, no lease/revocations, and `window.resetAt > grantExpiresAt`; seed its alarm to exactly `grantExpiresAt`. Two matching `checkAccess()` calls each return `{ kind: "revoked" }`; together they produce exactly `{get:2,transaction:0,put:0,setAlarm:0,deleteAlarm:0}`, preserve byte-identical state, and leave `getAlarm()` equal to `grantExpiresAt`. Advance the Workers test clock to exactly `grantExpiresAt` without sleeping or polling, deliver `alarm()`, and assert exactly one transaction `put`, active-pair removal, and one alarm update (`setAlarm` for another remaining candidate or `deleteAlarm` when none remains). Re-delivering cleanup asserts zero further `put`, `setAlarm`, or `deleteAlarm`. For every mutating RPC, separately instrument exact-active change and these no-ops: same-pair activation, duplicate begin, rate-limited begin, late complete, absent-lease abort, mismatched revoke, repeated revoke, already-revoked pair, and fully expired pair before/after lazy cleanup. Every no-op must assert `put:0,setAlarm:0,deleteAlarm:0` and unchanged stored bytes/alarm; changed cases assert exactly `put:1` and exactly one of `setAlarm:1`/`deleteAlarm:1`.
9. Seed malformed stored state and separately inject direct `get`, transaction, `put`, alarm, and namespace/RPC failures. Through `DurableObjectVnuRefreshControlCoordinator`, each rejects with exact sanitized `vnuRefreshUnavailable()`, with no stored/provided sentinel in message, details, or logs.

Use an explicit instrumented storage adapter rather than wall-clock inference. Add this test contract to `vnu-refresh-control.ts`; the Cloudflare-only file supplies the real adapter, while ordinary Vitest supplies a counting fake and therefore never imports `cloudflare:workers`:

```ts
export interface VnuRefreshControlStorage {
  get(): Promise<unknown>;
  transaction<T>(body: (stored: unknown, put: (state: VnuRefreshControlState) => Promise<void>, setAlarm: (at: number | undefined) => Promise<void>) => Promise<T>): Promise<T>;
}

export function nextVnuRefreshAlarm(state: VnuRefreshControlState): number | undefined {
  const values = [
    ...Object.values(state.revokedAccess),
    ...Object.values(state.revokedGrants),
    // Access expiry changes authorization immediately but does not remove the
    // active link. Scheduling it would consume the one-shot alarm without a
    // state change and lose the required grant-expiry cleanup alarm.
    state.active?.grantExpiresAt,
    state.lease?.expiresAt,
    state.window.resetAt,
  ].filter((value): value is number => typeof value === "number");
  return values.length ? Math.min(...values) : undefined;
}

export async function checkAccessAuthoritatively(
  storage: VnuRefreshControlStorage,
  access: AccessDescriptorRef,
  now: number,
): Promise<AccessCheckResult> {
  const stored = parseVnuRefreshControlState(await storage.get());
  const checked = applyCheckAccess(stored, access, now);
  if (!checked.changed) return checked.result;
  return storage.transaction(async (raw, put, setAlarm) => {
    const retry = applyCheckAccess(parseVnuRefreshControlState(raw), access, now);
    if (retry.changed) {
      await put(retry.state);
      await setAlarm(nextVnuRefreshAlarm(retry.state));
    }
    return retry.result;
  });
}
```

Add this exact ordinary unit case beside the transition tests. It proves access expiry is a read-only authorization boundary while grant expiry remains the active-link cleanup boundary:

```ts
it("retains the grant-expiry alarm after access expiry", () => {
  const ACCESS_EXPIRY = NOW + 1_000;
  const GRANT_EXPIRY = NOW + 2_000;
  const pair: LinkedPair = {
    accessTokenId: "E".repeat(22),
    accessExpiresAt: ACCESS_EXPIRY,
    grantId: "F".repeat(22),
    grantExpiresAt: GRANT_EXPIRY,
  };
  const stored: VnuRefreshControlState = {
    active: pair,
    revokedAccess: {},
    revokedGrants: {},
    window: { count: 0, resetAt: GRANT_EXPIRY + 1_000 },
  };

  expect(nextVnuRefreshAlarm(stored)).toBe(GRANT_EXPIRY);
  const first = applyCheckAccess(stored, pair, ACCESS_EXPIRY);
  expect(first).toEqual({ state: stored, result: { kind: "revoked" }, changed: false });
  const second = applyCheckAccess(first.state, pair, ACCESS_EXPIRY + 1);
  expect(second).toEqual({ state: stored, result: { kind: "revoked" }, changed: false });
  expect(nextVnuRefreshAlarm(second.state)).toBe(GRANT_EXPIRY);

  const cleaned = cleanVnuRefreshState(second.state, GRANT_EXPIRY);
  expect(cleaned.active).toBeUndefined();
  expect(sameVnuRefreshState(second.state, cleaned)).toBe(false);
});
```

The real adapter maps `setAlarm(undefined)` to `transaction.deleteAlarm()` and a numeric value to `transaction.setAlarm(value)`. Active steady checks and all explicit no-op mutation results never invoke either. The counting fake records `get`, outer `transaction`, callback `put`, `setAlarm`, and `deleteAlarm` independently. Assert transition `changed` against exact state equality in ordinary tests, then assert storage-call counts in real-Durable-Object tests; result-kind equality alone is insufficient.

The Workers test uses entered-operation promises/barriers for races. No `setTimeout`, fake timing sleep, or polling loop.

Run RED:

```bash
pnpm --filter @hyeboard/worker test:workers
```

Expected: FAIL because `vnu-refresh-control-durable-object.ts`/exported class does not exist. Then create that file from the Step 3 snippet, keeping `cloudflare:workers` confined there, and rerun `test:workers` GREEN.

- [ ] **Step 5: Wire Cloudflare binding/migration and self-host fail-closed default**

In `apps/worker/src/index.ts`, export `VnuRefreshControlDurableObject`, construct `DurableObjectVnuRefreshControlCoordinator(cfEnv.VNU_REFRESH_CONTROL)`, and pass it to new `setVnuRefreshControlCoordinator()`.

Add binding after `VNU_PROBE_BUDGET` in `apps/worker/wrangler.jsonc`:

```json
{
  "name": "VNU_REFRESH_CONTROL",
  "class_name": "VnuRefreshControlDurableObject"
}
```

Append migration after `v2`; never edit prior tags:

```json
{
  "tag": "v3",
  "new_sqlite_classes": ["VnuRefreshControlDurableObject"]
}
```

In `apps/worker/src/app.ts` add an optional coordinator plus fail-closed accessor:

```ts
let vnuRefreshControlCoordinator: VnuRefreshControlCoordinator | undefined;

export function setVnuRefreshControlCoordinator(coordinator: VnuRefreshControlCoordinator | undefined): void {
  vnuRefreshControlCoordinator = coordinator;
}

function requireVnuRefreshControlCoordinator(): VnuRefreshControlCoordinator {
  if (!vnuRefreshControlCoordinator) throw vnuRefreshUnavailable();
  return vnuRefreshControlCoordinator;
}
```

Do not edit `apps/worker/src/start.ts` or `apps/worker/src/index.node.ts`: both already consume `app.ts` and leave the coordinator undefined. Manual login explicitly branches on coordinator presence: undefined Node/Bun mode returns existing access-only session response with no descriptor/grant and no automatic refresh; configured Cloudflare mode requires atomic activation and propagates real coordinator outages. Existing legacy/non-refresh-linked VNU session resolution and best-effort cache revocation behavior remain unchanged. Never claim exact revocation for those tokens. Any descriptor-bearing token presented to self-host ordinary session resolution calls the required accessor and fails closed with sanitized `VNU_REFRESH_UNAVAILABLE`; self-host must not issue such tokens.

Regenerate types; never hand-edit generated body:

```bash
pnpm --filter @hyeboard/worker exec wrangler types
```

Expected header hash changes; `Env` contains `VNU_REFRESH_CONTROL`; durable namespace union contains `VnuRefreshControlDurableObject`.

- [ ] **Step 6: Run GREEN, migration checks, and independent typecheck**

```bash
pnpm --filter @hyeboard/worker exec vitest run src/vnu-refresh-control.test.ts
pnpm --filter @hyeboard/worker test:workers
pnpm --filter @hyeboard/worker typecheck
```

Expected: all focused tests PASS; both Worker and Node TypeScript builds exit `0`. Verify `wrangler.jsonc` migration order is `v1`, `v2`, `v3`.

- [ ] **Step 7: Commit Task 2 only**

```bash
git add apps/worker/src/vnu-refresh-control.ts apps/worker/src/vnu-refresh-control.test.ts apps/worker/src/vnu-refresh-control-durable-object.ts apps/worker/test/vnu-refresh-control-durable-object.workers.ts apps/worker/test/captcha-relay-worker.ts apps/worker/vitest.workers.config.ts apps/worker/src/app.ts apps/worker/src/index.ts apps/worker/wrangler.jsonc apps/worker/worker-configuration.d.ts
git diff --cached --check
git commit -m "feat(worker): add authoritative VNU refresh control"
```

---

### Task 3: Split Recoverability and Issue Grants Only After Verified Identity

**Files:**
- Modify: `packages/schemas/src/index.ts:237-276`
- Modify: `packages/university-adapters/src/vnu/adapter.ts:61-86`
- Modify: `apps/worker/src/app.ts:218-271,339-369,599-672,718-770,852-974`
- Modify: `apps/worker/src/app.test.ts:1-214,421-769`
- Modify: `apps/worker/src/vnu-student-id-resolver.test.ts:400-430`

- [ ] **Step 1: Write RED schema and Worker classification tests**

Add these exact assertions to `apps/worker/src/app.test.ts` using existing `app`, token helpers, and synthetic constants:

```ts
it("marks only missing VNU credential as recoverable", async () => {
  const token = await encryptSession({ ...normalizedVnuSession(), vnu: undefined }, SESSION_SECRET);
  const response = await getVnuRawPage(app, token, "grades");
  await expect(response.json()).resolves.toEqual({
    data: null,
    error: {
      code: "VNU_LOGIN_REQUIRED",
      message: "VNU data needs an active university portal credential.",
      details: { reason: "MISSING_VNU_CREDENTIAL" },
    },
  });
});

it.each(["missing internal student id", "missing internal university id", "missing required student code"])("returns VNU_PROFILE_INCOMPLETE for %s", async () => {
  const error = new HyeboardError("VNU_PROFILE_INCOMPLETE", "The university portal profile is incomplete.", 500);
  profileSpy.mockRejectedValueOnce(error);
  const response = (createApp(undefined) as ReturnType<typeof createApp>).handle(new Request("http://localhost/api/vnu/raw/exams?vTermID=SYNTHETIC-TERM", {
    headers: { Authorization: `Bearer ${await encryptSession(normalizedVnuSession(), SESSION_SECRET)}` },
  }));
  const resolved = await response;
  const text = await resolved.text();
  expect(resolved.status).toBe(500);
  expect(JSON.parse(text)).toMatchObject({ data: null, error: { code: "VNU_PROFILE_INCOMPLETE" } });
  expect(text).not.toContain("MISSING_VNU_CREDENTIAL");
  expect(text).not.toContain(VNU_STUDENT_CODE);
});

it("manual VNU login returns token and grant only after verified identity", async () => {
  const response = await requestVnuImport(app);
  const body = await response.json() as { data: VnuImportResponse & { refreshGrant: string }; error: null };
  expect(response.status).toBe(200);
  expect(Object.keys(body.data).sort()).toEqual(["refreshGrant", "session", "token"]);
  expect(body.data.refreshGrant).not.toBe(body.data.token);
  const grant = await decryptVnuRefreshGrant(body.data.refreshGrant, SESSION_SECRET, syntheticTime);
  expect(grant.expectedStudentCode).toBe(VNU_STUDENT_CODE);
  expect(grant.username).toBe("synthetic_vnu_user");
  expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
});

it("cache hit uses submitted credentials only after live identity verification", async () => {
  const first = await requestVnuImport(app);
  expect(first.status).toBe(200);
  profileSpy.mockClear();
  const second = await requestVnuImport(app);
  const body = await second.json() as { data: VnuImportResponse & { refreshGrant: string } };
  expect(profileSpy).toHaveBeenCalledTimes(1);
  expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
  const grant = await decryptVnuRefreshGrant(body.data.refreshGrant, SESSION_SECRET, syntheticTime);
  expect(grant.password).toBe("SYNTHETIC_VNU_PASSWORD");
  expect(grant.expectedStudentCode).toBe(VNU_STUDENT_CODE);
});
```

For coordinator-enabled import tests, update `VnuImportResponse` to require `refreshGrant: string`. Import `decryptVnuRefreshGrant`, `decryptSession`, and a fake `VnuRefreshControlCoordinator` that records atomic `activatePair()` calls. Assert decrypted token descriptor exactly matches the activated pair and decrypted grant ID. Do not use numeric identity-shaped fixtures.

Also add app tests proving: descriptor-bearing ordinary VNU requests decrypt first, then call authoritative `checkAccess()` with the exact descriptor-derived principal, access ID, grant ID, access expiry, and grant expiry and proceed only for `active`; wrong namespace/ID/link/expiry returns session death without upstream access or mutation; coordinator rejection returns sanitized `VNU_REFRESH_UNAVAILABLE` and no upstream call. Three repeated active requests assert the instrumented authority records zero transaction `put` and zero alarm changes. One stale cleanup request writes once, and the following check returns to zero writes. Corrupted state, storage failures, and RPC rejection all return the same sanitized unavailable response. Legacy VNU tokens without descriptors never call coordinator, retain existing session/cache behavior, and cannot receive or trigger automatic refresh. A self-host/unavailable coordinator manual login returns access-only auth and does not falsely claim grant support. All fixtures must use conspicuous `SYNTHETIC-*` values.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @hyeboard/worker exec vitest run src/app.test.ts -t "missing VNU credential|VNU_PROFILE_INCOMPLETE|manual VNU login|cache hit uses submitted"
```

Expected: FAIL because details are absent, profile errors still use old classification in raw helpers, and import response lacks `refreshGrant`.

- [ ] **Step 3: Add typed sanitized JSON wire contracts without narrowing internal errors**

Add to `packages/schemas/src/index.ts`:

```ts
export const apiErrorDetailsSchema = z.object({
  reason: z.literal("MISSING_VNU_CREDENTIAL").optional(),
  retryAfterSeconds: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  windowSeconds: z.number().int().positive().optional(),
}).strict();

export const authResultSchema = z.object({
  token: z.string().min(1),
  refreshGrant: z.string().min(1).optional(),
  session: authSessionSchema,
});

export type ApiErrorDetails = z.infer<typeof apiErrorDetailsSchema>;
export type AuthResult = z.infer<typeof authResultSchema>;
```

Change `apiErrorSchema.details` from `z.unknown().optional()` to `apiErrorDetailsSchema.optional()` for parsed JSON wire responses. Keep `HyeboardError.details`, core `fail()` input, and internal `errorPayload()` details typed as `unknown`; do not globally narrow internal errors. At every JSON response boundary in `apps/worker/src/app.ts`, call `apiErrorDetailsSchema.safeParse(error.details)` and include `details` only when parsing succeeds. Invalid/extra-key details become `undefined`, never a partially stripped object.

Add `routeError()` tests for an allowlisted detail object, a mixed object with one private extra key, arbitrary upstream prose/object, and circular/non-object values. Assert JSON includes only a fully valid details object, responses never contain private sentinels, and new VNU logs contain operation, code, and status only—never `error.message`, upstream prose, `err`, request/body IDs, token, grant, HMAC principal, username, student code, profile, or cookie. Replace current VNU-path `log[level](..., error.message)` calls accordingly; do not broaden this change to unrelated UET automation logging beyond ensuring new VNU logs obey the stable-field rule.

Scope sanitized details to JSON only. VNU refresh/import/logout are JSON routes and must not use SSE. Do not modify `apps/web/src/lib/uet-session-stream.ts`, its tests, or UET SSE serialization/consumption; existing UET SSE behavior remains byte-for-byte outside shared unrelated formatting.

- [ ] **Step 4: Implement exact classification and verified grant issuance**

Add helpers in `apps/worker/src/app.ts`:

```ts
const MISSING_VNU_CREDENTIAL_DETAILS = { reason: "MISSING_VNU_CREDENTIAL" } as const;

function missingVnuCredential(): HyeboardError {
  return new HyeboardError("VNU_LOGIN_REQUIRED", "VNU data needs an active university portal credential.", 401, MISSING_VNU_CREDENTIAL_DETAILS);
}

function incompleteVnuProfile(): HyeboardError {
  return new HyeboardError("VNU_PROFILE_INCOMPLETE", "The university portal profile is incomplete.", 500);
}

async function issueVerifiedVnuArtifacts(input: {
  session: EncryptedSessionPayload;
  username: string;
  password: string;
  studentCode: string;
}) {
  const secret = getSessionSecret();
  if (!vnuRefreshControlCoordinator) {
    return {
      token: await encryptSession(input.session, secret),
      session: { universityId: "vnu", studentCode: input.studentCode, expiresAt: input.session.expiresAt, authenticated: true as const },
    };
  }
  const grantPayload = createVnuRefreshGrant({
    username: input.username,
    password: input.password,
    expectedStudentCode: input.studentCode,
  });
  const descriptor = await createVnuRefreshAccessDescriptor({
    username: grantPayload.username,
    grantId: grantPayload.grantId,
    accessExpiresAt: input.session.expiresAt,
    grantExpiresAt: grantPayload.expiresAt,
    secret,
  });
  const session = { ...input.session, vnuRefresh: descriptor };
  const pair = {
    accessTokenId: descriptor.accessTokenId,
    accessExpiresAt: Date.parse(descriptor.accessExpiresAt),
    grantId: descriptor.grantId,
    grantExpiresAt: Date.parse(descriptor.grantExpiresAt),
  };
  const token = await encryptSession(session, secret);
  const refreshGrant = await encryptVnuRefreshGrant(grantPayload, secret);
  await requireVnuRefreshControlCoordinator().activatePair(descriptor.principalKey, pair);
  return {
    token,
    refreshGrant,
    session: { universityId: "vnu", studentCode: input.studentCode, expiresAt: input.session.expiresAt, authenticated: true as const },
  };
}
```

Replace every missing `session.vnu?.value` branch in VNU raw/probe helpers with `throw missingVnuCredential()`. Replace missing/malformed own internal student ID, internal university ID, and required student code branches with `throw incompleteVnuProfile()`. Preserve `VNU_SESSION_EXPIRED` from live/cache expiry detection.

Refactor ordinary `getSession()`/`resolveSession()` validation for descriptor-bearing VNU tokens in this exact order: (1) ordinary `decryptSession()` validates AEAD, exact shape, canonical descriptor expiries, descriptor access expiry equality, and unexpired outer token; (2) validate descriptor/session identity invariants; (3) reconstruct the full `AccessDescriptorRef` solely from descriptor fields and call `checkAccess(principalKey,accessDescriptorRef)`; (4) proceed to cache/upstream resolution only for `active`. DO outage returns `VNU_REFRESH_UNAVAILABLE`; revoked/nonactive descriptor returns `SESSION_EXPIRED`. The steady active check is read-only. Never consult fail-open cache revocation for descriptor-bearing tokens. Tokens without `vnuRefresh` keep the existing path and cannot auto-refresh.

For manual import:

1. Normalize username once with `body.vnuUsername.trim().toLowerCase()` before cache key and adapter call.
2. Keep submitted plaintext request-local on both cache miss and hit.
3. Cache miss: adapter login, normalize `session.studentCode`, require nonempty verified identity, cache only encrypted session seed and summary, then call `issueVerifiedVnuArtifacts()`.
4. Cache hit: perform current live profile fetch first; only when live identity equals cached payload and summary call `issueVerifiedVnuArtifacts()` using submitted username/password. If live identity is missing/mismatched, perform a fresh adapter login and verify again.
5. Registering a manual grant replaces/revokes the prior active grant through Task 2 before response.
6. In Cloudflare/coordinator mode, one `activatePair()` transaction commits access ID and grant ID together before either encrypted artifact is returned. If activation fails, return `VNU_REFRESH_UNAVAILABLE`; do not return access token alone.
7. In Node/Bun unavailable-default mode, preserve manual login's current access-only response: omit `refreshGrant`, omit descriptor, perform no coordinator call, and advertise no automatic refresh. This explicit degradation preserves existing VNU sessions but provides no exact coordinator revocation claim.

Update the existing `importVnu()` test helper's key assertion from `["session", "token"]` to `["refreshGrant", "session", "token"]`. In every VNU import-suite `beforeEach`, install a fresh fake coordinator; otherwise Task 2's self-host-style unavailable default correctly makes manual VNU login fail closed.

Update `packages/university-adapters/src/vnu/adapter.ts` to pass `input.vnuUsername.trim().toLowerCase()` to `DaotaoClient.login()`. Keep password byte-for-byte unchanged.

Update JSON `routeError()`/JSON helpers to include only `safeParse()`-accepted `ApiErrorDetails`. Keep `errorPayload()` and SSE behavior unchanged. Change VNU route logging to a constant message such as `"VNU request failed"` with stable fields only.

- [ ] **Step 5: Run focused GREEN and package checks**

```bash
pnpm --filter @hyeboard/worker exec vitest run src/app.test.ts src/vnu-student-id-resolver.test.ts
pnpm --filter @hyeboard/schemas test
pnpm --filter @hyeboard/core test
pnpm --filter @hyeboard/university-adapters test
pnpm --filter @hyeboard/worker typecheck
```

Expected: PASS. Existing expiry tests still assert `VNU_SESSION_EXPIRED`; structural errors assert `VNU_PROFILE_INCOMPLETE`; only missing VNU credential includes exact reason.

- [ ] **Step 6: Commit Task 3 only**

```bash
git add packages/schemas/src/index.ts packages/university-adapters/src/vnu/adapter.ts apps/worker/src/app.ts apps/worker/src/app.test.ts apps/worker/src/vnu-student-id-resolver.test.ts
git diff --cached --check
git commit -m "feat(worker): issue verified VNU refresh grants"
```

---

### Task 4: Add Refresh and Race-Safe Logout Routes

**Files:**
- Modify: `apps/worker/src/app.ts:146-255,257-271,939-1008`
- Modify: `apps/worker/src/app.test.ts:1-214,421-1000`

- [ ] **Step 1: Write RED route matrix**

Add helpers and table tests in `apps/worker/src/app.test.ts`:

```ts
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
    body: JSON.stringify(refreshGrant ? { refreshGrant } : {}),
  }));
}

it("refresh validates outer token and identity before upstream login", async () => {
  const imported = await importVnu(app);
  const importedPayload = await decryptSession(imported.token, SESSION_SECRET);
  const other = await encryptSession({ ...importedPayload, studentCode: "OTHER-SYNTHETIC-STUDENT" }, SESSION_SECRET);
  const response = await requestVnuRefresh(app, other, imported.refreshGrant);
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({ data: null, error: { code: "VNU_REFRESH_IDENTITY_MISMATCH" } });
  expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
});

it("refresh rotates access and grant while preserving original grant expiry", async () => {
  const imported = await importVnu(app);
  const before = await decryptVnuRefreshGrant(imported.refreshGrant, SESSION_SECRET, syntheticTime);
  adapterMocks.importSession.mockResolvedValueOnce(importedVnu({ ...vnuSession(), vnu: { kind: "cookie", value: "SYNTHETIC-ROTATED-COOKIE" } }));
  const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
  const body = await response.json() as { data: VnuImportResponse; error: null };
  const after = await decryptVnuRefreshGrant(body.data.refreshGrant, SESSION_SECRET, syntheticTime + 1);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(body.data.token).not.toBe(imported.token);
  expect(body.data.refreshGrant).not.toBe(imported.refreshGrant);
  expect(after.grantId).not.toBe(before.grantId);
  expect(after.expiresAt).toBe(before.expiresAt);
  expect(after.issuedAt).toBe(before.issuedAt);
  expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
});

it.each([
  ["VNU_RATE_LIMITED", 429],
  ["VNU_UPSTREAM_UNAVAILABLE", 502],
  ["VNU_REQUEST_FAILED", 502],
])("aborts lease retryably for %s", async (code, status) => {
  const imported = await importVnu(app);
  adapterMocks.importSession.mockRejectedValueOnce(new HyeboardError(code, "SYNTHETIC-UPSTREAM-PROSE", status));
  const failed = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
  expect(failed.status).toBe(status);
  adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
  const retry = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
  expect(retry.status).toBe(200);
});

it.each(["INVALID_VNU_CREDENTIAL", "VNU_REFRESH_IDENTITY_MISMATCH"])("revokes grant on terminal %s", async (code) => {
  const imported = await importVnu(app);
  adapterMocks.importSession.mockRejectedValueOnce(new HyeboardError(code, "SYNTHETIC-TERMINAL", code === "INVALID_VNU_CREDENTIAL" ? 401 : 409));
  await requestVnuRefresh(app, imported.token, imported.refreshGrant);
  const retry = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
  expect(retry.status).toBe(401);
  await expect(retry.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_GRANT_REVOKED" } });
});

it("logout revokes token and grant idempotently and defeats late completion", async () => {
  const imported = await importVnu(app);
  const first = await requestVnuLogout(app, imported.token, imported.refreshGrant);
  const second = await requestVnuLogout(app, imported.token, imported.refreshGrant);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.headers.get("Cache-Control")).toBe("no-store");
  const refresh = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
  expect(refresh.status).toBe(401);
  expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
});

it("logs out from an authenticated descriptor alone after the tab grant is absent and the access token expired", async () => {
  const imported = await importVnu(app, { accessExpiresAt: syntheticTime - 1 });
  const revokeLinkedPairByAccess = vi.spyOn(refreshControl, "revokeLinkedPairByAccess").mockResolvedValue("revoked");
  const response = await requestVnuLogout(app, imported.token);
  expect(response.status).toBe(200);
  const payload = await decryptSessionForVnuLogout(imported.token, SESSION_SECRET);
  expect(revokeLinkedPairByAccess).toHaveBeenCalledWith(payload.vnuRefresh!.principalKey, {
    accessTokenId: payload.vnuRefresh!.accessTokenId,
    accessExpiresAt: Date.parse(payload.vnuRefresh!.accessExpiresAt),
    grantId: payload.vnuRefresh!.grantId,
    grantExpiresAt: Date.parse(payload.vnuRefresh!.grantExpiresAt),
  });
});

it("validates an optional logout grant completely before authoritative revoke", async () => {
  const left = await importVnu(app);
  const right = await importSecondSyntheticVnu(app);
  const revoke = vi.spyOn(refreshControl, "revokeLinkedPairByAccess");
  const wrongPrincipal = await requestVnuLogout(app, left.token, right.refreshGrant);
  expect(wrongPrincipal.status).toBe(409);
  expect(revoke).toHaveBeenCalledTimes(0);

  const wrongLink = await encryptGrantWithChangedGrantId(left.refreshGrant);
  const wrongLinkResponse = await requestVnuLogout(app, left.token, wrongLink);
  expect(wrongLinkResponse.status).toBe(409);
  expect(revoke).toHaveBeenCalledTimes(0);

  const malformed = await requestVnuLogout(app, left.token, "not-a-grant");
  expect(malformed.status).toBe(401);
  expect(revoke).toHaveBeenCalledTimes(0);

  const matching = await requestVnuLogout(app, left.token, left.refreshGrant);
  expect(matching.status).toBe(200);
  expect(revoke).toHaveBeenCalledTimes(1);
});

it("accepts an authenticated fully expired descriptor after lazy state cleanup without writing", async () => {
  const imported = await importVnu(app, { accessExpiresAt: syntheticTime - 2, grantExpiresAt: syntheticTime - 1 });
  await refreshControlTestHarness.runAlarmAt(syntheticTime); // removes the complete expired pair
  refreshControlTestHarness.resetStorageCounts();
  const response = await requestVnuLogout(app, imported.token); // new-tab/access-only body
  expect(response.status).toBe(200);
  expect(refreshControl.revokeLinkedPairByAccess).toHaveBeenCalledTimes(1);
  expect(refreshControlTestHarness.storageCounts()).toEqual({ put: 0, setAlarm: 0, deleteAlarm: 0 });
});

it("does not convert a live-half or unauthenticated mismatch into expired logout success", async () => {
  const accessExpiredGrantLive = await importVnu(app, { accessExpiresAt: syntheticTime - 1, grantExpiresAt: syntheticTime + 60_000 });
  refreshControl.revokeLinkedPairByAccess.mockResolvedValueOnce("mismatch");
  expect((await requestVnuLogout(app, accessExpiredGrantLive.token)).status).toBe(401);
  expect((await requestVnuLogout(app, "tampered.authenticated-token-shape")).status).toBe(401);
});

it("rejects principal or grant-link mismatch without authority mutation", async () => {
  const left = await importVnu(app);
  const right = await importSecondSyntheticVnu(app);
  const revokeExact = vi.spyOn(refreshControl, "revokeExactLinkedPair");
  const begin = vi.spyOn(refreshControl, "beginRefresh");
  const response = await requestVnuRefresh(app, left.token, right.refreshGrant);
  expect(response.status).toBe(409);
  expect(revokeExact).not.toHaveBeenCalled();
  expect(begin).not.toHaveBeenCalled();
  await expect(requestVnuRefresh(app, left.token, left.refreshGrant)).resolves.toMatchObject({ status: 200 });
});

it("revokes only its exact cryptographically linked pair for pre-lease student identity mismatch", async () => {
  const imported = await importVnu(app);
  const linkedWrongStudentToken = await reencryptLinkedTokenWithStudentCode(imported.token, "OTHER-SYNTHETIC-STUDENT");
  const revokeExact = vi.spyOn(refreshControl, "revokeExactLinkedPair").mockResolvedValue("revoked");
  const response = await requestVnuRefresh(app, linkedWrongStudentToken, imported.refreshGrant);
  expect(response.status).toBe(409);
  expect(revokeExact).toHaveBeenCalledTimes(1);
  expect(refreshControl.beginRefresh).not.toHaveBeenCalled();
  expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
});

it("distinguishes expired logout from expired refresh without loosening ordinary access", async () => {
  const imported = await importVnu(app, { accessExpiresAt: syntheticTime - 1, grantExpiresAt: syntheticTime + 60_000 });
  expect((await requestVnuLogout(app, imported.token)).status).toBe(200);
  expect((await getVnuRawPage(app, imported.token, "grades")).status).toBe(401);
  const second = await importVnu(app, { accessExpiresAt: syntheticTime - 1, grantExpiresAt: syntheticTime + 60_000 });
  expect((await requestVnuRefresh(app, second.token, second.refreshGrant)).status).toBe(200);
  const expiredGrant = await importVnu(app, { accessExpiresAt: syntheticTime - 1, grantExpiresAt: syntheticTime - 1 });
  expect((await requestVnuRefresh(app, expiredGrant.token, expiredGrant.refreshGrant)).status).toBe(401);
});

it("logout before lease completion revokes the exact pair and blocks late rotation", async () => {
  const imported = await importVnu(app);
  const gate = enteredPromise<void>();
  adapterMocks.importSession.mockImplementationOnce(async () => { gate.enter(); await gate.release; return importedVnu(); });
  const refreshing = requestVnuRefresh(app, imported.token, imported.refreshGrant);
  await gate.entered;
  const logout = await requestVnuLogout(app, imported.token);
  gate.resolve();
  const late = await refreshing;
  expect(logout.status).toBe(200);
  expect(late.status).toBe(401);
  expect(refreshControl.revokeLinkedPairByAccess).toHaveBeenCalledTimes(1);
  expect(refreshControl.completeRefresh).toHaveBeenCalledTimes(1);
  expect(adapterMocks.importSession).toHaveBeenCalledTimes(2); // initial import + one refresh login
});
```

`enteredPromise()` is a local deferred with `{entered,enter,release,resolve}`; it contains no timer. Add the inverse race: hold logout after descriptor validation, allow `completeRefresh()` first, then release old-descriptor logout. Assert old logout does not revoke the new pair, new access resolves, and counters remain exactly one login, one complete, one old logout RPC, zero cache revocations.

Also add tests for malformed body `400`, invalid/expired/wrong-purpose grant `401` without adapter login, and this exact validation matrix:

- Refresh order is access-token AEAD/shape decode via `decryptSessionForVnuRefresh()`, then descriptor/grant identity match, then authoritative DO `beginRefresh()`, then upstream login. Spies prove no later stage runs after an earlier failure.
- Outer token whose Hyeboard `expiresAt` is past is accepted only by `/api/vnu/auth/refresh` when descriptor and grant remain valid and linked; the same token through ordinary `resolveSession()` still returns `SESSION_EXPIRED`. Expired upstream cookie alone remains accepted. Tampered/invalid/wrong-purpose outward tokens never reach DO.
- Principal mismatch or grant-link mismatch between token descriptor and decrypted grant returns `VNU_REFRESH_IDENTITY_MISMATCH`, performs **no** authority mutation, and never logs in upstream. This prevents one principal's artifact from revoking another principal.
- After cryptographic principal/grant linkage is established but before lease, student identity mismatch calls dedicated authoritative `revokeExactLinkedPair(principalKey,oldPair)`. Authority revokes only when all four pair fields exactly match current active state; `mismatch` means no mutation. After lease, a live profile student mismatch uses `abortRefresh({terminal:true})`, which revokes only the leased exact pair.
- Coordinator outage at access check/begin/complete/revoke returns sanitized `503` and fails closed. Descriptor-bearing ordinary requests do not fall back to cache revocation checks.
- Legacy/non-refresh-linked VNU tokens keep existing ordinary behavior but refresh returns `VNU_REFRESH_GRANT_INVALID` without adapter login; Node/self-host unavailable mode has no grant/auto-refresh.
- Begin in-progress and five-attempt `429` details are exactly `{retryAfterSeconds,limit,windowSeconds}` after JSON-boundary sanitization.
- Two concurrent refreshes cause one adapter login; response delivery loss after committed completion leaves old access ID and grant ID revoked and next pair active.
- Cancellation before complete causes retryable abort. Stable logs/responses exclude synthetic private sentinels.
- Atomic logout-versus-refresh races test both legal orderings: exact descriptor logout first defeats late completion; complete first makes subsequent old-descriptor logout an idempotent/mismatch success that does not revoke the newly active pair. A logout carrying the new descriptor revokes the new pair.
- Access-only/new-tab expiry cleanup is safe only for a cryptographically authenticated, exact-shape descriptor whose `accessExpiresAt <= now` **and** `grantExpiresAt <= now`. The route still calls `revokeLinkedPairByAccess`; authority may return `expired` with zero writes after state disappeared. If either expiry is live, `mismatch` is an error, never idempotent success. Tampered tokens, malformed descriptors, noncanonical expiries, wrong purpose, optional-grant principal mismatch, optional-grant ID mismatch, and optional-grant expiry mismatch all fail before authority mutation.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @hyeboard/worker exec vitest run src/app.test.ts -t "refresh|logout revokes token and grant"
```

Expected: FAIL with route `404` and missing `Cache-Control: no-store`.

- [ ] **Step 3: Implement strict route helpers**

Add schemas:

```ts
const vnuRefreshBody = t.Object({ refreshGrant: t.String({ minLength: 1, maxLength: 8192 }) }, { additionalProperties: false });
const vnuLogoutBody = t.Object({ refreshGrant: t.Optional(t.String({ minLength: 1, maxLength: 8192 })) }, { additionalProperties: false });
```

Add helpers with these exact semantics:

```ts
function ensureVnuIdentityMatch(session: EncryptedSessionPayload, grant: VnuRefreshGrantPayload): void {
  if (session.universityId !== "vnu" || !session.studentCode || session.studentCode !== grant.expectedStudentCode) {
    throw new HyeboardError("VNU_REFRESH_IDENTITY_MISMATCH", "The VNU reconnect identity did not match the signed-in account.", 409);
  }
}

function beginResultError(result: BeginRefreshResult): never {
  if (result.kind === "revoked") throw new HyeboardError("VNU_REFRESH_GRANT_REVOKED", "The VNU reconnect grant has been revoked.", 401);
  if (result.kind === "in-progress") throw new HyeboardError("VNU_REFRESH_UNAVAILABLE", "VNU reconnect is already in progress. Try again shortly.", 503, { retryAfterSeconds: result.retryAfterSeconds });
  if (result.kind === "rate-limited") throw new HyeboardError("VNU_REFRESH_RATE_LIMITED", "Too many VNU reconnect attempts. Wait and try again.", 429, {
    retryAfterSeconds: result.retryAfterSeconds,
    limit: result.limit,
    windowSeconds: result.windowSeconds,
  });
  throw new Error("Accepted refresh result cannot be converted to an error");
}

function isTerminalVnuRefreshFailure(error: unknown): boolean {
  return error instanceof HyeboardError && (error.code === "INVALID_VNU_CREDENTIAL" || error.code === "VNU_REFRESH_IDENTITY_MISMATCH");
}
```

Implement `POST /api/vnu/auth/refresh` in this order:

1. Parse Bearer token directly and call purpose-limited `decryptSessionForVnuRefresh()`. Do not call cache `isTokenRevoked()`, ordinary `decryptSession()`, or upstream-aware `resolveSession()`. This route alone may cryptographically decode an expired outward Hyeboard token; every ordinary request still rejects it.
2. Decrypt grant with `decryptVnuRefreshGrant()`; grant expiry remains authoritative and fixed at eight hours.
3. Re-derive HMAC principal from grant username. If it differs from descriptor `principalKey`, or descriptor `grantId !== grant.grantId`, reject with no DO call. Build `oldPair` solely from descriptor IDs/canonical expiries and separately require grant expiry equals descriptor grant expiry. Never substitute grant values into the descriptor pair or expose descriptor fields.
4. After principal/grant linkage, compare the access token's signed student identity with `grant.expectedStudentCode`. On mismatch, call `revokeExactLinkedPair(descriptor.principalKey,oldPair)` and return `VNU_REFRESH_IDENTITY_MISMATCH`; if authority reports `mismatch`, still return identity mismatch but mutate nothing. Then call `beginRefresh(descriptor.principalKey, oldPair)` before adapter login. This is authoritative exact-pair validation plus lease acquisition; fail closed on outage. Convert non-accepted results with `beginResultError()`.
5. Call adapter `importSession({vnuUsername: grant.username,vnuPassword: grant.password})` once.
6. Require returned verified student code equals `expectedStudentCode`; post-lease mismatch becomes `VNU_REFRESH_IDENTITY_MISMATCH` and must flow through terminal `abortRefresh({pair:oldPair,terminal:true})`.
7. Build rotated grant plus a fresh access descriptor/accessTokenId under the same principal. Do not change grant `issuedAt`/`expiresAt`; outward session expiry may follow existing session policy but cannot extend grant expiry.
8. Check `request.signal.aborted` immediately before commit. Cancellation here calls retryable abort and returns without rotation.
9. Call one `completeRefresh(principalKey,{old:oldPair,next:newPair})` transaction before returning. It simultaneously revokes old access/grant IDs and activates new access/grant IDs. If it reports revoked, return `VNU_REFRESH_GRANT_REVOKED` and discard newly minted artifacts. Never write a separate cache revocation entry for refresh-linked access tokens.
10. On terminal error, await `abortRefresh({terminal:true})`; on 429/5xx/network/timeout/request abort before complete, await `abortRefresh({terminal:false})`. Coordinator failure maps to `VNU_REFRESH_UNAVAILABLE` and never continues.
11. Return `Cache-Control: no-store` on success and every refresh/logout error via `onRequest` and `routeError()` path checks.

Use one `completed` boolean in `try/catch/finally`; after successful `completeRefresh()`, never abort. If response delivery fails afterward, old grant stays revoked by design.

Implement `POST /api/vnu/auth/logout`:

- parse/decrypt Bearer token with purpose-limited `decryptSessionForVnuLogout()`, which authenticates exact payload/descriptor shape but permits expired outward access solely for logout. Reconstruct `AccessDescriptorRef` from the descriptor alone; no browser grant is required;
- when an optional browser grant is supplied, decrypt and validate it **before any coordinator call**. Re-derive its principal and require exact equality with descriptor `principalKey`; require grant ID and canonical grant expiry to equal descriptor `grantId`/`grantExpiresAt`; require signed student identity to equal `expectedStudentCode`. Malformed/expired supplied grant returns `VNU_REFRESH_GRANT_INVALID`; principal, student, ID, or expiry mismatch returns `VNU_REFRESH_IDENTITY_MISMATCH`. Every such rejection asserts zero calls to `revokeLinkedPairByAccess`, `revokeExactLinkedPair`, `beginRefresh`, `abortRefresh`, and `completeRefresh`, plus zero DO `put`/alarm changes;
- only after the optional grant passes every check, call the sole authoritative mutation `revokeLinkedPairByAccess(principalKey,accessDescriptorRef)`. Authority compares all four descriptor fields to its exact active pair, and only then atomically revokes that stored access ID and linked grant ID plus matching lease. Logout never calls `revokeExactLinkedPair` and never revokes a different current pair;
- missing optional browser grant is normal. The authenticated descriptor remains the complete authority input;
- matching already-revoked linked descriptor is idempotent success after authoritative DO response; active and inactive browser accounts use identical token-derived authority;
- authority `revoked` is idempotent success only when both exact IDs are still recorded revoked. Authority `expired` is idempotent success only because both authenticated descriptor expiries are already `<= now`; this remains safe after lazy cleanup deleted active/revoked state. Authority must derive this result from the supplied complete pair times, never from caller prose or an account ID. Authority `mismatch` always fails closed as `VNU_REFRESH_GRANT_REVOKED`. Never touch current unrelated state;
- legacy/non-refresh-linked tokens keep the existing generic/best-effort cache revoke path and no exact-revocation claim;
- coordinator failure for descriptor-bearing artifacts returns `VNU_REFRESH_UNAVAILABLE` and does not claim success;
- register the dedicated `/api/vnu/auth/logout` before generic `/api/:universityId/auth/logout`; retain generic UET/mock route unchanged;
- response `{authenticated:false}`, `Cache-Control: no-store`.

Do not log request body, token, grant, payload, profile, username, password, student code, IDs, token hash, HMAC principal, upstream prose, or `error.message`. New VNU log fields are exactly operation, code, and status.

- [ ] **Step 4: Run focused GREEN and full Worker tests**

```bash
pnpm --filter @hyeboard/worker exec vitest run src/app.test.ts -t "refresh|logout"
pnpm --filter @hyeboard/worker test
```

Expected: focused and full Worker suites PASS; both Worker and Node typechecks exit `0`.

- [ ] **Step 5: Commit Task 4 only**

```bash
git add apps/worker/src/app.ts apps/worker/src/app.test.ts
git diff --cached --check
git commit -m "feat(worker): rotate and revoke VNU refresh grants"
```

---

### Task 5: Add Exact-Account Browser Coordinator and Safe Replay Policy

**Files:**
- Create: `apps/web/src/lib/api-types.ts`
- Create: `apps/web/src/lib/vnu-refresh.ts`
- Create: `apps/web/src/lib/vnu-refresh.test.ts`
- Modify: `apps/web/src/lib/api.ts:1-230,311-414,476-486`
- Modify: `apps/web/src/lib/api.test.ts:1-242`
- Modify: `apps/web/src/main.tsx:11-13`

- [ ] **Step 1: Write RED storage, classifier, and policy tests**

Create `apps/web/src/lib/vnu-refresh.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyVnuRecovery,
  clearVnuRefreshGrant,
  readVnuRefreshGrant,
  requestPolicyFor,
  runVnuRefresh,
  storeVnuRefreshGrant,
} from "./vnu-refresh";
import { ApiError, type StoredAccount } from "./api-types";

const ACCOUNT: StoredAccount = { id: "account-alpha", universityId: "vnu", token: "failed-token-alpha", studentCode: "SYNTHETIC-STUDENT-ALPHA", addedAt: "2036-01-01T00:00:00.000Z" };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("VNU refresh storage and policy", () => {
  it("stores grants by opaque local account only in sessionStorage", () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
    expect(localStorage.length).toBe(0);
    expect([...Array(sessionStorage.length)].map((_, index) => sessionStorage.key(index))).toEqual(["hyeboard.vnu.refreshGrant.account-alpha"]);
    clearVnuRefreshGrant(ACCOUNT.id);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBeUndefined();
  });

  it.each([
    [new ApiError("expired", "VNU_SESSION_EXPIRED", 401), true],
    [new ApiError("missing", "VNU_LOGIN_REQUIRED", 401, { reason: "MISSING_VNU_CREDENTIAL" }), true],
    [new ApiError("broad", "VNU_LOGIN_REQUIRED", 401), false],
    [new ApiError("wrong", "VNU_LOGIN_REQUIRED", 401, { reason: undefined }), false],
    [new ApiError("profile", "VNU_PROFILE_INCOMPLETE", 500), false],
  ])("classifies exact recoverability", (error, expected) => {
    expect(classifyVnuRecovery(error)).toBe(expected);
  });

  it.each([
    ["GET", "/api/vnu/raw/profile", "safe-replay"],
    ["GET", "/api/vnu/raw/point-detail?id=SYNTHETIC", "safe-replay"],
    ["GET", "/api/vnu/dashboard", "safe-replay"],
    ["GET", "/api/vnu/cross-lookup/student-code?allowCrossLookup=true", "refresh-no-replay"],
    ["POST", "/api/vnu/cross-lookup/bulk", "refresh-no-replay"],
    ["POST", "/api/vnu/raw/profile", "never"],
    ["HEAD", "/api/vnu/dashboard", "never"],
    ["POST", "/api/vnu/auth/refresh", "never"],
    ["GET", "/api/uet/dashboard", "never"],
  ] as const)("maps %s %s to %s", (method, path, expected) => {
    expect(requestPolicyFor({ method, pathname: path })).toBe(expected);
  });
});

describe("VNU refresh single-flight", () => {
  it("joins one account/token generation and commits/invalidate once", async () => {
    const auth = {
      token: "rotated-token-alpha",
      refreshGrant: "rotated-grant-alpha",
      session: { universityId: "vnu", studentCode: "SYNTHETIC-STUDENT-ALPHA", expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true as const },
    };
    let resolveRefresh!: (value: typeof auth) => void;
    const fetchRefresh = vi.fn(() => new Promise<typeof auth>((resolve) => { resolveRefresh = resolve; }));
    const deps = {
      getAccount: () => ACCOUNT,
      getActiveAccountId: () => ACCOUNT.id,
      fetchRefresh,
      commit: vi.fn(() => true),
      terminal: vi.fn(),
      invalidate: vi.fn(),
      status: vi.fn(),
    };
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const first = runVnuRefresh(ACCOUNT, undefined, deps);
    const second = runVnuRefresh(ACCOUNT, undefined, deps);
    resolveRefresh(auth);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "committed", auth },
      { kind: "committed", auth },
    ]);
    expect(fetchRefresh).toHaveBeenCalledTimes(1);
    expect(deps.commit).toHaveBeenCalledTimes(1);
    expect(deps.invalidate).toHaveBeenCalledTimes(1);
  });

  it("keeps shared work for one waiter and aborts only after all waiters cancel", async () => {
    const refreshAbort = vi.fn();
    const fetchRefresh = vi.fn((_account, _grant, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => { refreshAbort(); reject(signal.reason); })));
    const deps = { getAccount: () => ACCOUNT, getActiveAccountId: () => ACCOUNT.id, fetchRefresh, commit: vi.fn(), terminal: vi.fn(), invalidate: vi.fn(), status: vi.fn() };
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const a = new AbortController();
    const b = new AbortController();
    const first = runVnuRefresh(ACCOUNT, a.signal, deps);
    const second = runVnuRefresh(ACCOUNT, b.signal, deps);
    a.abort(new DOMException("first cancelled", "AbortError"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(refreshAbort).not.toHaveBeenCalled();
    b.abort(new DOMException("second cancelled", "AbortError"));
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(refreshAbort).toHaveBeenCalledTimes(1);
    expect(deps.commit).not.toHaveBeenCalled();
  });
});
```

Add API tests for safe GET replay once with new token and internal `noRefresh`; every non-GET defaulting to `never`; charged cross-lookup GET and bulk POST refreshing without replay; missing grant removing only unchanged VNU account; retryable errors preserving account/grant; terminal errors clearing only unchanged account; separate account/token flights; and sanitized `ApiError.details` propagation. Race tests must switch account, replace token, remove account, and manually relogin before refresh resolves; clear side-effect spies immediately before release, then prove each resolution yields `{kind:"stale"}` with no late account/grant/status/invalidation mutation, no replay, and no `VNU_REQUEST_NOT_REPLAYED` success signal.

Add Query retry tests where refresh itself returns representative `429`, `503`, and mapped upstream/network failure. Each request performs exactly one refresh attempt; the thrown `ApiError` carries the internal attempted-refresh marker, and `shouldRetryQuery()` returns false regardless of error code. Also prove an unrelated unmarked transient error may use the existing one retry.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/vnu-refresh.test.ts src/lib/api.test.ts
```

Expected: FAIL because `vnu-refresh.ts` and four-argument `ApiError` do not exist.

- [ ] **Step 3: Break the ESM cycle, then implement storage, strict details, and policy registry**

Create `apps/web/src/lib/api-types.ts` and move `ApiError`, `StoredAccount`, `AuthResult` aliases, and shared request/auth input types used by both modules out of `api.ts`. `api.ts` re-exports compatibility type names only where current callers require them. Both `api.ts` and `vnu-refresh.ts` import directly from `api-types.ts`; `api-types.ts` imports neither. Add migration assertions in `api.test.ts`/`vnu-refresh.test.ts` proving one `ApiError` constructor identity (`instanceof` works across both modules) and no runtime import cycle.

Define `ApiError` there as:

```ts
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
    public readonly details?: ApiErrorDetails,
    options?: { vnuRefreshAttempted?: boolean },
  ) {
    super(message);
    this.name = "ApiError";
    Object.defineProperty(this, vnuRefreshAttemptedMarker, { value: options?.vnuRefreshAttempted === true, enumerable: false });
  }
}
```

`vnuRefreshAttemptedMarker` is a non-exported module-local `unique symbol`. Export typed helpers `markVnuRefreshAttempted(error)` and `wasVnuRefreshAttempted(error)`; they preserve message/code/status/details, never add a JSON field, and never enter `ApiResponse`, logs, storage, analytics, or wire schemas.

Pass `payload.error?.details` at plain-JSON `ApiError` construction sites. Never parse unknown detail keys client-side; Worker JSON boundary already admits only `reason`, `retryAfterSeconds`, `limit`, and `windowSeconds`. Leave UET SSE `createError(message,code,status)` and `uet-session-stream.ts` unchanged.

Create `apps/web/src/lib/vnu-refresh.ts` with exact public contracts:

```ts
import type { ApiErrorDetails, AuthResult } from "@hyeboard/schemas";
import { ApiError, type StoredAccount } from "./api-types";

export type VnuRequestPolicy = "safe-replay" | "refresh-no-replay" | "never";
export const VNU_REQUEST_NOT_REPLAYED = "VNU_REQUEST_NOT_REPLAYED" as const;
const PREFIX = "hyeboard.vnu.refreshGrant.";
const terminalCodes = new Set(["VNU_REFRESH_GRANT_INVALID", "VNU_REFRESH_GRANT_REVOKED", "INVALID_VNU_CREDENTIAL", "VNU_REFRESH_IDENTITY_MISMATCH"]);

export function storeVnuRefreshGrant(accountId: string, grant: string): void { sessionStorage.setItem(`${PREFIX}${accountId}`, grant); }
export function readVnuRefreshGrant(accountId: string): string | undefined { return sessionStorage.getItem(`${PREFIX}${accountId}`) ?? undefined; }
export function clearVnuRefreshGrant(accountId: string): void { sessionStorage.removeItem(`${PREFIX}${accountId}`); }

export function classifyVnuRecovery(error: unknown): boolean {
  return error instanceof ApiError && (
    error.code === "VNU_SESSION_EXPIRED"
    || (error.code === "VNU_LOGIN_REQUIRED" && error.details?.reason === "MISSING_VNU_CREDENTIAL")
  );
}

export function requestPolicyFor(input: { method: string; pathname: string }): VnuRequestPolicy {
  const method = input.method.toUpperCase();
  const pathname = new URL(input.pathname, "https://hyeboard.invalid").pathname;
  if (method !== "GET") return pathname === "/api/vnu/cross-lookup/bulk" && method === "POST" ? "refresh-no-replay" : "never";
  if (/^\/api\/vnu\/auth\//.test(pathname) || pathname === "/api/vnu/auth/solve-captcha") return "never";
  if (pathname === "/api/vnu/cross-lookup/bulk" || /^\/api\/vnu\/cross-lookup\//.test(pathname)) return "refresh-no-replay";
  if (/^\/api\/vnu\/raw\/(profile|grades|progress|exam-base|exams|syllabus|point-detail)$/.test(pathname)) return "safe-replay";
  if (/^\/api\/vnu\/(dashboard|terms|timetable|courses|assignments|grades|exams|documents|tuition|news|training-points|requests)$/.test(pathname)) return "safe-replay";
  return "never";
}

export class VnuRequestNotReplayedError extends ApiError {
  constructor() { super("The VNU session was restored. Retry this operation manually.", VNU_REQUEST_NOT_REPLAYED); }
}

type RefreshDeps = {
  getAccount(id: string): StoredAccount | undefined;
  getActiveAccountId(): string | null;
  fetchRefresh(account: StoredAccount, grant: string, signal: AbortSignal): Promise<AuthResult>;
  commit(account: StoredAccount, result: AuthResult): boolean;
  terminal(account: StoredAccount): void;
  invalidate(accountId: string): void;
  status(accountId: string, state: "reconnecting" | "retryable" | "idle"): void;
  onFlightSettled?(): void; // deterministic test observer; production omits it
};

export type VnuRefreshOutcome = { kind: "committed"; auth: AuthResult } | { kind: "stale" };
type Flight = { controller: AbortController; waiters: Set<symbol>; promise: Promise<VnuRefreshOutcome>; generation: symbol };
const flights = new Map<string, Flight>();

function flightKey(account: StoredAccount): string { return `${account.id}\u0000${account.token}`; }
function unchangedActive(account: StoredAccount, deps: RefreshDeps): boolean {
  const current = deps.getAccount(account.id);
  return Boolean(current && current.token === account.token && deps.getActiveAccountId() === account.id);
}

export function runVnuRefresh(account: StoredAccount, signal: AbortSignal | undefined, deps: RefreshDeps): Promise<VnuRefreshOutcome> {
  const grant = readVnuRefreshGrant(account.id);
  if (!grant) {
    if (unchangedActive(account, deps)) deps.terminal(account);
    return Promise.reject(new ApiError("VNU reconnect requires manual sign-in.", "VNU_REFRESH_GRANT_INVALID", 401));
  }
  const key = flightKey(account);
  let flight = flights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const generation = Symbol(key);
    const waiters = new Set<symbol>();
    deps.status(account.id, "reconnecting");
    const promise = deps.fetchRefresh(account, grant, controller.signal).then((result) => {
      const current = flights.get(key);
      if (current?.generation === generation && current.waiters.size > 0 && unchangedActive(account, deps) && deps.commit(account, result)) {
        deps.invalidate(account.id);
        deps.status(account.id, "idle");
        return { kind: "committed", auth: result } as const;
      }
      return { kind: "stale" } as const;
    }).catch((error: unknown) => {
      const current = flights.get(key);
      if (current?.generation === generation && current.waiters.size > 0 && unchangedActive(account, deps)) {
        if (error instanceof ApiError && terminalCodes.has(error.code ?? "")) deps.terminal(account);
        else deps.status(account.id, "retryable");
      }
      throw error;
    }).finally(() => {
      if (flights.get(key)?.generation === generation) flights.delete(key);
      deps.onFlightSettled?.();
    });
    flight = { controller, waiters, promise, generation };
    flights.set(key, flight);
  }
  const waiter = Symbol("vnu-refresh-waiter");
  flight.waiters.add(waiter);
  const release = () => {
    flight!.waiters.delete(waiter);
    if (flight!.waiters.size === 0) {
      flight!.controller.abort(new DOMException("All VNU refresh waiters cancelled", "AbortError"));
      if (unchangedActive(account, deps)) deps.status(account.id, "idle");
    }
  };
  if (signal?.aborted) { release(); return Promise.reject(signal.reason); }
  return new Promise<VnuRefreshOutcome>((resolve, reject) => {
    const onAbort = () => { release(); reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
    flight!.promise.then(resolve, reject).finally(() => {
      signal?.removeEventListener("abort", onAbort);
      flight!.waiters.delete(waiter);
    });
  });
}
```

Tests may inject deps; production `api.ts` supplies adapters over account storage and fetch.

- [ ] **Step 4: Refactor account mutation and request execution**

Add an internal account lookup and exact commit in `api.ts`:

```ts
export function getAccountById(id: string): StoredAccount | undefined { return readAccounts().find((account) => account.id === id); }

export function commitVnuRefresh(origin: StoredAccount, result: AuthResult): boolean {
  const accounts = readAccounts();
  const index = accounts.findIndex((account) => account.id === origin.id && account.token === origin.token);
  if (index < 0 || getActiveAccountId() !== origin.id || !result.refreshGrant) return false;
  const previousGrant = readVnuRefreshGrant(origin.id);
  try {
    storeVnuRefreshGrant(origin.id, result.refreshGrant);
    accounts[index] = { ...accounts[index], token: result.token, studentCode: result.session.studentCode ?? accounts[index].studentCode };
    writeAccounts(accounts);
    return true;
  } catch (error) {
    if (previousGrant) storeVnuRefreshGrant(origin.id, previousGrant); else clearVnuRefreshGrant(origin.id);
    throw error;
  }
}
```

Refactor `request()` to capture `originatingAccount` and `failedToken` once, execute one fetch, parse `ApiError` with details, and on exact recoverability:

Classify policy from `{ method: init.method ?? "GET", pathname: path }`. Caller overrides may only reduce replay safety, never turn an unlisted path/method into `safe-replay`.

- policy `never` or internal `noRefresh`: throw original error;
- no grant: guarded removal of unchanged origin, then throw original error;
- otherwise join/run refresh. Normalize any non-`ApiError` rejection (network, abort, timeout) into an `ApiError` with stable client copy/code as current request handling requires, then mark every error leaving this attempted path with the internal non-enumerable attempted-refresh marker;
- `{kind:"stale"}`: throw the marked original request error. Perform no replay, no `VnuRequestNotReplayedError`, no terminal handling, no status transition, and no success/invalidation event;
- `{kind:"committed"}` with `safe-replay`: fetch original path/init once using `outcome.auth.token` and `{noRefresh:true}`; preserve original body, query string, parameters, method, and signal; never start second refresh;
- `{kind:"committed"}` with `refresh-no-replay`: throw a marked `new VnuRequestNotReplayedError()` without issuing a replacement request;
- replay uses the caller's original abort signal and rotated token, not global active token;
- UET handling remains current and still uses originating-account semantics.

Use an internal options type, not a wire field:

```ts
type InternalRequestOptions = { policy?: VnuRequestPolicy; noRefresh?: boolean; tokenOverride?: string };
```

Do not put policy/noRefresh in URL, body, headers, or Query key.

Change `SESSION_INVALID_CODES` back to only `MISSING_SESSION`, `SESSION_EXPIRED`, `INVALID_SESSION`. Handle `VNU_SESSION_EXPIRED` through VNU recovery; if no usable grant, guarded account removal preserves old observable behavior.

Export Query retry helper and use it in `main.tsx`:

```ts
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (wasVnuRefreshAttempted(error)) return false;
  if (!(error instanceof ApiError)) return true;
  return !isSessionDeathCode(error.code) && error.code !== VNU_REQUEST_NOT_REPLAYED;
}
```

Do not maintain a refresh-failure code list in Query policy. The internal marker covers `429`, `503`, network/timeouts mapped to `ApiError`, and future refresh failures after any attempted refresh. Marker state is memory-only and absent from `Object.keys`, `JSON.stringify`, wire payloads, and user data exports.

```ts
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: shouldRetryQuery } },
});
```

- [ ] **Step 5: Run GREEN and independent web typecheck**

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/vnu-refresh.test.ts src/lib/api.test.ts
pnpm --filter @hyeboard/web typecheck
```

Expected: PASS. Fetch-count assertions prove one refresh, one safe replay, zero charged/bulk replay, one account update, and one invalidation.

- [ ] **Step 6: Commit Task 5 only**

```bash
git add apps/web/src/lib/api-types.ts apps/web/src/lib/vnu-refresh.ts apps/web/src/lib/vnu-refresh.test.ts apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/main.tsx
git diff --cached --check
git commit -m "feat(web): coordinate VNU refresh and safe replay"
```

---

### Task 6: Integrate Login, Reconnect Status, and Exact-Account Revocation UI

**Files:**
- Modify: `apps/web/src/lib/api-types.ts`
- Modify: `apps/web/src/lib/api.ts:103-145,387-486`
- Modify: `apps/web/src/lib/api.test.ts:1-242`
- Modify: `apps/web/src/state.tsx:1-164`
- Modify: `apps/web/src/pages/login.tsx:86-248,377-395`
- Modify: `apps/web/src/components/layout.tsx:268-325`
- Modify: `apps/web/src/pages/settings.tsx:20-35`
- Modify: `apps/web/src/lib/i18n.tsx:1-806`
- Modify: `apps/web/tests/smoke.spec.ts:1-160,653-850`

- [ ] **Step 1: Write RED atomic import and revocation tests**

Add API unit tests:

```ts
it("returns the upserted VNU account and stores its grant before one switch event", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    data: {
      token: "opaque-access-alpha",
      refreshGrant: "opaque-grant-alpha",
      session: { universityId: "vnu", studentCode: "SYNTHETIC-STUDENT-ALPHA", expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
    },
    error: null,
  }), { headers: { "Content-Type": "application/json" } })));
  const result = await api.importSession("vnu", { vnuUsername: "SYNTHETIC-VNU-USER", vnuPassword: "SYNTHETIC-VNU-PASSWORD" });
  expect(result.account.id).toBeTruthy();
  expect(sessionStorage.getItem(`hyeboard.vnu.refreshGrant.${result.account.id}`)).toBe("opaque-grant-alpha");
  expect(dispatchEvent).toHaveBeenCalledTimes(1);
});

it("leaves account and grant unchanged when exact-account revoke fails", async () => {
  seedAccount();
  sessionStorage.setItem(`hyeboard.vnu.refreshGrant.${ACCOUNT.id}`, "opaque-grant-alpha");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic unavailable", details: { retryAfterSeconds: 5 } } }), { status: 503, headers: { "Content-Type": "application/json" } })));
  await expect(api.revokeAndRemoveAccount(ACCOUNT.id)).rejects.toMatchObject({ code: "VNU_REFRESH_UNAVAILABLE" });
  expect(listAccounts()).toEqual([ACCOUNT]);
  expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
});

it("revokes and removes the requested inactive VNU account without using active artifacts", async () => {
  localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT, SECOND_ACCOUNT]));
  localStorage.setItem("hyeboard.activeAccountId", SECOND_ACCOUNT.id);
  storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
  storeVnuRefreshGrant(SECOND_ACCOUNT.id, "opaque-grant-beta");
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { authenticated: false }, error: null }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  await api.revokeAndRemoveAccount(ACCOUNT.id);
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/vnu/auth/logout"), expect.objectContaining({
    headers: expect.objectContaining({ Authorization: `Bearer ${ACCOUNT.token}` }),
    body: JSON.stringify({ refreshGrant: "opaque-grant-alpha" }),
  }));
  expect(listAccounts()).toEqual([SECOND_ACCOUNT]);
  expect(readVnuRefreshGrant(ACCOUNT.id)).toBeUndefined();
  expect(readVnuRefreshGrant(SECOND_ACCOUNT.id)).toBe("opaque-grant-beta");
});

it.each(["active", "inactive"])("removes a %s VNU account in a new tab without a browser grant", async (kind) => {
  localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT, SECOND_ACCOUNT]));
  localStorage.setItem("hyeboard.activeAccountId", kind === "active" ? ACCOUNT.id : SECOND_ACCOUNT.id);
  sessionStorage.clear();
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { authenticated: false }, error: null }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  await api.revokeAndRemoveAccount(ACCOUNT.id);
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/vnu/auth/logout"), expect.objectContaining({
    headers: expect.objectContaining({ Authorization: `Bearer ${ACCOUNT.token}` }),
    body: JSON.stringify({}),
  }));
  expect(listAccounts()).toEqual([SECOND_ACCOUNT]);
});

it.each(["active", "inactive"])("removes a %s new-tab VNU account after both linked expiries and authority cleanup", async (kind) => {
  const expired = { ...ACCOUNT, token: "authenticated-fully-expired-descriptor-token" };
  localStorage.setItem("hyeboard.accounts", JSON.stringify([expired, SECOND_ACCOUNT]));
  localStorage.setItem("hyeboard.activeAccountId", kind === "active" ? expired.id : SECOND_ACCOUNT.id);
  sessionStorage.clear();
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { authenticated: false }, error: null }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  await api.revokeAndRemoveAccount(expired.id);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/vnu/auth/logout"), expect.objectContaining({
    headers: expect.objectContaining({ Authorization: `Bearer ${expired.token}` }),
    body: JSON.stringify({}),
  }));
  expect(listAccounts()).toEqual([SECOND_ACCOUNT]);
});
```

Add one self-host degradation test: a successful VNU import response without `refreshGrant` still commits the access-only account, stores no stale/new grant, and dispatches one switch event. It cannot auto-refresh later and follows existing session-death/manual-login behavior.

Add Playwright tests replacing old plaintext-retention expectations:

- input change writes no VNU username/password storage;
- failed login leaves no VNU plaintext/grant key;
- successful login stores returned grant under returned local account ID and deletes both legacy plaintext keys;
- new tab shares local accounts but has no session-scoped grant: ordinary expiry goes to manual login, while active or inactive account removal still succeeds through the encrypted access descriptor alone both while the grant is live and after both descriptor expiries pass plus authority lazy cleanup removes state;
- reconnect status is `role="status"`, `aria-live="polite"`, nonblocking, and appears once for joined failures;
- active and inactive removal send matching token and optional same-tab grant, succeed without a grant in a new tab, and retain UI on mocked `503`;
- successful removal clears only matching grant/account;
- terminal refresh failure removes only unchanged origin;
- EN/VI copy and mobile/desktop visibility.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/api.test.ts
```

Expected: FAIL because import returns only wire data and `revokeAndRemoveAccount` does not exist.

- [ ] **Step 3: Implement atomic import contract and exact-account revoke API**

Define returned contract in `api-types.ts` and import it into `api.ts`:

```ts
export type ImportedAccountResult = { account: StoredAccount; auth: AuthResult };
```

Refactor account upsert into a no-event record builder. Implement one logical transaction:

```ts
function commitImportedAccount(universityId: string, auth: AuthResult): StoredAccount {
  const beforeAccounts = localStorage.getItem(ACCOUNTS_KEY);
  const beforeActive = localStorage.getItem(ACTIVE_ACCOUNT_KEY);
  const accounts = readAccounts();
  const index = accounts.findIndex((account) => account.universityId === universityId && (account.studentCode ?? "") === (auth.session.studentCode ?? ""));
  const account: StoredAccount = index >= 0
    ? { ...accounts[index], token: auth.token, studentCode: auth.session.studentCode ?? accounts[index].studentCode }
    : { id: uuid(), universityId, token: auth.token, studentCode: auth.session.studentCode, addedAt: new Date().toISOString() };
  const beforeGrant = readVnuRefreshGrant(account.id);
  try {
    if (universityId === "vnu") {
      if (auth.refreshGrant) storeVnuRefreshGrant(account.id, auth.refreshGrant);
      else clearVnuRefreshGrant(account.id);
    }
    if (index >= 0) accounts[index] = account; else accounts.push(account);
    writeAccounts(accounts);
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, account.id);
    sessionStorage.removeItem("hyeboard.relogin.vnu.username");
    sessionStorage.removeItem("hyeboard.relogin.vnu.password");
  } catch (error) {
    if (beforeAccounts === null) localStorage.removeItem(ACCOUNTS_KEY); else localStorage.setItem(ACCOUNTS_KEY, beforeAccounts);
    if (beforeActive === null) localStorage.removeItem(ACTIVE_ACCOUNT_KEY); else localStorage.setItem(ACTIVE_ACCOUNT_KEY, beforeActive);
    if (beforeGrant) storeVnuRefreshGrant(account.id, beforeGrant); else clearVnuRefreshGrant(account.id);
    throw error;
  }
  window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT));
  return account;
}
```

`api.importSession()` returns `{account,auth}` after `commitImportedAccount()`. Existing UET/mock callers may ignore `account`; VNU login relies on it. This solves sequencing: local ID is created before grant key is finalized, both are committed before the sole account event.

Implement exact-account removal:

```ts
export async function revokeAndRemoveAccount(accountId: string): Promise<void> {
  const origin = getAccountById(accountId);
  if (!origin) return;
  if (origin.universityId === "vnu") {
    const grant = readVnuRefreshGrant(origin.id);
    await requestWithAccount<{ authenticated: false }>(origin, "/api/vnu/auth/logout", {
      method: "POST",
      body: JSON.stringify(grant ? { refreshGrant: grant } : {}),
    }, { policy: "never", noRefresh: true });
  } else {
    try { await requestWithAccount(origin, `/api/${origin.universityId}/auth/logout`, { method: "POST" }, { policy: "never", noRefresh: true }); } catch { /* preserve existing best-effort UET/mock behavior */ }
  }
  const current = getAccountById(origin.id);
  if (!current || current.token !== origin.token) return;
  clearVnuRefreshGrant(origin.id);
  sessionStorage.removeItem("hyeboard.relogin.vnu.username");
  sessionStorage.removeItem("hyeboard.relogin.vnu.password");
  removeAccount(origin.id);
}
```

Before sending logout, cancel/remove that account's refresh waiters through an exported `cancelVnuRefreshForAccount(accountId)`; Worker logout's principal-wide revocation closes a refresh that reached authority concurrently. If logout fails, do not remove account/grant or switch active account. If account token changed during await, success is inert and newer local state survives.

- [ ] **Step 4: Remove plaintext VNU persistence and add status/state UI**

In `login.tsx` initialize VNU fields with empty component state:

```ts
const [vnuUsername, setVnuUsername] = useState("");
const [vnuPassword, setVnuPassword] = useState("");
```

Use plain setters on input change. Do not call `sessionStored()` or `setSessionStored()` for VNU. On success:

```ts
const { account } = await api.importSession("vnu", {
  vnuUsername: vnuUsername || undefined,
  vnuPassword: vnuPassword || undefined,
});
```

Do not reject successful access-only VNU auth when `refreshGrant` is absent; this is the documented Node/Bun degradation. Cloudflare coordinator outages remain Worker errors and never return partial success.

Failure leaves only React component state until component unmount. Keep UET credential persistence unchanged.

In `state.tsx`:

- expose `logout(): Promise<void>` and `removeStoredAccount(id): Promise<void>`;
- keep `removingAccountIds: ReadonlySet<string>` and `accountActionError?: string`;
- subscribe to one refresh-status event carrying only `{accountId,state}`; never token/grant/identity;
- expose active-account `vnuReconnectState: "idle" | "reconnecting" | "retryable"`;
- on one coordinator success event, increment `sessionNonce` and invalidate only active VNU query keys once; do not duplicate account commit;
- `logout()` awaits `revokeAndRemoveAccount(activeAccountId)` before navigation/local removal.

Render near `<Outlet />` in `layout.tsx`:

```tsx
{state.vnuReconnectState === "reconnecting" ? (
  <p className="mb-3 text-sm text-muted-foreground" role="status" aria-live="polite">{t.common.vnuReconnecting}</p>
) : state.vnuReconnectState === "retryable" ? (
  <p className="mb-3 text-sm text-muted-foreground" role="status" aria-live="polite">{t.common.vnuReconnectRetryable}</p>
) : null}
```

Make menu/settings handlers async, disable the exact account action while pending, catch error into inline translated copy, and navigate only after active logout succeeds. Nonactive removal must call `state.removeStoredAccount(account.id)`, never `state.logout()`.

Add both dictionaries with identical keys:

```ts
vnuReconnecting: "Reconnecting to VNU…",
vnuReconnectRetryable: "VNU could not reconnect. Retry the affected request.",
vnuRevocationFailed: "Could not securely remove this VNU account. Try again.",
vnuManualLoginRequired: "This VNU account needs manual sign-in.",
```

```ts
vnuReconnecting: "Đang kết nối lại với VNU…",
vnuReconnectRetryable: "Không thể kết nối lại với VNU. Hãy thử lại thao tác bị ảnh hưởng.",
vnuRevocationFailed: "Không thể gỡ tài khoản VNU an toàn. Hãy thử lại.",
vnuManualLoginRequired: "Tài khoản VNU này cần đăng nhập lại thủ công.",
```

- [ ] **Step 5: Run unit GREEN, then serial focused E2E**

```bash
pnpm --filter @hyeboard/web test
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --workers=1 --grep "VNU.*(grant|reconnect|remove|new tab|plaintext)"
```

Expected: web tests PASS. Focused Playwright passes serially; failed revoke leaves account visible; no plaintext VNU storage exists.

- [ ] **Step 6: Commit Task 6 only**

```bash
git add apps/web/src/lib/api-types.ts apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts apps/web/src/state.tsx apps/web/src/pages/login.tsx apps/web/src/components/layout.tsx apps/web/src/pages/settings.tsx apps/web/src/lib/i18n.tsx apps/web/tests/smoke.spec.ts
git diff --cached --check
git commit -m "feat(web): integrate VNU reconnect account lifecycle"
```

---

### Task 7: Preserve Bulk Progress Across Refresh Without POST Replay

**Files:**
- Modify: `apps/web/src/lib/bulk-lookup.ts:10-186`
- Modify: `apps/web/src/lib/bulk-lookup.test.ts:40-206`
- Modify: `apps/web/src/lib/api.test.ts` (real request-policy + bulk joined-flight integration)
- Modify: `apps/web/src/lib/vnu-refresh.test.ts` (all-waiter cancellation late-resolution integration)
- Modify: `apps/web/src/pages/lookup.tsx:850-1045`
- Modify: `apps/web/src/lib/i18n.tsx:215-338,683-806`
- Modify: `apps/web/tests/smoke.spec.ts`

- [ ] **Step 1: Write RED bulk recovery/cancellation tests**

Append to `apps/web/src/lib/bulk-lookup.test.ts`:

```ts
it("preserves acknowledged items and marks the failed chunk plus later targets retryable after refresh", async () => {
  const targets = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  let calls = 0;
  const execution = await executeBulkLookup({
    mode: "stdid-to-code",
    targets,
    signal: new AbortController().signal,
    requestChunk: async (_mode, chunk) => {
      calls += 1;
      if (calls === 2) throw new VnuRequestNotReplayedError();
      return chunk.map((target) => ({ target, status: "ok", result: { studentCode: `SYNTHETIC-${target}` } }));
    },
  });
  expect(calls).toBe(2);
  expect(execution.progress.items.map((item) => item.target)).toEqual(targets.slice(0, 5));
  expect(execution.remainingTargets).toEqual(["foxtrot"]);
  expect(execution.restoredWithoutReplay).toBe(true);
});

it("manual retry sends remaining targets under caller's current token", async () => {
  const tokens: string[] = [];
  const first = await executeBulkLookup({
    mode: "stdid-to-code",
    targets: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"],
    signal: new AbortController().signal,
    requestChunk: async (_mode, chunk) => {
      if (chunk[0] === "foxtrot") throw new VnuRequestNotReplayedError();
      tokens.push("failed-token-alpha");
      return chunk.map((target) => ({ target, status: "error", errorCode: "SYNTHETIC" }));
    },
  });
  const retry = await executeBulkLookup({
    mode: "stdid-to-code",
    targets: first.remainingTargets,
    initialProgress: first.progress,
    signal: new AbortController().signal,
    requestChunk: async (_mode, chunk) => {
      tokens.push("rotated-token-alpha");
      return chunk.map((target) => ({ target, status: "error", errorCode: "SYNTHETIC" }));
    },
  });
  expect(tokens).toEqual(["failed-token-alpha", "rotated-token-alpha"]);
  expect(retry.remainingTargets).toEqual([]);
});

```

Keep the preceding pure chunk-state tests in `bulk-lookup.test.ts`. Put the joined survivor integration in `api.test.ts`, because both callers must traverse production `request()`: the failed second chunk calls `api.vnuCrossLookupBulk()`, while the survivor calls an ordinary safe GET through `api.dashboard("vnu")`. Neither test may call `runVnuRefresh()` directly, throw a synthetic no-replay error, or increment a synthetic replay counter. Keep the all-waiter late-resolution test in `vnu-refresh.test.ts`; add `onFlightSettled?: () => void` to injected `RefreshDeps` only for that cancellation barrier. Production omits it, and `runVnuRefresh()` invokes it from the shared promise's `finally`.

```ts
const ELEVEN_TARGETS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo"];
const ROTATED_AUTH = {
  token: "rotated-token-alpha",
  refreshGrant: "rotated-grant-alpha",
  session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true as const },
};

it("joins a safe GET to the bulk refresh and replays the GET with the rotated token", async () => {
  seedAccount(ACCOUNT);
  storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
  let enterRefresh!: () => void;
  const refreshEntered = new Promise<void>((resolve) => { enterRefresh = resolve; });
  let releaseRefresh!: (response: Response) => void;
  const refreshResponse = new Promise<Response>((resolve) => { releaseRefresh = resolve; });
  let markSafeGetJoined!: () => void;
  const safeGetJoined = new Promise<void>((resolve) => { markSafeGetJoined = resolve; });
  const restoreObserver = installRequestTestObserver({
    onRefreshWaiterRegistered: ({ path, joinedExistingFlight }) => {
      if (path === "/api/vnu/dashboard" && joinedExistingFlight) markSafeGetJoined();
    },
  });
  const calls: Array<{ path: string; method: string; token: string | null }> = [];
  let bulkPosts = 0;
  let safeGets = 0;

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "https://hyeboard.invalid").pathname;
    const method = init?.method ?? "GET";
    const token = new Headers(init?.headers).get("Authorization");
    calls.push({ path, method, token });
    if (path === "/api/vnu/auth/refresh") {
      enterRefresh();
      return refreshResponse;
    }
    if (path === "/api/vnu/cross-lookup/bulk") {
      bulkPosts += 1;
      if (bulkPosts === 1) {
        const body = JSON.parse(String(init?.body)) as { targets: string[] };
        return jsonOk({ items: body.targets.map((target) => ({ target, status: "error", errorCode: "SYNTHETIC" })) });
      }
      return jsonError("VNU_SESSION_EXPIRED", 401);
    }
    if (path === "/api/vnu/dashboard") {
      safeGets += 1;
      return safeGets === 1 ? jsonError("VNU_SESSION_EXPIRED", 401) : jsonOk({ terms: [] });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  }));

  const bulkRun = executeBulkLookup({
    mode: "stdid-to-code",
    targets: ELEVEN_TARGETS,
    signal: new AbortController().signal,
    requestChunk: (mode, chunk) => api.vnuCrossLookupBulk(mode, chunk),
  });
  await refreshEntered;
  const safeGet = api.dashboard("vnu"); // first production request() fetch fails recoverably and joins the deferred bulk flight
  await safeGetJoined;
  releaseRefresh(jsonOk(ROTATED_AUTH));
  await expect(safeGet).resolves.toEqual({ terms: [] });
  const bulk = await bulkRun;

  expect(bulk).toMatchObject({ aborted: false, restoredWithoutReplay: true });
  expect(bulk.progress.items.map((item) => item.target)).toEqual(ELEVEN_TARGETS.slice(0, 5));
  expect(bulk.remainingTargets).toEqual(ELEVEN_TARGETS.slice(5));
  expect(calls.filter((call) => call.path === "/api/vnu/cross-lookup/bulk")).toHaveLength(2);
  expect(calls.filter((call) => call.path === "/api/vnu/auth/refresh")).toHaveLength(1);
  expect(calls.filter((call) => call.path === "/api/vnu/dashboard")).toEqual([
    { path: "/api/vnu/dashboard", method: "GET", token: `Bearer ${ACCOUNT.token}` },
    { path: "/api/vnu/dashboard", method: "GET", token: `Bearer ${ROTATED_AUTH.token}` },
  ]);
  expect(calls.filter((call) => call.path === "/api/vnu/cross-lookup/bulk" && call.token === `Bearer ${ROTATED_AUTH.token}`)).toHaveLength(0);
  expect(listAccounts()).toContainEqual(expect.objectContaining({ id: ACCOUNT.id, token: ROTATED_AUTH.token }));
  restoreObserver();
});

it("aborts one shared refresh after all waiters cancel and ignores a late success", async () => {
  storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
  const beforeAccount = getAccountById(ACCOUNT.id);
  const bulk = new AbortController();
  const peer = new AbortController();
  let enterRefresh!: () => void;
  let releaseLate!: () => void;
  let markSettled!: () => void;
  const refreshEntered = new Promise<void>((resolve) => { enterRefresh = resolve; });
  const lateReleased = new Promise<void>((resolve) => { releaseLate = resolve; });
  const flightSettled = new Promise<void>((resolve) => { markSettled = resolve; });
  const counts = { bulkPost: 0, refreshPost: 0, refreshAbort: 0, replacementBulkPost: 0, peerReplay: 0 };
  const deps = {
    getAccount: () => ACCOUNT,
    getActiveAccountId: () => ACCOUNT.id,
    fetchRefresh: vi.fn(async (_account, _grant, signal: AbortSignal) => {
      counts.refreshPost += 1;
      signal.addEventListener("abort", () => { counts.refreshAbort += 1; }, { once: true });
      enterRefresh();
      await lateReleased; // deliberately resolves successfully after shared abort
      return ROTATED_AUTH;
    }),
    commit: vi.fn(() => true), terminal: vi.fn(), invalidate: vi.fn(), status: vi.fn(), onFlightSettled: markSettled,
  };
  const bulkRun = executeBulkLookup({
    mode: "stdid-to-code", targets: ELEVEN_TARGETS, signal: bulk.signal,
    requestChunk: async (_mode, chunk, signal) => {
      counts.bulkPost += 1;
      if (counts.bulkPost > 2) counts.replacementBulkPost += 1;
      if (counts.bulkPost === 1) return chunk.map((target) => ({ target, status: "error", errorCode: "SYNTHETIC" }));
      await runVnuRefresh(ACCOUNT, signal, deps);
      throw new VnuRequestNotReplayedError();
    },
  });
  await refreshEntered;
  const peerRun = runVnuRefresh(ACCOUNT, peer.signal, deps).then(() => { counts.peerReplay += 1; });
  bulk.abort(new DOMException("bulk cancelled", "AbortError"));
  peer.abort(new DOMException("peer cancelled", "AbortError"));
  await expect(peerRun).rejects.toMatchObject({ name: "AbortError" });
  const cancelled = await bulkRun;
  expect(counts.refreshAbort).toBe(1);
  deps.commit.mockClear(); deps.terminal.mockClear(); deps.invalidate.mockClear(); deps.status.mockClear();
  releaseLate();
  await flightSettled;

  expect(cancelled.progress.items.map((item) => item.target)).toEqual(ELEVEN_TARGETS.slice(0, 5));
  expect(cancelled.remainingTargets).toEqual(ELEVEN_TARGETS.slice(5));
  expect(deps.commit).not.toHaveBeenCalled();
  expect(deps.terminal).not.toHaveBeenCalled();
  expect(deps.invalidate).not.toHaveBeenCalled();
  expect(deps.status).not.toHaveBeenCalled();
  expect(getAccountById(ACCOUNT.id)).toEqual(beforeAccount);
  expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
  expect(counts).toEqual({ bulkPost: 2, refreshPost: 1, refreshAbort: 1, replacementBulkPost: 0, peerReplay: 0 });
});
```

`installRequestTestObserver()` is a non-production test seam in `api.ts`: it accepts only `onRefreshWaiterRegistered({path,joinedExistingFlight})`, returns a restore function, stores no token/account/grant, and is called immediately after production `request()` synchronously registers its waiter. Production installs no observer. The entered promise proves the safe GET joined before refresh release without sleeps, polling, direct flight-map access, or fake replay work.

These unit integration tests use actual production `request()` recovery, shared-flight code, entire `executeBulkLookup()` chunk state, and entered/settled promises. The survivor's first and replay GETs are real mocked fetches observed at the network boundary; no synthetic counter increment stands in for replay. Keep `api.test.ts` assertions that POST policy is `refresh-no-replay` and never automatically reissues the request.

Playwright route-count test must assert exactly two initial bulk POSTs (first acknowledged, second failed), one refresh POST, zero replacement bulk POST before user click, and one replacement POST after **Retry remaining**. Assert partial export action/model remains visible before and after refresh. A second browser test aborts all joined UI requests at the entered refresh barrier and asserts one refresh abort, no replacement bulk POST, and no post-abort account/grant/reconnect-status/query-invalidation event.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/bulk-lookup.test.ts src/lib/api.test.ts src/lib/vnu-refresh.test.ts
```

Expected: FAIL because `restoredWithoutReplay`, joined-flight entered observers, cancellation generation guards, and client-only recovery classification do not exist.

- [ ] **Step 3: Add explicit client-only restored state**

Change execution type:

```ts
export type BulkLookupExecution = {
  progress: BulkLookupProgress;
  remainingTargets: string[];
  error?: unknown;
  aborted: boolean;
  restoredWithoutReplay: boolean;
};
```

Every return sets `restoredWithoutReplay`. In request catch:

```ts
const restoredWithoutReplay = error instanceof ApiError && error.code === VNU_REQUEST_NOT_REPLAYED;
return {
  progress,
  remainingTargets: options.targets.slice(completedTargets),
  error: options.signal.aborted || restoredWithoutReplay ? undefined : error,
  aborted: options.signal.aborted,
  restoredWithoutReplay,
};
```

Normal/validation/cancel returns use `false`. This signal is browser control flow only; do not invent or request a Worker error.

In `lookup.tsx` add `restoredWithoutReplay` state. After execution:

- retain `progress`, export model, prior acknowledged items, pagination, and failed chunk/later `remainingTargets`;
- set manual **Retry remaining** state when true;
- stop loop; do not invoke bulk API again;
- user click starts a new `run()` and `api.ts` captures current rotated token then;
- cancellation/account switch generation guards keep late refresh and chunk results inert;
- reset/new input/mode switch clears restored state;
- no repeated toast; use existing polite bulk region.

Cancellation semantics are separate from restored-without-replay semantics. `executeBulkLookup()` must pass its caller signal into the real chunk request; cancellation while `request()` is waiting on shared refresh releases only that waiter. It returns `aborted:true`, retains every item acknowledged before the failed chunk, and returns the entire failed chunk plus all later targets in `remainingTargets`. It never treats cancellation as `restoredWithoutReplay`, never submits a replacement chunk, and never clears export state. `runVnuRefresh()` commits/replays only while at least one waiter remains; when all leave it aborts the shared controller and its generation/waiter guard rejects a late successful network result before account, grant, status, or invalidation side effects.

Add copy:

```ts
bulkSessionRestored: "VNU reconnected. Review the saved results, then retry the remaining targets.",
```

```ts
bulkSessionRestored: "Đã kết nối lại với VNU. Hãy kiểm tra kết quả đã lưu, rồi thử lại các mục còn lại.",
```

- [ ] **Step 4: Run GREEN and focused serial E2E**

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/bulk-lookup.test.ts src/lib/api.test.ts src/lib/vnu-refresh.test.ts
pnpm --filter @hyeboard/web typecheck
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --workers=1 --grep "bulk.*refresh"
```

Expected: PASS. Network-call records prove exactly two original bulk POSTs with the failed token, one shared refresh POST, one original safe GET with the failed token, one replayed safe GET with the rotated token, and zero rotated-token/replacement bulk POSTs before manual action. Separate cancellation coverage proves one shared abort when all waiters cancel and one new-token POST on manual retry. Entered-flight promises make every join/cancellation assertion deterministic.

- [ ] **Step 5: Commit Task 7 only**

```bash
git add apps/web/src/lib/bulk-lookup.ts apps/web/src/lib/bulk-lookup.test.ts apps/web/src/lib/api.test.ts apps/web/src/lib/vnu-refresh.test.ts apps/web/src/pages/lookup.tsx apps/web/src/lib/i18n.tsx apps/web/tests/smoke.spec.ts
git diff --cached --check
git commit -m "feat(web): preserve bulk progress through VNU reconnect"
```

---

### Task 8: Document Boundaries and Run Exhaustive Verification

**Files:**
- Modify: `README.md:20-27,56-74`
- Modify: `docs/architecture.md:21-42`
- Modify: `docs/har-security.md`
- Verify only: every Task 1-7 allowlisted file

- [ ] **Step 1: Update user/operator documentation**

Add this subsection under `README.md` Security:

```markdown
### VNU reconnect grants

Successful VNU sign-in returns an ordinary access token and a separate encrypted reconnect grant. The browser stores the grant only in the current tab's `sessionStorage`, keyed by Hyeboard's opaque local account ID. A new tab or browser restart requires manual VNU sign-in after upstream expiry.

Reconnect grants have a fixed eight-hour lifetime from manual sign-in. Rotation does not extend that lifetime. Cloudflare deployments serialize refresh attempts plus linked access/grant activation and revocation through `VNU_REFRESH_CONTROL`. Self-hosted Node/Bun deployments have no equivalent durable authority: they issue no reconnect grant or linked descriptor, provide no automatic refresh, and retain existing access-session behavior without claiming exact revocation.
```

Add this architecture section:

```markdown
## VNU Automatic Relogin

VNU access tokens and reconnect grants are separate AES-GCM protocols. Grant keys use an HKDF context distinct from access-token encryption. Grants contain the VNU credentials needed for one tab's reconnect flow; access tokens do not.

`VnuRefreshControlDurableObject` is addressed by an HMAC-derived normalized-username principal. It stores random access-token IDs, grant IDs, expiry, a two-minute lease, and a five-attempt/fifteen-minute window—never credentials, raw tokens, or student identity. The encrypted access descriptor carries the opaque principal, exact linked IDs, and both expiries, so logout can atomically revoke its exact active pair even when a new tab has no browser grant. Logout validates any optional grant completely before its sole authoritative revoke call. A fully expired authenticated descriptor remains an idempotent access-only removal proof after authority cleanup, while any live-half mismatch fails closed. Every authority transition reports changed/no-op; no-op operations write neither state nor alarms. Active ordinary checks read authority without rewriting state or alarms; stale cleanup enters a transaction once. Refresh cryptographically decodes the outer access token through a refresh-only path, rejects principal/link mismatches without mutation, checks authority, performs one live login, verifies the live profile, and atomically revokes the old pair while activating the new pair before returning. Ordinary descriptor-bearing session resolution also checks this authority and fails closed when unavailable.

The browser coordinates one refresh per local account and failed access token. It replays only explicit side-effect-free VNU reads once. Bulk and charged cross-lookups may refresh but require a manual retry; acknowledged browser results and exports remain intact.
```

Add to `docs/har-security.md`:

```markdown
## Reconnect grant handling

Treat encrypted VNU reconnect grants as credentials. Never paste them into issues, logs, screenshots, HAR samples, query strings, exports, analytics, or test fixtures. Browser storage is limited to `sessionStorage` keys prefixed with `hyeboard.vnu.refreshGrant.`; new VNU server logs contain only stable operation, code, and status fields.
```

- [ ] **Step 2: Verify every task's focused suite and independent typecheck**

Run serially from worktree root:

```bash
pnpm --filter @hyeboard/core test
pnpm --filter @hyeboard/schemas test
pnpm --filter @hyeboard/university-adapters test
pnpm --filter @hyeboard/worker exec vitest run src/vnu-refresh-control.test.ts src/app.test.ts
pnpm --filter @hyeboard/worker test:workers
pnpm --filter @hyeboard/worker typecheck
pnpm --filter @hyeboard/web exec vitest run src/lib/vnu-refresh.test.ts src/lib/api.test.ts src/lib/bulk-lookup.test.ts
pnpm --filter @hyeboard/web typecheck
```

Expected: every command exits `0`; no skipped focused test introduced by this feature.

- [ ] **Step 3: Regenerate/verify Wrangler types and migration before build**

```bash
pnpm --filter @hyeboard/worker exec wrangler types
git diff --exit-code apps/worker/worker-configuration.d.ts
pnpm build:web
pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run
```

Expected: generated types unchanged after regeneration; frontend assets exist for Wrangler validation; `wrangler deploy --dry-run` executes validation/packaging only, exits `0`, lists `VNU_REFRESH_CONTROL`, and performs no live deployment. Migration order remains `v1` CAPTCHA, `v2` probe budget, `v3` refresh control.

- [ ] **Step 4: Run complete build, tests, Node package checks, and serial Playwright**

```bash
pnpm build
pnpm test
pnpm package
pnpm --filter @hyeboard/worker check:node-package
pnpm --filter @hyeboard/web exec playwright test --workers=1
```

Expected:

- build, all package tests, package assembly, and Node package check exit `0`;
- self-host Node package type/build remains valid; it issues access-only legacy VNU sessions, offers no auto-refresh/exact revocation, and fails closed if a descriptor-bearing token appears;
- Chromium and mobile-safari Playwright projects pass serially;
- no live deployment occurs; only the explicit Wrangler dry-run deploy command runs.

- [ ] **Step 5: Run immutable-baseline file allowlist and secret/privacy scans**

```bash
$BASE_SHA = "c0cdaf6"
git merge-base --is-ancestor $BASE_SHA HEAD
git diff --name-only "$BASE_SHA...HEAD" | Sort-Object
git diff --check "$BASE_SHA...HEAD"
git diff "$BASE_SHA...HEAD" -- . ':!docs/superpowers/plans/2026-07-28-vnu-automatic-relogin.md' | rg -n '([0-9]{8}|[0-9]{11})'
git diff "$BASE_SHA...HEAD" -- apps packages | rg -n 'console\.(log|debug|info|warn|error).*?(grant|token|password|username|student|profile|body)|localStorage.*refreshGrant|hyeboard\.relogin\.vnu\.(username|password).*setItem|refreshGrant.*(URLSearchParams|queryKey|href|searchParams|Export|analytics)'
git diff "$BASE_SHA...HEAD" -- apps packages | rg -n 'T[B]D|T[O]DO|implement[[:space:]]+later|fill[[:space:]]+in[[:space:]]+details|similar[[:space:]]+to[[:space:]]+Task'
git status --short
```

Expected:

- ancestor command exits `0`;
- changed paths are only this plan plus Task 1-8 file map paths;
- `diff --check` exits `0`;
- identity-shaped scan has no new test constants; if production regexes such as `^\d{8}$` or duration arithmetic match, classify each line in final report without copying any sensitive value;
- privacy and placeholder scans return no matches;
- status contains only `?? docs/superpowers/plans/2026-07-28-vnu-automatic-relogin.md`; the user required this plan to remain uncommitted.

Exact implementation allowlist:

```text
README.md
docs/architecture.md
docs/har-security.md
docs/superpowers/plans/2026-07-28-vnu-automatic-relogin.md
packages/core/src/index.ts
packages/core/src/session.test.ts
packages/schemas/src/index.ts
packages/university-adapters/src/vnu/adapter.ts
apps/worker/src/app.ts
apps/worker/src/app.test.ts
apps/worker/src/index.ts
apps/worker/src/vnu-refresh-control.ts
apps/worker/src/vnu-refresh-control.test.ts
apps/worker/src/vnu-refresh-control-durable-object.ts
apps/worker/test/captcha-relay-worker.ts
apps/worker/test/vnu-refresh-control-durable-object.workers.ts
apps/worker/src/vnu-student-id-resolver.test.ts
apps/worker/vitest.workers.config.ts
apps/worker/wrangler.jsonc
apps/worker/worker-configuration.d.ts
apps/web/src/components/layout.tsx
apps/web/src/lib/api-types.ts
apps/web/src/lib/api.ts
apps/web/src/lib/api.test.ts
apps/web/src/lib/bulk-lookup.ts
apps/web/src/lib/bulk-lookup.test.ts
apps/web/src/lib/i18n.tsx
apps/web/src/lib/vnu-refresh.ts
apps/web/src/lib/vnu-refresh.test.ts
apps/web/src/main.tsx
apps/web/src/pages/login.tsx
apps/web/src/pages/lookup.tsx
apps/web/src/pages/settings.tsx
apps/web/src/state.tsx
apps/web/tests/smoke.spec.ts
```

Any other changed file fails scope review. Do not include generated build/package output.

- [ ] **Step 6: Manual EN/VI, theme, responsive, and race check**

Start only local dev:

```bash
pnpm dev
```

Check desktop `1440×900` and mobile `390×844`, light/dark, English/Vietnamese:

1. VNU login input changes create no plaintext storage entries.
2. Successful coordinator-backed login creates one per-account opaque `sessionStorage` grant; Node/Bun access-only login creates none; neither mode writes a localStorage grant.
3. Safe read expiry shows one polite reconnect status, keeps visible data, refreshes once, then clears status.
4. `VNU_PROFILE_INCOMPLETE` stays inline and performs no refresh request.
5. Charged lookup and bulk refresh once but do not replay; bulk keeps prior rows/export and shows **Retry remaining**.
6. Switching account during refresh makes late result inert.
7. Cancelling one joined caller does not cancel another; cancelling all aborts refresh and produces no late mutation.
8. Failed active/nonactive VNU removal retains exact account/grant and shows retryable copy.
9. Successful nonactive removal never sends active token/grant.
10. New tab has no grant and falls back to manual VNU sign-in for refresh, but active and inactive account removal still succeeds from its descriptor-bearing token both after outward access expiry while the grant remains live and after both linked expiries plus lazy authority cleanup.
11. UET inline reauthentication, CAPTCHA, account switch, and logout behavior remain unchanged.
12. Status text fits mobile, remains nonblocking, uses no repeated toast, and has `role="status"`/`aria-live="polite"`.

Stop dev server after checks. Expected: all checks pass in both locales/themes/viewports.

- [ ] **Step 7: Commit documentation and verification record only**

Do not add generated output or test artifacts.

```bash
git add README.md docs/architecture.md docs/har-security.md
git diff --cached --check
git commit -m "docs: document VNU automatic relogin boundaries"
git status --short
```

Expected: eighth implementation commit. Status contains only the untracked plan file. The plan must not be included in any implementation commit unless the user separately requests committing it.

## Final Acceptance Checklist

- [ ] Grant payload is exact-purpose/version/university validated, 128-bit-ID minimum, random-IV AES-GCM, HKDF-domain-separated from access token, fixed eight hours, and rotation does not extend expiry.
- [ ] Durable Object stores no credentials/identity/raw token; linked access/grant state changes are transactional; five attempts/fifteen minutes and two-minute lease are authoritative; old access and grant IDs remain revoked through expiry.
- [ ] Manual cache hit still uses submitted credentials only after live identity verification; coordinator mode returns both artifacts only after atomic linked-pair activation.
- [ ] Refresh/logout-only decoders validate outer token AEAD/shape and descriptor even when outward `expiresAt` passed; ordinary requests still reject outward expiry. Descriptor contains exact linked IDs/expiries, permitting grantless active/inactive/new-tab removal.
- [ ] Principal or grant-link mismatch rejects with no mutation; a cryptographically linked pre-lease student mismatch uses exact linked-pair revocation; post-lease live mismatch uses terminal abort of the leased pair.
- [ ] Response-delivery loss after complete leaves old access/grant pair revoked; logout validates any optional grant before its sole `revokeLinkedPairByAccess` mutation, remains idempotent for an authenticated fully expired pair after cleanup, defeats leased/late rotation, and never revokes a mismatched current pair.
- [ ] Every authority transition returns explicit changed/no-op. Mismatch, repeat, already-revoked, and fully expired no-ops perform zero `put`/alarm changes; repeated active `checkAccess()` performs direct authoritative reads; stale cleanup writes once; corrupted/storage/RPC failures sanitize to `VNU_REFRESH_UNAVAILABLE`.
- [ ] `HyeboardError.details` remains internal `unknown`; every JSON response boundary emits details only after full `apiErrorDetailsSchema.safeParse()` success. UET SSE remains unchanged.
- [ ] Import returns `{account, auth}` and stores grant under created/upserted local ID before one account event; rollback leaves no partial local state.
- [ ] VNU credentials remain component state only until request completion and never persist as plaintext.
- [ ] Active/nonactive removal awaits exact-account revocation; failure retains unchanged local state.
- [ ] Single-flight key includes account ID and failed token; waiter cancellation is reference-counted; outcome is discriminated `committed|stale`; stale causes no mutation, replay, no-replay-success, or invalidation.
- [ ] Replay policy classifies `{method,pathname}`; only explicit safe GETs replay once with original signal/parameters and internal `noRefresh`; every non-GET defaults never and charged GET/bulk POST never replay.
- [ ] Internal non-wire attempted-refresh marker suppresses Query retries for every post-attempt failure, including 429, 503, upstream, network, and timeout errors.
- [ ] Bulk retains acknowledged/export state and entire failed chunk/later targets. Real joined-flight tests send the survivor's recoverable GET and rotated-token replay through production `request()`, prove one shared refresh and zero bulk replay, and separately prove all-waiter cancellation aborts once and blocks every late mutation/replacement POST.
- [ ] No encrypted refresh grant exists in localStorage, Query cache/key, URL, export, log, diagnostics, analytics, or error details; internal descriptor IDs remain encrypted and never surface.
- [ ] New tab has no grant; absent grant performs no auto-refresh, but encrypted-descriptor logout still removes active or inactive VNU accounts authoritatively before expiry and idempotently after both linked expiries plus lazy authority cleanup.
- [ ] `VNU_PROFILE_INCOMPLETE` never refreshes; `VNU_LOGIN_REQUIRED` refreshes only for exact `MISSING_VNU_CREDENTIAL` reason.
- [ ] UET behavior unchanged.
- [ ] Full build/tests/serial E2E/Wrangler dry-run/Node package checks pass.

## Plan Self-Review Record

- Spec coverage: Tasks 1-8 map every approved design section—grant crypto, authoritative state, recoverability, routes, browser races/replay, UI/account lifecycle, bulk semantics, privacy/docs/verification.
- Placeholder scan: implementation steps contain concrete paths, contracts, snippets, commands, and expected results. No deferred implementation marker remains.
- Type/signature consistency: `AuthResult`, `ApiErrorDetails`, `VnuRefreshGrantPayload`, `VnuRefreshAccessDescriptor`, `LinkedPair`, `AccessDescriptorRef`, `BeginRefreshResult`, `VnuRefreshOutcome`, `VNU_REQUEST_NOT_REPLAYED`, account mutation, and coordinator methods keep one spelling and shape across tasks.
- Error consistency: exact reason and all six refresh error codes match the protocol table; client-only no-replay code never crosses Worker boundary.
- Account/query consistency: refresh commit occurs only in `commitVnuRefresh`; coordinator owns the sole success invalidation; joined callers do neither.
- Graph consistency: `api-types.ts` breaks the web ESM cycle; Worker-safe contracts never import the Cloudflare Durable Object module; Node graph reaches only `app.ts` plus Worker-safe control code.
- Authority consistency: one `LinkedPair` Durable Object owns access/grant activation, rotation, exact descriptor revocation, and mismatch handling; no best-effort cache participates for descriptor-bearing tokens. Principal/link mismatch cannot mutate; exact pre-lease identity mismatch revokes only its pair; descriptor-bearing resolution fails closed; legacy/self-host behavior makes no exact-revocation claim.
- Logout-order consistency: route authenticates descriptor, validates supplied grant principal/student/link/expiry with zero authority calls on mismatch, then invokes only `revokeLinkedPairByAccess`. No validation branch can mutate before this point.
- Mutation consistency: every transition returns `changed`; transactional persistence and alarm updates occur only for `changed:true`. Exact storage counters cover all mutation/no-op classes, including mismatch, idempotent repeat, already-revoked, and fully expired pairs.
- Expired-removal consistency: only an authenticated exact descriptor with both pair expiries passed may map absent cleaned state to `expired` success. Any live-half mismatch fails closed. Worker plus active/inactive new-tab tests cover pre-cleanup and post-cleanup states.
- Read-path consistency: active `checkAccess()` uses direct parsed storage read with zero put/alarm mutation; only exact stale-state inequality retries one cleanup transaction. Counting-adapter and Workers tests cover repeated reads, one-time cleanup, corruption, storage failure, alarm failure, and RPC failure.
- Bulk-cancellation consistency: joined survivor integration executes the failed bulk chunk and recoverable safe GET through production `request()`, records exact original/replay fetches and tokens, shares one deferred refresh, retains the first chunk plus remaining targets, and proves zero bulk replay. Separate all-waiter coverage proves abort and late-result inertness; Playwright verifies POST counts and retained export/UI state without sleeps.
- Privacy consistency: internal error details remain `unknown`, every JSON boundary fully safe-parses details, VNU logs use operation/code/status only, and UET SSE files remain outside the allowlist.
- Migration consistency: immutable `v1`/`v2`, additive `v3`, then Wrangler regeneration before dry-run.
- Command validity: each task's RED/GREEN/typecheck command is independently invocable from the stated worktree root and names an existing package script or local binary. Scripts were checked against root, core, schemas, university-adapters, worker, and web `package.json`; no command depends on a prior shell variable except the explicitly re-declared `$BASE_SHA`; existing Worker `test:workers`/Miniflare setup is extended rather than recreated; Playwright uses existing `tests/smoke.spec.ts` and serial `--workers=1`.
- Regression review: canonical ISO validation remains exact; sanitized details/logging remains JSON-boundary-only; `committed|stale` discriminant and non-wire refresh-attempt Query marker remain intact; replay remains method/path aware; Workers bindings/tests and Cloudflare-only import boundary remain intact; commands remain direct pnpm/PowerShell-safe with exact per-task file lists and independent typechecks.
- Baseline/scope consistency: final scans remain anchored to immutable `c0cdaf6`; only listed worktree paths are allowed; outside-worktree dirty runtime config is excluded.

## Final Boundary

After Task 8, stop. Report eight commit hashes, verification commands/results, manual matrix, allowlist output, and any classified scan matches. Do **not** push, perform a live deployment, run `pnpm deploy`, amend, merge, rebase, or modify the main worktree. The one allowed deploy-named command is Task 8's `wrangler deploy --dry-run`, which performs no live deployment.
