export type ExportFormat = "json" | "csv";

export type ExportSurface =
  | "class-forward"
  | "class-reverse"
  | "student-id-to-code"
  | "student-code-to-id"
  | "grades-term"
  | "grades-page"
  | "cross-transcript"
  | "bulk-id-to-code"
  | "bulk-code-to-id"
  | "bulk-id-to-transcript";

export type ExportQuery = { mode: string; value: string };
export type ExportIdentity = { studentCode?: string; internalStudentId?: string; studentName?: string; managingClass?: string };
export type ExportReported = { cumulativeGpa4?: number; totalCredits?: number; accumulatedCredits?: number };
export type ExportCourse = { courseCode: string; courseName: string; credits?: number; point10?: number; letter?: string; point4?: number };
export type ExportDerivedTerm = {
  termCode: string;
  termLabel: string;
  estimateKind: "derived";
  listedCredits: number;
  includedCredits: number;
  termGpa4?: number;
  derivedCpa4?: number;
  courses: ExportCourse[];
};
export type ExportClassResult = { classCode: string; classNumber?: string; classId: string; courseName?: string };
export type ExportResolverResult = { resolvedStudentCode: string; resolvedInternalStudentId: string; probes: number };
export type ExportResult = {
  identity?: ExportIdentity;
  classResult?: ExportClassResult;
  resolver?: ExportResolverResult;
  reported?: ExportReported;
  derivedTerms?: ExportDerivedTerm[];
};
export type ExportBulkItem =
  | { target: string; status: "ok"; result: ExportResult }
  | { target: string; status: "error"; errorCode: string };
export type ExportRun = { status: "complete" | "partial"; mode: string; processedCount: number; totalCount: number };
export type ExportDocument = {
  schemaVersion: 1;
  surface: ExportSurface;
  universityId: string;
  query?: ExportQuery;
  run?: ExportRun;
  identity?: ExportIdentity;
  reported?: ExportReported;
  derivedTerms?: ExportDerivedTerm[];
  results?: Array<ExportResult | ExportBulkItem>;
};

type IdentityInput = ExportIdentity & Record<string, unknown>;

function copyIdentity(input: ExportIdentity | IdentityInput | undefined): ExportIdentity | undefined {
  if (!input) return undefined;
  const value = {
    studentCode: input.studentCode,
    internalStudentId: input.internalStudentId,
    studentName: input.studentName,
    managingClass: input.managingClass,
  };
  return Object.values(value).some((field) => field !== undefined) ? value : undefined;
}

function copyReported(input: ExportReported | undefined): ExportReported | undefined {
  if (!input) return undefined;
  const value = {
    cumulativeGpa4: input.cumulativeGpa4,
    totalCredits: input.totalCredits,
    accumulatedCredits: input.accumulatedCredits,
  };
  return Object.values(value).some((field) => field !== undefined) ? value : undefined;
}

function copyCourse(input: ExportCourse): ExportCourse {
  return {
    courseCode: input.courseCode,
    courseName: input.courseName,
    credits: input.credits,
    point10: input.point10,
    letter: input.letter,
    point4: input.point4,
  };
}

function copyDerivedTerm(input: ExportDerivedTerm): ExportDerivedTerm {
  return {
    termCode: input.termCode,
    termLabel: input.termLabel,
    estimateKind: "derived",
    listedCredits: input.listedCredits,
    includedCredits: input.includedCredits,
    termGpa4: input.termGpa4,
    derivedCpa4: input.derivedCpa4,
    courses: input.courses.map(copyCourse),
  };
}

function copyQuery(input: ExportQuery | undefined): ExportQuery | undefined {
  if (!input) return undefined;
  return { mode: input.mode, value: input.value };
}

function copyRun(input: ExportRun | undefined): ExportRun | undefined {
  if (!input) return undefined;
  return {
    status: input.status,
    mode: input.mode,
    processedCount: input.processedCount,
    totalCount: input.totalCount,
  };
}

function copyResult(input: ExportResult): ExportResult {
  return {
    identity: copyIdentity(input.identity),
    classResult: input.classResult ? {
      classCode: input.classResult.classCode,
      classNumber: input.classResult.classNumber,
      classId: input.classResult.classId,
      courseName: input.classResult.courseName,
    } : undefined,
    resolver: input.resolver ? {
      resolvedStudentCode: input.resolver.resolvedStudentCode,
      resolvedInternalStudentId: input.resolver.resolvedInternalStudentId,
      probes: input.resolver.probes,
    } : undefined,
    reported: copyReported(input.reported),
    derivedTerms: input.derivedTerms?.map(copyDerivedTerm),
  };
}

