# Plan — Generator Phase 2: catalog-driven surface codegen

> **Plan-only artifact.** This file is a resumable execution plan. Nothing here
> has been implemented. A fresh session executes it later.

## Session bootstrap (read first — you have no memory of the planning conversation)

- **Worktree / cwd:** `/Users/mthines/Workspace/lorekit.git/feat/api-token-surface-generator`
  (a `gw` worktree of `mthines/lorekit`, the LoreKit agent-memory system). Do
  **all** work here. **Never** touch, `cd` into, or `gw clean` the `…/main`
  worktree — run any worktree command from the gw root or another worktree.
- **Branch:** `feat/api-token-surface-generator`, stacked on
  `feat/api-token-scope-authorized-removal`, itself stacked on
  `feat/combobox-multi-select` (open PR #490). Nothing is committed on the two
  feature branches yet — prior work is present as uncommitted/staged changes
  carried into each worktree. **Confirm branch before editing:**
  `git -C <worktree> branch --show-current`.
- **First action:** `cd` to the worktree and verify anchors exist:
  `ls packages/schemas/src/tool-catalog.ts packages/mcp-core/src/tool-catalog-parity.spec.ts packages/mcp-core/src/surface-parity.spec.ts scripts/sync-edge-schemas.mjs supabase/functions/mcp/mcp-handler.ts`.
- **This Phase 2 plan MUST land before Phases 3a–3d** — those plans do their
  edits *through* the catalog surface bindings this plan introduces. See
  "Dependencies / ordering".

## Context / background

LoreKit exposes the same set of `memory.*` / `org.*` operations across **four**
surfaces, each wired by hand and each able to drift from the others:

1. **Canonical catalog** — `packages/schemas/src/tool-catalog.ts`. Zero-import
   TS. Already the single declaration for the MCP wire (`tools/list` via
   `toWireTool`/`wireTools`) and the `llms.txt` docs (via
   `packages/schemas/src/llms/render.ts`). Mirrored verbatim into
   `supabase/functions/_shared/schemas/tool-catalog.ts` by
   `scripts/sync-edge-schemas.mjs` (guarded by `edge-schema-parity.spec.ts`).
2. **Edge MCP dispatch** — `supabase/functions/mcp/mcp-handler.ts` has
   hand-maintained `MEMORY_TOOLS` and `ORG_TOOLS` dispatch maps + a `tools/call`
   authz block. Runtime permission gating lives in
   `packages/mcp-core/src/permissions.ts` (`READ_TOOLS`/`WRITE_TOOLS`), mirrored
   to `supabase/functions/mcp/permissions.ts`.
3. **CLI dispatch (human)** — `packages/cli/bin/lorekit.mjs` (`switch` on
   command, `HUMAN_COMMANDS` set, `COMMAND_ALIASES`, `KNOWN_FLAGS`, and a large
   per-command `HELP`/`COMMAND_HELP` block), talking to REST via
   `packages/cli/src/store/remote.mjs`.
4. **CLI local stdio MCP server** — `packages/cli/src/mcp-server.mjs` has its
   OWN duplicated `MEMORY_TOOL_DEFS` + `ORG_TOOL_DEFS` + `MEMORY_DISPATCH` +
   `ORG_DISPATCH`. This is a third copy of the tool list that nothing currently
   cross-checks against the catalog.

Today the only automated coupling is:
- `tool-catalog-parity.spec.ts`: catalog ↔ `permissions.ts`, and catalog ↔ the
  edge `MEMORY_TOOLS`/`ORG_TOOLS` dispatch maps (regex-scraped from handler
  source).
- `surface-parity.spec.ts` (added on THIS branch, Phase 1): every `memory.*`
  catalog tool maps to a CLI command **or a documented exemption**
  (`MCP_TO_CLI` hand-map, with `{ exempt }` entries for `list_archived`, `purge`,
  `purge_expired`). Its own docblock says: "When the generator emits both
  surfaces from the catalog (Phase 2), the mapping below becomes a generated
  artifact and this hand-written gate can retire."

**Phase 2 goal:** make the catalog the single source of *surface bindings* —
which of {mcp, cli, rest} exposes each op, the CLI command name + aliases, and
the handler binding — and add a generator (`scripts/gen-surfaces.mjs`, with
`--check`, mirroring `sync-edge-schemas.mjs`) plus a completeness gate that
**absorbs** `surface-parity.spec.ts` and **extends** `tool-catalog-parity.spec.ts`.
The generator must keep the edge mirror and every existing parity spec green.

### Scope decision (READ THIS — it bounds the whole plan)

There are two possible ambitions for "codegen":

- **(A) Data-model + assertion generator (RECOMMENDED, this plan's default).**
  The catalog gains per-op `surfaces` bindings. `gen-surfaces.mjs` emits a
  single generated, committed **manifest** (`surface-manifest.generated.*`) that
  the specs and (optionally) the runtime dispatch maps read, plus `--check` to
  fail CI when the manifest is stale — exactly the `sync-edge-schemas.mjs`
  shape. The hand-written dispatch maps in `mcp-handler.ts` / `lorekit.mjs` /
  `mcp-server.mjs` are **not** machine-rewritten; instead the completeness gate
  asserts they equal the manifest (the audit-vocabulary pattern already used by
  `tool-catalog-parity.spec.ts`). This is low-risk, preserves the "add a tool =>
  a test fails until you wire it" ergonomics, and is what makes 3a–3d one-edit
  changes.
- **(B) Full emitter that rewrites the dispatch source.** Rejected for Phase 2:
  rewriting hand-maintained TS/JS dispatch with generated blocks is a large blast
  radius (function *bindings* — actual imported symbols — cannot be expressed in
  a zero-import catalog), and the byte-for-byte edge mirror + `noUnusedParameters`
  build make generated source fragile. If pursued later it is a separate plan.

**This plan implements (A).** Every acceptance criterion below is written against
(A). If a future maintainer wants (B), re-plan it.

## Requirements

- **R1** [user-stated] Extend `tool-catalog.ts` with per-op **surface bindings**:
  for each tool, which of `mcp` / `cli` / `rest` expose it, the CLI command name
  + aliases, and the handler binding (as a *name/string*, since the catalog is
  zero-import and cannot hold function references).
- **R2** [user-stated] Add `scripts/gen-surfaces.mjs` with a `--check` mode,
  mirroring `scripts/sync-edge-schemas.mjs`'s structure (pure transform fns +
  `main()` + `--check` staleness exit 1 + self-invoke guard).
- **R3** [user-stated] The generator emits, from the catalog: the MCP dispatch
  map (data form), the CLI command table (data form), the `tools/list` payload
  (already `wireTools()` — assert it still derives from the catalog), and the
  docs (already `llms.txt` via `render.ts` — assert unchanged / regenerated).
- **R4** [user-stated] A completeness gate **replaces/absorbs**
  `surface-parity.spec.ts` and **extends** `tool-catalog-parity.spec.ts`, so a
  new tool cannot land on one surface without a conscious catalog edit.
- **R5** [user-stated] Keep the edge mirror + ALL existing parity specs green:
  `edge-schema-parity.spec.ts`, `edge-parity.spec.ts`,
  `tool-catalog-parity.spec.ts`, `tenant-scope-usage.spec.ts`,
  `rest-route-parity.spec.ts`, `rest-tool-name.spec.ts`, `list-view-parity.spec.ts`,
  `permissions.spec.ts`, `usage-client-parity.spec.ts`, plus the CLI test suite.
- **R6** [user-stated] Telemetry is INHERITED, not per-op: confirm (in the plan
  and in a guard/assertion) that generated ops flow through the central MCP
  span/usage wrapper (`mcp-handler.ts` `toolSpan` + `recordUsageEvent`) and CLI
  `traceCommand` (`lorekit.mjs`), so adding an op via the catalog does not
  require touching telemetry.
- **R7** [derived] The catalog stays **zero-import** (a `zod`/relative import
  breaks both the edge mirror parity and the bare-checkout generator — see the
  `tool-catalog.ts` header and `edge-bare-specifier.spec.ts`). Surface bindings
  must be plain data.
- **R8** [derived] `gen-surfaces.mjs` must run on a **bare checkout with no
  `node_modules`** (same constraint as `generate.ts`/`sync-edge-schemas.mjs`): no
  runtime deps, node builtins only.
- **R9** [process] The generated manifest is **committed** and mirrored into the
  edge tree if any edge code reads it (see Decisions D3); `--check` is added to
  the same CI job that runs the existing `--check` scripts.

## Decisions (resolve before writing code; defaults chosen)

- **D1 — Binding shape.** Add an optional `surfaces` field to `McpToolDoc`:
  ```ts
  interface SurfaceBinding {
    readonly mcp: boolean;                 // dispatched by the edge MCP handler
    readonly cli: string | null;           // canonical CLI command, or null
    readonly cliAliases?: readonly string[];
    readonly rest?: string | null;         // REST route pattern, e.g. 'POST /purge', or null
    readonly handler: string;              // dispatch symbol NAME, e.g. 'toolPurge'
    readonly cliExempt?: string;           // documented reason cli is null but that's intentional
  }
  ```
  Rationale: `handler` is a *string name*, honouring R7. The spec resolves the
  name→function by asserting the hand-written map's keys/handler-names equal the
  catalog's, never by importing.
- **D2 — Where the CLI command metadata lives.** The CLI `bin/lorekit.mjs`
  cannot import `@lorekit/schemas` at runtime easily (it is a published npm
  package with its own bundling; check `packages/cli/package.json` deps). Default:
  the generator emits a small committed **data** file the CLI test imports
  (`packages/cli/src/surface-manifest.generated.mjs` — plain object, zero-dep),
  and the CLI dispatch/HELP stays hand-written but is *asserted* against it. Do
  NOT machine-rewrite `bin/lorekit.mjs`.
- **D3 — Manifest location + edge mirror.** Emit
  `packages/schemas/src/surface-manifest.generated.ts` (source of truth, derived
  from the catalog) and, if any edge function needs it, add it to
  `MIRRORED_SCHEMA_FILES` in `sync-edge-schemas.mjs`. Default: the edge does NOT
  need it (dispatch stays hand-written + asserted), so do **not** mirror it —
  keep the mirrored surface minimal (that file's own comment says so). Re-confirm
  during execution.
- **D4 — Retire vs keep `surface-parity.spec.ts`.** Absorb its three assertions
  into the extended `tool-catalog-parity.spec.ts` (or a new
  `surface-manifest-parity.spec.ts`) so the coverage is not lost, then delete
  `surface-parity.spec.ts`. The `MCP_TO_CLI` hand-map becomes the generated
  `surfaces.cli` field. Confirm the `list_archived` exemption survives as
  `cliExempt`.

## Acceptance criteria (verifiable)

> Each AC is checkable by a command. `kind: command` ACs are the executable
> `checks.yaml` (see below). "covers" ties each AC back to a requirement.

- **AC1** (covers R1, R7) `tool-catalog.ts` declares a `surfaces` binding for
  **every** entry in `MCP_TOOLS`, and the file still imports nothing.
  - `kind: command`: `corepack pnpm exec vitest run packages/mcp-core/src/tool-catalog-parity.spec.ts` passes, including a new case asserting `MCP_TOOLS.every(t => t.surfaces)` and that `surfaces.handler` is a non-empty string for each.
  - `kind: command`: `grep -nE "^import |from ['\"]" packages/schemas/src/tool-catalog.ts` returns **no** import lines (still zero-import).
- **AC2** (covers R2, R8) `scripts/gen-surfaces.mjs` exists, exports pure
  transform fn(s), has a `main()` + `--check` + self-invoke guard mirroring
  `sync-edge-schemas.mjs`, and runs on node builtins only.
  - `kind: command`: `node scripts/gen-surfaces.mjs` writes the manifest and exits 0.
  - `kind: command`: `node scripts/gen-surfaces.mjs --check` exits 0 immediately after a fresh generate.
  - `kind: command`: `node -e "const m=require('node:module');"` — smoke that the script has no bare non-builtin `import` (grep: `grep -nE "from ['\"](?!node:)[^./]" scripts/gen-surfaces.mjs` returns nothing).
- **AC3** (covers R3) The generated manifest reproduces the MCP dispatch map keys,
  the CLI command table, and matches `wireTools()` / catalog order.
  - `kind: command`: the extended parity spec asserts `manifest.mcp` keys `===` catalog names where `surfaces.mcp`, and `manifest.cli` `===` catalog names→command where `surfaces.cli`.
- **AC4** (covers R4, R5, D4) The completeness gate lives in
  `tool-catalog-parity.spec.ts` (extended) and/or
  `surface-manifest-parity.spec.ts`; `surface-parity.spec.ts` is deleted and its
  three assertions are preserved in the new gate.
  - `kind: command`: `test ! -f packages/mcp-core/src/surface-parity.spec.ts`.
  - `kind: command`: the new/extended spec, when run, includes assertions equivalent to the old three (every `memory.*` mapped; every non-exempt mapping is a real CLI `case`; anti-vacuity that the CLI switch parsed). Prove by deleting one `case` in a scratch copy → the spec goes red (do NOT commit the scratch change).
- **AC5** (covers R5) The full affected spec set is green:
  `corepack pnpm exec vitest run packages/mcp-core/src/tool-catalog-parity.spec.ts packages/mcp-core/src/edge-schema-parity.spec.ts packages/mcp-core/src/edge-parity.spec.ts packages/mcp-core/src/permissions.spec.ts packages/mcp-core/src/rest-tool-name.spec.ts packages/mcp-core/src/list-view-parity.spec.ts packages/schemas/src/llms/render.spec.ts` all pass.
- **AC6** (covers R5) The edge mirror is in sync: `node scripts/sync-edge-schemas.mjs --check` exits 0 (the `tool-catalog.ts` change is mirrored).
- **AC7** (covers R3) `llms.txt` regenerates with no unexpected diff:
  `node --experimental-transform-types packages/schemas/src/llms/generate.ts --check` exits 0 (surface bindings are docs-invisible unless the plan chose to render them; default: not rendered, so no `llms.txt` change).
- **AC8** (covers R6) A telemetry-inheritance guard asserts the central wrappers
  still bracket every dispatched op: a spec (extend `mcp-auth-tracing.spec.ts` or
  add `surface-telemetry.spec.ts`) that greps `mcp-handler.ts` for the single
  `toolSpan`/`recordUsageEvent` bracket around `MEMORY_TOOLS[...]`/`ORG_TOOLS[...]`
  dispatch, and greps `bin/lorekit.mjs` that every `HUMAN_COMMANDS` command is
  dispatched via `traceCommand(`.
  - `kind: command`: `corepack pnpm exec vitest run packages/mcp-core/src/mcp-auth-tracing.spec.ts` passes.
- **AC9** (covers R5) CLI suite green: `node --test packages/cli/test/*.test.mjs`
  (or at minimum `cli.test.mjs`, `remove.test.mjs`, and any new
  surface-manifest test) passes.
- **AC10** (covers R9) A `--check` invocation of `gen-surfaces.mjs` is added to
  the same CI workflow step that runs `sync-edge-schemas.mjs --check` /
  `generate.ts --check` (find it under `.github/workflows/`).
  - `kind: command`: `grep -rn "gen-surfaces.mjs" .github/workflows/` returns a `--check` invocation.

## File changes (concrete paths)

- **Edit** `packages/schemas/src/tool-catalog.ts`
  - Add `SurfaceBinding` interface + `surfaces` field on `McpToolDoc`.
  - Populate `surfaces` for all 15 tools. Encode the current reality:
    - `memory.write` → `{ mcp:true, cli:'write', rest:'POST /', handler:'toolWrite' }`
    - `memory.read` → `{ mcp:true, cli:'show', rest:'GET /', handler:'toolRead' }`
    - `memory.list` → `{ mcp:true, cli:'list', cliAliases:['ls'], rest:'GET /', handler:'toolList' }`
    - `memory.delete` → `{ mcp:true, cli:'delete', cliAliases:['rm'], rest:'DELETE /', handler:'toolDelete' }`
    - `memory.search` → `{ mcp:true, cli:'search', cliAliases:['grep'], rest:'POST /search', handler:'toolSearch' }`
    - `memory.archive` → `{ mcp:true, cli:'archive', rest:'DELETE /', handler:'toolArchive' }`
    - `memory.scopes` → `{ mcp:true, cli:'scopes', rest:'GET /scopes', handler:'toolScopes' }`
    - `memory.list_archived` → `{ mcp:true, cli:null, cliExempt:'surfaced via `list --archived`', rest:'GET /?archived=true', handler:'toolListArchived' }`
    - `memory.restore` → `{ mcp:true, cli:'restore', rest:'POST /restore', handler:'toolRestore' }`
    - `memory.purge` → `{ mcp:true, cli:null, cliExempt:'KNOWN GAP — slated for Phase 3c', rest:'POST /purge', handler:'toolPurge' }`
    - `memory.purge_expired` → `{ mcp:true, cli:null, cliExempt:'KNOWN GAP — Phase 3c', rest:'POST /purge-expired', handler:'toolPurgeExpired' }`
    - `org.create`/`org.list`/`org.rename`/`org.delete` → `{ mcp:true, cli:null, cliExempt:'org.* exposed via local mcp-server passthrough, not a lorekit subcommand', rest:'…', handler:'toolOrgCreate' … }`
    - (Encode the CURRENT `auth:'jwt-only'` for org tools; Phase 3a flips it.)
- **Add** `scripts/gen-surfaces.mjs` — pure `toManifest(catalog)` +
  `expectedManifest()` + `main()` (`--check`) + self-invoke guard. Structure is a
  near-copy of `scripts/sync-edge-schemas.mjs`.
- **Add** `packages/schemas/src/surface-manifest.generated.ts` (or `.mjs` per
  D2/D3) — the emitted artifact, committed, with a GENERATED banner + regenerate
  instruction.
- **Add** `packages/mcp-core/src/surface-manifest-parity.spec.ts` OR extend
  `packages/mcp-core/src/tool-catalog-parity.spec.ts` — completeness gate
  (absorbs the three `surface-parity.spec.ts` assertions), manifest freshness,
  MCP-map/CLI-table equivalence.
- **Delete** `packages/mcp-core/src/surface-parity.spec.ts` (its coverage moves
  per D4).
- **Edit (assertion only, if D2 needs it)** `packages/cli/test/*.test.mjs` — a new
  test that the CLI `HUMAN_COMMANDS`/`COMMAND_ALIASES` match the manifest's
  `cli`/`cliAliases`.
- **Edit** `scripts/sync-edge-schemas.mjs` — ONLY if D3 flips to mirror the
  manifest (default: no change; the `tool-catalog.ts` edit is already mirrored by
  the existing `tool-catalog.ts` entry).
- **Edit** `.github/workflows/<the check workflow>` — add `gen-surfaces.mjs --check`.
- **Possibly edit** `packages/mcp-core/src/mcp-auth-tracing.spec.ts` (or add
  `surface-telemetry.spec.ts`) for AC8.
- **Docs:** run the docs-drift greps (see Risks) — `docs/mcp-tools.md`,
  `docs/architecture.md`, `docs/key-files.md`, `packages/cli/README.md`,
  `CLAUDE.md` package map. A new script + generated file likely wants a
  `docs/key-files.md` line and a mention in `docs/architecture.md`'s "surfaces"
  narrative.

## Verification

Run from the worktree root. macOS has **no `timeout`** — do not wrap commands in it.

1. `corepack pnpm exec vitest run packages/mcp-core/src/tool-catalog-parity.spec.ts packages/mcp-core/src/edge-schema-parity.spec.ts packages/mcp-core/src/edge-parity.spec.ts packages/mcp-core/src/permissions.spec.ts packages/mcp-core/src/rest-tool-name.spec.ts packages/mcp-core/src/list-view-parity.spec.ts` — all green (AC1, AC3, AC4, AC5).
2. `corepack pnpm exec vitest run packages/schemas/src/llms/render.spec.ts` — green (AC7 companion).
3. `node scripts/gen-surfaces.mjs && node scripts/gen-surfaces.mjs --check` — write then confirm fresh (AC2).
4. `node scripts/sync-edge-schemas.mjs --check` — edge mirror in sync (AC6).
5. `node --experimental-transform-types packages/schemas/src/llms/generate.ts --check` — `llms.txt` unchanged (AC7).
6. `node --test packages/cli/test/cli.test.mjs packages/cli/test/remove.test.mjs` (+ any new surface-manifest CLI test) — green (AC9).
7. **Guard-bites proof (lesson: `mock-that-reimplements-the-thing-under-test`):**
   for the completeness gate and manifest-freshness check, temporarily perturb
   the real artifact (remove one `case` in `bin/lorekit.mjs`, or hand-edit the
   generated manifest) and confirm the spec flips **red**, then restore. A gate
   that stays green through a real perturbation asserts nothing. Do NOT commit
   the perturbation.
8. Whole-package sanity (optional, RAM-aware — run sequentially, not in
   parallel): `corepack pnpm exec vitest run packages/mcp-core` and
   `corepack pnpm exec vitest run packages/schemas`.

## Risks & mitigations

- **Catalog gains an import by accident** (breaks edge mirror + bare-checkout
  generator). *Mitigation:* AC1's grep + the existing `edge-bare-specifier.spec.ts`;
  keep `surfaces` plain data with string `handler`.
- **Manifest drift undetected** (the classic "mock re-implements the thing").
  *Mitigation:* AC4/AC10 make `--check` a CI gate; Verification step 7 proves the
  gate bites; the manifest is *derived from* the catalog, and the spec compares
  the hand-written dispatch to the manifest, never a re-encoded literal.
- **Docs-drift on sibling surfaces** (lesson: grep sibling NAMES, not just the
  command string). *Mitigation:* before claiming no doc drift, grep BOTH the new
  names (`gen-surfaces`, `surface-manifest`) AND an existing sibling
  (`sync-edge-schemas`) across `docs/`, `packages/cli/README.md`, bundled skill
  rule files + their generated plugin mirrors, and root `CLAUDE.md`. Regenerate
  any mirror with the repo's sync script — never hand-edit.
- **`noUnusedParameters` / TS6133 build strictness** if a generated `.ts` is
  added (the schemas package is type-checked). *Mitigation:* keep the generated
  file free of unused locals; run `pnpm nx typecheck schemas` (or the repo's
  typecheck target) before finishing.
- **CLI is a published package** and may not resolve `@lorekit/schemas` at
  runtime. *Mitigation:* D2 — the CLI reads a committed zero-dep `.mjs` manifest,
  not the workspace package; dispatch stays hand-written and only *asserted*.
- **Over-reach into option (B)** (rewriting dispatch source). *Mitigation:* this
  plan is (A) only; if tempted, stop and re-plan.

## Dependencies / ordering

- **Precedes 3a, 3b, 3c, 3d.** All four Phase-3 plans perform their surface edits
  *through* the `surfaces` bindings + manifest this plan introduces, so they are
  one-edit-plus-regenerate changes instead of the 6-place ripple that got 3a
  reverted before. Land Phase 2 first.
- **Depends on** the removal branch's `surface-parity.spec.ts` (present on this
  branch) — this plan absorbs and deletes it.
- Independent of the removal-branch finalize plan
  (`.agent/feat/api-token-scope-authorized-removal/…`), which can land in parallel.
