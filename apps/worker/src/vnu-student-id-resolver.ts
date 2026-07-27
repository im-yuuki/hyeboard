import { HyeboardError } from "@hyeboard/core";

const VERIFIED_NEAR_CODE_DELTA = 64;
const FAR_LINEAR_CORRECTION_CODE_DELTA = 10;
const NEAR_LINEAR_PROBE_LIMIT = 8;
const BISECTION_PROBE_LIMIT = 12;
const FAR_LINEAR_PROBE_LIMIT = 10;
const TOTAL_PROBE_LIMIT = 24;
const PROBE_DELAY_MS = 250;

// Bisection plus linear correction is the resolver's reachable hard maximum.
// Bulk budget reservations consume this declared amount per code target.
export const VNU_STUDENT_ID_RESOLVER_MAX_PROBES = BISECTION_PROBE_LIMIT + FAR_LINEAR_PROBE_LIMIT;

export type VnuStudentIdResolution = {
  stdId: string;
  stdCode: string;
  probes: number;
};

export type VnuStudentIdResolverOptions = {
  ownStdId: number;
  ownCode: number;
  targetCode: number;
  fetchStudentCode: (stdId: number) => Promise<string | undefined>;
  waitBetweenProbes?: () => Promise<void>;
  farWalkEnabled?: boolean;
};

type ProbeResult = { stdId: number; studentCode: number };

function notConverged(): HyeboardError {
  return new HyeboardError(
    "VNU_CROSS_LOOKUP_NOT_CONVERGED",
    "Could not resolve an internal student id for that code near your own cohort. The code-to-id mapping only holds within one cohort.",
    404,
  );
}

function defaultProbeDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PROBE_DELAY_MS));
}

function resolved(stdId: number, targetCode: number, probes: number): VnuStudentIdResolution {
  return {
    stdId: String(stdId).padStart(11, "0"),
    stdCode: String(targetCode).padStart(8, "0"),
    probes,
  };
}

export async function resolveVnuStudentId(options: VnuStudentIdResolverOptions): Promise<VnuStudentIdResolution> {
  const { ownStdId, ownCode, targetCode, fetchStudentCode } = options;
  const waitBetweenProbes = options.waitBetweenProbes ?? defaultProbeDelay;
  const visited = new Set<number>();
  let probeCount = 0;

  const probe = async (stdId: number): Promise<ProbeResult> => {
    if (!Number.isSafeInteger(stdId) || stdId <= 0 || visited.has(stdId) || probeCount >= TOTAL_PROBE_LIMIT) throw notConverged();
    if (probeCount > 0) await waitBetweenProbes();
    visited.add(stdId);
    probeCount += 1;
    const rawStudentCode = await fetchStudentCode(stdId);
    if (!rawStudentCode || !/^\d{8}$/.test(rawStudentCode)) throw notConverged();
    return { stdId, studentCode: Number(rawStudentCode) };
  };

  const runLinearCorrection = async (initialGuess: number, probeLimit: number): Promise<VnuStudentIdResolution> => {
    let guess = initialGuess;
    for (let stageProbes = 0; stageProbes < probeLimit; stageProbes += 1) {
      const result = await probe(guess);
      if (result.studentCode === targetCode) return resolved(result.stdId, targetCode, probeCount);
      guess = result.stdId + (targetCode - result.studentCode);
    }
    throw notConverged();
  };

  const codeDelta = targetCode - ownCode;
  const projectedStdId = ownStdId + codeDelta;
  if (Math.abs(codeDelta) <= VERIFIED_NEAR_CODE_DELTA) {
    return runLinearCorrection(projectedStdId, NEAR_LINEAR_PROBE_LIMIT);
  }

  if (options.farWalkEnabled !== true) throw notConverged();

  const direction = Math.sign(codeDelta);
  const margin = Math.ceil(Math.abs(codeDelta) * 0.02) + 64;
  let lowerStdId = direction > 0 ? ownStdId + 1 : projectedStdId - margin;
  let upperStdId = direction > 0 ? projectedStdId + margin : ownStdId - 1;
  let closest: ProbeResult | undefined;

  // Wide-span code(StdID) monotonicity is assumed here, not live-verified.
  // Callers must retain an explicit release gate around this path.
  for (let bisectionProbes = 0; bisectionProbes < BISECTION_PROBE_LIMIT && lowerStdId <= upperStdId; bisectionProbes += 1) {
    const midpoint = Math.floor((lowerStdId + upperStdId) / 2);
    const result = await probe(midpoint);
    if (!closest || Math.abs(targetCode - result.studentCode) < Math.abs(targetCode - closest.studentCode)) closest = result;
    if (result.studentCode === targetCode) return resolved(result.stdId, targetCode, probeCount);
    if (Math.abs(targetCode - result.studentCode) <= FAR_LINEAR_CORRECTION_CODE_DELTA) break;
    if (result.studentCode < targetCode) lowerStdId = midpoint + 1;
    else upperStdId = midpoint - 1;
  }

  if (!closest) throw notConverged();
  return runLinearCorrection(closest.stdId + (targetCode - closest.studentCode), FAR_LINEAR_PROBE_LIMIT);
}
