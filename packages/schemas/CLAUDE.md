# @lorekit/schemas

Single source of truth for all lorekit data shapes — Zod schemas for both MCP and REST surfaces.

## Rules

- **No imports from `@lorekit/core`** — this is a leaf package. One-way dep graph: `@lorekit/core` → `@lorekit/schemas`, never the reverse.
- **Deno consumption** — Supabase Edge Functions import via `import_map.json` which aliases `@lorekit/schemas` to `../../packages/schemas/src/`. All `import { z } from 'zod'` calls resolve to `npm:zod@3` via the Deno import map.
- **`ScopeSchema` vs `RawScopeSchema`** — use `ScopeSchema` (with transform) where the normalised lowercase value goes into DB queries (MCP tool schemas). Use `RawScopeSchema` for REST query params where semantic validation happens separately.

## Adding a schema

1. Add to the appropriate domain file (`memory.ts`, `org.ts`, etc.)
2. Export from `src/index.ts` if shared
3. Regenerate OpenAPI: `pnpm nx run schemas:generate:openapi`

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
