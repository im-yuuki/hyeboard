import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { consumeBudgetWindow, type VnuProbeBudgetDurableObject } from "../src/vnu-probe-budget-durable-object";
import { VNU_PROBE_BUDGET_LIMIT, VNU_PROBE_BUDGET_WINDOW_SECONDS } from "../src/vnu-probe-budget";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    VNU_PROBE_BUDGET: Env["VNU_PROBE_BUDGET"];
  }
}

afterEach(() => reset());

describe("VnuProbeBudgetDurableObject", () => {
  it("authoritatively rejects concurrent consumption beyond the fixed-window limit", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("a".repeat(64));
    const results = await Promise.all(
      Array.from({ length: VNU_PROBE_BUDGET_LIMIT + 1 }, () => stub.consume(1)),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(VNU_PROBE_BUDGET_LIMIT);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
  });

  it("atomically accepts or rejects whole concurrent reservations", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("c".repeat(64));
    const results = await Promise.all(Array.from({ length: 5 }, () => stub.reserve(66)));

    expect(results.filter((result) => result.allowed)).toHaveLength(4);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    const entries = await runInDurableObject(stub, async (_instance: VnuProbeBudgetDurableObject, state) => [...await state.storage.list()]);
    expect(entries[0]?.[1]).toEqual({ count: 264, resetAt: expect.any(Number) });
  });

  it("stores only count and resetAt under a constant key", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("b".repeat(64));
    await stub.consume(1);

    const entries = await runInDurableObject(stub, async (_instance: VnuProbeBudgetDurableObject, state) => {
      return [...await state.storage.list()];
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toBe("window");
    expect(entries[0]?.[1]).toEqual({ count: 1, resetAt: expect.any(Number) });
    expect(JSON.stringify(entries)).not.toContain("cookie");
    expect(JSON.stringify(entries)).not.toMatch(/20000001|00000001002/);
  });

  it("uses exact fixed-window boundaries with deterministic time", () => {
    const firstNow = 1_000_000;
    const expectedFirstResetAt = firstNow + VNU_PROBE_BUDGET_WINDOW_SECONDS * 1000;

    const first = consumeBudgetWindow(undefined, 1, firstNow);
    expect(first).toEqual({ window: { count: 1, resetAt: expectedFirstResetAt }, result: { allowed: true } });

    const full = consumeBudgetWindow(first.window, VNU_PROBE_BUDGET_LIMIT - 1, firstNow);
    expect(full).toEqual({ window: { count: VNU_PROBE_BUDGET_LIMIT, resetAt: expectedFirstResetAt }, result: { allowed: true } });

    const rejected301st = consumeBudgetWindow(full.window, 1, firstNow);
    expect(rejected301st).toEqual({
      window: full.window,
      result: { allowed: false, retryAfterSeconds: VNU_PROBE_BUDGET_WINDOW_SECONDS },
    });

    const rejectedBeforeReset = consumeBudgetWindow(full.window, 1, expectedFirstResetAt - 1);
    expect(rejectedBeforeReset).toEqual({
      window: full.window,
      result: { allowed: false, retryAfterSeconds: 1 },
    });

    const reset = consumeBudgetWindow(full.window, 1, expectedFirstResetAt);
    expect(reset).toEqual({
      window: {
        count: 1,
        resetAt: expectedFirstResetAt + VNU_PROBE_BUDGET_WINDOW_SECONDS * 1000,
      },
      result: { allowed: true },
    });
  });
});
