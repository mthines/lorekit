'use client';

/**
 * NavigationCommands
 *
 * Registers all global commands available on every dashboard page.
 * Mount this once inside `CommandPaletteProvider` (done in the dashboard
 * layout) so they are always present regardless of which page is active.
 *
 * ## Command groups
 *
 * ### Navigate
 * Top-level destinations with "g → X" chained shortcuts (Gmail / Linear style):
 *   g o → Dashboard (Home)
 *   g e → Lore Explorer
 *   g s → Settings
 *   g g → Docs
 *
 * ### Settings
 * Direct jumps to each settings section (no extra shortcuts — use search):
 *   Plan · API Keys · Integrations · Organization · Audit Logs · User profile
 *
 * ### Docs
 * Direct jumps to each public docs page (driven by the single `DOCS_SECTIONS`
 * table so the palette can never drift from the nav rail) plus the REST API
 * reference. The docs pages are also full-text searchable at `/docs`.
 *
 * ### Lore
 * "Open Lesson…" — async nested list of the 20 most-recent memories;
 * selecting one opens it in the lesson detail sidebar.
 */

import { useRouter } from 'next/navigation';
import {
  BookOpen,
  LayoutDashboard,
  Settings,
  GraduationCap,
  Newspaper,
  Key,
  Blocks,
  Users,
  ShieldCheck,
  UserCircle,
  CreditCard,
  FileCode,
  Library,
} from 'lucide-react';
import { useCommand } from './useCommand';
import { useMemorySidebar } from '@/components/providers/MemorySidebarProvider';
import { useLoreData } from '@/lib/queries/lore';
import { DOCS_SECTIONS, type DocsSection } from '@/lib/docs/sections';
import { SETTINGS_LANDING_HREF } from '@/lib/settings-routes';

// ── Lore sub-commands helper ──────────────────────────────────────────────────
//
// Rendered as a separate component so it can safely call hooks that depend on
// MemorySidebarProvider. NavigationCommands is mounted INSIDE
// MemorySidebarProvider in the dashboard layout precisely so useMemorySidebar()
// here resolves — the command registry itself still comes from the ancestor
// CommandPaletteProvider.

function LoreCommands() {
  const router = useRouter();
  const { openLessonById } = useMemorySidebar();
  const { data } = useLoreData();

  useCommand({
    id: 'lore-open-lesson',
    label: 'Open Lesson…',
    icon: <Library className="size-4" />,
    group: 'Lore',
    // Async children: resolves the 20 most-recent lessons at open time so the
    // list is always fresh without blocking the palette open.
    children: async () => {
      const lessons = data?.lessons?.slice(0, 20) ?? [];
      if (lessons.length === 0) {
        return [
          {
            id: 'lore-no-lessons',
            label: 'No lessons found',
            description: 'Visit the Lore Explorer to add some.',
            onSelect: () => router.push('/lore'),
          },
        ];
      }
      return lessons.map((lesson) => ({
        id: `lore-lesson-${lesson.scope}::${lesson.key}`,
        label: lesson.key,
        description: lesson.scope,
        onSelect: () =>
          openLessonById({ scope: lesson.scope, key: lesson.key }),
      }));
    },
  });

  return null;
}

// ── Docs sub-commands ─────────────────────────────────────────────────────────
//
// One command per docs page, driven by the shared DOCS_SECTIONS table (the same
// source the /docs nav rail uses) so adding a page registers it everywhere at
// once. Each item is its own component so useCommand is called at a stable hook
// position rather than inside a .map() in the parent.

function DocsCommandItem({ section }: { section: DocsSection }) {
  const router = useRouter();
  const Icon = section.icon;
  useCommand({
    id: `docs-${section.id}`,
    label: section.label,
    description: section.summary,
    icon: <Icon className="size-4" />,
    group: 'Docs',
    onSelect: () => router.push(`/docs/${section.id}`),
  });
  return null;
}

function DocsCommands() {
  return (
    <>
      {DOCS_SECTIONS.map((section) => (
        <DocsCommandItem key={section.id} section={section} />
      ))}
    </>
  );
}

// ── Main registration component ───────────────────────────────────────────────

export function NavigationCommands() {
  const router = useRouter();

  // ── Navigate ─────────────────────────────────────────────────────────────

  useCommand({
    id: 'nav-overview',
    label: 'Go to Overview',
    icon: <LayoutDashboard className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 'o'] },
    onSelect: () => router.push('/overview'),
  });

  useCommand({
    id: 'nav-explorer',
    label: 'Go to Lore Explorer',
    icon: <BookOpen className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 'e'] },
    onSelect: () => router.push('/lore'),
  });

  useCommand({
    id: 'nav-settings',
    label: 'Go to Settings',
    icon: <Settings className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 's'] },
    onSelect: () => router.push(SETTINGS_LANDING_HREF),
  });

  useCommand({
    id: 'nav-docs',
    label: 'Go to Docs',
    icon: <GraduationCap className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 'g'] },
    onSelect: () => router.push('/docs'),
  });

  useCommand({
    id: 'nav-blog',
    label: 'Go to Blog',
    icon: <Newspaper className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 'b'] },
    onSelect: () => router.push('/blog'),
  });

  // ── Settings ──────────────────────────────────────────────────────────────

  useCommand({
    id: 'settings-plan',
    label: 'Plan',
    description: 'Your plan, memory usage, and capacity',
    icon: <CreditCard className="size-4" />,
    group: 'Settings',
    onSelect: () => router.push('/settings/plan'),
  });

  useCommand({
    id: 'settings-api-keys',
    label: 'API Keys',
    description: 'Manage your MCP API tokens',
    icon: <Key className="size-4" />,
    group: 'Settings',
    onSelect: () => router.push('/settings/api-keys'),
  });

  useCommand({
    id: 'settings-integrations',
    // "webhook" stays in the description so anyone searching the palette for
    // the old name still lands here.
    label: 'Integrations',
    description: 'Install the GitHub App — PR review comments and webhooks',
    icon: <Blocks className="size-4" />,
    group: 'Settings',
    onSelect: () => router.push('/settings/integrations'),
  });

  useCommand({
    id: 'settings-organization',
    label: 'Organization',
    description: 'Manage team members and shared scopes',
    icon: <Users className="size-4" />,
    group: 'Settings',
    onSelect: () => router.push('/settings/organization'),
  });

  useCommand({
    id: 'settings-audit',
    label: 'Audit Logs',
    description: 'Browse your account activity history',
    icon: <ShieldCheck className="size-4" />,
    group: 'Settings',
    onSelect: () => router.push('/settings/audit'),
  });

  useCommand({
    id: 'settings-user',
    label: 'User Settings',
    description: 'Your profile and account preferences',
    icon: <UserCircle className="size-4" />,
    group: 'Settings',
    onSelect: () => router.push('/settings/user'),
  });

  // ── Docs ────────────────────────────────────────────────────────────────────

  useCommand({
    id: 'docs-api-reference',
    label: 'API Reference',
    description: 'Open the REST API docs (opens in a new tab)',
    icon: <FileCode className="size-4" />,
    group: 'Docs',
    onSelect: () => {
      window.open('/api-docs', '_blank', 'noopener,noreferrer');
    },
  });

  return (
    <>
      {/* Docs pages, driven by DOCS_SECTIONS. */}
      <DocsCommands />
      {/* LoreCommands hooks into MemorySidebarProvider — rendered as a sibling so
          the hook calls stay within the correct provider tree. */}
      <LoreCommands />
    </>
  );
}
