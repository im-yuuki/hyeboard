import {
  AutomationEnvelopeCodec,
  AutomationWorker,
  CancellationToken,
  ConfigurationError,
  InMemoryAutomationEventSink,
  InMemoryJobLeaseStore,
  InMemoryStreamsBroker,
  createBrowserlessPuppeteerProvider,
  parseAutomationWorkerConfig,
  safeConfigSummary,
  type PuppeteerBrowser,
} from "./index";
import {
  createAccountId,
  createJobId,
  createUetImportJob,
  encryptEnvelope,
  parseAutomationEvent,
  type AutomationKeyring,
} from "@hyeboard/automation-protocol";
import { describe, expect, it } from "vitest";

const now = Date.parse("2036-01-02T03:04:05.000Z");
const keyring: AutomationKeyring = { current: { id: "current", material: new Uint8Array(32).fill(7) } };
const config = {
  redisUrl: "redis://localhost:6379/0",
  jobStream: "jobs",
  eventStream: "events",
  consumerGroup: "workers",
  consumerName: "test-worker",
  executionMode: "distributed" as const,
  browserProvider: "browserless" as const,
  browserlessEndpoint: "wss://browserless.example.test",
  browserlessToken: "never-log-this-token",
  jobEnvelopeAad: "job-aad",
  credentialEnvelopeAadPrefix: "credential:",
  resultEnvelopeAadPrefix: "result:",
  leaseTtlMs: 30_000,
  heartbeatIntervalMs: 10_000,
  reclaimIdleMs: 1_000,
  readBlockMs: 1,
  shutdownTimeoutMs: 1_000,
  maxDeliveryCount: 2,
  resultTtlMs: 30_000,
  keyring,
};

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    REDIS_URL: "redis://localhost:6379/0",
    BROWSERLESS_ENDPOINT: "wss://browserless.example.test",
    BROWSERLESS_TOKEN: "secret-token",
    AUTOMATION_KEY_CURRENT_ID: "current",
    AUTOMATION_KEY_CURRENT_B64: Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
    ...overrides,
  };
}

function job(): ReturnType<typeof createUetImportJob> {
  return createUetImportJob({
    jobId: createJobId(() => new Uint8Array(16).fill(1)),
    accountId: createAccountId(() => new Uint8Array(16).fill(2)),
    fence: 4,
    credentialEnvelope: "aep1.synthetic.encrypted",
    issuedAt: "2036-01-02T03:00:00.000Z",
    expiresAt: "2036-01-02T04:00:00.000Z",
  });
}

describe("automation worker configuration", () => {
  it("validates required configuration and rejects Patchright in distributed mode", () => {
    expect(() => parseAutomationWorkerConfig(env({ AUTOMATION_BROWSER_PROVIDER: "patchright" }))).toThrow(ConfigurationError);
    expect(() => parseAutomationWorkerConfig(env({ AUTOMATION_EXECUTION_MODE: "distributed", AUTOMATION_BROWSER_PROVIDER: "patchright" }))).toThrow(/Patchright/);
    expect(() => parseAutomationWorkerConfig(env({ BROWSERLESS_ENDPOINT: "wss://browserless.example.test?token=leak" }))).toThrow(/must not contain a token/);
    expect(() => parseAutomationWorkerConfig(env({ AUTOMATION_KEY_CURRENT_ID: "current", AUTOMATION_KEY_PREVIOUS_ID: "current", AUTOMATION_KEY_PREVIOUS_B64: env().AUTOMATION_KEY_CURRENT_B64 }))).toThrow(ConfigurationError);
    const localConfig = parseAutomationWorkerConfig(env({ AUTOMATION_EXECUTION_MODE: "local", AUTOMATION_BROWSER_PROVIDER: "patchright", BROWSERLESS_ENDPOINT: "", BROWSERLESS_TOKEN: "" }));
    expect(localConfig.browserProvider).toBe("patchright");
    expect(JSON.stringify(safeConfigSummary(parseAutomationWorkerConfig(env())))).not.toContain("secret-token");
  });

  it("cancels immediately when a job deadline has passed", () => {
    const token = new CancellationToken(now - 1, undefined, () => now);
    expect(token.reason).toBe("deadline");
    expect(() => token.throwIfCancelled()).toThrow(/deadline/);
  });
});

