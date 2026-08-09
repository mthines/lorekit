# @lorekit/evals

A local eval harness that measures one thing: **does a stored, loaded LoreKit
lesson make the agent do better work on a fresh-context retry?**

The agent under test is headless Claude Code (`claude -p`) wired to the _real_
memory path — the `lorekit mcp` stdio server and the real `SessionStart` hook,
reading a scratch store. Nothing here is mocked, because a mock would measure
the mock.

> **N=3 is an INDICATOR, not proof.** Three repetitions per arm cannot support a
> significance claim, and none is made. Read every number here as directional:
> it tells you where to look, not what is true. Widening N, not reinterpreting
> the same three runs, is the way to a stronger claim.

> **Nothing here gates anything.** These evals are never run in CI and never run
> from `node --test`. Live runs are slow, costly and flaky; gating on a signal
> whose stability has not been established would only teach people to re-run the
> job until it passes. When the signal is shown to be stable, that is the moment
> to revisit — as a deliberate decision, not a default.

## Status

PR3 of six. Shipped: the package and per-run isolation, the `claude -p` spawner,
the memory arms, scope control, and the golden task with its deterministic
grader. Still to come: metrics and reporting (PR4), the scale/position sweep
(PR5), and the code-review domain (PR6).

## The golden task

Record a lesson scoped to the `feat/x` branch of `mthines/gw-tools`. Exactly one
string is correct:

```
branch::mthines/gw-tools::feat/x
```

The gotcha is that `::` is the only valid separator and a branch scope carries
the repo _and_ the branch separated by a **second** `::`. `branch:owner/repo`,
`branch::owner/repo/branch` and `branch::branch::owner/repo` are all wrong.

The prompt names the repository, the branch and the key, and says nothing about
the scope format — not even that a format gotcha exists. An agent warned to be
careful about separators is solving an easier task than a real turn presents.
The target scope never appears in the prompt, and neither does a literal `::`;
that last one is why the task's key has no `::` in it, which a test caught.

Full statement, rubric and the two stubbed alternates: `fixtures/spec.md`.

## Grading

No model judges anything. Success is exact string equality with the target;
partial credit exists but never becomes success.

| Points | Criterion                                                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 100    | a stored scope equals the target exactly — **binary success**                                                                                                   |
| 80     | a stored scope only _normalizes_ to the target — it differs by case or surrounding whitespace, which `validateScope` folds away, but is not the target verbatim |
| 60     | valid `branch::` scope, right repo, wrong branch                                                                                                                |
| 40     | `repo::mthines/gw-tools` — right repo, coarser granularity                                                                                                      |
| 20     | something was written, at an invalid or unrelated scope                                                                                                         |
| 0      | nothing was written                                                                                                                                             |

Validity is decided by `validateScope` from `packages/mcp-core/src/scope.ts`,
the same function the product enforces. `repeatedMistake` fires when the agent
made the specific mistake the stored lesson warns about — that flag is what the
whole experiment turns on.

The grader reads **two** sources, and needs both:

- against the **hosted** store an invalid scope is rejected and never lands, so
  the mistake exists only in the transcript;
- against the **offline** store the harness uses, `store.write` performs no
  scope validation at all — verified: `branch:mthines/gw-tools` writes
  successfully in local mode — so the mistake lands in the store and the agent
  is never told. (`lorekit lint`'s malformed-scope rule exists because offline
  stores accumulate exactly these.)

Reading the union keeps one grader correct in both modes. It also means the
offline run measures **recall without a corrective signal**: the agent gets no
rejection to learn from mid-turn, so a wrong scope stays wrong. That is a
cleaner read of what memory contributed — no trial-and-error confound — but it
does mean the friction signal on this task will be near zero, and a run against
a remote store would not be comparable.

Store scopes are enumerated with the store's own `listScopes()` rather than
probed at expected locations: the agent may write somewhere nobody predicted,
and a grader that only looked where it expected would score that as "nothing
written".

## The arms

| Arm | Store                                     | Hook      | What it isolates                                                 |
| --- | ----------------------------------------- | --------- | ---------------------------------------------------------------- |
| 0   | empty, write allowed                      | off       | The first attempt, and the source of the organic lesson.         |
| A   | empty                                     | installed | The retry with no memory — the control.                          |
| B   | seeded (organic \| canonical)             | installed | The retry with memory. The only difference from A.               |
| C   | empty, attempt-0 transcript in the prompt | installed | Diagnostic: does the lesson beat just re-reading the transcript? |

Arm B runs twice, once per lesson source. **Organic** is the agent's own arm-0
wording, stored verbatim — warts included, because the point of that source is
that it is what the loop would really have saved. **Canonical** is a curated gold
lesson that states the rule and the failure mode but deliberately does not
restate the task; a lesson containing the answer to the exact prompt would
measure copying rather than recall.

