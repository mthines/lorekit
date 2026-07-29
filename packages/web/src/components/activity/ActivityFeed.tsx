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

import { useMemo, useState, useEffect } from 'react';
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
 *
 * `todayIso` / `yesterdayIso` must be computed from a value that is stable
 * between the SSR pass and the first client render. Calling `new Date()` at
 * module level or directly inside the component body produces different
 * timestamps on server vs client and triggers React hydration error #418.
 * Callers must pass today's ISO date string (stable across the render) so this
 * function stays pure and hydration-safe.
 */
function dayLabel(date: string, todayIso: string, yesterdayIso: string): string {
  if (date === todayIso) return 'Today';
  if (date === yesterdayIso) return 'Yesterday';
  return new Date(date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

/**
 * Hydration-safe date heading.
 *
 * `new Date()` produces a different value on the server vs the client (different
 * clock instants), which makes "Today" / "Yesterday" labels mismatch and fires
 * React hydration error #418. We defer the live-clock comparison to after mount
 * via `useEffect`, starting with the static ISO date string so the SSR output
 * and the first client render always agree.
 */
function DateLabel({ date }: { date: string }) {
  // Start with the raw ISO date — identical on server and client first render.
  const [label, setLabel] = useState(date);

  useEffect(() => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    setLabel(dayLabel(date, todayIso, yesterdayIso));
  }, [date]);

  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 bg-[var(--color-bg)] py-2">
      <span className="text-xs font-medium text-[var(--color-content-tertiary)]">{label}</span>
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
          <div className="flex flex-col gap-1.5" role="list" aria-label={date}>
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
