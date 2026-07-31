import { describe, expect, it } from "vitest";
import {
  isDaotaoSessionExpired,
  parseExamCatalogHtml,
  parseExamsHtml,
  parseGradesHtml,
  parsePointDetailHtml,
  parsePortalNotice,
  parseSyllabusHtml,
  parseTranscriptHtml,
} from "./parser";
import {
  loginFormHtml,
  mixedAttributeLoginFormHtml,
  standaloneSessionEndedNoticeHtml,
} from "./session-expiry-fixtures";

const transcriptHtml = `
  <table>
    <tr><td>Sinh viên: SYNTHETIC STUDENT</td><td>Mã số: 20000001</td><td>Lớp quản lý: QH-SYNTHETIC</td></tr>
    <tr><td>HỌC KỲ 2 - 2025-2026. MÃ HỌC KỲ 252</td></tr>
    <tr>
      <td>1</td><td>INT1001</td><td>Reliable Systems</td><td>3</td><td>8.5</td><td>B+</td><td>3.5</td>
      <td><img onclick="detailPoint('123456','8.5','00000000001','42')"></td>
    </tr>
    <tr><td>HỌC KỲ 1 - 2024-2025. MÃ HỌC KỲ 241</td></tr>
    <tr><td>2</td><td>INT1002</td><td>Boundary Parsing</td><td>2</td><td></td><td></td><td></td><td></td></tr>
  </table>
  <div>Tổng tín chỉ: 5</div>
  <div>Tổng tín chỉ tích lũy: 4</div>
  <div>Điểm trung bình tích lũy hệ 4: 3.25</div>
`;

function gradeRow(courseCodeHtml: string): string {
  return `<tr><td>1</td><td>${courseCodeHtml}</td><td>Synthetic Course</td><td>3</td><td>8</td><td>B</td><td>3</td></tr>`;
}

function syllabusRow(courseCodeHtml: string): string {
  return `<tr><td>1</td><td>${courseCodeHtml}</td><td>Synthetic Course</td><td>3</td><td><a href="synthetic.pdf">PDF</a></td><td>-</td><td>1 KB</td><td>01/01/2000</td></tr>`;
}

function examRow(compositeCodeHtml: string, classId?: string): string {
  const hiddenClassId = classId ? `<input type="hidden" name="hidCrdID" value="${classId}">` : "";
  return `<tr id="1"><td>${hiddenClassId}1</td><td>${compositeCodeHtml}</td><td>Synthetic Course</td><td>01/01/2000</td><td>1(08:00)</td><td>Written</td><td>R-SYNTHETIC</td><td>S-SYNTHETIC</td></tr>`;
}

