# Recipe card — code-changing agent

For a host that **edits code** and fails in recurring ways: an autonomous workflow, a
fix-bug agent, an implement-suggestion worker. It wants two reads — its own lessons
*and* the shared `codebase-knowledge` for the files it is about to touch — and two
writes — a lesson on failure, and a verified structural fact back to
`codebase-knowledge`.

Fill in: `<host>` (e.g. `fix-bug`), `<owner>/<repo>`. `N = 5`.

## Bucket

- Lessons: tag `loop::<host>-lessons`, key `<host>-lessons::<slug>`.
- Shared: tag `codebase-knowledge` (read by every code-touching loop; see
  [the shared layer](../rules/self-improvement-loops.md#shared-codebase-knowledge-the-standard-cross-loop-layer)).

## Read step — at the start of the run AND at the plan/apply seam

```text
# 1. Own lessons, narrow-to-broad, capped at N per scope:
memory.list { scope: "repo::<owner>/<repo>", tags: ["loop::<host>-lessons"], limit: 5 }
memory.list { scope: "global",               tags: ["loop::<host>-lessons"], limit: 5 }

# 2. When the run names a subsystem/error, one targeted search:
memory.search { q: "<keywords>", scopes: ["repo::<owner>/*", "global"], limit: 5 }

# 3. At the plan/apply seam — once you have the concrete file/symbol list:
memory.list { scope: "repo::<owner>/<repo>", tags: ["codebase-knowledge"], limit: 100 }
#   keep ONLY hotspot::<path> / knowledge::<symbol>@<path> whose <path>/<symbol>
#   this run will touch. Apply as PLANNING INPUT: raise coverage on a hotspot,
#   design around a known invariant. Advisory; re-verify against the code.
```

Match each lesson's **Applies when** line against the current run; apply matching
**Do this instead** lines as *considerations*, not commands. On a `repo::` vs `global`
collision, `repo::` wins. An absent `codebase-knowledge` record is never evidence of
safety.

## Write step — on failure / at end of run

```text
# Dedup first so a recurrence UPDATEs in place:
memory.search { q: "<key words of the lesson>", scopes: ["repo::<owner>/<repo>", "global"], limit: 10 }

memory.write {
  scope:    "<global | repo::<owner>/<repo>>",   # repo:: if it names a repo path/term, else global
  key:      "<host>-lessons::<slug>",
  value:    "<markdown lesson body — no hidden blocks>",
  tags:     ["loop::<host>-lessons", "source::<trigger>"],
  trigger:  "<stuck-loop | command-failure | gotcha | near-miss | assumption-wrong | paid-off>",
  ttl_days: 90
}
```

If the host **verified** a structural fact this run (an invariant a symbol holds, a
file that produced a defect), write it back to `codebase-knowledge` under the
multi-writer contract — `verified_at_sha`, `source_agent`, merge-not-clobber, raise
care never suppress:
[write side](../rules/self-improvement-loops.md#write-side--how-the-layer-fills-and-why-many-writers-stay-safe).

## Lesson body — copy this shape

```markdown
# <one-line takeaway — what to do, not what it is about>

**Applies when:** <concrete signal — file glob, task type, tool name, error shape>

**What happened:** <the concrete observable>
**Why:** <root cause, or "unknown">
**Do this instead:** <prescriptive, testable instruction>
**Promotion target:** <the host rule this would harden if promoted, or "none">
```

## Fire-once check (do this before trusting the loop)

1. Trigger the failure this loop is meant to catch.
2. Confirm the lesson landed: `memory.list { scope: "<expected>", tags: ["loop::<host>-lessons"], limit: 10 }`.
3. Re-run over the same situation; confirm it surfaces in the read step and biases the run.

## Cold start (optional, capped)

Pre-seed a *handful* of real lessons from git history / prior review threads so run one
is not empty — [cold-start-seeding.md](../rules/cold-start-seeding.md). Do **not** seed
a loop whose lift you intend to measure; it erases the baseline.

## Prove it

Declare the immunity re-challenge at wiring time: after you promote a lesson to a rule,
its failure signature should stop recurring — [proving-improvement.md](../rules/proving-improvement.md).
