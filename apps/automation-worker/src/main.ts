import puppeteer from "puppeteer-core";
import { createClient, createClientPool } from "redis";
import {
  AutomationControlConsumer,
  CaptchaControlBridge,
  type AutomationControl,
} from "./control";
import { parseAutomationWorkerConfig, safeConfigSummary, type AutomationWorkerConfig } from "./config";
import { AutomationEnvelopeCodec } from "./envelope";
import { EncryptedStreamAutomationEventSink } from "./events";
import { errorCode } from "./errors";
import { RedisJobLeaseStore } from "./lease";
import { RedisStreamsBroker, type NodeRedisStreamsClient } from "./broker";
import { createBrowserlessPuppeteerProvider, type BrowserProvider, type PuppeteerConnector } from "./provider";
import { createUetAutomationExecutor } from "./uet-executor";
import type { UetAutomationCredential } from "./uet-executor";
import type { ImportedSession } from "@hyeboard/university-adapters";
import { AutomationWorker, type AutomationWorkerLogger } from "./worker";

export type AutomationRedisHostClient = NodeRedisStreamsClient & {
  set(key: string, value: string, options: { PX: number; NX: boolean }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  connect(): Promise<void>;
  ping(): Promise<string>;
  isOpen?: boolean;
  quit?(): Promise<unknown>;
  close?(): Promise<unknown>;
  destroy?(): void;
};

export type AutomationHostLogger = AutomationWorkerLogger & {
  info?(message: string, fields?: Record<string, unknown>): void;
};

export type AutomationHostOptions = {
  env?: Record<string, string | undefined>;
  redis?: { normal: AutomationRedisHostClient; blocking: AutomationRedisHostClient; close?: () => Promise<void> };
  connectBrowser?: PuppeteerConnector;
  browserProvider?: BrowserProvider;
  logger?: AutomationHostLogger;
  now?: () => number;
};

export type AutomationHost = {
  readonly config: AutomationWorkerConfig;
  readonly worker: AutomationWorker<UetAutomationCredential, ImportedSession>;
  readonly controls: AutomationControlConsumer;
  start(): Promise<void>;
  stop(): Promise<void>;
};

async function closeRedisClient(client: AutomationRedisHostClient): Promise<void> {
  if (client.isOpen === false) return;
  try {
    if (client.quit) await client.quit();
    else if (client.close) await client.close();
    else client.destroy?.();
  } catch {
    client.destroy?.();
  }
}

function defaultConnector(): PuppeteerConnector {
  return async ({ browserWSEndpoint }) => puppeteer.connect({ browserWSEndpoint }) as never;
}

function createRedisHostClients(redisUrl: string): { normal: AutomationRedisHostClient; blocking: AutomationRedisHostClient; close: () => Promise<void> } {
  const normal = createClient({ url: redisUrl }) as unknown as AutomationRedisHostClient;
  const blocking = createClientPool({ url: redisUrl }) as unknown as AutomationRedisHostClient;
  return {
    normal,
    blocking,
    close: async () => {
      await Promise.all([closeRedisClient(normal), closeRedisClient(blocking)]);
    },
  };
}

export function createAutomationHost(options: AutomationHostOptions = {}): AutomationHost {
  const config = parseAutomationWorkerConfig(options.env ?? process.env);
  if (config.browserProvider !== "browserless") {
    throw new Error("The executable automation host supports Browserless only; configure BROWSERLESS_ENDPOINT and BROWSERLESS_TOKEN.");
  }

  const redis = options.redis ?? createRedisHostClients(config.redisUrl);
  const broker = new RedisStreamsBroker(redis.normal, redis.blocking);
  const codec = new AutomationEnvelopeCodec(config.keyring, options.now);
  const provider = options.browserProvider ?? createBrowserlessPuppeteerProvider({
    endpoint: config.browserlessEndpoint!,
    token: config.browserlessToken!,
    connect: options.connectBrowser ?? defaultConnector(),
    now: options.now,
  });
  const captcha = new CaptchaControlBridge();
  const worker = new AutomationWorker<UetAutomationCredential, ImportedSession>({
    config,
    broker,
    leaseStore: new RedisJobLeaseStore(redis.normal),
    envelopeCodec: codec,
    browserProvider: provider,
    executor: createUetAutomationExecutor(),
    events: new EncryptedStreamAutomationEventSink(broker, config.eventStream, codec, config.eventEnvelopeAadPrefix),
    logger: options.logger,
    now: options.now,
    onCaptchaNeeded: (request) => captcha.waitForAnswer(request),
  });
  const controls = new AutomationControlConsumer({
    config,
    broker,
    envelopeCodec: codec,
    logger: options.logger,
    now: options.now,
    onControl: async (control) => applyControl(control, worker, captcha),
  });

  let started = false;
  let stopping: Promise<void> | undefined;

  return {
    config,
    worker,
    controls,
    async start() {
      if (started) return;
      const clientsConnected = new Set<AutomationRedisHostClient>();
      try {
        await redis.normal.connect();
        clientsConnected.add(redis.normal);
        await redis.blocking.connect();
        clientsConnected.add(redis.blocking);
        await Promise.all([redis.normal.ping(), redis.blocking.ping()]);
        const probe = await provider.open();
        await probe.disconnect();
        await worker.start();
        await controls.start();
        started = true;
        options.logger?.info?.("Automation worker ready.", safeConfigSummary(config));
      } catch (error) {
        await controls.stop(config.shutdownTimeoutMs).catch(() => undefined);
        await worker.stop("shutdown").catch(() => undefined);
        if (redis.close) await redis.close().catch(() => undefined);
        else await Promise.all([...clientsConnected].map((client) => closeRedisClient(client)));
        throw error;
      }
    },
    async stop() {
      stopping ??= (async () => {
        await controls.stop(config.shutdownTimeoutMs);
        await worker.stop("shutdown");
        if (redis.close) await redis.close();
        else await Promise.all([closeRedisClient(redis.normal), closeRedisClient(redis.blocking)]);
        started = false;
      })();
      await stopping;
    },
  };
}

function applyControl(control: AutomationControl, worker: AutomationWorker<UetAutomationCredential, ImportedSession>, captcha: CaptchaControlBridge): boolean {
  if (control.type === "captcha-answer") return captcha.applyAnswer(control);
  if (control.challengeId && !captcha.matchesChallenge(control)) return false;
  return worker.requestFencedCancel(control);
}

export async function runAutomationWorker(env: Record<string, string | undefined> = process.env): Promise<void> {
  const logger: AutomationHostLogger = {
    info: (message, fields) => console.info(message, fields ?? {}),
    warn: (message, fields) => console.warn(message, fields ?? {}),
    error: (message, fields) => console.error(message, fields ?? {}),
  };
  const host = createAutomationHost({ env, logger });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= host.stop().catch((error) => logger.error?.("Automation worker shutdown failed.", { code: errorCode(error) }));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await host.start();
    await new Promise<void>((resolve) => {
      const waitForStop = () => {
        if (stopping) void stopping.finally(resolve);
        else setTimeout(waitForStop, 25);
      };
      waitForStop();
    });
  } catch (error) {
    logger.error?.("Automation worker failed to start.", { code: errorCode(error) });
    throw error;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await host.stop().catch(() => undefined);
  }
}
