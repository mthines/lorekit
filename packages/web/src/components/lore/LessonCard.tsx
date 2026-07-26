'use client';

import { MemoryCard, memoryFromLesson } from '@/components/memory/MemoryCard';
import type { ScopePrefix } from '@/lib/scope';

/**
 * Canonical shape of a memory as stored/queried. Kept here as the app's shared
 * lesson type (imported across the lore, activity, and dashboard queries); the
 * visual rendering is delegated to the shared {@link MemoryCard}.
 */
export interface LessonEntry {
  /** DB row id — present on paginated server-action results, absent on legacy client fetches. */
  id?: string;
  key: string;
  value: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
  source_agent?: string | null;
  trigger?: string | null;
  scope: string;
  scope_type: ScopePrefix;
}

interface LessonCardProps {
  lesson: LessonEntry;
  selected: boolean;
  onClick: () => void;
  index: number;
}

export function LessonCard({ lesson, selected, onClick, index }: LessonCardProps) {
  return (
    <MemoryCard
      memory={memoryFromLesson(lesson)}
      layout="card"
      selected={selected}
      onClick={onClick}
      index={index}
    />
  );
}
