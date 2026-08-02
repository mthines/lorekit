import { z } from 'zod';
import { ScopeSchema, RawScopeSchema } from './scope.ts';
import { FilterGroupSchema } from './common.ts';
import { PURGE_RETENTION_DAYS_DEFAULT } from './tool-catalog.ts';

export const MAX_VALUE_BYTES = 65_536;

// Declared in the zero-dependency tool catalog (the MCP tool docs need it and
// cannot import zod); re-exported here so existing importers are unaffected.
export { PURGE_RETENTION_DAYS_DEFAULT };

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

/**
 * An ISO date (`2026-08-01`) or timestamp (`2026-08-01T12:00:00.000Z`).
 *
 * Used by the `created_since` / `created_until` list filters. A date-only
 * value already sorts as the start of that UTC day when compared against a
 * `timestamptz` column, so no client-side expansion is required. The pattern
 * is deliberately strict: these values are handed to PostgREST as filter
 * operands, and the same reasoning that makes `decodeCursor` validate its
 * `updated_at` applies here.
 */
export const TimestampFilterSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/,
    'must be an ISO date (YYYY-MM-DD) or timestamp',
  );

/** Sort column for `GET /memories`. The cursor encodes whichever is chosen. */
export const MemorySortSchema = z.enum(['updated_at', 'created_at']);
export type MemorySort = z.infer<typeof MemorySortSchema>;

/**
 * How a multi-label `tags` filter combines.
 *
 * `any` (the default, and the historical behaviour) is Postgres' `&&` overlap —
 * a row matching at least one label. `all` is `@>` containment — a row must
 * carry EVERY named label, which is what the dashboard's label filter means.
 */
export const TagsModeSchema = z.enum(['any', 'all']);
export type TagsMode = z.infer<typeof TagsModeSchema>;

export const ListMemoriesQuerySchema = z.object({
  scope: RawScopeSchema.optional(),
  key: z.string().min(1).max(512).optional(),
  tags: z.string().optional(),
  tags_mode: TagsModeSchema.optional().default('any'),
  /**
   * Case-insensitive substring match against `key` OR `value`.
   *
   * Deliberately NOT the full-text `q` of `POST /memories/search`: that one is
   * `websearch` FTS over the `fts` column (stemmed, word-boundary), which is
   * the right tool for "find lessons about auth" and the wrong one for an
   * as-you-type filter over a list the user is looking at. Both exist because
   * they answer different questions.
   */
  q: z.string().min(1).max(512).optional(),
  /** Inclusive lower bound on `created_at`. */
  created_since: TimestampFilterSchema.optional(),
  /** EXCLUSIVE upper bound on `created_at` — the window is `[since, until)`. */
  created_until: TimestampFilterSchema.optional(),
  sort: MemorySortSchema.optional().default('updated_at'),
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
  /**
   * Most recent `created_at` among the counted rows, or `null` for a scope
   * whose rows are all archived/expired (which cannot happen while `count`
   * is derived from the same predicate, but the column is nullable in SQL).
   *
   * Exists so a caller can render "last activity" per scope WITHOUT falling
   * back to listing rows and reducing them client-side — the row-cap trap this
   * endpoint exists to avoid.
   */
  last_activity: z.string().nullable().optional(),
});
export type ScopeCount = z.infer<typeof ScopeCountSchema>;

export const ScopesResponseSchema = z.object({ scopes: z.array(ScopeCountSchema) });
export type ScopesResponse = z.infer<typeof ScopesResponseSchema>;

// ── GET /memories/tags ───────────────────────────────────────────────────────

/**
 * Query params for `GET /memories/tags`.
 *
 * `archived` partitions exactly as `GET /memories` does: the catalog must
 * describe the population it will be used to filter, and active and archived
 * are different populations (an archive-only label is missing from the active
 * catalog, and the counts differ).
 */
export const ListTagsQuerySchema = z.object({
  archived: z.enum(['true', 'false']).optional().default('false'),
});
export type ListTagsQuery = z.infer<typeof ListTagsQuerySchema>;

/** One row of GET /memories/tags — a distinct label with how many rows carry it. */
export const TagCountSchema = z.object({
  tag: z.string(),
  count: z.number().int().nonnegative(),
});
export type TagCount = z.infer<typeof TagCountSchema>;

export const TagsResponseSchema = z.object({ tags: z.array(TagCountSchema) });
export type TagsResponse = z.infer<typeof TagsResponseSchema>;

// ── GET /memories/activity ───────────────────────────────────────────────────

/** Bucket granularity for `GET /memories/activity`. */
export const ActivityBucketUnitSchema = z.enum(['hour', 'day']);
export type ActivityBucketUnit = z.infer<typeof ActivityBucketUnitSchema>;

/**
 * Query params for `GET /memories/activity`.
 *
 * The window is half-open `[since, until)`, matching `GET /memories/usage`.
 * Both bounds are optional; `until` defaults to now and `since` to the start
 * of the retention window the handler picks, so a bare call is still bounded.
 */
