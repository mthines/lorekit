'use client';

/**
 * Read-only, filterable feed for the Settings → Audit Logs page.
 *
 * Mirrors the Activity feed's idioms (components/activity/ActivityFeed.tsx):
 * URL-backed filter pills (shareable, survives refresh, scoped to this
 * route), a typed badge per row, and the same skeleton/empty-state language.
 * A dedicated component (not a reuse of ActivityFeed) because it renders
 * audit rows — actor + action + resource/target — not memory cards.
 */

import { useMemo } from 'react';
import { motion, MotionConfig, useReducedMotion } from 'motion/react';
import { Clock } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { AUDIT_ACTION_META, type AuditAction } from '@/lib/audit-actions';
import { formatRelativeTime } from '@/components/memory/MemoryCard';
import { useUrlState } from '@/lib/hooks/useUrlState';
import type { AuditLogRow } from '@/lib/audit-log';

interface AuditLogFeedProps {
  events: AuditLogRow[];
}

function AuditRow({ event, index }: { event: AuditLogRow; index: number }) {
  const reduceMotion = useReducedMotion();
  const meta = AUDIT_ACTION_META[event.action];
  const Icon = meta.icon;
  const absolute = new Date(event.created_at).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: reduceMotion ? 0 : 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.02, duration: 0.2, ease: 'easeOut' }}
      className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-3 transition-colors duration-150 hover:bg-[var(--color-bg-elevated)]"
    >
      <div
        className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]"
        aria-hidden
      >
        <Icon className="size-3.5 text-[var(--color-content-tertiary)]" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <Badge variant={meta.badgeColor}>{meta.label}</Badge>
          {event.target && (
            <code className="min-w-0 truncate font-mono text-xs text-[var(--color-content-primary)]">
              {event.target}
            </code>
          )}
        </div>
        {event.resource_type && (
          <p className="truncate text-xs text-[var(--color-content-tertiary)]">
            {event.resource_type}
            {event.resource_id ? ` · ${event.resource_id}` : ''}
          </p>
        )}
      </div>

      {/* Relative time is the visible label; the absolute time is available
          two ways so it isn't hover-only (title tooltips are invisible to
          touch and unreliable for screen readers): (1) tabIndex makes the
          element focusable so keyboard users trigger the native `title`
          tooltip on focus, and (2) aria-label gives assistive tech the full
          "relative (absolute)" string regardless of hover/focus. */}
      <span
        tabIndex={0}
        className="flex shrink-0 items-center gap-1 rounded text-xs text-[var(--color-content-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        title={absolute}
        aria-label={`${formatRelativeTime(event.created_at)} (${absolute})`}
      >
        <Clock className="size-3" aria-hidden />
        <time dateTime={event.created_at} aria-hidden>
          {formatRelativeTime(event.created_at)}
        </time>
      </span>
    </motion.div>
  );
}

export function AuditLogFeed({ events }: AuditLogFeedProps) {
  // URL-backed so a filtered view is shareable and survives refresh — scoped
  // to /settings/audit so the param doesn't leak onto other settings pages.
  const [filter, setFilter] = useUrlState<AuditAction | 'all'>('action', 'all', {
    cleanOnPathname: '/settings/audit',
  });

  // Filter pills derived from the actions actually present, most-frequent
  // first (same ordering rule as ActivityFeed's scope pills).
  const actionFilters = useMemo(() => {
    const counts = new Map<AuditAction, number>();
    for (const e of events) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([action]) => action);
  }, [events]);

  const filtered = useMemo(
    () => (filter === 'all' ? events : events.filter((e) => e.action === filter)),
    [events, filter],
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col gap-3">
        {actionFilters.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by action">
            {(['all', ...actionFilters] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={[
                  // min-h-[--spacing(8)] ≈ 32px is tight for WCAG touch targets on
                  // mobile; py-1.5 + leading brings the hit area to ~36-40px.
                  'min-h-9 rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-150',
                  filter === f
                    ? 'bg-[var(--color-accent)] text-[#000]'
                    : 'border border-[var(--color-border)] bg-[var(--color-bg-raised)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
                ].join(' ')}
              >
                {f === 'all' ? 'All' : AUDIT_ACTION_META[f].label}
              </button>
            ))}
          </div>
        )}

        {filtered.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {filtered.map((event, i) => (
              <AuditRow key={event.id} event={event} index={i} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <p className="text-sm text-[var(--color-content-secondary)]">
              {filter === 'all' ? 'No audit events yet' : 'No events match this filter'}
            </p>
            <p className="text-xs text-[var(--color-content-tertiary)]">
              {filter === 'all'
                ? 'Sensitive actions — API keys, webhooks, memory changes, limit overrides — will appear here.'
                : 'Try a different action, or clear the filter.'}
            </p>
          </div>
        )}
      </div>
    </MotionConfig>
  );
}
