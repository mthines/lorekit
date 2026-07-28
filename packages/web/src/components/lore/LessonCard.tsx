'use client';

import { MemoryCard, memoryFromLesson } from '@/components/memory/MemoryCard';
import type { ScopePrefix } from '@/lib/scope';
import type { MemoryOwner } from '@/lib/ownership';

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
  /** Raw FK — undefined/null for personal lore, set for org-owned lore. */
  org_id?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  /** Resolved ownership (see `ownerFromMemoryRow`) — undefined for personal lore. */
  org?: MemoryOwner;
  /** Optional expiry timestamp. NULL means the row never expires. */
  expires_at?: string | null;
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
