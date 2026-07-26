'use client';

/**
 * Filterable, paginated feed for the Settings → Audit Logs page.
 *
 * Server-side keyset pagination + combinable search (action set / name
 * substring / date interval) via `useAuditLog` (react-query `useInfiniteQuery`
 * over the `listAuditLog` server action). All filter/search/page state is
 * URL-backed and shareable, scoped to `/settings/audit` via `cleanOnPathname`
 * so it doesn't leak onto other Settings tabs.
 *
 * Mirrors the Activity feed's idioms (components/activity/ActivityFeed.tsx):
 * URL-backed filter pills, the same skeleton/empty-state language, and
 * `DateRangePicker` + the single `range` param.
 */

import { useMemo } from 'react';
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from 'motion/react';
import { Clock, Search, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { ActorBadge } from '@/components/settings/ActorBadge';
import { AUDIT_ACTIONS, AUDIT_ACTION_META, type AuditAction } from '@/lib/audit-actions';
import type { AuditActor } from '@/lib/audit-actor';
import { formatRelativeTime } from '@/components/memory/MemoryCard';
import { useUrlState } from '@/lib/hooks/useUrlState';
import { useDebouncedUrlState } from '@/lib/hooks/useDebouncedUrlState';
import { DateRangePicker, type DateRange } from '@/components/ui/DateRangePicker';
import { useAuditLog } from '@/lib/queries/audit-log';
import type { AuditLogRow } from '@/lib/audit-log';

const AUDIT_ROUTE = '/settings/audit';

// Stable reference for the "no actions selected" default — useUrlState/
// useUrlState-derived hooks expect a stable default identity so their
// internal memoization doesn't churn on every render.
const NO_ACTIONS: AuditAction[] = [];

function AuditRow({ event, index, actor }: { event: AuditLogRow; index: number; actor: AuditActor }) {
  const reduceMotion = useReducedMotion();
  const meta = AUDIT_ACTION_META[event.action];
  const Icon = meta.icon;
  const absolute = new Date(event.created_at).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: reduceMotion ? 0 : 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ delay: reduceMotion ? 0 : Math.min(index, 8) * 0.02, duration: 0.2, ease: 'easeOut' }}
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

      <ActorBadge actor={actor} />

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

function RowSkeleton() {
  return (
    <div className="h-[60px] animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
  );
}

