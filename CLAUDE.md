# LoreKit — Agent Context

LoreKit is a Supabase-backed MCP server for shared, persistent agent memory.
Agents read and write *lore* (lessons) via MCP tool calls. A Next.js dashboard
lets humans browse, search, and manage those lessons.

→ For architecture, MCP tools, scope format, tokens, OTel, and deployment:
  **read [docs/](./docs/README.md) on demand — do NOT load all docs upfront.**

---

## Package map

| Package | Path | Role |
|---------|------|------|
| `@lorekit/core` | `packages/mcp-core/` | Scope validator, DB client, 10 tool handlers, OTel tracer/meter |
| `@lorekit/server` | `packages/mcp-server/` | Node.js HTTP server for Fly.io (OTel SDK init, auth, webhook) |
| `@lorekit/web` | `packages/web/` | Next.js 15 dashboard (Vercel) |
| `@lorekit/cli` | `packages/cli/` | Zero-dep Node CLI: `install` (scaffolds the `lorekit-memory` + `lorekit-setup` skills, MCP server, and the deterministic lifecycle hooks into `.claude`/`~/.claude` per a project/global prompt — the plugin's three parts without a marketplace; `--no-hooks` to skip), `doctor` (connectivity/token/scope health checks), `list` (alias `ls` — read-only human view of the lessons for the cwd's scopes, project/branch/repo/global, split into an **Offline** local-store section and a **Remote** hosted section that degrades gracefully when unconfigured; `--json`/`--scope`; independently builds BOTH stores via `src/stores.mjs` + renders via the reusable `src/lessons-view.mjs`, the seam all the `search`/`show`/`stats`/`diff` read commands stack on; the shared deny-wins block those five read commands all use is extracted into `resolveDenies(root,{env})` in `control.mjs`), `search` (alias `grep` — full-text search the same scopes/stores/split as `list`; matches a **literal, case-insensitive** substring against a lesson's key OR value, via the pure `matchesQuery` (in the dependency-free `lessons-pure.mjs`, re-exported by `lessons-view.mjs`)/`filterGroups` helpers over the shared `gather()` output — NOT each store's native `search` method, whose semantics diverge (local literal-substring vs remote server-FTS); regex metachars are matched verbatim, never compiled; `--json`/`--scope`), `show` (inspect ONE lesson in full via each store's real `read({scope,key})` — complete untruncated value, scope, key, updated, tags, and which store(s) hold it; when the same `scope::key` is in both stores it shows both and flags any divergence via the pure `recordsDiverge`; exits non-zero when found in no readable store; `--json`), `stats` (at-a-glance counts of the applicable lessons **per scope** and **per store**, with per-store + grand totals, in the same Offline/Remote split; pure `tallyGroups` over `gather()`; `--json`/`--scope`; no cap-usage `N/limit` figure — the hosted MCP surface exposes no total-count or cap tool, so remote counts reflect only what `memory.list` returns per scope), `scopes` (a **store-wide** inventory — UNLIKE every other read command, NOT cwd-scoped: enumerates EVERY distinct scope present in the store with a per-scope non-archived count, so a user sees all scopes they have lessons in anywhere; pure `scopeTypeOf`/`sortScopeInventory`/`filterScopeInventory`/`summarizeScopeInventory` in `lessons-view.mjs`, sorted by scope type then name; `--json`/`--scope` [a **substring filter** over the inventory, not a single-scope selector]. **Offline enumeration is exact** — a new `LocalStore._walkEntries()`/`listScopes()` (+ `TwoTierStore.listScopes()` deduping by `scope::key` across tiers, project shadowing home) recursively walks the store and reads each file's frontmatter `scope` string, NEVER reverse-mapping the on-disk layout [which is lossy for `project::{name}`, stored by basename only], so scopes are reconstructed verbatim. **Remote enumeration is impossible and reported honestly** — the hosted MCP surface has no "list all scopes" tool [every read tool REQUIRES a scope], so `RemoteStore.listScopes()` returns an unsupported sentinel and the Remote section is always a short note [`REMOTE_SCOPES_UNSUPPORTED`], degrading gracefully at exit 0, the `stats`-omits-cap-usage pattern), `diff` (compare offline vs remote for the applicable scopes and report **local-only** / **remote-only** / **conflicting** keys grouped by scope, via the pure `diffGroups` set-diff reusing `recordsDiverge`; needs BOTH stores readable — an unconfigured/denied store yields a clear `comparable:false` note at exit 0, never a crash; `--json`/`--scope`), `tree` (alias `resolve` — the scope **precedence hierarchy**: resolves the hook-injected `readOrder` scopes [project→branch→repo→global, most-specific first] and marks per key which scope's lesson **wins** and which are **shadowed**, mirroring `core/lessons.mjs`'s first-seen-wins merge EXACTLY via the SAME shared pure `resolvePrecedence` [now in the dependency-free `lessons-pure.mjs`, re-exported by `lessons-view.mjs`]; per-store; `--json`/`--scope`), `lint` (flag low-quality lessons across the applicable scopes/stores — pure `LINT_RULES`/`lintEntry`/`lintGroups`: **empty-value**/**short-value**/**untrimmed-value**/**empty-key**/**malformed-scope** [via the canonical `scopeIssue` validator], each rule independently tested; **exits non-zero when any finding exists** so it's a CI gate; `--json`/`--scope`), `dedupe` (heuristic near-duplicate detection — pure `tokenize`/`similarity` [zero-dep **Jaccard word-token overlap**, NOT embeddings]/`clusterDuplicates` [union-find, `>= threshold` inclusive, 2+-member clusters only]; per-store across scopes; `--json`/`--scope`/`--threshold` [default 0.8]), `hook` (the shared hook engine behind the plugins — injects lessons on SessionStart, **relevant lessons + a write-nudge on a tool failure** [`failureQuery`/`relevantLessons` reuse the shared `matchesQuery`], and a retrospective nudge on Stop; always exit 0, best-effort, never blocks the host), and `mcp` (a hand-rolled local stdio MCP server exposing `memory.*` from the resolved store — lets `.mcp.json` point at the CLI instead of `mcp-remote`, for offline local-mode tool calls). Ships two skills under `skill/*` — `lorekit-memory` (runtime read/write) and `lorekit-setup` (authoring a self-improvement loop into a host); `install`/`uninstall`/`doctor` iterate the `SKILLS` list in `config.mjs`, and `scripts/sync-plugin-skill.mjs` mirrors every `skill/*` into the plugin. Human-facing commands (`install`/`uninstall`/`doctor`/`list`/`search`/`show`/`stats`/`scopes`/`diff`/`tree`/`lint`/`dedupe`/`migrate`) emit one OTel span + counter point per run via a zero-dep self-contained OTLP/JSON `fetch` exporter (`src/telemetry.mjs`, the `_shared/otel.ts` pattern) — `service.name=lorekit-cli`, `service.namespace=lorekit`, no-PII attrs, opt-out via `LOREKIT_TELEMETRY`/`DO_NOT_TRACK`; `hook`/`mcp` stay uninstrumented. The ingesting-only Dash0 token is never committed — `src/telemetry-token.mjs` is empty in git and injected at publish time from the `LOREKIT_TELEMETRY_TOKEN` secret by `scripts/inject-telemetry-token.mjs` (wired into `release.yml`'s `publish-cli` job); `LOREKIT_TELEMETRY_TOKEN`/`OTEL_EXPORTER_OTLP_HEADERS` env override it at runtime. Verified by its own `node:test` suite; excluded from the NX TS lint gate. |
| `plugins/` | `plugins/` | Per-framework deterministic bundles: `lorekit-claude` (marketplace plugin: skill + hooks + MCP), `lorekit-cursor` (rule + `stop` hook), `lorekit-codex` (feature-flagged hooks + `AGENTS.md` fallback, experimental). Root `.claude-plugin/marketplace.json` lists the Claude plugin. |
| `supabase` | `supabase/` | Edge Functions (production MCP server), migrations, NX targets |

The **production MCP server** is `supabase/functions/mcp/index.ts` (Deno, self-contained).
`packages/mcp-server/` is the Node.js variant for Fly.io with full OTel.

**Shared hook engine:** `lorekit hook --adapter <claude|cursor|codex> --event <name>` reads the host's
JSON on stdin and injects lessons / a retrospective nudge on stdout, always exiting 0. Logic lives once
in `packages/cli/src/{core,adapters}/`; each adapter reshapes I/O to its host. On a tool failure it
additionally does a best-effort lesson lookup (`fetchLessons` → `failureQuery` distils terms from the
tool name + error text → `relevantLessons` filters via the shared `matchesQuery`, capped at 3) and
injects any relevant prior lessons BEFORE the write-nudge — an unusable store or no match silently falls
back to the nudge alone, and any error is swallowed (exit 0). The cross-scope precedence merge and the
literal matcher are the SAME pure functions the read commands use — `resolvePrecedence` and `matchesQuery`
now live in the dependency-free `packages/cli/src/lessons-pure.mjs` (re-exported by `lessons-view.mjs`) so
the hot path shares them without dragging in the `util`/render stack. The Claude plugin's skill copy is
vendored from `packages/cli/skill/` — keep in sync via `node scripts/sync-plugin-skill.mjs` (a `--check`
mode guards drift).

**Cross-framework validation:** `packages/cli/test/frameworks.test.mjs` replays payload fixtures
(`test/fixtures/<adapter>-<event>.json`) through the binary and asserts each host's output contract, runs
`claude plugin validate` (skips if the CLI is absent), and structurally checks the Cursor/Codex configs.
Harvest real fixtures with `LOREKIT_HOOK_RECORD=<dir>` set on the hook command (one run per framework).