function copyNonBulkResult(input: ExportResult | ExportBulkItem): ExportResult {
  return copyResult({
    identity: "identity" in input ? input.identity : undefined,
    classResult: "classResult" in input ? input.classResult : undefined,
    resolver: "resolver" in input ? input.resolver : undefined,
    reported: "reported" in input ? input.reported : undefined,
    derivedTerms: "derivedTerms" in input ? input.derivedTerms : undefined,
  });
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<PropertyKey, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, property);
}

function copyBulkResult(input: unknown, index: number): ExportBulkItem {
  const invalidResult = () => new Error(`Invalid bulk export result at index ${index}`);
  if (!isRecord(input) || !hasOwn(input, "status") || !hasOwn(input, "target")) throw invalidResult();

  if (input.status === "error") {
    if (typeof input.target !== "string" || !hasOwn(input, "errorCode") || typeof input.errorCode !== "string") throw invalidResult();
    return { target: input.target, status: "error", errorCode: input.errorCode };
  }

  if (input.status === "ok") {
    if (typeof input.target !== "string" || !hasOwn(input, "result") || !isRecord(input.result)) throw invalidResult();
    return { target: input.target, status: "ok", result: copyNonBulkResult(input.result as ExportResult) };
  }

  throw invalidResult();
}

const BULK_EXPORT_SURFACES: ReadonlySet<ExportSurface> = new Set([
  "bulk-id-to-code",
  "bulk-code-to-id",
  "bulk-id-to-transcript",
]);

function copyDocumentResults(surface: ExportSurface, results: ExportDocument["results"]): ExportDocument["results"] {
  if (!results) return undefined;
  if (BULK_EXPORT_SURFACES.has(surface)) return results.map(copyBulkResult);
  return results.map(copyNonBulkResult);
}

export function sanitizeExportDocument(model: ExportDocument): ExportDocument {
  return {
    schemaVersion: 1,
    surface: model.surface,
    universityId: model.universityId,
    query: copyQuery(model.query),
    run: copyRun(model.run),
    identity: copyIdentity(model.identity),
    reported: copyReported(model.reported),
    derivedTerms: model.derivedTerms?.map(copyDerivedTerm),
    results: copyDocumentResults(model.surface, model.results),
  };
}

export function createClassLookupExport(input: {
  surface: "class-forward" | "class-reverse";
  universityId: string;
  query: ExportQuery;
  result: ExportClassResult;
}): ExportDocument {
  return {
    schemaVersion: 1,
    surface: input.surface,
    universityId: input.universityId,
    query: copyQuery(input.query),
    results: [copyResult({ classResult: input.result })],
  };
}

export function createResolverLookupExport(input: {
  surface: "student-id-to-code" | "student-code-to-id";
  universityId: string;
  query: ExportQuery;
  identity?: IdentityInput;
  resolver?: ExportResolverResult;
}): ExportDocument {
  return {
    schemaVersion: 1,
    surface: input.surface,
    universityId: input.universityId,
    query: copyQuery(input.query),
    results: [copyResult({ identity: copyIdentity(input.identity), resolver: input.resolver })],
  };
}

export function createGradesExport(input: {
  surface: "grades-term" | "grades-page";
  universityId: string;
  identity?: IdentityInput;
  reported?: ExportReported;
  derivedTerms: ExportDerivedTerm[];
}): ExportDocument {
  return {
    schemaVersion: 1,
    surface: input.surface,
    universityId: input.universityId,
    identity: copyIdentity(input.identity),
    reported: copyReported(input.reported),
    derivedTerms: input.derivedTerms.map(copyDerivedTerm),
  };
}

export function createTranscriptExport(input: {
  universityId: string;
  query: ExportQuery;
  identity?: IdentityInput;
  reported?: ExportReported;
  derivedTerms: ExportDerivedTerm[];
}): ExportDocument {
  return {
    schemaVersion: 1,
    surface: "cross-transcript",
    universityId: input.universityId,
    query: copyQuery(input.query),
    identity: copyIdentity(input.identity),
    reported: copyReported(input.reported),
    derivedTerms: input.derivedTerms.map(copyDerivedTerm),
  };
}

