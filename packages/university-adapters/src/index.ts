export * from "./registry";
export * from "./types";
export { DaotaoClient } from "./vnu/daotao-client";
// Worker-side VNU parsing for session-bound authorization and cross-lookup
// guards. Pure regex, safe for every runtime the package ships to.
export { findPointDetailSelector, isDaotaoSessionExpired, parseGradesHtml, parseProfileHtml } from "./vnu/parser";
export type { VnuProfile } from "./vnu/types";
// Worker-side cross-student identity resolution — the worker parses the
// fetched listpoint_Brc1.asp header itself so only the resolved code/name/
// class (never the target student's raw transcript HTML) crosses the network
// to the browser for the cross-lookup routes. parsePortalNotice is the
// fail-closed portal notice extractor reused there so an invalid StdID still
// surfaces the portal's own in-page message instead of a silent empty result.
export { parseTranscriptHeader, parseTranscriptHtml, parsePortalNotice } from "./vnu/parser";
// Worker-side detailPoint.asp parsing for the permit-gated cross-detail
// routes: the worker parses the fetched popup itself and projects only the
// strict component allowlist (never notes, header echoes, or raw HTML).
export { parsePointDetailHtml } from "./vnu/parser";
export type { VnuTranscript, VnuTranscriptHeader, VnuPointDetail } from "./vnu/types";
// Static vTermID table — verified vTermID <-> maHK <-> academic-year mapping
// (see exam-terms.ts). Pure data, safe for every runtime.
export { VNU_EXAM_TERMS } from "./vnu/exam-terms";
// Deliberately NOT re-exporting anything from ./uet/google-login-automation-
// patchright.ts here — see that file and setPatchrightLauncher's doc
// comment in google-login-automation.ts for why (keeping the large
// Node-only patchright dependency out of this barrel file matters: apps/worker's
// Cloudflare entry point imports this whole module).
export {
  setPatchrightLauncher,
  setPatchrightCloseHandler,
  type PatchrightLauncher,
  closeCachedBrowserSessions,
} from "./uet/google-login-automation";
export { setCaptchaOcrSolver, type CaptchaOcrSolver } from "./uet/captcha";
