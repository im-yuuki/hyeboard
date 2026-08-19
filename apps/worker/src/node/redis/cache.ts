import type { RedisCommandClient } from "./client";
import { cacheKey } from "./keys";

export type RedisCacheOptions = { client: RedisCommandClient; defaultTtlMs?: number };

export class RedisJsonCache {
  constructor(private readonly options: RedisCacheOptions) { this.options.defaultTtlMs ??= 60_000; }
  async get<T>(logicalKey: string): Promise<T | undefined> {
    const raw = await this.options.client.get(cacheKey(logicalKey));
    return raw === null ? undefined : JSON.parse(raw) as T;
  }
  async set<T>(logicalKey: string, value: T, ttlMs = this.options.defaultTtlMs!): Promise<void> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Redis cache TTL must be positive");
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Redis cache value is not JSON serializable");
    await this.options.client.set(cacheKey(logicalKey), serialized, { expiration: { type: "PX", value: ttlMs } });
  }
  async delete(logicalKey: string): Promise<void> { await this.options.client.del(cacheKey(logicalKey)); }
}