describe("VNU course-code cells", () => {
  it.each([
    ["plain internal space", "INT 3103", "INT 3103"],
    ["named NBSP", "INT&nbsp;3103", "INT 3103"],
    ["decimal NBSP", "INT&#160;3103A", "INT 3103A"],
    ["hex NBSP", "đt&#xA0;3103b", "đt 3103b"],
    ["multi-letter suffix", "INT 3103AB", "INT 3103AB"],
    ["hyphen letter suffix", "INE2102-E", "INE2102-E"],
    ["multi-letter hyphen suffix", "INE2102-EF", "INE2102-EF"],
    ["repeated spaces", "INT   3103", "INT 3103"],
    ["tabs and newlines", "INT\t\n3103Z", "INT 3103Z"],
    ["intervening tags", "INT<span></span>3103", "INT 3103"],
  ])("preserves normalized display for %s in grades, term groups, transcript, and syllabus", (_case, source, display) => {
    const gradesHtml = `<table><tr><td>HỌC KỲ. MÃ HỌC KỲ 252</td></tr>${gradeRow(source)}</table>`;
    const grades = parseGradesHtml(gradesHtml);
    const transcript = parseTranscriptHtml(gradesHtml);
    const syllabus = parseSyllabusHtml(`<table>${syllabusRow(source)}</table>`);

    expect(grades.rows.map((row) => row.courseCode)).toEqual([display]);
    expect(grades.terms[0]?.rows.map((row) => row.courseCode)).toEqual([display]);
    expect(transcript.terms[0]?.rows.map((row) => row.courseCode)).toEqual([display]);
    expect(syllabus.map((row) => row.courseCode)).toEqual([display]);
  });

  it.each([
    ["one-letter prefix", "I 3103"],
    ["seven-letter prefix", "ABCDEFG 3103"],
    ["two-digit number", "INT 31"],
    ["five-digit number", "INT 31035"],
    ["malformed internal split", "IN T 3103"],
    ["trailing prose", "INT 3103 synthetic prose"],
    ["punctuation", "INT-3103"],
    ["bare hyphen suffix", "INE2102-"],
    ["multiple hyphen suffixes", "INE2102-E-F"],
  ])("skips malformed %s grade and syllabus rows", (_case, source) => {
    expect(parseGradesHtml(`<table>${gradeRow(source)}</table>`).rows).toEqual([]);
    expect(parseSyllabusHtml(`<table>${syllabusRow(source)}</table>`)).toEqual([]);
  });
});

describe("VNU exam composite codes", () => {
  it.each([
    ["252-INT 3103 6", { termCode: "252", courseCode: "INT 3103", classNo: "6" }],
    ["241-FLF1107-01", { termCode: "241", courseCode: "FLF1107", classNo: "01" }],
    ["252-INT 3103A CN7", { termCode: "252", courseCode: "INT 3103A", classNo: "CN7" }],
    ["252-INT 3103A", { termCode: "252", courseCode: "INT 3103A", classNo: undefined }],
    ["252-INE2102-E 6", { termCode: "252", courseCode: "INE2102-E", classNo: "6" }],
    ["252-INE2102-E", { termCode: "252", courseCode: "INE2102-E", classNo: undefined }],
    ["252-INE2102-EF 6", { termCode: "252", courseCode: "INE2102-EF", classNo: "6" }],
    ["252-INT 3103AB CN7", { termCode: "252", courseCode: "INT 3103AB", classNo: "CN7" }],
    ["252-INT 3103 - CN7", { termCode: "252", courseCode: "INT 3103", classNo: "CN7" }],
    ["252-INT 3103--71", { termCode: "252", courseCode: "INT 3103", classNo: "71" }],
    ["252-đt&nbsp;3103Z-CN07", { termCode: "252", courseCode: "đt 3103Z", classNo: "CN07" }],
    ["252-INT<span></span>3103A\tCN7", { termCode: "252", courseCode: "INT 3103A", classNo: "CN7" }],
  ])("parses %s identically for schedules and catalogs", (source, expected) => {
    expect(parseExamsHtml(`<table>${examRow(source)}</table>`)[0]).toMatchObject(expected);
    expect(parseExamCatalogHtml(`<table>${examRow(source, "CLASS-SYNTHETIC")}</table>`)[0]).toMatchObject({
      classId: "CLASS-SYNTHETIC",
      ...expected,
    });
  });

  it.each([
    ["two-digit term", "25-INT 3103 6"],
    ["four-digit term", "2521-INT 3103 6"],
    ["missing prefix separator", "252 INT 3103 6"],
    ["two-digit course number", "252-INT 31 6"],
    ["five-digit course number", "252-INT 31035 6"],
    ["invalid class token", "252-INT 3103 CN"],
    ["trailing prose", "252-INT 3103 CN7 synthetic prose"],
  ])("keeps malformed %s schedules whole and applies only catalog term-prefix fallback", (_case, source) => {
    expect(parseExamsHtml(`<table>${examRow(source)}</table>`)[0]).toMatchObject({
      courseCode: source,
      termCode: undefined,
      classNo: undefined,
    });

    const catalog = parseExamCatalogHtml(`<table>${examRow(source, "CLASS-SYNTHETIC")}</table>`)[0];
    const prefixed = /^(\d{3})-(.+)$/.exec(source);
    expect(catalog).toMatchObject(prefixed
      ? { termCode: prefixed[1], courseCode: prefixed[2], classNo: undefined }
      : { courseCode: source, termCode: undefined, classNo: undefined });
  });

  it("normalizes malformed fallback display without inventing a class number", () => {
    const source = "252-INT&nbsp;<span></span>31\t\nsynthetic prose";
    const normalizedComposite = "252-INT 31 synthetic prose";

    expect(parseExamsHtml(`<table>${examRow(source)}</table>`)[0]).toMatchObject({
      courseCode: normalizedComposite,
      termCode: undefined,
      classNo: undefined,
    });
    expect(parseExamCatalogHtml(`<table>${examRow(source, "CLASS-SYNTHETIC")}</table>`)[0]).toMatchObject({
      courseCode: "INT 31 synthetic prose",
      termCode: "252",
      classNo: undefined,
    });
  });

  it.each(["252-INE2102-", "252-INE2102-E-F"]) ("does not split malformed hyphen suffix %s in schedule or catalog", (source) => {
    expect(parseExamsHtml(`<table>${examRow(source)}</table>`)[0]).toMatchObject({ courseCode: source, termCode: undefined, classNo: undefined });
    expect(parseExamCatalogHtml(`<table>${examRow(source, "CLASS-SYNTHETIC")}</table>`)[0]).toMatchObject({ courseCode: source, termCode: undefined, classNo: undefined });
  });

  it("requires both hidden course identity and eight-column evidence for catalog rows", () => {
    const withoutIdentity = examRow("252-INT 3103 6");
    const sevenColumns = examRow("252-INT 3103 6", "CLASS-SYNTHETIC").replace("<td>S-SYNTHETIC</td>", "");

    expect(parseExamCatalogHtml(`<table>${withoutIdentity}${sevenColumns}</table>`)).toEqual([]);
  });
});

