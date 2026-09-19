# Loop health — keeping it firing, clean, and honest

A wired loop is not a working loop. This file is the maintenance layer: how to tell the
loop is firing at all, how to catch a lesson that will never match the read that should
surface it, how to roll back a bad lesson without losing the evidence, how to stop the
bucket bloating, and how to keep every body honest. Most of it is a check you run once
at wiring time; the rest the `lorekit-groom` skill automates.

## Contents

- [Is the loop firing?](#is-the-loop-firing)
- [Does the write match the read? (matchability check)](#does-the-write-match-the-read-matchability-check)
- [Rolling back a bad lesson: quarantine, not delete](#rolling-back-a-bad-lesson-quarantine-not-delete)
- [Keep the bucket from bloating](#keep-the-bucket-from-bloating)
- [The body contract is now enforced](#the-body-contract-is-now-enforced)

---

## Is the loop firing?

The most common silent failure is a loop that never runs — a read step behind a
condition that is never true, or a `memory.*` connection that quietly dropped. Silence
looks identical to "no failures happened."

Turn the absence into a presence with a **canary**: at wiring time, plant one canary
lesson per bucket with a unique key and a `ttl_days` shorter than the loop's cadence.

```text
memory.write {
  scope:    "repo::<owner>/<repo>",
  key:      "<host>-lessons::canary",
  value:    "# Canary — if the read step surfaced this, the loop's read path works.",
  tags:     ["loop::<host>-lessons", "status::canary"],
  trigger:  "manual",
  ttl_days: <shorter than the loop's run cadence>
}
```

If the loop is alive, its own read/write touches the canary and the store's usage
telemetry records it; if the canary quietly expires without ever being touched, the loop
is not firing — a diagnosable signal where silence was not. Check recency with
`lorekit stats` / `lorekit list --tags loop::<host>-lessons`. Exclude `status::canary`
from the run's actual considerations.

## Does the write match the read? (matchability check)

A lesson that the read step will never surface is dead on arrival — and you only find
out much later, when the same failure recurs and the loop "did not help." The only
moment you can catch it is at **write** time, when you still know what the lesson was
supposed to catch.

Right after writing a failure lesson, re-query the store with the **same terms the read
step uses** and confirm the just-written lesson comes back:

```text
memory.search { q: "<the failure's key terms>", scopes: ["repo::<owner>/<repo>", "global"], limit: 10 }
# Is the lesson you just wrote in the results? If not, its tags / Applies-when / scope
# do not match how the read step looks for it — fix them NOW, while you have the context.
```

A miss means a mismatch between how the lesson was written and how it will be sought —
usually a too-specific **Applies when**, a wrong scope, or a missing tag. Fixing it at
write time is cheap; discovering it at the next failure is not.

## Rolling back a bad lesson: quarantine, not delete

A loop can store a wrong conclusion. Deleting it destroys the evidence of *what the
agent believed* when it got stuck — which is exactly the forensic value you want right
after the harm. Prefer a reversible demotion:

1. **Quarantine** the suspect lesson: add a `status::quarantine` tag and shorten its
   `ttl_days`. The start-of-run read filters `status::quarantine` OUT, so it stops
   biasing runs, but it survives long enough for a human to inspect it.
2. **Inspect**, decide: rewrite it (a real lesson, badly phrased) or let it expire (a
   genuine mistake).
3. **Protect** a lesson a human has vetted with `memory.protect`, so grooming and
   auto-quarantine never touch it.

Delete only a lesson that is both wrong *and* worthless to inspect. Quarantine is the
default; deletion is the exception.

## Keep the bucket from bloating

Every lesson in a bucket competes for the run's read budget. Two mechanisms keep it
bounded:

- **The injection cap (a wiring precondition).** The loop reads at most N lessons into a
  run (the recipe cards default N = 5). This bounds read cost *regardless* of how big the
  bucket grows — it is the backstop.
- **Grooming.** Run the `lorekit-groom` skill periodically to merge near-duplicates,
  expire the stale, and retire the never-opened (low pull-through). Grooming is where a
  bucket's total size is actually reduced; the cap only bounds what a single run reads.

A bucket whose read is always dominated by low-value lessons is a grooming problem, not
a reason to raise the cap.

## The body contract is now enforced

Every lesson body is markdown for humans — no HTML comment, no front-matter, no JSON
blob, no `key=value` header ([the full contract](./self-improvement-loops.md#never-put-machine-metadata-in-the-body)).
This is no longer honor-system:

- **`lorekit lint` flags a violation.** A body containing `<!-- meta` / any `<!--`
  block, leading front-matter (`---`), or a `key=value` header before the `#` title is
  reported by the `hidden-metadata` lint rule. Run `lorekit lint` after a batch of
  writes.
- **The `lorekit-groom` skill cleans legacy offenders.** The store still contains records
  written under the old `<!-- meta: seen_count=… status=… trigger-context=… -->`
  convention (which this skill once prescribed and now forbids); grooming detects them,
  folds any recoverable value into the proper column/tag/field, and strips the block. See
  the `lorekit-groom` skill.
- **The matchability check above** is the natural moment to also eyeball the body: if you
  find yourself reaching for a compact hidden header, stop — every fact in it has a
  first-class field.

Never write a hidden block. It renders to nothing for a human and its baked-in values
silently disagree with the store's own columns.
