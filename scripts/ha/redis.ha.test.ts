import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { dockerImagesAreAvailable, dockerIsAvailable, runProbe, WorkerProcess } from "./test-support.js";

const dockerAvailable = await dockerIsAvailable();
const imagesAvailable = dockerAvailable && await dockerImagesAreAvailable(["postgres:16-alpine", "redis:7-alpine"]);
const infrastructureAvailable = dockerAvailable && imagesAvailable;
if (!infrastructureAvailable) {
  const reason = dockerAvailable
    ? "required Docker images are not present (pull postgres:16-alpine and redis:7-alpine first)"
    : "Docker is unavailable";
  if (process.env.HYEB_REQUIRE_HA_INFRASTRUCTURE === "true") {
    throw new Error(`[ha:redis] ${reason}`);
  }
  console.warn(`[ha:redis] SKIPPED: ${reason}; no fake integration result will be reported.`);
}

describe.skipIf(!infrastructureAvailable)("HA Redis integration", () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let workers: WorkerProcess[] = [];

  beforeAll(async () => {
    const containers = await Promise.allSettled([
      new PostgreSqlContainer("postgres:16-alpine").start(),
      new RedisContainer("redis:7-alpine").start(),
    ]);
    if (containers[0]?.status === "rejected" || containers[1]?.status === "rejected") {
      await Promise.allSettled(containers.map((result) => result.status === "fulfilled" ? result.value.stop() : undefined));
      throw containers.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
    }
    postgres = containers[0].value;
    redis = containers[1].value;
    const startedWorkers = await Promise.allSettled([
      WorkerProcess.start({ port: 0, nodeId: "ha-redis-a", postgresUrl: postgres.getConnectionUri(), redisUrl: redis.getConnectionUrl() }),
      WorkerProcess.start({ port: 0, nodeId: "ha-redis-b", postgresUrl: postgres.getConnectionUri(), redisUrl: redis.getConnectionUrl() }),
    ]);
    workers = startedWorkers.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const workerFailure = startedWorkers.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (workerFailure) {
      await Promise.allSettled(workers.map((worker) => worker.stop()));
      await Promise.allSettled([postgres.stop(), redis.stop()]);
      workers = [];
      throw workerFailure.reason;
    }
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(workers.map((worker) => worker.stop()));
    await Promise.allSettled([postgres?.stop(), redis?.stop()]);
  });

  it("serializes refresh leases across independent Redis processes", async () => {
    const principalKey = "b".repeat(64);
    const pair = { accessTokenId: "C".repeat(22), accessExpiresAt: Date.now() + 600_000, grantId: "D".repeat(22), grantExpiresAt: Date.now() + 900_000 };
    await runProbe("redis", "activate", { principalKey, pair }, { redisUrl: redis.getConnectionUrl() });
    const results = await Promise.all([
      runProbe("redis", "begin", { principalKey, pair }, { redisUrl: redis.getConnectionUrl() }),
      runProbe("redis", "begin", { principalKey, pair }, { redisUrl: redis.getConnectionUrl() }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["accepted", "in-progress"]);
  });

  it("relays a CAPTCHA answer between independent Redis processes", async () => {
    const prepared = await runProbe("redis", "captcha-prepare", { image: "synthetic-image-not-persisted-in-result" }, { redisUrl: redis.getConnectionUrl() });
    const waiting = runProbe("redis", "captcha-wait", { challengeId: prepared.challengeId }, { redisUrl: redis.getConnectionUrl() });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(runProbe("redis", "captcha-answer", { challengeId: prepared.challengeId, answer: "CROSS_PROCESS_OK" }, { redisUrl: redis.getConnectionUrl() })).resolves.toEqual({ accepted: true });
    await expect(waiting).resolves.toMatchObject({ answer: "CROSS_PROCESS_OK" });
  });

  it("keeps liveness independent while Redis outage is reported by readiness", async () => {
    await redis.stop();
    await expect(workers[0]!.request("/api/ready")).resolves.toMatchObject({ status: 200, body: { data: { state: "ready" } } });
    await expect(workers[0]!.request("/api/uet/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uetGoogleEmail: "ph.synthetic@example.com" }),
    })).resolves.toMatchObject({ status: 503, body: { error: { code: "HA_DEPENDENCY_UNAVAILABLE" } } });
    await expect(workers[0]!.request("/api/live")).resolves.toMatchObject({ status: 200, body: { data: { alive: true } } });
  });

  it("drains and exits both workers on SIGTERM", async () => {
    const results = await Promise.all(workers.map((worker) => worker.stop("SIGTERM")));
    expect(results.every(({ code, signal }) => code === 0 && signal === null)).toBe(true);
    workers = [];
  });
});
