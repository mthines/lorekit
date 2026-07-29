# @lorekit/schemas

This package owns all lorekit Zod schemas and OpenAPI generation. Single source of truth for data shapes shared by @lorekit/core (Node), Supabase Edge Functions (Deno via deno.json), and the CLI.

## Purpose

Instead of defining schemas inline in each tool file (packages/mcp-core/src/tools/*.ts) or duplicating them across the Node and Deno runtimes, all Zod schema definitions live here and are imported by consumers.

## Modules

- `src/scope.ts` — canonical scope validation: `ScopePrefix`, `ScopeValidationError`, `validateScope()`, `scopeType()`, `expandScopeForSearch()`, `ScopeFilter`, `ScopeSchema`
- `src/memory.ts` — all memory tool input schemas (Write, List, Read, Search, Delete, Archive, Restore, ListArchived, Purge) plus REST-specific schemas (MemoryUpdate)
- `src/org.ts` — org and membership schemas: OrgCreate, OrgRename, Org, MemberRole, MemberRoleUpdate, InviteCreate
- `src/common.ts` — shared REST API primitives: pagination, OR+AND filter nodes, error response shape, paginated response wrapper

## Deno import pattern

The Supabase Edge Functions (Deno) cannot cross-import this Node package directly. The intended pattern is to use a per-function `deno.json` that maps `@lorekit/schemas/` to a relative path into the checked-out monorepo:

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

This lets the Edge Function import `import { ScopeSchema } from '@lorekit/schemas/scope';` without any build step, while sharing the exact same schema definitions as the Node package.

## Node import pattern

Node consumers use the path alias registered in `tsconfig.base.json`:

```ts
import { WriteInputSchema } from '@lorekit/schemas/memory.js';
import { ScopeSchema } from '@lorekit/schemas/scope.js';
```

Note the `.js` extension — required for Node ESM.
