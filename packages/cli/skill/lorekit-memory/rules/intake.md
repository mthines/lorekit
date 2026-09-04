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

## 6. When the run will change code — read the shared codebase-knowledge

Steps 1–4 read **your own** bucket. When this run is about to change code, do one
more read — not optional, it is how the cross-loop synergy reaches you: the shared
**`codebase-knowledge`** bucket. This is the repo-scoped, cross-loop record of what
the codebase has taught every LoreKit loop that touched it
(`knowledge::<symbol>@<path>` facts, `hotspot::<path>` counters). Its keys are
**structural** (`symbol@path`, a file path) rather than prose, so you match them
against the concrete files and symbols this run will touch and pull only the
records that apply. Read it for exactly the files you will change:

```text
memory.list { scope: "repo::{owner}/{repo}", tags: ["codebase-knowledge"], limit: 100 }
# keep only hotspot::<path> / knowledge::<symbol>@<path> whose <path> (and <symbol>)
# the current change will actually touch — a known regression hotspot or a
# repeatedly-flagged symbol is then planned with that history in hand.
```

If this run **verifies** a structural fact about a symbol or file (a consumer
count you swept, an invariant you confirmed, a defect you fixed at a SHA),
contribute it back so the next code-changer benefits — write it to
`codebase-knowledge` under the write contract in the `lorekit-setup` skill,
`rules/self-improvement-loops.md § Shared codebase-knowledge`. The layer fills
because its readers also feed it.

Four rules make this safe, and they are non-negotiable:

- Match **structurally and narrowly** — the paths/symbols of this run, never the
  whole bucket.
- It **raises care, never lowers a bar** — plan more coverage on a hotspot; an
  absent record is not evidence of safety.
- A fact may be **stale** (it carries the writer's `verified_at_sha`) — treat it
  as a consideration and re-verify against the code.
- **Read-only.** Never write another host's bucket; write ownership stays with
  its one owner.

Do **not** cross-read another host's `loop::<host>-lessons` — those are prose
advice with no structural key to match on. The full contract and when to wire a
cross-read into a host is the `lorekit-setup` skill,
`rules/self-improvement-loops.md § Cross-bucket reads (targeted, read-only)`.
