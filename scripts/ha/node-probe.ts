import {
  PostgresPool,
  PostgresSessionRevocationStore,
  PostgresVnuRefreshControlCoordinator,
  runPostgresMigrations,
} from "../../apps/worker/src/node/postgres/index.js";
import {
  closeRedis,
  connectRedis,
  createRedisClients,
  RedisCaptchaRelayCoordinator,
  RedisVnuRefreshControlCoordinator,
} from "../../apps/worker/src/node/redis/index.js";
import type { LinkedPair } from "../../apps/worker/src/vnu-refresh-control.js";

const input = JSON.parse(process.argv[3] ?? "{}") as Record<string, any>;
const backend = process.env.HA_PROBE_BACKEND;
const secret = "ha-verification-secret-with-at-least-32-bytes";

async function postgresProbe(): Promise<unknown> {
  const url = process.env.HA_POSTGRES_URL;
  if (!url) throw new Error("HA_POSTGRES_URL is required");
  const pool = new PostgresPool(url);
  try {
    const coordinator = new PostgresVnuRefreshControlCoordinator(pool);
    const store = new PostgresSessionRevocationStore(pool, secret);
    return await executeCoordinator(coordinator, store);
  } finally {
    await pool.close();
  }
}

async function redisProbe(): Promise<unknown> {
  const url = process.env.HA_REDIS_URL;
  if (!url) throw new Error("HA_REDIS_URL is required");
  const clients = createRedisClients({ url });
  await connectRedis(clients);
  try {
    const coordinator = new RedisVnuRefreshControlCoordinator({ client: clients.client as any });
    const captcha = new RedisCaptchaRelayCoordinator({ client: clients.client as any, blocking: clients.blocking as any });
    return await executeCoordinator(coordinator, undefined, captcha);
  } finally {
    await closeRedis(clients);
  }
}

async function executeCoordinator(
  coordinator: PostgresVnuRefreshControlCoordinator | RedisVnuRefreshControlCoordinator,
  revocations?: PostgresSessionRevocationStore,
  captcha?: RedisCaptchaRelayCoordinator,
): Promise<unknown> {
  const operation = process.argv[2];
  const principalKey = input.principalKey as string;
  const pair = input.pair as LinkedPair;
  switch (operation) {
    case "activate": return await coordinator.activatePair(principalKey, pair);
    case "begin": return await coordinator.beginRefresh(principalKey, pair);
    case "check": return await coordinator.checkAccess(principalKey, pair);
    case "revoke-session":
      if (!revocations) throw new Error("Session revocation is PostgreSQL-only");
      await revocations.revokeSession(input.sessionId, input.expiresAt);
      return { revoked: true };
    case "check-session":
      if (!revocations) throw new Error("Session revocation is PostgreSQL-only");
      return { revoked: await revocations.isSessionRevoked(input.sessionId) };
    case "captcha-prepare": {
      if (!captcha) throw new Error("CAPTCHA relay is Redis-only");
      const relay = await captcha.prepare(input.image);
      return { challengeId: relay.challengeId };
    }
    case "captcha-wait": {
      if (!captcha) throw new Error("CAPTCHA relay is Redis-only");
      // The production coordinator intentionally keeps wait private on the
      // prepared handle. This probe is the cross-process verification seam;
      // call that same method against a challenge created by another process.
      const wait = (captcha as unknown as { wait(challengeId: string): Promise<string> }).wait.bind(captcha);
      return { challengeId: input.challengeId, answer: await wait(input.challengeId) };
    }
    case "captcha-answer": {
      if (!captcha) throw new Error("CAPTCHA relay is Redis-only");
      await captcha.answer(input.challengeId, input.answer);
      return { accepted: true };
    }
    default: throw new Error(`Unknown HA probe operation: ${operation}`);
  }
}

async function main(): Promise<void> {
  if (backend === "postgres") {
    const pool = new PostgresPool(process.env.HA_POSTGRES_URL);
    try {
      await runPostgresMigrations(pool);
    } finally {
      await pool.close();
    }
    console.log(JSON.stringify(await postgresProbe()));
    return;
  }
  if (backend === "redis") {
    console.log(JSON.stringify(await redisProbe()));
    return;
  }
  throw new Error("HA_PROBE_BACKEND must be postgres or redis");
}

await main();