export function createBulkExport(input: {
  surface: "bulk-id-to-code" | "bulk-code-to-id" | "bulk-id-to-transcript";
  universityId: string;
  mode: string;
  total: number;
  items: ExportBulkItem[];
}): ExportDocument {
  const results = input.items.map((item): ExportBulkItem => item.status === "error"
    ? { target: item.target, status: "error", errorCode: item.errorCode }
    : { target: item.target, status: "ok", result: copyResult(item.result) });

  return {
    schemaVersion: 1,
    surface: input.surface,
    universityId: input.universityId,
    run: {
      status: results.length === input.total ? "complete" : "partial",
      mode: input.mode,
      processedCount: results.length,
      totalCount: input.total,
    },
    results,
  };
}

export function serializeExportJson(model: ExportDocument): string {
  return `${JSON.stringify(sanitizeExportDocument(model), null, 2)}\n`;
}

export const CSV_HEADERS = [
  "record_type", "surface", "run_status", "item_index", "status", "error_code", "query_mode", "query_value", "target", "university_id",
  "student_code", "internal_student_id", "student_name", "managing_class", "class_code", "class_number", "class_id", "resolved_student_code",
  "resolved_internal_student_id", "probes", "term_code", "term_label", "estimate_kind", "listed_credits", "included_credits", "term_gpa4",
  "derived_cpa4", "reported_cumulative_gpa4", "course_code", "course_name", "credits", "point10", "letter", "point4",
] as const;

type CsvHeader = typeof CSV_HEADERS[number];
type CsvValue = string | number | undefined;
type CsvRow = Partial<Record<CsvHeader, CsvValue>>;
type CsvContext = {
  surface: ExportSurface;
  universityId: string;
  runStatus?: "complete" | "partial";
  itemIndex?: number;
  status?: "ok" | "error";
  errorCode?: string;
  target?: string;
};

function createBaseRow(context: CsvContext, recordType: string): CsvRow {
  return {
    record_type: recordType,
    surface: context.surface,
    run_status: context.runStatus,
    item_index: context.itemIndex,
    status: context.status,
    error_code: context.errorCode,
    target: context.target,
    university_id: context.universityId,
  };
}

function createIdentityRow(context: CsvContext, value: ExportIdentity, recordType = "identity"): CsvRow {
  return {
    ...createBaseRow(context, recordType),
    student_code: value.studentCode,
    internal_student_id: value.internalStudentId,
    student_name: value.studentName,
    managing_class: value.managingClass,
  };
}

function createReportedRow(context: CsvContext, value: ExportReported): CsvRow {
  return {
    ...createBaseRow(context, "reported_summary"),
    reported_cumulative_gpa4: value.cumulativeGpa4,
  };
}

function createTermRows(context: CsvContext, terms: readonly ExportDerivedTerm[]): CsvRow[] {
  return terms.flatMap((term) => [
    {
      ...createBaseRow(context, "term_summary"),
      term_code: term.termCode,
      term_label: term.termLabel,
      estimate_kind: term.estimateKind,
      listed_credits: term.listedCredits,
      included_credits: term.includedCredits,
      term_gpa4: term.termGpa4,
      derived_cpa4: term.derivedCpa4,
    },
    ...term.courses.map((course): CsvRow => ({
      ...createBaseRow(context, "course"),
      term_code: term.termCode,
      term_label: term.termLabel,
      course_code: course.courseCode,
      course_name: course.courseName,
      credits: course.credits,
      point10: course.point10,
      letter: course.letter,
      point4: course.point4,
    })),
  ]);
}

function createResultRows(context: CsvContext, value: ExportResult): CsvRow[] {
  const rows: CsvRow[] = [];
  if (value.identity) rows.push(createIdentityRow(context, value.identity, value.derivedTerms !== undefined || value.reported !== undefined ? "identity" : "result"));
  if (value.classResult) rows.push({
    ...createBaseRow(context, "result"),
    class_code: value.classResult.classCode,
    class_number: value.classResult.classNumber,
    class_id: value.classResult.classId,
    course_name: value.classResult.courseName,
  });
  if (value.resolver) rows.push({
    ...createBaseRow(context, "result"),
    resolved_student_code: value.resolver.resolvedStudentCode,
    resolved_internal_student_id: value.resolver.resolvedInternalStudentId,
    probes: value.resolver.probes,
  });
  if (value.reported) rows.push(createReportedRow(context, value.reported));
  if (value.derivedTerms) rows.push(...createTermRows(context, value.derivedTerms));
  return rows;
}

