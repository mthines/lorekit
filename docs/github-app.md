# GitHub App integration

The LoreKit GitHub App replaces the per-repo manual webhook-secret setup with
a zero-configuration alternative: install the App once on a repo (or org) and
every webhook delivery is verified with a single shared secret, with no extra
steps per repository.

---

## How it works

### Current per-repo flow (manual)

```
User → Dashboard → generate 32-byte secret → webhook_secrets table
                                           → paste into GitHub webhook settings
```

Each repo needs its own secret.  The edge function looks up the secret by
`repository.full_name` on every delivery.

### GitHub App flow (new)

```
User → GitHub Marketplace / App install → GitHub delivers installation event
                                        → LoreKit records installation + repos
                                        → all deliveries verified against ONE app secret
```

The App path is gated behind `GITHUB_APP_ENABLED`.  Until that flag is set and
the App's secrets are provisioned, the handler behaves exactly as today.

---

## Architecture

### Webhook routing decision

```
Incoming delivery
├── GITHUB_APP_ENABLED = true AND event is App event
│   ├── installation lifecycle (installation / installation_repositories / …)
│   │   → verify HMAC against GITHUB_APP_WEBHOOK_SECRET
│   │   → reconcileAppInstallation (event→action mapping, DB upsert)
│   │   → 200 OK
│   └── comment event (issue_comment / pull_request_review*)
│       → verify HMAC against GITHUB_APP_WEBHOOK_SECRET
│       → existing candidate-write path (source::pr-webhook) — unchanged
│       → 200 OK / 500
└── per-repo path (flag off, or non-App delivery)
    → resolve secret: webhook_secrets (db_repo → db_legacy → env)
    → existing path — UNCHANGED
```

### Data model (`00037_github_installations.sql`)

| Table | Key columns | Purpose |
| ----- | ----------- | ------- |
| `github_installations` | `installation_id` (UNIQUE), `github_account_id`, `user_id` (nullable), `status` | One row per GitHub App installation; pending until a matching LoreKit user is found |
| `installation_repositories` | `installation_id` FK, `full_name`, `active` | Repos covered by each installation |

RLS on `github_installations`: authenticated users see only `status='linked'`
rows where `user_id = auth.uid()`.  Pending rows (no LoreKit user yet) are
invisible to authenticated users and reconciled on next login.

### Fail-safe pending identity

An installation can arrive **before** the installing user has a LoreKit
account (e.g., installed from GitHub Marketplace, or an org-owned account).
These installations are stored with `user_id = NULL` and `status = 'pending'`.
They are **never dropped**.  When the user later signs in via GitHub OAuth,
`handleSetupReturn` (or the next webhook delivery) transitions the row to
`status = 'linked'`.

### Idempotency

`UNIQUE (installation_id)` + `ON CONFLICT DO UPDATE` in
`lorekit_installation_upsert` ensures re-delivered `installation` events
produce exactly one row.

---

## Pure helpers (`webhook-installation.ts`)

Three side-effect-free functions, tested in
`packages/mcp-core/src/webhook-installation.spec.ts` with no GitHub calls:

| Function | What it does |
| -------- | ------------ |
| `mapInstallationEvent(event, action)` | Maps a (event, action) pair to a reconcile op — `upsert_installation`, `add_repos`, `remove_repos`, `remove_installation`, or `ignore` |
| `reconcileInstallation(githubAccountId, knownUser)` | Returns `{ kind: 'linked', userId }` or `{ kind: 'pending', githubAccountId }` — "dropped installation" is unrepresentable |
| `buildInstallationTokenClaims(appId, nowSeconds)` | Builds a JWT claim set for an installation-token request (RS256, clock injected) |

The edge function mirrors these byte-for-byte in
`supabase/functions/mcp/webhook-installation.ts` (same pattern as
`webhook-secret-select.ts` / `limits.ts`).  The drift guard lives in
`packages/mcp-core/src/edge-parity.spec.ts`.

---

## Setup-URL return bounce (`?state=` correlation)

When a user installs the App, GitHub redirects back to the App's Setup URL:

```
https://lorekit.io/api/auth/callback?installation_id=<id>&setup_action=install[&state=<state>]
```

