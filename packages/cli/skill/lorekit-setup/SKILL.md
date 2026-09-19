---
name: lorekit-setup
description: >
  Turns a skill, workflow, agent, or CI job into one that gets better across runs
  and can PROVE it. Walks a six-step lifecycle — Find where a loop pays off, Wire
  it from a ready-made recipe card, Seed it so it delivers on run one, Prove it
  improved something, Maintain it so it does not rot, and Scale it to a team — with
  a 15-minute quickstart that ends in a loop firing once, live. Under the hood it
  is a LoreKit lessons loop: a fast episodic tier of advisory lessons read at the
  start of every run and written on failure; a slow procedural tier that promotes a
  recurring lesson into a permanent rule; and, for the rare judgement-free case, a
  third rung that compiles a lesson into a mechanically-checked CI invariant. Also
  covers the non-LLM case (durable JSON state records for a deterministic job) and
  the guards that stop a learning loop from reinforcing its own mistakes. Runtime
  reading and writing of lessons is the lorekit-memory skill; this is the authoring
  counterpart. Use when giving a host durable cross-run memory or wiring a lessons
  loop. Triggers on "set up memory for my skill", "add a self-improvement loop",
  "give my workflow memory", "make this learn from its mistakes", "where should I
  add a loop", "prove my loop is working", "self-improving memory", "memory in CI",
  "GitHub Actions state", "remember the last CI run", "/lorekit-setup".
user-invocable: true
argument-hint: '[host-name]'
license: MIT
metadata:
  author: mthines
  version: '2.0.0'
  workflow_type: memory-loop-authoring
  tags:
    - lorekit
    - self-improvement
    - memory
    - lessons
    - loop
    - authoring
    - setup
    - ci
    - github-actions
---

# LoreKit Setup

Give a host durable cross-run memory, and make its improvement **visible**. For a
model-driven host that means a **self-improvement loop**: it reads its own
accumulated lessons at the start of every run and hardens the proven ones into
permanent rules, so it gets better the more it runs. For a deterministic host — a
CI job — it means **state records**: it reads what was true at the end of its last
run instead of rediscovering it.

This is the **authoring** counterpart to `lorekit-memory`. `lorekit-memory` does the
runtime read/write of individual lessons; `lorekit-setup` wires the durable memory
that calls those primitives on a host's behalf. Both run on the same LoreKit store —
over the `memory.*` MCP tools for agents, over the `lorekit` CLI or REST for jobs.

> A loop that nobody can see helping is indistinguishable from no loop. This skill
> treats "the host measurably got better" as the deliverable — not "a loop is
> wired." Every step below is judged against that.

## The lifecycle (start here)

A working loop is six steps. Do them in order; each links to the rule that covers it.

