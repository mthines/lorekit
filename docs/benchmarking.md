# Benchmarking

Two experiments, and the difference between them decides which one answers your
question. Running the wrong one is the common mistake: they vary different
things and knee for different reasons.

| | **Row-scaling sweep** | **Load test** |
|---|---|---|
| Varies | **data shape** — rows per user | **traffic** — requests/sec |
| Answers | where per-user cost bends; whether a limit is set right | concurrency ceilings; which handler and statement is hot |
| Needs the edge deployed | No — it is all SQL-level | Yes |
| Repeatable against a shared environment | **No** — it permanently changes table size and index bloat | Yes — non-destructive |
| Against production | **Never** | Possible, behind the approval gate |
| Status | **Built** (`scripts/sweep-rows.mjs`) | **Designed, not built** |

A load test measures requests/sec; a per-user cap governs rows. Neither number
tells you about the other, which is why the memory cap was settled with the
sweep and not with load.

---

## The row-scaling sweep

```bash
pnpm nx sweep supabase                                     # defaults
node scripts/sweep-rows.mjs --rungs 1000,5000,25000 --iterations 40
node scripts/sweep-rows.mjs --database-url postgresql://…   # bring your own DB
```

It boots a **throwaway** PostgreSQL 16 cluster, applies
`supabase/tests/bare-postgres-bootstrap.sql` plus every migration, runs
`supabase/tests/row-scaling-sweep.sql`, prints the tables, and exports the run
to Dash0.

Throwaway because this is a data-shape experiment: index bloat survives a
delete, and reclaiming it needs `REINDEX` or `VACUUM FULL`. So it must never run
against production — which shares the `memories` table with real tenants — and
preferably not against a shared preview project either.

### Prerequisites

```bash
pnpm install --frozen-lockfile          # a fresh container's install is incomplete
apt-get install -y postgresql-16-pgvector   # migrations 00060/00062 need `vector`
```

`initdb` must be present, not just `psql` — a client-only install passes the
`psql` check and then fails much later as a confusing "could not connect".
The runner probes for `initdb` for exactly that reason and names the fix.

### Flags

| Flag | Default | |
|---|---|---|
| `--rungs <list>` | `1000,5000,25000,100000` | focal-user row counts to measure at |
| `--users <n>` | `3` | background users |
| `--background-rows <n>` | `2000` | rows per background user (**fixed**, not swept) |
| `--iterations <n>` | `25` | timed repetitions per probe |
| `--database-url <url>` | — | skip cluster setup; the DB **will** be grown |
| `--keep` | off | leave the cluster running to query `sweep_timings` by hand |
| `--dry-run` | off | build both OTLP payloads into `$TMPDIR`, send nothing |

### What it isolates, and what it does not

The sweep moves **one** dimension: rows belonging to one focal user, which is
the dimension a per-user cap governs. Background users are seeded once at a
fixed size so the table and its indexes hold realistic content, but they do not
grow with the rungs. That keeps seeding linear and keeps a knee attributable as
a per-user effect.

**Total table size is a second dimension and the sweep does not vary it.** Raise
`--users` / `--background-rows` to move it. Per-user cost and whole-table cost
have different fixes — a partial index versus partitioning — so mixing them into
one number answers neither.

### Reading the output

Start with the **growth-factor** table, not the raw timings:

- **~1.0×** — flat. The probe is properly indexed.
- **tracking the row multiple** — a linear scan. This is the finding.
- **worse than the row multiple** — super-linear, usually a plan that switched
  to a sequential scan as the table grew.

Then read the two `EXPLAIN` blocks. A heap filter on `archived_at` instead of an
index-only scan is the shape to look for.

Local hardware is not Supabase hardware: the findings are the **shape** of the
curve and the **query plans**, never the absolute milliseconds.

### What it found

