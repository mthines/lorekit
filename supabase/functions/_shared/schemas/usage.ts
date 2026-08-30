// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/domain/usage.ts
// Regenerate: node scripts/codegen/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
import { z } from 'npm:zod@3';

/**
 * Query + response shapes for `GET /memories/usage` — aggregate usage
 * statistics read back from `usage_events` (migration 00034).
 *
 * The window tokens are duplicated from `packages/mcp-core/src/telemetry/usage-stats.ts`
 * on purpose: that module is import-free so it can be mirrored verbatim into the
 * edge tree, so it cannot import this schema (and this leaf package cannot
 * import mcp-core). The two lists are tiny and both are unit-tested.
 */

/** Rolling-window tokens accepted by the `period` query param. */
export const USAGE_PERIODS = ['24h', '7d', '30d', '90d', 'all'] as const;

/**
 * `GET /memories/usage` query params. All optional:
 *   - `period` — a rolling window (`24h`/`7d`/`30d`/`90d`/`all`).
 *   - `since` / `until` — explicit ISO bounds; `since` overrides `period`.
 * Omitting everything means all-time. Semantic validation (an inverted window)
 * happens in `parseUsageWindow`, so the schema only checks shape.
 */
export const UsageStatsQuerySchema = z.object({
  period: z.enum(USAGE_PERIODS).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  // Optional grouping key: restrict the result to one PR / session / job (see
  // the X-LoreKit-Correlation-Id write contract). Bounded; the handler
  // normalises it through the pure `parseCorrelationId`.
  correlation_id: z.string().min(1).max(200).optional(),
});
export type UsageStatsQuery = z.infer<typeof UsageStatsQuerySchema>;

/**
 * One grouped row: events for a (tool, outcome, scope_type, client, kind,
 * host) tuple (migration 00079 added the last three — `client` is which
 * SURFACE called, `kind`/`host` are the memory taxonomy family/owner).
 * `client`/`kind`/`host` are nullable: not every call carries them (a
 * headerless legacy caller, an org.* tool with no memory taxonomy). `host` is
 * additionally bounded to the window's own top 20 by event count — anything
 * else arrives as the literal `'other'`, never an unbounded free-text value.
 */
export const UsageStatRowSchema = z.object({
  tool_name: z.string(),
  outcome: z.string(),
  scope_type: z.string().nullable(),
  // Optional (not just nullable) so a fixture/response from before migration
  // 00079 — and every existing call site that only knew tool_name/outcome/
  // scope_type — still typechecks without inventing these three.
  client: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
  host: z.string().nullable().optional(),
  // event_count = tool CALLS; record_count = the RECORDS those calls touched.
  event_count: z.number().int().nonnegative(),
  record_count: z.number().int().nonnegative(),
  total_duration_ms: z.number().int().nonnegative().nullable(),
});
export type UsageStatRow = z.infer<typeof UsageStatRowSchema>;

export const UsageSummarySchema = z.object({
  total_events: z.number().int().nonnegative(),
  reads: z.number().int().nonnegative(),
  writes: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
  // Record-level headline figures (distinct from the call counts above).
  records_read: z.number().int().nonnegative(),
  // Lifecycle counts in the window: `archived` is the number of `memory.archive`
  // calls (one per memory; the write sets no record-count, so it is counted by
  // event), `expired` the records the TTL purge removed (one event, N records).
  archived: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  by_outcome: z.record(z.number().int().nonnegative()),
  /**
   * The highest `memories.count` snapshot recorded on a WRITE event
   * (`usage_events.memory_count`, migration 00034) in this window — migration
   * 00081 surfaces it. Answers "how full WAS this account over the window",
   * distinct from the live "how full is it now" the plan page's existing
   * `lorekit_memory_count()` call answers. `null` when the window has no
   * write events at all, or for a service-role caller with no target user —
   * never a fabricated 0, which would read as "empty" rather than "unknown".
   * No limit accompanies this field: pair it with the caller's own
   * `lorekit_get_limit`/`lorekit_memory_count` reading, never a hardcoded
   * number.
   */
  peak_memory_count: z.number().int().nonnegative().nullable().optional(),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const UsageScopeTallySchema = z.object({
  scope_type: z.string().nullable(),
  event_count: z.number().int().nonnegative(),
});

export const UsageStatsResponseSchema = z.object({
  range: z.object({
    since: z.string().nullable(),
    until: z.string().nullable(),
  }),
  // Echoes the applied correlation filter (null when unfiltered).
  correlation_id: z.string().nullable(),
  summary: UsageSummarySchema,
  by_tool: z.array(UsageStatRowSchema),
  by_scope_type: z.array(UsageScopeTallySchema),
});
export type UsageStatsResponse = z.infer<typeof UsageStatsResponseSchema>;

/**
 * `GET /memories/usage/runs` — enumerates runs (distinct `correlation_id`
 * values), each with what it read, wrote, and touched. The payoff view for
 * `?correlation_id=`: that filters TO one run; this is how a caller
 * discovers which ones exist. REST-only (`telemetry-vocabulary.ts`'s
 * `NON_CATALOG_OPS`) — no MCP tool, no CLI command, by the same "dashboard
 * analytics, not an agent primitive" decision as `/usage`/`/tags`/etc.
 */
export const UsageRunsQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().optional(),
  // `z.coerce` — query params arrive as strings (`validateQuery` parses
  // `URLSearchParams`), so a bare `z.number()` 400s on every caller that
  // sends the param. Same defect, same fix as `ReadRankingQuerySchema`.
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});
export type UsageRunsQuery = z.infer<typeof UsageRunsQuerySchema>;

/**
 * One run: everything `usage_events` knows about one `correlation_id`.
 * `read_events`/`records_read`/`write_events` use the SAME broader
 * `READ_TOOL_NAMES`/`WRITE_TOOL_NAMES` vocabulary `summarizeUsageRows`
 * (`usage-stats.ts`) does for `/usage`'s own summary — NOT
 * `lorekit_read_activity`'s narrower 4-tool "read" definition. A run summary
 * answers "what did this run do overall", not "how many memories did it
 * read" — pick one per view and say which, per this repo's own rule.
 */
export const UsageRunSchema = z.object({
  correlation_id: z.string(),
  session_kind: z.string().nullable(),
  first_seen: z.string().datetime(),
  last_seen: z.string().datetime(),
  read_events: z.number().int().nonnegative(),
  records_read: z.number().int().nonnegative(),
  write_events: z.number().int().nonnegative(),
  distinct_scopes: z.number().int().nonnegative(),
  total_duration_ms: z.number().int().nonnegative(),
});
export type UsageRun = z.infer<typeof UsageRunSchema>;

export const UsageRunsResponseSchema = z.object({
  range: z.object({
    since: z.string(),
    until: z.string(),
  }),
  runs: z.array(UsageRunSchema),
  next_cursor: z.string().nullable(),
});
export type UsageRunsResponse = z.infer<typeof UsageRunsResponseSchema>;
