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
 *   g h → Dashboard (Home)
 *   g e → Lore Explorer
 *   g s → Settings
 *   g l → Getting Started
 *
 * ### Settings
 * Direct jumps to each settings section (no extra shortcuts — use search):
 *   API Keys · Webhooks · Organization · Audit Logs · User profile
 *
 * ### Learn
 * Direct jumps to the Getting Started page and each tutorial:
 *   Setup · Offline storage · Remote storage · Team sharing ·
 *   Private lore · Tags & scopes · Use cases
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
  Key,
  Webhook,
  Users,
  ShieldCheck,
  UserCircle,
  Rocket,
  HardDrive,
  Cloud,
  Lock,
  Tag,
  Zap,
  Library,
} from 'lucide-react';
import { useCommand } from './useCommand';
import { useMemorySidebar } from '@/components/providers/MemorySidebarProvider';
import { useLoreData } from '@/lib/queries/lore';

// ── Lore sub-commands helper ──────────────────────────────────────────────────
//
// Rendered as a separate component so it can safely call hooks that depend on
// MemorySidebarProvider. NavigationCommands is mounted INSIDE
// MemorySidebarProvider in the dashboard layout precisely so useMemorySidebar()
// here resolves — the command registry itself still comes from the ancestor
// CommandPaletteProvider.

function LoreCommands() {
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

// ── Main registration component ───────────────────────────────────────────────

export function NavigationCommands() {
  const router = useRouter();

  // ── Navigate ─────────────────────────────────────────────────────────────

  useCommand({
    id: 'nav-dashboard',
    label: 'Go to Dashboard',
    icon: <LayoutDashboard className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 'o'] },
    onSelect: () => router.push('/dashboard'),
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
    onSelect: () => router.push('/settings'),
  });

  useCommand({
    id: 'nav-learn',
    label: 'Go to Getting Started',
    icon: <GraduationCap className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 'g'] },
    onSelect: () => router.push('/learn'),
  });

  // ── Settings ──────────────────────────────────────────────────────────────

  useCommand({
    id: 'settings-api-keys',
    label: 'API Keys',
    description: 'Manage your MCP API tokens',
    icon: <Key className="size-4" />,
    group: 'Settings',
    onSelect: () => router.push('/settings/api-keys'),
  });

  useCommand({
    id: 'settings-webhooks',
    label: 'Webhooks',
    description: 'Configure GitHub webhook integration',
    icon: <Webhook className="size-4" />,
    group: 'Settings',
    onSelect: () => router.push('/settings/webhooks'),
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

  // ── Learn ─────────────────────────────────────────────────────────────────

  useCommand({
    id: 'learn-setup',
    label: 'Getting Started Guide',
    description: 'Connect your agent and generate a token',
    icon: <Rocket className="size-4" />,
    group: 'Learn',
    onSelect: () => router.push('/learn/setup'),
  });

  useCommand({
    id: 'learn-offline',
    label: 'Tutorial: Offline Storage',
    description: 'Store lessons locally without a server',
    icon: <HardDrive className="size-4" />,
    group: 'Learn',
    onSelect: () => router.push('/learn/offline'),
  });

  useCommand({
    id: 'learn-remote',
    label: 'Tutorial: Remote Storage',
    description: 'Sync lessons to the hosted LoreKit server',
    icon: <Cloud className="size-4" />,
    group: 'Learn',
    onSelect: () => router.push('/learn/remote'),
  });

  useCommand({
    id: 'learn-organization',
    label: 'Tutorial: Team Sharing',
    description: 'Share lore across your organization',
    icon: <Users className="size-4" />,
    group: 'Learn',
    onSelect: () => router.push('/learn/organization'),
  });

  useCommand({
    id: 'learn-private',
    label: 'Tutorial: Private Lore',
    description: 'Keep sensitive lessons private',
    icon: <Lock className="size-4" />,
    group: 'Learn',
    onSelect: () => router.push('/learn/private'),
  });

  useCommand({
    id: 'learn-tags',
    label: 'Tutorial: Tags & Scopes',
    description: 'Organise lessons by scope and tag',
    icon: <Tag className="size-4" />,
    group: 'Learn',
    onSelect: () => router.push('/learn/tags'),
  });

  useCommand({
    id: 'learn-use-cases',
    label: 'Tutorial: Use Cases',
    description: 'Common patterns and workflows',
    icon: <Zap className="size-4" />,
    group: 'Learn',
    onSelect: () => router.push('/learn/use-cases'),
  });

  return (
    // LoreCommands hooks into MemorySidebarProvider — rendered as a sibling so
    // the hook calls stay within the correct provider tree.
    <LoreCommands />
  );
}
