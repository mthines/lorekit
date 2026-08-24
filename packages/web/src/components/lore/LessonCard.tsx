'use client';

import { MemoryCard, memoryFromLesson } from '@/components/memory/MemoryCard';
import type { ScopePrefix } from '@/lib/scope';
import type { MemoryOwner } from '@/lib/ownership';
import type { MemoryOriginFields } from '@/lib/origin';

/**
 * Canonical shape of a memory as stored/queried. Kept here as the app's shared
 * lesson type (imported across the lore, activity, and dashboard queries); the
 * visual rendering is delegated to the shared {@link MemoryCard}.
 */
export interface LessonEntry extends MemoryOriginFields {
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
  // Provenance (`origin_repo` / `origin_branch` / `origin_commit` / `origin_pr`)
  // comes from MemoryOriginFields — where the memory was RECORDED FROM, as
  // opposed to `scope`, which says where it applies. See `lib/origin.ts`.
  /**
   * Taxonomy — which family the memory belongs to and which agent/skill owns
   * it. Nullable: a row written before migration 00056 (or an explicit write
   * that omitted both) carries neither, and `lessonFromMemoryEntry` falls back
   * to the loop-tag inference (`inferKindHost`) rather than re-parsing tags here.
   */
  kind?: string | null;
  host?: string | null;
  /**
   * Recurrence — how many times this lesson has been written (migration
   * 00059). `>= 3` is LoreKit's own documented promotion threshold (see
   * `packages/cli/skill/lorekit-setup/rules/self-improvement-loops.md` →
   * "Promotion (fast → slow)"): the lesson has recurred enough across runs to
   * be worth hardening into a permanent rule. Optional, never null — a read
   * either carries a count (>= 1) or omits the field for a pre-00059 backend.
   */
  seen_count?: number;
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