---

## NX commands

```bash
# CI gate
pnpm nx run-many -t typecheck,test,lint --all

# Individual packages
pnpm nx typecheck mcp-core
pnpm nx typecheck web
pnpm nx test mcp-core          # needs supabase start
pnpm nx serve web              # Next.js dev server

# Supabase (needs SUPABASE_PROJECT_REF in .env.local)
# NOTE: these are for local/first-time setup. Merging to main runs the
# staging-first CI/CD pipeline (.github/workflows/deploy.yml) automatically.
# See docs/deployment.md → "Automated deployment (CI/CD)".
pnpm nx deploy supabase        # typecheck + test → db push → fn:deploy
pnpm nx db:push supabase       # push migrations
pnpm nx fn:deploy supabase     # deploy mcp + health Edge Functions
pnpm nx db:types supabase      # generate TypeScript types from DB
pnpm nx health supabase        # curl /health endpoint
pnpm nx start supabase         # start local Supabase
pnpm nx fn:dev supabase        # run Edge Functions locally
```

---

## PR workflow (mandatory — always follow this order)

Every PR in this repository goes through a fixed five-step sequence.
Do NOT skip steps or change the order, whether the PR is a draft or ready for review.

### Prerequisites — install agent-skills (once per sandbox)

Before running any PR workflow steps, ensure `agent-skills` is cloned and all skills and agents are
wired into `~/.claude/`. This is idempotent — safe to re-run, no-op if already set up.

```bash
# Clone if not already present, then wire every skill and agent into ~/.claude/
git clone https://github.com/mthines/agent-skills.git /tmp/workspace/agent-skills 2>/dev/null || true
bash /tmp/workspace/agent-skills/scripts/sync-symlinks.sh
```

The script discovers all skills (any directory under `skills/` containing a `SKILL.md`) and all
agents (`agents/*.md`), and creates a two-tier symlink chain so they are available as native Claude
skills and sub-agents. It repairs broken links and skips already-correct ones.

### Step 1 — Run `/polish` and auto-fix all findings

Before opening the PR, run the `polish` skill against the branch. This is a **local-only** pass —
it never writes to GitHub. All auto-fixable findings must be committed before opening the PR.

Dispatch a sub-agent (subagent_type: general):

> Read /tmp/workspace/agent-skills/skills/quality/polish/SKILL.md and follow it exactly.
> Run in full mode (default). Auto-fix all simple findings. Apply all Class M mechanical refactors
> that pass the confidence gate. Commit each pass separately. Do NOT write to GitHub.

Wait for the polish run to finish before proceeding. Planned-complex items (Class J, judgment-required)
are surfaced for awareness but do not block the workflow — they require a human decision.

Skip this step only if the branch diff is non-code only (docs, lockfiles, generated artefacts).

### Step 2 — Open / push the PR

Create the PR (or push a new commit to an existing branch). It may start as a draft.
The Dash0 bot picks up the event automatically and starts its review — **you do not trigger it manually**.

### Step 3 — Await the Dash0 bot review report

After the PR is opened or marked ready-for-review, **wait for the `dash0-dev` bot to post its review**.
The bot runs `PR Ready for Review — Polish + Review` automatically; a comment from `dash0-dev` with
the review results will appear on the PR. Do not proceed until that comment is present.

```bash
# Poll until the dash0-dev review appears (count should reach ≥ 1)
while [ "$(gh pr view <pr-number> --repo mthines/lorekit --json reviews \
  --jq '.reviews | map(select(.author.login == "dash0-dev")) | length')" -lt 1 ]; do
  sleep 10
done
```

### Step 4 — Implement review suggestions

Once the Dash0 bot review is posted, dispatch a sub-agent (subagent_type: general):

> Read /tmp/workspace/agent-skills/skills/workflow/implement-suggestion/SKILL.md and follow it exactly.
> TARGET_PR=<full PR URL>, OWNER=<owner>, REPO=<repo>, NUMBER=<pr number>

The skill fetches all open review comments from human and AI reviewers, validates each through
`/critical` then `/confidence`, applies approved changes as individual commits, pushes to
the existing branch, and resolves addressed threads. Do NOT open a new PR. Do NOT skip the two-gate
validation. Wait for the sub-agent to finish before proceeding to Step 5.

**Note:** Do NOT post `@dash0 resolve` as a PR comment — agent-posted comments do not trigger
the webhook. Run the skill directly as described above.

If the review report contained no actionable suggestions (all gates passed clean), skip this step.

### Step 5 — Fix CI with `/ci-auto-fix`

After the implement-suggestion sub-agent finishes (or if there were no suggestions to implement), run:

```
/ci-auto-fix
```

This uses the `ci-auto-fix` skill (wired in during Prerequisites), diagnoses any failing GitHub
Actions checks, applies a minimal targeted fix, and iterates until all checks are green. The skill
is confidence-gated (>=90 auto-apply, 80-89 ask, <80 escalate) and will never disable or weaken a
check. Skip if CI is already fully green.

### Summary table

| Step | Action | Who triggers |
|------|--------|--------------|
| 0 | Clone agent-skills + run sync-symlinks.sh (once per sandbox) | Agent |
| 1 | Run `/polish` — review + simplify, auto-fix all findings, commit each pass | Agent |
| 2 | Open / push the PR (draft or ready) | Agent |
| 3 | Wait for `dash0-dev` bot review comment | Automatic (Dash0 bot) |
| 4 | Run implement-suggestion skill (or skip if review is clean) | Agent |
| 5 | Run `/ci-auto-fix` until all checks pass (or skip if green) | Agent |

## Scope format (canonical — `::` separator only)

```
global
project::{name}                           project::agent-skills
repo::{owner}/{repo}                      repo::mthines/gw-tools
branch::{owner}/{repo}::{branch}          branch::mthines/gw-tools::feat/x
```

Single `:` → 400 error. All segments lowercased. See [docs/scope-format.md](./docs/scope-format.md).

---

## Auth tiers (MCP server)

1. `SUPABASE_SERVICE_ROLE_KEY` → full access, bypasses RLS (CI only)
2. `lk_rw_*` / `lk_ro_*` / `lk_wo_*` API token → service-role client + **mandatory `user_id` filter** on every query
3. Supabase JWT → user-scoped client, RLS enforced automatically

**Critical:** `api_key` auth uses service-role. ALL queries must `.eq('user_id', userId)`.
Write tools require write permission (`lk_rw_*` / `lk_wo_*`); read tools require read
permission (`lk_rw_*` / `lk_ro_*`). `lk_ro_*` is denied on write tools; `lk_wo_*` is denied
on read tools — both with the standard `-32001` permission-denied error. The gating logic
(`READ_TOOLS`/`WRITE_TOOLS`/`toolRequires`/`tokenPrefixFor`) is a shared pure module,
`packages/mcp-core/src/permissions.ts`, mirrored self-contained into
`supabase/functions/mcp/permissions.ts` (the `limits.ts` pattern) — the Node.js
`mcp-server` has no API-token auth path today and is out of scope for this gating.

---

## Limits & rate limiting

Two abuse guardrails, both free-tier defaults, config-driven, per-user
overridable (no billing built yet — see [docs/limits.md](./docs/limits.md)):

- **Memory cap** (default 5000 active memories/user, raised from 1000 by migration 00032_plans.sql) — enforced authoritatively
  by a `BEFORE INSERT` trigger on `memories` (`enforce_memory_cap()`,
  `supabase/migrations/00004_limits.sql`). Rejections are translated into an
  actionable `LimitError` (code `memory_cap`) by the app layer.
- **Rate limit** (default 120 req/min/user, all MCP methods) — a Postgres-backed
  fixed-window RPC (`lorekit_check_rate_limit()`), called by the transport layer
  right after auth resolves. Blocked requests get HTTP `429` + `Retry-After`.
- Both read their limits through `lorekit_get_limit(user_id, key)` =
  `COALESCE(user_limits override, lorekit_default_limit(key))` — no numeric
  limit is hardcoded in app code. Raising a user's limit is a `user_limits` row
  upsert (SQL) for now.
- Service-role (CI, `user_id IS NULL`) is exempt from both guardrails.

---

## Key files

