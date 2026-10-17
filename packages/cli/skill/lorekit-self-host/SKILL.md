---
name: lorekit-self-host
description: >
  Guided runbook for deploying your OWN LoreKit backend instead of using the
  hosted service — full self-host (your Supabase project runs everything) or
  self-host + BYOD (memory rows live in a second Supabase project you
  control). Walks Supabase link → migrate → secrets → deploy-all-functions →
  dashboard/token → connect-your-agent → write/read round-trip, each step a
  gate: do the thing, verify it, stop and diagnose if the verification fails.
  Links out to docs/install.md and docs/byod.md rather than duplicating their
  commands. Slash-only — not installed by `lorekit install`, and never reads
  or writes a lesson itself. Use when deploying your own LoreKit instance, not
  for everyday read/write (see lorekit-memory) or store maintenance (see
  lorekit-groom). Triggers ONLY on explicit invocation:
  "/lorekit-self-host".
user-invocable: true
disable-model-invocation: true
argument-hint: '[full|byod]'
license: MIT
metadata:
  author: mthines
  version: '1.0.0'
  workflow_type: self-host-deployment-runbook
  tags:
    - lorekit
    - self-host
    - supabase
    - byod
    - setup
---

# LoreKit Self-Host

A guided runbook for running your own LoreKit backend. Every step below is a
gate: **do** the thing, **verify** it, and **stop and diagnose** before moving
on if the verification fails. This skill links to the canonical docs instead
of copying their commands, so it never drifts from them:

