# Setting up a self-improvement loop

Use this when someone wants a skill, workflow, or agent to **get better across
runs** — "give my skill memory", "add a self-improvement loop", "make this
learn from its mistakes", "set up lessons for this workflow".

Reading and writing individual lessons at runtime is the **`lorekit-memory`**
skill (its `intake` / `retrospective` rules). This skill is one level up: how to
wire a **durable loop** into a host so it reads its own accumulated lessons at
the start of every run and records new ones on failure — safely, without the
loop entrenching its own mistakes. The loop runs on the same `memory.*` MCP
tools `lorekit-memory` uses.

The design has two tiers connected by a recurrence gate. Both run on LoreKit.

## Contents

- [When to add a loop (and when not to)](#when-to-add-a-loop-and-when-not-to)
- [The two tiers](#the-two-tiers)
- [Conventions](#conventions)
- [Read step (start of every run)](#read-step-start-of-every-run)
- [Write step (on failure / at the end of a run)](#write-step-on-failure--at-the-end-of-a-run)
- [The reconcile-on-re-run flow (resolve + record)](#the-reconcile-on-re-run-flow-resolve--record)
- [Promotion (fast → slow)](#promotion-fast--slow)
- [Entrenchment guards (do not skip these)](#entrenchment-guards-do-not-skip-these)
- [Wiring checklist](#wiring-checklist)
- [Interactive setup](#interactive-setup)

---

## When to add a loop (and when not to)

Add a loop when **all** of these hold:

- The host is an **orchestrator or multi-step pipeline** that can fail in
  recurring, classifiable ways (wrong triage, a missed step, a false-green gate).
- Its failures are about the **host's own process**, not just the user's product.
- There is somewhere a proven lesson could eventually **harden into a rule** (the
  slow tier below).

Do **not** add a loop to:

- **One-shot utilities** with no durable cross-run subject — the bookkeeping
  costs more than it returns.
- **Adversarial / audit steps** (a red-team pass, a fresh-eyes reviewer) — they
  must not be biased by prior runs; that is the whole point of a fresh pass.
- **Steps that handle secrets or credentials** — routing them through lesson
  extraction is a leak risk.
- **Deterministic jobs** (a CI workflow, a cron script, a release pipeline) — they
  do not draft prose lessons or need a promotion gate; what they want is a JSON
  **state record** of their last run. That is a different shape with different
  guards: see [ci-state-records.md](./ci-state-records.md).

When unsure, default to **no**. A loop can be added later; unwinding an
entrenched-bias loop is harder.

---

## The two tiers

| Tier | Mechanism | Storage | Changes behavior? | Gate |
| ---- | --------- | ------- | ----------------- | ---- |
| **Fast (episodic)** | LoreKit lessons (`memory.*`), read at the start of a run, written on failure / at the end | LoreKit | **No** — advisory input only | none (privacy pre-flight only) |
| **Slow (procedural)** | A permanent edit to the host's own source / rules | the host skill | **Yes** — a rule / gate / trigger | human review + approval |

The fast tier captures a lesson immediately and cheaply. A lesson earns a
**permanent** change to the host (the slow tier) only once it has **recurred
across runs** — recurrence is the cheap external signal that the lesson is real,
not a one-off. This is the episodic → procedural promotion path, with a human
gate on the slow tier so a single bad run can never rewrite the host.

The fast tier is optional: if LoreKit's `memory.*` tools are not connected, the
loop is a silent no-op (log one line, continue). The slow tier is just editing
the host and is unaffected.

---

## Conventions

Give the loop its own **bucket** so its lessons stay separate from every other
loop's on the same scopes. A bucket is a tag plus a key namespace:

- **Tag:** `loop::<host>-lessons` (e.g. `loop::deploy-lessons`). Reads filter by
  it; writes always carry it.
- **Key:** `<host>-lessons::<kebab-slug>` (e.g. `deploy-lessons::migration-order`).
  Same `scope` + `key` overwrites in place — the mechanism behind recurrence
  counting.

Pick the **scope** per lesson from the standard LoreKit model (`::` is the only
separator; the `lorekit-memory` skill's scope-resolution reference has the full
derivation):

- **`global`** — universal lessons that should follow the user across every repo.
- **`repo::{owner}/{repo}`** — lessons specific to this repository.

Reserve `branch::` for throwaway notes; a loop normally writes `global` or
`repo::`.

### The lesson record

A loop lesson is **procedural** ("how to do better next time"), not a fact about
the user. Keep the machine-read metadata in a `meta:` comment at the top of the
`value` so the prose stays readable:

```markdown
<!-- meta: seen_count=1 status=active expires=<ISO 8601, ~90 days out> trigger-context="<concrete signal — file glob, task type, tool, error shape>" -->

# <one-line lesson title>

**What failed:** <concrete observable from the run>
**Why:** <root cause, if known; "unknown" is allowed>
**What to do next time:** <prescriptive, actionable, testable instruction>
**Promotion target:** <the host rule/step this would harden if promoted, or "none">
```

`trigger-context` must be **concrete** (globs, task types, tool names, error
shapes) — never "when it feels relevant" — so the read step can match it
mechanically. `seen_count`, `status`, and `expires` drive recurrence, promotion,
and decay.

---

## Read step (start of every run)

Read narrow-to-broad, filtered by the bucket tag, and merge:

```text
memory.list { scope: "repo::{owner}/{repo}", tags: ["loop::<host>-lessons"], limit: 50 }   # skips silently if memory.* not connected
memory.list { scope: "global",               tags: ["loop::<host>-lessons"], limit: 50 }
# when the run names a subsystem / error, add a search:
memory.search { q: "<keywords>", scopes: ["repo::{owner}/*", "global"], limit: 10 }
```

Then:

1. Match each lesson's `trigger-context` against the current run. Consider only
   matches. **Skip any lesson whose `expires` is in the past** — treat it as
   stale.
2. Apply each matching *"What to do next time"* as a **consideration**, not a
   command — it biases the run unless it conflicts with the user's stated intent
   or a task-specific constraint. On conflict, the user's intent wins; surface it.
3. On a `repo::` vs `global` collision, the `repo::` lesson wins (closer scope).

No consolidation pass is needed — LoreKit owns storage and deduplicates on write.

---

## Write step (on failure / at the end of a run)

Trigger on friction: a stuck loop, a repeated failure, a gate that should have
caught something, a near-miss, a guess that paid off. Not on smooth successes.

1. **Classify the scope.** Trigger references a concrete repo path / repo-specific
   package or term → `repo::{owner}/{repo}`. A glob, framework, tool, or task
   type with no repo binding → `global`. When ambiguous, default to `global`.
2. **Deduplicate**, so a recurrence updates in place instead of piling up:

   ```text
   memory.search { q: "<key words of the lesson>", scopes: ["repo::{owner}/{repo}", "global"], limit: 10 }
   ```

3. **Write** to the classified scope:

   ```text
   memory.write {
     scope: "<global | repo::{owner}/{repo}>",
     key:   "<host>-lessons::<slug>",
     value: "<the lesson body above>",
     tags:  ["loop::<host>-lessons", "source::<trigger>"],
     trigger: "<stuck-loop | command-failure | gotcha | near-miss | assumption-wrong | paid-off | manual>"
   }
   ```

Same `scope` + `key` overwrites in place. **A recurrence resolves to an UPDATE
that increments `seen_count` by 1 and refreshes `expires`** — that is what makes
recurrence countable and drives promotion. If a lesson you applied at the start
of the run worked (the failure did not recur), still write the UPDATE:
successful application is recurrence evidence.

The privacy pre-flight is never skipped, autonomous or not: a candidate lesson
containing a secret, token, credential, or PII is **dropped, not written**. The
bar is stricter for `repo::` writes — a repo scope is team-visible.

---

## The reconcile-on-re-run flow (resolve + record)

Some hosts do not just fail-and-learn — they **produce durable outputs at a
shared target that they revisit on later runs**: a reviewer posts comment threads
on a PR it re-reviews on every push, a triager files issues it re-scans, a linter
opens tickets it re-opens. For these, a plain read/write loop is not enough:
stale outputs pile up at the target, and the signal about which outputs were
*useful* is thrown away.

The reconcile-on-re-run flow closes both gaps. On each re-run over the same
target, the host **reconciles its own prior outputs** in three steps:

1. **Classify** each prior output the host itself produced against the current
   state of the target. The three outcomes that carry signal:

   | Outcome | Meaning | Evidence |
   | --- | --- | --- |
   | **resolved** | The output was acted on — the thing it flagged is now handled | the flagged region changed and the finding no longer reproduces, or the owner acknowledged it |
   | **declined** | The owner explicitly rejected it | a "won't fix" / "by design" reply, a 👎 |
   | **still-open** | The finding still reproduces this run | the host re-produces the same output |

2. **Clean up at the target.** For `resolved` and `declined` outputs, close them
   at the source — resolve the thread, close the ticket, check the box — so a
   re-run leaves the target tidier than it found it instead of accumulating
   cruft. **Never** close a `still-open` output; that would hide a live finding.
   Only ever touch outputs the host itself authored.

3. **Record the outcome** to a **Signal**-shaped bucket (a durable, per-target
   relevance memory — distinct from the fast lessons bucket). Write `resolved` as
   a positive signal for that output's *pattern* and `declined` as a negative
   one, keyed by a stable pattern fingerprint (never by a line number or an id
   that drifts). Over runs this bucket teaches the host which of its output
   patterns get acted on in this target and which are noise — read it at the
   start of a run to suppress the reliably-declined patterns and reinforce the
   reliably-resolved ones. `still-open` writes nothing: there is no outcome yet.

   The Signal bucket is a second bucket alongside the lessons one, in the same
   grammar as [Conventions](#conventions):

   - **Tag:** `loop::<host>-<signal>` — e.g. `loop::reviewer-comment-relevance`.
     Reads filter by it; writes always carry it.
   - **Key:** `<host>-<signal>::<pattern-fingerprint>` — e.g.
     `reviewer-comment-relevance::unsupported-cross-repo-claim`. The fingerprint
     is the key segment, so the same `scope` + `key` overwrites in place and one
     output pattern accumulates one record across runs.

Two guards keep this honest, both instances of the entrenchment guards below:

- **Absence of confirmation is not resolution.** If a re-run did not re-scan the
  region a prior output covers (e.g. it only looked at the diff), the output is
  `still-open`, not `resolved` — silence is not a fix.
- **The cleanup is idempotent and non-fatal.** A target already closed is
  skipped; a cleanup error is logged and never fails the run.

Wire it as its own step at the host's re-run seam, gated on "a prior run's output
exists at this target". It composes with the read/write steps: the Signal bucket
it writes is read back at the next run's read step. The reference implementation
is the `agent-skills` `pr-reviewer` agent: it resolves its own addressed PR
threads on each commit-triggered re-review and records the fixed/declined
outcome to a `reviewer-comment-relevance` bucket, whose classification and
record shape are specified in `agents/shared/rules/comment-relevance-memory.md`.

---

## Promotion (fast → slow)

After a read or write, a lesson is **promotion-eligible** when either:

- `seen_count >= 3` — the same failure recurred across at least three runs, or
- it is tagged `status=structural` because it reflects a design gap, not a
  one-off.

For an eligible lesson, **surface a one-line suggestion — never act silently**:

> Lesson "<title>" recurred N times. Promote it to a permanent guard in
> `<host>`? (edit the host's source / rules behind your normal review.)

The promotion target follows the lesson's scope: a `global` lesson hardens the
**host's own source** (every user of the host benefits); a `repo::` lesson
hardens the **repo's own rules / docs** (every teammate in that repo benefits).
Promotion is a normal, human-reviewed edit — LoreKit does not apply it. After a
successful promotion, write an UPDATE setting `status=promoted` so the lesson
stops re-suggesting and stands as an audit trail of why the rule exists.

---

## Entrenchment guards (do not skip these)

The dominant risk of any reflective-memory loop is **self-reinforcing error**:
the host wrongly concludes "approach X always fails", stores it, avoids X
forever, and never gathers the evidence to overturn the false belief. These
guards are what make the loop safe:

1. **Lessons are advisory, never auto-applied to behavior.** A lesson biases a
   run; it can never silently disable a gate, skip a step, or change a limit. The
   only path from a lesson to changed behavior is the human-reviewed slow tier.
2. **Recurrence gates promotion, not a single run** (`seen_count >= 3`, or an
   explicit `status=structural` marker in the lesson's `meta:` comment).
3. **Every lesson expires** (default ~90 days from last sighting; the read step
   ignores expired lessons, so stale beliefs decay instead of entrenching).
4. **Contradiction is surfaced, not silently overwritten** — the dedup search
   finds the prior lesson; a genuine reversal is a reviewed decision.
5. **The privacy pre-flight is never bypassed** — secrets / PII are dropped, not
   stored.

---

## Wiring checklist

To add a loop to a host called `<host>`:

- [ ] Pick the bucket: tag `loop::<host>-lessons`, key `<host>-lessons::<slug>`.
- [ ] Add the **read step** at the start of the host's run (narrow-to-broad
      `memory.list` filtered by the tag; apply matches as considerations; skip
      expired).
- [ ] Add the **write step** at the host's existing failure / end-of-run points
      (classify scope, `memory.search` to dedup, `memory.write`). No new
      reflection stage — hook the points the host already detects.
- [ ] Add the **promotion suggestion** when a read/written lesson hits
      `seen_count >= 3` or `status=structural`.
- [ ] State the **entrenchment guards** so a future maintainer does not "optimize
      them away".
- [ ] Confirm the loop **degrades silently** when `memory.*` is not connected.

---

## Interactive setup

When a user asks to set up self-improving memory for a specific host, walk them
through it rather than dumping the whole recipe:

1. **Confirm it should have a loop** — run the "when to add a loop" test above.
   If the host is a one-shot utility, an adversarial pass, or a secret-handler,
   say so and stop.
2. **Name the bucket** — `loop::<host>-lessons` from the host's name.
3. **Locate the read and write points** — the start of a run, and the failure /
   end-of-run points the host already has. Show the two `memory.*` snippets with
   the bucket filled in.
4. **Write the guards down** in the host's own docs, so they survive future edits.
5. **Do a dry run** — trigger a failure, confirm a lesson is written to the right
   scope with the right tag, then confirm the next run reads it back.
