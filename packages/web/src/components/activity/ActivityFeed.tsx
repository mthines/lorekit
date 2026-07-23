'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { Bot, Zap, GitBranch, Globe, FolderGit2, Layers, Webhook } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
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

const SCOPE_ICONS: Record<ScopePrefix, typeof Globe> = {
  global: Globe,
  project: Layers,
  repo: FolderGit2,
  branch: GitBranch,
};

const TRIGGER_ICONS: Record<string, typeof Bot> = {
  'stuck-loop': Zap,
  'pr-webhook': Webhook,
  'manual': Bot,
};

function formatDateTime(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60_000);

  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

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
}

function ActivityEventRow({ event, index }: ActivityEventRowProps) {
  const ScopeIcon = SCOPE_ICONS[event.scope_type];
  const TriggerIcon = event.trigger ? (TRIGGER_ICONS[event.trigger] ?? Bot) : Bot;

  return (
    <motion.article
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.03, duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="flex gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-3 transition-colors duration-150 hover:bg-[var(--color-bg-elevated)]"
    >
      {/* Icon */}
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        <TriggerIcon className="size-3.5 text-[var(--color-content-tertiary)]" aria-hidden />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <Badge variant={event.scope_type}>
            <ScopeIcon className="mr-1 inline size-2.5" aria-hidden />
            {event.scope_type}
          </Badge>
          <code className="truncate font-mono text-xs text-[var(--color-content-primary)]">
            {event.key}
          </code>
          <span className="ml-auto shrink-0 text-xs text-[var(--color-content-tertiary)]">
            {formatDateTime(event.created_at)}
          </span>
        </div>

        <p className="mb-1.5 line-clamp-1 text-xs text-[var(--color-content-secondary)]">
          {event.value_preview}
        </p>

        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-content-tertiary)]">
          {event.source_agent && (
            <span className="flex items-center gap-1">
              <Bot className="size-3" aria-hidden />
              {event.source_agent}
            </span>
          )}
          {event.trigger && (
            <span className="flex items-center gap-1">
              <Zap className="size-3" aria-hidden />
              {event.trigger}
            </span>
          )}
          <code className="ml-auto truncate opacity-50">{event.scope}</code>
        </div>
      </div>
    </motion.article>
  );
}

interface ActivityFeedProps {
  events: ActivityEvent[];
}

const FILTERS = ['all', 'aw-executor', 'fix-bug', 'pr-webhook', 'manual'] as const;

export function ActivityFeed({ events }: ActivityFeedProps) {
  const [filter, setFilter] = useState<string>('all');

  const filtered = filter === 'all'
    ? events
    : events.filter(
        (e) => e.source_agent === filter || e.trigger === filter,
      );

  const grouped = groupByDate(filtered);

  return (
    <div className="flex flex-col gap-3">
      {/* Filter pills */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by source">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={[
              'rounded-full px-3 py-1 text-xs font-medium transition-all duration-150',
              filter === f
                ? 'bg-[var(--color-accent)] text-[#000]'
                : 'border border-[var(--color-border)] bg-[var(--color-bg-raised)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
            ].join(' ')}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Grouped events */}
      {grouped.size > 0 ? (
        <div className="flex flex-col gap-1">
          {Array.from(grouped.entries()).map(([date, dayEvents]) => (
            <div key={date}>
              <DateLabel date={date} />
              <div className="flex flex-col gap-1.5">
                {dayEvents.map((e, i) => (
                  <ActivityEventRow key={e.id} event={e} index={i} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <p className="text-sm text-[var(--color-content-secondary)]">No activity yet</p>
          <p className="text-xs text-[var(--color-content-tertiary)]">
            Agent writes will appear here.
          </p>
        </div>
      )}
    </div>
  );
}
