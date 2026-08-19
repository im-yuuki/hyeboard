import { describe, expect, it } from "vitest";
import { createRedisClient, type RedisBlockingClient, type RedisCommandClient, type RedisMultiLike } from "./client";
import { cacheKey, captchaRelayKey, captchaRelaySignalKey, crossDetailLeaseKey, crossDetailPermitKey, crossDetailWindowKey, refreshStateKey } from "./keys";
import { RedisJsonCache } from "./cache";
import { RedisCaptchaRelayCoordinator } from "./captcha-relay-coordinator";
import { RedisSingleFlight } from "./single-flight";
import { RedisVnuProbeBudgetCoordinator } from "./vnu-probe-budget-coordinator";
import { RedisVnuRefreshControlCoordinator } from "./vnu-refresh-coordinator";
import type { LinkedPair } from "../../vnu-refresh-control";

class FakeRedis implements RedisBlockingClient {
  readonly values = new Map<string, string>();
  readonly lists = new Map<string, string[]>();
  readonly commands: Array<{ script: string; keys?: string[]; arguments?: string[] }> = [];
  private lock = false;
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async set(key: string, value: string, options?: { expiration?: { type: "PX" | "EX"; value: number }; condition?: "NX" | "XX" }): Promise<string | null> {
    if (options?.condition === "NX" && this.values.has(key)) return null;
    this.values.set(key, value); return "OK";
  }
  async del(key: string): Promise<number> {
    const deleted = this.values.delete(key) || this.lists.delete(key);
    return deleted ? 1 : 0;
  }
  async watch(): Promise<void> {}
  async unwatch(): Promise<void> {}
  multi(): RedisMultiLike {
    const commands: Array<() => Promise<unknown>> = [];
    return {
      set: (key, value) => { commands.push(() => this.set(key, value)); return this.multiWith(commands); },
      del: (key) => { commands.push(() => this.del(key)); return this.multiWith(commands); },
      exec: async () => { for (const command of commands) await command(); return []; },
    };
  }
  private multiWith(commands: Array<() => Promise<unknown>>): RedisMultiLike {
    return { set: (key, value) => { commands.push(() => this.set(key, value)); return this.multiWith(commands); }, del: (key) => { commands.push(() => this.del(key)); return this.multiWith(commands); }, exec: async () => { for (const command of commands) await command(); return []; } };
  }
  async eval(script: string, options: { keys?: string[]; arguments?: string[] }): Promise<unknown> {
    this.commands.push({ script, ...options });
    const key = options.keys?.[0] ?? "";
    const args = options.arguments ?? [];
    if (script.includes("state.status")) {
      const raw = this.values.get(key); if (!raw) return 0;
      const state = JSON.parse(raw) as Record<string, unknown>; if (state.status !== "pending") return 0;
      state.status = args[0]; if (args[0] === "answered") state.answer = args[2];
      if (args[0] === "answered") this.values.set(key, JSON.stringify(state));
      else this.values.delete(key);
      const signal = options.keys?.[1]!; this.lists.set(signal, [args[0]]); return 1;
    }
    if (script.includes("PTTL") && script.includes("INCRBY")) return [1, 0];
    if (script.includes("cjson.decode")) return [1, Date.now() + 125_000, "ENVELOPE"];
    if (script.includes("ZREMRANGEBYSCORE") && script.includes("ZCARD")) return [1, Date.now() + 125_000];
    if (script.includes("SET', KEYS[1]")) { if (this.lock) return 0; this.lock = true; return 1; }
    if (script.includes("GET', KEYS[1]")) { this.lock = false; return 1; }
    if (script.includes("LPUSH")) { this.lists.set(key, ["ready"]); return 1; }
    if (script.includes("redis.call('SET', KEYS[i]")) return 1;
    return 0;
  }
  async blPop(key: string): Promise<{ key: string; element: string } | null> {
    const value = this.lists.get(key)?.shift(); return value === undefined ? null : { key, element: value };
  }
}

const PAIR: LinkedPair = { accessTokenId: "A".repeat(22), accessExpiresAt: Date.now() + 600_000, grantId: "B".repeat(22), grantExpiresAt: Date.now() + 900_000 };

