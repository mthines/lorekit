# Plan — Generator Phase 3b: org members + invites on MCP + CLI

> **Plan-only artifact.** Nothing here is implemented. A fresh session executes it later.

## Session bootstrap (read first)

- **Worktree / cwd:** `/Users/mthines/Workspace/lorekit.git/feat/api-token-surface-generator`
  (`gw` worktree of `mthines/lorekit`). Do all work here. **Never** touch/`cd`/`gw clean` `…/main`.
- **Branch:** `feat/api-token-surface-generator` (stack → `…-scope-authorized-removal` → `feat/combobox-multi-select`, PR #490). Confirm with `git branch --show-current`.
- **First action:** verify anchors:
  `ls supabase/functions/orgs/handlers/members/ supabase/functions/orgs/handlers/invites/ supabase/functions/mcp/tools.ts packages/schemas/src/tool-catalog.ts packages/schemas/src/member.ts packages/schemas/src/invite.ts`.
- **DEPENDENCIES:** land **Phase 2** (catalog surface bindings + generator) and
  **Phase 3a** (org tools serve tokens) first. This plan adds *new* org
  sub-resource tools/commands and assumes the token-capable org surface from 3a.

## Context / background

The REST `orgs` function already exposes org MEMBERS and INVITES sub-resources,
and all serve `lk_*` tokens (via `actorUserId(auth)` + explicit membership gates,
per `00041` + `orgs/index.ts`):

- **Members:** `GET /:slug/members` (`handleListMembers` → RPC
  `lorekit_org_members_list`), `PATCH /:slug/members/:userId` (`handleChangeRole`
  → RPC `lorekit_org_member_role`, body `{ role }`), `DELETE /:slug/members/:userId`
  (`handleRemoveMember` → RPC `lorekit_org_member_remove`, or `lorekit_org_leave`
  for self). Response shapes: list → `{ entries: [{ user_id, handle, avatar_url,
  role, joined_at }] }`; change-role → `{ slug, userId, role }`; remove → 204.
- **Invites:** `GET /:slug/invites` (`handleListInvites` → direct `org_invites`
  select, gated on the `invite` capability; a plain member gets `{ entries: [] }`),
  `POST /:slug/invites` (`handleCreateInvite` → RPC `lorekit_org_invite`, body
  `CreateInviteBodySchema` = `{ email?, handle?, role }` with exactly one of
  email/handle, role excludes `owner`, default `member`; returns
  `{ inviteId }`), `DELETE /:slug/invites/:inviteId` (`handleRevokeInvite` → RPC
  `lorekit_org_invite_revoke`). Response shapes from `packages/schemas/src/member.ts`
  (`OrgMemberListResponseSchema`) and `invite.ts` (`OrgInviteListResponseSchema`,
  `CreateInviteBodySchema`).

There are **no MCP tools and no CLI subcommands** for members or invites today.
`rest-tool-name.ts` already names these routes with the `member.*` audit-action
vocabulary (`member.role_change`, `member.remove`, `member.invite`,
`member.revoke`) — there is a naming precedent to reuse.

**Known safe RPC invariants (already enforced server-side, do not re-implement):**
- Admin cannot act on owner/admin targets; last owner cannot be removed/demoted;
  owner role is non-assignable via change-role (v1); revoke only a pending invite.
- Self-removal via API token currently fails closed (LK002/403) because
  `lorekit_org_leave` got no actor override in 00041 — a documented gap, not a bug
  to fix here.

## BLAST-RADIUS FLAG (user-requested — resolve explicitly)

These operations let an autonomous agent holding an `lk_rw_*` token **remove org
members and revoke invites** — destructive, people-facing, and easy to trigger by
mistake from a agent loop. This is materially higher-stakes than memory CRUD.
The plan MUST decide a guard posture, not silently ship parity:

- **Reads** (`org.members.list`, `org.invites.list`) — low risk; ship as normal
  `read`-permission tools/commands.
- **Additive writes** (`org.invite`) — medium risk; ship as `write`, but with
  clear tool descriptions.
- **Destructive writes** (`org.member.remove`, `org.member.set_role`,
  `org.invite.revoke`) — HIGH risk. **Default recommendation:** gate them behind
  an explicit opt-in so they are NOT reachable by default:
  - **MCP:** keep them OFF the default catalog OR mark them with a new
    `surfaces` flag (Phase 2) `dangerous: true` and require a server-side env/flag
    (e.g. `LOREKIT_ENABLE_ORG_MEMBER_WRITES`) checked in the dispatcher; absent →
    the tool is not advertised in `tools/list` and `tools/call` returns a clear
    "disabled" error.
  - **CLI:** require an interactive confirmation (a `y/N` prompt) unless `--yes`
    is passed, mirroring `migrate`'s dry-run-by-default posture. `--json`/non-TTY
    without `--yes` refuses rather than auto-confirming.
  - The RPC invariants (last-owner, admin-vs-owner) are the backstop, but the
    opt-in is the "an agent should not remove a teammate on a whim" guard.

If the executor (or user) decides parity-without-opt-in is acceptable, that is a
conscious choice to record in the plan's Decisions + PR body — do not default to it.

## Requirements

- **R1** [user-stated] New MCP tools + CLI commands for **members**: list,
  change-role, remove.
- **R2** [user-stated] New MCP tools + CLI commands for **invites**: list, create,
  revoke.
- **R3** [user-stated] Built over the EXISTING REST/RPC surface — no new
  migrations, no new RPCs, no new REST routes. The CLI store calls `/orgs/:slug/*`;
  the MCP tools call the same RPCs the REST handlers call (or, simpler and
  drift-free, the MCP tools call the REST routes via the same client the org tools
  use — decide in D2).
- **R4** [user-stated] FLAG the blast radius and propose a guard/opt-in for the
  destructive ops (see the section above). The plan's Decisions must record the
  chosen posture.
- **R5** [derived] Do it THROUGH the Phase-2 catalog: new tools get `surfaces`
  bindings; the completeness gate + `permissions.ts` + edge mirror + `llms.txt`
  re-derive.
- **R6** [derived] Reuse the `member.*` naming from `rest-tool-name.ts` /
  audit-log actions; do not invent a third vocabulary.
- **R7** [derived] Response shapes match the schemas (`member.ts`, `invite.ts`);
  the CLI `--json` output and the MCP `tools/call` payload must be a published,
  stable shape (the same discipline `remote.mjs` org methods follow).

## Decisions (defaults chosen — CONFIRM before coding)

- **D1 — tool names.** MCP: `org.members.list`, `org.members.set_role`,
  `org.members.remove`, `org.invites.list`, `org.invites.create`,
  `org.invites.revoke`. (Dot-hierarchical, consistent with `memory.list_archived`
  style; the parity spec's dispatch-map regex `'([a-z_]+\.[a-z_]+)'` currently
  matches ONE dot — a three-segment `org.members.list` will NOT match it, so the
  regex in `tool-catalog-parity.spec.ts`/`surface-manifest-parity.spec.ts` must be
  widened to `[a-z_]+(?:\.[a-z_]+)+`. Flag this in the file-changes.) Alternative:
  flat `org.member_list` etc. to avoid the regex change — decide D1 explicitly.
- **D2 — MCP handler implementation.** Two options:
  - **(a)** New `toolOrgMembersList` etc. in `supabase/functions/mcp/tools.ts`
    calling the SAME RPCs the REST handlers call (`lorekit_org_members_list`,
    `lorekit_org_member_role`, `lorekit_org_member_remove`, `lorekit_org_invite`,
    `lorekit_org_invite_revoke`) + the direct `org_invites` select for list, each
    passing `p_actor_user_id: userId` and the membership gate. Most faithful; more
    code duplicated from the REST handlers.
  - **(b)** MCP tools proxy to the REST routes via a service-side fetch. Rejected —
    the edge function calling its own sibling function over HTTP is fragile.
  - **Default: (a).** Mirror the REST handlers' logic (slug→org_id lookup,
    `isOrgMember` gate, `hasOrgCapability` for invite list, RPC call, audit).
    Extract the shared slug→id + membership-gate helper if it reduces the copy.
