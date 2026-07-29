export function collapseVnuCourseCodeDisplay(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function vnuCourseCodeKey(value: string): string {
  return value.trim().replace(/\s/g, "").toUpperCase();
}
