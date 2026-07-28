import { cors } from "@elysiajs/cors";
import { decryptSession, encryptSession, fail, getLogger, HyeboardError, isExpired, ok, parseBearerToken, type EncryptedSessionPayload } from "@hyeboard/core";
import { DaotaoClient, getAdapter, isDaotaoSessionExpired, listUniversities, parseProfileHtml, parseTranscriptHeader, parseTranscriptHtml, type BrowserBinding, type BrowserConnection, type VnuTranscript } from "@hyeboard/university-adapters";
import { Elysia, t } from "elysia";
import { LocalCaptchaRelayCoordinator, captchaRelayCancelled, captchaRelayNotFound, type CaptchaRelayCoordinator, type PreparedCaptchaRelay } from "./captcha-relay";
import { probeBudgetUnavailable, type VnuProbeBudgetCoordinator } from "./vnu-probe-budget";
import { resolveVnuStudentId, VNU_STUDENT_ID_RESOLVER_MAX_PROBES } from "./vnu-student-id-resolver";

// ─── Runtime config ───────────────────────────────────────────
// Self-hosted (Node/Bun) loads config from config.json + env var overrides
// (see loadConfigFile below). Cloudflare Workers doesn't use config.json
// (no filesystem) — index.ts calls setRuntimeConfig directly with env var
// values from the `cloudflare:workers` binding.
//
// HYEB_SESSION_SECRET is NEVER read from config.json — only from env vars
// or setRuntimeConfig(), to keep it out of files that might be checked in.
export interface RuntimeConfig {
  HYEB_SESSION_SECRET?: string;
  HYEB_ALLOWED_ORIGINS?: string;
  HYEB_BROWSER_WS_ENDPOINT?: string;
  HYEB_BROWSER_LOCAL?: string;
  HYEB_BROWSER_HEADLESS?: string;
  HYEB_CHROME_PATH?: string;
  HYEB_BROWSER_IDLE_EVICTION_MS?: string;
  HYEB_LOG_LEVEL?: string;
  VNU_FAR_WALK_ENABLED?: string;
  HOST?: string;
  PORT?: string;
  HYEB_STATIC_DIR?: string;
}

let runtimeConfig: RuntimeConfig = {};

export function setRuntimeConfig(config: RuntimeConfig): void {
  runtimeConfig = config;
}

// Read non-secret config from a JSON file (Node/Bun only, no-op on CF Workers).
// The file path defaults to ./config.json relative to cwd, overridable via
// CONFIG_PATH env var. Returns a partial RuntimeConfig — callers merge with
// env vars (which take precedence) before passing to setRuntimeConfig.
//
// HYEB_SESSION_SECRET is intentionally never read from this file. It must
// come from an env var only.
// Structured config.json schema:
//   { "origins": [...], "browser": { "ws_endpoint", "local", "headless",
//     "chrome_path", "idle_eviction_minutes" }, "log_level", "host", "port",
//     "static_dir" }
// See apps/worker/config.json for the full default file.
export async function loadConfigFile(): Promise<RuntimeConfig> {
  const isNode = typeof process !== "undefined" && typeof process.cwd === "function";
  if (!isNode) return {};
  try {
    const configPath = process.env.CONFIG_PATH;
    const { join } = await import("node:path");
    const path = configPath || join(process.cwd(), "config.json");
    const { readFileSync, existsSync } = await import("node:fs");
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const cfg = JSON.parse(raw);
    const r: RuntimeConfig = {};
    if (Array.isArray(cfg.origins)) r.HYEB_ALLOWED_ORIGINS = cfg.origins.join(", ");
    if (cfg.browser && typeof cfg.browser === "object") {
      if (typeof cfg.browser.ws_endpoint === "string") r.HYEB_BROWSER_WS_ENDPOINT = cfg.browser.ws_endpoint;
      if (typeof cfg.browser.local === "boolean") r.HYEB_BROWSER_LOCAL = String(cfg.browser.local);
      if (typeof cfg.browser.headless === "boolean") r.HYEB_BROWSER_HEADLESS = String(cfg.browser.headless);
      if (typeof cfg.browser.chrome_path === "string") r.HYEB_CHROME_PATH = cfg.browser.chrome_path;
      if (typeof cfg.browser.idle_eviction_minutes === "number") r.HYEB_BROWSER_IDLE_EVICTION_MS = String(cfg.browser.idle_eviction_minutes * 60_000);
    }
    if (typeof cfg.log_level === "string") r.HYEB_LOG_LEVEL = cfg.log_level;
    if (typeof cfg.host === "string") r.HOST = cfg.host;
    if (typeof cfg.port === "number") r.PORT = String(cfg.port);
    // Empty string means "use the built-in default" (see config.json's
    // checked-in default) — only set it when non-empty, since start.ts's
    // `process.env.HYEB_STATIC_DIR ?? fileConfig.HYEB_STATIC_DIR ?? default`
    // fallback chain uses `??`, which does NOT treat an empty string as
    // nullish. Setting it unconditionally here would make config.json's
    // default "" silently win over the real default path, breaking static
    // asset serving (confirmed live: registerStaticAssets("") resolves to
    // the current working directory, not apps/web/dist).
    if (typeof cfg.static_dir === "string" && cfg.static_dir !== "") r.HYEB_STATIC_DIR = cfg.static_dir;
    return r;
  } catch {
    return {};
  }
}

// On Cloudflare, use the managed Browser Rendering binding (env.BROWSER),
// set once at module load by index.ts via setCloudflareBrowserBinding().
// Self-hosted deployments (Node/Bun + a Docker headless-Chrome container)
// have no such binding — instead they set HYEB_BROWSER_WS_ENDPOINT to a
// plain CDP WebSocket URL (e.g. ws://localhost:3000) and
// google-login-automation connects to it via puppeteer-core instead of
// @cloudflare/puppeteer.
let cloudflareBrowserBinding: BrowserBinding | undefined;

export function setCloudflareBrowserBinding(binding: BrowserBinding): void {
  cloudflareBrowserBinding = binding;
}

// ─── Config ───────────────────────────────────────────────────

function getSessionSecret(): string {
  const s = runtimeConfig.HYEB_SESSION_SECRET;
  if (!s) throw new HyeboardError("SERVER_CONFIG_ERROR", "HYEB_SESSION_SECRET not configured", 500);
  if (s.length < 32) throw new HyeboardError("WEAK_SESSION_SECRET", "HYEB_SESSION_SECRET must be >= 32 characters", 500);
  return s;
}

function browserHeadless(): boolean {
  const v = runtimeConfig.HYEB_BROWSER_HEADLESS;
  if (v === undefined || v === "") return true;
  return v === "true" || v === "1";
}

function browserConnection(): BrowserConnection {
  const wsEndpoint = runtimeConfig.HYEB_BROWSER_WS_ENDPOINT;
  if (wsEndpoint) return { kind: "self-hosted", browserWSEndpoint: wsEndpoint };
  // Explicit "true"/"1" check, not a truthy-string check: HYEB_BROWSER_LOCAL is
  // always a *string* here (from either an env var or loadConfigFile's
  // String(boolean) conversion of config.json's browser.local), so a naive
  // `if (runtimeConfig.HYEB_BROWSER_LOCAL)` would treat the string "false" as
  // truthy and force "local" mode even when the config explicitly disables it.
  if (runtimeConfig.HYEB_BROWSER_LOCAL === "true" || runtimeConfig.HYEB_BROWSER_LOCAL === "1") return { kind: "local", headless: browserHeadless() };
  return { kind: "cloudflare", binding: cloudflareBrowserBinding as BrowserBinding };
}

