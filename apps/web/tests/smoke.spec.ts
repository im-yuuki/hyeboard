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

async function clickVisibleNavigationLink(
  page: import("@playwright/test").Page,
  href: "/" | "/settings",
  isMobile: boolean,
): Promise<void> {
  if (isMobile) await page.getByRole("button", { name: "Open navigation menu" }).click();
  const link = page.locator(`a[href="${href}"]:visible`);
  await expect(link).toHaveCount(1);
  await link.click();
}

async function startMockedVnuSession(
  page: import("@playwright/test").Page,
  error: { code?: string; status: number; message: string },
  options: { deferRawResponses?: boolean } = {},
) {
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

const SYNTHETIC_OWN_STUDENT_CODE = "99000000";
const SYNTHETIC_TARGET_STUDENT_CODE = "99000001";
const SYNTHETIC_ERROR_STUDENT_CODE = "99000002";
const SYNTHETIC_OWN_INTERNAL_ID = "99000000000";
const SYNTHETIC_TARGET_INTERNAL_ID = "99000000001";
const SYNTHETIC_ERROR_INTERNAL_ID = "99000000002";
const SYNTHETIC_CLASS_ID = "990099";

type LookupRequestCounts = { exams: number; studentCode: number; studentId: number; transcript: number };

async function openMockedLookup(page: import("@playwright/test").Page, bulkMaximum: number | null = 50): Promise<LookupRequestCounts> {
  const requestCounts: LookupRequestCounts = { exams: 0, studentCode: 0, studentId: 0, transcript: 0 };
  await page.route("**/api/universities", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { data: Array<{ id: string; capabilities: Record<string, boolean>; limits?: { crossLookup?: { bulkMaxTargets: number } } }> };
    const mock = payload.data.find((university) => university.id === "mock");
    if (mock) {
      mock.capabilities.classLookup = true;
      mock.capabilities.crossLookup = true;
      if (bulkMaximum === null) delete mock.limits;
      else mock.limits = { crossLookup: { bulkMaxTargets: bulkMaximum } };
    }
    await route.fulfill({ response, json: payload });
  });
  await page.route("**/api/vnu/raw/profile", async (route) => {
    const html = `<input name="StdCode" value="${SYNTHETIC_OWN_STUDENT_CODE}"><input name="StdName" value="Synthetic Demo"><input name="hidStdID" value="${SYNTHETIC_OWN_INTERNAL_ID}">`;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { html } }) });
  });
  await page.route("**/api/vnu/raw/exams**", async (route) => {
    requestCounts.exams += 1;
    const html = `<table><tr><td>1</td><td>252-SYN9900-99</td><td>Synthetic Export Systems</td><td>31/12/2099</td><td>9(09:00)</td><td>Synthetic</td><td>LAB-99</td><td>99</td><td><input name="hidCrdID" value="${SYNTHETIC_CLASS_ID}"></td></tr></table>`;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { html } }) });
  });
  await page.route("**/api/vnu/raw/point-detail**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { html: `<table><tr><td>1</td><td>Giữa kỳ</td><td>0.4</td><td>1</td><td>8.5</td></tr><tr><td>2</td><td>Thi cuối kỳ</td><td>0.6</td><td>1</td><td>9</td></tr><tr><td>Tổng điểm: 8.8</td></tr></table>` }, error: null }) });
  });
  await page.route("**/api/vnu/cross-lookup/student-code**", async (route) => {
    requestCounts.studentCode += 1;
    const isError = new URL(route.request().url()).searchParams.get("stdId") === SYNTHETIC_ERROR_INTERNAL_ID;
    await route.fulfill({
      status: isError ? 404 : 200,
      contentType: "application/json",
      body: JSON.stringify(isError
        ? { data: null, error: { code: "VNU_CROSS_LOOKUP_NOT_FOUND", message: "Synthetic not found" } }
        : { data: { studentCode: SYNTHETIC_TARGET_STUDENT_CODE, studentName: "Synthetic Target", className: "SYNTHETIC-99" }, error: null }),
    });
  });
  await page.route("**/api/vnu/cross-lookup/student-id**", async (route) => {
    requestCounts.studentId += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { stdCode: SYNTHETIC_TARGET_STUDENT_CODE, stdId: SYNTHETIC_TARGET_INTERNAL_ID, probes: 2 }, error: null }) });
  });
  await page.route("**/api/vnu/cross-lookup/transcript**", async (route) => {
    requestCounts.transcript += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: {
        header: { studentCode: SYNTHETIC_TARGET_STUDENT_CODE, studentName: "Synthetic Target", className: "SYNTHETIC-99" },
        totals: { totalCredits: 8, accumulatedCredits: 6, gpa4: 3.91 },
        terms: [
          { maHK: "251", rows: [{ courseCode: "SYN9901", courseName: "Synthetic Foundations", credits: 3, grade10: 8, letterGrade: "B", grade4: 3 }] },
          { maHK: "252", rows: [
            { courseCode: "SYN9902", courseName: "Synthetic Resolution", credits: 3, grade10: 9, letterGrade: "A", grade4: 4 },
            { courseCode: "SYN9903", courseName: "Synthetic Pending", credits: 2 },
          ] },
        ],
      }, error: null }),
    });
  });
  await loginDemo(page);
  await page.goto("/lookup");
  await expect(page.getByRole("heading", { name: "Lookup", exact: true })).toBeVisible();
  return requestCounts;
}

async function switchDemoShellToVnu(page: import("@playwright/test").Page): Promise<void> {
  await loginDemo(page);
  await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<Record<string, unknown>>;
    const activeAccountId = localStorage.getItem("hyeboard.activeAccountId");
    localStorage.setItem("hyeboard.accounts", JSON.stringify(accounts.map((account) => (
      account.id === activeAccountId ? { ...account, universityId: "vnu" } : account
    ))));
    localStorage.setItem("hyeboard.universityId", "vnu");
    window.dispatchEvent(new CustomEvent("hyeboard:account-switched"));
  });
}

async function openMockedVnuLookup(page: import("@playwright/test").Page): Promise<() => number> {
  let examRequests = 0;
  await page.route("**/api/vnu/raw/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/vnu/raw/exams") examRequests += 1;
    const html = path === "/api/vnu/raw/exams"
      ? `<table><tr><td>1</td><td>252-INT&nbsp;3103-CN7</td><td>Synthetic Search Systems</td><td>31/12/2099</td><td>9(09:00)</td><td>Synthetic</td><td>LAB-SYNTHETIC</td><td>1</td><td><input name="hidCrdID" value="SYNTHETIC-VNU-CLASS-ID"></td></tr></table>`
      : "<main></main>";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { html }, error: null }) });
  });
  await switchDemoShellToVnu(page);
  await page.goto("/lookup");
  await expect(page.getByRole("heading", { name: "Lookup", exact: true })).toBeVisible();
  return () => examRequests;
}

async function openMockedVnuDocuments(page: import("@playwright/test").Page): Promise<() => number> {
  let syllabusRequests = 0;
  await page.route("**/api/vnu/raw/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/vnu/raw/syllabus") syllabusRequests += 1;
    const html = path === "/api/vnu/raw/syllabus"
      ? `<table><tr><td>1</td><td>INT&nbsp;3103</td><td>Synthetic Syllabus</td><td>3</td><td><a href="synthetic.pdf">PDF</a></td><td></td><td>1 KB</td><td>31/12/2099</td></tr></table>`
      : "<main></main>";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { html }, error: null }) });
  });
  await switchDemoShellToVnu(page);
  await page.goto("/documents");
  await expect(page.getByText("INT 3103 — Synthetic Syllabus")).toBeVisible();
  return () => syllabusRequests;
}

type ApiRequestSnapshot = {
  total: number;
  paths: Array<readonly [string, number]>;
};

type ApiRequestTracker = {
  count(path: string): number;
  snapshot(): ApiRequestSnapshot;
};

function trackApiRequestCounts(page: import("@playwright/test").Page): ApiRequestTracker {
  const counts = new Map<string, number>();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) counts.set(path, (counts.get(path) ?? 0) + 1);
  });
  return {
    count: (path) => counts.get(path) ?? 0,
    snapshot: () => {
      const paths = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
      return { total: paths.reduce((total, [, count]) => total + count, 0), paths };
    },
  };
}

