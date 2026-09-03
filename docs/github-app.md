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
│   ├── comment event (issue_comment / pull_request_review*)
│   │   → verify HMAC against GITHUB_APP_WEBHOOK_SECRET
│   │   → existing candidate-write path (source::pr-webhook) — unchanged
│   │   → 200 OK / 500
│   └── relevance delivery
│       │   pull_request_review_thread.resolved   → classify that ONE thread
│       │   pull_request.closed WHERE merged      → sweep every OPEN thread
│       → verify HMAC against GITHUB_APP_WEBHOOK_SECRET
│       → classifyCommentRelevance (see "Comment-relevance classification")
│       → 200 OK — a classification failure never fails the delivery
└── per-repo path (flag off, or non-App delivery)
    → resolve secret: webhook_secrets (db_repo → db_legacy → env)
    → existing path — UNCHANGED
```

### Data model (`00037_github_installations.sql`)

| Table | Key columns | Purpose |
| ----- | ----------- | ------- |
| `github_installations` | `installation_id` (UNIQUE), `github_account_id`, `user_id` (nullable), `status` | One row per GitHub App installation; pending until a matching LoreKit user is found |
| `installation_repositories` | `installation_id` FK, `full_name`, `active` | Repos covered by each installation |

Added by `00102_github_relevance_configs.sql`:

| Table | Key columns | Purpose |
| ----- | ----------- | ------- |
| `github_relevance_configs` | `installation_id` FK, `marker_open` / `marker_close`, `bucket_tag`, `key_prefix`, `agent_name`, `record_kind` / `record_host`, `ttl_days`, `active` | The consumer's vocabulary for comment-relevance classification — one row per (installation, bucket). No row means no classification for that installation |

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
`packages/mcp-core/src/webhook/webhook-installation.spec.ts` with no GitHub calls:

| Function | What it does |
| -------- | ------------ |
| `mapInstallationEvent(event, action)` | Maps a (event, action) pair to a reconcile op — `upsert_installation`, `add_repos`, `remove_repos`, `remove_installation`, or `ignore` |
| `reconcileInstallation(githubAccountId, knownUser)` | Returns `{ kind: 'linked', userId }` or `{ kind: 'pending', githubAccountId }` — "dropped installation" is unrepresentable |
| `buildInstallationTokenClaims(appId, nowSeconds)` | Builds a JWT claim set for an installation-token request (RS256, clock injected) |

The edge function mirrors these byte-for-byte in
`supabase/functions/mcp/webhook-installation.ts` (same pattern as
`webhook-secret-select.ts` / `limits.ts`).  The drift guard lives in
`packages/mcp-core/src/edge/edge-parity.spec.ts`.

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

1. A **Supabase** auth `code` / `token_hash` is exchanged first (so the session
   exists). A GitHub App Setup-URL return is **not**: its `code` is GitHub's, so
   `classifyAuthCallback` reports `none` for it (see `isGithubAppSetupReturn` in
   `packages/web/src/lib/auth-callback-params.ts`) and the route goes straight to
   step 2 on the session the browser already has.
2. If `installation_id` is present, `handleSetupReturn`
   (`packages/web/src/lib/github-installations.ts`) records the installation
   **immediately**, decoupled from the webhook delivery and from
   `GITHUB_APP_ENABLED`: it POSTs the caller's Supabase JWT + the
   `installation_id` to the edge endpoint `…/functions/v1/mcp/installations/sync`.
3. Redirects to `/settings/integrations` so the user sees the linked installation.

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

## Comment-relevance classification

A review agent posts a finding as a PR review comment.
Some time later that thread is resolved, declined in a reply, thumbed down, or
merged still open.
That outcome is the only honest signal available about whether the finding was
worth posting, and the App turns it into a memory record so the next review can
learn from it.

Before this, the classification lived in a **GitHub Actions workflow** in each
consuming repository, which needed a `LOREKIT_API_KEY` secret, a committed
caller workflow, and a CI run per resolved thread.
Now the App does it: the installation is the only setup, and the App already
holds a credential that can read the pull request.

### The rule underneath every branch

**A directional record requires corroborated evidence.
Where the evidence cannot decide, write nothing.**

Silence costs one signal.
A wrong signal trains a suppressor against a finding class that was never
rejected, and the suppressor is the thing that decides what a future review is
allowed to say.
Every refusal below is that rule firing, not a gap.

### Config model (`github_relevance_configs`)

LoreKit must not learn any particular agent's vocabulary — that is how a generic
mechanism silently becomes one consumer's mechanism.
So an installation **declares** its vocabulary, and a repository with no config
row is simply not classified:

| Column | What the installation declares |
| ------ | ------------------------------ |
| `marker_open` / `marker_close` | The literal delimiters wrapping the agent's own opaque identifier inside a comment body |
| `key_prefix` | The memory-key namespace classified outcomes are filed under |
| `bucket_tag` | The LoreKit tag the records carry |
| `agent_name` | What the installation calls its review agent — copied onto `source.agent` |
| `record_kind` / `record_host` | LoreKit's first-class record properties (`kind` defaults to `signal`) |
| `ttl_days` | Record lifetime, 1–365, default 60 |

Set one with the owner-gated RPC (there is **no dashboard UI yet**):

```sql
select lorekit_relevance_config_set(
  p_installation_id => 12345678,
  p_marker_open     => '<!-- relevance:fp=',
  p_marker_close    => ' -->',
  p_bucket_tag      => 'loop::reviewer-comment-relevance',
  p_key_prefix      => 'relevance::',
  p_agent_name      => 'pr-reviewer',
  p_record_host     => 'reviewer',
  p_ttl_days        => 60
);
```

`lorekit_relevance_config_deactivate(installation_id, bucket_tag)` soft-disables
one; both are gated on `auth.uid()` owning the installation.

**Literal delimiters, not a caller-supplied regex.**
A regex from the database, compiled inside an edge function, is a
catastrophic-backtracking vector, and "reject the dangerous patterns" is not a
check that can be written soundly.
`indexOf` answers the same question in linear time.
The extracted value is additionally held to `SAFE_MARKER_VALUE`
(`[A-Za-z0-9._:@/-]{1,200}`) because whoever can comment on the pull request
supplies it, and it becomes the suffix of a memory key.
Anything outside that charset is dropped — no record at all, never a record
under an unpredictable key.

### Direction tables (`comment-relevance.ts`)

The decision logic is pure and unit-tested in
`packages/mcp-core/src/webhook/comment-relevance.ts`, mirrored byte-for-byte
into `supabase/functions/mcp/comment-relevance.ts`.

**A resolved thread** — precedence top to bottom, first match wins:

| Evidence | Outcome | Method | Direction |
| -------- | ------- | ------ | --------- |
| 👎 from the PR author on the root comment | `not-relevant` | `wont-fix` | `suppress` |
| A reply matching `DECLINE_PATTERN` | `not-relevant` | `wont-fix` | `suppress` |
| Thread state unreadable | *(no record — `thread-state-unavailable`)* | | |
| Thread is outdated (the anchored code is gone) | *(no record — `anchor-gone`)* | | |
| Resolved, live anchor, nothing declining it | `relevant` | `fixed` | `amplify` |

**A thread as it stood at merge:**

| Evidence | Outcome | Method | Direction |
| -------- | ------- | ------ | --------- |
| Thread state unreadable | *(no record — `thread-state-unknown`)* | | |
| Thread was resolved | *(no record — `already-classified-on-resolve`)* | | |
| 👎 from the PR author | `not-relevant` | `wont-fix` | `suppress` |
| A reply matching `DECLINE_PATTERN` | `not-relevant` | `wont-fix` | `suppress` |
| Thread is outdated | *(no record — `anchor-gone`)* | | |
| Comment carries no path | *(no record — `no-anchor`)* | | |
| The commit walk did not complete | *(no record — `touch-undecidable`)* | | |
| A commit touched the commented region | *(no record — `region-edited`)* | | |
| Open, undeclined, live anchor, no fix landed | `weak-not-relevant` | `ignored-at-merge` | `suppress` |

Three properties of these tables are load-bearing:

1. **`weak-not-relevant` is its own value.**
   "Open at merge with nothing said about it" is much thinner evidence than "the
   author replied that it was intentional", and collapsing the two would let
   neglect accumulate into suppression at the same rate as an explicit decline.
2. **An incomplete commit walk is undecidable, not "untouched".**
   Reading it the other way converts a fetch budget into a stream of false
   suppressions.
3. **Every alternative in `DECLINE_PATTERN` carries `\b` on both sides.**
   Unbounded, `intentional` matches inside *"That was unintentional - fixed"* and
   turns a landed fix into a `suppress` record — the exact inversion the module
   exists to avoid.

Only the **PR author's own** 👎 counts as a decline.
Anyone who can react to a comment could otherwise train the suppressor.

`severity` is absent from the record by design: grading a finding needs the
agent's own comment-prefix conventions, which LoreKit does not know.
This is a deliberate capability gap against the Actions-based writer, which runs
inside the consuming repository and does know them.

### Read budget

This runs **inline on a webhook delivery**, so the cost is fixed rather than
proportional to the pull request (`github-review-read.ts`):

| Read | Cost | Cap |
| ---- | ---- | --- |
| Thread facts (resolution, staleness, anchor, replies, 👎) | ONE paginated GraphQL query | 50 threads × 20 pages |
| Comments per thread | included above | 50 |
| Touch evidence (`compare/<comment's commit>...<head>`) | ONE call per **distinct commit**, memoised | 12 compares |

