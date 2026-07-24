# Scope resolution

A scope string names the namespace a lesson belongs to.
`::` is the **only** valid separator — a single `:` returns a 400 error.
All segments are lowercased by the server.

## The four scope types

| Type | Format | Example |
|------|--------|---------|
| Global | `global` | `global` |
| Project (monorepo) | `project::{name}` | `project::agent-skills` |
| Repository | `repo::{owner}/{repo}` | `repo::mthines/lorekit` |
| Branch | `branch::{owner}/{repo}::{branch}` | `branch::mthines/lorekit::feat/x` |

## Deriving scope from the working directory

1. Read the `origin` remote URL and normalize it to `owner/repo`:
   - `git@github.com:mthines/lorekit.git` → `mthines/lorekit`
   - `https://github.com/mthines/lorekit.git` → `mthines/lorekit`
   - strip a trailing `.git`, lowercase the result.
2. Read the current branch: `git rev-parse --abbrev-ref HEAD`.
3. Compose:
   - `repo::mthines/lorekit`
   - `branch::mthines/lorekit::{branch}`
4. If there is no git remote, there is no repo/branch scope — use `global`,
   and optionally `project::{basename-of-repo-root}` for a monorepo.

The LoreKit CLI's `doctor` command prints the scope it derives, which is a
quick way to confirm the agent will read and write to the right place.

## Read order (intake)

Query most specific first, then merge; more specific scopes win on key collisions:

```text
branch::{owner}/{repo}::{branch}   →   repo::{owner}/{repo}   →   project::{name}   →   global
```

## Write scope (retrospective)

Use the narrowest scope that correctly describes where the lesson applies:

- Branch-scoped lessons do not pollute the repo's lesson set.
- Repo-scoped lessons do not pollute global.
- Only truly universal lessons belong in `global`.

## Wildcards (search only)

`memory.search` accepts an owner-level wildcard in `scopes`:

```json
{ "scopes": ["repo::mthines/*", "global"] }
```

Wildcards work **only** in `memory.search` — not in `memory.list`,
`memory.read`, or `memory.write`.

## Validation rules

1. `::` is the only separator; a single `:` → 400.
2. `repo::` must include a `/` (owner/repo); `repo::mthines` → 400.
3. `branch::` must have exactly two `::` separators.
4. Only `global`, `project`, `repo`, `branch` prefixes are valid.
5. Segments are trimmed and lowercased on ingest.
