/**
 * The canonical MCP tool catalog — ONE declaration per tool, serving both the
 * wire protocol and the documentation.
 *
 * Two consumers, deliberately:
 *
 *   1. `supabase/functions/mcp/mcp-handler.ts` renders `tools/list` from it
 *      (via `toWireTool`, which drops the docs-only fields). Before this
 *      module the tool list was an inline literal in that handler.
 *   2. `packages/schemas/src/llms/render.ts` renders the "MCP tools" and
 *      "Permission matrix" sections of `packages/web/public/llms.txt`. Before
 *      this module those 161 lines were hand-maintained markdown that nothing
 *      checked — every argument name, type, and default retyped by hand.
 *
 * Zero imports on purpose. It is mirrored verbatim into
 * `supabase/functions/_shared/schemas/tool-catalog.ts` for the self-contained
 * Deno edge runtime (`node scripts/codegen/sync-edge-schemas.mjs`, guarded by
 * `edge-schema-parity.spec.ts`), and it is read by a generator that runs on a
 * bare checkout with no `node_modules`. A `zod` import would break both.
 *
 * The `permission` field is the docs-side statement of the same fact
 * `packages/mcp-core/src/auth/permissions.ts` enforces at runtime. That module
 * cannot import this one (it is mirrored self-contained too, and a relative
 * import would break its byte-for-byte parity guard), so the two are held
 * together by `tool-catalog-parity.spec.ts` instead — the
 * `audit-vocabulary.spec.ts` pattern, applied for the same reason.
 */

/** Default retention window for `memory.purge`, in days. */
export const PURGE_RETENTION_DAYS_DEFAULT = 30;

/**
 * The permission family a tool belongs to, mirroring `READ_TOOLS` /
 * `WRITE_TOOLS`.
 *
 * `null` means the operation is not gated by TOKEN permission at all. No
 * catalogued tool is null today: `org.*` used to be, when those tools were
 * JWT-only, and they are now gated like any other — read to list, write to
 * mutate. Token permission stays orthogonal to org ROLE: a `lk_rw_*` held by a
 * viewer still cannot rename an org, because `lorekit_org_can` remains the only
 * role→capability source.
 */
export type McpToolPermission = 'read' | 'write' | null;

/** Which auth tiers may call a tool. */
export type McpToolAuth = 'token-or-jwt' | 'jwt-only';

/**
 * Which surfaces expose an operation, and how — the binding that makes this
 * file the single origin of the *operation surface*, not just the MCP wire.
 *
 * Read `rest` as DOCUMENTATION of the binding, never as a projection to
 * generate from. The mapping is many-to-one and not derivable: `GET /memories`
 * and `POST /memories/list` are both `memory.list`, `POST /memories` and
 * `PATCH /memories/:id` are both `memory.write`, and `DELETE /memories` splits
 * into `memory.delete` vs `memory.archive` by the `?force` query parameter
 * (resolved in `rest-tool-name.ts`'s code, not by a table lookup). Several REST
 * routes deliberately have no operation here at all. Which operations exist is
 * a curation decision about agent surface area; the HTTP routes are one way to
 * reach them.
 *
 * `handler` is a NAME, never a function reference: this module is zero-import
 * (see the file header), so it can only name the symbol. The generated dispatch
 * module resolves the name to the real import, and a guard asserts every name
 * here is exported from `supabase/functions/mcp/tools.ts`.
 *
 * The `*Exempt` fields exist so that *absence* from a surface is a declared,
 * reviewable decision rather than a silent omission — which is how
 * `memory.restore` came to be missing from the CLI's stdio server despite both
 * stores supporting it.
 */
export interface SurfaceBinding {
  /** Dispatched by the edge MCP handler (`supabase/functions/mcp/`). */
  readonly mcp: boolean;
  /** Canonical `lorekit` subcommand, or null when the CLI does not expose it. */
  readonly cli: string | null;
  /** Additional accepted command spellings, canonicalised before dispatch. */
  readonly cliAliases?: readonly string[];
  /** Representative REST route. Documentation of the binding — see above. */
  readonly rest?: string | null;
  /** Dispatch symbol NAME exported from `supabase/functions/mcp/tools.ts`. */
  readonly handler: string;
  /** Required when `cli` is null: why that is intentional. */
  readonly cliExempt?: string;
  /** Required when the CLI's local stdio MCP server does not dispatch it. */
  readonly localMcpExempt?: string;
}

/** The subset of JSON Schema the tool inputs actually use. */
export interface JsonSchemaProperty {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  readonly description?: string;
  readonly items?: { readonly type: string };
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: string | number | boolean;
  /** Closed value vocabulary, e.g. `kind: ['lesson','bus','signal']`. */
  readonly enum?: readonly string[];
}

