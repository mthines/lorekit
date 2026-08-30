// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/domain/retention.ts
// Regenerate: node scripts/codegen/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
import { z } from 'npm:zod@3';
import { ScopeSchema } from './scope.ts';
import { ScalarFilterModeSchema, TagsModeSchema } from './memory.ts';

/**
 * Retention policies — scoped, saved rules that AUTO-ARCHIVE matching
 * lessons. This file is retention's own domain (not folded into `memory.ts`)
 * because it is a genuinely separate concept — a saved RULE, not a memory —
 * and keeping it apart is what lets the schema map stay legible as the
 * feature grows (org-owned policies, more condition types).
 *
 * v1 is personal-owned (`user_id`-keyed) only. `policy_id` OR inline
 * conditions are accepted on `groom.preview` / `groom.run` — never both
 * required, never both silently combined.
 */

export const RetentionModeSchema = z.enum(['review', 'auto']);
export type RetentionMode = z.infer<typeof RetentionModeSchema>;

/**
 * A dimension value list for a policy's filters — deliberately the same
 * bounds as `memory.ts`'s `DimensionValuesSchema` (not imported: that one is
 * `const`-scoped, not exported, and this is the one place outside
 * `memory.ts` that needs the identical shape) so a value the Explorer's
 * filter bar can hold is always one a policy can also hold.
 */
const GroomValueListSchema = z.array(z.string().min(1).max(512)).max(1000);

/**
 * The EIGHT dimension filters a policy (or an inline groom call) can ALSO
 * carry — the exact set the Lore Explorer's filter bar offers
 * (`lib/filters.ts`'s `FILTER_FIELDS`), minus `owner`: a policy's `scope`
 * already partitions personal-vs-org lore (v1 is personal-owned only), so a
 * second ownership predicate would either agree with the scope or silently
 * fight it. Field names and `*_mode` semantics are IDENTICAL to
 * `ListMemoriesBodySchema`'s dimension fields — same `TagsModeSchema` /
 * `ScalarFilterModeSchema`, same OR-within/AND-across combination — so
 * `lib/filters.ts`'s `Filter[]` bar and a policy's saved conditions are one
 * shape read two ways, not two shapes that can drift.
 *
 * `origin_pr` is a STRING list here, not an integer one: the wire and the
 * Explorer's filter bar both speak digit strings (`ListMemoriesBodySchema`
 * does the same), and the digits-only coercion happens once, downstream,
 * exactly as `GET /memories`' `origin_pr` already works — never twice.
 *
 * `*_mode` fields are `.optional()` WITHOUT a zod `.default(...)` — unlike
 * `ListMemoriesBodySchema`'s `dimensionBodyFields`, which default so the
 * REST route always has a mode to compose SQL with. Here, a `.default(...)`
 * would make zod's INFERRED type (`GroomConditions`, below) report every
 * `*_mode` field as always-present, which breaks every caller that builds a
 * `GroomConditions`/`PolicyCreateBody` INCREMENTALLY (a conditional spread
 * per field, `lib/retention-filter.ts`'s whole pattern) — those callers
 * genuinely may not have a mode to offer yet. The default a caller omits is
 * applied downstream instead, once, by both edge handlers
 * (`groomConditionsRpcParams` in `groom.ts` / `mcp/tools.ts`) immediately
 * before the RPC call — the same value (`'any'` / `'in'`) this schema would
 * otherwise have defaulted to, just applied one layer later.
 */
export const GroomDimensionFiltersSchema = z.object({
  tags: GroomValueListSchema.optional(),
  tags_mode: TagsModeSchema.optional(),
  source_agent: GroomValueListSchema.optional(),
  source_agent_mode: ScalarFilterModeSchema.optional(),
  trigger: GroomValueListSchema.optional(),
  trigger_mode: ScalarFilterModeSchema.optional(),
  kind: GroomValueListSchema.optional(),
  kind_mode: ScalarFilterModeSchema.optional(),
  host: GroomValueListSchema.optional(),
  host_mode: ScalarFilterModeSchema.optional(),
  origin_repo: GroomValueListSchema.optional(),
  origin_repo_mode: ScalarFilterModeSchema.optional(),
  origin_branch: GroomValueListSchema.optional(),
  origin_branch_mode: ScalarFilterModeSchema.optional(),
  origin_pr: GroomValueListSchema.optional(),
  origin_pr_mode: ScalarFilterModeSchema.optional(),
});
export type GroomDimensionFilters = z.infer<typeof GroomDimensionFiltersSchema>;

/** The AND-ed match conditions a policy (or an inline groom call) carries — the three age/activity thresholds plus the eight dimension filters above. */
export const GroomConditionsSchema = z.object({
  min_age_days: z.number().int().min(1).max(3650).optional(),
  unseen_days: z.number().int().min(1).max(3650).optional(),
  max_seen_count: z.number().int().min(0).max(100_000).optional(),
}).merge(GroomDimensionFiltersSchema);
export type GroomConditions = z.infer<typeof GroomConditionsSchema>;

