# Golden task — the branch-scope gotcha

The one task every arm runs. It is deliberately small, deterministic, and has a
single correct answer that a program can check without reading prose.

## The task

Record a lesson scoped to the `feat/x` branch of the `mthines/gw-tools`
repository, using the `memory.write` MCP tool.

## The target

```
branch::mthines/gw-tools::feat/x
```

## Why this task

The gotcha is that `::` is the **only** valid segment separator, and a branch
scope carries the repo _and_ the branch separated by a **second** `::`. Every
natural-looking alternative is rejected by the canonical validator:

| Written                            | Why it fails                                             |
| ---------------------------------- | -------------------------------------------------------- |
| `branch:mthines/gw-tools`          | single `:` — the validator rejects this shape explicitly |
| `branch::mthines/gw-tools/feat/x`  | branch appended with `/` instead of a second `::`        |
| `branch::feat/x::mthines/gw-tools` | segments in the wrong order                              |
| `repo::mthines/gw-tools`           | right repo, wrong granularity — no branch                |

This is a good golden task for four reasons:

1. **It is a real, recurring mistake.** The validator carries a dedicated
   rejection branch for the single-colon form precisely because agents keep
   writing it.
2. **It is binary.** A scope either equals the target string or it does not.
   No rubric, no judgment, no grader drift.
3. **It is un-guessable from the working directory.** The sandbox is stripped of
   every agent-instruction file, so the format cannot be read off a doc — only
   remembered, inferred, or discovered by trial and error.
4. **The failure is observable.** A rejected write returns an error the agent
   can react to, so a rep that fails after several attempts is distinguishable
   from one that fails immediately — which is what the friction metric reads.

## Rubric

`grade.mjs` is the only authority. Success is **exact string equality** with the
target; everything else is partial credit, and partial credit never becomes
success.

| Points | Criterion                                                                                                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 100    | A stored scope equals the target exactly. **Binary success.**                                                                                                                                                                |
| 80     | A stored scope _normalizes_ to the target — it differs only by case or surrounding whitespace, which `validateScope` folds away — but is not the target verbatim. Still a failure: the offline store holds what was written. |
| 60     | A stored scope is a _valid_ `branch::` scope for the right repo, but the branch differs.                                                                                                                                     |
| 40     | A stored scope is valid and names the right repo at a coarser granularity (`repo::mthines/gw-tools`).                                                                                                                        |
| 20     | Something was written, but at an invalid or unrelated scope.                                                                                                                                                                 |
| 0      | Nothing was written at all.                                                                                                                                                                                                  |

`repeatedMistake` is flagged when any _attempted_ scope is invalid in one of the
specific ways this lesson warns about. It is the signal the whole experiment
turns on: it fires when the agent made the exact mistake the stored lesson
describes. Each kind is recorded separately, because they are different recall
failures:

| Kind                         | Shape                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `single-colon`               | `branch:mthines/gw-tools` — a single `:` after a known prefix                             |
| `branch-appended-with-slash` | `branch::mthines/gw-tools/feat/x` — the branch glued on with `/` instead of a second `::` |
| `branch-segment-missing`     | `branch::mthines/gw-tools` — the branch segment omitted altogether                        |

## Validity oracle

Validity is decided by `validateScope` from `packages/mcp-core/src/scope.ts` —
the same function the product enforces — never by a copy. A vendored second
validator would keep the grader passing while the product's rules moved, and
every number the harness printed would silently become wrong.

## Seed lesson

`fixtures/canonical-lesson.md`. It states the rule and the failure mode and
deliberately does **not** restate the task; a lesson containing the answer to
the exact prompt would measure copying rather than recall.

## Alternates (stubbed, not built)

Two further tasks are registered as stubs in `task.mjs` for later
generalization. Neither is implemented, because each needs grader machinery the
primary task does not:

- **npx / Storybook hang** — the failure is a process that never exits, so the
  grader needs a hard timeout and must distinguish "hung" from "slow", which
  the exact-match grader has no notion of.
- **Edge bare specifier / import map** — the failure is a boot error inside a
  Deno function, so the grader needs to run the function and parse its startup
  output rather than inspect the store.
