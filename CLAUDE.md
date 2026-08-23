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
| `@lorekit/web` | `packages/web/` | Next.js 15 dashboard (Vercel) |
| `@lorekit/cli` | `packages/cli/` | Zero-dep Node CLI. `install`/`uninstall`/`doctor` (scaffold the `lorekit-memory`/`lorekit-setup`/`lorekit-groom` skills + MCP server + lifecycle hooks into `.claude`; connectivity/token/scope health checks); read commands `list`/`search`/`show`/`stats`/`scopes`/`diff`/`tree`/`lint`/`dedupe`/`link` (Offline + Remote split, `--json`/`--scope`); maintenance sweeps `purge`/`purge-expired` (remote-only, account-wide, irreversible — confirm-or-`--yes`, refused for a scoped key); `hook` (the shared hook engine behind the plugins); `mcp` (local stdio MCP server); `migrate`. Self-contained OTLP telemetry (`service.name=cli`). Full command reference: [`docs/cli.md`](./docs/cli.md) |

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
`packages/cli/src/lessons-pure.mjs` (re-exported by `lessons-view.mjs`), so the hot path shares it without
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
`node scripts/sync-plugin-skill.mjs` (a `--check` mode guards drift).

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

Five facts about a fresh sandbox/container, each confirmed by direct observation
rather than inferred. They cost time every time they are rediscovered:

1. **Run `pnpm install` before the first `pnpm nx` command.** A fresh container's
   install is incomplete or absent. The signature is a cryptic
   `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "nx" not found` (no
   `node_modules/.bin/nx`) or a `Cannot find module 'zod'` cascade through
   `packages/schemas/**`. Both are the same missing install, not a broken nx
   config — `pnpm install --frozen-lockfile` at the root fixes both in ~15s.
   `pnpm` itself may or may not be on PATH; probe, and `corepack enable` only if
   it is missing.
2. **`cli:test` is red on a clean tree, so `run-many -t … --all` exits non-zero
   even with no changes.** The failures are all loopback-HTTP-shaped: the tests
   stand up a mock server on `127.0.0.1:0` and the spawned CLI child's `fetch`
   never arrives. The failing SET GROWS as new tests land on that surface, so
   **never pattern-match on a remembered count** — see point 3. (Writing a new
   test for this surface? Target the local on-disk store via `LOREKIT_HOME` +
   `LOREKIT_MODE=local` instead of a mock REST server.) Web lint separately
   reports dozens of pre-existing `no-non-null-assertion` **warnings, 0 errors** —
   not yours. The count drifts upward as tests land (it was recorded as ~47 and
   measured 59 later), so establish it with `git stash -u` like any other red;
   what CI gates on is the **0 errors**.
3. **Prove a failure pre-existing with `git stash -u`, not from memory.** Stash,
   re-run the same command, compare. The assertion that holds is "N failures
   before == N failures after"; any specific N goes stale. This takes ~40s and is
   the difference between reporting an inherited red and "fixing" something that
   was never broken.
4. **`supabase start` is impossible (no Docker socket) but the SQL tests still
   run.** `migrations.test.sql` — the only thing that exercises raw migration
   logic — needs a database, not the Supabase stack. PostgreSQL 16 is installed
   locally, so `initdb` a throwaway cluster, apply
   `supabase/tests/bare-postgres-bootstrap.sql` (it supplies the `auth.*` claim
   readers, `auth.users`/`auth.identities` and the three roles), apply
   `supabase/migrations/*.sql` in order, then run the test file. Its runbook is
   in its own header. Needs `apt-get install postgresql-16-pgvector` for
   00060/00062. **A failure is strong evidence; a pass is not a substitute for
   CI's `Integration smoke` job** — the bootstrap is a stand-in, not Supabase.
   The test file is one transaction ending in `rollback`, so it is re-runnable
   against the same database, which makes guard-biting an assertion cheap.
5. **`deno check` DOES run here — install it with `npm i -g deno`.** The
   official installer fetches from `deno.land`, which the egress policy blocks,
   and that made the ratchet look CI-only. npm is reachable, the `deno` package
   ships the same binary, and the version it lands (2.9.5) satisfies the `v2.x`
   CI pins and reproduces the committed baseline exactly. So
   `node scripts/deno-check-functions.mjs` is a local gate, not a remote one —
   which is how the 83 baselined errors were driven to 0 rather than guessed at.
   Two traps if you script around it: `deno check` writes errors to stderr with
   ANSI colour, so a `grep -cE '^TS[0-9]+'` counts **zero** on real failures
   (strip ANSI first, and self-test the counter against a known-bad state); and
   pass `--node-modules-dir=none` so `npm:` specifiers resolve from Deno's cache
   the way production does, instead of the repo's pnpm `node_modules`.