describe("parseTranscriptHtml", () => {
  it("reuses the own-grades rows and groups a full transcript by maHK", () => {
    const grades = parseGradesHtml(transcriptHtml);
    const transcript = parseTranscriptHtml(transcriptHtml);

    expect(grades.rows).toHaveLength(2);
    expect(grades.rows[0]).toMatchObject({ classId: "123456", termOrdinal: "42" });
    expect(transcript).toEqual({
      header: { studentName: "SYNTHETIC STUDENT", studentCode: "20000001", className: "QH-SYNTHETIC" },
      terms: [
        {
          maHK: "252",
          label: "HỌC KỲ 2 - 2025-2026. MÃ HỌC KỲ 252",
          rows: [{
            courseCode: "INT1001",
            courseName: "Reliable Systems",
            credits: 3,
            grade10: 8.5,
            letterGrade: "B+",
            grade4: 3.5,
            classId: "123456",
            termOrdinal: "42",
          }],
        },
        {
          maHK: "241",
          label: "HỌC KỲ 1 - 2024-2025. MÃ HỌC KỲ 241",
          rows: [{ courseCode: "INT1002", courseName: "Boundary Parsing", credits: 2 }],
        },
      ],
      totals: { totalCredits: 5, accumulatedCredits: 4, gpa4: 3.25 },
      notice: undefined,
    });
  });

  it("fails closed on malformed identity, scores, and detail arguments", () => {
    const html = `<table>
      <tr><td>HỌC KỲ 1 - 2025-2026. MÃ HỌC KỲ 251</td></tr>
      <tr><td>1</td><td>INT1001</td><td>Reliable Systems</td><td>x</td><td>x</td><td></td><td>x</td><td><img onclick="detailPoint('bad-id','','','bad-term')"></td></tr>
    </table>`;

    expect(parseTranscriptHtml(html)).toEqual({
      header: {},
      terms: [{ maHK: "251", label: "HỌC KỲ 1 - 2025-2026. MÃ HỌC KỲ 251", rows: [{ courseCode: "INT1001", courseName: "Reliable Systems" }] }],
      totals: {},
      notice: undefined,
    });
  });

  it("decodes table-cell entities exactly once", () => {
    const grades = parseGradesHtml(`<table><tr>
      <td>1</td><td>INT1001</td><td>&amp;#xEA;</td><td>3</td><td>8.0</td><td>B</td><td>3.0</td>
    </tr></table>`);

    expect(grades.rows[0]?.courseName).toBe("&#xEA;");
  });
});

