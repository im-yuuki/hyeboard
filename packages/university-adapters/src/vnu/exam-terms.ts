// Static, hand-verified vTermID <-> maHK <-> academic-year table for
// StdExamination.asp?selViewType=StdExam&vTermID=... — the portal has no
// endpoint that lists this mapping itself (parseExamTermOptions scrapes a
// <select> that only contains terms the *current* student has exam rows
// for), so it's captured here once as reference data instead of being
// re-derived from a page on every request.
//
// vTermID ordinals are assigned per session slot in chronological order —
// NOT arithmetic from maHK — so a "HK2 extra"/supplementary session (maHK
// ending in 3) consumes the next ordinal rather than leaving a gap. maHK
// itself follows a YYS scheme: YY is the 2-digit academic-year start year,
// S is 1 for HK1, 2 for HK2, or 3 for a HK2 extra/supplementary session
// (still "Học kỳ 2" for display purposes, see VnuExamTermInfo.session).
//
// Ordered oldest-first to mirror how the table was verified; callers that
// want a newest-first term picker should reverse the array themselves.
import type { VnuExamTermInfo } from "./types";

export const VNU_EXAM_TERMS: readonly VnuExamTermInfo[] = [
  { ordinal: "003", maHK: "071", session: 1, yearStart: 2007 },
  { ordinal: "004", maHK: "072", session: 2, yearStart: 2007 },
  { ordinal: "005", maHK: "081", session: 1, yearStart: 2008 },
  { ordinal: "006", maHK: "082", session: 2, yearStart: 2008 },
  { ordinal: "007", maHK: "091", session: 1, yearStart: 2009 },
  { ordinal: "008", maHK: "092", session: 2, yearStart: 2009 },
  { ordinal: "009", maHK: "101", session: 1, yearStart: 2010 },
  { ordinal: "010", maHK: "102", session: 2, yearStart: 2010 },
  { ordinal: "011", maHK: "111", session: 1, yearStart: 2011 },
  { ordinal: "012", maHK: "112", session: 2, yearStart: 2011 },
  { ordinal: "013", maHK: "121", session: 1, yearStart: 2012 },
  { ordinal: "014", maHK: "122", session: 2, yearStart: 2012 },
  { ordinal: "015", maHK: "131", session: 1, yearStart: 2013 },
  { ordinal: "016", maHK: "132", session: 2, yearStart: 2013 },
  { ordinal: "017", maHK: "141", session: 1, yearStart: 2014 },
  { ordinal: "018", maHK: "142", session: 2, yearStart: 2014 },
  { ordinal: "019", maHK: "151", session: 1, yearStart: 2015 },
  { ordinal: "020", maHK: "152", session: 2, yearStart: 2015 },
  { ordinal: "021", maHK: "161", session: 1, yearStart: 2016 },
  { ordinal: "022", maHK: "162", session: 2, yearStart: 2016 },
  { ordinal: "023", maHK: "171", session: 1, yearStart: 2017 },
  { ordinal: "024", maHK: "172", session: 2, yearStart: 2017 },
  { ordinal: "025", maHK: "181", session: 1, yearStart: 2018 },
  { ordinal: "026", maHK: "182", session: 2, yearStart: 2018 },
  { ordinal: "027", maHK: "191", session: 1, yearStart: 2019 },
  { ordinal: "028", maHK: "192", session: 2, yearStart: 2019 },
  { ordinal: "029", maHK: "201", session: 1, yearStart: 2020 },
  { ordinal: "030", maHK: "202", session: 2, yearStart: 2020 },
  { ordinal: "031", maHK: "203", session: 3, yearStart: 2020 },
  { ordinal: "032", maHK: "211", session: 1, yearStart: 2021 },
  { ordinal: "033", maHK: "212", session: 2, yearStart: 2021 },
  { ordinal: "034", maHK: "213", session: 3, yearStart: 2021 },
  { ordinal: "035", maHK: "221", session: 1, yearStart: 2022 },
  { ordinal: "036", maHK: "222", session: 2, yearStart: 2022 },
  { ordinal: "037", maHK: "223", session: 3, yearStart: 2022 },
  { ordinal: "038", maHK: "231", session: 1, yearStart: 2023 },
  { ordinal: "039", maHK: "232", session: 2, yearStart: 2023 },
  { ordinal: "040", maHK: "233", session: 3, yearStart: 2023 },
  { ordinal: "041", maHK: "241", session: 1, yearStart: 2024 },
  { ordinal: "042", maHK: "242", session: 2, yearStart: 2024 },
  { ordinal: "043", maHK: "243", session: 3, yearStart: 2024 },
  { ordinal: "044", maHK: "251", session: 1, yearStart: 2025 },
  { ordinal: "045", maHK: "252", session: 2, yearStart: 2025 },
  { ordinal: "046", maHK: "253", session: 3, yearStart: 2025 },
];
