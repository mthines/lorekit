# Plan — Generator Phase 3a: org tools for `lk_*` tokens (redo cleanly via the catalog)

> **Plan-only artifact.** Nothing here is implemented. A fresh session executes it later.

## Session bootstrap (read first)

- **Worktree / cwd:** `/Users/mthines/Workspace/lorekit.git/feat/api-token-surface-generator`
  (a `gw` worktree of `mthines/lorekit`). Do all work here. **Never** touch/`cd`/`gw clean` `…/main`.
- **Branch:** `feat/api-token-surface-generator` (stack: → `feat/api-token-scope-authorized-removal` → `feat/combobox-multi-select`, PR #490). Confirm with `git branch --show-current`.
- **First action:** verify anchors:
  `ls supabase/functions/mcp/mcp-handler.ts supabase/functions/mcp/tools.ts packages/schemas/src/tool-catalog.ts packages/mcp-core/src/permissions.ts supabase/migrations/00041_org_actor_override.sql`.
- **HARD DEPENDENCY:** Phase 2 (`plan-generator-phase2-codegen.md`) MUST already
  be landed — this plan makes its change *through* the catalog `surfaces`/`auth`/
  `permission` fields so it is one edit, not the 6-place ripple that got the
  manual version reverted.

## Context / background

The MCP `org.create` / `org.list` / `org.rename` / `org.delete` tools are still
**JWT-only**, even though the entire REST `/orgs*` surface already serves `lk_*`
API tokens on every route.

What already exists (do NOT re-plan):
- `00041_org_actor_override.sql` added a trailing `p_actor_user_id uuid default
  null` to 8 org RPCs, resolved via `lorekit_org_actor(p_actor_user_id)` =
  `auth.role()='service_role' ? coalesce(p_actor_user_id, auth.uid()) : auth.uid()`.
  An `authenticated` caller's `p_actor_user_id` is ignored; only a verified
  service_role JWT may name an actor. Fails closed on NULL actor.
- `supabase/functions/orgs/index.ts` serves `lk_*` tokens on **every** route with
  `requires: 'read' | 'write'` (list/get = read; create/rename/delete/members/
  invites mutations = write), each handler passing `p_actor_user_id: actorUserId(auth)`
  and adding an explicit membership/tenant predicate where it used to lean on RLS.
- `packages/cli/src/store/remote.mjs` already routes `orgCreate/orgList/orgRename/
  orgDelete` through REST (`/orgs*`) — no MCP transport left in that store.

What is STILL a gap:
- `supabase/functions/mcp/mcp-handler.ts` rejects api_key callers for any tool in
  `ORG_TOOLS` **before dispatch** (the `if (isOrgTool) { if (!isJwtAuth(auth)) …
  JSONRPC_FORBIDDEN }` block). Org tools are dispatched `(db, args, span)` — no
  `userId` is threaded to them.
- `supabase/functions/mcp/tools.ts` `toolOrgCreate/Rename/Delete` call their RPCs
  with NO `p_actor_user_id`, and `toolOrgList` does a direct
  `.from('org_members').select('role, orgs(...)')` that relies on RLS — which is
  bypassed for the service-role client an api_key caller gets, so it must be
  scoped by `user_id` explicitly.
- The catalog marks org tools `auth:'jwt-only'`, `permission:null`;
  `permissions.ts` has no org entries; `tool-catalog-parity.spec.ts` asserts
  `permission===null ⇒ auth==='jwt-only'`; `llms.txt` renders the JWT-only
  footnote; the CLI local `mcp-server.mjs` `ORG_TOOL_DEFS` describe them.

This exact change was prototyped and **REVERTED** off the removal branch because
the manual version needed a 6-place ripple: catalog `auth`/`permission`,
`permissions.ts`, the `tool-catalog-parity.spec.ts` model, the edge mirror,
`llms.txt`, and docs. Phase 2's catalog surface bindings collapse that to one
catalog edit + regenerate + the two edge behavioural edits (dispatcher gate +
handler actor/scoping). This plan does it THAT way.

### The target behaviour

- `org.list` → `permission: 'read'` (a `lk_ro_*` or `lk_rw_*` token may list).
- `org.create` / `org.rename` / `org.delete` → `permission: 'write'` (needs
  `lk_wo_*`/`lk_rw_*`). Token permission is orthogonal to org role — a `lk_rw_*`
  held by a viewer still cannot rename (the RPC's `lorekit_org_can` denies →
  LK002 → forbidden). This mirrors the REST router's own note.
- `auth: 'token-or-jwt'` for all four (JWT still works; api_key now also works).
- Dispatcher passes the resolved `userId` (`getUserId(auth)`) to org tools so they
  can send `p_actor_user_id: userId`. For a JWT caller `getUserId` is null and the
  RPCs fall back to `auth.uid()` — unchanged behaviour.
- `toolOrgList` must scope its `org_members` read by `user_id` for the api_key
  (service-role) path, since RLS is bypassed. A JWT caller keeps RLS-only scoping.

## Requirements

- **R1** [user-stated] Drop the JWT-only gate on `org.*` in `mcp-handler.ts`.
- **R2** [user-stated] Apply read/write permission: `org.list`=read; create/rename/delete=write — enforced by the same `toolRequires`/`canRead`/`canWrite` path the memory tools use.
- **R3** [user-stated] Pass `p_actor_user_id: userId` from the org tool handlers to their RPCs.
- **R4** [user-stated] Scope `toolOrgList`'s direct `org_members` read by `user_id` for api_key auth (service-role bypasses RLS); JWT auth stays RLS-scoped.
- **R5** [user-stated] Do it THROUGH the Phase-2 catalog so it is ONE edit: change `surfaces`/`auth`/`permission` in `tool-catalog.ts`, regenerate the manifest + mirror + `llms.txt`, and every parity spec re-derives.
- **R6** [user-stated] Update the catalog model + EVERY parity spec the change implies: the `permission===null ⇒ jwt-only` invariant in `tool-catalog-parity.spec.ts` must become "org tools carry a permission + `token-or-jwt`", and `permissions.ts` `READ_TOOLS`/`WRITE_TOOLS` gain the org entries.
- **R7** [derived] Preserve `org.delete` MCP semantics (SOFT delete via `lorekit_org_delete`) and the `resolveOrgId` slug→id lookup; do not regress to the CLI `mcp-server.mjs` description that says "cascade-deleted / unrecoverable" (that text is already wrong vs the edge — flag it, see Risks).
- **R8** [derived] The edge mirror (`_shared/schemas/tool-catalog.ts`, `mcp/permissions.ts`) stays byte-parity via the sync scripts.

## Decisions (defaults chosen)

- **D1 — org list = read, mutations = write.** Matches `orgs/index.ts` exactly
  (`GET /`=read, `POST/PATCH/DELETE`=write). This is the authoritative source.
- **D2 — dispatch signature.** Change `ORG_TOOLS` handlers to accept `userId`
  (either `(db, args, userId, span)` to match the memory family, or keep
  `(db, args, span)` and pass `userId` inside args-adjacent). Default: unify on
  `(db, args, userId, span)` so both maps look alike and the dispatcher passes
  `toolUserId`/`getUserId(auth)` uniformly. Update the `mcp-handler.ts` call site
  and all four `toolOrg*` signatures + their RPC calls.
- **D3 — `toolOrgList` scoping.** When `userId` is non-null (api_key), add
  `.eq('user_id', userId)` to the `org_members` select. When null (JWT), leave it
  RLS-scoped. Mirror the `applyTenantScope`/`memberOrgIds` posture already used by
  the memory read tools. (There is no `applyTenantScope` for `org_members`; a
  direct `.eq('user_id', userId)` is correct and is the same shape the REST
  `_shared/api/tenant.ts` uses.)
- **D4 — permission model in the catalog.** `org.list.permission='read'`,
  others `'write'`; all four `auth='token-or-jwt'`. `McpToolPermission` already
  allows `'read'|'write'|null` — org tools stop being `null`. The
  `render.ts` `renderPermissionMatrix` filters `permission!==null`, so org tools
  will now appear in the matrix rows; confirm the JWT-only footnote is removed or
  reworded (they are no longer JWT-only). This is a deliberate `llms.txt` diff.

## Acceptance criteria (verifiable)

- **AC1** (covers R1) An api_key (`lk_rw_*`) `tools/call` for `org.list` is NOT
  rejected by the dispatcher's org-JWT gate. The `if (!isJwtAuth(auth))` block for
  org tools is removed/replaced by the memory-family permission check path.
  - `kind: command`: `grep -n "org.* tools require Supabase JWT" supabase/functions/mcp/mcp-handler.ts` returns **nothing** (the JWT-only refusal string is gone).
- **AC2** (covers R2, R6) `permissions.ts` gates the org tools: `org.list` in
  `READ_TOOLS`, `org.create`/`org.rename`/`org.delete` in `WRITE_TOOLS`; and
  `tool-catalog-parity.spec.ts` passes with the new model (org tools have a
  permission + `token-or-jwt`).
  - `kind: command`: `corepack pnpm exec vitest run packages/mcp-core/src/tool-catalog-parity.spec.ts packages/mcp-core/src/permissions.spec.ts` passes.
- **AC3** (covers R3) All three write org handlers send `p_actor_user_id`.
  - `kind: command`: `grep -nc "p_actor_user_id" supabase/functions/mcp/tools.ts` is ≥ 3 (create/rename/delete; list too if it moves to an RPC — default it stays a table read).
- **AC4** (covers R4) `toolOrgList` scopes by `user_id` on the api_key path.
  - `kind: command`: `grep -n "eq('user_id'" supabase/functions/mcp/tools.ts` shows a match inside `toolOrgList` (verify by reading the function body).
- **AC5** (covers R5, R8) One catalog edit drives the rest; edge mirror + llms
  regenerate cleanly.
  - `kind: command`: `node scripts/sync-edge-schemas.mjs --check` exits 0.
  - `kind: command`: `node scripts/gen-surfaces.mjs --check` exits 0.
  - `kind: command`: `node --experimental-transform-types packages/schemas/src/llms/generate.ts --check` exits 0 AFTER regenerating (the permission-matrix change is committed).
- **AC6** (covers R2/R7 — behavioural) A SQL test section proves the org RPCs
  honour a service-role actor override end-to-end: an `lk_*`-shaped call (service
  role + `p_actor_user_id`) can `org.list`/`create`/`rename`/`delete` as that
  actor, and a viewer-role actor is denied `rename` (LK002). Add
  `migrations.test.sql` §85 (org actor via api_key surface).
  - `kind: command`: run the isolated-stack SQL harness (see Verification) and confirm §85 passes.
- **AC7** (covers R6) `mcp-authz-status.spec.ts` / `mcp-auth-tracing.spec.ts`
  still pass (the org tools now emit the same authz spans as memory tools).
  - `kind: command`: `corepack pnpm exec vitest run packages/mcp-core/src/mcp-authz-status.spec.ts packages/mcp-core/src/mcp-auth-tracing.spec.ts` passes.
- **AC8** (covers R7) `org.delete` MCP path still calls `lorekit_org_delete`
  (SOFT delete) and resolves slug→id first.
  - `kind: command`: `grep -n "lorekit_org_delete\|resolveOrgId" supabase/functions/mcp/tools.ts` shows both in `toolOrgDelete`.
- **AC9** (regression) The CLI `mcp-server.mjs` org passthrough still works and
  the four org tools are still advertised; CLI suite green.
  - `kind: command`: `node --test packages/cli/test/mcp-server.test.mjs` passes.

## File changes (concrete paths)

- **Edit** `packages/schemas/src/tool-catalog.ts` — the ONE conceptual edit:
  set `org.list` `permission:'read'`, `org.create/rename/delete` `permission:'write'`,
  all four `auth:'token-or-jwt'`; update their `surfaces` (Phase 2) if the binding
  encodes auth. Reword the org-tool descriptions if they claim JWT-only.
- **Edit** `packages/mcp-core/src/permissions.ts` — add `org.list` to `READ_TOOLS`,
  `org.create`/`org.rename`/`org.delete` to `WRITE_TOOLS`. Update the docblock.
- **Edit** `supabase/functions/mcp/permissions.ts` (mirror) — via
  `node scripts/sync-edge-schemas.mjs`? NO — `permissions.ts` is a MANUAL mirror
  (`limits.ts`/`created-at.ts` pattern, not the schema sync). Edit it by hand to
  match, keep `edge-parity.spec.ts` green.
- **Edit** `supabase/functions/mcp/mcp-handler.ts`:
  - Remove the `isOrgTool` JWT-only refusal block.
  - Route org tools through the same `toolRequires`/`canRead`/`canWrite` permission
    check as memory tools (org tools now have a non-null `toolRequires`).
  - Pass `toolUserId` (`getUserId(auth)`) into the `ORG_TOOLS[...]` call (D2).
  - Keep the scope-allowlist / account-wide refusal path memory-only (org tools
    carry no scope; ensure the scope checks are guarded so they don't run for org
    tools — they key off `toolArgs['scope']`/`scopes`, which org tools don't send,
    so they are inert, but confirm).
- **Edit** `supabase/functions/mcp/tools.ts`:
  - `toolOrgCreate/Rename/Delete`: accept `userId`, pass `p_actor_user_id: userId`
    to `lorekit_org_create` / `lorekit_org_rename` / `lorekit_org_delete`.
  - `toolOrgList`: accept `userId`; when non-null, `.eq('user_id', userId)` on the
    `org_members` select.
  - Update the file header comment that says org tools "REQUIRE a Supabase user
    JWT … receive -32001" — no longer true.
- **Edit** `packages/mcp-core/src/tool-catalog-parity.spec.ts` — replace the
  `permission===null ⇒ auth==='jwt-only'` invariant with the new one (org tools
  have a permission + `token-or-jwt`); ensure the read/write set assertions include
  the org tools. (If Phase 2 moved these to a manifest spec, edit there.)
- **Edit** `packages/schemas/src/llms/render.spec.ts` — update expectations if the
  permission matrix / footnote text changed.
- **Regenerate** `packages/web/public/llms.txt` (`generate.ts`), the surface
  manifest (`gen-surfaces.mjs`), and the edge mirror (`sync-edge-schemas.mjs`).
- **Edit** `packages/cli/src/mcp-server.mjs` — reword `ORG_TOOL_DEFS` descriptions
  that say "require JWT auth" / "cascade-deleted / unrecoverable" to match reality
  (soft delete; token-or-jwt). Keep dispatch unchanged (still proxies to REST).
- **Add** `supabase/tests/migrations.test.sql` §85 — org actor override via the
  service-role + `p_actor_user_id` path (AC6). Seed `auth.users` a1/b2/c3 + an org;
  assert list/create/rename/delete as actor, and a viewer denied rename.
- **Docs:** `docs/org-sharing.md`, `docs/mcp-tools.md`, `docs/api-tokens.md`,
  `docs/architecture.md`, `docs/decisions.md`, `packages/web/public/llms.txt`
  (generated) — update any statement that `org.*` is JWT-only. Run the sibling-name
  docs-drift greps (Risks) before claiming done.

## Verification

Run from the worktree root. No `timeout` on macOS.

1. Static/parity: `corepack pnpm exec vitest run packages/mcp-core/src/tool-catalog-parity.spec.ts packages/mcp-core/src/permissions.spec.ts packages/mcp-core/src/edge-parity.spec.ts packages/mcp-core/src/edge-schema-parity.spec.ts packages/mcp-core/src/mcp-authz-status.spec.ts packages/mcp-core/src/mcp-auth-tracing.spec.ts` — all green.
2. Regenerate + check: `node scripts/sync-edge-schemas.mjs --check`, `node scripts/gen-surfaces.mjs --check`, `node --experimental-transform-types packages/schemas/src/llms/generate.ts --check`.
3. CLI: `node --test packages/cli/test/mcp-server.test.mjs`.
4. **SQL (isolated stack, MANDATORY for AC6)** — the removal-branch pattern:
   - Edit `supabase/config.toml` ports by +100 (studio/api/db/etc.) so this run
     never disturbs another worktree's stack.
   - `supabase start -x studio,imgproxy,storage-api,realtime,edge-runtime,logflare,vector,pooler,inbucket`
   - `supabase db reset`
   - `psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/migrations.test.sql`
     (DB_URL from `supabase status`). Expect §85 to pass. NOTE the pre-existing,
     unrelated failure around `migrations.test.sql` ~line 2685 (an anon-grant
     assertion on `lorekit_org_members_list` from PR #266) — CI runs green;
     verify §85 specifically rather than trusting a clean overall exit.
   - `supabase stop` and `git checkout supabase/config.toml` to restore ports.
5. Edge Deno type/lint runs in CI (no local Deno harness assumed). Rely on CI for
   the `supabase/functions/**` Deno checks; do a manual read-through of
   `tools.ts`/`mcp-handler.ts` diffs for `noUnusedParameters`-style issues.

## Risks & mitigations

- **Reintroducing the 6-place ripple / partial edit** (the reason this was
  reverted). *Mitigation:* Phase-2 dependency is hard; drive from the catalog and
  regenerate; the parity specs (AC2/AC5) fail if any surface is missed.
- **`toolOrgList` cross-tenant leak** — forgetting `.eq('user_id', userId)` on the
  service-role path would list every org's memberships. *Mitigation:* AC4 grep +
  AC6 SQL test with two users; read the function body to confirm the predicate is
  reachable (not returned-around).
- **Permission-matrix / footnote diff in `llms.txt`** surprising a reviewer.
  *Mitigation:* it is intended; call it out in the PR body and update
  `render.spec.ts` expectations (AC5).
- **CLI `mcp-server.mjs` description drift** — it currently claims org tools need
  JWT and that delete is a hard cascade. *Mitigation:* R7/AC-file-change reword;
  do not leave contradictory copy (lesson:
  `instruction-file-fixes-contradict-siblings-not-opened-in-the-same-edit` — open
  every file that states the org-auth fact in the same edit).
- **Scope-allowlist path accidentally applied to org tools** in the dispatcher.
  *Mitigation:* org tools send no `scope`/`scopes`, so the checks are inert, but
  guard the branch explicitly (org tools skip the memory scope/account-wide block).
- **Docs-drift on sibling surfaces.** *Mitigation:* grep the sibling terms
  (`org.list`, `jwt-only`, "dashboard session") across `docs/`, `README.md`,
  bundled skill rule files + generated plugin mirrors, root `CLAUDE.md`; regenerate
  mirrors with the sync script.

## Dependencies / ordering

- **Depends on Phase 2** (catalog surface bindings + `gen-surfaces.mjs` + manifest
  gate). Do not start 3a until Phase 2 is green.
- Independent of 3b/3c/3d, but 3b (members + invites) shares the "org tools now
  serve tokens" premise — land 3a first so 3b builds on token-capable org tooling.
