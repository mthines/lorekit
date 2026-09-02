/**
 * Operational health diagnostics derived from `GET /memories/usage`'s
 * `by_tool` rows — friction (failures), latency (mean duration per tool), and
 * coverage gaps (calls vs the records they actually found). None of this needs
 * a new endpoint: `by_tool` already carries `(tool_name, outcome, scope_type,
 * event_count, record_count, total_duration_ms)` per migration 00044.
 *
 * `usage_events.scope_type` carries LEGACY free-text values (`dash0`,
 * `daily-report`, `bogusprefix`, …) written before `scopeTypeAttribute` was
 * hardened — present in a wide window, absent in a narrow one. Every grouping
 * here buckets anything outside the closed vocabulary (and `null`, which is
 * not a scope-bearing call at all — `org.*`/`member.*` tools) into `'other'`
 * rather than assuming the six-value enum is exhaustive.
 *
 * These are diagnostics, not additive stat cards — nothing here needs to sum
 * to a headline the way the dashboard's stat row does.
 *
 * Pure and dependency-free, so it is unit-testable without a network call.
 */

import type { UsageStatRow } from '@lorekit/schemas/usage';

/** The closed `scope_type` vocabulary a row's value may legitimately carry. */
const KNOWN_SCOPE_TYPES = new Set(['global', 'project', 'repo', 'branch', 'mixed', 'invalid']);

/** Bucket a raw `scope_type` into the closed vocabulary, or `'other'`. */
export function bucketScopeType(scopeType: string | null): string {
  if (scopeType !== null && KNOWN_SCOPE_TYPES.has(scopeType)) return scopeType;
  return 'other';
}

// ── Friction ─────────────────────────────────────────────────────────────────

/** The (client, scope_type) pairing responsible for some share of a failure's events. */
export interface FailureContext {
  /** `null` means genuinely unattributed, same convention as `readsByClient`. */
  client: string | null;
  scope_type: string;
  event_count: number;
}

export interface FailureRow {
  tool_name: string;
  outcome: string;
  event_count: number;
  /**
   * The single (client, scope_type) pairing contributing the most events to
   * this failure — turns "187 memory.read errors" into "mostly cli, branch",
   * a concrete place to go look (that surface's logs, that scope's hook
   * config), without a second query. Ties break toward whichever context was
   * encountered first in `rows` — the underlying data has no meaningful
   * tiebreaker of its own.
   */
  topContext: FailureContext;
}

/**
 * Non-`ok` calls grouped by `(tool_name, outcome)`, ranked by how many times
 * each combination fired. A large `event_count` on one row IS "the same
 * failure repeated" — 155 identical `org.create` failures is one row with
 * `event_count: 155`, not 155 separate entries — which is what makes a
 * repeated failure legible as a broken integration rather than a stat.
 */
export function failuresByToolOutcome(rows: readonly UsageStatRow[]): FailureRow[] {
  const totals = new Map<
    string,
    { tool_name: string; outcome: string; event_count: number; contexts: Map<string, FailureContext> }
  >();
  for (const row of rows) {
    if (row.outcome === 'ok') continue;
    const key = `${row.tool_name}\u0000${row.outcome}`;
    let existing = totals.get(key);
    if (!existing) {
      existing = { tool_name: row.tool_name, outcome: row.outcome, event_count: 0, contexts: new Map() };
      totals.set(key, existing);
    }
    existing.event_count += row.event_count;

    const contextScopeType = bucketScopeType(row.scope_type);
    const contextKey = `${row.client ?? '\u0000'}\u0001${contextScopeType}`;
    const context = existing.contexts.get(contextKey);
    if (context) context.event_count += row.event_count;
    else existing.contexts.set(contextKey, { client: row.client ?? null, scope_type: contextScopeType, event_count: row.event_count });
  }
  return [...totals.values()]
    .map(({ contexts, ...rest }) => ({
      ...rest,
      topContext: [...contexts.values()].sort((a, b) => b.event_count - a.event_count)[0],
    }))
    .sort((a, b) => b.event_count - a.event_count);
}

// ── Latency ──────────────────────────────────────────────────────────────────

export interface LatencyRow {
  tool_name: string;
  /** `null` (bucketed to `'other'` for scope-bearing tools) means "no scope named" — an unscoped call. */
  scope_type: string;
  meanMs: number;
  event_count: number;
}

/**
 * Mean duration (`total_duration_ms / event_count`) per `(tool_name,
 * scope_type)` — a MEAN, not a percentile; `usage_events` carries no
 * histogram, so callers must label it as such rather than implying a p50/p95.
 *
 * Rows with a null `total_duration_ms` (an outcome that never reached timing,
 * e.g. a denied call) are excluded rather than treated as zero, which would
 * silently pull the mean toward instant.
 */
