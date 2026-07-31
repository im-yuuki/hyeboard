import { expect } from "@playwright/test";
import { authenticateDemoPage } from "./base";

export const SYNTHETIC_OWN_STUDENT_CODE = "99000000";

export const SYNTHETIC_TARGET_STUDENT_CODE = "99000001";

export const SYNTHETIC_ERROR_STUDENT_CODE = "99000002";

export const SYNTHETIC_OWN_INTERNAL_ID = "99000000000";

export const SYNTHETIC_TARGET_INTERNAL_ID = "99000000001";

export const SYNTHETIC_ERROR_INTERNAL_ID = "99000000002";

export const SYNTHETIC_CLASS_ID = "990099";

export type LookupRequestCounts = { exams: number; studentCode: number; studentId: number; transcript: number };

export async function openMockedLookup(page: import("@playwright/test").Page, bulkMaximum: number | null = 50): Promise<LookupRequestCounts> {
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
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { html: `<table><tr><td>STT</td><td>Bản chất kỳ thi</td><td>TS</td><td>Lần thi</td><td>Điểm</td><td>Ghi chú</td></tr><tr><td>1</td><td>Giữa kỳ</td><td>0.4</td><td>1</td><td>8.5</td><td></td></tr><tr><td>2</td><td>Thi cuối kỳ</td><td>0.6</td><td>1</td><td>9</td><td></td></tr><tr><td colspan="6">Tổng điểm: 8.8</td></tr></table>` }, error: null }) });
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
  await authenticateDemoPage(page, "/lookup");
  await expect(page.getByRole("heading", { name: "Lookup", exact: true })).toBeVisible();
  return requestCounts;
}

export async function switchDemoShellToVnu(page: import("@playwright/test").Page): Promise<void> {
  await authenticateDemoPage(page);
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

export async function openMockedVnuLookup(page: import("@playwright/test").Page): Promise<() => number> {
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

export async function openMockedVnuDocuments(page: import("@playwright/test").Page): Promise<() => number> {
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

export type SyntheticBulkMode = "stdid-to-code" | "code-to-stdid" | "stdid-to-transcript";

export function syntheticBulkResult(mode: SyntheticBulkMode, target: string) {
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

export async function fulfillBulkSuccess(route: import("@playwright/test").Route, chunks: string[][]) {
  const body = route.request().postDataJSON() as { mode: SyntheticBulkMode; targets: string[] };
  chunks.push([...body.targets]);
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { items: body.targets.map((target) => ({ target, status: "ok", result: syntheticBulkResult(body.mode, target) })) }, error: null }),
  });
}
