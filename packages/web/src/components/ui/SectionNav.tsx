'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, MotionConfig } from 'motion/react';
import { ArrowUpRight, ChevronDown, type LucideIcon } from 'lucide-react';
import { useHash } from '@/lib/hooks/useHash';
import {
  activeSubItemId,
  isSectionActive,
  shouldRevealSubItems,
  type SectionNavSubItem,
} from './section-nav';

export type { SectionNavSubItem };

export interface SectionNavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Optional count pill rendered after the label (e.g. pending invites). Hidden when 0 or absent. */
  badgeCount?: number;
  /**
   * When set, renders a divider (horizontal rule + optional label) immediately
   * before this item. Use to visually group related items within the nav, e.g.
   * "Setup" and "Tutorials" within a unified learning section.
   * Hidden on mobile (horizontal scroll strips the visual grouping context).
   */
  divider?: string;
  /**
   * Links OUT of the section to another surface (e.g. the /api-docs Scalar page,
   * which is a route handler, not an app-router page). Renders a plain anchor
   * that opens in a new tab with a trailing ↗, and is never marked active.
   */
  external?: boolean;
  /**
   * In-page anchors for the cards on this section's page, revealed as an
   * indented list while the section is active. Only rendered when there is
   * more than one — see {@link shouldRevealSubItems}. Each `id` must match the
   * `anchorId` of the corresponding `SectionPanel`.
   */
  subItems?: readonly SectionNavSubItem[];
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
 * Items may carry an optional `divider` string which renders a labelled section
 * break immediately before the item on desktop. On mobile the divider is hidden
 * so the horizontal tab strip stays uncluttered.
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

  // Sub-items are in-page anchors, so the fragment — not the pathname — says
  // which one is current.
  const hash = useHash();

  return (
    <MotionConfig reducedMotion="user">
      <nav
        aria-label={ariaLabel}
        className="flex gap-1 overflow-x-auto border-b border-[var(--color-border)] pb-2 md:w-52 md:shrink-0 md:flex-col md:overflow-visible md:border-b-0 md:pb-0"
      >
        {items.map(({ id, label, href, icon: Icon, badgeCount, divider, external, subItems }) => {
          const active = isSectionActive(pathname, href, external);
          const revealSubItems = shouldRevealSubItems(active, subItems);
          // The chevron is the only hint an inactive section has children —
          // without it, depth is invisible until you happen to click in.
          const hasSubItems = (subItems?.length ?? 0) > 1;
          const currentSubItemId = revealSubItems ? activeSubItemId(subItems ?? [], hash) : null;
          const className = [
            // 44px min touch target (WCAG 2.2 SC 2.5.8)
            'relative flex min-h-11 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 text-sm transition-colors duration-150',
            active
              ? 'text-[var(--color-accent)]'
              : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]',
          ].join(' ');
          const inner = (
            <>
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
              {external && <ArrowUpRight className="relative ml-auto size-3.5 shrink-0 opacity-70" aria-hidden />}
              {hasSubItems && (
                <ChevronDown
                  className={[
                    'relative ml-auto hidden size-3.5 shrink-0 text-[var(--color-content-tertiary)] transition-transform duration-150 md:block',
                    active ? 'rotate-180' : '',
                  ].join(' ')}
                  aria-hidden
                />
              )}
              {Boolean(badgeCount && badgeCount > 0) && (
                <span
                  className="relative ml-auto flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-semibold text-[#000]"
                  aria-label={`${badgeCount} pending`}
                >
                  {badgeCount}
                </span>
              )}
            </>
          );
          return (
            <div key={id} className="contents">
              {/* Divider — desktop only; hidden in mobile horizontal scroll */}
              {divider && (
                <div
                  className="hidden md:flex items-center gap-2 px-3 pt-4 pb-1"
                  aria-hidden
                >
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-content-tertiary)]">
                    {divider}
                  </span>
                  <div className="flex-1 border-t border-[var(--color-border)]" />
                </div>
              )}
              {external ? (
                <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
                  {inner}
                </a>
              ) : (
                <Link
                  href={href}
                  prefetch
                  ref={active ? activeRef : undefined}
                  aria-current={active ? 'page' : undefined}
                  className={className}
                >
                  {inner}
                </Link>
              )}

              {/*
                Sub-items — desktop only, for the same reason as the divider:
                the mobile rail is a horizontal strip, and a second level in it
                reads as more destinations rather than as detail within one.
                On mobile the cards themselves are the navigation (they are all
                on one short page).
              */}
              {revealSubItems && (
                <ul className="hidden md:flex md:flex-col md:gap-0.5 md:pt-0.5">
                  {(subItems ?? []).map((subItem) => {
                    const current = subItem.id === currentSubItemId;
                    return (
                      <li key={subItem.id} className="relative pl-[1.375rem]">
                        {/* Rail: one continuous line, so the group reads as one unit. */}
                        <span
                          className="absolute inset-y-0 left-[1.125rem] w-px bg-[var(--color-border)]"
                          aria-hidden
                        />
                        <a
                          href={`#${subItem.id}`}
                          aria-current={current ? 'location' : undefined}
                          className={[
                            'flex min-h-9 items-center rounded-md px-3 text-[13px] transition-colors duration-150',
                            current
                              ? 'font-medium text-[var(--color-accent)]'
                              : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-primary)]',
                          ].join(' ')}
                        >
                          {subItem.label}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
    </MotionConfig>
  );
}
