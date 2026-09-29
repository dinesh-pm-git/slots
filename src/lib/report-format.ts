import { SCHEDULE_LOCALE, fromDateKey } from "@/lib/time";

/**
 * Formatting shared by the Reports page and its download, so a number reads
 * the same on screen as in the spreadsheet. Kept apart from lib/reports.ts,
 * which talks to the database and must not end up in the browser bundle.
 */

/** Whole-number percentage, or null when there is nothing to divide by. */
export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** "23 Sep – 30 Sep 2026", "30 Sep 2026", or "28 Dec 2025 – 3 Jan 2026". */
export function rangeLabel(from: string, to: string): string {
  const day = (key: string, withYear: boolean) =>
    fromDateKey(key).toLocaleDateString(SCHEDULE_LOCALE, {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
    });
  if (from === to) return day(to, true);
  return `${day(from, from.slice(0, 4) !== to.slice(0, 4))} – ${day(to, true)}`;
}

/** 12.5 -> "12.5", 12 -> "12": hours are whole or half. */
export function hoursLabel(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}
