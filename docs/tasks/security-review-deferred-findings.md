# Security review — deferred findings

Backlog of security findings from the per-project security review (July 2026) that were
**deliberately not fixed** in the two shipped PRs, plus the design-level follow-ups the
[agent-memory-atlas analysis](https://neoneye.github.io/agent-memory-atlas/systems/lorekit/)
raised. Each item below is written to convert 1:1 into a Linear issue.

## Context — what already shipped

| PR | Merged | Scope |
|----|--------|-------|
| #288 | `725f5f3` | DB access-control IDOR family — actor guard on `archive_memory`, `restore_memory`, `purge_archived_memories`, `purge_expired_memories`, **`memory_delete`** (migration `00046`), least-privilege grants, `migrations.test.sql` §60. |
| #293 | `2dd5f88` | App-layer — PostgREST filter-injection closed at scope validation; `mcp-server` pre-auth body-size DoS cap. |
| _readfn hardening_ | migration `00047` | **The clearly-safe half of this backlog.** Actor guard + anon-revoke on `lorekit_memory_scopes`/`lorekit_memory_count`; `revoke ... from public` on `lorekit_find_user_by_github_id`, the 3 installation RPCs, `lorekit_purge_old_usage_events`, `lorekit_purge_all_expired_memories`. `migrations.test.sql` §61. |

Everything below is **out of scope of those PRs** and still open.

### ✅ Resolved in the `00047` read-function grant-hardening pass

Struck from the backlog — do **not** open Linear issues for these:

- **SEC-2** — GitHub App installation RPCs anon-writable → revoked to service-role only.
- **SEC-3 (safe subset)** — `lorekit_memory_scopes`, `lorekit_memory_count` (actor guard + anon-revoke), `lorekit_find_user_by_github_id` (service-role only). *`lorekit_member_org_ids` remains — see SEC-3 below.*
- **SEC-4** — `lorekit_purge_old_usage_events` anon global wipe → service-role only.
- **SEC-13 (safe subset)** — `lorekit_purge_all_expired_memories` → service-role only. *`lorekit_org_role`/`_can` and `lorekit_get_limit`/`_org_limit`/`default_limit` remain — see SEC-13 below.*

## The one big caveat before you action these

Several fixes are a **`REVOKE … FROM public/anon` grant sweep**. That is mechanically simple but
**not uniformly safe**: some of these SECURITY DEFINER functions are called **inside RLS policies**
(`lorekit_member_org_ids`, `lorekit_org_role`, `lorekit_org_can`) or on the **rate-limit hot path**
(`lorekit_check_rate_limit`). Revoking the wrong role there is a **production-availability incident**
(RLS on `memories`/`orgs` stops evaluating for real users). Every grant change needs an
`migrations.test.sql` assertion that the affected RLS read path still returns the right rows.

Items are tagged **[safe-sweep]** (isolated, procedural — low risk) or **[rls/hot-path]** (needs
per-function caller analysis + RLS-path test).

---

## SEC-1 — [HIGH] CLI API-token exfiltration via committed repo config

- **Severity:** High · **Component:** `@lorekit/cli` · **Labels:** security, cli, supply-chain
- **Files:** `packages/cli/src/config.mjs` (`resolveProjectConnection`, ~L351-380), `stores.mjs`, `src/store/remote.mjs` (`restFetch`), `src/store/index.mjs`, `src/hook.mjs`

**Problem.** The remote endpoint is read verbatim from repo-committed config (`.mcp.json`
`mcpServers.lorekit.args`, or `.lorekit.json` `mcp.endpoint`) with **no host allow-list** (the only
check rejects the literal `<project-ref>` placeholder). Worse, when the committed endpoint carries no
token the code falls back to `token: token || process.env.LOREKIT_TOKEN`.

**Exploit (no user action).** A malicious repo commits a `.mcp.json` pointing `lorekit` at
`https://evil.com/functions/v1/mcp`. A victim who has `LOREKIT_TOKEN` set (shell profile / CI) opens
the repo → the **SessionStart hook** (`hook.mjs` → `fetchLessons` → `RemoteStore.list` → `restFetch`)
fires automatically and sends the victim's real `lk_rw_*` token to `evil.com`. Every read command does
the same. Even without the env token, a committed URL carrying the *attacker's* token silently reroutes
the victim's memory reads/writes to attacker-controlled storage (prompt-injection in + capture out).

**Fix.** (1) Constrain the remote host to an allow-list (mirror the web `otel-origins.ts` posture:
production `*.supabase.co` ref; explicit opt-in for a self-hosted host). (2) **Never pair an env/global
token with a repo-tier endpoint** — a repo-supplied endpoint may only use a token supplied in the same
trust tier; drop the `|| process.env.LOREKIT_TOKEN` fallback for repo-sourced endpoints.

**Effort:** M · behaviour-sensitive (must not break legit self-hosted setups) — needs tests.

---

## SEC-3 — [MEDIUM→LOW] `lorekit_member_org_ids` anon-reachable (remaining half)

> The `memory_scopes` / `memory_count` / `find_user_by_github_id` parts of this finding — flagged by
> the atlas analysis and a second session — were **fixed in `00047`**. Only the RLS-embedded
> `lorekit_member_org_ids` remains.

- **Severity:** Low (org-membership UUIDs only) · **Labels:** security, database · **[rls/hot-path]**
- **File:** `lorekit_member_org_ids(uuid)` — `00014_orgs.sql` (grant ~L78)

**Problem.** SECURITY DEFINER, bare `p_user_id`, retains `anon`/`authenticated` EXECUTE → anon
enumerates any user's org-membership UUIDs.

**Fix.** `revoke execute … from public` (and `anon` if not needed) — **but** this function is called
**inside the `memories`/`orgs` RLS read policies** with `auth.uid()`, so the querying role must keep
EXECUTE for RLS to evaluate. **Do NOT add an actor guard** and do **not** revoke `authenticated`/`anon`
without an `migrations.test.sql` assertion proving the `memories` RLS read path still returns rows for a
normal user. Because RLS always passes `auth.uid()` (never request input), the practical leak is small;
weigh the change against the RLS-regression risk.

**Effort:** M · needs an RLS-path assertion; low value.

---

## SEC-5 — [MEDIUM] MCP dispatcher returns raw DB/internal error text to callers

- **Severity:** Medium · **Labels:** security, edge, info-leak
- **File:** `supabase/functions/mcp/mcp-handler.ts` (~L465-467, the `-32603` path); tool handlers `throw new Error(error.message)` (`tools.ts:172,199,271,345,…`)

**Problem.** Verbatim PostgREST error text (parse errors, column/constraint/RPC signatures) is returned
to any authenticated client. The REST surface already funnels unknowns to a generic `internalError`;
the MCP surface does not — an asymmetry that also turns a filter-injection attempt into a usable oracle.

**Fix.** On the `-32603` path, log detail to the span (already done) but return a generic message; keep
specific messages only for the discriminated client-error classes (`UserInputError`/`OrgPermissionError`/`LimitError`).

**Effort:** S.

---

## SEC-6 — [MEDIUM] CLI repo-committed `store` path escapes the repo

- **Severity:** Medium · **Component:** `@lorekit/cli` · **Labels:** security, cli
- **File:** `packages/cli/src/control.mjs` (`projectDirFrom`, ~L177-180); consumed by `localStoreDirs`/`resolveControl`

**Problem.** `projectDirFrom` does `path.isAbsolute(raw) ? raw : path.join(root, raw)` where `raw` can
come from a repo-committed `.lorekit.json` `"store"`. A malicious repo sets `"store": "/home/victim/.ssh"`
or `"../../.."`, redirecting the local store base outside the repo → writes/reads markdown in any
writable dir (filenames are slug-sanitized, so no arbitrary-named overwrite, but directory litter +
scanning of an attacker-chosen tree).

**Fix.** Reject absolute paths and `..` segments in a **repo-tier** `store` value (allow them only from
env / user-global config), or resolve and assert containment within `root`.

**Effort:** S-M.

---

## SEC-7 — [MEDIUM] CLI prompt-injection via repo-committed `hooks.instructions`

- **Severity:** Medium (trust-model) · **Component:** `@lorekit/cli` · **Labels:** security, cli, prompt-injection
- **Files:** `packages/cli/src/control.mjs` (`hooksInstructions`, ~L145-159), `src/hook.mjs` (SessionStart/Stop injection)

**Problem.** A repo's committed `.lorekit.json` can set `hooks.instructions.SessionStart` (etc.) to
arbitrary text emitted into the coding agent's context on session start with **no consent gate** — same
trust class as a malicious `CLAUDE.md`, but LoreKit widens it to two more committed files a user may not
realize are executable-in-effect. Compounds with SEC-1 (attacker-controlled *lesson* content injected).

**Fix.** Document the trust boundary explicitly, and/or add a one-time trust prompt before honouring
repo-supplied hook instructions (and repo-supplied endpoints, cf. SEC-1).

**Effort:** M (UX decision).

---

## SEC-8 — [MEDIUM/LOW] Rate-limit RPCs anon-callable (targeted DoS)

- **Severity:** Medium/Low · **Labels:** security, database · **[rls/hot-path — verify caller role first]**
- **File:** `supabase/migrations/00004_limits.sql` — `lorekit_check_rate_limit` (~L138, no explicit grant → PUBLIC), `lorekit_purge_rate_limit_counters` (~L182)

**Exploit.** Anon calls `lorekit_check_rate_limit(p_user_id=<victim>)` repeatedly to drive the victim's
fixed-window counter to the limit → the victim's legit requests get HTTP 429. `lorekit_purge_rate_limit_counters('0')`
deletes all counters (momentarily disables rate limiting globally).

**Fix.** `revoke execute … from public` (transport-layer/service-role only). **Verify first** which DB
role the transport actually calls `lorekit_check_rate_limit` with — the edge calls it right after auth;
if any JWT/`authenticated` path invokes it as `authenticated`, keep that grant.

**Effort:** M (caller analysis required).

---

## SEC-9 — [LOW] `lorekit_record_usage_event` anon analytics injection

- **Severity:** Low (append-only, no read of others) · **Labels:** security, database · **[verify caller role]**
- **File:** `supabase/migrations/00034_usage_events.sql` (grant ~L138, explicit `anon`)

**Exploit.** Anon inserts arbitrary `usage_events` for any `user_id`/`org_id` with arbitrary
`tool_name`/`outcome`/counts (bypasses RLS via DEFINER) → pollutes analytics / inflates a target's usage.

**Fix.** Revoke from `public`/`anon`; keep `authenticated` + `service_role` only if a JWT edge path
records usage as `authenticated` (verify).

**Effort:** S-M.

---

## SEC-10 — [LOW] Cursor `id` not UUID-validated (bounded filter injection)

- **Severity:** Low · **Labels:** security, edge
- **File:** `supabase/functions/_shared/api/paginate.ts` (`decodeCursor`, ~L5-15); consumers `memories/handlers/list.ts:61`, `search.ts:47`

**Problem.** `decodeCursor` regex-validates `updated_at` *because* it's interpolated into the keyset
`.or(...)`, but leaves `id` as an arbitrary string. Cursors are opaque base64 but **unsigned**, so a
forged `id` injects into the filter. Bounded (the tenant predicate is a separate AND; REST returns a
generic error), but it defeats the exact hardening the `updated_at` regex added.

**Fix.** Validate `id` as a UUID in `decodeCursor` (return `null` otherwise), matching the `updated_at` guard.

**Effort:** S.

---

## SEC-11 — [LOW] Webhook comments become cap-exempt, un-rate-limited, author-less durable memory

- **Severity:** Low · **Labels:** security, edge, memory-poisoning · (overlaps the atlas "provenance" point)
- **File:** `supabase/functions/mcp/webhook.ts` (~L491-506, `toolWrite(db, {...}, null, span)`)

**Problem.** Once a delivery HMAC-verifies, any commenter on a watched repo (incl. external PR
contributors) has their comment body written as a `repo::owner/name` memory with `userId = null` →
lands in the **service partition** (cap-exempt via `enforce_memory_cap`), **skips**
`lorekit_check_rate_limit`, keys on `Date.now()` (no upsert dedup → unbounded growth), and carries **no
author identity** → an attacker who can comment can inject "lesson" text later sessions ingest.

**Fix.** Attribute webhook writes to the repo-owner's user id (so cap + rate limit apply), capture the
comment author into `metadata`/`tags` for provenance, and add a per-repo write ceiling.

**Effort:** M.

---

## SEC-12 — [LOW] Defense-in-depth `user_id` filter on archive/restore/read/list

- **Severity:** Low · **Labels:** security, mcp-core, defense-in-depth
- **Files:** `packages/mcp-core/src/tools/archive.ts` (~L52-57, 109-114), `read.ts` (~L28-38), `list.ts` (~L34-41)

**Problem.** `delete.ts` deliberately adds `user_id` to `.match()` ("without it a service-role client
would match any user's row with the same (scope,key)"); `archiveMemory`/`restoreMemory` (called with no
`userId` in the Node server) and the read tools have no equivalent guard. For JWT callers RLS covers it,
but the asymmetry means one RLS-policy regression silently becomes cross-tenant on these paths where
`delete` would still be protected.

**Fix.** Mirror `delete.ts`'s `if (userId) match.user_id = userId` across these tools.

**Effort:** S.

---

## SEC-13 — [LOW] Assorted anon-reachable DEFINER probes (remaining)

> `lorekit_purge_all_expired_memories` was **fixed in `00047`**. The functions below all touch the RLS
> policies or the memory-insert/rate-limit hot path, so they were deliberately left here.

- **Severity:** Low · **Labels:** security, database · **[rls/hot-path]**
- **Files & functions:**
  - `lorekit_org_role(uuid,uuid)` / `lorekit_org_can(uuid,uuid,text)` — `00017` (~L48/L81, explicit `anon`) — boolean/text oracle of any user's role/capability in any org. **Used in the `orgs`/`org_members`/`org_invites` RLS policies and every org capability check.**
  - `lorekit_get_limit(uuid,text)` / `lorekit_get_org_limit(uuid,text)` (`00004`/`00018` ~L60) / `lorekit_default_limit` — leak a user's/org's numeric limit (≈ plan tier). **Called by the `enforce_memory_cap` trigger on every memory insert** (it is `SECURITY DEFINER`, so the internal call survives a revoke, but confirm no invoker path).

**Fix.** `revoke execute … from public`, granting only the roles that need them — but **do not** touch
`lorekit_org_role`/`_can` grants without an `migrations.test.sql` assertion that the org RLS read path
still evaluates, and confirm nothing calls `get_limit` as an invoker before revoking `authenticated`.

**Effort:** M · low value, real regression risk — do carefully.

---

## SEC-14 — [LOW] Web `/api-docs/proxy` — unauthenticated same-origin relay, no throttle

- **Severity:** Low (abuse-amplification only; SSRF-locked, upstream enforces auth+rate-limit) · **Labels:** security, web
- **File:** `packages/web/src/app/api-docs/proxy/route.ts` (~L51-96)

**Problem.** Public route (no `getUser()`) forwards a caller-supplied `Authorization` header to the
LoreKit REST API. Lets an attacker brute-force/probe `lk_*` tokens **through the `lorekit.io` origin**
(source-IP laundering) with no proxy-side rate limit. Not a data-exposure vector (origin/path locked;
cookies never forwarded).

**Fix.** Require an authenticated session on the proxy route, or add a lightweight per-IP rate limit.

**Effort:** S.

---

## SEC-15 — [INFO] Hardening batch (low priority, group into one ticket)

- **CORS fail-open** — `supabase/functions/_shared/api/cors.ts` (~L1-3,19): defaults to `Allow-Origin: *`
  unless `ALLOWED_ORIGINS` set or `VERCEL_ENV=production`. Mitigated (Bearer auth, no `Allow-Credentials`).
  Confirm the deploy sets one of those in production.
- **Non-constant-time secret compare** — `token === SERVICE_KEY` in `_shared/api/auth.ts` (~L41),
  `mcp/auth.ts` (~L51). Theoretical timing side-channel on a long static secret; use `timingSafeEqual`.
- **Telemetry PII** — `createTracedClient` records interpolated filter values (scope, key, `user_id`,
  raw search `q`) in `db.query.text` (`_shared/otel.ts` ~L483-524). Goes to the operator's Dash0, not
  users, and excludes memory *values*, but is more PII than the "no-PII attrs" posture implies.
- **CLI `__proto__` frontmatter** — `packages/cli/src/store/format.mjs` (`parseEntry`, ~L31-42):
  `meta[key] = …` assigns through `__proto__`. Not exploitable today (no deep-merge of the parsed object),
  but skip `__proto__`/`constructor`/`prototype` keys to remove the footgun.
- **Web broad CORS preflight `*`** — `packages/web/src/middleware.ts` (~L21-39). Not exploitable (no
  credentials, `SameSite=Lax` httpOnly cookies). Hardening note.
- **Attacker-controllable `state` in `audit_log`** — `packages/web/src/lib/github-installations.ts`
  (~L195). Stored untrusted data, React-escaped, own-`user_id` scoped — non-exploitable; noted.

---

## Non-security design follow-ups from the atlas analysis (separate track)

Not vulnerabilities — product/quality items the analysis raised. Listed so they don't get lost.

- **Audit log preserves no prior value.** `memory.update` audit metadata is `{scope,key}` only; the
  in-place upsert keeps no version history, so the log proves *that* a memory changed, never *what it
  was*. If the value matters, put the old value in the log or keep a version chain.
- **`seen_count >= 3` recurrence gate is prose-only.** The entrenchment guard governing promotion lives
  in skill markdown with no column and no enforcement. Either give the guard a mechanism (a recurrence
  counter) or describe it explicitly as advice.
- **Archive frees the address.** The partial unique index (`00003`, `where archived_at is null`) lets the
  same `(user_id,scope,key)` be re-created after archive — so an archived "this was wrong" lesson can be
  silently re-asserted with no record of the prior rejection. If archive is used as rejection, record it.
- (Webhook author provenance is tracked above as **SEC-11**.)

---

## Suggested triage order

The clearly-safe grant sweep (former SEC-2/SEC-4 + the safe subsets of SEC-3/SEC-13) already shipped in
`00047`. Remaining:

1. **SEC-1** (High) — CLI token exfiltration. The only High left; behaviour-sensitive, needs tests.
2. **SEC-5, SEC-6, SEC-10** — small, isolated code fixes (MCP error-leak, CLI store path escape, cursor-id).
3. The **[rls/hot-path]** grant changes — **SEC-3** (`member_org_ids`), **SEC-8** (`check_rate_limit`),
   **SEC-9** (`record_usage_event`), **SEC-13** (`org_role`/`_can`, `get_limit`/`_org_limit`) — each with an
   RLS-path / hot-path assertion in `migrations.test.sql`. **Do these carefully; low value, real risk.**
4. **SEC-7, SEC-11, SEC-12, SEC-14** and the **SEC-15** hardening batch.
