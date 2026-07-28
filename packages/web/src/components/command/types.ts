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

export interface Command {
  /** Stable identifier — used as React key and for de-duplication. */
  id: string;
  /** Display label shown in the palette. */
  label: string;
  /** Optional supporting text shown in a smaller font beside the label. */
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
   */
  children?: CommandChildren;
}

/** One frame in the navigation stack — the palette supports nesting. */
export interface PaletteFrame {
  /** The parent command that opened this level (null at root). */
  parentCommand: Command | null;
  /** The commands available at this level. */
  commands: Command[];
  /** Whether this frame is loading async children. */
  loading: boolean;
}
