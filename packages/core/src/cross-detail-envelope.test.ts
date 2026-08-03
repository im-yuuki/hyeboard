import { describe, expect, it } from "vitest";
import {
  decryptVnuCrossDetailPermitEnvelope,
  encryptVnuCrossDetailPermitEnvelope,
  VNU_CROSS_DETAIL_PERMIT_ENVELOPE_MAX_LENGTH,
  type VnuCrossDetailPermitEnvelope,
} from "./index";

const SECRET = "synthetic-core-secret-with-at-least-32-chars";
const WRONG_SECRET = "different-synthetic-secret-at-least-32-chars";

function syntheticEnvelope(): VnuCrossDetailPermitEnvelope {
  return {
    version: 1,
    purpose: "vnu-cross-detail",
    nonce: "a".repeat(32),
    targetHmac: "b".repeat(64),
    revisionHmac: "c".repeat(64),
    rowHmac: "d".repeat(64),
    selector: { stdId: "99000000001", classId: "990099", termOrdinal: "2" },
  };
}

describe("VNU cross-detail permit envelope", () => {
  it("round-trips a well-formed envelope", async () => {
    const payload = syntheticEnvelope();
    const token = await encryptVnuCrossDetailPermitEnvelope(payload, SECRET);

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(VNU_CROSS_DETAIL_PERMIT_ENVELOPE_MAX_LENGTH);
    expect(token).not.toContain("99000000001");
    await expect(decryptVnuCrossDetailPermitEnvelope(token, SECRET)).resolves.toEqual(payload);
  });

  it("rejects decryption with the wrong secret as a generic invalid permit", async () => {
    const token = await encryptVnuCrossDetailPermitEnvelope(syntheticEnvelope(), SECRET);

    await expect(decryptVnuCrossDetailPermitEnvelope(token, WRONG_SECRET)).rejects.toMatchObject({
      code: "VNU_CROSS_DETAIL_PERMIT_INVALID",
      status: 403,
    });
  });

  it.each([
    ["empty", ""],
    ["single segment", "abc"],
    ["three segments", "a.b.c"],
    ["non-base64url", "!!!.@@@"],
    ["oversized", `${"A".repeat(VNU_CROSS_DETAIL_PERMIT_ENVELOPE_MAX_LENGTH)}.AA`],
  ])("rejects a %s token shape before decryption", async (_label, token) => {
    await expect(decryptVnuCrossDetailPermitEnvelope(token, SECRET)).rejects.toMatchObject({
      code: "VNU_CROSS_DETAIL_PERMIT_INVALID",
      status: 403,
    });
  });

  it("never leaks the rejection reason beyond the stable code", async () => {
    const token = await encryptVnuCrossDetailPermitEnvelope(syntheticEnvelope(), SECRET);
    const tampered = `${token.slice(0, -2)}${token.endsWith("AA") ? "AB" : "AA"}`;

    const rejection = await decryptVnuCrossDetailPermitEnvelope(tampered, SECRET).catch((error: unknown) => error);

    expect(rejection).toMatchObject({ code: "VNU_CROSS_DETAIL_PERMIT_INVALID", status: 403 });
    expect(JSON.stringify(rejection)).not.toContain("99000000001");
  });

  it.each([
    ["wrong version", { version: 2 }],
    ["wrong purpose", { purpose: "vnu-refresh" }],
    ["short nonce", { nonce: "a".repeat(31) }],
    ["non-hex nonce", { nonce: "g".repeat(32) }],
    ["short target hmac", { targetHmac: "b".repeat(63) }],
    ["short revision hmac", { revisionHmac: "c".repeat(63) }],
    ["short row hmac", { rowHmac: "d".repeat(63) }],
    ["non-numeric stdId", { selector: { stdId: "99x", classId: "990099", termOrdinal: "2" } }],
    ["overlong stdId", { selector: { stdId: "9".repeat(12), classId: "990099", termOrdinal: "2" } }],
    ["empty classId", { selector: { stdId: "99000000001", classId: "", termOrdinal: "2" } }],
    ["whitespace classId", { selector: { stdId: "99000000001", classId: "99 0099", termOrdinal: "2" } }],
    ["empty term ordinal", { selector: { stdId: "99000000001", classId: "990099", termOrdinal: "" } }],
    ["extra key", { unexpected: true }],
  ] as const)("refuses to mint an envelope with %s", async (_label, mutation) => {
    const payload = { ...syntheticEnvelope(), ...mutation } as unknown as VnuCrossDetailPermitEnvelope;

    await expect(encryptVnuCrossDetailPermitEnvelope(payload, SECRET)).rejects.toMatchObject({
      code: "VNU_CROSS_DETAIL_PERMIT_INVALID",
      status: 403,
    });
  });

  it("derives a key isolated from the session and refresh-grant domains", async () => {
    const payload = syntheticEnvelope();
    const token = await encryptVnuCrossDetailPermitEnvelope(payload, SECRET);

    await expect(decryptVnuCrossDetailPermitEnvelope(token, SECRET)).resolves.toEqual(payload);
    const { decryptSession, decryptVnuRefreshGrantForLogout } = await import("./index");
    await expect(decryptSession(token, SECRET)).rejects.toMatchObject({ code: "INVALID_SESSION" });
    await expect(decryptVnuRefreshGrantForLogout(token, SECRET)).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_INVALID" });
  });
});
