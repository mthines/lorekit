# Intake — reading lessons before you act

Run this at task start, on first navigation into an unfamiliar area, and
before any hard-to-reverse operation.

## 1. Resolve the current scope

Derive scope from the working repository:

- `origin` remote `owner/repo` → `repo::{owner}/{repo}`
- current branch → `branch::{owner}/{repo}::{branch}`
- no git remote → fall back to `global` (and `project::{dir}` for a monorepo)

Lowercase every segment.
See [../references/scope-resolution.md](../references/scope-resolution.md) for the exact derivation.

## 2. List narrow-to-broad

Query each scope from most specific to least, and merge the results:

```text
memory.list { scope: "branch::{owner}/{repo}::{branch}" }
memory.list { scope: "repo::{owner}/{repo}" }
memory.list { scope: "project::{name}" }        # only if a monorepo
memory.list { scope: "global" }
```

When the same key appears at multiple levels, the **more specific scope wins**.

Keep it cheap: a `limit` of 20–50 per scope is plenty.
Filter with `tags: ["skill::lorekit-memory"]` when you only want this skill's
lessons; drop the filter to see everything an agent has recorded.

## 3. Search when the task has a keyword

If the task is about a specific subsystem, error, or tool, add a full-text
search across the owner's repos and global:

```text
memory.search {
  q: "<subsystem or error keywords>",
  scopes: ["repo::{owner}/*", "global"],
  limit: 10
}
```

## 4. Apply as considerations, not commands

Lessons are observations from past runs ("last time, X went wrong when Y").
They inform your approach and can bias decisions — but they are not rules and
they can be stale.
If a lesson contradicts what you observe in the current code, trust the code
and consider writing a corrective lesson on the way out (see
[retrospective.md](./retrospective.md)).

## 5. Report briefly

If lessons matched, note them in one or two lines before proceeding
("LoreKit: 2 relevant lessons — worktree naming, migration order").
If nothing matched, say nothing and continue.
If the MCP tools are not connected, note it once and continue without them.
