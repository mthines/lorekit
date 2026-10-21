# LoreKit — repo facts for the verification suite

Read by `aw-verify`, `ui-verify`, `telemetry-verify`, `aw-tester` and `aw` on every run.
Values live in the sibling `environments.yml`, `ui.yml` and `telemetry.yml`; this file says what they cannot.

## Local stack

- Two modes, one URL (`http://localhost:3000`). `web` alone serves the dashboard against the hosted Supabase project in `.env.local`. When the diff touches `supabase/**` or `scripts/seed/**`, the `supabase` component starts first and `web` switches to it (`nx serve-local web` → `http://127.0.0.1:54321`). `AW_WEB_BACKEND=local|hosted` forces a mode.
- **The hosted backend is production** (`pqokxlhvnosogizsjztg`). A probe that creates, edits or deletes a record in `web`-only mode writes real production rows under the shared test account. Name every record a run creates with `aw-verify` or `ui-verify-adv` in its key or title and delete it in the same run. Run write-heavy ACs (Concurrency rows, bulk edits) in local-Supabase mode or on the preview.
- **The local Supabase stack runs on a developer machine only.** `supabase-local.sh` exits `78` with an `aw: local Supabase skipped (…)` line when no Docker daemon or Supabase CLI is reachable. That happens in every Agent0 / cloud sandbox (no Docker socket). Treat it as `skipped`, not a failure: carry on with `web`, and mark ACs that need the PR's backend code `skipped (supabase runs locally only — verify on the preview)`.
- An Agent0 sandbox also starts without `.env.local`, so `web` has no Supabase URL and authed pages fail. There, prefer `run preview`.
- `supabase-local.sh` seeds the test account into the local auth from the same `LOREKIT_TESTING_USER_*` variables, so the login is identical in both modes. Stopping its process group stops the functions server only; `pnpm nx stop supabase` stops the containers. Studio: `http://127.0.0.1:54323`.
- `pnpm --filter @lorekit/web dev` runs `vercel env pull` first and needs a linked Vercel CLI; the stack uses `pnpm nx serve web` instead.

## Login

- One shared test account: email `LOREKIT_TESTING_USER_NAME`, password `LOREKIT_TESTING_USER_PW` (from `.env.local` locally, the shell elsewhere). Never commit either value.
- `/login` opens on a provider-choice screen; the email form appears after "Continue with email". `scripts/auth-bootstrap-credentials.mjs` handles that and lands on `/lore`. Never script the GitHub OAuth path.
- Signed in = the sidebar link "User settings for <name>". It shows the account's display name and has no `data-testid` to mask in screenshots.
- Sessions are host-scoped: `.auth/local.json` never authenticates the preview, and the preview session is recaptured every run.

## Preview

- CI deploys the dashboard preview (`web-preview-deploy.yml`) only when web paths changed (`scripts/ci/web-preview-filter.mjs`). Comment `/web-preview` on the PR to force one.
- The URL is in the sticky `<!-- lorekit-web-preview` comment from `github-actions[bot]`: the stable alias `lorekit-pr-<n>-<vercel scope>.vercel.app` (scope `mads-thines-projects` unless a fork sets `VERCEL_SCOPE`). The GitHub deployments API holds only `main`'s staging (`preview` environment, ref `main`) and production deploys — never use them for a PR.
- Every preview request needs the `x-vercel-protection-bypass` header from `VERCEL_AUTOMATION_BYPASS_SECRET`; without it Vercel redirects to its SSO page before the app loads.
- An Agent0 thread in trusted-hosts network mode cannot reach `*.vercel.app` (connection reset, seen 2026-10-21). Preview runs from Agent0 need full network access.

## Data

- No package seed script; local `fixtures.seed` stays `null` and runs use the account's existing data.
- The preview Supabase project is seeded by `preview.yml` (`/preview --seed`) via `scripts/seed/seed-preview.mjs`: keys prefixed `preview-seed/`, tag `seed::preview`, org `preview-seed-org`. Locally: `node scripts/seed/seed-preview.mjs --psql postgresql://postgres:postgres@127.0.0.1:54322/postgres --user-email "$LOREKIT_TESTING_USER_NAME"` (needs `psql`). It refuses the production project.

## Telemetry

- Dash0 dev org (`app.dash0-dev.com`), dataset `default`. Use the Dash0 MCP server whose `listDatasets` contains it, and set its key as `mcp_server` in `~/.agents/aw/config.yml`.
- `service.namespace` is `lorekit` on every service in every environment, and production traffic sits in the same dataset and window. Separate a run's records by `deployment.environment.name` (`preview` on a PR preview, `local` or `development` locally) and, for web events, by the page host.
- `service.name`: `web` (browser RUM and the Next.js server), `api` (every Edge Function, told apart by `faas.name`), `cli`, `e2e`. Web events have been seen from `production` and `preview` only.
- Local export happens only when `.env.local` sets the `OTEL_*` variables; none arrived from local `web` in the 24 h before 2026-10-21. Without them, report `telemetry: skipped (no local export configured)` rather than a clean window.
- Attribute reference: `docs/otel.md`. Smoke and CI runs are tagged `deployment.environment.name=test`.

## Checks and commits

- Run `pnpm install --frozen-lockfile` before the first `pnpm nx` in a fresh checkout.
- Gate: `pnpm nx affected -t typecheck,test,lint`. Never `run-many … --all` in a sandbox — it stalls the box.
- Storybook interaction + visual tests: `cd packages/web && npx vitest run --config vitest.storybook.config.ts --changed=main` (use `npx`, not `pnpm exec`).
- Node's `fetch` ignores `HTTPS_PROXY` in a proxied sandbox; run Node scripts with `NODE_USE_ENV_PROXY=1`.
- Conventional Commits. A fix that changes what a user can do or see also updates the user-facing docs and regenerates `llms.txt` (CLAUDE.md → "User-facing docs"). PRs stay draft; undrafting is a human decision.
