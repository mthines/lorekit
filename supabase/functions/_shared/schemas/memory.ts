// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/memory.ts
// Regenerate: node scripts/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
import { z } from 'npm:zod@3';
import { ScopeSchema, RawScopeSchema } from './scope.ts';
import { FilterGroupSchema } from './common.ts';

export const MAX_VALUE_BYTES = 65_536;
export const PURGE_RETENTION_DAYS_DEFAULT = 30;

export const MemoryWriteSchema = z.object({
  scope: ScopeSchema, key: z.string().min(1).max(512),
  value: z.string().max(MAX_VALUE_BYTES, `value exceeds ${MAX_VALUE_BYTES} bytes`),
  tags: z.array(z.string()).optional().default([]),
  source_agent: z.string().optional(), trigger: z.string().optional(),
  created_at: z.string().optional(), org: z.string().optional(),
  ttl_days: z.number().int().min(1).max(365).optional(),
  clear_ttl: z.boolean().optional().default(false),
  // Provenance — where the memory was RECORDED FROM (vs `scope`, which says
  // where it applies). Every field is independently optional; the shared
  // `parseOrigin` validator (mcp-core / _shared/origin.ts) owns the shape rules.
  origin_repo: z.string().optional(), origin_branch: z.string().optional(),
  origin_commit: z.string().optional(), origin_pr: z.union([z.number(), z.string()]).optional(),
});
export type MemoryWrite = z.infer<typeof MemoryWriteSchema>;

export const MemoryReadSchema = z.object({ scope: ScopeSchema, key: z.string().min(1).max(512) });
export const MemoryListSchema = z.object({ scope: ScopeSchema, tags: z.array(z.string()).optional(), limit: z.number().int().min(1).max(100).optional().default(50) });
export const MemoryDeleteSchema = z.object({ scope: ScopeSchema, key: z.string().min(1).max(512), force: z.boolean().optional().default(false) });
export const MemorySearchSchema = z.object({ q: z.string().min(1), scopes: z.array(RawScopeSchema).optional(), tags: z.array(z.string()).optional() });
export const MemoryArchiveSchema = z.object({ scope: ScopeSchema, key: z.string().min(1).max(512) });
export const MemoryRestoreSchema = z.object({ scope: ScopeSchema, key: z.string().min(1).max(512) });
export const MemoryListArchivedSchema = z.object({ scope: ScopeSchema, limit: z.number().int().min(1).max(100).optional().default(50) });
export const MemoryPurgeSchema = z.object({ retention_days: z.number().int().min(1).max(365).optional().default(PURGE_RETENTION_DAYS_DEFAULT) });

