# Deployment

LoreKit has three deployable pieces. Each has its own deployment path.

## Overview

| Piece | Platform | Deploy command |
|-------|----------|----------------|
| MCP server + health check | Supabase Edge Functions | `pnpm nx fn:deploy supabase` |
| Web dashboard | Vercel | Auto-deploy on `git push main` |
| Database migrations | Supabase | `pnpm nx db:push supabase` |

**In normal operation you do not run these by hand.** Merging to `main` triggers
the [automated CI/CD pipeline](#automated-deployment-cicd), which promotes
migrations + Edge Functions **preview → production** with smoke gates and
automatic function rollback. The manual commands below are for first-time
project setup and local operations.

---

## Automated deployment (CI/CD)

Two GitHub Actions workflows own the lifecycle:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `.github/workflows/ci.yml` | PRs to `main` | **Verify before merge.** `check` (affected typecheck/test/lint — unit tests, all mocked) and `integration` (boots a local Supabase → migrations apply → serves the real Edge Functions → asserts an authenticated MCP `tools/list` returns 200, plus schema lint). `integration` only runs when API/backend paths change (see [below](#only-runs-when-relevant)); the web build is verified by Vercel's own PR check. |
| `.github/workflows/deploy.yml` | push to `main`, `workflow_dispatch` | **Deploy the already-verified commit.** No test re-run — preview-first promotion only. |

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

### The deploy pipeline (on merge to `main`)

Each job `needs:` the previous one, so a red step is a hard gate — nothing
downstream runs:

```
deploy-preview          db push + functions deploy → PREVIEW project
  └─▶ smoke-preview      smoke.integration spec against PREVIEW
        └─▶ deploy-production     db push + functions deploy → PRODUCTION project
              └─▶ smoke-production   health + MCP tools/list against PRODUCTION
                    └─▶ rollback-production   (only on failure)

any job fails ─▶ notify-failure   Discord webhook (see below)
```

Production is never touched until preview has been deployed and smoke-tested.

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

#### Wiring the classifier into the workflows

Like the smoke sweeper above, **the workflow steps are documented, not
committed** — the GitHub App that opens automated PRs has no `workflows`
permission, so a human applies these three edits once.

**1.** In `.github/workflows/deploy.yml`, in the **`deploy-preview`** job only,
replace the `Push database migrations` step with the following (the
`deploy-production` job is left exactly as it is):

```yaml
      - name: Set up Node.js (for the migration-drift classifier)
        uses: actions/setup-node@v7
        with:
          node-version: 20

      # `preview` is a SHARED Supabase project, and preview.yml ALSO pushes
      # migrations to it — from an OPEN PR's head SHA, on a `/preview` comment.
      # So its migration history can legitimately carry versions that do not
      # exist on this ref yet, and `supabase db push` treats a remote that is
      # merely AHEAD as fatal even when this ref has nothing left to apply.
      # Classify the drift first and react proportionally; this step never
      # repairs or mutates the remote's migration history.
      - name: Classify migration drift against preview
        id: drift
        run: |
          # Tolerate a non-zero exit here: the classifier decides, not the CLI.
          # A listing it cannot parse yields `push` — the previous behaviour,
          # error message included.
          supabase migration list --linked > /tmp/migration-list.txt 2>&1 || true
          cat /tmp/migration-list.txt
          node scripts/check-remote-migration-drift.mjs < /tmp/migration-list.txt

      - name: Push database migrations
        if: steps.drift.outputs.action == 'push'
        # --include-all applies a migration even when a LOWER-numbered file was
        # merged after a higher-numbered one already reached this remote — which
        # happens when parallel PRs pick colliding sequential prefixes (e.g.
        # #260 shipped 00042, then #266 shipped 00041). Without it `db push`
        # aborts with "migration files to be inserted before the last migration
        # on remote". Migrations are still applied in on-disk numeric order; the
        # PR-time guard (scripts/check-migration-order.mjs, the `migration-order`
        # CI job) is what stops an out-of-order file from landing in the first
        # place, so this flag only ever applies already-reviewed, CI-tested ones.
        run: supabase db push --include-all
```

**2.** In `.github/workflows/ci.yml`, widen the `migrations` path filter in the
`changes` job so a change to the classifier or its test triggers the gate:

```yaml
          if printf '%s\n' "$CHANGED" | grep -qE '^(supabase/migrations/|scripts/check-migration-order|scripts/check-remote-migration-drift|\.github/workflows/ci\.yml)'; then
```

**3.** In the same file, add a second self-test to the `migration-order` job,
right after `Unit-test the guard`:

```yaml
      # The deploy-time counterpart: the PR-time guard above stops an
      # out-of-order file from landing, while the drift classifier decides what
      # deploy.yml does when the SHARED preview project's migration history is
      # ahead of the ref being deployed. Its verdict gates a `supabase db push`,
      # so it is unit-tested here too.
      - name: Unit-test the remote-migration-drift classifier
        run: node --test scripts/check-remote-migration-drift.test.mjs
```

Until step 1 is applied, the classifier ships but is not wired in, and a
`/preview` run on an open PR that adds migrations will keep wedging `main`'s
deploy. The interim manual unblock is to run the classifier's own advice:
confirm nothing is pending locally, then let the next deploy through by
repairing the drifted rows on the preview project.

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
commit's** Edge Functions and fails the run loudly with a step summary.
Database migrations are **forward-only** and intentionally *not* reverted —
keep migrations backward-compatible (expand/contract) and enable **PITR**
(Point-in-Time Recovery) in the Supabase dashboard as the database safety net.

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
personal access token) and — optionally — `DISCORD_WEBHOOK_URL` for
[failure notifications](#failure-notifications-discord). Add a **required
reviewer** on the `production` environment for a manual approval gate before prod
is touched.

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
