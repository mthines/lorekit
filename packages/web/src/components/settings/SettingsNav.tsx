'use client';

import { SectionNav } from '@/components/ui/SectionNav';
import { SETTINGS_SECTIONS } from './sections';

/**
 * Settings' consumer of the reusable {@link SectionNav}. Kept as a client
 * component so the section list (whose icons are component functions) stays
 * inside the client bundle rather than crossing the server→client prop boundary.
 */
export function SettingsNav() {
  return (
    <SectionNav
      items={SETTINGS_SECTIONS}
      ariaLabel="Settings sections"
      layoutId="settings-nav-active"
    />
  );
}