describe("parsePointDetailHtml", () => {
  it("parses synthetic component rows and preserves the cosmetic footer separately", () => {
    const detail = parsePointDetailHtml(`<table>
      <tr><td>STT</td><td>Bản chất kỳ thi</td><td>TS</td><td>Lần thi</td><td>Điểm</td><td>Ghi chú</td></tr>
      <tr><td>1</td><td>Giữa kỳ</td><td>0.4</td><td>1</td><td>8.5</td><td></td></tr>
      <tr><td>2</td><td>Thi cuối kỳ</td><td>0.6</td><td>1</td><td>9</td><td></td></tr>
      <tr><td colspan="6">Tổng điểm: 8.8</td></tr>
    </table>`);

    expect(detail.components).toEqual([
      { index: 1, nature: "Giữa kỳ", weight: 0.4, attempt: 1, score: 8.5, notes: undefined },
      { index: 2, nature: "Thi cuối kỳ", weight: 0.6, attempt: 1, score: 9, notes: undefined },
    ]);
    expect(detail.displayTotalEcho).toBe("8.8");
  });
});

describe("parsePortalNotice entity decoding", () => {
  it.each([
    ["an encoded entity", "&amp;#xEA;", "&#xEA;"],
    ["a supplementary scalar", "&#x1F600;", "😀"],
    ["the maximum scalar", "&#x10FFFF;", String.fromCodePoint(0x10ffff)],
    ["a surrogate", "&#xD800;", "&#xD800;"],
    ["an out-of-range value", "&#x110000;", "&#x110000;"],
    ["a malformed reference", "&#xZZ;", "&#xZZ;"],
  ])("decodes %s in one pass", (_case, entity, expected) => {
    expect(parsePortalNotice(`<script>alert('${entity}')</script>`)).toBe(expected);
  });
});