The memory cap is also a write-cost parameter, because `enforce_memory_cap()`
runs a `count(*)` over the user's active rows on every insert and no index covers
that predicate on the personal branch. The measurements, the org-branch control
that isolates the cause, and the one-line index that fixes it are in
**[limits.md → "The cap is also a WRITE-COST parameter"](./limits.md#the-cap-is-also-a-write-cost-parameter)**.
Not repeated here — one home per fact.

### Telemetry

Every run exports a trace plus four gauges under `service.name=sweep`, keyed by
`vcs.ref.head.revision`, so runs are comparable across commits instead of being
a number in a terminal. The signal list, the attribute contract and the
`db.plan.node_type` dimension are in
**[otel.md → "The row-scaling sweep"](./otel.md#the-row-scaling-sweep)**.

Verifying a run landed (traces are queryable; the gauge read-back path is an
open question below):

```bash
curl -sS -X POST \
  "https://api.europe-west4.gcp.dash0-dev.com/api/spans?dataset=default" \
  -H "Authorization: Bearer $DASH0_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"timeRange":{"from":"2026-08-22T00:00:00Z","to":"2026-08-22T23:59:59Z"},
       "filter":[{"key":"service.name","operator":"is","value":"sweep"}],
       "pageSize":50}'
```

Filter on `service.name = sweep`, **not** `deployment.environment.name = test` —
the daily smoke jobs carry that value too.

> **In a cloud sandbox, run the export with `NODE_USE_ENV_PROXY=1`.** Node's
> built-in `fetch` ignores `HTTPS_PROXY`, so without it the POST goes direct and
> returns `403 Host not in allowlist` **for a host that is allowlisted**. See the
> sandbox baseline in the root `CLAUDE.md`, point 6.

---

## The load test — planned, not built

Recorded here so the design is not re-derived, and so the constraints that shape
it are not rediscovered the hard way.

### The rate limit decides the design

The limit is **already per-user**: `rate_limit_counters` is keyed
`(user_id, window_start)` and the ceiling comes from
`lorekit_get_limit(p_user_id, 'requests_per_minute')`. So **N seeded users give
N × 120 req/min** with no code change.

Coverage is asymmetric, and this is what a load test has to work around:

| Surface | Rate limited? |
|---|---|
| MCP | **Yes** — every method (`supabase/functions/mcp/index.ts`) |
| REST writes | Only `POST /memories` (`create.ts`) and the two purge handlers |
| REST reads | **No** |

A naive load script against MCP measures the rate limiter, not the system.

### Which surfaces

**REST as the generator.** REST and MCP converge on the same handlers and the
same SQL — the expensive part is shared, and REST reads are the only surface
that can actually be pushed.

**MCP gets a thin arm, not a throughput test.** The dispatcher is a genuinely
distinct path worth measuring (JSON-RPC parse, tool gating, the usage-event
write, the concurrent plan + rate-limit round-trip), but the 2 rps ceiling
forbids more than a fixed low rate.

**The CLI gets nothing.** It is a REST client, so it adds no server-side path;
load-testing it measures node startup on the runner. CLI hook latency is a real
question but it is a single-shot benchmark, a different instrument.

### Scaling users, not limits

Raise **`max_memories`** for the seeded users — writes accumulate across runs and
you do not want run 5 failing on a cap, and a higher ceiling distorts nothing.

Do **not** raise `requests_per_minute` to concentrate load on one user. The
counter is `on conflict (user_id, window_start) do update set count = count + 1`,
so every concurrent request from one user contends on a **single row**. Raising
one user's limit and pushing hundreds of rps builds a hot row production never
sees — measuring lock serialization you invented. N users across N counter rows
is both realistic and free of the artifact.

Either limit is a one-row `user_limits` upsert (service-role; there is no
insert/update RLS on that table by design), and `user_limits.user_id` is
`references auth.users on delete cascade`, so deleting a test user cleans up its
override.

### Workflow shape

A GitHub Actions workflow, because the target must be configurable between
preview and production:

```yaml
on:
  workflow_dispatch:
    inputs:
      target:   { type: choice, options: [preview, production], default: preview }
      rps:      { default: '20' }
      duration: { default: '120' }
      users:    { default: '5' }
  schedule: [{ cron: '25 5 * * 1' }]   # preview only — never prod on a timer
```

- `environment: ${{ inputs.target }}` — production inherits the **existing
  approval gate** `deploy.yml` already uses. That is a real guard; a typed
  confirmation input is not.
- `concurrency: { group: load-${{ inputs.target }}, cancel-in-progress: false }`
  — matching `deploy.yml`'s posture, because a cancelled load test leaves rows.
- Cleanup in `if: always()` through `scripts/smoke-cleanup.mjs`'s existing
  guards. Reuse `seed-smoke-user.mjs` and the anchored name pattern rather than
  inventing a data path — a load run creates orders of magnitude more rows than
  a smoke test, and those guards are load-bearing.
- Stamp `X-LoreKit-Deployment-Environment: test` and a correlation id of
  `gh-run-<run_id>`, so the run filters apart in Dash0 and `?correlation_id=`
  scopes the usage read to it.

### Method

- **Open loop** — a fixed arrival rate, not N workers in a loop. Closed-loop
  hides latency under coordinated omission: when the server slows you send fewer
  requests and the numbers flatter you.
- **p50 / p95 / p99 plus 429 and 5xx counts.** Never means.
- **Warm up and discard.** The edge is serverless; cold starts dominate the
  first requests.
- **Snapshot `lorekit_db_query_stats` before and after and diff it.** The
  counters are cumulative, so a raw top-N is dominated by history. The diff is
  the sharpest output a run can produce: "62 % of p95 was SQL, and here are the
  three statements."

**Caveat worth stating up front:** a shared 2-core runner saturates before the
target at any real concurrency, and network variance adds latency noise — so
distrust the client-side p95. It matters less than it sounds, because
`lorekit.self_time_ms`, `lorekit.io.wait_ms` and the `lorekit.db.query.*` metrics
are measured **server-side** and are robust to a noisy client. That is what makes
a cheap runner acceptable.

A production run writes real rows into the shared table and consumes real Dash0
ingest quota. Worth having, as a deliberate and approved occasional thing.

---

## Open questions

| Question | State |
|---|---|
| Apply the `(user_id) where archived_at is null` partial index? | Recommended by the sweep, deliberately not bundled with the profiling PR. Re-run the sweep afterwards and confirm `db.plan.node_type` flips to `Index Only Scan` before moving the cap. |
| Should REST reads be rate limited? | MCP gates every method; REST gates only `create.ts` and the purge handlers. Whether the asymmetry is intended needs a decision — independent of benchmarking. |
| How are the sweep's gauges read back? | Ingest returns 2xx and the traces are queryable through `/api/spans`; the query path for metrics has not been found. Until it is, gauge exports are ingest-confirmed only. |
| Has `migrations.test.sql` ever run? | Its `PROF-*` assertions have not — `supabase start` needs Docker, which cloud sandboxes lack. CI's `Integration smoke` job is the first place they execute. |
