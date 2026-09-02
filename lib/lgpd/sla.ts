/**
 * LGPD SLA business-day calculator.
 *
 * Rules (L-04):
 *  - SLA is expressed in Mozambican business days (dias úteis).
 *  - Skip Saturdays (getDay()===6) and Sundays (getDay()===0).
 *  - Skip Mozambican national holidays from HOLIDAYS_MZ_ISO.
 *  - If receivedAt itself is not a business day, counting starts on the
 *    next business day (edge: weekend/holiday receipt).
 */

import { HOLIDAYS_MZ_ISO } from "./holidays-mz";

const _defaultHolidays = new Set(HOLIDAYS_MZ_ISO);

/**
 * Format a Date to YYYY-MM-DD (UTC-based, suitable for set lookup when
 * dates are constructed as UTC midnight + 1-day increments).
 */
function toISODateStr(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Returns true when the given Date (treated as a UTC midnight point) is
 * a business day — not Saturday, not Sunday, not in the holidays set.
 */
function isBusinessDay(date: Date, holidays: Set<string>): boolean {
  const dow = date.getUTCDay(); // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(toISODateStr(date));
}

/**
 * Advance date by one calendar day (UTC).
 */
function addOneDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

/**
 * Compute the due date for an LGPD SLA.
 *
 * @param receivedAt   Timestamp when the request was received.
 * @param businessDays Number of business days allowed (e.g. 15 for redact).
 * @param holidays     Override holiday set; defaults to HOLIDAYS_MZ_ISO.
 * @returns            Date representing end of the Nth business day (00:00 UTC of that day).
 */
export function computeDueAt(
  receivedAt: Date,
  businessDays: number,
  holidays: Set<string> = _defaultHolidays,
): Date {
  // Normalise to UTC midnight of the received day
  let cursor = new Date(
    Date.UTC(receivedAt.getUTCFullYear(), receivedAt.getUTCMonth(), receivedAt.getUTCDate()),
  );

  // If receivedAt itself is not a business day, advance to the first business day
  if (!isBusinessDay(cursor, holidays)) {
    cursor = addOneDay(cursor);
    while (!isBusinessDay(cursor, holidays)) {
      cursor = addOneDay(cursor);
    }
  }

  // Count N business days starting from (and including) the first business day
  let remaining = businessDays;
  while (remaining > 0) {
    cursor = addOneDay(cursor);
    if (isBusinessDay(cursor, holidays)) {
      remaining--;
    }
  }

  return cursor;
}