// REST-specific
export const ListMemoriesQuerySchema = z.object({
  scope: RawScopeSchema.optional(),
  key: z.string().min(1).max(512).optional(),
  tags: z.string().optional(),
  archived: z.enum(['true','false']).optional().default('false'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
});
export type ListMemoriesQuery = z.infer<typeof ListMemoriesQuerySchema>;

export const CreateMemoryBodySchema = MemoryWriteSchema.extend({ scope: RawScopeSchema });
export type CreateMemoryBody = z.infer<typeof CreateMemoryBodySchema>;

/**
 * DELETE /memories and DELETE /memories/:id query params.
 *
 * Not derivable from MemoryDeleteSchema: that one is the MCP tool shape, where
 * `scope`/`key` are required and `force` arrives as a real boolean over JSON-RPC.
 * Over HTTP every query param is a string, so `force` is an enum coerced by the
 * handler, and scope+key are optional because the `/:id` form supplies neither.
 * `RawScopeSchema` (shape-only) rather than `ScopeSchema` for the same reason the
 * other REST schemas use it — normalisation happens downstream.
 *
 * `org` names an organization slug and switches the handler onto the role-gated
 * `memory_delete` RPC (00020), exactly as the MCP `memory.delete` tool's `org`
 * argument does. It is keyed on the natural key, so it is only valid together
 * with `scope` + `key` — the `/:id` form plus `org` is rejected as a 400.
 */
export const DeleteMemoryQuerySchema = z.object({
  scope: RawScopeSchema.optional(),
  key: z.string().min(1).max(512).optional(),
  force: z.enum(['true', 'false']).optional().default('false'),
  org: z.string().min(1).max(50).optional(),
});
export type DeleteMemoryQuery = z.infer<typeof DeleteMemoryQuerySchema>;

/**
 * POST /memories/restore body — the natural-key form the CLI uses.
 * Shape-compatible with the MCP `MemoryRestoreSchema` but with `RawScopeSchema`,
 * matching every other REST body schema in this file.
 */
export const RestoreMemoryBodySchema = z.object({
  scope: RawScopeSchema,
  key: z.string().min(1).max(512),
});
export type RestoreMemoryBody = z.infer<typeof RestoreMemoryBodySchema>;

/**
 * POST /memories/purge body. Identical field semantics to the MCP
 * `MemoryPurgeSchema`; kept as a separate export so the REST body can evolve
 * (extra fields) without changing the MCP tool contract, and so the OpenAPI
 * registration names a REST-shaped component.
 */
export const PurgeMemoriesBodySchema = z.object({
  retention_days: z.coerce.number().int().min(1).max(365).optional().default(PURGE_RETENTION_DAYS_DEFAULT),
});
export type PurgeMemoriesBody = z.infer<typeof PurgeMemoriesBodySchema>;

/** `200 { restored: true }` from POST /memories/restore and /memories/:id/restore. */
export const RestoreResponseSchema = z.object({ restored: z.boolean() });
export type RestoreResponse = z.infer<typeof RestoreResponseSchema>;

/** `200 { purged: <number> }` from POST /memories/purge and /memories/purge-expired. */
export const PurgeResponseSchema = z.object({ purged: z.number().int().nonnegative() });
export type PurgeResponse = z.infer<typeof PurgeResponseSchema>;

/** One row of GET /memories/scopes — a distinct scope with its non-archived count. */
export const ScopeCountSchema = z.object({
  scope: z.string(),
  count: z.number().int().nonnegative(),
});
export type ScopeCount = z.infer<typeof ScopeCountSchema>;

export const ScopesResponseSchema = z.object({ scopes: z.array(ScopeCountSchema) });
export type ScopesResponse = z.infer<typeof ScopesResponseSchema>;

/**
 * PATCH /memories/:id body.
 *
 * The origin (provenance) fields are deliberately OMITTED: they record where a
 * memory was written FROM, which is a fact about a write, not an editable
 * property of the row. `handleUpdate` copies body fields straight into the
 * column patch, so admitting them here would also bypass the shared
 * `parseOrigin` normalisation that every real write path goes through.
 */
export const UpdateMemoryBodySchema = MemoryWriteSchema
  .omit({
    scope: true, key: true, created_at: true,
    origin_repo: true, origin_branch: true, origin_commit: true, origin_pr: true,
  }).partial()
  .refine((d) => Object.keys(d).some((k) => d[k as keyof typeof d] !== undefined), { message: 'PATCH body must contain at least one field' });
export type UpdateMemoryBody = z.infer<typeof UpdateMemoryBodySchema>;

export const SearchMemoriesBodySchema = z.object({
  q: z.string().optional(), scopes: z.array(RawScopeSchema).optional(),
  tags: z.array(z.string()).optional(), filter: FilterGroupSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
}).refine((d) => d.q !== undefined || d.scopes !== undefined || d.filter !== undefined, { message: 'At least one of q, scopes, or filter is required' });
export type SearchMemoriesBody = z.infer<typeof SearchMemoriesBodySchema>;

export const MemoryEntrySchema = z.object({
  id: z.string().uuid(), scope: z.string(), key: z.string(), value: z.string(),
  tags: z.array(z.string()), source_agent: z.string().nullable(), trigger: z.string().nullable(),
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable(), archived_at: z.string().datetime().nullable(),
  origin_repo: z.string().nullable().optional(), origin_branch: z.string().nullable().optional(),
  origin_commit: z.string().nullable().optional(), origin_pr: z.number().nullable().optional(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

/** Paginated list response for GET /memories and POST /memories/search */
export const MemoryPageResponseSchema = z.object({
  entries: z.array(MemoryEntrySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type MemoryPageResponse = z.infer<typeof MemoryPageResponseSchema>;
