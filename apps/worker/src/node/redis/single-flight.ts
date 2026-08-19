import { randomBytes } from "node:crypto";
import type { RedisBlockingClient, RedisCommandClient } from "./client";
import { lockKey, singleFlightKey } from "./keys";
import { acquireRedisLock, releaseRedisLock } from "./primitives";

export type RedisSingleFlightOptions = { client: RedisCommandClient; blocking: RedisBlockingClient; lockTtlMs?: number; resultTtlMs?: number; waitMs?: number };

export class RedisSingleFlight {
  private readonly blocking: RedisBlockingClient;
  constructor(private readonly options: RedisSingleFlightOptions) {
    this.blocking = options.blocking;
  }

  async run<T>(logicalKey: string, work: () => Promise<T>): Promise<T> {
    const stateKey = singleFlightKey(logicalKey);
    const resultKey = `${stateKey}:result`;
    const signalKey = `${stateKey}:signal`;
    const lock = lockKey(logicalKey);
    const lockTtlMs = this.options.lockTtlMs ?? 60_000;
    const resultTtlMs = this.options.resultTtlMs ?? lockTtlMs;
    const waitMs = this.options.waitMs ?? lockTtlMs;
    const startedAt = Date.now();
    for (;;) {
      const cached = await this.options.client.get(resultKey);
      if (cached !== null) return JSON.parse(cached) as T;
      const token = randomBytes(16).toString("hex");
      const acquired = await acquireRedisLock(this.options.client, lock, lockTtlMs, token);
      if (acquired.acquired) {
        try {
          const value = await work();
          const serialized = JSON.stringify(value);
          if (serialized === undefined) throw new Error("Redis single-flight result is not JSON serializable");
          await this.options.client.set(resultKey, serialized, { expiration: { type: "PX", value: resultTtlMs } });
          await this.options.client.eval("redis.call('LPUSH', KEYS[1], 'ready'); redis.call('PEXPIRE', KEYS[1], ARGV[1]); return 1", { keys: [signalKey], arguments: [String(resultTtlMs)] });
          return value;
        } finally { await releaseRedisLock(this.options.client, lock, token).catch(() => undefined); }
      }
      if (Date.now() - startedAt >= waitMs) throw new Error("Redis single-flight wait expired");
      await this.blocking.blPop(signalKey, Math.max(1, Math.ceil((waitMs - (Date.now() - startedAt)) / 1000))).catch(() => null);
    }
  }
}
