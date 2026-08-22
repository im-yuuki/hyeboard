const INVALIDATABLE_QUERY_NAMES = new Set([
  "dashboard",
  "timetable",
  "courses",
  "assignments",
  "grades",
  "exams",
  "tuition",
  "documents",
  "training-points",
  "requests",
  "news",
  "vnu-point-detail",
  "vnu-lookup-catalog",
  "vnu-lookup-profile",
]);

type AccountQueryCandidate = {
  queryKey: readonly unknown[];
  isActive(): boolean;
};

export function shouldInvalidateAccountQuery(
  query: AccountQueryCandidate,
): boolean {
  return (
    query.isActive() &&
    typeof query.queryKey[0] === "string" &&
    INVALIDATABLE_QUERY_NAMES.has(query.queryKey[0])
  );
}
