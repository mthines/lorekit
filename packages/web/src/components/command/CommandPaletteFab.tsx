'use client';

/**
 * CommandPaletteFab
 *
 * The phone-breakpoint trigger for the command palette: a raised graphite disc
 * docked in the CENTRE of the mobile tab bar. It replaces the `⌘K` chip that
 * used to sit in the TopBar on mobile — a keyboard-shortcut label is dead copy
 * on a touch device, and the top-right corner is the hardest place on a phone
 * to reach one-handed while the centre of the bottom bar is the easiest.
 *
 * ## Why it looks different from every other control
 * The palette is the one "do anything" action in the app, so it is the one
 * control allowed to break the tab bar's flat rhythm: the four tabs are outline
 * icons lying flat on the raised surface, this is a filled disc that rises above
 * the bar's top edge. That asymmetry IS the affordance — "this is not a fifth
 * destination, it's an action".
 *
 * It carries that asymmetry through ELEVATION rather than hue: a neutral face
 * lit from above, a soft ambient halo, and a bright glyph. Amber was tried first
 * and read as an alert — it out-shouted the accent on the active tab and on
 * every chart bar, which is the one thing a persistent control must not do. The
 * grey disc still reads as the hero because nothing else on the bar is raised or
 * filled, and it leaves the accent to mean "your data" everywhere else.
 *
 * The halo breathes on a slow 4.5s loop so the button reads as live without
 * competing with page content. Both the breathe and the press feedback animate
 * `opacity`/`transform` only, so they stay on the compositor; the halo's RESTING
 * look lives in its base classes because the global `prefers-reduced-motion`
 * rule collapses the animation to ~0ms with no fill, dropping the element back
 * to those base styles.
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
      // `-translate-y-5` lifts the 48px disc so 20px of it clears the bar's
      // 56px-tall top border and 28px stays seated in it — the docked-FAB
      // silhouette. Any less and it reads as a button sitting *inside* the bar,
      // which loses the "this is an action, not a tab" signal the whole
      // treatment exists for; any more and it eats into the scroll padding
      // `(dashboard)/layout.tsx` reserves for it. `focus-visible:rounded-full`
      // undoes the global focus rule's `border-radius: 4px`, which would
      // otherwise square off a circular button the moment it takes keyboard
      // focus.
      className="group absolute left-1/2 top-0 -translate-x-1/2 -translate-y-5 transition-transform duration-150 ease-[var(--ease-spring)] active:scale-[0.92] focus-visible:rounded-full focus-visible:outline-offset-4"
    >
      {/*
        The halo. A blurred disc sitting BEHIND the button face (earlier in DOM
        order, so no z-index juggling) and slightly larger than it, which is what
        separates the FAB from the bar it overlaps without needing a punched-out
        notch in the bar's geometry. Neutral, so it reads as ambient light rather
        than as a status colour.
      */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-1.5 rounded-full bg-[var(--color-content-tertiary)] opacity-55 blur-lg animate-halo-breathe"
      />

      {/*
        The face. A three-stop gradient rather than a flat fill so the disc reads
        as lit from above, plus an inset hairline highlight along its top edge and
        a neutral drop shadow that tightens on press — the "lit object on a dark
        surface" treatment, at a 48px target (still clear of the 44pt HIG / 48dp
        Material floor).
      */}
      <span className="relative flex size-12 items-center justify-center rounded-full bg-[linear-gradient(150deg,#464c5b_0%,#333947_55%,#242832_100%)] text-[var(--color-content-primary)] shadow-[0_7px_18px_-6px_#000000b3,inset_0_1px_0_#ffffff26] transition-shadow duration-200 group-active:shadow-[0_3px_10px_-6px_#000000b3,inset_0_1px_0_#ffffff26]">
        <Command className="size-5" strokeWidth={2.25} aria-hidden />
      </span>
    </button>
  );
}
