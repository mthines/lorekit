/**
 * Label formatting shared by the visual Insights charts.
 *
 * Day buckets are UTC days on the server (`date_trunc` on UTC), so they are
 * labelled in UTC: labelling the 00:00Z bucket in a US zone would call it the
 * previous day. Hour buckets are instants, so they are labelled in the
 * viewer's zone, where "14:00" means their afternoon.
 */

import type { BucketUnit } from '@/lib/time-range';

const dayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const hourFormats = new Map<string, Intl.DateTimeFormat>();

function hourFormat(timeZone: string): Intl.DateTimeFormat {
  let f = hourFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
    hourFormats.set(timeZone, f);
  }
  return f;
}

export function formatBucketLabel(start: string, unit: BucketUnit, timeZone: string): string {
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return start;
  return unit === 'day' ? dayFormat.format(date) : hourFormat(timeZone).format(date);
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** `840`, `1.2K`, `18K` — for tick labels and readouts where width matters. */
export function formatCompact(n: number): string {
  return n < 1000 ? String(n) : compact.format(n);
}

/** The viewer's IANA time zone, falling back to UTC where the runtime has none. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
