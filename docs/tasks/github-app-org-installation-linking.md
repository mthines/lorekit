# Idea: Link GitHub App installations on organizations (not just personal accounts)

> Status: **idea / not started** · Area: GitHub App · Size: **M–L**
> Follow-up to PR #285 (installation sync) and PR #291 (repo→org binding).
> Copy into Linear when ready.

## Problem

The dashboard only ever links a GitHub App installation to a user when the
installation's account **is that user's own personal GitHub account**
(`lorekit_find_user_by_github_id(installation.account.id) === caller`). Any
installation on a **GitHub organization** the user administers (e.g. `dash0hq`,
`dash0-mthines-testing-org`) is upserted as `status='pending'` with
`user_id = NULL` and stays **invisible** in the dashboard — you can't see it,
and you can't bind its repos to a LoreKit Organization (PR #291) because it
never surfaces.

This is the documented limitation in `docs/github-app.md` ("Known limitation:
an installation on an organization the caller administers stays `pending`") and
the reason the install-target picker (personal + several orgs) can't be fully
used yet.

Why it's built this way today: the entitlement rule is deliberately strict —
matching the installation's account id to the caller's personal GitHub identity
is the one check the webhook reconcile and the sync endpoint can both make
without trusting caller-supplied input. It's safe, but it excludes orgs.

## Proposed approach

Authorize an org installation using the **caller's own GitHub user-to-server
token**, which is inherently scoped to what that user may access — no org-admin
API gymnastics, no App-private-key trust escalation.

1. The App already has **"Request user authorization (OAuth) during
   installation"** enabled, so the setup-URL bounce
   (`/api/auth/callback`) receives an OAuth `code` alongside `installation_id`.
2. Exchange the `code` for a user-to-server access token
   (`POST https://github.com/login/oauth/access_token`).
3. Call `GET /user/installations` with that token — it returns **exactly the
   installations the authenticated user can access** (personal + orgs they're a
   member/admin of). If the incoming `installation_id` is in that list, the user
   is entitled; otherwise they are not.
4. Link the installation to the caller (set `user_id` + `status='linked'`) via
   the existing `lorekit_installation_upsert` path — the entitlement decision is
   server-derived from the verified token, never caller-asserted.

The GitHub App private key stays a Supabase secret and is untouched by this flow
(entitlement uses the *user's* token, not an App JWT). Token handling can be
bounce-time-only (no long-term storage) if we authorize at the callback, or we
store the refresh token if we want on-demand re-sync later.

## Open design decisions (flag in the ticket)

- **One install ↔ many LoreKit users.** `github_installations.user_id` is a
  single owner (1:1). An org install may be administered by several LoreKit
  users. Options: (a) link to the first authorizing user (simplest); (b) add an
  `installation_members` join table so every entitled member sees it. Recommend
  starting with (a) and noting (b) as a follow-up.
- **Where the entitlement check runs.** Either extend the `installations/sync`
  edge endpoint to accept the OAuth-derived proof, or do the
  `/user/installations` verification in the web (with the exchanged token) and
  then call the existing upsert with an `entitled` flag. Keep the private key
  edge-side; keep the entitlement gate server-derived.
- **Token lifecycle.** Bounce-time authorization needs no storage; on-demand
  re-sync ("refresh my org installs" button) needs a stored refresh token +
  its own threat model.

## Acceptance criteria

- Installing the App on an org the caller administers, then returning to
  LoreKit, shows that installation as `linked` with its covered repos.
- A user who is **not** entitled to an `installation_id` (not in their
  `/user/installations`) can never link it — verified by a negative test.
- Personal-account linking (PR #285) is unchanged.
- Once an org install is linked, its repos can be bound to a LoreKit
  Organization via the PR #291 flow with no further work.
- No new storage of the App private key; entitlement is never caller-asserted.

## Dependencies / relationship to shipped work

- Builds on **PR #285** (installation sync endpoint) — likely extends it.
- Unlocks **PR #291** (repo→org binding) for org-owned repos: today that
  feature only reaches repos under installations that already link (personal).
- No new migration expected for option (a); option (b) adds one join table.
