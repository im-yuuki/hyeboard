import { test, expect, expectInsideViewport, expectNoPageOverflow } from "./fixtures/base";
import { downloadText, trackApiRequestCounts, expectExportFormats, expectAcademicCsvMatchesJson, expectOpenMenuUsesThemeTokens } from "./helpers/export";

test("grades default to the newest term, merge summer into term two, and expand row details", async ({ authenticatedPage: page }) => {
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

test("grades render derived term GPA and CPA and export current page and term state", async ({ authenticatedPage: page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
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

  const pageDocument = await expectExportFormats(page, "grades-page", apiRequestCount, {
    sourcePath: "/api/mock/grades",
    assertCsv: expectAcademicCsvMatchesJson,
  });
  expect(pageDocument).toMatchObject({
    surface: "grades-page",
    universityId: "mock",
    identity: { studentCode: expect.any(String), studentName: "Demo Student", managingClass: "K69CLC-C" },
    reported: { cumulativeGpa4: 3.48, totalCredits: 18, accumulatedCredits: 92 },
    derivedTerms: [{ termCode: "20251", estimateKind: "derived" }],
  });
  expect(pageDocument.derivedTerms).toHaveLength(1);
  expect(pageDocument.derivedTerms?.[0]?.termGpa4).toBeCloseTo(3.45);
  expect(pageDocument.derivedTerms?.[0]?.derivedCpa4).toBeCloseTo(3.43, 2);
  expect(pageDocument.derivedTerms?.[0]?.courses.map((course) => course.courseName)).toEqual(["Web Application Development", "Linear Algebra"]);
  expect(Object.keys(pageDocument.derivedTerms?.[0]?.courses[0] ?? {})).toEqual(["courseCode", "courseName", "credits", "point10", "letter", "point4"]);

  const termDocument = await expectExportFormats(page, "grades-term", apiRequestCount, {
    sourcePath: "/api/mock/grades",
    assertCsv: expectAcademicCsvMatchesJson,
  });
  expect(termDocument.derivedTerms).toHaveLength(1);
  expect(termDocument.derivedTerms?.[0]).toMatchObject({ termCode: "20251" });
  expect(termDocument.derivedTerms?.[0]?.termGpa4).toBeCloseTo(3.45);
  expect(termDocument.derivedTerms?.[0]?.derivedCpa4).toBeCloseTo(3.43, 2);
  expect(termDocument.derivedTerms?.[0]?.courses).toEqual(pageDocument.derivedTerms?.[0]?.courses);

  await page.getByRole("combobox", { name: "Term" }).click();
  await page.getByRole("option", { name: "All terms" }).click();
  await expect(page.getByTestId("academic-term-header")).toHaveCount(2);
  const allTermsDocument = await expectExportFormats(page, "grades-page", apiRequestCount, {
    sourcePath: "/api/mock/grades",
    assertCsv: expectAcademicCsvMatchesJson,
  });
  expect(allTermsDocument.derivedTerms?.map((term) => term.termCode)).toEqual(["20251", "20242"]);

  await page.goto("/settings");
  await page.getByRole("button", { name: "Toggle light and dark mode" }).click();
  await page.goto("/grades");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");

  const resultText = page.getByText("Web Application Development");
  const exportRoot = page.locator('[data-export-surface="grades-page"]');
  const themedTrigger = exportRoot.getByRole("button", { name: "Export" });
  await themedTrigger.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("menuitem", { name: "Download JSON" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Download CSV" })).toBeFocused();
  const darkMenuTheme = await expectOpenMenuUsesThemeTokens(page);
  await page.keyboard.press("Escape");
  await expect(themedTrigger).toBeFocused();

  await page.evaluate(() => { document.documentElement.dataset.theme = "uet"; });
  await themedTrigger.click();
  await page.keyboard.press("ArrowDown");
  const uetMenuTheme = await expectOpenMenuUsesThemeTokens(page);
  expect(uetMenuTheme.itemBackground).not.toBe(darkMenuTheme.itemBackground);
  expect(uetMenuTheme.itemForeground).not.toBe(darkMenuTheme.itemForeground);
  await page.keyboard.press("Escape");

  const requestsBeforePrint = apiRequestCount.snapshot();
  await page.evaluate(() => {
    const events: string[] = [];
    Object.defineProperty(window, "open", {
      configurable: true,
      value: () => ({ document: { write: () => events.push("write"), close: () => events.push("close") }, print: () => events.push("print"), opener: window }),
    });
    (window as typeof window & { __printExportEvents?: string[] }).__printExportEvents = events;
  });
  await themedTrigger.click();
  await page.getByRole("menuitem", { name: "Print / Save PDF" }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __printExportEvents?: string[] }).__printExportEvents)).toEqual(["write", "close", "print"]);
  expect(apiRequestCount.snapshot()).toEqual(requestsBeforePrint);
  await expect(resultText).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => { throw new Error("synthetic download failure"); },
    });
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await themedTrigger.click();
    await page.getByRole("menuitem", { name: "Download JSON" }).click();
    await expect(exportRoot.getByRole("status"))
      .toContainText("The export could not be downloaded. Your result is unchanged; try again.");
    await expect(exportRoot.getByRole("status")).toHaveAttribute("aria-live", "polite");
    await expect(resultText).toBeVisible();
  }

  await page.goto("/settings");
  await page.getByRole("combobox", { name: "Language" }).click();
  await page.getByRole("option", { name: "Tiếng Việt" }).click();
  await page.goto("/grades");
  await page.evaluate(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => { throw new Error("synthetic download failure"); },
    });
  });
  const localizedRoot = page.locator('[data-export-surface="grades-page"]');
  await localizedRoot.getByRole("button", { name: "Xuất dữ liệu" }).click();
  await expect(page.getByRole("menuitem", { name: "Tải JSON" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Tải CSV" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "In / Lưu PDF" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Tải JSON" }).click();
  await expect(localizedRoot.getByRole("status"))
    .toContainText("Không thể tải dữ liệu xuất. Kết quả vẫn được giữ nguyên; hãy thử lại.");
  await expect(localizedRoot.getByRole("status")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByText("Web Application Development")).toBeVisible();
});

