'use client';

/**
 * useCommand
 *
 * Register a command in the global command palette from any client component.
 *
 * The command is registered on mount and deregistered on unmount. When the
 * command definition changes, the registry entry is updated in-place so the
 * next palette open picks up the latest label/icon/shortcut.
 *
 * @example — simple navigation action
 * ```tsx
 * useCommand({
 *   id: 'go-dashboard',
 *   label: 'Go to Dashboard',
 *   icon: <LayoutDashboard className="size-4" />,
 *   group: 'Navigate',
 *   shortcut: { keys: ['g', 'h'] },
 *   onSelect: () => router.push('/dashboard'),
 * });
 * ```
 *
 * @example — nested children (Linear-style "Open Lesson…")
 * ```tsx
 * useCommand({
 *   id: 'open-lesson',
 *   label: 'Open Lesson…',
 *   icon: <BookOpen className="size-4" />,
 *   group: 'Lore',
 *   children: async () => {
 *     const lessons = await fetchRecentLessons();
 *     return lessons.map((l) => ({
 *       id: `lesson-${l.key}`,
 *       label: l.key,
 *       description: l.scope,
 *       onSelect: () => openLessonById({ scope: l.scope, key: l.key }),
 *     }));
 *   },
 * });
 * ```
 */

import { useEffect, useRef } from 'react';
import { useCommandPalette } from './CommandPaletteProvider';
import type { Command } from './types';

export function useCommand(command: Command): void {
  const { register } = useCommandPalette();
  const commandRef = useRef<Command>(command);

  // Keep the ref current so the latest definition is always available even
  // when the registry holds a reference to the original object (which the
  // provider looks up at open time via registryRef.current).
  commandRef.current = command;

  useEffect(() => {
    // We always register the ref's current value; re-register only when `id` changes.
    const cleanup = register(commandRef.current);
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, command.id]);

  // When non-id fields change (label, icon, shortcut, onSelect, etc.), update
  // the registry entry in-place. We call register() which overwrites the same
  // map key — no flash — and return the cleanup so this effect's entry is
  // revoked when the dep changes (the id-effect immediately re-registers).
  useEffect(() => {
    return register(command);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    command.label,
    command.description,
    command.group,
    command.onSelect,
    command.children,
  ]);
}
