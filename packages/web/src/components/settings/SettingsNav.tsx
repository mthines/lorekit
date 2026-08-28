'use client';

import { FlaskConical } from 'lucide-react';
import { SectionNav, type SectionNavItem } from '@/components/ui/SectionNav';
import { SETTINGS_SECTIONS } from './sections';
import { usePendingInvitesForMe } from '@/lib/queries/pending-invites';
import { useDismissedInviteIds } from '@/lib/hooks/useDismissedInviteIds';
import { pendingInviteCount } from '@/lib/org-ui';
import { resolveDeploymentEnvironment } from '@/lib/otel-deployment-env';

/**
 * Not a `SETTINGS_SECTIONS` entry — that list is the customer-facing surface.
 * Forcing a flag variant is a debugging aid for the team building LoreKit,
 * not a setting a customer needs, so it's appended conditionally here rather
 * than being always-visible. Gated on the deployment environment (the same
 * cross-checked `NODE_ENV`/`VERCEL_ENV` resolution `otel-deployment-env.ts`
 * uses everywhere else) rather than an org role: overriding a flag only ever
 * changes what YOUR OWN session sees, so hiding the entry point outside
 * production is about not cluttering the customer-facing nav, not access
 * control — see `docs/feature-flags.md` § "Session overrides".
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

/**
 * Settings' consumer of the reusable {@link SectionNav}. Kept as a client
 * component so the section list (whose icons are component functions) stays
 * inside the client bundle rather than crossing the server→client prop
 * boundary. Also supplies the Organization item's badge count from the
 * shared `['pending-invites']` query (plan.md Decision D6).
 */
export function SettingsNav() {
  const { data: invites = [] } = usePendingInvitesForMe();
  const [dismissedIds, , hasHydrated] = useDismissedInviteIds();
  // 0 until hydrated so the server render and first client paint agree (no
  // badge), then the real count once localStorage-backed dismissals are known.
  const badgeCount = hasHydrated ? pendingInviteCount(invites, dismissedIds) : 0;

  const items = SETTINGS_SECTIONS.map((section) =>
    section.id === 'organization' ? { ...section, badgeCount } : section,
  );
  if (isNonProductionDeployment()) items.push(DEVELOPER_SECTION);

  return (
    <SectionNav
      items={items}
      ariaLabel="Settings sections"
      layoutId="settings-nav-active"
    />
  );
}
