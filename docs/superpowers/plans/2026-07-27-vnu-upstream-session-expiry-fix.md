# VNU Upstream Session Expiry Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect expired daotao sessions reliably, validate cached VNU imports against the live profile, recover only from definitive expiry or identity mismatch, and clear frontend VNU state only for `VNU_SESSION_EXPIRED`.

**Architecture:** Keep one allow-listed expiry detector in the VNU adapter and call it from every successful `DaotaoClient.fetchPage()` response before HTML reaches callers or caches. Restore cached imports as decrypted payloads, validate them with a direct profile fetch, and reuse or repair them without changing route envelopes, token lifetimes, raw-cache TTLs, or cookie-derived cache keys. Extend the existing central frontend session-death classifier so current account removal and navigation behavior handles VNU expiry without broad error reclassification.

**Tech Stack:** TypeScript, Vitest, Elysia, Cloudflare Cache API-compatible storage, Web Crypto session encryption, React/Vite, Playwright, pnpm.

---

## File map

- Create `packages/university-adapters/src/vnu/session-expiry-fixtures.ts`: synthetic, non-personal HTML fixtures for the two login-form variants and standalone session-ended notice.
- Modify `packages/university-adapters/src/vnu/parser.ts:22-37,445-447`: add URL/body-aware `isDaotaoSessionExpired(finalUrl, html)` detector and remove the single-field `hasLoginForm()` classifier.
- Modify `packages/university-adapters/src/vnu/parser.test.ts`: add focused detector matches and non-matches.
- Create `packages/university-adapters/src/vnu/daotao-client.test.ts`: prove detector integration and preserve HTTP/network error precedence.
- Modify `packages/university-adapters/src/vnu/daotao-client.ts:7-40`: run expiry classification after status handling and before returning HTML.
- Modify `apps/worker/src/app.ts:602-657,695-748,907-923`: restore decrypted cache payloads, validate cached profiles live, recover through the existing adapter import, and preserve cache/raw-cache behavior.
- Modify `apps/worker/src/app.test.ts:44-173,374-603`: cover valid cache reuse, expiry repair, identity mismatch, transient failures, recovery failure, runtime expiry, and fresh-cookie raw-cache isolation.
- Modify `apps/web/src/lib/api.ts:23-31`: add `VNU_SESSION_EXPIRED` to the explicit terminal session-code set.
- Modify `apps/web/tests/smoke.spec.ts:97-117,623-679`: prove VNU expiry removes the active account and redirects while relogin credentials survive; prove representative other VNU errors remain inline.

## Constraints to preserve throughout

- Keep all route paths, request bodies, success payloads, error envelopes, and HTTP status mappings unchanged.
- Preserve cached seed format, credential-derived HMAC cache key, original `expiresAt`, independent outward encryption, exact-token revocation, and cookie-derived raw-cache keys.
- Validate cache hits with `new DaotaoClient(restored.payload).getProfileHtml()` directly; never call `vnuRawHtml()` for import validation.
- Catch only `HyeboardError` with code `VNU_SESSION_EXPIRED` as an exception-driven cache repair signal. Missing/mismatched profile identity falls through to fresh login; every other thrown error propagates unchanged.
- Write no credentials, cookies, decrypted sessions, HTML, or identities to logs. Use only the synthetic values shown below.
- Do not add retries, cache eviction, lifetime extension, generic content classification, or broad auth/parser refactors.

### Task 1: Add the allow-listed VNU expiry detector

**Files:**
- Create: `packages/university-adapters/src/vnu/session-expiry-fixtures.ts`
- Modify: `packages/university-adapters/src/vnu/parser.test.ts`
- Modify: `packages/university-adapters/src/vnu/parser.ts:22-37,445-447`

- [ ] **Step 1: Create sanitized detector fixtures**

Create `packages/university-adapters/src/vnu/session-expiry-fixtures.ts` with synthetic markup only:

```ts
export const VNU_LOGIN_FORM_DOUBLE_QUOTED = `
  <html><body>
    <form action="/dkmh/login.asp" method="post">
      <input type="text" name="txtLoginId" autocomplete="username">
      <input type="password" name="txtPassword" autocomplete="current-password">
    </form>
  </body></html>
`;

export const VNU_LOGIN_FORM_MIXED_ATTRIBUTES = `
  <HTML><BODY>
    <FORM method='POST' action='/dkmh/login.asp'>
      <INPUT class='credential' NAME = 'TXTLOGINID' data-order='changed' TYPE = 'text'>
      <input value='' TYPE = "PASSWORD" aria-label='Password' name = 'txtPassword'>
    </FORM>
  </BODY></HTML>
`;

export const VNU_SESSION_ENDED_NOTICE_HTML = `
  <html>
    <body>
      <table class="portal-notice" cellspacing="0">
        <tbody><tr><td align="center">
          <font color="#ff0000"><strong>
            Phi&#234;n l&#224;m vi&#7879;c &#273;&#227; k&#7871;t th&#250;c.&nbsp;
            Vui l&#242;ng <span>&#273;&#259;ng nh&#7853;p l&#7841;i</span> h&#7879; th&#7889;ng.
          </strong></font>
        </td></tr></tbody>
      </table>
    </body>
  </html>
`;
```

This fixture normalizes to the exact allow-listed sentence `Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.` and contains no headers, credentials, cookies, tokens, or student data.

- [ ] **Step 2: Write failing detector tests**

Extend the imports in `packages/university-adapters/src/vnu/parser.test.ts` and append this suite:

