'use client';

import type { TocItem } from '@/lib/blog/toc';
import { useActiveHeading } from './useActiveHeading';
import { TocList } from './TocList';

interface TableOfContentsProps {
  items: readonly TocItem[];
}

/**
 * The desktop "On this page" rail — a sticky scroll-spy list shown from `lg` up
 * (the page renders {@link MobileTableOfContents} below `lg`). Scroll-spy state
 * and navigation come from {@link useActiveHeading}; the list itself is the shared
 * {@link TocList}. See that hook for the active-resolution + a11y details.
 */
export function TableOfContents({ items }: TableOfContentsProps) {
  const { activeId, navigate } = useActiveHeading(items);
  if (items.length === 0) return null;

  return (
    <nav aria-label="On this page" className="text-sm">
      <p className="mb-3 px-3 text-[11px] font-semibold uppercase tracking-widest text-[var(--color-content-tertiary)]">
        On this page
      </p>
      <TocList items={items} activeId={activeId} onNavigate={navigate} layoutId="blog-toc" />
    </nav>
  );
}
