'use client';

import { SectionNav } from '@/components/ui/SectionNav';
import { LEARN_SECTIONS } from './sections';

/**
 * Learn section's consumer of the reusable {@link SectionNav}. A client
 * component so that icon component references (LucideIcon) stay in the client
 * bundle. Uses a unique `layoutId` so the animated active pill doesn't bleed
 * into the Settings or any other SectionNav on the page.
 */
export function LearnNav() {
  return (
    <SectionNav
      items={LEARN_SECTIONS}
      ariaLabel="Learn sections"
      layoutId="learn-nav-active"
    />
  );
}
