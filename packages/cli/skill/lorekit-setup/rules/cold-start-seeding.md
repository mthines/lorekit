# Cold-start seeding — value on run one

The honest cold start is a lie. A loop does not really begin empty — the lessons already
exist, scattered across git history, PR review threads, CI guard scripts, and the
`obligations-map`. They were just never written down as reusable memory. Seeding
harvests a *handful* of them so the loop's very first run reads real institutional
knowledge instead of nothing.

This is optional, and it trades one thing for another — read
[the measurement trade-off](#the-hard-rule-never-seed-a-loop-you-will-measure) before
you reach for it.

## Contents

- [When to seed (and when not to)](#when-to-seed-and-when-not-to)
- [The cap: a handful, hand-checked](#the-cap-a-handful-hand-checked)
- [The hard rule: never seed a loop you will measure](#the-hard-rule-never-seed-a-loop-you-will-measure)
- [Where the lessons already are](#where-the-lessons-already-are)
- [The flow](#the-flow)
- [Guards](#guards)

---

## When to seed (and when not to)

Seed when the host's value is **invisible for its first week** — lessons only accrue on
repeated runs, so a freshly-wired loop delivers config, not a win, and people abandon
it before it pays off. A few real seeded lessons make run one useful.

Do **not** seed when you intend to *prove* the loop's lift (below), or when you cannot
find genuinely recurring pain to seed from — a fabricated lesson is worse than an empty
bucket.

## The cap: a handful, hand-checked

**Seed a handful (roughly ≤ 5), each one hand-checked. Never bulk-mine.** This is the
single most important rule here, and it runs against the instinct to "import everything."

Bulk seeding floods the bucket with generic, machine-drafted lessons that never get
opened. That tanks the exact pull-through ratio [proving-improvement.md](./proving-improvement.md)
reads, triggers the bucket-bloat [loop-health.md](./loop-health.md#keep-the-bucket-from-bloating)
fights, and buries the few seeds that were actually good — on day one. A small,
curated set is worth more than a large, automatic one.

## The hard rule: never seed a loop you will measure

Seeding writes lessons before the loop has run, so it **erases the clean baseline** the
immunity re-challenge needs. A seeded loop's improvement is unattributable — you cannot
tell the loop's own learning from the head start you handed it.

So it is one or the other, per loop:

| You want… | Then… |
| --------- | ----- |
| Value on run one | Seed it (a handful, curated). Accept that its lift is not cleanly provable. |
| Provable lift | Leave it cold. The first weeks are quieter, but the immunity check reads a real baseline. |

## Where the lessons already are

Mine these — they are recurring pain the team already paid for:

- **Git fix/revert chains** — the same pattern fixed the same way 3+ times, or a
  revert-then-refix. `git log`, `git log --grep=revert`, `git log -p` over a hot file.
- **Recurring PR review comments** — the same review note left across many PRs.
- **Existing CI guard scripts** — a guard that exists *is* a lesson someone learned;
  seed a `codebase-knowledge` fact pointing at it.
- **The `obligations-map`** — its path-keyed partnerships are compiled lessons; the
  ones not yet gating are candidates. `lorekit invariants candidates` surfaces clusters.
- **`lorekit dedupe`** — near-duplicate existing lessons that should be one seed.

## The flow

1. **Mine** one or two of the sources above for genuinely recurring pain.
2. **Draft** ≤ 5 candidate lessons to the normal body shape
   ([the lesson record](./self-improvement-loops.md#the-lesson-record)) — a takeaway
   title, a concrete **Applies when**, a prescriptive **Do this instead**.
3. **A human approves** the survivors. This is not skippable; seeding is the one place
   a bad lesson enters with no recurrence evidence behind it.
4. **Write** each with provenance and a `source::seed` tag, so seeds are auditable and
   distinguishable from earned lessons:

   ```text
   memory.write {
     scope:       "<global | repo::<owner>/<repo>>",
     key:         "<host>-lessons::<slug>",
     value:       "<markdown lesson body — no hidden blocks>",
     tags:        ["loop::<host>-lessons", "source::seed"],
     trigger:     "manual",
     origin_commit: "<the commit this was learned from, if any>",
     ttl_days:    90
   }
   ```

## Guards

- **The body contract still applies** — seeds are markdown for humans, no hidden blocks.
- **Tag seeds `source::seed`** so [loop-health](./loop-health.md) and grooming can tell a
  head start from an earned lesson.
- **Privacy pre-flight is not skipped** — a seed mined from history can carry a secret or
  a name; drop it, do not write it. The bar is stricter for `repo::` (team-visible).
- **Re-check the cap after mining.** If your candidate list is 40 long, you are
  bulk-seeding — cut to the handful that actually recur.
