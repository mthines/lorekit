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
 * Canonical string for a parsed key: modifiers in a FIXED order followed by the
 * base key, e.g. `{ mod, shift, key: 'm' }` → `'mod+shift+m'`. Both authored
 * shortcut tokens and live keyboard events funnel through this so they compare
 * as plain strings regardless of how the token was written (`shift+mod+m` and
 * `mod+shift+m` both normalise to `'mod+shift+m'`).
 */
export function canonicalKey(p: ParsedKey): string {
  const parts: string[] = [];
  if (p.mod) parts.push('mod');
  if (p.shift) parts.push('shift');
  if (p.alt) parts.push('alt');
  parts.push(p.key);
  return parts.join('+');
}

/** Canonicalise an authored shortcut token (`'mod+shift+M'` → `'mod+shift+m'`). */
export function normalizeToken(token: string): string {
  return canonicalKey(parseKey(token));
}

/**
 * Canonical token for a live keyboard event, or `null` for a pure-modifier
 * press (Meta/Control/Alt/Shift on their own) which never forms a chord step.
 * `mod` resolves to Cmd on macOS and Ctrl elsewhere — matching how `mod` is
 * authored — so a `mod+shift+m` shortcut fires on Cmd+Shift+M (mac) or
 * Ctrl+Shift+M (other platforms).
 */
export function eventToToken(e: KeyboardEvent): string | null {
  if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') {
    return null;
  }
  return canonicalKey({
    key: e.key.toLowerCase(),
    mod: isMac() ? e.metaKey : e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
  });
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