test("grades keep missing and reserved term identities collision-safe", async ({ authenticatedPage: page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
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

  const document = await expectExportFormats(page, "grades-page", apiRequestCount, {
    sourcePath: "/api/mock/grades",
    assertCsv: expectAcademicCsvMatchesJson,
  });
  const termIdentities = document.derivedTerms?.map((term) => [term.termCode, term.termLabel]);
  expect(termIdentities).toEqual(expect.arrayContaining([
    ["unknown", "Unknown term"],
    ["unknown", "unknown"],
    ["all", "all"],
    ["~hyeboard:known:reserved", "~hyeboard:known:reserved"],
  ]));
  const numericTerm = document.derivedTerms?.find((term) => term.termCode === "251");
  const spacedTerm = document.derivedTerms?.find((term) => term.termCode === " 251 ");
  expect(numericTerm?.courses.map((course) => course.courseName)).toEqual(["Numeric term"]);
  expect(spacedTerm?.courses.map((course) => course.courseName)).toEqual(["Spaced numeric term"]);
});

test("grades exports wait for dashboard metadata without blocking grades", async ({ authenticatedPage: page }) => {
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

test("export menu keeps download focus and remains contained across viewports @webkit", async ({ authenticatedPage: page }) => {
  await page.goto("/grades");
  const resultText = page.getByText("Web Application Development");
  await expect(resultText).toBeVisible();

  const exportRoot = page.locator('[data-export-surface="grades-page"]');
  const trigger = exportRoot.getByRole("button", { name: "Export" });

  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expectNoPageOverflow(page);
    await expectInsideViewport(page, trigger);
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox!.height).toBeGreaterThanOrEqual(43.9);

    const featureHeader = page.getByRole("heading", { name: "Grades", exact: true }).locator("..").locator("..");
    const featureHeaderBox = await featureHeader.boundingBox();
    expect(featureHeaderBox).not.toBeNull();
    expect(triggerBox!.x).toBeGreaterThanOrEqual(featureHeaderBox!.x);
    expect(triggerBox!.y).toBeGreaterThanOrEqual(featureHeaderBox!.y);
    expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(featureHeaderBox!.x + featureHeaderBox!.width + 1);
    expect(triggerBox!.y + triggerBox!.height).toBeLessThanOrEqual(featureHeaderBox!.y + featureHeaderBox!.height + 1);
    expect(await featureHeader.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    const termHeader = page.getByTestId("academic-term-header").first();
    const termTrigger = termHeader.getByRole("button", { name: "Export" });
    const termHeaderBox = await termHeader.boundingBox();
    const termTriggerBox = await termTrigger.boundingBox();
    expect(termHeaderBox).not.toBeNull();
    expect(termTriggerBox).not.toBeNull();
    expect(termTriggerBox!.x).toBeGreaterThanOrEqual(termHeaderBox!.x);
    expect(termTriggerBox!.y).toBeGreaterThanOrEqual(termHeaderBox!.y);
    expect(termTriggerBox!.x + termTriggerBox!.width).toBeLessThanOrEqual(termHeaderBox!.x + termHeaderBox!.width + 1);
    expect(termTriggerBox!.y + termTriggerBox!.height).toBeLessThanOrEqual(termHeaderBox!.y + termHeaderBox!.height + 1);
    expect(await termHeader.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    await trigger.click();
    const openMenu = page.getByRole("menu");
    await expect(openMenu).toBeVisible();
    for (const menuItem of await page.getByRole("menuitem").all()) {
      const menuItemBox = await menuItem.boundingBox();
      expect(menuItemBox).not.toBeNull();
      expect(menuItemBox!.height).toBeGreaterThanOrEqual(43.9);
    }
    await expectInsideViewport(page, openMenu);
    const menuBox = await openMenu.boundingBox();
    expect(menuBox!.height).toBeGreaterThanOrEqual(43.9 * 2);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }

  const downloadPromise = page.waitForEvent("download");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^hyeboard-grades-page-\d{4}-\d{2}-\d{2}\.json$/);
  expect(JSON.parse(await downloadText(download))).toMatchObject({ surface: "grades-page" });
  await expect(trigger).toBeFocused();
  await expect(resultText).toBeVisible();
});
