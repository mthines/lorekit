import { Rocket, FileCog, HardDrive, Cloud, Users, Lock, Tag, Zap } from 'lucide-react';
import type { SectionNavItem } from '@/components/ui/SectionNav';

/**
 * The Learn section navigation — a single grouped list covering both the
 * initial setup checklist and the step-by-step tutorials.
 *
 * Items with a `divider` string render a labelled section break on desktop
 * (hidden on mobile so the horizontal tab strip stays clean). The divider
 * sits immediately before its item, visually opening a new group.
 *
 * Ordered so a new user can read top-to-bottom as a natural learning path:
 *   Setup     — get LoreKit connected (checklist)
 *   ──────────────────────────────────────────
 *   Tutorials — go deeper on each topic
 */
export const LEARN_SECTIONS: readonly SectionNavItem[] = [
  // ── Setup ──────────────────────────────────────────────────────────────────
  {
    id: 'setup',
    label: 'Getting started',
    href: '/learn/setup',
    icon: Rocket,
  },
  {
    id: 'config',
    label: 'Configuration',
    href: '/learn/config',
    icon: FileCog,
  },

  // ── Tutorials ──────────────────────────────────────────────────────────────
  {
    id: 'offline',
    label: 'Offline storage',
    href: '/learn/offline',
    icon: HardDrive,
    divider: 'Tutorials',
  },
  {
    id: 'remote',
    label: 'Remote storage',
    href: '/learn/remote',
    icon: Cloud,
  },
  {
    id: 'organization',
    label: 'Team sharing',
    href: '/learn/organization',
    icon: Users,
  },
  {
    id: 'private',
    label: 'Private lore',
    href: '/learn/private',
    icon: Lock,
  },
  {
    id: 'tags',
    label: 'Tags & scopes',
    href: '/learn/tags',
    icon: Tag,
  },
  {
    id: 'use-cases',
    label: 'Use cases',
    href: '/learn/use-cases',
    icon: Zap,
  },
];
