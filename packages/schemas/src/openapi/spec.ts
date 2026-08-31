// deno-lint-ignore-file
import { z } from 'zod';
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

// zod-to-openapi v7 attaches `.openapi()` to ZodType.prototype. Without this call
// every `registry.register()` throws `zodSchema.openapi is not a function`, which is
// what made GET /functions/v1/openapi return 500 from the day it shipped. The patch is
// applied here (the only module that talks to zod-to-openapi) so the runtime schema
// files stay free of any OpenAPI dependency — the edge functions that import them do
// not pull zod-to-openapi into their bundle.
extendZodWithOpenApi(z);

import {
  MemoryEntrySchema,
  MemoryPageResponseSchema,
  CreateMemoryBodySchema,
  UpdateMemoryBodySchema,
  SearchMemoriesBodySchema,
  ListMemoriesQuerySchema,
  DeleteMemoryQuerySchema,
  RestoreMemoryBodySchema,
  PurgeMemoriesBodySchema,
  RestoreResponseSchema,
  PurgeResponseSchema,
  ScopesResponseSchema,
  ListTagsQuerySchema,
  TagsResponseSchema,
  ListFacetsQuerySchema,
  FacetsResponseSchema,
  PivotBodySchema,
  PivotQuerySchema,
  PivotResponseSchema,
  ActivityQuerySchema,
  ActivityResponseSchema,
  ListMemoriesBodySchema,
  ListFacetsBodySchema,
  ActivityBodySchema,
  ReadActivityQuerySchema,
  ReadActivityResponseSchema,
  ReadRankingQuerySchema,
  ReadRankingResponseSchema,
  ClustersQuerySchema,
  ClustersResponseSchema,
} from '../domain/memory.ts';
import {
  OrgResponseSchema,
  OrgListResponseSchema,
  CreateOrgBodySchema,
  RenameOrgBodySchema,
} from '../domain/org.ts';
import {
  OrgMemberSchema,
  OrgMemberListResponseSchema,
  UpdateMemberRoleBodySchema,
} from '../domain/member.ts';
import {
  OrgInviteSchema,
  OrgInviteListResponseSchema,
  CreateInviteBodySchema,
} from '../domain/invite.ts';
import {
  ErrorResponseSchema,
  MemoryIdParamsSchema,
  OrgSlugParamsSchema,
  OrgSlugMemberParamsSchema,
  OrgSlugInviteParamsSchema,
} from '../shared/common.ts';
import {
  UsageStatsQuerySchema,
  UsageStatsResponseSchema,
  UsageRunsQuerySchema,
  UsageRunsResponseSchema,
} from '../domain/usage.ts';
import {
  RelevantQuerySchema,
  RelevantResponseSchema,
} from '../shared/relevant.ts';
import {
  GetBlogLikesQuerySchema,
  LikeBlogBodySchema,
  BlogLikesResponseSchema,
} from '../domain/blog.ts';

let _cachedSpec: Record<string, unknown> | null = null;

// `FilterGroupSchema` is a `z.lazy()` recursive union, which zod-to-openapi cannot
// introspect ("Unknown zod object type"). Document it as a free-form object with an
// example instead of duplicating the search body: the doc schema is DERIVED from the
// runtime one (`.innerType()` unwraps the `.refine()` wrapper), so any field added to
// `SearchMemoriesBodySchema` shows up here automatically — only `filter` is overridden.
const FilterGroupDocSchema = z.record(z.unknown()).openapi({
  type: 'object',
  description:
    'Recursive filter tree. Either a condition `{ field, op, value }` or a group ' +
    '`{ and: [...] }` / `{ or: [...] }`, nestable to any depth. ' +
    'Operators: is, is_not, contains, does_not_contain, starts_with, ends_with, is_set, is_not_set.',
  example: {
    and: [
      { field: 'scope', op: 'is', value: 'global' },
      { or: [{ field: 'key', op: 'contains', value: 'auth' }, { field: 'tags', op: 'contains', value: 'ci' }] },
    ],
  },
});

const SearchMemoriesBodyDocSchema = SearchMemoriesBodySchema.innerType().extend({
  filter: FilterGroupDocSchema.optional(),
});