describe("Browserless provider", () => {
  it("keeps the token inside the connector and exposes ownership metadata only", async () => {
    const endpoints: string[] = [];
    const browser: PuppeteerBrowser = { newPage: async () => ({}), disconnect: async () => undefined };
    const provider = createBrowserlessPuppeteerProvider({
      endpoint: "wss://browserless.example.test/session",
      token: "private-browserless-token",
      connect: async ({ browserWSEndpoint }) => {
        endpoints.push(browserWSEndpoint);
        return browser;
      },
      id: () => "connection-1",
      now: () => now,
    });
    const connection = await provider.open();
    expect(endpoints[0]).toContain("private-browserless-token");
    expect(connection.metadata).toEqual(expect.objectContaining({ provider: "browserless", endpointOrigin: "wss://browserless.example.test", reconnectable: true }));
    expect(JSON.stringify(connection.metadata)).not.toContain("private-browserless-token");
    await connection.disconnect();
  });
});

describe("in-memory automation worker", () => {
  it("consumes a job, opens encrypted credentials, closes the result, and emits terminal events", async () => {
    const broker = new InMemoryStreamsBroker(() => now);
    const events = new InMemoryAutomationEventSink();
    const codec = new AutomationEnvelopeCodec(keyring, () => now);
    const value = job();
    const credentials = await encryptEnvelope({ bearer: "private-upstream-token" }, { keyring, aad: `credential:${value.jobId}`, issuedAt: "2036-01-02T03:00:00.000Z", expiresAt: "2036-01-02T04:00:00.000Z", randomBytes: () => new Uint8Array(12).fill(8) });
    const encryptedJob = await codec.close({ ...value, credentialEnvelope: credentials }, "job-aad", "2036-01-02T04:00:00.000Z");
    await broker.add("jobs", { jobEnvelope: encryptedJob });
    const browser: PuppeteerBrowser = { newPage: async () => ({}), disconnect: async () => undefined };
    const worker = new AutomationWorker({
      config,
      broker,
      leaseStore: new InMemoryJobLeaseStore(() => now),
      envelopeCodec: codec,
      browserProvider: createBrowserlessPuppeteerProvider({ endpoint: config.browserlessEndpoint, token: config.browserlessToken, connect: async () => browser, now: () => now }),
      executor: { execute: async ({ credential, progress }) => { expect(credential).toEqual({ bearer: "private-upstream-token" }); await progress("import", 75); return { imported: true }; } },
      events,
      now: () => now,
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(broker.pending("jobs", "workers")).toHaveLength(0);
    expect(events.events.map((event) => event.type)).toEqual(["started", "progress", "succeeded"]);
    expect(events.events[2]).toMatchObject({ type: "succeeded", resultEnvelope: expect.any(String) });
    for (const event of events.events) parseAutomationEvent(event, now);
  });

  it("reclaims an idle pending message for another consumer", async () => {
    let current = now;
    const broker = new InMemoryStreamsBroker(() => current);
    await broker.ensureGroup("jobs", "workers");
    const id = await broker.add("jobs", { jobEnvelope: "opaque" });
    await expect(broker.readGroup({ stream: "jobs", group: "workers", consumer: "first", count: 1, blockMs: 1 })).resolves.toHaveLength(1);
    current += 2_000;
    const reclaimed = await broker.reclaimPending({ stream: "jobs", group: "workers", consumer: "second", count: 1, minIdleMs: 1_000 });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ id, deliveryCount: 2, fields: { jobEnvelope: "opaque" } });
  });

  it("cancels an active executor without acknowledging a shutdown-interrupted job", async () => {
    const broker = new InMemoryStreamsBroker(() => now);
    const events = new InMemoryAutomationEventSink();
    const codec = new AutomationEnvelopeCodec(keyring, () => now);
    const value = job();
    const credentials = await encryptEnvelope({ bearer: "private-upstream-token" }, { keyring, aad: `credential:${value.jobId}`, issuedAt: "2036-01-02T03:00:00.000Z", expiresAt: "2036-01-02T04:00:00.000Z", randomBytes: () => new Uint8Array(12).fill(8) });
    await broker.add("jobs", { jobEnvelope: await codec.close({ ...value, credentialEnvelope: credentials }, "job-aad", "2036-01-02T04:00:00.000Z") });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const browser: PuppeteerBrowser = { newPage: async () => ({}), disconnect: async () => undefined };
    const worker = new AutomationWorker({
      config: { ...config, shutdownTimeoutMs: 20 },
      broker,
      leaseStore: new InMemoryJobLeaseStore(() => now),
      envelopeCodec: codec,
      browserProvider: createBrowserlessPuppeteerProvider({ endpoint: config.browserlessEndpoint, token: config.browserlessToken, connect: async () => browser, now: () => now }),
      executor: { execute: async ({ cancellation }) => { await Promise.race([blocked, cancellation.sleep(10_000)]); cancellation.throwIfCancelled(); return { imported: true }; } },
      events,
      now: () => now,
    });
    const processing = worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await worker.stop();
    release?.();
    await processing;
    expect(broker.pending("jobs", "workers")).toHaveLength(1);
  });
});