/** The dimension-filter columns as READ BACK from a saved policy row — nullable, never absent. */
const GroomDimensionFiltersColumnsSchema = z.object({
  tags: z.array(z.string()).nullable(),
  tags_mode: TagsModeSchema.nullable(),
  source_agent: z.array(z.string()).nullable(),
  source_agent_mode: ScalarFilterModeSchema.nullable(),
  trigger: z.array(z.string()).nullable(),
  trigger_mode: ScalarFilterModeSchema.nullable(),
  kind: z.array(z.string()).nullable(),
  kind_mode: ScalarFilterModeSchema.nullable(),
  host: z.array(z.string()).nullable(),
  host_mode: ScalarFilterModeSchema.nullable(),
  origin_repo: z.array(z.string()).nullable(),
  origin_repo_mode: ScalarFilterModeSchema.nullable(),
  origin_branch: z.array(z.string()).nullable(),
  origin_branch_mode: ScalarFilterModeSchema.nullable(),
  origin_pr: z.array(z.string()).nullable(),
  origin_pr_mode: ScalarFilterModeSchema.nullable(),
});

export const RetentionPolicySchema = z.object({
  id: z.string().uuid(),
  scope: z.string(),
  name: z.string().min(1).max(200),
  mode: RetentionModeSchema,
  enabled: z.boolean(),
  min_age_days: z.number().int().nullable(),
  unseen_days: z.number().int().nullable(),
  max_seen_count: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).merge(GroomDimensionFiltersColumnsSchema);
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

/** `POST /policies` and the MCP `policy.create` tool. */
export const PolicyCreateBodySchema = z.object({
  scope: ScopeSchema,
  name: z.string().min(1).max(200),
  mode: RetentionModeSchema.optional().default('review'),
  enabled: z.boolean().optional().default(false),
}).merge(GroomConditionsSchema);
export type PolicyCreateBody = z.infer<typeof PolicyCreateBodySchema>;

/**
 * `PATCH /policies/:id` and the MCP `policy.update` tool — every field
 * optional, and every dimension filter NULLABLE-optional like `min_age_days`:
 * absent leaves the column unchanged, `null` clears it, a value sets it.
 */
export const PolicyUpdateBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  mode: RetentionModeSchema.optional(),
  enabled: z.boolean().optional(),
  min_age_days: z.number().int().min(1).max(3650).nullable().optional(),
  unseen_days: z.number().int().min(1).max(3650).nullable().optional(),
  max_seen_count: z.number().int().min(0).max(100_000).nullable().optional(),
  tags: GroomValueListSchema.nullable().optional(),
  tags_mode: TagsModeSchema.nullable().optional(),
  source_agent: GroomValueListSchema.nullable().optional(),
  source_agent_mode: ScalarFilterModeSchema.nullable().optional(),
  trigger: GroomValueListSchema.nullable().optional(),
  trigger_mode: ScalarFilterModeSchema.nullable().optional(),
  kind: GroomValueListSchema.nullable().optional(),
  kind_mode: ScalarFilterModeSchema.nullable().optional(),
  host: GroomValueListSchema.nullable().optional(),
  host_mode: ScalarFilterModeSchema.nullable().optional(),
  origin_repo: GroomValueListSchema.nullable().optional(),
  origin_repo_mode: ScalarFilterModeSchema.nullable().optional(),
  origin_branch: GroomValueListSchema.nullable().optional(),
  origin_branch_mode: ScalarFilterModeSchema.nullable().optional(),
  origin_pr: GroomValueListSchema.nullable().optional(),
  origin_pr_mode: ScalarFilterModeSchema.nullable().optional(),
});
export type PolicyUpdateBody = z.infer<typeof PolicyUpdateBodySchema>;

export const PolicyListResponseSchema = z.object({ entries: z.array(RetentionPolicySchema) });
export type PolicyListResponse = z.infer<typeof PolicyListResponseSchema>;

/**
 * `groom.preview` / `groom.run` input — a policy_id OR inline conditions, on
 * BOTH the REST body and the MCP tool. `scope` is required only for the
 * inline form; a `policy_id` already carries its own scope.
 */
export const GroomRequestSchema = z.union([
  z.object({ policy_id: z.string().uuid() }),
  z.object({ scope: ScopeSchema }).merge(GroomConditionsSchema),
]);
export type GroomRequest = z.infer<typeof GroomRequestSchema>;

export const GroomCandidateKeySchema = z.object({ scope: z.string(), key: z.string() });

export const GroomPreviewResponseSchema = z.object({
  count: z.number().int(),
  keys: z.array(GroomCandidateKeySchema),
});
export type GroomPreviewResponse = z.infer<typeof GroomPreviewResponseSchema>;

export const GroomRunResponseSchema = z.object({
  archived: z.number().int(),
  keys: z.array(GroomCandidateKeySchema),
});
export type GroomRunResponse = z.infer<typeof GroomRunResponseSchema>;

/** `POST /protect` and the MCP `memory.protect` tool. */
export const ProtectBodySchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1).max(512),
  protected: z.boolean(),
});
export type ProtectBody = z.infer<typeof ProtectBodySchema>;

export const ProtectResponseSchema = z.object({ protected: z.boolean() });
export type ProtectResponse = z.infer<typeof ProtectResponseSchema>;
