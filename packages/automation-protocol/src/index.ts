import { z } from "zod";

export const AUTOMATION_PROTOCOL_VERSION = 1 as const;
export const AUTOMATION_ENVELOPE_ALGORITHM = "AES-256-GCM" as const;
export const OPAQUE_ID_BYTES = 16;

const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_AAD_BYTES = 4_096;
const MAX_ENVELOPE_BYTES = 1_048_576;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type IdKind = "job" | "account" | "challenge";

export type OpaqueId<K extends IdKind = IdKind> = string & {
  readonly __hyeboardOpaqueId: K;
};

export type JobId = OpaqueId<"job">;
export type AccountId = OpaqueId<"account">;
export type ChallengeId = OpaqueId<"challenge">;

export class AutomationProtocolError extends Error {
  constructor(
    public readonly code:
    | "INVALID_INPUT"
    | "INVALID_KEY"
    | "INVALID_KEYRING"
    | "UNKNOWN_KEY_ID"
    | "INVALID_ENVELOPE"
    | "ENVELOPE_EXPIRED"
    | "INVALID_JOB"
    | "JOB_EXPIRED"
    | "INVALID_EVENT"
    | "EVENT_EXPIRED"
    | "EVENT_JOB_MISMATCH"
    | "EVENT_ACCOUNT_MISMATCH"
    | "EVENT_FENCE_MISMATCH"
    | "EVENT_SEQUENCE_MISMATCH"
    | "EVENT_AFTER_TERMINAL"
    | "INVALID_ID"
    | "INVALID_AAD"
    | "SERIALIZATION_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "AutomationProtocolError";
  }
}

function protocolError(code: ConstructorParameters<typeof AutomationProtocolError>[0], message: string): AutomationProtocolError {
  return new AutomationProtocolError(code, message);
}

function bytesFromRandomSource(source: Uint8Array, length: number): Uint8Array {
  if (!(source instanceof Uint8Array) || source.byteLength !== length) {
    throw protocolError("INVALID_INPUT", `Random source must provide exactly ${length} bytes.`);
  }
  return new Uint8Array(source);
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!value || !BASE64_URL_PATTERN.test(value) || value.includes("=")) {
    throw protocolError("INVALID_ENVELOPE", "Invalid base64url data.");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw protocolError("INVALID_ENVELOPE", "Invalid base64url data.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (toBase64Url(bytes) !== value) throw protocolError("INVALID_ENVELOPE", "Invalid base64url data.");
  return bytes;
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function assertCanonicalIsoDate(value: string, field: string): void {
  if (!isCanonicalIsoDate(value)) throw protocolError("INVALID_INPUT", `${field} must be a canonical ISO-8601 timestamp.`);
}

function assertTimeWindow(issuedAt: string, expiresAt: string): void {
  assertCanonicalIsoDate(issuedAt, "issuedAt");
  assertCanonicalIsoDate(expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw protocolError("INVALID_INPUT", "expiresAt must be later than issuedAt.");
  }
}

export function isExpired(expiresAt: string, now = Date.now()): boolean {
  return Date.parse(expiresAt) <= now;
}

export function assertNotExpired(expiresAt: string, now = Date.now(), code: "ENVELOPE_EXPIRED" | "JOB_EXPIRED" | "EVENT_EXPIRED" = "ENVELOPE_EXPIRED"): void {
  assertCanonicalIsoDate(expiresAt, "expiresAt");
  if (isExpired(expiresAt, now)) throw protocolError(code, "The automation protocol value has expired.");
}

function assertOpaqueIdValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw protocolError("INVALID_ID", "Invalid opaque identifier.");
  }
  const bytes = fromBase64Url(value);
  if (bytes.byteLength !== OPAQUE_ID_BYTES) throw protocolError("INVALID_ID", "Invalid opaque identifier.");
}

export const opaqueIdSchema = z.string().regex(OPAQUE_ID_PATTERN).refine((value) => {
  try {
    return fromBase64Url(value).byteLength === OPAQUE_ID_BYTES;
  } catch {
    return false;
  }
});

export function isOpaqueId(value: unknown): value is OpaqueId {
  try {
    assertOpaqueIdValue(value);
    return true;
  } catch {
    return false;
  }
}

export function assertOpaqueId<K extends IdKind = IdKind>(value: unknown): asserts value is OpaqueId<K> {
  assertOpaqueIdValue(value);
}

export function createOpaqueId<K extends IdKind>(source: () => Uint8Array = () => randomBytes(OPAQUE_ID_BYTES)): OpaqueId<K> {
  const bytes = bytesFromRandomSource(source(), OPAQUE_ID_BYTES);
  return toBase64Url(bytes) as OpaqueId<K>;
}

