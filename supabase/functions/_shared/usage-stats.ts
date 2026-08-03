// Pure logic for the usage-statistics endpoint (GET /memories/usage).
//
// The expensive grouping runs in Postgres (`lorekit_usage_stats`, migration
// 00043) exactly as `lorekit_memory_scopes` does — Postgres aggregation is
// exact at any row count where a `select` + client-side reduce is silently
// truncated past PostgREST's row cap. What stays here is the small, pure part
// that IS worth unit-testing and that both surfaces must agree on:
//
//   * `parseUsageWindow` — turn the request's `period` / `since` / `until` into
//     a validated `[since, until]` ISO window (or open-ended nulls).
//   * `usageToolKind` — classify a `usage_events.tool_name` as read / write /
//     other, so the summary can answer "how many reads vs writes".
//   * `summarizeUsageRows` / `rollupByScopeType` — roll the raw grouped rows
//     into the summary + per-scope-type view WITHOUT a second DB pass.
//
// Import-free so it can be mirrored verbatim into
// `supabase/functions/_shared/usage-stats.ts` (the edge tree cannot cross-import
// this package) and unit-tested in Node — the edge functions have no test
// harness of their own. `edge-parity.spec.ts` guards the two copies.

export class UsageStatsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageStatsError';
  }
}

/**
 * Supported rolling-window tokens. `all` means all-time (no lower bound).
 * Callers wanting an exact boundary (e.g. midnight in their own timezone) pass
 * an explicit ISO `since`/`until` instead.
 */
export const USAGE_PERIODS = ['24h', '7d', '30d', '90d', 'all'] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

const PERIOD_MS: Record<Exclude<UsagePeriod, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

export interface UsageWindowInput {
  period?: string;
  since?: string;
  until?: string;
}

export interface UsageWindow {
  /** ISO lower bound (inclusive), or null for all-time. */
  since: string | null;
  /** ISO upper bound (exclusive), or null for "up to now". */
  until: string | null;
}

function parseIsoOrThrow(value: string, name: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new UsageStatsError(`${name} is not a valid ISO 8601 date-time`);
  }
  return ms;
}

/**
 * Resolve the request's window parameters into a validated `[since, until]`.
 *
 * Precedence: an explicit `since` wins over `period`; `until` defaults to
 * open-ended ("up to now"). An omitted `period` with no `since` is all-time.
 * A future `since` is allowed (it simply yields an empty result) — only a
 * genuinely malformed or inverted window is rejected, so the function is a
 * total, side-effect-free validator.
 *
 * @throws {UsageStatsError} on an unknown `period`, an unparseable date, or a
 *   window whose `until` is not strictly after its `since`.
 */
export function parseUsageWindow(input: UsageWindowInput, now: number = Date.now()): UsageWindow {
  const { period, since, until } = input;

  if (period !== undefined && !(USAGE_PERIODS as readonly string[]).includes(period)) {
    throw new UsageStatsError(
      `period must be one of ${USAGE_PERIODS.join(', ')}`,
    );
  }

  let sinceMs: number | null = null;
  if (since !== undefined && since !== '') {
    sinceMs = parseIsoOrThrow(since, 'since');
  } else if (period !== undefined && period !== 'all') {
    sinceMs = now - PERIOD_MS[period as Exclude<UsagePeriod, 'all'>];
  }

  let untilMs: number | null = null;
  if (until !== undefined && until !== '') {
    untilMs = parseIsoOrThrow(until, 'until');
  }

  if (sinceMs !== null && untilMs !== null && untilMs <= sinceMs) {
    throw new UsageStatsError('until must be strictly after since');
  }

  return {
    since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
    until: untilMs === null ? null : new Date(untilMs).toISOString(),
  };
}

/**
 * The read tool_names in the `usage_events` vocabulary. Deliberately a
 * standalone list (not `permissions.ts`'s `READ_TOOLS`, which covers only the
 * memory.* gating vocabulary): usage events also carry `org.*`, `member.*` and
 * the aggregate `memory.scopes` / `memory.usage` names, and the read/write cut
 * for analytics is a presentation concern, not an authorization one.
 */