export function meanLatencyByToolScope(rows: readonly UsageStatRow[]): LatencyRow[] {
  const totals = new Map<string, { tool_name: string; scope_type: string; durationMs: number; event_count: number }>();
  for (const row of rows) {
    if (row.total_duration_ms == null) continue;
    const scopeType = bucketScopeType(row.scope_type);
    const key = `${row.tool_name}\u0000${scopeType}`;
    const existing = totals.get(key);
    if (existing) {
      existing.durationMs += row.total_duration_ms;
      existing.event_count += row.event_count;
    } else {
      totals.set(key, { tool_name: row.tool_name, scope_type: scopeType, durationMs: row.total_duration_ms, event_count: row.event_count });
    }
  }
  return [...totals.values()]
    .map((t) => ({
      tool_name: t.tool_name,
      scope_type: t.scope_type,
      event_count: t.event_count,
      meanMs: t.event_count > 0 ? t.durationMs / t.event_count : 0,
    }))
    .sort((a, b) => b.meanMs - a.meanMs);
}

// ── Coverage gaps ────────────────────────────────────────────────────────────

export interface CoverageGapRow {
  scope_type: string;
  event_count: number;
  record_count: number;
  /** `record_count / event_count`, `0` when there were no calls (never NaN). */
  recordsPerCall: number;
}

/**
 * Calls vs the records they actually found, per `scope_type`. `by_scope_type`
 * (the pre-rolled response field) carries only `event_count` — the
 * `record_count` side has to be summed from `by_tool` here, which is why this
 * reads `rows` (the raw grouped rows) rather than the rolled-up summary.
 */
export function coverageGapsByScopeType(rows: readonly UsageStatRow[]): CoverageGapRow[] {
  const totals = new Map<string, { event_count: number; record_count: number }>();
  for (const row of rows) {
    const scopeType = bucketScopeType(row.scope_type);
    const existing = totals.get(scopeType);
    if (existing) {
      existing.event_count += row.event_count;
      existing.record_count += row.record_count;
    } else {
      totals.set(scopeType, { event_count: row.event_count, record_count: row.record_count });
    }
  }
  return [...totals.entries()]
    .map(([scope_type, t]) => ({
      scope_type,
      event_count: t.event_count,
      record_count: t.record_count,
      recordsPerCall: t.event_count > 0 ? t.record_count / t.event_count : 0,
    }))
    .sort((a, b) => a.recordsPerCall - b.recordsPerCall);
}

// ── Who is reading (client) ─────────────────────────────────────────────────

export interface ClientBreakdownRow {
  /** `null` is genuinely unattributed — a call predating the per-transport default (see PR B1). */
  client: string | null;
  event_count: number;
  record_count: number;
}

/**
 * Calls and records grouped by `client` (`dashboard`/`cli`/`mcp`/`api`,
 * migration 00079's new dimension on `by_tool`). Answers "who is reading" now
 * that both transports default an unattributed call to their own name (PR
 * B1) instead of leaving the dominant agent read path silently NULL.
 */
export function readsByClient(rows: readonly UsageStatRow[]): ClientBreakdownRow[] {
  const totals = new Map<string | null, { event_count: number; record_count: number }>();
  for (const row of rows) {
    const client = row.client ?? null;
    const existing = totals.get(client);
    if (existing) {
      existing.event_count += row.event_count;
      existing.record_count += row.record_count;
    } else {
      totals.set(client, { event_count: row.event_count, record_count: row.record_count });
    }
  }
  return [...totals.entries()]
    .map(([client, t]) => ({ client, event_count: t.event_count, record_count: t.record_count }))
    .sort((a, b) => b.event_count - a.event_count);
}

// ── Agent family (kind × host) ───────────────────────────────────────────────

export interface AgentFamilyRow {
  /** The memory taxonomy family (`lesson`/`bus`/`signal`), or `null` when unresolved. */
  kind: string | null;
  /** The owning skill/agent (open free-text, bounded to the window's top 20 + 'other' by the RPC). */
  host: string | null;
  event_count: number;
  record_count: number;
}

/**
 * Calls and records grouped by `(kind, host)` — which agent FAMILY is
 * generating the traffic ("reviewer's lessons", "aw's bus events"), not just
 * how much. `host` is already bounded to this window's own top 20 + `'other'`
 * by `lorekit_usage_stats` (migration 00079); this only re-groups what the
 * RPC already returned, it does not impose its own bound.
 */
export function readsByAgentFamily(rows: readonly UsageStatRow[]): AgentFamilyRow[] {
  const totals = new Map<string, { kind: string | null; host: string | null; event_count: number; record_count: number }>();
  for (const row of rows) {
    const kind = row.kind ?? null;
    const host = row.host ?? null;
    if (kind === null && host === null) continue; // no taxonomy at all — nothing to attribute
    const key = `${kind ?? ''}\u0000${host ?? ''}`;
    const existing = totals.get(key);
    if (existing) {
      existing.event_count += row.event_count;
      existing.record_count += row.record_count;
    } else {
      totals.set(key, { kind, host, event_count: row.event_count, record_count: row.record_count });
    }
  }
  return [...totals.values()].sort((a, b) => b.event_count - a.event_count);
}
