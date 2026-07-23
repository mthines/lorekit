# Scope Format

A scope string partitions memory into named namespaces. It is the primary key used to organise, retrieve, and restrict access to lessons.

## Canonical format

`::` is the **only** valid separator. Any other separator (`:`, `/`, `-`) returns a `400` error.

| Scope type | Format | Example |
|-----------|--------|---------|
| Global | `global` | `global` |
| Project (monorepo) | `project::{name}` | `project::agent-skills` |
| Repository | `repo::{owner}/{repo}` | `repo::mthines/gw-tools` |
| Branch | `branch::{owner}/{repo}::{branch}` | `branch::mthines/gw-tools::feat/add-memory` |

All segments are normalised to **lowercase** by the server.

## Choosing the right scope

| Lesson type | Recommended scope |
|-------------|-------------------|
| Universal principles (always apply) | `global` |
| Lessons about this specific repo's codebase | `repo::{owner}/{repo}` |
| Experimental learnings on a feature branch | `branch::{owner}/{repo}::{branch}` |
| Lessons shared across a monorepo | `project::{name}` |

**Rule of thumb:** use the narrowest scope that correctly describes where the lesson applies. Branch-scoped lessons don't pollute the repo's lesson set; repo-scoped lessons don't pollute global.

## Scope resolution (agent reads)

When an agent reads context before working on a task, it should query multiple scopes and merge the results:

```bash
# In order of specificity (narrow → broad)
memory.list { scope: "branch::mthines/gw-tools::feat/x" }   # branch-specific
memory.list { scope: "repo::mthines/gw-tools" }              # repo-level
memory.list { scope: "project::gw-tools" }                   # project-level (if monorepo)
memory.list { scope: "global" }                              # universal
```

More specific scopes take precedence when the same key exists at multiple levels.

## Wildcard search

The `memory.search` tool accepts owner-level wildcards in the `scopes` parameter:

```json
{ "scopes": ["repo::mthines/*"] }  // all repos under mthines
{ "scopes": ["global", "repo::mthines/gw-tools"] }  // explicit multi-scope
```

Wildcards only work in `memory.search` — not in `memory.read`, `memory.list`, or `memory.delete`.

## Validation rules

1. `::` is the only separator. Single `:` → 400.
2. `repo::` format must include a `/` (owner/repo). `repo::mthines` → 400.
3. `branch::` format must have exactly two `::` separators. `branch::mthines/gw-tools` → 400.
4. Unknown prefixes → 400. Only `global`, `project`, `repo`, `branch` are valid.
5. Segments are trimmed and lowercased on ingest.