- **D3 — destructive-op guard.** Default: opt-in per the BLAST-RADIUS section
  (env flag for MCP dispatch; `--yes` confirmation for CLI). Record the decision.
- **D4 — CLI command surface.** Add a `lorekit org` command group:
  `lorekit org members [--org <slug>]`, `lorekit org set-role <slug> <userId> <role>`,
  `lorekit org remove-member <slug> <userId>`, `lorekit org invites <slug>`,
  `lorekit org invite <slug> --email|--handle <x> [--role member]`,
  `lorekit org revoke-invite <slug> <inviteId>`. OR flat top-level commands. Decide
  D4; default is a nested `org` group to avoid polluting the top-level command
  namespace. Whichever is chosen must round-trip through the manifest gate (a nested
  group changes how `surface-manifest-parity.spec.ts` matches CLI commands — Phase 2's
  gate assumed one `switch` `case` per command; a subcommand group needs the gate
  taught about it).
- **D5 — self-removal.** MCP/CLI `remove-member` targeting yourself hits the
  `lorekit_org_leave` gap (403 under a token). Surface the server's error verbatim;
  do NOT special-case it. Document as a known gap (follow-up: give
  `lorekit_org_leave` an actor override — separate migration).

## Acceptance criteria (verifiable)

- **AC1** (covers R1, R2, R5) The six new tools exist in the catalog with
  `surfaces` bindings and correct `permission` (list=read; create/set_role/remove/
  revoke=write) and `auth:'token-or-jwt'`; the completeness/manifest gate passes.
  - `kind: command`: `corepack pnpm exec vitest run packages/mcp-core/src/tool-catalog-parity.spec.ts packages/mcp-core/src/permissions.spec.ts` passes (with the widened multi-dot regex if D1 chose dotted names).
