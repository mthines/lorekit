import { HardDrive, Cloud, Users, Lock, Tag, Zap } from 'lucide-react';
import type { SectionNavItem } from '@/components/ui/SectionNav';

/**
 * The tutorials sub-navigation. Add a new tutorial by appending one entry here
 * and creating the matching `tutorials/<id>/page.tsx` route — the nav rail,
 * mobile tabs, and active-state highlighting all derive from this list.
 *
 * Ordered from most-common / self-contained first to team / advanced last,
 * so new users can read top-to-bottom as a getting-deeper path.
 */
export const TUTORIAL_SECTIONS: readonly SectionNavItem[] = [
  {
    id: 'offline',
    label: 'Offline storage',
    href: '/tutorials/offline',
    icon: HardDrive,
  },
  {
    id: 'remote',
    label: 'Remote storage',
    href: '/tutorials/remote',
    icon: Cloud,
  },
  {
    id: 'organization',
    label: 'Team sharing',
    href: '/tutorials/organization',
    icon: Users,
  },
  {
    id: 'private',
    label: 'Private lore',
    href: '/tutorials/private',
    icon: Lock,
  },
  {
    id: 'tags',
    label: 'Tags & scopes',
    href: '/tutorials/tags',
    icon: Tag,
  },
  {
    id: 'use-cases',
    label: 'Use cases',
    href: '/tutorials/use-cases',
    icon: Zap,
  },
];
