---
title: Linear Shortcuts — the key convention map
impact: HIGH
tags:
  - linear
  - keyboard-shortcuts
  - conventions
  - collision-avoidance
---

# Linear Shortcuts

The convention map used to assign a keyboard shortcut to each gap (Phase 3).
LoreKit follows Linear's shortcut language: a `g` navigation prefix, ⌘K for
the palette, and single letters for context actions. Assign from this map;
do not invent ad-hoc keys.

## Contents

- [The two families](#the-two-families)
- [Canonical Linear action letters](#canonical-linear-action-letters)
- [Navigation letters (the g prefix)](#navigation-letters-the-g-prefix)
- [Assignment procedure (per gap)](#assignment-procedure-per-gap)
- [Recommended additions the audit should surface](#recommended-additions-the-audit-should-surface)

## The two families

| Family        | Shape              | Fires when                          | Examples             |
| ------------- | ------------------ | ----------------------------------- | -------------------- |
| Navigation    | `g` then a letter  | globally (outside text fields)      | `g o`, `g e`, `g s`  |
| Context action| a single letter    | on the relevant view/selection      | `f`, `l`, `c`, `/`   |
| Palette       | `mod+k`            | always                              | ⌘K / Ctrl+K          |
| Meta          | `?`                | globally                            | shortcuts help       |

`g` is **reserved for navigation** — never assign it to an action.

## Canonical Linear action letters

Map a gap's action to its Linear letter. Only bind the ones the app actually
has; leave the rest for future actions.

| Letter | Linear meaning        | LoreKit application                              |
| ------ | --------------------- | ----------------------------------------------- |
| `c`    | Create               | New lesson / create (if a create UI exists)     |
| `f`    | Filter               | Open the Explorer filter menu (`FilterMenu`)    |
| `l`    | Label                | Filter/set by label dimension                   |
| `/`    | Focus search         | Focus the Explorer search field                 |
| `o`    | Open                 | Open item (e.g. the existing "Open Lesson…")    |
| `e`    | Edit                 | Edit the focused/selected lesson                |
| `x`    | Select / archive-ish | (reserve; only if a selection model exists)     |
| `?`    | Keyboard help        | Open a shortcuts overlay                         |
| `[` `]`| Navigate prev/next   | Move between list items                          |

## Navigation letters (the `g` prefix)

Extend the existing set; keep letters mnemonic and collision-free.

| Keys  | Destination           | Status            |
| ----- | --------------------- | ----------------- |
| `g o` | Overview              | taken             |
| `g e` | Lore Explorer         | taken             |
| `g s` | Settings              | taken             |
| `g g` | Docs                  | taken             |
| `g p` | Settings → Plan       | free (suggested)  |
| `g k` | Settings → API keys   | free (suggested)  |
| `g i` | Settings → Integrations | free (suggested) |
| `g a` | Settings → Audit logs | free (suggested)  |

Confirm "free" against the LIVE registry every run — the baseline table in
[`../references/palette-api.md`](../references/palette-api.md) can lag.

## Assignment procedure (per gap)

1. Is the gap a **destination**? → propose `g <letter>`, letter mnemonic of
   the destination, not already bound.
2. Is the gap an **action**? → propose its canonical Linear letter from the
   table above.
3. Check the proposed token against the live registry (Phase 1 Step 3) AND
   the baseline table. On collision, pick the next mnemonic letter and note
   the substitution.
4. Every gap also needs a **palette entry** — the shortcut is the accelerator,
   the palette row is the discoverable surface. Propose both.
5. Prefer reusing an existing command over adding a duplicate.

## Recommended additions the audit should surface

- A `?` **keyboard-shortcuts overlay** — Linear has one; LoreKit does not.
  Surface it as a recommendation whenever it is absent.
- Context actions must respect the input/textarea/contenteditable guard (the
  provider already enforces this) — so `/` to focus search and `f` to filter
  will not fire mid-typing, which is correct.

## Examples

### Good

```text
Gap: Filter (Explorer), both surfaces missing.
→ palette: { id:'explorer-filter', label:'Filter lore…', group:'Lore' }
→ shortcut: ['f']   (Linear "filter", free in the registry)
```

### Bad — action on the reserved nav prefix

```text
Gap: Filter (Explorer)
→ shortcut: ['g','f']   ← WRONG: `g` is navigation-only. Use ['f'].
```

## Common mistakes

- Assigning `g`+letter to an action. **Fix:** single letter from the action map.
- Reusing a bound token. **Fix:** check the live registry, pick the next mnemonic.
- Recommending a shortcut but no palette row (or vice versa). **Fix:** both.
