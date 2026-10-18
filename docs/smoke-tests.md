# Smoke and end-to-end tests

Three suites answer one question: **after a merge, does the core of LoreKit
still work?** Each is a table you add a row to, and each has a guard that fails
the PR when something new ships without a row.

| Suite | What it drives | Where it lives | Guard |
|-------|----------------|----------------|-------|
| Website e2e | Every page and key journey of `@lorekit/web` in a real browser (Playwright) | `packages/web-e2e/specs/*.md` — Markdown, the ui-verify `WHEN`/`THEN` grammar | `specs.test.ts` — every spec parses, and every `page.tsx` is visited by one |
| CLI smoke | Every `lorekit` command, through the real binary | `packages/cli/test/smoke/` | `cli-smoke.test.mjs` — every command and alias needs a case |
| MCP smoke | Every MCP tool: the local stdio server and the hosted server | `packages/cli/test/smoke/cases.mjs` (`mcp` case) and `scripts/smoke/smoke-mcp-tools.mjs` | `cli-smoke.test.mjs` — every catalog tool needs a call in both |

The guards need no browser, no network and no secrets, so they run in the
`check` job (`nx affected -t test`) on every PR.

## What runs where

| When | Website e2e | CLI smoke | MCP smoke |
|------|-------------|-----------|-----------|
| **Every PR** (`ci.yml`) | `web-e2e` job: a local production build against a local Supabase stack — public pages, the signed-out redirect of every dashboard page, and every dashboard page signed in as a throwaway user | offline lane, inside `cli:test` | local stdio server, inside `cli:test` |
| **`/preview` on a PR** (`preview.yml`) | — | remote lane against the preview project | hosted server against the preview project |
| **Merge → before production** (`deploy.yml`) | `e2e-web-staged`: the staged production build, before its domain is assigned (signed-in pages too when the merge leaves the API alone). Gates `promote-web-production` | remote lane in `smoke-preview`. Gates `deploy-production` | hosted server in `smoke-preview`. Gates `deploy-production` |
| **Merge → after production** (`deploy.yml`) | `smoke-production`: `https://www.lorekit.io`, public + signed in. A failed page rolls both halves back; a failed test-account sign-in only warns | — (it writes; production is never written to by a smoke) | stdio handshake only (read-only) |

## Adding a website test

Append a Markdown block to a file in `packages/web-e2e/specs/` — no TypeScript:

```markdown
## Spec 29: Settings › Billing renders
url: /settings/billing
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Billing"} is visible
```

- The format is aw-tester's `WHEN`/`THEN` grammar — the body of a
  `<!-- ui-verify:v1 -->` PR block — so a spec moves between a PR and this suite
  unchanged. `pnpm --filter @lorekit/web-e2e spec:import --pr <n>` pulls a PR's
  ui-verify block in (an intent block arrives as a draft with TODO lines to
  finish); `pnpm --filter @lorekit/web-e2e spec:export <file>` prints a block to
  paste into a PR. Full guide, every supported phrase and locator:
  [`packages/web-e2e/specs/README.md`](../packages/web-e2e/specs/README.md).
- `User is signed in …` in `preconditions:` runs the spec as the test user, and
  also generates a check that a signed-out visitor to its url is sent to
  `/login?next=<url>`. `Not on production: <why>` skips it there.
- Assert what a person sees — the heading, exactly as rendered (settings pages
  share the h1 "Settings", so use their section heading).
- A typo fails `nx test web-e2e` with the file and line, before CI boots a
  browser; so does a new `page.tsx` that no spec visits.

Every test also fails on an uncaught exception, a `console.error` or a
same-origin 5xx, so a page that renders its heading but throws underneath still
fails.

What the grammar cannot express — a reload, a locator that needs scoping to one
container, a request-level check — goes in `packages/web-e2e/src/journeys/*.e2e.ts`
(tag it `@signed-in` if it needs a session).

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
E2E_SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o json | jq -r '.SERVICE_ROLE_KEY // .SECRET_KEY // .service_role_key // .Secret // empty')" \
  npx playwright test

# …or against a deployed site
E2E_BASE_URL=https://www.lorekit.io E2E_USER_EMAIL=… E2E_USER_PASSWORD=… npx playwright test
```

`E2E_WEB_COMMAND="pnpm --filter @lorekit/web exec next dev --port 3100"` swaps
the build for the dev server while iterating. Every variable is documented at
the top of `packages/web-e2e/src/support/env.ts`.

## Telemetry

Every Playwright test attempt is also a trace in Dash0 (`service.name=e2e`),
shipped by `packages/web-e2e/src/support/otel-reporter.ts` whenever the CLI's
`resolveTelemetryConfig` enables export (`LOREKIT_TELEMETRY_TOKEN`, or the
standard `OTEL_EXPORTER_OTLP_*` variables — an explicit
`OTEL_EXPORTER_OTLP_ENDPOINT` needs no credential): a root span per test, a child per step, with
the status, retry, flakiness and duration. Typed values (the sign-in password)
are redacted. A run the resolver does not enable sends nothing (export it locally to send
from your machine too); `E2E_OTEL_OUT=<file>` writes the payload to a file. Span reference: [otel.md](./otel.md#website-e2e-runs-servicenamee2e).

## Secrets the deploy-time runs use

| Secret | Used by | Without it |
|--------|---------|------------|
| `LOREKIT_TESTING_USER_NAME`, `LOREKIT_TESTING_USER_PW` (repo) | signed-in pages on the staged build and on `lorekit.io` | signed-in tests skip, announced; public tests still run |
| `LOREKIT_SMOKE_TOKEN` (preview env, existing) | CLI remote lane, hosted MCP smoke | — (already required) |
| `LOREKIT_TELEMETRY_TOKEN` (repo, existing) | the e2e OTel reporter, on every Playwright step | tests run as before; no traces are sent |

Traces are off on any run that targets production (the staged build included): a
trace records request headers and cookies, and this public repo's artifacts are
downloadable by anyone. Failure screenshots still upload.

The sign-in is its own CI step in both deploy-time jobs: when the test account
cannot sign in (an expired password, an auth rate limit) the signed-in pages are
skipped with a warning, so a credential problem never blocks a promotion or
rolls back production — only a page that fails after a successful sign-in does.
The deliberately failed sign-in (`journeys/login.e2e.ts`) never targets
production.

The test account must be a normal user (not in `DEVELOPER_EMAILS`); opening
`/lore` as a user with no API tokens creates one, so expect a "My first token".
The sign-out journey never runs against production: signing out revokes every
session of the account.
