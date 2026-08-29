// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/domain/memory.ts
// Regenerate: node scripts/codegen/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
import { z } from 'npm:zod@3';
import { ScopeSchema, RawScopeSchema } from './scope.ts';
import { FilterGroupSchema } from './common.ts';
import { PURGE_RETENTION_DAYS_DEFAULT } from './tool-catalog.ts';

export const MAX_VALUE_BYTES = 65_536;

// Declared in the zero-dependency tool catalog (the MCP tool docs need it and
// cannot import zod); re-exported here so existing importers are unaffected.
export { PURGE_RETENTION_DAYS_DEFAULT };

/**
 * The three KINDS of memory a self-improvement loop writes — the bucket
 * taxonomy promoted to a first-class property.
 *
 * `lesson` — a procedural "how to do better next time" rule, read every run.
 * `bus`    — a transient per-item outcome event, read only at promotion time.
 * `signal` — a durable, learned per-repo filter, read every run.
 *
 * A closed vocabulary: adding a kind is a schema change, deliberately, because
 * the three families drive different read cadences and lifetimes. `host` (the
 * owning skill/agent) is open free-text, like `source_agent`. The authoritative
 * reference is agent-skills' `agents/shared/rules/memory-buckets.md`.
 */
export const MemoryKindSchema = z.enum(['lesson', 'bus', 'signal']);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemoryWriteSchema = z.object({
  scope: ScopeSchema, key: z.string().min(1).max(512),
  value: z.string().max(MAX_VALUE_BYTES, `value exceeds ${MAX_VALUE_BYTES} bytes`).transform((s) => s.trim()),
  tags: z.array(z.string()).optional().default([]),
  source_agent: z.string().optional(), trigger: z.string().optional(),
  created_at: z.string().optional(), org: z.string().optional(),
  ttl_days: z.number().int().min(1).max(365).optional(),
  clear_ttl: z.boolean().optional().default(false),
  // Taxonomy — WHAT KIND of memory this is and WHICH HOST owns it. Both are
  // optional: an older client omits them and the write path derives them from
  // the `loop::<host>-lessons` tag via `inferKindHost` (tags.ts).
  kind: MemoryKindSchema.optional(), host: z.string().max(64).optional(),
  // Provenance — where the memory was RECORDED FROM (vs `scope`, which says
  // where it applies). Every field is independently optional; the shared
  // `parseOrigin` validator (mcp-core / _shared/provenance/origin.ts) owns the shape rules.
  origin_repo: z.string().optional(), origin_branch: z.string().optional(),
  origin_commit: z.string().optional(), origin_pr: z.union([z.number(), z.string()]).optional(),
});
export type MemoryWrite = z.infer<typeof MemoryWriteSchema>;

export const MemoryReadSchema = z.object({ scope: ScopeSchema, key: z.string().min(1).max(512) });

/**
 * How much of each entry a list read puts on the wire.
 *
 * `full`    — every entry carries its complete `value` (the historical shape).
 * `summary` — `value` is REPLACED by `value_bytes` + a bounded `preview`.
 *
 * The split exists because the two reads answer different questions. An agent
 * deciding WHICH lessons apply to the change in front of it needs the index —
 * keys, tags, freshness — not 50 full bodies; it can then `memory.read` the
 * handful it matched. At the observed ~1.9 KB median body, a 50-entry
 * `full` list is ~95 KB of caller context, the overwhelming majority of which
 * is never consulted. `summary` is the cheap discovery half of that read.
 *
 * `full` remains the default: the parameter is additive and no existing caller
 * changes shape.
 */
export const MemoryListViewSchema = z.enum(['full', 'summary']);
export type MemoryListView = z.infer<typeof MemoryListViewSchema>;

/** Characters of `value` echoed in a `summary` entry's `preview`. */
export const LIST_PREVIEW_CHARS = 200;

