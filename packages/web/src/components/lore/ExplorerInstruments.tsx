'use client';

/**
 * ExplorerInstruments — the collapsible panel that hosts the Explorer's filter
 * instruments.
 *
 * ## It collapses, and it opens collapsed
 *
 * The Explorer already carries a scope strip, an Activity panel and a filter bar
 * before the first memory. A second always-open panel would push the list off a
 * laptop screen entirely — which is the failure the Activity panel's own
 * disclosure exists to prevent, and adding a new panel that reintroduces it
 * would be a poor trade.
 *
 * So this opens COLLAPSED (`DEFAULT_INSTRUMENTS_OPEN`) and the choice persists
 * per person, through the same `usePersistedPreference` + `localStorage` path
 * `ExplorerInsights` uses. Two consequences, both deliberate:
 *
 *  - **The no-flash rule holds here too.** Until a client store has been
 *    consulted the panel renders its NEUTRAL state — collapsed — never its
 *    stored one. Rendering expanded and then snapping shut is the artefact
 *    persistence must not introduce, and starting from the neutral state makes
 *    it unreachable rather than merely unlikely. Here the neutral state and the
 *    default happen to coincide, which is why the panel is quiet on first paint.
 *  - **It is not in the URL.** A shared link carries which lore you are looking
 *    at — that is the filter bar's job, and every instrument writes to it — not
 *    which instrument you had open. Same call, and same reasoning, as the
 *    Activity panel's disclosure.
 *
 * ## The collapsed state is not empty
 *
 * Collapsed, the header still says which instrument is selected and whether the
 * bar is narrowed. A disclosure that hides the answer is just hiding, and people
 * stop collapsing things that cost them the answer.
 *
 * ## Below `md`, the body is a BottomSheet
 *
 * A matrix and a brushable timeline are transient selection surfaces, and the
 * repo's rule sends those to `BottomSheet` at the phone breakpoint rather than
 * squeezing a desktop panel (`docs/decisions.md` → "Mobile transient selection
 * surfaces use the BottomSheet primitive"). The sheet gets the full width and a
 * scrim, which is what makes a 9-column grid and a 60-day track actually usable
 * with a thumb.
 *
 * **One body, two containers.** The instrument components are rendered exactly
 * once, into a `body` element that either goes inline (desktop) or into the
 * sheet (mobile) — `FilterMenu` is the reference for this. Rendering them twice
 * would double the pivot query and let the two copies drift.
 *
 * `useIsMobile()` is JS rather than a `md:` class for the reason `useMediaQuery`
 * documents: this picks which single DOM tree to mount, which CSS cannot do.
 */

import { ChevronDown, Grid3x3, LayoutGrid, Sliders } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotionConfig } from 'motion/react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { SegmentedControl, type SegmentedControlItem } from '@/components/ui/SegmentedControl';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { usePersistedPreference } from '@/lib/hooks/usePersistedPreference';
import {
  DEFAULT_INSTRUMENT,
  DEFAULT_INSTRUMENTS_OPEN,
  INSTRUMENTS,
  INSTRUMENT_ARIA_LABELS,
  INSTRUMENT_LABELS,
  type Instrument,
} from '@/lib/explorer-instruments';
import {
  PREFERENCE_KEYS,
  isResolved,
  parseBooleanPreference,
  parseEnumPreference,
  serializeBooleanPreference,
} from '@/lib/persisted-preference';
import type { ReactNode } from 'react';

const PANEL_ID = 'explorer-instruments-body';

const INSTRUMENT_ICONS: Record<Instrument, typeof Grid3x3> = {
  matrix: Grid3x3,
  timeline: LayoutGrid,
};

const ITEMS: SegmentedControlItem<Instrument>[] = INSTRUMENTS.map((value) => ({
  value,
  label: INSTRUMENT_LABELS[value],
  icon: INSTRUMENT_ICONS[value],
  // The visible label is hidden at narrow panel widths, so this is the
  // segment's only accessible name there.
  ariaLabel: INSTRUMENT_ARIA_LABELS[value],
}));