describe("isDaotaoSessionExpired", () => {
  const authenticatedUrl = "https://daotao.vnu.edu.vn/StdInfo/StudentProfile.asp";

  it("matches the trusted login URL case-insensitively and permits a query", () => {
    expect(isDaotaoSessionExpired("https://daotao.vnu.edu.vn/DKMH/LOGIN.ASP?return=profile", "")).toBe(true);
  });

  it("rejects a login-looking URL on a foreign origin", () => {
    expect(isDaotaoSessionExpired("https://example.com/dkmh/login.asp", "")).toBe(false);
  });

  it.each([loginFormHtml, mixedAttributeLoginFormHtml])("matches a complete login form", (html) => {
    expect(isDaotaoSessionExpired(authenticatedUrl, html)).toBe(true);
  });

  it.each([
    ["comment", "<!-- ".repeat(5_000)],
    ["script", "<script>".repeat(5_000)],
  ])("fails closed after repeated unterminated %s openers", (_case, openers) => {
    const loginForm = `<form action="/dkmh/login.asp"><input name="txtLoginId"><input name="txtPassword"></form>`;

    expect(isDaotaoSessionExpired(authenticatedUrl, `${openers}${loginForm}`)).toBe(false);
  });

  it.each([
    ["a format end tag", "</format>"],
    ["a form-invalid end tag", "</form-invalid>"],
    ["a comment", "<!-- </form> -->"],
    ["a script", "<script>const closingTag = '</form>';</script>"],
  ])("ignores a fake form closing tag in %s", (_case, fakeClosingTag) => {
    const html = `<form action="/dkmh/login.asp"><input name="txtLoginId">${fakeClosingTag}<input name="txtPassword"></form>`;

    expect(isDaotaoSessionExpired(authenticatedUrl, html)).toBe(true);
  });

  it.each([
    `<form action="/dkmh/login.asp"><input name="txtLoginId"></form>`,
    `<form action='/dkmh/login.asp'><input name='txtPassword'></form>`,
  ])("rejects a login form missing one required control", (html) => {
    expect(isDaotaoSessionExpired(authenticatedUrl, html)).toBe(false);
  });

  it("scans many unterminated login-form candidates without matching controls across forms", () => {
    const candidates = Array.from({ length: 20_000 }, (_, index) => (
      `<form action="/dkmh/login.asp"><input name="${index % 2 === 0 ? "txtLoginId" : "txtPassword"}">`
    )).join("");

    expect(isDaotaoSessionExpired(authenticatedUrl, `${candidates}</form>`)).toBe(false);
  });

  it("rejects a complete login form nested inside a non-login form", () => {
    const html = `<form action="/account"><form action="/dkmh/login.asp"><input name="txtLoginId"><input name="txtPassword"></form></form>`;

    expect(isDaotaoSessionExpired(authenticatedUrl, html)).toBe(false);
  });

  it("taints an outer login form containing a nested form, then resumes after the outer close", () => {
    const malformed = `<form action="/dkmh/login.asp"><input name="txtLoginId"><form action="/account"></form><input name="txtPassword"></form>`;
    const valid = `<form action="/dkmh/login.asp"><input name="txtLoginId"><input name="txtPassword"></form>`;

    expect(isDaotaoSessionExpired(authenticatedUrl, malformed)).toBe(false);
    expect(isDaotaoSessionExpired(authenticatedUrl, `${malformed}${valid}`)).toBe(true);
  });

  it("matches the complete standalone session-ended notice", () => {
    expect(isDaotaoSessionExpired(authenticatedUrl, standaloneSessionEndedNoticeHtml)).toBe(true);
  });

  it("uses body evidence when the final URL is malformed", () => {
    expect(isDaotaoSessionExpired("not a URL", standaloneSessionEndedNoticeHtml)).toBe(true);
  });

  it.each([
    ["an extra row", `<html><body><table><tr><td>Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.</td></tr><tr><td></td></tr></table></body></html>`],
    ["an extra cell", `<html><body><table><tr><td>Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.</td><td></td></tr></table></body></html>`],
    ["an empty button", `<html><body><table><tr><td>Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.<button></button></td></tr></table></body></html>`],
  ])("rejects a standalone notice with %s", (_case, html) => {
    expect(isDaotaoSessionExpired(authenticatedUrl, html)).toBe(false);
  });

  it.each([
    "Please log in because your session may have ended.",
    `<html><body><form><input name="StdCode" value="SYNTHETIC"></form><table><tr><td>Current term</td></tr></table></body></html>`,
    `<html><body><table><tr><td><font color="red">Unrelated notice.</font></td></tr></table></body></html>`,
    `<html><body><table><tr><td>Phiên làm việc đã kết thúc.</td></tr></table></body></html>`,
    `<html><body><header>Authenticated profile</header><table><tr><td>Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.</td></tr></table></body></html>`,
    `<html><body><table><tr><td>Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.<input name="state"></td></tr></table></body></html>`,
    `<html><body><table><tr><td>Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.</td></tr></table><table><tr><td></td></tr></table></body></html>`,
  ])("rejects non-standalone prose and authenticated content", (html) => {
    expect(isDaotaoSessionExpired(authenticatedUrl, html)).toBe(false);
  });
});
