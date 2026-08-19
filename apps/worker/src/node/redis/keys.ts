import { createHash } from "node:crypto";

export const REDIS_KEY_PREFIX = "hyeboard:v1";

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_32 = /^[0-9a-f]{32}$/;

function opaque(value: string, pattern: RegExp, name: string): string {
  if (!pattern.test(value)) throw new Error(`Invalid Redis ${name}`);
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function scoped(scope: string, kind: string, suffix = ""): string {
  const tag = digest(scope);
  return `${REDIS_KEY_PREFIX}:{${tag}}:${kind}${suffix ? `:${suffix}` : ""}`;
}

export function refreshStateKey(principalKey: string): string {
  return scoped(opaque(principalKey, HEX_64, "principal key"), "refresh");
}

export function probeBudgetKey(sessionIdentity: string): string {
  return scoped(opaque(sessionIdentity, HEX_64, "session identity"), "probe-budget");
}

export function brc1PermitKey(sessionIdentity: string): string {
  return scoped(opaque(sessionIdentity, HEX_64, "session identity"), "brc1-leases");
}

export function crossDetailLeaseKey(sessionIdentity: string): string {
  return scoped(opaque(sessionIdentity, HEX_64, "session identity"), "cross-detail-leases");
}

export function crossDetailWindowKey(sessionIdentity: string): string {
  return scoped(opaque(sessionIdentity, HEX_64, "session identity"), "cross-detail-window");
}

export function crossDetailPermitKey(sessionIdentity: string, permitHash: string): string {
  return scoped(opaque(sessionIdentity, HEX_64, "session identity"), "cross-detail-permit", opaque(permitHash, HEX_64, "permit hash"));
}

export function captchaRelayKey(challengeId: string): string {
  return scoped(opaque(challengeId, /^[A-Za-z0-9_-]{16,128}$/, "captcha challenge ID"), "captcha");
}

export function captchaRelaySignalKey(challengeId: string): string {
  return scoped(opaque(challengeId, /^[A-Za-z0-9_-]{16,128}$/, "captcha challenge ID"), "captcha-signal");
}

export function singleFlightKey(logicalKey: string): string {
  if (logicalKey.length === 0 || logicalKey.length > 4096) throw new Error("Invalid Redis single-flight key");
  return scoped(logicalKey, "single-flight");
}

export function cacheKey(logicalKey: string): string {
  if (logicalKey.length === 0 || logicalKey.length > 4096) throw new Error("Invalid Redis cache key");
  return scoped(logicalKey, "cache");
}

export function lockKey(logicalKey: string): string {
  if (logicalKey.length === 0 || logicalKey.length > 4096) throw new Error("Invalid Redis lock key");
  return scoped(logicalKey, "lock");
}

export function ensureLeaseId(leaseId: string): string {
  return opaque(leaseId, HEX_32, "lease ID");
}
