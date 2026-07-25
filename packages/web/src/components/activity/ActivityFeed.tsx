'use client';

import { useMemo } from 'react';
import { Bot, Zap, Webhook } from 'lucide-react';
import { MemoryCard, memoryFromEvent } from '@/components/memory/MemoryCard';
import { scopeLabel } from '@/components/memory/scope-meta';
import { useMemorySidebar } from '@/components/providers/MemorySidebarProvider';
import { useUrlState } from '@/lib/hooks/useUrlState';
import { DateRangePicker, type DateRange } from '@/components/ui/DateRangePicker';
import type { ScopePrefix } from '@/lib/scope';

export interface ActivityEvent {
  id: string;
  scope: string;
  scope_type: ScopePrefix;
  key: string;
  value_preview: string;
  source_agent: string | null;
  trigger: string | null;
  tags: string[];
  created_at: string;
}

const TRIGGER_ICONS: Record<string, typeof Bot> = {
  'stuck-loop': Zap,
  'pr-webhook': Webhook,
  'manual': Bot,
};

function groupByDate(events: ActivityEvent[]): Map<string, ActivityEvent[]> {
  const groups = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    const day = e.created_at.slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(e);
  }
  return groups;
}

function DateLabel({ date }: { date: string }) {
  const d = new Date(date);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const label =
    date === today
      ? 'Today'
      : date === yesterday
        ? 'Yesterday'
        : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 bg-[var(--color-bg)] py-2">
      <span className="text-xs font-medium text-[var(--color-content-tertiary)]">{label}</span>
      <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden />
    </div>
  );
}

interface ActivityEventRowProps {
  event: ActivityEvent;
  index: number;
  selected: boolean;
  onSelect: (ref: { scope: string; key: string }) => void;
}

function ActivityEventRow({ event, index, selected, onSelect }: ActivityEventRowProps) {
  const TriggerIcon = event.trigger ? (TRIGGER_ICONS[event.trigger] ?? Bot) : Bot;

  return (
    <MemoryCard
      memory={memoryFromEvent(event)}
      layout="row"
      index={index}
      selected={selected}
      onClick={() => onSelect({ scope: event.scope, key: event.key })}
      leadingIcon={<TriggerIcon className="size-3.5 text-[var(--color-content-tertiary)]" aria-hidden />}
    />
  );
}

interface ActivityFeedProps {
  events: ActivityEvent[];
  /** Selected date range (UTC day strings), or null for all time. */
  range: DateRange | null;
  onRangeChange: (range: DateRange | null) => void;
}

export function ActivityFeed({ events, range, onRangeChange }: ActivityFeedProps) {
  // URL-backed so a filtered view is shareable and survives refresh. Scoped to
  // /activity via cleanOnPathname so the param doesn't linger on other pages.
  const [filter, setFilter] = useUrlState<string>('filter', 'all', {
    cleanOnPathname: '/activity',
  });
  const { openLessonRef, openLessonById, closeLesson } = useMemorySidebar();

  function handleSelect(ref: { scope: string; key: string }) {
    if (openLessonRef?.scope === ref.scope && openLessonRef?.key === ref.key) {
      closeLesson();
    } else {
      openLessonById(ref);
    }
  }

  // Filter pills are derived from the scopes actually present in the events —
  // dynamic and relevant to this user's data, rather than a hardcoded list of
  // agent/trigger names. Ordered by frequency (most active scope first), then
  // alphabetically for a stable tie-break.
  const scopeFilters = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.scope, (counts.get(e.scope) ?? 0) + 1);
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([scope]) => scope);
  }, [events]);

  // Apply both the scope pill and the date range. Event day is derived in UTC
  // (toISOString) so it matches the heatmap cells the range can be set from.
  const filtered = useMemo(() => {
    let out = events;
    if (filter !== 'all') out = out.filter((e) => e.scope === filter);
    if (range) {
      out = out.filter((e) => {
        const day = new Date(e.created_at).toISOString().slice(0, 10);
        return day >= range.from && day <= range.to;
      });
    }
    return out;
  }, [events, filter, range]);

  const grouped = groupByDate(filtered);
  const isFiltered = filter !== 'all' || range !== null;

  return (
    <div className="flex flex-col gap-3">
      {/* Filters: scope pills (left) + date-range picker (right). */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {scopeFilters.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by scope">
            {['all', ...scopeFilters].map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                title={f === 'all' ? undefined : f}
                className={[
                  'rounded-full px-3 py-1 font-mono text-xs font-medium transition-all duration-150',
                  filter === f
                    ? 'bg-[var(--color-accent)] text-[#000]'
                    : 'border border-[var(--color-border)] bg-[var(--color-bg-raised)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
                ].join(' ')}
              >
                {f === 'all' ? 'all' : scopeLabel(f)}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <DateRangePicker value={range} onChange={onRangeChange} className="ml-auto" />
      </div>

      {/* Grouped events */}
      {grouped.size > 0 ? (
        <div className="flex flex-col gap-1">
          {Array.from(grouped.entries()).map(([date, dayEvents]) => (
            <div key={date}>
              <DateLabel date={date} />
              <div className="flex flex-col gap-1.5">
                {dayEvents.map((e, i) => (
                  <ActivityEventRow
                    key={e.id}
                    event={e}
                    index={i}
                    selected={openLessonRef?.scope === e.scope && openLessonRef?.key === e.key}
                    onSelect={handleSelect}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <p className="text-sm text-[var(--color-content-secondary)]">
            {isFiltered ? 'No activity matches these filters' : 'No activity yet'}
          </p>
          <p className="text-xs text-[var(--color-content-tertiary)]">
            {isFiltered ? 'Try widening the date range or clearing the scope filter.' : 'Agent writes will appear here.'}
          </p>
        </div>
      )}
    </div>
  );
}
