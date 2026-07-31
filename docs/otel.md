# OpenTelemetry & Dash0

LoreKit emits traces, metrics, and logs to Dash0 from every layer of the stack.

## What's instrumented

| Layer | SDK | Signals |
|-------|-----|---------|
| Edge Function (Deno) | Lightweight OTLP/JSON via `fetch()` | Traces per tool call + webhook; DB child spans named by SQL statement |
| Next.js server | `@vercel/otel` | HTTP server spans, Supabase query spans, custom INTERNAL spans for every mutating server action |
| Browser (RUM) | `@dash0/sdk-web` | Page loads, navigation, Web Vitals, fetch tracing, errors, sessions |
| CLI (`@lorekit/cli`) | Lightweight OTLP/JSON via `fetch()` (zero-dep, no SDK) | One span + one counter point per human-facing command (`install` / `uninstall` / `doctor` / `list` / `search` / `show` / `stats` / `scopes` / `diff` / `tree` / `lint` / `dedupe` / `migrate`) |

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
| `lorekit.plan` | `free` | User's plan at call time |
| `lorekit.duration_ms` | `42` | Wall-clock handler duration (milliseconds) |
| `lorekit.write.inserted` | `true` | Write path only: `true` = new row, `false` = update |
| `lorekit.value.bytes` | `312` | Write path only: byte length of the value |
| `lorekit.tags.count` | `2` | Write path only: number of tags supplied |
| `lorekit.result.count` | `17` | List / search results: row count returned |

Rate-limit attributes on the root `lorekit.mcp` span:

| Attribute | Example | Notes |
|-----------|---------|-------|
| `rate_limit.allowed` | `true` | Whether the request was allowed |
| `rate_limit.current_count` | `47` | Current window request count |
| `rate_limit.limit_value` | `120` | Effective RPM limit |

---

## Structured usage events (`usage_events` table)

In addition to OTLP traces, every significant tool call outcome is recorded as
a lightweight structured row in the `usage_events` Postgres table
(`supabase/migrations/00034_usage_events.sql`). These rows live **in Postgres,
not in Dash0** — use Supabase's SQL editor or a direct DB connection to query
them, not the Dash0 Explore UI. They are intentionally **flat and categorical**
(no PII, no key/value/scope strings) so they can be used for plan-sizing
analysis without a Dash0 token:

```sql
-- Daily active writers (free plan)
select date_trunc('day', created_at) as day, count(distinct user_id) as writers
  from usage_events
 where tool_name = 'memory.write'
   and outcome = 'ok'
   and plan_name = 'free'
 group by 1 order by 1 desc;

-- Cap-hit rate per plan — use to calibrate plan thresholds
select plan_name, count(*) filter (where outcome = 'cap_exceeded') as cap_hits,
       count(*) as total_writes,
       round(100.0 * count(*) filter (where outcome = 'cap_exceeded') / nullif(count(*), 0), 1) as pct
  from usage_events
 where tool_name = 'memory.write'
 group by plan_name;

-- p50 / p95 write duration per tool
select tool_name,
       percentile_cont(0.50) within group (order by duration_ms) as p50_ms,
       percentile_cont(0.95) within group (order by duration_ms) as p95_ms
  from usage_events
 where outcome = 'ok'
 group by tool_name order by tool_name;
```

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | `uuid` | Supabase auth user UUID (pseudonymous, never email/handle) |
| `org_id` | `uuid` | Set for org-owned writes, null for personal |
| `plan_name` | `text` | `'free'` or a future plan name |
| `tool_name` | `text` | e.g. `memory.write`, `memory.search`, `transport` (rate-limit) |
| `scope_type` | `text` | `global` \| `project` \| `repo` \| `branch` \| `null` (org tools) |
| `auth_type` | `text` | `api_key` \| `jwt` (excludes service-role) |
| `outcome` | `text` | `ok` \| `cap_exceeded` \| `rate_limited` \| `permission_denied` \| `error` |
| `duration_ms` | `integer` | Wall-clock handler time |
| `memory_count` | `integer` | Active memories at write time (write path only, future use) |
| `created_at` | `timestamptz` | Event timestamp |

Rows are retained for **90 days** and purged weekly by `lorekit_purge_old_usage_events()`.
Users can read their own rows (self-service "my usage" view via RLS).

---

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
| `lorekit.cli.command` | `install` | Bounded: `install` \| `uninstall` \| `doctor` \| `list` \| `search` \| `show` \| `stats` \| `scopes` \| `diff` \| `tree` \| `lint` \| `dedupe` \| `migrate` |
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

## Next.js server-action spans

Every mutating server action in `packages/web/src/lib/` emits an `INTERNAL`
span via the shared `withSpan` helper in `lib/telemetry.ts`.
Auto-instrumentation from `@vercel/otel` already covers the HTTP server boundary
and the outbound Supabase fetch calls; the custom spans add business context
(org IDs, invite types, token permissions) to those auto-instrumented trees.

