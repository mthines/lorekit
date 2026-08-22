---
title: Auto-Wire — write the missing registrations safely
impact: HIGH
tags:
  - apply
  - auto-wire
  - confidence-gate
  - useCommand
---

# Auto-Wire

The `apply`-mode mechanics: turn a confirmed gap into a real `useCommand`
registration, behind a confidence gate. Only runs after the Phase 4 report.
Read [`../references/palette-api.md`](../references/palette-api.md) for the
API and hook-position rules before writing anything.

## Contents

- [Preconditions (all required)](#preconditions-all-required)
- [Where each kind of registration goes](#where-each-kind-of-registration-goes)
- [Rules for the written code](#rules-for-the-written-code)
- [Verify after writing](#verify-after-writing)

## Preconditions (all required)

1. The gap appears in the Phase 4 coverage matrix.
2. Its proposed binding passed [`linear-shortcuts.md`](./linear-shortcuts.md)
   (mnemonic, no collision).
3. `confidence ≥ 90%` — invoke `Skill('confidence')` in analysis mode on the
   proposed change. Below 90%, do NOT write; downgrade to a recommendation in
   the report and record why in LoreKit (Phase 6).
4. The user explicitly confirmed the diff.

## Where each kind of registration goes

| Gap kind                          | File to edit                                  | Pattern                          |
| --------------------------------- | --------------------------------------------- | -------------------------------- |
| Dashboard navigation              | `components/command/NavigationCommands.tsx`   | a `useCommand` in the component  |
| Dashboard action (feature-local)  | the feature component (e.g. `LoreExplorer`)   | a small child component + `useCommand` |
| Docs page navigation              | derived from `DOCS_SECTIONS` — table-driven   | usually **no new code**          |
| Blog post navigation              | derived from `BLOG_SECTIONS` — table-driven   | usually **no new code**          |
| Docs / blog "Navigate" (signed-in)| `components/docs/DocsSessionCommands.tsx`     | mirror the dashboard binding; mounted in both layouts |

## Rules for the written code

- **Table-driven first.** If the gap is a route already in `DOCS_SECTIONS`,
  `SETTINGS_SECTIONS`, or `BLOG_SECTIONS`, fix the drift by registering FROM
  the table (the `DocsCommandItem` map pattern), not by hand-adding one command.
- **Hook position.** Never call `useCommand` inside a `.map()` — wrap each
  list item in its own component. Straight (non-list) registrations go inline.
- **id + prefix.** Follow the id-prefix scheme (`nav-*`, `settings-*`,
  `explorer-*`, …). Keep ids stable and unique.
- **Group.** Reuse an existing group label (`Navigate`, `Settings`, `Docs`,
  `Lore`) unless a genuinely new area needs one.
- **Icon.** A lucide-react icon with `className="size-4"`, consistent with
  siblings.
- **Action wiring.** For an action gap, the `onSelect` must call the SAME
  handler the on-screen control uses — lift it to shared state/context if it
  is currently local, rather than duplicating logic. If lifting the handler is
  non-trivial, that is a signal confidence is `< 90%`: report, do not wire.
- **Docs mirror.** A dashboard "Navigate" binding that also belongs on the
  public `/docs` palette must be mirrored in `DocsSessionCommands.tsx` with a
  `docs-nav-*` id so the two never collide.

## Example — a navigation gap (settings → Plan)

```tsx
// in NavigationCommands.tsx, alongside the other settings-* commands
useCommand({
  id: 'settings-plan',
  label: 'Plan',
  description: 'Your plan, memory usage, and capacity',
  icon: <CreditCard className="size-4" />,
  group: 'Settings',
  shortcut: { keys: ['g', 'p'] }, // only if 'g p' is free in the registry
  onSelect: () => router.push('/settings/plan'),
});
```

## Example — an action gap (Explorer filter)

```tsx
// a small child mounted inside LoreExplorer, next to the filter UI
function ExplorerFilterCommand({ openFilters }: { openFilters: () => void }) {
  useCommand({
    id: 'explorer-filter',
    label: 'Filter lore…',
    icon: <Filter className="size-4" />,
    group: 'Lore',
    shortcut: { keys: ['f'] },
    onSelect: openFilters, // the SAME handler the on-screen button calls
  });
  return null;
}
```

## Verify after writing

1. `pnpm nx typecheck web` — must be green.
2. If any registration touches a story-covered surface, run the web Storybook
   tests per `CLAUDE.md` (`npx vitest run --config vitest.storybook.config.ts
   --changed=main`). Do not run whole-repo Nx fan-outs in a sandbox.
3. User-facing docs: a NEW shortcut or palette capability is a user-visible
   change — update the relevant surface per `CLAUDE.md`'s user-facing-docs
   rule (or state in one line why none applied).

## Common mistakes

- Hand-adding a command for a route that a section table already owns. **Fix:**
  register from the table.
- Duplicating an action handler instead of sharing it. **Fix:** lift the
  handler; if too costly, report instead of wiring.
- Writing at `confidence < 90%`. **Fix:** downgrade to a recommendation.
- Forgetting the `/docs` mirror for a shared nav binding. **Fix:** add the
  `docs-nav-*` twin.
