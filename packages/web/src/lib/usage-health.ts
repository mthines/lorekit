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
import { pctChange } from '@/lib/aggregations';

/** The closed `scope_type` vocabulary a row's value may legitimately carry. */
const KNOWN_SCOPE_TYPES = new Set(['global', 'project', 'repo', 'branch', 'mixed', 'invalid']);

/**
 * Drop dashboard-originated rows — mirrors the `client is distinct from
 * 'dashboard'` filter migrations 00054/00058/00069/00080 already apply to the
 * Explorer's "Memories retrieved"/"opened" cards ("browsing your lore is
 * visualisation, not consumption"). `/insights` had no equivalent: its own
 * tagline is "how your agents are actually using them", yet `HealthSummary`
 * and `UsageHealth` mixed in every dashboard page-load that happened to hit
 * the API (e.g. paging the Explorer) as if it were agent traffic.
 *
 * Deliberately NOT applied to {@link readsByClient} — "who is reading" exists
 * specifically to show the client split, dashboard included; dropping the row
 * there would defeat the one panel that answers "how much of my traffic is me
 * vs. my agents".
 */
export function excludeDashboardReads(rows: readonly UsageStatRow[]): UsageStatRow[] {
  return rows.filter((row) => row.client !== 'dashboard');
}

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

// ── At-a-glance summary ──────────────────────────────────────────────────────

/**
 * Tools whose calls can return memory records, so a records-per-call ratio is
 * a meaningful question to ask of them.
 *
 * Deliberately NOT every tool: `memory.write`/`memory.archive`/`org.*` carry
 * `record_count: 0` by construction, so folding them in would make a
 * write-heavy window look like a coverage failure. This is the one place the
 * distinction matters — `coverageGapsByScopeType` groups by scope rather than
 * by tool and predates the ratio being read as a headline, so it is left as it
 * is (a per-scope-type diagnostic, read next to its own tooltip).
 */
const RECORD_BEARING_TOOLS = new Set(['memory.list', 'memory.read', 'memory.search']);

export interface ReadCoverage {
  /** Calls to a {@link RECORD_BEARING_TOOLS} tool in the window. */
  readCalls: number;
  recordsFound: number;
  /** `recordsFound ÷ readCalls`. Never `NaN` — see {@link readCoverage}, which returns `null` instead. */
  recordsPerCall: number;
}

/**
 * How much lore the agents actually GOT, not just whether the call returned
 * 200 — "asked 1,176 times, found 15 records" is the question this page exists
 * to answer, and no `outcome` value expresses it: the vocabulary is
 * `ok | cap_exceeded | rate_limited | permission_denied | error`, all of which
 * describe the transport or the authorization, none of which describe an agent
 * asking for lore and getting nothing back. A successful read of an empty
 * scope is `ok`.
 *
 * `null` when the window contains no record-bearing calls at all — a
 * write-only window has no coverage to report, and `0 / 0` presented as "0
 * records per read" would read as a failure rather than as an absence.
 */
export function readCoverage(rows: readonly UsageStatRow[]): ReadCoverage | null {
  let readCalls = 0;
  let recordsFound = 0;
  for (const row of rows) {
    if (!RECORD_BEARING_TOOLS.has(row.tool_name)) continue;
    readCalls += row.event_count;
    recordsFound += row.record_count;
  }
  if (readCalls === 0) return null;
  return { readCalls, recordsFound, recordsPerCall: recordsFound / readCalls };
}

/** Named `HealthSummaryStats`, not `HealthSummary`, to avoid colliding with the `HealthSummary` React component (`dashboard/HealthSummary.tsx`) that consumes it. */
export interface HealthSummaryStats {
  totalCalls: number;
  /** `ok` calls ÷ total, in [0, 1]. `1` (not `NaN`) when there were no calls — nothing failed because nothing happened. */
  successRate: number;
  /** The single most frequent failure in the window, or `null` when nothing failed. */
  topFailure: FailureRow | null;
  /** How much lore the reads actually found — `null` when the window has no record-bearing calls. */
  coverage: ReadCoverage | null;
}

/** Sum `event_count`/`ok`-outcome share directly from rows — see {@link summarizeHealth}. */
function totalsFromRows(rows: readonly UsageStatRow[]): { totalCalls: number; successRate: number } {
  let totalCalls = 0;
  let okCalls = 0;
  for (const row of rows) {
    totalCalls += row.event_count;
    if (row.outcome === 'ok') okCalls += row.event_count;
  }
  return { totalCalls, successRate: totalCalls > 0 ? okCalls / totalCalls : 1 };
}

/**
 * The headline a reader should see BEFORE the three diagnostic panels below —
 * "is this basically fine" answered in one line, so the panels are for
 * investigating a problem this already told you exists, not the first thing
 * you have to parse to find out whether one does.
 *
 * Sums `rows` directly rather than reading `/usage`'s pre-rolled
 * `summary.total_events`/`by_outcome`: those totals are computed server-side
 * over EVERY client, including the dashboard's own page-loads, so they no
 * longer agree with a caller that passed {@link excludeDashboardReads}'d rows.
 * `rows` is what the caller actually wants summarised — pass the full set to
 * reproduce the old "every client" total, or the dashboard-excluded set for
 * an agent-only one.
 */
