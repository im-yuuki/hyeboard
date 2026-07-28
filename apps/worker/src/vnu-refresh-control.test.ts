import { describe, expect, it, vi } from "vitest";
import {
  DurableObjectVnuRefreshControlCoordinator,
  VNU_REFRESH_LEASE_MS,
  VNU_REFRESH_STATE_KEY,
  VNU_REFRESH_WINDOW_MS,
  applyAbortRefresh,
  applyActivatePair,
  applyBeginRefresh,
  applyCheckAccess,
  applyCompleteRefresh,
  applyRevokeExactLinkedPair,
  applyRevokeLinkedPairByAccess,
  cleanVnuRefreshState,
  deriveVnuRefreshPrincipal,
  nextVnuRefreshAlarm,
  parseVnuRefreshControlState,
  vnuRefreshUnavailable,
  type LinkedPair,
  type VnuRefreshControlState,
  type VnuRefreshControlStub,
} from "./vnu-refresh-control";

const NOW = Date.parse("2036-02-03T04:05:06.000Z");
const EXPIRY = NOW + 8 * 60 * 60 * 1000;
const OLD: LinkedPair = { accessTokenId: "A".repeat(22), accessExpiresAt: EXPIRY - 60_000, grantId: "B".repeat(22), grantExpiresAt: EXPIRY };
const NEXT: LinkedPair = { accessTokenId: "C".repeat(22), accessExpiresAt: EXPIRY + 60_000, grantId: "D".repeat(22), grantExpiresAt: EXPIRY };
const stale = (state: VnuRefreshControlState): VnuRefreshControlState => ({ ...state, revokedAccess: { ...state.revokedAccess, ["S".repeat(22)]: NOW } });

describe("normative VNU refresh contracts", () => {
  it("uses exact state key and optional active/lease shape", () => {
    expect(VNU_REFRESH_STATE_KEY).toBe("vnu-refresh-control");
    const state = applyActivatePair(undefined, OLD, NOW).state;
    expect(state).toEqual({ active: OLD, revokedAccess: {}, revokedGrants: {}, window: { count: 0, resetAt: NOW + VNU_REFRESH_WINDOW_MS } });
    const leased = applyBeginRefresh(state, OLD, NOW).state;
    expect(leased.lease).toEqual({ pair: OLD, expiresAt: NOW + VNU_REFRESH_LEASE_MS });
  });

  it("parses only exact allowed state, lease, pair, maps, and window shapes", () => {
    const state = applyBeginRefresh(applyActivatePair(undefined, OLD, NOW).state, OLD, NOW).state;
    expect(parseVnuRefreshControlState(state)).toEqual(state);
    for (const invalid of [
      { ...state, extra: true },
      { ...state, lease: { ...state.lease, accessTokenId: OLD.accessTokenId } },
      { ...state, active: { ...OLD, extra: true } },
      { ...state, revokedAccess: undefined },
      { ...state, window: { count: -1, resetAt: NOW } },
    ]) expect(() => parseVnuRefreshControlState(invalid)).toThrow(/Invalid VNU refresh (state|pair)/);
  });

  it("rejects impossible relational authority states", () => {
    const active = applyActivatePair(undefined, OLD, NOW).state;
    const impossible = [
      { ...active, lease: { pair: OLD, expiresAt: NOW + 1 } , active: undefined },
      { ...active, lease: { pair: NEXT, expiresAt: NOW + 1 } },
      { ...active, lease: { pair: OLD, expiresAt: OLD.grantExpiresAt + 1 } },
      { ...active, revokedAccess: { [OLD.accessTokenId]: OLD.accessExpiresAt } },
      { ...active, revokedGrants: { [OLD.grantId]: OLD.grantExpiresAt } },
      { ...active, window: { count: 6, resetAt: EXPIRY } },
    ];
    for (const state of impossible) expect(() => parseVnuRefreshControlState(state)).toThrow("Invalid VNU refresh state");
  });

  it("does not schedule quiescent zero-attempt state", () => {
    const state: VnuRefreshControlState = { revokedAccess: {}, revokedGrants: {}, window: { count: 0, resetAt: NOW + VNU_REFRESH_WINDOW_MS } };
    expect(nextVnuRefreshAlarm(state)).toBeUndefined();
  });
});

