# Plan — Finalize the scope-authorized-removal branch → stacked draft PR

> **Plan-only artifact.** Nothing here is implemented. A fresh session executes it later.

## Session bootstrap (read first — you have no memory of the planning conversation)

- **Worktree / cwd for THIS plan:**
  `/Users/mthines/Workspace/lorekit.git/feat/api-token-scope-authorized-removal`
  (a `gw` worktree of `mthines/lorekit`). Do the commit/verify/PR work HERE, on
  the `feat/api-token-scope-authorized-removal` branch. **Never** touch/`cd`/
  `gw clean` the `…/main` worktree.
- **Branch stack:** `feat/api-token-scope-authorized-removal` is stacked on
  `feat/combobox-multi-select` (open PR #490 — "scope an API key from the
  dashboard, and enforce it end to end"). At planning time BOTH branches sit at
  the same base commit `614e0690` and the removal work is present as
  **uncommitted / staged changes** in this worktree; nothing is committed on the
  feature branch yet. `feat/api-token-surface-generator` is stacked ON TOP of this
  branch — so this PR is the MIDDLE of a three-PR stack (#490 → this → surface-gen).
- **First action:** `cd` to the worktree and confirm state:
  `git branch --show-current` → `feat/api-token-scope-authorized-removal`;
  `git status --short` (expect the removal changes below as uncommitted);
  `git log --oneline -1` (expect the base `614e0690`).
- **Use `gw`, not raw `git worktree`.** Create no new worktrees for this plan.

## Context / background — what this PR ships (all DONE + verified, do NOT re-plan)

The change lets a SCOPED `lk_*` API token archive/delete/restore ANY writer's row
WITHIN its allowlisted scopes, while an unscoped key and any non-service-role
caller stay own-rows-only (preserving the 00046 IDOR closure); and it adds an
`existed` signal so a 0-row op reports `not_found` vs `forbidden`. Concretely:

- **Migrations** `supabase/migrations/00070_api_token_scope_authorized_removal.sql`
  and `00071_api_token_scope_authorized_restore.sql`: extend `memory_delete` and
  `restore_memory` (both SECURITY DEFINER) with the
  `v_scope_managed := auth.role()='service_role' AND array_length(p_key_scopes,1)
  IS NOT NULL` widening + an `existed` return column. `restore_memory` is DROPped
  from its old `returns uuid` 3-arg form and recreated as
  `(uuid,text,text,text[],text,uuid[]) returns table(restored,existed)`.
- **Edge MCP tools** `supabase/functions/mcp/tools.ts`: `toolArchive`,
  `toolDelete`, `toolRestore` route through `memory_delete`/`restore_memory` (no
  raw service-role `.update()/.delete()`), pass `keyScoping`, and map `existed` →
  `reason: 'forbidden' | 'not_found'`.
- **REST handlers** `supabase/functions/memories/handlers/remove.ts`,
  `restore.ts`: the personal `scope+key` form routes through the RPCs (the `/:id`
  form stays direct); `existed` → 403 vs 404.
- **CLI:** `lorekit archive | delete | restore` subcommands
  (`packages/cli/src/remove.mjs`, wired in `packages/cli/bin/lorekit.mjs` with the
  `rm` alias); a `restore` method on `packages/cli/src/store/remote.mjs`. Test:
  `packages/cli/test/remove.test.mjs` (5 tests, green).
- **Tests:** `supabase/tests/migrations.test.sql` §83 (delete/archive) + §84
  (restore) — verified against a real local Postgres; drift guards in
  `packages/mcp-core/src/tenant-scope-usage.spec.ts` updated (the 5 `p_key_scopes`
  MCP call sites; the `REMOVAL_TOOLS` mapping guard; `REST_RPC_WRITES` now includes
  `restore`).

**Expected uncommitted set in this worktree** (from the planning snapshot):
`M packages/cli/bin/lorekit.mjs`, `M packages/cli/src/store/remote.mjs`,
`M packages/mcp-core/src/tenant-scope-usage.spec.ts`,
`M supabase/functions/mcp/tools.ts`,
`M supabase/functions/memories/handlers/remove.ts`,
`M supabase/functions/memories/handlers/restore.ts`,
`M supabase/tests/migrations.test.sql`,
`?? packages/cli/src/remove.mjs`, `?? packages/cli/test/remove.test.mjs`,
`?? supabase/migrations/00070_api_token_scope_authorized_removal.sql`,
`?? supabase/migrations/00071_api_token_scope_authorized_restore.sql`.
(**NOT** `packages/mcp-core/src/surface-parity.spec.ts` — that belongs to the
surface-generator branch, not this one. If it shows up here, it leaked from the
stacked worktree; do NOT include it in this PR.)

## Requirements

- **R1** [user-stated] Commit the removal work on `feat/api-token-scope-authorized-removal`.
- **R2** [user-stated] Run FULL verification: all affected vitest specs, the SQL
  sections (§83/§84) in isolation, and the edge Deno checks in CI.
- **R3** [user-stated] Open the DRAFT PR stacked on #490 (base =
  `feat/combobox-multi-select`).
- **R4** [user-stated] Note the BYOD follow-up: mirror `00070`/`00071` into
  `supabase/byod/bootstrap.sql` (its `memory_delete` + `restore_memory` are the
  pre-widening own-rows-only forms) and into the `mcp-core` Node `delete.ts` /
  `archive.ts` (currently unchanged / own-rows-only). This PR does NOT implement
  the follow-up — it records it (PR body + a tracked note).
- **R5** [derived] Only this branch's changes land in this PR — exclude anything
  belonging to `feat/combobox-multi-select` (already in #490) or
  `feat/api-token-surface-generator` (the parent/child stack).
- **R6** [process] Open the PR via the repo's `/create-pr` → `/polish` flow, NOT
  a bare `gh pr create` — the polish quality gate must run before the PR opens.

## Acceptance criteria (verifiable)

- **AC1** (covers R1, R5) The removal work is committed on the branch as one (or a
  small number of) focused commits, containing EXACTLY the expected set above and
  nothing from the sibling branches.
  - `kind: command`: `git status --short` is clean after commit.
  - `kind: command`: `git diff --name-only feat/combobox-multi-select...HEAD` lists only the 10 removal files (no `surface-parity.spec.ts`, no combobox files).
- **AC2** (covers R2) All affected vitest specs pass:
  `corepack pnpm exec vitest run packages/mcp-core/src/tenant-scope-usage.spec.ts`
  (the updated drift guards — 5 `p_key_scopes` MCP call sites, `REMOVAL_TOOLS`,
  `REST_RPC_WRITES` with `restore`, and the account-wide guard) is green.
  - `kind: command`: `corepack pnpm exec vitest run packages/mcp-core/src/tenant-scope-usage.spec.ts` exits 0.
- **AC3** (covers R2) The CLI removal suite passes:
  - `kind: command`: `node --test packages/cli/test/remove.test.mjs` — 5 tests green.
  - `kind: command`: `node --test packages/cli/test/cli.test.mjs` — regression green.
- **AC4** (covers R2) The SQL sections §83/§84 pass against a real local Postgres,
  run in ISOLATION (the removal-branch pattern) so the pre-existing unrelated
  failure near `migrations.test.sql` ~line 2685 (anon grant on
  `lorekit_org_members_list`, from PR #266 — CI runs it green) does not mask the
  result.
  - `kind: command`: isolated-stack run (see Verification) with §83 and §84 asserting green.
- **AC5** (covers R2) No edge/mcp-core parity guard regressed by the removal work:
  `corepack pnpm exec vitest run packages/mcp-core/src/edge-parity.spec.ts packages/mcp-core/src/tool-catalog-parity.spec.ts packages/mcp-core/src/rest-tool-name.spec.ts packages/mcp-core/src/rest-route-parity.spec.ts` all green.
- **AC6** (covers R3, R6) A DRAFT PR is open with base `feat/combobox-multi-select`
  (stacked on #490), opened through `/create-pr` → `/polish` (not bare `gh`).
  - `kind: command`: `gh pr view --json isDraft,baseRefName,headRefName` shows `isDraft:true`, `baseRefName:"feat/combobox-multi-select"`, `headRefName:"feat/api-token-scope-authorized-removal"`.
- **AC7** (covers R4) The PR body has a "Follow-ups (not in this PR)" section
  naming the BYOD mirror (`supabase/byod/bootstrap.sql` `memory_delete` +
  `restore_memory`) and the Node mirror (`packages/mcp-core/src/tools/delete.ts` +
  `archive.ts`), and a LoreKit lesson OR a tracking note is recorded so the
  follow-up is not lost.
  - `kind: command`: `gh pr view --json body | grep -iE "byod|bootstrap.sql|delete.ts|archive.ts"` matches.
- **AC8** (covers R6) CI on the draft PR is watched to green (or the only red is
  the KNOWN pre-existing ~line-2685 SQL assertion, if CI runs the full
  `migrations.test.sql` — but per the context CI runs it GREEN, so any red there
  is a real regression to investigate, NOT to wave off). Independently verify any
  "infra flake" claim via `gh pr view --json statusCheckRollup` before dismissing.

## Verification

Run from the removal-branch worktree root. macOS has **no `timeout`** — do not wrap.

1. **CLI:** `node --test packages/cli/test/remove.test.mjs packages/cli/test/cli.test.mjs` (AC3).
2. **Drift guards + parity:** `corepack pnpm exec vitest run packages/mcp-core/src/tenant-scope-usage.spec.ts packages/mcp-core/src/edge-parity.spec.ts packages/mcp-core/src/tool-catalog-parity.spec.ts packages/mcp-core/src/rest-tool-name.spec.ts packages/mcp-core/src/rest-route-parity.spec.ts` (AC2, AC5).
3. **SQL isolated stack (AC4)** — the removal-branch pattern (so this run never
   disturbs another worktree's Supabase stack):
   - Edit `supabase/config.toml` ports by **+100** (api, db, studio, etc.).
   - `supabase start -x studio,imgproxy,storage-api,realtime,edge-runtime,logflare,vector,pooler,inbucket`
   - `supabase db reset` (applies migrations 00001…00071).
   - `psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/migrations.test.sql`
     (DB_URL from `supabase status`). Confirm **§83** and **§84** pass. The run may
     halt at the pre-existing ~line-2685 anon-grant assertion (unrelated, from PR
     #266); if so, confirm §83/§84 executed and passed BEFORE that point, or run a
     scratch copy of the file with only §83/§84 to isolate them. Do NOT "fix" the
     2685 assertion here — it is out of scope and CI runs it green.
   - `supabase stop`; `git checkout supabase/config.toml` to restore ports.
4. **Edge Deno checks:** no local Deno harness is assumed — rely on CI for the
   `supabase/functions/**` Deno type/lint. Before pushing, read-through the
   `tools.ts` / `remove.ts` / `restore.ts` diffs for unused-param / type issues.
5. **PR flow (AC6):** run `/create-pr` (which pushes the branch, opens the draft,
   then runs the review-loop) with base pinned to `feat/combobox-multi-select`.
   Do NOT `gh pr create` directly. If sub-agent dispatch (`Task`) is unavailable
   so `/create-pr`'s reviewer step can't run, that is a DEGRADED path — record it
   in the PR/《Degraded》line and still open the draft; fetch the PR's own review
   threads (not only a dispatched reviewer) before considering it review-clean.
6. **CI watch (AC8):** after the draft opens, watch checks; investigate any red
   with `gh pr view --json statusCheckRollup` rather than assuming a flake.

## PR description (draft skeleton — keep ≤ ~25 lines, narrative)

- **What:** scoped `lk_*` tokens can now archive/delete/restore any writer's row
  within their allowlisted scopes; unscoped keys and non-service-role callers stay
  own-rows-only. Adds `existed` → `not_found`/`forbidden`.
- **Why:** the owner scoped the key deliberately; managing the whole scope is the
  authority scoping grants. Closes the "can't tell already-gone from not-yours"
  ambiguity.
- **How:** `memory_delete`/`restore_memory` gain the `v_scope_managed` widening +
  `existed`; MCP tools + REST scope+key handlers route through the RPCs; CLI gains
  `archive`/`delete`/`restore`.
- **Safety:** the 00046 IDOR closure is preserved — both conjuncts of
  `v_scope_managed` are load-bearing (service_role gate + non-empty allowlist).
- **Tests:** migrations §83/§84 (real Postgres), CLI `remove.test.mjs`, drift
  guards in `tenant-scope-usage.spec.ts`.
- **Follow-ups (NOT in this PR):** mirror 00070/00071 into
  `supabase/byod/bootstrap.sql` (`memory_delete` still lacks `existed` + the
  widening; `restore_memory` is still the `returns uuid` own-rows-only form) and
  into the Node `packages/mcp-core/src/tools/delete.ts` + `archive.ts` (still
  own-rows-only). Stacked on #490.

## BYOD follow-up — concrete scope (for AC7's note; NOT implemented here)

- `supabase/byod/bootstrap.sql` `memory_delete(uuid,text,text,text,boolean,text[],text,uuid[])`
  currently `returns table(deleted, archived)` and filters `where user_id =
  p_user_id` only. To mirror 00070 (BYOD has no orgs, so no org clause): add the
  `existed` return column and the personal-branch `v_scope_managed` widening
  (`auth.role()='service_role' AND array_length(p_key_scopes,1) IS NOT NULL`, row
  filter `or v_scope_managed` — no `lorekit_api_token_org_allowed` since BYOD has
  no orgs).
- `supabase/byod/bootstrap.sql` `restore_memory(uuid,text,text) returns uuid` →
  rewrite to the 00071 shape `(uuid,text,text,text[],text,uuid[]) returns
  table(restored,existed)` with the same personal-only widening. Update the
  trailing `grant execute on function restore_memory(...)` signature.
- `packages/mcp-core/src/tools/delete.ts` + `archive.ts` (the Node/BYOD-Node
  library path) are own-rows-only and unchanged; decide whether the Node path
  even reaches the scope-managed case (it uses a pre-scoped db + RLS, not the
  service-role RPC path) — the follow-up plan must confirm before mirroring.
- These are a SEPARATE PR (own threat-model review), tracked as a LoreKit lesson
  (`repo::mthines/lorekit`) or an issue.

## Risks & mitigations

- **Cross-branch contamination in the commit** (staged surface-gen or combobox
  files). *Mitigation:* AC1 diff-name check against `feat/combobox-multi-select`;
  explicitly `git add` only the 10 removal paths; verify with
  `git diff --cached --name-only` before committing.
- **The ~line-2685 pre-existing SQL failure masking §83/§84.** *Mitigation:* AC4
  — verify §83/§84 executed+passed specifically; do not trust an overall exit code.
- **Bare `gh pr create` skipping the polish gate** (a recorded past failure).
  *Mitigation:* R6/AC6 — go through `/create-pr` → `/polish`.
- **A second reviewer's threads left unread before undraft/merge** (recorded
  failure: a repo bot commented on every push, none read). *Mitigation:* fetch the
  PR's own review threads (not only a dispatched reviewer) before considering it
  review-clean; this PR opens as DRAFT so merge is not imminent.
- **Wrongly dismissing a CI red as an infra flake.** *Mitigation:* AC8 — verify via
  `statusCheckRollup` before dismissing.
- **BYOD divergence forgotten.** *Mitigation:* R4/AC7 — recorded in the PR body +
  a durable lesson/issue.

## Dependencies / ordering

- **Base = `feat/combobox-multi-select` (PR #490).** This PR is the middle of the
  stack; `feat/api-token-surface-generator` is stacked on top of it. Land/rebase
  order: #490 → this → surface-gen. If #490 merges to main first, rebase this
  branch's base to `main` before undrafting.
- Independent of the Phase-2/3 generator plans in
  `.agent/feat/api-token-surface-generator/` (those live on the child branch).
