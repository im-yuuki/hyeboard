export type EffectiveVnuRuntimeConfig = {
  codeLookupConcurrency: number;
  crossLookupBulkMaxTargets: number;
};

export type VnuRuntimeConfigInput = {
  codeLookupConcurrency?: string;
  crossLookupBulkMaxTargets?: string;
};

export type VnuConfigWarning = (
  setting: "VNU_CODE_LOOKUP_CONCURRENCY" | "VNU_CROSS_LOOKUP_BULK_MAX_TARGETS",
  effectiveFallback: number,
) => void;

const CANONICAL_INTEGER = /^(?:0|[1-9]\d*)$/;

function parseSafeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !CANONICAL_INTEGER.test(value)) return undefined;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseVnuRuntimeConfig(input: VnuRuntimeConfigInput, warn?: VnuConfigWarning): EffectiveVnuRuntimeConfig {
  const parsedConcurrency = input.codeLookupConcurrency === undefined ? 16 : parseSafeInteger(input.codeLookupConcurrency);
  const parsedBulkMaximum = input.crossLookupBulkMaxTargets === undefined ? 50 : parseSafeInteger(input.crossLookupBulkMaxTargets);
  const codeLookupConcurrency = parsedConcurrency !== undefined && parsedConcurrency > 0 ? parsedConcurrency : 1;
  const crossLookupBulkMaxTargets = parsedBulkMaximum ?? 0;

  if (input.codeLookupConcurrency !== undefined && codeLookupConcurrency === 1 && input.codeLookupConcurrency !== "1") {
    warn?.("VNU_CODE_LOOKUP_CONCURRENCY", 1);
  }
  if (input.crossLookupBulkMaxTargets !== undefined && parsedBulkMaximum === undefined) {
    warn?.("VNU_CROSS_LOOKUP_BULK_MAX_TARGETS", 0);
  }

  return { codeLookupConcurrency, crossLookupBulkMaxTargets };
}

export function normalizeSelfHostedInteger(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return "";
}
