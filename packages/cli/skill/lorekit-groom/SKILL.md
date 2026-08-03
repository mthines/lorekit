---
name: lorekit-groom
description: >
  Grooms and maintains an accumulated LoreKit memory store — the cleanup
  counterpart to lorekit-memory (which reads and records single lessons). It
  finds and merges near-duplicate lessons, lints out low-quality ones, sets
  expiry (TTL) on time-bound lessons, and prunes or archives obsolete ones,
  ALWAYS analysing read-only and proposing a plan before any change (nothing
  is deleted or merged without confirmation, and archive is preferred over
  hard-delete). Reach for this whenever a lesson/memory store has grown noisy,
  large, or stale and needs tidying — not for reading or writing one lesson.
  Triggers on "groom my memories", "clean up my lessons", "dedupe the memory
  store", "merge duplicate lessons", "too many memories", "my lorekit is a
  mess", "consolidate lessons", "add expiry dates to old lessons", "prune stale
  branch lessons", "lint my memories", "/lorekit-groom".
user-invocable: true
argument-hint: '[scope-hint]'
license: MIT
metadata:
  author: mthines
  version: '1.0.0'
  workflow_type: shared-memory-grooming-and-consolidation
  tags:
    - lorekit
    - persistent-memory
    - shared-memory
    - mcp
    - lessons
    - grooming
    - dedupe
    - lint
    - maintenance
---

# LoreKit Groom

Keep a shared memory store healthy as it grows.

A memory store that is never tended slowly rots: the same lesson gets written
three times in slightly different words, a stub with an empty value sits next to
a real one, a branch-specific gotcha outlives the branch by a year. Noise like
that is not harmless — it drowns the signal every future read depends on, so the
next agent scrolls past ten near-identical lines instead of acting on one clear
one.

This skill runs a **grooming pass** over the lessons for a scope: survey → lint →
dedupe & merge → set expiry → prune → verify. It is the maintenance counterpart
to the other two LoreKit skills:

| Skill | Job |
|-------|-----|
| `lorekit-memory` | Runtime: read scoped lessons on a task, write one on failure |
| `lorekit-setup` | Authoring: wire a self-improvement loop into a host |
| **`lorekit-groom`** | **Maintenance: consolidate and clean an accumulated store** |

---

## The one rule that governs everything: propose, then confirm

Grooming edits a **shared, persistent** store — a lesson you merge or delete is
gone for every agent on every machine, not just this session. So the entire pass
is read-only until a human says otherwise:

1. **Analyse read-only.** Every survey step below is a read command. Run them
   first and build the full picture before touching anything.
2. **Propose a concrete plan.** Show exactly what you intend to do — which
   lessons merge into which, what gets an expiry, what gets archived — with the
   actual keys and values, grouped so a human can scan it in one screen.
3. **Only mutate after confirmation.** Wait for the go-ahead, then apply. Prefer
   **archive** (reversible) over hard-delete; reserve permanent deletion for
   genuine junk and only with explicit sign-off.

Never batch-delete on a similarity score alone — the dedupe heuristic is a
word-overlap guess, not a semantic judge (see the toolbox note below). It finds
*candidates for a human's eye*, and merging is a judgement call about meaning.

If you are asked to "just clean it up" without oversight, still surface the plan
once and get a single confirmation for the batch — that is the floor, not a
step to skip.

---

## The grooming pass

Follow [rules/grooming-pass.md](./rules/grooming-pass.md) for the full playbook.
The short version is six phases; the first four are pure analysis.

1. **Survey** — size the problem. `lorekit stats` (counts per scope + store) and
   `lorekit scopes` (store-wide inventory: every scope with its lesson count)
   show where the mass is. Pick the noisiest scope to start.
2. **Lint** — `lorekit lint --json` flags structurally bad lessons (empty /
   whitespace / suspiciously short / untrimmed values, empty keys, malformed
   scopes). These are the cheapest wins: fix or drop them first.