const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  'memory.read',
  'memory.list',
  'memory.search',
  'memory.scopes',
  'memory.list_archived',
  'memory.usage',
  'org.list',
  'org.get',
  'member.list',
  'member.invite_list',
]);

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'memory.write',
  'memory.delete',
  'memory.archive',
  'memory.restore',
  'memory.purge',
  'memory.purge_expired',
  'org.create',
  'org.rename',
  'org.delete',
  'member.role_change',
  'member.remove',
  'member.invite',
  'member.revoke',
]);

export type UsageToolKind = 'read' | 'write' | 'other';

/** Classify a `usage_events.tool_name`. Total — unknown names are `other`. */
export function usageToolKind(toolName: string): UsageToolKind {
  if (READ_TOOL_NAMES.has(toolName)) return 'read';
  if (WRITE_TOOL_NAMES.has(toolName)) return 'write';
  return 'other';
}

/**
 * The synthetic tool_name recorded when `purge_expired_memories` deletes rows
 * whose TTL has elapsed (migration 00045). Its `result_count` is the number of
 * records that expired, so "6 lessons got expired" is `sum(record_count)` over
 * this bucket. Classified `other`, not read/write — expiry is a system effect,
 * not a caller action — and surfaced as the summary's `expired` field.
 */
export const EXPIRED_TOOL_NAME = 'memory.expired';

/**
 * How many records an event touched, from a tool RESULT of unknown shape.
 * Total and fail-safe (returns null when it cannot tell), so a telemetry count
 * can never break the call it is measuring:
 *   - an array               → its length (org.list, …)
 *   - `{ entries: [...] }` / `{ archived: [...] }` → that array's length (list/search)
 *   - any other object       → 1 (a single record, e.g. memory.read)
 *   - null / undefined       → 0 (a miss)
 *   - anything else          → null
 */
export function countRecords(result: unknown): number | null {
  if (Array.isArray(result)) return result.length;
  if (result === null || result === undefined) return 0;
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    for (const key of ['entries', 'archived', 'results']) {
      const v = obj[key];
      if (Array.isArray(v)) return v.length;
    }
    return 1;
  }
  return null;
}

/**
 * Parse the `X-LoreKit-Result-Count` response header a collection handler sets.
 * Fail-safe: a non-integer / negative / absent value is `null`, never a throw —
 * the recording path treats an unknown count as "no record count".
 */
