import { describe, expect, it } from "vitest";
import { collapseVnuCourseCodeDisplay, vnuCourseCodeKey } from "./course-code";

const ECMASCRIPT_WHITESPACE_AND_LINE_TERMINATORS = [
  "\u0009",
  "\u000A",
  "\u000B",
  "\u000C",
  "\u000D",
  "\u0020",
  "\u00A0",
  "\u1680",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200A",
  "\u2028",
  "\u2029",
  "\u202F",
  "\u205F",
  "\u3000",
  "\uFEFF",
] as const;

describe("collapseVnuCourseCodeDisplay", () => {
  it.each(ECMASCRIPT_WHITESPACE_AND_LINE_TERMINATORS.map((character) => [
    `U+${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`,
    character,
  ]))("collapses %s runs to one ASCII space and trims them", (_label, character) => {
    expect(collapseVnuCourseCodeDisplay(`${character}${character}int${character}${character}3103${character}`)).toBe("int 3103");
  });

  it.each([
    ["U+0085", "\u0085"],
    ["U+200B", "\u200B"],
  ])("does not collapse excluded %s", (_label, character) => {
    expect(collapseVnuCourseCodeDisplay(`${character}int${character}3103${character}`)).toBe(`${character}int${character}3103${character}`);
  });
});

describe("vnuCourseCodeKey", () => {
  it.each(ECMASCRIPT_WHITESPACE_AND_LINE_TERMINATORS.map((character) => [
    `U+${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`,
    character,
  ]))("removes %s and uppercases the result", (_label, character) => {
    expect(vnuCourseCodeKey(`${character}int${character}${character}3103-a${character}`)).toBe("INT3103-A");
  });

  it.each([
    ["U+0085", "\u0085"],
    ["U+200B", "\u200B"],
    ["U+0000", "\u0000"],
  ])("preserves excluded or non-whitespace control %s", (_label, character) => {
    expect(vnuCourseCodeKey(`${character}int${character}3103${character}`)).toBe(`${character}INT${character}3103${character}`);
  });
});
