import { runAutomationWorker } from "./main";

runAutomationWorker().catch(() => {
  process.exitCode = 1;
});
