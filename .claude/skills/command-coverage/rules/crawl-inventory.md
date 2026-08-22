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

## Step 0 — Map where the palette even EXISTS (do this first)

The palette can only cover a route whose layout mounts the provider. Find the
palette-bearing layouts before anything else:

```bash
grep -rln "CommandPaletteProvider" packages/web/src/app
```

Today that is `(dashboard)/layout.tsx`, `docs/layout.tsx`, and `blog/layout.tsx`. Any
navigable route NOT under one of these layouts has **no palette context** —
there is no ⌘K and no shortcut engine there at all. That is a distinct, and
usually more serious, finding than a missing command: the surface is
unreachable by the palette by construction. Record it as
`no-palette-context`, and note the fix is to mount the provider in that
layout (as `docs/layout.tsx` already does), not to add one command.

## Step 1 — Enumerate navigation targets

| Source            | Command                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| App routes (ALL)  | `find packages/web/src/app -name page.tsx \| sort`                    |
| Settings sections | read `SETTINGS_SECTIONS` in `components/settings/sections.ts`         |
| Docs sections     | read `DOCS_SECTIONS` in `lib/docs/sections.ts`                        |
| Blog posts        | read `BLOG_SECTIONS` in `lib/blog/sections.ts` (table-driven, like docs) |

Crawl **every** `app/**/page.tsx`, not just the authenticated `(dashboard)`
subtree — the public content surfaces (`/blog`, `/blog/[slug]`, `/learn`,
the landing `/`) are navigable too and are the easiest to forget. Then filter
to **user-navigable** routes: drop `(auth)/*` and pure layouts; a
`[slug]`/`[[...slug]]` segment is covered collectively by its table (docs and
blog both drive per-item commands from a slug table), so treat the table, not
the dynamic route file, as the unit. Keep every stable destination.

Cross-check each surface against Step 0: a public content route (blog, learn,
landing) whose layout is not in the palette-bearing set is a
`no-palette-context` finding, and a content type that IS table-driven but has
no derived commands (blog vs. docs) is an **inconsistency** — call it out
explicitly against its precedent.

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
| Warrants shortcut? | `yes` / `no — occasional` / `no — destructive` / `contextual` — the shortcut-test verdict, so a palette-only row reads as a decision |
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
