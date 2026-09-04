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
- [Cross-bucket reads (targeted, read-only)](#cross-bucket-reads-targeted-read-only)
- [Shared codebase-knowledge (the standard cross-loop layer)](#shared-codebase-knowledge-the-standard-cross-loop-layer)
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

## Cross-bucket reads (targeted, read-only)

The default is strict: a loop reads **only its own bucket**, filtered by
`loop::<host>-lessons`. That isolation is deliberate — it keeps one loop's
lessons from drowning another's, and lets each read fire at its own cadence
against its own decision point. Wholesale "read every lesson this repo knows"
is an **anti-pattern**: it reintroduces exactly the noise the tag split exists
to prevent, and buries the matches that would have fired.

There is **one** shape of cross-bucket read that is safe and worth wiring: a host
reading **another host's Signal or Knowledge bucket, matched by a structural key,
strictly read-only**. Wire it only when all four hold:

1. **The other bucket is keyed by something structural** — a `symbol@path`, a
   file path, a stable fingerprint — never by prose. A structural key is what
   makes a cross-host read meaningful: it matches the reader's own concrete work
   (the files or symbols it is about to touch), not a vague topic.
2. **The read is bounded to the reader's current work.** Match the other bucket's
   keys against the paths / symbols this run will actually touch and ignore the
   rest — never load the whole bucket as advice.
3. **The reader treats it as advisory and re-verifies.** A cross-host fact can be
   stale — it carries the *writer's* `verified_at_sha`, not the reader's. It
   **raises care** (more coverage on a hotspot, design around a known invariant)
   but never lowers a bar, skips a step, or suppresses a finding. An absent
   record is never evidence of safety.
4. **The reader never writes the other bucket.** Write ownership stays with the
   one owning host; a second writer corrupts its provenance. Cross-host is a
   **read** relationship only.

Do **not** cross-read another host's `loop::<host>-lessons`. Lessons are prose
"how to do better" advice tuned to that host's own decisions; they re-key on
rephrasing and carry no structural anchor to match against, so a cross-read of
them is the wholesale anti-pattern above. Only Signal / Knowledge buckets with
structural keys qualify.

LoreKit ships **one** standard instance of this pattern — the shared
`codebase-knowledge` bucket that every code-touching loop reads and writes. It is
the mechanism behind the automatic synergy below, and it is what makes a
structural key worth insisting on: a fixed name plus a `symbol@path` key is what
lets a loop wired by one person be consumed by a loop wired by another. It is
specified in full next.

---

## Shared codebase-knowledge (the standard cross-loop layer)

The cross-bucket read above becomes **automatic** through one bucket every LoreKit
loop shares by name: `codebase-knowledge`. This is the reason two skills wired
independently — by different people, in different sessions, in the same repo —
still compound: they read and write the *same* repo-scoped, structurally-keyed
record of what the codebase has taught every loop that touched it. A code-changing
loop plans and edits with that history in hand instead of blind; and because the
loops that consume it also feed it, the synergy appears for a user who wired a
single skill and nothing else.

### The bucket

| Field | Value |
| --- | --- |
| **Tag** | `codebase-knowledge` |
| **Kind** | `signal` (a durable per-repo filter, read on every run that touches code) |
| **Scope** | `repo::{owner}/{repo}` — a codebase fact is repo-bound |
| **TTL** | ~90 days, refreshed on re-verification |
| **Keys** | `knowledge::<symbol>@<path>` — verified facts about one symbol (an invariant it holds, its consumer/dependent count, a defect it produced before); `hotspot::<path>` — per-file counters (`confirmed`, `regressed`, `missed`) |

The keys are **structural** (`symbol@path`, `path`) on purpose: a key survives a
rename of the *finding* but not a rename of the *code*, which is exactly the
sensitivity that lets a different loop match it against the files it is about to
touch. Set `kind: signal` and `host` explicitly on every write — LoreKit infers
them only from a `loop::` tag, and this bucket is not tagged that way.

### Read side — automatic for any code-touching host

Wire it at the host's **plan/apply seam** — the moment it has the concrete
file/symbol list it will change (a plan's File Changes list, an apply pack, a
fix's target file):

```text
memory.list { scope: "repo::{owner}/{repo}", tags: ["codebase-knowledge"], limit: 100 }
# keep only hotspot::<path> / knowledge::<symbol>@<path> whose <path> (and <symbol>)
# this run will actually touch. Apply as PLANNING INPUTS: raise coverage on a
# hotspot, design around a known invariant / consumer count. Advisory and
# re-verified against the code — never a reason to skip a step or suppress a finding.
```

This is the read-side contract from [Cross-bucket reads](#cross-bucket-reads-targeted-read-only)
made concrete: structural match, bounded to this run, advisory, an absent record
never evidence of safety.

### Write side — how the layer fills, and why many writers stay safe

A host that **verifies** a structural fact contributes it back, so the next loop
reads it. This is what makes the synergy automatic even for a user with one skill
and no dedicated reviewer: the loops that consume the layer also feed it.
Multi-writer is safe **only** behind this write contract — bake in every bullet,
or do not wire the write:

- **Structural key from a real symbol/path list**, never composed from prose. A
  prose key accumulates nothing and no reader can match it.
- **`verified_at_sha` on every fact** — the HEAD this run verified it at. It is the
  whole mechanism the next reader uses to decide "fact stands" vs "re-verify"; an
  absent or stale SHA makes the fact permanently unverifiable, and it is dropped.
- **`source_agent` stamped** — which host verified it. Together with
  `verified_at_sha` this is what makes many writers safe: a reader sees who
  verified what, and when, so no writer silently overwrites another's provenance.
- **Only what THIS run actually verified**, grounded in the code — never a guess,
  and never a value about a person or a telemetry reading. A fact about code,
  keyed to code.
- **Merge, never clobber.** Read the existing record first; append to `history[]`
  or increment counters (each capped) and carry the rest through unchanged. A
  clobbered counter is indistinguishable from a first write.
- **Raise care, never suppress.** These records only raise priority/coverage on a
  file or symbol. They never lower a bar or silence a finding, and an absent record
  is never evidence of safety. Suppression, if a host needs it, is a different
  bucket behind verification (the Signal in the reconcile flow above).
- **Explicit `kind: signal` + `host`, a TTL, and the privacy pre-flight** — as
  every write in this skill.

Because the name is fixed, the read is the same call in every host, and the write
follows one contract, **any two LoreKit-wired loops in the same repo compound
automatically** — which is the whole reason to standardize the name instead of
letting each host invent its own. The reference ecosystem is `agent-skills`: the
`pr-reviewer` agent is the primary writer (it verifies symbol facts and file
hotspots during review), and every code-changing host — `aw`, `implement-suggestion`,
`fix-bug`, `ci-auto-fix` — reads the layer at its plan/apply seam.

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

A recurring lesson can be promoted a second time, past the prose rule above,
into a **compiled invariant** — a declarative, mechanically-checked assertion
instead of text a reader has to notice and act on. Most lessons never qualify
(the failure mode has to be judgement-free and checkable against an
independent source of truth); when one does, see
[compiled-invariants.md](./compiled-invariants.md) for the compilability test,
the `candidate → advisory → gating → retired` ladder, and
`lorekit invariants candidates`, the scan that surfaces compile candidates from
the store.

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
- [ ] If the host **touches code**, wire the **[codebase-knowledge](#shared-codebase-knowledge-the-standard-cross-loop-layer)
      read** at its plan/apply seam (match `hotspot::<path>` /
      `knowledge::<symbol>@<path>` to the files it will change). If it **verifies**
      a structural fact, wire the **write** behind that section's contract.

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
