# Adding an operation

**How-to.** You are adding a new capability that agents or the dashboard call —
a new MCP tool, CLI command, or REST route (or some combination). LoreKit's
operation surface is declared once, in one catalog, and projected/mirrored out
to every runtime that cannot import it directly. Skipping a step in this
checklist is how a tool ships on MCP but 404s on REST, or passes every test
except the one gate that actually catches the gap.

Read [`CLAUDE.md`](../CLAUDE.md) → "Key decisions" → "The tool catalog is the
single origin of the operation SURFACE" first if you have not — this doc is the
step-by-step procedure behind that decision.

## 1. Decide which surfaces the operation needs

Every operation is declared with a `surfaces` binding
(`packages/schemas/src/shared/tool-catalog.ts`, `SurfaceBinding`):

- `mcp: boolean` — does the MCP server dispatch it?
- `cli: string | null` — the `lorekit` subcommand, or `null`.
- `rest?: string | null` — the representative REST route (documentation of the
  binding, not something generated from).
- `handler: string` — the exported symbol name in `supabase/functions/mcp/tools.ts`.

**Absence from a surface is a decision, not an oversight, and it must be
justified with a string:**

- `cliExempt` — required whenever `cli` is `null`. Say why the CLI does not (or
  should not) expose this operation. Examples already in the catalog:
  `memory.list_archived` is `cliExempt: 'surfaced as a flag on an existing
  command — lorekit list --archived — not a command of its own'`; every `org.*`
  mutation is exempt because org management reaches the CLI through the local
  stdio MCP server, not a `lorekit` subcommand.
