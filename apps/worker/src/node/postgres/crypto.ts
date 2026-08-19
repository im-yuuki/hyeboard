import { createHmac } from "node:crypto";

export type PostgresHmacSecret = string | Uint8Array;

export function derivePostgresOpaqueHash(secret: PostgresHmacSecret, kind: "token" | "session", value: string): string {
  if ((typeof secret === "string" && Buffer.byteLength(secret, "utf8") < 32) || (secret instanceof Uint8Array && secret.byteLength < 32)) {
    throw new Error("PostgreSQL HMAC secret must be at least 32 bytes");
  }
  if (value.length === 0) throw new Error("PostgreSQL revocation subject must not be empty");
  return createHmac("sha256", secret)
    .update(`hyeboard:session-revocation:v1:${kind}:`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function toPostgresEpochMilliseconds(value: Date | string | number): number {
  const milliseconds = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new Error("Invalid PostgreSQL expiry timestamp");
  return milliseconds;
}