export function createJobId(source?: () => Uint8Array): JobId {
  return createOpaqueId<"job">(source);
}

export function createAccountId(source?: () => Uint8Array): AccountId {
  return createOpaqueId<"account">(source);
}

export function createChallengeId(source?: () => Uint8Array): ChallengeId {
  return createOpaqueId<"challenge">(source);
}

export type AutomationKeyMaterial = Uint8Array | CryptoKey;

export type AutomationKey = {
  id: string;
  material: AutomationKeyMaterial;
};

export type AutomationKeyring = {
  current: AutomationKey;
  previous?: AutomationKey;
};

function assertKeyId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) {
    throw protocolError("INVALID_KEYRING", "Invalid automation key ID.");
  }
}

function isCryptoKey(value: AutomationKeyMaterial): value is CryptoKey {
  return typeof value === "object" && value !== null && "algorithm" in value && "usages" in value;
}

function assertRawKey(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw protocolError("INVALID_KEY", "Automation AES-GCM keys must contain exactly 32 bytes.");
  }
}

function assertCryptoKey(value: CryptoKey): void {
  const algorithm = value.algorithm as AesKeyAlgorithm;
  if (algorithm.name !== "AES-GCM" || ("length" in algorithm && algorithm.length !== 256)) {
    throw protocolError("INVALID_KEY", "Automation keys must be AES-256-GCM keys.");
  }
}

function assertKeyMaterial(value: AutomationKeyMaterial): void {
  if (isCryptoKey(value)) assertCryptoKey(value);
  else assertRawKey(value);
}

export function assertKeyring(keyring: AutomationKeyring): void {
  if (!keyring || typeof keyring !== "object" || !keyring.current) {
    throw protocolError("INVALID_KEYRING", "A current automation key is required.");
  }
  assertKeyId(keyring.current.id);
  assertKeyMaterial(keyring.current.material);
  if (keyring.previous !== undefined) {
    assertKeyId(keyring.previous.id);
    assertKeyMaterial(keyring.previous.material);
    if (keyring.previous.id === keyring.current.id) {
      throw protocolError("INVALID_KEYRING", "Current and previous automation key IDs must differ.");
    }
  }
}

async function importAesKey(material: AutomationKeyMaterial, usages: KeyUsage[]): Promise<CryptoKey> {
  assertKeyMaterial(material);
  if (isCryptoKey(material)) {
    if (!usages.every((usage) => material.usages.includes(usage))) {
      throw protocolError("INVALID_KEY", "Automation key does not permit the requested operation.");
    }
    return material;
  }
  return crypto.subtle.importKey("raw", toArrayBuffer(material), { name: "AES-GCM", length: 256 }, false, usages);
}

export type EncryptedAutomationEnvelope = {
  version: 1;
  algorithm: typeof AUTOMATION_ENVELOPE_ALGORITHM;
  keyId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  ciphertext: string;
};

const envelopeHeaderSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal(AUTOMATION_ENVELOPE_ALGORITHM),
  keyId: z.string().regex(KEY_ID_PATTERN),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  issuedAt: z.string().regex(ISO_DATE_PATTERN),
  expiresAt: z.string().regex(ISO_DATE_PATTERN),
}).strict();

export const encryptedAutomationEnvelopeSchema = envelopeHeaderSchema.extend({
  ciphertext: z.string().regex(BASE64_URL_PATTERN),
}).strict();

export type EnvelopeAad = string | Uint8Array;

function aadBytes(aad: EnvelopeAad): Uint8Array {
  const bytes = typeof aad === "string" ? textEncoder.encode(aad) : new Uint8Array(aad);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AAD_BYTES) throw protocolError("INVALID_AAD", "AAD must be non-empty and at most 4096 bytes.");
  return bytes;
}

function headerBytes(header: Omit<EncryptedAutomationEnvelope, "ciphertext">): Uint8Array {
  return textEncoder.encode(JSON.stringify(header));
}

function authenticatedData(header: Omit<EncryptedAutomationEnvelope, "ciphertext">, aad: EnvelopeAad): Uint8Array {
  const context = aadBytes(aad);
  const prefix = textEncoder.encode("hyeboard:automation-envelope:v1\n");
  const headerData = headerBytes(header);
  const result = new Uint8Array(prefix.byteLength + headerData.byteLength + 1 + context.byteLength);
  result.set(prefix, 0);
  result.set(headerData, prefix.byteLength);
  result[prefix.byteLength + headerData.byteLength] = 0;
  result.set(context, prefix.byteLength + headerData.byteLength + 1);
  return result;
}

