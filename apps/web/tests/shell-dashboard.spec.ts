import { test, expect, authenticateDemoPage, loginDemoThroughUi, expectNoPageOverflow, REFERENCE_VIEWPORTS } from "./fixtures/base";
import { openMockedLookup } from "./fixtures/lookup";

for (const viewport of REFERENCE_VIEWPORTS.slice(2)) {
  test(`login, dashboard, timetable, and grades have no horizontal overflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await expectNoPageOverflow(page);
    await authenticateDemoPage(page);
    await expectNoPageOverflow(page);
    for (const route of ["/timetable", "/grades", "/exams", "/tuition"]) {
      await page.goto(route);
      await expectNoPageOverflow(page);
    }
  });
}

test("account menu opens and signs out", async ({ authenticatedPage: page }) => {
  const accountButton = page.getByRole("button", { name: "Open account menu" });
  await accountButton.click();
  await expect(page.getByTestId("account-trigger")).toHaveCSS("transform", /matrix\(0\.94/);
  await expect(page.getByRole("menuitem", { name: /Settings/i })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Add account/i })).toBeVisible();
  await page.getByRole("menuitem", { name: /Sign out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("friendly demo login opens dashboard", async ({ page }) => {
  await loginDemoThroughUi(page);
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

test("dashboard summary strip stays contained on mobile @webkit", async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

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

test("status labels render as readable text", async ({ authenticatedPage: page }) => {
  await expect(page.getByText("In progress", { exact: true })).toBeVisible();
  await expect(page.getByText("Not started", { exact: true })).toBeVisible();
  await expect(page.getByText("in_progress", { exact: true })).toHaveCount(0);
  await expect(page.getByText("not_started", { exact: true })).toHaveCount(0);
});

test("light and dark mode toggle changes rendered theme", async ({ authenticatedPage: page }) => {
  await page.goto("/settings");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await page.getByRole("button", { name: "Toggle light and dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await page.getByRole("button", { name: "Toggle light and dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
});

test("settings can switch between neutral and university theme styles", async ({ authenticatedPage: page }) => {
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

test("sidebar collapses and expands via toggle button", async ({ authenticatedPage: page, isMobile }) => {
  test.skip(isMobile, "desktop-only sidebar, hidden below the lg breakpoint on mobile");
  await expect(page.getByText("Demo", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Overview", { exact: true })).toBeVisible();
  await expect(page.getByText("Study", { exact: true })).toBeVisible();
  await expect(page.getByText("Utilities", { exact: true })).toBeVisible();
  await expect(page.getByText("System", { exact: true })).toBeVisible();
  await expect(page.getByText(/Powered by Hyeboard/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Student command center")).toHaveCount(0);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByText("Demo", { exact: true })).toBeHidden();
  await expect(page.getByText(/Powered by Hyeboard/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect.poll(async () => {
    const logoBox = await page.locator("aside [data-testid='brand-icon']").boundingBox();
    const expandBox = await page.getByRole("button", { name: "Expand sidebar" }).boundingBox();
    if (!logoBox || !expandBox) return false;
    const verticallySeparated = logoBox.y + logoBox.height <= expandBox.y;
    const horizontallyCentered = Math.abs((logoBox.x + logoBox.width / 2) - (expandBox.x + expandBox.width / 2)) <= 1;
    return verticallySeparated && horizontallyCentered;
  }).toBe(true);
  await expect(page.locator(".app-shell")).toHaveCSS("transition-property", /grid-template-columns/);
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.getByText("Demo", { exact: true }).first()).toBeVisible();
});

test("Utility accordion expands Lookup and persists on desktop", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop-only sidebar, hidden below the lg breakpoint on mobile");
  await openMockedLookup(page);
  await page.goto("/");

  const utility = page.getByRole("button", { name: "Expand Utility" });
  await utility.click();
  await expect(utility).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "Lookup" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Collapse Utility" })).toHaveAttribute("aria-expanded", "true");
});

test("Utility accordion opens Lookup in the mobile navigation drawer", async ({ page }) => {
  await openMockedLookup(page);
  await page.setViewportSize({ width: 500, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("button", { name: /Utility/ }).click();
  await expect(drawer.getByRole("link", { name: "Lookup" })).toBeVisible();
  await drawer.getByRole("link", { name: "Lookup" }).click();
  await expect(page).toHaveURL(/\/lookup$/);
});

test("mobile nav drawer opens and closes on navigation @webkit", async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 500, height: 900 });
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

test("mobile nav drawer links meet touch target size and restore focus on escape @webkit", async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
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

test("header search filters and navigates to a page", async ({ authenticatedPage: page }) => {
  const search = page.getByPlaceholder("Search pages...");
  await search.click();
  await search.fill("Grades");
  await expect(page.getByRole("button", { name: "Grades" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/grades$/);
});

test("notifications menu shows dashboard notifications", async ({ authenticatedPage: page }) => {
  const notificationsButton = page.getByRole("button", { name: "Notifications" });
  await notificationsButton.click();
  await expect(page.getByTestId("notifications-trigger")).toHaveCSS("transform", /matrix\(0\.94/);
  await expect(page.getByText("No notifications right now.").or(page.getByRole("menuitem").first())).toBeVisible();
});

test("settings About section shows version and commit information", async ({ authenticatedPage: page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
  await expect(page.getByText("Version")).toBeVisible();
  await expect(page.getByText(/^Commit /)).toBeVisible();
});

test("dashboard, timetable, grades, and login each expose exactly one page heading", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("h1")).toHaveCount(1);

  await authenticateDemoPage(page);
  await expect(page.locator("h1")).toHaveCount(1);

  await page.goto("/timetable");
  await expect(page.locator("h1")).toHaveCount(1);

  await page.goto("/grades");
  await expect(page.locator("h1")).toHaveCount(1);
});

test("sidebar nav links have accessible names and move aria-current on navigation", async ({ authenticatedPage: page, isMobile }) => {
  test.skip(isMobile, "desktop-only sidebar, hidden below the lg breakpoint on mobile");
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

test("header search field exposes an accessible name beyond its placeholder", async ({ authenticatedPage: page }) => {
  await expect(page.getByRole("textbox", { name: "Search pages" })).toBeVisible();
});
