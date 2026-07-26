'use client';

import { SectionNav } from '@/components/ui/SectionNav';
import { SETTINGS_SECTIONS } from './sections';
import { usePendingInvitesForMe } from '@/lib/queries/pending-invites';
import { useDismissedInviteIds } from '@/lib/hooks/useDismissedInviteIds';
import { pendingInviteCount } from '@/lib/org-ui';

/**
 * Settings' consumer of the reusable {@link SectionNav}. Kept as a client
 * component so the section list (whose icons are component functions) stays
 * inside the client bundle rather than crossing the server→client prop
 * boundary. Also supplies the Organization item's badge count from the
 * shared `['pending-invites']` query (plan.md Decision D6).
 */
export function SettingsNav() {
  const { data: invites = [] } = usePendingInvitesForMe();
  const [dismissedIds] = useDismissedInviteIds();
  const badgeCount = pendingInviteCount(invites, dismissedIds);

  const items = SETTINGS_SECTIONS.map((section) =>
    section.id === 'organization' ? { ...section, badgeCount } : section,
  );

  return (
    <SectionNav
      items={items}
      ariaLabel="Settings sections"
      layoutId="settings-nav-active"
    />
  );
}
