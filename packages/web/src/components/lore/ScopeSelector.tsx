'use client';

/**
 * ScopeSelector — the Explorer's scope picker as a PERSISTENT chip row.
 *
 * ## Why chips, not the left tree
 *
 * The scope list used to be a left-hand column (`ScopeTree`), a different shape
 * from everything else on the page. This renders scopes as chips — the same
 * `ScopeBadge` language the Overview's scope-health cards, the lesson cards and
 * the stat captions use — so the selector, the number it drives and the list it
 * filters all speak one vocabulary.
 *
 * ## One component in every state
 *
 * The chip row is in the SAME place whether or not a scope is selected — picking
 * one only changes which chip is lit, it never reflows the page. `All scopes` is
 * the first chip (clears the filter). When there are more scopes than fit the
 * row, `Browse all` expands the SAME selector into a searchable chip list — still
 * chips, no cards — so the long tail is reachable without a second visual model.
 * Selecting from the list collapses it back to the row with that chip lit.
 *
 * Single-select, so it uses radiogroup / radio semantics (`aria-checked`), the
 * same shape as `OwnershipFilterBar`.
 */

import { useMemo, useState } from 'react';
import { Search, ChevronDown, LayoutList } from 'lucide-react';
import { scopeIcon } from '@/components/memory/scope-meta';
import type { ScopeNode } from './ScopeTree';

/**
 * The scope-type accent, applied to the chip's icon only — the same hues the
 * `ScopeBadge` pills use, but as a single tint on a single pill rather than a
 * bordered badge nested inside the chip (which read as two stacked labels).
 */
const TYPE_COLOR: Record<ScopeNode['type'], string> = {
  repo: 'text-[#6b8afd]',
  project: 'text-[#4bbf87]',
  global: 'text-[#a679f0]',
  branch: 'text-[#d98a3d]',
};

/**
 * How many scope chips the collapsed row shows before `Browse all` takes over.
 * The row is already sorted by count (the tree query orders by it), so these are
 * the scopes a reader is most likely to want.
 */
const VISIBLE_CHIPS = 6;

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
}

/**
 * One scope chip — a SINGLE compact pill: a type-tinted icon, the scope label,
 * and the count in a small circle. One pill, not a badge-inside-a-chip.
 */
function ScopeChip({ type, label, count, selected, onSelect }: ScopeChipProps) {
  const Icon = scopeIcon(type);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={[
        'flex min-h-7 items-center gap-1.5 rounded-full border py-0.5 pl-2 pr-1 text-xs transition-colors duration-150',
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

  const allScopes = useMemo(() => flattenScopes(nodes), [nodes]);
  // The collapsed row shows the top-count scopes — PLUS the selected one if it is
  // not already among them (a branch, or a low-count scope, chosen from Browse
  // all). Otherwise selecting it would light no chip, and the row would claim
  // "All scopes" is active when it is not.
  const visible = useMemo(() => {
    const top = nodes.slice(0, VISIBLE_CHIPS);
    if (!selected || top.some((n) => n.scope === selected)) return top;
    const selectedNode = allScopes.find((n) => n.scope === selected);
    return selectedNode ? [...top, selectedNode] : top;
  }, [nodes, allScopes, selected]);
  const hasMore = allScopes.length > nodes.slice(0, VISIBLE_CHIPS).length;

  // The searchable list matches on the canonical scope OR its label, so both
  // `mthines/lorekit` and `lorekit` find the same chip.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allScopes;
    return allScopes.filter(
      (n) => n.scope.toLowerCase().includes(q) || n.label.toLowerCase().includes(q),
    );
  }, [allScopes, query]);

  // Selecting anything collapses the browse list — the choice is made.
  function choose(scope: string | null) {
    onSelect(scope);
    setOpen(false);
    setQuery('');
  }

  return (
    <div aria-label="Scope" className="flex flex-col gap-2">
      {/* No card — a bare, compact row so the selector reads as a control, not a
          panel competing with the stats below it. */}
      <div role="radiogroup" aria-label="Filter by scope" className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
          Scope
        </span>

        {/* All scopes — always first, clears the filter. */}
        <button
          type="button"
          role="radio"
          aria-checked={selected === null}
          onClick={() => choose(null)}
          className={[
            'flex min-h-7 items-center gap-1.5 rounded-full border border-dashed py-0.5 pl-2 pr-1 text-xs transition-colors duration-150',
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

        {visible.map((node) => (
          <ScopeChip
            key={node.scope}
            type={node.type}
            label={node.label}
            count={node.count}
            selected={selected === node.scope}
            onSelect={() => choose(node.scope)}
          />
        ))}

        {hasMore && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="scope-browse-all"
            className={[
              'flex min-h-7 items-center gap-1 rounded-full border py-0.5 px-2 text-xs transition-colors duration-150',
              open
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-content-tertiary)] hover:bg-[var(--color-bg-elevated)]',
            ].join(' ')}
          >
            {open ? 'Hide' : `Browse all ${allScopes.length}`}
            <ChevronDown
              className={['size-3 shrink-0 transition-transform duration-150', open ? 'rotate-180' : ''].join(' ')}
              aria-hidden
            />
          </button>
        )}
      </div>

      {open && (
        <div
          id="scope-browse-all"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-2.5"
        >
          <div className="relative mb-2.5">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-content-tertiary)]"
              aria-hidden
            />
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter scopes…"
              aria-label="Filter scopes"
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-1.5 pl-8 pr-3 text-xs text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
          {filtered.length > 0 ? (
            <div role="radiogroup" aria-label="All scopes" className="flex max-h-64 flex-wrap gap-1.5 overflow-y-auto">
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
      )}
    </div>
  );
}
