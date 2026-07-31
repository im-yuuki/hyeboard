import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, watch, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installSignalAbortHandlers, runTrackedCommands, TrackedProcessRunner } from "./benchmark-process-runner.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/benchmark-child.mjs", import.meta.url));

async function createTestDirectory(name) {
  const directory = path.join(os.tmpdir(), `hyeboard-benchmark-${process.pid}-${name}`);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return directory;
}

async function readFixturePids(pidPath) {
  const watcher = watch(path.dirname(pidPath), { persistent: false });
  try {
    try {
      return JSON.parse(await readFile(pidPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for await (const event of watcher) {
      if (event.filename !== path.basename(pidPath)) continue;
      return JSON.parse(await readFile(pidPath, "utf8"));
    }
    throw new Error(`Fixture evidence watcher ended before ${pidPath} was ready`);
  } finally {
    await watcher.return();
  }
}

async function assertProcessExited(pid) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setImmediate(resolve));
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
  }
  assert.fail(`Process ${pid} remained alive after tracked cleanup`);
}

function fixtureCommand(name, mode, directory, pidPath) {
  return {
    name,
    command: process.execPath,
    args: [fixturePath, mode, ...(pidPath ? [pidPath] : [])],
    outputPath: path.join(directory, `${name}.log`),
  };
}

const silentOutput = { write() {} };

test("deadline terminates a tracked process tree", async () => {
  const directory = await createTestDirectory("deadline");
  const pidPath = path.join(directory, "pids.json");
  const runner = new TrackedProcessRunner();
  await assert.rejects(
    runTrackedCommands({
      commands: [fixtureCommand("slow", "spawn-descendant", directory, pidPath)],
      cwd: directory,
      environment: process.env,
      deadlineMs: 400,
      output: silentOutput,
      runner,
    }),
    /exceeded 400ms deadline/,
  );
  const pids = await readFixturePids(pidPath);
  await assertProcessExited(pids.root);
  await assertProcessExited(pids.descendant);
  assert.deepEqual(runner.activeProcessIds, []);
});

test("branch failure cancels its tracked sibling tree", async () => {
  const directory = await createTestDirectory("sibling");
  const pidPath = path.join(directory, "pids.json");
  const runner = new TrackedProcessRunner();
  await assert.rejects(
    runTrackedCommands({
      commands: [
        fixtureCommand("failure", "fail-after-evidence", directory, pidPath),
        fixtureCommand("sibling", "spawn-descendant", directory, pidPath),
      ],
      cwd: directory,
      environment: process.env,
      deadlineMs: 2_000,
      output: silentOutput,
      runner,
    }),
    /failure branch exited with code 23/,
  );
  const pids = await readFixturePids(pidPath);
  await assertProcessExited(pids.root);
  await assertProcessExited(pids.descendant);
  assert.deepEqual(runner.activeProcessIds, []);
});

test("missing executable rejects through cleanup and records sibling-tree failure evidence", async () => {
  const directory = await createTestDirectory("missing-executable");
  const pidPath = path.join(directory, "pids.json");
  const sibling = spawn(process.execPath, [fixturePath, "spawn-descendant", pidPath], {
    cwd: directory,
    detached: process.platform !== "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const pids = await readFixturePids(pidPath);
  let suppliedSibling = false;
  const runner = new TrackedProcessRunner({
    spawnProcess(command, args, options) {
      if (!suppliedSibling && command === process.execPath) {
        suppliedSibling = true;
        return sibling;
      }
      return spawn(command, args, options);
    },
  });
  const missingExecutable = `hyeboard-definitely-missing-${process.pid}.exe`;
  let failure;
  try {
    await runTrackedCommands({
      commands: [
        fixtureCommand("missing-sibling", "spawn-descendant", directory, pidPath),
        { name: "missing", command: missingExecutable, args: [], outputPath: path.join(directory, "missing.log") },
      ],
      cwd: directory,
      environment: process.env,
      deadlineMs: 2_000,
      output: silentOutput,
      runner,
    });
  } catch (error) {
    failure = error;
  }
  assert.match(failure?.message ?? "", /missing branch failed/);
  assert.match(failure?.message ?? "", /ENOENT/);
  assert.equal("missing" in failure.results, false);
  assert.equal("missing-sibling" in failure.results, true);
  await assertProcessExited(pids.root);
  await assertProcessExited(pids.descendant);
  assert.deepEqual(runner.activeProcessIds, []);

  const evidencePath = path.join(directory, "failure-evidence.json");
  await writeFile(evidencePath, JSON.stringify({ failure: failure.message, results: failure.results, trackedProcessIds: runner.activeProcessIds }));
  assert.deepEqual(JSON.parse(await readFile(evidencePath, "utf8")), {
    failure: failure.message,
    results: failure.results,
    trackedProcessIds: [],
  });
});

test("asynchronous log failure rejects the run and cancels its sibling", async () => {
  const directory = await createTestDirectory("log-failure");
  const pidPath = path.join(directory, "pids.json");
  const runner = new TrackedProcessRunner();
  await assert.rejects(
    runTrackedCommands({
      commands: [
        { ...fixtureCommand("broken-log", "fail-after-evidence", directory, pidPath), outputPath: directory },
        fixtureCommand("log-sibling", "spawn-descendant", directory, pidPath),
      ],
      cwd: directory,
      environment: process.env,
      deadlineMs: 2_000,
      output: silentOutput,
      runner,
    }),
    /broken-log branch failed/,
  );
  const pids = await readFixturePids(pidPath);
  await assertProcessExited(pids.root);
  await assertProcessExited(pids.descendant);
  assert.deepEqual(runner.activeProcessIds, []);
});

test("SIGTERM abort handler cancels and cleans tracked children", async () => {
  const directory = await createTestDirectory("signal");
  const pidPath = path.join(directory, "pids.json");
  const runner = new TrackedProcessRunner();
  const signalEmitter = new EventEmitter();
  const abortController = new AbortController();
  const removeSignalHandlers = installSignalAbortHandlers(signalEmitter, abortController);
  const run = runTrackedCommands({
    commands: [fixtureCommand("signalled", "spawn-descendant", directory, pidPath)],
    cwd: directory,
    environment: process.env,
    deadlineMs: 2_000,
    signal: abortController.signal,
    output: silentOutput,
    runner,
  });
  let pids;
  try {
    pids = await readFixturePids(pidPath);
    signalEmitter.emit("SIGTERM");
    await assert.rejects(run, /interrupted by SIGTERM/);
  } finally {
    if (!abortController.signal.aborted) signalEmitter.emit("SIGTERM");
    await run.catch(() => {});
    removeSignalHandlers();
  }
  await assertProcessExited(pids.root);
  await assertProcessExited(pids.descendant);
  assert.deepEqual(runner.activeProcessIds, []);
  assert.equal(signalEmitter.listenerCount("SIGINT"), 0);
  assert.equal(signalEmitter.listenerCount("SIGTERM"), 0);
});