describe("VNU refresh transitions", () => {
  it("activates and atomically revokes a replaced pair", () => {
    const first = applyActivatePair(undefined, OLD, NOW);
    const second = applyActivatePair(first.state, NEXT, NOW + 1);
    expect(first).toMatchObject({ result: { kind: "activated" }, changed: true });
    expect(second).toMatchObject({ result: { kind: "activated" }, changed: true, state: { active: NEXT } });
    expect(second.state.revokedAccess[OLD.accessTokenId]).toBe(OLD.accessExpiresAt);
    expect(second.state.revokedGrants[OLD.grantId]).toBe(OLD.grantExpiresAt);
  });

  it("same activation is unchanged without lease and clears lease as one mutation", () => {
    const active = applyActivatePair(undefined, OLD, NOW).state;
    expect(applyActivatePair(active, OLD, NOW + 1)).toEqual({ state: active, result: { kind: "activated" }, changed: false });
    const leased = applyBeginRefresh(active, OLD, NOW).state;
    const cleared = applyActivatePair(leased, OLD, NOW + 1);
    expect(cleared).toMatchObject({ result: { kind: "activated" }, changed: true });
    expect(cleared.state.lease).toBeUndefined();
  });

  it("never leases at or after grant expiry", () => {
    const pair = { ...OLD, accessExpiresAt: EXPIRY + 60_000 };
    const active = applyActivatePair(undefined, pair, NOW).state;
    expect(applyBeginRefresh(active, pair, EXPIRY)).toEqual({ state: active, result: { kind: "revoked" }, changed: false });
  });

  it("leases once, exposes lease expiry, and duplicates are strict no-ops", () => {
    const active = applyActivatePair(undefined, OLD, NOW).state;
    const first = applyBeginRefresh(active, OLD, NOW);
    expect(first).toMatchObject({ result: { kind: "accepted", leaseExpiresAt: NOW + 120_000 }, changed: true });
    expect(first.state.window).toEqual({ count: 1, resetAt: NOW + 900_000 });
    expect(applyBeginRefresh(first.state, OLD, NOW + 1)).toEqual({ state: first.state, result: { kind: "in-progress", retryAfterSeconds: 120 }, changed: false });
  });

  it("caps lease expiry at the fixed grant boundary", () => {
    const pair = { ...OLD, grantExpiresAt: NOW + 1_000 };
    const active = applyActivatePair(undefined, pair, NOW).state;
    expect(applyBeginRefresh(active, pair, NOW).result).toEqual({ kind: "accepted", leaseExpiresAt: pair.grantExpiresAt });
  });

  it("enforces five attempts and does not smuggle cleanup on rate limit", () => {
    let state = applyActivatePair(undefined, OLD, NOW).state;
    for (let attempt = 0; attempt < 5; attempt += 1) state = applyBeginRefresh(state, OLD, NOW + attempt * 120_001).state;
    const snapshot = stale(state);
    expect(applyBeginRefresh(snapshot, OLD, NOW + 5 * 120_001)).toEqual({
      state: snapshot,
      result: { kind: "rate-limited", retryAfterSeconds: 300, limit: 5, windowSeconds: 900 },
      changed: false,
    });
  });

  it("completes exact rotation and late completion returns revoked unchanged", () => {
    const leased = applyBeginRefresh(applyActivatePair(undefined, OLD, NOW).state, OLD, NOW).state;
    const completed = applyCompleteRefresh(leased, { old: OLD, next: NEXT }, NOW + 1);
    expect(completed).toMatchObject({ result: { kind: "completed" }, changed: true, state: { active: NEXT } });
    expect(applyCompleteRefresh(completed.state, { old: OLD, next: NEXT }, NOW + 2)).toEqual({ state: completed.state, result: { kind: "revoked" }, changed: false });
  });

  it("rejects reused or revoked rotation identifiers before mutation", () => {
    const leased = applyBeginRefresh(applyActivatePair(undefined, OLD, NOW).state, OLD, NOW).state;
    const collisionState: VnuRefreshControlState = {
      ...leased,
      revokedAccess: { ...leased.revokedAccess, [NEXT.accessTokenId]: NEXT.accessExpiresAt },
      revokedGrants: { ...leased.revokedGrants, [NEXT.grantId]: NEXT.grantExpiresAt },
    };
    for (const next of [
      { ...NEXT, accessTokenId: OLD.accessTokenId },
      { ...NEXT, grantId: OLD.grantId },
      NEXT,
    ]) {
      const state = next === NEXT ? collisionState : leased;
      expect(() => applyCompleteRefresh(state, { old: OLD, next }, NOW + 1)).toThrow(/rotation/i);
      expect(state).toEqual(next === NEXT ? collisionState : leased);
    }
  });

  it("aborts retryably, revokes terminally, and absent abort is unchanged", () => {
    const active = applyActivatePair(undefined, OLD, NOW).state;
    expect(applyAbortRefresh(active, { pair: OLD, terminal: false }, NOW)).toEqual({ state: active, result: { kind: "aborted" }, changed: false });
    const leased = applyBeginRefresh(active, OLD, NOW).state;
    const retryable = applyAbortRefresh(leased, { pair: OLD, terminal: false }, NOW + 1);
    expect(retryable).toMatchObject({ result: { kind: "aborted" }, changed: true });
    const terminal = applyAbortRefresh(applyBeginRefresh(retryable.state, OLD, NOW + 2).state, { pair: OLD, terminal: true }, NOW + 3);
    expect(terminal).toMatchObject({ result: { kind: "revoked" }, changed: true });
  });

  it("keeps exact revoke idempotent between access and grant expiry", () => {
    const pair = { ...OLD, accessExpiresAt: NOW };
    const active = applyActivatePair(undefined, pair, NOW - 1).state;
    const first = applyRevokeLinkedPairByAccess(active, pair, NOW + 1);
    expect(first).toMatchObject({ result: { kind: "revoked" }, changed: true });
    expect(first.state.revokedAccess[pair.accessTokenId]).toBe(pair.accessExpiresAt);
    expect(applyRevokeLinkedPairByAccess(first.state, pair, NOW + 2)).toEqual({ state: first.state, result: { kind: "revoked" }, changed: false });
    const cleaned = cleanVnuRefreshState(first.state, NOW + 3);
    expect(cleaned.revokedAccess[pair.accessTokenId]).toBeUndefined();
    expect(applyRevokeLinkedPairByAccess(cleaned, pair, NOW + 3)).toEqual({ state: cleaned, result: { kind: "revoked" }, changed: false });
    const stillLiveWrongAccess = { ...pair, accessTokenId: "Z".repeat(22), accessExpiresAt: NOW + 4 };
    expect(applyRevokeLinkedPairByAccess(cleaned, stillLiveWrongAccess, NOW + 3)).toEqual({ state: cleaned, result: { kind: "mismatch" }, changed: false });
    expect(applyRevokeLinkedPairByAccess(cleaned, { ...pair, grantId: "Z".repeat(22) }, NOW + 3)).toEqual({ state: cleaned, result: { kind: "mismatch" }, changed: false });
    expect(applyRevokeLinkedPairByAccess(cleaned, { ...pair, grantExpiresAt: pair.grantExpiresAt + 1 }, NOW + 3)).toEqual({ state: cleaned, result: { kind: "mismatch" }, changed: false });
  });

  it("expires access tombstones independently; unrelated grants cannot extend them", () => {
    const oldAccessId = "E".repeat(22);
    const unrelatedGrantId = "F".repeat(22);
    const stored: VnuRefreshControlState = {
      revokedAccess: { [oldAccessId]: NOW },
      revokedGrants: { [unrelatedGrantId]: EXPIRY },
      window: { count: 0, resetAt: EXPIRY },
    };
    const cleaned = cleanVnuRefreshState(stored, NOW + 1);
    expect(cleaned.revokedAccess).toEqual({});
    expect(cleaned.revokedGrants).toEqual({ [unrelatedGrantId]: EXPIRY });
    expect(nextVnuRefreshAlarm(cleaned)).toBe(EXPIRY);
  });

  it("all stale-candidate no-ops preserve the exact original snapshot", () => {
    const active = applyActivatePair(undefined, OLD, NOW).state;
    const leased = applyBeginRefresh(active, OLD, NOW).state;
    const completed = applyCompleteRefresh(leased, { old: OLD, next: NEXT }, NOW + 1).state;
    const revoked = applyRevokeLinkedPairByAccess(active, OLD, NOW + 1).state;
    const staleActive = stale(active);
    const staleLeased = stale(leased);
    const staleCompleted = stale(completed);
    const staleRevoked = stale(revoked);
    const cases = [
      applyActivatePair(staleActive, OLD, NOW + 1),
      applyBeginRefresh(staleLeased, OLD, NOW + 1),
      applyBeginRefresh(staleCompleted, OLD, NOW + 2),
      applyCompleteRefresh(staleCompleted, { old: OLD, next: NEXT }, NOW + 2),
      applyAbortRefresh(staleActive, { pair: OLD, terminal: false }, NOW + 1),
      applyRevokeLinkedPairByAccess(staleActive, { ...OLD, grantId: "Z".repeat(22) }, NOW + 1),
      applyRevokeLinkedPairByAccess(staleRevoked, OLD, NOW + 2),
    ];
    for (const output of cases) expect(output.changed).toBe(false);
    expect(cases.map((output) => output.state)).toEqual([staleActive, staleLeased, staleCompleted, staleCompleted, staleActive, staleActive, staleRevoked]);
    const expired = { ...OLD, accessExpiresAt: NOW, grantExpiresAt: NOW };
    const staleExpired = stale({ revokedAccess: {}, revokedGrants: {}, window: { count: 0, resetAt: EXPIRY } });
    expect(applyRevokeLinkedPairByAccess(staleExpired, expired, NOW)).toEqual({ state: staleExpired, result: { kind: "expired" }, changed: false });
    const cleaned = cleanVnuRefreshState(staleExpired, NOW);
    expect(applyRevokeLinkedPairByAccess(cleaned, expired, NOW)).toEqual({ state: cleaned, result: { kind: "expired" }, changed: false });
  });

  it("accepts only exact old rotation tombstones idempotently while next remains active", () => {
    const leased = applyBeginRefresh(applyActivatePair(undefined, OLD, NOW).state, OLD, NOW).state;
    const rotated = applyCompleteRefresh(leased, { old: OLD, next: NEXT }, NOW + 1).state;
    expect(applyRevokeLinkedPairByAccess(rotated, OLD, NOW + 2)).toEqual({ state: rotated, result: { kind: "revoked" }, changed: false });
    for (const wrong of [
      { ...OLD, accessExpiresAt: OLD.accessExpiresAt + 1 },
      { ...OLD, grantExpiresAt: OLD.grantExpiresAt + 1 },
      { ...OLD, accessTokenId: "Z".repeat(22) },
      { ...OLD, grantId: "Z".repeat(22) },
    ]) expect(applyRevokeLinkedPairByAccess(rotated, wrong, NOW + 2)).toEqual({ state: rotated, result: { kind: "mismatch" }, changed: false });
    const oneTombstone = { ...rotated, revokedGrants: {} };
    expect(applyRevokeLinkedPairByAccess(oneTombstone, OLD, NOW + 2)).toEqual({ state: oneTombstone, result: { kind: "mismatch" }, changed: false });
    expect(applyCheckAccess(rotated, NEXT, NOW + 2).result).toEqual({ kind: "active" });
  });

  it("uses an exact live old grant after its access tombstone is cleaned while next stays active", () => {
    const old = { ...OLD, accessExpiresAt: NOW };
    const leased = applyBeginRefresh(applyActivatePair(undefined, old, NOW - 1).state, old, NOW - 1).state;
    const rotated = applyCompleteRefresh(leased, { old, next: NEXT }, NOW).state;
    const cleaned = cleanVnuRefreshState(rotated, NOW + 1);
    expect(cleaned.revokedAccess).toEqual({});
    expect(cleaned.revokedGrants).toEqual({ [old.grantId]: old.grantExpiresAt });
    expect(applyRevokeLinkedPairByAccess(cleaned, old, NOW + 1)).toEqual({ state: cleaned, result: { kind: "revoked" }, changed: false });
    for (const wrong of [{ ...old, grantId: "Z".repeat(22) }, { ...old, grantExpiresAt: old.grantExpiresAt + 1 }]) {
      expect(applyRevokeLinkedPairByAccess(cleaned, wrong, NOW + 1)).toEqual({ state: cleaned, result: { kind: "mismatch" }, changed: false });
    }
    expect(applyRevokeLinkedPairByAccess(cleaned, { ...old, accessTokenId: "Z".repeat(22), accessExpiresAt: NOW + 2 }, NOW + 1)).toEqual({ state: cleaned, result: { kind: "mismatch" }, changed: false });
    expect(applyCheckAccess(cleaned, NEXT, NOW + 1).result).toEqual({ kind: "active" });
  });

  it("exact linked revoke and grantless revoke share exact boundaries", () => {
    const active = applyActivatePair(undefined, OLD, NOW).state;
    expect(applyRevokeExactLinkedPair(active, { ...OLD, grantId: "Z".repeat(22) }, NOW + 1)).toEqual({ state: active, result: { kind: "mismatch" }, changed: false });
    expect(applyRevokeExactLinkedPair(active, OLD, NOW + 1)).toMatchObject({ result: { kind: "revoked" }, changed: true });
    const expired = { ...OLD, accessExpiresAt: NOW, grantExpiresAt: NOW };
    expect(applyRevokeExactLinkedPair(undefined, expired, NOW)).toMatchObject({ result: { kind: "expired" }, changed: false });
  });

  it("retains active link and grant alarm after access expiry", () => {
    const pair = { ...OLD, accessExpiresAt: NOW + 1_000, grantExpiresAt: NOW + 2_000 };
    const stored: VnuRefreshControlState = { active: pair, revokedAccess: {}, revokedGrants: {}, window: { count: 0, resetAt: NOW + 3_000 } };
    expect(nextVnuRefreshAlarm(stored)).toBe(pair.grantExpiresAt);
    expect(applyCheckAccess(stored, pair, NOW + 1_000)).toEqual({ state: stored, result: { kind: "revoked" }, changed: false });
    expect(applyCheckAccess(stored, pair, NOW + 1_001)).toEqual({ state: stored, result: { kind: "revoked" }, changed: false });
    expect(cleanVnuRefreshState(stored, pair.grantExpiresAt).active).toBeUndefined();
  });
});

