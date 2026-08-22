/**
 * Command Palette — shared types
 *
 * A `Command` is the atomic unit of the palette. Commands are registered by
 * any component via `useCommand` / `CommandPaletteProvider.register`. They may
 * carry:
 * - An optional `shortcut` — a chained key sequence (VSCode-style: `['g','h']`
 *   for "g then h"). Single keys are expressed as a one-element array.
 * - An optional `children` thunk — when present the command opens a nested
 *   level in the palette (Linear-style "Open Project…"). The thunk is called
 *   lazily so it can be async (return a Promise that resolves to the list).
 * - An optional `search` thunk — like `children`, but for a nested level whose
 *   contents are too large or too fresh to prefetch once. The palette
 *   re-invokes it (debounced) on every keystroke instead of client-filtering a
 *   fixed list, and passes the raw query text through unfiltered.
 * - An optional `icon` — any React node (use lucide-react icons for consistency).
 * - An optional `group` for the separator label above a run of commands.
 *
 * Groups are rendered in insertion order; commands within a group are rendered
 * in insertion order. A separator with the group label is injected before the
 * first item of each group.
 */

import type { ReactNode } from 'react';

/** A single keyboard key label (e.g. "g", "p", "n"). */
export type Key = string;

/**
 * Chained key sequence.
 * - `['g', 'h']` means press g, then h within the chord timeout.
 * - Single-key shortcuts are `['g']`.
 *
 * Keys may include modifier prefixes using `+` as separator:
 *  - `'mod+k'`  → Cmd+K on macOS, Ctrl+K elsewhere
 *  - `'shift+n'` → Shift+N
 *  - `'alt+p'`   → Alt/Option+P
 *
 * Modifiers combine and chain freely, so a sequence of modified chords works:
 *  - `['mod+shift+m', 'mod+shift+o']` → Cmd+Shift+M then Cmd+Shift+O.
 */
export type KeySequence = Key[];

export interface CommandShortcut {
  /** The key sequence that activates this command. */
  keys: KeySequence;
  /**
   * Human-readable label rendered in the palette row.
   * Derived automatically when omitted from `keys`.
   */
  label?: string;
}

export type CommandChildren =
  | Command[]
  | (() => Command[] | Promise<Command[]>);

/**
 * A live, re-queryable nested level. Called with the palette's raw search
 * text (`''` on first open, before the user has typed anything) and expected
 * to return the full result set to render — the palette does NOT additionally
 * filter these by `matchesSearch`, since the thunk already decided what
 * matches. Debounced by the palette, not the implementation.
 */
export type CommandSearch = (query: string) => Command[] | Promise<Command[]>;

export interface Command {
  /** Stable identifier — used as React key and for de-duplication. */
  id: string;
  /** Display label shown in the palette. */
  label: string;
  /**
   * Optional supporting text. NOT rendered — rows are single-line and
   * label-only (see `CommandRow`). It stays in the SEARCH index
   * (`matchesSearch`), so typing a word from it still surfaces the command.
   */
  description?: string;
  /** Lucide icon or any ReactNode rendered to the left of the label. */
  icon?: ReactNode;
  /** Group label. Commands with the same group are clustered under a separator. */
  group?: string;
  /** Keyboard shortcut that activates the command from anywhere in the app. */
  shortcut?: CommandShortcut;
  /**
   * Called when the command is selected from the palette or via shortcut.
   * Mutually exclusive with `children` — if both are set, `children` wins and
   * the palette drills into the nested level.
   */
  onSelect?: () => void | Promise<void>;
  /**
   * Nested sub-commands shown when this command is activated (Enter / click).
   * Can be a static array or an async thunk that loads on demand.
   *
   * Mutually exclusive with `search` — when both are set, `search` wins,
   * since it is the more capable of the two (a fixed `children` list is a
   * `search` that ignores its query).
   */
  children?: CommandChildren;
  /**
   * Live nested level: re-invoked with the current query on every keystroke
   * (debounced) rather than prefetched once and client-filtered. Use this
   * instead of `children` when the full result set is too large to prefetch
   * (e.g. searching every memory by key rather than listing the 20 most
   * recent) or changes too fast for a point-in-time snapshot to stay correct.
   */
  search?: CommandSearch;
  /**
   * Only meaningful alongside `search`, and only at the ROOT level. When the
   * root's normal label/description/group filter comes up empty for a
   * non-empty query, the palette falls back to THIS command's `search`
   * in-place — no drilling in, no extra keystroke, no breadcrumb — so pasting
   * a value that matches nothing by label (a full memory key, say) still
   * finds something without first navigating into the command manually.
   * At most one root command should set this; if several do, the first one
   * registered wins.
   */
  fallbackSearch?: boolean;
}

/** One frame in the navigation stack — the palette supports nesting. */
export interface PaletteFrame {
  /** The parent command that opened this level (null at root). */
  parentCommand: Command | null;
  /** The commands available at this level. */
  commands: Command[];
  /** Whether this frame is loading async children. */
  loading: boolean;
  /**
   * Present when this frame was opened by a `search` command. Its identity
   * (not just presence) is what {@link CommandPalette} keys its debounced
   * re-query effect on, so drilling into a different `search` command re-runs
   * the query rather than reusing a stale closure.
   */
  search?: CommandSearch;
}