export function isVnuFarWalkEnabled(value: string | undefined): boolean {
  return value === "true";
}

function vnuFarWalkEnabled(): boolean {
  return isVnuFarWalkEnabled(runtimeConfig.VNU_FAR_WALK_ENABLED);
}

// ─── Auth ─────────────────────────────────────────────────────

async function getSession(headers: Headers | Record<string, string | undefined>) {
  const h = headers instanceof Headers ? headers : new Headers(headers as Record<string, string>);
  const token = parseBearerToken(h.get("Authorization"));
  if (!token) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);
  if (await isTokenRevoked(token)) throw new HyeboardError("SESSION_EXPIRED", "Session expired", 401);
  return decryptSession(token, getSessionSecret());
}

type ResolvedSession = { session: EncryptedSessionPayload; refreshedToken?: string };

// Lazy, per-request refresh (no background jobs/Durable Object alarms — see
// spec's "lazy on next API call" decision). Only uet sessions created via
// automated Google login (uetGoogleCredential) or a parent/guardian direct
// login (uetParentCredential) carry a refreshable credential; every other
// session (manual paste, vnu, mock) passes straight through the plain
// decrypt path with the shortcut check below being a cheap no-op.
export async function resolveSession(headers: Headers | Record<string, string | undefined>): Promise<ResolvedSession> {
  const h = headers instanceof Headers ? headers : new Headers(headers as Record<string, string>);
  const token = parseBearerToken(h.get("Authorization"));
  if (!token) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);
  if (await isTokenRevoked(token)) throw new HyeboardError("SESSION_EXPIRED", "Session expired", 401);
  const session = await decryptSession(token, getSessionSecret());

  if (session.universityId !== "uet" || (!session.uetGoogleCredential && !session.uetParentCredential)) return { session };
  const studenthubExpiresAt = session.studenthub?.expiresAt;
  if (studenthubExpiresAt && !isExpired(studenthubExpiresAt)) return { session };

  try {
    const adapter = getAdapter("uet");
    // Parent/guardian accounts refresh through StudentHub's direct CAPTCHA
    // APIs. Google accounts still need browser automation below.
    const refreshed = session.uetParentCredential
      ? await adapter.importSession({
          uetGoogleEmail: session.uetParentCredential.username,
          uetGooglePassword: session.uetParentCredential.password,
        })
      : await adapter.importSession(
          {
            uetGoogleEmail: session.uetGoogleCredential!.email,
            uetGooglePassword: session.uetGoogleCredential!.password,
            uetGoogleCookies: session.uetGoogleCredential!.googleCookies,
          },
          { browserConnection: browserConnection() },
        );
    const refreshedToken = await encryptSession(refreshed.session, getSessionSecret());
    return { session: refreshed.session, refreshedToken };
  } catch (error) {
    // Preserve the real failure code/status instead of collapsing every
    // refresh failure into a generic GOOGLE_REFRESH_FAILED/401 — the
    // frontend and logs both need to distinguish e.g. STUDENTHUB_MAINTENANCE
    // (503, transient, not a "sign in again" situation) from a genuine
    // GOOGLE_AUTOMATION_TIMEOUT/GOOGLE_AUTOMATION_BLOCKED/challenge failure.
    if (session.uetParentCredential) {
      // Parent refresh errors stay sanitized: upstream bodies, credentials,
      // CAPTCHA values, IDs, images, account data, and tokens must not enter logs.
      getLogger().error({
        code: error instanceof HyeboardError ? error.code : "PARENT_REFRESH_FAILED",
        status: error instanceof HyeboardError ? error.status : 500,
        errorName: error instanceof Error ? error.name : typeof error,
      }, "resolveSession: parent sign-in refresh failed");
    } else {
      getLogger().error({ err: error }, "resolveSession: automatic sign-in refresh failed");
    }
    if (error instanceof HyeboardError) throw error;
    throw new HyeboardError("GOOGLE_REFRESH_FAILED", "Automatic sign-in refresh failed. Sign in again.", 401);
  }
}

// ─── Error handling ───────────────────────────────────────────

// Shared with the SSE import-session branch below, which can't rely on
// Elysia's onError hook (errors thrown inside a ReadableStream's start()
// callback don't propagate to Elysia at all — the stream must catch and
// report its own errors as an "error" SSE event instead).
function errorPayload(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof HyeboardError) return { code: error.code, message: error.message, status: error.status };
  // A truly unexpected (non-HyeboardError) failure reaching this far means
  // the automation's own error handling didn't catch it — surface the real
  // message instead of a fully generic one, so it's actually diagnosable.
  const reason = error instanceof Error ? error.message : String(error);
  return { code: "GOOGLE_SIGNIN_FAILURE", message: `Google sign-in did not complete: ${reason}`, status: 502 };
}

function routeError(error: unknown, requestId?: string, requestUrl?: string) {
  const id = requestId ?? "-";
  const log = getLogger();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (requestUrl && new URL(requestUrl).pathname.startsWith("/api/vnu/cross-lookup/")) headers.set("Cache-Control", "no-store");
  if (error instanceof HyeboardError) {
    const level = error.status >= 500 ? "error" : "warn";
    log[level]({ reqId: id, code: error.code, status: error.status }, error.message);
    return new Response(JSON.stringify(fail(error.code, error.message, error.details)), { status: error.status, headers });
  }
  // Elysia's own error classes (ValidationError, ParseError, NotFoundError,
  // InternalServerError) are plain Errors with .code/.status, not
  // HyeboardError. Surface them as clean 4xx responses instead of masking
  // a client mistake (e.g. malformed request body) as a generic 500.
  if (error instanceof Error && "status" in error && typeof (error as { status?: unknown }).status === "number") {
    const status = (error as { status: number }).status;
    const code = "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "REQUEST_ERROR";
    const level = status >= 500 ? "error" : "warn";
    log[level]({ reqId: id, code, status }, "request rejected");
    const message = status < 500 ? "The request was invalid. Check the fields you submitted and try again." : "Unexpected API error";
    return new Response(JSON.stringify(fail(code, message)), { status, headers });
  }
  log.error({ reqId: id, errorType: typeof error, stack: error instanceof Error ? error.stack : undefined }, "Unhandled error type");
  return new Response(JSON.stringify(fail("INTERNAL_ERROR", "Unexpected API error")), { status: 500, headers });
}

// ─── Schemas ──────────────────────────────────────────────────

const importSessionBody = t.Object({
  studenthubGoogleCredential: t.Optional(t.String()),
  studenthubToken: t.Optional(t.String()),
  studenthubCookie: t.Optional(t.String()),
  canvasToken: t.Optional(t.String()),
  canvasCookie: t.Optional(t.String()),
  canvasCsrfToken: t.Optional(t.String()),
  vnuUsername: t.Optional(t.String()),
  vnuPassword: t.Optional(t.String()),
  studentCode: t.Optional(t.String()),
  uetGoogleEmail: t.Optional(t.String()),
  uetGooglePassword: t.Optional(t.String()),
});

const termCodeQuery = t.Object({ termCode: t.Optional(t.String()) });

