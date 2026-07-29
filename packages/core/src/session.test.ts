import { describe, expect, it } from "vitest";
import {
  assertVnuRefreshGrantMatchesDescriptor,
  createVnuRefreshAccessDescriptor,
  createVnuRefreshGrant,
  decryptSession,
  decryptSessionForVnuLogout,
  decryptSessionForVnuRefresh,
  decryptVnuRefreshGrant,
  decryptVnuRefreshGrantForLogout,
  deriveVnuRefreshPrincipal,
  encryptSession,
  encryptVnuRefreshGrant,
  rotateVnuRefreshGrant,
  VNU_REFRESH_GRANT_MAX_LENGTH,
  type EncryptedSessionPayload,
  type VnuRefreshAccessDescriptor,
} from "./index";

const SECRET = "synthetic-core-secret-with-at-least-32-chars";
const WRONG_SECRET = "different-synthetic-secret-at-least-32-chars";
const NOW = Date.parse("2036-01-02T03:04:05.000Z");
const ACCESS_EXPIRES_AT = "2036-01-02T04:04:05.000Z";
const encoder = new TextEncoder();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function encryptMalformedGrantFixture(payload: unknown): Promise<string> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(SECRET), "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(encoder.encode("hyeboard:vnu-refresh:v1:salt")),
      info: toArrayBuffer(encoder.encode("hyeboard:vnu-refresh:v1:aes-gcm")),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = new Uint8Array(12).fill(0x7a);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(encoder.encode("hyeboard:vnu-refresh:v1")) },
    key,
    toArrayBuffer(encoder.encode(JSON.stringify(payload))),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

async function encryptRawAccessFixture(payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(SECRET));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12).fill(0x6b);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(encoder.encode(JSON.stringify(payload))),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

function deterministicBytes(value: number): (length: number) => Uint8Array {
  return (length) => new Uint8Array(length).fill(value);
}

function boundaryGrant(password: string) {
  return createVnuRefreshGrant({
    username: "synthetic-boundary-user",
    password,
    expectedStudentCode: "SYNTHETIC-BOUNDARY-STUDENT",
    now: NOW,
    randomBytes: deterministicBytes(0x41),
  });
}

function largestAcceptedAsciiPasswordLength(): number {
  let low = 1;
  let high = VNU_REFRESH_GRANT_MAX_LENGTH;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    try {
      boundaryGrant("P".repeat(candidate));
      low = candidate;
    } catch {
      high = candidate - 1;
    }
  }
  return low;
}

function vnuSession(vnuRefresh?: VnuRefreshAccessDescriptor): EncryptedSessionPayload {
  return {
    version: 1,
    universityId: "vnu",
    studentCode: "SYNTHETIC-STUDENT-CODE",
    vnu: { kind: "cookie", value: "SYNTHETIC-COOKIE" },
    expiresAt: vnuRefresh?.accessExpiresAt ?? ACCESS_EXPIRES_AT,
    ...(vnuRefresh ? { vnuRefresh } : {}),
  };
}

async function linkedArtifacts() {
  const grant = createVnuRefreshGrant({
    username: "  SYNTHETIC-VNU-USER  ",
    password: "SYNTHETIC-VNU-PASSWORD",
    expectedStudentCode: "SYNTHETIC-STUDENT-CODE",
    now: NOW,
    randomBytes: deterministicBytes(0x5a),
  });
  const descriptor = await createVnuRefreshAccessDescriptor({
    username: grant.username,
    grantId: grant.grantId,
    accessExpiresAt: ACCESS_EXPIRES_AT,
    grantExpiresAt: grant.expiresAt,
    secret: SECRET,
    randomBytes: deterministicBytes(0x33),
  });
  return { grant, descriptor };
}

