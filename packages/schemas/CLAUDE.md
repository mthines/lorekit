# @lorekit/schemas

Single source of truth for all lorekit data shapes — Zod schemas for both MCP and REST surfaces.

## Rules

- **No imports from `@lorekit/core`** — this is a leaf package. One-way dep graph: `@lorekit/core` → `@lorekit/schemas`, never the reverse.
- **Deno consumption is a MIRROR, not an import** — Supabase Edge Functions do **not** import this package. `src/**` is mirrored into `supabase/functions/_shared/schemas/**` by `node scripts/sync-edge-schemas.mjs` and imported relatively from there. The only transform is `'zod'` → `'npm:zod@3'` (and `@asteasolutions/zod-to-openapi` likewise), because Deno resolves a fully-qualified `npm:` specifier with no import map. **Edit `src/` and re-run the sync** — never edit the mirror; `edge-schema-parity.spec.ts` fails the build if the two diverge, and `edge-bare-specifier.spec.ts` fails it if a bare specifier reappears anywhere in the functions' graph. This replaced an `import_map.json` alias that the local edge runtime silently stopped receiving, which killed `memories`/`orgs`/`openapi` at boot with an opaque `503 BOOT_ERROR`.
- **`ScopeSchema` vs `RawScopeSchema`** — use `ScopeSchema` (with transform) where the normalised lowercase value goes into DB queries (MCP tool schemas). Use `RawScopeSchema` for REST query params where semantic validation happens separately.
- **Runtime schema files never import `@asteasolutions/zod-to-openapi`** — `openapi/spec.ts` is the only module that touches it, and it is the only module that calls `extendZodWithOpenApi(z)`. That call is mandatory: without it every `registry.register()` throws `zodSchema.openapi is not a function`. Keeping it confined to `spec.ts` also keeps zod-to-openapi out of the `memories`/`orgs` edge bundles.
- **Schemas zod-to-openapi cannot introspect need a doc-only override** — `z.lazy()` (recursive schemas such as `FilterGroupSchema`) and `z.custom()` fail generation with `Unknown zod object type`. Do NOT annotate the runtime schema; add a *derived* doc schema in `spec.ts` (`SearchMemoriesBodySchema.innerType().extend({ … })`) so the field list stays in sync automatically and only the un-introspectable field is overridden.

## Adding a schema

1. Add to the appropriate domain file (`memory.ts`, `org.ts`, etc.)
2. Export from `src/index.ts` if shared
3. Register it in `openapi/spec.ts` if a REST route uses it
4. Run `pnpm nx test schemas` — `openapi/spec.spec.ts` executes the real generator, so an un-introspectable schema fails there instead of 500ing the deployed `/openapi` function
5. Regenerate OpenAPI: `pnpm nx run schemas:generate:openapi`

## Schema map

| Schema | File | Used by |
|---|---|---|
| `MemoryWriteSchema` | `memory.ts` | MCP + REST POST /memories |
| `ListMemoriesQuerySchema` | `memory.ts` | REST GET /memories |
| `SearchMemoriesBodySchema` | `memory.ts` | REST POST /memories/search |
| `UpdateMemoryBodySchema` | `memory.ts` | REST PATCH /memories/:id |
| `MemoryPageResponseSchema` | `memory.ts` | REST GET /memories, POST /memories/search |
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