6. **Node's built-in `fetch` ignores `HTTPS_PROXY` — run it with
   `NODE_USE_ENV_PROXY=1`.** This bites anything in this repo that exports
   telemetry over `fetch`: `scripts/sweep-rows.mjs`, the CLI's
   `packages/cli/src/telemetry.mjs`, and the `_shared/otel.ts` exporters when
   exercised locally. The symptom is a **`403 Host not in allowlist: <host>`**
   *even for a host that IS allowlisted*, because without the variable undici
   goes DIRECT and meets the network gateway's own, narrower allowlist instead
   of the session proxy's. The tell is a discrepancy between clients: `curl`
   reaches the host (it uses a `CONNECT` tunnel and so goes through the proxy)
   while `node -e 'fetch(...)'` returns that 403. Confirmed on Node 22.22 —
   `NODE_USE_ENV_PROXY=1 node …` turned the Dash0 sweep export from a 403 into
   a real 2xx, and `curl -sS "$HTTPS_PROXY/__agentproxy/status"` lists the
   recent denials with their reason. `/root/.ccr/README.md` documents this and
   the other per-tool proxy accommodations. Never "fix" it by unsetting
   `HTTPS_PROXY` or disabling TLS verification.

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

The `@lorekit/web` dashboard has Storybook 10 (`@storybook/nextjs-vite`) wired to
Vitest **browser mode** via `@storybook/addon-vitest`. Two story files per
component, two suites, one browser run — driven by `packages/web/vitest.storybook.config.ts`
(kept **separate** from `vitest.config.ts` so the node/jsdom `nx test` target
never boots a browser):

- **Interaction tests** — `*.test.stories.tsx` (the `/Tests` namespace, `tags: ['test']`,
  `chromatic.disableSnapshot`); their `play` functions run as browser tests.
- **Visual regression** — every OTHER story (`*.stories.tsx` `Default`/`Playground`)
  is screenshotted by a Storybook-level `afterEach` in `.storybook/vitest.setup.ts`
  using Vitest 4's `toMatchScreenshot`. Baselines are committed under
  `src/**/__screenshots__/**/*-chromium-linux.png`.

```bash
cd packages/web
npx vitest run --config vitest.storybook.config.ts                 # both suites
npx vitest run --config vitest.storybook.config.ts --changed=main  # only changed stories
npx vitest run --config vitest.storybook.config.ts -u              # update baselines
```

- Invoke with **`npx`**, not `pnpm exec` / `pnpm run` / `nx run` — those wrap the
  process and keep the Playwright browser child's stdio open, so the run never
  returns. An `nx test-storybook` target exists for graph awareness but is not
  used by any CI gate for this reason.
- **Playwright is pinned to `1.56.0`** (Chromium build 1194) via a root pnpm
  override, so local runs and CI render on the same browser build and pixel
  baselines compare like-for-like. Bumping it requires regenerating baselines
  (`-u`) on Linux/Chromium.
- CI runs these in the `web-test` job of `ci.yml`, gated by the `changes.web`
  path filter and diff-optimized with `vitest --changed <base>` (a
  one-component edit re-tests one component). It is a browser job, so it is NOT
  part of the `check` job's `nx affected -t test`.

