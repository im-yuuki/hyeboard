import { DurableObject } from "cloudflare:workers";
import {
  VNU_PROBE_BUDGET_LIMIT,
  VNU_PROBE_BUDGET_WINDOW_SECONDS,
  type VnuProbeBudgetResult,
} from "./vnu-probe-budget";

const STATE_KEY = "window";

export type StoredBudgetWindow = {
  count: number;
  resetAt: number;
};

export type BudgetWindowTransition = {
  window: StoredBudgetWindow;
  result: VnuProbeBudgetResult;
};

function parseStoredWindow(value: unknown): StoredBudgetWindow | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Stored VNU probe budget is invalid");
  const window = value as Record<string, unknown>;
  if (!Number.isSafeInteger(window.count) || (window.count as number) < 0) throw new Error("Stored VNU probe count is invalid");
  if (!Number.isSafeInteger(window.resetAt) || (window.resetAt as number) <= 0) throw new Error("Stored VNU probe reset time is invalid");
  return { count: window.count as number, resetAt: window.resetAt as number };
}

export function consumeBudgetWindow(
  stored: StoredBudgetWindow | undefined,
  amount: number,
  now: number,
): BudgetWindowTransition {
  const window = !stored || now >= stored.resetAt
    ? { count: 0, resetAt: now + VNU_PROBE_BUDGET_WINDOW_SECONDS * 1000 }
    : stored;

  if (window.count + amount > VNU_PROBE_BUDGET_LIMIT) {
    return {
      window,
      result: { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) },
    };
  }

  return {
    window: { ...window, count: window.count + amount },
    result: { allowed: true },
  };
}

export class VnuProbeBudgetDurableObject extends DurableObject<Env> {
  async consume(amount: number): Promise<VnuProbeBudgetResult> {
    return this.reserve(amount);
  }

  // Bulk callers reserve their full conservative allowance in one storage
  // transaction before touching Brc1. Unused units intentionally remain spent:
  // strict preflight atomicity is more important than maximizing the window.
  async reserve(amount: number): Promise<VnuProbeBudgetResult> {
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > VNU_PROBE_BUDGET_LIMIT) {
      throw new Error("VNU probe-budget amount is invalid");
    }

    return this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now();
      const stored = parseStoredWindow(await transaction.get(STATE_KEY));
      const transition = consumeBudgetWindow(stored, amount, now);
      if (!transition.result.allowed) return transition.result;

      await transaction.put(STATE_KEY, transition.window);
      return transition.result;
    });
  }
}
