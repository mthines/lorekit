'use client';

import { useEffect, useId, useState } from 'react';
import { ChevronDown, List } from 'lucide-react';
import type { TocItem } from '@/lib/blog/toc';
import { useActiveHeading } from './useActiveHeading';
import { TocList } from './TocList';

interface MobileTableOfContentsProps {
  items: readonly TocItem[];
}

/**
 * The mobile/tablet "On this page" control — shown below `lg`, where there's no
 * room for the sticky right rail. A collapsible bar that sticks below the header
 * so the TOC is reachable anywhere in the post (not just at the top), and whose
 * trigger doubles as a "you are here" indicator: collapsed, it shows the current
 * section's name. Tapping expands the shared {@link TocList}; choosing a section
 * scrolls there and collapses.
 *
 * The expand/collapse uses a `grid-template-rows: 0fr → 1fr` transition (no fixed
 * height needed, and the global `prefers-reduced-motion` rule in `globals.css`
 * neutralises it for reduced-motion users). Scroll-spy state is shared with the
 * desktop rail via {@link useActiveHeading}.
 */
export function MobileTableOfContents({ items }: MobileTableOfContentsProps) {
  const { activeId, navigate } = useActiveHeading(items);
  const [open, setOpen] = useState(false);
  const panelId = useId();

  // Escape closes the expanded panel — standard disclosure a11y.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (items.length === 0) return null;

  const activeItem = items.find((i) => i.id === activeId) ?? items[0];

  return (
    <nav
      aria-label="On this page"
      className="sticky top-14 z-20 -mx-6 mb-8 border-y border-[var(--color-border)] bg-[var(--color-bg)]/90 px-6 backdrop-blur md:-mx-10 md:px-10 lg:hidden"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-11 w-full items-center gap-2 text-sm"
      >
        <List className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
        <span className="shrink-0 font-medium text-[var(--color-content-secondary)]">On this page</span>
        {!open && activeItem && (
          <span className="min-w-0 flex-1 truncate text-left text-[var(--color-accent)]">
            {activeItem.text}
          </span>
        )}
        <ChevronDown
          className={[
            'ml-auto size-4 shrink-0 text-[var(--color-content-tertiary)] transition-transform duration-200',
            open ? 'rotate-180' : '',
          ].join(' ')}
          aria-hidden
        />
      </button>

      {/* grid-rows 0fr→1fr disclosure — reduced-motion handled globally. */}
      <div
        id={panelId}
        className={[
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        ].join(' ')}
      >
        <div className="overflow-hidden">
          <div className="max-h-[60vh] overflow-y-auto pb-3 pt-1 text-sm">
            <TocList
              items={items}
              activeId={activeId}
              layoutId="blog-toc-mobile"
              onNavigate={(id) => {
                const ok = navigate(id);
                if (ok) setOpen(false);
                return ok;
              }}
            />
          </div>
        </div>
      </div>
    </nav>
  );
}