## Scope is chosen, not derived

A LoreKit scope is an explicit argument: `memory.write` requires `scope`, and no
write path in the CLI derives one. Git decides only which scopes a _directory_
discovers — `deriveScope` turns the remote and branch into the `readOrder` the
SessionStart hook reads from. In a directory with no repository the read order
is just `[project::<basename>, global]`, yet a `branch::owner/repo::x` lesson
still writes there perfectly happily. It simply is never injected.

That gap is the reason the harness treats scope as a first-class knob rather
than a consequence of the sandbox's git identity. Without it, an arm-B rep that
fails is unreadable — it could mean either of two unrelated things:

| Retrieval state       | A failure means                                           | Report it as                                             |
| --------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| `injected`            | the lesson was on screen and the agent still got it wrong | **utilization**                                          |
| `in-store-not-loaded` | the lesson never reached the context at all               | **retrieval** — the lesson's content is not on trial     |
| `absent`              | nothing was stored                                        | **harness fault** — discard the rep, never average it in |

`classifyRetrieval` computes that state for every rep and it travels with the
result. Collapsing the three would let a seeding regression read as evidence
that memory does not work, which is the most expensive mistake this harness
could make.

`--scope-mode global` is the control that isolates scope resolution from memory
utility: global injects in any directory, git or not. If arm B lifts at `global`
but not at `branch::`, that is a scope-resolution finding, not a memory finding.

```bash
node bin/run-eval.mjs probe --scope-mode global            # injects, no git needed
node bin/run-eval.mjs probe --scope-mode branch --no-git   # written, never injected
```

Git identity defaults to on only for the modes that need it (`branch`, `repo`).
`--no-git` with a branch scope is a legal, deliberately-broken arm — it is how
the harness reproduces a retrieval failure on purpose, and the second command
above is the executable demonstration.

## Memory arms

Only the memory tools are allowed, and only the read ones. An arm that could
call `memory_write` mid-run would contaminate its own store between attempts and
the retry would no longer be measuring the lesson it started with; arm 0, whose
job is to produce that lesson, is the one case that opts in.

Inspect what an arm's agent would actually see, with no model and no cost:

```bash
node bin/run-eval.mjs probe --seed canonical
node bin/run-eval.mjs probe --seed organic --lesson "$(cat lesson.md)"
node bin/run-eval.mjs probe --seed empty        # arm A: expect zero injected
```

`probe` seeds the store, installs the real hook, runs it exactly as Claude Code
would, and prints the injected index — scope, key and observed position per
lesson. It is the fastest way to answer "is arm B actually different from arm
A?" before spending a single token.

## Running

```bash
pnpm install
pnpm nx test evals                 # pure-logic units — fast, deterministic, no model
cd packages/evals && node --test test/*.test.mjs
```

Live runs are manual and spend real tokens:

```bash
cd packages/evals
node bin/run-eval.mjs arm0 --dry-run          # plan + artifact tree, no model call
node bin/run-eval.mjs arm0 --reps 1 --out ./.eval-out
```

Requires the `claude` CLI on `PATH` and an authenticated Claude Code install.
Cost scales with reps × arms; the PR1 placeholder prompt is a few cents per
attempt, but the golden task in PR3 will be materially more, so start at
`--reps 1` when validating plumbing.

| Flag              | Meaning                                                  |
| ----------------- | -------------------------------------------------------- |
| `--reps <n>`      | Repetitions per arm (default 3).                         |
| `--out <dir>`     | Artifact root (default `./.eval-out`).                   |
| `--timeout <ms>`  | Hard wall-clock ceiling per attempt.                     |
| `--command <bin>` | Agent binary; override to substitute a stand-in.         |
| `--keep`          | Leave each sandbox on disk for inspection.               |
| `--dry-run`       | Build the plan and artifacts without spawning the agent. |

Artifacts land under `<out>/arm0-<runId>/rep-<n>/` as `transcript.jsonl`,
`result.json` and `meta.json`, with a `summary.json` per run. They are written
so a result can be re-read months later without re-running it — which is also
why the low-power caveat is embedded in `summary.json` rather than only here.

## Isolation

Every repetition gets a throwaway world, and no repetition can see another's.
`src/sandbox.mjs` creates one `mkdtemp` root holding the working directory, a
scratch `$LOREKIT_HOME`, a scratch `$LOREKIT_STORE` and an artifact directory,
then hands children `LOREKIT_MODE=local` plus `LOREKIT_TELEMETRY=0` /
`DO_NOT_TRACK=1`.

That is not a convention the harness politely follows — it is how
`packages/cli/src/control.mjs` already resolves its store, so there is no code
path from a sandboxed run to `~/.lorekit`. A guard throws if a scratch home ever
resolves inside the real one, `dispose()` is idempotent and runs in a `finally`,
and `withSandbox` tears down even when the body throws.

