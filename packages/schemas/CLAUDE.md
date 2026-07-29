# @lorekit/schemas

This package owns all lorekit Zod schemas and OpenAPI generation. Single source of truth for data shapes shared by @lorekit/core (Node), Supabase Edge Functions (Deno via deno.json), and the CLI.

## Purpose

Instead of defining schemas inline in each tool file (packages/mcp-core/src/tools/*.ts) or duplicating them across the Node and Deno runtimes, all Zod schema definitions live here and are imported by consumers.

- `@lorekit/core` (Node): imports via path alias `@lorekit/schemas/scope.js` etc.
- `supabase/functions/mcp/` (Deno): cannot cross-import Node packages. Uses a per-function `deno.json` import map pointing at the checked-out source files directly.
- The CLI: imports via the same Node ESM path aliases.

## Modules

- `src/scope.ts` — canonical scope validation: `ScopePrefix`, `ScopeValidationError`, `validateScope()`, `scopeType()`, `expandScopeForSearch()`, `ScopeFilter`, `ScopeSchema`
- `src/memory.ts` — all memory tool input schemas (Write, List, Read, Search, Delete, Archive, Restore, ListArchived, Purge) plus REST-specific `MemoryUpdateSchema`; also exports `MAX_VALUE_BYTES` and `PURGE_RETENTION_DAYS_DEFAULT`
- `src/org.ts` — org and membership schemas: `OrgCreate`, `OrgRename`, `Org`, `MemberRole`, `MemberRoleUpdate`, `InviteCreate`
- `src/common.ts` — shared REST API primitives: `PaginationSchema`, `FilterNodeSchema` (OR+AND tree), `ErrorResponseSchema`, `paginatedResponse()` factory

## Node import pattern

Node consumers use the path alias registered in `tsconfig.base.json`:

```ts
import { WriteInputSchema, MAX_VALUE_BYTES } from '@lorekit/schemas/memory.js';
import { ScopeSchema, scopeType } from '@lorekit/schemas/scope.js';
import { OrgCreateSchema } from '@lorekit/schemas/org.js';
import { PaginationSchema } from '@lorekit/schemas/common.js';
```

Note the `.js` extension — required for Node ESM (`moduleResolution: "nodenext"`).

## Deno import pattern (supabase/functions)

The Supabase Edge Functions (Deno) cannot cross-import this Node package directly because the Deno runtime is incompatible with the Node.js MCP SDK. The intended pattern is a per-function `deno.json` that maps `@lorekit/schemas/` to relative paths into the checked-out monorepo:

```json
{
  "imports": {
    "@lorekit/schemas/scope": "../../../packages/schemas/src/scope.ts",
    "@lorekit/schemas/memory": "../../../packages/schemas/src/memory.ts",
    "@lorekit/schemas/org": "../../../packages/schemas/src/org.ts",
    "@lorekit/schemas/common": "../../../packages/schemas/src/common.ts"
  }
}
```

Place this `deno.json` at `supabase/functions/<function-name>/deno.json`. Then the Edge Function imports without any build step:

```ts
import { ScopeSchema } from '@lorekit/schemas/scope';
import { WriteInputSchema } from '@lorekit/schemas/memory';
```

Note: Deno resolves `.ts` directly, so no `.js` extension needed in Deno imports.

## Key invariants

- **No runtime dependencies other than `zod`** — schemas are pure data-shape definitions.
- **`@asteasolutions/zod-to-openapi`** is a dev/optional dep for OpenAPI generation; schema files import only from `zod`.
- All schema files are import-free from each other except `memory.ts` importing `ScopeSchema` from `./scope.js`.
- `mcp-core/src/scope.ts` is now a thin re-export: `export * from '@lorekit/schemas/scope.js'`. It is NOT in the `edge-parity.spec.ts` MIRRORS list (it was never a byte-for-byte edge mirror).
