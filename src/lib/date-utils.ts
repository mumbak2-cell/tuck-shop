/**
 * Timezone-safe YYYY-MM-DD formatting.
 *
 * `new Date().toISOString().split("T")[0]` returns UTC, which is wrong for
 * a SAST user between midnight and 02:00 local. These helpers use the
 * browser's local timezone via Intl, which resolves correctly for any TZ.
 */

/** YYYY-MM-DD in the browser's local timezone. */
export function toLocalDateStr(d: Date): string {
  return d.toLocaleDateString("en-CA"); // en-CA yields YYYY-MM-DD
}

/** Today's date as YYYY-MM-DD in local timezone. */
export function localToday(): string {
  return toLocalDateStr(new Date());
}

/** Yesterday's date as YYYY-MM-DD in local timezone. */
export function localYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return toLocalDateStr(d);
}

/** First day of the current month as YYYY-MM-DD in local timezone. */
export function localMonthStart(): string {
  const d = new Date();
  d.setDate(1);
  return toLocalDateStr(d);
}

/** Start of the current week (Sunday) as YYYY-MM-DD in local timezone. */
export function localWeekStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return toLocalDateStr(d);
}