**MSW-mocked full-page stories.** Page/subtree stories mock the Supabase REST
(PostgREST) responses with [MSW](https://mswjs.io) so the app's real
`@tanstack/react-query` hooks resolve against a stable dataset (no SWR — React
Query is the one data layer). Pieces under `packages/web`: `public/mockServiceWorker.js`
(committed via `msw init`, served in the deployed build via `staticDirs: ['../public']`
so hosted stories mock too), `src/mocks/memories.ts` (`memoryHandlers()` + fixtures +
`FROZEN_NOW`), `src/mocks/decorators.tsx` (`withQueryClient` — retries off/no refetch;
`withFrozenClock` — pins `Date` so time-relative renders are deterministic;
`withMemorySidebar` — the `/lore` tree's context), and `.storybook/preview.tsx`
(`initialize()` + `mswLoader`, injects the public Supabase URL, and collapses `motion`
animations for stable snapshots — inert for the existing component stories). A story opts
in via `parameters.msw.handlers`. **Mixed rendering model:** `'use client'` pages story as
true full pages (`app/(dashboard)/lore/LorePage.stories.tsx` — needs
`parameters.nextjs.appDirectory: true` for `useRouter`/`useSearchParams`); server-component
pages can't render in the browser, so story their largest client subtree instead
(`components/dashboard/DashboardStats.stories.tsx` for the RSC `/overview`), never refactor
an RSC page to client just to story it. The `/lore` lesson list reads the `listMemories`
**server action** (gated on `getUser()` → empty in the mocked context), so its results panel
shows the empty state while the browser-fetched scope tree + heatmap populate.
- **Storybook deploys as its own Vercel project** via native Git integration (no CI job, no
  `VERCEL_TOKEN`). `packages/web/vercel.json` is the **dashboard** project (Next.js → `.next`),
  so the Storybook project uses Root Directory = repo root, Framework Preset = Other, Build
  Command `pnpm --filter @lorekit/web build-storybook`, Output Directory
  `packages/web/storybook-static`. Full runbook in [docs/storybook.md](./docs/storybook.md).

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
change they document, so `/polish` and the review bot see the finished diff.

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

### Step 2 — Open the PR with `/create-pr --no-review` (as a draft)

Open the PR with `/create-pr` (it opens as a **draft** — the draft state is what lets the `dash0-dev`
bot post inline comments while the branch converges).

**Always pass `--no-review`.** This repo has the `dash0-dev` bot, which runs the `pr-reviewer` agent on
the PR automatically (Step 3), so `/create-pr`'s built-in `review-loop` would run a **second**
`pr-reviewer` on the same PR — a duplicate review by the same agent, for no gain. `--no-review` drops
that local reviewer pass while **keeping** `create-pr`'s `polish simplify` and, crucially, its
external-bot feedback loop (which is Step 4). Do **not** pass `--no-feedback` (that skips Step 4) or
`--no-quality`. Undrafting is the last, human step, after the flow reaches ready-to-review.

> **The one review agent on the PR is the `dash0-dev` bot — never run a second `pr-reviewer` locally.**
> `/polish` (Step 1) runs pre-PR, where its reviewer pass (Pass A) is **skipped** — `pr-reviewer` has no
> PR-less mode — so Step 1 only runs the `simplify` pass and never posts to GitHub; `review-loop` runs
> `pr-reviewer` ON the open PR, where it posts a `COMMENT` review, so it is excluded here to avoid
> duplicating the `dash0-dev` review.

### Step 3 — The `dash0-dev` bot reviews (the ONE review agent on the PR)

The `dash0-dev` bot runs `pr-reviewer` server-side and posts a `COMMENT` review automatically — **and
re-reviews on every new commit** (a `synchronize` push), marking addressed findings "Superseded /
Resolving." You do NOT trigger it manually, and you do NOT run a second reviewer against the PR. Two
facts to remember: a verdict is pinned to a `commit_id`, so a gate summary can be **stale on an older
SHA** while already resolved on `HEAD` — check which commit a comment targets before treating it as
open; and a push mid-review can anchor the next comments to your new SHA while still describing
*pre-fix* content, so re-verify against `HEAD` (`git show HEAD:<file>`) rather than trusting a
just-arrived comment.

### Step 4 — Absorb the bot's feedback with `/implement-suggestion --watch`

`/create-pr` dispatches this automatically after opening the PR (its external-bot feedback step) as a
**background** sub-agent — so if you opened the PR with `/create-pr` (Step 2) it is already running. If
you pushed a follow-up commit by hand, or need to drive it yourself, dispatch a background sub-agent
(`run_in_background: true`, subagent_type: general):

> Invoke: Skill('implement-suggestion', '<pr-url> --watch')
> Absorb the `dash0-dev` (and any CodeRabbit / human) review feedback to completion. It never opens a
> new PR and never undrafts this one. Return its per-iteration watch report.

`--watch` waits for each `dash0-dev` review, applies the actionable comments (**one commit per
comment**, each gated by `/critical` then `/confidence`), pushes, and repeats — **bounded to 5
iterations** (`--max-iters` default; hard cap 10), processing only comments newer than the last round
so it never re-applies one. It **never undrafts**. Do **not** post `@dash0 resolve` — agent-posted
comments don't trigger the webhook; the skill resolves threads via the API directly.

### Step 5 — Drive CI green; ready-to-review = bot PASS + green CI

`/create-pr` watches CI and delegates mechanical failures to `/ci-auto-fix` for you. For any red check
on a hand-pushed commit, run it yourself:

```
/ci-auto-fix
```

This uses the `ci-auto-fix` skill (wired in during Prerequisites), diagnoses any failing GitHub
Actions checks, applies a minimal targeted fix, and iterates until all checks are green. The skill
is confidence-gated (>=90 auto-apply, 80-89 ask, <80 escalate) and will never disable or weaken a
check. Skip only when CI is already fully green. A `/ci-auto-fix` push is itself a new commit, so it
re-triggers the `dash0-dev` review that Step 4 then absorbs — the loops converge.

**Definition of ready-to-review:** the `dash0-dev` review is PASS with no open actionable findings
**and** every CI check is green. That is the *content* state this flow drives to; the agent does
**not** flip the draft flag — undrafting stays a human/explicit decision.

### Summary table

| Step | Action | Who triggers |
|------|--------|--------------|
| 0 | Clone agent-skills + run sync-symlinks.sh (once per sandbox) | Agent |
| 0.5 | Update user-facing docs + regenerate `llms.txt` (or state why none applied) | Agent |
| 1 | Run `/polish` — review + simplify, auto-fix all findings, commit each pass | Agent |
| 2 | `/create-pr --no-review` — open draft PR; NO duplicate local reviewer (keeps `polish simplify` + the feedback loop) | Agent |
| 3 | `dash0-dev` bot reviews automatically — the ONE review agent, re-reviews on every commit | Automatic (bot) |
| 4 | `/implement-suggestion --watch` (background) — absorb the `dash0-dev`/CodeRabbit/human feedback, one commit per comment, ≤**5** iters, never undrafts | Agent (background) |
| 5 | `/ci-auto-fix` until green. Ready-to-review = `dash0-dev` PASS AND green CI (agent does not undraft) | Agent |

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

The full annotated index (144 files, grouped by subsystem) lives in
[`docs/key-files.md`](./docs/key-files.md) — read it when you need to locate a
specific handler, migration, or pure module. The load-bearing "start here" files:

| File | Purpose |
|------|---------|
| `packages/schemas/src/shared/tool-catalog.ts` | The single origin of the operation SURFACE — every tool's schema, `permission`, `auth`, and its `surfaces` binding (which of MCP/CLI/REST, under what name, backed by which handler, with a declared reason for each absence). Zero-import by construction; `gen-surfaces.mjs` projects the two consumers that cannot import it |
| `packages/cli/src/commands.mjs` | The ONE CLI command registry — `bin/lorekit.mjs` derives dispatch, aliases, flag strictness, help and `traceCommand` wrapping from it |
| `packages/mcp-core/src/scope/scope.ts` | Canonical scope validation + wildcard expansion |
| `packages/mcp-core/src/auth/permissions.ts` | `READ_TOOLS`/`WRITE_TOOLS`, `toolRequires`, `tokenPrefixFor` — the `lk_rw_`/`lk_ro_`/`lk_wo_` prefix derivation + tool gating (mirrored to edge + web) |
| `packages/mcp-core/src/limits/limits.ts` | `LimitError`, `translateCapError`, `checkRateLimit` — the origin of the "pure module mirrored self-contained into the edge function" pattern |
| `packages/mcp-core/src/auth/tenant-scope.ts` | `applyTenantScope` — the single widened tenant-visibility predicate (RLS side is `lorekit_member_org_ids()`) |
| `supabase/functions/mcp/index.ts` | Self-contained Deno MCP server (production) |
| `supabase/functions/_shared/otel.ts` | Reusable OTel for Edge Functions: `traceRequest()`, `createTracedClient()`, and the ONE source of the OTLP resource attributes / endpoint / attribute encoding that both the span and metric exporters share |
| `packages/mcp-core/src/telemetry/io-ledger.ts` | `mergeBusyMs`/`attributeIoTime` — the self-time split behind `lorekit.self_time_ms` (mirrored to `_shared/`). Merged intervals, never summed |
| `supabase/functions/_shared/audit.ts` (← `packages/mcp-core/src/audit/audit.ts`) | THE single edge audit writer (MCP tools **and** REST handlers) |
| `supabase/functions/_shared/usage.ts` | `recordUsageEvent` + `getUserPlanName` — the single edge usage-event writer |
| `supabase/migrations/00001_memories.sql` | `memories` table, FTS, RLS |
| `supabase/migrations/00004_limits.sql` | Memory-cap trigger (`enforce_memory_cap`) + rate-limit RPC (`lorekit_check_rate_limit`) + `user_limits`/`lorekit_get_limit` config source |
| `packages/web/src/lib/api/` | The dashboard's client for LoreKit's OWN REST API (`restFetch`, typed wrappers from `@lorekit/schemas`) |
| `packages/web/src/lib/filters.ts` | Pure model for the Lore Explorer filter bar (OR within a dimension, AND across; `filtersToBody` is the wire seam the Explorer uses, `filtersToQueryParams` the GET encoding kept for query-string callers) |
| `packages/web/src/lib/dash0-rum.ts` | The SINGLE browser RUM init path for `@dash0/sdk-web` (init guard, endpoint validator, identity) |

See [`docs/key-files.md`](./docs/key-files.md) for the remaining ~124 files:
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

- **Dashboard is a CLIENT of LoreKit's REST API** — memory reads/writes go through the `memories` edge function (user JWT), never a direct PostgREST/supabase-js query; every new data surface becomes part of the PUBLIC contract (schema + handler + OpenAPI + `migrations.test.sql`). [rationale](./docs/decisions.md#dashboard-is-a-client-of-lorekits-rest-api)
- **MCP server endpoint is a static production URL** — always write `https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp` in user-facing content, never a `<ref>` / `<project-ref>` placeholder. [rationale](./docs/decisions.md#mcp-server-endpoint-is-a-static-production-url)
- **Lore Explorer filters through ONE two-level command menu + pills** — never one picker per dimension, never client-side narrowing; OR within a dimension, AND across; all dimensions filtered server-side; facets are their own drill-down query. [rationale](./docs/decisions.md#lore-explorer-filters-through-one-two-level-command-menu)
- **The Explorer's Activity panel has a DISPLAY default (24h), separate from the list's (all time)** — substituted for an absent `?range=`, never written back; `RangePicker` emits `{preset:'all'}` (not `null`) so "chose All" and "has not chosen" stay two values. [rationale](./docs/decisions.md#the-explorers-activity-panel-has-a-display-default-separate-from-the-lists)
- **The Explorer's Activity panel shows ONE body at a time and remembers your disclosure** — a `SegmentedControl` (Stat charts / Heatmap) where the `Activity · <scope>` label was; the expanded `heatmap` view is the calendar ALONE — the stat grid is absent there, because keeping it above the calendar rebuilt the stacked layout the toggle exists to remove — while COLLAPSED keeps the four numbers on every view (two-up at a compact density, ~250px on a phone, bounded by a test); opens EXPANDED, and the disclosure + view choice persist to `localStorage` via `useSyncExternalStore` where `null` means "no client store consulted yet" (never the same as `''`) — consumers render the COLLAPSED state while unresolved so an expanded→collapsed flash is unreachable. Never move these to the URL; never re-seed them from a `useState` initializer. [rationale](./docs/decisions.md#the-activity-panel-shows-one-body-at-a-time-and-remembers-your-disclosure)
- **Chart bucket readouts are PORTALED, one per chart** — `AnchoredTooltip` reuses `Tooltip`'s pure `computeTooltipPosition` and takes an `anchor: Element`, because an in-flow panel is clipped by `CollapsibleStatCard`'s `overflow:hidden` reveal region and one `Tooltip` per bucket would be 364 portals. The heatmap's native `title` is gone; its `aria-label` is not. [rationale](./docs/decisions.md#chart-bucket-readouts-are-portaled-and-there-is-one-per-chart)
- **Dashboard figures COUNT to a new value** (`AnimatedNumber`) — a change indicator, not decoration; two nodes (visible + `sr-only`), so read the `.sr-only` half, never `textContent`; honours `MotionConfig reducedMotion="always"` on top of the device preference, which is what makes the visual baselines deterministic. The `TrendChip` delta uses the same two-node pattern, but ONLY when it abbreviates a large percentage (`+8.8K%`). [rationale](./docs/decisions.md#dashboard-figures-count-to-a-new-value)
- **Mobile transient selection surfaces use the `BottomSheet` primitive** — never an anchored popover on the phone breakpoint; share ONE body between desktop popover and sheet (`FilterMenu` is the reference). [rationale](./docs/decisions.md#mobile-transient-selection-surfaces-use-the-bottomsheet-primitive)
- `::` separator avoids collision with `/` in repo paths and `:` in branch names
- `lk_rw_` prefix encodes permission visibly in config files
- **Write-only tokens (`lk_wo_*`)** store `permissions: ['write']` in the existing `text[]` column (zero migration); gating logic in the shared pure `permissions.ts`. [rationale](./docs/decisions.md#write-only-tokens-lk_wo_)
- Token SHA-256 hash in DB — shown once, never stored in plain text
- **API token scoping (scopes + orgs)** — `api_tokens.scopes` (empty = unrestricted, owner wildcards reuse `expandScopeForSearch`'s grammar, with the trailing `*` legal only after a `/` or a `::`) + a tri-state `org_access`/`org_ids`; the key restriction is authoritative over `org_scope_bindings` auto-routing; scoping is set through an owner-only SECURITY DEFINER RPC, never an UPDATE policy. **Live end to end — 00068 ships the columns and the two predicates, 00069 makes them binding in three layers (transport refusal, query narrowing, and the SQL functions the transports cannot stand in front of), `TokenManager.tsx` sets them, and 00070 audits every change.** [rationale](./docs/decisions.md#api-token-scoping-scopes--orgs)
- `AlwaysOn` OTel sampler — sampling deferred to Dash0 pipeline, never SDK-side
- `instrumentation.ts` must be `async function register()` with `NEXT_RUNTIME === 'nodejs'` guard
- **Browser RUM initialises in `lib/dash0-rum.ts`, identity set at INIT** — every event carries a `user.id` (`anon:<uuid>` until login); never simplify back to a login-only `identify()`. [rationale](./docs/decisions.md#browser-rum-init--identity-at-init)
- **`OTEL_SERVICE_NAME` must never decide a component's name** — `register()` overwrites it with the code-declared name and warns on conflict. [rationale](./docs/decisions.md#otel_service_name-must-never-decide-a-components-name)
- **`VERCEL_ENV` must never decide `deployment.environment.name` alone** — always cross-checked against `NODE_ENV` in one shared pure module (`otel-deployment-env.ts`), so a dev server can never report `production`/`preview`; `VERCEL` is deliberately not also gated on. [rationale](./docs/decisions.md#vercel_env-must-never-decide-the-deployment-environment-alone)
- **Caller identity belongs on the ROOT request span** — `createRouter` sets `auth.type`/`auth.user_id` on the REST root span (as MCP does); enables web↔CLI↔MCP correlation by account, no fingerprinting. [rationale](./docs/decisions.md#caller-identity-belongs-on-the-root-request-span)
- **CLI telemetry is attributable via a minted install id + a LEARNED account id** — `service.instance.id` (opaque random, persisted to `$LOREKIT_HOME/telemetry-id.json`) plus `user.id` (the account once known, else `install:<id>`, learned from the `X-LoreKit-User-Id` response header and cached, which is what lets an OFFLINE run join to server-side `auth.user_id`). Four invariants are load-bearing: nothing minted and no file created while export is disabled; the account cache only UPDATES an existing file, never creates one; the id is random so deleting the file resets it; an unpersistable id reports as NO identity, never a fresh one per run. Never add an in-memory fallback. [rationale](./docs/decisions.md#cli-telemetry-is-attributable-by-a-locally-minted-install-id-plus-a-learned-account-id)
- **`hook` and `mcp` are untraced but METERED** — `meterCommand` emits the counter alone (no span) on a 400ms budget, started before the command and awaited after so it overlaps its work; `surface-parity.test.mjs` asserts both that they ARE metered and that they never reach `traceCommand`. [rationale](./docs/decisions.md#hook-and-mcp-are-untraced-but-metered)
- **The edge's `deployment.environment.name` is set by `deploy.yml`, not inferred** — a Supabase project has no `VERCEL_ENV`, so with the secret unset BOTH projects reported `local` and preview/production traffic was indistinguishable; each deploy job now `supabase secrets set DEPLOYMENT_ENVIRONMENT` (`preview`/`production`) so it self-heals. `preview`, never `staging`. The per-request `test` header still wins for smoke runs. [rationale](./docs/decisions.md#the-edges-deploymentenvironmentname-is-set-by-the-deploy-pipeline-not-inferred)
- **Edge Function is self-contained Deno** — no cross-package/bare imports; schemas mirrored into `_shared/schemas/`, `npm:` specifiers only; never re-add an import map. [rationale](./docs/decisions.md#edge-function-is-self-contained-deno-no-import-map)
- NX 22.4.0 — matches `gw-tools` exactly; bump both together
- **Memory cap enforced by a DB trigger** (`NEW.user_id`-keyed, auth-agnostic, unbypassable) — not app-side counting. [rationale](./docs/decisions.md#memory-cap-enforced-by-a-db-trigger)
- Rate limiting is a Postgres-backed fixed-window counter (not in-memory/Redis) — edge isolates are stateless; no new infra
- Limits config lives in one DB function (`lorekit_default_limit`) + `user_limits` override table — no numeric limit hardcoded; raising a ceiling is one row upsert
- **Webhook secrets are repo-scoped** — matched by `repository.full_name` against `webhook_secrets.repo`; `selectWebhookSecrets` pure + mirrored. [rationale](./docs/decisions.md#webhook-secrets-are-repo-scoped)
- **Audit logging is captured at the app layer** — explicit `recordAudit` after each mutation; actor via `auditUserId`; ONE edge writer (`_shared/audit.ts`); one action vocabulary in `@lorekit/schemas`. [rationale](./docs/decisions.md#audit-logging-is-captured-at-the-app-layer)
- **Usage events recorded once per surface, in the dispatcher** — never per handler; a REST route reports the equivalent MCP tool name via `rest-tool-name.ts`. [rationale](./docs/decisions.md#usage-events-recorded-once-per-surface-in-the-dispatcher)
- **Org/scope sharing is ORG-FIRST (Phase 1)** — single authoritative shared row; tenant visibility in ONE place (`lorekit_member_org_ids` / `applyTenantScope`). [rationale](./docs/decisions.md#orgscope-sharing-is-org-first-phase-1)
- **Org-sharing Phase 2 (org-owned writes)** — `memory_write` gains `p_org_slug`, ownership authorization-derived inside the RPC; cap becomes tenant-keyed; `LK002` denial. [rationale](./docs/decisions.md#orgscope-sharing-phase-2-org-owned-writes)
- **Audit Logs pagination is keyset (cursor), not OFFSET** — opaque `nextCursor`; own `user_id` filter so a forged cursor can't widen visibility. [rationale](./docs/decisions.md#audit-logs-pagination-is-keyset-cursor-not-offset)
- **Org-sharing Phase 3 (org management backend)** — every state transition is a SECURITY DEFINER RPC; no insert/update/delete RLS; anti-TOCTOU invite accept. [rationale](./docs/decisions.md#orgscope-sharing-phase-3-org-management-backend)
- **Org-sharing Phase 4 (dashboard UX)** — Settings→Organization page, pure `org-ui.ts` affordances, `ConfirmDialog`/`ToastProvider`; `lorekit_org_members_list` for real identities. [rationale](./docs/decisions.md#orgscope-sharing-phase-4-dashboard-ux)
- **Safe org deletion** — soft-delete (`deleted_at`) + owner-only `lorekit_org_purge`; hidden from reads via `lorekit_member_org_ids`. [rationale](./docs/decisions.md#safe-org-deletion)
- **Scope→org binding** — admin binds a scope; a write auto-routes to the org for write-capable members, falls back to personal (never rejected) otherwise. [rationale](./docs/decisions.md#scopeorg-binding)
- **GitHub App single-secret model** — all App events HMAC-verified against ONE `GITHUB_APP_WEBHOOK_SECRET`; dashboard visibility via `installations/sync`, not the webhook. [rationale](./docs/decisions.md#github-app-single-secret-model)
- **Hook scope ordering unified, project scope IS injected** — `readOrder` = `[project, branch, repo, global]`, matching the read commands' `scopeList`. [rationale](./docs/decisions.md#hook-scope-ordering-unified-project-scope-injected)
- **Hook precedence + match is single source of truth with read commands** — `resolvePrecedence`/`matchesQuery` in dependency-free `lessons-pure.mjs`. [rationale](./docs/decisions.md#hook-precedence--match-is-single-source-of-truth-with-read-commands)
- **CI/CD is split** — `ci.yml` verifies before merge, `deploy.yml` promotes the verified commit (preview→prod); don't re-merge or re-add a deploy-time test job. [rationale](./docs/decisions.md#cicd-is-split-ciyml-verifies-deployyml-promotes)
- **The deploy SCOPE is measured against what is deployed** — each half is diffed against the SHA it last reached production at (`deployed/api-production` / `deployed/web-production`), never against the previous commit; a rollback repoints its half's tag at what production went back to, and never leaves it naming a commit production dropped (the one deletion is `rollback-web-production` when there was no previous promotion to restore, which warns loudly); `rollback-production` repoints only a marker that run advanced; the tags fail open; and the decision is the unit-tested `scripts/resolve-deploy-scope.mjs`, called by `deploy.yml`'s `changes` job and unit-tested by ci.yml's `deploy-scope` job. Never reinstate the single-push baseline: it let the web be promoted ahead of an API that had never deployed. [rationale](./docs/decisions.md#cicd-is-split-ciyml-verifies-deployyml-promotes)
- **Smoke tests clean up after themselves + a sweeper** — hard-delete/purge; name-pattern sweep behind four guards; never revert to soft delete / id tracking / a permissive pattern. [rationale](./docs/decisions.md#smoke-tests-clean-up-after-themselves)
- **Invite-details modal** — SECURITY DEFINER `lorekit_invite_org_details` gated on `lorekit_invite_addressed_to_caller`; Tier-A fields only, never leaks existence. [rationale](./docs/decisions.md#invite-details-modal)
- **Docs are a PUBLIC MDX section at `/docs`** — single source `DOCS_SECTIONS`; full-text search derived from the same MDX files. [rationale](./docs/decisions.md#docs-are-a-public-mdx-section-at-docs)
- **Settings sections named for the user's goal** — `/settings/integrations`; sub-nav only when >1 card; manual webhook UI removed (ingest path untouched). [rationale](./docs/decisions.md#settings-sections-named-for-the-users-goal)
- **Org REST routes open to `lk_*` tokens, gated by token permission not auth tier** — actor via `p_actor_user_id` (service-role only) + explicit tenant reads; CLI dropped MCP entirely. [rationale](./docs/decisions.md#org-rest-routes-open-to-lk_-tokens-gated-by-token-permission)
- **Org-owned lore archive/hard-delete over REST** — `DELETE /memories?…&org=` routes to the role-gated `memory_delete`; no `/memories/:id`+`org` form; restore has no org branch on either surface. [rationale](./docs/decisions.md#org-owned-lore-archivehard-delete-over-rest)
- **Usage analytics answer record-level questions** — `GET /memories/usage` reports call AND record counts; two fail-safe headers; expiry event-sourced through the purge. [rationale](./docs/decisions.md#usage-analytics-answer-record-level-questions)
- **Profiling is SQL-level, because there is no host to profile** — Dash0 profiling needs a host-level eBPF agent and every runtime here is managed serverless; the substitutes are per-request self-time attribution (merged intervals, never summed) and `pg_stat_statements` → cumulative sums through the service-role-only `profiling` function (off until two Vault secrets exist). Don't re-open this as "add the profiler". [rationale](./docs/decisions.md#profiling-is-sql-level-because-there-is-no-host-to-profile)
- **The tool catalog is the single origin of the operation SURFACE** — `packages/schemas/src/shared/tool-catalog.ts` declares which of MCP/CLI/REST exposes each op, under what name, and the reason for each absence. Consumers *derive* (can import it), *generate* (cannot — `gen-surfaces.mjs`, committed artifacts, `--check`), or *assert* (deriving would be wrong). Never hand-edit a `*.generated.*` file; CLI **behaviour** stays hand-written in `packages/cli/src/commands.mjs`. [tiers + gates](./docs/architecture.md#surface-generation)
- **`READ_TOOLS`/`WRITE_TOOLS` stay HAND-WRITTEN, not derived from the catalog** — the duplication *is* the authorization control: deriving the gate from the thing it gates means one careless catalog edit silently opens a tool. Held to the catalog by assertion instead (`tool-catalog-parity.spec.ts`), the same way the audit vocabulary is. Do not "simplify" this.
- **MCP `org.*` tools serve `lk_*` tokens, gated by permission not auth tier** — matching REST; `org.list` reads, the three mutations write, and token permission is orthogonal to org ROLE (`lorekit_org_can` in the RPCs is still the only role gate). Actor via `p_actor_user_id`; every raw org read carries its own tenant predicate because the api_key path is service-role. [rationale](./docs/decisions.md#mcp-org-tools-serve-lk_-tokens-on-the-same-actor-override-rest-uses)
- **Dashboard analytics reads stay REST-only** — `/usage`, `/tags`, `/facets`, `/activity`, `/read-activity` get no MCP tool and no CLI command: charts, not agent primitives, and three are name-bearing (scope-leak surface). Recorded as guarded `restOnly` fields in `telemetry-vocabulary.ts`, so re-proposing one argues with a decision rather than filing a gap. `/relevant` is NOT one of them — `memory.list order=rank` already covers it. [rationale](./docs/decisions.md#dashboard-analytics-reads-stay-rest-only)