- **AC2** (covers R1, R2, D2) The edge dispatch map `ORG_TOOLS` gains the six
  handlers, and `tool-catalog-parity.spec.ts`'s catalog↔dispatch assertion passes.
  - `kind: command`: `grep -nE "org\.(members|invites)\." supabase/functions/mcp/mcp-handler.ts` shows all six mapped.
- **AC3** (covers R6) The MCP handlers + CLI store map to the `member.*` audit
  vocabulary / `rest-tool-name.ts` names; `rest-tool-name.spec.ts` still passes.
  - `kind: command`: `corepack pnpm exec vitest run packages/mcp-core/src/rest-tool-name.spec.ts` passes.
- **AC4** (covers R3, R7) The CLI store methods exist on `remote.mjs`
  (`orgMembersList`, `orgMemberSetRole`, `orgMemberRemove`, `orgInvitesList`,
  `orgInviteCreate`, `orgInviteRevoke`) calling `/orgs/:slug/*` with
  `encodeURIComponent` on path segments, returning the published `{ ok, ... }`
  shapes; a CLI test covers each against a mocked REST layer.
  - `kind: command`: `node --test packages/cli/test/org.test.mjs` (new) passes.
- **AC5** (covers R4, D3) The destructive ops honour the guard: MCP tools are
  absent from `tools/list` (or return a disabled error) unless the opt-in flag is
  set; CLI destructive commands refuse without `--yes` in non-interactive mode.
  - `kind: command`: a CLI test asserts `org remove-member … --json` (non-TTY, no
    `--yes`) exits non-zero with a "confirmation required" message; and with
    `--yes` it proceeds (mocked).
  - `kind: command`: an MCP-handler or mcp-server test asserts the destructive
    tool is not advertised without the flag (whichever surface enforces it).
- **AC6** (covers R1, R2 — behavioural) SQL test §86 (org members/invites via the
  service-role + actor path): seed an org with owner a1 + member b2; assert list
  members, set b2→admin, invite by email, list invites (owner sees it, plain
  member sees empty), revoke invite, remove b2; and assert admin-vs-owner and
  last-owner invariants still deny.
  - `kind: command`: isolated-stack SQL harness passes §86 (see Verification).
- **AC7** (covers R5) `node scripts/gen-surfaces.mjs --check`,
  `node scripts/sync-edge-schemas.mjs --check`, and
  `node --experimental-transform-types packages/schemas/src/llms/generate.ts --check`
  all exit 0 after regeneration.
- **AC8** (covers R7) The CLI local `mcp-server.mjs` advertises + dispatches the
  new tools (proxying to the new `remote.mjs` methods), and its test passes.
  - `kind: command`: `node --test packages/cli/test/mcp-server.test.mjs` passes.

## File changes (concrete paths)

- **Edit** `packages/schemas/src/tool-catalog.ts` — six new `McpToolDoc` entries
  with `surfaces` bindings, permissions, `token-or-jwt`, and (for destructive)
  the `dangerous`/opt-in flag if D3 adds one to the binding shape.
- **Edit** `packages/mcp-core/src/permissions.ts` (+ manual mirror
  `supabase/functions/mcp/permissions.ts`) — add the six to READ/WRITE sets.
- **Edit** `supabase/functions/mcp/mcp-handler.ts` — add six entries to `ORG_TOOLS`,
  thread `userId`, and (D3) the opt-in gate for the destructive three.
- **Edit** `supabase/functions/mcp/tools.ts` — six new `toolOrg*` handlers (D2a),
  mirroring the REST handlers' slug→id + membership-gate + RPC-call + audit logic.
  Consider a shared `resolveOrgIdForActor`/`requireMembership` helper.
