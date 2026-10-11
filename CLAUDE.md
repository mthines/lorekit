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
| `@lorekit/feature-flags` | `packages/feature-flags/` | OpenFeature-standard flag evaluation. `registry.ts` is the single hand-authored source of truth (zod-validated, all four OpenFeature value types); `nx run feature-flags:generate` projects it into typed TS bindings + a language-neutral `flags.manifest.json`. `LoreKitFlagProvider` resolves: session override → A/B(/n) experiment (deterministic FNV-1a bucketing on a stable `targetingKey`) → static default. Telemetry is two mechanisms: `featureFlagOtelHook` stamps `feature_flag.*` span attributes per evaluation (server-side), while `packages/web`'s `FeatureFlagsProvider` tags RUM signals with `feature_flag.<key>` (browser-side). UI-affecting experiments use a copy-and-suffix component convention (a resolver + one whole component per variant, never inline branches). `/settings/developer` (override UI) is open to any signed-in user outside production; in production it's gated by a server-side email allowlist (`developer-users.ts`, `notFound()` on the page). Package rules + file map: [`packages/feature-flags/CLAUDE.md`](./packages/feature-flags/CLAUDE.md). Full guide: [`docs/feature-flags.md`](./docs/feature-flags.md). Add/update/remove a flag via the `feature-flags` skill |
| `@lorekit/web` | `packages/web/` | Next.js 15 dashboard (Vercel) |
| `@lorekit/cli` | `packages/cli/` | Zero-dep Node CLI. **Setup:** `install`/`uninstall`/`doctor`/`update` (scaffold skills + MCP + lifecycle hooks into `.claude`; connectivity/token/scope health checks; offline skill refresh). **Reads:** `list`/`search`/`show`/`stats`/`scopes`/`diff`/`tree`/`lint`/`dedupe`/`link` (Offline + Remote split, `--json`/`--scope`). **Recurrence tooling:** `obligations` (a changed-file set vs a declarative Surface-Partner Map; per-entry `state` `advisory`/`gating`/`retired`) + `invariants candidates` (candidate scan reusing `dedupe`'s clustering; never auto-compiles or gates). **Maintenance:** `purge`/`purge-expired` (remote-only, account-wide, irreversible, confirm-or-`--yes`). Plus `hook` (shared hook engine behind the plugins), `mcp` (local stdio MCP server), `migrate`, `completion`. Self-contained OTLP telemetry (`service.name=cli`). Full command reference: [`docs/cli.md`](./docs/cli.md) |

| `plugins/` | `plugins/` | Per-framework deterministic bundles: `lorekit-claude` (marketplace plugin: skill + hooks + MCP), `lorekit-cursor` (rule + `stop` hook), `lorekit-codex` (feature-flagged hooks + `AGENTS.md` fallback, experimental). Root `.claude-plugin/marketplace.json` lists the Claude plugin. |
| `supabase` | `supabase/` | Edge Functions (production MCP server), migrations, NX targets |
| `@lorekit/smoke-tests` | `packages/smoke-tests/` | Live-endpoint integration/smoke tests against the deployed Edge Functions (memories, orgs, MCP, BYOD) — no application code, self-skips when its env vars are absent |

The **production MCP server** is `supabase/functions/mcp/index.ts` (Deno, self-contained). There
is no other MCP server implementation — a prior Node.js/Fly.io variant (`packages/mcp-server/`)
was never deployed and has been removed.

**Shared hook engine:** `lorekit hook --adapter <claude|cursor|codex> --event <name>` reads the host's
JSON on stdin and injects lessons / a retrospective nudge on stdout, always exiting 0. Logic lives once
in `packages/cli/src/{core,adapters}/`; each adapter reshapes I/O to its host. On a tool failure it
additionally does a best-effort lesson lookup (`failureQuery` distils terms from the tool name + error
text → `relevantLessonsFromStore` QUERIES the store — a SINGLE `store.search` carrying ALL the terms in
one call (OR semantics) across the scope hierarchy, so the offline store is walked once, not once per
term → the pure `dedupeRelevant` de-dupes the hits by `scope::key` and caps at 3, keeping the store's own
ordering) and injects any relevant prior lessons BEFORE the write-nudge — an unusable store, a throwing
search, or no match silently falls back to the nudge alone, and any error is swallowed (exit 0). This
deliberately QUERIES rather than post-filtering the SessionStart-injected set: post-filtering could only
ever resurface an already-shown lesson, so a paraphrased match or one past the per-scope read cap was
unreachable. Matching is the store's job — server-side FTS (with stemming) for
remote, full-scope substring for local — but ORDERING is not relevance: the remote handler orders by
`updated_at desc` (`supabase/functions/memories/handlers/search.ts`), and the local two-tier store puts
project-tier hits ahead of home-tier ones, so scope precedence holds only within a tier;
`store.search`'s `q` accepts a term LIST for exactly this
one-pass multi-term query (the remote joins it into one `websearch` `OR` query, a single round-trip). The cross-scope precedence merge (the SessionStart read) still
uses the SAME `resolvePrecedence` the read commands use, in the dependency-free
`packages/cli/src/shared/lessons-pure.mjs` (re-exported by `lessons-view.mjs`), so the hot path shares it without
dragging in the `util`/render stack. The end-of-turn retrospective nudge
is **friction-gated** by default (`hooks.stop`, resolved in `control.mjs`: `friction` | `always` | `off`,
default `friction`): in `friction` mode the Stop handler reads the session transcript via the pure
`packages/cli/src/core/friction.mjs` (`detectFriction` = errored tool results OR a tool+input repeated
≥ `STUCK_LOOP_THRESHOLD`; `readSessionFriction` is the IO wrapper; `shouldRetrospect` is the gating
matrix) and stays SILENT on a clean session — so a trivial turn no longer nudges. The friction read
happens BEFORE the once-per-session throttle is consumed, so a clean early turn doesn't burn the marker
and a later friction turn can still fire once. `friction: null` (no transcript, e.g. Cursor/Codex) falls
back to firing so no lesson is lost where friction can't be measured. The nudge itself is a terse
one-liner naming the detected reasons — the lore deep-link lives on the write CONFIRMATION, not here. The
Claude plugin's skill copy is vendored from `packages/cli/skill/` — keep in sync via
`node scripts/codegen/sync-plugin-skill.mjs` (a `--check` mode guards drift).

**Cross-framework validation:** `packages/cli/test/frameworks.test.mjs` replays payload fixtures
(`test/fixtures/<adapter>-<event>.json`) through the binary and asserts each host's output contract, runs
`claude plugin validate` (skips if the CLI is absent), and structurally checks the Cursor/Codex configs.
Harvest real fixtures with `LOREKIT_HOOK_RECORD=<dir>` set on the hook command (one run per framework).

---

## NX commands

### Never run whole-repo Nx fan-outs in a cloud sandbox

**Agents must NOT run `pnpm nx run-many -t … --all` (or `npx nx run-many --all`,
or any other whole-repo fan-out) in a cloud or container environment.** It
saturates the box — every project's target starts at once, the Nx daemon and the
spawned workers contend for the small CPU/memory allowance — and the session
freezes or stalls indefinitely rather than failing cleanly. Recovering costs a
whole session.

Run the narrow equivalent instead:

```bash
# What CI actually runs on a PR — only the projects your change affects
pnpm nx affected -t typecheck,test,lint

# Or name the projects explicitly, one target at a time
pnpm nx typecheck mcp-core
pnpm nx test cli
```

If you genuinely need whole-repo coverage, cap the fan-out and scope the targets
(`pnpm nx run-many -t typecheck --all --parallel=1`) and run one target per
invocation — never `typecheck,test,lint` together across every project. The
unqualified `--all` form below is documented as the CI gate; **CI is where it
belongs**, not a sandbox.

### Sandbox baseline — read before trusting a red gate

Six traps in a fresh sandbox, each costing a session when rediscovered. Full runbook
+ error signatures: [`docs/sandbox.md`](./docs/sandbox.md).

1. **Run `pnpm install --frozen-lockfile` before the first `pnpm nx`** — a fresh container's install is absent; the tell is `Command "nx" not found` or a `Cannot find module 'zod'` cascade.
2. **`cli:test` is red on a clean tree** (loopback-HTTP mock never arrives) and the failing set GROWS — never pattern-match a remembered count. Web lint has pre-existing `no-non-null-assertion` **warnings, 0 errors**.
3. **Prove a failure pre-existing with `git stash -u`, not from memory** — stash, re-run, compare; "N before == N after".
4. **`supabase start` is impossible (no Docker socket)** but `migrations.test.sql` runs against a throwaway PG16 cluster + `bare-postgres-bootstrap.sql`. A pass is NOT a substitute for CI's `Integration smoke`.
5. **`deno check` runs locally — install via `npm i -g deno`** (the official installer's host is egress-blocked); run `node scripts/ci/deno-check-functions.mjs` with `--node-modules-dir=none`.
6. **Node's `fetch` ignores `HTTPS_PROXY` — run with `NODE_USE_ENV_PROXY=1`**, else a `403 Host not in allowlist` even for allowlisted hosts. Never "fix" by unsetting `HTTPS_PROXY` or disabling TLS.

```bash
# CI gate — CI ONLY. Do not run this in a cloud/sandbox session; it stalls the
# box (see "Never run whole-repo Nx fan-outs in a cloud sandbox" above).
pnpm nx run-many -t typecheck,test,lint --all

# The sandbox-safe equivalent
pnpm nx affected -t typecheck,test,lint

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

### Web Storybook tests (interaction + visual regression)

`@lorekit/web` runs Storybook 10 (`@storybook/nextjs-vite`) on Vitest **browser mode**:
`*.test.stories.tsx` are interaction tests (`/Tests` namespace); every other `*.stories.tsx`
is screenshotted for visual regression (baselines in `src/**/__screenshots__/**/*-chromium-linux.png`).
Driven by `packages/web/vitest.storybook.config.ts`, kept separate from `vitest.config.ts` so
`nx test` never boots a browser.

```bash
cd packages/web
npx vitest run --config vitest.storybook.config.ts                 # both suites
npx vitest run --config vitest.storybook.config.ts --changed=main  # only changed stories
npx vitest run --config vitest.storybook.config.ts -u              # update baselines
```

- Invoke with **`npx`**, not `pnpm exec` / `nx run` — those keep the Playwright child's stdio open, so the run never returns.
- **Playwright is pinned to `1.56.0`** via a root pnpm override so local + CI pixel baselines match; bumping it requires regenerating baselines (`-u`) on Linux/Chromium.
- CI runs these in the `web-test` job (browser job, gated by `changes.web`) — NOT part of `check`'s `nx affected -t test`.
- Full-page stories mock Supabase REST with **MSW** so real React Query hooks resolve against a stable dataset; server-component pages story their largest client subtree, never refactored to client. Storybook deploys as its OWN Vercel project. Full runbook + MSW / mixed-rendering / deploy detail: [docs/storybook.md](./docs/storybook.md).

---

## User-facing docs (mandatory on every change)

**Any change that alters what a user can do, see, or configure MUST update the user-facing
docs AND `packages/web/public/llms.txt` in the SAME PR.** Docs are not a follow-up — a shipped
capability nobody can find is unshipped, and a documented capability that no longer behaves that
way is worse than no documentation.

This applies to a new or changed MCP tool / REST route / CLI command or flag, a new config key or
env var, a changed limit, token prefix, scope rule, or error contract, and any new dashboard
surface. It does NOT apply to a pure refactor, a test-only change, or an internal rename with no
observable effect.

| Surface | Path | Update when |
|---------|------|-------------|
| **`llms.txt`** | **GENERATED** — never edit `packages/web/public/llms.txt`. Edit `packages/schemas/src/llms/template.md` (editorial prose) or `packages/schemas/src/shared/tool-catalog.ts` (tool reference), then `pnpm nx generate:llms schemas`. | **Always.** The MCP tool reference, permission matrix and docs index derive from the catalog and the MDX frontmatter; the quickstart and scope explanation are editorial. `render.spec.ts` fails when the committed file is not what the generator produces. |
| Public docs | `packages/web/src/content/docs/*.mdx` | The change affects setup, config, offline/remote mode, orgs, labels, or a use case. Adding a page = drop the `.mdx` **and** add its `lib/docs/sections.ts` entry (`sections.spec.ts` fails on drift). |
| Dashboard copy | `packages/web/src/**` | The change alters an in-product flow the copy describes. |
| Contributor docs | `docs/*.md` + the index table in `docs/README.md` | The change affects architecture, deployment, limits, tokens, OTel, or a runbook. |
| `README.md` | repo root | The change alters the pitch, the install path, or the package map. |

Writing rules for all of the above: always the concrete MCP endpoint, never a `<ref>` placeholder
(see Endpoints and Key decisions); tag every fenced code block with its language; keep `llms.txt`
consistent with the MDX docs — when the two disagree, agents read `llms.txt` and get it wrong.

Definition of done: the diff either touches the surfaces above, or the PR description says in one
line why none applied.

---

## PR workflow (mandatory — always follow this order)

Every PR in this repository goes through a fixed five-step sequence.
Do NOT skip steps or change the order, whether the PR is a draft or ready for review.

Before Step 1, settle the docs: apply
[User-facing docs](#user-facing-docs-mandatory-on-every-change) and commit those edits with the
change they document, so `/polish` and `review-loop`'s `pr-reviewer` pass see the finished diff.

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

### The five steps

Each step's full procedure lives in its own skill (`polish`, `create-pr`, `review-loop`,
`implement-suggestion`, `ci-auto-fix`) — the summary table below is the contract. Non-obvious constraints:

1. **`/polish`** — local-only (never writes to GitHub); auto-fix all findings, commit each pass. Skip only if the diff is non-code.
2. **`/create-pr`** — opens a **draft**. Do NOT pass `--no-review` (this repo has no external bot; the review pass is `/create-pr`'s own `review-loop`), `--no-feedback` (skips Step 4), or `--no-quality` (skips Steps 3–4).
3. **`review-loop`** — the ONE reviewer; `/create-pr` auto-runs `Skill("review-loop", "<pr-url> --no-ci")`, converging `pr-reviewer` → `implement-suggestion --resolve-all` → `polish simplify` (≤5 iters) until every thread is resolved by a fix or an honest reply, then refreshes the PR description. Re-run it yourself after any hand-pushed commit.
4. **`/implement-suggestion --watch`** — background; absorbs genuine external (CodeRabbit/human) feedback posted after `review-loop`'s last push, one commit per comment (`/critical`+`/confidence` gated), ≤5 iters. Never undrafts.
5. **`/ci-auto-fix`** — drive CI green (confidence-gated, never weakens a check); re-run Step 3 after its push.

**Definition of ready-to-review:** `review-loop` PASS with zero open threads (only genuine human-judgment flags may remain — surface them) AND green CI. The agent does **not** flip the draft flag — undrafting stays a human decision.

### Summary table

| Step | Action | Who triggers |
|------|--------|--------------|
| 0 | Clone agent-skills + run sync-symlinks.sh (once per sandbox) | Agent |
| 0.5 | Update user-facing docs + regenerate `llms.txt` (or state why none applied) | Agent |
| 1 | Run `/polish` — review + simplify, auto-fix all findings, commit each pass | Agent |
| 2 | `/create-pr` — open draft PR; no `--no-review` (there is no external bot to defer to) | Agent |
| 3 | `review-loop` converges automatically (`pr-reviewer` → `implement-suggestion --resolve-all` → `polish simplify`, ≤5 iters) — the ONE review agent, refreshes the PR description on convergence | Agent (auto-dispatched by `/create-pr`) |
| 4 | `/implement-suggestion --watch` (background) — absorb genuine CodeRabbit/human feedback posted after `review-loop`'s last push, one commit per comment, ≤**5** iters, never undrafts | Agent (background) |
| 5 | `/ci-auto-fix` until green. Ready-to-review = `review-loop` PASS with zero open threads AND green CI (agent does not undraft) | Agent |

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
`packages/mcp-core/src/auth/permissions.ts`, mirrored self-contained into
`supabase/functions/mcp/permissions.ts` (the `limits.ts` pattern).

**Entitlement must gate the response BODY, not only the write.** On any
`supabase/functions/mcp/**` (or REST) handler authenticated by a user JWT but keyed on a
**caller-supplied resource id**, the same `entitled` / `verdict.kind === 'linked'` computation
that gates the RPC/upsert MUST also gate every field of the success response. The recurring
bug: the check guards the DB write while the 200 body still returns third-party/unentitled
metadata sourced from the fetched object — an information leak even though nothing was written.
The tell when reviewing: an `entitled` value that gates the mutation but is never referenced
when constructing the response literal; grep the response literal for fields sourced from the
fetched third-party object. (Related, still-open residue not covered by this rule: a
pending-vs-linked `status` field / not-found-vs-ok split can remain an existence oracle —
`status` can't simply be dropped because `packages/web/src/lib/github-installations.ts`
branches on it.)

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

The full annotated index (172 files, grouped by subsystem) lives in
[`docs/key-files.md`](./docs/key-files.md) — read it when you need to locate a
specific handler, migration, or pure module. The load-bearing "start here" files:

| File | Purpose |
|------|---------|
| `packages/schemas/src/shared/tool-catalog.ts` | The single origin of the operation SURFACE — every tool's schema, `permission`, `auth`, and its `surfaces` binding (which of MCP/CLI/REST, under what name, backed by which handler, with a declared reason for each absence). Zero-import by construction; `gen-surfaces.mjs` projects the two consumers that cannot import it |
| `packages/cli/src/commands.mjs` | The ONE CLI command registry — `bin/lorekit.mjs` derives dispatch, aliases, flag strictness, help and `traceCommand` wrapping from it |
| `packages/mcp-core/src/scope/scope.ts` | Canonical scope validation + wildcard expansion |
| `packages/mcp-core/src/scope/scope-precedence.ts` | Which row wins when a read named NO scope — `readOrder` as a total order (mirrored to edge; cross-language twin `packages/cli/src/shared/scope-precedence.mjs`) |
| `packages/mcp-core/src/auth/permissions.ts` | `READ_TOOLS`/`WRITE_TOOLS`, `toolRequires`, `tokenPrefixFor` — the `lk_rw_`/`lk_ro_`/`lk_wo_` prefix derivation + tool gating (mirrored to edge + web) |
| `packages/mcp-core/src/limits/limits.ts` | `LimitError`, `translateCapError`, `checkRateLimit` — the origin of the "pure module mirrored self-contained into the edge function" pattern |
| `packages/mcp-core/src/auth/tenant-scope.ts` | `applyTenantScope` — the single widened tenant-visibility predicate (RLS side is `lorekit_member_org_ids()`) |
| `supabase/functions/mcp/index.ts` | Self-contained Deno MCP server (production) |
| `supabase/functions/_shared/telemetry/otel.ts` | Reusable OTel for Edge Functions: `traceRequest()`, `createTracedClient()`, and the ONE source of the OTLP resource attributes / endpoint / attribute encoding that both the span and metric exporters share |
| `packages/mcp-core/src/telemetry/io-ledger.ts` | `mergeBusyMs`/`attributeIoTime` — the self-time split behind `lorekit.self_time_ms` (mirrored to `_shared/`). Merged intervals, never summed |
| `supabase/functions/_shared/audit/audit.ts` (← `packages/mcp-core/src/audit/audit.ts`) | THE single edge audit writer (MCP tools **and** REST handlers) |
| `supabase/functions/_shared/telemetry/usage.ts` | `recordUsageEvent` + `getUserPlanName` — the single edge usage-event writer |
| `supabase/migrations/00001_memories.sql` | `memories` table, FTS, RLS |
| `supabase/migrations/00004_limits.sql` | Memory-cap trigger (`enforce_memory_cap`) + rate-limit RPC (`lorekit_check_rate_limit`) + `user_limits`/`lorekit_get_limit` config source |
| `packages/web/src/lib/api/` | The dashboard's client for LoreKit's OWN REST API (`restFetch`, typed wrappers from `@lorekit/schemas`) |
| `packages/web/src/lib/filters.ts` | Pure model for the Lore Explorer filter bar (OR within a dimension, AND across; `filtersToBody` is the wire seam the Explorer uses, `filtersToQueryParams` the GET encoding kept for query-string callers) |
| `packages/web/src/lib/dash0-rum.ts` | The SINGLE browser RUM init path for `@dash0/sdk-web` (init guard, endpoint validator, identity) |

See [`docs/key-files.md`](./docs/key-files.md) for the remaining ~137 files:
all migrations, the `_shared`/`mcp-core` pure modules and their edge mirrors,
the auth/org/invite/scope-binding surfaces, and the Explorer/Settings UI.

---

## OTel attributes (custom)

All `lorekit.*` spans carry:
- `lorekit.tool.name` — bounded: `memory.write|read|list|delete|search`
- `lorekit.scope` — canonical scope string
- `lorekit.scope.type` — bounded: `global|project|repo|branch|mixed|invalid`, and OMITTED when the operation carries no scope. Resolved by the shared `scope-type-attribute.ts` (mirrored into `_shared/`), never by an inline `split('::')` in a transport
- `lorekit.key` — lesson key
- `service.namespace` — always `lorekit`
- `deployment.environment.name` — `production|preview|development|local` (on `web`, from `VERCEL_ENV` **cross-checked against `NODE_ENV`**, never `VERCEL_ENV` alone — see Key decisions), plus the synthetic `test` stamped on smoke/CI runs (the pipelines set `DEPLOYMENT_ENVIRONMENT=test`; the edge also honours it per-request via the `X-LoreKit-Deployment-Environment` header, allowlisted to `test`) — see [docs/otel.md](./docs/otel.md) → "Smoke / test runs are tagged"

Metric: `lorekit.tool.duration` histogram (unit `s`) with `lorekit.tool.name` + `lorekit.scope.type`.

Every edge ROOT request span additionally carries the self-time split, stamped by
`traceRequest` and fed by span KIND (any `SPAN_KIND_CLIENT` span counts as an outbound call):
- `lorekit.io.wait_ms` — wall-clock ms with ≥1 outbound call in flight. Concurrent calls count ONCE
- `lorekit.io.calls` — how many outbound calls (summed, not merged — an N+1 vs one slow query)
- `lorekit.self_time_ms` — the residue no child span explains: our own code

Numeric measures, not dimensions, so they add no cardinality. The merge lives in the pure
`io-ledger.ts` (mirrored to `_shared/`) — never simplify it back to a SUM, which double-counts
concurrent queries and drives self time negative.

**Profiles are NOT a signal LoreKit can emit** — Dash0 collects them with a host-level eBPF agent and
every runtime here is managed serverless. Query-level profiling (`pg_stat_statements` → the three
`lorekit.db.query.*` cumulative sums, via the service-role-only `profiling` function, OFF until two
Vault secrets exist) is the substitute. Read
[docs/otel.md](./docs/otel.md) → "Query-level profiling" and
[docs/decisions.md](./docs/decisions.md#profiling-is-sql-level-because-there-is-no-host-to-profile)
before proposing a profiler.

Trace-context propagation (W3C `traceparent` — who sends/receives, the origin allow-list, the parser, span kinds, and the recorded-not-acted-on sampled flag) and the `service.name` inventory (edge = one `api` service told apart by `faas.name`; `mcp`/`web`/`cli`; never a per-function `SERVICE_NAME` secret) live in [`docs/otel.md`](./docs/otel.md) → "Custom span attributes — propagation & service.name".

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

Each decision's full rationale lives in [`docs/decisions.md`](./docs/decisions.md) —
the headline here is the rule; follow the link for the "why". Short entries carry
their rationale inline. **Do not relitigate these.**
- **Dashboard is a CLIENT of LoreKit's REST API** — [rationale](./docs/decisions.md#dashboard-is-a-client-of-lorekits-rest-api)
- **MCP server endpoint is a static production URL** — [rationale](./docs/decisions.md#mcp-server-endpoint-is-a-static-production-url)
- **Lore Explorer filters through ONE two-level command menu + pills** — [rationale](./docs/decisions.md#lore-explorer-filters-through-one-two-level-command-menu)
- **The Explorer's Activity panel has a DISPLAY default (24h), separate from the list's (all time)** — [rationale](./docs/decisions.md#the-explorers-activity-panel-has-a-display-default-separate-from-the-lists)
- **The Explorer's Activity panel shows ONE body at a time and remembers your disclosure** — [rationale](./docs/decisions.md#the-activity-panel-shows-one-body-at-a-time-and-remembers-your-disclosure)
- **Chart bucket readouts are PORTALED, one per chart** — [rationale](./docs/decisions.md#chart-bucket-readouts-are-portaled-and-there-is-one-per-chart)
- **Dashboard figures COUNT to a new value** — [rationale](./docs/decisions.md#dashboard-figures-count-to-a-new-value)
- **Mobile transient selection surfaces use the `BottomSheet` primitive** — [rationale](./docs/decisions.md#mobile-transient-selection-surfaces-use-the-bottomsheet-primitive)
- `::` separator avoids collision with `/` in repo paths and `:` in branch names
- `lk_rw_` prefix encodes permission visibly in config files
- **Write-only tokens (`lk_wo_*`)** — [rationale](./docs/decisions.md#write-only-tokens-lk_wo_)
- Token SHA-256 hash in DB — shown once, never stored in plain text
- **API token scoping (scopes + orgs)** — [rationale](./docs/decisions.md#api-token-scoping-scopes--orgs)
- `AlwaysOn` OTel sampler — sampling deferred to Dash0 pipeline, never SDK-side
- `instrumentation.ts` must be `async function register()` with `NEXT_RUNTIME === 'nodejs'` guard
- **Browser RUM initialises in `lib/dash0-rum.ts`, identity set at INIT** — [rationale](./docs/decisions.md#browser-rum-init--identity-at-init)
- **`OTEL_SERVICE_NAME` must never decide a component's name** — [rationale](./docs/decisions.md#otel_service_name-must-never-decide-a-components-name)
- **`VERCEL_ENV` must never decide `deployment.environment.name` alone** — [rationale](./docs/decisions.md#vercel_env-must-never-decide-the-deployment-environment-alone)
- **Caller identity belongs on the ROOT request span** — [rationale](./docs/decisions.md#caller-identity-belongs-on-the-root-request-span)
- **CLI telemetry is attributable via a minted install id + a LEARNED account id** — [rationale](./docs/decisions.md#cli-telemetry-is-attributable-by-a-locally-minted-install-id-plus-a-learned-account-id)
- **`hook` and `mcp` are untraced but METERED** — [rationale](./docs/decisions.md#hook-and-mcp-are-untraced-but-metered)
- **The edge's `deployment.environment.name` is set by `deploy.yml`, not inferred** — [rationale](./docs/decisions.md#the-edges-deploymentenvironmentname-is-set-by-the-deploy-pipeline-not-inferred)
- **Edge Function is self-contained Deno** — [rationale](./docs/decisions.md#edge-function-is-self-contained-deno-no-import-map)
- NX 22.4.0 — matches `gw-tools` exactly; bump both together
- **Memory cap enforced by a DB trigger** — [rationale](./docs/decisions.md#memory-cap-enforced-by-a-db-trigger)
- Rate limiting is a Postgres-backed fixed-window counter (not in-memory/Redis) — edge isolates are stateless; no new infra
- Limits config lives in one DB function (`lorekit_default_limit`) + `user_limits` override table — no numeric limit hardcoded; raising a ceiling is one row upsert
- **Webhook secrets are repo-scoped** — [rationale](./docs/decisions.md#webhook-secrets-are-repo-scoped)
- **Audit logging is captured at the app layer** — [rationale](./docs/decisions.md#audit-logging-is-captured-at-the-app-layer)
- **Usage events recorded once per surface, in the dispatcher** — [rationale](./docs/decisions.md#usage-events-recorded-once-per-surface-in-the-dispatcher)
- **Org/scope sharing is ORG-FIRST (Phase 1)** — [rationale](./docs/decisions.md#orgscope-sharing-is-org-first-phase-1)
- **Org-sharing Phase 2 (org-owned writes)** — [rationale](./docs/decisions.md#orgscope-sharing-phase-2-org-owned-writes)
- **Audit Logs pagination is keyset (cursor), not OFFSET** — [rationale](./docs/decisions.md#audit-logs-pagination-is-keyset-cursor-not-offset)
- **Org-sharing Phase 3 (org management backend)** — [rationale](./docs/decisions.md#orgscope-sharing-phase-3-org-management-backend)
- **Org-sharing Phase 4 (dashboard UX)** — [rationale](./docs/decisions.md#orgscope-sharing-phase-4-dashboard-ux)
- **Safe org deletion** — [rationale](./docs/decisions.md#safe-org-deletion)
- **Scope→org binding** — [rationale](./docs/decisions.md#scopeorg-binding)
- **GitHub App single-secret model** — [rationale](./docs/decisions.md#github-app-single-secret-model)
- **Comment-relevance classification is server-side, config-driven, and refuses to guess** — [rationale](./docs/decisions.md#comment-relevance-classification-is-server-side-config-driven-and-refuses-to-guess)
- **Hook scope ordering unified, project scope IS injected** — [rationale](./docs/decisions.md#hook-scope-ordering-unified-project-scope-injected)
- **Hook precedence + match is single source of truth with read commands** — [rationale](./docs/decisions.md#hook-precedence--match-is-single-source-of-truth-with-read-commands)
- **CI/CD is split** — [rationale](./docs/decisions.md#cicd-is-split-ciyml-verifies-deployyml-promotes)
- **The deploy SCOPE is measured against what is deployed** — [rationale](./docs/decisions.md#cicd-is-split-ciyml-verifies-deployyml-promotes)
- **Smoke tests clean up after themselves + a sweeper** — [rationale](./docs/decisions.md#smoke-tests-clean-up-after-themselves)
- **Invite-details modal** — [rationale](./docs/decisions.md#invite-details-modal)
- **Docs are a PUBLIC MDX section at `/docs`** — [rationale](./docs/decisions.md#docs-are-a-public-mdx-section-at-docs)
- **Settings sections named for the user's goal** — [rationale](./docs/decisions.md#settings-sections-named-for-the-users-goal)
- **Org REST routes open to `lk_*` tokens, gated by token permission not auth tier** — [rationale](./docs/decisions.md#org-rest-routes-open-to-lk_-tokens-gated-by-token-permission)
- **Org-owned lore archive/hard-delete over REST** — [rationale](./docs/decisions.md#org-owned-lore-archivehard-delete-over-rest)
- **Usage analytics answer record-level questions** — [rationale](./docs/decisions.md#usage-analytics-answer-record-level-questions)
- **Profiling is SQL-level, because there is no host to profile** — [rationale](./docs/decisions.md#profiling-is-sql-level-because-there-is-no-host-to-profile)
- **The tool catalog is the single origin of the operation SURFACE** — `packages/schemas/src/shared/tool-catalog.ts` declares which of MCP/CLI/REST exposes each op, under what name, and the reason for each absence. Adding an operation? Follow [`docs/adding-an-operation.md`](./docs/adding-an-operation.md) (or `/add-operation`) — it is the step-by-step checklist behind this decision. Consumers *derive* (can import it), *generate* (cannot — `gen-surfaces.mjs`, committed artifacts, `--check`), or *assert* (deriving would be wrong). Never hand-edit a `*.generated.*` file; CLI **behaviour** stays hand-written in `packages/cli/src/commands.mjs`. [tiers + gates](./docs/architecture.md#surface-generation)
- **`READ_TOOLS`/`WRITE_TOOLS` stay HAND-WRITTEN, not derived from the catalog** — the duplication *is* the authorization control: deriving the gate from the thing it gates means one careless catalog edit silently opens a tool. Held to the catalog by assertion instead (`tool-catalog-parity.spec.ts`), the same way the audit vocabulary is. Do not "simplify" this.
- **A tool-originated MCP failure is an `isError` result, not a protocol error** — [rationale](./docs/decisions.md#a-tool-originated-mcp-failure-is-an-iserror-result-not-a-protocol-error)
- **MCP `org.*` tools serve `lk_*` tokens, gated by permission not auth tier** — [rationale](./docs/decisions.md#mcp-org-tools-serve-lk_-tokens-on-the-same-actor-override-rest-uses)
- **Dashboard analytics reads stay REST-only** — [rationale](./docs/decisions.md#dashboard-analytics-reads-stay-rest-only)
- **The Explorer's Duplicate Clusters panel is a PANEL, not an instrument** — [rationale](./docs/decisions.md#dashboard-analytics-reads-stay-rest-only)
- **Dashboard analytics live on one dedicated `/insights` route** — [rationale](./docs/decisions.md#dashboard-analytics-live-on-one-dedicated-insights-route)
- **A COUNT must describe the rows its LIST returns — retention thresholds reach all four readers** — [rationale](./docs/decisions.md#a-count-must-describe-the-rows-its-list-returns)
- **A read must never restamp `updated_at`** — [rationale](./docs/decisions.md#a-read-must-never-restamp-updated_at)
- **Lore value is the RATIO `opened_count / read_count`, and `/insights` leads with the bill** — [rationale](./docs/decisions.md#lore-value-is-a-ratio-and-insights-leads-with-the-bill)
- **A citation is the agent's word, and it is a fact about a RUN** — [rationale](./docs/decisions.md#a-citation-is-the-agents-word-and-it-is-a-fact-about-a-run)
- **`memory.read` batching (`refs: string[]`) is conditional, verbatim-scoped, and inflates a signal it doesn't count** — [rationale](./docs/decisions.md#memoryread-batching-is-conditional-verbatim-scoped-and-inflates-a-signal-it-doesnt-count)
- **An omitted scope on a read means EVERYWHERE, not `global`** — [rationale](./docs/decisions.md#an-omitted-scope-means-everywhere-not-global)
- **A tool's `inputSchema` carries NO top-level `oneOf`/`anyOf`/`allOf`** — [rationale](./docs/decisions.md#a-tools-inputschema-carries-no-top-level-oneofanyofallof)
- **A skill's `metadata.version` must be bumped on any content change, and CI enforces it** — [rationale](./docs/decisions.md#a-skills-metadataversion-must-be-bumped-on-any-content-change-and-ci-enforces-it)
- **Judgment is BYOK, best-effort, never on the correctness path** — [rationale](./docs/decisions.md#judgment-is-byok-best-effort-never-on-the-correctness-path)