```ts
import { isDaotaoSessionExpired, parseGradesHtml, parseTranscriptHtml } from "./parser";
import {
  VNU_LOGIN_FORM_DOUBLE_QUOTED,
  VNU_LOGIN_FORM_MIXED_ATTRIBUTES,
  VNU_SESSION_ENDED_NOTICE_HTML,
} from "./session-expiry-fixtures";

describe("isDaotaoSessionExpired", () => {
  const profileUrl = "https://daotao.vnu.edu.vn/StdInfo/TabStdSelf.asp";

  it("accepts the trusted final login URL regardless of path casing or query", () => {
    expect(isDaotaoSessionExpired(
      "https://daotao.vnu.edu.vn/DKMH/LOGIN.ASP?returnUrl=%2FStdInfo%2FTabStdSelf.asp",
      "<html><body></body></html>",
    )).toBe(true);
  });

  it("rejects a login-looking final URL on another origin", () => {
    expect(isDaotaoSessionExpired(
      "https://example.invalid/dkmh/login.asp?returnUrl=daotao.vnu.edu.vn",
      "<html><body></body></html>",
    )).toBe(false);
  });

  it.each([
    ["double-quoted form", VNU_LOGIN_FORM_DOUBLE_QUOTED],
    ["mixed-case reordered form", VNU_LOGIN_FORM_MIXED_ATTRIBUTES],
  ])("accepts the %s only when both credential controls are present", (_label, html) => {
    expect(isDaotaoSessionExpired(profileUrl, html)).toBe(true);
  });

  it.each([
    ["username only", `<input name="txtLoginId" value="mentioned-only">`],
    ["password only", `<input type="password" name="txtPassword">`],
    ["plain login prose", `<p>Login and session help</p>`],
  ])("rejects %s", (_label, html) => {
    expect(isDaotaoSessionExpired(profileUrl, html)).toBe(false);
  });

  it("accepts the complete standalone session-ended notice", () => {
    expect(isDaotaoSessionExpired(profileUrl, VNU_SESSION_ENDED_NOTICE_HTML)).toBe(true);
  });

  it.each([
    ["authenticated profile", `<html><body><input name="StdCode" value="SYNTHETIC-STUDENT-001"></body></html>`],
    ["unrelated red notice", `<html><body><table><tr><td><font color="red">Không tìm thấy dữ liệu.</font></td></tr></table></body></html>`],
    ["partial session notice", `<html><body><table><tr><td>Phiên làm việc đã kết thúc.</td></tr></table></body></html>`],
    ["notice embedded in a normal page", `<html><body><nav>Portal</nav><table><tr><td>Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.</td></tr></table><main>Authenticated content</main></body></html>`],
  ])("does not classify %s", (_label, html) => {
    expect(isDaotaoSessionExpired(profileUrl, html)).toBe(false);
  });
});
```

Replace the original `parseGradesHtml`/`parseTranscriptHtml` import instead of adding a duplicate import.

- [ ] **Step 3: Run the detector tests and confirm RED**

Run from repository root:

```bash
pnpm --filter @hyeboard/university-adapters exec vitest run src/vnu/parser.test.ts
```

Expected: FAIL at module load because `./parser` does not export `isDaotaoSessionExpired`.

- [ ] **Step 4: Implement the minimal detector**

In `packages/university-adapters/src/vnu/parser.ts`, extend `decodeEntities`, add the detector helpers near `stripTags`, and replace `hasLoginForm()` with the exported detector:

```ts
const DAOTAO_ORIGIN = "https://daotao.vnu.edu.vn";
const DAOTAO_LOGIN_PATH = "/dkmh/login.asp";
const SESSION_ENDED_NOTICE_TEXT = "Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.";

function decodeNumericEntity(entity: string, digits: string, radix: 10 | 16): string {
  const codePoint = Number.parseInt(digits, radix);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : entity;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (entity, hex: string) => decodeNumericEntity(entity, hex, 16))
    .replace(/&#(\d+);/g, (entity, decimal: string) => decodeNumericEntity(entity, decimal, 10))
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "));
}

function quotedAttribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match?.[1] ?? match?.[2];
}

function hasCredentialControlPair(html: string): boolean {
  const inputTags = html.match(/<input\b[^>]*>/gi) ?? [];
  const names = new Set(inputTags.map((tag) => quotedAttribute(tag, "name")?.toLowerCase()).filter(Boolean));
  return names.has("txtloginid") && names.has("txtpassword");
}

function hasStandaloneSessionEndedNotice(html: string): boolean {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1];
  if (!body) return false;
  const tableCount = body.match(/<table\b/gi)?.length ?? 0;
  const noticeStructure = /<table\b[^>]*>[\s\S]*?<tr\b[^>]*>[\s\S]*?<td\b[^>]*>[\s\S]*?<\/td>[\s\S]*?<\/tr>[\s\S]*?<\/table>/i.test(body);
  const hasInteractivePageControls = /<(?:form|input|select|textarea)\b/i.test(body);
  return tableCount === 1
    && noticeStructure
    && !hasInteractivePageControls
    && stripTags(body) === SESSION_ENDED_NOTICE_TEXT;
}

export function isDaotaoSessionExpired(finalUrl: string, html: string): boolean {
  try {
    const url = new URL(finalUrl);
    if (url.origin.toLowerCase() === DAOTAO_ORIGIN && url.pathname.toLowerCase() === DAOTAO_LOGIN_PATH) return true;
  } catch {
    // An absent or malformed final URL is not expiry evidence; body checks still apply.
  }
  return hasCredentialControlPair(html) || hasStandaloneSessionEndedNotice(html);
}
```

Delete the old export:

```ts
export function hasLoginForm(html: string): boolean {
  return html.includes('name="txtLoginId"') || html.includes("name='txtLoginId'");
}
```

- [ ] **Step 5: Run focused tests and confirm GREEN**

```bash
pnpm --filter @hyeboard/university-adapters exec vitest run src/vnu/parser.test.ts
```

Expected: PASS for all existing transcript tests and every detector match/non-match.

- [ ] **Step 6: Run adapter typecheck**

