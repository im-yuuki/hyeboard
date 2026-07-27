import { describe, expect, it } from "vitest";
import { appendBulkLookupChunk, chunkBulkTargets, deriveBulkLookupViewState, executeBulkLookup, parseBulkTargets } from "./bulk-lookup";
import type { VnuBulkLookupItem } from "./api";

describe("bulk lookup input", () => {
  it("trims and deduplicates targets while preserving first occurrence", () => {
    expect(parseBulkTargets(" 12\n34\n12\n\n 34 \n56")).toEqual({ targets: ["12", "34", "56"] });
  });

  it("rejects more than 50 unique targets", () => {
    const input = Array.from({ length: 51 }, (_, index) => String(index + 1)).join("\n");
    expect(parseBulkTargets(input).error).toBe("tooMany");
  });

  it("preserves malformed targets for per-item server isolation", () => {
    expect(parseBulkTargets("1001\nmalformed\n1002")).toEqual({ targets: ["1001", "malformed", "1002"] });
  });

  it("chunks code mode by three and other modes by five", () => {
    const targets = ["1", "2", "3", "4", "5", "6", "7"];
    expect(chunkBulkTargets("code-to-stdid", targets)).toEqual([["1", "2", "3"], ["4", "5", "6"], ["7"]]);
    expect(chunkBulkTargets("stdid-to-code", targets)).toEqual([["1", "2", "3", "4", "5"], ["6", "7"]]);
  });
});

describe("bulk lookup progress", () => {
  it("aggregates chunks in response order and advances processed count", () => {
    const first = appendBulkLookupChunk({ processed: 0, total: 3, items: [] }, [
      { target: "1", status: "error", errorCode: "NOT_FOUND" },
      { target: "2", status: "ok", result: { studentCode: "20000002" } },
    ]);
    const complete = appendBulkLookupChunk(first, [{ target: "3", status: "error", errorCode: "INVALID" }]);

    expect(complete.processed).toBe(3);
    expect(complete.items.map((item) => item.target)).toEqual(["1", "2", "3"]);
    expect(deriveBulkLookupViewState({ targets: ["1", "2", "3"] }, false, complete.processed)).toBe("completed");
  });

  it("executes chunks strictly sequentially", async () => {
    let activeCalls = 0;
    const callOrder: string[] = [];
    const controller = new AbortController();
    const execution = await executeBulkLookup({
      mode: "stdid-to-code",
      targets: ["1", "2", "3", "4", "5", "6"],
      signal: controller.signal,
      requestChunk: async (_mode, targets) => {
        activeCalls += 1;
        expect(activeCalls).toBe(1);
        callOrder.push(targets.join(","));
        await Promise.resolve();
        activeCalls -= 1;
        return targets.map((target) => ({ target, status: "ok", result: { studentCode: target.padStart(8, "0") } }));
      },
    });

    expect(callOrder).toEqual(["1,2,3,4,5", "6"]);
    expect(execution.progress.processed).toBe(6);
    expect(execution.remainingTargets).toEqual([]);
  });

  it("stops before later chunks when aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const execution = await executeBulkLookup({
      mode: "stdid-to-code",
      targets: ["1", "2", "3", "4", "5", "6"],
      signal: controller.signal,
      requestChunk: async (_mode, targets) => {
        calls += 1;
        controller.abort();
        return targets.map((target) => ({ target, status: "ok", result: { studentCode: "20000001" } }));
      },
    });

    expect(calls).toBe(1);
    expect(execution.aborted).toBe(true);
    expect(execution.progress.items).toEqual([]);
    expect(execution.remainingTargets).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it.each([429, 503])("keeps prior results and coherent retry state after a later %s", async (status) => {
    const targets = ["1", "2", "3", "4", "5", "6"];
    const controller = new AbortController();
    const requestError = Object.assign(new Error("synthetic request failure"), { status });
    let calls = 0;
    const firstRun = await executeBulkLookup({
      mode: "stdid-to-code",
      targets,
      signal: controller.signal,
      requestChunk: async (_mode, chunk) => {
        calls += 1;
        if (calls === 2) throw requestError;
        return chunk.map((target) => ({ target, status: "ok", result: { studentCode: target.padStart(8, "0") } }));
      },
    });

    expect(firstRun.progress.items.map((item) => item.target)).toEqual(["1", "2", "3", "4", "5"]);
    expect(firstRun.remainingTargets).toEqual(["6"]);
    expect(firstRun.error).toBe(requestError);

    const retry = await executeBulkLookup({
      mode: "stdid-to-code",
      targets: firstRun.remainingTargets,
      signal: new AbortController().signal,
      initialProgress: firstRun.progress,
      requestChunk: async (_mode, chunk) => chunk.map((target) => ({ target, status: "ok", result: { studentCode: "20000006" } })),
    });
    expect(retry.progress.items.map((item) => item.target)).toEqual(targets);
    expect(retry.progress.processed).toBe(6);
    expect(retry.progress.total).toBe(6);
    expect(retry.remainingTargets).toEqual([]);
  });

  it("preserves mixed malformed, self, not-found, and successful outcomes in order", async () => {
    const targets = parseBulkTargets("bad\n1000\n1001\n1002").targets;
    const items: VnuBulkLookupItem[] = [
      { target: "bad", status: "error", errorCode: "VNU_CROSS_LOOKUP_INVALID_TARGET" },
      { target: "1000", status: "error", errorCode: "VNU_CROSS_LOOKUP_SELF_TARGET" },
      { target: "1001", status: "error", errorCode: "VNU_CROSS_LOOKUP_NOT_FOUND" },
      { target: "1002", status: "ok", result: { studentCode: "20000002" } },
    ];
    const execution = await executeBulkLookup({
      mode: "stdid-to-code",
      targets,
      signal: new AbortController().signal,
      requestChunk: async () => items,
    });

    expect(execution.progress.items).toEqual(items);
    expect(execution.progress.items.map((item) => item.target)).toEqual(targets);
  });
});
