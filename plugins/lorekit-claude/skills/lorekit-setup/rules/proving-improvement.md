# Proving a loop improved something

A loop that nobody can see helping is indistinguishable from no loop. Wiring is not
the deliverable — **a real failure that stops recurring** is. This file is how you show
that, and — as important — how you avoid fooling yourself with numbers that cannot prove
it.

## Contents

- [The required proof: the immunity re-challenge](#the-required-proof-the-immunity-re-challenge)
- [Why the raw counters cannot prove causation](#why-the-raw-counters-cannot-prove-causation)
- [The optional counter view (advisory only)](#the-optional-counter-view-advisory-only)
- [Declare the metric at wiring time](#declare-the-metric-at-wiring-time)
- [The north star: a withheld-memory control arm](#the-north-star-a-withheld-memory-control-arm)
- [Guards](#guards)

---

## The required proof: the immunity re-challenge

There is exactly one proof this skill *requires*, because it is the one a doc can make
a person actually run and the one that survives the confounds below: **after you promote
a lesson to a rule, its failure signature should stop recurring.**

Borrowed from immune memory: promoting a lesson registers its original failure
signature as a "pathogen"; a later write bearing that same signature is a re-infection.

1. **At promotion, record the signature.** The lesson's **Applies when** line *is* the
   signature — a file glob, a task type, a tool name, an error shape. Note the source
   lesson's key and its `seen_count` at the moment of promotion.
2. **Watch for recurrence.** The direct measurement is the source lesson's `seen_count`
   going **flat** — the loop stops writing that lesson because the failure stopped
   happening. Read the column (`memory.read` / `lorekit show`), never a number in the
   body.
3. **Escalate a breakthrough.** Any new write matching the promoted signature is a
   vaccine-breakthrough case: the rule did not hold. That is a signal to fix the rule
   (too narrow, wrong shape), not to shrug.

A promoted rule's value is the **silence** of its failure signature afterward. You
measure the absence. This needs no new product feature — `seen_count` and the
**Applies when** line already exist.

## Why the raw counters cannot prove causation

It is tempting to prove a loop "works" by pointing at rising counters. Do not lead with
this — LoreKit's own analysis records why the absolute counters are confounded:

- **`read_count` is ~99.8% bulk ride-alongs** — it tracks scope breadth, not whether a
  lesson mattered.
- **`seen_count` is `1` for ~88% of rows** — most lessons never recur, so a raw count is
  mostly noise.
- **Pull-through (`opened_count / read_count`) is the only trustworthy value signal** —
  it cancels the ride-along confound by dividing it out.

And even pull-through is *correlation*: a lesson can pull through because it was
genuinely useful, or because the task was easy and any nudge looked right. Counter
movement alone can never separate "the lesson helped" from "the run would have
succeeded anyway." Only a run that deliberately did **not** get the memory can — see
[the north star](#the-north-star-a-withheld-memory-control-arm).

## The optional counter view (advisory only)

Once the immunity check is in place, the counters are a useful *secondary* read — never
the headline:

- **Pull-through per bucket** — `opened_count / read_count` across `loop::<host>-lessons`.
  A bucket read often and opened rarely is dead weight to prune, not proof of value.
- **`/insights`** — the dashboard's Lore Utility grid classifies each lesson
  (load-bearing / specialist / noise-tax / dormant) from pull-through against an
  evidence floor. Consult it to find lessons to promote (load-bearing) or retire
  (noise-tax), not to claim the loop improved a host.
- **`cited_count`** — when a host cites the lessons it applied (`cited` on the write),
  a rising `cited_count` on a lesson is *evidence* it is being used. It is evidence,
  never a denominator: a `0` means "nobody said so", not "unused".

State the confound wherever you report these: raw counters describe supply, not lift.

## Declare the metric at wiring time

Do this at step 6 of the quickstart, not months later when you have forgotten what
"better" meant:

- **Required:** name the failure signature (the **Applies when** line) whose recurrence
  you will watch after promotion.
- **Optional:** name the one bucket pull-through you will glance at, and the interval.
- Write it into the host's own docs next to the loop's read/write steps, so a future
  maintainer inherits the definition of "working" instead of re-inventing it.

## The north star: a withheld-memory control arm

The only *rigorous* attribution is a control arm: deterministically bucket a small
fraction of runs into a **lessons-suppressed** arm (reuse LoreKit's feature-flags
FNV-1a bucketing on a stable run id), then compare outcome rates — retry count,
first-try pass, wall-clock — between treated and control. That yields lift with a
confidence interval instead of a ratio.

This is the aspiration, **not a requirement**, for two honest reasons: it needs product
infrastructure that does not exist yet (a per-loop lift harness), and deliberately
withholding memory has a real UX/ethics cost, so it must be opt-in. Treat it as the
direction of travel; ship the immunity re-challenge today.

## Guards

- **Do not measure a loop you seeded.** Cold-start seeding erases the clean baseline the
  immunity check reads — see [cold-start-seeding.md](./cold-start-seeding.md). Pick, per
  loop: run-one value (seed it) OR provable lift (leave it cold).
- **A flat `seen_count` after promotion is proof only if the loop is still firing.**
  Confirm the loop is alive first ([loop-health.md](./loop-health.md#is-the-loop-firing));
  a dead loop also has a flat count, for the wrong reason.
- **Never gate anything on a counter.** These are proof for a human, not a machine gate.
  The only mechanical gate is the compiled invariant ([compiled-invariants.md](./compiled-invariants.md)).
