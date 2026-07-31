import { expect } from "@playwright/test";

export async function startMockedVnuSession(
  page: import("@playwright/test").Page,
  error: { code?: string; status: number; message: string },
  options: { deferRawResponses?: boolean } = {},
) {
  await page.goto("/login");
  const initialAccountCount = await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as unknown[];
    return accounts.length;
  });
  let releaseRawRequests!: () => void;
  const featureNavigationReady = new Promise<void>((resolve) => {
    releaseRawRequests = resolve;
  });
  const expectedRawPaths = new Set([
    "/api/vnu/raw/profile",
    "/api/vnu/raw/grades",
    "/api/vnu/raw/progress",
  ]);
  const pendingRawRequestPaths = new Set(expectedRawPaths);
  let markAllRawRequestsStarted!: () => void;
  const allRawRequestsStarted = new Promise<void>((resolve) => {
    markAllRawRequestsStarted = resolve;
  });
  const pendingRawResponsePaths = new Set(expectedRawPaths);
  let markAllRawResponsesFulfilled!: () => void;
  const allRawResponsesFulfilled = new Promise<void>((resolve) => {
    markAllRawResponsesFulfilled = resolve;
  });

  await page.route("**/api/uet/dashboard**", (route) => route.abort());
  await page.route("**/api/mock/**", (route) => route.abort());
  await page.route("**/api/vnu/auth/import-session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          token: "synthetic-vnu-token",
          session: {
            authenticated: true,
            studentCode: "synthetic-vnu-student",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        },
      }),
    });
  });
  await page.route("**/api/vnu/raw/**", async (route) => {
    const rawPath = new URL(route.request().url()).pathname;
    if (pendingRawRequestPaths.delete(rawPath) && pendingRawRequestPaths.size === 0) markAllRawRequestsStarted();
    await featureNavigationReady;
    await route.fulfill({
      status: error.status,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: error.code, message: error.message } }),
    });
    if (pendingRawResponsePaths.delete(rawPath) && pendingRawResponsePaths.size === 0) markAllRawResponsesFulfilled();
  });

  await page.goto("/login");
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await page.getByLabel("Username").fill("synthetic-vnu-user");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-vnu-password");
  await page.getByRole("button", { name: "Import university session", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as unknown[];
    return accounts.length;
  })).toBe(initialAccountCount + 1);
  await expect(page).toHaveURL(/\/$/);
  if (!options.deferRawResponses) releaseRawRequests();
  return { releaseRawRequests, allRawRequestsStarted, allRawResponsesFulfilled };
}

export const NEW_TAB_VNU_ACCOUNT_ID = "synthetic-vnu-new-tab";

export const NEW_TAB_SURVIVOR = { id: "synthetic-new-tab-survivor", universityId: "mock", token: "synthetic-survivor-token", studentCode: "SYNTHETIC-SURVIVOR", addedAt: "2099-01-01T00:00:00.000Z" };

export async function seedNewTabDescriptorScenario(
  page: import("@playwright/test").Page,
  token: string,
  targetIsActive: boolean,
): Promise<void> {
  await page.goto("/login");
  await page.evaluate(({ accountId, accountToken, survivor, active }) => {
    const target = { id: accountId, universityId: "vnu", token: accountToken, studentCode: "SYNTHETIC-NEW-TAB", addedAt: "2099-01-01T00:00:00.000Z" };
    localStorage.setItem("hyeboard.accounts", JSON.stringify(active ? [target, survivor] : [survivor, target]));
    localStorage.setItem("hyeboard.activeAccountId", active ? accountId : survivor.id);
    localStorage.setItem("hyeboard.universityId", active ? "vnu" : "mock");
    sessionStorage.setItem(`hyeboard.vnu.refreshGrant.${accountId}`, "synthetic-source-tab-grant");
  }, { accountId: NEW_TAB_VNU_ACCOUNT_ID, accountToken: token, survivor: NEW_TAB_SURVIVOR, active: targetIsActive });
}

export async function seedExpiringNewTabAccount(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate((accountId) => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([{ id: accountId, universityId: "vnu", token: "synthetic-expiring-new-tab-token", studentCode: "SYNTHETIC-NEW-TAB", addedAt: "2099-01-01T00:00:00.000Z" }]));
    localStorage.setItem("hyeboard.activeAccountId", accountId);
    localStorage.setItem("hyeboard.universityId", "vnu");
    sessionStorage.setItem(`hyeboard.vnu.refreshGrant.${accountId}`, "synthetic-source-tab-grant");
  }, NEW_TAB_VNU_ACCOUNT_ID);
}

export type VnuReconnectRequestCounts = {
  vnuTimetable: number;
  uetTimetable: number;
  universities: number;
};

export async function seedVnuReconnectScenario(
  page: import("@playwright/test").Page,
  locale: "en" | "vi" = "en",
): Promise<VnuReconnectRequestCounts> {
  const counts: VnuReconnectRequestCounts = { vnuTimetable: 0, uetTimetable: 0, universities: 0 };
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/universities", (route) => {
    counts.universities += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], error: null }) });
  });
  await page.route("**/api/vnu/timetable**", (route) => {
    counts.vnuTimetable += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], error: null }) });
  });
  await page.route("**/api/uet/timetable**", (route) => {
    counts.uetTimetable += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], error: null }) });
  });
  await page.goto("/login");
  await page.evaluate((selectedLocale) => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([
      { id: "synthetic-vnu-active", universityId: "vnu", token: "synthetic-active-token", studentCode: "SYNTHETIC-ACTIVE", addedAt: "2099-01-01T00:00:00.000Z" },
      { id: "synthetic-vnu-inactive", universityId: "uet", token: "synthetic-inactive-token", studentCode: "SYNTHETIC-INACTIVE", addedAt: "2099-01-01T00:00:00.000Z" },
    ]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-vnu-active");
    localStorage.setItem("hyeboard.universityId", "vnu");
    localStorage.setItem("hyeboard.locale", selectedLocale);
  }, locale);
  const initialTimetable = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/vnu/timetable");
  await page.goto("/timetable");
  await initialTimetable;
  await expect(page.getByTestId("account-trigger")).toBeVisible();
  return counts;
}

export function reconnectCountsSnapshot(counts: VnuReconnectRequestCounts): VnuReconnectRequestCounts {
  return { ...counts };
}
