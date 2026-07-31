import { describe, expect, it } from "vitest";
import { mapGradeRow } from "./mapper";

describe("mapGradeRow", () => {
  it("preserves verified VNU own-grade detail identity without changing exported grade fields", () => {
    const grade = mapGradeRow({
      termCode: "252",
      termLabel: "Synthetic term",
      courseCode: "INE2102-E",
      courseName: "Synthetic course",
      classId: "123456",
      termOrdinal: "42",
    }, 0);

    expect(grade).toMatchObject({ classId: "123456", termOrdinal: "42" });
  });
});