export function parseResultCountHeader(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * The SURFACE a usage event came from, as opposed to `auth_type` (how the
 * caller authenticated) or `tool_name` (what they asked for). Deliberately a
 * tiny CLOSED vocabulary rather than free text: this dimension is grouped and
 * filtered on, so an unbounded value would blow up analytics cardinality the
 * way `correlation_id` would without its length bound.
 *
 *   * `dashboard` — the LoreKit web dashboard rendering lore for a human.
 *   * `cli`       — the `lorekit` CLI.
 *   * `mcp`       — an agent over the MCP transport.
 *   * `api`       — a direct REST caller that named itself nothing else.
 *
 * `dashboard` is the one that changes a NUMBER rather than only labelling it:
 * `lorekit_read_activity` (migration 00054) excludes it, so opening or
 * reloading the dashboard no longer inflates the "Memories read" card. Browsing
 * your own lore is visualisation, not consumption — the card measures what your
 * agents read. The events are still recorded in full; only the metric excludes
 * them, so the ledger stays complete and the choice stays reversible.
 */
export const USAGE_CLIENTS = ['dashboard', 'cli', 'mcp', 'api'] as const;
export type UsageClient = (typeof USAGE_CLIENTS)[number];

/** The one client whose reads are excluded from the read-activity metric. */
export const DASHBOARD_CLIENT: UsageClient = 'dashboard';

/**
 * Validate the client-supplied `X-LoreKit-Client` header against the closed
 * vocabulary above. Total and fail-safe: an absent, empty, or unrecognised
 * value is `null` ("unattributed"), never an error — a header can never fail
 * the request it is describing, and an unknown client must not be able to
 * smuggle a new value into the ledger. Case- and whitespace-insensitive so a
 * caller sending `Dashboard` is attributed rather than silently dropped.
 */
export function parseUsageClient(raw: string | null | undefined): UsageClient | null {
  if (raw === null || raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  return (USAGE_CLIENTS as readonly string[]).includes(normalized)
    ? (normalized as UsageClient)
    : null;
}

/** Max length of a correlation id — bounds cardinality and storage. */
export const CORRELATION_ID_MAX = 200;

// Correlation ids are opaque client-supplied grouping keys — a PR ref
// (`mthines/lorekit#123`), a branch, a session id (`session_019…`). Restrict to
// a safe, printable set so the value can be logged, indexed and echoed without
// escaping concerns, and cannot smuggle control characters into analytics.
const CORRELATION_ID_RE = /^[A-Za-z0-9_\-./:#@]+$/;

/**
 * Validate and normalise a client-supplied correlation id (from the
 * `X-LoreKit-Correlation-Id` request header or the `correlation_id` query
 * param). Total and fail-safe — an empty, over-long or out-of-charset value is
 * `null` (no correlation / no filter), never an error, so a malformed header
 * can never fail a request.
 */
export function parseCorrelationId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > CORRELATION_ID_MAX) return null;
  if (!CORRELATION_ID_RE.test(trimmed)) return null;
  return trimmed;
}

/** One grouped row as returned by `lorekit_usage_stats` (bigints Number-ised). */
export interface UsageStatRow {
  tool_name: string;
  outcome: string;
  scope_type: string | null;
  /** Number of EVENTS (tool calls / routes) in this bucket. */
  event_count: number;
  /** Number of RECORDS those events touched (sum of `result_count`). */
  record_count: number;
  total_duration_ms: number | null;
}

export interface UsageSummary {
  /** Event (call) counts. */
  total_events: number;
  reads: number;
  writes: number;
  other: number;
  /**
   * RECORD counts — distinct from the call counts above. `records_read` is the
   * literal "you read N memories" figure (sum of `record_count` over read
   * events, not the number of read calls); `expired` is "N lessons expired"
   * (sum of `record_count` over the `memory.expired` bucket).
   */
  records_read: number;
  expired: number;
  by_outcome: Record<string, number>;
}

/**
 * Roll the raw grouped rows into headline totals. Pure: iterates once, adding
 * `event_count` into the read/write/other CALL buckets (by `usageToolKind`) and
 * into a per-outcome map, and `record_count` into the RECORD totals
 * (`records_read`, `expired`). A single source with the endpoint's `by_tool` —
 * no second DB query, so the numbers can never disagree with the rows.
 */
export function summarizeUsageRows(rows: readonly UsageStatRow[]): UsageSummary {
  const summary: UsageSummary = {
    total_events: 0, reads: 0, writes: 0, other: 0,
    records_read: 0, expired: 0, by_outcome: {},
  };
  const bucket: Record<UsageToolKind, 'reads' | 'writes' | 'other'> = {
    read: 'reads',
    write: 'writes',
    other: 'other',
  };
  for (const row of rows) {
    const n = row.event_count;
    const kind = usageToolKind(row.tool_name);
    summary.total_events += n;
    summary[bucket[kind]] += n;
    if (kind === 'read') summary.records_read += row.record_count;
    if (row.tool_name === EXPIRED_TOOL_NAME) summary.expired += row.record_count;
    summary.by_outcome[row.outcome] = (summary.by_outcome[row.outcome] ?? 0) + n;
  }
  return summary;
}

export interface ScopeTypeTally {
  scope_type: string | null;
  event_count: number;
}

/**
 * Collapse the grouped rows onto scope_type, summing event counts. Sorted by
 * count descending then scope_type ascending so the output is deterministic
 * (a null scope_type sorts last within an equal count).
 */
export function rollupByScopeType(rows: readonly UsageStatRow[]): ScopeTypeTally[] {
  const byScope = new Map<string | null, number>();
  for (const row of rows) {
    byScope.set(row.scope_type, (byScope.get(row.scope_type) ?? 0) + row.event_count);
  }
  return [...byScope.entries()]
    .map(([scope_type, event_count]) => ({ scope_type, event_count }))
    .sort((a, b) =>
      b.event_count - a.event_count ||
      (a.scope_type ?? '￿').localeCompare(b.scope_type ?? '￿'),
    );
}
