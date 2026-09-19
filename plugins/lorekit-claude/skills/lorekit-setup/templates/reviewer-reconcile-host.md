# Recipe card — reviewer / reconcile host

For a host that **produces durable outputs at a shared target it revisits**: a PR
reviewer posting comment threads it re-reviews on every push, a triager filing issues
it re-scans, a linter opening tickets. A plain read/write loop is not enough — stale
outputs pile up at the target and the signal about which outputs were *useful* is
thrown away. This card adds the **reconcile-on-re-run** flow on top of the lessons
loop, feeding a second **Signal** bucket.

Fill in: `<host>` (e.g. `reviewer`), `<signal>` (e.g. `comment-relevance`),
`<owner>/<repo>`. `N = 5`.

## Buckets (two)

- Lessons: tag `loop::<host>-lessons`, key `<host>-lessons::<slug>` — how to review better.
- Signal: tag `loop::<host>-<signal>`, key `<host>-<signal>::<pattern-fingerprint>` —
  which of the host's OUTPUT PATTERNS get acted on vs declined at this target.

## Read step — start of run

```text
# Own lessons (capped at N per scope):
memory.list { scope: "repo::<owner>/<repo>", tags: ["loop::<host>-lessons"], limit: 5 }
memory.list { scope: "global",               tags: ["loop::<host>-lessons"], limit: 5 }

# Signal bucket — suppress reliably-declined patterns, reinforce reliably-resolved ones:
memory.list { scope: "repo::<owner>/<repo>", tags: ["loop::<host>-<signal>"], limit: 20 }
```

## Reconcile step — at the re-run seam, gated on "a prior output exists at this target"

For each prior output the host itself authored, classify against the current target:

| Outcome | Meaning | Evidence |
| --- | --- | --- |
| **resolved** | acted on — the flagged thing is handled | the region changed and the finding no longer reproduces, or the owner acknowledged it |
| **declined** | explicitly rejected | a "won't fix" / "by design" reply, a 👎 |
| **still-open** | still reproduces this run | the host re-produces the same output |

Then:

1. **Clean up** `resolved` + `declined` at the source (resolve the thread, close the
   ticket). **Never** touch a `still-open` output. Only ever touch outputs the host
   authored. Cleanup is idempotent and non-fatal (a cleanup error is logged, never
   fails the run).
2. **Record the outcome** to the Signal bucket, keyed by a stable pattern fingerprint
   (never a line number or a drifting id):

```text
memory.write {
  scope:    "repo::<owner>/<repo>",
  key:      "<host>-<signal>::<pattern-fingerprint>",
  value:    "<markdown: the pattern, and resolved-vs-declined evidence — no hidden blocks>",
  tags:     ["loop::<host>-<signal>", "status::<resolved | declined>"],
  trigger:  "reconcile",
  ttl_days: 90
}
```

`still-open` writes nothing — there is no outcome yet. **Absence of confirmation is not
resolution**: if a re-run did not re-scan the region a prior output covers, it is
`still-open`, not `resolved`.

## Write step (lessons) — on friction, as usual

Same as any lessons loop — see [code-changing-agent.md](./code-changing-agent.md#write-step--on-failure--at-end-of-run)
for the write shape.

## Fire-once check

1. Produce an output at a test target, then resolve it at the source by hand.
2. Re-run; confirm the host classifies it `resolved`, cleans it up, and writes a
   positive Signal record for its pattern.
3. Start a third run; confirm the Signal record surfaces and reinforces that pattern.

## Reference implementation

The `agent-skills` `pr-reviewer` agent: it resolves its own addressed PR threads on
each commit-triggered re-review and records the fixed/declined outcome to a
`reviewer-comment-relevance` bucket. Full flow:
[the reconcile-on-re-run flow](../rules/self-improvement-loops.md#the-reconcile-on-re-run-flow-resolve--record).

## Prove it

[proving-improvement.md](../rules/proving-improvement.md) — for this host the signal is
the **decline rate** of the host's outputs trending down over runs.
