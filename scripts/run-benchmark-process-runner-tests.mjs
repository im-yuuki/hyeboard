import { spawnSync } from "node:child_process";
import process from "node:process";

if (process.env.HYEB_COMBINED_GATE === "1") {
  console.log("Benchmark lifecycle self-tests skipped inside their own measured run");
} else {
  const result = spawnSync(process.execPath, ["--test", "scripts/benchmark-process-runner.test.mjs"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
