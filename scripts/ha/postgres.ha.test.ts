import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { encryptSession } from "../../packages/core/src/index.js";
import { PostgresPool, runPostgresMigrations } from "../../apps/worker/src/node/postgres/index.js";
import { dockerImagesAreAvailable, dockerIsAvailable, runProbe, sessionSecret, WorkerProcess } from "./test-support.js";

const dockerAvailable = await dockerIsAvailable();
const imagesAvailable = dockerAvailable && await dockerImagesAreAvailable(["postgres:16-alpine", "redis:7-alpine"]);
const infrastructureAvailable = dockerAvailable && imagesAvailable;
if (!infrastructureAvailable) {
  const reason = dockerAvailable
    ? "required Docker images are not present (pull postgres:16-alpine and redis:7-alpine first)"
    : "Docker is unavailable";
  if (process.env.HYEB_REQUIRE_HA_INFRASTRUCTURE === "true") {
    throw new Error(`[ha:postgres] ${reason}`);
  }
  console.warn(`[ha:postgres] SKIPPED: ${reason}; no fake integration result will be reported.`);
}

describe.skipIf(!infrastructureAvailable)("HA PostgreSQL integration", () => {
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
    const pool = new PostgresPool(postgres.getConnectionUri());
    try {
      await runPostgresMigrations(pool);
    } finally {
      await pool.close();
    }
    const startedWorkers = await Promise.allSettled([
      WorkerProcess.start({ port: 0, nodeId: "ha-postgres-a", postgresUrl: postgres.getConnectionUri(), redisUrl: redis.getConnectionUrl() }),
      WorkerProcess.start({ port: 0, nodeId: "ha-postgres-b", postgresUrl: postgres.getConnectionUri(), redisUrl: redis.getConnectionUrl() }),
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

  it("keeps both worker processes live and ready with shared dependencies", async () => {
    for (const worker of workers) {
      await expect(worker.request("/api/live")).resolves.toMatchObject({ status: 200, body: { data: { alive: true, state: "ready" } } });
      await expect(worker.request("/api/ready")).resolves.toMatchObject({ status: 200, body: { data: { state: "ready", dependencies: { postgres: "ready", redis: "ready" } } } });
    }
  });

  it("shares PostgreSQL session revocation across worker processes", async () => {
    const token = await encryptSession({
      version: 1,
      universityId: "mock",
      studentCode: "HA-POSTGRES-REVOCATION",
      sessionId: "ha-session-postgres-shared",
      sessionEpoch: 1,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }, sessionSecret);
    await expect(workers[1]!.request("/api/mock/auth/session", { headers: { Authorization: `Bearer ${token}` } })).resolves.toMatchObject({ status: 200 });
    await expect(workers[0]!.request("/api/mock/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } })).resolves.toMatchObject({ status: 200 });
    await expect(workers[1]!.request("/api/mock/auth/session", { headers: { Authorization: `Bearer ${token}` } })).resolves.toMatchObject({ status: 401, body: { error: { code: "SESSION_EXPIRED" } } });
  });

  it("serializes refresh leases across independent PostgreSQL processes", async () => {
    const principalKey = "a".repeat(64);
    const pair = { accessTokenId: "A".repeat(22), accessExpiresAt: Date.now() + 600_000, grantId: "B".repeat(22), grantExpiresAt: Date.now() + 900_000 };
    await runProbe("postgres", "activate", { principalKey, pair }, { postgresUrl: postgres.getConnectionUri() });
    const results = await Promise.all([
      runProbe("postgres", "begin", { principalKey, pair }, { postgresUrl: postgres.getConnectionUri() }),
      runProbe("postgres", "begin", { principalKey, pair }, { postgresUrl: postgres.getConnectionUri() }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["accepted", "in-progress"]);
  });

  it("returns a dependency error after PostgreSQL becomes unavailable", async () => {
    const token = await encryptSession({
      version: 1,
      universityId: "mock",
      sessionId: "ha-session-postgres-outage",
      sessionEpoch: 1,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }, sessionSecret);
    await postgres.stop();
    await expect(workers[0]!.request("/api/mock/auth/session", { headers: { Authorization: `Bearer ${token}` } })).resolves.toMatchObject({ status: 503, body: { error: { code: "HA_DEPENDENCY_UNAVAILABLE" } } });
  });

  it("drains and exits both workers on SIGTERM", async () => {
    const results = await Promise.all(workers.map((worker) => worker.stop("SIGTERM")));
    expect(results.every(({ code, signal }) => code === 0 && signal === null)).toBe(true);
    workers = [];
  });
});
