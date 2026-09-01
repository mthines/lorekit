/**
 * Per-memory read counters (`memories.read_count` / `.last_read_at`) and the
 * daily rollup (`memory_read_daily`) — migration 00077.
 *
 * `usage_events` records HOW MANY records a call touched, never WHICH. There
 * is no `memory_id` on the read ledger, so "is this lesson earning its place"
 * was absent from the data, not merely unsurfaced. This closes it with the
 * cheap shape: counters + a daily rollup, not a per-read event table — at the
 * observed ~495K records/month for a single account, an event table would be
 * the highest-volume table in the schema by an order of magnitude on day one.
 *
 * Same non-throwing contract as `recordUsageEvent` in this same directory: a
 * counter write must never fail, slow down, or otherwise affect the read it is
 * measuring. Fire-and-forget via `EdgeRuntime.waitUntil` so the increment lands
 * before the isolate dies without the caller awaiting it.
 */

import { background } from '../runtime/background.ts';
import type { DbClient } from '../db/db-client.ts';
import type { UsageClient } from './usage-stats.ts';

/**
 * `targeted` = `memory.read` (one exact scope+key). `bulk` = `memory.list` /
 * `memory.search` / `memory.list_archived` (every row a listing call
 * returned). The SAME narrow 4-tool split `lorekit_read_activity` uses for its
 * own "read" definition — not the broader `READ_TOOL_NAMES` in
 * `usage-stats.ts`, which also covers `memory.scopes` / `memory.usage` /
 * `org.list`. Those aggregate tools touch no single memory row, so they never
 * call this at all.
 */
export type MemoryReadKind = 'targeted' | 'bulk';

/**
 * Increment `read_count`/`last_read_at` and the day's `memory_read_daily` row
 * for every memory id a call actually returned — in ONE round trip regardless
 * of how many ids there are, because a bulk `list` returning 31 rows must not
 * turn into 31 statements on a hot path. No-ops (never queries) on an empty
 * array, since a call that matched nothing touched no memory.
 *
 * `client` (migration 00097) additionally bumps `memories.last_opened_at`
 * when `readKind === 'targeted'` and `client` is `'mcp'` or `'cli'` — an agent
 * deliberately reaching for this one lesson, as opposed to a bulk list/search
 * appearance or a human viewing the web dashboard. Optional and defaulted to
 * `null` (no attribution, `last_opened_at` untouched) so a caller that cannot
 * name its surface degrades gracefully rather than being required to guess.
 *
 * Never throws. A failing counter update must not fail the read it is
 * measuring — same posture as `recordUsageEvent`.
 */
export function recordMemoryReads(
  db: DbClient,
  memoryIds: readonly string[],
  readKind: MemoryReadKind,
  client: UsageClient | null = null,
): void {
  if (memoryIds.length === 0) return;

  const p = Promise.resolve(
    db.rpc('lorekit_record_memory_reads', {
      p_memory_ids: memoryIds as string[],
      p_read_kind: readKind,
      p_client: client,
    }),
  ).then(() => { /* fire-and-forget */ }, () => { /* swallow */ });

  const host = background();
  if (host) host.waitUntil(p);
  else void p;
}