- `localMcpExempt` — required whenever the CLI's local stdio MCP server (`lorekit
  mcp`) does not dispatch the operation against the offline store. Account-wide
  sweeps (`memory.purge`, `memory.purge_expired`) are `localMcpExempt` because
  the offline `.lorekit/` store has no equivalent concept.

A tool with no `cliExempt` and no `cli` binding is a bug the generator will not
catch on its own — it is a documentation/reviewer question, so put the
justification in the catalog entry where a reviewer will actually read it.

## 2. The ordered checklist

Work top to bottom. Each step names the exact file(s) and the gate that would
catch a mistake at that step.

1. **Catalog** — add the operation to `MCP_TOOLS` in
   `packages/schemas/src/shared/tool-catalog.ts`: `name`, `description`,
   `inputSchema`, `permission` (`'read' | 'write' | null`), `auth`
   (`'token-or-jwt' | 'jwt-only'`), `surfaces` (with `cliExempt`/`localMcpExempt`
   as needed per step 1), `returns`, `notes`. This file is zero-import by
   construction (mirrored into the self-contained Deno edge runtime and read by
   a generator on a bare checkout) — never add an import to it.
2. **Regenerate the surface projections** — the catalog cannot be imported by
   two consumers, so a generator projects it for them:
   ```bash
   node scripts/codegen/gen-surfaces.mjs           # CLI surfaces.generated.mjs + edge tool-dispatch.generated.ts
   node scripts/codegen/sync-edge-schemas.mjs       # mirrors packages/schemas/src/** into supabase/functions/_shared/schemas/**
   ```
   **Never hand-edit a `*.generated.*` file or the `_shared/schemas/` mirror.**
   `gen-surfaces.mjs --check` and `edge-schema-parity.spec.ts` fail the build if
   either drifts from what the generator produces.
3. **Pure core logic** — if the operation has real logic beyond a straight DB
   call, write it as a pure module in `packages/mcp-core/src/**` (unit-testable,
   no I/O) and mirror it self-contained into `supabase/functions/_shared/**` (the
   edge tree cannot cross-import `mcp-core` — Deno/Node incompatibility).
   **Register the new mirror pair in `packages/mcp-core/src/edge/edge-parity.spec.ts`'s
   `MIRRORS` array** so a future edit to one copy that forgets the other fails a
   test instead of silently drifting.
4. **Edge handler** — export the function named in the catalog's
   `surfaces.handler` from `supabase/functions/mcp/tools.ts`, modelled on the
   nearest existing handler (see "Existing Code Survey" note below — find a
   neighbour before writing from scratch). A generated guard asserts every
   catalog `handler` name is actually exported from this file.
5. **REST route(s)** — if `surfaces.rest` names a route, register it in the
   appropriate edge function's `index.ts` (usually `supabase/functions/memories/`),
   with a handler under `handlers/`. **Route order matters**: literal
   single-segment routes (`/search`, `/restore`, …) must be registered BEFORE
   `/:id` — `matchPath` matches on segment count and returns every match, first
   registered wins on a method collision. Map the route in BOTH copies of
   `rest-tool-name.ts` (`packages/mcp-core/src/rest/rest-tool-name.ts` and
   `supabase/functions/_shared/rest/rest-tool-name.ts`) — an unmapped route falls
   back to a `.unmapped` bucket in usage analytics, which is how a forgotten
   mapping is caught in production instead of code review.
   Two structural guards fire automatically on a new mutating route (no
   registration needed, they parse `index.ts`'s own route table): every
   mutating (unsafe method, not `requires: 'read'`) handler must call
   `isDryRunHeader(...)` before its first write
   (`dry-run-coverage.spec.ts`), and must call `recordAudit`/`recordAuditDeferred`
   (`audit-coverage.spec.ts`).
6. **CLI** — add a row to `packages/cli/src/commands.mjs`'s `COMMANDS` array and
   a handler under `packages/cli/src/commands/*.mjs`, modelled on the nearest
   neighbour (`commands/purge.mjs` for an account-wide sweep,
   `commands/remove.mjs` for a scope+key mutation). The CLI is a **zero-dependency**
   published package — never add a workspace import (`@lorekit/schemas`,
   `@lorekit/core`) to anything under `packages/cli/src/`. `surface-parity.test.mjs`
   cross-checks every catalog `cli`/`cliExempt` binding against this registry.
7. **Permissions, in BOTH mirrors** — add the operation name to `READ_TOOLS` or
   `WRITE_TOOLS` in **both** `packages/mcp-core/src/auth/permissions.ts` and
   `supabase/functions/mcp/permissions.ts`. This duplication is deliberate and
   load-bearing — it is the authorization control itself, so it is never derived
   from the catalog. `tool-catalog-parity.spec.ts` cross-checks the catalog's
   `permission` field against both mirrors.
8. **Audit vocabulary**, if the operation performs a security/data-affecting
   mutation — a **three-part** change, all in one commit:
   1. `packages/schemas/src/domain/audit.ts` — add the action(s) to `AUDIT_ACTIONS`.
   2. `packages/web/src/lib/audit-actions.ts` — add to both the `AUDIT_ACTIONS`
      union AND `AUDIT_ACTION_META` (label, badge colour, icon). The web package
      re-declares rather than imports (`@lorekit/schemas` is not a web dependency).
   3. A **new** migration that drops and re-adds `audit_log_action_check` with
      the WHOLE widened list (a CHECK cannot be widened in place — forward-only,
      following `00023`/`00027`/`00042`/`00070`'s pattern).
   `audit-vocabulary.spec.ts` parses the newest such migration and fails if any
   of the three disagree. `recordAudit`/`recordAuditEvent` never throw on a
   rejected action — a skipped migration here is a **silent** hole in the audit
   trail, not a loud failure, which is exactly why the spec exists.
9. **Usage events** — do nothing extra. They are recorded once per surface, in
   the MCP dispatcher and in the REST router (via `rest-tool-name.ts`, step 5) —
   never add a per-handler `recordUsageEvent` call.
10. **Docs** — the catalog's `description`/`notes` feed `llms.txt` automatically;
    regenerate with `pnpm nx generate:llms schemas`
    (`packages/schemas/src/llms/render.spec.ts` fails if the committed file
    drifts). Add or update the relevant page under
    `packages/web/src/content/docs/*.mdx` plus its
    `packages/web/src/lib/docs/sections.ts` entry (`sections.spec.ts` guards
    drift), and update `docs/README.md`'s index table and `README.md`'s package
    map if the capability is user-facing.

## 3. Gates that catch a missed step

Run these locally before opening a PR — CI runs the same suite, but a local
failure is cheaper to fix:

| Gate | What it catches |
|------|------------------|
| `node scripts/codegen/gen-surfaces.mjs --check` | Stale CLI/edge-dispatch projections |
| `node scripts/codegen/sync-edge-schemas.mjs --check` | Stale `_shared/schemas/` mirror |
| `pnpm nx test schemas` (`surface-generator.spec.ts`, `render.spec.ts`) | Generated artifacts + `llms.txt` drift |
| `pnpm nx test mcp-core` (`tool-catalog-parity.spec.ts`, `permissions.spec.ts`, `audit-vocabulary.spec.ts`, `edge-parity.spec.ts`, `edge-schema-parity.spec.ts`, `dry-run-coverage.spec.ts`, `audit-coverage.spec.ts`, `mcp-authz-status.spec.ts`) | Permission-mirror drift, audit vocabulary drift, pure-module mirror drift, missing dry-run/audit wiring |
| `pnpm nx test cli` (`surface-parity.test.mjs`, `frameworks.test.mjs`) | CLI registry vs catalog binding drift |
| `node scripts/ci/deno-check-functions.mjs --node-modules-dir=none` | Type errors in the edge tree — **nothing else typechecks it** |
| `pnpm nx test web` (`sections.spec.ts`) | Missing/malformed docs registry entry |

## 4. Worked example

Adding a hypothetical `memory.pin` (write) that has no CLI verb of its own
(surfaced as `lorekit protect`/`lorekit unprotect` instead) and a REST route:

```ts
// packages/schemas/src/shared/tool-catalog.ts
{
  name: 'memory.protect',
  description: 'Mark or unmark a lesson as protected from automated grooming',
  permission: 'write',
  auth: 'token-or-jwt',
  surfaces: { mcp: true, cli: 'protect', rest: 'POST /protect', handler: 'toolProtect' },
  inputSchema: {
    type: 'object',
    required: ['scope', 'key', 'protected'],
    properties: { scope, key, protected: { type: 'boolean', description: 'Whether the lesson is protected.' } },
  },
  returns: '`{ "protected": boolean }`',
},
```

Then, in order: regenerate (step 2); write `toolProtect` in `tools.ts` (step 4);
register `POST /protect` in `memories/index.ts` + `handlers/protect.ts`, and map
it in both `rest-tool-name.ts` copies (step 5); add the `protect` command to
`commands.mjs` + `commands/protect.mjs` (step 6); add `memory.protect` to
`WRITE_TOOLS` in both `permissions.ts` copies (step 7); add `memory.protect` to
the audit vocabulary's three parts (step 8); run the gate table (step 3).

This exact operation — plus `policy.*` and `groom.*` for scoped, automated
grooming — is what retention policies exercised this checklist against; see
that feature's `plan.md` (`.agent/feat/retention-policies/`) for the full trace.