export function AuditLogFeed({ actor }: { actor: AuditActor }) {
  // Multi-select action filter — a SET, URL-backed as an array of action
  // strings. Scoped to /settings/audit so it doesn't leak to other tabs.
  const [actions, setActions] = useUrlState<AuditAction[]>('actions', NO_ACTIONS, {
    cleanOnPathname: AUDIT_ROUTE,
  });

  // Debounced name search — the value updates instantly for a responsive
  // input, while the URL (and therefore the query) settles ~350ms after
  // typing stops.
  const [name, setName] = useDebouncedUrlState('name', '', {
    debounceMs: 350,
    cleanOnPathname: AUDIT_ROUTE,
  });

  // The *server query* must key off the settled (URL-committed) value, NOT the
  // instant `name` above: `useDebouncedUrlState` debounces only the URL write,
  // so passing `name` to useAuditLog would re-fire the server action on every
  // keystroke — the debounce would gate the URL, not the endpoint. Reading the
  // committed param back gives us the settled needle (it updates ~350ms after
  // typing stops, when the debounced write lands), so the query is debounced
  // for real. On a shared link / back-forward both seed from the URL at once.
  const [committedName] = useUrlState<string>('name', '', {
    cleanOnPathname: AUDIT_ROUTE,
  });

  // Single shareable `range` param, mirroring activity/page.tsx.
  const [range, setRange] = useUrlState<DateRange | null>('range', null, {
    cleanOnPathname: AUDIT_ROUTE,
  });

  const reduceMotion = useReducedMotion();

  const {
    data,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useAuditLog({ actions, name: committedName, range });

  const events = useMemo(() => data?.pages.flatMap((page) => page.rows) ?? [], [data]);
  const isFiltered = actions.length > 0 || name.trim() !== '' || range !== null;

  function toggleAction(action: AuditAction) {
    setActions((prev) => (prev.includes(action) ? prev.filter((a) => a !== action) : [...prev, action]));
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col gap-3">
        {/* Search + date range */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-content-tertiary)]"
              aria-hidden
            />
            <input
              type="search"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Search by target…"
              aria-label="Search audit log by target"
              className="min-h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] py-1.5 pl-8 pr-3 text-xs text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            />
          </div>
          <DateRangePicker value={range} onChange={setRange} className="ml-auto" />
        </div>

        {/* Multi-select action pills */}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by action">
          {AUDIT_ACTIONS.map((action) => {
            const selected = actions.includes(action);
            return (
              <button
                key={action}
                type="button"
                onClick={() => toggleAction(action)}
                aria-pressed={selected}
                className={[
                  // min-h-9 (~36px) keeps the pill within WCAG 2.2's 24px
                  // minimum touch-target size with comfortable margin.
                  'min-h-9 rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-150',
                  selected
                    ? 'bg-[var(--color-accent)] text-[#000]'
                    : 'border border-[var(--color-border)] bg-[var(--color-bg-raised)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
                ].join(' ')}
              >
                {AUDIT_ACTION_META[action].label}
              </button>
            );
          })}
          {actions.length > 0 && (
            <button
              type="button"
              onClick={() => setActions(NO_ACTIONS)}
              className="min-h-9 rounded-full px-2 text-xs font-medium text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-content-primary)]"
            >
              Clear
            </button>
          )}
        </div>

        {/* Screen-reader-only status announcements — visible feedback (the row
            list itself / the skeleton) already covers sighted users, but
            without this a "Load more" click or a filter change is otherwise
            silent to assistive tech (Nielsen #1, Visibility of System Status). */}
        <p role="status" aria-live="polite" className="sr-only">
          {isLoading
            ? 'Loading audit events'
            : isFetchingNextPage
              ? 'Loading more audit events'
              : `${events.length} audit event${events.length === 1 ? '' : 's'} loaded`}
        </p>

        {isLoading ? (
          <div
            role="status"
            aria-label="Loading audit logs"
            className="flex flex-col gap-1.5"
          >
            {[0, 1, 2, 3, 4].map((i) => (
              <RowSkeleton key={i} />
            ))}
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <p className="text-sm text-[var(--color-content-secondary)]">Failed to load audit events</p>
            <p className="text-xs text-[var(--color-content-tertiary)]">Please refresh the page to try again.</p>
          </div>
        ) : events.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {events.map((event, i) => (
                <AuditRow key={event.id} event={event} index={i} actor={actor} />
              ))}
            </AnimatePresence>

            <div className="flex justify-center pt-2">
              {hasNextPage ? (
                <button
                  type="button"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="flex min-h-9 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-4 py-1.5 text-xs font-medium text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] disabled:opacity-60"
                >
                  {isFetchingNextPage && (
                    <Loader2
                      className={`size-3.5 ${reduceMotion ? '' : 'animate-spin'}`}
                      aria-hidden
                    />
                  )}
                  {isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              ) : (
                <p className="text-[10px] text-[var(--color-content-tertiary)]">End of audit trail</p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <p className="text-sm text-[var(--color-content-secondary)]">
              {isFiltered ? 'No events match these filters' : 'No audit events yet'}
            </p>
            <p className="text-xs text-[var(--color-content-tertiary)]">
              {isFiltered
                ? 'Try a different action, search term, or date range.'
                : 'Sensitive actions — API keys, webhooks, memory changes, limit overrides — will appear here.'}
            </p>
          </div>
        )}
      </div>
    </MotionConfig>
  );
}
