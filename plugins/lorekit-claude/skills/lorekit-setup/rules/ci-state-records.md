# CI state records (programmatic, non-LLM memories)

Use this when the host is a **deterministic job** — a GitHub Actions workflow, a
cron script, a release pipeline — that needs to know **what happened last time**:
which tests flaked, what the last benchmark number was, which SHA was deployed,
what it already notified about.

This is the same LoreKit store the lessons loop uses, but a different **shape** of
record. Nothing here is written or interpreted by a model, so the whole apparatus
of [self-improvement-loops.md](./self-improvement-loops.md) — prose lessons,
`seen_count` recurrence, promotion, entrenchment guards — does not apply. A
different, smaller set of guards applies instead.

## Contents

- [When this is the right tool (and when it is not)](#when-this-is-the-right-tool-and-when-it-is-not)
- [State record vs. lesson](#state-record-vs-lesson)
- [The cardinality rule](#the-cardinality-rule)
- [Conventions](#conventions)
- [The record shape](#the-record-shape)
- [Read step](#read-step)
- [Write step](#write-step)
- [TTL is a liveness guard](#ttl-is-a-liveness-guard)
- [Worked example — GitHub Actions flaky-test tracker](#worked-example--github-actions-flaky-test-tracker)
- [Guards (do not skip these)](#guards-do-not-skip-these)
- [The payoff — CI and agents share one store](#the-payoff--ci-and-agents-share-one-store)
- [Wiring checklist](#wiring-checklist)

---

## When this is the right tool (and when it is not)

Reach for a LoreKit state record when **both** hold:

- The job needs a **small, current** fact from previous runs — the latest value,
  not a history.
- That fact is **also useful to an agent or a human**, not just to the next run of
  the same job.

Use something else when:

| Need | Use instead |
| ---- | ----------- |
| Pure job-to-job caching, nobody else reads it | `actions/cache` — free, unlimited, built for this |
| A full run history / time series | Artifacts, a metrics backend, or your OTel pipeline |
| Large payloads (coverage reports, logs, traces) | Artifacts — the value cap is 64 KiB |
| A mutual-exclusion lock between concurrent jobs | A real lock (concurrency groups, an advisory lock) — writes here are last-write-wins with no compare-and-swap |
| Anything derived from a secret | Nothing. Do not store it. |

The second bullet of the "both" test is what earns LoreKit over `actions/cache`.
If only the next CI run will ever read it, `actions/cache` is the better answer and
this rule should say so out loud rather than sell the store.

---

## State record vs. lesson

|  | Lesson (`self-improvement-loops.md`) | CI state record (this file) |
| --- | --- | --- |
| Author | a model, at the end of a run | a script, deterministically |
| Value | prose + a `meta:` comment | JSON (an object, not a bare scalar) |
| How a reader uses it | **advisory** — a consideration that can be overridden | **authoritative** — parsed and branched on |
| Recurrence / promotion | yes (`seen_count`, human-gated hardening) | n/a — nothing is inferred, so nothing needs gating |
| Entrenchment risk | high — the reason those guards exist | none; the risks are cardinality and secrets instead |
| Key count over time | grows with distinct lessons | **fixed** — see below |
| Token | the agent's `lk_rw_*` | the job's `lk_wo_*` to write, `lk_ro_*` to read |

Because a state record is parsed rather than read, it must be **valid JSON on
every write** and **version-stamped**, so a reader written against v1 can detect a
v2 record instead of silently mis-parsing it.

---

## The cardinality rule

**One key per fact, overwritten in place. Never one key per run.**

This is the single constraint that keeps the idea sound, and it is easy to get
wrong — "record the state of the last run" reads like an append. It is not.

Same `scope` + `key` is an UPDATE, so a job that writes
`ci-state::flaky-tests` on every run holds **one** row forever, no matter how many
times it runs. A job that writes `ci-state::run-${{ github.run_id }}` adds a row
per run and will, in order: crowd the agent context window, blow the 5 000-memory
cap, and turn a memory store into a bad artifact bucket.

Three concrete limits make this a hard rule rather than a style preference:

- **64 KiB** per value (`MAX_VALUE_BYTES`) — a 400 above it.
- **5 000** active memories per user by default, enforced by a DB trigger.
- **120 requests/min** per user across every LoreKit surface.

And one soft limit that bites sooner: the agent SessionStart hook lists each scope
with a **read cap and no tag filter**, ordered by recency. Per-run CI writes are
the most recently updated rows in the repo scope, so they would displace the
lessons the hook exists to inject. Bounded cardinality is what keeps CI records
cheap enough to live in the same scope agents read.

---

## Conventions

Give the state its own bucket, in a namespace that can never be mistaken for a
lesson bucket:

- **Tag:** `ci::<job>-state` — e.g. `ci::test-state`, `ci::deploy-state`.
  Deliberately **not** `loop::…`; that prefix is the lessons grammar.
- **Key:** `ci-state::<slug>` — e.g. `ci-state::flaky-tests`. One slug per fact.
- **Taxonomy:** pass `--kind bus --host ci` explicitly. `kind`/`host` are only
  inferred from `loop::` tags, so a `ci::` tag leaves them NULL unless you say so.
  Setting them buys `lorekit list --kind bus --host ci` — one command that shows
  every state record and nothing else.

Scope, by what the fact is about:

- **`repo::{owner}/{repo}`** — the default. Trunk state: flaky tests, the last
  deployed SHA, a benchmark baseline.
- **`branch::{owner}/{repo}::{branch}`** — per-PR state that should disappear with
  the branch (what this PR's last run already commented on). Pair it with
  `--ttl-days` so it self-cleans.
- **`global`** — almost never. A CI fact is repo-bound by construction.

---

## The record shape

A JSON object with a version stamp and a provenance block, so a reader can tell
which run produced it and whether it understands the format:

```json
{
  "v": 1,
  "updated_by_run": "https://github.com/owner/repo/actions/runs/123456789",
  "commit": "0f4a1c9…",
  "data": {
    "flaky": ["src/queue.test.ts::retries on 429", "src/auth.test.ts::refresh"],
    "consecutive_green": 3
  }
}
```

Rules that make it safe to parse:

- `v` is required and bumped on any breaking shape change. A reader that sees an
  unknown `v` **falls back to its first-run path and logs it** — it never guesses.
- Everything mutable lives under `data`, so the envelope stays stable.
- No secrets, no tokens, no full environment dumps, no raw log bodies (see
  [Guards](#guards-do-not-skip-these)).

---

## Read step

Address the record with **`--scope` and `--key` flags, not the single-token
`<scope::key>` form** — the key itself contains `::`, and flags are the only
unambiguous way to express that.

```bash
set -euo pipefail

STATE_JSON='{}'
if lorekit show --scope "repo::${REPO}" --key 'ci-state::flaky-tests' \
     --remote --json > state-raw.json 2>&1; then
  cat state-raw.json                                   # the log-visibility rule: always echo
  STATE_JSON=$(jq -r '.remote.record.value // "{}"' state-raw.json)
else
  cat state-raw.json
  echo "No prior state (first run, or LoreKit unreachable) — continuing with defaults."
fi

VERSION=$(jq -r '.v // 0' <<<"$STATE_JSON")
if [ "$VERSION" != "1" ]; then
  echo "State schema v${VERSION} is not v1 — ignoring it and rebuilding from scratch."
  STATE_JSON='{}'
fi
```

Two things this deliberately gets right:

- **`lorekit show` exits 1 on a miss.** That is not an error condition here — the
  first run of any new state record misses. Branch on it; do not `|| true` it away,
  which would swallow a genuine auth or network failure too.
- **A LoreKit outage degrades to the first-run path.** The job continues; it does
  not fail. See [Guards](#guards-do-not-skip-these).

---

## Write step

```bash
set -euo pipefail

jq -nc \
  --arg run "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
  --arg sha "${GITHUB_SHA}" \
  --argjson data "$NEW_DATA" \
  '{v: 1, updated_by_run: $run, commit: $sha, data: $data}' \
| lorekit write \
    --scope "repo::${REPO}" \
    --key 'ci-state::flaky-tests' \
    --tags 'ci::test-state' \
    --kind bus --host ci \
    --ttl-days 7 \
    --remote --json \
| tee write-result.json
```

Notes on each flag that is not obvious:

- **`--ttl-days` is not optional, and it should be short.** See
  [TTL is a liveness guard](#ttl-is-a-liveness-guard) — the countdown refreshes on
  every write, so a short TTL expires the record only when the *job* stops running.
  Never omit it: a write passing neither `--ttl-days` nor `--clear-ttl` inherits
  whatever `ttl.default` / `scope.defaults.<prefix>.ttl_days` the repo config
  happens to set for lessons, which is a number nobody chose for this record.
- **No value argument** — `lorekit write` reads stdin when none is given, which is
  what makes the `jq | lorekit write` pipe work.
- **`--remote`** — be explicit. A CI checkout has no offline store, and picking the
  target by inference is not something to leave to chance in a pipeline.
- **`--kind bus --host ci`** — see [Conventions](#conventions).

The token comes from `LOREKIT_TOKEN` in the environment. Use a **write-only
`lk_wo_*` token for the writing job**: it cannot read anything back, so a leaked CI
token cannot exfiltrate the team's lore. Where the same job must also read, it needs
`lk_rw_*` — split the steps and use two tokens if the read is small enough to
justify it.

Over REST instead of the CLI, the equivalents are `POST /memories` (write) and
`GET /memories?scope=…&key=…` (read), same auth header. The CLI is preferred in CI
because it derives `origin` (repo / branch / commit / PR) from the GitHub Actions
environment automatically, which is what makes each record traceable back to the
run that wrote it in the dashboard.

---

## TTL is a liveness guard

**Default to a short TTL — roughly a week — not a permanent record.** This is the
opposite of the instinct that "state must persist", and it follows from one detail
of the write path.

`memory_write` computes `expires_at = now() + ttl_days` on **every** write, insert
or update (`supabase/migrations/00030_memory_ttl.sql`: `expires_at = case when
p_ttl_days is not null then v_expires_at else memories.expires_at end`). The job
rewrites its record on every run and passes `--ttl-days` every time, so the
countdown restarts every run.

That makes the TTL measure **how long the job has been silent**, not how old the
record is. A record expires when — and only when — the job stopped running for that
long, which is exactly when its contents stopped being true. A daily job with a
7-day TTL keeps its state indefinitely while it runs daily, and drops it a week
after someone deletes the workflow.

| Job cadence | TTL | Why |
| ----------- | --- | --- |
| Every push / per-PR | **7 days** | Survives a feature freeze or a quiet holiday week; an abandoned job self-cleans |
| Nightly | **14 days** | Tolerates a fortnight of red or paused schedules |
| Weekly (release, audit) | **30 days** | ~4 missed runs of slack |
| Branch-scoped, any cadence | **7 days or less** | The branch outlives the state; let it decay with the PR |

Pick the number so a *normal* quiet spell does not expire the record, and an
abandoned job does. Do not reach for 365 to be safe — that is just "permanent" with
extra steps, and it re-creates the failure below.

Two things this buys beyond freshness:

- **A stale record is worse than a missing one.** Falling back to the first-run path
  is a defined, tested code path. Acting on a flaky-test set from four months ago is
  not — it is silently wrong, and nothing surfaces that.
- **It bounds the blast radius of a cardinality mistake.** [The cardinality
  rule](#the-cardinality-rule) is a discipline, and disciplines get violated. If
  someone keys on `github.run_id` anyway, a 7-day TTL turns unbounded growth into a
  bounded steady state that drains itself — the store stops filling instead of
  climbing to the 5 000-memory cap.

**`--clear-ttl` is the rare exception, not the default.** Reserve it for a record
whose *absence* is more dangerous than its staleness — a migration watermark, say.
If you find yourself there, ask first whether the fact belongs in a best-effort
memory store at all rather than in the datastore that owns it.

---

## Worked example — GitHub Actions flaky-test tracker

Applies the usual workflow-authoring rules (the `github-actions-author` skill in
[mthines/agent-skills](https://github.com/mthines/agent-skills) is the reference):
named steps, least-privilege `permissions`, SHA-pinned third-party actions,
`concurrency` without cancellation (a cancelled run must not leave half-written
state), `set -euo pipefail`, and every command's output reaching the run log.

```yaml
name: Tests

on:
  push:
    branches: [main]
    paths: ['src/**', 'package-lock.json', '.github/workflows/tests.yml']

permissions:
  contents: read

concurrency:
  group: tests-${{ github.ref }}
  cancel-in-progress: false        # never abandon a run mid-state-write

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      LOREKIT_TOKEN: ${{ secrets.LOREKIT_TOKEN_RW }}
      REPO: ${{ github.repository }}
    steps:
      - name: Check out the repository
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

      - name: Set up Node.js
        uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: |
          set -euo pipefail
          npm ci 2>&1 | tee install.log

      - name: Read the known-flaky set from LoreKit
        run: |
          set -euo pipefail
          KNOWN='[]'
          if npx --yes @lorekit/cli@latest show \
               --scope "repo::${REPO}" --key 'ci-state::flaky-tests' \
               --remote --json > state.json 2>&1; then
            cat state.json
            KNOWN=$(jq -c '(.remote.record.value // "{}") | fromjson
                           | if .v == 1 then .data.flaky else [] end' state.json)
          else
            cat state.json
            echo "No prior flaky state — treating every failure as new."
          fi
          echo "KNOWN_FLAKY=${KNOWN}" >> "$GITHUB_ENV"
          echo "Known flaky on entry: ${KNOWN}"

      - name: Run the test suite
        id: tests
        run: |
          set -euo pipefail
          npm test -- --reporter=default --reporter=json --outputFile=results.json 2>&1 \
            | tee test-output.log

      - name: Record the flaky set back to LoreKit
        if: always()
        run: |
          set -euo pipefail
          FLAKY=$(jq -c '[.testResults[]? | select(.status == "failed") | .name]' results.json)
          jq -nc \
            --arg run "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
            --arg sha "${GITHUB_SHA}" \
            --argjson flaky "$FLAKY" \
            '{v: 1, updated_by_run: $run, commit: $sha, data: {flaky: $flaky}}' \
          | npx --yes @lorekit/cli@latest write \
              --scope "repo::${REPO}" --key 'ci-state::flaky-tests' \
              --tags 'ci::test-state' --kind bus --host ci \
              --ttl-days 7 --remote --json \
          | tee lorekit-write.log \
          || echo "LoreKit write failed (exit $?) — not failing the build; see the output above."
```

The last step is `if: always()` and its failure is swallowed **with the output
echoed and the exit code named** — a memory store being down is never a reason to
turn a green test run red, but a silent `|| true` would hide a misconfigured token
for months.

---

## Guards (do not skip these)

The lessons loop's entrenchment guards do not apply — nothing here is inferred. These
do:

1. **Bounded cardinality.** One key per fact, overwritten in place. If the number
   of keys a job writes grows with the number of runs, the design is wrong. See
   [The cardinality rule](#the-cardinality-rule).
2. **No secrets, ever — and the bar is higher here than for lessons.** A lesson is
   drafted by a model that can be told to redact; a state record is assembled
   mechanically from a CI environment that is *full* of tokens. Never
   `env | jq -R`, never a raw log body, never an error string that might carry a
   connection URL. Build the payload from an explicit allow-list of fields.
3. **Expiry is explicit, and short by default.** Pass `--ttl-days` sized to the
   job's cadence (~7 days for anything running at least daily). It refreshes on
   every write, so it expires only when the job goes silent — see
   [TTL is a liveness guard](#ttl-is-a-liveness-guard). Never inherit the config
   default by accident, and reserve `--clear-ttl` for the rare record whose absence
   is worse than its staleness.
4. **The store is never on the critical path.** A read miss falls back to the
   first-run path; a write failure is logged and swallowed. A LoreKit outage must
   not fail a build — but it must be *visible* in the log, never `|| true`-d away.
5. **Last write wins; there is no compare-and-swap.** Two concurrent jobs writing
   the same key will clobber each other. Either write from one job, or serialise
   with a `concurrency` group, or shard the key.
6. **Version every record.** An unrecognised `v` means fall back to the first-run
   path and log it — never parse a shape you do not recognise.
7. **Remember agents read this scope.** State records land in `repo::` alongside
   lessons and will surface in an agent's SessionStart injection. That is the point
   (see below) — but it means the value should read sensibly to a human skimming
   it, and stay small.

---

## The payoff — CI and agents share one store

Job-to-job persistence alone does not justify LoreKit over `actions/cache`. What
does is that **both sides of the loop read the same store**:

- CI writes `ci-state::flaky-tests` deterministically on every run of `main`.
- An agent asked to "fix the flaky tests" reads it at SessionStart — the same repo
  scope, no extra wiring — and starts from the real list instead of re-deriving it.
- The agent's own findings go back as a **lesson** in the `loop::` bucket, in the
  same repo scope, where the next human and the next agent both see it.
- The dashboard shows both, with each state record linked back to the exact
  workflow run that wrote it via the derived `origin`.

So the two record kinds are complementary, not competing: the state record carries
**what is true right now**, the lesson carries **what we learned about it**. Keep
them in separate buckets (`ci::` vs `loop::`) so each can be read, filtered, and
groomed on its own terms.

---

## Wiring checklist

To add CI state to a job called `<job>`:

- [ ] Confirm the fact is small, current-only, and useful to more than the next CI
      run — otherwise use `actions/cache`.
- [ ] Pick the bucket: tag `ci::<job>-state`, key `ci-state::<slug>`, one slug per
      fact, `--kind bus --host ci`.
- [ ] Pick the scope: `repo::` for trunk state, `branch::` for per-PR state.
- [ ] Pick the TTL from the job's cadence (7 / 14 / 30 days — see the table). Short
      by default; `--clear-ttl` only with a reason.
- [ ] Define the JSON envelope with a `v` stamp, and the reader's unknown-version
      fallback.
- [ ] Add the **read step** early in the job (`--scope`/`--key` flags, exit-1-is-a-miss
      branch, output echoed).
- [ ] Add the **write step** at the end (`if: always()` if the state should survive a
      failing run), `--ttl-days` passed on EVERY write, failure swallowed but logged.
- [ ] Provision tokens: `lk_wo_*` for a write-only job, `lk_ro_*` for a read-only
      one, `lk_rw_*` only where one job genuinely needs both.
- [ ] Verify the payload is built from an explicit allow-list of fields, with no
      environment dump and no raw error bodies.
- [ ] Confirm the key count does not grow with run count — run the job twice and
      check `lorekit list --kind bus --host ci` still shows one row per fact.
