# OpenTelemetry & Dash0

LoreKit emits traces, metrics, and logs to Dash0 from every layer of the stack.

## What's instrumented

| Layer | SDK | Signals |
|-------|-----|---------|
| Edge Function (Deno) | Lightweight OTLP/JSON via `fetch()` | Traces per tool call + webhook; DB child spans named by SQL statement |
| Next.js server | `@vercel/otel` | HTTP server spans, Supabase query spans |
| Browser (RUM) | `@dash0/sdk-web` | Page loads, navigation, Web Vitals, fetch tracing, errors, sessions |
| CLI (`@lorekit/cli`) | Lightweight OTLP/JSON via `fetch()` (zero-dep, no SDK) | One span + one counter point per human-facing command (`install` / `doctor` / `migrate`) |

All signals carry `service.namespace=lorekit` so you can filter the full stack in one Dash0 query.

---

## Custom spans (Edge Function)

Every `tools/call` invocation produces a trace tree:

```
lorekit.memory.write   (INTERNAL — tool dispatch)
  └── UPSERT INTO memories WHERE ...  (CLIENT — Postgres, db.query.text set)
```

Attributes on `lorekit.memory.*` spans:

| Attribute | Example | Notes |
|-----------|---------|-------|
| `lorekit.tool.name` | `memory.write` | Bounded set — safe as metric dimension |
| `lorekit.scope` | `repo::mthines/gw-tools` | Canonical scope string |
| `lorekit.scope.type` | `repo` | `global` \| `project` \| `repo` \| `branch` |
| `lorekit.key` | `aw-lessons::worktree-naming` | Lesson key |
| `lorekit.source_agent` | `aw-executor` | Agent that triggered the write |
| `lorekit.trigger` | `stuck-loop` | What triggered the write |

DB child spans carry OTel database semconv:

| Attribute | Example |
|-----------|---------|
| `db.system` | `postgresql` |
| `db.operation.name` | `SELECT` / `INSERT` |
| `db.collection.name` | `memories` |
| `db.query.text` | `SELECT key,value FROM memories WHERE scope = '...' LIMIT 50` |
| `db.response.rows` | `7` |

---

## CLI usage telemetry (`@lorekit/cli`)

The CLI is strictly zero-dependency, so — like the Edge Function — it emits
OTLP/JSON directly over the global `fetch` (no `@opentelemetry/*` SDK). Each
**human-facing** command produces one `INTERNAL` span named `lorekit.cli.<cmd>`
plus one data point on the `lorekit.cli.invocations` counter, so the maintainers
can see which commands people run. The machine-facing `hook` and `mcp` commands
are **not** instrumented — they fire on every agent event and must keep stdout
to their host protocol.

Attributes on `lorekit.cli.*` spans + counter points (deliberately narrow — this
runs on end-users' machines, so **no PII is ever attached**: no path, cwd, token,
endpoint, repo, or scope string):

| Attribute | Example | Notes |
|-----------|---------|-------|
| `lorekit.cli.command` | `install` | Bounded: `install` \| `doctor` \| `migrate` |
| `lorekit.cli.outcome` | `ok` | `ok` \| `error` |
| `lorekit.cli.exit_code` | `0` | Command exit code |
| `lorekit.cli.flag.<name>` | `true` | Only when set; allow-list: `global`, `project`, `deep`, `yes`, `force`, `no-hooks` |

**Opt-out / config:**

- `LOREKIT_TELEMETRY=0` (or `off` / `false` / `no` / `disable`) disables export.
- The cross-vendor `DO_NOT_TRACK=1` also disables it.
- Standard `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` override
  the baked-in defaults.
- With no OTLP endpoint (or no auth for the default endpoint) resolvable, export
  is a no-op and the command runs with zero overhead.

The default endpoint + token live in `packages/cli/src/telemetry.mjs` and are
**public by design** — anyone can unpack the npm tarball and read them. The token
**MUST be a Dash0 ingesting-only token** scoped to the CLI dataset (write spans,
never read/query/manage). Leave `DEFAULT_TOKEN` empty to keep default export off.

---

## Resource attributes

All signals carry these resource attributes:

| Attribute | Value |
|-----------|-------|
| `service.namespace` | `lorekit` |
| `service.name` | `mcp` (Edge Function), `web` (Next.js), or `lorekit-cli` (CLI) |
| `service.version` | Git SHA (`VERCEL_GIT_COMMIT_SHA`) or `unknown`; the package version for the CLI |
| `deployment.environment.name` | `production` / `preview` / `development` / `local` (not set by the CLI) |