```bash
pnpm --filter @hyeboard/university-adapters exec tsc -p tsconfig.json --noEmit
```

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 7: Request fresh specification-compliance review**

Use a fresh review subagent with this exact scope: compare Task 1 changes against design sections “Expired-response detector,” “Security and privacy,” and “VNU detector and client.” Require explicit checks for trusted-origin URL matching, paired controls, full standalone notice, all listed non-matches, and synthetic fixtures. Expected result: `APPROVED` with no missing requirement; resolve any concrete finding and rerun Steps 5-6 before continuing.

- [ ] **Step 8: Request fresh code-quality review**

Use a different fresh review subagent. Limit review to the three Task 1 files. Require checks for catastrophic/backtracking-prone regexes, malformed URL safety, entity normalization, false-positive breadth, fixture privacy, and exact signature consistency. Expected result: `APPROVED`; resolve any concrete finding and rerun Steps 5-6.

- [ ] **Step 9: Commit the detector slice**

```bash
git add packages/university-adapters/src/vnu/session-expiry-fixtures.ts packages/university-adapters/src/vnu/parser.ts packages/university-adapters/src/vnu/parser.test.ts
git commit -m "fix(vnu): detect expired portal responses"
```

Expected: one scoped commit containing only detector fixtures, tests, and implementation.

### Task 2: Enforce expiry detection inside `DaotaoClient`

**Files:**
- Create: `packages/university-adapters/src/vnu/daotao-client.test.ts`
- Modify: `packages/university-adapters/src/vnu/daotao-client.ts:7-40`

- [ ] **Step 1: Write failing client integration tests**

Create `packages/university-adapters/src/vnu/daotao-client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaotaoClient } from "./daotao-client";
import { VNU_SESSION_ENDED_NOTICE_HTML } from "./session-expiry-fixtures";

function upstreamResponse(
  body: string,
  status = 200,
  finalUrl = "https://daotao.vnu.edu.vn/StdInfo/TabStdSelf.asp",
): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

describe("DaotaoClient expiry handling", () => {
  const fetchMock = vi.fn<typeof fetch>();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    ["followed trusted login redirect", upstreamResponse("<html></html>", 200, "https://daotao.vnu.edu.vn/dkmh/login.asp?return=profile")],
    ["HTTP 200 standalone notice", upstreamResponse(VNU_SESSION_ENDED_NOTICE_HTML)],
  ])("throws VNU_SESSION_EXPIRED for a %s", async (_label, response) => {
    fetchMock.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DaotaoClient().getProfileHtml()).rejects.toMatchObject({
      code: "VNU_SESSION_EXPIRED",
      status: 401,
    });
  });

  it("returns normal authenticated HTML unchanged", async () => {
    const html = `<input name="StdCode" value="SYNTHETIC-STUDENT-001">`;
    fetchMock.mockResolvedValueOnce(upstreamResponse(html));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DaotaoClient().getProfileHtml()).resolves.toBe(html);
  });

  it.each([
    ["429", upstreamResponse(VNU_SESSION_ENDED_NOTICE_HTML, 429), "VNU_RATE_LIMITED", 429],
    ["upstream 503", upstreamResponse(VNU_SESSION_ENDED_NOTICE_HTML, 503), "VNU_UPSTREAM_UNAVAILABLE", 502],
    ["non-expiry 403", upstreamResponse("Forbidden", 403), "VNU_REQUEST_FAILED", 403],
  ])("keeps %s status mapping ahead of body classification", async (_label, response, code, status) => {
    fetchMock.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DaotaoClient().getProfileHtml()).rejects.toMatchObject({ code, status });
  });

  it("keeps network failures mapped to VNU_UPSTREAM_UNAVAILABLE", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("synthetic network failure"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DaotaoClient().getProfileHtml()).rejects.toMatchObject({
      code: "VNU_UPSTREAM_UNAVAILABLE",
      status: 502,
    });
  });
});
```

- [ ] **Step 2: Run the client tests and confirm RED**

```bash
pnpm --filter @hyeboard/university-adapters exec vitest run src/vnu/daotao-client.test.ts
```

Expected: FAIL because the standalone notice and final login URL return HTML instead of throwing `VNU_SESSION_EXPIRED`.

- [ ] **Step 3: Replace the old form-only call with the unified detector**

Change the parser import and successful-response block in `packages/university-adapters/src/vnu/daotao-client.ts`:

```ts
import { isDaotaoSessionExpired } from "./parser";
```

```ts
if (response.status === 429) throw new HyeboardError("VNU_RATE_LIMITED", "daotao.vnu.edu.vn is rate-limiting requests. Wait a few minutes and try again.", 429);
if (response.status >= 500) throw new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", `daotao.vnu.edu.vn returned ${response.status}. Try again later.`, 502);
if (!response.ok) throw new HyeboardError("VNU_REQUEST_FAILED", `daotao.vnu.edu.vn rejected the request with HTTP ${response.status}.`, response.status);
const html = await response.text();
if (isDaotaoSessionExpired(response.url, html)) {
  throw new HyeboardError("VNU_SESSION_EXPIRED", "The university portal session has expired. Sign in again.", 401);
}
return html;
```

Status handling remains before `response.text()` and classification. Every page method already funnels through `fetchPage()`, so no per-method changes are needed.

- [ ] **Step 4: Run both focused adapter suites and confirm GREEN**

```bash
pnpm --filter @hyeboard/university-adapters exec vitest run src/vnu/parser.test.ts src/vnu/daotao-client.test.ts
```

Expected: PASS; expiry signals throw 401, normal HTML returns unchanged, and 429/503/403/network mappings retain their prior code/status.

- [ ] **Step 5: Run adapter typecheck**

```bash
pnpm --filter @hyeboard/university-adapters exec tsc -p tsconfig.json --noEmit
```

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 6: Request two-stage review**

