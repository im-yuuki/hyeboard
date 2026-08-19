import { Buffer } from "node:buffer";
import { assertKeyring, type AutomationKeyring } from "../../../../../packages/automation-protocol/src/index";

export type DistributedAutomationConfig = {
  jobStream: string;
  eventStream: string;
  controlStream: string;
  jobEnvelopeAad: string;
  credentialEnvelopeAadPrefix: string;
  resultEnvelopeAadPrefix: string;
  eventEnvelopeAadPrefix: string;
  idempotencyTtlMs: number;
  deadlineMs: number;
  eventBlockMs: number;
  eventBatchSize: number;
  keyring: AutomationKeyring;
  executorReady: boolean;
};

type Environment = Record<string, string | undefined>;

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for distributed automation.`);
  return value;
}

function positive(environment: Environment, name: string, fallback: number): number {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function key(environment: Environment, name: string): Uint8Array {
  const value = required(environment, name);
  const bytes = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (bytes.byteLength !== 32) throw new Error(`${name} must decode to exactly 32 bytes.`);
  return new Uint8Array(bytes);
}

function keyring(environment: Environment): AutomationKeyring {
  const currentId = required(environment, "AUTOMATION_KEY_CURRENT_ID");
  const previousId = environment.AUTOMATION_KEY_PREVIOUS_ID?.trim();
  const previousValue = environment.AUTOMATION_KEY_PREVIOUS_B64?.trim();
  if (Boolean(previousId) !== Boolean(previousValue)) {
    throw new Error("AUTOMATION_KEY_PREVIOUS_ID and AUTOMATION_KEY_PREVIOUS_B64 must be provided together.");
  }
  return {
    current: { id: currentId, material: key(environment, "AUTOMATION_KEY_CURRENT_B64") },
    ...(previousId && previousValue ? { previous: { id: previousId, material: key(environment, "AUTOMATION_KEY_PREVIOUS_B64") } } : {}),
  };
}

export function parseDistributedAutomationConfig(environment: Environment): DistributedAutomationConfig {
  const result: DistributedAutomationConfig = {
    jobStream: environment.AUTOMATION_JOB_STREAM?.trim() || "hyeboard:automation:jobs",
    eventStream: environment.AUTOMATION_EVENT_STREAM?.trim() || "hyeboard:automation:events",
    controlStream: environment.AUTOMATION_CONTROL_STREAM?.trim() || "hyeboard:automation:control",
    jobEnvelopeAad: environment.AUTOMATION_JOB_ENVELOPE_AAD?.trim() || "hyeboard:automation:job:v1",
    credentialEnvelopeAadPrefix: environment.AUTOMATION_CREDENTIAL_AAD_PREFIX?.trim() || "hyeboard:automation:credential:",
    resultEnvelopeAadPrefix: environment.AUTOMATION_RESULT_AAD_PREFIX?.trim() || "hyeboard:automation:result:",
    eventEnvelopeAadPrefix: environment.AUTOMATION_EVENT_AAD_PREFIX?.trim() || "hyeboard:automation:event:",
    idempotencyTtlMs: positive(environment, "AUTOMATION_IDEMPOTENCY_TTL_MS", 5 * 60_000),
    deadlineMs: positive(environment, "AUTOMATION_DEADLINE_MS", 90_000),
    eventBlockMs: positive(environment, "AUTOMATION_EVENT_BLOCK_MS", 1_000),
    eventBatchSize: positive(environment, "AUTOMATION_EVENT_BATCH_SIZE", 100),
    keyring: keyring(environment),
    // This is intentionally opt-in. The API must never turn a missing worker
    // into an inline browser execution or leave a request looking successful.
    executorReady: environment.HYEB_AUTOMATION_EXECUTOR_READY === "true" || environment.AUTOMATION_EXECUTOR_READY === "true",
  };
  try {
    assertKeyring(result.keyring);
  } catch {
    throw new Error("The distributed automation keyring is invalid.");
  }
  return result;
}
