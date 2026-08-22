import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en", { weekday: "short", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
const CURRENCY_FORMATTER = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDateTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return DATE_TIME_FORMATTER.format(date);
}

export function formatCurrency(value?: number) {
  return CURRENCY_FORMATTER.format(value ?? 0);
}
