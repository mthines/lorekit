# Releasing `@lorekit/cli`

The CLI is released automatically from **conventional commits** using
[release-please](https://github.com/googleapis/release-please). You never bump
the version by hand — you write good commit messages, and release-please does
the rest.

## The flow

```
 feature PRs (feat:/fix:/…)          release PR                     npm
        │  merge to main        ┌──────────────────┐   merge   ┌───────────┐
        ▼                       │ release-please    │  ──────▶  │ publish   │
  ┌───────────┐   push    ┌────▶│ bumps version +   │           │ (OIDC)    │
  │  main     │ ────────▶ │     │ writes CHANGELOG  │           └───────────┘
  └───────────┘           │     └──────────────────┘
                          └── release.yml (runs on every push to main)
```

1. **You merge feature PRs** to `main` with [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `feat!:`/`BREAKING CHANGE:` for majors, …). Only commits
   that touch `packages/cli/**` count toward the CLI's version.
2. **release-please keeps a "release PR" open**, continuously updating
   `packages/cli/package.json` and `packages/cli/CHANGELOG.md` with the next
   version and the accumulated notes. Nothing is published yet.
3. **The release PR merges itself** — `release.yml` turns on GitHub auto-merge
   for it, so it lands the moment the required CI checks (`check` + `integration`)
   pass. No human merge step. That push makes release-please create the tag
   `cli-vX.Y.Z` + a GitHub Release, which gates the `publish-cli` job — it checks
   out the freshly-bumped `main` and runs `npm publish` via Trusted Publishing.

> Because the release PR auto-merges, **every CLI-affecting commit on `main`
> flows to npm on its own**. To batch or hold releases, see "Hold a release"
> below.

The version is decided by the commits since the last release:

| Commit type                         | Bump  |
| ----------------------------------- | ----- |
| `fix:` / `perf:` / `deps:` / `revert:` | patch |
| `feat:`                             | minor |
| `feat!:` or a `BREAKING CHANGE:` footer | major |
| `docs:` / `chore:` / `ci:` / `test:` / `refactor:` | none (shown or hidden per config) |

## One-time setup

Three things must exist for the pipeline to run end-to-end. All are already
referenced by `.github/workflows/release.yml`.

### 1. A GitHub App for release-please

release-please must author its PR as something **other than** the default
`GITHUB_TOKEN`, because a PR opened by that token does not trigger `ci.yml` —
so the required `check` would never run and the release PR could not be merged.
A GitHub App mints a short-lived token per run (no long-lived PAT to rotate).

- Create a GitHub App (org or personal) with **Repository permissions →
  Contents: Read and write** and **Pull requests: Read and write**.
- Install it on `mthines/lorekit`.
- Add, under **Settings → Secrets and variables → Actions**:
  - `RELEASE_APP_ID` — a repository **variable** (Variables tab) holding the
    App's numeric ID. It's a variable, not a secret, so `release.yml` can gate
    on it — until it's set, the whole workflow no-ops instead of failing.
  - `RELEASE_APP_PRIVATE_KEY` — a repository **secret** holding the App's
    generated private key (`.pem` contents).

> Lighter alternative: a fine-grained PAT with the same two permissions, passed
> as `token:` directly. The App is preferred — it isn't tied to a person and the
> token is short-lived.

### 2. npm Trusted Publisher pointed at `release.yml`

The `publish-cli` job publishes with OIDC — no `NPM_TOKEN`. On npmjs.com →
**@lorekit/cli → Settings → Trusted Publisher → GitHub Actions**:

- Organization or user: `mthines`
- Repository: `lorekit`
- Workflow filename: **`release.yml`** (this is the workflow that runs
  `npm publish` — not `deploy.yml`)
- Allowed actions: **Allow `npm publish`**

The package must already exist on npm before a trusted publisher can be added,
so the very first publish is done by hand (`cd packages/cli && npm publish
--access public`); every release after that is automated and token-free.

### 3. Repo auto-merge enabled + required checks

The release PR merges itself via GitHub's native auto-merge, so:

- Under **Settings → General → Pull Requests**, tick **Allow auto-merge**.
  Without it, `gh pr merge --auto` in `release.yml` errors and the PR sits
  unmerged.
- Keep `check` + `integration` as **required status checks** on `main` (branch
  protection or a ruleset). Auto-merge holds the merge until they pass, so an
  unverified release can never land. The workflow squash-merges the PR.

### 4. Discord failure alerts (optional)

If `release-please` (maintaining the release PR / cutting the tag / auto-merge)
or the `publish-cli` job (test, smoke, `npm publish`) fails, `release.yml`'s
`notify-failure` job posts a red embed to Discord with a **deep link to the
failed run** plus the branch, commit, and who triggered it — the same alert and
webhook `deploy.yml` uses (both share `./.github/actions/discord-notify`).

Add the **repo-level** secret `DISCORD_WEBHOOK_URL` (Settings ▸ Secrets and
variables ▸ Actions) — create the webhook in Discord under *Server Settings ▸
Integrations ▸ Webhooks ▸ New Webhook*. If it is **unset**, `notify-failure`
no-ops with a warning and never fails the run.

## Adjusting a release

- **Change what's in the release** — edit the release PR's title/body or amend
  commits; release-please recomputes on the next push to `main`.
- **Hold a release** — auto-merge lands the release PR as soon as CI is green,
  so to hold, turn off auto-merge on that specific PR (or dismiss it) before it
  goes green; feature merges keep accumulating into the next one. To pause
  releases entirely, temporarily untick **Allow auto-merge** for the repo.
- **Force a version** — add a `Release-As: X.Y.Z` footer to a commit on `main`.
