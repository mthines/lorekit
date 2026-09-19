# Recipe card — CI job (state record, not a lesson)

For a **deterministic job** — a GitHub Actions workflow, a cron script, a release
pipeline — that needs to know *what happened last time*: which tests flaked, the last
benchmark number, the last deployed SHA. This is **not** a lessons loop: nothing here
is authored or interpreted by a model, so there is no `seen_count`, no promotion, no
entrenchment guard. A different, smaller set of guards applies. Full rule:
[ci-state-records.md](../rules/ci-state-records.md).

Fill in: `<job>` (e.g. `test`), `<slug>` (e.g. `flaky-tests`), `<owner>/<repo>`.

> Use `actions/cache` instead if **only** the next CI run will ever read this. LoreKit
> earns its place only when the fact is *also* useful to an agent or a human.

## Bucket

- Tag `ci::<job>-state` (deliberately NOT `loop::…`). Key `ci-state::<slug>`, one slug
  per fact, **overwritten in place** — never one key per run.
- Taxonomy: pass `--kind bus --host ci` explicitly, or the record leaks into every
  session's SessionStart digest as a raw JSON blob.

## Record shape (versioned JSON)

```json
{
  "v": 1,
  "updated_by_run": "https://github.com/<owner>/<repo>/actions/runs/123",
  "commit": "0f4a1c9…",
  "data": { "flaky": ["src/queue.test.ts::retries on 429"], "consecutive_green": 3 }
}
```

## Read step — early in the job

```bash
set -euo pipefail
STATE_JSON='{}'
if lorekit show --scope "repo::<owner>/<repo>" --key 'ci-state::<slug>' --remote --json > state.json 2>&1; then
  cat state.json                                   # always echo — never `|| true`
  STATE_JSON=$(jq -r '.remote.record.value // "{}"' state.json)
else
  cat state.json
  echo "No prior state (first run, or LoreKit unreachable) — continuing with defaults."
fi
VERSION=$(jq -r '.v // 0' <<<"$STATE_JSON")
[ "$VERSION" = "1" ] || { echo "State schema v${VERSION} != v1 — rebuilding."; STATE_JSON='{}'; }
```

`lorekit show` exits 1 on a miss — that is the first run, branch on it; do not `|| true`
it away (that swallows a real auth/network failure too).

## Write step — end of job (`if: always()` if state should survive a failing run)

```bash
set -euo pipefail
jq -nc \
  --arg run "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
  --arg sha "${GITHUB_SHA}" \
  --argjson data "$NEW_DATA" \
  '{v: 1, updated_by_run: $run, commit: $sha, data: $data}' \
| lorekit write \
    --scope "repo::<owner>/<repo>" --key 'ci-state::<slug>' \
    --tags 'ci::<job>-state' --kind bus --host ci \
    --ttl-days 7 --remote --json \
| tee write.log \
|| echo "LoreKit write failed (exit $?) — not failing the build; see output above."
```

`--ttl-days` is **not optional** and should be short (7 for daily jobs) — it refreshes
every write, so it expires only when the *job* goes silent. See
[TTL is a liveness guard](../rules/ci-state-records.md#ttl-is-a-liveness-guard).

## Tokens

Write with a **write-only `lk_wo_*`** token (a leaked CI token then cannot exfiltrate
the team's lore); read with `lk_ro_*`; use `lk_rw_*` only where one job genuinely needs
both.

## Guards (do not skip)

Bounded cardinality (one key per fact) · no secrets, ever (build the payload from an
allow-list, never `env | jq -R`) · explicit short TTL · never on the critical path
(a store outage logs and continues) · last-write-wins (serialise with a `concurrency`
group) · version every record. Full list:
[Guards](../rules/ci-state-records.md#guards-do-not-skip-these).

## Verify

Run the job twice; confirm `lorekit list --kind bus --host ci` still shows **one** row
per fact (key count must not grow with run count).