function serializeJson(value: unknown): Uint8Array {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw protocolError("SERIALIZATION_ERROR", "Envelope payload must be JSON serializable.");
  }
  if (serialized === undefined) throw protocolError("SERIALIZATION_ERROR", "Envelope payload must be JSON serializable.");
  const bytes = textEncoder.encode(serialized);
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw protocolError("SERIALIZATION_ERROR", "Envelope payload is too large.");
  return bytes;
}

function parseHeader(value: unknown): Omit<EncryptedAutomationEnvelope, "ciphertext"> {
  const parsed = envelopeHeaderSchema.safeParse(value);
  if (!parsed.success || !isCanonicalIsoDate(parsed.data.issuedAt) || !isCanonicalIsoDate(parsed.data.expiresAt) || Date.parse(parsed.data.expiresAt) <= Date.parse(parsed.data.issuedAt)) {
    throw protocolError("INVALID_ENVELOPE", "Invalid encrypted automation envelope.");
  }
  const nonce = fromBase64Url(parsed.data.nonce);
  if (nonce.byteLength !== 12) throw protocolError("INVALID_ENVELOPE", "Invalid encrypted automation envelope.");
  return parsed.data;
}

function encodeEnvelope(header: Omit<EncryptedAutomationEnvelope, "ciphertext">, ciphertext: Uint8Array): string {
  const headerEncoded = toBase64Url(textEncoder.encode(JSON.stringify(header)));
  return `aep1.${headerEncoded}.${toBase64Url(ciphertext)}`;
}

function decodeEnvelope(token: string): { header: Omit<EncryptedAutomationEnvelope, "ciphertext">; ciphertext: Uint8Array } {
  if (typeof token !== "string" || token.length > MAX_ENVELOPE_BYTES * 2) throw protocolError("INVALID_ENVELOPE", "Invalid encrypted automation envelope.");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "aep1") throw protocolError("INVALID_ENVELOPE", "Invalid encrypted automation envelope.");
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(textDecoder.decode(fromBase64Url(parts[1])));
  } catch {
    throw protocolError("INVALID_ENVELOPE", "Invalid encrypted automation envelope.");
  }
  const header = parseHeader(headerValue);
  const ciphertext = fromBase64Url(parts[2]);
  if (ciphertext.byteLength < 17) throw protocolError("INVALID_ENVELOPE", "Invalid encrypted automation envelope.");
  return { header, ciphertext };
}

function findKey(keyring: AutomationKeyring, keyId: string): { key: AutomationKey; rotated: boolean } {
  if (keyring.current.id === keyId) return { key: keyring.current, rotated: false };
  if (keyring.previous?.id === keyId) return { key: keyring.previous, rotated: true };
  throw protocolError("UNKNOWN_KEY_ID", "The automation envelope key ID is not available.");
}

export type EncryptEnvelopeOptions = {
  keyring: AutomationKeyring;
  aad: EnvelopeAad;
  expiresAt: string;
  issuedAt?: string;
  randomBytes?: (length: number) => Uint8Array;
};

export type DecryptEnvelopeOptions = {
  keyring: AutomationKeyring;
  aad: EnvelopeAad;
  now?: number;
};

export type OpenedAutomationEnvelope<T> = {
  payload: T;
  envelope: EncryptedAutomationEnvelope;
  keyId: string;
  rotated: boolean;
};

export async function encryptEnvelope<T>(payload: T, options: EncryptEnvelopeOptions): Promise<string> {
  assertKeyring(options.keyring);
  const issuedAt = options.issuedAt ?? new Date().toISOString();
  assertTimeWindow(issuedAt, options.expiresAt);
  const nonce = bytesFromRandomSource((options.randomBytes ?? randomBytes)(12), 12);
  const header = {
    version: AUTOMATION_PROTOCOL_VERSION,
    algorithm: AUTOMATION_ENVELOPE_ALGORITHM,
    keyId: options.keyring.current.id,
    nonce: toBase64Url(nonce),
    issuedAt,
    expiresAt: options.expiresAt,
  } as const;
  const key = await importAesKey(options.keyring.current.material, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(authenticatedData(header, options.aad)) },
    key,
    toArrayBuffer(serializeJson(payload)),
  );
  return encodeEnvelope(header, new Uint8Array(encrypted));
}

