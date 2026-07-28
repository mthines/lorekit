'use client';

/**
 * NavigationCommands
 *
 * Registers the global navigation commands that are available on every
 * dashboard page. Mount this component once inside `CommandPaletteProvider`
 * (e.g. in the dashboard layout) so the commands are always present.
 *
 * Keyboard shortcuts follow the "g then X" pattern (Gmail / GitHub / Linear
 * style) so they are mnemonic and don't conflict with system shortcuts:
 *   g h → Go to Dashboard (Home)
 *   g e → Go to Explorer
 *   g s → Go to Settings
 *   g l → Go to Getting started (Learn)
 */

import { useRouter } from 'next/navigation';
import { BookOpen, LayoutDashboard, Settings, GraduationCap, Command } from 'lucide-react';
import { useCommand } from './useCommand';

export function NavigationCommands() {
  const router = useRouter();

  // Go to Dashboard
  useCommand({
    id: 'nav-dashboard',
    label: 'Go to Dashboard',
    icon: <LayoutDashboard className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 'h'] },
    onSelect: () => router.push('/dashboard'),
  });

  // Go to Lore Explorer
  useCommand({
    id: 'nav-explorer',
    label: 'Go to Explorer',
    icon: <BookOpen className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 'e'] },
    onSelect: () => router.push('/lore'),
  });

  // Go to Settings
  useCommand({
    id: 'nav-settings',
    label: 'Go to Settings',
    icon: <Settings className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 's'] },
    onSelect: () => router.push('/settings'),
  });

  // Go to Getting Started
  useCommand({
    id: 'nav-learn',
    label: 'Go to Getting Started',
    icon: <GraduationCap className="size-4" />,
    group: 'Navigate',
    shortcut: { keys: ['g', 'l'] },
    onSelect: () => router.push('/learn'),
  });

  return null;
}