function parseDownloadedRfc4180Csv(input: string): string[][] {
  expect(input.charCodeAt(0)).toBe(0xfeff);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  let index = 1;

  while (index < input.length) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (character === '"') {
        quoted = false;
        quoteClosed = true;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (quoteClosed && character !== "," && character !== "\r") {
      throw new Error("Unexpected character after closing CSV quote");
    }
    if (character === '"') {
      if (field !== "") throw new Error("Unexpected quote inside unquoted CSV field");
      quoted = true;
      index += 1;
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      quoteClosed = false;
      index += 1;
      continue;
    }
    if (character === "\r") {
      if (input[index + 1] !== "\n") throw new Error("CSV records must use CRLF separators");
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      quoteClosed = false;
      index += 2;
      continue;
    }
    if (character === "\n") throw new Error("Bare LF outside a quoted CSV field");
    field += character;
    index += 1;
  }

  if (quoted) throw new Error("Unclosed quoted CSV field");
  if (quoteClosed || row.length > 0 || field.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

type DownloadedIdentity = {
  studentCode?: string;
  internalStudentId?: string;
  studentName?: string;
  managingClass?: string;
};

type DownloadedCourse = {
  courseCode: string;
  courseName: string;
  credits?: number;
  point10?: number;
  letter?: string;
  point4?: number;
};

type DownloadedTerm = {
  termCode: string;
  termLabel?: string;
  estimateKind?: string;
  listedCredits?: number;
  includedCredits?: number;
  termGpa4?: number;
  derivedCpa4?: number;
  courses: DownloadedCourse[];
  [key: string]: unknown;
};

type DownloadedResult = {
  target?: string;
  status?: string;
  errorCode?: string;
  identity?: DownloadedIdentity;
  classResult?: { classCode: string; classNumber?: string; classId: string; courseName?: string };
  resolver?: { resolvedStudentCode: string; resolvedInternalStudentId: string; probes: number };
  reported?: { cumulativeGpa4?: number };
  derivedTerms?: DownloadedTerm[];
  result?: DownloadedResult;
};

type DownloadedExport = {
  surface: string;
  universityId?: string;
  query?: { mode: string; value: string };
  identity?: DownloadedIdentity;
  reported?: { cumulativeGpa4?: number };
  derivedTerms?: DownloadedTerm[];
  run?: { status: string; mode: string; processedCount: number; totalCount: number };
  results?: DownloadedResult[];
};

type CsvRecord = Record<string, string>;
type CsvExpectation = Record<string, string>;

function csvIdentifier(value: string): string {
  return `'${value}`;
}

function csvValue(value: string | number | undefined): string {
  return value === undefined ? "" : String(value);
}

function expectExactCsvRecords(records: CsvRecord[], expectations: CsvExpectation[]): void {
  expect(records, "CSV emitted an unexpected number of records").toHaveLength(expectations.length);
  expectations.forEach((expectedRecord, index) => {
    expect(records[index], `Unexpected CSV record at index ${index}`).toMatchObject(expectedRecord);
  });
}

function expectAcademicCsvMatchesJson(model: DownloadedExport, records: CsvRecord[]): void {
  const expectedRecords: CsvExpectation[] = [];
  if (model.query) {
    expectedRecords.push({ record_type: "query", query_mode: model.query.mode, query_value: csvIdentifier(model.query.value) });
  }
  if (model.identity) {
    expectedRecords.push({
      record_type: "identity",
      student_code: model.identity.studentCode ? csvIdentifier(model.identity.studentCode) : "",
      internal_student_id: model.identity.internalStudentId ? csvIdentifier(model.identity.internalStudentId) : "",
      student_name: model.identity.studentName ?? "",
      managing_class: model.identity.managingClass ? csvIdentifier(model.identity.managingClass) : "",
    });
  }
  if (model.reported) {
    expectedRecords.push({ record_type: "reported_summary", reported_cumulative_gpa4: csvValue(model.reported.cumulativeGpa4) });
  }
  for (const term of model.derivedTerms ?? []) {
    expectedRecords.push({
      record_type: "term_summary",
      term_code: csvIdentifier(term.termCode),
      listed_credits: csvValue(term.listedCredits),
      included_credits: csvValue(term.includedCredits),
      term_gpa4: csvValue(term.termGpa4),
      derived_cpa4: csvValue(term.derivedCpa4),
    });
    for (const course of term.courses) {
      expectedRecords.push({
        record_type: "course",
        term_code: csvIdentifier(term.termCode),
        course_code: csvIdentifier(course.courseCode),
        course_name: course.courseName,
        credits: csvValue(course.credits),
        point10: csvValue(course.point10),
        letter: csvValue(course.letter),
        point4: csvValue(course.point4),
      });
    }
  }
  expectExactCsvRecords(records, expectedRecords);
}

function expectClassCsvMatchesJson(model: DownloadedExport, records: CsvRecord[]): void {
  const classResult = model.results?.[0]?.classResult;
  expect(model.query).toBeDefined();
  expect(classResult).toBeDefined();
  expectExactCsvRecords(records, [
    { record_type: "query", query_mode: model.query!.mode, query_value: csvIdentifier(model.query!.value) },
    {
      record_type: "result",
      class_code: csvIdentifier(classResult!.classCode),
      class_number: classResult!.classNumber ? csvIdentifier(classResult!.classNumber) : "",
      class_id: csvIdentifier(classResult!.classId),
      course_name: classResult!.courseName ?? "",
    },
  ]);
}

function expectResolverCsvMatchesJson(model: DownloadedExport, records: CsvRecord[]): void {
  const result = model.results?.[0];
  expect(model.query).toBeDefined();
  expect(result).toBeDefined();
  const resultExpectation: CsvExpectation = result?.resolver
    ? {
        record_type: "result",
        resolved_student_code: csvIdentifier(result.resolver.resolvedStudentCode),
        resolved_internal_student_id: csvIdentifier(result.resolver.resolvedInternalStudentId),
        probes: String(result.resolver.probes),
      }
    : {
        record_type: "result",
        student_code: result?.identity?.studentCode ? csvIdentifier(result.identity.studentCode) : "",
        internal_student_id: result?.identity?.internalStudentId ? csvIdentifier(result.identity.internalStudentId) : "",
        student_name: result?.identity?.studentName ?? "",
      };
  expectExactCsvRecords(records, [
    { record_type: "query", query_mode: model.query!.mode, query_value: csvIdentifier(model.query!.value) },
    resultExpectation,
  ]);
}

function expectBulkCsvMatchesJson(model: DownloadedExport, records: CsvRecord[]): void {
  const run = model.run;
  const results = model.results ?? [];
  expect(run).toBeDefined();
  expect(results).toHaveLength(run!.processedCount);

  const expectedRecords = results.flatMap((item, index): CsvExpectation[] => {
    const base = (recordType: string): CsvExpectation => ({
      item_index: String(index + 1),
      record_type: recordType,
      run_status: run!.status,
      status: item.status!,
      target: csvIdentifier(item.target!),
    });
    if (item.status === "error") return [{ ...base("item"), error_code: item.errorCode! }];

    const result = item.result;
    expect(result).toBeDefined();
    const itemRecords: CsvExpectation[] = [];
    if (result?.identity) {
      itemRecords.push({
        ...base(result.derivedTerms !== undefined || result.reported !== undefined ? "identity" : "result"),
        student_code: result.identity.studentCode ? csvIdentifier(result.identity.studentCode) : "",
        internal_student_id: result.identity.internalStudentId ? csvIdentifier(result.identity.internalStudentId) : "",
        student_name: result.identity.studentName ?? "",
        managing_class: result.identity.managingClass ? csvIdentifier(result.identity.managingClass) : "",
      });
    }
    if (result?.classResult) {
      itemRecords.push({
        ...base("result"),
        class_code: csvIdentifier(result.classResult.classCode),
        class_number: result.classResult.classNumber ? csvIdentifier(result.classResult.classNumber) : "",
        class_id: csvIdentifier(result.classResult.classId),
        course_name: result.classResult.courseName ?? "",
      });
    }
    if (result?.resolver) {
      itemRecords.push({
        ...base("result"),
        resolved_student_code: csvIdentifier(result.resolver.resolvedStudentCode),
        resolved_internal_student_id: csvIdentifier(result.resolver.resolvedInternalStudentId),
        probes: String(result.resolver.probes),
      });
    }
    if (result?.reported) {
      itemRecords.push({ ...base("reported_summary"), reported_cumulative_gpa4: csvValue(result.reported.cumulativeGpa4) });
    }
    for (const term of result?.derivedTerms ?? []) {
      itemRecords.push({
        ...base("term_summary"),
        term_code: csvIdentifier(term.termCode),
        listed_credits: csvValue(term.listedCredits),
        included_credits: csvValue(term.includedCredits),
        term_gpa4: csvValue(term.termGpa4),
        derived_cpa4: csvValue(term.derivedCpa4),
      });
      for (const course of term.courses) {
        itemRecords.push({
          ...base("course"),
          term_code: csvIdentifier(term.termCode),
          course_code: csvIdentifier(course.courseCode),
          course_name: course.courseName,
          credits: csvValue(course.credits),
          point10: csvValue(course.point10),
          letter: csvValue(course.letter),
          point4: csvValue(course.point4),
        });
      }
    }
    return itemRecords;
  });
  expectExactCsvRecords(records, expectedRecords);
}

type ExportFormatExpectations = {
  sourcePath: string;
  assertCsv(model: DownloadedExport, records: CsvRecord[]): void;
};

async function expectExportFormats(
  page: import("@playwright/test").Page,
  surface: string,
  apiRequests: ApiRequestTracker,
  expectations: ExportFormatExpectations,
): Promise<DownloadedExport> {
  const exportRoot = page.locator(`[data-export-surface="${surface}"]`).first();
  const trigger = exportRoot.getByRole("button", { name: "Export" });
  expect(apiRequests.count(expectations.sourcePath), `Expected source request ${expectations.sourcePath}`).toBeGreaterThan(0);

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Download JSON" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  const requestsBeforeJson = apiRequests.snapshot();
  const jsonPromise = page.waitForEvent("download");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  const jsonDownload = await jsonPromise;
  expect(jsonDownload.suggestedFilename()).toMatch(new RegExp(`^hyeboard-${surface}-\\d{4}-\\d{2}-\\d{2}\\.json$`));
  const jsonModel = JSON.parse(await downloadText(jsonDownload)) as DownloadedExport;
  expect(jsonModel.surface).toBe(surface);
  expect(jsonModel.derivedTerms?.length ?? jsonModel.results?.length ?? 0).toBeGreaterThan(0);
  expect(apiRequests.snapshot()).toEqual(requestsBeforeJson);
  await expect(trigger).toBeFocused();

  const requestsBeforeCsv = apiRequests.snapshot();
  const csvPromise = page.waitForEvent("download");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Download CSV" }).click();
  const csvDownload = await csvPromise;
  expect(csvDownload.suggestedFilename()).toMatch(new RegExp(`^hyeboard-${surface}-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
  const csvRows = parseDownloadedRfc4180Csv(await downloadText(csvDownload));
  const csvHeader = csvRows[0]!;
  expect(csvHeader.slice(0, 3)).toEqual(["record_type", "surface", "run_status"]);
  const surfaceColumn = csvHeader.indexOf("surface");
  expect(surfaceColumn).toBeGreaterThanOrEqual(0);
  const csvRecords = csvRows.slice(1).map((row) => Object.fromEntries(csvHeader.map((header, index) => [header, row[index] ?? ""])));
  expect(csvRecords.length).toBeGreaterThan(0);
  expect(csvRecords.every((record) => record.surface === surface)).toBe(true);
  expectations.assertCsv(jsonModel, csvRecords);
  expect(apiRequests.snapshot()).toEqual(requestsBeforeCsv);
  await expect(trigger).toBeFocused();
  return jsonModel;
}

async function expectInsideViewport(page: import("@playwright/test").Page, locator: import("@playwright/test").Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
}

async function readOpenMenuTheme(page: import("@playwright/test").Page) {
  return page.getByRole("menu").evaluate((menu) => {
    const createTokenProbe = (background: string, color: string) => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = background;
      probe.style.color = color;
      document.body.append(probe);
      const styles = getComputedStyle(probe);
      const result = { background: styles.backgroundColor, color: styles.color };
      probe.remove();
      return result;
    };
    const cardToken = createTokenProbe("hsl(var(--card))", "hsl(var(--card-foreground))");
    const accentToken = createTokenProbe("hsl(var(--accent))", "hsl(var(--accent-foreground))");
    const menuStyles = getComputedStyle(menu);
    const highlightedItem = menu.querySelector<HTMLElement>('[role="menuitem"][data-highlighted]');
    if (!highlightedItem) throw new Error("Export menu has no highlighted keyboard item");
    const itemStyles = getComputedStyle(highlightedItem);
    return {
      menuBackground: menuStyles.backgroundColor,
      menuForeground: menuStyles.color,
      itemBackground: itemStyles.backgroundColor,
      itemForeground: itemStyles.color,
      cardToken,
      accentToken,
    };
  });
}

async function expectOpenMenuUsesThemeTokens(page: import("@playwright/test").Page) {
  await expect.poll(async () => {
    const theme = await readOpenMenuTheme(page);
    return {
      menuBackground: theme.menuBackground === theme.cardToken.background,
      menuForeground: theme.menuForeground === theme.cardToken.color,
      itemBackground: theme.itemBackground === theme.accentToken.background,
      itemForeground: theme.itemForeground === theme.accentToken.color,
    };
  }).toEqual({ menuBackground: true, menuForeground: true, itemBackground: true, itemForeground: true });
  return readOpenMenuTheme(page);
}

type SyntheticBulkMode = "stdid-to-code" | "code-to-stdid" | "stdid-to-transcript";

function syntheticBulkResult(mode: SyntheticBulkMode, target: string) {
  const suffix = target.slice(-2);
  if (mode === "stdid-to-code") return { studentCode: `990001${suffix}`, studentName: `Synthetic 99${suffix}`, className: "SYNTHETIC-99", ignoredField: "must-not-export" };
  if (mode === "code-to-stdid") return { stdCode: target, stdId: `990000001${suffix}`, probes: Number(suffix), ignoredField: "must-not-export" };
  return {
    header: { studentCode: `990001${suffix}`, studentName: `Synthetic 99${suffix}`, className: "SYNTHETIC-99", ignoredField: "must-not-export" },
    totals: { totalCredits: 3, accumulatedCredits: 3, gpa4: 4, ignoredField: "must-not-export" },
    terms: [{ maHK: "252", ignoredField: "must-not-export", rows: [{ courseCode: `SYN99${suffix}`, courseName: `Synthetic Course 99${suffix}`, credits: 3, grade10: 9, letterGrade: "A", grade4: 4, ignoredField: "must-not-export" }] }],
    ignoredField: "must-not-export",
  };
}

async function fulfillBulkSuccess(route: import("@playwright/test").Route, chunks: string[][]) {
  const body = route.request().postDataJSON() as { mode: SyntheticBulkMode; targets: string[] };
  chunks.push([...body.targets]);
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { items: body.targets.map((target) => ({ target, status: "ok", result: syntheticBulkResult(body.mode, target) })) }, error: null }),
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
});

test("downloaded CSV parser rejects characters after a closing quote", () => {
  expect(() => parseDownloadedRfc4180Csv('\ufeff"value"junk\r\n'))
    .toThrow("Unexpected character after closing CSV quote");
});

test("downloaded CSV parser preserves quoted controls and doubled quotes", () => {
  expect(parseDownloadedRfc4180Csv('\ufeff"LF\nCR\rCRLF\r\nQuote ""ok""",tail\r\n"EOF"'))
    .toEqual([["LF\nCR\rCRLF\r\nQuote \"ok\"", "tail"], ["EOF"]]);
});

test("CSV record assertions reject injected rows", () => {
  const expected = [{ record_type: "query" }, { record_type: "result" }];
  const withInjectedRow = [{ record_type: "query" }, { record_type: "injected" }, { record_type: "result" }];
  expect(() => expectExactCsvRecords(withInjectedRow, expected)).toThrow();
});

test("CSV record assertions reject reordered bulk item groups", () => {
  const model: DownloadedExport = {
    surface: "bulk-id-to-code",
    run: { status: "complete", mode: "stdid-to-code", processedCount: 2, totalCount: 2 },
    results: [
      { target: "99000000001", status: "ok", result: { identity: { studentCode: "99000001" } } },
      { target: "99000000002", status: "ok", result: { identity: { studentCode: "99000002" } } },
    ],
  };
  const reorderedRecords = [
    { item_index: "2", record_type: "result", run_status: "complete", status: "ok", target: "'99000000002", student_code: "'99000002" },
    { item_index: "1", record_type: "result", run_status: "complete", status: "ok", target: "'99000000001", student_code: "'99000001" },
  ];
  expect(() => expectBulkCsvMatchesJson(model, reorderedRecords)).toThrow();
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

test("VNU plaintext input never enters storage while UET relogin persistence remains", async ({ page }) => {
  await page.route("**/api/vnu/auth/import-session", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ data: null, error: { code: "INVALID_VNU_CREDENTIAL", message: "Synthetic invalid VNU credential" } }),
  }));
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
  await page.getByRole("button", { name: "Import university session", exact: true }).click();
  await expect(page.getByText("Synthetic invalid VNU credential")).toBeVisible();
  expect(await page.evaluate(() => ({
    username: sessionStorage.getItem("hyeboard.relogin.vnu.username"),
    password: sessionStorage.getItem("hyeboard.relogin.vnu.password"),
    grantKeys: Object.keys(sessionStorage).filter((key) => key.startsWith("hyeboard.vnu.refreshGrant.")),
    local: JSON.stringify({ ...localStorage }),
  }))).toEqual({ username: null, password: null, grantKeys: [], local: expect.not.stringContaining("vnu-relogin-password") });
  await page.reload();

  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await expect(page.getByPlaceholder("Student code / username")).toHaveValue("");
  await expect(page.getByPlaceholder("Password")).toHaveValue("");
});

test("VNU plaintext is absent after session expiry and manual sign-in is empty", async ({ page }) => {
  await startMockedVnuSession(page, {
    code: "VNU_SESSION_EXPIRED",
    status: 401,
    message: "Synthetic VNU session expired",
  });

  await expect(page).toHaveURL(/\/login$/);
  const storage = await page.evaluate(() => ({
    accounts: JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as unknown[],
    activeAccountId: localStorage.getItem("hyeboard.activeAccountId"),
  }));
  expect(storage.accounts).toHaveLength(0);
  expect(storage.activeAccountId).toBeNull();

  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await expect(page.getByLabel("Username")).toHaveValue("");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");

  const credentialStorage = await page.evaluate(() => {
    const credentialEntries = Object.entries(sessionStorage).filter(([, value]) => value === "synthetic-vnu-user" || value === "synthetic-vnu-password");
    return {
      sessionCredentials: Object.fromEntries(credentialEntries),
      localStorageSerialized: JSON.stringify({ ...localStorage }),
    };
  });
  expect(credentialStorage.sessionCredentials).toEqual({});
  expect(credentialStorage.localStorageSerialized).not.toContain("synthetic-vnu-user");
  expect(credentialStorage.localStorageSerialized).not.toContain("synthetic-vnu-password");

  const newTab = await page.context().newPage();
  await newTab.goto("/login");
  await newTab.getByRole("combobox", { name: "School" }).click();
  await newTab.getByRole("option", { name: "VNU (daotao)" }).click();
  await expect(newTab.getByLabel("Username")).toHaveValue("");
  await expect(newTab.getByLabel("Password", { exact: true })).toHaveValue("");
  expect(await newTab.evaluate(() => ({
    username: sessionStorage.getItem("hyeboard.relogin.vnu.username"),
    password: sessionStorage.getItem("hyeboard.relogin.vnu.password"),
  }))).toEqual({ username: null, password: null });
  await newTab.close();
});

test("VNU grant import is account-scoped and deletes legacy plaintext", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/vnu/auth/import-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: {
      token: "synthetic-scoped-access",
      refreshGrant: "synthetic-scoped-grant",
      session: { authenticated: true, universityId: "vnu", studentCode: "SYNTHETIC-SCOPED-STUDENT", expiresAt: "2099-01-01T00:00:00.000Z" },
    }, error: null }),
  }));
  await page.goto("/login");
  await page.evaluate(() => {
    sessionStorage.setItem("hyeboard.relogin.vnu.username", "legacy-synthetic-user");
    sessionStorage.setItem("hyeboard.relogin.vnu.password", "legacy-synthetic-password");
  });
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await page.getByLabel("Username").fill("SYNTHETIC-SCOPED-USER");
  await page.getByLabel("Password", { exact: true }).fill("SYNTHETIC-SCOPED-PASSWORD");
  await page.getByRole("button", { name: "Import university session", exact: true }).click();

  await expect.poll(() => page.evaluate(() => {
    const account = (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string; studentCode?: string }>).find((item) => item.studentCode === "SYNTHETIC-SCOPED-STUDENT");
    return account ? {
      grant: sessionStorage.getItem(`hyeboard.vnu.refreshGrant.${account.id}`),
      username: sessionStorage.getItem("hyeboard.relogin.vnu.username"),
      password: sessionStorage.getItem("hyeboard.relogin.vnu.password"),
    } : null;
  })).toEqual({ grant: "synthetic-scoped-grant", username: null, password: null });
});

const NEW_TAB_VNU_ACCOUNT_ID = "synthetic-vnu-new-tab";
const NEW_TAB_SURVIVOR = { id: "synthetic-new-tab-survivor", universityId: "mock", token: "synthetic-survivor-token", studentCode: "SYNTHETIC-SURVIVOR", addedAt: "2099-01-01T00:00:00.000Z" };

async function seedNewTabDescriptorScenario(
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

async function seedExpiringNewTabAccount(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/login");
  await page.evaluate((accountId) => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([{ id: accountId, universityId: "vnu", token: "synthetic-expiring-new-tab-token", studentCode: "SYNTHETIC-NEW-TAB", addedAt: "2099-01-01T00:00:00.000Z" }]));
    localStorage.setItem("hyeboard.activeAccountId", accountId);
    localStorage.setItem("hyeboard.universityId", "vnu");
    sessionStorage.setItem(`hyeboard.vnu.refreshGrant.${accountId}`, "synthetic-source-tab-grant");
  }, NEW_TAB_VNU_ACCOUNT_ID);
}

test("VNU new tab without a grant expires to empty manual login", async ({ page, context }) => {
  await page.route("**/api/**", (route) => route.abort());
  await seedExpiringNewTabAccount(page);
  const expiryTab = await context.newPage();
  let refreshRequests = 0;
  await expiryTab.route("**/api/**", (route) => route.abort());
  await expiryTab.route("**/api/universities", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], error: null }) }));
  await expiryTab.route("**/api/vnu/timetable**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic new-tab expiry" } }) }));
  await expiryTab.route("**/api/vnu/auth/refresh", (route) => {
    refreshRequests += 1;
    return route.abort();
  });
  await expiryTab.goto("/timetable");
  await expect(expiryTab).toHaveURL(/\/login$/);
  expect(refreshRequests).toBe(0);
  expect(await expiryTab.evaluate((accountId) => ({
    accounts: JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as unknown[],
    grant: sessionStorage.getItem(`hyeboard.vnu.refreshGrant.${accountId}`),
  }), NEW_TAB_VNU_ACCOUNT_ID)).toEqual({ accounts: [], grant: null });
  await expiryTab.getByRole("combobox", { name: "School" }).click();
  await expiryTab.getByRole("option", { name: "VNU (daotao)" }).click();
  await expect(expiryTab.getByLabel("Username")).toHaveValue("");
  await expect(expiryTab.getByLabel("Password", { exact: true })).toHaveValue("");
  await expiryTab.close();
});

for (const descriptorCase of [
  { label: "live", token: "synthetic-live-descriptor" },
  { label: "fully expired", token: "authenticated-fully-expired-descriptor-token" },
] as const) {
  for (const targetIsActive of [true, false] as const) {
    test(`VNU new tab removes ${targetIsActive ? "active" : "inactive"} ${descriptorCase.label} descriptor without a grant`, async ({ page, context }) => {
      await page.route("**/api/**", (route) => route.abort());
      await seedNewTabDescriptorScenario(page, descriptorCase.token, targetIsActive);
      const removalTab = await context.newPage();
      await removalTab.route("**/api/**", (route) => route.abort());
      let logoutRequest: { authorization?: string; body: string | null } | undefined;
      await removalTab.route("**/api/vnu/auth/logout", (route) => {
        logoutRequest = { authorization: route.request().headers().authorization, body: route.request().postData() };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { authenticated: false }, error: null }) });
      });
      await removalTab.goto(targetIsActive ? "/settings" : "/");
      expect(await removalTab.evaluate((accountId) => sessionStorage.getItem(`hyeboard.vnu.refreshGrant.${accountId}`), NEW_TAB_VNU_ACCOUNT_ID)).toBeNull();
      if (targetIsActive) {
        await removalTab.getByRole("button", { name: "Sign out" }).click();
        await expect(removalTab).toHaveURL(/\/login$/);
      } else {
        await removalTab.getByRole("button", { name: "Open account menu" }).click();
        await removalTab.getByRole("button", { name: "Remove SYNTHETIC-NEW-TAB" }).click();
      }
      await expect.poll(() => removalTab.evaluate((accountId) => {
        const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>;
        return accounts.some((account) => account.id === accountId);
      }, NEW_TAB_VNU_ACCOUNT_ID)).toBe(false);
      expect(logoutRequest).toEqual({ authorization: `Bearer ${descriptorCase.token}`, body: JSON.stringify({}) });
      expect(await removalTab.evaluate(() => {
        const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>;
        return accounts.map((account) => account.id);
      })).toEqual([NEW_TAB_SURVIVOR.id]);
      await removalTab.close();
    });
  }
}

type VnuReconnectRequestCounts = {
  vnuTimetable: number;
  uetTimetable: number;
  universities: number;
};

async function seedVnuReconnectScenario(
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

function reconnectCountsSnapshot(counts: VnuReconnectRequestCounts): VnuReconnectRequestCounts {
  return { ...counts };
}

test("VNU active reconnect status is one polite nonblocking region and committed refresh refetches", async ({ page }) => {
  const counts = await seedVnuReconnectScenario(page);
  const beforeCommit = reconnectCountsSnapshot(counts);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "reconnecting" } })));
  const status = page.getByText("Reconnecting to VNU…", { exact: true });
  await expect(status).toHaveCount(1);
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveText("Reconnecting to VNU…");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "retryable" } })));
  const retryableStatus = page.getByText("VNU could not reconnect. Retry the affected request.", { exact: true });
  await expect(retryableStatus).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "idle" } })));
  await expect(retryableStatus).toHaveCount(0);
  const refetchedTimetable = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/vnu/timetable");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-committed", { detail: { accountId: "synthetic-vnu-active" } })));
  await refetchedTimetable;
  expect(counts).toEqual({ ...beforeCommit, vnuTimetable: beforeCommit.vnuTimetable + 1 });
});

test("VNU inactive reconnect events cause no refetch after causal render and request lifecycles", async ({ page, isMobile }) => {
  const counts = await seedVnuReconnectScenario(page);
  const beforeEvents = reconnectCountsSnapshot(counts);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-inactive", state: "reconnecting" } }));
    window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "reconnecting" } }));
  });
  await expect(page.getByText("Reconnecting to VNU…", { exact: true })).toBeVisible();
  expect(counts).toEqual(beforeEvents);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "idle" } })));
  await expect(page.getByText("Reconnecting to VNU…", { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-committed", { detail: { accountId: "synthetic-vnu-inactive" } })));
  await clickVisibleNavigationLink(page, "/settings", isMobile);
  await expect(page).toHaveURL(/\/settings$/);
  const returnedTimetable = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/vnu/timetable");
  await page.goto("/timetable");
  await returnedTimetable;
  expect(counts.vnuTimetable).toBe(beforeEvents.vnuTimetable + 1);
  expect(counts.uetTimetable).toBe(beforeEvents.uetTimetable);
});

test("VNU reconnect status is localized", async ({ page }) => {
  await seedVnuReconnectScenario(page, "vi");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "reconnecting" } })));
  await expect(page.getByText("Đang kết nối lại với VNU…", { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "idle" } })));
  await expect(page.getByText("Đang kết nối lại với VNU…", { exact: true })).toHaveCount(0);
});

test("VNU committed event stays inactive after switching accounts", async ({ page, isMobile }) => {
  const counts = await seedVnuReconnectScenario(page);
  const switchedTimetable = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/uet/timetable");
  await page.getByTestId("account-trigger").click();
  await page.getByTestId("account-switch-item").filter({ hasText: "(UET)" }).click();
  await switchedTimetable;
  const afterSwitch = reconnectCountsSnapshot(counts);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-committed", { detail: { accountId: "synthetic-vnu-active" } })));
  await clickVisibleNavigationLink(page, "/settings", isMobile);
  await expect(page).toHaveURL(/\/settings$/);
  const returnedTimetable = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/uet/timetable");
  await page.goto("/timetable");
  await returnedTimetable;
  expect(counts.vnuTimetable).toBe(afterSwitch.vnuTimetable);
  expect(counts.uetTimetable).toBe(afterSwitch.uetTimetable + 1);
});

test("VNU remove keeps exact account pending and on revoke failure, then clears only its grant", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  let releaseFirstLogout!: () => void;
  const firstLogoutMayFinish = new Promise<void>((resolve) => { releaseFirstLogout = resolve; });
  let logoutAttempt = 0;
  const logoutRequests: Array<{ authorization?: string; body: string | null }> = [];
  await page.route("**/api/vnu/auth/logout", async (route) => {
    logoutAttempt += 1;
    logoutRequests.push({ authorization: route.request().headers().authorization, body: route.request().postData() });
    if (logoutAttempt === 1) {
      await firstLogoutMayFinish;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic unavailable" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { authenticated: false }, error: null }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([
      { id: "synthetic-mock-active", universityId: "mock", token: "synthetic-mock-token", studentCode: "SYNTHETIC-ACTIVE", addedAt: "2099-01-01T00:00:00.000Z" },
      { id: "synthetic-vnu-remove", universityId: "vnu", token: "synthetic-vnu-remove-token", studentCode: "SYNTHETIC-INACTIVE", addedAt: "2099-01-01T00:00:00.000Z" },
    ]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-mock-active");
    sessionStorage.setItem("hyeboard.vnu.refreshGrant.synthetic-vnu-remove", "synthetic-vnu-remove-grant");
    sessionStorage.setItem("hyeboard.vnu.refreshGrant.synthetic-mock-active", "synthetic-active-grant");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account menu" }).click();
  const removeButton = page.getByRole("button", { name: "Remove SYNTHETIC-INACTIVE" });
  await removeButton.click();
  await expect(removeButton).toBeDisabled();
  releaseFirstLogout();
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveText("Could not securely remove this VNU account. Try again.");
  await expect(removeButton).toBeEnabled();
  expect(await page.evaluate(() => ({
    accountIds: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>).map((account) => account.id),
    grant: sessionStorage.getItem("hyeboard.vnu.refreshGrant.synthetic-vnu-remove"),
  }))).toEqual({ accountIds: ["synthetic-mock-active", "synthetic-vnu-remove"], grant: "synthetic-vnu-remove-grant" });

  await removeButton.click();
  await expect(removeButton).toHaveCount(0);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  expect(logoutRequests).toEqual([
    { authorization: "Bearer synthetic-vnu-remove-token", body: JSON.stringify({ refreshGrant: "synthetic-vnu-remove-grant" }) },
    { authorization: "Bearer synthetic-vnu-remove-token", body: JSON.stringify({ refreshGrant: "synthetic-vnu-remove-grant" }) },
  ]);
  expect(await page.evaluate(() => ({
    accountIds: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>).map((account) => account.id),
    removedGrant: sessionStorage.getItem("hyeboard.vnu.refreshGrant.synthetic-vnu-remove"),
    activeGrant: sessionStorage.getItem("hyeboard.vnu.refreshGrant.synthetic-mock-active"),
  }))).toEqual({ accountIds: ["synthetic-mock-active"], removedGrant: null, activeGrant: "synthetic-active-grant" });
});

test("VNU active Settings logout uses its grant and one alert while 503 retains state and route", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  let releaseLogout!: () => void;
  const logoutMayFinish = new Promise<void>((resolve) => { releaseLogout = resolve; });
  let logoutRequest: { authorization?: string; body: string | null } | undefined;
  await page.route("**/api/vnu/auth/logout", async (route) => {
    logoutRequest = { authorization: route.request().headers().authorization, body: route.request().postData() };
    await logoutMayFinish;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic unavailable" } }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([{ id: "synthetic-vnu-settings", universityId: "vnu", token: "synthetic-vnu-settings-token", studentCode: "SYNTHETIC-SETTINGS", addedAt: "2099-01-01T00:00:00.000Z" }]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-vnu-settings");
    localStorage.setItem("hyeboard.universityId", "vnu");
    sessionStorage.setItem("hyeboard.vnu.refreshGrant.synthetic-vnu-settings", "synthetic-vnu-settings-grant");
  });
  await page.goto("/settings");
  const signOut = page.getByRole("button", { name: "Sign out" });
  await signOut.click();
  await expect(signOut).toBeDisabled();
  releaseLogout();
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveText("Could not securely remove this VNU account. Try again.");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(signOut).toBeEnabled();
  expect(logoutRequest).toEqual({
    authorization: "Bearer synthetic-vnu-settings-token",
    body: JSON.stringify({ refreshGrant: "synthetic-vnu-settings-grant" }),
  });
  expect(await page.evaluate(() => ({
    accounts: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>).map((account) => account.id),
    grant: sessionStorage.getItem("hyeboard.vnu.refreshGrant.synthetic-vnu-settings"),
  }))).toEqual({ accounts: ["synthetic-vnu-settings"], grant: "synthetic-vnu-settings-grant" });
  await page.getByRole("button", { name: "Open account menu" }).click();
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveText("Could not securely remove this VNU account. Try again.");
});

test("VNU reconnect cancelled by failed revoke leaves one alert and no stale reconnecting status", async ({ page, isMobile }) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/universities", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], error: null }) }));
  await page.route("**/api/vnu/timetable**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }) }));
  let markRefreshEntered!: () => void;
  const refreshEntered = new Promise<void>((resolve) => { markRefreshEntered = resolve; });
  let releaseOldRefresh!: () => void;
  const oldRefreshMayFinish = new Promise<void>((resolve) => { releaseOldRefresh = resolve; });
  let markOldRefreshRouteCompleted!: () => void;
  const oldRefreshRouteCompleted = new Promise<void>((resolve) => { markOldRefreshRouteCompleted = resolve; });
  let markOldRefreshBrowserSettled!: () => void;
  const oldRefreshBrowserSettled = new Promise<void>((resolve) => { markOldRefreshBrowserSettled = resolve; });
  let refreshRequests = 0;
  const markMatchingRefreshSettled = (request: import("@playwright/test").Request) => {
    if (new URL(request.url()).pathname === "/api/vnu/auth/refresh") markOldRefreshBrowserSettled();
  };
  page.on("requestfinished", markMatchingRefreshSettled);
  page.on("requestfailed", markMatchingRefreshSettled);
  await page.addInitScript(() => {
    const observations = { committed: 0, statuses: [] as string[] };
    window.addEventListener("hyeboard:vnu-refresh-committed", () => { observations.committed += 1; });
    window.addEventListener("hyeboard:vnu-refresh-status", (event) => {
      const state = (event as CustomEvent<{ state?: string }>).detail.state;
      if (state) observations.statuses.push(state);
    });
    Object.defineProperty(window, "__lateRefreshObservations", { value: observations, configurable: true });
  });
  await page.route("**/api/vnu/auth/refresh", async (route) => {
    refreshRequests += 1;
    markRefreshEntered();
    await oldRefreshMayFinish;
    try {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        token: "synthetic-late-refresh-token",
        refreshGrant: "synthetic-late-refresh-grant",
        session: { authenticated: true, universityId: "vnu", studentCode: "SYNTHETIC-REFRESH-REVOKE", expiresAt: "2099-01-01T00:00:00.000Z" },
      }, error: null }) });
    } catch {
      // Cancellation may detach the request before the synthetic late response is sent.
    } finally {
      markOldRefreshRouteCompleted();
    }
  });
  let logoutRequests = 0;
  await page.route("**/api/vnu/auth/logout", (route) => {
    logoutRequests += 1;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic logout unavailable" } }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([{ id: "synthetic-refresh-revoke", universityId: "vnu", token: "synthetic-refresh-revoke-token", studentCode: "SYNTHETIC-REFRESH-REVOKE", addedAt: "2099-01-01T00:00:00.000Z" }]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-refresh-revoke");
    localStorage.setItem("hyeboard.universityId", "vnu");
    sessionStorage.setItem("hyeboard.vnu.refreshGrant.synthetic-refresh-revoke", "synthetic-refresh-revoke-grant");
  });
  await page.goto("/timetable");
  await refreshEntered;
  await expect(page.getByText("Reconnecting to VNU…", { exact: true })).toBeVisible();
  await clickVisibleNavigationLink(page, "/settings", isMobile);
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  await expect(page.getByText("Reconnecting to VNU…", { exact: true })).toHaveCount(0);
  await oldRefreshBrowserSettled;
  const stateBeforeLateResponse = await page.evaluate(() => ({
    accountIds: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>).map((account) => account.id),
    token: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ token: string }>)[0]?.token,
    grant: sessionStorage.getItem("hyeboard.vnu.refreshGrant.synthetic-refresh-revoke"),
    observations: (window as unknown as { __lateRefreshObservations: { committed: number; statuses: string[] } }).__lateRefreshObservations,
  }));
  expect(stateBeforeLateResponse).toEqual({
    accountIds: ["synthetic-refresh-revoke"],
    token: "synthetic-refresh-revoke-token",
    grant: "synthetic-refresh-revoke-grant",
    observations: { committed: 0, statuses: ["reconnecting", "idle"] },
  });
  releaseOldRefresh();
  await oldRefreshRouteCompleted;
  const retryLogoutResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/vnu/auth/logout");
  await page.getByRole("button", { name: "Sign out" }).click();
  await retryLogoutResponse;
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  await expect(page.getByText("Reconnecting to VNU…", { exact: true })).toHaveCount(0);
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  expect(await page.evaluate(() => ({
    accountIds: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>).map((account) => account.id),
    token: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ token: string }>)[0]?.token,
    grant: sessionStorage.getItem("hyeboard.vnu.refreshGrant.synthetic-refresh-revoke"),
    observations: (window as unknown as { __lateRefreshObservations: { committed: number; statuses: string[] } }).__lateRefreshObservations,
  }))).toEqual(stateBeforeLateResponse);
  expect(refreshRequests).toBe(1);
  expect(logoutRequests).toBe(2);
});

test("VNU remove failure cannot resurrect Settings ownership after route navigation", async ({ page, isMobile }) => {
  await page.route("**/api/**", (route) => route.abort());
  let markLogoutEntered!: () => void;
  const logoutEntered = new Promise<void>((resolve) => { markLogoutEntered = resolve; });
  let releaseLogout!: () => void;
  const logoutMayFinish = new Promise<void>((resolve) => { releaseLogout = resolve; });
  await page.route("**/api/vnu/auth/logout", async (route) => {
    markLogoutEntered();
    await logoutMayFinish;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic delayed unavailable" } }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([{ id: "synthetic-vnu-delayed-settings", universityId: "vnu", token: "synthetic-delayed-settings-token", studentCode: "SYNTHETIC-DELAYED", addedAt: "2099-01-01T00:00:00.000Z" }]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-vnu-delayed-settings");
    localStorage.setItem("hyeboard.universityId", "vnu");
    sessionStorage.setItem("hyeboard.vnu.refreshGrant.synthetic-vnu-delayed-settings", "synthetic-delayed-settings-grant");
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await logoutEntered;
  await clickVisibleNavigationLink(page, "/", isMobile);
  await expect(page).toHaveURL(/\/$/);
  const logoutResponse = page.waitForResponse((response) => response.url().includes("/api/vnu/auth/logout"));
  releaseLogout();
  await logoutResponse;
  await clickVisibleNavigationLink(page, "/settings", isMobile);
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

test("VNU remove failure cannot resurrect a closed account-menu owner", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  let markLogoutEntered!: () => void;
  const logoutEntered = new Promise<void>((resolve) => { markLogoutEntered = resolve; });
  let releaseLogout!: () => void;
  const logoutMayFinish = new Promise<void>((resolve) => { releaseLogout = resolve; });
  await page.route("**/api/vnu/auth/logout", async (route) => {
    markLogoutEntered();
    await logoutMayFinish;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic delayed unavailable" } }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([
      { id: "synthetic-menu-survivor", universityId: "mock", token: "synthetic-menu-survivor-token", studentCode: "SYNTHETIC-SURVIVOR", addedAt: "2099-01-01T00:00:00.000Z" },
      { id: "synthetic-menu-delayed", universityId: "vnu", token: "synthetic-menu-delayed-token", studentCode: "SYNTHETIC-DELAYED", addedAt: "2099-01-01T00:00:00.000Z" },
    ]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-menu-survivor");
    localStorage.setItem("hyeboard.universityId", "mock");
    sessionStorage.setItem("hyeboard.vnu.refreshGrant.synthetic-menu-delayed", "synthetic-menu-delayed-grant");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Remove SYNTHETIC-DELAYED" }).click();
  await logoutEntered;
  await page.keyboard.press("Escape");
  const logoutResponse = page.waitForResponse((response) => response.url().includes("/api/vnu/auth/logout"));
  releaseLogout();
  await logoutResponse;
  await page.getByRole("button", { name: "Open account menu" }).click();
  await expect(page.getByRole("button", { name: "Remove SYNTHETIC-DELAYED" })).toBeEnabled();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

test("VNU remove older failure stays inert after a newer account action succeeds", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  let markOlderEntered!: () => void;
  const olderEntered = new Promise<void>((resolve) => { markOlderEntered = resolve; });
  let releaseOlder!: () => void;
  const olderMayFinish = new Promise<void>((resolve) => { releaseOlder = resolve; });
  await page.route("**/api/vnu/auth/logout", async (route) => {
    const authorization = route.request().headers().authorization;
    if (authorization === "Bearer synthetic-older-token") {
      markOlderEntered();
      await olderMayFinish;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic older unavailable" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { authenticated: false }, error: null }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([
      { id: "synthetic-action-survivor", universityId: "mock", token: "synthetic-action-survivor-token", studentCode: "SYNTHETIC-SURVIVOR", addedAt: "2099-01-01T00:00:00.000Z" },
      { id: "synthetic-action-older", universityId: "vnu", token: "synthetic-older-token", studentCode: "SYNTHETIC-OLDER", addedAt: "2099-01-01T00:00:00.000Z" },
      { id: "synthetic-action-newer", universityId: "vnu", token: "synthetic-newer-token", studentCode: "SYNTHETIC-NEWER", addedAt: "2099-01-01T00:00:00.000Z" },
    ]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-action-survivor");
    localStorage.setItem("hyeboard.universityId", "mock");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Remove SYNTHETIC-OLDER" }).click();
  await olderEntered;
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Remove SYNTHETIC-NEWER" }).click();
  await expect(page.getByRole("button", { name: "Remove SYNTHETIC-NEWER" })).toHaveCount(0);
  const olderResponse = page.waitForResponse((response) => response.request().headers().authorization === "Bearer synthetic-older-token");
  releaseOlder();
  await olderResponse;
  await expect(page.getByRole("button", { name: "Remove SYNTHETIC-OLDER" })).toBeEnabled();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>).map((account) => account.id))).toEqual([
    "synthetic-action-survivor",
    "synthetic-action-older",
  ]);
});

test("VNU remove pending failure stays inert after account switch", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  let markLogoutEntered!: () => void;
  const logoutEntered = new Promise<void>((resolve) => { markLogoutEntered = resolve; });
  let releaseLogout!: () => void;
  const logoutMayFinish = new Promise<void>((resolve) => { releaseLogout = resolve; });
  await page.route("**/api/vnu/auth/logout", async (route) => {
    markLogoutEntered();
    await logoutMayFinish;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic switched unavailable" } }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([
      { id: "synthetic-switch-pending", universityId: "vnu", token: "synthetic-switch-pending-token", studentCode: "SYNTHETIC-PENDING", addedAt: "2099-01-01T00:00:00.000Z" },
      { id: "synthetic-switch-survivor", universityId: "mock", token: "synthetic-switch-survivor-token", studentCode: "SYNTHETIC-SURVIVOR", addedAt: "2099-01-01T00:00:00.000Z" },
    ]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-switch-pending");
    localStorage.setItem("hyeboard.universityId", "vnu");
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await logoutEntered;
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByTestId("account-switch-item").filter({ hasText: "SYNTHETIC-SURVIVOR" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("hyeboard.activeAccountId"))).toBe("synthetic-switch-survivor");
  const logoutResponse = page.waitForResponse((response) => response.url().includes("/api/vnu/auth/logout"));
  releaseLogout();
  await logoutResponse;
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

test("concurrent VNU expiry leaves a switched inactive origin inert", async ({ page }) => {
  await loginDemo(page);
  const survivingAccount = await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string; universityId: string; token: string; studentCode: string }>;
    return accounts.find((account) => account.universityId === "mock");
  });
  expect(survivingAccount).toBeDefined();

  const mockedSession = await startMockedVnuSession(page, {
    code: "VNU_SESSION_EXPIRED",
    status: 401,
    message: "Synthetic concurrent VNU session expiry",
  }, { deferRawResponses: true });
  const harmlessExtraRawRequest = page.evaluate(() => fetch("/api/vnu/raw/syllabus").then((response) => response.status));
  await mockedSession.allRawRequestsStarted;

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByTestId("account-switch-item").filter({ hasText: "(MOCK)" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("hyeboard.activeAccountId"))).toBe(survivingAccount?.id);

  const releasedRawPaths = ["/api/vnu/raw/profile", "/api/vnu/raw/grades", "/api/vnu/raw/progress", "/api/vnu/raw/syllabus"];
  const rawRequestSettlements = releasedRawPaths.map((path) => Promise.race([
    page.waitForEvent("requestfinished", { predicate: (request) => new URL(request.url()).pathname === path }),
    page.waitForEvent("requestfailed", { predicate: (request) => new URL(request.url()).pathname === path }),
  ]));
  mockedSession.releaseRawRequests();
  await Promise.all([
    mockedSession.allRawResponsesFulfilled,
    expect(harmlessExtraRawRequest).resolves.toBe(401),
    ...rawRequestSettlements,
  ]);
  await page.getByRole("button", { name: "Open account menu" }).click();
  const activeSurvivor = page.locator('[data-testid="account-switch-item"]:visible').filter({ hasText: survivingAccount?.studentCode });
  await expect(activeSurvivor).toHaveCount(1);
  await expect(activeSurvivor.locator("svg.text-primary")).toHaveCount(1);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate((expectedAccount) => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string; universityId: string; token: string }>;
    return {
      accountCount: accounts.length,
      survivingIdMatches: accounts[0]?.id === expectedAccount?.id,
      survivingTokenMatches: accounts[0]?.token === expectedAccount?.token,
      survivingUniversityMatches: accounts[0]?.universityId === expectedAccount?.universityId,
      activeAccountMatches: localStorage.getItem("hyeboard.activeAccountId") === expectedAccount?.id,
    };
  }, survivingAccount)).toEqual({
    accountCount: 2,
    survivingIdMatches: true,
    survivingTokenMatches: true,
    survivingUniversityMatches: true,
    activeAccountMatches: true,
  });
  await expect(page).not.toHaveURL(/\/login$/);
});

for (const error of [
  { status: 401, message: "Synthetic code-less VNU failure" },
  { code: "VNU_UNKNOWN_FAILURE", status: 401, message: "Synthetic unknown VNU failure" },
  { code: "VNU_REQUEST_FAILED", status: 401, message: "Synthetic VNU request failed" },
  { code: "VNU_RATE_LIMITED", status: 429, message: "Synthetic VNU rate limit" },
  { code: "VNU_UPSTREAM_UNAVAILABLE", status: 502, message: "Synthetic VNU upstream unavailable" },
  { code: "VNU_CROSS_LOOKUP_NOT_FOUND", status: 404, message: "Synthetic VNU lookup not found" },
]) {
  test(`${error.code ?? "VNU code-less 401"} remains inline and keeps the active account`, async ({ page }) => {
    await startMockedVnuSession(page, error);

    await expect(page).not.toHaveURL(/\/login$/);
    await expect(page.getByText(error.message).first()).toBeVisible();
    const storage = await page.evaluate(() => ({
      accounts: JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as unknown[],
      activeAccountId: localStorage.getItem("hyeboard.activeAccountId"),
    }));
    expect(storage.accounts).toHaveLength(1);
    expect(storage.activeAccountId).not.toBeNull();
  });
}

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
  await expect(page.locator("[data-export-surface]")).toHaveCount(0);

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

test("lookup renders only own-session point-detail components", async ({ page }) => {
  await openMockedLookup(page);
  await page.getByLabel("Course code").fill("SYN9900");
  await page.getByLabel("Term").click();
  await page.getByRole("option").first().click();
  const result = page.getByTestId("lookup-results");
  await expect(result.getByText("Synthetic Export Systems")).toBeVisible();
  await result.getByRole("button", { name: "Grade breakdown" }).click();
  await expect(result.getByText("Giữa kỳ")).toBeVisible();
  await expect(result.getByText("Thi cuối kỳ")).toBeVisible();
  await expect(result.getByText("Weight 0.4 · Attempt 1")).toBeVisible();
  await expect(result.getByText("8.5", { exact: true })).toBeVisible();
  await expect(result.getByText("Tổng điểm")).toHaveCount(0);
  await expect(result.getByText("Portal footer total")).toHaveCount(0);
});

test("bulk hides when maximum is zero or missing while single cross lookup remains", async ({ page }) => {
  for (const maximum of [0, null] as const) {
    await openMockedLookup(page, maximum);
    await expect(page.getByTestId("student-record-tools")).toBeVisible();
    await expect(page.getByTestId("cross-student-code")).toBeVisible();
    await expect(page.getByTestId("bulk-lookup")).toHaveCount(0);
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("bulk enforces configured deduplicated maximum and dynamic copy", async ({ page }) => {
  await openMockedLookup(page, 2);
  const bulk = page.getByTestId("bulk-lookup");
  await expect(bulk.getByText("Process up to 2 identifiers in sequential batches. Each target reports its own result.")).toBeVisible();
  await bulk.getByLabel("Targets, one per line").fill("99000000101\n99000000101\n99000000102");
  await expect(bulk.getByText("Use no more than 2 unique identifiers at once.")).toHaveCount(0);
  await bulk.getByLabel("Targets, one per line").fill("99000000101\n99000000101\n99000000102\n99000000103");
  await expect(bulk.getByText("Use no more than 2 unique identifiers at once.")).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Run bulk lookup" })).toBeDisabled();
});

test("bulk keeps complete exports ordered for all modes and fixed chunks", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  const chunks: Record<SyntheticBulkMode, string[][]> = { "stdid-to-code": [], "code-to-stdid": [], "stdid-to-transcript": [] };
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    const mode = (route.request().postDataJSON() as { mode: SyntheticBulkMode }).mode;
    await fulfillBulkSuccess(route, chunks[mode]);
  });
  await openMockedLookup(page);
  const bulk = page.getByTestId("bulk-lookup");
  const cases: Array<{ mode: SyntheticBulkMode; option: string; targets: string[]; surface: string; sizes: number[] }> = [
    { mode: "stdid-to-code", option: "Internal IDs to student codes", targets: Array.from({ length: 6 }, (_, index) => `9900000010${index + 1}`), surface: "bulk-id-to-code", sizes: [5, 1] },
    { mode: "code-to-stdid", option: "Student codes to internal IDs", targets: Array.from({ length: 4 }, (_, index) => `9900010${index + 1}`), surface: "bulk-code-to-id", sizes: [3, 1] },
    { mode: "stdid-to-transcript", option: "Internal IDs to transcripts", targets: Array.from({ length: 6 }, (_, index) => `9900000020${index + 1}`), surface: "bulk-id-to-transcript", sizes: [5, 1] },
  ];

  for (const testCase of cases) {
    await bulk.getByLabel("Lookup mode").click();
    await page.getByRole("option", { name: testCase.option }).click();
    await bulk.getByLabel("Targets, one per line").fill(testCase.targets.join("\n"));
    await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
    await expect(bulk.getByText(`${testCase.targets.length} completed`)).toBeVisible();
    const document = await expectExportFormats(page, testCase.surface, apiRequestCount, {
      sourcePath: "/api/vnu/cross-lookup/bulk",
      assertCsv: expectBulkCsvMatchesJson,
    });
    expect(document.surface).toBe(testCase.surface);
    expect(document.run).toEqual({ status: "complete", mode: testCase.mode, processedCount: testCase.targets.length, totalCount: testCase.targets.length });
    const results = document.results as Array<{ target: string; status: string; result: Record<string, unknown> }>;
    expect(results.map((item) => item.target)).toEqual(testCase.targets);
    expect(results.every((item) => item.status === "ok")).toBe(true);
    expect(JSON.stringify(results)).not.toContain("ignoredField");
    if (testCase.mode === "stdid-to-code") expect(results[0]?.result).toEqual({ identity: { studentCode: "99000101", internalStudentId: testCase.targets[0], studentName: "Synthetic 9901", managingClass: "SYNTHETIC-99" } });
    if (testCase.mode === "code-to-stdid") expect(results[0]?.result).toEqual({ resolver: { resolvedStudentCode: testCase.targets[0], resolvedInternalStudentId: "99000000101", probes: 1 } });
    if (testCase.mode === "stdid-to-transcript") expect(results[0]?.result).toMatchObject({ identity: { internalStudentId: testCase.targets[0] }, reported: { cumulativeGpa4: 4 }, derivedTerms: [{ termCode: "252", estimateKind: "derived", courses: [{ courseCode: "SYN9901" }] }] });
  }

  for (const testCase of cases) expect(chunks[testCase.mode].map((chunk) => chunk.length)).toEqual(testCase.sizes);
});

test("bulk exports prior five results after later 429 and while retrying", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  let call = 0;
  let markRetryStarted!: () => void;
  const retryStarted = new Promise<void>((resolve) => { markRetryStarted = resolve; });
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    call += 1;
    if (call === 2) {
      await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_RATE_LIMITED", message: "Synthetic 99 limit" } }) });
      return;
    }
    if (call === 3) {
      markRetryStarted();
      await retryGate;
    }
    await fulfillBulkSuccess(route, []);
  });
  await openMockedLookup(page);
  const bulk = page.getByTestId("bulk-lookup");
  const targets = Array.from({ length: 6 }, (_, index) => `9900000030${index + 1}`);
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await expect(bulk.getByRole("button", { name: "Retry remaining" })).toBeVisible();
  const partial = await expectExportFormats(page, "bulk-id-to-code", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/bulk",
    assertCsv: expectBulkCsvMatchesJson,
  });
  expect(partial.run).toEqual({ status: "partial", mode: "stdid-to-code", processedCount: 5, totalCount: 6 });
  expect((partial.results as Array<{ target: string }>).map((item) => item.target)).toEqual(targets.slice(0, 5));

  await bulk.getByRole("button", { name: "Retry remaining" }).click();
  await retryStarted;
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  releaseRetry();
  await expect(bulk.getByText("6 completed")).toBeVisible();
});

test("bulk keeps prior export during and after cancellation of second chunk", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  let call = 0;
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let markSecondHandled!: () => void;
  const secondHandled = new Promise<void>((resolve) => { markSecondHandled = resolve; });
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    call += 1;
    if (call === 2) {
      markSecondStarted();
      await secondGate;
    }
    try {
      await fulfillBulkSuccess(route, []);
    } finally {
      if (call === 2) markSecondHandled();
    }
  });
  await openMockedLookup(page);
  const bulk = page.getByTestId("bulk-lookup");
  const targets = Array.from({ length: 6 }, (_, index) => `9900000040${index + 1}`);
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await secondStarted;
  await expect(bulk.locator("#bulk-lookup-progress-label")).toHaveText("5 of 6 processed");
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  await bulk.getByRole("button", { name: "Cancel" }).click();
  await expect(bulk.getByRole("button", { name: "Retry remaining" })).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  await expect(bulk.getByText(targets[0]!, { exact: true })).toBeVisible();
  const partial = await expectExportFormats(page, "bulk-id-to-code", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/bulk",
    assertCsv: expectBulkCsvMatchesJson,
  });
  expect(partial.run).toEqual({ status: "partial", mode: "stdid-to-code", processedCount: 5, totalCount: 6 });
  expect(partial.results?.map((item) => item.target)).toEqual(targets.slice(0, 5));
  releaseSecond();
  await secondHandled;
});

test("bulk preserves partial export through VNU refresh and retries only remaining targets", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  const initialToken = "synthetic-expiring-bulk-token";
  const rotatedToken = "synthetic-rotated-bulk-token";
  const targets = Array.from({ length: 6 }, (_, index) => `990000010${index + 1}`);
  let bulkPosts = 0;
  let refreshPosts = 0;
  const bulkAuthorizations: Array<string | null> = [];
  let markRefreshEntered!: () => void;
  const refreshEntered = new Promise<void>((resolve) => { markRefreshEntered = resolve; });
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>((resolve) => { releaseRefresh = resolve; });

  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    bulkPosts += 1;
    bulkAuthorizations.push(route.request().headers()["authorization"] ?? null);
    const body = route.request().postDataJSON() as { targets: string[] };
    if (bulkPosts === 2) markSecondStarted();
    if (bulkPosts === 2) {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { items: body.targets.map((target) => ({ target, status: "ok", result: { studentCode: `CODE-${target}` } })) }, error: null }),
    });
  });
  await page.route("**/api/vnu/auth/refresh", async (route) => {
    refreshPosts += 1;
    markRefreshEntered();
    await refreshReleased;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      token: rotatedToken,
      refreshGrant: "synthetic-rotated-bulk-grant",
      session: { universityId: "vnu", studentCode: "SYNTHETIC-STUDENT", expiresAt: "2099-01-01T00:00:00.000Z", authenticated: true },
    }, error: null }) });
  });

  await openMockedVnuLookup(page);
  await page.evaluate(({ token }) => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<Record<string, unknown>>;
    const activeId = localStorage.getItem("hyeboard.activeAccountId");
    localStorage.setItem("hyeboard.accounts", JSON.stringify(accounts.map((account) => account.id === activeId ? { ...account, token } : account)));
    const activeAccount = accounts.find((account) => account.id === activeId);
    if (activeId) sessionStorage.setItem(`hyeboard.vnu.refreshGrant.${activeId}`, "synthetic-bulk-grant");
    if (!activeAccount) throw new Error("Synthetic active account missing");
  }, { token: initialToken });
  await page.reload();
  const bulk = page.getByTestId("bulk-lookup");
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await secondStarted;
  await refreshEntered;
  await expect(bulk.locator("#bulk-lookup-progress-label")).toHaveText("5 of 6 processed");
  await expect(bulk.getByText(targets[0]!, { exact: true })).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  expect(bulkPosts).toBe(2);
  const partialBeforeRefresh = await expectExportFormats(page, "bulk-id-to-code", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/bulk",
    assertCsv: expectBulkCsvMatchesJson,
  });
  expect(partialBeforeRefresh.run).toEqual({ status: "partial", mode: "stdid-to-code", processedCount: 5, totalCount: 6 });
  expect(partialBeforeRefresh.results?.map((item) => item.target)).toEqual(targets.slice(0, 5));
  releaseRefresh();

  await expect(bulk.getByRole("button", { name: "Retry remaining" })).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  expect(bulkPosts).toBe(2);
  expect(refreshPosts).toBe(1);
  expect(bulkAuthorizations).toEqual([`Bearer ${initialToken}`, `Bearer ${initialToken}`]);
  await expect(bulk.getByText("VNU reconnected. Review the saved results, then retry the remaining targets.")).toBeVisible();
  await bulk.getByRole("button", { name: "Retry remaining" }).click();
  await expect(bulk.getByText("6 completed")).toBeVisible();
  expect(bulkPosts).toBe(3);
  expect(bulkAuthorizations).toEqual([`Bearer ${initialToken}`, `Bearer ${initialToken}`, `Bearer ${rotatedToken}`]);
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ token: string }>)[0]?.token)).toBe(rotatedToken);
});

test("bulk and safe VNU lookup cancel one shared refresh without late mutations", async ({ page }) => {
  const initialToken = "synthetic-cancel-bulk-token";
  const targets = Array.from({ length: 6 }, (_, index) => `990000020${index + 1}`);
  let bulkPosts = 0;
  let refreshPosts = 0;
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  let markRefreshEntered!: () => void;
  const refreshEntered = new Promise<void>((resolve) => { markRefreshEntered = resolve; });
  let releaseLate!: () => void;
  const lateReleased = new Promise<void>((resolve) => { releaseLate = resolve; });
  let markRefreshHandled!: () => void;
  const refreshHandled = new Promise<void>((resolve) => { markRefreshHandled = resolve; });
  let refreshAborted = 0;
  let markRefreshAbort!: () => void;
  const refreshAbortObserved = new Promise<void>((resolve) => { markRefreshAbort = resolve; });
  const bulkAuthorizations: Array<string | null> = [];
  page.on("requestfailed", (request) => {
    if (!request.url().includes("/api/vnu/auth/refresh")) return;
    refreshAborted += 1;
    markRefreshAbort();
  });

  await openMockedVnuLookup(page);

  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    bulkPosts += 1;
    bulkAuthorizations.push(route.request().headers()["authorization"] ?? null);
    const body = route.request().postDataJSON() as { targets: string[] };
    if (bulkPosts === 2) {
      markSecondStarted();
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      items: body.targets.map((target) => ({ target, status: "ok", result: { studentCode: `CODE-${target}` } })),
    }, error: null }) });
  });
  await page.route("**/api/vnu/raw/exams**", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }) });
  });
  await page.route("**/api/vnu/auth/refresh", async (route) => {
    refreshPosts += 1;
    markRefreshEntered();
    await lateReleased;
    try {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        token: "synthetic-late-cancel-token",
        refreshGrant: "synthetic-late-cancel-grant",
        session: { universityId: "vnu", studentCode: "SYNTHETIC-STUDENT", expiresAt: "2099-01-01T00:00:00.000Z", authenticated: true },
      }, error: null }) });
    } catch {
      // Browser cancellation intentionally makes the late response inert.
    } finally {
      markRefreshHandled();
    }
  });

  await page.evaluate(({ token }) => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<Record<string, unknown>>;
    const activeId = localStorage.getItem("hyeboard.activeAccountId");
    localStorage.setItem("hyeboard.accounts", JSON.stringify(accounts.map((account) => account.id === activeId ? { ...account, token } : account)));
    if (activeId) sessionStorage.setItem(`hyeboard.vnu.refreshGrant.${activeId}`, "synthetic-cancel-grant");
  }, { token: initialToken });
  await page.reload();
  await page.evaluate(() => {
    const events = { committed: 0, statuses: [] as string[] };
    window.addEventListener("hyeboard:vnu-refresh-committed", () => { events.committed += 1; });
    window.addEventListener("hyeboard:vnu-refresh-status", (event) => {
      const state = (event as CustomEvent<{ state?: string }>).detail.state;
      if (state) events.statuses.push(state);
    });
    Object.defineProperty(window, "__vnuRefreshEvents", { value: events, configurable: true });
  });

  const bulk = page.getByTestId("bulk-lookup");
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await secondStarted;
  await refreshEntered;
  await expect(bulk.getByText(targets[0]!, { exact: true })).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();

  const term = page.getByRole("combobox", { name: "Term" });
  const safeExpiryResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/vnu/raw/exams" && response.status() === 401);
  await term.click();
  const termOptions = page.getByRole("listbox");
  await termOptions.getByRole("option", { name: "Semester 2, 2025–2026 (supplementary)", exact: true }).click();
  await safeExpiryResponse;
  await page.getByRole("button", { name: "Class ID to course" }).click();
  await expect(page.getByTestId("reverse-class-lookup")).toBeVisible();
  await bulk.getByRole("button", { name: "Cancel" }).click();
  await refreshAbortObserved;
  expect(refreshPosts).toBe(1);
  expect(refreshAborted).toBe(1);
  expect(bulkPosts).toBe(2);
  expect(bulkAuthorizations).toEqual([`Bearer ${initialToken}`, `Bearer ${initialToken}`]);
  const beforeLate = await page.evaluate(() => ({
    account: localStorage.getItem("hyeboard.accounts"),
    grants: Object.entries(sessionStorage).filter(([key]) => key.startsWith("hyeboard.vnu.refreshGrant.")),
    events: (window as unknown as { __vnuRefreshEvents: { committed: number; statuses: string[] } }).__vnuRefreshEvents,
  }));
  await expect(bulk.getByRole("button", { name: "Retry remaining" })).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  await expect(bulk.getByText(targets[0]!, { exact: true })).toBeVisible();

  releaseLate();
  await refreshHandled;
  const afterLate = await page.evaluate(() => ({
    account: localStorage.getItem("hyeboard.accounts"),
    grants: Object.entries(sessionStorage).filter(([key]) => key.startsWith("hyeboard.vnu.refreshGrant.")),
    events: (window as unknown as { __vnuRefreshEvents: { committed: number; statuses: string[] } }).__vnuRefreshEvents,
  }));
  expect(afterLate).toEqual(beforeLate);
  expect(bulkPosts).toBe(2);
  expect(refreshPosts).toBe(1);
  expect(refreshAborted).toBe(1);
  expect(bulkAuthorizations).toEqual([`Bearer ${initialToken}`, `Bearer ${initialToken}`]);
});

test("bulk resets without stale resurrection while second chunk is gated", async ({ page }) => {
  let releaseSecond!: () => void;
  let markSecondStarted!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  const chunks: string[][] = [];
  let failedRequests = 0;
  let markFailedRequest!: () => void;
  const failedRequest = new Promise<void>((resolve) => { markFailedRequest = resolve; });
  let markSecondHandled!: () => void;
  const secondHandled = new Promise<void>((resolve) => { markSecondHandled = resolve; });
  page.on("requestfailed", (request) => {
    if (!request.url().includes("/api/vnu/cross-lookup/bulk")) return;
    failedRequests += 1;
    markFailedRequest();
  });
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    const body = route.request().postDataJSON() as { targets: string[] };
    chunks.push(body.targets);
    if (chunks.length === 2) {
      markSecondStarted();
      await secondGate;
    }
    try { await fulfillBulkSuccess(route, []); } catch { /* Request was invalidated by reset. */ }
    finally { if (chunks.length === 2) markSecondHandled(); }
  });
  await openMockedLookup(page);
  const bulk = page.getByTestId("bulk-lookup");
  const targets = Array.from({ length: 11 }, (_, index) => `990000005${String(index + 1).padStart(2, "0")}`);
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await secondStarted;
  await bulk.getByRole("button", { name: "Reset" }).click();
  await failedRequest;
  expect(failedRequests).toBe(1);
  await expect(bulk.getByRole("button", { name: "Export" })).toHaveCount(0);
  await expect(bulk.getByText(targets[0]!)).toHaveCount(0);
  await expect(bulk.locator("#bulk-lookup-progress-label")).toHaveCount(0);
  releaseSecond();
  await secondHandled;
  expect(chunks).toHaveLength(2);
  await expect(bulk.getByRole("button", { name: "Export" })).toHaveCount(0);
  await expect(bulk.getByText(targets[0]!)).toHaveCount(0);
});

test("bulk clears account results and aborts gated work on session freshness change", async ({ page }) => {
  let releaseSecond!: () => void;
  let markSecondStarted!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  const chunks: string[][] = [];
  let failedRequests = 0;
  let markFailedRequest!: () => void;
  const failedRequest = new Promise<void>((resolve) => { markFailedRequest = resolve; });
  let markSecondHandled!: () => void;
  const secondHandled = new Promise<void>((resolve) => { markSecondHandled = resolve; });
  page.on("requestfailed", (request) => {
    if (!request.url().includes("/api/vnu/cross-lookup/bulk")) return;
    failedRequests += 1;
    markFailedRequest();
  });
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    const body = route.request().postDataJSON() as { targets: string[] };
    chunks.push(body.targets);
    if (chunks.length === 2) {
      markSecondStarted();
      await secondGate;
    }
    try { await fulfillBulkSuccess(route, []); } catch { /* Request was invalidated by account switch. */ }
    finally { if (chunks.length === 2) markSecondHandled(); }
  });
  await openMockedLookup(page);
  const bulk = page.getByTestId("bulk-lookup");
  const targets = Array.from({ length: 11 }, (_, index) => `990000006${String(index + 1).padStart(2, "0")}`);
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await secondStarted;
  await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<Record<string, unknown>>;
    const current = accounts[0];
    if (!current) throw new Error("Synthetic account fixture missing");
    const next = { ...current, id: "synthetic-account-99", studentCode: "99009999", addedAt: "2099-12-31T00:00:00.000Z" };
    localStorage.setItem("hyeboard.accounts", JSON.stringify([...accounts, next]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-account-99");
    window.dispatchEvent(new CustomEvent("hyeboard:account-switched"));
  });
  await failedRequest;
  expect(failedRequests).toBe(1);
  await expect(page.getByTestId("bulk-lookup").getByRole("button", { name: "Export" })).toHaveCount(0);
  await expect(page.getByTestId("bulk-lookup").getByText(targets[0]!)).toHaveCount(0);
  releaseSecond();
  await secondHandled;
  expect(chunks).toHaveLength(2);
  await expect(page.getByTestId("bulk-lookup").getByRole("button", { name: "Export" })).toHaveCount(0);
  await expect(page.getByTestId("bulk-lookup").getByText(targets[0]!)).toHaveCount(0);
});

test("bulk bounds rendered rows and pages through every result", async ({ page }) => {
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => fulfillBulkSuccess(route, []));
  await openMockedLookup(page, 101);
  const bulk = page.getByTestId("bulk-lookup");
  const targets = Array.from({ length: 101 }, (_, index) => `9900001${String(index + 1).padStart(4, "0")}`);
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await expect(bulk.getByText("101 completed")).toBeVisible();
  const resultsList = bulk.getByTestId("bulk-results-list");
  await expect(resultsList.locator(":scope > .list-row")).toHaveCount(50);
  await expect(resultsList.getByText(targets[0]!)).toBeVisible();
  await expect(resultsList.getByText(targets[50]!)).toHaveCount(0);
  await expect(bulk.getByText("Showing 1–50 of 101 results")).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Previous page" })).toBeDisabled();

  await bulk.getByRole("button", { name: "Next page" }).click();
  await expect(resultsList.locator(":scope > .list-row")).toHaveCount(50);
  await expect(resultsList.getByText(targets[0]!)).toHaveCount(0);
  await expect(resultsList.getByText(targets[50]!)).toBeVisible();
  await expect(bulk.getByText("Showing 51–100 of 101 results")).toBeVisible();

  await bulk.getByRole("button", { name: "Next page" }).click();
  await expect(resultsList.locator(":scope > .list-row")).toHaveCount(1);
  await expect(resultsList.getByText(targets[100]!)).toBeVisible();
  await expect(bulk.getByText("Showing 101–101 of 101 results")).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Next page" })).toBeDisabled();

  await bulk.getByRole("button", { name: "Previous page" }).click();
  await expect(resultsList.locator(":scope > .list-row")).toHaveCount(50);
  await expect(resultsList.getByText(targets[50]!)).toBeVisible();
  await bulk.getByRole("button", { name: "Previous page" }).click();
  await expect(resultsList.getByText(targets[0]!)).toBeVisible();
  await expect(resultsList.getByText(targets[50]!)).toHaveCount(0);
});

test("bulk rejects malformed success without exporting unsafe result fields", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  let call = 0;
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    call += 1;
    if (call === 1) {
      await fulfillBulkSuccess(route, []);
      return;
    }
    const body = route.request().postDataJSON() as { targets: string[] };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { items: body.targets.map((target) => ({ target, status: "ok", result: { studentCode: 99000199, unsafe: "must-not-export" } })) }, error: null }),
    });
  });
  await openMockedLookup(page);
  const bulk = page.getByTestId("bulk-lookup");
  const targets = Array.from({ length: 6 }, (_, index) => `9900000070${index + 1}`);
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await expect(bulk.getByText("The lookup returned an invalid result. Retry the remaining targets.")).toBeVisible();
  const partial = await expectExportFormats(page, "bulk-id-to-code", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/bulk",
    assertCsv: expectBulkCsvMatchesJson,
  });
  expect(partial.run).toEqual({ status: "partial", mode: "stdid-to-code", processedCount: 5, totalCount: 6 });
  expect(JSON.stringify(partial)).not.toContain("unsafe");
});

test("lookup successful single results export both formats without refetch and clear stale actions", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  await openMockedLookup(page);

  await page.getByLabel("Course code").fill("SYN9900");
  await page.getByLabel("Term").click();
  await page.getByRole("option", { name: "Semester 2, 2025–2026 (supplementary)" }).click();
  const forwardRow = page.getByTestId("lookup-results").locator(".list-row").filter({ hasText: "Synthetic Export Systems" });
  await expect(forwardRow).toBeVisible();
  const forwardDocument = await expectExportFormats(page, "class-forward", apiRequestCount, {
    sourcePath: "/api/vnu/raw/exams",
    assertCsv: expectClassCsvMatchesJson,
  });
  expect(forwardDocument).toMatchObject({
    surface: "class-forward",
    universityId: "mock",
    results: [{ classResult: { classCode: "SYN9900", classNumber: "99", classId: SYNTHETIC_CLASS_ID, courseName: "Synthetic Export Systems" } }],
  });

  await page.getByRole("button", { name: "Class ID to course" }).click();
  const reverseSection = page.getByTestId("reverse-class-lookup");
  await reverseSection.getByLabel("Term").click();
  await page.getByRole("option", { name: "Semester 2, 2025–2026 (supplementary)" }).click();
  await reverseSection.getByLabel("Internal class ID").fill(SYNTHETIC_CLASS_ID);
  const reverseDocument = await expectExportFormats(page, "class-reverse", apiRequestCount, {
    sourcePath: "/api/vnu/raw/exams",
    assertCsv: expectClassCsvMatchesJson,
  });
  expect(reverseDocument).toMatchObject({
    surface: "class-reverse",
    universityId: "mock",
    results: [{ classResult: { classCode: "SYN9900", classNumber: "99", classId: SYNTHETIC_CLASS_ID, courseName: "Synthetic Export Systems" } }],
  });

  const codeSection = page.getByTestId("cross-student-code");
  const codeInput = codeSection.getByLabel("Target internal student ID");
  await codeInput.fill(SYNTHETIC_TARGET_INTERNAL_ID);
  await codeSection.getByRole("button", { name: "Look up" }).click();
  await expect(codeSection.getByText(SYNTHETIC_TARGET_STUDENT_CODE)).toBeVisible();
  const codeDocument = await expectExportFormats(page, "student-id-to-code", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/student-code",
    assertCsv: expectResolverCsvMatchesJson,
  });
  expect(codeDocument).toMatchObject({
    surface: "student-id-to-code",
    query: { mode: "stdId", value: SYNTHETIC_TARGET_INTERNAL_ID },
    results: [{ identity: { studentCode: SYNTHETIC_TARGET_STUDENT_CODE, internalStudentId: SYNTHETIC_TARGET_INTERNAL_ID, studentName: "Synthetic Target" } }],
  });
  await codeInput.fill(SYNTHETIC_ERROR_INTERNAL_ID);
  await expect(codeSection.getByRole("button", { name: "Export" })).toHaveCount(0);

  await page.getByRole("button", { name: "Code → ID" }).click();
  const idSection = page.getByTestId("cross-student-id");
  const idInput = idSection.getByLabel("Target student code");
  await idInput.fill(SYNTHETIC_TARGET_STUDENT_CODE);
  await idSection.getByRole("button", { name: "Look up" }).click();
  await expect(idSection.getByText(SYNTHETIC_TARGET_INTERNAL_ID)).toBeVisible();
  const idDocument = await expectExportFormats(page, "student-code-to-id", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/student-id",
    assertCsv: expectResolverCsvMatchesJson,
  });
  expect(idDocument).toMatchObject({ surface: "student-code-to-id", results: [{ resolver: { resolvedStudentCode: SYNTHETIC_TARGET_STUDENT_CODE, resolvedInternalStudentId: SYNTHETIC_TARGET_INTERNAL_ID, probes: 2 } }] });
  await idInput.fill(SYNTHETIC_ERROR_STUDENT_CODE);
  await expect(idSection.getByRole("button", { name: "Export" })).toHaveCount(0);

  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  const transcriptSection = page.getByTestId("cross-transcript");
  const transcriptInput = transcriptSection.getByLabel("Target internal student ID");
  await transcriptInput.fill(SYNTHETIC_TARGET_INTERNAL_ID);
  await transcriptSection.getByRole("button", { name: "View transcript" }).click();
  await expect(transcriptSection.getByText("Portal cumulative GPA (4.0)", { exact: true })).toBeVisible();
  await expect(transcriptSection.getByText("3.91", { exact: true })).toBeVisible();
  const derivedHeader = transcriptSection.getByTestId("academic-term-header").first();
  await expect(derivedHeader.getByText("Derived", { exact: true })).toBeVisible();
  await expect(derivedHeader.getByText("Term GPA").locator("..")).toContainText("4.00");
  await expect(derivedHeader.getByText("CPA", { exact: true }).locator("..")).toContainText("3.50");
  await expect(derivedHeader.getByText("Included credits").locator("..")).toContainText("3 / 5 listed");
  await expect(transcriptSection.getByRole("button", { name: "Export" })).toHaveCount(1);
  const transcriptDocument = await expectExportFormats(page, "cross-transcript", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/transcript",
    assertCsv: expectAcademicCsvMatchesJson,
  });
  expect(transcriptDocument).toMatchObject({
    surface: "cross-transcript",
    query: { mode: "stdId", value: SYNTHETIC_TARGET_INTERNAL_ID },
    identity: { studentCode: SYNTHETIC_TARGET_STUDENT_CODE, studentName: "Synthetic Target", managingClass: "SYNTHETIC-99" },
    reported: { cumulativeGpa4: 3.91 },
  });
  const transcriptTerms = transcriptDocument.derivedTerms as Array<Record<string, unknown>>;
  expect(transcriptTerms.map((term) => term.termCode)).toEqual(["252", "251"]);
  expect(transcriptTerms[0]).toMatchObject({ termCode: "252", estimateKind: "derived", listedCredits: 5, includedCredits: 3, termGpa4: 4, derivedCpa4: 3.5 });
  expect((transcriptTerms[0]?.courses as Array<{ courseCode: string }>).map((course) => course.courseCode)).toEqual(["SYN9902", "SYN9903"]);
  expect(transcriptTerms[1]).toMatchObject({ termCode: "251", estimateKind: "derived", listedCredits: 3, includedCredits: 3, termGpa4: 3, derivedCpa4: 3 });
  await transcriptInput.fill(SYNTHETIC_ERROR_INTERNAL_ID);
  await expect(transcriptSection.getByRole("button", { name: "Export" })).toHaveCount(0);
  await expectNoPageOverflow(page);
});

test("VNU class lookup matches compact and spaced codes and exports preserved display", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  const examRequests = await openMockedVnuLookup(page);
  await page.getByLabel("Course code").fill("INT3103");
  await page.getByLabel("Term").click();
  await page.getByRole("option", { name: "Semester 2, 2025–2026 (supplementary)" }).click();
  const row = page.getByTestId("lookup-results").locator(".list-row").filter({ hasText: "Synthetic Search Systems" });
  await expect(row).toContainText("INT 3103 · CN7");
  const requestsAfterCompactSearch = examRequests();
  await page.getByLabel("Course code").fill(" INT 3103 ");
  await expect(row).toContainText("INT 3103 · CN7");
  expect(examRequests()).toBe(requestsAfterCompactSearch);

  const exported = await expectExportFormats(page, "class-forward", apiRequestCount, {
    sourcePath: "/api/vnu/raw/exams",
    assertCsv: expectClassCsvMatchesJson,
  });
  expect(exported).toMatchObject({
    surface: "class-forward",
    universityId: "vnu",
    results: [{ classResult: { classCode: "INT 3103", classNumber: "CN7", classId: "SYNTHETIC-VNU-CLASS-ID" } }],
  });
});

test("lookup single-result errors remove stale export actions", async ({ page }) => {
  await openMockedLookup(page);
  const section = page.getByTestId("cross-student-code");
  const input = section.getByLabel("Target internal student ID");

  await input.fill(SYNTHETIC_TARGET_INTERNAL_ID);
  await section.getByRole("button", { name: "Look up" }).click();
  await expect(section.getByRole("button", { name: "Export" })).toBeVisible();

  await input.fill(SYNTHETIC_ERROR_INTERNAL_ID);
  await expect(section.getByRole("button", { name: "Export" })).toHaveCount(0);
  await section.getByRole("button", { name: "Look up" }).click();
  await expect(section.getByText("The portal did not render a student code for this internal ID. The ID may not exist.")).toBeVisible();
  await expect(section.getByRole("button", { name: "Export" })).toHaveCount(0);
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
  await codeInput.fill(SYNTHETIC_OWN_INTERNAL_ID);
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
  await idInput.fill(SYNTHETIC_OWN_STUDENT_CODE);
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
  const apiRequestCount = trackApiRequestCounts(page);
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
});

test("grades keep missing and reserved term identities collision-safe", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
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

test("export menu reports local failures, remains responsive, and localizes without losing results", async ({ page }) => {
  await loginDemo(page);
  await page.goto("/grades");
  const resultText = page.getByText("Web Application Development");
  await expect(resultText).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("button", { name: "Toggle light and dark mode" }).click();
  await page.goto("/grades");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");

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

  const apiRequestsBeforePrint = await page.evaluate(() => performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/")).length);
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
  expect(await page.evaluate(() => performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/")).length)).toBe(apiRequestsBeforePrint);
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
  const localizedTrigger = localizedRoot.getByRole("button", { name: "Xuất dữ liệu" });
  await localizedTrigger.click();
  const localizedJson = page.getByRole("menuitem", { name: "Tải JSON" });
  const localizedCsv = page.getByRole("menuitem", { name: "Tải CSV" });
  const localizedPrint = page.getByRole("menuitem", { name: "In / Lưu PDF" });
  await expect(localizedJson).toBeVisible();
  for (const menuItem of [localizedJson, localizedCsv, localizedPrint]) {
    const menuItemBox = await menuItem.boundingBox();
    expect(menuItemBox).not.toBeNull();
    expect(menuItemBox!.height).toBeGreaterThanOrEqual(43.9);
  }
  await localizedJson.click();
  await expect(localizedRoot.getByRole("status"))
    .toContainText("Không thể tải dữ liệu xuất. Kết quả vẫn được giữ nguyên; hãy thử lại.");
  await expect(localizedRoot.getByRole("status")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByText("Web Application Development")).toBeVisible();
  await expect(localizedTrigger).toBeFocused();

  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expectNoPageOverflow(page);
    await expectInsideViewport(page, localizedTrigger);
    const triggerBox = await localizedTrigger.boundingBox();
    expect(triggerBox!.height).toBeGreaterThanOrEqual(43.9);

    const featureHeader = page.getByRole("heading", { name: "Điểm số", exact: true }).locator("..").locator("..");
    const featureHeaderBox = await featureHeader.boundingBox();
    expect(featureHeaderBox).not.toBeNull();
    expect(triggerBox!.x).toBeGreaterThanOrEqual(featureHeaderBox!.x);
    expect(triggerBox!.y).toBeGreaterThanOrEqual(featureHeaderBox!.y);
    expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(featureHeaderBox!.x + featureHeaderBox!.width);
    expect(triggerBox!.y + triggerBox!.height).toBeLessThanOrEqual(featureHeaderBox!.y + featureHeaderBox!.height);
    expect(await featureHeader.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    const termHeader = page.getByTestId("academic-term-header").first();
    const termTrigger = termHeader.getByRole("button", { name: "Xuất dữ liệu" });
    const termHeaderBox = await termHeader.boundingBox();
    const termTriggerBox = await termTrigger.boundingBox();
    expect(termHeaderBox).not.toBeNull();
    expect(termTriggerBox).not.toBeNull();
    expect(termTriggerBox!.x).toBeGreaterThanOrEqual(termHeaderBox!.x);
    expect(termTriggerBox!.y).toBeGreaterThanOrEqual(termHeaderBox!.y);
    expect(termTriggerBox!.x + termTriggerBox!.width).toBeLessThanOrEqual(termHeaderBox!.x + termHeaderBox!.width);
    expect(termTriggerBox!.y + termTriggerBox!.height).toBeLessThanOrEqual(termHeaderBox!.y + termHeaderBox!.height);
    expect(await termHeader.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    await localizedTrigger.click();
    const openMenu = page.getByRole("menu");
    await expect(openMenu).toBeVisible();
    await expectInsideViewport(page, openMenu);
    const menuBox = await openMenu.boundingBox();
    expect(menuBox!.height).toBeGreaterThanOrEqual(43.9 * 2);
    await page.keyboard.press("Escape");
    await expect(localizedTrigger).toBeFocused();
  }
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

test("VNU spaced course codes match compact document searches without refetch", async ({ page }) => {
  const syllabusRequests = await openMockedVnuDocuments(page);
  const search = page.getByLabel("Search documents");
  const document = page.getByText("INT 3103 — Synthetic Syllabus");

  await search.fill("INT3103");
  await expect(document).toBeVisible();
  const requestsAfterCompactSearch = syllabusRequests();
  await search.fill("INT 3103");
  await expect(document).toBeVisible();
  await search.fill("Synthetic Syllabus");
  await expect(document).toBeVisible();
  expect(syllabusRequests()).toBe(requestsAfterCompactSearch);
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
  const expectTouchTarget = async (locator: import("@playwright/test").Locator) => {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  };

  await page.goto("/timetable");
  for (const name of ["List", "Calendar"]) {
    await expectTouchTarget(page.getByRole("button", { name, exact: true }));
  }

  await page.goto("/exams");
  for (const name of ["List", "Calendar"]) {
    await expectTouchTarget(page.getByRole("button", { name, exact: true }));
  }
  await expectTouchTarget(page.getByRole("combobox", { name: "Term" }));

  await page.goto("/grades");
  await expectTouchTarget(page.getByTestId("grades-term-select"));

  await page.goto("/settings");
  await expectTouchTarget(page.getByRole("button", { name: "Toggle light and dark mode" }));

  for (const name of ["Neutral", "Colored"]) {
    await expectTouchTarget(page.getByRole("button", { name, exact: true }));
  }

  await expectTouchTarget(page.getByRole("combobox", { name: "Language" }));
  await expectTouchTarget(page.getByRole("button", { name: "Sign out" }));
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