REST cannot report thread resolution at all, and its reactions endpoint is one
call per thread — which is why the thread read is GraphQL.
The `compare` question is exactly "did anything land after this comment", so its
call count is bounded by the number of distinct commits the open threads were
written against, not by the branch length.
Failures are cached too: retrying the same unreachable `compare` once per thread
is how a bounded budget becomes an unbounded one.

**Every cap reports *undecidable*, never a default.**
A truncated GraphQL walk sets `complete: false`, which **aborts the merge
sweep** — a sweep asserts "this thread was open at merge" about threads it could
not see.
A single resolved-thread delivery stays classifiable, because it only needs the
one thread it was told about.
`compare` truncates its `files` array at 300 entries with no flag saying so, so a
diff at that ceiling is treated as unreadable rather than as a diff that happens
not to contain the file.

### Tenancy

Records are written **as the installation's owner**, not as `null`.
`lorekit_relevance_config_for_repo` filters on
`status = 'linked' and user_id is not null` for that reason: reads filter by
`user_id`, so a record written with `user_id = null` is a row no user token can
ever read back.
Writes go through the same `toolWrite` path as any other memory, so they count
against the owner's memory cap and carry the normal provenance
(`source_agent = 'github-app/comment-relevance'`, `origin_repo`, `origin_pr`,
`origin_commit`).

