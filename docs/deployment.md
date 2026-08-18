# Deployment

LoreKit has three deployable pieces. Each has its own deployment path.

## Overview

| Piece | Platform | Deploy command |
|-------|----------|----------------|
| MCP server + health check | Supabase Edge Functions | `pnpm nx fn:deploy supabase` |
| Web dashboard | Vercel (via `deploy.yml`, CLI) | Promoted by the pipeline on `git push main` |
| Database migrations | Supabase | `pnpm nx db:push supabase` |

**In normal operation you do not run these by hand.** Merging to `main` triggers
the [automated CI/CD pipeline](#automated-deployment-cicd), which promotes
migrations, Edge Functions **and the Vercel web dashboard** **preview →
production** with smoke gates and automatic rollback of both the functions and
the web deployment. The manual commands below are for first-time project setup
and local operations.

> **The web dashboard is deployed by `deploy.yml` / `ci.yml`, not by Vercel's
> Git integration.** Vercel's native auto-deploy is turned off entirely
> (`packages/web/vercel.json` → `git.deploymentEnabled = false`). Production is
> promoted by `deploy.yml`, so the FE and API flip to production together
> instead of skewing apart — Vercel used to deploy the frontend the instant
> `main` was pushed, while the API crawled through the preview→smoke→prod
> pipeline. PR **previews** are deployed by `ci.yml`'s `web-preview` job, gated
> on the `web` path filter — so a PR with no web changes creates **no** Vercel
> deployment (and spends no quota), where the Git integration used to deploy on
> every push. It goes further: on a web PR it **skips redeploying between commits
> when no web file changed since that PR's last preview** (`web-preview`'s
> "Decide" step diffs the current head against the SHA recorded in the sticky
> preview comment via the compare API, and fails safe to deploy on any doubt), so
> a burst of non-web commits spends one deployment, not one per push. If you fork
> this, mirror the flag (or disable Git deployments in the Vercel dashboard) or
> you will double-deploy.
>
> The sticky comment is a Vercel-style status table exposing **both** URLs, like
> the Git integration did: a **stable** `Preview` link (a `lorekit-pr-<n>-<scope>`
> alias the job re-points to the newest deployment via `vercel alias set` — which
> re-points, not deploys, so it costs no quota) and the **immutable** per-commit
> `Deployment` link. The alias `<scope>` is derived from the deployment host so it
> satisfies the CORS allowlist (`isVercelPreviewOrigin`); if aliasing isn't
> permitted on the plan, the comment degrades to the per-commit link alone.
>
> The three preview jobs (`ci.yml` `web-preview`, `deploy.yml`
> `deploy-web-preview`, `preview.yml` `deploy-web`) share one implementation:
> the composite action **`.github/actions/vercel-preview-deploy`** (pull → build
> on the runner → deploy prebuilt → return the URL; callers supply only the env
> to pin and the git ref to attribute). It is a **local** action, so it must
> exist at the checked-out ref: `ci.yml`/`deploy.yml` always have it (they check
> out the PR merge ref / `main`), but a `/preview` on a branch that predates this
> action will fail to resolve it until that branch merges `main`.
>
> **`deploy.yml`'s `deploy-web-preview` runs the composite in BUILD-ONLY mode**
> (`deploy: 'false'`): it builds the FE against the preview Supabase project as a
> gate but creates **no** deployment. That deployment was pure quota waste —
> `smoke-preview` tests the API only (it never fetched the web URL) and
> production is promoted from the separate `stage-web-production` build, so
> nothing consumed the preview. The build still fails the pipeline if the FE
> can't compile.

---

## Automated deployment (CI/CD)

