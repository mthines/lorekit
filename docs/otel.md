# OpenTelemetry & Dash0

LoreKit emits traces, metrics, and logs to Dash0 from every layer of the stack.

## What's instrumented

| Layer | SDK | Signals |
|-------|-----|---------|
| Edge Function (Deno) | Lightweight OTLP/JSON via `fetch()` | Traces per tool call + webhook; DB child spans named by SQL statement; self-time attribution on every root span; Postgres query-cost metrics (opt-in) |
| Next.js server | `@vercel/otel` | HTTP server spans, Supabase query spans, custom INTERNAL spans for every mutating server action |
| Browser (RUM) | `@dash0/sdk-web` | Page loads, navigation, Web Vitals, fetch tracing, errors, sessions |
| CLI (`@lorekit/cli`) | Lightweight OTLP/JSON via `fetch()` (zero-dep, no SDK) | One span + one counter point per human-facing command (`install` / `uninstall` / `doctor` / `list` / `search` / `show` / `stats` / `scopes` / `diff` / `tree` / `lint` / `dedupe` / `link` / `migrate`) |

All signals carry `service.namespace=lorekit` so you can filter the full stack in one Dash0 query.

> **Profiles are not among the signals, and cannot be.** Dash0 collects profiles
> with a host-level eBPF agent and LoreKit has no host to run one on. What
> replaces it: [self-time attribution](#self-time-attribution-every-root-request-span)
> per request, and [query-level profiling](#query-level-profiling) from
> `pg_stat_statements`. The full reasoning is in that second section — read it
> before proposing a profiler.

> For how the four services correlate into one trace (W3C `traceparent`
> propagation), a review of telemetry quality against the OTel semantic
> conventions, and the tests that guard both, see
> [telemetry-quality-review.md](./telemetry-quality-review.md).

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
| `lorekit.scope.type` | `repo` | `global` \| `project` \| `repo` \| `branch` \| `mixed` (a multi-type `memory.search`) \| `invalid` (ungrammatical input). **Omitted entirely** when the operation carries no scope — never a placeholder. Resolved by the shared `scope-type-attribute.ts` |
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

### Self-time attribution (every root request span)

`traceRequest` splits each request's duration into time spent waiting on
something else and time spent in our own code. Stamped on **every** root span of
**every** edge function — these are numeric measures, not dimensions, so they add
no cardinality and need no sampling.

| Attribute | Example | Notes |
|-----------|---------|-------|
| `lorekit.io.wait_ms` | `38` | Wall-clock ms with at least one outbound (CLIENT) call in flight. Concurrent calls count **once** |
| `lorekit.io.calls` | `3` | How many outbound calls were made. Summed, not merged — this is what separates an N+1 from one slow query |
| `lorekit.self_time_ms` | `7` | Request duration no child span accounts for: scope expansion, payload building, JSON, runtime overhead |

This is the closest thing to a CPU profile a Supabase Edge Function can produce
— see [Query-level profiling](#query-level-profiling) for why an actual profiler
is not an option. Any span with `kind = CLIENT` feeds the ledger, so a
hand-rolled `span.child(..., SPAN_KIND_CLIENT)` around a `fetch` is attributed
without touching the helper.

The intervals are **merged, not summed**, and that is the whole subtlety.
Handlers issue concurrent queries (`Promise.all`); adding two 40 ms queries that
ran side by side would claim 80 ms of wait in a request that waited 40, and the
self time computed from it would go negative — reading as "instant" on exactly
the requests worth investigating. The merge lives in the pure
`packages/mcp-core/src/io-ledger.ts` (mirrored to `_shared/`) so it is unit
tested rather than only observable as a wrong number on a chart.

Useful queries:

- `lorekit.self_time_ms` high with `lorekit.io.calls` low → our code is the cost.
- `lorekit.io.calls` high with each DB span short → an N+1; look at the child spans.
- `lorekit.io.wait_ms` ≈ the span duration → we are purely waiting on Postgres;
  go to the query metrics below.

---

## Query-level profiling

### Why there is no CPU profiler

Dash0 collects profiles with a **host-level eBPF agent** (the OpenTelemetry eBPF
profiler, deployed by the Dash0 Kubernetes operator). LoreKit has no host to run
one on: every runtime is managed serverless — Supabase Edge Functions on managed
Deno isolates, the dashboard on Vercel. There is no node, no DaemonSet, and no
privileged sidecar. Supabase's edge runtime also exposes no userland V8 profiler
to sample from.

The in-process alternative does not exist yet either: OTLP **profiles** reached
public Alpha in March 2026, the SIG states it should not be used for critical
production workloads, and the JS SDK has no profiles exporter
([opentelemetry-js#6500](https://github.com/open-telemetry/opentelemetry-js/issues/6500)).
There is no Deno equivalent at all.

And it would tell us little. These handlers are I/O-bound, so a sampled stack is
mostly "awaiting fetch". `createTracedClient` already opens a CLIENT span per
round-trip, so the trace waterfall already attributes request time to specific
queries — better than a profile would.

**`packages/mcp-server/` is the one component that could be truly profiled**, if
it were ever deployed to a VM or Kubernetes where the eBPF profiler can attach.
Nothing deploys it today.

### What we profile instead

The time goes into SQL, and Postgres already profiles itself.
`pg_stat_statements` holds **server-side cost per statement shape, aggregated
across every caller** — the one thing per-request CLIENT spans cannot see, since
they time each round-trip from the caller's side, one request at a time.

```
pg_cron (every minute)
  └── lorekit_export_db_query_stats()      ← inert without vault secrets
        └── pg_net → POST /functions/v1/profiling
              └── lorekit_db_query_stats(20)          ← top-N reader RPC
                    └── buildDbQueryMetrics()          ← pure mapper
                          └── POST → Dash0 /v1/metrics
```

Three metrics, all **cumulative monotonic sums**:

| Metric | Unit | Meaning |
|--------|------|---------|
| `lorekit.db.query.time` | `s` | Cumulative server-side execution time per statement shape |
| `lorekit.db.query.calls` | `{call}` | Cumulative executions |
| `lorekit.db.query.rows` | `{row}` | Cumulative rows returned or affected |

Datapoint attributes — all bounded:

| Attribute | Example | Notes |
|-----------|---------|-------|
| `db.queryid` | `-3590487284026153938` | `pg_stat_statements.queryid`, as a **string** — it is an int64 and would lose precision as a JSON number |
| `db.query.text` | `insert into memories(scope,key,value) values ($1,$2,$3)` | The normalised statement, whitespace-collapsed and truncated to 512 chars |
| `db.query.toplevel` | `false` | `false` = executed inside a function body. LoreKit's writes run inside RPCs, so the outer `select memory_write(...)` and its inner statements both appear; **filter on this or you double-count** |
| `db.system` | `postgresql` | |

There is deliberately **no tenant dimension**. `pg_stat_statements` aggregates by
statement shape across all callers, so it has no user to attribute a row to, and
inventing one would both lie and make the cardinality unbounded.

Mean latency is a derived query — `rate(lorekit.db.query.time) /
rate(lorekit.db.query.calls)` — rather than a fourth metric that could disagree
with the other two.

### Why cumulative, not deltas

`pg_stat_statements` counters are cumulative since `stats_reset`, and they are
exported that way: each datapoint's `startTimeUnixNano` carries the reset
timestamp, so Dash0 does the differencing and reads a reset as a **new series**
rather than as negative traffic. Computing deltas in the exporter would mean
persisting the previous snapshot somewhere and re-implementing reset detection in
a new place.

A consequence worth knowing: a dropped scrape costs **resolution, not data** —
the next scrape still carries the full cumulative total. That is why the cron
poke is fire-and-forget.

### Cardinality

Each statement is one series **per metric**, so top-N is the dial. The endpoint
defaults to 20 and `lorekit_db_query_stats()` caps it at **200** regardless of
what is asked for. Membership of the top-N changes over time, so series appear
and disappear — expected, and the reason the cap is enforced in the RPC rather
than trusted to the caller.

### Turning it on

**Off by default** — the same posture as the embedding pipeline
([embeddings.md](./embeddings.md)). Migration `00074` ships the reader, the
exporter and the cron schedule, but the exporter returns `disabled` and posts
nothing until an operator provisions two Vault secrets:

```sql
select vault.create_secret(
  'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/profiling',
  'lorekit_profiling_url');
select vault.create_secret('<service-role-key>', 'lorekit_profiling_key');
```

The gate is in one place, so this is the whole switch: no migration re-run and no
schedule edit. Turn it off again by deleting either secret.

Requires the `pg_stat_statements` extension (Supabase preloads it). It needs no
new Dash0 credentials — the `profiling` function exports through the same
`OTEL_EXPORTER_OTLP_*` secrets every other function already uses.

### The row-scaling sweep

`scripts/sweep-rows.mjs` is the companion experiment to the metrics above, and
it answers a different question. The query metrics tell you what production is
doing *now*; the sweep tells you what it will do at 10× the rows — by growing
one user to 100k and measuring the same probes at each rung.

```bash
pnpm nx sweep supabase                                   # defaults
node scripts/sweep-rows.mjs --rungs 1000,5000,25000 --iterations 40
node scripts/sweep-rows.mjs --database-url postgresql://…  # bring your own DB
```

It boots a **throwaway** PostgreSQL cluster, applies
`supabase/tests/bare-postgres-bootstrap.sql` plus every migration, and runs
`supabase/tests/row-scaling-sweep.sql`. Throwaway because the sweep is a
data-shape experiment: index bloat survives a delete, so it must never run
against production and preferably not against a shared preview project.

Local hardware is not Supabase hardware — the findings are the **shape** of the
curve and the **EXPLAIN plans**, never the absolute milliseconds. What it found
about the memory cap is in [limits.md](./limits.md#the-cap-is-also-a-write-cost-parameter).

**Every run exports to Dash0**, so runs are comparable across commits rather
than being a number in a terminal:

| Signal | Name | Notes |
|---|---|---|
| Trace | `lorekit.sweep` + `lorekit.sweep.rung` | Real timestamps from `sweep_phases`. Deliberately no span per probe — a p50 over 25 repetitions is an aggregate, not an interval |
| Gauge | `lorekit.sweep.probe.duration` (`s`) | `{probe, rows, quantile}` |
| Gauge | `lorekit.sweep.growth_factor` (`1`) | `{probe}` — p50 at the top rung ÷ p50 at the bottom. **~1.0 is indexed**; tracking the row multiple is a linear scan |
| Gauge | `lorekit.sweep.index.bytes` (`By`) | `{index}` — write amplification lives here |
| Gauge | `lorekit.sweep.rows` (`1`) | `{kind: total\|focal}` |

Gauges rather than sums because each is a measurement at a point in time (this
run, this commit), not something that accumulates.

The plan's top **scan** node rides on the rung span as `db.plan.node_type` —
`Seq Scan` becoming `Index Only Scan` is the entire signal an index change is
meant to produce, in one low-cardinality attribute rather than a diff of plan
text. (It is the top *scan*, not the outermost node: every probe is a
`count(*)`, so the outermost node is always `Aggregate` and would be constant.)

Resource identity: `service.name=sweep` (its own component, so benchmark
numbers never mix into `api`/`cli`/`web`/`mcp`),
`deployment.environment.name=test` **always** — a benchmark is synthetic by
construction — and `vcs.ref.head.revision` from git, which is what makes a run
attributable to the commit it measured. Compare runs on `service.name=sweep`
keyed by that revision.

Export reuses the CLI's `resolveTelemetryConfig`, so it honours the same token
priority (`OTEL_EXPORTER_OTLP_HEADERS` > `LOREKIT_TELEMETRY_TOKEN` > baked-in),
the same `Dash0-Dataset` routing, and the same opt-outs (`LOREKIT_TELEMETRY`,
`DO_NOT_TRACK`). With no credential it prints `export skipped (no-credential)`
and still shows the tables — the sweep never fails because telemetry could not
be shipped.

### Checking it by hand

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/profiling | jq
```

```json
{ "exported": true, "statements": 20, "datapoints": 60,
  "metrics": ["lorekit.db.query.time", "lorekit.db.query.calls", "lorekit.db.query.rows"] }
```

Status codes are distinct on purpose — a `200` for a failed export would be a
cron job reporting success while nothing reaches Dash0:

| Status | Meaning |
|--------|---------|
| `200` | Exported |
| `401` | Not the service-role key. A user JWT and an `lk_*` token are both refused — these counters are the cluster's, not a caller's |
| `502` | Dash0 rejected the payload or was unreachable |
| `503` | Nothing to send, or nowhere to send it: `pg_stat_statements` absent/unreadable, or `OTEL_EXPORTER_OTLP_ENDPOINT` unset |

The reader never raises. A missing extension, one installed but absent from
`shared_preload_libraries`, a version too old for `toplevel`, or a privilege
refusal all yield zero rows — an observability read must not be the thing that
breaks. The exporter is excluded from its own results (both the RPC and the view
name), or it would climb its own top-N at one scrape a minute and report on
itself forever.

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
| `scope_type` | `text` | `global` \| `project` \| `repo` \| `branch` \| `invalid` (ungrammatical `scope` argument) \| `null` (org tools, and any call with no singular `scope`) |
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
| `lorekit.cli.command` | `install` | Bounded: `install` \| `uninstall` \| `doctor` \| `list` \| `search` \| `show` \| `stats` \| `scopes` \| `diff` \| `tree` \| `lint` \| `dedupe` \| `link` \| `migrate` |
| `lorekit.cli.outcome` | `ok` | `ok` \| `failure` \| `error` — `failure` is a command that RAN and reported a negative verdict (a failing `doctor` check, a `lint` finding); `error` is a crash |
| `lorekit.cli.exit_code` | `0` | Command exit code |
| `lorekit.cli.flag.<name>` | `true` | Only when set; allow-list: `global`, `project`, `deep`, `yes`, `force`, `no-hooks`, `json`, `link` |
| `lorekit.cli.hooks_mode` | `all` | `install` only. Bounded: `all` \| `read-only` \| `none` \| `custom` — which hook wiring the run resolved to (from the flag, the prompt, or the detected state). Counts the CHOICE, not the `--no-hooks` flag |

**`STATUS_CODE_ERROR` is reserved for a CRASH.** A command that ran to completion
and exited non-zero — `doctor` finding a failing check, `lint` finding what it
was asked to look for — keeps the same `STATUS_CODE_OK` span status a successful
run gets, and reports `lorekit.cli.outcome=failure`. Only an unhandled throw sets
`STATUS_CODE_ERROR` (with a bounded, non-PII `errorLabel` message). This keeps
the `cli` service's
error rate a measure of the CLI being broken rather than of an unhealthy user
environment: query failing runs on `lorekit.cli.outcome` / `lorekit.cli.exit_code`,
never on the span status.

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

## Product events (`lib/analytics/track.ts`)

Typed browser events for product surfaces, emitted through the one `track()`
wrapper. Attributes use the `lorekit.*` namespace.

| Event | Emitted when | Attributes |
|-------|--------------|------------|
| `command_palette.opened` | The palette overlay was shown | `lorekit.command_palette.trigger` |
| `command_palette.command_selected` | A command was executed | `lorekit.command.id`, `lorekit.command.source`, `lorekit.command.group` (optional — omitted when the command has no group) |
| `install_command.copied` | A visitor copied a shell command | `lorekit.install_command.id`, `lorekit.install_command.surface`, `lorekit.install_command.succeeded` |

`install_command.copied` exists because copying `npx @lorekit/cli install` is the
strongest intent signal a logged-out visitor can produce short of authenticating
— and, since the CLI works offline with no account, it is a route to *using* the
product that leaves no other trace on the website at all. Without it, a visitor
who read the page, took the command and went to their terminal is
indistinguishable from one who bounced.

It records failures as well as successes (`succeeded=false`). A denied clipboard
— insecure context, hardened browser, dismissed permission prompt — makes the
button silently do nothing, and counting only successes would render that as a
lack of interest rather than a broken affordance.

Both the command and the surface are reported as **bounded ids**, never the
command string: `CopyCommand` takes arbitrary text, which would become unbounded
the moment a call site interpolates into it.

---

## Browser auth events (`auth.*`)

Every authentication surface in the dashboard emits a discrete RUM event through
`packages/web/src/lib/auth-telemetry.ts`. Three event names, one bounded
`auth.method` on each:

| Event | Emitted when | Attributes |
|-------|--------------|------------|
| `auth.option_selected` | The visitor picked a route — any control that moves them onto one, counted at most once per document. The controls are enumerated under ["Selection vs attempt"](#selection-vs-attempt) rather than repeated here, so the two cannot drift | `auth.method`, `auth.intent` |
| `auth.attempt` | The visitor commits to a path — before the network call, and **before** an OAuth redirect navigates the page away | `auth.method`, `auth.intent` |
| `auth.success` | A session exists (or the step completed: reset email sent, password changed) | `auth.method`, `auth.intent` |
| `auth.failure` | The provider rejected the attempt. Severity `WARN`, not `ERROR` — a mistyped password is the system working | `auth.method`, `auth.intent`, `auth.error_code` |

`auth.method` is one of `github_oauth`, `email_password`, `email_password_signup`,
`email_otp`, `email_confirmation`, `password_reset_request`,
`password_reset_complete`, `password_change_settings`.

### Signing up vs signing in

`auth.method` alone does not answer "are people registering or returning?" — it
takes a reader who already knows that `email_password_signup` is registration and
`password_reset_complete` is not. `auth.intent` encodes that once:

| `auth.intent` | Methods |
|---------------|---------|
| `signup` | `email_password_signup`, `email_confirmation` |
| `login` | `email_password` |
| `login_or_signup` | `github_oauth`, `email_otp` |
| `recovery` | `password_reset_request`, `password_reset_complete` |
| `account_management` | `password_change_settings` |

`login_or_signup` is not a hedge. Both of those paths create an account when
there is none and sign the visitor in when there is, and **the browser cannot
know which will happen before it happens**. Collapsing them into either bucket
would be a guess presented as a fact, in the one place the distinction matters
most — GitHub OAuth is the primary CTA.

The answer comes from the server instead. `/api/auth/callback` holds the Supabase
user record, so it sets `auth.outcome` on its `lorekit.auth.callback` span (and
in the `auth.callback.success` log record):

| `auth.outcome` | Meaning |
|----------------|---------|
| `account_created` | `last_sign_in_at` is within 10s of `created_at` — this callback registered the account |
| `returning_sign_in` | The account predates this sign-in |
| `unknown` | A timestamp was missing, unparseable, or ordered nonsensically |

The rule is the pure `classifyAuthOutcome` in `packages/web/src/lib/auth-outcome.ts`.
All three paths land on that route and are classified by the same rule, but the
rule can only separate them on **one** of the three, and reading the attribute
as if it separated all three is the mistake this paragraph exists to prevent:

| Path | What `auth.outcome` says on a first sign-in | Why |
|------|---------------------------------------------|-----|
| `github_oauth` | `account_created` | The insert and the sign-in happen in the same callback, well inside the 10s tolerance |
| `email_otp` (magic link to a new address) | `returning_sign_in` | The account is created when the link is **requested** (`shouldCreateUser: true`, `LoginButton.tsx`); the sign-in only happens when the visitor opens their inbox |
| `email_confirmation` | `returning_sign_in` | `signUp` creates the account, and the confirmation link is opened minutes or hours later |

The two email paths put a human round-trip between `created_at` and
`last_sign_in_at`, so they fall outside a tolerance that exists to absorb write
skew, not inboxes. That is not a bug in the rule — a callback holding only those
two timestamps genuinely cannot tell a confirmation click from a sign-in a week
later — it is the limit of what the rule is allowed to claim.

`unknown` is a real bucket and must stay countable — folding it into
`returning_sign_in` would understate signups by exactly the cases the data is
least sure about.

**So: count acquisition per path, and never infer a signup from
`auth.method = github_oauth`.**

- **OAuth** — `auth.outcome = account_created` on the server. This is the one
  path where the attribute is the acquisition count.
- **Email confirmation** — the `auth.success` event with
  `auth.method = email_confirmation` (`auth.intent = signup`), emitted on
  `/welcome`. Its server-side `auth.outcome` will say `returning_sign_in`; do
  not add the two together.
- **Magic link** — `auth.intent = login_or_signup` is as far as the data goes
  today. A first-time magic-link visitor is not separable from a returning one
  by either signal, so report that population as unresolved rather than
  assigning it to a side.

### Selection vs attempt

`auth.option_selected` and `auth.attempt` are different steps and both are needed:
selecting is "showed interest in this route", attempting is "handed over
credentials". The gap between them is the form-abandonment rate.

Every control that moves the visitor onto a route reports it: the landing
buttons, the "Create an account" / "I already have an account" toggle, the
in-panel switches between the password and magic-link forms, and the return from
the "confirm your email" screen. A route counted only when it was picked from the
landing state would be counted differently depending on which door the visitor
came through.

**A route is selected at most once per document.** The login page's panels can be
toggled back and forth, and every switch is the same visitor showing the same
interest, so `LoginButton` emits each `auth.method` only on its first selection
in that document. Read `option_selected` as *visitors who tried this route* and
`attempt` as *submissions*, which do repeat on a retry — so the gap is the share
of interested visitors who never submitted, not a difference of two like counts.

They exist because two of the three options on the login page were pure local
state changes — they swap a panel, make no network call, and emitted nothing. So
"how many people even tried the email route?" was unanswerable: a visitor who
opened the form, read it and left was indistinguishable from one who never
touched it. Only submissions were visible, which measures the bottom of the
funnel and calls it the top.

On the GitHub path the two coincide (there is no form in between to abandon), and
both are emitted anyway so every option is comparable at the selection step.

`auth.error_code` is Supabase's `code` (`invalid_credentials`,
`email_not_confirmed`, …), falling back to the error `name`, then `unknown`. The
error **message** is deliberately never reported: it is prose, it is localised,
and it can embed the address that was typed — unbounded and PII-bearing, the two
things a grouping key must not be.

The funnel is `auth.attempt` minus `auth.success`, grouped by `auth.method` — for
every method that emits both. Three do not, in different directions, so read
those rows differently:

- `github_oauth` emits an attempt and never a success, so its subtraction is
  always its full attempt count, not a drop-off.
- `email_confirmation` emits a success and never an attempt (`WelcomeContent.tsx`
  is the only call site), so its subtraction is *negative* — the matching intent
  was recorded on the signup page one document earlier, as
  `email_password_signup`.
- `email_password_signup` emits both — but only on the two branches that
  terminate in this document (`data.session` → success, `signUpError` →
  failure). When the project requires confirmation, the attempt ends on the
  "check your inbox" screen having emitted *neither*, for the reason below, so
  its subtraction counts every confirmation-pending signup as drop-off. Those
  are the ones that reappear as `email_confirmation` successes on `/welcome`,
  which is why the two rows have to be read as a pair.

Two paths deliberately emit no `auth.success`:

- **GitHub OAuth** — success is a redirect to a new document, so the page that
  would report it is already gone. Arrival at the destination is the evidence.
- **The "confirm your email" screen** — no session exists yet, and Supabase
  routes an already-registered address down the same branch. Counting it would
  overstate signups *and* leak the distinction the screen exists to hide. That
  path completes as `email_confirmation` on `/welcome`.

> **These used to be signal attributes, and must never go back to being any.**
> The surfaces previously called `addSignalAttribute('auth.method', …)`, which
> attaches a value to *every signal for the rest of the page load*. One click on
> "Continue with GitHub" therefore labelled 538 `browser.web_vital` events across
> 38 sessions; a failed sign-in followed by a switch to "Create an account"
> emitted `auth.method=email_password_signup` next to the previous attempt's
> `auth.password_error_code=invalid_credentials`, a combination the backend
> cannot produce and which read as a signup bug that did not exist; and because
> the function appends rather than replaces (the property `dash0-rum.ts`
> documents for `user.id`), a retry shipped several entries for one key. An
> attribute describes the signal it rides on — use `sendEvent` for a thing that
> happens at an instant.

**Renamed:** `auth.password_error_code` / `auth.otp_error_code` are now one
`auth.error_code`. The method is already on the event, so the per-surface prefix
carried nothing.

---

## Resource attributes

All signals carry these resource attributes:

| Attribute | Value |
|-----------|-------|
| `service.namespace` | `lorekit` |
| `service.name` | `api` (Edge Functions), `web` (Next.js), `mcp` (Node MCP server), or `cli` (CLI) |
| `service.version` | Git SHA (`VERCEL_GIT_COMMIT_SHA`) or `unknown`; the package version for the CLI |
| `deployment.environment.name` | `production` / `preview` / `development` / `local`; the CLI omits it unless overridden. An explicit `DEPLOYMENT_ENVIRONMENT` env var overrides the ambient value on the CLI, the Node MCP server, and the edge (used by `scripts/emit-correlated-trace.mts` and the smoke jobs to stamp `test` — see below); `web` does **not** read it, and derives the value from `VERCEL_ENV` **cross-checked against `NODE_ENV`** — see below. |

### `web` never reports `production` from a dev server

`VERCEL_ENV` is a value, not a proof of where the process runs: `vercel env pull`
writes it — `VERCEL_ENV=production` included — into a local `.env.local`, which
`next dev` then loads like any other env file. Left unchecked, a laptop stamps
every span and RUM event `deployment.environment.name=production`.

That is not hypothetical. A local Turbopack dev server's `ENOENT … .next/server/
app/(auth)/login/page/app-build-manifest.json` failures once pushed the
production `web` SERVER error ratio to 12 % and fired the "Web — high backend
error rate" check rule, while the deployed site was healthy.

So both emitters resolve the tag through one shared pure module,
[`packages/web/src/lib/otel-deployment-env.ts`](../packages/web/src/lib/otel-deployment-env.ts)
(server: `src/instrumentation.ts`; browser: `src/lib/dash0-rum.ts`):

- `NODE_ENV === 'production'` — a real `next build` output, as served by every
  Vercel production and preview deployment. `VERCEL_ENV` is mapped straight
  through. A local `next build && next start` also sets `NODE_ENV=production`,
  so it lands in this branch too: run against a pulled `VERCEL_ENV=production`
  it still reports `production`. That residual is accepted deliberately —
  `otel-deployment-env.ts` documents why gating additionally on `VERCEL` would
  not close it, and `next dev` is the case that caused the incident.
- anything else — a dev server. The result is narrowed to `development` (what
  `vercel dev` genuinely is) or `local`, **never** `production` / `preview`.
  The two outcomes are not equally loud:
  - a claimed `production` / `preview` is **clamped** to `local`, and a one-time
    `console.warn` names the value that was dropped so the developer can clear
    `VERCEL_ENV` out of their local env files.
  - a claimed `development` — what `vercel env pull` writes by default — is
    reported as `development` **silently**: nothing was clamped, so there is
    nothing to warn about, and the dev server's telemetry sits alongside the
    Vercel Development deployment rather than under `local`.

An unrecognised `VERCEL_ENV` (a typo, `staging`, …) falls back to `local` rather
than being passed through, so it can never invent a new environment in Dash0.

### Smoke / test runs are tagged `deployment.environment.name=test`

Every smoke suite in the pipelines (`deploy.yml` smoke-preview/smoke-production,
`preview.yml` smoke, `ci.yml` integration) sets `DEPLOYMENT_ENVIRONMENT=test`, so
all synthetic smoke telemetry filters apart from real traffic in Dash0 — even the
production smoke, which runs against the production deployment. It reaches all
three emitters through one knob:

- **CLI** (`install`, `doctor --deep`): `resolveDeploymentEnvironment` reads
  `DEPLOYMENT_ENVIRONMENT` and stamps the CLI's own resource.
- **Edge** (`api` — every REST/MCP request a smoke makes): the client forwards
  the value as the `X-LoreKit-Deployment-Environment` request header — the CLI's
  `restFetch` does it automatically from the same env var, and the REST/MCP smoke
  specs send it via `testRunHeaders` (`packages/mcp-server/src/smoke-telemetry.ts`).
  `traceRequest` applies it to that request's span batch as
  `deployment.environment.name`. The edge's own `deployment.environment.name` is a
  per-deployment resource attribute it cannot change per request, so the header is
  the seam that lets a smoke request against a production isolate still report
  `test`.

The edge honours **only** the synthetic value `test` from the header (an
allowlist in `resolveEnvironmentOverride`): a caller can mark its own traffic as
synthetic but can never relabel itself `production`/`preview`, and no auth,
tenancy, limit, or behaviour depends on the tag — it is observability only.
`release.yml`'s `doctor --telemetry` ingest probe is tagged `test` the same way.

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
> (aligning with the namespace-grouped `api` / `web` / `mcp` names). This is a
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
`src/telemetry-token.mjs` with the secret just before `npm publish`. Run bare, a
missing secret is a **silent no-op** and the CLI publishes emitting nothing — the
exact failure that goes unnoticed for days. Pass `--require` to make that a failed
release instead; the local, flagless invocation keeps the forgiving behaviour on
purpose. `--require` (and a post-injection `doctor --telemetry` probe) is wired
into the job — see **Wiring the export gate into CI** below for the exact steps.

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

`lorekit doctor --telemetry` is the direct answer to "is the export still
working?". It resolves the same credential a real command would, POSTs one probe
span named `lorekit.cli.doctor.telemetry_probe` to the OTLP endpoint, and **exits
non-zero unless the collector accepted it** — a revoked token, a moved endpoint,
or a build with no credential at all are each a hard failure with its own
message. It is a *focused* run: it skips the skill, backend and scope checks, so
its exit code answers exactly one question and nothing else.

```bash
LOREKIT_TELEMETRY_TOKEN=<ingesting-only token> npx @lorekit/cli doctor --telemetry
```

Probe spans carry `lorekit.telemetry.probe=true` — exclude that attribute when
measuring CLI adoption, or these synthetic runs inflate the numbers.

A plain `lorekit doctor` reports the export as an **info** line only (endpoint,
plus where the credential came from) and never fails on it: an end user who opted
out, or who simply has no phone-home configured, does not have a broken install.

This gate exists because `exportInvocation` swallows transport errors by design —
without an explicit probe, a dead export path has no failure signal anywhere. The
scheduled workflow that runs it is `.github/workflows/telemetry-smoke.yml` — see
**Wiring the export gate into CI** below.

After running `lorekit doctor` (with `DEFAULT_TOKEN` set, or `OTEL_EXPORTER_OTLP_*` exported), check Dash0 → Explore → filter `service.name = cli` and `service.namespace = lorekit`. Group by `lorekit.cli.command` to count across `install`, `doctor`, `list`, `scopes`, `diff`, and the other human-facing commands.

### Wiring the export gate into CI

The flag, the probe and the `--require` guard all work on their own; the two CI
touch-points below are what make the gate run automatically instead of only when
someone remembers. Both are committed — the workflow files themselves are the
source of truth, so consult them directly rather than a copy here.

**1. `release.yml` → `publish-cli` job.** The *Inject telemetry token* step runs
`inject-telemetry-token.mjs --require`, followed by a `doctor --telemetry` probe
of the injected token. `--require` turns a missing secret into a failed release
(a telemetry-blind tarball must never ship silently); the probe then proves the
injected token is actually accepted, so a revoked credential is caught before
publish rather than by someone noticing a flat dashboard days later.

**2. `.github/workflows/telemetry-smoke.yml`.** A release-time check only covers
release days; a token revoked on a quiet Tuesday goes unnoticed until the next
publish. This runs the same `doctor --telemetry` gate on a schedule (plus
`workflow_dispatch` and pushes to `main` touching the export path) and, on
failure, notifies through the same `discord-notify` / `dash0-notify` composite
actions `release.yml` and `deploy.yml` use. No new secret — `LOREKIT_TELEMETRY_TOKEN`
is the one the release job and `emit-trace.yml` share. It runs the CLI from
source (zero-dependency, no install) and probes from `$RUNNER_TEMP` so a
committed `.lorekit.json` can never opt the gate out of its own check.

### Browser
Open Chrome DevTools → Network → filter by `v1/traces`. You should see POST requests to the Dash0 OTLP endpoint after page load and on each navigation.

### Browser errors from extensions are dropped, by STACK not by message

A visitor's browser extension raises its uncaught errors and unhandled promise
rejections on the *page's* `window`, so `@dash0/sdk-web` records them as
`browser.error` events attributed to `service.name=web`. Measured over a week of
production RUM, **102 of 105** browser errors came from two visitors'
extensions — a `chrome-extension://…` script looping
`Cannot read properties of undefined (reading 'M_ID')` every ~2s, plus a
MetaMask `inpage.js` connect failure — against 3 genuine first-party errors.

The filter lives in **`packages/web/src/lib/extension-errors.ts`** (pure
classification) and is installed by `installExtensionErrorFilter()` in
`lib/dash0-rum.ts`, which subscribes to `error` and `unhandledrejection` in the
capture phase and calls `stopImmediatePropagation()` on an extension-only error.

Four things not to "simplify":

- **It must run BEFORE `init()`.** The SDK subscribes inside `init()`
  (`addEventListener('unhandledrejection', …)` plus an override of
  `window.onerror`); window listeners fire in registration order, so
  registering first is what lets `stopImmediatePropagation()` preempt it.
- **Running first is not enough for the `onerror` half.** `window.onerror` is an
  event-handler IDL attribute: its listener slot is created at the FIRST
  non-null assignment and never moves, so the SDK's later assignment inherits
  the slot of anything that set `onerror` before us and runs ahead of the
  filter. `withOnErrorRegisteredLast()` in `lib/dash0-rum.ts` detaches the
  incumbent handler, registers our listeners, then re-assigns it — which moves
  it behind us. Deleting that re-seating makes the uncaught-error half a
  silent no-op on any page that touches `window.onerror` first.
- **It cannot be `ignoreErrorMessages`.** sdk-web 0.23.0's only error filter
  matches its regexes against the error MESSAGE. The extension message above is
  the commonest shape of a real first-party `TypeError`, so a regex wide enough
  to catch it would also silence our own bugs.
- **It drops only when EVERY source-bearing frame is an extension URL.** When an
  extension breaks our code the stack interleaves their frames with ours, and
  that error is our bug — it stays. When the stack proves nothing (no stack, or
  no line naming a source) the event's `filename` is consulted instead, and the
  error is kept unless that names an extension script.

`preventDefault()` is deliberately not called, so the browser still logs the
error to the console.

**What the filter does NOT reach.** Uncaught errors from a cross-origin script —
which every `chrome-extension://` script is — are muted by the browser: the page
gets `Script error.` with `error: null` and `filename: ""`, so there is nothing
to attribute and the event is kept (fail-safe). That is acceptable because both
production fingerprints arrive on the `unhandledrejection` path, where the
`reason` is a real `Error` carrying a full stack. Judge the filter by the
rejection path; the `error` path is a bonus for the cases that do report.

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

## Custom span attributes — propagation & service.name (from CLAUDE.md)

Canonical detail for the **OTel attributes** summary in the root [`CLAUDE.md`](../CLAUDE.md).

### Trace-context propagation (W3C `traceparent`)

- **Who sends it.** The CLI attaches `traceparent` to every outgoing REST call (`restFetch`),
  which is now *every* call its remote store makes — memory ops, `listScopes()`, all four
  `org.*` ops and the `ping` health probe. `packages/cli/src/store/remote.mjs` no longer
  references `mcpCall` at all (guarded by `packages/cli/test/source-hygiene.test.mjs`), so
  there is no second, MCP-shaped propagation path to keep in sync. Values are sourced
  from `getActiveTraceparent()` in `packages/cli/src/telemetry.mjs`. Context is generated for
  **every** `traceCommand` run, including when telemetry export is disabled — propagation is
  decoupled from export. The browser sends it via `@dash0/sdk-web`. The Next.js **server**
  side sends it via `@vercel/otel`'s fetch instrumentation, configured in
  `packages/web/src/instrumentation.ts` — this needs an explicit
  `fetch: { propagateContextUrls: [...] }`, because `@vercel/otel` propagates context ONLY to
  Vercel deployment URLs by default. Without it every server action / RSC call to Supabase
  produced an orphan PostgREST / Edge Function span.
- **The Supabase origin allow-list lives in exactly one place** —
  `packages/web/src/lib/otel-origins.ts` (`supabaseOriginPattern()`), consumed by all three
  web call sites (`instrumentation.ts` server, `lib/dash0-rum.ts` browser) so browser and
  server can never drift. It is dependency-free
  (no React, no `next/*`, no node builtins) because it is evaluated in both the Node runtime
  and the browser bundle, and reads `process.env['NEXT_PUBLIC_SUPABASE_PROJECT_REF']` as a
  literal member expression so Next.js can inline it at build time. The pattern is anchored
  (`^https://…`) so a nested URL such as `https://evil.com/https://<ref>.supabase.co/x` never
  matches and plain `http://` is excluded. When the project ref is **unset** it deliberately
  fails open to any `*.supabase.co` / `*.supabase.in` host (kept so local/preview setups
  without the var still propagate) and emits a one-time `console.warn` so the widening is
  visible rather than silent.
- **Who receives it.** Every edge function's `traceRequest` (`supabase/functions/_shared/otel.ts`)
  parses the inbound header; an invalid one falls back to a new root trace instead of a corrupt
  span. Responses carry a `traceparent` back (exposed via `Access-Control-Expose-Headers`) so a
  client can correlate with the server span.
- **The parser** is `packages/mcp-core/src/trace-context.ts` (`parseTraceparent` /
  `formatTraceparent` / `isValidTraceId` / `isValidSpanId`), import-free and mirrored verbatim
  to `supabase/functions/_shared/trace-context.ts`; drift is parity-guarded by
  `edge-parity.spec.ts`. Strict W3C validation: lowercase hex only, no all-zero ids, version
  `ff` rejected, version `00` fixed at four fields, future versions may append fields.
- **Span kinds.** Root request spans are SERVER (2), `TracedQuery` DB spans are CLIENT (3),
  everything else INTERNAL (1) — required for service-to-service edges in an APM.
- **The sampled flag is recorded and propagated, never acted on.** Edge spans emit
  `flags: sampled ? 1 : 0` and children inherit the parent's flag, but export stays AlwaysOn —
  sampling is deferred to the Dash0 pipeline (see Key decisions). Never turn the flag into a
  drop condition. The CLI emits flags `01` when its span will be exported and `00` when it will
  not, still carrying the trace id either way so the server can correlate.

### `service.name` inventory

Every emitting component and where its `service.name` is configured. A collision here
collapses two components into one indistinguishable node in the service map — keep these
unique.

| `service.name` | Component | Set in |
|---|---|---|
| `api` | **All** Supabase Edge Functions (`memories`, `orgs`, `openapi`, `mcp`, `health`, `blog`) | Hard-coded in `supabase/functions/_shared/otel.ts`. No configuration required. |
| `mcp` | Node MCP server (Fly.io) | `OTEL_SERVICE_NAME`, default in `packages/mcp-server/src/instrumentation.ts` |
| `web` | Next.js (server + browser) | `packages/web/src/instrumentation.ts` (server), `packages/web/src/lib/dash0-rum.ts` (browser). Both pin the literal `web`; `otel-conventions.spec.ts` asserts the two agree, because server and browser are ONE service told apart by `telemetry.sdk.language`, not by name |
| `cli` | CLI | `packages/cli/src/telemetry.mjs` |

- **The edge functions are one service, not five.** They share a deployment, a database and a
  lifecycle; each function is an *operation* on `api`, not a separate service. Splitting them
  fragments the service map for no analytical gain.
- **Tell the functions apart with `faas.name`**, set on every root span by `traceRequest` and
  derived from the operation name (`lorekit.memories` → `memories`, `lorekit.webhook.github` →
  `webhook.github`). The span name carries the same information. A new function gets this for
  free and cannot forget to set it.
- **Do not reintroduce a per-function `SERVICE_NAME` secret.** Supabase secrets are
  project-wide, not per-function, so one value can never name five functions — the previous
  attempt left `mcp` and `health` silently sharing a fallback name. The `SERVICE_NAME` env var
  is still honoured as an escape hatch, but nothing needs to set it and `config.toml` sets none.
- `service.namespace` is **`lorekit`** everywhere — hard-coded in each component's resource
  (including `packages/mcp-server/src/instrumentation.ts`, which no longer delegates it to
  `OTEL_RESOURCE_ATTRIBUTES`), never env-dependent.
- The Node MCP server is `mcp`: the `lorekit` namespace already carries the product, and the
  edge functions report `api` (told apart by `faas.name`), so `mcp` names this Fly.io
  deployment cleanly with no service-map collision. It stays its own service, distinct from the
  edge `api`, because it is a separate deployment (Fly.io) with its own lifecycle.
- The Supabase origin pattern used for browser + server trace-context propagation lives in one
  place: `packages/web/src/lib/otel-origins.ts`.
