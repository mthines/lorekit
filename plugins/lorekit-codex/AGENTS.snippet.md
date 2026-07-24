<!-- Append to your project's AGENTS.md. This is the fallback for Codex builds
     without hooks, and a useful reinforcement even when hooks are enabled. -->

## Shared memory (LoreKit)

You have LoreKit MCP tools (`memory.list`, `memory.search`, `memory.read`,
`memory.write`) for shared, persistent lessons.

- **At the start of a task**, read lessons narrow-to-broad and merge them:
  `memory.list` for `branch::{owner}/{repo}::{branch}`, then
  `repo::{owner}/{repo}`, then `global`. Treat them as considerations, not
  rules. Derive `{owner}/{repo}` and `{branch}` from git, lowercased.
- **When something goes wrong** — a stuck loop, a repeated failure, a gotcha,
  a near-miss, or a wrong assumption that cost time — record it with
  `memory.write` to the narrowest fitting scope (default `repo::{owner}/{repo}`),
  key `lorekit-memory::<slug>`, tags `["skill::lorekit-memory", "source::gotcha"]`,
  phrased as an observation. Search first to update a near-duplicate. If
  nothing durable happened, write nothing.
