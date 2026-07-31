// Raw, parsed-from-HTML shapes scraped from daotao.vnu.edu.vn (classic ASP,
// server-rendered, no JSON API). See har-notes.md for the page-by-page
// research this parser is based on.

export type VnuProfile = {
  studentCode?: string;
  fullName?: string;
  dob?: string;
  internalStudentId?: string; // hidStdID hidden field, used as selStd in exam URLs
  internalUnivId?: string; // selected UnivID option value, used as selUniv in exam URLs
  levelName?: string;
  trainingModeName?: string;
  programTypeName?: string;
  cohortName?: string;
  className?: string;
  facultyName?: string;
  majorName?: string;
};

export type VnuGradeRow = {
  termCode: string;
  termLabel: string;
  courseCode: string;
  courseName: string;
  credits?: number;
  point10?: number;
  letter?: string;
  point4?: number;
  // Both lifted from the row's "Chi tiết" cell <img onClick="detailPoint(
  // '{classId}','{grade10}','{stdId}','{termOrdinal}')"> — absent when the
   // row renders no detail link. Own grades preserve these only to request
   // the authenticated student's component breakdown.
  classId?: string;
  termOrdinal?: string;
};

export type VnuGradesResult = {
  rows: VnuGradeRow[];
  terms: VnuGradeTerm[];
  totalCredits?: number;
  totalAccumulatedCredits?: number;
  cumulativeGpa4?: number;
};

export type VnuGradeTerm = {
  termCode: string;
  termLabel?: string;
  rows: VnuGradeRow[];
};

export type VnuTranscriptRow = {
  courseCode: string;
  courseName: string;
  credits?: number;
  grade10?: number;
  letterGrade?: string;
  grade4?: number;
  classId?: string;
  termOrdinal?: string;
};

export type VnuTranscriptTerm = {
  maHK: string;
  label?: string;
  rows: VnuTranscriptRow[];
};

export type VnuTranscript = {
  header: VnuTranscriptHeader;
  terms: VnuTranscriptTerm[];
  totals: {
    totalCredits?: number;
    accumulatedCredits?: number;
    gpa4?: number;
  };
  notice?: string;
};

export type VnuTermProgressRow = {
  termCode?: string;
  termLabel: string;
  conductScore?: number;
  termGpa?: number;
  cumulativeGpa?: number;
};

export type VnuExamTermOption = {
  value: string;
  label: string;
  selected: boolean;
};

export type VnuExamRow = {
  termCode?: string;
  courseCode: string;
  classNo?: string; // class/group number parsed from the exam-code cell; shape varies (e.g. "6", "01", "CN7")
  courseName: string;
  examDate: string; // DD/MM/YYYY as rendered by the portal
  session?: number;
  hour?: string; // HH:MM
  method?: string;
  room?: string;
  seatNumber?: string;
};

export type VnuSyllabusRow = {
  courseCode: string;
  courseName: string;
  credits?: number;
  fileUrl?: string;
  fileSize?: string;
  uploadedAt?: string;
};

// StdExamination.asp?selViewType=StdExam&vTermID=... rows, but scoped to the
// class-lookup resolver: the same rows parseExamsHtml reads, plus the hidden
// hidCrdID field (the portal's internal 6-digit class id) that only this use
// case needs.
export type VnuExamCatalogRow = {
  classId: string; // hidCrdID hidden input — the portal's internal class id
  termCode?: string; // maHK, e.g. "252" for HK2 2025-2026 — see exam-terms.ts
  courseCode: string;
  classNo?: string; // class/group number within the course; shape varies (e.g. "6", "01", "CN7")
  courseName: string;
  examDate: string; // DD/MM/YYYY as rendered by the portal
  session?: number; // exam session ordinal, same shape as VnuExamRow.session
  hour?: string; // HH:MM, same shape as VnuExamRow.hour
  method?: string;
  room?: string;
  seatNumber?: string;
};

// One row of the static, verified vTermID <-> maHK <-> academic-year table
// (see exam-terms.ts). Kept as raw data (no pre-rendered label) so the
// frontend can produce a localized label through the i18n system.
export type VnuExamTermInfo = {
  ordinal: string; // vTermID query-param value for StdExamination.asp
  maHK: string; // 3-digit YYS code: YY = 2-digit academic-year start, S = 1/2/3
  session: 1 | 2 | 3; // 1 = HK1 ("Semester 1"), 2 = HK2, 3 = HK2 extra/supplementary session
  yearStart: number; // academic year start, e.g. 2025 for 2025-2026
};

// ListPoint/listpoint_Brc1.asp page header — the requested student's identity
// line ("Sinh viên: {name}", "Mã số: {8-digit code}", "Lớp quản lý: {class}"),
// rendered for whatever selStd is passed (the ONLY live-verified student-role
// StdID -> identity oracle, see har-notes.md). All fields stay absent when the
// portal renders no header for the requested StdID — never filled with guessed
// values.
export type VnuTranscriptHeader = {
  studentName?: string; // "Sinh viên:" value — the student's full name
  studentCode?: string; // "Mã số:" value — the 8-digit public-facing student code
  className?: string; // "Lớp quản lý:" value — the managing class, e.g. "QH-20XX-I/CQ-I-XXX0"
};

// ListPoint/detailPoint.asp — per-component grade breakdown popup for one
// class (live-verified shape, see har-notes.md). One row per exam component.
export type VnuPointDetailComponent = {
  index: number; // STT column ordinal
  nature: string; // portal's "Bản chất kỳ thi", e.g. "Thi cuối kỳ" / "Kiểm tra"
  weight?: number; // TS column, e.g. 0.6
  attempt?: number; // "Lần thi" column
  score?: number; // "Điểm" column
  notes?: string; // "Ghi chú" column, usually empty
};

export type VnuPointDetail = {
  headerLabel?: string; // raw portal header line, e.g. "Điểm chi tiết môn học — Học kỳ N năm học YYYY-YYYY. Mã học kỳ ZZZ"
  termCode?: string; // maHK parsed out of the header line
  components: VnuPointDetailComponent[];
  // The popup's "Tổng điểm" footer is a verbatim echo of the client-supplied
  // val= query param — live-verified that the server neither recomputes nor
  // validates it (reloading with a different val flips the footer while the
  // components stay identical). Exposed under a name that makes its
  // display-only nature explicit; the authoritative total lives in
  // listpoint_Brc1.asp's "Điểm hệ 10 cuối cùng" column, not here.
  displayTotalEcho?: string;
};