describe("Redis HA primitives", () => {
  it("exposes node-redis clients through the narrow injectable interfaces", () => {
    const client: RedisCommandClient = createRedisClient();
    expect(client).toBeDefined();
  });

  it("uses versioned opaque hash-tagged keys and rejects non-opaque identities", () => {
    const key = refreshStateKey("a".repeat(64));
    expect(key).toMatch(/^hyeboard:v1:\{[0-9a-f]{64}\}:refresh$/);
    expect(key).not.toContain("a".repeat(64));
    expect(() => refreshStateKey("raw-user-id")).toThrow();
    expect(() => captchaRelayKey("short")).toThrow();
  });

  it("co-locates every multi-key operation under one Redis Cluster hash tag", () => {
    const identity = "a".repeat(64);
    const tag = (key: string) => key.match(/\{([^}]+)\}/)?.[1];
    expect(new Set([
      tag(crossDetailPermitKey(identity, "1".repeat(64))),
      tag(crossDetailLeaseKey(identity)),
      tag(crossDetailWindowKey(identity)),
    ]).size).toBe(1);
    expect(tag(captchaRelayKey("C".repeat(16)))).toBe(tag(captchaRelaySignalKey("C".repeat(16))));
  });

  it("keeps refresh transitions in the existing pure contract and writes through CAS", async () => {
    const redis = new FakeRedis();
    const coordinator = new RedisVnuRefreshControlCoordinator({ client: redis });
    await expect(coordinator.activatePair("a".repeat(64), PAIR)).resolves.toEqual({ kind: "activated" });
    const stored = await redis.get(refreshStateKey("a".repeat(64)));
    expect(stored).toContain(PAIR.accessTokenId);
    expect(redis.commands.some(({ script }) => script === undefined)).toBe(false);
  });

  it("maps probe budget and permit results without leaking the session identity", async () => {
    const redis = new FakeRedis();
    const coordinator = new RedisVnuProbeBudgetCoordinator({ client: redis });
    await coordinator.consume("a".repeat(64), 3);
    await expect(coordinator.acquireBrc1Permit("a".repeat(64))).resolves.toMatchObject({ leaseId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const commandText = JSON.stringify(redis.commands);
    expect(commandText).not.toContain("a".repeat(64));
    expect(commandText).not.toMatch(/password|cookie|raw.?token/i);
  });

  it("keeps cross-detail permits opaque and returns only the validated envelope", async () => {
    const redis = new FakeRedis();
    const coordinator = new RedisVnuProbeBudgetCoordinator({ client: redis });
    const limits = { maxTargets: 1, maxRows: 1, concurrency: 1, budget: 2, windowSeconds: 60 };
    const permit = {
      permitHash: "1".repeat(64),
      record: {
        requesterHmac: "2".repeat(64), targetHmac: "3".repeat(64), revisionHmac: "4".repeat(64), rowHmac: "5".repeat(64),
        policyVersion: 1, nonce: "6".repeat(32), envelope: "ENVELOPE", expiresAt: Date.now() + 60_000,
      },
    };
    await coordinator.issueCrossDetailPermits("a".repeat(64), [permit], limits);
    await expect(coordinator.consumeCrossDetailPermit("a".repeat(64), { ...permit.record, permitHash: permit.permitHash }, limits)).resolves.toMatchObject({ envelope: "ENVELOPE" });
    expect(JSON.stringify(redis.commands)).not.toContain("a".repeat(64));
  });

  it("preserves CAPTCHA answer-before-wait and cancellation semantics", async () => {
    const redis = new FakeRedis();
    const coordinator = new RedisCaptchaRelayCoordinator({ client: redis, blocking: redis, createId: () => "C".repeat(16), timeoutMs: 50 });
    const relay = await coordinator.prepare("data:image/png;base64,IMAGE");
    expect(JSON.stringify(redis.values)).not.toContain("data:image/png;base64,IMAGE");
    await coordinator.answer(relay.challengeId, "ANSWER");
    await expect(relay.wait()).resolves.toBe("ANSWER");
    await expect(coordinator.answer(relay.challengeId, "LATE")).rejects.toMatchObject({ code: "STUDENTHUB_CAPTCHA_CHALLENGE_NOT_FOUND" });
    const cancelled = await coordinator.prepare("data:image/png;base64,IMAGE");
    await cancelled.cancel();
    await expect(cancelled.wait()).rejects.toMatchObject({ code: "STUDENTHUB_CAPTCHA_CHALLENGE_NOT_FOUND" });
  });

  it("cleans a relay state and signal when a waiter is aborted", async () => {
    const redis = new FakeRedis();
    const coordinator = new RedisCaptchaRelayCoordinator({ client: redis, blocking: redis, createId: () => "D".repeat(16), timeoutMs: 1000 });
    const relay = await coordinator.prepare("IMAGE");
    const controller = new AbortController();
    const waiting = relay.wait(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "STUDENTHUB_CAPTCHA_CANCELLED" });
    expect(await redis.get(captchaRelayKey(relay.challengeId))).toBeNull();
    expect(redis.lists.has(captchaRelaySignalKey(relay.challengeId))).toBe(false);
  });

  it("provides JSON cache and distributed import single-flight on hashed keys", async () => {
    const redis = new FakeRedis();
    const cache = new RedisJsonCache({ client: redis, defaultTtlMs: 1000 });
    await cache.set("student-import", { ok: true });
    await expect(cache.get<{ ok: boolean }>("student-import")).resolves.toEqual({ ok: true });
    expect([...redis.values.keys()].some((key) => key === cacheKey("student-import"))).toBe(true);
    const singleFlight = new RedisSingleFlight({ client: redis, blocking: redis, resultTtlMs: 1000 });
    let calls = 0;
    await expect(singleFlight.run("student-import", async () => { calls += 1; return { imported: true }; })).resolves.toEqual({ imported: true });
    await expect(singleFlight.run("student-import", async () => { calls += 1; return { imported: false }; })).resolves.toEqual({ imported: true });
    expect(calls).toBe(1);
  });
});