### Org lifecycle (`lib/orgs.ts`)

| Span name | Key attributes |
|-----------|---------------|
| `lorekit.org.create` | `lorekit.org.slug`, `lorekit.org.id` (on success) |
| `lorekit.org.rename` | `lorekit.org.id` |
| `lorekit.org.delete` | `lorekit.org.id` |
| `lorekit.org.member.remove` | `lorekit.org.id` |
| `lorekit.org.member.change_role` | `lorekit.org.id`, `lorekit.org.member.role` |
| `lorekit.org.leave` | `lorekit.org.id` |

### Invite lifecycle (`lib/org-invites.ts`)

| Span name | Key attributes |
|-----------|---------------|
| `lorekit.org.invite.member` | `lorekit.org.id`, `lorekit.invite.role`, `lorekit.invite.type` (`email`\|`handle`), `lorekit.invite.id` (on success) |
| `lorekit.org.invite.revoke` | `lorekit.invite.id` |
| `lorekit.org.invite.accept` | `lorekit.invite.id` |
| `lorekit.org.invite.decline` | `lorekit.invite.id` |

### API token management (`lib/tokens.ts`)

| Span name | Key attributes |
|-----------|---------------|
| `lorekit.api_token.generate` | `lorekit.api_token.permissions`, `lorekit.api_token.id` (on success), `lorekit.api_token.limit_reached` (when cap is hit) |
| `lorekit.api_token.revoke` | `lorekit.api_token.id`, `lorekit.api_token.prefix` |

On **any RPC/DB failure** the span also carries:

| Attribute | Value |
|-----------|-------|
| `error.type` | The error class (e.g. `SupabaseRpcError`, `SupabaseInsertError`) |
| Span status | `ERROR` with `{ErrorClass}: {message}` |

A structured error log record is emitted to stdout with `exception.type`,
`exception.message`, `exception.stacktrace`, and `trace_id` + `span_id` for
span↔log correlation.

---

## Invite-email span

The org-invite email send (`packages/web/src/lib/invite-email.ts`) is a
deliberately **non-throwing** side effect — it swallows every failure so a bad
key or unverified domain can't break the invite. That makes telemetry the *only*
way to see a failed or skipped send, so it carries an explicit span even though
`@vercel/otel` already auto-instruments the outbound Resend `fetch`.

```
lorekit.invite.email.send   (INTERNAL — one per email-invite send attempt)
```

| Attribute | Example | Notes |
|-----------|---------|-------|
| `lorekit.invite.role` | `member` | Role the invitee was offered |
| `lorekit.invite.email.outcome` | `sent` | Bounded: `sent` \| `skipped_no_recipient` \| `skipped_no_api_key` \| `error` |
| `lorekit.invite.email.status_code` | `422` | Only on a non-2xx Resend response |

On failure the span sets `ERROR` status and emits a structured error log record
(not `span.recordException()` which uses the deprecated Span Event API — see
[spans.md §"Recording exceptions"](https://github.com/dash0hq/agent-skills/blob/main/skills/otel-instrumentation/rules/spans.md)).
The
recipient email and org name are deliberately **not** attributed (PII). Group by
`lorekit.invite.email.outcome` in Dash0 to watch send health; a rising `error`
rate means the Resend key/domain needs attention.

---

## Resource attributes

All signals carry these resource attributes:

| Attribute | Value |
|-----------|-------|
| `service.namespace` | `lorekit` |
| `service.name` | `api` (Edge Functions), `web` (Next.js), `mcp-node` (Node MCP server), or `cli` (CLI) |
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
change. The endpoint (`DEFAULT_ENDPOINT`) and dataset (`DEFAULT_DATASET`, now
`default`) are committed defaults in `packages/cli/src/telemetry.mjs`.

**Dataset precedence** (highest first): an explicit `Dash0-Dataset` passed via
`OTEL_EXPORTER_OTLP_HEADERS` is preserved and never overwritten; otherwise
`DASH0_DATASET`; otherwise the `default` fallback. The edge functions
(`_shared/otel.ts`) follow the same order.

> **Note:** the CLI `service.name` was `lorekit-cli` before this and is now `cli`
> (aligning with the namespace-grouped `api` / `web` / `mcp-node` names). This is a
> rename, not an alias — CLI telemetry emitted before and after the change lives
> under two distinct `service.name` values in Dash0. Query `service.namespace = lorekit`
> to see the CLI across both, or union `service.name in (cli, lorekit-cli)` for history.

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
After running `lorekit doctor` (with `DEFAULT_TOKEN` set, or `OTEL_EXPORTER_OTLP_*` exported), check Dash0 → Explore → filter `service.name = cli` and `service.namespace = lorekit`. Group by `lorekit.cli.command` to count across `install`, `doctor`, `list`, `scopes`, `diff`, and the other human-facing commands.

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
