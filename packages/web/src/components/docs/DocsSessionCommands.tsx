'use client';

/**
 * DocsSessionCommands
 *
 * Makes the public `/docs` command palette feel connected to the app: when the
 * visitor is SIGNED IN, it registers the "Navigate" group (Go to Overview /
 * Lore Explorer / Settings) so they can jump back into the app from the docs.
 * When signed out, it registers nothing and the palette shows only "Docs".
 *
 * The session check mirrors `DocsAuthCta` (a browser `getSession()` in a
 * `useEffect`) so the rest of the `/docs` layout stays statically rendered.
 *
 * The "Navigate" commands mirror the dashboard's `NavigationCommands` EXACTLY
 * (labels, icons, shortcuts, destinations) but are standalone — importing
 * `NavigationCommands` would pull in auth-only providers (`useLoreData`,
 * `useMemorySidebar`) that don't exist on the public docs. Command ids are
 * prefixed `docs-nav-*` so they never collide with the dashboard's `nav-*` ids.
 *
 * Conditional RENDERING of the hook-calling child components is correct here:
 * each child calls `useCommand` unconditionally at a stable hook position, and
 * whether the child is mounted at all is what gates registration. Mount this
 * once inside `CommandPaletteProvider` (done in the docs layout).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen, LayoutDashboard, Settings, Newspaper } from 'lucide-react';
import { useCommand } from '@/components/command/useCommand';
import { createClient } from '@/lib/supabase/client';
import { SETTINGS_LANDING_HREF } from '@/lib/settings-routes';

function GoToDashboardCommand() {
  const router = useRouter();
  useCommand({
    id: 'docs-nav-overview',
    label: 'Go to Overview',
    icon: <LayoutDashboard className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 'o'] },
    onSelect: () => router.push('/overview'),
  });
  return null;
}

function GoToExplorerCommand() {
  const router = useRouter();
  useCommand({
    id: 'docs-nav-explorer',
    label: 'Go to Lore Explorer',
    icon: <BookOpen className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 'e'] },
    onSelect: () => router.push('/lore'),
  });
  return null;
}

function GoToSettingsCommand() {
  const router = useRouter();
  useCommand({
    id: 'docs-nav-settings',
    label: 'Go to Settings',
    icon: <Settings className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 's'] },
    onSelect: () => router.push(SETTINGS_LANDING_HREF),
  });
  return null;
}

function GoToBlogCommand() {
  const router = useRouter();
  useCommand({
    id: 'docs-nav-blog',
    label: 'Go to Blog',
    icon: <Newspaper className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 'b'] },
    onSelect: () => router.push('/blog'),
  });
  return null;
}

export function DocsSessionCommands() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    createClient()
      .auth.getSession()
      .then(({ data }) => {
        if (!cancelled) setSignedIn(Boolean(data.session));
      })
      .catch(() => {
        /* stay signed-out on any error */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!signedIn) return null;

  return (
    <>
      <GoToDashboardCommand />
      <GoToExplorerCommand />
      <GoToSettingsCommand />
      <GoToBlogCommand />
    </>
  );
}
