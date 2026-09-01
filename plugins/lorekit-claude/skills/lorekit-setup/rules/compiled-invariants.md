# Compiled invariants (the third rung)

A lesson that keeps recurring can go two places. [self-improvement-loops.md](./self-improvement-loops.md)
covers the first: promote it into a **prose rule** — a human-reviewed edit to the
host's own source or docs, still read by whoever (human or model) happens to look.
This file covers the second, harder promotion: turning a recurrence into a
**compiled invariant** — a declarative, checked assertion that a CI gate or a CLI
command enforces mechanically, whether or not anyone reads the rule that day.

## The three rungs

1. **Lesson** (fast, episodic). Written by a model at the end of a run, read at
   the start of the next one. Advisory only — it biases a future run, it does not
   block one.
2. **Prose rule** (slow, procedural). A human-reviewed edit that hardens a
   recurring lesson into the host's own source or docs. Still advisory in the
   sense that nothing *enforces* it — it works only if the next reader (human or
   model) actually reads it.
3. **Compiled invariant** (this file). A declarative entry — in this repo,
   `packages/cli/src/shared/obligations-map.mjs` — that `lorekit obligations`
   checks against a changed-file set. Not advisory: a `gating` entry with an
   independent `guard` fails `--strict`.

Rungs 1 and 2 are **probabilistic** — they depend on someone noticing, reading,
and acting on the text at the right moment. Rung 3 is **deterministic** — the
check runs whether or not anyone was thinking about the rule that day. That is
the entire reason to climb this far: it is strictly more reliable, and strictly
more expensive to build and maintain, which is why most lessons never get here.

## The compilability test

A lesson is a compile candidate only if **all four** hold:

1. **Trigger detectable without judgement.** The condition that should fire the
   check can be recognized from a file path, a diff shape, or another mechanical
   signal — not "whether this edit is the kind that matters," which needs a
   reader's judgement. This is exactly what the existing "trigger-context must be
   concrete" requirement in the lessons loop exists for: a lesson with a vague
   trigger-context was never going to compile, so demanding concreteness at
   write time is what keeps the door open later.
2. **Assertion statable as must-remain-true.** The rule has to be expressible as
   an invariant ("if A changed, B must also be in the changed set"), not a
   preference or a judgement call ("consider simplifying this").
3. **Expected value comes from somewhere OTHER than the memory itself.** The
   check needs an independent source of truth to compare against — a second
   file, a generator's output, an existing test. A lesson that only says "X
   should be true" with no external referent has nothing to check X against.
4. **An enforcement point exists.** Something already runs at the right time —
   CI, a pre-commit hook, a CLI command a human or agent actually invokes — for
   the check to plug into. A perfectly compilable rule with nowhere to run is
   still stuck at rung 2.

Most memories fail this test, and that is the expected, normal outcome — not a
sign the lesson was low-quality. A lesson can be a perfectly good, permanently
useful rung-2 prose rule and never qualify for rung 3, because it fails on
judgement (a design taste) or on having no independent value to check against (a
process reminder). Compilability is a property of the failure mode, not of how
important or how recurrent the lesson is.

## The state ladder

A compiled entry does not start out enforcing anything. It moves through:

```
candidate → advisory → gating → retired
```

- **candidate** — surfaced by `lorekit invariants candidates` (below), not yet a
  map entry. Exists only in a scan's output, never in the repo.
- **advisory** — a hand-written `obligations-map.mjs` entry (`state: 'advisory'`).
  Reported by `lorekit obligations` on every hit, gates nothing, not even under
  `--strict`. This is where every new entry starts.
- **gating** — fails `--strict`. An entry may only be `gating` if it declares an
  independent `guard`: an existing CI spec or script that *already* asserts the
  partnership on its own, so the map entry is surfacing a real check earlier,
  not inventing a new source of truth. An entry with no `guard` stays advisory by
  construction — it would otherwise assert nothing but its own author's belief.
- **retired** — not checked; kept in the map for provenance (why the entry
  existed, when it stopped applying).

Two more rules keep the ladder honest once an entry reaches `gating`:

- **Auto-demotion on false positives.** A `gating` entry that fires on an edit
  it should not have (its `guard` disagrees, or a human overrides it) is a signal
  the entry is too broad or the wrong shape — demote it back to `advisory` rather
  than letting the disagreement stand.
- **A review date.** Every entry carries `reviewBy`; an entry with no independent
  guard gets a shorter horizon than one that does, because it is more likely to
  have been an over-generalization from a single incident.