export const MemoryListSchema = z.object({ scope: ScopeSchema, tags: z.array(z.string()).optional(), limit: z.number().int().min(1).max(100).optional().default(50), cursor: z.string().optional(), order: z.enum(['recency', 'rank']).optional().default('recency'), kind: MemoryKindSchema.optional(), host: z.string().min(1).max(64).optional(), view: MemoryListViewSchema.optional().default('full') });
export const MemoryDeleteSchema = z.object({ scope: ScopeSchema, key: z.string().min(1).max(512), force: z.boolean().optional().default(false) });
export const MemorySearchSchema = z.object({ q: z.string().min(1), scopes: z.array(RawScopeSchema).optional(), tags: z.array(z.string()).optional(), limit: z.number().int().min(1).max(100).optional().default(20), cursor: z.string().optional() });
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
 * `none` is the negation of `any` (`not.ov`) — a row carrying none of the named
 * labels, which is what the Explorer's "includes none" operator means. There is
 * deliberately no `not_all`: "does not carry every one of these" is a shape no
 * user has asked for and reads as a double negative in a filter pill.
 */
export const TagsModeSchema = z.enum(['any', 'all', 'none']);
export type TagsMode = z.infer<typeof TagsModeSchema>;

/**
 * How a scalar multi-value filter (`source_agent`, `trigger`, `origin_*`)
 * combines.
 *
 * `in` is disjunctive — the row's value is one of the named values, which is
 * the Explorer's `is` / `is either of`. `nin` is its negation (`not.in`), the
 * Explorer's `is not`. Stating the negation as `not.in` rather than expanding
 * it into a conjunction of `neq`s matters: NOT(a OR b) and (NOT a AND NOT b)
 * agree only while the column is NOT NULL, and every column here is nullable —
 * `not.in` keeps the two readings identical by never leaving PostgREST.
 */
export const ScalarFilterModeSchema = z.enum(['in', 'nin']);
export type ScalarFilterMode = z.infer<typeof ScalarFilterModeSchema>;

/**
 * A comma-separated list of values for a scalar multi-value filter.
 *
 * Same wire shape (and the same "a value containing a comma is unreachable
 * over this parameter" caveat) as `tags`, parsed by the same
 * `parseTagsParam` — one splitting rule for every list-valued query param,
 * rather than a second one that could round-trip differently.
 */
const ValueListSchema = z.string().min(1).max(2048);

