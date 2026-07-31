import { Key, Webhook, ShieldCheck, Users, UserCircle, CreditCard, FileCode } from 'lucide-react';
import type { SectionNavItem } from '@/components/ui/SectionNav';

/**
 * The settings sub-navigation. Add a new section by appending one entry here
 * and creating the matching `settings/<id>/page.tsx` route — the nav rail,
 * mobile tabs, and active-state highlighting all derive from this list.
 *
 * `api-docs` is the exception: it's an `external` item pointing at the Scalar
 * API reference (a route handler, not a settings page), so it opens in a new
 * tab and is never active-highlighted.
 */
export const SETTINGS_SECTIONS: readonly SectionNavItem[] = [
  { id: 'api-keys', label: 'API keys', href: '/settings/api-keys', icon: Key },
  { id: 'webhooks', label: 'Webhooks', href: '/settings/webhooks', icon: Webhook },
  { id: 'organization', label: 'Organization', href: '/settings/organization', icon: Users },
  { id: 'audit', label: 'Audit Logs', href: '/settings/audit', icon: ShieldCheck },
  { id: 'plan', label: 'Plan', href: '/settings/plan', icon: CreditCard },
  { id: 'user', label: 'User', href: '/settings/user', icon: UserCircle },
  { id: 'api-docs', label: 'API reference', href: '/api-docs', icon: FileCode, external: true },
];