'use client';

import { FlaskConical } from 'lucide-react';
import { SectionNav, type SectionNavItem } from '@/components/ui/SectionNav';
import { SETTINGS_SECTIONS } from './sections';
import { usePendingInvitesForMe } from '@/lib/queries/pending-invites';
import { useDismissedInviteIds } from '@/lib/hooks/useDismissedInviteIds';
import { useDeveloperNavRevealed } from '@/lib/hooks/useDeveloperNavRevealed';
import { pendingInviteCount } from '@/lib/org-ui';
import { resolveDeploymentEnvironment } from '@/lib/otel-deployment-env';
import { isDeveloperEmail } from '@/lib/developer-users';

/**
 * Not a `SETTINGS_SECTIONS` entry — that list is the customer-facing surface.
 * Forcing a flag variant is a debugging aid for the team building LoreKit,
 * not a setting a customer needs, so it's appended conditionally here rather
 * than being always-visible.
 *
 * Two DIFFERENT gates decide visibility, stacked:
 *
 *   1. Outside production: always shown. Overriding a flag only ever changes
 *      what YOUR OWN session sees, so hiding the entry point in dev/preview
 *      is about not cluttering the nav, not access control — see
 *      `docs/feature-flags.md` § "Session overrides".
 *   2. In production: shown only for an allowlisted developer
 *      (`isDeveloperEmail` — `lib/developer-users.ts`) AND only after the
 *      5-consecutive-clicks reveal gesture on the avatar
 *      (`UserSettingsPanel.tsx` → `useDeveloperNavRevealed`). A customer in
 *      production should never see this at all, allowlisted or not — the
 *      gesture is a "don't show it in my screenshots by default" affordance
 *      for the developer, not a security boundary. The actual security
 *      boundary is `isDeveloperEmail`, enforced again (independently, this
 *      is only the nav link) on the page itself
 *      (`app/(dashboard)/settings/developer/page.tsx`'s `notFound()`).
 */
const DEVELOPER_SECTION: SectionNavItem = {
  id: 'developer',
  label: 'Developer',
  href: '/settings/developer',
  icon: FlaskConical,
};

function isNonProductionDeployment(): boolean {
  return (
    resolveDeploymentEnvironment(process.env.NEXT_PUBLIC_VERCEL_ENV, process.env.NODE_ENV).name !==
    'production'
  );
}

export interface SettingsNavProps {
  /** The signed-in user's email, resolved once by `settings/layout.tsx` — for the developer-nav gate only. */
  userEmail: string | null;
}

/**
 * Settings' consumer of the reusable {@link SectionNav}. Kept as a client
 * component so the section list (whose icons are component functions) stays
 * inside the client bundle rather than crossing the server→client prop
 * boundary. Also supplies the Organization item's badge count from the
 * shared `['pending-invites']` query (plan.md Decision D6).
 */
export function SettingsNav({ userEmail }: SettingsNavProps) {
  const { data: invites = [] } = usePendingInvitesForMe();
  const [dismissedIds, , hasHydrated] = useDismissedInviteIds();
  const developerNavRevealed = useDeveloperNavRevealed();
  // 0 until hydrated so the server render and first client paint agree (no
  // badge), then the real count once localStorage-backed dismissals are known.
  const badgeCount = hasHydrated ? pendingInviteCount(invites, dismissedIds) : 0;

  const items = SETTINGS_SECTIONS.map((section) =>
    section.id === 'organization' ? { ...section, badgeCount } : section,
  );
  const showDeveloperNav =
    isNonProductionDeployment() || (isDeveloperEmail(userEmail) && developerNavRevealed);
  if (showDeveloperNav) items.push(DEVELOPER_SECTION);

  return (
    <SectionNav
      items={items}
      ariaLabel="Settings sections"
      layoutId="settings-nav-active"
    />
  );
}
