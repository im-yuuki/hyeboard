import { expect, test } from "@playwright/test";

async function downloadText(download: import("@playwright/test").Download): Promise<string> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Playwright download stream was unavailable");

  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function loginDemo(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "Mock" }).click();
  await page.getByRole("button", { name: "Open Demo Workspace" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: /Welcome back, Demo Student/i })).toBeVisible();
}

async function openMockedLookup(page: import("@playwright/test").Page) {
  await page.route("**/api/universities", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { data: Array<{ id: string; capabilities: Record<string, boolean> }> };
    const mock = payload.data.find((university) => university.id === "mock");
    if (mock) {
      mock.capabilities.classLookup = true;
      mock.capabilities.crossLookup = true;
    }
    await route.fulfill({ response, json: payload });
  });
  await page.route("**/api/vnu/raw/profile", async (route) => {
    const html = '<input name="StdCode" value="24000000"><input name="StdName" value="Demo Student"><input name="hidStdID" value="123456">';
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { html } }) });
  });
  await loginDemo(page);
  await page.goto("/lookup");
  await expect(page.getByRole("heading", { name: "Lookup", exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
});

test("dashboard redirects to login without a session", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in to Hyeboard" })).toBeVisible();
});

test("login shows university-specific sections", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("combobox", { name: "School" })).toContainText("VNU-UET");
  await expect(page.getByText("Connect university account")).toBeVisible();
  await expect(page.getByText("Use Demo Data")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await page.getByRole("button", { name: "Having trouble? Use a manual token instead" }).click();
  await expect(page.getByText("Connect your university portal")).toBeVisible();
  await expect(page.getByText(/origin_mismatch/)).toBeVisible();
  await expect(page.getByText(/copy\(localStorage\.getItem/)).toBeVisible();
  await expect(page.getByPlaceholder("University portal access token")).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "Open university portal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open learning platform" })).toBeVisible();
  await expect(page.getByText("Optional: connect the learning platform")).toBeVisible();
  await expect(page.getByPlaceholder("Learning platform access token")).toHaveAttribute("type", "password");
  await expect(page.getByText("Advanced cookie options")).toBeVisible();
  await page.getByText("Advanced cookie options").click();
  await expect(page.getByPlaceholder("University portal cookie, if token import is unavailable")).toHaveAttribute("type", "password");
  await expect(page.getByPlaceholder("Student code, optional")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "uet");

  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "Mock" }).click();
  await expect(page.getByRole("combobox", { name: "School" })).toContainText("Mock");
  await expect(page.getByText("Use Demo Data")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Demo Workspace" })).toBeVisible();
  await expect(page.getByPlaceholder("Student code, optional")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "geist");
});

test("UET login leads with Google sign-in and reveals manual fallback on demand", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU-UET" }).click();

  await expect(page.getByPlaceholder("Student code")).toBeVisible();
  await expect(page.getByPlaceholder("Google account password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();

  await expect(page.getByPlaceholder("University portal access token")).toHaveCount(0);
  await expect(page.getByPlaceholder("Learning platform access token")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open university portal" })).toHaveCount(0);

  await page.getByRole("button", { name: "Having trouble? Use a manual token instead" }).click();

  await expect(page.getByPlaceholder("University portal access token")).toBeVisible();
  await expect(page.getByPlaceholder("Learning platform access token")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open university portal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open learning platform" })).toBeVisible();
});

test("login keeps relogin fields after session expiry", async ({ page }) => {
  await page.goto("/login");

  await page.getByRole("button", { name: "Having trouble? Use a manual token instead" }).click();
  await page.getByPlaceholder("Learning platform access token").fill("canvas-relogin-token");
  await page.reload();
  await page.getByRole("button", { name: "Having trouble? Use a manual token instead" }).click();
  await expect(page.getByPlaceholder("Learning platform access token")).toHaveValue("canvas-relogin-token");

  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await page.getByPlaceholder("Student code / username").fill("24000000");
  await page.getByPlaceholder("Password").fill("vnu-relogin-password");
  await page.evaluate(() => sessionStorage.removeItem("hyeboard.sessionToken"));
  await page.reload();

  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await expect(page.getByPlaceholder("Student code / username")).toHaveValue("24000000");
  await expect(page.getByPlaceholder("Password")).toHaveValue("vnu-relogin-password");
});

test("login always shows the correct accent color for the selected school, never a stale one", async ({ page }) => {
  // Simulate a browser that previously had a mock (geist) session persisted,
  // then landed back on /login for VNU-UET - the accent must not stay stale.
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.palette", "geist");
    localStorage.setItem("hyeboard.universityId", "uet");
  });
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "uet");
});