First use a fresh specification reviewer to verify detector placement after HTTP handling and before return, all page methods covered through `fetchPage()`, and no outward error-shape change. After approval, use a different fresh code-quality reviewer to inspect fetch mocking, status precedence, response URL handling, and absence of raw HTML in thrown errors. Expected for each stage: `APPROVED`; resolve concrete findings and rerun Steps 4-5.

- [ ] **Step 7: Commit the client integration slice**

```bash
git add packages/university-adapters/src/vnu/daotao-client.ts packages/university-adapters/src/vnu/daotao-client.test.ts
git commit -m "test(vnu): enforce session expiry in client"
```

Expected: one scoped commit containing client integration and its tests.

### Task 3: Validate VNU import cache hits and repair definitive expiry

**Files:**
- Modify: `apps/worker/src/app.test.ts:44-173,374-603`
- Modify: `apps/worker/src/app.ts:602-657,907-923`

- [ ] **Step 1: Add cache-test helpers and live-profile setup**

In `apps/worker/src/app.test.ts`, add these helpers near the existing VNU test helpers:

```ts
function vnuProfileHtml(studentCode = VNU_STUDENT_CODE): string {
  return studentCode ? `<input name="StdCode" value="${studentCode}">` : "<html><body>No profile identity</body></html>";
}

async function requestVnuImport(app: ReturnType<typeof createApp>): Promise<Response> {
  return app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vnuUsername: "SYNTHETIC_VNU_USER", vnuPassword: "SYNTHETIC_VNU_PASSWORD" }),
  }));
}
```

Refactor `importVnu()` to call `requestVnuImport(app)` before its existing 200/envelope assertions:

```ts
async function importVnu(app: ReturnType<typeof createApp>): Promise<VnuImportResponse> {
  const response = await requestVnuImport(app);
  expect(response.status).toBe(200);
  const body = await response.json() as { data: VnuImportResponse; error: null };
  expect(body.error).toBeNull();
  expect(Object.keys(body.data).sort()).toEqual(["session", "token"]);
  expect(Object.keys(body.data.session).sort()).toEqual(["authenticated", "expiresAt", "studentCode", "universityId"]);
  return body.data;
}
```

Inside `describe("VNU import session cache")`, declare and install a profile spy:

```ts
let profileSpy: ReturnType<typeof vi.spyOn>;
let gradesSpy: ReturnType<typeof vi.spyOn> | undefined;
```

```ts
profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml").mockResolvedValue(vnuProfileHtml());
gradesSpy = undefined;
```

Restore it in `afterEach()` before unstubbing globals:

```ts
gradesSpy?.mockRestore();
profileSpy.mockRestore();
```

This default makes every existing structurally valid cache hit perform and pass one live identity validation after implementation.

- [ ] **Step 2: Tighten the existing valid-cache test before implementation**

Replace the assertions in `it("re-encrypts an equivalent session with its original expiry on a cache hit", ...)` with:

```ts
const first = await importVnu(app);
const cachedBefore = await cache.importEntry();
const second = await importVnu(app);
const cachedAfter = await cache.importEntry();

expect(profileSpy).toHaveBeenCalledTimes(1);
expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
expect(second.token).not.toBe(first.token);
expect(second.token).not.toBe(cachedBefore.seed);
expect(second.session).toEqual(first.session);
expect(cachedAfter).toEqual(cachedBefore);
const firstPayload = await decryptSession(first.token, SESSION_SECRET);
const secondPayload = await decryptSession(second.token, SESSION_SECRET);
expect(secondPayload).toEqual(firstPayload);
expect(secondPayload.expiresAt).toBe("2099-01-01T00:00:00.000Z");
```

- [ ] **Step 3: Add failing expiry-repair and identity-mismatch tests**

Append inside the VNU import-cache describe:

```ts
it("repairs a definitely expired cached ASP session and reuses the replacement", async () => {
  const oldSession = normalizedVnuSession();
  const repairedSession: EncryptedSessionPayload = {
    ...normalizedVnuSession(),
    vnu: { ...normalizedVnuSession().vnu!, value: "SYNTHETIC_REPAIRED_VNU_COOKIE" },
  };
  adapterMocks.importSession
    .mockResolvedValueOnce(importedVnu(oldSession))
    .mockResolvedValueOnce(importedVnu(repairedSession));

  const oldLogin = await importVnu(app);
  const oldEntry = await cache.importEntry();
  profileSpy
    .mockRejectedValueOnce(new HyeboardError("VNU_SESSION_EXPIRED", "Synthetic portal session expiry", 401))
    .mockResolvedValueOnce(vnuProfileHtml());

  const repaired = await importVnu(app);
  const replacement = await cache.importEntry();
  const cachedRelogin = await importVnu(app);

  expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
  expect(profileSpy).toHaveBeenCalledTimes(2);
  expect(replacement.seed).not.toBe(oldEntry.seed);
  expect(repaired.token).not.toBe(oldLogin.token);
  expect(cachedRelogin.token).not.toBe(repaired.token);
  expect(cachedRelogin.token).not.toBe(replacement.seed);
  await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(repairedSession);
  await expect(decryptSession(repaired.token, SESSION_SECRET)).resolves.toEqual(repairedSession);
  await expect(decryptSession(cachedRelogin.token, SESSION_SECRET)).resolves.toEqual(repairedSession);
});

it.each([
  ["missing", ""],
  ["different", "SYNTHETIC-STUDENT-OTHER"],
])("performs verified fresh login when live profile identity is %s", async (_label, liveStudentCode) => {
  await importVnu(app);
  const oldEntry = await cache.importEntry();
  profileSpy.mockResolvedValueOnce(vnuProfileHtml(liveStudentCode));
  const repairedSession: EncryptedSessionPayload = {
    ...normalizedVnuSession(),
    vnu: { ...normalizedVnuSession().vnu!, value: `SYNTHETIC_REPAIRED_${_label.toUpperCase()}_COOKIE` },
  };
  adapterMocks.importSession.mockResolvedValueOnce(importedVnu(repairedSession));

  const recovered = await importVnu(app);
  const replacement = await cache.importEntry();

  expect(profileSpy).toHaveBeenCalledTimes(1);
  expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
  expect(replacement.seed).not.toBe(oldEntry.seed);
  await expect(decryptSession(recovered.token, SESSION_SECRET)).resolves.toEqual(repairedSession);
  await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(repairedSession);
});
```