const vnuRawQuery = t.Object({
  // selUniv/selStd are still accepted so stale clients don't break, but they
  // are NEVER honored: vnuRawHtml strips them before cache keying and derives
  // both ids from the session's own profile for every key that needs them
  // (see the exams and point-detail branches). vTermID stays client-supplied
  // — it is a term selector, not a per-student id.
  selUniv: t.Optional(t.String()),
  selStd: t.Optional(t.String()),
  vTermID: t.Optional(t.String()),
  // point-detail key only: class id, cosmetic echo value, term ordinal.
  id: t.Optional(t.String()),
  val: t.Optional(t.String()),
  Term: t.Optional(t.String()),
});

// Cross-student lookup (vnu-only, see the crossLookup capability flag). Kept
// off the /api/vnu/raw/:page allow-list so the access pattern stays auditable
// and gated in exactly one place. allowCrossLookup must be the literal string
// "true" — an explicit, obviously-named opt-in, never a neutral flag.
const vnuCrossLookupQuery = t.Object({
  stdId: t.Optional(t.String()),
  stdCode: t.Optional(t.String()),
  allowCrossLookup: t.Optional(t.String()),
});

type VnuBulkLookupMode = "stdid-to-code" | "code-to-stdid" | "stdid-to-transcript";
type VnuBulkLookupBody = { mode: VnuBulkLookupMode; targets: unknown[]; allowCrossLookup: true };

const VNU_BULK_MODE_LIMITS: Record<VnuBulkLookupMode, number> = {
  "stdid-to-code": 5,
  "code-to-stdid": 3,
  "stdid-to-transcript": 5,
};

function parseVnuBulkLookupBody(value: unknown): VnuBulkLookupBody {
  if (!isRecord(value)) throw new HyeboardError("VNU_CROSS_LOOKUP_BODY_INVALID", "Bulk cross-lookup needs a JSON object body.", 400);
  if (value.allowCrossLookup !== true) throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED", "Cross-student lookup requires the literal allowCrossLookup: true opt-in.", 400);
  if (value.mode !== "stdid-to-code" && value.mode !== "code-to-stdid" && value.mode !== "stdid-to-transcript") {
    throw new HyeboardError("VNU_CROSS_LOOKUP_MODE_INVALID", "Bulk cross-lookup mode is invalid.", 400);
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0) throw new HyeboardError("VNU_CROSS_LOOKUP_TARGETS_INVALID", "Bulk cross-lookup needs at least one target.", 400);
  if (value.targets.length > VNU_BULK_MODE_LIMITS[value.mode]) throw new HyeboardError("VNU_CROSS_LOOKUP_CHUNK_TOO_LARGE", "Bulk cross-lookup chunk exceeds the selected mode limit.", 400);
  return { mode: value.mode, targets: value.targets, allowCrossLookup: true };
}

async function parseVnuBulkLookupRequest(request: Request): Promise<VnuBulkLookupBody> {
  try {
    return parseVnuBulkLookupBody(await request.json());
  } catch (error) {
    if (error instanceof HyeboardError) throw error;
    throw new HyeboardError("VNU_CROSS_LOOKUP_BODY_INVALID", "Bulk cross-lookup needs a valid JSON object body.", 400);
  }
}

type VnuCrossLookupTranscript = Omit<VnuTranscript, "notice">;

function parseVnuCrossLookupTranscript(html: string): VnuCrossLookupTranscript {
  const { notice: _upstreamNotice, ...transcript } = parseTranscriptHtml(html);
  return transcript;
}

const VNU_PORTAL_STD_ID_PATTERN = /^\d{1,11}$/;
const VNU_PORTAL_STUDENT_CODE_PATTERN = /^\d{8}$/;

type VnuOwnIdentity = { ownStdId: number; ownCode?: number };

// Parse, don't validate: the session owner's portal identity is parsed into
// trusted positive integers exactly once, at this boundary, and every cross
// route below consumes only that result. A malformed profile value fails
// closed here with VNU_LOGIN_REQUIRED instead of slipping past a self-target
// guard through NaN semantics — Number(garbage) is NaN, NaN === NaN is false,
// so a raw Number() comparison can never be trusted as a guard.
function parseVnuOwnIdentity(
  profile: { internalStudentId?: string; studentCode?: string },
  options: { requireStudentCode: true; errorMessage: string },
): { ownStdId: number; ownCode: number };
function parseVnuOwnIdentity(
  profile: { internalStudentId?: string; studentCode?: string },
  options: { requireStudentCode: boolean; errorMessage: string },
): VnuOwnIdentity;
function parseVnuOwnIdentity(
  profile: { internalStudentId?: string; studentCode?: string },
  options: { requireStudentCode: boolean; errorMessage: string },
): VnuOwnIdentity {
  const stdIdText = profile.internalStudentId ?? "";
  const ownStdId = Number(stdIdText);
  const stdIdValid = VNU_PORTAL_STD_ID_PATTERN.test(stdIdText) && Number.isSafeInteger(ownStdId) && ownStdId > 0;
  if (!stdIdValid) throw new HyeboardError("VNU_LOGIN_REQUIRED", options.errorMessage, 401);

  const codeText = profile.studentCode ?? "";
  const ownCode = Number(codeText);
  const codeValid = VNU_PORTAL_STUDENT_CODE_PATTERN.test(codeText) && Number.isSafeInteger(ownCode) && ownCode > 0;
  if (codeValid) return { ownStdId, ownCode };
  if (options.requireStudentCode) throw new HyeboardError("VNU_LOGIN_REQUIRED", options.errorMessage, 401);
  return { ownStdId };
}

// Normalized numeric self-target comparisons. Targets reaching these helpers
// have already passed their own regex gates (^\d{1,11}$ / ^\d{8}$), so
// Number() on them is always a safe integer and leading-zero spellings of the
// same id ("00000001000" vs "1000") correctly compare equal.
function isOwnStdId(identity: VnuOwnIdentity, targetStdId: string): boolean {
  return Number(targetStdId) === identity.ownStdId;
}

function isOwnStudentCode(identity: VnuOwnIdentity, targetStdCode: string): boolean {
  return identity.ownCode !== undefined && Number(targetStdCode) === identity.ownCode;
}

type VnuBulkAllowance = { consume(): void };

function createVnuBulkAllowance(units: number): VnuBulkAllowance {
  let remaining = units;
  return {
    consume() {
      if (remaining <= 0) throw new Error("Reserved VNU probe allowance exhausted");
      remaining -= 1;
    },
  };
}

function vnuBulkReservationUnits(body: VnuBulkLookupBody): number {
  const unitsPerTarget = body.mode === "code-to-stdid" ? VNU_STUDENT_ID_RESOLVER_MAX_PROBES : 1;
  return body.targets.length * unitsPerTarget;
}

function waitBetweenBulkItems(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

// ─── Cache abstraction ────────────────────────────────────────
// The Cloudflare Cache API (`caches.default`) is native to Workers/workerd
// but doesn't exist on plain Node or Bun. To keep rate-limiting/session
// revocation working identically across all three runtimes, fall back to a
// tiny in-memory Map-based Cache-like shim implementing just the
// `.match(request)`/`.put(request, response)` surface that cacheGet/cachePut
// actually use. This is already documented as a best-effort guardrail, not a
// hard security boundary, so an in-memory Map is an equivalent-strength
// (if anything, more consistent within a single process) substitute.

interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function createMemoryCache(): CacheLike {
  const store = new Map<string, { response: Response; expiresAt: number }>();
  return {
    async match(request: Request) {
      const entry = store.get(request.url);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        store.delete(request.url);
        return undefined;
      }
      return entry.response.clone();
    },
    async put(request: Request, response: Response) {
      const cacheControl = response.headers.get("Cache-Control") ?? "";
      const maxAgeMatch = /max-age=(\d+)/.exec(cacheControl);
      const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 0;
      store.set(request.url, { response: response.clone(), expiresAt: Date.now() + maxAgeSeconds * 1000 });
    },
  };
}