`state` is correlation-only: it allows associating the install with an
ongoing OAuth flow.  It **never grants access** — all authorization derives
from `auth.uid()` + RLS.

### Implementation

`packages/web/src/app/api/auth/callback/route.ts` threads the params:

1. OAuth `code` is exchanged first (so the session exists).
2. If `installation_id` is present, `handleSetupReturn`
   (`packages/web/src/lib/github-installations.ts`) records the installation
   **immediately**, decoupled from the webhook delivery and from
   `GITHUB_APP_ENABLED`: it POSTs the caller's Supabase JWT + the
   `installation_id` to the edge endpoint `…/functions/v1/mcp/installations/sync`.
3. Redirects to `/settings/webhooks` so the user sees the linked installation.

### The `installations/sync` endpoint

`supabase/functions/mcp/installation-sync.ts` (routed from `mcp/index.ts`) is
the reason an installation appears in the dashboard even when no webhook was
delivered — the exact failure the webhook-first design left open (App installed
on GitHub, `0` installations in LoreKit):

1. Resolve the caller from their Supabase user JWT (`resolveAuth`) — never a
   caller-supplied id; api_key / service callers are rejected.
2. Resolve the installation's account + covered repos from GitHub using an
   **App JWT** (`github-app-client.ts` — the only holder of
   `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`, which stay **Supabase secrets**,
   never Vercel env, never the browser). The RS256 JWT is minted with Web
   Crypto; the deterministic byte work (base64url, PEM→PKCS#8) is the pure,
   unit-tested `github-app-jwt.ts` (mirrored mcp-core ↔ edge, parity-guarded).
3. Entitlement: link the row to the caller **only** when the installation's
   account is the caller's own GitHub account
   (`lorekit_find_user_by_github_id` resolves to their uid) — the same rule the
   webhook reconcile uses. Otherwise the row is upserted `pending`, so an org
   install can never be attributed to a user who doesn't own the account.
4. Upsert via the SECURITY DEFINER `lorekit_installation_upsert` RPC.

This endpoint depends on the App API credentials, **not** on
`GITHUB_APP_ENABLED` (that flag gates only the webhook branch). When the App API
key is absent it replies `app_not_configured`. On that — or on any other
unsuccessful sync (installation not found, upsert error, endpoint
unreachable) — `handleSetupReturn` falls back to `linkPendingInstallation`
(the webhook-driven path), so behaviour is never worse than before.

> **Known limitation:** an installation on an **organization** the caller
> administers stays `pending` (its account id is not the caller's personal
> GitHub id), matching the webhook reconcile. Linking org installs to an
> administering member is a follow-up (verify org-admin membership via the
> caller's OAuth token).

### Live-spike requirement (AC-6)

The `?state=` round-trip depends on GitHub's behavior when configured on the
App's Setup URL.  **Before relying on it in production**, a live spike must
confirm:

1. The App's Setup URL is configured with `?state={state}` in the callback.
2. A test install is triggered; the `state` value issued arrives back in the
   callback unmodified.
3. The `state` correlates to the expected session.

**Option B (fallback):** Configure a dedicated local GitHub App for development
to test the bounce locally without affecting the production App.  See
[GitHub docs — Creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps).

---

## Post-merge operational runbook

After this PR is merged, the live App path stays **dormant** until these steps
are completed:

### 1. Register the GitHub App

- Navigate to GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
- **User authorization callback URL:** `https://lorekit.io/api/auth/callback`.
- **Post-install redirect — pick ONE, both land on the callback route:**
  - If **"Request user authorization (OAuth) during installation"** is enabled
    (recommended), GitHub **disables the separate "Setup URL" field** — the
    callback URL above serves both roles, and the post-install redirect carries
    `code` + `installation_id` together (`auth/callback/route.ts` already
    exchanges the code first, then links). Nothing to set in "Setup URL".
  - If OAuth-during-install is **off**, set **"Setup URL (optional)"** to the
    same `https://lorekit.io/api/auth/callback` instead.
- **Enable "Redirect on update".** Without it, re-configuring an
  **already-installed** App never bounces back with the `installation_id`, so an
  existing install can't be linked short of uninstalling and reinstalling. This
  is the switch that lets `handleSetupReturn` record an install that predates
  this endpoint.
- Configure webhook URL:
  `https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp/webhooks/github`.
- Generate a webhook secret (strong random value, 32+ bytes).
- Download the private key.

### 2. Provision Supabase secrets

```bash
# From the repo root:
supabase secrets set GITHUB_APP_ID=<numeric-app-id>
supabase secrets set GITHUB_APP_WEBHOOK_SECRET=<the-webhook-secret>
supabase secrets set GITHUB_APP_PRIVATE_KEY="$(cat path/to/private-key.pem)"
supabase secrets set GITHUB_APP_ENABLED=true
```

Which secret powers which path:

| Secret | `installations/sync` (dashboard linking) | Webhook branch |
| ------ | ---------------------------------------- | -------------- |
| `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` | **required** — mints the App JWT | not used |
| `GITHUB_APP_WEBHOOK_SECRET` | not used | required — HMAC-verifies deliveries |
| `GITHUB_APP_ENABLED` | **not consulted** | gates the whole App webhook branch |

So the dashboard can record installations as soon as the App **ID + private
key** are set, independent of `GITHUB_APP_ENABLED`. `GITHUB_APP_PRIVATE_KEY`
accepts either the PKCS#1 (`BEGIN RSA PRIVATE KEY`, GitHub's download) or the
PKCS#8 (`BEGIN PRIVATE KEY`) PEM — the endpoint converts as needed.

### 3. Surface the install button in the dashboard

The dashboard's "Install GitHub App" button (Settings → Webhooks) links to the
App's public installation page. It is resolved from the App's slug at build
time, so set this **web** env var (Vercel — not a Supabase secret):

```bash
NEXT_PUBLIC_GITHUB_APP_SLUG=<the-app-slug>   # e.g. lorekitbot (from github.com/apps/<slug>)
```

When unset, the dashboard falls back to the "available once `GITHUB_APP_ENABLED`
is set" note instead of rendering a link to a non-existent App page.

### 4. Verify

- Install the App on a test repo.
- Confirm a `github_installations` row appears with `status='linked'`.
- Confirm webhook deliveries are accepted (check Dash0 traces for
  `lorekit.webhook.secret_source=app` and `lorekit.installation.op=upsert_installation`).

---

## Security posture

- **HMAC verification** for all App-delivered events uses the single
  `GITHUB_APP_WEBHOOK_SECRET`.  No event is processed before HMAC verification.
- **Authorization** is always server-derived from `auth.uid()` + RLS.  Caller-
  supplied `installation_id` / `state` values never grant access.
- **Secrets** are stored only in Supabase secrets / env — never committed.
- **App path stays dormant** until `GITHUB_APP_ENABLED=true` is set.  The flag
  guards all token minting and reconcile logic.
- **Reconcile RPC** (`lorekit_installation_upsert`) is SECURITY DEFINER with
  `set search_path = public`, callable only by `service_role`.

---

## Testing

All new tests pass in the existing `integration` CI job with **no GitHub App
credentials set**:

| Test | File | What it covers |
| ---- | ---- | -------------- |
| `mapInstallationEvent` variants | `packages/mcp-core/src/webhook-installation.spec.ts` | AC-2, AC-9 |
| `reconcileInstallation` pending / linked | same | AC-4, AC-5, AC-9 |
| `buildInstallationTokenClaims` | same | AC-9 |
| edge↔mcp-core byte-parity | `packages/mcp-core/src/edge-parity.spec.ts` | AC-11 |
| Idempotent double-apply | `supabase/tests/migrations.test.sql` §38 | AC-7 |
| pending→linked transition | same §39 | AC-4, AC-5 |
| No regression to pending | same §40 | AC-7 |
| Coverage lookup | same §41 | AC-2, AC-3 |
| Remove repos / installation | same §42–43 | AC-2 |
| RLS isolation | same §44–45 | AC-10 |
| webhook_secrets unchanged | same §46 | AC-2 |

**AC-6 (live `?state=` spike) and AC-10 (dashboard rendering)** require a
running dashboard — they are logged as manual follow-ups in the PR description.
