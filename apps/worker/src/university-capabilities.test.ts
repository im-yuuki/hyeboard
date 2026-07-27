import { encryptSession, type EncryptedSessionPayload } from "@hyeboard/core";
import { DaotaoClient } from "@hyeboard/university-adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApp, setRuntimeConfig, setVnuProbeBudgetCoordinator } from "./app";
import type { VnuProbeBudgetCoordinator } from "./vnu-probe-budget";

// Self-hosted (Node/Bun) deployments never install a probe-budget
// coordinator, so every cross-lookup route there fails closed with 503. The
// capability payload must say so honestly instead of rendering cross-lookup
// UI whose every request errors; the static adapter record itself stays
// untouched for the Cloudflare deployment. This file gets its own module
// graph (vitest isolates per file), so the coordinator starts uninstalled
// here regardless of what app.test.ts installs.
//
// ORDER MATTERS: the coordinator-install test must run last within this
// file — installation is module-level state and cannot be uninstalled.

const SESSION_SECRET = "worker-test-secret-worker-test-secret";

type UniversitiesPayload = {
  data: Array<{ id: string; capabilities: Record<string, boolean> }>;
};

function vnuSession(): EncryptedSessionPayload {
  return {
    version: 1,
    universityId: "vnu",
    vnu: { kind: "cookie", value: "SYNTHETIC_SELFHOST_COOKIE", expiresAt: "2099-01-01T00:00:00.000Z" },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

async function listUniversities(app: ReturnType<typeof createApp>): Promise<UniversitiesPayload["data"]> {
  const response = await app.handle(new Request("http://localhost/api/universities"));
  expect(response.status).toBe(200);
  const body = await response.json() as UniversitiesPayload;
  expect(body.data.length).toBeGreaterThan(0);
  return body.data;
}

describe("university capability serialization", () => {
  beforeEach(() => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
  });

  it("masks crossLookup off without an installed coordinator and keeps the routes fail-closed 503", async () => {
    const app = createApp(undefined);

    const universities = await listUniversities(app);
    const vnu = universities.find((university) => university.id === "vnu");
    expect(vnu?.capabilities.crossLookup).toBe(false);
    // Only crossLookup is masked — the rest of the static record (and the
    // other universities) passes through untouched.
    expect(vnu?.capabilities.classLookup).toBe(true);
    expect(vnu?.capabilities.grades).toBe(true);
    expect(universities.find((university) => university.id === "mock")?.capabilities.crossLookup).toBe(false);
    expect(universities.find((university) => university.id === "uet")?.capabilities.crossLookup).toBe(false);

    const profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml")
      .mockResolvedValue(`<input name="hidStdID" value="1000"><input name="StdCode" value="20000000">`);
    const transcriptSpy = vi.spyOn(DaotaoClient.prototype, "getTranscriptByStdIdHtml")
      .mockResolvedValue("<table></table>");
    try {
      const token = await encryptSession(vnuSession(), SESSION_SECRET);
      const response = await app.handle(new Request("http://localhost/api/vnu/cross-lookup/student-code?stdId=1002&allowCrossLookup=true", {
        headers: { Authorization: `Bearer ${token}` },
      }));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_PROBE_BUDGET_UNAVAILABLE" } });
      expect(transcriptSpy).not.toHaveBeenCalled();
    } finally {
      profileSpy.mockRestore();
      transcriptSpy.mockRestore();
    }
  });

  it("reports the static capability once an authoritative coordinator is installed (Cloudflare path)", async () => {
    const coordinator: VnuProbeBudgetCoordinator = {
      async consume() { /* not exercised — capability wiring only */ },
      async reserve() { /* not exercised — capability wiring only */ },
    };
    setVnuProbeBudgetCoordinator(coordinator);

    const universities = await listUniversities(createApp(undefined));

    // Seeing true here immediately after the previous test saw false also
    // proves the mask never mutated the shared static adapter record.
    expect(universities.find((university) => university.id === "vnu")?.capabilities.crossLookup).toBe(true);
  });
});