export async function openEnvelope<T>(token: string, options: DecryptEnvelopeOptions): Promise<OpenedAutomationEnvelope<T>> {
  assertKeyring(options.keyring);
  const { header, ciphertext } = decodeEnvelope(token);
  assertNotExpired(header.expiresAt, options.now, "ENVELOPE_EXPIRED");
  const selected = findKey(options.keyring, header.keyId);
  try {
    const key = await importAesKey(selected.key.material, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(fromBase64Url(header.nonce)), additionalData: toArrayBuffer(authenticatedData(header, options.aad)) },
      key,
      toArrayBuffer(ciphertext),
    );
    const payload: unknown = JSON.parse(textDecoder.decode(plaintext));
    return {
      payload: payload as T,
      envelope: { ...header, ciphertext: toBase64Url(ciphertext) },
      keyId: header.keyId,
      rotated: selected.rotated,
    };
  } catch (error) {
    if (error instanceof AutomationProtocolError) throw error;
    throw protocolError("INVALID_ENVELOPE", "Invalid encrypted automation envelope.");
  }
}

export async function decryptEnvelope<T>(token: string, options: DecryptEnvelopeOptions): Promise<T> {
  return (await openEnvelope<T>(token, options)).payload;
}

const canonicalDateSchema = z.string().regex(ISO_DATE_PATTERN).refine(isCanonicalIsoDate);
const positiveIntegerSchema = z.number().int().nonnegative().safe();
const fenceSchema = z.number().int().positive().safe();
const envelopeReferenceSchema = z.string().regex(/^aep1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).max(MAX_ENVELOPE_BYTES * 2);

export const uetImportJobSchema = z.object({
  version: z.literal(1),
  type: z.literal("uet-import"),
  jobId: opaqueIdSchema,
  accountId: opaqueIdSchema,
  fence: fenceSchema,
  issuedAt: canonicalDateSchema,
  expiresAt: canonicalDateSchema,
  credentialEnvelope: envelopeReferenceSchema,
  expectedStudentCode: z.string().min(1).max(128).optional(),
}).strict();

export type UetImportJob = z.infer<typeof uetImportJobSchema> & {
  jobId: JobId;
  accountId: AccountId;
};

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, code: "INVALID_JOB" | "INVALID_EVENT"): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw protocolError(code, code === "INVALID_JOB" ? "Invalid UET import job." : "Invalid automation event.");
  return parsed.data;
}

export function assertUetImportJob(value: unknown): asserts value is UetImportJob {
  const job = parseSchema(uetImportJobSchema, value, "INVALID_JOB");
  assertOpaqueId<"job">(job.jobId);
  assertOpaqueId<"account">(job.accountId);
  assertTimeWindow(job.issuedAt, job.expiresAt);
}

export function parseUetImportJob(value: unknown, now = Date.now()): UetImportJob {
  assertUetImportJob(value);
  assertNotExpired(value.expiresAt, now, "JOB_EXPIRED");
  return value;
}

export type CreateUetImportJobInput = {
  jobId: JobId;
  accountId: AccountId;
  fence: number;
  credentialEnvelope: string;
  expiresAt: string;
  issuedAt?: string;
  expectedStudentCode?: string;
};

export function createUetImportJob(input: CreateUetImportJobInput): UetImportJob {
  const job: UetImportJob = {
    version: 1,
    type: "uet-import",
    jobId: input.jobId,
    accountId: input.accountId,
    fence: input.fence,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    expiresAt: input.expiresAt,
    credentialEnvelope: input.credentialEnvelope,
    ...(input.expectedStudentCode === undefined ? {} : { expectedStudentCode: input.expectedStudentCode }),
  };
  assertUetImportJob(job);
  return job;
}

const eventBase = {
  version: z.literal(1),
  jobId: opaqueIdSchema,
  accountId: opaqueIdSchema,
  fence: fenceSchema,
  sequence: positiveIntegerSchema,
  emittedAt: canonicalDateSchema,
  expiresAt: canonicalDateSchema,
};

export const automationEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("started") }).strict(),
  z.object({ ...eventBase, type: z.literal("progress"), phase: z.enum(["queue", "login", "captcha", "import", "finalize"]), percent: z.number().int().min(0).max(100) }).strict(),
  z.object({ ...eventBase, type: z.literal("challenge-required"), challengeId: opaqueIdSchema, image: z.string().min(1).max(350_000) }).strict(),
  z.object({ ...eventBase, type: z.literal("heartbeat") }).strict(),
  z.object({ ...eventBase, type: z.literal("succeeded"), resultEnvelope: envelopeReferenceSchema.optional() }).strict(),
  z.object({ ...eventBase, type: z.literal("failed"), code: z.string().regex(/^[A-Z][A-Z0-9_.-]{1,63}$/), retryable: z.boolean() }).strict(),
  z.object({ ...eventBase, type: z.literal("cancelled"), reason: z.enum(["requested", "expired", "superseded", "shutdown"]) }).strict(),
]);

