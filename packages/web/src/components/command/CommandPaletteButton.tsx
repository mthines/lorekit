'use client';

/**
 * CommandPaletteButton
 *
 * A clickable trigger in the TopBar that opens the command palette.
 * Shows the ⌘K (or Ctrl+K) shortcut label so users discover it.
 * Rendered at a comfortable min-h-11 touch target.
 */

import { Command } from 'lucide-react';
import { useCommandPalette } from './CommandPaletteProvider';
import { isMac } from './shortcut';

export function CommandPaletteButton() {
  const { openPalette } = useCommandPalette();
  const shortcutLabel = isMac() ? '⌘K' : 'Ctrl+K';

  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label="Open command palette"
      title={`Open command palette (${shortcutLabel})`}
      className="flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 text-xs text-[var(--color-content-secondary)] transition-colors hover:border-[var(--color-content-tertiary)] hover:text-[var(--color-content-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
    >
      <Command className="size-3.5 shrink-0" aria-hidden />
      <span className="hidden sm:inline">Search</span>
      <kbd className="hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-0.5 font-mono text-[10px] sm:inline">
        {shortcutLabel}
      </kbd>
    </button>
  );
}
