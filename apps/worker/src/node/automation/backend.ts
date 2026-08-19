import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  assertAutomationEvent,
  createAccountId,
  createEventCursor,
  createJobId,
  createUetImportJob,
  decryptEnvelope,
  encryptEnvelope,
  parseAutomationEvent,
  parseUetImportJob,
  validateNextAutomationEvent,
  type AutomationEvent,
  type AutomationKeyring,
  type UetImportJob,
} from "../../../../../packages/automation-protocol/src/index";
import { HyeboardError } from "@hyeboard/core";
import type { DistributedAutomationBackend, DistributedAutomationEvent, DistributedAutomationImportRequest, DistributedImportedSession } from "../../app";
import { parseDistributedAutomationConfig, type DistributedAutomationConfig } from "./config";

type RedisStreamMessage = {
  id?: unknown;
  message?: unknown;
};

export type AutomationRedisClient = {
  set(key: string, value: string, options?: { PX?: number; NX?: boolean; XX?: boolean }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  xAdd(stream: string, id: string, fields: Record<string, string>): Promise<string>;
  xRead(streams: Array<{ key: string; id: string }>, options: { COUNT: number; BLOCK: number }): Promise<unknown>;
};

type JobRecord = {
  jobId: string;
  accountId: string;
  fence: number;
  ownershipToken: string;
};

type ChallengeState = {
  jobId: string;
  accountId: string;
  fence: number;
  challengeId: string;
  status: "pending" | "answered" | "cancelled";
};

type ControlPayload = {
  type: "captcha-answer" | "cancel";
  jobId: string;
  accountId: string;
  fence: number;
  challengeId?: string;
  answer?: string;
  reason?: "requested";
};

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CAPABILITY_PREFIX = "hyeboard-automation-v1";
const OWNERSHIP_DOMAIN = "hyeboard:automation-ownership:v1\0";
const CHALLENGE_DOMAIN = "hyeboard:automation-challenge:v1\0";
const COMPLETE_CHALLENGE_SCRIPT = `
local state = redis.call('GET', KEYS[1])
if state ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

function opaqueHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function redisKey(kind: string, value: string): string {
  return `hyeboard:v1:automation:{${opaqueHash(value)}}:${kind}`;
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function sameSignature(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function capability(secret: string, kind: "job" | "challenge", job: JobRecord, challengeId?: string): string {
  const body = [CAPABILITY_PREFIX, kind, job.jobId, job.accountId, String(job.fence), challengeId ?? ""].join(".");
  return `${body}.${hmac(secret, `${OWNERSHIP_DOMAIN}${body}`)}`;
}

function parseCapability(secret: string, token: string, kind: "job" | "challenge"): JobRecord & { challengeId?: string } {
  const parts = token.split(".");
  if (parts.length !== 7 || parts[0] !== CAPABILITY_PREFIX || parts[1] !== kind) throw automationNotFound();
  const [prefix, tokenKind, jobId, accountId, fenceValue, challengeId, signature] = parts;
  const body = [prefix, tokenKind, jobId, accountId, fenceValue, challengeId ?? ""].join(".");
  if (!JOB_ID_PATTERN.test(jobId) || !JOB_ID_PATTERN.test(accountId) || !/^\d+$/.test(fenceValue) || !/^[0-9a-f]{64}$/.test(signature)) throw automationNotFound();
  if (!sameSignature(hmac(secret, `${OWNERSHIP_DOMAIN}${body}`), signature)) throw automationNotFound();
  const fence = Number(fenceValue);
  if (!Number.isSafeInteger(fence) || fence < 1) throw automationNotFound();
  return { jobId, accountId, fence, ownershipToken: token, ...(kind === "challenge" ? { challengeId } : {}) };
}

function automationNotFound(): HyeboardError {
  return new HyeboardError("STUDENTHUB_CAPTCHA_CHALLENGE_NOT_FOUND", "This verification code request has expired or already been answered.", 404);
}

function automationUnavailable(): HyeboardError {
  return new HyeboardError("AUTOMATION_BACKEND_UNCONFIGURED", "Distributed browser automation is not configured; configure a worker executor before using Google sign-in.", 503);
}

function automationTimeout(): HyeboardError {
  return new HyeboardError("GOOGLE_AUTOMATION_TIMEOUT", "The automated sign-in took too long and was cancelled.", 504);
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateImportedSession(value: unknown): DistributedImportedSession {
  if (!asRecord(value) || value.universityId !== "uet" || typeof value.expiresAt !== "string" || !asRecord(value.session)) {
    throw new HyeboardError("GOOGLE_SIGNIN_FAILURE", "The automation worker returned an invalid sign-in result.", 502);
  }
  const session = value.session;
  const expiresAt = Date.parse(value.expiresAt);
  const google = session.uetGoogleCredential;
  const credential = session.studenthub;
  if (session.version !== 1 || session.universityId !== "uet" || session.expiresAt !== value.expiresAt || !Number.isFinite(expiresAt) || expiresAt <= Date.now()
    || new Date(expiresAt).toISOString() !== value.expiresAt
    || (value.studentCode !== undefined && value.studentCode !== session.studentCode)
    || !asRecord(google) || typeof google.email !== "string" || google.email.length === 0 || typeof google.password !== "string" || google.password.length === 0
    || (google.googleCookies !== undefined && !Array.isArray(google.googleCookies))) {
    throw new HyeboardError("GOOGLE_SIGNIN_FAILURE", "The automation worker returned an invalid sign-in result.", 502);
  }
  if (asRecord(google) && Array.isArray(google.googleCookies) && google.googleCookies.some((cookie) => !asRecord(cookie)
    || typeof cookie.name !== "string" || cookie.name.length === 0
    || typeof cookie.value !== "string" || cookie.value.length === 0
    || typeof cookie.domain !== "string" || cookie.domain.length === 0
    || typeof cookie.path !== "string" || cookie.path.length === 0)) {
    throw new HyeboardError("GOOGLE_SIGNIN_FAILURE", "The automation worker returned an invalid sign-in result.", 502);
  }
  for (const candidate of [credential, session.canvas]) {
    if (candidate !== undefined && (!asRecord(candidate) || !["bearer", "cookie", "manual"].includes(String(candidate.kind)) || typeof candidate.value !== "string" || candidate.value.length === 0)) {
      throw new HyeboardError("GOOGLE_SIGNIN_FAILURE", "The automation worker returned an invalid sign-in result.", 502);
    }
  }
  if (session.studentCode !== undefined && typeof session.studentCode !== "string") {
    throw new HyeboardError("GOOGLE_SIGNIN_FAILURE", "The automation worker returned an invalid sign-in result.", 502);
  }
  return {
    universityId: "uet",
    ...(session.studentCode === undefined ? {} : { studentCode: session.studentCode }),
    expiresAt: value.expiresAt,
    session: session as DistributedImportedSession["session"],
  };
}

function errorForWorkerCode(code: string): HyeboardError {
  const known = new Set([
    "GOOGLE_2FA_REQUIRED",
    "GOOGLE_AUTOMATION_BLOCKED",
    "GOOGLE_CHALLENGE_REQUIRED",
    "GOOGLE_AUTOMATION_TIMEOUT",
    "GOOGLE_KEYCLOAK_REDIRECT_MISSING",
    "GOOGLE_SIGNIN_FAILURE",
    "STUDENTHUB_MAINTENANCE",
  ]);
  if (known.has(code)) return new HyeboardError(code, "Google sign-in did not complete. Try again or use the manual token option.", code === "GOOGLE_AUTOMATION_TIMEOUT" ? 504 : 502);
  return new HyeboardError("GOOGLE_SIGNIN_FAILURE", "Google sign-in did not complete. Try again or use the manual token option.", 502);
}

function readFields(value: unknown): Record<string, string> {
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([key, item]) => [String(key), String(item)]));
  if (asRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
  throw new Error("Redis automation stream fields are malformed.");
}

function readMessages(value: unknown): Array<{ id: string; fields: Record<string, string> }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((stream) => {
    if (!asRecord(stream) || !Array.isArray(stream.messages)) return [];
    return stream.messages.map((message) => {
      if (!asRecord(message) || typeof message.id !== "string") throw new Error("Redis automation stream message is malformed.");
      return { id: message.id, fields: readFields(message.message) };
    });
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export class RedisDistributedAutomationBackend implements DistributedAutomationBackend {
  private readonly config: DistributedAutomationConfig;
  private readonly keyring: AutomationKeyring;

  constructor(
    private readonly client: AutomationRedisClient,
    private readonly sessionSecret: string,
    config: DistributedAutomationConfig,
  ) {
    this.config = config;
    this.keyring = config.keyring;
  }

  static fromEnvironment(client: AutomationRedisClient, sessionSecret: string, environment: Record<string, string | undefined>): RedisDistributedAutomationBackend {
    return new RedisDistributedAutomationBackend(client, sessionSecret, parseDistributedAutomationConfig(environment));
  }

  isAvailable(): boolean {
    return this.config.executorReady;
  }

  isAutomationChallengeToken(value: string): boolean {
    return value.startsWith(`${CAPABILITY_PREFIX}.challenge.`);
  }

  async importUetGoogle(
    input: DistributedAutomationImportRequest,
    options: { signal?: AbortSignal; cursor?: number; onJob?: (ownershipToken: string) => void; onEvent?: (event: DistributedAutomationEvent) => Promise<void> | void },
  ): Promise<DistributedImportedSession> {
    if (!this.config.executorReady) throw automationUnavailable();
    const created = await this.enqueue(input);
    options.onJob?.(created.ownershipToken);
    return this.consumeEvents(created.job, created.record, options);
  }

  async answerCaptcha(token: string, answer: string): Promise<void> {
    const owner = parseCapability(this.sessionSecret, token, "challenge");
    if (!answer || answer.length > 64) throw automationNotFound();
    const stateKey = redisKey("challenge", owner.challengeId!);
    const state = await this.readChallenge(stateKey);
    if (!state || !this.matches(state, owner) || state.challengeId !== owner.challengeId || state.status !== "pending") throw automationNotFound();
    const accepted = await this.completeChallenge(stateKey, { ...state, status: "answered" });
    if (!accepted) throw automationNotFound();
    const control: ControlPayload = { type: "captcha-answer", jobId: owner.jobId, accountId: owner.accountId, fence: owner.fence, challengeId: owner.challengeId, answer };
    await this.publishControl(control, owner.jobId);
  }

  async cancelCaptcha(token: string): Promise<void> {
    const owner = parseCapability(this.sessionSecret, token, "challenge");
    const stateKey = redisKey("challenge", owner.challengeId!);
    const state = await this.readChallenge(stateKey);
    if (!state || !this.matches(state, owner) || state.challengeId !== owner.challengeId || state.status !== "pending") throw automationNotFound();
    const accepted = await this.completeChallenge(stateKey, { ...state, status: "cancelled" });
    if (!accepted) throw automationNotFound();
    await this.client.set(redisKey("cancel", owner.jobId), "1", { PX: this.config.idempotencyTtlMs });
    await this.publishControl({ type: "cancel", jobId: owner.jobId, accountId: owner.accountId, fence: owner.fence, challengeId: owner.challengeId, reason: "requested" }, owner.jobId);
  }

  async cancelAutomation(token: string): Promise<void> {
    const owner = parseCapability(this.sessionSecret, token, "job");
    if (!(await this.client.get(redisKey("job", owner.jobId)))) throw automationNotFound();
    await this.client.set(redisKey("cancel", owner.jobId), "1", { PX: this.config.idempotencyTtlMs });
    const control: ControlPayload = { type: "cancel", jobId: owner.jobId, accountId: owner.accountId, fence: owner.fence, reason: "requested" };
    await this.publishControl(control, owner.jobId);
  }

  createChallengeToken(event: DistributedAutomationEvent, ownershipToken: string): string {
    if (event.type !== "challenge-required") throw new Error("Only challenge events can create CAPTCHA capabilities.");
    const owner = parseCapability(this.sessionSecret, ownershipToken, "job");
    if (event.jobId !== owner.jobId || event.accountId !== owner.accountId || event.fence !== owner.fence) throw automationNotFound();
    return capability(this.sessionSecret, "challenge", owner, event.challengeId);
  }

  private async enqueue(input: DistributedAutomationImportRequest): Promise<{ job: UetImportJob; record: JobRecord; ownershipToken: string; result?: DistributedImportedSession }> {
    const idempotency = redisKey("idempotency", hmac(this.sessionSecret, input.idempotencyKey));
    const existing = await this.client.get(idempotency);
    if (existing) {
      const record = this.parseJobRecord(existing);
      const jobEnvelope = await this.client.get(redisKey("job", record.jobId));
      if (!jobEnvelope) throw automationUnavailable();
      const job = parseUetImportJob(await decryptEnvelope<unknown>(jobEnvelope, { keyring: this.keyring, aad: this.config.jobEnvelopeAad }));
      return { job, record, ownershipToken: record.ownershipToken };
    }

    const jobId = createJobId(() => new Uint8Array(randomBytes(16)));
    const accountId = createAccountId(() => new Uint8Array(randomBytes(16)));
    const record: JobRecord = { jobId, accountId, fence: 1, ownershipToken: "" };
    record.ownershipToken = capability(this.sessionSecret, "job", record);
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.config.deadlineMs).toISOString();
    const credentialEnvelope = await encryptEnvelope({
      uetGoogleEmail: input.email,
      uetGooglePassword: input.password,
      ...(input.googleCookies === undefined ? {} : { uetGoogleCookies: input.googleCookies }),
    }, {
      keyring: this.keyring,
      aad: `${this.config.credentialEnvelopeAadPrefix}${jobId}`,
      issuedAt,
      expiresAt,
    });
    const job = createUetImportJob({ jobId, accountId, fence: 1, credentialEnvelope, issuedAt, expiresAt, expectedStudentCode: input.expectedStudentCode });
    const jobEnvelope = await encryptEnvelope(job, { keyring: this.keyring, aad: this.config.jobEnvelopeAad, issuedAt, expiresAt });
    const stored = await this.client.set(idempotency, JSON.stringify(record), { PX: this.config.idempotencyTtlMs, NX: true });
    if (stored !== "OK" && stored !== true) return this.enqueue(input);
    try {
      await this.client.set(redisKey("job", jobId), jobEnvelope, { PX: this.config.idempotencyTtlMs });
      await this.client.xAdd(this.config.jobStream, "*", { jobEnvelope });
    } catch (error) {
      await this.client.del(idempotency).catch(() => undefined);
      throw error;
    }
    return { job, record, ownershipToken: record.ownershipToken };
  }

  private async consumeEvents(
    job: UetImportJob,
    record: JobRecord,
    options: { signal?: AbortSignal; cursor?: number; onEvent?: (event: DistributedAutomationEvent) => Promise<void> | void },
  ): Promise<DistributedImportedSession> {
    let cursor = createEventCursor(job, options.cursor ?? -1);
    let streamId = "0-0";
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason ?? new DOMException("This operation was aborted", "AbortError"));
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(automationTimeout()), Math.max(1, Date.parse(job.expiresAt) - Date.now()));
    try {
      while (!controller.signal.aborted) {
        if (await this.client.get(redisKey("cancel", job.jobId))) {
          throw new HyeboardError("GOOGLE_AUTOMATION_TIMEOUT", "The automated sign-in was cancelled.", 504);
        }
        const messages = readMessages(await this.client.xRead([{ key: this.config.eventStream, id: streamId }], { COUNT: this.config.eventBatchSize, BLOCK: this.config.eventBlockMs }));
        if (messages.length === 0) continue;
        for (const message of messages) {
          streamId = message.id;
          if (message.fields.jobId !== job.jobId) continue;
          const envelope = message.fields.eventEnvelope;
          if (!envelope) continue;
          const event = parseAutomationEvent(await decryptEnvelope<unknown>(envelope, { keyring: this.keyring, aad: `${this.config.eventEnvelopeAadPrefix}${job.jobId}` }));
          assertAutomationEvent(event);
          if (event.sequence <= cursor.lastSequence) continue;
          cursor = validateNextAutomationEvent(event, cursor);
          const publicEvent = event as DistributedAutomationEvent;
          if (event.type === "challenge-required") await this.prepareChallenge(event, record);
          await options.onEvent?.(publicEvent);
          if (event.type === "failed") throw errorForWorkerCode(event.code);
          if (event.type === "cancelled") throw event.reason === "expired" ? automationTimeout() : new HyeboardError("GOOGLE_AUTOMATION_TIMEOUT", "The automated sign-in was cancelled.", 504);
          if (event.type === "succeeded") {
            if (!event.resultEnvelope) throw new HyeboardError("GOOGLE_SIGNIN_FAILURE", "The automation worker returned no sign-in result.", 502);
            const resultPayload = await decryptEnvelope<unknown>(event.resultEnvelope, { keyring: this.keyring, aad: `${this.config.resultEnvelopeAadPrefix}${job.jobId}` });
            return validateImportedSession(resultPayload);
          }
        }
      }
      throw controller.signal.reason ?? automationTimeout();
    } catch (error) {
      if (isAbort(error) && options.signal?.aborted) {
        await this.cancelAutomation(record.ownershipToken).catch(() => undefined);
        throw options.signal.reason ?? error;
      }
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof HyeboardError) throw reason;
        throw automationTimeout();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async prepareChallenge(event: Extract<AutomationEvent, { type: "challenge-required" }>, record: JobRecord): Promise<void> {
    const key = redisKey("challenge", event.challengeId);
    const state: ChallengeState = { jobId: record.jobId, accountId: record.accountId, fence: record.fence, challengeId: event.challengeId, status: "pending" };
    const stored = await this.client.set(key, JSON.stringify(state), { PX: Math.max(1, Date.parse(event.expiresAt) - Date.now()), NX: true });
    if (stored !== "OK" && stored !== true) return;
  }

  private async publishControl(control: ControlPayload, jobId: string): Promise<void> {
    const expiresAt = new Date(Date.now() + this.config.deadlineMs).toISOString();
    const envelope = await encryptEnvelope(control, { keyring: this.keyring, aad: `${this.config.credentialEnvelopeAadPrefix}${jobId}`, expiresAt });
    await this.client.xAdd(this.config.controlStream, "*", { jobId, controlEnvelope: envelope });
  }

  private async readChallenge(key: string): Promise<ChallengeState | undefined> {
    const value = await this.client.get(key);
    if (!value) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!asRecord(parsed) || typeof parsed.jobId !== "string" || typeof parsed.accountId !== "string" || typeof parsed.challengeId !== "string" || typeof parsed.fence !== "number" || !["pending", "answered", "cancelled"].includes(String(parsed.status))) return undefined;
      return parsed as unknown as ChallengeState;
    } catch {
      return undefined;
    }
  }

  private async completeChallenge(key: string, state: ChallengeState): Promise<boolean> {
    const result = await this.client.eval(COMPLETE_CHALLENGE_SCRIPT, { keys: [key], arguments: [JSON.stringify({ ...state, status: "pending" }), JSON.stringify(state), String(this.config.idempotencyTtlMs)] });
    return Number(result) === 1;
  }

  private matches(value: Pick<JobRecord, "jobId" | "accountId" | "fence">, owner: Pick<JobRecord, "jobId" | "accountId" | "fence">): boolean {
    return value.jobId === owner.jobId && value.accountId === owner.accountId && value.fence === owner.fence;
  }

  private parseJobRecord(value: string): JobRecord {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!asRecord(parsed) || typeof parsed.jobId !== "string" || typeof parsed.accountId !== "string" || typeof parsed.fence !== "number" || typeof parsed.ownershipToken !== "string") throw new Error();
      return parsed as unknown as JobRecord;
    } catch {
      throw automationUnavailable();
    }
  }
}

export function createDistributedAutomationBackend(
  client: AutomationRedisClient,
  sessionSecret: string,
  environment: Record<string, string | undefined>,
): RedisDistributedAutomationBackend {
  return RedisDistributedAutomationBackend.fromEnvironment(client, sessionSecret, environment);
}
