'use client';

/**
 * ActivityFeed — the "Browse by time" rendering of the Lore Explorer.
 *
 * Presentational only: it receives an already-filtered, owner-aware list of
 * lessons from {@link LoreExplorer} and groups them by calendar day. Every
 * filter (scope / search / date range / owner / archived) is owned by
 * `LoreExplorer` and applied upstream via the shared `useMemories` query, so
 * this component no longer holds any filter state, scope pills, or date picker
 * of its own — the scope tree and the shared filter bar drive both views
 * identically. The only difference between the two tabs is the layout: the
 * scope view renders a flat card list, the time view renders these date groups.
 */

import { useMemo } from 'react';
import { Bot, Zap, Webhook } from 'lucide-react';
import { MemoryCard, memoryFromLesson } from '@/components/memory/MemoryCard';
import type { LessonEntry } from '@/components/lore/LessonCard';

const TRIGGER_ICONS: Record<string, typeof Bot> = {
  'stuck-loop': Zap,
  'pr-webhook': Webhook,
  'manual': Bot,
};

/** Group lessons into [day, lessons] pairs, preserving the input order. */
function groupByDate(lessons: LessonEntry[]): [string, LessonEntry[]][] {
  const groups = new Map<string, LessonEntry[]>();
  for (const l of lessons) {
    // UTC day so groups line up with the heatmap cells a range can be set from.
    const day = new Date(l.created_at).toISOString().slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(l);
  }
  return Array.from(groups.entries());
}

/**
 * Friendly heading for a UTC day string (`YYYY-MM-DD`): "Today" / "Yesterday"
 * / weekday. One source of truth so the visible `DateLabel` and the day-group
 * list's `aria-label` never diverge (a screen reader must hear the same label a
 * sighted user reads, not the raw ISO date).
 */
function dayLabel(date: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (date === today) return 'Today';
  if (date === yesterday) return 'Yesterday';
  return new Date(date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function DateLabel({ date }: { date: string }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 bg-[var(--color-bg)] py-2">
      <span className="text-xs font-medium text-[var(--color-content-tertiary)]">{dayLabel(date)}</span>
      <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden />
    </div>
  );
}

interface ActivityFeedProps {
  /** Already filtered + owner-narrowed lessons, newest first. */
  lessons: LessonEntry[];
  /** Selection predicate — mirrors the scope view's selected-card check. */
  isSelected: (lesson: LessonEntry) => boolean;
  /** Row click — same handler the scope view's cards use (toggles the sheet). */
  onSelect: (lesson: LessonEntry) => void;
}

export function ActivityFeed({ lessons, isSelected, onSelect }: ActivityFeedProps) {
  const grouped = useMemo(() => groupByDate(lessons), [lessons]);

  return (
    <div className="flex flex-col gap-1">
      {grouped.map(([date, dayLessons]) => (
        <div key={date}>
          <DateLabel date={date} />
          <div className="flex flex-col gap-1.5" role="list" aria-label={dayLabel(date)}>
            {dayLessons.map((lesson, i) => {
              const TriggerIcon = lesson.trigger ? (TRIGGER_ICONS[lesson.trigger] ?? Bot) : Bot;
              return (
                <div key={`${lesson.scope}::${lesson.key}`} role="listitem">
                  <MemoryCard
                    memory={memoryFromLesson(lesson)}
                    layout="row"
                    index={i}
                    selected={isSelected(lesson)}
                    onClick={() => onSelect(lesson)}
                    leadingIcon={<TriggerIcon className="size-3.5 text-[var(--color-content-tertiary)]" aria-hidden />}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
