'use client';

/**
 * Keyboard shortcut engine
 *
 * Handles:
 * 1. Single-key shortcuts: `['g']`
 * 2. Chained shortcuts (VSCode-style): `['g', 'h']` — press g, then h within
 *    CHORD_TIMEOUT_MS.
 * 3. Modifier keys via the `+` syntax: `'mod+k'`, `'shift+n'`, `'alt+p'`.
 *    `mod` resolves to Cmd on macOS and Ctrl elsewhere.
 *
 * This module is pure (no React); it is consumed by the chord machine in
 * `CommandPaletteProvider`.
 */

/** Time window (ms) within which the next key in a chain must arrive. */
export const CHORD_TIMEOUT_MS = 1000;

/** Detect macOS so we can map `mod` → Cmd vs Ctrl. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export interface ParsedKey {
  key: string; // Normalised lower-case key name
  mod: boolean; // Cmd (macOS) or Ctrl (others)
  shift: boolean;
  alt: boolean;
}

/**
 * Parse a key token like `'mod+k'`, `'shift+n'`, `'g'` into its parts.
 */
export function parseKey(token: string): ParsedKey {
  const parts = token.toLowerCase().split('+');
  const key = parts[parts.length - 1]!;
  return {
    key,
    mod: parts.includes('mod') || parts.includes('ctrl') || parts.includes('meta'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt') || parts.includes('option'),
  };
}

/**
 * Check whether a native KeyboardEvent matches a parsed key descriptor.
 */
export function matchesKey(e: KeyboardEvent, parsed: ParsedKey): boolean {
  const mac = isMac();
  const modPressed = mac ? e.metaKey : e.ctrlKey;
  if (parsed.mod && !modPressed) return false;
  if (!parsed.mod && modPressed) return false;
  if (parsed.shift !== e.shiftKey) return false;
  if (parsed.alt !== e.altKey) return false;
  return e.key.toLowerCase() === parsed.key;
}

/**
 * Given a KeySequence, format it as a human-readable shortcut label.
 * e.g. `['g', 'h']` → `'g h'`
 *     `['mod+k']` → `'⌘K'` on macOS or `'Ctrl+K'` elsewhere
 */
export function formatShortcut(keys: string[]): string {
  return keys
    .map((token) => {
      const parsed = parseKey(token);
      const parts: string[] = [];
      if (parsed.mod) {
        parts.push(isMac() ? '⌘' : 'Ctrl+');
      }
      if (parsed.shift) parts.push(isMac() ? '⇧' : 'Shift+');
      if (parsed.alt) parts.push(isMac() ? '⌥' : 'Alt+');
      parts.push(parsed.key.toUpperCase());
      return parts.join('');
    })
    .join(' ');
}
