# Smoke and end-to-end tests

Three suites answer one question: **after a merge, does the core of LoreKit
still work?** Each is a table you add a row to, and each has a guard that fails
the PR when something new ships without a row.

| Suite | What it drives | Where it lives | Guard |
|-------|----------------|----------------|-------|
| Website e2e | Every page of `@lorekit/web` in a real browser (Playwright) | `packages/web-e2e/` | `routes.test.ts` — every `page.tsx` needs an entry in `src/routes.ts` |
| CLI smoke | Every `lorekit` command, through the real binary | `packages/cli/test/smoke/` | `cli-smoke.test.mjs` — every command and alias needs a case |
| MCP smoke | Every MCP tool: the local stdio server and the hosted server | `packages/cli/test/smoke/cases.mjs` (`mcp` case) and `scripts/smoke/smoke-mcp-tools.mjs` | `cli-smoke.test.mjs` — every catalog tool needs a call in both |

The guards need no browser, no network and no secrets, so they run in the
`check` job (`nx affected -t test`) on every PR.

## What runs where

| When | Website e2e | CLI smoke | MCP smoke |
|------|-------------|-----------|-----------|
| **Every PR** (`ci.yml`) | `web-e2e` job: a local production build against a local Supabase stack — public pages, the signed-out redirect of every dashboard page, and every dashboard page signed in as a throwaway user | offline lane, inside `cli:test` | local stdio server, inside `cli:test` |
| **`/preview` on a PR** (`preview.yml`) | — | remote lane against the preview project | hosted server against the preview project |
| **Merge → before production** (`deploy.yml`) | `e2e-web-staged`: the staged production build, before its domain is assigned. Gates `promote-web-production` | remote lane in `smoke-preview`. Gates `deploy-production` | hosted server in `smoke-preview`. Gates `deploy-production` |
| **Merge → after production** (`deploy.yml`) | `smoke-production`: `https://lorekit.io`, public + signed in. A failure rolls both halves back | — (it writes; production is never written to by a smoke) | stdio handshake only (read-only) |

## Adding a page

Add one object to `ROUTES` in `packages/web-e2e/src/routes.ts`:

```ts
{ route: '/settings/billing', access: 'signed-in', heading: { level: 2, name: 'Billing' } },
```

- `route` is the directory of the `page.tsx` with route groups removed
  (`(dashboard)/settings/billing/page.tsx` → `/settings/billing`). For a dynamic
  route, keep the pattern in `route` and put a real URL in `path`.
- `access: 'public'` → one test: it renders for a signed-out visitor.
  `access: 'signed-in'` → two: a signed-out visitor is sent to
  `/login?next=<path>`, and a signed-in user sees the heading.
- `heading` is what a person sees — the exact accessible name. Use the h2 on
  settings pages (they share the h1 "Settings").
- `landsOn` when the page redirects; `skipOn` (with a reason) when one kind of
  target cannot show it; `allowConsoleErrors` (with a comment) for a known,
  harmless console error.

Every test also fails on an uncaught exception, a `console.error` or a
same-origin 5xx, so a page that renders its heading but throws underneath still
fails.

A journey that spans pages (sign in, navigate, sign out) goes in
`packages/web-e2e/src/journeys/` — tag it `@signed-in` if it needs a session.

## Adding a CLI command

Add a case to `packages/cli/test/smoke/cases.mjs`, in session order:

```js
smoke('billing', 'shows the current plan', BOTH, async ({ cli, ctx }) => {
  const out = cli.json(['billing']);
  assert.equal(out.ok, true);
});
```

- `cli.json(args)` appends `--json`, asserts exit 0 (or `{ code }`) and returns
  the parsed output; `cli.ok(args)` returns the text; `cli.fails(args, /why/)`
  asserts a non-zero exit with that message.
- Lanes: `offline` (throwaway HOME + project, `LOREKIT_MODE=local`, no network),
  `remote` (a live endpoint), or both. A remote-only command gets an offline case
  that asserts it refuses cleanly, and a remote case that asserts it works.
- Anything the remote lane writes must go under `ctx.scope` and through
  `writeLesson(...)` / `trackRemoteWrite(...)`, so cleanup hard-deletes it.
- A command that genuinely cannot be smoked goes in `NOT_SMOKED` with the reason.

## Adding an MCP tool

After adding the operation (see [adding-an-operation.md](./adding-an-operation.md)):

1. **Hosted:** add a `check(...)` to `scripts/smoke/smoke-mcp-tools.mjs` that
   calls it and asserts what it did, writing only under the run's scope.
2. **Local stdio**, unless the tool is in `LOCAL_MCP_EXEMPT`: call it in the
   offline `mcp` case in `cases.mjs` and add it to `LOCAL_MCP_CALLED`.

## Running locally

```bash
# Guards (fast, no browser)
pnpm nx test web-e2e
node --test packages/cli/test/cli-smoke.test.mjs   # guards + the offline CLI/MCP lane

# CLI remote lane against preview (writes; refuses production)
node packages/cli/test/smoke/run.mjs --remote "$PREVIEW_MCP_URL" "$LOREKIT_TOKEN"

# Website e2e against a local build
pnpm nx run web-e2e:build-web                      # NEXT_PUBLIC_USE_LOCAL_SUPABASE=true
cd packages/web-e2e && npx playwright install chromium
npx playwright test --project=public               # signed-out only, no backend needed
npx playwright test --ui                           # watch it run

# …with signed-in pages, against `supabase start`
E2E_SUPABASE_URL=http://127.0.0.1:54321 \
E2E_SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o json | jq -r .SERVICE_ROLE_KEY)" \
  npx playwright test

# …or against a deployed site
E2E_BASE_URL=https://lorekit.io E2E_USER_EMAIL=… E2E_USER_PASSWORD=… npx playwright test
```

`E2E_WEB_COMMAND="pnpm --filter @lorekit/web exec next dev --port 3100"` swaps
the build for the dev server while iterating. Every variable is documented at
the top of `packages/web-e2e/src/support/env.ts`.

## Secrets the deploy-time runs use

| Secret | Used by | Without it |
|--------|---------|------------|
| `VERCEL_AUTOMATION_BYPASS_SECRET` (repo) | `e2e-web-staged` — gets through Vercel Deployment Protection on the staged URL | the job skips with a warning and promotion proceeds as before |
| `LOREKIT_TESTING_USER_NAME`, `LOREKIT_TESTING_USER_PW` (repo) | signed-in pages on the staged build and on `lorekit.io` | signed-in tests skip, announced; public tests still run |
| `LOREKIT_SMOKE_TOKEN` (preview env, existing) | CLI remote lane, hosted MCP smoke | — (already required) |

The test account must be a normal user (not in `DEVELOPER_EMAILS`); opening
`/lore` as a user with no API tokens creates one, so expect a "My first token".
The sign-out journey never runs against production: signing out revokes every
session of the account.
