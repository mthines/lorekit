---
name: lorekit-setup
description: >
  Sets up a self-improvement loop for a skill, workflow, or agent using LoreKit,
  so a host gets better across runs by reading its own accumulated lessons at
  the start of every run and hardening the proven ones into permanent rules.
  Designs the two tiers (a fast episodic tier of LoreKit lessons, advisory-only;
  a slow procedural tier that promotes a recurring lesson into a host rule),
  chooses the lesson bucket (tag + key namespace) and scopes, and installs the
  entrenchment guards that stop a learning loop from reinforcing its own
  mistakes. Runtime reading and writing of lessons is the lorekit-memory skill;
  this is the authoring counterpart. Use when giving a host durable cross-run
  memory or wiring a lessons loop. Triggers on "set up memory for my skill",
  "add a self-improvement loop", "give my workflow memory", "make this learn
  from its mistakes", "self-improving memory", "/lorekit-setup".
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
---

# LoreKit Setup

Give a skill, workflow, or agent a **self-improvement loop**: it reads its own
accumulated lessons at the start of every run and hardens the proven ones into
permanent rules — so it gets better the more it runs.

This is the **authoring** counterpart to `lorekit-memory`. `lorekit-memory` does
the runtime read/write of individual lessons; `lorekit-setup` wires the durable
loop that calls those primitives on a host's behalf. Both run on the same
LoreKit `memory.*` MCP tools.

## The two tiers (in one screen)

| Tier | Mechanism | Changes behavior? |
| ---- | --------- | ----------------- |
| **Fast (episodic)** | LoreKit lessons in a per-host bucket, read at the start of a run, written on failure | **No** — advisory input only |
| **Slow (procedural)** | A human-reviewed edit that hardens a recurring lesson into a host rule | **Yes** |

A recurrence gate connects them: a lesson that recurs (`seen_count >= 3`) or is
marked `status=structural` becomes promotion-eligible. Entrenchment guards keep
the fast tier from reinforcing its own wrong conclusions.

## Set up a loop

Follow [rules/self-improvement-loops.md](./rules/self-improvement-loops.md).
It covers: when to add a loop (and when not to), the bucket convention (tag
`loop::<host>-lessons` + key namespace), scope selection, the lesson schema, the
read/write steps, the promotion gate, the entrenchment guards, a wiring
checklist, and an interactive setup flow.

If invoked with a `host-name`, set up the loop for that host; otherwise ask
which skill / workflow / agent the loop is for, then walk the interactive setup.

The loop's runtime tier needs LoreKit's `memory.*` tools connected; if they are
not, the host's loop is a silent no-op (the slow tier — a normal source edit —
still works). Designing the loop needs no connection.