export const ListMemoriesQuerySchema = z.object({
  scope: RawScopeSchema.optional(),
  key: z.string().min(1).max(512).optional(),
  /**
   * Case-insensitive PREFIX match on `key` (`key ILIKE '<prefix>%'`), distinct
   * from the exact `key` above. Backs the CLI's `--key-prefix` narrowing for
   * `dedupe`/`list`: it must be applied SERVER-side so a large scope is narrowed
   * before the page/cap is reached, not row-filtered after. LIKE metacharacters
   * in the prefix are escaped by the handler, so a literal `%`/`_` stays data.
   */
  key_prefix: z.string().min(1).max(512).optional(),
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
  /**
   * Provenance and authorship filters — the dimensions the Explorer's filter
   * menu exposes beside labels (`GET /memories/facets` enumerates their values
   * with counts).
   *
   * Each is a comma-separated value list combined by its own `*_mode`
   * (`in` — the default — or `nin`), and the dimensions AND together: the
   * Linear model of "OR within a filter type, AND across filter types", which
   * is the only combination a flat filter bar can render unambiguously.
   * Anything richer (cross-type OR, nested groups) belongs in
   * `POST /memories/search`'s `filter` tree, which already expresses it.
   */
  source_agent: ValueListSchema.optional(),
  source_agent_mode: ScalarFilterModeSchema.optional().default('in'),
  trigger: ValueListSchema.optional(),
  trigger_mode: ScalarFilterModeSchema.optional().default('in'),
  /**
   * Taxonomy filters — the bucket KIND (`lesson`/`bus`/`signal`) and the owning
   * HOST. Same comma-list + `*_mode` shape as the scalar filters above, so
   * `?kind=lesson&host=reviewer` reads "reviewer's lessons".
   */
  kind: ValueListSchema.optional(),
  kind_mode: ScalarFilterModeSchema.optional().default('in'),
  host: ValueListSchema.optional(),
  host_mode: ScalarFilterModeSchema.optional().default('in'),
  origin_repo: ValueListSchema.optional(),
  origin_repo_mode: ScalarFilterModeSchema.optional().default('in'),
  origin_branch: ValueListSchema.optional(),
  origin_branch_mode: ScalarFilterModeSchema.optional().default('in'),
  /**
   * Pull-request numbers. Non-numeric entries are dropped by the handler
   * rather than 400ing the whole request: the list arrives from a hand-editable
   * URL, and one bad entry should narrow the filter, not break the page.
   */
  origin_pr: ValueListSchema.optional(),
  origin_pr_mode: ScalarFilterModeSchema.optional().default('in'),
  /**
   * Ownership filter — the literal `personal` (rows with no org) plus one value
   * per org the caller belongs to, keyed by the org SLUG (stable, unlike its
   * uuid or display name). Same comma-list + `*_mode` shape as the scalar
   * dimensions above, so `?owner=personal,acme` reads "my personal lore or
   * acme's". A slug the caller is not a member of matches nothing. This was the
   * one dimension the dashboard used to narrow CLIENT-side; it is server-side
   * now (migration 00064) so the list, the facet counts and the stat header
   * agree.
   */
  owner: ValueListSchema.optional(),
  owner_mode: ScalarFilterModeSchema.optional().default('in'),
  sort: MemorySortSchema.optional().default('updated_at'),
  archived: z.enum(['true','false']).optional().default('false'),
  /**
   * "Expiring soon": keep only memories whose TTL runs out within the next N
   * days — `expires_at` in `(now, now + N days]`.
   *
   * A RELATIVE horizon rather than an absolute `expires_before` timestamp,
   * because this parameter's job is to back a shareable, bookmarkable view.
   * "Expiring in the next 7 days" stays true tomorrow; `expires_before=<a
   * Tuesday>` silently becomes a view of the past. The bound is computed
   * per-request by `expiringWindow`, which owns the boundary semantics.
   *
   * Composes with the other filters rather than overriding them: with the
   * default `archived=false` it narrows the live rows (the only combination the
   * Explorer's Status control produces), and `archived=true` alongside it reads
   * as "archived AND expiring soon" instead of being rejected — a filter that
   * 400s on a combination the grammar can express is a worse surprise than an
   * empty page.
   *
   * Bounds mirror `TTL_MIN_DAYS`/`TTL_MAX_DAYS` (`@lorekit/mcp-core`'s `ttl.ts`)
   * and `EXPIRING_WITHIN_DAYS_MIN`/`_MAX` (`expiring-window.ts`); the literals
   * are repeated here because `@lorekit/schemas` deliberately depends on
   * nothing, exactly as `ttl_days` above already does. `expiring-window.spec.ts`
   * asserts the two agree, so the duplication cannot drift silently.
   *
   * `z.coerce` because every query param arrives as a string; `.int()` runs
   * after coercion, so `7.5` and `abc` are a 400 rather than a silent floor.
   */
  expiring_within_days: z.coerce.number().int().min(1).max(365).optional(),
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

// ── GET /memories/facets ─────────────────────────────────────────────────────

/**
 * The dimensions `GET /memories/facets` enumerates.
 *
 * These are exactly the columns `GET /memories` can filter on by value, so the
 * catalog can never offer a value the list route will not accept — the failure
 * mode a hand-maintained picker list eventually reaches.
 *
 * `tag` overlaps `GET /memories/tags` deliberately. That endpoint is the
 * single-dimension label catalog the CLI and older clients call, and removing
 * it would be a breaking change; this one answers "every filterable dimension
 * in one round trip", which is what a multi-dimension filter menu needs to
 * offer cross-type type-ahead before the user has picked a dimension. Both
 * read the same rows under the same predicate (migrations 00050 / 00052), so
 * the `tag` rows of the two responses agree by construction.
 */
export const MemoryFacetSchema = z.enum([
  'tag',
  'source_agent',
  'trigger',
  'kind',
  'host',
  'origin_repo',
  'origin_branch',
  'origin_pr',
  // Ownership (migration 00064): `personal` for org_id-null rows, else the
  // owning org's slug. Enumerated with per-value counts like every other
  // dimension, so the filter menu offers Personal / {org} with drill-down.
  'owner',
]);
export type MemoryFacet = z.infer<typeof MemoryFacetSchema>;

/**
 * Query params for `GET /memories/facets`.
 *
 * `archived` partitions for `GET /memories/tags`' reason verbatim: a catalog
 * must describe the population it will be used to filter, and active and
 * archived are different populations.
 */
export const ListFacetsQuerySchema = z.object({
  archived: z.enum(['true', 'false']).optional().default('false'),
  /**
   * Restrict the response to these dimensions (comma-separated). Absent means
   * every dimension. A menu that has already drilled into one dimension can
   * refresh just that one instead of re-reading the whole catalog.
   */
  facets: z.string().optional(),
  /**
   * The caller's CURRENTLY-APPLIED filters — the DIMENSION filters of
   * `GET /memories`, named identically so a menu CAN pass its filter state
   * verbatim. When any are present the counts become drill-down: each dimension
   * is counted with every OTHER active filter applied but not its own
   * (self-exclusion, migration 00057), so a value's count is what selecting it
   * would actually yield. Absent → the global catalog, unchanged.
   *
   * The dashboard's Explorer passes its active filter bar AND the selected
   * `scope` here (`listFacetsRequest` ← `filtersToFacetParams` plus
   * `useFacetCatalog`'s `scope`), so its filter-menu counts drill down and match
   * the scoped list. All eight dimensions — `kind` and `host` included — now
   * have a filter pill, so every facet this route can emit is one the menu can
   * act on.
   *
   * `ListMemoriesQuerySchema`'s NON-dimension filters — `q`, `key`,
   * `created_since`, `created_until` and `expiring_within_days` — are
   * deliberately NOT mirrored, so with a search, a date window or an
   * expiring-soon horizon active a count is an upper bound on the yield rather
   * than the exact figure. Mirroring `q` would mean a second implementation of
   * `likeNeedle`'s LIKE escaping inside plpgsql, and mirroring
   * `expiring_within_days` a second implementation of `expiringWindow`'s
   * `now`-relative boundary — a filter value is encoded exactly one way in this
   * repo.
   *
   * A value whose count falls to zero under the other dimensions' filters emits
   * no row at all — the same omission a null column value has — so it leaves
   * the menu until the filter is cleared.
   */
  scope: RawScopeSchema.optional(),
  tags: z.string().optional(),
  tags_mode: TagsModeSchema.optional().default('any'),
  source_agent: ValueListSchema.optional(),
  source_agent_mode: ScalarFilterModeSchema.optional().default('in'),
  trigger: ValueListSchema.optional(),
  trigger_mode: ScalarFilterModeSchema.optional().default('in'),
  kind: ValueListSchema.optional(),
  kind_mode: ScalarFilterModeSchema.optional().default('in'),
  host: ValueListSchema.optional(),
  host_mode: ScalarFilterModeSchema.optional().default('in'),
  origin_repo: ValueListSchema.optional(),
  origin_repo_mode: ScalarFilterModeSchema.optional().default('in'),
  origin_branch: ValueListSchema.optional(),
  origin_branch_mode: ScalarFilterModeSchema.optional().default('in'),
  origin_pr: ValueListSchema.optional(),
  origin_pr_mode: ScalarFilterModeSchema.optional().default('in'),
  owner: ValueListSchema.optional(),
  owner_mode: ScalarFilterModeSchema.optional().default('in'),
});
export type ListFacetsQuery = z.infer<typeof ListFacetsQuerySchema>;

/** One `(facet, value)` cell: how many visible memories carry that value. */
export const FacetValueSchema = z.object({
  facet: MemoryFacetSchema,
  value: z.string(),
  count: z.number().int().nonnegative(),
});
export type FacetValue = z.infer<typeof FacetValueSchema>;

export const FacetsResponseSchema = z.object({ facets: z.array(FacetValueSchema) });
export type FacetsResponse = z.infer<typeof FacetsResponseSchema>;

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
 *
 * `scope` + the DIMENSION filters (`tags`, `source_agent`, `trigger`, `kind`,
 * `host`, `origin_repo/branch/pr`, each with its `*_mode`) are the SAME params
 * `GET /memories` and `GET /memories/facets` take, named identically so the
 * Explorer's stat header can pass its filter bar verbatim (`filtersToQueryParams`
 * ← the one translation the list uses). They narrow the written/scopes counts so
 * the header agrees with the list beneath it (migration 00063, applying the same
 * predicate as `lorekit_memory_facets`). Absent → unfiltered, byte-for-byte the
 * pre-00063 aggregate.
 *
 * Like `ListFacetsQuery`, the NON-dimension filters — `q`, `key`,
 * `created_since/until`, `expiring_within_days` — are deliberately NOT mirrored:
 * a filter value is encoded exactly one way in this repo, and mirroring `q`
 * would mean a second `likeNeedle` inside plpgsql. So under an active SEARCH the
 * counts are an upper bound on the yield, not the exact figure — the same
 * documented caveat the facets menu carries.
 */
export const ActivityQuerySchema = z.object({
  bucket: ActivityBucketUnitSchema.optional().default('day'),
  since: TimestampFilterSchema.optional(),
  until: TimestampFilterSchema.optional(),
  scope: RawScopeSchema.optional(),
  tags: z.string().optional(),
  tags_mode: TagsModeSchema.optional().default('any'),
  source_agent: ValueListSchema.optional(),
  source_agent_mode: ScalarFilterModeSchema.optional().default('in'),
  trigger: ValueListSchema.optional(),
  trigger_mode: ScalarFilterModeSchema.optional().default('in'),
  kind: ValueListSchema.optional(),
  kind_mode: ScalarFilterModeSchema.optional().default('in'),
  host: ValueListSchema.optional(),
  host_mode: ScalarFilterModeSchema.optional().default('in'),
  origin_repo: ValueListSchema.optional(),
  origin_repo_mode: ScalarFilterModeSchema.optional().default('in'),
  origin_branch: ValueListSchema.optional(),
  origin_branch_mode: ScalarFilterModeSchema.optional().default('in'),
  origin_pr: ValueListSchema.optional(),
  origin_pr_mode: ScalarFilterModeSchema.optional().default('in'),
  owner: ValueListSchema.optional(),
  owner_mode: ScalarFilterModeSchema.optional().default('in'),
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

// ── GET /memories/read-activity ──────────────────────────────────────────────

/**
 * Query params for `GET /memories/read-activity`.
 *
 * Deliberately identical in shape to {@link ActivityQuerySchema} — the two
 * endpoints answer the same question about opposite verbs (written vs read),
 * so a caller charting both uses one set of parameters. The bucket enum is
 * REUSED rather than redeclared: a granularity admitted by one and not the
 * other would be a trap for exactly the caller rendering them side by side.
 *
 * `scope` is an optional exact-match FILTER (migration 00058). It is
 * `RawScopeSchema` (shape-only) rather than `ScopeSchema` so the canonical
 * normalisation happens once, in the handler, which can turn a rejection into a
 * 400 — the `?correlation_id=` precedent. Because the metric is additive, the
 * filtered buckets SUM to the per-scope headline; there is no separate total
 * endpoint that could drift from the bars drawn above it.
 */
export const ReadActivityQuerySchema = z.object({
  bucket: ActivityBucketUnitSchema.optional().default('day'),
  since: TimestampFilterSchema.optional(),
  until: TimestampFilterSchema.optional(),
  scope: RawScopeSchema.optional(),
});
export type ReadActivityQuery = z.infer<typeof ReadActivityQuerySchema>;

/**
 * One `(bucket, scope)` cell of read volume: how many memory RECORDS were read
 * in that UTC hour/day under that scope.
 *
 * Records, not calls — one `memory.list` returning 600 rows is one call and
 * 600 records, the same distinction `GET /memories/usage` draws between
 * `event_count` and `record_count`. Records is the additive figure a chart can
 * sum: the bars of a read sparkbar add up to "you read N memories".
 *
 * `scope` mirrors {@link ActivityBucketSchema}'s (migration 00058) but is
 * NULLABLE where the write series' is not: a write always happens under a
 * scope, while a read may carry none the server can resolve (a scope in a body
 * the router must not consume, or an ungrammatical one, both recorded as
 * unattributed rather than failing the call). Those rows are still counted in
 * the unfiltered series, so summing every bucket still gives the account total
 * — which is exactly why a per-scope total can be SMALLER than the account
 * total, and why a UI showing both should say so.
 */
/**
 * `read_kind` (migration 00080): `'targeted'` for a `memory.read` (one exact
 * scope+key), `'bulk'` for `memory.list`/`memory.search`/`memory.list_archived`
 * (every row a listing call returned) — `lorekit_read_activity`'s OWN narrow
 * 4-tool "read" definition, not the broader `READ_TOOL_NAMES` in
 * `usage-stats.ts`. Optional so a pre-00080 response (and any fixture that
 * predates the split) still typechecks.
 */
export const ReadKindSchema = z.enum(['targeted', 'bulk']);
export type ReadKind = z.infer<typeof ReadKindSchema>;

export const ReadActivityBucketSchema = z.object({
  bucket: z.string(),
  scope: z.string().nullable(),
  read_kind: ReadKindSchema.optional(),
  count: z.number().int().nonnegative(),
});
export type ReadActivityBucket = z.infer<typeof ReadActivityBucketSchema>;

export const ReadActivityResponseSchema = z.object({
  bucket: ActivityBucketUnitSchema,
  since: z.string(),
  until: z.string(),
  buckets: z.array(ReadActivityBucketSchema),
});
export type ReadActivityResponse = z.infer<typeof ReadActivityResponseSchema>;

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
  // Taxonomy. Optional/nullable so a row written before 00056 (NULL kind/host)
  // and an older client that reads neither are both unaffected.
  kind: z.string().nullable().optional(), host: z.string().nullable().optional(),
  // Recurrence — how many times this lesson has been written (00059). The
  // column is NOT NULL DEFAULT 1, so a live row always has >= 1; optional here
  // for the same reason kind/host are, so a client reading a response from a
  // backend deployed before 00059 is unaffected. Optional but NOT nullable,
  // unlike the neighbours above: those mirror genuinely nullable columns,
  // whereas a read of this one yields a number or omits the field entirely —
  // there is no null for the schema to admit.
  seen_count: z.number().int().optional(),
  // Consumption — how many times this memory has actually been READ back
  // (migration 00077), the read-to-write counterpart to seen_count above.
  // `read_count` is NOT NULL DEFAULT 0 at the DB level (every row has a real,
  // countable value), but optional here for the same backward-compat reason
  // as seen_count: a client reading a response from a backend deployed before
  // 00077 sees no field rather than a fabricated 0. `last_read_at` mirrors the
  // genuinely nullable column (a never-read-since-00077 memory has none).
  read_count: z.number().int().nonnegative().optional(),
  last_read_at: z.string().datetime().nullable().optional(),
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
  + 'origin_repo,origin_branch,origin_commit,origin_pr,kind,host,seen_count,'
  + 'read_count,last_read_at,'
  + 'org_id,created_by,updated_by,orgs(id,name,slug)';

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

// ── The body transport: POST /memories/list, /facets, /activity ──────────────

/**
 * How many values ONE dimension may carry in a body request.
 *
 * A safety limit, not a product limit: it is ~50x the widest filter bar the
 * Explorer has produced, and roughly 20x what the query transport could carry
 * before `ValueListSchema`'s 2048-character cap rejected the request. It exists
 * so an unbounded array cannot be used to make the server build an unbounded
 * PostgREST `in.()` operand — the reason the bound is a COUNT and not another
 * character budget is that a count is the thing a caller can reason about,
 * where "2048 characters" silently means a different number of hosts than of
 * branches.
 */
export const FILTER_VALUES_MAX = 1000;

/** How long ONE filter value may be — the `key` bound, applied to a filter. */
export const FILTER_VALUE_MAX_CHARS = 512;

/**
 * One dimension's values, as a real array.
 *
 * This is the whole point of the body transport. The query form joins the
 * values with commas into a single `ValueListSchema` string, which caps the
 * DIMENSION at 2048 characters and makes a value containing a comma
 * unreachable (`parseTagsParam` splits before anything is quoted). An array has
 * neither property: each value is bounded on its own, the dimension is bounded
 * by a count, and a comma is just a character.
 */
const DimensionValuesSchema = z
  .array(z.string().min(1).max(FILTER_VALUE_MAX_CHARS))
  .max(FILTER_VALUES_MAX);

/**
 * The dimension filters, shared verbatim by all three body routes.
 *
 * Named identically to the query params they replace — `tags`, `host`,
 * `origin_pr`, each with its `*_mode` — so the two transports are the same
 * contract in two encodings, and `handleList` / `handleListPost` can hand the
 * SAME normalised shape to the SAME predicate function (`dimensionsFromQuery` /
 * `dimensionsFromBody`). A field that existed on only one of them would be a
 * place for the two to disagree about what a filter means.
 */
const dimensionBodyFields = {
  tags: DimensionValuesSchema.optional(),
  tags_mode: TagsModeSchema.optional().default('any'),
  source_agent: DimensionValuesSchema.optional(),
  source_agent_mode: ScalarFilterModeSchema.optional().default('in'),
  trigger: DimensionValuesSchema.optional(),
  trigger_mode: ScalarFilterModeSchema.optional().default('in'),
  kind: DimensionValuesSchema.optional(),
  kind_mode: ScalarFilterModeSchema.optional().default('in'),
  host: DimensionValuesSchema.optional(),
  host_mode: ScalarFilterModeSchema.optional().default('in'),
  origin_repo: DimensionValuesSchema.optional(),
  origin_repo_mode: ScalarFilterModeSchema.optional().default('in'),
  origin_branch: DimensionValuesSchema.optional(),
  origin_branch_mode: ScalarFilterModeSchema.optional().default('in'),
  /**
   * Pull-request numbers. Still tolerant of a non-numeric entry for the query
   * form's reason — the bar can be built from a hand-editable URL — so the
   * handler drops those rather than 400ing the page.
   */
  origin_pr: DimensionValuesSchema.optional(),
  origin_pr_mode: ScalarFilterModeSchema.optional().default('in'),
  owner: DimensionValuesSchema.optional(),
  owner_mode: ScalarFilterModeSchema.optional().default('in'),
} as const;

/**
 * `POST /memories/list` — the same read as `GET /memories`, over a body.
 *
 * The dashboard's Explorer sends this one. The query form remains supported and
 * unchanged for the CLI, the MCP surface and any API-token caller; it is simply
 * not a transport that scales, because a filter bar's value sets are unbounded
 * (agents invent hosts) while a URL is not.
 *
 * The non-dimension fields take their REAL JSON types — `archived` is a
 * boolean, `limit` a number — instead of the coerced strings a query string
 * forces. That is deliberate: over JSON, `"true"` is a string, and silently
 * accepting it would make the two transports disagree about what a caller sent.
 */
export const ListMemoriesBodySchema = z.object({
  scope: RawScopeSchema.optional(),
  key: z.string().min(1).max(512).optional(),
  key_prefix: z.string().min(1).max(512).optional(),
  q: z.string().min(1).max(512).optional(),
  created_since: TimestampFilterSchema.optional(),
  created_until: TimestampFilterSchema.optional(),
  ...dimensionBodyFields,
  sort: MemorySortSchema.optional().default('updated_at'),
  archived: z.boolean().optional().default(false),
  expiring_within_days: z.number().int().min(1).max(365).optional(),
  limit: z.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
});
export type ListMemoriesBody = z.infer<typeof ListMemoriesBodySchema>;

/**
 * `POST /memories/facets` — the drill-down catalog, over a body.
 *
 * Mirrors `ListFacetsQuerySchema` field for field, with `facets` as an array of
 * the closed facet vocabulary rather than a comma list. An unknown NAME cannot
 * arrive here at all (the enum rejects it), where the query form tolerated one
 * and narrowed to nothing — a JSON client builds this from `MemoryFacet`, so a
 * typo is a bug worth surfacing rather than a keystroke to survive.
 */
export const ListFacetsBodySchema = z.object({
  archived: z.boolean().optional().default(false),
  facets: z.array(MemoryFacetSchema).optional(),
  scope: RawScopeSchema.optional(),
  ...dimensionBodyFields,
});
export type ListFacetsBody = z.infer<typeof ListFacetsBodySchema>;

/** `POST /memories/activity` — the written-volume series, over a body. */
export const ActivityBodySchema = z.object({
  bucket: ActivityBucketUnitSchema.optional().default('day'),
  since: TimestampFilterSchema.optional(),
  until: TimestampFilterSchema.optional(),
  scope: RawScopeSchema.optional(),
  ...dimensionBodyFields,
});
export type ActivityBody = z.infer<typeof ActivityBodySchema>;

/**
 * `GET /memories/read-ranking` — memories ranked by how often they have
 * actually been READ (migration 00077's `memories.read_count`), not written.
 * `hot` (default) surfaces the most-consumed lore; `cold` surfaces the
 * least-consumed — the prune-list input the `lorekit-groom` skill exists to
 * consume. REST-only (`telemetry-vocabulary.ts`'s `NON_CATALOG_OPS`): the
 * response names individual scopes, the same scope-leak surface as
 * `memory.tags`/`memory.facets`, for the same absent agent-side demand —
 * dashboard analytics, not an agent primitive.
 */
export const ReadRankingDirectionSchema = z.enum(['hot', 'cold']);
export type ReadRankingDirection = z.infer<typeof ReadRankingDirectionSchema>;
export const ReadRankingQuerySchema = z.object({
  direction: ReadRankingDirectionSchema.optional().default('hot'),
  scope: RawScopeSchema.optional(),
  // `z.coerce` because this is a QUERY schema — `validateQuery` feeds it
  // `Object.fromEntries(searchParams)`, where every value is a string. A bare
  // `z.number()` here 400s (`Expected number, received string`) on every
  // caller that passes the param at all, which is what silently blanked the
  // Insights page's Hot & Cold panel: the request never reached the RPC.
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});
export type ReadRankingQuery = z.infer<typeof ReadRankingQuerySchema>;

/**
 * One ranked row. `read_count`/`last_read_at` are the counters this ranking
 * exists to expose; `seen_count` rides along so the dashboard can show the
 * read-to-write ratio (written once and read 200 times vs. written 16 times
 * and never read) without a second round trip.
 */
export const ReadRankingEntrySchema = z.object({
  id: z.string().uuid(),
  scope: z.string(),
  key: z.string(),
  read_count: z.number().int().nonnegative(),
  last_read_at: z.string().datetime().nullable(),
  seen_count: z.number().int().optional(),
  created_at: z.string().datetime(),
});
export type ReadRankingEntry = z.infer<typeof ReadRankingEntrySchema>;

export const ReadRankingResponseSchema = z.object({
  direction: ReadRankingDirectionSchema,
  /**
   * The date counting started (migration 00077's deployment). A `cold` row
   * with `read_count: 0` means "not read SINCE this date", never "never read
   * in this memory's lifetime" — a memory created before it may have been
   * read plenty under the old, uncounted regime. Every consumer MUST render
   * this qualifier rather than the bare word "never".
   */
  counting_since: z.string().datetime(),
  entries: z.array(ReadRankingEntrySchema),
});
export type ReadRankingResponse = z.infer<typeof ReadRankingResponseSchema>;