describe("VNU refresh coordinator", () => {
  const allMethods = (calls: unknown[]) => ({
    activatePair: async (pair: LinkedPair) => { calls.push(["activatePair", pair]); return { kind: "activated" as const }; },
    checkAccess: async (pair: LinkedPair) => { calls.push(["checkAccess", pair]); return { kind: "active" as const }; },
    beginRefresh: async (pair: LinkedPair) => { calls.push(["beginRefresh", pair]); return { kind: "accepted" as const, leaseExpiresAt: NOW }; },
    completeRefresh: async (input: { old: LinkedPair; next: LinkedPair }) => { calls.push(["completeRefresh", input]); return { kind: "completed" as const }; },
    abortRefresh: async (input: { pair: LinkedPair; terminal: boolean }) => { calls.push(["abortRefresh", input]); return { kind: "aborted" as const }; },
    revokeLinkedPairByAccess: async (pair: LinkedPair) => { calls.push(["revokeLinkedPairByAccess", pair]); return { kind: "revoked" as const }; },
    revokeExactLinkedPair: async (pair: LinkedPair) => { calls.push(["revokeExactLinkedPair", pair]); return { kind: "revoked" as const }; },
  }) satisfies VnuRefreshControlStub;

  it("derives a stable opaque lowercase principal", async () => {
    const secret = "synthetic-worker-secret-with-at-least-32-chars";
    const first = await deriveVnuRefreshPrincipal(" SYNTHETIC-VNU-USER ", secret);
    expect(first).toBe(await deriveVnuRefreshPrincipal("synthetic-vnu-user", secret));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain("synthetic");
  });

  it("uses exact RPC signatures and serializes no credential or identity", async () => {
    const calls: unknown[] = [];
    const getByName = vi.fn(() => allMethods(calls));
    const coordinator = new DurableObjectVnuRefreshControlCoordinator({ getByName });
    const principal = "a".repeat(64);
    await coordinator.activatePair(principal, OLD);
    await coordinator.checkAccess(principal, OLD);
    await coordinator.beginRefresh(principal, OLD);
    await coordinator.completeRefresh(principal, { old: OLD, next: NEXT });
    await coordinator.abortRefresh(principal, { pair: OLD, terminal: false });
    await coordinator.revokeLinkedPairByAccess(principal, OLD);
    await coordinator.revokeExactLinkedPair(principal, OLD);
    expect(getByName).toHaveBeenCalledTimes(7);
    expect(JSON.stringify(calls)).not.toMatch(/username|password|studentCode|cookie|raw.?token|SYNTHETIC-VNU-USER/i);
  });

  it.each(["invalid-principal", "namespace", "rpc"])("sanitizes %s failures exactly", async (failure) => {
    const namespace = failure === "namespace"
      ? { getByName() { throw new Error("SENTINEL_NAMESPACE"); } }
      : { getByName() { return { ...allMethods([]), activatePair: async () => { throw new Error("SENTINEL_RPC"); } }; } };
    const coordinator = new DurableObjectVnuRefreshControlCoordinator(namespace);
    await expect(coordinator.activatePair(failure === "invalid-principal" ? "SENTINEL" : "a".repeat(64), OLD)).rejects.toEqual(vnuRefreshUnavailable());
  });
});