export type AutomationEvent = z.infer<typeof automationEventSchema> & {
  jobId: JobId;
  accountId: AccountId;
  challengeId?: ChallengeId;
};

export function assertAutomationEvent(value: unknown): asserts value is AutomationEvent {
  const event = parseSchema(automationEventSchema, value, "INVALID_EVENT");
  assertOpaqueId<"job">(event.jobId);
  assertOpaqueId<"account">(event.accountId);
  if (event.type === "challenge-required") assertOpaqueId<"challenge">(event.challengeId);
  assertTimeWindow(event.emittedAt, event.expiresAt);
}

export function parseAutomationEvent(value: unknown, now = Date.now()): AutomationEvent {
  assertAutomationEvent(value);
  assertNotExpired(value.expiresAt, now, "EVENT_EXPIRED");
  return value;
}

export type EventCursor = {
  jobId: JobId;
  accountId: AccountId;
  fence: number;
  lastSequence: number;
  terminal: boolean;
};

export function createEventCursor(job: Pick<UetImportJob, "jobId" | "accountId" | "fence">, initialSequence = -1): EventCursor {
  assertOpaqueId<"job">(job.jobId);
  assertOpaqueId<"account">(job.accountId);
  if (!Number.isSafeInteger(initialSequence) || initialSequence < -1) throw protocolError("INVALID_INPUT", "Initial event sequence must be -1 or a safe integer.");
  if (!Number.isSafeInteger(job.fence) || job.fence < 1) throw protocolError("INVALID_INPUT", "Event fence must be a positive safe integer.");
  return { jobId: job.jobId, accountId: job.accountId, fence: job.fence, lastSequence: initialSequence, terminal: false };
}

function isTerminalEvent(event: AutomationEvent): boolean {
  return event.type === "succeeded" || event.type === "failed" || event.type === "cancelled";
}

export function validateNextAutomationEvent(eventValue: unknown, cursor: EventCursor, now = Date.now()): EventCursor {
  const event = parseAutomationEvent(eventValue, now);
  if (event.jobId !== cursor.jobId) throw protocolError("EVENT_JOB_MISMATCH", "Automation event belongs to a different job.");
  if (event.accountId !== cursor.accountId) throw protocolError("EVENT_ACCOUNT_MISMATCH", "Automation event belongs to a different account.");
  if (event.fence !== cursor.fence) throw protocolError("EVENT_FENCE_MISMATCH", "Automation event has a stale fence.");
  if (cursor.terminal) throw protocolError("EVENT_AFTER_TERMINAL", "Automation events cannot follow a terminal event.");
  if (event.sequence !== cursor.lastSequence + 1) throw protocolError("EVENT_SEQUENCE_MISMATCH", "Automation event sequence is not contiguous.");
  return { ...cursor, lastSequence: event.sequence, terminal: isTerminalEvent(event) };
}

export function validateAutomationEventSequence(events: readonly unknown[], cursor: EventCursor, now = Date.now()): EventCursor {
  let next = cursor;
  for (const event of events) next = validateNextAutomationEvent(event, next, now);
  return next;
}

const SENSITIVE_KEY_PATTERN = /(?:password|passphrase|secret|token|cookie|authorization|bearer|credential|csrf|captcha.?answer|answer|ciphertext|image)/i;

function shouldRedactKey(key: string, parent: Record<string, unknown>): boolean {
  if (SENSITIVE_KEY_PATTERN.test(key)) return true;
  return key === "value" && (parent.kind === "bearer" || parent.kind === "cookie" || parent.kind === "manual");
}

export function redactSecrets<T>(value: T): unknown {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, parent?: Record<string, unknown>): unknown => {
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return "[Circular]";
    seen.add(current);
    if (Array.isArray(current)) return current.map((item) => visit(item));
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current)) {
      output[key] = shouldRedactKey(key, current as Record<string, unknown>) ? "[REDACTED]" : visit(child, current as Record<string, unknown>);
    }
    seen.delete(current);
    return output;
  };
  return visit(value);
}

export const redactForLog = redactSecrets;

export function redactError(error: unknown): { name: string; code?: string; message: string } {
  if (error instanceof AutomationProtocolError) return { name: error.name, code: error.code, message: error.message };
  if (error instanceof Error) return { name: error.name, message: "Unexpected automation protocol error." };
  return { name: "Error", message: "Unknown automation protocol error." };
}