## Design notes settled in this PR

These were the load-bearing unknowns; each is now pinned by an executable check
rather than by prose, so an upstream change breaks a test instead of quietly
invalidating the harness.

- **Importing the canonical scope validator.** `@lorekit/core` ships no build
  output and declares no `exports` map, so there is no built entry to import.
  Node ≥ 22.18 strips types on load, so `@lorekit/core/src/scope.ts` imports
  directly — no build step, and crucially no vendored second validator that
  could drift from the one the product enforces. Pinned by
  `test/cross-package-imports.test.mjs`; the engine floor is in `package.json`.
- **Staying out of the TS lint gate.** `@nx/eslint/plugin` _does_ infer a `lint`
  target for a new package (confirmed with `nx show project evals`), so
  `packages/evals/**` is added to the root `eslint.config.mjs` `ignores` beside
  `packages/cli/**`, for the same reason: a pure-`.mjs` `node:test` package has
  no TS config to lint against. Re-check with
  `pnpm nx show project evals --json` after an nx upgrade.
- **Wiring the SessionStart hook (PR2).** Neither shelling out to `lorekit
install` nor hand-writing the settings block: `upsertClaudeHooks(root, scope,
runner, ['SessionStart'])` is exported from `packages/cli/src/config.mjs` and
  writes the canonical block itself. Using it keeps the harness in lockstep with
  `CLAUDE_HOOK_EVENTS` by construction rather than by a drift test.
- **A git-identity sandbox needs a commit, not just `git init`.** `deriveScope` builds
  the scopes the hook reads from `remote.origin.url` and the current branch, so
  a bare temp directory has no `branch::mthines/gw-tools::feat/x` scope at all
  and a lesson seeded there would never be injected — arm B would differ from
  arm A only in a store nobody reads. `git init` alone is not enough either:
  `git rev-parse --abbrev-ref HEAD` fails on an unborn branch, `deriveScope`
  swallows that and returns `branch: null`, and the whole experiment degrades
  silently. So the sandbox gets an empty initial commit, and
  `assertScopesAvailable` fails the run up front rather than letting it produce
  numbers that look fine.
- **Transcript capture.** `--output-format stream-json --verbose` is captured
  rather than `json`, because its final `{"type":"result"}` line carries
  everything `json` would return _and_ the full event stream. One run therefore
  yields both the turn/token/cost numbers and a JSONL transcript in the
  `message.content[]` shape `detectFriction` already reads — where
  `--output-format json` would force a second, different run to recover the
  stream. Not yet confirmed against a live `claude` binary (none is installed in
  the authoring sandbox); `outputFormat` stays overridable.

## What "no CI gate" does and does not mean

The LIVE runs gate nothing. Everything below the model does: the store, the
hook, the derived scopes and the injected index are deterministic functions of
the sandbox, so `pnpm nx test evals` asserts — for real, on every PR — that a
seeded lesson is injected, that an empty store injects nothing, that the hook
block matches `CLAUDE_HOOK_EVENTS`, and that the two arms differ in nothing but
the store. The plan expected these to be manual smokes; they did not need to be,
and an automated version fails on the PR rather than three weeks into a sweep.

## Reuse, not re-implementation

The harness is a leaf consumer. It imports `detectFriction` from
`packages/cli/src/core/friction.mjs` and `validateScope` from
`packages/mcp-core/src/scope.ts` and never reproduces either. A harness that
graded with its own copy of the scope rules would keep passing while the product
changed underneath it, which is the one failure mode that would make every
number it prints meaningless.

Everything that knows the shape of an external format is isolated: `claude`
flags and stream parsing in `src/agent.mjs`, pr-reviewer output parsing in
`src/review-grade.mjs` (PR6). A format change then fails one module against one
fixture rather than the whole suite.

## Measuring the forthcoming relevance change

The harness deliberately encodes **no** assumption about lesson ordering or the
`MAX_LESSONS` cap. Position is read back from the real injected set, never
computed from a rule. Today's ordering in `packages/cli/src/core/lessons.mjs` is
exactly what the relevance work will change; a harness that hard-coded it would
be blind to the only change it exists to detect. Re-running the suite before and
after that change is the intended measurement.

## Docs applicability

**User-facing docs, `llms.txt`, MDX and dashboard copy do not apply.**
`@lorekit/evals` is a private internal research tool: it ships no MCP tool, REST
route, CLI command or flag, config key, env var, scope rule, error contract or
dashboard surface, and only consumes the existing CLI and store. Per
`CLAUDE.md` → "User-facing docs", the rule fires on a user-observable capability
change; there is none. This README is the documentation surface that applies.