const memoryCache: CacheLike = createMemoryCache();

// Safe request-ID generator. crypto.randomUUID() is available on all modern
// browsers and Node 19+/14.17.0 via the crypto module, but the bundled
// worker references the global Web Crypto API (globalThis.crypto), which
// doesn't exist or lacks randomUUID on Node <19. Fall back to Math.random
// for those environments.
function requestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().slice(0, 8);
  }
  if (typeof require === "function") {
    try { return require("crypto").randomUUID().slice(0, 8); } catch { /* fall through */ }
  }
  return Math.random().toString(36).substring(2, 10);
}

// ── CAPTCHA human-relay coordination ─────────────────────────────────
// The uet adapter's parent/guardian direct-login flow (see adapter.ts,
// captcha.ts) receives an image from StudentHub's CAPTCHA API that OCR
// couldn't confidently solve. When that happens mid-login, the
// server needs to pause and wait for the end user (on the OTHER side of
// the currently-open SSE connection) to look at the image and type an
// answer. Cloudflare configures a Durable Object coordinator; Node/Bun use
// an abort-aware process-local coordinator.
let captchaRelayCoordinator: CaptchaRelayCoordinator = new LocalCaptchaRelayCoordinator();

const CAPTCHA_RELAY_TOKEN_DOMAIN = "hyeboard:captcha-relay:v1\0";
const CAPTCHA_RELAY_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const CAPTCHA_RELAY_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

export function setCaptchaRelayCoordinator(coordinator: CaptchaRelayCoordinator): void {
  captchaRelayCoordinator = coordinator;
}

