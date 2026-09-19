# Recipe card — multi-step orchestrator

For a **pipeline that fails in classifiable ways** but does not post durable outputs at
a shared target and does not (necessarily) edit code: a triage → plan → execute
workflow, a release orchestrator, a batch processor. The plain two-tier lessons loop
fits it exactly. This is the card to start from when no other card matches.

Fill in: `<host>` (e.g. `deploy`), `<owner>/<repo>`. `N = 5`.

## Bucket

Tag `loop::<host>-lessons`, key `<host>-lessons::<slug>`. One bucket per host.

## Read step — start of every run

```text
memory.list { scope: "repo::<owner>/<repo>", tags: ["loop::<host>-lessons"], limit: 5 }
memory.list { scope: "global",               tags: ["loop::<host>-lessons"], limit: 5 }
# when the run names a stage/error, one targeted search:
memory.search { q: "<keywords>", scopes: ["repo::<owner>/*", "global"], limit: 5 }
```

Match each **Applies when** against the current run; apply matching **Do this instead**
lines as considerations. `repo::` beats `global` on a collision.

## Write step — at the host's EXISTING failure points

Do not add a new reflection stage — hook the points the host already detects (a stuck
loop, a repeated failure, a gate that should have caught something, a near-miss, a
guess that paid off). Not on smooth successes.

```text
memory.search { q: "<key words of the lesson>", scopes: ["repo::<owner>/<repo>", "global"], limit: 10 }

memory.write {
  scope:    "<global | repo::<owner>/<repo>>",
  key:      "<host>-lessons::<slug>",
  value:    "<markdown lesson body — no hidden blocks>",
  tags:     ["loop::<host>-lessons", "source::<trigger>"],   # + "status::structural" when it is
  trigger:  "<stuck-loop | command-failure | gotcha | near-miss | assumption-wrong | paid-off>",
  ttl_days: 90
}
```

Same `scope` + `key` UPDATEs in place — the store increments `seen_count` for you and
re-passing `ttl_days` refreshes the expiry. Never hand-write a count into the body.

## Lesson body — copy this shape

```markdown
# <one-line takeaway — what to do, not what it is about>

**Applies when:** <concrete signal — stage name, task type, tool name, error shape>

**What happened:** <the concrete observable>
**Why:** <root cause, or "unknown">
**Do this instead:** <prescriptive, testable instruction>
**Promotion target:** <the host step this would harden if promoted, or "none">
```

## Promotion

When a lesson hits `seen_count >= 3` (read the column, not the body) or carries
`status::structural`, surface a one-line promotion suggestion — never act silently.
See [Promotion](../rules/self-improvement-loops.md#promotion-fast--slow).

## Fire-once check

1. Force the failure this loop targets.
2. `memory.list { scope: "<expected>", tags: ["loop::<host>-lessons"], limit: 10 }` — confirm the lesson.
3. Re-run; confirm it surfaces and biases the run.

## Cold start & proof

Optional capped seeding: [cold-start-seeding.md](../rules/cold-start-seeding.md).
Required proof — the immunity re-challenge: [proving-improvement.md](../rules/proving-improvement.md).