| File | Purpose |
|------|---------|
| `packages/mcp-server/src/instrumentation.ts` | **First import in index.ts.** OTel SDK init. Must be `async function register()` with `NEXT_RUNTIME === 'nodejs'` guard. |
| `packages/mcp-core/src/scope.ts` | Canonical scope validation + wildcard expansion |
| `packages/mcp-core/src/telemetry.ts` | Shared tracer/meter getters, `lorekit.tool.duration` histogram |
| `packages/web/src/lib/scope.ts` | Lightweight copy of `scopeType` for Next.js bundle (no OTel deps) |
| `packages/web/src/lib/tokens.ts` | Server actions: `generateToken`, `listTokens`, `revokeToken` |
| `packages/web/src/components/providers/Dash0Provider.tsx` | Browser RUM init via `@dash0/sdk-web`. Mounted in root layout. |
| `supabase/functions/mcp/index.ts` | Self-contained Deno MCP server (production) |
| `supabase/functions/_shared/otel.ts` | Reusable OTel for Edge Functions: `traceRequest()`, `createTracedClient()` |
| `supabase/migrations/00001_memories.sql` | `memories` table, FTS, RLS |
| `supabase/migrations/00002_api_tokens.sql` | `api_tokens` table, RLS |
| `supabase/migrations/00004_limits.sql` | Memory cap trigger (`enforce_memory_cap`), rate-limit RPC (`lorekit_check_rate_limit`), `user_limits` override table, `lorekit_get_limit`/`lorekit_default_limit` config source |
| `packages/mcp-core/src/auth-token.ts` | Pure `extractToken` — resolves the raw Bearer token from `Authorization` header or `?token=` query parameter; import-free so it can be mirrored verbatim into `supabase/functions/mcp/auth-token.ts` and kept in sync by `edge-parity.spec.ts` |
| `packages/mcp-core/src/trace-context.ts` | Pure W3C `traceparent` parse/format — `parseTraceparent` (strict: lowercase hex, no all-zero ids, `ff` rejected, `00` fixed at 4 fields, future versions may append), `formatTraceparent`, `isValidTraceId`/`isValidSpanId`; import-free so it can be mirrored verbatim into `supabase/functions/_shared/trace-context.ts` and kept in sync by `edge-parity.spec.ts` |
| `packages/mcp-core/src/limits.ts` | `LimitError`, `translateCapError`, `checkRateLimit`, `rateLimitMessage` — mirrored self-contained in `supabase/functions/mcp/limits.ts` for the Deno edge function |
| `packages/mcp-core/src/permissions.ts` | `READ_TOOLS`/`WRITE_TOOLS`, `toolRequires`, `tokenPrefixFor` — the `lk_rw_`/`lk_ro_`/`lk_wo_` prefix derivation and read/write tool-gating switch. Mirrored self-contained in `supabase/functions/mcp/permissions.ts` (edge) and lightly in `packages/web/src/lib/token-permission.ts` (web, `permissionSuffix`/`tierFor`/`PERMISSION_TIERS`) — the `limits.ts` pattern |
| `supabase/migrations/00008_webhook_secrets_repo.sql` | Adds nullable `repo` column (`owner/name`, CHECK-constrained) to `webhook_secrets`; partial unique index `(user_id, coalesce(repo,'')) where active` — one active secret per `(user, repo)` |
| `packages/mcp-core/src/webhook-secret-select.ts` | Pure `selectWebhookSecrets` — matches active rows by `repository.full_name`, falls back to a legacy null-`repo` row, then `GITHUB_WEBHOOK_SECRET` — mirrored self-contained in `supabase/functions/mcp/webhook-secret-select.ts` for the Deno edge function |
| `supabase/migrations/00009_memory_write_created_at.sql` | Drops + recreates the `memory_write` RPC with an optional `p_created_at timestamptz default null`; INSERT uses `coalesce(p_created_at, now())` for both `created_at` and `updated_at` (conflict-update never touches `created_at`). Lets `memory.write` backdate a migrated memory. No table change — `created_at` already existed |
| `packages/mcp-core/src/ttl.ts` | Pure `parseTtlDays` — validates the optional `memory.write` `ttl_days` override (1–365 integer, rejects 0/fractional/non-finite). Mirrored self-contained in `supabase/functions/mcp/ttl.ts` (the `limits.ts` pattern). |
| `packages/mcp-core/src/created-at.ts` | Pure `parseCreatedAt` — validates the optional `memory.write` `created_at` override, normalises to ISO, rejects invalid + future dates (60s skew). Mirrored self-contained in `supabase/functions/mcp/created-at.ts` (edge) and `packages/cli/src/store/created-at.mjs` (zero-dep CLI) — the `limits.ts` pattern |
| `supabase/functions/mcp/webhook.ts` | GitHub webhook handler; `resolveSecrets()` queries `webhook_secrets` by `full_name` — when `GITHUB_APP_ENABLED=true` and the event is an App-delivered lifecycle event, routes to `GITHUB_APP_WEBHOOK_SECRET` instead (single app secret, no per-repo lookup) |
| `supabase/migrations/00037_github_installations.sql` | `github_installations` (UNIQUE `installation_id`, `user_id` nullable, `status pending/linked/removed`) + `installation_repositories` (FK, `full_name`, `active`); 4 SECURITY DEFINER RPCs (`lorekit_installation_upsert` idempotent ON CONFLICT, `lorekit_installation_remove_repos`, `lorekit_installation_remove`, `lorekit_find_user_by_github_id`); RLS: authenticated users see only `status='linked'` rows where `user_id=auth.uid()` |
| `packages/mcp-core/src/webhook-installation.ts` | Three pure exports: `mapInstallationEvent` (event→action→reconcile op), `reconcileInstallation` (GitHub account id + known user → `linked/pending` verdict — "dropped installation" is unrepresentable), `buildInstallationTokenClaims` (clock-injected JWT claim set). Mirrored self-contained in `supabase/functions/mcp/webhook-installation.ts`; drift guarded by `edge-parity.spec.ts` MIRRORS — the `limits.ts` pattern |
| `packages/web/src/lib/github-installations.ts` | Server actions: `listGithubInstallations()` (RLS-scoped) + `handleSetupReturn(installationId, setupAction, state?)` — associates a pending App installation with the authenticated session using the service-role client to query `auth.identities` |
| `packages/web/src/components/dashboard/GithubAppManager.tsx` | GitHub App installation section for the webhooks settings page; shows linked installations + App-covered repos; App-covered repos are visually distinct from manually secret-configured repos (mirrors `WebhookSecretManager` composition) |
| `packages/web/src/lib/webhook-secrets.ts` | Server actions: `listWebhookSecrets`, `generateWebhookSecret(repo)` — per-repo, Supabase-JWT + RLS scoped (not an `lk_rw_*` API token path) |
| `packages/web/src/lib/repo-format.ts` | Pure `normalizeRepo` — validates/lowercases a bare `owner/name` repo identifier |
| `packages/web/src/lib/auth-redirect.ts` | Pure `safeNextPath` + `DEFAULT_POST_LOGIN_PATH` — the SINGLE same-origin rule for the attacker-controllable `?next=` param, shared by `/api/auth/callback` and the client-side password sign-in so the two can't drift |
| `packages/web/src/lib/auth-callback-url.ts` | Pure `buildAuthCallbackUrl(base, next)` (sanitises `next` via `safeNextPath`) + browser-only `authCallbackOrigin()` — every `redirectTo`/`emailRedirectTo` in the dashboard is built here |
| `packages/web/src/lib/password-policy.ts` | Pure `MIN_PASSWORD_LENGTH` (8) + `validatePassword` / `validatePasswordConfirmation` — client-side pre-flight only; the authoritative policy is the Supabase project's `minimum_password_length` (the hosted Auth setting, mirrored locally in `supabase/config.toml`), which must stay ≤ this value — the UI may be stricter than the backend, never laxer |
| `packages/web/src/lib/auth-errors.ts` | Pure `friendlyAuthError` — the single Supabase-auth-error → user-copy mapping for every auth surface (password sign-in/sign-up, magic link, reset, settings). Invalid credentials map to one message for both "wrong password" and "no such account" — no enumeration oracle |
| `packages/web/src/components/auth/LoginButton.tsx` | The whole sign-in flow: GitHub OAuth, email + password (sign in / create account), and magic link, plus the link to `/forgot-password`. Password sign-in navigates client-side via `router.push(safeNextPath(next))`; OAuth/magic-link/sign-up still round-trip through `/api/auth/callback` |
| `packages/web/src/app/(auth)/forgot-password/` + `update-password/` | Password recovery: request a reset link (`resetPasswordForEmail` → `/api/auth/callback?next=/update-password`), then set the new password against the session the callback established. Both `noindex` |
| `packages/web/src/components/settings/PasswordPanel.tsx` | Settings → User "Password" section — one `updateUser({ password })` form that both ADDS a password to a GitHub/magic-link account and rotates an existing one |
| `supabase/migrations/00010_audit_log.sql` | `audit_log` table (bounded `action` CHECK over 11 actions), append-only RLS (SELECT + scoped INSERT only, no update/delete), `(user_id, created_at desc)` + `(action)` indexes, and the `audit_user_limits()` trigger (the D2 exception — see Key decisions) |
| `supabase/migrations/00011_memory_write_inserted.sql` | Drop + recreate `memory_write` adding an additive `inserted boolean` (`RETURNING (xmax = 0) AS inserted`) so callers can discriminate `memory.create` vs `memory.update` for the audit log |
| `packages/mcp-core/src/audit.ts` | `AUDIT_ACTIONS`/`AuditAction`, pure `buildAuditEntry`, non-throwing `recordAudit` — mirrored self-contained in `supabase/functions/mcp/audit.ts` for the Deno edge function |
| `packages/web/src/lib/audit-log.ts` | Server actions: `recordAuditEvent` (non-throwing writer), `listAuditLog(filters)` (RLS-scoped, keyset-paginated reader returning `{ rows, nextCursor, hasMore }`) — powers Settings → Audit Logs |
| `packages/web/src/lib/audit-actions.ts` | `AuditAction` union (re-declared, no `@lorekit/core` dependency in `web`) + `AUDIT_ACTION_META` single-record badge metadata; includes `'github_app.installation_linked'` |
| `supabase/migrations/00014_orgs.sql` | `orgs` + `org_members(role)` tables (RLS, member-scoped select policies) and `lorekit_member_org_ids(uuid)` — the single `SECURITY DEFINER` membership-truth function (org-sharing Phase 1 foundations; see plan `.agent/claude/memory-scope-sharing-ualfuz/plan.md`) |
| `supabase/migrations/00015_memories_org_fk.sql` | Converts `memories.org_id` from dormant free-text to a nullable FK → `orgs(id)`; drops the unsafe `auth.jwt() ->> 'org_id'` RLS read policies and recreates them via `lorekit_member_org_ids(auth.uid())` |
| `supabase/migrations/00016_memories_org_unique_arbiter.sql` | Replaces the two `00003` partial unique indexes with three mutually-exclusive org/personal/service partial indexes; re-pins `memory_write`'s `ON CONFLICT` predicates to match (no signature change — writes stay personal-only in Phase 1) |
| `packages/mcp-core/src/tenant-scope.ts` | `applyTenantScope` — the single widened tenant-visibility predicate (total function; empty `orgIds` never emits `org_id.in.()`), consumed by the edge api_key read handlers. Mirrored self-contained in `supabase/functions/mcp/tenant-scope.ts`, guarded by `edge-parity.spec.ts`. The RLS side of the same predicate is `lorekit_member_org_ids()` (00014) — see Key decisions |
| `scripts/sync-edge-schemas.mjs` | Generates `supabase/functions/_shared/schemas/**` from `packages/schemas/src/**` (7 reachable files; `index.ts` and `openapi/generate.ts` excluded). Only transform: bare `zod` / `@asteasolutions/zod-to-openapi` → fully-qualified `npm:` specifiers. `--check` mode fails when the mirror is stale. Edit `packages/schemas/src`, never the mirror |
| `packages/mcp-core/src/edge-bare-specifier.spec.ts` | Boot guard: walks each edge function's module graph and asserts every specifier is self-resolving (relative / `npm:` / `jsr:` / `node:` / URL), that no function reaches source outside `supabase/functions/`, and that no `import_map` declaration returns to `config.toml`. Pure source scan — runs in the mocked `check` job, so a boot-breaking import fails on the PR instead of at runtime |
| `packages/mcp-core/src/edge-schema-parity.spec.ts` | Drift guard for the schema mirror — asserts each mirrored file is exactly what `sync-edge-schemas.mjs` would emit, and that source and mirror differ ONLY by the `npm:` rewrite |
| `packages/mcp-core/src/tenant-scope-usage.spec.ts` | Source-scan drift guard: asserts every edge `tools.ts` read handler (`toolRead`/`toolList`/`toolSearch`/`toolListArchived`) routes through `applyTenantScope`, not an inlined `.eq('user_id', ...)` |
| `packages/web/src/lib/pagination/` | Pure, audit-decoupled keyset-pagination + filter module: `cursor.ts` (opaque base64url cursor codec, fails closed to `null` on any malformed/forged input — safe because callers still apply their own `user_id` scoping), `keyset.ts` (`clampPageSize`, the `(created_at desc, id desc)` `.or()` predicate, fetch+1 → page assembly), `filters.ts` (`normalizeActions` against a caller-supplied allow-set, LIKE/PostgREST-escaping `substringNeedle`, inclusive-`from`/half-open-`to` `dateRangeBounds`), `apply.ts` (thin supabase-js query-builder shell). Each pure file has a co-located `.spec.ts` (mirrors `aggregations.spec.ts`/`repo-format.spec.ts`); composed by `listAuditLog` in `audit-log.ts`, the only current consumer |
| `packages/web/src/lib/queries/audit-log.ts` | `useAuditLog` — `useInfiniteQuery` over the `listAuditLog` server action, keyed by the URL-backed filter state (action set / name / date range); drives the feed's "Load more" |
| `supabase/migrations/00012_audit_log_search.sql` | Enables `pg_trgm` + a GIN trigram index on `audit_log.target` (index-backed `ilike` name search) and a `(user_id, created_at desc, id)` index covering the keyset seek (00010's `(user_id, created_at desc)` index lacks the `id` tiebreaker) |
| `supabase/migrations/00017_org_roles_and_author.sql` | Adds `viewer` to the `org_members.role` CHECK; adds `memories.created_by`/`updated_by`; creates `lorekit_org_role` + `lorekit_org_can(user, org, capability)` — the single `SECURITY DEFINER` capability source for org writes/deletes (org-sharing Phase 2; see plan `.agent/claude/org-sharing-phase-2-writes/plan.md`) |
| `supabase/migrations/00018_org_limits.sql` | `org_limits` table (mirrors `user_limits`) + `lorekit_get_org_limit`; re-creates `enforce_memory_cap()` with an org branch that runs BEFORE the `user_id IS NULL` service exemption, so an org-owned row (always `user_id NULL`) is never cap-exempt |
| `supabase/migrations/00019_memory_write_org.sql` | Drop+recreate `memory_write` with a trailing `p_org_slug`: resolves the slug and requires `lorekit_org_can(writer, org_id, 'write')` inside the RPC (never trusts a caller-supplied org id); sets `created_by`/`updated_by` on every branch; org upsert-clobber preserves `created_by`/`created_at` |
| `supabase/migrations/00020_memory_delete_org.sql` | New `memory_delete(p_user_id, p_org_slug, p_scope, p_key, p_force)` RPC — role-gated (`'archive'` for soft-delete, `'hard_delete'` for `p_force`) for the org branch; personal branch mirrors the pre-existing `.eq(user_id, ...)` delete/archive behavior |
| `packages/mcp-core/src/org-permissions.ts` | `ORG_PERMISSION_SQLSTATE` (`LK002`), `OrgPermissionError`, `translateOrgPermissionError` — translates an org-authorization denial into an actionable error; the role→capability matrix itself lives only in `lorekit_org_can`, never duplicated here. Import-free, mirrored verbatim into `supabase/functions/mcp/org-permissions.ts` and guarded by `edge-parity.spec.ts` `MIRRORS` (the `limits.ts` pattern) |
| `supabase/migrations/00021_org_invites.sql` | `org_invites` table (identity-bound email/handle, `role` excludes `owner`, `status` lifecycle, partial-unique per pending `(org, identity)`) + its two SELECT RLS policies (manager-visible via `lorekit_org_can('invite')`, invitee-visible via verified JWT `email`/`user_metadata.user_name`); widens `rls_org_members_select` (00012) from own-row-only to all co-members via `lorekit_org_role` (org-sharing Phase 3; see plan `.agent/claude/org-sharing-phase-3-org-backend/plan.md`) |
| `supabase/migrations/00022_org_management_rpcs.sql` | Extends `lorekit_org_can` with 6 management capabilities (`invite`/`revoke_invite`/`remove_member`/`change_role`/`rename_org`/`delete_org`); the 10 SECURITY DEFINER membership-write RPCs (`lorekit_org_create`/`_rename`/`_delete`/`_invite`/`_invite_revoke`/`_invite_accept`/`_invite_decline`/`_member_remove`/`_member_role`/`_leave`), each resolving the actor as `auth.uid()` (never a caller-passed user-id); `lorekit_invite_addressed_to_caller` — the shared, NULL-safe identity-match helper accept/decline both call |
| `supabase/migrations/00023_audit_log_org_actions.sql` | Forward-only drop+re-add of the `audit_log.action` CHECK, widened to admit the 10 org-management actions (`org.*`, `member.*`) |
| `supabase/migrations/00024_org_member_identities.sql` | Org-sharing Phase 4 dashboard addition (reverses Phase 4 plan's Decision D1 deferral): `lorekit_org_members_list(p_org_id)` — SECURITY DEFINER, `lorekit_org_role`-gated, resolves every co-member's real GitHub handle/avatar (`auth.users.raw_user_meta_data`) for orgs the caller belongs to; no `anon` grant (PII-bearing, unlike the boolean-only `lorekit_member_org_ids`/`lorekit_org_role`) |
| `packages/web/src/lib/org-members.ts` | `listMemberIdentities(orgId)` server action wrapping `lorekit_org_members_list` — powers real member handles/avatars in `OrganizationManager`'s member list and "last updated by @handle" in `LessonDetailSheet` (falls back to a generic "a team member" when the author can't be resolved) |
| `supabase/migrations/00025_safe_org_deletion.sql` | Safe org deletion: adds nullable `orgs.deleted_at`; re-creates `lorekit_member_org_ids` to exclude soft-deleted orgs (the single change that hides a deleted org's lore from all reads); makes `lorekit_org_delete` a soft-delete (stamps `deleted_at`); adds owner-only `lorekit_org_purge` (real cascading delete); adds `deleted_at is null` to `rls_orgs_select` |
| `supabase/migrations/00026_scope_org_bindings.sql` | Scope→org binding: `org_scope_bindings` table (globally-unique `scope` → one org, member-visible RLS-select, RPC-only writes) + `lorekit_scope_bind`/`_unbind` (SECURITY DEFINER, `auth.uid()` actor, gated on a new `manage_scopes` capability on `lorekit_org_can`). Drop+recreate `memory_write` so that when NO explicit `p_org_slug` is given it consults the binding: a write-capable member's write auto-routes to the bound org; a non-member's falls back to **personal** (never rejected). Return grows additive `org_routed`/`binding_org_slug` columns so the edge surfaces a graceful notice. Explicit `p_org_slug` still wins |
| `supabase/migrations/00027_audit_log_scope_actions.sql` | Forward-only drop+re-add of the `audit_log.action` CHECK, widened to admit `scope.bind` and `scope.unbind` so the web server-action `recordAuditEvent` calls for bind/unbind succeed (same pattern as `00023_audit_log_org_actions.sql`) |
| `supabase/migrations/00028_invite_org_details.sql` | Invite-details modal: `lorekit_invite_org_details(p_invite_id)` — SECURITY DEFINER, gated on the existing `lorekit_invite_addressed_to_caller` (00022, never re-derived), returns Tier-A org details ONLY (`org_name`, `org_slug`, `org_created_at`, an aggregate `member_count`, `inviter_handle`/`inviter_avatar_url` resolved from `auth.users.raw_user_meta_data`) for a PENDING invite addressed to the caller; empty set (never raises) for any invite that doesn't exist, isn't pending, or isn't addressed to the caller — never leaks existence. No `anon` grant (PII-bearing, same posture as `lorekit_org_members_list`); adds no policy and touches no existing function |
| `supabase/migrations/00030_memory_ttl.sql` | Adds nullable `memories.expires_at` column, a partial index, the `purge_expired_memories(p_user_id)` RPC, and recreates `memory_write` with a trailing `p_ttl_days integer default null`. Callers pass `ttl_days` (1–365) to auto-expire a memory. All active-read paths (`toolRead`, `toolList`, `toolSearch`, the Node `read`/`list`/`search` tools) filter `expires_at IS NULL OR expires_at > now()`. |
| `supabase/migrations/00031_memory_ttl_clear.sql` | Adds `p_clear_ttl boolean default false` to `memory_write`. When true, sets `expires_at = NULL` (makes the row permanent again). Tri-state action var (`'clear' | 'set' | 'keep'`) keeps the CASE WHEN readable; `p_clear_ttl` beats `p_ttl_days` when both are supplied. |
| `packages/mcp-core/src/ttl.ts` | Pure `parseTtlDays` — validates the optional `memory.write` `ttl_days` override (1–365 integer, rejects 0/fractional/non-finite). Mirrored self-contained in `supabase/functions/mcp/ttl.ts` (the `limits.ts` pattern). |
| `supabase/migrations/00039_memory_scopes.sql` | `lorekit_memory_scopes(p_user_id)` — SECURITY DEFINER + STABLE, returns `(scope, count)` for every scope the caller can see with its active (non-archived, non-expired) row count, sorted by scope. Backs `GET /memories/scopes`, the REST answer to the CLI's `listScopes()` "unsupported" sentinel. Aggregates in Postgres deliberately: the `select('scope')`-plus-client-side-`Set` form (`packages/web/src/lib/queries/lore.ts`) silently omits scopes past PostgREST's row cap. Visibility reuses `lorekit_member_org_ids` exactly as the `memories` RLS read policies do — never a hand-rolled tenant predicate; a `p_user_id is null` + `auth.role() = 'service_role'` branch is the CI escape hatch and fails closed for anyone else. `plpgsql` (not SQL) so the `order by` can't be lost to inlining. No `anon` grant (scope names embed repo/project names) — same posture as `lorekit_member_org_ids` |
| `packages/web/src/lib/scope-bindings.ts` | Server actions: scope-binding lifecycle (`listScopeBindings`, `bindScope`, `unbindScope`) — Supabase user JWT + RLS reads, `.rpc()` writes, non-throwing `recordAuditEvent`. `bindScope` translates `scope_bound_elsewhere` (P0001) and `LK002` (permission) errors into user-facing messages |
| `packages/web/src/lib/ownership.ts` | Pure `ownerFromMemoryRow` — collapses a memory row's `org_id` + embedded `orgs(name,slug)` join into one optional `MemoryOwner` field (`undefined` for personal lore); the org-sharing Phase 4 dashboard UX's ownership derivation |
| `packages/web/src/lib/org-ui.ts` | Pure UI decision logic for the Organization dashboard: `roleCapabilities` (single-source role→UI-affordance matrix mirroring `lorekit_org_can`), `canActOnOrgMember`, `filterByOwnership`, `classifyInviteInput`, `visibleInvites`/`pendingInviteCount`, `memberCountLabel`/`inviteExpiryLabel` (invite-details modal display labels, injected-`now` clock for testability) |
| `packages/web/src/lib/org-slug.ts` | Pure `normalizeSlug` — total-function org-slug validator (`^[a-z0-9-]+$`, length-bounded), mirrors `repo-format.ts`'s `normalizeRepo` shape |
| `packages/web/src/lib/orgs.ts` | Server actions: org lifecycle + member management (`createOrg`, `listMyOrgs`, `getOrg`, `renameOrg`, `deleteOrg`, `listMembers`, `removeMember`, `changeMemberRole`, `leaveOrg`) — Supabase user JWT + RLS reads, `.rpc()` writes, non-throwing `recordAuditEvent` |
| `packages/web/src/lib/org-invites.ts` | Server actions: invite lifecycle (`inviteMember`, `listInvites`, `revokeInvite`, `acceptInvite`, `declineInvite`, `listPendingInvitesForMe`) — same JWT+RLS/RPC split; `acceptInvite` never passes any identity of its own, relying on `lorekit_org_invite_accept` to derive it from `auth.uid()`. Also `getInviteOrgDetails(inviteId)`, a total function (`InviteOrgDetails \| null`) wrapping `lorekit_invite_org_details` (00028) for the invite-details modal |
| `packages/web/src/components/dashboard/InviteDetailsDialog.tsx` | Focus-managed details dialog (reuses `ConfirmDialog`'s a11y patterns: focus trap, Escape, `role="dialog"`/`aria-modal`, `min-h-11`) letting a pending invitee review the inviting org's Tier-A details before acting; fetches lazily via `getInviteOrgDetails` on open; Accept/Decline are the SAME callbacks `PendingInvitesBanner` passes to its own quick actions — no second, divergent accept path |

---

## OTel attributes (custom)

All `lorekit.*` spans carry:
- `lorekit.tool.name` — bounded: `memory.write|read|list|delete|search`
- `lorekit.scope` — canonical scope string
- `lorekit.scope.type` — bounded: `global|project|repo|branch`
- `lorekit.key` — lesson key
- `service.namespace` — always `lorekit`
- `deployment.environment.name` — `production|preview|development|local` (from `VERCEL_ENV`)

Metric: `lorekit.tool.duration` histogram (unit `s`) with `lorekit.tool.name` + `lorekit.scope.type`.

### Trace-context propagation (W3C `traceparent`)

- **Who sends it.** The CLI attaches `traceparent` to every outgoing REST call (`restFetch`)
  and every MCP call (`mcpCall` — `memory.delete --force` and all four `org.*` ops), sourced
  from `getActiveTraceparent()` in `packages/cli/src/telemetry.mjs`. Context is generated for
  **every** `traceCommand` run, including when telemetry export is disabled — propagation is
  decoupled from export. The browser sends it via `@dash0/sdk-web`. The Next.js **server**
  side sends it via `@vercel/otel`'s fetch instrumentation, configured in
  `packages/web/src/instrumentation.ts` — this needs an explicit
  `fetch: { propagateContextUrls: [...] }`, because `@vercel/otel` propagates context ONLY to
  Vercel deployment URLs by default. Without it every server action / RSC call to Supabase
  produced an orphan PostgREST / Edge Function span.
- **The Supabase origin allow-list lives in exactly one place** —
  `packages/web/src/lib/otel-origins.ts` (`supabaseOriginPattern()`), consumed by all three
  web call sites (`instrumentation.ts` server, `instrumentation-client.ts` browser,
  `Dash0Provider.tsx` browser) so browser and server can never drift. It is dependency-free
  (no React, no `next/*`, no node builtins) because it is evaluated in both the Node runtime
  and the browser bundle, and reads `process.env['NEXT_PUBLIC_SUPABASE_PROJECT_REF']` as a
  literal member expression so Next.js can inline it at build time. The pattern is anchored
  (`^https://…`) so a nested URL such as `https://evil.com/https://<ref>.supabase.co/x` never
  matches and plain `http://` is excluded. When the project ref is **unset** it deliberately
  fails open to any `*.supabase.co` / `*.supabase.in` host (kept so local/preview setups
  without the var still propagate) and emits a one-time `console.warn` so the widening is
  visible rather than silent.
- **Who receives it.** Every edge function's `traceRequest` (`supabase/functions/_shared/otel.ts`)
  parses the inbound header; an invalid one falls back to a new root trace instead of a corrupt
  span. Responses carry a `traceparent` back (exposed via `Access-Control-Expose-Headers`) so a
  client can correlate with the server span.
- **The parser** is `packages/mcp-core/src/trace-context.ts` (`parseTraceparent` /
  `formatTraceparent` / `isValidTraceId` / `isValidSpanId`), import-free and mirrored verbatim
  to `supabase/functions/_shared/trace-context.ts`; drift is parity-guarded by
  `edge-parity.spec.ts`. Strict W3C validation: lowercase hex only, no all-zero ids, version
  `ff` rejected, version `00` fixed at four fields, future versions may append fields.
- **Span kinds.** Root request spans are SERVER (2), `TracedQuery` DB spans are CLIENT (3),
  everything else INTERNAL (1) — required for service-to-service edges in an APM.
- **The sampled flag is recorded and propagated, never acted on.** Edge spans emit
  `flags: sampled ? 1 : 0` and children inherit the parent's flag, but export stays AlwaysOn —
  sampling is deferred to the Dash0 pipeline (see Key decisions). Never turn the flag into a
  drop condition. The CLI emits flags `01` when its span will be exported and `00` when it will
  not, still carrying the trace id either way so the server can correlate.

### `service.name` inventory

Every emitting component and where its `service.name` is configured. A collision here
collapses two components into one indistinguishable node in the service map — keep these
unique.

| `service.name` | Component | Set in |
|---|---|---|
| `api` | **All** Supabase Edge Functions (`memories`, `orgs`, `openapi`, `mcp`, `health`) | Hard-coded in `supabase/functions/_shared/otel.ts`. No configuration required. |
| `mcp-node` | Node MCP server (Fly.io) | `OTEL_SERVICE_NAME`, default in `packages/mcp-server/src/instrumentation.ts` |
| `web` | Next.js (server + browser) | `packages/web/src/instrumentation.ts`, `packages/web/src/instrumentation-client.ts`, `packages/web/src/components/providers/Dash0Provider.tsx` |
| `lorekit-cli` | CLI | `packages/cli/src/telemetry.mjs` |

- **The edge functions are one service, not five.** They share a deployment, a database and a
  lifecycle; each function is an *operation* on `api`, not a separate service. Splitting them
  fragments the service map for no analytical gain.
- **Tell the functions apart with `faas.name`**, set on every root span by `traceRequest` and
  derived from the operation name (`lorekit.memories` → `memories`, `lorekit.webhook.github` →
  `webhook.github`). The span name carries the same information. A new function gets this for
  free and cannot forget to set it.
- **Do not reintroduce a per-function `SERVICE_NAME` secret.** Supabase secrets are
  project-wide, not per-function, so one value can never name five functions — the previous
  attempt left `mcp` and `health` silently sharing a fallback name. The `SERVICE_NAME` env var
  is still honoured as an escape hatch, but nothing needs to set it and `config.toml` sets none.
- `service.namespace` is **`lorekit`** everywhere — hard-coded in each component's resource
  (including `packages/mcp-server/src/instrumentation.ts`, which no longer delegates it to
  `OTEL_RESOURCE_ATTRIBUTES`), never env-dependent.
- The Node MCP server is `mcp-node`, deliberately distinct from the edge `api`: it is a
  separate deployment (Fly.io) with its own lifecycle, so it stays its own service.
- The Supabase origin pattern used for browser + server trace-context propagation lives in one
  place: `packages/web/src/lib/otel-origins.ts`.

---

## Endpoints

The production Supabase project ref is **`pqokxlhvnosogizsjztg`** (static). Always
write the concrete endpoint below in any user-facing surface — dashboard copy,
Learn pages, config examples, docs — **NEVER** a `<ref>` / `<project-ref>`
placeholder for the MCP server URL.

| URL | Auth | Purpose |
|-----|------|---------|
| `https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp` | Bearer token required | MCP server for agents |
| `https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/health` | None (public) | Uptime monitoring |
| `https://lorekit.io` | GitHub OAuth, email + password, or magic link | Web dashboard |

---

## Key decisions (do not relitigate)

- **The MCP server endpoint is a static production URL — never write a `<ref>` placeholder in user-facing content.** The hosted MCP server lives at a fixed Supabase project ref (`pqokxlhvnosogizsjztg`), so any URL an end user sees — Getting started / Learn pages, `.lorekit.json` / config examples, dashboard copy, docs — MUST use the concrete `https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp` (the same literal `GettingStartedContent.tsx`'s `MCP_URL` uses), NOT `https://<ref>.supabase.co/...` or `<project-ref>`. A placeholder is only acceptable in migration/deploy tooling that legitimately targets multiple projects (e.g. the `resolveProjectConnection` `<project-ref>` guard, which *rejects* an unconfigured placeholder). See the Endpoints table.
- `::` separator avoids collision with `/` in repo paths and `:` in branch names
- `lk_rw_` prefix encodes permission visibly in config files
- Write-only tokens (`lk_wo_*`) store `permissions: ['write']` in the existing `text[]` column — zero migration. Prefix derivation and tool gating (`READ_TOOLS`/`WRITE_TOOLS`/`toolRequires`/`tokenPrefixFor`) are consolidated into a shared pure module (`packages/mcp-core/src/permissions.ts`), mirrored self-contained into the edge function and lightly into web — the same reasoning as `limits.ts`/`webhook-secret-select.ts`: the edge function has no test harness, so the pure module is the only unit-testable home for gating logic. The Node.js `mcp-server` gets no gating — it has no API-token auth path at all, and adding one is out of scope.
- Token SHA-256 hash in DB — shown once, never stored in plain text
- `AlwaysOn` OTel sampler — sampling deferred to Dash0 pipeline, never SDK-side
- `instrumentation.ts` must be `async function register()` with `NEXT_RUNTIME === 'nodejs'` guard
- `Dash0Provider` React component is the primary RUM init path (explicit, visible in component tree)
- Edge Function is self-contained Deno (no cross-package imports) — Node.js MCP SDK incompatible with Deno. **This is enforced, not advisory, as of the import-map removal:** `memories`/`orgs`/`openapi` violated it by importing `@lorekit/schemas/*` and `zod` as BARE specifiers, which resolve only if something hands Deno `supabase/functions/import_map.json`. Nothing did — current Supabase CLI versions dropped auto-discovery of that filename and `setup-cli` pins `version: latest`, so it broke with no commit to blame, and all three died at boot with `Relative import path "@lorekit/schemas/memory" not prefixed with / or ./ or ../`, visible only as an opaque `503 BOOT_ERROR` through the REST passthrough (six CI runs across five branches before the container log was ever captured). Declaring `import_map` per function in `config.toml` was tried and does NOT reach the local `supabase start` runtime. The map is now **deleted**: schemas are mirrored into `supabase/functions/_shared/schemas/` (`node scripts/sync-edge-schemas.mjs`, the `limits.ts` mirror pattern) and `zod` / `@asteasolutions/zod-to-openapi` are written as fully-qualified `npm:` specifiers. Two guards run in the mocked `check` job: `edge-bare-specifier.spec.ts` (no file reachable from a function may use a bare specifier, and no function may reach source outside `supabase/functions/`) and `edge-schema-parity.spec.ts` (the mirror matches `packages/schemas/src` exactly, modulo the `npm:` rewrite). Never add an import map back — the invariant is stronger and cannot be disabled by a CLI upgrade.
- NX 22.4.0 — matches `gw-tools` exactly; bump both together
- Memory cap enforced by a DB trigger (not app-side counting) — the write-path `userId` is auth-type-sensitive (null for JWT users, RLS-scoped), so only a `NEW.user_id`-keyed trigger is auth-agnostic and unbypassable
- Rate limiting is a Postgres-backed fixed-window counter (not in-memory or Redis) — edge isolates are stateless/short-lived; no new infra required
- Limits config lives in one DB function (`lorekit_default_limit`) + one override table (`user_limits`) — no numeric limit hardcoded in app code, so raising a user's ceiling is a single row upsert (paid-tier-ready, no billing built now)
- Webhook secrets are **repo-scoped**, matched by the delivery's `repository.full_name` against a stored `repo` column (`webhook_secrets.repo`, nullable) — not by joining `repository.owner.login` against `auth.users` (that join is O(all users), capped at 1000, and fails for org-owned repos where the owner login is the org, not any user's personal GitHub login). A null-`repo` row is a legacy/global fallback kept for back-compat; `GITHUB_WEBHOOK_SECRET` remains the last-resort env-var fallback. The selection logic (`selectWebhookSecrets`) is pure and lives in `packages/mcp-core` (vitest-tested, no Deno test harness exists), mirrored self-contained into the edge function — the same pattern as `limits.ts`. Webhook server actions authenticate via the Supabase user JWT + RLS, not an `lk_rw_*` API token — the `lk_rw_*` rule is for MCP `api_key` tool calls, not dashboard server actions.
- Audit logging (`audit_log` table, `supabase/migrations/00010_audit_log.sql`) is captured **at the app layer** — an explicit `recordAudit`/`recordAuditEvent` call right after each sensitive mutation succeeds (API-key create/revoke, webhook-secret create/rotate, memory create/update/archive/restore/delete), not by DB triggers on the underlying tables — the app layer can resolve the actor (`auth.uid()` for dashboard actions, the resolved token/user for MCP, `null` for service-role/CI) and shape a human-readable `target`/`metadata` that a trigger on `memories`/`api_tokens`/`webhook_secrets` cannot. **The one deliberate exception is `user_limits`**: no app-layer code path writes that table today (raising a limit is a raw SQL upsert), so there's no call site to instrument — an `AFTER INSERT OR UPDATE OR DELETE` DB trigger (`audit_user_limits()`) is the only way to capture `limit.override` events, mirroring the `enforce_memory_cap()` DB-trigger precedent for the same reason (the write-path actor isn't app-visible there either). `recordAudit`/`recordAuditEvent` never throw — a failed audit write must never break the primary operation it's auditing. Mirrored self-contained into `supabase/functions/mcp/audit.ts` for the Deno edge function, the same pattern as `limits.ts`/`created-at.ts`.
- Org/scope sharing is **ORG-FIRST** (single authoritative shared row owned by an org, not copy-on-share) — Phase 1 (foundations only; full phased arc in `.agent/claude/memory-scope-sharing-ualfuz/plan.md`) ships `orgs`/`org_members` and widens **reads** to org membership; **writes stay personal-only** until Phase 2 (`memory_write` gains no `org_id` parameter this phase). The tenant-visibility predicate lives in exactly ONE enforced place: `lorekit_member_org_ids(uuid)` (`SECURITY DEFINER`, `STABLE`, 00014_orgs.sql), consumed both by the `memories` RLS read policies (00015) and by the mirrored TS helper `applyTenantScope` (`packages/mcp-core/src/tenant-scope.ts` ↔ `supabase/functions/mcp/tenant-scope.ts`, the `limits.ts` mirror pattern) — never a hand-copied `.or()` predicate. `applyTenantScope` is a total function: an empty `orgIds` list returns a personal-only filter and never emits an `org_id.in.()` fragment (that degrades to a PostgREST match-all/error footgun). Two executable drift guards enforce this stays singular: `edge-parity.spec.ts` (mirror parity) and `tenant-scope-usage.spec.ts` (source-scan — every edge read handler must route through `applyTenantScope`, never an inlined `.eq('user_id', ...)`). The uniqueness arbiter partitions org-owned rows (`org_id, scope, key`) separately from personal (`user_id, scope, key` where `org_id is null`) and service-role (`scope, key` where both are null) rows via three mutually-exclusive partial unique indexes (00016) — an org row can never collide with or impersonate the cap-exempt `user_id IS NULL` service partition. `.lorekit/config.json` is (and will remain, per the Phase 4 plan) **advisory only** — membership truth is always the server-side `org_members` table, never a client-committed org pointer.
- Org/scope sharing **Phase 2 (org-owned writes)** opens the write path Phase 1 left closed (`.agent/claude/org-sharing-phase-2-writes/plan.md`). `memory_write` gains a trailing `p_org_slug`, but org ownership is **authorization-derived inside the RPC**, never trusted from the caller: it resolves the slug and requires `lorekit_org_can(writer, org_id, 'write')` — the SOLE role→capability source (`supabase/migrations/00017_org_roles_and_author.sql`), covering a new `viewer` role plus `write`/`archive`/`restore`/`hard_delete` capabilities for `member`/`admin`/`owner`. Author attribution is additive `created_by`/`updated_by` columns (org rows keep `user_id NULL`, so a dedicated author pair records the writer without pooling org rows into the writer's personal cap or RLS partition). The memory cap becomes **tenant-keyed**: `enforce_memory_cap()`'s branch order is org → service-exempt → personal (`00018_org_limits.sql`) — the org branch MUST precede the service exemption because an org row always has `user_id IS NULL`, otherwise it would silently inherit the cap-exempt service partition. Destructive ops route through a new role-gated `memory_delete` RPC (`00020_memory_delete_org.sql`) rather than a raw service-role delete/update, because the edge api_key client bypasses RLS and has no other gate available. Rate limiting stays caller-keyed (`lorekit_check_rate_limit(p_user_id, ...)`, unchanged) — a throughput-per-caller guard, distinct from the tenant-keyed storage cap. The read path is untouched: `applyTenantScope`/`lorekit_member_org_ids` remain the sole tenant-visibility predicate (verified by `tenant-scope-usage.spec.ts` + `edge-parity.spec.ts` staying green). The denial signal is a distinct SQLSTATE `LK002` (vs. the cap's `LK001`), translated by `org-permissions.ts` (mirrored edge-parity-guarded, the `limits.ts` pattern) — the capability matrix itself is never duplicated in TS.
- Audit Logs pagination is **keyset (cursor), not OFFSET** — `listAuditLog` orders `(created_at desc, id desc)` and pages via an opaque `nextCursor` (base64url `{ c, id }`, `packages/web/src/lib/pagination/cursor.ts`). The cursor carries no `user_id`; `listAuditLog` applies its own `.eq('user_id', …)` unconditionally, so a forged/tampered cursor can at worst mis-page the caller's own rows, never widen visibility — that's what makes `decodeCursor` safe to fail closed to `null` (→ first page) without HMAC/signing. Name search (`target ilike '%…%'`) is index-backed by a `pg_trgm` GIN trigram index (`supabase/migrations/00012_audit_log_search.sql`); the keyset seek is covered by `(user_id, created_at desc, id)` (00010's `(user_id, created_at desc)` index lacks the `id` tiebreaker). The pure pagination/filter logic lives in `packages/web/src/lib/pagination/`, decoupled from audit so it's reusable by any future `(timestamp, id)`-ordered list.
- Org/scope sharing **Phase 3 (org management backend)** opens the membership-truth WRITE path Phase 1 deliberately left closed (00012's comment: "only a service-role client can create orgs/memberships" until Phase 3) — see `.agent/claude/org-sharing-phase-3-org-backend/plan.md`. Every state transition (`createOrg`/`renameOrg`/`deleteOrg`, invite/accept/decline/revoke, `removeMember`/`changeMemberRole`/`leaveOrg`) is a **SECURITY DEFINER RPC** in `00022_org_management_rpcs.sql` — `orgs`/`org_members`/`org_invites` carry **no insert/update/delete RLS policy at all**; direct RLS-gated writes were rejected for two reasons: the **owner-bootstrap problem** (the first membership row can't be gated by existing membership, so a self-insert-as-owner policy would let anyone seize any org) and **non-atomic accept** (inserting the membership row and flipping the invite status must happen in one transaction, not two RLS round-trips). Unlike `memory_write`/`memory_delete` (Phase 2, which take an explicit `p_user_id` because the edge `api_key` service-role client has no session JWT of its own), every Phase 3 RPC resolves the actor as `auth.uid()` directly — **no RPC takes a caller-supplied user-id parameter** — because these are dashboard actions invoked under a real Supabase user JWT session. This is the concrete form of the anti-TOCTOU fix: `lorekit_org_invite_accept(p_invite_id)` reads the invite, matches its `invitee_email`/`invitee_handle` against the CALLER's verified JWT claims (`email`, `user_metadata.user_name`) via the shared `lorekit_invite_addressed_to_caller` helper, and only ever inserts `org_members(org_id, auth.uid(), role)` — the invited string is a match target, never the membership subject, so a forwarded invite can only ever be redeemed by the identity it's actually addressed to. `lorekit_invite_addressed_to_caller` explicitly `coalesce`s each side of the identity check to `false`: `NULL = x` is SQL `NULL`, not `false`, and an un-coalesced `or` between a matched email and a NULL handle evaluates to `NULL` — which `if not (...)` treats as `if not false`, silently skipping the authorization exception. This was caught live by `migrations.test.sql`'s AC-6 negative assertion (a different authenticated user accepting a same-org invite) during Phase 3 development and is exactly the kind of bug an SQL-level assertion suite (not just the mocked TS unit tests) exists to catch. `lorekit_org_can` (00015) is **extended, never re-derived**, with six management capabilities (`invite`/`revoke_invite`/`remove_member`/`change_role`/`rename_org`/`delete_org`); capability-independent invariants a static role matrix cannot express (an admin may act only on `member`/`viewer` targets, never `owner`/`admin`; the last remaining owner can never be removed/demoted/left) live as `plpgsql` guards inside the RPC bodies themselves. `org_invites.role` CHECK excludes `owner` outright (ownership is non-transferable in v1) and `rls_org_members_select` is widened from own-row-only (00012) to all co-members of a shared org via `lorekit_org_role`. Dashboard server actions (`orgs.ts`, `org-invites.ts`) mirror `tokens.ts`/`webhook-secrets.ts` exactly — Supabase user JWT + RLS reads, `.rpc()` writes, non-throwing `recordAuditEvent` — and NO dashboard UI ships this phase; the Settings → Organization page, member list, invite form, and accept/decline card are the next stacked PR (Phase 4), per `ux-design.md`.
- Org/scope sharing **Phase 4 (dashboard UX)** wires the Phases 1–3 backend into the Next.js dashboard: a Settings → Organization page (`OrganizationManager`, mirroring `WebhookSecretManager`) for create/invite/member-management, a dismissible pending-invites banner on Overview, and an `OwnershipBadge` (rendered beside, never inside, `ScopeBadge`) plus an Explorer ownership filter (`All · Personal · {org}`, URL-backed via `owner`, pure predicate `filterByOwnership`) threaded through `MemoryCard`/`LessonEntry`/`LessonDetailSheet`. Decision logic stays in pure, node-vitest-tested `.ts` helpers (`lib/ownership.ts`, `lib/org-ui.ts`) per the functional-core/impure-shell split — `roleCapabilities` is the single UI-affordance mirror of `lorekit_org_can`; components never bare-compare `role === '...'`. Two new reusable primitives, `ConfirmDialog` (focus-managed, Escape-closable, symmetric copy) and `ToastProvider` (`role="status"`, `aria-live`), back every destructive action and async confirmation — no dark patterns, `min-h-11` targets throughout. **Mid-phase reversal of the original plan's Decision D1** ("member identity degrades to a bare `user_id` for non-self members, deferred as a fast-follow"): `supabase/migrations/00024_org_member_identities.sql` adds `lorekit_org_members_list(p_org_id)` — SECURITY DEFINER, gated via the existing `lorekit_org_role` (never a new capability, never an `anon` grant since it returns PII) — so the member list and "last updated by" now show real GitHub handles/avatars instead of a truncated UUID. This is the one migration this phase adds; every org *mutation* still calls only the pre-existing `orgs.ts`/`org-invites.ts` server actions (Phases 1–3 SQL is otherwise untouched).
- **Safe org deletion** (`supabase/migrations/00025_safe_org_deletion.sql`) keeps the `memories.org_id` `ON DELETE CASCADE` (the #73 decision) and layers recovery ABOVE it: `lorekit_org_delete` becomes a **soft-delete** (stamps `orgs.deleted_at`), with a separate owner-only `lorekit_org_purge` for the real cascading delete (SQL-only for now — the `audit_log` action CHECK has no `org.purge` value, so a dashboard purge button would need a second CHECK migration; framed as the explicit permanent-delete / grace-period-job path). A soft-deleted org's lore vanishes from **every** read through ONE change — `lorekit_member_org_ids` (the single tenant-visibility predicate, consumed by both the `memories` RLS policies and the mirrored `applyTenantScope`) now joins `orgs` and filters `deleted_at is null`; because callers read the function's *output list*, `tenant-scope.ts` and its drift guards are untouched. `rls_orgs_select` uses a direct `org_members` subquery (not the function), so it gets an explicit `deleted_at is null`; `rls_org_limits_select` routes through the function and is hidden transitively. Retention is a documented `ORG_DELETE_RETENTION_DAYS = 30` (no purge job yet). The dashboard delete flow gets a type-the-org-name `ConfirmDialog` (additive `confirmPhrase` prop) + an "Export lore" JSON download (`exportOrgLore`) offered before deletion.
- **Scope→org binding** (`supabase/migrations/00026_scope_org_bindings.sql`) lets an org admin bind a scope (e.g. a repo) to an org so writes under it auto-route to the org without each write naming it. Authorization stays server-derived (the Phase 2 rule): binding requires the new `manage_scopes` capability (`lorekit_org_can`, extended not re-derived, admin/owner); and a write under a bound scope routes to the org **only if the writer is a write-capable member** — a non-member's write **falls back to personal, never rejected**. `memory_write` (no explicit `p_org_slug`) consults `org_scope_bindings`, and its return grows additive `org_routed` + `binding_org_slug` columns so the edge `toolWrite` can attach an actionable `notice` ("saved personal; this scope is shared with `<org>`, ask an admin") — the graceful-personal-**and-informed** decision (never silent, never a hard reject). Explicit `p_org_slug` always takes precedence (binding lookup skipped). Binding is server-truth in `org_scope_bindings` (globally unique per scope), NOT the advisory `.lorekit/config.json`. The Node/mcp-core path passes `p_user_id: null` (service-role) so it never binding-routes — fail-safe. **This is the backend + MCP routing only; the dashboard "Settings → Shared scopes" UI + Explorer bound-scope badge are the stacked follow-up.** |
- **GitHub App single-secret model** (`supabase/migrations/00037_github_installations.sql`, `supabase/functions/mcp/webhook.ts`): ALL App-delivered events are HMAC-verified against the ONE `GITHUB_APP_WEBHOOK_SECRET` — ZERO `webhook_secrets` rows are written for App-covered repos. The App path is dormant until `GITHUB_APP_ENABLED=true` (env/Supabase secret). Fail-safe pending-identity: a GitHub member with no LoreKit account → `status='pending'`, `user_id NULL`, never dropped; a later login transitions to `status='linked'`. Idempotent upsert via `UNIQUE (installation_id)` + `ON CONFLICT DO UPDATE`. `lorekit_find_user_by_github_id` is a SECURITY DEFINER function that bridges PostgREST's auth-schema limitation (queries `auth.identities` directly). The `?state=` setup-URL return bounce is correlation-only — never grants access; authorization is always `auth.uid()` + RLS. Post-merge runbook in `docs/github-app.md`.
- **Hook scope ordering is unified, and project scope IS injected (reverses the earlier exclusion).** The pre-existing decision that `deriveScope().readOrder` (the hook's injected/resolution set) deliberately EXCLUDED `project::` — so the hooks and `tree` never surfaced project-scoped lessons — is **REVERSED as of the smart-hooks PR**. `readOrder` is now `[projectScope, branchScope, repoScope, 'global']` (null-filtered, deduped), matching the read commands' `scopeList` EXACTLY — one scope ordering everywhere (hook, `tree`, `list`/`search`/`stats`/`diff`/`lint`/`dedupe`), project most-specific so a project lesson wins and is injected. **Accepted caveat:** the offline store keys `project::` by the working directory's **basename** (`scopeToDir` → `project/<basename>`), so two unrelated repos that happen to share a folder name can cross-surface each other's project-scoped lessons — accepted as the out-of-the-box-completeness tradeoff (the alternative, excluding project entirely, left project lessons silently un-injected, which was worse). The hosted/remote store scopes `project::{name}` server-side and is unaffected.
- **The hook's precedence + match logic is a single source of truth with the read commands.** `fetchLessons` (SessionStart hot path) resolves cross-scope precedence via the pure `resolvePrecedence` (first-seen / more-specific-wins, `MAX_LESSONS=15` cap, `limit:25`/scope, best-effort skip on a failed scope read) — the SAME function `tree` renders with — instead of a hand-rolled inline `byKey` merge, so the hook and `tree` provably can't drift. `resolvePrecedence` and `matchesQuery` were extracted from `lessons-view.mjs` into a new **dependency-free `packages/cli/src/lessons-pure.mjs`**, re-exported by `lessons-view.mjs` (so `search`/`tree` and every existing import/test are unchanged). Both the SessionStart read and the failure-relevance lookup import ONLY `lessons-pure.mjs` + `scope.mjs`, never the `util`/render/lint/dedupe surface — keeping the hot path lean while sharing one matcher/resolver. (`matchesQuery` was relocated alongside `resolvePrecedence` because the new failure-injection path needs the exact same literal-substring semantics as `search`; duplicating it or importing the render layer into the hook were both worse than co-locating the two pure primitives.)
- CI/CD is split: `ci.yml` **verifies before merge** (PRs + non-main branches) — `check` runs mocked unit tests, `integration` boots a local Supabase and asserts the stack wires up (migrations apply, functions serve, authenticated MCP `tools/list` → 200) **and** runs `supabase/tests/migrations.test.sql` directly on Postgres — plpgsql `ASSERT`s over the SQL-only business rules (memory-cap + rate-limit triggers/RPCs, RLS user isolation, `memory_write` created_at insert-vs-conflict semantics, webhook-secret partial-unique + repo CHECK) that the mocked unit tests can only assume; the full CRUD `smoke.integration` round-trip runs in `smoke-staging` against a real project, not locally — the local edge runtime's older PostgREST can't resolve the `UNIQUE NULLS NOT DISTINCT` upsert arbiter for service-role writes. The web build is covered by Vercel's own PR check, not CI. `deploy.yml` owns `main` and **deploys the already-verified commit** (no test re-run) as a **preview-first promotion pipeline** (deploy-preview → smoke-preview → deploy-production → smoke-production → rollback-on-failure; the pre-prod GitHub Environment is named `preview`). Tests run once, on the PR; the deploy path only smoke-tests the live deployment. Make `check` + `integration` required status checks — they are the sole gate keeping unverified code off main. Two Supabase projects, secrets scoped via `preview`/`production` GitHub Environments. Migrations are forward-only (expand/contract + PITR); only Edge Functions auto-rollback. `[functions.*] verify_jwt = false` in config.toml mirrors the deploy `--no-verify-jwt` flag and lets `supabase start` serve functions for the integration test. Do not re-merge the workflows or re-add a deploy-time test job — the split is what removed the old double test + double `db push`. See docs/deployment.md.
- **Invite-details modal** (`supabase/migrations/00028_invite_org_details.sql`) lets a PENDING (not-yet-member) invitee see WHICH org invited them before accepting — today `listPendingInvitesForMe`'s `orgs(name, slug)` embed resolves to null for a non-member (the org read policy is member-only), so the banner fell back to "Someone invited you to an organization" with no name. Rather than widen the member-only org read policy (user-forbidden — it would leak org rows to invitees globally), this ships one new SECURITY DEFINER reader, `lorekit_invite_org_details(p_invite_id)`, gated on the EXISTING `lorekit_invite_addressed_to_caller` (00022, never re-derived): it returns Tier-A fields ONLY (org name/slug/created_at, an aggregate member **count**, the inviter's handle/avatar) and explicitly NO per-member identity list (Tier B, declined) — an empty set, never a raised error, for any invite that doesn't exist, isn't pending, or isn't addressed to the caller, so it never leaks existence either. `getInviteOrgDetails` (org-invites.ts) wraps the RPC as a total function (`InviteOrgDetails | null`, matching `getOrg`'s null-on-absence shape); `InviteDetailsDialog` is a bespoke component (not an extension of `ConfirmDialog`, which is single-confirm-only) reusing its exact a11y patterns, fetching lazily on open, and wiring Accept/Decline to the SAME `handleAccept`/`handleDecline` callbacks `PendingInvitesBanner`'s own quick actions use — no second, divergent accept path, so accept-from-modal preserves the existing route-to-Explorer + success-toast behavior. Accept/decline authorization and the tenant read path (`applyTenantScope`/`lorekit_member_org_ids`/the org read policy) are untouched.
- **A Learn (Getting started) page is defined in THREE places that must stay in sync — always add/remove all three in one change.** Every page under `packages/web/src/app/(dashboard)/learn/<id>/page.tsx` must have (1) a matching item in `LEARN_SECTIONS` (`packages/web/src/components/learn/sections.ts`, drives the left `LearnNav` rail) and (2) a matching `useCommand` entry in the `Learn` group of `NavigationCommands.tsx` (`packages/web/src/components/command/`, drives the ⌘K command palette). The `id`/`href`/`icon` should agree across all three (same lucide icon, `href: '/learn/<id>'`). When you scaffold a new Learn page, do NOT stop at the route file — register the nav item and the command-menu entry too, or the page is unreachable from the rail and unsearchable from the palette. This is the same "one destination, registered everywhere" invariant that keeps the Settings pages and their `Settings`-group commands aligned. Reference: the `Configuration` page (`/learn/config`, the `.lorekit.json` / `~/.lorekit/config.json` schema reference) was added across exactly these three files.