export function summarizeHealth(rows: readonly UsageStatRow[], failures: readonly FailureRow[]): HealthSummaryStats {
  const { totalCalls, successRate } = totalsFromRows(rows);
  return { totalCalls, successRate, topFailure: failures[0] ?? null, coverage: readCoverage(rows) };
}

// ── Verdict ──────────────────────────────────────────────────────────────────

export type Verdict = 'healthy' | 'degraded' | 'unhealthy';

/** Which dimension the verdict is actually reporting on — so the banner can say. */
export type VerdictDriver = 'reliability' | 'coverage';

/** At or above this success rate, calls are reliable enough to read as healthy. */
const HEALTHY_SUCCESS_RATE = 0.99;
/** Below {@link HEALTHY_SUCCESS_RATE} but at or above this, reliability is a caution rather than a problem. */
const DEGRADED_SUCCESS_RATE = 0.95;
/** At or above this many records per read, agents are finding the lore they ask for. Same 1-record-per-call line `UsageHealth`'s coverage panel draws. */
const HEALTHY_RECORDS_PER_CALL = 1;
/** Below {@link HEALTHY_RECORDS_PER_CALL} but at or above this, coverage is thin rather than absent. */
const DEGRADED_RECORDS_PER_CALL = 0.5;

const VERDICT_RANK: Record<Verdict, number> = { healthy: 0, degraded: 1, unhealthy: 2 };

function reliabilityVerdict(successRate: number): Verdict {
  if (successRate >= HEALTHY_SUCCESS_RATE) return 'healthy';
  if (successRate >= DEGRADED_SUCCESS_RATE) return 'degraded';
  return 'unhealthy';
}

function coverageVerdict(recordsPerCall: number): Verdict {
  if (recordsPerCall >= HEALTHY_RECORDS_PER_CALL) return 'healthy';
  if (recordsPerCall >= DEGRADED_RECORDS_PER_CALL) return 'degraded';
  return 'unhealthy';
}

export interface HealthVerdict {
  verdict: Verdict;
  /** The dimension responsible for {@link verdict} — the banner names it so a red badge is never unexplained. */
  driver: VerdictDriver;
}

/**
 * The verdict weighs RELIABILITY (did the calls succeed) against COVERAGE (did
 * the reads find anything), and reports the WORSE of the two.
 *
 * Reliability alone was the original headline and it is very nearly a
 * constant: LoreKit's own API is stable, and the `outcome` vocabulary contains
 * no "found nothing" state, so a healthy account read "100% of calls
 * succeeded" every single day. A headline that cannot vary carries no
 * information while occupying the largest, first slot on the page — and the
 * signal a reader actually came for (agents asking a scope for lore that is
 * not there) was a 10px row three columns into the section below.
 *
 * Ties go to `reliability` as the driver, so a healthy verdict names the
 * dimension a reader is most likely to already understand. A window with no
 * record-bearing calls has no coverage to weigh (`coverage: null`) and falls
 * back to reliability alone rather than inventing a zero.
 */
export function healthVerdict(stats: Pick<HealthSummaryStats, 'successRate' | 'coverage'>): HealthVerdict {
  const reliability = reliabilityVerdict(stats.successRate);
  if (stats.coverage === null) return { verdict: reliability, driver: 'reliability' };
  const coverage = coverageVerdict(stats.coverage.recordsPerCall);
  return VERDICT_RANK[coverage] > VERDICT_RANK[reliability]
    ? { verdict: coverage, driver: 'coverage' }
    : { verdict: reliability, driver: 'reliability' };
}

export interface HealthTrend {
  /** Period-over-period % change in call volume (current window vs. the immediately preceding one of equal length). */
  totalCallsChangePct: number;
  /** PERCENTAGE-POINT delta in success rate (current − previous) — a ratio-of-ratios % change would misread a rate. */
  successRateDeltaPct: number;
}

/**
 * The smallest previous-window call count a period-over-period comparison is
 * reported for.
 *
 * Guarding only against zero left the chip firing off a baseline of ONE call:
 * a previous window with a single successful call and a current window with a
 * thousand at 99% renders "+99,900%" and "−1pp", both arithmetically correct
 * and both noise. This module is otherwise scrupulous about exactly that class
 * of overclaim — `read_count: 0` is never rendered as "never read", the
 * latency figure is labelled a mean rather than implied to be a p95 — so the
 * chip is held to the same standard. Well under a day of normal agent traffic,
 * so a real comparison is not suppressed.
 */
const MIN_TREND_CALLS = 20;

/**
 * Compare a window's totals against the immediately preceding equal-length
 * window — "is my agent reading better this week than last" as a number
 * instead of a reader having to flip the range picker back and forth and
 * remember what the banner said.
 *
 * `null` when the previous window carries fewer than {@link MIN_TREND_CALLS}
 * calls: a % change against zero is either a fabricated "+100%" or a
 * divide-by-zero, and a change against a handful is a percentage dressed up as
 * a signal. A young scope's first busy week deserves neither — there is
 * nothing meaningful to compare against yet.
 */
export function healthTrend(
  currentRows: readonly UsageStatRow[],
  previousRows: readonly UsageStatRow[],
): HealthTrend | null {
  const previous = totalsFromRows(previousRows);
  if (previous.totalCalls < MIN_TREND_CALLS) return null;
  const current = totalsFromRows(currentRows);
  return {
    totalCallsChangePct: pctChange(current.totalCalls, previous.totalCalls),
    successRateDeltaPct: Math.round((current.successRate - previous.successRate) * 1000) / 10,
  };
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
