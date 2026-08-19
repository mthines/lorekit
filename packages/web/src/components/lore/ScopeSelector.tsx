'use client';

/**
 * ScopeSelector — the Explorer's scope picker as a PERSISTENT chip strip.
 *
 * ## Why chips, not the left tree
 *
 * The scope list used to be a left-hand column (`ScopeTree`), a different shape
 * from everything else on the page. This renders scopes as chips — the same
 * `ScopeBadge` language the Overview's scope-health cards, the lesson cards and
 * the stat captions use — so the selector, the number it drives and the list it
 * filters all speak one vocabulary.
 *
 * ## One strip, two ways in
 *
 * The chips sit in a SINGLE horizontally-scrolling strip that renders EVERY
 * top-level scope, not a truncated few — so on a phone you can flick through the
 * whole set inline, and the row never reflows onto a second line and shoves the
 * stats down. The strip's edges fade only on the side that has more to scroll,
 * so "there is more here" is shown rather than guessed. `All scopes` is the
 * first chip (clears the filter).
 *
 * To its right, ALWAYS visible and outside the scroll, is a compact `Browse all`
 * button — the second way in. It opens the same set as a searchable list, which
 * is how you reach a branch scope (they hang under their repo and are not in the
 * strip) or find one by name in a long tail. On the phone breakpoint that list
 * is the shared `BottomSheet`, per the repo-wide rule for transient selection
 * surfaces; on the desktop it expands inline beneath the row.
 *
 * Single-select, so it uses radiogroup / radio semantics (`aria-checked`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronDown, LayoutList } from 'lucide-react';
import { scopeIcon } from '@/components/memory/scope-meta';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { FadeScroller } from '@/components/ui/FadeScroller';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import type { ScopeNode } from './ScopeTree';

/**
 * The scope-type accent, applied to the chip's icon only — the same
 * `--color-scope-*` tokens the `ScopeBadge` pills use (never a raw hex, per the
 * package theme rule), but as a single tint on a single pill rather than a
 * bordered badge nested inside the chip (which read as two stacked labels).
 */
const TYPE_COLOR: Record<ScopeNode['type'], string> = {
  repo: 'text-[var(--color-scope-repo)]',
  project: 'text-[var(--color-scope-project)]',
  global: 'text-[var(--color-scope-global)]',
  branch: 'text-[var(--color-scope-branch)]',
};

/**
 * Flatten the tree into a single list of selectable scopes — top-level nodes
 * (repos, global, projects) AND their branch children — so `Browse all` and its
 * search can reach a branch scope, not only the repo it hangs under.
 */
function flattenScopes(nodes: ScopeNode[]): ScopeNode[] {
  const out: ScopeNode[] = [];
  for (const node of nodes) {
    out.push(node);
    if (node.children?.length) out.push(...flattenScopes(node.children));
  }
  return out;
}

interface ScopeChipProps {
  type: ScopeNode['type'];
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
  /** Set on the selected chip so the strip can scroll it into view. */
  chipRef?: React.Ref<HTMLButtonElement>;
}

/**
 * One scope chip — a SINGLE compact pill: a type-tinted icon, the scope label,
 * and the count in a small circle. One pill, not a badge-inside-a-chip.
 */
function ScopeChip({ type, label, count, selected, onSelect, chipRef }: ScopeChipProps) {
  const Icon = scopeIcon(type);
  return (
    <button
      ref={chipRef}
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={[
        'flex min-h-7 shrink-0 items-center gap-1.5 rounded-full border py-0.5 pl-2 pr-1 text-xs transition-colors duration-150',
        selected
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-content-primary)]'
          : 'border-[var(--color-border)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
      ].join(' ')}
    >
      <Icon className={`size-3 shrink-0 ${TYPE_COLOR[type]}`} aria-hidden />
      <span className="truncate font-mono">{label}</span>
      <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-elevated)] px-1 text-[10px] tabular-nums text-[var(--color-content-tertiary)]">
        {count}
      </span>
    </button>
  );
}

interface ScopeSelectorProps {
  nodes: ScopeNode[];
  /** The currently-selected scope, or null for "all scopes". */
  selected: string | null;
  onSelect: (scope: string | null) => void;
  /** Total active memory count across all scopes (for the "All scopes" chip). */
  totalCount: number;
}

