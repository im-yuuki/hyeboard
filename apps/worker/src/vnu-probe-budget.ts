import { HyeboardError } from "@hyeboard/core";

export const VNU_PROBE_BUDGET_LIMIT = 300;
export const VNU_PROBE_BUDGET_WINDOW_SECONDS = 600;
export const VNU_PROBE_BUDGET_UNAVAILABLE_RETRY_SECONDS = 5;

export type VnuProbeBudgetResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export interface VnuProbeBudgetCoordinator {
  consume(sessionIdentity: string, amount?: number): Promise<void>;
  reserve(sessionIdentity: string, amount: number): Promise<void>;
}

export interface VnuProbeBudgetDurableObjectStub {
  consume(amount: number): Promise<VnuProbeBudgetResult>;
  reserve(amount: number): Promise<VnuProbeBudgetResult>;
}

export interface VnuProbeBudgetNamespace {
  getByName(name: string): VnuProbeBudgetDurableObjectStub;
}

function assertValidConsumeAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > VNU_PROBE_BUDGET_LIMIT) {
    throw new Error("VNU probe-budget amount is invalid");
  }
}

function rateLimited(retryAfterSeconds: number): HyeboardError {
  return new HyeboardError(
    "VNU_RATE_LIMITED",
    "This session has reached the VNU lookup probe limit. Wait for the probe window to reset and try again.",
    429,
    {
      retryAfterSeconds,
      limit: VNU_PROBE_BUDGET_LIMIT,
      windowSeconds: VNU_PROBE_BUDGET_WINDOW_SECONDS,
    },
  );
}

export function probeBudgetUnavailable(): HyeboardError {
  return new HyeboardError(
    "VNU_PROBE_BUDGET_UNAVAILABLE",
    "The VNU lookup probe budget is temporarily unavailable. Try again shortly.",
    503,
    { retryAfterSeconds: VNU_PROBE_BUDGET_UNAVAILABLE_RETRY_SECONDS },
  );
}

export class DurableObjectVnuProbeBudgetCoordinator implements VnuProbeBudgetCoordinator {
  constructor(private readonly namespace: VnuProbeBudgetNamespace) {}

  async consume(sessionIdentity: string, amount = 1): Promise<void> {
    await this.charge("consume", sessionIdentity, amount);
  }

  async reserve(sessionIdentity: string, amount: number): Promise<void> {
    await this.charge("reserve", sessionIdentity, amount);
  }

  private async charge(operation: "consume" | "reserve", sessionIdentity: string, amount: number): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(sessionIdentity)) throw new Error("VNU probe-budget session identity is invalid");
    assertValidConsumeAmount(amount);

    let result: VnuProbeBudgetResult;
    try {
      result = await this.namespace.getByName(sessionIdentity)[operation](amount);
    } catch {
      throw probeBudgetUnavailable();
    }

    if (!result.allowed) throw rateLimited(result.retryAfterSeconds);
  }
}
