'use client';

/**
 * LoreExplorer
 *
 * The Lore page: a scope chip selector + a collapsible insights panel (stats +
 * heatmap) above a paginated, filterable lesson list.
 *
 * ## Key changes from the previous client-filtered version
 * - Default view is "all scopes" (no scope selected). The scope selector's first
 *   chip is "All scopes", which clears the scope filter.
 * - Filtering (scope / search / date) is server-side, not client-side.
 *   `useMemories` (`useInfiniteQuery` over `listMemories`) is the data source.
 * - Pagination: "Load more" button appends the next keyset page, identical to
 *   the audit log feed (`AuditLogFeed.tsx`).
 * - Scope is a persistent chip row (`ScopeSelector`) at the top of the page,
 *   above the stats it drives — not a left-hand tree. It shares the `ScopeBadge`
 *   language with the Overview cards and the stat captions.
 *
 * ## URL state
 * - `scope` param:    selected scope (null → all scopes). Shareable.
 * - `q` param:        search query, debounced write. Shareable.
 * - `tags` param:     selected labels (JSON array). A memory must carry ALL of
 *   them. Server-side, shareable — "every perf regression we've learned" is a
 *   link you can paste to a teammate.
 * - `range` param:    time range, shareable. Scoped to /lore. Shared by the
 *   heatmap click and the list — one param drives both, and
 *   as of the shared time model it is the SAME param the Overview writes, so a
 *   selection means the same thing on both pages. It holds either a relative
 *   preset (`{preset:'7d'}`, which stays live in a shared link) or an absolute
 *   window (`{from,to}`, ISO instants or the legacy `YYYY-MM-DD` day strings).
 *   `resolveRange` turns whichever arrived into instants; nothing downstream
 *   sees a relative value. See `lib/time-range.ts`.
 * - `status` param:   'active' | 'archived' | 'expiring'. The population being
 *   viewed, as opposed to the filters that narrow it. Absent means "fall back
 *   to the legacy `archived` flag", which is why its default is `null` rather
 *   than `'active'`.
 * - `filters` param:  the unified filter bar (JSON array of committed
 *   conditions) — one dimension per pill, OR within a dimension and AND across.
 *   Ownership (Personal / an org) is one of those dimensions now, filtered
 *   server-side like every other (migration 00063).
 * - `owner` param:    the superseded ownership shorthand from the old
 *   client-side owner bar. Still READ so old links (and pre-change accept-invite
 *   deep links) land; never written. `resolveFilters` folds a `'personal'` value
 *   into an `owner` filter — same absent-only fallback rule as legacy `tags`.
 * - `archived` param: the superseded boolean. Still READ so existing links keep
 *   resolving; never written. Same treatment as the legacy `tags` shorthand.
 * - `insightsOpen`:  local useState inside `ExplorerInsights` — ephemeral panel
 *   collapse, NOT in URL. A shared link carries what you are looking at, not
 *   how tall you left a panel.
 *
 * ## SSR note
 * Uses `useSearchParams()` via `useUrlState`. Must be wrapped in <Suspense>.
 */

