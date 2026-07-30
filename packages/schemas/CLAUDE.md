# @lorekit/schemas

Single source of truth for all lorekit data shapes — Zod schemas for both MCP and REST surfaces.

## Rules

- **No imports from `@lorekit/core`** — this is a leaf package. One-way dep graph: `@lorekit/core` → `@lorekit/schemas`, never the reverse.
- **Deno consumption** — Supabase Edge Functions import via `import_map.json` which aliases `@lorekit/schemas` to `../../packages/schemas/src/`. All `import { z } from 'zod'` calls resolve to `npm:zod@3` via the Deno import map.
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
| `FilterGroupSchema` | `common.ts` | REST POST /memories/search `filter` |
| `serializeFilterGroup` | `filter.ts` | `_shared/api/filter.ts` (edge adapter) |
| `AUDIT_ACTIONS` / `AuditActionSchema` | `audit.ts` | **The** `audit_log.action` vocabulary — `@lorekit/core`'s `audit.ts`, `supabase/functions/_shared/audit.ts`, `packages/web/src/lib/audit-actions.ts`, and (restated in SQL) the CHECK constraint |
| `AuditEntryInputSchema` | `audit.ts` | Input type for `recordAudit` / `recordRestAudit` / `recordAuditEvent` |
| `AuditRowSchema` | `audit.ts` | Output type of `buildAuditEntry` — the snake_case `audit_log` row |

### `audit.ts` is a vocabulary, and the DB owns a second copy

`AUDIT_ACTIONS` is the only hand-maintained action list, but Postgres cannot import
TypeScript: the enforcing copy is the `action` CHECK on `audit_log`. That seam has
already failed once silently — the dashboard emitted `github_app.installation_linked`,
the CHECK rejected it, and the non-throwing writer swallowed the error, so every such
event was lost with no signal.

**Adding an action is therefore two edits, always together:** the tuple here, and a new
forward-only drop-and-re-add CHECK migration (the
`00023`/`00027`/`00040_audit_log_*.sql` pattern). `packages/mcp-core/src/audit-actions-drift.spec.ts`
parses the latest such migration back out and fails if the two disagree — it also
requires `AUDIT_ACTION_META` in web to have exactly one entry per action.

Presentation (labels, icons, badge colours) stays in
`packages/web/src/lib/audit-actions.ts`: this package must not gain `lucide-react` or
any other UI dependency.

## Behaviour lives here, not in the edge adapter

`filter.ts` is the exception to "this package is only shapes": it holds the
*meaning* of a `FilterGroup` — the operator→PostgREST mapping, the
`ALLOWED_FILTER_FIELDS` whitelist, and the value encoding that stops a value
breaking out of its clause. It sits next to the schema that validates its input
so the two cannot drift, and because Deno has no test harness in this repo this
is the only place the logic can be unit-tested (`src/filter.spec.ts`, run by
`pnpm nx test schemas`). The edge module `_shared/api/filter.ts` is a five-line
adapter that chains the returned expressions onto a query builder.

Apply the same reasoning to any future logic that is (a) pure, (b) part of the
wire contract, and (c) needed by more than one runtime.

## Tests

`pnpm nx test schemas` — Vitest, `src/**/*.spec.ts`. The package is a leaf with
no I/O, so everything in it is directly unit-testable; add a co-located
`.spec.ts` for any behaviour you add.
