# Plan / Decision Record — Generator Phase 3d: analytics reads on MCP/CLI?

> **Plan-only artifact + decision record.** Nothing is implemented. This captures
> a recommendation and, if overridden, the minimal path.

## Session bootstrap (read first)

- **Worktree / cwd:** `/Users/mthines/Workspace/lorekit.git/feat/api-token-surface-generator`
  (`gw` worktree of `mthines/lorekit`). **Never** touch/`cd`/`gw clean` `…/main`.
- **Branch:** `feat/api-token-surface-generator` (stack → `…-scope-authorized-removal` → `feat/combobox-multi-select`, PR #490).
- **First action (if pursued):** `ls supabase/functions/memories/handlers/{usage,tags,facets,activity,read-activity,relevant}.ts packages/schemas/src/tool-catalog.ts`.
- **DEPENDENCY (only if pursued):** Phase 2.

## Context / background

The REST `memories` function exposes several **analytics reads** that have NO MCP
tool and no CLI command:

| REST route | handler | `rest-tool-name.ts` name | MCP tool? | CLI? |
|---|---|---|---|---|
| `GET /usage` | `handleUsage` | `memory.usage` | none | none |
| `GET /tags` | `handleTags` | `memory.tags` | none | none |
| `GET /facets` | `handleFacets` | `memory.facets` | none | none |
| `GET /activity` | `handleActivity` | `memory.activity` | none | none |
| `GET /read-activity` | `handleReadActivity` | `memory.read-activity` | none | none |
| `GET /relevant` | `handleRelevant` | `memory.relevant` | via `memory.list order=rank` | via `remote.relevant()` |

`/relevant` is already covered functionally: MCP's `memory.list order=rank` and
the CLI's `remote.relevant()` (used by the SessionStart-hook ranking path) both
answer the "what is worth reading" question. So `/relevant` is NOT part of this
decision — it is done.

The five remaining (`usage`, `tags`, `facets`, `activity`, `read-activity`) are
**dashboard telemetry / Explorer drill-down** reads. They power the web
dashboard's charts and filters (usage-over-time, tag facets, activity heatmaps).
They are aggregate reads keyed by `scope_type` or tag/time buckets, not
lesson-CRUD.

## The decision

**Recommendation: DO NOT add `usage` / `tags` / `facets` / `activity` /
`read-activity` to MCP or the CLI.** Rationale:

1. **They are dashboard telemetry, not agent primitives.** An agent's job is to
   read/write *lessons* (the `memory.*` CRUD + `list order=rank` shortlist). Usage
   rollups, tag facets, and activity heatmaps are humans-looking-at-a-dashboard
   concerns. The dashboard (`packages/web`) already renders them from these
   routes. No agent workflow in the repo consumes them.
2. **Tool-list bloat degrades the agent.** Every tool added to `tools/list` costs
   context and adds a choice the model can get wrong. Five analytics tools that no
   loop calls is negative-value surface area — the exact "always-heavy" anti-pattern
   the tool catalog's minimalism guards against.
3. **The completeness gate does not force them.** `surface-parity.spec.ts` /
   Phase-2's manifest gate only require **catalogued MCP tools** to map to a CLI
   command. These REST routes are NOT MCP tools, so leaving them REST-only creates
   no parity violation. `rest-tool-name.ts` already names them for usage-event
   aggregation; that is the only cross-surface coupling and it is satisfied.
4. **CLI has adjacent affordances already.** `lorekit stats` / `lorekit scopes` /
   `lorekit list` cover the "what do I have" question a human at a terminal asks;
   the deep analytics belong in the dashboard where they are visualised.

**Action for Phase 3d: record this as a decision, add a short note to the surface
docs so the omission is deliberate-not-accidental, and add (if Phase 2's manifest
supports it) a `surfaces` annotation marking these REST routes as
`intentionallyRestOnly: 'dashboard analytics'` so a future audit does not re-flag
them.** No new tools, no new CLI commands.

## Requirements

- **R1** [user-stated] Produce a short decision record on whether to surface
  `tags`/`facets`/`activity`/`usage` (and `read-activity`) on MCP/CLI.
- **R2** [user-stated] Recommendation is NOT to add them (dashboard telemetry,
  tool bloat) — capture the rationale.
- **R3** [user-stated] If pursued anyway, capture the minimal path.
- **R4** [derived] Make the omission explicit so the Phase-2 completeness gate /
  a future surface audit treats it as intentional, not a gap.

## Acceptance criteria (verifiable)

- **AC1** (covers R1, R2, R4) A decision is recorded in the repo's decisions doc
  (`docs/decisions.md`) stating the five analytics reads stay REST-only, with the
  rationale, and (if Phase-2 manifest supports it) the catalog/manifest annotates
  them `intentionallyRestOnly`.
  - `kind: command`: `grep -niE "analytics.*rest-only|rest-only.*analytics|dashboard telemetry" docs/decisions.md` matches the new entry.
- **AC2** (covers R4) No parity/completeness spec regresses by the decision (the
  routes were never MCP tools; nothing forces them on).
  - `kind: command`: `corepack pnpm exec vitest run packages/mcp-core/src/tool-catalog-parity.spec.ts packages/mcp-core/src/rest-tool-name.spec.ts` passes unchanged.
- **AC3** (covers R2) The recommendation is discoverable next to the other surface
  docs (a one-liner in `docs/mcp-tools.md` and/or `docs/architecture.md` noting
  the analytics reads are dashboard-only).
  - `kind: command`: `grep -niE "usage|tags|facets|activity" docs/mcp-tools.md` shows the "REST/dashboard-only, not exposed as agent tools" note.

## If pursued anyway — the minimal path (NOT recommended)

Only if the user overrides the recommendation. The minimal, lowest-bloat path:

- **Do NOT add per-metric tools.** Adding five tools is the worst option. If
  anything, add ONE read-only inspection tool, e.g. `memory.stats`, that returns
  a compact rollup (counts by scope_type + top tags) — a single, agent-legible
  summary rather than five dashboard endpoints. This keeps `tools/list` growth to
  one entry.
- **CLI:** surface via flags on the existing `stats` command
  (`lorekit stats --tags` / `--activity`) rather than new top-level commands, so
  the human-facing surface does not sprout five analytics verbs.
- **Wiring (per op, through Phase-2 catalog):**
  - Add the tool to `tool-catalog.ts` with `surfaces` binding + `permission:'read'`.
  - Add a `toolStats` handler in `supabase/functions/mcp/tools.ts` calling the same
    RPC the REST handler calls, passing `p_key_scopes` where the drift guard
    (`tenant-scope-usage.spec.ts` RPC-backed reads list) requires it — note
    `usage` is deliberately excluded from that guard because it emits no scope
    NAME (rolls up by `scope_type`), so a `usage`-derived tool must keep that
    property or the guard's exclusion list must be revisited.
  - Add the dispatch-map entry + permission-set entry + regenerate manifest/mirror/llms.
  - `remote.mjs` method + CLI flag + tests + SQL section if a new RPC path is hit.
- **Cost to acknowledge:** each analytics tool is context the model pays for every
  session and a scope-leak surface (`facets`/`tags`/`activity` are name-bearing —
  they MUST pass `p_key_scopes`, unlike `usage`). This is exactly the risk the
  recommendation avoids.

## File changes (concrete paths)

- **Recommended path:**
  - **Edit** `docs/decisions.md` — add the decision entry (AC1).
  - **Edit** `docs/mcp-tools.md` and/or `docs/architecture.md` — one-line note that
    the analytics reads are dashboard/REST-only (AC3).
  - **Optional edit** `packages/schemas/src/tool-catalog.ts` — if the Phase-2
    binding shape has an `intentionallyRestOnly` annotation, mark the five routes
    (only if the catalog models REST-only routes at all; if the catalog is
    MCP-tools-only, skip and rely on the decisions doc).
- **If pursued (not recommended):** the wiring list above — `tool-catalog.ts`,
  `permissions.ts` (+ mirror), `mcp-handler.ts`, `tools.ts`, `remote.mjs`,
  `bin/lorekit.mjs` (or `stats.mjs`), new CLI test, `migrations.test.sql` section
  if a name-bearing RPC is newly reached, regenerate manifest/mirror/llms, docs.

## Verification

Run from the worktree root. No `timeout` on macOS.

- Recommended path: `corepack pnpm exec vitest run packages/mcp-core/src/tool-catalog-parity.spec.ts packages/mcp-core/src/rest-tool-name.spec.ts` (AC2), and the doc greps (AC1, AC3). No stack/SQL run needed.
- If pursued: the full Phase-3-style verification (parity specs + regenerate `--check` + CLI tests + isolated-stack SQL for any name-bearing RPC).

## Risks & mitigations

- **Tool-list bloat** (the reason to say no). *Mitigation:* the recommendation
  itself; if overridden, cap at ONE summary tool, not five.
- **Scope leak via name-bearing analytics** (`facets`/`tags`/`activity`).
  *Mitigation:* if pursued, they MUST pass `p_key_scopes` (the RPC-backed-reads
  drift guard in `tenant-scope-usage.spec.ts` enforces this for REST; an MCP twin
  would need the same). `usage` is the only one exempt (no scope name).
- **Silent re-flagging** by a future surface audit. *Mitigation:* AC1/AC4 record
  the decision so the omission is documented intent.

## Dependencies / ordering

- Recommended path depends on nothing (pure docs + decision) and can land any
  time, but is cleanest AFTER Phase 2 so the decisions doc can reference the
  manifest's `intentionallyRestOnly` concept if it exists.
- If pursued, depends on Phase 2 like 3a–3c.