import { useCallback, useMemo, useTransition, useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { type ScopeNode } from './ScopeTree';
import { ScopeSelector } from './ScopeSelector';
import { ExplorerInsights } from './ExplorerInsights';
import { LessonCard } from './LessonCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { useUrlState } from '@/lib/hooks/useUrlState';
import { useDebouncedUrlState } from '@/lib/hooks/useDebouncedUrlState';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { useMemorySidebar } from '@/components/providers/MemorySidebarProvider';
import { DateRangePicker, type DateRange } from '@/components/ui/DateRangePicker';
import { StatusControl } from './StatusControl';
import {
  EXPIRING_WITHIN_DAYS,
  expiringWithinDays,
  isArchivedView,
  resolveStatus,
  STATUS_ICONS,
  statusParamValue,
  type MemoryStatus,
} from '@/lib/status-filter';
import {
  isPresetRange,
  rangeCaption,
  resolveRange,
  toDayRange,
  type TimeRange,
} from '@/lib/time-range';
import { useFacetCatalog, useMemories } from '@/lib/queries/lore';
import {
  filtersParamValue,
  removeFilter,
  resolveFilters,
  setFilterOperator,
  toggleFilterValue,
  type FacetValue,
  type Filter,
  type FilterField,
  type FilterOperator,
} from '@/lib/filters';
import { FilterMenuTrigger, FilterPillRow } from './FilterBar';
import { useReducedMotion } from 'motion/react';
import type { LessonEntry } from './LessonCard';


// Module-scoped so the reference is stable across renders — `useUrlState`
// documents that mutable defaults must be memoized at the call site.
const NO_TAGS: string[] = [];
const NO_FILTERS: Filter[] = [];

/**
 * The Explorer opens on ALL time — a list's job is to show everything, and that
 * is the horizon every existing `/lore` deep link (and `lorekit link` URL) has
 * always meant by an absent `range`. The stat header does NOT need the list
 * narrowed to stay legible: an unbounded selection charts the last 90 days on
 * its own (`effectiveStatsRange`), so the two can share one range param without
 * a 24h default that would silently re-scope every shared link.
 *
 * Module-level `null` for the reference-stability reason `useUrlState` documents:
 * the default sits in the setter's `useCallback` deps, so a fresh literal each
 * render reminted it. `null` is a constant, so this is moot — kept named for the
 * one-line rationale above.
 */
const DEFAULT_EXPLORER_RANGE: TimeRange = null;

// ── Filter bar (search + filters + date + status) ─────────────────────────────
// Shared by both tabs and both breakpoints. `variant` carries the only two
// differences between the desktop and mobile renders: the desktop bar sits in a
// bordered header (`border-b`/padding), uses smaller type + the page `bg`, and
// shows text labels + hover affordances; the mobile bar is a bare row with
// icon-only toggles on the raised `bg`. Everything else — the search input, the
// label picker, the date picker, the toggle behaviour — is identical, so it
// lives here once instead of near-verbatim in each breakpoint branch.
//
// The filter menu is one trigger for every dimension rather than one trigger
// per dimension: the values of each dimension grow without bound, and so does
// the number of dimensions. Its committed conditions render as pills on their
// own line below (`FilterPillRow`), because a control row is fixed-width and a
// filter set is not. See `FilterMenu`.

function ControlRow({
  variant,
  search,
  onSearchChange,
  facets,
  filters,
  onToggleFilterValue,
  editingField,
  onEditField,
  range,
  onRangeChange,
  status,
  onStatusChange,
}: {
  variant: 'desktop' | 'mobile';
  search: string;
  onSearchChange: (value: string) => void;
  facets: FacetValue[];
  filters: Filter[];
  onToggleFilterValue: (field: FilterField, value: string) => void;
  editingField: FilterField | null;
  onEditField: (field: FilterField | null) => void;
  range: DateRange | null;
  onRangeChange: (range: DateRange | null) => void;
  status: MemoryStatus;
  onStatusChange: (status: MemoryStatus) => void;
}) {
  const desktop = variant === 'desktop';

  return (
    <div className={desktop ? 'flex items-center gap-2 border-b border-[var(--color-border)] p-3' : 'flex items-center gap-2'}>
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-content-tertiary)]" aria-hidden />
        <input
          type="search"
          placeholder="Search memories…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          aria-label="Search memories"
          className={[
            'w-full rounded-lg border border-[var(--color-border)] py-2 pl-8 pr-3 text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none transition-colors duration-150',
            desktop ? 'bg-[var(--color-bg)] text-xs' : 'bg-[var(--color-bg-raised)] text-sm',
          ].join(' ')}
        />
      </div>
      <FilterMenuTrigger
        facets={facets}
        filters={filters}
        onToggleValue={onToggleFilterValue}
        editingField={editingField}
        onEditField={onEditField}
        variant={variant}
      />
      <DateRangePicker value={range} onChange={onRangeChange} className="shrink-0" />
      <StatusControl value={status} onChange={onStatusChange} variant={variant} />
    </div>
  );
}

interface LoreExplorerProps {
  scopes: ScopeNode[];
  heatmapData: { date: string; count: number }[];
}

