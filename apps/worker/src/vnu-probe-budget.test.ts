import { describe, expect, it } from "vitest";
import {
  DurableObjectVnuProbeBudgetCoordinator,
  VNU_PROBE_BUDGET_LIMIT,
  VNU_PROBE_BUDGET_WINDOW_SECONDS,
} from "./vnu-probe-budget";

const SESSION_IDENTITY = "a".repeat(64);

describe("VNU probe-budget coordinators", () => {
  const stub = (operation: () => Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>) => ({
    consume: operation,
    reserve: operation,
  });

  it("maps confirmed Durable Object exhaustion to rate-limit semantics", async () => {
    const budget = new DurableObjectVnuProbeBudgetCoordinator({
      getByName: () => stub(async () => ({ allowed: false, retryAfterSeconds: VNU_PROBE_BUDGET_WINDOW_SECONDS })),
    });

    await expect(budget.consume(SESSION_IDENTITY)).rejects.toMatchObject({
      code: "VNU_RATE_LIMITED",
      status: 429,
      details: {
        retryAfterSeconds: VNU_PROBE_BUDGET_WINDOW_SECONDS,
        limit: VNU_PROBE_BUDGET_LIMIT,
        windowSeconds: VNU_PROBE_BUDGET_WINDOW_SECONDS,
      },
    });
  });

  it("maps Durable Object failure to unavailable rather than exhaustion", async () => {
    const budget = new DurableObjectVnuProbeBudgetCoordinator({
      getByName: () => stub(async () => { throw new Error("unavailable"); }),
    });

    await expect(budget.consume(SESSION_IDENTITY)).rejects.toMatchObject({
      code: "VNU_PROBE_BUDGET_UNAVAILABLE",
      status: 503,
      details: { retryAfterSeconds: 5 },
    });
  });

  it("uses only the opaque HMAC identity as the Durable Object name", async () => {
    const names: string[] = [];
    const budget = new DurableObjectVnuProbeBudgetCoordinator({
      getByName: (name) => {
        names.push(name);
        return stub(async () => ({ allowed: true }));
      },
    });

    await budget.consume(SESSION_IDENTITY);

    expect(names).toEqual([SESSION_IDENTITY]);
  });

  it("uses one reserve RPC for a whole bulk allowance", async () => {
    const amounts: number[] = [];
    const budget = new DurableObjectVnuProbeBudgetCoordinator({
      getByName: () => ({
        consume: async () => ({ allowed: true }),
        reserve: async (amount) => { amounts.push(amount); return { allowed: true }; },
      }),
    });

    await budget.reserve(SESSION_IDENTITY, 66);

    expect(amounts).toEqual([66]);
  });
});
