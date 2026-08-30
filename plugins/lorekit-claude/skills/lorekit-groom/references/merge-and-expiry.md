# Merge, expiry, and removal — the judgement calls

The mechanical parts of grooming (survey, lint, dedupe) are commands. The parts
that need thought are: how to synthesise a merged lesson, where it should live,
how long a lesson should last, and whether a stale lesson should be archived or
deleted. This file is the reference for those four decisions. Read it before the
first merge or TTL choice in a pass.

## Table of contents

1. [Synthesising a merged lesson](#1-synthesising-a-merged-lesson)
2. [Choosing the merged lesson's scope](#2-choosing-the-merged-lessons-scope)
3. [Choosing the key](#3-choosing-the-key)
4. [Expiry tiers (TTL)](#4-expiry-tiers-ttl)
5. [Archive vs. hard-delete](#5-archive-vs-hard-delete)

---

## 1. Synthesising a merged lesson

A merge is not a concatenation. Three lessons that say the same thing become
**one lesson that says it best** — otherwise you have replaced three near-copies
with one long lumpy one and gained nothing.

- **Keep the observation, drop the repetition.** Write the single clearest
  statement of the shared point. If two members add genuinely different detail
  (one names the failing command, another names the fix), fold both facts into
  one lesson; if they only reword each other, keep the sharpest phrasing.
- **Stay an observation, not a rule.** LoreKit lessons are advisory ("migrations
  that skip an explicit transaction have left the schema half-applied here"), not
  commandments ("ALWAYS wrap migrations"). Merging is a chance to soften a member
  that drifted into a rigid MUST.
- **Preserve the union of tags and the richest provenance.** Carry every source's
  tags onto the merged lesson so it stays as findable as the originals. Keep the
  most complete origin (repo / branch / commit / PR) among the members.
- **Prefer updating a survivor over minting a new key.** If one member is already
  well-named and well-scoped, write the merged value onto *its* `scope::key`
  (an in-place update) and delete the others. That keeps any external links to
  that key alive. Mint a fresh key only when no member's key fits the merged
  meaning.

**Example**

```text
Sources:
  - "wrap every migration in a transaction"
  - "schema changes need a transaction or they half-apply on error"
  - "migrations must be atomic"
Merged value:
  "Migrations here half-apply on error unless wrapped in an explicit
   transaction — a failed step otherwise leaves the schema partly changed."
```

The merged version keeps the *why* (half-apply on error) that only one source
had, and states it as an observation.

## 2. Choosing the merged lesson's scope

Merge into the **narrowest scope that still correctly covers every member**.

- All members share a scope → merge stays in that scope.
- Members span scopes (e.g. two `branch::…` and one `repo::…` saying the same
  thing) → the lesson is really about the broader scope. Merge up to the
  narrowest scope that is still true for all of them — usually `repo::` when a
  branch lesson turned out to be a repo-wide truth. Broadening scope is itself a
  useful grooming outcome: a durable lesson trapped on a dead branch is nearly
  invisible.
- Never merge *down* into a scope narrower than some members — that hides the
  lesson from contexts where it applies.

Precedence check: bare `lorekit tree` shows which scope's lesson wins when keys
collide across scopes. Run it without `--scope` — that flag narrows the
resolution to a single scope, which by construction cannot show a collision.
Use it to confirm a merged lesson will actually surface where you intend.

## 3. Choosing the key

- Reuse a good survivor's key when one exists (see §1 — keeps links alive).
- Otherwise write a short, specific, hyphenated key that names the *observation*,
  not the symptom: `db-migrations-need-explicit-tx`, not `migration-bug` or
  `note-3`. A key is how a future agent recognises the lesson at a glance in a
  list, so vague keys are their own kind of noise.

## 4. Expiry tiers (TTL)

`ttl_days` (1–365) auto-expires a lesson that many days after the write, after
which it is hidden from reads. Set it via `memory.write { ttl_days }` or
`lorekit write --ttl-days <n>`; clear it with `{ clear_ttl: true }` /
`--clear-ttl` to make a lesson permanent again.

Match the TTL to how long the lesson's *truth* lasts, not to how old it is:

| Lesson kind | Guidance |
|-------------|----------|
| `branch::` — branch-specific gotcha | Short. The branch is short-lived; 14–30 days usually outlasts it. Prime expiry candidates. |
| Version- or dependency-pinned ("works around the bug in lib X 2.3") | Medium (30–90d), or archive once the pin is gone. |
| Repo- or project-wide architectural truth | Usually **permanent** — no TTL. Expiring durable knowledge is how a store forgets the things worth keeping. |
| `global` principle | Permanent. |

The instinct to worry about is expiring something durable. When unsure whether a
lesson's truth is time-bound, leave it permanent and flag it in the plan rather
than quietly attaching a TTL — a lesson that silently vanishes is worse than one
that lingers.

## 5. Archive vs. hard-delete

Two removal paths, and the default is the reversible one.

- **Archive** (`memory.archive`, or `memory.delete` without `force`) —
  soft-removes: hidden from reads but restorable. This is the default for
  anything that is *stale* rather than *junk*: superseded workarounds, lessons
  about a since-deleted subsystem, a merge's source lessons. If a future run
  might ever want it back, archive.
- **Hard-delete** (`memory.delete { force: true }`) — permanent, no recovery.
  Reserve it for genuine junk: lint casualties with no meaning (empty values,
  placeholder keys), test detritus, accidental writes. Only with explicit
  human sign-off in the plan.

When a lesson came from another agent or teammate (check its tags / source),
lean further toward archive — deleting someone else's recorded knowledge outright
is a heavier call than tidying your own.

Rule of thumb: **if you would hesitate to lose it forever, archive it.**
