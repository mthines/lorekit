import { Key, Webhook, ShieldCheck } from 'lucide-react';
import type { SectionNavItem } from '@/components/ui/SectionNav';

/**
 * The settings sub-navigation. Add a new section by appending one entry here
 * and creating the matching `settings/<id>/page.tsx` route — the nav rail,
 * mobile tabs, and active-state highlighting all derive from this list.
 */
export const SETTINGS_SECTIONS: readonly SectionNavItem[] = [
  { id: 'api-keys', label: 'API keys', href: '/settings/api-keys', icon: Key },
  { id: 'webhooks', label: 'Webhooks', href: '/settings/webhooks', icon: Webhook },
  { id: 'audit', label: 'Audit Logs', href: '/settings/audit', icon: ShieldCheck },
];
