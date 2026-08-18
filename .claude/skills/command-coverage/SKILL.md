---
name: command-coverage
description: >
  Audits the @lorekit/web dashboard so every navigation target and user
  action is reachable from BOTH the command palette (⌘K) and a Linear-style
  keyboard shortcut, then (in apply mode) wires the missing ones behind a
  confidence gate. Crawls the app routes, settings/docs section tables, and
  page-level actions, diffs them against the useCommand registry, assigns
  Linear key conventions (F=filter, L=label, C=create, g→ for navigation),
  and records approach insights to LoreKit. Use before shipping a new page or
  action, or when checking shortcut/palette parity. Triggers on "check
  shortcut coverage", "audit the command palette", "are these actions in the
  palette", "wire up keyboard shortcuts", "command palette parity",
  "/command-coverage".
argument-hint: '[audit|apply] [--scope dashboard|docs|all]'
license: MIT
metadata:
  author: mthines
  version: '1.0.0'
  workflow_type: applied
  tags:
    - command-palette
    - keyboard-shortcuts
    - linear-conventions
    - cmdk
    - web-audit
    - accessibility
    - coverage
    - lorekit
    - nextjs
---

# Command Coverage

Ensures every place a user can **navigate** to and every **action** they can
take in `packages/web` is exposed consistently in two surfaces:

1. The **command palette** (⌘K / Ctrl+K), and
2. A **keyboard shortcut** that follows Linear's conventions.

The skill crawls the web app, builds two inventories (what exists vs. what is
registered), diffs them into a coverage matrix, recommends a Linear-style
binding for each gap, and — in `apply` mode — writes the missing
`useCommand({...})` registrations behind a confidence gate. It reads and
writes LoreKit memory so the *approach* (conventions, decisions, prior gaps)
compounds across runs.

> **This `SKILL.md` is a thin index.** The crawl procedure, the Linear key
> map, the auto-wire mechanics, the LoreKit protocol, and the concrete
> palette API contract live in `rules/*.md` and `references/*.md` — load only
> what the current phase needs.

---

## Mode Detection

Parse `$ARGUMENTS`. First token selects the mode; `--scope` narrows the crawl.

| Mode    | Default | Trigger                                                            |
| ------- | ------- | ----------------------------------------------------------------- |
| `audit` | **yes** | Default. "check coverage", "audit palette", or no mode argument.  |
| `apply` |         | "wire up", "fix the gaps", "apply", or `$ARGUMENTS` starts `apply`. |

`--scope` (default `all`): `dashboard` (routes + actions behind auth),
`docs` (the public `/docs` palette), or `all`.

State the detected mode and scope in one line before continuing:

```text
Mode: audit
Scope: all
```

`apply` runs the full `audit` pipeline first — it never wires blind.

---

## Workflow

| Phase | Name        | Rule / reference                                                     | Gate                                                        |
| ----- | ----------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| 0     | Recall      | [`rules/lorekit-memory.md`](./rules/lorekit-memory.md)             | Prior conventions + decisions loaded from LoreKit           |
| 1     | Inventory   | [`rules/crawl-inventory.md`](./rules/crawl-inventory.md)          | Nav targets, actions, and the command registry all enumerated |
| 2     | Diff        | [`rules/crawl-inventory.md`](./rules/crawl-inventory.md)          | Coverage matrix built (target × {palette, shortcut})        |
| 3     | Recommend   | [`rules/linear-shortcuts.md`](./rules/linear-shortcuts.md)        | Every gap has a proposed binding; no token collisions       |
| 4     | Report      | this file (Report format)                                          | Matrix + recommendations presented to the user              |
| 5     | Wire (apply)| [`rules/auto-wire.md`](./rules/auto-wire.md)                      | Registrations written only at `confidence ≥ 90%` + user OK  |
| 6     | Record      | [`rules/lorekit-memory.md`](./rules/lorekit-memory.md)            | New insights/decisions written back to LoreKit              |

`audit` stops after Phase 4 and still runs Phase 6. `apply` runs all phases.

---

