import {
  Rocket,
  HardDrive,
  Cloud,
  Globe,
  Users,
  Lock,
  Tag,
  FileCog,
  Zap,
  Link2,
  FileCode,
  type LucideIcon,
} from 'lucide-react';
import type { SectionNavItem } from '@/components/ui/SectionNav';

/**
 * The public docs table of contents — the single source of truth for BOTH the
 * `/docs` nav rail (via {@link SectionNav}) and the ⌘K "Docs" command group in
 * `NavigationCommands`. Adding a page means: drop a `src/content/docs/<id>.mdx`
 * file (with matching frontmatter) AND add its entry here — the same
 * "one destination, registered everywhere" invariant the Settings pages follow.
 *
 * `id` is the URL slug and the MDX filename stem; ordering here is the reading
 * order (Setup first, then the tutorials). The content file's `order` frontmatter
 * should agree, but this list is authoritative for navigation.
 */
export interface DocsSection {
  id: string;
  label: string;
  icon: LucideIcon;
  /** One-line summary for the ⌘K command description. */
  summary: string;
}

export const DOCS_SECTIONS: readonly DocsSection[] = [
  { id: 'setup', label: 'Getting started', icon: Rocket, summary: 'Connect your agent and generate a token' },
  { id: 'offline', label: 'Offline storage', icon: HardDrive, summary: 'Store lessons locally without a server' },
  { id: 'remote', label: 'Remote storage', icon: Cloud, summary: 'Sync lessons to the hosted LoreKit server' },
  { id: 'organization', label: 'Team sharing', icon: Users, summary: 'Share lore across your organization' },
  { id: 'private', label: 'Private lore', icon: Lock, summary: 'Keep sensitive lessons private' },
  { id: 'tags', label: 'Tags & scopes', icon: Tag, summary: 'Organise lessons by scope and tag' },
  { id: 'config', label: 'Configuration', icon: FileCog, summary: 'All .lorekit.json / config.json options' },
  { id: 'claude-code-web', label: 'Claude Code on the web', icon: Globe, summary: 'Set up LoreKit in the cloud web environment' },
  { id: 'use-cases', label: 'Use cases', icon: Zap, summary: 'Common patterns and workflows' },
  { id: 'deep-links', label: 'Deep links', icon: Link2, summary: 'Shareable dashboard URLs for scopes, memories, and filters' },
];

/** URL slugs / MDX filename stems, in reading order. */
export const DOCS_SLUGS: readonly string[] = DOCS_SECTIONS.map((s) => s.id);

/**
 * Nav-rail items for {@link SectionNav}: every section as a `/docs/<id>` link,
 * a "Tutorials" divider before the second item, and the external REST API
 * reference (the Scalar page, a route handler — hence `external`) pinned last.
 */
export const DOCS_NAV_ITEMS: readonly SectionNavItem[] = [
  ...DOCS_SECTIONS.map((s, i) => ({
    id: s.id,
    label: s.label,
    href: `/docs/${s.id}`,
    icon: s.icon,
    ...(i === 1 ? { divider: 'Tutorials' } : {}),
  })),
  {
    id: 'api-reference',
    label: 'API reference',
    href: '/api-docs',
    icon: FileCode,
    external: true,
    divider: 'Reference',
  },
];
