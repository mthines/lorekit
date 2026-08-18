---
title: Palette API — the packages/web command-palette contract
impact: HIGH
tags:
  - palette-api
  - useCommand
  - shortcut
  - registry
---

# Palette API

The exact command-palette contract in `packages/web`. Read this before
crawling (Phase 1) or wiring (Phase 5) so recommendations match the real API
and never drift. All paths are under `packages/web/src`.

## Contents

- [Where the code lives](#where-the-code-lives)
- [The `Command` type](#the-command-type)
- [Registering a command](#registering-a-command)
- [Shortcut syntax](#shortcut-syntax)
- [Existing bindings (the baseline)](#existing-bindings-the-baseline)
- [Navigation source-of-truth tables](#navigation-source-of-truth-tables)
- [id-prefix conventions](#id-prefix-conventions)

## Where the code lives

| File                                            | Role                                                           |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `components/command/types.ts`                   | `Command`, `CommandShortcut`, `KeySequence`, `PaletteFrame`   |
| `components/command/shortcut.ts`                | Pure chord/modifier engine (`parseKey`, `formatShortcut`, `CHORD_TIMEOUT_MS`) |
| `components/command/CommandPaletteProvider.tsx` | Registry + open/close + the global keydown chord machine       |
| `components/command/useCommand.tsx`             | The hook every registration uses                               |
| `components/command/NavigationCommands.tsx`     | Dashboard registrations (mounted in the dashboard layout)      |
| `components/docs/DocsCommands.tsx`              | Public `/docs` page registrations                              |
| `components/docs/DocsSessionCommands.tsx`       | `/docs` + `/blog` "Navigate" group, shown only when signed in  |
| `components/blog/BlogCommands.tsx`             | Public `/blog` post registrations (driven by `BLOG_SECTIONS`)   |
| `components/command/CommandPaletteButton.tsx`   | The ⌘K trigger in the TopBar                                   |

The registration call sites — the crawl's "what is registered" set — are
**every `useCommand({...})` call**. Today that is `NavigationCommands.tsx`,
`DocsCommands.tsx`, `DocsSessionCommands.tsx`, and `BlogCommands.tsx`. Find them with:

```bash
grep -rn "useCommand(" packages/web/src --include='*.tsx' \
  | grep -v "components/command/useCommand"
```

## The `Command` type

```ts
interface Command {
  id: string;                    // stable, unique — React key + de-dup
  label: string;                 // shown in the palette row
  description?: string;          // smaller supporting text
  icon?: ReactNode;              // a lucide-react icon, `className="size-4"`
  group?: string;                // separator label; clusters rows
  shortcut?: { keys: KeySequence; label?: string };
  onSelect?: () => void | Promise<void>;   // leaf action
  children?: Command[] | (() => Command[] | Promise<Command[]>); // nested level
}
```

`children` and `onSelect` are mutually exclusive — if both are set,
`children` wins and the palette drills in (Linear-style "Open Lesson…").

## Registering a command

`useCommand(command)` registers on mount, deregisters on unmount, and updates
in place when non-`id` fields change.

**Hook-position rule (load-bearing):** `useCommand` must be called at a stable
hook position — **never inside a `.map()`**. To register one command per item
in a list, wrap each item in its own tiny component that calls `useCommand`
once, then render the list of components. This is the `DocsCommandItem`
pattern:

```tsx
function DocsCommandItem({ section }: { section: DocsSection }) {
  const router = useRouter();
  const Icon = section.icon;
  useCommand({
    id: `docs-${section.id}`,
    label: section.label,
    description: section.summary,
    icon: <Icon className="size-4" />,
    group: 'Docs',
    onSelect: () => router.push(`/docs/${section.id}`),
  });
  return null;
}

function DocsCommands() {
  return <>{DOCS_SECTIONS.map((s) => <DocsCommandItem key={s.id} section={s} />)}</>;
}
```

## Shortcut syntax

`shortcut.keys` is a **chord sequence** — an array of key tokens pressed in
order within `CHORD_TIMEOUT_MS` (1000 ms).

- `['g', 'o']` → press `g` then `o` (Gmail/Linear navigation style).
- `['f']` → a single-key action.
- Modifiers use `+`: `'mod+k'`, `'shift+n'`, `'alt+p'`. `mod` resolves to
  ⌘ on macOS and Ctrl elsewhere. Modifiers combine and chain freely
  (`['mod+shift+m', 'mod+shift+o']`).

Execution context (from `CommandPaletteProvider`):

- `mod+k` toggles the palette and always fires.
- Other shortcuts fire globally **unless** the focused element is an
  `<input>`, `<textarea>`, or `[contenteditable]` — so a single-letter
  action like `f` will NOT fire while the user is typing in a field.
- `label` on the shortcut is optional; the row derives one from `keys`.

## Existing bindings (the baseline)

Never propose a token that collides with these.

| Keys        | Command                | id (dashboard / docs)          |
| ----------- | ---------------------- | ------------------------------ |
| `mod+k`     | Open palette           | (built into the provider)      |
| `g` `o`     | Go to Overview         | `nav-overview` / `docs-nav-overview` |
| `g` `e`     | Go to Lore Explorer    | `nav-explorer` / `docs-nav-explorer` |
| `g` `s`     | Go to Settings         | `nav-settings` / `docs-nav-settings` |
| `g` `g`     | Go to Docs             | `nav-docs`                     |

The `g` prefix is **reserved for navigation**. Do not use it for actions.

## Navigation source-of-truth tables

Register navigation from these tables, not a hand-copied list:

| Table              | File                                  | Drives                                   |
| ------------------ | ------------------------------------- | ---------------------------------------- |
| `DOCS_SECTIONS`    | `lib/docs/sections.ts`                | One "Docs" command per docs page         |
| `SETTINGS_SECTIONS`| `components/settings/sections.ts`     | The settings section jumps               |
| App routes         | `app/**/page.tsx`                     | Every top-level destination              |

When a new page is added to one of these tables, the palette command for it
should appear automatically from the same table — a route that exists in the
table but has no derived command is a **drift bug**, not just a gap.

## id-prefix conventions

| Prefix       | Meaning                                   |
| ------------ | ----------------------------------------- |
| `nav-*`      | Dashboard top-level navigation            |
| `settings-*` | Dashboard settings jumps                  |
| `docs-*`     | Dashboard docs jumps                      |
| `lore-*`     | Lore-specific commands                    |
| `docs-nav-*` | Standalone `/docs` copies (avoid `nav-*` collision) |

New action commands should extend this scheme by feature area
(e.g. `explorer-filter`, `explorer-search`).