test("account menu opens and signs out", async ({ page }) => {
  await loginDemo(page);
  const accountButton = page.getByRole("button", { name: "Open account menu" });
  await accountButton.click();
  await expect(page.getByTestId("account-trigger")).toHaveCSS("transform", /matrix\(0\.94/);
  await expect(page.getByRole("menuitem", { name: /Settings/i })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Add account/i })).toBeVisible();
  await page.getByRole("menuitem", { name: /Sign out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("friendly demo login opens dashboard", async ({ page }) => {
  await loginDemo(page);
  await expect(page.getByText("React Router Lab")).toBeVisible();
  await expect(page.getByTestId("brand-icon")).toHaveAttribute("data-university", "mock");
  await expect(page.getByTestId("brand-icon").locator("img")).toHaveCount(0);
  await expect(page.getByText("Web Application Development").first()).toBeVisible();
  await expect(page.getByText("09:50 - 12:30").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open class page" })).toHaveAttribute("href", "https://portal.uet.vnu.edu.vn/courses/5359");

  await expect(page.getByTestId("dashboard-summary")).toBeVisible();
  await expect(page.getByTestId("dashboard-schedule")).toBeVisible();
  await expect(page.getByTestId("dashboard-assignments")).toBeVisible();
  await expect(page.getByTestId("dashboard-courses")).toBeVisible();
  await expect(page.getByTestId("dashboard-notifications")).toBeVisible();
  await expect(page.locator(".stat-card")).toHaveCount(0);
});

test("dashboard summary strip stays contained on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginDemo(page);

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

  const stats = page.getByTestId("dashboard-summary").locator(".summary-stat");
  await expect(stats).toHaveCount(4);
  const first = await stats.nth(0).boundingBox();
  const second = await stats.nth(1).boundingBox();
  const third = await stats.nth(2).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(third).not.toBeNull();
  expect(Math.abs(first!.y - second!.y)).toBeLessThan(5);
  expect(third!.y).toBeGreaterThan(first!.y);

  await page.goto("/grades");
  const gradesStats = page.getByTestId("grades-summary").locator(".summary-stat");
  await expect(gradesStats).toHaveCount(3);
  const wrappedStatBorderLeft = await gradesStats
    .nth(2)
    .evaluate((element) => getComputedStyle(element).borderLeftWidth);
  expect(wrappedStatBorderLeft).toBe("0px");
});

test("status labels render as readable text", async ({ page }) => {
  await loginDemo(page);
  await expect(page.getByText("In progress", { exact: true })).toBeVisible();
  await expect(page.getByText("Not started", { exact: true })).toBeVisible();
  await expect(page.getByText("in_progress", { exact: true })).toHaveCount(0);
  await expect(page.getByText("not_started", { exact: true })).toHaveCount(0);
});

test("light and dark mode toggle changes rendered theme", async ({ page }) => {
  await loginDemo(page);
  await page.goto("/settings");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await page.getByRole("button", { name: "Toggle light and dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await page.getByRole("button", { name: "Toggle light and dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
});

test("settings can switch between neutral and university theme styles", async ({ page }) => {
  await loginDemo(page);
  await page.goto("/settings");
  await expect(page.getByRole("group", { name: "Theme style" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Neutral" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Colored" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Theme color" })).toHaveCount(0);

  await page.getByRole("button", { name: "Colored" }).click();
  const group = page.getByRole("group", { name: "Theme color" });
  await expect(group).toBeVisible();
  const greenSwatch = page.getByRole("button", { name: "Green" });
  await greenSwatch.click();
  await expect(greenSwatch).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveCSS("--primary", "152 88% 28%");
  await page.getByRole("button", { name: "Neutral" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "geist");
  await expect(page.getByRole("group", { name: "Theme color" })).toHaveCount(0);
});

test("sidebar collapses and expands via toggle button", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop-only sidebar, hidden below the lg breakpoint on mobile");
  await loginDemo(page);
  await expect(page.getByText("Demo", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Overview", { exact: true })).toBeVisible();
  await expect(page.getByText("Study", { exact: true })).toBeVisible();
  await expect(page.getByText("Services", { exact: true })).toBeVisible();
  await expect(page.getByText("System", { exact: true })).toBeVisible();
  await expect(page.getByText(/Powered by Hyeboard/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Student command center")).toHaveCount(0);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByText("Demo", { exact: true })).toBeHidden();
  await expect(page.getByText(/Powered by Hyeboard/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await page.waitForTimeout(350);
  const logoBox = await page.locator("aside [data-testid='brand-icon']").boundingBox();
  const expandBox = await page.getByRole("button", { name: "Expand sidebar" }).boundingBox();
  expect(logoBox).not.toBeNull();
  expect(expandBox).not.toBeNull();
  expect(logoBox!.y + logoBox!.height).toBeLessThanOrEqual(expandBox!.y);
  expect(Math.abs((logoBox!.x + logoBox!.width / 2) - (expandBox!.x + expandBox!.width / 2))).toBeLessThanOrEqual(1);
  await expect(page.locator(".app-shell")).toHaveCSS("transition-property", /grid-template-columns/);
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.getByText("Demo", { exact: true }).first()).toBeVisible();
});

test("mobile nav drawer opens and closes on navigation", async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 900 });
  await loginDemo(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Toggle light and dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeHidden();
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Demo", { exact: true })).not.toHaveCSS("color", "rgb(0, 0, 0)");
  await page.getByRole("link", { name: "Timetable" }).click();
  await expect(page).toHaveURL(/\/timetable$/);
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeHidden();
});

test("mobile nav drawer links meet touch target size and restore focus on escape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginDemo(page);
  const trigger = page.getByRole("button", { name: "Open navigation menu" });
  await trigger.click();
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeVisible();

  const links = page.getByRole("dialog").getByRole("link");
  const count = await links.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = await links.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeVisible();
  await page.getByRole("link", { name: "Timetable" }).click();
  await expect(page).toHaveURL(/\/timetable$/);
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeHidden();
});

test("header search filters and navigates to a page", async ({ page }) => {
  await loginDemo(page);
  const search = page.getByPlaceholder("Search pages...");
  await search.click();
  await search.fill("Grades");
  await expect(page.getByRole("button", { name: "Grades" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/grades$/);
});

// The Lookup feature (class-code -> internal-id resolver, own StdID card) is
// gated on the vnu-only `classLookup` capability - the mock demo adapter
// deliberately sets it to false (see mock/adapter.ts), so both the sidebar
// nav entry and the header search must never surface it for that account.
//
// NOTE: this suite has no vnu-authenticated fixture (a real vnu login needs
// a real daotao.vnu.edu.vn username/password posted to the live portal -
// there is no mock/stub server for it here, unlike the "mock" demo
// university). A direct-route-render test for a signed-in vnu session is
// intentionally not added rather than fabricating credentials or a bespoke
// fetch-mocking harness beyond this feature's scope.
test("Lookup nav item is absent for the mock demo account (vnu-only capability)", async ({ page }) => {
  await loginDemo(page);
  await expect(page.getByRole("link", { name: "Lookup" })).toHaveCount(0);

  const search = page.getByPlaceholder("Search pages...");
  await search.click();
  await search.fill("Lookup");
  await expect(page.getByText("No page matches that search.")).toBeVisible();

  // Direct-URL access must not leak the cross-lookup sections either: the mock
  // adapter sets crossLookup=false, and the sections are additionally gated
  // behind the page's profile query failing for a non-vnu session. The same
  // gating covers the phase-3 additions — the reverse class-ID resolver and
  // the cross-student resolvers must stay equally unreachable.
  await page.goto("/lookup");
  await expect(page.getByTestId("reverse-class-lookup")).toHaveCount(0);
  await expect(page.getByTestId("cross-student-code")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Resolve another student's code" })).toHaveCount(0);
  await expect(page.getByTestId("cross-student-id")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Resolve another student's internal ID" })).toHaveCount(0);
  await expect(page.getByTestId("cross-transcript")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Look up another student's transcript" })).toHaveCount(0);
  await expect(page.getByTestId("bulk-lookup")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Bulk cross-lookup" })).toHaveCount(0);
});

test("lookup groups use progressive modes, accessible labels, and responsive touch targets", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openMockedLookup(page);

  await expect(page.getByTestId("class-identifier-tools")).toBeVisible();
  await expect(page.getByTestId("student-record-tools")).toBeVisible();
  await expect(page.getByTestId("bulk-lookup")).toBeVisible();
  await expect(page.getByLabel("Course code")).toBeVisible();
  await expect(page.getByLabel("Class number (optional)")).toBeVisible();
  await expect(page.getByRole("group", { name: "Class lookup direction" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Student record tool" })).toBeVisible();

  await page.getByRole("button", { name: "Class ID to course" }).click();
  await expect(page.getByLabel("Internal class ID")).toBeVisible();
  await page.getByRole("button", { name: "Code → ID" }).click();
  await expect(page.getByLabel("Target student code")).toBeVisible();
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(page.getByRole("group", { name: "Transcript lookup identifier" })).toBeVisible();

  const principalControls = page.locator('[data-testid="class-identifier-tools"] button:visible, [data-testid="class-identifier-tools"] input:visible, [data-testid="student-record-tools"] button:visible, [data-testid="student-record-tools"] input:visible, [data-testid="bulk-lookup"] button:visible, [data-testid="bulk-lookup"] textarea:visible, [data-testid="bulk-lookup"] [role="combobox"]:visible');
  const controlCount = await principalControls.count();
  expect(controlCount).toBeGreaterThan(0);
  for (let index = 0; index < controlCount; index++) {
    const box = await principalControls.nth(index).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(43.9);
  }

  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expectNoPageOverflow(page);
  }
});

test("cross-student forms reject malformed identifiers client-side before any request", async ({ page }) => {
  await openMockedLookup(page);

  // StdID -> code section: a malformed internal id shows the localized
  // validation message, marks the input invalid, and keeps submit disabled
  // (same contract as the transcript form; the worker still rejects too).
  const codeInput = page.getByLabel("Target internal student ID");
  await codeInput.fill("12ab");
  await expect(codeInput).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Enter 1 to 11 digits for the internal student ID.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Look up" })).toBeDisabled();
  await codeInput.fill("123456");
  await expect(codeInput).toHaveAttribute("aria-invalid", "false");
  await expect(page.getByText("That is your own internal ID — your own ID mapping is shown above.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Look up" })).toBeDisabled();

  // Code -> StdID section: same contract for the 8-digit code form.
  await page.getByRole("button", { name: "Code → ID" }).click();
  const idInput = page.getByLabel("Target student code");
  await idInput.fill("1234567");
  await expect(idInput).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Enter an 8-digit student code.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Look up" })).toBeDisabled();
  await idInput.fill("24000000");
  await expect(page.getByText("That is your own student code — your own ID mapping is shown above.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Look up" })).toBeDisabled();
});

test("notifications menu shows dashboard notifications", async ({ page }) => {
  await loginDemo(page);
  const notificationsButton = page.getByRole("button", { name: "Notifications" });
  await notificationsButton.click();
  await expect(page.getByTestId("notifications-trigger")).toHaveCSS("transform", /matrix\(0\.94/);
  await expect(page.getByText("No notifications right now.").or(page.getByRole("menuitem").first())).toBeVisible();
});

test("grades default to the newest term, merge summer into term two, and expand row details", async ({ page }) => {
  await loginDemo(page);
  await page.goto("/grades");

  // Default selection is the newest term only, not the full stacked transcript.
  await expect(page.getByRole("heading", { name: "Semester 1, 2025–2026" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Semester 2, 2024–2025" })).toHaveCount(0);
  await expect(page.getByText("Web Application Development")).toBeVisible();

  // The Note column is gone; letter grades render as toned badges instead.
  await expect(page.getByRole("columnheader", { name: "Note" })).toHaveCount(0);
  await expect(page.getByTestId("letter-badge")).toHaveCount(2);
  await expect(page.getByTestId("letter-badge").nth(0)).toHaveText("B+");
  await expect(page.getByTestId("letter-badge").nth(1)).toHaveText("A");

  // Switching terms via the dropdown reveals the merged summer group.
  await page.getByRole("combobox", { name: "Term" }).click();
  await page.getByRole("option", { name: "Semester 2, 2024–2025" }).click();
  await expect(page.getByRole("heading", { name: "Semester 2, 2024–2025" })).toBeVisible();
  await expect(page.getByText("20242", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("term-summary").first()).toBeVisible();
  await expect(page.locator(".stat-card")).toHaveCount(0);
  await expect(page.getByText("Includes summer term")).toBeVisible();
  await expect(page.getByText("Signals and Systems")).toBeVisible();
  await expect(page.getByText("Term GPA").first()).toBeVisible();
  await expect(page.getByText("Term GPA").first().locator("..")).toContainText("3.40");
  await expect(page.getByText("A+", { exact: true }).first()).toBeVisible();

  // Expanding a row shows the detail panel with its humanized (summer) term.
  const detailToggle = page.getByRole("button", { name: "Toggle details for Signals and Systems" });
  await expect(detailToggle).toHaveAttribute("aria-expanded", "false");
  await detailToggle.click();
  await expect(detailToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Summer semester, 2024–2025")).toBeVisible();
  await detailToggle.click();
  await expect(detailToggle).toHaveAttribute("aria-expanded", "false");

  await page.getByRole("button", { name: "Point 10" }).first().click();
  await expect(page.getByRole("columnheader", { name: /Point 10/ }).first()).toHaveAttribute("aria-sort", "ascending");
  await page.getByRole("button", { name: "Point 10" }).first().click();
  await expect(page.getByRole("columnheader", { name: /Point 10/ }).first()).toHaveAttribute("aria-sort", "descending");
});

test("grades render derived term GPA and CPA and export current page and term state", async ({ page }) => {
  await loginDemo(page);
  await page.goto("/grades");

  const newestTermHeader = page.getByTestId("academic-term-header").first();
  const newestTerm = newestTermHeader.locator("..");
  await expect(newestTermHeader.getByRole("heading", { name: "Semester 1, 2025–2026" })).toBeVisible();
  await expect(newestTermHeader.getByText("Derived", { exact: true })).toBeVisible();
  await expect(newestTermHeader.getByText("Term GPA").locator("..")).toContainText("3.45");
  await expect(newestTermHeader.getByText("CPA", { exact: true }).locator("..")).toContainText("3.43");
  await expect(newestTermHeader.getByText("Included credits").locator("..")).toContainText("6 / 6 listed");

  const reportedSummary = page.getByTestId("grades-summary");
  await expect(reportedSummary.getByText("Portal cumulative GPA", { exact: true })).toBeVisible();
  await expect(reportedSummary.getByText("3.48", { exact: true })).toBeVisible();

  await newestTerm.getByRole("button", { name: "Course" }).click();
  await expect(newestTerm.locator("tbody > tr").nth(0)).toContainText("Web Application Development");
  await expect(newestTerm.locator("tbody > tr").nth(2)).toContainText("Linear Algebra");

  const pageExport = page.getByTestId("grades-page-export");
  await pageExport.getByRole("button", { name: "Export" }).click();
  const pageDownloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  const pageDownload = await pageDownloadPromise;
  expect(pageDownload.suggestedFilename()).toMatch(/^hyeboard-grades-page-\d{4}-\d{2}-\d{2}\.json$/);
  const pageDocument = JSON.parse(await downloadText(pageDownload));
  expect(pageDocument).toMatchObject({
    surface: "grades-page",
    universityId: "mock",
    identity: { studentCode: expect.any(String), studentName: "Demo Student", managingClass: "K69CLC-C" },
    reported: { cumulativeGpa4: 3.48, totalCredits: 18, accumulatedCredits: 92 },
    derivedTerms: [{ termCode: "20251", estimateKind: "derived" }],
  });
  expect(pageDocument.derivedTerms).toHaveLength(1);
  expect(pageDocument.derivedTerms[0].termGpa4).toBeCloseTo(3.45);
  expect(pageDocument.derivedTerms[0].derivedCpa4).toBeCloseTo(3.43, 2);
  expect(pageDocument.derivedTerms[0].courses.map((course: { courseName: string }) => course.courseName)).toEqual(["Web Application Development", "Linear Algebra"]);
  expect(Object.keys(pageDocument.derivedTerms[0].courses[0])).toEqual(["courseCode", "courseName", "credits", "point10", "letter", "point4"]);

  await newestTermHeader.getByRole("button", { name: "Export" }).click();
  const termDownloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download CSV" }).click();
  const termDownload = await termDownloadPromise;
  expect(termDownload.suggestedFilename()).toMatch(/^hyeboard-grades-term-\d{4}-\d{2}-\d{2}\.csv$/);
  const termCsv = await downloadText(termDownload);
  expect(termCsv.startsWith("\ufeffrecord_type,surface,")).toBe(true);
  expect(termCsv).toContain(",grades-term,");
  expect(termCsv).toContain("Demo Student");
  expect(termCsv).toContain(",3.48,");
  expect(termCsv).toContain("'20251");
  expect(termCsv.indexOf("Web Application Development")).toBeLessThan(termCsv.indexOf("Linear Algebra"));
  expect(termCsv.endsWith("\r\n")).toBe(true);
  expect(termCsv.replaceAll("\r\n", "")).not.toContain("\n");

  await page.getByRole("combobox", { name: "Term" }).click();
  await page.getByRole("option", { name: "All terms" }).click();
  await expect(page.getByTestId("academic-term-header")).toHaveCount(2);
  await pageExport.getByRole("button", { name: "Export" }).click();
  const allTermsDownloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  const allTermsDocument = JSON.parse(await downloadText(await allTermsDownloadPromise));
  expect(allTermsDocument.derivedTerms.map((term: { termCode: string }) => term.termCode)).toEqual(["20251", "20242"]);
});

test("grades keep missing and reserved term identities collision-safe", async ({ page }) => {
  await loginDemo(page);
  await page.route("**/api/mock/grades", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          { id: "missing", courseCode: "MISS1", courseName: "Missing term", credits: 1, point4: 4 },
          { id: "blank", courseCode: "MISS2", courseName: "Blank term", credits: 1, point4: 3, termCode: "  " },
          { id: "unknown", courseCode: "KNOWN1", courseName: "Known unknown", credits: 1, point4: 2, termCode: "unknown" },
          { id: "all", courseCode: "KNOWN2", courseName: "Known all", credits: 1, point4: 1, termCode: "all" },
          { id: "reserved", courseCode: "KNOWN3", courseName: "Known reserved", credits: 1, point4: 3, termCode: "~hyeboard:known:reserved" },
          { id: "numeric", courseCode: "NUMERIC", courseName: "Numeric term", credits: 1, point4: 3, termCode: "251" },
          { id: "spaced", courseCode: "SPACED", courseName: "Spaced numeric term", credits: 1, point4: 3, termCode: " 251 " },
        ],
        error: null,
      }),
    });
  });
  await page.goto("/grades");

  await page.getByRole("combobox", { name: "Term" }).click();
  for (const option of ["Unknown term", "unknown", "all", "~hyeboard:known:reserved"]) {
    await expect(page.getByRole("option", { name: option, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("option", { name: "Semester 1, 2025–2026", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "251", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "All terms" }).click();
  await expect(page.getByTestId("academic-term-header")).toHaveCount(6);
  await expect(page.getByTestId("academic-term-header").getByRole("heading", { name: "Semester 1, 2025–2026", exact: true })).toBeVisible();
  await expect(page.getByTestId("academic-term-header").getByRole("heading", { name: "251", exact: true })).toBeVisible();
  await expect(page.getByText("Missing term")).toBeVisible();
  await expect(page.getByText("Blank term")).toBeVisible();

  const pageExport = page.getByTestId("grades-page-export");
  await pageExport.getByRole("button", { name: "Export" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  const document = JSON.parse(await downloadText(await downloadPromise));
  const termIdentities = document.derivedTerms.map((term: { termCode: string; termLabel: string }) => [term.termCode, term.termLabel]);
  expect(termIdentities).toEqual(expect.arrayContaining([
    ["unknown", "Unknown term"],
    ["unknown", "unknown"],
    ["all", "all"],
    ["~hyeboard:known:reserved", "~hyeboard:known:reserved"],
  ]));
  const numericTerm = document.derivedTerms.find((term: { termCode: string }) => term.termCode === "251");
  const spacedTerm = document.derivedTerms.find((term: { termCode: string }) => term.termCode === " 251 ");
  expect(numericTerm.courses.map((course: { courseName: string }) => course.courseName)).toEqual(["Numeric term"]);
  expect(spacedTerm.courses.map((course: { courseName: string }) => course.courseName)).toEqual(["Spaced numeric term"]);
});

test("grades exports wait for dashboard metadata without blocking grades", async ({ page }) => {
  await loginDemo(page);
  let releaseDashboard!: () => void;
  let markDashboardRequested!: () => void;
  const dashboardGate = new Promise<void>((resolve) => { releaseDashboard = resolve; });
  const dashboardRequested = new Promise<void>((resolve) => { markDashboardRequested = resolve; });
  await page.route("**/api/mock/dashboard**", async (route) => {
    markDashboardRequested();
    await dashboardGate;
    const response = await route.fetch();
    await route.fulfill({ response });
  });

  await page.goto("/grades");
  await dashboardRequested;
  await expect(page.getByText("Web Application Development")).toBeVisible();
  await expect(page.getByRole("button", { name: "Export" })).toHaveCount(0);

  releaseDashboard();
  await expect(page.getByRole("button", { name: "Export" })).toHaveCount(2);
});

test("timetable renders a responsive grid on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginDemo(page);
  await page.goto("/timetable");

  await expect(page.getByTestId("desktop-timetable")).toBeVisible();
  await expect(page.getByTestId("mobile-timetable")).toBeHidden();
  await expect(page.getByRole("columnheader", { name: "Sun" })).toHaveCount(0);
  await expect(page.locator('[data-current-day="true"]')).toHaveCount(1);

  await expect(page.getByText("Web Application Development").first()).toBeVisible();
  await expect(page.getByText("G2-301").first()).toBeVisible();
  await expect(page.getByText("Period 4-6").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open class page" }).first()).toHaveAttribute("href", "https://portal.uet.vnu.edu.vn/courses/5359");
});

test("timetable renders day groups on mobile without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginDemo(page);
  await page.goto("/timetable");

  await expect(page.getByTestId("desktop-timetable")).toBeHidden();
  await expect(page.getByTestId("mobile-timetable")).toBeVisible();
  await expect(page.getByRole("button", { name: "List" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Calendar" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  const mobileSurface = page.getByTestId("mobile-timetable");
  await expect(mobileSurface.getByText("Web Application Development").first()).toBeVisible();
  await expect(mobileSurface.getByText("G2-301").first()).toBeVisible();
  await expect(mobileSurface.getByRole("link", { name: "Open class page" }).first()).toHaveAttribute("href", "https://portal.uet.vnu.edu.vn/courses/5359");
});

test("timetable stays free of horizontal overflow on tablet", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await loginDemo(page);
  await page.goto("/timetable");

  await expect(page.getByTestId("mobile-timetable")).toBeVisible();
  await expect(page.getByRole("button", { name: "List" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Calendar" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("feature routes render UI instead of JSON dumps", async ({ page }) => {
  await loginDemo(page);
  const routes = [
    ["/timetable", "Timetable", "Web Application Development"],
    ["/courses", "Courses", "Data Structures and Algorithms"],
    ["/assignments", "Assignments", "Graph traversal quiz"],
    ["/grades", "Grades", "Academic transcript"],
    ["/exams", "Exams", "Data Structures and Algorithms"],
    ["/tuition", "Tuition", "Early payment credit"],
    ["/documents", "Documents & Services", "Course outline.pdf"],
    ["/training-points", "Training Points", "Semester training points"],
  ] as const;

  for (const [path, heading, text] of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    // Some routes (e.g. Timetable) render the same data in both a desktop-only
    // and a mobile-only surface; `.and(":visible")` picks only the currently
    // rendered one instead of always latching onto the first DOM match, which
    // may be the CSS-hidden counterpart on narrow viewports.
    await expect(page.getByText(text).and(page.locator(":visible")).first()).toBeVisible();
    await expect(page.locator("pre")).toHaveCount(0);
    await expect(page.getByText("active", { exact: true })).toHaveCount(0);
  }

  await page.goto("/documents");
  await expect(page.getByText("Transcript request")).toBeVisible();
  await expect(page.getByRole("link", { name: "Academic calendar update" })).toHaveAttribute("href", "https://uet.edu.vn/academic-calendar-update/");
  await page.getByRole("button", { name: "Toggle News" }).click();
  await expect(page.getByRole("link", { name: "Academic calendar update" })).toBeHidden();

  await page.goto("/courses");
  const coursesSection = page.getByTestId("courses-section");
  await expect(coursesSection).toBeVisible();
  await expect(coursesSection.locator(".section-panel")).toHaveCount(0);
  await expect(page.getByTestId("status-badge").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Open course page/ }).first()).toHaveAttribute("href", /portal\.uet\.vnu\.edu\.vn\/courses/);

  await page.goto("/assignments");
  const assignmentsSection = page.getByTestId("assignments-section");
  await expect(assignmentsSection).toBeVisible();
  await expect(assignmentsSection.locator(".section-panel")).toHaveCount(0);

  await page.goto("/exams");
  await expect(page.getByRole("button", { name: "Calendar" })).toBeVisible();
  await page.getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByText("Written", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("written", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/07:00 AM/)).toHaveCount(0);
});

test("login fields expose persistent accessible labels on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");

  // UET branch: Google sign-in fields.
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU-UET" }).click();
  await expect(page.getByLabel("Student or parent code")).toBeVisible();
  await expect(page.getByLabel("Google account password")).toHaveAttribute("type", "password");

  // Manual fallback fields.
  await page.getByRole("button", { name: "Having trouble? Use a manual token instead" }).click();
  await expect(page.getByLabel("University portal access token")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Learning-platform access token")).toHaveAttribute("type", "password");
  await page.getByText("Advanced cookie options").click();
  await expect(page.getByLabel("University portal cookie")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Learning-platform cookie")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Learning-platform CSRF token")).toHaveAttribute("type", "password");

  // Parent/guardian login swaps the password field label.
  await page.getByLabel("Student or parent code").fill("PH000001");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");

  // VNU (daotao) branch: username/password fields.
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

test("CAPTCHA verification field exposes a persistent accessible label", async ({ page }) => {
  // A real StudentHub CAPTCHA prompt arrives over an SSE connection that
  // stays open until the user answers (see uet-session-stream.ts). Playwright's
  // route.fulfill() always delivers a complete, closed body, which makes the
  // stream-reader treat the connection as closed and immediately dismiss the
  // modal. Overriding window.fetch with a ReadableStream that is never closed
  // reproduces the real "still waiting for an answer" condition instead.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/uet/auth/import-session") && init?.method === "POST") {
        const stream = new ReadableStream({
          start(controller) {
            const chunk = `event: captcha_required\ndata: ${JSON.stringify({ challengeId: "smoke-1", image: "data:image/png;base64,QQ==" })}\n\n`;
            controller.enqueue(new TextEncoder().encode(chunk));
            // Intentionally never call controller.close() — the modal should
            // stay open until the user submits an answer, same as production.
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return originalFetch(input, init);
    };
  });

  await page.goto("/login");
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU-UET" }).click();

  await page.getByLabel("Student or parent code").fill("PH000001");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page.getByLabel("Verification code")).toBeVisible();
});

test("session death triggers inline CAPTCHA re-auth instead of a login redirect", async ({ page }) => {
  // First import-session call (the login) succeeds immediately with a token
  // the real worker cannot decrypt, so the very first dashboard request dies
  // with a genuine INVALID_SESSION 401 from the backend. With credentials
  // stored by the successful login, that session death must open the inline
  // re-auth dialog in place instead of bouncing back to /login. The second
  // import-session call (the re-auth) relays a CAPTCHA and completes once
  // the answer is submitted.
  await page.addInitScript(() => {
    let importCalls = 0;
    let reauthStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encode = (event: string, data: unknown) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/uet/auth/import-session") && init?.method === "POST") {
        importCalls += 1;
        const isReauth = importCalls > 1;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (isReauth) {
              // Held open until the CAPTCHA answer arrives, like production.
              reauthStream = controller;
              controller.enqueue(encode("captcha_required", { challengeId: `smoke-reauth-${importCalls}`, image: "data:image/png;base64,QQ==" }));
            } else {
              controller.enqueue(encode("done", { token: "expired-token", session: { studentCode: "PH000001" } }));
              controller.close();
            }
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.includes("/api/uet/auth/solve-captcha")) {
        reauthStream?.enqueue(encode("done", { token: "fresh-token", session: { studentCode: "PH000001" } }));
        reauthStream?.close();
        return new Response(JSON.stringify({ data: { accepted: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    };
  });

  await page.goto("/login");
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU-UET" }).click();
  await page.getByLabel("Student or parent code").fill("PH000001");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // The re-auth dialog appears on the app route - no redirect to /login.
  await expect(page.getByText("Session expired — verify to continue")).toBeVisible();
  await expect(page.getByLabel("Verification code")).toBeVisible();
  expect(new URL(page.url()).pathname).not.toBe("/login");

  await page.getByLabel("Verification code").fill("ABCD");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("You're signed back in.")).toBeVisible();
});

test("settings About section shows version and commit information", async ({ page }) => {
  await loginDemo(page);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
  await expect(page.getByText("Version")).toBeVisible();
  await expect(page.getByText(/^Commit /)).toBeVisible();
});

async function expectNoPageOverflow(page: import("@playwright/test").Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

const REFERENCE_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

for (const viewport of REFERENCE_VIEWPORTS) {
  test(`login, dashboard, timetable, and grades have no horizontal overflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await expectNoPageOverflow(page);

    await loginDemo(page);
    await expectNoPageOverflow(page);

    await page.goto("/timetable");
    await expectNoPageOverflow(page);

    await page.goto("/grades");
    await expectNoPageOverflow(page);

    await page.goto("/exams");
    await expectNoPageOverflow(page);

    await page.goto("/tuition");
    await expectNoPageOverflow(page);
  });
}

test("dashboard, timetable, grades, and login each expose exactly one page heading", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("h1")).toHaveCount(1);

  await loginDemo(page);
  await expect(page.locator("h1")).toHaveCount(1);

  await page.goto("/timetable");
  await expect(page.locator("h1")).toHaveCount(1);

  await page.goto("/grades");
  await expect(page.locator("h1")).toHaveCount(1);
});

test("sidebar nav links have accessible names and move aria-current on navigation", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop-only sidebar, hidden below the lg breakpoint on mobile");
  await loginDemo(page);
  const dashboardLink = page.getByRole("link", { name: "Dashboard" });
  const timetableLink = page.getByRole("link", { name: "Timetable" });
  const gradesLink = page.getByRole("link", { name: "Grades" });
  await expect(dashboardLink).toHaveAttribute("aria-current", "page");
  await expect(timetableLink).not.toHaveAttribute("aria-current", "page");
  await expect(gradesLink).not.toHaveAttribute("aria-current", "page");

  await timetableLink.click();
  await expect(page).toHaveURL(/\/timetable$/);
  await expect(timetableLink).toHaveAttribute("aria-current", "page");
  await expect(dashboardLink).not.toHaveAttribute("aria-current", "page");
});

test("header search field exposes an accessible name beyond its placeholder", async ({ page }) => {
  await loginDemo(page);
  await expect(page.getByRole("textbox", { name: "Search pages" })).toBeVisible();
});

test("view toggles and key settings actions meet mobile touch target size", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginDemo(page);

  // WebKit at a 3x device pixel ratio can report a CSS 44px target as
  // 43.99998 due to subpixel snapping, so allow a hairline rounding tolerance.
  const MIN_TOUCH_TARGET = 43.9;

  await page.goto("/timetable");
  for (const name of ["List", "Calendar"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  }

  await page.goto("/exams");
  for (const name of ["List", "Calendar"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  }
  const examsTermBox = await page.getByRole("combobox", { name: "Term" }).boundingBox();
  expect(examsTermBox).not.toBeNull();
  expect(examsTermBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);

  await page.goto("/grades");
  const gradesTermBox = await page.getByTestId("grades-term-select").boundingBox();
  expect(gradesTermBox).not.toBeNull();
  expect(gradesTermBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);

  await page.goto("/settings");
  const toggleBox = await page.getByRole("button", { name: "Toggle light and dark mode" }).boundingBox();
  expect(toggleBox).not.toBeNull();
  expect(toggleBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);

  for (const name of ["Neutral", "Colored"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  }

  const languageBox = await page.getByRole("combobox", { name: "Language" }).boundingBox();
  expect(languageBox).not.toBeNull();
  expect(languageBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);

  const signOutBox = await page.getByRole("button", { name: "Sign out" }).boundingBox();
  expect(signOutBox).not.toBeNull();
  expect(signOutBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
});

test("exam and tuition tables keep every column reachable on mobile via internal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginDemo(page);

  for (const route of ["/exams", "/tuition"]) {
    await page.goto(route);
    await expectNoPageOverflow(page);
    const wrapper = page.getByTestId("data-table").first();
    await expect(wrapper).toBeVisible();
    // The table is wider than the phone viewport, so the wrapper must scroll
    // internally (not clip): scrolling to the end reveals the last column.
    const { scrollWidth, clientWidth, overflowX } = await wrapper.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
    }));
    expect(overflowX).toBe("auto");
    expect(scrollWidth).toBeGreaterThan(clientWidth);
    const lastHeader = wrapper.locator("th").last();
    await wrapper.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(lastHeader).toBeInViewport();
  }
});

test("focus-visible ring remains rendered for interactive controls in light and dark mode", async ({ page }) => {
  await loginDemo(page);
  await page.goto("/settings");
  // A preceding keyboard event keeps the browser's focus-visible input-modality
  // heuristic on "keyboard" so a later programmatic .focus() still renders the
  // focus ring, matching how a real keyboard user would tab to the control.
  await page.keyboard.press("Tab");
  const toggle = page.getByRole("button", { name: "Toggle light and dark mode" });
  await toggle.focus();
  await expect(toggle).toBeFocused();
  const lightShadow = await toggle.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(lightShadow).not.toBe("none");

  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await page.keyboard.press("Tab");
  const signOut = page.getByRole("button", { name: "Sign out" });
  await signOut.focus();
  await expect(signOut).toBeFocused();
  const darkShadow = await signOut.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(darkShadow).not.toBe("none");
});
