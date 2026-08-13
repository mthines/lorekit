// Pure UTC hour/day bucket reducer — the local-store counterpart to
// `lorekit_memory_activity` (supabase/migrations/00051_memory_activity.sql).
// Buckets LIVE memories created within a half-open `[since, until)` window,
// grouped by (bucket, scope) — the same shape `GET /memories/activity`
// returns, so the dashboard's contribution heatmap and stat-card sparkbars
// render identically over a local store.
//
// `date_trunc(bucket, created_at)` in the SQL anchors each bucket at the
// START of the UTC hour/day; this reimplementation anchors the same way via
// `Date.UTC`, so a client re-tallying these cells gets the same numbers a
// hosted account would.
//
// Zero-dependency: no imports.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const DEFAULT_WINDOW_DAYS = 200;

/** The UTC start of the hour/day containing `iso`, as an ISO string. */
function bucketStart(iso, bucket) {
  const d = new Date(iso);
  if (bucket === 'hour') {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())).toISOString();
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * `GET /memories/activity` over an in-memory row array.
 *
 * `rows` are `MemoryEntry`-shaped (must carry `created_at`, `archived_at`,
 * `expires_at`, `scope`). Only LIVE rows count (not archived, not expired) —
 * mirroring the SQL's `m.archived_at is null and (m.expires_at is null or
 * m.expires_at > now())`. `bucket` is `'hour' | 'day'` (default `'day'`);
 * `since`/`until` default to a 200-day trailing window ending now, matching
 * the edge handler's `DEFAULT_WINDOW_DAYS` — an unbounded aggregate has no
 * caller today.
 *
 * Returns `{ bucket, since, until, buckets: [{ bucket, scope, count }] }`,
 * sparse (only buckets with activity), sorted `bucket asc, scope asc`.
 */
export function computeActivity(rows, { bucket = 'day', since, until, now = new Date().toISOString() } = {}) {
  const untilIso = until ?? now;
  const sinceIso = since ?? new Date(Date.parse(untilIso) - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();

  const counts = new Map(); // `${bucketIso}\x00${scope}` -> count

  for (const row of rows) {
    if (row.archived_at != null) continue;
    if (row.expires_at && !(row.expires_at > now)) continue;
    const created = row.created_at;
    if (!created) continue;
    if (created < sinceIso) continue;
    if (!(created < untilIso)) continue;

    const b = bucketStart(created, bucket);
    const key = `${b}\x00${row.scope}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const buckets = [];
  for (const [key, count] of counts) {
    const nul = key.indexOf('\x00');
    buckets.push({ bucket: key.slice(0, nul), scope: key.slice(nul + 1), count });
  }
  buckets.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket < b.bucket ? -1 : 1;
    return a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0;
  });

  return { bucket, since: sinceIso, until: untilIso, buckets };
}