## The cluster layer

An `obligations-map.mjs` entry does not name a bare lesson key — it names a
**recurrence class**, declared in `packages/cli/src/shared/recurrence-clusters.mjs`.
Read that file's header docblock for the full rationale; the short version is
that naming the class (rather than one lesson) lets several unmet obligations
that share a root cause report as one problem, and gives the compile pipeline a
join point between "a candidates scan over the memory store" and "a human-written
map entry." `RECURRENCE_CLUSTERS` is a short, deliberately curated list — adding
one is an assertion that several distinct memories are really the same class, not
a bucket you reach for per-entry.

## `lorekit invariants candidates`

```
lorekit invariants candidates [--scope <scope>] [--min-seen-count N] [--json]
```

A read-only survey over the memory store. It reuses `dedupe`'s Jaccard clustering
to find near-duplicate lessons, then ranks the resulting clusters by
`(summed seen_count × distinct scopes)`, descending. A cluster is worth
reporting when the summed `seen_count` across its members is at least
`--min-seen-count` (default 3), or any member's `meta` comment already declares a
non-`active` status. For each candidate it prints every memory the merge would
collapse — deliberately the default view, not hidden behind `--verbose`, because
that list *is* the point of the command: a human decides from it whether the
cluster deserves a hand-written entry.

It also reports whether a cluster already resolves to a named recurrence class
via the same join `dedupe` uses — so a scan can tell you "this cluster of five
near-duplicate lessons is already the `copies-a-claim` class" instead of leaving
you to notice by hand.

Two things it deliberately does **not** do, on purpose:

- **It does not classify trigger-contexts.** A lesson's raw `trigger-context`
  string, when present, is printed verbatim — never interpreted into a
  glob/command/error-shape. Turning "parses into a detectable trigger" from a
  string into an actual predicate is the human step the compile pipeline
  protects; automating it would be exactly the "auto-compile" this pipeline
  refuses to do.
- **It does not check `compiled_to`.** No such field exists yet — no schema, no
  server support. A candidate that has already been compiled into an
  `obligations-map.mjs` entry can still surface again on a later scan. This is a
  known, named gap, not a silent one: don't assume a candidate you see today
  hasn't already been acted on, and don't build automation on the assumption
  that a scan's output is the full unresolved set.

It never auto-compiles and never gates anything — it produces a report; a human
reads it and hand-writes the `obligations-map.mjs` entry.

## Where declarations live

Compiled invariants are declared **in the repo** — `obligations-map.mjs` is
reviewable, versioned, ordinary source, subject to the same PR review as any
other code change. They are never stored as memory-store records. The memory
store is the *input* to the compile pipeline (it is what `lorekit dedupe` and
`lorekit invariants candidates` scan) but is never on the critical path of a
gating check — `lorekit obligations` reads only the changed-file set and the
map, never the store, so a store outage cannot silently disable a gate.

## The dedupe prerequisite

This is the most load-bearing sequencing fact in the pipeline: **cluster before
you count.** The compile pipeline is `cluster → groom-merge → compile candidate →
invariant`, in that order, and the clustering step is not optional scaffolding —
it is the thing that makes the `seen_count` threshold meaningful at all.

The concrete case that proves it: the ~45 lesson variants behind the
`copies-a-claim`/`sibling-set` recurrence were not one lesson written 45 times —
they were **~45 distinct keys**, each written once, each carrying its own
`seen_count` of 1. A raw scan for `seen_count >= 3` over the ungroomed store would
have found *nothing*, because no single key ever crossed the threshold on its
own. Only after `lorekit dedupe`'s Jaccard clustering merged the near-duplicates
into groups did the pipeline have anything to sum a `seen_count` over. Skipping
the merge step, or running the candidates scan against an ungroomed store, does
not just produce a worse result — it produces a false negative that looks like
"nothing recurs here."

## `compiled_to` is a named gap

There is deliberately no `compiled_to` field on a memory record today — no
schema for it, no server support. Once a lesson has been compiled into an
`obligations-map.mjs` entry, nothing marks the source memory as resolved, and
nothing stops it from surfacing again in a later `lorekit invariants candidates`
scan or a later `dedupe` pass. This is a known gap, not a claim that the loop
closes end-to-end today — don't describe the pipeline as though a compiled
candidate is automatically suppressed from future scans, and don't build
automation that assumes it is.