---

## Setup

### Edge Function (Deno)

Add two Supabase secrets:

```bash
supabase secrets set \
  OTEL_EXPORTER_OTLP_ENDPOINT=https://ingress.europe-west4.gcp.dash0-dev.com \
  OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <DASH0_AUTH_TOKEN> \
  --project-ref pqokxlhvnosogizsjztg
```

Then redeploy: `pnpm nx fn:deploy supabase`

### Next.js server (Vercel)

Add to Vercel → Settings → Environment Variables:

```
OTEL_EXPORTER_OTLP_ENDPOINT   https://ingress.europe-west4.gcp.dash0-dev.com
OTEL_EXPORTER_OTLP_HEADERS    Authorization=Bearer <DASH0_AUTH_TOKEN>
```

`VERCEL_GIT_COMMIT_SHA` and `VERCEL_ENV` are injected automatically by Vercel.

### Browser RUM

Add to Vercel → Environment Variables (all environments):

```
NEXT_PUBLIC_DASH0_OTLP_ENDPOINT   https://ingress.europe-west4.gcp.dash0-dev.com
NEXT_PUBLIC_DASH0_AUTH_TOKEN      <ingesting-only-token>
NEXT_PUBLIC_SUPABASE_PROJECT_REF  pqokxlhvnosogizsjztg
```

> **Security:** `NEXT_PUBLIC_DASH0_AUTH_TOKEN` is embedded in the browser bundle. Create a **separate** auth token in Dash0 with **Ingesting only** permissions, scoped to the `lorekit` dataset.

After adding variables, **Redeploy** in Vercel — `NEXT_PUBLIC_*` vars are baked into the bundle at build time.

### CLI (`@lorekit/cli`)

The token is **not committed to git** — it is injected into the published tarball
at release time from a GitHub Actions secret, so it can be rotated without a code
change. The endpoint (`DEFAULT_ENDPOINT`) and dataset (`DEFAULT_DATASET`) are
committed defaults in `packages/cli/src/telemetry.mjs`.

1. Create a Dash0 token with **Ingesting only** permissions (it can `POST` spans
   but cannot read, query, or manage anything — same reasoning as the browser
   `NEXT_PUBLIC_DASH0_AUTH_TOKEN` above; it is public once published).
2. Add it under **Settings → Secrets and variables → Actions** as the repository
   secret **`LOREKIT_TELEMETRY_TOKEN`**.

The `publish-cli` job in `.github/workflows/release.yml` runs
`scripts/inject-telemetry-token.mjs`, which rewrites the committed-empty
`src/telemetry-token.mjs` with the secret just before `npm publish`. If the
secret is unset the script no-ops and the CLI ships with default telemetry off.

**Auth-header priority at runtime** (highest first): `OTEL_EXPORTER_OTLP_HEADERS`
→ `LOREKIT_TELEMETRY_TOKEN` (bare bearer via env — handy for local testing) →
the baked-in token. End users can opt out entirely with `LOREKIT_TELEMETRY=0` or
`DO_NOT_TRACK=1`, or point the CLI at their own collector with
`OTEL_EXPORTER_OTLP_ENDPOINT` / `_HEADERS`.

---

## Verifying telemetry

### Edge Function
After a `memory.write` call, check Dash0 → Explore → filter `service.name = mcp` and `service.namespace = lorekit`.

### CLI
After running `lorekit doctor` (with `DEFAULT_TOKEN` set, or `OTEL_EXPORTER_OTLP_*` exported), check Dash0 → Explore → filter `service.name = lorekit-cli` and `service.namespace = lorekit`. Group by `lorekit.cli.command` to count `install` vs `doctor` vs `migrate`.

### Browser
Open Chrome DevTools → Network → filter by `v1/traces`. You should see POST requests to the Dash0 OTLP endpoint after page load and on each navigation.

### Quick console check (browser)
```js
// Run in the browser console on the deployed app:
process.env.NEXT_PUBLIC_DASH0_OTLP_ENDPOINT
// Should return the Dash0 endpoint URL, not undefined
```

If `undefined`, the env var wasn't set when the build ran — add it and redeploy.

---

## Local development (no Dash0)

To see spans in your terminal without sending to Dash0, the Edge Function logs to console when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. For the Next.js app, you can temporarily override:

```bash
OTEL_TRACES_EXPORTER=console OTEL_METRICS_EXPORTER=console pnpm nx serve web
```
