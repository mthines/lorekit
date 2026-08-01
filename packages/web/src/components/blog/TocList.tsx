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
      <ul className="relative flex flex-col gap-0.5">
        {/* Continuous rail behind every row — the "progress spine". */}
        <span className="absolute inset-y-1 left-0 w-px bg-[var(--color-border)]" aria-hidden />
        {items.map(({ id, text, depth }) => {
          const active = id === activeId;
          return (
            <li key={id} className={depth === 3 ? 'pl-3' : ''}>
              <a
                ref={active ? activeRef : undefined}
                href={`#${id}`}
                onClick={(event) => handleClick(event, id)}
                aria-current={active ? 'location' : undefined}
                className={[
                  'relative flex min-h-9 items-center rounded-md py-1.5 pr-3 pl-3 leading-snug transition-colors duration-150',
                  active
                    ? 'text-[var(--color-accent)]'
                    : 'text-[var(--color-content-secondary)] hover:text-[var(--color-content-primary)]',
                ].join(' ')}
              >
                {active && (
                  <>
                    {/* Sliding amber fill (shared layoutId — the signature pill). */}
                    <motion.span
                      layoutId={`${layoutId}-active`}
                      className="absolute inset-0 rounded-md bg-[var(--color-accent-subtle)]"
                      transition={{ type: 'spring', stiffness: 700, damping: 44, mass: 0.5 }}
                      aria-hidden
                    />
                    {/* Accent tick on the rail, so the spine reads as progress. */}
                    <motion.span
                      layoutId={`${layoutId}-tick`}
                      className="absolute -left-px top-1.5 bottom-1.5 w-0.5 rounded-full bg-[var(--color-accent)]"
                      transition={{ type: 'spring', stiffness: 700, damping: 44, mass: 0.5 }}
                      aria-hidden
                    />
                  </>
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
