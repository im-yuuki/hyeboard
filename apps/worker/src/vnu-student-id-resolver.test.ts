import { describe, expect, it, vi } from "vitest";
import { resolveVnuStudentId } from "./vnu-student-id-resolver";

const OWN_STD_ID = 100_000;
const OWN_CODE = 24_001_000;
const noWait = async () => undefined;

function codeForParallelMapping(stdId: number): string {
  return String(OWN_CODE + (stdId - OWN_STD_ID));
}

describe("resolveVnuStudentId", () => {
  it.each([
    ["lower", -60, -2],
    ["upper", 60, 2],
  ] as const)("corrects a verified-near %s target with far walking disabled", async (_label, codeDelta, correction) => {
    const targetCode = OWN_CODE + codeDelta;
    const projectedStdId = OWN_STD_ID + codeDelta;
    const exactStdId = projectedStdId + correction;
    const fetchStudentCode = vi.fn(async (stdId: number) => {
      if (stdId === projectedStdId) return String(targetCode - correction);
      if (stdId === exactStdId) return String(targetCode);
      return undefined;
    });

    const result = await resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: OWN_CODE,
      targetCode,
      farWalkEnabled: false,
      fetchStudentCode,
      waitBetweenProbes: noWait,
    });

    expect(result).toEqual({
      stdId: String(exactStdId).padStart(11, "0"),
      stdCode: String(targetCode),
      probes: 2,
    });
    expect(fetchStudentCode.mock.calls.map(([stdId]) => stdId)).toEqual([projectedStdId, exactStdId]);
  });

  it.each([
    ["lower", -64],
    ["upper", 64],
  ] as const)("includes the verified-near %s boundary with far walking disabled", async (_label, codeDelta) => {
    const targetCode = OWN_CODE + codeDelta;
    const expectedStdId = OWN_STD_ID + codeDelta;
    const fetchStudentCode = vi.fn(async (stdId: number) => codeForParallelMapping(stdId));

    const result = await resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: OWN_CODE,
      targetCode,
      farWalkEnabled: false,
      fetchStudentCode,
      waitBetweenProbes: noWait,
    });

    expect(result).toEqual({
      stdId: String(expectedStdId).padStart(11, "0"),
      stdCode: String(targetCode),
      probes: 1,
    });
    expect(fetchStudentCode).toHaveBeenCalledOnce();
  });

  it.each([
    ["lower", -65],
    ["upper", 65],
  ] as const)("rejects the %s target beyond the verified-near boundary before fetching", async (_label, codeDelta) => {
    const fetchStudentCode = vi.fn(async (stdId: number) => codeForParallelMapping(stdId));

    await expect(resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: OWN_CODE,
      targetCode: OWN_CODE + codeDelta,
      farWalkEnabled: false,
      fetchStudentCode,
      waitBetweenProbes: noWait,
    })).rejects.toMatchObject({ code: "VNU_CROSS_LOOKUP_NOT_CONVERGED", status: 404 });
    expect(fetchStudentCode).not.toHaveBeenCalled();
  });

  it("refines a near target with at most eight probes", async () => {
    const targetCode = OWN_CODE + 5;
    const fetchStudentCode = vi.fn(async (stdId: number) => {
      if (stdId === OWN_STD_ID + 5) return String(targetCode - 1);
      return String(targetCode);
    });

    const result = await resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: OWN_CODE,
      targetCode,
      farWalkEnabled: true,
      fetchStudentCode,
      waitBetweenProbes: noWait,
    });

    expect(result).toEqual({ stdId: "00000100006", stdCode: String(targetCode), probes: 2 });
    expect(fetchStudentCode).toHaveBeenCalledTimes(2);
  });

  it("bisects a far target before linear correction", async () => {
    const targetCode = OWN_CODE + 1_000;
    const fetchStudentCode = vi.fn(async (stdId: number) => codeForParallelMapping(stdId));

    const result = await resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: OWN_CODE,
      targetCode,
      farWalkEnabled: true,
      fetchStudentCode,
      waitBetweenProbes: noWait,
    });

    expect(result.stdId).toBe("00000101000");
    expect(result.stdCode).toBe(String(targetCode));
    expect(result.probes).toBeLessThanOrEqual(22);
  });

  it("mirrors the bisection interval for a lower target", async () => {
    const targetCode = OWN_CODE - 1_000;
    const probedIds: number[] = [];

    const result = await resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: OWN_CODE,
      targetCode,
      farWalkEnabled: true,
      fetchStudentCode: async (stdId) => {
        probedIds.push(stdId);
        return codeForParallelMapping(stdId);
      },
      waitBetweenProbes: noWait,
    });

    expect(result.stdId).toBe("00000099000");
    expect(probedIds.every((stdId) => stdId < OWN_STD_ID)).toBe(true);
  });

  it.each([
    ["upper", 1, "00000100991"],
    ["lower", -1, "00000099009"],
  ] as const)("transitions from %s bisection to linear correction under drift", async (_label, direction, expectedStdId) => {
    const targetCode = OWN_CODE + direction * 1_000;
    const probedIds: number[] = [];
    const waitBetweenProbes = vi.fn(noWait);

    const result = await resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: OWN_CODE,
      targetCode,
      farWalkEnabled: true,
      fetchStudentCode: async (stdId) => {
        probedIds.push(stdId);
        const stdIdDelta = stdId - OWN_STD_ID;
        const drift = Math.sign(stdIdDelta) * Math.floor(Math.abs(stdIdDelta) / 100);
        return String(OWN_CODE + stdIdDelta + drift);
      },
      waitBetweenProbes,
    });

    expect(result.stdId).toBe(expectedStdId);
    expect(probedIds.length).toBeGreaterThan(1);
    expect(probedIds.at(-1)).toBe(Number(expectedStdId));
    expect(waitBetweenProbes).toHaveBeenCalledTimes(probedIds.length - 1);
  });

  it("caps a worst-case far walk at 22 unique probes with one delay between each fetch", async () => {
    const targetCode = OWN_CODE + 100_000;
    const probedIds: number[] = [];
    const waitBetweenProbes = vi.fn(noWait);

    await expect(resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: OWN_CODE,
      targetCode,
      farWalkEnabled: true,
      fetchStudentCode: async (stdId) => {
        probedIds.push(stdId);
        const linearProbeNumber = Math.max(1, probedIds.length - 12);
        return String(targetCode - (probedIds.length <= 12 ? 100 : linearProbeNumber));
      },
      waitBetweenProbes,
    })).rejects.toMatchObject({ code: "VNU_CROSS_LOOKUP_NOT_CONVERGED", status: 404 });

    expect(probedIds).toHaveLength(22);
    expect(new Set(probedIds).size).toBe(22);
    expect(probedIds.length).toBeLessThanOrEqual(24);
    expect(waitBetweenProbes).toHaveBeenCalledTimes(21);
  });

  it("fails immediately when an oracle header is malformed", async () => {
    const fetchStudentCode = vi.fn(async () => undefined);

    await expect(resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: OWN_CODE,
      targetCode: OWN_CODE + 1,
      fetchStudentCode,
      waitBetweenProbes: noWait,
    })).rejects.toMatchObject({ code: "VNU_CROSS_LOOKUP_NOT_CONVERGED", status: 404 });
    expect(fetchStudentCode).toHaveBeenCalledTimes(1);
  });

  it("disables far walking by default before any oracle probe", async () => {
    const fetchStudentCode = vi.fn(async (stdId: number) => codeForParallelMapping(stdId));

    await expect(resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: OWN_CODE,
      targetCode: OWN_CODE + 65,
      fetchStudentCode,
      waitBetweenProbes: noWait,
    })).rejects.toMatchObject({ code: "VNU_CROSS_LOOKUP_NOT_CONVERGED", status: 404 });
    expect(fetchStudentCode).not.toHaveBeenCalled();
  });

  it("detects linear-correction oscillation", async () => {
    const targetCode = OWN_CODE + 5;
    const fetchStudentCode = vi.fn(async (stdId: number) => {
      if (stdId === OWN_STD_ID + 5) return String(targetCode - 1);
      return String(targetCode + 1);
    });

    await expect(resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: OWN_CODE,
      targetCode,
      fetchStudentCode,
      waitBetweenProbes: noWait,
    })).rejects.toMatchObject({ code: "VNU_CROSS_LOOKUP_NOT_CONVERGED", status: 404 });
    expect(fetchStudentCode).toHaveBeenCalledTimes(2);
  });

  it("stops near-target correction at its eight-probe bound", async () => {
    const targetCode = OWN_CODE + 64;
    const fetchStudentCode = vi.fn(async (stdId: number) => String(targetCode - (stdId - (OWN_STD_ID + 9)) - 1));

    await expect(resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: OWN_CODE,
      targetCode,
      fetchStudentCode,
      waitBetweenProbes: noWait,
    })).rejects.toMatchObject({ code: "VNU_CROSS_LOOKUP_NOT_CONVERGED", status: 404 });
    expect(fetchStudentCode.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it("never returns an approximate student id without an exact header match", async () => {
    const targetCode = OWN_CODE + 60;
    const fetchStudentCode = vi.fn(async () => String(targetCode - 1));

    await expect(resolveVnuStudentId({
      ownStdId: OWN_STD_ID,
      ownCode: OWN_CODE,
      targetCode,
      farWalkEnabled: false,
      fetchStudentCode,
      waitBetweenProbes: noWait,
    })).rejects.toMatchObject({ code: "VNU_CROSS_LOOKUP_NOT_CONVERGED", status: 404 });
    expect(fetchStudentCode).toHaveBeenCalledTimes(8);
  });
});
