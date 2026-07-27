'use client';

import { SectionNav } from '@/components/ui/SectionNav';
import { TUTORIAL_SECTIONS } from './sections';

/**
 * Tutorials' consumer of the reusable {@link SectionNav}. A client component
 * so that icon component references (LucideIcon) stay in the client bundle.
 */
export function TutorialsNav() {
  return (
    <SectionNav
      items={TUTORIAL_SECTIONS}
      ariaLabel="Tutorial sections"
      layoutId="tutorials-nav-active"
    />
  );
}