export function generateSpec(baseUrl = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1'): Record<string, unknown> {
  if (_cachedSpec) return _cachedSpec;

  const registry = new OpenAPIRegistry();

  // Register all schemas so they appear as $ref components in the spec.
  // Every schema used in a path must be registered here first.
  registry.register('Memory', MemoryEntrySchema);
  registry.register('MemoryPage', MemoryPageResponseSchema);
  registry.register('CreateMemoryBody', CreateMemoryBodySchema);
  registry.register('UpdateMemoryBody', UpdateMemoryBodySchema);
  registry.register('SearchMemoriesBody', SearchMemoriesBodyDocSchema);
  registry.register('ListMemoriesBody', ListMemoriesBodySchema);
  registry.register('ListFacetsBody', ListFacetsBodySchema);
  registry.register('ActivityBody', ActivityBodySchema);
  registry.register('RestoreMemoryBody', RestoreMemoryBodySchema);
  registry.register('PurgeMemoriesBody', PurgeMemoriesBodySchema);
  registry.register('RestoreResponse', RestoreResponseSchema);
  registry.register('PurgeResponse', PurgeResponseSchema);
  registry.register('ScopesResponse', ScopesResponseSchema);
  registry.register('UsageStatsResponse', UsageStatsResponseSchema);
  registry.register('Org', OrgResponseSchema);
  registry.register('OrgList', OrgListResponseSchema);
  registry.register('CreateOrgBody', CreateOrgBodySchema);
  registry.register('RenameOrgBody', RenameOrgBodySchema);
  registry.register('OrgMember', OrgMemberSchema);
  registry.register('OrgMemberList', OrgMemberListResponseSchema);
  registry.register('UpdateMemberRoleBody', UpdateMemberRoleBodySchema);
  registry.register('OrgInvite', OrgInviteSchema);
  registry.register('OrgInviteList', OrgInviteListResponseSchema);
  registry.register('CreateInviteBody', CreateInviteBodySchema);
  registry.register('BlogLikes', BlogLikesResponseSchema);
  registry.register('Error', ErrorResponseSchema);

  const bearerAuth = registry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'LoreKit API token (lk_rw_*, lk_ro_*, lk_wo_*) or Supabase JWT. Every route — memories and orgs alike — accepts either; access is gated by the token read/write permission, not by auth tier.',
  });

  const security = [{ [bearerAuth.name]: [] }];

  const errorResponse = {
    description: 'Error',
    content: { 'application/json': { schema: ErrorResponseSchema } },
  };
  const memoryResponse = (desc: string) => ({
    description: desc,
    content: { 'application/json': { schema: MemoryEntrySchema } },
  });
  const memoryPageResponse = (desc: string) => ({
    description: desc,
    content: { 'application/json': { schema: MemoryPageResponseSchema } },
  });
  const restoreResponse = {
    description: 'Restored',
    content: { 'application/json': { schema: RestoreResponseSchema } },
  };
  const purgeResponse = {
    description: 'Number of memories hard-deleted',
    content: { 'application/json': { schema: PurgeResponseSchema } },
  };

  // ── Memories ──────────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get', path: '/memories', summary: 'List memories', tags: ['Memories'],
    description:
      'Lists live memories by default. Filters AND across dimensions and OR within one, so ' +
      '`?kind=lesson&host=reviewer` reads "reviewer\'s lessons".\n\n' +
      '`expiring_within_days=N` narrows to lore whose TTL runs out soon — `expires_at` strictly ' +
      'after now and at or before now + N days. The lower bound is exclusive because that is what ' +
      '"still live" means everywhere else in the API (an already-expired memory is never returned); ' +
      'the upper bound is inclusive, so "within 7 days" includes one expiring exactly 7 days out. ' +
      'Memories with no TTL are never in the result. It is a RELATIVE horizon rather than an ' +
      'absolute timestamp so a saved or shared link keeps answering the same question tomorrow.\n\n' +
      'An invalid `scope` is a `400`, not a silently ignored filter — a scope filter is the ' +
      'question being asked, so an ungrammatical one is rejected rather than matched against ' +
      'nothing and reported as an empty page. The value is validated, never normalised: the ' +
      'write path stores `scope` verbatim, so the filter matches exactly what was written.',
    security, request: { query: ListMemoriesQuerySchema },
    responses: {
      200: memoryPageResponse('Paginated memories'),
      // Reachable for any out-of-range query param (`limit`, `expiring_within_days`)
      // and for an ungrammatical `scope`. It always was for the former — the spec
      // simply never said so; the latter arrived with the scope-filter validation.
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  // ── The body transport ──────────────────────────────────────────────────
  // `POST /memories/list`, `/memories/facets` and `/memories/activity` are the
  // three GET reads above in another encoding, for the one caller the query
  // string cannot serve: a filter bar whose value sets are unbounded. Each
  // dimension is a real array bounded by a COUNT (1000 values of 512
  // characters) instead of `ValueListSchema`'s 2048-character-per-dimension
  // cap, and a value containing a comma is reachable because nothing splits on
  // one. The GET forms stay fully supported and unchanged.
  const bodyTransportNote =
    '\n\nThe BODY form of the read above, for callers whose filters do not fit a URL. ' +
    'Every dimension is a real array (`{"host": ["reviewer", "aw"], "host_mode": "in"}`) ' +
    'bounded at 1000 values of 512 characters each, where the query form caps a dimension ' +
    'at 2048 characters and splits every value on a comma. Both transports decode to ONE ' +
    'normalised filter shape server-side, so they return the same rows and report under the ' +
    'same usage tool name — this is a transport choice and nothing else. The body is optional: ' +
    'a bodiless request is the unfiltered read.';
  registry.registerPath({
    method: 'post', path: '/memories/list', summary: 'List memories (filters in a JSON body)',
    tags: ['Memories'],
    description: 'The same read as `GET /memories`.' + bodyTransportNote,
    security, request: { body: { content: { 'application/json': { schema: ListMemoriesBodySchema } } } },
    responses: {
      200: memoryPageResponse('Paginated memories'),
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'post', path: '/memories', summary: 'Create or update a memory', tags: ['Memories'],
    security, request: { body: { content: { 'application/json': { schema: CreateMemoryBodySchema } } } },
    responses: { 201: memoryResponse('Created'), 400: errorResponse, 401: errorResponse, 429: errorResponse },
  });
  registry.registerPath({
    method: 'post', path: '/memories/search', summary: 'Search memories with OR+AND filtering', tags: ['Memories'],
    security, request: { body: { content: { 'application/json': { schema: SearchMemoriesBodyDocSchema } } } },
    responses: { 200: memoryPageResponse('Search results'), 400: errorResponse, 401: errorResponse },
  });
  registry.registerPath({
    method: 'delete', path: '/memories',
    summary: 'Archive (or, with force=true, hard-delete) a memory by scope+key; ?org=<slug> targets org-owned lore', tags: ['Memories'],
    description: 'An invalid `scope` is a `400`, not a `404` — a bad scope is bad input, not a missing memory.',
    security, request: { query: DeleteMemoryQuerySchema },
    responses: { 204: { description: 'Archived or deleted' }, 400: errorResponse, 401: errorResponse, 403: errorResponse, 404: errorResponse },
  });
  registry.registerPath({
    method: 'post', path: '/memories/restore', summary: 'Restore an archived memory by scope+key', tags: ['Memories'],
    description: 'An invalid `scope` is a `400`, not a `404` — a bad scope is bad input, not a missing memory.',
    security, request: { body: { content: { 'application/json': { schema: RestoreMemoryBodySchema } } } },
    responses: { 200: restoreResponse, 400: errorResponse, 401: errorResponse, 404: errorResponse },
  });
  registry.registerPath({
    method: 'post', path: '/memories/purge',
    summary: 'Hard-delete archived memories older than retention_days', tags: ['Memories'],
    security, request: { body: { content: { 'application/json': { schema: PurgeMemoriesBodySchema } } } },
    responses: { 200: purgeResponse, 400: errorResponse, 401: errorResponse, 403: errorResponse, 429: errorResponse },
  });
  registry.registerPath({
    method: 'post', path: '/memories/purge-expired', summary: 'Hard-delete memories whose TTL has elapsed', tags: ['Memories'],
    security,
    responses: { 200: purgeResponse, 401: errorResponse, 403: errorResponse, 429: errorResponse },
  });
  registry.registerPath({
    method: 'get', path: '/memories/scopes',
    summary: 'List every visible scope with its active memory count', tags: ['Memories'],
    security,
    responses: {
      200: { description: 'Scopes', content: { 'application/json': { schema: ScopesResponseSchema } } },
      401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'get', path: '/memories/tags',
    summary: 'List every visible label with how many memories carry it', tags: ['Memories'],
    security, request: { query: ListTagsQuerySchema },
    responses: {
      200: { description: 'Labels', content: { 'application/json': { schema: TagsResponseSchema } } },
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'get', path: '/memories/facets',
    summary: 'List every filterable value (label, agent, trigger, repo, branch, pull request) with its memory count',
    tags: ['Memories'],
    description: 'An invalid `scope` is a `400`, not a silently ignored filter — the menu counts and the list they drill into agree on what a scope is.',
    security, request: { query: ListFacetsQuerySchema },
    responses: {
      200: { description: 'Facet values', content: { 'application/json': { schema: FacetsResponseSchema } } },
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'post', path: '/memories/facets',
    summary: 'List every filterable value with its memory count (filters in a JSON body)',
    tags: ['Memories'],
    description:
      'The same drill-down catalog as `GET /memories/facets`. `facets` is an array of the ' +
      'closed facet vocabulary rather than a comma list, so an unknown name is a `400` here ' +
      'where the query form tolerated one and narrowed to nothing.' + bodyTransportNote,
    security, request: { body: { content: { 'application/json': { schema: ListFacetsBodySchema } } } },
    responses: {
      200: { description: 'Facet values', content: { 'application/json': { schema: FacetsResponseSchema } } },
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'get', path: '/memories/pivot',
    summary: 'Cross-tabulate two filterable dimensions and count the memories in each cell',
    tags: ['Memories'],
    description:
      '`GET /memories/facets` with a second group-by. `row` and `col` name any two of the ' +
      'facet dimensions (they may be the same, giving that dimension’s diagonal). ' +
      '**Both axes are self-excluded from the filters**, so a caller that turns a cell into ' +
      '`row in [x] AND col in [y]` and asks again still gets every other cell back — that ' +
      'is what keeps a drilled-in grid navigable instead of collapsing to the clicked cell. ' +
      'A pair counting zero emits no cell. `truncated` reports whether `limit` cut the grid.',
    security, request: { query: PivotQuerySchema },
    responses: {
      200: { description: 'Pivot cells', content: { 'application/json': { schema: PivotResponseSchema } } },
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'post', path: '/memories/pivot',
    summary: 'Cross-tabulate two dimensions (filters in a JSON body)', tags: ['Memories'],
    description: 'The same cross-tabulation as `GET /memories/pivot`.' + bodyTransportNote,
    security, request: { body: { content: { 'application/json': { schema: PivotBodySchema } } } },
    responses: {
      200: { description: 'Pivot cells', content: { 'application/json': { schema: PivotResponseSchema } } },
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'get', path: '/memories/activity',
    summary: 'Memories created per UTC hour/day per scope over a window', tags: ['Memories'],
    description: 'An invalid `scope` is a `400`, not a silently ignored filter — the same rule the read counterpart `GET /memories/read-activity` follows.',
    security, request: { query: ActivityQuerySchema },
    responses: {
      200: { description: 'Activity buckets', content: { 'application/json': { schema: ActivityResponseSchema } } },
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'post', path: '/memories/activity',
    summary: 'Memories created per UTC hour/day per scope over a window (filters in a JSON body)',
    tags: ['Memories'],
    description: 'The same series as `GET /memories/activity`.' + bodyTransportNote,
    security, request: { body: { content: { 'application/json': { schema: ActivityBodySchema } } } },
    responses: {
      200: { description: 'Activity buckets', content: { 'application/json': { schema: ActivityResponseSchema } } },
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'get', path: '/memories/read-activity',
    summary: 'Memory records read per UTC hour/day over a window', tags: ['Memories'],
    description:
      'Records read (not read *calls*) per bucket, summed over `memory.read` / `memory.list` / ' +
      '`memory.search` / `memory.list_archived`. Calls that identified themselves as the LoreKit ' +
      'dashboard (`X-LoreKit-Client: dashboard`) are EXCLUDED: browsing your own lore in the web UI ' +
      'is visualisation, not consumption, and would otherwise make this series grow every time you ' +
      'looked at it. `GET /memories/usage` still counts them — use it for the complete ledger.\n\n' +
      'Buckets are returned one per `(bucket, scope, read_kind)` cell, mirroring `GET /memories/activity`. ' +
      '`scope` is nullable: a read whose scope the server could not resolve (carried in a request ' +
      'body, or ungrammatical) is recorded as unattributed rather than dropped, so it still counts ' +
      'toward the unfiltered total. Pass the optional `scope` query parameter to restrict the ' +
      'series to one exact scope; because the metric is additive, those buckets SUM to the ' +
      'per-scope headline. That per-scope total can legitimately be SMALLER than the account ' +
      'total — the difference is the unattributable reads. An invalid `scope` is a `400`, not a ' +
      'silently ignored filter.\n\n' +
      '`read_kind` (migration 00080) splits retrieved from opened: `\'targeted\'` is `memory.read` ' +
      '(one exact scope+key — an agent deliberately opening a specific lesson); `\'bulk\'` is ' +
      '`memory.list`/`memory.search`/`memory.list_archived` (every row a listing call returned, ' +
      'e.g. a session-start hook injecting lessons). Retrieved + opened sum to the same total this ' +
      'endpoint always returned — the split refines the series, it does not change it.',
    security, request: { query: ReadActivityQuerySchema },
    responses: {
      200: { description: 'Read-activity buckets', content: { 'application/json': { schema: ReadActivityResponseSchema } } },
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'get', path: '/memories/read-ranking',
    summary: 'Memories ranked by how often they have actually been read (hot or cold lore)',
    tags: ['Memories'],
    description:
      'Ranks memories by `read_count` (migration 00077) — how many times a `memory.read` / ' +
      '`memory.list` / `memory.search` / `memory.list_archived` call actually returned this ' +
      'exact row, not just how often the account read *something*. `direction=hot` (default) ' +
      'surfaces the most-consumed lore first; `direction=cold` surfaces the least, oldest-created ' +
      'first among ties — the prune-list input the `lorekit-groom` skill consumes.\n\n' +
      '`counting_since` is the date this counter started: a `cold` row with `read_count: 0` means ' +
      '"not read since that date", never "never read" — a memory written earlier may have been ' +
      'read plenty under the old, uncounted regime. Render the qualifier; never the bare word ' +
      '"never". `seen_count` (how many times the memory has been WRITTEN) rides along so a reader ' +
      'can compare consumption against recurrence in one response. Active memories only ' +
      '(archived/expired rows are excluded — they are already pruned). An invalid `scope` is a ' +
      '`400`, not a silently ignored filter.',
    security, request: { query: ReadRankingQuerySchema },
    responses: {
      200: { description: 'Ranked memories', content: { 'application/json': { schema: ReadRankingResponseSchema } } },
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'get', path: '/memories/clusters',
    summary: 'Groups of near-duplicate memories, ranked as merge candidates (read-only)',
    tags: ['Memories'],
    description:
      'Clusters the caller\'s recent lore by Jaccard similarity over tokenized bodies and returns ' +
      'each group with its member count, its similarity RANGE (`min_similarity`/`max_similarity` — ' +
      'a cluster is built transitively, so two members can sit below `threshold` and still share ' +
      'one) and, when the member keys match a known recurrence class, that class plus whether the ' +
      'match is `pure` (every member matched, nothing else joined). Ordering is by score: summed ' +
      '`seen_count` first, then size, then similarity — "which redundancy has cost the most".\n\n' +
      '**Read-only is the contract, not a phase.** Deciding that N near-duplicate lessons are ' +
      'really one entry is a human judgment, so there is deliberately no merge counterpart and no ' +
      'parameter that makes this route act. It surfaces and ranks the evidence and stops.\n\n' +
      '**It answers a WINDOWED question.** Candidates are cut at a server-side cap in ' +
      '`updated_at desc` order *before* clustering, so `candidates` saturating at that cap means ' +
      'the answer is "what have I recently written that duplicates something else recent", not ' +
      '"what are all the duplicates in my store". `lorekit dedupe` streams the whole scope through ' +
      'the identical clustering core and is the answer to the second question.\n\n' +
      'Member bodies are never returned — only `hook`, the first line — for the same reason ' +
      '`GET /memories/relevant` returns none: the point is deciding which lessons to look at. ' +
      'An invalid `scope` is a `400`, not a silently ignored filter.',
    security, request: { query: ClustersQuerySchema },
    responses: {
      200: { description: 'Ranked duplicate clusters', content: { 'application/json': { schema: ClustersResponseSchema } } },
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'get', path: '/memories/relevant',
    summary: 'Top-K lessons ranked for a query — the shortlist, not the whole match set', tags: ['Memories'],
    description:
      'The one verb that RANKS. Every other read returns a single-signal ordering — ' +
      '`GET /memories` is `updated_at` desc, `POST /memories/search` is FTS rank — so a caller ' +
      'wanting a useful shortlist had to fetch a page and re-sort it, and every client that did ' +
      'so disagreed with the others. Here the score combines RECENCY (exponential decay, 14-day ' +
      'half-life), SALIENCE (`log1p(seen_count)` normalised across the candidates, so a lesson ' +
      'learned twelve times outranks one written once) and RELEVANCE (full-text match on `q`). ' +
      'The response is a compact index — scope, key, a one-line hook and the score — because the ' +
      'point is deciding WHICH few lessons deserve a reader\'s attention; fetch the bodies with ' +
      '`GET /memories/:id` or `memory.read`. `q` is optional: without it the ranking is recency + ' +
      'salience, which answers "what matters generally" rather than "what matters for this". ' +
      '`scopes` is ordered most-specific first and that order breaks ties, so a project lesson ' +
      'wins over the global one it ties with.',
    security, request: { query: RelevantQuerySchema },
    responses: {
      200: { description: 'Ranked lessons', content: { 'application/json': { schema: RelevantResponseSchema } } },
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'get', path: '/memories/usage',
    summary: 'Aggregate usage statistics for your own activity (reads, writes, outcomes, per scope-type) over an optional period',
    tags: ['Memories'],
    description:
      '`by_tool` rows are grouped by `(tool_name, outcome, scope_type, client, kind, host)` ' +
      '(migration 00079 added the last three). `client` is which surface called ' +
      '(`dashboard`/`cli`/`mcp`/`api`); `kind`/`host` are the memory taxonomy family/owner. ' +
      '`host` is bounded to this window\'s own top 20 by event count — anything else is the ' +
      'literal `\'other\'`, never an unbounded free-text value. `scope_type` may carry a legacy ' +
      'free-text value predating validation hardening; group by it defensively rather than ' +
      'assuming the closed `global|project|repo|branch|mixed|invalid` vocabulary is exhaustive.\n\n' +
      '`summary.peak_memory_count` (migration 00081) is the highest active-memory-count snapshot ' +
      'taken on a write event in this window — "how full WAS this account", distinct from the ' +
      '`/settings/plan` page\'s existing LIVE count. `null` when the window has no write events. ' +
      'No plan limit accompanies it; pair it with your own limit reading.',
    security, request: { query: UsageStatsQuerySchema },
    responses: {
      200: { description: 'Usage statistics', content: { 'application/json': { schema: UsageStatsResponseSchema } } },
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'get', path: '/memories/usage/runs',
    summary: 'Enumerate runs (correlation_id values) with what each one read, wrote, and touched',
    tags: ['Memories'],
    description:
      'The payoff view for `?correlation_id=` on `GET /memories/usage`: that filters TO one run, ' +
      'this is how you discover which ones exist. Each run is a distinct `correlation_id` — a ' +
      'local session, a CI job, or a PR automation (`session_kind`, migration 00082) — with its ' +
      'first/last-seen timestamps, read/write event and record counts (the SAME broader ' +
      '`READ_TOOL_NAMES`/`WRITE_TOOL_NAMES` vocabulary `summarizeUsageRows` uses for `/usage`\'s ' +
      'own summary, not `GET /memories/read-activity`\'s narrower 4-tool definition), distinct ' +
      'scopes touched, and total duration.\n\n' +
      'Keyset-paginated (`cursor`/`next_cursor`), never OFFSET. `range` echoes the window actually ' +
      'queried — an unbounded request is narrowed to 90 days server-side and captioned here rather ' +
      'than silently answering less than "all time" implies.',
    security, request: { query: UsageRunsQuerySchema },
    responses: {
      200: { description: 'Runs page', content: { 'application/json': { schema: UsageRunsResponseSchema } } },
      400: errorResponse, 401: errorResponse, 403: errorResponse,
    },
  });
  registry.registerPath({
    method: 'get', path: '/memories/{id}', summary: 'Get memory by ID', tags: ['Memories'],
    security, request: { params: MemoryIdParamsSchema },
    responses: { 200: memoryResponse('Memory'), 404: errorResponse, 401: errorResponse },
  });
  registry.registerPath({
    method: 'patch', path: '/memories/{id}', summary: 'Update a memory', tags: ['Memories'],
    security,
    request: {
      params: MemoryIdParamsSchema,
      body: { content: { 'application/json': { schema: UpdateMemoryBodySchema } } },
    },
    responses: { 200: memoryResponse('Updated memory'), 400: errorResponse, 404: errorResponse, 401: errorResponse },
  });
  registry.registerPath({
    method: 'delete', path: '/memories/{id}',
    summary: 'Archive a memory (soft-delete), or hard-delete it with force=true', tags: ['Memories'],
    security, request: { params: MemoryIdParamsSchema, query: DeleteMemoryQuerySchema },
    responses: { 204: { description: 'Archived or deleted' }, 404: errorResponse, 401: errorResponse },
  });
  registry.registerPath({
    method: 'post', path: '/memories/{id}/restore', summary: 'Restore an archived memory by ID', tags: ['Memories'],
    security, request: { params: MemoryIdParamsSchema },
    responses: { 200: restoreResponse, 400: errorResponse, 401: errorResponse, 404: errorResponse },
  });

  // ── Orgs ─────────────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get', path: '/orgs', summary: 'List my organizations', tags: ['Orgs'],
    security,
    responses: { 200: { description: 'Orgs', content: { 'application/json': { schema: OrgListResponseSchema } } }, 401: errorResponse },
  });
  registry.registerPath({
    method: 'post', path: '/orgs', summary: 'Create an organization', tags: ['Orgs'],
    security, request: { body: { content: { 'application/json': { schema: CreateOrgBodySchema } } } },
    responses: { 201: { description: 'Created org', content: { 'application/json': { schema: OrgResponseSchema } } }, 400: errorResponse, 401: errorResponse, 403: errorResponse },
  });
  registry.registerPath({
    method: 'get', path: '/orgs/{slug}', summary: 'Get organization', tags: ['Orgs'],
    security, request: { params: OrgSlugParamsSchema },
    responses: { 200: { description: 'Org', content: { 'application/json': { schema: OrgResponseSchema } } }, 404: errorResponse, 401: errorResponse },
  });
  registry.registerPath({
    method: 'patch', path: '/orgs/{slug}', summary: 'Rename organization', tags: ['Orgs'],
    security,
    request: { params: OrgSlugParamsSchema, body: { content: { 'application/json': { schema: RenameOrgBodySchema } } } },
    responses: { 200: { description: 'Updated org', content: { 'application/json': { schema: OrgResponseSchema } } }, 400: errorResponse, 401: errorResponse, 403: errorResponse },
  });
  registry.registerPath({
    method: 'delete', path: '/orgs/{slug}', summary: 'Delete organization — owner only', tags: ['Orgs'],
    security, request: { params: OrgSlugParamsSchema },
    responses: { 204: { description: 'Deleted' }, 401: errorResponse, 403: errorResponse },
  });

  // ── Members ───────────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get', path: '/orgs/{slug}/members', summary: 'List members', tags: ['Members'],
    security, request: { params: OrgSlugParamsSchema },
    responses: { 200: { description: 'Members', content: { 'application/json': { schema: OrgMemberListResponseSchema } } }, 401: errorResponse, 403: errorResponse },
  });
  registry.registerPath({
    method: 'patch', path: '/orgs/{slug}/members/{userId}', summary: 'Update member role', tags: ['Members'],
    security,
    request: {
      params: OrgSlugMemberParamsSchema,
      body: { content: { 'application/json': { schema: UpdateMemberRoleBodySchema } } },
    },
    responses: { 200: { description: 'Updated' }, 400: errorResponse, 401: errorResponse, 403: errorResponse },
  });
  registry.registerPath({
    method: 'delete', path: '/orgs/{slug}/members/{userId}', summary: 'Remove member', tags: ['Members'],
    security, request: { params: OrgSlugMemberParamsSchema },
    responses: { 204: { description: 'Removed' }, 401: errorResponse, 403: errorResponse },
  });

  // ── Invites ───────────────────────────────────────────────────────────────
  registry.registerPath({
    method: 'get', path: '/orgs/{slug}/invites', summary: 'List pending invites', tags: ['Invites'],
    security, request: { params: OrgSlugParamsSchema },
    responses: { 200: { description: 'Invites', content: { 'application/json': { schema: OrgInviteListResponseSchema } } }, 401: errorResponse, 403: errorResponse },
  });
  registry.registerPath({
    method: 'post', path: '/orgs/{slug}/invites', summary: 'Send an invite', tags: ['Invites'],
    security,
    request: { params: OrgSlugParamsSchema, body: { content: { 'application/json': { schema: CreateInviteBodySchema } } } },
    responses: { 201: { description: 'Invite sent', content: { 'application/json': { schema: OrgInviteSchema } } }, 400: errorResponse, 401: errorResponse, 403: errorResponse },
  });
  registry.registerPath({
    method: 'delete', path: '/orgs/{slug}/invites/{inviteId}', summary: 'Revoke an invite', tags: ['Invites'],
    security, request: { params: OrgSlugInviteParamsSchema },
    responses: { 204: { description: 'Revoked' }, 401: errorResponse, 403: errorResponse },
  });

  // ── Blog (PUBLIC — no auth) ─────────────────────────────────────────────────
  // The blog like counter is the one unauthenticated REST surface: the blog is a
  // public page and a like accumulates across all anonymous visitors. `security:
  // []` overrides the document-level default so the docs show these as open.
  const blogLikesResponse = {
    description: "The post's global like total",
    content: { 'application/json': { schema: BlogLikesResponseSchema } },
  };
  registry.registerPath({
    method: 'get', path: '/blog/likes', summary: 'Get a blog post\'s like total (public)', tags: ['Blog'],
    security: [], request: { query: GetBlogLikesQuerySchema },
    responses: { 200: blogLikesResponse, 400: errorResponse },
  });
  registry.registerPath({
    method: 'post', path: '/blog/likes', summary: 'Add a like to a blog post (public)', tags: ['Blog'],
    security: [], request: { body: { content: { 'application/json': { schema: LikeBlogBodySchema } } } },
    responses: { 200: blogLikesResponse, 400: errorResponse },
  });

  const description = [
    'Persistent memory for AI coding agents.',
    '',
    '**Authentication** — every endpoint accepts a Bearer token: a LoreKit API token',
    '(`lk_ro_*` to explore, `lk_rw_*` to test writes) or your Supabase session (JWT).',
    'Generate a token from [Settings → API keys](/settings/api-keys) and paste it into the',
    '**Authorize** box above — one token works on every endpoint, orgs included.',
    '',
    '**Safe by default** — destructive calls run in *dry-run* mode: the `X-LoreKit-Dry-Run`',
    'header defaults to `true`, so create / update / delete requests are validated and',
    'authorized but make **no changes**. Clear that header on an operation to execute for real.',
  ].join('\n');

  const gen = new OpenApiGeneratorV31(registry.definitions);
  const doc = gen.generateDocument({
    openapi: '3.1.0',
    info: { title: 'LoreKit REST API', version: '1.0.0', description },
    servers: [{ url: baseUrl, description: 'Supabase Edge Functions' }],
    // Applied globally in addition to the per-operation `security` so the spec
    // root itself declares the requirement (clients / linters that read the
    // document-level default see auth is required everywhere).
    security,
  }) as unknown as Record<string, unknown>;

  // Sidebar hierarchy (Scalar / Redocly `x-tagGroups`): Members and Invites are
  // sub-concepts of an organization, so nest them with Orgs under one group
  // instead of the flat Memories/Orgs/Members/Invites list.
  doc['x-tagGroups'] = [
    { name: 'Memories', tags: ['Memories'] },
    { name: 'Organizations', tags: ['Orgs', 'Members', 'Invites'] },
  ];

  // Attach the dry-run header to every mutating operation, centrally rather
  // than per-registerPath. It defaults to `true` so Scalar pre-fills it and the
  // docs are safe by default; the caller clears it to execute for real. The
  // backend contract lives in `_shared/limits/dry-run.ts` (isDryRunHeader).
  const MUTATING_METHODS = new Set(['post', 'patch', 'delete', 'put']);
  const dryRunParam = {
    name: 'X-LoreKit-Dry-Run',
    in: 'header',
    required: false,
    description:
      'Safe-explore mode. When `true` (the default here), the request is validated and ' +
      'authorized but makes NO changes. Set it to `false` to execute for real.',
    schema: { type: 'boolean', default: true },
  };
  // Attach the client-attribution header to EVERY operation (not just mutating
  // ones — it exists mainly to label reads). Optional and fail-safe: an
  // unrecognised value is recorded as "unattributed" and never affects the
  // response. It matters because `GET /memories/read-activity` excludes the
  // `dashboard` surface, so a client that wants its reads counted should either
  // send its own name or send nothing.
  //
  // An ABSENT header is no longer "unattributed" on this transport: this REST
  // API itself defaults an unlabelled call to `api`, applied by the router
  // around the (still closed, still fail-safe) validator. The header is now an
  // OVERRIDE for a caller that wants a more specific label than "the REST API"
  // — e.g. a caller identifying itself as `cli` — rather than the only source
  // of the value.
  const clientParam = {
    name: 'X-LoreKit-Client',
    in: 'header',
    required: false,
    description:
      'Which surface is calling. One of `dashboard`, `cli`, `mcp`, `api`; anything else is ' +
      'recorded as unattributed. Purely for usage analytics — it never changes the response. ' +
      'Optional: an absent header records this transport\'s own default (`api`), so send it only ' +
      'to identify a MORE SPECIFIC calling surface (e.g. `cli`). ' +
      'Reads attributed to `dashboard` are excluded from `GET /memories/read-activity`.',
    schema: { type: 'string', enum: ['dashboard', 'cli', 'mcp', 'api'] },
  };
  const paths = (doc['paths'] ?? {}) as Record<string, Record<string, { parameters?: unknown[] }>>;
  for (const [path, operations] of Object.entries(paths)) {
    // The public blog surface implements neither usage attribution nor dry-run,
    // so it must not advertise their headers. Every other (Bearer-authed) route
    // gets the client header, and every mutating one the dry-run header.
    if (path.startsWith('/blog')) continue;
    for (const [method, operation] of Object.entries(operations)) {
      operation.parameters = [...(operation.parameters ?? []), clientParam];
      if (!MUTATING_METHODS.has(method)) continue;
      operation.parameters = [...(operation.parameters ?? []), dryRunParam];
    }
  }

  _cachedSpec = doc;
  return _cachedSpec;
}