3. **Dedupe** — `lorekit dedupe --json` clusters near-duplicate lessons. Start at
   a high `--threshold` (e.g. `0.85`) for confident duplicates, then lower it to
   surface looser paraphrases. Use `lorekit show <scope::key>` to read each
   cluster member's full value before deciding.
4. **Plan** — turn the findings into a proposed set of merges, expiries, and
   removals. This is where propose-then-confirm happens.
5. **Apply** (after confirmation) — merge, expire, and prune. See the toolbox.
6. **Verify** — re-run `lorekit lint` (should exit 0) and `lorekit dedupe` (no
   clusters at your threshold) and `lorekit stats` (a lower count). Green means
   the pass landed.

---

## The toolbox

Grooming spans two surfaces. **Analysis is the CLI** — its read commands
(`lint`, `dedupe`, `stats`, `scopes`, `show`, `list`, `search`, `tree`, `diff`)
survey the store far more richly than the MCP tools do, across both the offline
and remote stores at once. **Mutation is the `memory.*` MCP tools** — and
crucially, *removal* is MCP-only: there is no `lorekit delete` command, so
archiving and deleting always go through `memory.delete` / `memory.archive`.

| Job | How | Surface |
|-----|-----|---------|
| Count lessons per scope/store | `lorekit stats [--scope <s>]` | CLI (read) |
| Inventory every scope + lesson count | `lorekit scopes` | CLI (read) |
| Find low-quality lessons | `lorekit lint --json` | CLI (read) |
| Find near-duplicate clusters | `lorekit dedupe --json [--threshold <n>]` | CLI (read) |
| Read one lesson in full | `lorekit show <scope::key> [--json]` | CLI (read) |
| Compare offline vs remote | `lorekit diff` | CLI (read) |
| Write the merged/consolidated lesson | `memory.write` (or `lorekit write`) | MCP / CLI |
| Set / clear an expiry | `memory.write { ttl_days }` / `{ clear_ttl: true }` | MCP / CLI (`--ttl-days` / `--clear-ttl`) |
| Archive a lesson (reversible) | `memory.archive` (or `memory.delete`) | **MCP only** |
| Hard-delete a lesson (permanent) | `memory.delete { force: true }` | **MCP only** |

> **`dedupe` is a heuristic, not a semantic judge.** It clusters on Jaccard
> word-token overlap, so it can both miss reworded duplicates *and* group
> coincidental ones. Treat every cluster as a candidate to read and decide on,
> never as an instruction to merge.

> **If the `memory.*` MCP tools are not connected**, analysis still works
> (the CLI reads and `lorekit write --ttl-days` sets expiries), but you cannot
> archive or delete. Say so once, complete everything you can, and hand the
> removal list to the human rather than silently skipping it.

Merging, expiry tiers, and the archive-vs-delete call each have real judgement
in them — the details, with examples, live in
[references/merge-and-expiry.md](./references/merge-and-expiry.md). Read it
before your first merge or TTL decision in a pass.

---

## Scope in one line

Lessons are partitioned by a canonical scope string (`::` is the only separator):

```text
global                                universal principles
project::{name}                       monorepo-wide
repo::{owner}/{repo}                   this repository's codebase
branch::{owner}/{repo}::{branch}       short-lived, this branch only
```

Scope drives two grooming decisions: **branch-scoped lessons are the prime
candidates for expiry** (a branch is short-lived, its lessons usually are too),
and **a merge lands in the narrowest scope that still covers all its members**.
Both are spelled out in the reference file.

---

## Setup

Grooming uses the same install as the rest of LoreKit:

```bash
npx @lorekit/cli install
npx @lorekit/cli doctor
```

`doctor` confirms the store backend (`remote`, `local`, or `off`) and token
permission. Removal needs a token with **write** permission (`lk_rw_*` or
`lk_wo_*`); a read-only token can survey and propose but not apply. If a mutate
call fails with an authorization error, report it and stop — do not retry.