| # | Step | What it answers | Read |
| - | ---- | --------------- | ---- |
| 1 | **Find** | *Where* does a loop actually pay off? (Do not guess — the data already knows.) | [rules/self-improvement-loops.md § Find where a loop pays off](./rules/self-improvement-loops.md#find-where-a-loop-pays-off) |
| 2 | **Wire** | Add the read/write steps with the least effort — copy a recipe card. | [templates/](./templates/) + [rules/self-improvement-loops.md](./rules/self-improvement-loops.md) |
| 3 | **Seed** | Deliver value on run **one**, before any lesson has been earned. | [rules/cold-start-seeding.md](./rules/cold-start-seeding.md) |
| 4 | **Prove** | Show the loop reduced a real failure — not just that lessons exist. | [rules/proving-improvement.md](./rules/proving-improvement.md) |
| 5 | **Maintain** | Keep it firing, keep the bucket clean, roll back a bad lesson. | [rules/loop-health.md](./rules/loop-health.md) |
| 6 | **Scale** | Turn one person's loop into a team practice that compounds. | [rules/team-and-portfolio.md](./rules/team-and-portfolio.md) |

If invoked with a `host-name`, set up memory for that host and walk this lifecycle.
Otherwise ask which skill / workflow / agent / job it is for, pick the shape from
[Pick the shape](#pick-the-shape), then walk it.

## Quickstart (15 minutes, one loop firing once)

The shortest path from "I have a host" to "I watched the loop close." Do it against a
real host with `memory.*` connected.

1. **Name the bucket.** From the host's name `<host>`: tag `loop::<host>-lessons`,
   key namespace `<host>-lessons::<slug>`. One bucket per host.
2. **Copy a recipe card.** Pick the archetype in [templates/](./templates/) that
   matches your host (code-changing agent, reviewer/reconcile host, multi-step
   orchestrator, CI job) and paste its read step at the host's start and its write
   step at the host's existing failure points. The card already carries the
   injection cap, the TTL, and the entrenchment defaults — do not hand-roll them.
3. **Seed one real lesson** (optional but recommended) so run one is not empty —
   [rules/cold-start-seeding.md](./rules/cold-start-seeding.md). Keep it to a
   *handful*, hand-checked.
4. **Fire it once, on purpose.** Trigger the failure the loop is meant to catch.
   Confirm a lesson was written to the right scope with the right tag:

   ```text
   memory.list { scope: "<the scope you expect>", tags: ["loop::<host>-lessons"], limit: 10 }
   ```

5. **Run again and watch it read back.** Start a second run over the same
   situation. Confirm the lesson surfaces in the read step and biases the run.
   That is the loop closing — the whole point, demonstrated once.
6. **Write down the success metric** you will use to prove it keeps helping —
   [rules/proving-improvement.md](./rules/proving-improvement.md). The required one
   is the *immunity re-challenge*: after you promote a lesson to a rule, the failure
   signature should stop recurring.

That is a live, working loop. Everything below is depth on each step.

## Pick the shape

Two kinds of host want memory, and they want a different record. Decide which first:

| The host is… | Wants | Read |
| ------------ | ----- | ---- |
| A **model-driven** skill, agent, or workflow that fails in recurring, classifiable ways | Prose **lessons** — advisory, recurrence-gated, promotable into rules | [rules/self-improvement-loops.md](./rules/self-improvement-loops.md) |
| A **deterministic job** — a GitHub Actions workflow, a cron script, a release pipeline — that needs last-run state | JSON **state records** — authoritative, parsed, one key per fact | [rules/ci-state-records.md](./rules/ci-state-records.md) |
| A recurring lesson whose failure mode is judgement-free and checkable against an independent source of truth | A **compiled invariant** — a declarative entry a CI gate enforces mechanically, never advisory once `gating` | [rules/compiled-invariants.md](./rules/compiled-invariants.md) |

A host can want both, in separate buckets: the state record carries *what is true
right now*, the lesson carries *what we learned about it*.

## The rungs of a lessons loop (in one screen)

The runtime loop is two tiers, fast and slow; a third, rarer rung sits past promotion.

| Rung | Mechanism | Changes behavior? | Advisory or enforced? |
| ---- | --------- | ----------------- | ---------------------- |
| **Fast (episodic)** | LoreKit lessons in a per-host bucket, read at the start of a run, written on failure | **No** — advisory input only | Advisory |
| **Slow (procedural)** | A human-reviewed edit that hardens a recurring lesson into a host rule | **Yes** | Advisory (works only if the next reader notices it) |
| **Compiled invariant** | A declarative `obligations-map.mjs` entry a CI gate checks against a changed-file set — see [rules/compiled-invariants.md](./rules/compiled-invariants.md) | **Yes** | Enforced once `gating`; most lessons never qualify |

A recurrence gate connects the first two: a lesson that recurs (`seen_count >= 3`) or
carries the `status::structural` tag becomes promotion-eligible. Entrenchment guards
keep the fast tier from reinforcing its own wrong conclusions.

## Non-negotiables (do not "optimize these away")

Five co-requirements make the difference between a loop that helps and one that
quietly rots or crowds out the run it was meant to help. Every recipe card bakes
them in; if you wire by hand, wire these too:

1. **A lesson body is markdown for humans — nothing hidden.** No HTML comment, no
   front-matter, no JSON blob, no `key=value` header. Every fact the store already
   models goes in its own field, never restated in prose — see
   [the body contract](#a-lesson-body-is-markdown-for-humans--nothing-hidden) below.
2. **Every loop declares a per-host injection cap.** A loop reads *at most* N lessons
   into a run (the cards default to a small N). Many cheap loops with no cap tax
   every session's context until agents ignore injected lore entirely.
3. **Every lesson expires.** `ttl_days` on the write, refreshed on recurrence, so a
   stale belief decays instead of entrenching. Decay is automatic, never staffed.
4. **Lessons are advisory, never auto-applied.** The only path from a lesson to
   changed behavior is the human-reviewed slow tier.
5. **Prove it, or it did not happen.** A loop earns its keep only when a real failure
   stops recurring — [rules/proving-improvement.md](./rules/proving-improvement.md).

### A lesson body is markdown for humans — nothing hidden

The `value` is **markdown a person reads**, and it carries no hidden payload. Every
fact the store already models goes in its own write field:

| Fact | Field, not prose |
| ---- | ---------------- |
| Recurrence | `seen_count` — the store increments it on every overwrite |
| Expiry | `ttl_days` (`clear_ttl` to make permanent) |
| Status (`structural` / `promoted`) | a `status::<value>` tag |
| Owning host, bucket kind | `host`, `kind` |
| Repo / branch / commit / PR | the `origin_*` fields |
| What triggered the write | `trigger` |

A hidden block does not just look untidy — it is *wrong*. A `seen_count=1` baked into
prose is stale the first time the lesson recurs, while the column that governs
promotion moves without it; an HTML comment renders to nothing, so a human is shown a
lesson that begins mid-sentence. The full shape, the field-by-field rationale, and the
writing rules are [the lesson record](./rules/self-improvement-loops.md#the-lesson-record).
This contract is now checkable — `lorekit lint` flags a body that violates it, and the
`lorekit-groom` skill cleans legacy offenders.

## The shared codebase-knowledge layer (automatic cross-loop synergy)

A per-host lessons bucket is private to one host. There is also **one shared bucket
every code-touching host reads and, under a contract, writes**: `codebase-knowledge` —
a repo-scoped, structurally-keyed record (`knowledge::<symbol>@<path>` facts,
`hotspot::<path>` counters) of what the codebase has taught every LoreKit loop that
touched it. Because the name is fixed and the key is structural, a loop wired by one
person compounds with a loop wired by another. The full specification is
[rules/self-improvement-loops.md § Shared codebase-knowledge](./rules/self-improvement-loops.md#shared-codebase-knowledge-the-standard-cross-loop-layer).

## Connectivity

A lessons loop's runtime tier needs LoreKit's `memory.*` tools connected; if they are
not, the host's loop is a silent no-op (the slow tier — a normal source edit — still
works). A CI job needs a `lk_*` token in its environment instead, and degrades to its
first-run path when the store is unreachable. Designing either needs no connection.