interface ExplorerInstrumentsProps {
  /** Renders the selected instrument. Called once — see "One body, two containers". */
  renderInstrument: (instrument: Instrument) => ReactNode;
  /** How many pills the bar carries, for the collapsed summary. */
  activeFilterCount: number;
}

export function ExplorerInstruments({
  renderInstrument,
  activeFilterCount,
}: ExplorerInstrumentsProps) {
  const openPref = usePersistedPreference(PREFERENCE_KEYS.explorerInstrumentsOpen);
  const instrumentPref = usePersistedPreference(PREFERENCE_KEYS.explorerInstrument);

  // Until a client store has been consulted, render the NEUTRAL state — see the
  // no-flash rule in the docblock.
  const resolved = isResolved(openPref.raw);
  const open = resolved && parseBooleanPreference(openPref.raw, DEFAULT_INSTRUMENTS_OPEN);
  const instrument = parseEnumPreference(instrumentPref.raw, INSTRUMENTS, DEFAULT_INSTRUMENT);

  // `useReducedMotionConfig`, not `useReducedMotion`: the latter reads only the
  // device query and ignores a surrounding `MotionConfig`, which Storybook sets
  // to collapse motion for deterministic baselines. This panel's exit gates an
  // UNMOUNT, so with the wrong hook a story races a real 200ms exit.
  const reduceMotion = useReducedMotionConfig();
  const isMobile = useIsMobile();

  const setOpen = (next: boolean) => openPref.write(serializeBooleanPreference(next));

  // Rendered ONCE, then placed either inline or in the sheet.
  const body = open ? renderInstrument(instrument) : null;

  return (
    <section
      aria-label="Filter instruments"
      // `@container` so the segmented control can drop to icons on the PANEL's
      // width rather than the viewport's — the same arrangement ExplorerInsights
      // uses, and what makes this behave in a squeezed column.
      className="@container rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <Sliders className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
        <SegmentedControl
          label="Filter instrument"
          items={ITEMS}
          value={instrument}
          onChange={(next) => {
            instrumentPref.write(next);
            // Picking an instrument while folded EXPANDS. Otherwise the segment
            // lights up and nothing happens, which reads as a dead control —
            // and "show me the matrix" is a request to see it, not to select it.
            if (!open) setOpen(true);
          }}
          labels="wide"
          className="min-w-0"
        />

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* The collapsed summary: never fold away the answer. */}
          {!open && activeFilterCount > 0 && (
            <span className="hidden text-[10px] text-[var(--color-content-tertiary)] @sm:inline">
              {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} active
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            // Only reference the region while it EXISTS — it is unmounted when
            // collapsed, and on mobile it lives in a portal, so a static IDREF
            // would dangle in both cases.
            {...(open && !isMobile ? { 'aria-controls': PANEL_ID } : {})}
            aria-label={open ? 'Hide filter instruments' : 'Show filter instruments'}
            className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-content-secondary)]"
          >
            {/* One chevron that ROTATES rather than two swapped icons: the
                rotation is the affordance, and it survives reduced motion as a
                static direction. */}
            <motion.span
              animate={{ rotate: open ? 180 : 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.15 }}
              className="flex"
            >
              <ChevronDown className="size-4" aria-hidden />
            </motion.span>
          </button>
        </div>
      </div>

      {/* ── Desktop: the body unfolds in place ─────────────────────────────
          Mounted only once the stored preference is known, so the first
          application of it is an instant swap rather than an animated unfold —
          `AnimatePresence initial={false}` skips the enter transition for
          children present on its OWN first render. */}
      {resolved && !isMobile && (
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              id={PANEL_ID}
              key="instrument"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeOut' }}
              style={{ overflow: 'hidden' }}
            >
              <div className="border-t border-[var(--color-border)] px-4 pb-4 pt-4">{body}</div>
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {/* ── Mobile: the same body, in a sheet ──────────────────────────────
          Closing the sheet collapses the panel, so the header's chevron and the
          sheet's dismiss are one state rather than two that can disagree. */}
      {isMobile && (
        <BottomSheet
          open={open}
          onClose={() => setOpen(false)}
          title={INSTRUMENT_LABELS[instrument]}
        >
          <div className="pb-2">{body}</div>
        </BottomSheet>
      )}
    </section>
  );
}
