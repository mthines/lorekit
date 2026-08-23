// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/domain/usage.ts
// Regenerate: node scripts/sync-edge-schemas.mjs
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

/** One grouped row: events for a (tool, outcome, scope_type) triple. */
export const UsageStatRowSchema = z.object({
  tool_name: z.string(),
  outcome: z.string(),
  scope_type: z.string().nullable(),
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