export interface JsonSchemaObject {
  readonly type: 'object';
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
}

export interface McpToolDoc {
  /** Wire name, e.g. `memory.write`. */
  readonly name: string;
  /** Sent verbatim as the MCP `description`. One line, imperative. */
  readonly description: string;
  /** Sent verbatim as the MCP `inputSchema`. */
  readonly inputSchema: JsonSchemaObject;
  /** Token permission family. `null` only if not token-gated at all. */
  readonly permission: McpToolPermission;
  /** Auth tiers accepted. */
  readonly auth: McpToolAuth;
  /** Which surfaces expose this op, and the handler that backs it. */
  readonly surfaces: SurfaceBinding;
  /** Docs-only: the shape a successful call returns. */
  readonly returns?: string;
  /** Docs-only: caveats worth a paragraph under the argument table. */
  readonly notes?: readonly string[];
}

const scope: JsonSchemaProperty = { type: 'string', description: 'Canonical scope string, e.g. `repo::mthines/lorekit`.' };
const key: JsonSchemaProperty = { type: 'string', description: 'Lesson identifier, unique within the scope. Max 512 characters.' };
const limit: JsonSchemaProperty = { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Maximum entries to return.' };

/**
 * The EIGHT dimension filters a retention policy (or an inline groom call)
 * can carry (migration 00093) — the same set the Lore Explorer's filter bar
 * offers. Shared by `policy.create`, `policy.update`, `groom.preview` and
 * `groom.run` so the four cannot describe the dimensions differently. `*_mode`
 * defaults match `ListMemoriesBodySchema`'s: `any` for `tags`, `in` for every
 * scalar dimension.
 */
function groomDimensionFilterProperties(clearable: boolean): Record<string, JsonSchemaProperty> {
  const omitSuffix = clearable ? ' Omit to leave unchanged; pass explicit null to clear.' : '';
  const scalar = (label: string, example: string): JsonSchemaProperty => ({
    type: 'array',
    items: { type: 'string' },
    description: `Match lessons whose ${label} is one of these (or, with mode "nin", none of these) — e.g. ${example}.${omitSuffix}`,
  });
  const mode = (label: string, values: readonly string[], def: string): JsonSchemaProperty => ({
    type: 'string', enum: [...values], default: def, description: `How the ${label} filter combines.${omitSuffix}`,
  });
  return {
    tags: { type: 'array', items: { type: 'string' }, description: `Match lessons carrying these labels — combined by \`tags_mode\`.${omitSuffix}` },
    tags_mode: { type: 'string', enum: ['any', 'all', 'none'], default: 'any', description: `"any" (carries at least one), "all" (carries every one), or "none" (carries none).${omitSuffix}` },
    source_agent: scalar('writing agent', '"claude", "aw"'),
    source_agent_mode: mode('source_agent', ['in', 'nin'], 'in'),
    trigger: scalar('write trigger', '"stuck-loop", "pr-webhook"'),
    trigger_mode: mode('trigger', ['in', 'nin'], 'in'),
    kind: scalar('kind', '"lesson", "bus", "signal"'),
    kind_mode: mode('kind', ['in', 'nin'], 'in'),
    host: scalar('owning host', '"reviewer", "aw"'),
    host_mode: mode('host', ['in', 'nin'], 'in'),
    origin_repo: scalar('origin repository', '"owner/repo"'),
    origin_repo_mode: mode('origin_repo', ['in', 'nin'], 'in'),
    origin_branch: scalar('origin branch', '"main", "feat/x"'),
    origin_branch_mode: mode('origin_branch', ['in', 'nin'], 'in'),
    origin_pr: { type: 'array', items: { type: 'string' }, description: `Match lessons from one of these pull-request numbers, as digit strings — e.g. "482".${omitSuffix}` },
    origin_pr_mode: mode('origin_pr', ['in', 'nin'], 'in'),
  };
}

/**
 * Why no `org.*` operation has a `lorekit <verb>` subcommand: org management
 * reaches the CLI through the local stdio MCP server (`lorekit mcp`), which
 * proxies to the REST `/orgs` routes. Stated once and shared by all four rather
 * than repeated, so the four cannot drift into disagreeing about the reason.
 */
const ORG_CLI_EXEMPT = 'org management reaches the CLI via the local stdio MCP server (`lorekit mcp`), not a `lorekit` subcommand';

/**
 * Every tool the MCP server exposes, in the order `tools/list` reports them.
 *
 * Adding a tool means adding it here, with a `surfaces` binding, and adding the
 * named handler to `supabase/functions/mcp/tools.ts`. The dispatch map, the
 * CLI's generated surface artifact, and the docs all derive from this array —
 * `surface-parity.spec.ts` fails when a surface is missed.
 *
 * `as const satisfies` rather than a `: readonly McpToolDoc[]` annotation: the
 * annotation widens every `name` to `string`, which is what forced the dispatch
 * map to be cross-checked by a source regex. Keeping the literal types makes
 * `McpToolName` a real union, so a dispatch map keyed by it rejects a missing or
 * misspelled entry at compile time instead. `satisfies` keeps the interface
 * conformance check the annotation was providing.
 */
export const MCP_TOOLS = [
  {
    name: 'memory.write',
    description: 'Store or update a lesson',
    permission: 'write',
    auth: 'token-or-jwt',
    surfaces: { mcp: true, cli: 'write', rest: 'POST /', handler: 'toolWrite' },
    inputSchema: {
      type: 'object',
      required: ['scope', 'key', 'value'],
      properties: {
        scope,
        key,
        value: { type: 'string', description: 'Lesson body in markdown. Max 64 KB.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free-form labels, e.g. `["skill::aw", "source::stuck-loop"]`.' },
        source_agent: { type: 'string', description: 'Name of the agent writing this lesson.' },
        trigger: { type: 'string', description: 'What triggered the write: `stuck-loop`, `pr-webhook`, `manual`.' },
        kind: {
          type: 'string',
          enum: ['lesson', 'bus', 'signal'],
          description:
            'The bucket kind: `lesson` (procedural, read every run), `bus` (transient outcome event, read at promotion time), or `signal` (durable per-repo filter, read every run). Omit to have it inferred from a `loop::<host>-lessons` tag.',
        },
        host: {
          type: 'string',
          description:
            'The owning skill or agent (e.g. `reviewer`, `aw`, `ci-auto-fix`). Omit to have it inferred from a `loop::<host>-lessons` tag.',
        },
        created_at: {
          type: 'string',
          format: 'date-time',
          description:
            'Optional ISO 8601 creation date. Use when migrating a pre-existing memory so it is dated by its original time instead of now. Rejected if invalid or in the future. Applies only when the memory is first created.',
        },
        org: {
          type: 'string',
          description:
            'Org slug to write under (org-owned write). Omit for a personal memory. You must be a write-capable member (member/admin/owner, not viewer) of the org, verified server-side — supplying an org slug you are not authorized for is rejected.',
        },
        ttl_days: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
          description:
            'Number of days until the memory auto-expires. Omit for a permanent memory. On an update, supplying ttl_days refreshes the expiry; omitting it leaves the existing expiry unchanged.',
        },
        clear_ttl: {
          type: 'boolean',
          description:
            'When true, removes the existing expiry and makes the memory permanent again. Takes precedence over ttl_days when both are supplied.',
        },
        origin_repo: {
          type: 'string',
          description:
            'Provenance: the owner/name of the repository this memory was recorded from. Distinct from `scope`, which says where the lesson APPLIES.',
        },
        origin_branch: {
          type: 'string',
          description:
            'Provenance: the git branch this memory was recorded from. Stored verbatim (case-sensitive) so its GitHub link resolves.',
        },
        origin_commit: {
          type: 'string',
          description: 'Provenance: the commit SHA (7-40 hex characters) checked out when this memory was recorded.',
        },
        origin_pr: {
          type: 'integer',
          minimum: 1,
          description:
            'Provenance: the pull request number this memory was recorded from. Combined with origin_repo it renders as a link to the PR.',
        },
      },
    },
    returns:
      '`{ "id": "<uuid>", "created_at": "<iso>" }` — plus optional `"expires_at"` and `"notice"` (when a write fell back to personal because the scope is bound to an org the caller cannot write to).',
    notes: [
      '**Provenance (`origin_*`):** `scope` says where a lesson *applies*; the four `origin_*` fields say where it was *recorded from*. Each is independently optional and the last KNOWN value wins — on an update, a field you omit keeps whatever a previous write recorded rather than being erased. A malformed value is rejected, never silently dropped.',
      '**Scope→org binding:** An org admin can bind a scope (e.g. a repo) to an org. A write under a bound scope with no explicit `org` auto-routes to that org for write-capable members. A non-member\u2019s write falls back to personal (never rejected) with a `notice`.',
    ],
  },
  {
    name: 'memory.read',
    description: 'Read a lesson by scope and key',
    permission: 'read',
    auth: 'token-or-jwt',
    surfaces: { mcp: true, cli: 'show', rest: 'GET /:id', handler: 'toolRead' },
    inputSchema: { type: 'object', required: ['scope', 'key'], properties: { scope, key } },
    returns: '`{ "value": "<markdown>", "updated_at": "<iso>" }` or `null` if not found.',
  },
  {
    name: 'memory.list',
    description: 'List lessons for a scope',
    permission: 'read',
    auth: 'token-or-jwt',
    surfaces: { mcp: true, cli: 'list', cliAliases: ['ls'], rest: 'GET /', handler: 'toolList' },
    inputSchema: {
      type: 'object',
      required: ['scope'],
      properties: {
        scope,
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter to entries carrying ANY of these labels (OR).' },
        limit,
        cursor: { type: 'string', description: 'Opaque cursor from a previous response\'s `nextCursor`. Omit to start from the first page. Ignored when `order` is `rank` (ranked mode returns a single bounded page; `hasMore` is always false and `nextCursor` always null).' },
        order: { type: 'string', enum: ['recency', 'rank'], default: 'recency', description: 'recency (default, updated_at desc + cursor pagination) or rank (salience+recency; bounded top-N, no cursor). Note: rank results are MMR-diversified, so they are NOT strictly score-descending — a more diverse lower-scored lesson can precede a higher-scored near-duplicate.' },
        kind: { type: 'string', enum: ['lesson', 'bus', 'signal'], description: 'Filter to one bucket family: `lesson` (procedural, read every run), `bus` (transient outcome event), or `signal` (durable per-repo filter). Rows written before the taxonomy existed have no kind and are excluded when this is set.' },
        host: { type: 'string', description: 'Filter to the owning skill or agent, e.g. `reviewer`, `aw`, `ci-auto-fix`. Combine with `kind` to read exactly one bucket ("lessons for host reviewer").' },
        view: { type: 'string', enum: ['full', 'summary'], default: 'full', description: 'full (default) returns each entry\'s complete `value`. summary omits `value` and returns `value_bytes` + a 200-character `preview` instead — the cheap discovery read for deciding WHICH lessons to then fetch with `memory.read`.' },
      },
    },
    returns: '`{ "entries": [{ "key", "value", "tags", "updated_at" }], "hasMore": boolean, "nextCursor": string | null }` — newest-first (recency mode) or ranked by salience+recency then MMR-diversified (rank mode). Because rank mode diversifies, entries are NOT strictly score-descending — a more diverse lower-scored lesson can precede a higher-scored near-duplicate. Pass `nextCursor` back as `cursor` to paginate — recency mode only. Rank mode is a single bounded top-N page: `hasMore` is always false and `nextCursor` always null. With `view: "summary"` each entry is `{ "key", "tags", "updated_at", "value_bytes", "preview" }` — `value` is omitted entirely.',
  },
  {
    name: 'memory.delete',
    description:
      'Soft-archive a lesson (default) or hard-delete it (force: true). Archived lessons are hidden from reads but can be restored.',
    permission: 'write',
    auth: 'token-or-jwt',
    // `?force=true` is what tells this apart from `memory.archive` on the same route.
    surfaces: { mcp: true, cli: 'delete', cliAliases: ['rm'], rest: 'DELETE /?force=true', handler: 'toolDelete' },
    inputSchema: {
      type: 'object',
      required: ['scope', 'key'],
      properties: {
        scope,
        key,
        force: { type: 'boolean', default: false, description: 'Hard-delete immediately (unrecoverable). Defaults to false (soft-archive).' },
        org: {
          type: 'string',
          description:
            'Org slug to delete under (org-owned delete). Omit for a personal memory. Soft-archive requires a member/admin/owner role; hard-delete (force: true) requires admin/owner — verified server-side.',
        },
      },
    },
    returns:
      '`{ "deleted": boolean, "archived": boolean }` — soft-archive returns `{ deleted: false, archived: true }`, hard-delete returns `{ deleted: true, archived: false }`, both `false` when the lesson was not found.',
  },
  {
    name: 'memory.search',
    description: 'Full-text search across lessons',
    permission: 'read',
    auth: 'token-or-jwt',
    surfaces: { mcp: true, cli: 'search', cliAliases: ['grep'], rest: 'POST /search', handler: 'toolSearch' },
    inputSchema: {
      type: 'object',
      required: ['q'],
      properties: {
        q: { type: 'string', description: 'Full-text query.' },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Scopes to search. Accepts an owner-level wildcard, e.g. `repo::mthines/*` — the only tool that does.',
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter to entries carrying ALL of these labels (AND).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum entries to return.' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous response\'s `nextCursor`. Omit to start from the first page.' },
      },
    },
    returns: '`{ "entries": [{ "key", "value", "scope", "tags", "rank" }], "hasMore": boolean, "nextCursor": string | null }`. Pass `nextCursor` back as `cursor` to retrieve the next page.',
  },
  {
    name: 'memory.archive',
    description: 'Soft-archive a lesson. Archived lessons are hidden from reads but can be restored via memory.restore.',
    permission: 'write',
    auth: 'token-or-jwt',
    // Same route as `memory.delete`, distinguished by the ABSENCE of `?force=true`.
    surfaces: { mcp: true, cli: 'archive', rest: 'DELETE /', handler: 'toolArchive' },
    inputSchema: { type: 'object', required: ['scope', 'key'], properties: { scope, key } },
    returns: '`{ "archived": true }` if found and archived, `{ "archived": false }` if already archived or not found.',
  },
  {
    name: 'memory.scopes',
    description:
      'List every scope in the store with how many active memories it holds and when it was last '
      + 'written to — the inventory to consult when you do not already know which scope to read. '
      + 'Takes no arguments and is store-wide, NOT limited to any working directory. Every other '
      + 'read tool requires a scope up front, so this is the one that answers "what is there?".',
    permission: 'read',
    auth: 'token-or-jwt',
    surfaces: { mcp: true, cli: 'scopes', rest: 'GET /scopes', handler: 'toolScopes' },
    inputSchema: { type: 'object', properties: {} },
    returns: '`{ "scopes": [{ "scope", "count", "last_activity" }] }`, sorted by count desc then scope asc (busiest scope first). `count` is active (non-archived, non-expired) memories; `last_activity` is the newest `created_at` among them, or `null`.',
  },
  {
    name: 'memory.list_archived',
    description: 'List archived (soft-deleted) lessons for a scope',
    permission: 'read',
    auth: 'token-or-jwt',
    surfaces: {
      mcp: true,
      cli: null,
      cliExempt: 'surfaced as a flag on an existing command — `lorekit list --archived` — not a command of its own',
      rest: 'GET /?archived=true',
      handler: 'toolListArchived',
      localMcpExempt: 'reachable through memory.list\'s archived filter on the offline store',
    },
    inputSchema: { type: 'object', required: ['scope'], properties: { scope, limit } },
    returns: '`{ "entries": [{ "key", "value", "tags", "updated_at", "archived_at" }] }`',
  },
  {
    name: 'memory.restore',
    description: 'Restore an archived lesson back to active',
    permission: 'write',
    auth: 'token-or-jwt',
    surfaces: { mcp: true, cli: 'restore', rest: 'POST /restore', handler: 'toolRestore' },
    inputSchema: { type: 'object', required: ['scope', 'key'], properties: { scope, key } },
    returns: '`{ "restored": true }` if restored, `{ "restored": false }` if already active or not found.',
  },
  {
    name: 'memory.purge',
    description: `Permanently delete archived lessons older than retention_days (default ${PURGE_RETENTION_DAYS_DEFAULT}). Unrecoverable.`,
    permission: 'write',
    auth: 'token-or-jwt',
    surfaces: {
      mcp: true,
      cli: 'purge',
      rest: 'POST /purge',
      handler: 'toolPurge',
      localMcpExempt: 'account-wide sweep against server-side state; the offline store has no equivalent',
    },
    inputSchema: {
      type: 'object',
      properties: {
        retention_days: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
          default: PURGE_RETENTION_DAYS_DEFAULT,
          description: 'Only purge archived lessons older than this many days.',
        },
      },
    },
    returns: '`{ "purged": <count> }`',
  },
  {
    name: 'memory.purge_expired',
    description: 'Permanently delete all TTL-expired memories for the current user. Unrecoverable.',
    permission: 'write',
    auth: 'token-or-jwt',
    surfaces: {
      mcp: true,
      cli: 'purge-expired',
      rest: 'POST /purge-expired',
      handler: 'toolPurgeExpired',
      localMcpExempt: 'account-wide sweep against server-side state; the offline store has no equivalent',
    },
    inputSchema: { type: 'object', properties: {} },
    returns: '`{ "purged": <count> }`',
  },
  {
    name: 'org.create',
    description:
      'Create a new organization. You become its owner automatically. The slug must be globally unique and lowercase.',
    permission: 'write',
    auth: 'token-or-jwt',
    surfaces: { mcp: true, cli: null, cliExempt: ORG_CLI_EXEMPT, rest: 'POST /orgs', handler: 'toolOrgCreate' },
    inputSchema: {
      type: 'object',
      required: ['slug', 'name'],
      properties: {
        slug: { type: 'string', description: 'Unique lowercase org identifier, e.g. "my-team"' },
        name: { type: 'string', description: 'Human-readable display name' },
      },
    },
    returns: '`{ "id", "slug", "name" }`',
  },
  {
    name: 'org.list',
    description: 'List all organizations you are a member of, with your role in each.',
    permission: 'read',
    auth: 'token-or-jwt',
    surfaces: { mcp: true, cli: null, cliExempt: ORG_CLI_EXEMPT, rest: 'GET /orgs', handler: 'toolOrgList' },
    inputSchema: { type: 'object', properties: {} },
    returns: '`{ "entries": [{ "id", "slug", "name", "role", "created_at" }] }` — roles: `owner`, `admin`, `member`, `viewer`.',
  },
  {
    name: 'org.rename',
    description: "Rename an organization's display name. Requires admin or owner role.",
    permission: 'write',
    auth: 'token-or-jwt',
    surfaces: { mcp: true, cli: null, cliExempt: ORG_CLI_EXEMPT, rest: 'PATCH /orgs/:slug', handler: 'toolOrgRename' },
    inputSchema: {
      type: 'object',
      required: ['slug', 'name'],
      properties: {
        slug: { type: 'string', description: 'The org slug to update' },
        name: { type: 'string', description: 'New display name' },
      },
    },
    returns: '`{ "id", "slug", "name" }`',
  },
  {
    name: 'org.delete',
    description:
      'Delete an organization. Requires owner role. Soft-deletes the org — all org lore is immediately hidden from reads. Unrecoverable via MCP.',
    permission: 'write',
    auth: 'token-or-jwt',
    surfaces: { mcp: true, cli: null, cliExempt: ORG_CLI_EXEMPT, rest: 'DELETE /orgs/:slug', handler: 'toolOrgDelete' },
    inputSchema: {
      type: 'object',
      required: ['slug'],
      properties: { slug: { type: 'string', description: 'The org slug to delete' } },
    },
    returns: '`{ "deleted": true, "slug": "<slug>" }`',
  },
  {
    name: 'policy.list',
    description: 'List every retention policy you own',
    permission: 'read',
    auth: 'token-or-jwt',
    surfaces: {
      mcp: true,
      cli: 'policy',
      rest: 'GET /policies',
      handler: 'toolPolicyList',
      localMcpExempt: 'server-side retention_policies table; the offline store has no equivalent',
    },
    inputSchema: { type: 'object', properties: {} },
    returns: '`{ "entries": [{ "id", "scope", "name", "mode", "enabled", "min_age_days", "unseen_days", "max_seen_count", "max_read_count", "max_opened_count", "created_at", "updated_at" }] }`',
  },
  {
    name: 'policy.create',
    description: 'Create a scoped retention policy that auto-archives (never hard-deletes) matching lessons',
    permission: 'write',
    auth: 'token-or-jwt',
    surfaces: {
      mcp: true,
      cli: null,
      cliExempt: 'an action of the `lorekit policy` command',
      rest: 'POST /policies',
      handler: 'toolPolicyCreate',
      localMcpExempt: 'server-side retention_policies table; the offline store has no equivalent',
    },
    inputSchema: {
      type: 'object',
      required: ['scope', 'name'],
      properties: {
        scope,
        name: { type: 'string', description: 'Human-readable name for the policy.' },
        mode: { type: 'string', enum: ['review', 'auto'], default: 'review', description: '`review` — surfaced for a human to run manually. `auto` — swept nightly, if enabled.' },
        enabled: { type: 'boolean', default: false, description: 'Whether `auto` mode is active. Always starts false, even when mode is `auto`.' },
        min_age_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Match only lessons at least this many days old.' },
        unseen_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Match lessons not individually opened via MCP or the CLI for at least this many days (a bulk list/search result or a dashboard view does not count). A never-opened lesson is measured from its creation date, so it matches only once it is itself this old.' },
        max_seen_count: { type: 'integer', minimum: 0, maximum: 100000, description: 'Match only lessons that have recurred at most this many times.' },
        max_read_count: { type: 'integer', minimum: 0, maximum: 100000, description: 'Match only lessons READ at most this many times — the counter that says whether a lesson was ever actually used, unlike `max_seen_count` which counts WRITES. Counts EVERY read, a bulk `memory.list`/`memory.search` appearance included (unlike `unseen_days`, which only counts targeted opens). Reads have only been counted since the counter shipped, so a long-lived lesson can show a low count it never earned.' },
        max_opened_count: { type: 'integer', minimum: 0, maximum: 100000, description: 'Match only lessons an agent DELIBERATELY fetched at most this many times — the count behind `last_opened_at`. Unlike `max_read_count` a bulk `memory.list`/`memory.search` ride-along does NOT count, so `0` means "nothing ever chose this" rather than "this lesson happens to live in a narrow scope". Backfilled over the whole recorded history, so it carries no cutover caveat.' },
        ...groomDimensionFilterProperties(false),
      },
    },
    returns: 'The created policy object.',
    notes: ['Every condition is AND-ed together; a policy with no conditions at all matches every non-protected lesson in scope.'],
  },
  {
    name: 'policy.update',
    description: 'Update a retention policy. Every field but id is optional',
    permission: 'write',
    auth: 'token-or-jwt',
    surfaces: {
      mcp: true,
      cli: null,
      cliExempt: 'an action of the `lorekit policy` command',
      rest: 'PATCH /policies/:id',
      handler: 'toolPolicyUpdate',
      localMcpExempt: 'server-side retention_policies table; the offline store has no equivalent',
    },
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The policy id to update.' },
        name: { type: 'string', description: 'New name for the policy.' },
        mode: { type: 'string', enum: ['review', 'auto'], description: '`review` — surfaced for a human to run manually. `auto` — swept nightly, if enabled.' },
        enabled: { type: 'boolean', description: 'Whether `auto` mode is active.' },
        min_age_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Match only lessons at least this many days old. Omit to leave unchanged; pass explicit null to clear.' },
        unseen_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Match lessons not individually opened via MCP or the CLI for at least this many days (a bulk list/search result or a dashboard view does not count); a never-opened lesson is measured from its creation date. Omit to leave unchanged; pass explicit null to clear.' },
        max_seen_count: { type: 'integer', minimum: 0, maximum: 100000, description: 'Match only lessons that have recurred at most this many times. Omit to leave unchanged; pass explicit null to clear.' },
        max_read_count: { type: 'integer', minimum: 0, maximum: 100000, description: 'Match only lessons READ at most this many times — the counter that says whether a lesson was ever actually used, unlike `max_seen_count` which counts WRITES. Counts EVERY read, a bulk `memory.list`/`memory.search` appearance included (unlike `unseen_days`, which only counts targeted opens). Reads have only been counted since the counter shipped, so a long-lived lesson can show a low count it never earned. Omit to leave unchanged; pass explicit null to clear.' },
        max_opened_count: { type: 'integer', minimum: 0, maximum: 100000, description: 'Match only lessons an agent DELIBERATELY fetched at most this many times — the count behind `last_opened_at`. Unlike `max_read_count` a bulk `memory.list`/`memory.search` ride-along does NOT count, so `0` means "nothing ever chose this" rather than "this lesson happens to live in a narrow scope". Backfilled over the whole recorded history, so it carries no cutover caveat. Omit to leave unchanged; pass explicit null to clear.' },
        ...groomDimensionFilterProperties(true),
      },
    },
    returns: 'The updated policy object.',
    notes: ['An omitted field is left unchanged; an explicit `null` clears that condition.'],
  },
  {
    name: 'policy.delete',
    description: 'Delete a retention policy. Deletes the rule only — never touches the lessons it matched',
    permission: 'write',
    auth: 'token-or-jwt',
    surfaces: {
      mcp: true,
      cli: null,
      cliExempt: 'an action of the `lorekit policy` command',
      rest: 'DELETE /policies/:id',
      handler: 'toolPolicyDelete',
      localMcpExempt: 'server-side retention_policies table; the offline store has no equivalent',
    },
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'The policy id to delete.' } } },
    returns: '`{ "deleted": boolean }`',
  },
  {
    name: 'groom.preview',
    description: 'Preview the lessons a saved policy or an inline condition set would archive, without changing anything',
    permission: 'read',
    auth: 'token-or-jwt',
    surfaces: {
      mcp: true,
      cli: 'groom',
      rest: 'POST /groom/preview',
      handler: 'toolGroomPreview',
      localMcpExempt: 'server-side candidate query against retention_policies + memories; the offline store has no equivalent',
    },
    inputSchema: {
      type: 'object',
      properties: {
        policy_id: { type: 'string', description: 'Preview an existing saved policy. Mutually exclusive with `scope`/conditions.' },
        scope,
        min_age_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Match only lessons at least this many days old.' },
        unseen_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Match lessons not individually opened via MCP or the CLI for at least this many days (a bulk list/search result or a dashboard view does not count). A never-opened lesson is measured from its creation date, so it matches only once it is itself this old.' },
        max_seen_count: { type: 'integer', minimum: 0, maximum: 100000, description: 'Match only lessons that have recurred at most this many times.' },
        max_read_count: { type: 'integer', minimum: 0, maximum: 100000, description: 'Match only lessons READ at most this many times — the counter that says whether a lesson was ever actually used, unlike `max_seen_count` which counts WRITES. Counts EVERY read, a bulk `memory.list`/`memory.search` appearance included (unlike `unseen_days`, which only counts targeted opens). Reads have only been counted since the counter shipped, so a long-lived lesson can show a low count it never earned.' },
        max_opened_count: { type: 'integer', minimum: 0, maximum: 100000, description: 'Match only lessons an agent DELIBERATELY fetched at most this many times — the count behind `last_opened_at`. Unlike `max_read_count` a bulk `memory.list`/`memory.search` ride-along does NOT count, so `0` means "nothing ever chose this" rather than "this lesson happens to live in a narrow scope". Backfilled over the whole recorded history, so it carries no cutover caveat.' },
        ...groomDimensionFilterProperties(false),
      },
    },
    returns: '`{ "count": <number>, "keys": [{ "scope", "key" }] }` — the SAME candidates `groom.run` would archive.',
    notes: ['Pass either `policy_id` or `scope` (with optional conditions), never both.'],
  },
  {
    name: 'groom.run',
    description: 'Archive every lesson a saved policy or an inline condition set matches. Soft-archive only — never hard-deletes',
    permission: 'write',
    auth: 'token-or-jwt',
    surfaces: {
      mcp: true,
      cli: null,
      cliExempt: 'the `--run` mode of `lorekit groom` (`groom.preview` claims the `groom` binding)',
      rest: 'POST /groom/run',
      handler: 'toolGroomRun',
      localMcpExempt: 'server-side candidate query against retention_policies + memories; the offline store has no equivalent',
    },
    inputSchema: {
      type: 'object',
      properties: {
        policy_id: { type: 'string', description: 'Run an existing saved policy. Mutually exclusive with `scope`/conditions.' },
        scope,
        min_age_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Match only lessons at least this many days old.' },
        unseen_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Match lessons not individually opened via MCP or the CLI for at least this many days (a bulk list/search result or a dashboard view does not count). A never-opened lesson is measured from its creation date, so it matches only once it is itself this old.' },
        max_seen_count: { type: 'integer', minimum: 0, maximum: 100000, description: 'Match only lessons that have recurred at most this many times.' },
        max_read_count: { type: 'integer', minimum: 0, maximum: 100000, description: 'Match only lessons READ at most this many times — the counter that says whether a lesson was ever actually used, unlike `max_seen_count` which counts WRITES. Counts EVERY read, a bulk `memory.list`/`memory.search` appearance included (unlike `unseen_days`, which only counts targeted opens). Reads have only been counted since the counter shipped, so a long-lived lesson can show a low count it never earned.' },
        max_opened_count: { type: 'integer', minimum: 0, maximum: 100000, description: 'Match only lessons an agent DELIBERATELY fetched at most this many times — the count behind `last_opened_at`. Unlike `max_read_count` a bulk `memory.list`/`memory.search` ride-along does NOT count, so `0` means "nothing ever chose this" rather than "this lesson happens to live in a narrow scope". Backfilled over the whole recorded history, so it carries no cutover caveat.' },
        ...groomDimensionFilterProperties(false),
      },
    },
    returns: '`{ "archived": <count>, "keys": [{ "scope", "key" }] }`',
    notes: ['Resolves and archives the SAME candidates `groom.preview` shows, in one transaction. Archived lessons are recoverable via `memory.restore`.'],
  },
  {
    name: 'memory.protect',
    description: 'Mark or unmark a lesson as protected — excluded from every grooming candidate set regardless of policy',
    permission: 'write',
    auth: 'token-or-jwt',
    surfaces: {
      mcp: true,
      cli: 'protect',
      rest: 'POST /protect',
      handler: 'toolProtect',
      localMcpExempt: 'the offline store has no protected column in v1',
    },
    inputSchema: {
      type: 'object',
      required: ['scope', 'key', 'protected'],
      properties: { scope, key, protected: { type: 'boolean', description: 'true to protect, false to unprotect.' } },
    },
    returns: '`{ "protected": boolean }`',
  },
] as const satisfies readonly McpToolDoc[];

/**
 * Every operation name the catalog declares — a literal union, not `string`.
 *
 * This is what lets a dispatch map be typed `Record<MemoryToolName, Handler>`,
 * so a missing entry is a compile error and a misspelled one an excess-property
 * error. Splitting by prefix mirrors the two dispatch maps the MCP handler keeps
 * (memory tools take a `userId`; org tools are role-gated inside their RPCs).
 */
export type McpToolName = (typeof MCP_TOOLS)[number]['name'];
export type MemoryToolName = Extract<McpToolName, `memory.${string}`>;
export type OrgToolName = Extract<McpToolName, `org.${string}`>;

/** Every tool name the catalog declares, in wire order. */
export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((t) => t.name);

/** The wire shape for a `tools/list` entry — docs-only fields dropped. */
export interface WireTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
}

/** Project a catalog entry onto the MCP wire shape. */
export function toWireTool(tool: McpToolDoc): WireTool {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

/** The full `tools/list` payload. */
export function wireTools(): readonly WireTool[] {
  return MCP_TOOLS.map(toWireTool);
}
