import { decryptSession, type EncryptedSessionPayload } from "@hyeboard/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApp,
  setAppCache,
  setDistributedAutomationBackend,
  setRateLimitCoordinator,
  setRuntimeConfig,
  type DistributedAutomationBackend,
} from "./app";

const SECRET = "distributed-api-session-secret-sentinel";

function importedSession(): EncryptedSessionPayload {
  return {
    version: 1,
    universityId: "uet",
    studentCode: "STUDENT_SENTINEL",
    expiresAt: "2099-01-01T00:00:00.000Z",
    uetGoogleCredential: { email: "student@vnu.edu.vn", password: "PRIVATE-PASSWORD" },
    studenthub: { kind: "bearer", value: "PRIVATE-TOKEN", expiresAt: "2099-01-01T00:00:00.000Z" },
  };
}

function backend(events: Array<{ type: string; sequence: number }>): DistributedAutomationBackend {
  return {
    isAvailable: () => true,
    isAutomationChallengeToken: () => false,
    createChallengeToken: () => "unused",
    answerCaptcha: async () => undefined,
    cancelCaptcha: async () => undefined,
    cancelAutomation: async () => undefined,
    importUetGoogle: async (_input, options) => {
      options.onJob?.("signed-owner-token");
      for (const event of events) await options.onEvent?.({
        type: event.type,
        sequence: event.sequence,
        jobId: "job",
        accountId: "account",
        fence: 1,
        ...(event.type === "progress" ? { phase: "login" as const, percent: 50 } : {}),
      });
      return { universityId: "uet", studentCode: "STUDENT_SENTINEL", expiresAt: "2099-01-01T00:00:00.000Z", session: importedSession() };
    },
  };
}

describe("distributed automation API integration", () => {
  const cache = new Map<string, Response>();
  afterEach(() => {
    setDistributedAutomationBackend(undefined);
    setRateLimitCoordinator(undefined);
    setAppCache(undefined);
    setRuntimeConfig({ HYEB_SESSION_SECRET: SECRET });
  });

  it("streams validated worker progress and only emits a normal session token after the result", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SECRET, HYEB_HA_MODE: "distributed" });
    setRateLimitCoordinator({ consumeFixedWindow: async () => ({ allowed: true, retryAfterSeconds: 0 }) });
    setAppCache({
      match: async (request) => cache.get(request.url)?.clone(),
      put: async (request, response) => { cache.set(request.url, response.clone()); },
    });
    setDistributedAutomationBackend(backend([{ type: "started", sequence: 0 }, { type: "progress", sequence: 1 }, { type: "succeeded", sequence: 2 }]));
    const response = await createApp(undefined).handle(new Request("http://localhost/api/uet/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uetGoogleEmail: "student@vnu.edu.vn", uetGooglePassword: "password" }),
    }));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("event: progress");
    expect(text).toContain("event: done");
    const done = JSON.parse(text.split("event: done\ndata: ")[1].split("\n\n")[0]) as { token: string };
    await expect(decryptSession(done.token, SECRET)).resolves.toMatchObject({ universityId: "uet", studentCode: "STUDENT_SENTINEL" });
  });

  it("does not silently inline when distributed automation has no executor", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SECRET, HYEB_HA_MODE: "distributed" });
    setRateLimitCoordinator({ consumeFixedWindow: async () => ({ allowed: true, retryAfterSeconds: 0 }) });
    setAppCache({
      match: async (request) => cache.get(request.url)?.clone(),
      put: async (request, response) => { cache.set(request.url, response.clone()); },
    });
    setDistributedAutomationBackend({ ...backend([]), isAvailable: () => false });
    const response = await createApp(undefined).handle(new Request("http://localhost/api/uet/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uetGoogleEmail: "student@vnu.edu.vn", uetGooglePassword: "password" }),
    }));
    await expect(response.json()).resolves.toMatchObject({ error: { code: "AUTOMATION_BACKEND_UNCONFIGURED" } });
    expect(response.status).toBe(503);
  });
});