- **Edit** `packages/cli/src/store/remote.mjs` — six new methods over `/orgs/:slug/*`.
- **Add** `packages/cli/src/org.mjs` — the `org` command group (D4) with the
  `--yes` confirmation for destructive ops.
- **Edit** `packages/cli/bin/lorekit.mjs` — register the `org` command (dispatch +
  `HUMAN_COMMANDS` + `KNOWN_FLAGS` for `--role`/`--email`/`--handle`/`--invite-id` +
  `HELP`/`COMMAND_HELP` entry + `traceCommand` wrap).
- **Edit** `packages/cli/src/mcp-server.mjs` — add the six to `ORG_TOOL_DEFS` +
  `ORG_DISPATCH` (proxy to the new `remote.mjs` methods).
- **Edit** `packages/mcp-core/src/tool-catalog-parity.spec.ts` (or the Phase-2
  manifest spec) — widen the dispatch-map name regex to multi-dot if D1 chose
  dotted names; extend the CLI-command assertion for the `org` subcommand group.
- **Add** `packages/cli/test/org.test.mjs` — CLI command + store coverage (AC4,
  AC5).
- **Add** `supabase/tests/migrations.test.sql` §86 (AC6).
- **Regenerate** `packages/web/public/llms.txt`, the surface manifest, the edge
  mirror.
- **Docs:** `docs/org-sharing.md` (members/invites via CLI/MCP), `docs/mcp-tools.md`,
  `docs/cli.md`, `docs/api-tokens.md` (the opt-in flag), `packages/cli/README.md`,
  `packages/web/public/llms.txt` (generated). Run sibling-name docs-drift greps.

## Verification

Run from the worktree root. No `timeout` on macOS.

1. `corepack pnpm exec vitest run packages/mcp-core/src/tool-catalog-parity.spec.ts packages/mcp-core/src/permissions.spec.ts packages/mcp-core/src/rest-tool-name.spec.ts packages/mcp-core/src/edge-parity.spec.ts packages/mcp-core/src/edge-schema-parity.spec.ts` — green.
2. `node --test packages/cli/test/org.test.mjs packages/cli/test/mcp-server.test.mjs packages/cli/test/cli.test.mjs` — green.
3. Regenerate + `--check`: `gen-surfaces.mjs`, `sync-edge-schemas.mjs`, `generate.ts`.
4. **SQL isolated stack (AC6):** same recipe as Phase 3a's plan — config.toml
   ports +100, `supabase start -x …`, `supabase db reset`, `psql -f
   supabase/tests/migrations.test.sql`, confirm §86, `supabase stop`, restore
   config. Watch the pre-existing ~line-2685 failure (unrelated).
5. **Guard-bites proof** for AC5: confirm the destructive-op refusal actually
   fires (flip the opt-in flag / drop `--yes`) and that removing the guard flips
   the test — do not commit the perturbation.
6. Edge Deno checks: rely on CI; read-through the `tools.ts`/`mcp-handler.ts`
   diffs for unused-param / type issues.

## Risks & mitigations

- **Destructive op triggered by an agent** (the flagged blast radius).
  *Mitigation:* D3 opt-in + `--yes`; RPC invariants as backstop; AC5 proves the
  guard bites.
- **Multi-dot tool names break the dispatch-map regex** silently (the parity gate
  would stop matching the new tools and pass vacuously). *Mitigation:* widen the
  regex AND keep/raise the anti-vacuity `toBeGreaterThanOrEqual(N)` count in
  `tool-catalog-parity.spec.ts` so a regex that matches nothing fails.
- **Duplicating REST-handler logic in `tools.ts`** drifts from the REST behaviour
  (membership gate, capability gate for invite-list). *Mitigation:* extract shared
  helpers where possible; §86 SQL test exercises both the allow and deny paths;
  keep the `invite`-capability empty-list behaviour identical (a plain member sees
  `{ entries: [] }`, not a 403).
- **Self-removal 403 confuses users.** *Mitigation:* D5 — surface the server error
  verbatim, document the `lorekit_org_leave` follow-up.
- **CLI subcommand group breaks the Phase-2 manifest gate's one-case-per-command
  assumption.** *Mitigation:* teach the gate about the `org` group (D4) in the same
  edit; do not leave the gate asserting against a model it no longer matches.
- **Docs-drift on sibling surfaces.** *Mitigation:* grep sibling names
  (`org.create`, `member.`, "invite") across all doc/skill/mirror surfaces before
  claiming done.

## Dependencies / ordering

- **Depends on Phase 2 AND Phase 3a.** 3a makes the org surface token-capable;
  this adds sub-resources on top. Do not start before both are green.
- Independent of 3c/3d.
