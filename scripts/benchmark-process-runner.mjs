import { spawn, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Tracked process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onClose = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("close", onClose);
    };
    child.once("close", onClose);
  });
}

async function terminateProcessTree(child, platform = process.platform) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

  if (platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    if (result.status === 0 || child.exitCode !== null || child.signalCode !== null) return;
    try {
      await waitForChildClose(child, 1_000);
    } catch {
      throw new Error(`Could not terminate tracked Windows process tree ${child.pid}: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  try {
    await waitForChildClose(child, 2_000);
    return;
  } catch {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

export class TrackedProcessRunner {
  #activeChildren = new Map();
  #spawnProcess;
  #terminateTree;
  #platform;

  constructor({ spawnProcess = spawn, terminateTree = terminateProcessTree, platform = process.platform } = {}) {
    this.#spawnProcess = spawnProcess;
    this.#terminateTree = terminateTree;
    this.#platform = platform;
  }

  get activeProcessIds() {
    return [...this.#activeChildren.keys()];
  }

  spawn(command, args, options, onSpawnError = () => {}) {
    const child = this.#spawnProcess(command, args, {
      ...options,
      detached: this.#platform !== "win32",
      shell: false,
      windowsHide: true,
    });
    child.once("error", onSpawnError);
    if (!child.pid) return child;

    this.#activeChildren.set(child.pid, child);
    child.once("close", () => this.#activeChildren.delete(child.pid));
    return child;
  }

  async terminateAll() {
    const trackedChildren = [...this.#activeChildren.values()];
    if (trackedChildren.length === 0) return;

    const terminationResults = await Promise.allSettled(trackedChildren.map(async (child) => {
      await this.#terminateTree(child, this.#platform);
      await waitForChildClose(child, 5_000);
    }));
    const failures = terminationResults.filter((result) => result.status === "rejected").map((result) => errorMessage(result.reason));
    if (failures.length) throw new AggregateError(failures.map((message) => new Error(message)), `Failed to terminate ${failures.length} tracked process tree(s)`);
  }
}

export function installSignalAbortHandlers(signalEmitter, abortController) {
  const handlers = new Map();
  for (const signalName of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (!abortController.signal.aborted) abortController.abort(new Error(`Benchmark interrupted by ${signalName}`));
    };
    handlers.set(signalName, handler);
    signalEmitter.once(signalName, handler);
  }
  return () => {
    for (const [signalName, handler] of handlers) signalEmitter.off(signalName, handler);
  };
}

function runCapturedCommand({ name, command, args, cwd, environment, outputPath, output }, runner) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    const chunks = [];

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`${name} branch failed: ${errorMessage(error)}`, { cause: error }));
    };
    const capture = (chunk) => {
      try {
        chunks.push(Buffer.from(chunk));
        output.write(`[${name}] ${chunk}`);
      } catch (error) {
        rejectOnce(error);
      }
    };

    try {
      child = runner.spawn(command, args, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] }, rejectOnce);
    } catch (error) {
      rejectOnce(error);
      return;
    }
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("close", async (exitCode, signal) => {
      try {
        await writeFile(outputPath, Buffer.concat(chunks));
        if (settled) return;
        settled = true;
        resolve({ exitCode, signal });
      } catch (error) {
        rejectOnce(error);
      }
    });
  });
}

function cancellationPromise(signal) {
  let removeAbortListener = () => {};
  const promise = new Promise((_, reject) => {
    const rejectForAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Benchmark cancelled")));
    if (signal.aborted) {
      rejectForAbort();
      return;
    }
    signal.addEventListener("abort", rejectForAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", rejectForAbort);
  });
  return { promise, removeAbortListener };
}

export async function runTrackedCommands({ commands, cwd, environment, deadlineMs, signal, output = process.stdout, runner = new TrackedProcessRunner() }) {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1) throw new Error("deadlineMs must be a positive integer");
  if (commands.length < 1) throw new Error("At least one command is required");

  const deadlineController = new AbortController();
  const deadline = setTimeout(() => deadlineController.abort(new Error(`Benchmark run exceeded ${deadlineMs}ms deadline`)), deadlineMs);
  const combinedSignal = signal ? AbortSignal.any([signal, deadlineController.signal]) : deadlineController.signal;
  const cancellation = cancellationPromise(combinedSignal);
  const results = {};
  const branches = commands.map(async (definition) => {
    const result = await runCapturedCommand({ ...definition, cwd, environment, output }, runner);
    results[definition.name] = result;
    if (result.exitCode !== 0) throw new Error(`${definition.name} branch exited with code ${result.exitCode} signal ${result.signal ?? "none"}`);
    return result;
  });

  try {
    await Promise.race([Promise.all(branches), cancellation.promise]);
    return results;
  } catch (error) {
    let cleanupError;
    try {
      await runner.terminateAll();
    } catch (candidate) {
      cleanupError = candidate;
    }
    await Promise.allSettled(branches);
    const message = cleanupError ? `${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}` : errorMessage(error);
    const failure = new Error(message, { cause: error });
    failure.results = results;
    throw failure;
  } finally {
    clearTimeout(deadline);
    cancellation.removeAbortListener();
  }
}
