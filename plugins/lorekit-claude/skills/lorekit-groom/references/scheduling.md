# Grooming on a schedule

A store that is groomed only when someone remembers to drifts between passes.
A schedule keeps it healthy, but only the parts of grooming that need no
judgement can run unattended. Split the work three ways:

| Work | Who runs it | Cadence | Mutates? |
|------|-------------|---------|----------|
| **Prune by inactivity** — archive lessons nobody opens | the server's nightly sweep, through an `auto` retention policy | nightly (03:17 UTC) | archive only, reversible |
| **Report** — lint, dedupe clusters, promotion and prune candidates | a scheduled agent job that only reads | weekly, per busy scope | never |
| **Decide** — merges, promotions into rules, deletes | a human, from the report | when the report lands | after confirmation |

The one rule of grooming still holds: **a scheduled job proposes, a human
confirms.** The only exception is the archive an `auto` policy does, and only
after that policy has been run in `review` mode and its matches read.

---

## 1. Prune with a retention policy, not an agent

The server already sweeps every enabled `auto` policy nightly and archives what
matches. That beats an agent-run prune: it is deterministic, it sees
`last_opened_at` directly, and it never deletes.

Write the conditions from the lifecycle fields (the same ones `list --json`
reports). A lesson is a prune candidate when it is old enough to have been
needed, nobody has opened it recently, and it never recurred:

```bash
# 1. Start in review mode: a policy that only reports what it would archive.
lorekit policy create --scope repo::acme/api --name stale-one-offs \
  --mode review --min-age-days 30 --unseen-days 90 --max-seen-count 1 \
  --tags codebase-knowledge --tags-mode none

# 2. Read what it would archive. Every match should be a lesson you would archive by hand.
lorekit groom --policy-id <id>

# 3. Only then let the nightly sweep run it.
lorekit policy update <id> --mode auto --enabled
```

```text
✗ policy create --mode auto --enabled --unseen-days 30          # first night archives lessons nobody reviewed
✓ policy create --mode review …  →  groom --policy-id <id>  →  policy update <id> --mode auto --enabled
```

- **Condition on opens, never on reads.** `--unseen-days` and
  `--max-opened-count` count deliberate single-lesson reads. Do not use
  `--max-read-count` to find unused lessons: every listing, including the weekly
  report job below, adds a bulk read to each row it returns, so that condition
  would never match a lesson the report looked at.
- **Always set `--max-seen-count 1` (or similarly low).** A lesson that recurred
  is a promotion candidate, not a prune candidate, however long since it was
  opened.
- **Exclude `codebase-knowledge`** (`--tags codebase-knowledge --tags-mode none`):
  it is a structural signal store, never pruned by age.
- **Protect what must survive** with `lorekit pin <scope::key>`: a pinned lesson
  is skipped by every policy and every `groom --run`.
- **One policy per scope.** A store-wide policy cannot tell a short-lived branch
  scope from a durable repo scope; branch scopes can take a tighter rule.

## 2. Report weekly with a read-only job

The judgement work — what to merge, what to promote, which lint findings to fix —
needs a report a human can act on in one sitting. A scheduled agent job (a cron
routine, a CI schedule) produces it, with a token that has **read** permission
only, so it cannot mutate even by mistake.

The job, per scope with lessons in it:

1. `lorekit lint --json --scope <scope>` — structural findings.
2. `lorekit dedupe --json --scope <scope> --threshold 0.85` — clusters; each
   member carries `seen_count`, `last_opened_at`, and a `preview`, so the report
   can name the merge keeper without a `show` per member.
3. `lorekit list --all --json --scope <scope>` — promotion candidates
   (`seen_count >= 3`, or a `status::structural` tag, not yet `status::promoted`)
   and lessons with no `expires_at`.
4. `lorekit groom --policy-id <id>` for each `review` policy — what it would
   archive.
5. Write one report: the proposed plan of the grooming pass (Phase 4), grouped
   MERGE / PROMOTE / EXPIRE / ARCHIVE, with real keys and previews. Post it where
   the owner reads it (an issue, a draft PR for promotions, a message).

```text
✗ weekly job with an lk_rw_* token that archives its own dedupe clusters   # merges are judgement calls
✓ weekly job with a read-only token that posts the plan; a human applies it with the grooming pass
```

A **promotion** in the report is a proposed edit to the host's rule file (the
slow tier, see `lorekit-setup`), so the most useful form is a draft PR with that
edit and the lesson keys it promotes. Tag each promoted lesson
`status::promoted` once the PR merges, so the next report does not propose it
again.

## 3. Pick the cadence from the store's rate, not the calendar

| Signal | Cadence |
|--------|---------|
| Under ~50 new lessons a week in the scope | weekly report, or fortnightly |
| More than that, or several loops writing to one scope | weekly report, plus a key-prefix dedupe per loop (`--key-prefix <loop>-lessons::`) |
| Branch scopes | rely on the TTL the writer set; a branch policy with `--unseen-days 14` catches the rest |
| A report with nothing to act on three weeks running | halve the cadence |

## 4. Check the schedule is working

- `lorekit stats --scope <scope>` before and after a month: the count should
  level off rather than climb in a straight line.
- The report's MERGE and lint sections should shrink week over week; if the
  same cluster appears three weeks running, nobody is acting on the report, so
  fix the delivery before adding automation.
- A lesson that an `auto` policy archived and an agent then needed shows up as
  a restore (`lorekit restore`). One restore means the policy is too tight:
  raise `--unseen-days`.