export function LoreExplorer({ scopes, heatmapData }: LoreExplorerProps) {
  const { openLesson, openLessonById, closeLesson } = useMemorySidebar();
  const [, startTransition] = useTransition();
  const reduceMotion = useReducedMotion();

  // URL-backed: null means "all scopes" (the new default). A discrete click
  // writes the URL immediately (no debounce). Scoped to /lore.
  const [selectedScope, setSelectedScope] = useUrlState<string | null>('scope', null, {
    cleanOnPathname: '/lore',
  });

  // Search is high-frequency input — the returned `search` is instantly
  // responsive (local state) while the URL param is written on a trailing
  // debounce. The *server query* keys off the settled URL value (committedSearch)
  // so the server action fires only after the debounce settles, not on every
  // keystroke. Mirrors the AuditLogFeed pattern exactly.
  const [search, setSearch] = useDebouncedUrlState<string>('q', '', {
    debounceMs: 350,
    cleanOnPathname: '/lore',
  });
  const [committedSearch] = useUrlState<string>('q', '', {
    cleanOnPathname: '/lore',
  });

  // URL-backed date range, scoped to /lore. Shared by the heatmap click, the
  // scope view, and the feed view — one param drives all three.
  //
  // Typed as `TimeRange` (lib/time-range.ts) rather than `DateRange`, which is
  // what makes the param timestamp-capable: it now also carries a relative
  // preset (`{preset:'7d'}`, which stays live in a shared link) and an absolute
  // window precise to the hour (what a drilled-in chart bucket produces, PR-6).
  // The widening is backward-compatible by construction — a `{from,to}` pair of
  // day strings, the only shape this param has ever held, is still one of the
  // arms, so every existing `?range=` link decodes exactly as before.
  const [range, setRange] = useUrlState<TimeRange>('range', DEFAULT_EXPLORER_RANGE, {
    cleanOnPathname: '/lore',
  });

  // Resolved ONCE per range change, never per render: the clock is read inside
  // the memo, so a relative preset stays a stable object between renders. It is
  // part of the `useMemories` query key, and re-resolving on every render would
  // mint a new key each time and refetch forever.
  //
  // Keyed on the SERIALISED range, not the object: `useUrlState` re-derives its
  // value from `searchParams`, so `range` is a fresh object identity after ANY
  // param edit — flipping the archived toggle would otherwise re-resolve
  // `{preset:'7d'}` against a newer clock and remint the `useMemories` key for a
  // range the user never touched.
  // One clock for everything the insights panel derives — the picker's custom
  // label, the stat window (it is handed down to ExplorerStats so the strip and
  // the cards share it) and the captions must all describe the same instant, or a
  // render can straddle a bucket boundary and caption a chart it did not draw.
  // Minted ONCE per mount (empty deps): a stable instant is the point, so it must
  // not be re-read on range changes or every render would chase the clock.
  const insightsNowIso = useMemo(() => new Date().toISOString(), []);
  const rangeKey = JSON.stringify(range);
  const resolvedRange = useMemo(
    // Resolve the LIST's window against the SAME mount clock the insights panel
    // uses (`insightsNowIso`), not a fresh `new Date()` — otherwise a relative
    // preset like `24h` bounds the list and the stat header a few milliseconds
    // apart, reintroducing exactly the header/list disagreement this feature
    // removes. `insightsNowIso` is a mount-stable constant, so `rangeKey` is what
    // actually drives re-resolution; it is listed as a dep for correctness.
    () => resolveRange(range, insightsNowIso),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rangeKey, insightsNowIso],
  );

  // Day-cell highlighting for the heatmap. Derived from the RESOLVED window, so
  // a preset arriving from an Overview deep link lights the right cells instead
  // of leaving the calendar blank while the list below it is clearly filtered.
  const highlightRange: DateRange | null = resolvedRange ? toDayRange(resolvedRange) : null;

  // The calendar picker speaks whole UTC days and cannot render a preset or a
  // sub-day window, so it is shown the absolute arm and nothing else. A preset
  // reads as "no custom range" there — which is honest: the user did not pick
  // one — while the label above the picker still names what is selected.
  //
  // It is shown the DAY form, not the raw param. `DateRange` is documented as
  // an INCLUSIVE `YYYY-MM-DD` pair, and now that the absolute arm can carry ISO
  // instants with an exclusive `to` (a bucket drilled in from a chart), handing
  // the raw value over would feed a day picker timestamps. `toDayRange` is
  // already the one conversion, and it is a no-op for the legacy day pair this
  // param has always held.
  const pickerRange: DateRange | null = isPresetRange(range) ? null : highlightRange;

  // The pre-facet `?owner=` param. Ownership is a server-side filter DIMENSION
  // now (migration 00063), folded into the bar below like every other
  // dimension, so this legacy param is READ (never written) purely to keep old
  // links landing: the accept-invite deep link, `lorekit link --owner`, and any
  // shared owner view from before this change. `resolveFilters` translates ANY
  // non-`all` string — a `'personal'` marker OR an org slug — into an owner
  // filter; only the pre-00063 `{orgId}` OBJECT degrades to no filter (its uuid
  // cannot be resolved to the slug the facet keys on). Same "absent-only"
  // fallback rule as legacy `?tags=`. The default stays `'all'` (its historical
  // value, mirrored in the CLI's `LORE_PARAM_DEFAULTS`).
  const [legacyOwner] = useUrlState<unknown>('owner', 'all', {
    cleanOnPathname: '/lore',
  });

  // URL-backed filter bar — server-side filtered (OR within a dimension, AND
  // across dimensions). Shareable: "every perf regression we learned on the
  // release branch" is a link you can paste to a teammate.
  // `null` — not `[]` — is the default, so "the param is absent" and "the bar
  // is explicitly empty" stay distinguishable. `useUrlState` drops a param whose
  // value equals its default, so an `[]` default made emptying the bar
  // indistinguishable from never having touched it, and the legacy fallback
  // below resurrected the pill the user had just removed.
  const [rawFilters, setRawFilters] = useUrlState<Filter[] | null>('filters', null, {
    cleanOnPathname: '/lore',
  });

  // The pre-filter-bar `?tags=` param. Still read (never written) so links
  // shared before this shipped — in PRs, Slack, and `lorekit link` output —
  // still land on the filter they name.
  const [legacyTags] = useUrlState<string[]>('tags', NO_TAGS, {
    cleanOnPathname: '/lore',
  });

  // Both params are user-editable text, so they can arrive as anything JSON can
  // express. Normalizing once here means every consumer below (the query, the
  // pills, the empty-state copy) reads a real `Filter[]`. An explicit
  // `?filters=` wins over the legacy shorthand — including when it is empty,
  // which is what makes removing the last pill on a `?tags=` link stick.
  const filters = useMemo(
    () => resolveFilters(rawFilters, legacyTags, legacyOwner),
    [rawFilters, legacyTags, legacyOwner],
  );

  // Every write goes through here so the "explicitly empty" marker is applied
  // in one place rather than at each of the four call sites below.
  const setFilters = useCallback(
    (next: Filter[]) => setRawFilters(filtersParamValue(next, legacyTags, legacyOwner)),
    [setRawFilters, legacyTags, legacyOwner],
  );

  // Which dimension the menu should open at, set by a pill's value segment.
  // Ephemeral — a request, not state worth sharing, so never in the URL.
  const [editingField, setEditingField] = useState<FilterField | null>(null);

  // The desktop and mobile layouts are BOTH mounted — the breakpoint split
  // below is CSS (`hidden md:flex` / `flex md:hidden`), not a conditional
  // render — so both `ControlRow`s hold a live `FilterMenu`. An `editingField`
  // handed to both opens both: each menu's effect runs in the same commit, so
  // the first one's `onOpenAtFieldHandled` has not cleared the request by the
  // time the second reads it, and the mobile `BottomSheet` portals to
  // `document.body`, which escapes its `md:hidden` ancestor and appears on
  // desktop. The request therefore goes to the variant that is actually
  // visible, and only that one; `useIsMobile` is JS for the reason
  // `useMediaQuery` documents — a `md:` class cannot gate a prop.
  const isMobile = useIsMobile();


  // URL-backed Status — scoped to /lore. Defaults to `null` (param absent), not
  // to 'active', for the reason `filters` defaults to null: absent has to be
  // distinguishable from an explicit choice, because an absent `status` falls
  // back to the legacy `archived` flag and an explicit one overrides it.
  const [rawStatus, setRawStatus] = useUrlState<MemoryStatus | null>('status', null, {
    cleanOnPathname: '/lore',
  });

  // The superseded boolean. Still READ so `?archived=true` links in PRs, Slack
  // and `lorekit link --archived` output keep resolving to the archived view —
  // the same treatment the legacy `?tags=` shorthand gets. Never written.
  const [legacyArchived] = useUrlState<boolean>('archived', false, {
    cleanOnPathname: '/lore',
  });

  const status = resolveStatus(rawStatus, legacyArchived);
  const showArchived = isArchivedView(status);

  // Paginated lesson list — server-side filtered by scope / search / range / status.
  const {
    data,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useMemories({
    scope: selectedScope,
    search: committedSearch,
    range: resolvedRange,
    filters,
    showArchived,
    expiringWithinDays: expiringWithinDays(status),
  });

  // Facet catalog for the menu (see `useFacetCatalog`) — its own endpoint query,
  // never derived from the loaded pages, so the menu's options can't shrink to
  // whatever happens to be loaded. Passing `filters` makes its counts drill down:
  // pick one filter and the other dimensions narrow to what selecting each would
  // yield, while the endpoint self-excludes each dimension so you can still widen
  // or switch within it. `selectedScope` scopes the counts to match the list —
  // without it a scoped view would show global counts and overstate the yield.
  // Archived-aware — the archived view is a different population with its own counts.
  const { data: facets } = useFacetCatalog(showArchived, filters, selectedScope);

  // The list is entirely server-filtered now — scope / search / range / status
  // AND every dimension in the filter bar, ownership included (migration 00063
  // folded the old client-side owner narrowing into the bar). So the loaded
  // pages ARE the result; there is no post-filter pass.
  const lessons = useMemo(
    () => data?.pages.flatMap((page) => page.rows) ?? [],
    [data],
  );

  // A range is "narrowing" only when it actually bounds something: an
  // unbounded selection cannot be the reason a list is empty, so offering to
  // widen it would be a button that does nothing.
  const rangeIsNarrowing = range !== null && resolvedRange !== null;

  // Has the user narrowed WITHIN the current view? `status` is deliberately not
  // one of these: it selects which population is listed, not a predicate over
  // it, so "Archived" or "Expiring" being selected must not read as "you
  // filtered something out". `range` is excluded for a related reason — a time
  // window is a bound, not a within-view predicate, and it has its own
  // empty-state branch (`rangeIsNarrowing`) with a "View all time" way out. That
  // distinction is what the empty state turns on — a status view with nothing
  // narrowing it gets its own copy, the same view with a search that matched
  // nothing gets "no matches".
  const isNarrowedWithinView = search.trim() !== '' || filters.length > 0;

  // Every filter mutation closes the lesson sidebar for one reason: the open
  // lesson may not survive the new predicate, and a detail panel describing a
  // memory that is no longer in the list behind it is a lie about what you are
  // looking at.
  function handleToggleFilterValue(field: FilterField, value: string) {
    setFilters(toggleFilterValue(filters, field, value));
    closeLesson();
  }

  function handleOperatorChange(field: FilterField, operator: FilterOperator) {
    setFilters(setFilterOperator(filters, field, operator));
    closeLesson();
  }

  function handleRemoveFilter(field: FilterField) {
    setFilters(removeFilter(filters, field));
    closeLesson();
  }

  function handleClearFilters() {
    setFilters(NO_FILTERS);
    closeLesson();
  }

  function handleStatusChange(next: MemoryStatus) {
    // `statusParamValue` decides whether the param is written or dropped — it
    // has to be written even for the default when a legacy `archived=true` is
    // still in the URL, or selecting Active would silently undo itself on the
    // next reload.
    setRawStatus(statusParamValue(next, legacyArchived));
    // Close the sidebar — the open lesson may not exist in the other population.
    closeLesson();
  }

  function handleScopeSelect(scope: string | null) {
    startTransition(() => {
      setSelectedScope(scope);
      // Close the sidebar when switching scope — the previous lesson may not
      // be present in the new scope.
      closeLesson();
    });
  }

  function handleLessonClick(lesson: LessonEntry) {
    if (openLesson?.key === lesson.key && openLesson?.scope === lesson.scope) {
      closeLesson();
    } else {
      // Pass the full lesson object so the sidebar can render immediately
      // without a lookup — critical for archived lessons which aren't in the
      // active useLoreData cache.
      openLessonById({ scope: lesson.scope, key: lesson.key }, lesson);
    }
  }

  // Heatmap day-click: two-click range anchor → extend → reset, matching the
  // original activity page behaviour.
  function handleHeatmapDayClick(day: string) {
    // The anchor→extend gesture only makes sense against an existing SINGLE-DAY
    // absolute selection. A preset (or any wider window) is not an anchor, so a
    // click on top of one starts a fresh single-day selection rather than
    // silently extending from a boundary the user never picked.
    const anchor = !isPresetRange(range) && range && range.from === range.to ? range.from : null;
    if (anchor !== null) {
      setRange(day >= anchor ? { from: anchor, to: day } : { from: day, to: anchor });
    } else {
      setRange({ from: day, to: day });
    }
  }

  const selectedScopeLabel =
    selectedScope === null
      ? 'All scopes'
      : (scopes.find((s) => s.scope === selectedScope)?.label ?? selectedScope);

  const totalCount = scopes.reduce((sum, s) => sum + s.count, 0);

  const isLessonSelected = (lesson: LessonEntry) =>
    openLesson?.key === lesson.key && openLesson?.scope === lesson.scope;

  // Shared "Load more" / "all loaded" control — identical for both views so the
  // pagination affordance never differs between the scope list and the feed.
  const loadMore = (
    <div className="flex justify-center pt-2 pb-1">
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
        <p className="text-[10px] text-[var(--color-content-tertiary)]">All memories loaded</p>
      )}
    </div>
  );

  // The results renderer: one flat card list. Loading / error / empty are
  // handled once here; the populated body is the lesson cards. It consumes the
  // server-filtered `lessons` (scope / search / range / archived / every bar
  // dimension) — there is a single renderer now that the scope/time view tabs
  // and the date-grouped `ActivityFeed` body are gone.
  //
  // This is a plain function that is CALLED, not a nested component rendered as
  // `<Results />`. A nested component would get a fresh type identity on every
  // parent render, so React would unmount and remount the entire list each time
  // any filter/search/transition state changed — replaying every card's enter
  // animation even when the same cards remain. Inlining the returned JSX keeps
  // each keyed card mounted across renders, so only genuinely-new cards animate.
  const renderResults = () => {
    if (isLoading) {
      return (
        <div className="flex flex-col gap-2 p-3" aria-label="Loading memories" role="status">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
          ))}
        </div>
      );
    }

    if (isError) {
      return (
        <div className="flex items-center justify-center p-8">
          <p className="text-sm text-[var(--color-content-secondary)]">Failed to load memories. Please refresh.</p>
        </div>
      );
    }

    // Empty state only when nothing is left to show AND nothing more to load.
    // Every filter is server-side now, so an empty page with `hasNextPage` still
    // true genuinely means "keep loading", not "no matches".
    if (lessons.length === 0 && !hasNextPage) {
      return (
        <EmptyState
          icon={STATUS_ICONS[status]}
          // The time window gets its own state and its own "View all time" way
          // out. The Explorer opens on ALL time, so an empty list is rarely the
          // window's fault — but once a reader HAS narrowed the range, widening
          // it is the most likely fix, so the action is offered whenever the
          // range actually bounds something, regardless of which title branch
          // wins below.
          {...(rangeIsNarrowing
            ? { action: { label: 'View all time', onClick: () => setRange(null) } }
            : {})}
          title={
            // Within-view narrowing is checked FIRST — a search or filter that
            // matched nothing is a failed search in every status view, and
            // reading "Nothing expiring soon" (or "No archived memories") when
            // the honest answer is "your query matched nothing here" hides the
            // control the user needs to undo. Then the range window (named, with
            // the widen action above). The status-specific copy shows only when
            // neither a filter NOR the range is narrowing — i.e. the "All time"
            // view of that population is genuinely empty, which is exactly when
            // "No archived memories" is the truthful answer rather than a
            // range-specific "No memories in the last 7 days".
            isNarrowedWithinView
              ? 'No matching memories'
              : rangeIsNarrowing
                ? `No memories in ${rangeCaption(range, insightsNowIso)}`
                : status === 'archived'
                  ? 'No archived memories'
                  : // An unnarrowed EXPIRING view is good news, not a failed
                    // search, so it gets its own copy.
                    status === 'expiring'
                    ? 'Nothing expiring soon'
                    : 'No memories in this scope'
          }
          description={
            isNarrowedWithinView
              ? // Filters AND together, so the most likely cause of an empty
                // list is one condition too many — name that before search
                // terms and dates, which the user can already see.
                filters.length > 1
                ? 'No memory satisfies every filter — try removing one.'
                : 'Try a different search term, filter, or date range.'
              : rangeIsNarrowing
                ? 'Nothing was written in this window. Widen the range, or pick another from the Activity panel above.'
                : status === 'archived'
                  ? 'Archive a memory from its detail panel to see it here.'
                  : status === 'expiring'
                    ? `No live memory in this view runs out within ${EXPIRING_WITHIN_DAYS} days.`
                    : 'Memories will appear here once your agents start writing.'
          }
        />
      );
    }

    return (
      <div className="flex flex-col gap-2" role="list" aria-label="Memories">
        {lessons.map((lesson, i) => (
          <div key={`${lesson.scope}::${lesson.key}`} role="listitem">
            <LessonCard
              lesson={lesson}
              selected={isLessonSelected(lesson)}
              onClick={() => handleLessonClick(lesson)}
              index={i}
            />
          </div>
        ))}

        {loadMore}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Screen-reader-only status announcements. */}
      <p role="status" aria-live="polite" className="sr-only">
        {isLoading
          ? 'Loading memories'
          : isFetchingNextPage
            ? 'Loading more memories'
            : `${lessons.length} memor${lessons.length === 1 ? 'y' : 'ies'} loaded`}
      </p>

      {/* ── Scope selector ──────────────────────────────────────────────────
          A persistent chip row at the TOP of the page, above the stats it
          drives. Selecting a scope only lights a different chip — it never
          reflows the layout — and the numbers below update in step, so the
          selection's effect on the stats is legible. See ScopeSelector. */}
      <ScopeSelector
        nodes={scopes}
        selected={selectedScope}
        onSelect={handleScopeSelect}
        totalCount={totalCount}
      />

      {/* ── Insights ────────────────────────────────────────────────────────
          ONE panel for everything the page says ABOUT the memories — the stat
          cards, the range picker and the heatmap — above the list of the
          memories themselves. It replaced two separate bordered panels with two
          independent chevrons; see ExplorerInsights for why it opens collapsed
          and why the collapsed state still shows the numbers. */}
      <ExplorerInsights
        scope={selectedScope}
        scopeLabel={selectedScopeLabel}
        range={range}
        onRangeChange={setRange}
        filters={filters}
        heatmapData={heatmapData}
        highlightRange={highlightRange}
        onSelectDate={handleHeatmapDayClick}
        nowIso={insightsNowIso}
      />

      {/* ── Results ─────────────────────────────────────────────────────────
          The filter bar (search / filters / date / status) sits above the memory
          list — ownership is a dimension INSIDE the filter menu now, not a
          separate bar. Scope now
          lives in the chip row at the top of the page, so the list is a single
          full-width column — no more left scope rail. Both breakpoints are still
          mounted and CSS-toggled (not a JS conditional render) so each keeps a
          live FilterMenu, exactly as before; `variant` carries the only styling
          difference between them. */}

      {/* Desktop */}
      <div className="hidden md:flex h-full flex-col overflow-hidden rounded-xl border border-[var(--color-border)]">
        <ControlRow
          variant="desktop"
          search={search}
          onSearchChange={setSearch}
          facets={facets ?? []}
          filters={filters}
          onToggleFilterValue={handleToggleFilterValue}
          editingField={isMobile ? null : editingField}
          onEditField={setEditingField}
          range={pickerRange}
          onRangeChange={setRange}
          status={status}
          onStatusChange={handleStatusChange}
        />

        <FilterPillRow
          filters={filters}
          onOperatorChange={handleOperatorChange}
          onRemove={handleRemoveFilter}
          onClearAll={handleClearFilters}
          onEditField={setEditingField}
        />

        <div className="flex-1 overflow-y-auto p-3">{renderResults()}</div>
      </div>

      {/* Mobile: stacked layout — pb-6 so the last card and "Load more" button
          clear the bottom edge of the scroll container. */}
      <div className="flex md:hidden flex-col gap-3 pb-6">
        <ControlRow
          variant="mobile"
          search={search}
          onSearchChange={setSearch}
          facets={facets ?? []}
          filters={filters}
          onToggleFilterValue={handleToggleFilterValue}
          editingField={isMobile ? editingField : null}
          onEditField={setEditingField}
          range={pickerRange}
          onRangeChange={setRange}
          status={status}
          onStatusChange={handleStatusChange}
        />

        <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] empty:hidden">
          <FilterPillRow
            filters={filters}
            onOperatorChange={handleOperatorChange}
            onRemove={handleRemoveFilter}
            onClearAll={handleClearFilters}
            onEditField={setEditingField}
          />
        </div>

        <div>{renderResults()}</div>
      </div>
    </div>
  );
}
