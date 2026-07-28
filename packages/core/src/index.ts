import type { ApiError, ApiResponse } from "@hyeboard/schemas";

export { configureLogger, getLogger, type Logger, type LoggerInit } from "./logger";

export type UpstreamCredential = {
  kind: "bearer" | "cookie" | "manual";
  value: string;
  csrfToken?: string;
  expiresAt?: string;
};

// Minimal subset of a Puppeteer/CDP cookie needed to rehydrate a Google
// session on a fresh browser (page.setCookie / page.cookies). Kept as a
// plain structural type here (not importing Puppeteer's own type) so
// packages/core stays free of a Puppeteer dependency.
export type GoogleSessionCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

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

export type EncryptedSessionPayload = {
  version: 1;
  universityId: string;
  studentCode?: string;
  studenthub?: UpstreamCredential;
  canvas?: UpstreamCredential;
  vnu?: UpstreamCredential;
  // Present only for uet sessions created via automated Google login (see
  // packages/university-adapters/src/uet/google-login-automation.ts). Lets
  // resolveSession() in apps/worker silently re-run the login when the
  // short-lived studenthub/canvas credentials expire, without forcing the
  // user to retype anything. Persisted per explicit user decision — a
  // HYEB_SESSION_SECRET compromise exposes this real password, not just a
  // scoped token. See spec's "Accepted risks" section.
  //
  // googleCookies: the actual Google (and VNU IDP) session cookies captured
  // after a successful automated login. Passed back into
  // automateVnuGoogleLogin() on the next refresh so it can rehydrate the
  // browser's session before the interactive flow starts. Confirmed by live
  // testing that Google still shows its account chooser rather than
  // silently completing OAuth from the rehydrated cookie alone — the
  // cookie's real value is that the account chooser then shows the
  // logged-in account as a one-click tile (skipping the email step), and,
  // when the VNU IDP cookie is also still valid, skips the Keycloak
  // credential form entirely. Falls back to the full interactive
  // email/password/Keycloak flow whenever any of these cookies turn out to
  // be stale/expired/revoked.
  uetGoogleCredential?: { email: string; password: string; googleCookies?: GoogleSessionCookie[] };
  // Present only for uet sessions created via a parent/guardian account
  // direct login. StudentHub's CAPTCHA challenge and login APIs need no
  // Google OAuth or browser automation. Persisted for the same reason as
  // uetGoogleCredential above: resolveSession() can silently re-authenticate
  // on expiry when Node-only OCR solves the fresh challenge. A deployment
  // without OCR returns STUDENTHUB_CAPTCHA_REQUIRED during silent refresh.
  uetParentCredential?: { username: string; password: string };
  vnuRefresh?: VnuRefreshAccessDescriptor;
  expiresAt: string;
};

export function ok<T>(data: T, meta?: Record<string, unknown>): ApiResponse<T> {
  return { data, error: null, meta };
}

export function fail(code: string, message: string, details?: unknown): ApiResponse<never> {
  const error: ApiError = { code, message, details };
  return { data: null, error };
}

