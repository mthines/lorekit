'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, MotionConfig } from 'motion/react';
import type { LucideIcon } from 'lucide-react';

export interface SectionNavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
}

interface SectionNavProps {
  items: readonly SectionNavItem[];
  /** Accessible name for the nav landmark, e.g. "Settings sections". */
  ariaLabel: string;
  /**
   * Unique `layoutId` for the sliding active pill. Give each SectionNav on a
   * page its own id so their pills don't animate into one another.
   */
  layoutId?: string;
}

/**
 * Reusable secondary navigation — a data-driven list that renders as a vertical
 * rail on desktop (md+) and a horizontal, scrollable tab row on mobile. An amber
 * pill (shared `layoutId`) slides to the active item; the active item is kept in
 * view on mobile. Active = exact match or a nested route under the item's href.
 *
 * Drive it from a typed items array so adding an entry is the only change needed.
 */
export function SectionNav({ items, ariaLabel, layoutId = 'section-nav-active' }: SectionNavProps) {
  const pathname = usePathname();
  // On mobile the nav scrolls horizontally; keep the active tab visible when the
  // route changes or when landing deep-linked on an off-screen section.
  const activeRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [pathname]);

  return (
    <MotionConfig reducedMotion="user">
      <nav
        aria-label={ariaLabel}
        className="flex gap-1 overflow-x-auto border-b border-[var(--color-border)] pb-2 md:w-52 md:shrink-0 md:flex-col md:overflow-visible md:border-b-0 md:pb-0"
      >
        {items.map(({ id, label, href, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={id}
              href={href}
              prefetch
              ref={active ? activeRef : undefined}
              aria-current={active ? 'page' : undefined}
              className={[
                // 44px min touch target (WCAG 2.2 SC 2.5.8)
                'relative flex min-h-11 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 text-sm transition-colors duration-150',
                active
                  ? 'text-[var(--color-accent)]'
                  : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]',
              ].join(' ')}
            >
              {active && (
                <motion.span
                  layoutId={layoutId}
                  className="absolute inset-0 rounded-lg bg-[var(--color-accent-subtle)]"
                  transition={{ type: 'spring', stiffness: 900, damping: 48, mass: 0.5 }}
                  aria-hidden
                />
              )}
              <Icon className="relative size-4 shrink-0" aria-hidden />
              <span className="relative font-medium">{label}</span>
            </Link>
          );
        })}
      </nav>
    </MotionConfig>
  );
}