function createCsvRows(model: ExportDocument): CsvRow[] {
  const context: CsvContext = { surface: model.surface, universityId: model.universityId, runStatus: model.run?.status };
  const rows: CsvRow[] = [];
  if (model.query) rows.push({ ...createBaseRow(context, "query"), query_mode: model.query.mode, query_value: model.query.value });
  if (model.identity) rows.push(createIdentityRow(context, model.identity));
  if (model.reported) rows.push(createReportedRow(context, model.reported));
  if (model.derivedTerms) rows.push(...createTermRows(context, model.derivedTerms));
  model.results?.forEach((item, index) => {
    if ("status" in item) {
      const itemContext: CsvContext = {
        ...context,
        itemIndex: index + 1,
        status: item.status,
        target: item.target,
        errorCode: item.status === "error" ? item.errorCode : undefined,
      };
      if (item.status === "error") rows.push(createBaseRow(itemContext, "item"));
      else rows.push(...createResultRows(itemContext, item.result));
      return;
    }
    rows.push(...createResultRows(context, item));
  });
  return rows;
}

const IDENTIFIER_CSV_HEADERS: ReadonlySet<CsvHeader> = new Set([
  "query_value",
  "target",
  "university_id",
  "student_code",
  "internal_student_id",
  "managing_class",
  "class_code",
  "class_number",
  "class_id",
  "resolved_student_code",
  "resolved_internal_student_id",
  "term_code",
  "course_code",
]);
const FORMULA_LIKE_TEXT = /^[\t\r\n ]*[=+\-@]/;

function encodeCsvField(header: CsvHeader, value: CsvValue): string {
  if (value === undefined) return "";
  const text = typeof value === "number"
    ? String(value)
    : (IDENTIFIER_CSV_HEADERS.has(header) || FORMULA_LIKE_TEXT.test(value) ? `'${value}` : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeExportCsv(model: ExportDocument): string {
  const sanitizedModel = sanitizeExportDocument(model);
  const rows = createCsvRows(sanitizedModel).map((row) => CSV_HEADERS.map((header) => encodeCsvField(header, row[header])).join(","));
  return `\ufeff${[CSV_HEADERS.join(","), ...rows].join("\r\n")}\r\n`;
}

const RESERVED_COMPONENTS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function sanitizeAsciiFilenameComponent(value: string): string {
  const ascii = value.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  if (RESERVED_COMPONENTS.test(ascii.trim())) return "export";
  const cleaned = ascii
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "-")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return !cleaned || RESERVED_COMPONENTS.test(cleaned) ? "export" : cleaned.toLowerCase();
}

export function buildExportFilename(surface: ExportSurface, date: Date, format: ExportFormat): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  const day = `${year}-${month}-${dayOfMonth}`;
  return `hyeboard-${sanitizeAsciiFilenameComponent(surface)}-${day}.${format}`;
}

export type DownloadAnchor = { href: string; download: string; click(): void; remove(): void };
export type DownloadEnvironment = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  createAnchor(): DownloadAnchor;
  appendAnchor(anchor: DownloadAnchor): void;
};

function createBrowserDownloadEnvironment(): DownloadEnvironment {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement("a"),
    appendAnchor: (anchor) => document.body.append(anchor as HTMLAnchorElement),
  };
}

export function downloadExport(
  model: ExportDocument,
  format: ExportFormat,
  date = new Date(),
  environment = createBrowserDownloadEnvironment(),
): void {
  const content = format === "json" ? serializeExportJson(model) : serializeExportCsv(model);
  const mime = format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8";
  const blob = new Blob([content], { type: mime });
  let url: string | undefined;
  let anchor: DownloadAnchor | undefined;
  try {
    url = environment.createObjectURL(blob);
    anchor = environment.createAnchor();
    anchor.href = url;
    anchor.download = buildExportFilename(model.surface, date, format);
    environment.appendAnchor(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    if (url) environment.revokeObjectURL(url);
  }
}