- [ ] **Step 4: Add failing transient-error and failed-recovery tests**

Append:

```ts
it.each([
  ["rate limit", new HyeboardError("VNU_RATE_LIMITED", "Synthetic rate limit", 429)],
  ["upstream 502", new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", "Synthetic upstream failure", 502)],
  ["mapped network failure", new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", "Synthetic network failure", 502)],
])("propagates %s validation failure without login or cache repair", async (_label, error) => {
  await importVnu(app);
  const before = await cache.importEntry();
  profileSpy.mockRejectedValueOnce(error);

  const response = await requestVnuImport(app);

  expect(response.status).toBe(error.status);
  await expect(response.json()).resolves.toMatchObject({ data: null, error: { code: error.code } });
  expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
  expect(await cache.importEntry()).toEqual(before);
});

it("leaves the old entry untouched when expiry recovery login fails", async () => {
  await importVnu(app);
  const before = await cache.importEntry();
  profileSpy.mockRejectedValueOnce(new HyeboardError("VNU_SESSION_EXPIRED", "Synthetic portal session expiry", 401));
  const loginError = new HyeboardError("INVALID_VNU_CREDENTIAL", "Synthetic login rejection", 401);
  adapterMocks.importSession.mockRejectedValueOnce(loginError);

  const response = await requestVnuImport(app);

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ data: null, error: { code: "INVALID_VNU_CREDENTIAL" } });
  expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
  expect(await cache.importEntry()).toEqual(before);
});
```

- [ ] **Step 5: Run focused worker cache tests and confirm RED**

```bash
pnpm --filter @hyeboard/worker exec vitest run src/app.test.ts -t "VNU import session cache"
```

Expected: FAIL because cache hits currently mint tokens without calling `getProfileHtml()`, so profile-call assertions fail, expiry/transient errors are never observed, and no cache repair occurs.

- [ ] **Step 6: Refactor cache restoration to return the decrypted payload**

In `apps/worker/src/app.ts`, add the restored type and change `restoreCachedVnuImport()`:

```ts
type RestoredCachedVnuImport = {
  payload: EncryptedSessionPayload;
  session: AuthenticatedSessionMetadata;
};

async function restoreCachedVnuImport(value: unknown, secret: string): Promise<RestoredCachedVnuImport | undefined> {
  const cached = parseCachedVnuImport(value);
  if (!cached) return undefined;

  try {
    const session = await decryptSession(cached.seed, secret);
    const expiresAt = Date.parse(session.expiresAt);
    if (session.universityId !== "vnu" || session.vnu?.kind !== "cookie" || typeof session.vnu.value !== "string" || session.vnu.value.length === 0) return undefined;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined;
    if (cached.session.universityId !== session.universityId) return undefined;
    if (cached.session.studentCode !== session.studentCode) return undefined;
    if (cached.session.expiresAt !== session.expiresAt) return undefined;

    return { payload: session, session: cached.session };
  } catch {
    return undefined;
  }
}
```

Cryptographic errors, malformed payloads, expiry, and metadata inconsistency remain ordinary cache misses.

- [ ] **Step 7: Implement live cache-hit validation and narrow repair**

Replace only the VNU branch at `apps/worker/src/app.ts:907-923`:

```ts
if (params.universityId === "vnu" && body.vnuUsername && body.vnuPassword) {
  const cacheKey = await vnuImportCacheKey(body.vnuUsername, body.vnuPassword);
  const secret = getSessionSecret();

  const loginAndCache = async () => {
    const imported = await adapterInstance.importSession(body);
    const normalizedSession: EncryptedSessionPayload = {
      ...imported.session,
      studentCode: imported.studentCode ?? imported.session.studentCode,
    };
    const seed = await encryptSession(normalizedSession, secret);
    const token = await encryptSession(normalizedSession, secret);
    const payload = {
      token,
      session: {
        universityId: normalizedSession.universityId,
        studentCode: normalizedSession.studentCode,
        expiresAt: normalizedSession.expiresAt,
        authenticated: true as const,
      },
    };
    await cachePut(
      cacheKey,
      { seed, session: payload.session },
      Math.floor((Date.parse(normalizedSession.expiresAt) - Date.now()) / 1000),
    );
    return ok(payload);
  };

  const cached = await restoreCachedVnuImport(await cacheGet<unknown>(cacheKey), secret);
  if (cached) {
    try {
      const profile = parseProfileHtml(await new DaotaoClient(cached.payload).getProfileHtml());
      const identityMatches = profile.studentCode !== undefined
        && profile.studentCode === cached.payload.studentCode
        && profile.studentCode === cached.session.studentCode;
      if (identityMatches) {
        return ok({
          token: await encryptSession(cached.payload, secret),
          session: cached.session,
        });
      }
    } catch (error) {
      if (!(error instanceof HyeboardError && error.code === "VNU_SESSION_EXPIRED")) throw error;
    }
  }

  return loginAndCache();
}
```

The helper writes the replacement only after adapter login and its existing profile verification succeed. A valid cache hit encrypts only an outward token, leaving seed, metadata, and expiry unchanged.

- [ ] **Step 8: Run worker cache tests and confirm GREEN**