export async function createCaptchaRelayToken(relayId: string): Promise<string> {
  if (!CAPTCHA_RELAY_ID_PATTERN.test(relayId)) throw new Error("Invalid CAPTCHA relay ID");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${CAPTCHA_RELAY_TOKEN_DOMAIN}${relayId}`)));
  return `${relayId}.${signature}`;
}

async function verifyCaptchaRelayToken(token: string): Promise<string | undefined> {
  try {
    const separator = token.indexOf(".");
    if (separator === -1 || separator !== token.lastIndexOf(".")) return undefined;
    const relayId = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    if (!CAPTCHA_RELAY_ID_PATTERN.test(relayId) || !CAPTCHA_RELAY_SIGNATURE_PATTERN.test(signature)) return undefined;

    const signatureBytes = new Uint8Array(32);
    for (let index = 0; index < signatureBytes.length; index += 1) {
      signatureBytes[index] = Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16);
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(getSessionSecret()),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const authentic = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode(`${CAPTCHA_RELAY_TOKEN_DOMAIN}${relayId}`),
    );
    return authentic ? relayId : undefined;
  } catch {
    return undefined;
  }
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(getSessionSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const cache = await appCache();
    const response = await cache.match(new Request(`https://hyeboard.internal/cache/${key}`));
    if (!response) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

async function cachePut(key: string, value: unknown, maxAgeSeconds: number): Promise<void> {
  if (maxAgeSeconds <= 0) return;
  try {
    const cache = await appCache();
    await cache.put(
      new Request(`https://hyeboard.internal/cache/${key}`),
      new Response(JSON.stringify(value), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${Math.floor(maxAgeSeconds)}`,
        },
      }),
    );
  } catch {
    // Cache is best-effort. Auth must keep working even when cache access
    // fails for any reason (colo rejection, memory pressure, etc.).
  }
}

async function appCache(): Promise<CacheLike> {
  const storage = globalThis.caches as (CacheStorage & { default?: Cache }) | undefined;
  if (!storage) return memoryCache;
  if (storage.default) return storage.default;
  if (typeof storage.open === "function") return storage.open("hyeboard");
  return memoryCache;
}

let vnuProbeBudgetCoordinator: VnuProbeBudgetCoordinator = {
  async consume() { throw probeBudgetUnavailable(); },
  async reserve() { throw probeBudgetUnavailable(); },
};

// True only once a genuinely shared probe-budget coordinator backs the
// cross-lookup routes — in practice the authoritative Cloudflare Durable
// Object coordinator installed by index.ts. Self-hosted Node/Bun runtimes
// never install one, so their cross-lookup routes always fail closed with
// 503 and the capability must serialize as unavailable (see
// serializeUniversities below) rather than teasing UI that can only error.
let probeBudgetCoordinatorInstalled = false;

export function setVnuProbeBudgetCoordinator(coordinator: VnuProbeBudgetCoordinator): void {
  vnuProbeBudgetCoordinator = coordinator;
  probeBudgetCoordinatorInstalled = true;
}

async function vnuProbeBudgetKey(session: EncryptedSessionPayload): Promise<string> {
  if (session.universityId !== "vnu" || !session.vnu?.value) throw new HyeboardError("VNU_LOGIN_REQUIRED", "VNU lookup probes need an active daotao.vnu.edu.vn session. Sign in again.", 401);
  return hmacHex(`${session.vnu.value}\n${session.expiresAt}`);
}

// Shared boundary for every Brc1 oracle fetch. Upcoming transcript/bulk routes
// must call this immediately before each upstream request. The opaque HMAC
// identity binds one Durable Object to one VNU session without exposing cookie
// or student identifiers in its name or storage.
export async function consumeVnuOracleProbe(session: EncryptedSessionPayload, amount = 1): Promise<void> {
  try {
    await vnuProbeBudgetCoordinator.consume(await vnuProbeBudgetKey(session), amount);
  } catch (error) {
    if (error instanceof HyeboardError) throw error;
    throw probeBudgetUnavailable();
  }
}

async function reserveVnuOracleProbes(session: EncryptedSessionPayload, amount: number): Promise<void> {
  try {
    await vnuProbeBudgetCoordinator.reserve(await vnuProbeBudgetKey(session), amount);
  } catch (error) {
    if (error instanceof HyeboardError) throw error;
    throw probeBudgetUnavailable();
  }
}

async function vnuImportCacheKey(username: string, password: string): Promise<string> {
  return `vnu/import/${await hmacHex(`${username.trim()}\n${password}`)}`;
}

type AuthenticatedSessionMetadata = {
  universityId: string;
  studentCode?: string;
  expiresAt: string;
  authenticated: true;
};

type CachedVnuImport = {
  seed: string;
  session: AuthenticatedSessionMetadata;
};

type RestoredCachedVnuImport = {
  payload: EncryptedSessionPayload;
  session: AuthenticatedSessionMetadata;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCachedVnuImport(value: unknown): CachedVnuImport | undefined {
  if (!isRecord(value) || typeof value.seed !== "string" || value.seed.length === 0 || !isRecord(value.session)) return undefined;

  const session = value.session;
  if (session.authenticated !== true || typeof session.universityId !== "string" || typeof session.expiresAt !== "string") return undefined;
  if (session.studentCode !== undefined && typeof session.studentCode !== "string") return undefined;

  return {
    seed: value.seed,
    session: {
      universityId: session.universityId,
      studentCode: session.studentCode,
      expiresAt: session.expiresAt,
      authenticated: true,
    },
  };
}

async function restoreCachedVnuImport(value: unknown, secret: string): Promise<RestoredCachedVnuImport | undefined> {
  const cached = parseCachedVnuImport(value);
  if (!cached) return undefined;

  try {
    const payload = await decryptSession(cached.seed, secret);
    const expiresAt = Date.parse(payload.expiresAt);
    if (payload.universityId !== "vnu" || payload.vnu?.kind !== "cookie" || typeof payload.vnu.value !== "string" || payload.vnu.value.length === 0) return undefined;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined;
    if (cached.session.universityId !== payload.universityId) return undefined;
    if (cached.session.studentCode !== payload.studentCode) return undefined;
    if (cached.session.expiresAt !== payload.expiresAt) return undefined;

    return { payload, session: cached.session };
  } catch {
    return undefined;
  }
}

// ── Google-login rate limiting + token revocation ───────────────────────

const GOOGLE_LOGIN_RATE_LIMIT = 5;
const GOOGLE_LOGIN_RATE_WINDOW_SECONDS = 15 * 60;

async function googleLoginRateLimitKey(email: string): Promise<string> {
  return `uet/google-login-attempts/${await hmacHex(email.trim().toLowerCase())}`;
}

// Best-effort fixed-window counter via the cache abstraction (same storage
// already used for vnu's import dedupe). Not perfectly race-free across
// concurrent requests in the same window, which is acceptable for an
// abuse-reduction guardrail, not a hard security boundary.
async function checkAndIncrementGoogleLoginAttempts(email: string): Promise<void> {
  const key = await googleLoginRateLimitKey(email);
  const existing = await cacheGet<{ count: number }>(key);
  const count = (existing?.count ?? 0) + 1;
  if (count > GOOGLE_LOGIN_RATE_LIMIT) {
    throw new HyeboardError("GOOGLE_LOGIN_RATE_LIMITED", "Too many sign-in attempts for this email. Wait 15 minutes and try again, or use the manual token option below.", 429);
  }
  await cachePut(key, { count }, GOOGLE_LOGIN_RATE_WINDOW_SECONDS);
}

async function revokedTokenKey(token: string): Promise<string> {
  return `revoked-token/${await hmacHex(token)}`;
}

async function revokeToken(token: string, expiresAt: string): Promise<void> {
  const ttlSeconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  await cachePut(await revokedTokenKey(token), { revoked: true }, ttlSeconds);
}

async function isTokenRevoked(token: string): Promise<boolean> {
  return Boolean(await cacheGet<{ revoked: true }>(await revokedTokenKey(token)));
}

async function vnuRawCacheKey(session: EncryptedSessionPayload, page: string, params: Record<string, string | undefined>): Promise<string> {
  return `vnu/raw/${await hmacHex(JSON.stringify({ cookie: session.vnu?.value ?? "", page, params }))}`;
}

async function vnuRawHtml(session: EncryptedSessionPayload, page: string, params: { selUniv?: string; selStd?: string; vTermID?: string; id?: string; val?: string; Term?: string }): Promise<string> {
  if (!session.vnu?.value) throw new HyeboardError("VNU_LOGIN_REQUIRED", "VNU (daotao) data needs a saved daotao.vnu.edu.vn session. Sign in again.", 401);
  // Client-supplied selStd/selUniv are never trusted for any key: per-student
  // branches below derive both ids from the session's own profile. Strip them
  // before cache keying too, so a smuggled value cannot even fragment this
  // session's cache entries.
  const { selStd: _ignoredSelStd, selUniv: _ignoredSelUniv, ...trustedParams } = params;
  const cacheKey = await vnuRawCacheKey(session, page, trustedParams);
  const cached = await cacheGet<{ html: string }>(cacheKey);
  if (cached) {
    if (isDaotaoSessionExpired("", cached.html)) {
      throw new HyeboardError("VNU_SESSION_EXPIRED", "The university portal session has expired. Sign in again.", 401);
    }
    return cached.html;
  }

  const client = new DaotaoClient(session);
  let html: string;
  if (page === "profile") html = await client.getProfileHtml();
  else if (page === "grades") html = await client.getGradesHtml();
  else if (page === "progress") html = await client.getStudyProgressHtml();
  else if (page === "exam-base") html = await client.getExamBaseHtml();
  else if (page === "syllabus") html = await client.getSyllabusHtml();
  else if (page === "exams") {
    if (!trustedParams.vTermID) throw new HyeboardError("VNU_EXAM_QUERY_INCOMPLETE", "Exam lookup needs a term id (vTermID); the student and university ids are always derived from your own profile server-side.", 400);
    // Same hardening as point-detail: the selStd/selUniv sent upstream are
    // ALWAYS the session owner's own internal ids, resolved from their
    // profile here on the server. Live probing showed StdExamination.asp
    // silently ignores selStd anyway (self-echo — see har-notes.md), but
    // deriving the ids server-side keeps the proxy contract uniform with the
    // genuinely un-bound endpoints (listpoint_Brc1.asp, detailPoint.asp) and
    // stays correct if upstream behavior ever changes; cross-student access
    // lives only on the gated cross-lookup routes. The profile read reuses
    // this same cached path, keyed per session cookie.
    const ownProfile = parseProfileHtml(await vnuRawHtml(session, "profile", {}));
    if (!ownProfile.internalStudentId || !ownProfile.internalUnivId) throw new HyeboardError("VNU_LOGIN_REQUIRED", "VNU (daotao) exam lookup needs your own portal student id, which this session could not provide. Sign in again.", 401);
    html = await client.getExamsHtml({ selUniv: ownProfile.internalUnivId, selStd: ownProfile.internalStudentId, vTermID: trustedParams.vTermID });
  } else if (page === "point-detail") {
    if (!trustedParams.id || !trustedParams.Term) throw new HyeboardError("VNU_POINT_DETAIL_QUERY_INCOMPLETE", "Point detail needs a class id and a term ordinal.", 400);
    // The StdID sent upstream is ALWAYS the session owner's own internal id,
    // resolved from their profile here on the server — this key never honors
    // a client-supplied selStd, so the raw proxy cannot be turned into the
    // cross-student point-detail IDOR that detailPoint.asp would otherwise
    // allow (see har-notes.md). The profile read reuses this same cached
    // path, keyed per session cookie.
    const ownProfile = parseProfileHtml(await vnuRawHtml(session, "profile", {}));
    if (!ownProfile.internalStudentId) throw new HyeboardError("VNU_LOGIN_REQUIRED", "VNU (daotao) point detail needs your own portal student id, which this session could not provide. Sign in again.", 401);
    html = await client.getPointDetailHtml({ id: trustedParams.id, stdId: ownProfile.internalStudentId, term: trustedParams.Term, val: trustedParams.val });
  } else {
    throw new HyeboardError("VNU_RAW_PAGE_UNKNOWN", `Unknown VNU raw page: ${page}`, 404);
  }

  await cachePut(cacheKey, { html }, page === "exams" || page === "point-detail" ? 60 : 300);
  return html;
}

// ─── CORS ─────────────────────────────────────────────────────
// Enabled only when HYEB_ALLOWED_ORIGINS is set (dev, or a self-hosted
// deployment serving the frontend from a different origin). Skipped when
// unset — same-origin, no CORS needed.

function corsPlugin() {
  const raw = runtimeConfig.HYEB_ALLOWED_ORIGINS;
  if (!raw) return undefined;
  const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return cors({
    origin: ({ headers }) => {
      const origin = headers.get("Origin");
      if (!origin) return true;
      return allowed.includes(origin);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    credentials: false,
  });
}

// ─── App ──────────────────────────────────────────────────────
// Builds the full Elysia app for a given adapter (Cloudflare Workers, Node,
// or Bun). Route logic is identical across all three runtimes — only the
// adapter (and, via setRuntimeConfig/setCloudflareBrowserBinding, how config
// values are sourced) differs per entry point.

// Worker-side serialization point for university capability data. The static
// adapter record (vnu: crossLookup=true) describes the Cloudflare deployment,
// where the authoritative Durable Object probe-budget coordinator exists. A
// self-hosted runtime has no such coordinator — every cross-lookup route
// there fails closed with 503 — so advertising the capability would render
// cross-lookup UI whose every request errors. Mask it honestly at this
// boundary instead of touching the shared static record (correct for
// Cloudflare; listUniversities() returns the adapters' own objects, so the
// masked list must be a copy, never a mutation).
function serializeUniversities() {
  const universities = listUniversities();
  if (probeBudgetCoordinatorInstalled) return universities;
  return universities.map((university) => university.capabilities.crossLookup
    ? { ...university, capabilities: { ...university.capabilities, crossLookup: false } }
    : university);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createApp(adapter: any) {
  const app = new Elysia({ adapter });

  const plugin = corsPlugin();
  if (plugin) app.use(plugin);

  return app
    .onRequest(({ request, set }) => {
      const req = request as unknown as { _hyebReqId?: string; _hyebStart?: number };
      req._hyebReqId = requestId();
      req._hyebStart = Date.now();
      if (new URL(request.url).pathname.startsWith("/api/vnu/cross-lookup/")) set.headers["Cache-Control"] = "no-store";
      // Set HYEB_LOG_LEVEL=debug (Node/Bun .env, or a Cloudflare secret/var)
      // to see one line per incoming request here.
      getLogger().debug({ reqId: req._hyebReqId, method: request.method, url: request.url }, "request received");
    })
    .onAfterResponse(({ request, set }) => {
      const req = request as unknown as { _hyebReqId?: string; _hyebStart?: number };
      getLogger().debug({ reqId: req._hyebReqId, status: set.status, durationMs: req._hyebStart ? Date.now() - req._hyebStart : undefined }, "request completed");
    })
    .onError(({ error, request }) => routeError(error, (request as unknown as { _hyebReqId?: string })._hyebReqId, request.url))

    // ── Public — no session required ──
    .get("/api/health", () => ok({ status: "ok", service: "hyeboard" }))
    .get("/api/universities", () => ok(serializeUniversities()))
    .post("/api/:universityId/auth/import-session", async ({ params, body, request }) => {
      const adapterInstance = getAdapter(params.universityId);
      // Keep parent/guardian direct API logins on this SSE route so a
      // server-side OCR miss can relay the CAPTCHA image to the user. The
      // same rate limit remains shared with Google automation.
      if (params.universityId === "uet" && body.uetGoogleEmail) {
        await checkAndIncrementGoogleLoginAttempts(body.uetGoogleEmail);
        // Google automation can take 90s+; parent direct login may pause for
        // a human CAPTCHA answer. Stream both as Server-Sent Events. Every
        // other branch below (vnu, manual-token/cookie paste, mock)
        // resolves almost instantly and keeps the plain JSON response.
        const encoder = new TextEncoder();
        let activeRelay: PreparedCaptchaRelay | undefined;
        let cancelled = false;
        let closed = false;
        const cancelRelay = async () => {
          if (cancelled) return;
          cancelled = true;
          const relay = activeRelay;
          activeRelay = undefined;
          await relay?.cancel().catch(() => undefined);
        };
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: string, data: unknown) => {
              if (cancelled || closed) return;
              try {
                controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
              } catch {
                void cancelRelay();
              }
            };
            const close = () => {
              if (cancelled || closed) return;
              closed = true;
              controller.close();
            };
            const onAbort = () => void cancelRelay();
            request.signal.addEventListener("abort", onAbort, { once: true });
            try {
              const imported = await adapterInstance.importSession(body, {
                browserConnection: browserConnection(),
                onProgress: (message) => send("progress", { message }),
                onCaptchaNeeded: async (image) => {
                  const relay = await captchaRelayCoordinator.prepare(image);
                  activeRelay = relay;
                  try {
                    const relayToken = await createCaptchaRelayToken(relay.challengeId);
                    if (cancelled || request.signal.aborted) throw captchaRelayCancelled();
                    send("captcha_required", { challengeId: relayToken, image: relay.image });
                    return await relay.wait(request.signal);
                  } catch (error) {
                    if (activeRelay === relay) await relay.cancel().catch(() => undefined);
                    throw error;
                  } finally {
                    if (activeRelay === relay) activeRelay = undefined;
                  }
                },
              });
              const token = await encryptSession(imported.session, getSessionSecret());
              send("done", { token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true } });
            } catch (error) {
              if (!cancelled) {
                const { code, message, status } = errorPayload(error);
                const level = status >= 500 ? "error" : "warn";
                getLogger()[level]({ code, status }, message);
                send("error", { code, message, status });
              }
            } finally {
              request.signal.removeEventListener("abort", onAbort);
              close();
            }
          },
          cancel: cancelRelay,
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            // Disables response buffering on proxies that respect this
            // (e.g. nginx) so progress events actually stream incrementally
            // instead of arriving all at once when the connection closes.
            "X-Accel-Buffering": "no",
          },
        });
      }
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
          const payload = { token, session: { universityId: normalizedSession.universityId, studentCode: normalizedSession.studentCode, expiresAt: normalizedSession.expiresAt, authenticated: true as const } };
          await cachePut(cacheKey, { seed, session: payload.session }, Math.floor((Date.parse(normalizedSession.expiresAt) - Date.now()) / 1000));
          return ok(payload);
        };

        const cached = await restoreCachedVnuImport(await cacheGet<unknown>(cacheKey), secret);
        if (!cached) return loginAndCache();

        let liveStudentCode: string | undefined;
        try {
          liveStudentCode = parseProfileHtml(await new DaotaoClient(cached.payload).getProfileHtml()).studentCode;
        } catch (error) {
          if (error instanceof HyeboardError && error.code === "VNU_SESSION_EXPIRED") return loginAndCache();
          throw error;
        }

        if (!liveStudentCode || liveStudentCode !== cached.payload.studentCode || liveStudentCode !== cached.session.studentCode) return loginAndCache();

        const token = await encryptSession(cached.payload, secret);
        return ok({ token, session: cached.session });
      }
      const imported = await adapterInstance.importSession(body);
      const token = await encryptSession(imported.session, getSessionSecret());
      return ok({ token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true } });
    }, { body: importSessionBody })
    // Answers a CAPTCHA challenge raised mid-login by the "captcha_required"
    // SSE event above. No session token exists
    // yet at this point in the flow (the whole point is to finish logging
    // in), so this is deliberately unauthenticated. Verify the signed relay
    // token before coordinator access so forged IDs cannot instantiate DOs.
    .post("/api/uet/auth/solve-captcha", async ({ body }) => {
      const relayId = await verifyCaptchaRelayToken(body.challengeId);
      if (!relayId) throw captchaRelayNotFound();
      await captchaRelayCoordinator.answer(relayId, body.answer);
      return ok({ accepted: true });
    }, {
      body: t.Object({
        challengeId: t.String({ minLength: 1, maxLength: 160 }),
        answer: t.String({ minLength: 1, maxLength: 64 }),
      }),
    })
    .post("/api/:universityId/auth/logout", async ({ headers }) => {
      const h = headers instanceof Headers ? headers : new Headers(headers as Record<string, string>);
      const token = parseBearerToken(h.get("Authorization"));
      if (token) {
        try {
          const session = await decryptSession(token, getSessionSecret());
          await revokeToken(token, session.expiresAt);
        } catch {
          // Already invalid/expired token — nothing to revoke.
        }
      }
      return ok({ authenticated: false });
    })
    .get("/api/vnu/raw/:page", async ({ headers, params, query }) => {
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      return ok({ html: await vnuRawHtml(session, params.page, query) });
    }, { query: vnuRawQuery })
    // Cross-student StdID -> student-code resolver. listpoint_Brc1.asp
    // HONORS selStd (live-verified — see har-notes.md): it renders the
    // requested student's identity header (name / 8-digit code / managing
    // class) for whatever selStd is passed. This deployment is authorized to
    // expose that, gated server-side behind an explicit opt-in flag and a
    // self-targeting rejection. Responses are NEVER cached: no shared-cache
    // path exists here, so one caller's cross-lookup result can never bleed
    // into another caller's cache entries. The fetched transcript HTML is
    // parsed here, server-side, and only the resolved code/name/class
    // ever cross the network — the target student's full grade table (which
    // the same HTML contains) is never sent to the browser. A header-less
    // response is a clean not-found, not an error.
    .get("/api/vnu/cross-lookup/student-code", async ({ headers, query }) => {
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      if (query.allowCrossLookup !== "true") throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED", "Cross-student lookup requires the explicit allowCrossLookup=true opt-in.", 400);
      if (!query.stdId || !/^\d{1,11}$/.test(query.stdId)) throw new HyeboardError("VNU_CROSS_LOOKUP_QUERY_INCOMPLETE", "Cross-student student-code lookup needs a target student id.", 400);
      // Fails closed when the caller's own id is unavailable or malformed:
      // without a parsed own identity the self-targeting check below cannot
      // run, so the request is rejected rather than allowed through
      // unverified (see parseVnuOwnIdentity).
      const ownIdentity = parseVnuOwnIdentity(parseProfileHtml(await vnuRawHtml(session, "profile", {})), {
        requireStudentCode: false,
        errorMessage: "VNU (daotao) cross-lookup needs your own portal student id, which this session could not provide. Sign in again.",
      });
      if (isOwnStdId(ownIdentity, query.stdId)) throw new HyeboardError("VNU_CROSS_LOOKUP_SELF_TARGET", "That is your own student id. Your own ID mapping is on the Lookup page; cross-lookup is only for other students.", 400);
      await consumeVnuOracleProbe(session);
      const html = await new DaotaoClient(session).getTranscriptByStdIdHtml(query.stdId);
      const { studentCode, studentName, className } = parseTranscriptHeader(html);
      if (!studentCode) throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_FOUND", "The portal did not return a student for that identifier.", 404);
      return ok({ studentCode, studentName, className });
    }, { query: vnuCrossLookupQuery })
    // Cross-student student-code -> StdID resolver (the reverse direction of
    // the route above). No portal endpoint maps a public student code back to
    // an internal StdID, so this walks the live-verified Brc1 oracle. Near
    // targets use the verified cohort-local correction. Far targets first
    // bisect a mirrored interval under a provisional monotonicity assumption,
    // then correct linearly from the closest valid result. Same gate as the
    // sibling route: session guard,
    // vnu-only, explicit allowCrossLookup=true, self-target rejection, never
    // cached. Fails closed with VNU_CROSS_LOOKUP_NOT_CONVERGED (404) when the
    // anchor model does not apply (different cohort, oscillation, invalid
    // intermediate StdID, or probe cap reached) — never returns a guessed id.
    .get("/api/vnu/cross-lookup/student-id", async ({ headers, query }) => {
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      if (query.allowCrossLookup !== "true") throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED", "Cross-student lookup requires the explicit allowCrossLookup=true opt-in.", 400);
      if (!query.stdCode || !/^\d{8}$/.test(query.stdCode)) throw new HyeboardError("VNU_CROSS_LOOKUP_QUERY_INCOMPLETE", "Cross-student student-id lookup needs a target 8-digit student code.", 400);
      const ownIdentity = parseVnuOwnIdentity(parseProfileHtml(await vnuRawHtml(session, "profile", {})), {
        requireStudentCode: true,
        errorMessage: "VNU (daotao) cross-lookup needs your own portal student id and code, which this session could not provide. Sign in again.",
      });
      if (isOwnStudentCode(ownIdentity, query.stdCode)) throw new HyeboardError("VNU_CROSS_LOOKUP_SELF_TARGET", "That is your own student code. Your own ID mapping is on the Lookup page; cross-lookup is only for other students.", 400);

      const client = new DaotaoClient(session);
      return ok(await resolveVnuStudentId({
        ownStdId: ownIdentity.ownStdId,
        ownCode: ownIdentity.ownCode,
        targetCode: Number(query.stdCode),
        farWalkEnabled: vnuFarWalkEnabled(),
        fetchStudentCode: async (stdId) => {
          await consumeVnuOracleProbe(session);
          const html = await client.getTranscriptByStdIdHtml(String(stdId));
          return parseTranscriptHeader(html).studentCode;
        },
      }));
    }, { query: vnuCrossLookupQuery })
    .get("/api/vnu/cross-lookup/transcript", async ({ headers, query, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      if (query.allowCrossLookup !== "true") throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED", "Cross-student lookup requires the explicit allowCrossLookup=true opt-in.", 400);

      const hasStdId = query.stdId !== undefined;
      const hasStdCode = query.stdCode !== undefined;
      if (hasStdId === hasStdCode || (hasStdId && !/^\d{1,11}$/.test(query.stdId!)) || (hasStdCode && !/^\d{8}$/.test(query.stdCode!))) {
        throw new HyeboardError("VNU_CROSS_LOOKUP_QUERY_INCOMPLETE", "Cross-student transcript lookup needs exactly one valid target: stdId or 8-digit stdCode.", 400);
      }

      const ownIdentity = parseVnuOwnIdentity(parseProfileHtml(await vnuRawHtml(session, "profile", {})), {
        requireStudentCode: true,
        errorMessage: "VNU (daotao) cross-lookup needs your own portal student id and code, which this session could not provide. Sign in again.",
      });
      if (hasStdId && isOwnStdId(ownIdentity, query.stdId!)) throw new HyeboardError("VNU_CROSS_LOOKUP_SELF_TARGET", "That is your own student id. Your own transcript is on the Grades page; cross-lookup is only for other students.", 400);
      if (hasStdCode && isOwnStudentCode(ownIdentity, query.stdCode!)) throw new HyeboardError("VNU_CROSS_LOOKUP_SELF_TARGET", "That is your own student code. Your own transcript is on the Grades page; cross-lookup is only for other students.", 400);

      const client = new DaotaoClient(session);
      let targetStdId = query.stdId;
      if (query.stdCode) {
        const resolvedTarget = await resolveVnuStudentId({
          ownStdId: ownIdentity.ownStdId,
          ownCode: ownIdentity.ownCode,
          targetCode: Number(query.stdCode),
          farWalkEnabled: vnuFarWalkEnabled(),
          fetchStudentCode: async (stdId) => {
            await consumeVnuOracleProbe(session);
            return parseTranscriptHeader(await client.getTranscriptByStdIdHtml(String(stdId))).studentCode;
          },
        });
        targetStdId = resolvedTarget.stdId;
      }

      await consumeVnuOracleProbe(session);
      const transcript = parseVnuCrossLookupTranscript(await client.getTranscriptByStdIdHtml(targetStdId!));
      if (!transcript.header.studentCode) throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_FOUND", "The portal did not return a student for that identifier.", 404);
      return ok(transcript);
    }, { query: vnuCrossLookupQuery })
    .post("/api/vnu/cross-lookup/bulk", async ({ headers, request }) => {
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      const body = await parseVnuBulkLookupRequest(request);

      const needsOwnCode = body.mode === "code-to-stdid";
      const ownIdentity = parseVnuOwnIdentity(parseProfileHtml(await vnuRawHtml(session, "profile", {})), {
        requireStudentCode: needsOwnCode,
        errorMessage: "VNU (daotao) bulk cross-lookup needs your own portal identifiers, which this session could not provide. Sign in again.",
      });

      const reservedUnits = vnuBulkReservationUnits(body);
      await reserveVnuOracleProbes(session, reservedUnits);
      const allowance = createVnuBulkAllowance(reservedUnits);
      const client = new DaotaoClient(session);
      const items: Array<{ target: string; status: "ok"; result: unknown } | { target: string; status: "error"; errorCode: string }> = [];

      for (let index = 0; index < body.targets.length; index += 1) {
        if (index > 0) await waitBetweenBulkItems();
        const rawTarget = body.targets[index];
        const target = typeof rawTarget === "string" ? rawTarget : "";
        const pattern = body.mode === "code-to-stdid" ? /^\d{8}$/ : /^\d{1,11}$/;
        if (typeof rawTarget !== "string" || !pattern.test(target)) {
          items.push({ target, status: "error", errorCode: "VNU_CROSS_LOOKUP_INVALID_TARGET" });
          continue;
        }

        const selfTarget = body.mode === "code-to-stdid"
          ? isOwnStudentCode(ownIdentity, target)
          : isOwnStdId(ownIdentity, target);
        if (selfTarget) {
          items.push({ target, status: "error", errorCode: "VNU_CROSS_LOOKUP_SELF_TARGET" });
          continue;
        }

        try {
          if (body.mode === "stdid-to-code") {
            allowance.consume();
            const header = parseTranscriptHeader(await client.getTranscriptByStdIdHtml(target));
            if (!header.studentCode) throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_FOUND", "Student not found", 404);
            items.push({ target, status: "ok", result: { studentCode: header.studentCode, studentName: header.studentName, className: header.className } });
            continue;
          }

          if (body.mode === "stdid-to-transcript") {
            allowance.consume();
            const transcript = parseVnuCrossLookupTranscript(await client.getTranscriptByStdIdHtml(target));
            if (!transcript.header.studentCode) throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_FOUND", "Student not found", 404);
            items.push({ target, status: "ok", result: transcript });
            continue;
          }

          const resolution = await resolveVnuStudentId({
            ownStdId: ownIdentity.ownStdId,
            // Guaranteed defined: this branch only runs for code-to-stdid,
            // which required the owner code during identity parsing above.
            ownCode: ownIdentity.ownCode!,
            targetCode: Number(target),
            farWalkEnabled: vnuFarWalkEnabled(),
            fetchStudentCode: async (stdId) => {
              allowance.consume();
              return parseTranscriptHeader(await client.getTranscriptByStdIdHtml(String(stdId))).studentCode;
            },
          });
          items.push({ target, status: "ok", result: resolution });
        } catch (error) {
          if (error instanceof HyeboardError && error.code === "VNU_SESSION_EXPIRED") throw error;
          items.push({
            target,
            status: "error",
            errorCode: error instanceof HyeboardError ? error.code : "VNU_CROSS_LOOKUP_FAILED",
          });
        }
      }

      return ok({ items });
    }, { parse: "none" })

    // ── Authenticated — session+adapter injected via resolve() ──
    .group("/api/:universityId", (g) =>
      g
        .resolve(async ({ headers, params }) => {
          const { session, refreshedToken } = await resolveSession(headers);
          if (session.universityId !== params.universityId)
            throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
          return { session, refreshedToken, adapter: getAdapter(params.universityId) };
        })
        .onAfterHandle(({ response, refreshedToken }) => {
          if (!refreshedToken || !response || typeof response !== "object") return response;
          const typed = response as { data?: unknown; error?: unknown; meta?: Record<string, unknown> };
          if (!("data" in typed)) return response;
          return { ...typed, meta: { ...(typed.meta ?? {}), refreshedToken } };
        })
        .get("/auth/session", ({ session }) => ok({ universityId: session.universityId, studentCode: session.studentCode, expiresAt: session.expiresAt, authenticated: true }))
        .get("/me", async ({ adapter, session }) => ok(await adapter.getStudentProfile({ session })))
        .get("/dashboard", async ({ adapter, session, query }) => ok(await adapter.getDashboard({ session, termCode: query.termCode })), { query: termCodeQuery })
        .get("/terms", async ({ adapter, session }) => ok(await adapter.getTerms({ session })))
        .get("/timetable", async ({ adapter, session, query }) => ok(await adapter.getTimetable({ session, termCode: query.termCode })), { query: termCodeQuery })
        .get("/courses", async ({ adapter, session }) => ok(await adapter.getCourses({ session })))
        .get("/courses/:courseId", async ({ adapter, session, params }) => ok(await adapter.getCourseDetail({ session, courseId: params.courseId })))
        .get("/assignments", async ({ adapter, session }) => ok(await adapter.getAssignments({ session })))
        .get("/grades", async ({ adapter, session }) => ok(await adapter.getGrades({ session })))
        .get("/gpa", async ({ adapter, session }) => ok(await adapter.getGpaSummary({ session })))
        .get("/exams", async ({ adapter, session, query }) => ok(await adapter.getExams({ session, termCode: query.termCode })), { query: termCodeQuery })
        .get("/attendance", async ({ adapter, session }) => ok(await adapter.getAttendance({ session })))
        .get("/notifications", async ({ adapter, session }) => ok(await adapter.getNotifications({ session })))
        .get("/news", async ({ adapter, session }) => ok(await adapter.getNews({ session })))
        .get("/documents", async ({ adapter, session }) => ok(await adapter.getDocuments({ session })))
        .get("/tuition", async ({ adapter, session }) => ok(await adapter.getTuition({ session })))
        .get("/training-points", async ({ adapter, session }) => ok(await adapter.getTrainingPoints({ session })))
        .get("/requests", async ({ adapter, session }) => ok(await adapter.getRequests({ session })))
    )
    .compile();
}
