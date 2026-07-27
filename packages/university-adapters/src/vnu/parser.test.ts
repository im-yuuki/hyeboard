import { describe, expect, it } from "vitest";
import { parseGradesHtml, parseTranscriptHtml } from "./parser";

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
});