```bash
pnpm --filter @hyeboard/worker exec vitest run src/app.test.ts -t "VNU import session cache"
```

Expected: PASS for existing cache-format/revocation/TTL tests and new validation, repair, identity, transient-error, and failed-recovery tests.

- [ ] **Step 9: Run worker typecheck**

```bash
pnpm --filter @hyeboard/worker exec tsc -p tsconfig.json --noEmit
```

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 10: Request two-stage review**

First use a fresh specification reviewer to walk every import-cache decision-table row and prior cache assertion against the implementation. Require explicit confirmation that direct profile validation bypasses raw cache, only definitive expiry is caught, mismatch falls through, transient errors preserve identity/cache, failed login cannot overwrite, and expiry remains unchanged. Then use a different fresh code-quality reviewer to inspect closure scope, duplicate encryption, cache-write ordering, type narrowing, and lack of credential/session logging. Expected for each stage: `APPROVED`; resolve concrete findings and rerun Steps 8-9.

- [ ] **Step 11: Commit the import-cache slice**

```bash
git add apps/worker/src/app.ts apps/worker/src/app.test.ts
git commit -m "fix(worker): validate cached VNU sessions"
```

Expected: one scoped worker cache-validation commit.

### Task 4: Prove runtime expiry never enters the raw cache

**Files:**
- Modify: `apps/worker/src/app.test.ts:54-107,374-603`
- Verify unchanged control flow: `apps/worker/src/app.ts:695-748`

- [ ] **Step 1: Expose raw-cache URLs in the test cache**

Add to `TestCache` in `apps/worker/src/app.test.ts`:

```ts
rawUrls(): string[] {
  return [...this.store.keys()].filter((key) => key.includes("/cache/vnu/raw/"));
}
```

No production cache API changes are needed.

- [ ] **Step 2: Add a request helper for raw VNU pages**

Add near `getVnuSession()`:

```ts
async function getVnuRawPage(
  app: ReturnType<typeof createApp>,
  token: string,
  page = "grades",
): Promise<Response> {
  return app.handle(new Request(`http://localhost/api/vnu/raw/${page}`, {
    headers: { Authorization: `Bearer ${token}` },
  }));
}
```

- [ ] **Step 3: Write the runtime-expiry cache-safety test**

Append inside the VNU import-cache describe:

```ts
it("returns runtime VNU_SESSION_EXPIRED without exposing or caching expiry HTML", async () => {
  const expiryNoticeSentinel = "SYNTHETIC_SESSION_ENDED_NOTICE_MUST_NOT_ESCAPE";
  gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockRejectedValueOnce(
    new HyeboardError("VNU_SESSION_EXPIRED", "The university portal session has expired. Sign in again.", 401),
  );
  const token = await encryptSession(normalizedVnuSession(), SESSION_SECRET);

  const response = await getVnuRawPage(app, token);
  const body = await response.text();

  expect(response.status).toBe(401);
  expect(JSON.parse(body)).toMatchObject({ data: null, error: { code: "VNU_SESSION_EXPIRED" } });
  expect(body).not.toContain(expiryNoticeSentinel);
  expect(cache.rawUrls()).toEqual([]);
  expect(gradesSpy).toHaveBeenCalledTimes(1);
});
```

The spy represents the already-tested `DaotaoClient` conversion from recognized HTTP 200 expiry HTML to `HyeboardError`; this worker test verifies the route/cache consequence without carrying notice HTML across the client boundary.

- [ ] **Step 4: Write the fresh-cookie raw-cache isolation test**

Append:

```ts
it("keeps repaired and previous cookies on separate raw-cache keys", async () => {
  const oldSession = normalizedVnuSession();
  const repairedSession: EncryptedSessionPayload = {
    ...normalizedVnuSession(),
    vnu: { ...normalizedVnuSession().vnu!, value: "SYNTHETIC_REPAIRED_RAW_CACHE_COOKIE" },
  };
  adapterMocks.importSession
    .mockResolvedValueOnce(importedVnu(oldSession))
    .mockResolvedValueOnce(importedVnu(repairedSession));
  const oldLogin = await importVnu(app);
  profileSpy.mockRejectedValueOnce(new HyeboardError("VNU_SESSION_EXPIRED", "Synthetic portal session expiry", 401));
  const repaired = await importVnu(app);
  gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<table><tr><td>Authenticated synthetic grades</td></tr></table>");

  expect((await decryptSession(oldLogin.token, SESSION_SECRET)).vnu?.value)
    .not.toBe((await decryptSession(repaired.token, SESSION_SECRET)).vnu?.value);
  expect((await getVnuRawPage(app, oldLogin.token)).status).toBe(200);
  expect((await getVnuRawPage(app, repaired.token)).status).toBe(200);
  expect(cache.rawUrls()).toHaveLength(2);
  expect(gradesSpy).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 5: Run focused runtime/cache tests**

```bash
pnpm --filter @hyeboard/worker exec vitest run src/app.test.ts -t "runtime VNU_SESSION_EXPIRED|separate raw-cache keys"
```

Expected before the Task 2 client integration is present: the end-to-end detector path cannot produce `VNU_SESSION_EXPIRED`. Expected after Tasks 1-3: PASS; the worker returns the existing 401 envelope, no expiry HTML is returned, no failed fetch writes a raw entry, and different cookies produce two keys.

- [ ] **Step 6: Run the full worker unit suite and typecheck**

```bash
pnpm --filter @hyeboard/worker exec vitest run src/app.test.ts
pnpm --filter @hyeboard/worker exec tsc -p tsconfig.json --noEmit
```

Expected: both commands PASS. Confirm `vnuRawHtml()` still performs `cachePut()` only after a client method resolves successfully; make no production edit if that control flow remains intact.

- [ ] **Step 7: Request two-stage review**

Use a fresh specification reviewer to verify runtime 401 behavior, response sanitization, no raw write on expiry, no proactive eviction, and fresh-cookie key separation. Then use a different fresh code-quality reviewer to check spy restoration, cache-state isolation, and whether tests prove behavior rather than private implementation details. Expected for each stage: `APPROVED`; resolve concrete findings and rerun Steps 5-6.

- [ ] **Step 8: Commit the runtime regression tests**

```bash
git add apps/worker/src/app.test.ts
git commit -m "test(worker): cover VNU runtime expiry caching"
```

Expected: one scoped test commit; `apps/worker/src/app.ts` remains unchanged in this task unless review finds a concrete violation of the successful-return-before-cache-write invariant.

### Task 5: Treat only VNU session expiry as frontend session death

**Files:**
- Modify: `apps/web/tests/smoke.spec.ts:97-117,623-679`
- Modify: `apps/web/src/lib/api.ts:23-31`

- [ ] **Step 1: Add a mocked VNU login/error helper to Playwright**

Add near `loginDemo()` in `apps/web/tests/smoke.spec.ts`:

```ts
async function startMockedVnuSession(
  page: import("@playwright/test").Page,
  error: { code: string; status: number; message: string },
) {
  await page.route("**/api/vnu/auth/import-session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          token: "synthetic-vnu-token",
          session: {
            universityId: "vnu",
            studentCode: "SYNTHETIC-STUDENT-001",
            expiresAt: "2099-01-01T00:00:00.000Z",
            authenticated: true,
          },
        },
        error: null,
      }),
    });
  });
  await page.route("**/api/vnu/raw/**", async (route) => {
    await route.fulfill({
      status: error.status,
      contentType: "application/json",
      body: JSON.stringify({ data: null, error: { code: error.code, message: error.message } }),
    });
  });

  await page.goto("/login");
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await page.getByLabel("Username").fill("synthetic-vnu-user");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-vnu-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
```

- [ ] **Step 2: Write the failing terminal-expiry regression**

Add after the existing relogin-field test:

```ts
test("VNU session expiry removes the active account, redirects, and preserves relogin credentials", async ({ page }) => {
  await startMockedVnuSession(page, {
    code: "VNU_SESSION_EXPIRED",
    status: 401,
    message: "The university portal session has expired. Sign in again.",
  });

  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]").length)).toBe(0);
  await expect.poll(async () => page.evaluate(() => localStorage.getItem("hyeboard.activeAccountId"))).toBeNull();

  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await expect(page.getByLabel("Username")).toHaveValue("synthetic-vnu-user");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("synthetic-vnu-password");
});
```

- [ ] **Step 3: Write representative non-terminal VNU regressions**

Add this generated test set at module scope:

```ts
for (const error of [
  { code: "VNU_REQUEST_FAILED", status: 401, message: "Synthetic request rejection" },
  { code: "VNU_RATE_LIMITED", status: 429, message: "Synthetic rate limit" },
  { code: "VNU_UPSTREAM_UNAVAILABLE", status: 502, message: "Synthetic upstream outage" },
  { code: "VNU_CROSS_LOOKUP_NOT_FOUND", status: 404, message: "Synthetic feature miss" },
]) {
  test(`${error.code} remains inline without removing the VNU account`, async ({ page }) => {
    await startMockedVnuSession(page, error);

    await expect(page).not.toHaveURL(/\/login$/);
    await expect(page.getByText(error.message).first()).toBeVisible();
    await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]").length)).toBe(1);
    await expect.poll(async () => page.evaluate(() => localStorage.getItem("hyeboard.activeAccountId"))).not.toBeNull();
  });
}
```

The coded error must override raw HTTP 401 fallback, so `VNU_REQUEST_FAILED` at status 401 is the critical false-logout case.

- [ ] **Step 4: Run focused Playwright tests and confirm RED**

```bash
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --grep "VNU session expiry|VNU_.* remains inline"
```

Expected: `VNU_SESSION_EXPIRED` case FAILS because the account remains active and the page does not redirect. Non-terminal cases should remain on the feature route.

- [ ] **Step 5: Add the one central terminal code**

Change only the set in `apps/web/src/lib/api.ts`:

```ts
const SESSION_INVALID_CODES: ReadonlySet<string> = new Set([
  "MISSING_SESSION",
  "SESSION_EXPIRED",
  "INVALID_SESSION",
  "VNU_SESSION_EXPIRED",
]);
```

Do not add `VNU_LOGIN_REQUIRED`, `VNU_RATE_LIMITED`, `VNU_UPSTREAM_UNAVAILABLE`, `VNU_REQUEST_FAILED`, any cross-lookup code, or any generic 401 family rule.

- [ ] **Step 6: Run focused Playwright tests and confirm GREEN**

```bash
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --grep "VNU session expiry|VNU_.* remains inline"
```

Expected: PASS. Expiry removes the only active VNU account, emits existing session-cleared navigation, lands on `/login`, and retains tab-scoped username/password. Every representative other code leaves the account and route intact with inline error copy.

- [ ] **Step 7: Run web typecheck**

```bash
pnpm --filter @hyeboard/web exec tsc -p tsconfig.json --noEmit
```

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 8: Request two-stage review**

Use a fresh specification reviewer to verify terminal code specificity, account removal/navigation, tab-scoped credential preservation, and representative unrelated 401/429/502/feature errors. Then use a different fresh code-quality reviewer to inspect route interception scope, race-resistant assertions, storage assertions, and test isolation. Expected for each stage: `APPROVED`; resolve concrete findings and rerun Steps 6-7.

- [ ] **Step 9: Commit the frontend slice**

```bash
git add apps/web/src/lib/api.ts apps/web/tests/smoke.spec.ts
git commit -m "fix(web): clear expired VNU sessions"
```

Expected: one scoped frontend behavior/test commit.

### Task 6: Full verification and final plan/spec review

**Files:**
- Verify: `packages/university-adapters/src/vnu/session-expiry-fixtures.ts`
- Verify: `packages/university-adapters/src/vnu/parser.ts`
- Verify: `packages/university-adapters/src/vnu/parser.test.ts`
- Verify: `packages/university-adapters/src/vnu/daotao-client.ts`
- Verify: `packages/university-adapters/src/vnu/daotao-client.test.ts`
- Verify: `apps/worker/src/app.ts`
- Verify: `apps/worker/src/app.test.ts`
- Verify: `apps/web/src/lib/api.ts`
- Verify: `apps/web/tests/smoke.spec.ts`

- [ ] **Step 1: Run all focused adapter and worker unit tests**

```bash
pnpm --filter @hyeboard/university-adapters exec vitest run src/vnu/parser.test.ts src/vnu/daotao-client.test.ts
pnpm --filter @hyeboard/worker exec vitest run src/app.test.ts
```

Expected: both commands PASS with no skipped new regression.

- [ ] **Step 2: Run package typechecks**

```bash
pnpm --filter @hyeboard/university-adapters exec tsc -p tsconfig.json --noEmit
pnpm --filter @hyeboard/worker exec tsc -p tsconfig.json --noEmit
pnpm --filter @hyeboard/web exec tsc -p tsconfig.json --noEmit
```

Expected: all three commands PASS with no diagnostics.

- [ ] **Step 3: Run the required worker package test command**

```bash
pnpm --filter @hyeboard/worker test
```

Expected: PASS.

- [ ] **Step 4: Build the complete monorepo**

```bash
pnpm build
```

Expected: PASS for the Vite frontend build and worker TypeScript build.

- [ ] **Step 5: Run monorepo tests/typechecks**

```bash
pnpm test
```

Expected: PASS across all packages.

- [ ] **Step 6: Run the complete Playwright suite**

```bash
pnpm --filter @hyeboard/web exec playwright test
```

Expected: PASS across configured browsers, including terminal VNU expiry, inline non-terminal errors, and existing session/relogin coverage.

- [ ] **Step 7: Verify the deployment bundle without deploying**

```bash
pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run
```

Expected: PASS; Wrangler builds the worker and reports a dry-run bundle without publishing.

- [ ] **Step 8: Check patch cleanliness and scope**

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exits successfully with no whitespace errors. Status contains only this plan document plus intentional uncommitted corrections among the nine planned implementation/test files; no HAR, credential, environment, build-output, Playwright-report, or unrelated file appears.

- [ ] **Step 9: Perform final spec-coverage self-review**

Read the approved design once more and map every requirement to evidence:

1. Detector tests cover trusted final login URL, both paired-control variants, exact standalone notice, authenticated HTML, unrelated notices, partial fields, and foreign-origin login URL.
2. Client tests prove HTTP/network mappings precede body classification and recognized HTTP 200 expiry throws `VNU_SESSION_EXPIRED` 401.
3. Worker tests cover valid live cache hit, fresh outward encryption/original expiry, definitive-expiry repair and reusable replacement, malformed metadata cache miss, missing/mismatched live identity, 429/502/network propagation, failed recovery without rewrite, runtime no-cache behavior, fresh-cookie key isolation, revocation, and unchanged JSON shape.
4. Frontend tests prove only `VNU_SESSION_EXPIRED` is terminal, account removal/navigation uses existing behavior, relogin credentials remain, and representative other VNU errors stay inline.
5. No route, request, response, error-envelope, cache TTL, cross-device cache key, session duration, or unsupported capability changed.

Expected: every item points to a named passing test or unchanged invariant; no uncovered design requirement remains.

- [ ] **Step 10: Perform unfinished-marker and signature consistency scan**

Inspect the nine planned files and this plan for unfinished markers, vague deferred work, omitted code blocks, or replacement prose. Confirm these signatures and names match everywhere:

```ts
isDaotaoSessionExpired(finalUrl: string, html: string): boolean
restoreCachedVnuImport(value: unknown, secret: string): Promise<RestoredCachedVnuImport | undefined>
type RestoredCachedVnuImport = { payload: EncryptedSessionPayload; session: AuthenticatedSessionMetadata }
requestVnuImport(app: ReturnType<typeof createApp>): Promise<Response>
getVnuRawPage(app: ReturnType<typeof createApp>, token: string, page?: string): Promise<Response>
```

Expected: no unfinished marker or signature mismatch; imports reference the exact exported names above.

- [ ] **Step 11: Request final two-stage review**

First use a fresh specification reviewer with the full approved design and final diff. Require a decision for every goal, non-goal, failure-table row, security rule, and acceptance command. After specification approval, use a different fresh code-quality reviewer on the same final diff, focusing on false positives, error swallowing, cache mutation ordering, outward-shape drift, race-prone tests, privacy, and unnecessary refactors. Expected for both stages: `APPROVED`; resolve concrete findings, then rerun every command in Steps 1-8.

- [ ] **Step 12: Record final implementation commit only after all checks pass**

If review fixes changed files after their scoped commits:

```bash
git add packages/university-adapters/src/vnu/session-expiry-fixtures.ts packages/university-adapters/src/vnu/parser.ts packages/university-adapters/src/vnu/parser.test.ts packages/university-adapters/src/vnu/daotao-client.ts packages/university-adapters/src/vnu/daotao-client.test.ts apps/worker/src/app.ts apps/worker/src/app.test.ts apps/web/src/lib/api.ts apps/web/tests/smoke.spec.ts
git commit -m "test(vnu): complete session expiry regression coverage"
```

Expected: create this final scoped commit only when review produced post-commit corrections; otherwise leave the five prior scoped commits unchanged. Never amend, force-push, or include generated artifacts.
