---
title: Crawl & Inventory — build the coverage matrix
impact: HIGH
tags:
  - crawl
  - inventory
  - diff
  - coverage-matrix
---

# Crawl & Inventory

Builds the two inventories the audit diffs: **what the app offers** (nav
targets + user actions) and **what is registered** (the command/shortcut
registry). Then computes the coverage matrix. Run this for Phases 1–2. All
paths are under `packages/web/src`. Read
[`../references/palette-api.md`](../references/palette-api.md) first for the
registry shape.

## Contents

- [Step 1 — Enumerate navigation targets](#step-1--enumerate-navigation-targets)
- [Step 2 — Enumerate user actions](#step-2--enumerate-user-actions)
- [Step 3 — Enumerate the registry](#step-3--enumerate-the-registry)
- [Step 4 — Build the coverage matrix](#step-4--build-the-coverage-matrix)
- [Step 5 — Flag drift](#step-5--flag-drift-stronger-than-a-gap)

## Step 1 — Enumerate navigation targets

| Source            | Command                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| App routes        | `find packages/web/src/app -name page.tsx \| sort`                    |
| Settings sections | read `SETTINGS_SECTIONS` in `components/settings/sections.ts`         |
| Docs sections     | read `DOCS_SECTIONS` in `lib/docs/sections.ts`                        |

Filter to **user-navigable** routes: drop `(auth)/*`, dynamic-only segments
you cannot deep-link generically (`[slug]`, `[[...slug]]`) unless the audit
scope calls for them, and pure layouts. Keep every stable destination a user
would reasonably want a shortcut to.

## Step 2 — Enumerate user actions

Actions are interactive, page-level operations — not every button, but the
ones a power user repeats. Scan the primary feature components for triggers:

```bash
grep -rn "onClick=\|aria-label=\|role=\"button\"\|<button" \
  packages/web/src/components/lore \
  packages/web/src/components/dashboard \
  packages/web/src/components/settings
```

Classify each candidate against the Linear action vocabulary (see
[`linear-shortcuts.md`](./linear-shortcuts.md)). Typical LoreKit actions:

| Action                     | Where                         | Linear verb |
| -------------------------- | ----------------------------- | ----------- |
| Open the filter menu       | `lore/FilterMenu.tsx`         | filter (F)  |
| Focus the search field     | `lore/LoreExplorer.tsx`       | search (/)  |
| Select scope               | `lore/ScopeSelector.tsx`      | (context)   |
| Change the activity range  | `lore/ExplorerInsights.tsx`   | (context)   |
| Open a lesson              | already `lore-open-lesson`    | open (O)    |

Ignore transient/local controls (a card's expand toggle, pagination "load
more") — they are not palette-worthy. When unsure, a control is action-worthy
if a user would plausibly want to reach it from anywhere on the page.

## Step 3 — Enumerate the registry

The registered set is every `useCommand({...})` call (see the reference for
the grep). For each, capture: `id`, `label`, `group`, `shortcut.keys` (or
none), and the destination/`onSelect`. This is the ground truth for "what is
covered" — a target is covered ONLY if it appears here.

## Step 4 — Build the coverage matrix

Join Steps 1–2 (offered) against Step 3 (registered) into one row per target
or action:

| Column     | Value                                                     |
| ---------- | -------------------------------------------------------- |
| Target     | route path or action name                                 |
| Trigger    | route, or the component/handler for an action             |
| Palette    | the registering `id`, or `❌`                             |
| Shortcut   | the key sequence, or `❌`                                 |
| Gap        | `—` / `palette` / `shortcut` / `both`                    |

## Step 5 — Flag drift (stronger than a gap)

A route present in `DOCS_SECTIONS` / `SETTINGS_SECTIONS` but with **no**
table-derived command is **drift**, not a plain gap — the table-driven
registration is supposed to guarantee coverage. Call these out separately;
the fix is to route the registration through the table, not to hand-add one
command (see [`auto-wire.md`](./auto-wire.md)).

## Examples

### Good — action correctly identified as action-worthy

```text
Filter (Explorer) | FilterMenu open | ❌ | ❌ | both
→ power-user repeats it; belongs in palette ("Filter lore…") + shortcut `f`.
```

### Bad — treating a local toggle as a gap

```text
Expand lesson card | MemoryExpandButton | ❌ | ❌ | both   ← WRONG
→ transient per-card control; not palette-worthy. Exclude it.
```

## Common mistakes

- Counting a route as covered from the route table alone. **Fix:** require a
  matching `useCommand` registration in Step 3.
- Listing every button as an action. **Fix:** apply the "repeated, page-level,
  reach-from-anywhere" test.
- Missing docs vs. dashboard scope split. **Fix:** the same target can be
  covered in one layout and not the other; keep them as separate rows.
