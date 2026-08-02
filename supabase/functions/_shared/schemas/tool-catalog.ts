// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/tool-catalog.ts
// Regenerate: node scripts/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
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
 * Deno edge runtime (`node scripts/sync-edge-schemas.mjs`, guarded by
 * `edge-schema-parity.spec.ts`), and it is read by a generator that runs on a
 * bare checkout with no `node_modules`. A `zod` import would break both.
 *
 * The `permission` field is the docs-side statement of the same fact
 * `packages/mcp-core/src/permissions.ts` enforces at runtime. That module
 * cannot import this one (it is mirrored self-contained too, and a relative
 * import would break its byte-for-byte parity guard), so the two are held
 * together by `tool-catalog-parity.spec.ts` instead — the
 * `audit-vocabulary.spec.ts` pattern, applied for the same reason.
 */

/** Default retention window for `memory.purge`, in days. */
export const PURGE_RETENTION_DAYS_DEFAULT = 30;

/**
 * The permission family a tool belongs to, mirroring `READ_TOOLS` /
 * `WRITE_TOOLS`. `null` for `org.*` tools, which are gated by auth tier and
 * org role rather than by token permission.
 */
export type McpToolPermission = 'read' | 'write' | null;

/** Which auth tiers may call a tool. */
export type McpToolAuth = 'token-or-jwt' | 'jwt-only';

/** The subset of JSON Schema the tool inputs actually use. */
export interface JsonSchemaProperty {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  readonly description?: string;
  readonly items?: { readonly type: string };
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: string | number | boolean;
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
  /** Token permission family. `null` for `org.*`. */
  readonly permission: McpToolPermission;
  /** Auth tiers accepted. */
  readonly auth: McpToolAuth;
  /** Docs-only: the shape a successful call returns. */
  readonly returns?: string;
  /** Docs-only: caveats worth a paragraph under the argument table. */
  readonly notes?: readonly string[];
}

const scope: JsonSchemaProperty = { type: 'string', description: 'Canonical scope string, e.g. `repo::mthines/lorekit`.' };
const key: JsonSchemaProperty = { type: 'string', description: 'Lesson identifier, unique within the scope. Max 512 characters.' };
const limit: JsonSchemaProperty = { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Maximum entries to return.' };

/**
 * Every tool the MCP server exposes, in the order `tools/list` reports them.
 *
 * Adding a tool means adding it here AND to the dispatch map in
 * `supabase/functions/mcp/mcp-handler.ts`; `tool-catalog-parity.spec.ts` fails
 * when the two disagree.
 */
export const MCP_TOOLS: readonly McpToolDoc[] = [
  {
    name: 'memory.write',
    description: 'Store or update a lesson',
    permission: 'write',
    auth: 'token-or-jwt',
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
    inputSchema: { type: 'object', required: ['scope', 'key'], properties: { scope, key } },
    returns: '`{ "value": "<markdown>", "updated_at": "<iso>" }` or `null` if not found.',
  },
  {
    name: 'memory.list',
    description: 'List lessons for a scope',
    permission: 'read',
    auth: 'token-or-jwt',
    inputSchema: {
      type: 'object',
      required: ['scope'],
      properties: {
        scope,
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter to entries carrying ANY of these labels (OR).' },
        limit,
      },
    },
    returns: '`{ "entries": [{ "key", "value", "tags", "updated_at" }] }` — newest first.',
  },
  {
    name: 'memory.delete',
    description:
      'Soft-archive a lesson (default) or hard-delete it (force: true). Archived lessons are hidden from reads but can be restored.',
    permission: 'write',
    auth: 'token-or-jwt',
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
      },
    },
    returns: '`{ "entries": [{ "key", "value", "scope", "tags", "rank" }] }`',
  },
  {
    name: 'memory.archive',
    description: 'Soft-archive a lesson. Archived lessons are hidden from reads but can be restored via memory.restore.',
    permission: 'write',
    auth: 'token-or-jwt',
    inputSchema: { type: 'object', required: ['scope', 'key'], properties: { scope, key } },
    returns: '`{ "archived": true }` if found and archived, `{ "archived": false }` if already archived or not found.',
  },
  {
    name: 'memory.list_archived',
    description: 'List archived (soft-deleted) lessons for a scope',
    permission: 'read',
    auth: 'token-or-jwt',
    inputSchema: { type: 'object', required: ['scope'], properties: { scope, limit } },
    returns: '`{ "entries": [{ "key", "value", "tags", "updated_at", "archived_at" }] }`',
  },
  {
    name: 'memory.restore',
    description: 'Restore an archived lesson back to active',
    permission: 'write',
    auth: 'token-or-jwt',
    inputSchema: { type: 'object', required: ['scope', 'key'], properties: { scope, key } },
    returns: '`{ "restored": true }` if restored, `{ "restored": false }` if already active or not found.',
  },
  {
    name: 'memory.purge',
    description: `Permanently delete archived lessons older than retention_days (default ${PURGE_RETENTION_DAYS_DEFAULT}). Unrecoverable.`,
    permission: 'write',
    auth: 'token-or-jwt',
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
    inputSchema: { type: 'object', properties: {} },
    returns: '`{ "purged": <count> }`',
  },
  {
    name: 'org.create',
    description:
      'Create a new organization. You become its owner automatically. The slug must be globally unique and lowercase.',
    permission: null,
    auth: 'jwt-only',
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
    permission: null,
    auth: 'jwt-only',
    inputSchema: { type: 'object', properties: {} },
    returns: '`{ "entries": [{ "id", "slug", "name", "role", "created_at" }] }` — roles: `owner`, `admin`, `member`, `viewer`.',
  },
  {
    name: 'org.rename',
    description: "Rename an organization's display name. Requires admin or owner role.",
    permission: null,
    auth: 'jwt-only',
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
    permission: null,
    auth: 'jwt-only',
    inputSchema: {
      type: 'object',
      required: ['slug'],
      properties: { slug: { type: 'string', description: 'The org slug to delete' } },
    },
    returns: '`{ "deleted": true, "slug": "<slug>" }`',
  },
] as const;

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