## Required Reading by Phase

Load on demand — do not preload.

| Phase   | Files                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------- |
| 0, 6    | [`rules/lorekit-memory.md`](./rules/lorekit-memory.md)                                             |
| 1, 2    | [`rules/crawl-inventory.md`](./rules/crawl-inventory.md), [`references/palette-api.md`](./references/palette-api.md) |
| 3       | [`rules/linear-shortcuts.md`](./rules/linear-shortcuts.md)                                         |
| 5       | [`rules/auto-wire.md`](./rules/auto-wire.md), [`references/palette-api.md`](./references/palette-api.md) |

The concrete `packages/web` palette contract (the `Command` type, the
`useCommand` hook-position rules, existing bindings, id-prefix conventions)
lives in [`references/palette-api.md`](./references/palette-api.md). Read it
before crawling or wiring so the skill never re-derives — or drifts from —
the real API.

---

## Report format (Phase 4)

Emit one coverage matrix, then the recommendations. Group by surface scope.

```text
## Coverage — dashboard

| Target / action        | Route / trigger          | Palette | Shortcut | Gap        |
| ---------------------- | ------------------------ | ------- | -------- | ---------- |
| Overview               | /overview                | ✅ nav-overview | ✅ g o | —          |
| Lore Explorer          | /lore                    | ✅ nav-explorer | ✅ g e | —          |
| Filter (Explorer)      | FilterMenu open          | ❌      | ❌       | both       |
| Focus search (Explorer)| search input             | ❌      | ❌       | both       |

Recommendations (Linear conventions):
- Filter (Explorer)  → palette "Filter lore…" (group: Lore) + shortcut `f`
- Focus search       → shortcut `/` (focus the search field)
- Keyboard help      → shortcut `?` (open a shortcuts overlay — not present)
```

Rules for the matrix:

- One row per navigation target AND per page-level action.
- `Palette` cites the registering command `id` when present, `❌` when absent.
- `Shortcut` cites the key sequence when present, `❌` when absent.
- `Gap` is one of `—` (covered), `palette`, `shortcut`, or `both`.
- Never invent coverage: a target counts as covered only if a real
  `useCommand` registration is found in the crawl (Phase 1).

---

## Core Principles

1. **Two surfaces, one source.** A user action is only "done" when it is in
   the palette AND on a shortcut. The palette is discoverability; the
   shortcut is speed. Ship both or neither is complete.
2. **Follow Linear, do not invent.** `g` prefix is reserved for navigation;
   single letters (F, L, C, …) are context actions; ⌘K opens the palette.
   Reuse the repo's existing bindings before adding new ones.
3. **Table-driven truth.** Navigation is already driven by `DOCS_SECTIONS`
   and `SETTINGS_SECTIONS`; register from those tables, never a hand-copied
   list that can drift.
4. **Never wire blind.** `apply` only writes after the `audit` matrix and a
   `confidence ≥ 90%` gate; show the diff and get explicit user confirmation.
5. **Compound the approach.** Read LoreKit at the start, write decisions and
   newly-found conventions at the end, so the next run is smarter.

---

## Anti-patterns

- Registering commands inside a `.map()` — breaks React hook order. Wrap each
  item in its own component (see the `DocsCommandItem` pattern).
- Reusing a key token already bound (checked against the live registry).
- Binding a single-letter action that fires globally without respecting the
  input/textarea/contenteditable guard.
- Claiming a target is covered from the route table alone without finding its
  `useCommand` registration.
- Adding a nav command with a `g`-prefix that collides with `g o/e/s/g`.

---

## Definition of Done

- [ ] Mode + scope stated in one line.
- [ ] LoreKit recalled (Phase 0) and recorded (Phase 6).
- [ ] Coverage matrix covers every route, section-table entry, and page action.
- [ ] Every gap has a proposed Linear-style binding with no token collision.
- [ ] `apply` only: each new registration passed the confidence gate, the
      user confirmed, and `pnpm nx typecheck web` is green.
- [ ] One-line summary of the coverage delta delivered to the user.
