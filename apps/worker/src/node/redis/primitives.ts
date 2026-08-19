import { randomBytes } from "node:crypto";
import type { RedisCommandClient } from "./client";
import { acquireLeaseScript, acquireLockScript, fixedWindowScript, releaseLeaseScript, releaseLockScript, renewLockScript } from "./scripts";

function number(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Invalid Redis script result");
  return result;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid Redis ${name}`);
}

export async function acquireRedisLock(client: RedisCommandClient, key: string, ttlMs: number, token = randomBytes(16).toString("hex")): Promise<{ acquired: boolean; token: string }> {
  positiveInteger(ttlMs, "lock TTL");
  const result = await client.eval(acquireLockScript, { keys: [key], arguments: [token, String(ttlMs)] });
  return { acquired: number(result) === 1, token };
}

export async function releaseRedisLock(client: RedisCommandClient, key: string, token: string): Promise<void> {
  await client.eval(releaseLockScript, { keys: [key], arguments: [token] });
}

export async function renewRedisLock(client: RedisCommandClient, key: string, token: string, ttlMs: number): Promise<boolean> {
  positiveInteger(ttlMs, "lock TTL");
  return number(await client.eval(renewLockScript, { keys: [key], arguments: [token, String(ttlMs)] })) === 1;
}

export async function consumeFixedWindow(client: RedisCommandClient, key: string, amount: number, windowMs: number, limit: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  positiveInteger(amount, "rate-limit amount");
  positiveInteger(windowMs, "rate-limit window");
  positiveInteger(limit, "rate-limit limit");
  const result = await client.eval(fixedWindowScript, { keys: [key], arguments: [String(amount), String(windowMs), String(limit)] });
  if (!Array.isArray(result) || result.length < 2) throw new Error("Invalid Redis rate-limit result");
  return { allowed: number(result[0]) === 1, retryAfterSeconds: number(result[1]) };
}

export async function acquireRedisLease(client: RedisCommandClient, key: string, limit: number, ttlMs: number): Promise<{ allowed: boolean; leaseId?: string; expiresAt?: number; retryAfterSeconds?: number }> {
  positiveInteger(limit, "lease limit");
  positiveInteger(ttlMs, "lease TTL");
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const leaseId = randomBytes(16).toString("hex");
  const result = await client.eval(acquireLeaseScript, { keys: [key], arguments: [String(now), String(expiresAt), String(limit), leaseId] });
  if (!Array.isArray(result) || result.length < 2) throw new Error("Invalid Redis lease result");
  if (number(result[0]) !== 1) return { allowed: false, retryAfterSeconds: number(result[1]) };
  return { allowed: true, leaseId, expiresAt: number(result[1]) };
}

export async function releaseRedisLease(client: RedisCommandClient, key: string, leaseId: string): Promise<void> {
  await client.eval(releaseLeaseScript, { keys: [key], arguments: [leaseId] });
}
