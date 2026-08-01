'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { motion, MotionConfig } from 'motion/react';
import type { TocItem } from '@/lib/blog/toc';

/** The "reading line" (px from viewport top): a heading is the active section
 *  once its top rises above this. Deliberately a hair BELOW `BlogProse`'s
 *  `scroll-mt-28` (7rem = 112px) resting position — so a heading you click/anchor
 *  to (which lands at ~112px) counts as active, instead of leaving the previous
 *  section lit. */
const ACTIVE_OFFSET = 128;

interface TableOfContentsProps {
  items: readonly TocItem[];
}

/**
 * Scroll-spy "On this page" rail. Highlights the section the reader is currently
 * in and slides an amber pill (shared `layoutId`, the product's signature move)
 * to it as they scroll. Built on `IntersectionObserver` — the observer fires only
 * when a heading crosses the active line, and the active id is then resolved from
 * live positions, so it stays correct between crossings and at the page bottom
 * without a per-frame scroll listener.
 *
 * Accessibility: a labelled `nav` landmark, `aria-current="location"` on the
 * active link, ≥36px hit rows, and `MotionConfig reducedMotion="user"` so the
 * pill (and click-to-scroll) collapse to an instant jump when the reader asks for
 * reduced motion.
 */
export function TableOfContents({ items }: TableOfContentsProps) {
  const [activeId, setActiveId] = useState<string>(items[0]?.id ?? '');
  // Read the motion preference once for the click-to-scroll behaviour (MotionConfig
  // already governs the pill).
  const prefersReducedRef = useRef(false);

  // Resolve the active heading from live positions: the last heading whose top has
  // scrolled above the active line. Deterministic and cheap — one rect read per
  // heading, only when a crossing fires.
  const resolveActive = useCallback(() => {
    let current = items[0]?.id ?? '';
    for (const { id } of items) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.getBoundingClientRect().top - ACTIVE_OFFSET <= 0) current = id;
      else break;
    }
    setActiveId(current);
  }, [items]);

  useEffect(() => {
    prefersReducedRef.current =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const elements = items
      .map(({ id }) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    // The observer's job is only to WAKE us when a heading crosses the active
    // line; `resolveActive` does the actual picking from positions. The thin top
    // band (`-…px 0 -66% 0`) means an event fires right as a heading passes.
    const observer = new IntersectionObserver(() => resolveActive(), {
      rootMargin: `-${ACTIVE_OFFSET}px 0px -66% 0px`,
      threshold: [0, 1],
    });
    for (const el of elements) observer.observe(el);

    resolveActive(); // initial paint (handles deep-links + top-of-page)
    return () => observer.disconnect();
  }, [items, resolveActive]);

  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, id: string) => {
      const el = document.getElementById(id);
      if (!el) return; // let the browser handle it if the anchor is somehow missing
      event.preventDefault();
      el.scrollIntoView({
        behavior: prefersReducedRef.current ? 'auto' : 'smooth',
        block: 'start',
      });
      // Keep the URL shareable/deep-linkable without a second jarring jump.
      history.replaceState(null, '', `#${id}`);
      setActiveId(id);
    },
    [],
  );

  if (items.length === 0) return null;

  return (
    <MotionConfig reducedMotion="user">
      <nav aria-label="On this page" className="text-sm">
        <p className="mb-3 px-3 text-[11px] font-semibold uppercase tracking-widest text-[var(--color-content-tertiary)]">
          On this page
        </p>
        <ul className="relative flex flex-col gap-0.5">
          {/* Continuous rail behind every row — the "progress spine". */}
          <span
            className="absolute inset-y-1 left-0 w-px bg-[var(--color-border)]"
            aria-hidden
          />
          {items.map(({ id, text, depth }) => {
            const active = id === activeId;
            return (
              <li key={id} className={depth === 3 ? 'pl-3' : ''}>
                <a
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
                        layoutId="blog-toc-active"
                        className="absolute inset-0 rounded-md bg-[var(--color-accent-subtle)]"
                        transition={{ type: 'spring', stiffness: 700, damping: 44, mass: 0.5 }}
                        aria-hidden
                      />
                      {/* Accent tick on the rail, so the spine reads as progress. */}
                      <motion.span
                        layoutId="blog-toc-tick"
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
      </nav>
    </MotionConfig>
  );
}
