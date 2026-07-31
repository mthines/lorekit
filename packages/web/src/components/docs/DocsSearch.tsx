'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import MiniSearch from 'minisearch';
import { Search, CornerDownLeft } from 'lucide-react';
import type { DocSearchRecord } from '@/lib/docs/content';

interface DocsSearchProps {
  /** Build-time search index, embedded into the static docs layout. */
  index: DocSearchRecord[];
}

interface Hit {
  slug: string;
  title: string;
  description: string;
}

/**
 * Full-text search over the docs, powered by MiniSearch built in the browser
 * from the server-provided index. Matches title, keywords, description, and the
 * flattened page body (so a command or concept anywhere in a page is findable),
 * then links to `/docs/<slug>`.
 *
 * Keyboard: `/` or ⌘K-style focus is handled by the browser; within the box,
 * ↑/↓ move the selection, Enter opens it, Escape closes the results.
 */
export function DocsSearch({ index }: DocsSearchProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const engine = useMemo(() => {
    const ms = new MiniSearch<DocSearchRecord>({
      fields: ['title', 'keywords', 'description', 'text'],
      storeFields: ['slug', 'title', 'description'],
      searchOptions: {
        boost: { title: 5, keywords: 3, description: 2 },
        prefix: true,
        fuzzy: 0.2,
        combineWith: 'AND',
      },
    });
    ms.addAll(index);
    return ms;
  }, [index]);

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim();
    if (q.length < 2) return [];
    return engine
      .search(q)
      .slice(0, 8)
      .map((r) => ({ slug: String(r['slug']), title: String(r['title']), description: String(r['description']) }));
  }, [engine, query]);

  // Reset the highlighted row whenever the result set changes.
  useEffect(() => setActive(0), [hits]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  function go(hit: Hit | undefined) {
    if (!hit) return;
    setOpen(false);
    setQuery('');
    router.push(`/docs/${hit.slug}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(hits[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const showResults = open && query.trim().length >= 2;

  return (
    <div ref={rootRef} className="relative w-full max-w-xs">
      <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 focus-within:border-[var(--color-accent)]">
        <Search className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
        <input
          type="search"
          role="combobox"
          aria-expanded={showResults}
          aria-controls={listboxId}
          aria-activedescendant={
            showResults && hits.length > 0 ? `${listboxId}-opt-${active}` : undefined
          }
          aria-autocomplete="list"
          placeholder="Search docs…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="min-h-11 w-full bg-transparent text-sm text-[var(--color-content-primary)] outline-none placeholder:text-[var(--color-content-tertiary)]"
        />
      </div>

      {showResults && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-2 w-[min(28rem,90vw)] max-w-[90vw] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] py-1 shadow-xl"
        >
          {hits.length === 0 ? (
            <li className="px-4 py-3 text-sm text-[var(--color-content-tertiary)]">
              No results for “{query.trim()}”
            </li>
          ) : (
            hits.map((hit, i) => (
              <li key={hit.slug} id={`${listboxId}-opt-${i}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(hit)}
                  className={[
                    'flex w-full items-start gap-3 px-4 py-2.5 text-left',
                    i === active ? 'bg-[var(--color-accent-subtle)]' : '',
                  ].join(' ')}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--color-content-primary)]">
                      {hit.title}
                    </p>
                    {hit.description && (
                      <p className="truncate text-xs text-[var(--color-content-secondary)]">
                        {hit.description}
                      </p>
                    )}
                  </div>
                  {i === active && (
                    <CornerDownLeft className="mt-0.5 size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
