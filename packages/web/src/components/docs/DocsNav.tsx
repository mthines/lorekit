'use client';

import { SectionNav } from '@/components/ui/SectionNav';
import { DOCS_NAV_ITEMS } from '@/lib/docs/sections';

/**
 * The `/docs` secondary nav rail. A thin consumer of the reusable
 * {@link SectionNav}, driven by {@link DOCS_NAV_ITEMS} (the single docs TOC),
 * with its own `layoutId` so the active pill never bleeds into another nav.
 */
export function DocsNav() {
  return (
    <SectionNav items={DOCS_NAV_ITEMS} ariaLabel="Documentation sections" layoutId="docs-nav-active" />
  );
}
