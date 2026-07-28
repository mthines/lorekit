import { Key, Webhook, ShieldCheck, Users, UserCircle, CreditCard } from 'lucide-react';
import type { SectionNavItem } from '@/components/ui/SectionNav';

/**
 * The settings sub-navigation. Add a new section by appending one entry here
 * and creating the matching `settings/<id>/page.tsx` route — the nav rail,
 * mobile tabs, and active-state highlighting all derive from this list.
 */
export const SETTINGS_SECTIONS: readonly SectionNavItem[] = [
  { id: 'plan', label: 'Plan', href: '/settings/plan', icon: CreditCard },
  { id: 'api-keys', label: 'API keys', href: '/settings/api-keys', icon: Key },
  { id: 'webhooks', label: 'Webhooks', href: '/settings/webhooks', icon: Webhook },
  { id: 'organization', label: 'Organization', href: '/settings/organization', icon: Users },
  { id: 'audit', label: 'Audit Logs', href: '/settings/audit', icon: ShieldCheck },
  { id: 'user', label: 'User', href: '/settings/user', icon: UserCircle },
];