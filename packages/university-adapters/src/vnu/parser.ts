// Regex-based HTML scraping for daotao.vnu.edu.vn (classic ASP, no JSON API).
// Attribute order in the source markup is inconsistent (id before/after name,
// value before/after disabled, etc.), so helpers scan whole tags rather than
// assuming a fixed attribute order. See har-notes.md for the exact page
// structures these patterns were derived from.

import type {
  VnuExamCatalogRow,
  VnuExamRow,
  VnuExamTermOption,
  VnuGradeRow,
  VnuGradesResult,
  VnuPointDetail,
  VnuPointDetailComponent,
  VnuProfile,
  VnuSyllabusRow,
  VnuTermProgressRow,
  VnuTranscript,
  VnuTranscriptHeader,
} from "./types";
import { collapseVnuCourseCodeDisplay } from "./course-code";

const DAOTAO_ORIGIN = "https://daotao.vnu.edu.vn";
const DAOTAO_LOGIN_PATH = "/dkmh/login.asp";
const DAOTAO_SESSION_ENDED_SENTENCE = "Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.";
const HTML_ENTITY_RE = /&(?:nbsp|amp|lt|gt|quot|#[^;&\s]*);/gi;
const VNU_COURSE_CODE_SOURCE = "[A-Za-zĐđ]{2,6} ?\\d{3,4}[A-Za-zĐđ]*";
const VNU_COURSE_CODE_RE = new RegExp(`^${VNU_COURSE_CODE_SOURCE}$`);
const VNU_EXAM_COMPOSITE_RE = new RegExp(
  `^(\\d{3})-(${VNU_COURSE_CODE_SOURCE})(?:[ -]+(\\d+|[A-Za-zĐđ]+\\d+))?$`,
);

function decodeEntities(text: string): string {
  return collapseVnuCourseCodeDisplay(
    text.replace(HTML_ENTITY_RE, (entity) => {
      const token = entity.slice(1, -1).toLowerCase();
      if (token === "nbsp") return " ";
      if (token === "amp") return "&";
      if (token === "lt") return "<";
      if (token === "gt") return ">";
      if (token === "quot") return '"';

      const numericMatch = token.match(/^#(?:(x)([0-9a-f]+)|(\d+))$/i);
      if (!numericMatch) return entity;

      const codePoint = Number.parseInt(numericMatch[2] ?? numericMatch[3], numericMatch[1] ? 16 : 10);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return entity;
      return String.fromCodePoint(codePoint);
    }),
  );
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "));
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  const normalized = value?.trim().replace(",", ".");
  if (!normalized || !/^-?\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function attrOf(tag: string, attr: string): string | undefined {
  const match = tag.match(new RegExp(`(?:^|\\s)${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match?.[1] ?? match?.[2];
}

function tagWithAttr(html: string, tag: string, attrName: string, attrValue: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    if (attrOf(match[0], attrName)?.toLowerCase() === attrValue.toLowerCase()) return match[0];
  }
  return undefined;
}

function inputValue(html: string, name: string): string | undefined {
  const tag = tagWithAttr(html, "input", "name", name);
  const value = tag ? attrOf(tag, "value") : undefined;
  return value?.trim() || undefined;
}

function selectBlock(html: string, name: string): string | undefined {
  const re = new RegExp(`<select\\b[^>]*name\\s*=\\s*"${name}"[^>]*>([\\s\\S]*?)</select>`, "i");
  return re.exec(html)?.[1];
}

function selectedOption(html: string, name: string): { value: string; label: string } | undefined {
  const block = selectBlock(html, name);
  if (!block) return undefined;
  const optionRe = /<option\b([^>]*)>([^<]*)<\/option>/gi;
  let match: RegExpExecArray | null;
  while ((match = optionRe.exec(block))) {
    if (/selected/i.test(match[1])) {
      return { value: attrOf(`<option ${match[1]}>`, "value") ?? "", label: decodeEntities(match[2]) };
    }
  }
  return undefined;
}

export function parseProfileHtml(html: string): VnuProfile {
  const univ = selectedOption(html, "UnivID");
  const major = selectedOption(html, "BrcID");
  const cls = selectedOption(html, "ClsID");
  const cohort = selectedOption(html, "PrmID");
  const level = selectedOption(html, "LevID");
  const mode = selectedOption(html, "SysID");
  const progType = selectedOption(html, "PrgTypeID");
  return {
    studentCode: inputValue(html, "StdCode"),
    fullName: inputValue(html, "StdName"),
    dob: inputValue(html, "StdDob"),
    internalStudentId: inputValue(html, "hidStdID"),
    internalUnivId: univ?.value,
    facultyName: univ?.label,
    majorName: major?.label,
    className: cls?.label,
    cohortName: cohort?.label,
    levelName: level?.label,
    trainingModeName: mode?.label,
    programTypeName: progType?.label,
  };
}

function tdCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
}

// ListPoint/listpoint_Brc1.asp — term-grouped transcript table plus
// plain-text cumulative summary lines after the table.
export function parseGradesHtml(html: string): VnuGradesResult {
  const rows: VnuGradeRow[] = [];
  const terms: VnuGradesResult["terms"] = [];
  let currentTerm: VnuGradesResult["terms"][number] | undefined;
  let currentTermCode: string | undefined;
  let currentTermLabel: string | undefined;
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = trRe.exec(html))) {
    const cells = tdCells(match[1]);
    if (!cells.length) continue;
    const joined = cells.join(" ");
    const termHeaderMatch = joined.match(/MÃ HỌC KỲ\s*(\d+)/i);
    if (termHeaderMatch && cells.length <= 2) {
      currentTermCode = termHeaderMatch[1];
      currentTermLabel = collapseVnuCourseCodeDisplay(joined);
      currentTerm = { termCode: currentTermCode, termLabel: currentTermLabel || undefined, rows: [] };
      terms.push(currentTerm);
      continue;
    }
    if (cells.length >= 7 && VNU_COURSE_CODE_RE.test(cells[1] ?? "")) {
      const credits = parseOptionalNumber(cells[3]);
      const point10 = parseOptionalNumber(cells[4]);
      const point4 = parseOptionalNumber(cells[6]);
      const detailMatch = match[1].match(/detailPoint\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]\s*\)/i);
      const classId = detailMatch?.[1]?.trim();
      const termOrdinal = detailMatch?.[2]?.trim();
      const row: VnuGradeRow = {
        termCode: currentTermCode ?? "",
        termLabel: currentTermLabel ?? "",
        courseCode: (cells[1] ?? "").trim(),
        courseName: (cells[2] ?? "").trim(),
        credits,
        point10,
        letter: cells[5]?.trim() || undefined,
        point4,
        classId: classId && /^\d+$/.test(classId) ? classId : undefined,
        termOrdinal: termOrdinal && /^\d+$/.test(termOrdinal) ? termOrdinal : undefined,
      };
      rows.push(row);
      currentTerm?.rows.push(row);
    }
  }
  const plain = stripTags(html);
  const accumulatedMatch = plain.match(/Tổng tín chỉ tích lũy:\s*([\d.]+)/i);
  const listingMatch = plain.match(/Tổng tín chỉ:\s*([\d.]+)/i);
  const cumulativeGpaMatch = plain.match(/Điểm trung bình tích lũy hệ 4:\s*([\d.]+)/i);
  return {
    rows,
    terms,
    totalCredits: listingMatch ? Number.parseFloat(listingMatch[1]) : undefined,
    totalAccumulatedCredits: accumulatedMatch ? Number.parseFloat(accumulatedMatch[1]) : undefined,
    cumulativeGpa4: cumulativeGpaMatch ? Number.parseFloat(cumulativeGpaMatch[1]) : undefined,
  };
}

// Full server-side model for ListPoint/listpoint_Brc1.asp. Grade-table parsing
// remains centralized in parseGradesHtml so own Grades and cross transcript
// cannot drift onto different row/header/footer interpretations.
export function parseTranscriptHtml(html: string): VnuTranscript {
  const grades = parseGradesHtml(html);
  return {
    header: parseTranscriptHeader(html),
    terms: grades.terms.map((term) => ({
      maHK: term.termCode,
      label: term.termLabel,
      rows: term.rows.map((row) => ({
        courseCode: row.courseCode,
        courseName: row.courseName,
        credits: row.credits,
        grade10: row.point10,
        letterGrade: row.letter,
        grade4: row.point4,
        classId: row.classId,
        termOrdinal: row.termOrdinal,
      })),
    })),
    totals: {
      totalCredits: grades.totalCredits,
      accumulatedCredits: grades.totalAccumulatedCredits,
      gpa4: grades.cumulativeGpa4,
    },
    notice: parsePortalNotice(html),
  };
}

// StdInfo/TabStdStudy.asp, Section 2 "Thông tin học tập" — per-term conduct
// score + term/cumulative GPA. Other sections (rewards, discipline,
// scholarships, science awards, overseas travel) render only an empty
// "add new" template row for most students and are intentionally not parsed.
export function parseStudyProgressHtml(html: string): VnuTermProgressRow[] {
  const rows: VnuTermProgressRow[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = trRe.exec(html))) {
    const cells = tdCells(match[1]);
    if (cells.length < 5) continue;
    const termCodeMatch = cells[1]?.match(/MÃ\s*(\d+)/i);
    if (!termCodeMatch) continue;
    const conduct = Number.parseFloat(cells[2] ?? "");
    const termGpa = Number.parseFloat(cells[3] ?? "");
    const cumulativeGpa = Number.parseFloat(cells[4] ?? "");
    rows.push({
      termCode: termCodeMatch[1],
      termLabel: (cells[1] ?? "").trim(),
      conductScore: Number.isFinite(conduct) ? conduct : undefined,
      termGpa: Number.isFinite(termGpa) ? termGpa : undefined,
      cumulativeGpa: Number.isFinite(cumulativeGpa) ? cumulativeGpa : undefined,
    });
  }
  return rows;
}

// StdExamination.asp?selViewType=StdExam — the vTermID dropdown, used to
// resolve a requested termCode (from the grades page's "MÃ HỌC KỲ" scheme)
// to this page's separate internal vTermID scheme.
export function parseExamTermOptions(html: string): VnuExamTermOption[] {
  const block = selectBlock(html, "selTermID");
  if (!block) return [];
  return [...block.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/gi)].map((m) => ({
    value: attrOf(`<option ${m[1]}>`, "value") ?? "",
    label: decodeEntities(m[2]),
    selected: /selected/i.test(m[1]),
  }));
}

// StdExamination.asp?selViewType=StdExam&vTermID=... data rows.
export function parseExamsHtml(html: string): VnuExamRow[] {
  const rows: VnuExamRow[] = [];
  const trRe = /<tr\b[^>]*id="\d+"[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = trRe.exec(html))) {
    const cells = tdCells(match[1]);
    if (cells.length < 8) continue;
    const examCode = collapseVnuCourseCodeDisplay(cells[1] ?? "");
    const codeMatch = parseExamCompositeCode(examCode);
    const sessionMatch = cells[4]?.match(/(\d+)\(([\d:]+)\)/);
    rows.push({
      termCode: codeMatch?.termCode,
      courseCode: codeMatch?.courseCode ?? examCode,
      classNo: codeMatch?.classNo,
      courseName: (cells[2] ?? "").trim(),
      examDate: (cells[3] ?? "").trim(),
      session: sessionMatch ? Number.parseInt(sessionMatch[1], 10) : undefined,
      hour: sessionMatch?.[2],
      method: cells[5]?.trim() || undefined,
      room: cells[6]?.trim() || undefined,
      seatNumber: cells[7]?.trim() || undefined,
    });
  }
  return rows;
}

type VnuExamCompositeCode = { termCode: string; courseCode: string; classNo?: string };

function parseExamCompositeCode(raw: string): VnuExamCompositeCode | undefined {
  const match = VNU_EXAM_COMPOSITE_RE.exec(raw);
  if (!match) return undefined;

  const [, termCode, courseCode, classNo] = match;
  return { termCode, courseCode, classNo };
}

function parseCatalogCode(raw: string): { termCode?: string; courseCode: string; classNo?: string } {
  const strict = parseExamCompositeCode(raw);
  if (strict) {
    return strict;
  }
  // Fallback for shapes that don't fit the common pattern: still split off a
  // recognizable "NNN-" term prefix if present, and never throw on an odd row.
  const loose = raw.match(/^(\d{3})-(.+)$/);
  if (loose) {
    const [, termCode, rest] = loose;
    return { termCode, courseCode: rest.trim() };
  }
  return { courseCode: raw };
}

// StdExamination.asp?selViewType=StdExam&vTermID=... data rows, read for the
// class-code -> internal-id resolver. Parsed separately from parseExamsHtml
// because this also reads the row's hidden hidCrdID input — the portal's
// internal 6-digit class id, not surfaced by any other page — though it
// captures the same descriptive columns (session/hour/method/room/seat) so a
// class resolved by internal id carries the same display detail as the
// forward exam-schedule view. A row is only treated as real data when
// hidCrdID is present, which naturally skips header rows and renders an
// empty/invalid vTermID (or a term with no exam entries at all) as an empty
// list rather than a parse error.
export function parseExamCatalogHtml(html: string): VnuExamCatalogRow[] {
  const rows: VnuExamCatalogRow[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = trRe.exec(html))) {
    const rowHtml = match[1];
    const classId = inputValue(rowHtml, "hidCrdID");
    if (!classId) continue;
    const cells = tdCells(rowHtml);
    if (cells.length < 8) continue;
    const { termCode, courseCode, classNo } = parseCatalogCode((cells[1] ?? "").trim());
    if (!courseCode) continue;
    const sessionMatch = cells[4]?.match(/(\d+)\(([\d:]+)\)/);
    rows.push({
      classId,
      termCode,
      courseCode,
      classNo,
      courseName: (cells[2] ?? "").trim(),
      examDate: (cells[3] ?? "").trim(),
      session: sessionMatch ? Number.parseInt(sessionMatch[1], 10) : undefined,
      hour: sessionMatch?.[2],
      method: cells[5]?.trim() || undefined,
      room: cells[6]?.trim() || undefined,
      seatNumber: cells[7]?.trim() || undefined,
    });
  }
  return rows;
}

// SiteManager/Syllabus/default.asp — paginated syllabus/curriculum PDF
// listing. Only parses the current page; pagination (nPage/pStart) is not
// followed since the adapter has no use case requiring the full 9-page list.
export function parseSyllabusHtml(html: string): VnuSyllabusRow[] {
  const rows: VnuSyllabusRow[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = trRe.exec(html))) {
    const cellsHtml = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cellsHtml.length < 7) continue;
    const codeText = stripTags(cellsHtml[1] ?? "");
    if (!VNU_COURSE_CODE_RE.test(codeText)) continue;
    const nameText = stripTags(cellsHtml[2] ?? "");
    const creditsText = stripTags(cellsHtml[3] ?? "");
    const fileHrefMatch = (cellsHtml[4] ?? "").match(/href="([^"]+\.pdf)"/i);
    const sizeText = stripTags(cellsHtml[6] ?? "");
    const dateText = cellsHtml[7] ? stripTags(cellsHtml[7]) : undefined;
    const credits = Number.parseFloat(creditsText);
    rows.push({
      courseCode: codeText.trim(),
      courseName: nameText.trim(),
      credits: Number.isFinite(credits) ? credits : undefined,
      fileUrl: fileHrefMatch ? new URL(fileHrefMatch[1], "https://daotao.vnu.edu.vn/SiteManager/Syllabus/").toString() : undefined,
      fileSize: sizeText || undefined,
      uploadedAt: dateText || undefined,
    });
  }
  return rows;
}

// ListPoint/detailPoint.asp?id=...&val=...&StdID=...&Term=... — per-component
// grade breakdown popup (live-verified shape, see har-notes.md). Rows carry
// STT | Bản chất kỳ thi | TS | Lần thi | Điểm | Ghi chú. The trailing
// "Tổng điểm" row is parsed into displayTotalEcho — it merely echoes the
// request's val= param back (verified live) and is never a computed total.
export function parsePointDetailHtml(html: string): VnuPointDetail {
  const plain = stripTags(html);
  const headerMatch = plain.match(/Điểm chi tiết môn học.*?Mã học kỳ\s*[0-9A-Za-z]+/i);
  const termCodeMatch = plain.match(/Mã học kỳ\s*([0-9A-Za-z]+)/i);
  const components: VnuPointDetailComponent[] = [];
  let displayTotalEcho: string | undefined;
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = trRe.exec(html))) {
    const cells = tdCells(match[1]);
    if (!cells.length) continue;
    const joined = cells.join(" ");
    if (/Tổng điểm/i.test(joined)) {
      displayTotalEcho = joined.match(/Tổng điểm\s*[:\-]?\s*([\d.,]+)/i)?.[1]?.trim() || undefined;
      continue;
    }
    // Header rows render their column titles as text ("STT", ...), so a
    // numeric first cell is what distinguishes a real component row.
    if (cells.length < 5 || !/^\d+$/.test(cells[0] ?? "")) continue;
    const weight = Number.parseFloat(cells[2] ?? "");
    const attempt = Number.parseFloat(cells[3] ?? "");
    const score = Number.parseFloat(cells[4] ?? "");
    components.push({
      index: Number.parseInt(cells[0] ?? "0", 10),
      nature: (cells[1] ?? "").trim(),
      weight: Number.isFinite(weight) ? weight : undefined,
      attempt: Number.isFinite(attempt) ? attempt : undefined,
      score: Number.isFinite(score) ? score : undefined,
      notes: cells[5]?.trim() || undefined,
    });
  }
  return { headerLabel: headerMatch?.[0], termCode: termCodeMatch?.[1], components, displayTotalEcho };
}

// ListPoint/listpoint_Brc1.asp?selStd=... page header — the requested
// student's identity line, rendered for whatever selStd is passed (the ONLY
// live-verified student-role StdID -> identity oracle, see har-notes.md). The
// verbatim header shape is three adjacent cells:
//   Sinh viên: {name}  |  Mã số: {8-digit code}  |  Lớp quản lý: {class}
// Fail-closed: an invalid/unknown StdID renders no header, so an absent
// "Mã số:" label yields an empty result and callers must surface a not-found
// state — never a made-up code.
export function parseTranscriptHeader(html: string): VnuTranscriptHeader {
  const plain = stripTags(html);
  const codeMatch = plain.match(/Mã\s+số\s*:\s*(\d{8})/i);
  if (!codeMatch) return {};
  // The name sits between the two neighboring labels in the same header row.
  const nameMatch = plain.match(/Sinh\s+viên\s*:\s*(.+?)(?=\s+Mã\s+số\s*:)/i);
  // The class code is a single whitespace-free token (e.g. "QH-20XX-I/CQ-I-XXX0").
  const classMatch = plain.match(/Lớp\s+quản\s+lý\s*:\s*(\S+)/i);
  return {
    studentCode: codeMatch[1],
    studentName: nameMatch?.[1]?.trim() || undefined,
    className: classMatch?.[1]?.trim() || undefined,
  };
}

// Best-effort extraction of a human-readable portal notice (validation/error
// message). Classic ASP pages surface these as alert() scripts, red <font>
// text, or inline Vietnamese "không ..." phrases rather than an HTTP error —
// e.g. StdExamination.asp renders one when the requested StdID doesn't exist.
// Returns undefined when no notice is found; callers fall back to their own
// empty state in that case rather than inventing a message.
export function parsePortalNotice(html: string): string | undefined {
  const alertMatch = html.match(/alert\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (alertMatch?.[1]?.trim()) return decodeEntities(alertMatch[1]);
  const fontRe = /<font\b([^>]*)>([\s\S]*?)<\/font>/gi;
  let fontMatch: RegExpExecArray | null;
  while ((fontMatch = fontRe.exec(html))) {
    if (!/color\s*=\s*"?#?(?:red|ff0000|c00000)/i.test(fontMatch[1] ?? "")) continue;
    const text = stripTags(fontMatch[2] ?? "");
    if (text) return text;
  }
  const plain = stripTags(html);
  const phraseMatch = plain.match(/không\s+(?:tìm\s+thấy|tồn\s+tại)[^.]{0,120}/i);
  return phraseMatch?.[0].trim() || undefined;
}

function isHtmlWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
}

function startsWithAsciiCaseInsensitive(text: string, token: string, index: number): boolean {
  for (let offset = 0; offset < token.length; offset += 1) {
    if (text[index + offset]?.toLowerCase() !== token[offset]) return false;
  }
  return true;
}

function isScriptOpeningAt(html: string, index: number): boolean {
  if (!startsWithAsciiCaseInsensitive(html, "<script", index)) return false;
  const boundary = html[index + "<script".length];
  return boundary === undefined || boundary === ">" || boundary === "/" || isHtmlWhitespace(boundary);
}

function scriptClosingTagEndAt(html: string, index: number): number | undefined {
  if (!startsWithAsciiCaseInsensitive(html, "</script", index)) return undefined;

  let cursor = index + "</script".length;
  while (isHtmlWhitespace(html[cursor])) cursor += 1;
  return html[cursor] === ">" ? cursor + 1 : undefined;
}

function hasCompleteLoginForm(html: string): boolean {
  type LoginFormCandidate = { hasLoginId: boolean; hasPassword: boolean };

  let candidate: LoginFormCandidate | undefined;
  let formDepth = 0;
  let formRegionTainted = false;
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart === -1) return false;

    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      if (commentEnd === -1) return false;
      cursor = commentEnd + 3;
      continue;
    }

    if (isScriptOpeningAt(html, tagStart)) {
      const openingTagEnd = html.indexOf(">", tagStart + 7);
      if (openingTagEnd === -1) return false;

      cursor = openingTagEnd + 1;
      while (cursor < html.length) {
        const closingTagEnd = scriptClosingTagEndAt(html, cursor);
        if (closingTagEnd !== undefined) {
          cursor = closingTagEnd;
          break;
        }
        cursor += 1;
      }
      if (cursor >= html.length) return false;
      continue;
    }

    const tagEnd = html.indexOf(">", tagStart + 1);
    if (tagEnd === -1) return false;
    const tag = html.slice(tagStart, tagEnd + 1);
    cursor = tagEnd + 1;

    if (/^<form\b/i.test(tag)) {
      formDepth += 1;
      if (formDepth > 1) {
        formRegionTainted = true;
        candidate = undefined;
        continue;
      }
      candidate = attrOf(tag, "action")?.toLowerCase() === DAOTAO_LOGIN_PATH
        ? { hasLoginId: false, hasPassword: false }
        : undefined;
      continue;
    }

    if (/^<\/form\s*>$/i.test(tag)) {
      if (formDepth === 0) continue;
      formDepth -= 1;
      if (formDepth > 0) continue;
      if (!formRegionTainted && candidate?.hasLoginId && candidate.hasPassword) return true;
      candidate = undefined;
      formRegionTainted = false;
      continue;
    }

    if (formDepth !== 1 || formRegionTainted || !candidate || !/^<input\b/i.test(tag)) continue;
    const inputName = attrOf(tag, "name")?.toLowerCase();
    if (inputName === "txtloginid") candidate.hasLoginId = true;
    if (inputName === "txtpassword") candidate.hasPassword = true;
  }

  return false;
}

function isTrustedLoginUrl(finalUrl: string): boolean {
  try {
    const url = new URL(finalUrl);
    return url.origin === DAOTAO_ORIGIN && url.pathname.toLowerCase() === DAOTAO_LOGIN_PATH;
  } catch {
    return false;
  }
}

function hasStandaloneSessionEndedNotice(html: string): boolean {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  if (!bodyMatch) return false;

  const body = bodyMatch[1];
  if ((body.match(/<table\b/gi) ?? []).length !== 1) return false;
  if ((body.match(/<tr\b/gi) ?? []).length !== 1) return false;
  if ((body.match(/<td\b/gi) ?? []).length !== 1) return false;
  if (/<(?:form|input|select|textarea|button)\b/i.test(body)) return false;
  if (!/^\s*<table\b[^>]*>\s*<tr\b[^>]*>\s*<td\b[^>]*>[\s\S]*<\/td\s*>\s*<\/tr\s*>\s*<\/table\s*>\s*$/i.test(body)) return false;

  return stripTags(body) === DAOTAO_SESSION_ENDED_SENTENCE;
}

export function isDaotaoSessionExpired(finalUrl: string, html: string): boolean {
  if (isTrustedLoginUrl(finalUrl)) return true;
  if (hasCompleteLoginForm(html)) return true;
  return hasStandaloneSessionEndedNotice(html);
}