export class HyeboardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 500,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function assertSupported(value: boolean, feature: string): void {
  if (!value) throw new HyeboardError("UNSUPPORTED_FEATURE", `${feature} is not supported by this university`, 501);
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function addHours(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function isExpired(isoDate: string): boolean {
  return new Date(isoDate).getTime() <= Date.now();
}

export function parseBearerToken(authorizationHeader?: string | null): string | null {
  if (!authorizationHeader) return null;
  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const textEncoder = new TextEncoder();
const VNU_REFRESH_LIFETIME_MS = 8 * 60 * 60 * 1000;
const VNU_REFRESH_SALT = textEncoder.encode("hyeboard:vnu-refresh:v1:salt");
const VNU_REFRESH_INFO = textEncoder.encode("hyeboard:vnu-refresh:v1:aes-gcm");
const VNU_REFRESH_AAD = textEncoder.encode("hyeboard:vnu-refresh:v1");
const VNU_PRINCIPAL_SALT = textEncoder.encode("hyeboard:vnu-refresh-principal:v1:salt");
const VNU_PRINCIPAL_INFO = textEncoder.encode("hyeboard:vnu-refresh-principal:v1:hmac-sha256");
const VNU_PRINCIPAL_MESSAGE_PREFIX = "hyeboard:vnu-refresh-principal:v1:";
const BASE64URL_128_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const VNU_PRINCIPAL_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_KEYS = [
  "canvas",
  "expiresAt",
  "studentCode",
  "studenthub",
  "uetGoogleCredential",
  "uetParentCredential",
  "universityId",
  "version",
  "vnu",
  "vnuRefresh",
] as const;
const CREDENTIAL_KEYS = ["csrfToken", "expiresAt", "kind", "value"] as const;
const GOOGLE_CREDENTIAL_KEYS = ["email", "googleCookies", "password"] as const;
const GOOGLE_COOKIE_KEYS = ["domain", "expires", "httpOnly", "name", "path", "sameSite", "secure", "value"] as const;
const PARENT_CREDENTIAL_KEYS = ["password", "username"] as const;
const GRANT_KEYS = ["expectedStudentCode", "expiresAt", "grantId", "issuedAt", "password", "purpose", "universityId", "username", "version"] as const;
const DESCRIPTOR_KEYS = ["accessExpiresAt", "accessTokenId", "grantExpiresAt", "grantId", "principalKey", "purpose", "version"] as const;

type RandomBytes = (length: number) => Uint8Array;
type JsonObject = Record<string, unknown>;

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function assertStrongSecret(secret: string): void {
  if (secret.length < 32) throw new HyeboardError("WEAK_SESSION_SECRET", "HYEB_SESSION_SECRET must be at least 32 characters", 500);
}

function invalidSession(): HyeboardError {
  return new HyeboardError("INVALID_SESSION", "Invalid session token", 401);
}

function invalidVnuRefreshGrant(): HyeboardError {
  return new HyeboardError("VNU_REFRESH_GRANT_INVALID", "The VNU reconnect grant is invalid or expired.", 401);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, allowedKeys: readonly string[], requiredKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowedKeys.includes(key)) && requiredKeys.every((key) => Object.hasOwn(value, key));
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseCanonicalIso(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString() === value ? timestamp : null;
}

function normalizeVnuUsername(username: string): string {
  return username.trim().toLowerCase();
}

function isBase64Url128(value: unknown): value is string {
  if (typeof value !== "string" || !BASE64URL_128_PATTERN.test(value)) return false;
  const bytes = fromBase64Url(value);
  return bytes.byteLength === 16 && toBase64Url(bytes) === value;
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deriveHkdfKey(secret: string, salt: Uint8Array, info: Uint8Array, algorithm: AesDerivedKeyParams | HmacImportParams, usages: KeyUsage[]): Promise<CryptoKey> {
  assertStrongSecret(secret);
  const material = await crypto.subtle.importKey("raw", textEncoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(salt), info: toArrayBuffer(info) },
    material,
    algorithm,
    false,
    usages,
  );
}

async function deriveVnuRefreshGrantKey(secret: string): Promise<CryptoKey> {
  return deriveHkdfKey(secret, VNU_REFRESH_SALT, VNU_REFRESH_INFO, { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function assertVnuRefreshGrantPayload(value: unknown): asserts value is VnuRefreshGrantPayload {
  if (!isJsonObject(value) || !hasExactKeys(value, GRANT_KEYS, GRANT_KEYS)) throw invalidVnuRefreshGrant();
  if (value.version !== 1 || value.purpose !== "vnu-refresh" || value.universityId !== "vnu") throw invalidVnuRefreshGrant();
  if (!isBase64Url128(value.grantId)) throw invalidVnuRefreshGrant();
  if (!isNonemptyString(value.username) || value.username !== normalizeVnuUsername(value.username)) throw invalidVnuRefreshGrant();
  if (!isNonemptyString(value.password) || !isNonemptyString(value.expectedStudentCode)) throw invalidVnuRefreshGrant();
  const issuedAt = parseCanonicalIso(value.issuedAt);
  const expiresAt = parseCanonicalIso(value.expiresAt);
  if (issuedAt === null || expiresAt === null || expiresAt - issuedAt !== VNU_REFRESH_LIFETIME_MS) throw invalidVnuRefreshGrant();
}

export function assertVnuRefreshAccessDescriptor(value: unknown): asserts value is VnuRefreshAccessDescriptor {
  if (!isJsonObject(value) || !hasExactKeys(value, DESCRIPTOR_KEYS, DESCRIPTOR_KEYS)) throw invalidSession();
  if (value.version !== 1 || value.purpose !== "vnu-refresh-access") throw invalidSession();
  if (!isNonemptyString(value.principalKey) || !VNU_PRINCIPAL_PATTERN.test(value.principalKey)) throw invalidSession();
  if (!isBase64Url128(value.accessTokenId) || !isBase64Url128(value.grantId)) throw invalidSession();
  if (parseCanonicalIso(value.accessExpiresAt) === null || parseCanonicalIso(value.grantExpiresAt) === null) throw invalidSession();
}

function assertUpstreamCredential(value: unknown): void {
  if (!isJsonObject(value) || !hasExactKeys(value, CREDENTIAL_KEYS, ["kind", "value"])) throw invalidSession();
  if (value.kind !== "bearer" && value.kind !== "cookie" && value.kind !== "manual") throw invalidSession();
  if (!isNonemptyString(value.value)) throw invalidSession();
  if (value.csrfToken !== undefined && !isNonemptyString(value.csrfToken)) throw invalidSession();
  if (value.expiresAt !== undefined && parseCanonicalIso(value.expiresAt) === null) throw invalidSession();
}

function assertGoogleCookie(value: unknown): void {
  if (!isJsonObject(value) || !hasExactKeys(value, GOOGLE_COOKIE_KEYS, ["name", "value", "domain", "path"])) throw invalidSession();
  for (const key of ["name", "value", "domain", "path"] as const) if (!isNonemptyString(value[key])) throw invalidSession();
  if (value.expires !== undefined && (typeof value.expires !== "number" || !Number.isFinite(value.expires))) throw invalidSession();
  for (const key of ["httpOnly", "secure"] as const) if (value[key] !== undefined && typeof value[key] !== "boolean") throw invalidSession();
  if (value.sameSite !== undefined && value.sameSite !== "Strict" && value.sameSite !== "Lax" && value.sameSite !== "None") throw invalidSession();
}

function parseEncryptedSessionPayload(value: unknown): EncryptedSessionPayload {
  if (!isJsonObject(value) || value.version !== 1) throw invalidSession();
  if (value.vnuRefresh === undefined) return value as EncryptedSessionPayload;
  if (!hasExactKeys(value, SESSION_KEYS, ["version", "universityId", "expiresAt"])) throw invalidSession();
  if (value.version !== 1 || !isNonemptyString(value.universityId) || parseCanonicalIso(value.expiresAt) === null) throw invalidSession();
  if (value.studentCode !== undefined && !isNonemptyString(value.studentCode)) throw invalidSession();
  for (const key of ["studenthub", "canvas", "vnu"] as const) if (value[key] !== undefined) assertUpstreamCredential(value[key]);
  if (value.uetParentCredential !== undefined) {
    if (!isJsonObject(value.uetParentCredential) || !hasExactKeys(value.uetParentCredential, PARENT_CREDENTIAL_KEYS, PARENT_CREDENTIAL_KEYS)) throw invalidSession();
    if (!isNonemptyString(value.uetParentCredential.username) || !isNonemptyString(value.uetParentCredential.password)) throw invalidSession();
  }
  if (value.uetGoogleCredential !== undefined) {
    if (!isJsonObject(value.uetGoogleCredential) || !hasExactKeys(value.uetGoogleCredential, GOOGLE_CREDENTIAL_KEYS, ["email", "password"])) throw invalidSession();
    if (!isNonemptyString(value.uetGoogleCredential.email) || !isNonemptyString(value.uetGoogleCredential.password)) throw invalidSession();
    if (value.uetGoogleCredential.googleCookies !== undefined) {
      if (!Array.isArray(value.uetGoogleCredential.googleCookies)) throw invalidSession();
      for (const cookie of value.uetGoogleCredential.googleCookies) assertGoogleCookie(cookie);
    }
  }
  assertVnuRefreshAccessDescriptor(value.vnuRefresh);
  if (value.universityId !== "vnu" || !isJsonObject(value.vnu) || !isNonemptyString(value.vnu.value)) throw invalidSession();
  if (value.vnuRefresh.accessExpiresAt !== value.expiresAt) throw invalidSession();
  return value as EncryptedSessionPayload;
}

export function createVnuRefreshGrant(input: {
  username: string;
  password: string;
  expectedStudentCode: string;
  now?: number;
  randomBytes?: RandomBytes;
}): VnuRefreshGrantPayload {
  const now = input.now ?? Date.now();
  const randomBytes = input.randomBytes ?? defaultRandomBytes;
  const payload: VnuRefreshGrantPayload = {
    version: 1,
    purpose: "vnu-refresh",
    grantId: toBase64Url(randomBytes(16)),
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
  const rotated = { ...payload, grantId: toBase64Url(randomBytes(16)) };
  assertVnuRefreshGrantPayload(rotated);
  return rotated;
}

export async function deriveVnuRefreshPrincipal(username: string, secret: string): Promise<string> {
  const normalizedUsername = normalizeVnuUsername(username);
  if (!normalizedUsername) throw invalidSession();
  const key = await deriveHkdfKey(secret, VNU_PRINCIPAL_SALT, VNU_PRINCIPAL_INFO, { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(`${VNU_PRINCIPAL_MESSAGE_PREFIX}${normalizedUsername}`));
  return encodeHex(new Uint8Array(signature));
}

export async function createVnuRefreshAccessDescriptor(input: {
  username: string;
  grantId: string;
  accessExpiresAt: string;
  grantExpiresAt: string;
  secret: string;
  randomBytes?: RandomBytes;
}): Promise<VnuRefreshAccessDescriptor> {
  const randomBytes = input.randomBytes ?? defaultRandomBytes;
  const descriptor: VnuRefreshAccessDescriptor = {
    version: 1,
    purpose: "vnu-refresh-access",
    principalKey: await deriveVnuRefreshPrincipal(input.username, input.secret),
    accessTokenId: toBase64Url(randomBytes(16)),
    grantId: input.grantId,
    accessExpiresAt: input.accessExpiresAt,
    grantExpiresAt: input.grantExpiresAt,
  };
  assertVnuRefreshAccessDescriptor(descriptor);
  return descriptor;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function assertVnuRefreshGrantMatchesDescriptor(
  grant: VnuRefreshGrantPayload,
  descriptor: VnuRefreshAccessDescriptor,
  secret: string,
): Promise<void> {
  try {
    assertVnuRefreshGrantPayload(grant);
    assertVnuRefreshAccessDescriptor(descriptor);
  } catch {
    throw invalidSession();
  }
  if (grant.grantId !== descriptor.grantId || grant.expiresAt !== descriptor.grantExpiresAt) throw invalidSession();
  const expectedPrincipal = await deriveVnuRefreshPrincipal(grant.username, secret);
  if (!constantTimeEqual(expectedPrincipal, descriptor.principalKey)) throw invalidSession();
}

export async function encryptVnuRefreshGrant(payload: VnuRefreshGrantPayload, secret: string): Promise<string> {
  assertVnuRefreshGrantPayload(payload);
  const iv = defaultRandomBytes(12);
  const key = await deriveVnuRefreshGrantKey(secret);
  const encoded = textEncoder.encode(JSON.stringify(payload));
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
    if (iv.byteLength !== 12 || toBase64Url(iv) !== parts[0]) throw invalidVnuRefreshGrant();
    const encrypted = fromBase64Url(parts[1]);
    if (encrypted.byteLength < 17 || toBase64Url(encrypted) !== parts[1]) throw invalidVnuRefreshGrant();
    const key = await deriveVnuRefreshGrantKey(secret);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(VNU_REFRESH_AAD) },
      key,
      toArrayBuffer(encrypted),
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

export async function encryptSession(payload: EncryptedSessionPayload, secret: string): Promise<string> {
  assertStrongSecret(secret);
  const parsedPayload = parseEncryptedSessionPayload(payload);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret);
  const encoded = new TextEncoder().encode(JSON.stringify(parsedPayload));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(encoded)));
  return `${toBase64Url(iv)}.${toBase64Url(encrypted)}`;
}

async function decryptAccessToken(token: string, secret: string): Promise<EncryptedSessionPayload> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalidSession();
    const iv = fromBase64Url(parts[0]);
    const encrypted = fromBase64Url(parts[1]);
    if (iv.byteLength !== 12 || toBase64Url(iv) !== parts[0] || encrypted.byteLength < 17 || toBase64Url(encrypted) !== parts[1]) throw invalidSession();
    const key = await deriveKey(secret);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(encrypted));
    const payload: unknown = JSON.parse(new TextDecoder().decode(decrypted));
    return parseEncryptedSessionPayload(payload);
  } catch (error) {
    if (error instanceof HyeboardError && error.code === "WEAK_SESSION_SECRET") throw error;
    throw invalidSession();
  }
}

export async function decryptSession(token: string, secret: string): Promise<EncryptedSessionPayload> {
  const payload = await decryptAccessToken(token, secret);
  if (isExpired(payload.expiresAt)) throw new HyeboardError("SESSION_EXPIRED", "Session expired", 401);
  return payload;
}

export function decryptSessionForVnuRefresh(token: string, secret: string): Promise<EncryptedSessionPayload> {
  return decryptVnuRefreshPurposeToken(token, secret);
}

export function decryptSessionForVnuLogout(token: string, secret: string): Promise<EncryptedSessionPayload> {
  return decryptVnuRefreshPurposeToken(token, secret);
}

async function decryptVnuRefreshPurposeToken(token: string, secret: string): Promise<EncryptedSessionPayload> {
  const payload = await decryptAccessToken(token, secret);
  if (!payload.vnuRefresh) throw invalidSession();
  return payload;
}

export function unwrapStudentHubEnvelope<T>(input: { code?: unknown; msgCode?: unknown; data?: T } | T): T {
  if (input && typeof input === "object" && "data" in input && "code" in input) {
    return (input as { data: T }).data;
  }
  return input as T;
}

export function combineDateTime(date?: string, time?: string): string {
  if (!date && !time) return isoNow();
  if (date && !time) return new Date(date).toISOString();
  const normalized = `${date ?? new Date().toISOString().slice(0, 10)}T${time}`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? isoNow() : parsed.toISOString();
}
