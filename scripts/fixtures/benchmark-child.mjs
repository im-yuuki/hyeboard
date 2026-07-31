import { spawn } from "node:child_process";
import { readFile, rename, watch, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const [mode, pidPath] = process.argv.slice(2);

async function waitForEvidence(evidencePath) {
  const watcher = watch(path.dirname(evidencePath));
  try {
    try {
      await readFile(evidencePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for await (const event of watcher) {
      if (event.filename !== path.basename(evidencePath)) continue;
      await readFile(evidencePath);
      return;
    }
    throw new Error(`Evidence watcher ended before ${evidencePath} was ready`);
  } finally {
    await watcher.return();
  }
}

async function writeAtomicJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value));
  await rename(temporaryPath, filePath);
}

if (mode === "fail") {
  process.exit(23);
} else if (mode === "fail-after-evidence") {
  await waitForEvidence(pidPath);
  process.exit(23);
} else if (mode === "wait") {
  setInterval(() => {}, 1_000);
} else if (mode === "spawn-descendant") {
  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), "wait"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await writeAtomicJson(pidPath, { root: process.pid, descendant: descendant.pid });
  setInterval(() => {}, 1_000);
} else {
  throw new Error(`Unknown fixture mode: ${mode}`);
}