A per-delivery write ceiling of 40 records bounds a merge sweep on a very large
pull request, and each record is written in its own `try`/`catch` so one failure
does not abandon the rest of the sweep.

### Observability

The classifier emits `lorekit.relevance.*` span attributes:
`configs`, `threads_read`, `threads_complete`, `written`, `mode`
(`thread-resolved` / `merge-sweep`), `touch_compares`, `skips` (a comma-joined
list of the skip tokens above), and `skip_reason` / `config_error` / `error` on
the paths that end early.

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
    `code` + `installation_id` together (`auth/callback/route.ts` recognises that
    shape and links the installation *without* exchanging GitHub's `code`).
    Nothing to set in "Setup URL".
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
- **Subscribe to the events the handler routes.**  Comment-relevance
  classification needs `Pull request review thread` (for `.resolved`) **and**
  `Pull request` (for `.closed` where `merged` is true).  `pull_request` is the
  one addition this feature makes to the subscription list, and it is a settings
  change with no code counterpart: without it the merge sweep never fires and
  only per-thread resolutions are classified.  Repository permissions needed:
  **Pull requests: Read-only** and **Contents: Read-only** (the latter for the
  `compare` call that supplies touch evidence).

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

The dashboard's "Install GitHub App" button (Settings → Integrations) links to the
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
- **Relevance config is owner-gated, never caller-supplied.**
  `lorekit_relevance_config_set` / `_deactivate` verify `auth.uid()` owns the
  installation; `lorekit_relevance_config_for_repo` is SECURITY DEFINER, granted
  only to `service_role`, and resolves the repo → installation → owner chain
  server-side.  RLS on `github_relevance_configs` is select-only and scoped to
  the caller's own linked installations.
- **No regex comes out of the database.**  Marker delimiters are literal strings
  matched with `indexOf`, so a config row cannot smuggle a
  catastrophic-backtracking pattern into an edge function.
- **The marker value is charset-bounded** (`SAFE_MARKER_VALUE`) before it becomes
  a memory-key suffix, and the key's *prefix* is the account's own — so a
  commenter can influence one namespace's shape, never its location.

---

## Testing

All new tests pass in the existing `integration` CI job with **no GitHub App
credentials set**:

| Test | File | What it covers |
| ---- | ---- | -------------- |
| `mapInstallationEvent` variants | `packages/mcp-core/src/webhook/webhook-installation.spec.ts` | AC-2, AC-9 |
| `reconcileInstallation` pending / linked | same | AC-4, AC-5, AC-9 |
| `buildInstallationTokenClaims` | same | AC-9 |
| edge↔mcp-core byte-parity | `packages/mcp-core/src/edge/edge-parity.spec.ts` | AC-11 |
| Idempotent double-apply | `supabase/tests/migrations.test.sql` §38 | AC-7 |
| pending→linked transition | same §39 | AC-4, AC-5 |
| No regression to pending | same §40 | AC-7 |
| Coverage lookup | same §41 | AC-2, AC-3 |
| Remove repos / installation | same §42–43 | AC-2 |
| RLS isolation | same §44–45 | AC-10 |
| webhook_secrets unchanged | same §46 | AC-2 |
| Relevance decision tables, marker extraction, patch touch, record shape | `packages/mcp-core/src/webhook/comment-relevance.spec.ts` (78 cases) | every branch and every skip token, each `DECLINE_PATTERN` boundary case individually, the `SAFE_MARKER_VALUE` charset rejections |
| Relevance config resolution + owner gating + RLS | `supabase/tests/migrations.test.sql` §102 | linked resolves the owner and the declared vocabulary; pending / uncovered / deactivated resolve nothing; `full_name` lower-cased; non-owner set + deactivate denied; owner upsert idempotent per bucket; stranger reads 0 rows |

**AC-6 (live `?state=` spike) and AC-10 (dashboard rendering)** require a
running dashboard — they are logged as manual follow-ups in the PR description.
