import { describe, expect, it } from "vitest";
import { isDaotaoSessionExpired, parseGradesHtml, parsePortalNotice, parseTranscriptHtml } from "./parser";
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