- Full install reference: [docs/install.md](https://github.com/mthines/lorekit/blob/main/docs/install.md)
- BYOD reference: [docs/byod.md](https://github.com/mthines/lorekit/blob/main/docs/byod.md)

**Never echo a token, API key, or service-role key value** in any command
output you show the user — redact it, or reference the env var name only.

## Step 0 — Choose your setup

| Setup | What you run | Memory rows live in | Dashboard/REST/hooks see them? |
| ----- | ------------ | -------------------- | ------------------------------- |
| Hosted (default) | Nothing — use `lorekit.io` | LoreKit's hosted project | Yes |
| Full self-host | Your own Supabase project, all 8 Edge Functions | Your project's own DB | Yes |
| Self-host + BYOD | Your function project **plus** a second Supabase project for storage | The second (storage) project's DB | **No** — the dashboard, REST API, remote CLI commands, and hooks all read the **function project's own DB**, never the BYOD storage project |

If the user only wants the hosted service, **stop here** and point them at
`npx @lorekit/cli install` — nothing below applies.

**Recommendation: choose full self-host unless your memory rows must live in
a separate database** (data residency, an existing Supabase subscription you
want billed separately, or org policy). BYOD is full self-host **plus** a
second storage project layered on top — the hosted endpoint has no BYOD, and
BYOD is never a substitute for deploying your own function project; it only
changes where rows are written. State this trade-off to the user before
proceeding so they pick the right branch of this runbook (`full` or `byod` —
matches this skill's argument hint).

## Step 1 — Prerequisites

Follow [docs/install.md § Prerequisites](https://github.com/mthines/lorekit/blob/main/docs/install.md#prerequisites):
Node ≥ 18, pnpm, the Supabase CLI, Git, and a Supabase project (create one at
https://supabase.com if you don't have one yet).

**Verify:** `node -v`, `pnpm -v`, `supabase -v`, `git --version` all print a
version. **On failure:** install the missing tool per the Prerequisites table
before continuing.

## Step 2 — Link your Supabase project

Follow [docs/install.md § Step 2](https://github.com/mthines/lorekit/blob/main/docs/install.md#step-2--link-to-your-supabase-project):
`supabase link --project-ref <your-project-ref>`, then write
`SUPABASE_PROJECT_REF=<your-project-ref>` into `.env.local`.

**Verify:** `supabase projects list` shows your project, and the link command
exits 0. **On failure:** re-check the project ref (the subdomain of your
Supabase project URL) and that you're logged in (`supabase login`).

## Step 3 — Apply database migrations

Follow [docs/install.md § Step 3](https://github.com/mthines/lorekit/blob/main/docs/install.md#step-3--apply-database-migrations):
`pnpm nx db:push supabase`.

**Verify:** the command exits 0 and `supabase migration list` shows no
pending migrations. **On failure:** read the migration error — a partially
applied migration usually needs a manual fix before re-running `db:push`.

## Step 4 — Set Edge Function secrets

Follow [docs/install.md § Step 5](https://github.com/mthines/lorekit/blob/main/docs/install.md#step-5--set-supabase-edge-function-secrets).
Required: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
Optional: `ALLOWED_ORIGINS` (only if you deploy your own dashboard on a
non-`lorekit.io` domain — otherwise its REST calls are CORS-blocked), and the
Dash0/OTel variables (telemetry only, safe to skip).

**Verify:** `supabase secrets list --project-ref <your-project-ref>` lists
the three required names (never print their values). **On failure:** re-run
`supabase secrets set` with the correct project ref.

## Step 5 — Deploy ALL Edge Functions

The project ships 8 Edge Functions (`mcp`, `health`, `memories`, `orgs`,
`openapi`, `blog`, `profiling`, `groom-sweep`). `pnpm nx fn:deploy supabase`
only deploys `mcp` + `health` — that leaves the `memories` function (used by
hooks, the remote CLI commands, and the dashboard's REST API) undeployed.
Deploy every function instead:

```bash
supabase functions deploy --no-verify-jwt --project-ref <your-project-ref>
```

**Verify, in order:**

1. Health check: `curl https://<your-project-ref>.supabase.co/functions/v1/health`
   must return HTTP 200 with `"status":"ok"` and `"db":"ok"`. A 503 with
   `"status":"degraded"` and `"db":"error"` means the function can't reach the
   DB — recheck the secrets from Step 4.
2. `memories` deployed: `curl -s -o /dev/null -w '%{http_code}' https://<your-project-ref>.supabase.co/functions/v1/memories`
   must return `401` (deployed, auth required). A `404` means the function
   wasn't deployed — re-run the deploy command above; it deploys every
   function found under `supabase/functions/`.

**On failure:** check `supabase functions list --project-ref <your-project-ref>`
for which functions actually deployed, and re-run the command.

## Step 6 (BYOD only) — Point the function project at your storage project

Skip this step for full self-host.

1. Create a second Supabase project for storage (or reuse an existing one).
2. Apply the LoreKit schema to it by following
   [docs/byod.md § Apply the LoreKit schema](https://github.com/mthines/lorekit/blob/main/docs/byod.md#2-apply-the-lorekit-schema) —
   this runbook does not duplicate those commands since they vary by
   revision; follow what that doc (and `lorekit bootstrap` itself) prints.
3. Set `LOREKIT_STORAGE_URL`, `LOREKIT_STORAGE_ANON_KEY`, AND
   `LOREKIT_STORAGE_SERVICE_KEY` as **Edge Function secrets on the function
   project** (`supabase secrets set ... --project-ref <your-function-project-ref>`)
   — NOT in `.mcp.json`. An older `docs/byod.md` revision may say to put
   these in `.mcp.json`; that env never reaches the edge function, only your
   local MCP client process, so it has no effect on a deployed function.
4. `lorekit bootstrap` and `lorekit doctor` read `LOREKIT_STORAGE_*` from
   your **local shell**, not from the Edge Function secrets set in 6.3 — so
   pass them inline, matching docs/byod.md:

   ```bash
   LOREKIT_STORAGE_URL=https://<storage-ref>.supabase.co \
   LOREKIT_STORAGE_SERVICE_KEY=<storage-service-role-key> \
   lorekit bootstrap

   LOREKIT_STORAGE_URL=https://<storage-ref>.supabase.co \
   LOREKIT_STORAGE_ANON_KEY=<storage-anon-key> \
   lorekit doctor
   ```

   Without those vars in the shell, `doctor` silently skips the BYOD check.

**Caveat — repeat this to the user:** the dashboard, REST API, remote CLI
commands, and hooks all read the **function project's own DB**. They do
**not** see rows written to the BYOD storage project. There is no dashboard
view into BYOD data — it is intentionally invisible to everything except the
`memory.*` MCP tools and the `lorekit` CLI talking directly to that endpoint.

**Verify:** the inline-env `lorekit doctor` run from 6.4 prints a **passing**
`byod storage` line. No `byod storage` line at all means the check was
skipped — the vars weren't set in that shell; re-run with them inline.
**On failure:** check the storage URL/anon key you passed, that the schema
from Step 6.2 applied cleanly, and that all three secrets are set on the
function project (not the storage project).

## Step 7 — Dashboard and API token

A token must be minted on a dashboard connected to **your** project — a token
minted on `lorekit.io` only authenticates the hosted project and will not work
against your self-hosted deployment.

Either:

- Deploy your own dashboard (follow
  [docs/install.md § Step 8](https://github.com/mthines/lorekit/blob/main/docs/install.md#step-8--deploy-the-web-dashboard-optional)), or
- Run it locally against your project: set `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `packages/web/.env.local` to your
  project's values, add `http://localhost:4200/api/auth/callback` to
  Supabase → Auth → URL Configuration → Redirect URLs, then `pnpm nx serve web`
  (it listens on port 4200).

Then, in that dashboard: **Lore Explorer → Step 2: Connect your agent →
Generate new token**. Choose Read + Write (`lk_rw_`), Read only (`lk_ro_`), or
Write only (`lk_wo_`). Copy it — it is shown once.

**Verify:** the token modal shows a token in the format `lk_rw_<32 chars>` (or
`lk_ro_`/`lk_wo_`). **On failure:** confirm the dashboard's Supabase env vars
point at your project, not the hosted one.

## Step 8 — Connect your agent

```bash
npx @lorekit/cli install --endpoint https://<your-project-ref>.supabase.co/functions/v1/mcp --token <your-token>
```

(or export `LOREKIT_MCP_URL=https://<your-project-ref>.supabase.co/functions/v1/mcp`
and `LOREKIT_TOKEN` instead of passing `--endpoint`/`--token` each time).

**Warning:** any `lorekit install` that writes the MCP entry **without**
`--endpoint` — a `--force` reinstall, a new project, a global install, or a
project whose `.mcp.json` lost its LoreKit entry — uses the hosted URL
hardcoded in `install.mjs` when neither the `LOREKIT_MCP_URL` nor the
`LOREKIT_ENDPOINT` env var is set. (A plain re-run on an already-installed
project leaves `.mcp.json` untouched.) Always pass `--endpoint`, or export
`LOREKIT_MCP_URL` in your shell profile, on every install.

**Verify:** `npx @lorekit/cli doctor` shows your endpoint and reports
connectivity + authentication passing, **and** that endpoint line ends in
`/functions/v1/mcp`. Check the suffix yourself: `doctor` probes over REST,
which drops the `/mcp` suffix, so an endpoint missing it still passes
`doctor` while the agent's MCP client gets a 404. Step 9 is the real MCP
check. **On failure:** re-check the endpoint
URL (must end in `/functions/v1/mcp`) and that the token matches the
permission tier the connection needs.

## Step 9 — Write/read round-trip

Write a `global` test lesson, read it back, then delete it:

```json
memory.write { scope: "global", key: "self-host-test", value: "It works." }
memory.read  { scope: "global", key: "self-host-test" }
memory.delete { scope: "global", key: "self-host-test" }
```

`memory.delete` archives the lesson (`"archived":true`); a later
`memory.read` returns `null`.

**Verify:** the read returns the value you wrote. **For BYOD**, also confirm
the row landed in the **storage project's** `memories` table — not the
function project's — since that is the whole point of the BYOD layering.
**On failure:** re-check Step 8's endpoint/token, and for BYOD, re-check Step
6's secrets.

## Never

- Never print or echo a token, API key, or service-role key value.
- Never apply the BYOD storage-only schema steps from docs/byod.md to the
  function project's own database — they only ever go on the separate
  storage project; the function project gets the Step 6.3 secrets only.
- Never point a self-hosted deployment's agent connection at the hosted
  endpoint, and never assume a `lorekit.io`-minted token works against it.
