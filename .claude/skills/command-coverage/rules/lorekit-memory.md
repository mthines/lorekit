---
title: LoreKit Memory — recall & record the approach
impact: HIGH
tags:
  - lorekit
  - memory
  - recall
  - record
---

# LoreKit Memory

How this skill uses LoreKit so the *approach* — conventions, decisions, and
previously-found gaps — compounds across runs. Recall in Phase 0; record in
Phase 6. LoreKit is already wired in this repo (the `lorekit` MCP server is
enabled in `.claude/settings.local.json`), so use the `mcp__lorekit__*` tools
directly. If a project has NOT set LoreKit up, run `/lorekit-setup` first.

## Scope & keys

| Field | Value                                                            |
| ----- | --------------------------------------------------------------- |
| Scope | `repo::mthines/lorekit` (repo-shared — every teammate benefits) |
| Key   | `command-coverage::<slug>` (namespaced so grooming is easy)     |
| Tag   | include `command-coverage` in the lesson so a run can find its own set |

## Phase 0 — Recall

Before crawling, load prior insight so the run does not re-derive decisions:

```text
memory_search  q=["command palette","keyboard shortcut","command-coverage","Linear shortcut"]
               scope="repo::mthines/lorekit"
```

Read the top hits in full with `memory_read`. Apply what you find:

- **Convention decisions** (e.g. "`g p` is our Plan binding") → treat as the
  baseline; do not re-propose a different letter.
- **Deferred gaps** ("filter shortcut deferred — handler is page-local") →
  re-check whether the blocker still holds before re-flagging.
- **Rejected proposals** → do not resurface unless the reason changed.

If nothing is found, that is fine — this is the first run; proceed and seed
memory in Phase 6.

## Phase 6 — Record

After the report (and any wiring), write back what a future run should know.
One fact per memory. Write only DURABLE insight, not a transient snapshot.

| Write when…                                    | Example key                                   |
| ---------------------------------------------- | --------------------------------------------- |
| A binding convention was decided               | `command-coverage::binding-plan-is-g-p`       |
| A gap was intentionally deferred (with reason) | `command-coverage::defer-explorer-filter-shortcut` |
| A proposal was rejected (with reason)          | `command-coverage::reject-single-key-s-scope` |
| A structural rule about the palette was learned| `command-coverage::docs-palette-needs-mirror` |

Do NOT write:

- The full coverage matrix of one run (volatile — it changes every edit).
- Facts already in `references/palette-api.md` (that is the skill's own
  reference, not a memory).
- Anything the code or `CLAUDE.md` already records.

### Memory body shape

```text
scope: repo::mthines/lorekit
key:   command-coverage::binding-plan-is-g-p
value: |
  Decision — Settings → Plan is bound to `g p` in the command palette.
  Why: mnemonic, and `g p` was free in the registry as of this run.
  How to apply: when auditing settings nav, treat `g p` as taken for Plan;
  do not re-propose a different letter for Plan.
tags: [command-coverage, keyboard-shortcuts, decision]
```

Follow the repo's lesson style (see `/lorekit-memory`): a `Why:` and a
`How to apply:` line so the memory is actionable, not just a note.

## Common mistakes

- Skipping recall and re-litigating a settled binding. **Fix:** always run
  Phase 0 first.
- Writing the whole matrix as a memory. **Fix:** record decisions, not state.
- Using the wrong scope (`global` or a branch). **Fix:** `repo::mthines/lorekit`
  so the whole team's audits share one approach.
