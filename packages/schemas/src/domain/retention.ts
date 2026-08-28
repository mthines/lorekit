import { z } from 'zod';
import { ScopeSchema } from '../shared/scope.ts';

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

/** The three AND-ed match conditions a policy (or an inline groom call) carries. */
export const GroomConditionsSchema = z.object({
  min_age_days: z.number().int().min(1).max(3650).optional(),
  unseen_days: z.number().int().min(1).max(3650).optional(),
  max_seen_count: z.number().int().min(0).max(100_000).optional(),
});
export type GroomConditions = z.infer<typeof GroomConditionsSchema>;

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
});
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

/** `POST /policies` and the MCP `policy.create` tool. */
export const PolicyCreateBodySchema = z.object({
  scope: ScopeSchema,
  name: z.string().min(1).max(200),
  mode: RetentionModeSchema.optional().default('review'),
  enabled: z.boolean().optional().default(false),
}).merge(GroomConditionsSchema);
export type PolicyCreateBody = z.infer<typeof PolicyCreateBodySchema>;

/** `PATCH /policies/:id` and the MCP `policy.update` tool — every field optional. */
export const PolicyUpdateBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  mode: RetentionModeSchema.optional(),
  enabled: z.boolean().optional(),
  min_age_days: z.number().int().min(1).max(3650).nullable().optional(),
  unseen_days: z.number().int().min(1).max(3650).nullable().optional(),
  max_seen_count: z.number().int().min(0).max(100_000).nullable().optional(),
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
