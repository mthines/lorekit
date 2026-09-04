---
name: lorekit-setup
description: >
  Sets up a self-improvement loop for a skill, workflow, or agent using LoreKit,
  so a host gets better across runs by reading its own accumulated lessons at
  the start of every run and hardening the proven ones into permanent rules.
  Designs the lessons loop (a fast episodic tier of LoreKit lessons, advisory-only;
  a slow procedural tier that promotes a recurring lesson into a host rule; and,
  for the rarer judgement-free, independently-checkable case, a third rung that
  compiles a recurring lesson into a mechanically-enforced CI invariant instead),
  chooses the lesson bucket (tag + key namespace) and scopes, and installs the
  entrenchment guards that stop a learning loop from reinforcing its own
  mistakes. Also covers the non-LLM case: giving a deterministic job (a GitHub
  Actions workflow, a cron script, a release pipeline) durable JSON state
  records so it knows what happened on its last run — flaky tests, a benchmark
  baseline, the last deployed SHA — in the same store agents read. Runtime
  reading and writing of lessons is the lorekit-memory skill; this is the
  authoring counterpart. Use when giving a host durable cross-run memory or
  wiring a lessons loop. Triggers on "set up memory for my skill", "add a
  self-improvement loop", "give my workflow memory", "make this learn from its
  mistakes", "self-improving memory", "memory in CI", "GitHub Actions state",
  "remember the last CI run", "/lorekit-setup".
user-invocable: true
argument-hint: '[host-name]'
license: MIT
metadata:
  author: mthines
  version: '1.0.0'
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

Give a host durable cross-run memory. For a model-driven host that means a
**self-improvement loop**: it reads its own accumulated lessons at the start of
every run and hardens the proven ones into permanent rules, so it gets better the
more it runs. For a deterministic host — a CI job — it means **state records**: it
reads what was true at the end of its last run instead of rediscovering it.

This is the **authoring** counterpart to `lorekit-memory`. `lorekit-memory` does
the runtime read/write of individual lessons; `lorekit-setup` wires the durable
memory that calls those primitives on a host's behalf. Both run on the same
LoreKit store — over the `memory.*` MCP tools for agents, over the `lorekit` CLI
or REST for jobs.

## The rungs of a lessons loop (in one screen)

The runtime loop below is two tiers, fast and slow; a third, rarer rung sits past
promotion, for the minority of recurring lessons that can be turned into a
mechanically-checked rule instead of text a reader has to notice.

| Rung | Mechanism | Changes behavior? | Advisory or enforced? |
| ---- | --------- | ----------------- | ---------------------- |
| **Fast (episodic)** | LoreKit lessons in a per-host bucket, read at the start of a run, written on failure | **No** — advisory input only | Advisory |
| **Slow (procedural)** | A human-reviewed edit that hardens a recurring lesson into a host rule | **Yes** | Advisory (works only if the next reader notices it) |
| **Compiled invariant** | A declarative `obligations-map.mjs` entry a CI gate checks against a changed-file set — see [rules/compiled-invariants.md](./rules/compiled-invariants.md) | **Yes** | Enforced once `gating`; most lessons never qualify |

A recurrence gate connects the first two: a lesson that recurs (`seen_count >= 3`)
or is marked `status=structural` becomes promotion-eligible. Entrenchment guards
keep the fast tier from reinforcing its own wrong conclusions. The third rung has
its own, stricter gate — the compilability test — and most promotion-eligible
lessons stop at the second rung because they fail it.

## Pick the shape first

Two kinds of host want memory, and they want a different record. Decide which
before reading further:

| The host is… | Wants | Read |
| ------------ | ----- | ---- |
| A **model-driven** skill, agent, or workflow that fails in recurring, classifiable ways | Prose **lessons** — advisory, recurrence-gated, promotable into rules | [rules/self-improvement-loops.md](./rules/self-improvement-loops.md) |
| A **deterministic job** — a GitHub Actions workflow, a cron script, a release pipeline — that needs last-run state | JSON **state records** — authoritative, parsed, one key per fact | [rules/ci-state-records.md](./rules/ci-state-records.md) |
| A recurring lesson whose failure mode is judgement-free and checkable against an independent source of truth | A **compiled invariant** — a declarative entry a CI gate enforces mechanically, never advisory once `gating` | [rules/compiled-invariants.md](./rules/compiled-invariants.md) |

A host can want both, in separate buckets: the state record carries *what is true
right now*, the lesson carries *what we learned about it*.

## Set up a loop (model-driven hosts)

Follow [rules/self-improvement-loops.md](./rules/self-improvement-loops.md).
It covers: when to add a loop (and when not to), the bucket convention (tag
`loop::<host>-lessons` + key namespace), scope selection, the lesson schema, the
read/write steps, the promotion gate, the entrenchment guards, a wiring
checklist, and an interactive setup flow.

## The shared codebase-knowledge layer (automatic cross-loop synergy)

A per-host lessons bucket is private to one host. There is also **one shared
bucket every code-touching host reads and, under a contract, writes**:
`codebase-knowledge` — a repo-scoped, structurally-keyed record
(`knowledge::<symbol>@<path>` facts, `hotspot::<path>` counters) of what the
codebase has taught every LoreKit loop that touched it. Because the name is fixed
and the key is structural, a loop wired by one person compounds with a loop wired
by another: a host about to change code reads the history for exactly the files it
will touch, and a host that verifies a structural fact contributes it back. That
is the synergy that appears for a user who wired a single skill and nothing else.

Wire it whenever a host changes code (read at its plan/apply seam) or verifies a
durable structural fact (write under the contract). The full specification — the
bucket table, the automatic read side, and the seven-bullet multi-writer write
contract — is [rules/self-improvement-loops.md § Shared codebase-knowledge](./rules/self-improvement-loops.md#shared-codebase-knowledge-the-standard-cross-loop-layer).

## Set up CI state (deterministic hosts)

Follow [rules/ci-state-records.md](./rules/ci-state-records.md). It covers: when
LoreKit beats `actions/cache` (and when it does not), the `ci::<job>-state` bucket
convention, the versioned JSON envelope, the read/write steps with the `lorekit`
CLI or REST, a full GitHub Actions example, the guards (bounded cardinality, no
secrets, explicit expiry, never on the critical path, last-write-wins), and a
wiring checklist.

If invoked with a `host-name`, set up memory for that host; otherwise ask which
skill / workflow / agent / job it is for, pick the shape from the table above,
then walk that rule file's setup.

A lessons loop's runtime tier needs LoreKit's `memory.*` tools connected; if they
are not, the host's loop is a silent no-op (the slow tier — a normal source edit —
still works). A CI job needs a `lk_*` token in its environment instead, and
degrades to its first-run path when the store is unreachable. Designing either
needs no connection.
