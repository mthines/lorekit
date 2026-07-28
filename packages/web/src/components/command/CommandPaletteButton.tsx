'use client';

/**
 * CommandPaletteButton
 *
 * A clickable trigger in the TopBar that opens the command palette.
 * Shows the ⌘K (or Ctrl+K) shortcut label so users discover it.
 * Rendered at a comfortable min-h-11 touch target.
 *
 * ## Hydration safety
 * `isMac()` reads `navigator.platform` which is undefined on the server.
 * We defer the platform-specific label to after mount (`useEffect`) so the
 * SSR pass and the first client render agree on the text, avoiding React
 * hydration error #418.
 */

import { useState, useEffect } from 'react';
import { useCommandPalette } from './CommandPaletteProvider';
import { isMac } from './shortcut';

export function CommandPaletteButton() {
  const { openPalette } = useCommandPalette();
  // Start with a neutral label that matches the server render (no navigator access).
  // After mount, swap in the platform-specific label.
  const [shortcutLabel, setShortcutLabel] = useState('⌘K');

  useEffect(() => {
    setShortcutLabel(isMac() ? '⌘K' : 'Ctrl+K');
  }, []);

  return (
    <button
      type="button"
      onClick={() => openPalette('button')}
      aria-label={`Open command palette (${shortcutLabel})`}
      title={`Open command palette (${shortcutLabel})`}
      // Shaped like the app's badges/tags (rounded-md, mono, hairline border):
      // a muted neutral tag at rest, warming to the LoreKit amber tag tint on
      // hover/focus — subtle by default, sexy on interaction.
      className="inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-content-tertiary)] transition-colors duration-200 hover:border-[#f5a62333] hover:bg-[#f5a6231a] hover:text-[var(--color-accent)] focus-visible:border-[#f5a62333] focus-visible:bg-[#f5a6231a] focus-visible:text-[var(--color-accent)] focus-visible:outline-none"
    >
      {shortcutLabel}
    </button>
  );
}