describe("encryptSession / decryptSession", () => {
  it("roundtrips a payload carrying uetGoogleCredential", async () => {
    const payload: EncryptedSessionPayload = {
      version: 1,
      universityId: "uet",
      studentCode: "SYNTHETIC-STUDENT-CODE",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      studenthub: { kind: "bearer", value: "SYNTHETIC-SH-TOKEN", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      uetGoogleCredential: { email: "SYNTHETIC-EMAIL", password: "SYNTHETIC-PASSWORD" },
    };
    const token = await encryptSession(payload, SECRET);
    const decrypted = await decryptSession(token, SECRET);
    expect(decrypted.uetGoogleCredential).toEqual(payload.uetGoogleCredential);
    expect(decrypted.studenthub?.value).toBe("SYNTHETIC-SH-TOKEN");
  });

  it("omits uetGoogleCredential when not set", async () => {
    const payload: EncryptedSessionPayload = {
      version: 1,
      universityId: "uet",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      studenthub: { kind: "bearer", value: "SYNTHETIC-SH-TOKEN", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    };
    const token = await encryptSession(payload, SECRET);
    await expect(decryptSession(token, SECRET)).resolves.toEqual(payload);
  });

  it("preserves historical descriptor-less V1 payload shape and date compatibility", async () => {
    const legacyPayload = {
      version: 1,
      universityId: "uet",
      studentCode: "",
      studenthub: { kind: "bearer", value: "", csrfToken: "", expiresAt: "" },
      expiresAt: "2099-01-01T00:00:00Z",
      syntheticLegacyExtra: "SYNTHETIC-LEGACY-EXTRA",
    } as unknown as EncryptedSessionPayload;

    const historicalTokenFixture = await encryptRawAccessFixture(legacyPayload);
    await expect(decryptSession(historicalTokenFixture, SECRET)).resolves.toEqual(legacyPayload);
    const roundtripToken = await encryptSession(legacyPayload, SECRET);
    await expect(decryptSession(roundtripToken, SECRET)).resolves.toEqual(legacyPayload);
  });
});

describe("VNU refresh grants", () => {
  it("bounds producer grants at the largest encoded token that can roundtrip", async () => {
    const largestPasswordLength = largestAcceptedAsciiPasswordLength();
    const grant = boundaryGrant("P".repeat(largestPasswordLength));
    const token = await encryptVnuRefreshGrant(grant, SECRET);
    expect(token.length).toBeLessThanOrEqual(VNU_REFRESH_GRANT_MAX_LENGTH);
    await expect(decryptVnuRefreshGrant(token, SECRET, NOW + 1)).resolves.toEqual(grant);

    expect(() => boundaryGrant("P".repeat(largestPasswordLength + 1))).toThrow(expect.objectContaining({
      code: "VNU_REFRESH_GRANT_TOO_LARGE",
      status: 400,
      details: undefined,
    }));
  });

  it("measures producer feasibility in UTF-8 bytes without exposing Unicode credentials", () => {
    const largestPasswordLength = largestAcceptedAsciiPasswordLength();
    expect(() => boundaryGrant("P".repeat(largestPasswordLength))).not.toThrow();
    const privateUnicode = "秘密".repeat(Math.ceil(largestPasswordLength / 2));
    try {
      boundaryGrant(privateUnicode);
      throw new Error("Expected Unicode grant to exceed the encoded limit");
    } catch (error) {
      expect(error).toMatchObject({
        code: "VNU_REFRESH_GRANT_TOO_LARGE",
        message: "The VNU reconnect credentials are too large to store safely.",
        status: 400,
        details: undefined,
      });
      expect(String(error)).not.toContain(privateUnicode.slice(0, 16));
    }
  });

  it("round trips an exact purpose-bound eight-hour payload", async () => {
    const { grant } = await linkedArtifacts();
    const token = await encryptVnuRefreshGrant(grant, SECRET);
    await expect(decryptVnuRefreshGrant(token, SECRET, NOW + 1)).resolves.toEqual(grant);
    expect(grant).toMatchObject({ version: 1, purpose: "vnu-refresh", universityId: "vnu", username: "synthetic-vnu-user" });
    expect(Object.keys(grant).sort()).toEqual([
      "expectedStudentCode", "expiresAt", "grantId", "issuedAt", "password", "purpose", "universityId", "username", "version",
    ]);
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt)).toBe(8 * 60 * 60 * 1000);
    expect(grant.grantId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("separates access-token and refresh-grant cryptographic domains", async () => {
    const { grant } = await linkedArtifacts();
    const accessToken = await encryptSession(vnuSession(), SECRET);
    const grantToken = await encryptVnuRefreshGrant(grant, SECRET);
    await expect(decryptVnuRefreshGrant(accessToken, SECRET, NOW)).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_INVALID", status: 401 });
    await expect(decryptSession(grantToken, SECRET)).rejects.toMatchObject({ code: "INVALID_SESSION", status: 401 });
  });

  it.each(["not-a-grant", "AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAA"])("sanitizes malformed or tampered ciphertext", async (token) => {
    await expect(decryptVnuRefreshGrant(token, SECRET, NOW)).rejects.toEqual(expect.objectContaining({
      code: "VNU_REFRESH_GRANT_INVALID",
      message: "The VNU reconnect grant is invalid or expired.",
      status: 401,
      details: undefined,
    }));
  });

  it("rejects invalid shapes, wrong secrets, and expiry uniformly", async () => {
    const { grant } = await linkedArtifacts();
    const invalidShapes = [
      { ...grant, purpose: "access" },
      { ...grant, version: 2 },
      { ...grant, universityId: "uet" },
      { ...grant, issuedAt: "2036-01-02T03:04:05Z" },
      { ...grant, issuedAt: "2036-01-02T10:04:05.000+07:00" },
      { ...grant, expiresAt: "2036-02-30T11:04:05.000Z" },
      { ...grant, expiresAt: `${grant.expiresAt}tail` },
      { ...grant, username: "" },
      { ...grant, password: "" },
      { ...grant, expectedStudentCode: "" },
      { ...grant, grantId: "short" },
      { ...grant, grantId: `${"A".repeat(21)}B` },
      { ...grant, extra: "SYNTHETIC-EXTRA" },
      Object.fromEntries(Object.entries(grant).filter(([key]) => key !== "password")),
    ];
    for (const shape of invalidShapes) {
      const encrypted = await encryptMalformedGrantFixture(shape);
      await expect(decryptVnuRefreshGrant(encrypted, SECRET, NOW)).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_INVALID", details: undefined });
    }
    const encrypted = await encryptVnuRefreshGrant(grant, SECRET);
    await expect(decryptVnuRefreshGrant(encrypted, WRONG_SECRET, NOW)).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_INVALID" });
    await expect(decryptVnuRefreshGrant(encrypted, SECRET, Date.parse(grant.expiresAt))).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_INVALID" });
  });

  it("authenticates an expired grant only through the logout decoder", async () => {
    const { grant } = await linkedArtifacts();
    const token = await encryptVnuRefreshGrant(grant, SECRET);
    const expiredAt = Date.parse(grant.expiresAt);
    await expect(decryptVnuRefreshGrant(token, SECRET, expiredAt)).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_INVALID" });
    await expect(decryptVnuRefreshGrantForLogout(token, SECRET)).resolves.toEqual(grant);
  });

  it("keeps logout grant decoding strict for tampering and malformed purpose payloads", async () => {
    const { grant } = await linkedArtifacts();
    const malformed = await encryptMalformedGrantFixture({ ...grant, purpose: "access" });
    const token = await encryptVnuRefreshGrant(grant, SECRET);
    const [iv, ciphertext] = token.split(".") as [string, string];
    const tampered = `${iv}.${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`;
    for (const invalid of ["not-a-grant", malformed, tampered]) {
      await expect(decryptVnuRefreshGrantForLogout(invalid, SECRET)).rejects.toMatchObject({
        code: "VNU_REFRESH_GRANT_INVALID",
        status: 401,
        details: undefined,
      });
    }
  });

  it("preserves weak-secret behavior", async () => {
    const { grant } = await linkedArtifacts();
    await expect(encryptVnuRefreshGrant(grant, "weak")).rejects.toMatchObject({ code: "WEAK_SESSION_SECRET", status: 500 });
    await expect(decryptVnuRefreshGrant("bad", "weak", NOW)).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_INVALID", status: 401 });
  });

  it("never encrypts an invalid grant payload", async () => {
    const { grant } = await linkedArtifacts();
    await expect(encryptVnuRefreshGrant({ ...grant, purpose: "access" } as never, SECRET)).rejects.toMatchObject({
      code: "VNU_REFRESH_GRANT_INVALID",
      status: 401,
    });
  });

  it("uses independent IVs and rotates only its ID", async () => {
    const { grant } = await linkedArtifacts();
    const first = await encryptVnuRefreshGrant(grant, SECRET);
    const second = await encryptVnuRefreshGrant(grant, SECRET);
    expect(first.split(".")[0]).not.toBe(second.split(".")[0]);
    const rotated = rotateVnuRefreshGrant(grant, deterministicBytes(0x22));
    expect(rotated.grantId).not.toBe(grant.grantId);
    expect(rotated.issuedAt).toBe(grant.issuedAt);
    expect(rotated.expiresAt).toBe(grant.expiresAt);
  });
});

describe("VNU refresh access descriptors", () => {
  it("derives a normalized, secret-bound private principal", async () => {
    const first = await deriveVnuRefreshPrincipal(" SYNTHETIC-VNU-USER ", SECRET);
    const normalized = await deriveVnuRefreshPrincipal("synthetic-vnu-user", SECRET);
    const otherSecret = await deriveVnuRefreshPrincipal("synthetic-vnu-user", WRONG_SECRET);
    expect(first).toBe(normalized);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(otherSecret);
    expect(first).not.toContain("synthetic");
  });

  it("has exact private shape and reconstructs a complete linked pair without a grant", async () => {
    const { grant, descriptor } = await linkedArtifacts();
    expect(Object.keys(descriptor).sort()).toEqual([
      "accessExpiresAt", "accessTokenId", "grantExpiresAt", "grantId", "principalKey", "purpose", "version",
    ]);
    expect(descriptor).toMatchObject({ version: 1, purpose: "vnu-refresh-access", grantId: grant.grantId, grantExpiresAt: grant.expiresAt });
    expect(descriptor.accessTokenId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const serialized = JSON.stringify(descriptor).toLowerCase();
    for (const privateText of ["synthetic-vnu-user", "synthetic-vnu-password", "synthetic-student-code", "synthetic-cookie"]) {
      expect(serialized).not.toContain(privateText);
    }
    const token = await encryptSession(vnuSession(descriptor), SECRET);
    const decoded = await decryptSessionForVnuRefresh(token, SECRET);
    expect(decoded.vnuRefresh).toEqual(descriptor);
    expect(decoded.vnuRefresh && {
      accessTokenId: decoded.vnuRefresh.accessTokenId,
      accessExpiresAt: Date.parse(decoded.vnuRefresh.accessExpiresAt),
      grantId: decoded.vnuRefresh.grantId,
      grantExpiresAt: Date.parse(decoded.vnuRefresh.grantExpiresAt),
    }).toEqual({
      accessTokenId: descriptor.accessTokenId,
      accessExpiresAt: Date.parse(ACCESS_EXPIRES_AT),
      grantId: grant.grantId,
      grantExpiresAt: Date.parse(grant.expiresAt),
    });
  });

  it("matches only its linked grant", async () => {
    const { grant, descriptor } = await linkedArtifacts();
    await expect(assertVnuRefreshGrantMatchesDescriptor(grant, descriptor, SECRET)).resolves.toBeUndefined();
    const rotated = rotateVnuRefreshGrant(grant, deterministicBytes(0x77));
    await expect(assertVnuRefreshGrantMatchesDescriptor(rotated, descriptor, SECRET)).rejects.toMatchObject({ code: "INVALID_SESSION", status: 401 });
    await expect(
      assertVnuRefreshGrantMatchesDescriptor(grant, { ...descriptor, grantExpiresAt: "2036-01-02T12:04:05.000Z" }, SECRET),
    ).rejects.toMatchObject({ code: "INVALID_SESSION", status: 401 });
  });

  it("rejects a descriptor derived for a different grant username", async () => {
    const { grant } = await linkedArtifacts();
    const wrongPrincipalDescriptor = await createVnuRefreshAccessDescriptor({
      username: "SYNTHETIC-OTHER-VNU-USER",
      grantId: grant.grantId,
      accessExpiresAt: ACCESS_EXPIRES_AT,
      grantExpiresAt: grant.expiresAt,
      secret: SECRET,
      randomBytes: deterministicBytes(0x45),
    });

    await expect(assertVnuRefreshGrantMatchesDescriptor(grant, wrongPrincipalDescriptor, SECRET)).rejects.toMatchObject({
      code: "INVALID_SESSION",
      status: 401,
    });
  });

  it("accepts a rotated grant linked to a newly issued access token that expires later", async () => {
    const { grant } = await linkedArtifacts();
    const rotatedGrant = rotateVnuRefreshGrant(grant, deterministicBytes(0x66));
    const laterAccessExpiry = "2036-01-02T12:04:05.000Z";
    const descriptor = await createVnuRefreshAccessDescriptor({
      username: rotatedGrant.username,
      grantId: rotatedGrant.grantId,
      accessExpiresAt: laterAccessExpiry,
      grantExpiresAt: rotatedGrant.expiresAt,
      secret: SECRET,
      randomBytes: deterministicBytes(0x67),
    });

    expect(rotatedGrant.expiresAt).toBe(grant.expiresAt);
    expect(Date.parse(descriptor.accessExpiresAt)).toBeGreaterThan(Date.parse(descriptor.grantExpiresAt));
    await expect(assertVnuRefreshGrantMatchesDescriptor(rotatedGrant, descriptor, SECRET)).resolves.toBeUndefined();
    const token = await encryptSession(vnuSession(descriptor), SECRET);
    await expect(decryptSession(token, SECRET)).resolves.toEqual(vnuSession(descriptor));
  });

  it("rejects descriptor shape, linkage, context, and canonical timestamp failures", async () => {
    const { descriptor } = await linkedArtifacts();
    const invalidDescriptors = [
      { ...descriptor, version: 2 },
      { ...descriptor, purpose: "vnu-refresh" },
      { ...descriptor, principalKey: "A".repeat(64) },
      { ...descriptor, accessTokenId: "short" },
      { ...descriptor, grantId: "short" },
      { ...descriptor, grantId: `${"A".repeat(21)}B` },
      { ...descriptor, accessExpiresAt: "2036-01-02T04:04:05Z" },
      { ...descriptor, grantExpiresAt: "2036-01-02T18:04:05.000+07:00" },
      { ...descriptor, extra: "SYNTHETIC-EXTRA" },
      Object.fromEntries(Object.entries(descriptor).filter(([key]) => key !== "grantId")),
    ];
    const sessions = [
      ...invalidDescriptors.map((vnuRefresh) => vnuSession(vnuRefresh as VnuRefreshAccessDescriptor)),
      { ...vnuSession(descriptor), expiresAt: "2036-01-02T04:04:06.000Z" },
      { ...vnuSession(descriptor), universityId: "uet" },
      { ...vnuSession(descriptor), vnu: undefined },
      { ...vnuSession(descriptor), vnu: { kind: "cookie" as const, value: "" } },
    ];
    for (const session of sessions) {
      await expect(encryptSession(session as EncryptedSessionPayload, SECRET)).rejects.toMatchObject({ code: "INVALID_SESSION", status: 401 });
      const token = await encryptRawAccessFixture(session);
      await expect(decryptSessionForVnuRefresh(token, SECRET)).rejects.toMatchObject({ code: "INVALID_SESSION", status: 401 });
    }
  });

  it("rejects noncanonical outer timestamps", async () => {
    const { descriptor } = await linkedArtifacts();
    for (const expiresAt of [
      "2036-01-02T04:04:05Z",
      "2036-01-02T11:04:05.000+07:00",
      "2036-02-30T04:04:05.000Z",
      "2036-01-02T04:04:05.000Ztail",
    ]) {
      const malformedSession = { ...vnuSession({ ...descriptor, accessExpiresAt: expiresAt }), expiresAt };
      await expect(encryptSession(malformedSession, SECRET)).rejects.toMatchObject({ code: "INVALID_SESSION", status: 401 });
      const token = await encryptRawAccessFixture(malformedSession);
      await expect(decryptSessionForVnuLogout(token, SECRET)).rejects.toMatchObject({ code: "INVALID_SESSION", status: 401 });
    }
  });

  it("limits expired access decoding to refresh and logout entry points", async () => {
    const { descriptor } = await linkedArtifacts();
    const expiredDescriptor = { ...descriptor, accessExpiresAt: "2000-01-01T00:00:00.000Z" };
    const token = await encryptSession(vnuSession(expiredDescriptor), SECRET);
    await expect(decryptSession(token, SECRET)).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });
    await expect(decryptSessionForVnuRefresh(token, SECRET)).resolves.toEqual(vnuSession(expiredDescriptor));
    await expect(decryptSessionForVnuLogout(token, SECRET)).resolves.toEqual(vnuSession(expiredDescriptor));
  });

  it("does not turn purpose decoders into generic expired-session decoders", async () => {
    const token = await encryptSession({ ...vnuSession(), expiresAt: "2000-01-01T00:00:00.000Z" }, SECRET);
    await expect(decryptSessionForVnuRefresh(token, SECRET)).rejects.toMatchObject({ code: "INVALID_SESSION", status: 401 });
    await expect(decryptSessionForVnuLogout(token, SECRET)).rejects.toMatchObject({ code: "INVALID_SESSION", status: 401 });
  });

  it("keeps purpose decoders authenticated and structurally strict", async () => {
    const { descriptor } = await linkedArtifacts();
    const token = await encryptSession(vnuSession(descriptor), SECRET);
    const [iv, ciphertext] = token.split(".");
    const tampered = `${iv}.${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
    await expect(decryptSessionForVnuRefresh(token, WRONG_SECRET)).rejects.toMatchObject({ code: "INVALID_SESSION" });
    await expect(decryptSessionForVnuLogout(tampered, SECRET)).rejects.toMatchObject({ code: "INVALID_SESSION" });
    await expect(decryptSessionForVnuRefresh("malformed", SECRET)).rejects.toMatchObject({ code: "INVALID_SESSION" });
  });
});
