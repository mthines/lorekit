# @lorekit/schemas

Single source of truth for all lorekit data shapes — Zod schemas for both MCP and REST surfaces.

## Rules

- **No imports from `@lorekit/core`** — this is a leaf package. One-way dep graph: `@lorekit/core` → `@lorekit/schemas`, never the reverse.
- **Deno consumption is a MIRROR, not an import** — Supabase Edge Functions do **not** import this package. `src/**` is mirrored into `supabase/functions/_shared/schemas/**` by `node scripts/codegen/sync-edge-schemas.mjs` and imported relatively from there. The only transform is `'zod'` → `'npm:zod@3'` (and `@asteasolutions/zod-to-openapi` likewise), because Deno resolves a fully-qualified `npm:` specifier with no import map. **Edit `src/` and re-run the sync** — never edit the mirror; `edge-schema-parity.spec.ts` fails the build if the two diverge, and `edge-bare-specifier.spec.ts` fails it if a bare specifier reappears anywhere in the functions' graph. This replaced an `import_map.json` alias that the local edge runtime silently stopped receiving, which killed `memories`/`orgs`/`openapi` at boot with an opaque `503 BOOT_ERROR`.
- **`ScopeSchema` vs `RawScopeSchema`** — use `ScopeSchema` (with transform) where the normalised lowercase value goes into DB queries (MCP tool schemas). Use `RawScopeSchema` for REST query params where semantic validation happens separately.
- **Runtime schema files never import `@asteasolutions/zod-to-openapi`** — `openapi/spec.ts` is the only module that touches it, and it is the only module that calls `extendZodWithOpenApi(z)`. That call is mandatory: without it every `registry.register()` throws `zodSchema.openapi is not a function`. Keeping it confined to `spec.ts` also keeps zod-to-openapi out of the `memories`/`orgs` edge bundles.
- **Schemas zod-to-openapi cannot introspect need a doc-only override** — `z.lazy()` (recursive schemas such as `FilterGroupSchema`) and `z.custom()` fail generation with `Unknown zod object type`. Do NOT annotate the runtime schema; add a *derived* doc schema in `spec.ts` (`SearchMemoriesBodySchema.innerType().extend({ … })`) so the field list stays in sync automatically and only the un-introspectable field is overridden.

## Adding a schema

1. Add to the appropriate domain file (`memory.ts`, `org.ts`, etc.)
2. Export from `src/index.ts` if shared
3. Register it in `openapi/spec.ts` if a REST route uses it
4. Run `pnpm nx test schemas` — `openapi/spec.spec.ts` executes the real generator, so an un-introspectable schema fails there instead of 500ing the deployed `/openapi` function

There is no spec artifact to regenerate: the `openapi` Edge Function calls `generateSpec()` at runtime and caches the result per isolate, so a registered schema is live the moment the function redeploys.

## Schema map

| Schema | File | Used by |
|---|---|---|
| `MemoryWriteSchema` | `memory.ts` | MCP + REST POST /memories |
| `ListMemoriesQuerySchema` | `memory.ts` | REST GET /memories |
| `SearchMemoriesBodySchema` | `memory.ts` | REST POST /memories/search |
| `UpdateMemoryBodySchema` | `memory.ts` | REST PATCH /memories/:id |
| `MemoryPageResponseSchema` | `memory.ts` | REST GET /memories, POST /memories/search |
| `MEMORY_SELECT` / `shapeMemoryRow` | `memory.ts` | The one projection + org-embed collapse every read route shares |
| `ScopesResponseSchema` | `memory.ts` | REST GET /memories/scopes |
| `ListTagsQuerySchema` / `TagsResponseSchema` | `memory.ts` | REST GET /memories/tags |
| `ActivityQuerySchema` / `ActivityResponseSchema` | `memory.ts` | REST GET /memories/activity |
| `likeNeedle` / `quoteFilterValue` / `ilikeClause` | `filter.ts` | `GET /memories?q=` substring escaping, and the shared logic-tree value encoding |
| `parseTagsParam` / `pgArrayLiteral` | `tags.ts` | `GET /memories?tags=`, and the dashboard's label picker |
| `OrgResponseSchema` | `org.ts` | REST /orgs |
| `OrgListResponseSchema` | `org.ts` | REST GET /orgs |
| `OrgMemberListResponseSchema` | `member.ts` | REST GET /orgs/:slug/members |
| `OrgInviteListResponseSchema` | `invite.ts` | REST GET /orgs/:slug/invites |
| `MemoryIdParamsSchema` | `common.ts` | REST /memories/:id path params |
| `OrgSlugParamsSchema` | `common.ts` | REST /orgs/:slug path params |
| `OrgSlugMemberParamsSchema` | `common.ts` | REST /orgs/:slug/members/:userId |
| `OrgSlugInviteParamsSchema` | `common.ts` | REST /orgs/:slug/invites/:inviteId |
| `ScopeSchema` | `scope.ts` | MCP tool input validation |
| `RawScopeSchema` | `scope.ts` | REST query params, OpenAPI |
| `FilterGroupSchema` | `common.ts` | REST POST /memories/search `filter` |
| `UsageStatsQuerySchema` | `usage.ts` | REST GET /memories/usage query params |
| `UsageStatsResponseSchema` | `usage.ts` | REST GET /memories/usage response |
| `serializeFilterGroup` | `filter.ts` | `_shared/api/filter.ts` (edge adapter) |

## Behaviour lives here, not in the edge adapter

`filter.ts` is the exception to "this package is only shapes": it holds the
*meaning* of a `FilterGroup` — the operator→PostgREST mapping, the
`ALLOWED_FILTER_FIELDS` whitelist, and the value encoding that stops a value
breaking out of its clause. It sits next to the schema that validates its input
so the two cannot drift, and because Deno has no test harness in this repo this
is the only place the logic can be unit-tested (`src/filter.spec.ts`, run by
`pnpm nx test schemas`). The edge module `_shared/api/filter.ts` is a five-line
adapter that chains the returned expressions onto a query builder.

`tags.ts` is the second instance of the same pattern: label normalisation and
Postgres array quoting are needed by the `GET /memories` handler AND by the
dashboard's label picker, and getting the quoting wrong silently filters on the
wrong labels. `filter.ts`'s `likeNeedle` is the third — an unescaped `%` turns an
as-you-type filter into a match-everything wildcard.

**There is ONE value encoding for a logic tree, and both search paths use it.**
`likeNeedle` escapes LIKE metacharacters (`%`, `_`, `\`); `quoteFilterValue`
double-quotes the finished value, which is how PostgREST's URL grammar carries
a reserved character (`,` `.` `:` `()`); `ilikeClause` composes the two so the
`GET /memories?q=` filter and a `contains` condition of a `FilterGroup` cannot
encode differently. Do NOT percent-encode instead: every expression reaches the
wire through postgrest-js `.or()`, i.e. `URLSearchParams.append`, which
re-encodes the `%` — a hand-written `%2C` arrives as the literal text `%2C` and
matches nothing. Quoting is only valid INSIDE a logic tree; a top-level filter
(`?key=ilike.…`) is parsed by `pSingleVal`, which strips nothing.

Apply the same reasoning to any future logic that is (a) pure, (b) part of the
wire contract, and (c) needed by more than one runtime.

## Tests

`pnpm nx test schemas` — Vitest, `src/**/*.spec.ts`. The package is a leaf with
no I/O, so everything in it is directly unit-testable; add a co-located
`.spec.ts` for any behaviour you add.
