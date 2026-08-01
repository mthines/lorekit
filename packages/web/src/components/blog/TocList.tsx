'use client';

import { useEffect, useRef, type MouseEvent } from 'react';
import { motion, MotionConfig } from 'motion/react';
import type { TocItem } from '@/lib/blog/toc';

interface TocListProps {
  items: readonly TocItem[];
  activeId: string;
  /** Scroll to a heading; returning `false` lets the native anchor jump happen. */
  onNavigate: (id: string) => boolean;
  /**
   * Distinct `layoutId` namespace per placement (desktop rail vs mobile panel) so
   * the two instances' sliding pills never animate into each other.
   */
  layoutId: string;
}

/**
 * The shared "On this page" list: heading links over a continuous rail, with a
 * sliding amber pill + accent tick (shared `layoutId`, the product's signature
 * move) marking the active section. Presentational — active state and navigation
 * come from {@link useActiveHeading} via props, so the desktop rail and the mobile
 * disclosure render the exact same list from one source of truth.
 */
export function TocList({ items, activeId, onNavigate, layoutId }: TocListProps) {
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  // Keep the active item visible: if the list lives in its own scroll container
  // (`[data-toc-scroll]` — the desktop rail on a long post, or the mobile panel)
  // and the active item has scrolled out of view, nudge ONLY that container into
  // view. Guarded to the container so it never scrolls the page.
  useEffect(() => {
    const el = activeRef.current;
    const scroller = el?.closest('[data-toc-scroll]');
    if (!el || !(scroller instanceof HTMLElement)) return;
    const item = el.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    if (item.top < box.top) scroller.scrollBy({ top: item.top - box.top - 8 });
    else if (item.bottom > box.bottom) scroller.scrollBy({ top: item.bottom - box.bottom + 8 });
  }, [activeId]);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    // Only take over if the target exists; otherwise let the browser jump.
    if (onNavigate(id)) event.preventDefault();
  };

  return (
    <MotionConfig reducedMotion="user">
      <ul className="relative flex flex-col gap-px">
        {/* Continuous rail behind every row — the reading "track" the active
            marker slides along. */}
        <span className="absolute inset-y-1 left-0 w-px bg-[var(--color-border)]" aria-hidden />
        {items.map(({ id, text, depth }) => {
          const active = id === activeId;
          return (
            <li key={id}>
              <a
                ref={active ? activeRef : undefined}
                href={`#${id}`}
                onClick={(event) => handleClick(event, id)}
                aria-current={active ? 'location' : undefined}
                className={[
                  'relative flex min-h-8 items-center rounded-md py-1.5 pr-2 leading-snug transition-colors duration-150',
                  // Depth-based indent conveys hierarchy; h3 is smaller + steps in.
                  depth === 3 ? 'pl-7 text-[13px]' : 'pl-4 text-sm',
                  active
                    ? 'font-medium text-[var(--color-accent)]'
                    : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]/60 hover:text-[var(--color-content-primary)]',
                ].join(' ')}
              >
                {active && (
                  // A single sliding accent bar on the track — sleeker than a
                  // filled pill, and it reads as "you are here" on the spine.
                  <motion.span
                    layoutId={`${layoutId}-marker`}
                    className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--color-accent)]"
                    transition={{ type: 'spring', stiffness: 700, damping: 44, mass: 0.5 }}
                    aria-hidden
                  />
                )}
                <span className="relative">{text}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </MotionConfig>
  );
}