Two GitHub Actions workflows own the lifecycle:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `.github/workflows/ci.yml` | PRs to `main` | **Verify before merge.** `check` (affected typecheck/test/lint — unit tests, all mocked) and `integration` (boots a local Supabase → migrations apply → serves the real Edge Functions → asserts an authenticated MCP `tools/list` returns 200, plus schema lint). `integration` only runs when API/backend paths change (see [below](#only-runs-when-relevant)); the web build is verified by the `web-test` (Storybook) and `web-preview` (Vercel preview deploy) jobs, both gated on the `web` path filter so a PR with no web changes deploys nothing and spends no Vercel quota. |
| `.github/workflows/deploy.yml` | push to `main`, `workflow_dispatch` | **Deploy the already-verified commit** — Supabase (migrations + Edge Functions) **and** the Vercel web dashboard, in lockstep. No test re-run — preview-first promotion only. |
| `.github/workflows/web-preview-deploy.yml` | `workflow_call` (reusable) | **The dashboard preview flow itself**, called by the two workflows below. Owns the fork-secret guard, the incremental "is a redeploy needed?" decision, the PR-head checkout, and the sticky preview comment. See [Dashboard previews](#dashboard-previews-on-a-pr). |
| `.github/workflows/web-preview.yml` | `/web-preview` comment, `workflow_dispatch` | **Deploy a dashboard preview on demand** for one PR, forcing past the incremental skip. See [Forcing a preview](#forcing-a-preview-web-preview). |

### Tests run once, on the PR

Unit and integration tests run in `ci.yml` on every PR (and feature-branch
push), so a commit cannot reach `main` unverified. The deploy pipeline
deliberately does **not** re-run them — it trusts the required PR checks and
only verifies the *live deployment* via smoke tests. Make the `check` and
`integration` jobs [required status checks](#recommended-branch-protection) so
this guarantee holds.

The `integration` job asserts the whole stack wires up locally: migrations
apply, the Edge Functions boot and serve, and an authenticated MCP `tools/list`
returns 200. The full write/read/list/search/delete round-trip (the
`smoke.integration` spec) runs in `smoke-preview` against the real preview
project — it is intentionally not run locally, because the local edge runtime
bundles an older PostgREST that can't resolve the `UNIQUE NULLS NOT DISTINCT`
upsert arbiter for service-role writes (`user_id` null). Real writes use a
non-null `user_id` (an `lk_rw_` token or a JWT), which `mcp-core`'s unit tests
cover here and `smoke-preview` exercises end-to-end against current PostgREST.

#### Only runs when relevant

Booting a local Supabase is expensive, so a `changes` job diffs the PR and the
`integration` job only runs when API/backend paths change — `packages/mcp-core/`,
`packages/mcp-server/`, `supabase/functions/`, `supabase/migrations/`,
`supabase/config.toml`, `package.json`, `pnpm-lock.yaml`, or `ci.yml` itself. A
docs- or web-only PR skips it. Unit typecheck/test/lint (`check`) is not gated
this way — `nx affected` already scopes itself to the changed packages. A
skipped required check is treated as passing by branch protection, so gating
`integration` does not block unrelated PRs from merging.

### Dashboard previews on a PR

Every PR that touches the dashboard gets a Vercel preview and a single sticky
comment holding two links: a **stable** `lorekit-pr-<n>-<scope>.vercel.app`
alias that always points at the newest deployment, and the **immutable**
per-commit URL. This replaces Vercel's native Git integration, which deployed on
every push regardless of what changed.

The flow lives in `.github/workflows/web-preview-deploy.yml`, a `workflow_call`
reusable workflow. `ci.yml`'s `web-preview` job calls it with `force: false`;
`/web-preview` calls it with `force: true`. Both produce the same deployment and
the same comment — only the decision to deploy differs. The build itself is the
`.github/actions/vercel-preview-deploy` composite action, shared with
`deploy.yml` and `preview.yml`.

**Two gates decide whether a push spends a deployment** (the Vercel Hobby plan
allows 100/day):

1. The `changes` job's `web` path filter — no web-relevant file in the PR at
   all ⇒ the job never runs.
2. The reusable workflow's *incremental* check — a web-relevant file changed in
   the PR, but nothing web-relevant changed **since this PR's last preview**
   (diffed against the SHA recorded in the sticky comment's marker) ⇒ skip. So a
   burst of backend-only commits on a web PR spends one deployment, not one per
   push. It fails safe to deploying on any doubt: no prior preview, a
   rebase/force-push, a >300-file diff, or an API error.

Both gates read the same path list. The canonical copy is the
`web-path-filter` input default in `web-preview-deploy.yml`; the `changes` job
in `ci.yml` carries a duplicate for its coarse gate, written as an extended
regex so the one string works under both `grep -E` and a JS `RegExp`. **Keep
the two in sync.** The list covers `packages/web/`, `packages/schemas/`
(a `workspace:*` dependency the dashboard compiles in — omitting it silently
skips both the preview *and* the Storybook visual tests), `package.json`,
`pnpm-lock.yaml`, `nx.json`, the composite action, and these workflow files.

### Forcing a preview (`/web-preview`)

The incremental check means an unchanged head never redeploys — including via
"Re-run jobs". When you need a deployment anyway (the preview expired, the
stable alias broke, a run was cancelled mid-deploy, or the path filter was
simply wrong), force one:

```text
/web-preview
```

Comment it on the PR as an OWNER, MEMBER, or COLLABORATOR. The command must be
the first non-empty line of the comment, so quoting it in prose or in a bot
summary does not fire it. To respect the incremental skip instead of forcing:

```text
/web-preview --if-changed
```

You can also run it from **Actions ▸ Deploy web preview ▸ Run workflow**, which
takes the PR number — useful for a PR you would rather not comment on, or when
the comment path itself is broken.

Feedback on the comment path is a 👀 reaction when the command is accepted, then
👍 (ran, nothing to deploy), 🚀 (deployed), or 👎 plus a comment linking the run
(failed). The dispatch path has no comment to react to, so it reports by
commenting on the PR.

> `issue_comment` workflows always run the workflow file from the **default
> branch**. Edits to `web-preview.yml` or `web-preview-deploy.yml` therefore
> only take effect once merged to `main` — on the PR that introduces them,
> `/web-preview` still runs `main`'s version.

### The deploy pipeline (on merge to `main`)

Each job `needs:` the previous one, so a red step is a hard gate — nothing
downstream runs:

```
deploy-preview          db push + functions deploy → PREVIEW project
deploy-web-preview      Vercel build (preview Supabase) + preview deploy
stage-web-production    Vercel build --prod, upload prebuilt, --skip-domain (no flip yet)
  └─▶ smoke-preview     smoke.integration spec against PREVIEW
        └─▶ deploy-production      db push + functions deploy → PRODUCTION project
              └─▶ promote-web-production   Vercel alias swap → PRODUCTION domain
                    └─▶ smoke-production    health + MCP tools/list + web dashboard 200
                          ├─▶ rollback-production       functions → previous commit (on failure)
                          └─▶ rollback-web-production   Vercel → previous deployment (on failure)

any job fails ─▶ notify-failure   Discord webhook (see below)
```

Production is never touched until preview has been deployed and smoke-tested.

#### Which halves run (change detection + manual override)

A `changes` job diffs the merge and gates the two halves independently: the API
chain (`deploy-preview` → `smoke-preview` → `deploy-production`) runs only when
API paths changed, and the web chain (`deploy-web-preview` / `stage-web-production`
→ `promote-web-production`) only when web paths changed. A docs-only merge deploys
neither. `packages/schemas/`, the workspace files, and `deploy.yml` itself map to
**both**.

A **manual run** can override the detection. From **Actions ▸ Deploy ▸ Run
workflow** (or `gh workflow run deploy.yml`), pick a `deploy_target`:

| `deploy_target` | Deploys |
|-----------------|---------|
| `auto` (default) | Whatever the change-detection step finds — same as a push to `main`. |
| `all` | Both halves — API **and** web — regardless of what changed. |
| `api` | API only (Supabase migrations + edge functions). |
| `web` | Web only (Next.js dashboard on Vercel). |

This is the way to redeploy an unchanged half — e.g. re-ship the dashboard after a
Vercel env-var change, or re-apply functions — without an empty no-op commit. The
override only decides **which** halves run; each still goes through the full
preview → smoke → production promotion with its own gates and rollback.

### FE ↔ API deploy in lockstep (no availability skew)

The whole point of moving the web deploy into `deploy.yml` is that the frontend
and backend flip to production **together**. Previously Vercel's Git integration
deployed the dashboard the moment `main` was pushed, while the API went through
the preview→smoke→prod pipeline (minutes) — so there was always a window where
the FE and API were on different versions.

Now:

- **The production web bundle is pre-built during the preview phase**
  (`stage-web-production`): `vercel build --prod` then `vercel deploy --prebuilt
  --prod --skip-domain`, which uploads a production-target deployment **without**
  assigning the production domain. The slow `next build` happens before the flip.
- **The flip is an alias swap** (`promote-web-production` → `vercel promote`),
  which is near-instant. It `needs: deploy-production`, so the API is live in
  production **before** the new FE is served — a client should never front an
  older backend. The two go live within seconds of each other.
- **The FE build points at the right Supabase per phase.** `deploy-web-preview`
  overrides `NEXT_PUBLIC_SUPABASE_*` to the **preview** project (set
  `SUPABASE_ANON_KEY` in the `preview` environment for this to take effect), so
  smoke exercises the FE against the same API bundle preview just shipped;
  `stage-web-production` uses Vercel's **production** env untouched.
- **Rollback reverts both.** Any production-phase failure (the API deploy, the
  web promote, or the shared production smoke — which now also curls the
  dashboard) trips **both** `rollback-production` (functions → previous commit)
  and `rollback-web-production` (`vercel rollback` → previous deployment), so the
  FE and API never end up on mismatched versions. The one exception is a failure
  in `deploy-production` itself before the web is promoted: the web was never
  touched, so only the functions revert.

The web jobs authenticate to Vercel with the same three repo-level secrets
`preview.yml` already uses — `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
— and the production smoke curls `${{ vars.WEB_PROD_URL }}` (an optional
repo-level variable, defaulting to `https://lorekit.io`).

#### The deploy scope is measured against what is DEPLOYED, not the last commit

> **Status: not wired yet.** `scripts/resolve-deploy-scope.mjs` is on `main`, but
> `deploy.yml` does not call it — the GitHub App that opens automated PRs has no
> `workflows` permission, the same constraint as "Wiring the sweep into CI". Until a
> human applies [Wiring the deployed-SHA baseline into `deploy.yml`](#wiring-the-deployed-sha-baseline-into-deployyml)
> below, the pipeline still diffs a single push and everything in this subsection
> describes the intended behaviour, not the current one.

Lockstep above only binds the two halves **within one run**. It says nothing
about a half that never reached production in an *earlier* run — and that gap is
what broke production once already:

| | |
|---|---|
| **#492** | Changed both halves (`packages/web/**` + `supabase/functions/**` + migration 00067). `smoke-preview` failed, so `deploy-production` and `promote-web-production` were both skipped. Correct — nothing shipped. |
| **#504** | Changed only `packages/web/**`. The scope filter diffed **that push** and reported `api=false`, so `promote-web-production` took its `changes.outputs.api == 'false'` branch and assigned the production domain to a bundle built from `HEAD` — carrying #492's client. |
| **Result** | That client POSTs `/functions/v1/memories/list`, a route the production edge functions had never been given. **100% of production Lore Explorer list reads answered `405`** until the web was rolled back by hand. |

So each half is now diffed against **the commit that half is actually serving**,
recorded by two advisory tags that only the successful production flip moves:

| Tag | Moved by | Means |
|-----|----------|-------|
| `deployed/api-production` | `deploy-production`, last step | Migrations pushed **and** edge functions deployed at this SHA |
| `deployed/web-production` | `promote-web-production`, last step | The production domain points at a bundle built from this SHA |

`changes` resolves each baseline, diffs it against `HEAD`, and applies the same
path globs as before. Undeployed work therefore stays in the diff until it
deploys: replay #504 with the API tag still on the pre-#492 commit and it
resolves `api=true`, so `promote-web-production` must wait for
`deploy-production` instead of running ahead of it. The same protection holds in
the other direction (an API change whose web half never promoted).

Three things to know when reading a run:

- **The tags are advisory and fail open.** A missing, unfetched or
  garbage-collected tag falls back to the push baseline — the previous
  behaviour. So does a tag that is not an ancestor of `HEAD` (after a revert, or
  a re-run of an older ref), because diffing against a marker *ahead* of `HEAD`
  reports the marker-only files as changed here. Doubt never resolves to "this
  half has no changes": a wrong `false` is the incident above, a wrong `true` is
  one redundant deploy.
- **`rollback-web-production` deliberately does not move the web tag.** It
  reverts the *domain* to the previously promoted deployment, whose commit the
  tag no longer names — and leaving the tag ahead is the safe error, because the
  non-ancestor rule then makes the next run fall back rather than skip.
- **The decision is a tested module, not a shell block.**
  `scripts/resolve-deploy-scope.mjs` with `scripts/resolve-deploy-scope.test.mjs`
  (`node --test`, zero deps), run by ci.yml's `deploy-scope` job — the same
  extract-and-test treatment `check-remote-migration-drift.mjs` got, for the same
  reason. The test pins both the fixed behaviour and the old one that caused the
  incident. The step summary prints both baselines and where each came from.

The first `deploy.yml` run after this landed has no tags yet, so both halves fall
back to the push baseline — and since the change touches `deploy.yml` itself
(which forces both halves), that run deploys both and mints both tags.

### Skew Protection (already-open tabs and Server Actions)

The lockstep flip above keeps the FE and API on the same version **for new page
loads**. It does nothing for a tab that is already open: the alias swap is
instant, and that tab keeps running the JavaScript of the deployment it loaded
from.

That matters because Next.js Server Actions are a `POST` to the page route
carrying a **build-time action ID**. A tab on build A that posts build A's
action ID to build B gets a bare **404** — no error surface, just a dead button.
This is exactly what happened on the Overview page: every `POST /dashboard` went
from `200` to `404` after a `main` push, with the browser reporting
`service.version` from one commit and the server span reporting another.

The mitigation is Vercel **Skew Protection**. The wiring is in place; **it is
not active**, and two prerequisites remain — one to confirm, one to decide.

1. **Code (in place, inert).** `next.config.ts` sets `deploymentId` from
   `VERCEL_DEPLOYMENT_ID` (`src/lib/deployment-id.ts`) — the value Next.js stamps
   onto asset URLs and Server Action requests. Neither route in step 3 actually
   activates it today: when Vercel runs the build the variable is there, but
   Next.js >= 14.1.4 stamps with no config at all, so the line is redundant
   rather than load-bearing; on the prebuilt path the ID Vercel wants is a
   *custom* one, not `VERCEL_DEPLOYMENT_ID`. What the line buys is the seam —
   `resolveDeploymentId` is the single place either ID would be read from.
2. **Project settings (manual, confirm first — it may already be on).** Vercel
   enables **Skew Protection** by default for projects created after
   2024-11-19 on a supported framework, so check Settings → Advanced before
   treating this as open; only older projects have to flip the switch
   themselves. Leave **Maximum Age** alone unless
   there is a reason to change it: Vercel's default is already one day, which
   covers a tab idled overnight — lowering it would *shorten* the protection
   window. Raise it only for tabs that stay open longer than that, up to the
   project's Deployment Retention limit, which is the ceiling Vercel enforces.
   Also enable **"Enable access to System Environment Variables"** (Settings →
   Environment Variables); without it Vercel never injects `VERCEL_*` system
   variables into the build, so `VERCEL_DEPLOYMENT_ID` stays absent even with
   Skew Protection on. Whatever you change here, Vercel's enable steps end by
   **redeploying the latest production deployment** — until that redeploy the
   toggles do not apply to what is currently live. On this project that
   redeploy only helps once one of the routes in step 3 is taken; a redeploy of
   today's prebuilt deployment still carries no deployment ID.
3. **Build path (open decision, blocks the whole thing).** A deployment ID is
   assigned when a deployment is **uploaded**, not when it is built. Today
   `stage-web-production` runs `vercel build --prod` inside GitHub Actions and
   then `vercel deploy --prebuilt` (see the bullets above), so
   `VERCEL_DEPLOYMENT_ID` does not exist during that build. Prebuilt deployments
   are **not** excluded from Skew Protection — Vercel supports them via a
   **custom deployment ID**, configured so the build-time ID matches the one
   Vercel assigns at deploy time (a prebuilt deployment may not use Vercel's
   reserved `dpl_` prefix for it). So there are two routes, and neither is taken
   here:
   - **Let Vercel build production.** Drop `--prebuilt`, forwarding the
     `VERCEL_GIT_*` values with `--build-env` so
     `NEXT_PUBLIC_OTEL_SERVICE_VERSION` and the `vcs.*` resource attributes
     survive. Next.js >= 14.1.4 built on Vercel needs no `next.config.ts` change
     at all. Costs the "build already done before the flip" property.
   - **Keep `--prebuilt` and adopt a custom deployment ID.** Keeps the current
     pipeline shape; the ID has to be minted by us and given to both the build
     and the deploy. `resolveDeploymentId` is the seam it would be read through.

   Setup steps for the custom-ID route are Vercel's, not ours — see
   [Skew Protection → Next.js](https://vercel.com/docs/skew-protection#skew-protection-with-next.js)
   and [`vercel deploy` → "When not to use `--prebuilt`"](https://vercel.com/docs/cli/deploy#when-not-to-use---prebuilt).

Until 2 **and** one of the two routes in 3 hold, no deployment ID reaches the
build, `deploymentId` resolves to `undefined`, and behaviour is unchanged.
Step 1 is inert on its own.

### Migration drift on the shared preview project

`preview` is a **shared** Supabase project, and two workflows push migrations to
it: `deploy.yml` on every merge to `main`, and `preview.yml` on a `/preview`
comment — from an **open PR's head SHA**. So the preview project's migration
history can legitimately carry versions that do not exist on `main` yet.

`supabase db push` treats a remote that is merely *ahead* as fatal:

```
Remote migration versions not found in local migrations directory.
supabase migration repair --status reverted 00049 00050 00051
```

…even when `main` has nothing left to apply. That is not a hypothetical: a
`/preview` run on PR #311 applied `00049`–`00051` to the shared project and
every subsequent deploy of `main` failed on this check, with zero pending work.

`deploy-preview` therefore classifies the drift *before* pushing, via
[`scripts/check-remote-migration-drift.mjs`](../scripts/check-remote-migration-drift.mjs):

| Remote state | Local pending | Outcome |
|---|---|---|
| in sync, or behind | any | **push** — `supabase db push --include-all`, unchanged |
| ahead (unknown versions) | none | **skip** — the push would be a no-op; warn and continue |
| ahead (unknown versions) | one or more | **fail** — ambiguous; the annotation names both sides |

The `skip` outcome is safe by construction: with zero local-pending migrations
there is no work a successful push would have done. The unknown versions
reconcile on their own when the PR that introduced them merges. The step never
runs `migration repair` and never mutates the remote's migration history —
reverting a history row does not undo the schema objects, so a later merge of
those same files would fail on "already exists".

The `fail` outcome is the one that needs a human. Either merge the PR that owns
the drifted versions, or — if those changes were abandoned — revert them on the
preview project and clear the history rows the annotation names:

```bash
supabase migration repair --status reverted 00049 00050 00051
```

`deploy-production` is deliberately **not** given this tolerance: nothing but
`deploy.yml` ever pushes to production, so a remote ahead of `main` there is a
real anomaly and must stop the pipeline.

#### How the classifier is wired in

The classifier is live in the workflows (no manual step — unlike the older
"Wiring the sweep into CI" section below, this one was committed directly):

- **`.github/workflows/deploy.yml`**, `deploy-preview` job only: a
  `Classify migration drift against preview` step (`id: drift`) runs
  `supabase migration list --linked` through the classifier after `Link`, and
  the `Push database migrations` step is gated on `steps.drift.outputs.action ==
  'push'`. A `fail` verdict exits non-zero and stops the deploy; `skip` continues
  to the function deploy without pushing. `deploy-production` is left strict.
- **`.github/workflows/ci.yml`**: the `changes` job's migration path filter also
  matches `scripts/check-remote-migration-drift`, and the `migration-order` job
  unit-tests the classifier (`node --test scripts/check-remote-migration-drift.test.mjs`)
  alongside the ordering guard.

If the classifier ever returns `fail`, the interim manual unblock is its own
advice: confirm nothing is pending locally, then let the next deploy through by
repairing the drifted rows on the preview project — or just run the rebuild
workflow below, which clears the drift wholesale.

### Rebuilding the shared preview project

The classifier above teaches `main`'s deploy to **tolerate** drift; it never
removes it. Because migrations are forward-only, a `/preview` run on a PR that
is later edited or abandoned leaves its versions **and their schema objects** on
the shared project permanently — so over time the preview database accumulates
orphan tables/functions and history rows that no migration file describes. The
`skip` outcome hides that indefinitely, and a genuine `fail` (a real migration
landing while drift is present) needs a human every time.

The preview project is **disposable** — nothing of lasting value lives there, it
exists only to smoke-test deploys and back the Vercel preview — so the correct
reconciliation is not a surgical per-PR cleanup (impossible without down
migrations) but a periodic **full rebuild** from the migration files:

```
supabase db reset --linked
```

`db reset --linked` drops and re-provisions the linked remote database the same
way Supabase originally created it, then re-applies every migration on this ref.
Grants and RLS defaults come back natively — this is deliberately **not** a
hand-rolled `DROP SCHEMA public CASCADE`, which would then have to restore the
public-schema grants exactly or silently break `anon`/RLS access. One rebuild
clears every drifted history row and orphan object at once, so accumulation is
bounded regardless of how many previews piled up between rebuilds.

This is a companion to the classifier, not a replacement: the classifier keeps
`main` shipping **between** rebuilds; the rebuild keeps the shared project from
rotting. Neither needs Supabase branching (unavailable on the free plan).

The rebuild **is destructive and the project is shared** — it wipes any
in-flight `/preview` state, so re-run `/preview` on a PR afterwards. It runs
on-demand and on a low-traffic weekly cron, never silently mid-deploy.

#### The rebuild workflow

The rebuild is committed as
[`.github/workflows/rebuild-preview.yml`](../.github/workflows/rebuild-preview.yml).
It runs `supabase db reset --linked` against the `preview` project (Environment-
scoped secrets + an explicit production-ref guard), then redeploys the edge
functions. Three ways to trigger it:

- **Actions ▸ Run workflow** (`workflow_dispatch`) — the manual path.
- **A `/reset-preview` comment on any PR** — gated to OWNER/MEMBER/COLLABORATOR
  by a guard job modeled on `preview.yml`'s `/preview`. Unlike `/preview` it does
  **not** check out the PR head; it rebuilds to `main`'s migration baseline. It's
  the ergonomic surface — you notice drift on a PR, so you clear it from that
  thread — but the reset is shared and destructive, so it still wipes every other
  in-flight preview. That's acceptable for a disposable project; it's why the
  comment path is maintainer-gated.
- **A weekly `cron`** (Sundays 04:00 UTC) — the unattended flush.

The **first** manual `workflow_dispatch` run is worth doing deliberately: it
clears any current drift wholesale (so a live wedge needs no manual `migration
repair`), and it's where you confirm whether the pinned Supabase CLI prompts on
`db reset --linked` in CI — before the cron ever fires. If it hangs on a prompt,
drive it non-interactively with whatever confirmation flag the installed CLI
exposes.

A reset wipes **everything**, including the seeded orgs-smoke user (see "Seed the
orgs-smoke user" below), so the orgs REST smoke self-skips until you re-seed it.
Re-seeding needs the service-role key and is deliberately **not** wired into the
workflow (the recurring smoke path never carries that key) — the workflow only
emits a reminder. After a rebuild, run `scripts/seed-smoke-user.mjs` from a
trusted admin shell against the preview project.

### Failure notifications (Discord)

A `notify-failure` job runs whenever **any** pipeline job reports `failure` — a
deploy step, a smoke gate, or the rollback — and posts a single embed to a
Discord webhook so a red production deploy reaches you outside the Actions UI.
The embed names the first stage that failed (e.g. *smoke test → production*) and
carries a **deep link to the failed run** (clickable title + a *View the failed
run* link), plus the repository, branch, workflow, a clickable short commit SHA,
and who triggered it.

The `release.yml` workflow posts the same alert on a release/publish failure —
both share the `./.github/actions/discord-notify` composite action and the same
`DISCORD_WEBHOOK_URL` secret, so there is one webhook and one embed format for
every pipeline.

Set it up by adding a **repo-level** secret `DISCORD_WEBHOOK_URL` (Settings ▸
Secrets and variables ▸ Actions) — create the webhook in Discord under *Server
Settings ▸ Integrations ▸ Webhooks ▸ New Webhook* and copy its URL. If the
secret is **unset**, `notify-failure` no-ops with a warning and never fails the
run — the underlying failure is still reported loudly by the job that broke.

### Rollback behaviour

On any post-deploy failure, `rollback-production` redeploys the **previous
commit's** Edge Functions and `rollback-web-production` reverts the Vercel
production deployment (`vercel rollback`), so the FE and API roll back together;
the run fails loudly with a step summary. Database migrations are **forward-only**
and intentionally *not* reverted — keep migrations backward-compatible
(expand/contract) and enable **PITR** (Point-in-Time Recovery) in the Supabase
dashboard as the database safety net. The web rollback stays out only when the
API deploy failed before the web was ever promoted — in that case the web was
never touched, so reverting it would regress a healthy deployment.

### Smoke telemetry (observable in Dash0, tagged `test`)

The smoke jobs are instrumented so a failure is diagnosable from telemetry, not
only the CI log. Each smoke job (`deploy.yml` smoke-preview/smoke-production,
`preview.yml` smoke, `ci.yml` integration) sets three job-wide env vars:

- `LOREKIT_TELEMETRY_TOKEN` — turns on CLI OTLP export, which is off in a source
  checkout (the token is injected only at npm publish), so `install` /
  `doctor --deep` emit their `cli` spans.
- `DEPLOYMENT_ENVIRONMENT=test` — stamps **all** of the run's smoke telemetry
  (CLI, plus the edge `api` spans for every REST/MCP request the smokes make)
  with `deployment.environment.name=test`, so synthetic smoke traffic filters
  apart from real usage — including the production smoke, which runs against the
  production deployment. The mechanism (a forwarded `X-LoreKit-Deployment-Environment`
  header the edge honours only for the value `test`) is documented in
  [docs/otel.md](./otel.md) → "Smoke / test runs are tagged".
- `LOREKIT_CORRELATION_ID` — a per-run key on every REST call's
  `usage_events.correlation_id`, so one run's calls are greppable.

`ci.yml`'s integration job runs against a throwaway **local** Supabase. A plain
`supabase start` gives the edge no OTLP endpoint, so it would be dark — the
"Configure local edge OTLP export" step therefore writes `supabase/functions/.env`
(the file the CLI loads into the local edge runtime) with the Dash0 ingress
endpoint + ingest token, so the local `api` spans **do** export, tagged `test`.
Fork PRs have no secret, so that step self-skips and the edge stays dark — a
graceful no-export, never a broken start.

### Smoke-test data hygiene

The smoke suites write to **real projects** — the preview/staging project in
`smoke-preview`, and (via `doctor --deep`) production itself. Every row they
create is a row in a live tenant, so cleanup is part of the contract, not an
afterthought. It has two layers, because one hook cannot cover both failure
modes:

| Layer | Covers | Where |
|-------|--------|-------|
| **Self-cleanup** — each suite hard-deletes everything it minted in `afterAll` | a suite that FAILED partway through | `packages/mcp-server/src/smoke-cleanup.ts` + each `*.integration.spec.ts` |
| **Orphan sweep** — deletes leftovers from earlier runs, matched by name pattern and age | a run that never reached `afterAll` (crash, OOM, cancelled workflow, job timeout) | `scripts/smoke-cleanup.mjs`, run as an `if: always()` step after every smoke job |

Two rules make the difference between "cleaned up" and "looks cleaned up":

- **Deletes must be hard deletes.** `memory.delete` and `DELETE /memories`
  default to a soft *archive*, and `DELETE /orgs/:slug` maps to
  `lorekit_org_delete`, a soft delete since migration 00025. Both leave the row
  in the table. Cleanup therefore passes `force=true` for memories and calls
  `lorekit_org_purge` for orgs.
- **Every artefact name is minted through `createSmokeNamespace`**, which
  registers it at mint time. Cleanup sweeps the registry, so a key created by a
  test that threw before recording its id is still removed — and the sweeper
  recognises the name later if the process died first.

Run the sweep by hand against any project:

```bash
LOREKIT_REST_BASE_URL="https://<ref>.supabase.co/functions/v1" \
LOREKIT_SMOKE_TOKEN="<lk_rw_* token>" \
LOREKIT_SMOKE_JWT="<supabase user JWT>" \
  node scripts/smoke-cleanup.mjs --dry-run
```

Drop `--dry-run` to delete. `--min-age-minutes` (default 30) protects a smoke
run that is still in flight; artefacts younger than that are left alone, judged
by the server's timestamp rather than the client-minted name so a skewed runner
clock cannot make a live run look sweepable.

Use the same `lk_rw_*` token as `LOREKIT_SMOKE_TOKEN` here, **not** the
service-role key. Service-role bypasses RLS and every handler's tenant filter,
so a sweep on it spans every tenant in the project; the script refuses such a
credential unless `--allow-service-role` is passed (CI does, against the
throwaway local stack, where there is only one tenant).

#### Wiring the sweep into CI (one-time, must be committed by a human)

The GitHub App that opens automated PRs cannot modify `.github/workflows/**`
(no `workflows` permission), so the three steps below are **not** applied by the
PR that added the sweeper — add them by hand. Everything else (the suites'
self-cleanup, the script) works without them; these are what make the orphan
sweep run automatically.

**1. `ci.yml` → `integration` job**, after `Smoke — REST API (memories + orgs)
against the live stack`. This is the only place the sweeper itself is exercised
on every PR, so a regression in it fails here rather than silently no-opping
against staging for months. `--allow-service-role` is safe (and required) here
because the local stack is a single-tenant throwaway; `--strict` is safe because
nothing downstream rolls back on this job.

```yaml
      - name: Smoke cleanup — sweep leftover artefacts (self-test of the sweeper)
        if: always()
        env:
          LOREKIT_SMOKE_TOKEN: ${{ steps.supabase.outputs.service_role_key }}
          LOREKIT_SMOKE_JWT: ${{ steps.smokejwt.outputs.jwt }}
          LOREKIT_SWEEP_SERVICE_ROLE_KEY: ${{ steps.supabase.outputs.service_role_key }}
          LOREKIT_REST_BASE_URL: http://127.0.0.1:54321/functions/v1
        run: node scripts/smoke-cleanup.mjs --min-age-minutes 0 --allow-service-role --strict
```

**2. `deploy.yml` → `smoke-preview` job**, as the last step. `if: always()` is
the point — the runs that leak are exactly the ones where an earlier step failed.
No `--strict`: cleanup must never red a deploy.

```yaml
      - name: Smoke cleanup — sweep orphaned artefacts from preview
        if: always()
        env:
          LOREKIT_REST_BASE_URL: https://${{ secrets.SUPABASE_PROJECT_REF }}.supabase.co/functions/v1
          LOREKIT_SMOKE_TOKEN: ${{ secrets.LOREKIT_SMOKE_TOKEN }}
          LOREKIT_SMOKE_JWT: ${{ steps.smokejwt.outputs.jwt }}
        run: node scripts/smoke-cleanup.mjs --min-age-minutes 30
```

**3. `deploy.yml` → `smoke-production` job**, as the last step — **report-only**.
Nothing in that job mints smoke artefacts (the `doctor --deep` probe uses a fixed
key the pattern deliberately does not match, and force-deletes it in a `finally`),
so a non-empty plan here is a signal to act on, not something to delete inside a
job whose failure triggers `rollback-production`. `--dry-run` +
`continue-on-error` keep it unable to influence the deploy outcome.

```yaml
      - name: Smoke residue check — report anything left in production
        if: always()
        continue-on-error: true
        env:
          LOREKIT_REST_BASE_URL: https://${{ secrets.SUPABASE_PROJECT_REF }}.supabase.co/functions/v1
          LOREKIT_SMOKE_TOKEN: ${{ secrets.LOREKIT_SMOKE_TOKEN }}
        run: node scripts/smoke-cleanup.mjs --min-age-minutes 30 --dry-run
```

**Historical residue.** Orgs that earlier runs *soft*-deleted are invisible to
every RLS read (`lorekit_member_org_ids` filters them out), so no API surface can
list them. Set `LOREKIT_SWEEP_SERVICE_ROLE_KEY` to the project's service-role key
**and pass `--allow-service-role`** — that phase reads and deletes across every
tenant in the project, so holding the key and intending a cross-tenant delete are
kept as two separate claims:

```bash
LOREKIT_REST_BASE_URL="https://<ref>.supabase.co/functions/v1" \
LOREKIT_SWEEP_SERVICE_ROLE_KEY="<service-role key>" \
  node scripts/smoke-cleanup.mjs --allow-service-role --dry-run
```

This is a one-off cleanup — the suites no longer create them.

### Environments and secrets

The pipeline targets **two Supabase projects** (a dedicated preview project +
production) via GitHub **Environments** (Settings ▸ Environments). Secrets share
the same *names* across environments; the `environment:` on each job selects the
right values:

| Secret | `preview` environment | `production` environment |
|--------|-----------------------|--------------------------|
| `SUPABASE_PROJECT_REF` | preview project ref | production project ref |
| `SUPABASE_DB_PASSWORD` | preview DB password | production DB password |
| `LOREKIT_SMOKE_TOKEN` | preview `lk_rw_*` token | production `lk_rw_*` token |

> `LOREKIT_SMOKE_TOKEN` should be an **`lk_rw_*`** token, not the service-role
> key. The CLI `doctor --deep` write round-trip only runs for a read+write
> `lk_*` token; a service-role key (or a JWT) classifies as an unrecognized
> prefix and the round-trip **silently skips**, so the write path goes untested.
>
> Trade-off to name explicitly: with an `lk_rw_*` token, the REST smoke's
> **`audit_log` read-back** sub-assertions self-skip — reading `audit_log`
> directly needs the service-role key (RLS bypass) or a user JWT (its own
> rows), which an `lk_*` API token is not. The CRUD/write path is still fully
> exercised; only the "was an audit row written" verification is traded away.
> The orgs audit read-back runs off `LOREKIT_SMOKE_JWT` (a user JWT) and is
> unaffected.

**Optional — the orgs REST smoke suite (`smoke-preview` only).** Unset → the
suite is announced-skipped and the memories suite still runs; the deploy is
never blocked. Set all three to enable it:

| Secret | `preview` environment |
|--------|-----------------------|
| `SUPABASE_ANON_KEY` | preview anon (publishable) key |
| `LOREKIT_SMOKE_EMAIL` | fixed smoke user's email |
| `LOREKIT_SMOKE_PASSWORD` | fixed smoke user's password |

The org endpoints require a real Supabase **user JWT** (`lk_*` tokens and the
service-role key are rejected), so `smoke-preview` mints one per run by signing
in as this fixed user. That user must already exist on the project —
seed it once with [`scripts/seed-smoke-user.mjs`](#seed-the-orgs-smoke-user)
below.

Repo-level secrets (not environment-scoped): `SUPABASE_ACCESS_TOKEN` (a Supabase
personal access token); the three **Vercel** secrets the web jobs use —
`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (the same set `preview.yml`
already relies on); `LOREKIT_TELEMETRY_TOKEN` (the Dash0 ingest-only token — the
smoke jobs pass it so their telemetry exports; see [Smoke telemetry](#smoke-telemetry-observable-in-dash0-tagged-test),
and it is also injected into the CLI tarball at publish by `release.yml`); and —
optionally — `DISCORD_WEBHOOK_URL` for
[failure notifications](#failure-notifications-discord). Add a **required
reviewer** on the `production` environment for a manual approval gate before prod
is touched — it now gates the web promote (`promote-web-production`) as well as
the API deploy.

Repo-level **variables** (Settings ▸ Secrets and variables ▸ Actions ▸
Variables), both optional:

- `WEB_PROD_URL` — the production dashboard origin the production smoke curls.
  Defaults to `https://lorekit.io`; set it for a self-hosted fork on a different
  domain.
- `VERCEL_SCOPE` — the Vercel **team slug** that `vercel promote` / `vercel
  rollback` run under. Defaults to `mads-thines-projects` (this project's team,
  matching the hardcoded `VERCEL_SCOPE` in `packages/mcp-core/src/cors-origins.ts`).
  **A fork MUST set this to its own team slug** — `promote`/`rollback` ignore the
  token's team and the linked project ([Vercel bug #11712](https://github.com/vercel/vercel/issues/11712)),
  so an unset value would try to promote into `mads-thines-projects` and 403.

#### Seed the orgs-smoke user

The orgs smoke signs in as a fixed user; it never creates one (a smoke run must
not provision users in a real tenant). Create that user **once per project**
with the idempotent seed script — it creates + email-confirms the user, resets a
drifted password on re-run, and verifies the sign-in works end-to-end before
exiting 0:

```bash
SUPABASE_URL=https://<preview-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<preview-service-role-key> \
LOREKIT_SMOKE_EMAIL=<email> \
LOREKIT_SMOKE_PASSWORD='<password>' \
  node scripts/seed-smoke-user.mjs
```

Run it from a trusted admin shell — **not in CI**. Creating a confirmed user
needs the service-role key (the Auth admin API), which the recurring deploy
smoke path deliberately does not carry; CI only ever uses the anon key +
email/password to mint the JWT. Re-run with the production ref + key to seed the
production project too.

### Recommended branch protection

Require a PR to `main` and mark the single **`CI Summary`** job as the required
status check. It aggregates every job above — `Typecheck, Test & Lint
(affected)`, `Integration smoke (local Supabase)`, `Plugin smoke`, and
`Migration order (no out-of-order prefixes)` — into one pass/fail verdict.
Require **`CI Summary`** rather than those jobs directly: it always runs
(`if: always()`) and collapses every job — including the path-gated ones that
skip on unrelated PRs — into one definite pass/fail, so branch protection needs
exactly one check and you never have to reason about how a *skipped* path-gated
check is counted (GitHub's handling of that is inconsistent, which is the whole
reason the aggregating job exists). Because `deploy.yml` no longer re-runs
tests, this check is the sole gate that keeps unverified (or migration-breaking)
code off `main`.

Also enable **"Require branches to be up to date before merging."** It is what
closes the last migration-ordering gap: the `migration-order` guard
(below) rejects a PR whose new migration is numbered at or below `main`'s
highest, but two PRs branched from the same base can each pass in isolation and
still collide once both merge. Requiring an up-to-date branch forces the second
to rebase — at which point the guard sees the now-merged higher number and
fires.

#### Migration ordering (sequential prefixes + parallel PRs)

Migrations use sequential integer prefixes (`00042_…`), which **do not survive
parallel PRs**: each branch picks "the next number" from its own base, so two
concurrent PRs can merge a lower number *after* a higher one is already live.
`supabase db push` then aborts on the next deploy with *"migration files to be
inserted before the last migration on remote"* — which is exactly what happened
when `#260` shipped `00042` and `#266` then shipped `00041`.

Two layers keep this from wedging the deploy:

1. **Prevention — the `migration-order` CI job** (`scripts/check-migration-order.mjs`)
   fails any PR that adds a migration numbered ≤ the highest already on the base
   branch, telling the author the next free number to rebase-and-renumber to.
2. **Tolerance — `supabase db push --include-all`** in `deploy.yml` applies an
   already-reviewed, CI-tested migration even if it sorts before one already on
   the remote (migrations still apply in on-disk numeric order). This unwedges
   the grandfathered `00041`/`00042` pair and any future edge case the guard
   didn't pre-empt.

The collision-proof end state is Supabase's **timestamp filenames**
(`YYYYMMDDHHMMSS_…`), which are monotonic and parallel-safe — a larger,
rename-everything change to consider separately.

---

## Prerequisites

1. A Supabase project ([supabase.com](https://supabase.com) → New project)
2. GitHub OAuth app for authentication
3. A Vercel project connected to this repository
4. Supabase CLI installed: `npm install -g supabase`

---

## 1. Link to your Supabase project

```bash
supabase link --project-ref pqokxlhvnosogizsjztg
```

Your project ref is the subdomain of your Supabase URL: `https://pqokxlhvnosogizsjztg.supabase.co`.

---

## 2. Apply database migrations

```bash
pnpm nx db:push supabase
# or directly:
supabase db push --project-ref pqokxlhvnosogizsjztg
```

This applies all migrations in `supabase/migrations/` in order, creating all required tables (`memories`, `api_tokens`, `user_limits`, `plans`, `orgs`, `org_members`, `org_invites`, `org_scope_bindings`, `webhook_secrets`, `audit_log`, `usage_events`, and others).

---

## 3. Configure GitHub OAuth

1. Create an OAuth app at [github.com/settings/developers](https://github.com/settings/developers):
   - **Callback URL:** `https://pqokxlhvnosogizsjztg.supabase.co/auth/v1/callback`
2. In Supabase → Auth → Providers → GitHub: enable and paste Client ID + Secret

---

## 4. Set Supabase secrets

```bash
supabase secrets set \
  SUPABASE_URL=https://pqokxlhvnosogizsjztg.supabase.co \
  SUPABASE_ANON_KEY=<publishable-key> \
  SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  OTEL_EXPORTER_OTLP_ENDPOINT=https://ingress.europe-west4.gcp.dash0-dev.com \
  OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <DASH0_AUTH_TOKEN>" \
  VERCEL_ENV=production \
  LOREKIT_APP_URL=https://lorekit.io \
  --project-ref pqokxlhvnosogizsjztg
```

> `LOREKIT_APP_URL` is the dashboard origin the MCP server links to in
> cap/rate-limit messages. Optional — it defaults to `https://lorekit.io`;
> override it only for a staging/custom deploy.

> `LOREKIT_EMBEDDING_*` are not needed here either. Embedding is **off by
> default** and is enabled separately, on demand — see
> [embeddings.md](./embeddings.md). Setting only the API key does nothing; the
> `LOREKIT_EMBEDDING_ENABLED` flag is the deliberate second half.

> `GITHUB_WEBHOOK_SECRET` is not needed here — webhook secrets are
> per-repository, generated by end users from the dashboard's webhook
> onboarding step. The env var is a legacy fallback only.

---

## 5. Deploy Edge Functions

```bash
# Deploy both functions (typecheck runs first via NX):
pnpm nx fn:deploy supabase

# Or directly:
supabase functions deploy mcp --project-ref pqokxlhvnosogizsjztg
supabase functions deploy health --no-verify-jwt --project-ref pqokxlhvnosogizsjztg
```

**Note:** `health` is deployed with `--no-verify-jwt` so uptime monitors can call it without authentication.

---

## 6. Configure Vercel

In your Vercel project → Settings → General:

| Setting | Value |
|---------|-------|
| Root Directory | `packages/web` |
| Build Command | `cd ../.. && pnpm nx build web --configuration=production` |
| Output Directory | `.next` |
| Install Command | `cd ../.. && pnpm install` |

> **Vercel Git auto-deploy is off.** `packages/web/vercel.json` sets
> `git.deploymentEnabled = false`, so Vercel deploys nothing on a Git push —
> `deploy.yml` promotes production (see [FE ↔ API deploy in lockstep](#fe--api-deploy-in-lockstep-no-availability-skew))
> and `ci.yml`'s `web-preview` job deploys PR previews, gated on the `web` path
> filter so unrelated PRs spend no quota. This also disables the dashboard's
> Ignored Build Step approach, which still created (quota-counting) deployments
> even when it skipped the build. Create a **Vercel access token**
> (Account Settings → Tokens) and store it as the repo secret `VERCEL_TOKEN`,
> alongside `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` (found in `.vercel/project.json`
> after `vercel link`, or in the project's Settings). These three secrets are
> repo-level, so `ci.yml`'s `web-preview` job reads them on PR runs (a fork PR
> with no access self-skips green).

Environment variables to add:

```
NEXT_PUBLIC_SUPABASE_URL          https://pqokxlhvnosogizsjztg.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY     <publishable-key>
NEXT_PUBLIC_SUPABASE_PROJECT_REF  pqokxlhvnosogizsjztg
NEXT_PUBLIC_APP_URL               https://lorekit.io
NEXT_PUBLIC_DASH0_OTLP_ENDPOINT   https://ingress.europe-west4.gcp.dash0-dev.com
NEXT_PUBLIC_DASH0_AUTH_TOKEN      <ingesting-only-dash0-token>

OTEL_EXPORTER_OTLP_ENDPOINT       https://ingress.europe-west4.gcp.dash0-dev.com
OTEL_EXPORTER_OTLP_HEADERS        Authorization=Bearer <DASH0_AUTH_TOKEN>

# Optional — org invite emails via Resend. Unset → invites are in-app only.
# Verify the sending domain (lorekit.io) in Resend before setting these.
RESEND_API_KEY                    re_<your-resend-api-key>
RESEND_FROM                       LoreKit <invites@lorekit.io>
```

> `NEXT_PUBLIC_APP_URL` is the custom domain (`https://lorekit.io`). For a
> self-hosted fork use your own domain or the `<your-project>.vercel.app` URL.

Also add your domain to Supabase → Auth → URL Configuration:
- Site URL: `https://lorekit.io`
- Redirect URLs: `https://lorekit.io/api/auth/callback`

---

## 7. Set up the GitHub webhook (optional)

For LoreKit to learn from PR review comments. Webhook secrets are
**per-repository**:

1. Web dashboard → Overview → **Set up the GitHub webhook** → add the repo
   (`owner/repo`) under **Webhook secrets** and copy the generated secret
2. Repo → Settings → Webhooks → Add webhook
3. Payload URL: `https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp/webhooks/github`
4. Content type: `application/json`
5. Secret: the value you copied in step 1
6. Events: **Pull request review comments** + **Pull request reviews**

---

## NX deploy targets

All Supabase operations have NX targets (requires `SUPABASE_PROJECT_REF` in `.env.local`):

```bash
pnpm nx deploy supabase    # typecheck + test → db push → fn:deploy
pnpm nx db:push supabase   # just push migrations
pnpm nx fn:deploy supabase # just deploy functions
pnpm nx health supabase    # curl /health endpoint
pnpm nx db:types supabase  # generate TypeScript types from DB schema
```
