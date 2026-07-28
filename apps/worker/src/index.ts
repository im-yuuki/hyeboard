import { configureLogger } from "@hyeboard/core";
import { env } from "cloudflare:workers";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { createApp, setCaptchaRelayCoordinator, setCloudflareBrowserBinding, setRuntimeConfig, setVnuProbeBudgetCoordinator, setVnuRefreshControlCoordinator } from "./app";
import { DurableObjectCaptchaRelayCoordinator } from "./captcha-relay-cloudflare";
import { DurableObjectVnuProbeBudgetCoordinator } from "./vnu-probe-budget";
import { DurableObjectVnuRefreshControlCoordinator } from "./vnu-refresh-control";

export { CaptchaRelayDurableObject } from "./captcha-relay-durable-object";
export { VnuProbeBudgetDurableObject } from "./vnu-probe-budget-durable-object";
export { VnuRefreshControlDurableObject } from "./vnu-refresh-control-durable-object";

const cfEnv = env;

configureLogger({ level: cfEnv.HYEB_LOG_LEVEL, mode: "browser" });
setRuntimeConfig({
  HYEB_SESSION_SECRET: cfEnv.HYEB_SESSION_SECRET,
  HYEB_ALLOWED_ORIGINS: cfEnv.HYEB_ALLOWED_ORIGINS,
  HYEB_BROWSER_WS_ENDPOINT: cfEnv.HYEB_BROWSER_WS_ENDPOINT,
  HYEB_LOG_LEVEL: cfEnv.HYEB_LOG_LEVEL,
  VNU_CODE_LOOKUP_CONCURRENCY: cfEnv.VNU_CODE_LOOKUP_CONCURRENCY,
  VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: cfEnv.VNU_CROSS_LOOKUP_BULK_MAX_TARGETS,
});
setCloudflareBrowserBinding(cfEnv.BROWSER);
setCaptchaRelayCoordinator(new DurableObjectCaptchaRelayCoordinator(cfEnv.CAPTCHA_RELAY));
setVnuProbeBudgetCoordinator(new DurableObjectVnuProbeBudgetCoordinator(cfEnv.VNU_PROBE_BUDGET));
setVnuRefreshControlCoordinator(new DurableObjectVnuRefreshControlCoordinator(cfEnv.VNU_REFRESH_CONTROL));

export default createApp(CloudflareAdapter);
