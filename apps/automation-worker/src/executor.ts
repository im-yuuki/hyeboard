import type { UetImportJob } from "@hyeboard/automation-protocol";
import type { CancellationToken } from "./cancellation";
import type { BrowserConnection } from "./provider";

export type AutomationProgressPhase = "queue" | "login" | "captcha" | "import" | "finalize";

export type AutomationExecutionContext<TCredential> = {
  job: UetImportJob;
  credential: TCredential;
  browser: BrowserConnection;
  cancellation: CancellationToken;
  progress(phase: AutomationProgressPhase, percent: number): Promise<void>;
};

export interface AutomationExecutor<TCredential, TResult> {
  execute(context: AutomationExecutionContext<TCredential>): Promise<TResult>;
}