export function ScopeSelector({ nodes, selected, onSelect, totalCount }: ScopeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const isMobile = useIsMobile();

  const allScopes = useMemo(() => flattenScopes(nodes), [nodes]);

  // The strip shows every top-level scope, PLUS the selected one when it is not
  // among them — a branch (branches hang under their repo, off-strip) or any
  // scope picked from Browse all. Without this the strip would light no chip for
  // a valid selection and read as "All scopes" when it is not.
  const stripNodes = useMemo(() => {
    if (!selected || nodes.some((n) => n.scope === selected)) return nodes;
    const selectedNode = allScopes.find((n) => n.scope === selected);
    return selectedNode ? [...nodes, selectedNode] : nodes;
  }, [nodes, allScopes, selected]);

  // The searchable list matches on the canonical scope OR its label, so both
  // `mthines/lorekit` and `lorekit` find the same chip.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allScopes;
    return allScopes.filter(
      (n) => n.scope.toLowerCase().includes(q) || n.label.toLowerCase().includes(q),
    );
  }, [allScopes, query]);

  // A scope chosen from Browse all can be appended to the END of the strip (see
  // `stripNodes`), which on a narrow row is off-screen — so bring the lit chip
  // into view when the selection changes. We scroll the strip's OWN element
  // horizontally (never `scrollIntoView`, which walks every scrollable ancestor
  // and would yank the whole page up to the strip after a pick from the mobile
  // sheet). Nearest-edge only, so an already-visible chip is left untouched.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const selectedChipRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!selected) return;
    const scroller = scrollerRef.current;
    const chip = selectedChipRef.current;
    if (!scroller || !chip) return;
    const relLeft = chip.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
    if (relLeft < 0) {
      scroller.scrollLeft += relLeft;
    } else if (relLeft + chip.clientWidth > scroller.clientWidth) {
      scroller.scrollLeft += relLeft + chip.clientWidth - scroller.clientWidth;
    }
  }, [selected]);

  // Selecting anything collapses the browse surface — the choice is made.
  function choose(scope: string | null) {
    onSelect(scope);
    setOpen(false);
    setQuery('');
  }

  function closeBrowse() {
    setOpen(false);
    setQuery('');
  }

  // The searchable list, shared verbatim by the desktop inline expander and the
  // mobile BottomSheet — one body, two hosts (the `FilterMenu` pattern).
  const browseBody = (
    <div className="p-2.5">
      <div className="relative mb-2.5">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-content-tertiary)]"
          aria-hidden
        />
        <input
          type="search"
          autoFocus={!isMobile}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter scopes…"
          aria-label="Filter scopes"
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-1.5 pl-8 pr-3 text-xs text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
        />
      </div>
      {filtered.length > 0 ? (
        <div
          role="radiogroup"
          aria-label="All scopes"
          className="flex max-h-64 flex-wrap gap-1.5 overflow-y-auto"
        >
          {filtered.map((node) => (
            <ScopeChip
              key={node.scope}
              type={node.type}
              label={node.label}
              count={node.count}
              selected={selected === node.scope}
              onSelect={() => choose(node.scope)}
            />
          ))}
        </div>
      ) : (
        <p className="px-1 py-4 text-center text-xs text-[var(--color-content-tertiary)]">
          No scope matches “{query}”.
        </p>
      )}
    </div>
  );

  return (
    <div aria-label="Scope" className="flex flex-col gap-2">
      {/* No card — a bare, compact row so the selector reads as a control, not a
          panel competing with the stats below it. Label + scrolling strip + a
          pinned Browse-all button, all on one line that never wraps. */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
          Scope
        </span>

        <FadeScroller
          ref={scrollerRef}
          role="radiogroup"
          aria-label="Filter by scope"
          // `py-1` gives the chips vertical breathing room inside the strip (and
          // clears the focus ring); `pr-1` keeps the last chip off the fade edge.
          className="min-w-0 flex-1 items-center gap-1.5 py-1 pr-1"
        >
          {/* All scopes — always first, clears the filter. */}
          <button
            type="button"
            role="radio"
            aria-checked={selected === null}
            onClick={() => choose(null)}
            className={[
              'flex min-h-7 shrink-0 items-center gap-1.5 rounded-full border border-dashed py-0.5 pl-2 pr-1 text-xs transition-colors duration-150',
              selected === null
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
            ].join(' ')}
          >
            <LayoutList className="size-3 shrink-0" aria-hidden />
            All scopes
            <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-elevated)] px-1 text-[10px] tabular-nums text-[var(--color-content-tertiary)]">
              {totalCount}
            </span>
          </button>

          {stripNodes.map((node) => (
            <ScopeChip
              key={node.scope}
              type={node.type}
              label={node.label}
              count={node.count}
              selected={selected === node.scope}
              chipRef={selected === node.scope ? selectedChipRef : undefined}
              onSelect={() => choose(node.scope)}
            />
          ))}
        </FadeScroller>

        {allScopes.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            // Only the DESKTOP inline expander carries this id; on mobile the
            // same body renders in a `BottomSheet`, so the reference would dangle.
            {...(isMobile ? {} : { 'aria-controls': 'scope-browse-all' })}
            className={[
              'flex min-h-7 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-150',
              open
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-content-tertiary)] hover:bg-[var(--color-bg-elevated)]',
            ].join(' ')}
          >
            <span className="hidden sm:inline">Browse all </span>
            <span className="sm:hidden">All </span>
            {allScopes.length}
            <ChevronDown
              className={['size-3 shrink-0 transition-transform duration-150', open ? 'rotate-180' : ''].join(' ')}
              aria-hidden
            />
          </button>
        )}
      </div>

      {/* The picker: a BottomSheet on the phone (per the transient-surface rule),
          an inline expander on the desktop. Same body either way. */}
      {isMobile ? (
        <BottomSheet open={open} onClose={closeBrowse} title="Browse scopes">
          {browseBody}
        </BottomSheet>
      ) : (
        open && (
          <div
            id="scope-browse-all"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
          >
            {browseBody}
          </div>
        )
      )}
    </div>
  );
}
