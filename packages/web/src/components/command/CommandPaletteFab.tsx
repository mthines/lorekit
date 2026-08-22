'use client';

/**
 * CommandPaletteFab
 *
 * The phone-breakpoint trigger for the command palette: a raised, amber disc
 * docked in the CENTRE of the mobile tab bar. It replaces the `⌘K` chip that
 * used to sit in the TopBar on mobile — a keyboard-shortcut label is dead copy
 * on a touch device, and the top-right corner is the hardest place on a phone
 * to reach one-handed while the centre of the bottom bar is the easiest.
 *
 * ## Why it looks different from every other control
 * The palette is the one "do anything" action in the app, so it is the one
 * control allowed to break the tab bar's flat, monochrome rhythm: the four
 * tabs are outline icons on the raised surface, this is a filled amber disc
 * that rises above the bar's top edge. That asymmetry IS the affordance —
 * "this is not a fifth destination, it's an action".
 *
 * The amber gradient + halo is the brand's signature glow (see the palette
 * comment in `globals.css`), and the halo breathes on a slow 4.5s loop so the
 * button reads as live without ever competing with page content. Both the
 * breathe and the press feedback animate `opacity`/`transform` only, so they
 * stay on the compositor; the halo's RESTING look lives in its base classes
 * because the global `prefers-reduced-motion` rule collapses the animation to
 * ~0ms with no fill, dropping the element back to those base styles.
 */

import { Command } from 'lucide-react';
import { useCommandPalette } from './CommandPaletteProvider';

export function CommandPaletteFab() {
  const { open, openPalette } = useCommandPalette();

  return (
    <button
      type="button"
      onClick={() => openPalette('fab')}
      aria-label="Open command palette"
      aria-haspopup="dialog"
      aria-expanded={open}
      // `-translate-y-6` lifts the 56px disc so 24px of it clears the bar's
      // 56px-tall top border and 32px stays seated in it — the docked-FAB
      // silhouette. Any less and it reads as a button sitting *inside* the bar,
      // which loses the "this is an action, not a tab" signal the whole
      // treatment exists for. `focus-visible:rounded-full` undoes the global
      // focus rule's `border-radius: 4px`, which would otherwise square off a
      // circular button the moment it takes keyboard focus.
      className="group absolute left-1/2 top-0 -translate-x-1/2 -translate-y-6 transition-transform duration-150 ease-[var(--ease-spring)] active:scale-[0.92] focus-visible:rounded-full focus-visible:outline-offset-4"
    >
      {/*
        The glow. A blurred amber disc sitting BEHIND the button face (earlier in
        DOM order, so no z-index juggling) and slightly larger than it, which is
        what separates the FAB from the bar it overlaps without needing a
        punched-out notch in the bar's geometry.
      */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-1.5 rounded-full bg-[var(--color-accent)] opacity-45 blur-lg animate-halo-breathe"
      />

      {/*
        The face. A three-stop gradient rather than a flat fill so the disc reads
        as lit from above, plus an inset hairline highlight along the top edge
        and an amber-tinted drop shadow — the same "lit object on a dark surface"
        treatment the login CTA uses, scaled up to a 56px target.
      */}
      <span className="relative flex size-14 items-center justify-center rounded-full bg-[linear-gradient(150deg,#ffc862_0%,#f5a623_52%,#d68b10_100%)] text-[var(--color-bg)] shadow-[0_8px_22px_-6px_#f5a623a6,inset_0_1px_0_#fff3d1b3] transition-shadow duration-200 group-active:shadow-[0_4px_12px_-6px_#f5a623a6,inset_0_1px_0_#fff3d1b3]">
        <Command className="size-6" strokeWidth={2.25} aria-hidden />
      </span>
    </button>
  );
}
