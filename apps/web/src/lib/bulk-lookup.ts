import type { VnuBulkLookupItem, VnuBulkLookupMode } from "./api";

export type BulkTargetError = "empty" | "tooMany";

export type ParsedBulkTargets = {
  targets: string[];
  error?: BulkTargetError;
};

export type BulkLookupProgress = {
  processed: number;
  total: number;
  items: VnuBulkLookupItem[];
};

export type BulkLookupViewState = "empty" | "validation" | "loading" | "completed";

export type BulkLookupExecution = {
  progress: BulkLookupProgress;
  remainingTargets: string[];
  error?: unknown;
  aborted: boolean;
};

export type ExecuteBulkLookupOptions = {
  mode: VnuBulkLookupMode;
  targets: readonly string[];
  signal: AbortSignal;
  initialProgress?: BulkLookupProgress;
  requestChunk: (mode: VnuBulkLookupMode, targets: string[], signal: AbortSignal) => Promise<VnuBulkLookupItem[]>;
  onProgress?: (progress: BulkLookupProgress) => void;
};

export function parseBulkTargets(raw: string): ParsedBulkTargets {
  const targets = [...new Set(raw.split(/\r?\n/).map((target) => target.trim()).filter(Boolean))];
  if (targets.length === 0) return { targets, error: "empty" };
  if (targets.length > 50) return { targets, error: "tooMany" };
  return { targets };
}

export function chunkBulkTargets(mode: VnuBulkLookupMode, targets: readonly string[]): string[][] {
  const size = mode === "code-to-stdid" ? 3 : 5;
  const chunks: string[][] = [];
  for (let index = 0; index < targets.length; index += size) chunks.push(targets.slice(index, index + size));
  return chunks;
}

export function appendBulkLookupChunk(progress: BulkLookupProgress, items: VnuBulkLookupItem[]): BulkLookupProgress {
  const combinedItems = [...progress.items, ...items];
  return { ...progress, processed: Math.min(progress.total, combinedItems.length), items: combinedItems };
}

export async function executeBulkLookup(options: ExecuteBulkLookupOptions): Promise<BulkLookupExecution> {
  const initialProgress = options.initialProgress ?? { processed: 0, total: options.targets.length, items: [] };
  let progress = initialProgress;
  let completedTargets = 0;

  for (const chunk of chunkBulkTargets(options.mode, options.targets)) {
    if (options.signal.aborted) return { progress, remainingTargets: options.targets.slice(completedTargets), aborted: true };

    let items: VnuBulkLookupItem[];
    try {
      items = await options.requestChunk(options.mode, chunk, options.signal);
    } catch (error) {
      return {
        progress,
        remainingTargets: options.targets.slice(completedTargets),
        error: options.signal.aborted ? undefined : error,
        aborted: options.signal.aborted,
      };
    }

    if (options.signal.aborted) return { progress, remainingTargets: options.targets.slice(completedTargets), aborted: true };
    if (items.length !== chunk.length) {
      return {
        progress,
        remainingTargets: options.targets.slice(completedTargets),
        error: new Error("Bulk lookup chunk returned an unexpected item count"),
        aborted: false,
      };
    }

    progress = appendBulkLookupChunk(progress, items);
    completedTargets += chunk.length;
    options.onProgress?.(progress);
  }

  return { progress, remainingTargets: [], aborted: false };
}

export function deriveBulkLookupViewState(input: ParsedBulkTargets, active: boolean, processed: number): BulkLookupViewState {
  if (active) return "loading";
  if (input.error === "empty" && processed === 0) return "empty";
  if (input.error) return "validation";
  return processed > 0 ? "completed" : "empty";
}