export const ActivityQuerySchema = z.object({
  bucket: ActivityBucketUnitSchema.optional().default('day'),
  since: TimestampFilterSchema.optional(),
  until: TimestampFilterSchema.optional(),
});
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;

/**
 * One `(bucket, scope)` cell: how many memories were created in that UTC
 * hour/day under that scope.
 *
 * Aggregated in Postgres for the same reason `GET /memories/scopes` is — a
 * client that instead selects raw rows and tallies them silently loses whole
 * periods once the row count passes PostgREST's cap. `bucket` is the UTC start
 * of the interval, so a client bucketing by UTC hour/day tallies identically.
 */
export const ActivityBucketSchema = z.object({
  bucket: z.string(),
  scope: z.string(),
  count: z.number().int().nonnegative(),
});
export type ActivityBucket = z.infer<typeof ActivityBucketSchema>;

export const ActivityResponseSchema = z.object({
  bucket: ActivityBucketUnitSchema,
  since: z.string(),
  until: z.string(),
  buckets: z.array(ActivityBucketSchema),
});
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;

/**
 * PATCH /memories/:id body.
 *
 * The origin (provenance) fields are deliberately OMITTED: they record where a
 * memory was written FROM, which is a fact about a write, not an editable
 * property of the row. Admitting them here would also bypass the shared
 * `parseOrigin` normalisation that every real write path goes through.
 *
 * `org` is omitted for a different reason: it is not a property of the row at
 * all but an ownership TRANSFER, which is role-gated and has no PATCH
 * semantics. It was previously admitted and — like `ttl_days` / `clear_ttl` —
 * copied straight into the column patch, naming a column that does not exist;
 * every such request failed. `ttl_days` / `clear_ttl` stay, and the handler now
 * translates them into `expires_at` instead of passing them through.
 */
export const UpdateMemoryBodySchema = MemoryWriteSchema
  .omit({
    scope: true, key: true, created_at: true, org: true,
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

/**
 * The org that owns a memory, as embedded in a list response.
 *
 * `null` (or absent) means personal lore. The embed exists so a client can
 * render ownership without a second round trip per row — the dashboard's
 * `Personal · {org}` filter needs the org NAME, and only the row's `org_id` is
 * on `memories` itself.
 */
export const MemoryOrgSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});
export type MemoryOrg = z.infer<typeof MemoryOrgSchema>;

export const MemoryEntrySchema = z.object({
  id: z.string().uuid(), scope: z.string(), key: z.string(), value: z.string(),
  tags: z.array(z.string()), source_agent: z.string().nullable(), trigger: z.string().nullable(),
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable(), archived_at: z.string().datetime().nullable(),
  origin_repo: z.string().nullable().optional(), origin_branch: z.string().nullable().optional(),
  origin_commit: z.string().nullable().optional(), origin_pr: z.number().nullable().optional(),
  // Ownership / authorship. Optional so an older client (and the CLI's
  // RemoteStore, which reads none of them) is unaffected by the addition.
  org_id: z.string().uuid().nullable().optional(),
  org: MemoryOrgSchema.nullable().optional(),
  created_by: z.string().uuid().nullable().optional(),
  updated_by: z.string().uuid().nullable().optional(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

/**
 * The PostgREST projection every read route selects, so `GET /memories`,
 * `GET /memories/:id` and `POST /memories/search` cannot answer with different
 * shapes for the same `MemoryEntry`.
 *
 * `orgs(...)` is the to-one embed across `memories_org_id_fkey`; it resolves to
 * `null` for personal lore. {@link shapeMemoryRow} collapses it into the flat
 * `org` field the schema declares.
 */
export const MEMORY_SELECT =
  'id,scope,key,value,tags,source_agent,trigger,created_at,updated_at,expires_at,archived_at,'
  + 'origin_repo,origin_branch,origin_commit,origin_pr,org_id,created_by,updated_by,orgs(id,name,slug)';

/**
 * Collapse a selected row's `orgs` embed into the flat `org` field.
 *
 * Total by construction: an absent embed, an explicit `null`, PostgREST's
 * array form, or a partial object all degrade to `org: null` rather than
 * throwing — a read route must never 500 because a join came back in a shape
 * this function did not expect.
 */
export function shapeMemoryRow<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const { orgs, ...rest } = row as Record<string, unknown> & { orgs?: unknown };
  const embed = Array.isArray(orgs) ? orgs[0] : orgs;
  const org =
    embed && typeof embed === 'object'
      ? (embed as Record<string, unknown>)
      : null;
  const id = org?.['id'];
  const name = org?.['name'];
  const slug = org?.['slug'];
  return {
    ...rest,
    org:
      typeof id === 'string' && typeof name === 'string' && typeof slug === 'string'
        ? { id, name, slug }
        : null,
  };
}

/** Paginated list response for GET /memories and POST /memories/search */
export const MemoryPageResponseSchema = z.object({
  entries: z.array(MemoryEntrySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type MemoryPageResponse = z.infer<typeof MemoryPageResponseSchema>;
