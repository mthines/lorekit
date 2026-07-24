# Retrospective — writing a lesson when something goes wrong

Run this after friction: a stuck loop, a repeated command failure, a
surprising gotcha, a near-miss, a wrong assumption that cost time, or a guess
that paid off and should be reused.
Do **not** run it on smooth successes — there is nothing durable to record.

## 1. Decide if there is a lesson

Ask the 30-second question:

> Would a future run in this repo (or anywhere) do better if it knew this?

If no, stop — write nothing. Empty retrospectives are skipped.
If yes, continue.

## 2. Phrase it as an observation

Write what happened and what worked, not a commandment.

- Good: "Running `pnpm nx test mcp-core` without `supabase start` fails with a
  connection refused error; start Supabase first."
- Avoid: "ALWAYS start Supabase." (rules rot; observations age gracefully)

Keep the body tight markdown. A sentence or three. Include the concrete
signal (the error text, the command, the file) so future search finds it.

## 3. Pick the narrowest scope that fits

| The lesson is about… | Scope |
|----------------------|-------|
| A universal principle, true in any repo | `global` |
| This repository's codebase or tooling | `repo::{owner}/{repo}` |
| A monorepo-wide convention | `project::{name}` |
| A throwaway detail of this branch only | `branch::{owner}/{repo}::{branch}` |

When in doubt for a "stuff went bad" lesson, default to **repo** scope.
Reserve `global` for things that are genuinely true everywhere.

## 4. Choose a stable key

Use a short, kebab-case, namespaced key so related lessons cluster and
re-writes update in place instead of duplicating:

```text
lorekit-memory::<short-slug>
# e.g. lorekit-memory::supabase-start-before-test
```

## 5. Deduplicate before writing

Check for a near-duplicate first, so you update rather than pile up:

```text
memory.search { q: "<key words of the lesson>", scopes: ["repo::{owner}/{repo}", "global"] }
```

- Found the same situation under a key → reuse that **exact scope + key** and
  `memory.write` an updated body (writing the same scope+key updates in place).
  Optionally note "(seen again <short-context>)" so the recurrence is visible.
- Nothing similar → write a new lesson with a fresh key.

## 6. Write

```text
memory.write {
  scope:        "repo::{owner}/{repo}",
  key:          "lorekit-memory::supabase-start-before-test",
  value:        "<observation in markdown>",
  tags:         ["skill::lorekit-memory", "source::stuck-loop"],
  source_agent: "<your agent name, if known>",
  trigger:      "stuck-loop"
}
```

Pick `trigger` / `source::*` from what actually happened:
`stuck-loop`, `command-failure`, `gotcha`, `near-miss`, `assumption-wrong`,
`paid-off`, or `manual`.

## 7. Confirm

State in one line what you recorded and where
("LoreKit: wrote repo lesson `supabase-start-before-test`").
If the write fails because the token is read-only or missing, say so once and
continue — never retry a write that failed on authorization.
