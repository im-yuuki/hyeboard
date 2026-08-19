import { describe, expect, it } from "vitest";
import {
  assertAutomationEvent,
  createAccountId,
  createChallengeId,
  createEventCursor,
  createJobId,
  createUetImportJob,
  decryptEnvelope,
  encryptEnvelope,
  openEnvelope,
  parseAutomationEvent,
  parseUetImportJob,
  redactError,
  redactSecrets,
  validateNextAutomationEvent,
  type AutomationEvent,
  type AutomationKeyring,
  type UetImportJob,
} from "./index";

const NOW = Date.parse("2036-01-02T03:04:05.000Z");
const EXPIRES = "2036-01-02T04:04:05.000Z";
const keyring: AutomationKeyring = {
  current: { id: "key-2", material: new Uint8Array(32).fill(2) },
  previous: { id: "key-1", material: new Uint8Array(32).fill(1) },
};
const deterministic = (value: number) => (_length: number) => new Uint8Array(12).fill(value);

function expectProtocolCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`Expected protocol error ${code}.`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function job(): UetImportJob {
  return createUetImportJob({
    jobId: createJobId(() => new Uint8Array(16).fill(0x11)),
    accountId: createAccountId(() => new Uint8Array(16).fill(0x22)),
    fence: 7,
    credentialEnvelope: "aep1.synthetic.encrypted-credentials",
    issuedAt: "2036-01-02T03:00:00.000Z",
    expiresAt: EXPIRES,
  });
}

function event(overrides: Partial<AutomationEvent> = {}): AutomationEvent {
  const base: AutomationEvent = {
    version: 1,
    type: "started",
    jobId: job().jobId,
    accountId: job().accountId,
    fence: 7,
    sequence: 0,
    emittedAt: "2036-01-02T03:04:06.000Z",
    expiresAt: EXPIRES,
  };
  return { ...base, ...overrides } as AutomationEvent;
}

describe("encrypted automation envelopes", () => {
  it("round trips with caller-supplied AAD and does not expose plaintext", async () => {
    const token = await encryptEnvelope({ password: "PRIVATE-PASSWORD" }, {
      keyring,
      aad: "job:opaque-job-context",
      issuedAt: "2036-01-02T03:00:00.000Z",
      expiresAt: EXPIRES,
      randomBytes: deterministic(9),
    });

    expect(token).not.toContain("PRIVATE-PASSWORD");
    await expect(decryptEnvelope(token, { keyring, aad: "job:opaque-job-context", now: NOW })).resolves.toEqual({ password: "PRIVATE-PASSWORD" });
    await expect(decryptEnvelope(token, { keyring, aad: "different-context", now: NOW })).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
  });

  it("decrypts with the previous key and reports rotation", async () => {
    const oldKeyring: AutomationKeyring = { current: keyring.previous! };
    const token = await encryptEnvelope({ value: "payload" }, {
      keyring: oldKeyring,
      aad: "rotation-test",
      issuedAt: "2036-01-02T03:00:00.000Z",
      expiresAt: EXPIRES,
      randomBytes: deterministic(8),
    });
    await expect(openEnvelope(token, { keyring, aad: "rotation-test", now: NOW })).resolves.toMatchObject({ keyId: "key-1", rotated: true, payload: { value: "payload" } });
  });

  it("rejects expired envelopes and invalid raw key lengths", async () => {
    await expect(encryptEnvelope({}, {
      keyring: { current: { id: "bad", material: new Uint8Array(31) } },
      aad: "test",
      expiresAt: EXPIRES,
    })).rejects.toMatchObject({ code: "INVALID_KEY" });

    const token = await encryptEnvelope({}, {
      keyring,
      aad: "expiry",
      issuedAt: "2036-01-02T02:00:00.000Z",
      expiresAt: "2036-01-02T03:00:00.000Z",
      randomBytes: deterministic(7),
    });
    await expect(decryptEnvelope(token, { keyring, aad: "expiry", now: NOW })).rejects.toMatchObject({ code: "ENVELOPE_EXPIRED" });
  });
});

describe("UET jobs and automation events", () => {
  it("strictly validates jobs and checks expiry", () => {
    const value = job();
    expect(parseUetImportJob(value, NOW)).toEqual(value);
    expectProtocolCode(() => parseUetImportJob({ ...value, unexpected: true }, NOW), "INVALID_JOB");
    expectProtocolCode(() => parseUetImportJob(value, Date.parse(EXPIRES)), "JOB_EXPIRED");
  });

  it("requires encrypted credential references instead of plaintext credentials", () => {
    const value = job();
    const malformed = { ...value, password: "PRIVATE-PASSWORD" };
    expectProtocolCode(() => parseUetImportJob(malformed, NOW), "INVALID_JOB");
    expect(JSON.stringify(value)).not.toContain("PRIVATE-PASSWORD");
  });

  it("enforces contiguous sequence, matching fence, and terminal fencing", () => {
    const cursor = createEventCursor(job());
    const afterStart = validateNextAutomationEvent(event(), cursor, NOW);
    expect(afterStart.lastSequence).toBe(0);

    const afterProgress = validateNextAutomationEvent(event({ type: "progress", sequence: 1, phase: "login", percent: 50 }), afterStart, NOW);
    expect(afterProgress.lastSequence).toBe(1);
    const afterSuccess = validateNextAutomationEvent(event({ type: "succeeded", sequence: 2, resultEnvelope: "aep1.result.encrypted" }), afterProgress, NOW);
    expect(afterSuccess.terminal).toBe(true);

    expectProtocolCode(() => validateNextAutomationEvent(event({ sequence: 4 }), afterProgress, NOW), "EVENT_SEQUENCE_MISMATCH");
    expectProtocolCode(() => validateNextAutomationEvent(event({ sequence: 2, fence: 8 }), afterProgress, NOW), "EVENT_FENCE_MISMATCH");
    expectProtocolCode(() => validateNextAutomationEvent(event({ sequence: 3 }), afterSuccess, NOW), "EVENT_AFTER_TERMINAL");
  });

  it("rejects expired events and malformed challenge IDs", () => {
    const expired = event({ emittedAt: "2036-01-02T02:00:00.000Z", expiresAt: "2036-01-02T03:00:00.000Z" });
    expectProtocolCode(() => parseAutomationEvent(expired, NOW), "EVENT_EXPIRED");
    expectProtocolCode(() => assertAutomationEvent(event({ type: "challenge-required", challengeId: "not-opaque" as AutomationEvent["challengeId"], image: "data:image/png;base64,AA==" })), "INVALID_EVENT");
    expect(createChallengeId(() => new Uint8Array(16).fill(0x33))).toHaveLength(22);
  });
});

describe("redaction", () => {
  it("redacts credential fields without changing opaque IDs", () => {
    const value = {
      jobId: "opaque-job-id",
      password: "PRIVATE-PASSWORD",
      studenthub: { kind: "bearer", value: "PRIVATE-TOKEN" },
      nested: { cookie: "PRIVATE-COOKIE", answer: "PRIVATE-ANSWER" },
    };
    expect(redactSecrets(value)).toEqual({
      jobId: "opaque-job-id",
      password: "[REDACTED]",
      studenthub: { kind: "bearer", value: "[REDACTED]" },
      nested: { cookie: "[REDACTED]", answer: "[REDACTED]" },
    });
    expect(JSON.stringify(redactSecrets(value))).not.toContain("PRIVATE-");
    expect(redactError(new Error("password=PRIVATE-PASSWORD token=PRIVATE-TOKEN"))).toEqual({ name: "Error", message: "Unexpected automation protocol error." });
  });
});
