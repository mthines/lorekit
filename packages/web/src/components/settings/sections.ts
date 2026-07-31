import { Key, Blocks, ShieldCheck, Users, UserCircle, CreditCard, FileCode } from 'lucide-react';
import type { SectionNavItem } from '@/components/ui/SectionNav';

/**
 * The settings sub-navigation. Add a new section by appending one entry here
 * and creating the matching `settings/<id>/page.tsx` route — the nav rail,
 * mobile tabs, and active-state highlighting all derive from this list.
 *
 * `api-docs` is the exception: it's an `external` item pointing at the Scalar
 * API reference (a route handler, not a settings page), so it opens in a new
 * tab and is never active-highlighted.
 *
 * `subItems` are in-page anchors to the cards on a section's page, revealed
 * while that section is active. Only add them to a section with MORE THAN ONE
 * card — with one card the sub-item is a link to the page you are already on.
 * `SectionNav` enforces the same rule structurally, so a section that grows a
 * second card picks up its sub-nav by adding the entry here and nothing else.
 * Each sub-item `id` must match the `anchorId` of its `SectionPanel`.
 */
export const SETTINGS_SECTIONS: readonly SectionNavItem[] = [
  { id: 'api-keys', label: 'API keys', href: '/settings/api-keys', icon: Key },
  // One card (GitHub App) today, so no sub-items. Named for the user's goal
  // rather than the mechanism — "webhooks" is how it works, "integrations" is
  // what it is, and the next connector has somewhere to live.
  { id: 'integrations', label: 'Integrations', href: '/settings/integrations', icon: Blocks },
  { id: 'organization', label: 'Organization', href: '/settings/organization', icon: Users },
  { id: 'audit', label: 'Audit Logs', href: '/settings/audit', icon: ShieldCheck },
  { id: 'plan', label: 'Plan', href: '/settings/plan', icon: CreditCard },
  {
    id: 'user',
    label: 'User',
    href: '/settings/user',
    icon: UserCircle,
    subItems: [
      { id: 'account', label: 'Account' },
      { id: 'password', label: 'Password' },
    ],
  },
  { id: 'api-docs', label: 'API reference', href: '/api-docs', icon: FileCode, external: true },
];