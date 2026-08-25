/**
 * "Who is reading" (by `client`) and "reads by agent family" (by `kind` ×
 * `host`) — both dimensions `GET /memories/usage`'s `by_tool` rows have
 * carried since migrations 00054/00056, both unaskable until migration 00076
 * widened `lorekit_usage_stats`' group-by to include them.
 *
 * Meaningful only for traffic recorded AFTER the per-transport `client`
 * default shipped (`default-usage-client-per-transport`) — a null client
 * bucket includes every request made before that default existed, not just
 * genuinely unattributed ones, and callers should say so.
 *
 * Pure and dependency-free, so it is unit-testable without a network call.
 */

import type { UsageStatRow } from '@lorekit/schemas/usage';

export interface ClientAttributionRow {
  client: string | null;
  event_count: number;
}

/** Sum event_count by client, ranked descending. `null` is its own row — kept, never dropped. */
export function attributionByClient(rows: readonly UsageStatRow[]): ClientAttributionRow[] {
  const totals = new Map<string | null, number>();
  for (const row of rows) {
    totals.set(row.client, (totals.get(row.client) ?? 0) + row.event_count);
  }
  return [...totals.entries()]
    .map(([client, event_count]) => ({ client, event_count }))
    .sort((a, b) => b.event_count - a.event_count);
}

export interface AgentFamilyRow {
  kind: string | null;
  host: string | null;
  event_count: number;
}

/**
 * Sum event_count by (kind, host), ranked descending. Rows with neither kind
 * nor host (org tools, member tools, or a memory tool with no explicit or
 * inferred taxonomy) collapse into one `{kind: null, host: null}` row rather
 * than being silently dropped or fragmenting by every other null-carrying
 * column.
 */
export function attributionByAgentFamily(rows: readonly UsageStatRow[]): AgentFamilyRow[] {
  const totals = new Map<string, AgentFamilyRow>();
  for (const row of rows) {
    const key = `${row.kind ?? ''}\u0000${row.host ?? ''}`;
    const existing = totals.get(key);
    if (existing) existing.event_count += row.event_count;
    else totals.set(key, { kind: row.kind, host: row.host, event_count: row.event_count });
  }
  return [...totals.values()].sort((a, b) => b.event_count - a.event_count);
}
